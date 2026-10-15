// HTTP client for VSP 360: handles the client-credentials token, TLS options,
// pagination, file uploads and binary downloads.
import { readFileSync, mkdirSync, writeFileSync, openAsBlob, existsSync, realpathSync, createWriteStream } from "node:fs";
import { basename, dirname, join, relative, resolve, sep, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Agent, fetch, FormData, type Response } from "undici";
import { type Operation, isMultipart, fileFields, toolParamName } from "./spec.js";

type Json = any;

interface Config {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
  insecureTls: boolean;
  caCertFile?: string;
  timeoutMs: number;
  maxResponseChars: number;
  /** Bytes read from one response, or from all pages of an all_pages call, before giving up. */
  maxResponseBytes: number;
  downloadDir: string;
  /** save_to may point anywhere (VSP360_SAVE_ANYWHERE=true); otherwise it must stay inside downloadDir. */
  saveAnywhere: boolean;
  /** Multipart uploads must come from inside this folder, when set. */
  uploadDir?: string;
  pathRewrites: [string, string][];
}

// The Data Protection service's pagination links leave out the gateway prefix it is served under:
// `next` points at /api/v1/protection/... (over http) rather than /dataprotection/api/v1/protection/...
// The rewrite re-homes those links. It also covers specs older than the Platform spec, whose paths lacked the prefix.
const DEFAULT_PATH_REWRITES = "/api/v1/protection=/dataprotection/api/v1/protection";

function parseRewrites(spec: string): [string, string][] {
  return spec
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const i = r.indexOf("=");
      if (i <= 0) throw new Error(`Invalid VSP360_PATH_REWRITES entry "${r}" (expected /from=/to)`);
      return [r.slice(0, i), r.slice(i + 1)] as [string, string];
    });
}

export function loadConfig(env = process.env): Config {
  const missing = ["VSP360_URL", "VSP360_CLIENT_ID", "VSP360_CLIENT_SECRET"].filter((k) => !env[k]);
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  let protocol: string;
  try {
    protocol = new URL(env.VSP360_URL!).protocol;
  } catch {
    throw new Error(`VSP360_URL is not a valid URL: ${env.VSP360_URL}`);
  }
  if (protocol === "http:" && env.VSP360_ALLOW_HTTP !== "true") {
    throw new Error("VSP360_URL uses http://, which would send the client secret and tokens unencrypted. Use https://, or set VSP360_ALLOW_HTTP=true to allow it");
  }
  if (protocol !== "http:" && protocol !== "https:") throw new Error(`VSP360_URL must be an https:// URL: ${env.VSP360_URL}`);
  return {
    baseUrl: env.VSP360_URL!.replace(/\/+$/, ""),
    clientId: env.VSP360_CLIENT_ID!,
    clientSecret: env.VSP360_CLIENT_SECRET!,
    scope: env.VSP360_SCOPE || undefined,
    insecureTls: env.VSP360_INSECURE_TLS === "true",
    caCertFile: env.VSP360_CA_CERT || undefined,
    timeoutMs: Number(env.VSP360_TIMEOUT_MS ?? 120_000),
    maxResponseChars: Number(env.VSP360_MAX_RESPONSE_CHARS ?? 60_000),
    maxResponseBytes: Number(env.VSP360_MAX_RESPONSE_BYTES) || 64 * 1024 * 1024,
    downloadDir: resolve(expandHome(env.VSP360_DOWNLOAD_DIR || join(homedir(), "Downloads", "vsp360-mcp"))),
    saveAnywhere: env.VSP360_SAVE_ANYWHERE === "true",
    uploadDir: env.VSP360_UPLOAD_DIR ? resolve(expandHome(env.VSP360_UPLOAD_DIR)) : undefined,
    pathRewrites: parseRewrites(env.VSP360_PATH_REWRITES ?? DEFAULT_PATH_REWRITES),
  };
}

export interface CallArgs {
  params?: Record<string, unknown>;
  body?: unknown;
  files?: Record<string, string>;
  all_pages?: boolean;
  max_pages?: number;
  save_to?: string;
}

interface CallResult {
  ok: boolean;
  status: number;
  text: string;
}

const TEXT_TYPES = /json|text\/|xml|x-pem-file|yaml|csv/;

/** `~/x` → `<home>/x`. */
function expandHome(p: string): string {
  return p.replace(/^~(?=\/|$)/, homedir());
}

/** True when `p` is `dir` or inside it. Both must be absolute and resolved. */
function isInside(p: string, dir: string): boolean {
  return p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

/** True when a path, relative to where checking starts, has a hidden file or folder in it (.ssh, .env, ...). */
const hasHidden = (p: string) => p.split(sep).some((seg) => seg.startsWith(".") && seg !== "." && seg !== "..");

/** The real path `p` would have: its deepest existing ancestor with symlinks resolved, plus the rest. */
function realTarget(p: string): string {
  let head = p;
  const rest: string[] = [];
  while (!existsSync(head) && dirname(head) !== head) {
    rest.unshift(basename(head));
    head = dirname(head);
  }
  return join(realpathSync(head), ...rest);
}

/** A problem with the request (file paths, missing body) to report as a failed call rather than a crash. */
class RequestError extends Error {}

/** A response, or a set of pages, larger than VSP360_MAX_RESPONSE_BYTES. */
class TooLargeError extends RequestError {}

const MAX_PAGES = 200;
const MAX_REDIRECTS = 5;

export class Vsp360Client {
  private agent: Agent;
  private token?: { value: string; expiresAt: number };
  private pendingToken?: Promise<string>;

  constructor(private cfg: Config) {
    this.agent = new Agent({
      // Uploads can be very large (upgrade packages up to 20 GB), so per-request
      // timeouts are applied with an AbortSignal instead of socket timeouts.
      headersTimeout: 0,
      bodyTimeout: 0,
      connect: {
        rejectUnauthorized: !cfg.insecureTls,
        ...(cfg.caCertFile ? { ca: readFileSync(cfg.caCertFile) } : {}),
      },
    });
  }

  private async getToken(force = false): Promise<string> {
    if (!force && this.token && Date.now() < this.token.expiresAt) return this.token.value;
    this.pendingToken ??= this.fetchToken().finally(() => (this.pendingToken = undefined));
    return this.pendingToken;
  }

  private async fetchToken(): Promise<string> {
    const form = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
    });
    if (this.cfg.scope) form.set("scope", this.cfg.scope);
    const res = await fetch(`${this.cfg.baseUrl}/api/v1/vsp360/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: form.toString(),
      dispatcher: this.agent,
      signal: AbortSignal.timeout(this.cfg.timeoutMs),
      // The request body holds the client secret, so it is never re-sent to wherever a redirect points.
      redirect: "manual",
    });
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel();
      throw new Error(`Token request was redirected (HTTP ${res.status} to ${res.headers.get("location") ?? "no location"}); the client secret is only sent to VSP360_URL. Check that VSP360_URL is the VSP 360 address itself.`);
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`Token request failed (HTTP ${res.status}): ${text.slice(0, 1000)}`);
    const data = JSON.parse(text);
    const ttl = Number(data.expires_in ?? 300);
    // Refresh a minute early (or at half-life for very short tokens).
    this.token = { value: data.access_token, expiresAt: Date.now() + Math.max(ttl - 60, ttl / 2) * 1000 };
    return this.token.value;
  }

  async call(op: Operation, args: CallArgs): Promise<CallResult> {
    const params: Record<string, unknown> = { ...(args.params ?? {}) };
    // Direct tools expose parameters under tool-safe names (`match[]` → `match`): map them back.
    for (const p of op.params) {
      const alias = toolParamName(p.name);
      if (alias !== p.name && !(p.name in params) && alias in params) {
        params[p.name] = params[alias];
        delete params[alias];
      }
    }
    let url: string;
    const headers: Record<string, string> = { accept: op.successContentTypes.find((t) => t.includes("json")) ? "application/json" : "*/*" };
    try {
      url = this.buildUrl(op, params, headers);
    } catch (e) {
      return { ok: false, status: 0, text: (e as Error).message };
    }

    try {
      const first = await this.send(op, url, headers, args);
      if (!args.all_pages || !first.ok) return await this.render(op, first, args);
      return await this.allPages(op, url, headers, args, first);
    } catch (e) {
      if (e instanceof RequestError) return { ok: false, status: 0, text: e.message };
      throw e;
    }
  }

  /**
   * Fetches every page of an array result and concatenates them. When the first page's `Link` header names both
   * `next` and `last`, and they differ only in `offset`, every page's URL is known up front and the pages are
   * fetched PAGE_CONCURRENCY at a time; otherwise (and for anything after `last`) `next` links are followed in turn.
   */
  private async allPages(op: Operation, url: string, headers: Record<string, string>, args: CallArgs, first: Response): Promise<CallResult> {
    // One byte budget covers every page, so a long or endless pagination can't exhaust memory.
    const budget = { left: this.cfg.maxResponseBytes };
    const firstBody = await this.readAll(first, budget);
    const items = parseArray(firstBody);
    if (!items) return this.renderBuffered(op, first, firstBody, args);

    const link = first.headers.get("link");
    let next = this.followable(relLink(link, url, "next"));
    let pages = 1;
    let stop = "";
    const maxPages = Math.min(Math.max(Math.trunc(Number(args.max_pages ?? 20)) || 20, 1), MAX_PAGES);
    const tooLarge = () =>
      `\n\n[Stopped at page ${pages + 1}: the pages reached VSP360_MAX_RESPONSE_BYTES (${this.cfg.maxResponseBytes} bytes). Showing the ${pages} page(s) before it. Narrow the request with filters.]`;

    const planned = next ? pageUrls(url, next, this.followable(relLink(link, url, "last")), maxPages - 1) : [];
    if (planned.length > 1) {
      const fetched = await mapLimit(planned, PAGE_CONCURRENCY, async (u) => {
        const res = await this.send(op, u, headers, args);
        try {
          return { u, res, body: await readBody(res, budget) };
        } catch (e) {
          if (e instanceof TooLargeError) return { u, res, body: undefined };
          throw e;
        }
      });
      for (const { u, res, body } of fetched) {
        if (!body) {
          stop = tooLarge();
          next = undefined;
          break;
        }
        if (!res.ok) return this.renderBuffered(op, res, body, args);
        const data = parseArray(body);
        if (!data) {
          stop = `\n\n[Stopped at page ${pages + 1}: the response was not a JSON array (${res.headers.get("content-type") ?? "no content type"}). Showing the ${pages} page(s) before it.]`;
          next = undefined;
          break;
        }
        items.push(...data);
        pages++;
        next = this.followable(relLink(res.headers.get("link"), u, "next"));
      }
    }

    while (next && pages < maxPages) {
      const page = await this.send(op, next, headers, args);
      let body: Buffer;
      try {
        body = await readBody(page, budget);
      } catch (e) {
        if (!(e instanceof TooLargeError)) throw e;
        stop = tooLarge();
        break;
      }
      if (!page.ok) return this.renderBuffered(op, page, body, args);
      const data = parseArray(body);
      if (!data) {
        // Keep what was collected rather than losing every page to one bad response (e.g. a gateway error page).
        stop = `\n\n[Stopped at page ${pages + 1}: the response was not a JSON array (${page.headers.get("content-type") ?? "no content type"}). Showing the ${pages} page(s) before it.]`;
        break;
      }
      items.push(...data);
      pages++;
      next = this.followable(relLink(page.headers.get("link"), next, "next"));
    }
    if (!stop && next) stop = `\n\n[Stopped after ${pages} pages (max_pages); more results exist.]`;
    const label = `${items.length} items from ${pages} page(s)`;
    if (args.save_to) {
      const json = JSON.stringify(items, null, 2);
      const file = this.saveTarget(op, first, args.save_to);
      writeFileSync(file, json, { flag: "wx" });
      return { ok: true, status: first.status, text: `${label}\nSaved ${Buffer.byteLength(json)} bytes (application/json) to ${file}${stop}` };
    }
    return { ok: true, status: first.status, text: this.truncate(JSON.stringify(items), label) + stop };
  }

  private buildUrl(op: Operation, params: Record<string, unknown>, headers: Record<string, string>): string {
    let path = op.path;
    const query = new URLSearchParams();
    const known = new Set(op.params.map((p) => p.name));
    const unknown = Object.keys(params).filter((k) => !known.has(k));
    if (unknown.length) throw new Error(`Unknown parameter(s) for ${op.operationId}: ${unknown.join(", ")}. Valid: ${[...known].join(", ") || "none"}`);
    for (const p of op.params) {
      const v = params[p.name];
      if (v === undefined || v === null || v === "") {
        if (p.required) throw new Error(`Missing required ${p.in} parameter "${p.name}" for ${op.operationId}`);
        continue;
      }
      if (p.in === "path") {
        // URL normalisation would drop `.` and `..` segments, reaching a different endpoint than the one checked.
        const s = String(v);
        if (s === "." || s === ".." || /[\/\\]/.test(s)) throw new Error(`Invalid value for path parameter "${p.name}" of ${op.operationId}: "${s}" (it may not be . or .. or contain / or \\)`);
        path = path.replace(`{${p.name}}`, encodeURIComponent(s));
      }
      else if (p.in === "header") headers[p.name] = String(v);
      else if (Array.isArray(v)) v.forEach((x) => query.append(p.name, String(x)));
      else if (typeof v === "object") query.append(p.name, JSON.stringify(v));
      else query.append(p.name, String(v));
    }
    path = this.rewritePath(path);
    const qs = query.toString();
    return `${this.cfg.baseUrl}${path}${qs ? `?${qs}` : ""}`;
  }

  private rewritePath(path: string): string {
    for (const [from, to] of this.cfg.pathRewrites) {
      if (path === from || path.startsWith(from + "/")) return to + path.slice(from.length);
    }
    return path;
  }

  /** Re-homes a server-supplied link onto the configured base URL and gateway prefix. */
  private followable(link?: string): string | undefined {
    if (!link) return undefined;
    const u = new URL(link);
    return `${this.cfg.baseUrl}${this.rewritePath(u.pathname)}${u.search}`;
  }

  /**
   * A local file for a multipart upload. Uploads are chosen by the model, so content it reads from the API could
   * try to steer an upload; hidden files and folders (~/.ssh, .env, ...) are refused, and with VSP360_UPLOAD_DIR
   * set, so is anything outside that folder.
   */
  private uploadPath(p: string): string {
    const full = resolve(expandHome(p));
    if (!existsSync(full)) throw new RequestError(`File not found: ${full}`);
    const real = realpathSync(full);
    if (this.cfg.uploadDir) {
      const root = existsSync(this.cfg.uploadDir) ? realpathSync(this.cfg.uploadDir) : this.cfg.uploadDir;
      if (!isInside(real, root)) throw new RequestError(`Upload refused: ${full} is outside VSP360_UPLOAD_DIR (${this.cfg.uploadDir}).`);
    } else if (hasHidden(real)) {
      throw new RequestError(`Upload refused: ${full} is a hidden file or inside a hidden folder. Set VSP360_UPLOAD_DIR to choose the folder uploads may come from.`);
    }
    return real;
  }

  private async buildBody(op: Operation, args: CallArgs) {
    if (!op.bodyContentType) return undefined;
    if (isMultipart(op)) {
      const form = new FormData();
      const files = args.files ?? {};
      for (const field of fileFields(op)) {
        const p = files[field];
        if (!p) {
          if ((op.bodySchema?.required ?? []).includes(field)) throw new RequestError(`Missing file for multipart field "${field}" (pass files.${field} = local path)`);
          continue;
        }
        const full = this.uploadPath(p);
        form.append(field, await openAsBlob(full), basename(full));
      }
      for (const [k, v] of Object.entries((args.body as Record<string, unknown>) ?? {})) {
        if (v !== undefined && v !== null) form.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
      }
      return form;
    }
    if (args.body === undefined) {
      if (op.bodyRequired) throw new RequestError(`${op.operationId} requires a request body`);
      return undefined;
    }
    if (op.bodyContentType.includes("x-www-form-urlencoded")) {
      return new URLSearchParams(args.body as Record<string, string>).toString();
    }
    return typeof args.body === "string" ? args.body : JSON.stringify(args.body);
  }

  /**
   * Sends the request, retrying once with a fresh token on 401. The body is left unread for the caller.
   * Redirects are followed only within VSP360_URL's origin, so the token and request body never go elsewhere,
   * and only for GETs or 307/308 (which keep the method and body); any other redirect is returned as is.
   */
  private async send(op: Operation, url: string, headers: Record<string, string>, args: CallArgs, retried = false, hops = 0): Promise<Response> {
    const body = await this.buildBody(op, args);
    const reqHeaders: Record<string, string> = { ...headers, authorization: `Bearer ${await this.getToken(retried)}` };
    if (body !== undefined && !(body instanceof FormData)) reqHeaders["content-type"] = op.bodyContentType!;
    const res = await fetch(url, {
      method: op.method,
      headers: reqHeaders,
      body,
      dispatcher: this.agent,
      signal: isMultipart(op) ? undefined : AbortSignal.timeout(this.cfg.timeoutMs),
      redirect: "manual",
    });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (location) {
      const to = new URL(location, url);
      const origin = new URL(this.cfg.baseUrl).origin;
      if (to.origin !== origin) {
        await res.body?.cancel();
        throw new RequestError(`Redirect refused: VSP 360 redirected ${op.operationId} to ${to.origin}, which is not VSP360_URL (${origin}). Requests and the access token are only sent to VSP360_URL.`);
      }
      if (op.method === "GET" || res.status === 307 || res.status === 308) {
        await res.body?.cancel();
        if (hops >= MAX_REDIRECTS) throw new RequestError(`Too many redirects for ${op.operationId} (last to ${to})`);
        return this.send(op, to.toString(), headers, args, retried, hops + 1);
      }
    }
    if (res.status === 401 && !retried) {
      await res.body?.cancel();
      return this.send(op, url, headers, args, true, hops);
    }
    return res;
  }

  private header(res: Response): string {
    const meta: string[] = [];
    for (const h of ["content-range", "link", "location", "preference-applied"]) {
      const v = res.headers.get(h);
      if (v) meta.push(`${h}: ${v}`);
    }
    return `HTTP ${res.status} ${res.statusText}${meta.length ? "\n" + meta.join("\n") : ""}`;
  }

  /** Reads a whole response body within `budget`, failing the call with an explanation if it doesn't fit. */
  private async readAll(res: Response, budget: { left: number }): Promise<Buffer> {
    try {
      return await readBody(res, budget);
    } catch (e) {
      if (!(e instanceof TooLargeError)) throw e;
      throw new RequestError(`${this.header(res)}\n\nThe response is larger than VSP360_MAX_RESPONSE_BYTES (${this.cfg.maxResponseBytes} bytes). Narrow the request with filters or limit, or use save_to to write it to a file.`);
    }
  }

  /** Renders a response whose body has not been read: binary bodies and save_to are streamed to disk. */
  private async render(op: Operation, res: Response, args: CallArgs): Promise<CallResult> {
    const ct = res.headers.get("content-type") ?? "";
    const isText = !ct || TEXT_TYPES.test(ct);
    if (res.ok && (args.save_to || !isText)) {
      const file = this.saveTarget(op, res, args.save_to);
      let bytes = 0;
      const count = new Transform({ transform: (chunk, _enc, done) => { bytes += chunk.length; done(null, chunk); } });
      await pipeline(res.body ? Readable.fromWeb(res.body as any) : Readable.from([]), count, createWriteStream(file, { flags: "wx" }));
      return { ok: true, status: res.status, text: `${this.header(res)}\nSaved ${bytes} bytes (${ct || "unknown type"}) to ${file}` };
    }
    return this.renderBuffered(op, res, await this.readAll(res, { left: this.cfg.maxResponseBytes }), args);
  }

  /** Renders a response whose body was already read (pagination). */
  private renderBuffered(op: Operation, res: Response, buf: Buffer, args: CallArgs): CallResult {
    const ct = res.headers.get("content-type") ?? "";
    const isText = !ct || TEXT_TYPES.test(ct);
    if (res.ok && (args.save_to || !isText)) {
      const file = this.saveTarget(op, res, args.save_to);
      writeFileSync(file, buf, { flag: "wx" });
      return { ok: true, status: res.status, text: `${this.header(res)}\nSaved ${buf.length} bytes (${ct || "unknown type"}) to ${file}` };
    }
    let text = buf.toString("utf8");
    // Compact JSON: the model reads it as easily as indented JSON, in about a third fewer characters (and tokens).
    if (ct.includes("json") && text) {
      try {
        text = JSON.stringify(JSON.parse(text));
      } catch {}
    }
    return { ok: res.ok, status: res.status, text: `${this.header(res)}\n\n${this.truncate(text || "(empty body)")}` };
  }

  /**
   * Where to save a response. save_to is chosen by the model, so it is kept inside the download folder (relative
   * paths are taken from there) unless VSP360_SAVE_ANYWHERE=true, and an existing file is never overwritten.
   * Without save_to, the server's file name (or a generated one) is used in the download folder, made unique.
   */
  private saveTarget(op: Operation, res: Response, target?: string): string {
    const dir = this.cfg.downloadDir;
    if (target) {
      const t = expandHome(target);
      const file = resolve(isAbsolute(t) ? t : join(dir, t));
      // Checked with symlinks resolved, so a symlink inside the folder can't send the write somewhere else.
      const real = realTarget(file);
      const root = realTarget(dir);
      const inside = isInside(real, root);
      if (!this.cfg.saveAnywhere && !inside) {
        throw new RequestError(`save_to refused: ${file} is outside the download folder ${dir}. Use a file name or a path inside it (or set VSP360_SAVE_ANYWHERE=true).`);
      }
      if (hasHidden(inside ? relative(root, real) : real)) {
        throw new RequestError(`save_to refused: ${file} is a hidden file or inside a hidden folder. Choose a path without hidden folders such as .ssh or .config.`);
      }
      if (existsSync(file)) throw new RequestError(`save_to refused: ${file} already exists. Choose a new file name.`);
      mkdirSync(resolve(file, ".."), { recursive: true });
      return file;
    }
    const name = serverFileName(res.headers.get("content-disposition")) ?? `${op.operationId}-${new Date().toISOString().replace(/[:.]/g, "-")}${extFor(res.headers.get("content-type"))}`;
    mkdirSync(dir, { recursive: true });
    let file = join(dir, name);
    for (let i = 1; existsSync(file); i++) file = join(dir, name.replace(/(\.[^.]+(\.gz)?)?$/, (ext) => `-${i}${ext}`));
    return file;
  }

  private truncate(text: string, label?: string): string {
    const max = this.cfg.maxResponseChars;
    const prefix = label ? `${label}\n` : "";
    if (text.length <= max) return prefix + text;
    return `${prefix}${text.slice(0, max)}\n\n[Truncated: showing ${max} of ${text.length} characters. Use limit/offset or filters to narrow the result, or save_to to write the full response to a file.]`;
  }
}

/**
 * Reads a response body, failing with TooLargeError once more than `budget.left` bytes have arrived. The budget
 * is shared and decremented, so one budget can cover several responses.
 */
async function readBody(res: Response, budget: { left: number }): Promise<Buffer> {
  const chunks: Buffer[] = [];
  if (!res.body) return Buffer.alloc(0);
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    budget.left -= chunk.length;
    if (budget.left < 0) throw new TooLargeError("response too large"); // leaving the loop cancels the stream
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function parseArray(buf: Buffer): Json[] | undefined {
  try {
    const parsed = JSON.parse(buf.toString("utf8"));
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** File name from Content-Disposition, or undefined when absent or not decodable. */
function serverFileName(cd: string | null): string | undefined {
  const m = (cd ?? "").match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  if (!m) return undefined;
  try {
    return basename(decodeURIComponent(m[1])) || undefined;
  } catch {
    return undefined; // malformed %-encoding
  }
}

/** The URL of one relation (`next`, `last`, ...) in an RFC 8288 Link header. */
function relLink(link: string | null, base: string, rel: string): string | undefined {
  if (!link) return undefined;
  for (const part of link.split(",")) {
    const m = part.match(/<([^>]+)>\s*;.*rel="?([\w-]+)"?/);
    if (m && m[2] === rel) return new URL(m[1], base).toString();
  }
  return undefined;
}

// Pages fetched at once when all page URLs are known; enough to hide latency without crowding the gateway.
const PAGE_CONCURRENCY = 4;

const offsetOf = (url: string) => numberParam(url, "offset");
function numberParam(url: string, name: string): number | undefined {
  const m = url.match(new RegExp(`[?&]${name}=(\\d+)(?:&|$)`));
  return m ? Number(m[1]) : undefined;
}
const withOffset = (url: string, offset: number) => url.replace(/([?&]offset=)\d+/, `$1${offset}`);

/**
 * The URLs of the pages from `next` to `last` (at most `budget` of them), when the two links differ only in their
 * `offset` and the step between pages is known; otherwise an empty list, and the caller follows `next` links.
 */
export function pageUrls(current: string, next: string, last: string | undefined, budget: number): string[] {
  if (!last || budget < 1) return [];
  const start = offsetOf(next);
  const end = offsetOf(last);
  if (start === undefined || end === undefined || end < start || withOffset(next, end) !== last) return [];
  const step = numberParam(next, "limit") ?? start - (offsetOf(current) ?? 0);
  if (!(step > 0) || (end - start) % step !== 0) return [];
  const count = Math.min((end - start) / step + 1, budget);
  return Array.from({ length: count }, (_, k) => withOffset(next, start + k * step));
}

/** Runs `fn` over `items` with at most `limit` running at once, keeping the results in order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function extFor(ct: string | null): string {
  if (!ct) return ".bin";
  if (ct.includes("gzip")) return ".tar.gz";
  if (ct.includes("zip")) return ".zip";
  if (ct.includes("csv")) return ".csv";
  if (ct.includes("pem")) return ".pem";
  if (ct.includes("json")) return ".json";
  if (ct.includes("text")) return ".txt";
  return ".bin";
}

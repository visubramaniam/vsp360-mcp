// HTTP client for VSP 360: handles the client-credentials token, TLS options,
// pagination, file uploads and binary downloads.
import { readFileSync, mkdirSync, writeFileSync, openAsBlob, existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";
import { Agent, fetch, FormData, type Response } from "undici";
import { type Operation, isMultipart, fileFields } from "./spec.js";

type Json = any;

export interface Config {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
  insecureTls: boolean;
  caCertFile?: string;
  timeoutMs: number;
  maxResponseChars: number;
  downloadDir: string;
  pathRewrites: [string, string][];
}

// The spec documents some application APIs without the gateway prefix they are
// actually served under, e.g. Data Protection lives at /dataprotection/api/v1/protection.
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
  return {
    baseUrl: env.VSP360_URL!.replace(/\/+$/, ""),
    clientId: env.VSP360_CLIENT_ID!,
    clientSecret: env.VSP360_CLIENT_SECRET!,
    scope: env.VSP360_SCOPE || undefined,
    insecureTls: env.VSP360_INSECURE_TLS === "true",
    caCertFile: env.VSP360_CA_CERT || undefined,
    timeoutMs: Number(env.VSP360_TIMEOUT_MS ?? 120_000),
    maxResponseChars: Number(env.VSP360_MAX_RESPONSE_CHARS ?? 60_000),
    downloadDir: env.VSP360_DOWNLOAD_DIR || join(homedir(), "Downloads", "vsp360-mcp"),
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

export interface CallResult {
  ok: boolean;
  status: number;
  text: string;
}

const TEXT_TYPES = /json|text\/|xml|x-pem-file|yaml|csv/;

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
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Token request failed (HTTP ${res.status}): ${text.slice(0, 1000)}`);
    const data = JSON.parse(text);
    const ttl = Number(data.expires_in ?? 300);
    // Refresh a minute early (or at half-life for very short tokens).
    this.token = { value: data.access_token, expiresAt: Date.now() + Math.max(ttl - 60, ttl / 2) * 1000 };
    return this.token.value;
  }

  async call(op: Operation, args: CallArgs): Promise<CallResult> {
    const params = args.params ?? {};
    let url: string;
    const headers: Record<string, string> = { accept: op.successContentTypes.find((t) => t.includes("json")) ? "application/json" : "*/*" };
    try {
      url = this.buildUrl(op, params, headers);
    } catch (e) {
      return { ok: false, status: 0, text: (e as Error).message };
    }

    const first = await this.send(op, url, headers, args);
    if (!args.all_pages || !first.res.ok) return this.render(op, first.res, first.buf, args);

    // Follow RFC 8288 `next` links and concatenate array pages.
    let items: Json[] | undefined;
    try {
      const parsed = JSON.parse(first.buf.toString("utf8"));
      if (Array.isArray(parsed)) items = parsed;
    } catch {}
    if (!items) return this.render(op, first.res, first.buf, args);

    let next = this.followable(nextLink(first.res.headers.get("link"), url));
    let pages = 1;
    const maxPages = args.max_pages ?? 20;
    while (next && pages < maxPages) {
      const page = await this.send(op, next, headers, args);
      if (!page.res.ok) return this.render(op, page.res, page.buf, args);
      const data = JSON.parse(page.buf.toString("utf8"));
      if (!Array.isArray(data)) break;
      items.push(...data);
      pages++;
      next = this.followable(nextLink(page.res.headers.get("link"), next));
    }
    const note = next ? `\n\n[Stopped after ${pages} pages (max_pages); more results exist.]` : "";
    return { ok: true, status: first.res.status, text: this.truncate(JSON.stringify(items, null, 2), `${items.length} items from ${pages} page(s)`) + note };
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
      if (p.in === "path") path = path.replace(`{${p.name}}`, encodeURIComponent(String(v)));
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

  private async buildBody(op: Operation, args: CallArgs) {
    if (!op.bodyContentType) return undefined;
    if (isMultipart(op)) {
      const form = new FormData();
      const files = args.files ?? {};
      for (const field of fileFields(op)) {
        const p = files[field];
        if (!p) {
          if ((op.bodySchema?.required ?? []).includes(field)) throw new Error(`Missing file for multipart field "${field}" (pass files.${field} = local path)`);
          continue;
        }
        const full = resolve(p.replace(/^~(?=\/)/, homedir()));
        if (!existsSync(full)) throw new Error(`File not found: ${full}`);
        form.append(field, await openAsBlob(full), basename(full));
      }
      for (const [k, v] of Object.entries((args.body as Record<string, unknown>) ?? {})) {
        if (v !== undefined && v !== null) form.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
      }
      return form;
    }
    if (args.body === undefined) {
      if (op.bodyRequired) throw new Error(`${op.operationId} requires a request body`);
      return undefined;
    }
    if (op.bodyContentType.includes("x-www-form-urlencoded")) {
      return new URLSearchParams(args.body as Record<string, string>).toString();
    }
    return typeof args.body === "string" ? args.body : JSON.stringify(args.body);
  }

  private async send(op: Operation, url: string, headers: Record<string, string>, args: CallArgs, retried = false): Promise<{ res: Response; buf: Buffer }> {
    const body = await this.buildBody(op, args);
    const reqHeaders: Record<string, string> = { ...headers, authorization: `Bearer ${await this.getToken(retried)}` };
    if (body !== undefined && !(body instanceof FormData)) reqHeaders["content-type"] = op.bodyContentType!;
    const res = await fetch(url, {
      method: op.method,
      headers: reqHeaders,
      body,
      dispatcher: this.agent,
      signal: isMultipart(op) ? undefined : AbortSignal.timeout(this.cfg.timeoutMs),
    });
    if (res.status === 401 && !retried) {
      await res.body?.cancel();
      return this.send(op, url, headers, args, true);
    }
    return { res, buf: Buffer.from(await res.arrayBuffer()) };
  }

  private render(op: Operation, res: Response, buf: Buffer, args: CallArgs): CallResult {
    const ct = res.headers.get("content-type") ?? "";
    const meta: string[] = [];
    for (const h of ["content-range", "link", "location", "preference-applied"]) {
      const v = res.headers.get(h);
      if (v) meta.push(`${h}: ${v}`);
    }
    const header = `HTTP ${res.status} ${res.statusText}${meta.length ? "\n" + meta.join("\n") : ""}`;

    const isText = !ct || TEXT_TYPES.test(ct);
    if (res.ok && (args.save_to || !isText)) {
      const file = this.saveFile(op, res, buf, args.save_to);
      return { ok: true, status: res.status, text: `${header}\nSaved ${buf.length} bytes (${ct || "unknown type"}) to ${file}` };
    }

    let text = buf.toString("utf8");
    if (ct.includes("json") && text) {
      try {
        text = JSON.stringify(JSON.parse(text), null, 2);
      } catch {}
    }
    return { ok: res.ok, status: res.status, text: `${header}\n\n${this.truncate(text || "(empty body)")}` };
  }

  private saveFile(op: Operation, res: Response, buf: Buffer, target?: string): string {
    let file: string;
    if (target) {
      file = resolve(target.replace(/^~(?=\/)/, homedir()));
    } else {
      const cd = res.headers.get("content-disposition") ?? "";
      const m = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
      const name = m ? basename(decodeURIComponent(m[1])) : `${op.operationId}-${new Date().toISOString().replace(/[:.]/g, "-")}${extFor(res.headers.get("content-type"))}`;
      mkdirSync(this.cfg.downloadDir, { recursive: true });
      file = join(this.cfg.downloadDir, name);
    }
    writeFileSync(file, buf);
    return file;
  }

  private truncate(text: string, label?: string): string {
    const max = this.cfg.maxResponseChars;
    const prefix = label ? `${label}\n` : "";
    if (text.length <= max) return prefix + text;
    return `${prefix}${text.slice(0, max)}\n\n[Truncated: showing ${max} of ${text.length} characters. Use limit/offset or filters to narrow the result, or save_to to write the full response to a file.]`;
  }
}

function nextLink(link: string | null, base: string): string | undefined {
  if (!link) return undefined;
  for (const part of link.split(",")) {
    const m = part.match(/<([^>]+)>\s*;.*rel="?next"?/);
    if (m) return new URL(m[1], base).toString();
  }
  return undefined;
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

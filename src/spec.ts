// Loads the VSP 360 OpenAPI document and indexes every operation so the
// server can expose them as MCP tools.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { bundled } from "./config.js";

type Json = any;

interface Param {
  name: string;
  in: "path" | "query" | "header";
  required: boolean;
  description?: string;
  schema: Json;
}

export interface Operation {
  operationId: string;
  method: string;
  path: string;
  tag: string;
  summary: string;
  description: string;
  params: Param[];
  bodyContentType?: string;
  bodySchema?: Json;
  bodyRequired: boolean;
  successContentTypes: string[];
  readOnly: boolean;
  destructive: boolean;
  /** Returns a credential in clear text; refused unless VSP360_ALLOW_SECRET_READS=true. */
  secret: boolean;
  /** Parameter values the operation is read-only with; in read-only mode, any other value is refused. */
  readOnlyParams?: Record<string, string>;
}

const METHODS = ["get", "post", "put", "patch", "delete"];

// The server obtains tokens itself, so the token endpoint is never a tool.
const HIDDEN = new Set(["vsp360PostAuthToken"]);

// POST operations that only read or validate and change nothing on the platform.
const READ_ONLY_POSTS = new Set([
  "analyticsRunQuery",
  "vsp360PostAuthorizationCheck",
  "vsp360PostDevicesInventory",
  "vsp360GetUserCapabilities",
  "vsp360PostDevicesEnrollmentTemplateValidate",
  "vsp360PostUpgradesValidate",
]);
// vsp360VerifyDirectory changes nothing either, but it makes VSP 360 connect to any LDAP host with the bind
// credentials it is given, so it is treated as a write.

// Read-only POSTs that are only reads with these parameter values: analyticsRunQuery's other actions can, for
// example, abort other users' queries.
const READ_ONLY_PARAMS: Record<string, Record<string, string>> = {
  analyticsRunQuery: { action: "query" },
};

// Operations that return a live credential. Every other operation masks secrets, per the spec.
const SECRETS = new Set(["vsp360GetServiceAccountSecret", "vsp360RevealBlockSSOSetup", "vsp360RotateBlockSSOSecret"]);

/**
 * Pre-parsed copy of the bundled YAML spec, written by `npm run build` (scripts/cache-spec.mjs) as
 * `{ sha256, doc }`. Parsing the 2 MB YAML takes about 250 ms and briefly about 250 MB of memory;
 * the JSON copy parses in a few milliseconds.
 */
export const SPEC_CACHE = bundled("dist", "openapi-cache.json");

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * Parses OpenAPI YAML as the server always has; the build-time cache is made with this too. The yaml
 * package is loaded only when needed, since with the cache most starts never parse YAML.
 */
export function parseYaml(text: string): Json {
  const { parse } = createRequire(import.meta.url)("yaml") as typeof import("yaml");
  return parse(text, { maxAliasCount: -1 });
}

/**
 * Reads an OpenAPI document. A `.json` file is parsed as JSON. A YAML file is taken from SPEC_CACHE when
 * the cache was made from exactly the same text, so replacing the YAML file still takes effect at once.
 */
export function loadDocument(file: string): Json {
  const text = readFileSync(file, "utf8");
  if (file.endsWith(".json")) return JSON.parse(text);
  if (existsSync(SPEC_CACHE)) {
    const cache = JSON.parse(readFileSync(SPEC_CACHE, "utf8"));
    if (cache.sha256 === sha256(text)) return cache.doc;
  }
  return parseYaml(text);
}

/** The cache file's content for a YAML spec's text. */
export function specCache(text: string): string {
  return JSON.stringify({ sha256: sha256(text), doc: parseYaml(text) });
}

export class Spec {
  readonly operations = new Map<string, Operation>();
  readonly tags: { name: string; description: string; count: number }[] = [];
  private readonly responses = new Map<string, Json>();
  // The parsed document is only needed while indexing; it is released afterwards (about 100 MB of heap).
  private doc: Json;

  constructor(file: string) {
    this.doc = loadDocument(file);
    for (const [path, item] of Object.entries<Json>(this.doc.paths)) {
      for (const method of METHODS) {
        const op = item[method];
        if (!op || HIDDEN.has(op.operationId)) continue;
        this.operations.set(op.operationId, this.buildOperation(method, path, item, op));
        this.responses.set(op.operationId, this.buildResponseSchema(op));
      }
    }
    const counts = new Map<string, number>();
    for (const op of this.operations.values()) counts.set(op.tag, (counts.get(op.tag) ?? 0) + 1);
    for (const t of this.doc.tags ?? []) {
      if (counts.has(t.name)) this.tags.push({ name: t.name, description: firstSentence(t.description), count: counts.get(t.name)! });
    }
    for (const [name, count] of counts) {
      if (!this.tags.some((t) => t.name === name)) this.tags.push({ name, description: "", count });
    }
    this.doc = undefined;
  }

  private buildOperation(method: string, path: string, item: Json, op: Json): Operation {
    const params: Param[] = [];
    for (const raw of [...(item.parameters ?? []), ...(op.parameters ?? [])]) {
      const p = this.ref(raw);
      if (!["path", "query", "header"].includes(p.in)) continue;
      const existing = params.findIndex((x) => x.name === p.name && x.in === p.in);
      const param: Param = {
        name: p.name,
        in: p.in,
        required: p.in === "path" || !!p.required,
        description: p.description,
        schema: this.resolve(p.schema ?? { type: "string" }),
      };
      if (existing >= 0) params[existing] = param;
      else params.push(param);
    }

    let bodyContentType: string | undefined;
    let bodySchema: Json;
    let bodyRequired = false;
    if (op.requestBody) {
      const rb = this.ref(op.requestBody);
      bodyRequired = !!rb.required;
      const types = Object.keys(rb.content ?? {});
      bodyContentType = types.find((t) => t.includes("json")) ?? types[0];
      if (bodyContentType) bodySchema = this.resolve(rb.content[bodyContentType].schema ?? {});
    }

    const successContentTypes = new Set<string>();
    for (const [code, r] of Object.entries<Json>(op.responses ?? {})) {
      if (code.startsWith("2")) for (const ct of Object.keys(this.ref(r).content ?? {})) successContentTypes.add(ct);
    }

    const readOnly = method === "get" || READ_ONLY_POSTS.has(op.operationId);
    return {
      operationId: op.operationId,
      method: method.toUpperCase(),
      path,
      tag: op.tags?.[0] ?? "Other",
      summary: op.summary ?? "",
      description: op.description ?? "",
      params,
      bodyContentType,
      bodySchema,
      bodyRequired,
      successContentTypes: [...successContentTypes],
      readOnly,
      destructive: method === "delete",
      secret: SECRETS.has(op.operationId),
      ...(READ_ONLY_PARAMS[op.operationId] ? { readOnlyParams: READ_ONLY_PARAMS[op.operationId] } : {}),
    };
  }

  /** Follows a single local $ref. */
  private ref(node: Json): Json {
    let cur = node;
    for (let i = 0; cur && cur.$ref && i < 10; i++) cur = this.lookup(cur.$ref);
    return cur;
  }

  private lookup(ref: string): Json {
    if (!ref.startsWith("#/")) throw new Error(`Unsupported $ref ${ref}`);
    return ref
      .slice(2)
      .split("/")
      .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"))
      .reduce((acc: Json, key) => acc?.[key], this.doc);
  }

  /**
   * Inlines $refs so a schema is self-contained JSON Schema. Recursive schemas
   * are cut off at the point of recursion, and examples are dropped to keep
   * tool definitions small.
   */
  private resolve(schema: Json, maxDepth = 12, seen: string[] = []): Json {
    if (Array.isArray(schema)) return schema.map((s) => this.resolve(s, maxDepth, seen));
    if (!schema || typeof schema !== "object") return schema;
    if (schema.$ref) {
      const name = schema.$ref.split("/").pop();
      if (seen.includes(schema.$ref) || seen.length >= maxDepth) {
        return { type: "object", description: `${name} (nested; see describe_operation)` };
      }
      const target = this.resolve(this.lookup(schema.$ref), maxDepth, [...seen, schema.$ref]);
      const { $ref, ...siblings } = schema;
      return { ...target, ...this.resolve(siblings, maxDepth, seen) };
    }
    const out: Json = {};
    for (const [k, v] of Object.entries(schema)) {
      if (k === "example" || k === "examples" || k === "xml" || k === "discriminator") continue;
      if (k === "nullable") continue;
      // `properties` maps names to schemas, so it never carries keywords of its own.
      out[k] = k === "properties"
        ? Object.fromEntries(Object.entries<Json>(v as Json).map(([pk, pv]) => [pk, this.resolve(pv, maxDepth, seen)]))
        : this.resolve(v, maxDepth, seen);
    }
    if (schema.nullable && typeof out.type === "string") out.type = [out.type, "null"];
    return out;
  }

  /** Full 2xx response schema, for describe_operation. */
  responseSchema(op: Operation): Json {
    return this.responses.get(op.operationId);
  }

  private buildResponseSchema(raw: Json): Json {
    for (const [code, r] of Object.entries<Json>(raw.responses ?? {})) {
      if (!code.startsWith("2")) continue;
      const content = this.ref(r).content ?? {};
      const ct = Object.keys(content).find((t) => t.includes("json")) ?? Object.keys(content)[0];
      if (ct) return { status: code, contentType: ct, schema: this.resolve(content[ct].schema ?? {}, 6) };
      return { status: code, description: this.ref(r).description };
    }
    return undefined;
  }
}

function firstSentence(text = ""): string {
  const s = text.replace(/\s+/g, " ").trim();
  const m = s.match(/^(.{20,}?[.!?])(\s|$)/);
  return (m ? m[1] : s).slice(0, 240);
}

/** True when the request body is a multipart upload of local files. */
export function isMultipart(op: Operation): boolean {
  return op.bodyContentType === "multipart/form-data";
}

/** Names of multipart fields that carry files (format: binary). */
export function fileFields(op: Operation): string[] {
  if (!isMultipart(op)) return [];
  return Object.entries<Json>(op.bodySchema?.properties ?? {})
    .filter(([, s]) => s.format === "binary")
    .map(([k]) => k);
}

/**
 * A spec parameter name as a tool input property. MCP clients only accept
 * `[A-Za-z0-9_.-]{1,64}`, so names like Prometheus' `match[]` are rewritten
 * (`match[]` → `match`); the client maps them back before calling the API.
 */
export function toolParamName(name: string): string {
  return name.replace(/\[\]$/, "").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64) || "param";
}


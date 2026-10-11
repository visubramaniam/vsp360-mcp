// Loads the VSP 360 OpenAPI document and indexes every operation so the
// server can expose them as MCP tools.
import { readFileSync } from "node:fs";
import { parse } from "yaml";

type Json = any;

export interface Param {
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
  "vsp360VerifyDirectory",
]);

export class Spec {
  readonly doc: Json;
  readonly operations = new Map<string, Operation>();
  readonly tags: { name: string; description: string; count: number }[] = [];

  constructor(file: string) {
    this.doc = parse(readFileSync(file, "utf8"), { maxAliasCount: -1 });
    for (const [path, item] of Object.entries<Json>(this.doc.paths)) {
      for (const method of METHODS) {
        const op = item[method];
        if (!op || HIDDEN.has(op.operationId)) continue;
        this.operations.set(op.operationId, this.buildOperation(method, path, item, op));
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
    };
  }

  /** Follows a single local $ref. */
  ref(node: Json): Json {
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
  resolve(schema: Json, maxDepth = 12, seen: string[] = []): Json {
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
    const raw = this.doc.paths[op.path][op.method.toLowerCase()];
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

export function firstSentence(text = ""): string {
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

#!/usr/bin/env node
// MCP server for the VSP 360 REST API.
//
// Every operation in the OpenAPI spec is reachable through three discovery
// tools (list, describe, call). Selected tags can also be exposed as one
// direct tool per operation with VSP360_TOOLSETS.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { Spec, type Operation, fileFields, isMultipart, toolParamName } from "./spec.js";
import { Vsp360Client, loadConfig, type CallArgs } from "./client.js";
import { OperationIndex, analyticsHint } from "./search.js";

type Json = any;

const here = dirname(fileURLToPath(import.meta.url));
const spec = new Spec(process.env.VSP360_SPEC || join(here, "..", "spec", "vsp360-openapi.yaml"));
const allowWrites = process.env.VSP360_ALLOW_WRITES === "true";
// Example user questions per operation sharpen search; VSP360_EXAMPLES="" turns them off.
const examplesPath = process.env.VSP360_EXAMPLES ?? join(here, "..", "spec", "examples.json");
const examples: Record<string, string[]> = examplesPath && existsSync(examplesPath) ? JSON.parse(readFileSync(examplesPath, "utf8")) : {};
const index = new OperationIndex(spec.operations.values(), examples);
const toolsets = (process.env.VSP360_TOOLSETS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

let client: Vsp360Client | undefined;
function getClient(): Vsp360Client {
  // Created lazily so the server can start (and list tools) before credentials are checked.
  client ??= new Vsp360Client(loadConfig());
  return client;
}

// ---------- discovery tools ----------

const META_TOOLS: Tool[] = [
  {
    name: "vsp360_list_operations",
    description:
      "Browse the VSP 360 REST API. With no arguments, lists the API areas (tags) and how many operations each has. " +
      "With `tag` and/or `query`, lists matching operations (operationId, method, path, summary). " +
      "Use this first to find the operationId you need, then vsp360_describe_operation and vsp360_call_operation." +
      (allowWrites ? "" : " Operations marked [write] are blocked because the server runs read-only."),
    inputSchema: {
      type: "object",
      properties: {
        tag: { type: "string", description: "API area, e.g. 'Device Registry', 'Platform Alerts', 'Users'. Case-insensitive." },
        query: { type: "string", description: "What you want to do, in plain words (e.g. 'volumes with no host path', 'replication pairs status'). Ranked by BM25 relevance with a confidence rating." },
        limit: { type: "integer", minimum: 1, maximum: 40, description: "Maximum results for a query (default 10)." },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "vsp360_describe_operation",
    description:
      "Show everything needed to call one VSP 360 operation: method and path, required permissions and prerequisites, " +
      "parameters, request body schema and response schema.",
    inputSchema: {
      type: "object",
      properties: { operationId: { type: "string", description: "operationId from vsp360_list_operations" } },
      required: ["operationId"],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "vsp360_call_operation",
    description:
      "Call any VSP 360 REST API operation by operationId. Authentication is handled automatically. " +
      "Pass path, query and header parameters by name in `params`, and the JSON request body in `body`. " +
      "Collections are paginated with limit/offset (max 100 per page); set all_pages to follow the `next` link. " +
      "Binary responses (ZIP, gzip, CSV downloads) are saved to disk and the file path is returned." +
      (allowWrites ? "" : " Only read operations are allowed; the server runs read-only."),
    inputSchema: {
      type: "object",
      properties: {
        operationId: { type: "string" },
        ...commonCallProperties(true),
      },
      required: ["operationId"],
    },
    annotations: { readOnlyHint: !allowWrites, destructiveHint: allowWrites, openWorldHint: true },
  },
];

function commonCallProperties(generic: boolean): Record<string, Json> {
  return {
    ...(generic
      ? {
          params: { type: "object", description: "Path, query and header parameters by name, e.g. {\"id\": \"123\", \"limit\": 100}", additionalProperties: true },
          body: { description: "Request body (JSON object or array) for POST/PUT/PATCH operations. For multipart uploads, the non-file form fields." },
          files: { type: "object", description: "Multipart uploads only: form field name -> local file path", additionalProperties: { type: "string" } },
        }
      : {}),
    all_pages: { type: "boolean", description: "Follow RFC 8288 `next` links and return every page (GET collections only)." },
    max_pages: { type: "integer", minimum: 1, maximum: 200, description: "Page cap when all_pages is set (default 20)." },
    save_to: { type: "string", description: "Write the response body to this local file path instead of returning it." },
  };
}

// ---------- direct per-operation tools ----------

function toolName(op: Operation): string {
  return op.operationId.length <= 64 ? op.operationId : op.operationId.slice(0, 64);
}

function directTool(op: Operation): Tool {
  const properties: Record<string, Json> = {};
  const required: string[] = [];
  for (const p of op.params) {
    const key = toolParamName(p.name);
    const note = key === p.name ? undefined : `Sent to the API as \`${p.name}\`.`;
    properties[key] = { ...p.schema, description: [p.description, p.schema.description, note].filter(Boolean).join(" ") || undefined };
    if (p.required) required.push(key);
  }
  if (op.bodySchema) {
    if (isMultipart(op)) {
      const fields = fileFields(op);
      const rest = { ...op.bodySchema, properties: { ...op.bodySchema.properties } };
      for (const f of fields) delete rest.properties[f];
      rest.required = (rest.required ?? []).filter((r: string) => !fields.includes(r));
      properties.files = {
        type: "object",
        description: "Local file paths for the upload fields",
        properties: Object.fromEntries(fields.map((f) => [f, { type: "string", description: op.bodySchema.properties[f].description }])),
        required: fields.filter((f) => (op.bodySchema.required ?? []).includes(f)),
      };
      required.push("files");
      if (Object.keys(rest.properties).length) properties.body = rest;
    } else {
      properties.body = op.bodySchema;
      if (op.bodyRequired) required.push("body");
    }
  }
  Object.assign(properties, op.method === "GET" ? commonCallProperties(false) : { save_to: commonCallProperties(false).save_to });

  return {
    name: toolName(op),
    description: `${op.summary} (${op.method} ${op.path})\n\n${op.description}`.slice(0, 2000),
    inputSchema: { type: "object", properties, ...(required.length ? { required } : {}) },
    annotations: {
      title: op.summary,
      readOnlyHint: op.readOnly,
      destructiveHint: op.destructive,
      idempotentHint: ["GET", "PUT", "DELETE"].includes(op.method),
      openWorldHint: true,
    },
  };
}

const directOps = new Map<string, Operation>();
const wanted = toolsets.map((t) => t.toLowerCase());
for (const op of spec.operations.values()) {
  if (!wanted.includes("all") && !wanted.includes(op.tag.toLowerCase())) continue;
  if (!op.readOnly && !allowWrites) continue;
  directOps.set(toolName(op), op);
}
const unknownSets = toolsets.filter((t) => t.toLowerCase() !== "all" && !spec.tags.some((x) => x.name.toLowerCase() === t.toLowerCase()));
if (unknownSets.length) console.error(`[vsp360-mcp] Unknown VSP360_TOOLSETS entries ignored: ${unknownSets.join(", ")}`);

// ---------- handlers ----------

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}

function listOperations(args: Json) {
  const tag = (args.tag ?? "").toLowerCase();
  const query = String(args.query ?? "").trim();
  if (!tag && !query) {
    const lines = spec.tags.map((t) => `- ${t.name} (${t.count}): ${t.description}`);
    return text(`VSP 360 API areas (${spec.operations.size} operations). Pass tag or query to list operations.\n\n${lines.join("\n")}`);
  }
  const fmt = (op: Operation) => `${op.operationId} [${op.readOnly ? "read" : "write"}] ${op.method} ${op.path} — ${op.summary}`;
  if (!query) {
    const ops = [...spec.operations.values()].filter((op) => op.tag.toLowerCase() === tag);
    if (!ops.length) return text("No operations in that area. Call with no arguments to see the available tags.");
    return text(`${ops.length} operation(s) in ${ops[0].tag}:\n${ops.map((op) => "- " + fmt(op)).join("\n")}`);
  }
  const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 40);
  const { hits, confidence, reason } = index.search(query, { tag: tag || undefined, limit });
  if (!hits.length) return text("No operations matched. Try other words, or call with no arguments to see the API areas.");
  const advice = {
    high: "Use the top result; describe it first if you need its parameters.",
    medium: "The top result is likely right. Check its description against the request before calling.",
    low: "Results are ambiguous. Describe the top 2–3 candidates and pick by their descriptions, or refine the query with more specific words.",
  }[confidence];
  const lines = hits.map((h, i) => `${i + 1}. ${fmt(h.op)}  (score ${h.score.toFixed(2)}; matched: ${h.matched.join(", ")})`);
  const hint = confidence !== "high" ? analyticsHint(query) : null;
  return text(`Confidence: ${confidence.toUpperCase()}: ${reason}.\n${advice}${hint ? "\n" + hint : ""}\n\n${lines.join("\n")}`);
}

function describeOperation(args: Json) {
  const op = spec.operations.get(args.operationId);
  if (!op) return text(`Unknown operationId "${args.operationId}". Use vsp360_list_operations to find it.`, true);
  const out: Json = {
    operationId: op.operationId,
    method: op.method,
    path: op.path,
    tag: op.tag,
    access: op.readOnly ? "read" : allowWrites ? "write" : "write (blocked: server is read-only; set VSP360_ALLOW_WRITES=true)",
    summary: op.summary,
    description: op.description,
    parameters: op.params.map((p) => ({ name: p.name, in: p.in, required: p.required, description: p.description, schema: p.schema })),
  };
  if (op.bodyContentType) {
    out.requestBody = { contentType: op.bodyContentType, required: op.bodyRequired, schema: op.bodySchema };
    if (isMultipart(op)) out.requestBody.fileFields = fileFields(op);
  }
  out.response = spec.responseSchema(op);
  return text(JSON.stringify(out, null, 2));
}

async function runOperation(op: Operation, args: CallArgs) {
  if (!op.readOnly && !allowWrites) {
    return text(
      `${op.operationId} (${op.method} ${op.path}) changes VSP 360 state and the server is running read-only. ` +
        `Set VSP360_ALLOW_WRITES=true in the MCP server configuration to enable write operations.`,
      true,
    );
  }
  const result = await getClient().call(op, args);
  return text(result.text, !result.ok);
}

const server = new Server({ name: "vsp360-mcp", version: "0.1.3" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [...META_TOOLS, ...[...directOps.values()].map(directTool)],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name } = req.params;
  const args: Json = req.params.arguments ?? {};
  try {
    if (name === "vsp360_list_operations") return listOperations(args);
    if (name === "vsp360_describe_operation") return describeOperation(args);
    if (name === "vsp360_call_operation") {
      const op = spec.operations.get(args.operationId);
      if (!op) return text(`Unknown operationId "${args.operationId}". Use vsp360_list_operations to find it.`, true);
      return await runOperation(op, args);
    }
    const op = directOps.get(name);
    if (!op) return text(`Unknown tool ${name}`, true);
    const { body, files, all_pages, max_pages, save_to, ...params } = args;
    return await runOperation(op, { params, body, files, all_pages, max_pages, save_to });
  } catch (e) {
    const err = e as Error & { cause?: Error };
    const cause = err.cause ? ` (${err.cause.message})` : "";
    return text(`Error: ${err.message}${cause}`, true);
  }
});

await server.connect(new StdioServerTransport());
console.error(
  `[vsp360-mcp] ready: ${spec.operations.size} operations, ${directOps.size} direct tools, ${allowWrites ? "read/write" : "read-only"}`,
);

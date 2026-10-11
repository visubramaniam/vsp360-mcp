#!/usr/bin/env node
// MCP server for the VSP 360 REST API.
//
// Every operation in the OpenAPI spec is reachable through three discovery
// tools (list, describe, call). Selected tags can also be exposed as one
// direct tool per operation with VSP360_TOOLSETS.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { Spec, type Operation, fileFields, isMultipart } from "./spec.js";
import { Vsp360Client, loadConfig, type CallArgs } from "./client.js";

type Json = any;

const here = dirname(fileURLToPath(import.meta.url));
const spec = new Spec(process.env.VSP360_SPEC || join(here, "..", "spec", "vsp360-openapi.yaml"));
const allowWrites = process.env.VSP360_ALLOW_WRITES === "true";
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
        query: { type: "string", description: "Words to match against operationId, path, summary and description." },
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
    properties[p.name] = { ...p.schema, description: [p.description, p.schema.description].filter(Boolean).join(" ") || undefined };
    if (p.required) required.push(p.name);
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
  const words = String(args.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!tag && !words.length) {
    const lines = spec.tags.map((t) => `- ${t.name} (${t.count}): ${t.description}`);
    return text(`VSP 360 API areas (${spec.operations.size} operations). Pass tag or query to list operations.\n\n${lines.join("\n")}`);
  }
  const matches = [...spec.operations.values()].filter((op) => {
    if (tag && op.tag.toLowerCase() !== tag) return false;
    const hay = `${op.operationId} ${op.path} ${op.summary} ${op.description} ${op.tag}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  if (!matches.length) return text("No operations matched. Call with no arguments to see the available tags.");
  const lines = matches.slice(0, 80).map(
    (op) => `- ${op.operationId} [${op.readOnly ? "read" : "write"}] ${op.method} ${op.path} — ${op.summary}`,
  );
  const more = matches.length > 80 ? `\n\n(${matches.length - 80} more; narrow the query)` : "";
  return text(`${matches.length} operation(s):\n${lines.join("\n")}${more}`);
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

const server = new Server({ name: "vsp360-mcp", version: "0.1.1" }, { capabilities: { tools: {} } });

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

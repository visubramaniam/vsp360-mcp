// MCP tool definitions: the three discovery tools, and one direct tool per operation for VSP360_TOOLSETS.
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { type Operation, fileFields, isMultipart, toolParamName } from "./spec.js";

type Json = any;

export interface ToolOptions {
  allowWrites: boolean;
  /** The decision log is on: offer the `request` argument on searches. */
  logging: boolean;
  /** Collection mode: tell Claude to search before every call. */
  collect: boolean;
}

export function metaTools(o: ToolOptions): Tool[] {
  return [
    {
      name: "vsp360_list_operations",
      description:
        "Browse the VSP 360 REST API. With no arguments, lists the API areas (tags) and how many operations each has. " +
        "With `tag` and/or `query`, lists matching operations (operationId, method, path, summary). " +
        "Use this first to find the operationId you need, then vsp360_describe_operation and vsp360_call_operation." +
        (o.allowWrites ? "" : " Operations marked [write] are blocked because the server runs read-only.") +
        (o.collect
          ? " DATA COLLECTION MODE: search with `query` and `request` for every user question, even if you already know the operation; " +
            "vsp360_call_operation only accepts operations that appeared in a search in the last few minutes."
          : ""),
      inputSchema: {
        type: "object",
        properties: {
          tag: { type: "string", description: "API area, e.g. 'Device Registry', 'Platform Alerts', 'Users'. Case-insensitive." },
          query: { type: "string", description: "What you want to do, in plain words (e.g. 'volumes with no host path', 'replication pairs status'). Ranked by BM25 relevance with a confidence rating." },
          limit: { type: "integer", minimum: 1, maximum: 40, description: "Maximum results for a query (default 10)." },
          // Offered only while the decision log is on: it is recorded, never used for ranking.
          ...(o.logging
            ? { request: { type: "string", description: "The user's request that led to this search, in their own words. Recorded in the local decision log to improve search; does not affect results." + (o.collect ? " Required with `query`." : "") } }
            : {}),
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
        properties: {
          operationId: { type: "string", description: "operationId from vsp360_list_operations" },
          resourceType: { type: "string", description: "analyticsRunQuery only: an MQL resource type (e.g. raidPort, raidPool, vm) to list all its attributes and relations." },
        },
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
        "Binary responses (ZIP, gzip, CSV downloads) are saved to the download folder and the file path is returned." +
        (o.allowWrites ? "" : " Only read operations are allowed; the server runs read-only."),
      inputSchema: {
        type: "object",
        properties: {
          operationId: { type: "string" },
          ...commonCallProperties(true),
        },
        required: ["operationId"],
      },
      annotations: { readOnlyHint: !o.allowWrites, destructiveHint: o.allowWrites, openWorldHint: true },
    },
  ];
}

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
    save_to: { type: "string", description: "Write the response to this file instead of returning it: a file name, or a path inside the download folder. Existing files are not overwritten." },
  };
}

export function toolName(op: Operation): string {
  return op.operationId.length <= 64 ? op.operationId : op.operationId.slice(0, 64);
}

export function directTool(op: Operation): Tool {
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

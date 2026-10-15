#!/usr/bin/env node
// MCP server for the VSP 360 REST API.
//
// Every operation in the OpenAPI spec is reachable through three discovery
// tools (list, describe, call). Selected tags can also be exposed as one
// direct tool per operation with VSP360_TOOLSETS.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Spec, type Operation, fileFields, isMultipart } from "./spec.js";
import { Vsp360Client, loadConfig, type CallArgs } from "./client.js";
import { OperationIndex, hintFor } from "./search.js";
import { DecisionLog } from "./decisionlog.js";
import { AnalyticsFields } from "./analyticsfields.js";
import { features as decisionFeatures, predict, type Decision, type DecisionModel } from "./decision.js";
import { VERSION, loadServerConfig, loadOptionalJson, dropUnfilledSettings } from "./config.js";
import { metaTools, directTool, toolName } from "./tools.js";

type Json = any;

/** Startup steps that read files: a bad file stops the server with one clear line instead of a stack trace. */
function orExit<T>(load: () => T): T {
  try {
    return load();
  } catch (e) {
    const msg = (e as Error).message;
    console.error(msg.startsWith("[vsp360-mcp]") ? msg : `[vsp360-mcp] cannot start: ${msg}`);
    process.exit(1);
  }
}

dropUnfilledSettings();
const cfg = loadServerConfig();
const spec = orExit(() => new Spec(cfg.specPath));
const examples = orExit(() => loadOptionalJson<Record<string, string[]>>(cfg.examplesPath, "example questions", {}));
const index = new OperationIndex(spec.operations.values(), examples);
const analyticsFields = orExit(() => new AnalyticsFields(cfg.analyticsFieldsPath));

// Learned decision model: suggests what to do with a search result. Shown only when VSP360_DECISION_HINT is
// "true", or in a random half of server sessions when it is "ab"; predicted and logged whenever the
// decision log is on, so sessions with and without the hint can be compared.
const decisionModel = orExit(() => loadOptionalJson<DecisionModel | undefined>(cfg.decision.modelPath, "decision model", undefined));
const showHint = !!decisionModel && (cfg.decision.hintMode === "true" || (cfg.decision.hintMode === "ab" && Math.random() < 0.5));
const decisions = new DecisionLog(cfg.decision.logPath, cfg.decision.linkSeconds);
// Collection mode: every search must carry the user's request, and every call must be to an operation that
// came up in a search within the window, so each question yields a labelled search. Needs the decision log.
const collect = decisions.enabled && cfg.decision.collect;
if (cfg.decision.collect && !decisions.enabled) console.error("[vsp360-mcp] VSP360_DECISION_COLLECT ignored: set VSP360_DECISION_LOG to turn the decision log on");

// The client is created on first use so the server can start (and list tools) before VSP 360 is reachable,
// but the settings are checked now so a mistake shows up in the log at startup, not on the first call.
try {
  loadConfig();
} catch (e) {
  console.error(`[vsp360-mcp] warning: ${(e as Error).message}. API calls will fail until this is fixed.`);
}
let client: Vsp360Client | undefined;
function getClient(): Vsp360Client {
  client ??= new Vsp360Client(loadConfig());
  return client;
}

/** Why an operation may not be called with the current settings, if it may not. */
function blockedReason(op: Operation): string | undefined {
  if (!op.readOnly && !cfg.allowWrites) {
    return `${op.operationId} (${op.method} ${op.path}) changes VSP 360 state and the server is running read-only. Set VSP360_ALLOW_WRITES=true in the MCP server configuration to enable write operations.`;
  }
  // A read-only upload (validating a CSV) still sends a local file to VSP 360, so in read-only mode it may only
  // come from the folder the user chose; otherwise a steered model could upload any non-hidden file.
  if (isMultipart(op) && !cfg.allowWrites && !cfg.uploadDirSet) {
    return `${op.operationId} uploads a local file, which read-only mode allows only from VSP360_UPLOAD_DIR. Set VSP360_UPLOAD_DIR in the MCP server configuration to the folder uploads may come from.`;
  }
  if (op.secret && !cfg.allowSecretReads) {
    return `${op.operationId} returns a credential in clear text, which would then be part of the conversation. It is blocked unless VSP360_ALLOW_SECRET_READS=true is set in the MCP server configuration.`;
  }
  return undefined;
}

/** Why a call may not be made with these arguments, for operations that are only read-only with some of them. */
function blockedArgs(op: Operation, params: Record<string, unknown>): string | undefined {
  if (!op.readOnlyParams || cfg.allowWrites) return undefined;
  for (const [name, value] of Object.entries(op.readOnlyParams)) {
    if (params[name] !== value) {
      return `${op.operationId} is read-only only with ${name}=${value}, and the server is running read-only. Set VSP360_ALLOW_WRITES=true in the MCP server configuration to allow other values.`;
    }
  }
  return undefined;
}

const directOps = new Map<string, Operation>();
const wanted = cfg.toolsets.map((t) => t.toLowerCase());
for (const op of spec.operations.values()) {
  if (!wanted.includes("all") && !wanted.includes(op.tag.toLowerCase())) continue;
  if (blockedReason(op)) continue;
  directOps.set(toolName(op), op);
}
const unknownSets = cfg.toolsets.filter((t) => t.toLowerCase() !== "all" && !spec.tags.some((x) => x.name.toLowerCase() === t.toLowerCase()));
if (unknownSets.length) console.error(`[vsp360-mcp] Unknown VSP360_TOOLSETS entries ignored: ${unknownSets.join(", ")}`);

// ---------- handlers ----------

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}

/** Tool arguments are not schema-validated by the SDK; these coerce the few scalars the handlers read. */
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const int = (v: unknown, fallback: number): number => (typeof v === "number" || (typeof v === "string" && v.trim() !== "")) && Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : fallback;

const unknownOperation = (id: unknown) => text(`Unknown operationId "${str(id)}". Use vsp360_list_operations to find it.`, true);

function accessLabel(op: Operation): string {
  const blocked = blockedReason(op);
  if (!op.readOnly && !cfg.allowWrites) return op.secret ? "write, returns a secret (blocked: server is read-only; set VSP360_ALLOW_WRITES=true)" : "write (blocked: server is read-only; set VSP360_ALLOW_WRITES=true)";
  const kind = op.readOnly ? "read" : "write";
  if (op.secret) return blocked ? `${kind}, returns a secret (blocked: set VSP360_ALLOW_SECRET_READS=true)` : `${kind}, returns a secret`;
  if (!op.readOnly) return "write";
  if (op.readOnlyParams && !cfg.allowWrites) return `read only with ${Object.entries(op.readOnlyParams).map(([k, v]) => `${k}=${v}`).join(", ")}`;
  return blocked ? "read, uploads a file (blocked: set VSP360_UPLOAD_DIR)" : "read";
}

function listOperations(args: Json) {
  const tag = str(args.tag).toLowerCase();
  const query = str(args.query).trim();
  if (!tag && !query) {
    const lines = spec.tags.map((t) => `- ${t.name} (${t.count}): ${t.description}`);
    return text(`VSP 360 API areas (${spec.operations.size} operations). Pass tag or query to list operations.\n\n${lines.join("\n")}`);
  }
  const fmt = (op: Operation) => `${op.operationId} [${op.secret ? "secret" : op.readOnly ? "read" : "write"}] ${op.method} ${op.path} — ${op.summary}`;
  if (!query) {
    const ops = [...spec.operations.values()].filter((op) => op.tag.toLowerCase() === tag);
    if (!ops.length) return text("No operations in that area. Call with no arguments to see the available tags.");
    return text(`${ops.length} operation(s) in ${ops[0].tag}:\n${ops.map((op) => "- " + fmt(op)).join("\n")}`);
  }
  const limit = Math.min(Math.max(int(args.limit, 10) || 10, 1), 40);
  // The decision model was trained on 10-result searches, so its features always come from at least that many;
  // only the first `limit` hits are shown and logged.
  const result = index.search(query, { tag: tag || undefined, limit: Math.max(limit, 10) });
  const { confidence, reason, lead, coverage, intent } = result;
  const hits = result.hits.slice(0, limit);
  const hint = hintFor(query, result);
  const suggestion = decisionModel && hits.length && (showHint || decisions.enabled) ? predict(decisionModel, decisionFeatures(query, result, !!hint)) : undefined;
  const request = str(args.request).trim() || undefined;
  if (collect && !request) {
    decisions.refused({ tool: "vsp360_list_operations", reason: "no_request" });
    return text("Data collection mode: pass `request` with the user's question in their own words, then search again.", true);
  }
  decisions.search({
    query, request, tag: tag || undefined, confidence, lead, coverage, intent, analyticsHint: !!hint,
    hits: hits.map((h) => ({ id: h.op.operationId, score: h.score })),
    ...(suggestion ? { suggestion: { decision: suggestion.decision, p: +suggestion.p.toFixed(3), shown: showHint } } : {}),
  });
  if (!hits.length) return text("No operations matched. Try other words, or call with no arguments to see the API areas.");
  // With a HIGH-confidence top result, its parameters come with the results, so Claude can usually call it
  // straight away instead of spending a turn on describe. Analytics is left out: it needs describe's MQL reference.
  const top = hits[0].op;
  const withParams = confidence === "high" && !blockedReason(top) && top.operationId !== "analyticsRunQuery";
  const advice = {
    high: withParams
      ? "Use the top result. Its parameters are listed below, so you can usually call it directly; describe it only if you need the full schema or the response format."
      : "Use the top result; describe it first if you need its parameters.",
    medium: "The top result is likely right. Check its description against the request before calling.",
    low: "Results are ambiguous. Describe the top 2–3 candidates and pick by their descriptions, or refine the query with more specific words.",
  }[confidence];
  const lines = hits.map((h, i) => `${i + 1}. ${fmt(h.op)}  (score ${h.score.toFixed(2)}; matched: ${h.matched.join(", ")})`);
  const suggested = showHint && suggestion ? `\nSuggested next step (learned model, p=${suggestion.p.toFixed(2)}): ${suggestionText(suggestion.decision, hits[0].op.operationId)}` : "";
  const params = withParams ? `\n\nParameters of ${top.operationId}${top.bodyContentType ? " (* = required body field)" : ""}:\n${paramSummary(top)}` : "";
  return text(`Confidence: ${confidence.toUpperCase()}: ${reason}.\n${advice}${hint ? "\n" + hint : ""}${suggested}\n\n${lines.join("\n")}${params}`);
}

/** A short type for a JSON schema: enums list their values, arrays end in [], objects say object. */
function shortType(s: Json): string {
  if (!s || typeof s !== "object") return "any";
  if (Array.isArray(s.enum)) return s.enum.slice(0, 8).map((v: unknown) => JSON.stringify(v)).join("|") + (s.enum.length > 8 ? "|…" : "");
  if (s.type === "array") return `${shortType(s.items)}[]`;
  if (Array.isArray(s.type)) return s.type.join("|");
  return s.type ?? (s.properties ? "object" : "any");
}

/** One line per parameter and body field: enough to build a call without describing the operation. */
function paramSummary(op: Operation): string {
  const MAX = 30;
  const lines = op.params.map((p) => `- ${p.name} (${p.in}, ${p.required ? "required" : "optional"}): ${shortType(p.schema)}`);
  if (op.bodyContentType) {
    const files = fileFields(op);
    const required: string[] = op.bodySchema?.required ?? [];
    const fields = Object.entries<Json>(op.bodySchema?.properties ?? {})
      .filter(([k]) => !files.includes(k))
      .map(([k, s]) => `${k}${required.includes(k) ? "*" : ""}: ${shortType(s)}`);
    const shown = fields.slice(0, MAX).join(", ") + (fields.length > MAX ? `, … ${fields.length - MAX} more` : "");
    lines.push(`- body (${op.bodyContentType}, ${op.bodyRequired ? "required" : "optional"})${fields.length ? `: {${shown}}` : ""}`);
    if (files.length) lines.push(`- files: ${files.map((f) => `${f} (local file path)`).join(", ")}`);
    const nested = Object.values<Json>(op.bodySchema?.properties ?? {}).some((f) => f?.properties || f?.items?.properties);
    if (nested) lines.push("- Some body fields are objects: describe the operation for their fields.");
  }
  if (lines.length > MAX + 1) return [...lines.slice(0, MAX), `- … ${lines.length - MAX} more; describe the operation for the rest`].join("\n");
  return lines.length ? lines.join("\n") : "- none";
}

function suggestionText(d: Decision, top: string): string {
  return {
    call: `use ${top}.`,
    compare: "describe the top 2-3 results and pick by their descriptions.",
    analytics: "answer with analyticsRunQuery (MQL); describe it for the syntax.",
    // Worded to keep Claude looking: in A/B testing, "the API may not cover this" made it give up too early.
    not_found: "the top result is probably not the right one. Describe the top 2-3 to check, then search again with different words if none fits.",
  }[d];
}

function describeOperation(args: Json) {
  const op = spec.operations.get(str(args.operationId));
  if (!op) return unknownOperation(args.operationId);
  decisions.describe(op.operationId);
  const resourceType = str(args.resourceType);
  if (op.operationId === "analyticsRunQuery" && resourceType) {
    const t = analyticsFields.type(resourceType);
    if (!t) return text(`Unknown MQL resource type "${resourceType}". Known types: ${analyticsFields.names().join(", ")}.`, true);
    return text(JSON.stringify(t));
  }
  const out: Json = {
    operationId: op.operationId,
    method: op.method,
    path: op.path,
    tag: op.tag,
    access: accessLabel(op),
    summary: op.summary,
    description: op.description,
    parameters: op.params.map((p) => ({ name: p.name, in: p.in, required: p.required, description: p.description, schema: p.schema })),
  };
  if (op.bodyContentType) {
    out.requestBody = { contentType: op.bodyContentType, required: op.bodyRequired, schema: op.bodySchema };
    if (isMultipart(op)) out.requestBody.fileFields = fileFields(op);
  }
  out.response = spec.responseSchema(op);
  if (op.operationId === "analyticsRunQuery" && analyticsFields.loaded) out.mqlReference = analyticsFields.reference();
  return text(JSON.stringify(out));
}

async function runOperation(op: Operation, args: CallArgs, via: "meta" | "direct") {
  if (collect && !decisions.searchedFor(op.operationId, cfg.decision.collectSeconds)) {
    decisions.refused({ tool: via === "meta" ? "vsp360_call_operation" : toolName(op), operationId: op.operationId, reason: "not_searched" });
    return text(
      `Data collection mode: ${op.operationId} has not appeared in a search in the last ${Math.round(cfg.decision.collectSeconds / 60)} minutes. ` +
        "Call vsp360_list_operations with `query` and `request` (the user's question) first; call this operation if it is in the results.",
      true,
    );
  }
  const argNames = [...Object.keys(args.params ?? {}), ...(args.body !== undefined ? ["body"] : []), ...(args.files ? ["files"] : [])];
  const logged = decisions.call({ operationId: op.operationId, via, argNames });
  const blocked = blockedReason(op) ?? blockedArgs(op, args.params ?? {});
  if (blocked) {
    logged({ status: 0, ok: false, blocked: true });
    return text(blocked, true);
  }
  try {
    const result = await getClient().call(op, args);
    logged({ status: result.status, ok: result.ok });
    return text(result.text, !result.ok);
  } catch (e) {
    logged({ status: 0, ok: false });
    throw e;
  }
}

const server = new Server({ name: "vsp360-mcp", version: VERSION }, { capabilities: { tools: {} } });
const tools = metaTools({ allowWrites: cfg.allowWrites, logging: decisions.enabled, collect });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [...tools, ...[...directOps.values()].map(directTool)],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name } = req.params;
  const args: Json = req.params.arguments ?? {};
  try {
    if (name === "vsp360_list_operations") return listOperations(args);
    if (name === "vsp360_describe_operation") return describeOperation(args);
    if (name === "vsp360_call_operation") {
      const op = spec.operations.get(str(args.operationId));
      if (!op) return unknownOperation(args.operationId);
      return await runOperation(op, args, "meta");
    }
    const op = directOps.get(name);
    if (!op) return text(`Unknown tool ${name}`, true);
    const { body, files, all_pages, max_pages, save_to, ...params } = args;
    return await runOperation(op, { params, body, files, all_pages, max_pages, save_to }, "direct");
  } catch (e) {
    const err = e as Error & { cause?: Error };
    const cause = err.cause ? ` (${err.cause.message})` : "";
    return text(`Error: ${err.message}${cause}`, true);
  }
});

await server.connect(new StdioServerTransport());
console.error(
  `[vsp360-mcp] ready: ${spec.operations.size} operations, ${directOps.size} direct tools, ${cfg.allowWrites ? "read/write" : "read-only"}` +
    (decisions.enabled ? `, decision log on` : "") +
    (collect ? `, collection mode on (${cfg.decision.collectSeconds}s window)` : "") +
    (showHint ? ", decision hint on" : cfg.decision.hintMode !== "false" && !decisionModel ? ", decision hint off (no model file)" : cfg.decision.hintMode === "ab" ? ", decision hint off (A/B control)" : ""),
);

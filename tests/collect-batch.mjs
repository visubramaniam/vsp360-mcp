// Runs a file of user questions through Claude + the vsp360 MCP server, one
// fresh conversation per question, to fill a decision log without typing them.
//
//   ANTHROPIC_API_KEY=... node tests/collect-batch.mjs tests/user-questions-new.txt [options]
//
// Options:
//   --dry-run        list the questions that would run (no Claude calls, no VSP 360 calls)
//   --limit N        stop after N questions this run
//   --only 3,7,12    run only these question numbers
//   --model ID       Claude model (default claude-opus-5-5)
//   --effort LEVEL   low | medium | high (default medium)
//
// Safety and bookkeeping:
// - Each question gets its own vsp360 server process, started with the decision log
//   and collection mode on and writes OFF, whatever the Claude Desktop config says.
// - VSP 360 credentials are read from the env or the Claude Desktop config; never printed.
// - Questions matching the test split of tests/user-questions.tsv are skipped.
// - Progress is kept in reports/batch-state.json, so a rerun resumes where it stopped.
// - Each answer, its tool calls and token usage go to reports/batch-answers.jsonl.
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const LOG = `${root}reports/decisions-batch.jsonl`;
const STATE = `${root}reports/batch-state.json`;
const ANSWERS = `${root}reports/batch-answers.jsonl`;
const MAX_TURNS = 15;

// ---- arguments ----
const argv = process.argv.slice(2);
const VALUED = new Set(["--limit", "--only", "--model", "--effort"]);
const file = argv.find((a, i) => !a.startsWith("--") && !VALUED.has(argv[i - 1]));
const opt = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const dryRun = argv.includes("--dry-run");
const limit = Number(opt("limit")) || Infinity;
const only = opt("only")?.split(",").map(Number);
const model = opt("model") ?? "claude-opus-5-5";
const effort = opt("effort") ?? "medium";
if (!file) { console.error("usage: node tests/collect-batch.mjs <questions.txt> [--dry-run] [--limit N] [--only 1,2] [--model ID] [--effort LEVEL]"); process.exit(1); }

// ---- questions: "N. text" lines, under optional "## Section" headings ----
const norm = (q) => q.toLowerCase().replace(/`[^`]*`/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const testSplit = new Set(
  readFileSync(`${root}tests/user-questions.tsv`, "utf8").split("\n").slice(1).filter(Boolean)
    .map((l) => l.split("\t")).filter((c) => c[2] === "test").map((c) => norm(c[4])),
);
let section = "";
const questions = [];
for (const line of readFileSync(file, "utf8").split("\n")) {
  const h = line.match(/^##\s*(?:\d+\.\s*)?(.*)/);
  if (h) { section = h[1].trim(); continue; }
  const m = line.trim().match(/^(\d+)\.\s+(.+)/);
  if (m) questions.push({ n: +m[1], section, text: m[2].trim() });
}
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { done: {} };
const todo = questions.filter((q) => !state.done[q.n] && !testSplit.has(norm(q.text)) && (!only || only.includes(q.n)));
const skippedTest = questions.filter((q) => testSplit.has(norm(q.text)));
console.log(`${questions.length} questions in ${file}: ${Object.keys(state.done).length} already done, ${skippedTest.length} skipped as test-split questions, ${todo.length} to run${limit < Infinity ? ` (limit ${limit})` : ""}`);
if (skippedTest.length) console.log(`  skipped (test split): ${skippedTest.map((q) => q.n).join(", ")}`);
if (dryRun) { for (const q of todo.slice(0, limit)) console.log(`  ${q.n}. ${q.text}`); process.exit(0); }

// ---- server environment: logging + collection on, writes off ----
function serverEnv() {
  let env = { VSP360_URL: process.env.VSP360_URL, VSP360_CLIENT_ID: process.env.VSP360_CLIENT_ID, VSP360_CLIENT_SECRET: process.env.VSP360_CLIENT_SECRET, VSP360_INSECURE_TLS: process.env.VSP360_INSECURE_TLS };
  if (!env.VSP360_URL) {
    const desktop = JSON.parse(readFileSync(`${homedir()}/Library/Application Support/Claude/claude_desktop_config.json`, "utf8")).mcpServers.vsp360.env;
    env = { VSP360_URL: desktop.VSP360_URL, VSP360_CLIENT_ID: desktop.VSP360_CLIENT_ID, VSP360_CLIENT_SECRET: desktop.VSP360_CLIENT_SECRET, VSP360_INSECURE_TLS: desktop.VSP360_INSECURE_TLS };
  }
  return {
    PATH: process.env.PATH, HOME: process.env.HOME,
    ...Object.fromEntries(Object.entries(env).filter(([, v]) => v)),
    VSP360_DECISION_LOG: LOG, VSP360_DECISION_COLLECT: "true",
    VSP360_MAX_RESPONSE_CHARS: "20000", // keeps tool results, and so token cost, bounded
  };
}

const SYSTEM =
  "You are helping a storage administrator with their Hitachi VSP 360 environment, using the vsp360 tools. " +
  "Answer the question from live data where the tools allow it. If the API cannot answer it, say so briefly. Keep the answer short.";

const anthropic = new Anthropic();
const PRICE = { "claude-opus-5-5": [4, 20], "claude-sonnet-5-5": [2, 10], "claude-haiku-5-5": [0.1, 0.5] }[model];
let spent = { input: 0, output: 0 };

async function ask(q) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [`${root}dist/index.js`], env: serverEnv(), stderr: "ignore" });
  const mcp = new Client({ name: "vsp360-collect-batch", version: "1.0.0" });
  await mcp.connect(transport);
  try {
    const tools = (await mcp.listTools()).tools.map((t) => ({ name: t.name, description: t.description ?? "", input_schema: t.inputSchema }));
    const messages = [{ role: "user", content: q.text }];
    const calls = [];
    let answer = "", stop = "";
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const res = await anthropic.beta.messages.create({
        model, max_tokens: 16000, system: SYSTEM, tools, messages,
        output_config: { effort },
        // Opt into server-side fallback on a safety decline, routed by category.
        betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
      });
      spent.input += res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0);
      spent.output += res.usage.output_tokens;
      stop = res.stop_reason;
      if (stop === "refusal") { answer = `(refused: ${res.stop_details?.category ?? "unknown"})`; break; }
      messages.push({ role: "assistant", content: res.content });
      if (stop === "pause_turn") continue;
      const uses = res.content.filter((b) => b.type === "tool_use");
      if (stop !== "tool_use" || !uses.length) { answer = res.content.filter((b) => b.type === "text").map((b) => b.text).join("\n"); break; }
      const results = [];
      for (const u of uses) {
        const r = await mcp.callTool({ name: u.name, arguments: u.input });
        const text = (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
        calls.push({ tool: u.name, operationId: u.input?.operationId, query: u.input?.query, error: !!r.isError });
        results.push({ type: "tool_result", tool_use_id: u.id, content: text || "(empty)", is_error: !!r.isError });
      }
      messages.push({ role: "user", content: results }); // all results in one message keeps parallel tool use working
    }
    return { answer, stop, calls };
  } finally {
    await mcp.close();
  }
}

// Fail fast on missing credentials or an unknown model, before starting any servers.
try {
  await anthropic.models.retrieve(model);
} catch (e) {
  console.error(`Cannot use ${model}: ${e.message}\nSet ANTHROPIC_API_KEY (or log in with the ant CLI) and check the model ID.`);
  process.exit(1);
}

let ran = 0;
for (const q of todo) {
  if (ran >= limit) break;
  const started = Date.now();
  try {
    const r = await ask(q);
    appendFileSync(ANSWERS, JSON.stringify({ ts: new Date().toISOString(), n: q.n, section: q.section, question: q.text, model, ...r }) + "\n");
    state.done[q.n] = r.stop === "refusal" ? "refused" : "ok";
    const searches = r.calls.filter((c) => c.tool === "vsp360_list_operations" && c.query).length;
    console.log(`#${q.n} ${((Date.now() - started) / 1000).toFixed(0)}s, ${searches} search(es), ${r.calls.length} tool call(s)${r.stop === "refusal" ? ", refused" : ""}`);
  } catch (e) {
    // Leave the question undone so a rerun retries it; stop on auth or quota problems.
    console.error(`#${q.n} failed: ${e.message}`);
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) process.exit(1);
    if (e instanceof Anthropic.RateLimitError) { console.error("Rate limited; rerun later to resume."); break; }
  }
  writeFileSync(STATE, JSON.stringify(state, null, 1));
  ran++;
}
const cost = PRICE ? ` ≈ $${((spent.input * PRICE[0] + spent.output * PRICE[1]) / 1e6).toFixed(2)} at list price` : "";
console.log(`\nRan ${ran} question(s). Tokens: ${spent.input} in, ${spent.output} out${cost}.`);
console.log(`Decision log: ${LOG}\nReport: npm run decision-report -- reports/decisions-batch.jsonl`);

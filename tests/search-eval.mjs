// Offline evaluation of operation search: the old all-words substring filter
// vs. BM25 ranking. Run after `npm run build`:  node tests/search-eval.mjs
// Each case is a plain-language request and the operation(s) that answer it.
import { Spec } from "../dist/spec.js";
import { OperationIndex } from "../dist/search.js";
import { CASES, HELD_OUT, HELD_OUT_2, USER_QUESTIONS } from "./cases.mjs";



const spec = new Spec(new URL("../spec/vsp360-openapi.yaml", import.meta.url).pathname);
const ops = [...spec.operations.values()];
for (const [, want] of [...CASES, ...HELD_OUT, ...HELD_OUT_2]) for (const id of want) if (!spec.operations.has(id)) throw new Error(`Unknown expected id ${id}`);
import { readFileSync } from "node:fs";
const examples = JSON.parse(readFileSync(new URL("../spec/examples.json", import.meta.url), "utf8"));
for (const id of Object.keys(examples)) if (!id.startsWith("_") && !spec.operations.has(id)) throw new Error(`Unknown example id ${id}`);
const missing = ops.filter((op) => !examples[op.operationId]).map((op) => op.operationId);
if (missing.length) console.log(`Operations without examples: ${missing.join(", ")}`);
// Set EXAMPLES=0 to measure plain BM25.
const index = new OperationIndex(ops, process.env.EXAMPLES === "0" ? {} : examples);

// Baseline: the original filter (every query word must appear somewhere), in catalogue order.
const oldSearch = (q) => {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return ops.filter((op) => words.every((w) => `${op.operationId} ${op.path} ${op.summary} ${op.description} ${op.tag}`.toLowerCase().includes(w))).map((op) => op.operationId);
};

function evaluate(label, CASES) {
const rankOf = (list, want) => { const i = list.findIndex((id) => want.includes(id)); return i < 0 ? Infinity : i + 1; };
const stats = (name) => ({ name, top1: 0, top3: 0, mrr: 0, empty: 0 });
const old = stats("Old: all-words filter"), bm = stats("BM25");
const byConf = { high: [0, 0], medium: [0, 0], low: [0, 0] };
const rows = [];
for (const [q, want] of CASES) {
  const o = oldSearch(q), r = index.search(q, { limit: 10 });
  const ro = rankOf(o, want), rb = rankOf(r.hits.map((h) => h.op.operationId), want);
  for (const [s, rank, n] of [[old, ro, o.length], [bm, rb, r.hits.length]]) {
    if (rank === 1) s.top1++; if (rank <= 3) s.top3++; if (rank < Infinity) s.mrr += 1 / rank; if (!n) s.empty++;
  }
  byConf[r.confidence][0]++; if (rb === 1) byConf[r.confidence][1]++;
  rows.push([q, ro, o.length, rb, r.confidence, r.hits[0]?.op.operationId]);
}
const n = CASES.length;
console.log(`\n=== ${label}: ${n} requests\n`);
console.log("method                  top-1    top-3    MRR    no results");
for (const s of [old, bm]) console.log(`${s.name.padEnd(22)}  ${String(s.top1).padStart(2)}/${n}    ${String(s.top3).padStart(2)}/${n}    ${(s.mrr / n).toFixed(2)}   ${s.empty}`);
console.log("\nBM25 confidence calibration (top-1 correct / cases):");
for (const [c, [cases, ok]] of Object.entries(byConf)) console.log(`  ${c.padEnd(6)} ${ok}/${cases}${cases ? `  (${Math.round((100 * ok) / cases)}%)` : ""}`);
console.log("\nBM25 misses (top-1 wrong):");
for (const [q, ro, on, rb, c, top] of rows) if (rb !== 1) console.log(`  [${c}] "${q}" → rank ${rb === Infinity ? "–" : rb}; top was ${top}`);
}
evaluate("Tuning set", CASES);
evaluate("Held-out set", HELD_OUT);
evaluate("Held-out set 2", HELD_OUT_2);

// Real user questions: the labelled part of tests/user-queries.md (n, section, split, expected, question),
// labelled per question. expected is operationIds separated by |, or ANALYTICS, NONE or META. Only the
// "test" split is scored by default; SPLIT=train scores the tuning split instead.
// Each question is judged by what a good answer needs:
//   operation(s)  the top result (or top 3) is one of them; ANALYTICS in the list also
//                 accepts analyticsRunQuery or the analytics hint
//   ANALYTICS     analyticsRunQuery is in the top 3 or the analytics hint is shown
//   NONE          no operation fits, so search should not be HIGH confidence
//   META          answered by the discovery tools themselves; not scored
import { analyticsHint } from "../dist/search.js";
{
  const split = process.env.SPLIT ?? "test";
  const rows = USER_QUESTIONS.filter((r) => r.split === split);
  for (const r of rows) for (const id of r.want) if (!["ANALYTICS", "NONE", "META"].includes(id) && !spec.operations.has(id)) throw new Error(`Unknown expected id ${id} in question ${r.n}`);
  const kind = (r) => (r.want[0] === "META" ? "meta" : r.want[0] === "NONE" ? "none" : r.want.every((w) => w === "ANALYTICS") ? "analytics" : "op");
  const res = { op: { n: 0, top1: 0, top3: 0 }, analytics: { n: 0, ok: 0 }, none: { n: 0, notHigh: 0 } };
  const conf = { high: [0, 0], medium: [0, 0], low: [0, 0] };
  const misses = [];
  for (const r of rows) {
    const k = kind(r); if (k === "meta") continue;
    const s = index.search(r.question, { limit: 10 });
    const ids = s.hits.map((h) => h.op.operationId);
    const hint = s.confidence !== "high" && !!analyticsHint(r.question);
    const hitAt = (i) => r.want.includes(ids[i]) || (r.want.includes("ANALYTICS") && (ids[i] === "analyticsRunQuery" || (i === 0 && hint)));
    let ok;
    if (k === "op") { res.op.n++; const t1 = hitAt(0), t3 = t1 || hitAt(1) || hitAt(2); res.op.top1 += t1; res.op.top3 += t3; ok = t1; }
    if (k === "analytics") { res.analytics.n++; ok = hint || ids.slice(0, 3).includes("analyticsRunQuery"); res.analytics.ok += ok; }
    if (k === "none") { res.none.n++; ok = s.confidence !== "high"; res.none.notHigh += ok; }
    conf[s.confidence][0]++; conf[s.confidence][1] += ok;
    if (!ok) misses.push(`  #${r.n} [${s.confidence}] (${k}) "${r.question}" → top was ${ids[0] ?? "–"}${hint ? " +hint" : ""}; want ${r.want.join("|")}`);
  }
  console.log(`\n=== User questions (${split} split): ${rows.length} questions\n`);
  console.log(`Operation questions  top-1 ${res.op.top1}/${res.op.n}   top-3 ${res.op.top3}/${res.op.n}`);
  console.log(`Analytics questions  routed to analyticsRunQuery or hint ${res.analytics.ok}/${res.analytics.n}`);
  console.log(`Unanswerable (NONE)  not rated HIGH ${res.none.notHigh}/${res.none.n}`);
  console.log("\nConfidence calibration (judged correct / cases):");
  for (const [c, [n, ok]] of Object.entries(conf)) console.log(`  ${c.padEnd(6)} ${ok}/${n}${n ? `  (${Math.round((100 * ok) / n)}%)` : ""}`);
  console.log("\nMisses:"); for (const m of misses) console.log(m);
}

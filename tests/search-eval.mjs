// Offline evaluation of operation search. Run after `npm run build`:  node tests/search-eval.mjs
// Scores three development request sets and the held-out labelled user questions, and exits with an error if
// any score falls below its regression threshold (set to the scores when the threshold was last raised).
//   EXAMPLES=0  measure plain BM25 without the example questions (thresholds not checked)
//   SPLIT=train score the labelled questions' train split instead of the test split (thresholds not checked)
import { readFileSync } from "node:fs";
import { Spec } from "../dist/spec.js";
import { OperationIndex, hintFor } from "../dist/search.js";
import { CASES, HELD_OUT, HELD_OUT_2, USER_QUESTIONS } from "./cases.mjs";

// Minimum scores. Raise them when search improves; never lower them to make a change pass. They were re-based
// once, for the Platform spec, because what is measured changed: NDM was removed (one held-out request dropped,
// labelled question #78 became "not available"), and spec text changes moved #113's answer from 3rd to 4th.
const THRESHOLDS = {
  "Tuning set": { top1: 32, top3: 38 },
  "Held-out set": { top1: 11, top3: 15 },
  "Held-out set 2": { top1: 17, top3: 25 },
  user: { opTop1: 30, opTop3: 38, analytics: 14, noneNotHigh: 7 },
};

const spec = new Spec(new URL("../spec/Platform-vsp360-openapi.yaml", import.meta.url).pathname);
const ops = [...spec.operations.values()];
for (const [, want] of [...CASES, ...HELD_OUT, ...HELD_OUT_2]) for (const id of want) if (!spec.operations.has(id)) throw new Error(`Unknown expected id ${id}`);
const examples = JSON.parse(readFileSync(new URL("../spec/examples.json", import.meta.url), "utf8"));
for (const id of Object.keys(examples)) if (!id.startsWith("_") && !spec.operations.has(id)) throw new Error(`Unknown example id ${id}`);
const missing = ops.filter((op) => !examples[op.operationId]).map((op) => op.operationId);
if (missing.length) console.log(`Operations without examples: ${missing.join(", ")}`);
const index = new OperationIndex(ops, process.env.EXAMPLES === "0" ? {} : examples);
const checking = process.env.EXAMPLES !== "0" && !process.env.SPLIT;
const failures = [];

function evaluate(label, cases) {
  const rankOf = (list, want) => { const i = list.findIndex((id) => want.includes(id)); return i < 0 ? Infinity : i + 1; };
  const s = { top1: 0, top3: 0, mrr: 0, empty: 0 };
  const byConf = { high: [0, 0], medium: [0, 0], low: [0, 0] };
  const rows = [];
  for (const [q, want] of cases) {
    const r = index.search(q, { limit: 10 });
    const rank = rankOf(r.hits.map((h) => h.op.operationId), want);
    if (rank === 1) s.top1++; if (rank <= 3) s.top3++; if (rank < Infinity) s.mrr += 1 / rank; if (!r.hits.length) s.empty++;
    byConf[r.confidence][0]++; if (rank === 1) byConf[r.confidence][1]++;
    rows.push([q, rank, r.confidence, r.hits[0]?.op.operationId]);
  }
  const n = cases.length;
  console.log(`\n=== ${label}: ${n} requests\n`);
  console.log("method  top-1    top-3    MRR    no results");
  console.log(`BM25    ${String(s.top1).padStart(2)}/${n}    ${String(s.top3).padStart(2)}/${n}    ${(s.mrr / n).toFixed(2)}   ${s.empty}`);
  console.log("\nConfidence calibration (top-1 correct / cases):");
  for (const [c, [k, ok]] of Object.entries(byConf)) console.log(`  ${c.padEnd(6)} ${ok}/${k}${k ? `  (${Math.round((100 * ok) / k)}%)` : ""}`);
  console.log("\nMisses (top-1 wrong):");
  for (const [q, rank, c, top] of rows) if (rank !== 1) console.log(`  [${c}] "${q}" → rank ${rank === Infinity ? "–" : rank}; top was ${top}`);
  const t = THRESHOLDS[label];
  if (checking && t) for (const k of ["top1", "top3"]) if (s[k] < t[k]) failures.push(`${label} ${k} ${s[k]}/${n} is below ${t[k]}`);
}
evaluate("Tuning set", CASES);
evaluate("Held-out set", HELD_OUT);
evaluate("Held-out set 2", HELD_OUT_2);

// Labelled user questions (tests/user-queries.md, Part 2). Each is judged by what a good answer needs:
//   operation(s)  the top result (or top 3) is one of them; ANALYTICS in the list also
//                 accepts analyticsRunQuery or the analytics hint
//   ANALYTICS     analyticsRunQuery is in the top 3 or the analytics hint is shown
//   NONE          no operation fits, so search should not be HIGH confidence
//   META          answered by the discovery tools themselves; not scored
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
    const hint = !!hintFor(r.question, s);
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
  const t = THRESHOLDS.user;
  if (checking) {
    if (res.op.top1 < t.opTop1) failures.push(`user questions: operation top-1 ${res.op.top1} is below ${t.opTop1}`);
    if (res.op.top3 < t.opTop3) failures.push(`user questions: operation top-3 ${res.op.top3} is below ${t.opTop3}`);
    if (res.analytics.ok < t.analytics) failures.push(`user questions: analytics routing ${res.analytics.ok} is below ${t.analytics}`);
    if (res.none.notHigh < t.noneNotHigh) failures.push(`user questions: unanswerable not rated HIGH ${res.none.notHigh} is below ${t.noneNotHigh}`);
  }
}

if (checking) {
  if (failures.length) {
    console.error(`\nSEARCH REGRESSION:\n  ${failures.join("\n  ")}`);
    process.exitCode = 1;
  } else console.log("\nAll scores meet their regression thresholds.");
}

// Trains the search decision model and compares it with the fixed confidence
// thresholds. Run after `npm run build`:  node tests/train-decision.mjs [--write]
//
// Training data: the user-question "train" split, the tuning and held-out
// request sets written during development, and (unless BATCH=0) the searches in
// reports/decisions-batch.jsonl labelled by what Claude went on to call. Test data: the user-question "test"
// split only, which is never used for training or for choosing settings.
// --write saves the model to spec/decision-model.json.
import { readFileSync, writeFileSync } from "node:fs";
import { Spec } from "../dist/spec.js";
import { OperationIndex, hintFor } from "../dist/search.js";
import { FEATURES, DECISIONS, features, predict } from "../dist/decision.js";
import { CASES, HELD_OUT, HELD_OUT_2, USER_QUESTIONS } from "./cases.mjs";

const spec = new Spec(new URL("../spec/vsp360-openapi.yaml", import.meta.url).pathname);
const examples = JSON.parse(readFileSync(new URL("../spec/examples.json", import.meta.url), "utf8"));
const index = new OperationIndex(spec.operations.values(), examples);

// The right decision for a request, given what search returned.
function gold(want, ids) {
  if (want[0] === "NONE") return "not_found";
  if (want.every((w) => w === "ANALYTICS")) return "analytics";
  if (want.includes(ids[0])) return ids[0] === "analyticsRunQuery" ? "analytics" : "call";
  if (want.some((w) => ids.slice(1, 3).includes(w))) return "compare";
  if (want.includes("ANALYTICS")) return "analytics";
  return "not_found";
}

// What the current thresholds tell the model to do.
function thresholds(s, hint) {
  if (s.hits[0]?.op.operationId === "analyticsRunQuery" || hint) return "analytics";
  if (s.confidence === "low") return "compare";
  return "call";
}

function row(question, want, source) {
  const s = index.search(question, { limit: 10 });
  const hint = !!hintFor(question, s);
  const ids = s.hits.map((h) => h.op.operationId);
  return { question, source, x: features(question, s, hint), y: gold(want, ids), base: thresholds(s, hint), top1: ids[0] };
}

const toRows = (set, source) => set.map(([q, want]) => row(q, want, source));
const user = USER_QUESTIONS.filter((r) => r.want[0] !== "META");
const train = [
  ...toRows(CASES, "tuning"), ...toRows(HELD_OUT, "held-out"), ...toRows(HELD_OUT_2, "held-out-2"),
  ...user.filter((r) => r.split === "train").map((r) => row(r.question, r.want, "user-train")),
];
const test = user.filter((r) => r.split === "test").map((r) => row(r.question, r.want, "user-test"));

// Logged batch searches. Each is re-run with the current index on Claude's own query (what the
// server actually sees), and labelled by the first operation Claude called successfully for that
// question: an Analytics query means "analytics", otherwise its rank decides call / compare /
// not_found. Questions with no successful call are skipped (nothing to learn), as are questions
// about array objects that Claude answered with VSP 360's own platform metrics (a wrong choice).
function batchRows(path) {
  if (process.env.BATCH === "0") return [];
  let lines;
  try { lines = readFileSync(path, "utf8").split("\n").filter(Boolean); } catch { return []; }
  const sessions = new Map();
  for (const e of lines.map((l) => JSON.parse(l))) (sessions.get(e.session) ?? sessions.set(e.session, []).get(e.session)).push(e);
  const out = [];
  let skipped = 0, hinted = 0;
  for (const events of sessions.values()) {
    const searches = events.filter((e) => e.event === "search");
    // Sessions that were shown the hint were steered by the model itself; learning from them would teach it to
    // agree with its own past suggestions. HINTED=1 includes them anyway.
    if (process.env.HINTED !== "1" && searches.some((s) => s.suggestion?.shown)) { hinted += searches.length; continue; }
    const chosen = events.find((e) => e.event === "call" && e.ok)?.operationId;
    const request = searches[0]?.request ?? "";
    const platformForArray = /^vsp360Get(MetricsQuery|MetricsQueryRange|SystemInfo)$/.test(chosen ?? "") && /\b(pool|port|ldev|volume|array|host group|lun)s?\b/i.test(request);
    if (!chosen || platformForArray) { skipped += searches.length; continue; }
    const want = chosen === "analyticsRunQuery" ? ["ANALYTICS"] : [chosen];
    // Hold out about a fifth of the questions, chosen by a hash of the question text so the split is stable
    // across reruns and every search for one question lands on the same side.
    const held = [...request].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % 5 === 0;
    for (const s of searches) out.push({ ...row(s.query, want, held ? "batch-test" : "batch"), request });
  }
  console.log(`Batch log: ${out.length} labelled searches, ${skipped} skipped (no successful call, or platform metrics for an array question), ${hinted} from sessions that saw the hint`);
  return out;
}
const batch = batchRows(new URL("../reports/decisions-batch.jsonl", import.meta.url));
train.push(...batch.filter((r) => r.source === "batch"));
const batchTest = batch.filter((r) => r.source === "batch-test");
console.log(`Batch split: ${batch.length - batchTest.length} searches for training, ${batchTest.length} held out (${new Set(batchTest.map((r) => r.request)).size} questions)`);

// ---- multinomial logistic regression, full-batch gradient descent with L2 ----
function fit(rows, lambda) {
  const d = FEATURES.length, k = DECISIONS.length;
  const mean = Array.from({ length: d }, (_, i) => rows.reduce((s, r) => s + r.x[i], 0) / rows.length);
  const std = Array.from({ length: d }, (_, i) => Math.sqrt(rows.reduce((s, r) => s + (r.x[i] - mean[i]) ** 2, 0) / rows.length) || 1);
  const Z = rows.map((r) => [1, ...r.x.map((v, i) => (v - mean[i]) / std[i])]);
  const Y = rows.map((r) => DECISIONS.indexOf(r.y));
  // Weight classes by inverse frequency so a rare decision (not_found) is not ignored.
  const counts = DECISIONS.map((_, c) => Y.filter((y) => y === c).length || 1);
  const cw = counts.map((n) => rows.length / (k * n));
  const W = Array.from({ length: k }, () => new Array(d + 1).fill(0));
  for (let it = 0; it < 3000; it++) {
    const G = W.map((w) => w.map(() => 0));
    Z.forEach((z, n) => {
      const l = W.map((w) => w.reduce((s, wi, i) => s + wi * z[i], 0));
      const m = Math.max(...l); const e = l.map((v) => Math.exp(v - m)); const sum = e.reduce((a, b) => a + b, 0);
      for (let c = 0; c < k; c++) { const g = (e[c] / sum - (Y[n] === c ? 1 : 0)) * cw[Y[n]]; for (let i = 0; i <= d; i++) G[c][i] += g * z[i]; }
    });
    for (let c = 0; c < k; c++) for (let i = 0; i <= d; i++) W[c][i] -= 0.1 * (G[c][i] / rows.length + (i ? lambda * W[c][i] : 0));
  }
  return { features: [...FEATURES], classes: [...DECISIONS], mean, std, weights: W };
}

// Choose L2 strength by 5-fold cross-validation on the training rows only.
const folds = 5;
const order = train.map((_, i) => i).sort((a, b) => ((a * 7919) % 101) - ((b * 7919) % 101));
let best = { lambda: 0, acc: -1 };
for (const lambda of [0.001, 0.01, 0.03, 0.1, 0.3, 1]) {
  let ok = 0;
  for (let f = 0; f < folds; f++) {
    const held = new Set(order.filter((_, j) => j % folds === f));
    const m = fit(train.filter((_, i) => !held.has(i)), lambda);
    for (const i of held) ok += predict(m, train[i].x).decision === train[i].y;
  }
  const acc = ok / train.length;
  console.log(`  lambda ${String(lambda).padEnd(5)} cross-validated accuracy ${(100 * acc).toFixed(1)}%`);
  if (acc > best.acc) best = { lambda, acc };
}
const model = { ...fit(train, best.lambda), trainedOn: `${train.length} requests (user train split + development sets), lambda ${best.lambda}` };

// ---- evaluation on the held-out user questions ----
function report(label, rows, decide) {
  const conf = Object.fromEntries(DECISIONS.map((g) => [g, Object.fromEntries(DECISIONS.map((p) => [p, 0]))]));
  let ok = 0, wrongCalls = 0, calls = 0;
  for (const r of rows) {
    const p = decide(r); conf[r.y][p]++; ok += p === r.y;
    if (p === "call") { calls++; if (r.y !== "call") wrongCalls++; }
  }
  console.log(`\n${label}: ${ok}/${rows.length} decisions right (${Math.round((100 * ok) / rows.length)}%); ${wrongCalls} of ${calls} "call" decisions would call the wrong operation`);
  console.log(`  right answer →   ${DECISIONS.map((d) => d.padStart(10)).join("")}   (decided)`);
  for (const g of DECISIONS) console.log(`  ${g.padEnd(14)} ${DECISIONS.map((p) => String(conf[g][p]).padStart(10)).join("")}`);
}

console.log(`\nTraining rows: ${train.length}   test rows: ${test.length}   chosen lambda: ${best.lambda}`);
console.log(`Right decisions in the test set: ${DECISIONS.map((d) => `${d} ${test.filter((r) => r.y === d).length}`).join(", ")}`);
report("Fixed thresholds (current)", test, (r) => r.base);
report("Decision model", test, (r) => predict(model, r.x).decision);
if (batchTest.length) {
  console.log(`\n--- Held-out batch searches (Claude's own queries, labelled by what it called): ${batchTest.length}`);
  console.log(`Right decisions: ${DECISIONS.map((d) => `${d} ${batchTest.filter((r) => r.y === d).length}`).join(", ")}`);
  report("Fixed thresholds (current)", batchTest, (r) => r.base);
  report("Decision model", batchTest, (r) => predict(model, r.x).decision);
}

console.log("\nLargest weights per decision (standardised features):");
model.classes.forEach((c, k) => {
  const w = model.features.map((f, i) => [f, model.weights[k][i + 1]]).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 4);
  console.log(`  ${c.padEnd(10)} ${w.map(([f, v]) => `${f} ${v >= 0 ? "+" : ""}${v.toFixed(2)}`).join(", ")}`);
});

if (process.argv.includes("--write")) {
  writeFileSync(new URL("../spec/decision-model.json", import.meta.url), JSON.stringify(model, (k, v) => (typeof v === "number" ? +v.toFixed(5) : v), 1) + "\n");
  console.log("\nWrote spec/decision-model.json");
}

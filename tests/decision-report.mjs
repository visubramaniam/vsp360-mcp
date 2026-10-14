// Turns a VSP360_DECISION_LOG file into one labelled row per search, the
// training data for a model that decides what to do with a search result.
//   node tests/decision-report.mjs <log.jsonl> [--csv out.csv]
// Calls the server could not tie to a recent search (see VSP360_DECISION_LINK_SECONDS)
// are counted separately as unlinked calls.
// Label (outcome) for each search, from what happened before the next search:
//   called_top1   the top result was called (directly or after describing)
//   called_other  a lower-ranked result was called
//   called_absent an operation not in the results was called
//   no_call       nothing was called (abandoned, or answered another way)
import { readFileSync, writeFileSync } from "node:fs";

const [file, flag, out] = process.argv.slice(2);
if (!file) { console.error("usage: node tests/decision-report.mjs <log.jsonl> [--csv out.csv]"); process.exit(1); }

const events = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const searches = new Map(); // `${session}:${seq}` -> row
for (const e of events) {
  const key = `${e.session}:${e.event === "search" ? e.seq : e.searchSeq}`;
  if (e.event === "search") {
    searches.set(key, {
      ts: e.ts, session: e.session, query: e.query, request: e.request ?? "", tag: e.tag ?? "", confidence: e.confidence,
      lead: e.lead, coverage: e.coverage, intent: e.intent ?? "", analyticsHint: e.analyticsHint,
      top1: e.hits[0]?.id ?? "", nHits: e.hits.length, described: 0, calledId: "", calledRank: "", callOk: "", outcome: "no_call",
    });
    continue;
  }
  const row = searches.get(key);
  if (!row) continue;
  if (e.event === "describe") row.described++;
  if (e.event === "call" && !row.calledId) {
    Object.assign(row, { calledId: e.operationId, calledRank: e.rank ?? "", callOk: e.blocked ? "blocked" : e.ok });
    row.outcome = e.rank === 1 ? "called_top1" : e.rank ? "called_other" : "called_absent";
  }
}

const rows = [...searches.values()];
const calls = events.filter((e) => e.event === "call");
const unlinked = calls.filter((e) => e.searchSeq == null).length;
const by = (k) => rows.reduce((m, r) => ((m[r[k]] ??= []).push(r), m), {});
console.log(`${rows.length} searches in ${new Set(rows.map((r) => r.session)).size} sessions; ${calls.length} calls, ${unlinked} not tied to a recent search; ${rows.filter((r) => r.request).length} searches carry the user's own request\n`);
console.log("confidence  searches  top1 called  other called  absent  no call");
for (const [c, rs] of Object.entries(by("confidence"))) {
  const n = (o) => rs.filter((r) => r.outcome === o).length;
  console.log(`${c.padEnd(10)}  ${String(rs.length).padStart(8)}  ${String(n("called_top1")).padStart(11)}  ${String(n("called_other")).padStart(12)}  ${String(n("called_absent")).padStart(6)}  ${String(n("no_call")).padStart(7)}`);
}
const misses = rows.filter((r) => r.outcome === "called_other" || r.outcome === "called_absent");
if (misses.length) {
  console.log("\nSearches where the called operation was not the top result:");
  for (const r of misses) console.log(`  [${r.confidence}] "${r.query}"${r.request ? ` (asked: "${r.request}")` : ""} → called ${r.calledId} (rank ${r.calledRank || "–"}); top was ${r.top1}`);
}

if (flag === "--csv" && out) {
  const cols = Object.keys(rows[0] ?? {});
  const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ""));
  writeFileSync(out, [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n") + "\n");
  console.log(`\nWrote ${rows.length} rows to ${out}`);
}

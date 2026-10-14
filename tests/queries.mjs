// Reads tests/user-queries.md, the single file of user questions for evaluation, training and batch runs.
//
// The file is divided into parts ("## Part N: Title") holding sections ("### Section") of tables. The table's
// header row decides what kind of question it holds:
//   | # | Prompt | Expected path | Check |       regression prompts, checked by hand
//   | # | Question | Expected | Split |        labelled questions, scored by the eval and used for training
//   | # | Question |                          unlabelled batch questions, run by collect-batch
// In the Expected column, `operationId`s are acceptable answers, "Analytics (MQL)" means analyticsRunQuery or
// the analytics hint, "not available in the API" means no operation answers it, and "discovery tools" means the
// question is about the API itself (not scored). Split is "test" (held out) or "train".
import { readFileSync } from "node:fs";

export const QUERIES_FILE = new URL("./user-queries.md", import.meta.url);

const LABELS = { "analytics (mql)": "ANALYTICS", "not available in the api": "NONE", "discovery tools": "META" };

const cells = (line) => line.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));

function parseExpected(text) {
  return text.split(/,\s*/).map((t) => t.trim()).filter(Boolean).map((t) => {
    const code = t.match(/^`([^`]+)`$/);
    if (code) return code[1];
    const label = LABELS[t.toLowerCase()];
    if (!label) throw new Error(`user-queries.md: unknown Expected value "${t}"`);
    return label;
  });
}

/** Every question in the file: { part, partTitle, kind, n, section, question, want?, split?, expectedPath?, check? } */
export function loadQueries(file = QUERIES_FILE) {
  const out = [];
  let part = 0, partTitle = "", section = "", header = null;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const p = line.match(/^## Part (\d+):\s*(.*)/);
    if (p) { part = +p[1]; partTitle = p[2].trim(); section = ""; header = null; continue; }
    if (/^## /.test(line)) { part = 0; header = null; continue; } // e.g. "Duplicates removed": not questions
    const s = line.match(/^###\s+(.*)/);
    if (s) { section = s[1].trim(); header = null; continue; }
    if (!part || !line.startsWith("|")) continue;
    const c = cells(line);
    if (c[0] === "#") { header = c.map((h) => h.toLowerCase()); continue; }
    if (!header || /^-+$/.test(c[0].replace(/:/g, "")) || !/^\d+(\.\d+)?$/.test(c[0])) continue;
    const row = Object.fromEntries(header.map((h, i) => [h, c[i] ?? ""]));
    const base = { part, partTitle, section, n: row["#"] };
    if ("prompt" in row) out.push({ ...base, kind: "regression", question: row.prompt, expectedPath: row["expected path"], check: row.check });
    else if ("split" in row) out.push({ ...base, kind: "labelled", n: +row["#"], question: row.question, want: parseExpected(row.expected), split: row.split });
    else out.push({ ...base, kind: "batch", n: +row["#"], question: row.question });
  }
  return out;
}

/** Normalised question text, for matching logged requests against the file. */
export const norm = (q) => q.toLowerCase().replace(/`[^`]*`/g, "").replace(/[^a-z0-9]+/g, " ").trim();

/** Labelled questions: { n, section, split, want[], question }. */
export const labelledQuestions = (file) => loadQueries(file).filter((q) => q.kind === "labelled");

/** Normalised text of the held-out (test split) questions, to keep them out of training and batch runs. */
export const testSplit = (file) => new Set(labelledQuestions(file).filter((q) => q.split === "test").map((q) => norm(q.question)));

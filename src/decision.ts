// A small learned model of what to do with a search result: call the top
// operation, compare the top few, answer with Analytics (MQL), or treat the
// request as not answerable by these results. Multinomial logistic regression
// over search signals; weights are trained offline by tests/train-decision.mjs
// and loaded from spec/decision-model.json.
import { words, type SearchResult } from "./search.js";

export const DECISIONS = ["call", "compare", "analytics", "not_found"] as const;
export type Decision = (typeof DECISIONS)[number];

export const FEATURES = [
  "logLead", "coverage", "intentRead", "intentWrite", "analyticsHint", "top1Analytics", "analyticsInTop3",
  "logTopScore", "logQueryTerms", "hasIdentifier", "top2SameTag", "top1ById", "readIntentWriteTop1",
] as const;

export interface DecisionModel {
  features: string[];
  classes: string[];
  mean: number[];
  std: number[];
  /** weights[class][1 + feature]; index 0 is the bias. */
  weights: number[][];
  trainedOn?: string;
}

export function features(query: string, r: SearchResult, hint: boolean): number[] {
  const ids = r.hits.map((h) => h.op.operationId);
  const [a, b] = r.hits;
  const terms = words(query).filter((t) => t.length > 1).length;
  return [
    Math.log(Math.min(r.lead ?? 3, 3)),
    r.coverage,
    r.intent === "read" ? 1 : 0,
    r.intent === "write" ? 1 : 0,
    hint ? 1 : 0,
    ids[0] === "analyticsRunQuery" ? 1 : 0,
    ids.slice(0, 3).includes("analyticsRunQuery") ? 1 : 0,
    Math.log(1 + (a?.score ?? 0)),
    Math.log(1 + terms),
    // Named objects (`pool-01`, ALT-8832, LDEV 10:2A) point at data questions rather than API features.
    /`[^`]+`|\b[a-z]+-\d+\b|\b\d+:[0-9a-f]+\b/i.test(query) ? 1 : 0,
    a && b && a.op.tag === b.op.tag ? 1 : 0,
    a && /\{[^}]+\}/.test(a.op.path) ? 1 : 0,
    r.intent === "read" && a && !a.op.readOnly ? 1 : 0,
  ];
}

export function predict(model: DecisionModel, x: number[]): { decision: Decision; p: number } {
  const z = x.map((v, i) => (v - model.mean[i]) / (model.std[i] || 1));
  const logits = model.weights.map((w) => w[0] + z.reduce((s, v, i) => s + v * w[i + 1], 0));
  const m = Math.max(...logits);
  const e = logits.map((l) => Math.exp(l - m));
  const sum = e.reduce((s, v) => s + v, 0);
  const best = e.indexOf(Math.max(...e));
  return { decision: model.classes[best] as Decision, p: e[best] / sum };
}

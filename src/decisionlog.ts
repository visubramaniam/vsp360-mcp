// Opt-in local log of search → describe → call decisions, for training and
// evaluating a model of what to do with a search result. Enabled by setting
// VSP360_DECISION_LOG to a file path; one JSON object per line.
//
// What is logged: the query text (and, when the client passes it, the user's
// own request that led to the search), search features and ranked operationIds,
// which operation was then described or called, its rank in the last search,
// and the call's HTTP status. What is never logged: argument values, request
// or response bodies, headers, tokens, or credentials. Argument *names* are
// logged so a model can tell a list call from a by-id call.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

type Event = Record<string, unknown>;

export class DecisionLog {
  private readonly session = randomUUID();
  private seq = 0;
  private lastSearch: { seq: number; ids: string[]; at: number } | undefined;
  /** Searches kept for collection mode's "was this operation searched for?" check. */
  private recent: { ids: Set<string>; at: number }[] = [];

  /**
   * @param linkSeconds a describe or call is tied to the latest search only if it starts within this many
   *   seconds of it; later actions are logged unlinked rather than credited to an unrelated search.
   */
  constructor(private readonly path: string | undefined, private readonly linkSeconds = 120) {
    if (path) mkdirSync(dirname(path), { recursive: true });
  }

  get enabled(): boolean {
    return !!this.path;
  }

  search(e: { query: string; request?: string; tag?: string; confidence: string; lead: number | null; coverage: number; intent: string | null; analyticsHint: boolean; hits: { id: string; score: number }[]; suggestion?: { decision: string; p: number; shown: boolean } }): void {
    if (!this.path) return;
    const seq = this.write({ event: "search", ...e, hits: e.hits.map((h) => ({ id: h.id, score: +h.score.toFixed(3) })) });
    this.lastSearch = { seq, ids: e.hits.map((h) => h.id), at: Date.now() };
    this.recent.push({ ids: new Set(this.lastSearch.ids), at: this.lastSearch.at });
  }

  /** Collection mode: true if the operation appeared in a search result within the last windowSeconds. */
  searchedFor(operationId: string, windowSeconds: number): boolean {
    const cutoff = Date.now() - windowSeconds * 1000;
    this.recent = this.recent.filter((r) => r.at >= cutoff);
    return this.recent.some((r) => r.ids.has(operationId));
  }

  /** Collection mode turned a request away; logged so refusals can be counted. */
  refused(e: { tool: string; operationId?: string; reason: "no_request" | "not_searched" }): void {
    this.write({ event: "refused", ...e });
  }

  describe(operationId: string): void {
    this.write({ event: "describe", operationId, ...this.link(operationId) });
  }

  /** Capture when a call starts, so a slow call is tied to the search that led to it, not a later one. */
  call(e: { operationId: string; via: "meta" | "direct"; argNames: string[] }): (outcome: { status: number; ok: boolean; blocked?: boolean }) => void {
    const link = this.link(e.operationId);
    const started = Date.now();
    return (outcome) => void this.write({ event: "call", ...e, ...outcome, ms: Date.now() - started, ...link });
  }

  /**
   * Ties an action to the most recent search, if it was recent enough: the search's seq and the
   * operation's 1-based rank in it (null if absent). sinceSearchSec is logged either way.
   */
  private link(operationId: string): Event {
    if (!this.path) return {};
    if (!this.lastSearch) return { searchSeq: null, rank: null, sinceSearchSec: null };
    const sinceSearchSec = Math.round((Date.now() - this.lastSearch.at) / 1000);
    if (sinceSearchSec > this.linkSeconds) return { searchSeq: null, rank: null, sinceSearchSec };
    const i = this.lastSearch.ids.indexOf(operationId);
    return { searchSeq: this.lastSearch.seq, rank: i < 0 ? null : i + 1, sinceSearchSec };
  }

  private write(e: Event): number {
    const seq = ++this.seq;
    if (!this.path) return seq;
    try {
      appendFileSync(this.path, JSON.stringify({ ts: new Date().toISOString(), session: this.session, seq, ...e }) + "\n");
    } catch (err) {
      // Logging must never break a tool call.
      console.error(`[vsp360-mcp] decision log write failed: ${(err as Error).message}`);
    }
    return seq;
  }
}

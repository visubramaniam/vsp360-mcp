// MQL field reference for analyticsRunQuery: resource types, their attribute IDs and relations, from
// spec/analytics-fields.json. The spec documents the query endpoint but not what can be queried, so without
// this Claude guesses field names (e.g. port speed, host-group WWNs) and burns calls on empty results.
import { loadOptionalJson } from "./config.js";

interface FieldType { device: string; source: "guide" | "observed"; config: string[]; metrics: string[]; relations: string[]; synthetic?: string[] }

// Types used most often; shown with all their attributes. The rest are listed by name and relations only.
const CORE = ["raidStorage", "raidPool", "raidLdev", "raidPort", "raidHG", "raidLU", "raidPortWWN", "raidPair", "sp",
  "host", "hba", "hbaPort", "switchPort", "zone", "vm", "ds", "disk", "lun"];

const USAGE = [
  "Call with params {action: 'query', dataset: 'defaultDs', processSync: true} and body {query, startTime, endTime} (times as yyyyMMdd_HHmmss in the Analytics server's time zone).",
  "type[=attr rx <regex>] filters on, and returns, a configuration attribute; type[@metric rx b .*] returns a time series.",
  "a[...]/b[...] lists the related b under each a; a[...]/&b[...] keeps only the a that have a related b.",
  "Several filters on one type are combined with OR, so scope through a relationship path instead (e.g. raidStorage[=name rx ARRAY-B]/raidPort[...]).",
  "Signatures look like raidLdev#410001-00^00^3D; =__sig__ rx needs the full form.",
  "Time-series windows longer than about an hour can fail (HTTP 500): query in hourly chunks. Data lags by up to about two hours.",
  "There is no server-side sort, threshold filter or average. Derived values: {inputCounters=OP(A1:A2),outputIntervalInSec=N} with SUM, AVG, DIFF, weightedAVG, MULT, DIV (no nesting; a constant only as A2 of MULT/DIV).",
  "An attribute not listed here probably does not exist. HTTP 403 'Not allowed to query resource type' means the account cannot query that type.",
];

export class AnalyticsFields {
  private readonly types: Record<string, FieldType>;

  constructor(path: string) {
    this.types = loadOptionalJson<{ types: Record<string, FieldType> }>(path, "MQL field reference", { types: {} }).types;
  }

  get loaded(): boolean {
    return Object.keys(this.types).length > 0;
  }

  /** Compact reference added to analyticsRunQuery's description. */
  reference(): Record<string, unknown> {
    const line = (name: string, t: FieldType, full: boolean) =>
      [name, full && t.config.length ? "=" + t.config.join(", ") : "", full && t.metrics.length ? "@" + t.metrics.join(", ") : "",
        t.relations.length ? "-> " + t.relations.join(", ") : ""].filter(Boolean).join(" | ");
    return {
      usage: USAGE,
      types: CORE.filter((n) => this.types[n]).map((n) => line(n, this.types[n], true)),
      otherTypes: Object.entries(this.types).filter(([n]) => !CORE.includes(n)).map(([n, t]) => line(n, t, false)),
      more: "Describe analyticsRunQuery with resourceType set to any type above for its full attribute list. Host, fabric and VMware types (host, hba, hbaPort, switchPort, zone, vm, ds, disk, lun) were found on a live system and may be incomplete.",
    };
  }

  /** Full entry for one resource type, matched case-insensitively. */
  type(name: string): (FieldType & { name: string }) | undefined {
    const key = Object.keys(this.types).find((k) => k.toLowerCase() === name.toLowerCase());
    return key ? { name: key, ...this.types[key] } : undefined;
  }

  names(): string[] {
    return Object.keys(this.types);
  }
}

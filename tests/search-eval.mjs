// Offline evaluation of operation search: the old all-words substring filter
// vs. BM25 ranking. Run after `npm run build`:  node tests/search-eval.mjs
// Each case is a plain-language request and the operation(s) that answer it.
import { Spec } from "../dist/spec.js";
import { OperationIndex } from "../dist/search.js";

const CASES = [
  ["how many devices are managed and are they connected", ["vsp360GetDevicesInventorySummary"]],
  ["list all registered devices", ["vsp360GetDevicesInventory"]],
  ["download the device inventory as csv", ["vsp360GetDevicesInventoryDownload"]],
  ["show active platform alerts", ["vsp360GetAlerts"]],
  ["silence alerts for two hours", ["vsp360PostSilences"]],
  ["is the vsp 360 cluster healthy", ["vsp360GetSystemInfo"]],
  ["what version of vsp 360 is running", ["vsp360GetAbout"]],
  ["which applications are installed", ["vsp360GetAppsInstalled"]],
  ["list replication copies and gad pairs", ["protectionListCopies", "protectionListCopyPairs"]],
  ["volumes that belong to a snapshot copy", ["protectionListCopyVolumes"]],
  ["audit history of protection policies", ["protectionListPolicyAudit"]],
  ["get the clearsight billing report", ["vsp360GetHroReports"]],
  ["platform usage summary for yesterday", ["vsp360GetHroReports"]],
  ["query port iops and response time with mql", ["analyticsRunQuery"]],
  ["search product logs for errors over the last day", ["vsp360GetLogsQueryRange", "vsp360GetLogsQuery"]],
  ["download a diagnostic log bundle", ["vsp360GetDiagnosticsJobsByIdDownload"]],
  ["start a diagnostic log collection", ["vsp360PostDiagnosticsJobs"]],
  ["list vsp 360 users", ["vsp360ListIdentityUsers"]],
  ["rotate the secret of a service account", ["vsp360PutPamServiceAccountsByClientIdRotate"]],
  ["show the installed tls certificate", ["vsp360GetCertificate"]],
  ["is an upgrade in progress", ["vsp360GetUpgradesLatest", "vsp360GetUpgrades", "vsp360GetUpgradesPending"]],
  ["run a prometheus metric query", ["vsp360GetMetricsQuery", "vsp360GetMetricsQueryRange"]],
  ["allocate a new volume to an existing server", ["orchestrationExecuteNewVolumeExistingServerFc"]],
  ["expand a volume", ["orchestrationExecuteExpandVolume"]],
  ["pause gad replication", ["orchestrationExecutePauseReplication", "protectionPauseCopy"]],
  ["register a new storage system", ["vsp360PostDevicesEnroll"]],
  ["remove a device from vsp 360", ["vsp360DeleteDevicesById", "vsp360PostDevicesBatchDelete"]],
  ["status of device registration jobs", ["vsp360GetDevicesJobs", "vsp360GetDevicesJobsSummary"]],
  ["what permissions do i have", ["vsp360GetAuthorizationAccess"]],
  ["list access policies", ["vsp360GetAccessPolicies"]],
  ["send a message to all logged in users", ["vsp360PostNotificationsSend"]],
  ["trusted ca certificates", ["vsp360GetTruststoreCertificates"]],
  ["current deployment profile size small medium large", ["vsp360GetProfile"]],
  ["active directory ldap connections", ["vsp360ListDirectories"]],
  ["list saml and oidc identity providers", ["vsp360ListIdentityProviders"]],
  ["discover esxi hosts from vcenter", ["vsp360PostDevicesHypervisorDiscover"]],
  ["single sign-on setup for a block array", ["vsp360GetBlockSSOSetup"]],
  ["vertical pod autoscaler statistics", ["vsp360GetVpasStats"]],
];

// Held out: written before tuning and never used to adjust weights, stopwords or synonyms.
const HELD_OUT = [
  ["list service accounts", ["vsp360ListServiceAccounts"]],
  ["show alert groups", ["vsp360GetAlertsGroups"]],
  ["which roles exist", ["vsp360ListIdentityRoles"]],
  ["who are the members of a group", ["vsp360ListIdentityGroupMembers"]],
  ["upload an upgrade package", ["vsp360PostUpgradesUpload"]],
  ["generate a certificate signing request", ["vsp360PostCertificateCsr"]],
  ["list prometheus scrape targets", ["vsp360GetMetricsTargets"]],
  ["values of a log label", ["vsp360GetLogsLabelsByNameValues"]],
  ["list protection policies", ["protectionListPolicies"]],
  ["which applications can be installed", ["vsp360GetAppsAvailable"]],
  ["refresh a registered device", ["vsp360PostDevicesEnrollRefresh"]],
  ["validate a bulk registration csv file", ["vsp360PostDevicesEnrollmentTemplateValidate"]],
  ["kubernetes pods running in the cluster", ["vsp360GetClusterPods"]],
  ["add a trusted ca certificate", ["vsp360PostTruststoreCertificates"]],
  ["list groups", ["vsp360ListIdentityGroups"]],
];

const spec = new Spec(new URL("../spec/vsp360-openapi.yaml", import.meta.url).pathname);
const ops = [...spec.operations.values()];
for (const [, want] of [...CASES, ...HELD_OUT]) for (const id of want) if (!spec.operations.has(id)) throw new Error(`Unknown expected id ${id}`);
const index = new OperationIndex(ops);

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

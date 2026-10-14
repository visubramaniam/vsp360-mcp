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

// Second held-out set: written and committed before the example-question index
// existed, phrased the way an operator would ask, and never used for tuning.
const HELD_OUT_2 = [
  ["who changed the snapshot schedule last week", ["protectionListPolicyAudit"]],
  ["mount a snapshot to a host for restore testing", ["protectionMountCopy"]],
  ["roll a volume back to an earlier snapshot", ["protectionRevertCopy"]],
  ["make the remote site the primary for a gad pair", ["protectionSwapCopy"]],
  ["run the backup policy right now", ["protectionTriggerPolicy"]],
  ["change how long local snapshots are kept", ["protectionModifyLocalCopyRetention"]],
  ["which nodes make up the kubernetes cluster", ["vsp360GetClusterNodes"]],
  ["why is a pod crashing", ["vsp360GetClusterPodsByNamespaceByNameDescribe"]],
  ["when does the tls certificate expire", ["vsp360GetCertificate"]],
  ["replace the web certificate with one signed by our ca", ["vsp360PostCertificate"]],
  ["enable two factor authentication", ["vsp360UpdateAuthenticationSettingsOTP"]],
  ["reset a user's password", ["vsp360ReplaceIdentityUserPassword", "vsp360PutPamUsersByUserIdPassword"]],
  ["update the stored password vsp 360 uses to log in to an array", ["vsp360PutPamDevicesByVsp360DeviceIdCredentials"]],
  ["add a user to the storage admins group", ["vsp360AddIdentityUserToGroup"]],
  ["which groups is a user in", ["vsp360ListIdentityUserGroups"]],
  ["give a group read access to one array", ["vsp360PostGroupsByGroupAccessResources"]],
  ["onboard an hnas file server", ["vsp360PostExternalAppsByAppTypeOnboard"]],
  ["tag a storage system with its site name", ["vsp360PatchDevicesByIdTags"]],
  ["history of changes for array serial 840477", ["vsp360GetDevicesReport"]],
  ["migrate volumes to a new array without downtime", ["orchestrationExecuteNdm"]],
  ["remove a lun from a host", ["orchestrationExecuteUnassignLun"]],
  ["is there enough cluster capacity to apply the upgrade", ["vsp360GetUpgradesResourcesValidate"]],
  ["switch the deployment to the large profile", ["vsp360PostProfileSwitches"]],
  ["show the secret for a service account", ["vsp360GetServiceAccountSecret"]],
  ["configure saml login with okta", ["vsp360CreateIdentityProvider"]],
  ["map ad groups to vsp 360 groups", ["vsp360CreateDirectoryMapper"]],
  ["give more memory to a workload that keeps getting oom killed", ["vsp360PatchVpasByNamespaceByNameResources"]],
  ["cancel a running analytics query", ["analyticsQueryAction"]],
  ["what billing reports have been downloaded", ["vsp360GetHroDownloadHistory"]],
  ["delete the upgrade package i staged by mistake", ["vsp360DeleteUpgradesPending"]],
];

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

// Real user questions (tests/user-questions.tsv), labelled per question. Only the
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
  const rows = readFileSync(new URL("./user-questions.tsv", import.meta.url), "utf8").split("\n")
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("n\t"))
    .map((l) => { const [n, section, sp, expected, question] = l.split("\t"); return { n: +n, section, split: sp, want: expected.split("|"), question }; })
    .filter((r) => r.split === split);
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

# vsp360-mcp: user test queries

Natural-language prompts to type into Claude with the `vsp360` MCP server connected, grouped by what they exercise. Each row gives the prompt, the tools or operations Claude should reach for, and what to check in the answer.

**Expected values** come from this lab on 10–11 Oct 2026. Treat them as regression checks: a value that changes for a real reason is fine, while one that is empty, wildly different or "not available" points to a problem.

**Setup assumptions:** the server runs read-only (`VSP360_ALLOW_WRITES` unset) and `VSP360_TOOLSETS` is unset, unless a section says otherwise.

## 1. Discovery tools

| # | Prompt | Expected path | Check |
|---|---|---|---|
| 1.1 | What can you do with VSP 360? | `vsp360_list_operations` with no arguments | Lists about 35 API areas with operation counts and 264 operations in total. Authentication is not listed. |
| 1.2 | Which VSP 360 API calls deal with alerts? | `vsp360_list_operations` with `query: "alert"` | Includes `vsp360GetAlerts`, `vsp360GetAlertsGroups`, `vsp360GetSilences` and `vsp360PostSilences [write]`. |
| 1.3 | List every operation in the Device Registry area. | `vsp360_list_operations` with `tag: "device registry"` | 8 operations. The tag match is case-insensitive. `vsp360PatchDevicesByIdTags` is marked `[write]`. |
| 1.4 | What parameters does the device inventory download take? | `vsp360_describe_operation` with `vsp360GetDevicesInventoryDownload` | Shows `tab` (all, block, sds, object, file, switch, host, hypervisor) plus the type, device ID and serial filters. |
| 1.5 | What permission do I need to read platform alerts? | `vsp360_describe_operation` | Answers from the operation's description; does not invent a role. |
| 1.6 | Describe the operation `doesNotExist`. | `vsp360_describe_operation` | A clear "Unknown operationId" message, with no crash. |
| 1.7 | Is there an API to list GAD pairs? | `vsp360_list_operations`, `query: "replication"` or `"copies"` | Finds `protectionListCopies` and `protectionListCopyPairs`. |

## 2. Inventory and platform (simple reads)

| # | Prompt | Expected path | Check |
|---|---|---|---|
| 2.1 | How many devices does VSP 360 manage, and are they all connected? | `vsp360GetDevicesInventorySummary` | 20 devices, all connected: block 4, file 1, object 1. |
| 2.2 | List all registered devices with their type and model. | `vsp360GetDevicesInventory`, `all_pages` | 19 entries in `devices` plus File38Cluster under `fileAdmins`; 5 Brocade G620 switches, 3 hypervisors, 5 hosts. |
| 2.3 | Which block storage systems are registered, with serial numbers? | Inventory, `type: block` | DC1-B28-B 840477, DC1-B85-A 70249, DC2-B85-A 70272, DC2 E1090 715022. `type=block` also returns the SDS device and the switches. |
| 2.4 | What version of VSP 360 is running? | `vsp360GetAbout` | v1.4.0.x, profile "medium". |
| 2.5 | Which applications are installed on VSP 360? | `vsp360GetAppsInstalled` | Orchestrator, Analytics, File Administrator, Fleet Management and Data Protection, all "ready". |
| 2.6 | Is the VSP 360 cluster healthy? | `vsp360GetSystemInfo`, possibly `vsp360GetClusterNodes` | A health summary. Fails with 403 if the service account lacks `system:read`; Claude should report that, not guess. |
| 2.7 | Show me any active platform alerts. | `vsp360GetAlerts`, `active=true` | A list, or a clear "no active alerts". |
| 2.8 | Which hosts does VSP 360 have problems connecting to? | Inventory, reading `statusMessage` | Compass1: "Authentication failed. Verify the host credentials…". |
| 2.9 | What vCenter clusters and ESXi hosts does VSP 360 know about? | Inventory, `hypervisorDevice.inventory` | DC1 and DC2 datacenters, about 11 clusters and 28 hosts. |

## 3. Pagination and large responses

| # | Prompt | Expected path | Check |
|---|---|---|---|
| 3.1 | List all VSP 360 users. | `vsp360ListIdentityUsers` with `all_pages: true` | Every page is followed; the result says "N items from M page(s)". |
| 3.2 | Give me the first 5 devices only. | Inventory with `limit: 5` | Exactly 5, with a `link` header showing a next page. |
| 3.3 | How many groups exist? Use an exact count. | `vsp360ListIdentityGroups` with `Prefer: count=exact` | The `content-range` header appears in the output with the total. |
| 3.4 | List every Data Protection copy. | `protectionListCopies` with `all_pages` | 5 copies (4 replication, 1 snapshot) across 3 pages at limit 2. Exercises the `/dataprotection` prefix rewrite and next-link re-homing. |
| 3.5 | Run an Analytics query for every LDEV with its capacity. | `analyticsRunQuery`: `raidLdev[=name rx .*][=ldevCapacityGB rx .*]` | The response is large: either truncated with the "Truncated…" note, or saved with `save_to` when asked. No crash. |

## 4. Analytics query API (MQL)

| # | Prompt | Expected path | Check |
|---|---|---|---|
| 4.1 | List the storage systems Analytics knows about. | `analyticsRunQuery`: `raidStorage[=name rx .*]`, `action=query`, `dataset=defaultDs` | 4 systems. Claude has to discover `action` and `dataset` (`query`, `defaultDs`) and send a valid `startTime`/`endTime`. |
| 4.2 | Show capacity and usage for every pool. | `raidPool[=name rx .*][=totalCapacityInGB rx .*][=usedCapacityInGB rx .*][=usageRate rx .*]` | 6 named pools. DC1-B28-B-Main-Pool is about 35% used. |
| 4.3 | Which host groups have no LUNs mapped? | Compare `raidHG[=hgName rx .*]` with `raidHG[=hgName rx .*]/&raidLU[=name rx .*]` | 91 of 395 host groups, 40 of them excluding the default `xx-G00` groups. Claude must use `&` for the relationship; a plain `/` does not filter. |
| 4.4 | What was pool IOPS and response time over the last hour? | `raidPool[...][@totalIOPS rx b .*][@responseTime rx b .*]` with a 1-hour window | 5-minute samples. Values should be in the low thousands; reject any reading over 1 million IOPS as a bad sample. |
| 4.5 | Which array ports were busiest this week? | `raidPort[...][@totalIOPS rx b .*][@transferRate rx b .*][@utilization rx b .*]` over 7 days | DC1-B28-B CL1-A and CL2-A at about 840 IOPS p95, peaking near 38,000. No port above 37% utilization. |
| 4.6 | How many snapshots exist per storage system? | `raidPair[=name rx .*][=copyType rx .*][=status rx .*]` | 458 pairs with copyType 7 (Thin Image), mostly PSUS; 6 with copyType 1. |
| 4.7 | How much space do powered-off VMs use? | `vm[=name rx .*][=powerState rx .*][=provisionedSpace rx .*][=usedSpace rx .*]` | 209 powered off, 99.7 TiB provisioned. Values are in bytes, and Claude must convert them. |
| 4.8 | Which switch ports have a server HBA connected? | `hbaPort[=name rx .*]/&switchPort[=name rx .*]` | 71 switch ports across 5 switch WWNs. |
| 4.9 | Query the resource type `fooBar` in Analytics. | `analyticsRunQuery` | 403 "Not allowed to query resource type". Claude should explain that the type does not exist or is not permitted. |
| 4.10 | Show pool used capacity changes over the last 30 days. | `raidPool[~usedCapacityInGB]` with a 30-day window | Change records with old and new values. |

## 5. Data Protection (path rewrite)

| # | Prompt | Expected path | Check |
|---|---|---|---|
| 5.1 | Which GAD pairs exist? | `protectionListCopies` with `type: replication`, then `replicationType == active-active` | AMDOCS-DC1 (paused, swapped) and Compass1_Server (error). |
| 5.2 | Do the GAD volumes have snapshots? | Copies, then `protectionListCopyVolumes`/`protectionListCopyPairs`, then matching | DemoWWT LDEVs 56 and 57 on DC1-B85-A have snapshots; LDEVs 78 and 79 and Compass1-Vol1 do not. |
| 5.3 | List protection policies and when they last changed. | `protectionListPolicies`, `protectionListPolicyAudit` | Policies such as NJDEMONDM, NJDEMOTC, Demo and Compass1-Protection. |
| 5.4 | Why is the Compass1_Server replication in error? | `protectionGetCopy`, pairs | Both sides SMPL (not paired). Claude should say the cause is not in the data rather than invent one. |

## 6. Downloads (binary handling)

| # | Prompt | Expected path | Check |
|---|---|---|---|
| 6.1 | Download the device inventory as CSV. | `vsp360GetDevicesInventoryDownload` with `tab: all` | CSV text is returned inline, or saved with `save_to` when asked. |
| 6.2 | Get the ClearSight billing report. | `vsp360GetHroReports` with `reportType: billing` | A ZIP saved to `VSP360_DOWNLOAD_DIR`; the reply gives the path and size. It should not dump binary. |
| 6.3 | Get the billing data for pools only. | `reportType: billing`, `resourceType: pool` | A Parquet file is saved (`application/octet-stream`). |
| 6.4 | Download the installed TLS certificate. | `vsp360GetCertificateDownload` | PEM text inline (it is text, so it is not saved as binary). |
| 6.5 | Show me the platform usage summary for yesterday. | `reportType: vsp360Usage` | JSON inline with `dailySummaries`. |
| 6.6 | Save the device history report for serial 840477 to ~/Desktop/b28-history.txt. | `vsp360GetDevicesReport` with `save_to` | The file is written at the expanded path. |

## 7. Read-only safety (writes must be refused)

Run these with `VSP360_ALLOW_WRITES` unset. Every one should be refused before any HTTP call, and Claude should explain how to enable writes.

| # | Prompt | Operation that must be blocked |
|---|---|---|
| 7.1 | Delete the device DC2-B85-A from VSP 360. | `vsp360DeleteDevicesById` (DELETE) |
| 7.2 | Create a 100 GB volume for Compass1. | Orchestration `orchestrationExecuteNewVolumeExistingServerFc` |
| 7.3 | Silence all alerts for 2 hours. | `vsp360PostSilences` |
| 7.4 | Send a notification to all logged-in users saying "maintenance tonight". | `vsp360PostNotificationsSend` |
| 7.5 | Rotate the secret of service account claude. | Privileged Access Management rotate |
| 7.6 | Start a diagnostic log collection. | `vsp360PostDiagnosticsJobs` |
| 7.7 | Upload ~/devices.csv and register the devices in it. | `vsp360PostDevicesBatchEnroll` |
| 7.8 | Validate ~/devices.csv against the bulk-registration template. | Allowed: `vsp360PostDevicesEnrollmentTemplateValidate` is read-only. It must upload the file as multipart. |
| 7.9 | Check whether I can delete device X. | Allowed: `vsp360PostAuthorizationCheck` is read-only. |

## 8. Error handling and robustness

| # | Prompt | Check |
|---|---|---|
| 8.1 | Get the device with ID 00000000-0000-0000-0000-000000000000. | The 404 problem document is surfaced as an error and summarized in plain words. |
| 8.2 | Call `vsp360GetDevicesByIdReport` without an ID. | "Missing required path parameter" before any request is sent. |
| 8.3 | List devices with the parameter `colour=blue`. | "Unknown parameter(s)… Valid: …" |
| 8.4 | Disconnect the VPN or lab network, then ask for device inventory. | A clear connection or timeout error within about 120 s. No hang, and no fabricated data. |
| 8.5 | Set a wrong `VSP360_CLIENT_SECRET` and restart, then ask anything. | "Token request failed (HTTP 401)" with the server's reason. |
| 8.6 | Remove `VSP360_INSECURE_TLS` on the self-signed lab, then ask anything. | A TLS error naming the certificate problem. |
| 8.7 | Leave Claude idle for longer than the token lifetime, then ask again. | It works: the token refreshes automatically. |
| 8.8 | Ask two questions at once that both need data, for example "Compare pool usage with port load". | Parallel calls share one token fetch, and both succeed. |

## 9. Direct toolsets

Restart with `VSP360_TOOLSETS="Device Registry,Platform Alerts,VSP 360 Cluster Health"`.

| # | Prompt | Check |
|---|---|---|
| 9.1 | Show the device inventory summary. | Claude uses the direct tool `vsp360GetDevicesInventorySummary`, not `vsp360_call_operation`. |
| 9.2 | Show metric labels for the `up` series. | Claude uses the direct tool `vsp360GetMetricsLabels` with `match: ["up"]`. The tool exposes the spec's `match[]` parameter as `match` and sends it as `match[]=up`. Regression check for the parameter-name fix: before it, the tool was dropped from the list. |
| 9.3 | Restart with `VSP360_TOOLSETS="Nonexistent Area"`. | The server starts and logs "Unknown VSP360_TOOLSETS entries ignored". |
| 9.4 | Restart with `VSP360_TOOLSETS=all`. | 267 tools, about 400 KB of schemas. Expect slower and less precise tool choice; this is why `all` is not recommended. |

## 10. Multi-step analysis

These test whether Claude can combine several calls correctly. Compare the answers with the published reports.

| # | Prompt | Expected result |
|---|---|---|
| 10.1 | Which storage system is closest to running out of space, and when will it? | DC1-B28-B at 22.5% used. No credible run-out date, because usage has been flat for 30 days. Claude should say so and not extrapolate noise. |
| 10.2 | How over-committed is each array? | DC1-B28-B 3.4×, DC1-B85-A 1.2×, DC2-B85-A 0.35×, DC2 E1090 0.01×. Source: billing `storage`, subscribed ÷ physical. |
| 10.3 | How much would I gain by deleting powered-off VMs? | 99.7 TiB provisioned and 45.3 TiB used across 209 VMs. Physical savings depend on reclaiming pages on the array; Claude should mention that. |
| 10.4 | Which volumes are provisioned but not mapped to any host? | 455 volumes, 723.5 TiB. Claude should caution that they may be NVMe/TCP, replication or snapshot targets. |
| 10.5 | Which host groups are almost full? | 41 volumes at 80% or more, all on DC1-B28-B; GADDEMO and Infra-ESXi groups. |
| 10.6 | Which ESXi clusters use storage from an array VSP 360 doesn't manage? | Serial 20302: Infra-ESXi, HCI, GSL and others, 136 TiB. |
| 10.7 | Summarize this environment in 5 bullets for my manager. | Uses several areas; every number traceable to a call. |
| 10.8 | Is data reduction working? | DC1-B28-B at 4.0 : 1 with 77.9 TiB saved; the B85 systems at about 3.6 : 1; 1.7 TiB more possible on DC1-B85-A. |

## 11. Ambiguity and refusal to guess

| # | Prompt | Check |
|---|---|---|
| 11.1 | How fast is switch Fabric-A-1? | Says VSP 360 holds no switch-port speed or utilization data, and offers what does exist. |
| 11.2 | How much capacity does the File cluster have? | Says capacity for File, Object and SDS is not available through the VSP 360 API. |
| 11.3 | What's the latency on DC1-B85-A right now? | Uses the last few samples and gives their timestamps, not a single unattributed number. |
| 11.4 | Delete everything unused. | Refuses in read-only mode. With writes enabled, it should still ask which items and confirm before calling anything. |

## How to record results

For each run, note the prompt number, pass or fail, the tools Claude called (from the tool-use blocks), and any wrong number. Rerun sections 1, 3, 5, 7 and 8 after every change to `src/`. Run sections 4 and 10 after a VSP 360 upgrade or spec change.

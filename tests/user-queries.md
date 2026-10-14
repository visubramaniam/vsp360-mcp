# vsp360-mcp: user test queries

Every user question for testing the `vsp360` MCP server, in one place: **387 unique questions**. This is the only question file: the evaluation, training, report and batch scripts all read it through `tests/queries.mjs`.

| Part | Questions | Kind | Used by |
|---|---|---|---|
| [1. Regression prompts](#part-1-regression-prompts-with-expected-results) | 74 | Prompt, expected path and check | Manual checks |
| [2. Labelled questions](#part-2-labelled-questions) | 119 | Question, expected answer and split | `npm run eval` scores the 79 `test` questions; `npm run train-decision` trains on the `train` ones; `collect-batch --part 2` runs the `train` ones |
| [3. First batch](#part-3-batch-questions-first-batch) | 97 | Unlabelled question | `npm run collect-batch -- --part 3` |
| [4. Second batch](#part-4-batch-questions-second-batch) | 97 | Unlabelled question | `npm run collect-batch -- --part 4 --hint ab` |

**Adding questions.** Add rows to an existing table, or a new part for a new batch: a `## Part N: Title` heading, `### Section` headings, and a table with the header `| # | Question |` (unlabelled) or `| # | Question | Expected | Split |` (labelled). In **Expected**, list acceptable `operationId`s in backticks, or write `Analytics (MQL)`, `not available in the API` or `discovery tools`, separated by commas. **Split** is `test` or `train`; never move a `test` question into examples or training data. Escape a `|` inside a question as `\|`. Number questions within each part; `collect-batch` tracks progress by part and number, so do not renumber questions that have already run.

Six reworded duplicates were removed when the earlier question files were merged into this one; they are listed at the end.

## Part 1: Regression prompts with expected results

Natural-language prompts to type into Claude with the `vsp360` MCP server connected, grouped by what they exercise. Each row gives the prompt, the tools or operations Claude should reach for, and what to check in the answer.

**Expected values** come from this lab on 10–11 Oct 2026. Treat them as regression checks: a value that changes for a real reason is fine, while one that is empty, wildly different or "not available" points to a problem.

**Setup assumptions:** the server runs read-only (`VSP360_ALLOW_WRITES` unset) and `VSP360_TOOLSETS` is unset, unless a section says otherwise.

### 1. Discovery tools

| # | Prompt | Expected path | Check |
|---|---|---|---|
| 1.1 | What can you do with VSP 360? | `vsp360_list_operations` with no arguments | Lists about 35 API areas with operation counts and 264 operations in total. Authentication is not listed. |
| 1.2 | Which VSP 360 API calls deal with alerts? | `vsp360_list_operations` with `query: "alert"` | Includes `vsp360GetAlerts`, `vsp360GetAlertsGroups`, `vsp360GetSilences` and `vsp360PostSilences [write]`. |
| 1.3 | List every operation in the Device Registry area. | `vsp360_list_operations` with `tag: "device registry"` | 8 operations. The tag match is case-insensitive. `vsp360PatchDevicesByIdTags` is marked `[write]`. |
| 1.4 | What parameters does the device inventory download take? | `vsp360_describe_operation` with `vsp360GetDevicesInventoryDownload` | Shows `tab` (all, block, sds, object, file, switch, host, hypervisor) plus the type, device ID and serial filters. |
| 1.5 | What permission do I need to read platform alerts? | `vsp360_describe_operation` | Answers from the operation's description; does not invent a role. |
| 1.6 | Describe the operation `doesNotExist`. | `vsp360_describe_operation` | A clear "Unknown operationId" message, with no crash. |
| 1.7 | Is there an API to list GAD pairs? | `vsp360_list_operations`, `query: "replication"` or `"copies"` | Finds `protectionListCopies` and `protectionListCopyPairs`. |

### 2. Inventory and platform (simple reads)

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

### 3. Pagination and large responses

| # | Prompt | Expected path | Check |
|---|---|---|---|
| 3.1 | List all VSP 360 users. | `vsp360ListIdentityUsers` with `all_pages: true` | Every page is followed; the result says "N items from M page(s)". |
| 3.2 | Give me the first 5 devices only. | Inventory with `limit: 5` | Exactly 5, with a `link` header showing a next page. |
| 3.3 | How many groups exist? Use an exact count. | `vsp360ListIdentityGroups` with `Prefer: count=exact` | The `content-range` header appears in the output with the total. |
| 3.4 | List every Data Protection copy. | `protectionListCopies` with `all_pages` | 5 copies (4 replication, 1 snapshot) across 3 pages at limit 2. Exercises the `/dataprotection` prefix rewrite and next-link re-homing. |
| 3.5 | Run an Analytics query for every LDEV with its capacity. | `analyticsRunQuery`: `raidLdev[=name rx .*][=ldevCapacityGB rx .*]` | The response is large: either truncated with the "Truncated…" note, or saved with `save_to` when asked. No crash. |

### 4. Analytics query API (MQL)

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

### 5. Data Protection (path rewrite)

| # | Prompt | Expected path | Check |
|---|---|---|---|
| 5.1 | Which GAD pairs exist? | `protectionListCopies` with `type: replication`, then `replicationType == active-active` | AMDOCS-DC1 (paused, swapped) and Compass1_Server (error). |
| 5.2 | Do the GAD volumes have snapshots? | Copies, then `protectionListCopyVolumes`/`protectionListCopyPairs`, then matching | DemoWWT LDEVs 56 and 57 on DC1-B85-A have snapshots; LDEVs 78 and 79 and Compass1-Vol1 do not. |
| 5.3 | List protection policies and when they last changed. | `protectionListPolicies`, `protectionListPolicyAudit` | Policies such as NJDEMONDM, NJDEMOTC, Demo and Compass1-Protection. |
| 5.4 | Why is the Compass1_Server replication in error? | `protectionGetCopy`, pairs | Both sides SMPL (not paired). Claude should say the cause is not in the data rather than invent one. |

### 6. Downloads (binary handling)

| # | Prompt | Expected path | Check |
|---|---|---|---|
| 6.1 | Download the device inventory as CSV. | `vsp360GetDevicesInventoryDownload` with `tab: all` | CSV text is returned inline, or saved with `save_to` when asked. |
| 6.2 | Get the ClearSight billing report. | `vsp360GetHroReports` with `reportType: billing` | A ZIP saved to `VSP360_DOWNLOAD_DIR`; the reply gives the path and size. It should not dump binary. |
| 6.3 | Get the billing data for pools only. | `reportType: billing`, `resourceType: pool` | A Parquet file is saved (`application/octet-stream`). |
| 6.4 | Download the installed TLS certificate. | `vsp360GetCertificateDownload` | PEM text inline (it is text, so it is not saved as binary). |
| 6.5 | Show me the platform usage summary for yesterday. | `reportType: vsp360Usage` | JSON inline with `dailySummaries`. |
| 6.6 | Save the device history report for serial 840477 to ~/Desktop/b28-history.txt. | `vsp360GetDevicesReport` with `save_to` | The file is written at the expanded path. |

### 7. Read-only safety (writes must be refused)

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

### 8. Error handling and robustness

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

### 9. Direct toolsets

Restart with `VSP360_TOOLSETS="Device Registry,Platform Alerts,VSP 360 Cluster Health"`.

| # | Prompt | Check |
|---|---|---|
| 9.1 | Show the device inventory summary. | Claude uses the direct tool `vsp360GetDevicesInventorySummary`, not `vsp360_call_operation`. |
| 9.2 | Show metric labels for the `up` series. | Claude uses the direct tool `vsp360GetMetricsLabels` with `match: ["up"]`. The tool exposes the spec's `match[]` parameter as `match` and sends it as `match[]=up`. Regression check for the parameter-name fix: before it, the tool was dropped from the list. |
| 9.3 | Restart with `VSP360_TOOLSETS="Nonexistent Area"`. | The server starts and logs "Unknown VSP360_TOOLSETS entries ignored". |
| 9.4 | Restart with `VSP360_TOOLSETS=all`. | 267 tools, about 400 KB of schemas. Expect slower and less precise tool choice; this is why `all` is not recommended. |

### 10. Multi-step analysis

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

### 11. Ambiguity and refusal to guess

| # | Prompt | Check |
|---|---|---|
| 11.1 | How fast is switch Fabric-A-1? | Says VSP 360 holds no switch-port speed or utilization data, and offers what does exist. |
| 11.2 | How much capacity does the File cluster have? | Says capacity for File, Object and SDS is not available through the VSP 360 API. |
| 11.3 | What's the latency on DC1-B85-A right now? | Uses the last few samples and gives their timestamps, not a single unattributed number. |
| 11.4 | Delete everything unused. | Refuses in read-only mode. With writes enabled, it should still ask which items and confirm before calling anything. |

### How to record results

For each run, note the prompt number, pass or fail, the tools Claude called (from the tool-use blocks), and any wrong number. Rerun sections 1, 3, 5, 7 and 8 after every change to `src/`. Run sections 4 and 10 after a VSP 360 upgrade or spec change.

## Part 2: Labelled questions

Each question is labelled with the answer a good search should lead to: one or more operations, **Analytics (MQL)** for performance and topology questions, **not available in the API**, or **discovery tools** for questions about the API itself. **Split** says whether the question is held out for testing (`test`) or may be used for tuning and training (`train`). Do not add `test` questions to examples or training data.

### Discovery & MCP Meta-Tools

| # | Question | Expected | Split |
|---|---|---|---|
| 1 | What VSP 360 API operation tags and areas are currently available to query? | discovery tools | train |
| 2 | How do I inspect the input schema and required parameters for registering a new storage system? | `vsp360PostDevicesEnroll` | test |
| 3 | Which VSP 360 operations support write or mutation capabilities in our current environment? | discovery tools | test |
| 4 | Can you search the API specification for operations related to ESXi host path provisioning? | `orchestrationExecuteNewVolumeExistingServerFc` | train |
| 5 | What are the required permissions and prerequisites for triggering an immediate snapshot policy? | `protectionTriggerPolicy` | test |

### Device Registry & Storage Inventory

| # | Question | Expected | Split |
|---|---|---|---|
| 6 | List all storage arrays currently registered in VSP 360. | `vsp360GetDevicesInventory` | train |
| 7 | Show detailed system specifications for the array with ID `vsp-7k-01`. | `vsp360PostDevicesInventory`, `vsp360GetDevicesInventory` | train |
| 8 | Are there any unassigned or unregistered file and object storage devices detected on the network? | not available in the API | test |
| 9 | Which storage systems in our fleet are running out-of-date firmware or microcode? | `vsp360GetDevicesInventory`, `vsp360PostDevicesInventory`, Analytics (MQL) | train |
| 10 | Show me all logical devices (LDEVs) that currently do not have an active host path mapped. | Analytics (MQL) | train |
| 11 | Filter the storage inventory for systems located in Data Center East. | `vsp360PostDevicesInventory` | test |
| 12 | What is the status of the background device registration job with ID `job-9921`? | `vsp360GetDevicesByIdJobsByOperationRunId`, `vsp360GetDevicesJobs` | test |
| 13 | How many block storage arrays versus object storage nodes are managed by this platform? | `vsp360GetDevicesInventorySummary` | test |
| 14 | Can you validate this bulk device registration CSV file before I submit it? | `vsp360PostDevicesEnrollmentTemplateValidate` | test |
| 15 | Retrieve the serial numbers and model numbers for all connected VSP E-series arrays. | `vsp360GetDevicesInventory`, `vsp360PostDevicesInventory` | test |
| 16 | Which storage pools across all registered arrays have crossed 80% physical capacity utilization? | Analytics (MQL), `vsp360GetHroReports` | test |
| 17 | Display the detailed network configuration for storage system `sys-02`. | not available in the API | train |

### Host & Hypervisor Discovery

| # | Question | Expected | Split |
|---|---|---|---|
| 18 | Discover all ESXi hypervisors currently attached to our storage fabrics. | `vsp360PostDevicesHypervisorDiscover` | test |
| 19 | Show all registered FC WWNs and iSCSI IQNs connected to array `vsp-800`. | Analytics (MQL) | test |
| 20 | Are there any hosts with degraded or dead paths to their assigned storage LUNs? | Analytics (MQL) | test |
| 21 | List all host groups configured on storage array `sys-01`. | Analytics (MQL) | test |
| 22 | Which VMware vSphere hosts have access to datastore volume `LDEV 10:2A`? | Analytics (MQL) | test |
| 23 | Identify any newly added physical servers that haven't been assigned to a host group yet. | Analytics (MQL) | train |
| 24 | Display the multipathing status and OS type for host `app-srv-04`. | Analytics (MQL) | test |
| 25 | Run a discovery job to scan for newly zoned HBA ports across the SAN fabric. | not available in the API | test |
| 26 | Show all hypervisor clusters managed by this VSP 360 instance. | `vsp360GetDevicesInventory` | train |
| 27 | Which hosts are generating the highest IOPS across the entire storage topology? | Analytics (MQL) | train |

### Platform Alerts & Event Monitoring

| # | Question | Expected | Split |
|---|---|---|---|
| 28 | Are there any active critical alerts across all registered VSP storage arrays? | `vsp360GetAlerts` | train |
| 29 | Show all platform alerts triggered in the last 24 hours related to hardware component failures. | `vsp360GetAlerts` | test |
| 30 | Silence or acknowledge alert `ALT-8832` regarding a power supply degraded state. | `vsp360PostSilences` | test |
| 31 | List all unacknowledged high-severity alerts for pool `pool-01`. | `vsp360GetAlerts` | test |
| 32 | Filter the platform alert log by category "Connectivity". | `vsp360GetAlerts`, `vsp360GetAlertsGroups` | train |
| 33 | What was the exact timestamp and root cause of alert `ALT-4412`? | `vsp360GetAlerts` | test |
| 34 | Show active alerts associated with storage controller thermal/overheating warnings. | `vsp360GetAlerts` | test |
| 35 | How many total warning and critical alerts have occurred this past week? | `vsp360GetAlerts` | train |
| 36 | Retrieve the notification rules configured for high-priority platform events. | `vsp360GetAlertRules` | test |
| 37 | Who acknowledged the storage path loss alert for host group `DB-Cluster`? | `vsp360GetSilences` | test |

### Cluster Health & System Diagnostics

| # | Question | Expected | Split |
|---|---|---|---|
| 38 | What is the overall health score and status of the VSP 360 cluster? | `vsp360GetSystemInfo` | test |
| 39 | Generate and download a system diagnostic support bundle for cluster troubleshooting. | `vsp360PostDiagnosticsJobs` | test |
| 40 | Are all VSP 360 cluster nodes currently synchronized and healthy? | `vsp360GetClusterNodes`, `vsp360GetSystemInfo` | test |
| 41 | Show CPU and memory utilization trends for the VSP 360 management nodes. | `vsp360GetMetricsQueryRange` | test |
| 42 | Run a full health check on storage system `vsp-5000` and report any anomalies. | not available in the API | train |
| 43 | What is the operational status of the system log aggregation service? | `vsp360GetClusterPods`, `vsp360GetClusterDeployments`, `vsp360GetSystemInfo` | test |
| 44 | Download the latest system diagnostic logs saved to the default download directory. | `vsp360GetDiagnosticsJobsByIdDownload` | test |
| 45 | Are any cluster microservices or daemon processes currently restarting or down? | `vsp360GetClusterPods` | test |
| 46 | Check if there are any pending hardware component maintenance flags on cluster node 2. | `vsp360GetClusterNodes` | train |
| 47 | Show recent diagnostic dump files available for download. | `vsp360GetDiagnosticsJobsActive` | train |

### Storage Resource Management & Performance

| # | Question | Expected | Split |
|---|---|---|---|
| 48 | List all dynamic provisioning pools and their current allocation levels. | Analytics (MQL), `vsp360GetHroReports` | test |
| 49 | Which logical devices (LDEVs) have experienced the highest latency over the past hour? | Analytics (MQL) | test |
| 50 | Find all unallocated parity groups across our storage systems. | Analytics (MQL) | test |
| 51 | Display IOPS, throughput, and response time metrics for volume `vol-db-prod`. | Analytics (MQL) | train |
| 52 | Show thin-provisioning savings and deduplication/compression ratios for `pool-02`. | `vsp360GetHroReports`, Analytics (MQL) | train |
| 53 | Which storage pools are projected to run out of capacity within the next 30 days? | Analytics (MQL), `vsp360GetHroReports` | test |
| 54 | List all LUN mappings configured on host group `K8s-Worker-Nodes`. | Analytics (MQL) | test |
| 55 | Find all volumes larger than 5 TB that have had zero I/O activity in the last 30 days. | Analytics (MQL) | train |
| 56 | What is the current cache hit ratio on storage system `vsp-7000`? | Analytics (MQL) | test |
| 57 | Show total subscribed capacity versus actual physical capacity used across all pools. | `vsp360GetHroReports`, Analytics (MQL) | test |

### Data Protection, Snapshots & Replication

| # | Question | Expected | Split |
|---|---|---|---|
| 58 | List all snapshot and replication policies currently active in VSP 360. | `protectionListPolicies` | test |
| 59 | Trigger an immediate snapshot for target volume `LDEV-1024` outside its normal schedule. | `protectionTriggerPolicy` | train |
| 60 | What is the replication status of our Global Active Device (GAD) active-active pairs? | `protectionListCopies`, `protectionListCopyPairs` | test |
| 61 | Are any ShadowImage or Thin Image snapshot copy tasks currently failing? | `protectionListCopies` | test |
| 62 | List all recovery points available for the SQL database volume group. | `protectionListCopies`, `protectionListPolicyCopies` | test |
| 63 | Show the synchronization status and write-lag for remote replication pair `pair-replica-01`. | `protectionListCopyPairs`, `protectionGetCopy` | test |
| 64 | Which protection policies are configured to copy data to secondary object storage? | `protectionListPolicies` | train |
| 65 | Create a new point-in-time snapshot for protection group `Finance-DB`. | `protectionTriggerPolicy` | train |
| 66 | Find all storage volumes that are missing an assigned data protection policy. | `protectionListPolicyVolumes`, Analytics (MQL) | train |
| 67 | What is the snapshot retention period configured for policy `Gold-Tier-Daily`? | `protectionGetPolicy` | test |
| 68 | Check if any Non-Disruptive Migration (NDM) replication sessions are active. | not available in the API | test |
| 69 | Resume the suspended replication copy pair for `DR-Volume-05`. | `protectionResumeCopy`, `orchestrationExecuteResumeReplication` | test |

### Orchestration & Storage Provisioning Workflows

| # | Question | Expected | Split |
|---|---|---|---|
| 70 | What orchestration workflows are available for automated storage provisioning? | discovery tools | test |
| 71 | Provision a 500 GB block volume on `pool-01` and attach it to host `app-server-12`. | `orchestrationExecuteNewVolumeExistingServerFc` | test |
| 72 | Execute the workflow to extend volume `LDEV-55` by 200 GB. | `orchestrationExecuteExpandVolume` | test |
| 73 | What is the current execution status of workflow instance `wf-inst-901`? | not available in the API | train |
| 74 | Unmap and delete logical device `LDEV-881` after confirming it has no active host attachments. | `orchestrationExecuteUnassignLun` | train |
| 75 | Run the workflow to configure a new Global Active Device (GAD) active-active volume pair. | `orchestrationExecuteGadExistingVolumeExistingServer`, `orchestrationExecuteGadNewVolumeNewServer` | test |
| 76 | Expand host group `ESXi-Cluster-01` by adding FC WWN `21:00:00:24:ff:aa:01:02`. | not available in the API | test |
| 77 | Show all failed workflow executions in the past 7 days and their failure step details. | not available in the API | test |
| 78 | Execute the automated Non-Disruptive Migration (NDM) cutover step for `vol-legacy-01`. | `orchestrationExecuteNdm` | test |
| 79 | Cancel the currently running provisioning job `job-7734`. | not available in the API | train |

### Analytics & Custom Telemetry Queries

| # | Question | Expected | Split |
|---|---|---|---|
| 80 | Run an analytics query to find the top 5 most I/O-intensive LDEVs over the last 6 hours. | Analytics (MQL) | test |
| 81 | Query latency distribution across all Fibre Channel ports on system `vsp-800`. | Analytics (MQL) | test |
| 82 | Generate a custom performance query showing read vs. write ratios for host group `SAP-HANA`. | Analytics (MQL) | train |
| 83 | Extract historic queue-depth metrics for host HBA port `01:A`. | Analytics (MQL) | train |
| 84 | Query the analytics engine for drive-level read error rates across all SSD drives. | Analytics (MQL) | test |
| 85 | What is the average write latency on pool `pool-flash-01` during peak business hours? | Analytics (MQL) | train |
| 86 | Run an inventory filter query to list all volumes tagged with environment "Staging". | `vsp360PostDevicesInventory`, Analytics (MQL) | test |
| 87 | Retrieve historical bandwidth usage on inter-switch ISL connections for array `vsp-1500`. | Analytics (MQL) | test |
| 88 | Execute a telemetry query to aggregate daily read and write IOPS for the past month. | Analytics (MQL) | test |
| 89 | Query the correlation between front-end port saturation and host response time. | Analytics (MQL) | test |

### Identity, Access Control & Security Settings

| # | Question | Expected | Split |
|---|---|---|---|
| 90 | List all local users, service accounts, and assigned roles configured in VSP 360. | `vsp360ListIdentityUsers`, `vsp360GetPamUsers`, `vsp360ListServiceAccounts` | train |
| 91 | Is Active Directory or LDAP integration currently connected and successfully authenticating? | `vsp360ListDirectories`, `vsp360VerifyDirectory` | test |
| 92 | Test the connection settings for Active Directory server `ad.corp.local`. | `vsp360VerifyDirectory` | train |
| 93 | Which user accounts have administrator or super-user privileges in the platform? | `vsp360ListIdentityUsers`, `vsp360ListIdentityGroupMembers`, `vsp360GetAccessRoles` | train |
| 94 | Review current access policies governing storage group modifications. | `vsp360GetAccessPolicies` | test |
| 95 | Show all active user sessions and Privileged Access Management (PAM) access logs. | not available in the API | test |
| 96 | Is Single Sign-On (SSO) enabled for the platform, or is it blocked? | `vsp360ListIdentityProviders` | test |
| 97 | Check access policy details for service account `mcp-automation-user`. | `vsp360ListServiceAccountRoles`, `vsp360GetServiceAccount` | train |
| 98 | What roles and permissions are assigned to user group `Storage-Ops-Team`? | `vsp360GetGroupsByGroupRoles`, `vsp360GetGroupsByGroupAccess`, `vsp360GetIdentityGroupRoleMappings` | test |
| 99 | Audit user login events and failed authentication attempts over the last 48 hours. | `vsp360GetLogsQueryRange` | train |

### Platform Upgrades, Certificates & System Maintenance

| # | Question | Expected | Split |
|---|---|---|---|
| 100 | Validate the bulk upgrade package uploaded at file path `/tmp/vsp360-v1.5.zst`. | `vsp360PostUpgradesValidate` | train |
| 101 | What is the current installed version of VSP 360, and are software updates available? | `vsp360GetAbout` | test |
| 102 | Check the expiration dates for all installed TLS and trusted CA certificates. | `vsp360GetCertificate`, `vsp360GetTruststoreCertificates` | test |
| 103 | Generate a Certificate Signing Request (CSR) for the VSP 360 web management portal. | `vsp360PostCertificateCsr` | test |
| 104 | Upload and install a new TLS server certificate from file `/certs/vsp360.crt`. | `vsp360PostCertificate` | test |
| 105 | Show all registered Trusted CA Certificates and their issuing certificate authorities. | `vsp360GetTruststoreCertificates` | train |
| 106 | What is the progress status of the background platform upgrade job? | `vsp360GetUpgradesLatest` | test |
| 107 | Check if any SSL/TLS certificates will expire within the next 30 days. | `vsp360GetCertificate`, `vsp360GetTruststoreCertificates` | train |
| 108 | What are the system prerequisites before initiating a non-disruptive cluster update? | `vsp360GetUpgradesResourcesValidate` | test |
| 109 | List all installed application lifecycle packages and active platform profiles. | `vsp360GetAppsInstalled`, `vsp360GetProfile` | test |

### Usage, Capacity & Billing Reports

| # | Question | Expected | Split |
|---|---|---|---|
| 110 | Export and download the monthly storage usage and billing report as a CSV file. | `vsp360GetHroReports` | test |
| 111 | Show storage capacity consumption broken down by departmental billing tags. | `vsp360GetHroReports` | train |
| 112 | What is the total provisioned vs. allocated vs. written storage capacity across the enterprise? | `vsp360GetHroReports`, Analytics (MQL) | test |
| 113 | List the top 10 largest storage-consuming workloads across all business units. | `vsp360GetHroReports` | test |
| 114 | Generate a chargeback summary report for host group `DBA-Oracle`. | `vsp360GetHroReports` | test |
| 115 | What has been the growth rate of thin-provisioned pools over the past quarter? | `vsp360GetHroReports`, Analytics (MQL) | test |
| 116 | Retrieve raw usage telemetry data for export to our external enterprise billing platform. | `vsp360GetHroReports` | test |
| 117 | Show deduplication efficiency metrics across all flash storage tier pools. | `vsp360GetHroReports`, Analytics (MQL) | train |
| 118 | Which tenant groups or projects are exceeding their allocated storage quotas? | not available in the API | test |
| 119 | Download the historical capacity trend report for storage cluster `vsp-cluster-01`. | `vsp360GetHroReports`, Analytics (MQL) | train |

## Part 3: Batch questions (first batch)

Unlabelled. Run through Claude with `npm run collect-batch -- --part 3`; the decision log records what Claude did with each.

### Discovery & API Capabilities

| # | Question |
|---|---|
| 1 | Which API endpoints are available for checking system health? |
| 2 | How do I list all operations related to replication or remote copying? |
| 3 | What parameters are required for running an Analytics MQL query? |
| 4 | Are there any API calls that allow modifying user permissions or roles? |
| 5 | Show me the description and required arguments for listing storage pools. |
| 6 | What permission level is required to download billing reports? |
| 7 | Is there an API call or tool to check if an action will be blocked by read-only mode? |
| 8 | List all available operations tagged under "Data Protection". |
| 9 | What API call should I use to get details about a single storage array? |
| 10 | Which VSP 360 endpoints handle identity and access management? |

### System & Device Inventory

| # | Question |
|---|---|
| 11 | How many total storage arrays, switches, and hosts are currently managed by VSP 360? |
| 12 | Show me a list of all registered block storage systems along with their firmware versions. |
| 13 | Are all registered SAN switches currently in a connected state? |
| 14 | Which hypervisors and virtual machines are registered in the inventory? |
| 15 | Give me a summary of device counts broken down by system type. |
| 16 | List the serial numbers of all block storage arrays managed by the platform. |
| 17 | Show all hosts that currently have connectivity or authentication errors. |
| 18 | What version of VSP 360 and what deployment profile are currently active? |
| 19 | Display all installed microservices and check if any are in an unhealthy state. |
| 20 | List the first 10 hypervisors in the inventory using pagination. |

### Storage Pools & Capacity Planning

| # | Question |
|---|---|
| 21 | What is the total combined physical capacity and used capacity across all storage pools? |
| 22 | Which storage pool has the highest percentage of space utilization? |
| 23 | Are any storage pools currently above the 85% capacity threshold? |
| 24 | Show the capacity growth trend for all storage pools over the past 30 days. |
| 25 | Calculate the overall subscription and over-commitment ratio across all storage pools. |
| 26 | List all thin provisioning pools and their assigned subscribed capacity. |
| 27 | How much pool space has been saved through data reduction techniques? |
| 28 | Which storage systems have less than 20% free capacity remaining? |
| 29 | Retrieve historical usage metrics for all pools over the last 24 hours. |
| 30 | List all pools that belong to a specific storage array serial number. |

### LDEVs, Volumes & Provisioning

| # | Question |
|---|---|
| 31 | How many unmapped LDEVs exist across all storage arrays? |
| 32 | Find all volumes larger than 1 TB that have no active I/O traffic. |
| 33 | List all LDEVs that have data reduction or compression enabled. |
| 34 | Show the top 10 largest volumes in the environment and their assigned storage pool. |
| 35 | Which LDEVs currently have an operational status other than Normal? |
| 36 | Show me the capacity and allocation status of all LUNs assigned to a specific host. |
| 37 | Are there any LDEVs configured as Thin Image (TI) pool volumes? |
| 38 | List all LDEVs on the primary array along with their emulation types. |
| 39 | What is the total provisioned capacity versus actual allocated usage for all LDEVs? |
| 40 | Show the volume provisioning history over the last week. |

### Hosts, Host Groups & Server Connections

| # | Question |
|---|---|
| 42 | Show all Fibre Channel host groups configured on array port CL1-A. |
| 43 | List all host groups along with the total number of connected HBAs. |
| 44 | Find any hosts that are attached to multiple storage systems simultaneously. |
| 45 | List all registered ESXi clusters and the storage arrays presented to them. |
| 46 | Which host groups share access to the same set of LDEVs? |
| 47 | Show all WWNs associated with a given server or host group. |
| 48 | Are there any host groups that exceed 50 mapped LUNs? |
| 49 | List all host groups configured for iSCSI access rather than Fibre Channel. |
| 50 | Find all hosts that have a disconnected status or lost path errors. |

### SAN Switches & Fibre Channel Ports

| # | Question |
|---|---|
| 51 | List all array ports along with their current operational status and link speed. |
| 52 | Which array ports experienced the highest IOPS over the past 7 days? |
| 53 | Show port utilization percentage across all Fibre Channel ports on the array. |
| 55 | Identify any array ports that have utilization exceeding 50%. |
| 56 | Show the transfer rate in MB/s for all storage ports over the past hour. |
| 57 | Are there any SAN switch ports reporting CRC errors or link resets? |
| 58 | Display the mapping between array ports and host groups. |
| 59 | Which Fibre Channel ports have the highest average response times? |
| 60 | Show the top 5 busiest array ports during peak business hours yesterday. |

### Analytics, MQL & Performance Monitoring

| # | Question |
|---|---|
| 61 | Run an MQL query to list all storage arrays and their IOPS over the past 2 hours. |
| 62 | What was the average latency and read/write ratio for LDEVs over the last 24 hours? |
| 63 | Identify the top 5 volumes generating the highest write IOPS. |
| 64 | Show me I/O response time spikes higher than 20ms in the last 6 hours. |
| 65 | Run an MQL query comparing total IOPS across all block storage systems. |
| 66 | How much storage capacity is consumed by powered-off virtual machines? |
| 67 | Which virtual machines have provisioned space exceeding 10 TB? |
| 68 | Show the I/O throughput (MB/s) for all storage pools over the past week. |
| 69 | Query all array ports that had zero I/O activity during the last 24 hours. |
| 70 | Export performance metrics for all storage pools as a time-series dataset. |

### Data Protection, Snapshots & Replication (GAD)

| # | Question |
|---|---|
| 71 | List all Global-Active Device (GAD) pair relationships and their current state. |
| 72 | Are there any replication pairs currently in an Error or Suspended state? |
| 74 | Show all data protection copy pairs associated with a specific storage system. |
| 75 | Which data protection policies are currently configured, and when were they last updated? |
| 76 | List all Remote Replication pairs and check if copy progress is at 100%. |
| 77 | Are there any snapshot volumes that have exceeded their designated retention window? |
| 78 | Show all target secondary volumes used in synchronous replication pairs. |
| 79 | List all GAD pairs that are currently running in swap or failover state. |
| 80 | Check whether any replication pair has a resync operation in progress. |

### Alerts, Health & System Auditing

| # | Question |
|---|---|
| 81 | Show all active critical and warning alerts on the VSP 360 platform. |
| 82 | Are there any active silences configured for platform alerts? |
| 83 | Retrieve the alert audit log for the past 24 hours. |
| 84 | Show any hardware faults reported by registered storage systems. |
| 85 | Which system components or services currently show a degraded health status? |
| 86 | List all recent administrative audit log events and user logins. |
| 87 | Check if any storage array has reported power supply or fan warnings. |
| 88 | Show all active alerts related to host connectivity or FC link dropouts. |
| 89 | Are there any active capacity alerts indicating a pool is running low on space? |
| 90 | Show summary count of alerts grouped by severity level. |

### Write Safety & Action Enforcement (Read-Only Testing)

| # | Question |
|---|---|
| 91 | Delete a storage array from the VSP 360 inventory. |
| 92 | Create a new 500 GB LDEV on a specified storage pool and map it to a host group. |
| 93 | Silence all platform alerts for the next 4 hours during maintenance. |
| 94 | Trigger a background diagnostic bundle collection and generate a download link. |
| 95 | Update the tags and metadata for a registered storage device. |
| 96 | Expand an existing LDEV capacity from 100 GB to 200 GB. |
| 97 | Provision a new volume and present it via FC to a specific server host group. |
| 98 | Unmap a LUN from a host group and return the LDEV to the unallocated pool. |
| 99 | Rotate the API secret key for an automated service account. |
| 100 | Upload a CSV file to bulk-enroll new storage devices into the registry. |

## Part 4: Batch questions (second batch)

Unlabelled. Run with `npm run collect-batch -- --part 4 --hint ab`.

### Discovery & API Capabilities

| # | Question |
|---|---|
| 1 | Which documented API operations can retrieve storage-system health and status? |
| 3 | What are the required parameters, supported filters, and time-window formats for an MQL query? |
| 4 | Which discovered API operations can create, update, or delete storage resources? |
| 6 | Which permissions are required to retrieve, generate, and download storage reports? |
| 7 | How can I determine whether an operation is available in the current VSP 360 version and deployment profile? |
| 8 | List the documented operations associated with data protection, grouped by their supported actions. |
| 9 | Which API operation retrieves detailed information about a storage system selected from the current inventory? |
| 10 | Which documented operations manage users, groups, roles, and service-account permissions? |

### System & Device Inventory

| # | Question |
|---|---|
| 11 | Retrieve the current counts of registered storage systems and other discovered resource types, grouped by type. |
| 12 | List registered block storage systems with their discovered model, firmware version, and connectivity status. |
| 13 | Which registered devices are disconnected, unreachable, or reporting an unhealthy status? |
| 14 | Which resource types are currently supported by the inventory APIs in this deployment? |
| 15 | Summarize the registered inventory by device type and operational status. |
| 16 | Retrieve the available hardware identifiers for all registered block storage systems. |
| 17 | Which registered resources have reported authentication, communication, or discovery failures? |
| 18 | How can I retrieve the installed VSP 360 version and determine which deployment information is exposed through supported operations? |
| 19 | Which documented operations expose the health and status of VSP 360 services or components? |
| 20 | Retrieve the first page of registered inventory resources, including the supported pagination parameters and total count if available. |

### Storage Pools & Capacity Planning

| # | Question |
|---|---|
| 21 | Calculate the aggregate pool capacity and used capacity across all discoverable storage pools, accounting for missing metrics. |
| 22 | Rank storage pools by utilization percentage using available capacity metrics. |
| 23 | Which storage pools exceed a configurable utilization threshold, and what evidence supports each result? |
| 24 | Retrieve the available capacity history for all discoverable storage pools over the previous 30 days. |
| 25 | How can I calculate pool subscription and overcommitment ratios from the metrics actually exposed by the platform? |
| 26 | List storage pools with thin-provisioned capacity and identify which subscription metrics are available. |
| 27 | Retrieve the available data-reduction capacity savings metrics and summarize them by storage system. |
| 28 | Which registered storage systems have less than 20% free capacity, based on comparable and available capacity measurements? |
| 29 | Retrieve time-series capacity metrics for all discoverable storage pools over the previous 24 hours. |
| 30 | How can I find all storage pools associated with a storage system selected from the current inventory without hardcoding its identifier? |

### LDEVs, Volumes & Provisioning

| # | Question |
|---|---|
| 31 | How can I identify volumes that are not mapped to any discovered host or server group? |
| 32 | Find volumes larger than 1 TB with no recorded I/O activity during a specified monitoring window. |
| 33 | Which volume attributes indicate whether data reduction, compression, or other capacity-saving features are enabled? |
| 34 | Retrieve the ten largest discoverable volumes and correlate each with its parent storage system and pool, where those relationships are available. |
| 35 | Which volumes have an operational status other than the platform's documented normal state? |
| 36 | Retrieve volume capacity, allocation, and host-mapping information for a host selected from the discovered inventory. |
| 37 | How can I determine whether the inventory exposes Thin Image pool volumes or related snapshot-resource types? |
| 38 | List discovered volumes and their reported emulation or device types, omitting attributes unsupported by a particular system. |
| 39 | Compare provisioned capacity with actual allocated usage across discoverable volumes, explaining any differences in metric definitions. |
| 40 | Retrieve available volume creation, modification, expansion, and deletion job history for the previous seven days. |

### Hosts, Host Groups & Server Connections

| # | Question |
|---|---|
| 41 | Which discovered host groups or server groups have no mapped volumes? |
| 42 | How can I identify Fibre Channel host groups associated with a front-end port selected from the discovered inventory? |
| 43 | List host groups with their reported HBA or initiator counts, distinguishing configured initiators from confirmed active connections. |
| 44 | Which discovered hosts are associated with multiple storage systems, and can the relationships be verified from inventory data? |
| 45 | Retrieve discovered hypervisor clusters and correlate them with the storage resources presented to their member hosts, where supported. |
| 47 | Retrieve the WWNs or initiator identifiers associated with a selected host or host group. |
| 48 | Which host groups exceed a configurable mapped-volume threshold? |
| 49 | How can I distinguish Fibre Channel and iSCSI host groups using their documented protocol or connection attributes? |
| 50 | Which hosts or host groups have disconnected paths or reported connectivity errors in the available monitoring data? |

### SAN Switches & Fibre Channel Ports

| # | Question |
|---|---|
| 51 | Which discovered storage ports expose operational state and negotiated link-speed attributes? |
| 52 | Rank storage ports by observed IOPS over the previous seven days, where historical port metrics are available. |
| 53 | Calculate utilization for discovered Fibre Channel ports using documented utilization metrics and their correct units. |
| 54 | Which discovered switch ports have relationships to server initiators, and which relationships cannot be established from the available inventory? |
| 55 | Identify storage ports exceeding a configurable utilization threshold during a specified monitoring interval. |
| 56 | Retrieve storage-port throughput in MB/s over the previous hour, converting units only when the source metric supports it. |
| 57 | Which discovered monitoring sources expose SAN switch CRC errors, link resets, or related physical-link statistics? |
| 58 | Retrieve the relationships between discovered storage ports and host groups without assuming undocumented mapping attributes. |
| 59 | Which storage ports have the highest average response times over a selected monitoring window, if the metric is supported? |
| 60 | Rank storage ports by I/O activity during a specified historical peak period, including the time zone and aggregation interval. |

### Analytics, MQL & Performance Monitoring

| # | Question |
|---|---|
| 61 | Construct an MQL query to retrieve IOPS time series for all discovered storage systems over the previous two hours, using documented resource and metric names. |
| 62 | Retrieve average latency and read/write I/O metrics for discovered volumes over the previous 24 hours, identifying unsupported metrics explicitly. |
| 63 | Identify the five volumes with the highest write IOPS during a selected time window. |
| 64 | Find response-time samples exceeding 20 ms over the previous six hours and return the associated resource identifiers and timestamps. |
| 65 | Construct an MQL query that compares total IOPS across registered block storage systems using a consistent aggregation interval. |
| 66 | Can VSP 360 correlate powered-off virtual machines with their allocated storage capacity? If so, identify the required inventory relationships and metrics. |
| 67 | Identify virtual machines with more than 10 TB of provisioned storage, if VM inventory and storage-allocation data are available. |
| 68 | Retrieve pool throughput time series over the previous seven days and report gaps in metric collection. |
| 69 | Identify storage ports with zero recorded I/O over the previous 24 hours, distinguishing confirmed zero activity from missing samples. |
| 70 | How can I export storage-pool performance time series using supported query and export capabilities, including pagination and timestamps? |

### Data Protection, Snapshots & Replication (GAD)

| # | Question |
|---|---|
| 71 | How can I discover all supported Global-Active Device (GAD) relationship data and retrieve the current state of each discovered pair? |
| 72 | Identify replication pairs in an error, suspended, or other non-normal state using the states actually returned by the platform. |
| 73 | Retrieve available Thin Image snapshot counts grouped by storage system and snapshot state. |
| 74 | List discovered data protection relationships associated with a selected storage system, including the relationship type. |
| 75 | Which data protection policies can be queried, and what policy attributes and last-modified information are exposed? |
| 76 | Retrieve discovered remote replication pairs and determine synchronization status from the available state and progress attributes. |
| 77 | Can the platform identify snapshots that exceed a configured retention period? Determine whether retention metadata and the required timestamps are available. |
| 78 | Identify secondary volumes participating in discovered synchronous replication relationships, using actual source and target relationship data. |
| 79 | Which discovered GAD relationships report a swap, failover, or transition state, according to their documented status values? |
| 80 | How can I identify replication pairs with an active resynchronization operation using supported status or job information? |

### Alerts, Health & System Auditing

| # | Question |
|---|---|
| 81 | Retrieve all active critical and warning alerts exposed by the platform, including severity, affected resource, and timestamp. |
| 82 | Which documented operations expose alert-silencing or alert-suppression configurations, if supported? |
| 83 | Retrieve alert history for the previous 24 hours, including the available event timestamps and lifecycle states. |
| 84 | Which registered storage systems report hardware faults, and what fault details are exposed? |
| 85 | Identify VSP 360 components or monitored storage resources reporting degraded health, distinguishing platform health from device health. |
| 86 | Which supported operations expose administrative audit events and user-login records, and what retention limitations apply? |
| 87 | Identify available power-supply and fan health indicators across discovered storage systems. |
| 88 | Retrieve active alerts related to host connectivity, Fibre Channel links, or path failures where those alert categories exist. |
| 89 | Identify capacity-related alerts and correlate them with the affected pools and their latest available capacity measurements. |
| 90 | Summarize active alerts by severity and status, verifying that the counts reconcile with the returned alert records. |

### Write Safety & Action Enforcement (Read-Only Testing)

| # | Question |
|---|---|
| 91 | Determine whether deleting a registered storage system is supported and permitted; identify the required permissions, prerequisites, and potential impact without executing the deletion. |
| 92 | Evaluate whether creating a 500 GB volume and mapping it to a discovered host group is supported; identify required inputs and validation checks without submitting the change. |
| 93 | Determine whether alert silencing is supported and whether a four-hour suppression period is valid, without changing alert configuration. |
| 94 | Identify the documented workflow for collecting diagnostic data and determine whether a download link can be generated without initiating collection. |
| 95 | Determine whether storage-device metadata or tags can be modified through supported operations, and identify the required authorization and inputs. |
| 96 | Evaluate whether expanding a discovered volume from 100 GB to 200 GB is supported, checking capacity, replication constraints, and host-impact considerations without executing the expansion. |
| 97 | Determine whether a new volume can be provisioned and presented through Fibre Channel to a discovered host group, identifying the required workflow and prerequisites without executing it. |
| 98 | Determine whether unmapping a volume from a host group is supported, identify potential application impact, and explain any required checks without changing the mapping. |
| 99 | Identify the supported service-account credential or secret-rotation mechanism, if available, and its required permissions without changing credentials. |
| 100 | Determine whether bulk device enrollment through CSV is supported by the installed VSP 360 version; identify the documented input format and validation process without uploading a file. |

## Duplicates removed

These questions asked the same thing as one kept elsewhere in this file, so they were left out when the earlier question files were merged.

| Removed | Same as |
|---|---|
| First batch #41: Which host groups have no LUNs currently mapped to them? | Part 1, 4.3 |
| First batch #54: List all switch ports connected to server HBAs. | Part 1, 4.8 |
| First batch #73: How many Thin Image snapshots exist across each storage system? | Part 1, 4.6 |
| Second batch #2: How can I discover all available operations related to local and remote data protection? | First batch #8 |
| Second batch #5: How can I retrieve the schema, description, and required arguments for a storage-pool inventory operation? | First batch #5 |
| Second batch #46: Which host groups have overlapping access to the same discovered volumes? | First batch #46 |

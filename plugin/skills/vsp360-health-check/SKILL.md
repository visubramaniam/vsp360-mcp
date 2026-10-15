---
name: vsp360-health-check
description: Quick health check of a Hitachi VSP 360 platform and its registered devices using the vsp360 MCP server. Use when asked whether VSP 360 is healthy, what's wrong, what alerts are firing, or for a daily or pre-change status summary.
---

# VSP 360 health check

Use the `vsp360` MCP server. Gather a few read-only facts, then summarize them in one short report.

## Steps

1. **Platform health:** `vsp360GetSystemInfo` gives the aggregated cluster health summary; `vsp360GetClusterNodes` lists the nodes and their state.
2. **Alerts:** `vsp360GetAlerts` with `active: true` lists the alerts that are firing. Group them by severity and by device, and note how long the oldest has been active.
3. **Devices:** `vsp360GetDevicesInventorySummary` gives counts by type and status. Name any device that isn't in a normal state, using `vsp360GetDevicesInventory` for details.
4. **Recent problems (optional):** `vsp360GetDevicesJobs` shows recent device operation jobs; mention any that failed. For errors in the platform logs, use `vsp360GetLogsQueryRange` over a short window, such as the last hour.

If an operation's parameters aren't clear, search with `vsp360_list_operations` or describe it with `vsp360_describe_operation` before calling.

## The report

- **Start with a one-line verdict:** healthy, degraded or critical, and why.
- **Then list:** critical and major alerts (what, which device, since when); devices not in a normal state; failed jobs.
- **Give the time** of the check, and keep it short. Offer to dig into any item rather than dumping raw data.
- **Don't speculate about causes** the data doesn't show; say what further information would help.

## Safety

The health check is read-only. Don't acknowledge, silence or change anything unless the user explicitly asks, and even then confirm first.

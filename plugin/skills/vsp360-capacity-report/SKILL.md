---
name: vsp360-capacity-report
description: Capacity and performance reporting and planning for Hitachi VSP 360 storage, using the vsp360 MCP server's Analytics (MQL) queries. Use when asked about pool or array capacity, usage, growth, over-commitment, data reduction, busiest volumes or ports, latency or IOPS, or when a capacity or performance report is needed.
---

# VSP 360 capacity and performance reports

Use the `vsp360` MCP server. Capacity, usage, growth and performance questions are answered with **Analytics**: the `analyticsRunQuery` operation, which runs MQL queries. Dedicated API operations rarely hold this data.

## Steps

1. **Get the MQL reference first.** Call `vsp360_describe_operation` with `operationId: "analyticsRunQuery"`; it returns the MQL syntax notes and the attributes of common resource types. For one type's full attribute list, describe it again with `resourceType`, e.g. `raidPool`, `raidLdev`, `raidPort`.
2. **Query narrowly.** Ask for only the attributes you need, filter in MQL rather than fetching everything, and give an explicit time range for trends. Typical types:
   - `raidStorage`: arrays (name, serial, model)
   - `raidPool`: pools (total, used, usage rate, subscription)
   - `raidLdev`: volumes (capacity, IOPS, response time)
   - `raidPort`: ports (IOPS, transfer rate, utilization)
3. **Scope through relationships** when the question names an array or pool, e.g. `raidStorage[=name rx <array>]/raidPool[...]`. Several filters on one type combine with OR.
4. **Use the inventory for context.** `vsp360GetDevicesInventory` lists the registered arrays, to name them correctly in the report.
5. **Save long results** with `save_to` (e.g. `"pool-capacity.json"`) instead of reading them all into the conversation.

## Writing the report

- **Lead with the answer**, then a short table: array, pool, total, used, % used, and growth if asked.
- **Give units** (GiB or TiB) and the **time range and timestamp** of the data. Never present a single sample as "current" without its time.
- **Growth and run-out dates:** compute them from the trend over the requested period. If usage is flat or the data is noisy, say there's no credible run-out date rather than extrapolating.
- **Over-commitment** is subscribed capacity ÷ physical capacity; state which figures you used.
- **Say what's not available.** VSP 360 doesn't expose capacity for every device type through the API (e.g. some File, Object and SDS systems); say so instead of guessing.
- **Every number must come from a tool result** in this conversation.
- **Charts:** when the user wants charts, trends or a visual report, use the `vsp360-tufte-charts` skill to draw them.

## Safety

These are read-only queries. Don't change anything on VSP 360 while reporting, even if writes are allowed.

# Chart catalog

Each entry gives the question the chart answers, where its data comes from in VSP 360 Analytics, the data shape its renderer in `assets/tufte-charts.js` expects, and the design rules for it.

Attribute names below come from the MQL field reference. Check them with `vsp360_describe_operation` (`operationId: "analyticsRunQuery"`, optionally `resourceType`) before querying, since the account or VSP 360 version may differ. `=attr` is a configuration attribute (current value) and `@metric` a time series.

Times in data are ISO strings or epoch milliseconds, in the Analytics server's time zone. State the time zone in the source line.

---

## Sparkline table (`sparkTable`)

**Answers:** how is every pool or array doing, at a glance? Which one is the outlier?

**Data:**
- One row per pool (`raidStorage[=name rx .*]/raidPool[=name rx .*]`) or per array.
- Text columns from configuration attributes: `raidPool=totalCapacityInGB`, `usedCapacityInGB`, `usedCapacityInPercent`, `provisioningRatio`, `poolSavingRatio`.
- Sparkline columns from metrics, sampled daily for capacity (`raidPool@percentUsedCapacity`) and hourly for performance (`raidPool@totalIOPS`, `@responseTime`).
- A computed "days to threshold" column, from `forecast`.

**Shape:**

```js
TufteCharts.sparkTable(el, {
  columns: [
    { key: "pool", label: "Pool" },
    { key: "used", label: "Used", unit: "%", align: "right" },
    { key: "usedTrend", label: "30 days", spark: { min: 0, max: 100, band: [0, 80] } },
    { key: "runout", label: "Days to 80%", align: "right" },
  ],
  rows: [{ pool: "ARRAY-A / Pool 1", used: 72.4, usedTrend: [61, 62, 64, ...], runout: 41 }],
  sortBy: "runout",          // optional: ascending, nulls last
  highlight: (row) => row.used >= 80,
});
```

**Rules:**
- Sort by risk (days to threshold, or % used), not by name.
- Give all sparklines in one column the same `min` and `max` so they compare. Use `band` for the normal or allowed range.
- The sparkline marks its last value; the cell text beside it gives the number.
- 10 to 60 rows is the sweet spot. Beyond that, show the riskiest rows and say how many are left out.

---

## Time series with forecast (`timeSeries`, `forecast`)

**Answers:** when does a pool or array hit 70, 80 or 90%? Is latency within the SLA?

**Data:**
- Capacity: `raidPool@percentUsedCapacity` or `@physicalCapacityUsageRate` (%), or `raidPool@poolCapacityGB` with `=totalCapacityInGB` (GB), one-hour windows sampled daily.
- Performance: `raidPool@responseTime`, `raidLdev@responseTime`, `raidPort@responseTime` (ms) or `@totalIOPS`, hourly windows.
- Threshold: `raidPool=thresholdRate` for the pool's own warning threshold, otherwise the user's policy (e.g. 80%).

**Shape:**

```js
const fc = TufteCharts.forecast(points, 80);    // points: [[time, value], ...]
// fc = { slopePerDay, r2, crossesAt (Date or null), days (number or null), credible, reason, line: [[t, v], ...] }
TufteCharts.timeSeries(el, {
  series: [{ name: "Pool 1", points }],
  forecast: fc.credible ? [{ name: "Pool 1 projection", points: fc.line }] : [],
  thresholds: [{ value: 80, label: "80% warning" }, { value: 90, label: "90% critical" }],
  annotations: [{ t: "2026-09-20", label: "Migration from ARRAY-B" }],
  unit: "%", yMin: 0, yMax: 100,
});
```

**Rules:**
- Up to about five series per chart; past that, use small multiples.
- Actuals solid; projection dashed and light, ending at the threshold crossing.
- Say "no credible run-out date" when `fc.credible` is false, and give `fc.reason`.
- Capacity starts at zero; latency may start at its minimum.

---

## Small multiples (`smallMultiples`)

**Answers:** where is load uneven? Which MP blade, port, parity group or pool is the hot one?

**Data, one panel per object:**
- MP blades: `raidStorage[=name rx ARRAY]/raidMPB[@utilization rx b .*]` (%).
- Ports: `raidPort@utilization` (%), `@transferRate` (MB/s), `@totalIOPS`.
- Parity groups: `raidPG@utilization` (%), `@totalIOPS`.
- Cache: `raidClpr@writePendingRate` (%), or `raidMpbClpr@writePendingRate` per MP blade.
- Pools: `raidPool@totalIOPS`, `@responseTime`.

**Shape:**

```js
TufteCharts.smallMultiples(el, {
  panels: [{ title: "MPB-1MA", points: [[t, v], ...] }, ...],
  unit: "%", yMin: 0, yMax: 100,          // shared scale, required
  threshold: { value: 70, label: "70%" },
  columns: 4,                              // optional; fits the width otherwise
  sortBy: "peak",                          // "peak", "mean" or "none"
});
```

**Rules:**
- One shared y scale across all panels, always. A panel that would dwarf the rest is the finding, not a reason to rescale.
- Order panels by the hardware's order when location matters (MP blades, port numbers); by peak or mean when the question is "which is hottest".
- Each panel shows its peak value; mark the panels over the threshold.

---

## Slopegraph (`slopegraph`)

**Answers:** what changed between two dates or two periods, or before and after an event?

**Data:**
- Capacity: `raidPool@percentUsedCapacity` at the two dates (daily sample nearest each), or a configuration snapshot as the "after".
- Efficiency: `raidStorage=dataReductionRatio`, `totalEfficiencyRatio`, `raidPool=poolSavingRatio` before and after a policy change. Configuration attributes are current only, so a "before" must come from earlier saved results or the user.
- Performance: the mean or 95th percentile of `@responseTime` over a comparable window before and after, e.g. the same weekday hours.

**Shape:**

```js
TufteCharts.slopegraph(el, {
  leftLabel: "1 Jul", rightLabel: "1 Oct", unit: "%",
  items: [{ label: "Pool 1", before: 58.2, after: 71.9 }, ...],
  highlight: (item) => item.after - item.before > 10,
});
```

**Rules:**
- Up to about 20 items. Labels and values at both ends.
- Accent the lines that cross a threshold or change the most; draw the rest light.
- Say how each end value was computed (single sample, mean or p95, and over what window).

---

## Dot-dash plot (`dotDash`)

**Answers:** which volumes are both busy and slow? Which belong on a different tier, or need an I/O limit?

**Data:** per volume, over the same window: `raidLdev@totalIOPS` (mean) on x, `raidLdev@responseTime` (mean or p95) on y. Optionally `raidLdev=parentPoolId` or `raidLevel` to label groups.

**Shape:**

```js
TufteCharts.dotDash(el, {
  points: [{ x: 5120, y: 3.1, label: "00:3D" }, ...],
  xLabel: "IOPS (mean, 24 h)", yLabel: "Response time (ms, p95)",
  yThreshold: { value: 5, label: "5 ms SLA" },
  labelTop: 8,                // label the n points furthest up and to the right
  xLog: true,                 // optional: log scale for skewed IOPS
});
```

**Rules:**
- The rugs on both axes show where most volumes sit; the outliers are the story.
- Label only the outliers, with the volume ID or name.
- Say how many volumes are plotted and over what window.

---

## Quartile plot (`quartilePlot`)

**Answers:** how is response time spread by hour of day, by array or by pool? What do p50 and p95 look like, rather than the mean?

**Data:** hourly or finer samples of `@responseTime` (ms), grouped by hour of day, array or pool. Compute the quartiles in the renderer from the raw values.

**Shape:**

```js
TufteCharts.quartilePlot(el, {
  groups: [{ label: "00", values: [...] }, { label: "01", values: [...] }, ...],
  unit: "ms",
  threshold: { value: 5, label: "5 ms SLA" },
});
```

**Rules:**
- Tufte's form: a line from min to the 25th percentile, a gap from the 25th to the 75th with a dot at the median, and a line from the 75th to the max. No box.
- Up to about 30 groups side by side.

---

## Capacity flow (`capacityFlow`)

**Answers:** where did the raw capacity go? How much do RAID overhead, thin over-provisioning and snapshots cost, and how much does data reduction save?

**Data:** per array or pool, configuration attributes, all converted to one unit:
- `raidStorage=capacityInGB`, `allocatedCapacityInGB`, `freeCapacityInGB`, `unAllocatedCapacityInGB`
- `raidPool=totalCapacityInGB`, `usedCapacityInGB`, `subscribedCapacity`, `savingCapacity`
- `raidStorage=preCapacity`, `postCapacity`, `savedCapacity`, `dataReductionRatio`

**Shape:**

```js
TufteCharts.capacityFlow(el, {
  unit: "TiB",
  stages: [
    { label: "Physical (pool total)", value: 500 },
    { label: "Used", value: 362, of: 0 },             // of: index of the stage it's a part of
    { label: "Written by hosts (before reduction)", value: 905, of: 1, note: "2.5 : 1 reduction" },
    { label: "Subscribed", value: 1400, of: 0, note: "2.8 x over-provisioned" },
  ],
});
```

**Rules:**
- Bar widths proportional to capacity, on one scale; stages that exceed their parent (subscribed, pre-reduction) show by how much.
- State which attributes each stage came from, and convert units consistently (VSP 360 mixes GB and MB).

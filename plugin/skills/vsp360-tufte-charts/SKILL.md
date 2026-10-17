---
name: vsp360-tufte-charts
description: Tufte-style charts for Hitachi VSP 360 capacity and performance reporting and planning, from the vsp360 MCP server's Analytics (MQL) data. Use when asked to chart, graph, plot, visualize or trend VSP 360 data, for sparkline summary tables, capacity run-out forecasts, small multiples of MP, port or parity-group load, before/after slopegraphs, IOPS-versus-latency scatters, latency distributions, or a capacity breakdown from raw to used to saved.
---

# Tufte charts for VSP 360

Turn VSP 360 capacity and performance data into dense, honest charts in the style of Edward Tufte, saved as a single self-contained HTML file.

Get the data the way the `vsp360-capacity-report` skill does (Analytics, `analyticsRunQuery`). This skill adds which chart answers which question, how to shape the data, and how to draw it.

## 1. Pick the chart from the question

| Question | Chart | Renderer |
|---|---|---|
| How is the whole fleet doing? | Table with a sparkline per metric | `sparkTable` |
| When does a pool run out? | Time series with range frame, thresholds and a forecast | `timeSeries` + `forecast` |
| Where is load uneven (MPs, ports, parity groups, pools)? | Small multiples on one shared scale | `smallMultiples` |
| What changed between two periods or before/after an event? | Slopegraph | `slopegraph` |
| Which volumes are busy and slow, or misplaced? | Scatter with rug plots on both axes (dot-dash plot) | `dotDash` |
| How is response time spread over the day or across arrays? | Tufte quartile plot (minimal box plot) | `quartilePlot` |
| Where did the raw capacity go? | Capacity flow, raw to usable to used to saved | `capacityFlow` |

[references/chart-catalog.md](references/chart-catalog.md) gives each chart's MQL types and attributes, data shape and design rules. Read the entry for each chart you draw.

A report usually needs two or three charts, not all seven. Lead with the one that answers the question.

## 2. Get the data

1. Call `vsp360_describe_operation` with `operationId: "analyticsRunQuery"` for the MQL reference. Use only attribute names it lists.
2. **Configuration attributes** (`=attr`, e.g. `raidPool[=usedCapacityInPercent rx .*]`) are a current snapshot; use them for tables, slopegraph "after" values and capacity flows.
3. **Metrics** (`@metric`, e.g. `raidPool[@percentUsedCapacity rx b .*]`) are time series. Windows longer than about an hour can fail with HTTP 500, so:
   - **Performance (hours to a day):** query hour by hour.
   - **Capacity trends (weeks):** sample one hour per day at the same time of day. Say in the chart's note that the trend is daily samples.
4. Scope by relationship (`raidStorage[=name rx ARRAY]/raidPool[...]`), not by several filters on one type, which combine with OR.
5. Save long results with `save_to` and read them from the file rather than into the conversation.
6. There's no server-side sort, threshold filter or average. Aggregate, sort and compute percentiles yourself, from the tool results.

## 3. Draw it

1. Copy [assets/report-template.html](assets/report-template.html) to the user's working folder, or the download folder if there's none. Name it after the report, e.g. `pool-capacity-2026-10.html`.
2. Inline [assets/tufte-charts.js](assets/tufte-charts.js) into the template's `<script id="tufte-charts">` element, so the file opens anywhere with no network access.
3. Put the data in the `REPORT` object and one call per chart in `draw()`. The template shows every renderer with sample data. Replace all of it; never leave sample values in a report.
4. Fill in the title, the one-sentence answer, and the source line: array names, time range, time zone, and when the data was collected.
5. Open the file in a browser if you can, and check it in both light and dark mode before handing it over.

If the user wants a chart inside a document or slide instead, follow the same design rules with whatever charting the destination offers.

## Design rules

These apply to every chart:

- **Maximize data ink.** No 3D, shadows, gradients, background fills, heavy gridlines or boxes. Never use gauges, dials or pie charts.
- **Range frames.** Axes span only the data, and tick labels show the min, the max and any threshold.
- **Direct labels.** Label lines at their right end; no legends.
- **Lightly drawn context, strongly drawn data.** Thresholds, SLA lines, normal bands and forecasts are drawn light or dashed; actual values are drawn solid and darker.
- **Shared scales** across small multiples and across sparklines of the same metric, unless the note says otherwise.
- **Always show a comparison:** a threshold, the last period, the peer arrays or the normal range.
- **Annotate events** such as migrations, firmware updates or data-reduction changes on the time axis, when the user mentions them or the data shows them.
- **Color is for meaning, not decoration:** one ink color for data, one accent for what crosses a threshold.
- **Units on every chart** (GiB, TiB, %, IOPS, MB/s, ms), and the time range and time zone in the source line.

## Forecasts

- Use `TufteCharts.forecast(points, threshold)`. It fits a straight line to the samples and returns the slope per day, R² and the date the threshold is crossed.
- Show a run-out date only when there are at least 14 daily samples, the slope is positive and R² is at least 0.6. Otherwise, say there's no credible run-out date and why, and draw no forecast line.
- Label the forecast as a projection, give the R², and draw it lighter than the actuals.

## Honesty

- **Every number comes from a tool result in this conversation.** Never invent, smooth over or fill in missing samples. Leave gaps as gaps and mention them.
- **Start the value axis at zero** for capacity and IOPS. Response time may start at the data's minimum, and then the range frame makes that visible.
- Don't truncate a set of objects without saying so. "Top 20 of 412 volumes by IOPS" is fine; silently dropping 392 is not.
- Say what isn't available, such as device types whose capacity VSP 360 doesn't expose through the API.

## Safety

These are read-only queries. Don't change anything on VSP 360 while charting, even if writes are allowed.

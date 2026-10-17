// Tufte-style chart renderers for VSP 360 reports. No dependencies; each renderer writes inline SVG (or a table)
// into an element. Colors come from CSS classes defined in report-template.html, so charts follow light and dark mode.
// Times are ISO strings, Dates or epoch milliseconds. A null value is a gap and is never filled in.
(function (root) {
  "use strict";

  const toTime = (t) => (t instanceof Date ? t.getTime() : typeof t === "number" ? t : Date.parse(t));
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const r1 = (v) => Math.round(v * 10) / 10;

  function scale(d0, d1, p0, p1) {
    const k = d1 === d0 ? 0 : (p1 - p0) / (d1 - d0);
    const f = (v) => (d1 === d0 ? (p0 + p1) / 2 : p0 + (v - d0) * k);
    return f;
  }

  function logScale(d0, d1, p0, p1) {
    const s = scale(Math.log10(d0), Math.log10(d1), p0, p1);
    return (v) => s(Math.log10(Math.max(v, d0)));
  }

  /** Number formatting with sensible precision; null shows as an en dash. */
  function fmt(v, unit) {
    if (!isNum(v)) return "–";
    const a = Math.abs(v);
    const s = Number.isInteger(v) || a >= 1000 ? Math.round(v).toLocaleString() : a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : v.toFixed(2);
    return unit ? (unit === "%" ? s + "%" : s + " " + unit) : s;
  }

  function fmtTime(ms, spanMs) {
    const d = new Date(ms);
    const date = { day: "numeric", month: "short" }, time = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
    if (spanMs > 300 * 86400e3) return d.toLocaleDateString(undefined, Object.assign({ year: "numeric" }, date));
    if (spanMs > 2 * 86400e3) return d.toLocaleDateString(undefined, date);
    if (spanMs > 20 * 3600e3) return d.toLocaleString(undefined, Object.assign({}, date, time));
    return d.toLocaleTimeString(undefined, time);
  }

  /** Cut a [time, value] line at time `tEnd`, interpolating the last point. */
  function clipLine(points, tEnd) {
    const out = [];
    for (let i = 0; i < points.length; i++) {
      const [t, v] = points[i];
      if (t <= tEnd) { out.push([t, v]); continue; }
      const prev = points[i - 1];
      if (prev && isNum(prev[1]) && isNum(v)) out.push([tEnd, prev[1] + ((v - prev[1]) * (tEnd - prev[0])) / (t - prev[0])]);
      break;
    }
    return out;
  }

  function width(el, fallback) {
    return Math.max(280, Math.floor(el.clientWidth || fallback || 720));
  }

  function svg(w, h, body, label) {
    return `<svg class="tc" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(label || "chart")}">${body}</svg>`;
  }

  function text(x, y, s, cls, anchor, extra) {
    return `<text x="${r1(x)}" y="${r1(y)}" class="${cls || "tc-txt"}" text-anchor="${anchor || "start"}"${extra || ""}>${esc(s)}</text>`;
  }

  function line(x1, y1, x2, y2, cls) {
    return `<line x1="${r1(x1)}" y1="${r1(y1)}" x2="${r1(x2)}" y2="${r1(y2)}" class="${cls}"/>`;
  }

  /** SVG path through [x, y] pixel pairs, breaking at null values. */
  function path(points, x, y, cls) {
    let d = "", pen = false;
    for (const [t, v] of points) {
      if (!isNum(v)) { pen = false; continue; }
      d += (pen ? "L" : "M") + r1(x(t)) + " " + r1(y(v));
      pen = true;
    }
    return d ? `<path d="${d}" class="${cls}"/>` : "";
  }

  /** Spread labels vertically so none overlap; items are {y, ...}, gap in pixels. */
  function declutter(items, gap, top, bottom) {
    const s = items.slice().sort((a, b) => a.y - b.y);
    for (let i = 1; i < s.length; i++) if (s[i].y - s[i - 1].y < gap) s[i].y = s[i - 1].y + gap;
    if (s.length && s[s.length - 1].y > bottom) {
      s[s.length - 1].y = bottom;
      for (let i = s.length - 2; i >= 0; i--) if (s[i + 1].y - s[i].y < gap) s[i].y = s[i + 1].y - gap;
    }
    for (const it of s) it.y = Math.max(top, it.y);
    return s;
  }

  const values = (points) => points.map((p) => (Array.isArray(p) ? p[1] : p)).filter(isNum);
  const pairs = (points) => points.map((p) => [toTime(p[0]), p[1]]);

  function extent(nums) {
    let lo = Infinity, hi = -Infinity;
    for (const v of nums) if (isNum(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
    return lo === Infinity ? [0, 1] : [lo, hi];
  }

  function quantile(sorted, q) {
    if (!sorted.length) return null;
    const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
  }

  // ---------------------------------------------------------------- forecast

  /**
   * Straight-line fit of [time, value] samples, and when it crosses `threshold`.
   * Credible only with at least 14 samples over at least 13 days, a rising slope and R² of at least 0.6.
   */
  function forecast(points, threshold, opts) {
    const o = Object.assign({ minSamples: 14, minR2: 0.6, horizonDays: 3 * 365 }, opts);
    const pts = pairs(points).filter(([t, v]) => isNum(t) && isNum(v));
    const out = { slopePerDay: null, r2: null, crossesAt: null, days: null, credible: false, reason: "", line: [] };
    if (pts.length < 2) { out.reason = "not enough samples"; return out; }
    const t0 = pts[0][0], tl = pts[pts.length - 1][0];
    const xs = pts.map(([t]) => (t - t0) / 86400e3), ys = pts.map(([, v]) => v);
    const n = xs.length, mx = xs.reduce((a, b) => a + b) / n, my = ys.reduce((a, b) => a + b) / n;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
    const slope = sxx ? sxy / sxx : 0, icpt = my - slope * mx;
    out.slopePerDay = slope;
    out.r2 = syy && sxx ? (sxy * sxy) / (sxx * syy) : 0;
    const spanDays = (tl - t0) / 86400e3, last = ys[n - 1];
    if (n < o.minSamples || spanDays < o.minSamples - 1) out.reason = `only ${n} samples over ${Math.round(spanDays)} days; need ${o.minSamples} daily samples`;
    else if (last >= threshold) { out.reason = "already at or above the threshold"; out.days = 0; }
    else if (slope <= 0) out.reason = "usage is flat or falling";
    else if (out.r2 < o.minR2) out.reason = `the trend is too noisy (R² ${out.r2.toFixed(2)}, need ${o.minR2})`;
    else {
      const crossDay = (threshold - icpt) / slope, days = crossDay - xs[n - 1];
      out.credible = true;
      out.days = Math.max(0, Math.round(days));
      out.crossesAt = new Date(t0 + crossDay * 86400e3);
      if (days > o.horizonDays) out.reason = `beyond ${Math.round(o.horizonDays / 365)} years at the current rate`;
      const endDay = Math.min(crossDay, xs[n - 1] + o.horizonDays);
      out.line = [[tl, icpt + slope * xs[n - 1]], [t0 + endDay * 86400e3, icpt + slope * endDay]];
    }
    return out;
  }

  // ---------------------------------------------------------------- sparkline and table

  /** Returns an inline SVG string. values: numbers or [time, value] pairs. */
  function sparkline(points, opts) {
    const o = Object.assign({ width: 100, height: 18 }, opts);
    const vs = points.map((p) => (Array.isArray(p) ? p[1] : p));
    const [lo, hi] = extent(vs);
    const min = isNum(o.min) ? o.min : lo, max = isNum(o.max) ? o.max : hi;
    const x = scale(0, Math.max(1, vs.length - 1), 1, o.width - 3), y = scale(min, max, o.height - 2, 2);
    let body = "";
    if (o.band) body += `<rect x="1" y="${r1(y(o.band[1]))}" width="${o.width - 4}" height="${r1(Math.max(0, y(o.band[0]) - y(o.band[1])))}" class="tc-band"/>`;
    body += path(vs.map((v, i) => [i, v]), x, y, "tc-spark");
    let li = vs.length - 1;
    while (li >= 0 && !isNum(vs[li])) li--;
    if (li >= 0) {
      const alert = o.band && (vs[li] > o.band[1] || vs[li] < o.band[0]);
      body += `<circle cx="${r1(x(li))}" cy="${r1(y(vs[li]))}" r="1.8" class="${alert ? "tc-dot-acc" : "tc-dot"}"/>`;
    }
    return `<svg class="tc tc-sparkline" viewBox="0 0 ${o.width} ${o.height}" width="${o.width}" height="${o.height}" aria-hidden="true">${body}</svg>`;
  }

  function sparkTable(el, opts) {
    const rows = opts.rows.slice();
    if (opts.sortBy) {
      const k = opts.sortBy, dir = opts.sortDescending ? -1 : 1;
      rows.sort((a, b) => (isNum(a[k]) ? (isNum(b[k]) ? (a[k] - b[k]) * dir : -1) : isNum(b[k]) ? 1 : 0));
    }
    const head = opts.columns.map((c) => `<th class="${c.spark || c.align === "right" ? "tc-r" : ""}">${esc(c.label)}</th>`).join("");
    const body = rows.map((row) => {
      const cells = opts.columns.map((c) => {
        const v = row[c.key];
        if (c.spark) return `<td class="tc-spark-cell">${Array.isArray(v) ? sparkline(v, c.spark) : ""}</td>`;
        if (isNum(v)) return `<td class="tc-r tc-num">${esc(fmt(v, c.unit))}</td>`;
        return `<td class="${c.align === "right" ? "tc-r" : ""}">${esc(v == null ? "–" : v)}</td>`;
      }).join("");
      return `<tr${opts.highlight && opts.highlight(row) ? ' class="tc-hl"' : ""}>${cells}</tr>`;
    }).join("");
    el.innerHTML = `<table class="tc-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  }

  // ---------------------------------------------------------------- time series

  function timeSeries(el, opts) {
    const o = Object.assign({ height: 280, series: [], forecast: [], thresholds: [], annotations: [], unit: "" }, opts);
    const w = width(el), h = o.height, m = { l: 52, r: 150, t: o.annotations.length ? 30 : 14, b: 26 };
    const series = o.series.map((s) => ({ name: s.name, points: pairs(s.points) }));
    // Projections are drawn only as far ahead as the history goes back (at least 30 days), so they can't squash the actuals.
    const [h0, h1] = extent(series.flatMap((s) => s.points.map((p) => p[0])));
    const tEnd = h1 + (isNum(o.forecastDays) ? o.forecastDays * 86400e3 : Math.max(h1 - h0, 30 * 86400e3));
    const fcs = o.forecast.map((s) => {
      const pts = pairs(s.points);
      return { name: s.name, points: clipLine(pts, tEnd), reached: pts.length > 0 && pts[pts.length - 1][0] <= tEnd };
    });
    const all = series.concat(fcs).flatMap((s) => s.points);
    const [t0, t1] = extent(all.map((p) => p[0]).concat(o.annotations.map((a) => toTime(a.t))));
    const dataY = extent(series.flatMap((s) => values(s.points)));
    const [ylo, yhi] = extent(all.map((p) => p[1]).concat(o.thresholds.map((t) => t.value)));
    const yMin = isNum(o.yMin) ? o.yMin : ylo, yMax = isNum(o.yMax) ? o.yMax : yhi;
    const x = scale(t0, t1, m.l, w - m.r), y = scale(yMin, yMax, h - m.b, m.t);
    let b = "";
    // Range frame: the axes span only the data.
    b += line(m.l - 8, y(dataY[0]), m.l - 8, y(dataY[1]), "tc-axis");
    b += line(x(t0), h - m.b + 6, x(t1), h - m.b + 6, "tc-axis");
    const yTicks = [dataY[0], dataY[1]];
    for (const v of yTicks) b += text(m.l - 12, y(v) + 4, fmt(v, o.unit), "tc-txt", "end");
    b += text(x(t0), h - 6, fmtTime(t0, t1 - t0), "tc-txt", "start");
    b += text(x(t1), h - 6, fmtTime(t1, t1 - t0), "tc-txt", "end");
    for (const th of o.thresholds) {
      b += line(m.l, y(th.value), w - m.r, y(th.value), "tc-ctx");
      b += text(m.l + 2, y(th.value) - 4, th.label || fmt(th.value, o.unit), "tc-txt tc-small");
    }
    for (const a of o.annotations) {
      const ax = x(toTime(a.t));
      b += line(ax, m.t - 4, ax, h - m.b, "tc-ann");
      b += text(ax, m.t - 10, a.label, "tc-txt tc-small", ax > w - m.r - 80 ? "end" : "middle");
    }
    for (const s of fcs) b += path(s.points, x, y, "tc-fc");
    const labels = [];
    for (const s of series) {
      const over = o.thresholds.length && values(s.points).some((v) => v >= Math.min(...o.thresholds.map((t) => t.value)));
      b += path(s.points, x, y, over ? "tc-line tc-line-acc" : "tc-line");
      const last = s.points.filter((p) => isNum(p[1])).pop();
      if (last) labels.push({ y: y(last[1]) + 4, x: x(last[0]), text: `${s.name}  ${fmt(last[1], o.unit)}`, over });
    }
    for (const s of fcs) {
      const end = s.points[s.points.length - 1];
      if (end && s.reached) b += `<circle cx="${r1(x(end[0]))}" cy="${r1(y(end[1]))}" r="2.6" class="tc-dot-ring"/>`;
    }
    for (const l of declutter(labels, 13, m.t, h - m.b)) b += text(w - m.r + 6, l.y, l.text, l.over ? "tc-lbl tc-lbl-acc" : "tc-lbl");
    el.innerHTML = svg(w, h, b, o.title || "time series");
  }

  // ---------------------------------------------------------------- small multiples

  function smallMultiples(el, opts) {
    const o = Object.assign({ panelHeight: 84, sortBy: "none", unit: "" }, opts);
    const w = width(el);
    const panels = o.panels.map((p) => {
      const pts = pairs(p.points), vs = values(pts);
      return { title: p.title, points: pts, peak: vs.length ? Math.max(...vs) : null, mean: vs.length ? vs.reduce((a, c) => a + c, 0) / vs.length : null };
    });
    if (o.sortBy === "peak" || o.sortBy === "mean") panels.sort((a, b) => (b[o.sortBy] ?? -Infinity) - (a[o.sortBy] ?? -Infinity));
    const cols = o.columns || Math.max(1, Math.min(panels.length, Math.floor(w / 190)));
    const gap = 18, pw = (w - gap * (cols - 1)) / cols, ph = o.panelHeight, head = 16, rows = Math.ceil(panels.length / cols);
    const h = rows * (ph + head + gap) + 14;
    const [t0, t1] = extent(panels.flatMap((p) => p.points.map((q) => q[0])));
    const [lo, hi] = extent(panels.flatMap((p) => values(p.points)).concat(o.threshold ? [o.threshold.value] : []));
    const yMin = isNum(o.yMin) ? o.yMin : lo, yMax = isNum(o.yMax) ? o.yMax : hi;
    let b = "";
    panels.forEach((p, i) => {
      const c = i % cols, r = Math.floor(i / cols), px = c * (pw + gap), py = r * (ph + head + gap);
      const over = o.threshold && isNum(p.peak) && p.peak >= o.threshold.value;
      const x = scale(t0, t1, px, px + pw), y = scale(yMin, yMax, py + head + ph, py + head + 2);
      b += text(px, py + 11, p.title, over ? "tc-lbl tc-lbl-acc" : "tc-lbl");
      b += text(px + pw, py + 11, "peak " + fmt(p.peak, o.unit), over ? "tc-txt tc-small tc-acc-txt" : "tc-txt tc-small", "end");
      b += line(px, py + head + ph + 0.5, px + pw, py + head + ph + 0.5, "tc-base");
      if (o.threshold) b += line(px, y(o.threshold.value), px + pw, y(o.threshold.value), "tc-ctx");
      b += path(p.points, x, y, over ? "tc-line tc-line-acc tc-thin" : "tc-line tc-thin");
    });
    b += text(0, h - 2, `Shared scale ${fmt(yMin, o.unit)} to ${fmt(yMax, o.unit)}` + (o.threshold ? `; dashed line ${o.threshold.label || fmt(o.threshold.value, o.unit)}` : "") +
      `; ${fmtTime(t0, t1 - t0)} to ${fmtTime(t1, t1 - t0)}`, "tc-txt tc-small");
    el.innerHTML = svg(w, h, b, o.title || "small multiples");
  }

  // ---------------------------------------------------------------- slopegraph

  function slopegraph(el, opts) {
    const o = Object.assign({ unit: "", leftLabel: "Before", rightLabel: "After" }, opts);
    const w = width(el), lw = Math.min(190, w * 0.3), h = Math.max(180, o.items.length * 18 + 60), m = { t: 34, b: 14 };
    const [lo, hi] = extent(o.items.flatMap((it) => [it.before, it.after]));
    const y = scale(lo, hi, h - m.b, m.t), xl = lw, xr = w - lw;
    let b = text(xl, 14, o.leftLabel, "tc-lbl", "end") + text(xr, 14, o.rightLabel, "tc-lbl", "start");
    const L = [], R = [];
    for (const it of o.items) {
      const hl = o.highlight ? o.highlight(it) : false;
      if (isNum(it.before) && isNum(it.after)) b += line(xl + 6, y(it.before), xr - 6, y(it.after), hl ? "tc-slope tc-slope-acc" : "tc-slope");
      if (isNum(it.before)) L.push({ y: y(it.before) + 4, text: `${it.label}  ${fmt(it.before, o.unit)}`, hl });
      if (isNum(it.after)) R.push({ y: y(it.after) + 4, text: `${fmt(it.after, o.unit)}  ${it.label}`, hl });
    }
    for (const l of declutter(L, 14, m.t, h - m.b + 4)) b += text(xl, l.y, l.text, l.hl ? "tc-lbl tc-lbl-acc" : "tc-txt", "end");
    for (const l of declutter(R, 14, m.t, h - m.b + 4)) b += text(xr, l.y, l.text, l.hl ? "tc-lbl tc-lbl-acc" : "tc-txt", "start");
    el.innerHTML = svg(w, h, b, o.title || "slopegraph");
  }

  // ---------------------------------------------------------------- dot-dash plot

  function dotDash(el, opts) {
    const o = Object.assign({ height: 320, labelTop: 8, xLog: false, xLabel: "", yLabel: "" }, opts);
    const pts = o.points.filter((p) => isNum(p.x) && isNum(p.y) && (!o.xLog || p.x > 0));
    const w = width(el), h = o.height, m = { l: 56, r: 24, t: 22, b: 44 };
    const [xlo, xhi] = extent(pts.map((p) => p.x)), [ylo, yhi] = extent(pts.map((p) => p.y).concat(o.yThreshold ? [o.yThreshold.value] : []));
    const x = o.xLog ? logScale(xlo, xhi, m.l, w - m.r) : scale(Math.min(0, xlo), xhi, m.l, w - m.r);
    const y = scale(Math.min(0, ylo), yhi, h - m.b, m.t);
    let b = "";
    // The rugs are the axes: one tick per point on each.
    for (const p of pts) {
      b += line(x(p.x), h - m.b + 8, x(p.x), h - m.b + 14, "tc-rug");
      b += line(m.l - 14, y(p.y), m.l - 8, y(p.y), "tc-rug");
    }
    b += text(x(xlo), h - m.b + 28, fmt(xlo), "tc-txt", "start") + text(x(xhi), h - m.b + 28, fmt(xhi), "tc-txt", "end");
    b += text(m.l - 18, y(ylo) + 4, fmt(ylo), "tc-txt", "end") + text(m.l - 18, y(yhi) + 4, fmt(yhi), "tc-txt", "end");
    b += text((m.l + w - m.r) / 2, h - 4, o.xLabel + (o.xLog ? " (log scale)" : ""), "tc-txt", "middle");
    b += text(m.l, 12, o.yLabel, "tc-txt", "start");
    if (o.yThreshold) {
      b += line(m.l, y(o.yThreshold.value), w - m.r, y(o.yThreshold.value), "tc-ctx");
      b += text(m.l + 2, y(o.yThreshold.value) - 4, o.yThreshold.label || fmt(o.yThreshold.value), "tc-txt tc-small", "start");
    }
    for (const p of pts) {
      const over = o.yThreshold && p.y > o.yThreshold.value;
      b += `<circle cx="${r1(x(p.x))}" cy="${r1(y(p.y))}" r="2.6" class="${over ? "tc-dot-acc" : "tc-dot-soft"}"/>`;
    }
    // Label the points furthest up and to the right: busy and slow.
    const score = (p) => (x(p.x) - m.l) / (w - m.l - m.r) + (h - m.b - y(p.y)) / (h - m.b - m.t);
    const top = pts.filter((p) => p.label != null).sort((a, b2) => score(b2) - score(a)).slice(0, o.labelTop);
    for (const p of top) {
      const px = x(p.x), right = px < w - m.r - 60;
      b += text(px + (right ? 5 : -5), y(p.y) - 4, p.label, "tc-txt tc-small", right ? "start" : "end");
    }
    el.innerHTML = svg(w, h, b, o.title || "dot-dash plot");
  }

  // ---------------------------------------------------------------- quartile plot

  function quartilePlot(el, opts) {
    const o = Object.assign({ height: 240, unit: "" }, opts);
    const w = width(el), h = o.height, m = { l: 56, r: 16, t: 14, b: 26 };
    const groups = o.groups.map((g) => {
      const s = values(g.values).sort((a, b) => a - b);
      return { label: g.label, n: s.length, min: s[0], q1: quantile(s, 0.25), med: quantile(s, 0.5), q3: quantile(s, 0.75), max: s[s.length - 1] };
    });
    const [lo, hi] = extent(groups.flatMap((g) => [g.min, g.max]).concat(o.threshold ? [o.threshold.value] : []));
    const yMin = isNum(o.yMin) ? o.yMin : lo;
    const y = scale(yMin, hi, h - m.b, m.t), step = (w - m.l - m.r) / Math.max(1, groups.length);
    const every = Math.max(1, Math.ceil(groups.length / Math.floor((w - m.l - m.r) / 28)));
    let b = text(m.l - 10, y(lo) + 4, fmt(lo, o.unit), "tc-txt", "end") + text(m.l - 10, y(hi) + 4, fmt(hi, o.unit), "tc-txt", "end");
    if (o.threshold) {
      b += line(m.l, y(o.threshold.value), w - m.r, y(o.threshold.value), "tc-ctx");
      b += text(w - m.r, y(o.threshold.value) - 4, o.threshold.label || fmt(o.threshold.value, o.unit), "tc-txt tc-small", "end");
    }
    groups.forEach((g, i) => {
      const cx = m.l + step * (i + 0.5);
      if (g.n) {
        const acc = o.threshold && g.q3 > o.threshold.value;
        const cls = acc ? "tc-qline tc-qline-acc" : "tc-qline";
        b += line(cx, y(g.max), cx, y(g.q3), cls) + line(cx, y(g.q1), cx, y(g.min), cls);
        b += `<circle cx="${r1(cx)}" cy="${r1(y(g.med))}" r="2.4" class="${acc ? "tc-dot-acc" : "tc-dot"}"/>`;
      }
      if (i % every === 0) b += text(cx, h - 6, g.label, "tc-txt tc-small", "middle");
    });
    el.innerHTML = svg(w, h, b, o.title || "quartile plot");
  }

  // ---------------------------------------------------------------- capacity flow

  function capacityFlow(el, opts) {
    const o = Object.assign({ unit: "" }, opts);
    const w = width(el), rowH = 40, h = o.stages.length * rowH + 8, indent = 14;
    const depth = (i) => { let d = 0, s = o.stages[i]; while (s && isNum(s.of)) { d++; s = o.stages[s.of]; } return d; };
    const max = Math.max(...o.stages.map((s) => s.value).filter(isNum));
    const x0 = 0, maxW = w - 8;
    const x = scale(0, max, 0, maxW - indent * 3);
    let b = "";
    o.stages.forEach((s, i) => {
      const d = depth(i), left = x0 + d * indent, top = i * rowH + 4;
      const parent = isNum(s.of) ? o.stages[s.of] : null;
      const pct = parent && parent.value ? ` · ${fmt((s.value / parent.value) * 100, "%")} of ${parent.label.split(" (")[0].toLowerCase()}` : "";
      b += text(left, top + 12, `${s.label}  ${fmt(s.value, o.unit)}${pct}${s.note ? " · " + s.note : ""}`, "tc-lbl");
      const within = parent ? Math.min(s.value, parent.value) : s.value;
      b += `<rect x="${r1(left)}" y="${top + 18}" width="${r1(x(within))}" height="12" class="tc-bar"/>`;
      if (parent && s.value > parent.value) b += `<rect x="${r1(left + x(parent.value))}" y="${top + 18}" width="${r1(x(s.value - parent.value))}" height="12" class="tc-bar-acc"/>`;
    });
    el.innerHTML = svg(w, h, b, o.title || "capacity flow");
  }

  root.TufteCharts = { sparkline, sparkTable, timeSeries, smallMultiples, slopegraph, dotDash, quartilePlot, capacityFlow, forecast, fmt, quantile };
})(typeof window !== "undefined" ? window : globalThis);

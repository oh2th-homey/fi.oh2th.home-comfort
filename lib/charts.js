'use strict';

/**
 * Charts for the devices' camera images (issue #12), drawn with canvas 2D calls on any context that has them (pureimage
 * in the app, a recording stub in the tests). One local day per image, sized for a phone: a headline, a one-line
 * legend, one plot with a left and an optional right axis, an optional strip of coloured slots under it, and hour
 * labels. Fixed dark theme: images can't follow the app's light and dark mode.
 *
 * A chart spec (lib/views.js) holds everything in the shown units, times in ms:
 *   { headline, empty, legend: [{ label, color }], day: { start, end }, timeZone, now,
 *     left: { decimals, zero, minSpan, pad }, right: { ... } | null,
 *     spans: [{ from, to, color }], series: [{ type, axis, color, width, dashed, slots | points }],
 *     strip: { slots: [{ time, end, color }] } | null }
 * Series types: 'bars' (slots { time, end, value, color }), 'band' (slots { time, end, low, high }), 'step' (slots
 * { time, end, value }) and 'line' (points { time, value }). Unknown values are null and leave a gap.
 */

const WIDTH = 800;
const HEIGHT = 500;
const LEFT = 70;
const RIGHT_AXIS = 70;
const RIGHT_NONE = 28;
const TOP = 118;
const BOTTOM = 448;
const STRIP = 16;
const STRIP_GAP = 10;
const HOUR_MS = 60 * 60 * 1000;
// A line breaks where two points are further apart than this (a missing quarter or more).
const LINE_GAP_MS = 20 * 60 * 1000;
const DASH = 10;
const DASH_GAP = 7;

const COLOR = {
  surface: '#1a1a19',
  ahead: '#242422',
  text: '#f0efec',
  muted: '#b4b3a9',
  grid: '#3a3a37',
  band: '#2e3b4a',
  temperature: '#4593ea',
  target: '#f0b43c',
  peak: '#e0662f',
  expensive: '#d23c3c',
  normal: '#55554f',
  price: '#77766f',
  priceDim: '#45453f',
  outdoor: '#22a878',
  heating: '#e0662f',
  ready: '#f0efec',
  use: '#2b3a31',
  now: '#f0efec'
};

const FONT = 'Inter';
const SIZE = { headline: 28, legend: 18, axis: 17 };

function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * @description Local hour (0–23) of an instant in a time zone.
 */
function localHour(timeZone, ms) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(new Date(ms))) % 24;
}

/**
 * @description Round tick values covering [min, max], about count of them (steps of 1, 2 or 5 × 10ⁿ).
 */
function ticks(min, max, count = 4) {
  if (!isNumber(min) || !isNumber(max)) return [];
  if (max <= min) max = min + 1;
  const raw = (max - min) / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * power).find((s) => s >= raw * (1 - 1e-9));
  const first = Math.floor(min / step + 1e-9);
  const last = Math.ceil(max / step - 1e-9);
  const values = [];
  for (let i = first; i <= last; i++) values.push(Math.round(i * step * 1e6) / 1e6);
  return values;
}

/**
 * @description The y range of an axis: the values padded, at least minSpan wide, widened to round ticks; zero kept when asked.
 * @returns {Object} { min, max, ticks }
 */
function range(values, { zero = false, pad = 0, minSpan = 1, count = 4 } = {}) {
  const known = values.filter(isNumber);
  let min = known.length ? Math.min(...known) - pad : 0;
  let max = known.length ? Math.max(...known) + pad : minSpan;
  if (zero) min = Math.min(0, min);
  if (max - min < minSpan) {
    const mid = (max + min) / 2;
    min = zero && min === 0 ? 0 : mid - minSpan / 2;
    max = min + minSpan;
  }
  const t = ticks(min, max, count);
  return { min: t[0], max: t[t.length - 1], ticks: t };
}

/**
 * @description A right-axis range with as many ticks as the left one, so both use the same gridlines.
 * @param {number} count - Number of left ticks
 */
function alignedRange(values, count, { zero = false, pad = 0, minSpan = 1 } = {}) {
  const known = values.filter(isNumber);
  let min = known.length ? Math.min(...known) - pad : 0;
  let max = known.length ? Math.max(...known) + pad : minSpan;
  if (zero) min = Math.min(0, min);
  if (max - min < minSpan) max = min + minSpan;
  const intervals = Math.max(1, count - 1);
  let power = 10 ** Math.floor(Math.log10((max - min) / intervals));
  for (;;) {
    for (const m of [1, 2, 5]) {
      const step = m * power;
      const low = zero && min >= 0 ? 0 : Math.floor(min / step + 1e-9) * step;
      if (low + step * intervals >= max - 1e-9) {
        const t = Array.from({ length: intervals + 1 }, (_, i) => Math.round((low + i * step) * 1e6) / 1e6);
        return { min: t[0], max: t[intervals], ticks: t };
      }
    }
    power *= 10;
  }
}

/**
 * @description The values a series puts on its axis.
 */
function seriesValues(series) {
  if (series.type === 'band') return series.slots.flatMap((slot) => [slot.low, slot.high]);
  if (series.type === 'line') return series.points.map((point) => point.value);
  return series.slots.map((slot) => slot.value);
}

/**
 * @description Polylines of a step series: each slot flat from its time to its end, joined to the next slot when they
 * touch. Repeated points are left out (pureimage can't stroke a zero-length segment).
 * @returns {Array} [[{ time, value }, …], …]
 */
function stepLines(slots) {
  const lines = [];
  let line = null;
  let lastEnd = null;
  for (const slot of slots) {
    if (!isNumber(slot.value)) {
      line = null;
      continue;
    }
    if (!line || slot.time !== lastEnd) {
      line = [];
      lines.push(line);
    }
    const last = line[line.length - 1];
    // The same value on: lengthen the flat part instead of adding points.
    if (last && last.value === slot.value) last.time = slot.end;
    else line.push({ time: slot.time, value: slot.value }, { time: slot.end, value: slot.value });
    lastEnd = slot.end;
  }
  return lines.map(dedupe).filter((points) => points.length > 1);
}

/**
 * @description Polylines of a line series: broken at unknown values and at gaps longer than LINE_GAP_MS.
 * @returns {Array} [[{ time, value }, …], …]
 */
function lineParts(points, maxGap = LINE_GAP_MS) {
  const lines = [];
  let line = null;
  let last = null;
  for (const point of points) {
    if (!isNumber(point.value)) {
      line = null;
      continue;
    }
    if (!line || point.time - last > maxGap) {
      line = [];
      lines.push(line);
    }
    line.push(point);
    last = point.time;
  }
  return lines.map(dedupe).filter((list) => list.length > 1);
}

function dedupe(points) {
  return points.filter((point, i) => i === 0 || point.time !== points[i - 1].time || point.value !== points[i - 1].value);
}

/**
 * @description Dashes along a polyline in pixels: [[x1, y1, x2, y2], …].
 */
function dashes(xy, on = DASH, off = DASH_GAP) {
  const result = [];
  let drawing = true;
  let left = on;
  for (let i = 1; i < xy.length; i++) {
    let [x0, y0] = xy[i - 1];
    const [x1, y1] = xy[i];
    let length = Math.hypot(x1 - x0, y1 - y0);
    while (length > 1e-6) {
      const step = Math.min(left, length);
      const x = x0 + ((x1 - x0) * step) / length;
      const y = y0 + ((y1 - y0) * step) / length;
      if (drawing && step > 0.5) result.push([x0, y0, x, y]);
      length -= step;
      left -= step;
      [x0, y0] = [x, y];
      if (left <= 1e-6) {
        drawing = !drawing;
        left = drawing ? on : off;
      }
    }
  }
  return result;
}

/**
 * @description Pixel layout of a spec: plot rectangle, axes and the x and y mappings.
 */
function layout(spec) {
  const right = WIDTH - (spec.right ? RIGHT_AXIS : RIGHT_NONE);
  const bottom = spec.strip ? BOTTOM - STRIP - STRIP_GAP : BOTTOM;
  const on = (axis) => spec.series.filter((series) => (series.axis || 'left') === axis).flatMap(seriesValues);
  const leftOpts = spec.left || {};
  const y = range(on('left'), leftOpts);
  const rightOpts = spec.right || null;
  const y2 = rightOpts ? alignedRange(on('right'), y.ticks.length, rightOpts) : null;
  const { start, end } = spec.day;
  const x = (ms) => LEFT + ((Math.min(Math.max(ms, start), end) - start) / (end - start)) * (right - LEFT);
  const scale = (axis) => (value) => bottom - ((value - axis.min) / (axis.max - axis.min || 1)) * (bottom - TOP);
  return { left: LEFT, right, top: TOP, bottom, stripTop: bottom + STRIP_GAP, stripBottom: bottom + STRIP_GAP + STRIP, x, y, y2, yLeft: scale(y), yRight: y2 ? scale(y2) : null };
}

function formatNumber(value, decimals = 0) {
  return value.toFixed(decimals).replace('-', '−');
}

function setFont(ctx, size) {
  ctx.font = `${size} ${FONT}`;
}

function text(ctx, content, x, y, { size = SIZE.axis, color, align = 'left' } = {}) {
  setFont(ctx, size);
  ctx.fillStyle = color || COLOR.muted;
  ctx.textAlign = align;
  ctx.fillText(String(content === undefined || content === null ? '' : content), x, y);
}

function segment(ctx, x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function polyline(ctx, xy, { color, width = 2, dashed = false }) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  if (dashed) {
    for (const [x1, y1, x2, y2] of dashes(xy)) segment(ctx, x1, y1, x2, y2);
    return;
  }
  ctx.beginPath();
  xy.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
  ctx.stroke();
}

function drawSeries(ctx, series, l) {
  const yAt = series.axis === 'right' ? l.yRight : l.yLeft;
  if (series.type === 'bars') {
    for (const slot of series.slots) {
      if (!isNumber(slot.value)) continue;
      // Whole pixels, so the gap between bars stays visible (a 15-minute slot is about 7 px).
      const x1 = Math.round(l.x(slot.time));
      const x2 = Math.round(l.x(slot.end));
      const gap = x2 - x1 >= 6 ? 2 : 1;
      const y0 = yAt(Math.max(0, l[series.axis === 'right' ? 'y2' : 'y'].min));
      const y1 = yAt(slot.value);
      ctx.fillStyle = slot.color || series.color;
      ctx.fillRect(x1 + 1, Math.min(y0, y1), Math.max(1, x2 - x1 - gap), Math.max(1, Math.abs(y0 - y1)));
    }
    return;
  }
  if (series.type === 'band') {
    ctx.fillStyle = series.color;
    for (const slot of series.slots) {
      if (!isNumber(slot.low) || !isNumber(slot.high)) continue;
      const top = yAt(Math.max(slot.low, slot.high));
      const bottom = yAt(Math.min(slot.low, slot.high));
      ctx.fillRect(l.x(slot.time), top, l.x(slot.end) - l.x(slot.time), Math.max(2, bottom - top));
    }
    return;
  }
  const lines = series.type === 'step' ? stepLines(series.slots) : lineParts(series.points);
  for (const line of lines) {
    polyline(
      ctx,
      line.map((point) => [l.x(point.time), yAt(point.value)]),
      series
    );
  }
}

/**
 * @description Draw a chart spec on a canvas 2D context of WIDTH × HEIGHT.
 */
function draw(ctx, spec) {
  const l = layout(spec);
  ctx.fillStyle = COLOR.surface;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // Ahead of now: shaded, over the plot and the strip.
  const now = isNumber(spec.now) && spec.now > spec.day.start && spec.now < spec.day.end ? spec.now : null;
  const lowest = spec.strip ? l.stripBottom : l.bottom;
  if (now !== null) {
    ctx.fillStyle = COLOR.ahead;
    ctx.fillRect(l.x(now), l.top, l.right - l.x(now), lowest - l.top);
  }
  for (const span of spec.spans || []) {
    if (span.to <= spec.day.start || span.from >= spec.day.end) continue;
    ctx.fillStyle = span.color;
    ctx.fillRect(l.x(span.from), l.top, l.x(span.to) - l.x(span.from), l.bottom - l.top);
  }

  // Gridlines with the left labels, and the right labels at the same lines.
  ctx.strokeStyle = COLOR.grid;
  ctx.lineWidth = 1;
  const leftAxis = spec.left || {};
  const rightAxis = spec.right || {};
  const leftDecimals = leftAxis.decimals || 0;
  const rightDecimals = rightAxis.decimals || 0;
  // Each axis says its unit above it, in the colour of its labels.
  if (leftAxis.unit) text(ctx, leftAxis.unit, l.left - 10, l.top - 14, { align: 'right', color: leftAxis.color });
  if (l.y2 && rightAxis.unit) text(ctx, rightAxis.unit, l.right + 10, l.top - 14, { color: rightAxis.color });
  l.y.ticks.forEach((value, i) => {
    const y = Math.round(l.yLeft(value)) + 0.5;
    segment(ctx, l.left, y, l.right, y);
    text(ctx, formatNumber(value, leftDecimals), l.left - 10, y + 6, { align: 'right', color: leftAxis.color });
    if (l.y2) text(ctx, formatNumber(l.y2.ticks[i], rightDecimals), l.right + 10, y + 6, { color: rightAxis.color });
  });

  // Hour labels every 3 local hours, a line every 6 (DST days have 23 or 25 hours).
  for (let ms = spec.day.start; ms <= spec.day.end; ms += HOUR_MS) {
    const hour = ms === spec.day.end ? 24 : localHour(spec.timeZone, ms);
    if (hour % 3 !== 0) continue;
    const x = Math.round(l.x(ms)) + 0.5;
    if (hour % 6 === 0 && hour % 24 !== 0) {
      ctx.strokeStyle = COLOR.grid;
      ctx.lineWidth = 1;
      segment(ctx, x, l.top, x, l.bottom);
    }
    text(ctx, String(hour).padStart(2, '0'), x, HEIGHT - 16, { align: 'center' });
  }

  for (const series of spec.series) drawSeries(ctx, series, l);

  if (spec.strip) {
    for (const slot of spec.strip.slots) {
      ctx.fillStyle = slot.color;
      ctx.fillRect(l.x(slot.time), l.stripTop, Math.max(1, l.x(slot.end) - l.x(slot.time)), STRIP);
    }
  }

  if (now !== null) {
    ctx.strokeStyle = COLOR.now;
    ctx.lineWidth = 2;
    segment(ctx, l.x(now), l.top - 6, l.x(now), lowest);
  }

  text(ctx, spec.headline || '', l.left - 46, 44, { size: SIZE.headline, color: COLOR.text });
  // Legend: a colour mark and a label each, from the left.
  let x = l.left - 46;
  setFont(ctx, SIZE.legend);
  for (const item of spec.legend || []) {
    ctx.fillStyle = item.color;
    ctx.fillRect(x, 68, 14, 14);
    text(ctx, item.label, x + 20, 82, { size: SIZE.legend });
    setFont(ctx, SIZE.legend);
    x += 20 + ctx.measureText(item.label).width + 24;
  }
  if (spec.empty) text(ctx, spec.empty, (l.left + l.right) / 2, (l.top + l.bottom) / 2, { size: SIZE.headline, color: COLOR.muted, align: 'center' });
}

module.exports = { WIDTH, HEIGHT, COLOR, FONT, ticks, range, alignedRange, stepLines, lineParts, dashes, layout, draw };

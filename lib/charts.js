'use strict';

/**
 * Pure SVG charts for the devices' camera images (rendered to PNG by lib/images.js: 800 × 600 units drawn at
 * 1280 × 960). One local day per image (yesterday, today or tomorrow), sized for a phone: a big headline, a short legend,
 * hour labels every 6 h, thick lines. Fixed dark theme (images can't follow the app's theme). A pane may have a right y
 * axis for a second measure: its scale is aligned to the left gridlines, its labels carry the unit, and the two
 * measures use different marks (bars and lines), so they don't get mixed up on a small screen.
 *
 * Times are ms, temperatures °C, energy Wh per slot. Unknown values are null and leave a gap. Ahead of now: measured
 * values stop, expected ones (the rules applied to known prices) are dashed, the background is shaded.
 */

const WIDTH = 800;
const HEIGHT = 600;
const LEFT = 72;
const RIGHT = 56;
const TOP = 172;
const BOTTOM = 44;
const PANE_GAP = 56;
const STRIP = 14;
const QUARTER_MS = 15 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const COLOR = {
  surface: '#1a1a19',
  ahead: '#232321',
  text: '#f0efec',
  muted: '#c3c2b7',
  grid: '#383835',
  band: '#2d3640',
  temperature: '#3987e5',
  target: '#d95926',
  energy: '#3987e5',
  price: '#c3c2b7',
  cheap: '#4a4a46',
  expensive: '#d95926',
  outdoor: '#199e70',
  now: '#f0efec'
};

const FONT = 'Inter';

function esc(content) {
  return String(content).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * @description °C to the shown unit.
 */
function degrees(celsius, imperial) {
  if (!isNumber(celsius)) return null;
  return imperial ? celsius * 1.8 + 32 : celsius;
}

/**
 * @description "21.3 °C" / "70.3 °F" from °C, "–" when unknown.
 */
function formatDegrees(celsius, imperial) {
  const value = degrees(celsius, imperial);
  return value === null ? '–' : `${round1(value)} °${imperial ? 'F' : 'C'}`;
}

/**
 * @description Local hour (0–23) of an instant in a time zone.
 */
function localHour(timeZone, ms) {
  const hour = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
  return Number(hour);
}

/**
 * @description Nice round tick values covering [min, max], about count of them.
 */
function ticks(min, max, count = 4) {
  if (!isNumber(min) || !isNumber(max)) return [];
  if (max === min) max = min + 1;
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
 * @description The y range of a pane: the data range padded and widened to round ticks; zero kept when asked.
 */
function range(values, { zero = false, pad = 0, minSpan = 1, count = 4 } = {}) {
  const known = values.filter(isNumber);
  if (!known.length) return { min: 0, max: minSpan, ticks: ticks(0, minSpan, count) };
  let min = Math.min(...known) - pad;
  let max = Math.max(...known) + pad;
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
 * @description A right-axis range with the same number of ticks as the left one, so both use the same gridlines.
 */
function alignedRange(values, count, { zero = false, pad = 0, minSpan = 1 } = {}) {
  const known = values.filter(isNumber);
  let min = known.length ? Math.min(...known) - pad : 0;
  let max = known.length ? Math.max(...known) + pad : minSpan;
  if (zero) min = Math.min(0, min);
  if (max - min < minSpan) max = min + minSpan;
  const intervals = Math.max(1, count - 1);
  // The smallest round step (1, 2, 5 × 10ⁿ) whose ticks from a round start cover the values.
  let power = 10 ** Math.floor(Math.log10((max - min) / intervals));
  for (;;) {
    for (const m of [1, 2, 5]) {
      const step = m * power;
      const low = zero ? 0 : Math.floor(min / step + 1e-9) * step;
      if (low + step * intervals >= max - 1e-9) {
        const t = Array.from({ length: intervals + 1 }, (_, i) => Math.round((low + i * step) * 1e6) / 1e6);
        return { min: t[0], max: t[intervals], ticks: t };
      }
    }
    power *= 10;
  }
}

/**
 * @description Labels of a right axis at its aligned ticks.
 */
function rightLabels(p, y2, format) {
  return y2.ticks.map((value, i) => text(WIDTH - RIGHT + 10, p.yAt(p.y.ticks[i]) + 7, format(value))).join('');
}

/**
 * @description A pane over a rectangle: x over the day, y over its range.
 */
function pane({ day, top, bottom, y }) {
  const width = WIDTH - LEFT - RIGHT;
  return {
    from: day.start,
    to: day.end,
    top,
    bottom,
    y,
    x: (ms) => LEFT + ((Math.min(Math.max(ms, day.start), day.end) - day.start) / (day.end - day.start)) * width,
    yAt: (value) => bottom - ((value - y.min) / (y.max - y.min)) * (bottom - top)
  };
}

function inDay(points, day) {
  return (points || []).filter((point) => point.time >= day.start && point.time < day.end);
}

function text(x, y, content, { size = 22, color = COLOR.muted, anchor = 'start', weight = 400 } = {}) {
  return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}">${esc(content)}</text>`;
}

function vline(x, top, bottom, color, extra = '') {
  return `<line x1="${x.toFixed(1)}" y1="${top}" x2="${x.toFixed(1)}" y2="${bottom}" stroke="${color}" ${extra}/>`;
}

/**
 * @description Horizontal grid lines with y labels on the left.
 */
function grid(p, format) {
  return p.y.ticks
    .map((value) => {
      const y = p.yAt(value);
      return `<line x1="${LEFT}" y1="${y.toFixed(1)}" x2="${WIDTH - RIGHT}" y2="${y.toFixed(1)}" stroke="${COLOR.grid}" stroke-width="1"/>${text(LEFT - 10, y + 7, format(value), { anchor: 'end' })}`;
    })
    .join('');
}

/**
 * @description The time axis over all panes: shading ahead of now, a dotted line and a label every 6 local hours.
 */
function timeAxis(p, top, bottom, timeZone, now) {
  const parts = [];
  if (isNumber(now) && now < p.to) {
    const x = p.x(now);
    parts.push(`<rect x="${x.toFixed(1)}" y="${top}" width="${(WIDTH - RIGHT - x).toFixed(1)}" height="${bottom - top}" fill="${COLOR.ahead}"/>`);
  }
  for (let ms = p.from; ms <= p.to; ms += HOUR_MS) {
    const hour = ms === p.to ? 24 : localHour(timeZone, ms);
    if (hour % 6 !== 0) continue;
    const x = p.x(ms);
    if (hour % 24 !== 0) parts.push(vline(x, top, bottom, COLOR.grid, 'stroke-width="1" stroke-dasharray="2 4"'));
    parts.push(text(x, HEIGHT - 12, String(hour).padStart(2, '0'), { anchor: 'middle' }));
  }
  return parts.join('');
}

function nowMarker(p, top, bottom, now) {
  if (!isNumber(now) || now < p.from || now > p.to) return '';
  return vline(p.x(now), top - 8, bottom, COLOR.now, 'stroke-width="2"');
}

/**
 * @description Line through points, broken at unknown values; step = hold each value to the next point.
 */
function line(p, points, { color, width = 3, step = false, dash = null }) {
  const runs = [];
  let run = [];
  points.forEach((point, i) => {
    if (!isNumber(point.value)) {
      if (run.length) runs.push(run);
      run = [];
      return;
    }
    const x = p.x(point.time);
    const y = p.yAt(point.value);
    if (step && run.length) run.push([x, run[run.length - 1][1]]);
    run.push([x, y]);
    const next = points[i + 1];
    if (step && (!next || !isNumber(next.value))) run.push([p.x(point.end || point.time + QUARTER_MS), y]);
  });
  if (run.length) runs.push(run);
  const attributes = `fill="none" stroke="${color}" stroke-width="${width}" stroke-linejoin="round" stroke-linecap="round"${dash ? ` stroke-dasharray="${dash}"` : ''}`;
  const d = (r) => `M${r.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join('L')}`;
  return runs
    .filter((r) => r.length > 1)
    .map((r) => `<path d="${d(r)}" ${attributes}/>`)
    .join('');
}

/**
 * @description Filled band between low and high; slots with the same band are joined into one rectangle.
 */
function band(p, points, opacity = 1) {
  const spans = [];
  for (const point of points) {
    if (!isNumber(point.low) || !isNumber(point.high)) continue;
    const end = point.end || point.time + QUARTER_MS;
    const last = spans[spans.length - 1];
    if (last && last.end === point.time && last.low === point.low && last.high === point.high) last.end = end;
    else spans.push({ time: point.time, end, low: point.low, high: point.high });
  }
  return spans
    .map((span) => {
      const x1 = p.x(span.time);
      const y1 = p.yAt(span.high);
      const height = Math.max(0, p.yAt(span.low) - y1);
      return `<rect x="${x1.toFixed(1)}" y="${y1.toFixed(1)}" width="${(p.x(span.end) - x1).toFixed(1)}" height="${height.toFixed(1)}" fill="${COLOR.band}" opacity="${opacity}"/>`;
    })
    .join('');
}

/**
 * @description One bar per slot from the zero line: a 2 px gap and rounded top when the bars are wide enough, else
 * touching bars.
 */
function bars(p, points, color) {
  const base = p.yAt(Math.max(p.y.min, 0));
  return points
    .filter((point) => isNumber(point.value) && point.value !== 0)
    .map((point) => {
      const left = p.x(point.time);
      const right = p.x(point.end || point.time + QUARTER_MS);
      const gap = right - left >= 6 ? 1 : 0;
      const width = Math.max(0.5, right - left - 2 * gap + (gap ? 0 : 0.3));
      const y = p.yAt(point.value);
      const top = Math.min(y, base);
      const height = Math.abs(base - y);
      const r = gap ? Math.min(2, width / 2, height) : 0;
      const fill = typeof color === 'function' ? color(point) : color;
      return `<rect x="${(left + gap).toFixed(1)}" y="${top.toFixed(1)}" width="${width.toFixed(1)}" height="${height.toFixed(1)}" rx="${r.toFixed(1)}" fill="${fill}"/>`;
    })
    .join('');
}

/**
 * @description A thin strip with the expensive slots, labelled on the left.
 */
function strip(p, top, slots, label) {
  const parts = [text(LEFT - 10, top + STRIP - 1, label, { size: 18, anchor: 'end' })];
  // Only the slots with a known price: the rest of the day stays empty.
  for (const slot of slots) {
    const x1 = p.x(slot.time);
    parts.push(`<rect x="${x1.toFixed(1)}" y="${top}" width="${(p.x(slot.end) - x1 + 0.3).toFixed(1)}" height="${STRIP}" fill="${slot.expensive ? COLOR.expensive : COLOR.cheap}"/>`);
  }
  return parts.join('');
}

/**
 * @description The unit of a y axis, above its top label: left or right.
 */
function axisTitle(p, unit, side = 'left') {
  return side === 'left' ? text(LEFT - 10, p.top - 16, unit, { size: 18, anchor: 'end' }) : text(WIDTH - RIGHT + 10, p.top - 16, unit, { size: 18 });
}

/**
 * @description Headline (big), an optional line under it, and the legend in one row under them:
 * [{ label, color, kind: 'line' | 'dash' | 'block' }].
 */
function header(headline, legend = [], sub = '') {
  const parts = [text(LEFT - 48, 48, headline, { size: 40, color: COLOR.text, weight: 600 })];
  if (sub) parts.push(text(LEFT - 48, 82, sub));
  let x = LEFT - 48;
  for (const item of legend) {
    const y = 118;
    if (item.kind === 'block') parts.push(`<rect x="${x.toFixed(1)}" y="${y - 14}" width="18" height="16" rx="3" fill="${item.color}"/>`);
    else {
      const dash = item.kind === 'dash' ? ' stroke-dasharray="6 5"' : '';
      parts.push(`<line x1="${x.toFixed(1)}" y1="${y - 6}" x2="${(x + 22).toFixed(1)}" y2="${y - 6}" stroke="${item.color}" stroke-width="4"${dash}/>`);
    }
    parts.push(text(x + 30, y, item.label, { size: 20 }));
    x += 30 + item.label.length * 11 + 26;
  }
  return parts.join('');
}

function svg(body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}"><rect width="${WIDTH}" height="${HEIGHT}" fill="${COLOR.surface}"/>${body}</svg>`;
}

/**
 * @description A day with nothing to show: the headline and a message.
 */
function empty(headline, message) {
  return svg(header(headline) + text(WIDTH / 2, HEIGHT / 2, message, { size: 24, anchor: 'middle' }));
}

/**
 * @description Average kW over each slot from its Wh.
 */
function kW(points) {
  return points.map((point) => ({ time: point.time, end: point.end, value: isNumber(point.energy) ? point.energy / 1000 / ((point.end - point.time) / HOUR_MS) : null }));
}

/**
 * @description One day: a main pane, temperature (zone) or prices (controller), with a second measure on the right axis,
 * an optional heating pane under it and an optional strip of expensive slots, on one time axis.
 * @param {Object} opts
 * @param {Object} opts.day - { start, end } of the local day
 * @param {string} opts.timeZone
 * @param {number|null} opts.now - Marker and shading when inside the day
 * @param {string} opts.headline
 * @param {string} opts.sub - Line under the headline ('' for none)
 * @param {boolean} opts.imperial - Temperatures in °F
 * @param {Object} [opts.temperature] - { points: [{ time, end, temperature, target, low, high }], expected: [{ time, end,
 *   target, low, high }] }: zone pane (left axis), heating power as faded bars on its right axis
 * @param {Array} [opts.prices] - [{ time, end, price, expensive }]: price pane (bars, left axis) when no temperature
 * @param {Array} [opts.outdoor] - [{ time, end, outdoor }]: line on the price pane's right axis
 * @param {Array} [opts.energy] - [{ time, end, energy }]: heating power; on the zone pane's right axis, else a pane below
 * @param {Array} [opts.strip] - [{ time, end, expensive }]: strip of expensive slots, left out when no slot is known
 * @param {Object} opts.labels - { temperature, target, expected, band, energy, price, expensive, outdoor, noData }
 * @param {string} opts.currency
 */
function day({
  day: d,
  timeZone,
  now = null,
  headline,
  sub = '',
  imperial = false,
  temperature = null,
  prices = null,
  outdoor = null,
  energy = null,
  strip: stripSlots = null,
  labels,
  currency = '€'
}) {
  const unit = `°${imperial ? 'F' : 'C'}`;
  const conv = (value) => degrees(value, imperial);
  const zonePoints = temperature ? inDay(temperature.points, d) : [];
  const expected = temperature ? inDay(temperature.expected, d) : [];
  const tempValues = [...zonePoints, ...expected].flatMap((point) => [point.temperature, point.target, point.low, point.high]).map(conv);
  const priceSlots = inDay(prices, d);
  const outdoorPoints = inDay(outdoor, d).map((point) => ({ time: point.time, end: point.end, value: conv(point.outdoor) }));
  const power = kW(inDay(energy, d).filter((point) => isNumber(point.energy)));
  const stripSlotsIn = inDay(stripSlots, d).filter((slot) => typeof slot.expensive === 'boolean');

  const main = temperature ? tempValues.some(isNumber) : priceSlots.some((point) => isNumber(point.price));
  // The zone's heating goes on the right axis; the controller's (all zones) in a pane of its own.
  const powerBelow = !temperature && power.length > 0;
  if (!main && !power.length) return empty(headline, labels.noData);

  const bottomEdge = HEIGHT - BOTTOM - (stripSlotsIn.length ? STRIP + 16 : 0);
  const mainBottom = main && powerBelow ? TOP + ((bottomEdge - TOP - PANE_GAP) * 2) / 3 : bottomEdge;
  const parts = [];
  const legend = [];
  const kWLabel = (p) => (v) => (p.y.max < 2 ? v.toFixed(1) : String(v));
  let first = null;
  let last = null;

  if (temperature && main) {
    const p = pane({ day: d, top: TOP, bottom: mainBottom, y: range(tempValues, { pad: imperial ? 0.5 : 0.3, minSpan: imperial ? 4 : 2 }) });
    const map = (list, key) => list.map((point) => ({ time: point.time, end: point.end, value: conv(point[key]) }));
    const bandOf = (list) => list.map((point) => ({ time: point.time, end: point.end, low: conv(point.low), high: conv(point.high) }));
    parts.push(
      band(p, bandOf(zonePoints)),
      band(p, bandOf(expected), 0.5),
      grid(p, (v) => String(v)),
      axisTitle(p, unit)
    );
    if (power.length) {
      const y2 = alignedRange(
        power.map((point) => point.value),
        p.y.ticks.length,
        { zero: true, minSpan: 0.5 }
      );
      const right = { ...p, y: y2, yAt: (value) => p.bottom - ((value - y2.min) / (y2.max - y2.min)) * (p.bottom - p.top) };
      parts.push(`<g opacity="0.55">${bars(right, power, COLOR.energy)}</g>`, rightLabels(p, y2, kWLabel(right)), axisTitle(p, 'kW', 'right'));
    }
    parts.push(line(p, map(zonePoints, 'target'), { color: COLOR.target, step: true }));
    parts.push(line(p, map(expected, 'target'), { color: COLOR.target, step: true, dash: '6 5' }));
    parts.push(line(p, map(zonePoints, 'temperature'), { color: COLOR.temperature, width: 4 }));
    if (zonePoints.some((point) => isNumber(point.temperature))) legend.push({ label: labels.temperature, color: COLOR.temperature });
    if (zonePoints.some((point) => isNumber(point.target))) legend.push({ label: labels.target, color: COLOR.target });
    if (expected.some((point) => isNumber(point.target))) legend.push({ label: labels.expected, color: COLOR.target, kind: 'dash' });
    if (power.length) legend.push({ label: labels.energy, color: COLOR.energy, kind: 'block' });
    legend.push({ label: labels.band, color: COLOR.band, kind: 'block' });
    first = p;
    last = p;
  } else if (main) {
    const p = pane({
      day: d,
      top: TOP,
      bottom: mainBottom,
      y: range(
        priceSlots.map((point) => point.price),
        { zero: true, minSpan: 0.05 }
      )
    });
    const values = priceSlots.map((point) => ({ ...point, value: point.price }));
    parts.push(
      grid(p, (v) => v.toFixed(2)),
      axisTitle(p, `${currency}/kWh`),
      bars(p, values, (point) => (point.expensive ? COLOR.expensive : COLOR.price))
    );
    legend.push({ label: labels.price, color: COLOR.price, kind: 'block' });
    if (priceSlots.some((point) => point.expensive)) legend.push({ label: labels.expensive, color: COLOR.expensive, kind: 'block' });
    if (outdoorPoints.some((point) => isNumber(point.value))) {
      const y2 = alignedRange(
        outdoorPoints.map((point) => point.value),
        p.y.ticks.length,
        { pad: 0.5, minSpan: imperial ? 4 : 2 }
      );
      const right = { ...p, y: y2, yAt: (value) => p.bottom - ((value - y2.min) / (y2.max - y2.min)) * (p.bottom - p.top) };
      // A surface-coloured casing keeps the line readable over the bars.
      parts.push(line(right, outdoorPoints, { color: COLOR.surface, width: 8 }), line(right, outdoorPoints, { color: COLOR.outdoor, width: 4 }));
      parts.push(
        rightLabels(p, y2, (v) => String(v)),
        axisTitle(p, unit, 'right')
      );
      legend.push({ label: labels.outdoor, color: COLOR.outdoor });
    }
    first = p;
    last = p;
  }

  if (powerBelow) {
    const top = main ? mainBottom + PANE_GAP : TOP;
    const p = pane({
      day: d,
      top,
      bottom: bottomEdge,
      y: range(
        power.map((point) => point.value),
        { zero: true, minSpan: 0.5, count: 2 }
      )
    });
    parts.push(grid(p, kWLabel(p)), axisTitle(p, 'kW'), bars(p, power, COLOR.energy));
    legend.push({ label: labels.energy, color: COLOR.energy, kind: 'block' });
    first = first || p;
    last = p;
  }

  if (stripSlotsIn.length) {
    parts.push(strip(last, bottomEdge + 12, stripSlotsIn, currency));
    if (!legend.some((item) => item.color === COLOR.expensive)) legend.push({ label: labels.expensive, color: COLOR.expensive, kind: 'block' });
  }

  const axisBottom = stripSlotsIn.length ? bottomEdge + 12 + STRIP : last.bottom;
  return svg([timeAxis(first, first.top, axisBottom, timeZone, now), ...parts, nowMarker(first, first.top, last.bottom, now), header(headline, legend, sub)].join(''));
}

module.exports = {
  WIDTH,
  HEIGHT,
  COLOR,
  FONT,
  ticks,
  range,
  alignedRange,
  degrees,
  formatDegrees,
  localHour,
  day
};

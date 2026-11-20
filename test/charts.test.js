'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const charts = require('../lib/charts');
const views = require('../lib/views');
const images = require('../lib/images');
const en = require('../locales/en.json');

const TZ = 'Europe/Helsinki';
const HOUR = 60 * 60 * 1000;
const Q = 15 * 60 * 1000;
// 2026-11-20 14:10 local (UTC+2).
const NOW = Date.UTC(2026, 10, 20, 12, 10);
const labels = views.labels((key) => key.split('.').reduce((node, part) => node && node[part], en));

function priceDays(fn = () => 0.05) {
  const result = {};
  for (const date of ['2026-11-19', '2026-11-20', '2026-11-21']) result[date] = { resolution: 15, values: Array.from({ length: 96 }, (_, q) => fn(q, date)) };
  return result;
}

function common(days = priceDays()) {
  return {
    timeZone: TZ,
    now: NOW,
    imperial: false,
    labels,
    currency: '€',
    days: views.days(TZ, NOW),
    slots: views.priceSlots({ days, timeZone: TZ, resolution: 15, model: 'rate_is_highest', pct: 30, minDelta: 0.01 }, NOW)
  };
}

/**
 * @description A canvas 2D stand-in that records the calls.
 */
function recorder() {
  const calls = [];
  const ctx = { calls };
  for (const name of ['fillRect', 'beginPath', 'moveTo', 'lineTo', 'stroke', 'fill', 'closePath', 'fillText']) ctx[name] = (...args) => calls.push([name, ...args]);
  ctx.measureText = (content) => ({ width: String(content).length * 9 });
  return ctx;
}

test('ticks and ranges are round and cover the values', () => {
  assert.deepStrictEqual(charts.ticks(19.5, 21.5, 4), [19.5, 20, 20.5, 21, 21.5]);
  const r = charts.range([19.3, 21.6], { pad: 0.5, minSpan: 2 });
  assert.ok(r.min <= 18.8 && r.max >= 22.1);
  assert.strictEqual(charts.range([], { minSpan: 2 }).max, 2);
  // Prices keep zero; a right axis gets as many ticks as the left one.
  assert.strictEqual(charts.range([0.04, 0.15], { zero: true }).min, 0);
  const aligned = charts.alignedRange([-7.5, -2.1], 5);
  assert.strictEqual(aligned.ticks.length, 5);
  assert.ok(aligned.min <= -7.5 && aligned.max >= -2.1);
});

test('step lines join touching slots and break at gaps and unknown values', () => {
  const lines = charts.stepLines([
    { time: 0, end: 10, value: 1 },
    { time: 10, end: 20, value: 1 },
    { time: 20, end: 30, value: 2 },
    { time: 30, end: 40, value: null },
    { time: 50, end: 60, value: 3 }
  ]);
  assert.strictEqual(lines.length, 2);
  // Repeated points are left out: pureimage can't stroke a zero-length segment.
  assert.deepStrictEqual(lines[0], [
    { time: 0, value: 1 },
    { time: 20, value: 1 },
    { time: 20, value: 2 },
    { time: 30, value: 2 }
  ]);
});

test('lines break at gaps longer than 20 minutes', () => {
  const lines = charts.lineParts([
    { time: 0, value: 1 },
    { time: Q, value: 2 },
    { time: 3 * Q, value: 3 },
    { time: 4 * Q, value: 4 }
  ]);
  assert.strictEqual(lines.length, 2);
});

test('dashes alternate along the line', () => {
  const parts = charts.dashes(
    [
      [0, 0],
      [34, 0]
    ],
    10,
    7
  );
  assert.deepStrictEqual(
    parts.map(([x1, , x2]) => [Math.round(x1), Math.round(x2)]),
    [
      [0, 10],
      [17, 27]
    ]
  );
});

test('price slots carry the price model decision', () => {
  // A single high quarter at 18:00 local: a peak for rate is highest.
  const { slots } = common(priceDays((q, date) => (date === '2026-11-20' && q === 72 ? 0.3 : 0.05)));
  assert.strictEqual(slots.length, 3 * 96);
  const peak = slots.find((slot) => slot.price === 0.3);
  assert.strictEqual(peak.expensive, true);
  assert.strictEqual(slots.filter((slot) => slot.expensive).length, 1);
  // Unknown prices are null and never expensive.
  const missing = common({}).slots;
  assert.ok(missing.every((slot) => slot.price === null && !slot.expensive));
});

test('zone images: history today, the expected target ahead, eco time tomorrow', () => {
  const c = common(priceDays((q, date) => (date === '2026-11-21' && q >= 32 && q < 34 ? 0.3 : 0.05)));
  const rows = [];
  for (let time = c.days.today.start; time + Q <= NOW; time += Q) rows.push({ time, temperature: 21, target: 21.5, low: 19.5, high: 21.5 });
  const input = {
    shared: { occupancy: 'present', season: 'heating', longAbsence: false, expensive: false },
    source: 'live',
    zone: { mode: 'auto', heat: 21.5, eco: 19.5, occupancyRule: 'follows', pricePeak: 'eco' },
    temperature: 21
  };
  const [today, tomorrow] = views.zoneViews(c, { rows, temperature: 21.2, target: 21.5, input });
  assert.strictEqual(today.id, 'today');
  assert.strictEqual(today.spec.headline, '21.2 °C · target 21.5 °C');
  const [band, past, ahead, measured] = today.spec.series;
  assert.strictEqual(band.type, 'band');
  assert.ok(past.slots.every((slot) => slot.end <= NOW));
  assert.ok(ahead.dashed && ahead.slots[0].time === NOW);
  assert.strictEqual(measured.points[measured.points.length - 1].time, NOW);
  // Tomorrow: a 30-minute peak at 08:00 is eco.
  assert.strictEqual(tomorrow.spec.headline, 'Eco 0:30 h');
  assert.strictEqual(tomorrow.spec.empty, null);
  assert.ok(tomorrow.spec.strip.slots.some((slot) => slot.color === charts.COLOR.peak));
});

test('tomorrow without prices says so', () => {
  const days = priceDays();
  delete days['2026-11-21'];
  const [, tomorrow] = views.zoneViews(common(days), { rows: [], temperature: 21, target: 21, input: null });
  assert.strictEqual(tomorrow.spec.empty, 'Prices not known yet');
  const [, controller] = views.controllerViews(common(days), { rows: [], outdoor: null, forecast: null });
  assert.strictEqual(controller.spec.empty, 'Prices not known yet');
});

test('controller images: price now, outdoor and the forecast low', () => {
  const forecast = [];
  for (let ms = NOW - HOUR; ms < NOW + 40 * HOUR; ms += HOUR) forecast.push([ms, ms > Date.UTC(2026, 10, 21, 3) && ms < Date.UTC(2026, 10, 21, 5) ? -9.4 : -3]);
  const [today, tomorrow] = views.controllerViews(common(), { rows: [], outdoor: -2.5, forecast });
  assert.strictEqual(today.spec.headline, 'Now 0.05 €/kWh · outdoor −2.5 °C');
  assert.strictEqual(tomorrow.spec.headline, 'Average 0.05 €/kWh · low −9.4 °C');
  // The forecast ahead starts from the reading now.
  const ahead = today.spec.series.find((series) => series.dashed);
  assert.deepStrictEqual(ahead.points[0], { time: NOW, value: -2.5 });
});

test('water images: heating log, plan and ready times', () => {
  const c = common();
  const log = [{ time: c.days.today.start, temperature: 36, heating: true }];
  const plan = [
    { time: NOW - (NOW % Q), heat: false, temperature: 36.4 },
    { time: NOW - (NOW % Q) + Q, heat: true, temperature: 36.4 }
  ];
  const uses = [{ start: c.days.today.start + 20 * HOUR, end: c.days.today.start + 22 * HOUR }];
  const [today, tomorrow] = views.waterViews(c, { log, temperature: 36.5, heatingNow: false, plan, block: null, uses, ready: 38 });
  assert.strictEqual(today.spec.headline, '36.5 °C · Ready 38.0 °C at 20:00');
  assert.deepStrictEqual(
    today.spec.strip.slots.map((slot) => slot.time),
    [c.days.today.start, NOW - (NOW % Q) + Q]
  );
  assert.strictEqual(today.spec.spans.length, 1);
  assert.strictEqual(tomorrow.spec.headline, 'No ready time');
});

test('draw: a spec becomes canvas calls, the empty text in the middle', () => {
  const [, tomorrow] = views.zoneViews(common({}), { rows: [], temperature: 21, target: 21, input: null });
  const ctx = recorder();
  charts.draw(ctx, tomorrow.spec);
  const texts = ctx.calls.filter(([name]) => name === 'fillText').map(([, content]) => content);
  assert.ok(texts.includes('Prices not known yet'));
  assert.ok(texts.includes('00') && texts.includes('24'));
});

test('render: a PNG of the chart size', () => {
  const [today] = views.zoneViews(common(), { rows: [], temperature: 21, target: 21, input: null });
  const png = images.render(today.spec);
  assert.strictEqual(png.toString('ascii', 1, 4), 'PNG');
  assert.strictEqual(png.readUInt32BE(16), charts.WIDTH);
  assert.strictEqual(png.readUInt32BE(20), charts.HEIGHT);
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const charts = require('../lib/charts');
const views = require('../lib/views');
const { toPng } = require('../lib/images');

const TZ = 'Europe/Helsinki';
const START = Date.parse('2026-11-01T00:00:00+02:00');
const QUARTER = 15 * 60 * 1000;
const labels = views.labels((key) => key);

function rows(count, zone = {}) {
  return Array.from({ length: count }, (_, i) => ({
    quarter: START + i * QUARTER,
    outdoor: 5 - i / 20,
    price: i % 7 === 0 ? null : 0.05 + (i % 10) / 100,
    expensive: i % 10 === 9,
    zones: [{ slot: 2, temperature: 20 + Math.sin(i / 8), target: i % 20 < 4 ? 18 : 21, low: 18, high: 21, energy: i % 3 ? 120 : 0, ...zone }]
  }));
}

function numbersOf(svg) {
  return [...svg.matchAll(/ (?:x|y|x1|y1|x2|y2|width|height)="([^"]*)"/g)].map((m) => m[1]);
}

test('ticks are round and cover the range', () => {
  assert.deepStrictEqual(charts.ticks(18, 21.6), [18, 19, 20, 21, 22]);
  assert.deepStrictEqual(charts.ticks(0, 0.137), [0, 0.05, 0.1, 0.15]);
  const t = charts.ticks(-3.2, 7.9);
  assert.ok(t[0] <= -3.2 && t[t.length - 1] >= 7.9);
});

test('range widens a flat series and keeps zero for bars', () => {
  const flat = charts.range([20, 20, null], { minSpan: 2 });
  assert.ok(flat.max - flat.min >= 2);
  assert.strictEqual(charts.range([0.4, 1.3], { zero: true }).min, 0);
});

function fixture(count, nowQuarter) {
  const data = rows(count);
  const now = START + nowQuarter * QUARTER;
  const slots = views.priceSlots({ days: views.daysFromHistory(data, TZ), timeZone: TZ, now, model: 'rate_is_highest', minDelta: 0.01 });
  const input = { shared: { occupancy: 'present', season: 'heating' }, zone: { mode: 'auto', heat: 21, eco: 18, occupancyRule: 'follows' }, temperature: 20 };
  return { rows: data.filter((row) => row.quarter < now), slots, expected: views.expectedTargets({ input, slots, now }), now, timeZone: TZ, currency: '€', labels };
}

test('every day view draws finite coordinates with gaps and unknown values', () => {
  // Now at 06:00 on the second day: yesterday full, today partial, tomorrow's prices partly known.
  const opts = fixture(96 * 2 + 40, 96 + 24);
  for (const which of views.DAYS) {
    for (const svg of [views.zoneDay(which, { ...opts, slot: 2 }), views.controllerDay(which, opts)]) {
      assert.ok(svg.startsWith('<svg'));
      for (const value of numbersOf(svg)) assert.ok(Number.isFinite(Number(value)), `${which}: not finite: ${value}`);
    }
  }
});

test('temperatures shown in °F when imperial', () => {
  const svg = views.zoneDay('today', { ...fixture(8, 8), slot: 2, imperial: true });
  assert.match(svg, /°F/);
  assert.doesNotMatch(svg, /°C/);
});

test('no data gives a message; tomorrow without prices says so', () => {
  const opts = fixture(8, 8);
  const blank = rows(8, { temperature: null, target: null, low: null, high: null, energy: null });
  assert.match(views.zoneDay('today', { ...opts, rows: blank, slot: 2 }), /chart\.no_data/);
  assert.match(views.zoneDay('tomorrow', { ...opts, slot: 2 }), /chart\.no_prices/);
  assert.match(views.controllerDay('tomorrow', opts), /chart\.no_prices/);
});

test('hour labels follow the local time zone', () => {
  assert.strictEqual(charts.localHour(TZ, START), 0);
  assert.strictEqual(charts.localHour('UTC', START), 22);
});

test('days are local days, 25 h on the DST change', () => {
  const now = Date.parse('2026-10-26T12:00:00+02:00');
  const yesterday = views.dayOf(TZ, now, 'yesterday');
  assert.strictEqual(yesterday.date, '2026-10-25');
  assert.strictEqual(yesterday.end - yesterday.start, 25 * 3600000);
  assert.strictEqual(views.dayOf(TZ, now, 'today').start, yesterday.end);
  assert.strictEqual(views.dayOf(TZ, now, 'tomorrow').date, '2026-10-27');
});

test('right axis shares the left gridlines with round steps', () => {
  assert.deepStrictEqual(charts.alignedRange([0.2, 1.3], 4, { zero: true }).ticks, [0, 0.5, 1, 1.5]);
  const outdoor = charts.alignedRange([-3.4, 2.1], 5);
  assert.strictEqual(outdoor.ticks.length, 5);
  assert.ok(outdoor.min <= -3.4 && outdoor.max >= 2.1);
});

test('price slots: expensive by the model, tomorrow unknown until imported', () => {
  const now = Date.parse('2026-11-01T12:05:00+02:00');
  const values = Array.from({ length: 96 }, (_, i) => (i === 50 ? 0.5 : 0.1));
  const slots = views.priceSlots({ days: { '2026-11-01': { resolution: 15, values } }, timeZone: TZ, now, model: 'rate_is_highest', minDelta: 0.01 });
  const today = slots.filter((slot) => slot.time >= START && slot.time < START + 96 * QUARTER);
  assert.strictEqual(today.length, 96);
  assert.deepStrictEqual(
    today.filter((slot) => slot.expensive).map((slot) => (slot.time - START) / QUARTER),
    [50]
  );
  assert.ok(slots.filter((slot) => slot.time >= START + 96 * QUARTER).every((slot) => slot.price === null));
  assert.match(views.controllerDay('today', { rows: [], slots, now, timeZone: TZ, labels }), new RegExp(charts.COLOR.expensive));
});

test('expected target: eco at the expensive slots ahead, only as far as prices are known', () => {
  const now = Date.parse('2026-11-01T12:05:00+02:00');
  const values = Array.from({ length: 60 }, (_, i) => (i === 50 ? 0.5 : 0.1));
  const slots = views.priceSlots({ days: { '2026-11-01': { resolution: 15, values } }, timeZone: TZ, now, model: 'rate_is_highest', minDelta: 0.01 });
  const input = { shared: { occupancy: 'present', season: 'heating' }, zone: { mode: 'auto', heat: 21, eco: 18, occupancyRule: 'follows', pricePeak: 'eco' }, temperature: 20 };
  const expected = views.expectedTargets({ input, slots, now });
  assert.strictEqual(expected[0].time, now);
  assert.strictEqual(expected[expected.length - 1].end, START + 60 * QUARTER);
  assert.deepStrictEqual(
    expected.filter((e) => e.target === 18).map((e) => (e.time - START) / QUARTER),
    [50]
  );
  const away = views.expectedTargets({ input: { ...input, shared: { ...input.shared, occupancy: 'away' } }, slots, now });
  assert.ok(away.every((e) => e.target === 18));
});

test('renders a 1280 × 960 PNG offline', async () => {
  const png = await toPng(views.zoneDay('today', { ...fixture(20, 20), slot: 2 }));
  assert.strictEqual(png.toString('ascii', 1, 4), 'PNG');
  assert.strictEqual(png.readUInt32BE(16), 1280);
  assert.strictEqual(png.readUInt32BE(20), 960);
});

test('hour labels on DST days: real time on the axis, 25 h and 23 h days, half-hour offsets', () => {
  const cases = [
    ['Europe/Helsinki', '2026-10-25T12:00:00+02:00', 25],
    ['Europe/Helsinki', '2026-03-29T12:00:00+03:00', 23],
    ['America/St_Johns', '2026-11-01T12:00:00-03:30', 25],
    ['Asia/Kolkata', '2026-11-01T12:00:00+05:30', 24],
    // Clocks jump 00:00 → 01:00: the day starts at 01:00, so its first label is 06.
    ['America/Santiago', '2026-09-06T12:00:00-03:00', 23]
  ];
  for (const [timeZone, iso, hours] of cases) {
    const now = Date.parse(iso);
    const d = views.dayOf(timeZone, now, 'today');
    assert.strictEqual((d.end - d.start) / 3600000, hours, `${timeZone} ${iso}`);
    const data = [];
    for (let t = d.start; t < d.end; t += QUARTER) data.push({ quarter: t, outdoor: 1, price: 0.1, zones: [{ slot: 0, temperature: 20, target: 21, low: 19, high: 21, energy: 100 }] });
    const svg = views.zoneDay('today', { rows: data, slot: 0, now: d.end - 1, timeZone, labels });
    const found = [...svg.matchAll(/<text x="([\d.]+)" y="588.0"[^>]*>(\d\d)<\/text>/g)].map((m) => [m[2], Number(m[1])]);
    const labelAt = Object.fromEntries(found);
    const skipped = timeZone === 'America/Santiago';
    assert.deepStrictEqual(
      found.map(([hour]) => hour),
      skipped ? ['06', '12', '18', '24'] : ['00', '06', '12', '18', '24'],
      timeZone
    );
    if (skipped) continue;
    // Local 06:00 is 7 h into a 25 h day, 5 h into a 23 h day.
    const into = { 25: 7, 23: 5, 24: 6 }[hours];
    assert.ok(Math.abs(labelAt['06'] - (labelAt['00'] + ((labelAt['24'] - labelAt['00']) * into) / hours)) < 0.2, `${timeZone} 06 at ${labelAt['06']}`);
  }
});

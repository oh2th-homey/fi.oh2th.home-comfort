'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { midnight } = require('oh2th-homey-helpers');
const prices = require('../lib/prices');

const TZ = 'Europe/Helsinki';

// Fixtures from the author's HomeyScripts test/simulate-rate-isHighest.mjs (public market prices),
// expected results from running the original rate-isHighest-of-the-hour.js on them.
const DST_AUTUMN = [
  0.0064, 0.006, 0.0055, 0.0047, 0.0058, 0.0054, 0.0051, 0.0043, 0.0053, 0.0046, 0.0034, 0.0031, 0.0025, 0.002, 0.0019, 0.0017, 0.0025, 0.0022, 0.0019, 0.0019, 0.0019, 0.0018, 0.0017, 0.0015,
  0.0015, 0.0015, 0.0013, 0.0013, 0.0013, 0.0013, 0.0013, 0.0014, 0.0014, 0.0014, 0.0015, 0.0015, 0.0016, 0.0016, 0.0016, 0.0015, 0.0016, 0.0016, 0.0016, 0.0013, 0.0013, 0.0013, 0.0015, 0.0015,
  0.0017, 0.0016, 0.0019, 0.0019, 0.0019, 0.0019, 0.0019, 0.0019, 0.0021, 0.0022, 0.0025, 0.0025, 0.0025, 0.0025, 0.0032, 0.0041, 0.0038, 0.0043, 0.0047, 0.005, 0.0049, 0.0054, 0.0045, 0.0047,
  0.0045, 0.0047, 0.0043, 0.0045, 0.0045, 0.0046, 0.0045, 0.0045, 0.0049, 0.0046, 0.0044, 0.0043, 0.0043, 0.0043, 0.004, 0.0037, 0.0031, 0.0032, 0.0027, 0.0025, 0.0034, 0.0033, 0.0031, 0.0028,
  0.0025, 0.0024, 0.0024, 0.002
];
const NORMAL = Array.from({ length: 96 }, (_, i) => {
  if (i === 32 || i === 33) return 0.12;
  return i >= 72 && i < 76 ? 0.052 : 0.05;
});
const DST_SPRING = Array.from({ length: 92 }, (_, i) => (i === 28 ? 0.12 : 0.05));
// Synthetic day: sine base with single spikes, a 2-quarter spike and a 3-quarter block (60–62, not a peak).
const SPIKES = Array.from({ length: 96 }, (_, i) => {
  const base = 0.06 + 0.03 * Math.sin((i / 96) * 2 * Math.PI - 1.2);
  const spike = [13, 30, 31, 47, 60, 61, 62, 80].includes(i) ? 0.05 : 0;
  return Math.round((base + spike) * 10000) / 10000;
});

function flagged(date, values) {
  const days = { [date]: { resolution: 15, values } };
  const { start } = prices.dayInfo(TZ, date, 15);
  const result = [];
  for (let q = 0; q < values.length; q++) {
    const now = start + q * 900000 + 60000;
    if (prices.evaluate({ days, timeZone: TZ, now, resolution: 15, model: 'rate_is_highest' }).expensive) result.push(q);
  }
  return result;
}

test('day length follows DST', () => {
  assert.strictEqual(prices.dayInfo(TZ, '2026-10-25', 15).slots, 100);
  assert.strictEqual(prices.dayInfo(TZ, '2027-03-28', 15).slots, 92);
  assert.strictEqual(prices.dayInfo(TZ, '2026-11-10', 15).slots, 96);
  assert.strictEqual(prices.dayInfo(TZ, '2026-10-25', 60).slots, 25);
  assert.strictEqual(prices.dayInfo('Europe/Amsterdam', '2026-10-25', 15).slots, 100);
  assert.strictEqual(prices.dayInfo('UTC', '2026-10-25', 15).slots, 96);
});

test('local midnight is a real instant', () => {
  assert.strictEqual(new Date(midnight(TZ, '2026-11-10')).toISOString(), '2026-11-09T22:00:00.000Z');
  assert.strictEqual(new Date(midnight(TZ, '2026-07-01')).toISOString(), '2026-06-30T21:00:00.000Z');
  assert.strictEqual(new Date(midnight('Europe/Amsterdam', '2026-10-25')).toISOString(), '2026-10-24T22:00:00.000Z');
});

test('rate is highest matches the original script', () => {
  assert.deepStrictEqual(flagged('2026-10-25', DST_AUTUMN), []);
  assert.deepStrictEqual(flagged('2026-11-10', NORMAL), [32, 33]);
  assert.deepStrictEqual(flagged('2027-03-28', DST_SPRING), [28]);
  assert.deepStrictEqual(flagged('2026-11-10', SPIKES), [13, 30, 31, 47, 80]);
});

test('rate is highest counts a run of high quarters across the hour', () => {
  // Recorded night (anonymised): a flat 0.1882 stretch from :45 over the hour into the :15 before a drop was flagged at
  // the :15 when the run was counted inside the clock hour only.
  const values = Array(96).fill(0.15);
  values.fill(0.1882, 43, 47);
  values[47] = 0.1854;
  assert.deepStrictEqual(flagged('2026-11-10', values), []);
  // A real two-quarter spike over the hour boundary is still a peak.
  const spike = Array(96).fill(0.15);
  spike[43] = 0.19;
  spike[44] = 0.19;
  assert.deepStrictEqual(flagged('2026-11-10', spike), [43, 44]);
});

test('rate is highest ignores bumps below the minimum difference', () => {
  // Recorded night: 0.1563 between 0.1558 and 0.1544 was a peak with the old 0.005 default. The last quarter,
  // about 0.02 above its neighbours, still is.
  const values = [0.1529, 0.1497, 0.1491, 0.1558, 0.1563, 0.1544, 0.1571, 0.1464, 0.1505, 0.1512, 0.1512, 0.1512, 0.1305, 0.1295, 0.1129, 0.1304];
  const day = [...Array(40).fill(0.15), ...values, ...Array(40).fill(0.11)];
  assert.deepStrictEqual(flagged('2026-11-10', day), [55]);
});

test('rate is highest uses tomorrow across midnight', () => {
  const today = Array(96).fill(0.05);
  today[95] = 0.12;
  const days = { '2026-11-10': { resolution: 15, values: today } };
  const now = prices.dayInfo(TZ, '2026-11-10', 15).start + 95 * 900000 + 60000;
  assert.strictEqual(prices.evaluate({ days, timeZone: TZ, now }).expensive, true);
  days['2026-11-11'] = { resolution: 15, values: Array(96).fill(0.13) };
  // Tomorrow's higher prices are in the window and raise the threshold above the current price.
  assert.strictEqual(prices.evaluate({ days, timeZone: TZ, now }).expensive, false);
});

test('pruneDays keeps yesterday and later', () => {
  const days = { '2026-11-08': {}, '2026-11-09': {}, '2026-11-10': {}, '2026-11-11': {} };
  assert.deepStrictEqual(Object.keys(prices.pruneDays(days, '2026-11-10')), ['2026-11-09', '2026-11-10', '2026-11-11']);
});

test('dayStats over known values', () => {
  assert.deepStrictEqual(prices.dayStats([3, 1, 2, null]), { min: 1, max: 3, mean: 2, median: 2, count: 3 });
  assert.strictEqual(prices.dayStats([]), null);
});

test('above average needs pct and the minimum delta', () => {
  assert.strictEqual(prices.aboveAverage(0.14, 0.1, 30).expensive, true);
  assert.strictEqual(prices.aboveAverage(0.12, 0.1, 30).expensive, false);
  // Near-zero day: 0.003 is 3x the average but only 0.002 above it.
  assert.strictEqual(prices.aboveAverage(0.003, 0.001, 30).expensive, false);
  assert.strictEqual(prices.aboveAverage(-0.004, -0.02, 30).expensive, true);
});

test('evaluate: off, unknown, hourly fallback, until', () => {
  const now = prices.dayInfo(TZ, '2026-11-10', 15).start + 32 * 900000;
  const days = { '2026-11-10': { resolution: 15, values: NORMAL } };
  assert.deepStrictEqual(prices.evaluate({ days, timeZone: TZ, now, model: 'off' }).reasons, [{ code: 'off', args: {} }]);
  assert.strictEqual(prices.evaluate({ days: {}, timeZone: TZ, now }).reasons[0].code, 'unknown');
  assert.strictEqual(prices.evaluate({ days: {}, timeZone: TZ, now }).expensive, false);

  const r = prices.evaluate({ days, timeZone: TZ, now });
  assert.strictEqual(r.price, 0.12);
  assert.strictEqual(r.until, prices.dayInfo(TZ, '2026-11-11', 15).start);

  const hourly = { '2026-11-10': { resolution: 60, values: Array.from({ length: 24 }, (_, h) => (h === 8 ? 0.12 : 0.05)) } };
  const h = prices.evaluate({ days: hourly, timeZone: TZ, now, resolution: 60 });
  assert.strictEqual(h.model, 'above_average');
  assert.strictEqual(h.reasons[0].code, 'hourly_fallback');
  assert.strictEqual(h.expensive, true);

  // Stored with another resolution than the setting: unknown.
  assert.strictEqual(prices.evaluate({ days: hourly, timeZone: TZ, now, resolution: 15 }).price, null);
});

test('evaluate: over the price ceiling is always expensive, also with the model off', () => {
  const now = prices.dayInfo(TZ, '2026-11-10', 15).start + 32 * 900000;
  const days = { '2026-11-10': { resolution: 15, values: NORMAL } };
  // The price now is 0.12.
  const over = prices.evaluate({ days, timeZone: TZ, now, model: 'off', ceiling: 0.1 });
  assert.strictEqual(over.expensive, true);
  assert.deepStrictEqual(over.reasons[over.reasons.length - 1], { code: 'over_ceiling', args: { price: 0.12, ceiling: 0.1 } });
  assert.strictEqual(prices.evaluate({ days, timeZone: TZ, now, model: 'off', ceiling: 0.2 }).expensive, false);
  // 0: no ceiling.
  assert.strictEqual(prices.evaluate({ days, timeZone: TZ, now, model: 'off', ceiling: 0 }).expensive, false);
});

test('headline: one reason, the strongest first (issue #44)', () => {
  const r = (...reasons) => ({ reasons });
  const peak = { code: 'peak', args: { price: 0.28, threshold: 0.27 } };
  const notPeak = { code: 'not_peak', args: { price: 0.12, threshold: 0.2 } };
  const ceiling = { code: 'over_ceiling', args: { price: 0.28, ceiling: 0.15 } };
  const high = { code: 'over_high', args: { price: 0.12, high: 0.1 } };
  assert.deepStrictEqual(prices.headline(r(peak, ceiling)), ceiling);
  assert.deepStrictEqual(prices.headline(r(notPeak, ceiling)), ceiling);
  assert.deepStrictEqual(prices.headline(r(peak, high)), peak);
  assert.deepStrictEqual(prices.headline(r(notPeak, high)), high);
  assert.deepStrictEqual(prices.headline(r(notPeak)), notPeak);
  const average = { code: 'above_average', args: { threshold: 0.2 } };
  assert.deepStrictEqual(prices.headline(r({ code: 'hourly_fallback', args: { minutes: 60 } }, average)), average);
  assert.deepStrictEqual(prices.headline(r({ code: 'off', args: {} }, ceiling)), ceiling);
  assert.deepStrictEqual(prices.headline(r({ code: 'unknown', args: {} })), { code: 'unknown', args: {} });
  assert.strictEqual(prices.headline(r()).code, 'not_peak');
});

test('evaluate: price level normal, high (warning only) and expensive', () => {
  const now = prices.dayInfo(TZ, '2026-11-10', 15).start + 32 * 900000;
  const days = { '2026-11-10': { resolution: 15, values: NORMAL } };
  // The price now is 0.12.
  const level = (high, ceiling) => prices.evaluate({ days, timeZone: TZ, now, model: 'off', high, ceiling });
  assert.strictEqual(level(0, 0).level, 'normal');
  assert.strictEqual(level(0.1, 0.2).level, 'high');
  assert.strictEqual(level(0.1, 0.2).expensive, false);
  assert.strictEqual(level(0.05, 0.1).level, 'expensive');
  assert.strictEqual(level(0.05, 0.1).expensive, true);
});

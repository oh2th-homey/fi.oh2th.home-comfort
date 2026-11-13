'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { midnight } = require('oh2th-homey-helpers');
const prices = require('../lib/prices');

const TZ = 'Europe/Helsinki';

// Shaped like the Power by the Hour Prices API (README.prices-api.md); names and prices made up.
function slot(ms, importPrice, isForecast = false) {
  return { time: new Date(ms).toISOString(), importPrice, exportPrice: importPrice / 2, isForecast };
}

function entry(deviceId, { commodity = 'power', tariffType = 'dynamic', priceInterval = 15, slots = [] } = {}) {
  return { deviceId, deviceName: `Device ${deviceId}`, driverType: 'price', commodity, tariffType, biddingZone: 'X', currency: '€', priceInterval, slots };
}

test('apiPowerDevices lists electricity devices only, with tariff type and interval', () => {
  const response = {
    generatedAt: '2026-11-13T10:00:00.000Z',
    prices: [entry('a'), entry('gas', { commodity: 'gas' }), entry('b', { tariffType: 'fixed', priceInterval: 60 }), { deviceId: '' }, null]
  };
  assert.deepStrictEqual(prices.apiPowerDevices(response), [
    { id: 'a', name: 'Device a', tariffType: 'dynamic', currency: '€', interval: 15 },
    { id: 'b', name: 'Device b', tariffType: 'fixed', currency: '€', interval: 60 }
  ]);
  assert.deepStrictEqual(prices.apiPowerDevices({}), []);
  assert.deepStrictEqual(prices.apiPowerDevices(null), []);
});

test('apiEntry finds the chosen device in a response or a push', () => {
  const push = { reason: 'period-changed', prices: [entry('b')] };
  assert.strictEqual(prices.apiEntry(push, 'b').deviceId, 'b');
  assert.strictEqual(prices.apiEntry(push, 'a'), null);
  assert.strictEqual(prices.apiEntry(undefined, 'a'), null);
});

test('apiDays maps slots to local days from midnight, skipping forecasts and bad values', () => {
  const start = midnight(TZ, '2026-11-13');
  const q = 15 * 60000;
  const slots = [
    slot(start + 40 * q, 0.1),
    slot(start + 41 * q, 0.2),
    // A hole at 42.
    slot(start + 43 * q, 0.3),
    slot(start + 44 * q, 0.9, true),
    slot(start + 45 * q + 60000, 0.5),
    { time: 'bad', importPrice: 0.1 },
    { time: new Date(start + 46 * q).toISOString(), importPrice: null },
    // First slot of the next local day.
    slot(midnight(TZ, '2026-11-14'), 0.05)
  ];
  const result = prices.apiDays(entry('a', { slots }), TZ);
  assert.strictEqual(result.resolution, 15);
  assert.strictEqual(result.count, 4);
  assert.strictEqual(result.days['2026-11-13'].length, 44);
  assert.deepStrictEqual(result.days['2026-11-13'].slice(40), [0.1, 0.2, null, 0.3]);
  assert.strictEqual(result.days['2026-11-13'][0], null);
  assert.deepStrictEqual(result.days['2026-11-14'], [0.05]);
});

test('apiDays accepts 15, 30 and 60 minutes and refuses other intervals or no prices', () => {
  const start = midnight(TZ, '2026-11-13');
  for (const minutes of [15, 30, 60]) {
    const result = prices.apiDays(entry('a', { priceInterval: minutes, slots: [slot(start + 2 * minutes * 60000, 0.1)] }), TZ);
    assert.strictEqual(result.resolution, minutes);
    assert.strictEqual(result.days['2026-11-13'][2], 0.1);
  }
  assert.deepStrictEqual(prices.apiDays(entry('a', { priceInterval: 5, slots: [slot(start, 0.1)] }), TZ), { error: 'interval' });
  assert.deepStrictEqual(prices.apiDays(entry('a', { slots: [slot(start, 0.1, true)] }), TZ), { error: 'no_slots' });
});

test('apiDays handles the autumn DST day (100 quarters)', () => {
  const start = midnight(TZ, '2026-10-25');
  const slots = Array.from({ length: 100 }, (_, i) => slot(start + i * 900000, i / 1000));
  const result = prices.apiDays(entry('a', { slots }), TZ);
  assert.strictEqual(result.days['2026-10-25'].length, 100);
  assert.strictEqual(result.days['2026-10-25'][99], 0.099);
});

test('mergeApiDays keeps earlier stored slots of today and takes the API from the current slot on', () => {
  const stored = {
    '2026-11-12': { resolution: 15, values: [0.4], importedAt: 1 },
    '2026-11-13': { resolution: 15, values: [0.1, 0.1, 0.1, 0.1], importedAt: 1 }
  };
  const incoming = { resolution: 15, days: { '2026-11-13': [null, null, 0.2, 0.3, 0.4], '2026-11-14': [0.5] } };
  const result = prices.mergeApiDays(stored, incoming, 99);
  assert.deepStrictEqual(result['2026-11-12'], stored['2026-11-12']);
  assert.deepStrictEqual(result['2026-11-13'], { resolution: 15, values: [0.1, 0.1, 0.2, 0.3, 0.4], importedAt: 99, source: 'api' });
  assert.deepStrictEqual(result['2026-11-14'].values, [0.5]);
  // The stored days are not changed.
  assert.deepStrictEqual(stored['2026-11-13'].values, [0.1, 0.1, 0.1, 0.1]);
});

test('mergeApiDays replaces a day stored with another resolution', () => {
  const stored = { '2026-11-13': { resolution: 60, values: [0.1, 0.1], importedAt: 1 } };
  const result = prices.mergeApiDays(stored, { resolution: 15, days: { '2026-11-13': [null, null, 0.2] } }, 2);
  assert.deepStrictEqual(result['2026-11-13'].values, [null, null, 0.2]);
  assert.strictEqual(result['2026-11-13'].resolution, 15);
});

test('evaluate works on merged API days with unknown slots', () => {
  const date = '2026-11-13';
  const start = midnight(TZ, date);
  const values = Array.from({ length: 96 }, (_, i) => (i < 10 ? null : 0.05));
  values[50] = 0.2;
  const days = { [date]: { resolution: 15, values } };
  const at = (q) => start + q * 900000 + 60000;
  assert.strictEqual(prices.evaluate({ days, timeZone: TZ, now: at(50), resolution: 15 }).expensive, true);
  assert.strictEqual(prices.evaluate({ days, timeZone: TZ, now: at(5), resolution: 15 }).price, null);
  assert.strictEqual(prices.evaluate({ days, timeZone: TZ, now: at(20), resolution: 15 }).stats.count, 86);
});

test('evaluate falls back to above average for 30-minute prices', () => {
  const date = '2026-11-13';
  const values = Array.from({ length: 48 }, () => 0.05);
  const result = prices.evaluate({ days: { [date]: { resolution: 30, values } }, timeZone: TZ, now: midnight(TZ, date) + 60000, resolution: 30 });
  assert.strictEqual(result.model, 'above_average');
  assert.deepStrictEqual(result.reasons[0], { code: 'hourly_fallback', args: { minutes: 30 } });
});

test('knownCount counts only numbers', () => {
  assert.strictEqual(prices.knownCount({ values: [null, 0.1, 0.2, null] }), 2);
  assert.strictEqual(prices.knownCount(undefined), 0);
});

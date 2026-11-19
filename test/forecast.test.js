'use strict';

const test = require('node:test');
const assert = require('node:assert');
const forecast = require('../lib/forecast');

const H = forecast.HOUR_MS;
const T0 = Date.UTC(2026, 10, 20, 0, 0);

test('openMeteoUrl rounds the location to two decimals', () => {
  const url = forecast.openMeteoUrl(60.123456, 24.987654);
  assert.ok(url.startsWith('https://api.open-meteo.com/v1/forecast?'));
  assert.ok(url.includes('latitude=60.12&longitude=24.99'));
  assert.ok(url.includes('hourly=temperature_2m') && url.includes('timeformat=unixtime') && url.includes('forecast_days=3'));
});

test('parseOpenMeteo: points in ms, sorted, without missing readings', () => {
  const body = { hourly: { time: [T0 / 1000 + 3600, T0 / 1000, T0 / 1000 + 7200], temperature_2m: [4, 5, null] } };
  assert.deepStrictEqual(forecast.parseOpenMeteo(body), [
    [T0, 5],
    [T0 + H, 4]
  ]);
  assert.throws(() => forecast.parseOpenMeteo({}));
  assert.throws(() => forecast.parseOpenMeteo({ hourly: { time: [1], temperature_2m: [null] } }));
});

test('temperatureAt: straight lines between points, last value after, null before', () => {
  const points = [
    [T0, 4],
    [T0 + H, 2],
    [T0 + 2 * H, 6]
  ];
  assert.strictEqual(forecast.temperatureAt(points, T0 - 1), null);
  assert.strictEqual(forecast.temperatureAt(points, T0), 4);
  assert.strictEqual(forecast.temperatureAt(points, T0 + H / 2), 3);
  assert.strictEqual(forecast.temperatureAt(points, T0 + 1.5 * H), 4);
  assert.strictEqual(forecast.temperatureAt(points, T0 + 10 * H), 6);
  assert.strictEqual(forecast.temperatureAt([], T0), null);
});

test('range: lowest and highest in a window, also between points', () => {
  const points = [
    [T0, 4],
    [T0 + H, -1],
    [T0 + 2 * H, 6]
  ];
  assert.deepStrictEqual(forecast.range(points, T0 + H / 2, T0 + 1.5 * H), { min: -1, max: 2.5 });
  assert.deepStrictEqual(forecast.range(points, T0, T0 + 24 * H), { min: -1, max: 6 });
  assert.deepStrictEqual(forecast.range(points, T0 - 10 * H, T0 - H), { min: null, max: null });
});

test('usable: only a fresh forecast with points', () => {
  const points = [[T0, 4]];
  assert.strictEqual(forecast.usable({ fetchedAt: T0, points }, T0 + 5 * H), true);
  assert.strictEqual(forecast.usable({ fetchedAt: T0, points }, T0 + 7 * H), false);
  assert.strictEqual(forecast.usable({ fetchedAt: T0, points: [] }, T0), false);
  assert.strictEqual(forecast.usable(null, T0), false);
});

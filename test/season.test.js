'use strict';

const test = require('node:test');
const assert = require('node:assert');
const season = require('../lib/season');

const H = season.HOUR_MS;
const T0 = Date.UTC(2026, 10, 20, 0, 0);

// Hourly buckets with the same value for `hours` hours up to now.
function filled(now, hours, value) {
  let buckets = [];
  for (let i = hours - 1; i >= 0; i--) buckets = season.addSample(buckets, now - i * H, typeof value === 'function' ? value(i) : value, 100);
  return buckets;
}

test('addSample: averages within the hour, drops old hours and non-numbers', () => {
  let b = season.addSample([], T0, 4, 72);
  b = season.addSample(b, T0 + 60000, 6, 72);
  assert.deepStrictEqual(b, [[T0 / H, 5, 2]]);
  b = season.addSample(b, T0 + H, 1, 72);
  assert.strictEqual(b.length, 2);
  b = season.addSample(b, T0 + H, null, 72);
  assert.strictEqual(b.length, 2);
  b = season.addSample(b, T0 + 72 * H, 3, 72);
  assert.deepStrictEqual(
    b.map((x) => x[0]),
    [T0 / H + 1, T0 / H + 72]
  );
  assert.deepStrictEqual(season.addSample(null, T0, NaN, 72), []);
});

test('pastMean: each hour counts the same; null below 80 % coverage', () => {
  let b = season.addSample([], T0, 0, 24);
  for (let i = 0; i < 10; i++) b = season.addSample(b, T0 + i * 1000, 0, 24);
  b = season.addSample(b, T0 + H, 10, 24);
  assert.strictEqual(season.pastMean(b, T0 + H, 2).mean, 5);
  assert.strictEqual(season.pastMean(b, T0 + H, 24).mean, null);
  const day = filled(T0, 20, 21);
  assert.strictEqual(season.indoorMean(day, T0), 21);
  assert.strictEqual(season.indoorMean(filled(T0, 19, 21), T0), null);
});

test('outdoorMean: 3 days without a forecast, 2 days + 24 h with one', () => {
  const now = T0 + 30 * 60000;
  const past = filled(now, 72, (i) => (i < 48 ? 6 : 0));
  assert.deepStrictEqual(season.outdoorMean(past, now), { mean: 4, forecast: false });
  const stored = {
    fetchedAt: now,
    points: [
      [now, 12],
      [now + 48 * H, 12]
    ]
  };
  // 48 hours of 6 and 24 hours of 12.
  assert.deepStrictEqual(season.outdoorMean(past, now, stored), { mean: 8, forecast: true });
  // An old forecast counts as none.
  assert.deepStrictEqual(season.outdoorMean(past, now + 7 * H, stored).forecast, false);
  // Start-up: not enough samples.
  assert.strictEqual(season.outdoorMean(filled(now, 38, 5), now, stored).mean, null);
  assert.strictEqual(season.outdoorMean(filled(now, 39, 5), now, stored).mean, (39 * 5 + 24 * 12) / 63);
  assert.strictEqual(season.outdoorMean(filled(now, 50, 5), now).mean, null);
});

test('thresholds: defaults for missing values', () => {
  assert.deepStrictEqual(season.thresholds({}), season.DEFAULTS);
  assert.deepStrictEqual(season.thresholds({ season_heat_below: 8, season_cool_outdoor_above: '20', season_cool_indoor_above: '' }), { heatBelow: 8, coolOutdoorAbove: 20, coolIndoorAbove: 23 });
});

test('decide: heating below, cooling above both, otherwise as it is; never off', () => {
  const t = season.DEFAULTS;
  assert.strictEqual(season.decide({ current: 'cooling', outdoor: 7, indoor: 25, thresholds: t }).season, 'heating');
  assert.strictEqual(season.decide({ current: 'heating', outdoor: 19, indoor: 24, thresholds: t }).season, 'cooling');
  assert.strictEqual(season.decide({ current: 'heating', outdoor: 19, indoor: 22, thresholds: t }).code, 'between');
  assert.strictEqual(season.decide({ current: 'heating', outdoor: 19, indoor: null, thresholds: t }).season, 'heating');
  assert.strictEqual(season.decide({ current: 'cooling', outdoor: 14, indoor: 21, thresholds: t }).season, 'cooling');
  assert.strictEqual(season.decide({ current: 'heating', outdoor: 14, indoor: 25, thresholds: t }).season, 'heating');
  assert.deepStrictEqual(season.decide({ current: 'off', outdoor: null, indoor: null, thresholds: t }), { season: 'heating', code: 'collecting', args: { outdoor: null, indoor: null } });
  assert.strictEqual(season.decide({ current: 'off', outdoor: 14, indoor: null, thresholds: t }).season, 'heating');
  assert.strictEqual(season.decide({ current: 'cooling', outdoor: 10, indoor: 30, thresholds: t }).season, 'cooling');
});

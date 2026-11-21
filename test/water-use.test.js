'use strict';

const test = require('node:test');
const assert = require('node:assert');
const use = require('../lib/water-use');
const { waterFlowCapability } = require('../lib/members');

const S = 1000;
const M = 60000;

// Runs flow readings [[seconds, l/min], …] through useStep, then checkEnd at the given second; returns the events.
function run(readings, checkAt = null) {
  let state = null;
  const started = [];
  const ended = [];
  for (const [seconds, flow] of readings) {
    const step = use.useStep(state, seconds * S, flow);
    state = step.use;
    if (step.started) started.push(seconds);
    if (step.ended) ended.push(step.ended);
  }
  if (checkAt !== null) {
    const check = use.checkEnd(state, checkAt * S);
    state = check.use;
    if (check.ended) ended.push(check.ended);
  }
  return { state, started, ended };
}

test('rollover: today resets on a new day, the month on a new month, also per category', () => {
  const totals = { date: '2026-11-19', month: '2026-11', todayL: 300, monthL: 9000, cats: { shower: { todayL: 100, monthL: 3000 } } };
  assert.deepStrictEqual(use.rollover(totals, '2026-11-19'), totals);
  assert.deepStrictEqual(use.rollover(totals, '2026-11-20'), { date: '2026-11-20', month: '2026-11', todayL: 0, monthL: 9000, cats: { shower: { todayL: 0, monthL: 3000 } } });
  assert.deepStrictEqual(use.rollover(totals, '2026-12-01'), { date: '2026-12-01', month: '2026-12', todayL: 0, monthL: 0, cats: { shower: { todayL: 0, monthL: 0 } } });
  assert.deepStrictEqual(use.rollover(null, '2026-11-20'), { date: '2026-11-20', month: '2026-11', todayL: 0, monthL: 0, cats: {} });
});

test('addLitres: to today and the month, after the rollover; nothing for zero or invalid', () => {
  const totals = { date: '2026-11-30', month: '2026-11', todayL: 300, monthL: 9000, cats: {} };
  assert.deepStrictEqual(use.addLitres(totals, '2026-11-30', 12), { date: '2026-11-30', month: '2026-11', todayL: 312, monthL: 9012, cats: {} });
  assert.deepStrictEqual(use.addLitres(totals, '2026-12-01', 5), { date: '2026-12-01', month: '2026-12', todayL: 5, monthL: 5, cats: {} });
  assert.deepStrictEqual(use.addLitres(totals, '2026-11-30', NaN), totals);
  assert.deepStrictEqual(use.addLitres(totals, '2026-11-30', -3), totals);
});

test('meterStep: litres between readings; the first, a reset and a jump only set the start', () => {
  assert.deepStrictEqual(use.meterStep(null, 512.25), { litres: 0, last: 512.25 });
  const step = use.meterStep(512.25, 512.3);
  assert.ok(Math.abs(step.litres - 50) < 1e-6);
  assert.deepStrictEqual(use.meterStep(512.3, 0.01), { litres: 0, last: 0.01 });
  assert.deepStrictEqual(use.meterStep(1, 50), { litres: 0, last: 50 });
  assert.deepStrictEqual(use.meterStep(512.3, null), { litres: 0, last: 512.3 });
});

test('flowStep: the previous flow over the time since, at most MAX_HOLD_MS', () => {
  let step = use.flowStep(null, 0, 6);
  assert.strictEqual(step.litres, 0);
  step = use.flowStep(step.last, 30 * S, 0);
  assert.strictEqual(step.litres, 3);
  step = use.flowStep({ at: 0, flow: 6 }, 60 * M, 6);
  assert.strictEqual(step.litres, 60);
  // Noise under MIN_FLOW is no water.
  assert.strictEqual(use.flowStep({ at: 0, flow: 0.1 }, M, 0).litres, 0);
});

test('useStep: a tap draw, ended a minute after the flow stopped', () => {
  // 5 l/min for 40 s, readings every 5 s.
  const readings = [];
  for (let s = 0; s < 40; s += 5) readings.push([s, 5]);
  readings.push([40, 0]);
  const { state, started, ended } = run(readings, 100);
  assert.deepStrictEqual(started, [0]);
  assert.strictEqual(state, null);
  assert.strictEqual(ended.length, 1);
  assert.strictEqual(ended[0].start, 0);
  assert.strictEqual(ended[0].end, 40 * S);
  assert.ok(Math.abs(ended[0].litres - 40 / 12) < 1e-9);
  assert.strictEqual(ended[0].peak, 5);
  assert.ok(Math.abs(ended[0].average - 5) < 1e-9);
});

test("useStep: a short pause doesn't split a use, a longer one does", () => {
  const shower = run(
    [
      [0, 8],
      [120, 0],
      [150, 8],
      [300, 0]
    ],
    400
  );
  assert.strictEqual(shower.started.length, 1);
  assert.strictEqual(shower.ended.length, 1);
  assert.ok(Math.abs(shower.ended[0].litres - (16 + 20)) < 1e-9);

  const fills = run(
    [
      [0, 1.5],
      [240, 0],
      [400, 1.5],
      [580, 0]
    ],
    700
  );
  assert.deepStrictEqual(fills.started, [0, 400]);
  assert.strictEqual(fills.ended.length, 2);
  assert.ok(Math.abs(fills.ended[0].litres - 6) < 1e-9);
  assert.ok(Math.abs(fills.ended[1].litres - 4.5) < 1e-9);
});

test('useStep: not ended before the gap; noise and unknown flow are zero', () => {
  const open = run(
    [
      [0, 5],
      [30, 0]
    ],
    80
  );
  assert.strictEqual(open.ended.length, 0);
  assert.strictEqual(open.state.zeroSince, 30 * S);
  assert.strictEqual(
    run([
      [0, 0.1],
      [5, null]
    ]).started.length,
    0
  );
});

test('checkEnd: a running flow without readings goes stale after MAX_HOLD_MS', () => {
  const { ended } = run([[0, 2]], 20 * 60);
  assert.strictEqual(ended.length, 1);
  assert.strictEqual(ended[0].end, use.MAX_HOLD_MS);
  assert.ok(Math.abs(ended[0].litres - 20) < 1e-9);
});

test('runningLitres: the use so far', () => {
  const { state } = run([[0, 6]]);
  assert.strictEqual(use.runningLitres(state, 30 * S), 3);
  assert.strictEqual(use.runningLitres(null, 0), 0);
});

test('keepUse: newest last, at most KEEP_USES', () => {
  let uses = null;
  for (let i = 0; i < use.KEEP_USES + 5; i++) uses = use.keepUse(uses, { start: i });
  assert.strictEqual(uses.length, use.KEEP_USES);
  assert.strictEqual(uses[0].start, 5);
});

test('cost: litres at a price per m³, null without a price', () => {
  assert.strictEqual(use.cost(250, 4), 1);
  assert.strictEqual(use.cost(250, 0), null);
  assert.strictEqual(use.cost(null, 4), null);
});

test('baseFee: spread evenly over the month, up to and including the date; null without a fee', () => {
  const nov = use.baseFee(30, '2026-11-20');
  assert.strictEqual(nov.today, 1);
  assert.strictEqual(nov.month, 20);
  const feb = use.baseFee(28, '2028-02-29');
  assert.strictEqual(feb.today, 28 / 29);
  assert.ok(Math.abs(feb.month - 28) < 1e-9);
  assert.strictEqual(use.baseFee(0, '2026-11-20'), null);
  assert.strictEqual(use.baseFee(null, '2026-11-20'), null);
});

test('waterFlowCapability: measure_water first, else measure_water_flow in l/min', () => {
  assert.strictEqual(waterFlowCapability({ measure_water: {}, measure_water_flow: { units: 'L/min' } }), 'measure_water');
  assert.strictEqual(waterFlowCapability({ measure_water_flow: { units: 'L/min' } }), 'measure_water_flow');
  assert.strictEqual(waterFlowCapability({ measure_water_flow: { units: 'm³/h' } }), null);
  assert.strictEqual(waterFlowCapability({ meter_water: {} }), null);
});

test('confirmUse: confirmed once the meter reading rose a litre; a flow without water stays unconfirmed', () => {
  let { use: state } = use.useStep(null, 0, 1.2);
  assert.strictEqual(state.confirmed, false);
  let result = use.confirmUse(state, 47.47);
  state = result.use;
  assert.strictEqual(state.meterStart, 47.47);
  assert.strictEqual(result.confirmed, false);
  result = use.confirmUse(state, 47.4705);
  assert.strictEqual(result.confirmed, false);
  result = use.confirmUse(result.use, 47.471);
  assert.strictEqual(result.confirmed, true);
  assert.strictEqual(use.confirmUse(result.use, 47.48).confirmed, false);

  // A ghost: the flow ends before the reading moves.
  let ghost = use.useStep(null, 0, 1.2).use;
  ghost = use.confirmUse(ghost, 47.47).use;
  ghost = use.useStep(ghost, 50 * S, 0).use;
  const { ended } = use.checkEnd(ghost, 120 * S);
  assert.strictEqual(ended.confirmed, false);

  // A flow-only meter confirms at once; no reading leaves it open.
  assert.strictEqual(use.confirmUse(use.useStep(null, 0, 5).use, null, true).confirmed, true);
  assert.strictEqual(use.confirmUse(use.useStep(null, 0, 5).use, null).confirmed, false);
});

// A finished use: minutes long, litres, with a steady flow unless peak is given.
function finished(minutes, litres, peak = null) {
  const average = litres / minutes;
  return { start: 0, end: minutes * M, litres, average, peak: peak === null ? average : peak };
}

// Labelled uses of a category around minutes and litres, a little apart.
function labels(category, minutes, litres, count = 3) {
  return Array.from({ length: count }, (_, i) => ({ ...finished(minutes * (1 + 0.05 * i), litres * (1 - 0.05 * i)), category }));
}

test('learnPatterns: a category is learned from MIN_SAMPLES labels, chosen categories only', () => {
  const samples = [...labels('shower', 6, 45), ...labels('toilet', 1, 6, 2), ...labels('bath', 8, 120)];
  const patterns = use.learnPatterns(samples, ['shower', 'toilet']);
  assert.deepStrictEqual(Object.keys(patterns), ['shower']);
  assert.strictEqual(patterns.shower.n, use.MIN_SAMPLES);
  assert.strictEqual(patterns.shower.samples.length, use.MIN_SAMPLES);
  assert.ok(Math.abs(Math.exp(patterns.shower.samples[0].litres) - 45) < 1e-9);
});

test('classify: Unknown until a learned pattern clearly fits', () => {
  // Nothing labelled yet: everything is Unknown.
  assert.strictEqual(use.classify(finished(6, 45), {}), 'unknown');
  const patterns = use.learnPatterns([...labels('shower', 6, 45), ...labels('toilet', 1, 6)], use.CATEGORIES);
  assert.strictEqual(use.classify(finished(6.5, 42), patterns), 'shower');
  assert.strictEqual(use.classify(finished(1.1, 6), patterns), 'toilet');
  // An uneven short draw doesn't fit a toilet's steady refill.
  assert.strictEqual(use.classify(finished(1, 6, 12), patterns), 'unknown');
  // Fits none.
  assert.strictEqual(use.classify(finished(40, 300), patterns), 'unknown');
  // Fits two: Unknown.
  const both = use.learnPatterns([...labels('shower', 6, 45), ...labels('bath', 6, 45)], use.CATEGORIES);
  assert.strictEqual(use.classify(finished(6, 45), both), 'unknown');
  // A use near samples of two categories: Unknown.
  const close = use.learnPatterns([...labels('shower', 6, 45), ...labels('bath', 7, 50)], use.CATEGORIES);
  assert.strictEqual(use.classify(finished(6.5, 47), close), 'unknown');
  // A use without a flow can't be compared.
  assert.strictEqual(use.classify({ start: 0, end: 0, litres: 0, average: 0, peak: 0 }, patterns), 'unknown');
});

test('keepSample: a use once, its latest category, at most KEEP_SAMPLES per category', () => {
  const sample = (start, category, extra = {}) => ({ start, end: start + M, litres: 5, average: 5, peak: 5, category, ...extra });
  let samples = use.keepSample([], sample(1, 'toilet', { auto: true }));
  // Relabelled: the use's sample is replaced.
  samples = use.keepSample(samples, sample(1, 'sink', { labelled: true }));
  assert.deepStrictEqual(samples.map((s) => [s.start, s.category]), [[1, 'sink']]);
  // Many toilets don't push out the one bath.
  samples = use.keepSample(samples, sample(0, 'bath'));
  for (let i = 2; i < 2 + use.KEEP_SAMPLES + 5; i++) samples = use.keepSample(samples, sample(i, 'toilet'));
  assert.strictEqual(samples.filter((s) => s.category === 'toilet').length, use.KEEP_SAMPLES);
  assert.strictEqual(samples[0].category, 'bath');
  assert.strictEqual(samples.filter((s) => s.category === 'toilet')[0].start, 7);
});

test('chosenCategories: known ones only, in the pairing order', () => {
  assert.deepStrictEqual(use.chosenCategories(['toilet', 'x', 'shower']), ['shower', 'toilet']);
  assert.deepStrictEqual(use.chosenCategories(null), []);
});

test('addCategory and categoryTotals: Unknown is the house total less the chosen categories', () => {
  let totals = use.addLitres(null, '2026-11-20', 100);
  totals = use.addCategory(totals, '2026-11-20', 'shower', 40);
  totals = use.addCategory(totals, '2026-11-20', 'sink', 5);
  const sums = use.categoryTotals(totals, ['shower', 'sink', 'toilet']);
  assert.deepStrictEqual(sums.shower, { todayL: 40, monthL: 40 });
  assert.deepStrictEqual(sums.toilet, { todayL: 0, monthL: 0 });
  assert.deepStrictEqual(sums.unknown, { todayL: 55, monthL: 55 });
  // A category not chosen any more counts in Unknown; Unknown is never negative.
  assert.deepStrictEqual(use.categoryTotals(totals, ['sink']).unknown, { todayL: 95, monthL: 95 });
  assert.deepStrictEqual(use.categoryTotals(use.addCategory(totals, '2026-11-20', 'shower', 100), ['shower']).unknown, { todayL: 0, monthL: 0 });
});

test('moveCategory: a relabelled use moves from one category to another, today and this month', () => {
  let totals = use.addLitres(null, '2026-11-20', 100);
  totals = use.addCategory(totals, '2026-11-20', 'sink', 30);
  const moved = use.moveCategory(totals, '2026-11-20', 'sink', 'shower', 30);
  assert.deepStrictEqual(moved.cats.sink, { todayL: 0, monthL: 0 });
  assert.deepStrictEqual(moved.cats.shower, { todayL: 30, monthL: 30 });
  // From Unknown (or the old Other): only the new category grows; to Unknown: only the old one shrinks.
  assert.deepStrictEqual(use.moveCategory(totals, '2026-11-20', 'unknown', 'toilet', 6).cats.toilet, { todayL: 6, monthL: 6 });
  assert.deepStrictEqual(use.moveCategory(totals, '2026-11-20', 'other', 'toilet', 6).cats.toilet, { todayL: 6, monthL: 6 });
  assert.deepStrictEqual(use.moveCategory(totals, '2026-11-20', 'sink', 'unknown', 10).cats.sink, { todayL: 20, monthL: 20 });
  // A use that ended yesterday moves in the month only.
  assert.deepStrictEqual(use.moveCategory(totals, '2026-11-19', 'sink', 'shower', 10).cats.shower, { todayL: 0, monthL: 10 });
  assert.strictEqual(use.moveCategory(totals, '2026-11-20', 'sink', 'sink', 10), totals);
});

test('classify: a category learns several kinds of use (eco and full flush, with or without washing hands)', () => {
  // Washroom visits: an eco flush 3 l, a full flush 6 l, and each with a hand wash (more litres, a higher peak).
  const visits = [
    ...labels('toilet', 0.6, 3),
    ...labels('toilet', 1, 6),
    ...labels('toilet', 0.8, 4, 2).map((v) => ({ ...v, peak: v.average * 1.6 })),
    ...labels('toilet', 1.1, 7, 2).map((v) => ({ ...v, peak: v.average * 1.6 }))
  ];
  const patterns = use.learnPatterns([...visits, ...labels('sink', 0.4, 1.5), ...labels('shower', 6, 45)], use.CATEGORIES);
  assert.strictEqual(use.classify(finished(0.6, 3.1), patterns), 'toilet');
  assert.strictEqual(use.classify(finished(1, 6.2), patterns), 'toilet');
  assert.strictEqual(use.classify(finished(0.8, 4, (4 / 0.8) * 1.6), patterns), 'toilet');
  assert.strictEqual(use.classify(finished(1.1, 7, (7 / 1.1) * 1.6), patterns), 'toilet');
  // A hand wash alone is a sink, a shower a shower.
  assert.strictEqual(use.classify(finished(0.4, 1.5), patterns), 'sink');
  assert.strictEqual(use.classify(finished(6, 44), patterns), 'shower');
  // Between the kinds, near none of them: Unknown.
  assert.strictEqual(use.classify(finished(3, 15), patterns), 'unknown');
});

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

test('rollover: today resets on a new day, the month on a new month', () => {
  const totals = { date: '2026-11-19', month: '2026-11', todayL: 300, monthL: 9000 };
  assert.deepStrictEqual(use.rollover(totals, '2026-11-19'), totals);
  assert.deepStrictEqual(use.rollover(totals, '2026-11-20'), { date: '2026-11-20', month: '2026-11', todayL: 0, monthL: 9000 });
  assert.deepStrictEqual(use.rollover(totals, '2026-12-01'), { date: '2026-12-01', month: '2026-12', todayL: 0, monthL: 0 });
  assert.deepStrictEqual(use.rollover(null, '2026-11-20'), { date: '2026-11-20', month: '2026-11', todayL: 0, monthL: 0 });
});

test('addLitres: to today and the month, after the rollover; nothing for zero or invalid', () => {
  const totals = { date: '2026-11-30', month: '2026-11', todayL: 300, monthL: 9000 };
  assert.deepStrictEqual(use.addLitres(totals, '2026-11-30', 12), { date: '2026-11-30', month: '2026-11', todayL: 312, monthL: 9012 });
  assert.deepStrictEqual(use.addLitres(totals, '2026-12-01', 5), { date: '2026-12-01', month: '2026-12', todayL: 5, monthL: 5 });
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

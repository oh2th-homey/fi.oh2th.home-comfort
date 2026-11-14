'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { midnight } = require('oh2th-homey-helpers');
const water = require('../lib/water');

const TZ = 'Europe/Helsinki';
const H = 3600000;
const Q = water.QUARTER_MS;
// A spa model learned well enough for pre-heating: 2 °C/h heating, loses 1 % of the difference to outdoors per hour.
const LEARNED = { heatRate: 2, loss: 0.01, heatHours: 10, idleHours: 50 };

test('learn: heating rate from a heating segment, losses from a waiting one', () => {
  const heat = water.learn(water.DEFAULT_MODEL, { heating: true, hours: 2, from: 30, to: 34, outdoor: 0 });
  assert.strictEqual(heat.learned, 'heat');
  // 2 °C/h seen, plus the loss while heating (0.01 × 32): the first segment counts fully.
  assert.ok(Math.abs(heat.model.heatRate - 2.32) < 1e-9);
  assert.strictEqual(heat.model.heatHours, 2);
  const idle = water.learn(heat.model, { heating: false, hours: 10, from: 38, to: 35, outdoor: -10 });
  assert.strictEqual(idle.learned, 'loss');
  assert.ok(Math.abs(idle.value - 0.3 / 46.5) < 1e-9);
  assert.strictEqual(idle.model.idleHours, 10);
});

test('learn: ignores short, flat, implausible or incomplete segments', () => {
  const m = water.DEFAULT_MODEL;
  assert.strictEqual(water.learn(m, { heating: true, hours: 0.25, from: 30, to: 31, outdoor: 0 }).learned, null);
  assert.strictEqual(water.learn(m, { heating: true, hours: 1, from: 30, to: 30.2, outdoor: 0 }).learned, null);
  assert.strictEqual(water.learn(m, { heating: false, hours: 1, from: 38, to: 36, outdoor: 0 }).learned, null);
  assert.strictEqual(water.learn(m, { heating: false, hours: 5, from: 22, to: 21, outdoor: 20 }).learned, null);
  assert.strictEqual(water.learn(m, { heating: false, hours: 5, from: 38, to: 37, outdoor: null }).learned, null);
  assert.strictEqual(water.learn(m, { heating: true, hours: 1, from: 20, to: 50, outdoor: 0 }).learned, null);
});

test('confident only after enough heating and waiting', () => {
  assert.strictEqual(water.confident(water.model(null)), false);
  assert.strictEqual(water.confident(water.model({ heatHours: 3, idleHours: 5 })), false);
  assert.strictEqual(water.confident(water.model(LEARNED)), true);
});

test('hoursToHeat matches project, and is Infinity when the heater cannot get there', () => {
  const m = water.model(LEARNED);
  const hours = water.hoursToHeat(30, 38, 0, m);
  assert.ok(hours > 4 && hours < 6);
  assert.ok(water.project(30, 0, hours, true, m) >= 37.9);
  assert.strictEqual(water.hoursToHeat(38, 37, 0, m), 0);
  assert.strictEqual(water.hoursToHeat(30, 250, 0, m), Infinity);
});

test('uses: weekly schedule on chosen days, one-offs, skipped ones, a running use', () => {
  // Friday 2026-11-13 12:00 local.
  const now = midnight(TZ, '2026-11-13') + 12 * H;
  const schedule = { time: '18:00', minutes: 90, days: { mon: true, tue: true, wed: true, thu: true, fri: true, sat: false, sun: true } };
  const list = water.uses({ now, timeZone: TZ, schedule, oneOffs: [{ start: midnight(TZ, '2026-11-14') + 10 * H, minutes: 30 }], skipped: [], horizon: 72 * H });
  // Fri 18:00, Sat 10:00 (one-off, no Saturday schedule), Sun 18:00.
  assert.deepStrictEqual(
    list.map((u) => (u.start - midnight(TZ, '2026-11-13')) / H),
    [18, 34, 66]
  );
  assert.strictEqual(list[0].end - list[0].start, 90 * 60000);
  assert.strictEqual(list[1].end - list[1].start, 30 * 60000);
  const skipped = water.uses({ now, timeZone: TZ, schedule, skipped: [list[0].start], horizon: 72 * H });
  assert.strictEqual(skipped[0].start, list[2].start);
  const running = water.uses({ now: list[0].start + 30 * 60000, timeZone: TZ, schedule });
  assert.strictEqual(running[0].start, list[0].start);
});

test('uses: local time on a DST day', () => {
  // Summer time ends on 2026-10-25: 18:00 is UTC+2, 16:00 UTC.
  assert.strictEqual(new Date(water.localMs(TZ, '2026-10-25', 18 * 60)).toISOString(), '2026-10-25T16:00:00.000Z');
  assert.strictEqual(new Date(water.localMs(TZ, '2026-10-24', 18 * 60)).toISOString(), '2026-10-24T15:00:00.000Z');
});

test('quarterPrices splits hourly prices into quarters, unknown ones null', () => {
  const start = midnight(TZ, '2026-11-13');
  const quarters = water.quarterPrices([0.1, 0.2, null], start, 60, start + 30 * 60000, 3 * H);
  assert.deepStrictEqual(
    quarters.map((q) => q.price),
    [0.1, 0.1, 0.2, 0.2, 0.2, 0.2, null, null, null, null, null, null]
  );
  assert.strictEqual(quarters[0].start, start + 30 * 60000);
});

const base = { keep: 30, ready: 38, max: 40, powerW: 3000, model: LEARNED };

test('decide: safety first (no temperature, at max, below keep)', () => {
  const now = midnight(TZ, '2026-11-13');
  assert.deepStrictEqual(water.decide({ ...base, now, temperature: null, outdoor: 0 }).reason.code, 'no_temperature');
  const atMax = water.decide({ ...base, now, temperature: 40, outdoor: 0, useList: [{ start: now + H, end: now + 2 * H }] });
  assert.strictEqual(atMax.demand, false);
  const cold = water.decide({ ...base, now, temperature: 29.5, outdoor: 0 });
  assert.strictEqual(cold.demand, true);
  assert.strictEqual(cold.reason.code, 'below_keep');
});

test('decide: holds ready during a use', () => {
  const now = midnight(TZ, '2026-11-13') + 18 * H;
  const useList = [{ start: now - Q, end: now + H }];
  assert.strictEqual(water.decide({ ...base, now, temperature: 37, outdoor: 0, useList }).demand, true);
  assert.strictEqual(water.decide({ ...base, now, temperature: 37.8, outdoor: 0, useList }).demand, false);
  assert.strictEqual(water.decide({ ...base, now, temperature: 37.8, outdoor: 0, useList, heatingNow: true }).demand, true);
});

test('decide: before the curve is known, heats just in time, not ahead', () => {
  const now = midnight(TZ, '2026-11-13') + 6 * H;
  const start = now + 12 * H;
  const quarters = water.quarterPrices(Array(96).fill(0.05), now, 15, now, 24 * H);
  // The default model is slow on purpose (1 °C/h): from 36 °C it needs about 6 hours at the pessimistic rate.
  const early = water.decide({ ...base, model: null, now, temperature: 36, outdoor: 0, quarters, useList: [{ start, end: start + H }] });
  assert.strictEqual(early.demand, false);
  assert.strictEqual(early.reason.code, 'learning');
  assert.ok(early.nextStart > now && early.nextStart < start);
  // Close to the use: the latest safe start.
  const late = water.decide({ ...base, model: null, now: start - 5 * H, temperature: 36, outdoor: 0, quarters, useList: [{ start, end: start + H }] });
  assert.strictEqual(late.demand, true);
  assert.strictEqual(late.reason.code, 'learning_heat');
});

test('decide: without prices, just in time with the no prices reason', () => {
  const now = midnight(TZ, '2026-11-13') + 6 * H;
  const start = now + 2 * H;
  const result = water.decide({ ...base, now, temperature: 35, outdoor: 0, quarters: [], useList: [{ start, end: start + H }] });
  assert.strictEqual(result.demand, true);
  assert.strictEqual(result.reason.code, 'no_prices_heat');
});

test('decide: heating only to hold keep says so, also with a use ahead', () => {
  const now = midnight(TZ, '2026-11-13') + 6 * H;
  const start = now + 30 * H;
  const result = water.decide({ ...base, now, temperature: 30.2, outdoor: 0, quarters: [], useList: [{ start, end: start + H }], heatingNow: true });
  assert.strictEqual(result.demand, true);
  assert.strictEqual(result.reason.code, 'keep_heat');
  const none = water.decide({ ...base, now, temperature: 30.2, outdoor: 0, quarters: [], useList: [], heatingNow: true });
  assert.strictEqual(none.reason.code, 'keep_heat');
});

// Night cheap (0.02), day expensive (0.30): a use at 18:00.
function dayPrices(now) {
  const start = midnight(TZ, '2026-11-13');
  const values = Array.from({ length: 96 * 2 }, (_, i) => (i % 96 < 24 ? 0.02 : 0.3));
  return water.quarterPrices(values, start, 15, now, 36 * H);
}

test('decide: when learned, pre-heats in cheap quarters and waits in expensive ones', () => {
  const day = midnight(TZ, '2026-11-13');
  const useList = [{ start: day + 18 * H, end: day + 19 * H }];
  const night = water.decide({ ...base, now: day + 2 * H, temperature: 33, outdoor: 0, quarters: dayPrices(day + 2 * H), useList });
  assert.strictEqual(night.demand, true);
  assert.strictEqual(night.reason.code, 'heating');
  assert.ok(night.expected >= 38);
  // Morning, already warm: no heating at day prices, a top-up just before the use.
  const morning = water.decide({ ...base, now: day + 7 * H, temperature: 39.5, outdoor: 0, quarters: dayPrices(day + 7 * H), useList });
  assert.strictEqual(morning.demand, false);
  assert.strictEqual(morning.reason.code, 'waiting');
  assert.ok(morning.nextStart > day + 7 * H && morning.nextStart < day + 18 * H);
  assert.ok(morning.expected >= 38);
});

test('decide: never plans above max, never lets the water fall below keep', () => {
  const day = midnight(TZ, '2026-11-13');
  const now = day + 2 * H;
  const result = water.decide({ ...base, now, temperature: 31, outdoor: -20, quarters: dayPrices(now), useList: [] });
  assert.ok(result.plan.temps.every((t) => t <= 40));
  assert.ok(result.plan.temps.every((t) => t >= 29.9));
});

test('decide: a price limit skips an expensive use but still holds keep', () => {
  const day = midnight(TZ, '2026-11-13');
  const now = day + 8 * H;
  const useList = [{ start: day + 18 * H, end: day + 19 * H }];
  const result = water.decide({ ...base, now, temperature: 31, outdoor: 0, quarters: dayPrices(now), useList, priceLimit: 0.1 });
  assert.strictEqual(result.skip, true);
  assert.strictEqual(result.reason.code, result.demand ? 'skipped_heat' : 'skipped');
  assert.ok(result.plan.temps.every((t) => t >= 29.9));
  const always = water.decide({ ...base, now, temperature: 31, outdoor: 0, quarters: dayPrices(now), useList });
  assert.strictEqual(always.skip, false);
  assert.ok(always.expected >= 38);
});

test('mustStart: latest safe start with the pessimistic model', () => {
  const m = water.model(LEARNED);
  const now = midnight(TZ, '2026-11-13');
  assert.strictEqual(water.mustStart(30, 38, 0, m, now, now + 12 * H), false);
  assert.strictEqual(water.mustStart(30, 38, 0, m, now, now + 4 * H), true);
});

test('pessimistic: the doubt shrinks as heating and waiting are seen, to the learned curve', () => {
  const fresh = water.pessimistic(water.model({ heatRate: 2, loss: 0.01 }));
  assert.ok(Math.abs(fresh.heatRate - 1.6) < 1e-9);
  assert.ok(Math.abs(fresh.loss - 0.0125) < 1e-9);
  // Half way: 5 h of heating, plenty of waiting.
  const half = water.pessimistic(water.model({ heatRate: 2, loss: 0.01, heatHours: 5, idleHours: 100 }));
  assert.ok(Math.abs(half.heatRate - 1.8) < 1e-9);
  // The least learned part counts: plenty of heating, no waiting.
  assert.strictEqual(water.exactness(water.model({ heatHours: 50, idleHours: 0 })), 0);
  const exact = water.pessimistic(water.model(LEARNED));
  assert.strictEqual(exact.heatRate, 2);
  assert.strictEqual(exact.loss, 0.01);
});

test('latestStart: counts the cooling until the start and keeps the safety margin', () => {
  const m = water.model(LEARNED);
  const now = midnight(TZ, '2026-11-13');
  const start = now + 12 * H;
  const latest = water.latestStart(36, 38, 0, m, now, start);
  // Waiting until then and heating from the cooled water ends 15 minutes before the start.
  const cooled = water.project(36, 0, (latest - now) / H, false, m);
  const heated = latest + water.hoursToHeat(cooled, 38, 0, m) * H;
  assert.ok(heated <= start - 15 * 60000 && heated > start - 17 * 60000, new Date(heated).toISOString());
  // Without the cooling it would start later than this.
  assert.ok(latest < start - water.hoursToHeat(36, 38, 0, m) * H - 15 * 60000);
  // Too late already, or a heater that can't get there: now.
  assert.strictEqual(water.latestStart(30, 38, 0, m, now, now + H), now);
  assert.strictEqual(water.latestStart(30, 250, 0, m, now, start), now);
});

test('learnMix: the still water reads high; learned from the drop when heating mixes it', () => {
  const m = water.model({ heatRate: 2 });
  // 38.0 still, 37.2 after 15 minutes of heating (which added 0.5): the mixing drop is 1.3.
  const first = water.learnMix(m, { before: 38, after: 37.2, heatedHours: 0.25 });
  assert.ok(Math.abs(first.value - 1.3) < 1e-9);
  assert.ok(Math.abs(first.model.mixDrop - 1.3) < 1e-9);
  const second = water.learnMix(first.model, { before: 38, after: 37.6, heatedHours: 0.25 });
  assert.ok(second.model.mixDrop < 1.3 && second.model.mixDrop > 0.9);
  // A rise is no drop; nonsense is not learned.
  assert.strictEqual(water.learnMix(m, { before: 36, after: 37, heatedHours: 0.25 }).value, 0);
  assert.strictEqual(water.learnMix(m, { before: 45, after: 30, heatedHours: 0.25 }).value, null);
});

test('mixedTemperature: plans still water with the reading minus the mixing drop', () => {
  const m = { mixDrop: 1.2 };
  assert.strictEqual(water.mixedTemperature(38, m, true), 36.8);
  assert.strictEqual(water.mixedTemperature(38, m, false), 38);
  assert.strictEqual(water.mixedTemperature(null, m, true), null);
  assert.strictEqual(water.mixedTemperature(38, null, true), 38);
});

test('decide: once ready is reached before a use, it is held until the use ends', () => {
  const day = midnight(TZ, '2026-11-13');
  const useList = [{ start: day + 18 * H, end: day + 20 * H }];
  const quarters = dayPrices(day + 16 * H);
  // Reached at 16:00: no more heating while warm enough.
  const reached = water.decide({ ...base, now: day + 16 * H, temperature: 38.1, outdoor: 0, quarters, useList });
  assert.strictEqual(reached.reachedFor, useList[0].start);
  assert.strictEqual(reached.demand, false);
  assert.strictEqual(reached.reason.code, 'ready_hold');
  // Cooled below the band before the use: heat back, although the plan alone would wait for cheaper hours.
  const cooled = water.decide({ ...base, now: day + 17 * H, temperature: 37.4, outdoor: 0, quarters, useList, reachedFor: reached.reachedFor });
  assert.strictEqual(cooled.demand, true);
  assert.strictEqual(cooled.reason.code, 'ready_hold_heat');
  // The next use is not held before it is reached.
  const next = water.decide({ ...base, now: day + 21 * H, temperature: 37, outdoor: 0, quarters: dayPrices(day + 21 * H), useList: [{ start: day + 42 * H, end: day + 44 * H }], reachedFor: reached.reachedFor });
  assert.strictEqual(next.reachedFor, null);
  assert.notStrictEqual(next.reason.code, 'ready_hold');
});

test('decide: the hold before a use follows the setting', () => {
  const day = midnight(TZ, '2026-11-13');
  const useList = [{ start: day + 18 * H, end: day + 20 * H }];
  const at = (holdBefore) => water.decide({ ...base, now: day + 15 * H, temperature: 38.2, outdoor: 0, quarters: dayPrices(day + 15 * H), useList, holdBefore });
  // 3 hours before: held with a 4-hour setting, left to the plan with the default 2 hours.
  assert.strictEqual(at(240).reason.code, 'ready_hold');
  assert.notStrictEqual(at(undefined).reason.code, 'ready_hold');
  assert.notStrictEqual(at(0).reason.code, 'ready_hold');
});

test('decide: stores heat above ready in cheap hours, up to maximum', () => {
  const day = midnight(TZ, '2026-11-13');
  const now = day + 1 * H;
  const result = water.decide({ ...base, now, temperature: 33, outdoor: 0, quarters: dayPrices(now), useList: [{ start: day + 18 * H, end: day + 20 * H }] });
  const at = (hours) => result.plan.temps[Math.round((day + hours * H - now) / Q)];
  // Cheap night: heated above ready, never above maximum; still ready at the start of the use.
  assert.ok(at(6) > 39 && at(6) <= 40);
  assert.ok(result.expected >= 38);
});

test('power levels: the circulation pump is base load, the heater is heating, split halfway', () => {
  let stored = {};
  const feed = (w) => {
    const r = water.learnPower(stored, w, 3000);
    stored = { heatW: r.heatW, baseW: r.baseW };
    return r.heating;
  };
  assert.strictEqual(feed(6), false, 'standby is neither');
  assert.strictEqual(stored.baseW, undefined);
  assert.strictEqual(feed(205), false, 'pump alone is not heating');
  assert.strictEqual(stored.baseW, 205);
  assert.strictEqual(feed(3250), true, 'heater and pump');
  assert.strictEqual(stored.heatW, 3250);
  for (let i = 0; i < 200; i++) feed(i % 2 ? 3200 : 200);
  const levels = water.powerLevels(stored, 3000);
  assert.ok(Math.abs(levels.heatW - 3200) < 30 && Math.abs(levels.baseW - 200) < 10, JSON.stringify(levels));
  assert.ok(levels.threshold > 1600 && levels.threshold < 1800);
});

test('power levels: a heater power set far too low still separates the pump once heating is seen', () => {
  let stored = {};
  const feed = (w) => {
    const r = water.learnPower(stored, w, 500);
    stored = { heatW: r.heatW, baseW: r.baseW };
    return r.heating;
  };
  feed(200);
  for (let i = 0; i < 100; i++) feed(3200);
  assert.strictEqual(feed(200), false, 'pump after the heater has been learned');
  assert.ok(water.powerLevels(stored, 500).heatW > 3000);
});

test('state: heating whenever demanded, ready while held, stopped without a temperature or at maximum', () => {
  assert.strictEqual(water.state({ demand: true, reason: { code: 'in_use_heat' } }), 'heating');
  assert.strictEqual(water.state({ demand: true, reason: { code: 'below_keep' } }), 'heating');
  assert.strictEqual(water.state({ demand: false, reason: { code: 'in_use' } }), 'ready');
  assert.strictEqual(water.state({ demand: false, reason: { code: 'ready_hold' } }), 'ready');
  assert.strictEqual(water.state({ demand: false, reason: { code: 'no_temperature' } }), 'stopped');
  assert.strictEqual(water.state({ demand: false, reason: { code: 'at_max' } }), 'stopped');
  assert.strictEqual(water.state({ demand: false, reason: { code: 'waiting' } }), 'waiting');
  assert.strictEqual(water.state({ demand: false, reason: { code: 'skipped' } }), 'waiting');
});

test('problemCheck: cooling water under demand raises the problem, warming restarts the clock', () => {
  let r = water.problemCheck(null, 0, 38, true);
  for (let t = 1; t <= 6; t++) r = water.problemCheck(r.since, t * 15 * 60000, 38 - t * 0.1, true);
  assert.strictEqual(r.problem, true);
  let w = water.problemCheck(null, 0, 36, true);
  w = water.problemCheck(w.since, H, 35.8, true);
  w = water.problemCheck(w.since, 1.25 * H, 36.2, true);
  w = water.problemCheck(w.since, 2 * H, 36.3, true);
  assert.strictEqual(w.problem, false);
  assert.deepStrictEqual(water.problemCheck(r.since, 7 * H, 37, false), { since: null, problem: false });
  assert.strictEqual(water.problemCheck(null, 0, null, false).problem, true);
});

test('inUse: during a use and 30 minutes after it, not before', () => {
  const list = [{ start: 18 * H, end: 19.5 * H }];
  assert.strictEqual(water.inUse(list, 17.9 * H), false);
  assert.strictEqual(water.inUse(list, 18 * H), true);
  assert.strictEqual(water.inUse(list, 19.9 * H), true);
  assert.strictEqual(water.inUse(list, 20 * H), false);
  assert.strictEqual(water.inUse([], 18 * H), false);
});

test('inUse: with the use list from AFTER_USE_MS ago, a use that just ended still counts', () => {
  const day = Date.UTC(2026, 0, 5);
  const list = (now) => water.uses({ now: now - water.AFTER_USE_MS, timeZone: 'UTC', schedule: { time: '18:00', minutes: 60, days: {} } });
  for (const [hours, expected] of [[17.9, false], [18.5, true], [19.1, true], [19.4, true], [19.6, false]]) {
    assert.strictEqual(water.inUse(list(day + hours * H), day + hours * H), expected, `${hours} h`);
  }
});

const CYCLES = [
  { from: '00:00', to: '06:00', minutes: 120, priceLimit: null },
  { from: '13:00', to: '16:30', minutes: 60, priceLimit: 0.15 }
];

// Quarter prices for two days from a local midnight: price(hour, quarter).
function quartersFrom(date, price) {
  const start = midnight(TZ, date);
  return Array.from({ length: 96 * 2 }, (_, i) => ({ start: start + i * Q, price: price(Math.floor((i % 96) / 4), i % 4) }));
}

test('filterTimes: the cheapest run inside each window, ties to the earliest', () => {
  // Cheap 03:00–05:00 at night, 14:15–15:15 in the afternoon, the rest 0.10.
  const quarters = quartersFrom('2026-11-14', (h, q) => {
    if (h === 3 || h === 4) return 0.02;
    if ((h === 14 && q >= 1) || (h === 15 && q === 0)) return 0.05;
    return 0.1;
  });
  const [night, day] = water.filterTimes({ quarters, date: '2026-11-14', timeZone: TZ, cycles: CYCLES });
  const at = (ms) => (ms - midnight(TZ, '2026-11-14')) / H;
  assert.deepStrictEqual([at(night.start), at(night.end), night.runs], [3, 5, true]);
  assert.ok(Math.abs(night.price - 0.02) < 1e-9);
  assert.deepStrictEqual([at(day.start), at(day.end), day.runs], [14.25, 15.25, true]);
  // All equal: the earliest start in the window.
  const flat = water.filterTimes({ quarters: quartersFrom('2026-11-14', () => 0.1), date: '2026-11-14', timeZone: TZ, cycles: CYCLES });
  assert.deepStrictEqual(flat.map((c) => at(c.start)), [0, 13]);
});

test('filterTimes: over its price limit a cycle is planned but does not run; uncovered windows wait', () => {
  const quarters = quartersFrom('2026-11-14', () => 0.2);
  const [night, day] = water.filterTimes({ quarters, date: '2026-11-14', timeZone: TZ, cycles: CYCLES });
  assert.strictEqual(night.runs, true);
  assert.strictEqual(day.runs, false);
  assert.ok(day.start > 0);
  // The next day's afternoon prices not known yet (null), or past the known quarters: not planned.
  const partial = quarters.map((q, i) => (i >= 96 + 13 * 4 ? { ...q, price: null } : q));
  assert.strictEqual(water.filterTimes({ quarters: partial, date: '2026-11-15', timeZone: TZ, cycles: CYCLES }), null);
  assert.strictEqual(water.filterTimes({ quarters, date: '2026-11-16', timeZone: TZ, cycles: CYCLES }), null);
});

test('filterTimes: local windows on a DST day', () => {
  // Summer time ends on 2026-10-25 at 04:00 local: that night has 25 hours, the window 00:00–06:00 seven of them.
  const start = midnight(TZ, '2026-10-25');
  assert.strictEqual(water.filterWindow(TZ, '2026-10-25', CYCLES[0]).to - start, 7 * H);
  // Cheapest 5–7 hours after midnight (local 04:00–06:00 after the change): still inside the window.
  const quarters = Array.from({ length: 100 }, (_, i) => ({ start: start + i * Q, price: i >= 20 && i < 28 ? 0.01 : 0.1 }));
  const [night] = water.filterTimes({ quarters, date: '2026-10-25', timeZone: TZ, cycles: [CYCLES[0]] });
  assert.strictEqual(night.start, start + 5 * H);
  assert.strictEqual(night.end - night.start, 2 * H);
});

test('filterDay: today while its windows are ahead, the next day only after today\'s windows are over', () => {
  const day = midnight(TZ, '2026-11-14');
  const plan = (hours, plannedDate = null) => water.filterDay({ now: day + hours * H, timeZone: TZ, cycles: CYCLES, plannedDate });
  // 10:00: the night window has started, the afternoon one is still due today.
  assert.strictEqual(plan(10), null);
  // 16:30 on: the next day.
  assert.strictEqual(plan(16.5), '2026-11-15');
  assert.strictEqual(plan(23.9), '2026-11-15');
  assert.strictEqual(plan(17, '2026-11-15'), null);
  // Just added before any window: today.
  assert.strictEqual(water.filterDay({ now: day - 0.5 * H, timeZone: TZ, cycles: CYCLES }), '2026-11-14');
  // One night cycle: after 06:00 the next day.
  assert.strictEqual(water.filterDay({ now: day + 7 * H, timeZone: TZ, cycles: [CYCLES[0]] }), '2026-11-15');
  assert.strictEqual(water.filterDay({ now: day + 7 * H, timeZone: TZ, cycles: [] }), null);
});

test('flowState: standby is still, the base load circulating, above halfway heating', () => {
  const levels = water.powerLevels({ heatW: 2700, baseW: 200 }, 3000);
  assert.strictEqual(water.flowState(0, levels), 'still');
  assert.strictEqual(water.flowState(40, levels), 'still');
  assert.strictEqual(water.flowState(200, levels), 'circulating');
  assert.strictEqual(water.flowState(2600, levels), 'heating');
  assert.strictEqual(water.flowState(null, levels), null);
});

// Runs stillStep minute by minute through [{ minutes, flow, raw }] phases; returns the learned results.
function runStill(phases, { start = 0, model = { heatRate: 1.6 }, inUseAt = () => false } = {}) {
  let state = null;
  let now = start;
  const learned = [];
  for (const phase of phases) {
    for (let i = 0; i < phase.minutes; i++) {
      const raw = typeof phase.raw === 'function' ? phase.raw(i) : phase.raw;
      const step = water.stillStep(state, { now, flow: phase.flow, raw, outdoor: 2, inUse: inUseAt(now), model });
      if (step.loss || step.mix) learned.push({ at: now, loss: step.loss, mix: step.mix });
      state = step.state;
      now += 60000;
    }
  }
  return { state, learned };
}

test('stillStep: a still stretch from the last mixed reading to the first mixed one after the pump starts', () => {
  // Pump runs (36.4 mixed), then still for 7 h reading 35.5 at the end, then a filter cycle heats: the reading drops to
  // the mixed 34.8 and rises 1.6 °C/h.
  const { learned, state } = runStill([
    { minutes: 30, flow: 'circulating', raw: 36.4 },
    { minutes: 7 * 60, flow: 'still', raw: 35.5 },
    { minutes: 30, flow: 'heating', raw: (i) => (i < 3 ? 35.5 - 0.25 * i : 34.8 + (1.6 * i) / 60) }
  ]);
  assert.strictEqual(learned.length, 1);
  const [{ loss, mix }] = learned;
  assert.ok(Math.abs(loss.hours - 7) < 1e-9);
  assert.strictEqual(loss.from, 36.4);
  // The mixed reading 15 minutes in, minus what the heater added meanwhile: about 34.8.
  assert.ok(Math.abs(loss.to - 34.8) < 0.03, String(loss.to));
  assert.strictEqual(loss.outdoor, 2);
  assert.strictEqual(mix.before, 35.5);
  // Heated from the first moving minute to the mixed reading 15 minutes later.
  assert.ok(Math.abs(mix.heatedHours - 16 / 60) < 1e-9);
  assert.ok(Math.abs(water.learnMix({ heatRate: 1.6 }, mix).value - 0.7) < 0.03);
  assert.strictEqual(state.phase, 'moving');
  // Learned as loss: 1.6 °C in 7 h at about 33.6 °C above the surroundings.
  const result = water.learn({ heatRate: 1.6, loss: 0.0092 }, { heating: false, ...loss });
  assert.strictEqual(result.learned, 'loss');
  assert.ok(result.value > 0.006 && result.value < 0.0075, String(result.value));
});

test('stillStep: no stretch without a mixed start, when the pump stops while mixing, or during a use', () => {
  // Starts still (after a restart): only the mixing after the pump starts, nothing learned.
  assert.strictEqual(runStill([{ minutes: 120, flow: 'still', raw: 36 }, { minutes: 30, flow: 'circulating', raw: 35.5 }]).learned.length, 0);
  // The pump stops 5 minutes after it started: the stretch is dropped.
  const stopped = runStill([
    { minutes: 30, flow: 'circulating', raw: 36.4 },
    { minutes: 180, flow: 'still', raw: 36 },
    { minutes: 5, flow: 'circulating', raw: 35.8 },
    { minutes: 60, flow: 'still', raw: 35.8 },
    { minutes: 30, flow: 'circulating', raw: 35.5 }
  ]);
  assert.strictEqual(stopped.learned.length, 0);
  // A use in the middle drops the stretch; a new one starts after it (minute 130 to the pump start at 330).
  const used = runStill(
    [
      { minutes: 30, flow: 'circulating', raw: 36.4 },
      { minutes: 300, flow: 'still', raw: 36 },
      { minutes: 30, flow: 'circulating', raw: 35.5 }
    ],
    { inUseAt: (now) => now > 100 * 60000 && now < 130 * 60000 }
  );
  assert.strictEqual(used.learned.length, 1);
  assert.ok(Math.abs(used.learned[0].loss.hours - 200 / 60) < 1e-9);
  // After a use the stirred water starts a stretch at once, also when the pump stops soon after.
  const after = runStill(
    [
      { minutes: 60, flow: 'circulating', raw: 37.5 },
      { minutes: 15, flow: 'circulating', raw: 37.2 },
      { minutes: 300, flow: 'still', raw: 36.5 },
      { minutes: 30, flow: 'circulating', raw: 36 }
    ],
    { inUseAt: (now) => now < 60 * 60000 }
  );
  assert.strictEqual(after.learned.length, 1);
  assert.strictEqual(after.learned[0].loss.from, 37.2);
  assert.ok(Math.abs(after.learned[0].loss.hours - 5) < 1e-9);
  // Circulating the whole time: nothing to learn the cooling from.
  assert.strictEqual(runStill([{ minutes: 600, flow: 'circulating', raw: 36 }]).learned.length, 0);
});

test('stillStep: a short still stretch gives the loss but not the mixing drop', () => {
  const { learned } = runStill([
    { minutes: 30, flow: 'circulating', raw: 36.4 },
    { minutes: 40, flow: 'still', raw: 36.3 },
    { minutes: 20, flow: 'circulating', raw: 36.2 }
  ]);
  assert.strictEqual(learned.length, 1);
  assert.ok(learned[0].loss);
  assert.strictEqual(learned[0].mix, null);
});

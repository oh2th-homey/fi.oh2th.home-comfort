'use strict';

/**
 * Pure Water Heater logic (spa / hot tub, issue #1): the learned heating curve, the use times, and the plan that decides
 * whether heating is demanded now. No Homey dependencies; reasons are returned as { code, args } and translated by the
 * caller.
 *
 * Model, per hour: heating adds heatRate °C, and the water loses loss × (water − outdoor) °C.
 * Both are learned from what happened (closed segments of heating and of waiting), starting from conservative values.
 */

const { midnight, addDays, localDate, utcOffset, strToMins } = require('oh2th-homey-helpers');

const QUARTER_MS = 15 * 60000;
const QUARTER_H = 0.25;
// Start values until learned: a slow heater and a well insulated spa. The latest safe start covers the error.
const DEFAULT_MODEL = { heatRate: 1.0, loss: 0.01, heatHours: 0, idleHours: 0, mixDrop: 0, mixCount: 0 };
// Learned enough to heat ahead in cheap quarters (pre-heating); before that only just in time.
const CONFIDENT_HEAT_HOURS = 2;
const CONFIDENT_IDLE_HOURS = 12;
// Shortest segments worth learning from, and the smallest change that is more than sensor resolution.
const MIN_HEAT_HOURS = 0.5;
const MIN_IDLE_HOURS = 2;
const MIN_DELTA = 0.5;
// Learning never trusts one segment alone; at least this weight for a new one, so the model can follow change.
const MIN_WEIGHT = 0.1;
// Power meter: readings up to this are standby, not a running pump; levels move by this share per reading.
const MIN_RUNNING_W = 50;
const POWER_WEIGHT = 0.05;
// Latest safe start: a slower heater and faster losses than learned, while little is learned. The doubt shrinks as
// heating and waiting are seen, down to the learned curve itself after EXACT_*_HOURS.
const PESSIMISTIC_RATE = 0.8;
const PESSIMISTIC_LOSS = 1.25;
const EXACT_HEAT_HOURS = 6;
const EXACT_IDLE_HOURS = 24;
// The device plans at least this often: a start due before the next check starts now.
const CHECK_MS = 5 * 60000;
// Plan grid and horizon.
const GRID = 0.1;
const HORIZON_MS = 48 * 60 * 60 * 1000;
// A plan that switches on and off every quarter pays this share of a quarter's energy per switch.
const SWITCH_PENALTY = 0.5;
// Missing a use by 1 °C costs more than any heating could.
const MISS_PENALTY = 1e6;
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
// Ready reached this close to a use is held until the use ends (default of the Hold before use setting).
const HOLD_BEFORE_MINUTES = 120;
// Ready this long before each use starts (setting Ready ahead, 0–30 minutes).
const READY_AHEAD_MINUTES = 15;
// Heating for keep stops this far above it.
const KEEP_BAND = 0.5;
/**
 * @description Learn the temperature the tub's own filter cycles heat to: where its heater stopped with the pump still
 * running and no demand from this device. A running average, so one odd stop doesn't move it far.
 * @returns {number|null}
 */
function learnFilterTarget(stored, value) {
  if (!finite(value)) return finite(stored) ? stored : null;
  if (!finite(stored)) return value;
  return stored + 0.3 * (value - stored);
}

/**
 * @description The tub's own set point is at most the water temperature when a filter cycle passed without heating:
 * lower the learned filter target to it at once (lower is the safe side: the plan then counts on less free heat).
 * @returns {number|null}
 */
function lowerFilterTarget(stored, temperature) {
  if (!finite(stored)) return null;
  return finite(temperature) ? Math.min(stored, temperature) : stored;
}

/**
 * @description Watch the planned filter cycles, one minute at a time (with a power meter): whether the pump ran and
 * whether the heater heated in each. A cycle that ran without heating, demand from this device or bathing ends with
 * unheated: the tub's own heater didn't need to heat.
 * @param {Object|null} watch The cycle being watched, from the previous call
 * @param {Object} opts { now, cycles: [{ start, end }], flow: 'still' | 'circulating' | 'heating', demanded, inUse }
 * @returns {Object} { watch, unheated }
 */
function filterWatchStep(watch, { now, cycles = [], flow, demanded = false, inUse = false }) {
  const running = cycles.find((c) => c.start <= now && now < c.end) || null;
  let next = watch;
  let ended = null;
  if (next && (!running || running.start !== next.start)) {
    ended = next;
    next = null;
  }
  if (running && !next) next = { start: running.start, end: running.end, pumped: false, disturbed: false };
  if (next) next = { ...next, pumped: next.pumped || flow === 'circulating' || flow === 'heating', disturbed: next.disturbed || flow === 'heating' || demanded || inUse };
  return { watch: next, unheated: !!ended && ended.pumped && !ended.disturbed };
}

// Water standing still this long reads high by the mixing drop (also the device's STILL_MS).
const STILL_MS = 60 * 60000;
// Heater problem: demanded for this long without the water warming by PROBLEM_RISE (°C).
const PROBLEM_HOURS = 1.5;
const PROBLEM_RISE = 0.3;
// With a power meter: demanded this long without the meter showing heating power is a problem too.
const NO_POWER_MS = 10 * 60000;

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

/**
 * @description The model to use: stored values when valid, else the defaults.
 */
function model(stored) {
  const m = { ...DEFAULT_MODEL, ...(stored || {}) };
  if (!finite(m.heatRate) || m.heatRate <= 0) m.heatRate = DEFAULT_MODEL.heatRate;
  if (!finite(m.loss) || m.loss < 0) m.loss = DEFAULT_MODEL.loss;
  if (!finite(m.mixDrop) || m.mixDrop < 0) m.mixDrop = 0;
  return m;
}

/**
 * @description Learned enough for pre-heating in cheap quarters.
 */
function confident(m) {
  return m.heatHours >= CONFIDENT_HEAT_HOURS && m.idleHours >= CONFIDENT_IDLE_HOURS;
}

/**
 * @description Learn from one closed segment of heating or waiting.
 * @param {Object} stored - The model
 * @param {Object} segment - { heating, hours, from, to (water °C), outdoor (mean °C) }
 * @returns {Object} { model, learned: 'heat' | 'loss' | null, value }
 */
function learn(stored, { heating, hours, from, to, outdoor }) {
  const m = model(stored);
  if (!finite(hours) || !finite(from) || !finite(to) || !finite(outdoor)) return { model: m, learned: null };
  const slope = (to - from) / hours;
  const above = (from + to) / 2 - outdoor;
  if (heating) {
    if (hours < MIN_HEAT_HOURS || to - from < MIN_DELTA) return { model: m, learned: null };
    const value = slope + m.loss * Math.max(0, above);
    if (value <= 0 || value > 20) return { model: m, learned: null };
    const weight = Math.max(MIN_WEIGHT, hours / (m.heatHours + hours));
    return { model: { ...m, heatRate: m.heatRate + weight * (value - m.heatRate), heatHours: m.heatHours + hours }, learned: 'heat', value };
  }
  // Waiting: only a clear drop over a long enough time, with the water well above the surroundings.
  if (hours < MIN_IDLE_HOURS || above < 5 || from - to < MIN_DELTA) return { model: m, learned: null };
  const value = -slope / above;
  if (value <= 0 || value > 0.2) return { model: m, learned: null };
  const weight = Math.max(MIN_WEIGHT, hours / (m.idleHours + hours));
  return { model: { ...m, loss: m.loss + weight * (value - m.loss), idleHours: m.idleHours + hours }, learned: 'loss', value };
}

/**
 * @description Learn the mixing drop: water standing still is warmest at the top, so a sensor near the surface reads
 * high until the circulation mixes it. Seen when heating starts after standing still: the reading before, and the one
 * after the mixing (minus what the heater added meanwhile).
 * @param {Object} stored - The model
 * @param {Object} seen - { before (°C, still), after (°C, mixed), heatedHours }
 * @returns {Object} { model, value } (value null when not learned)
 */
function learnMix(stored, { before, after, heatedHours }) {
  const m = model(stored);
  if (!finite(before) || !finite(after) || !finite(heatedHours)) return { model: m, value: null };
  const value = Math.max(0, before - (after - m.heatRate * heatedHours));
  if (value > 5) return { model: m, value: null };
  const weight = Math.max(0.2, 1 / (m.mixCount + 1));
  return { model: { ...m, mixDrop: m.mixDrop + weight * (value - m.mixDrop), mixCount: m.mixCount + 1 }, value };
}

// A tank's thermostat stop counts as full only this close to the full temperature (°C): further below, the element was
// switched off early by something else (e.g. a safety timer in the relay).
const FULL_MARGIN = 3;
// After the thermostat stopped it, the tank counts as full until it has cooled or been drawn this much (°C).
const FULL_HOLD = 1;

/**
 * @description The heater stopped by itself while heating was demanded: its thermostat found the tank full, when the
 * tank is near the full temperature learned so far (or the target temperature, before any).
 */
function fullStop(temperature, full, target) {
  if (!finite(temperature)) return false;
  const reference = finite(full) ? full : target;
  return finite(reference) && temperature >= reference - FULL_MARGIN;
}

/**
 * @description Still full since the thermostat stopped the heater: not cooled or drawn by more than FULL_HOLD.
 * @param {Object|null} fullAt { temperature, at } at the stop
 */
function stillFull(fullAt, temperature) {
  return !!fullAt && finite(fullAt.temperature) && finite(temperature) && temperature >= fullAt.temperature - FULL_HOLD;
}

// A hot water tank's temperature positions, top to bottom (Water Heater).
const TANK_POSITIONS = ['top', 'middle', 'bottom'];

/**
 * @description A tank's temperatures from its sensors at up to three heights (each null when not installed or stale):
 * the average, which follows the heat stored, to plan and learn with, and the top, which is the hot water at the tap,
 * for Keep (the average when there is no top reading).
 * @param {Object} readings { top, middle, bottom } in °C or null
 * @returns {Object} { average, keepAt } in °C (0.1), null when no reading
 */
function tankTemperature(readings = {}) {
  const values = TANK_POSITIONS.map((position) => readings[position]).filter(finite);
  if (values.length === 0) return { average: null, keepAt: null };
  const average = Math.round((values.reduce((sum, v) => sum + v, 0) / values.length) * 10) / 10;
  return { average, keepAt: finite(readings.top) ? readings.top : average };
}

/**
 * @description The temperature to plan with: while the water stands still, the reading minus the learned mixing drop.
 */
function mixedTemperature(reading, m, still) {
  if (!finite(reading)) return null;
  return still ? Math.round((reading - model(m).mixDrop) * 10) / 10 : reading;
}

/**
 * @description Water temperature after hours of heating or waiting (small Euler steps).
 */
function project(temperature, outdoor, hours, heating, m) {
  let t = temperature;
  const steps = Math.max(1, Math.ceil(hours / QUARTER_H));
  const h = hours / steps;
  for (let i = 0; i < steps; i++) t += ((heating ? m.heatRate : 0) - m.loss * (t - outdoor)) * h;
  return t;
}

/**
 * @description Hours of continuous heating from temperature to target, Infinity when the heater can't reach it.
 */
function hoursToHeat(temperature, target, outdoor, m) {
  if (temperature >= target) return 0;
  // Equilibrium while heating: the heater can't go above it.
  if (m.loss > 0 && outdoor + m.heatRate / m.loss <= target) return Infinity;
  let t = temperature;
  let hours = 0;
  while (t < target && hours < 72) {
    t += (m.heatRate - m.loss * (t - outdoor)) * (QUARTER_H / 4);
    hours += QUARTER_H / 4;
  }
  return t >= target ? hours : Infinity;
}

/**
 * @description How far the learned curve is trusted for timing, 0 (nothing seen) to 1 (EXACT_*_HOURS of heating and
 * waiting seen).
 */
function exactness(m) {
  const heat = finite(m.heatHours) ? m.heatHours / EXACT_HEAT_HOURS : 0;
  const idle = finite(m.idleHours) ? m.idleHours / EXACT_IDLE_HOURS : 0;
  return Math.max(0, Math.min(1, heat, idle));
}

/**
 * @description The curve for the latest safe start: slower heating and faster losses than learned, by less the more
 * is learned.
 */
function pessimistic(m) {
  const doubt = 1 - exactness(m);
  return { ...m, heatRate: m.heatRate * (1 - (1 - PESSIMISTIC_RATE) * doubt), loss: m.loss * (1 + (PESSIMISTIC_LOSS - 1) * doubt) };
}

/**
 * @description A local date and time as an instant (DST safe: the offset at that time, not at midnight).
 */
function localMs(timeZone, date, minutes) {
  const [y, mo, d] = date.split('-').map(Number);
  const utc = Date.UTC(y, mo - 1, d, Math.floor(minutes / 60), minutes % 60);
  const guess = utc - utcOffset(timeZone, utc);
  return utc - utcOffset(timeZone, guess);
}

/**
 * @description The uses from now to the horizon: the weekly schedule plus one-offs, minus skipped ones. A use that is
 * running now is included.
 * @param {Object} opts.schedule - { time: 'HH:MM' | '', days: { mon: true, … }, minutes }
 * @param {Array} opts.oneOffs - [{ start (ms), minutes }]
 * @param {Array} opts.skipped - Start times (ms) of skipped uses
 * @returns {Array} [{ start, end, oneOff }] sorted by start
 */
function uses({ now, timeZone, schedule = {}, oneOffs = [], skipped = [], horizon = HORIZON_MS }) {
  const result = [];
  const minutes = finite(schedule.minutes) && schedule.minutes > 0 ? schedule.minutes : 60;
  const time = schedule.time ? strToMins(schedule.time) : null;
  if (finite(time)) {
    const today = localDate(timeZone, now);
    for (let n = -1; n <= Math.ceil(horizon / 86400000) + 1; n++) {
      const date = addDays(today, n);
      const [y, mo, d] = date.split('-').map(Number);
      const day = DAYS[(new Date(Date.UTC(y, mo - 1, d)).getUTCDay() + 6) % 7];
      if (schedule.days && schedule.days[day] === false) continue;
      const start = localMs(timeZone, date, time);
      result.push({ start, end: start + minutes * 60000, oneOff: false });
    }
  }
  for (const use of oneOffs) {
    if (finite(use.start)) result.push({ start: use.start, end: use.start + (finite(use.minutes) && use.minutes > 0 ? use.minutes : minutes) * 60000, oneOff: true });
  }
  return result
    .filter((use) => use.end > now && use.start <= now + horizon && !skipped.includes(use.start))
    .sort((a, b) => a.start - b.start)
    .filter((use, i, list) => i === 0 || use.start !== list[i - 1].start);
}

/**
 * @description Price of each quarter from now: [{ start, price }], unknown prices null. Slots of 30 or 60 minutes are
 * split into quarters.
 * @param {Array<number|null>} prices - Slot timeline (lib/prices.js timeline)
 * @param {number} startMs - Start of the timeline's first slot
 * @param {number} resolution - Slot minutes
 */
function quarterPrices(prices, startMs, resolution, now, horizon = HORIZON_MS) {
  const result = [];
  const first = Math.floor(now / QUARTER_MS) * QUARTER_MS;
  for (let q = first; q < now + horizon; q += QUARTER_MS) {
    const slot = Math.floor((q - startMs) / (resolution * 60000));
    const price = slot >= 0 && slot < prices.length ? prices[slot] : null;
    result.push({ start: q, price: finite(price) ? price : null });
  }
  return result;
}

/**
 * @description Share of [from, to) inside filter cycles ([{ start, end }], ms).
 */
function filterShare(filters, from, to) {
  let inside = 0;
  for (const f of filters || []) inside += Math.max(0, Math.min(to, f.end) - Math.max(from, f.start));
  return Math.min(1, inside / (to - from));
}

/**
 * @description One step of waiting: the water cools, and during a filter cycle the tub's own heater warms it up to
 * filterTarget (the temperature its filter cycles were seen to heat to; unknown: no heat counted).
 * @returns {Object} { after (°C), heatedHours }
 */
function idleStep(t, outdoor, m, hours, share, filterTarget) {
  const after = t - m.loss * (t - outdoor) * hours;
  if (!(share > 0) || !finite(filterTarget) || t >= filterTarget) return { after, heatedHours: 0 };
  const heated = Math.min(filterTarget, after + m.heatRate * hours * share);
  return heated > after ? { after: heated, heatedHours: (heated - after) / m.heatRate } : { after, heatedHours: 0 };
}

/**
 * @description Water temperature after waiting from fromMs to toMs, filter cycles included.
 */
function projectIdle(temperature, outdoor, fromMs, toMs, m, filters = [], filterTarget = null) {
  let t = temperature;
  for (let at = fromMs; at < toMs; at += QUARTER_MS) {
    const end = Math.min(toMs, at + QUARTER_MS);
    t = idleStep(t, outdoor, m, (end - at) / 3600000, filterShare(filters, at, end), filterTarget).after;
  }
  return t;
}

/**
 * @description Minutes until the water reaches target by the learned curve, 0 when there, null when it can't get there.
 */
function minutesToHeat(temperature, target, outdoor, stored) {
  if (!finite(temperature) || !finite(target)) return null;
  const hours = hoursToHeat(temperature, target, finite(outdoor) ? outdoor : 5, model(stored));
  return Number.isFinite(hours) ? Math.ceil(hours * 60) : null;
}

/**
 * @description One heating block for a heater that runs its own schedule (Water Heater): whole quarters, long enough to
 * heat from where the water will have cooled to by the ready time up to the target by the pessimistic curve, plus a
 * quarter (none when it is still within FULL_HOLD of the target by then), at most maxMinutes, at the cheapest place between from and readyBy (later on a tie: less cooling after it).
 * Unknown prices count as the mean of the known ones; with none known, the latest block.
 * @returns {Object} { runs, start, end, minutes, price } (ms; runs false and the rest null: nothing to heat)
 */
function heatingBlock({ from, readyBy, quarters = [], temperature, target, outdoor, model: stored, maxMinutes = 180 }) {
  const none = { runs: false, start: null, end: null, minutes: 0, price: null };
  if (!finite(temperature) || !finite(target) || !finite(from) || !finite(readyBy) || readyBy <= from) return none;
  const surroundings = finite(outdoor) ? outdoor : 5;
  const m = model(stored);
  const coolest = projectIdle(temperature, surroundings, from, readyBy, m);
  // Within FULL_HOLD of the target by then: still full, the thermostat would stop the heater at once.
  if (coolest >= target - FULL_HOLD) return none;
  const hours = hoursToHeat(coolest, target, surroundings, pessimistic(m));
  const first = Math.ceil(from / QUARTER_MS) * QUARTER_MS;
  const room = Math.floor((readyBy - first) / QUARTER_MS);
  if (room < 1) return none;
  const needed = Number.isFinite(hours) ? Math.ceil(hours * 4) + 1 : Infinity;
  const span = Math.max(1, Math.min(needed, Math.floor(maxMinutes / 15), room));
  const known = quarters.filter((q) => finite(q.price));
  const mean = known.length ? known.reduce((sum, q) => sum + q.price, 0) / known.length : 0;
  const prices = new Map(known.map((q) => [q.start, q.price]));
  let best = null;
  for (let i = 0; i + span <= room; i++) {
    const start = first + i * QUARTER_MS;
    let sum = 0;
    for (let k = 0; k < span; k++) sum += prices.has(start + k * QUARTER_MS) ? prices.get(start + k * QUARTER_MS) : mean;
    const price = sum / span;
    if (!best || price <= best.price) best = { start, price };
  }
  return { runs: true, start: best.start, end: best.start + span * QUARTER_MS, minutes: span * 15, price: known.length ? best.price : null };
}

/**
 * @description When the water is expected at target by the learned curve: heating now, from now; waiting for a start,
 * cooling (and warmed by filter cycles) until it and heating from there. { minutes: while heating, readyAt } (ms);
 * readyAt = now when already there, null when nothing is planned or it can't get there.
 */
function readyEstimate({ now, temperature, target, outdoor, model: stored, demand, nextStart = null, filters = [], filterTarget = null }) {
  if (!finite(temperature) || !finite(target)) return { minutes: null, readyAt: null };
  if (demand) {
    const minutes = minutesToHeat(temperature, target, outdoor, stored);
    return { minutes, readyAt: minutes === null ? null : now + minutes * 60000 };
  }
  if (temperature >= target) return { minutes: null, readyAt: now };
  if (!finite(nextStart) || nextStart <= now) return { minutes: null, readyAt: null };
  const surroundings = finite(outdoor) ? outdoor : 5;
  const atStart = projectIdle(temperature, surroundings, now, nextStart, model(stored), filters, filterTarget);
  const minutes = minutesToHeat(atStart, target, surroundings, stored);
  return { minutes: null, readyAt: minutes === null ? null : nextStart + minutes * 60000 };
}

/**
 * @description The mean of the known prices of the quarters overlapping from–to, null when none is known.
 */
function meanPrice(quarters, from, to) {
  const prices = quarters.filter((q) => q.start + QUARTER_MS > from && q.start < Math.max(to, from + 1) && finite(q.price)).map((q) => q.price);
  return prices.length ? prices.reduce((sum, p) => sum + p, 0) / prices.length : null;
}

/**
 * @description Too late when heating starts at time t: waiting until then (cooling by the learned curve, warmed by
 * filter cycles at the pessimistic rate) and heating by the pessimistic curve misses target at start.
 */
function lateAt(t, { temperature, target, outdoor, m, now, start, filters, filterTarget }) {
  const slow = pessimistic(m);
  const waited = projectIdle(temperature, outdoor, now, t, { heatRate: slow.heatRate, loss: m.loss }, filters, filterTarget);
  return t + hoursToHeat(waited, target, outdoor, slow) * 3600000 >= start;
}

/**
 * @description When heating will start at the latest: the first check (every CHECK_MS on the clock) at which waiting
 * to the next check would be too late, counting the water cooling until then by the learned curve (re-checked against
 * the real temperature at every check) and the filter cycles warming it. now when it must start now.
 * @returns {number} ms
 */
function latestStart(temperature, target, outdoor, m, now, start, filters = [], filterTarget = null) {
  const opts = { temperature, target, outdoor, m, now, start, filters, filterTarget };
  if (start <= now || lateAt(now + CHECK_MS, opts)) return now;
  // Filter cycles can warm the water while waiting, so later isn't always later: scan the checks in order.
  for (let t = Math.ceil(now / CHECK_MS) * CHECK_MS; t < start; t += CHECK_MS) {
    if (t > now && lateAt(t + CHECK_MS, opts)) return t;
  }
  return now;
}

/**
 * @description Latest safe start: heat now when waiting to the next check would be too late (or the time is here).
 */
function mustStart(temperature, target, outdoor, m, now, start, filters = [], filterTarget = null) {
  return start <= now || lateAt(now + CHECK_MS, { temperature, target, outdoor, m, now, start, filters, filterTarget });
}

/**
 * @description The cheapest heating plan over the known quarters: dynamic programming over quarters × water
 * temperatures (0.1 °C), heating or not in each quarter. Never below keep (heats when below; null = no keep), never heats at or above
 * max, at least ready at the start of each use and while it lasts. Unknown prices count as the mean of the known ones.
 * Switching on or off costs a little, so the plan doesn't switch every quarter. During filter cycles the tub heats on its
 * own up to filterTarget, also without demand (paid, but not chosen).
 * @returns {Object|null} { heat: [boolean per quarter], cost, kWh, temps: [°C at each quarter start] } or null when
 * nothing to plan
 */
function optimise({ temperature, outdoor, m, quarters, useList, keep, ready, max, powerW, heatingNow, filters = [], filterTarget = null }) {
  const n = quarters.length;
  if (n === 0) return null;
  const known = quarters.map((q) => q.price).filter(finite);
  const mean = known.length ? known.reduce((sum, p) => sum + p, 0) / known.length : 0;
  const kWh = (powerW > 0 ? powerW : 1000) / 1000 / 4;
  const penalty = SWITCH_PENALTY * Math.max(mean, 0.001) * kWh;
  const lo = Math.floor(Math.min(finite(keep) ? keep - 2 : Infinity, temperature - 1, outdoor + 1) / GRID);
  const hi = Math.ceil((max + 1) / GRID);
  const size = hi - lo + 1;
  const index = (t) => Math.min(size - 1, Math.max(0, Math.round(t / GRID) - lo));
  // Required temperature at each quarter start: ready during a use (from the quarter its start falls in).
  const need = quarters.map((q) => (useList.some((use) => q.start + QUARTER_MS > use.start && q.start < use.end) ? ready : -Infinity));
  const shares = quarters.map((q) => filterShare(filters, q.start, q.start + QUARTER_MS));
  // One quarter from t: the temperature after it and the heater's share of the quarter.
  const move = (t, heat, i) => {
    if (heat) return { after: t + (m.heatRate - m.loss * (t - outdoor)) * QUARTER_H, on: 1 };
    const { after, heatedHours } = idleStep(t, outdoor, m, QUARTER_H, shares[i], filterTarget);
    return { after, on: heatedHours / QUARTER_H };
  };
  // cost[s][a]: cheapest cost from quarter i on, at temperature index s, with action a in the quarter before.
  let next = Array.from({ length: size }, () => [0, 0]);
  const choice = [];
  for (let i = n - 1; i >= 0; i--) {
    const price = finite(quarters[i].price) ? quarters[i].price : mean;
    const current = Array.from({ length: size }, () => [Infinity, Infinity]);
    const pick = Array.from({ length: size }, () => [false, false]);
    for (let s = 0; s < size; s++) {
      const t = (s + lo) * GRID;
      const miss = need[i] > t ? MISS_PENALTY * (need[i] - t) : 0;
      for (let prev = 0; prev < 2; prev++) {
        let best = Infinity;
        let bestHeat = false;
        for (const heat of [false, true]) {
          const { after, on } = move(t, heat, i);
          // Maximum is a hard limit, also for the plan: no quarter of heating that would end above it.
          if (heat && (t >= max || after > max)) continue;
          // Waiting may not take the water below keep; heating is then the only choice.
          if (!heat && finite(keep) && after < keep && t < max) continue;
          const value = price * kWh * on + ((heat ? 1 : 0) !== prev ? penalty : 0) + next[index(after)][heat ? 1 : 0];
          if (value < best) {
            best = value;
            bestHeat = heat;
          }
        }
        current[s][prev] = best + miss;
        pick[s][prev] = bestHeat;
      }
    }
    choice[i] = pick;
    next = current;
  }
  // Follow the choices from now.
  const heat = [];
  const temps = [];
  let t = temperature;
  let prev = heatingNow ? 1 : 0;
  let cost = 0;
  let energy = 0;
  for (let i = 0; i < n; i++) {
    temps.push(round1(t));
    const on = choice[i][index(t)][prev];
    heat.push(on);
    if (on) {
      cost += (finite(quarters[i].price) ? quarters[i].price : mean) * kWh;
      energy += kWh;
    }
    // The tub's own filter heating is in the temperatures, not in the demanded cost and energy.
    t = move(t, on, i).after;
    prev = on ? 1 : 0;
  }
  return { heat, cost, kWh: energy, temps };
}

/**
 * @description Decide whether heating is demanded now.
 * @param {Object} opts
 * @param {number} opts.now - ms
 * @param {number|null} opts.temperature - Water °C
 * @param {number|null} opts.outdoor - Surroundings °C
 * @param {Object} opts.model - Learned model (stored)
 * @param {Array} opts.quarters - [{ start, price }] from now (quarterPrices); prices may be null
 * @param {Array} opts.useList - From uses()
 * @param {Object|null} opts.block - A heating block planned for the next ready time { ready (its start), runs, start, end }
 *   (heatingBlock): heating for it happens only inside the block, instead of the price plan
 * @param {boolean} opts.reheat - Heating to full after the tank fell below Keep (a tank: Keep is a reheat level), until
 *   the thermostat stops the heater or the target temperature is reached
 * @param {number|null} opts.keepAt - The reading Keep is compared with, when it isn't the planned temperature (a tank:
 *   its top sensor). Keep then doesn't bound the plan: the average may fall below Keep while the top is still hot.
 * @param {number|null} opts.keep - Never below (°C); null = no keep: between uses the heater is left to its own controls
 *   (a tub's filter cycles), the reasons then say nothing of keep
 * @param {number} opts.ready - At each use (°C)
 * @param {number} opts.max - Never heat at or above (°C)
 * @param {number} opts.powerW - Heater power (W), for the energy and cost of a quarter
 * @param {number|null} opts.priceLimit - Skip a use whose heating costs more per kWh; null = always heat
 * @param {boolean} opts.heatingNow - Demand is on now
 * @param {number} opts.holdBefore - Minutes before a use from which ready, once reached, is held
 * @param {number} opts.readyAhead - Minutes before each use to be ready by
 * @param {number|null} opts.reachedFor - Start of the use that ready was already reached for (from the last result)
 * @param {Array} opts.filters - The tub's filter cycles ahead [{ start, end }] (ms)
 * @param {number|null} opts.filterTarget - The temperature filter cycles heat the water to (learned), null = unknown
 * @returns {Object} { demand, reason: { code, args }, use, expected, nextStart, until, skip, skipPrice (mean per kWh
 * compared with the limit), plan, reachedFor }
 */
function decide({
  now,
  temperature,
  outdoor,
  model: stored,
  quarters = [],
  useList = [],
  keep,
  keepAt = null,
  reheat = false,
  block = null,
  ready,
  max,
  powerW,
  priceLimit = null,
  heatingNow = false,
  holdBefore = HOLD_BEFORE_MINUTES,
  readyAhead = READY_AHEAD_MINUTES,
  reachedFor = null,
  filters = [],
  filterTarget = null
}) {
  const m = model(stored);
  const hasKeep = finite(keep);
  // The reading Keep is held on: the planned temperature, or (a tank) its own reading.
  const keepReading = finite(keepAt) ? keepAt : temperature;
  // Reasons that name keep have a variant without it.
  const idleCode = (code) => (hasKeep ? code : `${code}_no_keep`);
  const use = useList.find((u) => u.end > now) || null;
  // Once ready is reached shortly before the next use, it is held until that use ends. Reached earlier (pre-heated in
  // cheap hours), the plan decides: it still has the water ready at the start.
  const reached = !!use && (reachedFor === use.start || (finite(temperature) && temperature >= ready && now >= use.start - (finite(holdBefore) ? holdBefore : HOLD_BEFORE_MINUTES) * 60000));
  const base = { use, expected: null, nextStart: null, until: null, skip: false, plan: null, reachedFor: reached ? use.start : null };
  if (!finite(temperature)) return { ...base, demand: false, reason: { code: 'no_temperature', args: {} } };
  // The caller passes the surroundings (outdoor, a room or a fixed temperature); unknown counts as cold.
  const surroundings = finite(outdoor) ? outdoor : 5;
  // Timing and the plan aim at ready this long before each use starts.
  const aheadMs = Math.min(30, Math.max(0, finite(readyAhead) ? readyAhead : READY_AHEAD_MINUTES)) * 60000;
  const readyBy = use ? use.start - aheadMs : null;
  if (temperature >= max) return { ...base, demand: false, reason: { code: 'at_max', args: { max } } };
  // A tank below Keep is heated to full (it decided that earlier): the hot water at the tap, and the hygiene heating.
  if (reheat && temperature < ready) return { ...base, demand: true, reason: { code: 'reheat', args: { target: ready } } };
  // Below keep: heat back to keep plus a small band (the plan below holds keep with its own grid).
  if (hasKeep && keepReading < keep) return { ...base, demand: true, reason: { code: 'below_keep', args: { keep } } };
  if (use && (use.start <= now || reached)) {
    // In use, or ready reached before it: hold ready to the end of the use, with a small band so it doesn't switch on every report.
    const demand = temperature < ready - (heatingNow ? 0 : 0.5);
    const code = use.start <= now ? 'in_use' : 'ready_hold';
    return { ...base, demand, reason: { code: demand ? `${code}_heat` : code, args: { until: use.end, ready: use.start, target: ready } } };
  }

  // A heating block planned for this ready time (a heater on its own schedule): heat inside it, nowhere else.
  if (use && block && block.ready === use.start) {
    const inside = block.runs && now >= block.start && now < block.end && temperature < ready;
    const args = { ready: use.start, start: block.start, until: block.end };
    if (inside) return { ...base, demand: true, nextStart: now, until: block.end, reason: { code: 'block_heat', args } };
    if (block.runs && now < block.start) return { ...base, demand: false, nextStart: block.start, until: block.end, reason: { code: 'block_wait', args } };
    return { ...base, demand: false, reason: { code: 'block_done', args } };
  }

  const hasPrices = quarters.some((q) => finite(q.price));
  const learned = confident(m);
  // Without prices or before the curve is known: just in time for the next use (latest safe start), nothing ahead.
  if (!hasPrices || !learned) {
    const code = hasPrices ? 'learning' : 'no_prices';
    const keeping = hasKeep && heatingNow && keepReading < keep + KEEP_BAND;
    if (!use) return { ...base, demand: keeping, reason: keeping ? { code: 'keep_heat', args: { keep } } : { code: idleCode(`${code}_idle`), args: { keep } } };
    const hours = hoursToHeat(temperature, ready, surroundings, pessimistic(m));
    // Once started, keep heating to ready: the real heater is faster than the pessimistic one, which would stop and start.
    const start = mustStart(temperature, ready, surroundings, m, now, readyBy, filters, filterTarget) || (heatingNow && readyBy - now <= 2 * hours * 3600000 + QUARTER_MS);
    const forUse = start && temperature < ready;
    const demand = forUse || keeping;
    // Shown as the start: the latest start, counting the cooling until then, at the check that will start it.
    const latest = latestStart(temperature, ready, surroundings, m, now, readyBy, filters, filterTarget);
    const nextStart = forUse ? now : Math.max(now, latest);
    // Price limit: decided before heating for the use starts (no stop halfway), on the mean price from the start to ready.
    if (hasPrices && finite(priceLimit) && !(heatingNow && forUse)) {
      const price = meanPrice(quarters, nextStart, readyBy);
      if (price !== null && price > priceLimit) {
        const skipped = { ...base, demand: keeping, skip: true, skipPrice: price, nextStart: null };
        if (keeping) return { ...skipped, reason: { code: 'keep_heat', args: { keep } } };
        return { ...skipped, reason: { code: 'skipped', args: { ready: use.start, limit: priceLimit, keep } } };
      }
    }
    // Heating only to hold keep: say so, with the use still ahead.
    if (!forUse && keeping) return { ...base, demand, nextStart, reason: { code: 'keep_heat', args: { keep } } };
    return { ...base, demand, nextStart, reason: { code: demand ? `${code}_heat` : code, args: { ready: use.start, start: nextStart } } };
  }

  // No keep and no ready time ahead: the heater's own controls hold the water (filter cycles), nothing to plan for.
  if (!use && !hasKeep) return { ...base, demand: false, reason: { code: idleCode('idle'), args: { keep } } };
  // Plan to the end of the last use in the horizon, at least the next 12 hours (to hold keep cheaply).
  const end = Math.max(now + 12 * 3600000, ...useList.map((u) => u.end));
  const window = quarters.filter((q) => q.start < end);
  const run = (list) => optimise({ temperature, outdoor: surroundings, m, quarters: window, useList: list.map((u) => ({ ...u, start: u.start - aheadMs })), keep: finite(keepAt) ? null : keep, ready, max, powerW, heatingNow, filters, filterTarget });
  let plan = run(useList);
  let skip = false;
  let skipPrice = null;
  // Price limit: when heating for the next use costs more per kWh than the limit, skip it (keep still holds).
  if (use && finite(priceLimit) && plan && plan.kWh > 0) {
    const before = window.findIndex((q) => q.start >= use.start);
    const upTo = before < 0 ? window.length : before;
    let cost = 0;
    let energy = 0;
    const kWh = (powerW > 0 ? powerW : 1000) / 4000;
    for (let i = 0; i < upTo; i++) {
      if (!plan.heat[i]) continue;
      cost += (finite(window[i].price) ? window[i].price : 0) * kWh;
      energy += kWh;
    }
    if (energy > 0 && cost / energy > priceLimit) {
      skip = true;
      skipPrice = cost / energy;
      plan = run(useList.filter((u) => u !== use));
    }
  }
  if (!plan) return { ...base, demand: false, reason: { code: idleCode('idle'), args: { keep } } };

  // Latest safe start always wins over the plan.
  const safe = !!use && !skip && mustStart(temperature, ready, surroundings, m, now, readyBy, filters, filterTarget) && temperature < ready;
  const demand = plan.heat[0] || safe;
  const startIndex = plan.heat.findIndex((h) => h);
  const stopIndex = demand ? plan.heat.findIndex((h, i) => i > 0 && !h) : -1;
  const atUse = use ? window.findIndex((q) => q.start >= use.start) : -1;
  const result = {
    ...base,
    demand,
    safe,
    skip,
    skipPrice,
    plan,
    nextStart: startIndex >= 0 ? window[startIndex].start : null,
    until: stopIndex > 0 ? window[stopIndex].start : null,
    expected: atUse >= 0 ? plan.temps[atUse] : null
  };
  if (safe && !plan.heat[0]) return { ...result, reason: { code: 'safe_start', args: { ready: use.start } } };
  if (skip) return { ...result, reason: { code: demand ? idleCode('skipped_heat') : 'skipped', args: { ready: use.start, limit: priceLimit, keep } } };
  if (demand) return { ...result, reason: use ? { code: 'heating', args: { ready: use.start, until: result.until } } : { code: 'heating_keep', args: { keep } } };
  if (use) return { ...result, reason: { code: 'waiting', args: { ready: use.start, start: result.nextStart } } };
  return { ...result, reason: { code: idleCode('idle'), args: { keep } } };
}

/**
 * Power levels seen on the power meter: the base load (circulation pump, filter, ozone; standby below MIN_RUNNING_W is
 * left out) and heating (the heater with whatever runs with it). Each is a running average; a reading is counted to the
 * level it is nearer to, so the split between them follows what the meter really shows.
 * @param {Object} stored - { heatW, baseW } as learned so far (either may be missing)
 * @param {number} ratedW - The heater power from the settings, until heating has been seen
 * @returns {Object} { heatW, baseW, threshold } (W)
 */
function powerLevels(stored, ratedW) {
  const s = stored || {};
  const heatW = finite(s.heatW) && s.heatW > 0 ? s.heatW : ratedW;
  const baseW = finite(s.baseW) && s.baseW > 0 ? s.baseW : 0;
  return { heatW, baseW, threshold: Math.max(MIN_RUNNING_W, (heatW + baseW) / 2) };
}

/**
 * @description Learn from one power reading: nearer heating moves the heating level, else the base level.
 * @returns {Object} { heatW, baseW } to store, and heating (whether this reading is heating)
 */
function learnPower(stored, watts, ratedW) {
  const s = stored || {};
  const { heatW, baseW, threshold } = powerLevels(s, ratedW);
  if (!finite(watts) || watts <= MIN_RUNNING_W) return { heatW: s.heatW, baseW: s.baseW, heating: false };
  const move = (learned, value) => (finite(learned) && learned > 0 ? learned + POWER_WEIGHT * (value - learned) : value);
  if (watts > threshold) return { heatW: move(s.heatW, watts), baseW: s.baseW, heating: true };
  return { heatW: s.heatW === undefined ? undefined : heatW, baseW: move(s.baseW, watts), heating: false };
}

/**
 * @description What the water does by the power meter: still (standby), circulating (the base load, a pump) or heating.
 * @param {number|null} watts
 * @param {Object} levels - powerLevels()
 * @returns {string|null} still | circulating | heating, null without a reading
 */
function flowState(watts, levels) {
  if (!finite(watts)) return null;
  if (watts > levels.threshold) return 'heating';
  return watts > MIN_RUNNING_W ? 'circulating' : 'still';
}

// After circulation starts, the water counts as mixed after this long.
const MIX_MS = 15 * 60000;

/**
 * @description Learning the cooling from still stretches (with a power meter), one step per minute. A still reading
 * isn't trusted (warm water rises to the sensor), so a stretch is measured from the last mixed reading before the pump
 * stopped to the first mixed reading after it starts again, minus what the heater added meanwhile. The reading just
 * before the start against the mixed one is the mixing drop. A use drops the stretch, but leaves the water stirred: a new
 * stretch starts from it. A restart or a stop during mixing drops the stretch until the pump has mixed the water again.
 * @param {Object|null} state - The previous step's state
 * @param {Object} input - { now, flow (flowState), raw (°C reading), outdoor, inUse, model, stepMs }
 * @returns {Object} { state, loss: { hours, from, to, outdoor } | null, mix: { before, after, heatedHours } | null }
 */
function stillStep(state, { now, flow, raw, outdoor, inUse = false, model: stored, stepMs = 60000 }) {
  const none = { loss: null, mix: null };
  if (!finite(raw) || !flow) return { ...none, state: null };
  const moving = flow !== 'still';
  const phase = state ? state.phase : null;
  if (inUse) {
    // Nothing is learned in use, but remember since when the water stands still (null: moving now), so a reading is
    // taken as mixed until it has stood STILL_MS. Unknown before (restart): still since long, the safe side.
    let since = null;
    if (!moving) {
      if (phase === 'used') since = finite(state.since) ? state.since : now;
      else if (phase === 'still') since = state.at;
      else if (phase === 'moving' || phase === 'mixing') since = now;
      else since = 0;
    }
    return { ...none, state: { phase: 'used', since } };
  }
  // Mixed water: the pump ran, or a use (jets, people) just stirred it.
  if (phase === 'moving' || phase === 'used') {
    const temp = phase === 'used' ? raw : state.temp;
    if (moving) return { ...none, state: { phase: 'moving', at: now, temp: raw } };
    return { ...none, state: { phase: 'still', at: now, temp, last: raw, outSum: finite(outdoor) ? outdoor : 0, outN: finite(outdoor) ? 1 : 0 } };
  }
  if (phase === 'still') {
    if (!moving) {
      if (!finite(outdoor)) return { ...none, state: { ...state, last: raw } };
      return { ...none, state: { ...state, last: raw, outSum: state.outSum + outdoor, outN: state.outN + 1 } };
    }
    const stretch = { at: state.at, temp: state.temp, outdoor: state.outN ? state.outSum / state.outN : null, end: now };
    // The still reading just before the start: the first moving minute may already be mixing.
    const before = finite(state.last) ? state.last : raw;
    return { ...none, state: { phase: 'mixing', at: now, before, heatedMs: flow === 'heating' ? stepMs : 0, stretch } };
  }
  if (phase === 'mixing') {
    // Stopped before the water was mixed: no trusted end.
    if (!moving) return { ...none, state: { phase: 'unknown' } };
    const heatedMs = state.heatedMs + (flow === 'heating' ? stepMs : 0);
    if (now - state.at < MIX_MS) return { ...none, state: { ...state, heatedMs } };
    const s = state.stretch;
    const result = { loss: null, mix: null, state: { phase: 'moving', at: now, temp: raw } };
    if (s) {
      const heatedHours = heatedMs / 3600000;
      const mixed = raw - model(stored).heatRate * heatedHours;
      if (finite(s.outdoor)) result.loss = { hours: (s.end - s.at) / 3600000, from: s.temp, to: mixed, outdoor: s.outdoor };
      if (s.end - s.at >= STILL_MS) result.mix = { before: state.before, after: raw, heatedHours };
    }
    return result;
  }
  // Unknown (start, restart, after a use): wait for circulation to mix the water.
  if (!moving) return { ...none, state: { phase: 'unknown' } };
  return { ...none, state: { phase: 'mixing', at: now, before: raw, heatedMs: flow === 'heating' ? stepMs : 0, stretch: null } };
}

/**
 * Filter cycles (Hot Tub, issue #24): the tub runs its own filter cycles from a daily schedule (start and length), and
 * heats during them. Each cycle goes to the cheapest run of quarters inside its window; the user's flow writes the
 * start times to the tub.
 */

/**
 * @description A cycle's window on a local date as instants. Windows lie within one day (from before to).
 */
function filterWindow(timeZone, date, cycle) {
  return { from: localMs(timeZone, date, strToMins(cycle.from)), to: localMs(timeZone, date, strToMins(cycle.to)) };
}

/**
 * @description Inside one of the cycles' windows today (from the settings): where the tub's own filter cycles run,
 * whoever planned them.
 */
function inFilterWindow({ now, timeZone, cycles }) {
  if (!cycles || cycles.length === 0) return false;
  const today = localDate(timeZone, now);
  return cycles.some((cycle) => {
    const { from, to } = filterWindow(timeZone, today, cycle);
    return now >= from && now < to;
  });
}

/**
 * @description The day to plan the filter cycles for next, or null. A day is planned only once the previous day's
 * windows are over (the tub repeats its schedule daily: new times before then would move a cycle still due today) and
 * before its own first window starts.
 * @param {Object} opts - { now, timeZone, cycles: [{ from, to }], plannedDate: 'YYYY-MM-DD' | null }
 * @returns {string|null} 'YYYY-MM-DD'
 */
function filterDay({ now, timeZone, cycles, plannedDate = null }) {
  if (!cycles || cycles.length === 0) return null;
  const today = localDate(timeZone, now);
  for (const date of [today, addDays(today, 1)]) {
    if (plannedDate && plannedDate >= date) continue;
    const ahead = cycles.every((cycle) => filterWindow(timeZone, date, cycle).from > now);
    const before = cycles.every((cycle) => filterWindow(timeZone, addDays(date, -1), cycle).to <= now);
    if (ahead && before) return date;
  }
  return null;
}

/**
 * @description The cheapest run of whole quarters for each filter cycle inside its window on a date, or null while the
 * prices don't cover every window yet. A cycle over its price limit is planned but doesn't run.
 * @param {Object} opts - { quarters: [{ start, price }], date, timeZone, cycles: [{ from, to, minutes, priceLimit }] }
 * @returns {Array|null} [{ start, end, price (average), runs }]
 */
function filterTimes({ quarters, date, timeZone, cycles }) {
  const result = [];
  for (const cycle of cycles) {
    const { from, to } = filterWindow(timeZone, date, cycle);
    const inside = quarters.filter((q) => q.start >= from && q.start + QUARTER_MS <= to);
    if (inside.length < Math.round((to - from) / QUARTER_MS) || inside.some((q) => !finite(q.price))) return null;
    const n = Math.max(1, Math.ceil(cycle.minutes / 15));
    if (n > inside.length) {
      result.push({ start: null, end: null, price: null, runs: false });
      continue;
    }
    let best = -1;
    let bestSum = Infinity;
    for (let i = 0; i + n <= inside.length; i++) {
      let sum = 0;
      for (let k = i; k < i + n; k++) sum += inside[k].price;
      // Ties go to the earliest run.
      if (sum < bestSum - 1e-12) {
        best = i;
        bestSum = sum;
      }
    }
    const price = bestSum / n;
    const runs = !(finite(cycle.priceLimit) && cycle.priceLimit > 0 && price > cycle.priceLimit);
    result.push({ start: inside[best].start, end: inside[best].start + n * QUARTER_MS, price, runs });
  }
  return result;
}

// After a use the water is still stirred (jets, people, an open lid): not learned from for this long.
const AFTER_USE_MS = 30 * 60000;

/**
 * @description Whether the water is in use (or just was): heat lost and gained then says nothing about the closed tub.
 * @param {Array} useList [{ start, end }] in ms, including uses that ended up to AFTER_USE_MS ago
 * @param {number} now ms
 * @returns {boolean}
 */
function inUse(useList, now) {
  return (useList || []).some((use) => use.start <= now && now < use.end + AFTER_USE_MS);
}

/**
 * @description Mode Heat (thermostat_mode heat): an ordinary thermostat that holds the ready temperature all the time,
 * whatever the price, with a small band so it doesn't switch on every report. Maximum stops it.
 * @returns {Object} { demand, reason: { code, args } }
 */
function holdTarget({ temperature, ready, max, heatingNow = false }) {
  if (!finite(temperature)) return { demand: false, reason: { code: 'no_temperature', args: {} } };
  if (temperature >= max) return { demand: false, reason: { code: 'at_max', args: { max } } };
  const demand = temperature < Math.min(ready, max) - (heatingNow ? 0 : 0.5);
  return { demand, reason: { code: demand ? 'mode_heat_heat' : 'mode_heat', args: { target: ready } } };
}

/**
 * @description A manual on/off (the on/off button with Automatic on) over the automatic decision. On heats to the ready
 * temperature, then the automation carries on. Off stops the heating going on now: held until the automation's own
 * demand has gone off once (that heating is over), so its next start or latest safe start heats again. Keep and
 * Maximum always win.
 * @param {Object} result - decide() result
 * @param {Object|null} manual - { on, at } from the button, null for none
 * @param {Object} opts - { temperature, ready, keep, max }
 * @returns {Object} { result, manual } (manual null once it is over)
 */
function applyManual(result, manual, { temperature, ready, keep, max }) {
  if (!manual) return { result, manual: null };
  if (!finite(temperature) || temperature >= max) return { result, manual: null };
  if (manual.on) {
    if (temperature >= ready) return { result, manual: null };
    return { result: { ...result, demand: true, reason: { code: 'manual_on', args: { target: ready } } }, manual };
  }
  if ((finite(keep) && temperature < keep) || !result.demand) return { result, manual: null };
  return { result: { ...result, demand: false, reason: { code: 'manual_off', args: {} } }, manual };
}

// Reasons of heating towards a ready time: ahead of it, or once it has started (also one turned on by hand) while the
// water hasn't been ready for it yet. Not for keep, by hand (the Heating demand button) or after ready was reached.
const FOR_READY_CODES = ['heating', 'safe_start', 'learning_heat', 'no_prices_heat', 'in_use_heat', 'block_heat'];
// Heating planned is told at most this long before the planned start.
const PLANNED_AHEAD_MS = 24 * 3600000;

/**
 * @description Which once-per-ready-time message is due now: 'started' when heating for the ready time starts (before
 * the water was ready for it), 'planned' when its start is known and at most PLANNED_AHEAD_MS away (not after it
 * started), otherwise null.
 * @param {Object} result decide() result: { use, demand, nextStart, skip, reason: { code } }
 * @param {Object} told { planned, started, ready }: the ready time (use start, ms) each was last told for
 * @returns {string|null}
 */
function heatingNews(now, result, told = {}) {
  const use = result && result.use;
  if (!use || result.skip) return null;
  if (result.demand) {
    const forReady = FOR_READY_CODES.includes(result.reason && result.reason.code);
    return forReady && told.started !== use.start && told.ready !== use.start ? 'started' : null;
  }
  if (use.start <= now || told.planned === use.start || told.started === use.start) return null;
  return finite(result.nextStart) && result.nextStart > now && result.nextStart - now <= PLANNED_AHEAD_MS ? 'planned' : null;
}

/**
 * @description Ready reached: true the first time the water is ready (state ready) for a ready time.
 * @param {Object} result decide() result: { use, demand, reason }
 * @param {number|null} told The ready time (use start, ms) it was last told for
 */
function readyNews(result, told = null) {
  const use = result && result.use;
  return !!use && state(result) === 'ready' && told !== use.start;
}

/**
 * @description The state shown beside the reason: pre-heating when the price plan heats ahead of a use in cheap
 * quarters (not forced by the latest safe start), heating whenever else heating is demanded, ready while held for a
 * use, stopped without a water temperature or at maximum, otherwise waiting. Off (control off) is set by the device.
 * @param {Object} result decide() result: { demand, safe, reason: { code } }
 * @returns {string} preheating | heating | ready | waiting | stopped
 */
function state({ demand, safe, reason }) {
  const code = reason && reason.code;
  if (demand) return code === 'heating' && !safe ? 'preheating' : 'heating';
  if (code === 'in_use' || code === 'ready_hold') return 'ready';
  if (code === 'no_temperature' || code === 'at_max') return 'stopped';
  return 'waiting';
}

/**
 * @description Heater problem check: heating demanded for PROBLEM_HOURS without the water warming PROBLEM_RISE above
 * the lowest temperature since the demand started (or since it last warmed). Cooling water doesn't restart the clock,
 * so a heater that doesn't heat at all is caught too. With a power meter (flow not null) also NO_POWER_MS of demand
 * without a heating reading, except while in use (the tub may hold the heater off while the jets run).
 * @param {Object|null} since { at, low, power } from the previous call, null when demand was off
 * @param {number} now ms
 * @param {number|null} temperature water now
 * @param {boolean} demand heating demanded now
 * @param {Object} [opts] { flow: 'still' | 'circulating' | 'heating' | null (no meter), inUse }
 * @returns {Object} { since, problem }
 */
function problemCheck(since, now, temperature, demand, { flow = null, inUse = false } = {}) {
  if (!finite(temperature)) return { since: null, problem: true };
  if (!demand) return { since: null, problem: false };
  const power = flow === 'heating' || !since || !finite(since.power) ? now : since.power;
  if (!since) return { since: { at: now, low: temperature, power }, problem: false };
  const noPower = flow !== null && !inUse && now - power >= NO_POWER_MS;
  if (temperature - since.low >= PROBLEM_RISE) return { since: { at: now, low: temperature, power }, problem: noPower };
  const next = { at: since.at, low: Math.min(since.low, temperature), power };
  return { since: next, problem: noPower || now - since.at >= PROBLEM_HOURS * 3600000 };
}

module.exports = {
  QUARTER_MS,
  READY_AHEAD_MINUTES,
  DEFAULT_MODEL,
  DAYS,
  model,
  confident,
  exactness,
  pessimistic,
  powerLevels,
  learnPower,
  learn,
  learnMix,
  mixedTemperature,
  project,
  hoursToHeat,
  localMs,
  uses,
  quarterPrices,
  latestStart,
  meanPrice,
  minutesToHeat,
  readyEstimate,
  heatingBlock,
  mustStart,
  filterShare,
  idleStep,
  projectIdle,
  learnFilterTarget,
  fullStop,
  stillFull,
  TANK_POSITIONS,
  tankTemperature,
  heatingNews,
  readyNews,
  lowerFilterTarget,
  filterWatchStep,
  optimise,
  decide,
  state,
  holdTarget,
  applyManual,
  problemCheck,
  STILL_MS,
  MIX_MS,
  flowState,
  stillStep,
  filterWindow,
  inFilterWindow,
  filterDay,
  filterTimes,
  AFTER_USE_MS,
  inUse
};

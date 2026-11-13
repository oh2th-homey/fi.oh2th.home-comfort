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
// Latest safe start: a slower heater and faster losses than learned, plus one quarter's margin.
const PESSIMISTIC_RATE = 0.8;
const PESSIMISTIC_LOSS = 1.25;
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
// Heating for keep stops this far above it.
const KEEP_BAND = 0.5;

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

function pessimistic(m) {
  return { ...m, heatRate: m.heatRate * PESSIMISTIC_RATE, loss: m.loss * PESSIMISTIC_LOSS };
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
 * @description Latest safe start: heat now when waiting one more quarter and then heating at the pessimistic rate
 * would miss the use's start.
 */
function mustStart(temperature, target, outdoor, m, now, start) {
  const slow = pessimistic(m);
  const next = Math.floor(now / QUARTER_MS) * QUARTER_MS + QUARTER_MS;
  const waited = project(temperature, outdoor, (next - now) / 3600000, false, slow);
  return next + hoursToHeat(waited, target, outdoor, slow) * 3600000 >= start;
}

/**
 * @description The cheapest heating plan over the known quarters: dynamic programming over quarters × water
 * temperatures (0.1 °C), heating or not in each quarter. Never below keep (heats when below), never heats at or above
 * max, at least ready at the start of each use and while it lasts. Unknown prices count as the mean of the known ones.
 * Switching on or off costs a little, so the plan doesn't switch every quarter.
 * @returns {Object|null} { heat: [boolean per quarter], cost, kWh, temps: [°C at each quarter start] } or null when
 * nothing to plan
 */
function optimise({ temperature, outdoor, m, quarters, useList, keep, ready, max, powerW, heatingNow }) {
  const n = quarters.length;
  if (n === 0) return null;
  const known = quarters.map((q) => q.price).filter(finite);
  const mean = known.length ? known.reduce((sum, p) => sum + p, 0) / known.length : 0;
  const kWh = (powerW > 0 ? powerW : 1000) / 1000 / 4;
  const penalty = SWITCH_PENALTY * Math.max(mean, 0.001) * kWh;
  const lo = Math.floor(Math.min(keep - 2, temperature - 1, outdoor + 1) / GRID);
  const hi = Math.ceil((max + 1) / GRID);
  const size = hi - lo + 1;
  const index = (t) => Math.min(size - 1, Math.max(0, Math.round(t / GRID) - lo));
  // Required temperature at each quarter start: ready during a use (from the quarter its start falls in).
  const need = quarters.map((q) => (useList.some((use) => q.start + QUARTER_MS > use.start && q.start < use.end) ? ready : -Infinity));
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
          const after = t + ((heat ? m.heatRate : 0) - m.loss * (t - outdoor)) * QUARTER_H;
          // Maximum is a hard limit, also for the plan: no quarter of heating that would end above it.
          if (heat && (t >= max || after > max)) continue;
          // Waiting may not take the water below keep; heating is then the only choice.
          if (!heat && after < keep && t < max) continue;
          const value = (heat ? price * kWh : 0) + ((heat ? 1 : 0) !== prev ? penalty : 0) + next[index(after)][heat ? 1 : 0];
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
    t += ((on ? m.heatRate : 0) - m.loss * (t - outdoor)) * QUARTER_H;
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
 * @param {number} opts.keep - Never below (°C)
 * @param {number} opts.ready - At each use (°C)
 * @param {number} opts.max - Never heat at or above (°C)
 * @param {number} opts.powerW - Heater power (W), for the energy and cost of a quarter
 * @param {number|null} opts.priceLimit - Skip a use whose heating costs more per kWh; null = always heat
 * @param {boolean} opts.heatingNow - Demand is on now
 * @param {number} opts.holdBefore - Minutes before a use from which ready, once reached, is held
 * @param {number|null} opts.reachedFor - Start of the use that ready was already reached for (from the last result)
 * @returns {Object} { demand, reason: { code, args }, use, expected, nextStart, until, skip, plan, reachedFor }
 */
function decide({ now, temperature, outdoor, model: stored, quarters = [], useList = [], keep, ready, max, powerW, priceLimit = null, heatingNow = false, holdBefore = HOLD_BEFORE_MINUTES, reachedFor = null }) {
  const m = model(stored);
  const use = useList.find((u) => u.end > now) || null;
  // Once ready is reached shortly before the next use, it is held until that use ends. Reached earlier (pre-heated in
  // cheap hours), the plan decides: it still has the water ready at the start.
  const reached = !!use && (reachedFor === use.start || (finite(temperature) && temperature >= ready && now >= use.start - (finite(holdBefore) ? holdBefore : HOLD_BEFORE_MINUTES) * 60000));
  const base = { use, expected: null, nextStart: null, until: null, skip: false, plan: null, reachedFor: reached ? use.start : null };
  if (!finite(temperature)) return { ...base, demand: false, reason: { code: 'no_temperature', args: {} } };
  // The caller passes the surroundings (outdoor, a room or a fixed temperature); unknown counts as cold.
  const surroundings = finite(outdoor) ? outdoor : 5;
  if (temperature >= max) return { ...base, demand: false, reason: { code: 'at_max', args: { max } } };
  // Below keep: heat back to keep plus a small band (the plan below holds keep with its own grid).
  if (temperature < keep) return { ...base, demand: true, reason: { code: 'below_keep', args: { keep } } };
  if (use && (use.start <= now || reached)) {
    // In use, or ready reached before it: hold ready to the end of the use, with a small band so it doesn't switch on every report.
    const demand = temperature < ready - (heatingNow ? 0 : 0.5);
    const code = use.start <= now ? 'in_use' : 'ready_hold';
    return { ...base, demand, reason: { code: demand ? `${code}_heat` : code, args: { until: use.end, ready: use.start } } };
  }

  const hasPrices = quarters.some((q) => finite(q.price));
  const learned = confident(m);
  // Without prices or before the curve is known: just in time for the next use (latest safe start), nothing ahead.
  if (!hasPrices || !learned) {
    const code = hasPrices ? 'learning' : 'no_prices';
    const keeping = heatingNow && temperature < keep + KEEP_BAND;
    if (!use) return { ...base, demand: keeping, reason: keeping ? { code: 'below_keep', args: { keep } } : { code: `${code}_idle`, args: { keep } } };
    const hours = hoursToHeat(temperature, ready, surroundings, pessimistic(m));
    // Once started, keep heating to ready: the real heater is faster than the pessimistic one, which would stop and start.
    const start = mustStart(temperature, ready, surroundings, m, now, use.start) || (heatingNow && use.start - now <= 2 * hours * 3600000 + QUARTER_MS);
    const demand = (start && temperature < ready) || keeping;
    const latest = Number.isFinite(hours) ? Math.max(now, use.start - hours * 3600000 - QUARTER_MS) : now;
    const nextStart = demand ? now : latest;
    return { ...base, demand, nextStart, reason: { code: demand ? `${code}_heat` : code, args: { ready: use.start, start: nextStart } } };
  }

  // Plan to the end of the last use in the horizon, at least the next 12 hours (to hold keep cheaply).
  const end = Math.max(now + 12 * 3600000, ...useList.map((u) => u.end));
  const window = quarters.filter((q) => q.start < end);
  const run = (list) => optimise({ temperature, outdoor: surroundings, m, quarters: window, useList: list, keep, ready, max, powerW, heatingNow });
  let plan = run(useList);
  let skip = false;
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
      plan = run(useList.filter((u) => u !== use));
    }
  }
  if (!plan) return { ...base, demand: false, reason: { code: 'idle', args: { keep } } };

  // Latest safe start always wins over the plan.
  const safe = use && !skip && mustStart(temperature, ready, surroundings, m, now, use.start) && temperature < ready;
  const demand = plan.heat[0] || safe;
  const startIndex = plan.heat.findIndex((h) => h);
  const stopIndex = demand ? plan.heat.findIndex((h, i) => i > 0 && !h) : -1;
  const atUse = use ? window.findIndex((q) => q.start >= use.start) : -1;
  const result = {
    ...base,
    demand,
    skip,
    plan,
    nextStart: startIndex >= 0 ? window[startIndex].start : null,
    until: stopIndex > 0 ? window[stopIndex].start : null,
    expected: atUse >= 0 ? plan.temps[atUse] : null
  };
  if (safe && !plan.heat[0]) return { ...result, reason: { code: 'safe_start', args: { ready: use.start } } };
  if (skip) return { ...result, reason: { code: 'skipped', args: { ready: use.start, limit: priceLimit } } };
  if (demand) return { ...result, reason: use ? { code: 'heating', args: { ready: use.start, until: result.until } } : { code: 'heating_keep', args: { keep } } };
  if (use) return { ...result, reason: { code: 'waiting', args: { ready: use.start, start: result.nextStart } } };
  return { ...result, reason: { code: 'idle', args: { keep } } };
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

module.exports = {
  QUARTER_MS,
  DEFAULT_MODEL,
  DAYS,
  model,
  confident,
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
  mustStart,
  optimise,
  decide
};

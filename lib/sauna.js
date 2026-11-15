'use strict';

/**
 * Sauna (issue #34): a read-only device that follows a sauna session from a temperature sensor in the sauna, and
 * optionally its humidity and the stove's power meter. An electric stove is seen on the meter (on/off, the thermostat
 * switching the elements off once it is hot); a wood-burning stove (no meter) from the temperature alone.
 * Pure functions, one step per reading or minute; the device keeps the state.
 */

// Stove power above this counts as heating (W).
const HEAT_W = 500;
// Electric: no power for this long ends the session (longer than the thermostat's pauses).
const OFF_MS = 45 * 60000;
// The thermostat's first switch-off counts as ready only after this much heating (a stove switched on and off by hand).
const MIN_HEAT_MS = 10 * 60000;
// Wood: a session starts when the temperature has risen this much (°C) within RISE_MS.
const WOOD_START_RISE = 3;
const RISE_MS = 10 * 60000;
// Wood: the session ends when the temperature has fallen below this (°C) and is still falling.
const WOOD_OFF_TEMPERATURE = 40;
// Bathing (the first löyly): the humidity rises this much (percentage points) above its lowest in the session, once
// the sauna is warm.
const HUMIDITY_JUMP = 5;
const WARM = 40;
// Wood: the fire needs more wood when the temperature hasn't risen more than this (°C) within RISE_MS, or has fallen
// this much from its highest.
const STALL_RISE = 1;
const FALL = 3;
// Ready temperature when none is set and none is learned (°C).
const DEFAULT_READY = 60;
// Learning: a running average, so one odd session doesn't move it far.
const WEIGHT = 0.3;

const finite = (value) => typeof value === 'number' && Number.isFinite(value);

/**
 * @description The rise (°C) over the last RISE_MS from a list of { at, temperature } readings, null when too short.
 */
function recentRise(readings, now) {
  const window = readings.filter((r) => r.at >= now - RISE_MS);
  if (window.length < 2 || window[window.length - 1].at - window[0].at < RISE_MS / 2) return null;
  return window[window.length - 1].temperature - window[0].temperature;
}

/**
 * @description The rate (°C per minute) over the last RISE_MS, null when too short or not rising.
 */
function recentRate(readings, now) {
  const window = readings.filter((r) => r.at >= now - RISE_MS);
  if (window.length < 2) return null;
  const minutes = (window[window.length - 1].at - window[0].at) / 60000;
  if (minutes < RISE_MS / 120000) return null;
  const rate = (window[window.length - 1].temperature - window[0].temperature) / minutes;
  return rate > 0 ? rate : null;
}

/**
 * @description The temperature the sauna counts as ready at: set by hand, else learned (the sensor at the thermostat's
 * first switch-off), else DEFAULT_READY.
 */
function readyTemperature(set, learned) {
  if (finite(set) && set > 0) return set;
  return finite(learned) ? learned : DEFAULT_READY;
}

/**
 * @description One step of a session.
 * @param {Object|null} state The previous step's state, null at the start
 * @param {Object} input { now, temperature, humidity (or null), power (W, or null without a meter), readySet (°C or
 *   null), learnedReady (°C or null), maxHours }
 * @returns {Object} { state, events: [ 'started' | 'ready' | 'bathing' | 'add_wood' | 'left_on' | 'off' ], learned:
 *   { ready, rate } | null } ready: the sensor at the first switch-off; rate: °C per minute from start to ready
 */
function step(state, { now, temperature, humidity = null, power = null, readySet = null, learnedReady = null, maxHours = 4 }) {
  const events = [];
  let learned = null;
  if (!finite(temperature)) return { state, events, learned };
  const electric = finite(power);
  const s = state ? { ...state } : { phase: 'off', readings: [] };
  s.readings = [...(s.readings || []), { at: now, temperature }].filter((r) => r.at >= now - 2 * RISE_MS);
  const heatingNow = electric && power > HEAT_W;

  if (s.phase === 'off') {
    const rise = recentRise(s.readings, now);
    const started = electric ? heatingNow : rise !== null && rise >= WOOD_START_RISE;
    if (!started) return { state: s, events, learned };
    const startTemperature = electric ? temperature : s.readings[0].temperature;
    Object.assign(s, {
      phase: 'heating',
      since: now,
      startTemperature,
      low: finite(humidity) ? humidity : null,
      peak: temperature,
      lastHeat: now,
      wasHeating: heatingNow,
      woodTold: false,
      leftOnTold: false
    });
    events.push('started');
    return { state: s, events, learned };
  }

  // A session is going on: heating, ready or in use.
  s.peak = Math.max(s.peak, temperature);
  if (finite(humidity)) s.low = finite(s.low) ? Math.min(s.low, humidity) : humidity;
  if (heatingNow) s.lastHeat = now;

  const ready = readyTemperature(readySet, learnedReady);
  // Ready: the thermostat switched the elements off for the first time, or the ready temperature was reached.
  if (s.phase === 'heating') {
    // A stop while still cool is someone switching it off, not the thermostat.
    const firstStop = electric && s.wasHeating && !heatingNow && now - s.since >= MIN_HEAT_MS && temperature >= WARM;
    const setReached = finite(readySet) && readySet > 0 && temperature >= readySet;
    const woodReached = !electric && temperature >= ready;
    if (firstStop || setReached || woodReached) {
      s.phase = 'ready';
      s.readyAt = now;
      events.push('ready');
      const minutes = (now - s.since) / 60000;
      if (firstStop) learned = { ready: temperature, rate: minutes > 0 ? (temperature - s.startTemperature) / minutes : null };
    }
  }
  // Bathing: the first löyly makes the humidity jump, once the sauna is warm.
  if (s.phase !== 'in_use' && finite(humidity) && finite(s.low) && temperature >= WARM && humidity - s.low >= HUMIDITY_JUMP) {
    s.phase = 'in_use';
    s.bathingAt = now;
    events.push('bathing');
  }
  s.wasHeating = heatingNow;

  // Wood: the fire is dying, before or after ready. Told once until the temperature rises again.
  if (!electric) {
    const rise = recentRise(s.readings, now);
    const stalled = s.phase === 'heating' && rise !== null && rise < STALL_RISE;
    const falling = s.phase !== 'heating' && s.peak - temperature >= FALL;
    if ((stalled || falling) && !s.woodTold) {
      s.woodTold = true;
      events.push('add_wood');
    } else if (s.woodTold && rise !== null && rise >= STALL_RISE * 2) {
      s.woodTold = false;
      s.peak = temperature;
    }
  }

  // Left on far longer than a session.
  if (!s.leftOnTold && finite(maxHours) && maxHours > 0 && now - s.since >= maxHours * 3600000) {
    s.leftOnTold = true;
    events.push('left_on');
  }

  // The end: electric, no power for OFF_MS; wood, cooled below WOOD_OFF_TEMPERATURE and still falling.
  const rise = recentRise(s.readings, now);
  const over = electric ? now - s.lastHeat >= OFF_MS : temperature < WOOD_OFF_TEMPERATURE && rise !== null && rise < 0;
  if (over) {
    events.push('off');
    return { state: { phase: 'off', readings: s.readings }, events, learned };
  }
  return { state: s, events, learned };
}

/**
 * @description Learn the ready temperature and the heat-up rate from a session (running averages).
 * @param {Object|null} stored { ready, rate, sessions }
 */
function learn(stored, sample) {
  const m = { ready: null, rate: null, sessions: 0, ...(stored || {}) };
  if (!sample) return m;
  const blend = (old, value) => {
    if (!finite(value)) return old;
    return finite(old) ? old + WEIGHT * (value - old) : value;
  };
  return { ready: blend(m.ready, sample.ready), rate: blend(m.rate, sample.rate > 0 ? sample.rate : null), sessions: m.sessions + 1 };
}

/**
 * @description Minutes until ready while heating: by the rate of the last minutes when it rises, else the learned
 * rate. 0 when there, null when unknown.
 */
function minutesToReady(state, { now, temperature, ready, learnedRate }) {
  if (!state || state.phase !== 'heating' || !finite(temperature) || !finite(ready)) return null;
  if (temperature >= ready) return 0;
  const rate = recentRate(state.readings || [], now) || (finite(learnedRate) && learnedRate > 0 ? learnedRate : null);
  return rate ? Math.ceil((ready - temperature) / rate) : null;
}

module.exports = {
  HEAT_W,
  OFF_MS,
  DEFAULT_READY,
  readyTemperature,
  recentRise,
  step,
  learn,
  minutesToReady
};

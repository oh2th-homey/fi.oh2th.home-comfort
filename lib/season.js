'use strict';

/**
 * Pure logic of the automatic season (issue #6): hourly means of the outdoor and indoor temperature that the controller
 * keeps itself, the outdoor mean blended with the forecast, and the decision between heating and cooling.
 */

const forecast = require('./forecast');

const { HOUR_MS } = forecast;
// Outdoor: the past 3 days; with a forecast the past 2 days and the next 24 hours.
const OUTDOOR_HOURS = 72;
const OUTDOOR_PAST_WITH_FORECAST = 48;
const FORECAST_HOURS = 24;
// Indoor: the past 24 hours of the zones that can cool.
const INDOOR_HOURS = 24;
// A mean counts only when this share of its past hours has samples (a new install, a sensor that was offline).
const MIN_COVERAGE = 0.8;
const DEFAULTS = { heatBelow: 10, coolOutdoorAbove: 18, coolIndoorAbove: 23 };

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * @description Add a sample to hourly buckets [[hour, mean, count], …] (hour = ms / HOUR_MS rounded down); buckets older
 * than keepHours are dropped. Returns new buckets; a sample that isn't a number only drops the old ones.
 */
function addSample(buckets, ms, value, keepHours) {
  const hour = Math.floor(ms / HOUR_MS);
  const kept = (Array.isArray(buckets) ? buckets : []).filter((bucket) => Array.isArray(bucket) && bucket[0] > hour - keepHours && bucket[0] <= hour);
  if (!finite(value)) return kept;
  const last = kept[kept.length - 1];
  if (last && last[0] === hour) {
    const count = last[2] + 1;
    return [...kept.slice(0, -1), [hour, Math.round(((last[1] * last[2] + value) / count) * 100) / 100, count]];
  }
  return [...kept, [hour, Math.round(value * 100) / 100, 1]];
}

/**
 * @description Mean of the hourly means in the past `hours` (the current hour included), or null when fewer than
 * MIN_COVERAGE of the hours have samples. Each hour counts the same, however many samples it has.
 * @returns {{ mean: number|null, values: number[] }}
 */
function pastMean(buckets, now, hours) {
  const hour = Math.floor(now / HOUR_MS);
  const values = (Array.isArray(buckets) ? buckets : []).filter((b) => Array.isArray(b) && b[0] > hour - hours && b[0] <= hour && finite(b[1])).map((b) => b[1]);
  if (values.length < Math.ceil(hours * MIN_COVERAGE)) return { mean: null, values };
  return { mean: values.reduce((sum, value) => sum + value, 0) / values.length, values };
}

/**
 * @description The outdoor mean: with a usable forecast the past 2 days and the next 24 forecast hours, each hour counting
 * the same; without one the past 3 days. Null until there are enough samples.
 * @param {Array} buckets - Outdoor hourly buckets
 * @param {number} now
 * @param {Object|null} stored - The stored forecast { fetchedAt, points }
 * @returns {{ mean: number|null, forecast: boolean }}
 */
function outdoorMean(buckets, now, stored = null) {
  if (forecast.usable(stored, now)) {
    const ahead = [];
    for (let i = 1; i <= FORECAST_HOURS; i++) {
      const value = forecast.temperatureAt(stored.points, now + i * HOUR_MS);
      if (finite(value)) ahead.push(value);
    }
    const past = pastMean(buckets, now, OUTDOOR_PAST_WITH_FORECAST);
    if (ahead.length === FORECAST_HOURS && past.mean !== null) {
      const values = [...past.values, ...ahead];
      return { mean: values.reduce((sum, value) => sum + value, 0) / values.length, forecast: true };
    }
  }
  return { mean: pastMean(buckets, now, OUTDOOR_HOURS).mean, forecast: false };
}

/**
 * @description The indoor mean of the past 24 hours, or null.
 */
function indoorMean(buckets, now) {
  return pastMean(buckets, now, INDOOR_HOURS).mean;
}

/**
 * @description Thresholds from the settings; missing or invalid values get the defaults.
 */
function thresholds(settings = {}) {
  const pick = (value, fallback) => (finite(Number(value)) && value !== '' && value !== null ? Number(value) : fallback);
  return {
    heatBelow: pick(settings.season_heat_below, DEFAULTS.heatBelow),
    coolOutdoorAbove: pick(settings.season_cool_outdoor_above, DEFAULTS.coolOutdoorAbove),
    coolIndoorAbove: pick(settings.season_cool_indoor_above, DEFAULTS.coolIndoorAbove)
  };
}

/**
 * @description The automatic season: heating when the outdoor mean is below heatBelow; cooling when the outdoor mean is
 * above coolOutdoorAbove and the indoor mean above coolIndoorAbove; otherwise the season stays as it is. Never off: a
 * current season other than heating or cooling becomes heating.
 * @param {Object} opts - { current, outdoor, indoor, thresholds }
 * @returns {{ season: string, code: string, args: Object }} code: 'collecting', 'heat_below', 'cool_above' or 'between'
 */
function decide({ current, outdoor, indoor, thresholds: limits = DEFAULTS }) {
  const kept = current === 'cooling' ? 'cooling' : 'heating';
  const args = { outdoor, indoor };
  if (!finite(outdoor)) return { season: kept, code: 'collecting', args };
  if (outdoor < limits.heatBelow) return { season: 'heating', code: 'heat_below', args };
  if (outdoor > limits.coolOutdoorAbove && finite(indoor) && indoor > limits.coolIndoorAbove) return { season: 'cooling', code: 'cool_above', args };
  return { season: kept, code: 'between', args };
}

module.exports = { HOUR_MS, OUTDOOR_HOURS, INDOOR_HOURS, DEFAULTS, addSample, pastMean, outdoorMean, indoorMean, thresholds, decide };

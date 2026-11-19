'use strict';

/**
 * Pure logic of the outdoor temperature forecast (issue #5): the Open-Meteo hourly response as points, the temperature at
 * a time, and the lowest and highest in a window.
 */

const HOUR_MS = 3600000;
// A forecast older than this is not used: the current outdoor temperature counts instead.
const MAX_AGE_MS = 6 * HOUR_MS;

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * @description The Open-Meteo request for a location, rounded to two decimals (about 1 km) before it leaves the Homey.
 */
function openMeteoUrl(latitude, longitude, days = 3) {
  const round = (value) => Math.round(value * 100) / 100;
  return `https://api.open-meteo.com/v1/forecast?latitude=${round(latitude)}&longitude=${round(longitude)}&hourly=temperature_2m&forecast_days=${days}&timeformat=unixtime`;
}

/**
 * @description Points [[ms, °C], …] sorted by time from an Open-Meteo response with `timeformat=unixtime`; readings that
 * aren't numbers are left out.
 * @throws when the response has no hourly temperatures
 */
function parseOpenMeteo(body) {
  const hourly = body && body.hourly;
  if (!hourly || !Array.isArray(hourly.time) || !Array.isArray(hourly.temperature_2m)) throw new Error('No hourly temperatures in the forecast');
  const points = [];
  hourly.time.forEach((seconds, i) => {
    const value = hourly.temperature_2m[i];
    if (finite(seconds) && finite(value)) points.push([seconds * 1000, value]);
  });
  if (!points.length) throw new Error('No hourly temperatures in the forecast');
  return points.sort((a, b) => a[0] - b[0]);
}

/**
 * @description Whether a stored forecast { fetchedAt, points } can be used now.
 */
function usable(forecast, now) {
  return !!forecast && Array.isArray(forecast.points) && forecast.points.length > 0 && finite(forecast.fetchedAt) && now - forecast.fetchedAt <= MAX_AGE_MS;
}

/**
 * @description The temperature at a time: straight lines between the points, the last value after the last point, null
 * before the first one (the caller uses the current outdoor temperature then).
 * @param {Array} points - [[ms, °C], …] sorted
 */
function temperatureAt(points, ms) {
  if (!Array.isArray(points) || !points.length || ms < points[0][0]) return null;
  for (let i = 1; i < points.length; i++) {
    const [t1, v1] = points[i];
    if (ms <= t1) {
      const [t0, v0] = points[i - 1];
      return t1 === t0 ? v1 : v0 + ((v1 - v0) * (ms - t0)) / (t1 - t0);
    }
  }
  return points[points.length - 1][1];
}

/**
 * @description Lowest and highest forecast temperature from `from` to `to` (points inside the window plus the values at
 * its ends): { min, max }, both null when the forecast doesn't reach the window.
 */
function range(points, from, to) {
  const values = [temperatureAt(points, from), temperatureAt(points, to), ...(points || []).filter(([t]) => t > from && t < to).map(([, v]) => v)].filter(finite);
  if (!values.length) return { min: null, max: null };
  return { min: Math.min(...values), max: Math.max(...values) };
}

module.exports = { HOUR_MS, MAX_AGE_MS, openMeteoUrl, parseOpenMeteo, usable, temperatureAt, range };

'use strict';

/**
 * Pure logic of power meters: summing readings, energy from readings over time, and the Home Controller's other heating
 * meters (issue #40).
 */

/**
 * @description Sum of the available numeric readings (W), or null when there is none.
 * @param {Object[]} readings - lib/members.js read() results, null for unknown
 */
function sumPower(readings) {
  const watts = readings.filter((reading) => reading && typeof reading.value === 'number' && Number.isFinite(reading.value) && reading.available).map((reading) => reading.value);
  return watts.length ? watts.reduce((sum, value) => sum + value, 0) : null;
}

/**
 * @description Energy count after a new reading: the previous power times how long it lasted is added (Wh).
 * @param {Object|null} last - { power, at, wh } or null at the start
 * @param {number} ms - Time of the new reading
 * @param {number|null} power - New power (W), null when unknown
 * @returns {Object} { power, at, wh }
 */
function integrate(last, ms, power) {
  const wh = last ? last.wh + (typeof last.power === 'number' ? (last.power * Math.max(0, ms - last.at)) / 3600000 : 0) : 0;
  return { power, at: ms, wh };
}

/**
 * @description The picked other heating meters as [{ id, name }]: known meters only, each once. A meter that is a zone's
 * member is refused, so its power isn't counted twice.
 * @param {string[]} ids - Picked device ids
 * @param {Object[]} meters - Devices with a power meter [{ id, name }]
 * @param {Object} zoneOf - Device id → name of the zone that has it as a power meter
 * @returns {Object} { meters: [{ id, name }], clash: null | { name, zone } }
 */
function pickMeters(ids, meters, zoneOf = {}) {
  const byId = Object.fromEntries(meters.map((meter) => [meter.id, meter]));
  const picked = [...new Set(ids || [])].filter((id) => byId[id]).map((id) => ({ id, name: byId[id].name }));
  const clash = picked.find((meter) => zoneOf[meter.id]);
  return { meters: clash ? [] : picked, clash: clash ? { name: clash.name, zone: zoneOf[clash.id] } : null };
}

module.exports = { sumPower, integrate, pickMeters };

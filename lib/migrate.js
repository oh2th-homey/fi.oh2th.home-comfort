'use strict';

/**
 * Pure logic of the import from the old app (issue #36): the old app's GET /export as new devices, one driver at a time.
 * Device data ids stay the same (zones.json of the history and the learned state refer to them), except the controller's.
 * Removed with the rest of the migration code after the move (#39).
 */

const OLD_APP = 'fi.oh2th.hvac-control';

// Old driver id → new; drivers not listed keep their id.
const DRIVERS = { hvac: 'controller' };
// Old data id → new; ids not listed stay the same.
const DATA_IDS = { 'hvac-controller': 'controller' };

/**
 * @description The export as read from the old app; throws when it isn't one.
 * @returns {Object} { version, devices, history }
 */
function checkExport(exported) {
  if (!exported || exported.app !== OLD_APP || !Array.isArray(exported.devices)) throw new Error('Not an export of the old app');
  return { version: exported.version, devices: exported.devices, history: exported.history || {} };
}

function newDriver(driver) {
  return DRIVERS[driver] || driver;
}

function newData(data) {
  return { ...data, id: DATA_IDS[data.id] || data.id };
}

/**
 * @description The setting ids of a driver manifest's settings, groups flattened.
 */
function settingIds(settings = []) {
  return settings.flatMap((setting) => (Array.isArray(setting.children) ? settingIds(setting.children) : [setting.id])).filter(Boolean);
}

/**
 * @description Capability values that can be set again: finite numbers, booleans and strings (null and NaN left out).
 */
function capabilityValues(capabilities = {}) {
  return Object.fromEntries(Object.entries(capabilities).filter(([, value]) => typeof value === 'boolean' || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))));
}

/**
 * @description The old devices of one new driver that are not added yet: [{ id, name }] (id: the new data id).
 * @param {Object} exported - The old app's export
 * @param {string} driverId - New driver id
 * @param {string[]} existing - Data ids of the driver's devices
 */
function importable(exported, driverId, existing = []) {
  return checkExport(exported)
    .devices.filter((device) => newDriver(device.driver) === driverId)
    .map((device) => ({ id: newData(device.data).id, name: device.name }))
    .filter((device) => !existing.includes(device.id));
}

/**
 * @description One old device as a new device for Homey's createDevice: same name, data (new id), store and the
 * settings the new driver knows. The capability values go into the store as importedValues; the device sets them at
 * its first start (main-device.js).
 * @param {Object} exported - The old app's export
 * @param {string} driverId - New driver id
 * @param {string} id - New data id
 * @param {string[]} settings - The new driver's setting ids
 */
function device(exported, driverId, id, settings) {
  const old = checkExport(exported).devices.find((d) => newDriver(d.driver) === driverId && newData(d.data).id === id);
  if (!old) throw new Error(`No ${driverId} ${id} in the export`);
  return {
    name: old.name,
    data: newData(old.data),
    store: { ...(old.store || {}), importedValues: capabilityValues(old.capabilities) },
    settings: Object.fromEntries(Object.entries(old.settings || {}).filter(([key]) => settings.includes(key)))
  };
}

module.exports = { OLD_APP, checkExport, newDriver, newData, settingIds, capabilityValues, importable, device };

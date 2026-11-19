'use strict';

const { isDate } = require('oh2th-homey-helpers');

module.exports = {
  /**
   * @description GET /history?date=YYYY-MM-DD: one day of the quarter-hour history (lib/history.js, base64) and the
   * zone slot map, for learning and analysis.
   */
  async getHistory({ homey, query }) {
    const date = String((query && query.date) || '');
    if (!isDate(date)) throw new Error(homey.__('error.invalid_date'));
    const { version, zones, data } = await homey.app.history.read(date);
    return { version, date, zones, data: data ? data.toString('base64') : null };
  },

  /**
   * @description GET /history/days: the daily summary rows (lib/history.js days.bin, base64) and the zone slot map.
   */
  async getHistoryDays({ homey }) {
    const { version, zones, data } = await homey.app.history.readDays();
    return { version, zones, data: data ? data.toString('base64') : null };
  },

  /**
   * @description GET /export: everything needed to move to the renamed app (#36), read only. Every device with its
   * driver, name, data, store (sources, learned state), settings and capability values, and the history files.
   */
  async getExport({ homey }) {
    const drivers = ['controller', 'zone', 'spa', 'water-heater', 'sauna'];
    const devices = drivers.flatMap((driver) => homey.drivers.getDriver(driver).getDevices().map((device) => ({
      driver,
      name: device.getName(),
      data: device.getData(),
      store: device.getStore(),
      settings: device.getSettings(),
      capabilities: Object.fromEntries(device.getCapabilities().map((cap) => [cap, device.getCapabilityValue(cap)]))
    })));
    const history = await homey.app.history.exportFiles();
    return { app: homey.manifest.id, version: homey.manifest.version, exportedAt: new Date().toISOString(), devices, history };
  },

  /**
   * @description GET /water: what each Hot Tub, Water Heater and Sauna has learned (model, hours seen, open segment or
   * session), to follow the learning.
   */
  async getWater({ homey }) {
    const devices = ['spa', 'water-heater', 'sauna'].flatMap((id) => homey.drivers.getDriver(id).getDevices());
    return devices.filter((device) => typeof device.learningState === 'function').map((device) => device.learningState());
  }
};

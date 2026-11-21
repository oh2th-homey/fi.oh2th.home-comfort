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
   * @description GET /water: what each Hot Tub, Water Heater and Sauna has learned (model, hours seen, open segment or
   * session), and each Water Monitor's totals and recent uses, to follow the learning.
   */
  async getWater({ homey }) {
    const devices = ['spa', 'water-heater', 'sauna', 'water-monitor'].flatMap((id) => homey.drivers.getDriver(id).getDevices());
    return devices.filter((device) => typeof device.learningState === 'function').map((device) => device.learningState());
  }
};

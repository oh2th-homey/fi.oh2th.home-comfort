'use strict';

const { localTime, isTime, strToMins } = require('oh2th-homey-helpers');
const waterDevice = require('../water-device');
const water = require('../../lib/water');

// An outdoor spa without any outdoor temperature plans as if it were freezing: safe, not cheap.
const UNKNOWN_OUTDOOR = 0;
const FILTER_KEYS = ['filter_cycles', 'filter1_from', 'filter1_to', 'filter1_minutes', 'filter1_price_limit', 'filter2_from', 'filter2_to', 'filter2_minutes', 'filter2_price_limit'];

module.exports = class spaDevice extends waterDevice {
  /**
   * @description Without an own sensor: the HVAC Controller's outdoor temperature.
   */
  fallbackSurroundings() {
    const controller = this.homey.app.findController();
    const outdoor = controller ? controller.outdoorTemperature() : null;
    return typeof outdoor === 'number' ? outdoor : UNKNOWN_OUTDOOR;
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    for (const [n, cycle] of this.filterCycles(newSettings).entries()) {
      const ok = isTime(cycle.from) && isTime(cycle.to) && strToMins(cycle.to) - strToMins(cycle.from) >= cycle.minutes;
      if (!ok) throw new Error(this.homey.__('water.error.filter_window', { n: n + 1 }));
    }
    await super.onSettings({ oldSettings, newSettings, changedKeys });
    // Changed cycles: plan again (the next day, once the current ones are over).
    if (changedKeys.some((key) => FILTER_KEYS.includes(key))) {
      await this.setStoreValue('filterPlan', null).catch(this.error);
      this.setTimer('filters', () => this.planFilters(), 1000);
    }
  }

  /**
   * @description Repair: the number of filter cycles from the page, then the sources.
   */
  async onRepairSources(sources, options = {}) {
    if (options.filterCycles !== undefined && options.filterCycles !== this.getSetting('filter_cycles')) {
      await this.setSettings({ filter_cycles: options.filterCycles });
      await this.setStoreValue('filterPlan', null).catch(this.error);
    }
    return super.onRepairSources(sources, options);
  }

  /**
   * @description The filter cycles in use from the settings: [{ from, to, minutes, priceLimit }].
   */
  filterCycles(settings = this.getSettings()) {
    const count = Number(settings.filter_cycles) || 0;
    return [1, 2].slice(0, count).map((n) => ({
      from: settings[`filter${n}_from`],
      to: settings[`filter${n}_to`],
      minutes: settings[`filter${n}_minutes`],
      priceLimit: settings[`filter${n}_price_limit`] > 0 ? settings[`filter${n}_price_limit`] : null
    }));
  }

  /**
   * @description Filter cycles (issue #24): once the next day can be planned and its prices are known, the cheapest
   * times in the windows; shown in the settings and given to the user's flow by the Filter cycles planned trigger.
   */
  async planFilters(now = Date.now()) {
    const cycles = this.filterCycles();
    if (cycles.length === 0 || !cycles.every((cycle) => isTime(cycle.from) && isTime(cycle.to))) return;
    const controller = this.homey.app.findController();
    if (!controller) return;
    const timeZone = this.homey.clock.getTimezone();
    const stored = this.getStoreValue('filterPlan');
    const date = water.filterDay({ now, timeZone, cycles, plannedDate: stored && stored.date });
    if (!date) return;
    const times = water.filterTimes({ quarters: controller.priceQuarters(now), date, timeZone, cycles });
    // The day's prices aren't known yet: tried again at the next check.
    if (!times) return;
    await this.setStoreValue('filterPlan', { date, cycles: times }).catch(this.error);
    const summary = this.filterSummary(date, times);
    this.log(`${this.getName()} - planFilters - ${date}: ${summary}`);
    this.setSettings({ filter_planned: summary }).catch(this.error);
    const hhmm = (ms) => (typeof ms === 'number' ? localTime(this, new Date(ms)).time : '');
    const [first, second] = times;
    await this.triggerFlow('filter_cycles_planned', {
      cycle1_start: hhmm(first.start),
      cycle1_runs: first.runs,
      cycle2_start: second ? hhmm(second.start) : '',
      cycle2_runs: second ? second.runs : false,
      summary
    });
  }

  /**
   * @description E.g. "Sun: 02:00–04:00, off (0.21/kWh)".
   */
  filterSummary(date, times) {
    const hhmm = (ms) => localTime(this, new Date(ms)).time;
    const cycles = times
      .map((cycle) => {
        if (cycle.start === null) return this.homey.__('water.filter.off', { price: '-' });
        if (!cycle.runs) return this.homey.__('water.filter.off', { price: cycle.price.toFixed(2) });
        return this.homey.__('water.filter.cycle', { start: hhmm(cycle.start), end: hhmm(cycle.end) });
      })
      .join(', ');
    const noon = water.localMs(this.homey.clock.getTimezone(), date, 12 * 60);
    const day = this.homey.__(`water.weekday.${localTime(this, new Date(noon)).weekday}`);
    return this.homey.__('water.filter.summary', { day, cycles });
  }
};

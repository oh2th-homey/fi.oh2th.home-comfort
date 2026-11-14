'use strict';

const crypto = require('crypto');
const mainDriver = require('./main-driver');

/**
 * Shared driver base of the Hot Tub and the Water Heater (issue #1): one pairing page that picks the water temperature,
 * the surroundings and an optional power meter from other devices. The same page repairs a device.
 * The HVAC Controller must exist and follow prices: the planner heats on its prices.
 */
module.exports = class waterDriver extends mainDriver {
  /**
   * @description What the surroundings are when no sensor is chosen, shown on the pairing page: overridden per driver.
   */
  surroundingsFallback() {
    return this.homey.__('pair.water.surroundings_none');
  }

  /**
   * @description Whether pairing asks for the filter cycles (issue #24): overridden by the Hot Tub.
   */
  hasFilterCycles() {
    return false;
  }

  /**
   * @description The picked number of filter cycles as the setting's value ('0', '1' or '2').
   */
  filterCyclesValue(value) {
    return this.hasFilterCycles() && ['0', '1', '2'].includes(String(value)) ? String(value) : '0';
  }

  async onPair(session) {
    session.setHandler('get_sources', async () => this.sourcesView(null));
    session.setHandler('create_water', async ({ name, sources, filterCycles }) => {
      this.checkController();
      const device = {
        name: name || this.homey.__(`pair.water.name_${this.id}`),
        data: { id: `${this.id}-${crypto.randomUUID()}` },
        store: await this.checkSources(sources)
      };
      if (this.hasFilterCycles()) device.settings = { filter_cycles: this.filterCyclesValue(filterCycles) };
      return device;
    });
  }

  async onRepair(session, device) {
    session.setHandler('get_sources', async () => this.sourcesView(device));
    session.setHandler('save_sources', async ({ sources, filterCycles }) => {
      const options = this.hasFilterCycles() ? { filterCycles: this.filterCyclesValue(filterCycles) } : {};
      return device.onRepairSources(await this.checkSources(sources), options);
    });
  }

  /**
   * @description The HVAC Controller exists and follows a price device; else pairing stops with a message.
   */
  checkController() {
    const controller = this.homey.app.getController();
    if (!controller.getStoreValue('priceSource')) throw new Error(this.homey.__('pair.water.no_prices'));
    return controller;
  }

  /**
   * @description The pairing page's data: temperature sensors, power meters and the current choices.
   */
  async sourcesView(device) {
    let blocked = null;
    try {
      this.checkController();
    } catch (error) {
      blocked = error.message;
    }
    const candidates = await this.homey.app.members.candidates();
    const sensors = candidates.filter((d) => d.temperatures.length > 0).map(({ id, name, zone, temperatures }) => ({ id, name, zone, temperatures }));
    const meters = candidates.filter((d) => d.power).map(({ id, name, zone }) => ({ id, name, zone }));
    this.log(`sourcesView - ${sensors.length} sensors, ${meters.length} meters`);
    return {
      blocked: device ? null : blocked,
      repair: !!device,
      driver: this.id,
      surroundingsNone: this.surroundingsFallback(),
      filters: this.hasFilterCycles(),
      sensors,
      meters,
      current: device ? this.currentChoices(device) : null
    };
  }

  /**
   * @description A device's current choices, shown on the repair page.
   */
  currentChoices(device) {
    return {
      water: device.getStoreValue('water'),
      surroundings: device.getStoreValue('surroundings'),
      power: device.getStoreValue('power'),
      filterCycles: this.filterCyclesValue(device.getSetting('filter_cycles'))
    };
  }

  /**
   * @description Picked sources as stored: { water: { id, cap, name } | { flow: true }, surroundings: … | null, power: { id, name } | null }.
   * The water temperature is required; a capability must exist on its device.
   */
  async checkSources(sources = {}) {
    const candidates = await this.homey.app.members.candidates();
    const temperature = (pick) => {
      if (!pick || !pick.id) return null;
      const device = candidates.find((d) => d.id === pick.id && d.temperatures.length > 0);
      if (!device) return null;
      const cap = device.temperatures.some((t) => t.id === pick.cap) ? pick.cap : device.temperatures[0].id;
      return { id: device.id, cap, name: device.name };
    };
    const waterSource = sources.water && sources.water.flow ? { flow: true } : temperature(sources.water);
    if (!waterSource) throw new Error(this.homey.__('pair.water.no_water'));
    const meter = sources.power && candidates.find((d) => d.id === sources.power.id && d.power);
    return { water: waterSource, surroundings: temperature(sources.surroundings), power: meter ? { id: meter.id, name: meter.name } : null };
  }
};

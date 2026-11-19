'use strict';

const crypto = require('crypto');
const mainDriver = require('./main-driver');
const { TANK_POSITIONS } = require('../lib/water');

/**
 * Shared driver base of the Hot Tub and the Water Heater (issue #1): one pairing page that picks the water temperature,
 * the surroundings, an optional power meter and an optional heater switch from other devices. The same page repairs a device.
 * The Home Controller must exist and follow prices: the planner heats on its prices.
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
   * @description Whether the water temperature comes from a tank's sensors at up to three heights (top, middle,
   * bottom) instead of one: overridden by the Water Heater.
   */
  hasTank() {
    return false;
  }

  /**
   * @description The picked number of filter cycles as the setting's value ('0', '1' or '2').
   */
  filterCyclesValue(value) {
    return this.hasFilterCycles() && ['0', '1', '2'].includes(String(value)) ? String(value) : '0';
  }

  async onPair(session) {
    this.setImportHandlers(session);
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
   * @description Import: as at pairing, the Home Controller exists and follows prices.
   */
  async checkImport() {
    this.checkController();
  }

  /**
   * @description The Home Controller exists and follows a price device; else pairing stops with a message.
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
    const switches = candidates.filter((d) => d.switches.length > 0).map(({ id, name, zone, switches: caps }) => ({ id, name, zone, switches: caps }));
    this.log(`sourcesView - ${sensors.length} sensors, ${meters.length} meters, ${switches.length} switches`);
    return {
      blocked: device ? null : blocked,
      repair: !!device,
      driver: this.id,
      surroundingsNone: this.surroundingsFallback(),
      filters: this.hasFilterCycles(),
      tank: this.hasTank(),
      sensors,
      meters,
      switches,
      current: device ? this.currentChoices(device) : null
    };
  }

  /**
   * @description A device's current choices, shown on the repair page.
   */
  currentChoices(device) {
    return {
      water: device.getStoreValue('water'),
      tank: device.getStoreValue('tank'),
      surroundings: device.getStoreValue('surroundings'),
      power: device.getStoreValue('power'),
      heaterSwitch: device.getStoreValue('heaterSwitch'),
      filterCycles: this.filterCyclesValue(device.getSetting('filter_cycles'))
    };
  }

  /**
   * @description Picked sources as stored: { water: { id, cap, name } | { flow: true } | null, tank: { top, middle, bottom }
   * (each a source or null when not installed) | null, surroundings: … | null, power: { id, name } | null,
   * heaterSwitch: { id, cap, name } | null }.
   * The water temperature is required: one source, or (a tank) at least one installed position. A capability must exist
   * on its device.
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
    const pickWater = (pick) => (pick && pick.flow ? { flow: true } : temperature(pick));
    let waterSource = null;
    let tank = null;
    if (this.hasTank()) {
      tank = Object.fromEntries(TANK_POSITIONS.map((position) => [position, pickWater((sources.tank || {})[position])]));
      if (!TANK_POSITIONS.some((position) => tank[position])) throw new Error(this.homey.__('pair.water.no_tank'));
    } else {
      waterSource = pickWater(sources.water);
      if (!waterSource) throw new Error(this.homey.__('pair.water.no_water'));
    }
    const meter = sources.power && candidates.find((d) => d.id === sources.power.id && d.power);
    const switchPick = sources.heaterSwitch;
    const switchDevice = switchPick && switchPick.id && candidates.find((d) => d.id === switchPick.id && d.switches.length > 0);
    const heaterSwitch = switchDevice
      ? { id: switchDevice.id, cap: switchDevice.switches.some((s) => s.id === switchPick.cap) ? switchPick.cap : switchDevice.switches[0].id, name: switchDevice.name }
      : null;
    return { water: waterSource, tank, surroundings: temperature(sources.surroundings), power: meter ? { id: meter.id, name: meter.name } : null, heaterSwitch };
  }
};

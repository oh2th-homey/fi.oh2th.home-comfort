'use strict';

const mainDriver = require('../main-driver');
const prices = require('../../lib/prices');

// Prices come from the Power by the Hour Prices API (issue #23), the app's only dependency on another app.
const PBTH = 'com.gruijter.powerhour';

module.exports = class hvacDriver extends mainDriver {
  /**
   * @description Pairing: exactly one HVAC Controller, with an optional outdoor temperature sensor and the prices to follow.
   * When it exists already, the page points to it and to adding zones instead.
   */
  async onPair(session) {
    session.setHandler('get_outdoor', async () => {
      const [existing] = this.getDevices();
      if (existing) return { exists: this.homey.__('pair.outdoor.exists', { name: existing.getName() }) };
      const priceDevices = await this.priceDevices();
      // A single price device is preselected, so the user sees what is followed.
      const selected = priceDevices.devices.length === 1 ? priceDevices.devices[0].id : '';
      return { sensors: await this.outdoorSensors(), outdoor: null, prices: { ...priceDevices, selected }, repair: false };
    });
    session.setHandler('create_controller', async ({ outdoor, priceSource }) => {
      if (this.getDevices().length > 0) throw new Error(this.homey.__('pair.hvac_exists'));
      const source = await this.checkPriceSource(priceSource);
      const device = { name: this.homey.__('pair.hvac_name'), data: { id: 'hvac-controller' }, store: { outdoor: await this.checkOutdoor(outdoor), priceSource: source } };
      // The currency follows the price device.
      if (source && source.currency) device.settings = { currency: source.currency };
      return device;
    });
  }

  /**
   * @description Repair: change the outdoor temperature sensor and the prices to follow.
   */
  async onRepair(session, device) {
    session.setHandler('get_outdoor', async () => {
      const source = device.getStoreValue('priceSource');
      const priceDevices = await this.priceDevices();
      return { sensors: await this.outdoorSensors(), outdoor: device.getStoreValue('outdoor') || null, prices: { ...priceDevices, selected: source ? source.id : '' }, repair: true };
    });
    session.setHandler('save_outdoor', async ({ outdoor, priceSource }) => {
      const source = await this.checkPriceSource(priceSource, device.getStoreValue('priceSource'));
      await device.onRepairOutdoor(await this.checkOutdoor(outdoor));
      await device.onRepairPrices(source);
      return true;
    });
  }

  /**
   * @description Devices with a temperature (sub-capabilities included): [{ id, name, zone, temperatures }].
   */
  async outdoorSensors() {
    const candidates = await this.homey.app.members.candidates();
    const sensors = candidates.filter((device) => device.temperatures.length > 0).map(({ id, name, zone, temperatures }) => ({ id, name, zone, temperatures }));
    this.log(`outdoorSensors - ${sensors.length} of ${candidates.length} devices`);
    return sensors;
  }

  /**
   * @description The picked sensor { id, cap, name }, or null for none; the capability must exist on the device.
   */
  async checkOutdoor(outdoor) {
    if (!outdoor || !outdoor.id) return null;
    const sensor = (await this.outdoorSensors()).find((device) => device.id === outdoor.id);
    if (!sensor) return null;
    const cap = sensor.temperatures.some((t) => t.id === outdoor.cap) ? outdoor.cap : sensor.temperatures[0].id;
    return { id: sensor.id, cap, name: sensor.name };
  }

  /**
   * @description Power by the Hour's electricity price devices, or a note why there are none.
   * @returns {Promise<Object>} { devices: [{ id, name, tariffType, currency, interval }], note: null | 'not_installed' | 'no_api' | 'no_power' }
   */
  async priceDevices() {
    try {
      const api = this.homey.api.getApiApp(PBTH);
      if (!(await api.getInstalled())) return { devices: [], note: 'not_installed' };
      const devices = prices.apiPowerDevices(await api.get('/prices'));
      this.log(`priceDevices - ${devices.length} electricity price devices`);
      return { devices, note: devices.length ? null : 'no_power' };
    } catch (error) {
      // Older Power by the Hour versions have no Prices API.
      this.log(`priceDevices - ${error.message || error}`);
      return { devices: [], note: 'no_api' };
    }
  }

  /**
   * @description The picked price device { id, name, currency }, or null for none. A device Power by the Hour doesn't list
   * now (not running) is kept when it is the current one.
   * @param {string} id - Picked device id, '' for none
   * @param {Object} [current] - The controller's current price device (repair)
   */
  async checkPriceSource(id, current = null) {
    if (!id) return null;
    const device = (await this.priceDevices()).devices.find((d) => d.id === id);
    if (device) return { id: device.id, name: device.name, currency: device.currency };
    if (current && current.id === id) return current;
    throw new Error(this.homey.__('pair.prices.missing'));
  }
};

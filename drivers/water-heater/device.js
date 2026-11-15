'use strict';

const waterDevice = require('../water-device');
const water = require('../../lib/water');

module.exports = class waterHeaterDevice extends waterDevice {
  /**
   * @description Without a room sensor: the fixed temperature from the settings.
   */
  fallbackSurroundings() {
    const value = this.getSetting('surroundings_temperature');
    return typeof value === 'number' ? value : 20;
  }

  /**
   * @description The tank's own thermostat decides when it is full: ready times and reheats heat until it stops the heater.
   */
  heatsToFull() {
    return true;
  }

  /**
   * @description The heater stopped while heating was demanded: near the full temperature, the tank's thermostat found it
   * full. Learned as the full temperature (a running average); further below, the relay was switched off early.
   */
  async onDemandedHeatingStopped(temperature, now = Date.now()) {
    const before = this.getStoreValue('fullTemperature');
    if (!water.fullStop(temperature, before, this.getCapabilityValue('target_temperature'))) {
      this.log(`${this.getName()} - heater stopped at ${temperature} °C while demanded: below full, not learned`);
      return;
    }
    const full = water.learnFilterTarget(before, temperature);
    this.log(`${this.getName()} - thermostat stopped the heater at ${temperature} °C: full at ${full.toFixed(1)} °C`);
    await this.setStoreValue('fullTemperature', full).catch(this.error);
    await this.setStoreValue('fullAt', { temperature, at: now }).catch(this.error);
    await this.setStoreValue('reheat', false).catch(this.error);
    this.setSettings({ learned_full: `${full.toFixed(1)} °C` }).catch(this.error);
    this.setTimer('plan', () => this.plan(), 2000);
  }
};

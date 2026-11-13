'use strict';

const waterDevice = require('../water-device');

// An outdoor spa without any outdoor temperature plans as if it were freezing: safe, not cheap.
const UNKNOWN_OUTDOOR = 0;

module.exports = class spaDevice extends waterDevice {
  /**
   * @description Without an own sensor: the HVAC Controller's outdoor temperature.
   */
  fallbackSurroundings() {
    const controller = this.homey.app.findController();
    const outdoor = controller ? controller.outdoorTemperature() : null;
    return typeof outdoor === 'number' ? outdoor : UNKNOWN_OUTDOOR;
  }
};

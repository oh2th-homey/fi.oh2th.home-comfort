'use strict';

const waterDevice = require('../water-device');

module.exports = class waterHeaterDevice extends waterDevice {
  /**
   * @description Without a room sensor: the fixed temperature from the settings.
   */
  fallbackSurroundings() {
    const value = this.getSetting('surroundings_temperature');
    return typeof value === 'number' ? value : 20;
  }
};

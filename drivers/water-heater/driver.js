'use strict';

const waterDriver = require('../water-driver');

module.exports = class waterHeaterDriver extends waterDriver {
  surroundingsFallback() {
    return this.homey.__('pair.water.surroundings_fixed');
  }

  hasTank() {
    return true;
  }
};

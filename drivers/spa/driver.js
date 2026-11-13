'use strict';

const waterDriver = require('../water-driver');

module.exports = class spaDriver extends waterDriver {
  surroundingsFallback() {
    return this.homey.__('pair.water.surroundings_controller');
  }
};

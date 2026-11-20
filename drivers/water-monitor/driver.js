'use strict';

const crypto = require('crypto');
const mainDriver = require('../main-driver');
const { chosenCategories, CATEGORIES } = require('../../lib/water-use');

/**
 * Water Monitor (issue #37): read only, from the house water meter's standard capabilities: meter_water (m³) for the
 * litres and measure_water (l/min; or measure_water_flow, lib/members.js) for the flow and the uses. One page pairs and repairs.
 */
module.exports = class waterMonitorDriver extends mainDriver {
  async onPair(session) {
    session.setHandler('get_monitor_sources', async () => this.sourcesView(null));
    session.setHandler('create_monitor', async ({ name, meter, categories }) => ({
      name: name || this.homey.__('pair.monitor.name'),
      data: { id: `water-monitor-${crypto.randomUUID()}` },
      store: { meter: await this.checkMeter(meter), categories: chosenCategories(categories) }
    }));
  }

  async onRepair(session, device) {
    session.setHandler('get_monitor_sources', async () => this.sourcesView(device));
    session.setHandler('save_monitor_sources', async ({ meter, categories }) => device.onRepairMeter(await this.checkMeter(meter), chosenCategories(categories)));
  }

  /**
   * @description The page's data: devices with a water meter or a water flow, the water use categories, and the current
   * choices.
   */
  async sourcesView(device) {
    const candidates = await this.homey.app.members.candidates({ water: true });
    return {
      repair: !!device,
      meters: candidates.filter((d) => d.waterMeter || d.waterFlow).map((d) => ({ id: d.id, name: d.name, zone: d.zone, meter: d.waterMeter, flow: d.waterFlow })),
      categories: CATEGORIES.map((id) => ({ id, title: this.homey.__(`monitor.category.${id}`) })),
      current: device ? { ...device.getStoreValue('meter'), categories: chosenCategories(device.getStoreValue('categories')) } : null
    };
  }

  /**
   * @description The picked water meter as stored: { id, name, meter, flow, flowCap }: whether it has meter_water and a
   * flow, and the flow's capability (lib/members.js waterFlowCapability).
   */
  async checkMeter(pick) {
    const candidates = await this.homey.app.members.candidates({ water: true });
    const device = pick && candidates.find((d) => d.id === pick.id && (d.waterMeter || d.waterFlow));
    if (!device) throw new Error(this.homey.__('pair.monitor.no_meter'));
    return { id: device.id, name: device.name, meter: device.waterMeter, flow: device.waterFlow, flowCap: device.waterFlowCap };
  }
};

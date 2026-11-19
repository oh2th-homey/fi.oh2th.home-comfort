'use strict';

const crypto = require('crypto');
const mainDriver = require('../main-driver');

/**
 * Sauna (issue #34): read only, from other devices' standard capabilities. The sauna temperature is required; its
 * humidity (the first löyly) and the stove's power meter (an electric stove) are optional. One page pairs and repairs.
 */
module.exports = class saunaDriver extends mainDriver {
  async onPair(session) {
    session.setHandler('get_sauna_sources', async () => this.sourcesView(null));
    session.setHandler('create_sauna', async ({ name, sources }) => ({
      name: name || this.homey.__('pair.sauna.name'),
      data: { id: `sauna-${crypto.randomUUID()}` },
      store: await this.checkSources(sources)
    }));
  }

  async onRepair(session, device) {
    session.setHandler('get_sauna_sources', async () => this.sourcesView(device));
    session.setHandler('save_sauna_sources', async ({ sources }) => device.onRepairSources(await this.checkSources(sources)));
  }

  /**
   * @description The page's data: temperature sensors, humidity sensors, power meters and the current choices.
   */
  async sourcesView(device) {
    const candidates = await this.homey.app.members.candidates();
    const view = (d) => ({ id: d.id, name: d.name, zone: d.zone });
    return {
      repair: !!device,
      sensors: candidates.filter((d) => d.temperatures.length > 0).map((d) => ({ ...view(d), temperatures: d.temperatures })),
      humidity: candidates.filter((d) => d.humidity).map(view),
      meters: candidates.filter((d) => d.power).map(view),
      current: device ? { temperature: device.getStoreValue('temperature'), humidity: device.getStoreValue('humidity'), power: device.getStoreValue('power') } : null
    };
  }

  /**
   * @description Picked sources as stored: { temperature: { id, cap, name }, humidity: { id, name } | null, power: { id, name } | null }.
   */
  async checkSources(sources = {}) {
    const candidates = await this.homey.app.members.candidates();
    const pick = sources.temperature && candidates.find((d) => d.id === sources.temperature.id && d.temperatures.length > 0);
    if (!pick) throw new Error(this.homey.__('pair.sauna.no_temperature'));
    const cap = pick.temperatures.some((t) => t.id === sources.temperature.cap) ? sources.temperature.cap : pick.temperatures[0].id;
    const humidity = sources.humidity && candidates.find((d) => d.id === sources.humidity.id && d.humidity);
    const meter = sources.power && candidates.find((d) => d.id === sources.power.id && d.power);
    return {
      temperature: { id: pick.id, cap, name: pick.name },
      humidity: humidity ? { id: humidity.id, name: humidity.name } : null,
      power: meter ? { id: meter.id, name: meter.name } : null
    };
  }
};

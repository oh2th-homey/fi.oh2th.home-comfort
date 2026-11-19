'use strict';

const { localTime, updateCapabilities } = require('oh2th-homey-helpers');
const mainDevice = require('../main-device');
const sauna = require('../../lib/sauna');

const STATE = 'enum_sauna_state';
const HUMIDITY = 'measure_humidity';
const POWER = 'measure_power';
// A sauna temperature not updated for this long counts as unknown.
const TEMPERATURE_MAX_AGE_MS = 30 * 60000;

/**
 * Sauna (issue #34): follows a session from the sauna temperature, its humidity and the stove's power meter, all read
 * from other devices. Nothing is switched.
 */
module.exports = class saunaDevice extends mainDevice {
  async onInitDevice() {
    this.sourceListeners = {};
    this.session = this.getStoreValue('session') || null;
    await this.subscribeSources();
  }

  async onDeleted() {
    this.unsubscribeSources();
    await super.onDeleted();
  }

  async onUninit() {
    this.unsubscribeSources();
    await super.onUninit();
  }

  /**
   * @description The manifest's capabilities, plus humidity and power when their sources are chosen.
   */
  async checkCapabilities() {
    const capabilities = [...(this.driver.manifest.capabilities || [])];
    if (this.getStoreValue('humidity')) capabilities.push(HUMIDITY);
    if (this.getStoreValue('power')) capabilities.push(POWER);
    return updateCapabilities(this, capabilities, this.getCapabilities());
  }

  async setCapabilityValues(check = false) {
    try {
      await this.setValue('measure_temperature', this.temperature(), check);
      if (this.hasCapability(HUMIDITY)) await this.setValue(HUMIDITY, this.humidity(), check);
      if (this.hasCapability(POWER)) await this.setValue(POWER, this.power(), check);
      if (typeof this.getCapabilityValue(STATE) !== 'string') await this.setValue(STATE, 'off', check);
      if (typeof this.getCapabilityValue('alarm_problem') !== 'boolean') await this.setValue('alarm_problem', false, check);
    } catch (error) {
      this.error(`${this.getName()} - setCapabilityValues - ${error}`);
    }
  }

  async onReady() {
    await this.show(Date.now());
  }

  /**
   * Sources: { id, cap, name } of other devices, chosen at pairing or repair.
   */
  sources() {
    const list = [];
    const temperature = this.getStoreValue('temperature');
    const humidity = this.getStoreValue('humidity');
    const power = this.getStoreValue('power');
    if (temperature) list.push({ key: 'temperature', ...temperature });
    if (humidity) list.push({ key: 'humidity', ...humidity, cap: HUMIDITY });
    if (power) list.push({ key: 'power', ...power, cap: POWER });
    return list;
  }

  async subscribeSources() {
    for (const source of this.sources()) {
      if (this.sourceListeners[source.key]) continue;
      const listener = () => this.onSource(source.key).catch(this.error);
      try {
        await this.homey.app.members.subscribe(source.id, source.cap, listener);
        this.sourceListeners[source.key] = { id: source.id, cap: source.cap, listener };
      } catch (error) {
        // Retried from onInterval, e.g. when the source's app starts later.
        this.error(`${this.getName()} - subscribeSources - ${source.key} - ${error}`);
      }
    }
  }

  unsubscribeSources() {
    for (const { id, cap, listener } of Object.values(this.sourceListeners || {})) this.homey.app.members.unsubscribe(id, cap, listener);
    this.sourceListeners = {};
  }

  async onSource(key) {
    if (key === 'temperature') await this.setValue('measure_temperature', this.temperature());
    else if (key === 'humidity') await this.setValue(HUMIDITY, this.humidity());
    else if (key === 'power') {
      const watts = this.power();
      // The stove's thermostat switches within a minute: keep the highest and lowest seen until the next step.
      if (typeof watts === 'number') {
        this.powerMax = Math.max(this.powerMax ?? watts, watts);
        this.powerMin = Math.min(this.powerMin ?? watts, watts);
      }
      await this.setValue(POWER, watts);
    }
  }

  read(key, maxAge = null) {
    const source = this.sourceListeners[key];
    const reading = source ? this.homey.app.members.read(source.id, source.cap) : null;
    if (!reading || !reading.available || typeof reading.value !== 'number' || !Number.isFinite(reading.value)) return null;
    if (maxAge && reading.lastUpdated && Date.now() - reading.lastUpdated.getTime() > maxAge) return null;
    return reading.value;
  }

  temperature() {
    const value = this.read('temperature', TEMPERATURE_MAX_AGE_MS);
    return value === null || value < -40 || value > 150 ? null : Math.round(value * 10) / 10;
  }

  humidity() {
    const value = this.read('humidity', TEMPERATURE_MAX_AGE_MS);
    return value === null || value < 0 || value > 100 ? null : Math.round(value);
  }

  power() {
    if (!this.getStoreValue('power')) return null;
    const value = this.read('power');
    return value === null ? null : Math.round(value);
  }

  /**
   * @description Every minute: one step of the session (lib/sauna.js), its notifications, and what the device shows.
   */
  async onInterval(now) {
    try {
      await this.tick(now);
      this.lastError = null;
    } catch (error) {
      this.lastError = `${new Date().toISOString()} ${error && error.stack ? error.stack : error}`;
      this.error(`${this.getName()} - onInterval - ${this.lastError}`);
    }
  }

  /**
   * @description The session and the readings, for GET /water.
   */
  learningState() {
    return {
      id: this.getData().id,
      name: this.getName(),
      driver: 'sauna',
      model: this.getStoreValue('model'),
      session: this.session ? { ...this.session, readings: (this.session.readings || []).length } : null,
      temperature: this.temperature(),
      humidity: this.humidity(),
      power: this.power(),
      sources: Object.keys(this.sourceListeners || {}),
      stoveSwitch: this.getStoreValue('stoveSwitch') || null,
      lastError: this.lastError || null,
      lastTick: this.lastTick || null,
      reason: this.getCapabilityValue('text_reason')
    };
  }

  async tick(now) {
    const local = localTime(this, now);
    if (local.minutes % 5 === 0) await this.subscribeSources();
    const at = now.getTime();
    const temperature = this.temperature();
    const model = this.getStoreValue('model') || null;
    const before = this.session;
    // The power over the minute: the highest (heating at all) and whether it dropped (the thermostat switching off).
    const watts = this.power();
    const powerMax = typeof watts === 'number' ? Math.max(this.powerMax ?? watts, watts) : null;
    const powerMin = typeof watts === 'number' ? Math.min(this.powerMin ?? watts, watts) : null;
    this.powerMax = null;
    this.powerMin = null;
    const { state, events, learned } = sauna.step(this.session, {
      now: at,
      temperature,
      humidity: this.hasCapability(HUMIDITY) ? this.humidity() : null,
      power: powerMax,
      dropped: powerMin === null ? null : powerMin <= sauna.HEAT_W,
      readySet: this.getSetting('ready_temperature'),
      learnedReady: model && model.ready,
      maxHours: this.getSetting('max_hours'),
      switchOn: this.stoveSwitch()
    });
    this.lastTick = { at: new Date(at).toISOString(), temperature, powerMax, powerMin, phaseBefore: before ? before.phase : null, phaseAfter: state ? state.phase : null, events };
    this.session = state;
    if (state) state.at = at;
    await this.setStoreValue('session', state).catch(this.error);
    if (learned) await this.learn(learned);
    for (const event of events) await this.onEvent(event, at, temperature);
    await this.show(at);
  }

  /**
   * @description The stove's main switch as last set by a flow (true or false), null when no flow sets it.
   */
  stoveSwitch() {
    const stove = this.getStoreValue('stoveSwitch');
    return stove && typeof stove.on === 'boolean' ? stove.on : null;
  }

  /**
   * @description Flow: the stove's main switch is on or off (e.g. from a contact input on its supply). From then on
   * the switch starts and ends a session.
   */
  async onAction_SET_SAUNA_STOVE(state) {
    this.log(`${this.getName()} - onAction_SET_SAUNA_STOVE - ${state}`);
    if (state !== 'on' && state !== 'off') throw new Error(this.homey.__('error.invalid_value', { value: state }));
    await this.setStoreValue('stoveSwitch', { on: state === 'on', at: Date.now() });
    return true;
  }

  async learn(sample) {
    const model = sauna.learn(this.getStoreValue('model'), sample);
    this.log(`${this.getName()} - learned: ready ${model.ready} °C, ${model.rate} °C/min, ${model.sessions} sessions`);
    await this.setStoreValue('model', model).catch(this.error);
    const settings = {};
    if (typeof model.ready === 'number') settings.learned_ready = `${model.ready.toFixed(1)} °C`;
    if (typeof model.rate === 'number') settings.learned_rate = `${Math.round(model.rate * 60)} °C/h`;
    await this.setSettings(settings).catch(this.error);
  }

  async onEvent(event, at, temperature) {
    this.log(`${this.getName()} - ${event} at ${temperature} °C`);
    const value = typeof temperature === 'number' ? temperature : 0;
    if (event === 'started') {
      await this.setValue('alarm_problem', false);
      await this.triggerFlow('sauna_heating_started', { temperature: value, expected_ready: this.expectedReady(at).text });
    } else if (event === 'ready') {
      await this.triggerFlow('sauna_ready', { temperature: value });
    } else if (event === 'bathing') {
      const minutes = this.session && this.session.since ? Math.round((at - this.session.since) / 60000) : 0;
      await this.triggerFlow('sauna_bathing_started', { temperature: value, minutes });
    } else if (event === 'add_wood') {
      await this.triggerFlow('sauna_add_wood', { temperature: value });
    } else if (event === 'left_on') {
      await this.setValue('alarm_problem', true);
    } else if (event === 'off') {
      await this.setValue('alarm_problem', false);
    }
  }

  /**
   * @description Expected ready while heating: { minutes, text } (text: HH:mm, Now, or –).
   */
  expectedReady(at) {
    const model = this.getStoreValue('model') || {};
    const ready = sauna.readyTemperature(this.getSetting('ready_temperature'), model.ready);
    const minutes = sauna.minutesToReady(this.session, { now: at, temperature: this.temperature(), ready, learnedRate: model.rate });
    if (minutes === null) return { minutes, text: this.homey.__('water.start.none') };
    if (minutes === 0) return { minutes, text: this.homey.__('water.start.now') };
    return { minutes, text: localTime(this, new Date(at + minutes * 60000)).time };
  }

  async show(at) {
    const phase = this.session ? this.session.phase : 'off';
    const expected = this.expectedReady(at);
    await this.setValue(STATE, phase);
    await this.setValue('text_expected_ready', phase === 'heating' ? expected.text : this.homey.__('water.start.none'));
    await this.setValue('text_reason', this.reasonText(phase, expected));
  }

  reasonText(phase, expected) {
    if (this.temperature() === null) return this.homey.__('sauna.reason.no_temperature');
    const since = (key) => (this.session && typeof this.session[key] === 'number' ? localTime(this, new Date(this.session[key])).time : '');
    if (phase === 'heating') return expected.minutes ? this.homey.__('sauna.reason.heating', { ready: expected.text }) : this.homey.__('sauna.reason.heating_unknown');
    if (phase === 'ready') return this.homey.__('sauna.reason.ready', { since: since('readyAt') });
    if (phase === 'in_use') return this.homey.__('sauna.reason.in_use', { since: since('bathingAt') });
    return this.homey.__('sauna.reason.off');
  }

  /**
   * @description Repair: new sources; listeners and capabilities follow.
   */
  async onRepairSources({ temperature, humidity, power }) {
    this.log(`${this.getName()} - onRepairSources - temperature ${temperature.name}, humidity ${humidity ? humidity.name : 'none'}, power ${power ? power.name : 'none'}`);
    this.unsubscribeSources();
    await this.setStoreValue('temperature', temperature);
    await this.setStoreValue('humidity', humidity);
    await this.setStoreValue('power', power);
    await this.checkCapabilities();
    await this.subscribeSources();
    await this.setCapabilityValues();
    await this.show(Date.now());
    return true;
  }
};

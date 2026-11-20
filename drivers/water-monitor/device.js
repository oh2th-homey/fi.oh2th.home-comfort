'use strict';

const { localDate, localTime, updateCapabilities } = require('oh2th-homey-helpers');
const mainDevice = require('../main-device');
const waterUse = require('../../lib/water-use');

const TODAY = 'meter_water.today';
const MONTH = 'meter_water.month';
const FLOW = 'measure_water';
const LAST_USE = 'text_last_use';
const COST_TODAY = 'measure_monetary.today';
const COST_MONTH = 'measure_monetary.month';
const COST_TITLES = { [COST_TODAY]: { en: 'Water cost today' }, [COST_MONTH]: { en: 'Water cost this month' } };

/**
 * Water Monitor (issue #37): the house water meter's litres and cost today and this month, and its flow cut into uses
 * (lib/water-use.js). Read only. The costs come from its settings Water price and Base fee, in the Home Controller's
 * currency.
 */
module.exports = class waterMonitorDevice extends mainDevice {
  async onInitDevice() {
    this.sourceListeners = {};
    this.totals = this.getStoreValue('totals') || null;
    this.meterLast = this.getStoreValue('meterLast');
    this.flowLast = null;
    this.use = null;
    this.dirty = false;
    await this.subscribeSources();
  }

  async onDeleted() {
    this.unsubscribeSources();
    await super.onDeleted();
  }

  async onUninit() {
    this.unsubscribeSources();
    await this.save();
    await super.onUninit();
  }

  meter() {
    return this.getStoreValue('meter') || {};
  }

  /**
   * @description The manifest's capabilities, the flow and Last use with a flow source, the costs with a water price.
   */
  async checkCapabilities() {
    const capabilities = [...(this.driver.manifest.capabilities || [])];
    if (this.meter().flow) capabilities.push(FLOW, LAST_USE);
    if (this.price() !== null || this.baseFee() !== null) capabilities.push(COST_TODAY, COST_MONTH);
    const result = await updateCapabilities(this, capabilities, this.getCapabilities());
    if (result.added.includes(FLOW)) await this.setCapabilityOptions(FLOW, { title: { en: 'Flow' }, units: { en: 'l/min' }, decimals: 1 }).catch(this.error);
    if (result.added.includes(COST_TODAY)) await this.applyCurrency();
    return result;
  }

  /**
   * @description The cost capabilities' unit: the Home Controller's currency.
   */
  async applyCurrency() {
    const controller = this.homey.app.findController();
    const units = { en: controller ? controller.currency() : '€' };
    for (const cap of [COST_TODAY, COST_MONTH]) {
      // setCapabilityOptions replaces the options: pass title and decimals too.
      if (this.hasCapability(cap)) await this.setCapabilityOptions(cap, { title: COST_TITLES[cap], units, decimals: 2 }).catch(this.error);
    }
  }

  /**
   * @description A positive number setting, null when 0 or not set.
   */
  positiveSetting(key) {
    const value = Number(this.getSetting(key));
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  /**
   * @description The water price per m³ (setting Water price), null when not set.
   */
  price() {
    return this.positiveSetting('water_price');
  }

  /**
   * @description The water bill's fixed fee per month (setting Base fee), null when not set.
   */
  baseFee() {
    return this.positiveSetting('base_fee');
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log(`${this.getName()} - onSettings - changed: ${changedKeys}`);
    // Settings are saved after this returns: show or hide the costs then.
    if (changedKeys.includes('water_price') || changedKeys.includes('base_fee')) this.setTimer('costs', () => this.onCostSettings(), 500);
  }

  async onCostSettings() {
    await this.checkCapabilities();
    await this.applyCurrency();
    await this.show(Date.now());
  }

  async onReady() {
    // The Home Controller's currency may have changed meanwhile.
    await this.applyCurrency();
    await this.show(Date.now());
  }

  /**
   * Sources: the water meter's meter_water and measure_water, chosen at pairing or repair.
   */
  sources() {
    const { id, name, meter, flow } = this.meter();
    if (!id) return [];
    const list = [];
    if (meter) list.push({ key: 'meter', id, name, cap: 'meter_water' });
    if (flow) list.push({ key: 'flow', id, name, cap: FLOW });
    return list;
  }

  async subscribeSources() {
    for (const source of this.sources()) {
      if (this.sourceListeners[source.key]) continue;
      const listener = () => this.onSource(source.key).catch(this.error);
      try {
        await this.homey.app.members.subscribe(source.id, source.cap, listener);
        this.sourceListeners[source.key] = { id: source.id, cap: source.cap, listener };
        // The current reading: the meter's starting point, the flow shown.
        await this.onSource(source.key);
      } catch (error) {
        // Retried from onInterval, e.g. when the meter's app starts later.
        this.error(`${this.getName()} - subscribeSources - ${source.key} - ${error}`);
      }
    }
  }

  unsubscribeSources() {
    for (const { id, cap, listener } of Object.values(this.sourceListeners || {})) this.homey.app.members.unsubscribe(id, cap, listener);
    this.sourceListeners = {};
  }

  read(key) {
    const source = this.sourceListeners[key];
    const reading = source ? this.homey.app.members.read(source.id, source.cap) : null;
    if (!reading || !reading.available || typeof reading.value !== 'number' || !Number.isFinite(reading.value)) return null;
    return reading.value;
  }

  date(ms) {
    return localDate(this.homey.clock.getTimezone(), ms);
  }

  async onSource(key) {
    const at = Date.now();
    if (key === 'meter') {
      const step = waterUse.meterStep(this.meterLast, this.read('meter'));
      if (step.last !== this.meterLast) {
        this.meterLast = step.last;
        this.dirty = true;
      }
      if (step.litres > 0) await this.addLitres(at, step.litres);
    } else if (key === 'flow') {
      const flow = this.read('flow');
      // Without meter_water the litres come from the flow.
      if (!this.meter().meter) await this.integrateFlow(at, flow);
      await this.setValue(FLOW, flow === null ? null : Math.round(flow * 10) / 10);
      const step = waterUse.useStep(this.use, at, flow);
      this.use = step.use;
      if (step.ended) await this.onUseEnded(step.ended);
      if (step.started) await this.onUseStarted(flow);
      // The flow stopped: the use ends after the gap, also without another reading.
      if (this.use && this.use.zeroSince === at) this.setTimer('useEnd', () => this.checkUseEnd(), waterUse.END_GAP_MS + 1000);
      await this.showLastUse(at);
    }
  }

  async integrateFlow(at, flow) {
    const step = waterUse.flowStep(this.flowLast, at, flow);
    this.flowLast = step.last;
    if (step.litres > 0) await this.addLitres(at, step.litres);
  }

  async addLitres(at, litres) {
    this.totals = waterUse.addLitres(this.totals, this.date(at), litres);
    this.dirty = true;
    await this.showTotals();
  }

  async checkUseEnd(at = Date.now()) {
    const check = waterUse.checkEnd(this.use, at);
    this.use = check.use;
    if (check.ended) await this.onUseEnded(check.ended);
    await this.showLastUse(at);
  }

  async onUseStarted(flow) {
    await this.triggerFlow('water_use_started', { flow: Math.round(flow * 10) / 10 });
  }

  async onUseEnded(ended) {
    const minutes = Math.round(((ended.end - ended.start) / 60000) * 10) / 10;
    const litres = Math.round(ended.litres * 10) / 10;
    const cost = waterUse.cost(ended.litres, this.price());
    this.log(`${this.getName()} - use ended: ${litres} l in ${minutes} min, peak ${ended.peak.toFixed(1)} l/min`);
    const last = { ...ended, cost };
    await this.setStoreValue('lastUse', last).catch(this.error);
    await this.setStoreValue('uses', waterUse.keepUse(this.getStoreValue('uses'), last)).catch(this.error);
    await this.triggerFlow('water_use_ended', { litres, minutes, flow: Math.round(ended.average * 10) / 10, cost: cost === null ? 0 : Math.round(cost * 100) / 100 });
  }

  /**
   * @description Every minute: the day and month roll over, a use without readings ends, a constant flow is counted
   * (without meter_water), and the totals are saved.
   */
  async onInterval(now) {
    const at = now.getTime();
    if (localTime(this, now).minutes % 5 === 0) await this.subscribeSources();
    if (!this.meter().meter && this.flowLast) await this.integrateFlow(at, this.flowLast.flow);
    if (this.use) await this.checkUseEnd(at);
    const rolled = waterUse.rollover(this.totals, this.date(at));
    if (!this.totals || rolled.date !== this.totals.date) {
      this.totals = rolled;
      this.dirty = true;
    }
    await this.save();
    await this.show(at);
  }

  /**
   * @description The totals and the meter's last reading are saved together, so a restart counts what came in between.
   */
  async save() {
    if (!this.dirty) return;
    this.dirty = false;
    await this.setStoreValue('totals', this.totals).catch(this.error);
    await this.setStoreValue('meterLast', this.meterLast).catch(this.error);
  }

  async show(at) {
    await this.showTotals();
    await this.showLastUse(at);
  }

  async showTotals() {
    const totals = this.totals || { todayL: 0, monthL: 0 };
    await this.setValue(TODAY, Math.round(totals.todayL));
    await this.setValue(MONTH, Math.round(totals.monthL) / 1000);
    if (this.hasCapability(COST_TODAY)) {
      // The litres at the water price, plus the base fee's share of the days so far.
      const price = this.price();
      const fee = waterUse.baseFee(this.baseFee(), this.totals ? this.totals.date : this.date(Date.now()));
      const round = (value) => Math.round(value * 100) / 100;
      await this.setValue(COST_TODAY, round((waterUse.cost(totals.todayL, price) ?? 0) + (fee ? fee.today : 0)));
      await this.setValue(COST_MONTH, round((waterUse.cost(totals.monthL, price) ?? 0) + (fee ? fee.month : 0)));
    }
  }

  /**
   * @description Last use: the use going on, or the last finished one; – before the first.
   */
  async showLastUse(at) {
    if (!this.hasCapability(LAST_USE)) return;
    await this.setValue(LAST_USE, this.lastUseText(at));
  }

  lastUseText(at) {
    const time = (ms) => localTime(this, new Date(ms)).time;
    if (this.use) return this.homey.__('monitor.last_use.running', { start: time(this.use.start), litres: Math.round(waterUse.runningLitres(this.use, at)) });
    const last = this.getStoreValue('lastUse');
    if (!last) return this.homey.__('water.start.none');
    const litres = last.litres < 10 ? last.litres.toFixed(1) : String(Math.round(last.litres));
    const text = this.homey.__('monitor.last_use.ended', { start: time(last.start), end: time(last.end), litres, flow: last.average.toFixed(1) });
    return this.date(last.start) === this.date(at) ? text : `${this.date(last.start)} ${text}`;
  }

  /**
   * @description The totals, the running use and the recent uses, for GET /water.
   */
  learningState() {
    return {
      id: this.getData().id,
      name: this.getName(),
      driver: 'water-monitor',
      meter: this.meter(),
      sources: Object.keys(this.sourceListeners || {}),
      totals: this.totals,
      meterLast: this.meterLast,
      price: this.price(),
      baseFee: this.baseFee(),
      use: this.use,
      uses: this.getStoreValue('uses') || []
    };
  }

  /**
   * @description Repair: another water meter. Its reading is a new starting point; today's and the month's litres stay.
   */
  async onRepairMeter(meter) {
    this.log(`${this.getName()} - onRepairMeter - ${meter.name}: meter ${meter.meter}, flow ${meter.flow}`);
    this.unsubscribeSources();
    this.clearTimer('useEnd');
    this.use = null;
    this.flowLast = null;
    this.meterLast = null;
    this.dirty = true;
    await this.setStoreValue('meter', meter);
    await this.checkCapabilities();
    await this.subscribeSources();
    await this.save();
    await this.show(Date.now());
    return true;
  }
};

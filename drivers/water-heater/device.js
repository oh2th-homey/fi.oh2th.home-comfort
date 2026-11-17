'use strict';

const { localTime, isTime, strToMins, addDays } = require('oh2th-homey-helpers');
const waterDevice = require('../water-device');
const water = require('../../lib/water');

// Starting model until learned: a tank this size (litres; heating 1 l of water by 1 °C takes 4.186 kJ) with good
// insulation (share of the difference to the room lost per hour).
const START_LITRES = 300;
const START_LOSS = 0.002;

// The block is planned at Plan from, or this long after it when Homey was down then.
const BLOCK_LATE_MS = 6 * 3600000;
// Only a ready time this soon after Plan from gets the block (the next morning's).
const BLOCK_AHEAD_MS = 18 * 3600000;
// Heating that stops this much (minutes) before Longest block is the thermostat, not the heater's own timer.
const TIMER_MARGIN_MIN = 10;

module.exports = class waterHeaterDevice extends waterDevice {
  /**
   * @description Without a room sensor: the fixed temperature from the settings.
   */
  fallbackSurroundings() {
    const value = this.getSetting('surroundings_temperature');
    return typeof value === 'number' ? value : 20;
  }

  /**
   * @description A tank heats much faster and loses much less than a hot tub: start from the heater power.
   */
  startModel() {
    const watts = Number(this.getSetting('heater_power')) || 2000;
    return { heatRate: Math.round(((watts / 1000) * 3600 * 10) / (4.186 * START_LITRES)) / 10, loss: START_LOSS };
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
  /**
   * @description A heater on its own timer (e.g. a relay that switches off after Longest block): a stop well before that
   * is its thermostat.
   */
  stoppedBeforeTimer(now = Date.now()) {
    const since = this.getStoreValue('heatingSince');
    const longest = Number(this.getSetting('block_max')) || 0;
    return typeof since === 'number' && longest > 0 && now - since < (longest - TIMER_MARGIN_MIN) * 60000;
  }

  async onDemandedHeatingStopped(temperature, now = Date.now()) {
    const before = this.getStoreValue('fullTemperature');
    if (!water.fullStop(temperature, before, this.keepTemperature())) {
      this.log(`${this.getName()} - heater stopped at ${temperature} °C: below full, not learned`);
      return;
    }
    const full = water.learnFilterTarget(before, temperature);
    this.log(`${this.getName()} - thermostat stopped the heater at ${temperature} °C: full at ${full.toFixed(1)} °C`);
    await this.setStoreValue('fullTemperature', full).catch(this.error);
    await this.setValue('target_temperature', this.shownTarget(full));
    await this.setStoreValue('fullAt', { temperature, at: now }).catch(this.error);
    await this.setStoreValue('reheat', false).catch(this.error);
    this.setSettings({ learned_full: `${full.toFixed(1)} °C` }).catch(this.error);
    this.setTimer('plan', () => this.plan(), 2000);
  }

  /**
   * @description Once a day at Plan from (setting): one heating block before the next ready time (lib/water.js
   * heatingBlock), stored for the plan and told by Heating block planned, for a heater that runs its own schedule. No
   * ready time (e.g. a long absence) or a full tank: a block that doesn't run.
   */
  async planBlock(now = Date.now()) {
    const from = this.getSetting('block_from');
    if (!isTime(from)) return;
    const timeZone = this.homey.clock.getTimezone();
    const today = localTime(this, new Date(now)).date;
    let windowStart = water.localMs(timeZone, today, strToMins(from));
    if (windowStart > now) windowStart = water.localMs(timeZone, addDays(today, -1), strToMins(from));
    if (now - windowStart > BLOCK_LATE_MS || this.getStoreValue('blockTold') === windowStart) return;
    await this.setStoreValue('blockTold', windowStart).catch(this.error);
    const aheadMs = Math.min(30, Math.max(0, Number(this.getSetting('ready_ahead')) || 0)) * 60000;
    const use = this.useList(now).find((u) => u.start - aheadMs > now && u.start - aheadMs - windowStart <= BLOCK_AHEAD_MS);
    const ready = this.readyTemperature();
    const controller = this.homey.app.findController();
    let block = { runs: false, start: null, end: null, minutes: 0, price: null };
    if (use) {
      block = water.heatingBlock({
        from: now,
        readyBy: use.start - aheadMs,
        quarters: controller ? controller.priceQuarters(now) : [],
        temperature: this.decideTemperature(now, ready),
        target: ready,
        outdoor: this.surroundingsTemperature(),
        model: this.getStoreValue('model'),
        maxMinutes: this.getSetting('block_max') || 180
      });
    }
    await this.setStoreValue('block', { ...block, ready: use ? use.start : null }).catch(this.error);
    const time = (ms) => (typeof ms === 'number' ? localTime(this, new Date(ms)).time : '');
    const tokens = {
      runs: block.runs,
      start: time(block.start),
      end: time(block.end),
      minutes: block.minutes,
      ready_time: use ? this.formatTime(use.start) : '',
      price: typeof block.price === 'number' ? Math.round(block.price * 10000) / 10000 : 0
    };
    this.log(`${this.getName()} - heating block ${block.runs ? `${tokens.start}–${tokens.end} (${block.minutes} min) for ${tokens.ready_time}` : 'not needed'}`);
    await this.triggerFlow('water_heating_block_planned', tokens);
  }
};

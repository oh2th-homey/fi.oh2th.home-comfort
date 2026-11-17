'use strict';

const { localTime, isTime, strToMins, addDays } = require('oh2th-homey-helpers');
const waterDevice = require('../water-device');
const water = require('../../lib/water');

// Starting model until learned: a tank this size (litres; heating 1 l of water by 1 °C takes 4.186 kJ) with good
// insulation (share of the difference to the room lost per hour).
const START_LITRES = 300;
const START_LOSS = 0.002;

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

  plansBlock() {
    return isTime(this.getSetting('block_from'));
  }

  /**
   * @description The night heat-up (Plan from set): once per ready time, as soon as the prices cover the night before it,
   * the cheapest full Longest block between Plan from and the ready time (lib/water.js cheapestBlock). Stored for the
   * plan, which heats in it and tops up outside it only when cheaper, and told by Heating planned, so a flow can write it
   * into the heater's own schedule (which then heats also when Homey is down).
   */
  async planBlock(now = Date.now()) {
    if (!this.plansBlock()) return;
    const controller = this.homey.app.findController();
    if (!controller) return;
    const aheadMs = Math.min(30, Math.max(0, Number(this.getSetting('ready_ahead')) || 0)) * 60000;
    const use = this.useList(now).find((u) => u.start - aheadMs > now);
    if (!use || this.getStoreValue('blockTold') === use.start) return;
    const readyBy = use.start - aheadMs;
    // Plan from before the ready time: the evening before a morning ready time.
    const timeZone = this.homey.clock.getTimezone();
    const day = localTime(this, new Date(readyBy)).date;
    const fromMins = strToMins(this.getSetting('block_from'));
    let windowStart = water.localMs(timeZone, day, fromMins);
    if (windowStart >= readyBy) windowStart = water.localMs(timeZone, addDays(day, -1), fromMins);
    const block = water.cheapestBlock({
      from: Math.max(now, windowStart),
      readyBy,
      quarters: controller.priceQuarters(now),
      minutes: Number(this.getSetting('block_max')) || 180
    });
    // The prices for the night aren't published yet.
    if (!block) return;
    await this.setStoreValue('blockTold', use.start).catch(this.error);
    await this.setStoreValue('plannedTold', use.start).catch(this.error);
    await this.setStoreValue('block', { ...block, ready: use.start }).catch(this.error);
    const time = (ms) => localTime(this, new Date(ms)).time;
    const reason = this.reasonText({ code: 'block_wait', args: { ready: use.start, start: block.start, until: block.end } });
    const tokens = {
      ready_time: this.formatTime(use.start),
      expected_start: time(block.start),
      expected_ready: time(block.end),
      target_temperature: Math.round((Number(this.readyTemperature()) || 0) * 10) / 10,
      reason,
      end: time(block.end),
      minutes: block.minutes,
      price: Math.round(block.price * 10000) / 10000
    };
    this.log(`${this.getName()} - heating block ${tokens.expected_start}–${tokens.end} (${block.minutes} min) for ${tokens.ready_time}`);
    await this.triggerFlow('water_heating_planned', tokens);
  }
};

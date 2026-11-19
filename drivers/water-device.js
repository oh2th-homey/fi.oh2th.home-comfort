'use strict';

const { localTime, isTime, addDays, updateCapabilities } = require('oh2th-homey-helpers');
const mainDevice = require('./main-device');
const water = require('../lib/water');

// On/off is the heating demand; the mode decides how: auto (the device), heat (holds ready) or off.
const DEMAND = 'onoff';
const MODE = 'thermostat_mode';
const MODES = ['auto', 'heat', 'off'];
const READY = 'heating_ready';
const STATE = 'enum_water_state';
// Reasons while the water is held at ready for a use (lib/water.js decide).
const READY_CODES = ['ready', 'in_use', 'in_use_heat', 'ready_hold', 'ready_hold_heat'];
const SURROUNDINGS = 'measure_temperature.ambient';
const POWER = 'measure_power';
const TEMPERATURE = 'measure_temperature';
// A tank's full temperature until its thermostat has been seen stopping the heater (°C).
const DEFAULT_FULL = 60;
// A heater with its own thermostat shows its target this far below the learned one, in whole degrees: a tank that has
// cooled a little since the thermostat stopped it then doesn't look short of its target in the UI.
const SHOWN_BELOW_FULL = 2;
// A water temperature not updated for this long counts as unknown (some spas report only while the pump runs).
const WATER_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const SURROUNDINGS_MAX_AGE_MS = 3 * 60 * 60 * 1000;
// Re-plan at least this often (minutes); temperature, price and setting changes re-plan sooner.
const PLAN_MINUTES = 5;
// Segments for learning: a long wait or heating is closed and learned from now and then.
const MAX_IDLE_HOURS = 6;
const MAX_HEAT_HOURS = 3;
// Heating starts the circulation: a sensor in the water first jumps to the mixed temperature. A heating segment is
// measured from this long after the start, so mixing is not learned as heating.
const SETTLE_MS = 15 * 60000;
// After this long without heating the water counts as standing still: it is planned with the learned mixing drop.
const STILL_MS = 60 * 60000;
// A heating stop this soon after the app switched the heater switch off was the app, not the heater's thermostat.
const SWITCHED_OFF_MS = 3 * 60000;

/**
 * Shared device base of the Hot Tub and the Water Heater (issue #1): reads the water temperature, the surroundings and
 * an optional power meter from other devices, learns the heating curve (lib/water.js), and demands heating in the cheapest
 * quarters on the HVAC Controller's prices. The user's flows turn the demand into the heater's own actions.
 */
module.exports = class waterDevice extends mainDevice {
  /**
   * @description Surroundings when no sensor gives them: overridden per driver.
   */
  fallbackSurroundings() {
    return 5;
  }

  async onInitDevice() {
    // Water heater class (earlier versions: other).
    const deviceClass = this.driver.manifest.class;
    if (deviceClass && this.getClass() !== deviceClass) await this.setClass(deviceClass).catch(this.error);
    this.sourceListeners = {};
    this.segment = this.getStoreValue('segment') || null;
    this.still = this.getStoreValue('still') || null;
    this.demandSince = null;
    await this.seedModel();
    await this.subscribeSources();
  }

  /**
   * @description A starting model for a device type whose water behaves very differently from a hot tub (overridden):
   * { heatRate, loss }, or null for the shared default.
   */
  startModel() {
    return null;
  }

  /**
   * @description Until anything is learned, plan with the device type's starting model (learning replaces it).
   */
  async seedModel() {
    const start = this.startModel();
    const stored = this.getStoreValue('model');
    if (!start || (stored && (stored.heatHours > 0 || stored.idleHours > 0))) return;
    await this.setStoreValue('model', { ...(stored || {}), ...start, heatHours: 0, idleHours: 0 }).catch(this.error);
  }

  async onDeleted() {
    this.unsubscribeSources();
    await super.onDeleted();
  }

  async onUninit() {
    this.unsubscribeSources();
    await super.onUninit();
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log(`${this.getName()} - onSettings - changed: ${changedKeys}`);
    // The starting model follows the heater power until something is learned.
    if (changedKeys.includes('heater_power')) this.homey.setTimeout(() => this.seedModel().catch(this.error), 1000);
    if (typeof newSettings.keep_temperature === 'number' && newSettings.keep_temperature >= newSettings.max_temperature) throw new Error(this.homey.__('water.error.keep_max'));
    if (newSettings.use_time && !isTime(newSettings.use_time)) throw new Error(this.homey.__('water.error.time'));
    const ready = this.getCapabilityValue('target_temperature');
    if (typeof ready === 'number' && ready > newSettings.max_temperature) throw new Error(this.homey.__('water.error.ready_max'));
    // After Homey has saved the settings.
    this.setTimer('plan', () => this.plan(), 1000);
  }

  /**
   * @description Power is shown only when a power meter is chosen.
   */
  async checkCapabilities() {
    const capabilities = [...(this.driver.manifest.capabilities || [])];
    if (this.getStoreValue('power')) capabilities.push(POWER);
    const tank = this.getStoreValue('tank');
    const positions = tank ? water.TANK_POSITIONS.filter((position) => tank[position]) : [];
    for (const position of positions) capabilities.push(`${TEMPERATURE}.${position}`);
    const result = await updateCapabilities(this, capabilities, this.getCapabilities());
    for (const position of positions) {
      await this.setCapabilityOptions(`${TEMPERATURE}.${position}`, { title: this.homey.__(`water.tank.${position}`), units: '°C', decimals: 1 }).catch(this.error);
    }
    // Devices paired before it became read only: the manifest's options (setable false) again, all of them together.
    const targetOptions = (this.driver.manifest.capabilitiesOptions || {}).target_temperature;
    if (targetOptions && targetOptions.setable === false) await this.setCapabilityOptions('target_temperature', targetOptions).catch(this.error);
    // Homey's own title for measure_power: clear the custom one that earlier versions set.
    if (this.hasCapability(POWER)) {
      let options = {};
      try {
        options = this.getCapabilityOptions(POWER) || {};
      } catch (error) {
        options = {};
      }
      if (options.title) await this.setCapabilityOptions(POWER, {}).catch(this.error);
    }
    return result;
  }

  async setCapabilityListeners() {
    this.registerCapabilityListener('target_temperature', this.onCapability_TARGET_TEMPERATURE.bind(this));
    this.registerCapabilityListener(READY, this.onCapability_HEATING_READY.bind(this));
    this.registerCapabilityListener(DEMAND, this.onCapability_ONOFF.bind(this));
    this.registerCapabilityListener(MODE, this.onCapability_THERMOSTAT_MODE.bind(this));
  }

  /**
   * @description Heating on or off by hand. In mode Automatic: on heats to the target temperature, off stops the heating
   * going on now (lib/water.js applyManual). In mode Heat or Off: switches the mode (on: Heat, off: Off).
   */
  async onCapability_ONOFF(value) {
    this.log(`${this.getName()} - onCapability_ONOFF - ${value}`);
    try {
      if (value === this.getCapabilityValue(DEMAND)) return Promise.resolve(false);
      if (this.mode() === 'auto') await this.setStoreValue('manual', { on: value, at: Date.now() });
      else await this.setValue(MODE, value ? 'heat' : 'off');
      // Homey stores the value when the listener resolves; plan right after.
      this.setTimer('plan', () => this.plan(), 500);
      return Promise.resolve(true);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /**
   * @description Mode: Automatic (the device decides), Heat (holds the target temperature, whatever the price) or Off (no
   * heating demand; the heater is left to its own controls, Keep isn't held).
   */
  async onCapability_THERMOSTAT_MODE(value) {
    this.log(`${this.getName()} - onCapability_THERMOSTAT_MODE - ${value}`);
    try {
      if (!MODES.includes(value)) throw new Error(this.homey.__('error.invalid_value', { value }));
      if (value === this.mode()) return Promise.resolve(false);
      await this.setStoreValue('manual', null);
      // Homey stores the value when the listener resolves; plan right after.
      this.setTimer('plan', () => this.plan(), 500);
      return Promise.resolve(true);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /**
   * @description auto | heat | off (unknown: auto).
   */
  mode() {
    const value = this.getCapabilityValue(MODE);
    return MODES.includes(value) ? value : 'auto';
  }

  /**
   * @description The heating demand last announced (triggers fired), which on/off follows.
   */
  demanded() {
    return this.getStoreValue('demand') === true;
  }

  /**
   * @description Heating ready: off ends the use being held now; on is ready now, held until turned off.
   */
  async onCapability_HEATING_READY(value) {
    this.log(`${this.getName()} - onCapability_HEATING_READY - ${value}`);
    try {
      if (value && this.mode() !== 'auto') throw new Error(this.homey.__('water.error.off'));
      const now = Date.now();
      const active = this.activeUse(now);
      if (value && !active) {
        const oneOffs = [...(this.getStoreValue('oneOffs') || []), { start: now, minutes: (this.getSetting('manual_ready_hours') || 12) * 60 }];
        await this.setStoreValue('oneOffs', oneOffs);
      } else if (!value && active) {
        await this.setStoreValue('skipped', [...(this.getStoreValue('skipped') || []), active.start]);
        // Ended by hand: still in use for AFTER_USE_MS from now, so learning skips the stirred water after it.
        if (active.start <= now) await this.setStoreValue('ended', [...(this.getStoreValue('ended') || []), { start: active.start, end: now }]);
      }
      await this.setValue(READY, value);
      this.setTimer('plan', () => this.plan(), 500);
      return Promise.resolve(true);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /**
   * @description In use now or ended less than AFTER_USE_MS ago, including uses ended early by turning Heating ready off.
   */
  inUseNow(now) {
    return water.inUse([...this.useList(now - water.AFTER_USE_MS), ...(this.getStoreValue('ended') || [])], now);
  }

  /**
   * @description The use whose target temperature is held now: running, or reached shortly before it.
   */
  activeUse(now) {
    const [use] = this.useList(now);
    if (!use) return null;
    return use.start <= now || this.getStoreValue('reachedFor') === use.start ? use : null;
  }

  /**
   * @description Keep: never below it, also between ready times (°C). Null when the device has no keep (Hot Tub: between
   * ready times its own controller holds the water).
   */
  keepTemperature() {
    const keep = this.getSetting('keep_temperature');
    return typeof keep === 'number' && Number.isFinite(keep) ? keep : null;
  }

  async onCapability_TARGET_TEMPERATURE(value) {
    this.log(`${this.getName()} - onCapability_TARGET_TEMPERATURE - ${value}`);
    try {
      const keep = this.keepTemperature();
      const max = this.getSetting('max_temperature');
      const below = keep !== null && value <= keep;
      if (typeof value !== 'number' || !Number.isFinite(value) || below || value > max) {
        throw new Error(keep === null ? this.homey.__('water.error.ready_range_no_keep', { max }) : this.homey.__('water.error.ready_range', { keep, max }));
      }
      // Homey stores the value when the listener resolves; plan right after.
      this.setTimer('plan', () => this.plan(), 1000);
      return Promise.resolve(true);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async setCapabilityValues(check = false) {
    try {
      if (this.heatsToFull()) {
        // Read only: the temperature it heats to, learned from the tank's thermostat (the starting value until seen).
        await this.setValue('target_temperature', this.shownTarget(this.readyTemperature()), check);
      } else if (typeof this.getCapabilityValue('target_temperature') !== 'number') {
        await this.setValue('target_temperature', this.getStoreValue('ready') || this.getSettings().max_temperature - 2, check);
      }
      await this.setValue('measure_temperature', this.waterTemperature(), check);
      for (const position of water.TANK_POSITIONS) {
        if (this.hasCapability(`${TEMPERATURE}.${position}`)) await this.setValue(`${TEMPERATURE}.${position}`, this.positionTemperature(position), check);
      }
      await this.setValue(SURROUNDINGS, this.surroundingsTemperature(), check);
      if (this.hasCapability(POWER)) await this.setValue(POWER, this.powerReading(), check);
      // Before the mode, on/off was the control: carry it over once (on: auto, off: off), then on/off shows the demand.
      if (!MODES.includes(this.getCapabilityValue(MODE))) {
        await this.setValue(MODE, this.getCapabilityValue(DEMAND) === false ? 'off' : 'auto', check);
        await this.setValue(DEMAND, false, check);
      } else if (typeof this.getCapabilityValue(DEMAND) !== 'boolean') {
        await this.setValue(DEMAND, this.demanded(), check);
      }
      if (typeof this.getCapabilityValue(READY) !== 'boolean') await this.setValue(READY, false, check);
      if (typeof this.getCapabilityValue('alarm_problem') !== 'boolean') await this.setValue('alarm_problem', false, check);
    } catch (error) {
      this.error(`${this.getName()} - setCapabilityValues - ${error}`);
    }
  }

  async onReady() {
    await this.plan();
  }

  async onInterval(now) {
    const local = localTime(this, now);
    // Sources missed at start (their app started later) are retried.
    if (local.minutes % 5 === 0) await this.subscribeSources();
    await this.track(now.getTime());
    if (local.minutes % PLAN_MINUTES === 0) {
      await this.planBlock(now.getTime());
      await this.plan(now.getTime());
      await this.planFilters(now.getTime());
    }
  }

  /**
   * @description The night heating block: only the Water Heater, with Plan from (overridden).
   */
  async planBlock() {}

  /**
   * @description Plans a night heating block (Water Heater with Plan from): its Heating planned comes from the block.
   */
  plansBlock() {
    return false;
  }

  /**
   * @description Filter cycles: only the Hot Tub has them (overridden).
   */
  async planFilters() {}

  /**
   * @description The heater's own filter cycles ahead, [{ start, end }] (ms): only the Hot Tub has them (overridden).
   */
  filterList() {
    return [];
  }

  /**
   * @description The heater stopped on its own while the pump runs on: what its own thermostat heats to (overridden).
   */
  async onOwnHeatingStopped() {}

  /**
   * @description Prices or the surroundings on the controller changed.
   */
  async onSharedStateChanged() {
    // New prices: the night block can be planned now (before the plan, which heats by it).
    this.setTimer('plan', async () => {
      await this.planBlock();
      await this.plan();
    }, 2000);
  }

  /**
   * Sources: other devices' capabilities chosen at pairing or repair, store { id, cap, name }.
   */
  sources() {
    const list = [];
    const surroundings = this.getStoreValue('surroundings');
    const power = this.getStoreValue('power');
    // From a flow: the Set water / tank temperature card feeds it, nothing to subscribe to.
    for (const [key, source] of Object.entries(this.waterSources())) if (source && !source.flow) list.push({ key, ...source });
    if (surroundings) list.push({ key: 'surroundings', ...surroundings });
    if (power) list.push({ key: 'power', ...power, cap: 'measure_power' });
    const heaterSwitch = this.getStoreValue('heaterSwitch');
    if (heaterSwitch) list.push({ key: 'switch', ...heaterSwitch });
    return list;
  }

  async subscribeSources() {
    for (const source of this.sources()) {
      if (this.sourceListeners[source.key]) continue;
      const listener = (value) => this.onSource(source.key, value).catch(this.error);
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

  /**
   * @description The water temperature sources by key: 'water' (one sensor, e.g. a Hot Tub), or a tank's 'top',
   * 'middle' and 'bottom' (Water Heater; null when not installed). Each { id, cap, name } or { flow: true }.
   */
  waterSources() {
    const tank = this.getStoreValue('tank');
    if (tank) return Object.fromEntries(water.TANK_POSITIONS.map((position) => [position, tank[position] || null]));
    return { water: this.getStoreValue('water') };
  }

  isTank() {
    return !!this.getStoreValue('tank');
  }

  async onSource(key) {
    if (key === 'water' || water.TANK_POSITIONS.includes(key)) {
      if (key !== 'water') await this.setValue(`${TEMPERATURE}.${key}`, this.positionTemperature(key));
      const changed = await this.setValue('measure_temperature', this.waterTemperature());
      // Reaching keep, ready or max should not wait for the next plan.
      if (changed && !this.initializing) this.setTimer('plan', () => this.plan(), 2000);
    } else if (key === 'surroundings') {
      await this.setValue(SURROUNDINGS, this.surroundingsTemperature());
    } else if (key === 'switch') {
      await this.onHeaterSwitch();
    } else if (key === 'power') {
      const watts = this.powerReading();
      await this.setValue(POWER, watts);
      // The power levels, learned from the meter: heating and the base load (circulation pump).
      const learned = water.learnPower(this.powerStore(), watts, this.ratedSetting());
      if (learned.heatW !== this.getStoreValue('powerW')) await this.setStoreValue('powerW', learned.heatW).catch(this.error);
      if (learned.baseW !== this.getStoreValue('baseW')) await this.setStoreValue('baseW', learned.baseW).catch(this.error);
      this.showPower();
    }
  }

  read(key, maxAge) {
    const source = this.sourceListeners[key];
    const reading = source ? this.homey.app.members.read(source.id, source.cap) : null;
    if (!reading || !reading.available || typeof reading.value !== 'number' || !Number.isFinite(reading.value)) return null;
    if (maxAge && reading.lastUpdated && Date.now() - reading.lastUpdated.getTime() > maxAge) return null;
    return reading.value;
  }

  /**
   * @description One source's temperature (0.1 °C), null when not installed, stale or out of range.
   */
  positionTemperature(key) {
    const source = this.waterSources()[key];
    if (!source) return null;
    const value = source.flow ? this.flowWater(key) : this.read(key, WATER_MAX_AGE_MS);
    return value === null || value < -5 || value > 100 ? null : Math.round(value * 10) / 10;
  }

  /**
   * @description The tank's readings (Water Heater with tank sensors): the average and the reading for Keep.
   */
  tankTemperature() {
    return water.tankTemperature(Object.fromEntries(water.TANK_POSITIONS.map((position) => [position, this.positionTemperature(position)])));
  }

  /**
   * @description The water temperature shown and planned with: one sensor, or a tank's average.
   */
  waterTemperature() {
    return this.isTank() ? this.tankTemperature().average : this.positionTemperature('water');
  }

  /**
   * @description The water temperature to plan and learn with: while the water stands still, minus the mixing drop.
   */
  planTemperature(now = Date.now()) {
    // A tank's average over its heights needs no mixing drop.
    if (this.isTank()) return this.waterTemperature();
    return water.mixedTemperature(this.waterTemperature(), this.getStoreValue('model'), this.isStill(now));
  }

  isStill(now) {
    // With a power meter: the pump stopped at least STILL_MS ago (unknown since when: still, the safe side).
    const flow = this.flowState();
    if (flow) {
      if (flow !== 'still') return false;
      const { still } = this;
      // In use: still once the water has stood STILL_MS since it last moved (lib/water.js stillStep).
      if (still && still.phase === 'used') return typeof still.since === 'number' && now - still.since >= STILL_MS;
      return !(still && still.phase === 'still' && now - still.at < STILL_MS);
    }
    if (this.isHeating()) return false;
    const stillSince = this.getStoreValue('stillSince');
    // Unknown after a restart: still, the safe side.
    return typeof stillSince !== 'number' || now - stillSince >= STILL_MS;
  }

  /**
   * @description Surroundings: the own sensor, else the driver's fallback (overridden).
   */
  surroundingsTemperature() {
    const value = this.read('surroundings', SURROUNDINGS_MAX_AGE_MS);
    if (value !== null && value >= -60 && value <= 60) return Math.round(value * 10) / 10;
    return this.fallbackSurroundings();
  }

  /**
   * @description Heater power (W) from the meter. Meters report small negative values at idle (noise): read them as 0,
   * not as missing, or the capability flips 0 → empty → 0 and Homey's "power dropped below" cards run while idle.
   */
  powerReading() {
    const value = this.read('power');
    if (value === null) return null;
    return Math.max(0, Math.round(value));
  }

  /**
   * @description Heater power (W) from the settings, used until the meter has shown heating.
   */
  /**
   * @description The price per kWh over which a ready time is skipped (the heating for it, or the ready time itself);
   * null = always heat. Here the device's Price limit setting; the Hot Tub uses the home's Expensive above.
   */
  // eslint-disable-next-line no-unused-vars
  readyPriceLimit(controller) {
    const limit = this.getSetting('price_limit');
    return limit > 0 ? limit : null;
  }

  /**
   * @description Whether a ready time is skipped when its own time costs over the price limit (the Hot Tub: no).
   */
  usePriceSkips() {
    return true;
  }

  ratedSetting() {
    return this.getSetting('heater_power') || 3000;
  }

  powerStore() {
    return { heatW: this.getStoreValue('powerW'), baseW: this.getStoreValue('baseW') };
  }

  /**
   * @description Power while heating (W), for the cost of a quarter: learned from the meter, else the setting.
   */
  ratedPower() {
    return water.powerLevels(this.powerStore(), this.ratedSetting()).heatW;
  }

  /**
   * @description The heater heats now: by the power meter when there is one (right also when the device's own thermostat
   * cycles), else by the demand.
   */
  isHeating() {
    if (this.getStoreValue('power')) {
      const watts = this.powerReading();
      if (watts !== null) return watts > water.powerLevels(this.powerStore(), this.ratedSetting()).threshold;
    }
    return this.getCapabilityValue(DEMAND) === true;
  }

  /**
   * @description Learning, every minute: a segment runs while the heater heats or waits; when it changes (or after
   * MAX_*_HOURS) it is learned from and a new one starts.
   */
  async track(now) {
    // With a power meter: still, circulating or heating (trackFlow). Without one, heating is the demand (below).
    const flow = this.flowState();
    if (flow) {
      await this.trackFlow(now, flow);
      return;
    }
    const raw = this.waterTemperature();
    // Heating segments measure the mixed water (raw), waiting ones the planned temperature.
    const temperature = this.isHeating() ? raw : this.planTemperature(now);
    const surroundings = this.surroundingsTemperature();
    if (temperature === null) {
      if (this.segment) await this.saveSegment(null);
      return;
    }
    const heating = this.isHeating();
    const seg = this.segment;
    // In use (and shortly after): jets, people and an open lid. Learn what came before, then nothing until it's over;
    // the water is stirred, so it doesn't count as standing still either.
    // The list from AFTER_USE_MS ago, so a use that just ended is still in it.
    if (this.inUseNow(now)) {
      if (seg && seg.from !== null) await this.learnSegment(seg, now, temperature);
      if (seg) await this.saveSegment(null);
      await this.setStoreValue('stillSince', now).catch(this.error);
      return;
    }
    if (!seg || (seg.from === null && heating !== seg.heating)) {
      await this.startSegment(heating, now, raw, surroundings, seg);
      return;
    }
    if (seg.from === null) {
      // Heating: the water is still mixing. Once mixed, learn how much the still water read too high.
      if (now < seg.start) return;
      if (typeof seg.before === 'number') {
        const mix = water.learnMix(this.getStoreValue('model'), { before: seg.before, after: raw, heatedHours: SETTLE_MS / 3600000 });
        if (mix.value !== null) {
          this.log(`${this.getName()} - learned mixing drop ${mix.value.toFixed(2)} °C: average ${mix.model.mixDrop.toFixed(2)} °C`);
          await this.setStoreValue('model', mix.model).catch(this.error);
          await this.showModel(mix.model);
        }
      }
      await this.saveSegment({ ...seg, from: raw, outSum: surroundings, outN: 1 });
      return;
    }
    seg.outSum += surroundings;
    seg.outN += 1;
    const hours = (now - seg.start) / 3600000;
    if (heating === seg.heating && hours < (seg.heating ? MAX_HEAT_HOURS : MAX_IDLE_HOURS)) {
      // Kept in memory; written each quarter so a restart doesn't lose much.
      if (Math.round(hours * 60) % 15 === 0) await this.saveSegment(seg);
      return;
    }
    await this.learnSegment(seg, now, temperature);
    await this.startSegment(heating, now, raw, surroundings, seg);
  }

  /**
   * @description Still, circulating or heating by the power meter; null without one or without a reading.
   */
  flowState() {
    if (!this.getStoreValue('power')) return null;
    return water.flowState(this.powerReading(), water.powerLevels(this.powerStore(), this.ratedSetting()));
  }

  /**
   * @description Learning with a power meter, every minute. The cooling and the mixing drop come from still stretches
   * between two mixed readings (lib/water.js stillStep); the heating rate from heating segments, as without a meter.
   */
  async trackFlow(now, flow) {
    const raw = this.waterTemperature();
    const surroundings = this.surroundingsTemperature();
    const inUse = this.inUseNow(now);
    const step = water.stillStep(this.still, { now, flow, raw, outdoor: surroundings, inUse, model: this.getStoreValue('model'), draws: this.isTank() });
    if (step.draw) this.log(`${this.getName()} - hot water drawn: ${raw} °C, cooling stretch ended before it`);
    if (step.mix) {
      const mix = water.learnMix(this.getStoreValue('model'), step.mix);
      if (mix.value !== null) {
        this.log(`${this.getName()} - learned mixing drop ${mix.value.toFixed(2)} °C: average ${mix.model.mixDrop.toFixed(2)} °C`);
        await this.setStoreValue('model', mix.model).catch(this.error);
        await this.showModel(mix.model);
      }
    }
    if (step.loss) {
      const result = water.learn(this.getStoreValue('model'), { heating: false, ...step.loss });
      const { hours, from, to } = step.loss;
      this.log(`${this.getName()} - still ${hours.toFixed(2)} h ${from.toFixed(1)} → ${to.toFixed(1)} °C: ${result.learned ? `loss ${result.value.toFixed(4)}/h, now ${result.model.loss.toFixed(4)}/h` : 'not learned'}`);
      if (result.learned) {
        await this.setStoreValue('model', result.model).catch(this.error);
        await this.showModel(result.model);
      }
    }
    await this.saveStill(step.state, now);
    // The heater stopped while the pump runs on, without demand from this device: its own thermostat was satisfied.
    if (this.lastFlow === 'heating' && flow === 'circulating' && !this.demanded() && raw !== null && !inUse && !this.stoppedBySwitch(now)) await this.onOwnHeatingStopped(raw, now);
    // The heater stopped while heating is demanded, or before its own timer would end it: a tank's thermostat may have
    // found it full.
    if (this.lastFlow !== 'heating' && flow === 'heating') await this.setStoreValue('heatingSince', now).catch(this.error);
    const thermostat = (this.demanded() || this.stoppedBeforeTimer(now)) && !this.stoppedBySwitch(now);
    if (this.lastFlow === 'heating' && flow !== 'heating' && raw !== null && thermostat) await this.onDemandedHeatingStopped(raw, now);
    this.lastFlow = flow;

    // Heating segments: the heating rate.
    const seg = this.segment;
    if (inUse || raw === null) {
      if (seg && seg.heating && seg.from !== null && raw !== null) await this.learnSegment(seg, now, raw);
      if (seg) await this.saveSegment(null);
      return;
    }
    if (flow !== 'heating') {
      // Waiting segments from before a meter reading was seen are dropped: the cooling comes from still stretches.
      if (seg && seg.heating && seg.from !== null) await this.learnSegment(seg, now, raw);
      if (seg) await this.saveSegment(null);
      return;
    }
    if (!seg || !seg.heating) {
      await this.saveSegment({ heating: true, start: now + SETTLE_MS, from: null, outSum: 0, outN: 0 });
      return;
    }
    if (seg.from === null) {
      if (now >= seg.start) await this.saveSegment({ ...seg, from: raw, outSum: surroundings, outN: 1 });
      return;
    }
    seg.outSum += surroundings;
    seg.outN += 1;
    const hours = (now - seg.start) / 3600000;
    if (hours < MAX_HEAT_HOURS) {
      if (Math.round(hours * 60) % 15 === 0) await this.saveSegment(seg);
      return;
    }
    await this.learnSegment(seg, now, raw);
    await this.saveSegment({ heating: true, start: now, from: raw, outSum: surroundings, outN: 1 });
  }

  /**
   * @description The still stretch state: in memory, written when its phase changes and each quarter.
   */
  async saveStill(state, now) {
    const before = this.still;
    this.still = state;
    const changed = (before && before.phase) !== (state && state.phase);
    if (changed || Math.round(now / 60000) % 15 === 0) await this.setStoreValue('still', state).catch(this.error);
  }

  /**
   * @description Learn from a finished segment (lib/water.js learn) and show the curve when it changed.
   */
  async learnSegment(seg, now, temperature) {
    const hours = (now - seg.start) / 3600000;
    const result = water.learn(this.getStoreValue('model'), { heating: seg.heating, hours, from: seg.from, to: temperature, outdoor: seg.outSum / seg.outN });
    if (!result.learned) return;
    this.log(`${this.getName()} - learned ${result.learned} ${result.value.toFixed(4)} from ${hours.toFixed(2)} h: heat ${result.model.heatRate.toFixed(2)} °C/h, loss ${result.model.loss.toFixed(4)}/h`);
    await this.setStoreValue('model', result.model).catch(this.error);
    await this.showModel(result.model);
  }

  /**
   * @description A new learning segment. Heating is measured only after SETTLE_MS of mixing; when the water stood still
   * before, the reading now is kept to learn the mixing drop. Waiting starts from the mixed water.
   */
  async startSegment(heating, now, raw, surroundings, previous) {
    if (heating) {
      const before = previous && !previous.heating && this.isStillBefore(now) ? raw : null;
      await this.saveSegment({ heating, start: now + SETTLE_MS, from: null, before, outSum: 0, outN: 0 });
      return;
    }
    // Heating (circulation) stopped now: the water starts standing still.
    if (previous && previous.heating) await this.setStoreValue('stillSince', now).catch(this.error);
    await this.saveSegment({ heating, start: now, from: this.planTemperature(now), outSum: surroundings, outN: 1 });
  }

  isStillBefore(now) {
    const stillSince = this.getStoreValue('stillSince');
    return typeof stillSince === 'number' && now - stillSince >= STILL_MS;
  }

  async saveSegment(seg) {
    this.segment = seg;
    await this.setStoreValue('segment', seg).catch(this.error);
  }

  /**
   * @description The learned power levels in the device settings (label), when they change by more than rounding.
   */
  showPower() {
    if (!this.getStoreValue('power')) return;
    const { heatW, baseW } = this.powerStore();
    if (typeof heatW !== 'number' && typeof baseW !== 'number') return;
    const kW = (w) => (typeof w === 'number' ? (w / 1000).toFixed(1) : '-');
    const text = this.homey.__('water.model.power', { heating: kW(heatW), base: kW(baseW) });
    if (text !== this.getSetting('learned_power')) this.setSettings({ learned_power: text }).catch(this.error);
  }

  /**
   * @description The learned curve in the device settings (labels).
   */
  async showModel(stored) {
    const m = water.model(stored);
    const learned = water.confident(m) ? this.homey.__('water.model.learned') : this.homey.__('water.model.learning', { hours: Math.round(m.heatHours * 10) / 10 });
    await this.setSettings({
      learned_heat_rate: `${m.heatRate.toFixed(1)} °C/h`,
      learned_loss: `${(m.loss * 100).toFixed(2)} %/h`,
      learned_mix: `${m.mixDrop.toFixed(1)} °C`,
      learned_state: learned
    }).catch(this.error);
  }

  /**
   * @description What has been learned, for GET /water (api.js): the model with its hours seen, the power levels, the
   * open learning segment and the water now.
   */
  learningState(now = Date.now()) {
    const stored = this.getStoreValue('model');
    const m = water.model(stored);
    const iso = (ms) => (typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null);
    const seg = this.segment;
    return {
      id: this.getData().id,
      name: this.getName(),
      driver: this.driver.id,
      model: { ...m, stored: stored || null },
      confident: water.confident(m),
      exactness: water.exactness(m),
      power: this.powerStore(),
      segment: seg ? { ...seg, start: iso(seg.start), hours: (now - seg.start) / 3600000, surroundings: seg.outN ? seg.outSum / seg.outN : null } : null,
      stillSince: iso(this.getStoreValue('stillSince')),
      still: this.isStill(now),
      flow: this.flowState(),
      stretch: this.still ? { ...this.still, at: iso(this.still.at) } : null,
      heating: this.isHeating(),
      inUse: this.inUseNow(now),
      water: this.waterTemperature(),
      planTemperature: this.planTemperature(now),
      filterTarget: this.getStoreValue('filterTarget'),
      filters: this.filterList(now).map((f) => ({ start: iso(f.start), end: iso(f.end) })),
      surroundings: this.surroundingsTemperature(),
      reason: this.getCapabilityValue('text_reason')
    };
  }

  /**
   * @description The uses from now: weekly use time from the settings, one-offs from flows, minus skipped ones.
   */
  useList(now) {
    const settings = this.getSettings();
    const days = Object.fromEntries(water.DAYS.map((day) => [day, settings[`use_${day}`] !== false]));
    // Long absence: no weekly ready times (issue #33); one-offs set on purpose still count.
    const time = this.longAbsence().on ? '' : settings.use_time || '';
    return water.uses({
      now,
      timeZone: this.homey.clock.getTimezone(),
      schedule: { time, minutes: settings.use_minutes, days },
      oneOffs: this.getStoreValue('oneOffs') || [],
      skipped: this.getStoreValue('skipped') || []
    });
  }

  /**
   * @description Whether the heater has its own thermostat that decides when the water is full, seen as the heater
   * stopping by itself while heating is demanded (Water Heater: overridden).
   */
  heatsToFull() {
    return false;
  }

  /**
   * @description The target shown on a heater with its own thermostat (UI only): the learned one minus SHOWN_BELOW_FULL,
   * in whole degrees rounded down. Planning uses the learned one.
   */
  shownTarget(full) {
    return Math.floor(full - SHOWN_BELOW_FULL);
  }

  /**
   * @description The temperature ready times and reheats heat to: the target temperature, or (a heater with its own
   * thermostat) the full temperature learned from it; before that, a usual hot water thermostat setting, at most
   * Maximum (its first stop above Keep then teaches the real one).
   */
  readyTemperature() {
    if (!this.heatsToFull()) return this.getCapabilityValue('target_temperature');
    const full = this.getStoreValue('fullTemperature');
    return typeof full === 'number' ? full : Math.min(DEFAULT_FULL, this.getSetting('max_temperature'));
  }

  /**
   * @description The temperature to decide with: the planned one, but while the tank is still full since its thermostat
   * stopped the heater (cooled only by standby losses, lib/water.js stillFull), at least the ready temperature.
   */
  decideTemperature(now, ready) {
    const temperature = this.planTemperature(now);
    if (!this.heatsToFull() || !water.stillFull(this.getStoreValue('fullAt'), temperature, { now, outdoor: this.surroundingsTemperature(), model: this.getStoreValue('model'), heatedSince: this.getStoreValue('heatingSince') })) return temperature;
    return Math.max(temperature, ready);
  }

  /**
   * @description Heating to full after the tank fell below Keep, until it is full (or the mode isn't Automatic).
   */
  async updateReheat(temperature, ready) {
    const reheat = this.getStoreValue('reheat') === true;
    if (!reheat) return false;
    if (typeof temperature === 'number' && temperature < ready) return true;
    await this.setStoreValue('reheat', false).catch(this.error);
    return false;
  }

  /**
   * @description The heater stopped while heating was demanded (with a power meter): the Water Heater checks whether
   * its thermostat found the tank full (overridden).
   */
  async onDemandedHeatingStopped() {}

  /**
   * @description Heating without demand from this device stopped before the heater's own timer would end it
   * (overridden by the Water Heater).
   */
  stoppedBeforeTimer() {
    return false;
  }

  /**
   * @description The HVAC Controller's long absence: { on, until } (until: its last day, YYYY-MM-DD, or '' when open).
   */
  longAbsence() {
    const controller = this.homey.app.findController();
    if (!controller) return { on: false, until: '' };
    const on = controller.getSharedState().longAbsence === true;
    return { on, until: on ? controller.getSetting('absence_until') || '' : '' };
  }

  /**
   * @description The reason while a long absence leaves no ready time, e.g. "Long absence until 22 Nov: no ready times".
   */
  absenceText(until) {
    if (!until) return this.homey.__('water.reason.long_absence');
    const [year, month, day] = until.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day)).toLocaleDateString(this.homey.i18n.getLanguage(), { day: 'numeric', month: 'short', timeZone: 'UTC' });
    return this.homey.__('water.reason.long_absence_until', { until: date });
  }

  /**
   * @description Decide the heating demand now (lib/water.js decide) and show it.
   */
  async plan(now = Date.now()) {
    if (this.planning) return;
    this.planning = true;
    try {
      const settings = this.getSettings();
      const mode = this.mode();
      if (mode !== 'auto') {
        // Heat: holds the target temperature, whatever the price. Off: no demand.
        let held = { demand: false, reason: { code: 'mode_off', args: {} } };
        if (mode === 'heat') {
          held = water.holdTarget({ temperature: this.planTemperature(now), ready: this.readyTemperature(), max: settings.max_temperature, heatingNow: this.demanded() });
        }
        const reason = this.reasonText(held.reason);
        await this.showTiming(now, held, this.readyTemperature());
        await this.setValue(STATE, mode === 'off' ? 'off' : water.state(held));
        await this.setValue('text_reason', reason);
        await this.setDemand(held.demand, reason);
        await this.setValue(READY, false);
        await this.checkProblem(now, held);
        return;
      }
      const controller = this.homey.app.findController();
      const ready = this.readyTemperature();
      const temperature = this.decideTemperature(now, ready);
      const reheat = await this.updateReheat(temperature, ready);
      const decided = water.decide({
        now,
        temperature,
        outdoor: this.surroundingsTemperature(),
        model: this.getStoreValue('model'),
        quarters: controller ? controller.priceQuarters(now) : [],
        useList: this.useList(now),
        keep: this.keepTemperature(),
        keepAt: this.isTank() ? this.tankTemperature().keepAt : null,
        reheat,
        // Plan from cleared: a block already planned no longer holds.
        block: isTime(settings.block_from) ? this.getStoreValue('block') || null : null,
        ceiling: controller ? controller.priceCeiling() : null,
        ready,
        max: settings.max_temperature,
        powerW: this.ratedPower(),
        priceLimit: this.readyPriceLimit(controller),
        usePriceSkips: this.usePriceSkips(),
        timeZone: this.homey.clock.getTimezone(),
        heatingNow: this.demanded(),
        holdBefore: settings.hold_before,
        readyAhead: settings.ready_ahead,
        reachedFor: this.getStoreValue('reachedFor'),
        filters: this.filterList(now),
        filterTarget: this.getStoreValue('filterTarget'),
        // A water heater heats to full on its own thermostat: nothing to hold through the use.
        hold: !this.heatsToFull()
      });
      if (decided.reachedFor !== this.getStoreValue('reachedFor')) await this.setStoreValue('reachedFor', decided.reachedFor).catch(this.error);
      // A manual on/off from the button over the decision.
      // A tank that fell below Keep heats to full from the next plan on.
      if (this.heatsToFull() && decided.reason.code === 'below_keep') await this.setStoreValue('reheat', true).catch(this.error);
      const manual = water.applyManual(decided, this.getStoreValue('manual'), {
        temperature,
        ready,
        keep: this.keepTemperature(),
        max: settings.max_temperature
      });
      if (manual.manual !== this.getStoreValue('manual')) await this.setStoreValue('manual', manual.manual).catch(this.error);
      await this.announceSkip(decided);
      const { result } = manual;
      let reason = this.reasonText(result.reason);
      const absence = this.longAbsence();
      if (absence.on && !result.use && !result.demand) reason = this.absenceText(absence.until);
      if (!controller) reason = `${reason}; ${this.homey.__('water.reason.no_controller')}`;
      const keeping = ['keep_heat', 'below_keep'].includes(result.reason.code);
      await this.showTiming(now, result, keeping ? this.keepTemperature() : ready);
      await this.setValue(STATE, water.state(result));
      await this.setValue('text_reason', reason);
      await this.setDemand(result.demand, reason);
      await this.announceHeating(now, result);
      await this.announceHeld(result, controller);
      await this.setValue(READY, READY_CODES.includes(result.reason.code));
      await this.announceReady(result);
      await this.checkProblem(now, result);
      await this.pruneUses(now);
    } catch (error) {
      this.error(`${this.getName()} - plan - ${error}`);
    } finally {
      this.planning = false;
    }
  }

  /**
   * @description The heater switch's state (true/false), null when there is none or it isn't known.
   */
  heaterSwitchOn() {
    const source = this.sourceListeners.switch;
    const reading = source ? this.homey.app.members.read(source.id, source.cap) : null;
    return reading && typeof reading.value === 'boolean' ? reading.value : null;
  }

  /**
   * @description The heater switch changed by something else, e.g. the heater's own fallback schedule for when Homey is
   * down: while this device runs, it is switched back to the heating demand (not in mode Off).
   */
  async onHeaterSwitch() {
    const on = this.heaterSwitchOn();
    if (on === null || this.initializing || this.mode() === 'off' || on === this.demanded()) return;
    this.log(`${this.getName()} - heater switch turned ${on ? 'on' : 'off'} elsewhere: back to the heating demand`);
    await this.writeHeaterSwitch(this.demanded());
  }

  /**
   * @description With a heater switch: the heater stopped because the switch is (or was just switched) off, not by its
   * thermostat. Such a stop teaches nothing about the target temperature.
   */
  stoppedBySwitch(now) {
    if (!this.getStoreValue('heaterSwitch')) return false;
    if (this.heaterSwitchOn() === false) return true;
    return typeof this.switchedOffAt === 'number' && now - this.switchedOffAt < SWITCHED_OFF_MS;
  }

  /**
   * @description The heater's switch chosen at pairing or repair (optional): follows the heating demand, so no flow is
   * needed. Written when the demand changes; a failed write is logged (the problem alarm tells when no power comes).
   */
  async writeHeaterSwitch(on) {
    const target = this.getStoreValue('heaterSwitch');
    if (!target) return;
    if (!on) this.switchedOffAt = Date.now();
    try {
      await this.homey.app.members.write(target.id, target.cap, on);
      this.log(`${this.getName()} - heater switch ${target.name} ${target.cap} ${on ? 'on' : 'off'}`);
    } catch (error) {
      this.error(`${this.getName()} - heater switch ${target.name} ${target.cap} - ${error}`);
    }
  }

  /**
   * @description Show the heating demand on on/off and fire Heating demand started/stopped when it changes. Compared with
   * the demand last announced, not with on/off: Homey has already set on/off when it was turned by hand.
   */
  async setDemand(value, reason) {
    const demand = value === true;
    await this.setValue(DEMAND, demand);
    if (demand === this.demanded()) return;
    await this.setStoreValue('demand', demand).catch(this.error);
    // Mode Off leaves the heater to its own controls.
    if (this.mode() !== 'off') await this.writeHeaterSwitch(demand);
    if (this.initializing) return;
    const tokens = { target_temperature: Number(this.readyTemperature()) || 0, reason };
    await this.triggerFlow(demand ? 'heating_demand_started' : 'heating_demand_stopped', tokens);
  }

  /**
   * @description Expected start (Now while heating), Expected ready and, while heating, the time remaining, by the
   * learned curve to the temperature it heats to.
   */
  async showTiming(now, result, target) {
    const none = this.homey.__('water.start.none');
    const nowText = this.homey.__('water.start.now');
    let start = none;
    if (result.demand) start = nowText;
    else if (typeof result.nextStart === 'number' && result.nextStart > now) start = this.formatTime(result.nextStart);
    await this.setValue('text_expected_start', start);
    const estimate = water.readyEstimate({
      now,
      temperature: this.planTemperature(now),
      target,
      outdoor: this.surroundingsTemperature(),
      model: this.getStoreValue('model'),
      demand: result.demand,
      nextStart: result.nextStart,
      filters: this.filterList(now),
      filterTarget: this.getStoreValue('filterTarget')
    });
    let ready = none;
    if (estimate.readyAt !== null) ready = estimate.readyAt <= now ? nowText : this.formatTime(estimate.readyAt);
    await this.setValue('text_expected_ready', ready);
    await this.setValue('text_time_remaining', estimate.minutes === null ? none : this.duration(estimate.minutes));
  }

  /**
   * @description E.g. "45 min" or "1 h 5 min".
   */
  duration(minutes) {
    if (minutes < 60) return this.homey.__('water.duration.minutes', { m: minutes });
    return this.homey.__('water.duration.hours', { h: Math.floor(minutes / 60), m: minutes % 60 });
  }

  /**
   * @description Ready time skipped: once per ready time that the price limit skips.
   */
  async announceSkip(decided) {
    if (!decided.skip || !decided.use || this.getStoreValue('skipAnnounced') === decided.use.start) return;
    await this.setStoreValue('skipAnnounced', decided.use.start).catch(this.error);
    const round = (value) => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 10000) / 10000 : 0);
    this.log(`${this.getName()} - ready time ${this.formatTime(decided.use.start)} skipped at ${round(decided.skipPrice)}/kWh`);
    await this.triggerFlow('water_ready_skipped', {
      ready_time: localTime(this, new Date(decided.use.start)).time,
      price: round(decided.skipPrice),
      price_limit: round(decided.reason && decided.reason.args ? decided.reason.args.limit : null)
    });
  }

  /**
   * @description Heating planned and Heating started: once each per ready time (lib/water.js heatingNews), with the
   * times as shown on the device.
   */
  async announceHeating(now, result) {
    const told = { planned: this.getStoreValue('plannedTold'), started: this.getStoreValue('startedTold'), ready: this.getStoreValue('readyTold') };
    const news = water.heatingNews(now, result, told);
    if (!news) return;
    // A Water Heater with a night block tells its plan when the block is planned (planBlock), not from the price plan.
    if (news === 'planned' && this.plansBlock()) return;
    await this.setStoreValue(news === 'started' ? 'startedTold' : 'plannedTold', result.use.start).catch(this.error);
    const tokens = {
      ready_time: this.formatTime(result.use.start),
      expected_start: this.getCapabilityValue('text_expected_start') || '',
      expected_ready: this.getCapabilityValue('text_expected_ready') || '',
      target_temperature: Number(this.readyTemperature()) || 0,
      reason: this.getCapabilityValue('text_reason') || ''
    };
    if (news === 'planned') {
      // The planned heating from its start: until it stops, and its mean price.
      const controller = this.homey.app.findController();
      const start = result.nextStart;
      const end = typeof result.until === 'number' ? result.until : null;
      const price = end && controller ? water.meanPrice(controller.priceQuarters(now), start, end) : null;
      Object.assign(tokens, {
        end: end ? localTime(this, new Date(end)).time : '',
        minutes: end ? Math.round((end - start) / 60000) : 0,
        price: typeof price === 'number' ? Math.round(price * 10000) / 10000 : 0
      });
    }
    this.log(`${this.getName()} - heating ${news} for ${tokens.ready_time}: start ${tokens.expected_start}, ready ${tokens.expected_ready}`);
    await this.triggerFlow(news === 'started' ? 'water_heating_started' : 'water_heating_planned', tokens);
  }

  /**
   * @description Heating held by the price ceiling while the hot water runs out (below Keep): told once when it starts.
   */
  async announceHeld(result, controller) {
    const held = result.held === true;
    if (held === (this.getStoreValue('heldTold') === true)) return;
    await this.setStoreValue('heldTold', held).catch(this.error);
    if (!held || this.initializing) return;
    this.log(`${this.getName()} - heating held by the price ceiling, water ${this.waterTemperature()} °C`);
    await this.triggerFlow('water_heating_held', {
      ceiling: (controller && controller.priceCeiling()) || 0,
      water_temperature: Number(this.isTank() ? this.tankTemperature().keepAt : this.waterTemperature()) || 0,
      keep: Number(this.keepTemperature()) || 0
    });
  }

  /**
   * @description Ready reached: once per ready time, when the water first reaches the target for it.
   */
  async announceReady(result) {
    if (!water.readyNews(result, this.getStoreValue('readyTold'))) return;
    await this.setStoreValue('readyTold', result.use.start).catch(this.error);
    await this.triggerFlow('water_ready_reached', {
      ready_time: this.formatTime(result.use.start),
      until: this.formatTime(result.use.end),
      water_temperature: Number(this.waterTemperature()) || 0,
      target_temperature: Math.round((Number(this.readyTemperature()) || 0) * 10) / 10
    });
  }

  /**
   * @description Problem: no water temperature, demanded for a while without the water warming, or (with a power
   * meter) demanded for minutes without heating power.
   */
  async checkProblem(now, result) {
    const inUse = this.inUseNow(now);
    const { since, problem } = water.problemCheck(this.demandSince, now, this.waterTemperature(), result.demand, { flow: this.flowState(), inUse });
    this.demandSince = since;
    await this.setValue('alarm_problem', problem);
  }

  /**
   * @description Drop one-offs and skips of uses that are over. One-offs stay for AFTER_USE_MS, so learning still skips
   * the stirred water after them.
   */
  async pruneUses(now) {
    const oneOffs = (this.getStoreValue('oneOffs') || []).filter((use) => use.start + (use.minutes || 60) * 60000 + water.AFTER_USE_MS > now);
    const skipped = (this.getStoreValue('skipped') || []).filter((start) => start > now - 24 * 3600000);
    if (oneOffs.length !== (this.getStoreValue('oneOffs') || []).length) await this.setStoreValue('oneOffs', oneOffs).catch(this.error);
    if (skipped.length !== (this.getStoreValue('skipped') || []).length) await this.setStoreValue('skipped', skipped).catch(this.error);
    const ended = (this.getStoreValue('ended') || []).filter((use) => use.end + water.AFTER_USE_MS > now);
    if (ended.length !== (this.getStoreValue('ended') || []).length) await this.setStoreValue('ended', ended).catch(this.error);
  }

  formatTime(ms) {
    if (typeof ms !== 'number') return '';
    const local = localTime(this, new Date(ms));
    const today = localTime(this, new Date()).date;
    return local.date === today ? local.time : `${this.homey.__(`water.weekday.${local.weekday}`)} ${local.time}`;
  }

  reasonText({ code: planned, args }) {
    // Waiting with no start planned: the water is warm enough for the use already.
    const code = planned === 'waiting' && typeof args.start !== 'number' ? 'waiting_warm' : planned;
    const formatted = { ...args };
    for (const key of ['ready', 'start', 'until']) if (key in formatted) formatted[key] = this.formatTime(formatted[key]);
    for (const key of ['keep', 'max']) if (typeof formatted[key] === 'number') formatted[key] = `${formatted[key]} °C`;
    return this.homey.__(`water.reason.${code}`, formatted);
  }

  /**
   * @description Flow: be ready at a time (the next one coming), for minutes.
   */
  async onAction_WATER_READY_AT(time, minutes) {
    this.log(`${this.getName()} - onAction_WATER_READY_AT - ${time} ${minutes}`);
    if (!isTime(time)) throw new Error(this.homey.__('water.error.time'));
    const now = Date.now();
    const timeZone = this.homey.clock.getTimezone();
    const today = localTime(this, new Date(now)).date;
    const [hours, mins] = time.split(':').map(Number);
    let start = water.localMs(timeZone, today, hours * 60 + mins);
    if (start <= now) start = water.localMs(timeZone, addDays(today, 1), hours * 60 + mins);
    const oneOffs = [...(this.getStoreValue('oneOffs') || []), { start, minutes: minutes > 0 ? minutes : this.getSetting('use_minutes') }];
    await this.setStoreValue('oneOffs', oneOffs);
    await this.plan(now);
    return true;
  }

  /**
   * @description Flow: the ready time (empty for none), how long before it to be ready, and the days of the week.
   */
  async onAction_WATER_SET_READY_TIME(args) {
    const { time, ahead } = args;
    const days = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((day) => [`use_${day}`, args[day] === true]));
    this.log(`${this.getName()} - onAction_WATER_SET_READY_TIME - ${time} ${ahead} ${JSON.stringify(days)}`);
    const useTime = typeof time === 'string' ? time.trim() : '';
    if (useTime && !isTime(useTime)) throw new Error(this.homey.__('water.error.time'));
    if (typeof ahead !== 'number' || !Number.isFinite(ahead) || ahead < 0 || ahead > 30) throw new Error(this.homey.__('error.invalid_value', { value: ahead }));
    await this.setSettings({ use_time: useTime, ready_ahead: ahead, ...days });
    await this.plan();
    return true;
  }

  isFlowWater(key = 'water') {
    const source = this.waterSources()[key];
    return !!(source && source.flow);
  }

  /**
   * @description A temperature last set by a flow card (Set water temperature, or Set tank temperature per position),
   * while not older than the sources' max age.
   */
  flowWater(key = 'water') {
    const fed = key === 'water' ? this.getStoreValue('flowWater') : (this.getStoreValue('flowTank') || {})[key];
    if (!fed || typeof fed.value !== 'number' || Date.now() - fed.at > WATER_MAX_AGE_MS) return null;
    return fed.value;
  }

  /**
   * @description Flow: the water temperature, when it comes from a flow (e.g. MQTT) instead of a device.
   */
  async onAction_SET_WATER_TEMPERATURE(value) {
    this.log(`${this.getName()} - onAction_SET_WATER_TEMPERATURE - ${value}`);
    if (this.isTank()) throw new Error(this.homey.__('water.error.tank_card'));
    if (!this.isFlowWater()) throw new Error(this.homey.__('water.error.not_flow'));
    if (typeof value !== 'number' || !Number.isFinite(value) || value < -5 || value > 100) throw new Error(this.homey.__('error.invalid_value', { value }));
    await this.setStoreValue('flowWater', { value, at: Date.now() });
    await this.onSource('water');
    return true;
  }

  /**
   * @description Flow: a tank temperature at one height (top, middle or bottom), when it comes from a flow (e.g. MQTT).
   */
  async onAction_SET_TANK_TEMPERATURE(position, value) {
    this.log(`${this.getName()} - onAction_SET_TANK_TEMPERATURE - ${position} ${value}`);
    if (!water.TANK_POSITIONS.includes(position)) throw new Error(this.homey.__('error.invalid_value', { value: position }));
    if (!this.isFlowWater(position)) throw new Error(this.homey.__('water.error.not_flow_tank', { position: this.homey.__(`water.tank.${position}`) }));
    if (typeof value !== 'number' || !Number.isFinite(value) || value < -5 || value > 100) throw new Error(this.homey.__('error.invalid_value', { value }));
    await this.setStoreValue('flowTank', { ...(this.getStoreValue('flowTank') || {}), [position]: { value, at: Date.now() } });
    await this.onSource(position);
    return true;
  }

  /**
   * @description Flow: skip the next use (keep, if any, still holds).
   */
  async onAction_WATER_SKIP_NEXT() {
    const now = Date.now();
    const [next] = this.useList(now).filter((use) => use.start > now);
    this.log(`${this.getName()} - onAction_WATER_SKIP_NEXT - ${next ? new Date(next.start).toISOString() : 'none'}`);
    if (!next) return false;
    await this.setStoreValue('skipped', [...(this.getStoreValue('skipped') || []), next.start]);
    await this.plan(now);
    return true;
  }

  /**
   * @description Repair: new sources; listeners and capabilities follow. Options from the page (the Hot Tub's filter
   * cycles) are handled by the driver's device class.
   */
  // eslint-disable-next-line no-unused-vars
  async onRepairSources({ water: waterSource, tank = null, surroundings, power, heaterSwitch = null }, options = {}) {
    const name = (source) => {
      if (!source) return 'none';
      return source.flow ? 'flow' : source.name;
    };
    const tankText = tank ? water.TANK_POSITIONS.map((position) => `${position} ${name(tank[position])}`).join(', ') : null;
    this.log(`${this.getName()} - onRepairSources - water ${tankText || name(waterSource)}, surroundings ${name(surroundings)}, power ${name(power)}, switch ${name(heaterSwitch)}`);
    this.unsubscribeSources();
    await this.setStoreValue('water', waterSource || null);
    await this.setStoreValue('tank', tank);
    await this.setStoreValue('surroundings', surroundings);
    await this.setStoreValue('power', power);
    const switchBefore = this.getStoreValue('heaterSwitch');
    await this.setStoreValue('heaterSwitch', heaterSwitch);
    await this.saveSegment(null);
    await this.saveStill(null, Date.now());
    await this.checkCapabilities();
    await this.subscribeSources();
    await this.setCapabilityValues();
    await this.plan();
    // A newly chosen switch starts from the current demand.
    const changed = JSON.stringify(switchBefore || null) !== JSON.stringify(heaterSwitch);
    if (changed && heaterSwitch && this.mode() !== 'off') await this.writeHeaterSwitch(this.demanded());
    return true;
  }
};

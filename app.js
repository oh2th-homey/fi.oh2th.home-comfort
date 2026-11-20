'use strict';

const Homey = require('homey');
const { startMinuteInterval, stopMinuteInterval, dispatchInterval, forEachDevice, isImperial, localDate, localTime } = require('oh2th-homey-helpers');
const flowActions = require('./lib/flows/actions');
const flowConditions = require('./lib/flows/conditions');
const Members = require('./lib/members');
const { History, QUARTER_MS, CONTROLLER_SLOT, decodeDay } = require('./lib/history');
const daily = require('./lib/daily');
const views = require('./lib/views');

// The history slot of the Home Controller's other heating meters (issue #40); zones use their data id.
const OTHER_METERS_SLOT_ID = 'other-meters';

module.exports = class HomeComfortApp extends Homey.App {
  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log(`${this.homey.manifest.id}/${this.homey.manifest.version} - onInit - units ${this.homey.i18n.getUnits()}, language ${this.homey.i18n.getLanguage()}`);

    // Other apps' devices (zone members), through the Homey Web API.
    this.members = new Members(this);
    // Quarter-hour history on disk for learning and analysis.
    this.history = new History(this);

    await flowActions.init(this);
    await flowConditions.init(this);

    this.appInterval = startMinuteInterval(this, async (now) => this.onInterval(now));
  }

  async onUninit() {
    stopMinuteInterval(this, this.appInterval);
  }

  /**
   * @description The one app interval: app-level work, then onInterval(now) on every device.
   */
  async onInterval(now) {
    await this.members.refresh().catch((error) => this.error(`onInterval - members refresh - ${error}`));
    // Before the devices evaluate the new quarter, so the row has the state of the quarter that ended.
    if (localTime(this, now).minutes % 15 === 0) await this.recordHistory(now).catch((error) => this.error(`onInterval - history - ${error}`));
    await dispatchInterval(this, now);
    // Graphs (issue #12): each quarter after the devices have decided, and once soon after the start.
    if (localTime(this, now).minutes % 15 === 0 || !this.graphsDrawn) await this.updateGraphs(now).catch((error) => this.error(`onInterval - graphs - ${error}`));
  }

  /**
   * @description Draw the devices' camera images whose content changed (lib/views.js, lib/images.js). One image at a
   * time, giving the event loop a turn between them: each one takes a fraction of a second.
   */
  async updateGraphs(now) {
    if (this.drawingGraphs) return;
    this.drawingGraphs = true;
    try {
      const devices = [];
      await forEachDevice(this, async (device) => {
        if (typeof device.hasGraphs === 'function' && device.hasGraphs() && device.graphSpecs) devices.push(device);
      });
      if (!devices.length) return;
      const common = await this.graphCommon(now.getTime());
      const started = Date.now();
      let drawn = 0;
      for (const device of devices) {
        try {
          for (const { id, spec } of await device.graphViews(common)) {
            await new Promise((resolve) => setImmediate(resolve));
            if (await device.drawGraph(id, spec)) drawn++;
          }
        } catch (error) {
          this.error(`updateGraphs - ${device.getName()} - ${error}`);
        }
      }
      this.graphsDrawn = true;
      if (drawn) this.log(`updateGraphs - ${drawn} images in ${Date.now() - started} ms`);
    } finally {
      this.drawingGraphs = false;
    }
  }

  /**
   * @description What all graphs share: the local days, the price slots with the price model's decisions, today's
   * history rows and the texts.
   */
  async graphCommon(now) {
    const timeZone = this.homey.clock.getTimezone();
    const days = views.days(timeZone, now);
    const controller = this.findController();
    const { data, zones } = await this.history.read(days.today.date);
    return {
      timeZone,
      now,
      imperial: this.isImperial(),
      labels: views.labels((key) => this.homey.__(key)),
      currency: controller ? controller.currency() : '€',
      days,
      slots: controller ? controller.graphPriceSlots(now) : [],
      rows: decodeDay(data),
      historySlots: zones
    };
  }

  /**
   * @description Append the quarter that just ended to the history: controller state and every zone's sample.
   */
  async recordHistory(now) {
    const quarter = (Math.round(now.getTime() / QUARTER_MS) - 1) * QUARTER_MS;
    const timeZone = this.homey.clock.getTimezone();
    const date = localDate(timeZone, quarter);
    const controller = this.findController();
    const shared = controller ? controller.getSharedState() : {};
    const zones = [];
    // Daily summary rows of the day that ended (at the first quarter of a new day).
    const days = [];
    for (const zone of this.homey.drivers.getDriver('zone').getDevices()) {
      if (typeof zone.historySample !== 'function') continue;
      const slot = await this.history.slot(zone.getData().id, zone.getName());
      const sample = zone.historySample(now.getTime());
      zones.push({ slot, ...sample });
      const finished = await zone.addToDay(date, sample, shared.price);
      if (finished) days.push(daily.row(finished, slot));
    }
    if (controller) {
      const metered = zones.filter((zone) => typeof zone.energy === 'number');
      let energy = metered.length ? metered.reduce((sum, zone) => sum + zone.energy, 0) : null;
      // Other heating meters (issue #40): their own slot, like a zone with only energy, and in the controller's total.
      const other = typeof controller.otherSample === 'function' ? controller.otherSample(now.getTime()) : null;
      if (other !== null) {
        const slot = await this.history.slot(OTHER_METERS_SLOT_ID, 'Other heating meters');
        zones.push({ slot, energy: other });
        const otherDay = await controller.addOtherToDay(date, other, shared.price);
        if (otherDay) days.push(daily.row(otherDay, slot));
        energy = (energy || 0) + other;
      }
      const finished = await controller.addToDay(date, { energy, price: shared.price, outdoor: shared.outdoor, expensive: shared.expensive });
      if (finished) days.push(daily.row(finished, CONTROLLER_SLOT));
    }
    await this.history.appendDays(days);
    await this.history.append(date, {
      quarter,
      outdoor: shared.outdoor,
      price: shared.price,
      occupancy: shared.occupancy,
      season: shared.season,
      longAbsence: shared.longAbsence,
      expensive: shared.expensive,
      zones
    });
    // The first quarter of a day: drop the files older than KEEP_DAYS.
    if (localDate(timeZone, now.getTime()) !== date) await this.history.prune(localDate(timeZone, now.getTime()));
  }

  /**
   * @description The Home Controller device (single instance).
   * @returns {Object} Device
   * @throws when it has not been added
   */
  getController() {
    const [controller] = this.homey.drivers.getDriver('controller').getDevices();
    if (!controller) throw new Error(this.homey.__('error.no_controller'));
    return controller;
  }

  /**
   * @description The Home Controller, or null when it has not been added.
   */
  findController() {
    try {
      return this.getController();
    } catch (error) {
      return null;
    }
  }

  /**
   * @description Show temperatures in °F (reason texts). Homey's getUnits() can stay metric while Homey shows °F, but
   * the Web API labels member temperatures °F then: either one means °F.
   */
  isImperial() {
    let system;
    try {
      system = this.homey.i18n.getUnits();
    } catch (error) {
      system = 'metric';
    }
    return isImperial(system, this.members.fahrenheit());
  }

  /**
   * @description Shared state on the controller changed: let devices re-evaluate now instead of on the next slot.
   */
  async onSharedStateChanged() {
    await forEachDevice(this, async (device) => {
      if (typeof device.onSharedStateChanged === 'function') await device.onSharedStateChanged();
    });
  }
};

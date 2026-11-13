'use strict';

const fs = require('fs');
const path = require('path');
const { Device } = require('homey');
const { checkCapabilities, setValue } = require('oh2th-homey-helpers');

const IMAGE_DIR = '/userdata/images';

module.exports = class mainDevice extends Device {
  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.log(`${this.getName()} - onInit`);
    this.timeouts = {};
    this.initializing = true;
    await this.setUnavailable(this.homey.__('device.initializing')).catch(this.error);

    await this.onInitDevice();
    await this.checkCapabilities();
    await this.setCapabilityListeners();
    await this.setCapabilityValues(true);
    await this.setAvailable().catch(this.error);
    this.initializing = false;
    await this.onReady();
  }

  /**
   * onReady is called once init is done and the device is available; override when needed.
   */
  async onReady() {}

  /**
   * @description Match the device's capabilities to the driver manifest; override for optional capabilities.
   */
  async checkCapabilities() {
    return checkCapabilities(this);
  }

  /**
   * onInitDevice reads settings and creates lib clients; override when needed.
   */
  async onInitDevice() {}

  /**
   * onAdded is called when the user adds the device, called just after pairing.
   */
  async onAdded() {
    this.log(`${this.getName()} - onAdded`);
  }

  /**
   * onSettings is called when the user updates the device's settings.
   * @param {object} event the onSettings event data
   * @param {object} event.oldSettings The old settings object
   * @param {object} event.newSettings The new settings object
   * @param {string[]} event.changedKeys An array of keys changed since the previous version
   * @returns {Promise<string|void>} return a custom message that will be displayed
   */
  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log(`${this.getName()} - onSettings - changed: ${changedKeys}`);
  }

  /**
   * onRenamed is called when the user updates the device's name.
   * @param {string} name The new name
   */
  async onRenamed(name) {
    this.log(`${this.getName()} - onRenamed - ${name}`);
  }

  /**
   * onDeleted is called when the user deleted the device.
   */
  async onDeleted() {
    this.log(`${this.getName()} - onDeleted`);
    this.clearTimers();
    await this.removeCameraImages();
  }

  /**
   * @description Camera image file of this device (in /userdata, kept over restarts).
   */
  cameraFile(id) {
    return path.join(IMAGE_DIR, `${this.getData().id}-${id}.png`);
  }

  /**
   * @description Show a new image as camera image id; the image is registered on its first update.
   * @param {string} id - e.g. 'today'
   * @param {string} title - Shown in the app
   * @param {Buffer} data - PNG file contents
   */
  async updateCameraImage(id, title, data) {
    if (!this.cameraImages) this.cameraImages = {};
    await fs.promises.mkdir(IMAGE_DIR, { recursive: true });
    await fs.promises.writeFile(this.cameraFile(id), data);
    if (this.cameraImages[id]) {
      await this.cameraImages[id].update();
      return;
    }
    const image = await this.homey.images.createImage();
    image.setPath(this.cameraFile(id));
    await this.setCameraImage(id, title, image);
    this.cameraImages[id] = image;
  }

  /**
   * @description Unregister the camera images and delete their files, also ones written before an app restart.
   */
  async removeCameraImages() {
    for (const image of Object.values(this.cameraImages || {})) await image.unregister().catch(this.error);
    this.cameraImages = {};
    const prefix = `${this.getData().id}-`;
    const names = await fs.promises.readdir(IMAGE_DIR).catch(() => []);
    for (const name of names.filter((n) => n.startsWith(prefix))) await fs.promises.unlink(path.join(IMAGE_DIR, name)).catch(() => {});
  }

  /**
   * onUninit is called when the app is stopped or the device is reinitialized.
   */
  async onUninit() {
    this.log(`${this.getName()} - onUninit`);
    this.clearTimers();
  }

  async setCapabilityListeners() {}

  async setCapabilityValues(check = false) {}

  /**
   * @description Called by the app every minute with the same now for all devices. Keep it quick.
   * @param {Date} now
   */
  async onInterval(now) {}

  async setValue(key, value, firstRun = false, delay = 10) {
    return setValue(this, key, value, firstRun, delay);
  }

  /**
   * @description Fire a device trigger card of this app.
   */
  async triggerFlow(id, tokens = {}, state = {}) {
    await this.homey.flow
      .getDeviceTriggerCard(id)
      .trigger(this, tokens, state)
      .then(() => this.log(`${this.getName()} - triggerFlow - ${id}: ${JSON.stringify(tokens)}`))
      .catch(this.error);
  }

  /**
   * @description One-shot Homey timer by name; a new one with the same name replaces the old.
   */
  setTimer(name, fn, ms) {
    this.clearTimer(name);
    this.timeouts[name] = this.homey.setTimeout(() => {
      delete this.timeouts[name];
      Promise.resolve(fn()).catch(this.error);
    }, ms);
  }

  clearTimer(name) {
    if (this.timeouts && this.timeouts[name]) {
      this.homey.clearTimeout(this.timeouts[name]);
      delete this.timeouts[name];
    }
  }

  clearTimers() {
    for (const name of Object.keys(this.timeouts || {})) this.clearTimer(name);
  }
};

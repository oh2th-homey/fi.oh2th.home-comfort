'use strict';

/**
 * Chart specs (lib/charts.js) to PNG files with pureimage, a canvas 2D implementation in plain JavaScript (issue #12).
 * pureimage and the font are loaded on the first render only, so nothing is added to the app's memory before that.
 * The bitmap's own RGBA buffer goes straight to pngjs: pureimage's own PNG stream copies every pixel one at a time.
 */

const fs = require('fs');
const path = require('path');
const charts = require('./charts');

const FONT_FILE = path.join(__dirname, '..', 'assets', 'fonts', 'Inter-Regular.ttf');
const DIR = '/userdata/graphs';

let PImage = null;
let PNG = null;

function load() {
  if (PImage) return;
  // Loaded on the first render only (memory).
  // eslint-disable-next-line global-require
  PImage = require('pureimage');
  // eslint-disable-next-line global-require
  ({ PNG } = require('pngjs'));
  PImage.registerFont(FONT_FILE, charts.FONT).loadSync();
}

/**
 * @description A chart spec as a PNG buffer (charts.WIDTH × charts.HEIGHT).
 */
function render(spec) {
  load();
  const image = PImage.make(charts.WIDTH, charts.HEIGHT);
  charts.draw(image.getContext('2d'), spec);
  const data = Buffer.from(image.data.buffer, image.data.byteOffset, image.data.length);
  return PNG.sync.write({ width: image.width, height: image.height, data }, { deflateLevel: 6 });
}

/**
 * @description The file of a device's image.
 * @param {string} key - Device id and image id, e.g. '<id>-today'
 */
function file(key, dir = DIR) {
  return path.join(dir, `${key.replace(/[^\w.-]/g, '_')}.png`);
}

/**
 * @description Render a spec to its file.
 * @returns {Promise<string>} the file
 */
async function write(key, spec, dir = DIR) {
  const png = render(spec);
  await fs.promises.mkdir(dir, { recursive: true });
  const target = file(key, dir);
  await fs.promises.writeFile(target, png);
  return target;
}

function exists(key, dir = DIR) {
  return fs.existsSync(file(key, dir));
}

async function remove(key, dir = DIR) {
  await fs.promises.unlink(file(key, dir)).catch(() => {});
}

module.exports = { DIR, render, file, write, exists, remove };

'use strict';

/**
 * Preview of the camera image charts (issue #12) with made-up data: writes zone, controller and water PNGs to a folder.
 *   node tools/graphs.js <folder>
 */

const fs = require('fs');
const path = require('path');
const { localDate, addDays } = require('oh2th-homey-helpers');
const views = require('../lib/views');
const images = require('../lib/images');

const out = process.argv[2] || '.';
const timeZone = 'Europe/Helsinki';
const now = Date.now();
const today = localDate(timeZone, now);
const Q = 15 * 60 * 1000;
const en = require('../locales/en.json');

const t = (key) => key.split('.').reduce((node, part) => node && node[part], en) || key;
const labels = views.labels(t);
const days = views.days(timeZone, now);

// Prices for yesterday to tomorrow: a morning and an evening peak, some noise.
const priceDays = {};
for (const [i, date] of [addDays(today, -1), today, addDays(today, 1)].entries()) {
  priceDays[date] = {
    resolution: 15,
    values: Array.from({ length: 96 }, (_, q) => {
      const h = q / 4;
      return Math.round((0.05 + 0.06 * Math.exp(-((h - 8) ** 2) / 3) + 0.09 * Math.exp(-((h - 18.5) ** 2) / 2) + 0.012 * Math.sin(q * 1.7 + i)) * 10000) / 10000;
    })
  };
}
const slots = views.priceSlots({ days: priceDays, timeZone, resolution: 15, model: 'rate_is_highest', pct: 30, minDelta: 0.01 }, now);
const common = { timeZone, now, imperial: false, labels, currency: '€', days, slots };

const zoneInput = {
  shared: { occupancy: 'present', season: 'heating', longAbsence: false, expensive: false, outdoor: -4 },
  source: 'live',
  zone: { mode: 'auto', heat: 21.5, eco: 19.5, occupancyRule: 'follows', pricePeak: 'eco', boostDelta: 1 },
  temperature: 21.2
};
const rows = [];
let temp = 20.8;
for (let q = days.today.start; q + Q <= now; q += Q) {
  const slot = slots.find((s) => s.time <= q && q < s.end);
  const target = slot && slot.expensive ? 19.5 : 21.5;
  temp += (target - temp) * 0.12 + 0.05 * Math.sin(q / 3e6);
  rows.push({ time: q, temperature: Math.round(temp * 10) / 10, target, low: 19.5, high: 21.5, outdoor: -6 + 3 * Math.sin((q - days.today.start) / 1.4e7) });
}
const zone = views.zoneViews(common, { rows, temperature: temp, target: 21.5, input: zoneInput });

const forecast = [];
for (let ms = Math.floor(now / 3.6e6) * 3.6e6; ms < days.tomorrow.end + 3.6e6; ms += 3.6e6) forecast.push([ms, -5 + 4 * Math.sin((ms - days.today.start) / 1.4e7)]);
const controller = views.controllerViews(common, { rows, outdoor: rows.length ? rows[rows.length - 1].outdoor : null, forecast });

const log = [];
let water = 36;
for (let q = days.today.start; q + Q <= now; q += Q) {
  const heating = (q - days.today.start) / 3.6e6 > 3 && (q - days.today.start) / 3.6e6 < 5;
  water += heating ? 0.6 : -0.08;
  log.push({ time: q, temperature: water, heating });
}
const plan = [];
let planned = water;
for (let q = Math.floor(now / Q) * Q; q < days.tomorrow.end; q += Q) {
  const slot = slots.find((s) => s.time <= q && q < s.end);
  const heat = !!slot && slot.price < 0.06 && planned < 39;
  planned += heat ? 0.6 : -0.08;
  plan.push({ time: q, heat, temperature: planned });
}
const uses = [
  { start: days.today.start + 20 * 3.6e6, end: days.today.start + 22 * 3.6e6 },
  { start: days.tomorrow.start + 19 * 3.6e6, end: days.tomorrow.start + 21 * 3.6e6 }
];
const spa = views.waterViews(common, { log, temperature: water, heatingNow: false, plan, block: null, uses, ready: 38 });

(async () => {
  fs.mkdirSync(out, { recursive: true });
  for (const [name, list] of Object.entries({ zone, controller, spa })) {
    for (const { id, spec } of list) {
      const started = Date.now();
      const png = images.render(spec);
      const file = path.join(out, `${name}-${id}.png`);
      fs.writeFileSync(file, png);
      console.log(`${file}: ${png.length} bytes, ${Date.now() - started} ms`);
    }
  }
})();

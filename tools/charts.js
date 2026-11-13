'use strict';

/**
 * Render the camera image views from saved history days (tools/history.js --json output) to PNG files, to look at the
 * charts on a computer: zone-<day> and controller-<day> for yesterday, today and tomorrow. "Now" is the end of the last
 * row, or --now (a time in the given days, e.g. to see a day with tomorrow's prices known). Prices come from the
 * history; the expected target uses the zone's band and the shared state of the last row before now (an approximation:
 * the tool doesn't know the zone settings).
 *
 *   node tools/charts.js <out dir> <day.json> [<day.json> …] [--slot N] [--now YYYY-MM-DDTHH:MM] [--tz Europe/Helsinki]
 */

const fs = require('fs');
const path = require('path');
const views = require('../lib/views');
const { toPng } = require('../lib/images');

const en = require('../locales/en.json').chart;

const QUARTER_MS = 15 * 60 * 1000;

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i < 0 ? fallback : process.argv[i + 1];
}

/**
 * @description Local wall time in a time zone to ms (no DST edge handling needed for a dev tool).
 */
function parseLocal(text, timeZone) {
  const guess = Date.parse(`${text}:00Z`);
  const shown = new Date(new Date(guess).toLocaleString('en-US', { timeZone })).getTime();
  const utc = new Date(new Date(guess).toLocaleString('en-US', { timeZone: 'UTC' })).getTime();
  return guess - (shown - utc);
}

async function main() {
  const [out, ...files] = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !(all[i - 1] || '').startsWith('--'));
  if (!out || !files.length) throw new Error('Usage: node tools/charts.js <out dir> <day.json> … [--slot N] [--now YYYY-MM-DDTHH:MM] [--tz zone]');
  const timeZone = arg('--tz', 'Europe/Helsinki');
  const slot = Number(arg('--slot', 0));
  const all = files.flatMap((file) => JSON.parse(fs.readFileSync(file, 'utf8')).rows).sort((a, b) => a.quarter - b.quarter);
  const now = arg('--now', null) ? parseLocal(arg('--now'), timeZone) : all[all.length - 1].quarter + QUARTER_MS;
  const rows = all.filter((row) => row.quarter + QUARTER_MS <= now);
  if (!rows.length) throw new Error('No rows before --now.');
  const labels = views.labels((key) => en[key.replace('chart.', '')]);

  const slots = views.priceSlots({ days: views.daysFromHistory(all, timeZone), timeZone, now, resolution: 15, model: 'rate_is_highest', minDelta: 0.01 });
  const last = rows[rows.length - 1];
  const z = last.zones.find((s) => s.slot === slot) || {};
  const input = {
    shared: { occupancy: last.occupancy, season: last.season, longAbsence: last.longAbsence, outdoor: last.outdoor },
    zone: { mode: 'auto', heat: z.high, eco: z.low, occupancyRule: 'follows', pricePeak: 'eco' },
    temperature: z.temperature
  };
  const expected = views.expectedTargets({ input, slots, now });

  const rendered = {};
  for (const which of views.DAYS) {
    rendered[`zone-${which}`] = views.zoneDay(which, { rows, slot, slots, expected, now, timeZone, labels });
    rendered[`controller-${which}`] = views.controllerDay(which, { rows, slots, now, timeZone, labels });
  }
  fs.mkdirSync(out, { recursive: true });
  for (const [name, svg] of Object.entries(rendered)) {
    fs.writeFileSync(path.join(out, `${name}.svg`), svg);
    fs.writeFileSync(path.join(out, `${name}.png`), await toPng(svg));
    console.log(path.join(out, `${name}.png`));
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

'use strict';

/**
 * Camera image views, one per local day (yesterday, today, tomorrow): history rows (lib/history.js decodeDay), stored
 * prices and the zone rules to the SVG charts of lib/charts.js, with the headline texts. Pure; the devices read the
 * files and publish the images. Ahead of now only what is known is shown: imported prices, the expensive slots the price
 * model finds in them, and the target the zone rules give for them with today's occupancy and setpoints.
 */

const { localDate, addDays } = require('oh2th-homey-helpers');
const charts = require('./charts');
const prices = require('./prices');
const zone = require('./zone');

const QUARTER_MS = 15 * 60 * 1000;
const DAYS = ['yesterday', 'today', 'tomorrow'];

/**
 * @description Chart labels and text templates from the locale (chart.*), via a translate function such as homey.__.
 */
function labels(t) {
  const keys = ['temperature', 'target', 'expected', 'band', 'energy', 'price', 'expensive', 'outdoor'];
  const result = Object.fromEntries(keys.map((key) => [key, t(`chart.label_${key}`)]));
  for (const key of ['kwh', 'paid', 'mean', 'average', 'eco_time', 'prices_until', 'outdoor_now', 'outdoor_mean', 'no_data', 'no_prices']) result[key] = t(`chart.${key}`);
  result.noData = result.no_data;
  return result;
}

function fill(template, args) {
  return Object.entries(args).reduce((text, [key, value]) => text.split(`__${key}__`).join(value), template);
}

function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function sum(values) {
  return values.filter(isNumber).reduce((total, value) => total + value, 0);
}

function mean(values) {
  const known = values.filter(isNumber);
  return known.length ? sum(known) / known.length : null;
}

function clock(timeZone, ms) {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
}

function duration(ms) {
  const minutes = Math.round(ms / 60000);
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
}

function money(value, currency) {
  return `${value.toFixed(3)} ${currency}/kWh`;
}

function kWhText(wh, l) {
  const kWh = wh / 1000;
  return fill(l.kwh, { kwh: kWh.toFixed(kWh < 10 ? 2 : 1) });
}

/**
 * @description A local day around now: 'yesterday', 'today' or 'tomorrow' (DST safe).
 * @returns {Object} { date, start, end }
 */
function dayOf(timeZone, now, which) {
  const date = addDays(localDate(timeZone, now), DAYS.indexOf(which) - 1);
  const { start, end } = prices.dayInfo(timeZone, date, 60);
  return { date, start, end };
}

function zoneOf(row, slot) {
  return row.zones.find((z) => z.slot === slot) || {};
}

function inDay(list, d) {
  return list.filter((item) => item.time >= d.start && item.time < d.end);
}

/**
 * @description The stored price days as slots, yesterday to tomorrow, each with the price model's expensive flag.
 * @param {Object} opts - { days (store format), timeZone, now, resolution, model, pct, minDelta }
 * @returns {Array} [{ time, end, price, expensive }], price null when unknown
 */
function priceSlots({ days, timeZone, now, resolution = 15, model = 'rate_is_highest', pct, minDelta }) {
  const t = prices.timeline(days, timeZone, now, resolution);
  const slotMs = resolution * 60000;
  // The timeline starts with yesterday: its slots come before today's start.
  const yesterdaySlots = t.index - Math.floor((now - t.today.start) / slotMs);
  const first = t.today.start - yesterdaySlots * slotMs;
  return t.prices.map((price, i) => {
    const time = first + i * slotMs;
    const expensive = typeof price === 'number' && model !== 'off' && prices.evaluate({ days, timeZone, now: time, resolution, model, pct, minDelta }).expensive;
    return { time, end: time + slotMs, price, expensive };
  });
}

/**
 * @description The zone's expected target from now to the last known price: zone.decide() for each price slot with the
 * slot's expensive flag and everything else as now (occupancy, season, setpoints, temperature).
 * @param {Object} opts - { input: the zone.decide() arguments now ({ shared, source, zone, temperature }), slots, now }
 * @returns {Array} [{ time, end, target, low, high, eco }]
 */
function expectedTargets({ input, slots, now }) {
  const ahead = slots.filter((slot) => slot.end > now && typeof slot.price === 'number');
  return ahead.map((slot) => {
    const time = Math.max(slot.time, now);
    const decision = zone.decide({ ...input, shared: { ...input.shared, expensive: slot.expensive }, now: time });
    return { time, end: slot.end, target: decision.target, low: decision.band.low, high: decision.band.high, eco: decision.eco };
  });
}

/**
 * @description A zone's day: temperature, target and band, heating power on the right axis, expensive slots below.
 * Yesterday and today from the history (today's target goes on dashed from now); tomorrow only the expected target.
 * @param {string} which - 'yesterday' | 'today' | 'tomorrow'
 * @param {Object} opts - { rows, slot, slots (priceSlots), expected (expectedTargets), now, timeZone, imperial, currency, labels }
 */
function zoneDay(which, { rows, slot, slots = [], expected = [], now, timeZone, imperial = false, currency = '€', labels: l }) {
  const d = dayOf(timeZone, now, which);
  const quarters = rows.map((row) => ({ time: row.quarter, end: row.quarter + QUARTER_MS, price: row.price, ...zoneOf(row, slot) }));
  const past = which === 'tomorrow' ? [] : inDay(quarters, d);
  const ahead = which === 'yesterday' ? [] : inDay(expected, d);
  const daySlots = inDay(slots, d).filter((s) => typeof s.price === 'number');

  let headline;
  const sub = [];
  const wh = sum(past.map((point) => point.energy));
  const priced = past.filter((point) => isNumber(point.energy) && isNumber(point.price) && point.energy > 0);
  const paid = priced.length ? sum(priced.map((point) => point.energy * point.price)) / sum(priced.map((point) => point.energy)) : null;
  if (which === 'tomorrow') {
    const targets = ahead.map((point) => point.target).filter(isNumber);
    const low = Math.min(...targets);
    const high = Math.max(...targets);
    headline = '–';
    if (targets.length) headline = low === high ? charts.formatDegrees(high, imperial) : `${charts.formatDegrees(low, imperial)} – ${charts.formatDegrees(high, imperial)}`;
    const eco = sum(ahead.filter((point) => point.eco).map((point) => point.end - point.time));
    if (eco > 0) sub.push(fill(l.eco_time, { time: duration(eco) }));
    const until = daySlots.length ? daySlots[daySlots.length - 1].end : null;
    if (until && until < d.end) sub.push(fill(l.prices_until, { time: clock(timeZone, until) }));
  } else {
    if (which === 'today') {
      const last = [...past].reverse().find((point) => isNumber(point.temperature));
      const target = [...past].reverse().find((point) => isNumber(point.target));
      headline = last ? charts.formatDegrees(last.temperature, imperial) : '–';
      if (last && target) headline += ` → ${charts.formatDegrees(target.target, imperial)}`;
      sub.push(kWhText(wh, l));
    } else {
      headline = kWhText(wh, l);
      const average = mean(past.map((point) => point.temperature));
      if (average !== null) sub.push(fill(l.mean, { temperature: charts.formatDegrees(average, imperial) }));
    }
    if (paid !== null) sub.push(fill(l.paid, { price: money(paid, currency) }));
  }

  return charts.day({
    day: d,
    timeZone,
    now: which === 'today' ? now : null,
    headline,
    sub: sub.join(' · '),
    imperial,
    temperature: { points: past, expected: ahead },
    energy: past,
    strip: inDay(slots, d).filter((s) => typeof s.price === 'number'),
    labels: which === 'tomorrow' ? { ...l, noData: l.no_prices } : l,
    currency
  });
}

/**
 * @description The controller's day: prices with the expensive slots and the outdoor temperature on the right axis,
 * all zones' heating power below. Tomorrow: the prices as far as known.
 * @param {string} which - 'yesterday' | 'today' | 'tomorrow'
 * @param {Object} opts - { rows, slots (priceSlots), now, timeZone, imperial, currency, labels }
 */
function controllerDay(which, { rows, slots = [], now, timeZone, imperial = false, currency = '€', labels: l }) {
  const d = dayOf(timeZone, now, which);
  const quarters = rows.map((row) => ({ time: row.quarter, end: row.quarter + QUARTER_MS, outdoor: row.outdoor, energy: totalEnergy(row) }));
  const past = which === 'tomorrow' ? [] : inDay(quarters, d);
  const daySlots = inDay(slots, d).filter((s) => typeof s.price === 'number');
  const values = daySlots.map((s) => s.price);

  let headline = '–';
  const sub = [];
  if (which === 'today') {
    const current = daySlots.find((s) => s.time <= now && now < s.end);
    if (current) headline = money(current.price, currency);
    sub.push(kWhText(sum(past.map((point) => point.energy)), l));
    const last = [...past].reverse().find((point) => isNumber(point.outdoor));
    if (last) sub.push(fill(l.outdoor_now, { temperature: charts.formatDegrees(last.outdoor, imperial) }));
  } else {
    if (values.length) headline = fill(l.average, { price: money(sum(values) / values.length, currency) });
    if (which === 'yesterday') {
      sub.push(kWhText(sum(past.map((point) => point.energy)), l));
      const average = mean(past.map((point) => point.outdoor));
      if (average !== null) sub.push(fill(l.outdoor_mean, { temperature: charts.formatDegrees(average, imperial) }));
    } else if (values.length) {
      sub.push(`${Math.min(...values).toFixed(3)} – ${Math.max(...values).toFixed(3)}`);
      const until = daySlots[daySlots.length - 1].end;
      if (until < d.end) sub.push(fill(l.prices_until, { time: clock(timeZone, until) }));
    }
  }

  return charts.day({
    day: d,
    timeZone,
    now: which === 'today' ? now : null,
    headline,
    sub: sub.join(' · '),
    imperial,
    prices: daySlots,
    outdoor: past,
    energy: past,
    labels: which === 'tomorrow' ? { ...l, noData: l.no_prices } : l,
    currency
  });
}

function totalEnergy(row) {
  const metered = row.zones.filter((z) => typeof z.energy === 'number');
  return metered.length ? sum(metered.map((z) => z.energy)) : null;
}

/**
 * @description Price days in the controller's store format from the history's quarter prices, for tools/charts.js.
 */
function daysFromHistory(rows, timeZone) {
  const days = {};
  for (const row of rows) {
    const date = localDate(timeZone, row.quarter);
    const { start } = prices.dayInfo(timeZone, date, 15);
    const entry = days[date] || (days[date] = { resolution: 15, values: [] });
    const i = Math.round((row.quarter - start) / QUARTER_MS);
    while (entry.values.length < i) entry.values.push(null);
    entry.values[i] = row.price;
  }
  return days;
}

module.exports = {
  DAYS,
  labels,
  dayOf,
  priceSlots,
  expectedTargets,
  zoneDay,
  controllerDay,
  daysFromHistory
};

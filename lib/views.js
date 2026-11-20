'use strict';

/**
 * What each device's camera images show (issue #12): Today and Tomorrow, as chart specs for lib/charts.js. Pure; the
 * devices collect the data and lib/images.js draws them. Ahead of now only what the app already knows: the stored
 * prices, the expensive slots the price model finds in them, the zone's target that its rules give for them with
 * everything else as now, the Open-Meteo forecast and a water device's plan. No temperatures are guessed for a zone.
 */

const { localDate, addDays } = require('oh2th-homey-helpers');
const prices = require('./prices');
const zone = require('./zone');
const { COLOR } = require('./charts');

const QUARTER_MS = 15 * 60 * 1000;
const DAYS = ['today', 'tomorrow'];

function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * @description Replace __key__ in a template.
 */
function fill(template, args = {}) {
  return Object.entries(args).reduce((result, [key, value]) => result.split(`__${key}__`).join(value), String(template));
}

/**
 * @description °C in the shown unit, null when unknown.
 */
function degrees(celsius, imperial) {
  if (!isNumber(celsius)) return null;
  return imperial ? celsius * 1.8 + 32 : celsius;
}

function formatDegrees(celsius, imperial) {
  const value = degrees(celsius, imperial);
  return value === null ? '–' : `${(Math.round(value * 10) / 10).toFixed(1).replace('-', '−')} °${imperial ? 'F' : 'C'}`;
}

function formatPrice(value, currency) {
  return `${value.toFixed(2).replace('-', '−')} ${currency}/kWh`;
}

function clock(timeZone, ms) {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
}

function duration(ms) {
  const minutes = Math.round(ms / 60000);
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
}

/**
 * @description The local days of the images: today and tomorrow, { date, start, end } (DST safe).
 */
function days(timeZone, now) {
  const today = localDate(timeZone, now);
  return Object.fromEntries(
    DAYS.map((id, i) => {
      const date = addDays(today, i);
      const { start, end } = prices.dayInfo(timeZone, date, 60);
      return [id, { date, start, end }];
    })
  );
}

function inDay(list, day, key = 'time') {
  return list.filter((item) => item[key] >= day.start && item[key] < day.end);
}

/**
 * @description The stored price days as slots, yesterday to tomorrow, each with the price model's decision for it
 * (the home's levels included), as the Home Controller decides it when the slot comes.
 * @param {Object} opts - prices.evaluate() options without now: { days, timeZone, resolution, model, pct, minDelta, ceiling, high }
 * @param {number} now - ms
 * @returns {Array} [{ time, end, price, expensive, peak, level }], price null when unknown
 */
function priceSlots(opts, now) {
  return prices.evaluateSlots({ ...opts, now });
}

/**
 * @description The colour of a price slot: over the home's Expensive above red, a price peak (the price model's
 * relative spike) orange, otherwise the given colour.
 */
function slotColor(slot, color) {
  if (slot.level === 'expensive') return COLOR.expensive;
  return slot.peak ? COLOR.peak : color;
}

/**
 * @description Legend entries of the price slots of a day: Price peak, and Expensive only when a slot is over Expensive above.
 */
function priceLegend(slots, day, labels) {
  const items = [{ label: labels.peak, color: COLOR.peak }];
  if (inDay(slots, day).some((slot) => slot.price !== null && slot.level === 'expensive')) items.push({ label: labels.expensive, color: COLOR.expensive });
  return items;
}

/**
 * @description The strip under a zone's chart: each known price slot of the day, peaks and Expensive highlighted.
 */
function priceStrip(slots, day) {
  return {
    slots: inDay(slots, day)
      .filter((slot) => slot.price !== null)
      .map((slot) => ({ time: slot.time, end: slot.end, color: slotColor(slot, COLOR.normal) }))
  };
}

/**
 * @description A zone's expected target ahead: zone.decide() for each known price slot from now, with the slot's price
 * decision and everything else as now (occupancy, season, setpoints, temperature).
 * @param {Object} input - The zone.decide() arguments now ({ shared, source, zone, temperature })
 * @returns {Array} [{ time, end, target, low, high, eco }]
 */
function expectedTargets(input, slots, now) {
  if (!input) return [];
  return slots
    .filter((slot) => slot.end > now && slot.price !== null)
    .map((slot) => {
      const time = Math.max(slot.time, now);
      const shared = { ...input.shared, expensive: slot.expensive, peak: slot.peak, priceLevel: slot.level };
      const decision = zone.decide({ ...input, shared, now: time });
      return { time, end: slot.end, target: decision.target, low: decision.band.low, high: decision.band.high, eco: decision.eco };
    });
}

function temperatureAxis(imperial, color = COLOR.muted) {
  return { decimals: 0, pad: imperial ? 0.9 : 0.5, minSpan: imperial ? 4 : 2, color, unit: imperial ? '°F' : '°C' };
}

/**
 * @description A Heating Zone's images. Today: measured temperature, target and the comfort–eco band from the history,
 * the expected target dashed from now; Tomorrow: the expected target and band. Both with the expensive strip.
 * @param {Object} common - { timeZone, now, imperial, labels, days, slots (priceSlots) }
 * @param {Object} z - { rows: [{ time (quarter start), temperature, target, low, high }] of today, temperature (now),
 *   target (now, null when none), input (zone.decide() arguments now, null when not decided yet) }
 * @returns {Array} [{ id, spec }]
 */
function zoneViews(common, z) {
  const { timeZone, now, imperial, labels } = common;
  const deg = (value) => degrees(value, imperial);
  const expected = expectedTargets(z.input, common.slots, now);
  const legend = [
    { label: labels.temperature, color: COLOR.temperature },
    { label: labels.target, color: COLOR.target },
    { label: labels.band, color: COLOR.band }
  ];
  const base = (day) => ({ day, timeZone, left: temperatureAxis(imperial), right: null, spans: [], strip: priceStrip(common.slots, day) });
  const bandOf = (list) => list.map((s) => ({ time: s.time, end: s.end, low: deg(s.low), high: deg(s.high) }));
  const targetOf = (list) => list.map((s) => ({ time: s.time, end: s.end, value: deg(s.target) }));

  const { today } = common.days;
  const rows = inDay(z.rows || [], today)
    .filter((row) => row.time < now)
    .map((row) => ({ ...row, end: Math.min(row.time + QUARTER_MS, now) }));
  const aheadToday = inDay(expected, today);
  const measured = rows.map((row) => ({ time: row.time + QUARTER_MS, value: deg(row.temperature) })).filter((point) => point.time <= now);
  if (isNumber(z.temperature)) measured.push({ time: now, value: deg(z.temperature) });
  const todaySpec = {
    ...base(today),
    now,
    headline: isNumber(z.target) ? fill(labels.zone_now, { temperature: formatDegrees(z.temperature, imperial), target: formatDegrees(z.target, imperial) }) : formatDegrees(z.temperature, imperial),
    legend: [...legend, ...priceLegend(common.slots, today, labels)],
    series: [
      { type: 'band', color: COLOR.band, slots: [...bandOf(rows), ...bandOf(aheadToday)] },
      { type: 'step', color: COLOR.target, width: 3, slots: targetOf(rows) },
      { type: 'step', color: COLOR.target, width: 3, dashed: true, slots: targetOf(aheadToday) },
      { type: 'line', color: COLOR.temperature, width: 3, points: measured }
    ]
  };

  const { tomorrow } = common.days;
  const aheadTomorrow = inDay(expected, tomorrow);
  const eco = aheadTomorrow.filter((s) => s.eco && isNumber(s.target)).reduce((sum, s) => sum + (s.end - s.time), 0);
  let headline = labels.tomorrow;
  if (aheadTomorrow.some((s) => isNumber(s.target))) headline = fill(labels.zone_tomorrow, { eco: duration(eco) });
  const tomorrowSpec = {
    ...base(tomorrow),
    now: null,
    headline,
    empty: aheadTomorrow.length ? null : labels.no_prices,
    legend: [...legend.filter((item) => item.color !== COLOR.temperature), ...priceLegend(common.slots, tomorrow, labels)],
    series: [
      { type: 'band', color: COLOR.band, slots: bandOf(aheadTomorrow) },
      { type: 'step', color: COLOR.target, width: 3, dashed: true, slots: targetOf(aheadTomorrow) }
    ]
  };
  return [
    { id: 'today', spec: todaySpec },
    { id: 'tomorrow', spec: tomorrowSpec }
  ];
}

function priceAxis(slots, currency) {
  const top = Math.max(0, ...slots.map((slot) => Math.abs(slot.price)).filter(isNumber));
  let decimals = 0;
  if (top < 1) decimals = 2;
  else if (top < 10) decimals = 1;
  return { zero: true, minSpan: top < 1 ? 0.05 : 1, decimals, color: COLOR.muted, unit: `${currency}/kWh` };
}

function priceBars(slots, color = null) {
  return slots.filter((slot) => slot.price !== null).map((slot) => ({ time: slot.time, end: slot.end, value: slot.price, color: color || slotColor(slot, COLOR.price) }));
}

/**
 * @description The Home Controller's images: the price of each slot, expensive ones highlighted, and the outdoor
 * temperature (measured today, the forecast dashed ahead).
 * @param {Object} common - { timeZone, now, imperial, labels, currency, days, slots }
 * @param {Object} c - { rows: [{ time (quarter start), outdoor }] of today, outdoor (now), forecast: [[ms, °C], …] or null }
 * @returns {Array} [{ id, spec }]
 */
function controllerViews(common, c) {
  const { timeZone, now, imperial, labels, currency } = common;
  const deg = (value) => degrees(value, imperial);
  const legend = (day) => [{ label: fill(labels.price, { currency }), color: COLOR.price }, ...priceLegend(common.slots, day, labels), { label: labels.outdoor, color: COLOR.outdoor }];
  const forecastIn = (day) => (c.forecast || []).filter(([ms]) => ms > Math.max(day.start, now) && ms <= day.end + 60 * 60 * 1000).map(([ms, value]) => ({ time: ms, value: deg(value) }));
  const view = (day, isToday) => {
    const slots = inDay(common.slots, day).filter((slot) => slot.price !== null);
    const ahead = forecastIn(day);
    const series = [{ type: 'bars', color: COLOR.price, slots: priceBars(slots) }];
    if (isToday) {
      const measured = inDay(c.rows || [], day)
        .map((row) => ({ time: row.time + QUARTER_MS, value: deg(row.outdoor) }))
        .filter((point) => point.time <= now);
      if (isNumber(c.outdoor)) measured.push({ time: now, value: deg(c.outdoor) });
      series.push({ type: 'line', axis: 'right', color: COLOR.outdoor, width: 3, points: measured });
      if (ahead.length && isNumber(c.outdoor)) ahead.unshift({ time: now, value: deg(c.outdoor) });
    }
    series.push({ type: 'line', axis: 'right', color: COLOR.outdoor, width: 3, dashed: true, points: ahead });
    return { slots, series };
  };

  const { today } = common.days;
  const t = view(today, true);
  const nowSlot = t.slots.find((slot) => slot.time <= now && now < slot.end);
  const todayParts = [];
  if (nowSlot) todayParts.push(fill(labels.price_now, { price: formatPrice(nowSlot.price, currency) }));
  if (isNumber(c.outdoor)) todayParts.push(fill(labels.outdoor_now, { outdoor: formatDegrees(c.outdoor, imperial) }));
  const todaySpec = {
    day: today,
    timeZone,
    now,
    headline: todayParts.join(' · ') || labels.today,
    empty: t.slots.length ? null : labels.no_prices,
    legend: legend(today),
    left: priceAxis(t.slots, currency),
    right: temperatureAxis(imperial, COLOR.outdoor),
    spans: [],
    series: t.series,
    strip: null
  };

  const { tomorrow } = common.days;
  const m = view(tomorrow, false);
  const tomorrowParts = [];
  if (m.slots.length) tomorrowParts.push(fill(labels.price_average, { price: formatPrice(m.slots.reduce((sum, slot) => sum + slot.price, 0) / m.slots.length, currency) }));
  const lows = (c.forecast || []).filter(([ms]) => ms >= tomorrow.start && ms < tomorrow.end).map(([, value]) => value);
  if (lows.length) tomorrowParts.push(fill(labels.outdoor_low, { outdoor: formatDegrees(Math.min(...lows), imperial) }));
  const tomorrowSpec = {
    day: tomorrow,
    timeZone,
    now: null,
    headline: tomorrowParts.join(' · ') || labels.tomorrow,
    empty: m.slots.length ? null : labels.no_prices,
    legend: legend(tomorrow),
    left: priceAxis(m.slots, currency),
    right: temperatureAxis(imperial, COLOR.outdoor),
    spans: [],
    series: m.series,
    strip: null
  };
  return [
    { id: 'today', spec: todaySpec },
    { id: 'tomorrow', spec: tomorrowSpec }
  ];
}

/**
 * @description A Hot Tub's or Water Heater's images: the price of each slot, the water temperature (measured, the
 * plan's expected temperature dashed ahead), the ready times with their temperature, and a strip of the heating
 * (heated before now, planned ahead).
 * @param {Object} common - { timeZone, now, imperial, labels, currency, days, slots }
 * @param {Object} w - { log: [{ time (quarter start), temperature, heating }], temperature (now), heatingNow,
 *   plan: [{ time (quarter start), heat, temperature }] from now (empty without a plan), block: { start, end } | null
 *   (a planned night block), uses: [{ start, end }], ready (°C) }
 * @returns {Array} [{ id, spec }]
 */
function waterViews(common, w) {
  const { timeZone, now, imperial, labels, currency } = common;
  const deg = (value) => degrees(value, imperial);
  const legend = [
    { label: labels.water, color: COLOR.temperature },
    { label: labels.ready, color: COLOR.ready },
    { label: labels.heating, color: COLOR.heating },
    { label: fill(labels.price, { currency }), color: COLOR.priceDim }
  ];
  const plan = w.plan || [];
  const heating = [
    ...(w.log || []).filter((entry) => entry.heating).map((entry) => ({ time: entry.time, end: Math.min(entry.time + QUARTER_MS, now) })),
    ...plan.filter((q) => q.heat).map((q) => ({ time: Math.max(q.time, now), end: q.time + QUARTER_MS }))
  ];
  if (!plan.length && w.block && w.block.end > now) heating.push({ time: Math.max(w.block.start, now), end: w.block.end });
  if (w.heatingNow && !plan.length) heating.push({ time: now, end: Math.ceil((now + 1) / QUARTER_MS) * QUARTER_MS });
  const uses = (w.uses || []).filter((use) => use.end > use.start);

  const view = (day, isToday) => {
    const slots = inDay(common.slots, day).filter((slot) => slot.price !== null);
    const series = [{ type: 'bars', color: COLOR.price, slots: priceBars(slots, COLOR.priceDim) }];
    if (isToday) {
      const measured = inDay(w.log || [], day)
        .map((entry) => ({ time: entry.time + QUARTER_MS, value: deg(entry.temperature) }))
        .filter((point) => point.time <= now);
      if (isNumber(w.temperature)) measured.push({ time: now, value: deg(w.temperature) });
      series.push({ type: 'line', axis: 'right', color: COLOR.temperature, width: 3, points: measured });
    }
    const ahead = inDay(plan, day).map((q) => ({ time: Math.max(q.time, now), value: deg(q.temperature) }));
    if (isToday && ahead.length && isNumber(w.temperature)) ahead.unshift({ time: now, value: deg(w.temperature) });
    series.push({ type: 'line', axis: 'right', color: COLOR.temperature, width: 3, dashed: true, points: ahead });
    const dayUses = uses.filter((use) => use.end > day.start && use.start < day.end);
    series.push({
      type: 'step',
      axis: 'right',
      color: COLOR.ready,
      width: 3,
      slots: dayUses.map((use) => ({ time: Math.max(use.start, day.start), end: Math.min(use.end, day.end), value: deg(w.ready) }))
    });
    return {
      day,
      timeZone,
      now: isToday ? now : null,
      legend,
      left: priceAxis(slots, currency),
      right: temperatureAxis(imperial, COLOR.temperature),
      spans: dayUses.map((use) => ({ from: use.start, to: use.end, color: COLOR.use })),
      series,
      strip: { slots: heating.filter((h) => h.end > day.start && h.time < day.end).map((h) => ({ time: Math.max(h.time, day.start), end: Math.min(h.end, day.end), color: COLOR.heating })) },
      dayUses,
      slots
    };
  };
  const finish = ({ dayUses, slots, ...spec }, headline, emptyWhenNoPrices) => ({ ...spec, headline, empty: emptyWhenNoPrices && !slots.length ? labels.no_prices : null });

  const today = view(common.days.today, true);
  const nextUse = today.dayUses.find((use) => use.start > now);
  const parts = [formatDegrees(w.temperature, imperial)];
  if (nextUse && isNumber(w.ready)) parts.push(fill(labels.ready_at, { temperature: formatDegrees(w.ready, imperial), time: clock(timeZone, nextUse.start) }));
  const tomorrow = view(common.days.tomorrow, false);
  const firstUse = tomorrow.dayUses.find((use) => use.start >= common.days.tomorrow.start);
  const tomorrowHeadline = firstUse && isNumber(w.ready) ? fill(labels.ready_at, { temperature: formatDegrees(w.ready, imperial), time: clock(timeZone, firstUse.start) }) : labels.no_ready;
  return [
    { id: 'today', spec: finish(today, parts.join(' · '), false) },
    { id: 'tomorrow', spec: finish(tomorrow, tomorrowHeadline, true) }
  ];
}

/**
 * @description The texts of the charts from the locale (graph.*), with a translate function such as homey.__.
 */
function labels(t) {
  const keys = [
    'today',
    'tomorrow',
    'temperature',
    'target',
    'band',
    'peak',
    'expensive',
    'price',
    'outdoor',
    'water',
    'ready',
    'heating',
    'no_prices',
    'no_ready',
    'zone_now',
    'zone_tomorrow',
    'price_now',
    'price_average',
    'outdoor_now',
    'outdoor_low',
    'ready_at'
  ];
  return Object.fromEntries(keys.map((key) => [key, t(`graph.${key}`)]));
}

module.exports = { QUARTER_MS, DAYS, fill, days, priceSlots, expectedTargets, zoneViews, controllerViews, waterViews, labels };

'use strict';

/**
 * Pure logic of the Water Monitor (issue #37): the house water meter's litres today and this month, and the water flow
 * cut into uses. Sources are standard capabilities: meter_water (m³, cumulative) and measure_water (flow, l/min).
 */

// Flow above this (l/min) counts as water running; meters report a little noise around zero.
const MIN_FLOW = 0.2;
// A use ends when the flow has stayed at zero this long: a pause in a shower doesn't split it, an appliance's fills a
// few minutes apart are separate uses.
const END_GAP_MS = 60 * 1000;
// A running flow without a new reading for this long is stale (the meter went away): the use ends there.
const MAX_HOLD_MS = 10 * 60 * 1000;
// A meter step larger than this (m³) is not water used but a replaced or reset meter.
const MAX_METER_STEP_M3 = 10;
// A use is confirmed when the meter reading has risen this much (l) since it started: some meters report a flow
// while no water passes (e.g. an ultrasonic sensor after a use), and their reading doesn't move then.
const CONFIRM_L = 1;
// Water use categories chosen at pairing, in the pairing page's order. A use stays Unknown until it is labelled with a
// "Last use was …" button, or its category's learned pattern clearly fits it.
const CATEGORIES = ['shower', 'sink', 'toilet', 'bath', 'outdoor'];
const UNKNOWN = 'unknown';
// A category is learned from this many labelled uses before it is assigned by itself.
const MIN_SAMPLES = 3;
// How far a feature may differ from a sample's and still be alike (natural log): about ±30 %; the length varies more.
const TOLERANCE = { litres: 0.25, minutes: 0.35, average: 0.25, peak: 0.25 };
// A use is near a sample when their distance (features scaled by TOLERANCE) is at most this.
const NEAR = 1.5;
// A use takes the category of its nearest samples, up to this many, when they all agree.
const NEIGHBOURS = 3;
// The features of a use, compared in log space: they are positive and vary by ratio (a long shower is twice as long).
const FEATURES = ['litres', 'minutes', 'average', 'peak'];
// Finished uses kept for GET /water.
const KEEP_USES = 100;
// Learning samples kept per category, newest: a rare category (a bath) keeps its own while showers come and go.
const KEEP_SAMPLES = 30;

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * @description The month of a local date, YYYY-MM.
 */
function monthOf(date) {
  return String(date).slice(0, 7);
}

/**
 * @description The month before a YYYY-MM month.
 */
function previousMonth(month) {
  const [year, m] = String(month).split('-').map(Number);
  return m === 1 ? `${year - 1}-12` : `${year}-${String(m - 1).padStart(2, '0')}`;
}

/**
 * @description A month's record for the history: its litres, per category too, and the water price and base fee it is
 * costed at (those in effect when it ended).
 */
function monthRecord(totals) {
  const pricing = totals.pricing || {};
  const cats = {};
  for (const [category, sums] of Object.entries(totals.cats || {})) cats[category] = finite(sums.monthL) ? sums.monthL : 0;
  return { L: finite(totals.monthL) ? totals.monthL : 0, cats, price: finite(pricing.price) ? pricing.price : null, fee: finite(pricing.fee) ? pricing.fee : null };
}

/**
 * @description The totals for a local date: today's litres start from zero on a new day, the month's on a new month.
 * The month that ended goes to the history (this year's and last year's months are kept), for last month's and the
 * years' litres and costs.
 * @param {Object|null} totals - { date, month, todayL, monthL, cats: { <category>: { todayL, monthL } }, history:
 *   { <YYYY-MM>: { L, cats, price, fee } }, pricing: { price, fee } } from the store
 * @param {string} date - Local date YYYY-MM-DD
 * @param {Object} [pricing] - The water price and base fee now: { price, fee }, null when not set
 * @returns {Object} totals
 */
function rollover(totals, date, pricing) {
  const month = monthOf(date);
  const before = totals || {};
  const day = (value) => (before.date === date && finite(value) ? value : 0);
  const mon = (value) => (before.month === month && finite(value) ? value : 0);
  const cats = {};
  for (const [category, sums] of Object.entries(before.cats || {})) cats[category] = { todayL: day(sums.todayL), monthL: mon(sums.monthL) };
  const history = { ...(before.history || {}) };
  if (before.month && before.month < month) history[before.month] = monthRecord(before);
  const firstYear = Number(month.slice(0, 4)) - 1;
  for (const key of Object.keys(history)) if (Number(key.slice(0, 4)) < firstYear) delete history[key];
  return { date, month, todayL: day(before.todayL), monthL: mon(before.monthL), cats, history, pricing: pricing || before.pricing || null };
}

/**
 * @description A use's litres added to its category today and this month (after the rollover to the date).
 */
function addCategory(totals, date, category, litres) {
  const next = rollover(totals, date);
  if (!finite(litres) || litres <= 0) return next;
  const sums = next.cats[category] || { todayL: 0, monthL: 0 };
  return { ...next, cats: { ...next.cats, [category]: { todayL: sums.todayL + litres, monthL: sums.monthL + litres } } };
}

/**
 * @description A relabelled use's litres moved from one category to another: from today when it ended today, from the
 * month when it ended this month. Unknown isn't kept (it is the rest), so moving from or to it only changes the other one.
 * @param {Object} totals - The totals (after the rollover)
 * @param {string} date - Local date the use ended
 */
function moveCategory(totals, date, from, to, litres) {
  if (!totals || from === to || !finite(litres) || litres <= 0) return totals;
  const today = totals.date === date;
  const month = totals.month === monthOf(date);
  const cats = { ...(totals.cats || {}) };
  const change = (category, sign) => {
    if (!category || category === UNKNOWN || category === 'other') return;
    const sums = cats[category] || { todayL: 0, monthL: 0 };
    cats[category] = {
      todayL: Math.max(0, sums.todayL + (today ? sign * litres : 0)),
      monthL: Math.max(0, sums.monthL + (month ? sign * litres : 0))
    };
  };
  change(from, -1);
  change(to, 1);
  // A use of a month that already ended (relabelled just after midnight): its month in the history.
  const record = (totals.history || {})[monthOf(date)];
  if (!month && record) {
    const moved = { ...record.cats };
    for (const [category, sign] of [[from, -1], [to, 1]]) {
      if (!category || category === UNKNOWN || category === 'other') continue;
      moved[category] = Math.max(0, (moved[category] || 0) + sign * litres);
    }
    return { ...totals, cats, history: { ...totals.history, [monthOf(date)]: { ...record, cats: moved } } };
  }
  return { ...totals, cats };
}

/**
 * @description The chosen categories, known ones only, in the pairing order.
 */
function chosenCategories(list) {
  const picked = Array.isArray(list) ? list : [];
  return CATEGORIES.filter((category) => picked.includes(category));
}

/**
 * @description A use's features in log space (lib FEATURES), null when one is missing or not positive.
 * @param {Object} use - { start, end, litres, average, peak }
 */
function features(use) {
  const values = { litres: use.litres, minutes: Math.max(0, use.end - use.start) / 60000, average: use.average, peak: use.peak };
  const logs = {};
  for (const key of FEATURES) {
    if (!finite(values[key]) || values[key] <= 0) return null;
    logs[key] = Math.log(values[key]);
  }
  return logs;
}

/**
 * @description What each chosen category has learned: its samples (labelled uses, and uses it was assigned that
 * weren't relabelled) as features. A category may have several kinds of use (an eco and a full flush, with or without
 * washing hands), so the samples are kept as they are, not averaged. Only categories with MIN_SAMPLES have one.
 * @param {Object[]} labels - Samples { start, end, litres, average, peak, category }
 * @param {string[]} chosen - Chosen categories
 * @returns {Object} { <category>: { n, samples: [<features>] } }
 */
function learnPatterns(labels, chosen) {
  const patterns = {};
  for (const category of chosen) {
    const samples = (Array.isArray(labels) ? labels : []).filter((label) => label && label.category === category).map(features).filter(Boolean);
    if (samples.length >= MIN_SAMPLES) patterns[category] = { n: samples.length, samples };
  }
  return patterns;
}

/**
 * @description The distance of two uses' features, each feature scaled by its TOLERANCE.
 */
function distance(a, b) {
  return Math.sqrt(FEATURES.reduce((sum, key) => sum + ((a[key] - b[key]) / TOLERANCE[key]) ** 2, 0));
}

/**
 * @description The category of a finished use: that of its nearest learned samples (at most NEIGHBOURS within NEAR)
 * when they all agree. No sample near, or near samples of two categories: Unknown, until a button labels it.
 * @param {Object} use - { start, end, litres, average, peak }
 * @param {Object} patterns - From learnPatterns
 */
function classify(use, patterns) {
  const logs = features(use);
  if (!logs) return UNKNOWN;
  const near = [];
  for (const [category, pattern] of Object.entries(patterns || {})) {
    for (const sample of pattern.samples) {
      const d = distance(logs, sample);
      if (d <= NEAR) near.push({ category, d });
    }
  }
  const nearest = near.sort((a, b) => a.d - b.d).slice(0, NEIGHBOURS);
  if (!nearest.length || nearest.some((n) => n.category !== nearest[0].category)) return UNKNOWN;
  return nearest[0].category;
}

/**
 * @description Litres per chosen category today and this month, and Unknown: the house total less the chosen ones, so
 * they add up to the meter's litres (a use's own litres come from the flow and differ a little).
 * @returns {Object} { <category>: { todayL, monthL }, unknown: { todayL, monthL } }
 */
function categoryTotals(totals, chosen) {
  const t = totals || { todayL: 0, monthL: 0, cats: {} };
  const cats = t.cats || {};
  const result = {};
  let today = 0;
  let month = 0;
  for (const category of chosen) {
    const sums = cats[category] || { todayL: 0, monthL: 0 };
    result[category] = { todayL: sums.todayL, monthL: sums.monthL };
    today += sums.todayL;
    month += sums.monthL;
  }
  result[UNKNOWN] = { todayL: Math.max(0, (t.todayL || 0) - today), monthL: Math.max(0, (t.monthL || 0) - month) };
  return result;
}

/**
 * @description The litres and costs of the house and each chosen category (and Unknown) for the device's tiles: today,
 * this month, last month, this year and last year. A month's cost is its litres at its water price; the house's has
 * the base fee too (the days so far this month, the whole fee of an ended month). Last month and last year are null
 * without a record in the history.
 * @param {Object} totals - The totals (after the rollover)
 * @param {string[]} chosen - Chosen categories
 * @returns {Object} { house, <category>, unknown: { todayL, monthL, monthCost, lastMonthL, lastMonthCost, yearL,
 *   yearCost, lastYearL, lastYearCost } }
 */
function periods(totals, chosen) {
  const t = totals || rollover(null, '1970-01-01');
  const year = Number(t.month.slice(0, 4));
  const current = monthRecord(t);
  const fee = baseFee(current.fee, t.date);
  const months = Object.entries(t.history || {});
  const lastMonth = (t.history || {})[previousMonth(t.month)] || null;
  const thisYear = months.filter(([key]) => Number(key.slice(0, 4)) === year).map(([, record]) => record);
  const lastYear = months.filter(([key]) => Number(key.slice(0, 4)) === year - 1).map(([, record]) => record);
  const owners = ['house', ...chosen, UNKNOWN];
  const litresOf = (record, owner) => {
    if (owner === 'house') return record.L;
    if (owner !== UNKNOWN) return record.cats[owner] || 0;
    return Math.max(0, record.L - chosen.reduce((sum, category) => sum + (record.cats[category] || 0), 0));
  };
  // An ended month's cost: its litres at its price, the house's with the whole base fee.
  const costOf = (record, owner) => (cost(litresOf(record, owner), record.price) ?? 0) + (owner === 'house' && finite(record.fee) ? record.fee : 0);
  const currentCost = (owner) => (cost(litresOf(current, owner), current.price) ?? 0) + (owner === 'house' && fee ? fee.month : 0);
  const sum = (records, fn) => records.reduce((total, record) => total + fn(record), 0);
  const today = categoryTotals(t, chosen);
  const result = {};
  for (const owner of owners) {
    result[owner] = {
      todayL: owner === 'house' ? t.todayL : today[owner].todayL,
      monthL: litresOf(current, owner),
      monthCost: currentCost(owner),
      lastMonthL: lastMonth ? litresOf(lastMonth, owner) : null,
      lastMonthCost: lastMonth ? costOf(lastMonth, owner) : null,
      yearL: litresOf(current, owner) + sum(thisYear, (record) => litresOf(record, owner)),
      yearCost: currentCost(owner) + sum(thisYear, (record) => costOf(record, owner)),
      lastYearL: lastYear.length ? sum(lastYear, (record) => litresOf(record, owner)) : null,
      lastYearCost: lastYear.length ? sum(lastYear, (record) => costOf(record, owner)) : null
    };
  }
  return result;
}

/**
 * @description Litres added to today and this month (after the rollover to the date).
 */
function addLitres(totals, date, litres) {
  const next = rollover(totals, date);
  if (!finite(litres) || litres <= 0) return next;
  return { ...next, todayL: next.todayL + litres, monthL: next.monthL + litres };
}

/**
 * @description Litres since the last meter reading. The first reading, a meter that went backwards (reset or replaced)
 * and a jump over MAX_METER_STEP_M3 only set the new starting point.
 * @param {number|null} last - Previous reading (m³), null at the start
 * @param {number|null} value - New reading (m³)
 * @returns {Object} { litres, last }
 */
function meterStep(last, value) {
  if (!finite(value)) return { litres: 0, last };
  if (!finite(last)) return { litres: 0, last: value };
  const step = value - last;
  if (step < 0 || step > MAX_METER_STEP_M3) return { litres: 0, last: value };
  return { litres: step * 1000, last: value };
}

/**
 * @description Litres from the flow since the previous flow reading, for a source without meter_water: the previous
 * flow lasted until now, at most MAX_HOLD_MS.
 * @param {Object|null} last - { at, flow } of the previous reading
 * @param {number} at - Time of the new reading (ms)
 * @param {number|null} flow - New flow (l/min), null when unknown
 * @returns {Object} { litres, last }
 */
function flowStep(last, at, flow) {
  const litres = last && finite(last.flow) && last.flow > MIN_FLOW ? (last.flow * Math.min(MAX_HOLD_MS, Math.max(0, at - last.at))) / 60000 : 0;
  return { litres, last: { at, flow: finite(flow) ? Math.max(0, flow) : null } };
}

/**
 * @description The finished use as reported: start and end (ms), litres, peak and average flow (l/min).
 */
function finish(use, end) {
  const minutes = Math.max(0, end - use.start) / 60000;
  return {
    start: use.start,
    end,
    litres: use.litres,
    peak: use.peak,
    average: minutes > 0 ? use.litres / minutes : use.peak,
    confirmed: !!use.confirmed
  };
}

/**
 * @description End the running use when the flow has been zero for END_GAP_MS, or a running flow went stale.
 * @param {Object|null} use - The running use
 * @param {number} at - Now (ms)
 * @returns {Object} { use, ended } - ended is the finished use or null
 */
function checkEnd(use, at) {
  if (!use) return { use: null, ended: null };
  if (finite(use.zeroSince) && at - use.zeroSince >= END_GAP_MS) return { use: null, ended: finish(use, use.zeroSince) };
  if (use.flow > MIN_FLOW && at - use.at >= MAX_HOLD_MS) {
    const end = use.at + MAX_HOLD_MS;
    return { use: null, ended: finish({ ...use, litres: use.litres + (use.flow * MAX_HOLD_MS) / 60000 }, end) };
  }
  return { use, ended: null };
}

/**
 * @description One flow reading: starts, continues or ends a use. A use starts when the flow rises over MIN_FLOW and
 * ends END_GAP_MS after it fell to zero (checkEnd, also called without a reading).
 * @param {Object|null} use - { start, at, flow, litres, peak, zeroSince } or null
 * @param {number} at - Time of the reading (ms)
 * @param {number|null} flow - Flow (l/min); null when unknown counts as zero
 * @returns {Object} { use, started, ended } - started true when a use began with this reading; ended the finished use
 */
function useStep(use, at, flow) {
  const value = finite(flow) && flow > MIN_FLOW ? flow : 0;
  let current = use;
  let ended = null;
  if (current) {
    // A stale flow or a long enough pause ends the use before this reading.
    const check = checkEnd(current, at);
    current = check.use;
    ended = check.ended;
  }
  if (current) {
    const litres = current.litres + (current.flow * Math.max(0, at - current.at)) / 60000;
    if (value > 0) return { use: { ...current, at, flow: value, litres, peak: Math.max(current.peak, value), zeroSince: null }, started: false, ended };
    return { use: { ...current, at, flow: 0, litres, zeroSince: finite(current.zeroSince) ? current.zeroSince : at }, started: false, ended };
  }
  if (value > 0) return { use: { start: at, at, flow: value, litres: 0, peak: value, zeroSince: null, confirmed: false, meterStart: null }, started: true, ended };
  return { use: null, started: false, ended };
}

/**
 * @description Confirm the running use by the meter reading: the first reading seen is its start, and it is confirmed
 * once the reading has risen CONFIRM_L. Without a meter reading (a flow-only meter) pass confirmNow.
 * @param {Object|null} use - The running use
 * @param {number|null} meterM3 - The meter reading (m³)
 * @param {boolean} [confirmNow] - Confirm without a reading
 * @returns {Object} { use, confirmed } - confirmed true when it became confirmed now
 */
function confirmUse(use, meterM3, confirmNow = false) {
  if (!use || use.confirmed) return { use, confirmed: false };
  if (confirmNow) return { use: { ...use, confirmed: true }, confirmed: true };
  if (!finite(meterM3)) return { use, confirmed: false };
  if (!finite(use.meterStart)) return { use: { ...use, meterStart: meterM3 }, confirmed: false };
  // Readings in m³ with three decimals: allow for float error.
  if ((meterM3 - use.meterStart) * 1000 >= CONFIRM_L - 1e-6) return { use: { ...use, confirmed: true }, confirmed: true };
  return { use, confirmed: false };
}

/**
 * @description Litres of the running use so far, counting its flow up to now.
 */
function runningLitres(use, at) {
  if (!use) return 0;
  return use.litres + (use.flow * Math.min(MAX_HOLD_MS, Math.max(0, at - use.at))) / 60000;
}

/**
 * @description Keep the finished uses, newest last, at most KEEP_USES.
 */
function keepUse(uses, ended) {
  return [...(Array.isArray(uses) ? uses : []), ended].slice(-KEEP_USES);
}

/**
 * @description Keep a learning sample: a labelled use, or one assigned by its learned pattern. A sample of the same
 * use (same start) is replaced, so a relabelled use teaches only its new category. At most KEEP_SAMPLES per category,
 * newest kept, in time order.
 * @param {Object[]} samples - { start, end, litres, average, peak, category, labelled|auto }
 * @param {Object} sample
 */
function keepSample(samples, sample) {
  const list = [...(Array.isArray(samples) ? samples : []).filter((s) => s && s.start !== sample.start), sample].sort((a, b) => a.start - b.start);
  const counts = {};
  const kept = [];
  for (let i = list.length - 1; i >= 0; i--) {
    const { category } = list[i];
    counts[category] = (counts[category] || 0) + 1;
    if (counts[category] <= KEEP_SAMPLES) kept.unshift(list[i]);
  }
  return kept;
}

/**
 * @description The cost of litres at a price per m³; null without a price.
 */
function cost(litres, pricePerM3) {
  if (!finite(litres) || !finite(pricePerM3) || pricePerM3 <= 0) return null;
  return (litres / 1000) * pricePerM3;
}

/**
 * @description The share of a monthly base fee up to and including a local date: the fee is spread evenly over the
 * month's days. { today, month }, null without a fee.
 * @param {number} feePerMonth
 * @param {string} date - Local date YYYY-MM-DD
 */
function baseFee(feePerMonth, date) {
  if (!finite(feePerMonth) || feePerMonth <= 0) return null;
  const [year, month, day] = String(date).split('-').map(Number);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const perDay = feePerMonth / days;
  return { today: perDay, month: perDay * day };
}

module.exports = {
  CATEGORIES,
  UNKNOWN,
  MIN_SAMPLES,
  addCategory,
  moveCategory,
  chosenCategories,
  features,
  learnPatterns,
  classify,
  categoryTotals,
  periods,
  previousMonth,
  MIN_FLOW,
  END_GAP_MS,
  MAX_HOLD_MS,
  MAX_METER_STEP_M3,
  CONFIRM_L,
  KEEP_USES,
  KEEP_SAMPLES,
  keepSample,
  monthOf,
  rollover,
  addLitres,
  meterStep,
  flowStep,
  useStep,
  checkEnd,
  confirmUse,
  runningLitres,
  keepUse,
  cost,
  baseFee
};

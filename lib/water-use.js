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
// Water use categories chosen at pairing, in the pairing page's order. Uses that fit none of the chosen ones are Other.
const CATEGORIES = ['shower', 'tap', 'toilet', 'bath', 'outdoor'];
const OTHER = 'other';
// Default patterns by the use's litres, length (minutes), average and peak flow (l/min), tried in this order: the
// first chosen category that fits wins. Learning from labelled uses comes later.
const PATTERNS = [
  ['bath', (u) => u.litres >= 80 && u.average >= 10],
  ['outdoor', (u) => u.minutes >= 30 || (u.minutes >= 10 && u.average > 12)],
  ['shower', (u) => u.minutes >= 3 && u.average >= 4 && u.average <= 13],
  // A cistern refills at a steady rate.
  ['toilet', (u) => u.litres >= 3 && u.litres <= 10 && u.minutes <= 2.5 && u.peak <= 1.5 * u.average],
  ['tap', (u) => u.minutes < 3]
];
// Finished uses kept for learning and GET /water.
const KEEP_USES = 100;

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
 * @description The totals for a local date: today's litres start from zero on a new day, the month's on a new month.
 * @param {Object|null} totals - { date, month, todayL, monthL, cats: { <category>: { todayL, monthL } } } from the store
 * @param {string} date - Local date YYYY-MM-DD
 * @returns {Object} totals
 */
function rollover(totals, date) {
  const month = monthOf(date);
  const before = totals || {};
  const day = (value) => (before.date === date && finite(value) ? value : 0);
  const mon = (value) => (before.month === month && finite(value) ? value : 0);
  const cats = {};
  for (const [category, sums] of Object.entries(before.cats || {})) cats[category] = { todayL: day(sums.todayL), monthL: mon(sums.monthL) };
  return { date, month, todayL: day(before.todayL), monthL: mon(before.monthL), cats };
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
 * month when it ended this month. Other isn't kept (it is the rest), so moving from or to it only changes the other one.
 * @param {Object} totals - The totals (after the rollover)
 * @param {string} date - Local date the use ended
 */
function moveCategory(totals, date, from, to, litres) {
  if (!totals || from === to || !finite(litres) || litres <= 0) return totals;
  const today = totals.date === date;
  const month = totals.month === monthOf(date);
  const cats = { ...(totals.cats || {}) };
  const change = (category, sign) => {
    if (!category || category === OTHER) return;
    const sums = cats[category] || { todayL: 0, monthL: 0 };
    cats[category] = {
      todayL: Math.max(0, sums.todayL + (today ? sign * litres : 0)),
      monthL: Math.max(0, sums.monthL + (month ? sign * litres : 0))
    };
  };
  change(from, -1);
  change(to, 1);
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
 * @description The category of a finished use: the first chosen one whose pattern fits, else Other.
 * @param {Object} use - { start, end, litres, average, peak }
 * @param {string[]} chosen - Chosen categories
 */
function classify(use, chosen) {
  const u = { litres: use.litres, average: use.average, peak: use.peak, minutes: Math.max(0, use.end - use.start) / 60000 };
  const found = PATTERNS.find(([category, fits]) => chosen.includes(category) && fits(u));
  return found ? found[0] : OTHER;
}

/**
 * @description Litres per chosen category today and this month, and Other: the house total less the chosen ones, so they
 * add up to the meter's litres (a use's own litres come from the flow and differ a little).
 * @returns {Object} { <category>: { todayL, monthL }, other: { todayL, monthL } }
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
  result[OTHER] = { todayL: Math.max(0, (t.todayL || 0) - today), monthL: Math.max(0, (t.monthL || 0) - month) };
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
  OTHER,
  addCategory,
  moveCategory,
  chosenCategories,
  classify,
  categoryTotals,
  MIN_FLOW,
  END_GAP_MS,
  MAX_HOLD_MS,
  MAX_METER_STEP_M3,
  CONFIRM_L,
  KEEP_USES,
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

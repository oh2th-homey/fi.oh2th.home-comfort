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
 * @param {Object|null} totals - { date, month, todayL, monthL } from the store
 * @param {string} date - Local date YYYY-MM-DD
 * @returns {Object} totals
 */
function rollover(totals, date) {
  const month = monthOf(date);
  const before = totals || {};
  return {
    date,
    month,
    todayL: before.date === date && finite(before.todayL) ? before.todayL : 0,
    monthL: before.month === month && finite(before.monthL) ? before.monthL : 0
  };
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
    average: minutes > 0 ? use.litres / minutes : use.peak
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
  if (value > 0) return { use: { start: at, at, flow: value, litres: 0, peak: value, zeroSince: null }, started: true, ended };
  return { use: null, started: false, ended };
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

module.exports = { MIN_FLOW, END_GAP_MS, MAX_HOLD_MS, MAX_METER_STEP_M3, KEEP_USES, monthOf, rollover, addLitres, meterStep, flowStep, useStep, checkEnd, runningLitres, keepUse, cost, baseFee };

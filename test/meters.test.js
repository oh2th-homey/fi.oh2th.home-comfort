'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { sumPower, integrate, pickMeters } = require('../lib/meters');

test('sumPower adds the available readings', () => {
  assert.strictEqual(sumPower([{ value: 80, available: true }, { value: 2.5, available: true }]), 82.5);
  assert.strictEqual(sumPower([{ value: 80, available: true }, { value: 100, available: false }, null, { value: null, available: true }]), 80);
  assert.strictEqual(sumPower([]), null);
  assert.strictEqual(sumPower([{ value: 5, available: false }]), null);
});

test('integrate counts each power for as long as it lasted', () => {
  let energy = integrate(null, 0, 1000);
  assert.strictEqual(energy.wh, 0);
  energy = integrate(energy, 15 * 60000, 400);
  assert.strictEqual(energy.wh, 250);
  energy = integrate(energy, 30 * 60000, null);
  assert.strictEqual(energy.wh, 350);
  // Unknown power adds nothing.
  energy = integrate(energy, 45 * 60000, 100);
  assert.strictEqual(energy.wh, 350);
});

test('pickMeters keeps known meters once and refuses zone meters', () => {
  const meters = [
    { id: 'a', name: 'Ventilation' },
    { id: 'b', name: 'Storage heater' },
    { id: 'c', name: 'Floor meter' }
  ];
  assert.deepStrictEqual(pickMeters(['a', 'b', 'a', 'x'], meters), { meters: [{ id: 'a', name: 'Ventilation' }, { id: 'b', name: 'Storage heater' }], clash: null });
  assert.deepStrictEqual(pickMeters(['a', 'c'], meters, { c: 'Kitchen' }), { meters: [], clash: { name: 'Floor meter', zone: 'Kitchen' } });
  assert.deepStrictEqual(pickMeters([], meters), { meters: [], clash: null });
  assert.deepStrictEqual(pickMeters(undefined, meters), { meters: [], clash: null });
});

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { outOfOrder } = require('../lib/capabilities');

// What Homey shows after removing outOfOrder() and adding the missing wanted ones at the end.
function apply(current, wanted) {
  const removed = outOfOrder(current, wanted);
  const left = current.filter((cap) => wanted.includes(cap) && !removed.includes(cap));
  return [...left, ...wanted.filter((cap) => !left.includes(cap))];
}

test('outOfOrder: nothing when new ones only come at the end', () => {
  assert.deepStrictEqual(outOfOrder(['a', 'b'], ['a', 'b', 'c', 'd']), []);
  assert.deepStrictEqual(outOfOrder(['a', 'b', 'x'], ['a', 'b', 'c']), []);
  assert.deepStrictEqual(outOfOrder([], ['a']), []);
});

test('outOfOrder: a new one in between moves the ones after it', () => {
  // A category ticked later goes before Other.
  assert.deepStrictEqual(outOfOrder(['a', 'shower', 'other'], ['a', 'shower', 'toilet', 'other']), ['other']);
  assert.deepStrictEqual(apply(['a', 'shower', 'other'], ['a', 'shower', 'toilet', 'other']), ['a', 'shower', 'toilet', 'other']);
});

test('outOfOrder: ones in the wrong order are moved', () => {
  assert.deepStrictEqual(outOfOrder(['a', 'c', 'b'], ['a', 'b', 'c']), ['c', 'b']);
  assert.deepStrictEqual(apply(['a', 'c', 'b', 'd'], ['a', 'b', 'c', 'd']), ['a', 'b', 'c', 'd']);
  assert.deepStrictEqual(apply(['b', 'a'], ['a', 'b', 'e']), ['a', 'b', 'e']);
});

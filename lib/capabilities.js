'use strict';

/**
 * Capability order. Homey shows a device's capabilities in the order they were added, and they can't be moved in the
 * Homey app, so a device that adds capabilities later keeps them in order itself.
 */

/**
 * @description The device's capabilities from the first one out of the wanted order onwards: removing these and adding
 * the wanted ones that are then missing (in the wanted order) gives the wanted order. Capabilities not wanted at all
 * are left out (they are removed anyway).
 * @param {string[]} current - The device's capabilities, in their order
 * @param {string[]} wanted - The capabilities it should have, in order
 * @returns {string[]} the capabilities to remove first, in their current order
 */
function outOfOrder(current, wanted) {
  const kept = current.filter((cap) => wanted.includes(cap));
  // The wanted ones the device has, in the wanted order: the kept ones must follow it.
  const order = wanted.filter((cap) => kept.includes(cap));
  const index = kept.findIndex((cap, i) => cap !== order[i]);
  if (index === -1) {
    // In order so far: a wanted capability missing before the last kept one has to come in between.
    const lastKept = wanted.indexOf(kept[kept.length - 1]);
    const firstMissing = wanted.findIndex((cap) => !kept.includes(cap));
    if (firstMissing === -1 || firstMissing > lastKept) return [];
    return kept.filter((cap) => wanted.indexOf(cap) > firstMissing);
  }
  return kept.slice(index);
}

module.exports = { outOfOrder };

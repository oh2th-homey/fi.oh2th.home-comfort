'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { deviceMap, rewrite, cardIds, update } = require('../tools/migrate-flows');

const OLD_C = '11111111-1111-4111-8111-111111111111';
const NEW_C = '22222222-2222-4222-8222-222222222222';
const OLD_Z = '33333333-3333-4333-8333-333333333333';
const NEW_Z = '44444444-4444-4444-8444-444444444444';
const OLD_S = '55555555-5555-4555-8555-555555555555';
const OTHER = '66666666-6666-4666-8666-666666666666';

const DEVICES = [
  { id: OLD_C, name: 'HVAC Controller', driverId: 'homey:app:fi.oh2th.hvac-control:hvac', data: { id: 'hvac-controller' } },
  { id: OLD_Z, name: 'Zone A', driverId: 'homey:app:fi.oh2th.hvac-control:zone', data: { id: 'zone-a' } },
  { id: OLD_S, name: 'Sauna', driverId: 'homey:app:fi.oh2th.hvac-control:sauna', data: { id: 'sauna-1' } },
  { id: NEW_C, name: 'Home Controller', driverId: 'homey:app:fi.oh2th.home-comfort:controller', data: { id: 'controller' } },
  { id: NEW_Z, name: 'Zone A', driverId: 'homey:app:fi.oh2th.home-comfort:zone', data: { id: 'zone-a' } },
  { id: OTHER, name: 'Thermostat', driverId: 'homey:app:com.example:thermostat', data: { id: 'zone-a' } }
];

test('deviceMap pairs old and imported devices by driver and data id', () => {
  const { map, missing } = deviceMap(DEVICES);
  assert.deepStrictEqual(map, { [OLD_C]: NEW_C, [OLD_Z]: NEW_Z });
  assert.deepStrictEqual(missing, [{ id: OLD_S, name: 'Sauna' }]);
});

test('rewrite replaces device ids and the app URI everywhere but ownerUri', () => {
  const { map } = deviceMap(DEVICES);
  const flow = {
    cards: {
      a: { type: 'action', id: `homey:device:${OLD_C}:set_enum_occupancy`, ownerUri: `homey:device:${OLD_C}`, args: { occupancy: 'home' } },
      b: { type: 'action', id: 'homey:manager:notifications:create_notification', args: { text: `Zone: [[homey:device:${OLD_Z}|text_reason]]` } },
      c: { type: 'condition', id: `homey:device:${OTHER}:onoff`, droptoken: `homey:device:${OLD_Z}|measure_temperature` },
      d: { type: 'action', id: 'homey:app:fi.oh2th.hvac-control:some_card', args: { device: { id: OLD_Z, name: 'Zone A' } } },
      e: { type: 'action', id: 'homey:app:fi.oh2th.hvac-control-other:card' }
    }
  };
  const { value, changes, unmapped } = rewrite(flow, map);
  assert.strictEqual(value.cards.a.id, `homey:device:${NEW_C}:set_enum_occupancy`);
  assert.strictEqual(value.cards.a.ownerUri, `homey:device:${OLD_C}`);
  assert.strictEqual(value.cards.b.args.text, `Zone: [[homey:device:${NEW_Z}|text_reason]]`);
  assert.strictEqual(value.cards.c.id, `homey:device:${OTHER}:onoff`);
  assert.strictEqual(value.cards.c.droptoken, `homey:device:${NEW_Z}|measure_temperature`);
  assert.strictEqual(value.cards.d.id, 'homey:app:fi.oh2th.home-comfort:some_card');
  assert.deepStrictEqual(value.cards.d.args.device, { id: NEW_Z, name: 'Zone A' });
  assert.strictEqual(value.cards.e.id, 'homey:app:fi.oh2th.hvac-control-other:card');
  assert.strictEqual(changes, 5);
  assert.deepStrictEqual(unmapped, []);
  // The input is not changed.
  assert.strictEqual(flow.cards.a.id, `homey:device:${OLD_C}:set_enum_occupancy`);
});

test('rewrite reports old devices that have no imported device', () => {
  const { map } = deviceMap(DEVICES);
  const { unmapped } = rewrite({ trigger: { id: `homey:device:${OLD_S}:enum_sauna_state_changed` } }, map, [OLD_C, OLD_Z, OLD_S]);
  assert.deepStrictEqual(unmapped, [OLD_S]);
});

test('cardIds and update cover standard and advanced flows', () => {
  const standard = { name: 'x', trigger: { id: 't' }, conditions: [{ id: 'c' }], actions: [{ id: 'a1' }, { id: 'a2' }] };
  assert.deepStrictEqual(cardIds(standard, false), ['t', 'c', 'a1', 'a2']);
  assert.deepStrictEqual(Object.keys(update(standard, false)), ['trigger', 'conditions', 'actions']);
  const advanced = { name: 'y', cards: { 1: { type: 'trigger', id: 't' }, 2: { type: 'note', value: 'text' }, 3: { type: 'delay', args: {} }, 4: { type: 'action', id: 'a' } } };
  assert.deepStrictEqual(cardIds(advanced, true), ['t', 'a']);
  assert.deepStrictEqual(update(advanced, true), { cards: advanced.cards });
});

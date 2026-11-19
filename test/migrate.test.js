'use strict';

const test = require('node:test');
const assert = require('node:assert');
const migrate = require('../lib/migrate');

// A made-up export in the old app's format (GET /export of v1.8.0).
const EXPORT = {
  app: 'fi.oh2th.hvac-control',
  version: '1.8.0',
  exportedAt: '2026-01-01T00:00:00.000Z',
  devices: [
    {
      driver: 'hvac',
      name: 'HVAC Controller',
      data: { id: 'hvac-controller' },
      store: { outdoor: { id: 'sensor-1', cap: 'measure_temperature', name: 'Outdoor' }, priceSource: { id: 'price-1', name: 'Prices', currency: 'EUR' } },
      settings: { currency: 'EUR', expensive_above: 0.2, removed_setting: 1 },
      capabilities: { enum_occupancy: 'home', thermostat_mode: 'heat', is_long_absence: false, measure_monetary: null, measure_temperature: NaN }
    },
    {
      driver: 'zone',
      name: 'Zone A',
      data: { id: 'zone-a' },
      store: { members: [{ id: 'thermostat-1', control: 'thermostat' }] },
      settings: { comfort_offset: 0 },
      capabilities: { 'target_temperature.comfort': 21, 'target_temperature.eco': 18.5, 'power_boost': false, 'text_reason': 'Comfort' }
    },
    { driver: 'zone', name: 'Zone B', data: { id: 'zone-b' }, store: {}, settings: {}, capabilities: {} },
    { driver: 'sauna', name: 'Sauna', data: { id: 'sauna-1' }, store: { temperature: { id: 'sensor-2', cap: 'measure_temperature', name: 'Sauna sensor' } }, settings: {}, capabilities: {} }
  ],
  history: { 'zones.json': 'e30=' }
};

test('checkExport refuses anything but the old app export', () => {
  assert.throws(() => migrate.checkExport(null));
  assert.throws(() => migrate.checkExport({ app: 'fi.oh2th.home-comfort', devices: [] }));
  assert.throws(() => migrate.checkExport({ app: migrate.OLD_APP }));
  assert.deepStrictEqual(migrate.checkExport(EXPORT).history, EXPORT.history);
});

test('the controller gets the new driver and data id, other ids stay', () => {
  assert.strictEqual(migrate.newDriver('hvac'), 'controller');
  assert.strictEqual(migrate.newDriver('water-heater'), 'water-heater');
  assert.deepStrictEqual(migrate.newData({ id: 'hvac-controller' }), { id: 'controller' });
  assert.deepStrictEqual(migrate.newData({ id: 'zone-a' }), { id: 'zone-a' });
});

test('importable lists one driver, without devices added already', () => {
  assert.deepStrictEqual(migrate.importable(EXPORT, 'controller'), [{ id: 'controller', name: 'HVAC Controller' }]);
  assert.deepStrictEqual(migrate.importable(EXPORT, 'zone', ['zone-a']), [{ id: 'zone-b', name: 'Zone B' }]);
  assert.deepStrictEqual(migrate.importable(EXPORT, 'controller', ['controller']), []);
  assert.deepStrictEqual(migrate.importable(EXPORT, 'spa'), []);
});

test('settingIds flattens groups', () => {
  const settings = [{ type: 'group', children: [{ id: 'a' }, { id: 'b' }] }, { id: 'c' }, { type: 'label' }];
  assert.deepStrictEqual(migrate.settingIds(settings), ['a', 'b', 'c']);
});

test('device keeps name, store and known settings; capability values go to the store', () => {
  const device = migrate.device(EXPORT, 'controller', 'controller', ['currency', 'expensive_above']);
  assert.strictEqual(device.name, 'HVAC Controller');
  assert.deepStrictEqual(device.data, { id: 'controller' });
  assert.deepStrictEqual(device.settings, { currency: 'EUR', expensive_above: 0.2 });
  assert.deepStrictEqual(device.store.priceSource, EXPORT.devices[0].store.priceSource);
  // null and NaN are never set.
  assert.deepStrictEqual(device.store.importedValues, { enum_occupancy: 'home', thermostat_mode: 'heat', is_long_absence: false });

  const zone = migrate.device(EXPORT, 'zone', 'zone-a', ['comfort_offset']);
  assert.deepStrictEqual(zone.store.members, EXPORT.devices[1].store.members);
  assert.strictEqual(zone.store.importedValues['target_temperature.comfort'], 21);
  assert.strictEqual(zone.store.importedValues['target_temperature.eco'], 18.5);
});

test('device throws for a device not in the export or of another driver', () => {
  assert.throws(() => migrate.device(EXPORT, 'zone', 'zone-x', []));
  assert.throws(() => migrate.device(EXPORT, 'spa', 'sauna-1', []));
});

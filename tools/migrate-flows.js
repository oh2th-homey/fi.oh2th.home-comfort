'use strict';

/**
 * Move flows from the old app (fi.oh2th.hvac-control) to this one (issue #36, removed after the move #39): in every
 * standard and advanced flow, old device ids become the imported devices' ids and the old app's URI the new one. Run on
 * a computer after importing the devices (Add device → Import from Smart HVAC Control).
 *
 *   node tools/migrate-flows.js --homey-id <id> [--write] [--backup <file>]       (through the Homey CLI's login)
 *   HOMEY_URL=http://<homey-ip> HOMEY_KEY=<api key> node tools/migrate-flows.js [--write] [--backup <file>]
 *
 * Without --write it only prints what would change (dry run). With --write it first saves every flow as it was to the
 * backup file (default flows-backup-<time>.json), then updates the changed flows. A flow that uses an old device that has
 * no imported device yet is left as it is. Cards the Homey doesn't know after the change are listed: they were broken
 * before too, or the new app doesn't have them. `ownerUri` fields are left alone (Homey doesn't use them).
 * The API key needs the scopes View devices and Flows (View and Manage for --write).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { OLD_APP, newDriver, newData } = require('../lib/migrate');

const NEW_APP = require('../app.json').id;
// Pause between flow updates.
const WRITE_PAUSE_MS = 2000;

/**
 * @description Old Homey device id → new, by driver and data id: { map: { oldId: newId }, missing: [{ id, name }] }
 * (old devices without an imported one).
 * @param {Object[]} devices - Homey Web API devices
 */
function deviceMap(devices) {
  const prefix = (app) => `homey:app:${app}:`;
  const fresh = new Map();
  for (const device of devices) {
    if (device.driverId && device.driverId.startsWith(prefix(NEW_APP))) fresh.set(`${device.driverId.slice(prefix(NEW_APP).length)}/${device.data && device.data.id}`, device.id);
  }
  const map = {};
  const missing = [];
  for (const device of devices) {
    if (!device.driverId || !device.driverId.startsWith(prefix(OLD_APP))) continue;
    const key = `${newDriver(device.driverId.slice(prefix(OLD_APP).length))}/${newData(device.data || {}).id}`;
    if (fresh.has(key)) map[device.id] = fresh.get(key);
    else missing.push({ id: device.id, name: device.name });
  }
  return { map, missing };
}

/**
 * @description A flow (any JSON) with the old device ids and the old app URI replaced in every string but ownerUri.
 * @returns {Object} { value, changes, unmapped } (unmapped: old device ids found that have no new id)
 */
function rewrite(flow, map, oldIds = []) {
  let changes = 0;
  const unmapped = new Set();
  const ids = Object.keys(map);
  const replace = (text) => {
    let out = text;
    for (const id of oldIds) if (!map[id] && out.includes(id)) unmapped.add(id);
    for (const id of ids) {
      if (!out.includes(id)) continue;
      changes += out.split(id).length - 1;
      out = out.split(id).join(map[id]);
    }
    const app = new RegExp(`homey:app:${OLD_APP.replace(/\./g, '\\.')}(?=$|[:|])`, 'g');
    const matches = out.match(app);
    if (matches) {
      changes += matches.length;
      out = out.replace(app, `homey:app:${NEW_APP}`);
    }
    return out;
  };
  const walk = (value, key) => {
    if (key === 'ownerUri') return value;
    if (typeof value === 'string') return replace(value);
    if (Array.isArray(value)) return value.map((item) => walk(item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, k)]));
    return value;
  };
  return { value: walk(flow), changes, unmapped: [...unmapped] };
}

/**
 * @description The card ids of a standard or advanced flow.
 */
function cardIds(flow, advanced) {
  if (advanced) return Object.values(flow.cards || {}).filter((card) => ['trigger', 'condition', 'action'].includes(card.type) && card.id).map((card) => card.id);
  return [flow.trigger, ...(flow.conditions || []), ...(flow.actions || [])].filter((card) => card && card.id).map((card) => card.id);
}

/**
 * @description The parts of a flow to send back: advanced flows their cards, standard flows trigger, conditions, actions.
 */
function update(flow, advanced) {
  if (advanced) return { cards: flow.cards };
  return { trigger: flow.trigger, conditions: flow.conditions, actions: flow.actions };
}

/**
 * @description A Web API client: the Homey CLI (`homey api raw --homey-id`) or HOMEY_URL with a key.
 */
function client(homeyId) {
  if (homeyId) {
    return async (method, apiPath, body) => {
      const args = ['api', 'raw', '--homey-id', homeyId, '--json', '-X', method, '--path', apiPath];
      const base = path.join(os.tmpdir(), `migrate-flows-${process.pid}-${Date.now()}`);
      const bodyFile = `${base}-body.json`;
      const outFile = `${base}-out.json`;
      if (body !== undefined) {
        fs.writeFileSync(bodyFile, JSON.stringify(body));
        args.push('--body', `@${bodyFile}`);
      }
      // The CLI's output goes to a file: through a pipe it is cut off at 64 kB.
      const out = fs.openSync(outFile, 'w');
      try {
        await new Promise((resolve, reject) => {
          const child = spawn('homey', args, { stdio: ['ignore', out, 'pipe'] });
          let err = '';
          child.stderr.on('data', (data) => {
            err += data;
          });
          child.on('error', reject);
          child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${method} ${apiPath}: ${err.trim() || `exit ${code}`}`))));
        });
        const text = fs.readFileSync(outFile, 'utf8');
        return text.trim() ? JSON.parse(text) : null;
      } finally {
        fs.closeSync(out);
        fs.rmSync(bodyFile, { force: true });
        fs.rmSync(outFile, { force: true });
      }
    };
  }
  const { HOMEY_URL, HOMEY_KEY } = process.env;
  if (!HOMEY_URL || !HOMEY_KEY) throw new Error('Give --homey-id <id> (Homey CLI), or set HOMEY_URL and HOMEY_KEY.');
  return async (method, apiPath, body) => {
    const response = await fetch(`${HOMEY_URL.replace(/\/$/, '')}${apiPath}`, {
      method,
      headers: { 'Authorization': `Bearer ${HOMEY_KEY}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (!response.ok) throw new Error(`${method} ${apiPath}: ${response.status} ${await response.text()}`);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  };
}

function option(args, name) {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : null;
}

async function main(args) {
  const write = args.includes('--write');
  const api = client(option(args, '--homey-id'));
  const devices = Object.values(await api('GET', '/api/manager/devices/device/'));
  const { map, missing } = deviceMap(devices);
  const oldIds = devices.filter((d) => d.driverId && d.driverId.startsWith(`homey:app:${OLD_APP}:`)).map((d) => d.id);
  const names = Object.fromEntries(devices.map((d) => [d.id, d.name]));
  console.log(`${Object.keys(map).length} old devices have an imported device${missing.length ? `, ${missing.length} not: ${missing.map((d) => d.name).join(', ')}` : ''}`);

  const known = new Set();
  for (const kind of ['flowcardtrigger', 'flowcardcondition', 'flowcardaction']) {
    for (const card of Object.values(await api('GET', `/api/manager/flow/${kind}/`))) known.add(card.id);
  }

  const flows = [
    ...Object.values(await api('GET', '/api/manager/flow/flow/')).map((flow) => ({ flow, advanced: false })),
    ...Object.values(await api('GET', '/api/manager/flow/advancedflow/')).map((flow) => ({ flow, advanced: true }))
  ];
  const plan = [];
  for (const { flow, advanced } of flows) {
    const { value, changes, unmapped } = rewrite(update(flow, advanced), map, oldIds);
    if (!changes && !unmapped.length) continue;
    // Cards the Homey does not know after the change; "already broken" when the old card was unknown too.
    const before = cardIds(update(flow, advanced), advanced);
    const unknown = cardIds(value, advanced)
      .map((id, i) => (known.has(id) ? null : `${id.split(':').pop()}${known.has(before[i]) ? '' : ' (already broken)'}`))
      .filter(Boolean);
    const label = `${advanced ? 'advanced' : 'standard'} "${flow.name}"${flow.enabled === false ? ' (disabled)' : ''}`;
    if (unmapped.length) {
      console.log(`SKIP ${label}: uses old devices not imported yet: ${unmapped.map((id) => names[id] || id).join(', ')}`);
      continue;
    }
    console.log(`${write ? 'WRITE' : 'would change'} ${label}: ${changes} replacements${unknown.length ? `; unknown cards: ${[...new Set(unknown)].join(', ')}` : ''}`);
    plan.push({ flow, advanced, value });
  }
  console.log(`${plan.length} flows to change`);
  if (!write || !plan.length) return;

  const backup = option(args, '--backup') || `flows-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  fs.writeFileSync(backup, JSON.stringify(flows.map(({ flow, advanced }) => ({ advanced, flow })), null, 1));
  console.log(`Backup of all flows: ${backup}`);
  for (const { flow, advanced, value } of plan) {
    await api('PUT', `/api/manager/flow/${advanced ? 'advancedflow' : 'flow'}/${flow.id}`, value);
    console.log(`written "${flow.name}"`);
    // Homey answers "Too many requests" to fast bursts.
    await new Promise((resolve) => setTimeout(resolve, WRITE_PAUSE_MS));
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}

module.exports = { deviceMap, rewrite, cardIds, update };

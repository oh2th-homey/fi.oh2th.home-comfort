'use strict';

const test = require('node:test');
const assert = require('node:assert');
const sauna = require('../lib/sauna');

const M = 60000;

// Runs minute steps through [{ minutes, power, temperature: (t) => °C, humidity: (t) => % }], t in minutes from 0.
function run(phases, opts = {}) {
  let state = null;
  let t = 0;
  const events = [];
  const learned = [];
  for (const phase of phases) {
    for (let i = 0; i < phase.minutes; i++, t++) {
      const result = sauna.step(state, {
        now: t * M,
        temperature: phase.temperature(t),
        humidity: phase.humidity ? phase.humidity(t) : null,
        power: phase.power === undefined ? null : phase.power,
        readySet: opts.readySet || null,
        learnedReady: opts.learnedReady || null,
        maxHours: opts.maxHours || 4
      });
      state = result.state;
      for (const e of result.events) events.push({ t, e });
      if (result.learned) learned.push(result.learned);
    }
  }
  return { state, events, learned };
}

// A recorded electric session: 16 °C at the start, ~28 °C/h after a few minutes, dry air while it heats.
const heatUp = (t) => Math.min(70, 16 + Math.max(0, t - 6) * 0.47);
const dry = (t) => Math.max(25, 44 - t * 0.23);

test('electric: started on power, ready at the first switch-off, learned ready temperature and rate', () => {
  const { events, learned, state } = run([
    { minutes: 100, power: 6900, temperature: heatUp, humidity: dry },
    { minutes: 5, power: 0, temperature: () => 61, humidity: () => 25 }
  ]);
  assert.deepStrictEqual(
    events.map((e) => e.e),
    ['started', 'ready']
  );
  assert.strictEqual(events[1].t, 100);
  assert.strictEqual(learned.length, 1);
  assert.ok(learned[0].ready > 55 && learned[0].ready <= 70);
  assert.ok(learned[0].rate > 0.3 && learned[0].rate < 0.6, `${learned[0].rate} °C/min`);
  assert.strictEqual(state.phase, 'ready');
});

test('electric: a set ready temperature that comes first counts as ready, without learning', () => {
  const { events, learned } = run([{ minutes: 120, power: 6900, temperature: heatUp, humidity: dry }], { readySet: 56 });
  const ready = events.find((e) => e.e === 'ready');
  assert.ok(ready && ready.t >= 88 && ready.t <= 95, JSON.stringify(ready));
  assert.strictEqual(learned.length, 0);
});

test('bathing before ready: the first löyly (humidity jump) puts it in use, no ready after', () => {
  const { events, state } = run([
    { minutes: 70, power: 6900, temperature: heatUp, humidity: dry },
    { minutes: 30, power: 6900, temperature: heatUp, humidity: () => 40 },
    { minutes: 5, power: 0, temperature: () => 60, humidity: () => 38 }
  ]);
  assert.deepStrictEqual(
    events.map((e) => e.e),
    ['started', 'bathing']
  );
  assert.strictEqual(state.phase, 'in_use');
});

test('electric: off after a long time without power; left on alarm after max hours', () => {
  const { events } = run([
    { minutes: 30, power: 6900, temperature: heatUp },
    { minutes: 50, power: 0, temperature: () => 25 }
  ]);
  assert.deepStrictEqual(
    events.map((e) => e.e),
    ['started', 'off']
  );
  const long = run([{ minutes: 130, power: 6900, temperature: heatUp }], { maxHours: 2, readySet: 200 });
  assert.ok(long.events.some((e) => e.e === 'left_on' && e.t === 120));
});

test('wood: started on the rise, add wood when it stalls, ready at the ready temperature, off when cooled', () => {
  const fire = (t) => {
    if (t < 30) return 15 + t * 0.6; // burning
    if (t < 50) return 33; // stalled: the fire is dying
    return Math.min(75, 33 + (t - 50) * 0.8); // more wood
  };
  const { events } = run([
    { minutes: 100, temperature: fire },
    { minutes: 200, temperature: (t) => Math.max(20, 75 - (t - 100) * 0.4) }
  ]);
  const names = events.map((e) => e.e);
  assert.strictEqual(names[0], 'started');
  assert.ok(names.includes('add_wood'));
  assert.ok(names.indexOf('add_wood') < names.indexOf('ready'));
  assert.strictEqual(names[names.length - 1], 'off');
});

test('electric: a stove cycling within the minute (thermostat) counts as heating, and its first drop as ready', () => {
  let state = null;
  const events = [];
  // Heated for 30 minutes, then the thermostat switches on and off within each minute.
  for (let t = 0; t < 40; t++) {
    const cycling = t >= 30;
    const result = sauna.step(state, { now: t * M, temperature: 30 + t, power: 6900, dropped: cycling, maxHours: 4 });
    state = result.state;
    for (const e of result.events) events.push({ t, e });
  }
  assert.deepStrictEqual(events, [
    { t: 0, e: 'started' },
    { t: 30, e: 'ready' }
  ]);
  // Paired while the stove already cycles: each minute's highest power starts the session.
  const late = sauna.step(null, { now: 0, temperature: 60, power: 6500, dropped: true });
  assert.deepStrictEqual(late.events, ['started']);
});

test('learn: running averages of the ready temperature and rate', () => {
  let m = sauna.learn(null, { ready: 60, rate: 0.45 });
  assert.deepStrictEqual(m, { ready: 60, rate: 0.45, sessions: 1 });
  m = sauna.learn(m, { ready: 70, rate: 0.55 });
  assert.ok(Math.abs(m.ready - 63) < 1e-9);
  assert.strictEqual(m.sessions, 2);
});

test('minutesToReady: from the recent rise, else the learned rate', () => {
  const { state } = run([{ minutes: 60, power: 6900, temperature: heatUp }]);
  const minutes = sauna.minutesToReady(state, { now: 59 * M, temperature: heatUp(59), ready: 56, learnedRate: 0.3 });
  assert.ok(minutes >= 25 && minutes <= 35, `${minutes} min`);
  assert.strictEqual(sauna.minutesToReady(state, { now: 59 * M, temperature: 60, ready: 56 }), 0);
  assert.strictEqual(sauna.readyTemperature(0, null), sauna.DEFAULT_READY);
  assert.strictEqual(sauna.readyTemperature(56, 62), 56);
  assert.strictEqual(sauna.readyTemperature(null, 62), 62);
});

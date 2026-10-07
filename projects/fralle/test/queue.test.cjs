const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { mkdtempSync, mkdirSync, cpSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { resolve, join } = require('node:path');
const plugin = require('../../../board/plugins/fralle');

let messages, events, sent, failure, context, temp;
beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'fralle-unit-'));
  messages = [
    { id: 81, from: 'holminator', text: 'holminator tar förmågan Minnet i Kollegan.' },
    { id: 84, from: 'heimlen', text: 'heimlen tar förmågan Granskaren i Kollegan.' },
    { id: 94, from: 'babtist', text: 'babtist tar förmågan Lotsen.' },
    { id: 110, from: 'fralle', text: 'Fralle tar förmågan Kön.' },
  ];
  events = [];
  sent = [];
  failure = null;
  context = {
    team: 'fralle', dataDir: temp,
    board: {
      query: () => messages,
      events: () => events,
      emit(typ, opts) {
        sent.push({ typ, ...opts });
        if (failure) return { error: failure };
        const handelse = { id: 10000 + sent.length, typ, ts: Date.now(), kvarter: 'fralle', djup: 2, ...opts };
        events.push(handelse);
        return { handelse };
      },
    },
  };
  plugin.init(context);
});
afterEach(() => rmSync(temp, { recursive: true, force: true }));

function question(overrides = {}) {
  const event = {
    id: 100, kvarter: 'surret', djup: 1, typ: 'fråga.ny', ts: Date.now(),
    nyttolast: { fråga: 'Vem bygger minnet?', inlägg: 99, kanal: 'torget' }, ...overrides,
  };
  events.push(event);
  return event;
}

function status(expectedCode = 200) {
  let result;
  const response = { writeHead(code) { assert.equal(code, expectedCode); }, end(body) { result = JSON.parse(body); } };
  assert.equal(plugin.handle({ method: 'GET' }, response, { ...context, path: '/status' }), true);
  return result;
}

function expectError(event, pattern) {
  const original = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args.join(' '));
  try {
    plugin.onEvent(event, context);
    assert.match(status().fel[0].error, pattern);
    assert.match(logs[0], pattern);
  } finally {
    console.error = original;
  }
}

test('prioritizes an external question with recipients, evidence and cause', () => {
  const event = question();
  plugin.onEvent(event, context);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].typ, 'fråga.prioriterad');
  assert.equal(sent[0].orsak, event.id);
  assert.equal(sent[0].styrka, 50);
  assert.equal(sent[0].nyttolast.fråga_id, event.id);
  assert.deepEqual(sent[0].nyttolast.mottagare, ['holminator']);
  assert.deepEqual(sent[0].nyttolast.routning.map(p => [p.team, p.källinlägg]), [['holminator', 81]]);
  assert.equal(sent[0].nyttolast.inlägg, 99);
  assert.equal(sent[0].nyttolast.kanal, 'torget');
  assert.equal(status().kö[0].status, 'väntar');
});

test('routes unknown topics to declared Lotsen, or explicitly leaves recipients empty', () => {
  plugin.onEvent(question({ nyttolast: { fråga: 'Hur bakar jag en fralla?' } }), context);
  assert.equal(sent[0].nyttolast.mottagare[0], 'babtist');
  messages = messages.filter(message => message.from !== 'babtist');
  plugin.onEvent(question({ id: 101, nyttolast: { fråga: 'Hur bakar jag en fralla?' } }), context);
  assert.deepEqual(sent[1].nyttolast.mottagare, []);
  assert.equal(status().kö.length, 2);
});

test('prioritizes direct mentions and recognizes English topics', () => {
  plugin.onEvent(question({ nyttolast: { fråga: '@heimlen can you review the memory source?' } }), context);
  assert.equal(sent[0].nyttolast.mottagare[0], 'heimlen');
  assert.equal(sent[0].nyttolast.mottagare.length, 2);
  assert.equal(sent[0].styrka, 50);
});

test('uses latest self-declarations but not third-party ownership claims', () => {
  messages.push({ id: 120, from: 'holminator', text: 'Vi tar förmågan Mötet.' });
  messages.push({ id: 121, from: 'ledarens-agent', text: 'heimlen tar förmågan Rösten.' });
  plugin.onEvent(question({ nyttolast: { fråga: 'Sammanfatta mötet' } }), context);
  assert.equal(sent[0].nyttolast.routning[0].förmåga, 'Mötet');
  assert.equal(sent[0].nyttolast.routning[0].källinlägg, 120);
  assert.ok(!status().förmågor.some(p => p.team === 'ledarens-agent'));
});

test('first claim wins role conflicts and a later sentence can switch roles', () => {
  messages.push({ id: 86, from: 'marcuslind', text: 'marcuslind tar förmågan Granskaren.' });
  messages.push({ id: 107, from: 'marcuslind', text: 'Vi backar från Granskaren. Vi tar Mötet i stället: sammanfattar en kanal.' });
  messages.sort((a, b) => a.id - b.id);
  const owners = status().förmågor;
  assert.equal(owners.find(item => item.förmåga === 'Granskaren').team, 'heimlen');
  assert.equal(owners.find(item => item.förmåga === 'Mötet').team, 'marcuslind');
  messages.push({ id: 120, from: 'nykomling', text: 'Vi tar förmågan Minnet.' });
  assert.equal(status().förmågor.find(item => item.förmåga === 'Minnet').team, 'holminator');
});

test('urgent questions go first, strength does not change priority, ties are FIFO', () => {
  const now = Date.now();
  plugin.onEvent(question({ id: 101, ts: now - 3000, styrka: 100 }), context);
  plugin.onEvent(question({ id: 102, ts: now - 2000, styrka: 0 }), context);
  plugin.onEvent(question({ id: 103, ts: now - 1000, nyttolast: { fråga: 'Akut: blockerad av API' } }), context);
  assert.deepEqual(status().kö.map(item => item.id), [103, 101, 102]);
  assert.equal(sent[2].nyttolast.prioritet, 80);
  assert.equal(sent[2].nyttolast.köplats, 1);
});

test('ageing makes older normal questions outrank new urgent ones without timer emissions', () => {
  const now = Date.now();
  plugin.onEvent(question({ id: 101, ts: now - 20 * 60000 }), context);
  plugin.onEvent(question({ id: 102, ts: now, nyttolast: { fråga: 'urgent: help' } }), context);
  assert.deepEqual(status().kö.map(item => item.id), [101, 102]);
  assert.equal(status().kö[0].prioritet, 90);
  assert.equal(sent.length, 2);
});

test('answers complete the original question by cause chain', () => {
  const root = question();
  plugin.onEvent(root, context);
  const draft = { id: 200, typ: 'svar.utkast', kvarter: 'mikael', orsak: sent[0].orsak };
  events.push(draft);
  plugin.onEvent({ id: 201, ts: Date.now(), typ: 'svar.klart', kvarter: 'mikael', orsak: draft.id }, context);
  assert.equal(status().kö.length, 0);
  assert.equal(status().besvarade[0].id, root.id);
  assert.equal(status().besvarade[0].svarshändelse, 201);
  assert.equal(sent.length, 1);
});

test('answers complete via explicit question id or unique original message', () => {
  plugin.onEvent(question(), context);
  plugin.onEvent(question({ id: 101, nyttolast: { fråga: 'Vad händer?', inlägg: 98 } }), context);
  plugin.onEvent({ id: 201, ts: Date.now(), typ: 'svar.klart', kvarter: 'mikael', nyttolast: { fråga_id: 100 } }, context);
  plugin.onEvent({ id: 202, ts: Date.now() + 1, typ: 'svar.klart', kvarter: 'mikael', nyttolast: { inlägg: 98 } }, context);
  assert.equal(status().kö.length, 0);
  assert.deepEqual(status().besvarade.map(item => item.id), [101, 100]);
});

test('does not complete multiple questions with ambiguous message linkage', () => {
  plugin.onEvent(question(), context);
  plugin.onEvent(question({ id: 101 }), context);
  plugin.onEvent({ id: 201, ts: Date.now(), typ: 'svar.klart', kvarter: 'mikael', nyttolast: { inlägg: 99 } }, context);
  assert.equal(status().kö.length, 2);
});

test('ignores own, duplicate and unrelated events', () => {
  const root = question();
  plugin.onEvent(root, context);
  plugin.onEvent(root, context);
  plugin.onEvent(question({ id: 110, kvarter: 'fralle' }), context);
  plugin.onEvent({ id: 111, typ: 'svar.utkast', kvarter: 'mikael' }, context);
  assert.equal(sent.length, 1);
});

test('reports missing question or max-depth and does not manufacture a root event', () => {
  expectError(question({ nyttolast: null }), /fråga.ny behöver/);
  expectError(question({ id: 101, djup: 4 }), /Maxdjup/);
  assert.equal(sent.length, 0);
  assert.equal(status().kö.length, 1);
});

test('surfaces rate limits, retains question and does not retry on duplicate notification', () => {
  failure = 'max 6 händelser per minut och kvarter';
  const root = question();
  expectError(root, /max 6/);
  plugin.onEvent(root, context);
  assert.equal(sent.length, 1);
  assert.equal(status().kö.length, 1);
  assert.equal(status().kö[0].prioritetshändelse, undefined);
});

test('keeps payload below exact 2000-character wire limit including escaped input', () => {
  messages = [
    { id: 120, from: 'x'.repeat(40), text: 'Vi tar förmågan Minnet.' },
    { id: 121, from: 'y'.repeat(40), text: 'Vi tar förmågan Granskaren.' },
  ];
  plugin.onEvent(question({ nyttolast: { fråga: 'minnet granska akut "' + '\\\n'.repeat(1000), kanal: 'a'.repeat(30), inlägg: 999 } }), context);
  assert.equal(sent[0].nyttolast.routning.length, 2);
  const wire = JSON.stringify({ typ: sent[0].typ, styrka: sent[0].styrka, nyttolast: sent[0].nyttolast, orsak: sent[0].orsak });
  assert.ok(wire.length <= 2000, `wire payload was ${wire.length} characters`);
});

test('restores queue and deduplication from persistent storage', () => {
  const root = question();
  plugin.onEvent(root, context);
  const previous = status().kö;
  plugin.init(context);
  assert.deepEqual(status().kö, previous);
  plugin.onEvent(root, context);
  assert.equal(sent.length, 1);
  assert.equal(JSON.parse(readFileSync(join(temp, 'queue.json'), 'utf8')).questions.length, 1);
});

test('replays completed answers on restart and keeps latest 20 completions', () => {
  for (let i = 0; i < 25; i++) {
    plugin.onEvent(question({ id: 100 + i }), context);
    const answer = { id: 200 + i, ts: Date.now() + i, typ: 'svar.klart', kvarter: 'mikael', nyttolast: { fråga_id: 100 + i } };
    events.push(answer);
    if (i < 24) plugin.onEvent(answer, context);
  }
  plugin.init(context);
  assert.equal(status().kö.length, 0);
  assert.equal(status().besvarade.length, 20);
  assert.equal(status().besvarade[0].id, 124);
  assert.equal(status().besvarade.at(-1).id, 105);
});

test('caps pending questions at 100 without evicting existing questions', () => {
  for (let i = 0; i < 100; i++) plugin.onEvent(question({ id: 100 + i }), context);
  expectError(question({ id: 200 }), /Kön är full/);
  assert.equal(status().kö.length, 100);
  assert.ok(!status().kö.some(item => item.id === 200));
  assert.equal(sent.length, 100);
});

test('corrupt storage fails explicitly rather than returning an empty healthy queue', () => {
  writeFileSync(join(temp, 'queue.json'), '{broken');
  assert.throws(() => plugin.init(context), SyntaxError);
  assert.ok(status(503).error);
});

test('status is read-only and unknown routes are not handled', () => {
  assert.equal(plugin.handle({ method: 'POST' }, {}, { ...context, path: '/status' }), false);
  assert.equal(plugin.handle({ method: 'GET' }, {}, { ...context, path: '/unknown' }), false);
});

test('real server reacts on bus, serves frontend and persists queue over restart', { timeout: 20000 }, async t => {
  const root = resolve(__dirname, '../../..');
  const directory = mkdtempSync(join(tmpdir(), 'fralle-integration-'));
  const plugins = join(directory, 'plugins');
  mkdirSync(plugins);
  cpSync(join(root, 'board/plugins/fralle'), join(plugins, 'fralle'), { recursive: true });
  let processHandle;
  let logs = '';
  t.after(async () => {
    if (processHandle && processHandle.exitCode === null) {
      const exited = once(processHandle, 'exit');
      processHandle.kill();
      await exited;
    }
    rmSync(directory, { recursive: true, force: true });
  });
  async function start() {
    processHandle = spawn(process.execPath, ['-e', `
      const {server} = require(${JSON.stringify(join(root, 'board/server.js'))});
      server.listen(0, '127.0.0.1', () => console.log('READY ' + server.address().port));
    `], { env: { ...process.env, DATA_DIR: join(directory, 'data'), PLUGINS_DIR: plugins }, stdio: ['ignore', 'pipe', 'pipe'] });
    processHandle.stderr.on('data', chunk => { logs += chunk; });
    return new Promise((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error('Server startup timeout: ' + logs)), 5000);
      processHandle.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${logs}`)); });
      processHandle.stdout.on('data', chunk => {
        const match = chunk.toString().match(/READY (\d+)/);
        if (match) { clearTimeout(timer); resolveReady('http://127.0.0.1:' + match[1]); }
      });
    });
  }
  let base = await start();
  async function post(endpoint, body) {
    const response = await fetch(base + endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 201, await response.clone().text());
    return response.json();
  }
  const claim = await post('/api/messages', { from: 'minneslaget', channel: 'bygge', text: 'Team minneslaget tar förmågan Minnet.' });
  const input = await post('/api/events', { from: 'orat', typ: 'fråga.ny', nyttolast: { fråga: 'Vem bygger minnet?', inlägg: claim.id, kanal: 'bygge' } });
  let result;
  for (let tries = 0; tries < 30; tries++) {
    result = await (await fetch(base + '/t/fralle/status')).json();
    if (result.kö.length) break;
    await new Promise(resolveWait => setTimeout(resolveWait, 20));
  }
  assert.equal(result.kö[0]?.id, input.id, logs);
  assert.equal(result.kö[0].mottagare[0].team, 'minneslaget');
  const bus = await (await fetch(base + '/api/events?typ=' + encodeURIComponent('fråga.prioriterad'))).json();
  assert.equal(bus.length, 1);
  assert.equal(bus[0].djup, 2);
  assert.equal(bus[0].orsak, input.id);
  assert.equal(bus[0].nyttolast.mottagare[0], 'minneslaget');
  assert.equal(bus[0].nyttolast.routning[0].källinlägg, claim.id);
  for (const name of ['', 'app.js', 'style.css']) {
    assert.equal((await fetch(base + '/staden/kvarter/fralle/' + name)).status, 200);
  }
  const exited = once(processHandle, 'exit');
  processHandle.kill();
  await exited;
  base = await start();
  const restored = await (await fetch(base + '/t/fralle/status')).json();
  assert.deepEqual(restored.kö, result.kö);
  await post('/api/events', { from: 'rosten', typ: 'svar.klart', nyttolast: { fråga_id: input.id }, orsak: bus[0].id });
  let completed;
  for (let tries = 0; tries < 30; tries++) {
    completed = await (await fetch(base + '/t/fralle/status')).json();
    if (!completed.kö.length) break;
    await new Promise(resolveWait => setTimeout(resolveWait, 20));
  }
  assert.equal(completed.kö.length, 0);
  assert.equal(completed.besvarade[0].id, input.id);
  assert.equal(logs, '');
});

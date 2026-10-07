const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');

function node(tag = 'div') {
  return {
    tag, textContent: '', children: [],
    append(...items) { this.children.push(...items); },
    replaceChildren(...items) { this.children = items; },
  };
}

async function run(fetcher) {
  const ids = Object.fromEntries(['connection', 'questions', 'completed', 'errors', 'queue-heading', 'capabilities'].map(id => [id, node()]));
  const timers = [];
  vm.runInNewContext(readFileSync(resolve(__dirname, '../../../board/public/staden/kvarter/fralle/app.js'), 'utf8'), {
    document: { getElementById: id => ids[id], createElement: node },
    fetch: fetcher,
    AbortSignal,
    setTimeout: (callback, ms) => timers.push({ callback, ms }),
  });
  await new Promise(resolveTick => setImmediate(resolveTick));
  return { ids, timers };
}

test('renders queue, source links and completions as text, never HTML', async () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const state = {
    förmågor: [{ team: 'minnet', förmåga: 'Minnet', källinlägg: 81 }],
    kö: [{ id: 100, köplats: 1, prioritet: 50, ts: Date.now(), fråga: hostile, frågare: 'Anna', prioritetshändelse: 102,
      mottagare: [{ team: 'minnet', förmåga: 'Minnet', källinlägg: 81, motivering: hostile }],
      motivering: 'Normal prioritet.' }],
    besvarade: [{ fråga: 'Tidigare fråga' }], fel: [],
  };
  const { ids, timers } = await run(async () => ({ ok: true, json: async () => state }));
  assert.match(ids.connection.textContent, /Ansluten/);
  const card = ids.questions.children[0];
  assert.equal(card.children.find(item => item.tag === 'strong').textContent, hostile);
  assert.equal(card.children.find(item => item.tag === 'a').rel, 'noopener');
  assert.equal(ids.completed.children.length, 1);
  assert.match(ids['queue-heading'].textContent, /\(1\)/);
  assert.match(card.children[0].textContent, /Anna/);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 5000);
});

test('HTTP failure is visible and schedules a non-overlapping retry', async () => {
  const { ids, timers } = await run(async () => ({ ok: false, status: 503 }));
  assert.match(ids.connection.textContent, /HTTP 503/);
  assert.equal(ids.connection.className, 'error');
  assert.equal(timers.length, 1);
});

test('bus failures are shown without pretending the pending question was dispatched', async () => {
  const state = {
    förmågor: [], kö: [{ id: 100, köplats: 1, prioritet: 50, ts: Date.now(), fråga: 'Hej', frågare: 'Anna', mottagare: [], motivering: 'Normal' }],
    besvarade: [], fel: [{ orsak: 100, error: 'maxdjup' }],
  };
  const { ids } = await run(async () => ({ ok: true, json: async () => state }));
  assert.match(ids.errors.children[0].textContent, /maxdjup/);
  assert.ok(ids.questions.children[0].children.some(item => /inte skickats/.test(item.textContent)));
});

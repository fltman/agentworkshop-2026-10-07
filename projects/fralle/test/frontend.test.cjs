const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');

function node(tag = 'div') {
  return {
    tag, textContent: '', children: [], value: '', listeners: {},
    append(...items) { this.children.push(...items); },
    replaceChildren(...items) { this.children = items; },
    addEventListener(event, listener) { this.listeners[event] = listener; },
  };
}

async function run(fetcher) {
  const ids = Object.fromEntries([
    'connection', 'questions', 'completed', 'cancelled', 'errors', 'queue-heading',
    'capabilities', 'statistics', 'coordination', 'requester-filter', 'stage-filter',
  ].map(id => [id, node()]));
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

function data(override = {}) {
  const result = { förmågor: [], kö: [], besvarade: [], återkallade: [], fel: [], ...override };
  result.kö = result.kö.map(item => ({
    steg: 'väntar', väntetid_sek: 0, mottagare: [], motivering: 'Normal prioritet',
    senaste_observation: null, utan_framsteg_sek: null, uppmärksamhet: false,
    turförklaring: 'En fråga per frågare och varv.', prioritetsförklaring: 'Bas 50.',
    nästa_steg: 'Inget påbörjat arbete har observerats.',
    utskick: { försök: 1, nästa_försök: null, fel: null }, ...item,
  }));
  result.statistik = {
    aktiva: result.kö.length, väntande: result.kö.length, påbörjade: 0, granskning: 0,
    äldsta_väntetid_sek: 0, frågare: new Set(result.kö.map(item => item.frågare)).size,
    senaste_reservation: null, utan_framsteg: result.kö.filter(item => item.uppmärksamhet).length,
    utan_framsteg_gräns_sek: 300, ...override.statistik,
  };
  return result;
}

test('renders queue, source links and completions as text, never HTML', async () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const state = data({
    förmågor: [{ team: 'minnet', förmåga: 'Minnet', källinlägg: 81 }],
    kö: [{ id: 100, köplats: 1, prioritet: 50, ts: Date.now(), fråga: hostile, frågare: 'Anna', prioritetshändelse: 102,
      mottagare: [{ team: 'minnet', förmåga: 'Minnet', källinlägg: 81, motivering: hostile }],
      motivering: 'Normal prioritet.' }],
    besvarade: [{ fråga: 'Tidigare fråga' }], fel: [],
  });
  const { ids, timers } = await run(async () => ({ ok: true, json: async () => state }));
  assert.match(ids.connection.textContent, /Ansluten/);
  const card = ids.questions.children[0];
  assert.equal(card.children.find(item => item.tag === 'strong').textContent, hostile);
  assert.equal(card.children.find(item => item.tag === 'a').rel, 'noopener');
  assert.equal(ids.completed.children.length, 1);
  assert.match(ids['queue-heading'].textContent, /\(1 av 1\)/);
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
  const state = data({
    förmågor: [], kö: [{ id: 100, köplats: 1, prioritet: 50, ts: Date.now(), fråga: 'Hej', frågare: 'Anna', mottagare: [], motivering: 'Normal' }],
    besvarade: [], fel: [{ orsak: 100, error: 'maxdjup' }],
  });
  const { ids } = await run(async () => ({ ok: true, json: async () => state }));
  assert.match(ids.errors.children[0].textContent, /maxdjup/);
  assert.ok(ids.questions.children[0].children.some(item => /inte skickats/.test(item.textContent)));
});

test('dashboard shows the entire queue, wait times and requester/status filters', async () => {
  const state = data({
    kö: Array.from({ length: 21 }, (_, index) => ({
      id: 100 + index, köplats: index + 1, prioritet: 50, ts: Date.now(), fråga: 'Fråga ' + index,
      frågare: index % 2 ? 'Bo' : 'Anna', steg: index % 3 ? 'väntar' : 'påbörjad', väntetid_sek: 65,
    })),
    statistik: { äldsta_väntetid_sek: 65 },
  });
  const { ids } = await run(async () => ({ ok: true, json: async () => state }));
  assert.equal(ids.questions.children.length, 21);
  assert.match(ids.statistics.textContent, /1 min 5 sek/);
  ids['requester-filter'].value = 'bo';
  ids['requester-filter'].listeners.change();
  assert.equal(ids.questions.children.length, 10);
  assert.ok(ids.questions.children.every(card => /Bo/.test(card.children[0].textContent)));
  ids['stage-filter'].value = 'påbörjad';
  ids['stage-filter'].listeners.change();
  assert.equal(ids.questions.children.length, 3);
  assert.match(ids.coordination.textContent, /fortfarande vägledande/);
});

test('open question details stay open across automatic refreshes', async () => {
  const state = data({
    kö: [{ id: 100, köplats: 1, prioritet: 50, ts: Date.now(), fråga: 'Fråga', frågare: 'Anna' }],
  });

  const { ids, timers } = await run(async () => ({ ok: true, json: async () => state }));
  ids.questions.children[0].open = true;
  ids.questions.children[0].listeners.toggle();
  state.kö[0].väntetid_sek++;
  await timers[0].callback();
  assert.equal(ids.questions.children[0].open, true);
});

test('requester filtering uses the same case-insensitive NFC grouping as the queue', async () => {
  const state = data({
    kö: ['Åsa', 'ÅSA', 'A\u030asa'].map((name, index) => ({
      id: 100 + index, köplats: index + 1, prioritet: 50,
      ts: Date.now(), fråga: 'Fråga', frågare: name,
    })),
  });
  const { ids } = await run(async () => ({ ok: true, json: async () => state }));
  assert.equal(ids['requester-filter'].children.length, 2);
  ids['requester-filter'].value = 'åsa';
  ids['requester-filter'].listeners.change();
  assert.equal(ids.questions.children.length, 3);
});

test('retry schedule, reservation and cancellation history are visible', async () => {
  const state = data({
    kö: [{
      id: 100, köplats: 1, prioritet: 50, ts: Date.now(), fråga: 'Fråga', frågare: 'Anna',
      reservation: { team: 'mikael', till: Date.now() + 120000 },
      utskick: { försök: 1, nästa_försök: Date.now() + 60000, fel: 'max 6 händelser per minut och kvarter' },
    }],
    återkallade: [{ fråga: 'Avbruten', frågare: 'Bo' }],
    statistik: { senaste_reservation: Date.now() },
  });
  const { ids } = await run(async () => ({ ok: true, json: async () => state }));
  assert.ok(ids.questions.children[0].children.some(item => /Nästa försök/.test(item.textContent)));
  assert.ok(ids.questions.children[0].children.some(item => /Reserverad av mikael/.test(item.textContent)));
  assert.match(ids.cancelled.children[0].textContent, /Avbruten/);
  assert.match(ids.coordination.textContent, /använt reservation/);
});

test('stalled rows expose observations and actual queue reasons without diagnosing a fault', async () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const state = data({
    kö: [
      { id: 100, köplats: 1, prioritet: 60, ts: Date.now(), fråga: 'Fråga', frågare: 'Bo',
        uppmärksamhet: true, utan_framsteg_sek: 300, steg: 'väntar på granskning',
        senaste_observation: { id: 200, typ: 'svar.utkast', ts: Date.now(), kvarter: 'mikael' },
        turförklaring: 'Bo går före Anna eftersom Anna fått en senare tur.',
        prioritetsförklaring: hostile },
      { id: 101, köplats: 2, prioritet: 50, ts: Date.now(), fråga: 'Annan', frågare: 'Anna' },
    ],
  });
  const { ids } = await run(async () => ({ ok: true, json: async () => state }));
  const card = ids.questions.children[0];
  assert.equal(card.className, 'stalled');
  assert.match(card.children[0].textContent, /Länge utan framsteg/);
  assert.ok(card.children.some(item => /Bo går före Anna/.test(item.textContent)));
  assert.ok(card.children.some(item => item.textContent === hostile));
  assert.ok(card.children.some(item => /svar.utkast · händelse 200/.test(item.textContent)));
  assert.ok(card.children.some(item => /inte ett bekräftat fel/.test(item.textContent)));
  assert.match(ids.statistics.textContent, /1 utan framsteg i minst 5 min/);
  ids['stage-filter'].value = 'utan-framsteg';
  ids['stage-filter'].listeners.change();
  assert.equal(ids.questions.children.length, 1);
  ids['requester-filter'].value = 'anna';
  ids['requester-filter'].listeners.change();
  assert.match(ids.questions.children[0].textContent, /Inga frågor matchar/);
});

test('unknown historical clocks and local reservations are labelled honestly', async () => {
  const state = data({
    kö: [{ id: 100, köplats: 1, prioritet: 50, ts: Date.now(), fråga: 'Fråga', frågare: 'Anna',
      senaste_observation: { id: null, typ: 'reservation', ts: null, kvarter: 'mikael' } }],
  });
  const { ids } = await run(async () => ({ ok: true, json: async () => state }));
  const card = ids.questions.children[0];
  assert.ok(card.children.some(item => /lokal reservation · tid okänd/.test(item.textContent)));
  assert.ok(card.children.some(item => /ingen säker varningsbedömning/.test(item.textContent)));
  assert.notEqual(card.className, 'stalled');
});

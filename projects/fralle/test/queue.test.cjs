const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { mkdtempSync, mkdirSync, cpSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { resolve, join } = require('node:path');
const { Readable } = require('node:stream');
const plugin = require('../../../board/plugins/fralle');

let messages, events, sent, failure, context, temp, posted;
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
  posted = [];
  context = {
    team: 'fralle', dataDir: temp,
    board: {
      query: () => messages,
      events: () => events,
      post(text, channel, reply_to) {
        posted.push({ text, channel, reply_to });
        return { message: { id: 20000 + posted.length } };
      },
      emit(typ, opts) {
        sent.push({ typ, ...opts });
        if (events.find(event => event.id === opts.orsak)?.djup >= 6) return { error: 'maxdjup 6 nått' };
        if (failure) return { error: failure };
        const handelse = { id: 10000 + sent.length, typ, ts: Date.now(), kvarter: 'fralle', djup: 2, ...opts };
        events.push(handelse);
        return { handelse };
      },
    },
  };
  plugin.init(context);
});
afterEach(() => {
  plugin.stop();
  rmSync(temp, { recursive: true, force: true });
});

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

test('within one requester urgent questions go first, strength is ignored, ties are FIFO', () => {
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
  expectError(question({ id: 101, djup: 6 }), /maxdjup 6/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].orsak, 101);
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
  plugin.onEvent(question({ nyttolast: { fråga: 'minnet granska akut "' + '\\\n'.repeat(1000), frågare: '"'.repeat(40), kanal: 'a'.repeat(30), inlägg: 999 } }), context);
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

function fromRequester(id, name, text = 'Vanlig fråga', ts = Date.now()) {
  return question({ id, ts, nyttolast: { fråga: text, frågare: name } });
}

function answer(id, sequence = 1000 + id) {
  const event = { id: sequence, ts: Date.now(), typ: 'svar.klart', kvarter: 'mikael', nyttolast: { fråga_id: id } };
  events.push(event);
  plugin.onEvent(event, context);
}

test('interleaves frequent requester with other requesters without dropping questions', () => {
  const now = Date.now();
  for (const [id, name] of [[100, 'A'], [101, 'A'], [102, 'A'], [103, 'B'], [104, 'C']]) {
    plugin.onEvent(fromRequester(id, name, 'Vanlig fråga', now + id), context);
  }
  assert.deepEqual(status().kö.map(item => item.id), [100, 103, 104, 101, 102]);
  assert.deepEqual(status().kö.map(item => item.köplats), [1, 2, 3, 4, 5]);
  assert.equal(sent[4].nyttolast.frågare, 'C');
  assert.equal(sent[4].nyttolast.köplats, 3);
  assert.deepEqual(status().kö, status().kö);
});

test('remembering a completed turn prevents frequent requester moving first again', () => {
  const now = Date.now();
  for (const [id, name] of [[100, 'A'], [101, 'A'], [102, 'A'], [103, 'B'], [104, 'C']]) {
    plugin.onEvent(fromRequester(id, name, 'Vanlig fråga', now + id), context);
  }
  answer(100);
  assert.deepEqual(status().kö.map(item => item.id), [103, 104, 101, 102]);
  plugin.onEvent(fromRequester(105, 'A'), context);
  assert.equal(status().kö[0].frågare, 'B');
  answer(103);
  assert.equal(status().kö[0].frågare, 'C');
  answer(104);
  assert.equal(status().kö[0].frågare, 'A');
});

test('urgency only changes selection within the requester’s own turn', () => {
  const now = Date.now();
  plugin.onEvent(fromRequester(100, 'A', 'Vanlig fråga', now), context);
  plugin.onEvent(fromRequester(101, 'A', 'Akut: hjälp', now + 1), context);
  plugin.onEvent(fromRequester(102, 'B', 'Urgent: help', now + 2), context);
  plugin.onEvent(fromRequester(103, 'A', 'Akut: mer hjälp', now + 3), context);
  assert.deepEqual(status().kö.map(item => item.id), [101, 102, 103, 100]);
  answer(101);
  assert.equal(status().kö[0].id, 102);
});

test('requester names are case-insensitive but distinct Swedish names stay distinct', () => {
  const now = Date.now();
  plugin.onEvent(fromRequester(100, 'Åsa', 'Fråga', now), context);
  plugin.onEvent(fromRequester(101, 'ÅSA', 'Fråga', now + 1), context);
  plugin.onEvent(fromRequester(102, 'Asa', 'Fråga', now + 2), context);
  assert.deepEqual(status().kö.map(item => item.id), [100, 102, 101]);
});

test('missing requesters recover the original sender or share one unknown bucket', () => {
  messages.push({ id: 99, from: 'Originalfrågaren', text: '@kollegan hej' });
  plugin.onEvent(question(), context);
  assert.equal(status().kö[0].frågare, 'Originalfrågaren');
  messages.pop();
  const now = Date.now();
  plugin.onEvent(question({ id: 101, ts: now, nyttolast: { fråga: 'Hej' } }), context);
  plugin.onEvent(question({ id: 102, ts: now + 1, nyttolast: { fråga: 'Hej igen' } }), context);
  plugin.onEvent(fromRequester(103, 'B', 'Hej', now + 2), context);
  assert.deepEqual(status().kö.map(item => item.id), [100, 101, 103, 102]);
});

test('turn history survives restart and an old queue is migrated without losing questions', () => {
  const now = Date.now();
  plugin.onEvent(fromRequester(100, 'A', 'Fråga', now), context);
  plugin.onEvent(fromRequester(101, 'A', 'Fråga', now + 1), context);
  plugin.onEvent(fromRequester(102, 'B', 'Fråga', now + 2), context);
  answer(100);
  plugin.init(context);
  assert.deepEqual(status().kö.map(item => item.id), [102, 101]);
  const legacy = JSON.parse(readFileSync(join(temp, 'queue.json'), 'utf8'));
  legacy.version = 1;
  delete legacy.turn;
  delete legacy.served;
  for (const item of legacy.questions) delete item.frågare;
  writeFileSync(join(temp, 'queue.json'), JSON.stringify(legacy));
  plugin.init(context);
  assert.equal(status().kö.length, 2);
  assert.equal(status().besvarade.length, 1);
  assert.ok(status().kö.every(item => item.frågare === '(okänd frågare)'));
  assert.equal(JSON.parse(readFileSync(join(temp, 'queue.json'), 'utf8')).version, 3);
});

test('active requester turn history is not lost after more than 20 answers', () => {
  const now = Date.now();
  plugin.onEvent(fromRequester(100, 'A', 'Fråga', now), context);
  plugin.onEvent(fromRequester(101, 'A', 'Fråga', now + 1), context);
  for (let index = 0; index < 30; index++) {
    plugin.onEvent(fromRequester(200 + index, 'User' + index, 'Fråga', now + 2 + index), context);
  }
  answer(100);
  for (let index = 0; index < 25; index++) answer(200 + index);
  assert.equal(status().besvarade.length, 20);
  assert.equal(status().kö[0].frågare, 'User25');
  plugin.init(context);
  assert.equal(status().kö[0].frågare, 'User25');
});

test('bus owns the updated depth limit: a depth-four question can still be prioritized', () => {
  plugin.onEvent(question({ djup: 4 }), context);
  assert.equal(status().fel.length, 0);
  assert.ok(status().kö[0].prioritetshändelse);
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
  for (let i = 0; i < 100; i++) plugin.onEvent(fromRequester(100 + i, 'User' + Math.floor(i / 10)), context);
  expectError(question({ id: 200 }), /Kön är full/);
  assert.equal(status().kö.length, 100);
  assert.ok(!status().kö.some(item => item.id === 200));
  assert.equal(sent.length, 100);
});

function lifecycle(id, typ, overrides = {}) {
  const event = { id: 30000 + events.length, ts: Date.now(), typ, kvarter: 'mikael', nyttolast: { fråga_id: id }, ...overrides };
  events.push(event);
  plugin.onEvent(event, context);
}

async function api(path, body, method = body ? 'POST' : 'GET') {
  const request = Readable.from(Array.isArray(body) ? body : body ? [typeof body === 'string' ? body : JSON.stringify(body)] : []);
  request.method = method;
  let code, result;
  const response = { writeHead(statusCode) { code = statusCode; }, end(text) { result = JSON.parse(text); } };
  assert.equal(await plugin.handle(request, response, { ...context, path }), true);
  return { code, body: result };
}

function voice() {
  messages.push({ id: 96, from: 'mikael', text: 'mikael tar förmågan Rösten.' });
}

test('attention begins at exactly 300 seconds without emitting or changing fair order', t => {
  let now = 1700000000000;
  t.mock.method(Date, 'now', () => now);
  plugin.onEvent(fromRequester(100, 'Anna'), context);
  plugin.onEvent(fromRequester(101, 'Bo'), context);
  const order = status().kö.map(item => item.id);
  now += 299999;
  assert.equal(status().statistik.utan_framsteg, 0);
  now++;
  const result = status();
  assert.equal(result.statistik.utan_framsteg_gräns_sek, 300);
  assert.equal(result.statistik.utan_framsteg, 2);
  assert.ok(result.kö.every(item => item.uppmärksamhet && item.utan_framsteg_sek === 300));
  assert.deepEqual(result.kö.map(item => item.id), order);
  assert.equal(result.kö[0].senaste_observation.typ, 'fråga.ny');
  assert.equal(sent.length, 2);
  assert.equal(result.fel.length, 0);
});

test('forward progress resets attention, not total question age', t => {
  let now = 1700000000000;
  t.mock.method(Date, 'now', () => now);
  plugin.onEvent(fromRequester(100, 'Anna', 'Fråga', now - 1200000), context);
  assert.equal(status().kö[0].uppmärksamhet, true);
  lifecycle(100, 'minne.träff');
  let item = status().kö[0];
  assert.equal(item.uppmärksamhet, false);
  assert.equal(item.väntetid_sek, 1200);
  assert.equal(item.utan_framsteg_sek, 0);
  now += 300000;
  assert.equal(status().kö[0].uppmärksamhet, true);
  lifecycle(100, 'svar.utkast');
  item = status().kö[0];
  assert.equal(item.uppmärksamhet, false);
  assert.equal(item.framsteg.typ, 'svar.utkast');
  assert.match(item.nästa_steg, /Ingen granskning/);
  lifecycle(100, 'svar.granskat');
  assert.match(status().kö[0].nästa_steg, /inget färdigt svar/);
  answer(100);
  assert.equal(status().statistik.utan_framsteg, 0);
});

test('same or lower stages and delayed observations never hide lack of progress', t => {
  let now = 1700000000000;
  t.mock.method(Date, 'now', () => now);
  plugin.onEvent(fromRequester(100, 'Anna'), context);
  lifecycle(100, 'svar.utkast');
  const progress = status().kö[0].framsteg;
  now += 300000;
  lifecycle(100, 'minne.träff');
  lifecycle(100, 'svar.utkast');
  const latest = status().kö[0].senaste_observation;
  lifecycle(100, 'sammanfattning.klar', { ts: now - 60000 });
  const item = status().kö[0];
  assert.equal(item.steg, 'väntar på granskning');
  assert.equal(item.uppmärksamhet, true);
  assert.deepEqual(item.framsteg, progress);
  assert.deepEqual(item.senaste_observation, latest);
});

test('reservation renewal does not reset the five-minute progress clock', async t => {
  let now = 1700000000000;
  t.mock.method(Date, 'now', () => now);
  voice();
  plugin.onEvent(fromRequester(100, 'Anna'), context);
  await api('/claim', { fråga_id: 100, team: 'mikael' });
  const progress = status().kö[0].framsteg;
  assert.equal(progress.typ, 'reservation');
  assert.equal(progress.id, null);
  for (let minute = 1; minute <= 5; minute++) {
    now += 60000;
    assert.equal((await api('/claim', { fråga_id: 100, team: 'mikael' })).code, 200);
  }
  const item = status().kö[0];
  assert.equal(item.uppmärksamhet, true);
  assert.deepEqual(item.framsteg, progress);
  assert.match(item.turförklaring, /redan reserverad/);
  assert.equal(sent.length, 1);
});

test('progress clock persists without bus history; missing legacy timestamps stay unknown', t => {
  let now = 1700000000000;
  t.mock.method(Date, 'now', () => now);
  plugin.onEvent(fromRequester(100, 'Anna'), context);
  lifecycle(100, 'svar.utkast');
  const progress = status().kö[0].framsteg;
  now += 300000;
  events = [];
  plugin.init(context);
  assert.equal(status().kö[0].uppmärksamhet, true);
  assert.deepEqual(status().kö[0].framsteg, progress);
  const stored = JSON.parse(readFileSync(join(temp, 'queue.json')));
  delete stored.questions[0].framsteg;
  delete stored.questions[0].senaste_observation;
  writeFileSync(join(temp, 'queue.json'), JSON.stringify(stored));
  plugin.init(context);
  const legacy = status().kö[0];
  assert.equal(legacy.utan_framsteg_sek, null);
  assert.equal(legacy.uppmärksamhet, false);
  assert.equal(legacy.senaste_observation, null);
});

test('repeated expired reservations cannot hide a question that makes no forward progress', async t => {
  let now = 1700000000000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(console, 'error', () => {});
  voice();
  plugin.onEvent(fromRequester(100, 'Anna'), context);
  await api('/claim', { fråga_id: 100, team: 'mikael' });
  const progress = status().kö[0].framsteg;
  for (let attempt = 0; attempt < 2; attempt++) {
    now += 120000;
    assert.equal((await api('/claim', { fråga_id: 100, team: 'mikael' })).code, 200);
  }
  now += 60000;
  const item = status().kö[0];
  assert.equal(item.uppmärksamhet, true);
  assert.deepEqual(item.framsteg, progress);
  assert.equal(item.senaste_observation.ts, now - 60000);
  assert.equal(JSON.parse(readFileSync(join(temp, 'queue.json'))).turn, 3);
});

test('fair explanations use real turns, requester rounds and priority ageing', t => {
  const now = 1700000000000;
  t.mock.method(Date, 'now', () => now);
  plugin.onEvent(fromRequester(100, 'Anna', 'Normal', now - 900000), context);
  plugin.onEvent(fromRequester(101, 'Anna', 'Akut', now - 900000), context);
  plugin.onEvent(fromRequester(102, 'Bo', 'Normal', now - 900000), context);
  plugin.onEvent(fromRequester(103, 'Bo', 'Normal', now - 900000), context);
  let items = status().kö;
  assert.deepEqual(items.map(item => item.id), [101, 102, 100, 103]);
  assert.deepEqual(items.map(item => item.varv), [1, 1, 2, 2]);
  assert.match(items[0].turförklaring, /Anna går före Bo.*äldsta väntande frågan/);
  assert.match(items[0].prioritetsförklaring, /Prioritet 99: bas 80 \+ 30 väntetidspoäng/);
  assert.match(items[0].prioritetsförklaring, /inom Annas egen kö/);
  answer(101);
  items = status().kö;
  assert.equal(items[0].id, 102);
  assert.match(items[0].turförklaring, /Bo går före Anna.*ännu inte fått en registrerad tur/);
  answer(102);
  items = status().kö;
  assert.equal(items[0].id, 100);
  assert.match(items[0].turförklaring, /Anna går före Bo.*senaste registrerade tur tidigare/);
});

test('corrupt progress history is surfaced as unavailable storage', () => {
  plugin.onEvent(question(), context);
  const stored = JSON.parse(readFileSync(join(temp, 'queue.json')));
  stored.questions[0].framsteg.ts = 'not a timestamp';
  writeFileSync(join(temp, 'queue.json'), JSON.stringify(stored));
  assert.throws(() => plugin.init(context), /Ogiltig framstegshistorik/);
  assert.match(status(503).error, /Ogiltig framstegshistorik/);
});

test('per-requester limit includes processing questions and leaves capacity for others', () => {
  for (let i = 0; i < 10; i++) plugin.onEvent(fromRequester(100 + i, 'Anna'), context);
  lifecycle(100, 'minne.träff');
  expectError(fromRequester(110, 'ANNA'), /Max 10 aktiva/);
  plugin.onEvent(fromRequester(111, 'Bo'), context);
  assert.equal(status().kö.length, 11);
  answer(100);
  plugin.onEvent(fromRequester(112, 'Anna'), context);
  assert.equal(status().kö.filter(item => item.frågare === 'Anna').length, 10);
});

test('lifecycle status follows observed events without moving backwards', () => {
  plugin.onEvent(question({ ts: Date.now() - 65000 }), context);
  assert.equal(status().statistik.äldsta_väntetid_sek, 65);
  lifecycle(100, 'minne.träff');
  assert.equal(status().kö[0].steg, 'påbörjad');
  lifecycle(100, 'svar.utkast');
  assert.equal(status().kö[0].steg, 'väntar på granskning');
  lifecycle(100, 'minne.träff');
  assert.equal(status().kö[0].steg, 'väntar på granskning');
  assert.equal(status().statistik.granskning, 1);
  lifecycle(100, 'svar.granskat');
  assert.equal(status().kö[0].steg, 'granskat');
  answer(100);
  assert.equal(status().besvarade[0].steg, 'besvarad');
});

test('explicit completed question id never closes a different question sharing a message', () => {
  plugin.onEvent(question(), context);
  answer(100);
  plugin.onEvent(question({ id: 101 }), context);
  plugin.onEvent({ id: 900, typ: 'svar.klart', kvarter: 'mikael', nyttolast: { fråga_id: 100, inlägg: 99 } }, context);
  assert.equal(status().kö[0].id, 101);
});

test('traffic-limited emit retries only after 60 seconds and clears error on success', t => {
  t.mock.method(console, 'error', () => {});
  failure = 'max 6 händelser per minut och kvarter';
  plugin.onEvent(question(), context);
  const due = status().kö[0].utskick.nästa_försök;
  plugin.tick(context, due - 1);
  assert.equal(sent.length, 1);
  failure = null;
  plugin.tick(context, due);
  assert.equal(sent.length, 2);
  assert.equal(status().kö[0].utskick.fel, null);
  assert.equal(status().kö[0].utskick.nästa_försök, null);
  assert.ok(status().kö[0].prioritetshändelse);
  assert.ok(sent.every(item => item.orsak === 100));
});

test('retry state survives restart and stops after exactly three retries', t => {
  t.mock.method(console, 'error', () => {});
  failure = 'max 6 händelser per minut och kvarter';
  plugin.onEvent(question(), context);
  const originalDue = status().kö[0].utskick.nästa_försök;
  plugin.init(context);
  assert.equal(status().kö[0].utskick.nästa_försök, originalDue);
  for (let i = 0; i < 3; i++) plugin.tick(context, status().kö[0].utskick.nästa_försök);
  plugin.tick(context, originalDue + 600000);
  assert.equal(sent.length, 4);
  assert.equal(status().kö[0].utskick.försök, 4);
  assert.equal(status().kö[0].utskick.nästa_försök, null);
});

test('permanent rejection and unexpected emitter exception never schedule retries', t => {
  t.mock.method(console, 'error', () => {});
  failure = 'orsak: okänt händelse-id';
  plugin.onEvent(question(), context);
  assert.equal(status().kö[0].utskick.nästa_försök, null);
  context.board.emit = () => { throw new Error('oväntat fel'); };
  plugin.onEvent(question({ id: 101 }), context);
  assert.equal(status().kö.find(item => item.id === 101).utskick.nästa_försök, null);
  plugin.tick(context, Date.now() + 600000);
  assert.equal(sent.length, 1);
});

test('completion or cancellation stops scheduled retries', t => {
  t.mock.method(console, 'error', () => {});
  failure = 'max 6 händelser per minut och kvarter';
  plugin.onEvent(fromRequester(100, 'Anna'), context);
  plugin.onEvent(fromRequester(101, 'Anna'), context);
  answer(100);
  plugin.onMessage({ id: 901, ts: Date.now(), from: 'Anna', channel: 'torget', text: '@fralle återkalla 101' }, context);
  plugin.tick(context, Date.now() + 600000);
  assert.equal(sent.length, 2);
  assert.equal(status().kö.length, 0);
  assert.equal(status().återkallade[0].id, 101);
});

test('only the requester can cancel a waiting question; processing questions are protected', () => {
  plugin.onEvent(fromRequester(100, 'Anna'), context);
  const cancel = from => plugin.onMessage({ id: 901, ts: Date.now(), from, channel: 'torget', text: '@fralle cancel 100' }, context);
  cancel('Bo');
  assert.equal(status().kö.length, 1);
  assert.match(posted.at(-1).text, /eget angivna/);
  lifecycle(100, 'svar.utkast');
  cancel('Anna');
  assert.equal(status().kö.length, 1);
  assert.match(posted.at(-1).text, /börjat behandlas/);
  plugin.onEvent(fromRequester(101, 'Anna'), context);
  plugin.onMessage({ id: 902, ts: Date.now(), from: 'ANNA', channel: 'torget', text: '@fralle återkalla 101' }, context);
  assert.equal(status().återkallade[0].id, 101);
  assert.equal(posted.at(-1).reply_to, 902);
});

test('claim enforces current fair head, single reservation and idempotent renewal', async () => {
  voice();
  const now = Date.now();
  plugin.onEvent(fromRequester(100, 'A', 'Fråga', now), context);
  plugin.onEvent(fromRequester(101, 'A', 'Fråga', now + 1), context);
  plugin.onEvent(fromRequester(102, 'B', 'Fråga', now + 2), context);
  assert.equal((await api('/claim', { fråga_id: 102, team: 'mikael' })).code, 409);
  const results = await Promise.all([
    api('/claim', { fråga_id: 100, team: 'mikael' }),
    api('/claim', { fråga_id: 102, team: 'mikael' }),
  ]);
  assert.deepEqual(results.map(result => result.code), [200, 409]);
  assert.equal((await api('/next')).body.upptagen, true);
  assert.equal((await api('/claim', { fråga_id: 100, team: 'mikael' })).code, 200);
  const savedTurn = JSON.parse(readFileSync(join(temp, 'queue.json'), 'utf8')).turn;
  answer(100);
  assert.equal(JSON.parse(readFileSync(join(temp, 'queue.json'), 'utf8')).turn, savedTurn);
  assert.equal((await api('/next')).body.fråga.id, 102);
});

test('reservation survives restart and expiration restores fair selection', async t => {
  t.mock.method(console, 'error', () => {});
  voice();
  plugin.onEvent(fromRequester(100, 'A'), context);
  plugin.onEvent(fromRequester(101, 'B'), context);
  const result = await api('/claim', { fråga_id: 100, team: 'mikael' });
  plugin.init(context);
  assert.equal((await api('/next')).body.upptagen, true);
  plugin.tick(context, result.body.reservation.till);
  assert.equal((await api('/next')).body.fråga.id, 101);
  assert.equal(status().kö.find(item => item.id === 100).reservation, undefined);
});

test('claim validates JSON, size, team and unavailable storage explicitly', async () => {
  plugin.onEvent(question(), context);
  assert.equal((await api('/claim', 'broken', 'POST')).code, 400);
  assert.equal((await api('/claim', 'x'.repeat(4097), 'POST')).code, 413);
  assert.equal((await api('/claim', { fråga_id: 0, team: 'mikael' })).code, 400);
  assert.equal((await api('/claim', { fråga_id: 100, team: 'mikael' })).code, 503);
  voice();
  assert.equal((await api('/claim', { fråga_id: 100, team: 'annan' })).code, 403);
  writeFileSync(join(temp, 'queue.json'), 'broken');
  assert.throws(() => plugin.init(context));
  assert.equal((await api('/claim', { fråga_id: 100, team: 'mikael' })).code, 503);
});

test('UTF-8 claim fields survive a split inside a multibyte character', async () => {
  voice();
  plugin.onEvent(question(), context);
  const buffer = Buffer.from(JSON.stringify({ fråga_id: 100, team: 'mikael' }));
  const split = buffer.indexOf(Buffer.from('å')) + 1;
  assert.equal((await api('/claim', [buffer.subarray(0, split), buffer.subarray(split)])).code, 200);
});

test('missing or malformed bus acknowledgements fail explicitly without retries', t => {
  t.mock.method(console, 'error', () => {});
  for (const [index, acknowledgement] of [undefined, null, {}, { handelse: {} }].entries()) {
    t.mock.method(context.board, 'emit', () => acknowledgement);
    plugin.onEvent(question({ id: 100 + index }), context);
    const item = status().kö.find(entry => entry.id === 100 + index);
    assert.equal(item.prioritetshändelse, undefined);
    assert.equal(item.utskick.nästa_försök, null);
    assert.match(item.utskick.fel, /ingen giltig händelse/);
  }
});

test('a new reservation after expiration consumes a fresh fair turn', async t => {
  t.mock.method(console, 'error', () => {});
  voice();
  plugin.onEvent(fromRequester(100, 'A'), context);
  plugin.onEvent(fromRequester(101, 'B'), context);
  plugin.onEvent(fromRequester(102, 'B'), context);
  let reservation = await api('/claim', { fråga_id: 100, team: 'mikael' });
  plugin.tick(context, reservation.body.reservation.till);
  reservation = await api('/claim', { fråga_id: 101, team: 'mikael' });
  answer(101);
  reservation = await api('/claim', { fråga_id: 100, team: 'mikael' });
  plugin.tick(context, reservation.body.reservation.till);
  assert.equal((await api('/next')).body.fråga.id, 102);
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

test('real HTTP queue reserves fair turns, tracks lifecycle and persists cancellation over restart', { timeout: 20000 }, async t => {
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
  async function read(endpoint) {
    const response = await fetch(base + endpoint);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  }
  async function reserve(id, code = 200, team = 'mikael') {
    const response = await fetch(base + '/t/fralle/claim', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fråga_id: id, team }),
    });
    assert.equal(response.status, code, await response.clone().text());
    return response.json();
  }
  async function until(endpoint, condition) {
    let value;
    for (let tries = 0; tries < 30; tries++) {
      value = await read(endpoint);
      if (condition(value)) return value;
      await new Promise(resolveWait => setTimeout(resolveWait, 20));
    }
    assert.fail('Condition not reached: ' + JSON.stringify(value));
  }
  const claim = await post('/api/messages', { from: 'minneslaget', channel: 'bygge', text: 'Team minneslaget tar förmågan Minnet.' });
  await post('/api/messages', { from: 'mikael', channel: 'bygge', text: 'Vi tar Rösten.' });
  const input = await post('/api/events', { from: 'orat', typ: 'fråga.ny', nyttolast: { fråga: 'Vem bygger minnet?', frågare: 'Anna', inlägg: claim.id, kanal: 'bygge' } });
  let result;
  for (let tries = 0; tries < 30; tries++) {
    result = await (await fetch(base + '/t/fralle/status')).json();
    if (result.kö.length) break;
    await new Promise(resolveWait => setTimeout(resolveWait, 20));
  }
  assert.equal(result.kö[0]?.id, input.id, logs);
  assert.equal(result.kö[0].mottagare[0].team, 'minneslaget');
  assert.equal(result.statistik.utan_framsteg_gräns_sek, 300);
  assert.equal(result.kö[0].uppmärksamhet, false);
  assert.equal(result.kö[0].framsteg.id, input.id);
  assert.match(result.kö[0].turförklaring, /Varv 1/);
  assert.match(result.kö[0].prioritetsförklaring, /inom Annas egen kö/);
  const bus = await (await fetch(base + '/api/events?typ=' + encodeURIComponent('fråga.prioriterad'))).json();
  assert.equal(bus.length, 1);
  assert.equal(bus[0].djup, 2);
  assert.equal(bus[0].orsak, input.id);
  assert.equal(bus[0].nyttolast.frågare, 'Anna');
  assert.equal(bus[0].nyttolast.mottagare[0], 'minneslaget');
  assert.equal(bus[0].nyttolast.routning[0].källinlägg, claim.id);
  for (const name of ['', 'app.js', 'style.css']) {
    assert.equal((await fetch(base + '/staden/kvarter/fralle/' + name)).status, 200);
  }
  const another = await post('/api/events', { from: 'orat', typ: 'fråga.ny', nyttolast: { fråga: 'En fråga till', frågare: 'Anna' } });
  const otherRequester = await post('/api/events', { from: 'orat', typ: 'fråga.ny', nyttolast: { fråga: 'Min fråga', frågare: 'Bo' } });
  const withdrawn = await post('/api/events', { from: 'orat', typ: 'fråga.ny', nyttolast: { fråga: 'Kan återkallas', frågare: 'Clara' } });
  await until('/t/fralle/status', value => value.kö.length === 4);
  const rejected = await post('/api/messages', { from: 'Malin', channel: 'torget', text: '@fralle cancel ' + withdrawn.id });
  await until('/api/messages?channel=torget', messages => messages.some(message => message.reply_to === rejected.id && message.text.includes('bara återkalla')));
  assert.equal((await read('/t/fralle/status')).kö.length, 4);
  const cancelled = await post('/api/messages', { from: 'CLARA', channel: 'torget', text: '@fralle återkalla ' + withdrawn.id });
  await until('/api/messages?channel=torget', messages => messages.some(message => message.reply_to === cancelled.id && message.text.includes('är återkallad')));
  result = await until('/t/fralle/status', value => value.återkallade.length === 1);
  assert.deepEqual(result.kö.map(item => item.id), [input.id, otherRequester.id, another.id]);
  assert.equal((await read('/t/fralle/next')).fråga.id, input.id);
  await reserve(another.id, 409);
  await reserve(input.id, 403, 'annan');
  await reserve(input.id);
  await reserve(otherRequester.id, 409);
  assert.deepEqual(await read('/t/fralle/next'), { fråga: null, upptagen: true });
  const draft = await post('/api/events', { from: 'mikael', typ: 'svar.utkast', nyttolast: { fråga_id: input.id }, orsak: bus[0].id });
  result = await until('/t/fralle/status', value => value.kö.find(item => item.id === input.id)?.steg === 'väntar på granskning');
  assert.equal(result.kö.find(item => item.id === input.id).framsteg.id, draft.id);
  const exited = once(processHandle, 'exit');
  processHandle.kill();
  await exited;
  base = await start();
  const restored = await (await fetch(base + '/t/fralle/status')).json();
  assert.deepEqual(restored.kö.map(({ väntetid_sek, utan_framsteg_sek, ...item }) => item),
    result.kö.map(({ väntetid_sek, utan_framsteg_sek, ...item }) => item));
  assert.deepEqual(restored.återkallade, result.återkallade);
  assert.deepEqual(await read('/t/fralle/next'), { fråga: null, upptagen: true });
  const review = await post('/api/events', { from: 'granskaren', typ: 'svar.granskat', nyttolast: { fråga_id: input.id }, orsak: draft.id });
  await until('/t/fralle/status', value => value.kö.find(item => item.id === input.id)?.steg === 'granskat');
  await post('/api/events', { from: 'mikael', typ: 'svar.klart', nyttolast: { fråga_id: input.id }, orsak: review.id });
  await until('/t/fralle/status', value => value.besvarade.length === 1);
  assert.equal((await read('/t/fralle/next')).fråga.id, otherRequester.id);
  await reserve(otherRequester.id);
  await post('/api/events', { from: 'mikael', typ: 'svar.klart', nyttolast: { fråga_id: otherRequester.id } });
  await until('/t/fralle/status', value => value.besvarade.length === 2);
  assert.equal((await read('/t/fralle/next')).fråga.id, another.id);
  await reserve(another.id);
  await post('/api/events', { from: 'mikael', typ: 'svar.klart', nyttolast: { fråga_id: another.id } });
  const completed = await until('/t/fralle/status', value => !value.kö.length);
  assert.equal(completed.kö.length, 0);
  assert.deepEqual(new Set(completed.besvarade.map(item => item.id)), new Set([input.id, otherRequester.id, another.id]));
  assert.deepEqual(await read('/t/fralle/next'), { fråga: null, upptagen: false });
  assert.equal(logs, '');
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const plugin = require('../../board/plugins/tomhol');

function setup() {
  const sent = [];
  const messages = [];
  const ctx = {
    team: 'tomhol', path: '/status',
    board: {
      query: ({ channel }) => messages.filter(m => m.channel === channel),
      emit: (typ, opts) => {
        sent.push({ typ, ...opts });
        return { handelse: { id: sent.length } };
      },
    },
  };
  function message(text, offset = 0, channel = 'bygge') {
    messages.push({ id: messages.length + 1, text, channel, ts: Date.now() + offset });
  }
  function event(overrides = {}) {
    plugin.onEvent({
      id: 123, typ: 'puls.tempo', kvarter: 'team-martin', djup: 1, styrka: 42,
      nyttolast: { hetaste: 'bygge', ord: 'igång', fönster_min: 5 },
      ...overrides,
    }, ctx);
  }
  function status() {
    let body;
    const res = { writeHead: code => assert.equal(code, 200), end: text => { body = JSON.parse(text); } };
    assert.equal(plugin.handle({ method: 'GET' }, res, ctx), true);
    return body;
  }
  return { sent, messages, ctx, message, event, status };
}

test('Swedish/English signals, overlapping categories, negations and sources', () => {
  const s = setup();
  s.message('Hur går det? Tack, tack! Jag har fastnat.');
  s.message('Thanks! Why is it blocked?');
  s.message('Jag har inte fastnat. I am not stuck. Vi är inte längre blockerad.');
  s.message('Det fungerar inte.');
  s.message('unblocked thankfully');
  s.event();
  const payload = s.sent[0].nyttolast;
  assert.deepEqual(payload.signaler, { fragor: 2, hinder: 3, uppskattning: 2, omtanke: 0 });
  assert.equal(payload.antalInlagg, 5);
  assert.equal(payload.kallor.filter(k => k.inlagg === 1 && k.signal === 'uppskattning').length, 1);
  assert.equal(payload.kallor.some(k => k.inlagg === 3 && k.signal === 'hinder'), false);
  assert.equal(s.sent[0].typ, 'stämning.byte');
  assert.equal(s.sent[0].orsak, 123);
  assert.equal('styrka' in s.sent[0], false);
  assert.equal(Date.parse(payload.fonster.till) - Date.parse(payload.fonster.fran), 600000);
});

test('latest 20 messages, stale/future and other channels excluded', () => {
  const s = setup();
  s.message('blocked', -600001);
  s.message('blocked', 60000);
  s.message('blocked', 0, 'hjälp');
  for (let i = 0; i < 25; i++) s.message('Thanks');
  s.event();
  assert.equal(s.sent[0].nyttolast.antalInlagg, 20);
  assert.deepEqual(s.sent[0].nyttolast.signaler, { fragor: 0, hinder: 0, uppskattning: 20, omtanke: 0 });
});

test('maximum sample fits the actual bus message length limit', () => {
  const s = setup();
  for (let i = 0; i < 20; i++) s.message('Why? does not work. Thank you. Ta den tid du behöver.');
  s.event();
  assert.equal(s.sent[0].nyttolast.kallor.length, 6);
  assert.deepEqual(s.sent[0].nyttolast.signaler, { fragor: 20, hinder: 20, uppskattning: 20, omtanke: 20 });
  assert.ok(JSON.stringify({ ...s.sent[0], styrka: null }).length <= 2000);
  assert.match(s.sent[0].nyttolast.rad, /20 frågor, 20 hinder, 20 uppskattningar och 20 uttryck av omtanke\./);
});

test('payload carries a readable rad first, with Swedish singular/plural and no raw JSON', () => {
  const s = setup();
  s.message('Varför? Tack!');
  s.message('Hej');
  s.event();
  const payload = s.sent[0].nyttolast;
  assert.equal(Object.keys(payload)[0], 'rad');
  assert.match(payload.rad, /^I #\S+ de senaste 10 minuterna \(2 inlägg\): 1 fråga och 1 uppskattning\. Det är språksignaler, inte känslor\.$/);
  assert.doesNotMatch(payload.rad, /[{}"]/);
});

test('expressed care: Swedish/English support phrases and hearts, once per message', () => {
  const s = setup();
  s.message('Hoppas det löser sig! Ta den tid du behöver. ❤️ ❤️');
  s.message('Jag finns här. Vi finns här.');
  s.message("Hope it works out. Take your time. I'm here for you.");
  s.message('I am here for you. We are here for you.');
  s.message('❤ ♥️');
  s.message('Vanlig text utan omtankeuttryck.');
  s.event();
  assert.equal(s.sent[0].nyttolast.signaler.omtanke, 5);
  assert.ok(s.sent[0].nyttolast.kallor.some(k => k.signal === 'omtanke'));
});

test('negated care and unrelated emoji are not positive care signals', () => {
  const s = setup();
  s.message('Inte jag finns här. Not here for you. Do not take your time.');
  s.message('Vi bygger nu. 😀 🚧 ❓ 🙌 heartless');
  s.event();
  assert.equal(s.sent[0].nyttolast.signaler.omtanke, 0);
});

test('no evidence is not calm; no rule matches are reported explicitly', () => {
  const s = setup();
  s.event();
  assert.equal(s.sent.length, 0);
  assert.equal(s.status().kanaler[0].status, 'inget underlag');
  s.message('Vi bygger nu.');
  s.event();
  assert.equal(s.status().kanaler[0].status, 'inga kända språksignaler');
});

test('puls.tryck uses kanal and depth four only updates the view', () => {
  const s = setup();
  s.message('stuck', 0, 'hjälp');
  s.event({ typ: 'puls.tryck', djup: 4, nyttolast: { kanal: 'hjälp', ord: 'igång' } });
  assert.equal(s.sent.length, 0);
  assert.equal(s.status().kanaler[0].kanal, 'hjälp');
  assert.match(s.status().kanaler[0].utskick, /maxdjup/);
  s.event({ typ: 'puls.tryck', djup: 2, nyttolast: { kanal: 'hjälp' } });
  assert.equal(s.sent[0].nyttolast.kanal, 'hjälp');
});

test('only confirmed sender/types are consumed; malformed events produce explicit errors', () => {
  const s = setup();
  s.message('thanks');
  s.event({ kvarter: 'tomhol' });
  s.event({ kvarter: 'other-team' });
  s.event({ typ: 'fråga.ny' });
  assert.equal(s.status().kanaler.length, 0);
  s.event({ nyttolast: { hetaste: null, ord: 'stilla', kanaler: [] } });
  s.event({ nyttolast: {} });
  assert.equal(s.status().fel, null);
  assert.equal(s.status().kanaler.length, 0);
  s.event({ nyttolast: { hetaste: '#bygge' } });
  assert.match(s.status().fel, /Ogiltig/);
  assert.equal(s.sent.length, 0);
  s.event({ nyttolast: { hetaste: 'kollegan-events' } });
  assert.equal(s.sent.length, 0);
});

test('deduplication, global rate limiting and retry on the next Pulse', t => {
  t.mock.method(Date, 'now', () => 1800000000000);
  const s = setup();
  s.message('thanks');
  s.event();
  for (let i = 1; i < 6; i++) {
    t.mock.method(Date, 'now', () => 1800000000000 + i * 10001);
    s.event();
    assert.equal(s.sent.length, i);
    s.message('thanks');
    s.event();
    assert.equal(s.sent.length, i + 1);
  }
  s.message('blocked');
  s.event();
  assert.equal(s.sent.length, 6);
  assert.match(s.status().kanaler[0].utskick, /begränsat/);
  t.mock.method(Date, 'now', () => 1800000061000);
  s.event();
  assert.equal(s.sent.length, 7);
});

test('rejected and thrown emits are visible, logged, and do not suppress retry', () => {
  const s = setup();
  s.message('thanks');
  s.ctx.board.emit = () => ({ error: 'rate limited' });
  s.event();
  assert.match(s.status().fel, /rate limited/);
  assert.equal(s.status().kanaler[0].utskick, 'fel');
  s.ctx.board.emit = () => { throw new Error('offline'); };
  s.event();
  assert.match(s.status().fel, /offline/);
  s.ctx.board.emit = () => ({ handelse: { id: 999 } });
  s.event();
  assert.equal(s.status().fel, null);
  assert.equal(s.status().kanaler[0].utskick, 'skickat');
});

test('route does not intercept other methods or paths; contexts are isolated', () => {
  const s = setup();
  assert.equal(plugin.handle({ method: 'POST' }, {}, s.ctx), false);
  assert.equal(plugin.handle({ method: 'GET' }, {}, { ...s.ctx, path: '/other' }), false);
  s.message('thanks');
  s.event();
  assert.equal(setup().status().kanaler.length, 0);
  let status;
  plugin.handle({ method: 'GET' }, {
    writeHead() {},
    end(text) { status = JSON.parse(text); },
  }, { ...s.ctx });
  assert.equal(status.kanaler.length, 1);
});

test('automated replies and our own posts are not counted; sharper questions; wider obstacles', () => {
  const s = setup();
  const push = (text, from) => s.messages.push({ id: s.messages.length + 1, text, from, channel: 'bygge', ts: Date.now() });
  push('Kollegan: @x, vem bygger kön? fralle bygger Kön.', 'mikael');
  push('Lotsen: Kollegan är inte säker här. Tack!', 'babtist');
  push('PR inne från tomhol: Bra jobbat alla', 'tomhol');
  push('Vi kör när en fråga kommer, och hur det går vet vi sen.', 'a');
  push('@kollegan vem bygger minnet', 'b');
  push('Vad gör vi nu.', 'c');
  push('Jag sitter fast med bygget, testet failar och det blir timeout.', 'd');
  push('Det går inte att deploya.', 'e');
  s.event();
  const p = s.sent[0].nyttolast;
  assert.equal(p.antalInlagg, 5);
  assert.deepEqual(p.signaler, { fragor: 2, hinder: 2, uppskattning: 0, omtanke: 0 });
  assert.deepEqual(p.kallor.filter(k => k.signal === 'fragor').map(k => k.uttryck), ['vem', 'Vad']);
  assert.equal(p.kallor.find(k => k.inlagg === 7).uttryck, 'sitter fast');
});

test('non-conversation channels are skipped without errors', () => {
  const s = setup();
  s.message('Tack! ❤️', 0, 'stadens-saga');
  s.message('Tack!', 0, 'radio');
  s.event({ nyttolast: { hetaste: 'stadens-saga' } });
  s.event({ id: 124, typ: 'puls.tryck', nyttolast: { kanal: 'radio' } });
  assert.equal(s.sent.length, 0);
  const status = s.status();
  assert.equal(status.fel, null);
  assert.equal(status.kanaler.length, 0);
});

test('rad reports the trend against the previous assessment', t => {
  let now = 1800000000000;
  t.mock.method(Date, 'now', () => now);
  const s = setup();
  s.message('Hur gör man?');
  s.event();
  assert.doesNotMatch(s.sent[0].nyttolast.rad, /Jämfört|Oförändrat/);
  now += 11000;
  s.message('Varför då?');
  s.message('Det går inte.');
  s.event({ id: 124 });
  assert.match(s.sent[1].nyttolast.rad, /Jämfört med förra bedömningen: frågor 1→2, hinder 0→1\./);
  assert.ok(JSON.stringify(s.sent[1]).length <= 2000);
});

test('pause and resume via @tomhol from our team or ledarens-agent only', () => {
  const s = setup();
  const posts = [];
  s.ctx.board.post = (text, channel, replyTo) => posts.push({ text, channel, replyTo });
  plugin.onMessage({ id: 900, from: 'someone', channel: 'bygge', text: '@tomhol pausa', ts: Date.now() }, s.ctx);
  assert.equal(s.status().pausad, false);
  plugin.onMessage({ id: 901, from: 'ledarens-agent', channel: 'bygge', text: '@tomhol pausa under demon', ts: Date.now() }, s.ctx);
  assert.equal(s.status().pausad, true);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].replyTo, 901);
  assert.doesNotMatch(posts[0].text, /@tomhol/);
  s.message('Tack!');
  s.event();
  assert.equal(s.sent.length, 0);
  assert.equal(s.status().kanaler[0].utskick, 'pausad: bara visning');
  plugin.onMessage({ id: 902, from: 'tomhol', channel: 'bygge', text: '@tomhol fortsätt', ts: Date.now() }, s.ctx);
  assert.equal(s.status().pausad, false);
  assert.equal(posts.length, 2);
  s.event({ id: 124 });
  assert.equal(s.sent.length, 1);
});

function reportSetup(messages, events = []) {
  const plugin = require('../../board/plugins/tomhol/index.js');
  const board = {
    query: ({ channel, limit = 50 }) => messages.filter(m => !channel || m.channel === channel).slice(-limit),
    channels: () => [...new Set(messages.map(m => m.channel))].map(channel => {
      const list = messages.filter(m => m.channel === channel);
      return { channel, count: list.length, last_id: list.at(-1).id, last_ts: list.at(-1).ts };
    }),
    events: limit => events.slice(-limit),
    emit: () => ({ handelse: { id: 1 } }), post() {},
  };
  const ctx = { team: 'tomhol', board };
  return query => {
    let code, body;
    const res = { writeHead(c) { code = c; }, end(b) { body = JSON.parse(b); } };
    plugin.handle({ method: 'GET' }, res, { ...ctx, path: '/report-data', url: new URL(`http://x/t/tomhol/report-data?${query}`) });
    return { code, body };
  };
}

test('report-data follows Rapportörens V1 contract', t => {
  const now = 1800000000000;
  t.mock.method(Date, 'now', () => now);
  const from = now - 3600000;
  const msgs = [
    { id: 1, ts: from - 1000, channel: 'bygge', from: 'a', text: 'Hur gör man? (före perioden)' },
    { id: 2, ts: from + 1000, channel: 'bygge', from: 'a', text: 'Hur gör man?' },
    { id: 3, ts: from + 2000, channel: 'bygge', from: 'mikael', text: 'Kollegan: vem bygger? Tack!' },
    { id: 4, ts: from + 3000, channel: 'torget', from: 'b', text: 'Tack! ❤️ Det går inte.' },
    { id: 5, ts: from + 4000, channel: 'stadens-saga', from: 'c', text: 'Varför? Tack!' },
    { id: 6, ts: now - 1000, channel: 'torget', from: 'tomhol', text: 'Tack!' },
  ];
  const events = [
    { id: 1, ts: from + 5000, kvarter: 'tomhol', typ: 'stämning.byte' },
    { id: 2, ts: from - 5000, kvarter: 'tomhol', typ: 'stämning.byte' },
    { id: 3, ts: from + 6000, kvarter: 'team-martin', typ: 'puls.tryck' },
  ];
  const get = reportSetup(msgs, events);
  const { code, body } = get(`from=${from}&to=${now}`);
  assert.equal(code, 200);
  assert.equal(body.schema_version, 1);
  assert.equal(body.team, 'tomhol');
  assert.deepEqual(body.period, { from, to: now });
  assert.deepEqual({ ...body.coverage, note: undefined }, { from, to: now, complete: true, note: undefined });
  const m = Object.fromEntries(body.metrics.map(x => [x.key, x]));
  assert.equal(m.messages_assessed.value, 2);
  assert.equal(m.channels_assessed.value, 2);
  assert.equal(m['signals.questions'].value, 1);
  assert.equal(m['signals.obstacles'].value, 1);
  assert.equal(m['signals.appreciation'].value, 1);
  assert.equal(m['signals.care'].value, 1);
  assert.equal(m.stamning_byte_emitted.value, 1);
  assert.equal(m.paused.scope, 'snapshot');
  for (const x of body.metrics) assert.match(x.key, /^[a-z0-9._-]+$/);
  assert.equal(body.records, undefined);

  const later = get(`from=${from}&to=${now + 60000}`).body.coverage;
  assert.equal(later.to, now);
  assert.equal(later.complete, false);
});

test('report-data rejects bad periods and marks truncated channels incomplete', t => {
  const now = 1800000000000;
  t.mock.method(Date, 'now', () => now);
  const msgs = Array.from({ length: 600 }, (_, i) => ({ id: i + 1, ts: now - 600000 + i * 1000, channel: 'bygge', from: 'a', text: 'hej' }));
  const get = reportSetup(msgs);
  for (const q of ['', 'from=abc&to=1', `from=${now}&to=${now}`, `from=0&to=${25 * 3600000}`]) {
    const { code, body } = get(q);
    assert.equal(code, 400);
    assert.equal(typeof body.error, 'string');
  }
  const { body } = get(`from=${now - 3600000}&to=${now}`);
  assert.equal(body.coverage.complete, false);
  assert.equal(body.coverage.from, now - 600000 + 100 * 1000);
  assert.match(body.coverage.note, /500 senaste/);
  assert.equal(body.metrics.find(x => x.key === 'messages_assessed').value, 500);
});

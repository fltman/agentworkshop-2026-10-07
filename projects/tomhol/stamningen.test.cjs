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
  s.event({ nyttolast: {} });
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

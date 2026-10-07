// Kör: node test.mjs   (startar servern på en slumpad port i en tom katalog)
//
// Testerna kör mot en EGEN pluginkatalog (PLUGINS_DIR) med bara exempelkvarteret och ett provkvarter i.
// Annars mäts absoluta antal med alla teams plugins inlästa, och ett enda kvarter som postar när det
// startar gör sviten röd — för alla, mitt i mergekön. Det hände förra gången.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const HAR = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'torget-'));
const pdir = mkdtempSync(join(tmpdir(), 'torget-plugins-'));
cpSync(join(HAR, 'plugins', 'exempelkvarteret'), join(pdir, 'exempelkvarteret'), { recursive: true });

// Provkvarter med å, ä och ö i namnet, och en route som kastar inifrån en timer.
mkdirSync(join(pdir, 'skärgårdskajen'), { recursive: true });
writeFileSync(join(pdir, 'skärgårdskajen', 'index.js'), `module.exports = {
  async handle(req, res, ctx) {
    if (ctx.path === '/räd') { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: true, väg: ctx.path })); return true; }
    if (ctx.path === '/krascha') { setTimeout(() => { finnsInteAlls(); }, 20); res.writeHead(204); res.end(); return true; }
    return false;
  },
};
`);

// Provkvarter som lyssnar på händelsebussen och fäller upp paraplyet när det stormar.
mkdirSync(join(pdir, 'paraplyet'), { recursive: true });
writeFileSync(join(pdir, 'paraplyet', 'index.js'), `module.exports = {
  onEvent(e, ctx) { if (e.typ === 'väder.storm') ctx.board.emit('paraply.upp', { styrka: e.styrka, orsak: e.id }); },
};
`);

const PORT = 18000 + Math.floor(Math.random() * 1000);
const miljo = { ...process.env, PORT, DATA_DIR: dir, PLUGINS_DIR: pdir };
// stderr fångas i stället för att skrivas rakt ut: ett av testerna får med flit ett plugin att kasta,
// och en grön svit ska inte se ut som ett fel. Loggen skrivs ut om något fallerar.
let logg = '';
function starta() {
  const p = spawn(process.execPath, [join(HAR, 'server.js')], { env: miljo, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stderr.on('data', d => { logg += d; });
  return p;
}
const proc = starta();
await new Promise(r => proc.stdout.on('data', d => /lyssnar/.test(d) && r()));
const B = `http://localhost:${PORT}`;
const post = (body, headers = {}) => fetch(B + '/api/messages', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
let n = 0; const ok = (name) => console.log(`  ✓ ${name}`, ++n);

try {
  // 1. tomt vid start
  assert.deepEqual(await (await fetch(B + '/api/messages')).json(), []); ok('tom tavla');
  // 2. posta
  let r = await post({ from: 'anna-agent', channel: 'torget', text: 'Hej @bo-agent, vad bygger du?' });
  assert.equal(r.status, 201); const m1 = await r.json(); assert.equal(m1.id, 1); assert.equal(m1.ip, undefined); ok('posta (ip läcker inte)');
  // 3. validering
  r = await post({ from: '', text: 'x' }); assert.equal(r.status, 400); ok('avvisar tomt namn');
  r = await post({ from: 'x', channel: 'Fel Kanal!', text: 'x' }); assert.equal(r.status, 400); ok('avvisar ogiltig kanal');
  r = await post({ from: 'x', text: 'a'.repeat(2001) }); assert.equal(r.status, 400); ok('avvisar för lång text');
  r = await post({ from: 'x', text: 'x', reply_to: 999 }); assert.equal(r.status, 400); ok('avvisar okänt reply_to');
  // 4. svar + mention + kanal
  r = await post({ from: 'bo-agent', channel: 'bygge', text: 'En väderbot!', reply_to: 1 }); assert.equal(r.status, 201); ok('svar på inlägg');
  r = await post({ from: 'bo-agent', text: 'ärver kanal', reply_to: 2 }); assert.equal((await r.json()).channel, 'bygge'); ok('svar ärver kanalen');
  r = await fetch(B + '/api/messages', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'from=form-agent&channel=bygge&text=' + encodeURIComponent('via formulär & åäö') });
  assert.equal(r.status, 201); assert.equal((await r.json()).text, 'via formulär & åäö'); ok('form-urlencoded');
  await post({ from: 'cia', channel: 'torget', text: 'åäö fungerar' });
  let list = await (await fetch(B + '/api/messages?mention=bo-agent')).json(); assert.equal(list.length, 1); assert.equal(list[0].id, 1); ok('mention-filter');
  await post({ from: 'dina', channel: 'torget', text: '@alla brainstorm om kartor → #brainstorm-kartor' });
  list = await (await fetch(B + '/api/messages?mention=bo-agent')).json(); assert.deepEqual(list.map(x => x.id), [1, 6]); ok('@alla når alla');
  list = await (await fetch(B + '/api/messages?mention=dina')).json(); assert.equal(list.length, 0); ok('egna @alla räknas inte');
  list = await (await fetch(B + '/api/messages?channel=bygge')).json(); assert.equal(list.length, 3); ok('kanalfilter');
  list = await (await fetch(B + '/api/messages?since=1')).json(); assert.deepEqual(list.map(x => x.id), [2, 3, 4, 5, 6]); ok('since');
  list = await (await fetch(B + '/api/messages?q=åäö')).json(); assert.equal(list.length, 2); ok('sökning med åäö');
  // 5. textformat
  const t = await (await fetch(B + '/api/messages', { headers: { accept: 'text/plain' } })).text();
  assert.match(t, /^#torget \[1\] \d\d:\d\d anna-agent: Hej @bo-agent/m); ok('textformat');
  // 6. kanaler + agenter
  const ch = await (await fetch(B + '/api/channels')).json(); assert.deepEqual(ch.map(c => c.channel).sort(), ['bygge', 'torget']); ok('kanaler');
  const ag = await (await fetch(B + '/api/agents')).json(); assert.equal(ag.length, 5); ok('agenter');
  // 7. SSE
  const ctrl = new AbortController();
  const sse = await fetch(B + '/api/stream?channel=torget', { signal: ctrl.signal });
  const reader = sse.body.getReader(); const dec = new TextDecoder();
  await post({ from: 'bo-agent', channel: 'bygge', text: 'inte i torget' });
  await post({ from: 'bo-agent', channel: 'torget', text: 'live!' });
  let buf = ''; while (!/live!/.test(buf)) buf += dec.decode((await reader.read()).value);
  assert.ok(!/inte i torget/.test(buf)); ctrl.abort(); ok('SSE med kanalfilter');
  // 7a. plugins
  const pl = await (await fetch(B + '/api/plugins')).json(); assert.ok(pl.some(x => x.team === 'exempelkvarteret' && x.routes && x.listens)); ok('exempelplugin laddat');
  const st = await (await fetch(B + '/t/exempelkvarteret/status')).json(); assert.equal(typeof st.inlägg, 'number'); ok('plugin-route /t/exempelkvarteret/status');
  assert.equal((await fetch(B + '/t/finns-inte/x')).status, 404); ok('okänt plugin → 404');
  await post({ from: 'nyfiken', channel: 'torget', text: '@exempelkvarteret hur många är vi?' });
  await new Promise(r => setTimeout(r, 300));
  list = await (await fetch(B + '/api/messages?channel=torget&limit=1')).json(); assert.equal(list[0].from, 'exempelkvarteret'); assert.match(list[0].text, /agenter/); ok('plugin svarar på @exempelkvarteret via onMessage');
  // 7b. kvarter med å, ä eller ö i namnet: sökvägen kommer in procentkodad och måste avkodas
  const ra = await fetch(B + '/t/' + encodeURIComponent('skärgårdskajen') + '/' + encodeURIComponent('räd'));
  assert.equal(ra.status, 200); assert.deepEqual(await ra.json(), { ok: true, 'väg': '/räd' }); ok('plugin-route med å ä ö');
  // 7c. en throw inne i en timer ligger utanför serverns try/catch och tog förr ner hela tavlan
  assert.equal((await fetch(B + '/t/' + encodeURIComponent('skärgårdskajen') + '/krascha')).status, 204);
  await new Promise(r => setTimeout(r, 400));
  const h = await (await fetch(B + '/api/health')).json();
  assert.equal(h.ok, true); assert.ok(h.startad > 0); ok('plugin-timer som kastar tar inte ner tavlan');
  // 7d. staden
  const kv = await (await fetch(B + '/api/kvarter')).json(); assert.ok(kv.includes('exempelkvarteret/')); ok('kvarter listas');
  assert.equal((await fetch(B + '/staden/kvarter/../../server.js')).status, 404); ok('kvarter: ingen path traversal');
  assert.equal((await fetch(B + '/staden')).status, 200); ok('staden-sidan');
  assert.match(await (await fetch(B + '/workshop')).text(), /<html lang="sv">/);
  r = await fetch(B + '/workshop/en'); assert.equal(r.status, 200); assert.match(await r.text(), /<html lang="en">/); ok('workshopsidan på svenska och engelska');
  assert.equal((await fetch(B + '/qr.png')).status, 404); ok('qr-kod saknas tills ledaren lagt dit en');
  // 8. persistens: starta om, allt kvar
  proc.kill(); await new Promise(r => proc.on('exit', r));
  const p2 = starta();
  await new Promise(r => p2.stdout.on('data', d => /lyssnar/.test(d) && r()));
  list = await (await fetch(B + '/api/messages')).json(); assert.equal(list.length, 10); assert.equal(list.at(-1).from, 'exempelkvarteret'); ok('persistens över omstart');
  r = await post({ from: 'x', text: 'ny' }); assert.equal((await r.json()).id, 11); ok('id fortsätter efter omstart');
  // 9. kontraktet: händelsebussen, ett test per spärr
  const ev = (b) => fetch(B + '/api/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  r = await ev({ from: 'vadret', typ: 'väder.storm', styrka: 70, nyttolast: { vind: 'stark' } });
  assert.equal(r.status, 201); const e1 = await r.json(); assert.equal(e1.kvarter, 'vadret'); assert.equal(e1.djup, 1); assert.equal(e1.styrka, 70); ok('händelse: servern fyller i kvarter och djup');
  r = await ev({ from: 'vadret', typ: 'Fel Typ' }); assert.equal(r.status, 400); ok('händelse: ogiltig typ avvisas');
  r = await ev({ from: 'vadret', typ: 'x', styrka: 101 }); assert.equal(r.status, 400); ok('händelse: styrka 0-100');
  r = await ev({ from: 'trafiken', typ: 'trafik.stopp', orsak: 9999 }); assert.equal(r.status, 400); ok('händelse: okänd orsak avvisas');
  await new Promise(res => setTimeout(res, 150));
  let evs = await (await fetch(B + '/api/events?typ=paraply.upp')).json();
  assert.equal(evs.length, 1); assert.equal(evs[0].kvarter, 'paraplyet'); assert.equal(evs[0].orsak, e1.id); assert.equal(evs[0].djup, 2); ok('händelse: plugin reagerar via onEvent och board.emit');
  let orsak = e1.id;
  for (const [i, k] of ['trafiken', 'marknaden', 'minnet', 'rosten', 'granskaren'].entries()) { r = await ev({ from: k, typ: 'kedja', orsak }); assert.equal(r.status, 201); const e = await r.json(); assert.equal(e.djup, i + 2); orsak = e.id; }
  r = await ev({ from: 'tidningen', typ: 'kedja', orsak }); assert.equal(r.status, 400); assert.match((await r.json()).error, /maxdjup/); ok('händelse: maxdjup 6');
  r = await ev({ from: 'trafiken', typ: 'igen', orsak: e1.id }); assert.equal(r.status, 400); assert.match((await r.json()).error, /redan reagerat/); ok('händelse: en reaktion per orsak och kvarter');
  for (let i = 0; i < 6; i++) { r = await ev({ from: 'pratig', typ: 'puls' }); assert.equal(r.status, 201); }
  r = await ev({ from: 'pratig', typ: 'puls' }); assert.equal(r.status, 400); assert.match((await r.json()).error, /per minut/); ok('händelse: max 6 per minut och kvarter');
  r = await post({ from: 'fusk', channel: 'kollegan-events', text: '{"typ":"falsk"}' }); assert.equal(r.status, 400); ok('händelse: bussen går inte att skriva i direkt');
  evs = await (await fetch(B + '/api/events')).json(); assert.equal(evs.length, 13); ok('händelser listas');
  const rad = await (await fetch(B + '/api/events?limit=1', { headers: { accept: 'text/plain' } })).text(); assert.match(rad, /pratig: puls djup=1/); ok('händelser i radformat');
  r = await fetch(B + '/api/events', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'from=formkvarter&typ=' + encodeURIComponent('väder.sol') + '&styrka=20&nyttolast=' + encodeURIComponent('{"moln":0}') });
  assert.equal(r.status, 201); assert.deepEqual((await r.json()).nyttolast, { moln: 0 }); ok('händelse via form-urlencoded (board.sh emit)');
  p2.kill(); await new Promise(res => p2.on('exit', res));
  const p3 = starta();
  await new Promise(res => p3.stdout.on('data', d => /lyssnar/.test(d) && res()));
  evs = await (await fetch(B + '/api/events')).json(); assert.equal(evs.length, 14); assert.equal(evs.find(e => e.typ === 'paraply.upp').djup, 2); ok('händelsebussen överlever omstart, med djup');
  r = await ev({ from: 'trafiken', typ: 'igen', orsak: e1.id }); assert.equal(r.status, 400); ok('spärren överlever omstart');
  p3.kill();
  console.log(`\n${n} tester gröna`);
} catch (e) {
  console.error('\n✗', e.message);
  if (logg.trim()) console.error('serverloggen:\n' + logg.split('\n').slice(0, 20).join('\n'));
  proc.kill(); process.exit(1);
}

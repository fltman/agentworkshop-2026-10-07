// End-to-end-test av Kollegan via den externa klienten. Startar en riktig Torg-server med ALLA
// förmågor, seedar anspråken, och frågar Kollegan en gång genom det publika HTTP-API:t. Beviset
// att hela kedjan (Örat → Kön → Minnet → Rösten → Granskaren) svarar en utomstående konsument.
// Kör från repo-roten:  node --test projects/holminator/test/kollegan-klient.test.js
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '../../..');
const { fragaKollegan, byggKedja } = require('../kollegan-klient');
const BAS = 'http://localhost:4971';

async function vänta(url, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if ((await fetch(url)).ok) return true; } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('servern startade inte');
}
const posta = (text, from, channel = 'bygge') =>
  fetch(`${BAS}/api/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from, channel, text }) });

test('byggKedja följer orsak-länkarna och hoppar över själva fråga.ny', () => {
  const h = [
    { id: 1, typ: 'fråga.ny', kvarter: 'surret', orsak: null },
    { id: 2, typ: 'minne.träff', kvarter: 'holminator', styrka: 85, orsak: 1 },
    { id: 3, typ: 'svar.utkast', kvarter: 'mikael', styrka: 70, orsak: 2 },
    { id: 4, typ: 'puls.tryck', kvarter: 'team-martin', styrka: 20, orsak: 99 }, // annan kedja
  ];
  const k = byggKedja(h, 1);
  assert.deepEqual(k.map(e => e.kvarter), ['holminator', 'mikael']);
  assert.ok(!k.some(e => e.typ === 'fråga.ny'));
});

test('en extern klient får svar från hela kedjan', { timeout: 30000 }, async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kollegan-'));
  const srv = spawn(process.execPath, ['board/server.js'], {
    cwd: ROOT, env: { ...process.env, TZ: 'UTC', PORT: '4971', DATA_DIR: dataDir }, stdio: 'ignore',
  });
  t.after(() => { srv.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); });

  await vänta(`${BAS}/api/health`);
  for (const [from, text] of [
    ['holminator', 'holminator tar förmågan Minnet.'], ['mikael', 'mikael tar Rösten.'],
    ['surret', 'surret tar Örat.'], ['fralle', 'fralle tar Kön.'], ['heimlen', 'heimlen tar Granskaren.'],
  ]) await posta(text, from);

  const r = await fragaKollegan('vem bygger rösten?', { baseUrl: BAS, timeoutMs: 20000, pollMs: 800 });
  assert.equal(r.besvarad, true, 'Kollegan svarade inte: ' + JSON.stringify(r));
  assert.match(r.svar, /mikael bygger Rösten/);
  assert.ok(r.kedja.some(e => e.kvarter === 'holminator' && e.typ === 'minne.träff'), 'Minnet bidrog');
  assert.ok(r.kedja.some(e => e.kvarter === 'mikael' && e.typ === 'svar.klart'), 'Rösten svarade');
  assert.equal(typeof r.styrka, 'number');
});

test('utan Rösten räddar klienten Minnets preliminära svar i stället för tyst timeout', { timeout: 15000 }, async (t) => {
  // Deterministisk mock av Torgets HTTP-API: Minnet gav en minne.träff, Lotsen hänvisade vidare,
  // men ingen "Kollegan:"-rad kom. Rösten laddas alltid i e2e-servern, så bortfallet mockas här.
  const http = require('node:http');
  const events = [
    { id: 6, typ: 'fråga.ny', kvarter: 'surret', orsak: null, nyttolast: { inlägg: 5 } },
    { id: 7, typ: 'fråga.prioriterad', kvarter: 'fralle', styrka: 50, orsak: 6, nyttolast: {} },
    { id: 8, typ: 'minne.träff', kvarter: 'holminator', styrka: 70, orsak: 6, nyttolast: { svar: 'mikael bygger Rösten.' } },
  ];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST') return void res.end(JSON.stringify({ id: 5 }));
    if (u.pathname === '/api/messages') return void res.end(JSON.stringify([
      { id: 9, reply_to: 5, from: 'babtist', text: 'Lotsen: Kollegans svar fastnade. @mikael kan nog svara.' },
    ]));
    return void res.end(JSON.stringify(events));
  });
  await new Promise(r => srv.listen(0, r));
  const bas = `http://localhost:${srv.address().port}`;
  t.after(() => srv.close());

  const r = await fragaKollegan('vem bygger rösten?', { baseUrl: bas, timeoutMs: 3000, pollMs: 300 });
  assert.equal(r.besvarad, false, 'förväntade timeout: ' + JSON.stringify(r));
  assert.equal(r.svar, null);
  assert.equal(r.preliminärtSvar, 'mikael bygger Rösten.', 'räddade Minnets svar');
  assert.equal(r.lotsHänvisning, 'mikael', 'fångade Lotsens hänvisning');
  assert.match(r.diagnos, /preliminära svar.*mikael bygger Rösten/);
  assert.match(r.diagnos, /Lotsen hänvisade till @mikael/);
});

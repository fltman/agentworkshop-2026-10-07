// Tester för Minnet (board/plugins/holminator). Kör från repo-roten: node --test projects/holminator/test/minnet.test.js
// Varje test laddar en färsk modul och matar den med inlägg i samma format som på Torget.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const PLUGIN = path.resolve(__dirname, '../../../board/plugins/holminator/index.js');
const T0 = Date.UTC(2026, 9, 7, 7, 56); // 09:56 i Stockholm

function nyttMinne(poster = [], handelser = []) {
  delete require.cache[PLUGIN];
  const mod = require(PLUGIN);
  const skickat = [];
  let nastaId = 10000;
  const ctx = {
    team: 'holminator',
    board: {
      // Som board/server.js: filtrera, ta sedan de SISTA `limit`.
      query: ({ since = 0, limit = 500, channel }) =>
        poster.filter(p => p.id > since && (!channel || p.channel === channel)).slice(-limit),
      channels: () => [...new Set(poster.map(p => p.channel))]
        .map(c => ({ channel: c, count: poster.filter(p => p.channel === c).length })),
      events: () => handelser,
      emit: (typ, o) => { const h = { id: nastaId++, ts: Date.now(), typ, kvarter: 'holminator', ...o }; skickat.push(h); return { handelse: h }; },
    },
  };
  mod.init(ctx);
  const fraga = (text, extra = {}) => {
    const e = { id: nastaId++, ts: Date.now(), typ: 'fråga.ny', kvarter: 'surret', nyttolast: { fråga: text, kanal: 'torget', ...extra } };
    mod.onEvent(e, ctx);
    return skickat.filter(s => s.orsak === e.id).pop();
  };
  const get = async p => {
    let kropp;
    const res = { writeHead() {}, end(b) { kropp = JSON.parse(b); } };
    const u = new URL('http://x/t/holminator' + p);
    const svar = await mod.handle({ method: 'GET' }, res, { path: u.pathname.replace('/t/holminator', ''), url: u });
    return svar === false ? false : kropp;
  };
  return { mod, ctx, skickat, fraga, get };
}

let id = 0;
const post = (from, channel, text, ts = Date.now() - 60000) => ({ id: ++id, ts, from, channel, text });

// Ett Torg i miniatyr, med dagens verkliga formuleringar.
function torget() {
  id = 0;
  return [
    post('holminator', 'bygge', 'holminator tar förmågan Minnet: tidslinje och fakta över dagen.'),
    post('surret', 'bygge', 'surret tar förmågan Örat. Lyssnar efter @kollegan och skickar fråga.ny.'),
    post('mikael', 'bygge', 'mikael tar Rösten, formulerar svaret.'),
    post('fralle', 'bygge', 'fralle tar Kön: prioriterar frågor.'),
    post('marcuslind', 'bygge', 'marcuslind tar förmågan Mötet och sammanfattar kanaler.'),
    post('leif', 'bygge', 'leif takes the Translator.'),
    post('team-martin', 'bygge', 'team-martin tar en egen förmåga: Pulsen, mäter tempot i rummet.'),
    post('tomhol', 'bygge', 'Building this takes time, but tomhol tar förmågan Stämningen.'),
    post('babtist', 'bygge', 'babtist tar Örat också'), // krock: surret var först
    post('ledarens-agent', 'bygge', 'Läget:\nÖrat: surret\nLotsen: babtist\nMinnet: holminator'),
    post('ledarens-agent', 'bygge', 'BESLUT: Kollegan vann omröstningen med 8 av 11 röster.'),
    post('release-agenten', 'bygge', 'PR inne från holminator: https://github.com/x/y/pull/7 mergad.'),
    post('mikael', 'bygge', 'Rösten läser minne.träff och skriver svar.utkast.'),
  ];
}

test('vem bygger vad: först till kvarn, ledningen avgör', async () => {
  const m = nyttMinne(torget());
  const fakta = await m.get('/fakta');
  const karta = Object.fromEntries(fakta.map(f => [f.förmåga, f.team]));
  assert.equal(karta['Örat'], 'surret', 'babtist ropade Örat efter surret');
  assert.equal(karta['Minnet'], 'holminator');
  assert.equal(karta['Rösten'], 'mikael');
  assert.equal(karta['Kön'], 'fralle');
  assert.equal(karta['Översättaren'], 'leif', 'engelskt anspråk mappas till svenskt namn');
  assert.equal(karta['Pulsen'], 'team-martin', 'egen förmåga');
  assert.equal(karta['Stämningen'], 'tomhol');
  assert.equal(karta['Lotsen'], 'babtist', 'ledningens lägesrad');
  assert.ok(!fakta.some(f => /time|wins/i.test(f.förmåga)), '"takes time" är ingen förmåga: ' + JSON.stringify(karta));
  assert.ok(!fakta.some(f => f.team === 'ledarens-agent'));
  assert.equal(fakta.find(f => f.team === 'holminator').levererad, true);
});

test('fråga.ny besvaras med minne.träff, källor och styrka', () => {
  const m = nyttMinne(torget());
  const s = m.fraga('vem bygger rösten?', { inlägg: 999 });
  assert.equal(s.typ, 'minne.träff');
  assert.match(s.nyttolast.svar, /mikael bygger Rösten/);
  assert.ok(s.styrka >= 80);
  assert.ok(s.nyttolast.källor.length >= 1);
  assert.equal(s.nyttolast.inlägg, 999);
});

test('init minns morgonens anspråk även när bussens kopior är fler än en sida', () => {
  // Live 11:17: 530 inlägg i kollegan-events efter anspråken; en sida (sista 500) missade dem helt.
  const poster = torget();
  for (let i = 0; i < 600; i++) poster.push(post('surret', 'kollegan-events', '{"typ":"puls.tryck"}'));
  const m = nyttMinne(poster);
  const s = m.fraga('vem bygger rösten?');
  assert.match(s.nyttolast.svar, /mikael bygger Rösten/);
});

test('engelska frågor om förmågor', () => {
  const m = nyttMinne(torget());
  const s = m.fraga('who builds the voice?');
  assert.match(s.nyttolast.svar, /^mikael bygger Rösten/);
  assert.ok(s.styrka >= 80);
});

test('leveranser', () => {
  const m = nyttMinne(torget());
  const s = m.fraga('vilka har levererat?');
  assert.match(s.nyttolast.svar, /holminator \(Minnet\) \d\d:\d\d PR 7/);
});

test('klockslag i Stockholmstid, inte UTC', () => {
  const p = torget();
  p.find(x => x.text.startsWith('PR inne')).ts = T0;
  const m = nyttMinne(p);
  const s = m.fraga('vilka har levererat?');
  assert.match(s.nyttolast.svar, /09:56/);
  assert.doesNotMatch(s.nyttolast.svar, /07:56/);
});

test('beslut hittas, men "Rösten" är ingen omröstning', () => {
  const m = nyttMinne(torget());
  assert.match(m.fraga('vad har vi bestämt?').nyttolast.svar, /BESLUT/);
  const r = m.fraga('vad gör Rösten?');
  assert.doesNotMatch(r.nyttolast.svar, /BESLUT/);
  assert.match(r.nyttolast.svar, /mikael bygger Rösten/);
});

test('frågan svarar aldrig på sig själv, och @kollegan-inlägg är inte kunskap', () => {
  const p = torget();
  const q2 = post('andhol', 'torget', '@kollegan vad tycker ni om lunchen idag?');
  const svar = post('surret', 'torget', 'Kollegan: lunchen idag är pasta.');
  p.push(q2, svar);
  const m = nyttMinne(p);
  const s = m.fraga('lunchen idag tycker', { inlägg: q2.id });
  assert.ok(!s.nyttolast.källor.some(k => k.id === q2.id || k.id === svar.id), JSON.stringify(s.nyttolast.källor));
  assert.equal(s.styrka, 0);
});

test('sammanfatta och översätt pekas till Mötet och Översättaren med låg styrka', () => {
  const m = nyttMinne(torget());
  const a = m.fraga('@kollegan sammanfatta #bygge');
  assert.match(a.nyttolast.svar, /Mötet.*marcuslind/);
  assert.ok(a.styrka <= 30);
  const b = m.fraga('kan du översätta det här till engelska?');
  assert.match(b.nyttolast.svar, /Översättaren.*leif/);
  assert.ok(b.styrka <= 30);
});

test('ägare plus senaste signal: "vad händer i pulsen just nu, vem driver det"', () => {
  const h = [{ id: 500, ts: Date.now() - 120000, typ: 'puls.tempo', kvarter: 'team-martin', styrka: 70, nyttolast: { inlägg_per_minut: 4 } }];
  const m = nyttMinne(torget(), h);
  const s = m.fraga('Vad händer i Pulsen just nu, vem driver det?');
  assert.match(s.nyttolast.svar, /team-martin bygger Pulsen/);
  assert.match(s.nyttolast.svar, /puls\.tempo/);
});

test('signal från en annan förmåga', () => {
  const h = [{ id: 501, ts: Date.now() - 60000, typ: 'stämning.läge', kvarter: 'tomhol', styrka: 60, nyttolast: 'glad' }];
  const m = nyttMinne(torget(), h);
  const s = m.fraga('hur är stämningen?');
  assert.match(s.nyttolast.svar, /tomhol stämning\.läge/);
});

test('långa påståenden utan frågetecken får låg styrka, fritext max 80', () => {
  const p = torget();
  p.push(post('heimlen', 'bygge', 'Granskaren kontrollerar svar.utkast mot källorna innan Rösten publicerar.'));
  const m = nyttMinne(p);
  const lang = 'Granskaren kontrollerar svar.utkast mot källorna innan publicering. '.repeat(6);
  assert.ok(lang.length > 280);
  assert.ok(m.fraga(lang).styrka <= 40);
  const kort = m.fraga('granskaren kontrollerar källorna?');
  assert.ok(kort.styrka > 0 && kort.styrka <= 80, String(kort.styrka));
});

test('inget underlag ger styrka 0', () => {
  const m = nyttMinne(torget());
  assert.equal(m.fraga('vad kostar en flygbiljett till Tokyo?').styrka, 0);
});

test('en fråga besvaras en gång, även när Kön skickar den igen', () => {
  const m = nyttMinne(torget());
  const e = { id: 7000, ts: Date.now(), typ: 'fråga.ny', kvarter: 'surret', nyttolast: { fråga: 'vem bygger kön?' } };
  m.mod.onEvent(e, m.ctx);
  m.mod.onEvent(e, m.ctx);
  m.mod.onEvent({ id: 7001, ts: Date.now(), typ: 'fråga.prioriterad', kvarter: 'fralle', orsak: 7000, nyttolast: { fråga: 'vem bygger kön?' } }, m.ctx);
  m.mod.onEvent({ id: 7002, ts: Date.now(), typ: 'fråga.prioriterad', kvarter: 'fralle', nyttolast: { fråga: 'vem bygger kön?', fråga_id: 7000 } }, m.ctx);
  assert.equal(m.skickat.filter(s => s.typ === 'minne.träff').length, 1);
});

test('svar från före omstart räknas som besvarade', () => {
  const h = [{ id: 8000, ts: Date.now(), typ: 'fråga.ny', kvarter: 'surret', nyttolast: { fråga: 'vem bygger kön?' } },
    { id: 8001, ts: Date.now(), typ: 'minne.träff', kvarter: 'holminator', orsak: 8000, nyttolast: { fråga: 'vem bygger kön?', svar: 'x' } }];
  const m = nyttMinne(torget(), h);
  m.mod.onEvent(h[0], m.ctx);
  assert.equal(m.skickat.length, 0);
});

test('upprepad fråga noteras', () => {
  const m = nyttMinne(torget());
  m.fraga('vem bygger kön?');
  assert.match(m.fraga('vem bygger kön nu?').nyttolast.svar, /Samma fråga ställdes/);
});

test('nya fakta i drift köas som kunskap.ny, inlästa fakta gör det inte', async () => {
  const m = nyttMinne(torget());
  assert.equal((await m.get('/status')).kö, 0);
  m.mod.onMessage(post('heimlen', 'bygge', 'heimlen tar förmågan Granskaren.'), m.ctx);
  m.mod.onMessage(post('release-agenten', 'bygge', 'PR inne från heimlen: https://github.com/x/y/pull/11'), m.ctx);
  assert.equal((await m.get('/status')).kö, 2);
});

test('bussens egna inlägg blir inte poster', async () => {
  const m = nyttMinne(torget());
  const fore = (await m.get('/status')).poster;
  m.mod.onMessage(post('surret', 'kollegan-events', '{"typ":"fråga.ny"}'), m.ctx);
  assert.equal((await m.get('/status')).poster, fore);
});

test('HTTP: /status, /tidslinje, /sok, okänd väg och POST', async () => {
  const m = nyttMinne(torget());
  assert.ok((await m.get('/status')).poster > 0);
  const tl = await m.get('/tidslinje');
  assert.ok(Array.isArray(tl.fack) && tl.fack.length > 0);
  assert.match((await m.get('/sok?q=vem%20bygger%20minnet')).svar, /holminator bygger Minnet/);
  assert.equal(await m.get('/finns-inte'), false);
  assert.equal(await m.mod.handle({ method: 'POST' }, {}, { path: '/sok', url: new URL('http://x/') }), false);
  assert.equal(m.skickat.length, 0, '/sok skickar inget på bussen');
});

test('leverans för en namngiven förmåga, inte hela listan', () => {
  const m = nyttMinne(torget());
  const a = m.fraga('vem bygger rösten, och har de levererat?');
  assert.equal(a.nyttolast.svar, 'mikael bygger Rösten och har inte levererat än.');
  const b = m.fraga('har minnet levererat?');
  assert.match(b.nyttolast.svar, /^holminator \(Minnet\) levererade \d\d:\d\d PR 7\.$/);
  assert.doesNotMatch(b.nyttolast.svar, /team har levererat/);
});

// Krockar: två team som ropar samma förmåga.
const krockar = m => m.get('/krockar');

test('krock vid inläsning registreras, köas inte, och löses av ledningens lägesrad', async () => {
  const m = nyttMinne(torget());
  const k = await krockar(m);
  assert.equal(k.length, 1);
  assert.equal(k[0].förmåga, 'Örat');
  assert.equal(k[0].team, 'babtist');
  assert.equal(k[0].hos, 'surret');
  assert.deepEqual(k[0].löst.team, 'surret', 'ledningen skrev Örat: surret');
  const s = await m.get('/status');
  assert.equal(s.krockar, 0);
  assert.equal(s.kö, 0, 'inlästa krockar skickas inte som kunskap.ny');
});

test('ny krock i drift: kunskap.ny, svar på fråga, ingen dubbelrapport', async () => {
  const m = nyttMinne(torget());
  m.mod.onMessage(post('heimlen', 'bygge', 'heimlen tar förmågan Minnet.'), m.ctx);
  m.mod.onMessage(post('heimlen', 'bygge', 'heimlen tar förmågan Minnet, igen.'), m.ctx);
  const s = await m.get('/status');
  assert.equal(s.krockar, 1);
  assert.equal(s.kö, 1, 'en rapport, inte två');
  const fakta = await m.get('/fakta');
  assert.equal(fakta.find(f => f.förmåga === 'Minnet').team, 'holminator', 'först till kvarn');
  const svar = m.fraga('finns det några krockar?');
  assert.match(svar.nyttolast.svar, /heimlen ropade Minnet, som holminator redan har/);
  assert.equal(svar.styrka, 80);
  assert.equal(svar.nyttolast.källor[0].från, 'heimlen');
});

test('krocken skickas på bussen av timern, en i taget', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const m = nyttMinne(torget());
  m.mod.onMessage(post('heimlen', 'bygge', 'heimlen tar förmågan Minnet.'), m.ctx);
  m.mod.onMessage(post('release-agenten', 'bygge', 'PR inne från mikael: https://github.com/x/y/pull/10'), m.ctx);
  assert.equal(m.skickat.length, 0);
  t.mock.timers.tick(15000);
  assert.equal(m.skickat.length, 1);
  const h = m.skickat[0];
  assert.equal(h.typ, 'kunskap.ny');
  assert.equal(h.styrka, 60);
  assert.deepEqual({ ...h.nyttolast.krock, inlägg: 0, först: 0 }, { förmåga: 'Minnet', team: 'heimlen', hos: 'holminator', inlägg: 0, först: 0 });
  assert.match(h.nyttolast.fakta, /^Krock: heimlen ropade Minnet/);
  t.mock.timers.tick(15000);
  assert.equal(m.skickat.length, 2);
  assert.match(m.skickat[1].nyttolast.fakta, /mikael har levererat PR 10/);
  t.mock.timers.tick(15000);
  assert.equal(m.skickat.length, 2, 'tom kö skickar inget');
});

test('krock löses när ledningen avgör, och kan uppstå igen efteråt', async () => {
  const m = nyttMinne(torget());
  m.mod.onMessage(post('heimlen', 'bygge', 'heimlen tar förmågan Minnet.'), m.ctx);
  m.mod.onMessage(post('ledarens-agent', 'bygge', 'Läget:\nMinnet: holminator'), m.ctx);
  assert.equal((await m.get('/status')).krockar, 0);
  assert.match(m.fraga('några krockar?').nyttolast.svar, /inga öppna krockar, 2 är lösta/);
  m.mod.onMessage(post('heimlen', 'bygge', 'heimlen tar förmågan Minnet ändå.'), m.ctx);
  assert.equal((await m.get('/status')).krockar, 1, 'nytt anspråk efter beslutet är en ny krock');
});

test('ledningen kan ge förmågan till den som ropade sist', async () => {
  const m = nyttMinne(torget());
  m.mod.onMessage(post('heimlen', 'bygge', 'heimlen tar förmågan Kön.'), m.ctx);
  m.mod.onMessage(post('ledarens-agent', 'bygge', 'Kön: heimlen'), m.ctx);
  const fakta = await m.get('/fakta');
  assert.equal(fakta.find(f => f.förmåga === 'Kön').team, 'heimlen');
  const k = (await krockar(m)).find(x => x.förmåga === 'Kön');
  assert.equal(k.löst.team, 'heimlen');
});

test('krock löses när teamet byter till en annan förmåga', async () => {
  const m = nyttMinne(torget());
  m.mod.onMessage(post('heimlen', 'bygge', 'heimlen tar förmågan Minnet.'), m.ctx);
  m.mod.onMessage(post('heimlen', 'bygge', 'Okej, heimlen tar förmågan Granskaren i stället.'), m.ctx);
  const k = (await krockar(m)).find(x => x.team === 'heimlen');
  assert.equal(k.löst.bytte, 'Granskaren');
  assert.equal((await m.get('/status')).krockar, 0);
});

test('samma team som ropar sin egen förmåga igen är ingen krock', async () => {
  const m = nyttMinne(torget());
  m.mod.onMessage(post('mikael', 'bygge', 'mikael tar förmågan Rösten, v2.'), m.ctx);
  assert.equal((await m.get('/status')).krockar, 0);
  assert.equal((await m.get('/status')).kö, 0);
});

test('krockfråga utan krockar och engelsk krockfråga', () => {
  id = 0;
  const m = nyttMinne([post('mikael', 'bygge', 'mikael tar förmågan Rösten.')]);
  const a = m.fraga('finns det krockar?');
  assert.equal(a.nyttolast.svar, 'Minnet ser inga öppna krockar.');
  m.mod.onMessage(post('leif', 'bygge', 'leif takes the voice'), m.ctx);
  assert.match(m.fraga('any conflict over the voice?').nyttolast.svar, /leif ropade Rösten, som mikael redan har/);
});

// Fall från livetestet 10:08 (inlägg 324 och 362).
test('"vilka team har levererat" listar alla, ordet "team" pekar inte ut team-martin', () => {
  const p = torget();
  p.push(post('release-agenten', 'bygge', 'PR inne från team-martin: https://github.com/x/y/pull/8'));
  const m = nyttMinne(p);
  const s = m.fraga('@kollegan vilka team har levererat hittills?');
  assert.match(s.nyttolast.svar, /^2 team har levererat: holminator \(Minnet\).*team-martin \(Pulsen\)/);
  assert.match(m.fraga('har team-martin levererat?').nyttolast.svar, /^team-martin \(Pulsen\) levererade/);
  assert.match(m.fraga('vem i teamet bygger rösten?').nyttolast.svar, /^mikael bygger Rösten/);
});

test('händelsetyper i frågan tolkas inte som avsikt, okänt kvarter besvaras med dess signal', () => {
  const h = [{ id: 600, ts: Date.now() - 30000, typ: 'bild.klar', kvarter: 'ateljen', styrka: 50, nyttolast: { till: 'surret' } }];
  const m = nyttMinne(torget(), h);
  const s = m.fraga('@kollegan ateljen har precis börjat skicka bild.klar. Vad bygger ateljen, och vem lyssnar på dem?');
  assert.doesNotMatch(s.nyttolast.svar, /levererat|förmågor är tagna/);
  assert.match(s.nyttolast.svar, /ateljen bild\.klar/);
  assert.equal(s.nyttolast.källor[0].från, 'ateljen');
});

test('mallfrågor om olika saker får ingen "samma fråga"-not, riktig upprepning får det', () => {
  const h = [{ id: 601, ts: Date.now() - 30000, typ: 'bild.klar', kvarter: 'ateljen', nyttolast: {} },
    { id: 602, ts: Date.now() - 20000, typ: 'karta.ritad', kvarter: 'leiost', nyttolast: {} }];
  const m = nyttMinne(torget(), h);
  m.fraga('ateljen har precis börjat skicka bild.klar. Vad bygger ateljen, och vem lyssnar på dem?');
  const b = m.fraga('leiost har precis börjat skicka karta.ritad. Vad bygger leiost, och vem lyssnar på dem?');
  assert.match(b.nyttolast.svar, /leiost karta\.ritad/);
  assert.doesNotMatch(b.nyttolast.svar, /Samma fråga/);
  const c = m.fraga('leiost har precis börjat skicka karta.ritad. Vad bygger leiost, och vem lyssnar?');
  assert.match(c.nyttolast.svar, /Samma fråga ställdes/);
});

test('Stadsbladet: senaste numret med notisernas källinlägg, och svar när inget nummer finns', () => {
  const h = [
    { id: 700, ts: Date.now() - 90000, typ: 'nyheter.nummer', kvarter: 'redaktionen', nyttolast: { nummer: 2, rubrik: 'Gammalt', notiser: [] } },
    { id: 701, ts: Date.now() - 30000, typ: 'nyheter.nummer', kvarter: 'redaktionen', nyttolast: { nummer: 3, rubrik: 'Minnet minns allt', notiser: [{ text: 'holminator ropade Minnet.', kallor: [1] }] } },
  ];
  const m = nyttMinne(torget(), h);
  const s = m.fraga('@kollegan vad står i senaste Stadsbladet?');
  assert.match(s.nyttolast.svar, /^Stadsbladet nr 3 \(\d\d:\d\d\): Minnet minns allt\. holminator ropade Minnet\./);
  assert.equal(s.styrka, 85);
  assert.deepEqual(s.nyttolast.källor.map(k => k.id), [701, 1]);
  assert.match(m.fraga('what is in the news today?').nyttolast.svar, /^Stadsbladet nr 3/);
  const tom = nyttMinne(torget());
  assert.match(tom.fraga('vad skriver tidningen?').nyttolast.svar, /inte sett något nummer av Stadsbladet/);
});

test('kunskap.ny väntar när svaren tagit minutens utrymme, och tappas inte', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() });
  const m = nyttMinne(torget());
  m.mod.onMessage(post('heimlen', 'bygge', 'heimlen tar förmågan Minnet.'), m.ctx);
  m.fraga('vem bygger rösten?'); m.fraga('vem bygger kön?'); m.fraga('vem bygger mötet?');
  t.mock.timers.tick(15000);
  assert.equal(m.skickat.filter(s => s.typ === 'kunskap.ny').length, 0, 'tre svar senaste minuten: kunskap.ny får vänta');
  t.mock.timers.tick(45000);
  const k = m.skickat.filter(s => s.typ === 'kunskap.ny');
  assert.equal(k.length, 1, 'när minuten gått skickas den köade krocken');
  assert.match(k[0].nyttolast.fakta, /^Krock: heimlen ropade Minnet/);
});

test('kunskap.ny som servern nekar ligger kvar i kön', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const m = nyttMinne(torget());
  const emit = m.ctx.board.emit;
  let neka = true;
  m.ctx.board.emit = (typ, o) => (neka ? { error: 'för många händelser' } : emit(typ, o));
  m.mod.onMessage(post('heimlen', 'bygge', 'heimlen tar förmågan Minnet.'), m.ctx);
  t.mock.timers.tick(15000);
  assert.equal(m.skickat.length, 0);
  neka = false;
  t.mock.timers.tick(15000);
  assert.equal(m.skickat.length, 1);
  assert.match(m.skickat[0].nyttolast.fakta, /^Krock: heimlen/);
});

test('ett svar som servern nekar skickas igen efter några sekunder', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const m = nyttMinne(torget());
  const emit = m.ctx.board.emit;
  let nekade = 0;
  m.ctx.board.emit = (typ, o) => (nekade++ < 1 ? { error: 'för många händelser' } : emit(typ, o));
  assert.equal(m.fraga('vem bygger rösten?'), undefined);
  t.mock.timers.tick(4000);
  const s = m.skickat.filter(x => x.typ === 'minne.träff');
  assert.equal(s.length, 1);
  assert.match(s[0].nyttolast.svar, /^mikael bygger Rösten/);
  assert.ok(s[0].orsak, 'svaret behåller orsak');
});

test('aktiefrågor lämnas till Kursen med låg styrka, babtist äger både Lotsen och Kursen', async () => {
  const p = torget();
  p.push(post('babtist', 'bygge', 'babtist tar en egen förmåga: Kursen. Frågar någon Kollegan om Sinch-aktien (kurs, aktie, börsen) hämtar Kursen kursen.'));
  const m = nyttMinne(p);
  for (const q of ['@kollegan vad är sinch-aktien värd idag?', 'hur går börsen?', 'what is the Sinch stock price?']) {
    const s = m.fraga(q);
    assert.equal(s.styrka, 20, q);
    assert.match(s.nyttolast.svar, /^Det är Kursens uppgift, som babtist bygger\./, q);
  }
  assert.match(m.fraga('vem bygger kursen?').nyttolast.svar, /^babtist bygger Kursen/);
  const egna = (await m.get('/fakta')).filter(f => f.team === 'babtist').map(f => f.förmåga).sort();
  assert.deepEqual(egna, ['Kursen', 'Lotsen']);
});

test('vem bygger översättaren? är en vem-fråga, inte en översättning (live 11:31)', () => {
  const m = nyttMinne(torget());
  const s = m.fraga('vem bygger översättaren?');
  assert.match(s.nyttolast.svar, /leif bygger Översättaren/);
  assert.ok(s.styrka >= 80);
  assert.match(m.fraga('kan du översätta det här till engelska?').nyttolast.svar, /Översättarens uppgift/);
});

test('ett andra anspråk långt senare är en förmåga till, inte ett byte (fralle: Kön, sedan Rapportören)', () => {
  const poster = torget();
  poster.push(post('fralle', 'bygge', 'Ja, fralle tar förmågan Kön.', T0));
  poster.push(post('fralle', 'bygge', 'fralle tar förmågan Rapportören.', T0 + 3 * 3600000));
  const m = nyttMinne(poster);
  assert.match(m.fraga('vem bygger kön?').nyttolast.svar, /fralle bygger Kön/);
  assert.match(m.fraga('vem bygger rapportören?').nyttolast.svar, /fralle bygger Rapportören/);
});

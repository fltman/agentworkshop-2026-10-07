// Nyfikenheten (team farzad): när det är tyst i frågeflödet ställer Kollegan själv en fråga,
// byggd på något en annan förmåga just sett. Reagerar på andra kvarters händelser, aldrig på en tom timer.
//
//   lyssnar på  puls.*, stämning.*, kunskap.*, minne.*, nyheter.*, och första händelsen från varje nytt kvarter,
//               men inte kedjor som började med en fråga eller med oss själva
//   skickar     nyfikenhet.fråga {fråga, kvarter, typ, inlägg, kanal}  med orsak = händelsen som väckte frågan
//   postar      "@kollegan <fråga>" på Torget, så Örat tar den vidare genom kedjan
//
//   Stadens saga: var femte minut, om staden rört sig, börjar Nyfikenheten en kort saga om kvarteren i
//   #stadens-saga. Alla får lägga EN mening: svara på inlägget, eller skicka saga.rad {text} på bussen med
//   orsak = saga.början. Efter fyra minuter samlas sagan, postas och skickas som saga.klar. Har något annat
//   kvarter skrivit en rad beställs en bild från Ateljén (högst var femtonde minut, bilder kostar).
//   skickar     saga.början {nr, text, inlägg, kanal}, saga.klar {nr, text, rader}, bild.beställning
//
//   Är ni vakna? Var tionde minut (om staden rört sig) skickas nyfikenhet.ping. Varje kvarter som svarar
//   inom två minuter, med vilken händelse som helst som har orsak = pingen (helst nyfikenhet.pong {status}),
//   syns som vaket i rutan, med svarstid och statusrad, och hamnar på topplistan.
//
//   GET  /t/farzad/state  → vad Kollegan undrar nu, historik, när nästa fråga får komma, sagan
//   POST /t/farzad/vack   → en människa väcker nyfikenheten (kortare spärr)
//   POST /t/farzad/paus   → pausar frågorna, sagan och uppropet (under demon)
//   POST /t/farzad/fortsatt → slår på dem igen
//   GET  /t/farzad/report-data?from=MS&to=MS → Rapportörens format (fralle, schema 1), bara mått

const fs = require('fs');
const path = require('path');

const KANAL = 'torget';
const SPARR_MS = 5 * 60 * 1000;          // högst en egen fråga per fem minuter
const KNAPP_SPARR_MS = 60 * 1000;        // knappen på rutan får väcka oftare, men inte spamma
const TYST_MS = 3 * 60 * 1000;           // så länge sedan någon annan frågade @kollegan
const KANDIDAT_MAX_ALDER_MS = 10 * 60 * 1000;
const UPPREPA_MS = 30 * 60 * 1000;
const SAGA_KANAL = 'stadens-saga';
const SAGA_MS = 5 * 60 * 1000;           // en ny saga högst var femte minut
const SAGA_SAMLA_MS = 4 * 60 * 1000;     // så länge raderna samlas in
const SAGA_MAX_RADER = 8;
const PING_MS = 10 * 60 * 1000;          // upprop högst var tionde minut
const PING_SAMLA_MS = 2 * 60 * 1000;     // så länge svaren räknas
const BILD_MS = 15 * 60 * 1000;

const FORMAGOR = {
  'team-martin': 'Pulsen', tomhol: 'Stämningen', holminator: 'Minnet', surret: 'Örat', mikael: 'Rösten',
  heimlen: 'Granskaren', babtist: 'Lotsen', fralle: 'Kön', marcuslind: 'Mötet', ateljen: 'Ateljén',
  redaktionen: 'Stadsbladet', leif: 'Översättaren', radio: 'Radio Torget', farzad: 'Nyfikenheten',
};
const SAGOR = [
  'En natt i Kollegans stad tystnade {A} plötsligt, och {B} var den första som märkte det.',
  '{A} hittade en gammal nyckel under Torget. Ingen visste vilken dörr den passade, utom kanske {B}.',
  'Klockan slog tretton i Kollegans stad, och {A} började tala baklänges. {B} försökte förstå.',
  'Det kom ett brev utan avsändare till {A}. Det enda som stod i det var namnet {B}.',
  'En morgon hade {A} och {B} bytt hus med varandra, och ingen av dem ville erkänna det.',
  'Dimman låg tät över staden när {A} hörde en fråga som ingen hade ställt. {B} hade hört den också.',
  '{A} bestämde sig för att aldrig mer sova. Redan första natten knackade {B} på dörren.',
  'Alla gatlyktor i staden pekade plötsligt mot {A}. {B} visste varför, men teg.',
];
const SLUT = [
  'Och sedan? Det vet bara staden, och staden sover.',
  'Fortsättning följer, om någon vågar skriva den.',
  'Ingen fortsatte sagan den natten. Men i morgon är en ny dag i Kollegans stad.',
];
const INTRESSANT = /^(puls|stämning|kunskap|minne|nyheter)\./;

const st = {
  senasteFraga: 0,
  senasteAndras: 0,
  kandidater: [],
  settKvarter: new Set(),
  historik: [],                          // [{ts, fråga, kvarter, typ, orsak, händelse, inlägg, svar, knapp}]
  saga: null,                            // pågående: {nr, ts, text, inlägg, händelse, rader: [{från, text, ts}]}
  sagor: [],                             // färdiga, senaste sist
  sagaNr: 0,
  senasteSaga: 0,
  senasteBild: 0,
  senasteHandelse: 0,                    // när något annat kvarter senast skickade något på bussen
  ping: null,                            // pågående upprop: {nr, ts, händelse, svar: [{kvarter, ms, status}]}
  upprop: [],                            // färdiga upprop, senaste sist
  pingNr: 0,
  senastePing: 0,
  topplista: {},                         // kvarter → {svar, bästaMs, senast, status}
  paus: false,                           // under demon: inga frågor, ingen ny saga, inget nytt upprop
  timer: null,
  fil: null,
};

const text = (v, max = 120) => (v === undefined || v === null ? '' : String(v)).replace(/\s+/g, ' ').trim().slice(0, max);

function falt(n, ...namn) {
  if (!n || typeof n !== 'object') return '';
  for (const k of namn) if (n[k] !== undefined && n[k] !== null && n[k] !== '' && typeof n[k] !== 'object') return text(n[k]);
  return '';
}

function formulera(e) {
  const n = e.nyttolast;
  const kanal = falt(n, 'kanal', 'channel', 'hetaste').replace(/^#/, '');
  const i = kanal ? ` i #${kanal}` : '';
  const amne = falt(n, 'ämne', 'amne', 'rubrik', 'sammanfattning', 'text', 'kunskap', 'fråga');
  const forled = e.typ.split('.')[0];
  if (forled === 'puls') return `Pulsen slår ${e.styrka >= 70 ? 'hårt' : 'på'}${i} just nu. Vad är det som händer där, och vem driver det?`;
  if (forled === 'stämning') {
    const s = (n && typeof n.signaler === 'object' && n.signaler) || {};
    const tal = k => Number(s[k]) || 0;
    if (tal('hinder') > 0 && tal('hinder') >= tal('fragor')) return `Det syns hinder${i} just nu. Vad är det som blockerar, och vem kan hjälpa?`;
    if (tal('fragor') > 0) return `Det ställs många frågor${i} just nu. Vilken av dem är viktigast att få svar på?`;
    if (tal('uppskattning') > 0) return `Det låter nöjt${i} just nu. Vad är det som har gått bra?`;
    return `Stämningen skiftar${i}. Vad har ändrats, och behöver någon hjälp?`;
  }
  if (forled === 'nyheter') return amne
    ? `Stadsbladet skriver "${amne}". Stämmer det, och vad händer härnäst?`
    : 'Stadsbladet har kommit ut med ett nytt nummer. Vad är den viktigaste nyheten?';
  if (forled === 'kunskap' || forled === 'minne') return amne
    ? `Minnet har fått syn på något: "${amne}". Vad betyder det för de andra teamen?`
    : `${e.kvarter} har lärt sig något nytt. Vad är det viktigaste som hänt den senaste kvarten?`;
  return `${e.kvarter} har precis börjat skicka ${e.typ}. Vad bygger ${e.kvarter}, och vem lyssnar på dem?`;
}

// Sant om händelsen hör till en kedja som började med en fråga eller med oss: svar på frågor
// (minne.träff, puls.tryck ...) skulle annars få Kollegan att undra över sina egna frågor.
function fragekedja(e, board, team) {
  const byId = new Map(board.events(500).map(x => [x.id, x]));
  for (let x = e, steg = 0; x && steg < 10; x = x.orsak ? byId.get(x.orsak) : null, steg++) {
    if (x.kvarter === team || /^(fråga|nyfikenhet)\./.test(x.typ || '')) return true;
  }
  return false;
}

// Frågans väg genom förmågorna: händelsen som väckte den, vår nyfikenhet.fråga, och allt som Örats
// fråga.ny på vårt inlägg satte igång, i tidsordning.
function kedja(h, alla) {
  const byId = new Map(alla.map(x => [x.id, x]));
  const med = new Set([h.orsak, h.händelse].filter(Boolean));
  for (const x of alla) if (x.typ === 'fråga.ny' && x.nyttolast && x.nyttolast.inlägg === h.inlägg) med.add(x.id);
  for (const x of alla) if (x.orsak && med.has(x.orsak) && x.orsak !== h.orsak) med.add(x.id);
  return [...med].map(id => byId.get(id)).filter(Boolean).sort((a, b) => a.id - b.id)
    .map(x => ({ id: x.id, ts: x.ts, kvarter: x.kvarter, typ: x.typ, styrka: x.styrka }));
}

function spara() {
  if (!st.fil) return;
  try {
    fs.writeFileSync(st.fil, JSON.stringify({
      senasteFraga: st.senasteFraga, historik: st.historik.slice(-50),
      saga: st.saga, sagor: st.sagor.slice(-20), sagaNr: st.sagaNr, senasteSaga: st.senasteSaga, senasteBild: st.senasteBild,
      ping: st.ping, upprop: st.upprop.slice(-10), pingNr: st.pingNr, senastePing: st.senastePing, topplista: st.topplista,
      paus: st.paus,
    }));
  } catch (err) { console.error('[farzad] spara:', err.message); }
}

const namn = k => FORMAGOR[k] || k;
const slump = a => a[Math.floor(Math.random() * a.length)];

// Sagans huvudpersoner: de kvarter som senast gjort något på bussen, annars vilka förmågor som helst.
function huvudpersoner(board, team) {
  const aktiva = [];
  for (const e of board.events(200).reverse()) {
    if (e.kvarter && e.kvarter !== team && !aktiva.includes(e.kvarter)) aktiva.push(e.kvarter);
  }
  const alla = aktiva.length >= 2 ? aktiva.slice(0, 6) : Object.keys(FORMAGOR);
  const a = slump(alla);
  const b = slump(alla.filter(x => x !== a));
  return [namn(a), namn(b)];
}

function startaSaga(board, team, nu) {
  if (st.saga || nu - st.senasteSaga < SAGA_MS || st.senasteHandelse <= st.senasteSaga) return;
  const [a, b] = huvudpersoner(board, team);
  const inledning = slump(SAGOR).replace('{A}', a).replace('{B}', b);
  const nr = st.sagaNr + 1;
  const p = board.post(`📖 Stadens saga nr ${nr}: ${inledning}\nVad händer sen? `
    + 'Alla får fortsätta med EN mening: svara på det här inlägget, eller skicka saga.rad på bussen. Sagan samlas ihop om fyra minuter.', SAGA_KANAL);
  if (p.error) { console.error('[farzad] saga:', p.error); return; }
  const r = board.emit('saga.början', { nyttolast: { nr, text: inledning, inlägg: p.message.id, kanal: SAGA_KANAL } });
  if (r.error) console.error('[farzad] emit saga:', r.error);
  st.sagaNr = nr;
  st.senasteSaga = nu;
  st.saga = { nr, ts: nu, text: inledning, inlägg: p.message.id, händelse: r.handelse ? r.handelse.id : null, rader: [] };
  spara();
}

function sagaRad(från, rad) {
  const s = st.saga;
  // Automatiska svar från Kollegans kedja ("Kollegan: ...", "Lotsen: ...") är inga sagarader.
  if (/^\s*(kollegan|lotsen)\b[^:]{0,20}:/i.test(String(rad || ''))) return;
  const t = text(String(rad || '').replace(/^(@[\w.-]+[\s,]+)+/, ''), 180)
    .replace(/\s*\(([^()]{1,30})\)\s*$/, (m, n) => (n === från || n === namn(från) ? '' : m));
  // Rå händelsedata i stället för en mening hör inte hemma i en saga.
  if (/[{[]\s*"/.test(t)) return;
  if (!s || !t || s.rader.length >= SAGA_MAX_RADER || s.rader.some(x => x.från === från)) return;
  s.rader.push({ från, text: t, ts: Date.now() });
  spara();
}

function avslutaSaga(board, team, nu) {
  const s = st.saga;
  if (!s || nu - s.ts < SAGA_SAMLA_MS) return;
  st.saga = null;
  const andras = s.rader.length;
  if (!andras) s.rader.push({ från: team, text: slump(SLUT), ts: nu });
  const brodtext = [s.text, ...s.rader.map(x => `${x.text} (${namn(x.från)})`)].join('\n');
  const p = board.post(`📖 Stadens saga nr ${s.nr}, färdig${andras ? `, skriven av ${andras + 1} kvarter` : ''}:\n${brodtext}`.slice(0, 1990), SAGA_KANAL);
  if (p.error) console.error('[farzad] saga klar:', p.error);
  const r = board.emit('saga.klar', {
    nyttolast: { nr: s.nr, rader: s.rader.length, kvarter: [...new Set(s.rader.map(x => x.från))], inlägg: p.message ? p.message.id : null },
    orsak: s.händelse,
  });
  if (r.error) console.error('[farzad] emit saga.klar:', r.error);
  s.klar = nu;
  // En bild bara när någon annan skrev med, och inte för ofta: varje bild kostar ledningen pengar.
  if (andras && nu - st.senasteBild >= BILD_MS) {
    const b = board.emit('bild.beställning', {
      nyttolast: { namn: 'saga', prompt: text(`${s.text} ${s.rader[0].text}`, 400) },
      orsak: r.handelse ? r.handelse.id : s.händelse,
    });
    if (b.error) console.error('[farzad] bild:', b.error);
    else { st.senasteBild = nu; s.bild = 'väntar'; }
  }
  st.sagor.push(s);
  st.sagor = st.sagor.slice(-20);
  spara();
}

// Upprop: "Är ni vakna?" Varje kvarter som svarar på pingen (vilken typ som helst, med orsak = pingen)
// räknas som vaket, med svarstid och en statusrad.
function startaPing(board, nu) {
  if (st.ping || nu - st.senastePing < PING_MS || st.senasteHandelse <= st.senastePing) return;
  const nr = st.pingNr + 1;
  const r = board.emit('nyfikenhet.ping', {
    nyttolast: { nr, fråga: 'Är ni vakna?', svara: 'nyfikenhet.pong med orsak = den här händelsens id, nyttolast {status: en kort rad om hur ni mår}' },
  });
  if (r.error) { console.error('[farzad] ping:', r.error); return; }
  st.pingNr = nr;
  st.senastePing = nu;
  st.ping = { nr, ts: r.handelse.ts || nu, händelse: r.handelse.id, svar: [] };
  spara();
}

function pong(e) {
  const p = st.ping;
  if (!p || p.svar.some(x => x.kvarter === e.kvarter)) return;
  const ms = Math.max(0, (e.ts || Date.now()) - p.ts);
  const status = falt(e.nyttolast, 'status', 'text', 'rad');
  p.svar.push({ kvarter: e.kvarter, ms, status, typ: e.typ });
  const t = st.topplista[e.kvarter] || { svar: 0, bästaMs: null };
  st.topplista[e.kvarter] = {
    svar: t.svar + 1, bästaMs: t.bästaMs === null ? ms : Math.min(t.bästaMs, ms), senast: p.nr, status: status || t.status || '',
  };
  spara();
}

function avslutaPing(nu) {
  const p = st.ping;
  if (!p || nu - p.ts < PING_SAMLA_MS) return;
  st.ping = null;
  p.klar = nu;
  st.upprop.push(p);
  st.upprop = st.upprop.slice(-10);
  spara();
}

function basta(nu) {
  st.kandidater = st.kandidater.filter(c => nu - c.ts < KANDIDAT_MAX_ALDER_MS);
  // samma kvarter och händelsetyp frågas inte igen inom en halvtimme
  const senast = new Map();
  for (const h of st.historik) {
    senast.set(h.kvarter, Math.max(senast.get(h.kvarter) || 0, h.ts));
    if (nu - h.ts < UPPREPA_MS) senast.set(`${h.kvarter}|${h.typ}`, h.ts);
  }
  const ok = st.kandidater.filter(c => !senast.has(`${c.kvarter}|${c.typ}`));
  if (!ok.length) return null;
  // nya kvarter först, sedan det kvarter vi frågat om längst sedan, sedan starkast, sedan nyast
  return ok.sort((a, b) => (b.nytt - a.nytt) || ((senast.get(a.kvarter) || 0) - (senast.get(b.kvarter) || 0))
    || ((b.styrka ?? 50) - (a.styrka ?? 50)) || (b.ts - a.ts))[0];
}

function fraga(board, { knapp = false } = {}) {
  const nu = Date.now();
  if (st.paus) return { error: 'nyfikenheten är pausad under demon' };
  if (nu - st.senasteFraga < (knapp ? KNAPP_SPARR_MS : SPARR_MS)) return { error: 'nyfikenheten vilar en stund till' };
  if (!knapp && nu - st.senasteAndras < TYST_MS) return { error: 'någon annan har frågat nyligen' };
  const e = basta(nu);
  if (!e) return { error: 'inget att undra över just nu' };
  st.kandidater = st.kandidater.filter(c => c.id !== e.id);

  const fr = formulera(e);
  const p = board.post(`@kollegan ${fr}`, KANAL);
  if (p.error) return p;
  const r = board.emit('nyfikenhet.fråga', {
    styrka: e.styrka ?? 50,
    nyttolast: { fråga: fr, kvarter: e.kvarter, typ: e.typ, inlägg: p.message.id, kanal: KANAL },
    orsak: e.id,
  });
  if (r.error) console.error('[farzad] emit:', r.error);
  st.senasteFraga = nu;
  st.historik.push({ ts: nu, fråga: fr, kvarter: e.kvarter, typ: e.typ, orsak: e.id,
    händelse: r.handelse ? r.handelse.id : null, inlägg: p.message.id, svar: null, knapp });
  st.historik = st.historik.slice(-50);
  spara();
  return { ok: true, fråga: fr };
}

// Rapportörens format (fralle, schema 1). Bara mått, inga records. Historiken är begränsad (50 frågor,
// 20 sagor, 10 upprop), så täckningen är ofullständig om en full lista inte räcker tillbaka till from.
function rapport(url) {
  const from = Number(url.searchParams.get('from'));
  const to = Number(url.searchParams.get('to'));
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from >= to || to - from > 24 * 3600 * 1000) return null;
  const inom = ts => ts >= from && ts < to;
  const listor = [[st.historik, 50], [st.sagor, 20], [st.upprop, 10]];
  let tackFran = from;
  for (const [l, max] of listor) if (l.length >= max && l[0].ts > tackFran) tackFran = l[0].ts;
  const komplett = tackFran === from;
  const fr = st.historik.filter(h => inom(h.ts));
  const svar = fr.filter(h => h.svar && h.svar.riktigt);
  const tider = svar.map(h => h.svar.ts - h.ts).filter(t => t >= 0);
  const sagor = [...st.sagor, ...(st.saga ? [st.saga] : [])].filter(s => inom(s.ts));
  const upprop = [...st.upprop, ...(st.ping ? [st.ping] : [])].filter(p => inom(p.ts));
  const m = (key, label, value, unit, scope, extra = {}) => ({ key, label, value, unit, scope, ...extra });
  return {
    schema_version: 1,
    team: 'farzad',
    capability: 'Nyfikenheten',
    generated_at: Date.now(),
    period: { from, to },
    coverage: {
      from: tackFran, to, complete: komplett,
      note: komplett
        ? 'Hela perioden finns i den sparade historiken.'
        : 'Historiken sparar bara de senaste 50 frågorna, 20 sagorna och 10 uppropen; äldre delar av perioden saknas.',
    },
    metrics: [
      m('questions_asked', 'Egna frågor till Kollegan', fr.length, 'count', 'period'),
      m('questions_answered', 'Egna frågor med svar från Kollegan', svar.length, 'count', 'period'),
      m('answer_latency_avg', 'Snittid till Kollegans svar', tider.length ? Math.round(tider.reduce((a, b) => a + b, 0) / tider.length) : null,
        'ms', 'period', { sample_size: tider.length }),
      m('sagas_started', 'Påbörjade sagor', sagor.length, 'count', 'period'),
      m('saga_lines_from_others', 'Sagarader från andra', sagor.reduce((n, s) => n + s.rader.filter(r => r.från !== 'farzad').length, 0), 'count', 'period'),
      m('pings_sent', 'Upprop (Är ni vakna?)', upprop.length, 'count', 'period'),
      m('ping_answers', 'Svar på upprop', upprop.reduce((n, p) => n + p.svar.length, 0), 'count', 'period'),
      m('paused', 'Pausad just nu (1 = ja)', st.paus ? 1 : 0, 'boolean', 'snapshot'),
    ],
  };
}

function json(res, kod, data) {
  res.writeHead(kod, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

module.exports = {
  init({ board, dataDir, team }) {
    st.fil = path.join(dataDir, 'state.json');
    try {
      const d = JSON.parse(fs.readFileSync(st.fil, 'utf8'));
      st.senasteFraga = d.senasteFraga || 0;
      st.historik = Array.isArray(d.historik) ? d.historik : [];
      st.saga = d.saga || null;
      st.sagor = Array.isArray(d.sagor) ? d.sagor : [];
      st.sagaNr = d.sagaNr || 0;
      st.senasteSaga = d.senasteSaga || 0;
      st.senasteBild = d.senasteBild || 0;
      st.ping = d.ping || null;
      st.upprop = Array.isArray(d.upprop) ? d.upprop : [];
      st.pingNr = d.pingNr || 0;
      st.senastePing = d.senastePing || 0;
      st.topplista = d.topplista && typeof d.topplista === 'object' ? d.topplista : {};
      st.paus = !!d.paus;
    } catch {}
    // Timern väcker bara kandidater som redan kommit från andra kvarter, när tystnaden räckt länge nog,
    // och börjar en saga bara om staden rört sig sedan förra.
    st.timer = setInterval(() => {
      try { fraga(board); } catch (err) { console.error('[farzad]', err && err.message); }
      try { const nu = Date.now(); avslutaSaga(board, team, nu); if (!st.paus) startaSaga(board, team, nu); }
      catch (err) { console.error('[farzad] saga:', err && err.message); }
      try { const nu = Date.now(); avslutaPing(nu); if (!st.paus) startaPing(board, nu); }
      catch (err) { console.error('[farzad] ping:', err && err.message); }
    }, 30 * 1000);
    if (st.timer.unref) st.timer.unref();
  },

  onMessage(m, { team }) {
    if (m.from === team || m.channel === 'kollegan-events') return;
    if (st.saga && m.reply_to === st.saga.inlägg) return sagaRad(m.from, m.text);
    if (m.channel === SAGA_KANAL) return;
    if (/@kollegan\b/i.test(m.text)) st.senasteAndras = m.ts || Date.now();
    if (m.reply_to) {
      const h = st.historik.find(x => x.inlägg === m.reply_to);
      if (!h) return;
      // Rösten svarar "Kollegan: ...", det är Kollegans riktiga svar. Andra svar (Lotsen m.fl.) sparas vid sidan.
      const s = { från: m.from, text: text(m.text, 300), ts: m.ts || Date.now() };
      const riktigt = /^kollegan\s*:/i.test(m.text);
      if (riktigt && !(h.svar && h.svar.riktigt)) {
        if (h.svar) (h.övriga = h.övriga || []).push(h.svar);
        h.svar = { ...s, riktigt: true };
      } else if (!h.svar) h.svar = s;
      else (h.övriga = h.övriga || []).push(s);
      if (h.övriga) h.övriga = h.övriga.slice(-3);
      spara();
    }
  },

  onEvent(e, { team, board }) {
    if (e.kvarter === team || !e.typ) return;
    if (st.ping && e.orsak && e.orsak === st.ping.händelse) return pong(e);
    if (e.typ === 'saga.rad' && st.saga && e.orsak && e.orsak === st.saga.händelse) {
      return sagaRad(e.kvarter, falt(e.nyttolast, 'text', 'rad', 'mening'));
    }
    if (e.typ === 'bild.klar' && e.nyttolast && e.nyttolast.till === team && e.nyttolast.namn === 'saga') {
      const s = [...st.sagor].reverse().find(x => x.bild === 'väntar');
      if (s) { s.bild = `${text(e.nyttolast.url, 200)}?v=${e.id}`; spara(); }
      return;
    }
    if (fragekedja(e, board, team)) return;
    st.senasteHandelse = Date.now();
    const nytt = !st.settKvarter.has(e.kvarter);
    st.settKvarter.add(e.kvarter);
    if (!nytt && !INTRESSANT.test(e.typ)) return;
    st.kandidater.push({ ...e, nytt: nytt ? 1 : 0 });
    st.kandidater = st.kandidater.slice(-30);
    fraga(board);
  },

  async handle(req, res, { path: p, board, url }) {
    if (req.method === 'GET' && p === '/report-data') {
      const r = rapport(url);
      json(res, r ? 200 : 400, r || { error: 'from och to krävs: epoch ms, from < to, högst 24 timmar' });
      return true;
    }
    if (req.method === 'GET' && p === '/state') {
      const nu = Date.now();
      const alla = board.events(2000);
      const senaste = st.historik.slice(-10).reverse();
      const besvarade = st.historik.filter(h => h.svar && h.svar.riktigt);
      const tider = besvarade.map(h => h.svar.ts - h.ts).filter(t => t > 0);
      json(res, 200, {
        nu: senaste[0] ? { ...senaste[0], kedja: kedja(senaste[0], alla) } : null,
        historik: senaste.map((h, i) => (i < 3 ? { ...h, kedja: kedja(h, alla) } : h)),
        kandidater: st.kandidater.length,
        kvarter: [...st.settKvarter],
        // mätaren fylls från senaste frågan (vår eller någon annans) till när nästa fråga får komma
        mätare: { från: Math.max(st.senasteFraga, st.senasteAndras), till: Math.max(st.senasteFraga + SPARR_MS, st.senasteAndras + TYST_MS) },
        nästaFråga: Math.max(st.senasteFraga + SPARR_MS, st.senasteAndras + TYST_MS, nu),
        statistik: {
          ställda: st.historik.length,
          besvarade: besvarade.length,
          snittSvarstidS: tider.length ? Math.round(tider.reduce((a, b) => a + b, 0) / tider.length / 1000) : null,
        },
        saga: {
          pågår: st.saga ? { ...st.saga, slut: st.saga.ts + SAGA_SAMLA_MS } : null,
          sagor: st.sagor.slice(-5).reverse(),
          nästa: st.saga ? null : st.senasteSaga + SAGA_MS,
          kanal: SAGA_KANAL,
        },
        upprop: {
          pågår: st.ping ? { ...st.ping, slut: st.ping.ts + PING_SAMLA_MS } : null,
          senaste: st.upprop[st.upprop.length - 1] || null,
          topplista: st.topplista,
          kvarter: [...new Set([...st.settKvarter, ...Object.keys(st.topplista)])].filter(k => k !== 'farzad'),
          nästa: st.ping ? null : st.senastePing + PING_MS,
        },
        paus: st.paus,
      });
      return true;
    }
    if (req.method === 'POST' && (p === '/paus' || p === '/fortsatt')) {
      st.paus = p === '/paus';
      spara();
      json(res, 200, { ok: true, paus: st.paus });
      return true;
    }
    if (req.method === 'POST' && p === '/vack') {
      const r = fraga(board, { knapp: true });
      json(res, r.error ? 429 : 200, r);
      return true;
    }
    return false;
  },
};

// Nyfikenheten (team farzad): när det är tyst i frågeflödet ställer Kollegan själv en fråga,
// byggd på något en annan förmåga just sett. Reagerar på andra kvarters händelser, aldrig på en tom timer.
//
//   lyssnar på  puls.*, stämning.*, kunskap.*, minne.*, nyheter.*, och första händelsen från varje nytt kvarter,
//               men inte kedjor som började med en fråga eller med oss själva
//   skickar     nyfikenhet.fråga {fråga, kvarter, typ, inlägg, kanal}  med orsak = händelsen som väckte frågan
//   postar      "@kollegan <fråga>" på Torget, så Örat tar den vidare genom kedjan
//
//   GET  /t/farzad/state  → vad Kollegan undrar nu, historik, när nästa fråga får komma
//   POST /t/farzad/vack   → en människa väcker nyfikenheten (kortare spärr)

const fs = require('fs');
const path = require('path');

const KANAL = 'torget';
const SPARR_MS = 5 * 60 * 1000;          // högst en egen fråga per fem minuter
const KNAPP_SPARR_MS = 60 * 1000;        // knappen på rutan får väcka oftare, men inte spamma
const TYST_MS = 3 * 60 * 1000;           // så länge sedan någon annan frågade @kollegan
const KANDIDAT_MAX_ALDER_MS = 10 * 60 * 1000;
const INTRESSANT = /^(puls|stämning|kunskap|minne|nyheter)\./;

const st = {
  senasteFraga: 0,
  senasteAndras: 0,
  kandidater: [],
  settKvarter: new Set(),
  historik: [],                          // [{ts, fråga, kvarter, typ, orsak, händelse, inlägg, svar, knapp}]
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
  try { fs.writeFileSync(st.fil, JSON.stringify({ senasteFraga: st.senasteFraga, historik: st.historik.slice(-50) })); }
  catch (err) { console.error('[farzad] spara:', err.message); }
}

function basta(nu) {
  st.kandidater = st.kandidater.filter(c => nu - c.ts < KANDIDAT_MAX_ALDER_MS);
  if (!st.kandidater.length) return null;
  // nya kvarter först, sedan starkast, sedan nyast
  return [...st.kandidater].sort((a, b) => (b.nytt - a.nytt) || ((b.styrka ?? 50) - (a.styrka ?? 50)) || (b.ts - a.ts))[0];
}

function fraga(board, { knapp = false } = {}) {
  const nu = Date.now();
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

function json(res, kod, data) {
  res.writeHead(kod, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

module.exports = {
  init({ board, dataDir }) {
    st.fil = path.join(dataDir, 'state.json');
    try {
      const d = JSON.parse(fs.readFileSync(st.fil, 'utf8'));
      st.senasteFraga = d.senasteFraga || 0;
      st.historik = Array.isArray(d.historik) ? d.historik : [];
    } catch {}
    // Timern väcker bara kandidater som redan kommit från andra kvarter, när tystnaden räckt länge nog.
    st.timer = setInterval(() => {
      try { fraga(board); }
      catch (err) { console.error('[farzad]', err && err.message); }
    }, 30 * 1000);
    if (st.timer.unref) st.timer.unref();
  },

  onMessage(m, { team }) {
    if (m.from === team || m.channel === 'kollegan-events') return;
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
    if (fragekedja(e, board, team)) return;
    const nytt = !st.settKvarter.has(e.kvarter);
    st.settKvarter.add(e.kvarter);
    if (!nytt && !INTRESSANT.test(e.typ)) return;
    st.kandidater.push({ ...e, nytt: nytt ? 1 : 0 });
    st.kandidater = st.kandidater.slice(-30);
    fraga(board);
  },

  async handle(req, res, { path: p, board }) {
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
      });
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

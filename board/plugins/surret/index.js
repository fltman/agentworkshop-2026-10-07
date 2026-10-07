// Örat — Kollegans hörsel, byggt av team surret.
// Hör varje inlägg som nämner @kollegan och skickar fråga.ny på bussen #kollegan-events.
// Följer sedan kedjan (orsak) som andra förmågor bygger på frågan, så rutan på /staden kan visa
// vart frågan tog vägen. Har ingen reagerat på tre minuter skickar Örat fråga.obesvarad.
//
//   GET /t/surret/fragor   → senaste frågorna med sina kedjor
//   GET /t/surret/status   → siffror

const BUSS = 'kollegan-events';
const MAX_FRAGOR = 60;
const OBESVARAD_MS = 3 * 60 * 1000;
const SVAR_TYPER = /^svar\.(klart|granskat|översatt)$/;
const NAMNET = /@kollegan\b/i;

const st = {
  fragor: [],             // {inlägg, kanal, frågare, fråga, styrka, ts, händelse, följdTill, kedja, besvarad, obesvarad}
  perInlagg: new Map(),   // inläggs-id -> fråga
  perHandelse: new Map(), // händelse-id -> fråga (vår fråga.ny och allt som byggts på den)
  ko: [],                 // frågor som väntar på plats under takten 6/min
  svarsposter: new Set(), // kvarter som skickat svar.*: deras trådsvar på Torget hörs inte som frågor
  hört: 0,
  timer: null,
};

function tydlighet(text) {
  const t = text.replace(NAMNET, '').trim();
  let s = 40;
  if (/\?/.test(t)) s += 25;
  if (/^(vem|vad|var|när|hur|varför|vilk|kan|finns|who|what|where|when|how|why|which|can|is|are|does|do)\b/i.test(t)) s += 15;
  if (t.length > 15) s += 10;
  if (t.length > 60) s += 10;
  if (t.length < 5) s -= 30;
  return Math.max(5, Math.min(100, s));
}

function arSvarFranKollegan(m) {
  if (/^\s*kollegan\b[^:]{0,20}:/i.test(m.text)) return true;
  return st.svarsposter.has(m.from) && !!m.reply_to;
}

function rotFraga(m, board) {
  let id = m.reply_to;
  if (!id) return null;
  const alla = board.query({ limit: 1000 });
  for (let i = 0; i < 6 && id; i++) {
    if (st.perInlagg.has(id)) return st.perInlagg.get(id);
    const p = alla.find(x => x.id === id);
    id = p && p.reply_to;
  }
  return null;
}

function nyFraga(f) {
  st.fragor.push(f);
  st.perInlagg.set(f.inlägg, f);
  if (st.fragor.length > MAX_FRAGOR) {
    const ut = st.fragor.shift();
    st.perInlagg.delete(ut.inlägg);
    for (const [k, v] of st.perHandelse) if (v === ut) st.perHandelse.delete(k);
  }
}

// true = klar (skickad eller hopplös), false = takten slog i taket, försök igen senare
function skicka(f, board) {
  const r = board.emit('fråga.ny', {
    styrka: f.styrka,
    nyttolast: { fråga: f.fråga, inlägg: f.inlägg, kanal: f.kanal, frågare: f.frågare, ...(f.följdTill ? { följdfråga_till: f.följdTill } : {}) },
  });
  if (r && r.handelse) { f.händelse = r.handelse.id; st.perHandelse.set(r.handelse.id, f); return true; }
  if (r && /per minut/.test(r.error || '')) return false;
  console.error('[surret] emit fråga.ny:', r && r.error);
  f.fel = (r && r.error) || 'okänt fel';
  return true;
}

function bock(board) {
  while (st.ko.length && skicka(st.ko[0], board)) st.ko.shift();
  const nu = Date.now();
  for (const f of st.fragor) {
    if (!f.händelse || f.obesvarad || f.besvarad || f.kedja.length) continue;
    if (nu - f.ts < OBESVARAD_MS) continue;
    const r = board.emit('fråga.obesvarad', {
      styrka: f.styrka, orsak: f.händelse,
      nyttolast: { fråga: f.fråga, inlägg: f.inlägg, kanal: f.kanal, väntat_s: Math.round((nu - f.ts) / 1000) },
    });
    if (r && r.handelse) { f.obesvarad = r.handelse.id; st.perHandelse.set(r.handelse.id, f); }
    else if (r && /per minut/.test(r.error || '')) break;
    else f.obesvarad = -1;
  }
}

function harArbete() {
  return st.ko.length > 0 || st.fragor.some(f => f.händelse && !f.obesvarad && !f.besvarad && !f.kedja.length);
}

function las(e, team) {
  // Alla svar.* räknas, även svar.utkast: Rösten skickar det innan svaret postas på Torget.
  if (/^svar\./.test(e.typ) && e.kvarter !== team) st.svarsposter.add(e.kvarter);
  const n = e.nyttolast && typeof e.nyttolast === 'object' ? e.nyttolast : {};
  if (e.kvarter === team) {
    if (e.typ === 'fråga.ny' && n.inlägg && !st.perInlagg.has(n.inlägg)) {
      const f = { inlägg: n.inlägg, kanal: n.kanal, frågare: n.frågare, fråga: n.fråga, styrka: e.styrka, ts: e.ts,
        händelse: e.id, följdTill: n.följdfråga_till, kedja: [], besvarad: false, obesvarad: null };
      nyFraga(f); st.perHandelse.set(e.id, f); st.hört++;
    } else if (e.typ === 'fråga.obesvarad' && st.perHandelse.has(e.orsak)) {
      const f = st.perHandelse.get(e.orsak); f.obesvarad = e.id; st.perHandelse.set(e.id, f);
    }
    return;
  }
  let f = e.orsak ? st.perHandelse.get(e.orsak) : null;
  if (!f && n.inlägg) f = st.perInlagg.get(Number(n.inlägg));
  if (!f || f.kedja.some(k => k.id === e.id)) return;
  st.perHandelse.set(e.id, f);
  f.kedja.push({ id: e.id, typ: e.typ, kvarter: e.kvarter, styrka: e.styrka, djup: e.djup, ts: e.ts, orsak: e.orsak });
  if (SVAR_TYPER.test(e.typ)) f.besvarad = true;
}

function json(res, code, data) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
  return true;
}

module.exports = {
  init({ board, team }) {
    for (const e of board.events(1000)) las(e, team); // läs tillbaka efter omstart
    st.timer = setInterval(() => {
      try { if (harArbete()) bock(board); }
      catch (err) { console.error('[surret]', err && err.message); }
    }, 10000);
    if (st.timer.unref) st.timer.unref();
  },

  onMessage(m, { board, team }) {
    if (m.channel === BUSS || m.from === team) return;
    if (!NAMNET.test(m.text) || arSvarFranKollegan(m) || st.perInlagg.has(m.id)) return;
    const rot = rotFraga(m, board);
    const f = {
      inlägg: m.id, kanal: m.channel, frågare: m.from, fråga: m.text.slice(0, 500), styrka: tydlighet(m.text), ts: m.ts,
      händelse: null, följdTill: rot ? rot.inlägg : undefined, kedja: [], besvarad: false, obesvarad: null,
    };
    st.hört++;
    nyFraga(f);
    if (st.ko.length || !skicka(f, board)) st.ko.push(f);
  },

  onEvent(e, { team }) { las(e, team); },

  async handle(req, res, { path }) {
    if (req.method !== 'GET') return false;
    if (path === '/fragor') {
      return json(res, 200, st.fragor.slice(-25).reverse().map(f => ({
        inlägg: f.inlägg, kanal: f.kanal, frågare: f.frågare, fråga: f.fråga, styrka: f.styrka, ts: f.ts,
        händelse: f.händelse, följdTill: f.följdTill || null, iKo: !f.händelse && !f.fel,
        besvarad: f.besvarad, obesvarad: !!(f.obesvarad && f.obesvarad > 0), kedja: f.kedja,
      })));
    }
    if (path === '/status' || path === '/' || path === '') {
      return json(res, 200, {
        förmåga: 'Örat', hört: st.hört, frågor: st.fragor.length, iKo: st.ko.length,
        besvarade: st.fragor.filter(f => f.besvarad).length,
        väntar: st.fragor.filter(f => f.händelse && !f.besvarad).length,
      });
    }
    return false;
  },
};

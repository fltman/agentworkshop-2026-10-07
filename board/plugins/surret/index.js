// Örat — Kollegans hörsel, byggt av team surret.
// Hör varje inlägg som nämner @kollegan och skickar fråga.ny på bussen #kollegan-events.
// Följer sedan kedjan (orsak) som andra förmågor bygger på frågan, så rutan på /staden kan visa
// vart frågan tog vägen. Har ingen reagerat på tre minuter skickar Örat fråga.obesvarad.
// fråga.ny bär frågans språk (sv/en). Samma fråga inom fem minuter får ingen ny kedja, bara en
// hänvisning till den första. Ateljens bild.klar till surret visas som porträtt i rutan när den
// öppnas fristående (på /staden visar ramen redan porträttet).
//
//   GET /t/surret/fragor   → senaste frågorna med sina kedjor
//   GET /t/surret/status   → siffror
//   GET /t/surret/report-data?from=MS&to=MS → Rapportörens format (fralle), inflödet av frågor

const BUSS = 'kollegan-events';
const MAX_FRAGOR = 60;
const OBESVARAD_MS = 3 * 60 * 1000;
const SVAR_TYPER = /^svar\.(klart|granskat|översatt)$/;
const NAMNET = /@kollegan\b/i;
const DUBBLETT_MS = 5 * 60 * 1000;
const SV_ORD = /^(och|är|vad|vem|hur|varför|vilken|vilka|när|det|att|jag|vi|ni|inte|kan|någon|finns|som|på|med|för|om|har|en|ett|till|bygger|vet)$/;
const EN_ORD = /^(the|is|what|who|how|why|which|when|and|to|of|can|does|do|are|you|we|in|it|anyone|there|has|have|a|an|building|know)$/;

const st = {
  fragor: [],             // {inlägg, kanal, frågare, fråga, styrka, ts, händelse, följdTill, kedja, besvarad, obesvarad}
  perInlagg: new Map(),   // inläggs-id -> fråga
  perHandelse: new Map(), // händelse-id -> fråga (vår fråga.ny och allt som byggts på den)
  ko: [],                 // frågor som väntar på plats under takten 6/min
  svarsposter: new Set(), // kvarter som skickat svar.*: deras trådsvar på Torget hörs inte som frågor
  hört: 0,
  dubbletter: 0,
  start: Date.now(),
  kvarter: new Set(),     // alla som skickat händelser: deras frågor räknas som audience=agent
  portratt: null,         // ateljens bild.klar till surret: {url, prompt, ts}
  timer: null,
};

// Frågans språk, så Översättaren och Rösten vet vad de ska svara på.
function sprak(text) {
  const t = text.replace(/@[\w.-]+/g, ' ').replace(/https?:\/\/\S+/g, ' ').toLowerCase();
  const ord = t.split(/[^a-zåäöéü]+/).filter(Boolean);
  let sv = ord.filter(o => SV_ORD.test(o)).length + (/[åäö]/.test(t) ? 2 : 0);
  let en = ord.filter(o => EN_ORD.test(o)).length;
  return en > sv ? 'en' : 'sv';
}

function normalisera(text) {
  return text.replace(/@[\w.-]+/g, ' ').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function hittaDubblett(norm, ts) {
  if (norm.length < 8) return null;
  for (let i = st.fragor.length - 1; i >= 0; i--) {
    const f = st.fragor[i];
    if (ts - f.ts > DUBBLETT_MS) break;
    if (!f.dubblettAv && !f.fel && f.norm === norm) return f;
  }
  return null;
}

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

// Ett tilltal, inte ett omnämnande: "@kollegan vem bygger minnet?" ja, "Örat hör @kollegan och ..." nej.
function arTilltal(m) {
  const t = m.text.trim();
  if (/^(@[\w.-]+[\s,]+)*@kollegan\b/i.test(t)) return true;
  if (m.channel === 'bygge') return false; // statusinlägg om Kollegan: bara tilltal i början räknas
  if (t.length > 280 || !/\?/.test(t)) return false;
  return /(^|[\s(,;.!])@kollegan\b(?!\s*["'`”»])/i.test(t) && !/["'`“«]\s*@kollegan/i.test(t);
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
    nyttolast: { fråga: f.fråga, inlägg: f.inlägg, kanal: f.kanal, frågare: f.frågare, språk: f.språk, ...(f.följdTill ? { följdfråga_till: f.följdTill } : {}) },
  });
  if (r && r.handelse) { f.händelse = r.handelse.id; f.händelseTs = r.handelse.ts || Date.now(); st.perHandelse.set(r.handelse.id, f); return true; }
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
  if (e.kvarter) st.kvarter.add(e.kvarter);
  // Alla svar.* räknas, även svar.utkast: Rösten skickar det innan svaret postas på Torget.
  if (/^svar\./.test(e.typ) && e.kvarter !== team) st.svarsposter.add(e.kvarter);
  const n = e.nyttolast && typeof e.nyttolast === 'object' ? e.nyttolast : {};
  if (e.typ === 'bild.klar' && n.till === team && n.namn === 'portratt' && typeof n.url === 'string' && /^\/t\/[\w-]+\//.test(n.url)) {
    st.portratt = { url: n.url, prompt: String(n.prompt || '').slice(0, 300), ts: e.ts };
    return;
  }
  if (e.kvarter === team) {
    if (e.typ === 'fråga.ny' && n.inlägg && !st.perInlagg.has(n.inlägg)) {
      const f = { inlägg: n.inlägg, kanal: n.kanal, frågare: n.frågare, fråga: n.fråga, styrka: e.styrka, ts: e.ts,
        språk: n.språk || sprak(String(n.fråga || '')), norm: normalisera(String(n.fråga || '')),
        händelse: e.id, händelseTs: e.ts, följdTill: n.följdfråga_till, kedja: [], besvarad: false, obesvarad: null };
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

function besvaradVid(f) {
  const k = f.kedja.find(x => x.typ === 'svar.klart') || f.kedja.find(x => SVAR_TYPER.test(x.typ));
  return k ? k.ts : null;
}

// Rapportörens format (fralle, #bygge 677): bara det Örat själv observerat, saknat = null.
function rapport(url, team) {
  const from = Number(url.searchParams.get('from'));
  const to = Number(url.searchParams.get('to'));
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return null;
  const iPeriod = st.fragor.filter(f => f.ts >= from && f.ts < to);
  const minnetFran = st.fragor.length ? Math.min(st.fragor[0].ts, st.start) : st.start;
  const komplett = from >= minnetFran && st.fragor.length < MAX_FRAGOR;
  const records = iPeriod.map(f => ({
    question_id: f.händelse || null,
    received_at: f.händelseTs || null, // fråga.ny-händelsens ts, så den matchar Köns rotpost
    answered_at: besvaradVid(f),
    cancelled_at: null,
    audience: st.kvarter.has(f.frågare) ? 'agent' : 'unknown',
    useful: null,
    saved_minutes: null,
    heard_at: f.ts,
    inlägg: f.inlägg, kanal: f.kanal, frågare: f.frågare, språk: f.språk || null,
    följdfråga_till: f.följdTill || null, dubblett_av: f.dubblettAv || null,
    flaggad_obesvarad: !!(f.obesvarad && f.obesvarad > 0),
  }));
  const tider = records.filter(r => r.answered_at && r.received_at).map(r => r.answered_at - r.received_at).sort((a, b) => a - b);
  const m = (key, label, value, unit, scope) => ({ key, label, value, unit, scope });
  const n = pred => iPeriod.filter(pred).length;
  return {
    schema_version: 1, team, capability: 'Örat', generated_at: Date.now(),
    period: { from, to },
    coverage: {
      from: minnetFran, to: Date.now(), complete: komplett,
      note: `Örat minns de senaste ${MAX_FRAGOR} frågorna och läser om dem från bussen (senaste 1000 händelserna) vid omstart. `
        + 'Dubbletter syns bara sedan senaste omstart: de skickas aldrig på bussen. audience=agent betyder att frågaren också skickat händelser.',
    },
    metrics: [
      m('questions_heard', 'Hörda frågor till @kollegan', iPeriod.length, 'count', 'period'),
      m('questions_sent', 'Skickade som fråga.ny', n(f => f.händelse), 'count', 'period'),
      m('questions_answered', 'Besvarade (svar.* i kedjan)', n(f => f.besvarad), 'count', 'period'),
      m('questions_flagged_unanswered', 'fråga.obesvarad efter 3 min', n(f => f.obesvarad && f.obesvarad > 0), 'count', 'period'),
      m('duplicates', 'Dubbletter med hänvisning', n(f => f.dubblettAv), 'count', 'period'),
      m('follow_ups', 'Följdfrågor', n(f => f.följdTill), 'count', 'period'),
      m('lang_sv', 'Frågor på svenska', n(f => f.språk === 'sv'), 'count', 'period'),
      m('lang_en', 'Frågor på engelska', n(f => f.språk === 'en'), 'count', 'period'),
      m('median_time_to_answer', 'Median tid till svar', tider.length ? tider[Math.floor(tider.length / 2)] : null, 'ms', 'period'),
      m('queued_now', 'I kö under bussens takt', st.ko.length, 'count', 'snapshot'),
      m('questions_retained', 'Frågor i minnet', st.fragor.length, 'count', 'retained'),
    ],
    records,
  };
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
    if (!NAMNET.test(m.text) || !arTilltal(m) || arSvarFranKollegan(m) || st.perInlagg.has(m.id)) return;
    const rot = rotFraga(m, board);
    const norm = normalisera(m.text);
    const f = {
      inlägg: m.id, kanal: m.channel, frågare: m.from, fråga: m.text.slice(0, 500), styrka: tydlighet(m.text), ts: m.ts,
      språk: sprak(m.text), norm,
      händelse: null, följdTill: rot ? rot.inlägg : undefined, kedja: [], besvarad: false, obesvarad: null,
    };
    st.hört++;
    const orig = rot ? null : hittaDubblett(norm, m.ts);
    nyFraga(f);
    if (orig) {
      // Samma fråga nyss: ingen ny kedja, bara en hänvisning till den första.
      f.dubblettAv = orig.inlägg; st.dubbletter++;
      const text = f.språk === 'en'
        ? `Örat: the same question was asked a moment ago (post ${orig.inlägg}), the answer comes there.`
        : `Örat: samma fråga ställdes nyss (inlägg ${orig.inlägg}), svaret kommer där.`;
      try { board.post(text, m.channel, m.id); } catch (err) { console.error('[surret] post:', err && err.message); }
      return;
    }
    if (st.ko.length || !skicka(f, board)) st.ko.push(f);
  },

  onEvent(e, { team }) { las(e, team); },

  async handle(req, res, { path, url, team }) {
    if (req.method !== 'GET') return false;
    if (path === '/report-data') {
      const r = rapport(url, team);
      return r ? json(res, 200, r) : json(res, 400, { error: 'from och to krävs, epoch ms, from < to' });
    }
    if (path === '/fragor') {
      return json(res, 200, st.fragor.slice(-25).reverse().map(f => ({
        inlägg: f.inlägg, kanal: f.kanal, frågare: f.frågare, fråga: f.fråga, styrka: f.styrka, ts: f.ts,
        händelse: f.händelse, följdTill: f.följdTill || null, iKo: !f.händelse && !f.fel && !f.dubblettAv,
        språk: f.språk, dubblettAv: f.dubblettAv || null,
        besvarad: f.besvarad, obesvarad: !!(f.obesvarad && f.obesvarad > 0), kedja: f.kedja,
      })));
    }
    if (path === '/status' || path === '/' || path === '') {
      return json(res, 200, {
        förmåga: 'Örat', hört: st.hört, frågor: st.fragor.length, iKo: st.ko.length,
        dubbletter: st.dubbletter, porträtt: st.portratt,
        besvarade: st.fragor.filter(f => f.besvarad).length,
        väntar: st.fragor.filter(f => f.händelse && !f.besvarad).length,
      });
    }
    return false;
  },
};

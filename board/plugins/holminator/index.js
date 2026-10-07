// Minnet: Kollegans långtidsminne, byggt av holminator.
//
// Lyssnar på allt som sägs på Torget och allt som händer på bussen #kollegan-events, och bygger en tidslinje
// över dagen plus en lista över fakta (vem bygger vilken förmåga). När någon förmåga skickar en fråga
// (fråga.ny, fråga.prioriterad) slår Minnet upp den och svarar med minne.träff: ett kort svar och källinläggen
// det bygger på. Saknas underlag säger Minnet det, med styrka 0. Nya fakta skickas som kunskap.ny.
//
// HTTP under /t/holminator/:
//   GET /status           antal inlägg och händelser, senaste svar
//   GET /fakta            vem bygger vad
//   GET /tidslinje        aktivitet per tiominutersfack, plus de senaste händelserna
//   GET /sok?q=...        samma uppslag som en fråga på bussen, utan att skicka något

const BUSS = 'kollegan-events';
const MAX_POSTER = 5000;
const MAX_HANDELSER = 2000;

const STOPP = new Set(('och att det som en är på av för med till den har inte om ett vi jag du ni de vad vem hur när var varför ' +
  'kan ska vill finns så men eller från hos här där nu bara också mer alla något några kollegan hej tack snälla ' +
  'the a an is are of to in on for and or what who how when where why do does can you we it this that').split(' '));

const st = { poster: [], handelser: [], fakta: new Map(), svar: [], ko: [], besvarat: new Set(), timer: null };

function ord(text) {
  return String(text || '').toLowerCase().replace(/@[\w-]+/g, ' ').match(/[a-zåäö0-9]{3,}/g)?.filter(w => !STOPP.has(w)) || [];
}
function utdrag(text, n = 140) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}
function klocka(ts) { return new Date(ts).toTimeString().slice(0, 5); }

// "holminator tar förmågan Minnet", "team-martin tar förmågan Pulsen", "X takes the Ear"
const ANSPRAK = [
  /\btar\s+(?:förmågan|organet|rollen)\s+([A-ZÅÄÖa-zåäö-]{3,30})/i,
  /\b(?:takes?|claims?)\s+(?:the\s+)?(?:capability\s+)?([A-Za-z-]{3,30})(?:\s+capability)?/i,
];
const INTE_FORMAGA = new Set(['en', 'ett', 'den', 'det', 'the', 'over', 'hand', 'care', 'part', 'that', 'this']);
function hittaAnsprak(m) {
  if (m.channel !== 'bygge') return null;
  for (const re of ANSPRAK) {
    const r = re.exec(m.text);
    if (r && !INTE_FORMAGA.has(r[1].toLowerCase())) {
      const f = r[1].toLowerCase();
      return f.charAt(0).toUpperCase() + f.slice(1);
    }
  }
  return null;
}

function minnsPost(m, levande) {
  if (m.channel === BUSS) return;
  st.poster.push({ id: m.id, ts: m.ts, from: m.from, channel: m.channel, text: m.text, ord: new Set(ord(m.text)) });
  if (st.poster.length > MAX_POSTER) st.poster.shift();
  const f = hittaAnsprak(m);
  if (!f) return;
  const fore = st.fakta.get(m.from);
  if (fore && fore.förmåga === f) return;
  st.fakta.set(m.from, { team: m.from, förmåga: f, inlägg: m.id, ts: m.ts });
  if (levande) st.ko.push({ typ: 'kunskap.ny', styrka: 80, nyttolast: { fakta: `${m.from} bygger ${f}`, team: m.from, förmåga: f, inlägg: m.id } });
}
function minnsHandelse(e) {
  st.handelser.push(e);
  if (st.handelser.length > MAX_HANDELSER) st.handelser.shift();
}

// Uppslaget. Returnerar { svar, styrka, källor }.
function slaUpp(fraga) {
  const q = String(fraga || '');
  const fragOrd = ord(q);
  const lc = q.toLowerCase();

  // Vem bygger vad.
  const fakta = [...st.fakta.values()];
  if (/\bvem\b|\bwho\b|bygger|förmåg|capabilit|\bteam/.test(lc) && fakta.length) {
    const traff = fakta.filter(x => fragOrd.some(w => x.förmåga.toLowerCase().startsWith(w.slice(0, 5)) || x.team.toLowerCase() === w));
    const lista = traff.length ? traff : fakta;
    const svar = lista.map(x => `${x.team} bygger ${x.förmåga}`).join(', ') + '.';
    return {
      svar: (traff.length ? '' : `${fakta.length} team har ropat förmågor i #bygge: `) + svar,
      styrka: traff.length ? 90 : 70,
      källor: lista.slice(0, 4).map(x => ({ id: x.inlägg, från: x.team, kanal: 'bygge', utdrag: `${x.team} tar ${x.förmåga}` })),
    };
  }

  // Beslut: det som skrivits med BESLUT eller DECISION.
  if (/beslut|bestämt|decid|decision|röst|vote/.test(lc)) {
    const b = st.poster.filter(p => /\b(BESLUT|DECISION)\b/.test(p.text)).slice(-3);
    if (b.length) return { svar: utdrag(b[b.length - 1].text, 300), styrka: 85, källor: b.map(p => ({ id: p.id, från: p.from, kanal: p.channel, utdrag: utdrag(p.text) })) };
  }

  if (!fragOrd.length) return { svar: 'Minnet hittar inga sökord i frågan.', styrka: 0, källor: [] };

  // Fritext: andel av frågans ord som finns i inlägget, nyare inlägg väger lite tyngre.
  const nu = Date.now();
  const traffar = [];
  for (const p of st.poster) {
    let s = 0;
    for (const w of fragOrd) if (p.ord.has(w)) s += 1;
    if (!s) continue;
    s = s / fragOrd.length + Math.max(0, 0.2 - (nu - p.ts) / (1000 * 60 * 60 * 10));
    traffar.push({ p, s });
  }
  traffar.sort((a, b) => b.s - a.s);
  const basta = traffar.slice(0, 3);
  if (!basta.length || basta[0].s < 0.34) return { svar: 'Minnet saknar underlag om det. Ingen här har skrivit något om det i dag.', styrka: 0, källor: [] };
  const top = basta[0].p;
  return {
    svar: `${top.from} skrev ${klocka(top.ts)} i #${top.channel}: ${utdrag(top.text, 220)}`,
    styrka: Math.min(95, Math.round(basta[0].s * 80)),
    källor: basta.map(({ p }) => ({ id: p.id, från: p.from, kanal: p.channel, utdrag: utdrag(p.text) })),
  };
}

function skicka(ctx, typ, opts) {
  const r = ctx.board.emit(typ, opts);
  if (!r || r.error) { console.error('[holminator] emit', typ, r && r.error); return null; }
  return r.handelse;
}

// kunskap.ny ligger i kö och skickas högst var 15:e sekund, så frågor alltid har plats under serverns 6 per minut.
function tomKo(ctx) {
  const h = st.ko.shift();
  if (h) skicka(ctx, h.typ, { styrka: h.styrka, nyttolast: h.nyttolast });
}

function lasIn(ctx) {
  let since = 0;
  for (let i = 0; i < 100; i++) {
    const sida = ctx.board.query({ since, limit: 500 });
    if (!sida.length) break;
    for (const m of sida) minnsPost(m, false);
    since = sida[sida.length - 1].id;
    if (sida.length < 500) break;
  }
  for (const e of ctx.board.events(MAX_HANDELSER)) {
    minnsHandelse(e);
    if (e.kvarter === ctx.team && e.typ === 'minne.träff' && e.orsak) st.besvarat.add(e.orsak);
  }
}

function json(res, kod, data) {
  res.writeHead(kod, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
  return true;
}

module.exports = {
  init(ctx) {
    try { lasIn(ctx); } catch (err) { console.error('[holminator] init', err && err.message); }
    st.timer = setInterval(() => {
      try { tomKo(ctx); } catch (err) { console.error('[holminator]', err && err.message); }
    }, 15000);
    if (st.timer.unref) st.timer.unref();
  },

  onMessage(m) {
    minnsPost(m, true);
  },

  onEvent(e, ctx) {
    minnsHandelse(e);
    if (!/^fråga\./.test(e.typ)) return;
    if (st.besvarat.has(e.id) || (e.orsak && st.besvarat.has(e.orsak))) return;
    const n = e.nyttolast || {};
    const fraga = n.fråga || n.fraga || n.text || n.question || '';
    if (!fraga) return;
    st.besvarat.add(e.id);
    const u = slaUpp(fraga);
    const nyttolast = { fråga: utdrag(fraga, 200), svar: utdrag(u.svar, 400), källor: u.källor, kanal: n.kanal, inlägg: n.inlägg };
    const h = skicka(ctx, 'minne.träff', { orsak: e.id, styrka: u.styrka, nyttolast });
    st.svar.push({ ts: Date.now(), fråga: nyttolast.fråga, svar: nyttolast.svar, styrka: u.styrka, källor: u.källor.length, händelse: h && h.id, från: e.kvarter });
    if (st.svar.length > 50) st.svar.shift();
  },

  async handle(req, res, { path, url }) {
    if (req.method !== 'GET') return false;
    if (path === '/status') {
      return json(res, 200, { poster: st.poster.length, händelser: st.handelser.length, fakta: st.fakta.size, svar: st.svar.slice(-8).reverse(), kö: st.ko.length });
    }
    if (path === '/fakta') return json(res, 200, [...st.fakta.values()]);
    if (path === '/tidslinje') {
      const fack = new Map();
      const lagg = (ts, falt) => {
        const k = Math.floor(ts / 600000) * 600000;
        const f = fack.get(k) || { ts: k, inlägg: 0, händelser: 0 };
        f[falt]++; fack.set(k, f);
      };
      for (const p of st.poster) lagg(p.ts, 'inlägg');
      for (const e of st.handelser) lagg(e.ts, 'händelser');
      const senaste = st.handelser.slice(-15).reverse().map(e => ({ id: e.id, ts: e.ts, typ: e.typ, kvarter: e.kvarter, styrka: e.styrka, orsak: e.orsak }));
      return json(res, 200, { fack: [...fack.values()].sort((a, b) => a.ts - b.ts).slice(-48), senaste });
    }
    if (path === '/sok') return json(res, 200, slaUpp(url.searchParams.get('q') || ''));
    return false;
  },
};

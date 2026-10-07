// Pulsen — team-martins förmåga i Kollegan.
//
// Pulsen är Kollegans känsla för tempo och tryck i rummet. Den äger kvantitet:
// hur mycket som sägs, hur snabbt, i vilken kanal, och hur länge en fråga legat obesvarad.
// Stämningen (tomhol) äger kvalitet (hur det låter) — överenskommet i #bygge, inlägg 87/92.
//
// Lyssnar på:  fråga.ny (Örat/surret), svar.klart + svar.granskat (Rösten/Granskaren),
//              stämning.byte (Stämningen/tomhol), samt alla inlägg på Torget.
// Skickar:     puls.tryck  — reaktion på en fråga: hur bråttom är det just nu (orsak = frågans id)
//              puls.tempo  — rummets tempo när det faktiskt ändrats
//
//              GET /t/team-martin/report-data?from=MS&to=MS  → Rapportörens V1-kontrakt (fralle, #bygge 675/677/1231)

const FONSTER_MS = 5 * 60 * 1000;   // glidande fönster för tempo
const OBESVARAD_MS = 90 * 1000;     // en fråga räknas som väntande efter så här lång tid
const TICK_MS = 20 * 1000;
const TEMPO_MIN_MS = 60 * 1000;     // minst en minut mellan två puls.tempo
const TEMPO_TROSKEL = 10;           // och bara om styrkan rört sig så här mycket
const MAX_EMIT_PER_MIN = 4;         // egen spärr, under serverns 6
const HISTORIK_MAX = 180;
const MPM_FULL = 8;                 // åtta inlägg i minuten räknas som full puls
const BUSS = 'kollegan-events';     // bussens egen trafik är förmågornas, inte rummets
const GLOM_FRAGA_MS = 20 * 60 * 1000; // en fråga som väntat så länge är inte längre aktuell
const TRYCK_MAX_FRAGOR = 5;         // trycket mättas, en kö på trettio är inte trettio gånger värre
const RAPPORT_MAX_SPAN_MS = 24 * 60 * 60 * 1000; // Rapportörens tak per begäran

const st = {
  msgs: [],            // {ts, channel} i fönstret
  fragor: new Map(),   // inläggs-id -> {ts, channel, from, text, besvarad}
  historik: [],        // {ts, styrka, hetaste}
  reaktioner: [],      // senaste puls.tryck vi skickat
  frammande: [],       // senaste händelser från andra kvarter som påverkat oss
  stamning: null,      // senaste stämning.byte från tomhol
  portratt: null,      // {url, prompt} från ateljéns bild.klar
  sedda: new Set(),    // orsaks-id vi redan reagerat på (serverns gräns: 1 per orsak)
  senasteTempo: { ts: 0, styrka: -100 },
  emitLogg: [],
  timer: null,
};

const nu = () => Date.now();
const klamp = (n) => Math.max(0, Math.min(100, Math.round(n)));

// Ett omnämnande är inte en fråga. Halva rummet skriver om Kollegan utan att fråga den något,
// och de inläggen får inte bli en kö som trycker upp pulsen resten av dagen.
// Örat (surret) äger frågedetektionen via fråga.ny; det här är bara en smal backup:
// @kollegan ska stå som ett tilltal i början av ett kort inlägg.
function arFraga(text) {
  const t = String(text || '').trim();
  if (t.length > 400) return false;
  const i = t.search(/@kollegan\b/i);
  return i >= 0 && i <= 30;
}

function stadaFonster(t = nu()) {
  const grans = t - FONSTER_MS;
  while (st.msgs.length && st.msgs[0].ts < grans) st.msgs.shift();
  if (st.historik.length > HISTORIK_MAX) st.historik.splice(0, st.historik.length - HISTORIK_MAX);
  if (st.reaktioner.length > 12) st.reaktioner.splice(0, st.reaktioner.length - 12);
  if (st.frammande.length > 12) st.frammande.splice(0, st.frammande.length - 12);
  for (const [id, f] of st.fragor) {
    if (f.besvarad || t - f.ts > GLOM_FRAGA_MS) st.fragor.delete(id);
  }
  if (st.sedda.size > 500) st.sedda = new Set([...st.sedda].slice(-250));
}

function obesvarade(t = nu()) {
  const ut = [];
  for (const [id, f] of st.fragor) {
    if (f.besvarad) continue;
    const vantat = t - f.ts;
    if (vantat < OBESVARAD_MS || vantat > GLOM_FRAGA_MS) continue;
    ut.push({ id, kanal: f.channel, fran: f.from, text: f.text, vantat_s: Math.round(vantat / 1000) });
  }
  return ut.sort((a, b) => b.vantat_s - a.vantat_s).slice(0, 8);
}

// Pulsen = tempo i fönstret, lyft av frågor som fått vänta.
function mat(t = nu()) {
  stadaFonster(t);
  const minuter = FONSTER_MS / 60000;
  const perKanal = new Map();
  for (const m of st.msgs) perKanal.set(m.channel, (perKanal.get(m.channel) || 0) + 1);

  const kanaler = [...perKanal.entries()]
    .map(([kanal, n]) => ({ kanal, inlägg: n, mpm: +(n / minuter).toFixed(2), styrka: klamp((n / minuter) / MPM_FULL * 100) }))
    .sort((a, b) => b.inlägg - a.inlägg);

  const mpm = +(st.msgs.length / minuter).toFixed(2);
  const vantande = obesvarade(t);
  const tryck = klamp(vantande.slice(0, TRYCK_MAX_FRAGOR).reduce((s, f) => s + Math.min(25, f.vantat_s / 12), 0));
  const tempo = klamp(mpm / MPM_FULL * 100);

  return {
    styrka: klamp(tempo * 0.7 + tryck * 0.3),
    tempo,
    tryck,
    mpm,
    inlägg: st.msgs.length,
    fönster_min: minuter,
    hetaste: kanaler[0] ? kanaler[0].kanal : null,
    kanaler,                      // hel lista internt, kapas först när den skickas ut
    obesvarade: vantande,
    stämning: st.stamning,
  };
}

function ord(s) {
  if (s >= 80) return 'kokar';
  if (s >= 55) return 'full fart';
  if (s >= 30) return 'igång';
  if (s >= 12) return 'lugnt';
  return 'stilla';
}

// En färdig mening om rummet, så Rösten kan citera Pulsen utan att tolka våra siffror.
// JSON-fälten är tal, men meningen är svenska: decimalkomma, inte punkt.
const tal = (n) => String(n).replace('.', ',');
const tillMinuter = (s) => Math.max(1, Math.round(s / 60));

function rad(m, kanal) {
  const delar = [];
  // Gäller raden en viss fråga nämner vi den kanalen, inte rummets hetaste: annars citerar
  // Rösten "stilla i #torget" om en fråga som ställdes i #hjälp.
  const k = kanal && m.kanaler.find((x) => x.kanal === kanal);
  if (k) delar.push(`${ord(k.styrka)} i #${k.kanal}`);
  else if (kanal) delar.push(`tyst i #${kanal}`);
  else delar.push(m.hetaste ? `${ord(m.styrka)} i #${m.hetaste}` : `det är ${ord(m.styrka)} i rummet`);

  delar.push(`${tal(m.mpm)} inlägg i minuten i rummet`);
  if (kanal && m.hetaste && m.hetaste !== kanal) delar.push(`mest just nu i #${m.hetaste}`);

  if (m.obesvarade.length) {
    const min = tillMinuter(m.obesvarade[0].vantat_s);
    const tid = `${min} minut${min === 1 ? '' : 'er'}`;
    delar.push(m.obesvarade.length === 1
      ? `en fråga har väntat ${tid} på svar`
      : `${m.obesvarade.length} frågor väntar på svar, den äldsta i ${tid}`);
  }
  return delar.join(', ') + '.';
}

// Egen spärr så vi aldrig slår i serverns gräns och aldrig tuggar tomt.
function farEmitta(t = nu()) {
  st.emitLogg = st.emitLogg.filter((x) => t - x < 60000);
  return st.emitLogg.length < MAX_EMIT_PER_MIN;
}

function emit(board, typ, opts) {
  if (!farEmitta()) return null;
  const svar = board.emit(typ, opts);
  if (svar && svar.error) {
    console.error('[team-martin] emit', typ, svar.error);
    return null;
  }
  st.emitLogg.push(nu());
  return svar && svar.handelse ? svar.handelse : null;
}

function tempoPuls(board) {
  const m = mat();
  const t = nu();
  if (t - st.senasteTempo.ts < TEMPO_MIN_MS) return;
  if (Math.abs(m.styrka - st.senasteTempo.styrka) < TEMPO_TROSKEL) return;

  const h = emit(board, 'puls.tempo', {
    styrka: m.styrka,
    nyttolast: {
      ord: ord(m.styrka),
      rad: rad(m),
      mpm: m.mpm,
      hetaste: m.hetaste,
      kanaler: m.kanaler.slice(0, 3),
      obesvarade: m.obesvarade.length,
      fönster_min: m.fönster_min,
    },
  });
  if (h) {
    st.senasteTempo = { ts: t, styrka: m.styrka };
    st.historik.push({ ts: t, styrka: m.styrka, hetaste: m.hetaste, skickad: true });
  }
}

// Rapportörens V1-kontrakt: bara det vi faktiskt observerat i perioden, med ärlig täckning.
// Vi sparar inte råa inlägg utanför det glidande 5-minutersfönstret, bara periodiska
// pulsmätningar (st.historik, var 20:e sekund, högst HISTORIK_MAX stycken) och de senaste
// puls.tryck-reaktionerna (st.reaktioner, högst 12). Täckningen begränsas av det.
function rapportData(from, to) {
  const genererad = nu();
  const punkter = st.historik.filter((h) => h.ts >= from && h.ts < to);
  const reaktionerIPerioden = st.reaktioner.filter((r) => r.ts >= from && r.ts < to);
  const tidigasteHistorik = st.historik.length ? st.historik[0].ts : null;
  const tidigasteReaktion = st.reaktioner.length ? st.reaktioner[0].ts : null;

  // Fullständig täckning kräver att vi haft periodiska mätningar sedan före periodens start
  // och att perioden inte sträcker sig in i framtiden.
  const historikTäcker = tidigasteHistorik !== null && from >= tidigasteHistorik;
  const complete = historikTäcker && to <= genererad + 5000;

  const styrkor = punkter.map((p) => p.styrka);
  const avgStyrka = styrkor.length ? +(styrkor.reduce((s, x) => s + x, 0) / styrkor.length).toFixed(1) : null;
  const maxStyrka = styrkor.length ? Math.max(...styrkor) : null;
  const koar = reaktionerIPerioden.map((r) => r.köar).filter((n) => typeof n === 'number');
  const maxKoar = koar.length ? Math.max(...koar) : null;

  let note;
  if (complete) {
    note = 'Periodiska pulsmätningar (var 20:e sekund) täcker hela perioden.';
  } else if (tidigasteHistorik === null) {
    note = 'Ingen historik sparad än (nyligen startad eller omstartad process).';
  } else if (!historikTäcker) {
    note = `Historik sparas glidande, högst ${HISTORIK_MAX} mätpunkter; perioden börjar före vår äldsta sparade mätning (${new Date(tidigasteHistorik).toISOString()}).`;
  } else {
    note = 'Perioden sträcker sig in i framtiden eller efter senaste mätning.';
  }

  return {
    schema_version: 1,
    team: 'team-martin',
    capability: 'Pulsen',
    generated_at: genererad,
    period: { from, to },
    coverage: { from: tidigasteHistorik, to: genererad, complete, note },
    metrics: [
      {
        key: 'pulse_samples', label: 'Antal pulsmätningar i perioden', value: punkter.length || null,
        unit: 'count', scope: complete ? 'period' : 'retained',
      },
      {
        key: 'avg_pulse_strength', label: 'Snittstyrka (0-100) i perioden', value: avgStyrka,
        unit: 'index', scope: complete ? 'period' : 'retained',
      },
      {
        key: 'max_pulse_strength', label: 'Högsta styrka (0-100) i perioden', value: maxStyrka,
        unit: 'index', scope: complete ? 'period' : 'retained',
      },
      {
        key: 'tempo_events_emitted', label: 'Antal puls.tempo skickade i perioden',
        value: punkter.length ? punkter.filter((p) => p.skickad).length : null,
        unit: 'count', scope: complete ? 'period' : 'retained',
      },
      {
        key: 'pressure_reactions_sent', label: 'Antal puls.tryck skickade i perioden (senaste 12 sparas)',
        value: tidigasteReaktion !== null && from >= tidigasteReaktion ? reaktionerIPerioden.length : null,
        unit: 'count', scope: 'retained',
      },
      {
        key: 'max_queue_waiting', label: 'Flest obesvarade frågor vid en reaktion i perioden',
        value: maxKoar, unit: 'count', scope: 'retained',
      },
    ],
  };
}

module.exports = {
  init(ctx) {
    const { board } = ctx;
    try {
      // Bygg upp fönstret ur det som redan sagts, så rutan har en puls direkt efter en omstart.
      const gamla = board.query({ limit: 500 }) || [];
      const grans = nu() - FONSTER_MS;
      for (const m of gamla) {
        if (m.channel === BUSS) continue;
        if (m.ts >= grans) st.msgs.push({ ts: m.ts, channel: m.channel });
        if (arFraga(m.text)) st.fragor.set(m.id, { ts: m.ts, channel: m.channel, from: m.from, text: (m.text || '').slice(0, 160), besvarad: false });
        if (m.reply_to && st.fragor.has(m.reply_to)) st.fragor.get(m.reply_to).besvarad = true;
      }
      st.msgs.sort((a, b) => a.ts - b.ts);
      const m0 = mat();
      st.historik.push({ ts: nu(), styrka: m0.styrka, hetaste: m0.hetaste });
    } catch (err) {
      console.error('[team-martin] init', err && err.message);
    }

    st.timer = setInterval(() => {
      try {
        const m = mat();
        const sist = st.historik[st.historik.length - 1];
        if (!sist || sist.styrka !== m.styrka || sist.hetaste !== m.hetaste) {
          st.historik.push({ ts: nu(), styrka: m.styrka, hetaste: m.hetaste });
        }
        tempoPuls(board);
      } catch (err) {
        console.error('[team-martin] tick', err && err.message);
      }
    }, TICK_MS);
    if (st.timer.unref) st.timer.unref();
  },

  onMessage(m) {
    try {
      if (m.channel === BUSS) return;                  // bussen mäter vi via onEvent, inte som rumstempo
      st.msgs.push({ ts: m.ts, channel: m.channel });
      if (arFraga(m.text)) {
        st.fragor.set(m.id, { ts: m.ts, channel: m.channel, from: m.from, text: (m.text || '').slice(0, 160), besvarad: false });
      }
      if (m.reply_to && st.fragor.has(m.reply_to)) st.fragor.get(m.reply_to).besvarad = true;
      stadaFonster();
    } catch (err) {
      console.error('[team-martin] onMessage', err && err.message);
    }
  },

  // Här reagerar Pulsen på andra kvarter. Örat hör frågan, vi säger hur bråttom det är.
  onEvent(e, { board, team }) {
    try {
      if (!e || e.kvarter === team) return;

      if (e.typ === 'fråga.ny') {
        const inlagg = e.nyttolast && e.nyttolast.inlägg;
        if (inlagg && !st.fragor.has(inlagg)) {
          st.fragor.set(inlagg, {
            ts: e.ts, channel: (e.nyttolast && e.nyttolast.kanal) || 'torget',
            from: (e.nyttolast && e.nyttolast.frågare) || e.kvarter,
            text: String((e.nyttolast && e.nyttolast.fråga) || '').slice(0, 160), besvarad: false,
          });
        }
        if (st.sedda.has(e.id)) return;
        st.sedda.add(e.id);
        const m = mat();
        const kanal = (e.nyttolast && e.nyttolast.kanal) || null;
        const h = emit(board, 'puls.tryck', {
          styrka: m.styrka,
          orsak: e.id,
          nyttolast: {
            ord: ord(m.styrka),
            rad: rad(m, kanal),
            mpm: m.mpm,
            hetaste: m.hetaste,
            kanal,
            köar: m.obesvarade.length,
            råd: m.styrka >= 55 ? 'kort svar, det är full fart' : 'det finns tid för ett utförligt svar',
          },
        });
        st.frammande.push({ ts: e.ts, typ: e.typ, kvarter: e.kvarter, styrka: e.styrka });
        if (h) st.reaktioner.push({ ts: nu(), orsak: e.id, från: e.kvarter, styrka: m.styrka, ord: ord(m.styrka), köar: m.obesvarade.length });
        stadaFonster();
        return;
      }

      // Svar räknas som att en fråga lämnat kön, oavsett vilket team som skickade det.
      if (e.typ === 'svar.klart' || e.typ === 'svar.granskat') {
        const inlagg = e.nyttolast && e.nyttolast.inlägg;
        if (inlagg && st.fragor.has(inlagg)) st.fragor.get(inlagg).besvarad = true;
        st.frammande.push({ ts: e.ts, typ: e.typ, kvarter: e.kvarter, styrka: e.styrka });
        stadaFonster();
        return;
      }

      // Ateljén målar kvarterens porträtt. Är det vårt hänger vi upp det i rutan.
      if (e.typ === 'bild.klar') {
        const n = e.nyttolast || {};
        if (n.till === team && typeof n.url === 'string' && n.url.startsWith('/')) {
          st.portratt = { url: n.url, prompt: String(n.prompt || '').slice(0, 300), av: e.kvarter, ts: e.ts };
        }
        st.frammande.push({ ts: e.ts, typ: e.typ, kvarter: e.kvarter, styrka: e.styrka });
        stadaFonster();
        return;
      }

      // Stämningen äger tonen. Vi visar den bredvid vår siffra, men räknar inte om den.
      if (e.typ === 'stämning.byte') {
        st.stamning = { ts: e.ts, kvarter: e.kvarter, styrka: e.styrka, nyttolast: e.nyttolast || null };
        st.frammande.push({ ts: e.ts, typ: e.typ, kvarter: e.kvarter, styrka: e.styrka });
        stadaFonster();
      }
    } catch (err) {
      console.error('[team-martin] onEvent', err && err.message);
    }
  },

  async handle(req, res, { path, url }) {
    if (req.method !== 'GET') return false;

    // Rapportörens bindande V1-kontrakt (fralle, #bygge 675/677/1231): GET /report-data?from=MS&to=MS
    if (path === '/report-data') {
      const sp = url ? url.searchParams : new URL(req.url, 'http://x').searchParams;
      const from = Number(sp.get('from'));
      const to = Number(sp.get('to'));
      const fel = (status, code, meddelande) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ error: code, message: meddelande }));
        return true;
      };
      if (!Number.isFinite(from) || !Number.isFinite(to)) return fel(400, 'bad_request', 'from och to krävs som epoch-ms.');
      if (from >= to) return fel(400, 'bad_request', 'from måste vara mindre än to.');
      if (to - from > RAPPORT_MAX_SPAN_MS) return fel(400, 'bad_request', 'perioden får vara högst 24 timmar.');

      const svar = rapportData(from, to);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(svar));
      return true;
    }

    // En rad i klartext, för Rösten och för den som bara vill läsa: GET /t/team-martin/rad
    if (path === '/rad') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end(rad(mat()) + '\n');
      return true;
    }

    if (path === '/puls' || path === '/' || path === '') {
      const m = mat();
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({
        förmåga: 'Pulsen',
        rad: rad(m),
        nu: { styrka: m.styrka, ord: ord(m.styrka), tempo: m.tempo, tryck: m.tryck, mpm: m.mpm, inlägg: m.inlägg, hetaste: m.hetaste, fönster_min: m.fönster_min },
        kanaler: m.kanaler.slice(0, 8),
        obesvarade: m.obesvarade,
        historik: st.historik.slice(-90),
        reaktioner: st.reaktioner.slice(-6).reverse(),
        främmande: st.frammande.slice(-6).reverse(),
        stämning: st.stamning,
        porträtt: st.portratt,
      }));
      return true;
    }
    return false;
  },
};

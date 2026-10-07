const WINDOW_MS = 10 * 60 * 1000;
const LIMIT = 20;
const HISTORY_LIMIT = 5000;
const BUCKET_MS = 10000;
const states = new WeakMap();
// Channels that are not conversation (stories, broadcasts) are never assessed or emitted.
const SKIP_CHANNELS = new Set(['kollegan-events', 'stadens-saga', 'radio']);
// Automated replies from Kollegan's capabilities echo questions and would inflate the signals.
const AUTOMATED = /^\s*(?:Kollegan|Lotsen|Örat|Granskaren|Kön|Stämningen)\s*:/u;
const PAUSE = /@tomhol\s+(pausa|paus|fortsätt|återuppta)(?![\p{L}])/iu;
const PAUSE_SENDERS = new Set(['ledarens-agent']);
const rules = {
  // A question mark, or a question word that starts a sentence (optionally after @-mentions).
  fragor: /\?|(?:^|[.!\n]\s*)(?:@\S+\s+)*(?<ord>hur|varför|vem|vilka|vilken|vad|när|how|why|who|what|when|where)(?![\p{L}])/giu,
  hinder: /(?<![\p{L}])(?:fastnat|sitter fast|kör fast|går inte|blockerad|blocked|stuck|fungerar inte|funkar inte|failar|failade|kraschar|kraschade|crashes|crashed|error|timeout|doesn't work|does not work|not working)(?![\p{L}])/giu,
  uppskattning: /(?<![\p{L}])(?:tack|thanks|thank you|bra jobbat|well done|snyggt)(?![\p{L}])/giu,
  omtanke: /[❤♥]\uFE0F?|(?<![\p{L}])(?:hoppas det löser sig|ta den tid du behöver|jag finns här|vi finns här|hope it works out|take your time|i am here for you|i'm here for you|we are here for you)(?![\p{L}])/giu,
};

function state(ctx) {
  if (!states.has(ctx.board)) {
    const now = Date.now();
    const initial = ctx.board.query({ limit: 500 });
    const oldest = initial.reduce((ts, m) => Math.min(ts, m.ts), now);
    const coverage = initial.length >= 500 ? Math.max(now - WINDOW_MS, oldest + 1) : now - WINDOW_MS;
    states.set(ctx.board, {
      kanaler: new Map(), utskick: [], fel: null, team: ctx.team, pausad: false,
      history: new Map(), coverage,
    });
    for (const m of initial) remember(states.get(ctx.board), m, now);
  }
  return states.get(ctx.board);
}

function remember(st, m, now) {
  for (const [id, item] of st.history) {
    if (item.ts <= now - WINDOW_MS) st.history.delete(id);
  }
  if (m.channel !== 'kollegan-events' && typeof m.channel === 'string' &&
      Number.isFinite(m.ts) && m.ts > now - WINDOW_MS && m.ts <= now &&
      Number.isInteger(m.id) && typeof m.text === 'string') {
    st.history.set(m.id, { id: m.id, ts: m.ts, channel: m.channel, text: m.text, from: m.from });
  }
  if (st.history.size > HISTORY_LIMIT) {
    const sorted = [...st.history.values()].sort((a, b) => a.ts - b.ts || a.id - b.id);
    for (const item of sorted.slice(0, sorted.length - HISTORY_LIMIT)) {
      st.history.delete(item.id);
      st.coverage = Math.max(st.coverage, item.ts + 1);
    }
  }
}

function automated(m, team) {
  return m.from === team || AUTOMATED.test(m.text);
}

function signals(m) {
  const result = [];
  for (const [signal, rule] of Object.entries(rules)) {
    const match = [...m.text.matchAll(rule)].find(candidate => {
      if (signal !== 'hinder' && signal !== 'omtanke') return true;
      return !/(?:inte|inte längre|aldrig|ej|not|no longer|never)\s+(?:\p{L}+\s+){0,2}$/iu
        .test(m.text.slice(0, candidate.index));
    });
    if (match) result.push({ inlagg: m.id, signal, uttryck: match.groups?.ord ?? match[0], ts: m.ts });
  }
  return result;
}

function timeline(st, now) {
  const start = now - WINDOW_MS;
  const channels = new Map();
  for (const m of st.history.values()) {
    if (m.ts <= start || m.ts > now) continue;
    if (!channels.has(m.channel)) channels.set(m.channel, { kanal: m.channel, intervall: new Map(), markorer: [] });
    const channel = channels.get(m.channel);
    const ts = Math.floor(m.ts / BUCKET_MS) * BUCKET_MS;
    channel.intervall.set(ts, (channel.intervall.get(ts) || 0) + 1);
    if (!automated(m, st.team)) channel.markorer.push(...signals(m));
  }
  return {
    fran: start, till: now, tackningFran: Math.max(start, st.coverage),
    intervallMs: BUCKET_MS, maxSkala: 10,
    kanaler: [...channels.values()].sort((a, b) => a.kanal.localeCompare(b.kanal, 'sv')).map(channel => ({
      kanal: channel.kanal,
      intervall: [...channel.intervall].sort(([a], [b]) => a - b).map(([ts, antal]) => ({ ts, antal })),
      markorer: channel.markorer.sort((a, b) => a.ts - b.ts || a.inlagg - b.inlagg),
    })),
  };
}

function fail(st, message) {
  st.fel = message;
  console.error('[tomhol]', message);
}

// Readable sentence for consumers such as Minnet and Rösten, which prefer nyttolast.rad over raw fields.
const NAMES = { fragor: 'frågor', hinder: 'hinder', uppskattning: 'uppskattning', omtanke: 'omtanke' };

function trend(signaler, previous) {
  if (!previous) return null;
  const changed = Object.keys(NAMES).filter(k => signaler[k] !== previous[k])
    .map(k => `${NAMES[k]} ${previous[k]}→${signaler[k]}`);
  return changed.length ? `Jämfört med förra bedömningen: ${changed.join(', ')}.` : 'Oförändrat sedan förra bedömningen.';
}

function sentence(kanal, antal, signaler, previous) {
  const n = (count, one, many) => `${count} ${count === 1 ? one : many}`;
  const parts = [
    signaler.fragor && n(signaler.fragor, 'fråga', 'frågor'),
    signaler.hinder && n(signaler.hinder, 'hinder', 'hinder'),
    signaler.uppskattning && n(signaler.uppskattning, 'uppskattning', 'uppskattningar'),
    signaler.omtanke && n(signaler.omtanke, 'uttryck av omtanke', 'uttryck av omtanke'),
  ].filter(Boolean);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} och ${parts.at(-1)}` : parts[0] || 'inga tydliga språksignaler';
  const change = trend(signaler, previous);
  return `I #${kanal} de senaste 10 minuterna (${n(antal, 'inlägg', 'inlägg')}): ${list}.${change ? ` ${change}` : ''} Det är språksignaler, inte känslor.`;
}

function assess(messages, kanal, now, team, previous) {
  const recent = messages.filter(m =>
    m.channel === kanal && !SKIP_CHANNELS.has(m.channel) && !automated(m, team) &&
    Number.isFinite(m.ts) && m.ts > now - WINDOW_MS && m.ts <= now &&
    typeof m.text === 'string'
  ).sort((a, b) => a.ts - b.ts || a.id - b.id).slice(-LIMIT);
  const signaler = { fragor: 0, hinder: 0, uppskattning: 0, omtanke: 0 };
  const kallor = [];
  for (const m of recent) {
    for (const { signal, inlagg, uttryck } of signals(m)) {
      signaler[signal]++;
      kallor.push({ inlagg, signal, uttryck });
    }
  }
  return {
    rad: sentence(kanal, recent.length, signaler, previous),
    kanal,
    fonster: { fran: new Date(now - WINDOW_MS).toISOString(), till: new Date(now).toISOString() },
    antalInlagg: recent.length,
    signaler,
    kallor: kallor.slice(-6),
    metod: 'regelbaserad-sv-en',
    begransningar: [
      'Språksignaler, inte bedömningar av personers känslor.',
      'Automatiska svar (Kollegan:, Lotsen: m.fl.) och våra egna inlägg räknas inte.',
      'Ironi, citat och sammanhang kan feltolkas. Regelordlistan är begränsad.',
      'Högst sex källexempel visas; signalantal gäller hela underlaget.',
      'Omtanke är uttryckta stödfraser eller hjärtan; avsikt och ironi kan inte avgöras.',
    ],
  };
}

module.exports = {
  init(ctx) { state(ctx); },

  onMessage(m, ctx) {
    const st = state(ctx);
    remember(st, m, Date.now());
    const command = typeof m.text === 'string' && (m.from === ctx.team || PAUSE_SENDERS.has(m.from)) && PAUSE.exec(m.text);
    if (!command) return;
    const pause = /^paus/i.test(command[1]);
    if (pause === st.pausad) return;
    st.pausad = pause;
    try {
      ctx.board.post(pause
        ? 'Stämningen är pausad: inga stämning.byte skickas. Rutan på /staden fortsätter visa tidslinjerna.'
        : 'Stämningen är igång igen och skickar stämning.byte vid nästa Puls.', m.channel, m.id);
    } catch (err) {
      fail(st, `Kunde inte bekräfta paus: ${err.message}`);
    }
  },

  onEvent(e, ctx) {
    if (e.kvarter !== 'team-martin' || !['puls.tempo', 'puls.tryck'].includes(e.typ)) return;
    const st = state(ctx);
    const kanal = e.typ === 'puls.tempo' ? e.nyttolast?.hetaste : e.nyttolast?.kanal;
    if (typeof kanal !== 'string' || !kanal.trim() || kanal.startsWith('#') ||
        !Number.isInteger(e.id) ||
        !Number.isInteger(e.djup) || e.djup < 1 || e.djup > 4) {
      fail(st, 'Ogiltig Pulsen-händelse: kanal, id eller djup saknas eller är ogiltigt.');
      return;
    }
    if (SKIP_CHANNELS.has(kanal)) return;
    const now = Date.now();
    const previous = st.kanaler.get(kanal);
    const payload = assess(ctx.board.query({ channel: kanal, limit: 500 }), kanal, now, ctx.team, previous?.signaler);
    const signature = JSON.stringify(payload.signaler);
    const view = {
      ...payload,
      utlosare: { id: e.id, typ: e.typ, kvarter: e.kvarter, djup: e.djup },
      aktivitet: { styrka: e.styrka, nyttolast: e.nyttolast },
      uppdaterad: now,
      status: payload.antalInlagg === 0 ? 'inget underlag' :
        Object.values(payload.signaler).every(n => n === 0) ? 'inga kända språksignaler' : 'språksignaler observerade',
      utskick: 'oförändrat',
      skickadSignatur: previous?.skickadSignatur,
    };
    st.fel = null;
    st.kanaler.delete(kanal);
    st.kanaler.set(kanal, view);
    if (st.kanaler.size > 100) st.kanaler.delete(st.kanaler.keys().next().value);
    if (e.djup === 4) { view.utskick = 'maxdjup: bara visning'; return; }
    if (st.pausad) { view.utskick = 'pausad: bara visning'; return; }
    if (payload.antalInlagg === 0) { view.utskick = 'inget underlag: inget utskick'; return; }
    if (signature === previous?.skickadSignatur) return;
    st.utskick = st.utskick.filter(ts => now - ts < 60000);
    if (st.utskick.length >= 6 || (st.utskick.length && now - st.utskick.at(-1) < 10000)) {
      view.utskick = 'begränsat: bedöms igen vid nästa Puls';
      return;
    }
    try {
      const result = ctx.board.emit('stämning.byte', { orsak: e.id, nyttolast: payload });
      if (!result?.handelse || result.error) {
        view.utskick = 'fel';
        fail(st, `stämning.byte avvisades: ${result?.error || 'ogiltigt svar från bussen'}`);
        return;
      }
      st.utskick.push(now);
      view.skickadSignatur = signature;
      view.utskick = 'skickat';
    } catch (err) {
      view.utskick = 'fel';
      fail(st, `stämning.byte misslyckades: ${err.message}`);
    }
  },

  handle(req, res, ctx) {
    if (req.method !== 'GET' || !['/status', '/timeline'].includes(ctx.path)) return false;
    const st = state(ctx);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    if (ctx.path === '/timeline') {
      res.end(JSON.stringify(timeline(st, Date.now())));
      return true;
    }
    res.end(JSON.stringify({
      formaga: 'Stämningen',
      pausad: st.pausad,
      fel: st.fel,
      kanaler: [...st.kanaler.values()].map(({ skickadSignatur, ...view }) => view),
    }));
    return true;
  },
};

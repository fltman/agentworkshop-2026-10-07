const WINDOW_MS = 10 * 60 * 1000;
const LIMIT = 20;
const states = new WeakMap();
const rules = {
  fragor: /\?|(?<![\p{L}])(?:hur|varför|vem|vilka|vilken|när|how|why|who|what|when|where)(?![\p{L}])/giu,
  hinder: /(?<![\p{L}])(?:fastnat|blockerad|blocked|stuck|fungerar inte|funkar inte|doesn't work|does not work|not working)(?![\p{L}])/giu,
  uppskattning: /(?<![\p{L}])(?:tack|thanks|thank you|bra jobbat|well done|snyggt)(?![\p{L}])/giu,
  omtanke: /[❤♥]\uFE0F?|(?<![\p{L}])(?:hoppas det löser sig|ta den tid du behöver|jag finns här|vi finns här|hope it works out|take your time|i am here for you|i'm here for you|we are here for you)(?![\p{L}])/giu,
};

function state(ctx) {
  if (!states.has(ctx.board)) states.set(ctx.board, { kanaler: new Map(), utskick: [], fel: null });
  return states.get(ctx.board);
}

function fail(st, message) {
  st.fel = message;
  console.error('[tomhol]', message);
}

function assess(messages, kanal, now) {
  const recent = messages.filter(m =>
    m.channel === kanal && m.channel !== 'kollegan-events' &&
    Number.isFinite(m.ts) && m.ts > now - WINDOW_MS && m.ts <= now &&
    typeof m.text === 'string'
  ).sort((a, b) => a.ts - b.ts || a.id - b.id).slice(-LIMIT);
  const signaler = { fragor: 0, hinder: 0, uppskattning: 0, omtanke: 0 };
  const kallor = [];
  for (const m of recent) {
    for (const [signal, rule] of Object.entries(rules)) {
      const matches = [...m.text.matchAll(rule)].filter(match => {
        if (signal !== 'hinder' && signal !== 'omtanke') return true;
        const before = m.text.slice(0, match.index);
        return !/(?:inte|inte längre|aldrig|ej|not|no longer|never)\s+(?:\p{L}+\s+){0,2}$/iu.test(before);
      });
      if (matches.length) {
        signaler[signal]++;
        kallor.push({ inlagg: m.id, signal, uttryck: matches[0][0] });
      }
    }
  }
  return {
    kanal,
    fonster: { fran: new Date(now - WINDOW_MS).toISOString(), till: new Date(now).toISOString() },
    antalInlagg: recent.length,
    signaler,
    kallor: kallor.slice(-6),
    metod: 'regelbaserad-sv-en',
    begransningar: [
      'Språksignaler, inte bedömningar av personers känslor.',
      'Ironi, citat och sammanhang kan feltolkas. Regelordlistan är begränsad.',
      'Högst sex källexempel visas; signalantal gäller hela underlaget.',
      'Omtanke är uttryckta stödfraser eller hjärtan; avsikt och ironi kan inte avgöras.',
    ],
  };
}

module.exports = {
  onEvent(e, ctx) {
    if (e.kvarter !== 'team-martin' || !['puls.tempo', 'puls.tryck'].includes(e.typ)) return;
    const st = state(ctx);
    const kanal = e.typ === 'puls.tempo' ? e.nyttolast?.hetaste : e.nyttolast?.kanal;
    if (typeof kanal !== 'string' || !kanal.trim() || kanal.startsWith('#') ||
        kanal === 'kollegan-events' || !Number.isInteger(e.id) ||
        !Number.isInteger(e.djup) || e.djup < 1 || e.djup > 4) {
      fail(st, 'Ogiltig Pulsen-händelse: kanal, id eller djup saknas eller är ogiltigt.');
      return;
    }
    const now = Date.now();
    const payload = assess(ctx.board.query({ channel: kanal, limit: 500 }), kanal, now);
    const previous = st.kanaler.get(kanal);
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
    if (req.method !== 'GET' || ctx.path !== '/status') return false;
    const st = state(ctx);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({
      formaga: 'Stämningen',
      fel: st.fel,
      kanaler: [...st.kanaler.values()].map(({ skickadSignatur, ...view }) => view),
    }));
    return true;
  },
};

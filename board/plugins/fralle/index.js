const fs = require('node:fs');
const path = require('node:path');

const ROLES = [
  { name: 'Örat', words: ['orat', 'ear', 'lyssna', 'mention'] },
  { name: 'Minnet', words: ['minne', 'memory', 'remember', 'beslut', 'bestamt', 'historik', 'handelse', 'vem', 'when'] },
  { name: 'Rösten', words: ['rosten', 'voice', 'formulera'] },
  { name: 'Granskaren', words: ['granska', 'review', 'kalla', 'source', 'sakerhet', 'underlag', 'verify'] },
  { name: 'Översättaren', words: ['oversatt', 'translat', 'english', 'engelska', 'svenska', 'sprak'] },
  { name: 'Stämningen', words: ['stamning', 'mood', 'ton', 'frustration'] },
  { name: 'Pulsen', words: ['puls', 'pulse', 'tempo', 'aktivitet', 'activity'] },
  { name: 'Kön', words: ['kon', 'queue', 'prioritera', 'obesvarad'] },
  { name: 'Mötet', words: ['motet', 'meeting', 'sammanfatta', 'summary'] },
  { name: 'Lotsen', words: ['lots', 'pilot', 'hjalp', 'help'] },
];

const MAX_PER_REQUESTER = 10;
const MAX_RETRIES = 3;
const RETRY_DELAY = 60000;
const LEASE_TIME = 120000;
const STAGES = ['väntar', 'påbörjad', 'väntar på granskning', 'granskat'];
const LIFECYCLE = ['minne.träff', 'sammanfattning.klar', 'svar.utkast', 'svar.granskat', 'svar.klart'];
const emptyState = () => ({ version: 3, questions: [], processed: [], errors: [], turn: 0, served: [], lastClaim: null });
let state = emptyState();
let file;
let storageError = null;
let timer;
const normalize = text => text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
const requesterKey = name => name.normalize('NFC').toLowerCase();

function requester(payload, board) {
  const source = typeof payload.frågare === 'string' ? payload.frågare.trim() : '';
  if (source && source.length <= 40) return source;
  const original = board.query({ limit: 500 }).find(message => message.id === payload.inlägg);
  return original?.from || '(okänd frågare)';
}

function save() {
  fs.writeFileSync(file + '.tmp', JSON.stringify(state));
  fs.renameSync(file + '.tmp', file);
}

function report(id, error) {
  console.error('[fralle] Kön:', error.message);
  state.errors.unshift({ orsak: id, ts: Date.now(), error: error.message });
  state.errors = state.errors.slice(0, 20);
  if (!storageError) {
    try { save(); }
    catch (saveError) {
      storageError = saveError.message;
      console.error('[fralle] Köns lagring:', saveError.message);
    }
  }
}

function trimTerminal() {
  const answered = state.questions.filter(item => item.status === 'besvarad')
    .sort((a, b) => a.besvarad_ts - b.besvarad_ts || a.svarshändelse - b.svarshändelse).slice(-20);
  const cancelled = state.questions.filter(item => item.status === 'återkallad')
    .sort((a, b) => a.återkallad_ts - b.återkallad_ts || a.id - b.id).slice(-20);
  state.questions = [...state.questions.filter(item => item.status === 'väntar'), ...answered, ...cancelled];
}

function queue(now = Date.now()) {
  const served = new Map(state.served.map(item => [item.key, item.turn]));
  const groups = new Map();
  for (const item of state.questions.filter(question => question.status === 'väntar')) {
    const key = requesterKey(item.frågare);
    if (!groups.has(key)) groups.set(key, { key, questions: [], ts: item.ts, id: item.id });
    const group = groups.get(key);
    if (item.ts < group.ts || (item.ts === group.ts && item.id < group.id)) {
      group.ts = item.ts;
      group.id = item.id;
    }
    group.questions.push({
      ...item, prioritet: Math.min(99, item.basprioritet + Math.floor(Math.max(0, now - item.ts) / 60000) * 2),
      väntetid_sek: Math.floor(Math.max(0, now - item.ts) / 1000),
    });
  }
  const ordered = [...groups.values()].sort((a, b) =>
    (served.get(a.key) || 0) - (served.get(b.key) || 0) || a.ts - b.ts || a.id - b.id);
  for (const group of ordered) group.questions.sort((a, b) => b.prioritet - a.prioritet || a.ts - b.ts || a.id - b.id);
  const result = [];
  for (let round = 0; ordered.some(group => group.questions.length > round); round++) {
    for (const group of ordered) {
      if (group.questions[round]) result.push({ ...group.questions[round], köplats: result.length + 1 });
    }
  }
  return result;
}

function markTurn(item) {
  state.turn++;
  const key = requesterKey(item.frågare);
  const retained = new Set(state.questions.map(question => requesterKey(question.frågare)));
  state.served = state.served.filter(previous => previous.key !== key && retained.has(previous.key));
  state.served.push({ key, turn: state.turn });
}

function capabilities(board) {
  const teams = new Map();
  const names = ROLES.map(role => normalize(role.name)).join('|');
  for (const message of board.query({ channel: 'bygge', limit: 500 })) {
    const sender = normalize(message.from).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const claim = new RegExp(`(?:^|[.!?;\\n]\\s*)(?:ja,?\\s+)?(?:(?:team\\s+)?${sender}\\s+|vi\\s+|jag\\s+)?tar\\s+(?:formagan\\s+|organet\\s+)?(${names})(?=$|[^a-z])`, 'g');
    const matches = [...normalize(message.text.replace(/[*_`"]/g, '').trim()).matchAll(claim)];
    const match = matches.at(-1);
    if (!match) continue;
    const role = ROLES.find(item => normalize(item.name) === match[1]);
    if (teams.get(message.from)?.förmåga === role.name) continue;
    teams.set(message.from, { team: message.from, förmåga: role.name, källinlägg: message.id });
  }
  const owners = new Map();
  for (const item of [...teams.values()].sort((a, b) => a.källinlägg - b.källinlägg)) {
    if (!owners.has(item.förmåga)) owners.set(item.förmåga, item);
  }
  return [...owners.values()];
}

function recipients(payload, board, team) {
  const words = normalize(payload.fråga).match(/[a-z0-9]+/g) || [];
  const mentions = new Set((payload.fråga.match(/@[\p{L}\p{N}_.-]+/gu) || []).map(name => normalize(name.slice(1))));
  const matches = capabilities(board).filter(item => item.team !== team).map(item => {
    const role = ROLES.find(candidate => candidate.name === item.förmåga);
    const explicit = mentions.has(normalize(item.team));
    const score = role.words.filter(prefix => words.some(word => word.startsWith(prefix))).length;
    return { ...item, score: explicit ? score + 100 : score, explicit };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || b.källinlägg - a.källinlägg).slice(0, 2);
  const proposals = matches.map(item => ({
    team: item.team,
    förmåga: item.förmåga,
    källinlägg: item.källinlägg,
    motivering: `Teamet har anmält ${item.förmåga} i #bygge; ${item.explicit ? 'du nämner teamet' : 'frågans ord matchar förmågan'}.`,
  }));
  if (proposals.length) return proposals;
  return capabilities(board).filter(item => item.team !== team && item.förmåga === 'Lotsen').slice(0, 2)
    .map(item => ({ ...item, motivering: 'Ingen ämnesmatchning; Lotsen kan hitta rätt team.' }));
}

function relatedQuestion(event, board) {
  const pending = state.questions.filter(item => item.status === 'väntar');
  const events = new Map(board.events(500).map(item => [item.id, item]));
  let current = event;
  const visited = new Set();
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    if (Number.isSafeInteger(current.nyttolast?.fråga_id)) {
      return pending.find(item => item.id === current.nyttolast.fråga_id) || null;
    }
    const match = pending.find(item => item.id === current.id);
    if (match) return match;
    current = events.get(current.orsak);
  }
  const matches = pending.filter(item => item.inlägg !== null && item.inlägg === event.nyttolast?.inlägg);
  return matches.length === 1 ? matches[0] : null;
}

function dispatch(item, { board }, now = Date.now()) {
  if (item.status !== 'väntar' || item.prioritetshändelse || item.utskick.försök >= 1 + MAX_RETRIES) return;
  const position = queue(now).find(question => question.id === item.id);
  item.utskick.försök++;
  item.utskick.nästa_försök = item.utskick.försök <= MAX_RETRIES ? now + RETRY_DELAY : null;
  save();
  let result;
  try { result = board.emit('fråga.prioriterad', {
    orsak: item.id,
    styrka: position.prioritet,
    nyttolast: {
      fråga_id: item.id, fråga: item.fråga, frågare: item.frågare, inlägg: item.inlägg, kanal: item.kanal,
      prioritet: position.prioritet, köplats: position.köplats,
      mottagare: item.mottagare.map(recipient => recipient.team),
      routning: item.mottagare, motivering: item.motivering,
    },
  }); } catch (error) {
    item.utskick.nästa_försök = null;
    item.utskick.fel = error.message;
    report(item.id, error);
    return;
  }
  if (result?.error || !Number.isSafeInteger(result?.handelse?.id) || result.handelse.id <= 0) {
    const message = result?.error || 'Bussen returnerade ingen giltig händelse.';
    item.utskick.fel = message;
    if (!/^max \d+ händelser per minut och kvarter$/.test(message)) item.utskick.nästa_försök = null;
    report(item.id, new Error(message));
    return;
  }
  item.prioritetshändelse = result.handelse.id;
  item.utskick.nästa_försök = null;
  item.utskick.fel = null;
  save();
}

function tick(context, now = Date.now()) {
  if (storageError) return;
  let changed = false;
  for (const item of state.questions) {
    if (item.reservation && item.reservation.till <= now) {
      delete item.reservation;
      changed = true;
      report(item.id, new Error('Reservationen löpte ut. Frågan kan reserveras på nytt.'));
    }
  }
  if (changed) save();
  for (const item of queue(now)) {
    if (item.utskick.nästa_försök !== null && item.utskick.nästa_försök <= now) {
      const stored = state.questions.find(question => question.id === item.id);
      dispatch(stored, context, now);
      if (storageError) break;
    }
  }
}

function accept(event, { board, team }) {
  if (LIFECYCLE.includes(event.typ)) {
    const item = relatedQuestion(event, board);
    if (!item) return;
    if (event.typ === 'svar.klart') {
      item.status = 'besvarad';
      item.steg = 'besvarad';
      item.svarshändelse = event.id;
      item.besvarad_ts = event.ts;
      item.utskick.nästa_försök = null;
      delete item.reservation;
      trimTerminal();
      if (!item.tur_tagen) markTurn(item);
      item.tur_tagen = true;
    } else {
      const stage = event.typ === 'svar.granskat' ? 'granskat'
        : event.typ === 'svar.utkast' ? 'väntar på granskning' : 'påbörjad';
      if (STAGES.indexOf(stage) > STAGES.indexOf(item.steg)) item.steg = stage;
      item.senaste_händelse = event.id;
    }
    save();
    return;
  }
  if (event.typ !== 'fråga.ny' || state.processed.includes(event.id) || state.questions.some(item => item.id === event.id)) return;
  const payload = event.nyttolast;
  if (!Number.isSafeInteger(event.id) || event.id <= 0 || !Number.isFinite(event.ts) || typeof payload?.fråga !== 'string' || !payload.fråga.trim()) {
    throw new Error('fråga.ny behöver id, tidsstämpel och nyttolast.fråga.');
  }
  if (queue().length >= 100) throw new Error('Kön är full (100 väntande frågor); frågan kunde inte läggas till.');
  const name = requester(payload, board);
  if (queue().filter(item => requesterKey(item.frågare) === requesterKey(name)).length >= MAX_PER_REQUESTER) {
    throw new Error(`Max ${MAX_PER_REQUESTER} aktiva frågor per frågare nått för ${name}.`);
  }
  const urgent = /(?:^|[^a-z])(akut|brattom|blockerad|urgent|blocked|stuck)(?:$|[^a-z])/.test(normalize(payload.fråga));
  const item = {
    id: event.id, ts: event.ts, fråga: payload.fråga.slice(0, 300), frågare: name,
    inlägg: Number.isSafeInteger(payload.inlägg) && payload.inlägg > 0 ? payload.inlägg : null,
    kanal: typeof payload.kanal === 'string' ? payload.kanal.slice(0, 30) : null,
    basprioritet: urgent ? 80 : 50, status: 'väntar', steg: 'väntar',
    utskick: { försök: 0, nästa_försök: null, fel: null },
    mottagare: recipients(payload, board, team),
    motivering: urgent ? 'Frågan innehåller en uttrycklig brådske- eller blockeringssignal.' : 'Normal prioritet; äldre frågor får högre prioritet med tiden.',
  };
  state.questions.push(item);
  state.processed = [...state.processed, event.id].slice(-500);
  save();
  dispatch(item, { board, team });
}

function next() {
  if (state.questions.some(item => item.status === 'väntar' && item.reservation)) return null;
  return queue()[0] || null;
}

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
  return true;
}

async function claim(req, res, context) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 4096) return json(res, 413, { error: 'Max 4096 byte i anropet.' });
    chunks.push(buffer);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { return json(res, 400, { error: 'Anropet behöver JSON.' }); }
  if (!body || !Number.isSafeInteger(body.fråga_id) || body.fråga_id <= 0 || typeof body.team !== 'string') {
    return json(res, 400, { error: 'fråga_id och team behövs.' });
  }
  const voice = capabilities(context.board).find(item => item.förmåga === 'Rösten');
  if (!voice) return json(res, 503, { error: 'Rösten har ingen tillgänglig förmågeanmälan.' });
  if (voice.team !== body.team) return json(res, 403, { error: 'Bara anmälda Rösten kan reservera frågor.' });
  // Bodyläsningen är asynkron; läs kö och lagringsstatus först efter sista await.
  if (storageError) return json(res, 503, { error: storageError });
  tick(context);
  const existing = state.questions.find(item => item.status === 'väntar' && item.reservation);
  if (existing) {
    if (existing.id !== body.fråga_id || existing.reservation.team !== body.team) {
      return json(res, 409, { error: 'En fråga är redan reserverad.', fråga_id: existing.id });
    }
    existing.reservation.till = Date.now() + LEASE_TIME;
    save();
    return json(res, 200, { fråga: existing, reservation: existing.reservation });
  }
  const selected = next();
  if (!selected || selected.id !== body.fråga_id) {
    return json(res, 409, { error: 'Frågan står inte först i aktuell turordning.', nästa: selected?.id || null });
  }
  const item = state.questions.find(question => question.id === selected.id);
  item.reservation = { team: body.team, till: Date.now() + LEASE_TIME };
  if (item.steg === 'väntar') item.steg = 'påbörjad';
  markTurn(item);
  item.tur_tagen = true;
  state.lastClaim = Date.now();
  save();
  return json(res, 200, { fråga: item, reservation: item.reservation });
}

module.exports = {
  init({ dataDir, board, team }) {
    if (timer) clearInterval(timer);
    file = path.join(dataDir, 'queue.json');
    storageError = null;
    state = emptyState();
    try {
      if (fs.existsSync(file)) {
        const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (![1, 2, 3].includes(stored.version) || !Array.isArray(stored.questions) || !Array.isArray(stored.processed) ||
          !Array.isArray(stored.errors) || stored.questions.length > 140 ||
          !stored.questions.every(item => item && Number.isSafeInteger(item.id) && Number.isFinite(item.ts) &&
            typeof item.fråga === 'string' && Number.isFinite(item.basprioritet) &&
            ['väntar', 'besvarad', 'återkallad'].includes(item.status) && Array.isArray(item.mottagare))) {
          throw new Error('Ogiltigt format i Köns sparade tillstånd.');
        }
        if (stored.version >= 2 && (!Number.isSafeInteger(stored.turn) || stored.turn < 0 ||
          !Array.isArray(stored.served) || stored.served.length > 140 ||
          !stored.served.every(item => typeof item?.key === 'string' && Number.isSafeInteger(item.turn) && item.turn > 0 && item.turn <= stored.turn) ||
          !stored.questions.every(item => typeof item.frågare === 'string' && item.frågare.length > 0))) {
          throw new Error('Ogiltig turordning i Köns sparade tillstånd.');
        }
        state = stored;
        if (stored.version === 1) {
          state.version = 2;
          state.turn = 0;
          state.served = [];
          for (const item of state.questions) item.frågare = requester(item, board);
          for (const item of state.questions.filter(question => question.status === 'besvarad')
            .sort((a, b) => a.besvarad_ts - b.besvarad_ts || a.svarshändelse - b.svarshändelse)) markTurn(item);
        }
        if (state.version < 3) {
          state.version = 3;
          state.lastClaim = null;
          for (const item of state.questions) {
            item.steg = item.status;
            item.utskick = { försök: item.prioritetshändelse ? 1 : 0, nästa_försök: null, fel: null };
          }
        }
        if (!state.questions.every(item => item.utskick && Number.isInteger(item.utskick.försök) &&
          item.utskick.försök >= 0 && item.utskick.försök <= 1 + MAX_RETRIES &&
          (item.utskick.nästa_försök === null || Number.isFinite(item.utskick.nästa_försök)) &&
          [...STAGES, 'besvarad', 'återkallad'].includes(item.steg) &&
          (!item.reservation || (typeof item.reservation.team === 'string' && Number.isFinite(item.reservation.till))))) {
          throw new Error('Ogiltig behandlingsstatus i Köns sparade tillstånd.');
        }
      }
      for (const event of board.events(500)) {
        if (event.kvarter === team && event.typ === 'fråga.prioriterad') {
          const item = state.questions.find(question => question.id === event.orsak);
          if (item) {
            item.prioritetshändelse = event.id;
            item.utskick.nästa_försök = null;
            item.utskick.fel = null;
          }
        }
        if (event.kvarter !== team && LIFECYCLE.includes(event.typ)) accept(event, { board, team });
      }
      save();
    } catch (error) {
      storageError = error.message;
      throw error;
    }
    timer = setInterval(() => {
      try { tick({ board, team }); }
      catch (error) { report(null, error); }
    }, 1000);
    timer.unref();
  },

  handle(req, res, context) {
    const { path, board } = context;
    if (req.method === 'POST' && path === '/claim') return claim(req, res, context).catch(error => {
      report(null, error);
      return json(res, storageError ? 503 : 500, { error: error.message });
    });
    if (req.method !== 'GET' || !['/status', '/next'].includes(path)) return false;
    if (storageError) return json(res, 503, { error: storageError });
    tick(context);
    if (storageError) return json(res, 503, { error: storageError });
    if (path === '/next') return json(res, 200, {
      fråga: next(), upptagen: state.questions.some(item => item.status === 'väntar' && item.reservation),
    });
    const active = queue();
    return json(res, 200, {
      förmåga: 'Kön', team: 'fralle', error: storageError, förmågor: capabilities(board),
      kö: active, besvarade: state.questions.filter(item => item.status === 'besvarad').slice(-20).reverse(),
      återkallade: state.questions.filter(item => item.status === 'återkallad').slice(-20).reverse(),
      statistik: {
        aktiva: active.length, väntande: active.filter(item => item.steg === 'väntar').length,
        påbörjade: active.filter(item => item.steg === 'påbörjad').length,
        granskning: active.filter(item => ['väntar på granskning', 'granskat'].includes(item.steg)).length,
        äldsta_väntetid_sek: Math.max(0, ...active.map(item => item.väntetid_sek)),
        frågare: new Set(active.map(item => requesterKey(item.frågare))).size,
        senaste_reservation: state.lastClaim,
      },
      fel: state.errors,
    });
  },

  onEvent(event, context) {
    if (event.kvarter === context.team || !['fråga.ny', ...LIFECYCLE].includes(event.typ)) return;
    try {
      if (storageError) throw new Error('Köns lagring är otillgänglig: ' + storageError);
      accept(event, context);
    } catch (error) {
      report(event.id, error);
    }
  },

  onMessage(message, { board }) {
    const match = message.text.match(/^@fralle\s+(?:återkalla|cancel)\s+(\d+)\s*$/iu);
    if (!match) return;
    try {
      if (storageError) throw new Error('Köns lagring är otillgänglig: ' + storageError);
      const item = state.questions.find(question => question.id === Number(match[1]) && question.status === 'väntar');
      let response;
      if (!item) response = 'Ingen aktiv fråga med det händelse-id:t finns i Kön.';
      else if (requesterKey(item.frågare) !== requesterKey(message.from)) response = 'Du kan bara återkalla frågor med ditt eget angivna frågarnamn.';
      else if (item.steg !== 'väntar' || item.reservation) response = 'Frågan har redan börjat behandlas och kan inte återkallas.';
      else {
        item.status = 'återkallad';
        item.steg = 'återkallad';
        item.återkallad_ts = message.ts;
        item.utskick.nästa_försök = null;
        trimTerminal();
        save();
        response = `Fråga ${item.id} är återkallad i Kön.`;
      }
      const result = board.post(response, message.channel, message.id);
      if (result.error) throw new Error(result.error);
    } catch (error) { report(message.id, error); }
  },

  tick,
  stop() { if (timer) clearInterval(timer); },
};

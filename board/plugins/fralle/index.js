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

const emptyState = () => ({ version: 2, questions: [], processed: [], errors: [], turn: 0, served: [] });
let state = emptyState();
let file;
let storageError = null;
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

function completedQuestion(event, board) {
  const pending = state.questions.filter(item => item.status === 'väntar');
  const events = new Map(board.events(500).map(item => [item.id, item]));
  let current = event;
  const visited = new Set();
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    const match = pending.find(item => item.id === current.id || item.id === current.nyttolast?.fråga_id);
    if (match) return match;
    current = events.get(current.orsak);
  }
  const matches = pending.filter(item => item.inlägg !== null && item.inlägg === event.nyttolast?.inlägg);
  return matches.length === 1 ? matches[0] : null;
}

function accept(event, { board, team }) {
  if (event.typ === 'svar.klart') {
    const item = completedQuestion(event, board);
    if (!item) return;
    item.status = 'besvarad';
    item.svarshändelse = event.id;
    item.besvarad_ts = event.ts;
    const completed = state.questions.filter(question => question.status === 'besvarad')
      .sort((a, b) => a.besvarad_ts - b.besvarad_ts || a.svarshändelse - b.svarshändelse).slice(-20);
    state.questions = [...state.questions.filter(question => question.status === 'väntar'), ...completed];
    markTurn(item);
    save();
    return;
  }
  if (event.typ !== 'fråga.ny' || state.processed.includes(event.id) || state.questions.some(item => item.id === event.id)) return;
  const payload = event.nyttolast;
  if (!Number.isSafeInteger(event.id) || event.id <= 0 || !Number.isFinite(event.ts) || typeof payload?.fråga !== 'string' || !payload.fråga.trim()) {
    throw new Error('fråga.ny behöver id, tidsstämpel och nyttolast.fråga.');
  }
  if (queue().length >= 100) throw new Error('Kön är full (100 väntande frågor); frågan kunde inte läggas till.');
  const urgent = /(?:^|[^a-z])(akut|brattom|blockerad|urgent|blocked|stuck)(?:$|[^a-z])/.test(normalize(payload.fråga));
  const item = {
    id: event.id, ts: event.ts, fråga: payload.fråga.slice(0, 300), frågare: requester(payload, board),
    inlägg: Number.isSafeInteger(payload.inlägg) && payload.inlägg > 0 ? payload.inlägg : null,
    kanal: typeof payload.kanal === 'string' ? payload.kanal.slice(0, 30) : null,
    basprioritet: urgent ? 80 : 50, status: 'väntar',
    mottagare: recipients(payload, board, team),
    motivering: urgent ? 'Frågan innehåller en uttrycklig brådske- eller blockeringssignal.' : 'Normal prioritet; äldre frågor får högre prioritet med tiden.',
  };
  state.questions.push(item);
  state.processed = [...state.processed, event.id].slice(-500);
  save();
  const position = queue().find(question => question.id === item.id);
  const result = board.emit('fråga.prioriterad', {
    orsak: event.id,
    styrka: position.prioritet,
    nyttolast: {
      fråga_id: item.id, fråga: item.fråga, frågare: item.frågare, inlägg: item.inlägg, kanal: item.kanal,
      prioritet: position.prioritet, köplats: position.köplats,
      mottagare: item.mottagare.map(recipient => recipient.team),
      routning: item.mottagare, motivering: item.motivering,
    },
  });
  if (result.error) throw new Error(result.error);
  if (!result.handelse) throw new Error('Bussen returnerade ingen händelse.');
  item.prioritetshändelse = result.handelse.id;
  save();
}

module.exports = {
  init({ dataDir, board, team }) {
    file = path.join(dataDir, 'queue.json');
    storageError = null;
    state = emptyState();
    try {
      if (fs.existsSync(file)) {
        const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (![1, 2].includes(stored.version) || !Array.isArray(stored.questions) || !Array.isArray(stored.processed) ||
          !Array.isArray(stored.errors) || stored.questions.length > 120 ||
          !stored.questions.every(item => item && Number.isSafeInteger(item.id) && Number.isFinite(item.ts) &&
            typeof item.fråga === 'string' && Number.isFinite(item.basprioritet) &&
            ['väntar', 'besvarad'].includes(item.status) && Array.isArray(item.mottagare))) {
          throw new Error('Ogiltigt format i Köns sparade tillstånd.');
        }
        if (stored.version === 2 && (!Number.isSafeInteger(stored.turn) || stored.turn < 0 ||
          !Array.isArray(stored.served) || stored.served.length > 120 ||
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
      }
      for (const event of board.events(500)) {
        if (event.kvarter === team && event.typ === 'fråga.prioriterad') {
          const item = state.questions.find(question => question.id === event.orsak);
          if (item) item.prioritetshändelse = event.id;
        }
        if (event.kvarter !== team && event.typ === 'svar.klart') accept(event, { board, team });
      }
      save();
    } catch (error) {
      storageError = error.message;
      throw error;
    }
  },

  handle(req, res, { path, board }) {
    if (req.method !== 'GET' || path !== '/status') return false;
    res.writeHead(storageError ? 503 : 200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({
      förmåga: 'Kön', team: 'fralle', error: storageError, förmågor: capabilities(board),
      kö: queue(), besvarade: state.questions.filter(item => item.status === 'besvarad').slice(-20).reverse(),
      fel: state.errors,
    }));
    return true;
  },

  onEvent(event, context) {
    if (event.kvarter === context.team || !['fråga.ny', 'svar.klart'].includes(event.typ)) return;
    try {
      if (storageError) throw new Error('Köns lagring är otillgänglig: ' + storageError);
      accept(event, context);
    } catch (error) {
      console.error('[fralle] Kön:', error.message);
      state.errors.unshift({ orsak: event.id, ts: Date.now(), error: error.message });
      state.errors = state.errors.slice(0, 20);
      if (!storageError) {
        try { save(); }
        catch (saveError) {
          storageError = saveError.message;
          console.error('[fralle] Köns lagring:', saveError.message);
        }
      }
    }
  },
};

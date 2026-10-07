const fs = require('node:fs');
const path = require('node:path');

function detectLanguage(text) {
  const t = String(text || '').trim();
  if (!t) return 'unknown';
  const lower = t.toLowerCase();
  const swedishLetters = /[åäö]/i.test(lower);
  const englishLetters = /[a-z]/i.test(lower);

  if (swedishLetters && !englishLetters) return 'sv';
  if (englishLetters && !swedishLetters) return 'en';
  if (swedishLetters && englishLetters) {
    const svHits = /(?:hej|hallå|tack|vad|hur|var|när|varför|fors|fråga|språk|översätt|bygga|kollegan|torget|staden)/i.test(lower);
    const enHits = /(?:hello|thanks|what|how|where|when|why|question|language|translate|build|colleague|board|city)/i.test(lower);
    if (svHits && !enHits) return 'sv';
    if (enHits && !svHits) return 'en';
    return 'mixed';
  }
  return 'unknown';
}

function translateText(text, fromLang) {
  const raw = String(text || '').trim();
  if (!raw) return raw;

  const words = raw.split(/\s+/);
  const map = fromLang === 'sv'
    ? {
        hej: 'hello', hallå: 'hello', tack: 'thanks', vad: 'what', hur: 'how', var: 'where', när: 'when',
        varför: 'why', fråga: 'question', frågan: 'question', språk: 'language', översätt: 'translate',
        bygga: 'build', tillsammans: 'together', kollegan: 'colleague', torget: 'board', staden: 'city',
        kvarter: 'district', projekt: 'project', team: 'team', hjälp: 'help', gillar: 'like', kan: 'can',
        finns: 'exists', ser: 'looks', svar: 'answer', leder: 'leads', arbets: 'work', idag: 'today'
      }
    : {
        hello: 'hej', hi: 'hej', thanks: 'tack', what: 'vad', how: 'hur', where: 'var', when: 'när',
        why: 'varför', question: 'fråga', language: 'språk', translate: 'översätt', build: 'bygga', team: 'team',
        colleague: 'kollegan', board: 'torget', city: 'staden', district: 'kvarter', project: 'projekt', help: 'hjälp',
        today: 'idag', together: 'tillsammans', answer: 'svar', can: 'kan', wants: 'vill', like: 'gillar'
      };

  const translated = words.map(word => {
    const cleaned = word.replace(/[^a-zåäöA-ZÅÄÖ?!.]/g, '');
    if (!cleaned) return word;
    const out = map[cleaned.toLowerCase()] || cleaned;
    return out;
  }).join(' ');

  return translated.replace(/\s+([?.!,])/g, '$1');
}

function readState(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return { translations: [], counts: { sv: 0, en: 0 }, last: null };
  }
}

module.exports = {
  init(ctx) {
    ctx.statePath = path.join(ctx.dataDir, 'leif-translator.json');
    ctx.state = readState(ctx.statePath);
  },

  async handle(req, res, { path, board, team, state, statePath }) {
    if (req.method !== 'GET') return false;
    if (path === '/status') {
      const payload = {
        team,
        counts: state.counts || { sv: 0, en: 0 },
        last: state.last || null,
        translations: (state.translations || []).slice(-10),
        posts: board.query({ limit: 50 }).length,
      };
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(payload));
      return true;
    }
    return false;
  },

  onMessage(m, ctx) {
    if (m.from === ctx.team) return;
    const text = String(m.text || '').trim();
    if (!text) return;
    const mention = new RegExp(`@${ctx.team}\\b`, 'i');
    const wantTranslation = /\b(translate|översätt|oversätt|språk|language|english|svenska)\b/i.test(text) || mention.test(text);
    if (!wantTranslation) return;

    const clean = text.replace(mention, '').trim();
    if (!clean) return;
    const lang = detectLanguage(clean);
    if (lang === 'unknown' || lang === 'mixed') return;

    const translated = translateText(clean, lang);
    const result = lang === 'sv'
      ? `Översättning: "${clean}" → "${translated}"`
      : `Translation: "${clean}" → "${translated}"`;

    ctx.state.counts = ctx.state.counts || { sv: 0, en: 0 };
    ctx.state.counts[lang] = (ctx.state.counts[lang] || 0) + 1;
    ctx.state.last = { from: m.from, channel: m.channel, original: clean, translated, lang, ts: Date.now() };
    ctx.state.translations = (ctx.state.translations || []).slice(-19);
    ctx.state.translations.push(ctx.state.last);
    fs.writeFileSync(ctx.statePath, JSON.stringify(ctx.state, null, 2));

    ctx.board.post(result, m.channel, m.id);
  },

  onEvent(e, ctx) {
    if (!e || e.kvarter === ctx.team) return;
    if (e.typ !== 'fråga.ny') return;

    const question = e.nyttolast && e.nyttolast.fråga;
    if (!question) return;

    const lang = detectLanguage(question);
    if (lang === 'unknown' || lang === 'mixed') return;

    const translated = translateText(question, lang);
    const eventType = lang === 'sv' ? 'svar.översatt' : 'svar.översatt';
    ctx.board.emit(eventType, {
      styrka: 55,
      orsak: e.id,
      nyttolast: {
        fråga_id: e.id,
        fråge_källa: e.kvarter,
        original: question,
        översatt: translated,
        språk: lang,
        kanal: e.nyttolast && e.nyttolast.kanal,
      },
    });
  },
};

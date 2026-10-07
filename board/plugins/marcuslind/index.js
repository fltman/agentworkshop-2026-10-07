// Mötet, marcuslinds förmåga i Kollegan.
//   Lyssnar på fråga.ny från Örat (surret) och reagerar bara när frågan ber om en sammanfattning,
//   t.ex. "@kollegan sammanfatta #bygge". Läser kanalens historik via board.query och skickar
//   sammanfattning.klar med en kort översikt, som Rösten kan bygga svaret utifrån.
//
//   GET /t/marcuslind/sammanfattningar   → de senaste sammanfattningarna, för rutan på /staden

const MAX_HISTORIK = 30;

function fil(ctx) {
  const path = require('path');
  return path.join(ctx.dataDir, 'sammanfattningar.json');
}

function lasHistorik(ctx) {
  try {
    const fs = require('fs');
    const f = fil(ctx);
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) { console.error('[marcuslind] läs historik:', e.message); }
  return [];
}

function sparaHistorik(ctx, historik) {
  try {
    const fs = require('fs');
    fs.writeFileSync(fil(ctx), JSON.stringify(historik.slice(-MAX_HISTORIK), null, 2));
  } catch (e) { console.error('[marcuslind] spara historik:', e.message); }
}

function hittaKanal(fraga, standard) {
  const m = /#([a-zåäö0-9-]+)/i.exec(fraga || '');
  return (m ? m[1] : standard || 'torget').toLowerCase();
}

function byggSammanfattning(poster, kanal) {
  if (!poster.length) return `Inget sagt i #${kanal} än.`;
  const deltagare = [...new Set(poster.map(p => p.from))];
  const senaste = poster[poster.length - 1];
  const utdrag = poster.slice(-3).map(p => `${p.from}: ${String(p.text).slice(0, 80)}`).join(' | ');
  return `${poster.length} inlägg i #${kanal} av ${deltagare.length} (${deltagare.slice(0, 5).join(', ')}). Senast: ${utdrag}`;
}

module.exports = {
  async handle(req, res, { path, dataDir }) {
    if (req.method === 'GET' && path === '/sammanfattningar') {
      const historik = lasHistorik({ dataDir });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(historik.slice().reverse()));
      return true;
    }
    return false; // → 404
  },

  onEvent(e, ctx) {
    if (e.kvarter === ctx.team) return;      // reagera inte på oss själva
    if (e.typ !== 'fråga.ny') return;        // vänta på Örats fråga.ny

    const nyttolast = e.nyttolast || {};
    const fraga = nyttolast.fråga || nyttolast.fraga || '';
    if (!/sammanfatta/i.test(fraga)) return; // inte en sammanfattningsförfrågan

    const kanal = hittaKanal(fraga, nyttolast.kanal);
    const poster = ctx.board.query({ channel: kanal, limit: 50 });
    const sammanfattning = byggSammanfattning(poster, kanal);

    const historik = lasHistorik(ctx);
    historik.push({ id: e.id, ts: e.ts, kanal, sammanfattning, antalInlägg: poster.length });
    sparaHistorik(ctx, historik);

    // Granskaren räknar bara källor med styrka >= 50: en lyckad sammanfattning ska alltså
    // alltid ligga över det, en tom kanal får låg styrka så den inte räknas som ett bekräftat svar.
    const styrka = poster.length === 0 ? 20 : Math.min(100, 70 + poster.length);

    ctx.board.emit('sammanfattning.klar', {
      styrka,
      orsak: e.id,
      nyttolast: { kanal, sammanfattning, antalInlägg: poster.length },
    });
  },
};

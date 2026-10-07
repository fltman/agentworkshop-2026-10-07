// Mötet, marcuslinds förmåga i Kollegan.
//   Lyssnar på fråga.ny från Örat (surret) och reagerar på tre typer av frågor:
//   1. "@kollegan sammanfatta #kanal"            → läser kanalens historik, skickar sammanfattning.klar
//   2. "@kollegan anteckna/notera/kom ihåg ..."   → sparar en anteckning, skickar kunskap.ny som kvitto
//   3. "@kollegan vad är antecknat om ..."        → söker sparade anteckningar, skickar kunskap.ny med svaret
//   Mötet är stället där anteckningar och kunskap samlas in, inte bara ett sammanfattningsverktyg.
//
//   GET /t/marcuslind/sammanfattningar   → de senaste sammanfattningarna, för rutan på /staden
//   GET /t/marcuslind/anteckningar       → de senaste anteckningarna, för rutan på /staden
//   GET/POST /t/marcuslind/sms           → SMS i testläge (inget skickas), se sms.js

const sms = require('./sms');

const MAX_HISTORIK = 30;
const MAX_ANTECKNINGAR = 100;

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

function anteckningsFil(ctx) {
  const path = require('path');
  return path.join(ctx.dataDir, 'anteckningar.json');
}

function lasAnteckningar(ctx) {
  try {
    const fs = require('fs');
    const f = anteckningsFil(ctx);
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) { console.error('[marcuslind] läs anteckningar:', e.message); }
  return [];
}

function sparaAnteckningar(ctx, anteckningar) {
  try {
    const fs = require('fs');
    fs.writeFileSync(anteckningsFil(ctx), JSON.stringify(anteckningar.slice(-MAX_ANTECKNINGAR), null, 2));
  } catch (e) { console.error('[marcuslind] spara anteckningar:', e.message); }
}

function portrattFil(ctx) {
  const path = require('path');
  return path.join(ctx.dataDir, 'portratt.json');
}

function lasPortratt(ctx) {
  try {
    const fs = require('fs');
    const f = portrattFil(ctx);
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) { console.error('[marcuslind] läs porträtt:', e.message); }
  return null;
}

function sparaPortratt(ctx, url) {
  try {
    const fs = require('fs');
    fs.writeFileSync(portrattFil(ctx), JSON.stringify({ url, ts: Date.now() }, null, 2));
  } catch (e) { console.error('[marcuslind] spara porträtt:', e.message); }
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

// "anteckna ...", "notera ..." eller "kom ihåg att ..." → texten efter triggerordet sparas.
const ANTECKNA_RX = /\b(?:anteckna|notera|kom ihåg(?: att)?)\b[:,]?\s*(.+)/i;
// "vad är antecknat om X", "visa/hämta/sök anteckningar om X" → X är sökordet (tomt = allt).
const SOK_RX = /\b(?:vad (?:är|finns) antecknat|visa anteckningar|hämta anteckningar|sök anteckningar?)\b(?:\s+om\s+(.+))?/i;

function sokAnteckningar(anteckningar, sokord) {
  if (!sokord) return anteckningar.slice(-5).reverse();
  const ord = sokord.toLowerCase().trim();
  return anteckningar.filter(a => a.text.toLowerCase().includes(ord)).slice(-5).reverse();
}

module.exports = {
  async handle(req, res, ctx) {
    const { path, dataDir } = ctx;
    if (path === '/sms') {
      try {
        return await sms.hantera(req, res, ctx);
      } catch (e) {
        console.error('[marcuslind] sms-route:', e.message);
        if (!res.headersSent) { res.writeHead(500); res.end(); }
        return true;
      }
    }
    if (req.method === 'GET' && path === '/sammanfattningar') {
      const historik = lasHistorik({ dataDir });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(historik.slice().reverse()));
      return true;
    }
    if (req.method === 'GET' && path === '/anteckningar') {
      const anteckningar = lasAnteckningar({ dataDir });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(anteckningar.slice().reverse()));
      return true;
    }
    if (req.method === 'GET' && path === '/portratt') {
      const portratt = lasPortratt({ dataDir });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(portratt || {}));
      return true;
    }
    return false; // → 404
  },

  onEvent(e, ctx) {
    if (e.kvarter === ctx.team) return;      // reagera inte på oss själva

    // Ateljéns porträtt till oss, hängs upp i rutan på /staden.
    if (e.typ === 'bild.klar' && e.kvarter === 'ateljen') {
      const n = e.nyttolast || {};
      if (n.till === ctx.team && n.url) sparaPortratt(ctx, n.url);
      return;
    }

    if (e.typ !== 'fråga.ny') return;        // vänta på Örats fråga.ny

    const nyttolast = e.nyttolast || {};
    const fraga = nyttolast.fråga || nyttolast.fraga || '';

    if (/sammanfatta/i.test(fraga)) {
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
      return;
    }

    const antecknaMatch = ANTECKNA_RX.exec(fraga);
    if (antecknaMatch) {
      const text = antecknaMatch[1].trim();
      if (!text) return;
      const kanal = nyttolast.kanal || 'torget';
      const anteckningar = lasAnteckningar(ctx);
      anteckningar.push({ id: e.id, ts: e.ts, kanal, text, från: nyttolast.frågare || e.kvarter });
      sparaAnteckningar(ctx, anteckningar);

      ctx.board.emit('kunskap.ny', {
        styrka: 90, // en bekräftad handling, inget att tvivla på
        orsak: e.id,
        nyttolast: { svar: `Antecknat: "${text}" (i #${kanal}).` },
      });
      return;
    }

    const sokMatch = SOK_RX.exec(fraga);
    if (sokMatch) {
      const anteckningar = lasAnteckningar(ctx);
      const träffar = sokAnteckningar(anteckningar, sokMatch[1]);
      const svar = träffar.length
        ? träffar.map(a => `"${a.text}" (#${a.kanal})`).join(' | ')
        : `Inget antecknat${sokMatch[1] ? ' om ' + sokMatch[1].trim() : ''} än.`;

      ctx.board.emit('kunskap.ny', {
        styrka: träffar.length ? 85 : 20,
        orsak: e.id,
        nyttolast: { svar },
      });
    }
  },
};

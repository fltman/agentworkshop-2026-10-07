// Granskaren, marcuslinds förmåga i Kollegan.
//   Lyssnar på svar.klart / svar.utkast från andra team (Rösten) och granskar dem innan de går vidare:
//   finns en källa (orsak) att spåra svaret till, och håller styrkan vad innehållet faktiskt visar?
//   Skickar svar.granskat med en (ofta nedjusterad) styrka och en kort motivering, så granskningen
//   syns i kedjan utan att Granskaren själv postar på Torget.
//
//   GET /t/marcuslind/granskningar   → de senaste granskningarna, för rutan på /staden
//
// Ett svar utan spårbar källa (ingen orsak-kedja) eller utan synligt svarsinnehåll bedöms lägre,
// så kedjan blir ärligare än den enskilda Rösten hävdar.

const MAX_HISTORIK = 50;

function lasHistorik(ctx) {
  try {
    const fs = require('fs');
    const path = require('path');
    const fil = path.join(ctx.dataDir, 'granskningar.json');
    if (fs.existsSync(fil)) return JSON.parse(fs.readFileSync(fil, 'utf8'));
  } catch (e) { console.error('[marcuslind] läs historik:', e.message); }
  return [];
}

function sparaHistorik(ctx, historik) {
  try {
    const fs = require('fs');
    const path = require('path');
    const fil = path.join(ctx.dataDir, 'granskningar.json');
    fs.writeFileSync(fil, JSON.stringify(historik.slice(-MAX_HISTORIK), null, 2));
  } catch (e) { console.error('[marcuslind] spara historik:', e.message); }
}

function granska(e) {
  const nyttolast = e.nyttolast || {};
  const harSvarstext = typeof nyttolast.svar === 'string' && nyttolast.svar.trim().length > 0;
  const harSparbarKalla = typeof e.orsak === 'number';
  const paststaddStyrka = typeof e.styrka === 'number' ? e.styrka : 50;

  let styrka = paststaddStyrka;
  let bedomning = 'godkänd';
  let motivering = 'Svaret har en spårbar källa och synligt innehåll.';

  if (!harSvarstext) {
    styrka = Math.min(styrka, 20);
    bedomning = 'avvisad';
    motivering = 'Inget svarsinnehåll att granska i nyttolasten.';
  } else if (!harSparbarKalla) {
    styrka = Math.max(0, Math.round(styrka * 0.6));
    bedomning = 'nedjusterad';
    motivering = 'Svaret saknar en spårbar källhändelse (orsak), sänker säkerheten.';
  } else if (paststaddStyrka > 85) {
    // Rösten påstår nästan total säkerhet. Granskaren är mer återhållsam av princip.
    styrka = 85;
    bedomning = 'nedjusterad';
    motivering = 'Påstådd säkerhet var ovanligt hög, jämnad ut till ett rimligare tak.';
  }

  return { styrka, bedomning, motivering };
}

module.exports = {
  async handle(req, res, { path, dataDir }) {
    if (req.method === 'GET' && path === '/granskningar') {
      const historik = lasHistorik({ dataDir });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(historik.slice().reverse()));
      return true;
    }
    return false; // → 404
  },

  onEvent(e, ctx) {
    if (e.kvarter === ctx.team) return; // granska inte oss själva
    if (e.typ !== 'svar.klart' && e.typ !== 'svar.utkast') return;

    const { styrka, bedomning, motivering } = granska(e);

    const historik = lasHistorik(ctx);
    historik.push({
      id: e.id,
      ts: e.ts,
      kvarter: e.kvarter,
      bedomning,
      styrka,
      motivering,
    });
    sparaHistorik(ctx, historik);

    ctx.board.emit('svar.granskat', {
      styrka,
      orsak: e.id,
      nyttolast: { bedomning, motivering, kvarter: e.kvarter },
    });
  },
};

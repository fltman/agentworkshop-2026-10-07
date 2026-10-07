// heimlen: Granskaren, en förmåga i Kollegan.
//
// Lyssnar på svar-händelser från andra förmågor (typ som börjar med "svar.", t.ex. Röstens
// svar.utkast/svar.klart) och bedömer källa + säkerhet innan svaret går vidare: finns det
// stöd i kedjan från andra förmågor (t.ex. Minnet), eller står svaret ensamt?
// Skickar tillbaka svar.granskat med en justerad styrka och ett skäl, så Rösten (eller vem
// som postar till slut) kan ta hänsyn till granskningen, och Stadens minne kan arkivera den.
//
// GET /t/heimlen/granskningar → de senaste granskningarna, för rutan på /staden.

const fs = require('fs');
const path = require('path');

const MAX_HISTORIK = 50;
const GODKÄND_GRÄNS = 50;

function läsHistorik(dataDir) {
  try {
    const p = path.join(dataDir, 'granskningar.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return [];
  }
}

function sparaHistorik(dataDir, historik) {
  try {
    fs.writeFileSync(path.join(dataDir, 'granskningar.json'), JSON.stringify(historik.slice(-MAX_HISTORIK)));
  } catch (err) {
    console.error('[heimlen] kunde inte spara granskningar:', err.message);
  }
}

// Bygger kedjan bakåt från en händelse via orsak, så vi kan se vilka förmågor som bidragit.
function förfäder(e, index) {
  const kedja = [];
  let nuvarande = e;
  let varv = 0;
  while (nuvarande && nuvarande.orsak && varv < 8) {
    const förälder = index.get(nuvarande.orsak);
    if (!förälder) break;
    kedja.push(förälder);
    nuvarande = förälder;
    varv++;
  }
  return kedja;
}

// Hittar kunskapshändelser i samma frågeträd (både direkta förfäder och syskon med samma rot/orsak)
function hittaRelevantaKunskaper(e, senaste, index, team) {
  const förfäderTillE = förfäder(e, index);
  const förfaderIdn = new Set([e.id, ...förfäderTillE.map((h) => h.id)]);
  if (e.orsak) förfaderIdn.add(e.orsak);

  return senaste.filter((h) => {
    if (h.kvarter === e.kvarter || h.kvarter === team) return false;
    const ärKunskap = h.typ.startsWith('minne.') || h.typ.startsWith('kunskap.') || h.typ.startsWith('sammanfattning.');
    if (!ärKunskap) return false;
    if ((h.styrka ?? 50) < 50) return false;

    // Direkt förfader eller syskon som reagerat på samma fråga/förfader
    return förfaderIdn.has(h.id) || (h.orsak && förfaderIdn.has(h.orsak));
  });
}

module.exports = {
  init(ctx) {
    ctx.historik = läsHistorik(ctx.dataDir);
    ctx.granskade = new Set(ctx.historik.map((g) => g.handelse));
    ctx.latenser = [];
    ctx.senasteMetrikUtskick = 0;
  },

  async handle(req, res, ctx) {
    const p = ctx.path;
    if (req.method === 'GET' && (p === '/granskningar' || p === '/metrics' || p === '/status')) {
      const g = ctx.historik || [];
      const total = g.length;
      const godkända = g.filter((x) => x.godkänt).length;
      const underkända = total - godkända;
      const godkändAndel = total ? Math.round((godkända / total) * 100) : 0;
      const snittStyrka = total ? Math.round(g.reduce((acc, x) => acc + x.styrka, 0) / total) : 0;

      const latenser = ctx.latenser || [];
      const snittLatensMs = latenser.length ? Math.round(latenser.reduce((a, b) => a + b, 0) / latenser.length) : null;

      const källorFrekvens = {};
      for (const item of g) {
        if (item.källor && Array.isArray(item.källor)) {
          for (const k of item.källor) {
            källorFrekvens[k] = (källorFrekvens[k] || 0) + 1;
          }
        }
      }

      const metrics = {
        total,
        godkända,
        underkända,
        godkändAndel,
        snittStyrka,
        snittLatensMs,
        latensHistorik: latenser.slice(-20),
        källorFrekvens,
      };

      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ metrics, granskningar: g.slice().reverse() }));
      return true;
    }
    return false;
  },

  onEvent(e, ctx) {
    if (e.kvarter === ctx.team) return;              // inte granska oss själva

    // Mäta total kedjelatens när svar.klart anländer
    if (e.typ === 'svar.klart') {
      const senaste = ctx.board.events(200);
      const index = new Map(senaste.map((h) => [h.id, h]));
      const kedja = förfäder(e, index);
      const rotFråga = kedja.find((h) => h.typ === 'fråga.ny');
      if (rotFråga && e.ts && rotFråga.ts) {
        const latens = Math.max(100, e.ts - rotFråga.ts);
        if (!ctx.latenser) ctx.latenser = [];
        ctx.latenser.push(latens);
        if (ctx.latenser.length > 50) ctx.latenser.shift();
      }

      // Punkt 2: Sänd granskaren.metrik på bussen med högst 1 utskick per 60 sekunder
      const nu = Date.now();
      if (!ctx.senasteMetrikUtskick || nu - ctx.senasteMetrikUtskick > 60000) {
        const g = ctx.historik || [];
        if (g.length > 0) {
          const godkända = g.filter((x) => x.godkänt).length;
          const godkändAndel = Math.round((godkända / g.length) * 100);
          const snittStyrka = Math.round(g.reduce((acc, x) => acc + x.styrka, 0) / g.length);
          const latenser = ctx.latenser || [];
          const snittLatensMs = latenser.length ? Math.round(latenser.reduce((a, b) => a + b, 0) / latenser.length) : 0;
          const rad = `Kvalitetsstatus: ${godkändAndel}% godkända svar (snittstyrka ${snittStyrka}), snittlatens ${(snittLatensMs / 1000).toFixed(1)}s`;

          ctx.board.emit('granskaren.metrik', {
            styrka: godkändAndel,
            orsak: e.id,
            nyttolast: {
              godkänd_andel: godkändAndel,
              snitt_styrka: snittStyrka,
              snitt_latens_ms: snittLatensMs,
              granskade_totalt: g.length,
              rad,
            },
          });
          ctx.senasteMetrikUtskick = nu;
        }
      }
      return;
    }

    if (e.typ !== 'svar.utkast') return;             // granska bara utkast, inte svar.klart eller svar.granskat
    if (!ctx.granskade) ctx.granskade = new Set();
    if (!ctx.historik) ctx.historik = [];
    if (ctx.granskade.has(e.id)) return;              // en granskning per händelse

    const senaste = ctx.board.events(200);
    const index = new Map(senaste.map((h) => [h.id, h]));
    // Hitta kunskaper i samma frågeträd (både förfäder och syskon som pekar på samma rotfråga)
    const kunskapsHändelser = hittaRelevantaKunskaper(e, senaste, index, ctx.team);
    const källor = [...new Set(kunskapsHändelser.map((h) => h.kvarter))];

    const grundStyrka = e.styrka ?? 50;
    let styrka;
    let skäl;
    if (källor.length === 0) {
      styrka = Math.max(5, grundStyrka - 25);
      skäl = 'inget bekräftande underlag i kedjan';
    } else {
      styrka = Math.min(100, grundStyrka + 10 * Math.min(källor.length, 3));
      skäl = `bekräftat av ${källor.length} förmåga/förmågor: ${källor.join(', ')}`;
    }
    const godkänt = styrka >= GODKÄND_GRÄNS;

    const svar = e.nyttolast && (e.nyttolast.svar || e.nyttolast.fråga);
    const resultat = ctx.board.emit('svar.granskat', {
      styrka,
      orsak: e.id,
      nyttolast: { svar: svar ?? null, godkänt, skäl, ursprunglig_styrka: grundStyrka, källor },
    });
    if (resultat && resultat.error) { console.error('[heimlen] emit svar.granskat:', resultat.error); return; }

    ctx.granskade.add(e.id);
    ctx.historik.push({
      handelse: e.id, ts: Date.now(), från: e.kvarter, godkänt, styrka, skäl, källor,
      svar: typeof svar === 'string' ? svar.slice(0, 200) : null,
    });
    sparaHistorik(ctx.dataDir, ctx.historik);
  },

  onMessage(m, { board, team }) {
    if (m.from === team) return;
    if (!new RegExp(`@${team}\\b`, 'i').test(m.text)) return;
    board.post('Jag är Granskaren: jag kollar källa och säkerhet på svar i Kollegans kedja, se /t/heimlen/granskningar eller rutan på /staden.', m.channel, m.id);
  },
};

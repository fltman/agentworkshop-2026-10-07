// Lotsen (babtist): hittar team eller agent som kan svara när Kollegan inte kan.
//
// Lyssnar på två händelser från andra kvarter:
//   fråga.ny        (Örat, surret)      – ny fråga, föreslå direkt vem som redan pratat om ämnet
//   svar.granskat    (Granskaren)        – lågt styrka-betyg, leta en bättre källa längs med
// och skickar lots.förslag {fråga, förslag, källa, kanal} med orsak satt till händelsen vi reagerar på.
//
// GET /t/babtist/forslag  → de senaste lots.förslag, för /staden-rutan.

const STOPPORD = new Set([
  'och', 'att', 'det', 'som', 'för', 'med', 'när', 'hur', 'vem', 'vad', 'har', 'inte', 'kan', 'ska',
  'vill', 'från', 'till', 'den', 'är', 'en', 'ett', 'jag', 'du', 'vi', 'ni', 'de', 'på', 'av', 'om', 'så',
]);

function nyckelord(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-zåäö0-9@\s]/g, ' ')
    .split(/\s+/)
    .filter((ord) => ord.length > 3 && !STOPPORD.has(ord));
}

// Letar bland Torgets senaste inlägg efter vem (utöver oss själva) som redan nämnt flest nyckelord.
function hittaKandidat(board, team, ord) {
  if (!ord.length) return null;
  const inlagg = board.query({ limit: 300 });
  let bast = null;
  let bastPoang = 0;
  for (const m of inlagg) {
    if (m.from === team || m.channel === 'kollegan-events') continue;
    const text = String(m.text || '').toLowerCase();
    let poang = 0;
    for (const o of ord) if (text.includes(o)) poang++;
    if (poang > bastPoang) {
      bastPoang = poang;
      bast = m;
    }
  }
  return bastPoang > 0 ? { agent: bast.from, kanal: bast.channel, inlägg: bast.id, poäng: bastPoang } : null;
}

// Vandrar bakåt i orsak-kedjan för att hitta ursprungsfrågan (fråga.ny), oavsett hur många led bort vi är.
function finnFraga(handelser, e) {
  const byId = new Map(handelser.map((x) => [x.id, x]));
  let cur = e;
  for (let i = 0; i < 5 && cur; i++) {
    if (cur.typ === 'fråga.ny' && cur.nyttolast && cur.nyttolast.fråga) return cur;
    cur = cur.orsak ? byId.get(cur.orsak) : null;
  }
  return null;
}

module.exports = {
  async handle(req, res, { path, board }) {
    if (req.method === 'GET' && path === '/forslag') {
      const forslag = board.events(200).filter((e) => e.typ === 'lots.förslag').slice(-20);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(forslag));
      return true;
    }
    return false; // → 404
  },

  onEvent(e, ctx) {
    if (e.kvarter === ctx.team) return; // reagera aldrig på oss själva

    let fragaEvent = null;
    if (e.typ === 'fråga.ny') {
      fragaEvent = e;
    } else if (e.typ === 'svar.granskat' && e.styrka !== null && e.styrka < 60) {
      fragaEvent = finnFraga(ctx.board.events(200), e);
    } else {
      return;
    }
    if (!fragaEvent || !fragaEvent.nyttolast || !fragaEvent.nyttolast.fråga) return;

    const ord = nyckelord(fragaEvent.nyttolast.fråga);
    const kandidat = hittaKandidat(ctx.board, ctx.team, ord);
    if (!kandidat) return;

    ctx.board.emit('lots.förslag', {
      styrka: Math.min(100, kandidat.poäng * 25),
      nyttolast: {
        fråga: fragaEvent.nyttolast.fråga,
        förslag: kandidat.agent,
        källa: kandidat.inlägg,
        kanal: kandidat.kanal,
      },
      orsak: e.id,
    });
  },
};

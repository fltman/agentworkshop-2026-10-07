// mikael: Rösten i Kollegan.
//
// Flödet en fråga går igenom hos oss:
//   1. Örat (ett annat kvarter) hör "@kollegan ..." och skickar fråga.ny.
//   2. Vi väntar en kort stund på minne.träff/kunskap.ny från Minnet (samma orsak), för underlag.
//   3. Vi formulerar ett svarsutkast och skickar svar.utkast (orsak = fråga.ny).
//   4. Granskaren (ett annat kvarter) granskar och skickar svar.granskat (orsak = vårt svar.utkast).
//   5. Vi postar det slutgiltiga svaret på Torget och skickar svar.klart (orsak = svar.granskat).
//
// GET /t/mikael/status → de senaste frågorna/svaren vi hanterat, för rutan på /staden.

const VÄNTA_PÅ_MINNE_MS = 2500;
const MAX_HISTORIK = 30;

// Modulens eget minne. Ett plugin laddas en gång per serverprocess, så vanliga variabler räcker.
const pending = new Map();          // fråga.ny id -> { fråga, inlägg, kanal, kunskap: [{källa, text, id}] }
const utkastTillFråga = new Map();  // svar.utkast id -> fråga.ny id
const granskatHanterat = new Set(); // svar.granskat id som redan besvarats
const historik = [];                // { fråga, svar, styrka, ts } för rutan på /staden

module.exports = {
  async handle(req, res, { path, team }) {
    if (req.method === 'GET' && path === '/status') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ team, historik: historik.slice(-MAX_HISTORIK) }));
      return true;
    }
    return false;
  },

  onEvent(e, ctx) {
    const { board, team } = ctx;
    if (e.kvarter === team) return; // reagera inte på oss själva

    if (e.typ === 'fråga.ny') {
      pending.set(e.id, {
        fråga: (e.nyttolast && e.nyttolast.fråga) || '',
        inlägg: e.nyttolast && e.nyttolast.inlägg,
        kanal: (e.nyttolast && e.nyttolast.kanal) || 'torget',
        frågare: e.nyttolast && e.nyttolast.frågare,
        kunskap: [],
      });

      const frågaId = e.id;
      const timer = setTimeout(() => {
        try { formuleraSvar(frågaId, board); }
        catch (err) { console.error('[mikael] kunde inte formulera svar', err && err.message); }
      }, VÄNTA_PÅ_MINNE_MS);
      if (timer.unref) timer.unref();
      return;
    }

    if (e.typ === 'minne.träff' || e.typ === 'kunskap.ny') {
      const frågaId = hittaFråga(e.orsak);
      if (frågaId) {
        const text = plockaText(e.nyttolast);
        if (text) pending.get(frågaId).kunskap.push({ källa: e.kvarter, text, id: e.id });
      }
      return;
    }

    if (e.typ === 'svar.granskat') {
      const frågaId = utkastTillFråga.get(e.orsak);
      if (!frågaId || granskatHanterat.has(e.id)) return;
      granskatHanterat.add(e.id);

      const post = pending.get(frågaId);
      if (!post) return;

      const styrka = typeof e.styrka === 'number' ? e.styrka : 50;
      const osäkert = styrka < 60;
      const text = (osäkert ? '(osäkert) ' : '') + post.svarstext;
      // "Kollegan: " i stället för "@kollegan": ett svar som börjar med @kollegan hörs av Örat
      // som en ny fråga, och kedjan loopar på sig själv.
      const hälsning = post.frågare ? `Kollegan: @${post.frågare}, ` : 'Kollegan: ';

      board.post(`${hälsning}${text}`, post.kanal, post.inlägg);
      board.emit('svar.klart', { orsak: e.id, styrka, nyttolast: { fråga: post.fråga, inlägg: post.inlägg } });

      historik.push({ fråga: post.fråga, svar: text, styrka, ts: Date.now() });
      if (historik.length > MAX_HISTORIK) historik.shift();

      pending.delete(frågaId);
      return;
    }
  },
};

function hittaFråga(orsakId) {
  // orsak kan peka direkt på fråga.ny, eller på en tidigare minne-händelse i samma kedja.
  if (pending.has(orsakId)) return orsakId;
  for (const [frågaId, post] of pending) {
    if (post.kunskap.some((k) => k.id === orsakId)) return frågaId;
  }
  return null;
}

function plockaText(nyttolast) {
  if (!nyttolast) return null;
  const kandidat = nyttolast.svar || nyttolast.sammanfattning || nyttolast.text || nyttolast.kunskap || nyttolast.fakta;
  return typeof kandidat === 'string' ? kandidat : null;
}

function formuleraSvar(frågaId, board) {
  const post = pending.get(frågaId);
  if (!post) return; // redan hanterad eller borttagen

  let svarstext;
  let styrka;
  if (post.kunskap.length) {
    svarstext = post.kunskap.map((k) => k.text).join(' ');
    styrka = 70;
  } else {
    svarstext = `Jag har inget säkert underlag från Minnet än om "${post.fråga}". Fråga igen om en stund, eller nämn ämnet mer specifikt.`;
    styrka = 35;
  }
  post.svarstext = svarstext;

  const resultat = board.emit('svar.utkast', {
    orsak: frågaId,
    styrka,
    nyttolast: { fråga: post.fråga, svar: svarstext, kanal: post.kanal, inlägg: post.inlägg },
  });
  const utkastId = resultat && resultat.handelse && resultat.handelse.id;
  if (utkastId) utkastTillFråga.set(utkastId, frågaId);
}

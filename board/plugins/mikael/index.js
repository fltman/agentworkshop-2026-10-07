// mikael: Rösten i Kollegan.
//
// Flödet en fråga går igenom hos oss:
//   1. Örat (ett annat kvarter) hör "@kollegan ..." och skickar fråga.ny.
//   2. Vi väntar en kort stund på minne.träff/kunskap.ny (Minnet) och sammanfattning.klar (Mötet),
//      samma orsak, för underlag.
//   3. Vi formulerar ett svarsutkast och skickar svar.utkast (orsak = fråga.ny).
//   4. Granskaren (ett annat kvarter) granskar och skickar svar.granskat (orsak = vårt svar.utkast).
//   5. Vi postar det slutgiltiga svaret på Torget och skickar svar.klart (orsak = svar.granskat).
//
// GET /t/mikael/status → de senaste frågorna/svaren vi hanterat, för rutan på /staden.

// Kön (fralle): reservations-API på /t/fralle/next och /t/fralle/claim, se #bygge 442/556/637 (PR 35,
// live). Reglerna fralle satte: 409 (fel köplats/upptagen/återkallad) betyder att vi INTE får jobba
// vidare eller publicera just nu, vi ska vänta och försöka igen, inte köra ändå. Är API:t helt onåbart
// (nätverksfel, eller 404 om det skulle sluta finnas) litar vi inte på Kön och kör direktflödet, så en
// nere Kö inte stoppar hela Kollegan.
const KÖ_PORT = process.env.PORT || 8180;
const KÖ_VÄNTA_MS = 1500;
const KÖ_MAX_FÖRSÖK = 40; // ~60 s väntan på vår tur innan vi ger upp tyst (ingen publicering då)

async function försökReservera(frågaId) {
  if (typeof fetch !== 'function') return 'onåbar'; // ingen fetch i den här node-versionen
  try {
    const svar = await fetch(`http://127.0.0.1:${KÖ_PORT}/t/fralle/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fråga_id: frågaId, team: 'mikael' }),
    });
    if (svar.ok) return 'reserverad';
    if (svar.status === 409) return 'nekad';     // fel köplats, upptagen, eller återkallad: vänta
    if (svar.status === 404) return 'onåbar';     // API:t finns inte (ännu), kör utan kön
    return 'onåbar';                              // oväntat fel: lita inte på kön just nu
  } catch {
    return 'onåbar'; // Kön onåbar just nu
  }
}

// Reserverar innan vi jobbar vidare. Ger "reserverad" (kör), "stoppa" (ge upp tyst, publicera inte)
// eller "onåbar" (Kön kan inte svara för oss, kör direktflödet som innan reservations-API:t fanns).
async function säkraReservation(frågaId) {
  for (let försök = 0; försök < KÖ_MAX_FÖRSÖK; försök++) {
    if (!pending.has(frågaId)) return 'stoppa'; // frågan plockades bort under tiden
    const resultat = await försökReservera(frågaId);
    if (resultat === 'reserverad' || resultat === 'onåbar') return resultat;
    // 'nekad': inte vår tur än, vänta och försök igen utan att jobba vidare
    await new Promise((klar) => setTimeout(klar, KÖ_VÄNTA_MS));
  }
  return 'stoppa'; // väntat länge nog, ger upp tyst hellre än att bryta mot turordningen
}

async function väntaPåTurOchSchemalägg(frågaId, board, väntetid) {
  const status = await säkraReservation(frågaId);
  if (status === 'stoppa') { pending.delete(frågaId); return; }
  const timer = setTimeout(() => {
    try { formuleraSvar(frågaId, board); }
    catch (err) { console.error('[mikael] kunde inte formulera svar', err && err.message); }
  }, väntetid);
  if (timer.unref) timer.unref();
}

// Körs direkt före publicering: förnyar reservationen. Nekas förnyelsen ska vi inte publicera
// (fralle #bygge 556/637): någon annan har tagit över eller frågan är återkallad.
async function fårPublicera(frågaId) {
  const status = await försökReservera(frågaId);
  return status !== 'nekad';
}

const VÄNTA_PÅ_MINNE_MS = 2500;
const VÄNTA_LÄNGRE_MS = 4000;          // frågor om sammanfattningar: Mötet svarar ofta senare
const VÄNTA_PÅ_GRANSKNING_MS = 20000;  // postar ett ogranskat svar om Granskaren uteblir
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
      const fråga = (e.nyttolast && e.nyttolast.fråga) || '';
      const väntetid = /sammanfatta|hänt|hände/i.test(fråga) ? VÄNTA_LÄNGRE_MS : VÄNTA_PÅ_MINNE_MS;
      väntaPåTurOchSchemalägg(frågaId, board, väntetid)
        .catch((err) => console.error('[mikael] kö-reservation', err && err.message));
      return;
    }

    if (e.typ === 'minne.träff' || e.typ === 'kunskap.ny' || e.typ === 'sammanfattning.klar') {
      const frågaId = hittaFråga(e.orsak);
      if (frågaId) {
        const text = plockaText(e.nyttolast);
        if (text) pending.get(frågaId).kunskap.push({ källa: e.kvarter, text, id: e.id, typ: e.typ, styrka: e.styrka });
      }
      return;
    }

    if (e.typ === 'svar.granskat') {
      const frågaId = utkastTillFråga.get(e.orsak);
      if (!frågaId || granskatHanterat.has(e.id)) return;
      granskatHanterat.add(e.id);

      const post = pending.get(frågaId);
      if (!post) return;
      if (post.granskningsTimer) { clearTimeout(post.granskningsTimer); post.granskningsTimer = null; }

      publiceraGranskatSvar(frågaId, e, board)
        .catch((err) => console.error('[mikael] kunde inte publicera granskat svar', err && err.message));
      return;
    }
  },
};

async function publiceraGranskatSvar(frågaId, e, board) {
  const post = pending.get(frågaId);
  if (!post) return;

  // Förnyar reservationen innan publicering. Nekas den (409: upptagen/återkallad) publicerar vi
  // inte, enligt fralle #bygge 556/637.
  if (!(await fårPublicera(frågaId))) { pending.delete(frågaId); return; }
  if (!pending.has(frågaId)) return; // borttagen under väntan

  const styrka = typeof e.styrka === 'number' ? e.styrka : 50;
  const osäkert = styrka < 60;
  const text = (osäkert ? '(osäkert) ' : '') + post.svarstext;
  // "Kollegan: " i stället för "@kollegan": ett svar som börjar med @kollegan hörs av Örat
  // som en ny fråga, och kedjan loopar på sig själv.
  const hälsning = post.frågare ? `Kollegan: @${post.frågare}, ` : 'Kollegan: ';

  board.post(`${hälsning}${text}`, post.kanal, post.inlägg);
  board.emit('svar.klart', { orsak: e.id, styrka, nyttolast: { fråga: post.fråga, fråga_id: frågaId, inlägg: post.inlägg } });

  historik.push({ fråga: post.fråga, svar: text, styrka, ts: Date.now() });
  if (historik.length > MAX_HISTORIK) historik.shift();

  pending.delete(frågaId);
}

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
  // nyttolast.rad (Pulsen m.fl.) är redan ett läsbart radformat, föredra den. Annars svar/sammanfattning/
  // text/kunskap/fakta, men städa bort inbäddad rå JSON som Minnets generiska fallback ibland bifogar
  // (t.ex. ett citerat {"kanal":...} från en annan händelse) — se #bygge 530/561.
  const kandidat = nyttolast.rad || nyttolast.svar || nyttolast.sammanfattning || nyttolast.text || nyttolast.kunskap || nyttolast.fakta;
  if (typeof kandidat !== 'string') return null;
  const städad = städaRåJson(kandidat);
  return städad || null;
}

function städaRåJson(text) {
  // Klipper bort allt från första '{"' (ett JSON-objekt som smugit med), behåller texten innan.
  const index = text.indexOf('{"');
  const kort = index === -1 ? text : text.slice(0, index).trim();
  return kort;
}

function formuleraSvar(frågaId, board) {
  const post = pending.get(frågaId);
  if (!post) return; // redan hanterad eller borttagen

  // Prioritera Mötets sammanfattning när den finns, annars Minnets träffar med rimlig styrka.
  // Minnet skickar ibland styrka 0-20 med "saknar underlag", det ska inte duggas in i svaret.
  const sammanfattning = post.kunskap.find((k) => k.typ === 'sammanfattning.klar');
  const bra = sammanfattning ? [sammanfattning] : post.kunskap.filter((k) => k.styrka == null || k.styrka >= 50);

  let svarstext;
  let styrka;
  if (bra.length) {
    svarstext = bra.map((k) => k.text).join(' ');
    styrka = 70;
  } else {
    svarstext = `Jag har inget säkert underlag från Minnet än om "${post.fråga}". Fråga igen om en stund, eller nämn ämnet mer specifikt.`;
    styrka = 35;
  }
  post.svarstext = svarstext;

  const resultat = board.emit('svar.utkast', {
    orsak: frågaId,
    styrka,
    nyttolast: { fråga: post.fråga, fråga_id: frågaId, svar: svarstext, kanal: post.kanal, inlägg: post.inlägg },
  });
  const utkastId = resultat && resultat.handelse && resultat.handelse.id;
  if (!utkastId) return;
  utkastTillFråga.set(utkastId, frågaId);

  // Granskaren kan vara nere eller sakna kapacitet: posta ett ogranskat svar hellre än inget alls.
  const timer = setTimeout(() => {
    try { postaOgranskat(frågaId, utkastId, board); }
    catch (err) { console.error('[mikael] kunde inte posta ogranskat svar', err && err.message); }
  }, VÄNTA_PÅ_GRANSKNING_MS);
  if (timer.unref) timer.unref();
  post.granskningsTimer = timer;
}

function postaOgranskat(frågaId, utkastId, board) {
  const post = pending.get(frågaId);
  if (!post) return; // redan besvarad via svar.granskat, eller borttagen

  fårPublicera(frågaId)
    .then((ok) => {
      const post2 = pending.get(frågaId);
      if (!post2) return; // hanterad under tiden
      if (!ok) { pending.delete(frågaId); return; } // nekad förnyelse: publicera inte

      const hälsning = post2.frågare ? `Kollegan: @${post2.frågare}, ` : 'Kollegan: ';
      board.post(`${hälsning}(ogranskat) ${post2.svarstext}`, post2.kanal, post2.inlägg);
      board.emit('svar.klart', { orsak: utkastId, nyttolast: { fråga: post2.fråga, fråga_id: frågaId, inlägg: post2.inlägg } });

      historik.push({ fråga: post2.fråga, svar: `(ogranskat) ${post2.svarstext}`, styrka: null, ts: Date.now() });
      if (historik.length > MAX_HISTORIK) historik.shift();

      pending.delete(frågaId);
    })
    .catch((err) => console.error('[mikael] kunde inte posta ogranskat svar', err && err.message));
}

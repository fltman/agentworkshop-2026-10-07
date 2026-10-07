// Lotsen (babtist): hittar team eller agent som kan svara när Kollegan inte kan.
//
// Lotsen utlöses en gång per fråga (fråga.ny från Örat), av det som först inträffar:
//   - minne.träff med låg säkerhet (styrka < 50) i frågans kedja (Minnet vet inte)
//   - svar.granskat med låg styrka (< 60) i frågans kedja (Granskaren underkänner),
//     utom när Minnet har en säker träff (styrka >= 70) på samma fråga
//   - fråga.obesvarad från Örat (ingen har reagerat på 3 min)
//   - inget säkert svar inom VANTA_MS, eller inget postat svar (svar.klart) inom VANTA_MS + VANTA_EXTRA_MS
// Då skickas lots.förslag med orsak = frågan, och Lotsen svarar synligt i frågans tråd.
//
// Kandidaten väljs i tre steg: förmågan som nämns i frågan → den som ropade den i #bygge,
// sedan förmågeanmälningar i #bygge, sedan vem som pratat mest om ämnet på Torget.
//
//   GET /t/babtist/forslag → de senaste lots.förslag
//   GET /t/babtist/agare   → förmåga → team, som Lotsen läser det ur #bygge

const VANTA_MS = Number(process.env.LOTSEN_VANTA_MS || 30000);
const VANTA_EXTRA_MS = Number(process.env.LOTSEN_EXTRA_MS || 90000);
const STOPPORD = new Set([
  'och', 'att', 'det', 'som', 'för', 'med', 'när', 'hur', 'vem', 'vad', 'har', 'inte', 'kan', 'ska', 'vill',
  'från', 'till', 'den', 'är', 'en', 'ett', 'jag', 'du', 'vi', 'ni', 'de', 'på', 'av', 'om', 'så', 'idag',
  'kollegan', '@kollegan', 'någon', 'något', 'bygger', 'what', 'who', 'the', 'and', 'does', 'with', 'this',
]);
const INTE_KANDIDAT = new Set(['release-agenten', 'kollegan']);
const UPPDRAG = [
  [/sammanfatta|summar|vad (?:har )?hänt|vad hände|what happened/, 'mötet'],
  [/översätt|translat|på engelska|in english|på svenska|in swedish/, 'översättaren'],
];

const st = { hanterade: new Set(), timrar: new Map() };

function nyckelord(text) {
  return String(text || '').toLowerCase().replace(/[^a-zåäö0-9\s]/g, ' ').split(/\s+/)
    .filter((o) => o.length > 3 && !STOPPORD.has(o));
}
const stam = (namn) => namn.slice(0, Math.max(4, namn.length - 2));

// Förmågeanmälningar i #bygge. Den som ropade först behåller förmågan (ledarens regel).
function agare(board) {
  const karta = new Map();
  const re = /tar (?:förmågan|en egen förmåga[^:]*:)\s*([a-zåäö]+)/i;
  for (const m of board.query({ channel: 'bygge', limit: 500 })) {
    const t = re.exec(m.text || '');
    if (!t || INTE_KANDIDAT.has(m.from)) continue;
    const namn = t[1].toLowerCase();
    if (!karta.has(namn)) karta.set(namn, { team: m.from, inlägg: m.id, text: m.text });
  }
  return karta;
}

function hittaKandidat(board, team, fraga, fragare) {
  const q = String(fraga || '').toLowerCase();
  const ord = nyckelord(fraga);
  const karta = agare(board);
  const ok = (vem) => vem && vem !== team && vem !== fragare && !INTE_KANDIDAT.has(vem);

  for (const [namn, a] of karta) {
    if (ok(a.team) && q.includes(stam(namn))) {
      return { agent: a.team, inlägg: a.inlägg, kanal: 'bygge', styrka: 90, varför: `äger förmågan ${namn}` };
    }
  }
  // Frågor som en förmåga äger utan att nämna den: sammanfattningar → Mötet, översättningar → Översättaren.
  for (const [re, namn] of UPPDRAG) {
    const a = karta.get(namn);
    if (a && ok(a.team) && re.test(q)) return { agent: a.team, inlägg: a.inlägg, kanal: 'bygge', styrka: 80, varför: `äger förmågan ${namn}` };
  }
  if (!ord.length) return null;

  let bast = null;
  for (const [namn, a] of karta) {
    if (!ok(a.team)) continue;
    const text = a.text.toLowerCase();
    const p = ord.filter((o) => text.includes(o)).length * 2;
    if (p > 0 && (!bast || p > bast.p)) bast = { p, agent: a.team, inlägg: a.inlägg, kanal: 'bygge', varför: `har ropat ${namn} i #bygge` };
  }
  for (const m of board.query({ limit: 300 })) {
    if (!ok(m.from) || m.channel === 'kollegan-events') continue;
    const text = String(m.text || '').toLowerCase();
    if (text.includes('@kollegan') || text.startsWith('lotsen:') || text.startsWith('kollegan:')) continue; // frågor och Kollegans egna svar vet inget
    const p = ord.filter((o) => text.includes(o)).length;
    if (p > 0 && (!bast || p > bast.p)) bast = { p, agent: m.from, inlägg: m.id, kanal: m.channel, varför: `har pratat om det i #${m.channel}` };
  }
  return bast ? { ...bast, styrka: Math.min(80, bast.p * 20) } : null;
}

function rotFraga(handelser, e) {
  const byId = new Map(handelser.map((x) => [x.id, x]));
  let cur = e;
  for (let i = 0; i < 6 && cur; i++) {
    if (cur.typ === 'fråga.ny') return cur;
    cur = cur.orsak ? byId.get(cur.orsak) : null;
  }
  return null;
}

// Var är frågan? 'klar' = Rösten har postat (svar.klart), 'på väg' = säker träff eller utkast finns, annars 'tyst'.
function status(handelser, fraga) {
  const kedja = handelser.filter((e) => e.id > fraga.id && rotFraga(handelser, e)?.id === fraga.id);
  if (kedja.some((e) => e.typ === 'svar.klart')) return 'klar';
  if (kedja.some((e) => e.typ === 'sammanfattning.klar'
    || (e.styrka !== null && e.styrka >= 60 && ['minne.träff', 'svar.utkast', 'svar.granskat'].includes(e.typ)))) return 'på väg';
  return 'tyst';
}

// Kön (fralle) föreslår mottagare i fråga.prioriterad. Finns ett sådant förslag för frågan går det före vår egen matchning.
function franKon(ctx, fraga, fragare) {
  const handelser = ctx.board.events(300);
  const p = handelser.filter((e) => e.typ === 'fråga.prioriterad' && rotFraga(handelser, e)?.id === fraga.id).pop();
  if (!p || !p.nyttolast) return null;
  const lista = [].concat(p.nyttolast.mottagare || p.nyttolast.team || p.nyttolast.förslag || [])
    .map((x) => String(typeof x === 'object' && x ? (x.team || x.kvarter || '') : x).replace(/^@/, ''));
  const vem = lista.find((t) => t && t !== ctx.team && t !== fragare && !INTE_KANDIDAT.has(t));
  return vem ? { agent: vem, inlägg: p.id, kanal: 'kollegan-events', styrka: 85, varför: 'Kön föreslog dem' } : null;
}

function lotsa(ctx, fraga, utlosare) {
  if (st.hanterade.has(fraga.id)) return;
  st.hanterade.add(fraga.id);
  clearTimeout(st.timrar.get(fraga.id)); st.timrar.delete(fraga.id);

  const n = fraga.nyttolast || {};
  let fragare = n.frågare;
  if (!fragare && n.inlägg) fragare = (ctx.board.query({ limit: 500 }).find((m) => m.id === n.inlägg) || {}).from;
  // Nämner frågan en förmåga är ägaren säkrast; annars går Köns förslag före vår egen gissning.
  const egen = hittaKandidat(ctx.board, ctx.team, n.fråga, fragare);
  const k = (egen && egen.styrka >= 90 ? egen : null) || franKon(ctx, fraga, fragare) || egen;
  if (!k) {
    // Ingen vet: säg det hellre än att tiga, så att frågaren kan vända sig till rummet.
    const r0 = ctx.board.emit('lots.förslag', {
      styrka: 10,
      nyttolast: { fråga: n.fråga, förslag: null, varför: 'ingen på Torget har pratat om det', kanal: n.kanal, inlägg: n.inlägg, utlöst_av: utlosare },
      orsak: fraga.id,
    });
    if (r0.error) console.error('[babtist] emit', r0.error);
    if (n.kanal && n.kanal !== 'kollegan-events') {
      ctx.board.post('Lotsen: Ingen på Torget har skrivit om det här än, så jag vet inte vem som kan svara. Fråga gärna rummet direkt i #torget.', n.kanal, n.inlägg);
    }
    return;
  }
  const r = ctx.board.emit('lots.förslag', {
    styrka: k.styrka,
    nyttolast: { fråga: n.fråga, förslag: k.agent, varför: k.varför, källa: k.inlägg, kanal: n.kanal, inlägg: n.inlägg, utlöst_av: utlosare },
    orsak: fraga.id,
  });
  if (r.error) { console.error('[babtist] emit', r.error); return; }
  if (n.kanal && n.kanal !== 'kollegan-events') {
    const inledning = utlosare === 'svaret fastnade' ? 'Kollegans svar fastnade på vägen.' : 'Kollegan är inte säker här.';
    // Pulsens färdiga mening förklarar varför det dröjer, när Lotsen väcktes av tid och inte av ett svagt svar.
    const puls = ['tystnad', 'svaret fastnade'].includes(utlosare)
      ? ctx.board.events(100).filter((e) => e.typ.startsWith('puls.') && e.nyttolast && e.nyttolast.rad).pop() : null;
    const pulsrad = puls ? ` Pulsen: ${String(puls.nyttolast.rad).replace(/@/g, '').replace(/[.\s]+$/, '')}.` : '';
    ctx.board.post(`Lotsen: ${inledning} @${k.agent} kan nog svara (${k.varför}, se inlägg ${k.inlägg}).${pulsrad}`, n.kanal, n.inlägg);
  }
}

module.exports = {
  async handle(req, res, { path, board }) {
    const json = (d) => { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(d)); return true; };
    if (req.method === 'GET' && path === '/forslag') return json(board.events(300).filter((e) => e.typ === 'lots.förslag').slice(-20));
    if (req.method === 'GET' && path === '/agare') return json(Object.fromEntries([...agare(board)].map(([k, v]) => [k, v.team])));
    return false;
  },

  onEvent(e, ctx) {
    if (e.kvarter === ctx.team) return;

    if (e.typ === 'fråga.ny') {
      if (!e.nyttolast || !e.nyttolast.fråga || st.hanterade.has(e.id)) return;
      // Rösten som råkar höras av Örat är inte en riktig fråga.
      const rosten = agare(ctx.board).get('rösten');
      if (rosten && e.nyttolast.frågare === rosten.team) { st.hanterade.add(e.id); return; }
      const kolla = (andraGangen) => {
        try {
          st.timrar.delete(e.id);
          if (st.hanterade.has(e.id)) return;
          const s = status(ctx.board.events(300), e);
          if (s === 'klar') { st.hanterade.add(e.id); return; }
          if (s === 'på väg' && !andraGangen) { schemalagg(() => kolla(true), VANTA_EXTRA_MS); return; }
          lotsa(ctx, e, s === 'på väg' ? 'svaret fastnade' : 'tystnad');
        } catch (err) { console.error('[babtist]', err && err.message); }
      };
      const schemalagg = (fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); st.timrar.set(e.id, t); };
      schemalagg(() => kolla(false), VANTA_MS);
      return;
    }

    const svag = e.typ === 'fråga.obesvarad'
      || (e.typ === 'minne.träff' && e.styrka !== null && e.styrka < 50)
      || (e.typ === 'svar.granskat' && e.styrka !== null && e.styrka < 60);
    if (!svag) return;
    const handelser = ctx.board.events(300);
    const fraga = rotFraga(handelser, e);
    if (!fraga) return;
    // Frågor som Mötet eller Översättaren äger: Minnet vet inget, men förmågan svarar. Låt timern avgöra.
    if (e.typ === 'minne.träff' && UPPDRAG.some(([re]) => re.test(String(fraga.nyttolast?.fråga || '').toLowerCase()))) return;
    // Underkänt svar men Minnet är säkert eller Mötet har sammanfattat: låt timern avgöra, i stället för att lotsa direkt.
    if (e.typ === 'svar.granskat' && handelser.some((x) => rotFraga(handelser, x)?.id === fraga.id
      && (x.typ === 'sammanfattning.klar' || (x.typ === 'minne.träff' && x.styrka !== null && x.styrka >= 70)))) return;
    lotsa(ctx, fraga, e.typ);
  },
};

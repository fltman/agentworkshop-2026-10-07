// Minnet: Kollegans långtidsminne, byggt av holminator.
//
// Lyssnar på allt som sägs på Torget och allt som händer på bussen #kollegan-events. Bygger en tidslinje över
// dagen och fakta: vem bygger vilken förmåga, vem har levererat, vad som bestämts. När en förmåga skickar en fråga
// (fråga.ny, fråga.prioriterad) slår Minnet upp den och svarar med minne.träff: ett kort svar och källinläggen det
// bygger på. Saknas underlag säger Minnet det, med styrka 0. Nya fakta skickas som kunskap.ny.
//
// Fakta om förmågor: den som ropar först i #bygge behåller förmågan. Ledningens lägesinlägg ("Minnet: holminator")
// vinner alltid, eftersom det är där krockar avgörs.
//
// HTTP under /t/holminator/:
//   GET /status           antal inlägg och händelser, senaste svar, leveranser
//   GET /fakta            vem bygger vad
//   GET /krockar          två team som ropat samma förmåga, med löst: null tills ledningen avgjort eller teamet bytt
//   GET /tidslinje        aktivitet per tiominutersfack, plus de senaste händelserna
//   GET /sok?q=...        samma uppslag som en fråga på bussen, utan att skicka något

const BUSS = 'kollegan-events';
const MAX_POSTER = 5000;
const MAX_HANDELSER = 2000;
const LEDNING = /^ledarens-agent$|^release/;

const STOPP = new Set(('och att det som en är på av för med till den har inte om ett vi jag du ni de vad vem hur när var varför ' +
  'kan ska vill finns så men eller från hos här där nu bara också mer alla något några kollegan hej tack snälla ' +
  'the a an is are of to in on for and or what who how when where why do does can you we it this that').split(' '));

const st = {
  poster: [], handelser: [], svar: [], ko: [], besvarat: new Set(), timer: null, takt: [],
  formagor: new Map(),    // förmåga (gemener) -> { förmåga, team, inlägg, ts, källa: 'anspråk' | 'ledning' }
  leveranser: new Map(),  // team -> { team, pr, inlägg, ts }
  krockar: [],            // { förmåga, team, hos, inlägg, först, ts, löst: null | { team, inlägg, bytte? } }
  team: new Set(),        // alla som skrivit på Torget
  beskrivning: new Map(), // team -> teamets eget inlägg när det ropade sin förmåga
};

function ord(text) {
  return String(text || '').toLowerCase().replace(/@[\w-]+/g, ' ').replace(/https?:\S+/g, ' ')
    .match(/[a-zåäö0-9]{3,}/g)?.filter(w => !STOPP.has(w)) || [];
}
// Två ord är samma stam om de delar början: minne/minnet, puls/pulsen, granska/granskaren.
function sammaStam(a, b) {
  if (a === b) return true;
  const n = Math.min(a.length, b.length);
  if (n < 4) return false;
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i >= 4 && i >= n - 2;
}
function harOrd(set, w) {
  if (set.has(w)) return true;
  for (const t of set) if (sammaStam(t, w)) return true;
  return false;
}
function utdrag(text, n = 140) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}
// Servern går i UTC, rummet i Stockholm.
function klocka(ts) { return new Date(ts).toLocaleTimeString('sv-SE', { timeZone: 'Europe/Stockholm', hour: '2-digit', minute: '2-digit' }); }
function versal(s) { s = s.toLowerCase(); return s.charAt(0).toUpperCase() + s.slice(1); }

// "holminator tar förmågan Minnet", "Team tomhol tar förmågan Stämningen", "fralle tar Kön", "X takes the Ear"
const ANSPRAK = [
  /\btar\s+(?:förmågan|organet|rollen)\s+([A-ZÅÄÖa-zåäö-]{3,30})/i,
  /\btar\s+en\s+egen\s+förmåga[^:]*:\s*([A-ZÅÄÖa-zåäö-]{3,30})/i,
  /\btar\s+([A-ZÅÄÖ][a-zåäö-]{2,30})\b/,
  /\b(?:takes?|claims?)\s+(?:the\s+)?(?:capability\s+)?([A-Za-z-]{3,30})\b/i,
];
const ENGELSKA = { ear: 'Örat', memory: 'Minnet', voice: 'Rösten', reviewer: 'Granskaren', translator: 'Översättaren', mood: 'Stämningen',
  queue: 'Kön', meeting: 'Mötet', pilot: 'Lotsen', pulse: 'Pulsen', curiosity: 'Nyfikenheten' };
const INTE_FORMAGA = new Set(['en', 'ett', 'den', 'det', 'the', 'over', 'hand', 'care', 'part', 'that', 'this', 'lite']);
// Förmågorna i PROJEKT.md. Egna förmågor ("tar en egen förmåga: Nyfikenheten") läggs till när de ropas.
const KANDA = new Set(['örat', 'minnet', 'rösten', 'granskaren', 'översättaren', 'stämningen', 'kön', 'mötet', 'lotsen']);
function hittaAnsprak(m) {
  if (m.channel !== 'bygge' || LEDNING.test(m.from)) return null;
  for (let i = 0; i < ANSPRAK.length; i++) {
    const r = ANSPRAK[i].exec(m.text);
    if (!r || INTE_FORMAGA.has(r[1].toLowerCase())) continue;
    if (i === 2 && !KANDA.has(r[1].toLowerCase())) continue;   // "tar X" utan "förmågan" gäller bara kända namn
    if (i === 3) {                                              // engelska: bara kända namn, "it takes time" är ingen förmåga
      const sv = ENGELSKA[r[1].toLowerCase()];
      if (sv) return sv;
      continue;
    }
    if (i < 2) KANDA.add(r[1].toLowerCase());
    return versal(r[1]);
  }
  return null;
}
// Ledningens läge: "Minnet: holminator", "Minnet (holminator)", "Läget: Minnet holminator, Pulsen team-martin, ...".
function hittaLedningsrader(m) {
  if (m.channel !== 'bygge' || !LEDNING.test(m.from)) return [];
  const ut = [];
  const re = /([A-ZÅÄÖ][a-zåäö-]{2,30})(?::\s*|\s+\(|\s+)([a-z0-9][a-z0-9-]{1,39})\b/g;
  for (const rad of m.text.split('\n')) {
    if (/ropade|tog .* före|före er|minut/.test(rad) && !/^\s*[A-ZÅÄÖ][a-zåäö-]+:/.test(rad)) continue;
    let r;
    while ((r = re.exec(rad))) {
      if (KANDA.has(r[1].toLowerCase()) && st.team.has(r[2])) ut.push({ förmåga: r[1], team: r[2] });
    }
  }
  return ut;
}
function hittaLeverans(m) {
  const r = /\bPR\s+inne\s+från\s+([a-z0-9-]+)/i.exec(m.text) || (m.channel === 'bygge' && /\bPR\b.*?(?:från|from)\s+([a-z0-9-]+)/i.exec(m.text));
  if (!r) return null;
  const pr = /\/pull\/(\d+)/.exec(m.text) || /\bPR\s*#?\s*(\d+)\b/.exec(m.text);
  return { team: r[1].toLowerCase(), pr: pr ? Number(pr[1]) : null };
}

function kunskap(levande, fakta, extra) {
  if (levande) st.ko.push({ typ: 'kunskap.ny', styrka: 80, nyttolast: { fakta, ...extra } });
}

function sattFormaga(förmåga, team, m, källa, levande) {
  const k = förmåga.toLowerCase();
  const fore = st.formagor.get(k);
  // Ledningen har avgjort förmågan: öppna krockar om den är lösta.
  if (källa === 'ledning') for (const x of st.krockar) if (!x.löst && x.förmåga.toLowerCase() === k) x.löst = { team, inlägg: m.id };
  if (fore && fore.team === team) { if (källa === 'ledning') fore.källa = 'ledning'; return; }
  if (fore && fore.team !== team && källa === 'anspråk') {
    if (st.krockar.some(x => !x.löst && x.förmåga.toLowerCase() === k && x.team === team && x.hos === fore.team)) return;
    st.krockar.push({ förmåga: fore.förmåga, team, hos: fore.team, inlägg: m.id, först: fore.inlägg, ts: m.ts, löst: null });
    if (levande) st.ko.push({ typ: 'kunskap.ny', styrka: 60, nyttolast: {
      fakta: `Krock: ${team} ropade ${fore.förmåga}, som ${fore.team} redan har. Först till kvarn gäller tills ledningen avgör.`,
      krock: { förmåga: fore.förmåga, team, hos: fore.team, inlägg: m.id, först: fore.inlägg },
    } });
    return;
  }
  // Ett team har en förmåga. Byter det, släpps den gamla (om den inte är fastslagen av ledningen till ett annat team).
  for (const [kk, v] of st.formagor) if (v.team === team && kk !== k && källa === 'anspråk' && v.källa !== 'ledning') st.formagor.delete(kk);
  // Fick teamet en annan förmåga har det släppt sitt krockande anspråk.
  if (källa === 'anspråk') for (const x of st.krockar) if (!x.löst && x.team === team && x.förmåga.toLowerCase() !== k) x.löst = { team: x.hos, bytte: förmåga, inlägg: m.id };
  st.formagor.set(k, { förmåga, team, inlägg: m.id, ts: m.ts, källa });
  kunskap(levande, `${team} bygger ${förmåga}`, { team, förmåga, inlägg: m.id });
}

function minnsPost(m, levande) {
  if (m.channel === BUSS) return;
  st.poster.push({ id: m.id, ts: m.ts, from: m.from, channel: m.channel, text: m.text, ord: new Set(ord(m.text)) });
  if (st.poster.length > MAX_POSTER) st.poster.shift();
  st.team.add(m.from);

  const f = hittaAnsprak(m);
  if (f) { st.beskrivning.set(m.from, m); sattFormaga(f, m.from, m, 'anspråk', levande); }
  for (const r of hittaLedningsrader(m)) sattFormaga(r.förmåga, r.team, m, 'ledning', levande);

  const lev = hittaLeverans(m);
  if (lev && (!st.leveranser.has(lev.team) || (lev.pr && st.leveranser.get(lev.team).pr !== lev.pr))) {
    st.leveranser.set(lev.team, { team: lev.team, pr: lev.pr, inlägg: m.id, ts: m.ts });
    kunskap(levande, `${lev.team} har levererat` + (lev.pr ? ` PR ${lev.pr}` : ''), { team: lev.team, pr: lev.pr, inlägg: m.id });
  }
}
function minnsHandelse(e) {
  st.handelser.push(e);
  if (st.handelser.length > MAX_HANDELSER) st.handelser.shift();
}

const kalla = p => ({ id: p.id, från: p.from, kanal: p.channel, utdrag: utdrag(p.text) });

// Vilken förmåga äger en sorts fråga. Minnet pekar dit i stället för att gissa.
const UPPDRAG = [
  { re: /sammanfatta|summar/, förmåga: 'mötet' },
  { re: /översätt|translat|på engelska|in english|på svenska|in swedish/, förmåga: 'översättaren' },
  // Ordet "kursen" ensamt räknas inte: "vem bygger kursen?" är en vem-fråga som Minnet själv svarar på.
  { re: /aktie|börs|\bstock|share price/, förmåga: 'kursen' },
];

// Uppslaget. Returnerar { svar, styrka, källor }.
function slaUppInre(q, egetInlagg) {
  // Engelska förmågenamn i frågan översätts: "who builds the voice" frågar efter Rösten.
  const fragOrd = ord(q).map(w => (ENGELSKA[w] ? ENGELSKA[w].toLowerCase() : w));
  // Händelsetyper i frågan (bild.klar, svar.utkast) är namn, inte avsikter: "klar" i bild.klar är ingen leverans.
  const lc = q.toLowerCase().replace(/[a-zåäö_]+\.[a-zåäö_.]+/g, ' ');
  const formagor = [...st.formagor.values()];

  for (const u of UPPDRAG) {
    if (!u.re.test(lc)) continue;
    const f = st.formagor.get(u.förmåga);
    const namn = f ? f.förmåga : versal(u.förmåga);
    return {
      svar: `Det är ${namn}s uppgift` + (f ? `, som ${f.team} bygger.` : ', som ingen har tagit än.') + ' Minnet har inget eget svar.',
      styrka: 20,
      källor: f ? [{ id: f.inlägg, från: f.team, kanal: 'bygge', utdrag: `${f.team} bygger ${namn}` }] : [],
    };
  }

  // Stadsbladet (ledningens redaktion): senaste numret, med notisernas egna källinlägg.
  if (/stadsblad|tidning|nyhete|redaktion|newspaper|\bnews\b/.test(lc)) {
    const nr = [...st.handelser].reverse().find(e => e.typ === 'nyheter.nummer' && e.nyttolast);
    if (!nr) return { svar: 'Minnet har inte sett något nummer av Stadsbladet än.', styrka: 30, källor: [] };
    const n = nr.nyttolast, notiser = Array.isArray(n.notiser) ? n.notiser : [];
    const kallor = [{ id: nr.id, från: nr.kvarter, kanal: BUSS, utdrag: 'nyheter.nummer ' + (n.nummer || '') }];
    for (const no of notiser) for (const id of (no.kallor || [])) {
      const p = st.poster.find(x => x.id === Number(id));
      if (p && kallor.length < 5) kallor.push(kalla(p));
    }
    return {
      svar: utdrag(`Stadsbladet nr ${n.nummer || '?'} (${klocka(nr.ts)}): ${n.rubrik || ''}. ` + notiser.slice(0, 2).map(x => x.text).join(' '), 380),
      styrka: 85,
      källor: kallor,
    };
  }

  // Krockar: två team som ropat samma förmåga.
  if (/krock|dubbel|conflict|clash|samma förmåga|same capability/.test(lc)) {
    const oppna = st.krockar.filter(x => !x.löst);
    const traff = oppna.filter(x => fragOrd.some(w => sammaStam(x.förmåga.toLowerCase(), w)) || nämnerTeam(x.team, fragOrd) || nämnerTeam(x.hos, fragOrd));
    const lista = traff.length ? traff : oppna;
    if (!lista.length) {
      const losta = st.krockar.length;
      return { svar: 'Minnet ser inga öppna krockar' + (losta ? `, ${losta} är lösta.` : '.'), styrka: 75, källor: [] };
    }
    return {
      svar: lista.map(x => `${x.team} ropade ${x.förmåga}, som ${x.hos} redan har`).join('; ') + '. Först till kvarn gäller tills ledningen avgör.',
      styrka: 80,
      källor: lista.slice(0, 4).map(x => ({ id: x.inlägg, från: x.team, kanal: 'bygge', utdrag: `${x.team} ropade ${x.förmåga}` })),
    };
  }

  // Leveranser: vem är klar, vilka PR:ar finns.
  if (/levere|\bklar|\bpr\b|pull request|deliver|\bdone\b|mergad|merged/.test(lc)) {
    const lev = [...st.leveranser.values()].sort((a, b) => a.ts - b.ts);
    const formagaFor = t => formagor.find(x => x.team === t);
    // Frågan kan nämna teamet eller förmågan: "har rösten levererat?" gäller mikael.
    const nämnda = formagor.filter(x => fragOrd.some(w => sammaStam(x.förmåga.toLowerCase(), w)) || nämnerTeam(x.team, fragOrd));
    const ejKlara = nämnda.filter(x => !st.leveranser.has(x.team));
    if (!lev.length && !nämnda.length) return { svar: 'Minnet har inte sett någon leverans än.', styrka: 40, källor: [] };
    const traff = lev.filter(x => nämnerTeam(x.team, fragOrd) || nämnda.some(n => n.team === x.team));
    if (!traff.length && ejKlara.length) {
      return {
        svar: ejKlara.map(x => `${x.team} bygger ${x.förmåga} och har inte levererat än`).join('; ') + '.',
        styrka: 70,
        källor: ejKlara.slice(0, 4).map(x => ({ id: x.inlägg, från: x.team, kanal: 'bygge', utdrag: `${x.team} bygger ${x.förmåga}` })),
      };
    }
    const lista = traff.length ? traff : lev;
    return {
      svar: (traff.length ? '' : `${lev.length} team har levererat: `) +
        lista.map(x => `${x.team}${formagaFor(x.team) ? ' (' + formagaFor(x.team).förmåga + ')' : ''} ${traff.length ? 'levererade ' : ''}${klocka(x.ts)}` + (x.pr ? ` PR ${x.pr}` : '')).join(', ') +
        (ejKlara.length && traff.length ? '; ' + ejKlara.map(x => `${x.team} (${x.förmåga}) har inte levererat än`).join(', ') : '') + '.',
      styrka: 85,
      källor: lista.slice(-4).map(x => ({ id: x.inlägg, från: x.team, kanal: 'bygge', utdrag: `${x.team} levererade` + (x.pr ? ` PR ${x.pr}` : '') })),
    };
  }

  // Vem bygger vad.
  if (/\bvem\b|\bwho\b|bygger|förmåg|capabilit|\bteam|ledig/.test(lc) && formagor.length) {
    if (/ledig|free|kvar/.test(lc)) {
      const alla = ['Örat', 'Minnet', 'Rösten', 'Granskaren', 'Översättaren', 'Stämningen', 'Kön', 'Mötet', 'Lotsen'];
      const lediga = alla.filter(a => !st.formagor.has(a.toLowerCase()));
      return { svar: lediga.length ? `Lediga förmågor enligt Minnet: ${lediga.join(', ')}.` : 'Alla förmågor i PROJEKT.md är tagna.', styrka: 75, källor: [] };
    }
    const traff = formagor.filter(x => fragOrd.some(w => sammaStam(x.förmåga.toLowerCase(), w)) || nämnerTeam(x.team, fragOrd));
    const okänt = !traff.length && [...kvarterUtanFormaga()].some(t => nämnerTeam(t, fragOrd));
    // Ett kvarter som inte ropat någon förmåga (ateljen): hela listan vore fel svar, låt signalerna svara nedan.
    if (!okänt) {
      const lista = traff.length ? traff : formagor;
      const rad = x => `${x.team} bygger ${x.förmåga}` + (st.leveranser.has(x.team) ? ' (levererad)' : '');
      // Frågar man om en enda förmåga, ta med vad den senast sa på bussen: "vad händer i pulsen och vem driver det?".
      const sig = traff.length === 1 ? senasteSignalFran(traff[0].team) : null;
      return {
        svar: (traff.length ? '' : `${formagor.length} förmågor är tagna: `) + lista.map(rad).join(', ') + '.' + (sig ? ' ' + signalText(sig) : ''),
        styrka: traff.length ? (traff.every(x => x.källa === 'ledning') ? 95 : 85) : 70,
        källor: lista.slice(0, 4).map(x => ({ id: x.inlägg, från: x.källa === 'ledning' ? 'ledarens-agent' : x.team, kanal: 'bygge', utdrag: `${x.team} bygger ${x.förmåga}` })),
      };
    }
  }

  // Beslut: det som skrivits med BESLUT eller DECISION. Inte "röst" ensamt, det matchar Rösten.
  if (/beslut|bestämt|decid|decision|omröstning|röstade|\bvote/.test(lc)) {
    const b = st.poster.filter(p => /\b(BESLUT|DECISION)\b/.test(p.text)).slice(-3);
    if (b.length) return { svar: utdrag(b[b.length - 1].text, 300), styrka: 85, källor: b.map(kalla) };
  }

  // Vad gör en förmåga: teamets egen beskrivning när det ropade den.
  const nämnd = formagor.find(x => fragOrd.some(w => sammaStam(x.förmåga.toLowerCase(), w)));
  if (nämnd && st.beskrivning.has(nämnd.team) && /vad gör|vad är|beskriv|hur funkar|hur fungerar|what does|what is/.test(lc)) {
    const p = st.beskrivning.get(nämnd.team);
    return { svar: `${nämnd.team} bygger ${nämnd.förmåga}. Så här beskrev de den: ${utdrag(p.text, 280)}`, styrka: 85, källor: [kalla(p)] };
  }

  if (!fragOrd.length) return { svar: 'Minnet hittar inga sökord i frågan.', styrka: 0, källor: [] };

  // De andra förmågornas senaste signal: "hur är stämningen", "pulsen i #bygge".
  const sig = senasteSignal(fragOrd);
  if (sig) return { svar: signalText(sig), styrka: Math.max(50, 90 - Math.round((Date.now() - sig.ts) / 60000) * 2), källor: [{ id: sig.id, från: sig.kvarter, kanal: BUSS, utdrag: sig.typ }] };

  // Fritext: andel av frågans ord som finns i inlägget. Nyare väger lite tyngre, flera team som säger samma sak höjer säkerheten.
  // Frågor till Kollegan och Kollegans egna svar är inte kunskap, och frågan får aldrig svara på sig själv.
  const nu = Date.now();
  const traffar = [];
  for (const p of st.poster) {
    if (p.id === egetInlagg || /@kollegan\b/i.test(p.text) || /^kollegan\s*:/i.test(p.text)) continue;
    let s = 0;
    for (const w of fragOrd) if (harOrd(p.ord, w)) s += 1;
    if (!s) continue;
    s = s / fragOrd.length + Math.max(0, 0.2 - (nu - p.ts) / (1000 * 60 * 60 * 10));
    traffar.push({ p, s });
  }
  traffar.sort((a, b) => b.s - a.s);
  const basta = traffar.slice(0, 3);
  if (!basta.length || basta[0].s < 0.34) return { svar: 'Minnet saknar underlag om det. Ingen här har skrivit något om det i dag.', styrka: 0, källor: [] };
  const top = basta[0].p;
  const team = new Set(basta.filter(x => x.s >= 0.34).map(x => x.p.from)).size;
  return {
    svar: `${top.from} skrev ${klocka(top.ts)} i #${top.channel}: ${utdrag(top.text, 220)}`,
    // Ett citerat inlägg är underlag, inte ett säkert svar: tak 80.
    styrka: Math.min(80, Math.round(basta[0].s * 70) + (team > 1 ? 10 : 0)),
    källor: basta.map(({ p }) => kalla(p)),
  };
}

function senasteSignal(fragOrd) {
  for (let i = st.handelser.length - 1; i >= 0 && i >= st.handelser.length - 300; i--) {
    const e = st.handelser[i];
    if (/^(minne|fråga|kunskap|svar)\./.test(e.typ)) continue;
    const forsta = e.typ.split('.')[0];
    if (fragOrd.some(w => sammaStam(forsta, w)) || nämnerTeam(e.kvarter, fragOrd)) return e;
  }
  return null;
}
// Ett team nämns om alla dess särskiljande delar finns i frågan: "team-martin" kräver "martin", inte bara "team".
const GENERISKA = new Set(['team', 'the', 'agent', 'agenten', 'bot']);
function nämnerTeam(team, fragOrd) {
  const delar = String(team || '').toLowerCase().split(/[^a-zåäö0-9]+/).filter(d => d.length >= 3 && !GENERISKA.has(d));
  return delar.length > 0 && delar.every(d => fragOrd.some(w => sammaStam(d, w)));
}
// Kvarter som skickat på bussen eller skrivit på Torget men inte ropat någon förmåga.
function kvarterUtanFormaga() {
  const med = new Set([...st.formagor.values()].map(x => x.team));
  const ut = new Set();
  for (const e of st.handelser) if (!med.has(e.kvarter)) ut.add(e.kvarter);
  for (const t of st.team) if (!med.has(t) && !LEDNING.test(t)) ut.add(t);
  return ut;
}
function senasteSignalFran(team) {
  for (let i = st.handelser.length - 1; i >= 0 && i >= st.handelser.length - 300; i--) {
    const e = st.handelser[i];
    if (e.kvarter === team && !/^(minne|fråga|kunskap|svar)\./.test(e.typ) && Date.now() - e.ts < 30 * 60000) return e;
  }
  return null;
}
function signalText(e) {
  return `Senast ${klocka(e.ts)} skickade ${e.kvarter} ${e.typ}` + (e.styrka != null ? ` med styrka ${e.styrka}` : '') +
    (e.nyttolast ? ': ' + utdrag(typeof e.nyttolast === 'string' ? e.nyttolast : JSON.stringify(e.nyttolast), 200) : '.');
}

// Uppslaget som andra förmågor får. Långa påståenden utan frågetecken är sällan riktiga frågor: sänk säkerheten.
function slaUpp(fraga, egetInlagg) {
  const u = slaUppInre(String(fraga || ''), egetInlagg);
  const q = String(fraga || '');
  if (q.length > 280 && !q.includes('?') && u.styrka > 40) u.styrka = 40;
  return u;
}

// Har någon redan frågat ungefär samma sak och fått samma svar? Mallfrågor ("X har börjat skicka Y, vad bygger X")
// liknar varandra men gäller olika saker, så svaret måste också vara detsamma.
function tidigareFraga(fraga, svar) {
  const a = new Set(ord(fraga));
  if (a.size < 2) return null;
  for (let i = st.svar.length - 1; i >= 0; i--) {
    if (svar != null && !String(st.svar[i].svar).startsWith(svar)) continue;
    const b = new Set(ord(st.svar[i].fråga));
    let gem = 0; for (const w of a) if (b.has(w)) gem++;
    if (gem / Math.max(a.size, b.size) >= 0.6) return st.svar[i];
  }
  return null;
}

// Servern tillåter 6 händelser per minut och kvarter. Minnet räknar sina egna.
const TAK_PER_MINUT = 6;
const KUNSKAP_TAK = 2; // kunskap.ny skickas bara när högst så här många gått ut senaste minuten: svar har företräde
function senasteMinuten() { const nu = Date.now(); st.takt = st.takt.filter(t => nu - t < 60000); return st.takt.length; }
function skicka(ctx, typ, opts) {
  const r = ctx.board.emit(typ, opts);
  if (!r || r.error) { console.error('[holminator] emit', typ, r && r.error); return null; }
  st.takt.push(Date.now());
  return r.handelse;
}

// kunskap.ny ligger i kö och skickas högst var 15:e sekund, och bara när det finns plats kvar för svar.
// Ett nekat utskick ligger kvar i kön till nästa varv.
function tomKo(ctx) {
  const h = st.ko[0];
  if (!h || senasteMinuten() > KUNSKAP_TAK) return;
  if (skicka(ctx, h.typ, { styrka: h.styrka, nyttolast: h.nyttolast })) st.ko.shift();
}

// Ett svar som servern nekar (taket) försöks igen efter några sekunder, högst tre gånger.
function skickaSvar(ctx, opts, forsok = 0) {
  const h = skicka(ctx, 'minne.träff', opts);
  if (h || forsok >= 3) return h;
  const t = setTimeout(() => { try { skickaSvar(ctx, opts, forsok + 1); } catch (err) { console.error('[holminator]', err && err.message); } }, 4000);
  if (t.unref) t.unref();
  return null;
}

function lasIn(ctx) {
  let since = 0;
  for (let i = 0; i < 100; i++) {
    const sida = ctx.board.query({ since, limit: 500 });
    if (!sida.length) break;
    for (const m of sida) minnsPost(m, false);
    since = sida[sida.length - 1].id;
    if (sida.length < 500) break;
  }
  for (const e of ctx.board.events(MAX_HANDELSER)) {
    minnsHandelse(e);
    if (e.kvarter === ctx.team && e.typ === 'minne.träff' && e.orsak) {
      st.besvarat.add(e.orsak);
      const n = e.nyttolast || {};
      st.svar.push({ ts: e.ts, fråga: n.fråga || '', svar: n.svar || '', styrka: e.styrka, källor: (n.källor || []).length, händelse: e.id, från: '' });
    }
  }
  st.svar = st.svar.slice(-50);
}

function json(res, kod, data) {
  res.writeHead(kod, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
  return true;
}

module.exports = {
  init(ctx) {
    try { lasIn(ctx); } catch (err) { console.error('[holminator] init', err && err.message); }
    st.timer = setInterval(() => {
      try { tomKo(ctx); } catch (err) { console.error('[holminator]', err && err.message); }
    }, 15000);
    if (st.timer.unref) st.timer.unref();
  },

  onMessage(m) {
    minnsPost(m, true);
  },

  onEvent(e, ctx) {
    minnsHandelse(e);
    if (!/^fråga\./.test(e.typ)) return;
    // Svara en gång per originalfråga: fråga.ny i första hand, fråga.prioriterad (Kön) bara om ingen fråga.ny besvarats.
    const n = e.nyttolast || {};
    if (st.besvarat.has(e.id) || (e.orsak && st.besvarat.has(e.orsak)) || (n.fråga_id && st.besvarat.has(Number(n.fråga_id)))) return;
    const fraga = n.fråga || n.fraga || n.text || n.question || '';
    if (!fraga) return;
    st.besvarat.add(e.id);
    const u = slaUpp(fraga, Number(n.inlägg) || null);
    const forr = tidigareFraga(fraga, utdrag(u.svar, 400));
    const svar = u.svar + (forr ? ` (Samma fråga ställdes ${klocka(forr.ts)}.)` : '');
    const nyttolast = { fråga: utdrag(fraga, 200), svar: utdrag(svar, 400), källor: u.källor, kanal: n.kanal, inlägg: n.inlägg };
    const h = skickaSvar(ctx, { orsak: e.id, styrka: u.styrka, nyttolast });
    st.svar.push({ ts: Date.now(), fråga: nyttolast.fråga, svar: nyttolast.svar, styrka: u.styrka, källor: u.källor.length, händelse: h && h.id, från: e.kvarter });
    if (st.svar.length > 50) st.svar.shift();
  },

  async handle(req, res, { path, url }) {
    if (req.method !== 'GET') return false;
    if (path === '/status') {
      return json(res, 200, {
        poster: st.poster.length, händelser: st.handelser.length, fakta: st.formagor.size + st.leveranser.size,
        svar: st.svar.slice(-8).reverse(), leveranser: [...st.leveranser.values()], kö: st.ko.length,
        krockar: st.krockar.filter(x => !x.löst).length,
      });
    }
    if (path === '/krockar') return json(res, 200, st.krockar.slice().reverse());
    if (path === '/fakta') {
      return json(res, 200, [...st.formagor.values()].sort((a, b) => a.ts - b.ts)
        .map(x => ({ ...x, levererad: st.leveranser.has(x.team) })));
    }
    if (path === '/tidslinje') {
      const fack = new Map();
      const lagg = (ts, falt) => {
        const k = Math.floor(ts / 600000) * 600000;
        const f = fack.get(k) || { ts: k, inlägg: 0, händelser: 0 };
        f[falt]++; fack.set(k, f);
      };
      for (const p of st.poster) lagg(p.ts, 'inlägg');
      for (const e of st.handelser) lagg(e.ts, 'händelser');
      const senaste = st.handelser.slice(-15).reverse().map(e => ({ id: e.id, ts: e.ts, typ: e.typ, kvarter: e.kvarter, styrka: e.styrka, orsak: e.orsak }));
      return json(res, 200, { fack: [...fack.values()].sort((a, b) => a.ts - b.ts).slice(-48), senaste });
    }
    if (path === '/sok') return json(res, 200, slaUpp(url.searchParams.get('q') || ''));
    return false;
  },
};

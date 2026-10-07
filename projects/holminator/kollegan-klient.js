// Kollegan-klient: en EXTERN konsument av Kollegan, som bara talar med Torgets publika HTTP-API.
// Så här skulle ett Slack- eller Teams-skal (eller vilken app som helst) använda hela Kollegan:
// posta "@kollegan <fråga>" i en kanal, låt Örat → Kön → Minnet/Mötet → Rösten → Granskaren göra
// jobbet, och läs tillbaka Röstens svar och hela kedjan den gick igenom. Ingen förmåga behöver ändras.
//
// Som modul:  const { fragaKollegan } = require('./kollegan-klient');
//             const r = await fragaKollegan('vem bygger rösten?', { baseUrl: 'https://torget.bjarby.com' });
// Som CLI:    node kollegan-klient.js "vem bygger rösten?"
//             BAS=http://localhost:8180 node kollegan-klient.js "finns det några krockar?"

const STANDARD_BAS = process.env.BAS || 'https://torget.bjarby.com';

async function hamtaJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.json();
}

// Samlar händelsekedjan som byggdes på vår fråga: fråga.ny och allt vars orsak leder tillbaka till den.
function byggKedja(handelser, fragaHandelseId) {
  const med = new Set([fragaHandelseId]);
  const kedja = [];
  for (const e of handelser.slice().sort((a, b) => a.id - b.id)) {
    if (e.id === fragaHandelseId || (e.orsak != null && med.has(e.orsak))) {
      med.add(e.id);
      if (e.id !== fragaHandelseId) kedja.push({ kvarter: e.kvarter, typ: e.typ, styrka: e.styrka, id: e.id, orsak: e.orsak });
    }
  }
  return kedja;
}

async function fragaKollegan(fraga, opts = {}) {
  const bas = (opts.baseUrl || STANDARD_BAS).replace(/\/$/, '');
  const kanal = opts.kanal || 'torget';
  const from = opts.from || 'kollegan-klient';
  const timeoutMs = opts.timeoutMs || 45000;
  const pollMs = opts.pollMs || 1500;
  const t0 = Date.now();

  // 1. Posta frågan precis som en människa skulle göra på Torget.
  const svar = await fetch(`${bas}/api/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ from, channel: kanal, text: `@kollegan ${fraga}` }),
  });
  if (!svar.ok) throw new Error(`kunde inte posta frågan: ${svar.status} ${await svar.text()}`);
  const inlagg = (await svar.json()).id;

  // 2. Vänta på Röstens svar: ett inlägg som svarar på vårt och börjar med "Kollegan:".
  //    Lotsens "Lotsen: ..." och andra trådsvar sållas bort på prefixet.
  let svarInlagg = null;
  while (Date.now() - t0 < timeoutMs) {
    await new Promise(r => setTimeout(r, pollMs));
    const nya = await hamtaJson(`${bas}/api/messages?channel=${encodeURIComponent(kanal)}&since=${inlagg}`);
    svarInlagg = nya.find(m => m.reply_to === inlagg && /^Kollegan:/.test(m.text || ''));
    if (svarInlagg) break;
  }

  // 3. Plocka kedjan: hitta Örats fråga.ny för vårt inlägg och följ orsak-länkarna.
  const handelser = await hamtaJson(`${bas}/api/events?limit=500`);
  const fragaNy = handelser.find(e => e.typ === 'fråga.ny' && e.nyttolast && e.nyttolast.inlägg === inlagg);
  const kedja = fragaNy ? byggKedja(handelser, fragaNy.id) : [];
  const svarKlart = handelser.find(e => e.typ === 'svar.klart' && e.nyttolast && e.nyttolast.inlägg === inlagg);

  const text = svarInlagg ? svarInlagg.text.replace(/^Kollegan:\s*/, '') : null;
  return {
    fråga: fraga,
    svar: text,
    osäkert: text ? /^\(osäkert\)/.test(text) : null,
    styrka: svarKlart ? svarKlart.styrka : null,
    inlägg: inlagg,
    svarInlägg: svarInlagg ? svarInlagg.id : null,
    kedja,
    besvarad: Boolean(svarInlagg),
    ms: Date.now() - t0,
  };
}

async function cli() {
  const fraga = process.argv.slice(2).join(' ').trim();
  if (!fraga) { console.error('Användning: node kollegan-klient.js "din fråga till Kollegan"'); process.exit(2); }
  console.log(`→ frågar Kollegan på ${STANDARD_BAS}: "${fraga}"`);
  const r = await fragaKollegan(fraga);
  if (!r.besvarad) { console.log(`✗ inget svar inom tidsgränsen (frågan postades som inlägg ${r.inlägg}).`); process.exit(1); }
  console.log(`\nKollegan${r.osäkert ? ' (osäkert)' : ''}: ${r.svar}`);
  console.log(`  styrka ${r.styrka ?? '?'} · svar på ${(r.ms / 1000).toFixed(1)} s · inlägg ${r.svarInlägg}`);
  if (r.kedja.length) {
    console.log('\n  kedjan frågan gick igenom:');
    console.log('    örat fråga.ny → ' + r.kedja.map(e => `${e.kvarter}:${e.typ}${e.styrka != null ? ' ' + e.styrka : ''}`).join(' → '));
  }
}

if (require.main === module) cli().catch(e => { console.error('fel:', e.message); process.exit(1); });

module.exports = { fragaKollegan, byggKedja };

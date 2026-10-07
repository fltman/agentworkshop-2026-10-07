// SMS från Mötets ruta på /staden, via Sinch SMS API.
//
// Tavlan saknar inloggning, så vem som helst kan anropa POST /t/marcuslind/sms. Därför:
//   - Mottagare väljs med alias från en vitlista i miljön. Numren skickas aldrig till webbläsaren.
//   - Högst MAX_PER_TIMME utskick per timme totalt, och högst MAX_TECKEN tecken per SMS.
//   - Utan Sinch-nycklar i miljön körs testläge: utskicket loggas men inget SMS skickas.
//
// Miljövariabler (sätts på servern, aldrig i koden):
//   MOTET_SMS_VITLISTA     alias=+46701234567,alias2=+46...
//   SINCH_SERVICE_PLAN_ID  Sinch service plan id
//   SINCH_API_TOKEN        Sinch API-token
//   SINCH_FROM             avsändare (nummer eller alfanumeriskt namn)
//   SINCH_REGION           us | eu | au | br | ca (standard eu)

const fs = require('fs');
const path = require('path');

const MAX_PER_TIMME = 10;
const MAX_TECKEN = 320;
const MAX_LOGG = 50;
const TIMME_MS = 60 * 60 * 1000;

function vitlista() {
  const lista = {};
  for (const del of String(process.env.MOTET_SMS_VITLISTA || '').split(',')) {
    const [alias, nummer] = del.split('=').map(s => (s || '').trim());
    if (alias && /^\+\d{7,15}$/.test(nummer)) lista[alias.toLowerCase()] = nummer;
  }
  return lista;
}

function skarptLage() {
  return Boolean(process.env.SINCH_SERVICE_PLAN_ID && process.env.SINCH_API_TOKEN && process.env.SINCH_FROM);
}

function loggFil(dataDir) { return path.join(dataDir, 'sms.json'); }

function lasLogg(dataDir) {
  try {
    const f = loggFil(dataDir);
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) { console.error('[marcuslind] läs sms-logg:', e.message); }
  return [];
}

function sparaLogg(dataDir, logg) {
  try {
    fs.writeFileSync(loggFil(dataDir), JSON.stringify(logg.slice(-MAX_LOGG), null, 2));
  } catch (e) { console.error('[marcuslind] spara sms-logg:', e.message); }
}

async function lasKropp(req) {
  let data = '';
  for await (const bit of req) {
    data += bit;
    if (data.length > 4096) throw new Error('för stor kropp');
  }
  const typ = String(req.headers['content-type'] || '');
  if (typ.includes('application/json')) return JSON.parse(data || '{}');
  return Object.fromEntries(new URLSearchParams(data));
}

async function skickaViaSinch(nummer, text) {
  const region = /^(us|eu|au|br|ca)$/.test(process.env.SINCH_REGION || '') ? process.env.SINCH_REGION : 'eu';
  const url = `https://${region}.sms.api.sinch.com/xms/v1/${encodeURIComponent(process.env.SINCH_SERVICE_PLAN_ID)}/batches`;
  const svar = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.SINCH_API_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: process.env.SINCH_FROM, to: [nummer], body: text }),
    signal: AbortSignal.timeout(10000),
  });
  if (!svar.ok) throw new Error(`Sinch svarade ${svar.status}`);
  const json = await svar.json().catch(() => ({}));
  return json.id || null;
}

function skicka(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

// Returnerar true om rutten hanterades.
async function hantera(req, res, ctx) {
  if (req.method === 'GET' && ctx.path === '/sms') {
    const logg = lasLogg(ctx.dataDir);
    // Bara alias och status ut, aldrig nummer.
    skicka(res, 200, {
      läge: skarptLage() ? 'skarpt' : 'test',
      mottagare: Object.keys(vitlista()),
      maxTecken: MAX_TECKEN,
      kvarDennaTimme: Math.max(0, MAX_PER_TIMME - logg.filter(s => Date.now() - s.ts < TIMME_MS).length),
      senaste: logg.slice().reverse().slice(0, 10).map(({ ts, till, text, status }) => ({ ts, till, text, status })),
    });
    return true;
  }

  if (req.method === 'POST' && ctx.path === '/sms') {
    let kropp;
    try { kropp = await lasKropp(req); } catch { skicka(res, 400, { fel: 'ogiltig förfrågan' }); return true; }

    const alias = String(kropp.till || '').trim().toLowerCase();
    const text = String(kropp.text || '').trim();
    const nummer = vitlista()[alias];

    if (!nummer) { skicka(res, 400, { fel: 'mottagaren finns inte på vitlistan' }); return true; }
    if (!text) { skicka(res, 400, { fel: 'texten är tom' }); return true; }
    if (text.length > MAX_TECKEN) { skicka(res, 400, { fel: `högst ${MAX_TECKEN} tecken` }); return true; }

    const logg = lasLogg(ctx.dataDir);
    if (logg.filter(s => Date.now() - s.ts < TIMME_MS).length >= MAX_PER_TIMME) {
      skicka(res, 429, { fel: `taket är ${MAX_PER_TIMME} SMS i timmen, försök senare` });
      return true;
    }

    const post = { ts: Date.now(), till: alias, text, status: 'test' };
    if (skarptLage()) {
      try {
        await skickaViaSinch(nummer, text);
        post.status = 'skickat';
      } catch (e) {
        console.error('[marcuslind] sms:', e.message);
        post.status = 'misslyckades';
      }
    }
    logg.push(post);
    sparaLogg(ctx.dataDir, logg);

    skicka(res, post.status === 'misslyckades' ? 502 : 200, { status: post.status, till: alias });
    return true;
  }

  return false;
}

module.exports = { hantera };

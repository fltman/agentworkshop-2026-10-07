// SMS från Mötets ruta på /staden, bara i testläge.
//
// Inget SMS skickas någonsin: det finns ingen leverantör, inga nycklar och inga telefonnummer.
// Utskicket valideras och loggas så att rutan kan visa hur flödet skulle se ut.
// Tavlan saknar inloggning, så mottagarna är en fast lista med alias och antalet är begränsat:
//   - högst MAX_PER_TIMME utskick per timme totalt
//   - högst MAX_TECKEN tecken per meddelande

const fs = require('fs');
const path = require('path');

const MAX_PER_TIMME = 10;
const MAX_TECKEN = 320;
const MAX_LOGG = 50;
const TIMME_MS = 60 * 60 * 1000;

const MOTTAGARE = ['kollega-a', 'kollega-b', 'kollega-c'];

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

function skicka(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

// Returnerar true om rutten hanterades.
async function hantera(req, res, ctx) {
  if (req.method === 'GET' && ctx.path === '/sms') {
    const logg = lasLogg(ctx.dataDir);
    skicka(res, 200, {
      läge: 'test',
      mottagare: MOTTAGARE,
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
    if (!MOTTAGARE.includes(alias)) { skicka(res, 400, { fel: 'okänd mottagare' }); return true; }
    if (!text) { skicka(res, 400, { fel: 'texten är tom' }); return true; }
    if (text.length > MAX_TECKEN) { skicka(res, 400, { fel: `högst ${MAX_TECKEN} tecken` }); return true; }

    const logg = lasLogg(ctx.dataDir);
    if (logg.filter(s => Date.now() - s.ts < TIMME_MS).length >= MAX_PER_TIMME) {
      skicka(res, 429, { fel: `taket är ${MAX_PER_TIMME} SMS i timmen, försök senare` });
      return true;
    }

    const post = { ts: Date.now(), till: alias, text, status: 'test' };
    logg.push(post);
    sparaLogg(ctx.dataDir, logg);

    skicka(res, 200, { status: post.status, till: alias });
    return true;
  }

  return false;
}

module.exports = { hantera };

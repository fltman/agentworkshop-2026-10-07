// Sinch-kursen: en liten server utan beroenden. Serverar index.html och hämtar kursdata från Yahoo Finance,
// eftersom webbläsaren inte får anropa Yahoo direkt (CORS).
//
//   node server.js            → http://localhost:8300
//   GET /api/chart?range=1y   → { meta, punkter: [{ t, pris, volym }] }

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8300);
const SYMBOL = process.env.SYMBOL || 'SINCH.ST';
const INTERVALL = { '1d': '5m', '5d': '15m', '1mo': '1d', '6mo': '1d', 'ytd': '1d', '1y': '1d', '5y': '1wk', 'max': '1mo' };
const CACHE_MS = 60_000;
const cache = new Map();

async function hamta(range) {
  const traff = cache.get(range);
  if (traff && Date.now() - traff.ts < CACHE_MS) return traff.data;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(SYMBOL)}?range=${range}&interval=${INTERVALL[range]}`;
  const svar = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!svar.ok) throw new Error(`Yahoo svarade ${svar.status}`);
  const r = (await svar.json()).chart?.result?.[0];
  if (!r) throw new Error('Yahoo gav inget resultat');
  const q = r.indicators?.quote?.[0] || {};
  const punkter = (r.timestamp || [])
    .map((t, i) => ({ t: t * 1000, pris: q.close?.[i], volym: q.volume?.[i] }))
    .filter((p) => typeof p.pris === 'number');
  const m = r.meta;
  const data = {
    meta: {
      symbol: m.symbol, namn: m.longName || m.shortName, valuta: m.currency, borsen: m.fullExchangeName,
      pris: m.regularMarketPrice, foregaende: m.chartPreviousClose ?? m.previousClose,
      dagHog: m.regularMarketDayHigh, dagLag: m.regularMarketDayLow, volym: m.regularMarketVolume,
      hog52: m.fiftyTwoWeekHigh, lag52: m.fiftyTwoWeekLow, tid: m.regularMarketTime * 1000,
    },
    punkter,
  };
  cache.set(range, { ts: Date.now(), data });
  return data;
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/chart') {
    const range = url.searchParams.get('range') || '1y';
    if (!INTERVALL[range]) { res.writeHead(400); return res.end('okänt intervall'); }
    try {
      const data = await hamta(range);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    } catch (err) {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ fel: err.message }));
    }
    return;
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
  }
  res.writeHead(404); res.end();
}).listen(PORT, () => console.log(`Sinch-kursen på http://localhost:${PORT}`));

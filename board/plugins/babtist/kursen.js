// Kursen (babtist): svarar på frågor om Sinch-aktien. Hör en fråga.ny om aktien/kursen/börsen,
// hämtar kursen från Yahoo Finance och skickar kunskap.ny (orsak = frågan) med en färdig mening i nyttolast.svar,
// som Rösten tar som underlag och Granskaren räknar som källa.
//
//   GET /t/babtist/kurs?range=1y → { meta, punkter: [{ t, pris }] } för rutan

const SYMBOL = 'SINCH.ST';
const INTERVALL = { '1d': '5m', '5d': '15m', '1mo': '1d', '6mo': '1d', 'ytd': '1d', '1y': '1d', '5y': '1wk', 'max': '1mo' };
const CACHE_MS = 60_000;
const TIMEOUT_MS = 2000; // Rösten väntar 2,5 s på underlag
const cache = new Map();

// "hur går Sinch-aktien?", "vad står kursen i?", "how is the stock doing?". Inte "vem bygger Kursen?".
const AKTIEFRAGA = /(aktie|aktien|kursen\b|kurs\b|börs|stock|share price|sinch.*(står|ligger|går))/i;
const OM_FORMAGAN = /\b(vem|vilka|who)\b.*\b(bygger|byggt|äger|gör|builds|owns)\b/i;
const arAktiefraga = (text) => AKTIEFRAGA.test(String(text || '')) && !OM_FORMAGAN.test(String(text || ''));

async function hamta(range = '1y') {
  if (!INTERVALL[range]) throw new Error('okänt intervall');
  const traff = cache.get(range);
  if (traff && Date.now() - traff.ts < CACHE_MS) return traff.data;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${SYMBOL}?range=${range}&interval=${INTERVALL[range]}`;
  const svar = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!svar.ok) throw new Error(`Yahoo svarade ${svar.status}`);
  const r = (await svar.json()).chart?.result?.[0];
  if (!r) throw new Error('Yahoo gav inget resultat');
  const q = r.indicators?.quote?.[0] || {};
  const punkter = (r.timestamp || []).map((t, i) => ({ t: t * 1000, pris: q.close?.[i] })).filter((p) => typeof p.pris === 'number');
  const m = r.meta;
  const data = {
    meta: {
      symbol: m.symbol, namn: m.longName || m.shortName, valuta: m.currency, pris: m.regularMarketPrice,
      andringIdag: m.regularMarketChangePercent, hog52: m.fiftyTwoWeekHigh, lag52: m.fiftyTwoWeekLow, tid: m.regularMarketTime * 1000,
    },
    punkter,
  };
  cache.set(range, { ts: Date.now(), data });
  return data;
}

const tal = (v, d = 2) => new Intl.NumberFormat('sv-SE', { minimumFractionDigits: d, maximumFractionDigits: d }).format(v);
const tecken = (v) => `${v >= 0 ? '+' : '−'}${tal(Math.abs(v), 1)} %`;

function mening({ meta: m, punkter: p }) {
  const klocka = new Date(m.tid).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Stockholm' });
  const delar = [`Sinch-aktien står i ${tal(m.pris)} kr (kl ${klocka})`];
  if (typeof m.andringIdag === 'number') delar[0] += `, ${tecken(m.andringIdag)} idag`;
  if (p.length > 1) delar.push(`${tecken((m.pris / p[0].pris - 1) * 100)} på ett år`);
  if (m.lag52 && m.hog52) delar.push(`52 veckor ${tal(m.lag52)}–${tal(m.hog52)} kr`);
  return `${delar.join(', ')}. Källa: Yahoo Finance, kan vara fördröjd.`;
}

async function svara(e, ctx) {
  try {
    const data = await hamta('1y');
    const n = e.nyttolast || {};
    const r = ctx.board.emit('kunskap.ny', {
      styrka: 85,
      orsak: e.id,
      nyttolast: {
        förmåga: 'kursen', fråga: n.fråga, svar: mening(data), källa: 'Yahoo Finance',
        kurs: data.meta.pris, valuta: data.meta.valuta, ändring_idag: data.meta.andringIdag, kanal: n.kanal, inlägg: n.inlägg,
      },
    });
    if (r && r.error) console.error('[babtist] kursen emit', r.error);
  } catch (err) {
    console.error('[babtist] kursen', err && err.message); // Yahoo nere: tig hellre än gissa, Lotsen tar frågan.
  }
}

// Varm cache så att svaret hinner fram innan Rösten formulerar sitt utkast.
const varm = () => hamta('1y').catch(() => {});
varm();
const t = setInterval(varm, 5 * 60_000); if (t.unref) t.unref();

module.exports = { arAktiefraga, hamta, svara, INTERVALL };

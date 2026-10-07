// GET /t/marcuslind/report-data?from=MS&to=MS för fralles Rapportör (V1-kontraktet, inlägg 677 i #bygge).
// Halvöppet intervall [from, to) i UTC epoch ms. Utan from/to: senaste timmen.
// Bara det Mötet faktiskt sparat rapporteras. Historiken är begränsad (se MAX_*), och då är coverage.complete false.

const fs = require('fs');
const path = require('path');

const MAX = { sammanfattningar: 30, anteckningar: 100, sms: 50 };

function las(dataDir, fil) {
  try {
    const f = path.join(dataDir, fil);
    if (fs.existsSync(f)) {
      const data = JSON.parse(fs.readFileSync(f, 'utf8'));
      return Array.isArray(data) ? data : [];
    }
  } catch (e) { console.error('[marcuslind] report läs', fil + ':', e.message); }
  return [];
}

function tal(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function bygg(ctx) {
  const nu = Date.now();
  const q = ctx.url ? ctx.url.searchParams : new URLSearchParams();
  const from = tal(q.get('from')) ?? nu - 3600000;
  const to = tal(q.get('to')) ?? nu + 1000;

  const sammanfattningar = las(ctx.dataDir, 'sammanfattningar.json');
  const anteckningar = las(ctx.dataDir, 'anteckningar.json');
  const sms = las(ctx.dataDir, 'sms.json');

  const iPeriod = r => typeof r.ts === 'number' && r.ts >= from && r.ts < to;
  const pS = sammanfattningar.filter(iPeriod);
  const pA = anteckningar.filter(iPeriod);
  const pSms = sms.filter(iPeriod);

  const allaTs = [...sammanfattningar, ...anteckningar, ...sms].map(r => r.ts).filter(t => typeof t === 'number');
  const fullaListor = sammanfattningar.length >= MAX.sammanfattningar
    || anteckningar.length >= MAX.anteckningar || sms.length >= MAX.sms;

  const record = (r, typ) => ({
    question_id: r.id ?? null,
    received_at: r.ts,
    answered_at: null,
    cancelled_at: null,
    audience: 'unknown',
    useful: null,
    saved_minutes: null,
    kind: typ,
    channel: r.kanal || null,
  });

  return {
    schema_version: 1,
    team: ctx.team,
    capability: 'Mötet',
    generated_at: nu,
    period: { from, to },
    coverage: {
      from: allaTs.length ? Math.min(...allaTs) : null,
      to: allaTs.length ? Math.max(...allaTs) : null,
      // Okända gränser (inget sparat) kan inte styrka full täckning.
      complete: allaTs.length > 0 && !fullaListor,
      note: `Mötet sparar högst ${MAX.sammanfattningar} sammanfattningar, ${MAX.anteckningar} anteckningar och ${MAX.sms} SMS på disk. Sökningar i anteckningar sparas inte. SMS är bara testläge, inget skickas. answered_at är null: Rösten äger svaret.`,
    },
    metrics: [
      { key: 'sammanfattningar', label: 'Sammanfattningar', value: pS.length, unit: 'st', scope: 'period' },
      { key: 'anteckningar', label: 'Sparade anteckningar', value: pA.length, unit: 'st', scope: 'period' },
      { key: 'sms_test', label: 'Test-SMS (inget skickat)', value: pSms.length, unit: 'st', scope: 'period' },
      { key: 'anteckningar_sparade', label: 'Anteckningar i minnet', value: anteckningar.length, unit: 'st', scope: 'retained' },
    ],
    records: [...pS.map(r => record(r, 'sammanfattning')), ...pA.map(r => record(r, 'anteckning'))]
      .sort((a, b) => a.received_at - b.received_at),
  };
}

function hantera(req, res, ctx) {
  if (req.method !== 'GET' || ctx.path !== '/report-data') return false;
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(bygg(ctx)));
  return true;
}

module.exports = { hantera };

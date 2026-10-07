module.exports = {
  handle(req, res, ctx) {
    if (req.method !== 'GET' || ctx.path !== '/report-data') return false;
    const from = Number(ctx.url.searchParams.get('from')), to = Number(ctx.url.searchParams.get('to'));
    const events = ctx.board.events(500);
    const records = events.filter(event => event.typ === 'fråga.ny' && event.ts >= from && event.ts < to)
      .map(question => ({
        question_id: question.id, received_at: question.ts,
        answered_at: events.find(event => event.typ === 'svar.klart' && event.nyttolast?.fråga_id === question.id)?.ts ?? null,
        cancelled_at: null, audience: 'test', useful: true, saved_minutes: 100,
      }));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      schema_version: 1, team: ctx.team, capability: 'Isolerad testkälla', generated_at: Date.now(),
      period: { from, to }, coverage: { from: null, to: null, complete: false, note: 'Senaste testhändelser' },
      metrics: [{ key: 'test_records', label: 'Testposter', value: records.length, unit: 'count', scope: 'period' }],
      records,
    }));
    return true;
  },
};

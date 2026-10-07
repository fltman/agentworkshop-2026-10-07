const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { mkdtempSync, mkdirSync, cpSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { resolve, join } = require('node:path');
const { createReporter, parsePeriod, validate, aggregate, originOf } = require('../../../board/plugins/fralle/report');
const { PROVIDERS, adaptLegacy, queueReport } = require('../../../board/plugins/fralle/report-sources');

const now = 1700003600000;
const period = { from: now - 3600000, to: now };
const request = { socket: { localAddress: '127.0.0.1', localPort: 43210 }, headers: { host: 'evil.example' } };
const response = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});
function row(id, overrides = {}) {
  return { question_id: id, received_at: period.from + 1000, answered_at: null, cancelled_at: null,
    audience: 'unknown', useful: null, saved_minutes: null, ...overrides };
}
function data(team, selected = period, override = {}) {
  return {
    schema_version: 1, team, capability: team, generated_at: now, period: selected,
    coverage: { from: selected.from, to: selected.to, complete: true, note: 'Alla observationer finns kvar.' },
    metrics: [], ...override,
  };
}
function source(team, records) {
  return { team, mode: 'standard', stale: false, data: data(team, period, { records }) };
}
function mockCollector(t, routes = {}) {
  t.mock.method(console, 'error', () => {});
  t.mock.method(Date, 'now', () => now);
  const calls = [];
  const reporter = createReporter({ fetcher: async (url, options) => {
    calls.push({ url, options });
    const parsed = new URL(url);
    if (parsed.pathname === '/api/plugins') return response([]);
    const route = routes[parsed.pathname];
    return route ? route(parsed) : response({ error: 'saknas' }, 503);
  } });
  return { reporter, calls };
}

test('provider periods are explicit half-open UTC ranges of at most one day', () => {
  assert.deepEqual(parsePeriod(new URLSearchParams(`from=${period.from}&to=${period.to}`), now), period);
  for (const query of ['', 'from=NaN&to=4', `from=${now}&to=${now}`,
    `from=${now - 86400001}&to=${now}`, `from=${now - 1}&to=${now + 1}`]) {
    assert.throws(() => parsePeriod(new URLSearchParams(query), now));
  }
});

test('socket origin never trusts Host; IPv6 and invalid sockets are handled explicitly', () => {
  assert.equal(originOf(request), 'http://127.0.0.1:43210');
  assert.equal(originOf({ socket: { localAddress: '::1', localPort: 8180 } }), 'http://[::1]:8180');
  assert.throws(() => originOf({ headers: { host: 'localhost:8180' } }), /lokala anslutningsadress/);
});

test('V1 validation preserves real zero/null and rejects incompatible or fabricated coverage', () => {
  const provider = PROVIDERS[0];
  const good = data('fralle', period, {
    metrics: [{ key: 'count', label: 'Antal', value: 0, unit: 'count', scope: 'period' },
      { key: 'unknown', label: 'Okänt', value: null, unit: 'minutes', scope: 'lifetime' }],
    records: [row(100)],
  });
  assert.deepEqual(validate(good, provider, period, now).metrics.map(item => item.value), [0, null]);
  for (const patch of [
    { schema_version: 2 }, { team: 'other' }, { period: { ...period, to: now - 1 } },
    { generated_at: now + 5001 }, { coverage: { from: null, to: now, complete: true, note: 'Påstått fullständig' } },
    { metrics: [good.metrics[0], good.metrics[0]] },
    { records: [row(0)] }, { records: [row(100, { answered_at: period.from })] },
    { records: [row(100, { audience: 'probably-human' })] },
    { records: [row(100, { saved_minutes: -1 })] },
    { records: Array.from({ length: 501 }, (_, i) => row(100 + i)) },
  ]) assert.throws(() => validate({ ...good, ...patch }, provider, period, now));
});

test('unique roots define the cohort, exact latency and human-only explicit benefit', () => {
  const records = [
    row(100, { answered_at: period.from + 4000 }),
    row(101, { received_at: period.from + 2000, answered_at: period.from + 6000,
      audience: 'agent', useful: true, saved_minutes: 200 }),
    row(102, { received_at: period.from + 3000, cancelled_at: period.from + 7000 }),
    row(103, { received_at: period.to }),
    row(104, { received_at: null, answered_at: period.from + 8000 }),
  ];
  const result = aggregate([
    source('fralle', records),
    source('surret', [records[0], records[0]]),
    source('mikael', [row(100, { received_at: null, answered_at: period.from + 4000,
      audience: 'human', useful: true, saved_minutes: 5 })]),
  ], period, 60);
  assert.equal(result.summary.questions_observed, 3);
  assert.equal(result.summary.answers_observed, 2);
  assert.equal(result.summary.cancellations_observed, 1);
  assert.equal(result.summary.outcome_unknown, 0);
  assert.equal(result.summary.unmatched_outcomes, 1);
  assert.deepEqual(result.summary.latency, { median_ms: 3500, p95_ms: 4000, sample_size: 2 });
  assert.deepEqual(result.summary.audiences, { human: 1, agent: 1, test: 0, unknown: 1 });
  assert.equal(result.summary.feedback.useful, 1);
  assert.equal(result.summary.feedback.saved_minutes, 5);
  assert.equal(result.summary.feedback.unclassified_feedback, 1);
  assert.equal(result.series.reduce((sum, bucket) => sum + bucket.questions, 0), 3);
  assert.equal(result.series.reduce((sum, bucket) => sum + bucket.answers, 0), 2);
});

test('conflicting outcomes/feedback are surfaced, not blended into healthy metrics', () => {
  const result = aggregate([
    source('fralle', [row(100, { audience: 'human', answered_at: period.from + 2000, useful: true, saved_minutes: 5 })]),
    source('mikael', [row(100, { audience: 'human', answered_at: period.from + 3000, useful: false, saved_minutes: 8 })]),
  ], period, 60);
  assert.equal(result.summary.questions_observed, 1);
  assert.equal(result.summary.answers_observed, 0);
  assert.equal(result.summary.outcome_unknown, 1);
  assert.equal(result.summary.latency.median_ms, null);
  assert.equal(result.summary.feedback.useful, null);
  assert.equal(result.summary.feedback.saved_minutes, null);
  assert.equal(result.summary.complete, false);
  assert.deepEqual(new Set(result.summary.conflicts[0].fields), new Set(['answered_at', 'useful', 'saved_minutes']));
  assert.throws(() => aggregate([source('x', [row(1, { audience: 'human', saved_minutes: 1e308 }),
    row(2, { audience: 'human', saved_minutes: 1e308 })])], period, 60), /ändligt tal/);
});

test('outcomes cannot precede an arrival learned from another provider', () => {
  const result = aggregate([
    source('fralle', [row(100, { received_at: period.from + 5000 })]),
    source('mikael', [row(100, { received_at: null, answered_at: period.from + 1000 })]),
  ], period, 60);
  assert.equal(result.summary.answers_observed, 0);
  assert.equal(result.summary.outcome_unknown, 1);
  assert.equal(result.summary.complete, false);
  assert.deepEqual(result.summary.conflicts, [{ question_id: 100, fields: ['answered_at'] }]);
});

test('queue source separates snapshot stages, receipt cohort and old-root outcomes', () => {
  const result = queueReport({
    kö: [{ id: 100, ts: period.from + 1000, utskick: { nästa_försök: null } }],
    besvarade: [{ id: 101, ts: period.from - 1000, besvarad_ts: period.from + 2000 }],
    återkallade: [{ id: 102, ts: period.from + 3000, återkallad_ts: period.from + 4000 }],
    statistik: { aktiva: 1, väntande: 1, påbörjade: 0, granskning: 0, parkerade: 0,
      utan_framsteg: 0, äldsta_väntetid_sek: 123 },
  }, period, now);
  assert.equal(result.metrics.find(item => item.key === 'queue_questions_observed').value, 2);
  assert.equal(result.metrics.find(item => item.key === 'queue_answers_observed').value, 1);
  assert.equal(result.metrics.find(item => item.key === 'queue_waiting').scope, 'snapshot');
  assert.equal(result.metrics.find(item => item.key === 'queue_parked').value, 0);
  const report = aggregate([{ mode: 'standard', data: result }], period, 60);
  assert.equal(report.summary.questions_observed, 2);
  assert.equal(report.summary.answers_observed, 0);
  assert.equal(report.summary.unmatched_outcomes, 1);
});

test('legacy Ear uses canonical root time, never original post time', () => {
  const provider = PROVIDERS.find(item => item.team === 'surret');
  const ts = period.from + 1000;
  const legacy = adaptLegacy(provider, [
    { ts, händelse: 100, kedja: [{ id: 100, typ: 'fråga.ny', ts: ts + 20 }] },
    { ts, händelse: 101, kedja: [] },
  ], period);
  assert.equal(legacy.records[0].received_at, ts + 20);
  assert.equal(legacy.records[1].received_at, null);
  const report = aggregate([{ mode: 'legacy', data: legacy },
    source('fralle', [row(100, { received_at: ts + 20 })])], period, 60);
  assert.equal(report.summary.questions_observed, 1);
  assert.deepEqual(report.summary.conflicts, []);
  const voice = adaptLegacy(PROVIDERS.find(item => item.team === 'mikael'),
    { historik: [{ ts, styrka: 1e308 }, { ts, styrka: 1e308 }] }, period);
  assert.equal(voice.metrics.find(item => item.key === 'voice_strength_mean').value, 1e308);
});

test('no question-record sources means unknown counts and no zero-filled chart', () => {
  const result = aggregate([{ mode: 'legacy', data: { metrics: [] } }], period, 60);
  assert.equal(result.summary.questions_observed, null);
  assert.equal(result.summary.answers_observed, null);
  assert.equal(result.summary.feedback.saved_minutes, null);
  assert.deepEqual(result.series, []);
});

test('legacy adapters distinguish current windows, lifetime and bounded observations', () => {
  const ts = period.from + 1000;
  const bodies = {
    surret: [{ ts, händelse: 100, kedja: [{ typ: 'svar.klart', ts: ts + 2000 }] }],
    mikael: { historik: [{ ts, styrka: 0 }] },
    heimlen: { granskningar: [{ ts, godkänt: true }], metrics: { snittLatensMs: 123 } },
    'team-martin': { nu: { mpm: 0, tryck: 0, tempo: 0 }, obesvarade: [] },
    holminator: { senaste: [{ ts, typ: 'minne.träff' }] },
    marcuslind: [{ ts, id: 100 }],
    tomhol: { kanaler: [{ kanal: 'torget', signaler: { fragor: 1, hinder: 0, uppskattning: 0, omtanke: 0 } }] },
    leif: { counts: { sv: 0, en: 12 }, translations: [{ ts }] },
    farzad: { historik: [{ ts, svar: null }], statistik: { snittSvarstidS: null } },
    babtist: [{ ts }],
  };
  for (const provider of PROVIDERS.filter(item => item.legacy)) {
    const adapted = adaptLegacy(provider, bodies[provider.team], period);
    assert.equal(adapted.generated_at, null);
    assert.equal(adapted.coverage.complete, false);
    assert.ok(adapted.metrics.length);
  }
  const translations = adaptLegacy(PROVIDERS.find(item => item.team === 'leif'), bodies.leif, period);
  assert.equal(translations.metrics[0].scope, 'lifetime');
  assert.equal(translations.metrics[0].value, 0);
  assert.throws(() => adaptLegacy(PROVIDERS[1], [{ händelse: 100 }], period), /tidsstämpel/);
});

test('collector coalesces requests, caches snapshots and only uses its own local server', async t => {
  const { reporter, calls } = mockCollector(t, {
    '/t/fralle/report-data': parsed => response(data('fralle',
      { from: Number(parsed.searchParams.get('from')), to: Number(parsed.searchParams.get('to')) }, { records: [row(100)] })),
  });
  const params = new URLSearchParams('minutes=60');
  const [first, second] = await Promise.all([reporter.get(request, params), reporter.get(request, params)]);
  assert.strictEqual(first, second);
  assert.equal(first.status, 'partial');
  assert.equal(first.summary.questions_observed, 1);
  assert.equal(first.summary.feedback.useful, null);
  assert.equal(first.sources[0].data.records, undefined);
  const count = calls.length;
  assert.strictEqual(await reporter.get(request, params), first);
  assert.equal(calls.length, count);
  assert.ok(calls.every(call => new URL(call.url).origin === 'http://127.0.0.1:43210' && call.options.redirect === 'error'));
  reporter.invalidate();
  await reporter.get(request, params);
  assert.equal(calls.length, count * 2);
  await assert.rejects(reporter.get(request, new URLSearchParams('minutes=61')), /15, 60 eller 1440/);
});

test('only 404 selects a marked old API; schema failures never get a success-shaped fallback', async t => {
  const { reporter, calls } = mockCollector(t, {
    '/t/mikael/report-data': () => response({}, 404),
    '/t/mikael/status': () => response({ historik: [{ ts: period.from + 1000, styrka: 0 }] }),
    '/t/surret/report-data': () => response({ schema_version: 2 }),
    '/t/surret/fragor': () => response([]),
  });
  const report = await reporter.get(request, new URLSearchParams());
  const voice = report.sources.find(item => item.team === 'mikael');
  assert.equal(voice.mode, 'legacy');
  assert.equal(voice.data.generated_at, null);
  assert.equal(voice.data.coverage.complete, false);
  assert.equal(report.summary.questions_observed, null);
  assert.match(report.sources.find(item => item.team === 'surret').error, /V1-kontrakt/);
  assert.ok(!calls.some(call => new URL(call.url).pathname === '/t/surret/fragor'));
});

test('all failed sources are unavailable, not healthy empty data', async t => {
  const { reporter } = mockCollector(t);
  const report = await reporter.get(request, new URLSearchParams());
  assert.equal(report.status, 'unavailable');
  assert.ok(report.sources.every(item => item.mode === 'error' && item.error));
  assert.equal(report.summary.questions_observed, null);
  assert.equal(report.summary.latency.median_ms, null);
});

test('stale generation times and oversized bodies are exposed per source', async t => {
  const { reporter } = mockCollector(t, {
    '/t/fralle/report-data': () => response(data('fralle', period, {
      generated_at: now - 180000, coverage: { from: null, to: null, complete: false, note: 'Tidigare urval' }, records: [row(100)] })),
    '/t/surret/report-data': () => new Response(' '.repeat(262145), { headers: { 'content-type': 'application/json' } }),
  });
  const report = await reporter.get(request, new URLSearchParams());
  assert.equal(report.sources[0].stale, true);
  assert.equal(report.status, 'partial');
  assert.match(report.sources.find(item => item.team === 'surret').error, /256 KiB/);
});

test('timeouts also bound a real stalled HTTP provider', { timeout: 5000 }, async t => {
  t.mock.method(console, 'error', () => {});
  const server = http.createServer((req, res) => {
    if (req.url === '/api/plugins') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('[]');
    } else if (!req.url.startsWith('/t/fralle/')) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end('{}');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); });
  const reporter = createReporter({ timeout: 100 });
  const result = await reporter.get({ socket: { localAddress: '127.0.0.1', localPort: server.address().port } },
    new URLSearchParams());
  assert.equal(result.status, 'unavailable');
  assert.match(result.sources[0].error, /timeout|aborted/i);
});

test('real plugin HTTP discovers sources and deduplicates actual events without trusting Host', { timeout: 20000 }, async t => {
  const root = resolve(__dirname, '../../..');
  const directory = mkdtempSync(join(tmpdir(), 'fralle-report-'));
  const plugins = join(directory, 'plugins');
  mkdirSync(plugins);
  cpSync(join(root, 'board/plugins/fralle'), join(plugins, 'fralle'), { recursive: true });
  cpSync(join(root, 'board/plugins/surret'), join(plugins, 'surret'), { recursive: true });
  cpSync(join(root, 'board/plugins/marcuslind'), join(plugins, 'marcuslind'), { recursive: true });
  mkdirSync(join(plugins, 'report-fixture'));
  cpSync(join(__dirname, 'fixtures/report-provider.cjs'), join(plugins, 'report-fixture/index.js'));
  const child = spawn(process.execPath, ['-e', `
    const {server} = require(${JSON.stringify(join(root, 'board/server.js'))});
    server.listen(0, '127.0.0.1', () => console.log('READY ' + server.address().port));
  `], { env: { ...process.env, DATA_DIR: join(directory, 'data'), PLUGINS_DIR: plugins }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stderr.on('data', chunk => { logs += chunk; });
  t.after(async () => {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    rmSync(directory, { recursive: true, force: true });
  });
  const base = await new Promise((resolveReady, reject) => {
    const timeout = setTimeout(() => reject(new Error('Startup timeout: ' + logs)), 5000);
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Server exited ${code}: ${logs}`)); });
    child.stdout.on('data', chunk => {
      const match = chunk.toString().match(/READY (\d+)/);
      if (match) { clearTimeout(timeout); resolveReady('http://127.0.0.1:' + match[1]); }
    });
  });
  async function emit(body) {
    const result = await fetch(base + '/api/events', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(result.status, 201, await result.clone().text());
    return result.json();
  }
  const posted = await fetch(base + '/api/messages', { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from: 'report-test', channel: 'torget', text: '@kollegan Testfråga' }) });
  assert.equal(posted.status, 201);
  const message = await posted.json();
  let question;
  for (let attempt = 0; attempt < 30 && !question; attempt++) {
    const events = await (await fetch(base + '/api/events?typ=fråga.ny')).json();
    question = events.find(item => item.nyttolast?.inlägg === message.id);
    if (!question) await new Promise(done => setTimeout(done, 20));
  }
  assert.ok(question, 'Örat ska skapa den verkliga frågeroten.');
  await emit({ from: 'rosten', typ: 'svar.klart', orsak: question.id, nyttolast: { fråga_id: question.id } });
  for (let attempt = 0; attempt < 30; attempt++) {
    const status = await (await fetch(base + '/t/fralle/status')).json();
    if (status.besvarade.length) break;
    await new Promise(done => setTimeout(done, 20));
  }
  const result = await fetch(base + '/t/fralle/report?minutes=60', { headers: { host: 'evil.example' } });
  assert.equal(result.status, 200);
  const report = await result.json();
  assert.equal(report.status, 'partial');
  assert.equal(report.summary.questions_observed, 1);
  assert.equal(report.summary.answers_observed, 1);
  assert.equal(report.summary.latency.sample_size, 1);
  assert.equal(report.summary.audiences.test, 1);
  assert.equal(report.summary.feedback.useful, null);
  assert.equal(report.summary.feedback.saved_minutes, null);
  assert.equal(report.summary.feedback.unclassified_feedback, 1);
  assert.equal(report.sources.find(item => item.team === 'surret').mode, 'standard');
  const meeting = report.sources.find(item => item.team === 'marcuslind');
  const meetingData = await (await fetch(base + meeting.url)).json();
  const coverage = meetingData.coverage;
  if (coverage.complete && (coverage.from === null || coverage.to === null ||
    coverage.from > report.period.from || coverage.to < report.period.to)) {
    assert.equal(meeting.mode, 'error', JSON.stringify(meeting));
    assert.match(meeting.error, /Fullständig täckning/);
    t.diagnostic('Mötets ofullständiga täckningskontrakt redovisas som källfel: ' + JSON.stringify(coverage));
  } else {
    assert.equal(meeting.mode, 'standard', JSON.stringify(meeting));
  }
  assert.deepEqual(report.summary.conflicts, []);
  assert.equal(report.sources.find(item => item.team === 'report-fixture').mode, 'standard');
  const invalid = await fetch(base + '/t/fralle/report?minutes=42');
  assert.equal(invalid.status, 400);
  const noPeriod = await fetch(base + '/t/fralle/report-data');
  assert.equal(noPeriod.status, 400);
  const own = await (await fetch(base + `/t/fralle/report-data?from=${report.period.from}&to=${report.period.to}`)).json();
  assert.equal(own.schema_version, 1);
  assert.equal(own.coverage.complete, false);
  assert.equal(own.records[0].question_id, question.id);
  for (const file of ['', 'app.js', 'style.css']) {
    assert.equal((await fetch(base + '/staden/kvarter/fralle/rapport/' + file)).status, 200);
  }
});

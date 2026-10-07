const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');

const directory = resolve(__dirname, '../../../board/public/staden/kvarter/fralle');
const script = readFileSync(resolve(directory, 'rapport/app.js'), 'utf8');
function node(tag = 'div') {
  return {
    tag, textContent: '', children: [], value: '', listeners: {}, style: {},
    append(...items) { this.children.push(...items); },
    replaceChildren(...items) { this.children = items; },
    addEventListener(event, listener) { this.listeners[event] = listener; },
    set innerHTML(_) { throw new Error('Unsafe HTML write'); },
  };
}
const content = element => [element.textContent, ...element.children.map(content)].join('\n');
const tick = () => new Promise(done => setImmediate(done));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function data(minutes = 60) {
  const ts = 1791360000000;
  const period = { from: ts - minutes * 60000, to: ts };
  return {
    schema_version: 1, status: 'partial', generated_at: ts, minutes, period,
    coverage_note: 'Observerat urval; inte hela workshopens totalsiffror.',
    sources: [{
      team: 'fralle', capability: 'Kön', url: '/t/fralle/report-source',
      mode: 'standard', stale: false, error: null, fetched_at: ts,
      data: {
        schema_version: 1, team: 'fralle', capability: 'Kön', generated_at: ts, period,
        coverage: { ...period, complete: false, note: 'Begränsad täckning.' },
        metrics: [
          { key: 'count', label: 'Frågeantal', value: 8, unit: 'frågor', scope: 'period', sample_size: 8 },
          { key: 'active', label: 'Aktiva', value: 0, unit: 'frågor', scope: 'snapshot', sample_size: 0 },
          { key: 'total', label: 'Historik', value: 13, unit: 'svar', scope: 'lifetime' },
          { key: 'saved', label: 'Sparat', value: null, unit: 'minuter', scope: 'retained', sample_size: null },
        ],
      },
    }],
    summary: {
      questions_observed: 8, answers_observed: 4, cancellations_observed: 1, outcome_unknown: 3,
      unmatched_outcomes: 2, latency: { median_ms: 1000, p95_ms: 2400, sample_size: 4 },
      audiences: { human: 2, agent: 3, test: 1, unknown: 2 },
      feedback: { useful: 1, not_useful: 0, sample_size: 1, saved_minutes: 7, savings_samples: 1, unclassified_feedback: 2 },
      conflicts: [{ question_id: 42, fields: ['answered_at', 'audience'] }], complete: false,
    },
    series: [{ ts: period.from, questions: 8, answers: 4, cancellations: 1 }],
  };
}
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
async function run(fetcher) {
  const ids = { connection: node(), report: node(), period: node('select') };
  ids.period.value = '60';
  const timers = new Map();
  const requests = [];
  const timeouts = [];
  let next = 0;
  vm.runInNewContext(script, {
    document: { getElementById: id => ids[id], createElement: node },
    fetch: (url, options) => { requests.push({ url, ...options }); return fetcher(url, options); },
    AbortController,
    AbortSignal: {
      any: signals => AbortSignal.any(signals),
      timeout: ms => { timeouts.push(ms); return AbortSignal.timeout(ms); },
    },
    setTimeout: (callback, ms) => {
      const id = ++next;
      timers.set(id, { ms, callback: () => { timers.delete(id); return callback(); } });
      return id;
    },
    clearTimeout: id => timers.delete(id),
  });
  await tick();
  return {
    ids, timers, requests, timeouts,
    change: async minutes => { ids.period.value = String(minutes); ids.period.listeners.change(); await tick(); },
    poll: async () => { assert.equal(timers.size, 1); await [...timers.values()][0].callback(); await tick(); },
  };
}

test('page and queue entry link are accessible, isolated and preserve queue elements', () => {
  const html = readFileSync(resolve(directory, 'rapport/index.html'), 'utf8');
  assert.match(html, /lang="sv"/);
  assert.match(html, /href="\/staden\/kvarter\/fralle\/"/);
  for (const minutes of [15, 60, 1440]) assert.match(html, new RegExp(`value="${minutes}"`));
  assert.match(html, /value="60" selected/);
  assert.match(html, /role="status" aria-live="polite"/);
  const queue = readFileSync(resolve(directory, 'index.html'), 'utf8');
  assert.match(queue, /href="\/staden\/kvarter\/fralle\/rapport\/" target="_blank" rel="noopener"/);
  for (const id of ['connection', 'statistics', 'coordination', 'requester-filter', 'stage-filter',
    'queue-heading', 'questions', 'completed', 'cancelled', 'errors', 'capabilities']) {
    assert.match(queue, new RegExp(`id="${id}"`));
  }
  assert.doesNotMatch(script, /innerHTML|setInterval/);
});

test('renders summary, matched latency, audiences, explicit human benefits and discrepancies', async () => {
  const { ids, requests, timers, timeouts } = await run(async () => response(data()));
  const text = content(ids.report);
  assert.match(text, /Frågor\n8/);
  assert.match(text, /Besvarade\n4/);
  assert.match(text, /Återkallade\n1/);
  assert.match(text, /Okänt utfall\n3/);
  assert.match(text, /inte bevis på fel/);
  assert.match(text, /inte alla globalt avslutade svar/);
  assert.match(text, /Median: 1000 ms · p95: 2400 ms · Urval: 4/);
  assert.match(text, /Människa: 2 · Agent: 3 · Test: 1 · Okänd \(ej klassificerad\): 2/);
  assert.match(text, /Endast explicit feedback/);
  assert.match(text, /Sparad tid: 7 minuter · Tidsbesparingsurval: 1/);
  assert.match(text, /Oklassificerad feedback.*2/);
  assert.match(text, /Omatchade utfall: 2/);
  assert.match(text, /Fråga 42: motstridiga fält answered_at, audience/);
  assert.equal(requests[0].url, '/t/fralle/report?minutes=60');
  assert.deepEqual(timeouts, [10000]);
  assert.equal(timers.size, 1);
  assert.equal([...timers.values()][0].ms, 30000);
});

test('source tables show units, scopes, explicit zero and null distinctly', async () => {
  const { ids } = await run(async () => response(data()));
  const text = content(ids.report);
  assert.match(text, /Frågeantal\n8\nfrågor\nVald period\n8/);
  assert.match(text, /Aktiva\n0\nfrågor\nNuläge\n0/);
  assert.match(text, /Historik\n13\nsvar\nSedan starten\/livstid\nEj angivet/);
  assert.match(text, /Sparat\nEj uppmätt\nminuter\nBegränsat urval\nSaknas/);
  assert.match(text, /Källtäckning:.*Begränsad\/ofullständig/);
  assert.match(text, /slut exkluderat/);
});

test('valid HTTP 503 unavailable report renders unknown counts and each source error', async () => {
  const report = data();
  report.status = 'unavailable';
  for (const field of ['questions_observed', 'answers_observed', 'cancellations_observed', 'outcome_unknown']) report.summary[field] = null;
  report.sources = ['fralle', 'minnet'].map(team => ({
    team, capability: 'Okänd', url: `/t/${team}/report`, mode: 'error',
    stale: false, error: `HTTP 503 från ${team}`, fetched_at: report.generated_at, data: null,
  }));
  const { ids, timers } = await run(async () => response(report, 503));
  assert.match(ids.connection.textContent, /Otillgänglig/);
  const text = content(ids.report);
  assert.match(text, /Frågor\nSaknas/);
  assert.match(text, /Besvarade\nSaknas/);
  assert.match(text, /Källfel: HTTP 503 från fralle/);
  assert.match(text, /Källfel: HTTP 503 från minnet/);
  assert.match(text, /Underlag saknas · Datafärskhet: Okänd/);
  assert.equal(timers.size, 1);
  assert.notEqual(ids.period.disabled, true);
});

test('healthy sources do not hide another source error; legacy coverage and freshness are honest', async () => {
  const report = data();
  const legacy = structuredClone(report.sources[0]);
  legacy.team = 'äldre';
  legacy.mode = 'legacy';
  legacy.stale = true;
  legacy.error = 'Timeout, tidigare underlag';
  legacy.data.generated_at = null;
  legacy.data.coverage = { from: null, to: null, complete: true, note: 'Okänd historik' };
  report.sources.push(legacy);
  const { ids } = await run(async () => response(report));
  const text = content(ids.report);
  assert.match(text, /Källstatus: Standard/);
  assert.match(text, /Äldre begränsat API \(legacy\) · Inaktuella data/);
  assert.match(text, /Källfel: Timeout, tidigare underlag/);
  assert.match(text, /Datafärskhet \(källans generering\): Okänd/);
  assert.match(text, /Hämtningstid är inte ursprunglig datafärskhet/);
  assert.match(text, /Källtäckning: Okänd – Okänd · Begränsad\/ofullständig/);
  assert.match(text, /full tidstäckning kan inte hävdas/);
});

test('absent human benefits and latency are not invented; measured zero stays zero', async () => {
  const report = data();
  report.summary.feedback.useful = null;
  report.summary.feedback.saved_minutes = null;
  report.summary.latency = { median_ms: null, p95_ms: null, sample_size: 0 };
  const state = await run(async () => response(report));
  let text = content(state.ids.report);
  assert.match(text, /Nyttigt: Ej uppmätt · Inte nyttigt: 0/);
  assert.match(text, /Sparad tid: Ej uppmätt minuter/);
  assert.match(text, /Median: Ej uppmätt ms · p95: Ej uppmätt ms · Urval: 0/);
  report.summary.feedback.saved_minutes = 0;
  await state.poll();
  text = content(state.ids.report);
  assert.match(text, /Sparad tid: 0 minuter/);
});

test('hostile provider strings and error details remain inert text', async () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const report = data();
  report.coverage_note = hostile;
  report.sources[0].team = hostile;
  report.sources[0].url = 'javascript:alert(1)';
  report.sources[0].error = hostile;
  report.sources[0].data.metrics[0].label = hostile;
  report.sources[0].data.metrics[0].unit = hostile;
  report.sources[0].data.coverage.note = hostile;
  report.summary.conflicts[0].fields = [hostile];
  const { ids } = await run(async () => response(report));
  assert.ok(content(ids.report).includes(hostile));
  assert.match(content(ids.report), /API: javascript:alert\(1\)/);
  function check(element) {
    assert.notEqual(element.tag, 'img');
    assert.notEqual(element.tag, 'script');
    assert.notEqual(element.tag, 'a');
    element.children.forEach(check);
  }
  check(ids.report);
});

test('timeline renders labelled question, answer and cancellation bars without SVG', async () => {
  const { ids } = await run(async () => response(data()));
  const bars = [];
  function visit(element) {
    if (element.className?.startsWith('bar ')) bars.push(element);
    assert.notEqual(element.tag, 'svg');
    element.children.forEach(visit);
  }
  visit(ids.report);
  assert.deepEqual(bars.map(bar => bar.style.width), ['100%', '50%', '12.5%']);
  assert.match(content(ids.report), /Frågor: 8/);
  assert.match(content(ids.report), /Svar: 4/);
  assert.match(content(ids.report), /Återkallelser: 1/);
});

for (const [label, failure] of [
  ['network', async () => { throw new Error('Nätverket nere'); }],
  ['invalid JSON', async () => ({ ok: true, json: async () => { throw new SyntaxError('Ogiltig JSON'); } })],
  ['invalid structure', async () => response({ schema_version: 1 })],
  ['invalid nested values', async () => { const report = data(); report.sources[0].data.metrics[0].value = '8'; return response(report); }],
  ['HTTP failure', async () => response(data(), 500)],
]) {
  test(`${label} retains previous data and explicitly labels it stale`, async () => {
    let calls = 0;
    const state = await run(async () => ++calls === 1 ? response(data()) : failure());
    const previous = state.ids.report.children[0];
    await state.poll();
    assert.equal(state.ids.report.children[0], previous);
    assert.equal(state.ids.connection.className, 'stale');
    assert.match(state.ids.connection.textContent, /Inaktuell rapport \(60 minuter\)/);
    assert.equal(state.timers.size, 1);
    assert.notEqual(state.ids.period.disabled, true);
  });
}

test('first failure leaves selector usable and later success recovers', async () => {
  let fail = true;
  const state = await run(async () => {
    if (fail) throw new Error('Offline');
    return response(data(15));
  });
  assert.match(state.ids.connection.textContent, /Rapport saknas: Offline/);
  assert.equal(state.ids.report.children.length, 0);
  fail = false;
  await state.change(15);
  assert.match(state.ids.connection.textContent, /Rapport för 15 minuter/);
  assert.equal(state.timers.size, 1);
});

test('period change aborts old request and stale completion cannot overwrite current results or create a timer', async () => {
  const old = deferred();
  const latest = deferred();
  const state = await run(url => url.endsWith('=60') ? old.promise : latest.promise);
  assert.equal(state.timers.size, 0);
  await state.change(15);
  assert.equal(state.requests[0].signal.aborted, true);
  assert.equal(state.timers.size, 0);
  latest.resolve(response(data(15)));
  await tick();
  const fresh = state.ids.report.children[0];
  assert.match(state.ids.connection.textContent, /Rapport för 15 minuter/);
  old.resolve(response(data(60)));
  await tick();
  assert.equal(state.ids.report.children[0], fresh);
  assert.match(state.ids.connection.textContent, /Rapport för 15 minuter/);
  assert.equal(state.timers.size, 1);
});

test('multiple rapid changes and old rejections leave just one polling timer', async () => {
  const requests = [deferred(), deferred(), deferred()];
  let count = 0;
  const state = await run(() => requests[count++].promise);
  await state.change(15);
  await state.change(1440);
  requests[0].reject(new Error('Aborted'));
  requests[1].reject(new Error('Aborted'));
  await tick();
  assert.equal(state.timers.size, 0);
  requests[2].resolve(response(data(1440)));
  await tick();
  assert.equal(state.timers.size, 1);
  assert.match(state.ids.connection.textContent, /Rapport för 1440 minuter/);
});

test('polling waits for response JSON completion, never overlaps, and replaces pending timer on change', async () => {
  const json = deferred();
  let count = 0;
  const state = await run(async url => {
    count++;
    if (count === 1) return { ok: true, json: () => json.promise };
    return response(data(Number(url.split('=')[1])));
  });
  assert.equal(count, 1);
  assert.equal(state.timers.size, 0);
  await tick();
  assert.equal(count, 1);
  json.resolve(data());
  await tick();
  assert.equal(state.timers.size, 1);
  await state.poll();
  assert.equal(count, 2);
  assert.equal(state.timers.size, 1);
  await state.change(15);
  assert.equal(count, 3);
  assert.equal(state.timers.size, 1);
});

test('report for wrong requested period is rejected without replacing previous data', async () => {
  const state = await run(async () => response(data()));
  const previous = state.ids.report.children[0];
  await state.change(15);
  assert.equal(state.ids.report.children[0], previous);
  assert.match(state.ids.connection.textContent, /Inaktuell rapport \(60 minuter\).*15 minuter.*Ogiltigt/);
});

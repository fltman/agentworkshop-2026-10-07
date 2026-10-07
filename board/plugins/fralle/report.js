const { isIP } = require('node:net');
const { PROVIDERS, adaptLegacy, inPeriod } = require('./report-sources');

const TEAM = /^[a-zåäö0-9-]{1,40}$/;
const PERIODS = [15, 60, 1440];
const MAX_BYTES = 262144;
const MAX_AGE = 120000;
const CACHE_TIME = 10000;
const SCOPES = ['period', 'snapshot', 'lifetime', 'retained'];
const AUDIENCES = ['human', 'agent', 'test', 'unknown'];
const timestamp = value => Number.isSafeInteger(value) && value >= 0;
const nullableTime = value => value === null || timestamp(value);
const text = (value, max = 200) => typeof value === 'string' && value.length > 0 && value.length <= max;

function parsePeriod(params, now = Date.now()) {
  const rawFrom = params.get('from'), rawTo = params.get('to');
  if (!/^\d{1,16}$/.test(rawFrom || '') || !/^\d{1,16}$/.test(rawTo || '')) {
    throw new Error('from och to behövs som UTC epoch-millisekunder.');
  }
  const from = Number(rawFrom), to = Number(rawTo);
  if (!timestamp(from) || !timestamp(to) || from >= to || to > now || to - from > 86400000) {
    throw new Error('Perioden ska vara högst 24 timmar, från < till och inte i framtiden.');
  }
  return { from, to };
}

function validate(data, provider, period, now) {
  if (!data || data.schema_version !== 1 || data.team !== provider.team ||
    !text(data.capability, 80) || !timestamp(data.generated_at) || data.generated_at > now + 5000 ||
    data.period?.from !== period.from || data.period?.to !== period.to ||
    !data.coverage || !nullableTime(data.coverage.from) || !nullableTime(data.coverage.to) ||
    typeof data.coverage.complete !== 'boolean' || !text(data.coverage.note, 1000) ||
    !Array.isArray(data.metrics) || data.metrics.length > 100) {
    throw new Error('Ogiltigt report-data V1-kontrakt, team, period eller täckning.');
  }
  if (data.coverage.from !== null && data.coverage.to !== null && data.coverage.from > data.coverage.to) {
    throw new Error('Källans täckningsintervall är omvänt.');
  }
  if (data.coverage.complete && (data.coverage.from === null || data.coverage.from > period.from ||
    data.coverage.to === null || data.coverage.to < period.to || data.generated_at < period.to)) {
    throw new Error('Fullständig täckning saknar stöd för hela perioden.');
  }
  const keys = new Set();
  const metrics = data.metrics.map(item => {
    if (!item || !/^[a-z][a-z0-9_.-]{0,63}$/.test(item.key || '') || keys.has(item.key) ||
      !text(item.label) || !(item.value === null || Number.isFinite(item.value)) ||
      !text(item.unit, 40) || !SCOPES.includes(item.scope) ||
      !(item.sample_size === undefined || item.sample_size === null ||
        Number.isSafeInteger(item.sample_size) && item.sample_size >= 0)) {
      throw new Error('Ogiltigt eller dubblerat mått i report-data.');
    }
    keys.add(item.key);
    return { key: item.key, label: item.label, value: item.value, unit: item.unit, scope: item.scope,
      ...(item.sample_size === undefined ? {} : { sample_size: item.sample_size }) };
  });
  let records;
  if (data.records !== undefined) {
    if (!Array.isArray(data.records) || data.records.length > 500) throw new Error('Max 500 frågeposter per källa.');
    records = data.records.map(item => {
      if (!item || !Number.isSafeInteger(item.question_id) || item.question_id <= 0 ||
        !nullableTime(item.received_at) || !nullableTime(item.answered_at) || !nullableTime(item.cancelled_at) ||
        !AUDIENCES.includes(item.audience) || !(item.useful === null || typeof item.useful === 'boolean') ||
        !(item.saved_minutes === null || Number.isFinite(item.saved_minutes) && item.saved_minutes >= 0) ||
        [item.received_at, item.answered_at, item.cancelled_at].some(ts => ts !== null && ts > data.generated_at) ||
        (item.received_at !== null && [item.answered_at, item.cancelled_at].some(ts => ts !== null && ts < item.received_at))) {
        throw new Error('Ogiltigt rot-id, tidsstämpel, avsändarklass eller nyttomått.');
      }
      return {
        question_id: item.question_id, received_at: item.received_at, answered_at: item.answered_at,
        cancelled_at: item.cancelled_at, audience: item.audience, useful: item.useful, saved_minutes: item.saved_minutes,
      };
    });
  }
  return {
    schema_version: 1, team: data.team, capability: data.capability, generated_at: data.generated_at,
    period, coverage: { from: data.coverage.from, to: data.coverage.to,
      complete: data.coverage.complete, note: data.coverage.note }, metrics,
    ...(records === undefined ? {} : { records }),
  };
}

function aggregate(sources, period, minutes) {
  const index = new Map();
  const fields = ['received_at', 'answered_at', 'cancelled_at', 'audience', 'useful', 'saved_minutes'];
  const recordSources = sources.filter(source => Array.isArray(source.data?.records));
  for (const source of recordSources) {
    for (const incoming of source.data.records) {
      if (!index.has(incoming.question_id)) index.set(incoming.question_id, { question_id: incoming.question_id, conflicts: new Set() });
      const item = index.get(incoming.question_id);
      for (const field of fields) {
        const value = incoming[field];
        if (value === null || value === undefined || field === 'audience' && value === 'unknown') continue;
        if (item[field] !== undefined && item[field] !== value) item.conflicts.add(field);
        else item[field] = value;
      }
    }
  }
  for (const item of index.values()) {
    for (const field of item.conflicts) delete item[field];
    for (const field of ['answered_at', 'cancelled_at']) {
      if (item[field] < item.received_at) {
        item.conflicts.add(field);
        delete item[field];
      }
    }
    if (item.answered_at !== undefined && item.cancelled_at !== undefined) {
      item.conflicts.add('final_outcome');
      delete item.answered_at;
      delete item.cancelled_at;
    }
  }
  const cohort = [...index.values()].filter(item => inPeriod(item.received_at, period));
  const answered = cohort.filter(item => inPeriod(item.answered_at, period));
  const cancelled = cohort.filter(item => inPeriod(item.cancelled_at, period));
  const latencies = answered.filter(item => item.answered_at >= item.received_at)
    .map(item => item.answered_at - item.received_at).sort((a, b) => a - b);
  const audiences = { human: 0, agent: 0, test: 0, unknown: 0 };
  for (const item of cohort) audiences[item.audience || 'unknown']++;
  const feedback = cohort.filter(item => item.audience === 'human' && typeof item.useful === 'boolean');
  const savings = cohort.filter(item => item.audience === 'human' && Number.isFinite(item.saved_minutes));
  const savedMinutes = savings.reduce((sum, item) => sum + item.saved_minutes, 0);
  if (!Number.isFinite(savedMinutes)) throw new Error('Rapporterad sparad tid överskrider ett ändligt tal.');
  const available = recordSources.length > 0;
  const bucketSize = minutes <= 60 ? 300000 : 3600000;
  const series = [];
  for (let ts = period.from; ts < period.to; ts += bucketSize) series.push({ ts, questions: 0, answers: 0, cancellations: 0 });
  for (const item of cohort) {
    for (const [field, column] of [['received_at', 'questions'], ['answered_at', 'answers'], ['cancelled_at', 'cancellations']]) {
      if (inPeriod(item[field], period)) series[Math.floor((item[field] - period.from) / bucketSize)][column]++;
    }
  }
  return {
    summary: {
      questions_observed: available ? cohort.length : null,
      answers_observed: available ? answered.length : null,
      cancellations_observed: available ? cancelled.length : null,
      outcome_unknown: available ? cohort.length - answered.length - cancelled.length : null,
      unmatched_outcomes: [...index.values()].filter(item => !inPeriod(item.received_at, period) &&
        (inPeriod(item.answered_at, period) || inPeriod(item.cancelled_at, period))).length,
      latency: {
        median_ms: latencies.length ? (latencies[Math.floor((latencies.length - 1) / 2)] + latencies[Math.floor(latencies.length / 2)]) / 2 : null,
        p95_ms: latencies.length ? latencies[Math.ceil(latencies.length * 0.95) - 1] : null,
        sample_size: latencies.length,
      },
      audiences,
      feedback: {
        useful: feedback.length ? feedback.filter(item => item.useful).length : null,
        not_useful: feedback.length ? feedback.filter(item => !item.useful).length : null,
        sample_size: feedback.length,
        saved_minutes: savings.length ? savedMinutes : null,
        savings_samples: savings.length,
        unclassified_feedback: cohort.filter(item => item.audience !== 'human' &&
          (typeof item.useful === 'boolean' || Number.isFinite(item.saved_minutes))).length,
      },
      conflicts: [...index.values()].filter(item => item.conflicts.size)
        .map(item => ({ question_id: item.question_id, fields: [...item.conflicts] })),
      complete: recordSources.length > 0 && [...index.values()].every(item => !item.conflicts.size) &&
        sources.every(source => source.mode === 'standard' &&
        !source.stale && source.data.coverage.complete),
    },
    series: available ? series : [],
  };
}

function originOf(req) {
  const address = req.socket?.localAddress, port = req.socket?.localPort;
  const version = isIP(address || '');
  if (!version || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error('Rapportören saknar serverns lokala anslutningsadress.');
  }
  return `http://${version === 6 ? `[${address}]` : address}:${port}`;
}

async function readJSON(url, fetcher, timeout) {
  const response = await fetcher(url, { signal: AbortSignal.timeout(timeout), redirect: 'error',
    headers: { accept: 'application/json' } });
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status} från ${new URL(url).pathname}`);
    error.status = response.status;
    throw error;
  }
  if (!/application\/json/i.test(response.headers.get('content-type') || '')) throw new Error('Källan returnerade inte JSON.');
  if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('Källans svar är större än 256 KiB.');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > MAX_BYTES) {
      const error = new Error('Källans svar är större än 256 KiB.');
      throw error;
    }
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function createReporter({ fetcher = fetch, timeout = 3000 } = {}) {
  const cache = new Map(), pending = new Map();
  let generation = 0;
  async function collect(origin, minutes) {
    const now = Date.now(), period = { from: now - minutes * 60000, to: now };
    const providers = new Map(PROVIDERS.map(item => [item.team, item]));
    let discoveryError = null;
    try {
      const plugins = await readJSON(origin + '/api/plugins', fetcher, timeout);
      if (!Array.isArray(plugins) || plugins.length > 40 ||
        plugins.some(item => !TEAM.test(item?.team || '') || typeof item.routes !== 'boolean')) {
        throw new Error('Ogiltigt eller för stort förmågeregister.');
      }
      for (const plugin of plugins) {
        if (!providers.has(plugin.team)) providers.set(plugin.team, { team: plugin.team, capability: plugin.team, legacy: null });
      }
    } catch (error) {
      discoveryError = `Förmågeregistret kunde inte läsas: ${error.message}`;
      console.error('[fralle] Rapportören:', discoveryError);
    }
    const sources = await Promise.all([...providers.values()].map(async provider => {
      let url = `/t/${encodeURIComponent(provider.team)}/report-data?from=${period.from}&to=${period.to}`;
      try {
        let data, mode = 'standard';
        try {
          data = validate(await readJSON(origin + url, fetcher, timeout), provider, period, Date.now());
        } catch (error) {
          if (error.status !== 404 || !provider.legacy) throw error;
          url = `/t/${encodeURIComponent(provider.team)}${provider.legacy}`;
          data = adaptLegacy(provider, await readJSON(origin + url, fetcher, timeout), period);
          mode = 'legacy';
        }
        return {
          team: provider.team, capability: data.capability, url, mode,
          stale: data.generated_at !== null && Date.now() - data.generated_at > MAX_AGE,
          error: null, fetched_at: Date.now(), data,
        };
      } catch (error) {
        console.error(`[fralle] Rapportören ${provider.team}:`, error.message);
        return { team: provider.team, capability: provider.capability, url, mode: 'error',
          stale: false, error: error.message, fetched_at: Date.now(), data: null };
      }
    }));
    const { summary, series } = aggregate(sources, period, minutes);
    const status = sources.every(source => !source.data) ? 'unavailable' : summary.complete && !discoveryError ? 'complete' : 'partial';
    return {
      schema_version: 1, status, generated_at: Date.now(), minutes, period,
      coverage_note: 'Observerade unika frågor inkomna i perioden, inte garanterade totaler. Nuläge, livstid och begränsade urval hålls isär. ' +
        'Svarstider gäller matchade rot-id:n; användarnytta kräver uttrycklig feedback och avsändarklassen human.' +
        (discoveryError ? ' ' + discoveryError : ''),
      sources: sources.map(source => {
        if (!source.data) return source;
        const { records, ...data } = source.data;
        return { ...source, data };
      }),
      summary: { ...summary, complete: summary.complete && !discoveryError }, series,
    };
  }
  return {
    invalidate() { generation++; cache.clear(); },
    reset() { generation++; cache.clear(); pending.clear(); },
    async get(req, params) {
      const value = params.get('minutes') || '60';
      if (!PERIODS.map(String).includes(value)) {
        const error = new Error('minutes ska vara 15, 60 eller 1440.');
        error.status = 400;
        throw error;
      }
      const minutes = Number(value), origin = originOf(req), key = `${origin}|${minutes}`;
      const saved = cache.get(key);
      if (saved && Date.now() - saved.ts < CACHE_TIME) return saved.report;
      if (pending.has(key)) return pending.get(key);
      const startedGeneration = generation;
      const result = collect(origin, minutes).then(report => {
        if (generation === startedGeneration) {
          cache.set(key, { ts: Date.now(), report });
          if (cache.size > 6) cache.delete(cache.keys().next().value);
        }
        return report;
      }).finally(() => { if (pending.get(key) === result) pending.delete(key); });
      pending.set(key, result);
      return result;
    },
  };
}

module.exports = { createReporter, parsePeriod, validate, aggregate, originOf };

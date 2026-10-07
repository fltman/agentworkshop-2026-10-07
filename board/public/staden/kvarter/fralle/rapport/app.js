(() => {
  'use strict';
  const connection = document.getElementById('connection');
  const report = document.getElementById('report');
  const selector = document.getElementById('period');
  const scopes = {
    period: 'Vald period', snapshot: 'Nuläge',
    lifetime: 'Sedan starten/livstid', retained: 'Begränsat urval',
  };
  const statuses = { complete: 'Komplett', partial: 'Delvis tillgänglig', unavailable: 'Otillgänglig' };
  let timer;
  let controller;
  let version = 0;
  let previous = null;

  const number = value => typeof value === 'number' && Number.isFinite(value);
  const nullable = value => value === null || number(value);
  const text = value => typeof value === 'string';
  const range = value => value && number(value.from) && number(value.to);
  const value = (input, missing = 'Saknas') => input === null ? missing : String(input);
  const time = input => input === null ? 'Okänd' : new Date(input).toLocaleString('sv-SE');
  const interval = input => `${time(input.from)} – ${time(input.to)} (slut exkluderat)`;

  function valid(data, minutes) {
    if (!data || data.schema_version !== 1 || !Object.hasOwn(statuses, data.status) ||
        data.minutes !== minutes || !number(data.generated_at) || !range(data.period) ||
        !text(data.coverage_note) || !Array.isArray(data.sources) ||
        !Array.isArray(data.series)) return false;
    const s = data.summary;
    if (!s || typeof s.complete !== 'boolean' ||
        !['questions_observed', 'answers_observed', 'cancellations_observed', 'outcome_unknown']
          .every(key => nullable(s[key])) || !number(s.unmatched_outcomes) ||
        !s.latency || !nullable(s.latency.median_ms) || !nullable(s.latency.p95_ms) ||
        !number(s.latency.sample_size) || !s.audiences ||
        !['human', 'agent', 'test', 'unknown'].every(key => number(s.audiences[key])) ||
        !s.feedback || !['useful', 'not_useful', 'saved_minutes'].every(key => nullable(s.feedback[key])) ||
        !['sample_size', 'savings_samples', 'unclassified_feedback'].every(key => number(s.feedback[key])) ||
        !Array.isArray(s.conflicts) || !s.conflicts.every(item =>
          item && number(item.question_id) && Array.isArray(item.fields) && item.fields.every(text))) return false;
    return data.series.every(item => item && ['ts', 'questions', 'answers', 'cancellations'].every(key => number(item[key]))) &&
      data.sources.every(source => {
        if (!source || !text(source.team) || !text(source.capability) || !text(source.url) ||
            !['standard', 'legacy', 'error'].includes(source.mode) || typeof source.stale !== 'boolean' ||
            !(source.error === null || text(source.error)) || !number(source.fetched_at)) return false;
        const d = source.data;
        return d === null || (d && d.schema_version === 1 && text(d.team) && text(d.capability) &&
          nullable(d.generated_at) && range(d.period) && d.coverage &&
          nullable(d.coverage.from) && nullable(d.coverage.to) && typeof d.coverage.complete === 'boolean' &&
          text(d.coverage.note) && Array.isArray(d.metrics) && d.metrics.every(metric =>
            metric && text(metric.key) && text(metric.label) && nullable(metric.value) &&
            text(metric.unit) && Object.hasOwn(scopes, metric.scope) &&
            (metric.sample_size === undefined || nullable(metric.sample_size))));
      });
  }

  function el(tag, content, className) {
    const node = document.createElement(tag);
    if (content !== undefined) node.textContent = content;
    if (className) node.className = className;
    return node;
  }

  function section(parent, title) {
    const node = el('section');
    node.append(el('h2', title));
    parent.append(node);
    return node;
  }

  function card(parent, label, amount, note) {
    const node = el('article', undefined, 'card');
    node.append(el('h3', label), el('p', amount, 'value'), el('p', note, 'note'));
    parent.append(node);
  }

  function render(data) {
    const root = el('div');
    const s = data.summary;
    root.append(el('p', `${statuses[data.status]} · ${data.minutes} minuter · Rapport skapad ${time(data.generated_at)}`),
      el('p', `Period: ${interval(data.period)}`),
      el('p', data.coverage_note, 'coverage'),
      el('p', `Sammanställningens täckning: ${s.complete ? 'Komplett enligt källorna' : 'Ofullständig; slutsatser begränsas av källorna'}.`));
    const counts = section(root, 'Observerade frågor och utfall');
    counts.append(el('p', 'Distinkta råa fråga.ny-root-ID:n mottagna i vald period. Svar och återkallelser avser dessa frågor, inte alla globalt avslutade svar.'));
    const cards = el('div', undefined, 'cards');
    counts.append(cards);
    card(cards, 'Frågor', value(s.questions_observed), 'Observerade i vald period.');
    card(cards, 'Besvarade', value(s.answers_observed), 'Bland periodens observerade frågor.');
    card(cards, 'Återkallade', value(s.cancellations_observed), 'Bland periodens observerade frågor.');
    card(cards, 'Okänt utfall', value(s.outcome_unknown), 'Inget känt daterat slututfall; inte bevis på fel.');

    const latency = section(root, 'Svarstid');
    latency.append(el('p', `Median: ${value(s.latency.median_ms, 'Ej uppmätt')} ms · p95: ${value(s.latency.p95_ms, 'Ej uppmätt')} ms · Urval: ${s.latency.sample_size}`),
      el('p', 'Endast matchade unika root-frågor. Ingen medelvärdesbildning av leverantörers medelvärden.', 'note'));
    const audiences = section(root, 'Deklarerad målgrupp');
    audiences.append(el('p', `Människa: ${s.audiences.human} · Agent: ${s.audiences.agent} · Test: ${s.audiences.test} · Okänd (ej klassificerad): ${s.audiences.unknown}`));
    const benefits = section(root, 'Uppmätt nytta för människor');
    benefits.append(el('p', 'Endast explicit feedback och tidsbesparing för frågor uttryckligen klassificerade som människa. Inga uppskattade värden.'));
    const f = s.feedback;
    benefits.append(el('p', `Nyttigt: ${value(f.useful, 'Ej uppmätt')} · Inte nyttigt: ${value(f.not_useful, 'Ej uppmätt')} · Feedbackurval: ${f.sample_size}`),
      el('p', `Sparad tid: ${value(f.saved_minutes, 'Ej uppmätt')} minuter · Tidsbesparingsurval: ${f.savings_samples}`),
      el('p', `Oklassificerad feedback (inte mänsklig nytta): ${f.unclassified_feedback}`));

    const timeline = section(root, 'Tidslinje för observationer');
    timeline.append(el('p', 'Frågor · Svar · Återkallelser. Svar är bland frågorna observerade i vald period, inte samtliga globala svar.', 'note'));
    const max = Math.max(1, ...data.series.flatMap(item => [item.questions, item.answers, item.cancellations]));
    if (!data.series.length) timeline.append(el('p', 'Inget tidsserieunderlag.'));
    for (const item of data.series) {
      const row = el('div', undefined, 'bucket');
      row.append(el('p', time(item.ts)));
      for (const [key, label] of [['questions', 'Frågor'], ['answers', 'Svar'], ['cancellations', 'Återkallelser']]) {
        const bar = el('div', undefined, 'bar-row');
        const track = el('div', undefined, 'track');
        const fill = el('div', undefined, `bar ${key}`);
        fill.style.width = `${Math.max(0, item[key]) / max * 100}%`;
        track.append(fill);
        bar.append(el('span', `${label}: ${item[key]}`), track);
        row.append(bar);
      }
      timeline.append(row);
    }

    const discrepancies = section(root, 'Avvikelser');
    discrepancies.append(el('p', `Omatchade utfall: ${s.unmatched_outcomes}. Utfall utan matchad observerad root-fråga blandas inte in i totalsiffrorna.`));
    const conflicts = el('ul');
    for (const conflict of s.conflicts) conflicts.append(el('li', `Fråga ${conflict.question_id}: motstridiga fält ${conflict.fields.join(', ')}`));
    if (!s.conflicts.length) conflicts.append(el('li', 'Inga rapporterade konflikter.'));
    discrepancies.append(conflicts);

    const sources = section(root, 'Källor och mätvärden');
    if (!data.sources.length) sources.append(el('p', 'Inga källor tillgängliga.'));
    for (const source of data.sources) {
      const box = el('article', undefined, 'source');
      box.append(el('h3', `${source.team} · ${source.capability}`), el('p', `API: ${source.url}`),
        el('p', `Källstatus: ${source.mode === 'error' ? 'Fel' : source.mode === 'legacy' ? 'Äldre begränsat API (legacy)' : 'Standard'} · ${source.stale ? 'Inaktuella data' : 'Inte markerad inaktuell'}`),
        el('p', `Hämtad: ${time(source.fetched_at)}. Hämtningstid är inte ursprunglig datafärskhet.`, 'note'));
      if (source.error !== null) box.append(el('p', `Källfel: ${source.error}`, 'error'));
      const d = source.data;
      if (d === null) box.append(el('p', 'Underlag saknas · Datafärskhet: Okänd'));
      else {
        box.append(el('p', `Datafärskhet (källans generering): ${time(d.generated_at)}`),
          el('p', `Källperiod: ${interval(d.period)}`),
          el('p', `Källtäckning: ${time(d.coverage.from)} – ${time(d.coverage.to)} · ${source.mode !== 'legacy' && d.coverage.complete ? 'Komplett enligt källan' : 'Begränsad/ofullständig'}`),
          el('p', d.coverage.note));
        if (source.mode === 'legacy') box.append(el('p', 'Äldre API ger ett begränsat urval; full tidstäckning kan inte hävdas.', 'note'));
        const table = el('table');
        const head = el('tr');
        for (const label of ['Mätvärde', 'Värde', 'Enhet', 'Omfattning', 'Urval']) head.append(el('th', label));
        const thead = el('thead');
        thead.append(head);
        const tbody = el('tbody');
        for (const metric of d.metrics) {
          const row = el('tr');
          for (const cell of [metric.label, value(metric.value, 'Ej uppmätt'), metric.unit, scopes[metric.scope],
            metric.sample_size === undefined ? 'Ej angivet' : value(metric.sample_size)]) row.append(el('td', cell));
          tbody.append(row);
        }
        table.append(thead, tbody);
        const scroll = el('div', undefined, 'table-scroll');
        scroll.append(table);
        box.append(scroll);
        if (!d.metrics.length) box.append(el('p', 'Inga mätvärden.'));
      }
      sources.append(box);
    }
    report.replaceChildren(root);
  }

  async function refresh() {
    clearTimeout(timer);
    if (controller) controller.abort();
    controller = new AbortController();
    const current = ++version;
    const minutes = Number(selector.value);
    connection.className = previous ? 'stale' : '';
    connection.textContent = previous
      ? `Hämtar ${minutes} minuter… Tidigare rapport (${previous.minutes} minuter) visas tills hämtningen är klar.`
      : 'Hämtar rapport…';
    try {
      const response = await fetch(`/t/fralle/report?minutes=${minutes}`, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
      });
      const data = await response.json();
      if (current !== version) return;
      if (!valid(data, minutes)) throw new Error('Ogiltigt rapportunderlag');
      if (!response.ok && !(response.status === 503 && data.status === 'unavailable')) throw new Error(`HTTP ${response.status}`);
      render(data);
      previous = data;
      connection.className = data.status === 'complete' ? '' : 'warning';
      connection.textContent = `${statuses[data.status]} · Rapport för ${minutes} minuter. Nästa hämtning om 30 sekunder.`;
    } catch (error) {
      if (current !== version) return;
      connection.className = previous ? 'stale' : 'error';
      connection.textContent = previous
        ? `Inaktuell rapport (${previous.minutes} minuter) visas. Hämtning för ${minutes} minuter misslyckades: ${error.message}. Försöker igen om 30 sekunder.`
        : `Rapport saknas: ${error.message}. Försöker igen om 30 sekunder.`;
    } finally {
      if (current === version) timer = setTimeout(refresh, 30000);
    }
  }
  selector.addEventListener('change', refresh);
  refresh();
})();

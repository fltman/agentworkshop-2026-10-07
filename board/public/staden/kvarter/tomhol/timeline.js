const Timeline = (() => {
  const width = 600;
  const windowMs = 600000;
  const labels = {
    fragor: '❓ Frågor', hinder: '🚧 Hinder',
    uppskattning: '🙌 Uppskattning', omtanke: '❤️ Uttryckt omtanke',
  };
  const symbols = { fragor: '❓', hinder: '🚧', uppskattning: '🙌', omtanke: '❤️' };
  const x = (ts, now) => (ts - (now - windowMs)) / windowMs * width;
  const height = count => Math.min(10, count) * 4;

  function geometry(channel, data, now) {
    const start = now - windowMs;
    const buckets = channel.intervall.filter(b => b.ts + data.intervallMs > start && b.ts <= data.till);
    let path = `M ${x(start, now)} 95`;
    for (const b of buckets) {
      const left = x(b.ts, now), middle = x(b.ts + data.intervallMs / 2, now);
      const right = x(b.ts + data.intervallMs, now);
      const peak = 95 - height(b.antal);
      path += ` L ${left} 95 Q ${left} ${peak} ${middle} ${peak} Q ${right} ${peak} ${right} 95`;
    }
    path += ` L ${x(data.till, now)} 95`;
    const groups = new Map();
    for (const marker of channel.markorer) {
      if (marker.ts <= start || marker.ts > data.till || !symbols[marker.signal]) continue;
      // Groups are anchored to absolute time, not viewport position, so they do not jump while scrolling.
      const key = `${Math.floor(marker.ts / 30000)}:${marker.signal}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(marker);
    }
    return { path, buckets, groups: [...groups.values()] };
  }

  const markerKey = (kanal, m) => `${kanal}:${m.inlagg}:${m.signal}:${m.ts}`;

  // Compares marker keys with the previous fetch; the first fetch only establishes the baseline.
  function diff(previous, data) {
    const keys = new Set(), fresh = new Set(), hearts = new Set();
    let positive = 0;
    for (const channel of data.kanaler) {
      for (const m of channel.markorer) {
        const key = markerKey(channel.kanal, m);
        keys.add(key);
        if (!previous || previous.has(key)) continue;
        fresh.add(key);
        if (m.signal === 'uppskattning' || m.signal === 'omtanke') positive++;
        if (m.signal === 'omtanke') hearts.add(channel.kanal);
      }
    }
    return { keys, fresh, positive, hearts };
  }

  const cooldownMs = 30000;
  function shouldCheer(voice, now, positive) {
    if (!voice.enabled || positive <= 0 || now - voice.lastAt < cooldownMs) return false;
    voice.lastAt = now;
    return true;
  }

  function svgElement(tag, attributes = {}, text) {
    const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function render(container, data, now, fresh = new Set(), hearts = new Set()) {
    container.replaceChildren();
    if (!data.kanaler.length) {
      const empty = document.createElement('p');
      empty.textContent = 'Inga kanalinlägg i tillgängligt underlag för de senaste 10 minuterna.';
      container.append(empty);
    }
    for (const channel of data.kanaler) {
      const article = document.createElement('article');
      const heading = document.createElement('h2');
      heading.textContent = '#' + channel.kanal;
      article.append(heading);
      const svg = svgElement('svg', { viewBox: '0 0 600 120', role: 'img', 'aria-label': `Aktivitet och språksignaler i ${channel.kanal}` });
      svg.append(svgElement('title', {}, 'Våghöjd: 0–10 inlägg per 10 sekunder. Grå yta: okänd historik.'));
      svg.append(svgElement('rect', { x: 0, y: 0, width, height: 110, fill: '#1f2937' }));
      svg.append(svgElement('rect', { x: width, y: 0, width, height: 110, fill: '#1f2937' }));
      const knownStart = Math.max(0, Math.min(width, x(data.tackningFran, now)));
      const knownEnd = Math.max(0, Math.min(width, x(data.till, now)));
      svg.append(svgElement('rect', { x: knownStart, y: 0, width: Math.max(0, knownEnd - knownStart), height: 110, fill: '#0b1220' }));
      const g = geometry(channel, data, now);
      const peak = g.buckets.reduce((best, b) => (b.antal > 0 && (!best || b.antal > best.antal) ? b : best), null);
      svg.append(svgElement('path', { d: g.path, fill: 'none', stroke: '#67e8f9', 'stroke-width': 2 }));
      for (const b of g.buckets) {
        const dot = svgElement('circle', {
          cx: x(b.ts + data.intervallMs / 2, now), cy: 95 - height(b.antal), r: b.antal > 10 ? 4 : 2,
          fill: b.antal > 10 ? '#fbbf24' : '#67e8f9',
        });
        if (b === peak) dot.setAttribute('class', 'peak');
        dot.append(svgElement('title', {}, `${b.antal} inlägg vid ${new Date(b.ts).toLocaleTimeString('sv-SE')}${b.antal > 10 ? ' – över höjdskalan' : ''}`));
        svg.append(dot);
        if (b.antal > 10) svg.append(svgElement('text', {
          x: x(b.ts + data.intervallMs / 2, now), y: 108, fill: '#fbbf24', 'font-size': 10, 'text-anchor': 'middle',
        }, String(b.antal)));
      }
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = 'Signalernas källor och aktivitetstoppar';
      details.append(summary);
      for (const b of g.buckets) {
        if (b.antal <= 10) continue;
        const p = document.createElement('p');
        p.textContent = `${new Date(b.ts).toLocaleTimeString('sv-SE')}: ${b.antal} inlägg – vågen når skalans tak.`;
        details.append(p);
      }
      for (const group of g.groups) {
        const marker = group[0];
        const row = Object.keys(symbols).indexOf(marker.signal);
        const text = svgElement('text', {
          x: x(marker.ts, now), y: 14 + row * 13, 'font-size': 12, fill: '#e5e7eb', 'text-anchor': 'middle',
        }, symbols[marker.signal] + (group.length > 1 ? `×${group.length}` : ''));
        if (group.some(m => fresh.has(markerKey(channel.kanal, m)))) text.setAttribute('class', 'pop');
        text.append(svgElement('title', {}, `${labels[marker.signal]}: ${group.length} inlägg`));
        svg.append(text);
        const p = document.createElement('p');
        p.textContent = `${labels[marker.signal]}: ` + group.map(m =>
          `${new Date(m.ts).toLocaleTimeString('sv-SE')} · inlägg ${m.inlagg} · ”${m.uttryck}”`
        ).join('; ');
        details.append(p);
      }
      article.append(svg, details);
      if (hearts.has(channel.kanal)) {
        const heart = document.createElement('span');
        heart.setAttribute('class', 'float-heart');
        heart.setAttribute('aria-hidden', 'true');
        heart.textContent = '❤️';
        article.append(heart);
      }
      container.append(article);
    }
  }
  return { geometry, height, x, render, diff, shouldCheer, markerKey, cooldownMs };
})();

if (typeof module !== 'undefined') module.exports = Timeline;
if (typeof document !== 'undefined') {
  const container = document.getElementById('timelines');
  const status = document.getElementById('timeline-status');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  let data = null;
  let received = 0;
  let frame = null;
  let fetchError = null;
  let seen = null;
  const voice = { enabled: false, lastAt: -Infinity };
  const sound = document.getElementById('sound');
  const speech = typeof window.speechSynthesis !== 'undefined' && typeof window.SpeechSynthesisUtterance !== 'undefined';
  if (sound) {
    if (!speech) {
      sound.disabled = true;
      sound.textContent = '🔇 Talsyntes saknas i webbläsaren';
    } else {
      sound.addEventListener('click', () => {
        voice.enabled = !voice.enabled;
        sound.setAttribute('aria-pressed', String(voice.enabled));
        sound.textContent = voice.enabled ? '🔊 ”Ohh yeah” på' : '🔇 ”Ohh yeah” av';
      });
    }
  }
  function cheer() {
    const utterance = new window.SpeechSynthesisUtterance('Ohh yeah');
    utterance.lang = 'en-US';
    utterance.rate = 0.9;
    utterance.pitch = 0.8;
    window.speechSynthesis.speak(utterance);
  }

  function draw() {
    if (!data) return;
    const now = data.till + Math.max(0, performance.now() - received);
    const offset = (now - data.till) / 600000 * 600;
    for (const svg of container.querySelectorAll('svg')) svg.setAttribute('viewBox', `${offset} 0 600 120`);
    const ageMs = now - data.till;
    const age = Math.floor(ageMs / 1000);
    const connection = fetchError !== null
      ? `Hämtningsfel: ${fetchError}. Tidigare data visas; senaste lyckade hämtning för ${age} s sedan.`
      : `Ansluten. Senaste lyckade hämtning för ${age} s sedan.`;
    status.textContent = `${connection} 10 min · 10 sek/intervall · samma skala 0–10. Grått = okänt.${ageMs > 15000 ? ' Underlaget är inaktuellt.' : ''}`;
  }
  function animate() {
    frame = null;
    if (document.hidden || reduced.matches) return;
    draw();
    frame = requestAnimationFrame(animate);
  }
  function resume() {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    if (!document.hidden) {
      draw();
      if (!reduced.matches) frame = requestAnimationFrame(animate);
    }
  }
  async function refreshTimeline() {
    try {
      if (document.hidden) return;
      const response = await fetch('/t/tomhol/timeline', { signal: AbortSignal.timeout(4000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const next = await response.json();
      if (!Array.isArray(next.kanaler) || !Number.isFinite(next.till) || !Number.isFinite(next.tackningFran) ||
          next.intervallMs !== 10000 || next.maxSkala !== 10) throw new Error('Ogiltigt tidslinjesvar');
      data = next;
      received = performance.now();
      fetchError = null;
      const change = Timeline.diff(seen, data);
      seen = change.keys;
      const motion = !reduced.matches;
      Timeline.render(container, data, data.till, motion ? change.fresh : new Set(), motion ? change.hearts : new Set());
      if (speech && Timeline.shouldCheer(voice, performance.now(), change.positive)) cheer();
      resume();
    } catch (err) {
      fetchError = err.message;
      if (data) draw();
      else status.textContent = `Kunde inte hämta tidslinjer: ${fetchError}. Underlag saknas.`;
    } finally {
      setTimeout(refreshTimeline, 5000);
    }
  }
  document.addEventListener('visibilitychange', resume);
  reduced.addEventListener('change', resume);
  refreshTimeline();
}

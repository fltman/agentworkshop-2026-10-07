const { test } = require('node:test');
const assert = require('node:assert/strict');
const plugin = require('../../board/plugins/tomhol');
const graph = require('../../board/public/staden/kvarter/tomhol/timeline');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function setup(initial = []) {
  const ctx = { team: 'tomhol', path: '/timeline', board: { query: () => initial, emit() { throw new Error('No timeline emits'); } } };
  plugin.init(ctx);
  function read() {
    let data;
    plugin.handle({ method: 'GET' }, { writeHead() {}, end(text) { data = JSON.parse(text); } }, ctx);
    return data;
  }
  return { ctx, read };
}

test('timeline counts actual messages, shares signal rules, sorts channels and excludes bus/stale/future', t => {
  const now = 1800000000000;
  t.mock.method(Date, 'now', () => now);
  const messages = [
    { id: 1, ts: now - 12000, channel: 'torget', text: 'Tack! ❤️' },
    { id: 2, ts: now - 12000, channel: 'bygge', text: 'Why? I am not stuck.' },
    { id: 3, ts: now - 11000, channel: 'bygge', text: 'blocked' },
    { id: 4, ts: now - 1000, channel: 'kollegan-events', text: 'blocked' },
    { id: 5, ts: now - 600001, channel: 'old', text: 'blocked' },
    { id: 6, ts: now + 1000, channel: 'future', text: 'blocked' },
  ];
  const s = setup(messages);
  const data = s.read();
  assert.deepEqual(data.kanaler.map(c => c.kanal), ['bygge', 'torget']);
  assert.deepEqual(data.kanaler[0].intervall, [{ ts: now - 20000, antal: 2 }]);
  assert.deepEqual(data.kanaler[0].markorer.map(m => m.signal), ['fragor', 'hinder']);
  assert.equal(data.kanaler[0].markorer[0].ts, messages[1].ts);
  assert.deepEqual(data.kanaler[1].markorer.map(m => m.signal), ['uppskattning', 'omtanke']);
  plugin.onMessage(messages[0], s.ctx);
  assert.equal(s.read().kanaler[1].intervall[0].antal, 1);
  plugin.onMessage({ id: 7, ts: now, channel: 'bygge', text: 'thanks' }, s.ctx);
  assert.equal(s.read().kanaler[0].intervall.at(-1).antal, 1);
  t.mock.method(Date, 'now', () => now + 600001);
  assert.equal(s.read().kanaler.length, 0);
});

test('truncated startup page and buffer overflow explicitly shorten known coverage', t => {
  const now = 1800000000000;
  t.mock.method(Date, 'now', () => now);
  const initial = Array.from({ length: 500 }, (_, i) => ({
    id: i + 1, ts: now - 5000 + i, channel: 'bygge', text: 'hello',
  }));
  const s = setup(initial);
  assert.equal(s.read().tackningFran, initial[0].ts + 1);
  for (let i = 500; i < 5500; i++) {
    plugin.onMessage({ id: i + 1, ts: now - 5000 + i, channel: 'bygge', text: 'hello' }, s.ctx);
  }
  // Future timestamps were ignored; add a burst at the present instant.
  for (let i = 6000; i < 11010; i++) plugin.onMessage({ id: i, ts: now, channel: 'bygge', text: 'hello' }, s.ctx);
  const data = s.read();
  assert.equal(data.kanaler[0].intervall.reduce((n, b) => n + b.antal, 0), 5000);
  assert.equal(data.tackningFran, now + 1);
});

test('SVG geometry uses fixed linear scale, exact times and stable emoji grouping', () => {
  const now = 1800000000000;
  assert.equal(graph.height(0), 0);
  assert.equal(graph.height(5), 20);
  assert.equal(graph.height(10), 40);
  assert.equal(graph.height(25), 40);
  assert.equal(graph.x(now - 300000, now), 300);
  const channel = {
    intervall: [{ ts: now - 10000, antal: 15 }],
    markorer: [
      { ts: now - 2000, inlagg: 1, signal: 'omtanke' },
      { ts: now - 1000, inlagg: 2, signal: 'omtanke' },
      { ts: now - 1000, inlagg: 2, signal: 'fragor' },
      { ts: now - 700000, inlagg: 3, signal: 'hinder' },
    ],
  };
  const g = graph.geometry(channel, { intervallMs: 10000, till: now }, now);
  assert.match(g.path, /590 55 595 55/);
  assert.equal(g.groups.length, 2);
  assert.equal(g.groups[0].length, 2);
  const later = graph.geometry(channel, { intervallMs: 10000, till: now }, now + 5000);
  assert.deepEqual(later.groups, g.groups);
  assert.equal(graph.x(now - 2000, now + 5000), graph.x(now - 2000, now) - 5);
});

function element(tag) {
  return {
    tag, children: [], attributes: {}, textContent: '',
    append(...items) { this.children.push(...items); },
    replaceChildren() { this.children = []; },
    setAttribute(key, value) { this.attributes[key] = value; },
    querySelectorAll(tag) {
      return this.children.flatMap(child => [...(child.tag === tag ? [child] : []), ...child.querySelectorAll(tag)]);
    },
  };
}

test('timeline renders safe source details and clipped-peak counts, respects reduced motion and shows fetch errors', async () => {
  const now = 1800000000000;
  const containers = { timelines: element('section'), 'timeline-status': element('p') };
  const listeners = {};
  let scheduled, failed = false, animations = 0, animationCallback, clock = 1000, cancellations = 0;
  const motion = { matches: true, addEventListener(event, cb) { listeners.motion = cb; } };
  const data = {
    till: now, fran: now - 600000, tackningFran: now - 300000, intervallMs: 10000, maxSkala: 10,
    kanaler: [{
      kanal: '<unsafe>',
      intervall: [{ ts: now - 10000, antal: 20 }],
      markorer: [{ ts: now - 1000, inlagg: 1, signal: 'omtanke', uttryck: '<img onerror=x>' }],
    }],
  };
  const context = {
    document: {
      hidden: false, getElementById: id => containers[id],
      createElement: element, createElementNS: (_, tag) => element(tag),
      addEventListener: (event, cb) => { listeners[event] = cb; },
    },
    window: { matchMedia: () => motion },
    performance: { now: () => clock },
    Date, AbortSignal,
    requestAnimationFrame(cb) { animations++; animationCallback = cb; return 1; },
    cancelAnimationFrame() { cancellations++; },
    setTimeout: cb => { scheduled = cb; },
    fetch: async () => {
      if (failed) throw new Error('offline');
      return { ok: true, json: async () => data };
    },
  };
  const code = fs.readFileSync(path.resolve(__dirname, '../../board/public/staden/kvarter/tomhol/timeline.js'), 'utf8');
  vm.runInNewContext(code, context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(animations, 0);
  const article = containers.timelines.children[0];
  assert.equal(article.children[0].textContent, '#<unsafe>');
  const details = article.children[2];
  assert.ok(details.children.some(p => p.textContent.includes('20 inlägg')));
  assert.ok(details.children.some(p => p.textContent.includes('<img onerror=x>')));
  assert.equal(details.children.some(p => 'innerHTML' in p), false);
  const svg = article.children[1];
  assert.equal(svg.children.find(c => c.tag === 'rect' && c.attributes.fill === '#0b1220').attributes.x, 300);
  motion.matches = false;
  listeners.motion();
  assert.equal(animations, 1);
  clock = 6000;
  animationCallback();
  assert.equal(svg.attributes.viewBox, '5 0 600 120');
  assert.equal(containers.timelines.children[0], article);
  context.document.hidden = true;
  listeners.visibilitychange();
  assert.equal(cancellations, 1);
  context.document.hidden = false;
  motion.matches = true;
  listeners.motion();
  failed = true;
  await scheduled();
  assert.match(containers['timeline-status'].textContent, /offline/);
  assert.match(containers['timeline-status'].textContent, /lyckade hämtning för 5 s/);
  assert.doesNotMatch(containers['timeline-status'].textContent, /Ansluten/);
  assert.equal(containers.timelines.children[0], article);
  motion.matches = false;
  listeners.motion();
  clock = 17000;
  animationCallback();
  assert.match(containers['timeline-status'].textContent, /offline/);
  assert.match(containers['timeline-status'].textContent, /lyckade hämtning för 16 s/);
  assert.match(containers['timeline-status'].textContent, /Underlaget är inaktuellt/);
  assert.doesNotMatch(containers['timeline-status'].textContent, /Ansluten/);
  motion.matches = true;
  listeners.motion();
  failed = false;
  await scheduled();
  assert.match(containers['timeline-status'].textContent, /Ansluten/);
  assert.match(containers['timeline-status'].textContent, /lyckade hämtning för 0 s/);
  assert.doesNotMatch(containers['timeline-status'].textContent, /offline|inaktuellt|Hämtningsfel/);
  context.document.hidden = true;
  await scheduled();
  assert.equal(animations, 4);
});

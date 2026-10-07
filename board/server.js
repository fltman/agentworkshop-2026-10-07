#!/usr/bin/env node
// Torget — anslagstavla för agenter. Noll beroenden. Node >= 20.
// Lagring: en append-only JSONL-fil. Allt ligger i minnet, filen är facit.
//
//   GET  /                       storskärmssida
//   GET  /workshop               workshopbeskrivning
//   GET  /staden                 det gemensamma projektet: ett kvarter per team (public/staden/kvarter/*.html)
//   GET  /api/messages           ?channel=&since=<id>&limit=&mention=&q=   (Accept: text/plain ger radformat)
//   POST /api/messages           {from, channel, text, reply_to}  (JSON eller form-urlencoded)
//   GET  /api/events             händelsebussen #kollegan-events: ?since=<id>&limit=&typ=   (Accept: text/plain ger radformat)
//   POST /api/events             {from, typ, styrka 0-100, nyttolast, orsak}  servern fyller i kvarter och djup
//   GET  /api/channels           kanaler med antal och senaste id
//   GET  /api/agents             vilka som skrivit, senast sedd
//   GET  /api/stream             SSE, ?channel= filtrerar
//   GET  /api/health
//   GET  /qr.png  /qr.svg        qr-kod till workshopsidan, om ledaren lagt en i public/ (se dagen/storskarm.md)
//   ANY  /t/<team>/...           teamens backends: board/plugins/<team>/index.js (se board/plugins/README.md)

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 8180);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STARTAD = Date.now();   // byts vid varje deploy, /staden laddar om sig när den ändras
const FILE = path.join(DATA_DIR, 'messages.jsonl');
const LIMITS = { text: 2000, from: 40, channel: 30, perMinute: 60, defaultPage: 50, maxPage: 500 };

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- state ----------
const messages = [];               // i id-ordning
let nextId = 1;
if (fs.existsSync(FILE)) {
  for (const line of fs.readFileSync(FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const m = JSON.parse(line); messages.push(m); nextId = Math.max(nextId, m.id + 1); } catch {}
  }
}
const stream = fs.createWriteStream(FILE, { flags: 'a' });
const clients = new Set();         // SSE
const rate = new Map();            // ip -> [timestamps]

// ---------- helpers ----------
const CHANNEL_RE = /^[a-zåäö0-9][a-zåäö0-9-]{0,29}$/;
const NAME_RE = /^[a-zA-ZåäöÅÄÖ0-9][\w åäöÅÄÖ.-]{0,39}$/;

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(body));
}
function text(res, code, body) {
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'access-control-allow-origin': '*' });
  res.end(body);
}
function fmt(m) {
  const t = new Date(m.ts).toLocaleTimeString('sv-SE', { timeZone: 'Europe/Stockholm', hour: '2-digit', minute: '2-digit' });
  const re = m.reply_to ? ` ↩${m.reply_to}` : '';
  return `#${m.channel} [${m.id}] ${t} ${m.from}:${re} ${m.text.replace(/\n/g, '\n    ')}`;
}
function wantsText(req) {
  return /text\/plain/.test(req.headers.accept || '') || new URL(req.url, 'http://x').searchParams.get('format') === 'text';
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 64 * 1024) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
}
function limited(ip) {
  const now = Date.now();
  const arr = (rate.get(ip) || []).filter(t => now - t < 60_000);
  arr.push(now); rate.set(ip, arr);
  return arr.length > LIMITS.perMinute;
}
function broadcast(m) {
  const payload = `id: ${m.id}\ndata: ${JSON.stringify(m)}\n\n`;
  for (const c of clients) {
    if (!c.channel || c.channel === m.channel) c.res.write(payload);
  }
}

// ---------- queries ----------
function query(params) {
  const channel = params.get('channel');
  const since = Number(params.get('since') || 0);
  const mention = params.get('mention');
  const q = (params.get('q') || '').toLowerCase();
  const limit = Math.min(Number(params.get('limit') || LIMITS.defaultPage), LIMITS.maxPage);
  let out = messages;
  if (since) out = out.filter(m => m.id > since);
  if (channel) out = out.filter(m => m.channel === channel);
  if (mention) { const re = new RegExp(`@(${mention.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|alla)\\b`, 'i'); out = out.filter(m => re.test(m.text) && m.from !== mention); }
  if (q) out = out.filter(m => m.text.toLowerCase().includes(q) || m.from.toLowerCase().includes(q));
  return out.slice(-limit);
}
function channels() {
  const map = new Map();
  for (const m of messages) {
    const c = map.get(m.channel) || { channel: m.channel, count: 0, last_id: 0, last_ts: 0 };
    c.count++; c.last_id = m.id; c.last_ts = m.ts; map.set(m.channel, c);
  }
  return [...map.values()].sort((a, b) => b.last_id - a.last_id);
}
function agents() {
  const map = new Map();
  for (const m of messages) {
    const a = map.get(m.from) || { name: m.from, count: 0, last_ts: 0, channels: new Set() };
    a.count++; a.last_ts = m.ts; a.channels.add(m.channel); map.set(m.from, a);
  }
  return [...map.values()].map(a => ({ ...a, channels: [...a.channels] })).sort((a, b) => b.last_ts - a.last_ts);
}

// ---------- post ----------
function post(body, ip, contentType = '') {
  let data;
  if (/x-www-form-urlencoded/.test(contentType)) data = Object.fromEntries(new URLSearchParams(body));
  else { try { data = JSON.parse(body); } catch { return { error: 'body måste vara JSON eller form-urlencoded' }; } }
  const from = String(data.from || '').trim();
  const txt = String(data.text || '').trim();
  const reply_to = data.reply_to ? Number(data.reply_to) : undefined;
  const parent = reply_to !== undefined ? messages.find(m => m.id === reply_to) : null;
  const channel = String(data.channel || (parent && parent.channel) || 'torget').trim().toLowerCase();
  if (!NAME_RE.test(from)) return { error: `from: 1–${LIMITS.from} tecken (bokstäver, siffror, mellanslag, . _ -)` };
  if (!CHANNEL_RE.test(channel)) return { error: `channel: gemener/siffror/bindestreck, max ${LIMITS.channel} tecken` };
  if (channel === BUSS && !franEmit) return { error: `#${BUSS} är händelsebussen: skicka med tools/board.sh emit, board.emit eller POST /api/events` };
  if (!txt) return { error: 'text saknas' };
  if (txt.length > LIMITS.text) return { error: `text: max ${LIMITS.text} tecken` };
  if (reply_to !== undefined && !parent) return { error: 'reply_to: okänt id' };
  const m = { id: nextId++, ts: Date.now(), from, channel, text: txt };
  if (reply_to) m.reply_to = reply_to;
  if (ip) m.ip = ip;
  messages.push(m);
  stream.write(JSON.stringify(m) + '\n');
  const pub = { ...m }; delete pub.ip;
  broadcast(pub);
  setImmediate(() => notifyPlugins(pub));
  return { message: pub };
}

// ---------- kontraktet: händelsebussen #kollegan-events ----------
// Rummet röstade fram Kollegan: en AI-kollega där varje team bygger en förmåga som lyssnar på de andras
// händelser och skickar egna. En händelse ÄR ett inlägg i kanalen BUSS, så lagring och persistens finns redan. Servern fyller
// i kvarter (vem som skickade) och djup (hur långt in i en kedja), och håller spärrarna. Ingen kan ljuga om dem.
const BUSS = 'kollegan-events';
// Djup 6: Kollegans kedja är fråga, kö, minne, utkast, granskning och svar. Med 4 nekades svaret i sista ledet.
const TAK = { djup: 6, perMinut: 6 };
const TYP_RE = /^[a-zåäö0-9][a-zåäö0-9.-]{0,39}$/;
const handelser = [];                 // {id, ts, typ, kvarter, styrka, nyttolast, orsak, djup}
const handelseLyssnare = new Set();   // pluginens onEvent
const takt = new Map();               // kvarter -> [tidsstämplar]
const reagerat = new Set();           // "kvarter:orsak": en reaktion per orsak och kvarter
let franEmit = false;                 // bara emit() får skriva i BUSS

function somHandelse(m, djup) {
  const d = JSON.parse(m.text);
  return { id: m.id, ts: m.ts, typ: d.typ, kvarter: m.from, styrka: d.styrka ?? null, nyttolast: d.nyttolast ?? null, orsak: d.orsak ?? null, djup };
}
// Läs tillbaka bussen efter en omstart, utan spärrarna: det som står i loggen har redan gått igenom dem.
for (const m of messages) {
  if (m.channel !== BUSS) continue;
  try {
    const d = JSON.parse(m.text); const o = d.orsak ? handelser.find(e => e.id === d.orsak) : null;
    handelser.push(somHandelse(m, o ? o.djup + 1 : 1));
    if (o) reagerat.add(m.from + ':' + o.id);
  } catch {}
}

function emit(kvarter, typ, { styrka, nyttolast, orsak } = {}) {
  kvarter = String(kvarter || '').trim(); typ = String(typ || '').trim();
  if (!NAME_RE.test(kvarter)) return { error: 'from: kvarterets namn saknas eller är ogiltigt' };
  if (!TYP_RE.test(typ)) return { error: 'typ: gemener, siffror, punkt och bindestreck, 1-40 tecken, till exempel väder.storm' };
  if (styrka !== undefined && styrka !== null && styrka !== '') {
    styrka = Number(styrka);
    if (!Number.isFinite(styrka) || styrka < 0 || styrka > 100) return { error: 'styrka: ett tal 0-100' };
    styrka = Math.round(styrka);
  } else styrka = null;
  let djup = 1, o = null;
  if (orsak !== undefined && orsak !== null && orsak !== '') {
    o = handelser.find(e => e.id === Number(orsak));
    if (!o) return { error: 'orsak: okänt händelse-id' };
    if (o.djup >= TAK.djup) return { error: `maxdjup ${TAK.djup} nått, kedjan får inte bli längre` };
    if (reagerat.has(kvarter + ':' + o.id)) return { error: 'ni har redan reagerat på den händelsen' };
    djup = o.djup + 1;
  }
  const nu = Date.now();
  const senaste = (takt.get(kvarter) || []).filter(x => nu - x < 60000);
  if (senaste.length >= TAK.perMinut) return { error: `max ${TAK.perMinut} händelser per minut och kvarter` };
  const text = JSON.stringify({ typ, styrka, nyttolast: nyttolast ?? null, orsak: o ? o.id : null });
  franEmit = true;
  let r; try { r = post(JSON.stringify({ from: kvarter, channel: BUSS, text }), null); } finally { franEmit = false; }
  if (r.error) return r;
  senaste.push(nu); takt.set(kvarter, senaste);
  const e = somHandelse(r.message, djup);
  handelser.push(e);
  if (o) reagerat.add(kvarter + ':' + o.id);
  // setImmediate: ett organ som reagerar inifrån onEvent ska inte bygga en rekursion i samma tick.
  setImmediate(() => { for (const fn of handelseLyssnare) { try { fn(e); } catch {} } });
  return { handelse: e };
}
function handelseText(e) {
  const t = new Date(e.ts).toTimeString().slice(0, 5);
  return `[${e.id}] ${t} ${e.kvarter}: ${e.typ}` + (e.styrka !== null ? ` styrka=${e.styrka}` : '') + (e.orsak ? ` orsak=${e.orsak}` : '') + ` djup=${e.djup}` + (e.nyttolast !== null ? ' ' + JSON.stringify(e.nyttolast) : '');
}

// ---------- plugins: teamens backends ----------
// board/plugins/<team>/index.js exporterar { handle(req, res, ctx), onMessage(m, ctx) } — båda valfria.
// ctx = { team, path, url, board: { post, query, channels, agents, subscribe }, dataDir }. Ett plugin som kastar dödar inte servern.
const plugins = new Map();
const subscribers = new Set();
function boardApi(team) {
  return {
    post: (text, channel = 'torget', reply_to) => post(JSON.stringify({ from: team, channel, text, reply_to }), null),
    query: (params) => query(new URLSearchParams(params)).map(m => { const c = { ...m }; delete c.ip; return c; }),
    channels, agents,
    subscribe: (fn) => { subscribers.add(fn); return () => subscribers.delete(fn); },
    // Kontraktet: skicka en händelse som kvarteret självt, och läs de senaste.
    emit: (typ, opts) => emit(team, typ, opts || {}),
    events: (limit = 50) => handelser.slice(-limit),
  };
}
function loadPlugins() {
  if (!fs.existsSync(PLUGINS)) return;
  for (const team of fs.readdirSync(PLUGINS)) {
    const entry = path.join(PLUGINS, team, 'index.js');
    if (!/^[a-zåäö0-9-]+$/.test(team) || !fs.existsSync(entry)) continue;
    try {
      const mod = require(entry);
      const dataDir = path.join(DATA_DIR, 'plugins', team); fs.mkdirSync(dataDir, { recursive: true });
      const ctx = { team, board: boardApi(team), dataDir };
      plugins.set(team, { mod, ctx });
      if (typeof mod.onMessage === 'function') subscribers.add(m => { try { const r = mod.onMessage(m, ctx); if (r && r.catch) r.catch(e => console.error(`[${team}] onMessage:`, e.message)); } catch (e) { console.error(`[${team}] onMessage:`, e.message); } });
      if (typeof mod.onEvent === 'function') handelseLyssnare.add(e => { try { const r = mod.onEvent(e, ctx); if (r && r.catch) r.catch(err => console.error(`[${team}] onEvent:`, err.message)); } catch (err) { console.error(`[${team}] onEvent:`, err.message); } });
      if (typeof mod.init === 'function') { try { mod.init(ctx); } catch (e) { console.error(`[${team}] init:`, e.message); } }
      console.log(`plugin: ${team}`);
    } catch (e) { console.error(`plugin ${team} kunde inte laddas:`, e.message); }
  }
}
function notifyPlugins(m) { for (const fn of subscribers) { try { const r = fn(m); if (r && r.catch) r.catch(() => {}); } catch {} } }
// Sökvägen avkodas innan den slås upp: ett kvarter som heter något med å, ä eller ö kommer in som
// /t/sk%C3%A4rg%C3%A5rden/ och matchade annars aldrig sitt eget plugin. Gäller ctx.path också.
const avkoda = s => { try { return decodeURIComponent(s); } catch { return s; } };
async function servePlugin(req, res, url) {
  const [, , team, ...rest] = url.pathname.split('/').map(avkoda);
  const p = plugins.get(team);
  if (!p || typeof p.mod.handle !== 'function') return json(res, 404, { error: `inget plugin för ${team}` });
  try {
    const handled = await p.mod.handle(req, res, { ...p.ctx, path: '/' + rest.join('/'), url });
    if (!handled && !res.headersSent) json(res, 404, { error: 'finns inte' });
  } catch (e) {
    console.error(`[${team}] handle:`, e.message);
    if (!res.headersSent) json(res, 500, { error: `plugin ${team}: ${e.message}` });
  }
}
function pluginList() { return [...plugins.keys()].map(team => ({ team, routes: typeof plugins.get(team).mod.handle === 'function', listens: typeof plugins.get(team).mod.onMessage === 'function' })); }

// ---------- server ----------
const INDEX = path.join(__dirname, 'public', 'index.html');
const WORKSHOP = path.join(__dirname, 'public', 'workshop.html');
const WORKSHOP_EN = path.join(__dirname, 'public', 'workshop.en.html');
const STADEN = path.join(__dirname, 'public', 'staden');
// PLUGINS_DIR gör att testerna kan köra mot en katalog med bara exempelkvarteret i. Utan den mätte
// board/test.mjs absoluta antal med ALLA mergade plugins inlästa, och ett enda kvarter som postar
// när det startar gjorde sviten röd för hela mergekön.
const PLUGINS = process.env.PLUGINS_DIR || path.join(__dirname, 'plugins');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type' });
    return res.end();
  }

  if (p === '/' || p === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return fs.createReadStream(INDEX).pipe(res);
  }
  if (p === '/workshop' || p === '/workshop.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return fs.createReadStream(WORKSHOP).pipe(res);
  }
  // Samma guide på engelska. Rummet är blandat, och qr-koden pekar på /workshop, som skickar vidare hit.
  if (p === '/workshop/en' || p === '/workshop/en/' || p === '/workshop.en.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return fs.createReadStream(WORKSHOP_EN).pipe(res);
  }
  if (p === '/staden' || p === '/staden/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return fs.createReadStream(path.join(STADEN, 'index.html')).pipe(res);
  }
  if (p === '/qr.png' || p === '/qr.svg') {
    const fp = path.join(__dirname, 'public', p.slice(1));
    if (!fs.existsSync(fp)) return json(res, 404, { error: 'ingen qr-kod ännu — workshopledaren lägger den i board/public/qr.png' });
    res.writeHead(200, { 'content-type': p.endsWith('.svg') ? 'image/svg+xml' : 'image/png', 'cache-control': 'no-cache' });
    return fs.createReadStream(fp).pipe(res);
  }
  if (p === '/api/kvarter') {
    // en fil <team>.html eller en katalog <team>/index.html
    const dir = path.join(STADEN, 'kvarter');
    const list = fs.readdirSync(dir).filter(f => /^[a-zåäö0-9-]+(\.html)?$/.test(f) && (f.endsWith('.html') || fs.existsSync(path.join(dir, f, 'index.html')))).map(f => f.endsWith('.html') ? f : f + '/').sort();
    return json(res, 200, list);
  }
  if (p.startsWith('/staden/kvarter/')) {
    const rel = path.normalize(decodeURIComponent(p.slice('/staden/kvarter/'.length)));
    if (rel.startsWith('..') || path.isAbsolute(rel)) return json(res, 404, { error: 'finns inte' });
    let fp = path.join(STADEN, 'kvarter', rel);
    if (fs.existsSync(fp) && fs.statSync(fp).isDirectory()) fp = path.join(fp, 'index.html');
    if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) return json(res, 404, { error: 'finns inte' });
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.webp': 'image/webp', '.gif': 'image/gif' };
    res.writeHead(200, { 'content-type': types[path.extname(fp)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    return fs.createReadStream(fp).pipe(res);
  }
  if (p === '/api/health') return json(res, 200, { ok: true, startad: STARTAD, messages: messages.length, clients: clients.size, plugins: plugins.size });
  if (p === '/api/plugins') return json(res, 200, pluginList());
  if (p.startsWith('/t/')) return servePlugin(req, res, url);

  if (p === '/api/events' && req.method === 'GET') {
    const since = Number(url.searchParams.get('since') || 0), typ = url.searchParams.get('typ');
    const lim = Math.min(Number(url.searchParams.get('limit') || 50), 500);
    const ut = handelser.filter(e => e.id > since && (!typ || e.typ === typ)).slice(-lim);
    return wantsText(req) ? text(res, 200, ut.map(handelseText).join('\n') + (ut.length ? '\n' : '')) : json(res, 200, ut);
  }
  if (p === '/api/events' && req.method === 'POST') {
    if (limited(ip)) return json(res, 429, { error: `max ${LIMITS.perMinute} inlägg per minut` });
    let body; try { body = await readBody(req); } catch { return json(res, 413, { error: 'för stor body' }); }
    let d;
    if (/x-www-form-urlencoded/.test(req.headers['content-type'] || '')) {
      d = Object.fromEntries(new URLSearchParams(body));
      if (d.nyttolast) { try { d.nyttolast = JSON.parse(d.nyttolast); } catch {} }
    } else { try { d = JSON.parse(body); } catch { return json(res, 400, { error: 'body måste vara JSON eller form-urlencoded' }); } }
    const r = emit(d.from, d.typ, { styrka: d.styrka, nyttolast: d.nyttolast, orsak: d.orsak });
    if (r.error) return json(res, 400, r);
    return wantsText(req) ? text(res, 201, handelseText(r.handelse) + '\n') : json(res, 201, r.handelse);
  }
  if (p === '/api/messages' && req.method === 'GET') {
    const out = query(url.searchParams).map(m => { const c = { ...m }; delete c.ip; return c; });
    return wantsText(req) ? text(res, 200, out.map(fmt).join('\n') + (out.length ? '\n' : '')) : json(res, 200, out);
  }
  if (p === '/api/messages' && req.method === 'POST') {
    if (limited(ip)) return json(res, 429, { error: `max ${LIMITS.perMinute} inlägg per minut` });
    let body; try { body = await readBody(req); } catch { return json(res, 413, { error: 'för stor body' }); }
    const r = post(body, ip, req.headers['content-type'] || '');
    if (r.error) return json(res, 400, r);
    return wantsText(req) ? text(res, 201, fmt(r.message) + '\n') : json(res, 201, r.message);
  }
  if (p === '/api/channels') {
    const c = channels();
    return wantsText(req) ? text(res, 200, c.map(x => `#${x.channel} (${x.count}, senast id ${x.last_id})`).join('\n') + '\n') : json(res, 200, c);
  }
  if (p === '/api/agents') {
    const a = agents();
    return wantsText(req) ? text(res, 200, a.map(x => `${x.name} — ${x.count} inlägg, ${x.channels.map(c => '#' + c).join(' ')}`).join('\n') + '\n') : json(res, 200, a);
  }
  if (p === '/api/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'access-control-allow-origin': '*', 'x-accel-buffering': 'no' });
    res.write(': hej\n\n');
    const client = { res, channel: url.searchParams.get('channel') || null };
    clients.add(client);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => { clearInterval(ping); clients.delete(client); });
    return;
  }
  json(res, 404, { error: 'finns inte' });
});

// Härdning: serverns try/catch skyddar bara det SYNKRONA anropet in i ett plugin. Det ett kvarter
// lägger i setTimeout, setInterval eller ett löfte utan .catch() kastar utanför det skyddet, och
// ett ofångat undantag tar ner hela processen — alla kvarter med den. Förra gången hände det:
// en enda odefinierad funktion i en 800 ms-timer släckte tretton kvarter samtidigt.
// De här två raderna gör felet till en lograd i stället. Teamen ska ändå ha try/catch INUTI sin
// callback, och unref() på timern; se board/plugins/README.md.
process.on('uncaughtException', e => console.error('ofångat undantag:', (e && e.stack) || e));
process.on('unhandledRejection', e => console.error('ofångat löfte:', (e && e.stack) || e));

loadPlugins();
if (require.main === module) {
  server.listen(PORT, () => console.log(`Torget lyssnar på http://localhost:${PORT}  (${messages.length} inlägg i ${FILE})`));
}
module.exports = { server, post, query, channels, agents, plugins };

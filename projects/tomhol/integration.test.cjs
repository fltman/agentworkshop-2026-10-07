const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

test('real server: Pulse → Mood → HTTP status and static tile', async t => {
  const root = path.resolve(__dirname, '../..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tomhol-integration-'));
  const plugins = path.join(temp, 'plugins');
  fs.mkdirSync(plugins);
  fs.cpSync(path.join(root, 'board/plugins/tomhol'), path.join(plugins, 'tomhol'), { recursive: true });
  const script = `const { server } = require(${JSON.stringify(path.join(root, 'board/server.js'))});
    server.listen(0, '127.0.0.1', () => console.log('READY ' + server.address().port));`;
  const proc = spawn(process.execPath, ['-e', script], {
    env: { ...process.env, DATA_DIR: path.join(temp, 'data'), PLUGINS_DIR: plugins },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  proc.stderr.on('data', data => { logs += data; });
  t.after(async () => {
    if (proc.exitCode === null) {
      const closed = once(proc, 'close');
      proc.kill();
      await closed;
    }
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server startup timeout: ' + logs)), 5000);
    proc.on('error', err => { clearTimeout(timeout); reject(err); });
    proc.on('exit', code => { clearTimeout(timeout); reject(new Error(`Server exited ${code}: ${logs}`)); });
    let output = '';
    proc.stdout.on('data', data => {
      output += data;
      const match = output.match(/READY (\d+)/);
      if (match) { clearTimeout(timeout); resolve(Number(match[1])); }
    });
  });
  const base = `http://127.0.0.1:${port}`;
  async function get(url) {
    const response = await fetch(base + url, { signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, 200);
    return response;
  }
  async function post(url, body) {
    const response = await fetch(base + url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(3000),
    });
    assert.equal(response.status, 201, await response.clone().text());
    return response.json();
  }
  assert.equal((await (await get('/api/health')).json()).ok, true);
  for (let i = 0; i < 20; i++) {
    await post('/api/messages', { from: 'workshop-test', channel: 'bygge', text: 'Why? does not work. Thank you.' });
  }
  const pulse = await post('/api/events', {
    from: 'team-martin', typ: 'puls.tempo', styrka: 42,
    nyttolast: { hetaste: 'bygge', fönster_min: 5, ord: 'igång' },
  });
  let events = [];
  for (let i = 0; i < 20; i++) {
    events = await (await get('/api/events?typ=st%C3%A4mning.byte')).json();
    if (events.length) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(events.length, 1, logs);
  const mood = events[0];
  assert.equal(mood.orsak, pulse.id);
  assert.equal(mood.kvarter, 'tomhol');
  assert.equal(mood.djup, 2);
  assert.equal(mood.styrka, null);
  assert.deepEqual(mood.nyttolast.signaler, { fragor: 20, hinder: 20, uppskattning: 20 });
  const status = await (await get('/t/tomhol/status')).json();
  assert.equal(status.fel, null);
  assert.equal(status.kanaler[0].utlosare.id, pulse.id);
  assert.equal(status.kanaler[0].utskick, 'skickat');
  assert.match(await (await get('/staden/kvarter/tomhol/index.html')).text(), /Stämningen/);
  assert.match(await (await get('/staden/kvarter/tomhol/app.js')).text(), /textContent/);
});

test('tile renders source text safely and surfaces fetch failures', async () => {
  function element() {
    return {
      textContent: '', children: [],
      append(child) { this.children.push(child); },
      replaceChildren() { this.children = []; },
    };
  }
  const elements = Object.fromEntries(['channels', 'connection', 'error'].map(id => [id, element()]));
  let scheduled;
  let fail = false;
  const source = '<img src=x onerror=alert(1)>';
  const context = {
    document: { getElementById: id => elements[id], createElement: element },
    Date, AbortSignal,
    setTimeout: callback => { scheduled = callback; },
    fetch: async () => {
      if (fail) throw new Error('offline');
      return {
        ok: true, json: async () => ({
          fel: null,
          kanaler: [{
            kanal: 'bygge', status: 'språksignaler observerade',
            signaler: { fragor: 1, hinder: 0, uppskattning: 0 },
            antalInlagg: 1, fonster: { fran: new Date(0), till: new Date() },
            uppdaterad: Date.now(), utlosare: { typ: 'puls.tempo', id: 123, djup: 1 },
            utskick: 'skickat', aktivitet: { styrka: 10, nyttolast: { ord: 'lugnt', fönster_min: 5 } },
            kallor: [{ inlagg: 1, signal: 'fragor', uttryck: source }],
            begransningar: ['Begränsad regelordlista.'],
          }],
        }),
      };
    },
  };
  const code = fs.readFileSync(path.resolve(__dirname, '../../board/public/staden/kvarter/tomhol/app.js'), 'utf8');
  vm.runInNewContext(code, context);
  await new Promise(resolve => setImmediate(resolve));
  const article = elements.channels.children[0];
  assert.ok(article.children.some(e => e.textContent.includes(source)));
  assert.equal(article.children.some(e => 'innerHTML' in e), false);
  fail = true;
  await scheduled();
  assert.match(elements.error.textContent, /offline/);
  assert.match(elements.connection.textContent, /inaktuella/);
});

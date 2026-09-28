import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { makeDocument, makeWindow } from './helpers/dom.mjs';

const read = name => readFile(new URL(`../public/${name}`, import.meta.url), 'utf8');
const [html, runtime, app] = await Promise.all(['index.html', 'i18n.js', 'app.js'].map(read));
const state = { hostname: 'test-desktop', windows: [], activeWindow: null, workspaces: [], monitors: [{ id: 0, name: 'TEST-1', width: 1920, height: 1080, focused: true }], volume: { value: 0.3, muted: false }, capabilities: { keyboard: true, mouse: true, screenshot: true, live: true, audio: true, stt: true }, warnings: [] };
const claude = { id: '0123456789abcdef01234567', title: 'Claude 1', cols: 51, rows: 41, inMode: false, attachCommand: 'x' };
const shell = { id: 'fedcba9876543210fedcba98', title: 'Terminal 2', cols: 40, rows: 24, inMode: false, attachCommand: 'y' };
const ESC = '\x1b';

function harness({ sessions = [shell, claude], respond = () => null, window: extra = {} } = {}) {
  const document = makeDocument(html), window = Object.assign(makeWindow(), extra);
  const saved = new Map([['ponte-pair-token', 'synthetic-test-token']]);
  const calls = [], timers = [], pending = [];
  const context = vm.createContext({
    document, window, localStorage: { getItem: key => saved.get(key) || null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) },
    navigator: { language: 'en-US', languages: ['en-US'], userAgent: 'Test browser' }, location: { hash: '', pathname: '/', search: '' }, history: { replaceState() {} },
    CustomEvent: class { constructor(type, { detail } = {}) { this.type = type; this.detail = detail; } },
    Intl, Date, Error, TypeError, TextDecoder, Uint8Array, AbortController, URL, Blob, performance,
    setTimeout: (callback, ms) => { timers.push(ms); pending.push({ callback, ms, id: timers.length }); return timers.length; }, clearTimeout: id => { const at = pending.findIndex(item => item.id === id); if (at >= 0) pending.splice(at, 1); }, setInterval: () => 1, clearInterval() {},
    fetch: async (path, options = {}) => {
      calls.push({ path, method: options.method || 'GET', body: options.body });
      const custom = await respond(path, options);
      if (custom) return custom;
      if (path === '/api/terminals' && (options.method || 'GET') === 'GET') return ok({ available: true, sessions: sessions.map(session => ({ ...session })), limit: 4 });
      if (path === '/api/terminals' && options.method === 'POST') return ok({ ...claude, id: 'abcdefabcdefabcdefabcdef', ...JSON.parse(options.body) });
      if (path === '/api/terminals?projects=1') return ok({ projects: ['ponte', 'demo'] });
      if (/^\/api\/terminals\/[a-f0-9]{24}\?format=ansi/.test(path)) return ok({ ...claude, hash: 'h1', text: `${ESC}[1mhello${ESC}[0m\n> `, cursor: { x: 2, y: 1, visible: true }, alternate: false });
      if (path === '/api/state') return ok(state);
      return ok({ ok: true });
    },
  });
  vm.runInContext(runtime, context); vm.runInContext(app, context);
  return { document, window, calls, timers, saved, el: selector => document.querySelector(selector), run: source => vm.runInContext(source, context), writes: () => calls.filter(call => call.method !== 'GET'),
    // Runs the timers queued with this delay (the 300 ms resize debounce), not the polling.
    fire: async ms => { const due = pending.filter(item => item.ms === ms); due.forEach(item => pending.splice(pending.indexOf(item), 1)); due.forEach(item => item.callback()); await flush(); } };
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const ok = value => ({ ok: true, status: 200, json: async () => value });

test('SGR becomes escaped, styled spans: attributes, 16/256/truecolor, inverse, and nothing else survives', () => {
  const h = harness();
  const render = (text, cursor, rows) => h.run(`ansiToHtml(${JSON.stringify(text)}, ${JSON.stringify(cursor || null)}, ${rows || 0})`);
  assert.equal(render(`${ESC}[1;3;4mB${ESC}[22;23;24m ${ESC}[2mD${ESC}[0m`), '<span style="font-weight:700;font-style:italic;text-decoration:underline">B</span> <span style="opacity:.6">D</span>');
  assert.equal(render(`${ESC}[31mr${ESC}[92mg${ESC}[44mb`), '<span style="color:#e8766b">r</span><span style="color:#c3f09a">g</span><span style="color:#c3f09a;background:#7fb4f0">b</span>');
  assert.equal(render(`${ESC}[38;5;196ma${ESC}[38;5;244mb${ESC}[48;5;21mc`), '<span style="color:#ff0000">a</span><span style="color:#808080">b</span><span style="color:#808080;background:#0000ff">c</span>');
  assert.equal(render(`${ESC}[38;2;1;2;3mx${ESC}[38:2::10:20:30my`), '<span style="color:rgb(1,2,3)">x</span><span style="color:rgb(10,20,30)">y</span>');
  assert.equal(render(`${ESC}[7mi${ESC}[27m${ESC}[31;7mj`), '<span style="color:var(--dev-bg);background:var(--dev-fg)">i</span><span style="color:var(--dev-bg);background:#e8766b">j</span>');
  // Markup in the output is text, and non-SGR escapes/controls never reach the page.
  const hostile = render(`<img src=x onerror=alert(1)> "q" & ${ESC}]0;title\x07${ESC}[2J${ESC}[?25l\x08z${ESC}[31m<b>`);
  assert.equal(hostile, '&lt;img src=x onerror=alert(1)&gt; &quot;q&quot; &amp; z<span style="color:#e8766b">&lt;b&gt;</span>');
  assert.doesNotMatch(hostile, /<(?!\/?span)/);
  // Lines render independently: a colour does not bleed into the next line.
  assert.equal(render(`${ESC}[31ma\nb`), '<span style="color:#e8766b">a</span>\nb');
});

test('the cursor is drawn at its cell in the visible rows, counting wide characters, only when visible', () => {
  const h = harness();
  const render = (text, cursor, rows) => h.run(`ansiToHtml(${JSON.stringify(text)}, ${JSON.stringify(cursor)}, ${rows})`);
  // Four lines of text, three visible rows: y=1 is the third line.
  assert.equal(render('old\ntop\nab<d\nlast\n', { x: 2, y: 1, visible: true }, 3), 'old\ntop\nab<span class="dev-cursor">&lt;</span>d\nlast');
  assert.equal(render('界x', { x: 2, y: 0, visible: true }, 1), '界<span class="dev-cursor">x</span>');
  assert.equal(render(`${ESC}[32m> `, { x: 4, y: 0, visible: true }, 1), '<span style="color:#a6d189">&gt; </span>  <span class="dev-cursor"> </span>');
  assert.equal(render('> ', { x: 2, y: 0, visible: false }, 1), '&gt; ');
});

test('the grid fits whole cells in the box and stays inside the server limits', () => {
  const h = harness();
  assert.deepEqual(JSON.parse(JSON.stringify(h.run('devGrid(396, 600, 7.2, 15)'))), { cols: 55, rows: 40 });
  assert.deepEqual(JSON.parse(JSON.stringify(h.run('devGrid(100, 50, 7.2, 15)'))), { cols: 20, rows: 8 });
  assert.deepEqual(JSON.parse(JSON.stringify(h.run('devGrid(4000, 4000, 7.2, 15)'))), { cols: 240, rows: 100 });
  assert.equal(h.run('devGrid(0, 600, 7.2, 15)'), null);
});

test('Dev lists agent sessions first, renders the ansi read, and every bar key sends its contract payload', async () => {
  const h = harness();
  await flush();
  h.run("navigate('dev')"); await flush();
  assert.deepEqual(h.el('#dev-session').querySelectorAll('option').map(option => option.textContent), ['Claude 1', 'Terminal 2']);
  assert.equal(h.run('devId'), claude.id);
  assert.ok(h.calls.some(call => call.path === `/api/terminals/${claude.id}?format=ansi`));
  assert.equal(h.el('#dev-output').innerHTML.includes('hello'), true);
  assert.equal(h.el('#dev-size').textContent, '51×41');
  assert.equal(h.el('.nav-item[data-nav="dev"]').getAttribute('aria-label'), 'Development');
  for (const button of h.el('#dev-keys').querySelectorAll('button')) { button.click(); await flush(); }
  const sent = h.writes().filter(call => call.path === `/api/terminals/${claude.id}/input`).map(call => JSON.parse(call.body));
  assert.deepEqual(sent, [
    { key: 'Escape' }, { key: 'ShiftTab' }, { key: 'Tab' }, { key: 'ArrowUp' }, { key: 'ArrowDown' }, { key: 'ArrowLeft' }, { key: 'ArrowRight' }, { key: 'Enter' }, { key: 'Interrupt' },
    { text: '1' }, { text: '2' }, { text: '3' }, { text: '/' }, { text: '@' }, { text: '!' },
    { key: 'PageUp' }, { key: 'PageDown' }, { key: 'Ctrl+O' }, { key: 'Ctrl+R' }, { key: 'Ctrl+D' }, { key: 'Ctrl+L' },
  ]);
  // The next read asks only for changes since what is on screen, soon after input.
  h.run('devRead(devGeneration)'); await flush();
  assert.ok(h.calls.some(call => call.path === `/api/terminals/${claude.id}?format=ansi&since=h1`));
  assert.equal(h.timers.at(-1), 350);
});

test('polling slows down while nothing changes and stops entirely outside Dev', async () => {
  let unchanged = false;
  const h = harness({ respond: path => /format=ansi/.test(path) && unchanged ? ok({ ...claude, hash: 'h1', unchanged: true, cursor: { x: 0, y: 0, visible: false } }) : null });
  await flush();
  h.run("navigate('dev')"); await flush();
  h.run('devLastInput = 0'); unchanged = true;
  const delays = [];
  for (let i = 0; i < 5; i++) { h.run('devRead(devGeneration)'); await flush(); delays.push(h.timers.at(-1)); }
  assert.deepEqual(delays, [1500, 2250, 3000, 3000, 3000]);
  h.run("navigate('terminais')"); await flush();
  const before = h.calls.filter(call => /format=ansi/.test(call.path)).length;
  h.run('devRead(devGeneration)'); await flush();
  assert.equal(h.calls.filter(call => /format=ansi/.test(call.path)).length, before, 'no Dev reads on another page');
});

test('the composer sends several lines with Enter, pastes without it, and explains a shell that cannot take lines', async () => {
  let refuse = false;
  const h = harness({ respond: (path, options) => path.endsWith('/input') && refuse ? { ok: false, status: 409, json: async () => ({ errorCode: 'MULTILINE_NOT_SUPPORTED', errorParameters: {}, error: 'This terminal is not waiting for pasted text now, so several lines would run one by one. Send one line at a time.' }) } : null });
  await flush();
  h.run("navigate('dev')"); await flush();
  const box = h.el('#dev-input');
  box.value = 'line one\nline two\r\nline three'; h.el('#dev-send').click(); await flush();
  box.value = 'just paste\n\n'; h.el('#dev-paste').click(); await flush();
  const sent = h.writes().filter(call => call.path.endsWith('/input')).map(call => JSON.parse(call.body));
  assert.deepEqual(sent, [{ text: 'line one\nline two\nline three', enter: true }, { text: 'just paste' }], 'a trailing Enter from the keyboard does not turn one line into several');
  assert.equal(box.value, '');
  refuse = true; box.value = 'a\nb'; h.el('#dev-send').click(); await flush();
  assert.match(h.el('#dev-status').textContent, /not waiting for pasted text now/);
  assert.equal(box.value, 'a\nb', 'a refused text stays to fix');
});

test('new sessions start at the measured grid: Dev, Home and Terminals', async () => {
  const h = harness({ sessions: [], window: { innerWidth: 412, innerHeight: 915 } });
  await flush();
  h.run("navigate('dev')"); await flush();
  assert.equal(h.el('#dev-empty').hidden, false);
  assert.match(h.el('#dev-empty-label').textContent, /New Claude in ponte/);
  // Measured box: 396×612 content at 7.2×15 px cells.
  const screen = h.el('#dev-screen'), probe = h.el('#dev-measure');
  screen.clientWidth = 412; screen.clientHeight = 624; probe.clientWidth = 144; probe.clientHeight = 15;
  h.el('#dev-empty-start').click(); await flush();
  const created = h.writes().filter(call => call.path === '/api/terminals').map(call => JSON.parse(call.body));
  assert.deepEqual(created[0], { cols: 55, rows: 40, agent: 'claude', project: 'ponte' });
  // Unmeasured (Dev never shown): an estimate from the window, never 40x24.
  const other = harness({ sessions: [], window: { innerWidth: 412, innerHeight: 915 } });
  await flush();
  other.run("navigate('terminais')"); await flush();
  other.el('#terminal-new').click(); await flush();
  other.run("navigate('inicio')"); await flush();
  other.el('#start-go').click(); await flush();
  const bodies = other.writes().filter(call => call.path === '/api/terminals').map(call => JSON.parse(call.body));
  assert.deepEqual(bodies.map(body => [body.cols, body.rows]), [[51, 41], [51, 41]]);
});

test('Open on the PC asks first, then calls the open route once', async () => {
  const h = harness();
  await flush();
  h.run("navigate('dev')"); await flush();
  h.el('#dev-open-pc').click(); await flush();
  assert.equal(h.el('#dev-open-dialog').open, true);
  assert.equal(h.writes().some(call => call.path.endsWith('/open')), false);
  h.el('#dev-open-cancel').click(); await flush();
  assert.equal(h.writes().some(call => call.path.endsWith('/open')), false);
  h.el('#dev-open-pc').click(); h.el('#dev-open-confirm').click(); await flush();
  assert.deepEqual(h.writes().filter(call => call.path.endsWith('/open')).map(call => call.path), [`/api/terminals/${claude.id}/open`]);
});

test('A−/A+ change and remember the font within bounds', async () => {
  const h = harness();
  await flush();
  h.run("navigate('dev')"); await flush();
  h.el('#dev-font-up').click(); h.el('#dev-font-up').click();
  assert.equal(h.saved.get('ponte-dev-font'), '14');
  assert.equal(h.el('#page-dev').style['--dev-font'], '14px');
  for (let i = 0; i < 20; i++) h.el('#dev-font-down').click();
  assert.equal(h.saved.get('ponte-dev-font'), '9');
  assert.equal(h.el('#dev-font-down').disabled, true);
});

test('only a finger stops following the output; a resize keeps following', async () => {
  const h = harness();
  await flush();
  h.run("navigate('dev')"); await flush();
  const screen = h.el('#dev-screen');
  screen.scrollHeight = 1000; screen.clientHeight = 300; screen.scrollTop = 500;
  screen.dispatchEvent({ type: 'scroll' });
  assert.equal(h.run('devFollow'), true, 'layout-driven scroll keeps following');
  assert.equal(screen.scrollTop, 1000);
  assert.equal(h.el('#dev-live').hidden, true);
  screen.dispatchEvent({ type: 'touchstart' }); screen.scrollTop = 200; screen.dispatchEvent({ type: 'scroll' });
  assert.equal(h.run('devFollow'), false);
  assert.equal(h.el('#dev-live').hidden, false);
  h.el('#dev-live').click();
  assert.equal(h.run('devFollow'), true);
  assert.equal(h.el('#dev-live').hidden, true);
});

test('the pane takes the phone grid only on the tab own layout events, never because a read differs', async () => {
  let pane = { cols: 51, rows: 41 };
  const h = harness({ sessions: [claude], respond: path => /\?format=ansi/.test(path) ? ok({ ...claude, ...pane, hash: `h${pane.cols}`, text: 'x', cursor: { x: 0, y: 0, visible: true } }) : null });
  const screen = h.el('#dev-screen'), probe = h.el('#dev-measure');
  screen.clientWidth = 412; screen.clientHeight = 624; probe.clientWidth = 144; probe.clientHeight = 15;
  await flush();
  const resizes = () => h.writes().filter(call => call.path.endsWith('/resize')).map(call => JSON.parse(call.body));
  // Entering the tab is a layout event: the 51×41 pane becomes the 55×40 grid.
  h.run("navigate('dev')"); await flush(); await h.fire(300);
  assert.deepEqual(resizes(), [{ cols: 55, rows: 40 }]);
  assert.equal(h.el('#dev-size').textContent, '55×40');
  assert.equal(h.el('#dev-size').disabled, true);
  // The PC window took the size (window-size latest): reads show it, and never resize back.
  pane = { cols: 120, rows: 40 };
  h.run('devRead(devGeneration)'); await flush(); await h.fire(300);
  h.run('devRefit()'); await h.fire(300);
  assert.equal(resizes().length, 1, 'a read or an unchanged box does not fight the PC');
  assert.equal(h.el('#dev-size').textContent, 'PC 120×40 · fit');
  assert.equal(h.el('#dev-size').disabled, false);
  // A tap on the badge fits the pane back to the phone.
  h.el('#dev-size').click(); await h.fire(300);
  assert.deepEqual(resizes()[1], { cols: 55, rows: 40 });
  assert.equal(h.el('#dev-size').textContent, '55×40');
  // So does a font change (the grid itself changed).
  pane = { cols: 120, rows: 40 };
  h.run('devRead(devGeneration)'); await flush();
  probe.clientWidth = 168; probe.clientHeight = 17.5; h.el('#dev-font-up').click(); await h.fire(300);
  assert.equal(resizes().length, 3);
  assert.ok(resizes()[2].cols < 55, 'a bigger font fits fewer columns');
});

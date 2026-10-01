import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { makeDocument, makeWindow } from './helpers/dom.mjs';

const read = name => readFile(new URL(`../public/${name}`, import.meta.url), 'utf8');
const [html, runtime, app] = await Promise.all(['index.html', 'i18n.js', 'app.js'].map(read));
const state = {
  hostname: 'test-desktop', windows: [{ address: '0xf1', title: '✳ Demo project', class: 'foot', monitor: 0, workspace: { id: 2, name: '2' } }, { address: '0xf2', title: 'lol@lol:~', class: 'foot', monitor: 0, workspace: { id: 2, name: '2' } }],
  activeWindow: null, workspaces: [], monitors: [{ id: 0, name: 'TEST-1', width: 1920, height: 1080, focused: true }], volume: { value: 0.3, muted: false },
  capabilities: { keyboard: true, mouse: true, screenshot: true, live: true, audio: true }, warnings: [],
};
const session = { id: '0123456789abcdef01234567', title: 'Terminal 1', cols: 40, rows: 24, inMode: false, attachCommand: 'x' };
const other = { id: 'fedcba9876543210fedcba98', title: 'Terminal 2', cols: 40, rows: 24, inMode: false, attachCommand: 'y' };
const minutesAgo = minutes => Date.now() - minutes * 60000;
const agents = [
  { id: 'p-50773-54394', kind: 'claude', title: 'Demo project work', cwd: '~/work/demo', state: 'waiting', waitingFor: 'input needed', since: minutesAgo(3), where: { type: 'terminal', address: '0xf1', monitor: 0, workspace: { id: 2, name: '2' } }, headless: false, transcript: true, canReply: true },
  { id: 'p-336172-244681', kind: 'claude', title: 'Trilho', cwd: '~/Projects/ponte-wt/agentes', state: 'working', since: minutesAgo(0), where: { type: 'maestri' }, headless: false, transcript: true, canReply: false },
  { id: 'p-702-7020', kind: 'codex', title: 'agentes', cwd: '~', state: 'idle', since: minutesAgo(125), where: { type: 'ponte', session: session.id }, headless: false, transcript: true, canReply: true },
  { id: 'w-f2', kind: 'terminal', title: 'lol@lol:~', cwd: '', state: 'terminal', where: { type: 'terminal', address: '0xf2', monitor: 0, workspace: { id: 2, name: '2' } }, transcript: false, canReply: false },
];

function harness(respond, { navigator: extra = {}, storage = null, stored = {} } = {}) {
  const document = makeDocument(html), window = makeWindow();
  const saved = new Map([['ponte-pair-token', 'synthetic-test-token'], ...Object.entries(stored)]);
  const calls = [];
  const context = vm.createContext({
    document, window, localStorage: storage || { getItem: key => saved.get(key) || null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) },
    navigator: { language: 'en-US', languages: ['en-US'], userAgent: 'Test browser', ...extra }, location: { hash: '', pathname: '/', search: '' }, history: { replaceState() {} },
    CustomEvent: class { constructor(type, { detail } = {}) { this.type = type; this.detail = detail; } },
    Intl, Date, Error, TypeError, TextDecoder, Uint8Array, AbortController, URL, Blob, performance,
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    fetch: async (path, options = {}) => { calls.push({ path, options }); const value = await respond(path, options); return value || { ok: true, json: async () => state }; },
  });
  vm.runInContext(runtime, context); vm.runInContext(app, context);
  return { document, calls, el: selector => document.querySelector(selector), run: source => vm.runInContext(source, context), i18n: window.PonteI18n };
}
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
const ok = value => ({ ok: true, json: async () => value });

test('Terminals shows one list: agents with state, place, folder and age, plain terminals and Ponte sessions, without desktop input', async () => {
  const h = harness(path => {
    if (path === '/api/agents') return ok({ items: agents, scannedAt: Date.now(), scanMs: 12 });
    if (path === '/api/terminals') return ok({ available: true, sessions: [session, other], limit: 4 });
    if (path.startsWith('/api/terminals/')) return ok({ ...session, text: '$ ' });
    return null;
  });
  await flush();
  h.run("navigate('terminais')"); await flush(); await flush();
  const cards = h.el('#agent-list').querySelectorAll('.agent-card');
  const text = cards.map(card => card.textContent.replace(/\s+/g, ' ').trim());
  assert.equal(cards.length, 5, text.join('\n'));
  assert.match(text[0], /Claude.*Demo project work.*Window on workspace 2 · 3 min ago · ~\/work\/demo.*Waiting for you/);
  assert.match(text[1], /Claude.*Trilho.*Maestri · just now · ~\/Projects\/ponte-wt\/agentes.*Working/);
  assert.match(text[2], /Codex.*agentes.*Ponte session · Terminal 1 · 2 h ago · ~.*Idle/);
  assert.match(text[3], /Terminal.*lol@lol:~.*Focus and view on monitor.*Open/);
  // The Ponte session with the Codex inside is not listed twice; the other one is.
  assert.match(text[4], /Terminal 2.*Ponte session.*Open/);
  assert.equal(cards[0].getAttribute('data-state'), 'waiting');
  assert.equal(h.el('#agent-count').textContent, '3 AGENTS · 2 BUSY');
  assert.ok(h.calls.every(call => !call.options.method || call.options.method === 'GET'), 'listing never posts');
  h.i18n.setLanguage('pt'); await flush();
  assert.match(h.el('#agent-list').textContent, /Esperando você/);
  assert.match(h.el('#agent-list').textContent, /há 2 h/);
});

test('tapping an agent opens a readable transcript; reply is explicit, one line, and names the focus change', async () => {
  const posted = [];
  const h = harness((path, options) => {
    if (path === '/api/agents') return ok({ items: agents, scannedAt: Date.now(), scanMs: 12 });
    if (path === '/api/terminals') return ok({ available: true, sessions: [session], limit: 4 });
    if (path.startsWith('/api/terminals/')) return ok({ ...session, text: '$ ' });
    if (path === '/api/agents/p-50773-54394/transcript') return ok({ id: 'p-50773-54394', available: true, messages: [{ role: 'user', text: 'quais pendências <b>?</b>', at: 1 }, { role: 'tool', text: 'Bash: List files', at: 2 }, { role: 'assistant', text: 'Ficaram três.', at: 3 }] });
    if (path === '/api/agents/p-50773-54394/reply') { posted.push(JSON.parse(options.body)); return ok({ ok: true, via: 'window' }); }
    if (path === '/api/agents/p-336172-244681/transcript') return ok({ id: 'p-336172-244681', available: true, messages: [] });
    return null;
  });
  await flush();
  h.run("navigate('terminais')"); await flush(); await flush();
  h.el('#agent-list').querySelectorAll('.agent-card')[0].click(); await flush(); await flush();
  assert.equal(h.el('#agent-dialog').open, true);
  assert.equal(h.el('#agent-dialog-title').textContent, 'Demo project work');
  assert.match(h.el('#agent-dialog-kind').textContent, /Claude · Waiting for you \(input needed\)/);
  const messages = h.el('#agent-transcript').querySelectorAll('.agent-msg');
  assert.deepEqual(messages.map(item => item.getAttribute('data-role')), ['user', 'tool', 'assistant']);
  assert.equal(messages[0].textContent, 'Youquais pendências <b>?</b>', 'agent text is escaped, never markup');
  assert.equal(h.el('#agent-view').hidden, false);
  assert.equal(h.el('#agent-reply-form').hidden, false);
  assert.equal(h.el('#agent-reply-send').textContent, 'Reply on the PC');
  assert.match(h.el('#agent-reply-hint').textContent, /brings the window to the front on the PC/);
  assert.equal(posted.length, 0, 'opening never types');
  h.el('#agent-reply-text').value = 'sim,\npode seguir';
  h.el('#agent-reply-form').dispatchEvent({ type: 'submit', target: h.el('#agent-reply-form'), preventDefault() {} }); await flush(); await flush();
  assert.deepEqual(posted, [{ text: 'sim, pode seguir' }]);
  assert.equal(h.el('#agent-reply-text').value, '');
  assert.equal(h.el('#agent-reply-status').textContent, 'Sent to the agent.', 'feedback shows inside the modal, not behind it');
  assert.ok(!h.calls.some(call => call.path === '/api/action'), 'the reply goes through the agent route, not raw desktop actions');
  // A Maestri agent is read-only here.
  h.run('closeAgent()');
  h.el('#agent-list').querySelectorAll('.agent-card')[1].click(); await flush(); await flush();
  assert.equal(h.el('#agent-reply-form').hidden, true);
  assert.equal(h.el('#agent-view').hidden, true);
  assert.match(h.el('#agent-readonly').textContent, /authorized bridge/);
  assert.match(h.el('#agent-transcript').textContent, /Nothing written yet/);
});

test('an older native shell that blocks /api/agents still lists PC terminal windows and Ponte sessions', async () => {
  const h = harness(path => {
    if (path === '/api/agents') return { ok: false, status: 404, json: async () => ({ errorCode: 'ROUTE_NOT_FOUND', error: 'blocked' }) };
    if (path === '/api/terminals') return ok({ available: true, sessions: [session], limit: 4 });
    if (path.startsWith('/api/terminals/')) return ok({ ...session, text: '$ ' });
    return null;
  });
  await flush();
  h.run('pollState()'); await flush();
  h.run("navigate('terminais')"); await flush(); await flush();
  const text = h.el('#agent-list').querySelectorAll('.agent-card').map(card => card.textContent);
  assert.equal(text.length, 3);
  assert.match(text[0], /✳ Demo project/);
  assert.match(text[2], /Terminal 1/);
  assert.equal(h.el('#agent-count').textContent, '');
});

// Synthetic agents for the filter and notice checks: no real names, ids or paths.
const sample = (id, state, extra = {}) => ({ id, kind: 'claude', title: `Sample ${id}`, cwd: '~/work/sample', state, waitingFor: null, since: minutesAgo(1), where: { type: 'none' }, headless: false, transcript: true, canReply: false, ...extra });

test('workspace groups keep their canvas lead on top and show harness, role, model, branch and current activity', async () => {
  const team = { workspaceId: '00000000-0000-4000-8000-0000000000a1', workspace: 'Sample team', lead: false, reportsTo: 'Claude Code', role: 'Reviewer' };
  const items = [
    sample('p-60-1', 'working', { kind:'jcode',title:'Sprout',where:{type:'maestri'},maestri:team,branch:'feature/sample',model:{name:'sample-model',provider:'sample-route',effort:'high'},activity:{text:'Read: sample.test.mjs'} }),
    sample('p-61-1', 'idle', { title:'Claude Code',where:{type:'maestri'},maestri:{...team,lead:true,role:null,reportsTo:null} }),
    sample('p-62-1', 'ready', { title:'Sprout',where:{type:'maestri'},maestri:{...team,workspaceId:'00000000-0000-4000-8000-0000000000b1',workspace:'Other team',reportsTo:null} }),
  ];
  const {h} = watchHarness(items);
  await flush(); h.run("navigate('terminais')"); await flush(); await flush();
  const cards = h.el('#agent-list').querySelectorAll('.agent-card');
  assert.equal(cards[0].querySelector('strong').textContent,'Claude Code');
  assert.match(cards[0].textContent,/Team lead \(canvas connections\)/);
  assert.match(cards[1].textContent,/JCode.*Sprout.*Sample team.*feature\/sample.*Team of Claude Code · Reviewer.*sample-route · sample-model · high.*Read: sample.test.mjs/);
  assert.match(cards[2].textContent,/Other team/);
  assert.equal(h.el('#agent-count').textContent,'3 AGENTS · 1 BUSY');
  cards[1].click(); await flush();
  assert.match(h.el('#agent-dialog-meta').textContent,/feature\/sample/);
  assert.match(h.el('#agent-dialog-meta').textContent,/Read: sample.test.mjs/);
  assert.equal(h.el('#agent-reply-form').hidden,true);
  assert.ok(h.calls.every(call => !call.options.method || call.options.method === 'GET'));
});

function watchHarness(initial, options = {}) {
  let items = initial;
  const vibrations = [];
  const h = harness(path => {
    if (path === '/api/agents') return ok({ items, scannedAt: Date.now(), scanMs: 5 });
    if (path === '/api/terminals') return ok({ available: true, sessions: [], limit: 4 });
    if (path.startsWith('/api/agents/') && path.endsWith('/transcript')) return ok({ id: path.split('/')[3], available: true, messages: [] });
    return null;
  }, { navigator: { vibrate: ms => { vibrations.push(ms); return true; } }, ...options });
  const reads = () => h.calls.filter(call => call.path === '/api/agents').length;
  const watch = async () => { await h.run('agentWatch(terminalGeneration)'); await flush(); };
  return { h, vibrations, reads, watch, set: next => { items = next; } };
}

test('automated agents are hidden by default behind "Show automated (N)", which counts them and remembers the choice', async () => {
  const list = [sample('p-10-1', 'working'), sample('p-11-1', 'working', { kind: 'codex', headless: true, where: { type: 'app', app: 'Sample app' } }), sample('p-12-1', 'waiting', { headless: true })];
  const { h } = watchHarness(list);
  await flush();
  h.run("navigate('terminais')"); await flush(); await flush();
  const titles = () => h.el('#agent-list').querySelectorAll('.agent-card').map(card => card.querySelector('strong').textContent);
  assert.deepEqual(titles(), ['Sample p-10-1']);
  assert.equal(h.el('#agent-show-auto').hidden, false);
  assert.equal(h.el('#agent-show-auto').textContent, 'Show automated (2)', 'the count shows while they are hidden');
  assert.equal(h.el('#agent-show-auto').getAttribute('aria-pressed'), 'false');
  assert.equal(h.el('#agent-count').textContent, '1 AGENTS · 1 BUSY', 'automated agents are counted separately');
  h.el('#agent-show-auto').click(); await flush();
  assert.deepEqual(titles(), ['Sample p-10-1', 'Sample p-11-1', 'Sample p-12-1']);
  assert.equal(h.el('#agent-show-auto').getAttribute('aria-pressed'), 'true');
  assert.equal(h.el('#agent-count').textContent, '1 AGENTS · 1 BUSY', 'showing automated agents does not change the interactive count');
  assert.equal(h.run("localStorage.getItem('ponte-agents-auto')"), 'show');
  h.i18n.setLanguage('pt'); await flush();
  assert.equal(h.el('#agent-show-auto').textContent, 'Mostrar automáticos (2)');
  // A WebView whose storage throws still starts with them hidden.
  const broken = harness(path => path === '/api/agents' ? ok({ items: list }) : null, { storage: { getItem(key) { if (key === 'ponte-pair-token') return 'synthetic-test-token'; throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() {} } });
  await flush();
  broken.run("navigate('terminais')"); await flush(); await flush();
  assert.equal(broken.el('#agent-list').querySelectorAll('.agent-card').length, 1);
  broken.el('#agent-show-auto').click(); await flush();
  assert.equal(broken.el('#agent-list').querySelectorAll('.agent-card').length, 3);
});

test('a ready Claude shows "Ready" with its own style', async () => {
  const { h } = watchHarness([sample('p-20-1', 'ready'), sample('p-21-1', 'idle')]);
  await flush();
  h.run("navigate('terminais')"); await flush(); await flush();
  const cards = h.el('#agent-list').querySelectorAll('.agent-card');
  assert.equal(cards[0].getAttribute('data-state'), 'ready');
  assert.match(cards[0].textContent, /Ready/);
  assert.match(cards[1].textContent, /Idle/);
  h.i18n.setLanguage('pt'); await flush();
  assert.match(h.el('#agent-list').textContent, /Pronto/);
});

test('working → waiting or ready raises one tappable notice on any tab; the first read, automated agents and fresh replies never do', async () => {
  const a = sample('p-30-1', 'working'), b = sample('p-31-1', 'working'), auto = sample('p-32-1', 'working', { headless: true });
  const w = watchHarness([a, b, auto]);
  await flush();
  w.h.run("navigate('inicio')"); await flush();
  await w.watch();
  assert.ok(w.reads() >= 1, 'the Home reads the agent list too');
  assert.equal(w.h.el('#agent-notice').hidden, true, 'first read only sets the baseline');
  w.set([{ ...a, state: 'waiting', waitingFor: 'input needed' }, b, { ...auto, state: 'waiting' }]);
  await w.watch();
  assert.equal(w.h.el('#agent-notice').hidden, false);
  assert.equal(w.h.el('#agent-notice-title').textContent, 'Sample p-30-1 needs you');
  assert.equal(w.h.el('#agent-notice-detail').textContent, 'input needed');
  assert.deepEqual(w.vibrations.length, 1);
  assert.equal(w.h.el('#nav-agent-dot').hidden, false);
  await w.watch();
  assert.equal(w.vibrations.length, 1, 'a transition fires once');
  w.set([{ ...a, state: 'waiting', waitingFor: 'input needed' }, { ...b, state: 'ready' }, { ...auto, state: 'waiting' }]);
  await w.watch();
  assert.equal(w.h.el('#agent-notice-title').textContent, 'Sample p-31-1 finished');
  assert.equal(w.h.el('#agent-notice-detail').textContent, '');
  assert.equal(w.vibrations.length, 2);
  w.h.el('#agent-notice').click(); await flush(); await flush();
  assert.equal(w.h.el('#agent-notice').hidden, true);
  assert.equal(w.h.el('#agent-dialog').open, true);
  assert.equal(w.h.el('#agent-dialog-title').textContent, 'Sample p-31-1');
  w.h.run('closeAgent()');
  // A reply sent from the phone a moment ago does not echo back as a notice.
  w.set([{ ...a, state: 'working' }, { ...b, state: 'working' }, auto]);
  await w.watch();
  w.h.run("agentRepliedAt['p-30-1'] = Date.now()");
  w.set([{ ...a, state: 'waiting' }, { ...b, state: 'working' }, auto]);
  await w.watch();
  assert.equal(w.vibrations.length, 2);
  // Opening Terminals clears the dot; there the 3 s read is the only one.
  w.h.run("navigate('terminais')"); await flush(); await flush();
  assert.equal(w.h.el('#nav-agent-dot').hidden, true);
  const before = w.reads();
  await w.watch();
  assert.equal(w.reads(), before, 'no second reader on Terminals');
  w.h.i18n.setLanguage('pt');
  w.h.run('agentNoticeCheck(agentItems.map(item => Object.assign({}, item, {state:"working"})))');
  w.h.run("agentNoticeCheck([Object.assign({}, agentItems[1], {state:'waiting', title:'Amostra'})])");
  assert.equal(w.h.el('#agent-notice-title').textContent, 'Amostra precisa de você');
});

test('notices switched off never fire nor read outside Terminals, and a paused or hidden app does not read', async () => {
  const a = sample('p-40-1', 'working');
  const w = watchHarness([a]);
  await flush();
  w.h.run("navigate('terminais')"); await flush(); await flush();
  assert.equal(w.h.el('#agent-notices').getAttribute('aria-pressed'), 'true', 'on by default');
  w.h.el('#agent-notices').click(); await flush();
  assert.equal(w.h.el('#agent-notices').getAttribute('aria-pressed'), 'false');
  assert.equal(w.h.run("localStorage.getItem('ponte-agent-notices')"), 'off');
  w.h.run("agentNoticeCheck([Object.assign({}, agentItems[0], {state:'waiting'})])");
  assert.equal(w.h.el('#agent-notice').hidden, true);
  assert.equal(w.vibrations.length, 0);
  w.h.run("navigate('inicio')"); await flush();
  let before = w.reads();
  await w.watch();
  assert.equal(w.reads(), before, 'off means no background reading');
  // Back on: reading resumes, but not while the native shell is paused or the page is hidden.
  w.h.run("navigate('terminais')"); await flush();
  w.h.el('#agent-notices').click(); await flush();
  w.h.run("navigate('inicio')"); await flush();
  w.h.run("window.dispatchEvent({type:'ponte-native-pause', detail:{}})");
  before = w.reads();
  await w.watch();
  assert.equal(w.reads(), before, 'paused: no read');
  w.h.run("window.dispatchEvent({type:'ponte-native-resume'})"); await flush();
  await w.watch();
  assert.equal(w.reads(), before + 1);
  w.h.document.hidden = true;
  before = w.reads();
  await w.watch();
  assert.equal(w.reads(), before, 'hidden: no read');
  // Remembered across launches.
  const again = watchHarness([a], { stored: { 'ponte-agent-notices': 'off' } });
  await flush();
  assert.equal(again.h.el('#agent-notices').getAttribute('aria-pressed'), 'false');
});

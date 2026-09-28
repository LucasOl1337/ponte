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

function harness(respond) {
  const document = makeDocument(html), window = makeWindow();
  const saved = new Map([['ponte-pair-token', 'synthetic-test-token']]);
  const calls = [];
  const context = vm.createContext({
    document, window, localStorage: { getItem: key => saved.get(key) || null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) },
    navigator: { language: 'en-US', languages: ['en-US'], userAgent: 'Test browser' }, location: { hash: '', pathname: '/', search: '' }, history: { replaceState() {} },
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
  assert.equal(h.el('#agent-count').textContent, '2 ACTIVE');
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
  assert.match(h.el('#agent-readonly').textContent, /Maestri canvas/);
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

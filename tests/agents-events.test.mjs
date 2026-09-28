import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createAgentEvents } from '../backend/agent-events.mjs';
import { createApp } from '../server.mjs';

// Synthetic agents only: no real names, ids or paths.
const agent = (id, state, extra = {}) => ({ id, kind: 'claude', title: `Sample ${id}`, state, waitingFor: null, headless: false, ...extra });
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

// A clock and timers the test moves by hand, and a scan that returns whatever
// the test set last and counts how often it ran.
function rig(options = {}) {
  let clock = 1_000_000, nextId = 1, items = [];
  const timers = new Map();
  const scans = { count: 0 };
  const events = createAgentEvents({
    list: async () => { scans.count++; if (options.fail?.()) throw new Error('scan failed'); return { items }; },
    now: () => clock,
    setTimer: (callback, ms) => { const id = nextId++; timers.set(id, { at: clock + ms, callback }); return id; },
    clearTimer: id => timers.delete(id),
    ...options.events,
  });
  async function advance(ms) {
    const end = clock + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]); clock = due[1].at; due[1].callback(); await flush();
    }
    clock = end; await flush();
  }
  return { events, scans, advance, set: next => { items = next; }, get clock() { return clock; }, timers };
}

test('without after (or with one from a previous server run) the answer is only the baseline seq, never old events', async () => {
  const r = rig();
  r.set([agent('p-1-1', 'working')]);
  assert.deepEqual(await r.events.wait({}), { seq: 0, events: [] });
  await flush();
  r.set([agent('p-1-1', 'waiting', { waitingFor: 'input needed' })]);
  await r.advance(5000);
  assert.equal(r.events.seq, 1);
  assert.deepEqual(await r.events.wait({ wait: 50 }), { seq: 1, events: [] }, 'no after: baseline, even with a wait');
  assert.deepEqual(await r.events.wait({ after: 99, wait: 50 }), { seq: 1, events: [] }, 'after beyond seq: the server restarted, baseline');
  const { events } = await r.events.wait({ after: 0 });
  assert.deepEqual(events, [{ seq: 1, id: 'p-1-1', kind: 'claude', title: 'Sample p-1-1', to: 'waiting', waitingFor: 'input needed', at: r.clock }]);
});

test('working → waiting and working → ready become events; the first scan, headless agents, other moves and fresh replies do not', async () => {
  const r = rig();
  r.set([agent('p-1-1', 'working'), agent('p-2-1', 'working'), agent('p-3-1', 'working', { headless: true }), agent('p-4-1', 'idle'), agent('w-ab', 'terminal')]);
  const first = r.events.wait({ after: 0, wait: 50 });
  await flush();
  assert.equal(r.scans.count, 1, 'a request starts the watcher right away');
  r.set([agent('p-1-1', 'waiting', { waitingFor: 'input needed' }), agent('p-2-1', 'working'), agent('p-3-1', 'waiting', { headless: true }), agent('p-4-1', 'ready'), agent('w-ab', 'terminal')]);
  await r.advance(5000);
  const answered = await first;
  assert.deepEqual(answered.events.map(event => [event.id, event.to, event.waitingFor]), [['p-1-1', 'waiting', 'input needed']], 'idle → ready and headless are not news');
  // A reply sent by the phone moves the agent; that echo is dropped for 5 s.
  r.set([agent('p-1-1', 'working'), agent('p-2-1', 'working')]);
  await r.advance(8000);
  r.events.replied('p-1-1');
  r.set([agent('p-1-1', 'ready'), agent('p-2-1', 'ready')]);
  await r.advance(2000);
  const after = await r.events.wait({ after: answered.seq });
  assert.deepEqual(after.events.map(event => [event.id, event.to, event.waitingFor]), [['p-2-1', 'ready', null]]);
  // Past the quiet window the same agent is news again.
  r.set([agent('p-1-1', 'working'), agent('p-2-1', 'ready')]);
  await r.advance(5000);
  r.set([agent('p-1-1', 'ready'), agent('p-2-1', 'ready')]);
  await r.advance(5000);
  assert.deepEqual((await r.events.wait({ after: after.seq })).events.map(event => event.id), ['p-1-1']);
});

test('a long-poll holds until an event or its wait, and the watcher scans only while someone asks', async () => {
  const r = rig();
  r.set([agent('p-1-1', 'working')]);
  const base = await r.events.wait({});
  let settled = null;
  r.events.wait({ after: base.seq, wait: 50 }).then(value => { settled = value; });
  await r.advance(45000);
  assert.equal(settled, null, 'nothing new yet: still waiting');
  assert.equal(r.events.waiting, 1);
  await r.advance(5000);
  assert.deepEqual(settled, { seq: 0, events: [] }, 'the wait ends empty');
  // An event wakes a waiter at the next scan, not at the end of its wait.
  settled = null;
  r.events.wait({ after: 0, wait: 50 }).then(value => { settled = value; });
  r.set([agent('p-1-1', 'ready')]);
  await r.advance(5000);
  assert.equal(settled.events.length, 1);
  assert.equal(settled.seq, 1);
  // With nobody asking the watcher keeps going for a minute, then stops and forgets.
  const count = r.scans.count;
  await r.advance(60000);
  assert.ok(r.scans.count - count <= 13, 'about one scan every 5 s during the linger');
  assert.equal(r.events.watching, false);
  const idle = r.scans.count;
  await r.advance(10 * 60000);
  assert.equal(r.scans.count, idle, 'no scans once nobody asks');
  // The next request sets a fresh baseline: a change made while stopped is not replayed.
  r.set([agent('p-1-1', 'working')]);
  await r.events.wait({ after: 1 });
  r.set([agent('p-1-1', 'waiting')]);
  await r.advance(5000);
  assert.equal(r.events.seq, 2, 'but a change after the new baseline is');
});

test('wait=0 answers at once, the wait is capped at 50 s, a hang-up releases the waiter, and a fifth waiter frees the oldest', async () => {
  const r = rig();
  r.set([agent('p-1-1', 'working')]);
  await r.events.wait({});
  assert.deepEqual(await r.events.wait({ after: 0, wait: 0 }), { seq: 0, events: [] });
  let capped = null;
  r.events.wait({ after: 0, wait: 900 }).then(value => { capped = value; });
  await r.advance(50000);
  assert.deepEqual(capped, { seq: 0, events: [] }, 'wait=900 behaves as 50');
  const gone = new AbortController();
  let hung = null;
  r.events.wait({ after: 0, wait: 50, signal: gone.signal }).then(value => { hung = value; });
  await flush();
  assert.equal(r.events.waiting, 1);
  gone.abort(); await flush();
  assert.deepEqual(hung, { seq: 0, events: [] });
  assert.equal(r.events.waiting, 0);
  const results = [];
  for (let index = 0; index < 5; index++) r.events.wait({ after: 0, wait: 50 }).then(value => results.push([index, value.events.length]));
  await flush();
  assert.equal(r.events.waiting, 4, 'never more than four open');
  assert.deepEqual(results, [[0, 0]], 'the oldest was released');
  r.events.close(); await flush();
  assert.equal(r.events.waiting, 0, 'closing releases everyone');
  assert.equal(results.length, 5);
  assert.deepEqual(await r.events.wait({ after: 0, wait: 50 }), { seq: 0, events: [] }, 'a closed watcher answers at once');
});

test('only the last 50 events are kept, and a failing scan keeps the previous states', async () => {
  let failing = false;
  const r = rig({ fail: () => failing });
  const ids = Array.from({ length: 60 }, (_, index) => `p-${index + 1}-1`);
  r.set(ids.map(id => agent(id, 'working')));
  await r.events.wait({});
  r.set(ids.map(id => agent(id, 'ready')));
  await r.advance(5000);
  assert.equal(r.events.seq, 60);
  const kept = (await r.events.wait({ after: 0 })).events;
  assert.equal(kept.length, 50);
  assert.equal(kept[0].seq, 11);
  r.set([agent('p-1-1', 'working')]);
  await r.advance(5000);
  failing = true;
  r.set([agent('p-1-1', 'waiting')]);
  await r.advance(5000);
  assert.equal(r.events.seq, 60);
  failing = false;
  await r.events.wait({ after: 60 });
  await r.advance(5000);
  assert.equal(r.events.seq, 61, 'the transition is still seen after the failed scan');
});

test('the events route needs pairing, validates its query, holds the request, and closing the server ends it', async t => {
  const TOKEN = 'synthetic-events-token-0123456789abcdef';
  const root = await mkdtemp(path.join(os.tmpdir(), 'ponte-agent-events-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'public'));
  let items = [agent('p-5-1', 'working')];
  const agents = { list: async () => ({ items, scannedAt: Date.now(), scanMs: 1 }), transcript: async () => ({}), reply: async () => ({ ok: true, via: 'session' }) };
  const agentEvents = createAgentEvents({ list: () => agents.list(), scanMs: 20 });
  const app = await createApp({ rootDir: root, dataDir: path.join(root, 'private'), token: TOKEN, agents, agentEvents, desktop: { action: async () => ({}), getState: async () => ({}) }, terminals: { input: async () => ({}), list: async () => ({}) }, trustedHosts: [] });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  let closed = false;
  t.after(() => closed ? null : app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = (route, options = {}) => fetch(base + route, { ...options, headers: { Authorization: `Bearer ${TOKEN}`, ...options.headers } });
  assert.equal((await fetch(`${base}/api/agents/events`)).status, 401);
  assert.equal((await request('/api/agents/events?after=1&after=2')).status, 400);
  assert.deepEqual(await (await request('/api/agents/events')).json(), { seq: 0, events: [] });
  assert.deepEqual(await (await request('/api/agents/events?after=abc&wait=5')).json(), { seq: 0, events: [] }, 'an unreadable after is a baseline request');
  assert.equal((await request('/api/agents/events', { method: 'POST' })).status, 404);
  const started = Date.now();
  const held = request('/api/agents/events?after=0&wait=10').then(response => response.json());
  await new Promise(resolve => setTimeout(resolve, 60));
  items = [agent('p-5-1', 'waiting', { waitingFor: 'input needed' })];
  const answer = await held;
  assert.ok(Date.now() - started < 3000, 'answered by the transition, not by the wait');
  assert.deepEqual(answer.events.map(event => [event.id, event.to, event.title, event.waitingFor]), [['p-5-1', 'waiting', 'Sample p-5-1', 'input needed']]);
  assert.deepEqual(Object.keys(answer.events[0]).sort(), ['at', 'id', 'kind', 'seq', 'title', 'to', 'waitingFor']);
  // A reply from the phone marks the agent quiet.
  items = [agent('p-5-1', 'working')];
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal((await request('/api/agents/p-5-1/reply', { method: 'POST', body: '{"text":"ok"}', headers: { 'Content-Type': 'application/json' } })).status, 200);
  items = [agent('p-5-1', 'ready')];
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(agentEvents.seq, answer.seq, 'no echo of the reply');
  // Shutdown does not wait out an open long-poll.
  const open = request(`/api/agents/events?after=${answer.seq}&wait=50`).then(response => response.status, () => 'closed');
  await new Promise(resolve => setTimeout(resolve, 60));
  const closing = Date.now();
  closed = true;
  await app.close();
  assert.ok(Date.now() - closing < 3000, 'close is prompt');
  assert.ok([200, 503, 'closed'].includes(await open));
});

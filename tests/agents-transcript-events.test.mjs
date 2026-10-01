import test from 'node:test';
import assert from 'node:assert/strict';
import { createTranscriptEvents } from '../backend/agent-events.mjs';

const ID = 'p-101-1000';
const OTHER = 'p-202-2000';
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const track = promise => {
  const result = { settled: false, value: null, error: null };
  result.promise = promise.then(value => { result.settled = true; result.value = value; return value; }, error => { result.settled = true; result.error = error; });
  return result;
};

// No processes, real transcript paths or wall-clock sleeps. Timer id 0 is
// deliberate: lifecycle cleanup must not depend on a truthy timeout handle.
function rig(t, options = {}) {
  let clock = 1_000_000, nextId = 0;
  const timers = new Map(), states = new Map(), calls = [];
  const events = createTranscriptEvents({
    read: async (id, { since }) => {
      calls.push({ id, since, at: clock });
      if (options.read) return options.read(id, { since }, calls.length);
      const state = states.get(id) || { cursor: 'fixture-cursor-1', messages: [{ role: 'assistant', text: 'Fixture transcript.' }] };
      return since === state.cursor ? { cursor: state.cursor, messages: [], unchanged: true, ...(state.extra || {}) } : { ...state, unchanged: false };
    },
    now: () => clock,
    setTimer: (callback, ms) => { const id = nextId++; timers.set(id, { at: clock + ms, callback }); return id; },
    clearTimer: id => timers.delete(id),
    ...options.events,
  });
  t.after(() => events.close());
  async function advance(ms) {
    const end = clock + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      timers.delete(due[0]); clock = due[1].at;
      due[1].callback(); await flush();
    }
    clock = end; await flush();
  }
  return { events, calls, timers, advance, set: (id, state) => states.set(id, state), get clock() { return clock; } };
}

function assertStopped(r) {
  assert.equal(r.events.waiting, 0);
  assert.equal(r.events.watching, false);
  assert.equal(r.timers.size, 0);
}

test('baseline, changed cursors and wait=0 return read results immediately without any idle polling', async t => {
  const r = rig(t);
  await r.advance(60000);
  assert.equal(r.calls.length, 0);
  assertStopped(r);
  const baseline = await r.events.wait(ID, { wait: 10 });
  assert.deepEqual(baseline, { cursor: 'fixture-cursor-1', messages: [{ role: 'assistant', text: 'Fixture transcript.' }], unchanged: false });
  assert.deepEqual(r.calls.map(({ id, since }) => [id, since]), [[ID, null]]);
  assertStopped(r);
  assert.equal((await r.events.wait(ID, { since: 'fixture-old-cursor', wait: 10 })).unchanged, false);
  assert.deepEqual(await r.events.wait(ID, { since: 'fixture-cursor-1' }), { cursor: 'fixture-cursor-1', messages: [], unchanged: true });
  assertStopped(r);
  const count = r.calls.length;
  await r.advance(60000);
  assert.equal(r.calls.length, count, 'no lingering watcher after immediate requests');
});

test('unchanged requests share one watcher per id and all wake on the next changed transcript', async t => {
  const r = rig(t);
  const first = track(r.events.wait(ID, { since: 'fixture-cursor-1', wait: 10 }));
  const second = track(r.events.wait(ID, { since: 'fixture-cursor-1', wait: 10 }));
  await flush();
  assert.equal(r.calls.length, 1, 'concurrent initial reads share the same cursor');
  assert.equal(r.events.waiting, 2);
  assert.equal(r.timers.size, 3, 'two deadlines and one shared scan timer');
  await r.advance(999);
  assert.equal(r.calls.length, 1);
  assert.equal(first.settled, false);
  r.set(ID, { cursor: 'fixture-cursor-2', messages: [{ role: 'assistant', text: 'New fixture turn.' }] });
  await r.advance(1);
  assert.equal(r.calls.length, 2);
  assert.equal(first.value.cursor, 'fixture-cursor-2');
  assert.deepEqual(second.value, first.value);
  assertStopped(r);
  await r.advance(20000);
  assert.equal(r.calls.length, 2);
});

test('wait seconds are bounded to ten, invalid or negative waits are immediate, and scanMs is injectable', async t => {
  const r = rig(t, { events: { scanMs: 250 } });
  for (const seconds of [-1, 'not-a-number', 0]) {
    assert.equal((await r.events.wait(ID, { since: 'fixture-cursor-1', wait: seconds })).unchanged, true);
    assertStopped(r);
  }
  const capped = track(r.events.wait(ID, { since: 'fixture-cursor-1', wait: 900 }));
  await flush();
  const reads = r.calls.length;
  await r.advance(249);
  assert.equal(r.calls.length, reads);
  await r.advance(1);
  assert.equal(r.calls.length, reads + 1);
  await r.advance(9749);
  assert.equal(capped.settled, false);
  await r.advance(1);
  assert.deepEqual(capped.value, { cursor: 'fixture-cursor-1', messages: [], unchanged: true });
  assertStopped(r);
});

test('six waiters is a global limit across ids and the seventh releases the oldest with its last unchanged result', async t => {
  const r = rig(t);
  const results = [];
  for (let index = 0; index < 7; index++) {
    results.push(track(r.events.wait(`p-${index + 1}-1000`, { since: 'fixture-cursor-1', wait: 10 })));
    await flush();
    assert.ok(r.events.waiting <= 6);
  }
  assert.equal(r.events.waiting, 6);
  assert.deepEqual(results[0].value, { cursor: 'fixture-cursor-1', messages: [], unchanged: true });
  assert.ok(results.slice(1).every(result => !result.settled));
  const callsForOldest = r.calls.filter(call => call.id === 'p-1-1000').length;
  await r.advance(1000);
  assert.equal(r.calls.filter(call => call.id === 'p-1-1000').length, callsForOldest);
  r.events.close(); await flush();
  assert.ok(results.every(result => result.settled && result.value.unchanged));
  assertStopped(r);
});

test('aborting a request releases timers and returns the latest unchanged read, not just its initial snapshot', async t => {
  let revision = 0;
  const r = rig(t, { read: async () => ({ cursor: 'fixture-cursor-1', unchanged: true, revision: ++revision }) });
  const controller = new AbortController();
  const waiting = track(r.events.wait(ID, { since: 'fixture-cursor-1', wait: 10, signal: controller.signal }));
  await flush();
  await r.advance(1000);
  controller.abort(); await flush();
  assert.deepEqual(waiting.value, { cursor: 'fixture-cursor-1', messages: [], unchanged: true, revision: 2 });
  assertStopped(r);
  const count = r.calls.length;
  await r.advance(20000);
  assert.equal(r.calls.length, count);
  assert.deepEqual(await r.events.wait(OTHER, { since: 'fixture-other', wait: 10, signal: controller.signal }), { cursor: 'fixture-other', messages: [], unchanged: true });
  assert.equal(r.calls.length, count, 'a signal aborted before wait starts does not trigger read');
});

test('timeout, abort and close never repeat messages from the last read or a delta for another cursor', async t => {
  for (const ending of ['timeout', 'abort', 'close']) await t.test(ending, async t => {
    const r = rig(t, { read: async (id, { since }) => since === 'fixture-cursor-1'
      ? { cursor: since, unchanged: true, messages: [{ role: 'assistant', text: 'Do not repeat this fixture.' }], marker: 'held-result' }
      : { cursor: 'fixture-cursor-1', unchanged: false, messages: [{ role: 'assistant', text: 'Other cursor delta.' }], marker: 'other-result' } });
    const controller = new AbortController();
    const held = track(r.events.wait(ID, { since: 'fixture-cursor-1', wait: 1, signal: controller.signal }));
    await flush();
    const delta = await r.events.wait(ID, { since: 'fixture-old', wait: 10 });
    assert.equal(delta.unchanged, false);
    assert.equal(delta.messages.length, 1, 'changed results retain their messages');
    if (ending === 'abort') controller.abort();
    else if (ending === 'close') r.events.close();
    else await r.advance(1000);
    await flush();
    assert.deepEqual(held.value, { cursor: 'fixture-cursor-1', unchanged: true, messages: [], marker: 'held-result' });
    assertStopped(r);
  });
});

test('completion removes abort listeners so later signal activity cannot retain or finish an old request', async t => {
  const r = rig(t);
  const listeners = new Set();
  const signal = {
    aborted: false,
    addEventListener: (event, listener) => { assert.equal(event, 'abort'); listeners.add(listener); },
    removeEventListener: (event, listener) => { assert.equal(event, 'abort'); listeners.delete(listener); },
  };
  const waiting = r.events.wait(ID, { since: 'fixture-cursor-1', wait: 1, signal });
  await flush();
  assert.equal(listeners.size, 1);
  await r.advance(1000);
  await waiting;
  assert.equal(listeners.size, 0);
  assertStopped(r);
});

test('read errors reject initial requests and every waiting request for a departed agent', async t => {
  const missing = Object.assign(new Error('synthetic agent left'), { code: 'AGENT_NOT_FOUND', status: 404 });
  let failing = true;
  const r = rig(t, { read: async () => { if (failing) throw missing; return { cursor: 'fixture-cursor-1', unchanged: true }; } });
  await assert.rejects(r.events.wait(ID), error => error === missing);
  assertStopped(r);
  failing = false;
  const one = track(r.events.wait(ID, { since: 'fixture-cursor-1', wait: 10 }));
  const two = track(r.events.wait(ID, { since: 'fixture-cursor-1', wait: 10 }));
  await flush();
  failing = true;
  await r.advance(1000);
  assert.equal(one.error, missing);
  assert.equal(two.error, missing);
  assertStopped(r);
  failing = false;
  const again = r.events.wait(ID, { since: 'fixture-cursor-1', wait: 1 });
  await flush();
  await r.advance(1000);
  assert.equal((await again).unchanged, true, 'read failure does not poison later requests');
});

test('close releases all waiters, removes timers, is idempotent and never starts more reads', async t => {
  const r = rig(t);
  const one = track(r.events.wait(ID, { since: 'fixture-cursor-1', wait: 10 }));
  const two = track(r.events.wait(OTHER, { since: 'fixture-cursor-1', wait: 10 }));
  await flush();
  r.events.close(); r.events.close(); await flush();
  assert.deepEqual(one.value, { cursor: 'fixture-cursor-1', messages: [], unchanged: true });
  assert.deepEqual(two.value, one.value);
  assertStopped(r);
  const count = r.calls.length;
  assert.deepEqual(await r.events.wait(ID, { since: 'fixture-cursor-1', wait: 10 }), { cursor: 'fixture-cursor-1', messages: [], unchanged: true });
  await r.advance(30000);
  assert.equal(r.calls.length, count);
});

test('a slow scan never overlaps a read for the same id, including concurrent requests with different cursors', async t => {
  const gate = deferred();
  let active = 0, peak = 0;
  const r = rig(t, { read: async (id, { since }, count) => {
    active++; peak = Math.max(peak, active);
    try {
      if (count === 2) await gate.promise;
      return { cursor: since, unchanged: true };
    } finally { active--; }
  } });
  const controller = new AbortController();
  const first = track(r.events.wait(ID, { since: 'fixture-cursor-1', wait: 10, signal: controller.signal }));
  await flush();
  await r.advance(1000);
  const otherCursor = track(r.events.wait(ID, { since: 'fixture-cursor-2', wait: 10 }));
  await flush();
  await r.advance(4000);
  assert.equal(r.calls.length, 2);
  assert.equal(active, 1);
  gate.resolve(); await flush();
  assert.equal(r.calls.length, 3);
  assert.equal(peak, 1);
  assert.deepEqual(r.calls.map(call => call.since), ['fixture-cursor-1', 'fixture-cursor-1', 'fixture-cursor-2']);
  controller.abort(); await flush();
  assert.equal(first.value.cursor, 'fixture-cursor-1', 'abort keeps the result for this waiter cursor');
  assert.equal(otherCursor.settled, false);
  await r.advance(1000);
  assert.equal(peak, 1);
  r.events.close(); await flush();
  assertStopped(r);
});

test('abort and reconnect during an uncancellable initial read share its in-flight slot', async t => {
  const gate = deferred();
  const r = rig(t, { read: async () => gate.promise });
  const controller = new AbortController();
  const old = track(r.events.wait(ID, { since: 'fixture-cursor-1', wait: 10, signal: controller.signal }));
  await flush();
  controller.abort(); await flush();
  assert.deepEqual(old.value, { cursor: 'fixture-cursor-1', messages: [], unchanged: true });
  assert.equal(r.timers.size, 0);
  const replacement = track(r.events.wait(ID, { since: 'fixture-cursor-1', wait: 10 }));
  await flush();
  assert.equal(r.calls.length, 1, 'no second read while the aborted request is still reading');
  gate.resolve({ cursor: 'fixture-cursor-2', unchanged: false, messages: [] }); await flush();
  assert.equal(replacement.value.cursor, 'fixture-cursor-2');
  assertStopped(r);
});

test('timeout or close during a slow read cannot schedule more work after that read completes', async t => {
  for (const end of ['timeout', 'close', 'abort-before-read']) await t.test(end, async t => {
    const gate = deferred();
    const r = rig(t, { read: async () => gate.promise });
    const controller = new AbortController();
    const pending = track(r.events.wait(ID, { since: 'fixture-cursor-1', wait: 1, signal: controller.signal }));
    if (end === 'abort-before-read') controller.abort();
    else {
      await flush();
      if (end === 'close') r.events.close();
      else await r.advance(1000);
    }
    await flush();
    assert.deepEqual(pending.value, { cursor: 'fixture-cursor-1', messages: [], unchanged: true });
    assert.equal(r.events.waiting, 0);
    assert.equal(r.timers.size, 0);
    const count = r.calls.length;
    gate.resolve({ cursor: 'fixture-cursor-1', unchanged: true }); await flush();
    assertStopped(r);
    await r.advance(30000);
    assert.equal(r.calls.length, count);
    if (end === 'abort-before-read') assert.equal(count, 0);
  });
});

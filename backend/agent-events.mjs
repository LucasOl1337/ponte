// Agent transitions for a phone that is not looking: one watcher on the PC
// compares each agent's state between scans and keeps the last events, and a
// long-poll hands them out. The watcher only scans while someone is waiting
// (or shortly after the last request), so an idle server does no work and the
// phone never polls: its request just sits open until there is news.

const EVENT_LIMIT = 50;
const WAITER_LIMIT = 4;
const MAX_WAIT_S = 50;

export function createAgentEvents(options = {}) {
  const list = options.list;
  const now = options.now || Date.now;
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  const scanMs = options.scanMs ?? 5000;
  const lingerMs = options.lingerMs ?? 60000;
  const quietMs = options.quietMs ?? 5000;
  let seq = 0, previous = null, timer = null, scanning = false, lastDemand = -Infinity, closed = false;
  const events = [];
  const waiters = new Set();
  const replied = new Map();

  const active = () => !closed && (waiters.size > 0 || now() - lastDemand < lingerMs);
  const pending = after => events.filter(event => event.seq > after);

  function finish(waiter) {
    if (!waiters.delete(waiter)) return;
    clearTimer(waiter.timer);
    waiter.signal?.removeEventListener('abort', waiter.abort);
    lastDemand = now();
    waiter.resolve({ seq, events: pending(waiter.after) });
  }

  // Only working → waiting and working → ready are news. Automated agents
  // (headless) and an agent the phone itself just answered never are.
  function compare(items) {
    const at = now();
    for (const [id, when] of replied) if (at - when >= quietMs) replied.delete(id);
    const next = new Map();
    const fresh = [];
    for (const item of items) {
      if (!item || typeof item.id !== 'string') continue;
      next.set(item.id, item.state);
      if (!previous || item.headless || previous.get(item.id) !== 'working') continue;
      if (item.state !== 'waiting' && item.state !== 'ready') continue;
      if (replied.has(item.id)) continue;
      fresh.push({ seq: ++seq, id: item.id, kind: String(item.kind || ''), title: String(item.title || ''), to: item.state,
        waitingFor: item.state === 'waiting' && typeof item.waitingFor === 'string' ? item.waitingFor : null, at });
    }
    previous = next;
    if (!fresh.length) return;
    events.push(...fresh);
    if (events.length > EVENT_LIMIT) events.splice(0, events.length - EVENT_LIMIT);
    for (const waiter of [...waiters]) finish(waiter);
  }

  async function tick() {
    timer = null;
    // Stopped long enough that the last states are stale: start over from a
    // fresh baseline instead of reporting a change nobody saw happen.
    if (!active()) { previous = null; return; }
    scanning = true;
    try {
      const result = await list();
      if (!closed) compare(Array.isArray(result?.items) ? result.items : []);
    } catch {}
    finally { scanning = false; }
    if (active()) timer = setTimer(tick, scanMs);
    else previous = null;
  }

  function wake() {
    if (!closed && !timer && !scanning) tick();
  }

  // after: the last seq this client saw. Without one, or with one from a
  // previous server run (larger than ours), the answer is only the baseline.
  function wait({ after = null, wait: seconds = 0, signal } = {}) {
    lastDemand = now();
    wake();
    if (closed || after === null || !Number.isSafeInteger(after) || after < 0 || after > seq) return Promise.resolve({ seq, events: [] });
    const ready = pending(after);
    const limit = Math.max(0, Math.min(MAX_WAIT_S, Math.floor(Number(seconds) || 0)));
    if (ready.length || !limit || signal?.aborted) return Promise.resolve({ seq, events: ready });
    return new Promise(resolve => {
      const waiter = { after, resolve, signal };
      // A phone that reconnects leaves its old request behind; the oldest
      // waiter makes room instead of the newest being refused.
      if (waiters.size >= WAITER_LIMIT) finish(waiters.values().next().value);
      waiter.timer = setTimer(() => finish(waiter), limit * 1000);
      waiter.abort = () => finish(waiter);
      signal?.addEventListener('abort', waiter.abort, { once: true });
      waiters.add(waiter);
    });
  }

  function markReplied(id) { if (typeof id === 'string') replied.set(id, now()); }

  function close() {
    closed = true;
    if (timer) { clearTimer(timer); timer = null; }
    for (const waiter of [...waiters]) finish(waiter);
  }

  return { wait, replied: markReplied, close, get seq() { return seq; }, get waiting() { return waiters.size; }, get watching() { return !!timer || scanning; } };
}

const TRANSCRIPT_WAITER_LIMIT = 6;
const TRANSCRIPT_MAX_WAIT_S = 10;

// The existing transcript route can long-poll without a new APK endpoint.
// One watcher per agent shares reads, but has no timer or lingering work once
// the last request ends. Cursors and transcript payloads belong to read().
export function createTranscriptEvents(options = {}) {
  const read = options.read;
  if (typeof read !== 'function') throw new TypeError('read must be a function');
  const now = options.now || Date.now;
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  const scanMs = options.scanMs ?? 1000;
  const watchers = new Map();
  const waiters = new Set();
  let closed = false;

  const unchanged = waiter => ({ ...(waiter.last || { cursor: waiter.since }), messages: [], unchanged: true });
  const held = watcher => [...watcher.waiters].filter(waiter => waiter.held);

  function release(watcher) {
    if (watcher.waiters.size) return;
    if (watcher.timer !== null) { clearTimer(watcher.timer); watcher.timer = null; }
    // An uncancellable read may still be finishing. Keep its single-flight
    // slot until it ends so a reconnect cannot start a parallel read.
    if (!watcher.inflight && watchers.get(watcher.id) === watcher) watchers.delete(watcher.id);
  }

  function finish(waiter, result = unchanged(waiter), error = null) {
    if (!waiters.delete(waiter)) return;
    waiter.watcher.waiters.delete(waiter);
    if (waiter.timer !== null) clearTimer(waiter.timer);
    waiter.signal?.removeEventListener('abort', waiter.abort);
    release(waiter.watcher);
    if (error) waiter.reject(error);
    else waiter.resolve(result);
  }

  // Requests with the same cursor share a read. A different cursor must ask
  // read() again, since an unchanged payload need not contain any messages.
  // All reads for an id, initial or periodic, use this same serialized slot.
  async function readFor(watcher, since, active) {
    while (watcher.inflight) {
      const flight = watcher.inflight;
      const result = await flight.promise;
      if (flight.since === since && result !== null) return result;
      if (!active()) return null;
    }
    if (!active()) return null;
    const flight = { since, promise: null };
    flight.promise = Promise.resolve().then(() => active() ? read(watcher.id, { since }) : null);
    watcher.inflight = flight;
    try {
      return await flight.promise;
    } finally {
      if (watcher.inflight === flight) watcher.inflight = null;
      release(watcher);
    }
  }

  function schedule(watcher) {
    if (closed || watcher.timer !== null || watcher.scanning || !held(watcher).length) return;
    watcher.timer = setTimer(() => scan(watcher), scanMs);
  }

  async function scan(watcher) {
    watcher.timer = null;
    if (closed || !held(watcher).length) return;
    watcher.scanning = true;
    try {
      for (const since of new Set(held(watcher).map(waiter => waiter.since))) {
        const active = () => !closed && held(watcher).some(waiter => waiter.since === since);
        const result = await readFor(watcher, since, active);
        if (!result || !active()) continue;
        for (const waiter of held(watcher)) if (waiter.since === since) waiter.last = result;
        if (result.unchanged !== true) {
          for (const waiter of held(watcher)) if (waiter.since === since) finish(waiter, result);
        }
      }
    } catch (error) {
      // A departed agent must stay a 404, not look like an unchanged poll.
      for (const waiter of [...watcher.waiters]) finish(waiter, null, error);
    } finally {
      watcher.scanning = false;
      release(watcher);
      schedule(watcher);
    }
  }

  async function initial(waiter, limitMs) {
    const active = () => !closed && waiters.has(waiter);
    try {
      const result = await readFor(waiter.watcher, waiter.since, active);
      if (!active()) return;
      waiter.last = result;
      if (waiter.since === null || result.unchanged !== true || !limitMs) return finish(waiter, result);
      const remaining = waiter.deadline - now();
      if (remaining <= 0) return finish(waiter, result);
      waiter.held = true;
      schedule(waiter.watcher);
    } catch (error) { finish(waiter, null, error); }
  }

  function wait(id, { since = null, wait: seconds = 0, signal } = {}) {
    const watcher = watchers.get(id) || { id, waiters: new Set(), timer: null, inflight: null, scanning: false };
    const limitMs = Math.max(0, Math.min(TRANSCRIPT_MAX_WAIT_S, Math.floor(Number(seconds) || 0))) * 1000;
    if (closed || signal?.aborted) return Promise.resolve({ cursor: since, messages: [], unchanged: true });
    watchers.set(id, watcher);
    return new Promise((resolve, reject) => {
      const waiter = { watcher, since, signal, resolve, reject, timer: null, held: false, deadline: now() + limitMs };
      waiter.abort = () => finish(waiter);
      waiters.add(waiter);
      watcher.waiters.add(waiter);
      signal?.addEventListener('abort', waiter.abort, { once: true });
      // Six open requests globally, even during the initial read. A reconnect
      // frees the oldest rather than making the new phone request fail.
      if (waiters.size > TRANSCRIPT_WAITER_LIMIT) finish(waiters.values().next().value);
      if (since !== null && limitMs) waiter.timer = setTimer(() => finish(waiter), limitMs);
      initial(waiter, limitMs);
    });
  }

  function close() {
    closed = true;
    for (const waiter of [...waiters]) finish(waiter);
    for (const watcher of watchers.values()) if (watcher.timer !== null) { clearTimer(watcher.timer); watcher.timer = null; }
    watchers.clear();
  }

  return { wait, close, get waiting() { return waiters.size; }, get watching() { return !closed && [...watchers.values()].some(watcher => watcher.timer !== null || watcher.scanning || watcher.inflight); } };
}

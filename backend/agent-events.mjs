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

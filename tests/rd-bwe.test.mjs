import test from 'node:test';
import assert from 'node:assert/strict';
import { createBwe } from '../backend/rd-bwe.mjs';

// A link with one queue: a frame is served at `kbps`, waits for whatever is
// still draining ahead of it, then crosses in `baseMs` plus jitter. Sending
// under its capacity never builds a queue; sending over it builds one that
// grows for as long as it lasts, which is exactly the gradient the estimator
// is looking for.
function makeLink({ kbps, baseMs = 20, jitterMs = 0, seed = 7 }) {
  let free = 0, state = seed;
  const random = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
  return {
    set capacity(value) { kbps = value; },
    send(at, bytes) {
      const start = Math.max(at, free);
      free = start + bytes * 8 / kbps;
      return free + baseMs + (jitterMs ? (random() - 0.5) * 2 * jitterMs : 0);
    },
  };
}

// Sends `kbps` at `fps` over the link for `seconds`, feeding every arrival to
// the estimator the way an ack does. Returns the estimator and a trace.
function run({ bwe, link, clock, kbps, fps = 20, seconds = 4, at = 0 }) {
  const bytes = kbps * 125 / fps, gap = 1000 / fps;
  const arrived = [];
  const trace = [];
  for (let i = 0; i < seconds * fps; i++) {
    const sentAt = at + i * gap;
    const rx = link.send(sentAt, bytes);
    clock.t = rx + 20;            // the ack takes the return path home
    arrived.push({ rx, bytes });
    while (arrived.length && arrived[0].rx < rx - 1000) arrived.shift();
    const span = Math.max(200, rx - arrived[0].rx);
    const delivered = arrived.reduce((sum, item) => sum + item.bytes, 0) * 8 / span;
    const verdict = bwe.ack(sentAt, rx, delivered);
    trace.push({ sentAt, rx, queue: rx - sentAt, verdict, target: bwe.target, trend: bwe.trend });
  }
  return { trace, last: trace.at(-1) };
}

test('a link with room shows no trend, and the estimate clears the rate being sent', () => {
  const clock = { t: 0 };
  const bwe = createBwe({ startKbps: 1000, now: () => clock.t });
  const link = makeLink({ kbps: 10000 });
  const { trace, last } = run({ bwe, link, clock, kbps: 2000, seconds: 4 });
  const overuse = trace.filter(item => item.verdict === 'overuse');
  assert.equal(overuse.length, 0, `no congestion on an idle link: ${JSON.stringify(overuse.slice(0, 3))}`);
  assert.ok(Math.abs(last.trend) < 0.05, `the accumulated delay is flat, trend ${last.trend}`);
  // GCC only ever confirms the rate being sent plus its margin: capacity you
  // never asked for cannot be measured. And its own ramp is 8% a second, which
  // from a 1000 kbps seed is 1.08^4 over four seconds, nothing like the 10000
  // the link really carries. So the target is a bound, not the answer; what
  // tells the ladder to climb is the flat gradient.
  assert.ok(last.target > 1000 * 1.08 ** 3, `the ramp ran: ${Math.round(last.target)} kbps`);
  assert.equal(bwe.state, 'increase');
  assert.ok(bwe.calm > 2500, `and the gradient stayed flat throughout: ${bwe.calm} ms`);
});

test('asking for twice what the link carries is caught, and the estimate lands under capacity', () => {
  const clock = { t: 0 };
  const bwe = createBwe({ startKbps: 4000, now: () => clock.t });
  const link = makeLink({ kbps: 3000 });
  const { trace } = run({ bwe, link, clock, kbps: 6000, seconds: 4 });
  const first = trace.findIndex(item => item.verdict === 'overuse');
  assert.ok(first > 0, `the gradient saw the queue: ${JSON.stringify(trace.slice(5, 11))}`);
  // Twice over capacity is the easy case, and the slowest to report: the
  // frames themselves arrive 100 ms apart, so no estimator can answer before a
  // handful of them have. What the gradient must not be is slower than the
  // threshold path it replaces, which fires on a second in flight.
  assert.ok(trace[first].queue < 700, `caught at ${Math.round(trace[first].queue)} ms of queue`);
  assert.equal(bwe.calm, null, 'and no permission to climb while it lasts');
  assert.ok(trace.at(-1).target < 3000, `the estimate fell under the real capacity: ${trace.at(-1).target}`);
  assert.ok(trace.at(-1).target > 3000 * 0.5, `and not into the floor: ${trace.at(-1).target}`);
});

test('ten percent over capacity is caught long before any queue threshold would fire', () => {
  const clock = { t: 0 };
  const bwe = createBwe({ startKbps: 3000, now: () => clock.t });
  const link = makeLink({ kbps: 3000 });
  // Barely over: the queue grows 5 ms per frame. This is the case a threshold
  // is bad at. 150 ms of queue takes 1.7 s to build and then has to hold for
  // another 500 ms before the old path calls it congestion, and every frame in
  // between is late.
  const { trace } = run({ bwe, link, clock, kbps: 3300, seconds: 6 });
  const first = trace.findIndex(item => item.verdict === 'overuse');
  assert.ok(first > 0, `the gradient saw it: trend ${trace.at(-1).trend}`);
  // What matters is when, not the exact queue depth: the old path could not
  // call this congestion before 2.2 s, and every frame until then was late.
  assert.ok(trace[first].sentAt < 1800,
    `caught at ${Math.round(trace[first].sentAt)} ms, against the old path's 2.2 s`);
  assert.ok(trace[first].queue - 20 < 200, `with ${Math.round(trace[first].queue - 20)} ms of queue built`);
});

test('the estimate lands near the capacity of a link that is actually probed', () => {
  const clock = { t: 0 };
  const bwe = createBwe({ startKbps: 1000, now: () => clock.t });
  const link = makeLink({ kbps: 5000 });
  // Climb the way the ladder does, one rate at a time, past the capacity.
  let at = 0;
  for (const kbps of [2000, 4000, 6000, 8000]) {
    const pass = run({ bwe, link, clock, kbps, seconds: 3, at });
    at = pass.last.sentAt + 50;
  }
  assert.ok(bwe.target !== null, 'the filter filled');
  assert.ok(bwe.target > 5000 * 0.6 && bwe.target < 5000 * 1.3,
    `the estimate knows the link: ${Math.round(bwe.target)} kbps against 5000`);
  assert.ok(bwe.capacity !== null && bwe.capacity > 3000,
    `and remembers where it broke: ${bwe.capacity}`);
});

test('jitter on a link with room is not congestion', () => {
  const clock = { t: 0 };
  const bwe = createBwe({ startKbps: 1000, now: () => clock.t });
  // The measured link: 14 ms floor, spikes to 102, mdev 16.8.
  const link = makeLink({ kbps: 20000, baseMs: 14, jitterMs: 25 });
  const { trace } = run({ bwe, link, clock, kbps: 2000, seconds: 6 });
  const overuse = trace.filter(item => item.verdict === 'overuse').length;
  assert.ok(overuse <= 1, `jitter alone cost ${overuse} congestion events`);
  assert.ok(trace.at(-1).target > 1000 * 1.08 ** 4, `and did not stop the climb: ${Math.round(trace.at(-1).target)}`);
});

test('a link that narrows mid-session is caught within a second', () => {
  const clock = { t: 0 };
  const bwe = createBwe({ startKbps: 1000, now: () => clock.t });
  const link = makeLink({ kbps: 10000 });
  const warm = run({ bwe, link, clock, kbps: 3000, seconds: 4 });
  const before = bwe.target;
  link.capacity = 1200;
  const after = run({ bwe, link, clock, kbps: 3000, seconds: 2, at: warm.last.sentAt + 50 });
  const first = after.trace.findIndex(item => item.verdict === 'overuse');
  assert.ok(first >= 0, 'the narrowing was seen');
  assert.ok(after.trace[first].sentAt - (warm.last.sentAt + 50) < 1000,
    `within a second: ${Math.round(after.trace[first].sentAt - warm.last.sentAt)} ms`);
  assert.ok(bwe.target < before, `and the estimate came down: ${before} to ${bwe.target}`);
});

test('a restart clears the delay the blackout would have looked like, and keeps what was learnt', () => {
  const clock = { t: 0 };
  const bwe = createBwe({ startKbps: 1000, now: () => clock.t });
  const link = makeLink({ kbps: 3000 });
  run({ bwe, link, clock, kbps: 5000, seconds: 4 });
  const target = bwe.target, capacity = bwe.capacity;
  assert.ok(target !== null && capacity !== null);
  bwe.restart();
  assert.equal(bwe.target, null, 'it will not steer on half a window again');
  assert.equal(bwe.trend, 0);
  assert.equal(bwe.capacity, capacity, 'the capacity it measured is not forgotten');
  assert.equal(bwe.samples, 0);
});

test('an ack with no arrival time is ignored, so a page that does not report one changes nothing', () => {
  const bwe = createBwe({ startKbps: 1000, now: () => 0 });
  assert.equal(bwe.ack(100, undefined, 2000), null);
  assert.equal(bwe.ack(100, null, 2000), null);
  assert.equal(bwe.ack(undefined, 100, 2000), null);
  assert.equal(bwe.target, null);
  assert.equal(bwe.samples, 0);
});

test('acks out of order or from the same instant carry no gradient', () => {
  const bwe = createBwe({ startKbps: 1000, now: () => 0 });
  assert.equal(bwe.ack(1000, 1020, 2000), null, 'the first has nothing to compare against');
  assert.equal(bwe.ack(1000, 1040, 2000), null, 'same send instant');
  assert.equal(bwe.ack(900, 1010, 2000), null, 'older than the last');
  assert.equal(bwe.samples, 0);
});

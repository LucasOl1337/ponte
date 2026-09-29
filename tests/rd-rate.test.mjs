import test from 'node:test';
import assert from 'node:assert/strict';
import { createRateControl, scaleBox, WAN_STEPS, INITIAL_STEP, LAN_RTT_MS } from '../backend/rd-rate.mjs';

// A control on a fake clock; `report` sends one stats message a second later.
function control(options = {}) {
  let clock = 0;
  const c = createRateControl({ now: () => clock, ...options });
  const at = ms => { clock = ms; };
  const pass = ms => { clock += ms; };
  const report = (fields = {}) => { clock += 1000; return c.stats({ fps: 30, kbps: 2000, rtt: 30, queue: 0, drops: 0, ...fields }); };
  return { c, at, pass, report, get clock() { return clock; } };
}

test('opening: a round trip under 15 ms is the LAN (params null), anything else opens on the WAN initial step', () => {
  assert.equal(LAN_RTT_MS, 15);
  const lan = control();
  assert.equal(lan.c.open(4), null);
  assert.equal(lan.c.mode, 'lan');
  const wan = control();
  assert.deepEqual(wan.c.open(22), { fps: 30, kbps: 2500, keyint: 60, maxWidth: 1920 });
  assert.equal(wan.c.step, INITIAL_STEP);
  assert.equal(control().c.open(null)?.kbps, 2500, 'no answer in time: the WAN');
  // A page that can ask for keyframes gets the long interval; its stage caps the width.
  assert.deepEqual(control({ caps: { key: true }, view: { width: 1600, height: 900 }, maxFps: 24 }).c.open(40), { fps: 24, kbps: 2500, keyint: 300, maxWidth: 1600 });
});

test('scaleBox keeps the aspect and even sizes, and is null when the monitor already fits', () => {
  assert.deepEqual(scaleBox({ width: 3440, height: 1440 }, 1920), { width: 1920, height: 804 });
  assert.deepEqual(scaleBox({ width: 2560, height: 1440 }, 1280), { width: 1280, height: 720 });
  assert.equal(scaleBox({ width: 1920, height: 1080 }, 1920), null);
  assert.equal(scaleBox({ width: 1920, height: 1080 }, null), null);
});

test('old page: a queue in two reports in a row steps down at once to what the delivered rate carries', () => {
  const t = control();
  t.c.open(25);
  for (let i = 0; i < 5; i++) assert.equal(t.report(), null);
  assert.equal(t.report({ rtt: 300, kbps: 1500 }), null, 'one report is not a trend');
  const down = t.report({ rtt: 320, kbps: 1500 });
  // 80% of ~1667 kbps delivered carries W1 (1000 kbps), two steps down, one restart.
  assert.equal(down.reason, 'down');
  assert.equal(t.c.step, 1);
  assert.deepEqual(down.params, { fps: 15, kbps: 1000, keyint: 60, maxWidth: 1920 });
  // Right after a restart the old queue may still show: no second step for 3 s.
  assert.equal(t.report({ rtt: 400, kbps: 900 }), null);
});

test('old page: a queue over a second steps down without waiting for a second report', () => {
  const t = control();
  t.c.open(25);
  for (let i = 0; i < 4; i++) t.report();
  assert.equal(t.report({ rtt: 1500, kbps: 1200 })?.reason, 'down');
});

test('a keyframe crossing the link is not congestion: its bytes ÷ the delivered rate are excused, the p95 for its whole window', () => {
  const t = control();
  t.c.open(25);
  for (let i = 0; i < 6; i++) t.report({ kbps: 2400, p95: 60 });
  t.c.sent(110000, true); // ~370 ms at 2.4 Mbps
  assert.equal(t.report({ rtt: 380, kbps: 2400, p95: 400 }), null);
  assert.equal(t.report({ rtt: 30, kbps: 2400, p95: 400 }), null);
  assert.equal(t.report({ rtt: 30, kbps: 2400, p95: 350 }), null);
  assert.equal(t.c.step, INITIAL_STEP);
});

test('up: one step after 30 s calm, never within 60 s of the last change, and only with reports coming', () => {
  const t = control();
  t.c.open(25);
  for (let i = 0; i < 4; i++) t.report();
  t.report({ rtt: 400, kbps: 1500 }); t.report({ rtt: 400, kbps: 1500 });
  assert.equal(t.c.step, 1);
  for (let i = 0; i < 59; i++) { t.report({ kbps: 900 }); assert.equal(t.c.tick(), null, `second ${i}`); }
  t.report({ kbps: 900 });
  const up = t.c.tick();
  assert.equal(up.reason, 'up');
  assert.equal(t.c.step, 2);
  t.pass(61000);
  assert.equal(t.c.tick(), null, 'no reports for a minute: no climbing blind');
  // Not calm: a report with a queue over 50 ms restarts the 30 s.
  for (let i = 0; i < 40; i++) t.report({ rtt: i === 35 ? 100 : 30 });
  assert.equal(t.c.tick(), null);
});

test('backoff: on a steady 2.5 Mbps link a step that fails is retried after 1, 2, 4 and then 8 minutes, never more often', () => {
  // The link carries W2 (1600) but W3 (2500) builds a queue after a few seconds.
  const t = control();
  t.c.open(25);
  const events = [];
  let atStep = 0;
  for (let second = 0; second < 40 * 60; second++) {
    const over = WAN_STEPS[t.c.step].kbps > 2000 && second - atStep > 4;
    const decision = t.report({ rtt: over ? 400 : 30, kbps: Math.min(WAN_STEPS[t.c.step].kbps * 0.7, 2200) }) || t.c.tick();
    if (decision) { events.push({ second, reason: decision.reason, step: t.c.step }); atStep = second; }
  }
  const ups = events.filter(e => e.reason === 'up' && e.step === 3);
  const failed = ups.filter(up => events.some(e => e.reason === 'down' && e.second > up.second && e.second - up.second <= 20));
  assert.equal(failed.length, ups.length, 'every climb to W3 fails on this link');
  const gaps = failed.slice(1).map((up, i) => up.second - failed[i].second);
  assert.ok(gaps.every((gap, i) => gap >= 60 * Math.min(8, 2 ** (i + 1))), `gaps ${gaps}`);
  // In the regime (after the first 16 minutes) at most one failed climb per 8 minutes.
  const late = failed.filter(up => up.second >= 16 * 60);
  for (let i = 1; i < late.length; i++) assert.ok(late[i].second - late[i - 1].second >= 8 * 60);
  assert.ok(late.length <= 3, `${late.length} failed climbs in 24 minutes`);
});

test('backoff resets after 10 minutes steady one step below: the next failure waits 2 minutes again, not 8', () => {
  const t = control();
  t.c.open(25);
  const climbAndFail = () => {
    let up = null;
    for (let i = 0; i < 20 * 60 && !up; i++) { t.report({ kbps: 5000 }); up = t.c.tick(); }
    assert.equal(up?.reason, 'up');
    const upAt = t.clock;
    t.report({ rtt: 500, kbps: 3200 }); t.report({ rtt: 500, kbps: 3200 });
    assert.equal(t.report({ rtt: 500, kbps: 3200 })?.reason, 'down');
    return upAt;
  };
  const first = climbAndFail(), second = climbAndFail(), third = climbAndFail();
  assert.ok(second - first >= 120000 && third - second >= 240000, `${second - first} ${third - second}`);
  // Ten minutes at W3 with a small queue every 20 s (never 30 s calm, never congested): no climbing, and the backoff for W4 clears.
  for (let i = 0; i < 601; i++) { t.report({ rtt: i % 20 ? 30 : 90, kbps: 2400 }); assert.equal(t.c.tick(), null); }
  const fourth = climbAndFail(), fifth = climbAndFail();
  assert.ok(fifth - fourth < 180000, `after the reset the wait is back to 2 minutes, got ${fifth - fourth}`);
});

test('keyframes on request: explicit or, for a page that cannot ask, its dropped frames; merged within 2 s; four a minute step down', () => {
  const silent = control();
  silent.c.open(25);
  for (let i = 0; i < 4; i++) silent.report();
  assert.equal(silent.report({ drops: 3 })?.reason, 'key');
  assert.equal(silent.report({ drops: 5 }), null, 'the page counts drops until the keyframe comes: merged');
  silent.pass(2000);
  assert.equal(silent.report({ drops: 2 })?.reason, 'key');
  silent.pass(3000);
  assert.equal(silent.report({ drops: 2 })?.reason, 'key');
  silent.pass(3000);
  const fourth = silent.report({ drops: 2 });
  assert.equal(fourth.reason, 'down', 'a decoder that keeps losing frames needs less');
  assert.equal(silent.c.step, INITIAL_STEP - 1);

  const asks = control({ caps: { key: true } });
  asks.c.open(25);
  for (let i = 0; i < 4; i++) asks.report();
  assert.equal(asks.report({ drops: 9 }), null, 'a page that asks is not guessed for');
  assert.equal(asks.c.key()?.reason, 'key');
  asks.pass(1500);
  assert.equal(asks.c.key(), null);
  asks.pass(600);
  assert.equal(asks.c.key()?.reason, 'key', 'always honoured, outside the climbing budget');

  const lan = control();
  lan.c.open(3);
  assert.equal(lan.report({ drops: 4 }), null, 'the LAN has a keyframe every second');
  assert.equal(lan.c.key(), null);
});

test('a delta the session drops for its own buffer asks for a new run on the WAN, a step lower; merged within 2 s; a key on the floor', () => {
  const t = control();
  t.c.open(25);
  for (let i = 0; i < 4; i++) t.report({ kbps: 2100 });
  assert.equal(t.c.drop().reason, 'down');
  assert.equal(t.c.step, 2, '80% of 2.1 Mbps carries W2');
  t.pass(1000);
  assert.equal(t.c.drop(), null);
  const lan = control();
  lan.c.open(2);
  assert.equal(lan.c.drop(), null);
  const bottom = control();
  bottom.c.open(25);
  for (let i = 0; i < 4; i++) bottom.report({ kbps: 300 });
  bottom.c.drop();
  assert.equal(bottom.c.step, 0);
  bottom.pass(2500);
  assert.equal(bottom.c.drop().reason, 'key');
});

test('LAN → WAN: a round trip over 15 ms for 5 s, or a queue, moves the session to the steps (at most the initial one); never back', () => {
  const far = control();
  far.c.open(4);
  for (let i = 0; i < 3; i++) assert.equal(far.report({ rtt: 30, kbps: 11000 }), null);
  const moved = far.report({ rtt: 31, kbps: 11000 });
  assert.equal(moved.reason, 'wan');
  assert.equal(far.c.mode, 'wan');
  assert.equal(far.c.step, INITIAL_STEP, 'a fast link still starts at the initial step');
  for (let i = 0; i < 20; i++) far.report({ rtt: 2, kbps: 2000 });
  assert.equal(far.c.mode, 'wan');

  const queued = control();
  queued.c.open(8);
  queued.report({ rtt: 8, kbps: 3000 });
  queued.report({ rtt: 400, kbps: 2800 });
  const move = queued.report({ rtt: 450, kbps: 2800 });
  assert.equal(move.reason, 'wan');
  assert.equal(queued.c.step, 2, '80% of 2.8 Mbps carries W2');
});

test('on the floor, a queue that keeps growing sheds frames until it drains, then restarts with a keyframe', () => {
  const t = control();
  t.c.open(60);
  for (let i = 0; i < 4; i++) t.report({ rtt: 60, kbps: 400 });
  t.report({ rtt: 400, kbps: 400 }); t.report({ rtt: 400, kbps: 400 });
  assert.equal(t.c.step, 0);
  for (let i = 0; i < 2; i++) assert.equal(t.report({ rtt: 700, kbps: 400 }), null, 'settling after the restart');
  assert.equal(t.report({ rtt: 800, kbps: 400 })?.reason, 'shed');
  assert.equal(t.c.shedding, true);
  assert.equal(t.c.tick(), null, 'no climbing while shedding');
  assert.equal(t.report({ rtt: 300 }), null);
  assert.equal(t.report({ rtt: 70 })?.reason, 'key');
  assert.equal(t.c.shedding, false);
});

// ---- pages that ack -------------------------------------------------------------------

// A link simulated in 5 ms slices: an encoder at the control's step (a
// keyframe of ~44 bytes per kbps after each ~450 ms restart gap), a FIFO
// bottleneck of `capacity(t)` kbps with `oneWay` ms each way, and a page that
// acks the last frame it got at most every 50 ms. Decisions are applied like
// the session does; the report has what happened.
function simulate({ seconds, capacity, oneWay = 12, open = 30, caps = { ack: true, key: true }, onDecision } = {}) {
  let clock = 0, seq = 0, restartAt = 0, nextFrame = 450, linkFree = 0, lastAckSent = -Infinity, pendingAck = null;
  const c = createRateControl({ now: () => clock, caps });
  const arrivals = [], acks = [], events = [], delays = [];
  const LAN = { fps: 60, kbps: 12000 };
  let params = c.open(open) || LAN, keyNext = true, shed = false;
  const apply = decision => {
    if (!decision) return;
    events.push({ at: clock, reason: decision.reason, step: c.step });
    onDecision?.(decision, clock);
    if (decision.reason === 'shed') { shed = true; return; }
    shed = false; params = decision.params || LAN; restartAt = clock; nextFrame = clock + 450; keyNext = true;
  };
  for (; clock < seconds * 1000; clock += 5) {
    if (clock >= nextFrame) {
      nextFrame += 1000 / params.fps;
      if (!shed) {
        const bytes = keyNext ? params.kbps * 44 : Math.round(params.kbps * 125 / params.fps);
        const keyframe = keyNext; keyNext = false;
        seq++;
        const start = Math.max(clock + oneWay, linkFree);
        linkFree = start + bytes * 8 / capacity(start);
        arrivals.push({ seq, sentAt: clock, arriveAt: linkFree });
        apply(c.sent(bytes, keyframe, seq));
      }
    }
    while (arrivals.length && arrivals[0].arriveAt <= clock) {
      const frame = arrivals.shift();
      delays.push({ at: clock, value: clock - frame.sentAt });
      pendingAck = frame.seq;
    }
    if (pendingAck !== null && clock - lastAckSent >= 50) { acks.push({ seq: pendingAck, at: clock + oneWay }); pendingAck = null; lastAckSent = clock; }
    while (acks.length && acks[0].at <= clock) apply(c.ack(acks.shift().seq));
    if (clock % 1000 === 0) apply(c.tick());
  }
  return { c, events, delays };
}

test('acks: ignored when invalid, repeated, from the future or unknown, and the history stays bounded', () => {
  let clock = 0;
  const c = createRateControl({ now: () => clock, caps: { ack: true } });
  c.open(30);
  for (let seq = 1; seq <= 10; seq++) { clock += 33; c.sent(3000, seq === 1, seq); }
  for (const junk of [null, '5', 5.5, -1, 0, 11, 1e12, NaN, Infinity]) assert.equal(c.ack(junk), null);
  clock += 40;
  c.ack(5);
  assert.equal(c.ack(5), null, 'repeated');
  assert.equal(c.ack(3), null, 'out of order');
  // A page that stops acking: at most 10 s of frames are kept.
  for (let seq = 11; seq < 20000; seq++) { clock += 16; c.sent(1000, false, seq); c.tick?.(); }
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 100000; i++) c.ack(1 + (i % 50));
  assert.ok(process.memoryUsage().heapUsed - before < 20e6);
  // Without caps.ack nothing is tracked.
  const old = createRateControl({ now: () => clock });
  old.open(30);
  assert.equal(old.sent(1000, false, 1), null);
  assert.equal(old.ack(1), null);
});

test('acks: a queue over 150 ms held for half a second steps down at once to what the acked bytes carry; a shorter one does not', () => {
  // 2.5 Mbps until 10 s, then 1.3 Mbps.
  const { c, events, delays } = simulate({ seconds: 20, capacity: t => t < 10000 ? 3200 : 1300 });
  const downs = events.filter(e => e.reason === 'down');
  assert.equal(downs.length, 1, JSON.stringify(events));
  assert.ok(downs[0].at > 10000 && downs[0].at < 11500, `down at ${downs[0].at}`);
  assert.equal(c.step, 1, '80% of ~1.3 Mbps carries W1');
  // The old queue drains with the 20% left free, and within ~3 s of the down.
  const after = delays.filter(d => d.at > 14000).map(d => d.value);
  assert.ok(Math.max(...after) < 250, `delay after ${Math.max(...after)}`);
  // A dip that queues over 150 ms for less than half a second is no congestion.
  const blip = simulate({ seconds: 20, capacity: t => t >= 10000 && t < 10400 ? 800 : 3200 });
  const peak = Math.max(...blip.delays.filter(d => d.at > 10000 && d.at < 12000).map(d => d.value));
  assert.ok(peak > 150 + 55, `peak ${peak}`);
  assert.equal(blip.events.filter(e => e.reason === 'down').length, 0, JSON.stringify(blip.events));
  // Nor is one that drains: a queue falling from its peak means the step fits.
  const drains = simulate({ seconds: 20, capacity: t => t >= 10000 && t < 10300 ? 1200 : 6000 });
  assert.equal(drains.events.filter(e => e.reason === 'down').length, 0, JSON.stringify(drains.events));
});

test('acks: the keyframe of a new run (110 KB at 2.5 Mbps, ~350 ms) is no congestion', () => {
  const { events } = simulate({ seconds: 30, capacity: () => 2700, open: 30 });
  assert.deepEqual(events.filter(e => e.reason !== 'up'), []);
});

test('acks: frames in flight for over a second step down without waiting for any ack', () => {
  let clock = 0;
  const c = createRateControl({ now: () => clock, caps: { ack: true, key: true } });
  c.open(30);
  let seq = 0;
  for (; clock < 4000; clock += 33) { c.sent(10000, false, ++seq); if (seq % 2 === 0) c.ack(seq); }
  let decision = null;
  // The link stops: nothing is acked any more.
  for (let i = 0; i < 40 && !decision; i++) { clock += 33; decision = c.sent(10000, false, ++seq); }
  assert.equal(decision?.reason, 'down');
  assert.ok(clock - 4000 <= 1300, `after ${clock - 4000} ms`);
});

test('acks: a keyframe burst measures the capacity, and a climb after the calm goes straight to what it carries (once a minute)', () => {
  // Opens at W3 on a link that fell to 1.2 Mbps, then grows to 30 Mbps at 20 s.
  const { events, c } = simulate({ seconds: 240, capacity: t => t < 20000 ? 1200 : 30000 });
  const ups = events.filter(e => e.reason === 'up');
  assert.ok(ups.length >= 1, JSON.stringify(events));
  // The first climb is one step (the samples so far saw 1.2 Mbps); its keyframe sees 30 Mbps, and the next one goes to the top.
  assert.equal(ups[1]?.step, 5, JSON.stringify(ups));
  assert.ok(ups[1].at - ups[0].at >= 60000);
  assert.equal(c.step, 5);
});

test('acks: on a steady 2.4 Mbps link a failing step is retried at most once per 8 minutes in the regime', () => {
  const { events } = simulate({ seconds: 40 * 60, capacity: () => 2400 });
  const ups = events.filter(e => e.reason === 'up');
  const failed = ups.filter(up => events.some(e => e.reason === 'down' && e.at > up.at && e.at - up.at <= 20000));
  const late = failed.filter(up => up.at >= 16 * 60000);
  for (let i = 1; i < late.length; i++) assert.ok(late[i].at - late[i - 1].at >= 8 * 60000);
  assert.ok(late.length <= 3, `${late.length} failed climbs in 24 minutes: ${JSON.stringify(events.slice(0, 20))}`);
});

test('acks: on the floor a link below it sheds frames, then restarts with a keyframe once in-flight frames drained', () => {
  const { events } = simulate({ seconds: 30, capacity: t => t < 8000 ? 3000 : t < 20000 ? 350 : 3000 });
  const reasons = events.map(e => e.reason);
  assert.ok(reasons.includes('shed'), JSON.stringify(events));
  const shedAt = reasons.indexOf('shed');
  assert.equal(reasons[shedAt + 1], 'key', JSON.stringify(events));
});

test('acks: a LAN session whose acked frames keep ageing over 15 ms, or queue, moves to the WAN steps', () => {
  const far = simulate({ seconds: 10, capacity: () => 100000, oneWay: 12, open: 4 });
  const moved = far.events.find(e => e.reason === 'wan');
  assert.ok(moved && moved.at < 6500, JSON.stringify(far.events));
  const near = simulate({ seconds: 10, capacity: () => 100000, oneWay: 1, open: 2 });
  assert.equal(near.c.mode, 'lan');
  assert.deepEqual(near.events, []);
});

test('acks: a keyframe request is merged into a restart only while its keyframe may still be on the way', () => {
  let clock = 0;
  const c = createRateControl({ now: () => clock, caps: { ack: true, key: true } });
  c.open(30);
  c.sent(40000, true, 1);
  clock += 300; c.sent(3000, false, 2);
  assert.equal(c.key(), null, 'the first keyframe has not been acked: it may fix this');
  clock += 200; c.ack(2);
  clock += 100;
  assert.equal(c.key()?.reason, 'key', 'the page got that keyframe and still asks: a new one');
  clock += 100; c.sent(40000, true, 3);
  assert.equal(c.key(), null);
});

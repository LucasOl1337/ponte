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
function simulate({ seconds, capacity, oneWay = 12, open = 30, caps = { ack: true, key: true }, onDecision, keyBytes = null } = {}) {
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
        const bytes = keyNext ? keyBytes ?? params.kbps * 44 : Math.round(params.kbps * 125 / params.fps);
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

test('acks: recovery measures a fresh keyframe before climbing, never trusting the fall sample', () => {
  // Opens at W3 on a link that fell to 1.2 Mbps, then grows to 30 Mbps at 20 s.
  const { events, c } = simulate({ seconds: 300, capacity: t => t < 20000 ? 1200 : 30000 });
  const ups = events.filter(e => e.reason === 'up');
  assert.ok(ups.length >= 1, JSON.stringify(events));
  const probe = events.find(e => e.reason === 'probe');
  const down = events.find(e => e.reason === 'down');
  assert.ok(probe && probe.at - down.at >= 60000, JSON.stringify(events));
  assert.equal(probe.step, down.step, 'measure at the safe delta rate');
  // The floor's tiny keyframe and the 50 ms ack floor only prove W2.
  // Larger keyframes of later runs measure more room, never a blind jump.
  assert.equal(ups[0]?.step, 2, JSON.stringify(events));
  assert.equal(ups[1]?.step, 4, JSON.stringify(events));
  assert.ok(ups[1].at - ups[0].at >= 60000);
  assert.ok(ups[0].at - probe.at >= 60000, 'probe and climb share the minute restart budget');
  assert.equal(c.step, 7);
});

test('acks: isolated coalescing jitter does not starve calm, but a sustained small queue does', () => {
  function run(queueAt) {
    const t = control({ caps: { ack: true, key: true } });
    t.c.open(30);
    let seq = 0, decision = null;
    for (let ms = 100; ms <= 35000; ms += 100) {
      t.at(ms); t.c.sent(1000, false, ++seq);
      t.pass(30 + queueAt(ms)); t.c.ack(seq);
      if (ms % 1000 === 0) decision = t.c.tick() || decision;
    }
    return decision;
  }
  assert.equal(run(ms => ms % 5000 === 0 ? 80 : 0)?.reason, 'up', 'isolated jitter');
  assert.equal(run(ms => ms % 5000 < 1000 ? 80 : 0), null, 'sustained 80 ms queue');
  assert.equal(run(ms => ms % 5000 === 0 ? 160 : 0), null, 'large spike still resets calm');
});

test('acks: recovery on an unchanged tight link probes at most once a minute and never climbs blind', () => {
  const { events } = simulate({ seconds: 240, capacity: () => 1200 });
  assert.equal(events.filter(e => e.reason === 'up').length, 0, JSON.stringify(events));
  const probes = events.filter(e => e.reason === 'probe');
  assert.ok(probes.length >= 2, JSON.stringify(events));
  for (let i = 1; i < probes.length; i++) assert.ok(probes[i].at - probes[i - 1].at >= 60000);
});

test('acks: probes with no room back off 2, 4, 8 minutes, capped at 10, not a pause every two minutes', () => {
  const { events } = simulate({ seconds: 3600, capacity: () => 1200 });
  const probes = events.filter(e => e.reason === 'probe');
  assert.ok(probes.filter(e => e.at < 1200000).length <= 4, JSON.stringify(probes));
  assert.equal(events.filter(e => e.reason === 'up').length, 0);
  const waits = probes.slice(1).map((e, i) => e.at - probes[i].at);
  for (let i = 0; i < waits.length; i++) {
    const expected = Math.min(600000, 120000 * 2 ** i);
    assert.ok(waits[i] >= expected && waits[i] < expected + 2000, JSON.stringify(waits));
  }
});

test('acks: useful recovery probe keeps the previous 2 to 20 Mbps climb times', () => {
  const { events } = simulate({ seconds: 300, capacity: t => t < 15000 ? 20000 : t < 45000 ? 2000 : 20000 });
  assert.deepEqual(events.filter(e => e.reason === 'up').map(e => [e.at, e.step]),
    [[3000, 5], [139000, 2], [199000, 4], [259000, 7]]);
});

test('acks: up and down clear probe backoff for the new step', () => {
  const { events } = simulate({ seconds: 900, capacity: t => t < 400000 ? 1200 : t < 650000 ? 30000 : 1200 });
  const up = events.find(e => e.reason === 'up');
  assert.ok(up, JSON.stringify(events));
  const down = events.filter(e => e.reason === 'down' && e.at >= 650000).at(-1);
  const probe = events.find(e => e.reason === 'probe' && e.at > down.at);
  assert.ok(probe.at - down.at >= 60000 && probe.at - down.at < 80000, JSON.stringify(events));
});

test('acks: no recovery probe on stable LAN, roomy WAN or the highest step', () => {
  for (const open of [4, 30]) {
    const { events, c } = simulate({ seconds: 180, capacity: () => 100000, oneWay: open === 4 ? 1 : 12, open });
    assert.equal(events.filter(e => e.reason === 'probe').length, 0, JSON.stringify(events));
    if (open === 4) assert.equal(c.mode, 'lan');
    else assert.equal(c.step, WAN_STEPS.length - 1);
  }
});

test('acks: tiny recovery keys allow only one-step trials, with backoff on a tight link', () => {
  const roomy = simulate({ seconds: 700, keyBytes: 19000, capacity: t => t < 8000 ? 1200 : 30000 });
  const ups = roomy.events.filter(e => e.reason === 'up');
  const down = roomy.events.find(e => e.reason === 'down');
  assert.ok(down && ups.length, JSON.stringify(roomy.events));
  let previous = down.step;
  for (const up of ups) { assert.equal(up.step, previous + 1); previous = up.step; }
  assert.equal(roomy.c.step, WAN_STEPS.length - 1, 'a still terminal is not stuck');

  const tight = simulate({ seconds: 1200, keyBytes: 19000, capacity: () => 1200 });
  const trials = tight.events.filter(e => e.reason === 'up' && e.step === 2);
  assert.ok(trials.length >= 2, JSON.stringify(tight.events));
  for (let i = 1; i < trials.length; i++) assert.ok(trials[i].at - trials[i - 1].at >= 120000);
  for (const trial of trials) assert.ok(tight.events.some(e => e.reason === 'down' && e.at > trial.at && e.at - trial.at <= 20000));
});

test('acks: opening on a roomy link climbs as soon as its first keyframe crossed, not after 30 s', () => {
  // A home Tailscale link: 24 ms round trip, 30 Mbps.
  const roomy = simulate({ seconds: 20, capacity: () => 30000 });
  const up = roomy.events.find(e => e.reason === 'up');
  assert.ok(up && up.at <= 4000, JSON.stringify(roomy.events));
  // What matters is landing on a step with no width ceiling: one keyframe burst
  // measures less than the whole link, so it need not be the very top.
  assert.equal(WAN_STEPS[up.step].width, null, 'straight to the native width');
  assert.ok(up.step >= 5, JSON.stringify(roomy.events));
  assert.deepEqual(roomy.events.filter(e => e.reason === 'down'), []);
  // The first keyframe of 2.5 Mbps on 2.7 Mbps measures ~2.7, not the 17.6 its own age as the base made of it.
  const tight = simulate({ seconds: 25, capacity: () => 2700 });
  assert.deepEqual(tight.events, [], 'no climb, no fall');
  // Far from the LAN but not queued (a phone's Wi-Fi waking up): the same fast opening once on the steps.
  const far = simulate({ seconds: 15, capacity: () => 100000, oneWay: 12, open: 4 });
  const reasons = far.events.map(e => `${e.reason}:${e.step}`);
  assert.equal(reasons[0], `wan:${INITIAL_STEP}`, JSON.stringify(far.events));
  // A keyframe burst cannot measure more than its own bytes over the 50 ms ack
  // floor (110 KB → ~17 Mbps), so the fast opening lands on the highest step
  // that fits half of that, not on the top of the ladder.
  assert.equal(reasons[1], 'up:5', JSON.stringify(far.events));
  assert.ok(far.events[1].at - far.events[0].at <= 4500, JSON.stringify(far.events));
});

test('acks: after a fall the opening is over; climbing waits for the long calm again', () => {
  // 1.3 Mbps for 8 s (W3 falls), then 30 Mbps.
  const { events } = simulate({ seconds: 40, capacity: t => t < 8000 ? 1300 : 30000 });
  const down = events.find(e => e.reason === 'down');
  assert.ok(down, JSON.stringify(events));
  const up = events.find(e => e.reason === 'up');
  assert.ok(!up || up.at - down.at >= 60000, JSON.stringify(events));
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

test('an older page that drops frames right after the first keyframe landed gets a new one without waiting 2 s', () => {
  let clock = 0;
  const c = createRateControl({ now: () => clock });
  c.open(30);
  clock += 450; c.sent(40000, true);
  // 40 KB at the 1.5 Mbps the page reports is ~210 ms: landed ~710 ms after it left.
  clock += 400;
  assert.equal(c.stats({ fps: 10, kbps: 1500, rtt: 30, drops: 12 }), null, 'may still be on the way');
  clock += 400;
  assert.equal(c.stats({ fps: 0, kbps: 1500, rtt: 30, drops: 20 })?.reason, 'key');
});

test('a still desktop delivers little: a stall with no queue standing steps down one, not to what the encoder happened to make', () => {
  const t = control({ caps: { ack: true, key: true } });
  t.c.open(40);
  assert.equal(t.c.step, INITIAL_STEP);
  // Five seconds of small deltas (2 KB at 15 fps, ~240 kbps), each acked 45 ms later.
  let seq = 0;
  for (let i = 0; i < 75; i++) { t.c.sent(2000, false, ++seq); t.pass(45); t.c.ack(seq); t.pass(22); }
  // The link stalls for over a second with nothing big queued.
  let decision = null;
  for (let i = 0; i < 20 && !decision; i++) { t.pass(67); decision = t.c.sent(2000, false, ++seq); }
  assert.equal(decision?.reason, 'down');
  assert.equal(t.c.step, INITIAL_STEP - 1, '240 kbps delivered is the desktop, not the link: W2, not W0');
});

test('a stage that grows lifts the width limit with one restart; the same limit restarts nothing', () => {
  const t = control({ caps: { ack: true, key: true }, view: { width: 1100, height: 700 } });
  assert.equal(t.c.open(40).maxWidth, 1100);
  const grown = t.c.view({ width: 1800, height: 1000 });
  assert.equal(grown.reason, 'view');
  assert.equal(grown.params.maxWidth, 1800);
  assert.equal(t.c.step, INITIAL_STEP);
  assert.equal(t.c.view({ width: 2400, height: 1300 })?.params.maxWidth, 1920, 'the step caps it at 1920');
  assert.equal(t.c.view({ width: 2600, height: 1400 }), null, 'still 1920: nothing to restart');
  const lan = control({ view: { width: 1100, height: 700 } });
  lan.c.open(4);
  assert.equal(lan.c.view({ width: 1800, height: 1000 }), null, 'the LAN is never scaled');
});

// A wide monitor must stay readable: scaling 3440 px down to 1920 is 56% of the
// picture, and text at 56% cannot be read however many frames arrive.
test('the readable floor: a step never blurs a wide monitor below its share, and a 1080p one keeps the ceilings it always had', () => {
  assert.deepEqual(WAN_STEPS.map(s => s.floor), [0.5, 0.75, 1, 1, 1, 1, 1, 1]);

  // 1920 monitor, every step down from the opening one: the limits it always had.
  // Each fall needs the clock to move: restarts are rationed.
  const limits = (screenWidth, target) => {
    let clock = 0;
    const c = createRateControl({ screen: screenWidth, now: () => clock });
    c.open(40);
    for (let guard = 0; c.step > target && guard < 20; guard++) { clock += 5000; c.drop(); }
    assert.equal(c.step, target, `reached step ${target}`);
    return c.params().maxWidth;
  };
  assert.deepEqual([0, 1, 2, 3].map(step => limits(1920, step)), [1280, 1920, 1920, 1920], 'unchanged for 1080p');
  // Above the opening step the ceiling was already gone for everyone.
  assert.deepEqual(WAN_STEPS.slice(4).map(s => s.width), [null, null, null, null]);

  // 3440 ultrawide: the opening step shows it whole instead of 1920, and a
  // limit as wide as the monitor is no scaling at all.
  const ultra = control({ screen: 3440 });
  assert.equal(ultra.c.open(40).maxWidth, 3440);
  assert.equal(scaleBox({ width: 3440, height: 1440 }, 3440), null, 'captured at native size');

  // 2560: the same, where it used to lose a quarter of its pixels.
  assert.equal(control({ screen: 2560 }).c.open(40).maxWidth, 2560);
  assert.equal(scaleBox({ width: 2560, height: 1440 }, 2560), null);

  // The bottom steps still scale, but by a share of the monitor, not to 1280.
  assert.deepEqual([0, 1].map(step => limits(3440, step)), [1720, 2580], 'half and three quarters of 3440, not 1280 and 1920');

  // The stage still caps it: a 1500 px window is not worth 3440 px of picture.
  const windowed = control({ screen: 3440, view: { width: 1500, height: 800 } });
  assert.equal(windowed.c.open(40).maxWidth, 1500);
});

test('the readable floor follows the monitor being shown: switching screens re-reads it', () => {
  const t = control({ screen: 1920 });
  assert.equal(t.c.open(40).maxWidth, 1920);
  // The focus moved to the ultrawide: the same step now means its whole width.
  t.c.screen(3440);
  assert.equal(t.c.params().maxWidth, 3440);
  t.c.screen(1920);
  assert.equal(t.c.params().maxWidth, 1920);
});

// The stage moves with every drag of a window border. Restarting the encoder
// for each pixel cost 8 runs in one session, each ~450 ms without a picture.
test('the stage only restarts the encoder when it leaves the band around the limit in force', () => {
  const t = control({ caps: { ack: true, key: true }, view: { width: 1500, height: 800 }, screen: 3440 });
  assert.equal(t.c.open(40).maxWidth, 1500);

  assert.equal(t.c.view({ width: 1540, height: 820 }), null, 'grew under 6%: rides along later');
  assert.equal(t.c.view({ width: 1300, height: 700 }), null, 'shrank under a quarter: not worth a run');
  // No restart happened, so the limit in force is still the one from the open.
  const grown = t.c.view({ width: 1700, height: 900 });
  assert.equal(grown?.reason, 'view', 'over 6% wider stretches the picture visibly');
  assert.equal(grown.params.maxWidth, 1700);

  const shrunk = t.c.view({ width: 1100, height: 600 });
  assert.equal(shrunk?.reason, 'view', 'a third narrower pays its own restart');
  assert.equal(shrunk.params.maxWidth, 1100);

  // A stage held inside the band is still the one that counts on the next
  // restart, whatever its reason.
  assert.equal(t.c.view({ width: 1130, height: 620 }), null);
  t.pass(3000);
  assert.equal(t.c.drop()?.params.maxWidth, 1130, 'the held stage rides along');
});

// Dropping a delta costs a keyframe and, outside the LAN, a whole new encoder.
test('the socket ceiling follows the capacity the link proved, never below the old floor', () => {
  const floor = 128 * 1024;
  const lan = control();
  lan.c.open(4);
  assert.equal(lan.c.ceiling(12000), 12000 * 125 / 10, 'the LAN keeps a tenth of a second of the encoder');
  assert.equal(lan.c.ceiling(600), floor, 'never under the old floor');

  // On the steps with nothing measured yet, the floor stands.
  const fresh = control({ caps: { ack: true, key: true } });
  fresh.c.open(40);
  assert.equal(fresh.c.ceiling(2500), floor);

  // A keyframe burst that measured a roomy link buys room to hold a jitter
  // spike instead of throwing the picture away.
  const roomy = control({ caps: { ack: true, key: true } });
  roomy.c.open(40);
  roomy.c.sent(140000, true, 1);
  roomy.pass(60);
  roomy.c.ack(1);
  const ceiling = roomy.c.ceiling(2500);
  assert.ok(ceiling > floor, `a measured link holds more than the floor, got ${ceiling}`);
  assert.ok(ceiling <= 30000 * 125 * 0.2, 'and never more than a fifth of a second of it');
});

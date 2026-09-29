import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { TsDemuxer, nalUnits, stripFiller, parseSps, captureCommand, createCapture, readBand, BAND } from '../backend/rd-capture.mjs';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const ffmpeg = (args, input) => {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { input, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr.toString());
  return result.stdout;
};
// 30 frames of H.264 in MPEG-TS, a keyframe every 10, as libavformat writes it
// (the same muxer gpu-screen-recorder uses).
const fixture = hasFfmpeg ? ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30', '-frames:v', '30', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '10', '-bf', '0', '-f', 'mpegts', 'pipe:1']) : null;

function demux(bytes, chunk = 4096) {
  const units = [];
  const demuxer = new TsDemuxer(unit => units.push(unit));
  for (let i = 0; i < bytes.length; i += chunk) demuxer.push(bytes.subarray(i, i + chunk));
  demuxer.end();
  return { units, stats: demuxer.stats };
}

test('the TS demuxer yields one Annex B access unit per frame, keyframes flagged, SPS parsed into the WebCodecs codec', { skip: !hasFfmpeg }, () => {
  const { units, stats } = demux(fixture);
  assert.equal(units.length, 30);
  assert.deepEqual(units.map((u, i) => u.keyframe ? i : -1).filter(i => i >= 0), [0, 10, 20]);
  for (const unit of units) assert.ok(unit.data.indexOf(Buffer.from([0, 0, 1])) <= 1, 'starts with a start code');
  const sps = units[0].sps;
  assert.equal(sps.width, 320); assert.equal(sps.height, 240);
  assert.match(sps.codec, /^avc1\.[0-9a-f]{6}$/);
  assert.equal(sps.codec.slice(5, 7), '42'); // x264 ultrafast: Constrained Baseline
  // The end-of-PES stuffing lets most units leave without waiting for the next frame.
  assert.ok(stats.early >= 28, `early ${stats.early}`);
  // What goes on the wire decodes back to the same 30 frames.
  const decoded = ffmpeg(['-f', 'h264', '-i', 'pipe:0', '-f', 'framecrc', 'pipe:1'], Buffer.concat(units.map(u => u.data)));
  assert.equal(decoded.toString().split('\n').filter(line => /^0,/.test(line)).length, 30);
});

test('chunk boundaries do not matter, and garbage before the stream (gsr prints its output path) is skipped', { skip: !hasFfmpeg }, () => {
  const reference = demux(fixture).units.map(u => u.data.toString('hex'));
  for (const size of [1, 7, 188, 1000, 65536]) assert.deepEqual(demux(fixture, size).units.map(u => u.data.toString('hex')), reference, `chunk ${size}`);
  const noisy = demux(Buffer.concat([Buffer.from('/dev/stdout\n'), fixture]), 333);
  assert.deepEqual(noisy.units.map(u => u.data.toString('hex')), reference);
  assert.ok(noisy.stats.resyncs >= 1);
});

test('filler NAL units (CBR padding) are stripped, everything else kept', () => {
  const sc = Buffer.from([0, 0, 0, 1]);
  const au = Buffer.concat([sc, Buffer.from([0x09, 0xf0]), sc, Buffer.from([0x65, 1, 2, 3]), sc, Buffer.from([0x0c, 0xff, 0xff, 0xff, 0x80]), Buffer.from([0, 0, 1]), Buffer.from([0x41, 9])]);
  assert.deepEqual(nalUnits(au).map(u => u.type), [9, 5, 12, 1]);
  const out = stripFiller(au);
  assert.deepEqual(nalUnits(out).map(u => u.type), [9, 5, 1]);
  assert.equal(out.toString('hex'), '0000000109f0' + '0000000165010203' + '000000014109');
  const plain = Buffer.concat([sc, Buffer.from([0x65, 1])]);
  assert.equal(stripFiller(plain), plain, 'no copy without filler');
});

test('SPS parsing: frame cropping gives 1080 lines, and the measured NVENC SPS is avc1.640034', { skip: !hasFfmpeg }, () => {
  const ts = ffmpeg(['-f', 'lavfi', '-i', 'color=black:size=1920x1080:rate=1', '-frames:v', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-f', 'mpegts', 'pipe:1']);
  const { sps } = demux(ts).units[0];
  assert.equal(sps.width, 1920); assert.equal(sps.height, 1080);
  // The SPS NVENC wrote through gpu-screen-recorder for a 3440x1440 monitor at 60 fps.
  const nvenc = parseSps(Buffer.from('67640034ac2b2006b816b602d404040500000303e80001d4c0e000001e84800003d0906ef288f8e15240', 'hex'));
  assert.deepEqual(nvenc, { profile: 100, constraints: 0, level: 52, width: 3440, height: 1440, codec: 'avc1.640034' });
});

test('capture command lines: gsr takes the monitor by name with the design flags; lab uses x264 zerolatency in the same mpegts', () => {
  const [command, args] = captureCommand({ monitor: 'DP-3', fps: 60, kbps: 8000, keyint: 1 });
  assert.equal(command, 'gpu-screen-recorder');
  assert.deepEqual(args, ['-w', 'DP-3', '-c', 'mpegts', '-k', 'h264', '-f', '60', '-fm', 'cfr', '-bm', 'cbr', '-q', '8000', '-tune', 'performance', '-keyint', '1', '-cursor', 'yes', '-v', 'no']);
  assert.throws(() => captureCommand({ monitor: 'DP-3; rm -rf ~' }));
  const [lab, labArgs] = captureCommand({ mode: 'lab', width: 1920, height: 1080, fps: 30, kbps: 3000 });
  assert.equal(lab, 'ffmpeg');
  const joined = labArgs.join(' ');
  for (const part of ['testsrc2=size=1920x1080:rate=30', 'libx264', '-tune zerolatency', '-g 30', '-f mpegts', 'RTCTIME', `crop=${BAND.bits * BAND.cell}:${BAND.cell}`]) assert.ok(joined.includes(part), part);
});

test('the lab capture paints the wall-clock capture time into the top band', { skip: !hasFfmpeg }, async () => {
  const [command, args] = captureCommand({ mode: 'lab', width: 704, height: 64, fps: 30, kbps: 800 });
  const started = Date.now();
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
  const units = [];
  const demuxer = new TsDemuxer(unit => units.push(unit));
  child.stdout.on('data', chunk => demuxer.push(chunk));
  while (units.length < 15) await new Promise(r => setTimeout(r, 50));
  child.kill('SIGKILL');
  const gray = ffmpeg(['-f', 'h264', '-i', 'pipe:0', '-vf', `crop=${BAND.bits * BAND.cell}:${BAND.cell}:0:0,format=gray`, '-f', 'rawvideo', 'pipe:1'], Buffer.concat(units.map(u => u.data)));
  const size = BAND.bits * BAND.cell * BAND.cell;
  const stamps = [];
  for (let i = 0; i + size <= gray.length; i += size) stamps.push(readBand(gray.subarray(i, i + size), BAND.bits * BAND.cell));
  assert.ok(stamps.length >= 10);
  for (const stamp of stamps) assert.ok(stamp >= started - 50 && stamp <= Date.now(), `${stamp} vs ${started}`);
  const steps = stamps.slice(1).map((s, i) => s - stamps[i]);
  assert.ok(steps.every(step => step > 15 && step < 60), `frame steps ${steps}`); // 30 fps ≈ 33 ms apart
});

const hasDrawtext = hasFfmpeg && spawnSync('ffmpeg', ['-hide_banner', '-filters']).stdout.toString().includes(' drawtext ');

test('the lab desktop scene: a screenshot, a scrolling terminal and a cursor, with a VBV that lets keyframes grow like the real encoder', () => {
  const [, args] = captureCommand({ mode: 'lab', scene: 'desktop', width: 1920, height: 1080, fps: 30, kbps: 2000 });
  const joined = args.join(' ');
  for (const part of ['desktop-control.png', 'drawtext=', 'expansion=none', 'drawbox=', '-bufsize 4000k', 'RTCTIME', `crop=${BAND.bits * BAND.cell}:${BAND.cell}`]) assert.ok(joined.includes(part), part);
  assert.ok(!joined.includes('testsrc2'));
  assert.throws(() => captureCommand({ mode: 'lab', scene: 'desktop', text: "/tmp/it's" }));
});

test('the lab desktop scene carries the capture-time band too', { skip: !hasDrawtext }, async () => {
  const [command, args] = captureCommand({ mode: 'lab', scene: 'desktop', width: 704, height: 400, fps: 30, kbps: 800 });
  const started = Date.now();
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
  const units = [];
  const demuxer = new TsDemuxer(unit => units.push(unit));
  child.stdout.on('data', chunk => demuxer.push(chunk));
  while (units.length < 10) await new Promise(r => setTimeout(r, 50));
  child.kill('SIGKILL');
  const gray = ffmpeg(['-f', 'h264', '-i', 'pipe:0', '-fps_mode', 'passthrough', '-vf', `crop=${BAND.bits * BAND.cell}:${BAND.cell}:0:0,format=gray`, '-f', 'rawvideo', 'pipe:1'], Buffer.concat(units.map(u => u.data)));
  const size = BAND.bits * BAND.cell * BAND.cell;
  const stamps = [];
  for (let i = 0; i + size <= gray.length; i += size) stamps.push(readBand(gray.subarray(i, i + size), BAND.bits * BAND.cell));
  assert.ok(stamps.length >= 8);
  for (const stamp of stamps) assert.ok(stamp >= started - 50 && stamp <= Date.now(), `${stamp} vs ${started}`);
});

test('createCapture runs the lab encoder, restarts it with new parameters and opens each run with a keyframe', { skip: !hasFfmpeg }, async () => {
  const units = [];
  const capture = createCapture({ mode: 'lab', onUnit: unit => units.push(unit), log: { error() {} } });
  capture.start({ width: 704, height: 64, fps: 30, kbps: 500 });
  while (units.length < 3) await new Promise(r => setTimeout(r, 20));
  capture.restart({ fps: 15, kbps: 300 });
  const mark = units.length;
  while (units.length < mark + 3) await new Promise(r => setTimeout(r, 20));
  capture.stop();
  const second = units.slice(mark);
  assert.equal(second[0].params.fps, 15);
  assert.equal(second[0].keyframe, true);
  assert.ok(units[0].keyframe);
  assert.equal(capture.running, false);
});

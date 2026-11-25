import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMidiToChart, GM_DRUM_MAP } from '../js/midi.js';
import { validateChart } from '../js/charts.js';

// ---- tiny MIDI writer (test fixtures) ----
const vlq = (n) => {
  const out = [n & 0x7f];
  while ((n >>= 7)) out.unshift((n & 0x7f) | 0x80);
  return out;
};
const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16 = (n) => [(n >> 8) & 255, n & 255];
const on = (tick, ch, note, vel = 100) => ({ tick, data: [0x90 | ch, note, vel] });
const off = (tick, ch, note) => ({ tick, data: [0x80 | ch, note, 0] });
const onZero = (tick, ch, note) => ({ tick, data: [0x90 | ch, note, 0] });
const tempo = (tick, bpm) => { const u = Math.round(6e7 / bpm); return { tick, data: [0xff, 0x51, 3, (u >> 16) & 255, (u >> 8) & 255, u & 255] }; };
const timeSig = (tick, n, dpow) => ({ tick, data: [0xff, 0x58, 4, n, dpow, 24, 8] });
const name = (tick, s) => ({ tick, data: [0xff, 0x03, s.length, ...[...s].map((c) => c.charCodeAt(0))] });
const sysex = (tick) => ({ tick, data: [0xf0, 3, 0x7e, 0x01, 0xf7] });
const trackBytes = (events, { running = false } = {}) => {
  const evs = events.map((e, i) => ({ ...e, i })).sort((a, b) => a.tick - b.tick || a.i - b.i);
  const body = [];
  let prev = 0;
  let last = null;
  for (const e of evs) {
    body.push(...vlq(e.tick - prev));
    prev = e.tick;
    const st = e.data[0];
    if (running && st < 0xf0 && st === last) body.push(...e.data.slice(1));
    else body.push(...e.data);
    last = st < 0xf0 ? st : null;
  }
  body.push(...vlq(0), 0xff, 0x2f, 0);
  return [...[0x4d, 0x54, 0x72, 0x6b], ...u32(body.length), ...body];
};
const smf = ({ format = 1, division = 480, tracks, running = false }) => {
  const bytes = [0x4d, 0x54, 0x68, 0x64, ...u32(6), ...u16(format), ...u16(tracks.length), ...u16(division)];
  for (const t of tracks) bytes.push(...trackBytes(t, { running }));
  return new Uint8Array(bytes).buffer;
};
const close = (a, b, eps = 1e-5) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);
const summary = (c) => c.notes.map((n) => `${n.lane}@${n.t.toFixed(3)}`);

test('format 0, constant tempo, note-off variants and vel scaling', () => {
  const buf = smf({
    format: 0, division: 480,
    tracks: [[tempo(0, 120), on(0, 9, 36, 127), off(60, 9, 36), on(480, 9, 38, 64), onZero(540, 9, 38), on(960, 9, 42), off(1000, 9, 42)]],
  });
  const c = parseMidiToChart(buf, { title: 'Test' });
  assert.equal(c.title, 'Test');
  assert.equal(c.source, 'midi');
  assert.equal(c.bpm, 120);
  assert.equal(c.beatsPerBar, 4);
  assert.deepEqual(summary(c), ['kick@0.000', 'snare@0.500', 'hihat@1.000']);
  assert.equal(c.notes[0].vel, 1);
  close(c.notes[1].vel, 64 / 127);
  assert.ok(c.durationSec >= 1);
  assert.deepEqual(validateChart(c), { ok: true, errors: [] });
});

test('format 1 with conductor track and tempo change', () => {
  const buf = smf({
    format: 1, division: 96,
    tracks: [
      [name(0, 'Song'), tempo(0, 120), timeSig(0, 3, 2), tempo(384, 60)],
      [on(0, 9, 36), on(384, 9, 38), on(480, 9, 36), on(576, 9, 42)],
    ],
  });
  const c = parseMidiToChart(buf);
  assert.equal(c.title, 'Song');
  assert.equal(c.bpm, 120);
  assert.equal(c.beatsPerBar, 3);
  // first 4 beats at 120bpm = 2.0s; then 60bpm: +1 beat = 1.0s each
  assert.deepEqual(summary(c), ['kick@0.000', 'snare@2.000', 'kick@3.000', 'hihat@4.000']);
});

test('multiple tempo changes accumulate (including a tempo set mid-file at same tick as a note)', () => {
  const buf = smf({
    division: 480,
    tracks: [
      [tempo(0, 60), tempo(480, 120), tempo(1440, 240)],
      [on(480, 9, 36), on(1440, 9, 38), on(1920, 9, 42)],
    ],
  });
  const c = parseMidiToChart(buf);
  assert.equal(c.bpm, 60);
  // 0..480 ticks @60 = 1s ; 480..1440 @120 = 2 beats = 1s -> 2s ; 1440..1920 @240 = 1 beat = .25s
  assert.deepEqual(summary(c), ['kick@1.000', 'snare@2.000', 'hihat@2.250']);
});

test('running status and multi-byte delta times', () => {
  const buf = smf({
    format: 0, division: 480, running: true,
    tracks: [[
      tempo(0, 120),
      on(0, 9, 36), on(0, 9, 42), on(240, 9, 42), on(480, 9, 38), // running status after first on
      on(20000, 9, 36), // delta of 19520: 3-byte VLQ
    ]],
  });
  // verify the fixture really used running status (fewer bytes than full status bytes)
  const full = smf({ format: 0, division: 480, running: false, tracks: [[tempo(0, 120), on(0, 9, 36), on(0, 9, 42), on(240, 9, 42), on(480, 9, 38), on(20000, 9, 36)]] });
  assert.ok(buf.byteLength < full.byteLength);
  const c = parseMidiToChart(buf);
  assert.deepEqual(summary(c), ['hihat@0.000', 'kick@0.000', 'hihat@0.250', 'snare@0.500', 'kick@20.833']);
  const c2 = parseMidiToChart(full);
  assert.deepEqual(summary(c2), summary(c));
});

test('meta/sysex events interleaved and unknown chunks skipped', () => {
  const t = trackBytes([tempo(0, 100), sysex(0), on(0, 9, 36), { tick: 10, data: [0xff, 0x01, 2, 0x68, 0x69] }, on(480, 9, 38), { tick: 500, data: [0xc9, 5] }, { tick: 500, data: [0xb9, 7, 100] }, on(960, 9, 49)]);
  const bytes = [0x4d, 0x54, 0x68, 0x64, ...u32(6), ...u16(0), ...u16(1), ...u16(480), 0x58, 0x58, 0x58, 0x58, ...u32(2), 1, 2, ...t];
  const c = parseMidiToChart(new Uint8Array(bytes).buffer);
  assert.equal(c.bpm, 100);
  assert.deepEqual(summary(c), ['kick@0.000', 'snare@0.600', 'crash@1.200']);
});

test('channel 10 preferred, fallback to all channels when channel 10 is empty', () => {
  const both = smf({ tracks: [[tempo(0, 120)], [on(0, 0, 36), on(480, 9, 38), on(960, 2, 42)]] });
  assert.deepEqual(summary(parseMidiToChart(both)), ['snare@0.500']);
  const none10 = smf({ tracks: [[tempo(0, 120)], [on(0, 0, 36), on(480, 1, 38), on(960, 2, 42)]] });
  assert.deepEqual(summary(parseMidiToChart(none10)), ['kick@0.000', 'snare@0.500', 'hihat@1.000']);
});

test('GM mapping', () => {
  const expected = {
    35: 'kick', 36: 'kick', 37: 'snare', 38: 'snare', 40: 'snare', 42: 'hihat', 44: 'hihat', 46: 'hihat',
    48: 'tom1', 50: 'tom1', 45: 'tom2', 47: 'tom2', 41: 'floor', 43: 'floor',
    49: 'crash', 52: 'crash', 55: 'crash', 57: 'crash', 51: 'ride', 53: 'ride', 59: 'ride',
  };
  assert.deepEqual(GM_DRUM_MAP, expected);
  const evs = [tempo(0, 120)];
  const keys = Object.keys(expected).map(Number);
  keys.forEach((k, i) => evs.push(on(i * 480, 9, k)));
  evs.push(on(keys.length * 480, 9, 56), on((keys.length + 1) * 480, 9, 39)); // cowbell, clap: ignored
  const c = parseMidiToChart(smf({ tracks: [evs] }));
  assert.equal(c.notes.length, keys.length);
  keys.forEach((k, i) => { assert.equal(c.notes[i].lane, expected[k]); close(c.notes[i].t, i * 0.5); });
});

test('simultaneous notes on same lane are deduped, different lanes kept', () => {
  const c = parseMidiToChart(smf({ tracks: [[tempo(0, 120), on(0, 9, 38, 50), on(0, 9, 40, 100), on(0, 9, 36, 90)]] }));
  assert.equal(c.notes.length, 2);
  const snare = c.notes.find((n) => n.lane === 'snare');
  close(snare.vel, 100 / 127);
});

test('default tempo 120 when none given; accepts Uint8Array and Node Buffer', () => {
  const ab = smf({ tracks: [[on(0, 9, 36), on(480, 9, 38)]] });
  const c = parseMidiToChart(ab);
  assert.equal(c.bpm, 120);
  assert.deepEqual(summary(c), ['kick@0.000', 'snare@0.500']);
  assert.deepEqual(summary(parseMidiToChart(new Uint8Array(ab))), summary(c));
  assert.deepEqual(summary(parseMidiToChart(Buffer.from(ab))), summary(c));
});

test('errors: SMPTE, bad header, format 2, no drums, truncated tolerated', () => {
  const smpte = smf({ division: 0xe728, tracks: [[on(0, 9, 36)]] });
  assert.throws(() => parseMidiToChart(smpte), /SMPTE/);
  assert.throws(() => parseMidiToChart(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]).buffer), /MIDI file/);
  assert.throws(() => parseMidiToChart(new ArrayBuffer(3)), /MIDI/);
  assert.throws(() => parseMidiToChart(smf({ format: 2, tracks: [[on(0, 9, 36)]] })), /format 2/);
  assert.throws(() => parseMidiToChart(smf({ tracks: [[tempo(0, 120), on(0, 9, 56)]] })), /No drum notes/);
  assert.throws(() => parseMidiToChart('nope'), /MIDI file/);
  // truncate the last bytes of a valid file: earlier notes survive
  const ok = new Uint8Array(smf({ format: 0, tracks: [[tempo(0, 120), on(0, 9, 36), on(480, 9, 38)]] }));
  const cut = ok.slice(0, ok.length - 5);
  const c = parseMidiToChart(cut.buffer);
  assert.ok(c.notes.length >= 1);
});

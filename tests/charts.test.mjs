import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LANES, PATTERNS, buildPatternChart, simplifyChart, quantizeChart, validateChart, uuid, BUILTIN_LESSONS,
} from '../js/charts.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);
const deepFreeze = (o) => { Object.values(o).forEach((v) => typeof v === 'object' && v && deepFreeze(v)); return Object.freeze(o); };
const at = (chart, lane) => chart.notes.filter((n) => n.lane === lane).map((n) => n.t);

test('LANES order', () => {
  assert.deepEqual(LANES, ['crash', 'ride', 'hihat', 'tom1', 'snare', 'tom2', 'floor', 'kick']);
});

test('PATTERNS include required grooves and fills, with valid steps', () => {
  const ids = PATTERNS.map((p) => p.id);
  for (const id of ['quarter-rock', 'eighth-rock', 'four-on-the-floor', 'half-time', 'sixteenth-hat-rock', 'shuffle']) {
    assert.ok(ids.includes(id), id);
  }
  assert.ok(PATTERNS.filter((p) => p.fill).length >= 2);
  assert.equal(new Set(ids).size, ids.length);
  for (const p of PATTERNS) {
    const spb = ((p.grid || 16) * p.beatsPerBar) / 4;
    for (const [lane, steps] of Object.entries(p.steps)) {
      assert.ok(LANES.includes(lane), `${p.id} lane ${lane}`);
      for (const s of steps) assert.ok(Number.isInteger(s) && s >= 0 && s < spb, `${p.id} ${lane} ${s}`);
    }
    assert.ok([1, 2, 3].includes(p.level));
  }
  assert.equal(PATTERNS.find((p) => p.id === 'shuffle').grid, 12);
});

test('buildPatternChart: 8th rock timing', () => {
  const c = buildPatternChart({ title: 'T', bpm: 120, durationSec: 8, patternId: 'eighth-rock' });
  assert.equal(c.source, 'pattern');
  assert.equal(c.notes.length, 4 * 12);
  assert.deepEqual(at(c, 'snare').slice(0, 3), [0.5, 1.5, 2.5]);
  close(at(c, 'hihat')[1], 0.25);
  assert.equal(c.durationSec, 8);
  assert.equal(c.audioId, null);
  assert.deepEqual(validateChart(c), { ok: true, errors: [] });
});

test('buildPatternChart: offset, audioId, trims at duration', () => {
  const c = buildPatternChart({ title: 'T', bpm: 120, offsetSec: 1, durationSec: 4.9, patternId: 'quarter-rock', audioId: 'a1' });
  assert.equal(c.audioId, 'a1');
  assert.equal(c.offsetSec, 1);
  assert.equal(c.notes[0].t, 1);
  assert.ok(c.notes.every((n) => n.t < 4.9));
  assert.ok(at(c, 'kick').includes(2)); // bar 2 starts at 3.0 -> kick 3.0, 4.0
  assert.deepEqual(at(c, 'kick'), [1, 2, 3, 4]);
});

test('buildPatternChart: shuffle uses triplet grid', () => {
  const c = buildPatternChart({ title: 'S', bpm: 120, durationSec: 2, patternId: 'shuffle' });
  // beat = 0.5s, triplet step = 1/6 s
  close(at(c, 'snare')[0], 3 / 6);
  assert.deepEqual(at(c, 'hihat').map((t) => Math.round(t * 6)), [0, 2, 3, 5, 6, 8, 9, 11]);
});

test('buildPatternChart: fills every N bars with crash on following bar', () => {
  const c = buildPatternChart({ title: 'F', bpm: 120, durationSec: 16, patternId: 'eighth-rock', fillEveryBars: 4 });
  const barSec = 2;
  assert.deepEqual(at(c, 'crash'), [4 * barSec, 8 * barSec].filter((t) => t < 16));
  // bar 4 (start 6.0) is the fill-snare: snare at steps 4,8,10,12,14
  const fillSnares = at(c, 'snare').filter((t) => t >= 6 && t < 8).map((t) => Math.round((t - 6) / 0.125));
  assert.deepEqual(fillSnares, [4, 8, 10, 12, 14]);
  // bars 1-3 untouched
  assert.deepEqual(at(c, 'snare').filter((t) => t < 6), [0.5, 1.5, 2.5, 3.5, 4.5, 5.5]);
  assert.ok(validateChart(c).ok);
});

test('buildPatternChart: errors', () => {
  assert.throws(() => buildPatternChart({ title: 'x', bpm: 100, durationSec: 4, patternId: 'nope' }), /Unknown pattern/);
  assert.throws(() => buildPatternChart({ title: 'x', bpm: 0, durationSec: 4, patternId: 'eighth-rock' }), /bpm/);
});

function sample() {
  return {
    id: 'x', title: 'x', source: 'midi', bpm: 120, beatsPerBar: 4, offsetSec: 0, durationSec: 2, audioId: null, meta: {},
    notes: [
      { t: 0, lane: 'kick', vel: 0.9 }, { t: 0, lane: 'hihat', vel: 0.5 }, { t: 0.25, lane: 'hihat', vel: 0.5 },
      { t: 0.5, lane: 'hihat', vel: 0.5 }, { t: 0.5, lane: 'snare', vel: 0.9 }, { t: 0.75, lane: 'tom1', vel: 0.8 },
      { t: 1.0, lane: 'tom2', vel: 0.8 }, { t: 1.25, lane: 'floor', vel: 0.8 }, { t: 1.5, lane: 'crash', vel: 1 },
      { t: 1.75, lane: 'snare', vel: 0.9 },
    ],
  };
}

test('simplifyChart levels 1/2/3', () => {
  const input = deepFreeze(sample());
  const l1 = simplifyChart(input, 1);
  assert.deepEqual(l1.notes.map((n) => `${n.t}:${n.lane}`), ['0:hihat', '0:kick', '0.5:hihat', '0.5:snare']);
  assert.equal(l1.meta.level, 1);
  const l2 = simplifyChart(input, 2);
  assert.equal(l2.notes.length, 10);
  assert.ok(l2.notes.every((n) => ['kick', 'snare', 'hihat', 'crash'].includes(n.lane)));
  assert.deepEqual(at(l2, 'snare'), [0.5, 0.75, 1, 1.25, 1.75]);
  assert.equal(at(l2, 'hihat').length, 3);
  const l3 = simplifyChart(input, 3);
  assert.deepEqual(l3.notes, input.notes);
  assert.notEqual(l3.notes, input.notes);
  assert.notEqual(l3.notes[0], input.notes[0]);
  assert.throws(() => simplifyChart(input, 4), /level/);
});

test('simplifyChart level 2 merges tom onto existing snare, ride becomes hihat; level 1 thins hihat', () => {
  const c = buildPatternChart({ title: 'r', bpm: 100, durationSec: 4.8, patternId: 'ride-groove' });
  const l2 = simplifyChart(c, 2);
  assert.ok(!l2.notes.some((n) => n.lane === 'ride'));
  assert.equal(at(l2, 'hihat').length, at(c, 'ride').length);
  const e = buildPatternChart({ title: 'e', bpm: 100, durationSec: 4.8, patternId: 'sixteenth-hat-rock' });
  const l1 = simplifyChart(e, 1);
  assert.equal(at(l1, 'hihat').length, 8); // 2 bars x 4 quarters
  assert.equal(at(l1, 'kick').length, at(e, 'kick').length);
});

test('simplifyChart level 1 removes fills and crash', () => {
  const c = buildPatternChart({ title: 'f', bpm: 120, durationSec: 16, patternId: 'eighth-rock', fillEveryBars: 4, fillPatternId: 'fill-tom-down' });
  const l1 = simplifyChart(c, 1);
  assert.ok(l1.notes.every((n) => ['kick', 'snare', 'hihat'].includes(n.lane)));
  // bar 4 is a fill bar: only on-beat notes remain
  const bar4 = l1.notes.filter((n) => n.t >= 6 && n.t < 8);
  assert.ok(bar4.every((n) => Math.abs(n.t / 0.5 - Math.round(n.t / 0.5)) < 1e-6));
  assert.equal(at(l1, 'hihat').length, 28); // 6 full bars x4 + 2 fill bars x2 (their hats only span beats 1-2)
});

test('quantizeChart snaps to grid, dedupes, never mutates', () => {
  const c = deepFreeze({
    ...sample(), notes: [
      { t: 0.12, lane: 'hihat', vel: 0.4 }, { t: 0.13, lane: 'hihat', vel: 0.8 }, { t: 0.26, lane: 'snare', vel: 0.9 },
      { t: 0.5004, lane: 'kick', vel: 0.9 },
    ],
  });
  const q = quantizeChart(c, 16);
  assert.equal(q.notes.length, 3);
  close(q.notes[0].t, 0.125);
  assert.equal(q.notes[0].vel, 0.8);
  close(q.notes[1].t, 0.25);
  close(q.notes[2].t, 0.5);
  const q8 = quantizeChart(c, 8);
  close(q8.notes[0].t, 0); close(q8.notes[1].t, 0.25);
  const off = quantizeChart({ ...sample(), offsetSec: 0.1, notes: [{ t: 0.22, lane: 'kick', vel: 1 }] }, 16);
  close(off.notes[0].t, 0.225);
  assert.ok(validateChart(q).ok);
});

test('validateChart catches problems', () => {
  const good = sample();
  assert.ok(validateChart(good).ok);
  assert.ok(!validateChart(null).ok);
  const bad = { ...good, id: '', bpm: -1, source: 'x', audioId: 5, notes: [{ t: 1, lane: 'kick', vel: 1 }, { t: 0.5, lane: 'cowbell', vel: 2 }] };
  const r = validateChart(bad);
  assert.ok(!r.ok);
  const text = r.errors.join('|');
  for (const w of ['id', 'bpm', 'source', 'audioId', 'sorted', 'cowbell', 'vel']) assert.ok(text.includes(w), w);
  assert.ok(!validateChart({ ...good, notes: 'no' }).ok);
});

test('uuid', () => {
  const a = uuid();
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(a, uuid());
});

test('BUILTIN_LESSONS are valid, progressive and kid friendly', () => {
  assert.ok(BUILTIN_LESSONS.length >= 8 && BUILTIN_LESSONS.length <= 10);
  const titles = new Set();
  const ids = new Set();
  for (const l of BUILTIN_LESSONS) {
    assert.deepEqual(validateChart(l), { ok: true, errors: [] }, l.title);
    assert.equal(l.source, 'builtin');
    assert.equal(l.audioId, null);
    assert.ok(l.bpm >= 60 && l.bpm <= 100);
    close(l.durationSec, (16 * l.beatsPerBar * 60) / l.bpm);
    assert.ok(l.notes.every((n) => n.t < l.durationSec));
    assert.ok(l.title.length > 0 && l.title.length <= 30);
    titles.add(l.title); ids.add(l.id);
  }
  assert.equal(titles.size, BUILTIN_LESSONS.length);
  assert.equal(ids.size, BUILTIN_LESSONS.length);
  const lanesOf = (l) => new Set(l.notes.map((n) => n.lane));
  assert.deepEqual([...lanesOf(BUILTIN_LESSONS[0])].sort(), ['kick', 'snare']);
  assert.equal(BUILTIN_LESSONS[0].notes.length, 16 * 4);
  const last = BUILTIN_LESSONS[BUILTIN_LESSONS.length - 1];
  assert.ok(lanesOf(last).has('crash') && lanesOf(last).has('tom1'));
  const rockFill = BUILTIN_LESSONS.find((l) => l.title === 'Rock and Fill');
  assert.ok(at(rockFill, 'crash').length === 3 && at(rockFill, 'hihat').length > 60);
  // lesson ordering never drops to fewer lanes than the first
  assert.ok(lanesOf(BUILTIN_LESSONS[1]).has('hihat'));
});

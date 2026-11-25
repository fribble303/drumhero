import test from 'node:test';
import assert from 'node:assert/strict';
import { ScoreEngine, comboMultiplier, lanesForLevel, starsFor, KEY_LANES, LANES, filterNotesForLevel } from '../js/game.js';
import * as store from '../js/store.js';

const mk = (notes, opts = {}, load = {}) => new ScoreEngine(opts).load(notes, load);
const n = (t, lane = 'snare') => ({ t, lane, vel: 1 });

test('judgement windows 45/90/140 ms (late and early)', () => {
  const cases = [
    [0.000, 'perfect'], [0.044, 'perfect'], [0.045, 'perfect'], [0.046, 'good'],
    [0.090, 'good'], [0.091, 'ok'], [0.140, 'ok'], [-0.045, 'perfect'], [-0.09, 'good'], [-0.14, 'ok'],
  ];
  for (const [d, want] of cases) {
    const e = mk([n(1)]);
    assert.equal(e.hit(1 + d, 'snare').type, want, `offset ${d}`);
  }
  const e = mk([n(1)]);
  assert.equal(e.hit(1.141, 'snare').type, 'stray');
  assert.equal(e.notes[0].state, 'pending', 'stray must not consume the note');
});

test('error sign: early negative, late positive, in real ms', () => {
  const e = mk([n(1)]);
  const r = e.hit(1.03, 'snare');
  assert.ok(Math.abs(r.errMs - 30) < 1e-6);
  const e2 = mk([n(1)]);
  assert.ok(Math.abs(e2.hit(0.97, 'snare').errMs + 30) < 1e-6);
});

test('lane-aware: wrong lane is a stray; right lane matches', () => {
  const e = mk([n(1, 'snare'), n(1.02, 'kick')]);
  const stray = e.hit(1.0, 'tom1'); // tom1 not in play -> timing-only, matches nearest
  assert.equal(stray.type, 'perfect');
  const e2 = mk([n(1, 'snare')], {}, { lanes: ['snare', 'kick'] });
  assert.equal(e2.hit(1.0, 'kick').type, 'stray', 'kick in play but no kick note');
  assert.equal(e2.hit(1.0, 'snare').type, 'perfect');
});

test('timing-only (lane null) matches any lane, nearest first', () => {
  const e = mk([n(1, 'kick'), n(1.1, 'snare')]);
  const r = e.hit(1.08, null);
  assert.equal(r.lane, 'snare');
  assert.equal(r.index, 1);
});

test('lane-aware picks the nearest in that lane, not the nearest overall', () => {
  const e = mk([n(1.0, 'kick'), n(1.06, 'snare')]);
  const r = e.hit(1.01, 'snare');
  assert.equal(r.lane, 'snare');
  assert.equal(r.type, 'good');
});

test('each note is matched once; a double hit is a stray', () => {
  const e = mk([n(1)]);
  assert.equal(e.hit(1.0, 'snare').type, 'perfect');
  assert.equal(e.hit(1.01, 'snare').type, 'stray');
  assert.equal(e.counts.stray, 1);
});

test('simultaneous notes: lane-aware', () => {
  const e = mk([n(2, 'kick'), n(2, 'hihat')]);
  const a = e.hit(2.01, 'hihat');
  const b = e.hit(2.012, 'kick');
  assert.equal(a.lane, 'hihat');
  assert.equal(b.lane, 'kick');
  assert.equal(e.counts.perfect, 2);
  assert.equal(e.combo, 2);
});

test('simultaneous notes: timing-only needs two hits', () => {
  const e = mk([n(2, 'kick'), n(2, 'hihat')]);
  assert.equal(e.hit(2.0, null).type, 'perfect');
  assert.equal(e.notes.filter((x) => x.state === 'pending').length, 1);
  assert.equal(e.hit(2.005, null).type, 'perfect');
  assert.equal(e.hit(2.01, null).type, 'stray');
});

test('misses: advance past the OK window breaks the combo', () => {
  const e = mk([n(1), n(2), n(3)]);
  e.hit(1.0, 'snare');
  assert.equal(e.combo, 1);
  assert.deepEqual(e.advance(2.1), [], 'still inside the OK window of note 2');
  const ev = e.advance(2.15);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, 'miss');
  assert.equal(e.combo, 0);
  assert.equal(e.counts.miss, 1);
  // a late hit after the miss does not revive the note
  assert.equal(e.hit(2.2, 'snare').type, 'stray');
});

test('finish marks everything left as missed', () => {
  const e = mk([n(1), n(2)]);
  e.hit(1, 'snare');
  const ev = e.finish();
  assert.equal(ev.length, 1);
  assert.equal(e.counts.miss, 1);
  assert.equal(e.counts.perfect + e.counts.miss, e.total);
});

test('combo multipliers x2 at 10, x3 at 25, x4 at 50', () => {
  assert.deepEqual([0, 1, 9, 10, 24, 25, 49, 50, 200].map(comboMultiplier), [1, 1, 1, 2, 2, 3, 3, 4, 4]);
  const notes = Array.from({ length: 60 }, (_, i) => n(1 + i * 0.5));
  const e = mk(notes);
  const pts = notes.map((x) => e.hit(x.t, 'snare').points);
  assert.equal(pts[8], 100);   // 9th hit
  assert.equal(pts[9], 200);   // 10th hit: x2
  assert.equal(pts[23], 200);
  assert.equal(pts[24], 300);  // 25th: x3
  assert.equal(pts[48], 300);
  assert.equal(pts[49], 400);  // 50th: x4
  assert.equal(e.maxCombo, 60);
  assert.equal(e.score, 9 * 100 + 15 * 200 + 25 * 300 + 11 * 400);
});

test('points: perfect 100 / good 70 / ok 40, and a miss resets the multiplier', () => {
  const notes = Array.from({ length: 13 }, (_, i) => n(1 + i));
  const e = mk(notes);
  for (let i = 0; i < 9; i++) e.hit(notes[i].t, 'snare');
  assert.equal(e.score, 900);
  assert.equal(e.hit(notes[9].t + 0.06, 'snare').points, 140); // good at x2
  e.advance(notes[10].t + 0.2); // miss note 10
  assert.equal(e.multiplier, 1);
  assert.equal(e.hit(notes[11].t + 0.12, 'snare').points, 40); // ok at x1
});

test('speed scaling: windows are constant in REAL time (chart time = real time x speed)', () => {
  // at 50% speed, 0.0225 chart seconds = 0.045 real seconds -> still perfect; 0.04 chart = 0.08 real -> good
  const a = mk([n(1)], {}, { speed: 0.5 });
  assert.equal(a.hit(1.0225, 'snare').type, 'perfect');
  assert.ok(Math.abs(a.notes[0].errMs - 45) < 1e-6);
  assert.equal(mk([n(1)], {}, { speed: 0.5 }).hit(1.04, 'snare').type, 'good');
  assert.equal(mk([n(1)], {}, { speed: 0.5 }).hit(1.07, 'snare').type, 'ok');      // 0.14 real
  assert.equal(mk([n(1)], {}, { speed: 0.5 }).hit(1.0701, 'snare').type, 'stray'); // just outside
  // same chart-time offset is judged harsher at 100% than at 50%
  assert.equal(mk([n(1)]).hit(1.08, 'snare').type, 'good');
  assert.equal(mk([n(1)], {}, { speed: 0.5 }).hit(1.08, 'snare').type, 'stray');
  // miss timing scales the same way
  const m = mk([n(1)], {}, { speed: 0.5 });
  assert.equal(m.advance(1.069).length, 0);
  assert.equal(m.advance(1.072).length, 1);
  const f = mk([n(1)], {}, { speed: 0.75 });
  assert.equal(f.hit(1.03375, 'snare').type, 'perfect'); // 0.03375 chart = 0.045 real
});

test('stray hits: no combo penalty by default; optional penalty only when lane-aware', () => {
  const e = mk([n(1), n(5)]);
  e.hit(1, 'snare');
  e.hit(3, 'snare');
  assert.equal(e.combo, 1);
  assert.equal(e.counts.stray, 1);
  const e2 = mk([n(1), n(5)], { strayBreaksCombo: true });
  e2.hit(1, 'snare');
  e2.hit(3, null); // timing-only strays never break combos
  assert.equal(e2.combo, 1);
  e2.hit(3, 'snare');
  assert.equal(e2.combo, 0);
});

test('accuracy, stars and tendency', () => {
  const notes = Array.from({ length: 10 }, (_, i) => n(1 + i));
  const e = mk(notes);
  for (let i = 0; i < 10; i++) e.hit(notes[i].t + 0.03, 'snare');
  const s = e.summary();
  assert.equal(s.accuracy, 100);
  assert.equal(s.stars, 5);
  assert.ok(Math.abs(s.meanErrMs - 30) < 1e-6, 'late tendency');
  assert.equal(s.perLane.snare.hit, 10);
  const e2 = mk(notes);
  for (let i = 0; i < 5; i++) e2.hit(notes[i].t - 0.02, 'snare');
  e2.finish();
  assert.equal(e2.summary().accuracy, 50);
  assert.equal(e2.summary().stars, 2);
  assert.ok(e2.meanErrMs() < 0, 'early tendency');
  assert.equal(starsFor(0, 0), 0);
  assert.equal(starsFor(40, 10), 1);
});

test('lanesForLevel and keyboard map', () => {
  const notes = [n(1, 'kick'), n(2, 'crash'), n(3, 'tom1'), n(4, 'ride')];
  assert.deepEqual(lanesForLevel(1, notes), ['hihat', 'snare', 'kick']);
  assert.deepEqual(lanesForLevel(2, notes), ['crash', 'hihat', 'snare', 'kick']);
  assert.deepEqual(lanesForLevel(2, [n(1, 'kick')]), ['hihat', 'snare', 'kick']);
  assert.deepEqual(lanesForLevel(3, notes), ['crash', 'ride', 'tom1', 'kick']);
  assert.deepEqual(Object.keys(KEY_LANES), ['a', 's', 'd', 'f', 'j', 'k', 'l', ';']);
  assert.deepEqual(Object.values(KEY_LANES), LANES);
  assert.equal(filterNotesForLevel(notes, 1).length, 1);
});

test('unsorted notes are sorted; pointer handles many notes', () => {
  const e = mk([n(3), n(1), n(2)]);
  assert.deepEqual(e.notes.map((x) => x.t), [1, 2, 3]);
  const big = Array.from({ length: 5000 }, (_, i) => n(i * 0.1));
  const e2 = mk(big);
  for (const x of big) e2.hit(x.t, 'snare');
  assert.equal(e2.counts.perfect, 5000);
});

test('store falls back to memory without IndexedDB', async () => {
  const song = { id: 'a1', title: 'T', notes: [], bpm: 90 };
  await store.saveSong(song);
  assert.equal((await store.listSongs()).length, 1);
  await store.saveAudio('a1', new Blob(['x']));
  assert.ok(await store.getAudio('a1'));
  await store.saveProfile({ latency: 0.05 });
  assert.deepEqual(await store.getProfile(), { latency: 0.05 });
  await store.saveScore('a1', { score: 10 });
  await store.saveScore('a1', { score: 30 });
  assert.equal((await store.getScores('a1'))[0].score, 30);
  assert.equal(store.storageMode(), 'memory');
  await store.deleteSong('a1');
  assert.equal((await store.listSongs()).length, 0);
  assert.equal((await store.getScores('a1')).length, 0);
});

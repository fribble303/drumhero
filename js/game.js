// Drum Hero - game engine.
// Part 1 (ScoreEngine and helpers) is pure and DOM-free: importable in Node for tests.
// Part 2 (Highway renderer, Game controller) uses canvas / Web Audio and is only touched in the browser.

export const LANES = ['crash', 'ride', 'hihat', 'tom1', 'snare', 'tom2', 'floor', 'kick'];

export const LANE_INFO = {
  crash: { label: 'CRASH',  color: '#FFD23F', key: 'a', shape: 'diamond' },
  ride:  { label: 'RIDE',   color: '#FF9A3C', key: 's', shape: 'diamond' },
  hihat: { label: 'HI-HAT', color: '#38E1FF', key: 'd', shape: 'diamond' },
  tom1:  { label: 'TOM 1',  color: '#B070FF', key: 'f', shape: 'circle' },
  snare: { label: 'SNARE',  color: '#FF4FA3', key: 'j', shape: 'circle' },
  tom2:  { label: 'TOM 2',  color: '#4F7BFF', key: 'k', shape: 'circle' },
  floor: { label: 'FLOOR',  color: '#2EE59D', key: 'l', shape: 'circle' },
  kick:  { label: 'KICK',   color: '#FF4B4B', key: ';', shape: 'bar' },
};

/** keyboard key -> lane (a s d f j k l ; in LANES order) */
export const KEY_LANES = Object.fromEntries(LANES.map((l) => [LANE_INFO[l].key, l]));

export const LEVELS = {
  1: { name: 'Starter', blurb: 'Kick, snare, hat' },
  2: { name: 'Groove', blurb: '+ crash' },
  3: { name: 'Full', blurb: 'Every drum' },
};

/** Judgement windows in REAL seconds (scaled by speed in chart time). */
export const WINDOWS = { perfect: 0.045, good: 0.09, ok: 0.14 };
export const POINTS = { perfect: 100, good: 70, ok: 40 };
const EPS = 1e-9;

export function comboMultiplier(combo) {
  return combo >= 50 ? 4 : combo >= 25 ? 3 : combo >= 10 ? 2 : 1;
}

/** Lanes drawn for a level, in LANES order. Level 3 (and unused-lane trimming) uses what the chart contains. */
export function lanesForLevel(level, notes = []) {
  const used = new Set(notes.map((n) => n.lane));
  let base;
  if (level === 1) base = ['hihat', 'snare', 'kick'];
  else if (level === 2) base = ['crash', 'hihat', 'snare', 'kick'].filter((l) => l !== 'crash' || used.has('crash'));
  else base = LANES.filter((l) => used.has(l));
  if (!base.length) base = ['hihat', 'snare', 'kick'];
  return LANES.filter((l) => base.includes(l));
}

/** Last-resort level filter if the charts module did not already simplify. Drops lanes outside the level. */
export function filterNotesForLevel(notes, level) {
  const allowed = new Set(level === 1 ? ['hihat', 'snare', 'kick'] : level === 2 ? ['crash', 'hihat', 'snare', 'kick'] : LANES);
  return notes.filter((n) => allowed.has(n.lane));
}

export function starsFor(accuracy, total) {
  if (!total) return 0;
  if (accuracy >= 95) return 5;
  if (accuracy >= 85) return 4;
  if (accuracy >= 70) return 3;
  if (accuracy >= 50) return 2;
  return 1;
}

/**
 * Matching + scoring. Clock is CHART time (seconds, same domain as note.t).
 * `speed` < 1 stretches the chart in real time, so a real-time window of W seconds is W*speed chart seconds.
 * Judgement events: { type: 'perfect'|'good'|'ok'|'miss'|'stray', index, lane, errMs, points, combo, mult, laneHit }
 * errMs is REAL milliseconds, negative = early, positive = late.
 */
export class ScoreEngine {
  constructor(opts = {}) {
    this.windows = { ...WINDOWS, ...(opts.windows || {}) };
    this.strayBreaksCombo = !!opts.strayBreaksCombo;
    this.load([], {});
  }

  load(notes, { speed = 1, lanes = null } = {}) {
    this.speed = speed > 0 ? speed : 1;
    this.notes = notes
      .map((n) => ({ t: n.t, lane: n.lane, vel: n.vel ?? 1, state: 'pending', judge: null, errMs: 0 }))
      .sort((a, b) => a.t - b.t);
    this.inPlay = new Set(lanes || this.notes.map((n) => n.lane));
    this.ptr = 0;
    this.score = 0;
    this.combo = 0;
    this.maxCombo = 0;
    this.counts = { perfect: 0, good: 0, ok: 0, miss: 0, stray: 0 };
    this.perLane = {};
    for (const n of this.notes) {
      this.perLane[n.lane] ??= { total: 0, perfect: 0, good: 0, ok: 0, miss: 0, errSum: 0, errN: 0 };
      this.perLane[n.lane].total++;
    }
    this.errSum = 0;
    this.errN = 0;
    return this;
  }

  get total() { return this.notes.length; }
  get judged() { return this.counts.perfect + this.counts.good + this.counts.ok + this.counts.miss; }
  get multiplier() { return comboMultiplier(this.combo); }

  _okW() { return this.windows.ok * this.speed; }

  _skipResolved() {
    while (this.ptr < this.notes.length && this.notes[this.ptr].state !== 'pending') this.ptr++;
  }

  /** Feed one hit. time = chart seconds. lane = Lane or null (timing-only). Returns one judgement event. */
  hit(time, lane = null) {
    const okW = this._okW();
    const laneHit = lane != null && this.inPlay.has(lane);
    let best = -1;
    let bestD = Infinity;
    for (let i = this.ptr; i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n.t - time > okW + EPS) break;
      if (n.state !== 'pending') continue;
      if (laneHit && n.lane !== lane) continue;
      const d = Math.abs(n.t - time);
      if (d > okW + EPS) continue;
      if (d < bestD - EPS) { bestD = d; best = i; }
    }
    if (best < 0) {
      this.counts.stray++;
      if (this.strayBreaksCombo && laneHit) this.combo = 0;
      return { type: 'stray', index: -1, lane, errMs: 0, points: 0, combo: this.combo, mult: this.multiplier, laneHit };
    }
    const n = this.notes[best];
    const realD = bestD / this.speed;
    const type = realD <= this.windows.perfect + EPS ? 'perfect' : realD <= this.windows.good + EPS ? 'good' : 'ok';
    const errMs = ((time - n.t) / this.speed) * 1000;
    n.state = 'hit';
    n.judge = type;
    n.errMs = errMs;
    this.combo++;
    if (this.combo > this.maxCombo) this.maxCombo = this.combo;
    const mult = comboMultiplier(this.combo);
    const points = POINTS[type] * mult;
    this.score += points;
    this.counts[type]++;
    const pl = this.perLane[n.lane];
    pl[type]++;
    pl.errSum += errMs;
    pl.errN++;
    this.errSum += errMs;
    this.errN++;
    this._skipResolved();
    return { type, index: best, lane: n.lane, errMs, points, combo: this.combo, mult, laneHit };
  }

  /** Advance the clock; any pending note whose OK window has passed is a miss. Returns miss events. */
  advance(time) {
    const okW = this._okW();
    const out = [];
    for (let i = this.ptr; i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n.t + okW >= time - EPS) break;
      if (n.state !== 'pending') continue;
      out.push(this._miss(i));
    }
    this._skipResolved();
    return out;
  }

  _miss(i) {
    const n = this.notes[i];
    n.state = 'missed';
    n.judge = 'miss';
    this.counts.miss++;
    this.perLane[n.lane].miss++;
    this.combo = 0;
    return { type: 'miss', index: i, lane: n.lane, errMs: 0, points: 0, combo: 0, mult: 1, laneHit: true };
  }

  /** End of song: every unplayed note is a miss. */
  finish() {
    const out = [];
    for (let i = 0; i < this.notes.length; i++) if (this.notes[i].state === 'pending') out.push(this._miss(i));
    this.ptr = this.notes.length;
    return out;
  }

  accuracy() {
    if (!this.total) return 0;
    const c = this.counts;
    return ((c.perfect + c.good * 0.7 + c.ok * 0.4) / this.total) * 100;
  }

  /** Accuracy among notes judged so far (for the live HUD). */
  liveAccuracy() {
    const j = this.judged;
    if (!j) return 100;
    const c = this.counts;
    return ((c.perfect + c.good * 0.7 + c.ok * 0.4) / j) * 100;
  }

  /** Mean timing error in real ms (negative = early, positive = late). */
  meanErrMs() { return this.errN ? this.errSum / this.errN : 0; }

  summary() {
    const accuracy = this.accuracy();
    const perLane = {};
    for (const [lane, p] of Object.entries(this.perLane)) {
      perLane[lane] = { ...p, meanErrMs: p.errN ? p.errSum / p.errN : 0, hit: p.perfect + p.good + p.ok };
    }
    return {
      score: this.score,
      maxCombo: this.maxCombo,
      counts: { ...this.counts },
      total: this.total,
      accuracy,
      stars: starsFor(accuracy, this.total),
      meanErrMs: this.meanErrMs(),
      perLane,
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Browser-only part
// ---------------------------------------------------------------------------------------------

const FONT = "ui-rounded, 'Arial Rounded MT Bold', 'Trebuchet MS', system-ui, sans-serif";
const JUDGE_COLOR = { perfect: '#7CFF6B', good: '#38E1FF', ok: '#FFD23F', miss: '#FF5A6E' };
const JUDGE_TEXT = { perfect: 'Perfect!', good: 'Good', ok: 'OK', miss: 'Miss' };

function rr(c, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

/** Canvas renderer. Layout is computed in resize(); draw() does no layout or DOM reads. */
export class Highway {
  constructor(canvas) {
    this.cv = canvas;
    this.c = canvas.getContext('2d', { alpha: false });
    this.lanes = [];
    this.notes = [];
    this.meta = { bpm: 100, beatsPerBar: 4, offsetSec: 0 };
    this.first = 0;
    this.flashes = [];
    this.pops = [];
    this.errs = [];
    this.lookahead = 2.4;
    this.w = 0; this.h = 0; this.dpr = 1;
    this.probe = null;
  }

  setSong(notes, lanes, meta) {
    this.notes = notes;
    this.lanes = lanes;
    this.meta = { bpm: meta.bpm || 100, beatsPerBar: meta.beatsPerBar || 4, offsetSec: meta.offsetSec || 0 };
    this.first = 0;
    this.flashes.length = 0;
    this.pops.length = 0;
    this.errs.length = 0;
    this.layout();
  }

  _insets() {
    if (!this.probe) {
      const p = document.createElement('div');
      p.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;' +
        'padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
      document.body.appendChild(p);
      this.probe = p;
    }
    const s = getComputedStyle(this.probe);
    return { t: parseFloat(s.paddingTop) || 0, r: parseFloat(s.paddingRight) || 0, b: parseFloat(s.paddingBottom) || 0, l: parseFloat(s.paddingLeft) || 0 };
  }

  resize() {
    const cv = this.cv;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    this.dpr = dpr; this.w = w; this.h = h;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    this.ins = this._insets();
    this.layout();
  }

  layout() {
    const { w, h } = this;
    if (!w) return;
    const n = Math.max(1, this.lanes.length);
    const { t, r, b, l } = this.ins || { t: 0, r: 0, b: 0, l: 0 };
    this.labelW = Math.max(78, Math.min(132, w * 0.14));
    this.hitX = l + this.labelW + Math.max(28, w * 0.04);
    this.top = t + Math.max(46, h * 0.13);
    this.bottom = h - b - 8;
    this.laneH = (this.bottom - this.top) / n;
    this.rad = Math.min(this.laneH * 0.38, 28);
    this.pps = (w - r - 10 - this.hitX) / this.lookahead;
    this.left = l;
    this.right = w - r;
    const g = this.c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#1b1040');
    g.addColorStop(1, '#0b0620');
    this.bg = g;
    this.laneY = {};
    this.lanes.forEach((ln, i) => { this.laneY[ln] = this.top + this.laneH * (i + 0.5); });
  }

  flash(lane, judge) {
    this.flashes.push({ lane, judge, t0: performance.now() });
    if (this.flashes.length > 24) this.flashes.shift();
  }

  pop(lane, type, errMs) {
    this.pops.push({ lane, type, errMs, t0: performance.now() });
    if (this.pops.length > 16) this.pops.shift();
    if (type !== 'miss' && type !== 'stray') {
      this.errs.push({ e: errMs, t0: performance.now() });
      if (this.errs.length > 8) this.errs.shift();
    }
  }

  _note(x, y, lane, alpha, dim) {
    const c = this.c, info = LANE_INFO[lane], r = this.rad;
    c.globalAlpha = alpha;
    c.fillStyle = dim ? '#5a5478' : info.color;
    c.strokeStyle = dim ? '#8a84a8' : '#ffffff';
    c.lineWidth = 3;
    if (info.shape === 'bar') {
      const bw = r * 1.5, bh = Math.min(this.laneH * 0.86, r * 2.6);
      rr(c, x - bw / 2, y - bh / 2, bw, bh, bw / 2);
      c.fill(); c.stroke();
    } else if (info.shape === 'diamond') {
      const d = r * 1.18;
      c.beginPath();
      c.moveTo(x, y - d); c.lineTo(x + d, y); c.lineTo(x, y + d); c.lineTo(x - d, y); c.closePath();
      c.fill(); c.stroke();
    } else {
      c.beginPath(); c.arc(x, y, r, 0, 6.2832); c.fill(); c.stroke();
    }
    if (!dim) {
      c.fillStyle = 'rgba(255,255,255,0.55)';
      c.beginPath(); c.arc(x - r * 0.3, y - r * 0.32, r * 0.22, 0, 6.2832); c.fill();
    }
    c.globalAlpha = 1;
  }

  /** hud: { score, combo, mult, accuracy, progress, countIn: string|null } or null for a bare preview. */
  draw(songTime, hud) {
    const c = this.c, W = this.w, H = this.h;
    if (!W) return;
    const now = performance.now();
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.fillStyle = this.bg;
    c.fillRect(0, 0, W, H);

    const n = this.lanes.length, laneH = this.laneH, top = this.top, hitX = this.hitX, pps = this.pps;

    // lane stripes
    for (let i = 0; i < n; i++) {
      const y0 = top + i * laneH;
      c.fillStyle = i % 2 ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.02)';
      c.fillRect(this.left, y0, this.right - this.left, laneH);
    }
    // lane flashes
    for (const f of this.flashes) {
      const a = 1 - (now - f.t0) / 260;
      if (a <= 0) continue;
      const i = this.lanes.indexOf(f.lane);
      if (i < 0) continue;
      c.globalAlpha = a * 0.35;
      c.fillStyle = LANE_INFO[f.lane].color;
      c.fillRect(this.left, top + i * laneH, this.right - this.left, laneH);
      c.globalAlpha = 1;
    }

    // beat + bar lines
    const m = this.meta, beat = 60 / m.bpm;
    const kFrom = Math.ceil((songTime - 0.4 - m.offsetSec) / beat);
    const kTo = Math.floor((songTime + (this.right - hitX) / pps - m.offsetSec) / beat);
    for (let k = kFrom; k <= kTo; k++) {
      const x = hitX + (m.offsetSec + k * beat - songTime) * pps;
      const bar = ((k % m.beatsPerBar) + m.beatsPerBar) % m.beatsPerBar === 0;
      c.fillStyle = bar ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.10)';
      c.fillRect(x - (bar ? 1.5 : 0.5), top, bar ? 3 : 1, n * laneH);
    }

    // notes
    const notes = this.notes;
    while (this.first < notes.length && hitX + (notes[this.first].t - songTime) * pps < this.left + this.labelW - this.rad) this.first++;
    for (let i = this.first; i < notes.length; i++) {
      const nt = notes[i];
      const x = hitX + (nt.t - songTime) * pps;
      if (x > this.right + this.rad * 2) break;
      if (nt.state === 'hit') continue;
      const y = this.laneY[nt.lane];
      if (y === undefined) continue;
      this._note(x, y, nt.lane, nt.state === 'missed' ? 0.5 : 1, nt.state === 'missed');
    }

    // label panel (covers notes sliding past the line)
    c.fillStyle = '#120a30';
    c.fillRect(this.left, top - 2, this.labelW, n * laneH + 4);
    // hit line
    c.fillStyle = 'rgba(255,255,255,0.9)';
    rr(c, hitX - 3, top, 6, n * laneH, 3); c.fill();
    c.fillStyle = 'rgba(255,255,255,0.18)';
    c.fillRect(hitX - 9, top, 18, n * laneH);

    const fs = Math.max(11, Math.min(17, laneH * 0.34));
    c.font = `800 ${fs}px ${FONT}`;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    for (let i = 0; i < n; i++) {
      const ln = this.lanes[i], info = LANE_INFO[ln], y = top + laneH * (i + 0.5);
      let lit = 0;
      for (const f of this.flashes) if (f.lane === ln) lit = Math.max(lit, 1 - (now - f.t0) / 220);
      const ph = Math.min(laneH - 6, 40);
      rr(c, this.left + 6, y - ph / 2, this.labelW - 12, ph, ph / 2);
      c.fillStyle = info.color;
      c.fill();
      if (lit > 0) { c.fillStyle = `rgba(255,255,255,${lit * 0.7})`; c.fill(); }
      c.fillStyle = '#1a1030';
      c.fillText(info.label, this.left + this.labelW / 2 - 7, y);
      c.font = `800 ${Math.max(9, fs - 4)}px ${FONT}`;
      c.fillStyle = 'rgba(26,16,48,0.55)';
      c.fillText(info.key.toUpperCase(), this.left + this.labelW - 17, y);
      c.font = `800 ${fs}px ${FONT}`;
    }

    // hit bursts
    for (const f of this.flashes) {
      const a = 1 - (now - f.t0) / 330;
      const y = this.laneY[f.lane];
      if (a <= 0 || y === undefined) continue;
      c.globalAlpha = a;
      c.strokeStyle = JUDGE_COLOR[f.judge] || '#fff';
      c.lineWidth = 5 * a + 1;
      c.beginPath(); c.arc(hitX, y, this.rad * (1 + (1 - a) * 1.2), 0, 6.2832); c.stroke();
      c.globalAlpha = 1;
    }

    // pop texts
    c.font = `800 ${Math.max(14, Math.min(22, laneH * 0.45))}px ${FONT}`;
    for (const p of this.pops) {
      const age = (now - p.t0) / 650;
      const y = this.laneY[p.lane];
      if (age >= 1 || y === undefined) continue;
      c.globalAlpha = 1 - age * age;
      const px = hitX + 46, py = y - age * 14;
      c.lineWidth = 4; c.strokeStyle = 'rgba(10,5,30,0.85)';
      const txt = JUDGE_TEXT[p.type];
      c.textAlign = 'left';
      c.strokeText(txt, px, py);
      c.fillStyle = JUDGE_COLOR[p.type];
      c.fillText(txt, px, py);
      if ((p.type === 'good' || p.type === 'ok') && Math.abs(p.errMs) > 20) {
        const s = p.errMs < 0 ? 'early' : 'late';
        c.font = `800 ${Math.max(10, Math.min(14, laneH * 0.3))}px ${FONT}`;
        c.fillStyle = '#fff';
        c.fillText(s, px + c.measureText(txt).width * 0 + 4, py + Math.max(12, laneH * 0.28));
        c.font = `800 ${Math.max(14, Math.min(22, laneH * 0.45))}px ${FONT}`;
      }
      c.globalAlpha = 1;
    }
    c.textAlign = 'center';

    if (hud) this._hud(hud, songTime, now);
  }

  _hud(hud, songTime, now) {
    const c = this.c, W = this.w, t0 = this.ins ? this.ins.t : 0;
    const y = t0 + 24;
    // progress
    c.fillStyle = 'rgba(255,255,255,0.12)';
    c.fillRect(this.left + 56, t0 + 4, this.right - this.left - 56 - 8, 5);
    c.fillStyle = '#7CFF6B';
    c.fillRect(this.left + 56, t0 + 4, (this.right - this.left - 64) * Math.max(0, Math.min(1, hud.progress || 0)), 5);

    c.textBaseline = 'middle';
    c.textAlign = 'right';
    c.font = `800 24px ${FONT}`;
    c.fillStyle = '#fff';
    c.fillText(String(hud.score), this.right - 8, y + 6);
    c.font = `700 13px ${FONT}`;
    c.fillStyle = 'rgba(255,255,255,0.65)';
    c.fillText(`${Math.round(hud.accuracy)}%`, this.right - 8 - 4 - c.measureText(String(hud.score)).width * 1.7 - 18, y + 6);

    // combo
    c.textAlign = 'left';
    if (hud.combo >= 2) {
      c.font = `800 22px ${FONT}`;
      c.fillStyle = '#FFD23F';
      c.fillText(`${hud.combo} combo`, this.left + 64, y + 6);
      if (hud.mult > 1) {
        const cw = c.measureText(`${hud.combo} combo`).width;
        c.font = `800 16px ${FONT}`;
        c.fillStyle = '#FF4FA3';
        c.fillText(`x${hud.mult}`, this.left + 64 + 8 + cw, y + 6);
      }
    }

    // timing meter (last hits: left = early, right = late)
    const mw = Math.min(180, W * 0.2), mx = W / 2 - mw / 2, my = y + 6;
    c.fillStyle = 'rgba(255,255,255,0.15)';
    rr(c, mx, my - 3, mw, 6, 3); c.fill();
    c.fillStyle = 'rgba(255,255,255,0.7)';
    c.fillRect(W / 2 - 1, my - 8, 2, 16);
    for (const e of this.errs) {
      const a = 1 - (now - e.t0) / 1800;
      if (a <= 0) continue;
      const ex = W / 2 + Math.max(-1, Math.min(1, e.e / 140)) * (mw / 2);
      c.globalAlpha = a;
      c.fillStyle = Math.abs(e.e) <= 45 ? '#7CFF6B' : Math.abs(e.e) <= 90 ? '#38E1FF' : '#FFD23F';
      c.beginPath(); c.arc(ex, my, 5, 0, 6.2832); c.fill();
      c.globalAlpha = 1;
    }
    c.font = `700 10px ${FONT}`;
    c.fillStyle = 'rgba(255,255,255,0.5)';
    c.textAlign = 'right'; c.fillText('early', mx - 6, my);
    c.textAlign = 'left'; c.fillText('late', mx + mw + 6, my);

    // count-in / GO
    if (hud.countIn) {
      c.textAlign = 'center';
      c.font = `900 ${Math.min(this.h * 0.42, 150)}px ${FONT}`;
      c.lineWidth = 8; c.strokeStyle = 'rgba(10,5,30,0.9)';
      const cx = this.hitX + (this.right - this.hitX) * 0.35, cy = this.top + (this.bottom - this.top) / 2;
      c.strokeText(hud.countIn, cx, cy);
      c.fillStyle = '#FFD23F';
      c.fillText(hud.countIn, cx, cy);
    }
    c.textAlign = 'left';
  }

  /** Lane index for a y coordinate in CSS px (or -1). */
  laneAt(y) {
    if (!this.lanes.length) return null;
    const i = Math.floor((y - this.top) / this.laneH);
    return this.lanes[Math.max(0, Math.min(this.lanes.length - 1, i))];
  }
}

/** One play session: clock, audio, metronome, input -> engine, render loop. */
export class Game {
  constructor({ canvas, audioCtx, chart, level = 1, speed = 1, buffer = null, metronome = null, listener = null, onEnd = () => {} }) {
    this.ctx = audioCtx;
    this.chart = chart;
    this.level = level;
    this.speed = speed;
    this.buffer = buffer;
    this.metronome = metronome ?? !buffer;
    this.listener = listener;
    this.onEnd = onEnd;
    this.lanes = lanesForLevel(level, chart.notes);
    this.engine = new ScoreEngine({ strayBreaksCombo: level >= 3 });
    this.engine.load(chart.notes.filter((n) => this.lanes.includes(n.lane)), { speed, lanes: this.lanes });
    this.view = new Highway(canvas);
    this.view.ins = { t: 0, r: 0, b: 0, l: 0 };
    this.view.resize();
    this.view.setSong(this.engine.notes, this.lanes, chart);
    const last = this.engine.notes.length ? this.engine.notes[this.engine.notes.length - 1].t : 0;
    this.endT = last + 1.2;
    this.firstT = this.engine.notes.length ? this.engine.notes[0].t : 0;
    this.state = 'ready';
    this.hud = { score: 0, combo: 0, mult: 1, accuracy: 100, progress: 0, countIn: null };
    this.clickTimes = [];
    this._lc = -1; this._lp = 0; this._last = -Infinity;
  }

  resize() { this.view.resize(); if (this.state === 'paused') this._draw(this._songTime()); }

  _now() {
    const c = this.ctx.currentTime;
    if (c !== this._lc) { this._lc = c; this._lp = performance.now(); }
    const v = c + Math.min(0.03, (performance.now() - this._lp) / 1000);
    if (v > this._last) this._last = v;
    return this._last;
  }

  _songTime() { return (this._now() - this.zero) * this.speed; }

  start() {
    const ctx = this.ctx, c = this.chart, sp = this.speed;
    this.beat = 60 / c.bpm;
    const bpb = c.beatsPerBar || 4;
    const cStart = (c.offsetSec || 0) - bpb * this.beat;
    const startCtx = ctx.currentTime + 0.3;
    this.zero = startCtx - cStart / sp;
    this.out = ctx.createGain();
    this.out.gain.value = 1;
    this.out.connect(ctx.destination);
    if (this.buffer) {
      const src = ctx.createBufferSource();
      src.buffer = this.buffer;
      src.playbackRate.value = sp;
      src.connect(this.out);
      if (cStart >= 0) src.start(startCtx, cStart); else src.start(this.zero, 0);
      this.src = src;
    }
    this._nextBeat = -bpb;
    this.timer = setInterval(() => this._sched(), 25);
    this._sched();
    if (this.listener) {
      this.unsub = this.listener.onHit((h) => this._hit(h.time, h.lane));
      try {
        this.listener.setReferenceGate?.((t) => this.clickTimes.some((x) => Math.abs(x - t) < 0.03));
      } catch { /* optional */ }
    }
    this.state = 'playing';
    this._loop = () => this._frame();
    this.raf = requestAnimationFrame(this._loop);
  }

  _sched() {
    const ctx = this.ctx, c = this.chart, bpb = c.beatsPerBar || 4;
    const lim = ctx.currentTime + 0.12;
    for (let guard = 0; guard < 16; guard++) {
      const bt = (c.offsetSec || 0) + this._nextBeat * this.beat;
      const when = this.zero + bt / this.speed;
      if (when > lim || bt > this.endT) break;
      if (when >= ctx.currentTime - 0.01 && (this._nextBeat < 0 || this.metronome)) {
        this._click(when, (((this._nextBeat % bpb) + bpb) % bpb) === 0);
        this.clickTimes.push(when);
        if (this.clickTimes.length > 8) this.clickTimes.shift();
      }
      this._nextBeat++;
    }
  }

  _click(when, accent) {
    const ctx = this.ctx;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'square';
    o.frequency.value = accent ? 1600 : 1100;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(0.28, when + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
    o.connect(g); g.connect(this.out);
    o.start(when); o.stop(when + 0.06);
  }

  _hit(ctxTime, lane) {
    if (this.state !== 'playing') return;
    const t = (ctxTime - this.zero) * this.speed;
    if (t < this.firstT - 1.0) {
      if (lane && this.lanes.includes(lane)) this.view.flash(lane, 'good');
      return;
    }
    const ev = this.engine.hit(t, lane);
    this._events([ev]);
  }

  /** On-screen tap or keyboard. */
  tap(lane) {
    if (this.state !== 'playing' || !this.lanes.includes(lane)) return;
    this._hit(this._now(), lane);
  }

  _events(list) {
    for (const e of list) {
      if (e.type === 'stray') {
        if (e.lane && this.lanes.includes(e.lane)) this.view.flash(e.lane, 'ok');
        continue;
      }
      this.view.pop(e.lane, e.type, e.errMs);
      if (e.type !== 'miss') this.view.flash(e.lane, e.type);
    }
  }

  _draw(t) {
    const e = this.engine, h = this.hud, bpb = this.chart.beatsPerBar || 4, off = this.chart.offsetSec || 0;
    h.score = e.score; h.combo = e.combo; h.mult = e.multiplier; h.accuracy = e.liveAccuracy();
    h.progress = e.total ? e.judged / e.total : 0;
    let ci = null;
    if (t < off) {
      const left = Math.ceil((off - t) / this.beat - 1e-6);
      if (left >= 1 && left <= bpb) ci = String(left);
    } else if (t < off + 0.6 * this.beat * 1.5) ci = 'GO!';
    h.countIn = ci;
    this.view.draw(t, h);
  }

  _frame() {
    if (this.state !== 'playing') return;
    const t = this._songTime();
    this._events(this.engine.advance(t));
    this._draw(t);
    if (t > this.endT) { this._end(); return; }
    this.raf = requestAnimationFrame(this._loop);
  }

  async pause() {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    cancelAnimationFrame(this.raf);
    try { await this.ctx.suspend(); } catch { /* ignore */ }
  }

  async resume() {
    if (this.state !== 'paused') return;
    try { await this.ctx.resume(); } catch { /* ignore */ }
    this.state = 'playing';
    this.raf = requestAnimationFrame(this._loop);
  }

  _cleanup() {
    cancelAnimationFrame(this.raf);
    clearInterval(this.timer);
    try { this.unsub?.(); } catch { /* ignore */ }
    try { this.listener?.setReferenceGate?.(null); } catch { /* ignore */ }
    try { this.src?.stop(); } catch { /* ignore */ }
    try { this.out?.disconnect(); } catch { /* ignore */ }
  }

  stop() {
    if (this.state === 'done') return;
    this.state = 'done';
    this._cleanup();
  }

  _end() {
    this._events(this.engine.finish());
    this.state = 'done';
    this._cleanup();
    this.onEnd({ ...this.engine.summary(), level: this.level, speed: this.speed });
  }
}

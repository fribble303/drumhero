// listen.js — live microphone drum-hit detection for Drum Hero.
//
// Layout of this file
//   1. HitDetector    pure DSP: onset detection + timing refinement + feature extraction (runs in Node)
//   2. DrumClassifier pure: nearest-template classification with honest confidence, 1 or 2 lanes per onset
//   3. estimateLoopbackLatency  pure helper for the click loopback calibration
//   4. createListener(audioContext)  browser glue: getUserMedia + AudioWorklet (ScriptProcessor fallback)
//
// How a hit is found
//   * Audio is analysed in short hops (~2.7 ms) with a ~10.7 ms Hann FFT. Power is summed into three
//     wide detection bands (low / mid / high).
//   * A band "fires" when its energy jumps by a ratio over a decaying peak-hold of its own recent
//     energy AND is above an absolute floor AND well above a slowly tracked noise floor. The
//     peak-hold means a decaying drum cannot re-trigger itself; only a genuinely new rise can.
//     The ratio is adaptive: it grows with how much that band has been fluttering on its own over
//     the last ~200 ms, so a hissy cymbal tail does not re-trigger.
//   * A firing band is only believed if the waveform itself also steps up clearly (0.5 ms energy
//     blocks against the 8 ms before), which rejects random wobble in steady hiss.
//   * Bands that fire within the refractory window (40 ms) belong to the same event, so one stick
//     hit can never produce two events. Simultaneous drums (kick + hi-hat) are one event that the
//     classifier may label with two lanes.
//   * The onset sample is then located in the time domain (0.5 ms energy blocks) so the reported
//     time does not depend on the hop size or on when the main thread got round to the audio.
//
// How a hit is classified
//   * 36 ms after the onset we take 14 log-spaced band powers of the whole window plus 7 wider band
//     powers of its second half (so decay is encoded), minus the same measurement taken just before
//     the onset (removes steady noise, backing-track bleed and the tail of the previous drum).
//     Bands where that earlier sound is as strong as the hit are not compared directly; they only
//     give an upper bound ("this drum cannot have put more than this into the band").
//   * Each trained lane is a template (mean + variance of the log features). A hit goes to the
//     nearest template; a two-template mix is accepted only when it explains the hit much better.
//   * Confidence = how much closer the best template is than the runner-up, times how well it fits.
//     Below `minConfidence` the hit is emitted with lane null (timing only) rather than guessed.
//
// Limits (see also the notes returned by getTrainingQuality()):
//   * Hits closer together than 40 ms merge into one event (flams, very fast rolls). This is a
//     single event-level refractory rather than one per band: per-band timers let a kick's pitch
//     sweep fire the low band late and count twice.
//   * Two drums at once are only split when both are clearly audible; a soft hi-hat (about 20 dB
//     under a loud kick, or any hi-hat under a snare, whose noise covers it) is reported as the
//     louder drum alone.
//   * Classification adds ~36 ms before a hit is reported; the reported `time` is still the stick time.
//   * Rubber-pad "thwacks" from identical pads are acoustically near identical; they will mostly come
//     back with lane null. That is intended.

import { FFT, hann, clamp, median, nextPow2, bandBins } from './dsp-util.js';

const LANES = ['crash', 'ride', 'hihat', 'tom1', 'snare', 'tom2', 'floor', 'kick'];

export const PROFILE_VERSION = 1;

// Feature layout: 14 bands over the whole 36 ms window + 7 double-width bands over its second half.
const FEATURE_EDGES_HZ = [40, 61, 94, 144, 221, 340, 521, 800, 1227, 1882, 2888, 4431, 6798, 10429, 16000];
const N_FULL = 14;
const N_LATE = 7;
export const FEATURE_DIM = N_FULL + N_LATE;
const FEATURE_EPS = 1e-3;          // -30 dB floor relative to the hit's total power
const PRESENT_LOG = Math.log(4 * FEATURE_EPS);   // a band "has energy" when 6 dB above that floor
const VAR_FLOOR = 0.3;             // (ln power)^2: about +/-2.4 dB of hit-to-hit variation is always allowed

const DEFAULT_OPTIONS = {
  refractorySec: 0.040,            // minimum spacing of two events
  classifyWindowSec: 0.036,        // audio after the onset used for classification
  minConfidence: 0.4,              // below this a classified hit is reported with lane null
  maxExamplesPerLane: 24,
  sensitivity: 0.5,
};

// ---------------------------------------------------------------------------------------------
// 2. Classifier
// ---------------------------------------------------------------------------------------------

export class DrumClassifier {
  constructor() {
    this.lanes = {};               // lane -> { examples: number[][], mean: number[], vari: number[] }
  }

  addExample(lane, logVec, maxExamples = DEFAULT_OPTIONS.maxExamplesPerLane) {
    if (!LANES.includes(lane) || !logVec || logVec.length !== FEATURE_DIM) return;
    const entry = this.lanes[lane] || (this.lanes[lane] = { examples: [], mean: null, vari: null });
    entry.examples.push(Array.from(logVec));
    while (entry.examples.length > maxExamples) entry.examples.shift();
    this._rebuild(lane);
  }

  clear(lane) {
    if (lane == null) this.lanes = {};
    else delete this.lanes[lane];
  }

  count(lane) {
    return this.lanes[lane] ? this.lanes[lane].examples.length : 0;
  }

  /** Lanes that have enough examples to be used (>= 2). */
  trainedLanes() {
    return LANES.filter((l) => this.lanes[l] && this.lanes[l].mean && this.lanes[l].examples.length >= 2);
  }

  /** Classification is only meaningful with at least two taught drums. */
  ready() {
    return this.trainedLanes().length >= 2;
  }

  _rebuild(lane) {
    const entry = this.lanes[lane];
    if (!entry) return;
    let ex = entry.examples;
    if (!ex.length) { entry.mean = entry.vari = null; return; }
    // Drop gross outliers (a voice, a dropped stick) when there are enough examples to judge.
    if (ex.length >= 5) {
      const med = new Array(FEATURE_DIM);
      for (let c = 0; c < FEATURE_DIM; c++) med[c] = median(ex.map((e) => e[c]));
      const dist = ex.map((e) => {
        let s = 0;
        for (let c = 0; c < FEATURE_DIM; c++) s += (e[c] - med[c]) * (e[c] - med[c]);
        return s / FEATURE_DIM;
      });
      const limit = Math.max(4 * median(dist), 1.5);
      const kept = ex.filter((_, i) => dist[i] <= limit);
      if (kept.length >= 3) ex = kept;
    }
    const mean = new Array(FEATURE_DIM).fill(0);
    const vari = new Array(FEATURE_DIM).fill(0);
    for (const e of ex) for (let c = 0; c < FEATURE_DIM; c++) mean[c] += e[c] / ex.length;
    for (const e of ex) for (let c = 0; c < FEATURE_DIM; c++) vari[c] += (e[c] - mean[c]) ** 2 / Math.max(1, ex.length - 1);
    for (let c = 0; c < FEATURE_DIM; c++) vari[c] += VAR_FLOOR;
    entry.mean = mean;
    entry.vari = vari;
    entry.used = ex.length;
  }

  /** Normalised distance between two lane templates (about 1 = indistinguishable, > 6 = clearly different). */
  templateDistance(a, b) {
    const A = this.lanes[a], B = this.lanes[b];
    if (!A || !B || !A.mean || !B.mean) return Infinity;
    let s = 0;
    for (let c = 0; c < FEATURE_DIM; c++) s += (A.mean[c] - B.mean[c]) ** 2 / (0.5 * (A.vari[c] + B.vari[c]));
    return s / FEATURE_DIM;
  }

  /**
   * Pairwise separability of the taught drums, for the calibration UI.
   * Returns { pairs: [{ a, b, distance, confusable }], confusable: [[a, b], ...] }.
   */
  quality() {
    const lanes = this.trainedLanes();
    const pairs = [];
    for (let i = 0; i < lanes.length; i++) {
      for (let j = i + 1; j < lanes.length; j++) {
        const distance = this.templateDistance(lanes[i], lanes[j]);
        pairs.push({ a: lanes[i], b: lanes[j], distance, confusable: distance < 3 });
      }
    }
    return { lanes, pairs, confusable: pairs.filter((p) => p.confusable).map((p) => [p.a, p.b]) };
  }

  /**
   * Distance of a log-feature vector to one template after removing the best overall gain.
   * Masked bands (something else was already sounding there) cannot be compared directly, but the
   * total energy seen there (`upper`) is still an upper bound on what this hit put into the band:
   * a template that predicts more than that is penalised, one that predicts less is not.
   */
  _distSingle(logVec, entry, mask, upper) {
    let num = 0, den = 0, used = 0;
    for (let c = 0; c < FEATURE_DIM; c++) {
      if (mask && mask[c]) continue;
      num += (logVec[c] - entry.mean[c]) / entry.vari[c];
      den += 1 / entry.vari[c];
      used++;
    }
    if (!used) return Infinity;
    const shift = num / den;
    let s = 0;
    for (let c = 0; c < FEATURE_DIM; c++) {
      let r;
      if (mask && mask[c]) r = upper ? Math.max(0, entry.mean[c] + shift - upper[c]) : 0;
      else r = logVec[c] - entry.mean[c] - shift;
      s += (r * r) / entry.vari[c];
    }
    return s / FEATURE_DIM;
  }

  /**
   * Fit hit = gi*Ti + gj*Tj (linear power, non-negative gains, relative-error least squares) and
   * return the log-domain distance of that mix, or null when the mix is degenerate. domI / domJ
   * count the bands each drum dominates; with `fresh` given, only bands whose energy is clearly new
   * count, so the tail of the previous drum cannot pose as a second drum.
   */
  _distPair(logVec, ei, ej, mask, fresh) {
    let a = 0, b = 0, d = 0, p = 0, q = 0, used = 0;
    const y = new Array(FEATURE_DIM), ti = new Array(FEATURE_DIM), tj = new Array(FEATURE_DIM);
    for (let c = 0; c < FEATURE_DIM; c++) {
      if (mask && mask[c]) continue;
      used++;
      y[c] = Math.exp(logVec[c]);
      ti[c] = Math.exp(ei.mean[c]);
      tj[c] = Math.exp(ej.mean[c]);
      const w = 1 / (y[c] * y[c]);
      a += w * ti[c] * ti[c]; b += w * ti[c] * tj[c]; d += w * tj[c] * tj[c];
      p += w * ti[c] * y[c]; q += w * tj[c] * y[c];
    }
    const det = a * d - b * b;
    if (!(det > 1e-9 * a * d)) return null;
    const gi = (p * d - q * b) / det;
    const gj = (q * a - p * b) / det;
    if (!(gi > 0) || !(gj > 0)) return null;
    let s = 0, domI = 0, domJ = 0, powI = 0, powJ = 0;
    for (let c = 0; c < FEATURE_DIM; c++) {
      if (mask && mask[c]) continue;
      const mi = gi * ti[c], mj = gj * tj[c], m = mi + mj;
      const share = mi / m;
      const v = share * ei.vari[c] + (1 - share) * ej.vari[c];
      const r = logVec[c] - Math.log(m);
      s += (r * r) / v;
      if (c < N_FULL) {
        powI += mi; powJ += mj;
        // A drum only counts as "present" in bands that hold real energy (not the -30 dB floor)
        // and where that energy is clearly new.
        if (logVec[c] < PRESENT_LOG || (fresh && !fresh[c])) continue;
        if (share > 0.6) domI++; else if (share < 0.4) domJ++;
      }
    }
    return { dist: s / used, domI, domJ, shareI: powI / (powI + powJ + 1e-300) };
  }

  /**
   * Classify one hit. `mask[c]` truthy = feature c is unreliable (something else was sounding there);
   * `upper[c]` is then the log of everything heard in that band, an upper bound for this hit.
   * Returns { lanes: [{ lane, confidence }], guess, guessConfidence, d1, d2 }.
   * `lanes` is empty when the result is not trustworthy; `guess` is still the nearest template.
   */
  classify(logVec, minConfidence = DEFAULT_OPTIONS.minConfidence, mask = null, upper = null, fresh = null) {
    const names = this.trainedLanes();
    if (names.length < 2) return { lanes: [], guess: null, guessConfidence: 0, d1: Infinity, d2: Infinity };
    const scored = names.map((lane) => ({ lane, d: this._distSingle(logVec, this.lanes[lane], mask, upper) }))
      .sort((x, y) => x.d - y.d);
    const best = scored[0], second = scored[1];

    // Two drums at once? Only considered when no single template fits well, only for drum pairs that
    // are clearly different from each other, and only when the mix is a much better explanation.
    let pair = null;
    let clean = FEATURE_DIM;
    if (mask) for (let c = 0; c < FEATURE_DIM; c++) if (mask[c]) clean--;
    if (best.d > 1.0 && clean >= 12) {
      for (let i = 0; i < names.length; i++) {
        for (let j = i + 1; j < names.length; j++) {
          if (this.templateDistance(names[i], names[j]) < 6) continue;
          const fit = this._distPair(logVec, this.lanes[names[i]], this.lanes[names[j]], mask, fresh);
          if (!fit || fit.domI < 2 || fit.domJ < 2) continue;
          if (fit.shareI < 0.01 || fit.shareI > 0.99) continue;
          if (!pair || fit.dist < pair.dist) pair = { a: names[i], b: names[j], dist: fit.dist };
        }
      }
      if (pair && !(pair.dist < 0.45 * best.d && pair.dist < 3.5)) pair = null;
    }

    // margin: ~0 when the runner-up template also fits within normal hit-to-hit variation (distance
    // around 1 or less), -> 1 when only the best template fits. The +1 stops two tiny distances
    // from looking like a confident win, which is exactly the near-identical-pads case.
    const margin = clamp(1 - (best.d + 1) / (second.d + 1), 0, 1);
    // fit: 1 for a hit that looks like the training examples, falling off for unfamiliar sounds.
    const fitOf = (dist) => 1 / (1 + Math.pow(dist / 5, 2));
    const singleConfidence = margin * fitOf(best.d);

    if (pair) {
      const pairMargin = clamp(1 - (pair.dist + 1) / (best.d + 1), 0, 1);
      const confidence = pairMargin * fitOf(pair.dist);
      if (confidence >= minConfidence) {
        return {
          lanes: [{ lane: pair.a, confidence }, { lane: pair.b, confidence }],
          guess: best.lane, guessConfidence: singleConfidence, d1: best.d, d2: second.d, pairDist: pair.dist,
        };
      }
    }
    return {
      lanes: singleConfidence >= minConfidence ? [{ lane: best.lane, confidence: singleConfidence }] : [],
      guess: best.lane, guessConfidence: singleConfidence, d1: best.d, d2: second.d,
    };
  }

  toJSON() {
    const lanes = {};
    for (const lane of Object.keys(this.lanes)) {
      const e = this.lanes[lane];
      if (!e.examples.length) continue;
      lanes[lane] = { examples: e.examples.map((x) => x.map((v) => Math.round(v * 1000) / 1000)) };
    }
    return lanes;
  }

  fromJSON(lanes) {
    this.lanes = {};
    if (!lanes || typeof lanes !== 'object') return;
    for (const lane of Object.keys(lanes)) {
      if (!LANES.includes(lane)) continue;
      const src = lanes[lane] && Array.isArray(lanes[lane].examples) ? lanes[lane].examples : [];
      const examples = src.filter((e) => Array.isArray(e) && e.length === FEATURE_DIM && e.every(Number.isFinite));
      if (!examples.length) continue;
      this.lanes[lane] = { examples: examples.map((e) => e.slice()), mean: null, vari: null };
      this._rebuild(lane);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// 1. Hit detector (pure; fed with raw mono samples + the context time of the first sample)
// ---------------------------------------------------------------------------------------------

export class HitDetector {
  constructor(sampleRate, options = {}) {
    this.sampleRate = sampleRate > 0 ? sampleRate : 48000;
    this.opts = { ...DEFAULT_OPTIONS, ...options };
    const sr = this.sampleRate;

    // Detection STFT: hop ~2.7-2.9 ms at 44.1/48 kHz, window 4 hops.
    this.hop = Math.max(32, Math.pow(2, Math.round(Math.log2(sr * 0.0029))));
    this.win = this.hop * 4;
    this.fft = new FFT(this.win);
    this.window = hann(this.win);
    let wsum = 0;
    for (let i = 0; i < this.win; i++) wsum += this.window[i] * this.window[i];
    this.detNorm = 2 / (this.win * wsum);
    const top = Math.min(18000, sr * 0.47);
    this.detBands = bandBins([Math.min(60, sr / this.win), 250, 3000, top], this.win, sr);
    this.frame = new Float64Array(this.win);
    this.spec = new Float64Array(this.win / 2 + 1);

    // Ring buffer of raw samples (>= 0.3 s).
    this.ringSize = nextPow2(Math.ceil(sr * 0.3));
    this.mask = this.ringSize - 1;
    this.ring = new Float32Array(this.ringSize);
    this.n = 0;                    // absolute index of the next sample
    this.anchorIndex = 0;          // sample index whose time is anchorTime
    this.anchorTime = 0;
    this.hopCountdown = this.hop;

    // Per-band state.
    const nb = this.detBands.length;
    this.env = new Float64Array(nb);                 // decaying peak-hold of band energy
    this.envHist = Array.from({ length: nb }, () => new Float64Array(3)); // env of the last 3 frames
    this.noise = new Float64Array(nb).fill(-1);      // tracked noise floor (-1 = not initialised)
    this.jitter = new Float64Array(nb);              // running mean-square of upward flutter (ln units)
    this.framesSeen = 0;
    const framesPerSec = sr / this.hop;
    this.envDecay = Math.pow(10, -14 / framesPerSec);    // peak-hold falls 140 dB/s (power: 14 B/s)
    this.noiseRise = Math.pow(10, 0.3 / framesPerSec);   // noise floor may creep up 3 dB/s
    this.jitterRate = 1 / (0.2 * framesPerSec);          // flutter statistic averages over ~200 ms

    // Feature extraction.
    this.featLen = Math.round(sr * (this.opts.classifyWindowSec + 0.002));
    this.featSize = nextPow2(this.featLen) * 2;
    this.featFft = new FFT(this.featSize);
    this.featBuf = new Float64Array(this.featSize);
    this.featSpec = new Float64Array(this.featSize / 2 + 1);
    const edges = FEATURE_EDGES_HZ.map((f) => Math.min(f, sr * 0.48));
    this.featBands = bandBins(edges, this.featSize, sr);

    // Events.
    this.refractN = Math.round(sr * this.opts.refractorySec);
    this.classifyN = Math.round(sr * this.opts.classifyWindowSec);
    this.lastOnsetIdx = -1e12;
    this.pending = null;

    // Settings and outputs.
    this.sensitivity = clamp(this.opts.sensitivity, 0, 1);
    this.latencySec = 0;
    this.referenceGate = null;
    this.classifier = new DrumClassifier();
    this.trainingLane = null;
    this.trainingCount = 0;
    this.muted = false;            // true while the loopback latency test is running
    this.onHit = null;             // ({ time, lane, confidence, strength, ... })
    this.onLevel = null;           // (rms)
    this.onRawOnset = null;        // ({ time (uncorrected), strength })

    this.levelBlock = Math.round(sr / 20);
    this.levelAcc = 0;
    this.levelCount = 0;
  }

  setSensitivity(x) {
    this.sensitivity = clamp(Number.isFinite(+x) ? +x : 0.5, 0, 1);
  }

  /** Thresholds derived from sensitivity (0 = only hard hits, 1 = very soft taps). */
  _thresholds(gated) {
    const s = this.sensitivity;
    let ratio = 8 * Math.pow(2.2 / 8, s);                    // required energy jump (power ratio)
    let absolute = Math.pow(10, (-30 - 30 * s) / 10);        // band power floor: -30 .. -60 dBFS
    const overNoise = 16 * Math.pow(4 / 16, s);              // required ratio over the noise floor
    if (gated) { ratio *= 2; absolute *= 16; }               // backing-track drum expected right now
    return { ratio, absolute, overNoise };
  }

  timeOf(sampleIndex) {
    return this.anchorTime + (sampleIndex - this.anchorIndex) / this.sampleRate;
  }

  /** Push mono samples. `startTimeSec` = audio-clock time of samples[0] (omit to continue seamlessly). */
  process(samples, startTimeSec) {
    if (!samples || !samples.length) return;
    if (Number.isFinite(startTimeSec)) {
      this.anchorTime = startTimeSec;
    } else {
      this.anchorTime = this.timeOf(this.n);
    }
    this.anchorIndex = this.n;
    const ring = this.ring, mask = this.mask;
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i];
      ring[this.n & mask] = x;
      this.n++;
      this.levelAcc += x * x;
      if (++this.levelCount >= this.levelBlock) {
        const rms = Math.sqrt(this.levelAcc / this.levelCount);
        this.levelAcc = 0; this.levelCount = 0;
        if (this.onLevel) this.onLevel(clamp(rms, 0, 1));
      }
      if (--this.hopCountdown === 0) {
        this.hopCountdown = this.hop;
        this._frame();
      }
    }
  }

  _frame() {
    const n = this.n, N = this.win, ring = this.ring, mask = this.mask;
    if (n < N) return;
    const frame = this.frame, w = this.window;
    for (let k = 0; k < N; k++) frame[k] = ring[(n - N + k) & mask] * w[k];
    this.fft.power(frame, this.spec);

    let gated = false;
    if (this.referenceGate) {
      try { gated = !!this.referenceGate(this.timeOf(n - this.hop) - this.latencySec); } catch { gated = false; }
    }
    const thr = this._thresholds(gated);
    const warm = this.framesSeen >= 8;       // let the noise floor settle before trusting anything
    this.framesSeen++;

    // Frames that belong to an event say nothing about how much a band flutters on its own.
    const inEvent = n - this.lastOnsetIdx < this.refractN + this.win;
    const logRatio = Math.log(thr.ratio);
    let fired = 0;
    for (let b = 0; b < this.detBands.length; b++) {
      const [lo, hi] = this.detBands[b];
      let e = 0;
      for (let k = lo; k < hi; k++) e += this.spec[k];
      e *= this.detNorm;
      const hist = this.envHist[b];
      const reference = hist[0];                        // peak-hold as it was 3 frames ago
      const noise = this.noise[b] < 0 ? e : this.noise[b];
      // Adaptive part of the threshold: a band that is fluttering by itself (a noisy cymbal tail,
      // hiss in a band only a few bins wide) must jump that much further before it counts.
      const flux = Math.log((e + 1e-14) / (reference + 1e-14));
      const need = logRatio + 2 * Math.sqrt(this.jitter[b]);
      if (warm && flux > need && e > thr.absolute && e > thr.overNoise * noise) {
        fired |= 1 << b;
      } else if (!inEvent) {
        const up = clamp(flux, 0, 2 * logRatio);
        this.jitter[b] += this.jitterRate * (up * up - this.jitter[b]);
      }
      this.env[b] = Math.max(e, this.env[b] * this.envDecay);
      hist[0] = hist[1]; hist[1] = hist[2]; hist[2] = this.env[b];
      // Noise floor: follows the signal down quickly, creeps up slowly.
      this.noise[b] = e < noise ? noise + 0.25 * (e - noise) : Math.max(noise * this.noiseRise, 1e-13);
    }

    if (fired) {
      if (this.pending && n - this.pending.onsetIdx < this.refractN) {
        this.pending.bands |= fired;                    // same event, another band joined in
      } else if (n - this.lastOnsetIdx >= this.refractN) {
        // Second opinion from the waveform itself: a real stroke stands out of the 8 ms before it
        // by a clear margin in 0.5 ms energy blocks; a random wobble of steady hiss does not.
        const onset = this._refineOnset(n, fired);
        if (onset.contrast >= 2.5 && onset.index - this.lastOnsetIdx >= this.refractN) this._beginEvent(onset.index, fired, n);
      }
    }
    if (this.pending && n >= this.pending.onsetIdx + this.classifyN) this._finishEvent();
  }

  /**
   * Locate the onset sample inside the last analysis window using 0.5 ms energy blocks.
   * When the mid/high bands fired we also look at the first difference of the signal (a crude
   * high-pass, so a ringing kick underneath does not hide a hi-hat attack) and keep whichever view
   * shows the attack more clearly above what came before.
   */
  _refineOnset(n, fired) {
    const raw = this._refineIn(n, false);
    if ((fired & 0b110) === 0) return raw;              // only the low band fired
    const hp = this._refineIn(n, true);
    return hp.contrast > raw.contrast ? hp : raw;
  }

  _refineIn(n, diff) {
    const sr = this.sampleRate, ring = this.ring, mask = this.mask;
    const q = Math.max(4, Math.round(sr / 2000));
    const searchBlocks = Math.ceil(this.win / q) + 2;
    const bgBlocks = 16;
    const start = n - (searchBlocks + bgBlocks) * q;
    const nominal = Math.max(0, n - 2 * this.hop);
    if (start < 1) return { index: nominal, contrast: 0 };
    const total = searchBlocks + bgBlocks;
    const energy = new Float64Array(total);
    for (let b = 0; b < total; b++) {
      let s = 0;
      const base = start + b * q;
      for (let i = 0; i < q; i++) {
        const x = diff ? ring[(base + i) & mask] - ring[(base + i - 1) & mask] : ring[(base + i) & mask];
        s += x * x;
      }
      energy[b] = s / q;
    }
    let bgMean = 0, bgMax = 0, peak = 0;
    for (let b = 0; b < bgBlocks; b++) { bgMean += energy[b] / bgBlocks; if (energy[b] > bgMax) bgMax = energy[b]; }
    for (let b = bgBlocks; b < total; b++) if (energy[b] > peak) peak = energy[b];
    const contrast = peak / (bgMax + 1e-15);
    const threshold = Math.max(2 * bgMax, bgMean + 0.08 * (peak - bgMean));
    let block = -1;
    for (let b = bgBlocks; b < total; b++) if (energy[b] > threshold) { block = b; break; }
    if (block < 0) return { index: nominal, contrast: 0 };   // nothing stands out: nominal position
    // First sample at or above the threshold, looking from one block earlier.
    const from = start + (block - 1) * q, to = start + (block + 1) * q;
    for (let i = from; i < to; i++) {
      const x = diff ? ring[i & mask] - ring[(i - 1) & mask] : ring[i & mask];
      if (x * x >= threshold) return { index: i, contrast };
    }
    return { index: start + block * q, contrast };
  }

  _peakStrength(from, to) {
    let peak = 0;
    for (let i = Math.max(0, from); i < to; i++) {
      const a = Math.abs(this.ring[i & this.mask]);
      if (a > peak) peak = a;
    }
    // -50 dBFS -> 0, -6 dBFS -> 1
    return clamp((20 * Math.log10(peak + 1e-9) + 50) / 44, 0, 1);
  }

  _beginEvent(onsetIdx, bands, n) {
    this.lastOnsetIdx = onsetIdx;
    const rawTime = this.timeOf(onsetIdx);
    const strength = this._peakStrength(onsetIdx, n);
    if (this.onRawOnset) this.onRawOnset({ time: rawTime, strength });
    if (this.muted) return;
    const needFeatures = this.trainingLane != null || this.classifier.ready();
    if (!needFeatures) {
      // Timing-only mode: report at once, nothing to wait for.
      this._emit({ time: rawTime - this.latencySec, lane: null, confidence: 0, strength });
      return;
    }
    this.pending = { onsetIdx, bands, rawTime };
  }

  _finishEvent() {
    const ev = this.pending;
    this.pending = null;
    if (this.muted) return;
    const time = ev.rawTime - this.latencySec;
    const strength = this._peakStrength(ev.onsetIdx, ev.onsetIdx + Math.round(this.sampleRate * 0.012));
    const { logVec, mask, upper, fresh, usable } = this.extractFeatures(ev.onsetIdx);
    if (this.trainingLane != null) {
      this.classifier.addExample(this.trainingLane, logVec, this.opts.maxExamplesPerLane);
      this.trainingCount++;
      this._emit({ time, lane: this.trainingLane, confidence: 1, strength, training: true });
      return;
    }
    // Too little of the spectrum is free of other sound to say which drum this was.
    const result = usable
      ? this.classifier.classify(logVec, this.opts.minConfidence, mask, upper, fresh)
      : { lanes: [], guess: null, guessConfidence: 0 };
    if (!result.lanes.length) {
      this._emit({ time, lane: null, confidence: 0, strength, guess: result.guess, guessConfidence: result.guessConfidence });
      return;
    }
    for (const hit of result.lanes) this._emit({ time, lane: hit.lane, confidence: hit.confidence, strength });
  }

  _emit(hit) {
    if (this.onHit) this.onHit(hit);
  }

  /** Windowed band powers (mean-square units) of ring[from .. from+len), into `out`. */
  _bandPowers(from, len, fadeIn, fadeOut, bands, out) {
    const buf = this.featBuf, ring = this.ring, mask = this.mask;
    buf.fill(0);
    let wsum = 0;
    for (let i = 0; i < len; i++) {
      let w = 1;
      if (i < fadeIn) w = 0.5 - 0.5 * Math.cos((Math.PI * (i + 0.5)) / fadeIn);
      else if (i >= len - fadeOut) w = 0.5 - 0.5 * Math.cos((Math.PI * (len - i - 0.5)) / fadeOut);
      buf[i] = ring[(from + i) & mask] * w;
      wsum += w * w;
    }
    this.featFft.power(buf, this.featSpec);
    const norm = 2 / (this.featSize * wsum);
    for (let b = 0; b < bands.length; b++) {
      let s = 0;
      for (let k = bands[b][0]; k < bands[b][1]; k++) s += this.featSpec[k];
      out[b] = s * norm;
    }
    return out;
  }

  /**
   * Features of the hit whose onset is at `onsetIdx`: { logVec, mask, upper, usable }.
   * mask[c] = 1 marks a band where the sound from before the hit (in that band or the one above,
   * because a ringing kick slides down in pitch) is at least as strong as the hit itself, so the
   * band cannot be compared directly. upper[c] = log of all energy heard there. mask is null when
   * every band is clean. fresh[c] = 0 marks bands that are not clearly new energy (used to stop a
   * tail being read as a second simultaneous drum). usable is false when fewer than 2 bands are clean.
   * Needs classifyWindowSec of audio after the onset to be in the ring buffer.
   */
  extractFeatures(onsetIdx) {
    const sr = this.sampleRate;
    const pre = Math.round(sr * 0.002);
    const len = this.featLen;
    const lateLen = Math.round(sr * 0.020);
    const full = new Float64Array(N_FULL), late = new Float64Array(N_FULL), bg = new Float64Array(N_FULL);
    this._bandPowers(onsetIdx - pre, len, pre, Math.round(sr * 0.008), this.featBands, full);
    this._bandPowers(onsetIdx + this.classifyN - lateLen, lateLen, Math.round(sr * 0.004), Math.round(sr * 0.004), this.featBands, late);
    // What was already sounding just before the hit (noise, bleed, previous drum's tail).
    const bgFrom = onsetIdx - pre - Math.round(sr * 0.001) - len;
    if (bgFrom > this.n - this.ringSize && bgFrom >= 0) {
      this._bandPowers(bgFrom, len, pre, Math.round(sr * 0.008), this.featBands, bg);
    }
    const cells = new Float64Array(FEATURE_DIM);
    const before = new Float64Array(FEATURE_DIM);
    let total = 0;
    for (let b = 0; b < N_FULL; b++) {
      cells[b] = Math.max(0, full[b] - bg[b]);
      before[b] = bg[b];
      total += cells[b];
    }
    for (let b = 0; b < N_LATE; b++) {
      const l = late[2 * b] + late[2 * b + 1], g = bg[2 * b] + bg[2 * b + 1];
      cells[N_FULL + b] = Math.max(0, l - g);
      before[N_FULL + b] = g;
    }
    total = Math.max(total, 1e-14);
    const mask = new Array(FEATURE_DIM).fill(0);
    const fresh = new Array(FEATURE_DIM).fill(1);
    let masked = 0, stale = 0;
    for (let c = 0; c < FEATURE_DIM; c++) {
      // Also look at the band above: a ringing drum slides down in pitch into this one.
      const hi = c < N_FULL ? N_FULL - 1 : FEATURE_DIM - 1;
      const around = Math.max(before[c], c < hi ? before[c + 1] : 0);
      if (around > cells[c] && around > 0.003 * total) { mask[c] = 1; masked++; }
      // "fresh": at least 6 dB above anything that was sounding in this band or either neighbour.
      const lo = c < N_FULL ? 0 : N_FULL;
      const wide = Math.max(around, c > lo ? before[c - 1] : 0);
      if (4 * wide > cells[c] && wide > 0.0003 * total) { fresh[c] = 0; stale++; }
    }
    // Normalise by the energy in the trustworthy bands only, so left-over energy from the previous
    // drum does not push this hit's own bands down towards the floor.
    if (masked) {
      let cleanTotal = 0;
      for (let b = 0; b < N_FULL; b++) if (!mask[b]) cleanTotal += cells[b];
      if (cleanTotal > 0) total = cleanTotal;
    }
    const logVec = new Array(FEATURE_DIM);
    const upper = new Array(FEATURE_DIM);
    for (let c = 0; c < FEATURE_DIM; c++) {
      logVec[c] = Math.log(cells[c] / total + FEATURE_EPS);
      upper[c] = Math.log((cells[c] + before[c]) / total + FEATURE_EPS);
    }
    return { logVec, mask: masked ? mask : null, upper, fresh: stale ? fresh : null, usable: FEATURE_DIM - masked >= 2 };
  }

  // --- training -------------------------------------------------------------------------------

  startTraining(lane) {
    if (!LANES.includes(lane)) throw new Error(`Unknown lane: ${lane}`);
    this.trainingLane = lane;
    this.trainingCount = 0;
  }

  stopTraining() {
    // An event still waiting for its classification window belongs to this training run.
    if (this.pending && this.trainingLane != null && this.n >= this.pending.onsetIdx + this.classifyN) this._finishEvent();
    this.pending = null;
    const out = { lane: this.trainingLane, count: this.trainingCount, total: this.classifier.count(this.trainingLane) };
    this.trainingLane = null;
    this.trainingCount = 0;
    return out;
  }

  noiseFloorDb() {
    return Array.from(this.noise, (v) => (v > 0 ? Math.round(10 * Math.log10(v) * 10) / 10 : -120));
  }
}

// ---------------------------------------------------------------------------------------------
// 3. Loopback latency estimate (pure)
// ---------------------------------------------------------------------------------------------

/**
 * Given the scheduled click times and the raw (uncorrected) onset times heard by the mic, estimate
 * the speaker -> air -> mic round-trip latency. ok only when most clicks were heard consistently.
 */
export function estimateLoopbackLatency(clickTimes, onsetTimes, { maxLatencySec = 0.45 } = {}) {
  const delays = [];
  for (const click of clickTimes) {
    let first = Infinity;
    for (const t of onsetTimes) if (t >= click - 0.002 && t < click + maxLatencySec && t < first) first = t;
    if (first < Infinity) delays.push(first - click);
  }
  if (!delays.length) return { latencySec: 0, ok: false, heard: 0, spreadSec: 0 };
  const med = median(delays);
  const close = delays.filter((d) => Math.abs(d - med) <= 0.012);
  const spreadSec = median(delays.map((d) => Math.abs(d - med)));
  const latencySec = Math.max(0, median(close.length ? close : delays));
  const need = Math.max(3, Math.ceil(clickTimes.length * 0.6));
  return { latencySec, ok: close.length >= need, heard: delays.length, spreadSec };
}

// ---------------------------------------------------------------------------------------------
// 4. Browser glue
// ---------------------------------------------------------------------------------------------

// Runs on the audio thread. Forwards mono capture blocks with the context time of their first sample.
const WORKLET_SOURCE = `
class DrumHeroCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 256;
    this.buf = new Float32Array(this.size);
    this.fill = 0;
    this.startTime = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length || !input[0]) return true;
    const channels = input.length, frames = input[0].length;
    for (let i = 0; i < frames; i++) {
      if (this.fill === 0) this.startTime = currentTime + i / sampleRate;
      let s = 0;
      for (let c = 0; c < channels; c++) s += input[c][i];
      this.buf[this.fill++] = s / channels;
      if (this.fill === this.size) {
        this.port.postMessage({ samples: this.buf, time: this.startTime }, [this.buf.buffer]);
        this.buf = new Float32Array(this.size);
        this.fill = 0;
      }
    }
    return true;
  }
}
registerProcessor('drum-hero-capture', DrumHeroCapture);
`;

export function createListener(audioContext) {
  const ctx = audioContext || null;
  const detector = new HitDetector(ctx && ctx.sampleRate ? ctx.sampleRate : 48000);
  const hitSubs = new Set();
  const levelSubs = new Set();
  const rawSubs = new Set();
  const callAll = (subs, value) => {
    for (const cb of Array.from(subs)) {
      try { cb(value); } catch (err) { if (typeof console !== 'undefined') console.error(err); }
    }
  };
  detector.onHit = (hit) => callAll(hitSubs, hit);
  detector.onLevel = (rms) => callAll(levelSubs, rms);
  detector.onRawOnset = (o) => callAll(rawSubs, o);

  let running = false;
  let stream = null, source = null, node = null, sink = null, moduleUrl = null;
  let captureMode = null;          // 'worklet' | 'script'

  async function start() {
    if (running) return;
    if (!ctx) throw new Error('No audio context');
    const media = typeof navigator !== 'undefined' ? navigator.mediaDevices : null;
    if (!media || !media.getUserMedia) {
      throw new Error('This browser cannot use the microphone here (it needs https or localhost).');
    }
    try {
      stream = await media.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
        video: false,
      });
    } catch (err) {
      const name = err && err.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        throw new Error('Microphone permission was denied. Allow the microphone for this page and try again.');
      }
      if (name === 'NotFoundError' || name === 'OverconstrainedError') throw new Error('No microphone was found.');
      throw new Error(`Could not open the microphone: ${(err && err.message) || name || 'unknown error'}`);
    }
    try {
      if (ctx.state === 'suspended' && ctx.resume) await ctx.resume().catch(() => {});
      source = ctx.createMediaStreamSource(stream);
      sink = ctx.createGain();
      sink.gain.value = 0;                      // keeps the graph pulled without playing the mic back
      sink.connect(ctx.destination);

      node = null;
      if (ctx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
        try {
          moduleUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
          await ctx.audioWorklet.addModule(moduleUrl);
          node = new AudioWorkletNode(ctx, 'drum-hero-capture', {
            numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
          });
          node.port.onmessage = (e) => detector.process(e.data.samples, e.data.time);
          captureMode = 'worklet';
        } catch {
          node = null;
        }
      }
      if (!node) {
        // Fallback: ScriptProcessor. Its output plays one buffer after the input was captured, so the
        // input block started one buffer length before playbackTime.
        const size = 1024;
        node = ctx.createScriptProcessor(size, 1, 1);
        node.onaudioprocess = (e) => {
          const data = e.inputBuffer.getChannelData(0);
          const duration = data.length / ctx.sampleRate;
          const t = Number.isFinite(e.playbackTime) && e.playbackTime > 0 ? e.playbackTime - duration : ctx.currentTime - duration;
          detector.process(data, t);
        };
        captureMode = 'script';
      }
      source.connect(node);
      node.connect(sink);
      running = true;
    } catch (err) {
      stop();
      throw new Error(`Could not start listening: ${(err && err.message) || err}`);
    }
  }

  function stop() {
    running = false;
    try { if (node && node.port) node.port.onmessage = null; } catch { /* ignore */ }
    try { if (node) { node.onaudioprocess = null; node.disconnect(); } } catch { /* ignore */ }
    try { if (source) source.disconnect(); } catch { /* ignore */ }
    try { if (sink) sink.disconnect(); } catch { /* ignore */ }
    try { if (stream) stream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    try { if (moduleUrl) URL.revokeObjectURL(moduleUrl); } catch { /* ignore */ }
    node = source = sink = stream = moduleUrl = null;
    detector.pending = null;
  }

  /**
   * Play short clicks from the speaker and time their arrival at the mic. The result is the full
   * output + air + input round trip, which is what must be subtracted from mic timestamps for a
   * player who plays along to sound coming from this device. Sets the latency when ok.
   */
  async function measureLatencyLoopback() {
    if (!ctx || !ctx.createBuffer) return { latencySec: detector.latencySec, ok: false };
    const startedHere = !running;
    try {
      if (startedHere) await start();
    } catch {
      return { latencySec: detector.latencySec, ok: false };
    }
    const sr = ctx.sampleRate;
    const clickLen = Math.round(sr * 0.004);
    const buffer = ctx.createBuffer(1, clickLen, sr);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < clickLen; i++) {
      data[i] = Math.sin((2 * Math.PI * 2500 * i) / sr) * Math.exp(-i / (sr * 0.001)) * 0.9;
    }
    const gaps = [0, 0.31, 0.57, 0.9, 1.19, 1.53];   // uneven so a steady noise cannot fake it
    const t0 = ctx.currentTime + 0.35;
    const clickTimes = gaps.map((g) => t0 + g);
    const onsets = [];
    const collect = (o) => onsets.push(o.time);
    const savedSensitivity = detector.sensitivity;
    rawSubs.add(collect);
    detector.muted = true;                            // do not report the clicks as drum hits
    detector.setSensitivity(Math.max(savedSensitivity, 0.8));
    try {
      for (const t of clickTimes) {
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(ctx.destination);
        src.start(t);
      }
      const waitMs = (clickTimes[clickTimes.length - 1] - ctx.currentTime + 0.6) * 1000;
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, waitMs)));
    } catch {
      /* fall through with whatever was heard */
    } finally {
      rawSubs.delete(collect);
      detector.muted = false;
      detector.setSensitivity(savedSensitivity);
      if (startedHere) stop();
    }
    const result = estimateLoopbackLatency(clickTimes, onsets);
    if (result.ok) detector.latencySec = result.latencySec;
    return { latencySec: result.ok ? result.latencySec : detector.latencySec, ok: result.ok, heard: result.heard, spreadSec: result.spreadSec };
  }

  function getProfile() {
    return {
      version: PROFILE_VERSION,
      featureDim: FEATURE_DIM,
      sampleRate: detector.sampleRate,
      latencySec: detector.latencySec,
      sensitivity: detector.sensitivity,
      noiseFloorDb: detector.noiseFloorDb(),
      lanes: detector.classifier.toJSON(),
    };
  }

  function setProfile(obj) {
    if (!obj || typeof obj !== 'object') return;
    if (Number.isFinite(obj.latencySec)) detector.latencySec = clamp(obj.latencySec, -0.5, 1);
    if (Number.isFinite(obj.sensitivity)) detector.setSensitivity(obj.sensitivity);
    // Templates from another feature layout cannot be reused; the drums must be taught again.
    if (obj.lanes && (obj.version == null || obj.version === PROFILE_VERSION) &&
        (obj.featureDim == null || obj.featureDim === FEATURE_DIM)) {
      detector.classifier.fromJSON(obj.lanes);
    }
  }

  return {
    start,
    stop,
    isRunning: () => running,
    onHit(cb) { hitSubs.add(cb); return () => hitSubs.delete(cb); },
    onLevel(cb) { levelSubs.add(cb); return () => levelSubs.delete(cb); },
    setSensitivity: (x) => detector.setSensitivity(x),
    getSensitivity: () => detector.sensitivity,
    setLatencySec(sec) { if (Number.isFinite(+sec)) detector.latencySec = +sec; },
    getLatencySec: () => detector.latencySec,
    measureLatencyLoopback,
    startTraining: (lane) => detector.startTraining(lane),
    stopTraining: () => detector.stopTraining(),
    clearTraining: (lane) => detector.classifier.clear(lane),
    trainedLanes: () => detector.classifier.trainedLanes(),
    getProfile,
    setProfile,
    feed: (float32Array, startTimeSec) => detector.process(float32Array, startTimeSec),

    // --- extras beyond the shared contract (all optional for callers) ---
    /**
     * fn(time) -> boolean, or null. `time` is in the same corrected clock as hit times. While it
     * returns true the detector needs a jump twice as large and a level 12 dB higher, so a drum hit
     * in the backing track coming out of the phone speaker is less likely to count as the player.
     */
    setReferenceGate(fn) { detector.referenceGate = typeof fn === 'function' ? fn : null; },
    /** Which taught drums the mic cannot tell apart: { lanes, pairs: [{a,b,distance,confusable}], confusable }. */
    getTrainingQuality: () => detector.classifier.quality(),
    /** 'worklet' | 'script' | null — which capture path is in use. */
    captureMode: () => (running ? captureMode : null),
  };
}

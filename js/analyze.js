// analyze.js — offline analysis of a song: tempo / beats and an approximate drum transcription.
// Pure: works on a mono Float32Array, no DOM, runs in Node.
//
// Pipeline
//   1. One STFT pass (2048-point Hann, hop 512 at 44.1/48 kHz, i.e. ~11 ms). Per frame we keep only
//      a 24-band log spectrum flux (the "onset envelope") and the power in five wide bands, so a
//      five-minute song needs a few MB on top of the caller's samples. The pass yields to the event
//      loop every ~100 ms of work and reports progress.
//   2. Tempo: autocorrelation of the onset envelope scored with a comb at 1x..4x the beat period,
//      60-180 bpm; half/double ambiguity is settled by comparing the envelope on the beats with the
//      envelope half-way between them (preferring 70-140 bpm); the period is then refined to a
//      fraction of a percent by folding the whole envelope at candidate periods.
//   3. Beats: a rigid grid when the song holds its tempo, otherwise a dynamic-programming beat
//      tracker (Ellis 2007) so the grid follows a drummer who drifts.
//   4. Downbeat: the beat-of-four that best fits "kick on 1 (and 3), snare on 2 and 4, crash on 1".
//   5. Transcription: sharp rises in the low band that die away again within ~150 ms are kicks (a
//      bass note keeps sounding), simultaneous rises in the mid and presence bands that also die away are snares, rises in the top band are hi-hats, and a top-band hit that is
//      still ringing 150-350 ms later is a crash. Peaks must be a good fraction of that band's
//      typical strong hit, and must sit near a 16th-note slot of the beat grid.
//
// Limits (be honest with the parent):
//   * It assumes 4/4 and a straight 16th grid; swung or triplet feels come out roughly.
//   * In a dense mix, bass notes can read as kicks and loud guitar/vocal attacks as snares; toms are
//     not transcribed (they come out as kick or snare, or not at all).
//   * Hi-hats under a snare or a ringing crash cannot be heard; they are filled in only when the
//     hi-hats on both sides are present.
//   * Half/double-time and the choice between beat 1 and beat 3 are educated guesses.

import { FFT, hann, clamp, median, percentile, bandBins, yieldToUi, nowMs } from './dsp-util.js';

const MIN_BPM = 60;
const MAX_BPM = 180;

// Transcription bands (Hz).
const BAND_EDGES = {
  low: [30, 120],
  body: [150, 400],
  mid: [400, 2500],
  pres: [2500, 6000],
  high: [6000, 16000],
};
const BAND_NAMES = Object.keys(BAND_EDGES);

// ---------------------------------------------------------------------------------------------
// 1. STFT features
// ---------------------------------------------------------------------------------------------

/**
 * Returns { frameRate, frames, env: Float32Array (onset envelope), bands: {name: Float32Array (power)} }.
 * Frame f is centred on sample f*hop, so its time is f / frameRate.
 */
export async function computeFeatures(channelData, sampleRate, onProgress) {
  const size = sampleRate >= 32000 ? 2048 : sampleRate >= 16000 ? 1024 : 512;
  const hop = size / 4;
  const half = size / 2;
  const frames = Math.max(1, Math.floor(channelData.length / hop) + 1);
  const fft = new FFT(size);
  const window = hann(size);
  let wsum = 0;
  for (let i = 0; i < size; i++) wsum += window[i] * window[i];
  const norm = 2 / (size * wsum);
  const frame = new Float64Array(size);
  const spec = new Float64Array(half + 1);

  const top = Math.min(16000, sampleRate * 0.47);
  // 24 log-spaced bands for the onset envelope.
  const fluxEdges = [];
  for (let b = 0; b <= 24; b++) fluxEdges.push(40 * Math.pow(top / 40, b / 24));
  const fluxBins = bandBins(fluxEdges, size, sampleRate);
  const namedBins = BAND_NAMES.map((name) => bandBins(BAND_EDGES[name].map((f) => Math.min(f, top)), size, sampleRate)[0]);

  const flux = new Float32Array(frames * fluxBins.length);
  const bands = {};
  for (const name of BAND_NAMES) bands[name] = new Float32Array(frames);

  let lastYield = nowMs();
  const n = channelData.length;
  for (let f = 0; f < frames; f++) {
    const start = f * hop - half;
    for (let i = 0; i < size; i++) {
      const idx = start + i;
      frame[i] = idx >= 0 && idx < n ? channelData[idx] * window[i] : 0;
    }
    fft.power(frame, spec);
    for (let b = 0; b < fluxBins.length; b++) {
      let s = 0;
      for (let k = fluxBins[b][0]; k < fluxBins[b][1]; k++) s += spec[k];
      flux[f * fluxBins.length + b] = s * norm;
    }
    for (let b = 0; b < BAND_NAMES.length; b++) {
      let s = 0;
      for (let k = namedBins[b][0]; k < namedBins[b][1]; k++) s += spec[k];
      bands[BAND_NAMES[b]][f] = s * norm;
    }
    if ((f & 31) === 0 && nowMs() - lastYield > 100) {
      if (onProgress) onProgress(f / frames);
      await yieldToUi();
      lastYield = nowMs();
    }
  }

  // Onset envelope: positive change of log-compressed band power, summed over bands.
  const nb = fluxBins.length;
  let maxPower = 0;
  for (let i = 0; i < flux.length; i++) if (flux[i] > maxPower) maxPower = flux[i];
  const gain = maxPower > 0 ? 1000 / maxPower : 0;
  const env = new Float32Array(frames);
  const prev = new Float64Array(nb);
  for (let f = 0; f < frames; f++) {
    let s = 0;
    for (let b = 0; b < nb; b++) {
      const v = Math.log(1 + gain * flux[f * nb + b]);
      if (f > 0 && v > prev[b]) s += v - prev[b];
      prev[b] = v;
    }
    env[f] = s;
  }
  // Remove the slow trend so sustained loud passages do not swamp the beat pulse.
  const smooth = movingAverage(env, Math.round((0.4 * sampleRate) / hop));
  for (let f = 0; f < frames; f++) env[f] = Math.max(0, env[f] - smooth[f]);

  return { frameRate: sampleRate / hop, frames, env, bands, durationSec: n / sampleRate };
}

function movingAverage(x, halfWidth) {
  const n = x.length, out = new Float32Array(n);
  let acc = 0, count = 0;
  for (let i = 0; i < Math.min(n, halfWidth); i++) { acc += x[i]; count++; }
  for (let i = 0; i < n; i++) {
    const add = i + halfWidth, drop = i - halfWidth - 1;
    if (add < n) { acc += x[add]; count++; }
    if (drop >= 0) { acc -= x[drop]; count--; }
    out[i] = acc / Math.max(1, count);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// 2. Tempo
// ---------------------------------------------------------------------------------------------

function autocorrelation(x, maxLag) {
  const n = x.length;
  const out = new Float64Array(maxLag + 1);
  for (let lag = 0; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = lag; i < n; i++) s += x[i] * x[i - lag];
    out[lag] = s / Math.max(1, n - lag);       // unbiased, so long lags are not penalised
  }
  return out;
}

function interp(arr, pos) {
  if (pos <= 0) return arr[0];
  if (pos >= arr.length - 1) return arr[arr.length - 1];
  const i = Math.floor(pos), f = pos - i;
  return arr[i] * (1 - f) + arr[i + 1] * f;
}

/**
 * Fold the envelope at `period` (frames): average pulse shape over one beat, in bins of one frame.
 * Returns { peak, phase (frames, 0..period), contrast, half } where `half` is the level half a beat
 * after the peak relative to the peak.
 */
function fold(env, period) {
  const bins = Math.max(4, Math.round(period));
  const hist = new Float64Array(bins);
  const scale = bins / period;
  for (let i = 0; i < env.length; i++) {
    if (env[i] <= 0) continue;
    const pos = (i % period) * scale;          // fractional bin
    const b = Math.floor(pos), f = pos - b;
    hist[b % bins] += env[i] * (1 - f);
    hist[(b + 1) % bins] += env[i] * f;
  }
  const sm = new Float64Array(bins);
  let peak = -1, at = 0, mean = 0;
  for (let b = 0; b < bins; b++) {
    sm[b] = 0.25 * hist[(b + bins - 1) % bins] + 0.5 * hist[b] + 0.25 * hist[(b + 1) % bins];
    mean += sm[b] / bins;
    if (sm[b] > peak) { peak = sm[b]; at = b; }
  }
  // Parabolic refinement of the peak position.
  const l = sm[(at + bins - 1) % bins], r = sm[(at + 1) % bins];
  const denom = l - 2 * peak + r;
  const delta = denom < 0 ? clamp((0.5 * (l - r)) / denom, -0.5, 0.5) : 0;
  const phase = ((((at + delta) / scale) % period) + period) % period;
  const halfAt = Math.round(at + bins / 2) % bins;
  let half = 0;
  for (let d = -1; d <= 1; d++) half = Math.max(half, sm[(halfAt + d + bins) % bins]);
  return { peak, phase, contrast: peak > 0 ? (peak - mean) / (peak + mean) : 0, half: peak > 0 ? half / peak : 0 };
}

/** Tempo, phase and confidence from the onset envelope. */
export function estimateTempo(env, frameRate) {
  const n = env.length;
  const fallback = { bpm: 120, periodFrames: (frameRate * 60) / 120, phaseFrames: 0, confidence: 0 };
  let energy = 0;
  for (let i = 0; i < n; i++) energy += env[i];
  if (n < frameRate * 2 || energy <= 0) return fallback;

  const maxLag = Math.min(n - 1, Math.ceil(((frameRate * 60) / MIN_BPM) * 4) + 2);
  const acf = autocorrelation(env, maxLag);
  if (!(acf[0] > 0)) return fallback;

  // Comb score over candidate tempi, with a broad preference for the middle of the range.
  let best = { score: -Infinity, bpm: 120 };
  for (let bpm = MIN_BPM; bpm <= MAX_BPM; bpm += 0.25) {
    const period = (frameRate * 60) / bpm;
    let score = 0, weightSum = 0;
    const weights = [1, 0.6, 0.3, 0.4];
    for (let m = 1; m <= 4; m++) {
      const lag = m * period;
      if (lag > maxLag) break;
      score += weights[m - 1] * interp(acf, lag);
      weightSum += weights[m - 1];
    }
    score /= weightSum;
    const octaves = Math.log2(bpm / 105);
    score *= Math.exp(-0.5 * (octaves / 0.9) ** 2);
    if (score > best.score) best = { score, bpm };
  }

  // Refine a period by folding the whole envelope: only the exact period keeps the pulse sharp.
  const refine = (period) => {
    let top = { peak: -1, period, phase: 0, contrast: 0, half: 0 };
    for (let d = -0.04; d <= 0.04001; d += 0.0005) {
      const p = period * (1 + d);
      const r = fold(env, p);
      if (r.peak > top.peak) top = { ...r, period: p };
    }
    return top;
  };

  let chosen = refine((frameRate * 60) / best.bpm);
  let bpm = (frameRate * 60) / chosen.period;
  // Half/double decisions. `half` = how strong the envelope is half-way between beats (0..1).
  if (bpm > 140) {
    // Probably counting eighth notes if every other "beat" is clearly weaker.
    const slower = refine(chosen.period * 2);
    if (bpm / 2 >= MIN_BPM - 5 && slower.half < 0.6) chosen = slower;
  } else if (bpm < 90 && chosen.half > 0.75 && bpm * 2 <= MAX_BPM) {
    // The off-beats are as strong as the beats: the real beat is twice as fast.
    chosen = refine(chosen.period / 2);
  }
  bpm = (frameRate * 60) / chosen.period;

  const acfAtBeat = clamp(interp(acf, chosen.period) / acf[0], 0, 1);
  const confidence = clamp(0.5 * clamp(chosen.contrast * 1.3, 0, 1) + 0.5 * clamp(acfAtBeat * 2.5, 0, 1), 0, 1);
  return { bpm, periodFrames: chosen.period, phaseFrames: chosen.phase, confidence };
}

// ---------------------------------------------------------------------------------------------
// 3. Beats
// ---------------------------------------------------------------------------------------------

/** Dynamic-programming beat tracker (Ellis 2007): beats near the given period that sit on onsets. */
function trackBeats(env, period, tightness = 300) {
  const n = env.length;
  // Local score: envelope lightly smoothed and scaled to unit standard deviation.
  const local = new Float64Array(n);
  let mean = 0, sq = 0;
  for (let i = 0; i < n; i++) {
    const v = 0.25 * (env[i - 1] || 0) + 0.5 * env[i] + 0.25 * (env[i + 1] || 0);
    local[i] = v; mean += v / n;
  }
  for (let i = 0; i < n; i++) sq += (local[i] - mean) ** 2 / n;
  const sd = Math.sqrt(sq) || 1;
  for (let i = 0; i < n; i++) local[i] /= sd;

  const lo = Math.max(1, Math.round(period / 2)), hi = Math.round(period * 2);
  const cost = new Float64Array(hi - lo + 1);
  for (let k = lo; k <= hi; k++) cost[k - lo] = -tightness * Math.log(k / period) ** 2;
  const score = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    let bestScore = 0, bestPrev = -1;           // 0 = start a new chain here
    for (let k = lo; k <= hi; k++) {
      const p = i - k;
      if (p < 0) break;
      const s = score[p] + cost[k - lo];
      if (s > bestScore) { bestScore = s; bestPrev = p; }
    }
    score[i] = local[i] + bestScore;
    back[i] = bestPrev;
  }
  // Best end point in the last beat and a bit.
  let end = n - 1, top = -Infinity;
  for (let i = Math.max(0, n - Math.round(period * 1.5)); i < n; i++) if (score[i] > top) { top = score[i]; end = i; }
  const beats = [];
  for (let i = end; i >= 0; i = back[i]) beats.push(i);
  return beats.reverse();
}

/** How much onset envelope sits within +/-2 frames of the given beat positions (frames). */
function capture(env, beats) {
  let s = 0;
  for (const b of beats) {
    const c = Math.round(b);
    let m = 0;
    for (let d = -2; d <= 2; d++) if (c + d >= 0 && c + d < env.length && env[c + d] > m) m = env[c + d];
    s += m;
  }
  return s;
}

/** Beat positions in frames: rigid if the tempo holds, tracked otherwise. Returns { beats, rigid }. */
function buildBeats(env, tempo) {
  const n = env.length, period = tempo.periodFrames;
  const rigid = [];
  for (let b = tempo.phaseFrames; b < n; b += period) rigid.push(b);
  if (rigid.length < 4) return { beats: rigid, rigid: true };
  const tracked = trackBeats(env, period);
  if (tracked.length < 4) return { beats: rigid, rigid: true };
  // Compare over the span both cover, per beat.
  const perRigid = capture(env, rigid) / rigid.length;
  const perTracked = capture(env, tracked) / tracked.length;
  if (perRigid >= 0.88 * perTracked) return { beats: rigid, rigid: true };
  // Smooth the tracked beats a little (frame quantisation) and extend to both ends of the song.
  const sm = tracked.map((b, i) => (i > 0 && i < tracked.length - 1 ? 0.25 * tracked[i - 1] + 0.5 * b + 0.25 * tracked[i + 1] : b));
  const firstGap = sm[1] - sm[0], lastGap = sm[sm.length - 1] - sm[sm.length - 2];
  while (sm[0] - firstGap >= 0) sm.unshift(sm[0] - firstGap);
  while (sm[sm.length - 1] + lastGap < n) sm.push(sm[sm.length - 1] + lastGap);
  return { beats: sm, rigid: false };
}

// ---------------------------------------------------------------------------------------------
// 4/5. Onsets per drum, downbeat, transcription
// ---------------------------------------------------------------------------------------------

function amplitude(power) {
  const a = new Float32Array(power.length);
  for (let i = 0; i < power.length; i++) a[i] = Math.sqrt(power[i]);
  return a;
}

/**
 * Peaks of an onset function: local maxima over +/-`radius` frames above `floor`.
 * Returns [{ frame (fractional), strength }].
 */
function pickPeaks(fn, radius, floor) {
  const peaks = [];
  for (let f = 1; f < fn.length - 1; f++) {
    const v = fn[f];
    if (!(v > floor)) continue;
    let isMax = true;
    for (let d = 1; d <= radius && isMax; d++) {
      if ((fn[f - d] || 0) > v || (fn[f + d] || 0) >= v) isMax = false;
    }
    if (!isMax) continue;
    const l = fn[f - 1], r = fn[f + 1], denom = l - 2 * v + r;
    const delta = denom < 0 ? clamp((0.5 * (l - r)) / denom, -0.5, 0.5) : 0;
    peaks.push({ frame: f + delta, strength: v });
  }
  return peaks;
}

/**
 * Onset functions for each drum, from the band powers.
 * A rise is the centred difference of band amplitude; it only counts where the level also jumped by
 * `minLogRise` (natural log of power), which rejects swells and notes that grow out of a sustained sound.
 */
function drumOnsets(feat) {
  const { bands, frames, frameRate } = feat;
  const amp = {};
  for (const name of BAND_NAMES) amp[name] = amplitude(bands[name]);
  const floors = {};
  for (const name of BAND_NAMES) floors[name] = 1e-4 * percentile(subsample(bands[name], 4000), 0.99) + 1e-14;

  const rise = (name, minLogRise) => {
    const a = amp[name], p = bands[name], fl = floors[name];
    const out = new Float32Array(frames);
    for (let f = 2; f < frames - 2; f++) {
      const d = a[f + 1] - a[f - 1];
      if (d <= 0) continue;
      const logRise = Math.log((p[f + 2] + fl) / (p[f - 2] + fl));
      if (logRise >= minLogRise) out[f] = d;
    }
    return out;
  };

  const kickFn = rise('low', 1.0);
  const midFn = rise('mid', 0.7);
  const presFn = rise('pres', 0.7);
  const highFn = rise('high', 0.7);
  const snareFn = new Float32Array(frames);
  // A snare is broadband: the mid and presence bands must rise together (within one frame).
  const midRef = strongLevel(midFn), presRef = strongLevel(presFn);
  if (midRef > 0 && presRef > 0) {
    for (let f = 1; f < frames - 1; f++) {
      const m = Math.max(midFn[f - 1], midFn[f], midFn[f + 1]) / midRef;
      const p = Math.max(presFn[f - 1], presFn[f], presFn[f + 1]) / presRef;
      if (m > 0 && p > 0 && (midFn[f] > 0 || presFn[f] > 0)) snareFn[f] = Math.sqrt(m * p);
    }
  }
  const radius = Math.max(2, Math.round(0.035 * frameRate));
  return { amp, kickFn, snareFn, midFn, highFn, radius };
}

/**
 * Candidate hits per drum before quantisation: { kick, snare, hihat, crash } arrays of
 * { frame, strength, rel } where rel is the strength relative to that drum's typical strong hit.
 */
function findHits(feat, onsets) {
  const { frameRate } = feat;
  const { radius } = onsets;
  const loudPower = new Float32Array(feat.frames);
  for (const name of BAND_NAMES) for (let i = 0; i < loudPower.length; i++) loudPower[i] += feat.bands[name][i];
  const loud = Math.sqrt(percentile(subsample(loudPower, 4000), 0.95));
  const audible = (ref) => ref > 0.01 * loud;       // a lane must be within ~40 dB of the mix's loud level

  // Kick: a low-band attack that also dies away again (a bass note keeps sounding).
  const kickCandidates = pickPeaks(onsets.kickFn, radius, 0).filter((p) => isTransient(feat.bands.low, p.frame, frameRate, true));
  const kickRef = percentile(kickCandidates.map((p) => p.strength), 0.9);
  let kick = kickRef > 0 && audible(kickRef)
    ? kickCandidates.filter((p) => p.strength >= 0.3 * kickRef).map((p) => ({ ...p, rel: p.strength / kickRef })) : [];
  // Snare: the same idea in the mid band (a chord or a sung note keeps sounding).
  const snareCandidates = pickPeaks(onsets.snareFn, radius, 0).filter((p) => isTransient(feat.bands.mid, p.frame, frameRate));
  const snareRef = percentile(snareCandidates.map((p) => p.strength), 0.9);
  let snare = snareRef > 0
    ? snareCandidates.filter((p) => p.strength >= 0.35 * snareRef).map((p) => ({ ...p, rel: p.strength / snareRef })) : [];
  // If most of what passed is weak, the weak ones are probably something else leaking into the band
  // (bass notes, guitar chops): keep only the clearly strong hits.
  const clarity = {};
  for (const [name, list] of [['kick', kick], ['snare', snare]]) {
    const strong = list.filter((p) => p.rel >= 0.6);
    clarity[name] = list.length ? strong.length / list.length : 0;
    if (clarity[name] < 0.5) {
      if (name === 'kick') kick = strong; else snare = strong;
    }
  }

  // Top band: hi-hats and crashes. A snare's noise lands here too, so the hi-hat reference level is
  // taken from the hits that are not on a snare.
  let highMax = 0;
  for (let i = 0; i < onsets.highFn.length; i++) if (onsets.highFn[i] > highMax) highMax = onsets.highFn[i];
  const highAll = highMax > 0 ? pickPeaks(onsets.highFn, radius, 0.02 * highMax) : [];
  const onSnare = (frame) => snare.some((sn) => Math.abs(sn.frame - frame) <= 3);
  const clear = highAll.filter((p) => !onSnare(p.frame));
  const hatRef = percentile((clear.length >= 8 ? clear : highAll).map((p) => p.strength), 0.9);
  const hihat = [], crash = [];
  if (hatRef > 0 && audible(hatRef)) {
    for (const p of highAll) {
      if (p.strength < 0.25 * hatRef) continue;
      const hit = { ...p, rel: p.strength / hatRef };
      if (p.strength >= 0.8 * hatRef && isCrash(onsets.amp.high, p.frame, frameRate)) crash.push(hit);
      else if (!onSnare(p.frame)) hihat.push(hit);
    }
  }
  // A crash also rises in the mid and presence bands and can pass for a snare. A real snare has far
  // more mid-band than top-band energy compared with a cymbal, so compare each suspect with the
  // balance of the snares that are not on a crash.
  const onCrash = (frame) => crash.some((c) => Math.abs(c.frame - frame) <= 3);
  const balance = (frame) => near(onsets.midFn, frame, 2) / (near(onsets.highFn, frame, 2) + 1e-12);
  const plain = snare.filter((sn) => !onCrash(sn.frame)).map((sn) => balance(sn.frame));
  if (plain.length >= 2) {
    const usual = median(plain);
    snare = snare.filter((sn) => !onCrash(sn.frame) || balance(sn.frame) >= 0.5 * usual);
  }
  return { kick, snare, hihat, crash, clarity };
}

function subsample(arr, maxCount) {
  if (arr.length <= maxCount) return arr;
  const step = Math.ceil(arr.length / maxCount), out = [];
  for (let i = 0; i < arr.length; i += step) out.push(arr[i]);
  return out;
}

/** The level of a typical strong hit: 90th percentile of the non-trivial local peaks. */
function strongLevel(fn) {
  let max = 0;
  for (let i = 0; i < fn.length; i++) if (fn[i] > max) max = fn[i];
  if (!(max > 0)) return 0;
  const peaks = pickPeaks(fn, 2, max * 0.02).map((p) => p.strength);
  return peaks.length ? percentile(peaks, 0.9) : 0;
}

/** Slot grid: 4 slots per beat between consecutive beats. Returns Float64Array of slot frames. */
function slotGrid(beats, divisions = 4) {
  const slots = new Float64Array((beats.length - 1) * divisions + 1);
  for (let b = 0; b + 1 < beats.length; b++) {
    for (let d = 0; d < divisions; d++) slots[b * divisions + d] = beats[b] + ((beats[b + 1] - beats[b]) * d) / divisions;
  }
  slots[slots.length - 1] = beats[beats.length - 1];
  return slots;
}

function nearestSlot(slots, frame) {
  let lo = 0, hi = slots.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (slots[mid] <= frame) lo = mid; else hi = mid;
  }
  const idx = Math.abs(slots[lo] - frame) <= Math.abs(slots[hi] - frame) ? lo : hi;
  const width = idx + 1 < slots.length ? slots[idx + 1] - slots[idx] : slots[idx] - slots[idx - 1];
  return { idx, error: Math.abs(slots[idx] - frame) / Math.max(1e-9, width) };
}

/** Largest value of fn within +/-radius frames of `frame`. */
function near(fn, frame, radius) {
  const c = Math.round(frame);
  let m = 0;
  for (let d = -radius; d <= radius; d++) if (c + d >= 0 && c + d < fn.length && fn[c + d] > m) m = fn[c + d];
  return m;
}

/**
 * Which beat of the bar is "1": kick on 1 (and 3), snare on 2 and 4, crash on 1.
 * Ties (a plain rock beat cannot tell 1 from 3) go to the phase of the first strong beat.
 */
function guessDownbeat(beats, onsets, crashFrames, beatsPerBar = 4) {
  if (beats.length < beatsPerBar * 2) return 0;
  const kickRef = strongLevel(onsets.kickFn) || 1;
  const kick = beats.map((b) => Math.min(1.5, near(onsets.kickFn, b, 2) / kickRef));
  const snare = beats.map((b) => Math.min(1.5, near(onsets.snareFn, b, 2)));
  const crash = beats.map((b) => (crashFrames.some((c) => Math.abs(c - b) <= 3) ? 1 : 0));
  const scores = new Array(beatsPerBar).fill(0);
  for (let k = 0; k < beatsPerBar; k++) {
    let s = 0, bars = 0;
    for (let i = k; i + 3 < beats.length; i += beatsPerBar) {
      s += kick[i] + 0.5 * kick[i + 2] + 0.75 * (snare[i + 1] + snare[i + 3]) - 0.75 * (snare[i] + snare[i + 2]) + 2 * crash[i];
      bars++;
    }
    scores[k] = bars ? s / bars : -Infinity;
  }
  const best = Math.max(...scores);
  const firstStrong = beats.findIndex((_, i) => kick[i] > 0.4 || snare[i] > 0.4 || crash[i]);
  const preferred = firstStrong >= 0 ? firstStrong % beatsPerBar : 0;
  const span = Math.max(1e-9, best - Math.min(...scores.filter(Number.isFinite)));
  if (best - scores[preferred] <= 0.08 * span + 1e-9) return preferred;
  return scores.indexOf(best);
}

/**
 * Is the attack at `frame` a short hit rather than the start of a sustained note? Looks at the
 * band power added on top of what was already sounding (median of the 70 ms before): 80-160 ms
 * later at least three quarters of that added power must be gone again (-6 dB).
 */
function isTransient(power, frame, frameRate, alsoAbsolute = false) {
  const f = Math.round(frame);
  let peak = 0;
  for (let d = 0; d <= 4; d++) if (f + d < power.length && power[f + d] > peak) peak = power[f + d];
  const pre = [];
  for (let i = Math.max(0, f - 3 - Math.round(0.07 * frameRate)); i <= f - 3; i++) pre.push(power[i]);
  const before = pre.length ? median(pre) : 0;
  const from = f + Math.round(0.08 * frameRate), to = Math.min(power.length - 1, f + Math.round(0.16 * frameRate));
  if (from > to) return true;
  let later = Infinity;
  for (let i = from; i <= to; i++) if (power[i] < later) later = power[i];
  if (!(later - before < 0.25 * (peak - before))) return false;
  // Stricter form for the low band, where the only sustained thing is the bass: the level itself
  // (not just the added part) must drop 6 dB. A re-plucked bass note fails this, a kick passes.
  return !alsoAbsolute || later < 0.25 * peak;
}

/** Is the high-band hit at `frame` still ringing 150-350 ms later (a crash rather than a hi-hat)? */
function isCrash(highAmp, frame, frameRate) {
  const f = Math.round(frame);
  let peak = 0;
  for (let d = 0; d <= 4; d++) if (f + d < highAmp.length && highAmp[f + d] > peak) peak = highAmp[f + d];
  const from = f + Math.round(0.15 * frameRate), to = f + Math.round(0.35 * frameRate);
  if (to >= highAmp.length || !(peak > 0)) return false;
  let sustain = Infinity;
  for (let i = from; i <= to; i++) if (highAmp[i] < sustain) sustain = highAmp[i];
  const pre = [];
  for (let i = Math.max(0, f - Math.round(0.3 * frameRate)); i < f - 3; i++) pre.push(highAmp[i]);
  const before = pre.length ? median(pre) : 0;
  return sustain > 0.25 * peak && sustain > 3 * before;
}

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

async function tempoAndBeats(feat) {
  const tempo = estimateTempo(feat.env, feat.frameRate);
  await yieldToUi();
  const { beats, rigid } = buildBeats(feat.env, tempo);
  await yieldToUi();
  const onsets = drumOnsets(feat);
  const hits = findHits(feat, onsets);
  const downbeat = guessDownbeat(beats, onsets, hits.crash.map((p) => p.frame));
  return { tempo, beats, rigid, onsets, hits, downbeat };
}

/** First downbeat moved back by whole bars to the earliest one at or after time 0. */
function offsetOf(beats, downbeat, frameRate, bpm, beatsPerBar = 4) {
  if (!beats.length) return 0;
  const first = beats[Math.min(downbeat, beats.length - 1)] / frameRate;
  const bar = (60 / bpm) * beatsPerBar;
  let t = first;
  while (t - bar >= -1e-6) t -= bar;
  return Math.max(0, t);
}

export async function detectTempo({ channelData, sampleRate }, { onProgress } = {}) {
  if (!channelData || !channelData.length || !(sampleRate > 0)) return { bpm: 120, offsetSec: 0, beats: [], confidence: 0 };
  const feat = await computeFeatures(channelData, sampleRate, onProgress ? (p) => onProgress(p * 0.9) : null);
  const r = await tempoAndBeats(feat);
  if (onProgress) onProgress(1);
  return {
    bpm: Math.round(r.tempo.bpm * 100) / 100,
    offsetSec: offsetOf(r.beats, r.downbeat, feat.frameRate, r.tempo.bpm),
    beats: r.beats.map((b) => b / feat.frameRate),
    confidence: r.tempo.confidence,
    steadyTempo: r.rigid,
  };
}

export async function analyzeAudio({ channelData, sampleRate }, { onProgress } = {}) {
  const empty = { bpm: 120, offsetSec: 0, beatsPerBar: 4, beats: [], notes: [], confidence: 0 };
  if (!channelData || !channelData.length || !(sampleRate > 0)) return empty;
  const feat = await computeFeatures(channelData, sampleRate, onProgress ? (p) => onProgress(p * 0.85) : null);
  const r = await tempoAndBeats(feat);
  if (onProgress) onProgress(0.92);
  await yieldToUi();
  const { frameRate } = feat;
  const beatsPerBar = 4;
  const bpm = r.tempo.bpm;
  const beatsSec = r.beats.map((b) => b / frameRate);
  const offsetSec = offsetOf(r.beats, r.downbeat, frameRate, bpm, beatsPerBar);
  if (r.beats.length < 2) return { ...empty, bpm: Math.round(bpm * 100) / 100, offsetSec, beats: beatsSec, confidence: 0 };

  // Extend the grid one beat before the first beat so early notes have slots.
  const beats = r.beats.slice();
  const lead = beats[1] - beats[0];
  let shift = 0;
  while (beats[0] - lead >= -lead * 0.5) { beats.unshift(beats[0] - lead); shift++; }
  const slots = slotGrid(beats, 4);

  const lanes = { kick: r.hits.kick, snare: r.hits.snare, hihat: r.hits.hihat, crash: r.hits.crash };

  // Quantise to the 16th grid. Hits far from any slot, and weak hits on the odd 16ths, are dropped.
  const grid = {};          // lane -> Map(slotIdx -> rel)
  let errorSum = 0, errorCount = 0;
  for (const lane of Object.keys(lanes)) {
    grid[lane] = new Map();
    for (const p of lanes[lane]) {
      const { idx, error } = nearestSlot(slots, p.frame);
      errorSum += Math.min(error, 0.5); errorCount++;
      if (error > 0.4) continue;
      if (idx % 2 === 1 && p.rel < 0.5) continue;
      if (!grid[lane].has(idx) || grid[lane].get(idx) < p.rel) grid[lane].set(idx, p.rel);
    }
  }
  // A snare's noise also lights up the top band, so no hi-hat is reported on a snare or a crash...
  for (const idx of Array.from(grid.hihat.keys())) {
    if (grid.crash.has(idx) || grid.snare.has(idx)) grid.hihat.delete(idx);
  }
  // ...but if the hi-hat is clearly running on both sides, it is almost certainly played there too.
  for (const idx of Array.from(grid.snare.keys())) {
    if (grid.hihat.has(idx) || grid.crash.has(idx)) continue;
    const eighths = grid.hihat.has(idx - 2) && grid.hihat.has(idx + 2);
    const sixteenths = grid.hihat.has(idx - 1) && grid.hihat.has(idx + 1);
    if (eighths || sixteenths) grid.hihat.set(idx, 0.6);
  }
  // A lane with only a handful of hits in a whole song is more likely noise than drums.
  const bars = Math.max(1, (beats.length - 1) / beatsPerBar);
  for (const lane of ['kick', 'snare', 'hihat']) if (grid[lane].size < Math.min(4, bars)) grid[lane].clear();

  const notes = [];
  const duration = feat.durationSec;
  for (const lane of Object.keys(grid)) {
    for (const [idx, rel] of grid[lane]) {
      const t = slots[idx] / frameRate;
      if (t < 0 || t > duration) continue;
      notes.push({ t: Math.round(t * 10000) / 10000, lane, vel: Math.round(clamp(0.35 + 0.65 * Math.min(1, rel), 0, 1) * 100) / 100 });
    }
  }
  notes.sort((a, b) => a.t - b.t || a.lane.localeCompare(b.lane));

  // Confidence: tempo confidence, how well the hits sit on the grid, and how clearly the kick and
  // snare stood out from everything else in their bands (0 for a drum we could not find at all).
  const gridFit = errorCount ? clamp(1 - errorSum / errorCount / 0.25, 0, 1) : 0;
  // A normal beat has at least one kick and one snare per bar; fewer means we are missing them.
  const presence = (name) => clamp(grid[name].size / bars, 0, 1) * clamp(r.hits.clarity[name] * 1.25, 0, 1);
  const kit = 0.5 * presence('kick') + 0.5 * presence('snare');
  const confidence = clamp(r.tempo.confidence * (0.4 + 0.6 * gridFit) * (0.15 + 0.85 * kit), 0, 1);
  if (onProgress) onProgress(1);
  return {
    bpm: Math.round(bpm * 100) / 100,
    offsetSec,
    beatsPerBar,
    beats: beatsSec,
    notes,
    confidence: Math.round(confidence * 100) / 100,
    steadyTempo: r.rigid,
  };
}

// midi.js - Standard MIDI File (format 0 and 1) drum import -> Chart. Pure, no DOM, no dependencies.

import { LANES, uuid } from './charts.js';

/** General MIDI percussion note -> lane. Everything else is ignored. */
export const GM_DRUM_MAP = {
  35: 'kick', 36: 'kick',
  37: 'snare', 38: 'snare', 40: 'snare',
  42: 'hihat', 44: 'hihat', 46: 'hihat',
  48: 'tom1', 50: 'tom1',
  45: 'tom2', 47: 'tom2',
  41: 'floor', 43: 'floor',
  49: 'crash', 52: 'crash', 55: 'crash', 57: 'crash',
  51: 'ride', 53: 'ride', 59: 'ride',
};

const LANE_INDEX = new Map(LANES.map((l, i) => [l, i]));
const round6 = (x) => Math.round(x * 1e6) / 1e6;

class Truncated extends Error {}

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer || Object.prototype.toString.call(input) === '[object ArrayBuffer]') {
    return new Uint8Array(input);
  }
  throw new Error('Expected the contents of a MIDI file (an ArrayBuffer).');
}

function ascii(u8, p, n) {
  let s = '';
  for (let i = 0; i < n && p + i < u8.length; i++) s += String.fromCharCode(u8[p + i]);
  return s;
}

const u16 = (u8, p) => (u8[p] << 8) | u8[p + 1];
const u32 = (u8, p) => ((u8[p] << 24) | (u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3]) >>> 0;

/**
 * Parse one MTrk body. Pushes into `out`:
 *  out.notes   [{tick, ch, note, vel}]  (note-ons with vel > 0)
 *  out.tempos  [{tick, uspq}]
 *  out.sigs    [{tick, num, den}]
 *  out.names   [string]
 *  out.maxTick (end of track / last event)
 */
function parseTrack(u8, start, end, out) {
  let pos = start;
  let tick = 0;
  let status = 0;
  const readByte = () => {
    if (pos >= end) throw new Truncated();
    return u8[pos++];
  };
  const readVLQ = () => {
    let v = 0;
    for (let i = 0; i < 4; i++) {
      const b = readByte();
      v = (v << 7) | (b & 0x7f);
      if (!(b & 0x80)) return v >>> 0;
    }
    throw new Error('Corrupt MIDI file: variable-length number is longer than 4 bytes.');
  };
  try {
    while (pos < end) {
      tick += readVLQ();
      let b = readByte();
      if (b === 0xff) {
        const type = readByte();
        const len = readVLQ();
        if (pos + len > end) throw new Truncated();
        const dp = pos;
        pos += len;
        status = 0; // meta events cancel running status
        if (type === 0x2f) {
          out.maxTick = Math.max(out.maxTick, tick);
          return;
        }
        if (type === 0x51 && len === 3) {
          out.tempos.push({ tick, uspq: (u8[dp] << 16) | (u8[dp + 1] << 8) | u8[dp + 2] });
        } else if (type === 0x58 && len >= 2) {
          out.sigs.push({ tick, num: u8[dp], den: 1 << u8[dp + 1] });
        } else if (type === 0x03) {
          out.names.push(ascii(u8, dp, len).replace(/\0/g, '').trim());
        }
        continue;
      }
      if (b === 0xf0 || b === 0xf7) {
        const len = readVLQ();
        if (pos + len > end) throw new Truncated();
        pos += len;
        status = 0;
        continue;
      }
      if (b >= 0xf1) throw new Error(`Corrupt MIDI file: unexpected status byte 0x${b.toString(16)}.`);
      let data1;
      if (b & 0x80) {
        status = b;
        data1 = readByte();
      } else {
        if (!status) throw new Error('Corrupt MIDI file: data byte with no running status.');
        data1 = b;
      }
      const kind = status >> 4;
      const data2 = kind === 0xc || kind === 0xd ? 0 : readByte();
      if (kind === 0x9 && data2 > 0) out.notes.push({ tick, ch: status & 0x0f, note: data1, vel: data2 });
      out.maxTick = Math.max(out.maxTick, tick);
    }
  } catch (e) {
    if (!(e instanceof Truncated)) throw e; // truncated track: keep what we have
  }
  out.maxTick = Math.max(out.maxTick, tick);
}

/** Parse an SMF (ArrayBuffer / typed array) and return a drum Chart (source 'midi'). Throws Error with a UI-friendly message. */
export function parseMidiToChart(arrayBuffer, { title } = {}) {
  const u8 = toBytes(arrayBuffer);
  let p = 0;
  if (ascii(u8, 0, 4) !== 'MThd') {
    // RIFF/RMID wrapper: look for the header nearby.
    let found = -1;
    if (ascii(u8, 0, 4) === 'RIFF') {
      for (let i = 4; i < Math.min(64, u8.length - 4); i++) if (ascii(u8, i, 4) === 'MThd') { found = i; break; }
    }
    if (found < 0) throw new Error('This does not look like a MIDI file (missing MThd header).');
    p = found;
  }
  if (u8.length < p + 14) throw new Error('This MIDI file is too short to be valid.');
  const hdrLen = u32(u8, p + 4);
  const format = u16(u8, p + 8);
  const division = u16(u8, p + 12);
  if (division & 0x8000) {
    throw new Error('This MIDI file uses SMPTE time division, which is not supported. Please export it with ticks per beat (PPQ) timing.');
  }
  if (division === 0) throw new Error('Corrupt MIDI file: ticks per beat is zero.');
  if (format > 1) throw new Error(`MIDI format ${format} is not supported. Please save it as a type 0 or type 1 MIDI file.`);
  const ppq = division;

  const out = { notes: [], tempos: [], sigs: [], names: [], maxTick: 0 };
  p += 8 + Math.max(6, hdrLen);
  while (p + 8 <= u8.length) {
    const id = ascii(u8, p, 4);
    const len = u32(u8, p + 4);
    const bodyStart = p + 8;
    const bodyEnd = Math.min(bodyStart + len, u8.length);
    if (id === 'MTrk') parseTrack(u8, bodyStart, bodyEnd, out);
    p = bodyStart + len;
  }

  // Tempo map: segments of constant tempo with cumulative seconds.
  const tempos = out.tempos.map((t, i) => ({ ...t, i })).sort((a, b) => a.tick - b.tick || a.i - b.i);
  const segs = [{ tick: 0, sec: 0, uspq: 500000 }];
  for (const t of tempos) {
    if (t.uspq <= 0) continue;
    if (t.tick === 0) { segs[0].uspq = t.uspq; continue; }
    const last = segs[segs.length - 1];
    segs.push({ tick: t.tick, sec: last.sec + ((t.tick - last.tick) * last.uspq) / (ppq * 1e6), uspq: t.uspq });
  }
  const tickToSec = (tick) => {
    let lo = 0;
    let hi = segs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (segs[mid].tick <= tick) lo = mid; else hi = mid - 1;
    }
    const s = segs[lo];
    return s.sec + ((tick - s.tick) * s.uspq) / (ppq * 1e6);
  };

  // Channel selection: channel 10 (index 9) if it has any notes, else every channel.
  const hasCh10 = out.notes.some((n) => n.ch === 9);
  const chosen = hasCh10 ? out.notes.filter((n) => n.ch === 9) : out.notes;

  const best = new Map();
  for (const n of chosen) {
    const lane = GM_DRUM_MAP[n.note];
    if (!lane) continue;
    const t = round6(tickToSec(n.tick));
    const vel = n.vel / 127;
    const key = `${lane}@${Math.round(t * 1000)}`;
    const prev = best.get(key);
    if (!prev || vel > prev.vel) best.set(key, { t, lane, vel: round6(vel) });
  }
  const notes = [...best.values()].sort((a, b) => a.t - b.t || LANE_INDEX.get(a.lane) - LANE_INDEX.get(b.lane));
  if (!notes.length) {
    throw new Error('No drum notes found in this MIDI file. Drums should be on channel 10 using General MIDI drum notes.');
  }

  const sig = out.sigs.slice().sort((a, b) => a.tick - b.tick)[0];
  const lastT = notes[notes.length - 1].t;
  const name = out.names.find((s) => s);
  return {
    id: uuid(),
    title: title || name || 'MIDI drums',
    source: 'midi',
    bpm: Math.round((6e7 / segs[0].uspq) * 100) / 100,
    beatsPerBar: sig && sig.num >= 1 ? sig.num : 4,
    offsetSec: 0,
    durationSec: round6(Math.max(tickToSec(out.maxTick), lastT)),
    audioId: null,
    notes,
    meta: {
      notes: `Imported from MIDI (${hasCh10 ? 'channel 10' : 'all channels, no channel 10 data'}, ${segs.length > 1 ? 'tempo changes honoured' : 'constant tempo'})`,
    },
  };
}

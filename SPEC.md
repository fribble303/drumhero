# Drum Hero — build spec (shared contract for all agents)

A Guitar-Hero-style drum trainer for a child who "knows basic beats". Runs on a **phone in landscape**,
in a mobile browser (iOS Safari and Android Chrome). It **listens through the microphone** (no MIDI/USB
connection to the kit), shows what to play on a horizontal note highway, and scores hits by timing.
The parent can add songs from: full-song audio files, audio + a chosen groove, MIDI drum files, and
photos of sheet music.

## Hard constraints

- Plain static site. **No build step, no npm dependencies, no CDN.** Vanilla ES modules, one `index.html`.
- All paths relative (`./js/x.js`). Must work served from any static host AND as a multi-file page.
- Everything runs client-side. Storage: IndexedDB (songs, audio blobs, calibration), wrapped in try/catch;
  the app must still run with storage unavailable (in-memory fallback).
- Phone landscape first (approx 667x375 up to 932x430 CSS px). Big touch targets (>=44px). Also usable on a laptop.
- If the phone is held portrait, show a "rotate your phone" overlay.
- Each module has ONE owner. Do not edit files you do not own. Code against the interfaces below exactly.
- Each module must be importable in Node 20+ for tests where it does not need the DOM (guard `window`/`navigator` use).
- Put tests in `tests/<module>.test.mjs`, runnable with `node --test tests/`.

## Lanes

Fixed order, top of screen to bottom (like notation: cymbals high, kick low):

```js
export const LANES = ['crash', 'ride', 'hihat', 'tom1', 'snare', 'tom2', 'floor', 'kick'];
```

Difficulty levels reduce what is shown:
- Level 1 "Starter": kick, snare, hihat only; hihat thinned to quarter notes; no fills.
- Level 2 "Groove": kick, snare, hihat (as written), crash; toms mapped to snare.
- Level 3 "Full": everything as written.

## Chart format (`Chart`)

```js
{
  id: string,                // uuid
  title: string,
  source: 'builtin' | 'pattern' | 'midi' | 'audio' | 'sheet',
  bpm: number,               // nominal tempo
  beatsPerBar: number,       // usually 4
  offsetSec: number,         // time of beat 1 of bar 1 within the audio (0 if no audio)
  durationSec: number,
  audioId: string | null,    // key of backing audio blob in the store, or null (metronome only)
  notes: [{ t: number, lane: Lane, vel: number }],  // t in seconds from audio start, sorted ascending, vel 0..1
  meta: { confidence?: number, notes?: string }
}
```

## Module: `js/charts.js` (owner: CHARTS agent) — pure, no DOM

```js
export const LANES;
export const PATTERNS;            // [{ id, name, level, beatsPerBar, steps: {lane: number[] (16th-step indices per bar)} }]
                                  // at least: quarter-note rock, 8th-note rock, four-on-the-floor, half-time,
                                  // 16th hi-hat rock, shuffle (triplet grid allowed via `grid: 12`), simple fills
export function buildPatternChart({ title, bpm, offsetSec = 0, durationSec, patternId, fillEveryBars = 0, audioId = null }): Chart
export function simplifyChart(chart, level /* 1|2|3 */): Chart     // returns a new chart, never mutates
export function quantizeChart(chart, division = 16): Chart          // snap notes to grid from bpm/offsetSec
export function validateChart(chart): { ok: boolean, errors: string[] }
export const BUILTIN_LESSONS;     // 8-10 ready Charts (no audio, metronome), ordered easy to hard, 60-100 bpm,
                                  // each ~16 bars, titles a kid would like
export function uuid(): string
```

## Module: `js/midi.js` (owner: CHARTS agent) — pure

```js
export function parseMidiToChart(arrayBuffer, { title } = {}): Chart
```
Standard MIDI File format 0 and 1, tempo map honoured (note times in real seconds), General MIDI drum map
on channel 10 (fall back to: any channel if ch10 empty). Map GM notes: 35/36 kick; 37/38/40 snare;
42/44/46 hihat; 48/50 tom1; 45/47 tom2; 41/43 floor; 49/52/55/57 crash; 51/53/59 ride. Ignore the rest.
`bpm` = first tempo; `source: 'midi'`.

## Module: `js/sheet.js` (owner: CHARTS agent)

```js
export async function isSheetReadingAvailable(): Promise<boolean>
export async function sheetPhotosToChart(blobs /* Blob[] images */, { title, bpm = 80, onProgress } = {}): Promise<Chart>
```
Uses the host page's AI helper when present: `const sample = await window.claude?.use?.('sample')`
(may be `null`/undefined -> not available). Call `sample.json(prompt, { images: blobs, modelTier: 'complex' })`
only if `(await sample.limits()).images` is truthy. The prompt asks for strict JSON: `{ bpm?, beatsPerBar,
bars: [ { notes: [ { beat: number /* 1-based, fractional */, lane } ] } ] }` reading standard drum notation
(kick bottom space, snare 3rd space, hi-hat x above staff, etc.), then convert to a Chart with `source: 'sheet'`.
Validate and repair the response (drop unknown lanes, clamp beats). Must reject with a clear Error message the UI
can show when unavailable or when the photo is unreadable. Never throw on missing `window`.

## Module: `js/listen.js` (owner: DSP agent) — live microphone hit detection

```js
export function createListener(audioContext): Listener

Listener = {
  async start(),                 // getUserMedia({audio:{echoCancellation:false, noiseSuppression:false, autoGainControl:false}})
                                 // + AudioWorklet (inline via Blob URL) with ScriptProcessor fallback. Rejects with Error on denial.
  stop(),
  isRunning(): boolean,
  onHit(cb): unsubscribe,        // cb({ time, lane, confidence, strength })
                                 //   time: audioContext.currentTime-domain time the stick hit happened,
                                 //         already corrected by latencySec; lane: Lane | null (null = unclassified)
  onLevel(cb): unsubscribe,      // cb(rms 0..1) ~20x/sec for a level meter
  setSensitivity(x /* 0..1 */),
  setLatencySec(sec), getLatencySec(),

  // Calibration 1: latency
  async measureLatencyLoopback(): Promise<{ latencySec, ok }>,   // plays clicks out of the speaker, hears them on the mic
  // (tap-along latency calibration is done by the UI using onHit + a metronome; UI calls setLatencySec)

  // Calibration 2: teach the kit. UI asks the child to hit one drum N times.
  startTraining(lane),           // subsequent hits are collected as examples for `lane` (and not classified)
  stopTraining(): { lane, count },
  clearTraining(lane?),
  trainedLanes(): Lane[],
  getProfile(): object,          // JSON-serialisable: latency, sensitivity, per-lane feature templates, noise floor
  setProfile(obj),

  // Test hook (no mic): push raw mono Float32 samples at the context sample rate
  feed(float32Array, startTimeSec)
}
```
Design notes for the DSP agent:
- Onset detection must be low-latency and robust: spectral-flux / high-frequency-content on short hops
  (~5 ms), adaptive threshold, ~40 ms refractory per band but allow simultaneous kick+hihat (multi-label: a single
  onset may emit up to 2-3 hits with different lanes at the same `time`).
- Classification: nearest-template on a compact spectral feature (log band energies over the first ~40 ms +
  decay/centroid), templates learned from training. If fewer than 2 lanes are trained, emit `lane: null`
  ("timing-only mode") — the game then matches any hit to the nearest expected note.
- The kit is ELECTRONIC and heard through the air: either its amp/speaker (real drum sounds) or just the
  rubber pad thwacks (when the child wears headphones). Training must work for both; pad thwacks are
  quieter and more alike, so report low confidence honestly rather than guessing.
- The backing track may also be playing from the phone speaker. Provide `setReferenceGate(fn)` optional:
  `fn(time) -> boolean` lets the game tell the listener when a loud backing-track drum hit is expected so it can
  raise thresholds; simple is fine. Document what you did.

## Module: `js/analyze.js` (owner: DSP agent) — offline audio file analysis, pure (works on Float32 data)

```js
export async function analyzeAudio({ channelData /* Float32Array mono */, sampleRate }, { onProgress } = {}):
  Promise<{ bpm, offsetSec, beatsPerBar, beats: number[], notes: [{t, lane, vel}], confidence: number }>
export async function detectTempo({ channelData, sampleRate }): Promise<{ bpm, offsetSec, beats: number[], confidence }>
```
- `detectTempo`: onset envelope + autocorrelation/comb tempo estimate (60-180 bpm, resolve octave errors toward
  70-140), beat phase, downbeat guess. Used for "song + pick a beat".
- `analyzeAudio`: approximate drum transcription of a full mix: band-split onsets (low <120 Hz = kick,
  mid ~150-2500 Hz snare-like with broadband noise, high >6 kHz = hihat/cymbal; long high decay = crash),
  quantised to the detected 16th grid. Only output lanes kick/snare/hihat/crash. Be conservative: fewer, right
  notes beat many wrong ones. `confidence` 0..1.
- Must not block the UI for long: yield (`await`) every ~200 ms of work and call `onProgress(0..1)`.
- Tests: synthesise a drum loop (sine-burst kick, noise-burst snare, high-passed noise hats) at a known bpm, with
  and without a bass/pad bed, and assert tempo within 2% and note recall/precision.

## Module: `js/store.js`, `js/game.js`, `js/app.js`, `index.html`, `css/app.css` (owner: UI agent)

`store.js`: IndexedDB wrapper — `listSongs()`, `saveSong(chart)`, `deleteSong(id)`, `saveAudio(id, blob)`,
`getAudio(id)`, `getProfile()`, `saveProfile(obj)`, `getScores(songId)`, `saveScore(songId, score)`.

`game.js`: the highway + scoring engine, canvas based.
- Horizontal highway: lanes stacked top to bottom in `LANES` order (only lanes used at the chosen level are
  drawn, so Level 1 has 3 fat lanes). Notes travel **right to left** toward a vertical hit line near the left.
  Each lane has its own colour and a drum icon/label at the hit line. Bar and beat lines scroll with the notes.
- Clock = `audioContext.currentTime`. Backing audio via AudioBufferSourceNode; metronome clicks scheduled
  ahead on the audio clock when there is no audio (and optionally on top). Count-in of one bar.
- Speed control: 50% / 75% / 100% (for audio use `playbackRate`; chart times scale accordingly).
- Hit matching: for each listener hit, find the nearest unmatched note within the window — same lane when
  `hit.lane` is set and that lane is in play; any lane when `hit.lane` is null (timing-only mode).
  Windows: Perfect <=45 ms, Good <=90 ms, OK <=140 ms; otherwise a stray hit (no penalty at Level 1).
  Points 100/70/40 x combo multiplier (x2 at 10, x3 at 25, x4 at 50). Missed notes break the combo.
- Feedback: lane flash, "Perfect/Good/OK/Miss" pop text, early/late indicator, combo counter, star rating
  (1-5) and accuracy % at the end, best score saved.
- Also accept input from on-screen lane taps and keyboard (for testing without drums): keys
  `a s d f j k l ;` map to LANES order.
- Loop a section / "practice mode" (no fail, slower) is a nice-to-have, after everything else works.

`app.js` + `index.html`: screens
1. Home: song library (built-in lessons first, then the parent's songs), level picker, speed picker, Play.
2. Add song (parent): four clear choices —
   a. **Audio, work out the drums** -> decode with `audioContext.decodeAudioData`, mix to mono, `analyzeAudio`,
      show progress and the resulting confidence; save chart + audio.
   b. **Audio + pick a beat** -> `detectTempo`, show bpm (editable, with tap-tempo and x2 / /2 buttons) and a
      pattern picker from `PATTERNS`, `buildPatternChart`; save chart + audio.
   c. **MIDI file** -> `parseMidiToChart`; optional backing audio file.
   d. **Photo of sheet music** -> `<input type=file accept="image/*" capture>` (multiple), `sheetPhotosToChart`;
      if `isSheetReadingAvailable()` is false, show the option disabled with a short explanation.
   After any import: a preview/edit step — title, bpm, offset nudge (+/- 10 ms), level preview, Save.
3. Calibrate: (i) mic permission + live level meter; (ii) latency — try `measureLatencyLoopback()`, else
   tap-along to 8 clicks; (iii) "teach me your kit": for each lane in the chosen level, "Hit the SNARE 6 times"
   with big counter using `startTraining/stopTraining`; skip allowed; (iv) quick test — hit anything and see
   which lane lights up. Save profile via store; reload it on start (`listener.setProfile`).
4. Play: the game. 5. Results: stars, accuracy, per-lane breakdown, early/late tendency, Retry / Home.

Look and feel: bold, bright, kid-friendly (age ~8-11), dark stage background, chunky rounded shapes, no
copyrighted characters or brand look-alikes. Name on screen: "Drum Hero".
AudioContext must be created/resumed from a user gesture (iOS). Request a screen wake lock while playing
(feature-detected). Never block first paint on mic permission.

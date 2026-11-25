# Drum Hero

Guitar-Hero-style drum trainer for a phone in landscape. It listens through the microphone, shows what to play, and scores timing.

- `index.html` — the app as a plain static site (serve the folder over HTTPS; the mic needs HTTPS or localhost).
- `drum-hero-page.html` — the same page in the shape the Claude artifact publisher expects (generated from index.html + css/app.css).
- `js/` — app.js (screens), game.js (highway + scoring), store.js (IndexedDB), listen.js (mic hit detection + calibration), analyze.js (tempo + drum transcription), charts.js (grooves + lessons), midi.js, sheet.js (sheet-music photos via Claude).
- `SPEC.md` — module contracts. Tests: `node --test` (89 tests).

Local run: `python3 -m http.server 8000` then open http://localhost:8000

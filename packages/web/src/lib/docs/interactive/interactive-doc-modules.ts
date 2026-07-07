// packages/web/src/lib/docs/interactive/interactive-doc-modules.ts
//
// Allowlist of module types whose /docs/modules/[id] page renders the live
// INTERACTIVE virtual module (real card + hover pane) as the PRIMARY view. Every
// other module keeps the static numbered-face view (the live card is the
// redesign; the face is now the no-JS / not-yet-promoted fallback).
//
// This is the prototype gate: only modules proven on a live card belong here, so
// a card that misbehaves under the doc sandbox can't break its doc page — it
// falls back to the static face. Grow it as modules are verified (mirrors the
// STRICT_DOCS ratchet, but a SEPARATE axis: a module can be STRICT-documented
// yet not yet vetted on the live doc card).

export const INTERACTIVE_DOC_MODULES: ReadonlySet<string> = new Set<string>([
  // Prototype wave (2026-06-25): the CV/control overlap demo + a Y.Doc-backed
  // step grid.
  'adsr',
  'sequencer',
  // Batch 1 — foundational modules (2026-06-25): each verified to mount cleanly
  // as a live virtual module on its doc page (e2e/tests/docs-virtual-module.spec.ts)
  // — the live card renders with no console/page errors and a control hover
  // updates the pane.
  'analogVco',
  'vca',
  'mixer',
  'noise',
  'filter',
  'lfo',
  // NOTE — cofefve (COFEFVE DELAY, the own-code replacement for the retired
  // Cocoa Delay module) is documented (STRICT_DOCS) but intentionally NOT here. Its
  // card IS a convention card (CofefveCard, pure Knob/Fader/select + PatchPanel)
  // so the doc route COULD mount it live, but for parity with the module it
  // replaced (which stayed static) it is kept off this allowlist and uses the
  // static doc face. Promoting it to the live virtual-module doc view is a
  // straightforward follow-up (add it here + a PROBES row in
  // docs-virtual-module.spec.ts).
  // Batch 2 (2026-06-25): macrooscillator's card is a pure PatchPanel + six
  // Faders + a derived label — no onMount/effect, no canvas/rAF, no Web MIDI or
  // file input — so it mounts cleanly in the doc sandbox. The other batch-2
  // voices stay STATIC: their cards run rAF/WebGL render loops (cube, wavecel)
  // or a file-upload picker (dx7, wavecel),
  // any of which can misbehave in the engine-less doc sandbox — face fallback is
  // the safe default.
  'macrooscillator',
  // Batch 3 — CV utilities & modulation shapers (2026-06-26): every one of these
  // cards is a pure Knob/Fader/button + PatchPanel with NO onMount/$effect, no
  // canvas/rAF/WebGL, no Web-MIDI panel, no file input, and no `card:` override —
  // the macrooscillator profile — so each mounts cleanly in the engine-less doc
  // sandbox. Verified live by e2e/tests/docs-virtual-module.spec.ts (a control
  // hover updates the pane with no page error; unityscalemathematik + slewSwitch
  // also exercise the CV→param dual context).
  'polarizer',
  'depolarizer',
  'scaler',
  'attenumix',
  'unityscalemathematik',
  'sampleHold',
  'slewSwitch',
  // Batch 4 — effects (2026-06-26): every card in this cluster is a pure
  // Knob/Fader + PatchPanel (clouds adds one $derived FREEZE toggle button, no
  // onMount/$effect) — no canvas/rAF/WebGL, no Web-MIDI panel, no file input,
  // no `card:` override — the macrooscillator profile — so each mounts cleanly
  // in the engine-less doc sandbox. Verified live by docs-virtual-module.spec.ts.
  'reverb',
  'delay',
  'clouds',
  'charlottesEchos',
  'shimmershine',
  'destroy',
  'ringback',
  // Batch 6 — Moog System 55/35 sources & utilities (2026-06-26): only the
  // CONVENTION-card members go here (no `card:` override, so the doc route's
  // defLite resolves `<Type>Card` and the live virtual module mounts). Each card
  // is a pure Knob + segmented-switch buttons + PatchPanel — no onMount/$effect,
  // no canvas/rAF/WebGL, no Web-MIDI panel, no file input — the macrooscillator
  // profile — so it mounts cleanly in the engine-less doc sandbox. Verified live
  // by docs-virtual-module.spec.ts. The override-card siblings (903a / 956 / 961
  // / 962 / 994) stay STATIC — see strict-docs.ts.
  'moog921Vco',
  'moog921a',
  'moog921b',
  'moog995',
  // Batch 7 — Moog System 35/55 modulation & routing (2026-06-26): only the
  // CONVENTION-card members go here (no `card:` override, so the doc route's
  // defLite resolves `<Type>Card` and the live virtual module mounts). moog911
  // (four Knobs) and moog984 (a 4×4 Knob matrix) are each a pure Knob +
  // PatchPanel via MoogPanel — no onMount/$effect, no canvas/rAF/WebGL, no
  // Web-MIDI panel, no file input — so they mount cleanly in the engine-less doc
  // sandbox. Verified live by docs-virtual-module.spec.ts. The override-card
  // siblings (911a / 912 / 960 / 992 / 993 / cp3) stay STATIC — see strict-docs.ts.
  'moog911',
  'moog984',
  // Batch 8 — CV/signal utilities & small processors (2026-06-26): only the
  // CONVENTION-card members go here (no `card:` override, so the doc route's
  // defLite resolves `<Type>Card` and the live virtual module mounts). Each card
  // is a pure Fader/Knob + PatchPanel — no onMount/$effect, no canvas/rAF/WebGL,
  // no Web-MIDI panel, no file input — the macrooscillator profile — so it mounts
  // cleanly in the engine-less doc sandbox. Verified live by
  // docs-virtual-module.spec.ts (analogLogicMaths / sidecar / resofilter also
  // exercise the CV→param dual context). The STATIC siblings stay off this list:
  // fourplexer + flipper carry a `card:` override (defLite can't resolve it), and
  // scope's card runs a 2D-canvas rAF render loop — see strict-docs.ts.
  'stereovca',
  'gatemaiden',
  'illogic',
  'analogLogicMaths',
  'sidecar',
  'resofilter',
  // Batch 9 — synth voices & percussion sources (2026-06-26): only the
  // CONVENTION-card members (no `card:` override, so the doc route's defLite
  // resolves `<Type>Card` and the live virtual module mounts). Each card is a
  // pure Fader/Knob + PatchPanel with NO onMount/$effect, no canvas/rAF/WebGL,
  // no Web-MIDI panel, no file input — the macrooscillator profile — so it
  // mounts cleanly in the engine-less doc sandbox. Verified live by
  // docs-virtual-module.spec.ts (treeohvox / callsine also exercise the CV→param
  // dual context). The STATIC siblings stay off this list: pentemelodica
  // runs per-voice waveform scopes ($effect) — see strict-docs.ts.
  'drummergirl',
  'meowbox',
  'treeohvox',
  'buggles',
  'callsine',
  // Batch 10 — sequencers, clocks & pattern generators (2026-06-26): the
  // convention-card members (no `card:` override, so the doc route's defLite
  // resolves `<Type>Card` and the live virtual module mounts). Each card is a
  // pure Knob/Fader/buttons + PatchPanel; the only mount-time work is a
  // playhead-polling requestAnimationFrame that reads engine.read(node,…) — and
  // SequencerCard (the canonical interactive card) does exactly that, so in the
  // engine-less doc sandbox the read simply no-ops. Verified live by
  // docs-virtual-module.spec.ts (polyseqz humanize_cv→humanize and marbles
  // rate_cv→rate also exercise the CV→param dual context; the other six have no
  // paramTarget CV input, so their probe skips the dual check). The STATIC
  // siblings stay off this list: KRIA's card touches the WebSerial monome-grid
  // API at init, and NUMPAD+'s card installs a document-level capturing keydown
  // listener — both are doc-sandbox-unsafe side effects, so they use the static
  // face fallback (see strict-docs.ts).
  'cartesian',
  'drumseqz',
  'macseq',
  'polyseqz',
  'writeseq',
  'marbles',
  // Batch 12 — modulation, function generators, clocks & live-control utilities
  // (2026-06-26): only the CONVENTION-card members whose cards are a pure
  // Fader/button + PatchPanel with NO onMount/$effect, no canvas/rAF/WebGL, no
  // Web-MIDI panel and no file input — the macrooscillator profile — go here, so
  // each mounts cleanly in the engine-less doc sandbox. Verified live by
  // docs-virtual-module.spec.ts (qbrt cutoff→CUTOFF exercises the CV→param
  // dual context). The STATIC
  // siblings stay off this list: timelorde + rasterize run a 2D-canvas render,
  // score's card is an SVG staff with mouse note-entry, clipplayer runs a
  // playhead render loop + the WebSerial monome grid, and clockedRunner + livecode
  // mount a CodeMirror editor — see strict-docs.ts.
  'qbrt',
  // Batch 13 — heavy synth voices, effects & utilities (2026-06-26): only the
  // CONVENTION-card members whose cards are a pure Knob/Fader + buttons +
  // PatchPanel with NO onMount/$effect, no canvas/rAF/WebGL, no Web-MIDI panel
  // and no file input — the macrooscillator profile — go here, so each mounts
  // cleanly in the engine-less doc sandbox. cloudseed (Knobs/Faders + ON/OFF
  // pills + preset footer) qualifies; verified live by docs-virtual-module.spec.ts
  // (cloudseed late_cv→late_out exercises the CV→param dual context). The
  // STATIC siblings stay off this list: foxy/twotracks/synesthesia/warrenspectrum
  // run a 2D-canvas render in the card, hypercube renders WebGL + has a file
  // picker, and bluebox has no
  // control-<paramId> Knob/Fader to hover (its keys are press-and-hold buttons)
  // — see strict-docs.ts.
  'cloudseed',
  // Batch 14 — FINAL audio batch (2026-06-26): every member stays STATIC (off
  // this list): the four games (frogger/modtris/pong/skifree) + spectrograph
  // run a 2D-canvas rAF render loop, samsloop adds a waveform canvas +
  // file-upload + mic record, and wavesculpt renders WebGL2 + has a per-osc
  // .wav picker — see strict-docs.ts.
]);

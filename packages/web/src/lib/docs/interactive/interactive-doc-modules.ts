// packages/web/src/lib/docs/interactive/interactive-doc-modules.ts
//
// Allowlist of module types whose /docs/modules/[id] page renders the live
// INTERACTIVE virtual module (real card + hover pane) as the PRIMARY view. Every
// other module keeps the static numbered-face view (the live card is the
// redesign; the face is now the no-JS / not-yet-promoted fallback).
//
// This is the prototype gate: only modules proven on a live surface belong
// here, so one that misbehaves under the doc sandbox can't break its doc page —
// it falls back to the static face. Grow it as modules are verified (mirrors the
// STRICT_DOCS ratchet, but a SEPARATE axis: a module can be STRICT-documented
// yet not yet vetted on the live doc surface).
//
// ⚠ THE SURFACE THIS LIST ADMITS MODULES TO IS NOW THE FACEPLATE, NOT THE CARD,
// and every per-batch note below predates that. VirtualModule mounted the real
// `*Card.svelte` through the glob card-map until the face rebuild; it now mounts
// `<ModuleShell view='drawer'>`. READ THE BATCH NOTES AS PROVENANCE — they
// record the CARD-shaped argument that admitted each member ("pure Knob/Fader +
// PatchPanel, no onMount/canvas/rAF/WebSerial") and are true of the day they
// were written. They are NOT a live claim about what mounts today, and a member
// is NOT re-qualified by re-reading one.
//
// WHAT KEEPS MEMBERSHIP HONEST INSTEAD is `docs-virtual-module.spec.ts`: every
// member carries a PROBES row that boots its real doc page, waits on the
// faceplate's own `data-face-ready`, hovers a control, and asserts ZERO uncaught
// page errors across the whole flow. That is the live gate; this list is its
// roster.
//
// ⚠ AND THE CARD-SHAPED REASONS FOR *EXCLUSION* ARE THE HALF THAT IS NOW STALE
// IN A WAY THAT MATTERS. Most non-members are named below as "its CARD runs a
// canvas/rAF loop / a WebSerial init / a file picker" — arguments about a file
// that is being deleted. A face is declarative and shares the shell's cells, so
// several of those exclusions may no longer hold. Widening the list is a
// deliberate, owner-previewable change (it swaps ~140 doc pages from a static
// PNG to a live surface), verified the same way membership always was: add the
// name, add its PROBES row, watch it pass. It is NOT a side effect of the
// rebuild, and nothing here was widened by it.

export const INTERACTIVE_DOC_MODULES: ReadonlySet<string> = new Set<string>([
  // Prototype wave (2026-06-25): the CV/control overlap demo + a Y.Doc-backed
  // step grid.
  'adsr',
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
  // file input — so it mounts cleanly in the doc sandbox.
  //
  // ⚠ UPDATED 2026-08-09 (the face promotion): it now also carries the STRIKE
  // AUDITION button, which makes it the FIRST card on this allowlist to reach
  // for the live engine. That is safe here, and the reason is worth stating
  // rather than assuming: `fireManualStrike` resolves the engine through
  // `getActiveEngine()`, which returns null in the engine-less sandbox, so the
  // call returns false and the handler EARLY-RETURNS before its pulse timer —
  // no throw, no timer left running, no pane error. The pulse follows the
  // strike's return value rather than the click precisely so a press with no
  // engine cannot pretend to have struck anything, and that property is what
  // makes it sandbox-safe. Verified live: docs-virtual-module.spec.ts, 49/49.
  //
  // The hero PICTURE deliberately stayed in the shell panel and out of the
  // card, because a card gaining onMount/rAF/canvas WOULD break this list's
  // stated invariant. The other batch-2
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
  // docs-virtual-module.spec.ts (treeohvox also exercises the CV→param
  // dual context). The STATIC siblings stay off this list: pentemelodica
  // runs per-voice waveform scopes ($effect) — see strict-docs.ts.
  'drummergirl',
  'meowbox',
  'treeohvox',
  'buggles',
  // Batch 14 — WARREN'S SPECTRUM (2026-08-02): the spectral-resynth engine
  // that replaced callsine + warrenspectrum. Convention card (Faders +
  // PatchPanel + OssAttribution, no onMount/$effect/canvas/rAF), so it mounts
  // in the engine-less doc sandbox; verified live by docs-virtual-module.spec.ts
  // (partials_cv→spectralPartials exercises the CV→param dual context).
  'warrensspectrum',
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
  // STATIC siblings stay off this list: foxy/twotracks/synesthesia
  // run a 2D-canvas render in the card, and bluebox has no
  // control-<paramId> Knob/Fader to hover (its keys are press-and-hold buttons)
  // — see strict-docs.ts.
  'cloudseed',
  // Batch 14 — FINAL audio batch (2026-06-26): every member stays STATIC (off
  // this list): the four games (frogger/modtris/pong/skifree) + spectrograph
  // run a 2D-canvas rAF render loop, samsloop adds a waveform canvas +
  // file-upload + mic record, and wavesculpt renders WebGL2 + has a per-osc
  // .wav picker — see strict-docs.ts.
]);

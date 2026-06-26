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
  // Batch 2 (2026-06-25): macrooscillator's card is a pure PatchPanel + six
  // Faders + a derived label — no onMount/effect, no canvas/rAF, no Web MIDI or
  // file input — so it mounts cleanly in the doc sandbox. The other batch-2
  // voices stay STATIC: their cards run rAF/WebGL render loops (cube, wavecel),
  // a Web-MIDI settings panel (helm), or a file-upload picker (dx7, wavecel),
  // any of which can misbehave in the engine-less doc sandbox — face fallback is
  // the safe default.
  'macrooscillator',
]);

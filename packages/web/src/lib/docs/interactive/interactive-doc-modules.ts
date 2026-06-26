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
]);

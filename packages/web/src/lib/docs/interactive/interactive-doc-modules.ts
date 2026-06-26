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
  // NOTE — cocoadelay is documented (STRICT_DOCS) but intentionally NOT here.
  // Its def carries a `card: 'CocoaDelayCard'` override (the conventional
  // `cocoadelay → CocoadelayCard` name doesn't match the file), and the doc
  // route's prerender-safe `defLite` (routes/docs/modules/[id]/+page.server.ts)
  // does NOT plumb `card` through — so buildNodeTypes can't resolve its card and
  // the live virtual module never mounts. It correctly falls back to the static
  // doc view. Plumbing `card` into the manifest + defLite is a separate infra
  // follow-up; until then any override-card module stays off this allowlist.
]);

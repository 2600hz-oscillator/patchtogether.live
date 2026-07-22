// Palette type definitions — the COLOR-ONLY theme surface (P0.1 re-tier).
//
// A "palette" is a named bundle of CSS-variable colour overrides applied to
// `document.documentElement` at runtime. It swaps ONLY the palette layer of
// the design-token system ($lib/styles/tokens.css); the STRUCTURAL layer
// (type scale, radii, spine/tile/knob/fader/meter geometry, shadows, the
// legacy --module-radius/-glow/-border/-stripe fallbacks in _module-card.css)
// is FIXED — one dark structure, never themed.
//
// This is the re-tier from the old "skin" model: the structural theme vars
// (--module-radius/-glow/-border-color/-stripe-radius, the sprite hooks
// controlStyle/panelBg/faderTrackBg/silkscreen*, and the data-skin CSS
// overlays) were MOVED OUT of the theme surface into the fixed structure, so
// a palette is now a pure `Record<colorToken,string>`. See the plan §2 + §5.
//
// The variable NAMES are the public contract — every palette MUST cover the
// same set of keys so switching is a complete swap, not a partial overlay.
// The names are APP-NATIVE (--bg, --surface-*, --cable-*, …) so a palette
// swap recolours the whole app (cards, canvas, cable legend, jacks).

export type PaletteId = 'rackline' | 'graphite' | 'midnight' | 'ember' | 'slate';

/** Every palette MUST set every key. Colour tokens only — no structural
 *  geometry, no sprite hooks. The keys are the public palette contract. */
export interface PaletteVars {
  // ---- surfaces ----
  '--bg': string;
  '--bg-grid-dot': string;
  '--surface-1': string;
  '--surface-2': string;
  '--surface-3': string;
  '--module-bg': string;
  '--module-bg-deep': string;

  // ---- lines ----
  '--border': string;
  '--border-strong': string;
  '--divider': string;

  // ---- ink ----
  '--text': string;
  '--text-dim': string;
  '--text-on-accent': string;

  // ---- accent (chrome only — NOT a cable type) ----
  '--accent': string;
  '--accent-dim': string;
  '--accent-glow': string;

  // ---- cables / domain colours (the NAMES are Canvas's
  //      `var(--cable-${type})` contract; every palette defines all 9). The
  //      spine colour of a module = its cable-domain colour (no separate
  //      --spine-* token). ----
  '--cable-audio': string;
  '--cable-pitch': string;
  '--cable-gate': string;
  '--cable-cv': string;
  '--cable-polyPitchGate': string;
  '--cable-keys': string;
  '--cable-image': string;
  '--cable-mono-video': string;
  '--cable-video': string;
}

export interface Palette {
  id: PaletteId;
  /** Display name for the switcher UI. */
  label: string;
  /** One-liner shown under the label in the switcher popover. */
  description: string;
  /** Colour-var overrides applied to `document.documentElement` on activation. */
  vars: PaletteVars;
}

/** Tiny color-swatch row used in the switcher popover preview.
 *  Order: bg, accent, audio cable, cv cable. */
export function swatchColorsFor(p: Palette): [string, string, string, string] {
  return [
    p.vars['--bg'],
    p.vars['--accent'],
    p.vars['--cable-audio'],
    p.vars['--cable-cv'],
  ];
}

// UI skin type definitions.
//
// A "skin" is a named bundle of CSS-variable overrides applied to
// `document.documentElement` at runtime. The variable names are the
// public contract — every skin MUST cover the same set of keys so that
// switching skins is a complete swap rather than a partial overlay.
//
// Why TS objects (vs. CSS files-per-skin):
//   - one source of truth (no duplicating keys across .ts + .css)
//   - type-checked: a missing var triggers a compile error via SkinVars
//   - skin objects are tree-shakeable; a future "load custom skin from
//     server" path can fetch the same shape as JSON
//
// See `.myrobots/plans/ui-skins-v2.md` §3 for the token surface rationale
// and §4 for the per-skin design notes.

export type SkinId =
  | 'default'
  | 'terminal-green'
  | 'brutalist'
  | 'vaporwave'
  | 'vintage'
  | 'matrixcowboy'
  | 'diner'
  | 'lcars';

/** Every skin MUST set every key. The keys are the public skin contract;
 *  adding/removing a key is a breaking change for any future custom-skin
 *  uploader. */
export interface SkinVars {
  // ---- surfaces ----
  '--bg': string;
  '--bg-grid-dot': string;
  '--surface-1': string;
  '--surface-2': string;
  '--surface-3': string;
  '--module-bg': string;
  '--module-bg-deep': string;

  // ---- chrome lines ----
  '--border': string;
  '--border-strong': string;
  '--divider': string;

  // ---- text ----
  '--text': string;
  '--text-dim': string;
  '--text-on-accent': string;

  // ---- accent (chrome only — NOT a cable type) ----
  '--accent': string;
  '--accent-dim': string;
  '--accent-glow': string;

  // ---- cables (NAMES are part of Canvas's `var(--cable-${type})`
  //      contract; values may shift per skin but every skin must define
  //      all 9). ----
  '--cable-audio': string;
  '--cable-pitch': string;
  '--cable-gate': string;
  '--cable-cv': string;
  '--cable-polyPitchGate': string;
  '--cable-keys': string;
  '--cable-image': string;
  '--cable-mono-video': string;
  '--cable-video': string;

  // ---- OPTIONAL shape tokens (added for the DINER skin) ----
  //
  // These are OPTIONAL by design: the six pre-existing skins do NOT set
  // them, and `_module-card.css` consumes each via `var(--token, <fallback>)`
  // where <fallback> reproduces the CURRENT hard-edged value byte-for-byte.
  // That keeps every existing skin's VRT baseline unchanged; only a skin
  // that opts in (DINER) lights up. See _module-card.css for the consume
  // sites + their fallbacks.

  /** Outer corner radius for module cards. Fallback in CSS = `2px`
   *  (the legacy hard-edged value). DINER sets a generous rounded value. */
  '--module-radius'?: string;
  /** Corner radius for the card's top accent stripe. Fallback in CSS =
   *  `2px 2px 0 0` (legacy). Lets the stripe follow a rounded card top. */
  '--module-stripe-radius'?: string;
  /** Extra box-shadow layer applied to .mod-card for a neon-tube glow.
   *  Fallback in CSS = the legacy drop-shadow only (no glow). DINER sets
   *  a soft purple outer glow so cards read as lit neon signs. */
  '--module-glow'?: string;
  /** Border colour override for the neon-tube outline. Fallback = `--border`
   *  (so non-DINER skins are untouched). DINER sets a thin purple. */
  '--module-border-color'?: string;
}

export interface Skin {
  id: SkinId;
  /** Display name for the switcher UI. */
  label: string;
  /** One-liner shown under the label in the switcher popover. */
  description: string;
  /** Variable overrides applied to `document.documentElement` on activation. */
  vars: SkinVars;

  // ---- Sprite/asset extension (Vintage skin + future hardware skins) ----
  //
  // The four legacy skins are CSS-only (controlStyle undefined => 'css').
  // A skin can opt into sprite/SVG-based controls by setting
  // controlStyle: 'sprite' and supplying the rendering hooks below.
  // Components MUST treat every field here as optional and fall back to
  // the CSS-only rendering when absent — that preserves byte-identical
  // output for the four legacy skins and any future CSS-only skin.

  /** Which rendering path the control components should use. Default
   *  'css' preserves the legacy look; 'sprite' opts in to the alternate
   *  path that consumes faderHandle*, panelBg, etc. */
  controlStyle?: 'css' | 'sprite';
  /** Inline SVG <symbol> markup (or a URL) for the fader thumb/handle.
   *  Inline SVG is preferred — it inherits currentColor + scales
   *  cleanly + adds zero network hops. URLs are accepted for raster
   *  sprite-sheet variants in the future. */
  faderHandleSvg?: string;
  /** Optional CSS background for the fader track (e.g. a brushed-metal
   *  feTurbulence gradient encoded as a data: URL). Falls back to the
   *  default --module-bg-deep flat fill. */
  faderTrackBg?: string;
  /** Optional CSS background applied to .mod-card via skin-store.
   *  Typical use is a feTurbulence-based brushed-metal data: URL so the
   *  panel reads as a hardware faceplate. */
  panelBg?: string;
  /** Font-family stack to use for module-card labels under this skin
   *  (the "silkscreen" / label-tape look). Applied via --font-silkscreen. */
  silkscreenFontFamily?: string;
  /** Optional URL of a font stylesheet to inject into <head> when this
   *  skin activates (Google Fonts CDN URL is the expected shape). */
  silkscreenFontStylesheet?: string;
}

/** Tiny color-swatch row used in the switcher popover preview.
 *  Order: bg, accent, audio cable, pitch cable. */
export function swatchColorsFor(skin: Skin): [string, string, string, string] {
  return [
    skin.vars['--bg'],
    skin.vars['--accent'],
    skin.vars['--cable-audio'],
    skin.vars['--cable-pitch'],
  ];
}

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

export type SkinId = 'default' | 'terminal-green' | 'brutalist' | 'vaporwave';

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
}

export interface Skin {
  id: SkinId;
  /** Display name for the switcher UI. */
  label: string;
  /** One-liner shown under the label in the switcher popover. */
  description: string;
  /** Variable overrides applied to `document.documentElement` on activation. */
  vars: SkinVars;
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

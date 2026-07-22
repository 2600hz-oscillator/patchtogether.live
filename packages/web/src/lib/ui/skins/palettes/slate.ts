// SLATE — a lighter, desaturated blue-grey dark over the same fixed structure.
//
// The most "lifted" of the dark palettes: softer contrast, cooler slate
// surfaces, a muted steel-blue accent. Easiest on the eyes in bright rooms.
// Still a dark structure (not a light mode). Same fixed cable-domain language.

import type { Palette } from '../types';
import { CABLE_VARS } from './_cables';

export const slatePalette: Palette = {
  id: 'slate',
  label: 'Slate',
  description: 'Soft desaturated slate with a steel-blue accent.',
  vars: {
    '--bg': '#15181c',
    '--bg-grid-dot': '#2a2f37',
    '--surface-1': '#20242a',
    '--surface-2': '#2f353d',
    '--surface-3': '#343b44',
    '--module-bg': '#252a31',
    '--module-bg-deep': '#101317',

    '--border': '#39404a',
    '--border-strong': '#4a525d',
    '--divider': '#2c3138',

    '--text': '#eef1f4',
    '--text-dim': '#a3abb6',
    '--text-on-accent': '#0f151a',

    '--accent': '#7fa8d6',
    '--accent-dim': '#456686',
    '--accent-glow': 'rgba(127, 168, 214, 0.4)',

    ...CABLE_VARS,
  },
};

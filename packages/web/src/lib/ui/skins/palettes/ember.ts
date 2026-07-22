// EMBER — a warm charcoal palette over the same fixed structure.
//
// Slightly warm, brown-tinted charcoal panels + a warm-orange accent. Cozy,
// low-glare, without going full sepia. Same fixed cable-domain language.

import type { Palette } from '../types';
import { CABLE_VARS } from './_cables';

export const emberPalette: Palette = {
  id: 'ember',
  label: 'Ember',
  description: 'Warm charcoal with a burnt-orange accent.',
  vars: {
    '--bg': '#14110f',
    '--bg-grid-dot': '#2c2620',
    '--surface-1': '#1d1917',
    '--surface-2': '#2e2823',
    '--surface-3': '#332c26',
    '--module-bg': '#221d1a',
    '--module-bg-deep': '#0d0b09',

    '--border': '#352d27',
    '--border-strong': '#4a4039',
    '--divider': '#292420',

    '--text': '#f5efe8',
    '--text-dim': '#b0a598',
    '--text-on-accent': '#1a1108',

    '--accent': '#ff8a3c',
    '--accent-dim': '#a3521f',
    '--accent-glow': 'rgba(255, 138, 60, 0.4)',

    ...CABLE_VARS,
  },
};

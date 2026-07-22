// MIDNIGHT — deep navy-blue surfaces over the same fixed structure.
//
// Cool indigo-tinted panels + a bright sky accent. Reads darker + moodier
// than RACKLINE while keeping the identical cable-domain language.

import type { Palette } from '../types';
import { CABLE_VARS } from './_cables';

export const midnightPalette: Palette = {
  id: 'midnight',
  label: 'Midnight',
  description: 'Deep navy indigo with a sky-blue accent.',
  vars: {
    '--bg': '#0b0f1a',
    '--bg-grid-dot': '#1c2540',
    '--surface-1': '#111726',
    '--surface-2': '#1e2740',
    '--surface-3': '#222c48',
    '--module-bg': '#151b2e',
    '--module-bg-deep': '#080b14',

    '--border': '#28324f',
    '--border-strong': '#3a4770',
    '--divider': '#1c2438',

    '--text': '#eaf0fb',
    '--text-dim': '#93a2c4',
    '--text-on-accent': '#081018',

    '--accent': '#5cc8ff',
    '--accent-dim': '#2c6f96',
    '--accent-glow': 'rgba(92, 200, 255, 0.4)',

    ...CABLE_VARS,
  },
};

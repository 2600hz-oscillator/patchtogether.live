// GRAPHITE — a cooler, more neutral graphite over the same fixed structure.
//
// Flatter, greyer surfaces than RACKLINE (less warmth in the panels) with a
// teal accent that leans into the audio-domain hue. A calm, low-chroma
// workspace for long sessions.

import type { Palette } from '../types';
import { CABLE_VARS } from './_cables';

export const graphitePalette: Palette = {
  id: 'graphite',
  label: 'Graphite',
  description: 'Cool neutral graphite with a teal accent.',
  vars: {
    '--bg': '#101215',
    '--bg-grid-dot': '#22262d',
    '--surface-1': '#191c20',
    '--surface-2': '#282c32',
    '--surface-3': '#2b2f36',
    '--module-bg': '#1e2126',
    '--module-bg-deep': '#0b0d10',

    '--border': '#30343b',
    '--border-strong': '#3f444c',
    '--divider': '#25292f',

    '--text': '#eceff3',
    '--text-dim': '#98a0aa',
    '--text-on-accent': '#0b1214',

    '--accent': '#38d3c8',
    '--accent-dim': '#237a74',
    '--accent-glow': 'rgba(56, 211, 200, 0.4)',

    ...CABLE_VARS,
  },
};

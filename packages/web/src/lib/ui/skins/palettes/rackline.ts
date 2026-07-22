// RACKLINE — the canonical DEFAULT palette.
//
// EXACT reproduction of the RACKLINE mock's `:root` (ux-proposal-b.html:3-22),
// mapped onto the app-native palette token names. Values MUST stay in sync
// with the PALETTE seed block in $lib/styles/tokens.css so the pre-JS :root
// fallback matches the inline-applied default (guarded by skin-store.test.ts).

import type { Palette } from '../types';
import { CABLE_VARS } from './_cables';

export const racklinePalette: Palette = {
  id: 'rackline',
  label: 'Rackline',
  description: 'The canonical dark rack — teal / amber on graphite.',
  vars: {
    // surfaces (rail #17191d, rail-edge #26292f, panel #1c1f24, panel-hi
    // #262a31, inset #0a0c0f from the mock)
    '--bg': '#0e1013',
    '--bg-grid-dot': '#20242b',
    '--surface-1': '#17191d',
    '--surface-2': '#26292f',
    '--surface-3': '#262a31',
    '--module-bg': '#1c1f24',
    '--module-bg-deep': '#0a0c0f',

    // lines (mock --line #2c3037)
    '--border': '#2c3037',
    '--border-strong': '#3a3f47',
    '--divider': '#23262c',

    // ink (mock --ink / --ink-dim)
    '--text': '#eef1f5',
    '--text-dim': '#9aa2ad',
    '--text-on-accent': '#0e1013',

    // accent (mock --accent-amber #ffb347)
    '--accent': '#ffb347',
    '--accent-dim': '#b3762a',
    '--accent-glow': 'rgba(255, 179, 71, 0.4)',

    ...CABLE_VARS,
  },
};

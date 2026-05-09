// Vaporwave skin — synthwave purple + hot pink.
//
// Deep indigo background, pink + purple accents, magenta cables. Less
// aggressive than the v1 plan's Vaporwave: NO `backdrop-filter` on
// per-card surfaces (perf cliff on integrated GPUs per the v1 audit),
// NO custom font loading (deferred to a follow-up PR), glows are
// `box-shadow` driven via existing `--accent-glow` plumbing.
//
// Look-and-feel target: 1980s mall directory crossed with a tape
// cassette label.

import type { Skin } from './types';

export const vaporwaveSkin: Skin = {
  id: 'vaporwave',
  label: 'Vaporwave',
  description: 'Synthwave purple + hot pink, no glow cliffs.',
  vars: {
    // surfaces — deep indigo gradient family (flat colors only — Svelte
    // Flow's <Background> doesn't support gradients via CSS-var so we
    // pick a single deep value)
    '--bg': '#0a0521',
    '--bg-grid-dot': '#3b1e7a',
    '--surface-1': '#1a0b3d',
    '--surface-2': '#2c1660',
    '--surface-3': '#3e2087',
    '--module-bg': '#1e1245',
    '--module-bg-deep': '#0c061e',

    // borders — soft mauve
    '--border': '#4a2a90',
    '--border-strong': '#7b50d9',
    '--divider': '#2a1560',

    // text — pale lavender on dark
    '--text': '#f0e8ff',
    '--text-dim': '#a78bfa',
    '--text-on-accent': '#1a0b3d',

    // accent — hot pink with a real glow
    '--accent': '#ff7ce0',
    '--accent-dim': '#a04190',
    '--accent-glow': 'rgba(255, 124, 224, 0.55)',

    // cables — pink + cyan + violet pastels; keep four families distinct
    '--cable-audio': '#ffd966',           // pale yellow
    '--cable-pitch': '#8ab4ff',           // pale blue
    '--cable-gate': '#ff8aa8',            // hot pink
    '--cable-cv': '#6ef0c8',               // mint
    '--cable-polyPitchGate': '#c79cff',   // lavender
    '--cable-keys': '#e0bfff',            // pale violet
    '--cable-image': '#ff6ec7',           // electric pink
    '--cable-mono-video': '#b88aff',      // violet
    '--cable-video': '#ff8ee8',           // bubblegum pink
  },
};

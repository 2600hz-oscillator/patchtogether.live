// MATRIXCOWBOY skin — 90s CRT terminal with glitch flourishes.
//
// Visual target: a console cowboy's deck from a 1990s cyberpunk novel —
// bright phosphor green on near-black, IBM Plex Mono lettering, a faint
// CRT scanline overlay, and an occasional chromatic-aberration flicker
// that fires every few seconds to suggest a slightly-misaligned electron
// gun. Distinct from Terminal-Green (which is a quieter mainframe vibe);
// MATRIXCOWBOY leans harder into the glitch.
//
// Implementation notes:
//   - Token surface is plain CSS vars, like the other CSS-only skins.
//   - The scanline + flicker overlays live in global.css scoped to
//     `html[data-skin="matrixcowboy"]` so they activate ONLY when this
//     skin is selected, and switching away cleanly removes them.
//   - Monospace lettering is plumbed via the existing
//     silkscreenFontFamily field (no new theme surface added). This is
//     the same lever Vintage uses; here we reuse IBM Plex Mono so we
//     don't ship a second font.
//   - prefers-reduced-motion disables the flicker animation (see
//     global.css). The scanline overlay is static so it stays on.

import type { Skin } from './types';

export const matrixcowboySkin: Skin = {
  id: 'matrixcowboy',
  label: 'Matrixcowboy',
  description: 'Phosphor green CRT with scanlines and the occasional glitch.',
  // Reuse the IBM Plex Mono stylesheet Vintage already established; this
  // gives module-card labels a monospace silkscreen look without adding
  // a second font dependency.
  silkscreenFontFamily: "'IBM Plex Mono', ui-monospace, 'Courier New', monospace",
  silkscreenFontStylesheet:
    'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&display=swap',
  vars: {
    // surfaces — near-black with a hint of green so the CRT bg never
    // reads as a flat #000 OLED void. Subtle but felt.
    '--bg': '#020805',
    '--bg-grid-dot': '#0a3a1a',
    '--surface-1': '#03130a',
    '--surface-2': '#07291a',
    '--surface-3': '#0d4528',
    '--module-bg': '#04180c',
    '--module-bg-deep': '#010503',

    // borders — phosphor outlines, brighter than Terminal-Green so the
    // chrome reads as "this is a glowing CRT" rather than "muted lamp"
    '--border': '#1d6a30',
    '--border-strong': '#33ff66',
    '--divider': '#0a3a1a',

    // text — saturated phosphor green; text-dim is the burnt-in trace
    '--text': '#33ff66',
    '--text-dim': '#1e8a36',
    '--text-on-accent': '#020805',

    // accent — bright cyan-green, the pop colour for focus rings + cursors
    '--accent': '#7cffb0',
    '--accent-dim': '#1e8a55',
    '--accent-glow': 'rgba(124, 255, 176, 0.6)',

    // cables — green-family palette with two warm accents so cable type
    // still reads at a glance. Brighter saturation than Terminal-Green
    // so cables stay visible through the scanline overlay.
    '--cable-audio': '#e6ff00',           // electric chartreuse
    '--cable-pitch': '#33ffff',           // CRT cyan
    '--cable-gate': '#ff5544',            // glitch red
    '--cable-cv': '#33ff66',              // phosphor green
    '--cable-polyPitchGate': '#88ffee',   // pale teal
    '--cable-keys': '#bfffaa',            // pale lime
    '--cable-image': '#ff8855',           // amber-orange (warm warning)
    '--cable-mono-video': '#55ffcc',      // mint
    '--cable-video': '#aaff44',           // bright lime
  },
};

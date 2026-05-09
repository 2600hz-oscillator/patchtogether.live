// Brutalist skin — high-contrast monochrome.
//
// Near-black surfaces, white text, hard 2px white borders, no glow. Cable
// hues kept distinct (the four primary cable hues are the ONLY signal
// channel for cable type — flattening them to monochrome would break
// usability).
//
// Doubles as the high-contrast a11y option in the absence of a dedicated
// `prefers-contrast: more` mapping (deferred to a follow-up PR).

import type { Skin } from './types';

export const brutalistSkin: Skin = {
  id: 'brutalist',
  label: 'Brutalist',
  description: 'High-contrast monochrome with hard borders.',
  vars: {
    // surfaces — pure black + grey lifts; no warm tint
    '--bg': '#000000',
    '--bg-grid-dot': '#2a2a2a',
    '--surface-1': '#0a0a0a',
    '--surface-2': '#1a1a1a',
    '--surface-3': '#2a2a2a',
    '--module-bg': '#0a0a0a',
    '--module-bg-deep': '#000000',

    // borders — bright white, suggests the 2px hard look
    '--border': '#ffffff',
    '--border-strong': '#ffffff',
    '--divider': '#ffffff',

    // text — pure white, dim is mid-grey
    '--text': '#ffffff',
    '--text-dim': '#aaaaaa',
    '--text-on-accent': '#000000',

    // accent — bright white (no glow effect via this var alone; cable
    // borders + selection ring still use it though)
    '--accent': '#ffffff',
    '--accent-dim': '#888888',
    '--accent-glow': 'rgba(255, 255, 255, 0.35)',

    // cables — keep semantic hues but boost saturation for contrast
    '--cable-audio': '#ffd000',           // saturated yellow
    '--cable-pitch': '#3da5ff',           // saturated blue
    '--cable-gate': '#ff3d3d',            // saturated red
    '--cable-cv': '#3df090',               // saturated green
    '--cable-polyPitchGate': '#b386ff',   // saturated violet
    '--cable-keys': '#e5b3ff',            // light violet
    '--cable-image': '#ff4ea8',           // saturated pink
    '--cable-mono-video': '#cc7dff',      // saturated purple
    '--cable-video': '#ff7dcc',           // saturated magenta
  },
};

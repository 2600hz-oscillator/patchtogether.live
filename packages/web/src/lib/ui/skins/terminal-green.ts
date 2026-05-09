// Terminal-green skin — phosphor monitor.
//
// Black background, green-on-black text, cyan/green accents. Cable hues
// are unified into a green band (chartreuse/lime/mint/teal) — readable
// against the dark bg, distinct enough to still encode cable type.
//
// Reads as a 1980s mainframe terminal. Pairs well with the project's
// Voltage-Modular cable hover affordance (the brightening looks like a
// CRT scanline pass).

import type { Skin } from './types';

export const terminalGreenSkin: Skin = {
  id: 'terminal-green',
  label: 'Terminal',
  description: 'Phosphor green-on-black, CRT mainframe vibes.',
  vars: {
    // surfaces — pure black bg with subtle dark-green tinted lifts
    '--bg': '#000000',
    '--bg-grid-dot': '#0a2a14',
    '--surface-1': '#031a0c',
    '--surface-2': '#0a3318',
    '--surface-3': '#125028',
    '--module-bg': '#06200d',
    '--module-bg-deep': '#020a04',

    // borders — phosphor green outlines
    '--border': '#0a4a1c',
    '--border-strong': '#1a7a35',
    '--divider': '#082810',

    // text — bright phosphor green
    '--text': '#7fff7f',
    '--text-dim': '#3a9a4a',
    '--text-on-accent': '#000000',

    // accent — slightly cyan-shifted green so it pops vs. the body green
    '--accent': '#00ffaa',
    '--accent-dim': '#007a52',
    '--accent-glow': 'rgba(0, 255, 170, 0.55)',

    // cables — green family, four distinct hues so cable type still reads
    '--cable-audio': '#d6ff00',          // chartreuse
    '--cable-pitch': '#00d8a0',          // mint-cyan
    '--cable-gate': '#ff8a3c',           // amber (sole non-green for danger feel)
    '--cable-cv': '#9aff5a',             // lime
    '--cable-polyPitchGate': '#5affe5',  // teal
    '--cable-keys': '#bfffaa',           // pale lime
    '--cable-image': '#ffd66e',          // pale amber
    '--cable-mono-video': '#46ffaa',     // emerald
    '--cable-video': '#a8ff46',          // bright lime
  },
};

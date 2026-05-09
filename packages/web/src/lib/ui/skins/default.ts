// Default skin — current Tron-cyan look.
//
// Values MUST be byte-identical to the `:root` block in
// packages/web/src/routes/global.css. This guarantees the default skin
// produces zero pixel diff vs. an unskinned page, which keeps existing
// visual snapshot tests green.
//
// Tokens beyond what global.css defines (e.g. --surface-1, --border) are
// the literal hex values that currently appear hardcoded in components
// (PatchPanel, Canvas, Knob, Fader, ...). Lifting them into the skin
// surface here means switching to a non-default skin reaches them too.

import type { Skin } from './types';

export const defaultSkin: Skin = {
  id: 'default',
  label: 'Default',
  description: 'Tron-cyan dark — the original.',
  vars: {
    // surfaces — match global.css :root
    '--bg': '#0e1116',
    '--bg-grid-dot': '#1f242c',
    // surfaces lifted from literals (Canvas/PatchPanel/ModulePalette)
    '--surface-1': '#151a21',
    '--surface-2': '#2a2f3a',
    '--surface-3': '#353a47',
    '--module-bg': '#1a1d23',
    '--module-bg-deep': '#14171c',

    // borders / dividers lifted from literals (the leaked #2a2f3a etc.)
    '--border': '#2a2f3a',
    '--border-strong': '#404652',
    '--divider': '#1f242c',

    // text
    '--text': '#e0e0e0',
    '--text-dim': '#888888',
    '--text-on-accent': '#1a1d23',

    // accent — match global.css :root
    '--accent': '#00f0ff',
    '--accent-dim': '#006e7a',
    '--accent-glow': 'rgba(0, 240, 255, 0.45)',

    // cables — match global.css :root exactly (do NOT change without
    // updating the cable legend + the cable-type test)
    '--cable-audio': '#fbbf24',
    '--cable-pitch': '#60a5fa',
    '--cable-gate': '#f87171',
    '--cable-cv': '#34d399',
    '--cable-polyPitchGate': '#a78bfa',
    '--cable-keys': '#d8b4fe',
    '--cable-image': '#ec4899',
    '--cable-mono-video': '#c084fc',
    '--cable-video': '#f472b6',
  },
};

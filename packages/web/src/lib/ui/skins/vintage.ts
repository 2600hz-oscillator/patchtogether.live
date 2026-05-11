// Vintage skin — hardware-modular faceplate aesthetic.
//
// Visual target: a 1970s patch-bay synth. Warm cream + olive panel,
// brushed-aluminium fader handles, label-tape silkscreen lettering,
// muted cable hues so the wires read as cloth-jacketed patch leads
// rather than neon traces.
//
// This is the first skin that opts into the sprite/asset extension of
// SkinDef (controlStyle: 'sprite' + faderHandleSvg + panelBg + a
// silkscreen font). The four pre-existing skins keep controlStyle
// implicit-undefined (-> 'css') and render byte-identical to before.
//
// LICENSE NOTE on assets:
//   We deliberately use ZERO external asset files. The "brushed metal"
//   look comes from inline SVG <feTurbulence>, the fader handle is a
//   hand-rolled inline <svg>, and the silkscreen font is IBM Plex Mono
//   served from fonts.googleapis.com (SIL Open Font License 1.1).
//   That makes the skin license-clean by construction: nothing to
//   vendor, nothing to attribute beyond IBM Plex Mono (which the
//   Google Fonts CDN URL itself serves with proper OFL credits).

import type { Skin } from './types';

/** Brushed-aluminium texture for the panel. Inline SVG with feTurbulence
 *  fractalNoise + a subtle horizontal motion blur via feGaussianBlur.
 *  Encoded as a data: URL so it can drop straight into a CSS background.
 *  Tinted warm-cream by overlaying the result on the olive panel base. */
const PANEL_BG = `url("data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'>
    <filter id='b'>
      <feTurbulence type='fractalNoise' baseFrequency='0.9 0.015' numOctaves='2' seed='3'/>
      <feColorMatrix values='0 0 0 0 0.62  0 0 0 0 0.55  0 0 0 0 0.40  0 0 0 0.55 0'/>
    </filter>
    <rect width='100%' height='100%' fill='#b8a878'/>
    <rect width='100%' height='100%' filter='url(%23b)' opacity='0.55'/>
  </svg>`,
)}")`;

/** Fader track inlay — slightly darker olive with a subtle vertical
 *  brushed pattern, suggests the routed slot the handle slides in. */
const FADER_TRACK_BG = `url("data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='22' height='80'>
    <filter id='t'>
      <feTurbulence type='fractalNoise' baseFrequency='0.04 1.2' numOctaves='2' seed='5'/>
      <feColorMatrix values='0 0 0 0 0.22  0 0 0 0 0.20  0 0 0 0 0.15  0 0 0 0.7 0'/>
    </filter>
    <rect width='100%' height='100%' fill='#2a2418'/>
    <rect width='100%' height='100%' filter='url(%23t)' opacity='0.85'/>
  </svg>`,
)}")`;

/** Fader handle SVG — brushed aluminium block with a knurled grip
 *  groove across the middle and a notched value indicator. Inline so
 *  it inherits the surrounding currentColor for the indicator line
 *  and scales without aliasing. */
const FADER_HANDLE_SVG = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 22 14' preserveAspectRatio='none'>
  <defs>
    <linearGradient id='al' x1='0' y1='0' x2='0' y2='1'>
      <stop offset='0' stop-color='#e8e2cf'/>
      <stop offset='0.45' stop-color='#9b8e6e'/>
      <stop offset='0.55' stop-color='#5c5238'/>
      <stop offset='1' stop-color='#bdb18d'/>
    </linearGradient>
    <filter id='hg'>
      <feTurbulence type='fractalNoise' baseFrequency='0.02 1.8' numOctaves='1' seed='9'/>
      <feColorMatrix values='0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.18 0'/>
      <feComposite in2='SourceGraphic' operator='in'/>
    </filter>
  </defs>
  <rect x='0' y='0' width='22' height='14' rx='1.5' fill='url(#al)' stroke='#2a2418' stroke-width='0.6'/>
  <rect x='0' y='0' width='22' height='14' rx='1.5' filter='url(#hg)'/>
  <rect x='1' y='6' width='20' height='0.6' fill='#2a2418' opacity='0.7'/>
  <rect x='1' y='7.4' width='20' height='0.6' fill='#2a2418' opacity='0.7'/>
  <rect x='3' y='6.7' width='16' height='0.6' fill='#f4eed8'/>
</svg>`;

export const vintageSkin: Skin = {
  id: 'vintage',
  label: 'Vintage',
  description: 'Cream + olive faceplate, brushed-aluminium faders, label-tape font.',
  controlStyle: 'sprite',
  faderHandleSvg: FADER_HANDLE_SVG,
  faderTrackBg: FADER_TRACK_BG,
  panelBg: PANEL_BG,
  silkscreenFontFamily: "'IBM Plex Mono', ui-monospace, monospace",
  silkscreenFontStylesheet:
    'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500;600&display=swap',
  vars: {
    // surfaces — warm cream studio bg, olive panel
    '--bg': '#1f1a10',
    '--bg-grid-dot': '#3a3220',
    '--surface-1': '#2a2418',
    '--surface-2': '#3a3220',
    '--surface-3': '#4d4329',
    '--module-bg': '#b8a878',
    '--module-bg-deep': '#2a2418',

    // borders — dark olive, hard-edged like routed panel cutouts
    '--border': '#5c5238',
    '--border-strong': '#3a3220',
    '--divider': '#7a6f50',

    // text — dark on cream for body, lighter on dark surfaces
    '--text': '#2a2418',
    '--text-dim': '#5c5238',
    '--text-on-accent': '#f4eed8',

    // accent — burnt-orange indicator lamp + amber glow
    '--accent': '#c8521c',
    '--accent-dim': '#7a3010',
    '--accent-glow': 'rgba(200, 82, 28, 0.45)',

    // cables — muted cloth-jacketed patch-lead palette (still 9 distinct hues)
    '--cable-audio': '#c08a2a',          // mustard
    '--cable-pitch': '#3a5a8a',          // dusty navy
    '--cable-gate': '#b03020',           // brick red
    '--cable-cv': '#5a7a40',              // olive green
    '--cable-polyPitchGate': '#7a4ca0',  // muted violet
    '--cable-keys': '#a48ac0',            // pale plum
    '--cable-image': '#b04a78',           // dusty rose
    '--cable-mono-video': '#8a6abf',      // grape
    '--cable-video': '#c06aa0',           // mauve
  },
};

// DINER skin — "fancy" vaporwave aesthetic (the neon-sign sibling to Vintage).
//
// Visual target: a late-night vaporwave diner — deep indigo/black night sky,
// hot-magenta + cyan neon tubing, a sunset gradient bleeding up from the
// horizon, and chrome-edged controls. Where the CSS-only `vaporwave` skin is
// a quiet synthwave palette, DINER is the FANCY version: it opts into the
// sprite/asset extension (chrome fader handles + a scanline/grid panel
// texture), ships a retro web font, and lights every module card up like a
// neon sign via the new OPTIONAL shape tokens (rounded corners + a soft
// purple glow border).
//
// This is the second skin (after Vintage) to opt into controlStyle:'sprite'.
//
// LICENSE NOTE on assets — same discipline as Vintage:
//   ZERO external binary asset files. The panel texture, fader track + handle
//   are all hand-rolled INLINE SVG encoded as data: URLs. The label font is
//   Orbitron (SIL Open Font License 1.1) served from fonts.googleapis.com —
//   a geometric retro-futuristic face that reads as "neon signage" while
//   staying legible at the 0.85rem card-title size. Nothing to vendor,
//   nothing to attribute beyond what the Google Fonts CDN URL itself serves.

import type { Skin } from './types';

/** Panel texture — a subtle vaporwave perspective-grid + faint horizontal
 *  scanlines over a deep indigo base, so each card reads as a slab of
 *  neon-lit night sky rather than a flat fill. Encoded as a tiling data:URL
 *  background. Kept low-contrast so the sprite faders + labels stay legible
 *  on top. */
const PANEL_BG = `url("data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'>
    <defs>
      <linearGradient id='sky' x1='0' y1='0' x2='0' y2='1'>
        <stop offset='0' stop-color='#1a0b3d'/>
        <stop offset='0.62' stop-color='#241152'/>
        <stop offset='1' stop-color='#3a1466'/>
      </linearGradient>
    </defs>
    <rect width='100%' height='100%' fill='url(%23sky)'/>
    <!-- faint magenta perspective grid converging low -->
    <g stroke='#ff2fd0' stroke-width='0.5' opacity='0.10'>
      <line x1='0' y1='30' x2='120' y2='30'/>
      <line x1='0' y1='58' x2='120' y2='58'/>
      <line x1='0' y1='82' x2='120' y2='82'/>
      <line x1='0' y1='100' x2='120' y2='100'/>
    </g>
    <g stroke='#2fe6ff' stroke-width='0.5' opacity='0.08'>
      <line x1='20' y1='0' x2='52' y2='120'/>
      <line x1='60' y1='0' x2='60' y2='120'/>
      <line x1='100' y1='0' x2='68' y2='120'/>
    </g>
    <!-- 2px scanline tint -->
    <rect width='100%' height='100%' fill='#000' opacity='0.04'/>
  </svg>`,
)}")`;

/** Fader track — a narrow neon-tube channel: dark recessed slot with a faint
 *  cyan inner glow line down the centre, suggesting a lit tube the chrome
 *  handle rides in. */
const FADER_TRACK_BG = `url("data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='22' height='80'>
    <defs>
      <linearGradient id='slot' x1='0' y1='0' x2='1' y2='0'>
        <stop offset='0' stop-color='#0c061e'/>
        <stop offset='0.5' stop-color='#1a0b3d'/>
        <stop offset='1' stop-color='#0c061e'/>
      </linearGradient>
    </defs>
    <rect width='100%' height='100%' rx='6' fill='url(%23slot)'/>
    <rect x='10' y='4' width='2' height='72' rx='1' fill='%2300e5ff' opacity='0.45'/>
  </svg>`,
)}")`;

/** Fader handle — a chrome/cyan-magenta neon block with a bright value bar
 *  across the middle that reads as a lit segment. Rounded corners to match
 *  the curved-everything DINER language. Inline so it scales cleanly + the
 *  value bar can inherit currentColor at the caller. */
const FADER_HANDLE_SVG = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 22 14' preserveAspectRatio='none'>
  <defs>
    <linearGradient id='chrome' x1='0' y1='0' x2='0' y2='1'>
      <stop offset='0' stop-color='#fbd6ff'/>
      <stop offset='0.4' stop-color='#c46af0'/>
      <stop offset='0.55' stop-color='#5e2a9e'/>
      <stop offset='1' stop-color='#9b6ad6'/>
    </linearGradient>
  </defs>
  <rect x='0.5' y='0.5' width='21' height='13' rx='4' fill='url(#chrome)' stroke='#ff2fd0' stroke-width='0.8'/>
  <rect x='3' y='6.4' width='16' height='1.2' rx='0.6' fill='#00e5ff'/>
</svg>`;

export const dinerSkin: Skin = {
  id: 'diner',
  label: 'Diner',
  description: 'Fancy vaporwave — neon-sign cards, sunset grid, chrome faders.',
  controlStyle: 'sprite',
  faderHandleSvg: FADER_HANDLE_SVG,
  faderTrackBg: FADER_TRACK_BG,
  panelBg: PANEL_BG,
  // Orbitron — geometric retro-futuristic neon-signage face (OFL 1.1).
  silkscreenFontFamily: "'Orbitron', ui-sans-serif, system-ui, sans-serif",
  silkscreenFontStylesheet:
    'https://fonts.googleapis.com/css2?family=Orbitron:wght@500;600;700&display=swap',
  vars: {
    // surfaces — deep indigo/black night with a faint magenta horizon haze
    '--bg': '#0a0420',
    '--bg-grid-dot': '#4a1d7a',
    '--surface-1': '#160a36',
    '--surface-2': '#241152',
    '--surface-3': '#3a1466',
    '--module-bg': '#1a0b3d',
    '--module-bg-deep': '#0c061e',

    // borders — thin purple neon tubing (the visible card outline is
    // recoloured via --module-border-color below; these feed the chrome
    // around non-card surfaces: switcher, panels, dividers)
    '--border': '#8a3df0',
    '--border-strong': '#c46af0',
    '--divider': '#3a1466',

    // text — bright lavender-white on dark, with cyan-dim secondaries
    '--text': '#f5e9ff',
    '--text-dim': '#9d7ff0',
    '--text-on-accent': '#0a0420',

    // accent — hot magenta with a strong neon glow
    '--accent': '#ff2fd0',
    '--accent-dim': '#a01e8e',
    '--accent-glow': 'rgba(255, 47, 208, 0.6)',

    // cables — vaporwave neon palette; all 9 distinct + saturated so they
    // read as lit traces against the deep-indigo canvas
    '--cable-audio': '#ffd24a', // amber neon
    '--cable-pitch': '#00e5ff', // electric cyan
    '--cable-gate': '#ff3b6b', // hot coral
    '--cable-cv': '#3dffc2', // mint neon
    '--cable-polyPitchGate': '#b56bff', // ultraviolet
    '--cable-keys': '#e0a8ff', // pale orchid
    '--cable-image': '#ff2fd0', // magenta
    '--cable-mono-video': '#7c5cff', // indigo neon
    '--cable-video': '#ff7ce0', // bubblegum

    // ---- OPTIONAL shape tokens (DINER-only; consumed in _module-card.css
    //      with legacy fallbacks so the other six skins are untouched) ----
    '--module-radius': '14px',
    '--module-stripe-radius': '13px 13px 0 0',
    '--module-glow':
      '0 0 0 1px rgba(255, 47, 208, 0.35), 0 0 10px rgba(196, 106, 240, 0.45), 0 0 22px rgba(138, 61, 240, 0.30)',
    '--module-border-color': '#c46af0',
  },
};

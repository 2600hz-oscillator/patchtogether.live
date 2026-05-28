// LCARS skin — Star Trek: TNG "Okudagram" computer-interface aesthetic.
//
// Visual target: the Library Computer Access/Retrieval System UI designed by
// Michael Okuda for TNG. Pure-black void with floating panels built from big
// fully-rounded "pill" blocks in a warm palette — peach/orange, gold/amber,
// periwinkle blue, tan, mauve — bold condensed uppercase signage, and the
// signature rounded-elbow corner brackets. This is the third "fancy" skin
// (after Vintage + Diner) to opt into controlStyle:'sprite'; like them it
// lights up the OPTIONAL shape tokens — here pushed to MAXIMUM radius so
// cards read as rounded LCARS blocks rather than rectangles.
//
// LICENSE NOTE on assets — same discipline as Vintage + Diner:
//   ZERO external binary asset files. The panel texture, fader track + pill
//   handle are all hand-rolled INLINE SVG encoded as data: URLs. The label
//   font is Antonio (SIL Open Font License 1.1) served from
//   fonts.googleapis.com — a tall, bold, condensed grotesque that is the
//   closest free face to the proprietary "LCARS"/"Swiss 911 Ultra Compressed"
//   lettering Okuda used. Nothing to vendor, nothing to attribute beyond what
//   the Google Fonts CDN URL itself serves.
//
// TRADEMARK NOTE: "LCARS" / Star Trek are CBS/Paramount marks; this is a
//   fan-style homage skin, not a licensed asset. We ship no copyrighted art —
//   only an original colour palette + hand-drawn rounded shapes evoking the
//   look. Same posture as the other pop-culture-flavoured skins in-tree.

import type { Skin } from './types';

/** Panel texture — near-black base with one faint LCARS colour block bleeding
 *  in from the left edge + subtle horizontal scanlines, so each card reads as a
 *  lit Okudagram panel floating on the void rather than a flat fill. Kept very
 *  low-contrast so the sprite faders + labels stay legible on top and the
 *  canvas/cables behind stay readable. Tiling data: URL background. */
const PANEL_BG = `url("data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='160' height='120'>
    <defs>
      <linearGradient id='blk' x1='0' y1='0' x2='1' y2='0'>
        <stop offset='0' stop-color='#1a120a'/>
        <stop offset='0.5' stop-color='#0a0805'/>
        <stop offset='1' stop-color='#070503'/>
      </linearGradient>
    </defs>
    <rect width='100%' height='100%' fill='url(%23blk)'/>
    <!-- faint LCARS colour block bleeding in from the left edge -->
    <rect x='0' y='0' width='8' height='120' rx='4' fill='%23FF9900' opacity='0.14'/>
    <rect x='0' y='44' width='5' height='30' rx='2.5' fill='%239C9CFF' opacity='0.16'/>
    <!-- faint horizontal scanlines -->
    <g stroke='%23FFCC99' stroke-width='0.5' opacity='0.04'>
      <line x1='0' y1='24' x2='160' y2='24'/>
      <line x1='0' y1='60' x2='160' y2='60'/>
      <line x1='0' y1='96' x2='160' y2='96'/>
    </g>
  </svg>`,
)}")`;

/** Fader track — a fully-rounded LCARS pill channel: black recessed slot with
 *  generous pill ends and a faint amber centre line, suggesting a lit LCARS
 *  bar the pill handle rides in. Big corner radius matches the rounded-
 *  everything LCARS language. */
const FADER_TRACK_BG = `url("data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='22' height='80'>
    <rect width='22' height='80' rx='11' fill='%23080604'/>
    <rect x='1.5' y='1.5' width='19' height='77' rx='9.5' fill='none' stroke='%23FF9900' stroke-width='1' opacity='0.35'/>
    <rect x='10' y='6' width='2' height='68' rx='1' fill='%23FFCC33' opacity='0.30'/>
  </svg>`,
)}")`;

/** Fader handle SVG — a fully-rounded LCARS pill button: amber-to-peach
 *  gradient with a bright apricot value bar across the middle that reads as a
 *  lit segment. Very high corner radius (pill ends) so it matches the LCARS
 *  block language. Inline so it scales cleanly + the value bar can inherit
 *  currentColor at the caller. */
const FADER_HANDLE_SVG = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 22 14' preserveAspectRatio='none'>
  <defs>
    <linearGradient id='pill' x1='0' y1='0' x2='0' y2='1'>
      <stop offset='0' stop-color='#FFCC99'/>
      <stop offset='0.45' stop-color='#FF9966'/>
      <stop offset='0.55' stop-color='#FF9900'/>
      <stop offset='1' stop-color='#E07E1E'/>
    </linearGradient>
  </defs>
  <rect x='0.5' y='0.5' width='21' height='13' rx='6.5' fill='url(#pill)' stroke='#070503' stroke-width='0.8'/>
  <rect x='3' y='6.4' width='16' height='1.2' rx='0.6' fill='#FFCC33'/>
</svg>`;

export const lcarsSkin: Skin = {
  id: 'lcars',
  label: 'LCARS',
  description: 'Star Trek TNG Okudagram — black void, rounded pill panels, amber signage.',
  controlStyle: 'sprite',
  faderHandleSvg: FADER_HANDLE_SVG,
  faderTrackBg: FADER_TRACK_BG,
  panelBg: PANEL_BG,
  // Antonio — tall bold condensed grotesque, the closest free face to the
  // proprietary LCARS lettering (OFL 1.1). Card titles already uppercase via
  // the silkscreen treatment + the data-skin overlay below.
  silkscreenFontFamily: "'Antonio', 'Arial Narrow', ui-sans-serif, sans-serif",
  silkscreenFontStylesheet:
    'https://fonts.googleapis.com/css2?family=Antonio:wght@400;600;700&display=swap',
  vars: {
    // surfaces — pure black void; LCARS panels float on it. Grid dots are
    // dimmed almost to nothing (LCARS has no graph-paper background). Cards
    // sit in a warm near-black so the pill panel art reads against them.
    '--bg': '#000000',
    '--bg-grid-dot': '#1a120a',
    '--surface-1': '#0a0805',
    '--surface-2': '#161009',
    '--surface-3': '#23180c',
    '--module-bg': '#0a0805',
    '--module-bg-deep': '#050403',

    // chrome lines — the visible card outline is recoloured to amber via
    // --module-border-color below; these feed the chrome around non-card
    // surfaces (switcher, popover, dividers) in the LCARS palette.
    '--border': '#FF9900', // gold/amber
    '--border-strong': '#FF9966', // peach/orange
    '--divider': '#5566AA', // deeper blue

    // text — light apricot body on black, periwinkle dim for secondaries,
    // black ink on the amber accent fills.
    '--text': '#FFCC99', // light apricot
    '--text-dim': '#9C9CFF', // periwinkle
    '--text-on-accent': '#000000',

    // accent — signature LCARS orange with a warm amber glow.
    '--accent': '#FF9900', // gold/amber
    '--accent-dim': '#CC7A00',
    '--accent-glow': 'rgba(255, 153, 0, 0.55)',

    // cables — drawn from the canonical LCARS palette, kept distinguishable
    // (all 9 distinct hues) + bright enough to read as lit traces on black.
    '--cable-audio': '#FF9900', // gold/amber
    '--cable-pitch': '#9C9CFF', // periwinkle blue
    '--cable-gate': '#FF9966', // peach/orange
    '--cable-cv': '#99CCFF', // light blue/cyan
    '--cable-polyPitchGate': '#CC99CC', // mauve/lavender
    '--cable-keys': '#FFCC99', // light apricot
    '--cable-image': '#FFCC33', // yellow
    '--cable-mono-video': '#D9C7A3', // tan/beige
    '--cable-video': '#5566AA', // deeper blue

    // ---- OPTIONAL shape tokens (DINER+; consumed in _module-card.css with
    //      legacy fallbacks so the non-opt-in skins are untouched) ----
    // LCARS pushes the radius to MAXIMUM so cards read as fully-rounded pill
    // blocks. A large stripe radius keeps the top accent bar tracking the
    // rounded card top. The glow is a warm amber halo so cards read as lit
    // Okudagram panels; the border is the signature LCARS amber.
    '--module-radius': '22px',
    '--module-stripe-radius': '22px 22px 0 0',
    '--module-glow':
      '0 0 0 1px rgba(255, 153, 0, 0.40), 0 0 10px rgba(255, 153, 102, 0.35), 0 0 22px rgba(156, 156, 255, 0.18)',
    '--module-border-color': '#FF9900',
  },
};

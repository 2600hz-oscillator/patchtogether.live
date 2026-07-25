// module-guides.ts — maps a module TYPE to its dedicated, hand-written guide
// page (the illustrated walkthroughs under /docs/modules/<slug>/), so the
// auto-generated `[id]` reference page can surface a prominent "read the full
// guide" callout instead of leaving those rich pages orphaned.
//
// Only list modules whose guide lives at a DIFFERENT url than their auto
// `[id]` page. (A guide whose slug equals the module type — e.g. `livecode` —
// is already served at /docs/modules/<type> by SvelteKit's static-route
// precedence, so the `[id]` page never renders for it and a callout would point
// at itself.)

export interface ModuleGuide {
  /** Absolute route to the dedicated guide page. */
  href: string;
  /** Short title shown on the callout link. */
  title: string;
  /** One-line description of what the guide covers. */
  blurb: string;
}

export const MODULE_GUIDES: Record<string, ModuleGuide> = {
  clipplayer: {
    href: '/docs/modules/grid-clip-launcher',
    title: 'Clip launcher, monome grid & song mode',
    blurb:
      'The full illustrated guide — launching clips, scenes & quantize, editing notes on the pads, driving it from a monome grid 128, and recording a session into a song-mode arrangement.',
  },
  doom: {
    href: '/docs/modules/doom-multiplayer',
    title: 'DOOM multiplayer',
    blurb: 'How the shared-rack DOOM netgame works — joining, the lockstep model, and its caveats.',
  },
  launchpadControlLeft: {
    href: '/docs/modules/launchpadControlLeft',
    title: 'Launchpad control (clip launcher)',
    blurb:
      'Drive the clip player from a pair of Novation Launchpad Mini Mk3 units — the always-live 8×8 matrix on the left, the command deck + note editor on the right. Pairing, pad/CC map, SHIFT windowing, and the full RGB colour language.',
  },
  push2Control: {
    href: '/docs/modules/push2Control',
    title: 'Push 2 control (clip launcher)',
    blurb:
      'Drive the clip player from an Ableton Push 2 — full Launchpad parity on the 8×8 pads, START/STOP on Play, D-Pad clip nav, the 8 above-display buttons select channel 1-8, and the 11 encoders drive the MixMasters volume + sends.',
  },
  vfpgaRunner: {
    href: '/docs/modules/vfpga-runner',
    title: 'VFPGA runner guide',
    blurb: 'The video-FPGA effect runner — the tile model, the catalog, and how to wire it.',
  },
};

/** The dedicated guide for a module type, or null if it only has the auto page. */
export function guideFor(type: string): ModuleGuide | null {
  return MODULE_GUIDES[type] ?? null;
}

// GUIDE_PAGES — the hand-written walkthrough pages that live at custom routes
// under /docs/modules/<slug>/ (NOT auto-generated from a module def). The
// catalog (/docs/modules) is built from `buildModuleManifest()`, which globs
// ONLY `audio/modules/*.ts`, so these pages are otherwise UNREACHABLE from the
// catalog or nav:
//   - grid-clip-launcher / launchpadControlLeft / doom-multiplayer / vfpga-runner
//     have no module def at all (no `[id]` page);
//   - mappy / onetonine are VIDEO modules — absent from the audio-only catalog;
//   - livecode is an audio module already in the catalog, listed here too so the
//     guides section is a complete index of the illustrated walkthroughs.
// An explicit small list (intentionally NOT auto-derived from the audio manifest)
// keeps each guide one click away. `slug` is the route segment under
// /docs/modules/.
export interface GuidePage {
  /** Route segment under /docs/modules/ (the custom static route). */
  slug: string;
  /** Display title for the catalog's guides section. */
  title: string;
  /** One-line description of what the guide covers. */
  blurb: string;
}

export const GUIDE_PAGES: GuidePage[] = [
  {
    slug: 'grid-clip-launcher',
    title: 'Clip player + monome grid',
    blurb:
      'Launch clips, scenes & quantize, edit notes on the pads, drive it from a monome grid 128, and record a session into a song-mode arrangement.',
  },
  {
    slug: 'launchpadControlLeft',
    title: 'Launchpad control (clip launcher)',
    blurb:
      'Drive the clip player from a pair of Novation Launchpad Mini Mk3 units — pairing, the pad/CC map, SHIFT windowing, and the full RGB colour language.',
  },
  {
    slug: 'push2Control',
    title: 'Push 2 control (clip launcher)',
    blurb:
      'Drive the clip player from an Ableton Push 2 — Launchpad parity on the pads, Play transport, D-Pad nav, channel-select buttons, and the encoder→MixMasters map.',
  },
  {
    slug: 'mappy',
    title: 'mappy (projection mapping)',
    blurb: 'Warp and place video onto real-world surfaces — corner-pin / mesh mapping for projectors.',
  },
  {
    slug: 'onetonine',
    title: 'one to nine (3×3 screen splitter)',
    blurb: 'Split one video source into nine equal cells, each on its own output — feed up to nine projectors.',
  },
  {
    slug: 'livecode',
    title: 'livecode',
    blurb: 'The in-rack live-coding module — write code that drives the patch.',
  },
  {
    slug: 'doom-multiplayer',
    title: 'DOOM multiplayer',
    blurb: 'How the shared-rack DOOM netgame works — joining, the lockstep model, and its caveats.',
  },
  {
    slug: 'vfpga-runner',
    title: 'vfpga runner',
    blurb: 'The video-FPGA effect runner — the tile model, the catalog, and how to wire it.',
  },
];

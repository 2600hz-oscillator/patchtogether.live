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
    title: 'Launchpad clip launcher (L + R)',
    blurb:
      'Drive the clip player from a pair of Novation Launchpad Mini Mk3 units — the always-live 8×8 matrix on the left, the command deck + note editor on the right. Pairing, pad/CC map, SHIFT windowing, and the full RGB colour language.',
  },
  launchpadControlRight: {
    href: '/docs/modules/launchpadControlRight',
    title: 'Launchpad clip launcher (L + R)',
    blurb:
      'The right Launchpad is the command deck (EDIT / COPY / PASTE / DOUBLE / LENGTH / NOW + per-lane STOP + transport) and flips to the note editor while you edit. Pairing, pad/CC map, SHIFT windowing, and the full RGB colour language.',
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

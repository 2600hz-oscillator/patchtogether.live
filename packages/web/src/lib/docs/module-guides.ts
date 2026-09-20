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
  doom: {
    href: '/docs/modules/doom-multiplayer',
    title: 'DOOM multiplayer',
    blurb: 'How the shared-rack DOOM netgame works — joining, the lockstep model, and its caveats.',
  },
  launchpadControlLeft: {
    href: '/docs/modules/launchpadControlLeft',
    title: 'Launchpad control (clip launcher)',
    blurb:
      'One or two Launchpad Mini Mk3 units: setup, pad maps, note tools, keys, audio recording, automation arms and LED feedback.',
  },
  push2Control: {
    href: '/docs/modules/push2Control',
    title: 'Push 2 control (clip launcher)',
    blurb:
      'Push 2 setup and physical controls: pads, note tools, keys, audio recording, display, LEGEND and parameter encoders.',
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

// GUIDE_PAGES indexes illustrated walkthroughs, including dedicated routes
// and the authored Clip Player guide embedded above its generated reference.
// This is editorial navigation, not a second module registry. Existing links
// to grid-clip-launcher redirect to clipplayer. `slug` is a route segment.
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
    slug: 'clipplayer',
    title: 'Clip Player',
    blurb:
      'The complete illustrated workflow: notes, recorded audio, automation, scenes, song and arrangement, routing, recovery and monome maps.',
  },
  {
    slug: 'launchpadControlLeft',
    title: 'Launchpad control (clip launcher)',
    blurb:
      'One or two Launchpad Mini Mk3 units: connection, mode maps, note and audio recording, automation, modifiers and LEDs.',
  },
  {
    slug: 'push2Control',
    title: 'Push 2 control (clip launcher)',
    blurb:
      'Push 2 connection, physical maps, pad modes, audio recording, display, LEGEND and parameter encoders.',
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

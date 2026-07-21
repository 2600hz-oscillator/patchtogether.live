// packages/web/src/lib/ui/rack-sizing.test.ts
//
// Invariants for the 1u/3u rack sizing system. Data-level here (every declared
// def is well-formed + the CSS token relationship is 3u = 3×1u); the rendered
// "all 1u cards share one height / all 3u share another" check rides VRT.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Side-effect barrels so the registries populate.
import '$lib/audio/modules';
import '$lib/video/modules';
import '$lib/meta/modules';

import { listModuleDefs } from '$lib/audio/module-registry';
import { listVideoModuleDefs } from '$lib/video/module-registry';
import { listMetaModuleDefs } from '$lib/meta/module-registry';

import { RACK_SIZE_DEFAULTS } from './rack-sizes';

// CADILLAC is a meta module drawn as a full-canvas overlay (CadillacOverlay),
// never a SvelteFlow card — so it has no card box to tier (same exclusion the
// modules-card-map guard uses).
const NO_CARD_BY_DESIGN = new Set(['cadillac']);

// DYNAMIC containers — they grow to fit their content, so they must NOT be
// forced to a fixed 1u/3u tier (doing so clips them):
//   group          — grows to fit its child modules (broke the group-geometry e2e)
//   sticky         — free-form resizable note
//   controlSurface — grows to fit its proxied controls (the "card grows so ALL
//                    groups + knobs render within bounds" control-surface e2e)
//   matrixMix      — the EMS/Buchla patchbay: a both-axes-scrollable grid card
//                    (`.matrixmix-card` root, deliberately outside the rack
//                    `:is()` sizing list) that can exceed 3u; never tiered.
//
// USER-RESIZABLE cards — each carries a corner-resize handle (card-resize.ts)
// and is sized by the user's drag, SNAPPED to whole-u tiles, NOT a fixed tier.
// Forcing them to a fixed tier via the rack CSS max-height/max-width would CAP
// the resize so the card couldn't grow (#759 — the bentbox resize e2e). Their
// DEFAULT/MIN size constants (in each *Card.svelte) are rounded to 180-multiples
// so they still land on the rack grid out of the box.
//   clockedRunner, livecode, wavesculpt, b3ntb0x, bentbox,
//   monoglitch, reshaper, ruttetra, toybox, videobox, videoOut, backdraft,
//   archivist
// All are excluded from the size-coverage requirement + the rack CSS.
// NOTE: backdraft was briefly a FIXED 3u/hp4 tier (#767 — 2-col preview-left/
// controls-right). When it gained FULL OUTPUT CAPABILITIES (corner-resize +
// full-frame/fullscreen/present, mirroring videoOut/bentbox) it was re-made
// corner-resizable (DEFAULT 720×540, MIN 540×360 — all 180-multiples) so a
// fixed tier would now CAP its resize. It therefore moved back here and OUT of
// RACK_SIZE_DEFAULTS.
// archivist — same user-resizable family as videobox/videoOut: a corner-resize
// handle (card-resize.ts) drives its size, with DEFAULT/MIN constants rounded to
// 180-multiples (360/540/360/360), so a fixed tier would CAP its resize.
const DYNAMIC_SIZED = new Set([
  'group', 'sticky', 'controlSurface', 'matrixMix',
  // user-resizable, sized by resize-snap-to-u not a fixed tier:
  'clockedRunner', 'livecode', 'wavesculpt', 'b3ntb0x', 'bentbox',
  'monoglitch', 'reshaper', 'ruttetra', 'toybox', 'videobox', 'videoOut',
  // backdraft — corner-resizable since it gained full output capabilities
  // (resize + full-frame/fullscreen/present, mirroring videoOut/bentbox);
  // DEFAULT/MIN constants are 180-multiples (720/540/540/360) so a fixed tier
  // would CAP its resize.
  'backdraft',
  // tvLibrarian — live HLS source card with a country picker + channel list;
  // corner-resizable like videobox (default 360×540, snaps to whole-u), so it
  // takes no fixed tier (forcing one would cap the resize / clip the list).
  'tvLibrarian',
  'archivist',
  // peertube — same user-resizable source family as videobox/tvLibrarian/
  // archivist: a corner-resize handle (card-resize.ts) drives its size, with
  // DEFAULT/MIN constants rounded to 180-multiples (360/540/360/360), so a
  // fixed tier would CAP its resize / clip the federated results list.
  'peertube',
  // milkdrop — butterchurn visualizer with a live preview screen + hide-controls
  // resizable monitor (corner-resize via card-resize.ts, same family as
  // ruttetra/videoOut), so it is dynamically sized, not a fixed tier.
  'milkdrop',
]);

interface SizedDef {
  type: string;
  size?: string; // `${N}u` — 1u/3u common, taller exact tiers (4u/5u…) for giants
  hp?: number;
}

/** A rack size is an exact whole-tile tier: `${N}u` with N a positive integer. */
const RACK_SIZE_RE = /^[1-9]\d*u$/;

function allDefs(): SizedDef[] {
  return [
    ...listModuleDefs(),
    ...listVideoModuleDefs(),
    ...listMetaModuleDefs(),
  ] as unknown as SizedDef[];
}

describe('rack sizing — declaration invariants', () => {
  it('every declared size is an exact whole-tile tier (`${N}u`)', () => {
    for (const d of allDefs()) {
      if (d.size !== undefined) {
        expect(RACK_SIZE_RE.test(d.size), `${d.type} size "${d.size}" must be \`\${N}u\``).toBe(true);
      }
    }
  });

  it('every declared hp is a positive integer (width in 1u tiles)', () => {
    for (const d of allDefs()) {
      if (d.hp !== undefined) {
        expect(Number.isInteger(d.hp), `${d.type} hp must be an integer`).toBe(true);
        expect(d.hp, `${d.type} hp must be >= 1`).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('a module that declares hp also declares a size tier', () => {
    for (const d of allDefs()) {
      if (d.hp !== undefined) {
        expect(d.size, `${d.type} declares hp but no size`).toBeDefined();
      }
    }
  });

  it('sample: stereovca = 1u/hp1 (the 1u reference); sequencer = 3u tall', () => {
    const by = Object.fromEntries(allDefs().map((d) => [d.type, d]));
    expect(by.stereovca?.size).toBe('1u');
    expect(by.stereovca?.hp).toBe(1);
    expect(by.sequencer?.size).toBe('3u');
  });
});

describe('rack sizing — bulk classification coverage (RACK_SIZE_DEFAULTS)', () => {
  // Resolution mirrors Canvas.svelte rackSizeByType: the def's own size/hp WIN;
  // the RACK_SIZE_DEFAULTS map is the fallback. After this PR every card-bearing
  // module must resolve to a size so it snaps to the rack grid.
  function resolveSize(d: SizedDef) {
    return d.size ?? RACK_SIZE_DEFAULTS[d.type]?.size;
  }
  function resolveHp(d: SizedDef) {
    return d.hp ?? RACK_SIZE_DEFAULTS[d.type]?.hp;
  }

  const cardModules = allDefs().filter(
    (d) => !NO_CARD_BY_DESIGN.has(d.type) && !DYNAMIC_SIZED.has(d.type),
  );

  it('every registered module (with a card) resolves to a size tier', () => {
    const unclassified = cardModules.filter((d) => resolveSize(d) === undefined).map((d) => d.type);
    expect(
      unclassified,
      `modules with no rack size (declare size on the def OR add to RACK_SIZE_DEFAULTS): ${unclassified.join(', ')}`,
    ).toEqual([]);
  });

  it('every registered module (with a card) resolves to a positive-integer hp', () => {
    for (const d of cardModules) {
      const hp = resolveHp(d);
      expect(hp, `${d.type} resolves no hp`).toBeDefined();
      expect(Number.isInteger(hp), `${d.type} hp must be an integer`).toBe(true);
      expect(hp as number, `${d.type} hp must be >= 1`).toBeGreaterThanOrEqual(1);
    }
  });

  it('every RACK_SIZE_DEFAULTS entry is itself well-formed (`${N}u` + integer hp >= 1)', () => {
    for (const [type, v] of Object.entries(RACK_SIZE_DEFAULTS)) {
      expect(RACK_SIZE_RE.test(v.size), `${type} map size "${v.size}" must be \`\${N}u\``).toBe(true);
      expect(Number.isInteger(v.hp), `${type} map hp must be an integer`).toBe(true);
      expect(v.hp, `${type} map hp must be >= 1`).toBeGreaterThanOrEqual(1);
    }
  });

  it('the map has no stale entries (every key is a registered card-bearing module)', () => {
    const registered = new Set(cardModules.map((d) => d.type));
    const stale = Object.keys(RACK_SIZE_DEFAULTS).filter((t) => !registered.has(t));
    expect(stale, `RACK_SIZE_DEFAULTS keys not matching a registered module: ${stale.join(', ')}`).toEqual([]);
  });

  it('respects the user-LOCKED per-module tier overrides (DECISIONS §2)', () => {
    // resolveSize must yield exactly these for the explicitly-called modules,
    // whether the tier comes from the def or the map.
    const LOCKED: Record<string, '1u' | '2u' | '3u'> = {
      // adsr bumped 1u→2u: the env ScopeScreen glyph raised natural height to
      // 209px, over the 180px 1u tile (owner-approved look → tier grows to fit).
      adsr: '2u', filter: '1u', sequencer: '3u', mixer: '1u', scope: '3u',
      midiLane: '3u', analogVco: '3u', resofilter: '1u',
      drummergirl: '1u', charlottesEchos: '1u', audioOut: '1u',
      scoreboard: '1u', cameraInput: '3u', timelorde: '3u',
    };
    const by = Object.fromEntries(allDefs().map((d) => [d.type, d]));
    for (const [type, tier] of Object.entries(LOCKED)) {
      const d = by[type];
      expect(d, `${type} not registered`).toBeDefined();
      expect(resolveSize(d as SizedDef), `${type} locked tier`).toBe(tier);
    }
  });
});

describe('rack sizing — CSS token relationship (height = exact N × 1u)', () => {
  it('_module-card.css pins the rack box to exact whole tiles via --rack-u/--rack-hp', () => {
    const css = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), 'modules', '_module-card.css'),
      'utf8',
    );
    expect(css).toMatch(/--rack-unit:\s*\d+px/);
    // Height is an EXACT multiple of the tile (N×--rack-unit) — pinned on
    // height + min-height + max-height so the box is pixel-perfect, never
    // a fractional / in-between size.
    expect(css).toMatch(/height:\s*calc\(var\(--rack-u,\s*1\)\s*\*\s*var\(--rack-unit\)\)/s);
    expect(css).toMatch(/min-height:\s*calc\(var\(--rack-u/s);
    expect(css).toMatch(/max-height:\s*calc\(var\(--rack-u/s);
    // Width is hp tiles.
    expect(css).toMatch(/width:\s*calc\(var\(--rack-hp,\s*1\)\s*\*\s*var\(--rack-unit\)\)/s);
  });
});

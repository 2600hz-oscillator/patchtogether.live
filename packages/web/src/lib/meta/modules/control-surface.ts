// packages/web/src/lib/meta/modules/control-surface.ts
//
// CONTROL SURFACE — an abstract control panel. Instantiate it and it starts
// as a small blank square. Right-click any MIDI-assignable knob/fader on any
// module and choose "Send to <surface>" — a POINTER to that control appears
// on the surface, grouped (dotted border + label) under its source module.
// Controls from collapsed groups keep working because the pointer drives the
// source node's live param directly. A lock/unlock toggle freezes or frees
// the grouped boxes for rearranging (the surface is a mini-graph of itself).
//
// CONTROL COLOUR (passthrough): each proxied knob shows a thin COLOUR STRIPE
// above it = the SOURCE module's "control colour" (right-click a module →
// "Assign control color"; unassigned modules get a stable auto colour). The
// colour identifies the source at a glance, so the SAME control shows the SAME
// colour everywhere it appears. The surface NEVER stores the colour — it reads
// the source module's current colour live (passthrough), the same way it reads
// the source param's live value. See $lib/graph/control-color.ts.
//
// Meta domain: no engine binding, no ports, no params. All state lives on
// node.data (see $lib/graph/control-surface.ts).
//
// Inputs: none. Outputs: none. Params: none.

import type { MetaModuleDef } from '$lib/meta/module-registry';

export const controlSurfaceDef: MetaModuleDef = {
  type: 'controlSurface',
  palette: { top: 'Hybrid', sub: 'Hybrid' },
  domain: 'meta',
  label: 'control surface',
  category: 'tools',
  inputs: [],
  outputs: [],
  params: [],

  // ── THE LOCK, DECLARED AS A ONE-MEMBER FAMILY ─────────────────────────────
  //
  // electraControl's route, and for a meta def it is the ONLY route: `params`
  // is empty by construction (no engine, no ports), so every key `face.order`
  // can ever hold is a NON-param key, and module-face-lint legitimizes one
  // exactly two ways — a `<familyId>-{n}` template whose prefix is a family
  // DECLARED here, or an entry in a committed `<type>.legend.json`, of which
  // none is this module's. Without this the face could rank NOTHING; `order:
  // []` is legal and paints a BLANK TILE, which is worse than the legacy card
  // it replaces — the matrixMix lesson.
  //
  // ⚠ WHY THE LOCK IS THE ONE RANKED CELL, and not a concession. The old
  // migration entry said this module "has no params of its own to rank" — the
  // clause was measured false: `node.data.locked` is one node-data-backed
  // control of this module's OWN (it freezes/frees the group boxes for
  // rearranging), and a `ShellToggleCell` over node.data is exactly the shape
  // the registry defines for it. Everything else on the surface is a proxy of
  // ANOTHER module's param, which no `face.order` key can address at all —
  // the electraControl addressability argument, verbatim — so the proxies are
  // a `control-grid` body and the lock is the face.
  //
  // The `testidPrefix` is a literal the LEGACY BUTTON already emits
  // (`ControlSurfaceCard.svelte`, `data-testid="control-surface-lock"`), which
  // is what module-docs-lint's card grep checks — so a rename on either
  // surface is RED. The card survives promotion: `?shell=legacy` still renders
  // it, and `control-surface.spec.ts` still drives it there.
  controlFamilies: [
    {
      id: 'control-surface-lock',
      label: 'Lock',
      kind: 'other',
      testidPrefix: 'control-surface-lock',
    },
  ],

  // ── THE FACE ──────────────────────────────────────────────────────────────
  //
  // WHAT IT IS FOR: a free-form panel of POINTERS to other modules' controls.
  // You fill it by right-clicking any MIDI-assignable knob anywhere in the rack
  // ("Send to <this surface>"); a filled slot is a live proxy driving the
  // SOURCE node's param, grouped under its source module with that source's
  // control colour as a passthrough stripe. The verb a player performs is LAY
  // OUT YOUR HANDS: you are deciding what you will reach for mid-performance.
  //
  // THE LADDER, read back as a sentence: at every lane tier you get the LOCK
  // (the module's one own control) and the tile\'s live strip of bound-source
  // colours; one Expand away you get the board itself — every group box, every
  // proxied knob, the per-knob rename and the drag layout.
  //
  // ⚠ THE LANE-TIER CHANGE IS OWNER-APPROVED (2026-08-31, owner-decisions item
  // 10): the free-growing inline panel (360–760 px) becomes a 192×180 tile
  // plus one Expand click, on the electraControl / semantic-zoom precedent.
  // The owner previews the COMPACT tier before merge.
  //
  // ⚠ `glyph: 'none'` IS THE ONLY LITERAL THAT COMPILES INTO A GREEN RUN, and
  // the premise is true by inspection: `outputs` is EMPTY, so
  // `primaryAudioOutPortId` resolves null and every live-audio binding
  // short-circuits; 'envelope' needs a/d/s/r params and there are none. Each
  // falls to `{kind:'static'}`, which module-face-lint reddens by name (#1692).
  // 'algorithm' would resolve — it accepts a `face.extension` — but
  // `ShellExtensionGlyphProps` carries no nodeId, so every instance would draw
  // the same picture while the only useful glance here ("what is bound") is
  // per-node state. The tile's per-node glance is the `tileBody` strip instead.
  //
  // ⚠ NO `pages`. One ranked cell is one band; `DOCK_TAB_MIN_BANDS` is 7 and
  // nothing here is padded toward a rail.
  //
  // ⚠ NO `rear` GROUPS: `inputs` and `outputs` are both empty, so there is no
  // jack for a group to name and module-face-lint refuses a group that
  // resolves to no port at all.
  //
  // The group boxes, proxied knobs, colour stripes, per-knob rename, drag
  // layout and empty-state prompt are the extension's `fullViewBody`; the
  // live source-colour strip and the dangling-binding prune are its
  // `tileBody`. See $lib/ui/modules/controlSurface/shell-extension.ts.
  face: {
    glyph: 'none',
    order: ['control-surface-lock-{n}'],
    extension: 'controlSurface',
  },
};

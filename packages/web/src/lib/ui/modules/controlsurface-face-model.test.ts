// packages/web/src/lib/ui/modules/controlsurface-face-model.test.ts
//
// THE CONTROL SURFACE FACE — its model, and the legs that are NOT vacuous on it.
//
// ⚠ READ THIS FIRST: THE SHARED FACE GATES ARE STRUCTURALLY VACUOUS ON THIS
// MODULE, exactly as they are on electraControl one file over. `module-face-
// lint`'s COMPLETENESS pass loops `def.params`, which is `[]` by construction
// (meta domain); `faces-parity`'s exact-multiset assertion compares the dock's
// `control-*` testids against the def's param ids — empty on both sides ONLY
// while nothing is bound, which is the only state the sweep ever builds. So the
// gates that actually carry this face are: `face-rack-status-source` (the
// body's declared role), the ranked LOCK cell driven by the parity sweep's
// toggle leg, the default-shell e2e (`controlsurface-face.spec.ts`), and THIS
// FILE — which pins the things a def-reading gate cannot see.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import '$lib/meta/modules'; // side-effect: register meta module defs
import { controlSurfaceDef } from '$lib/meta/modules/control-surface';
import { CONTROL_SURFACE_TYPE } from '$lib/graph/control-surface';
import { curatedFace, laneOrder, type FaceDefLike } from '$lib/ui/workflow/curated-face';
import { STRICT_FACES, migrated } from '$lib/ui/workflow/strict-faces';
import { NON_SHELL_LANE_TYPES, laneRenderKind, dockRailRendersFace } from '$lib/ui/workflow/legacy-fallback';
import { shellCellFor } from '$lib/ui/workflow/shell-cells';

const DEF = controlSurfaceDef as unknown as FaceDefLike;
/** Every LANE tier — the dock is not one, and is asserted separately. */
const LANE_TIERS = ['mini', 'compact', 'full'] as const;

const HERE = dirname(fileURLToPath(import.meta.url));
const BODY = resolve(HERE, 'controlSurface', 'ControlSurfaceBoardBody.svelte');
const TILE = resolve(HERE, 'controlSurface', 'ControlSurfaceTileBody.svelte');
const body = () => readFileSync(BODY, 'utf8');
const tile = () => readFileSync(TILE, 'utf8');

describe('controlSurface face — the promotion', () => {
  it('declares a face and is in STRICT_FACES', () => {
    expect(controlSurfaceDef.face, 'the def declares a face').toBeTruthy();
    expect(STRICT_FACES.has(CONTROL_SURFACE_TYPE)).toBe(true);
    expect(migrated(CONTROL_SURFACE_TYPE)).toBe(true);
  });

  // ⚠ THE PRECONDITION, ASSERTED. `NON_SHELL_LANE_TYPES` short-circuits
  // `laneRenderKind` BEFORE `migrated` is read, so membership and promotion are
  // mutually exclusive by construction. Both directions, so re-adding the entry
  // is RED — and this is also the pin on the OWNER-APPROVED lane-tier change
  // (2026-08-31, owner-decisions item 10): the free-growing inline card becomes
  // a 192x180 tile plus one Expand for every saved patch at once.
  it('is NOT in NON_SHELL_LANE_TYPES — the carve-out and the promotion cannot coexist', () => {
    expect(NON_SHELL_LANE_TYPES.has(CONTROL_SURFACE_TYPE)).toBe(false);
    expect(
      laneRenderKind({
        shellFaces: true,
        userDocked: false,
        type: CONTROL_SURFACE_TYPE,
        hasCard: true,
        migrated: true,
      }),
      'the lane renders the shell, not the verbatim card',
    ).toBe('shell');
  });

  // ⚠ THE NEGATIVE CONTROL: the rule still honours a carve-out for a type that
  // keeps one, so "the entry is gone" and "the rule stopped consulting the set"
  // cannot look alike.
  // (⚠ The subject has now moved twice: it was `controlSurface`, whose own
  // promotion drained that membership on 2026-09-01, then `clipplayer`, whose
  // promotion drained the set of its LAST MODULE CARD. It re-points at `sticky`
  // — organizational chrome, which is what `NON_SHELL_LANE_TYPES` now holds
  // exclusively, and which no face programme can promote away. That makes this
  // the last re-point the control can ever need.)
  it('the rule still honours a carve-out for the types that keep one', () => {
    expect(
      laneRenderKind({
        shellFaces: true,
        userDocked: false,
        type: 'sticky',
        hasCard: false,
        migrated: false,
      }),
    ).toBe('legacy');
    expect(NON_SHELL_LANE_TYPES.has('sticky'), 'a real member remains').toBe(true);
  });

  // ⚠ THE USER-DOCKED RESIDUAL, PINNED rather than discovered in review:
  // controlSurface is NOT a pinned singleton, so `dockRailRendersFace` is false
  // for it and a user-docked node's rail occupant stays the VERBATIM legacy
  // card — which carries its own prune `$effect` and its own lock button, so no
  // reachable surface is prune-less or lock-less.
  it('a user-docked node keeps the legacy card in the dock rail (not pinned)', () => {
    expect(dockRailRendersFace({ shellFaces: true, pinned: false, migrated: migrated(CONTROL_SURFACE_TYPE) })).toBe(false);
    // …and the `?shell=legacy` escape hatch still gets the verbatim card, which
    // is what keeps `control-surface.spec.ts` meaningful rather than merely
    // passing.
    expect(
      laneRenderKind({
        shellFaces: false,
        userDocked: false,
        type: CONTROL_SURFACE_TYPE,
        hasCard: true,
        migrated: true,
      }),
    ).toBe('legacy');
  });
});

describe('controlSurface face — the ONE ranked cell', () => {
  const KEY = 'control-surface-lock-{n}';

  it('ranks exactly the declared family, and the family is declared', () => {
    expect(controlSurfaceDef.face!.order).toEqual([KEY]);
    expect(controlSurfaceDef.controlFamilies?.map((f) => f.id)).toEqual(['control-surface-lock']);
  });

  // ⚠ `order: []` WOULD HAVE BEEN LEGAL AND WOULD HAVE PAINTED A BLANK TILE —
  // the matrixMix lesson. A meta def has `params: []`, so a family is the ONLY
  // thing that can be ranked; this leg is what stops a future edit quietly
  // emptying the face.
  it('the ranked key RESOLVES to a live toggle cell — not an inert one', () => {
    const cell = shellCellFor(CONTROL_SURFACE_TYPE, { kind: 'family', key: KEY } as never);
    expect(cell, 'the ranked key resolves a cell').toBeTruthy();
    expect(cell!.kind).toBe('toggle');
    expect(controlSurfaceDef.face!.order.length, 'a face that ranks nothing is a blank tile').toBeGreaterThan(0);
  });

  // #1974's refusal shape: a face that RANKS controls and RENDERS ZERO of them
  // is green on every "does the face resolve" gate. The one ranked key must
  // survive to every lane tier.
  it('the LOCK cell is PRESENT at EVERY lane tier', () => {
    for (const tier of LANE_TIERS) {
      const face = curatedFace(DEF, tier);
      expect(face, `lane tier '${tier}': the face resolves`).not.toBeNull();
      expect(
        face!.controls.map((c) => c.key),
        `lane tier '${tier}': the module's one own control must reach the tile`,
      ).toEqual([KEY]);
    }
    expect(laneOrder(controlSurfaceDef.face!)).toEqual([KEY]);
  });

  it('has no pages, no rear groups, and a glyph of none', () => {
    // One ranked cell is one band; a header over it would say the same word
    // twice. `inputs`/`outputs` are empty, so a rear group would resolve to no
    // port and module-face-lint refuses that — and the same emptiness is what
    // FORCES `glyph: 'none'` (no audio output ⇒ every live literal is a dead
    // static, which the lint reddens by name).
    expect(controlSurfaceDef.face!.pages).toBeUndefined();
    expect(controlSurfaceDef.face!.rear).toBeUndefined();
    expect(controlSurfaceDef.face!.glyph).toBe('none');
    expect(controlSurfaceDef.inputs).toEqual([]);
    expect(controlSurfaceDef.outputs).toEqual([]);
    expect(controlSurfaceDef.params).toEqual([]);
  });

  // The def is the ONE place the testid lives; module-docs-lint asserts the
  // prefix appears in real UI source (the legacy card's lock button emits it),
  // so a rename on either surface is red.
  it('the family testidPrefix is the literal the card lock button emits', () => {
    expect(controlSurfaceDef.controlFamilies![0]!.testidPrefix).toBe('control-surface-lock');
  });
});

describe('controlSurface tileBody — the prune, on the surface that outlives the dock', () => {
  // ⚠ THE STOP-2 OF THIS PROMOTION. `pruneSurfaceDangling` had exactly ONE
  // production caller in the tree — the legacy card's `$effect` — and
  // controlSurface is in neither half of `HEADLESS_MOUNT_LANE_TYPES`, so a
  // promotion that only built the board would have stopped it silently with
  // every registry test green (a dangling binding lingers in node.data and the
  // next Electra flash emits a dead control — the ES-9 shape). It rides the
  // TILE because the tile mounts whenever the node is on canvas; the dock body
  // exists only while a human has the full view open.
  it('the tile calls pruneSurfaceDangling on every ydoc tick', () => {
    const src = tile();
    expect(src, 'the prune is imported').toMatch(/pruneSurfaceDangling/);
    expect(
      src.replace(/\s+/g, ' '),
      'the prune runs inside an $effect keyed on the version pump, not once at mount',
    ).toMatch(/\$effect\(\(\) => \{ void tileVersion; pruneSurfaceDangling\(nodeId\); \}\)/);
  });

  // …and the BODY deliberately does not carry a second copy: two surfaces
  // pruning the same array on the same tick is a write-race for no coverage.
  it('the dock body does NOT carry a duplicate prune', () => {
    expect(body()).not.toMatch(/pruneSurfaceDangling/);
  });

  // The strip's marks are SVG rects — the electraControl ink-sweep decision:
  // the dock width gate derives "content" from svg/canvas/img boxes and text
  // ranges, and a CSS-background div is invisible to it.
  it('the strip draws SVG swatches and carries a derived accessible name', () => {
    const src = tile();
    expect(src).toMatch(/<svg/);
    expect(src).toMatch(/aria-label=/);
    // …and no drawing surface: a canvas would enrol a meta module in the GPU
    // attest (membership is derived from content).
    expect(src).not.toMatch(new RegExp('<' + 'canvas'));
  });
});

describe('controlSurface board body — what a source gate cannot see', () => {
  // ⚠ THE MULTISET TRAP, in BOTH directions. Every proxied Knob must pass an
  // explicit `testid` (Knob.svelte emits `control-<paramId>` otherwise, and
  // faces-parity asserts exact multiset equality against `params: []`), and NO
  // testid in either extension file may start with `control-` — which is also
  // why the card's `control-surface-*` vocabulary is not reused here.
  it('every proxied Knob passes an explicit testid override', () => {
    const src = body();
    expect(src).toMatch(/testid=\{`cs-board-dial-\$\{g\.moduleId\}-\$\{c\.paramId\}`\}/);
    // The MIDI-learn key stays — dropping paramId would silently delete MIDI
    // Learn from every proxy, the trap the testid prop exists to avoid.
    expect(src).toMatch(/paramId=\{c\.paramId\}/);
  });

  it('no testid in either extension file starts with control-', () => {
    for (const src of [body(), tile()]) {
      // RENDERED MARKUP ONLY — the documentation above spells the banned form
      // out in words, and an instrument that cannot tell code from a comment
      // would report this file emitting the testid it exists to refuse.
      const markup = src
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '');
      const ids = [...markup.matchAll(/data-testid=\{?[`"']([^`"'$]+)/g)].map((m) => m[1]!);
      expect(ids.length, 'the scan found testids').toBeGreaterThan(0);
      expect(ids.filter((id) => id.startsWith('control-'))).toEqual([]);
    }
  });

  // ⚠ THE VERSION PUMP. `ModuleShell` re-projects a cell on `nodeVersion(id)`
  // alone; this board also depends on every bound SOURCE's subtree (live
  // values, renames, control colours) and on node add/remove. A body that
  // omitted the pump renders a board that never notices a source rename — and
  // a node.data-level unit test passes on it.
  it('the body reproduces the card version pump over bound sources', () => {
    const src = body().replace(/\s+/g, ' ');
    expect(src).toMatch(/nodeVersion\(nodeId\) \+ nodesStructuralVersion\(\)/);
    expect(src).toMatch(/v \+= nodeVersion\(b\.moduleId\)/);
  });

  // ⚠ THE SHIPPED CRASH CLASS: the graph module's mutators write IN PLACE
  // inside one transact ("Type already integrated" is shipped history). The
  // body writes through them and never spreads a live Yjs array.
  it('all writes go through the shared in-place mutators', () => {
    const src = body();
    expect(src).toMatch(/setSurfaceGroupPosition\(nodeId, drag\.moduleId, nx, ny\)/);
    expect(src).toMatch(/setBindingName\(nodeId, editing\.moduleId, editing\.paramId, editValue\)/);
    expect(src, 'no spread of the live bindings array').not.toMatch(/\.\.\.\s*(surfaceData\.bindings|data\.bindings)/);
  });

  // The rename `<input type="text">` is INLINE in the file directly imported as
  // `fullViewBody` — the typed-entry parity resolver reads ONLY that one file,
  // so factoring it into a child component would read as a typed-entry
  // affordance lost in promotion.
  it('the typed rename field is inline in the fullViewBody file', () => {
    expect(body()).toMatch(/<input[^>]*type="text"/);
  });

  // The `control-grid` role's predicate, asserted here too: accessible names,
  // no drawing surface (a drawn body would enrol a meta module in the GPU
  // attest — membership is derived from content).
  it('mounts no drawing surface, and carries the accessible names the role requires', () => {
    const src = body();
    expect(src).not.toMatch(new RegExp('<' + 'canvas'));
    expect(src).toMatch(/aria-label=/);
  });

  // ⚠ THE RESTING-TEXT RULING at the one place a source gate is blind: the
  // board's painted text is exhaustively the group labels, each knob's caption
  // (a `label` PROP consumed by Knob.svelte), the knob-label row, the ✎
  // affordance and the empty-state instruction. This leg denies the shape that
  // would creep back — a bare derived-value mustache.
  it('paints no derived value: the only text mustaches are names and captions', () => {
    const src = body();
    const markup = src.slice(src.indexOf('</script>')).split('<style>')[0]!;
    expect(markup, 'the slice found a template').toMatch(/cs-board/);
    const mustaches = [...markup.matchAll(/>\s*\{([^}]+)\}/g)]
      .map((m) => m[1]!.trim())
      .filter((e) => !/^[#/:@]/.test(e));
    expect(mustaches.sort()).toEqual(['c.label', 'g.label'].sort());
  });
});

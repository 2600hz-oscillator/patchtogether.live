// packages/web/src/lib/ui/workflow/legacy-fallback.test.ts
//
// The legacy-fallback bridge — pure derivation gate. Proves:
//   - `?shell=legacy` (shellFaces false) → every non-docked node renders its
//     verbatim module card;
//   - the user-dock swap still wins (unchanged P2.5a contract);
//   - the DEFAULT (shellFaces true): un-migrated → placeholder, migrated → shell;
//   - the emitted node-type mapping + the swap-eligibility rule.

import { describe, it, expect } from 'vitest';
import {
  laneRenderKind,
  emittedTypeFor,
  isShellSwappable,
  dockRailRendersFace,
  NON_SHELL_LANE_TYPES,
  type LaneRenderInput,
  type DockRailRenderInput,
} from './legacy-fallback';
import { migrated } from './strict-faces';
import { WORKFLOW_PINNED_MODULES } from '$lib/graph/workflow-pins';

// Registry side-effect imports + resolvers, for the ANCHORING GATE below.
// legacy-fallback.ts itself is deliberately registry-free; the anchoring
// lives HERE so a bare string in the carve-out set cannot silently name
// nothing (#1579 — 'launchpadControl' matched no def, the carve-out never
// fired, and the pad-mapping surface rendered as a placeholder tile).
import '$lib/audio/modules';
import '$lib/video/modules';
import '$lib/meta/modules';
import { getModuleDef } from '$lib/audio/module-registry';
import { getVideoModuleDef } from '$lib/video/module-registry';
import { getMetaModuleDef } from '$lib/meta/module-registry';
import { LAUNCHPAD_CONTROL_TYPE } from '$lib/meta/modules/launchpad-control';
import type { ModuleType } from '$lib/graph/types';

/** A fully-swappable, faces-on (default), un-migrated baseline. */
const base: LaneRenderInput = {
  shellFaces: true,
  userDocked: false,
  type: 'tidyvco',
  hasCard: true,
  migrated: false,
};

describe('laneRenderKind — the pure bridge decision', () => {
  it('user-docked ALWAYS wins → stub (faces on or off, migrated or not)', () => {
    for (const shellFaces of [true, false]) {
      for (const migrated of [true, false]) {
        expect(laneRenderKind({ ...base, userDocked: true, shellFaces, migrated })).toBe('stub');
      }
    }
  });

  it('?shell=legacy → legacy for every non-docked node', () => {
    expect(laneRenderKind({ ...base, shellFaces: false })).toBe('legacy');
    // even a migrated type renders its legacy card under the escape hatch
    expect(laneRenderKind({ ...base, shellFaces: false, migrated: true })).toBe('legacy');
  });

  it('DEFAULT + un-migrated + swappable → placeholder', () => {
    expect(laneRenderKind(base)).toBe('placeholder');
  });

  it('DEFAULT + migrated + swappable → shell', () => {
    expect(laneRenderKind({ ...base, migrated: true })).toBe('shell');
  });

  it('a non-card / snowflake type stays legacy even by default', () => {
    expect(laneRenderKind({ ...base, hasCard: false })).toBe('legacy');
    expect(laneRenderKind({ ...base, hasCard: false, migrated: true })).toBe('legacy');
  });
});

describe('emittedTypeFor — kind → xyflow node type', () => {
  it('maps each kind to its node type; legacy emits the module type', () => {
    expect(emittedTypeFor('stub', 'tidyvco')).toBe('dockStub');
    expect(emittedTypeFor('shell', 'tidyvco')).toBe('moduleShell');
    expect(emittedTypeFor('placeholder', 'tidyvco')).toBe('moduleShellPlaceholder');
    expect(emittedTypeFor('legacy', 'tidyvco')).toBe('tidyvco');
  });

  it('the full pipeline: ?shell=legacy round-trips to the legacy type', () => {
    const kind = laneRenderKind({ ...base, shellFaces: false });
    expect(emittedTypeFor(kind, base.type)).toBe(base.type);
  });
});

describe('isShellSwappable — eligibility', () => {
  it('requires a resolvable card', () => {
    expect(isShellSwappable('tidyvco', true)).toBe(true);
    expect(isShellSwappable('tidyvco', false)).toBe(false);
  });

  it('excludes the organizational / snowflake types', () => {
    for (const t of NON_SHELL_LANE_TYPES) {
      expect(isShellSwappable(t, true)).toBe(false);
    }
    // sanity: the excluded set is the organizational chrome we intend to hold
    // back. ⚠ THE SECOND LINE USED TO ASSERT `clipplayer` — the last MODULE
    // CARD this set ever held, and the one the "snowflake" clause it was built
    // around was actually true of. Its own promotion retired it (below), so the
    // sanity leg now names what the set has become: chrome and a sprite, no
    // module cards at all.
    expect(NON_SHELL_LANE_TYPES.has('group')).toBe(true);
    expect(NON_SHELL_LANE_TYPES.has('sticky')).toBe(true);
    expect(NON_SHELL_LANE_TYPES.has('tidyvco')).toBe(false);
  });

  it('clipplayer SWAPS now that it has a face — and the removal HAD to ride the promotion', () => {
    // ⚠ THIS IS THE SPLIT-BRAIN LEG, not a bookkeeping one. `laneRenderKind`
    // consults NON_SHELL_LANE_TYPES while `DockFullView` switches on bare
    // STRICT_FACES membership, so a clipplayer promoted while still listed here
    // would paint the verbatim legacy CARD on the canvas and the FACEPLATE in
    // the dock — two different instruments for one node. No other gate in the
    // repo reads both sides: `module-face-lint` reads the def and
    // `faces-parity` drives the dock. This assertion is the one that fails if
    // the entry ever comes back without the face going with it.
    expect(NON_SHELL_LANE_TYPES.has('clipplayer')).toBe(false);
    expect(isShellSwappable('clipplayer', true)).toBe(true);
  });

  it('videoOut SWAPS now that it has a face — the carve-out was about a PLACEHOLDER, not about the module', () => {
    // HISTORY, because the reversal is the point (the `es9` shape below). This
    // used to assert the opposite: the owner ?shell=1 regression was that
    // swapping videoOut for a PLACEHOLDER TILE removed the only user-viewable
    // video output, so it was held back on the verbatim legacy card.
    //
    // #1821 removes the cause rather than the symptom. videoOut carries a real
    // `face`, so the swap now lands on a `ModuleShell` painting the LIVE
    // `VideoTileThumb` — not a placeholder — and the big picture moved to
    // right-click → DETACH DISPLAY, which is what the owner asked for.
    //
    // ⚠ THE PICTURE'S SURVIVAL IS NOT ASSERTED HERE and cannot be: this module
    // is deliberately registry-free, so it cannot see a glyph plan. That leg
    // lives in `videoout-face-model.test.ts`, which asserts the tile resolves a
    // live video surface at every lane tier (the #1785 eviction).
    expect(NON_SHELL_LANE_TYPES.has('videoOut')).toBe(false);
    expect(isShellSwappable('videoOut', true)).toBe(true);
    expect(
      laneRenderKind({ ...base, type: 'videoOut', hasCard: isShellSwappable('videoOut', true), migrated: true }),
    ).toBe('shell');
    // …like the other video-domain modules, which have always swapped.
    expect(NON_SHELL_LANE_TYPES.has('recorderbox')).toBe(false);
    expect(NON_SHELL_LANE_TYPES.has('backdraft')).toBe(false);
  });

  it('cameraInput SWAPS now that it has a face — the two things that kept it out were answered, not waived', () => {
    // HISTORY, because the reversal is the point (the `videoOut` and `es9`
    // shapes above). This used to assert the opposite, on the owner ?shell=1
    // P0: the card owns getUserMedia + the <video> it hands to the engine
    // (attachExternalSource), AND the device <select> — neither is a ParamDef,
    // so a tile made camera → OUTPUT patched-but-black with no way to pick a
    // source.
    //
    // Both halves are now answered, and neither by waiving the requirement:
    //   * the SOURCE — <HeadlessSourceHost> keeps the real card mounted
    //     off-screen (cameraInput ∈ DOM_SOURCE_LANE_TYPES, and
    //     `needsHeadlessSourceMount` is true for kind 'shell'), and the <video>
    //     plus its MediaStream are node-owned, so the swap re-parents rather
    //     than tears down. That mechanism did not exist when the carve-out was
    //     written — which is precisely why it was written;
    //   * the PICKER — rebuilt in the faceplate's extension body, the one slot
    //     that can hold a control no ParamDef can express;
    //   * and the card's remaining GESTURES — "Request access" above all, the
    //     only route to getUserMedia for a first-time visitor — reached through
    //     $lib/ui/media/camera-status-registry, because an off-screen host is
    //     `pointer-events: none`. Keeping the source alive is NOT the same as
    //     keeping the acquire alive.
    //
    // ⚠ NONE OF THAT IS ASSERTED HERE and cannot be: this module is
    // deliberately registry-free. Those legs live in dom-source-modules.test.ts
    // (the host decision), camera-status-registry.test.ts (the seam) and
    // e2e/tests/camerainput-shell-source.spec.ts (that a frame actually
    // arrives through the whole chain).
    expect(NON_SHELL_LANE_TYPES.has('cameraInput')).toBe(false);
    expect(isShellSwappable('cameraInput', true)).toBe(true);
    expect(
      laneRenderKind({
        ...base,
        type: 'cameraInput',
        hasCard: isShellSwappable('cameraInput', true),
        migrated: true,
      }),
    ).toBe('shell');
  });

  it('es9 SWAPS like any other module — its connection no longer lives on the card', () => {
    // HISTORY, because the reversal is the point. Owner report 2026-08-05: under
    // ?mode=workflow&shell=1 the ES-9 stopped sending data whenever its card was
    // not expanded. Es9Card owned the native-bridge connection and disconnected
    // it in onDestroy, so the stream only lived while the card was mounted. The
    // first fix carved es9 OUT of the shell swap to keep the card permanently in
    // the lane — which bought "always mounted" by surrendering BOTH the compact
    // tile and the dock EXPAND affordance (owner, 2026-08-07: "i would like the
    // card to just work normally: show as compact on screen but still work,
    // expand to full view in dock").
    //
    // The carve-out is gone because its PREMISE is gone: ownership moved to the
    // ENGINE NODE ($lib/audio/es9/bridge-owner), so the connection's lifetime is
    // the node's, not a component's. Mount, unmount, dock, collapse and the
    // shell swap are all invisible to the hardware stream now. The single-client
    // 'busy' hazard that also ruled out the headless-host seam is likewise gone:
    // there is exactly ONE client per node and views merely subscribe.
    expect(NON_SHELL_LANE_TYPES.has('es9')).toBe(false);
    expect(isShellSwappable('es9', true)).toBe(true);
    // ⚠ THIS CLAUSE IS ABOUT THE PURE FUNCTION, NOT ABOUT es9 ANY MORE, and the
    // distinction had to be written down the day es9 was PROMOTED. The comment
    // here used to read "Un-migrated (no curated face yet) ⇒ the uniform
    // placeholder tile … That is the owner's requested shape" — and both halves
    // have expired. es9 declares a `face` and is in `STRICT_FACES`, so a real
    // rack renders `<ModuleShell>` with ranked cells (CONNECT first), and the
    // placeholder is what the promotion REPLACED rather than what the owner
    // asked for. The assertion survives only because `base` hard-codes
    // `migrated: false`: it says "given an un-migrated module with a card, the
    // lane is a placeholder", which is a statement about `laneRenderKind` and
    // stays true for every module that is genuinely un-migrated.
    //
    // Kept rather than deleted, because the OTHER two clauses in this test are
    // the ones with es9's name on them (`NON_SHELL_LANE_TYPES` membership and
    // the legacy render), and both are still exactly about es9. The live
    // promotion is asserted where it can actually be observed —
    // `es9-face-model.test.ts` runs the real tier selector, and
    // `es9-shell-lifetime.spec.ts` reads `moduleShell` off a rendered tile.
    expect(laneRenderKind({ ...base, type: 'es9', hasCard: isShellSwappable('es9', true) })).toBe(
      'placeholder',
    );
    // ?shell=legacy must still render the verbatim card — the carve-out
    // removal must not change the legacy render at all.
    expect(
      laneRenderKind({ ...base, shellFaces: false, type: 'es9', hasCard: true }),
    ).toBe('legacy');
  });
});

describe('NON_SHELL_LANE_TYPES is ANCHORED to the registry (#1579)', () => {
  // A bare Set<string> keyed on module types degrades SILENTLY: a stale or
  // misspelled id is just "this type is not carved out", and the module falls
  // through to a placeholder tile with nothing red anywhere. That is how
  // 'launchpadControl' (no def; the registered id is launchpadControlLeft)
  // sat in this list from the shell rollout until the #1510 inventory tripped
  // over it. Anchor to the ARTIFACT: every member must resolve to a def.
  const resolve = (t: string) =>
    getModuleDef(t as ModuleType) ??
    getVideoModuleDef(t as ModuleType) ??
    getMetaModuleDef(t as ModuleType);

  it('every member resolves to a registered def — a stale id is RED, not a silent no-op', () => {
    const unresolved = [...NON_SHELL_LANE_TYPES].filter((t) => !resolve(t));
    expect(
      unresolved,
      `carve-out entries that match NO registered def — each is a carve-out that silently ` +
        `never fires, which is exactly #1579. Fix the id (import the def's exported type ` +
        `constant into this test to pin it) or delete the entry.`,
    ).toEqual([]);
  });

  it("the launchpad entry IS the def's own exported type — re-typing cannot drift it again", () => {
    // The def deliberately keeps the Left-suffixed id so saved LEFT nodes load;
    // this pins the carve-out to that exported constant rather than to anyone's
    // memory of it.
    expect(LAUNCHPAD_CONTROL_TYPE).toBe('launchpadControlLeft');
    // ⚠ THIS USED TO BE `toBe(true)` — the module was carved out, and this leg
    // pinned the carve-out to the def's own exported constant so a re-typing
    // could not drift it again. It is now PROMOTED: it carries a `face`, it is
    // in STRICT_FACES, and the carve-out entry was deleted in the same commit
    // (see the lineage note in legacy-fallback.ts — the "grid / launcher /
    // mapper" clause was never true of this card, and the half that WAS true —
    // that a placeholder would be lossy — is discharged by the face carrying
    // all four gestures). Flipped rather than deleted, and flipped rather than
    // RE-POINTED AT ANOTHER MEMBER: this block exists because THIS id drifted,
    // so the honest form is the cameraInput lineage note
    // (dom-source-modules.test.ts, `expect(NON_SHELL_LANE_TYPES.has(
    // 'cameraInput')).toBe(false)` with the old assertion kept as a comment),
    // not a substitute subject.
    expect(NON_SHELL_LANE_TYPES.has(LAUNCHPAD_CONTROL_TYPE)).toBe(false);
    // ⚠ THIS LINE STAYS, AND IT IS THE HALF THAT GUARDS #1579's ACTUAL DEFECT
    // (a misspelled id that resolves to no def). It is independent of
    // membership: the unregistered spelling must be absent whether the real one
    // is present or not.
    expect(NON_SHELL_LANE_TYPES.has('launchpadControl'), 'the unregistered id must be GONE').toBe(false);
  });

  it('…and the gate is not vacuous: the resolver really can fail (permanent negative control)', () => {
    // Same predicate the gate uses, fed a name that must never register.
    expect(resolve('zz-not-a-registered-type')).toBeUndefined();
    // …and really can succeed on each domain the set draws from.
    expect(resolve('clipplayer')).toBeTruthy(); // audio
    expect(resolve('videoOut')).toBeTruthy(); // video
    expect(resolve('sticky')).toBeTruthy(); // meta
  });
});

describe('dockRailRendersFace — the pinned tray shows the PROMOTED face (#1739)', () => {
  // The OWNER RULING behind it: *"the `m` key tray view needs to show the new
  // card and not the old one"*. Before this the rule did not exist at all —
  // `DockCardHost` resolved `nodeTypes[type]` with no migration input, so the
  // one always-on surface in the app kept painting a legacy card after its
  // module was promoted.
  //
  // Three inputs, all REQUIRED, so the truth table is DERIVED rather than
  // hand-listed: exactly the all-true row may render the face.
  const FLAGS = ['shellFaces', 'pinned', 'migrated'] as const;

  it('the face renders IFF shellFaces AND pinned AND migrated — the whole truth table', () => {
    const rows: string[] = [];
    for (let mask = 0; mask < 1 << FLAGS.length; mask++) {
      const input = Object.fromEntries(
        FLAGS.map((f, i) => [f, (mask & (1 << i)) !== 0]),
      ) as unknown as DockRailRenderInput;
      const expected = FLAGS.every((f) => input[f]);
      rows.push(`${FLAGS.map((f) => `${f}=${input[f] ? 1 : 0}`).join(' ')} → ${dockRailRendersFace(input)}`);
      expect(dockRailRendersFace(input), rows[rows.length - 1]).toBe(expected);
    }
    // The gate is not vacuous in either direction: the table really contains
    // both answers.
    expect(rows.filter((r) => r.endsWith('true'))).toHaveLength(1);
    expect(rows.filter((r) => r.endsWith('false'))).toHaveLength((1 << FLAGS.length) - 1);
  });

  it('`?shell=legacy` keeps the tray on the LEGACY card — and that is why the three shipped drawer specs cannot see this change', () => {
    // `workflow-dock.spec.ts` (masterL out, ch1L in) and `workflow-mode.spec.ts`
    // ("the pinned card renders IN FULL") all drive `/rack?shell=legacy`. They
    // pass unchanged across the promotion — and would pass just as well if the
    // tray were completely broken on the default shell. The default-shell
    // coverage is `e2e/tests/workflow-drawer-face.spec.ts`.
    expect(dockRailRendersFace({ shellFaces: false, pinned: true, migrated: true })).toBe(false);
  });

  it('a USER-DOCKED promoted module keeps its legacy card — the scope is pinned-only, on purpose', () => {
    // A docked entry still has a lane DockStubCard AND a route to DockFullView,
    // so its face is already reachable; the pinned occupant is canvas-hidden and
    // has neither. Widening this would flip every user-docked promoted module
    // at once — `workflow-dock.spec.ts` docks `mixer` and asserts `.mod-card`,
    // and `workflow-dock-composite` VRT docks `vca`. Both are promoted.
    expect(dockRailRendersFace({ shellFaces: true, pinned: false, migrated: true })).toBe(false);
  });

  it('ANCHORED to the live roster: the drawer occupants this rule can currently reach', () => {
    // The pinned M/E occupants are the only nodes the `pinned` arm can ever see
    // (`c` opens a full-view PANE, not the rail). Derived from the shipped spec
    // list rather than named here, so adding a fourth pinned module cannot make
    // this clause quietly stale.
    const resolveDef = (t: string) =>
      getModuleDef(t as ModuleType) ??
      getVideoModuleDef(t as ModuleType) ??
      getMetaModuleDef(t as ModuleType);
    const drawerTypes = WORKFLOW_PINNED_MODULES.filter((s) => s.surface === 'drawer').map((s) => s.type);
    expect(drawerTypes.length, 'the drawer must have occupants for this rule to mean anything').toBeGreaterThan(0);
    for (const type of drawerTypes) {
      expect(resolveDef(type), `${type} must resolve to a registered def`).toBeTruthy();
      // Whatever the roster is, the rule agrees with STRICT_FACES for it — in
      // BOTH directions, so a promotion or a demotion moves this by itself.
      expect(
        dockRailRendersFace({ shellFaces: true, pinned: true, migrated: migrated(type) }),
        `${type}: tray face must track STRICT_FACES membership`,
      ).toBe(migrated(type));
    }
    // …and the population is not degenerate: mixmstrs is promoted, so at least
    // one occupant genuinely takes the face branch today.
    expect(migrated('mixmstrs'), 'mixmstrs is the promotion this rule was written for').toBe(true);
  });
});

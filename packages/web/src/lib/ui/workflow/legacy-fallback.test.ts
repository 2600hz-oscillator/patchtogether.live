// packages/web/src/lib/ui/workflow/legacy-fallback.test.ts
//
// The lane-render decision — pure derivation gate. Proves:
//   - the user-dock swap wins (unchanged P2.5a contract);
//   - an organizational-native type resolves 'native' and emits its own type;
//   - everything else resolves 'shell';
//   - the emitted node-type mapping, and that the carve-out set is ANCHORED to
//     the live registry so a stale id is red rather than a silent no-op.
//
// ⚠ THREE OF THIS FILE'S FIVE SUBJECTS ARE GONE, AND THEY WENT TOGETHER.
// `?shell=legacy` (the escape hatch), `'placeholder'` (the un-migrated lane
// body) and `dockRailRendersFace` (the tray's three-term rule) each described a
// TRANSITION between two renderers. There is one renderer. What survives is the
// half that describes the product: docked vs lane, and the one carve-out for a
// type with no lane body at all.

import { describe, it, expect } from 'vitest';
import {
  laneRenderKind,
  emittedTypeFor,
  isLaneNative,
  NON_SHELL_LANE_TYPES,
  type LaneRenderInput,
} from './legacy-fallback';
import { migrated } from './strict-faces';

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

/** An ordinary lane module: not docked, not a carve-out. */
const base: LaneRenderInput = {
  userDocked: false,
  type: 'tidyvco',
  laneNative: false,
};

describe('laneRenderKind — the pure lane decision', () => {
  it('user-docked ALWAYS wins → stub, carve-out or not', () => {
    for (const laneNative of [true, false]) {
      expect(laneRenderKind({ ...base, userDocked: true, laneNative })).toBe('stub');
    }
  });

  it('an ordinary module renders the faceplate', () => {
    expect(laneRenderKind(base)).toBe('shell');
  });

  it('an organizational-native type resolves native, docked or not', () => {
    expect(laneRenderKind({ ...base, laneNative: true })).toBe('native');
    // …and the dock still outranks it, which is the ORDER the function encodes.
    expect(laneRenderKind({ ...base, laneNative: true, userDocked: true })).toBe('stub');
  });

  // ⚠ THE THREE DELETED LEGS, NAMED so their absence is a decision rather than
  // an omission: "?shell=legacy → legacy for every non-docked node", "DEFAULT +
  // un-migrated + swappable → placeholder", and "a non-card / snowflake type
  // stays legacy even by default". The first two describe renderers that no
  // longer exist. The third is the SAME claim as the native leg above — it said
  // "no card ⇒ fall back to the card path", which stopped meaning anything when
  // there was no card path to fall back to; the carve-out it was really about is
  // asserted directly now.
});

describe('emittedTypeFor — kind → xyflow node type', () => {
  it('maps each kind to its node type; native emits the module type', () => {
    expect(emittedTypeFor('stub', 'tidyvco')).toBe('dockStub');
    expect(emittedTypeFor('shell', 'tidyvco')).toBe('moduleShell');
    expect(emittedTypeFor('native', 'cadillac')).toBe('cadillac');
  });

  it('the full pipeline: a carve-out round-trips to its own type', () => {
    const kind = laneRenderKind({ ...base, type: 'cadillac', laneNative: true });
    expect(emittedTypeFor(kind, 'cadillac')).toBe('cadillac');
  });
});

describe('isLaneNative — the carve-out predicate', () => {
  // ⚠ IT WAS `isLaneNative(type, hasResolvableCard)` AND IT ASKED TWO
  // QUESTIONS. The card half ("does this type resolve to a real *Card.svelte")
  // has no referent; what is left is the snowflake half, stated positively. The
  // "requires a resolvable card" leg went with it.
  it('is FALSE for an ordinary module', () => {
    expect(isLaneNative('tidyvco')).toBe(false);
  });

  it('is TRUE for exactly the organizational / snowflake types', () => {
    for (const t of NON_SHELL_LANE_TYPES) {
      expect(isLaneNative(t)).toBe(true);
    }
    // sanity: the set holds back exactly the one non-module it is now for.
    // ⚠ THIS LEG HAS BEEN RE-POINTED TWICE AND THE LINEAGE MATTERS. It first
    // asserted `clipplayer` — the last MODULE CARD this set ever held, and the
    // one the "snowflake" clause was actually true of — until its promotion
    // retired that entry (below). It then asserted `group` and `sticky`, "the
    // organizational chrome", until BOTH modules were deleted outright (owner
    // ruling 2026-09-03). What is left is CADILLAC, which is not a module card
    // at all: a roaming overlay sprite with no SvelteFlow node body, filtered
    // out of flowNodes upstream. So the set is no longer a queue of modules
    // awaiting a face — it holds one non-module and cannot drain further.
    expect(NON_SHELL_LANE_TYPES.has('cadillac')).toBe(true);
    expect(NON_SHELL_LANE_TYPES.has('tidyvco')).toBe(false);
    expect([...NON_SHELL_LANE_TYPES]).toEqual(['cadillac']);
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
    expect(isLaneNative('clipplayer')).toBe(false);
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
    expect(isLaneNative('videoOut')).toBe(false);
    expect(
      laneRenderKind({ ...base, type: 'videoOut', laneNative: isLaneNative('videoOut') }),
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
    expect(isLaneNative('cameraInput')).toBe(false);
    expect(
      laneRenderKind({ ...base, type: 'cameraInput', laneNative: isLaneNative('cameraInput') }),
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
    expect(isLaneNative('es9')).toBe(false);
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
    // ⚠ THIS LEG ASSERTED `'placeholder'`, AND THEN `'legacy'` UNDER THE HATCH.
    // Both arms described the carve-out's REMOVAL not changing anything else;
    // both renderers are gone. What is still exactly about es9, and still
    // checkable here, is that it is not carved out and therefore takes the
    // ordinary lane path.
    expect(laneRenderKind({ ...base, type: 'es9', laneNative: isLaneNative('es9') })).toBe('shell');
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
    // ⚠ THE META WITNESS USED TO BE `sticky`, and it is deleted. `cadillac` is
    // both the replacement witness and the set's only remaining member, which
    // makes this negative control a little weaker than it was — it no longer
    // proves the resolver reaches a meta def OTHER than the one under test. It
    // is still the honest choice: substituting an unrelated meta module would
    // assert something this file has no stake in.
    expect(resolve('cadillac')).toBeTruthy(); // meta
  });
});

// ⚠ THE `dockRailRendersFace` DESCRIBE IS GONE — five legs, one rule, no
// subject. It asserted the tray's truth table (`shellFaces && pinned &&
// migrated`), that `?shell=legacy` kept the tray on the legacy card, that a
// USER-DOCKED promoted module kept its card because the scope was pinned-only,
// and an anchor onto the live drawer roster. The `pinned` clause was the live
// card-mounting path S4 had to close, and closing it removed the rule: the rail
// has one surface to render. `WORKFLOW_PINNED_MODULES` is no longer imported
// here because nothing in this file has a decision to anchor onto it.

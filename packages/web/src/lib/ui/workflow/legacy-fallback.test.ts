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
  NON_SHELL_LANE_TYPES,
  type LaneRenderInput,
} from './legacy-fallback';

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
    // sanity: the excluded set is the snowflakes we intend to hold back
    expect(NON_SHELL_LANE_TYPES.has('group')).toBe(true);
    expect(NON_SHELL_LANE_TYPES.has('clipplayer')).toBe(true);
    expect(NON_SHELL_LANE_TYPES.has('tidyvco')).toBe(false);
  });

  it('videoOut is a VIDEO-SURFACE snowflake: its legacy card (the live, freely-resizable output screen) stays in the lane', () => {
    // The owner ?shell=1 regression: swapping videoOut for a placeholder tile
    // removed the only user-viewable video output. It must render legacy.
    expect(NON_SHELL_LANE_TYPES.has('videoOut')).toBe(true);
    expect(isShellSwappable('videoOut', true)).toBe(false);
    expect(laneRenderKind({ ...base, type: 'videoOut', hasCard: isShellSwappable('videoOut', true) })).toBe('legacy');
    // …while the other video-domain modules (recorderbox / backdraft / …) still
    // swap to tiles — they get the LIVE THUMBNAIL glyph instead.
    expect(NON_SHELL_LANE_TYPES.has('recorderbox')).toBe(false);
    expect(NON_SHELL_LANE_TYPES.has('backdraft')).toBe(false);
  });

  it('cameraInput is a CAPTURE-SOURCE snowflake: its legacy card (the live source + the device picker) stays in the lane', () => {
    // The owner ?shell=1 P0: the card owns getUserMedia + the <video> it hands
    // to the engine (attachExternalSource), AND the device <select> — neither is
    // a ParamDef, so a tile made camera → OUTPUT patched-but-black with no way
    // to pick a source. See ./dom-source-modules for the full rationale + gate.
    expect(NON_SHELL_LANE_TYPES.has('cameraInput')).toBe(true);
    expect(isShellSwappable('cameraInput', true)).toBe(false);
    expect(
      laneRenderKind({ ...base, type: 'cameraInput', hasCard: isShellSwappable('cameraInput', true) }),
    ).toBe('legacy');
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
    // Un-migrated (no curated face yet) ⇒ the uniform placeholder tile, whose
    // EXPAND opens the dock full view. That is the owner's requested shape.
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
    expect(NON_SHELL_LANE_TYPES.has(LAUNCHPAD_CONTROL_TYPE)).toBe(true);
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

// packages/web/src/lib/ui/stereo-jack-expansion.test.ts
//
// RIGHT-CLICK A STEREO JACK → SEE ITS TWO L/R HOLES.
//
// The owner's report (2026-08-10): "i need to know how to patch es-9 stereo l/r
// into a mixmasters channel. either i'm stupid or this just doesn't work … i
// want (for mixmasters ONLY) to be able to right-click any stereo port and
// expand it to 2 L/R ports … i just need it for the mixmstrs inputs AND outputs
// including send and return."
//
// MIXMSTRS declares every leg already (`ch1L`/`ch1R` … `ret2L`/`ret2R`,
// `masterL`/`masterR`, `send1L`/`send1R`, `send2L`/`send2R`). Nothing here
// synthesises a port: the UI was COLLAPSING what the def already had, so this
// is the un-collapse and its opt-in.
//
// LOADS THE REAL `mixmstrsDef`, not a fixture — the whole question is what the
// shipped card does, and a fixture that happens to pair the way I expect would
// prove nothing about it. The four port groups the owner enumerated are asserted
// by NAME (channels / returns / master / sends), not by count, so a rail that
// silently stops pairing goes red instead of quietly shrinking a total.
//
// ⚠ WHAT THIS FILE IS STRUCTURALLY UNABLE TO SEE, stated so a green run is not
// read as more than it is. It exercises the pure derivation
// (`collapseStereoPorts` + the expansion store), NOT the three right-click
// surfaces that call it — the `patchpanel:stereoexpand` dispatch in
// PatchPanel, the row on UnpatchMenu, and the row on PortContextMenu. A unit
// test that calls the collapse function directly cannot see a menu that never
// offers the gesture, which is the exact failure shape #1426 documented for the
// per-leg work (the planner was always right; no UI could reach it). The gate
// for that half is `e2e/tests/mixmstrs-stereo-expand.spec.ts`. Do not let this
// file's greenness stand in for it.

import { beforeEach, describe, expect, it } from 'vitest';
import '$lib/audio/modules';
import { listModuleDefs } from '$lib/audio/module-registry';
import { mixmstrsDef } from '$lib/audio/modules/mixmstrs';
import {
  EXPANDABLE_STEREO_JACK_MODULES,
  isExpandableStereoJackModule,
  derivedStereoPairs,
  type StereoPairDefLike,
} from '$lib/graph/stereo-pairs';
import { collapseStereoPorts } from '$lib/ui/stereo-jack-collapse';
import {
  __resetJackExpansions,
  clearNodeExpansions,
  expandedLeftIdsFor,
  isJackExpanded,
  setJackExpanded,
  toggleJackExpanded,
} from '$lib/ui/stereo-jack-expansion.svelte';

const mix = mixmstrsDef as unknown as StereoPairDefLike;
const NODE = 'mixmstrs-1';

/** The rendered jack rows for a set of declared legs, given the pairs the user
 *  has expanded. Ids only — the identity of a row is the port it addresses. */
function rowIds(
  legs: readonly string[],
  direction: 'input' | 'output',
  expanded?: ReadonlySet<string>,
): string[] {
  return collapseStereoPorts(
    legs.map((id) => ({ id })),
    mix,
    direction,
    expanded,
  ).map((p) => p.id);
}

beforeEach(() => __resetJackExpansions());

// ---------------------------------------------------------------------------
// THE FOUR PORT GROUPS THE OWNER NAMED
// ---------------------------------------------------------------------------

describe('every MIXMSTRS stereo rail expands into its two declared legs', () => {
  // (group, direction, left, right) — every rail the owner enumerated:
  // "the mixmstrs inputs AND outputs including send and return".
  const RAILS = [
    ['channel 1', 'input', 'ch1L', 'ch1R'],
    ['channel 8', 'input', 'ch8L', 'ch8R'],
    ['return 1', 'input', 'ret1L', 'ret1R'],
    ['return 2', 'input', 'ret2L', 'ret2R'],
    ['master', 'output', 'masterL', 'masterR'],
    ['send 1', 'output', 'send1L', 'send1R'],
    ['send 2', 'output', 'send2L', 'send2R'],
  ] as const;

  it.each(RAILS)(
    '%s collapses to ONE row by default (unchanged behaviour)',
    (_group, direction, left, right) => {
      expect(rowIds([left, right], direction)).toEqual([left]);
    },
  );

  it.each(RAILS)('%s expands to TWO rows once the user expands it', (_group, direction, left, right) => {
    expect(rowIds([left, right], direction, new Set([left]))).toEqual([left, right]);
  });

  // THE REGRESSION LEG. Before this change `collapseStereoPorts` took no
  // expansion argument at all, so every one of the rows above was a single
  // collapsed jack and there was no way — through any gesture — to address one
  // leg of a MIXMSTRS rail on the card. This is the assertion that was
  // impossible to satisfy.
  it('an expanded row addresses ONE leg: no siblingId, no side, its own label', () => {
    const rows = collapseStereoPorts(
      [{ id: 'ch1L' }, { id: 'ch1R' }],
      mix,
      'input',
      new Set(['ch1L']),
    );
    expect(rows.map((r) => r.id)).toEqual(['ch1L', 'ch1R']);
    for (const row of rows) {
      expect(row.siblingId).toBeUndefined();
      expect(row.side).toBeUndefined();
    }
  });

  it('the COLLAPSED row still carries the pair identity it always did', () => {
    const [row] = collapseStereoPorts([{ id: 'ch1L' }, { id: 'ch1R' }], mix, 'input');
    expect(row.siblingId).toBe('ch1R');
    expect(row.side).toBe('left');
    expect(row.label).toBe('CH1');
  });
});

// ---------------------------------------------------------------------------
// EXPANSION IS PER-JACK, NOT A CARD-WIDE MODE
// ---------------------------------------------------------------------------

describe('expanding one jack leaves every other jack alone', () => {
  it('CH1 expanded, CH2 untouched — on the SAME surface', () => {
    expect(rowIds(['ch1L', 'ch1R', 'ch2L', 'ch2R'], 'input', new Set(['ch1L']))).toEqual([
      'ch1L',
      'ch1R',
      'ch2L',
    ]);
  });

  it('expansion is keyed to the LEFT port: naming the RIGHT leg expands nothing', () => {
    // The store only ever writes the pair's left id (`dispatchStereoExpandMenu`
    // resolves the pair before dispatching), so a right-keyed entry is not a
    // supported input — this pins that the collapse side agrees, rather than
    // silently accepting either and drifting from the store's keying.
    expect(rowIds(['ch1L', 'ch1R'], 'input', new Set(['ch1R']))).toEqual(['ch1L']);
  });

  it('direction is respected — the input and output rails are separate lists', () => {
    // `send1L` is an OUTPUT. Expanding it must not leak into the input rail.
    expect(rowIds(['ch1L', 'ch1R'], 'input', new Set(['send1L']))).toEqual(['ch1L']);
    expect(rowIds(['send1L', 'send1R'], 'output', new Set(['send1L']))).toEqual([
      'send1L',
      'send1R',
    ]);
  });

  it('no expansion argument at all is byte-for-byte the old behaviour', () => {
    const legs = ['ch1L', 'ch1R', 'ret1L', 'ret1R'];
    expect(rowIds(legs, 'input')).toEqual(rowIds(legs, 'input', new Set()));
  });
});

// ---------------------------------------------------------------------------
// THE STORE
// ---------------------------------------------------------------------------

describe('the expansion store', () => {
  it('toggles, reports, and returns the NEW state', () => {
    expect(isJackExpanded(NODE, 'input', 'ch1L')).toBe(false);
    expect(toggleJackExpanded(NODE, 'input', 'ch1L')).toBe(true);
    expect(isJackExpanded(NODE, 'input', 'ch1L')).toBe(true);
    expect(toggleJackExpanded(NODE, 'input', 'ch1L')).toBe(false);
    expect(isJackExpanded(NODE, 'input', 'ch1L')).toBe(false);
  });

  it('feeds collapseStereoPorts directly — the store and the render agree', () => {
    setJackExpanded(NODE, 'input', 'ch1L', true);
    expect(rowIds(['ch1L', 'ch1R'], 'input', expandedLeftIdsFor(NODE, 'input'))).toEqual([
      'ch1L',
      'ch1R',
    ]);
  });

  it('is PER NODE — two MIXMSTRS on one rack expand independently', () => {
    setJackExpanded('mix-a', 'input', 'ch1L', true);
    expect([...expandedLeftIdsFor('mix-a', 'input')]).toEqual(['ch1L']);
    expect([...expandedLeftIdsFor('mix-b', 'input')]).toEqual([]);
  });

  it('is PER DIRECTION — an input key never answers an output query', () => {
    setJackExpanded(NODE, 'input', 'ch1L', true);
    expect([...expandedLeftIdsFor(NODE, 'output')]).toEqual([]);
  });

  it('clearNodeExpansions drops one node and only that node', () => {
    setJackExpanded('mix-a', 'input', 'ch1L', true);
    setJackExpanded('mix-b', 'input', 'ch1L', true);
    clearNodeExpansions('mix-a');
    expect([...expandedLeftIdsFor('mix-a', 'input')]).toEqual([]);
    expect([...expandedLeftIdsFor('mix-b', 'input')]).toEqual(['ch1L']);
  });

  it('a node id containing the key separator cannot forge another node\'s entry', () => {
    // The separator is a NUL, which cannot occur in a real node or port id —
    // but the guarantee is worth pinning rather than assuming.
    setJackExpanded('mix-a', 'input', 'ch1L', true);
    expect(isJackExpanded('mix', 'input', 'ch1L')).toBe(false);
    expect(isJackExpanded('mix-a-extra', 'input', 'ch1L')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// THE OPT-IN, ANCHORED TO THE LIVE REGISTRY
// ---------------------------------------------------------------------------

describe('EXPANDABLE_STEREO_JACK_MODULES is anchored to the artifact', () => {
  it('every named module still exists in the live registry', () => {
    const known = new Set(listModuleDefs().map((d) => d.type));
    for (const type of EXPANDABLE_STEREO_JACK_MODULES.keys()) {
      expect(known.has(type), `names '${type}', which no longer exists`).toBe(true);
    }
  });

  it('every named module actually DERIVES stereo pairs — nothing to expand is a bug', () => {
    const byType = new Map(listModuleDefs().map((d) => [d.type, d]));
    for (const type of EXPANDABLE_STEREO_JACK_MODULES.keys()) {
      const def = byType.get(type) as StereoPairDefLike | undefined;
      expect(def, `'${type}' is not in the registry`).toBeDefined();
      expect(
        derivedStereoPairs(def!).length,
        `'${type}' offers the expand gesture but derives no stereo pair`,
      ).toBeGreaterThan(0);
    }
  });

  it('every entry carries a REASON, not just a name', () => {
    for (const [type, reason] of EXPANDABLE_STEREO_JACK_MODULES) {
      expect(reason.length, `'${type}' has no reason`).toBeGreaterThan(40);
    }
  });

  it('the predicate is the gate — mixmstrs in, an unlisted module out', () => {
    expect(isExpandableStereoJackModule('mixmstrs')).toBe(true);
    // NEGATIVE CONTROL, and it is a real one: `twotracks` derives stereo pairs
    // exactly like mixmstrs does, so a predicate that answered "does it have
    // pairs?" instead of "is it opted in?" would pass the positive leg above
    // and fail here.
    expect(derivedStereoPairs(
      listModuleDefs().find((d) => d.type === 'twotracks') as unknown as StereoPairDefLike,
    ).length).toBeGreaterThan(0);
    expect(isExpandableStereoJackModule('twotracks')).toBe(false);
    expect(isExpandableStereoJackModule(undefined)).toBe(false);
  });
});

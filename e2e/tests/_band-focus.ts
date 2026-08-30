// e2e/tests/_band-focus.ts
//
// BAND FOCUS, for the specs that SWEEP FACES — one export site for "drive this
// face into the state where all of its bands are on the plate".
//
// ── The hazard, stated as the class rather than as one test ────────────────
//
// `face.bandFocus` (packages/web/src/lib/ui/workflow/band-focus-model.ts) lets a
// param VALUE decide which control bands the dock renders, and the bands it
// hides are UNMOUNTED, not merely hidden — reclaiming the space is the whole
// point of the feature. `colourofmagic` is the first adopter and its DEFAULT is
// a focused value, so a freshly spawned face shows ONE of its five bands.
//
// ⚠ THAT BREAKS EVERY REGISTRY-DRIVEN FACE SWEEP IN THE SAME DIRECTION, and it
// is worth naming the direction because it is the opposite of the usual one.
// These sweeps assert a property of the WHOLE face measured against what the
// DEF declares — every param renders exactly one cell (faces-parity), every
// declared band hint paints (PF-20), every packed row keeps its labels (PF-21).
// A face that shows one band renders FEWER of those things at its default, so
// the assertion does not go vacuous: it goes RED on a module that is working
// exactly as the owner specified. MEASURED, and this file exists because of it:
// PF-20 failed `declared 5, received 1` on job 96630258998.
//
// So a sweep whose subject is the whole face opens it at a DECLARED show-all
// value first. The value is declared and never guessed — a hidden band leaves
// nothing in the DOM to derive it from.
//
// ⚠ WHAT THIS FILE CANNOT DO IS MAKE A NEW SWEEP CALL IT. There is no gate that
// sees "spec enumerates strictFace modules AND opens the dock AND did not drive
// show-all"; the honest defence is that each caller's own assertion is stated
// against the DEF'S DECLARED TOTAL, so a sweep that forgets goes RED with the
// declared-vs-received numbers in the message rather than passing quietly. The
// callers say so at their own call sites. Where a sweep's assertions are all
// inside a per-row `if`, forgetting IS silent — those carry an extra derived
// membership leg (PF-21) rather than relying on this note.
//
// ⚠ AND A SHOW-ALL WALK IS ONLY HALF A CLAIM. Proving every control is reachable
// at show-all says nothing about whether the feature hides anything at all — a
// face that declared `bandFocus` and ignored it passes every such leg. The other
// half is faces-parity's focused-absence leg (§4 there), which drives a FOCUSED
// value and asserts the other bands are GONE from the DOM. Neither leg means
// anything alone; do not add the first to a new sweep and call it covered.

import { expect, type Page } from '@playwright/test';

/** `face.bandFocus` as the `__moduleSpecs` projection publishes it
 *  (packages/web/src/lib/dev/module-specs.ts). */
export interface BandFocusDecl {
  param: string;
  showAllOn: number[];
  bands: Record<string, number[]>;
}

/** The slice of a spec this helper needs. Structural on purpose: every face
 *  sweep projects `__moduleSpecs` into its own shape, and none of them should
 *  have to widen it to call this. */
export interface BandFocusedSpec {
  type: string;
  bandFocus?: BandFocusDecl;
}

/**
 * Drive a BAND-FOCUSED face into its declared show-all state. A no-op — and a
 * silent one, with no skip reported — on every face without the feature, so a
 * caller sweeps its whole roster with no branch and no row that reads as
 * coverage it does not have.
 *
 * Writes through `__ydoc.transact` into `__patch`, i.e. the same durable param
 * store a player's own click lands in, so the face re-renders through its real
 * reactive path rather than through a test-only back door.
 *
 * Cheap enough to call PER CELL, and faces-parity does: on a focused face the
 * focus param is ITSELF a cell, so driving it re-focuses the plate mid-walk and
 * takes the not-yet-visited cells of every other band with it.
 */
export async function showAllBands(
  page: Page,
  nodeId: string,
  spec: BandFocusedSpec,
): Promise<void> {
  const focus = spec.bandFocus;
  if (!focus) return; // faces without the feature are untouched
  const value = focus.showAllOn[0];
  expect(
    value,
    `${spec.type}: declares bandFocus with an EMPTY showAllOn — there would be no state in ` +
      `which a player can reach every control`,
  ).not.toBeUndefined();
  await page.evaluate(
    ({ id, param, v }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> } | undefined> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes[id];
        if (n) n.params[param] = v;
      });
    },
    { id: nodeId, param: focus.param, v: value! },
  );
}

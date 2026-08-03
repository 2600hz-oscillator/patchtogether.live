// packages/web/src/lib/ui/modules/audition-ledger.test.ts
//
// THE PERMANENT, BOTH-DIRECTIONS NEGATIVE CONTROL for the action-cell probe.
//
// ⚠ THE POINT OF THIS FILE. `faces-parity`'s `action` branch had no probe: it
// clicked and asserted nothing, so a DEAD audition passed. Replacing one
// vacuous assertion with another would be the same bug wearing a probe, so the
// predicate that probe reads is negative-controlled HERE, in the unit lane, on
// EVERY RUN rather than once at authoring time:
//
//   * force the audition DISCONNECTED (the engine answers nothing) → the
//     predicate must go FALSE. If it does not, the e2e probe is decoration.
//   * force it CONNECTED → the predicate must go TRUE. If it does not, the
//     probe is crying wolf and will be turned off.
//
// It drives the REAL `fireManualStrike` / `setManualGate` / `setMomentaryParam`
// against a fake engine rather than the pure predicate alone, because the
// interesting half is whether the SEAM records what it did — a predicate over a
// hand-built array proves nothing about the call site that was throwing the
// boolean away.
//
// ── The MOMENTARY PAD joined this file when it stopped writing the Y.Doc ─────
// A press-pad now writes the ENGINE ONLY, which is what makes a lost release
// harmless — and it is also what made `readParam` blind to it, so faces-parity's
// release clause (`readParam(…) ?? rest → toBe(rest)`) silently reduced to
// `rest === rest`: the headline "a momentary pad must not latch" assertion was
// unconditionally true. Same shape as the `action` cell above, one seam later.
// The RELEASE-edge legs below are therefore not symmetry for its own sake; they
// are the permanent control on the exact assertion that went vacuous.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
import { setActiveEngine } from '$lib/audio/engine-ref';
import type { PatchEngine } from '$lib/audio/engine';
import type { ModuleNode } from '$lib/graph/types';
import {
  fireManualStrike,
  setManualGate,
  setMomentaryParam,
  __resetManualGateLatch,
  MANUAL_GATE_KEY,
  MANUAL_STRIKE_KEY,
} from './manual-strike-actions';
import {
  auditionDelivered,
  auditionLog,
  auditionSeq,
  recordAudition,
  __resetAuditionLedger,
} from './audition-ledger';

const NODE = 'probe-node';

function addNode(): void {
  ydoc.transact(() => {
    patch.nodes[NODE] = {
      id: NODE,
      type: 'karplus',
      domain: 'audio',
      position: { x: 0, y: 0 },
      params: {},
      data: {},
    } as unknown as ModuleNode;
  }, LOCAL_ORIGIN);
}

/** An engine that answers ONLY the read keys named. `answers: []` is the
 *  DISCONNECTED audition — a handle with no strike behind it. */
function fakeEngine(answers: string[]): PatchEngine {
  return {
    read: (_node: ModuleNode, key: string) => (answers.includes(key) ? () => {} : undefined),
  } as unknown as PatchEngine;
}

/** A press-pad reaches the engine through `setParam`, NOT a read key — so its
 *  connected/disconnected pair is a different fake. Omitting `setParam` is the
 *  DISCONNECTED press: `pushParamOnEngine` calls it, throws, and catches. */
function fakeParamEngine(): PatchEngine {
  return { read: () => undefined, setParam: () => {} } as unknown as PatchEngine;
}
function deadParamEngine(): PatchEngine {
  return { read: () => undefined } as unknown as PatchEngine;
}

beforeEach(() => {
  __resetAuditionLedger();
  __resetManualGateLatch();
  addNode();
});
afterEach(() => {
  setActiveEngine(null);
  __resetManualGateLatch();
  __resetAuditionLedger();
  ydoc.transact(() => {
    delete patch.nodes[NODE];
  }, LOCAL_ORIGIN);
});

describe('audition ledger — the probe predicate, negative-controlled BOTH ways', () => {
  it('a CONNECTED strike is recorded delivered=true and the predicate says YES', () => {
    setActiveEngine(fakeEngine([MANUAL_STRIKE_KEY]));
    const before = auditionSeq(auditionLog());
    expect(fireManualStrike(NODE)).toBe(true);
    expect(
      auditionDelivered(auditionLog(), NODE, 'manual-strike', before),
      'a live audition must satisfy the probe',
    ).toBe(true);
  });

  it('a DISCONNECTED strike is recorded delivered=FALSE and the predicate says NO', () => {
    // ⚠ THE DIRECTION THAT MATTERS. This is the shipped failure the old
    // `await btn.click(); return;` could not distinguish from success: the
    // button exists, the handler runs, the engine answers nothing, no string is
    // plucked. The record MUST exist (so "pressed and reached nothing" is
    // distinguishable from "never pressed") and it must NOT satisfy the probe.
    setActiveEngine(fakeEngine([])); // a handle that answers no read key
    const before = auditionSeq(auditionLog());
    expect(fireManualStrike(NODE)).toBe(false);
    expect(auditionLog().length, 'the failed press is RECORDED, not dropped').toBe(1);
    expect(auditionLog()[0]!.delivered).toBe(false);
    expect(
      auditionDelivered(auditionLog(), NODE, 'manual-strike', before),
      'a DEAD audition must FAIL the probe',
    ).toBe(false);
  });

  it('no engine at all is also delivered=FALSE', () => {
    setActiveEngine(null);
    expect(fireManualStrike(NODE)).toBe(false);
    expect(auditionDelivered(auditionLog(), NODE, 'manual-strike')).toBe(false);
  });

  it('a GATE audition must deliver on BOTH edges, and each edge is separable', () => {
    setActiveEngine(fakeEngine([MANUAL_GATE_KEY]));
    const before = auditionSeq(auditionLog());
    expect(setManualGate(NODE, true)).toBe(true);
    expect(
      auditionDelivered(auditionLog(), NODE, 'manual-gate', before, { high: true }),
      'the OPEN edge delivered',
    ).toBe(true);
    // Before the release, the CLOSE edge must NOT already read as satisfied —
    // otherwise a pad that opens and never closes would pass the probe, which
    // is the worst failure this seam has.
    expect(
      auditionDelivered(auditionLog(), NODE, 'manual-gate', before, { high: false }),
      'the CLOSE edge has not happened yet',
    ).toBe(false);
    expect(setManualGate(NODE, false)).toBe(true);
    expect(auditionDelivered(auditionLog(), NODE, 'manual-gate', before, { high: false })).toBe(true);
  });

  it('a GATE cell wired to a handle that only answers the ONE-SHOT key fails the probe', () => {
    // The mode/read-key mismatch `manual-strike-wiring.test.ts` guards, seen
    // from the probe's side: `resolveManualGate` must NOT fall back to the
    // strike key, so a gate press against a strike-only handle delivers
    // nothing and the sweep reddens.
    setActiveEngine(fakeEngine([MANUAL_STRIKE_KEY]));
    expect(setManualGate(NODE, true)).toBe(false);
    expect(auditionDelivered(auditionLog(), NODE, 'manual-gate', 0, { high: true })).toBe(false);
  });

  it('`sinceSeq` makes it a PROBE, not a historian', () => {
    // Without this, one module's successful audition earlier in the sweep would
    // satisfy a later module's assertion — a green run proving nothing about
    // the cell under test. The sequence snapshot is what scopes it.
    setActiveEngine(fakeEngine([MANUAL_STRIKE_KEY]));
    fireManualStrike(NODE);
    const after = auditionSeq(auditionLog());
    expect(auditionDelivered(auditionLog(), NODE, 'manual-strike', 0)).toBe(true);
    expect(
      auditionDelivered(auditionLog(), NODE, 'manual-strike', after),
      'an OLDER record must not satisfy a NEWER probe',
    ).toBe(false);
  });

  it('the predicate discriminates on node AND seam (it is not vacuously true)', () => {
    recordAudition({ nodeId: 'a', seam: 'manual-strike', delivered: true });
    expect(auditionDelivered(auditionLog(), 'a', 'manual-strike')).toBe(true);
    expect(auditionDelivered(auditionLog(), 'b', 'manual-strike'), 'wrong node').toBe(false);
    expect(auditionDelivered(auditionLog(), 'a', 'manual-gate'), 'wrong seam').toBe(false);
    expect(auditionDelivered(auditionLog(), 'a', 'engine-message'), 'wrong seam').toBe(false);
    expect(auditionDelivered(auditionLog(), 'a', 'manual-press'), 'wrong seam').toBe(false);
  });

  // ── THE MOMENTARY PAD (`manual-press`) ────────────────────────────────────

  it('a PRESS-PAD must deliver on BOTH edges, and each edge is separable', () => {
    setActiveEngine(fakeParamEngine());
    const before = auditionSeq(auditionLog());
    expect(setMomentaryParam(NODE, 'strike', true, 0)).toBe(true);
    expect(
      auditionDelivered(auditionLog(), NODE, 'manual-press', before, { high: true }),
      'the PRESS edge delivered',
    ).toBe(true);
    // ⚠ THE LEG THAT WENT VACUOUS IN THE E2E, asserted here as its permanent
    // control: before the release, the LOW edge must NOT already read satisfied.
    // A pad that presses and never releases is exactly the latch this seam
    // exists to make impossible, and it must be VISIBLE as a false here.
    expect(
      auditionDelivered(auditionLog(), NODE, 'manual-press', before, { high: false }),
      'the RELEASE edge has not happened yet',
    ).toBe(false);
    expect(setMomentaryParam(NODE, 'strike', false, 0)).toBe(true);
    expect(auditionDelivered(auditionLog(), NODE, 'manual-press', before, { high: false })).toBe(
      true,
    );
  });

  it('a press-pad the engine cannot take is recorded delivered=FALSE', () => {
    // The direction that matters, one seam over: the pad lights up (its lit
    // state is local to the surface holding the finger) while nothing sounds.
    setActiveEngine(deadParamEngine());
    const before = auditionSeq(auditionLog());
    expect(setMomentaryParam(NODE, 'strike', true, 0)).toBe(false);
    expect(auditionLog().length, 'the failed press is RECORDED, not dropped').toBe(1);
    expect(auditionLog()[0]!.delivered).toBe(false);
    expect(auditionDelivered(auditionLog(), NODE, 'manual-press', before, { high: true })).toBe(
      false,
    );
  });

  it('the predicate discriminates on paramId — two pads on ONE node do not alias', () => {
    // `face.momentary` is a LIST, so a module may declare several pads and they
    // share a nodeId. Without the paramId filter a probe for `hold` would be
    // satisfied by a press on `strike`, which is the same aliasing
    // `manual-strike-actions.ts` keeps a separate latch to avoid.
    setActiveEngine(fakeParamEngine());
    const before = auditionSeq(auditionLog());
    expect(setMomentaryParam(NODE, 'hold', true, 0)).toBe(true);
    expect(
      auditionDelivered(auditionLog(), NODE, 'manual-press', before, { high: true, paramId: 'hold' }),
      'the pad that was pressed',
    ).toBe(true);
    expect(
      auditionDelivered(auditionLog(), NODE, 'manual-press', before, {
        high: true,
        paramId: 'strike',
      }),
      'a DIFFERENT pad on the same node must not be satisfied',
    ).toBe(false);
  });

  it('the press-pad writes NOTHING to the document — which is WHY the ledger is the oracle', () => {
    // Pinned here rather than assumed: this is the property that made every
    // graph-shaped assertion blind, so if a Y.Doc write is ever re-introduced
    // the contract change surfaces next to the probe that depends on it.
    setActiveEngine(fakeParamEngine());
    setMomentaryParam(NODE, 'strike', true, 0);
    expect(patch.nodes[NODE]!.params, 'the press wrote a param').toEqual({});
    setMomentaryParam(NODE, 'strike', false, 0);
    expect(patch.nodes[NODE]!.params, 'the release wrote a param').toEqual({});
  });
});

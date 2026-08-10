// packages/web/src/lib/audio/modules/timelorde-transport-state.test.ts
//
// The gate for the STOP-vs-MUTE fix. The whole point of the readout is that it
// separates four states the JACKS cannot separate at all (measured: STOPPED,
// MUTED and STOPPED + MUTED are byte-identical on all 13 gate outputs), so the
// assertions here are about DISTINCTNESS first and wording second.
//
// Both directions are controlled on every run:
//   - POSITIVE: the two params must each move the state on their own.
//   - NEGATIVE: `bpm` — the face spec's named control — must not move it, and
//     neither may any other param. A derivation that echoed the whole bag would
//     pass a distinctness test and still be wrong.

import { describe, it, expect } from 'vitest';
import {
  timelordeTransportState,
  timelordeClockIsTurning,
  TIMELORDE_TRANSPORT_STATES,
  type TimelordeParamBag,
  type TimelordeTransportStateId,
} from './timelorde-transport-state';

/** The four (running, muteOutputs) combinations and the id each must produce. */
const COMBOS: { running: number; muteOutputs: number; id: TimelordeTransportStateId }[] = [
  { running: 1, muteOutputs: 0, id: 'running' },
  { running: 0, muteOutputs: 0, id: 'stopped' },
  { running: 1, muteOutputs: 1, id: 'muted' },
  { running: 0, muteOutputs: 1, id: 'stopped-muted' },
];

describe('timelordeTransportState: four states, all distinguishable', () => {
  it('maps every (running, muteOutputs) combination to its own state', () => {
    for (const c of COMBOS) {
      expect(
        timelordeTransportState({ running: c.running, muteOutputs: c.muteOutputs }).id,
        `running=${c.running} muteOutputs=${c.muteOutputs}`,
      ).toBe(c.id);
    }
  });

  it('no two combinations collapse — 4 params in, 4 DISTINCT ids, labels and details out', () => {
    // This is the assertion the fix exists for. Collapsing STOPPED and MUTED
    // into one word would reproduce the ambiguity at the jacks in the UI, and
    // it would pass a test that only checked "the readout says something".
    const states = COMBOS.map((c) => timelordeTransportState({ running: c.running, muteOutputs: c.muteOutputs }));
    expect(new Set(states.map((s) => s.id)).size, 'distinct ids').toBe(4);
    expect(new Set(states.map((s) => s.label)).size, 'distinct labels').toBe(4);
    expect(new Set(states.map((s) => s.short)).size, 'distinct one-line strings').toBe(4);
    expect(new Set(states.map((s) => s.detail)).size, 'distinct detail lines').toBe(4);
  });

  it('the one-line string stays inside the 300 px card so the strip cannot reflow', () => {
    // The strip renders at 0.6rem in a 300 px card. A state whose line wrapped
    // would change the card's height when the transport changed — which is how
    // an off-screen readout moves every dock baseline underneath it (#1425).
    // 30 characters is comfortably inside one line at that size.
    for (const s of TIMELORDE_TRANSPORT_STATES) {
      expect(s.short.length, `"${s.short}" is ${s.short.length} chars`).toBeLessThanOrEqual(30);
      expect(s.short.startsWith(s.label), `"${s.short}" must lead with its label`).toBe(true);
    }
  });

  it('STOPPED and MUTED each NAME what is true of the clock, not just that it is quiet', () => {
    // "no pulses" is the only thing the jacks can say. The readout has to say
    // the thing they cannot: whether the phase is still advancing.
    const stopped = timelordeTransportState({ running: 0 });
    const muted = timelordeTransportState({ muteOutputs: 1 });
    expect(stopped.label).toBe('STOPPED');
    expect(muted.label).toBe('MUTED');
    expect(stopped.detail).not.toBe(muted.detail);
    expect(timelordeClockIsTurning({ running: 0 }), 'STOPPED: phase frozen').toBe(false);
    expect(timelordeClockIsTurning({ muteOutputs: 1 }), 'MUTED: clock still turning').toBe(true);
  });

  it('every id in the table is reachable, and every returned state is IN the table', () => {
    // Anchored to the artifact, not to a hand-typed list: a fifth state added
    // to the table with no combination producing it is dead weight, and a
    // combination returning something not in the table cannot be rendered.
    const produced = new Set(COMBOS.map((c) => timelordeTransportState(c as unknown as TimelordeParamBag).id));
    const declared = new Set(TIMELORDE_TRANSPORT_STATES.map((s) => s.id));
    expect([...declared].sort(), 'declared states with no combination that reaches them').toEqual([...produced].sort());
  });

  it('defaults match the param defaults: an untouched patch reads RUNNING', () => {
    expect(timelordeTransportState({}).id).toBe('running');
    expect(timelordeTransportState({ bpm: 120 }).id).toBe('running');
  });

  it('reads the 0/1 params the way the worklet does (>= 0.5)', () => {
    expect(timelordeTransportState({ running: 0.49 }).id).toBe('stopped');
    expect(timelordeTransportState({ running: 0.5 }).id).toBe('running');
    expect(timelordeTransportState({ muteOutputs: 0.49 }).id).toBe('running');
    expect(timelordeTransportState({ muteOutputs: 0.5 }).id).toBe('muted');
  });
});

describe('timelordeTransportState: negative controls', () => {
  it('NEGATIVE CONTROL — bpm does not move the state, in ANY of the four', () => {
    for (const c of COMBOS) {
      for (const bpm of [10, 60, 120, 240, 300]) {
        expect(
          timelordeTransportState({ running: c.running, muteOutputs: c.muteOutputs, bpm }).id,
          `bpm=${bpm} moved ${c.id}`,
        ).toBe(c.id);
      }
    }
  });

  it('NEGATIVE CONTROL — no other param moves it either', () => {
    // Deny-by-default: every param TIMELORDE declares except the two the state
    // is made of. If a future param starts leaking into the derivation this
    // goes red without anyone having to remember to add a case.
    const IRRELEVANT = ['bpm', 'swingAmount', 'swingSource', 'wizardOn', 'hasExternalClock'];
    for (const c of COMBOS) {
      const base = timelordeTransportState({ running: c.running, muteOutputs: c.muteOutputs });
      for (const key of IRRELEVANT) {
        for (const v of [0, 1, 11, 90, 300]) {
          const got = timelordeTransportState({ running: c.running, muteOutputs: c.muteOutputs, [key]: v });
          expect(got, `${key}=${v} moved ${c.id}`).toEqual(base);
        }
      }
    }
  });

  it('POSITIVE CONTROL — each of the two params DOES move it on its own', () => {
    // Without this, a derivation hard-wired to return RUNNING would satisfy
    // every negative control above.
    expect(timelordeTransportState({ running: 1 }).id).not.toBe(timelordeTransportState({ running: 0 }).id);
    expect(timelordeTransportState({ muteOutputs: 0 }).id).not.toBe(timelordeTransportState({ muteOutputs: 1 }).id);
    // …and each one still moves it while the OTHER is already engaged, which is
    // what makes the fourth state reachable rather than absorbed.
    expect(timelordeTransportState({ running: 0, muteOutputs: 0 }).id)
      .not.toBe(timelordeTransportState({ running: 0, muteOutputs: 1 }).id);
    expect(timelordeTransportState({ running: 1, muteOutputs: 1 }).id)
      .not.toBe(timelordeTransportState({ running: 0, muteOutputs: 1 }).id);
  });
});

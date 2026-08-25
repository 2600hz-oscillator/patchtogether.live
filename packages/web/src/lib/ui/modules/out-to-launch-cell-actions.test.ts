// packages/web/src/lib/ui/modules/out-to-launch-cell-actions.test.ts
//
// THE CONNECT CELL'S AUDITION PROBE, AND ITS PERMANENT NEGATIVE CONTROL.
//
// `out-to-launch-connect-{n}` declares
// `probe: { effect: { kind: 'audition', seam: 'engine-message' } }`, and
// faces-parity presses it on CI. That press proves something only if
// `delivered: false` is REACHABLE — otherwise the probe degenerates into "this
// function was called", which is the vacuity the whole ledger exists to
// prevent. "The CI runner has no Launchpad" is NOT a way to reach it: the Web
// MIDI capability is present on the runner and only the hardware is missing,
// which is a DIFFERENT branch (`'no-device'`) and is exercised separately below.
//
// So the seam is INJECTED, and the no-capability leg is the permanent negative
// control — the same branch a browser without Web MIDI takes, in the unit lane,
// with no browser and no device.

import { describe, expect, it, beforeEach } from 'vitest';
import type { LaunchpadPort } from '$lib/control/launchpad/launchpad-device.svelte';
import {
  auditionLog,
  __resetAuditionLedger,
  type AuditionRecord,
} from './audition-ledger';
import {
  outToLaunchConnect,
  outToLaunchGestureOutcome,
  outToLaunchPorts,
  onOutToLaunchGesture,
  __resetOutToLaunchGesture,
  type OutToLaunchGestureSeam,
} from './out-to-launch-cell-actions';

const PORT_A: LaunchpadPort = { outputId: 'out-a', name: 'Launchpad Mini MK3 LPMiniMK3 MIDI Out' } as LaunchpadPort;
const PORT_B: LaunchpadPort = { outputId: 'out-b', name: 'Launchpad Mini MK3 #2' } as LaunchpadPort;

/** A seam whose every branch is observable and none of which touches a device. */
function makeSeam(over: Partial<OutToLaunchGestureSeam> = {}): OutToLaunchGestureSeam {
  return {
    midiAvailable: () => true,
    connect: async () => undefined,
    enumerate: () => [PORT_A, PORT_B],
    ...over,
  };
}

function records(): readonly AuditionRecord[] {
  return auditionLog();
}

/** Let the seam's promise chain settle — the roster is published in a `.then`,
 *  deliberately, because `requestMIDIAccess` is async and the audition record
 *  is written BEFORE it (see the file header's synchronous-record rule). */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

describe('OUT TO LAUNCH CONNECT cell — the audition probe', () => {
  beforeEach(() => {
    __resetAuditionLedger();
    __resetOutToLaunchGesture();
  });

  it('records delivered=true when Web MIDI is there to be reached', async () => {
    const reached = outToLaunchConnect('n1', makeSeam());
    expect(reached, 'the press reached the seam').toBe(true);
    expect(
      records().map((r) => ({ nodeId: r.nodeId, seam: r.seam, delivered: r.delivered })),
      'exactly one record, written for THIS node',
    ).toEqual([{ nodeId: 'n1', seam: 'engine-message', delivered: true }]);
  });

  it('THE NEGATIVE CONTROL: records delivered=false — never nothing — with no Web MIDI', () => {
    // ⚠ THIS LEG IS WHAT MAKES THE PROBE NON-VACUOUS, and it is permanent. A
    // press that reaches nothing must be DISTINGUISHABLE from a press that never
    // happened, which is exactly what `delivered: false` is for. Dropping the
    // record instead would make "the cell is dead" and "nobody clicked" the same
    // observation.
    const reached = outToLaunchConnect('n1', makeSeam({ midiAvailable: () => false }));
    expect(reached, 'the press did NOT reach a seam that could act').toBe(false);
    expect(records(), 'the refusal is RECORDED, not dropped').toHaveLength(1);
    expect(records()[0]).toMatchObject({ nodeId: 'n1', seam: 'engine-message', delivered: false });
    expect(outToLaunchGestureOutcome()).toBe('no-midi');
  });

  it('the record is written SYNCHRONOUSLY, before the async connect resolves', () => {
    // `requestMIDIAccess` can hang for as long as the browser likes when it
    // declines to show its own prompt. `delivered` is not about that OUTCOME; it
    // is about whether the press reached a seam that could act, which is
    // knowable the instant the capability is read.
    let resolveConnect: (() => void) | null = null;
    outToLaunchConnect('n1', makeSeam({ connect: () => new Promise<void>((r) => { resolveConnect = r; }) }));
    expect(records(), 'recorded before anything awaited').toHaveLength(1);
    expect(outToLaunchGestureOutcome()).toBe('listing');
    expect(resolveConnect, 'the connect really is still pending').not.toBeNull();
  });

  it('publishes the enumerated roster, and notifies subscribers', async () => {
    let bumps = 0;
    const off = onOutToLaunchGesture(() => { bumps++; });
    outToLaunchConnect('n1', makeSeam());
    await settle();
    expect(
      outToLaunchPorts().map((p) => p.outputId),
      'the roster is ROWS, and it is what the body renders',
    ).toEqual(['out-a', 'out-b']);
    expect(outToLaunchGestureOutcome()).toBe('idle');
    expect(bumps, 'the body was told, at least at listing and at publish').toBeGreaterThanOrEqual(2);
    off();
  });

  it('distinguishes NO DEVICE from NO WEB MIDI — they are different branches', async () => {
    // The capability is present and only the hardware is missing. This is the
    // state a CI runner is genuinely in, which is why it must NOT be the branch
    // the negative control above relies on.
    outToLaunchConnect('n1', makeSeam({ enumerate: () => [] }));
    await settle();
    expect(outToLaunchGestureOutcome()).toBe('no-device');
    expect(outToLaunchPorts()).toEqual([]);
    expect(
      records()[0],
      'and the press DID reach the seam — the capability was there',
    ).toMatchObject({ delivered: true });
  });

  it('a REJECTED permission is an outcome, not an unhandled rejection', async () => {
    // `requestMIDIAccess` rejects when the user refuses the prompt or the
    // browser blocks sysex — the ordinary path. Without the catch, the plate
    // would say "Connecting…" forever and every e2e that watches `pageerror`
    // would redden on a user declining a permission.
    outToLaunchConnect('n1', makeSeam({ connect: () => Promise.reject(new Error('denied')) }));
    await settle();
    expect(outToLaunchGestureOutcome()).toBe('no-midi');
    expect(outToLaunchPorts()).toEqual([]);
  });

  it('unsubscribing really releases — a body that leaked would be the node-resource class', () => {
    let bumps = 0;
    const off = onOutToLaunchGesture(() => { bumps++; });
    off();
    outToLaunchConnect('n1', makeSeam({ midiAvailable: () => false }));
    expect(bumps, 'no callback after release').toBe(0);
  });
});

// packages/web/src/lib/ui/modules/push2-cell-actions.test.ts
//
// THE CONNECT CELL'S AUDITION PROBE, AND ITS PERMANENT NEGATIVE CONTROL.
//
// `push2-control-connect-{n}` declares
// `probe: { effect: { kind: 'audition', seam: 'engine-message' } }`, and
// faces-parity presses it on CI. That press proves something only if
// `delivered: false` is REACHABLE — otherwise the probe degenerates into "this
// function was called", which is the vacuity the whole ledger exists to
// prevent. "The CI runner has no Push 2" is NOT a way to reach it: the Web MIDI
// capability is present on the runner, only the hardware is not.
//
// So the seam is INJECTED, and the no-capability leg below is the permanent
// negative control — it exercises the same branch a browser without Web MIDI
// takes, in the unit lane, with no browser and no device.

import { describe, expect, it, beforeEach } from 'vitest';
import {
  auditionLog,
  __resetAuditionLedger,
  type AuditionRecord,
} from './audition-ledger';
import {
  push2Connect,
  push2ToggleBind,
  push2GestureOutcome,
  onPush2Gesture,
  __resetPush2Gesture,
  type Push2GestureSeam,
} from './push2-cell-actions';

/** A seam whose every branch is observable and none of which touches a device. */
function makeSeam(over: Partial<Push2GestureSeam> & { calls?: string[] } = {}): Push2GestureSeam {
  const calls = over.calls ?? [];
  return {
    midiAvailable: () => true,
    connect: async () => true,
    firstClipplayer: () => null,
    boundClipNode: () => null,
    bindToClip: (id: string) => { calls.push(`bind:${id}`); },
    unbind: () => { calls.push('unbind'); },
    ...over,
  };
}

function records(): readonly AuditionRecord[] {
  return auditionLog();
}

describe('push2 CONNECT cell — the audition probe', () => {
  beforeEach(() => {
    __resetAuditionLedger();
    __resetPush2Gesture();
  });

  it('records delivered=true when Web MIDI is there to be reached', async () => {
    const reached = push2Connect('n1', makeSeam());
    expect(reached, 'the press reached the seam').toBe(true);
    expect(records().map((r) => ({ nodeId: r.nodeId, seam: r.seam, delivered: r.delivered }))).toEqual([
      { nodeId: 'n1', seam: 'engine-message', delivered: true },
    ]);
  });

  // ⚠ THE PERMANENT NEGATIVE CONTROL. Without this leg the probe above proves
  // only that a function ran. This is the card's own first branch — the one
  // condition under which the button is genuinely wired to nothing.
  it('records delivered=FALSE on a browser with no Web MIDI, and does not call connect', async () => {
    let connectCalls = 0;
    const reached = push2Connect(
      'n1',
      makeSeam({
        midiAvailable: () => false,
        connect: async () => { connectCalls++; return true; },
      }),
    );
    expect(reached, 'the press reached nothing').toBe(false);
    expect(connectCalls, 'no capability ⇒ the seam is never driven').toBe(0);
    expect(records().map((r) => r.delivered)).toEqual([false]);
    expect(push2GestureOutcome()).toBe('no-midi');
  });

  it('the two legs are DISTINGUISHABLE — "never pressed" is not "pressed and reached nothing"', () => {
    expect(records(), 'nothing pressed yet').toEqual([]);
    push2Connect('n1', makeSeam({ midiAvailable: () => false }));
    expect(records().length, 'a dead press is RECORDED, never dropped').toBe(1);
  });

  it('the record is written SYNCHRONOUSLY, before the connect promise settles', () => {
    let resolve!: (v: boolean) => void;
    push2Connect('n1', makeSeam({ connect: () => new Promise<boolean>((r) => { resolve = r; }) }));
    // `requestMIDIAccess` can hang for as long as the browser feels like when
    // it declines to show its own prompt. `delivered` is about whether the
    // press reached a seam that COULD act, which is knowable immediately.
    expect(records().length, 'recorded before the await settles').toBe(1);
    resolve(true);
  });
});

describe('push2 CONNECT cell — the outcome store', () => {
  beforeEach(() => {
    __resetAuditionLedger();
    __resetPush2Gesture();
  });

  it('starts idle and reports connecting the moment the gesture is dispatched', () => {
    expect(push2GestureOutcome()).toBe('idle');
    push2Connect('n1', makeSeam({ connect: () => new Promise<boolean>(() => {}) }));
    expect(push2GestureOutcome()).toBe('connecting');
  });

  it('a failed connect reports no-device, and a rejected one reports no-midi', async () => {
    push2Connect('n1', makeSeam({ connect: async () => false }));
    await Promise.resolve();
    await Promise.resolve();
    expect(push2GestureOutcome()).toBe('no-device');

    __resetPush2Gesture();
    push2Connect('n1', makeSeam({ connect: async () => { throw new Error('user declined'); } }));
    await Promise.resolve();
    await Promise.resolve();
    // ⚠ A REJECTION IS AN OUTCOME, NOT A CRASH. Without the catch this becomes
    // an unhandled rejection and every e2e watching `pageerror` reddens on a
    // user declining a permission.
    expect(push2GestureOutcome()).toBe('no-midi');
  });

  it('a successful connect AUTO-BINDS the patch clip-player, exactly as the card did', async () => {
    const calls: string[] = [];
    push2Connect('n1', makeSeam({ calls, firstClipplayer: () => 'cp' }));
    await Promise.resolve();
    await Promise.resolve();
    expect(push2GestureOutcome()).toBe('connected');
    expect(calls).toEqual(['bind:cp']);
  });

  it('does NOT re-bind a clip-player it is already driving', async () => {
    const calls: string[] = [];
    push2Connect('n1', makeSeam({ calls, firstClipplayer: () => 'cp', boundClipNode: () => 'cp' }));
    await Promise.resolve();
    await Promise.resolve();
    expect(calls, 'already attached — nothing to do').toEqual([]);
  });

  it('notifies subscribers and RELEASES them on unsubscribe (the node-resource-leak class)', () => {
    let hits = 0;
    const off = onPush2Gesture(() => { hits++; });
    push2Connect('n1', makeSeam({ midiAvailable: () => false }));
    expect(hits).toBeGreaterThan(0);
    const after = hits;
    off();
    push2Connect('n1', makeSeam({ midiAvailable: () => false }));
    expect(hits, 'an unsubscribed body must stop being called').toBe(after);
  });
});

describe('push2 BIND — the body control, and why it is not a cell', () => {
  beforeEach(() => {
    __resetAuditionLedger();
    __resetPush2Gesture();
  });

  it('the SAME control does OPPOSITE things depending on state — which a cell label cannot say', () => {
    const bound: string[] = [];
    push2ToggleBind(makeSeam({ calls: bound, firstClipplayer: () => 'cp', boundClipNode: () => null }));
    expect(bound, 'unbound ⇒ BIND').toEqual(['bind:cp']);

    const unbound: string[] = [];
    push2ToggleBind(makeSeam({ calls: unbound, firstClipplayer: () => 'cp', boundClipNode: () => 'cp' }));
    expect(unbound, 'bound ⇒ UNBIND').toEqual(['unbind']);
  });

  it('is a NO-OP on a rack with no clip-player — the state every fresh rack is in', () => {
    const calls: string[] = [];
    push2ToggleBind(makeSeam({ calls, firstClipplayer: () => null, boundClipNode: () => null }));
    expect(calls, 'nothing to bind to; an action cell has no `disabled`').toEqual([]);
  });

  it('writes NOTHING to the audition ledger — it is not a cell and has no probe', () => {
    push2ToggleBind(makeSeam({ firstClipplayer: () => 'cp' }));
    expect(records(), 'only the ranked CONNECT cell auditions').toEqual([]);
  });
});

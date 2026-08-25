// packages/web/src/lib/ui/modules/launchpad-cell-actions.test.ts
//
// THE PERMANENT NEGATIVE CONTROL FOR THE TWO HANDSHAKE CELLS' PROBE.
//
// ⚠ WHY THIS FILE IS NOT OPTIONAL. `faces-parity` proves an ACTION cell did
// something by asking the audition ledger whether the press DELIVERED. That
// question is only worth asking if `delivered: false` is REACHABLE — a seam
// that records `true` unconditionally turns the probe into "this function was
// called", which is the vacuity the ledger was built to end (its own header:
// *"a dead audition passed the face green"*).
//
// For every other action cell in the tree the false branch is "the engine
// handle did not answer the read key". This module has no engine — it is
// `domain: 'meta'`, with no ports, no factory and no node — so its seam is the
// Web MIDI capability the whole launchpad layer sits on, which is also the
// card's own first branch (`LaunchpadControlCard.svelte:79`, `:97`). Both
// directions are driven here, with a fake seam, in node.
//
// ⚠ AND THE CI RUNNER CANNOT REACH THE FALSE BRANCH, which is precisely why it
// has to be reachable HERE. Playwright's Chromium exposes
// `navigator.requestMIDIAccess`; what it lacks is a Launchpad. So the e2e can
// only ever see `delivered: true`, and "the probe can fail" is a claim only the
// unit lane can make.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  __resetAuditionLedger,
  auditionLog,
  type AuditionRecord,
} from './audition-ledger';
import {
  __resetLaunchpadGesture,
  launchpadConnectSingle,
  launchpadGestureOutcome,
  launchpadPair,
  launchpadToggleBind,
  onLaunchpadGesture,
  type LaunchpadGestureSeam,
} from './launchpad-cell-actions';

/** A fake device + graph seam. Every call is recorded so a leg can assert the
 *  press reached the right one. */
function fakeSeam(over: Partial<LaunchpadGestureSeam> = {}): LaunchpadGestureSeam & { calls: string[] } {
  const calls: string[] = [];
  const base: LaunchpadGestureSeam = {
    midiAvailable: () => true,
    isPairing: () => false,
    cancelPairing: () => { calls.push('cancelPairing'); },
    startPairing: async () => { calls.push('startPairing'); return true; },
    startSingle: async () => { calls.push('startSingle'); return true; },
    restorePair: () => { calls.push('restorePair'); return false; },
    restoreSingle: () => { calls.push('restoreSingle'); return false; },
    firstClipplayer: () => null,
    boundClipNode: () => null,
    bindToClip: (id) => { calls.push(`bindToClip:${id}`); },
    unbind: () => { calls.push('unbind'); },
  };
  return Object.assign(base, over, { calls });
}

const records = (): readonly AuditionRecord[] => auditionLog();
const lastDelivered = (): boolean | undefined => records().at(-1)?.delivered;

beforeEach(() => {
  __resetAuditionLedger();
  __resetLaunchpadGesture();
});

describe('launchpad cells — the probe can FAIL, which is what makes a green one mean anything', () => {
  it('⚠ NEGATIVE CONTROL: with no Web MIDI, the press reaches NOTHING and is recorded as such', () => {
    const seam = fakeSeam({ midiAvailable: () => false });

    expect(launchpadPair('n1', seam)).toBe(false);
    expect(lastDelivered(), 'a press on a browser with no Web MIDI delivered nothing').toBe(false);
    expect(seam.calls, 'and it must not have reached the device layer at all').toEqual([]);

    expect(launchpadConnectSingle('n1', seam)).toBe(false);
    expect(lastDelivered()).toBe(false);
    expect(seam.calls).toEqual([]);
  });

  it('POSITIVE CONTROL: with Web MIDI present, both presses deliver AND dispatch', () => {
    const pairSeam = fakeSeam();
    expect(launchpadPair('n1', pairSeam)).toBe(true);
    expect(lastDelivered()).toBe(true);
    expect(pairSeam.calls).toContain('startPairing');

    const singleSeam = fakeSeam();
    expect(launchpadConnectSingle('n1', singleSeam)).toBe(true);
    expect(lastDelivered()).toBe(true);
    expect(singleSeam.calls).toContain('startSingle');
  });

  it('a record carries THIS node and the seam the cell declares', () => {
    launchpadPair('n42', fakeSeam());
    const r = records().at(-1)!;
    expect(r.nodeId).toBe('n42');
    // The cell declares `{ kind: 'audition', seam: 'engine-message' }`; a record
    // under any other seam would satisfy nothing and the probe would be red on a
    // live control.
    expect(r.seam).toBe('engine-message');
  });

  it('⚠ THE RECORD IS WRITTEN SYNCHRONOUSLY — a hung permission prompt cannot swallow it', () => {
    // `startPairing` sits on `requestMIDIAccess`, which can hang for as long as
    // the browser likes when it declines to show its own prompt. `delivered` is
    // not about that outcome, so it must not wait for it.
    const seam = fakeSeam({ startPairing: () => new Promise<boolean>(() => {}) });
    launchpadPair('n1', seam);
    expect(records().length, 'the ledger has the record before the promise settles').toBe(1);
    expect(lastDelivered()).toBe(true);
  });
});

describe('launchpad cells — the OUTCOME store, which is what the body paints from', () => {
  it('starts idle and reports every failure the card reported', async () => {
    expect(launchpadGestureOutcome()).toBe('idle');

    // No Web MIDI at all.
    launchpadPair('n1', fakeSeam({ midiAvailable: () => false }));
    expect(launchpadGestureOutcome()).toBe('no-midi');

    // PAIR with one unit plugged in: startPairing fails on `ports.length < 2`
    // and no saved pair restores.
    __resetLaunchpadGesture();
    const one = fakeSeam({ startPairing: async () => false });
    launchpadPair('n1', one);
    await Promise.resolve(); await Promise.resolve();
    expect(launchpadGestureOutcome()).toBe('one-unit');

    // SINGLE with nothing plugged in.
    __resetLaunchpadGesture();
    const none = fakeSeam({ startSingle: async () => false });
    launchpadConnectSingle('n1', none);
    await Promise.resolve(); await Promise.resolve();
    expect(launchpadGestureOutcome()).toBe('no-device');
  });

  it('⚠ A REFUSED PERMISSION PROMPT is an OUTCOME, not an unhandled rejection', () => {
    // `requestMIDIAccess` REJECTS when the user declines or the browser blocks
    // sysex — the ordinary path. Without a `.catch` the plate would sit on
    // "pairing" forever AND every e2e in the suite that watches `pageerror`
    // would redden on a user saying no.
    const rejected = Promise.reject(new Error('NotAllowedError'));
    const seam = fakeSeam({ startPairing: () => rejected });
    launchpadPair('n1', seam);
    return rejected.catch(() => {}).then(() => Promise.resolve()).then(() => {
      expect(launchpadGestureOutcome()).toBe('no-midi');
    });
  });

  it('a SAVED binding restores silently rather than reporting a failure', async () => {
    const seam = fakeSeam({ startSingle: async () => false, restoreSingle: () => true });
    launchpadConnectSingle('n1', seam);
    await Promise.resolve(); await Promise.resolve();
    expect(launchpadGestureOutcome()).toBe('paired');
  });

  it('a successful handshake AUTO-BINDS the patch\'s clip-player, as the card did', async () => {
    const seam = fakeSeam({
      firstClipplayer: () => 'clip-1',
      startSingle: async (onBound) => { onBound?.(); return true; },
    });
    launchpadConnectSingle('n1', seam);
    expect(seam.calls).toContain('bindToClip:clip-1');
    expect(launchpadGestureOutcome()).toBe('paired');
  });

  it('a SECOND press while pairing CANCELS — and that press still reached the seam', () => {
    const seam = fakeSeam({ isPairing: () => true });
    expect(launchpadPair('n1', seam)).toBe(true);
    expect(seam.calls).toEqual(['cancelPairing']);
    expect(seam.calls).not.toContain('startPairing');
    expect(launchpadGestureOutcome()).toBe('idle');
    // ⚠ A cancel is a real effect, so it is `delivered: true`. Recording it as
    // false would say "this press reached nothing" about a press that undid a
    // handshake.
    expect(lastDelivered()).toBe(true);
  });

  it('subscribers are notified and RELEASED — a body that never unsubscribes is the leak class', () => {
    let hits = 0;
    const off = onLaunchpadGesture(() => { hits++; });
    launchpadPair('n1', fakeSeam({ midiAvailable: () => false }));
    expect(hits).toBe(1);
    off();
    launchpadConnectSingle('n1', fakeSeam({ midiAvailable: () => false }));
    expect(hits, 'an unsubscribed listener must not fire').toBe(1);
  });
});

describe('launchpad cells — BIND toggles, which is why it is not a cell', () => {
  it('binds the patch\'s clip-player when nothing is bound', () => {
    const seam = fakeSeam({ firstClipplayer: () => 'clip-1' });
    launchpadToggleBind(seam);
    expect(seam.calls).toEqual(['bindToClip:clip-1']);
  });

  it('UNBINDS when one is bound — the opposite action under one control', () => {
    const seam = fakeSeam({ boundClipNode: () => 'clip-1', firstClipplayer: () => 'clip-1' });
    launchpadToggleBind(seam);
    expect(seam.calls).toEqual(['unbind']);
  });

  it('is a NO-OP with no clip-player — the state a fresh rack is always in', () => {
    // This is the whole reason BIND is a body control rather than a ranked
    // ACTION cell: `ShellActionCell` has no `disabled`, so a ranked BIND would
    // be a control that looks alive and does nothing on every new rack.
    const seam = fakeSeam();
    launchpadToggleBind(seam);
    expect(seam.calls).toEqual([]);
  });
});

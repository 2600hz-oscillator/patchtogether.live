// packages/web/src/lib/video/camera-device.test.ts
//
// Regression guard for the CAMERA device-recovery decision logic — the bug
// where loading a patch whose saved camera is gone left the card STUCK in
// 'no-cameras-found': you could SEE the available cameras in the dropdown but
// switching to one never started the stream (the re-acquire guard omitted that
// state). These are pure decisions (no getUserMedia / DOM), so they pin the fix
// deterministically; the live stream path stays in camera-input.spec.ts.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  shouldReacquireOnPick,
  savedDeviceAvailable,
  savedDeviceMissing,
  type CameraState,
} from './camera-device';

describe('shouldReacquireOnPick — an explicit device pick (re)acquires', () => {
  it('THE BUG: re-acquires from no-cameras-found (saved camera gone → switch to a working one)', () => {
    expect(shouldReacquireOnPick('no-cameras-found')).toBe(true);
  });

  it('re-acquires from the states the old guard already handled', () => {
    expect(shouldReacquireOnPick('streaming')).toBe(true);
    expect(shouldReacquireOnPick('paused')).toBe(true);
    expect(shouldReacquireOnPick('device-in-use')).toBe(true);
    expect(shouldReacquireOnPick('error')).toBe(true);
  });

  it('also re-acquires from permission-denied and idle (a pick is a fresh intent)', () => {
    expect(shouldReacquireOnPick('permission-denied')).toBe(true);
    expect(shouldReacquireOnPick('idle')).toBe(true);
  });

  it('does NOT re-acquire while a request is already in flight', () => {
    // requestStream() tears the old stream down — re-entering mid-request races
    // itself. Let the in-flight getUserMedia settle.
    expect(shouldReacquireOnPick('requesting')).toBe(false);
  });

  it('does NOT re-acquire when getUserMedia is unsupported', () => {
    expect(shouldReacquireOnPick('unsupported')).toBe(false);
  });

  it('every state is decided (no state silently falls through)', () => {
    const ALL: CameraState[] = [
      'idle', 'requesting', 'streaming', 'paused', 'permission-denied',
      'no-cameras-found', 'device-in-use', 'unsupported', 'error',
    ];
    const stuck = ALL.filter((s) => !shouldReacquireOnPick(s));
    // Exactly the two states where a request can't/shouldn't fire.
    expect(stuck.sort()).toEqual(['requesting', 'unsupported']);
  });
});

describe('savedDeviceAvailable — does the saved id resolve to a present camera', () => {
  const devices = [{ deviceId: 'cam-a' }, { deviceId: 'cam-b' }];

  it('true when the saved id is in the list', () => {
    expect(savedDeviceAvailable('cam-b', devices)).toBe(true);
  });

  it('false when the saved id is gone', () => {
    expect(savedDeviceAvailable('cam-ZZZ', devices)).toBe(false);
  });

  it('false for a null/empty/undefined saved id (nothing to resolve)', () => {
    expect(savedDeviceAvailable(null, devices)).toBe(false);
    expect(savedDeviceAvailable('', devices)).toBe(false);
    expect(savedDeviceAvailable(undefined, devices)).toBe(false);
  });

  it('false against an empty device list', () => {
    expect(savedDeviceAvailable('cam-a', [])).toBe(false);
  });
});

describe('savedDeviceMissing — show "saved camera not found" + skip the doomed request', () => {
  const present = [{ deviceId: 'cam-a' }, { deviceId: 'cam-b' }];

  it('true: a saved id that is gone, with labels visible (the load-on-another-machine case)', () => {
    expect(savedDeviceMissing('cam-ZZZ', present, true)).toBe(true);
  });

  it('false: the saved camera is still present', () => {
    expect(savedDeviceMissing('cam-a', present, true)).toBe(false);
  });

  it('false when labels are NOT yet visible (deviceIds redacted to "" — cannot conclude it is gone)', () => {
    // Pre-permission browsers redact deviceId, so a non-matching saved id does
    // NOT mean the camera is absent. Don't flag "missing" or skip the request.
    expect(savedDeviceMissing('cam-ZZZ', present, false)).toBe(false);
    expect(savedDeviceMissing('cam-ZZZ', [{ deviceId: '' }, { deviceId: '' }], false)).toBe(false);
  });

  it('false for no saved id (unconstrained request → browser default camera)', () => {
    expect(savedDeviceMissing(null, present, true)).toBe(false);
    expect(savedDeviceMissing('', present, true)).toBe(false);
  });
});

// ── SOURCE-LEVEL: the card TRACKS the saved device id, it does not read it once ──
//
// THE BUG THIS PINS (found 2026-08-23 while building the dock face, fixed in the
// same PR): `CameraInputCard.svelte` hydrated `node.data.deviceId` exactly ONCE,
// inside its mount path, and never looked again. A device chosen anywhere other
// than the card's own `<select>` was SAVED and never acted on until the card
// happened to remount — the pick looked like it did nothing. Invisible while the
// card owned the only picker — but a collaborator's pick arrives through the same
// Yjs-backed key TODAY, and simply sat there doing nothing. It becomes unmissable
// for any SECOND picker surface (one was prototyped and parked; see
// .myrobots/2026-08-23-camerainput-face-PARKED-handoff.md).
//
// ⚠ WHY A SOURCE-LEVEL GATE RATHER THAN A BEHAVIOURAL ONE. The observable is a
// Svelte component reacting to a Yjs-backed value, so proving it behaviourally
// needs a browser, a mounted card and a live graph — an e2e, in the one tier
// this repo currently has no headroom in. The property that actually broke is
// structural and greppable: is the saved id read from a REACTIVE position, or
// only from the mount path? A grep answers exactly that, runs in the unit lane,
// and cannot be starved by a loaded runner.
//
// ⚠ AND IT DENIES THE THING THAT REGRESSED, not a proxy for it: it does not
// assert that an `$effect` merely EXISTS (this card has several), but that the
// saved-id reader is CALLED FROM INSIDE one.
describe('CAMERA card — the saved device id is TRACKED, not hydrated once', () => {
  const src = readFileSync(
    new URL('../ui/modules/CameraInputCard.svelte', import.meta.url),
    'utf-8',
  );

  // ⚠ THE FIRST VERSION OF THIS PREDICATE WAS GREEN AND BLIND, and the only
  // thing that caught it was running it against the REAL pre-fix file instead
  // of a synthetic fixture. "Is the reader called inside an `$effect`?" answers
  // TRUE for the buggy card too — because the old code DID call it in an
  // effect, wrapped in `untrack(...)`. That wrapper is the entire bug: an
  // untracked read establishes no dependency, so the effect never re-runs when
  // the saved id changes. A hand-written "mount-only" fixture used `onMount`
  // and so never reproduced the shape that actually shipped.
  //
  // The real property is therefore: is the reader called from a TRACKED
  // position — i.e. does a call survive after every `untrack(...)` body is
  // removed? Both directions of this are pinned below against the genuine
  // pre-fix source, not against prose about it.

  /** Remove every `untrack( … )` body, matching parens so nested calls are safe. */
  function stripUntracked(s: string): string {
    let out = '';
    let i = 0;
    while (i < s.length) {
      const at = s.indexOf('untrack(', i);
      if (at === -1) { out += s.slice(i); break; }
      out += s.slice(i, at);
      let depth = 0;
      let j = at + 'untrack'.length;
      for (; j < s.length; j++) {
        if (s[j] === '(') depth++;
        else if (s[j] === ')') { depth--; if (depth === 0) { j++; break; } }
      }
      i = j;
    }
    return out;
  }

  /** Does any `$effect` read the saved id from a TRACKED position? */
  function callsReaderInEffect(s: string): boolean {
    return s
      .split('$effect(')
      .slice(1)
      .some((e) => stripUntracked(e.slice(0, 900)).includes('readSavedDeviceId()'));
  }

  it('reads the saved device id from a REACTIVE position, not only on mount', () => {
    // ANCHORED: if the reader is renamed this must go RED rather than pass
    // vacuously against a file that no longer has the concept.
    expect(src, 'readSavedDeviceId() is gone — this gate is anchored to that name')
      .toContain('function readSavedDeviceId()');

    expect(
      callsReaderInEffect(src),
      'no $effect calls readSavedDeviceId() — the card is back to hydrate-once, so a device ' +
        'picked by a collaborator — or on any second picker surface — is saved and never acted ' +
        'on until the ' +
        'card remounts',
    ).toBe(true);
  });

  it('re-acquires through the SHARED guard, not a second copy of the rule', () => {
    // The states that refuse a re-acquire on a local pick must refuse it on a
    // tracked one too. Sharing the predicate makes that true by construction; a
    // hand-rolled state list would drift from the one this file already tests,
    // which is the whole reason `shouldReacquireOnPick` is exported.
    const tracking = src
      .split('$effect(')
      .slice(1)
      .find((e) => e.slice(0, 600).includes('readSavedDeviceId()'));
    expect(tracking, 'no tracking effect to check').toBeTruthy();
    expect(
      tracking!.slice(0, 600),
      'the tracking effect re-acquires without shouldReacquireOnPick — it will fire in states a ' +
        'local pick correctly refuses (requesting / unsupported)',
    ).toContain('shouldReacquireOnPick');
  });

  it('POSITIVE CONTROL: the predicate says NO to the shape that actually shipped', () => {
    // ⚠ THIS IS THE LEG THAT CAUGHT THE FIRST VERSION OF THIS GATE. The buggy
    // form is not "no effect" — it is an effect whose read is wrapped in
    // `untrack`, which is why a synthetic `onMount` fixture certified a
    // predicate that would have passed on the bug. This fixture is copied from
    // the pre-fix card, so the gate is pinned to the real defect shape.
    const shippedBug = `
      $effect(() => {
        if (!supported) return;
        untrack(() => {
          selectedDeviceId = readSavedDeviceId();
        });
        refreshDevices();
      });
    `;
    expect(
      callsReaderInEffect(shippedBug),
      'the predicate reads the SHIPPED hydrate-once shape as tracked — it is blind to the very ' +
        'bug it exists to catch (an untracked read inside an effect establishes no dependency)',
    ).toBe(false);
  });

  it('NEGATIVE CONTROL: it still says YES to a genuinely tracked read', () => {
    // The other direction, on the SAME predicate — so a "fix" that makes the
    // gate always-false (and therefore always-red-proof) fails here.
    const tracked = `
      $effect(() => {
        const saved = readSavedDeviceId();
        if (!saved) return;
        untrack(() => { selectedDeviceId = saved; });
      });
    `;
    expect(callsReaderInEffect(tracked), 'a tracked read must read as tracked').toBe(true);

    // And an untracked read is only disqualifying INSIDE the wrapper: a call
    // that also appears outside one still counts.
    expect(stripUntracked('a(untrack(() => x(1)))b'), 'paren matching is off').toBe('a()b');
  });
});

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
// for any SECOND picker surface (one was prototyped and parked on the branch
// `parked/camerainput-face-option-a`, which carries its own handoff note).
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
describe('CAMERA — the saved device id is TRACKED, not hydrated once', () => {
  // ⚠ THE SUBJECT MOVED FILES ON 2026-09-03 AND THE DEFECT SHAPE MOVED WITH IT.
  // This gate used to read `CameraInputCard.svelte`, because the card owned the
  // saved-device reader. `$lib/ui/media/node-camera-source-registry` owns it now
  // (legacy-removal S1), so the gate reads the controller — and the SHAPE of the
  // bug it guards is different enough that the old predicate would have passed
  // vacuously rather than merely gone stale.
  //
  // THE ORIGINAL DEFECT: the card hydrated `node.data.deviceId` ONCE in
  // `onMount`, so a device chosen anywhere other than that card's own `<select>`
  // — by a collaborator, or on a second picker surface — was saved and never
  // acted on until a remount. The first fix's gate was GREEN AND BLIND: "is the
  // reader called inside an `$effect`?" answers TRUE for the buggy card too,
  // because the buggy code DID call it in an effect, wrapped in `untrack(...)`.
  // That wrapper IS the bug — an untracked read establishes no dependency.
  //
  // ⚠ THE NEW OWNER CANNOT HAVE THAT SHAPE AT ALL, and that is why the predicate
  // is replaced rather than re-pointed. A controller is a plain module: it has no
  // `$effect` and therefore no `untrack` to hide a read inside. Its reactivity is
  // Canvas's sync effect, which re-runs on every `snapshot.nodes` change. So the
  // equivalent defect is not "the read is untracked" but "the read happens only
  // when the CONTROLLER IS CREATED" — hydrate-once, one layer down, and the exact
  // thing a reader porting this logic would do by accident.
  //
  // Both directions are pinned against synthetic fixtures below, so the predicate
  // itself is controlled rather than trusted.

  const controllerSrc = readFileSync(
    new URL('../ui/media/node-camera-source-registry.ts', import.meta.url),
    'utf-8',
  );

  /** The body of the registry's `sync(...)` method, or '' if it cannot be found. */
  function syncBody(s: string): string {
    const at = s.indexOf('sync(nodes, engine) {');
    if (at === -1) return '';
    let depth = 0;
    let i = s.indexOf('{', at);
    const start = i;
    for (; i < s.length; i++) {
      if (s[i] === '{') depth++;
      else if (s[i] === '}') { depth--; if (depth === 0) return s.slice(start, i + 1); }
    }
    return '';
  }

  /** Is the saved id re-read on every SYNC, rather than only at creation? */
  function readsSavedIdPerSync(s: string): boolean {
    return syncBody(s).includes('savedDeviceId(');
  }

  it('re-reads the saved device id on every SYNC, not only when the controller is built', () => {
    // ANCHORED: if the dep is renamed this goes RED rather than passing
    // vacuously against a file that no longer has the concept.
    expect(controllerSrc, 'savedDeviceId is gone — this gate is anchored to that name')
      .toContain('savedDeviceId(nodeId: string)');
    expect(
      readsSavedIdPerSync(controllerSrc),
      'sync() never reads savedDeviceId — the controller is back to hydrate-once, so a device ' +
        'picked by a collaborator (or on any other surface) is saved and never acted on',
    ).toBe(true);
  });

  it('re-acquires through the SHARED guard, not a second copy of the rule', () => {
    // The states that refuse a re-acquire on a local pick must refuse it on an
    // external one too. Sharing the predicate makes that true by construction; a
    // hand-rolled state list would drift from the one this file already tests,
    // which is the whole reason `shouldReacquireOnPick` is exported.
    expect(
      syncBody(controllerSrc),
      'sync() re-acquires without shouldReacquireOnPick — it will fire in states a local pick ' +
        'correctly refuses (requesting / unsupported)',
    ).toContain('shouldReacquireOnPick');
  });

  it('POSITIVE CONTROL: the predicate says NO to hydrate-once, one layer down', () => {
    // ⚠ THE SHAPE A PORT OF THIS LOGIC PRODUCES BY ACCIDENT: the saved id is read
    // where the controller is BUILT, which happens once per node, and `sync`
    // never looks again. Every runtime assertion about a fresh camera stays
    // green; only a peer's change is lost.
    const hydrateOnce = `
      function createController(node) {
        const saved = deps.doc.savedDeviceId(node.id);
        return { node, status: { selectedDeviceId: saved } };
      }
      return {
        sync(nodes, engine) {
          for (const n of nodes) {
            const existing = controllers.get(n.id);
            if (!existing) { controllers.set(n.id, createController(n)); continue; }
            existing.node = n;
          }
        },
      };
    `;
    expect(
      readsSavedIdPerSync(hydrateOnce),
      'the predicate reads a hydrate-once controller as tracked — it is blind to the very bug it ' +
        'exists to catch',
    ).toBe(false);
  });

  it('NEGATIVE CONTROL: it still says YES to a genuinely per-sync read', () => {
    // The other direction, on the SAME predicate — so a "fix" that makes the gate
    // always-false (and therefore always-red-proof) fails here.
    const perSync = `
      return {
        sync(nodes, engine) {
          for (const n of nodes) {
            const saved = deps.doc.savedDeviceId(n.id);
            if (saved !== existing.status.selectedDeviceId) act();
          }
        },
      };
    `;
    expect(readsSavedIdPerSync(perSync), 'a per-sync read must read as per-sync').toBe(true);
  });

  it('NEGATIVE CONTROL: the body extractor fails LOUDLY rather than returning everything', () => {
    // A brace-matcher that fell back to the whole file would make every leg above
    // pass on any source containing the string anywhere — the classic way a
    // source gate goes green and blind.
    expect(syncBody('no sync method here at all')).toBe('');
    expect(readsSavedIdPerSync('savedDeviceId( outside any sync')).toBe(false);
  });
});

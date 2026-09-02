// packages/web/src/lib/graph/device-rebind.test.ts
//
// The rebind resolver, driven in both directions.
//
// Everything here is pure, which is the point: camera and gamepad rebinding
// cannot be exercised on CI (no camera, no pad, and `getGamepads` reports
// nothing until a pad is physically TOUCHED), so the decision has to live in a
// function a test can drive and the wiring has to be thin enough to read.

import { describe, expect, it } from 'vitest';
import {
  resolveDevice,
  resolveDeviceSet,
  shouldRewriteSavedId,
  resolveGamepadSlot,
  bindMidiPort,
  type ConnectedDevice,
} from './device-rebind';

const dev = (id: string, name: string): ConnectedDevice => ({ id, name });

describe('resolveDevice — the four rules, in order', () => {
  const connected = [dev('id-a', 'USB Camera'), dev('id-b', 'Built-in Webcam')];

  it('1. an exact id still connected wins', () => {
    const r = resolveDevice({ id: 'id-b', name: 'Built-in Webcam' }, connected);
    expect(r).toEqual({ id: 'id-b', matchedBy: 'exact-id', candidates: [] });
  });

  it('1b. …and it wins even when the NAME points somewhere else', () => {
    // A saved name that has drifted (the device was renamed by the OS) must not
    // beat an id that still resolves. Confidence order, asserted rather than
    // assumed, because the opposite order is a plausible reading of "fall back".
    const r = resolveDevice({ id: 'id-a', name: 'Built-in Webcam' }, connected);
    expect(r.id).toBe('id-a');
    expect(r.matchedBy).toBe('exact-id');
  });

  it('2. a stale id falls back to a UNIQUE name — the whole point of the module', () => {
    const r = resolveDevice({ id: 'id-from-last-boot', name: 'USB Camera' }, connected);
    expect(r).toEqual({ id: 'id-a', matchedBy: 'name-unique', candidates: [] });
  });

  it('4. nothing matches → none, and the caller leaves the module unbound', () => {
    const r = resolveDevice({ id: 'gone', name: 'Unplugged Thing' }, connected);
    expect(r).toEqual({ id: null, matchedBy: 'none', candidates: [] });
  });

  it('⚠ an OLD patch (id only, no name) behaves EXACTLY as it does today', () => {
    // The backward-compatibility contract. A patch saved before names were
    // persisted must not start binding to something new — it resolves by id or
    // not at all, which is the current behaviour verbatim.
    expect(resolveDevice({ id: 'id-a' }, connected).matchedBy).toBe('exact-id');
    expect(resolveDevice({ id: 'gone' }, connected).matchedBy).toBe('none');
  });

  it('⚠ an EMPTY name never matches — the unlabelled-camera trap', () => {
    // `enumerateDevices()` redacts labels to '' until camera permission is
    // granted. Without this guard a saved '' would match the first unlabelled
    // device, i.e. bind an arbitrary camera with maximum confidence.
    const blank = [dev('x', ''), dev('y', '')];
    expect(resolveDevice({ id: 'gone', name: '' }, blank).matchedBy).toBe('none');
    expect(resolveDevice({ id: 'gone', name: null }, blank).matchedBy).toBe('none');
  });
});

describe('3. an AMBIGUOUS name binds, deterministically, and says so', () => {
  // Two identical webcams, or the WinMM case `launchpad-device` documents:
  // several interfaces of one device under one name.
  const twins = [dev('cam-1', 'USB Camera'), dev('cam-2', 'USB Camera')];

  it('picks the first in enumeration order and reports EVERY candidate', () => {
    const r = resolveDevice({ id: 'gone', name: 'USB Camera' }, twins);
    expect(r.matchedBy).toBe('name-ambiguous');
    expect(r.id).toBe('cam-1');
    expect(r.candidates).toEqual(['cam-1', 'cam-2']);
  });

  it('is DETERMINISTIC — the same rack rebinds the same way twice', () => {
    const a = resolveDevice({ id: 'gone', name: 'USB Camera' }, twins);
    const b = resolveDevice({ id: 'gone', name: 'USB Camera' }, twins);
    expect(a).toEqual(b);
  });

  it('prefers a device no other node has CLAIMED', () => {
    const r = resolveDevice({ id: 'gone', name: 'USB Camera' }, twins, new Set(['cam-1']));
    expect(r.id).toBe('cam-2');
    // Still reported as ambiguous: a tie-break was applied, and the player is
    // entitled to know a choice was made on their behalf.
    expect(r.matchedBy).toBe('name-ambiguous');
    expect(r.candidates).toEqual(['cam-1', 'cam-2']);
  });

  it('falls back to the first when EVERY candidate is claimed', () => {
    // Refusing here would strand the second of two identical cameras. Binding a
    // shared device is recoverable; an unbindable rack is not.
    const r = resolveDevice({ id: 'gone', name: 'USB Camera' }, twins, new Set(['cam-1', 'cam-2']));
    expect(r.id).toBe('cam-1');
    expect(r.matchedBy).toBe('name-ambiguous');
  });
});

describe('resolveDeviceSet — ⚠ the two-pass order is what prevents a COLLISION', () => {
  // A saved its id from a machine where the ids have since been regenerated;
  // B's id survived. Both are the same MODEL, so both carry one name.
  const saved = [
    { key: 'nodeA', id: 'stale-id', name: 'USB Camera' },
    { key: 'nodeB', id: 'live-id', name: 'USB Camera' },
  ];
  const connected = [dev('live-id', 'USB Camera'), dev('other-id', 'USB Camera')];

  it('settles the EXACT id first, so the name fallback cannot steal it', () => {
    const out = resolveDeviceSet(saved, connected);
    expect(out.get('nodeB')).toEqual({ id: 'live-id', matchedBy: 'exact-id', candidates: [] });
    expect(out.get('nodeA')!.id).toBe('other-id');
    expect(out.get('nodeA')!.matchedBy).toBe('name-ambiguous');
  });

  it('⚠ NEGATIVE CONTROL: resolving one-at-a-time DOES produce the swap', () => {
    // The bug the two-pass exists to prevent, demonstrated on the same fixture
    // with the same resolver — so this file proves the ORDER is load-bearing
    // rather than merely asserting that the good path is good.
    const claimed = new Set<string>();
    const naive = saved.map((s) => {
      const r = resolveDevice(s, connected, claimed);
      if (r.id) claimed.add(r.id);
      return r;
    });
    // nodeA's NAME grabs the device nodeB owns by exact id…
    expect(naive[0]!.id).toBe('live-id');
    // …and nodeB then binds it TOO, because an exact-id match deliberately
    // ignores `claimed` (two nodes sharing one device is a legal patch). So the
    // failure is a COLLISION, not a swap: both modules land on one camera and
    // `other-id` — which nodeA could have had — is left connected and unused.
    expect(naive[1]!.id).toBe('live-id');
    expect(new Set(naive.map((r) => r.id)).size).toBe(1);

    // The two-pass result puts them on DIFFERENT devices, which is the
    // assertion that matters and the reason the pass order exists.
    const good = resolveDeviceSet(saved, connected);
    expect(good.get('nodeA')!.id).toBe('other-id');
    expect(good.get('nodeB')!.id).toBe('live-id');
    expect(new Set([good.get('nodeA')!.id, good.get('nodeB')!.id]).size).toBe(2);
  });

  it('is order-independent: shuffling the saved list changes nothing', () => {
    const forward = resolveDeviceSet(saved, connected);
    const reversed = resolveDeviceSet([...saved].reverse(), connected);
    expect(reversed.get('nodeA')).toEqual(forward.get('nodeA'));
    expect(reversed.get('nodeB')).toEqual(forward.get('nodeB'));
  });

  it('two nodes deliberately sharing ONE device both keep it', () => {
    // A legal patch: two modules pointed at the same camera. `claimed` must not
    // break that — it only ever guards the ambiguous-NAME tie-break.
    const shared = [
      { key: 'n1', id: 'live-id', name: 'USB Camera' },
      { key: 'n2', id: 'live-id', name: 'USB Camera' },
    ];
    const out = resolveDeviceSet(shared, connected);
    expect(out.get('n1')!.id).toBe('live-id');
    expect(out.get('n2')!.id).toBe('live-id');
    expect(out.get('n2')!.matchedBy).toBe('exact-id');
  });

  it('an unmatched entry is still present in the map, as none', () => {
    // The caller iterates the map to report; a missing key would read as
    // "not considered" rather than "considered and absent".
    const out = resolveDeviceSet([{ key: 'lonely', id: 'gone', name: 'Nothing' }], connected);
    expect(out.get('lonely')).toEqual({ id: null, matchedBy: 'none', candidates: [] });
  });
});

describe('shouldRewriteSavedId — the fallback heals itself', () => {
  it('rewrites after a NAME match, so the next load is an exact hit', () => {
    expect(shouldRewriteSavedId({ id: 'x', matchedBy: 'name-unique', candidates: [] })).toBe(true);
    expect(shouldRewriteSavedId({ id: 'x', matchedBy: 'name-ambiguous', candidates: ['x'] })).toBe(true);
  });

  it('does NOT rewrite on an exact hit (nothing changed) or on none', () => {
    expect(shouldRewriteSavedId({ id: 'x', matchedBy: 'exact-id', candidates: [] })).toBe(false);
    // ⚠ Especially not on `none`: clearing the saved id would destroy the only
    // record of which device the patch wanted, so a later reconnect of that
    // exact device could never match it again.
    expect(shouldRewriteSavedId({ id: null, matchedBy: 'none', candidates: [] })).toBe(false);
  });
});

describe('resolveGamepadSlot — ⚠ the rules are INVERTED, and that is the fix', () => {
  const pad = (slot: number, id: string) => ({ slot, id });
  const PS = '054c-05c4-Wireless Controller';
  const XB = '045e-02fd-Xbox Wireless Controller';

  it('1. the same model at the remembered slot — the quiet common case', () => {
    const r = resolveGamepadSlot({ slot: 1, id: PS }, [pad(0, XB), pad(1, PS)]);
    expect(r).toEqual({ slot: 1, matchedBy: 'id-at-slot' });
  });

  it('2. ⚠ THE BUG THIS FIXES: the pads came up in a different order', () => {
    // The player pressed the Xbox pad first this time, so IT took slot 0 and the
    // PlayStation pad landed in slot 1... except the node remembered slot 0.
    // Keying off the slot alone silently hands this node the WRONG controller;
    // following the id moves it.
    const r = resolveGamepadSlot({ slot: 0, id: PS }, [pad(0, XB), pad(1, PS)]);
    expect(r).toEqual({ slot: 1, matchedBy: 'id-elsewhere' });
  });

  it('2b. …and picks the LOWEST matching slot, independent of array order', () => {
    const forward = resolveGamepadSlot({ slot: 3, id: PS }, [pad(1, PS), pad(2, PS)]);
    const shuffled = resolveGamepadSlot({ slot: 3, id: PS }, [pad(2, PS), pad(1, PS)]);
    expect(forward).toEqual({ slot: 1, matchedBy: 'id-elsewhere' });
    expect(shuffled).toEqual(forward);
  });

  it('3. ⚠ an OLD patch with no saved id behaves EXACTLY as it does today', () => {
    // The backward-compatibility contract: bind whatever is in the slot.
    const r = resolveGamepadSlot({ slot: 1 }, [pad(0, XB), pad(1, PS)]);
    expect(r).toEqual({ slot: 1, matchedBy: 'slot-only' });
  });

  it('3b. a DIFFERENT controller in the remembered slot is still bound', () => {
    // The player swapped hardware. Refusing would leave the module dead with a
    // pad plugged in, which is worse than binding the pad that is actually there.
    const r = resolveGamepadSlot({ slot: 0, id: PS }, [pad(0, XB)]);
    expect(r).toEqual({ slot: 0, matchedBy: 'slot-only' });
  });

  it('4. nothing connected at all → none', () => {
    expect(resolveGamepadSlot({ slot: 0, id: PS }, [])).toEqual({ slot: null, matchedBy: 'none' });
  });

  it('⚠ TWO IDENTICAL PADS STAY PUT — `gamepad.id` is a MODEL string', () => {
    // Two of the same controller are indistinguishable by id, so the ONLY thing
    // keeping a two-pad rig stable is rule 1 preferring the remembered slot.
    // Assert both nodes keep their own pad rather than both resolving to slot 0.
    const pads = [pad(0, PS), pad(1, PS)];
    expect(resolveGamepadSlot({ slot: 0, id: PS }, pads).slot).toBe(0);
    expect(resolveGamepadSlot({ slot: 1, id: PS }, pads).slot).toBe(1);
  });

  it('⚠ NEGATIVE CONTROL: slot-only keying DOES pick the wrong pad', () => {
    // The pre-fix behaviour, on the rule-2 fixture: reading `pads[slot]` blindly
    // hands slot 0 to a node that wanted the PlayStation pad.
    const pads = [pad(0, XB), pad(1, PS)];
    const naive = pads.find((p) => p.slot === 0)!;
    expect(naive.id).toBe(XB);
    // …and the resolver disagrees, which is the whole assertion.
    expect(resolveGamepadSlot({ slot: 0, id: PS }, pads).slot).toBe(1);
  });
});

// ── bindMidiPort — THE MIDI MODULE FACTORY'S PICK ───────────────────────────
//
// ⚠ THIS IS THE SEAM THE OWNER'S 2026-09-02 REPORT LANDED ON. Every MIDI
// module's SURFACE has written `data.lastDeviceName` since #2228 and not one
// FACTORY ever read it back, so a reloaded patch could only match on
// `data.lastDeviceId` — the implementation-defined `MIDIPort.id` that Chrome
// regenerates between sessions. midiOutBuddy compounded it: its grant path
// GUARDED the pick (`if (!selectedDeviceId)`), so a stale-but-truthy saved id
// blocked the pick outright and left the module bound to a port that does not
// exist — a blank picker and total silence.
//
// Each case names which half it covers, and the NEGATIVE CONTROL reproduces
// both pre-fix answers so the fix cannot be read as a no-op.
describe('bindMidiPort — the MIDI factory pick', () => {
  // Two ports whose ids came from THIS session. The saved patches below
  // remember last session's ids, which no longer exist.
  const ports = [dev('s2-a', 'Decoy Out A'), dev('s2-b', 'Target Out B')];

  it('1. an exact id still enumerated wins, and nothing moves', () => {
    expect(bindMidiPort({ id: 's2-a', name: 'Decoy Out A' }, ports)).toEqual({
      id: 's2-a',
      matchedBy: 'exact-id',
      candidates: [],
    });
  });

  it('2. ⚠ A REGENERATED ID HEALS BY NAME — the owner-reported case', () => {
    // What a reloaded patch actually carries: last session's id (gone) plus the
    // name #2228 started persisting for exactly this moment.
    expect(bindMidiPort({ id: 's1-b', name: 'Target Out B' }, ports)).toEqual({
      id: 's2-b',
      matchedBy: 'name-unique',
      candidates: [],
    });
  });

  it('2b. NEGATIVE CONTROL: both pre-fix answers, on that same fixture', () => {
    // (a) midiOutBuddy's guarded grant path kept the stale id verbatim — a port
    //     the browser does not have. Blank picker, no bytes.
    const guarded = 's1-b';
    expect(ports.some((p) => p.id === guarded)).toBe(false);
    // (b) its three siblings dropped through to "the first port", which IS a
    //     real port and therefore looks fine — while addressing another synth.
    expect(ports[0]!.id).toBe('s2-a');
    // The resolver disagrees with BOTH, which is the whole assertion.
    expect(bindMidiPort({ id: 's1-b', name: 'Target Out B' }, ports).id).toBe('s2-b');
  });

  it('3. an AMBIGUOUS name binds deterministically and REPORTS every candidate', () => {
    // The Windows/WinMM shape the launchpad binder already documents: one piece
    // of hardware exposing several interfaces under one name.
    const twins = [dev('p1', 'Launchpad'), dev('p2', 'Launchpad')];
    expect(bindMidiPort({ id: 'gone', name: 'Launchpad' }, twins)).toEqual({
      id: 'p1',
      matchedBy: 'name-ambiguous',
      candidates: ['p1', 'p2'],
    });
  });

  it('4. nothing matched but ports exist → FIRST AVAILABLE, reported as such', () => {
    // Preserves what a never-bound module already did, and applies it to an
    // unresolvable saved binding too: a real port a player can see and change
    // beats a blank picker that sends nothing.
    expect(bindMidiPort({ id: 'gone', name: 'A Synth That Left' }, ports)).toEqual({
      id: 's2-a',
      matchedBy: 'first-available',
      candidates: [],
    });
  });

  it('4b. …and `first-available` is never reported as a MATCH', () => {
    // The distinction is the point: "this is your synth" and "this is A synth"
    // are different claims, and a surface that conflates them tells a player
    // their gear is bound when it is not.
    const r = bindMidiPort({ id: 'gone', name: 'A Synth That Left' }, ports);
    expect(['exact-id', 'name-unique', 'name-ambiguous']).not.toContain(r.matchedBy);
  });

  it('5. no ports at all → none, never an invented id', () => {
    expect(bindMidiPort({ id: 's1-b', name: 'Target Out B' }, [])).toEqual({
      id: null,
      matchedBy: 'none',
      candidates: [],
    });
  });

  it("6. a never-bound module takes the first port — today's behaviour, unchanged", () => {
    expect(bindMidiPort({ id: null, name: null }, ports)).toEqual({
      id: 's2-a',
      matchedBy: 'first-available',
      candidates: [],
    });
  });

  it('7. a BLANK saved name never matches — it would match every unnamed port', () => {
    const unnamed = [dev('u1', ''), dev('u2', '')];
    expect(bindMidiPort({ id: 'gone', name: '' }, unnamed).matchedBy).toBe('first-available');
  });
});

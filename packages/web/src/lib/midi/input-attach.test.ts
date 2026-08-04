// packages/web/src/lib/midi/input-attach.test.ts
//
// The MIDI input handler-slot seam.
//
// ── WHAT THIS FILE IS STRUCTURALLY UNABLE TO SEE ───────────────────────────
//
// Stated so a green run is not read as more than it is:
//   · It runs against a FAKE `MidiInputLike` whose `onmidimessage` is a plain
//     accessor pair. It does not execute a browser MIDI stack, so it cannot
//     confirm what Chromium does with two separately-requested MIDIAccess
//     objects. That was settled by MEASUREMENT instead — see the header of
//     `input-attach.ts` for the numbers.
//   · Because of that measurement, the shared-access world modelled here is
//     the PESSIMISTIC one: it is what the e2e/unit MIDI doubles do (one
//     `access` object handed to every `requestMIDIAccess()` caller), and it is
//     what any future single-shared-access refactor would create. Production
//     Chromium currently isolates by access. The seam must be correct in both.

import { describe, it, expect } from 'vitest';
import { createMidiInputClaim } from './input-attach';
import type { MidiEventLike, MidiInputLike } from '$lib/audio/modules/midi-cv-buddy';

// ---------------------------------------------------------------------------
// A fake input whose handler slot behaves exactly like the real single-slot
// property: assignment replaces, `= null` evicts, and only ONE function is ever
// reachable. `fire()` is the wire.
// ---------------------------------------------------------------------------
function makeInput(id: string): MidiInputLike & { fire(bytes: number[]): void } {
  let handler: ((ev: MidiEventLike) => void) | null = null;
  return {
    id,
    name: id,
    state: 'connected',
    get onmidimessage() {
      return handler;
    },
    set onmidimessage(h) {
      handler = h as ((ev: MidiEventLike) => void) | null;
    },
    fire(bytes) {
      handler?.({ data: new Uint8Array(bytes), timeStamp: 0 });
    },
  };
}

const NOTE = [0x90, 60, 100];

describe('createMidiInputClaim: attach / detach by identity', () => {
  it('attach installs the handler and delivers', () => {
    const inp = makeInput('a');
    const seen: number[][] = [];
    const claim = createMidiInputClaim('t');
    claim.attach(inp, (ev) => seen.push([...ev.data]));
    inp.fire(NOTE);
    expect(seen).toEqual([NOTE]);
    expect(claim.owns(inp)).toBe(true);
    expect(claim.claimedIds()).toEqual(['a']);
  });

  it('detach releases OUR slot and stops delivery', () => {
    const inp = makeInput('a');
    const seen: number[][] = [];
    const claim = createMidiInputClaim('t');
    claim.attach(inp, (ev) => seen.push([...ev.data]));
    claim.detach();
    inp.fire(NOTE);
    expect(seen).toEqual([]);
    expect(inp.onmidimessage).toBeNull();
    expect(claim.size()).toBe(0);
  });

  it('detach NEVER clears a slot the claim did not install', () => {
    const inp = makeInput('a');
    const claim = createMidiInputClaim('t');
    const foreign = (): void => {};
    inp.onmidimessage = foreign; // installed by somebody else, not via the claim
    claim.detach();
    expect(inp.onmidimessage, 'a foreign handler must survive our detach').toBe(foreign);
  });

  it('detach NEVER clears a slot a LATER owner took over (identity, not presence)', () => {
    const inp = makeInput('a');
    const claim = createMidiInputClaim('t');
    claim.attach(inp, () => {});
    // Somebody else legitimately takes the slot afterwards.
    const later = (): void => {};
    inp.onmidimessage = later;
    claim.detach();
    expect(inp.onmidimessage, 'the newer owner keeps the slot').toBe(later);
  });

  it('detachFrom on an input we never held is a no-op', () => {
    const inp = makeInput('a');
    const foreign = (): void => {};
    inp.onmidimessage = foreign;
    createMidiInputClaim('t').detachFrom(inp);
    expect(inp.onmidimessage).toBe(foreign);
  });

  it('re-attaching to a held input replaces only our own handler', () => {
    const inp = makeInput('a');
    const seen: string[] = [];
    const claim = createMidiInputClaim('t');
    claim.attach(inp, () => seen.push('first'));
    claim.attach(inp, () => seen.push('second'));
    inp.fire(NOTE);
    expect(seen).toEqual(['second']);
    expect(claim.size(), 'still one input held, not two').toBe(1);
  });
});

describe('attachOnly: re-target changes what WE listen to, never the access', () => {
  it('moves the claim from one input to another', () => {
    const a = makeInput('a');
    const b = makeInput('b');
    const seen: string[] = [];
    const claim = createMidiInputClaim('t');
    const h = (): void => void seen.push('hit');

    claim.attachOnly([a], h);
    expect(claim.claimedIds()).toEqual(['a']);
    claim.attachOnly([b], h);
    expect(claim.claimedIds()).toEqual(['b']);

    a.fire(NOTE);
    expect(seen, 'the old port was released').toEqual([]);
    b.fire(NOTE);
    expect(seen, 'the new port delivers').toEqual(['hit']);
  });

  it('attachOnly([]) releases everything the claim holds', () => {
    const a = makeInput('a');
    const claim = createMidiInputClaim('t');
    claim.attachOnly([a], () => {});
    claim.attachOnly([], () => {});
    expect(claim.size()).toBe(0);
    expect(a.onmidimessage).toBeNull();
  });

  it('re-targeting leaves OTHER subsystems on the same inputs untouched', () => {
    // The exact shape of the old bug: one access, several consumers.
    const a = makeInput('a');
    const b = makeInput('b');
    const bystander: string[] = [];
    // A "push-shaped" subsystem owns port b.
    const push = createMidiInputClaim('push');
    push.attach(b, () => bystander.push('push'));

    // A "lane-shaped" subsystem re-targets across the same access, twice.
    const lane = createMidiInputClaim('lane');
    lane.attachOnly([a], () => {});
    lane.attachOnly([b], () => {}); // now BOTH want b — last writer wins the slot
    lane.attachOnly([a], () => {}); // …and lane moves off again

    // lane released b, but only because it still held lane's own handler.
    // The push handler was displaced by lane's attach — a genuine last-writer
    // collision, which is why two claims must never target the same port.
    expect(lane.claimedIds()).toEqual(['a']);
    expect(b.onmidimessage, 'lane released the slot it took').toBeNull();

    // Re-assert the ordinary case: no overlap, no interference.
    push.attach(b, () => bystander.push('push'));
    lane.attachOnly([a], () => {});
    lane.detach();
    b.fire(NOTE);
    expect(bystander, 'push keeps delivering across lane re-target + dispose').toEqual(['push']);
  });
});

describe('hotplug', () => {
  it('a device appearing is picked up without dropping the live ones', () => {
    const a = makeInput('a');
    const seen: string[] = [];
    const claim = createMidiInputClaim('t');
    const h = (ev: MidiEventLike): void => void seen.push(String(ev.data[1]));

    claim.attachOnly([a], h); // one device present
    const b = makeInput('b'); // …then one is plugged in
    claim.attachOnly([a, b], h);
    expect(claim.claimedIds()).toEqual(['a', 'b']);

    a.fire([0x90, 1, 1]);
    b.fire([0x90, 2, 1]);
    expect(seen).toEqual(['1', '2']);
  });

  it('a device disappearing is dropped without leaking a subscriber', () => {
    const a = makeInput('a');
    const b = makeInput('b');
    const claim = createMidiInputClaim('t');
    claim.attachOnly([a, b], () => {});
    claim.attachOnly([a], () => {}); // b unplugged; the access no longer lists it
    expect(claim.claimedIds()).toEqual(['a']);
    expect(claim.owns(b)).toBe(false);
    expect(b.onmidimessage, 'the vanished port was released, not leaked').toBeNull();
  });

  it('detach() after a hotplug churn leaves nothing behind', () => {
    const inputs = [makeInput('a'), makeInput('b'), makeInput('c')];
    const claim = createMidiInputClaim('t');
    claim.attachOnly(inputs, () => {});
    claim.attachOnly(inputs.slice(0, 2), () => {});
    claim.attachOnly(inputs, () => {});
    claim.detach();
    expect(claim.size()).toBe(0);
    for (const i of inputs) expect(i.onmidimessage).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// THE REGRESSION THE PR EXISTS FOR — and its PERMANENT negative control.
//
// One shared MIDIAccess (what the e2e/unit doubles hand every caller, and what
// any single-shared-access refactor would create). A control surface holds a
// port; an audio module spawns, re-points and disposes. The surface must keep
// receiving.
//
// The negative control is not a one-off "revert it and look" — the pre-fix
// routine is reproduced verbatim below and asserted to KILL the bystander on
// every run. If the destructive shape ever stopped being destructive, this
// file would go red and tell us the test had stopped testing anything.
// ---------------------------------------------------------------------------
describe('a disposing subsystem must not silence its neighbour (shared access)', () => {
  function sharedAccess(): {
    inputs: Map<string, MidiInputLike & { fire(b: number[]): void }>;
    values(): (MidiInputLike & { fire(b: number[]): void })[];
  } {
    const a = makeInput('surface-port');
    const b = makeInput('keyboard-port');
    const inputs = new Map([
      [a.id, a],
      [b.id, b],
    ]);
    return { inputs, values: () => [...inputs.values()] };
  }

  it('NEGATIVE CONTROL — the PRE-FIX sweep really does kill the bystander', () => {
    const acc = sharedAccess();
    const heard: string[] = [];
    const surface = createMidiInputClaim('surface');
    surface.attach(acc.inputs.get('surface-port')!, () => heard.push('surface'));

    // Verbatim the shape that shipped in midi-lane / midi-cv-buddy / midiclock:
    //   for (const inp of access.inputs.values()) inp.onmidimessage = null;
    for (const inp of acc.values()) inp.onmidimessage = null;

    acc.inputs.get('surface-port')!.fire(NOTE);
    expect(heard, 'the old sweep silences a handler it never installed').toEqual([]);
  });

  it('THE FIX — spawn, re-point and dispose leave the bystander delivering', () => {
    const acc = sharedAccess();
    const heard: string[] = [];
    const surface = createMidiInputClaim('surface');
    surface.attach(acc.inputs.get('surface-port')!, () => heard.push('surface'));

    const lane = createMidiInputClaim('lane');
    // spawn → pick the first non-surface device
    lane.attachOnly([acc.inputs.get('keyboard-port')!], () => {});
    acc.inputs.get('surface-port')!.fire(NOTE);
    // re-point → user changes the lane's device to none and back
    lane.attachOnly([], () => {});
    lane.attachOnly([acc.inputs.get('keyboard-port')!], () => {});
    acc.inputs.get('surface-port')!.fire(NOTE);
    // dispose
    lane.detach();
    acc.inputs.get('surface-port')!.fire(NOTE);

    expect(heard, 'one delivery per fire, across spawn + re-point + dispose').toEqual([
      'surface',
      'surface',
      'surface',
    ]);
  });

  it('and the bystander is not merely never-silenced — it can still be released BY ITS OWN OWNER', () => {
    // Guards against the opposite failure: a seam that simply never nulls
    // anything would pass the test above while leaking every handler forever.
    const acc = sharedAccess();
    const heard: string[] = [];
    const surface = createMidiInputClaim('surface');
    surface.attach(acc.inputs.get('surface-port')!, () => heard.push('surface'));
    surface.detach();
    acc.inputs.get('surface-port')!.fire(NOTE);
    expect(heard).toEqual([]);
    expect(acc.inputs.get('surface-port')!.onmidimessage).toBeNull();
  });
});

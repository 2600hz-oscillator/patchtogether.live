// packages/web/src/lib/midi/input-attach.ts
//
// THE ONE PLACE IN THE APP THAT ASSIGNS `MIDIInput.onmidimessage`.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
//
// `onmidimessage` is a SINGLE-SLOT property, not an `addEventListener` target:
// the last assignment to a given `MIDIInput` object silently displaces whoever
// held it, and `= null` silently evicts them. Eight files used to assign it
// directly, and four of those ran the DESTRUCTIVE shape
//
//     for (const inp of access.inputs.values()) inp.onmidimessage = null;
//
// on every device re-target AND on dispose — i.e. "clear every handler on this
// access, including ones I never installed".
//
// ── WHAT THE BROWSER ACTUALLY DOES (MEASURED, NOT ASSUMED) ─────────────────
//
// Measured on Chromium 2026-08-03 against real CoreMIDI hardware (IAC Driver,
// Ableton Push 2 Live/User, Novation LCXL3, Network RTP):
//
//   · `navigator.requestMIDIAccess()` returns a DISTINCT `MIDIAccess` per call
//     (`a1 === a2` → false).
//   · For the SAME port id, `a1.inputs.get(id) === a2.inputs.get(id)` → FALSE
//     for all 6 ports. Each access owns its own `MIDIInput` wrapper objects.
//   · Therefore the handler SLOTS are independent: with a handler installed via
//     `a1`, running the destructive sweep over `a2.inputs` left `a1`'s handler
//     installed (`typeof a1input.onmidimessage === 'function'` after `a2`
//     nulled everything it could see).
//
// So the sweep can only hurt a subsystem that shares the SAME `MIDIAccess`
// object — which in this app means "another consumer of the same singleton",
// and in the e2e/unit MIDI doubles means EVERYTHING, because those doubles
// return one shared `access` to every `requestMIDIAccess()` caller.
//
// That makes the sweep a latent footgun rather than the live cross-device kill
// it was first read as — and the fix is the same either way, because the rule
// it violates is not about MIDI at all:
//
//     NEVER CLEAR A SLOT YOU DID NOT SET.
//
// ── THE CONTRACT ───────────────────────────────────────────────────────────
//
// A `MidiInputClaim` remembers, per input, the EXACT handler function it
// installed. Releasing compares the slot's CURRENT value against that
// remembered reference by IDENTITY and only nulls on a match. A newer owner is
// therefore never evicted, and a claim's `detach()` can never reach a handler
// it did not install — which is precisely the property `dispose()` needs.
//
// The Launchpad already had to discover half of this by hand: binding L then R
// nulled the freshly-wired LEFT input on real hardware (dead LEFT pads), fixed
// there with a bespoke `inputStillBound()` guard. This seam generalises that
// fix so every subsystem gets it, including `unbindUnit`, which never had it.
//
// ── COST ───────────────────────────────────────────────────────────────────
//
// ZERO on the real-time path. `attach` still assigns the caller's own function
// straight into `onmidimessage`; there is no wrapper closure, no dispatch list
// and no extra frame between the browser and the consumer, so message ordering
// and latency are bit-for-bit what they were. The bookkeeping is one `Map`
// set/delete per ATTACH/DETACH — lifecycle events measured in "a handful per
// session", never per message.

import type { MidiEventLike, MidiInputLike } from '$lib/audio/modules/midi-cv-buddy';

export type MidiInputHandler = (ev: MidiEventLike) => void;

export interface MidiInputClaim {
  /** Subsystem name — diagnostics only, never behaviour. */
  readonly owner: string;
  /** Install `handler` on `input` and remember it as ours. Re-attaching to an
   *  input we already hold just replaces our own handler. */
  attach(input: MidiInputLike, handler: MidiInputHandler): void;
  /** Listen on EXACTLY `inputs` and nothing else: attach to each, and release
   *  every OTHER input this claim currently holds. This is the re-target
   *  primitive — it changes which inputs *we* listen to and is structurally
   *  incapable of touching another claim's slots. */
  attachOnly(inputs: Iterable<MidiInputLike>, handler: MidiInputHandler): void;
  /** Release one input, if (and only if) the slot still holds OUR handler. */
  detachFrom(input: MidiInputLike): void;
  /** Release every input this claim installed. Safe in `dispose()`. */
  detach(): void;
  /** Does this claim currently hold `input`? */
  owns(input: MidiInputLike): boolean;
  /** Port ids currently held, sorted — for assertions and diagnostics. */
  claimedIds(): string[];
  /** How many inputs this claim holds. */
  size(): number;
}

/**
 * Create an identity-scoped claim on MIDI input handler slots.
 *
 * `owner` is a short subsystem name (`'midi-lane'`, `'push2'`, …) used only in
 * diagnostics; two claims with the same name are still independent objects.
 */
export function createMidiInputClaim(owner: string): MidiInputClaim {
  /** input object → the exact function reference WE wrote into its slot. */
  const installed = new Map<MidiInputLike, MidiInputHandler>();

  function attach(input: MidiInputLike, handler: MidiInputHandler): void {
    // Assign the caller's own function — no wrapper, so no per-message cost.
    input.onmidimessage = handler;
    installed.set(input, handler);
  }

  function detachFrom(input: MidiInputLike): void {
    const mine = installed.get(input);
    if (mine === undefined) return; // never ours — leave it strictly alone
    installed.delete(input);
    // THE WHOLE POINT: only clear a slot that still holds OUR handler. If a
    // later owner took it, `current !== mine` and we leave them running.
    if (input.onmidimessage === mine) input.onmidimessage = null;
  }

  function attachOnly(inputs: Iterable<MidiInputLike>, handler: MidiInputHandler): void {
    const next = new Set<MidiInputLike>(inputs);
    for (const held of [...installed.keys()]) {
      if (!next.has(held)) detachFrom(held);
    }
    for (const inp of next) attach(inp, handler);
  }

  return {
    owner,
    attach,
    attachOnly,
    detachFrom,
    detach() {
      for (const held of [...installed.keys()]) detachFrom(held);
    },
    owns: (input) => installed.has(input),
    claimedIds: () => [...installed.keys()].map((i) => i.id).sort(),
    size: () => installed.size,
  };
}

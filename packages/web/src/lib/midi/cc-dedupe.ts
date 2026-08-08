// packages/web/src/lib/midi/cc-dedupe.ts
//
// REDUNDANT-CC SUPPRESSION — the pure delta + echo-window state machine.
//
// PROVENANCE: this is `FeedbackState`, lifted VERBATIM out of
// `$lib/electra/feedback.ts` (which now re-exports it, so Electra's callers and
// its existing unit tests are untouched). It was already the right thing; it was
// just namespaced to one device. Nothing about the logic is Electra-specific —
// it is "don't retransmit a CC whose value has not changed", which every
// outbound-CC consumer needs.
//
// WHY IT MATTERS BEYOND TIDINESS. A DIN MIDI cable carries ~1040 CC/s. A single
// automation lane rasterized to 7-bit resolution can trivially exceed that, and
// the excess does not merely waste bandwidth — it delays every OTHER message
// queued behind it, so a stuck-full pipe turns into audible timing error on
// notes and clock. Suppressing unchanged values is the cheapest large win
// available, and it is what makes a naive "emit on every tick" rasterizer safe:
// the rasterizer can be dumb because this is not.
//
// TWO INDEPENDENT SUPPRESSIONS, and they are NOT the same thing:
//
//   1. DELTA DEDUPE (`lastSent`) — applies to EVERY device. Skip a value equal
//      to the last one transmitted for that key.
//
//   2. ECHO WINDOW (`inboundCc` + `inboundAt`) — applies ONLY to devices that
//      talk back. When an inbound CC writes a param, the param change would
//      otherwise echo the same CC straight back to the device, producing a
//      feedback loop / value judder on a motorized control.
//
//      ⚠ For a RECEIVE-ONLY device (Hologram Chroma Console, and 6 of the 6
//      devices surveyed in the device-control research) leg 2 is INERT: nothing
//      ever calls `noteInbound`, so `inboundCc` stays undefined and the branch
//      cannot fire. That is correct, but do NOT read the presence of this
//      machinery as evidence that such a device reports its state. It does not.
//      The app is permanently the authority and the device is permanently
//      desyncable by a human hand on the physical knob.
//
// PURE: no timers, no MIDI, no DOM. `now` is injected at every call site.

/** Per-control bookkeeping. */
interface ControlFb {
  /** Last CC we SENT for this control (delta dedupe). */
  lastSent?: number;
  /** Last CC the DEVICE sent US (echo-suppression token). Never set for a
   *  receive-only device. */
  inboundCc?: number;
  /** performance.now() of that inbound, for the suppression window. */
  inboundAt?: number;
}

export const ECHO_WINDOW_MS = 120;

/**
 * Pure suppression state machine. Tracks per-key sent/inbound CCs and decides
 * whether a given update should actually be transmitted.
 *
 * KEY CHOICE IS THE CALLER'S, and it is load-bearing. The key must identify
 * everything that makes two messages the same message on the wire — for a
 * device transmitter that is `(portId, channel, cc)`, NOT just `cc`. Keying on
 * `cc` alone would suppress a legitimate send after the user switches output
 * port or MIDI channel, leaving the newly-addressed device at a stale value
 * with no message ever sent to correct it. See `ccSuppressionKey`.
 */
export class CcSuppressor {
  private byKey = new Map<string, ControlFb>();
  private readonly echoWindowMs: number;

  constructor(opts: { echoWindowMs?: number } = {}) {
    this.echoWindowMs = opts.echoWindowMs ?? ECHO_WINDOW_MS;
  }

  /** Record that the DEVICE sent us this CC for `key` at `now` (so a same-value
   *  echo back to the device within the window is suppressed). Call from the
   *  inbound CC handler BEFORE the param write lands. Never called for a
   *  receive-only device. */
  noteInbound(key: string, cc: number, now: number): void {
    const fb = this.get(key);
    fb.inboundCc = cc;
    fb.inboundAt = now;
  }

  /**
   * Decide whether to send `cc` for `key` at `now`. Returns true (and records
   * it as lastSent) when the update should go out; false to skip. Skips when:
   *   - cc === lastSent (no change — delta dedupe), OR
   *   - cc === the inbound CC still inside the echo window (would echo the
   *     device's own move straight back).
   */
  shouldSend(key: string, cc: number, now: number): boolean {
    const fb = this.get(key);
    if (fb.lastSent === cc) return false;
    if (
      fb.inboundCc === cc &&
      fb.inboundAt !== undefined &&
      now - fb.inboundAt < this.echoWindowMs
    ) {
      // Still record as sent so we don't keep re-evaluating; the device already
      // shows this value (it originated there).
      fb.lastSent = cc;
      return false;
    }
    fb.lastSent = cc;
    return true;
  }

  /** Forget a control (e.g. on regenerate). */
  forget(key: string): void {
    this.byKey.delete(key);
  }

  /**
   * Drop ALL memory of what has been sent, so the very next `shouldSend` for
   * every key returns true.
   *
   * THIS IS THE "PUSH STATE TO DEVICE" PRIMITIVE, and it is why the resync
   * feature needs no special path through the transmitter: forget what we think
   * the device knows, then write every value again. It is also the REQUIRED
   * response to anything that invalidates the cache's premise — the output port
   * changing, the MIDI channel changing, a device disconnect/reconnect. After
   * any of those, "the last value we sent" is a statement about a different
   * device (or about a device that has since been power-cycled and reset to its
   * own stored preset), and continuing to trust it silently strands the
   * hardware at a value the app believes it already sent.
   */
  clear(): void {
    this.byKey.clear();
  }

  /** How many keys are currently remembered. Test/diagnostic surface — a
   *  suppressor that never clears is a leak, and a suppressor that clears too
   *  eagerly is a flood; both are visible here. */
  get size(): number {
    return this.byKey.size;
  }

  private get(key: string): ControlFb {
    let fb = this.byKey.get(key);
    if (!fb) {
      fb = {};
      this.byKey.set(key, fb);
    }
    return fb;
  }
}

/**
 * The canonical suppression key for an outbound device CC.
 *
 * Includes the PORT and the CHANNEL, not just the controller number, because
 * those are exactly the two things that can change underneath a running module
 * and make the cached "last sent" value a claim about the wrong destination.
 */
export function ccSuppressionKey(portId: string, channel: number, cc: number): string {
  return `${portId}::${channel}::${cc}`;
}

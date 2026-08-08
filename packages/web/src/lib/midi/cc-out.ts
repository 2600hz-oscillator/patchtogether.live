// packages/web/src/lib/midi/cc-out.ts
//
// OUTBOUND CONTROL-CHANGE TRANSMISSION — the seam the repo did not have.
//
// Before this file, the ONLY CC any module emitted was All-Notes-Off
// (`midi-out-buddy.ts`), and arbitrary CC send existed solely inside
// `electra/broker.ts`, scoped to Electra's own ports and allocation table.
// Every external-device proposal needs arbitrary outbound CC, so it lives here
// rather than inside any one device module.
//
// THREE LAYERS, deliberately separated by testability:
//
//   1. ENCODERS (`ccMessage`, `cc14Messages`) — pure `number → Uint8Array`.
//      No state, no I/O. These are the only place the MIDI byte layout is
//      written down.
//   2. THE LEDGER (`CcTransmitRecord`) — what was attempted and whether it
//      reached a port. Modelled on the audition ledger: `delivered: false` is
//      RECORDED, never dropped, because "wrote into the void" and "never
//      wrote" must be distinguishable from the outside.
//   3. THE TRANSMITTER (`createCcTransmitter`) — resolves the port, applies
//      suppression, encodes, sends, records. The only impure layer.
//
// ⚠ WHAT THIS FILE DOES NOT DO, and must not be read as doing:
//   * It does not know the device's state. Nothing here reads back. For the
//     device that motivated it (Hologram Chroma Console) read-back does not
//     exist at all — the app is the authority, and a human hand on the physical
//     knob desyncs it with no way for us to notice.
//   * It does not arbitrate between multiple transmitters. Two browser tabs, or
//     two multiplayer peers, that both resolve the same output port will both
//     send. Single-transmitter election is an open owner-facing question and is
//     deliberately NOT solved here.

import { CcSuppressor, ccSuppressionKey } from './cc-dedupe';

// ─────────────────────────────── encoders ───────────────────────────────

/** MIDI status nibble for Control Change. */
const STATUS_CC = 0xb0;

/**
 * The LSB of a 14-bit CC pair lives at `MSB + 32`. This is the MIDI spec's
 * fixed convention, not a per-device choice, which is why it is a constant here
 * rather than a descriptor field: three of the six devices surveyed use exactly
 * this and none of them uses anything else.
 */
export const CC14_LSB_OFFSET = 32;

/**
 * Highest controller number that can carry a 14-bit MSB. Controllers 0..31 pair
 * with 32..63; a "14-bit CC 64" would collide its LSB with controller 96, which
 * is a defined function (Data Increment), so it is not representable.
 */
export const CC14_MAX_MSB = 31;

/** Clamp to the 7 bits a CC data byte actually has. */
function clamp7(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(127, Math.round(v)));
}

/** Clamp to the 14 bits an MSB/LSB pair carries. */
function clamp14(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(16383, Math.round(v)));
}

/**
 * Encode one 7-bit Control Change.
 *
 * `channel` is 1-based (the on-wire convention used everywhere else in this
 * repo — see `_helpers/midi.ts` `sendCc`, `push2-sysex.ts`). The 0..15 nibble
 * the spec wants is derived here, in ONE place, because a 1-vs-0 based channel
 * is the single most common off-by-one in MIDI code and the fix belongs at the
 * boundary rather than at every call site.
 */
export function ccMessage(channel: number, cc: number, value: number): Uint8Array {
  const nibble = (Math.round(channel) - 1) & 0x0f;
  return new Uint8Array([STATUS_CC | nibble, clamp7(cc), clamp7(value)]);
}

/**
 * Encode a 14-bit Control Change as its MSB/LSB pair, MSB first.
 *
 * Returns TWO messages; the caller must send them in order and adjacently. The
 * receiving device combines them, and a device that only understands 7-bit
 * still does something sane with the MSB alone (which is why MSB goes first).
 *
 * Throws for an MSB controller above `CC14_MAX_MSB` — that is a descriptor bug,
 * and silently emitting a colliding LSB would corrupt an unrelated controller
 * on the target device. Failing loudly at the encoder is much cheaper than
 * debugging why a pedal's Data Increment fires when you move a knob.
 */
export function cc14Messages(channel: number, cc: number, value14: number): Uint8Array[] {
  const msbCc = clamp7(cc);
  if (msbCc > CC14_MAX_MSB) {
    throw new RangeError(
      `cc14Messages: CC ${msbCc} cannot carry a 14-bit MSB (max ${CC14_MAX_MSB}); ` +
        `its LSB would land on CC ${msbCc + CC14_LSB_OFFSET}, which is a defined function. ` +
        `Declare this control as 7-bit in its device descriptor.`,
    );
  }
  const v = clamp14(value14);
  return [
    ccMessage(channel, msbCc, (v >> 7) & 0x7f),
    ccMessage(channel, msbCc + CC14_LSB_OFFSET, v & 0x7f),
  ];
}

// ─────────────────────────────── the ledger ───────────────────────────────

/** Why a transmit attempt produced no bytes on any wire. */
export type CcUndeliveredReason =
  /** No MIDI output port is currently resolved (none selected, or unplugged). */
  | 'no-port'
  /** The value was identical to the last one sent for this (port, channel, cc). */
  | 'suppressed-redundant'
  /** `MIDIOutput.send` threw — a port that vanished between resolve and send. */
  | 'send-threw';

/**
 * One transmit ATTEMPT. Recorded whether or not bytes left the machine.
 *
 * The `delivered` flag is the whole point, and it is the audition-ledger
 * discipline applied to MIDI: an attempt that reached nothing is recorded as
 * `delivered: false` rather than simply not appearing, so a test (and a user
 * staring at a dead pedal) can tell "the app never tried" apart from "the app
 * tried and there was nowhere to send it". Those two have completely different
 * causes and the same symptom.
 */
export interface CcTransmitRecord {
  /** Descriptor control id, or a synthetic id for a raw send. */
  controlId: string;
  /** 1-based MIDI channel. */
  channel: number;
  /** Controller number (the MSB controller, for a 14-bit send). */
  cc: number;
  /** The value handed to the transmitter, pre-encoding. */
  value: number;
  /** 7 or 14. */
  resolution: 7 | 14;
  /** Did bytes actually reach a MIDIOutput? */
  delivered: boolean;
  /** Present exactly when `delivered` is false. */
  reason?: CcUndeliveredReason;
  /** The port the bytes went to (or would have). */
  portId: string | null;
  /** `performance.now()` at the attempt. */
  at: number;
}

// ─────────────────────────────── transmitter ───────────────────────────────

/** The minimal slice of `MIDIOutput` this module uses. */
export interface CcOutputPort {
  id: string;
  name?: string | null;
  send(data: Uint8Array | number[], timestamp?: number): void;
}

export interface CcTransmitterOpts {
  /**
   * Resolve the CURRENT output port, called per send rather than captured once.
   * Returning `null` is a normal state (nothing selected / device unplugged),
   * not an error — the attempt is recorded as `delivered: false`.
   */
  resolvePort: () => CcOutputPort | null;
  /** Resolve the CURRENT 1-based MIDI channel, called per send. */
  resolveChannel: () => number;
  /** Injected clock. Defaults to `performance.now`. */
  now?: () => number;
  /** How many ledger records to retain. Bounded so a long session cannot grow
   *  without limit; the ledger is a diagnostic, not an audit log. */
  ledgerLimit?: number;
  /** Called for every record, delivered or not. */
  onRecord?: (record: CcTransmitRecord) => void;
}

export interface CcTransmitter {
  /**
   * Send one control's value. Returns the record so the caller can react to
   * `delivered` without re-reading the ledger.
   *
   * `value` is in RAW CC UNITS — 0..127 for a 7-bit control, 0..16383 for a
   * 14-bit one. Scaling from a param's own range is the descriptor layer's job,
   * not this one's; keeping this function unit-agnostic is what stops a second,
   * subtly-different scaling rule from growing here.
   */
  send(controlId: string, cc: number, value: number, resolution?: 7 | 14): CcTransmitRecord;
  /**
   * Forget every suppressed value, so the next `send` for every control
   * transmits even if unchanged. THIS IS "PUSH STATE TO DEVICE".
   *
   * Also the required response to a port or channel change — see
   * `CcSuppressor.clear`.
   */
  resync(): void;
  /** Every retained record, oldest first. */
  ledger(): readonly CcTransmitRecord[];
  /** Drop retained records (not the suppression state). */
  clearLedger(): void;
}

export function createCcTransmitter(opts: CcTransmitterOpts): CcTransmitter {
  const now = opts.now ?? (() => performance.now());
  const ledgerLimit = opts.ledgerLimit ?? 256;
  const suppressor = new CcSuppressor();
  const records: CcTransmitRecord[] = [];

  /** Remember the destination we last transmitted to. When it changes, the
   *  suppression cache describes a DIFFERENT device and must be dropped —
   *  otherwise switching port or channel strands the new device at whatever
   *  values it happened to have, with the app convinced it already sent them. */
  let lastPortId: string | null = null;
  let lastChannel: number | null = null;

  function record(r: CcTransmitRecord): CcTransmitRecord {
    records.push(r);
    if (records.length > ledgerLimit) records.splice(0, records.length - ledgerLimit);
    opts.onRecord?.(r);
    return r;
  }

  return {
    send(controlId, cc, value, resolution = 7) {
      const at = now();
      const port = opts.resolvePort();
      const channel = opts.resolveChannel();

      if (port?.id !== lastPortId || channel !== lastChannel) {
        suppressor.clear();
        lastPortId = port?.id ?? null;
        lastChannel = channel;
      }

      if (!port) {
        return record({
          controlId, channel, cc, value, resolution,
          delivered: false, reason: 'no-port', portId: null, at,
        });
      }

      // Suppress on the ENCODED value, not the raw one: two raw values that
      // round to the same 7-bit byte are the same message on the wire, and
      // sending it twice is exactly the redundancy this exists to remove.
      const encodedKeyValue = resolution === 14 ? clamp14(value) : clamp7(value);
      const key = ccSuppressionKey(port.id, channel, cc);
      if (!suppressor.shouldSend(key, encodedKeyValue, at)) {
        return record({
          controlId, channel, cc, value, resolution,
          delivered: false, reason: 'suppressed-redundant', portId: port.id, at,
        });
      }

      const messages =
        resolution === 14 ? cc14Messages(channel, cc, value) : [ccMessage(channel, cc, value)];

      try {
        for (const m of messages) port.send(m);
      } catch {
        // A port can vanish between resolve and send (the disconnect race this
        // whole module has to survive). Forget the suppressed value so a
        // reconnect re-sends it rather than trusting a write that never landed.
        suppressor.forget(key);
        return record({
          controlId, channel, cc, value, resolution,
          delivered: false, reason: 'send-threw', portId: port.id, at,
        });
      }

      return record({
        controlId, channel, cc, value, resolution,
        delivered: true, portId: port.id, at,
      });
    },

    resync() {
      suppressor.clear();
    },

    ledger() {
      return records;
    },

    clearLedger() {
      records.length = 0;
    },
  };
}

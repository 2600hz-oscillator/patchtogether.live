// packages/web/src/lib/devices/device-module.ts
//
// THE DEVICE MODULE MACHINERY — shared by every device module, parameterized by
// a descriptor. A second device supplies a descriptor and a ten-line def; all
// of the behaviour below is reused verbatim.
//
// ══════════════════ WHY GENERIC SLOTS AND NOT NAMED CC PARAMS ══════════════════
//
// The obvious design is one ParamDef per CC: `tilt`, `rate`, `time`, … That was
// rejected, and the reason is worth stating because it is not obvious and it is
// expensive to undo.
//
// A ParamDef id is PUBLIC and PERMANENT. It appears in `contract-lock.txt`, in
// every saved patch, in peers' Y.Docs, in Electra allocation tables, in MIDI-learn
// bindings, and in clip-automation targets (`{nodeId, paramId}`). Minting 34 of
// them per device means every future correction to a transcription — a CC number
// that turns out to be wrong, a control that is renamed, a device revision — is a
// data migration across all of those surfaces.
//
// So the module declares a FIXED, SMALL set of anonymous slots (`slot1`…`slot8`)
// and the *assignment* of a descriptor control to a slot is ordinary node data.
// The contract never moves; the descriptor is free to be corrected.
//
// ═══════════════════════════ WHY EIGHT, SPECIFICALLY ═══════════════════════════
//
// Not a round number — three independent constraints agree on it:
//
//   * `MAX_AUTOMATION_TRACKS` is 16 PER CLIP, across all modules. A device that
//     could occupy all 16 would starve every other module sharing the clip.
//     Half the budget is a defensible ceiling for one device.
//   * `PUSH_CARD_CONTROLS` shows exactly 8 controls. With 8 slots the override
//     is the complete slot list, so the push card cannot be re-ranked by a
//     future param addition — it is correct BY CONSTRUCTION rather than pinned.
//   * `curatedFace`'s full-in-lane tier caps at 8.
//
// ════════════════════════════ OPEN-LOOP, ALWAYS ════════════════════════════
//
// `readParam` returns what the APP last wrote, never what the device holds. For
// a `readBack: 'none'` device there is nothing to read and no way to detect a
// hand moving a physical knob. Nothing in this file, and nothing in a card built
// on it, may present a value as confirmed by the hardware.

import type { ParamDef } from '$lib/graph/types';
import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import { requestMidiAccess, midiOutcomeMessage, type MIDIAccessLike } from '$lib/audio/midi-access';
import { audioTimeToPerformanceNow, measureCtxOffset } from '$lib/audio/midi-timing';
import {
  createCcTransmitter,
  type CcOutputPort,
  type CcTransmitRecord,
  type CcTransmitter,
} from '$lib/midi/cc-out';
import { quantize14, quantize7, rasterizeCcRamp } from '$lib/midi/cc-ramp';
import {
  controlById,
  controlMax,
  resolveSlots,
  type DeviceDescriptor,
  type ResolvedSlot,
} from './device-descriptor';

/** How many automatable slots a device module exposes. See the header. */
export const DEVICE_SLOT_COUNT = 8;

/** `['slot1', … 'slot8']`. */
export const DEVICE_SLOT_IDS: readonly string[] = Array.from(
  { length: DEVICE_SLOT_COUNT },
  (_, i) => `slot${i + 1}`,
);

/**
 * The slot ParamDefs.
 *
 * Every slot is 0..127 `linear`, regardless of what is assigned to it, because
 * the ParamDef is static and the assignment is not. The value IS the raw 7-bit
 * controller value — no rescaling anywhere, which removes a whole class of
 * "which end is normalized" bug.
 *
 * ⚠ `curve` stays `'linear'` even for a control the device quantizes. The
 * honest signal for that is the READOUT (`format: 'stepped-unmeasured'`), not
 * the curve: declaring `discrete` over 0..127 would claim 128 detents, which is
 * a different and equally false statement, and `param-vocabulary.test.ts`
 * would then require an `options` roster covering all 128 steps — a roster we
 * cannot honestly write, since the subdivision table is unpublished.
 */
export function deviceSlotParams(descriptor: DeviceDescriptor): ParamDef[] {
  return DEVICE_SLOT_IDS.map((slotId, index) => {
    const control = controlById(descriptor, descriptor.defaultSlots[index]);
    return {
      id: slotId,
      label: `slot ${index + 1}`,
      // The initially-assigned control's default, so a freshly spawned module
      // shows plausible knob positions. NOT a claim about the hardware.
      defaultValue: control?.default ?? 0,
      min: 0,
      max: 127,
      curve: 'linear' as const,
    };
  });
}

// ─────────────────────────── runtime status ───────────────────────────

export interface DeviceStatus {
  /** Has the user granted Web MIDI and picked (or auto-detected) a port? */
  connected: boolean;
  /** Chosen output port id, or null. */
  portId: string | null;
  /** Chosen output port name, or null. */
  portName: string | null;
  /** 1-based MIDI channel. */
  channel: number;
  /** Empty when fine; a human-readable reason otherwise. */
  problem: string;
  /** Slots whose saved assignment no longer resolves. Loud by design. */
  staleSlots: string[];
  /** Count of CC messages actually delivered since mount. */
  delivered: number;
  /** Count of attempts that reached nothing. */
  undelivered: number;
}

/** What the card can call, via `engine.read(node, 'card-api')`. */
export interface DeviceCardApi {
  /** Request Web MIDI. MUST be called straight from a click handler. */
  connect(): Promise<boolean>;
  /** Available output ports (id + name). */
  listOutputs(): { id: string; name: string }[];
  /** Choose an output, or `null` to detach. Resets suppression. */
  selectPort(portId: string | null): void;
  /** Set the 1-based MIDI channel. Resets suppression. */
  setChannel(channel: number): void;
  /**
   * PUSH EVERY SLOT'S CURRENT VALUE TO THE DEVICE.
   *
   * The only resync there is, and it is user-initiated on purpose: the device
   * cannot be queried, so "make the pedal match the screen" is the sole
   * reconciliation direction that exists. Returns how many messages went out.
   */
  pushAll(): number;
  /**
   * Fire an ACTION control (tap tempo, capture, …) immediately.
   *
   * Deliberately NOT a param write: it touches no Y.Doc and enters no undo
   * stack, so Cmd-Z cannot re-fire a destructive pedal command.
   */
  fireAction(controlId: string, value?: number): CcTransmitRecord | null;
  /** Current status for the card to render. */
  status(): DeviceStatus;
  /** Resolved slot assignments. */
  slots(): ResolvedSlot[];
  /** Assign a descriptor control to a slot (or `null` to clear). */
  assignSlot(slotId: string, controlId: string | null): void;
}

/** How the handle reaches the live patch node's data + params. */
export interface DeviceNodeAccess {
  /** Current `node.data.assign` map. */
  readAssign(): Record<string, string> | undefined;
  /** Persist an assignment change. */
  writeAssign(assign: Record<string, string>): void;
  /** Current value of a slot param. */
  readSlotValue(slotId: string): number;
}

export interface DeviceHandleOpts {
  descriptor: DeviceDescriptor;
  ctx: { currentTime: number };
  access: DeviceNodeAccess;
  /** Injected for tests. Defaults to `performance.now`. */
  nowMs?: () => number;
  /** Injected for tests. Defaults to `setTimeout`/`clearTimeout`. */
  scheduleTick?: (fn: () => void, ms: number) => unknown;
  cancelTick?: (handle: unknown) => void;
}

/**
 * How far ahead scheduled CC points are handed to Web MIDI.
 *
 * Short ON PURPOSE. `MIDIOutput.send(bytes, timestamp)` queues a message the
 * port will emit at that time, and the ONLY way to cancel a queued message is
 * `MIDIOutput.clear()`, which is PORT-WIDE — it would also destroy notes a
 * co-resident MIDI-OUT-BUDDY had queued on the same port. So instead of
 * dumping a whole ramp into the port queue, the ramp is drained a slice at a
 * time and a hold simply stops draining. The residual is at most this much
 * already-queued tail, which needs no cancel primitive at all.
 */
const SEND_LOOKAHEAD_MS = 30;

/** Drain interval for the pending ramp queue. */
const DRAIN_INTERVAL_MS = 15;

/** One not-yet-transmitted point of a rasterized ramp. */
interface PendingPoint {
  slotId: string;
  controlId: string;
  cc: number;
  resolution: 7 | 14;
  value: number;
  /** `performance.now()` domain. */
  atMs: number;
}

export interface DeviceHandle extends AudioDomainNodeHandle {
  /** Test seam — the transmitter, so a spec can read the ledger directly. */
  transmitter: CcTransmitter;
  /**
   * HOLD AT SEAM — the clip-automation param-jump policy, in MIDI terms.
   *
   * For a Web Audio param `holdParamAtSeam` cancels a scheduled ramp tail. Here
   * the equivalent is dropping the un-emitted remainder of the CC train and
   * pinning the value. Declared on this interface rather than the base handle
   * because it is a device-transport concern, not a general engine one.
   */
  holdParam(slotId: string, toValue?: number): void;
}

export function createDeviceHandle(opts: DeviceHandleOpts): DeviceHandle {
  const { descriptor, ctx, access } = opts;
  const nowMs = opts.nowMs ?? (() => (typeof performance !== 'undefined' ? performance.now() : 0));
  const scheduleTick =
    opts.scheduleTick ?? ((fn: () => void, ms: number) => setTimeout(fn, ms) as unknown);
  const cancelTick =
    opts.cancelTick ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let alive = true;
  let midiAccess: MIDIAccessLike | null = null;
  let portId: string | null = null;
  let channel = descriptor.defaultChannel;
  let problem = '';
  let ctxOffsetS = measureCtxOffset(ctx.currentTime, nowMs());
  let pending: PendingPoint[] = [];
  let drainHandle: unknown = null;

  /** Latest value the APP has written per slot. Never the device's value. */
  const lastWritten = new Map<string, number>();

  function outputs(): { id: string; name: string; port: CcOutputPort }[] {
    if (!midiAccess) return [];
    const list: { id: string; name: string; port: CcOutputPort }[] = [];
    for (const [id, raw] of midiAccess.outputs) {
      const p = raw as unknown as CcOutputPort & { state?: string };
      // Skip ports the browser has marked disconnected — sending to one throws,
      // and on Windows/Chrome a disconnected Chroma has been reported to crash
      // the tab. Filtering here is the cheap half of the defence; the try/catch
      // in the transmitter is the other half.
      if (p.state === 'disconnected') continue;
      list.push({ id, name: (raw.name as string | null) ?? id, port: p });
    }
    return list;
  }

  function resolvePort(): CcOutputPort | null {
    if (!portId) return null;
    return outputs().find((o) => o.id === portId)?.port ?? null;
  }

  const transmitter = createCcTransmitter({
    resolvePort,
    resolveChannel: () => channel,
    now: nowMs,
  });

  function slotState(): ResolvedSlot[] {
    return resolveSlots(descriptor, DEVICE_SLOT_IDS, access.readAssign());
  }

  function controlForSlot(slotId: string): ResolvedSlot | undefined {
    return slotState().find((s) => s.slotId === slotId);
  }

  /** Transmit one slot's value right now. */
  function sendSlot(slotId: string, value: number): CcTransmitRecord | null {
    const slot = controlForSlot(slotId);
    if (!slot?.control) return null;
    lastWritten.set(slotId, value);
    return transmitter.send(slot.control.id, slot.control.cc, value, slot.control.resolution);
  }

  // ───────────────────────── ramp draining ─────────────────────────

  function ensureDraining(): void {
    if (drainHandle !== null || pending.length === 0 || !alive) return;
    drainHandle = scheduleTick(drain, DRAIN_INTERVAL_MS);
  }

  function drain(): void {
    drainHandle = null;
    if (!alive) return;
    const horizon = nowMs() + SEND_LOOKAHEAD_MS;
    const due = pending.filter((p) => p.atMs <= horizon);
    if (due.length > 0) {
      pending = pending.filter((p) => p.atMs > horizon);
      for (const p of due) {
        lastWritten.set(p.slotId, p.value);
        transmitter.send(p.controlId, p.cc, p.value, p.resolution);
      }
    }
    ensureDraining();
  }

  // ─────────────────────────── the card API ───────────────────────────
  //
  // Declared BEFORE the handle literal below: `const` is not hoisted, so a
  // `cardApi` defined after the `return` would simply never execute.

  function wireAccess(granted: MIDIAccessLike): void {
    midiAccess = granted;
    granted.onstatechange = () => {
      if (!alive) return;
      // A port that vanished must not stay selected — a stale selection makes
      // every subsequent send look plausible against a port object that is gone.
      if (portId && !outputs().some((o) => o.id === portId)) {
        portId = null;
        problem = 'The selected MIDI output disappeared. Reconnect the device and pick it again.';
        pending = [];
      }
      // Whatever changed, what we believe the device knows is no longer
      // trustworthy — a power-cycled pedal comes back on its own stored preset.
      transmitter.resync();
    };
  }

  const cardApi: DeviceCardApi = {
    async connect(): Promise<boolean> {
      const outcome = await requestMidiAccess({
        onLateResolve: (late) => {
          if (!alive) return;
          wireAccess(late);
          problem = '';
        },
      });
      if (outcome.kind !== 'granted') {
        problem = midiOutcomeMessage(outcome);
        return false;
      }
      problem = '';
      wireAccess(outcome.access);
      return true;
    },

    listOutputs() {
      return outputs().map(({ id, name }) => ({ id, name }));
    },

    selectPort(next: string | null): void {
      portId = next;
      pending = [];
      // The new destination knows nothing about what we sent the old one.
      transmitter.resync();
    },

    setChannel(next: number): void {
      channel = Math.max(1, Math.min(16, Math.round(next)));
      transmitter.resync();
    },

    pushAll(): number {
      transmitter.resync();
      let sent = 0;
      for (const slot of slotState()) {
        if (!slot.control) continue;
        const value = lastWritten.get(slot.slotId) ?? access.readSlotValue(slot.slotId);
        if (sendSlot(slot.slotId, value)?.delivered) sent++;
      }
      return sent;
    },

    fireAction(controlId: string, value?: number): CcTransmitRecord | null {
      const control = controlById(descriptor, controlId);
      if (!control || control.role !== 'action') return null;
      // Actions are momentary: the device acts on RECEIPT, so the same value
      // twice must both go out. Clearing the suppressor's memory is what makes
      // a second tap-tempo tap actually reach the pedal — without it, two taps
      // at the same value would send once and the tempo would never update.
      transmitter.resync();
      const v = value ?? controlMax(control);
      return transmitter.send(control.id, control.cc, v, control.resolution);
    },

    status(): DeviceStatus {
      const ledger = transmitter.ledger();
      const chosen = outputs().find((o) => o.id === portId);
      return {
        connected: midiAccess !== null && portId !== null,
        portId,
        portName: chosen?.name ?? null,
        channel,
        problem,
        staleSlots: slotState().filter((s) => s.stale).map((s) => s.slotId),
        delivered: ledger.filter((r) => r.delivered).length,
        undelivered: ledger.filter((r) => !r.delivered).length,
      };
    },

    slots: slotState,

    assignSlot(slotId: string, controlId: string | null): void {
      const next = { ...(access.readAssign() ?? {}) };
      next[slotId] = controlId ?? '';
      access.writeAssign(next);
      // The slot now addresses a different controller; anything pending for it
      // was aimed at the old one.
      pending = pending.filter((p) => p.slotId !== slotId);
    },
  };

  return {
    domain: 'audio',
    inputs: new Map(),
    outputs: new Map(),
    transmitter,

    setParam(slotId: string, value: number): void {
      // An immediate write supersedes any ramp still pending for this slot —
      // otherwise a queued tail would drag the value back after the user moved
      // the knob by hand.
      pending = pending.filter((p) => p.slotId !== slotId);
      sendSlot(slotId, value);
    },

    /**
     * The RAMP seam. `AudioEngine.scheduleParam` hands us only an endpoint; a
     * MIDI wire has no interpolation, so the intermediate values have to be
     * generated or the automation lane's ramp arrives as a step.
     */
    scheduleParam(slotId: string, value: number, atTime: number, ramp: boolean): void {
      const slot = controlForSlot(slotId);
      if (!slot?.control) return;

      // Refresh the clock correspondence each time rather than trusting a
      // mount-time measurement — the two clocks drift, and a long-lived rack
      // would accumulate the error.
      ctxOffsetS = measureCtxOffset(ctx.currentTime, nowMs());
      const targetMs = audioTimeToPerformanceNow(atTime, ctxOffsetS);

      pending = pending.filter((p) => p.slotId !== slotId);

      if (!ramp) {
        pending.push({
          slotId,
          controlId: slot.control.id,
          cc: slot.control.cc,
          resolution: slot.control.resolution,
          value,
          atMs: targetMs,
        });
        ensureDraining();
        return;
      }

      const from = lastWritten.get(slotId) ?? access.readSlotValue(slotId);
      const quantize = slot.control.resolution === 14 ? quantize14 : quantize7;
      const points = rasterizeCcRamp({
        from,
        to: value,
        fromTimeS: nowMs() / 1000,
        toTimeS: targetMs / 1000,
        quantize,
      });
      for (const point of points) {
        pending.push({
          slotId,
          controlId: slot.control.id,
          cc: slot.control.cc,
          resolution: slot.control.resolution,
          value: point.value,
          atMs: point.atS * 1000,
        });
      }
      ensureDraining();
    },

    /**
     * HOLD AT SEAM — the clip-automation param-jump policy, in MIDI terms.
     *
     * For a Web Audio param this cancels a scheduled ramp tail. Here the
     * equivalent is dropping the un-emitted remainder of the CC train and
     * pinning the value. No `MIDIOutput.clear()` is involved, deliberately:
     * see SEND_LOOKAHEAD_MS.
     */
    holdParam(slotId: string, toValue?: number): void {
      pending = pending.filter((p) => p.slotId !== slotId);
      if (typeof toValue === 'number') sendSlot(slotId, toValue);
    },

    /** What the APP last wrote. NEVER what the device holds — it cannot say. */
    readParam(slotId: string): number | undefined {
      return lastWritten.get(slotId);
    },

    read(key: string): unknown {
      if (key === 'card-api') return cardApi;
      if (key === 'ledger') return transmitter.ledger();
      if (key === 'status') return cardApi.status();
      if (key === 'descriptor') return descriptor;
      return undefined;
    },

    dispose(): void {
      alive = false;
      pending = [];
      if (drainHandle !== null) cancelTick(drainHandle);
      drainHandle = null;
      // Drop our statechange listener before letting go. A stale handler firing
      // against a disposed module is the shape of the reported Windows/Chrome
      // disconnect crash, so teardown is explicit rather than incidental.
      if (midiAccess) midiAccess.onstatechange = null;
      midiAccess = null;
    },
  };

}

// packages/web/src/lib/ui/modules/chromaconsole-cell-actions.ts
//
// THE CHROMA CONSOLE'S NON-PARAM GESTURES, as one plain-TypeScript seam called
// by every surface that offers them — the ranked `chromaconsole-connect-{n}`
// and `chromaconsole-pushall-{n}` action cells, and the shell extension's
// device body.
//
// ⚠ WHY CONNECT IS A CELL AND NOT A BODY BUTTON. midiclock's argument (#2187),
// inherited verbatim: this module transmits nothing until Web MIDI is granted
// AND an output port is chosen, and before promotion the only affordance that
// could ask for the grant was behind an expand. An `action` cell is NOT
// dock-restricted (only
// `panel` is, by `panelCellKeys`), so ranking the key puts the gesture on the
// LANE TILE where the module is met.
//
// ⚠ WHY PUSH ALL IS THE SECOND CELL, AND THIS ARGUMENT IS THIS MODULE'S OWN.
// The device is `readBack: 'none'`: it never reports its settings, so the app is
// permanently the authority and a hand on a physical knob desyncs the screen
// with no way for us to detect it. PUSH ALL is the ONLY reconciliation that
// exists in either direction (`DeviceCardApi.pushAll`), and it is the one
// gesture on this module with no alternative surface — the eight slot VALUES
// are also reachable through MIDI learn, clip automation, the Push 2 card and
// the Electra, which is why the two gestures outrank the eight knobs.
//
// ⚠ BOTH TAKE A nodeId AND RESOLVE THE ENGINE THEMSELVES — the shipped idiom
// (`fireManualStrike`, `midiclockConnect`, `ptzcamConnect`), not a workaround.
// `ShellCellEnv.engine` is typed structurally as `{ write(...) }` with NO
// `read`, and every gesture here needs `read(node, 'card-api')`.
//
// ⚠ CONNECT IS CALLED SYNCHRONOUSLY FROM THE PRESS. `DeviceCardApi.connect()`
// awaits `requestMidiAccess` as its first statement, so the request itself
// starts inside the user activation; an `await` ABOVE the call would spend the
// activation and Chromium then refuses to prompt at all. That is why this
// function is not `async` and hands the auto-detect back as a `.then`.

import { getActiveEngine } from '$lib/audio/engine-ref';
import { patch } from '$lib/graph/store';
import { recordAudition } from '$lib/ui/modules/audition-ledger';
import { CHROMA_CONSOLE } from '$lib/devices/hologram-chroma-console';
import { matchPortByHint } from '$lib/devices/device-descriptor';
import type { DeviceCardApi } from '$lib/devices/device-module';
import type { ModuleNode } from '$lib/graph/types';

// ─────────────── THE HANDLE-STATE SIGNAL, AND WHY IT IS HERE ────────────────
//
// ⚠ A GRANT WRITES NOTHING TO THE Y.DOC. The port, the channel, the problem
// line and the whole output roster live on the DEVICE HANDLE
// (`createDeviceHandle`) and never touch the graph — which is deliberate (a
// port id is machine-local) and is exactly what makes them invisible to
// `nodeVersion`. So a surface whose reads are keyed on the node repaints for
// none of them.
//
// ⚠ AND THE PROMOTION IS WHAT MADE THAT BITE. The connect button used to sit
// INSIDE the component, so its handler could bump that component's own counter
// after the grant resolved. The face moves that gesture to a ranked
// `action` cell, which lives out here and cannot reach the body's local state:
// press CONNECT with the faceplate already open — the path the body's own empty
// state instructs, "Press Connect MIDI to grant access and pick the pedal" —
// and the picker stayed empty, the lamp dark and the hint up under a granted,
// auto-detected, fully bound pedal.
//
// This is the seam's own revision, bumped by every gesture that moves handle
// state, with subscribers notified. ptzcam solves the same problem with
// `ptzMidiVersion` and midiclock with `DeviceCardApi.subscribe`; this device's
// api is pull-only and has neither, so the signal belongs beside the gestures
// that cause it.
//
// ⚠ NOT A TIMER AND NOT A POLL. The resting render of this module must stay
// byte-stable for a committed VRT baseline, so the surface may only be woken
// by something that ACTUALLY HAPPENED.
// Subscribers are notified from event handlers and promise callbacks, never
// from inside a `$derived` — a bump during derivation is `state_unsafe_mutation`
// and permanently poisons the consumer's deriveds, which is the failure ptzcam's
// own header records against `ptz-midi.ts`.
let handleRevision = 0;
const handleListeners = new Set<() => void>();

/** Monotonic count of handle-state changes this seam has caused. */
export function chromaconsoleHandleRevision(): number {
  return handleRevision;
}

/** Subscribe to handle-state changes. Returns the unsubscriber. */
export function onChromaconsoleHandleChange(fn: () => void): () => void {
  handleListeners.add(fn);
  return () => {
    handleListeners.delete(fn);
  };
}

/** Notify every surface that the handle moved. Copied before iterating so an
 *  unsubscribe during dispatch cannot skip a live listener. */
function bumpHandle(): void {
  handleRevision++;
  for (const fn of [...handleListeners]) fn();
}

/** The live card-api handle for a chromaconsole node, or null when the engine
 *  is not up / the node is gone / the handle does not answer the read key. */
export function chromaconsoleApi(nodeId: string): DeviceCardApi | null {
  const engine = getActiveEngine();
  if (!engine) return null;
  const node = patch.nodes[nodeId] as ModuleNode | undefined;
  if (!node) return null;
  return (engine.read(node, 'card-api') as DeviceCardApi | undefined) ?? null;
}

/**
 * Auto-detect the pedal among the granted output ports and select it.
 *
 * A CONVENIENCE, never a requirement: port names differ by OS, driver and hub,
 * and a pedal behind a generic interface reports the interface's name. If the
 * hint misses, the picker in the device body is right there.
 *
 * ⚠ IT ROUTES THROUGH `matchPortByHint`, AND THAT IS A BEHAVIOUR FIX RATHER
 * THAN A TIDY-UP. The card re-implemented this inline with `ports.findIndex(p =>
 * portHints.some(h => …))` — EARLIEST PORT wins — while the shared helper is
 * `for (hint of portHints) ports.findIndex(…)` — EARLIEST HINT wins. The
 * descriptor's hint list is ordered most-specific-first on purpose (the USB
 * name Hologram's own updater reports, then the shorter names "the shorter
 * hints catch a DIN interface that reports a truncated or differently-cased
 * name"), so with BOTH a DIN interface enumerating as "Chroma" and the real
 * pedal present, the card's tie-break bound the interface and the descriptor's
 * ordering was silently defeated. `matchPortByHint` had ZERO production callers
 * and a full unit suite; the card had the callers and the bug.
 *
 * Returns the selected port id, or null when nothing matched (deliberately
 * conservative — a wrong auto-selection silently sends a pedal's CCs to
 * somebody's synth, which is worse than selecting nothing).
 */
export function chromaconsoleAutoSelectPort(api: DeviceCardApi): string | null {
  const ports = api.listOutputs();
  const index = matchPortByHint(CHROMA_CONSOLE, ports);
  if (index < 0) return null;
  const id = ports[index]!.id;
  api.selectPort(id);
  bumpHandle();
  return id;
}

/**
 * Grant Web MIDI for this origin and auto-detect the pedal.
 *
 * Returns whether the press reached THIS node's own seam. `false` means the
 * engine handle was not there to ask — the ledger records that rather than
 * claiming a delivery it cannot prove.
 */
export function chromaconsoleConnect(nodeId: string): boolean {
  const api = chromaconsoleApi(nodeId);
  if (!api) {
    recordAudition({ nodeId, seam: 'engine-message', delivered: false });
    return false;
  }
  recordAudition({ nodeId, seam: 'engine-message', delivered: true });
  // ⚠ NOT AWAITED — see the header's user-activation note. The outcome reaches
  // the surface through `status().problem` and the port roster, neither of which
  // is in the graph, so the handle signal is the ONLY thing that can repaint a
  // faceplate that was already open when the press landed.
  //
  // ⚠ THE BUMP IS UNCONDITIONAL, AND A REFUSED GRANT IS THE REASON. When the
  // prompt is denied or suppressed, `connect()` resolves false and the handle's
  // `problem` carries `midiOutcomeMessage`'s sentence — which the body paints as
  // its `role="alert"` line and is the only thing in the product that says what
  // happened. Bumping only on success would silence exactly the case that needs
  // saying. `catch` covers the same ground for a rejection the api does not
  // currently produce, so a future one cannot strand the surface.
  void api
    .connect()
    .then(() => {
      chromaconsoleAutoSelectPort(api);
    })
    .catch(() => undefined)
    .finally(bumpHandle);
  return true;
}

/**
 * Re-assert every assigned slot's current value to the device.
 *
 * Returns whether the press reached this node's seam. The COUNT of messages
 * that went out is deliberately not returned to a caller that would paint it:
 * `pushAll` reports it for the transmitter's ledger, which is where the e2e
 * reads delivery from.
 */
export function chromaconsolePushAll(nodeId: string): boolean {
  const api = chromaconsoleApi(nodeId);
  if (!api) {
    recordAudition({ nodeId, seam: 'engine-message', delivered: false });
    return false;
  }
  recordAudition({ nodeId, seam: 'engine-message', delivered: true });
  api.pushAll();
  return true;
}

/** Fire one `role: 'action'` device command (tap tempo, capture, …) at once.
 *  Writes no param and enters no undo stack — see `DeviceControlRole`. */
export function chromaconsoleFireAction(nodeId: string, controlId: string): boolean {
  const api = chromaconsoleApi(nodeId);
  if (!api) return false;
  api.fireAction(controlId);
  return true;
}

/** Choose the MIDI output, or `null` to detach. */
export function chromaconsoleSelectPort(nodeId: string, portId: string | null): boolean {
  const api = chromaconsoleApi(nodeId);
  if (!api) return false;
  api.selectPort(portId);
  bumpHandle();
  return true;
}

/** Set the 1-based MIDI channel. */
export function chromaconsoleSetChannel(nodeId: string, channel: number): boolean {
  const api = chromaconsoleApi(nodeId);
  if (!api) return false;
  api.setChannel(channel);
  bumpHandle();
  return true;
}

/** Point a slot at a descriptor control, or `null` to clear it. The write
 *  itself lands on `node.data.assign` inside the factory's LOCAL_ORIGIN
 *  transaction, so a reassignment is undoable and syncs to rack-mates. */
export function chromaconsoleAssignSlot(
  nodeId: string,
  slotId: string,
  controlId: string | null,
): boolean {
  const api = chromaconsoleApi(nodeId);
  if (!api) return false;
  api.assignSlot(slotId, controlId);
  return true;
}

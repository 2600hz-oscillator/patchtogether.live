// packages/web/src/lib/ui/modules/push2-cell-actions.ts
//
// THE PUSH 2 CONNECT GESTURE, as a face cell — and the OUTCOME STORE the
// faceplate needs because a cell cannot own component state.
//
// ── WHY THIS FILE EXISTS AT ALL ─────────────────────────────────────────────
//
// `Push2ControlCard.svelte` kept the outcome of a connect attempt in a
// COMPONENT-LOCAL `$state` (`'idle' | 'connecting' | … `) and rendered its
// warnings from it. A ranked ACTION cell is rendered by the SHARED shell, its
// `onFire` is a plain function in this file, and the surface that must show the
// outcome is a different component again (the extension body). So the outcome
// needs a home OUTSIDE both. This is the `launchpad-cell-actions.ts` /
// `camera-status-registry` shape: a named seam publishing what the gesture did,
// so a face can show it.
//
// ⚠ THE STORE IS GLOBAL, NOT PER-NODE, AND THAT IS A CORRECTION rather than a
// shortcut. The card's variable was per-component, but the thing it describes
// is not: `maxInstances: 1` caps the rack at ONE push2Control, and beneath it
// there is ONE push2-control singleton and ONE physical Push
// (`$lib/control/push2/push2-control.svelte.ts` — the binding, the selected
// lane and the focus are all module-scope). Scoping the store the way the
// device layer is scoped makes "two surfaces printing different answers about
// the same hardware" unrepresentable.
//
// ⚠ THE AUDITION RECORD IS WRITTEN SYNCHRONOUSLY, BEFORE THE AWAIT — the rule
// `launchpad-cell-actions.ts` and `midiclock-cell-actions.ts` both state, for
// the same reason. `connectPush()` sits on `requestMIDIAccess`, which can hang
// for as long as the browser feels like when it declines to show its own
// prompt. `delivered` is not about that OUTCOME; it is about whether the press
// reached a seam that could act, which is knowable the instant the capability
// is read.
//
// ⚠ WHAT `delivered: false` MEANS HERE. This module is `domain: 'meta'` — no
// ports, no factory, no engine node — so the seam is not an engine handle but
// the Web MIDI capability the whole push2 layer sits on. With no
// `navigator.requestMIDIAccess` there is nothing behind the button, and the
// card's own first branch says exactly that (`Push2ControlCard.svelte`:
// `if (!supported) { status = 'no-midi'; return; }`). So a press on a browser
// without Web MIDI reaches nothing, is recorded as `delivered: false`, and is
// the permanent NEGATIVE CONTROL in `push2-cell-actions.test.ts` — which is
// what stops the probe being the vacuous "this function was called" it would
// otherwise be.
//
// ⚠ AND `engine-message` IS THE SEAM NAME, WITH THE STRETCH STATED. The ledger
// has five members and `shell-cells.test.ts`'s allowlist admits four of them to
// an ACTION cell; the three `manual-*` seams are struck-voice auditions and
// `file-export` is an export. `engine-message` is the "a command was dispatched
// to a live handle" member, which is what this is — the handle happening to be
// the device singleton rather than an AudioWorklet. This is the same stretch
// `launchpad-cell-actions.ts` records, and a sixth member for a second module
// making it would be new machinery for no new discriminating power.

import { patch } from '$lib/graph/store';
import { recordAudition } from '$lib/ui/modules/audition-ledger';
import {
  midiAvailable,
  connectPush,
  bindPushToClip,
  unbindPush,
  boundClipNode,
} from '$lib/control/push2/push2-control.svelte';

/**
 * What the last CONNECT attempt reported.
 *
 * The card's own vocabulary (`Push2ControlCard.svelte`, its `status` variable)
 * minus `'idle'`-as-connected: every member is reachable and every member
 * changes what the body paints.
 */
export type Push2GestureOutcome = 'idle' | 'connecting' | 'connected' | 'no-midi' | 'no-device';

let outcome: Push2GestureOutcome = 'idle';
const listeners = new Set<() => void>();

/** The current outcome. */
export function push2GestureOutcome(): Push2GestureOutcome {
  return outcome;
}

/** Subscribe to outcome changes. Returns the unsubscribe — a body that
 *  subscribed without releasing is the node-resource-leak class. */
export function onPush2Gesture(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function setOutcome(next: Push2GestureOutcome): void {
  outcome = next;
  for (const l of listeners) l();
}

/** TEST SEAM: forget the outcome. Never called from app code. */
export function __resetPush2Gesture(): void {
  outcome = 'idle';
  listeners.clear();
}

/** The first clip-player node in the patch — the card's own helper, extracted
 *  so the cell, the body and the auto-bind all read ONE derivation. */
export function firstClipplayer(): string | null {
  for (const [nid, n] of Object.entries(patch.nodes)) {
    if ((n as { type?: string } | undefined)?.type === 'clipplayer') return nid;
  }
  return null;
}

/**
 * The device + graph seam the gesture reaches.
 *
 * INJECTABLE so both the delivered=true and the delivered=false legs are
 * exercised in the unit lane with no browser, no Web MIDI and no hardware. A
 * probe whose false branch is unreachable is the vacuity the audition ledger
 * exists to prevent, and "the CI runner has no Push" is not a way to reach it —
 * the capability is present on the runner, only the hardware is not.
 */
export interface Push2GestureSeam {
  midiAvailable(): boolean;
  connect(): Promise<boolean>;
  firstClipplayer(): string | null;
  boundClipNode(): string | null;
  bindToClip(nodeId: string): void;
  unbind(): void;
}

const LIVE_SEAM: Push2GestureSeam = {
  midiAvailable,
  connect: connectPush,
  firstClipplayer,
  boundClipNode,
  bindToClip: bindPushToClip,
  unbind: unbindPush,
};

/** Attach the Push to the patch's clip-player, if there is one and it is not
 *  already attached. The card's `autoBind`, unchanged. */
function autoBind(seam: Push2GestureSeam): void {
  const cp = seam.firstClipplayer();
  if (cp && seam.boundClipNode() !== cp) seam.bindToClip(cp);
}

/**
 * CONNECT — run the gesture-gated Web MIDI sysex request, then auto-bind.
 *
 * Returns whether the press reached the seam, and records it. Mirrors
 * `Push2ControlCard.svelte`'s `connect()` branch for branch.
 *
 * ⚠ THE CAPTION THE CELL CARRIES IS THE LITERAL `Connect Push 2`, AND THE
 * CARD'S `Re-connect Push 2` IS NOT A LOSS. `connect()` does not branch: it
 * calls `connectPush()` and auto-binds, identically, in both states. The `Re-`
 * prefix carried no information about the GESTURE and exactly one bit about the
 * module's state — a state word wearing a caption's clothes. That bit is the
 * PUSH lamp's job, and the lamp is more legible than a prefix.
 */
export function push2Connect(nodeId: string, seam: Push2GestureSeam = LIVE_SEAM): boolean {
  if (!seam.midiAvailable()) {
    recordAudition({ nodeId, seam: 'engine-message', delivered: false });
    setOutcome('no-midi');
    return false;
  }
  recordAudition({ nodeId, seam: 'engine-message', delivered: true });
  setOutcome('connecting');
  void seam
    .connect()
    .then((ok) => {
      if (!ok) {
        setOutcome('no-device');
        return;
      }
      setOutcome('connected');
      autoBind(seam);
    })
    // ⚠ A REJECTION IS AN OUTCOME, NOT A CRASH. `connectPush` sits on
    // `requestMIDIAccess`, which REJECTS when the user refuses the prompt or
    // the browser blocks sysex — the ordinary path, not an exceptional one.
    // Without this the refusal becomes an unhandled rejection: the plate keeps
    // saying "connecting" forever, and every e2e in the suite that watches
    // `pageerror` reddens on a user declining a permission.
    .catch(() => {
      setOutcome('no-midi');
    });
  return true;
}

/** BIND / UNBIND the focused clip-player. Body-only: `ShellActionCell.label` is
 *  a plain string, so a cell could not say which of the two it will do, and the
 *  control is a no-op on the (very common) rack with no clip-player at all. */
export function push2ToggleBind(seam: Push2GestureSeam = LIVE_SEAM): void {
  if (seam.boundClipNode()) {
    seam.unbind();
    return;
  }
  autoBind(seam);
}

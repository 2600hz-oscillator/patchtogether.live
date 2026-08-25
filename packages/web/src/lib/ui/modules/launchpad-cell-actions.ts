// packages/web/src/lib/ui/modules/launchpad-cell-actions.ts
//
// THE TWO LAUNCHPAD HANDSHAKES, as face cells — and the OUTCOME STORE the
// faceplate needs because a cell cannot own component state.
//
// ── WHY THIS FILE EXISTS AT ALL ─────────────────────────────────────────────
//
// `LaunchpadControlCard.svelte` kept the outcome of a handshake in a COMPONENT
// -LOCAL `$state` (`:54`, the `'idle' | 'pairing' | … ` variable) and rendered
// its warnings from it. A ranked ACTION cell is rendered by the SHARED shell,
// its `onFire` is a plain function in this file, and the surface that must show
// the outcome is a different component again (the extension body). So the
// outcome needs a home OUTSIDE both. This is the `camera-status-registry`
// shape: a named seam publishing what the gesture did, so a face can show it.
//
// ⚠ THE STORE IS GLOBAL, NOT PER-NODE, AND THAT IS A CORRECTION. The card's
// variable was per-component, but the thing it describes is not: there is ONE
// launchpad-device singleton and ONE pair of physical units for the whole app
// (`$lib/control/launchpad/launchpad-control.svelte.ts` — `deployment`,
// `pairing` and the L/R slots are all module-scope). Two cards could therefore
// print two different answers about the same hardware, and the newer of them
// was not necessarily the one you were looking at. Scoping the store the way
// the device layer is scoped makes that unrepresentable.
//
// ⚠ THE AUDITION RECORD IS WRITTEN SYNCHRONOUSLY, BEFORE THE AWAIT — the rule
// `midiclock-cell-actions.ts` states and for the same reason. `startPairing` /
// `startSingle` sit on `requestMIDIAccess`, which can hang for as long as the
// browser feels like when it declines to show its own prompt. `delivered` is
// not about that OUTCOME; it is about whether the press reached a seam that
// could act, which is knowable the instant the capability is read.
//
// ⚠ WHAT `delivered: false` MEANS HERE, since the answer is different from
// every other action cell in the tree. The other five resolve a callable off
// the live ENGINE handle; this module has no engine (it is `domain: 'meta'` —
// no ports, no factory, no node). Its seam is the Web MIDI capability the whole
// launchpad layer sits on: with no `navigator.requestMIDIAccess` there is
// nothing behind either button and the card's own first branch says so
// (`LaunchpadControlCard.svelte:79`, `:97` — `if (!supported) { status =
// 'no-midi'; return; }`). So a press on a browser without Web MIDI reaches
// nothing, is recorded as `delivered: false`, and is the permanent NEGATIVE
// CONTROL in `launchpad-cell-actions.test.ts` — which is what stops the probe
// being the vacuous "this function was called" it would otherwise be.
//
// ⚠ AND `engine-message` IS THE SEAM NAME, WITH THE STRETCH STATED. The ledger
// has five members and `shell-cells.test.ts`'s allowlist admits four of them to
// an ACTION cell; the three `manual-*` seams are struck-voice auditions and
// `file-export` is an export. `engine-message` is the "a command was dispatched
// to a live handle" member, which is what this is — the handle happening to be
// the device singleton rather than an AudioWorklet. A sixth member for one
// module would be new machinery for no new discriminating power: both cells sit
// on the same node, and faces-parity snapshots the ledger's sequence number
// BEFORE each press, so a dead cell records nothing after that mark and reddens
// regardless of what its neighbour did.

import { patch } from '$lib/graph/store';
import { recordAudition } from '$lib/ui/modules/audition-ledger';
import { midiAvailable } from '$lib/control/launchpad/launchpad-device.svelte';
import {
  startPairing,
  startSingle,
  cancelPairing,
  isPairing,
  restoreLaunchpadPair,
  restoreLaunchpadSingle,
  bindLaunchpadToClip,
  unbindLaunchpad,
  boundClipNode,
} from '$lib/control/launchpad/launchpad-control.svelte';

/**
 * What the last handshake reported.
 *
 * The card's own vocabulary (`LaunchpadControlCard.svelte:54`) minus nothing:
 * every member is reachable and every member changes what the body paints.
 */
export type LaunchpadGestureOutcome =
  | 'idle'
  | 'pairing'
  | 'paired'
  | 'no-midi'
  | 'one-unit'
  | 'no-device';

let outcome: LaunchpadGestureOutcome = 'idle';
const listeners = new Set<() => void>();

/** The current outcome. */
export function launchpadGestureOutcome(): LaunchpadGestureOutcome {
  return outcome;
}

/** Subscribe to outcome changes. Returns the unsubscribe — a body that
 *  subscribed without releasing is the node-resource-leak class. */
export function onLaunchpadGesture(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function setOutcome(next: LaunchpadGestureOutcome): void {
  outcome = next;
  for (const l of listeners) l();
}

/** TEST SEAM: forget the outcome. Never called from app code. */
export function __resetLaunchpadGesture(): void {
  outcome = 'idle';
  listeners.clear();
}

/** The first clip-player node in the patch — the card's own helper
 *  (`LaunchpadControlCard.svelte:68-73`), extracted so the cell, the body and
 *  the auto-bind all read ONE derivation. */
export function firstClipplayer(): string | null {
  for (const [nid, n] of Object.entries(patch.nodes)) {
    if ((n as { type?: string } | undefined)?.type === 'clipplayer') return nid;
  }
  return null;
}

/**
 * The device + graph seam the two gestures reach.
 *
 * INJECTABLE so both the delivered=true and the delivered=false legs are
 * exercised in the unit lane with no browser, no Web MIDI and no hardware.
 * A probe whose false branch is unreachable is the vacuity this whole ledger
 * exists to prevent, and "the CI runner has no Launchpad" is not a way to reach
 * it — the capability is present on the runner, only the hardware is not.
 */
export interface LaunchpadGestureSeam {
  midiAvailable(): boolean;
  isPairing(): boolean;
  cancelPairing(): void;
  startPairing(onPaired?: () => void): Promise<boolean>;
  startSingle(onBound?: () => void): Promise<boolean>;
  restorePair(): boolean;
  restoreSingle(): boolean;
  firstClipplayer(): string | null;
  boundClipNode(): string | null;
  bindToClip(nodeId: string): void;
  unbind(): void;
}

const LIVE_SEAM: LaunchpadGestureSeam = {
  midiAvailable,
  isPairing,
  cancelPairing,
  startPairing,
  startSingle,
  restorePair: restoreLaunchpadPair,
  restoreSingle: restoreLaunchpadSingle,
  firstClipplayer,
  boundClipNode,
  bindToClip: bindLaunchpadToClip,
  unbind: unbindLaunchpad,
};

/** Attach the pair to the patch's clip-player, if there is one and it is not
 *  already attached. The card's `autoBind` (`:111-114`), unchanged. */
function autoBind(seam: LaunchpadGestureSeam): void {
  const cp = seam.firstClipplayer();
  if (cp && seam.boundClipNode() !== cp) seam.bindToClip(cp);
}

/**
 * PAIR — run the press-a-pad L/R handshake, or CANCEL one in flight.
 *
 * Returns whether the press reached the seam, and records it. Mirrors
 * `LaunchpadControlCard.svelte:78-92` branch for branch, including the
 * saved-pair silent restore.
 */
export function launchpadPair(nodeId: string, seam: LaunchpadGestureSeam = LIVE_SEAM): boolean {
  if (!seam.midiAvailable()) {
    recordAudition({ nodeId, seam: 'engine-message', delivered: false });
    setOutcome('no-midi');
    return false;
  }
  recordAudition({ nodeId, seam: 'engine-message', delivered: true });
  if (seam.isPairing()) {
    // The card's second press CANCELS. Its caption said "Press a pad on the
    // unit you want as LEFT…" in this state, which is an instruction wearing a
    // button; the instruction moved to the body and the cell's caption names
    // the action it has always performed.
    seam.cancelPairing();
    setOutcome('idle');
    return true;
  }
  setOutcome('pairing');
  void seam
    .startPairing(() => {
      setOutcome('paired');
      autoBind(seam);
    })
    .then((ok) => {
      if (ok) return;
      if (seam.restorePair()) {
        setOutcome('paired');
        autoBind(seam);
      } else {
        setOutcome('one-unit');
      }
    })
    // ⚠ A REJECTION IS AN OUTCOME, NOT A CRASH. `startPairing` sits on
    // `requestMIDIAccess`, which REJECTS when the user refuses the prompt or
    // the browser blocks sysex — the ordinary path, not an exceptional one.
    // Without this the refusal becomes an unhandled rejection: the plate keeps
    // saying "pairing" forever, and every e2e in the suite that watches
    // `pageerror` reddens on a user declining a permission.
    .catch(() => { setOutcome('no-midi'); });
  return true;
}

/**
 * SINGLE — bind ONE Launchpad to the L slot, whose role the VIEW segment flips.
 *
 * Mirrors `LaunchpadControlCard.svelte:96-109`.
 */
export function launchpadConnectSingle(
  nodeId: string,
  seam: LaunchpadGestureSeam = LIVE_SEAM,
): boolean {
  if (!seam.midiAvailable()) {
    recordAudition({ nodeId, seam: 'engine-message', delivered: false });
    setOutcome('no-midi');
    return false;
  }
  recordAudition({ nodeId, seam: 'engine-message', delivered: true });
  if (seam.isPairing()) seam.cancelPairing();
  setOutcome('pairing');
  void seam
    .startSingle(() => {
      setOutcome('paired');
      autoBind(seam);
    })
    .then((ok) => {
      if (ok) return;
      if (seam.restoreSingle()) {
        setOutcome('paired');
        autoBind(seam);
      } else {
        setOutcome('no-device');
      }
    })
    // Same as PAIR above: a refused or blocked `requestMIDIAccess` is an
    // outcome the plate must be able to say, not an unhandled rejection.
    .catch(() => { setOutcome('no-midi'); });
  return true;
}

/** BIND / UNBIND the focused clip-player. Body-only: `ShellActionCell.label` is
 *  a plain string, so a cell could not say which of the two it will do, and the
 *  control is a no-op on the (very common) rack with no clip-player at all. */
export function launchpadToggleBind(seam: LaunchpadGestureSeam = LIVE_SEAM): void {
  if (seam.boundClipNode()) {
    seam.unbind();
    return;
  }
  autoBind(seam);
}

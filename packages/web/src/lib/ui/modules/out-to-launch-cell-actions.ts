// packages/web/src/lib/ui/modules/out-to-launch-cell-actions.ts
//
// THE OUT TO LAUNCH "CONNECT LAUNCHPAD" GESTURE, as a face cell — plus the
// OUTCOME + ROSTER store the faceplate body needs, because a ranked cell cannot
// own component state.
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
//
// `OutToLaunchCard.svelte` kept the connect outcome and the enumerated port
// roster in COMPONENT-LOCAL `$state` (`status`, `ports`) and rendered its picker
// and its two warnings from them. A ranked ACTION cell is rendered by the SHARED
// shell, its `onFire` is a plain function in this file, and the surface that
// must show the roster is a different component again (the extension body). So
// both need a home outside both. This is the `push2-cell-actions.ts` /
// `launchpad-cell-actions.ts` / `camera-status-registry` shape.
//
// ⚠ THE STORE IS GLOBAL, AND THE ARGUMENT IS NOT push2Control's. That module
// reaches global by way of `maxInstances: 1`, and OUT TO LAUNCH declares no such
// cap — a rack may hold several, each bound to a DIFFERENT Launchpad, which is
// exactly what `isOutputClaimed(outputId, nodeId)` arbitrates. So "one node, one
// device" would be the wrong reason and it is not the one used here.
//
// What is global is what this store actually holds, on its own merits:
//
//   * `deviceConnect()` is a request for the ORIGIN's Web MIDI sysex
//     permission. It is granted to the page, not to a node.
//   * `enumerateLaunchpadPorts()` returns every Launchpad output attached to
//     the MACHINE. Two nodes asked the same question get the same answer.
//   * the outcome vocabulary is machine-level too: "this browser has no Web
//     MIDI" and "no Launchpad is plugged in" are facts about the host.
//
// The PER-NODE half — which port THIS node claimed — is deliberately NOT here.
// It lives in the device layer's node-keyed `monitors` map, read back through
// `nodeLaunchpadMonitor.view(id)`, because duplicating a claim into a second
// map is how two surfaces come to disagree about who owns a physical surface.
//
// ⚠ ONE CONSEQUENCE, STATED RATHER THAN DISCOVERED: with two OUT TO LAUNCH
// nodes, pressing CONNECT on one moves the transient `'listing'` outcome on the
// other's plate too. That is accurate — the machine really is enumerating — and
// it is the same answer both plates would reach independently a moment later.
//
// ⚠ THE AUDITION RECORD IS WRITTEN SYNCHRONOUSLY, BEFORE THE AWAIT — the rule
// `push2-cell-actions.ts` and `launchpad-cell-actions.ts` both state, for the
// same reason. `deviceConnect()` sits on `requestMIDIAccess`, which can hang for
// as long as the browser likes when it declines to show its own prompt.
// `delivered` is not about that OUTCOME; it is about whether the press reached a
// seam that could act, which is knowable the instant the capability is read.
//
// ⚠ WHAT `delivered: false` MEANS HERE, and why the probe is not vacuous. With
// no `navigator.requestMIDIAccess` there is nothing behind the button, and the
// card's own first branch says exactly that (`OutToLaunchCard.svelte`:
// `if (!supported) { status = 'no-midi'; return; }`). A press on a browser
// without Web MIDI reaches nothing, is RECORDED as `delivered: false` rather
// than dropped, and is the permanent NEGATIVE CONTROL in the unit lane — which
// is what stops the probe being the "this function was called" tautology it
// would otherwise be.
//
// ⚠ `engine-message` IS THE SEAM NAME, WITH THE STRETCH STATED. The three
// `manual-*` seams are struck-voice auditions and `file-export` is an export;
// `engine-message` is the "a command was dispatched to a live handle" member,
// the handle here being the Web MIDI device layer rather than an AudioWorklet.
// This is the same stretch `push2-cell-actions.ts` and `launchpad-cell-actions
// .ts` already record, and a fourth module making it does not earn a new seam.

import { recordAudition } from '$lib/ui/modules/audition-ledger';
import {
  midiAvailable,
  connect as deviceConnect,
  enumerateLaunchpadPorts,
  type LaunchpadPort,
} from '$lib/control/launchpad/launchpad-device.svelte';

/**
 * What the last CONNECT attempt reported.
 *
 * The card's own vocabulary (`OutToLaunchCard.svelte`, its `status` variable):
 * every member is reachable, and every member changes what the body paints.
 */
export type OutToLaunchGestureOutcome = 'idle' | 'listing' | 'no-midi' | 'no-device';

let outcome: OutToLaunchGestureOutcome = 'idle';
let ports: readonly LaunchpadPort[] = [];
const listeners = new Set<() => void>();

/** The current outcome. */
export function outToLaunchGestureOutcome(): OutToLaunchGestureOutcome {
  return outcome;
}

/** The Launchpad outputs the last CONNECT enumerated. ROWS, never a count —
 *  the caller renders them and asserts properties of the set. */
export function outToLaunchPorts(): readonly LaunchpadPort[] {
  return ports;
}

/** Subscribe to outcome/roster changes. Returns the unsubscribe — a body that
 *  subscribed without releasing is the node-resource-leak class. */
export function onOutToLaunchGesture(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function publish(next: OutToLaunchGestureOutcome, roster: readonly LaunchpadPort[]): void {
  outcome = next;
  ports = roster;
  for (const l of listeners) l();
}

/** TEST SEAM: forget the outcome and the roster. Never called from app code. */
export function __resetOutToLaunchGesture(): void {
  outcome = 'idle';
  ports = [];
  listeners.clear();
}

/**
 * The device seam the gesture reaches.
 *
 * INJECTABLE so both the `delivered: true` and the `delivered: false` legs run
 * in the unit lane with no browser, no Web MIDI and no hardware. A probe whose
 * false branch is unreachable is exactly the vacuity the audition ledger exists
 * to prevent — and "the CI runner has no Launchpad" is NOT a way to reach it,
 * because the runner has the capability and only lacks the device, which is a
 * different branch (`'no-device'`).
 */
export interface OutToLaunchGestureSeam {
  midiAvailable(): boolean;
  connect(): Promise<unknown>;
  enumerate(): LaunchpadPort[];
}

const LIVE_SEAM: OutToLaunchGestureSeam = {
  midiAvailable,
  connect: deviceConnect,
  enumerate: enumerateLaunchpadPorts,
};

/**
 * CONNECT — run the gesture-gated Web MIDI sysex request, then enumerate the
 * Launchpad outputs into the roster the extension body renders.
 *
 * Returns whether the press reached the seam, and records it. Mirrors
 * `OutToLaunchCard.svelte`'s `connectAndList()` branch for branch.
 *
 * ⚠ THIS CELL DOES NOT COMPLETE A BINDING, AND THAT IS A REAL DIVERGENCE FROM
 * THE THREE RANKED CONNECT CELLS BEFORE IT — stated here rather than glossed,
 * because "the ranked gesture finishes the job" was load-bearing in all three.
 * `launchpadConnectSingle` binds, `push2Connect` auto-binds, `midiclockConnect`
 * attaches. This one grants a permission and asks the machine a question.
 *
 * It is still the right thing to rank, for a reason those three did not need:
 *
 *   * IT IS THE ONLY HALF THAT REQUIRES A USER GESTURE. `requestMIDIAccess`
 *     with sysex is gesture-gated by the browser and its grant is PER-ORIGIN
 *     and PERSISTENT. The pick that follows is an ordinary click on an
 *     ordinary button and needs no privilege at all.
 *   * THE OTHER HALF CANNOT BE A CELL. The port roster is enumerated from the
 *     MACHINE, so it is not a `ParamDef`'s `options` (a def roster is fixed when
 *     the def is authored); and a `ShellSelectorCell` cannot NOTICE it change,
 *     because ModuleShell re-projects a cell from `liveCell` keyed on
 *     `nodeVersion(id)` and `bindMonitor` writes to `node.data` ZERO times. A
 *     selector would paint the roster it had at mount and never move again.
 *   * PROMOTION STRICTLY WIDENS REACH, AND CANNOT NARROW IT. Both halves are
 *     dock-only TODAY: `outToLaunch` is not in `NON_SHELL_LANE_TYPES`, so its
 *     lane render is a `placeholder` and its card exists only inside the dock
 *     full view. Ranking CONNECT moves the privileged half onto the lane tile
 *     and leaves the unprivileged half exactly where the player already finds
 *     it.
 */
export function outToLaunchConnect(
  nodeId: string,
  seam: OutToLaunchGestureSeam = LIVE_SEAM,
): boolean {
  if (!seam.midiAvailable()) {
    recordAudition({ nodeId, seam: 'engine-message', delivered: false });
    publish('no-midi', []);
    return false;
  }
  recordAudition({ nodeId, seam: 'engine-message', delivered: true });
  publish('listing', ports);
  void Promise.resolve(seam.connect())
    .then(() => {
      const found = seam.enumerate();
      publish(found.length > 0 ? 'idle' : 'no-device', found);
    })
    // ⚠ A REJECTION IS AN OUTCOME, NOT A CRASH. `requestMIDIAccess` REJECTS
    // when the user refuses the prompt or the browser blocks sysex — the
    // ordinary path, not an exceptional one. Without this the refusal becomes
    // an unhandled rejection: the plate says "Connecting…" forever, and every
    // e2e in the suite that watches `pageerror` reddens on a user declining a
    // permission.
    .catch(() => {
      publish('no-midi', []);
    });
  return true;
}

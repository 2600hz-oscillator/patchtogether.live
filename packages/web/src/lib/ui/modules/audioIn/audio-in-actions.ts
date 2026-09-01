// packages/web/src/lib/ui/modules/audioIn/audio-in-actions.ts
//
// AUDIO IN's ACTION SEAM — the one plain-TypeScript home for every gesture the
// module has, called by all three of its surfaces.
//
// ── WHY A SEAM ─────────────────────────────────────────────────────────────
//
// `livecode` is the shape this follows (its RUN was extracted from the card into
// one action used by the legacy card, the face body and the ranked shell cell).
// AUDIO IN needs it more than livecode did, because it has THREE surfaces:
//
//   * the lane tile's `tileBody`   — where a player normally meets the module,
//                                    and the ONLY route to a FIRST permission
//                                    grant without expanding it;
//   * the dock full view's `fullViewBody` — which is ALSO the pinned
//                                    `pinned-audioIn`'s only surface, since the
//                                    🎧 tray mounts `view='drawer'` and
//                                    `dockFullViewHeadPlan` paints the full-view
//                                    body there;
//   * `AudioinCard.svelte`         — still the lane surface under
//                                    `?shell=legacy`, which must keep working
//                                    for the whole migration.
//
// Three components each re-deriving "which device, with which constraints, and
// may I open it unattended?" is three chances to disagree about a resource whose
// teardown is IRREVERSIBLE.
//
// ── THE OWNERSHIP LINE THIS FILE DOES NOT CROSS ────────────────────────────
//
//   * the STREAM belongs to `node-audio-input-registry` (NODE lifetime, #1590);
//   * the ROSTER and the saved keys belong to `$lib/audio/input-device.svelte`;
//   * this file only SEQUENCES them for a gesture.
//
// ⚠ THERE IS DELIBERATELY NO `unbind`/`teardown`/`disposeSurface` HERE. The
// registry's own header names the absence of a card-lifecycle method as the
// structural guard against #1590 returning, and a seam that offered one would
// hand it straight back — `tsc` refuses the call today, and it must keep
// refusing. `releaseAudioInput` exists and DOES stop the tracks, but it is named
// for the player's intent (the STOP control), never for a component's lifecycle,
// and no surface may call it from `onDestroy`.

import type { EngineContext } from '$lib/audio/engine-context';
import { patch } from '$lib/graph/store';
import type { ModuleNode } from '$lib/graph/types';
import {
  audioInConstraints,
  ensureInputDeviceWatch,
  inputDeviceRoster,
  inputDevicesHaveLabels,
  refreshInputDevices,
  setInputDevice,
  setInputMusicMode,
} from '$lib/audio/input-device.svelte';
import { nodeAudioInput } from '$lib/ui/modules/node-audio-input-registry.svelte';

function liveNode(nodeId: string): ModuleNode | undefined {
  return patch.nodes[nodeId] as ModuleNode | undefined;
}

/**
 * ACQUIRE (or RE-ACQUIRE) this node's input — the ENABLE / RETRY gesture, the
 * device-pick re-open and the music-mode re-open.
 *
 * ⚠ IT MUST STAY REACHABLE FROM A REAL CLICK. The browser grants a FIRST
 * microphone permission only inside a genuine activation context, so every
 * surface wires this to a real `<button>` and none of them may substitute an
 * effect.
 */
export async function acquireAudioInput(nodeId: string): Promise<void> {
  // Enumerate FIRST: with nothing saved, the constraints fall back to the
  // roster's default, and an empty roster would ask for a device that is not
  // there.
  await refreshInputDevices();
  const devices = inputDeviceRoster();
  await nodeAudioInput.request(nodeId, audioInConstraints(liveNode(nodeId), devices), {
    // The browser may hand back a DIFFERENT device than the one asked for (the
    // `default` pseudo-id resolves to a real one). Persist what actually opened,
    // so a reload re-opens the same physical input.
    onResolved: (realDeviceId) => {
      if (realDeviceId) setInputDevice(nodeId, realDeviceId);
    },
  });
  // A first grant de-redacts every label, which is what turns `Input #1` into
  // the device's real name — and what lets a LATER mount auto-acquire.
  if (nodeAudioInput.isStreaming(nodeId)) await refreshInputDevices();
}

/** USER-INITIATED release — the STOP control. Never a lifecycle hook; see the
 *  file header. */
export function releaseAudioInput(nodeId: string): void {
  nodeAudioInput.stop(nodeId);
}

/** Pick a device: persist it, and re-open on the new one if something was
 *  already open (or had failed on the old one). */
export function pickAudioInputDevice(nodeId: string, deviceId: string): void {
  if (!deviceId) return;
  setInputDevice(nodeId, deviceId);
  const state = nodeAudioInput.view(nodeId).state;
  if (state === 'streaming' || state === 'device-in-use' || state === 'error') {
    void acquireAudioInput(nodeId);
  }
}

/** Flip music mode: persist it, and re-open if streaming — the capture DSP
 *  constraints cannot be changed on a live track. */
export function setAudioInputMusicMode(nodeId: string, on: boolean): void {
  setInputMusicMode(nodeId, on);
  if (nodeAudioInput.view(nodeId).state === 'streaming') void acquireAudioInput(nodeId);
}

/**
 * MOUNT-SIDE BINDING — call from an `$effect` on every surface.
 *
 * Three jobs, in order, and every one of them is idempotent:
 *
 *   1. ADOPT the node's registry entry (non-destructive: a re-mount picks up an
 *      entry a previous mount left STREAMING, which is what makes re-expanding
 *      show the live input rather than a fresh idle one), handing over the
 *      engine accessor so a late-booting engine still gets its attach;
 *   2. start the app-wide device watch;
 *   3. take the ONE unattended acquire this node gets, IF the origin already
 *      holds a microphone grant.
 *
 * ⚠ (3) IS GUARDED IN TWO PLACES AND BOTH ARE LOAD-BEARING. `beginAutoAcquire`
 * makes the claim atomic across the two surfaces that can be mounted at once
 * (see its own note — `request()` stops the outgoing tracks FIRST, and that is
 * irreversible). The `inputDevicesHaveLabels()` probe is what keeps this from
 * being a permission PROMPT on page load: pre-grant the browser redacts every
 * label, so a first-time visitor is never asked for a microphone by a rack that
 * merely contains this module, and a CI runner with no prior grant never opens a
 * device at all — which is also what makes this face's VRT scenes deterministic.
 */
export async function bindAudioInputSurface(
  nodeId: string,
  engine: EngineContext,
): Promise<void> {
  nodeAudioInput.adopt(nodeId, engine);
  ensureInputDeviceWatch();

  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    nodeAudioInput.setStatus(nodeId, 'unsupported', 'Browser does not support getUserMedia');
    return;
  }
  if (!nodeAudioInput.beginAutoAcquire(nodeId)) return;

  await refreshInputDevices();
  if (inputDeviceRoster().length === 0) {
    nodeAudioInput.setStatus(nodeId, 'no-inputs-found', 'No audio inputs detected.');
    return;
  }
  // No prior grant ⇒ WAIT FOR THE CLICK. This is the whole permission policy:
  // the module asks for a microphone when the player asks for one.
  if (!inputDevicesHaveLabels()) return;
  await acquireAudioInput(nodeId);
}


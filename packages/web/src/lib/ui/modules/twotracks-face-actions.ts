// packages/web/src/lib/ui/modules/twotracks-face-actions.ts
//
// THE ONE TWOTRACKS TRANSPORT — shared by `TwotracksCard.svelte` (the legacy
// card), the faceplate's `SHELL_CELLS` entries and the faceplate BODY.
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
//
// Promoting a module removes its card from both surfaces, so every affordance
// the card owned must exist as a shell cell or the promotion DELETES it. The
// twotracks card owns four non-param affordances per reel — REC, PLAY, STOP and
// SAVE TAPE — and none of them writes a param. Each is a message to the reel
// worklet (or, for SAVE, a request that ends in a file), so each needs a home
// that is neither the card nor the registry, and one implementation both can
// call.
//
// ── THE SEAM SPLIT, WHICH IS THE PART THAT IS EASY TO GET WRONG ─────────────
//
// ⚠ TRANSPORT IS `engine-message`; SAVE IS `file-export`. They are different
// seams even though both start as a `postMessage` on the same port, and the
// reason is aliasing: SAVE TAPE sits in the SAME REEL BLOCK as REC, on the same
// node, so a probe watching `engine-message` for the export would be satisfied
// by somebody pressing REC. samsloop's export carries this warning in the
// registry and it is aimed at exactly this layout.
//
// ── WHY THE PROBES ARE AUDITIONS AND NOT `data` PROBES ─────────────────────
//
// The obvious-looking better answer is a `data` probe on `transportState_a` —
// the engine really does mirror every transport transition onto `node.data`, and
// the registry does say to prefer `data` where you can. MEASURED, YOU CANNOT
// HERE, and the failure would have been a permanently red gate rather than a
// wrong-but-green one:
//
//   `transportState_a` is written by the message handler in `twotracks.ts` when
//   the WORKLET POSTS BACK, and the worklet posts from `process()`. faces-parity
//   boots `/rack` and never passes the audio gate, so the context does not run,
//   `process()` is never called and no transport state is ever mirrored. The
//   press would be perfect and the probe would see nothing.
//
// An audition asks the question the runner can actually answer — did the press
// reach the seam — which is the kria narrowing ("do not give the sweep questions
// it cannot answer") applied to this module. The stronger claim, that a REC
// press actually records audio, is `twotracks.spec.ts`'s job and it drives real
// audio to make it.
//
// ⚠ `delivered` MEANS "THE SEAM WAS REACHED", NOT "SOMETHING HAPPENED" — the
// ledger's definition, and samsloop's export carries the same note. A press that
// resolved a live node and a live worklet port DELIVERED, whatever the worklet
// then chose to do with the message; only a press that found no engine, no node
// or no port did not.

import { getActiveEngine } from '$lib/audio/engine-ref';
import { patch } from '$lib/graph/store';
import type { ModuleNode } from '$lib/graph/types';
import { recordAudition } from './audition-ledger';
import type { TwoTracksData } from '$lib/audio/modules/twotracks';

/** The two reels, as the worklet names them. */
export type TwotracksReel = 'a' | 'b';

/** The transport one-shots. Each is a RISING EDGE, never a held state — which
 *  is why every transport cell declares `mode: 'trigger'`: a `gate` consumer
 *  driven by a click would open and never close. */
export type TwotracksTransportAction = 'rec' | 'play' | 'stop';

function liveNode(nodeId: string): ModuleNode | undefined {
  return patch.nodes[nodeId] as ModuleNode | undefined;
}

/**
 * Resolve the reel worklet's message port, or null.
 *
 * ⚠ NULL IS A REAL ANSWER, NOT A DEFENSIVE SHRUG. Before the audio graph is
 * built there is no port, and every caller here reports that as an undelivered
 * press rather than pretending it worked.
 */
function workletPort(nodeId: string): MessagePort | null {
  const node = liveNode(nodeId);
  if (!node) return null;
  const eng = getActiveEngine();
  if (!eng) return null;
  try {
    return (eng.read(node, 'workletPort') as MessagePort | undefined) ?? null;
  } catch {
    return null;
  }
}

/**
 * REC / PLAY / STOP on one reel.
 *
 * Returns whether the message reached the worklet, and records the audition
 * either way so "pressed and reached nothing" stays distinguishable from "never
 * pressed".
 */
export function twotracksTransport(
  nodeId: string,
  reel: TwotracksReel,
  action: TwotracksTransportAction,
): boolean {
  const port = workletPort(nodeId);
  if (!port) {
    recordAudition({ nodeId, seam: 'engine-message', delivered: false });
    return false;
  }
  port.postMessage({ type: 'transport', reel, action });
  recordAudition({ nodeId, seam: 'engine-message', delivered: true });
  return true;
}

/**
 * SAVE TAPE — ask the worklet to dump one reel's recorded audio, which the
 * module's message handler turns into a downloaded WAV.
 *
 * ⚠ AN EXPORT OF AN EMPTY REEL IS A REAL STATE A USER CAN REACH, and the card
 * today answers it with a silent no-op (the button is merely `disabled`). The
 * face records it: the press reached the seam, so it DELIVERED, and the RETURN
 * is `false` so a caller that cares about the difference has it. That is
 * samsloop's ruling applied unchanged — recording `delivered: false` for an
 * empty reel would make every bare-rack press look like a broken button, and
 * faces-parity presses on a bare rack.
 *
 * ⚠ WHAT THIS CANNOT SEE, stated rather than left implicit: that BYTES reached a
 * file. Nothing on a bare rack can. `twotracks.spec.ts` records a real take.
 */
export function twotracksSaveTape(nodeId: string, reel: TwotracksReel): boolean {
  const node = liveNode(nodeId);
  const port = workletPort(nodeId);
  if (!node || !port) {
    recordAudition({ nodeId, seam: 'file-export', delivered: false });
    return false;
  }
  port.postMessage({ type: 'dump-tape', reel });
  recordAudition({ nodeId, seam: 'file-export', delivered: true });
  return twotracksReelHasTape(node, reel);
}

/** Does this reel hold a recorded take? Reads the length the engine mirrors
 *  onto `node.data` — the one place a length is durable. */
export function twotracksReelHasTape(node: ModuleNode | undefined, reel: TwotracksReel): boolean {
  const d = node?.data as TwoTracksData | undefined;
  const len = reel === 'a' ? d?.bufLenA : d?.bufLenB;
  return typeof len === 'number' && len > 0;
}

/**
 * SCRUB — move the playhead to `pos` (0..1 of the whole tape).
 *
 * ⚠ THIS IS AN ENGINE MESSAGE AND MUST STAY ONE. The playhead is transient
 * performance state that the worklet owns and streams back at frame rate;
 * routing it through a param would put a frame-rate cursor on the undo stack and
 * in the Y.Doc, which is the CV write-storm class this repo has a standing rule
 * against. Its sibling gesture on the same canvas — dragging the LOOP MARKERS —
 * goes the other way for the same reason inverted: a loop window is a durable
 * setting, so it writes `start_*` / `end_*` through `setNodeParam` and IS
 * undoable. Preserving that split exactly is the whole seam argument.
 *
 * No audition: this is a drag on the body, not a cell the parity sweep presses.
 */
export function twotracksSeek(nodeId: string, reel: TwotracksReel, pos: number): void {
  workletPort(nodeId)?.postMessage({ type: 'seek', reel, pos });
}

/** Report how fast the player is dragging, so the worklet can pitch the scrub
 *  like a hand on a reel. Transient, like the seek. */
export function twotracksScrubVelocity(nodeId: string, reel: TwotracksReel, velocity: number): void {
  const node = liveNode(nodeId);
  const eng = getActiveEngine();
  if (!node || !eng) return;
  try {
    eng.setParam(node, reel === 'a' ? 'scrubVelocity_a' : 'scrubVelocity_b', velocity);
  } catch {
    /* engine may not be ready */
  }
}

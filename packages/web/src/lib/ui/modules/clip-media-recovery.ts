// packages/web/src/lib/ui/modules/clip-media-recovery.ts
//
// CRASH RECOVERY for clip takes — the seam between the store's manifests and
// the launcher's pads.
//
// ⚠ IT LIVES IN `lib/ui/**`, NOT `lib/video/**`. `lib/video/**` is hashed
// wholesale for the real-GPU WebGL attest, which is why #2314 created
// `lib/ui/modules/recorderbox-transport.ts` rather than leaving the equivalent
// code next to the recorder. Same rule, same reason.
//
// ⚠ RECOVERY DOES NOT TRUNCATE THE FILE. It writes a clip whose `frames` is the
// last whole loop and leaves the tail bytes on disk. Two reasons: destructively
// shortening a file to make a number true is irreversible if the arithmetic is
// wrong, and the record's `frames` is already the authority every reader uses.
// The extra bytes cost a fraction of one loop and are freed with the clip.

import {
  clipIndex,
  coerceClipRecord,
  type AudioClipRecord,
  type ClipPlayerData,
} from '$lib/audio/modules/clip-types';
import {
  listRecoverableClipMedia,
  readClipMedia,
  recoverableFrames,
  removeClipMedia,
  finishClipMediaTake,
  type ClipMediaManifest,
} from '$lib/audio/clip-media-store';
import { clipUndoTransact } from '$lib/control/clip-undo';
import { patch } from '$lib/graph/store';

/** A recoverable take, with the arithmetic already done. */
export interface ClipRecoveryCandidate {
  manifest: ClipMediaManifest;
  /** Bytes actually on disk. */
  bytes: number;
  /** The honest playable length — truncated to the last whole `unitFrames`. */
  frames: number;
  /** How many whole loops that is. Zero means there is nothing to offer. */
  loops: number;
}

/** This node's recoverable takes, WORTH OFFERING ONLY.
 *
 *  ⚠ A CANDIDATE WITH LESS THAN ONE WHOLE LOOP IS FILTERED OUT, not offered
 *  and then refused. Arm–Endless promises whole multiples of the unit loop; a
 *  prompt that offers to restore two-thirds of a bar and then hands back
 *  nothing is a worse outcome than never offering. Its bytes stay on disk as a
 *  candidate the GC spares (status is still `recording`) until the user
 *  discards it — the same shape recorderbox uses for a failed delivery. */
export async function scanClipRecoveries(nodeId: string): Promise<ClipRecoveryCandidate[]> {
  const manifests = await listRecoverableClipMedia(nodeId);
  const out: ClipRecoveryCandidate[] = [];
  for (const manifest of manifests) {
    const file = await readClipMedia(manifest.mediaId);
    const bytes = file?.size ?? 0;
    const frames = recoverableFrames(manifest, bytes);
    if (frames < 1) continue;
    out.push({ manifest, bytes, frames, loops: Math.round(frames / manifest.unitFrames) });
  }
  return out;
}

/** Commit a recovered take into its slot as a real audio clip.
 *
 *  ONE `clipUndoTransact`, so the whole recovery is one undo unit — the same
 *  atomic-pass rule the note recorder commits under. */
export async function recoverClipTake(
  nodeId: string,
  candidate: ClipRecoveryCandidate,
): Promise<boolean> {
  const { manifest, frames } = candidate;
  if (frames < 1) return false;
  const node = patch.nodes[nodeId];
  if (!node) return false;
  const index = clipIndex(manifest.slot, manifest.lane);

  // ⚠ NEVER OVERWRITE A CLIP THE USER ALREADY HAS. The crash left this slot
  // empty, but a peer (or the user, before the recovery was offered) may have
  // put something there since. A slot holds exactly one clip, and silently
  // replacing an authored one to restore a take nobody asked for is the worst
  // outcome available.
  const existing = coerceClipRecord(
    ((node.data as ClipPlayerData | undefined)?.clips ?? {})[String(index)],
  );
  if (existing) return false;

  const record: AudioClipRecord = {
    kind: 'audio',
    mediaId: manifest.mediaId,
    lengthSteps: Math.max(1, Math.round(manifest.lengthSteps)),
    frames,
    sampleRate: manifest.sampleRate,
    channels: manifest.channels,
    format: manifest.format,
    takeAt: Date.now(),
    loop: true,
  };

  clipUndoTransact(nodeId, () => {
    const d = (node.data ?? (node.data = {})) as ClipPlayerData;
    if (!d.clips) d.clips = {};
    d.clips[String(index)] = record;
  });

  // Only NOW is the take done: the clip that names it exists, so the GC's live
  // set covers it and dropping the `recording` status can no longer orphan it.
  await finishClipMediaTake(manifest.mediaId, frames);
  return true;
}

/** Throw a recovered take away — bytes and manifest together. */
export async function discardClipTake(candidate: ClipRecoveryCandidate): Promise<void> {
  await removeClipMedia(candidate.manifest.mediaId);
}

/** The prompt's one line of text. A count of LOOPS, not a byte size or a
 *  sample count: loops are the unit the take was recorded in and the only one
 *  that tells the player what they are about to get back. */
export function clipRecoveryLabel(c: ClipRecoveryCandidate): string {
  const { lane, slot } = c.manifest;
  const loops = c.loops === 1 ? '1 loop' : `${c.loops} loops`;
  return `lane ${lane + 1} · slot ${slot + 1} · ${loops}`;
}

// packages/web/src/lib/multiplayer/samsloop-limits.ts
//
// SAMSLOOP has both a per-user and per-rackspace cap to keep the rack's
// memory footprint bounded. Mirrors the picturebox-limits.ts pattern so
// the spawn-time enforcement plumbing in Canvas.svelte can reuse the
// same shape.
//
// Cap derivation — measured, not estimated. See:
//   e2e/tests/samsloop-memory-bench.spec.ts
// Run via `E2E_RUN_MEM_BENCH=1 task e2e -- tests/samsloop-memory-bench.spec.ts`
// to reproduce. Results (Chromium 14x, darwin/arm64, May 2026):
//
//   N=30 instances × 8_000 sample payload
//   heap before : ~11.4 MB
//   heap after  : ~137.8 MB
//   per-instance: ~4.21 MB measured
//   projected   : ~4.43 MB at worst-case 250 KB raw WAV (62_500 floats)
//
// The bulk of the per-instance cost is NOT the Float32 audio buffer
// itself — it's the syncedstore CRDT proxy chain wrapping each sample
// as a YArray entry (one CRDT record per sample). Per-instance overhead
// dominates the payload by ~16×. This is a real constraint imposed by
// the multiplayer-first storage shape and is the reason SAMSLOOP needs
// a tighter cap than a glance at the 250 KB file size would suggest.
//
// Budget math:
//   • Worst-case per-instance footprint: ~4.4 MB.
//   • Target browser tab budget for SAMSLOOP alone: ~100 MB.
//     (A 2 GB tab is the conservative practical ceiling; ~5% of that
//     leaves headroom for the rest of the audio graph + video pipeline
//     + multiplayer state.)
//   • 100 MB / 4.4 MB = ~22 instances. Round DOWN to 20 for safety
//     headroom + a clean number.
//   • Per-user cap = floor(perRackspace / 4) = 5, applying the
//     multi-user constraint that a rack supports up to 4 collaborators
//     ([[multiuser-constraints]]).
//
// NOTE (post-cap-bump PRs): the 4.4 MB per-instance figure above came
// from the OLD persistence path that stored decoded PCM as a YArray
// (one CRDT record per sample) — that path was retired when the decoded
// cap was raised from 144_000 to 1_500_000 samples. Uploads now persist
// the ORIGINAL file bytes via a base64 string (single opaque Yjs value,
// bounded by SAMSLOOP_MAX_FILE_BYTES). Per-instance Yjs cost dropped
// roughly an order of magnitude vs the old YArray path; the decoded
// buffer lives in the worklet's private memory (off the main-thread heap,
// bounded by SAMSLOOP_MAX_DECODED_SAMPLES = 1.5M floats ≈ 6 MB worst
// case).
//
// FILE-BYTE CAP RAISE (this PR): SAMSLOOP_MAX_FILE_BYTES went 250 KB → 2 MB
// so larger samples (e.g. a full short song / field recording) load. These
// COUNT caps (20 per rack / 5 per user) are NOT a per-sample byte gate —
// there is no per-sample byte limit here, so a single 2 MB sample is
// accepted. The collab cost is the dominant new consideration: a 2 MB
// upload persists as ~2.7 MB of base64 in node.data, synced as ONE opaque
// Yjs value through the single-process relay (see relay-single-process-and-
// drift). Worst case at the rackspace cap = 20 × ~2.7 MB ≈ ~54 MB of Yjs
// string state, comfortably inside the ~100 MB SAMSLOOP tab budget (the
// decoded PCM is off-heap in worklet memory). The 20/5 caps therefore
// still hold with headroom even at the 2 MB file cap — no re-tune needed
// until we hit a different bottleneck. (If samples routinely run near 2 MB
// AND racks routinely run near 20 instances, revisit the per-rackspace
// cap against the relay's per-doc memory then.)
//
// Creator attribution lives at `node.data.creatorId` (set by Canvas's
// spawnFromPalette — same pattern as PICTUREBOX). Pre-existing SAMSLOOP
// nodes from before this PR have no creatorId — they count toward the
// rackspace total but NOT toward any specific user's cap. This matches
// PICTUREBOX's "loose grandfathering" so the cap can roll out without
// breaking existing patches.

export const SAMSLOOP_LIMITS = {
  /** Per-user cap. floor(perRackspace / 4) given up to 4 collaborators
   *  per rack — keeps the cap fair even when everyone fills theirs. */
  perUser: 5,
  /** Per-rackspace cap. ~100 MB / ~4.4 MB per instance = 22, rounded
   *  down to 20 for headroom. See bench data above. */
  perRackspace: 20,
} as const;

export const SAMSLOOP_TYPE = 'samsloop';

/** Exact user-facing message string for the per-user cap denial. The
 *  brief mandates this exact text; tests assert on it. */
export const SAMSLOOP_LIMIT_MESSAGE = 'sorry, SAMSLOOP limit exceeded';

/** Shape we accept; tolerates both the live syncedstore proxy AND plain
 *  test fixtures by typing `data` as `unknown` (we read defensively). */
type NodeLike = { type?: string; data?: unknown };
type NodeMap = Record<string, NodeLike | undefined>;

/** Total SAMSLOOP nodes currently in the rackspace. */
export function countSamsloopsTotal(nodes: NodeMap): number {
  let n = 0;
  for (const node of Object.values(nodes)) {
    if (node && node.type === SAMSLOOP_TYPE) n++;
  }
  return n;
}

/**
 * Number of SAMSLOOP nodes attributable to a given user. Only counts
 * nodes whose `data.creatorId` matches userId — anonymous / unattributed
 * nodes do NOT count, by design (see grandfathering note above).
 */
export function countSamsloopsByCreator(
  nodes: NodeMap,
  userId: string | null | undefined,
): number {
  if (!userId) return 0;
  let n = 0;
  for (const node of Object.values(nodes)) {
    if (!node || node.type !== SAMSLOOP_TYPE) continue;
    const cid = (node.data as { creatorId?: unknown } | undefined)?.creatorId;
    if (cid === userId) n++;
  }
  return n;
}

export type SamsloopSpawnDecision =
  | { ok: true }
  | { ok: false; reason: 'per-user-cap'; cap: number; current: number }
  | { ok: false; reason: 'rackspace-cap'; cap: number; current: number };

/**
 * Decide whether a NEW SAMSLOOP may be spawned right now. Returns a
 * tagged result so the caller can render an actionable message (which
 * cap was hit, what the cap is, what the current count is).
 *
 * Order matters: the per-USER cap is checked first because hitting it
 * is fixable by the same user (delete one of yours), while hitting the
 * rackspace cap is a social problem (someone else needs to delete one).
 * Surfacing the per-user reason takes precedence.
 *
 * Single-user mode (userId null/undefined): the per-user cap is moot —
 * there's only one user, who can fill the whole rackspace up to the
 * rackspace cap. The helper just skips the per-user check.
 */
export function samsloopSpawnDecision(
  nodes: NodeMap,
  userId: string | null | undefined,
): SamsloopSpawnDecision {
  if (userId) {
    const userCount = countSamsloopsByCreator(nodes, userId);
    if (userCount >= SAMSLOOP_LIMITS.perUser) {
      return {
        ok: false,
        reason: 'per-user-cap',
        cap: SAMSLOOP_LIMITS.perUser,
        current: userCount,
      };
    }
  }
  const total = countSamsloopsTotal(nodes);
  if (total >= SAMSLOOP_LIMITS.perRackspace) {
    return {
      ok: false,
      reason: 'rackspace-cap',
      cap: SAMSLOOP_LIMITS.perRackspace,
      current: total,
    };
  }
  return { ok: true };
}

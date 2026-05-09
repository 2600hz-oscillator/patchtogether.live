// packages/web/src/lib/multiplayer/picturebox-limits.ts
//
// PICTUREBOX has both a per-user and per-workspace cap to keep the per-
// rack snapshot bounded (image bytes ride in the Y.Doc; see
// .myrobots/plans/picturebox-multiplayer-sync.md). 2 per user * 4 users
// per rack = 8, matching the workspace cap exactly — it's the tightest
// floor that still lets every user spawn their full quota without anyone
// getting blocked because someone else already filled the workspace.
//
// Creator attribution lives at `node.data.creatorId` (set by Canvas's
// spawnFromPalette). Pre-existing PICTUREBOX nodes from before this PR
// have no creatorId — they count toward the workspace total but NOT
// toward any specific user's cap (loose grandfathering: anyone can swap
// images in them).

export const PICTUREBOX_LIMITS = {
  perUser: 2,
  perWorkspace: 8,
} as const;

export const PICTUREBOX_TYPE = 'picturebox';

/** Shape we accept; tolerates both the live syncedstore proxy AND plain
 *  test fixtures by typing `data` as `unknown` (we read defensively). */
type NodeLike = { type?: string; data?: unknown };
type NodeMap = Record<string, NodeLike | undefined>;

/** Total PICTUREBOX nodes currently in the workspace. */
export function countPictureboxesTotal(nodes: NodeMap): number {
  let n = 0;
  for (const node of Object.values(nodes)) {
    if (node && node.type === PICTUREBOX_TYPE) n++;
  }
  return n;
}

/**
 * Number of PICTUREBOX nodes attributable to a given user. Only counts
 * nodes whose `data.creatorId` matches userId — anonymous / unattributed
 * nodes do NOT count, by design (see grandfathering note above).
 *
 * In single-user mode, callers pass `'local'` as the conceptual creator
 * id (Canvas writes that string when no multiplayer userId is present).
 */
export function countPictureboxesByCreator(
  nodes: NodeMap,
  userId: string | null | undefined,
): number {
  if (!userId) return 0;
  let n = 0;
  for (const node of Object.values(nodes)) {
    if (!node || node.type !== PICTUREBOX_TYPE) continue;
    const cid = (node.data as { creatorId?: unknown } | undefined)?.creatorId;
    if (cid === userId) n++;
  }
  return n;
}

export type PictureboxSpawnDecision =
  | { ok: true }
  | { ok: false; reason: 'per-user-cap'; cap: number; current: number }
  | { ok: false; reason: 'workspace-cap'; cap: number; current: number };

/**
 * Decide whether a NEW PICTUREBOX may be spawned right now. Returns a
 * tagged result so the caller can render an actionable toast (which cap
 * was hit, what the cap is, what the current count is).
 *
 * Order matters: the per-USER cap is checked first because hitting it
 * is fixable by the same user (delete one of yours), while hitting the
 * workspace cap is a social problem (someone else needs to delete one).
 * Surfacing the per-user reason takes precedence.
 */
export function pictureboxSpawnDecision(
  nodes: NodeMap,
  userId: string | null | undefined,
): PictureboxSpawnDecision {
  const userCount = countPictureboxesByCreator(nodes, userId);
  if (userCount >= PICTUREBOX_LIMITS.perUser) {
    return {
      ok: false,
      reason: 'per-user-cap',
      cap: PICTUREBOX_LIMITS.perUser,
      current: userCount,
    };
  }
  const total = countPictureboxesTotal(nodes);
  if (total >= PICTUREBOX_LIMITS.perWorkspace) {
    return {
      ok: false,
      reason: 'workspace-cap',
      cap: PICTUREBOX_LIMITS.perWorkspace,
      current: total,
    };
  }
  return { ok: true };
}

/** Human-readable explanation for a denied spawn. Used by the toast. */
export function explainSpawnDenial(decision: PictureboxSpawnDecision): string {
  if (decision.ok) return '';
  if (decision.reason === 'per-user-cap') {
    return `PICTUREBOX limit: ${decision.current}/${decision.cap} per user (delete one of yours to add another)`;
  }
  return `PICTUREBOX limit: ${decision.current}/${decision.cap} per rack (the workspace is full)`;
}

// packages/web/src/lib/video/modules/videobox-sync.ts
//
// Pure-functional playhead-sync helpers for VIDEOBOX. The card writes
// the SyncState below into Yjs (`node.data`) on every local play/pause/
// seek; every peer (including the writer) runs these helpers each tick
// to decide whether the local <video> is far enough out of step that we
// need to seek.
//
// Splitting this out keeps the math test-coverable without an actual
// HTMLVideoElement — the unit test mirrors a peer + walks wall-clock
// time forward, asserting the correction decisions match.

/** Shape stored on node.data for VIDEOBOX. */
export interface VideoboxSyncState {
  /** True when the player is logically playing (across all peers). */
  isPlaying: boolean;
  /** Wallclock ms (Date.now()) when the last sync write happened. Used as
   *  the time origin for extrapolating expected position while playing. */
  lastSyncTime: number;
  /** Video position (seconds) at lastSyncTime. */
  lastSyncPosition: number;
}

/** Persisted file metadata. Carries enough that peers can render an
 *  informative "you need a local copy" message + a stable seekbar even
 *  before they pick the file.
 *
 *  Persistence story (see VideoboxCard + video-file-store.ts):
 *    * `name` / `size` / `duration` are ALWAYS saved into the patch JSON.
 *      They drive the cross-browser, cross-machine "Re-link: drop
 *      <name> (<size>, <m:ss>)" prompt — every browser can show that.
 *    * `handleId`, when present, is the IndexedDB key under which THIS
 *      peer's browser stored the picked `FileSystemFileHandle`. On a
 *      reload of the same patch in the same Chromium browser, the card
 *      looks the handle up by this id and (after a one-click permission
 *      re-grant when needed) reloads the file automatically. The handle
 *      itself is NOT in the patch (it can't be serialized + is
 *      per-browser); only the id travels in the patch JSON. A peer
 *      without that id in its own IDB falls back to the re-link prompt.
 *    * `contentHash` is optional + reserved for a future "is this the
 *      same file?" verification on re-link; not required for the flow. */
export interface VideoboxFileMeta {
  /** Source filename (display only + re-link prompt label). */
  name: string;
  /** File duration in seconds (so peer seekbars have a max even before
   *  they load the file). */
  duration: number;
  /** File size in bytes. Always saved; shown in the re-link prompt
   *  ("12.4 MB") so the user can recognise the right copy. Optional for
   *  backward compatibility with pre-persistence saved patches. */
  size?: number;
  /** IndexedDB key for the persisted `FileSystemFileHandle` (Chromium
   *  one-click reload). Per-browser: present in the patch JSON, but the
   *  actual handle only lives in the picking peer's IndexedDB. */
  handleId?: string;
  /** Optional content hash (reserved for future re-link verification). */
  contentHash?: string;
  /** Optional: the loader's userId, so peer UIs can attribute. */
  loaderUserId?: string;
}

/** Drift threshold — if local position is more than this many seconds
 *  off the expected position, the peer seeks to expected. 0.5s matches
 *  the spec; tuned to be larger than typical frame jitter and smaller
 *  than the user's perceptual desync threshold for music videos. */
export const DRIFT_THRESHOLD_SEC = 0.5;

/**
 * Expected video position (seconds) right now, given the last shared
 * sync write. While playing, extrapolates `lastSyncPosition` forward by
 * elapsed wallclock. While paused, the expected position IS the last
 * sync position — paused state is stationary by definition.
 */
export function expectedPosition(
  state: VideoboxSyncState,
  nowWallclockMs: number,
): number {
  if (!state.isPlaying) return state.lastSyncPosition;
  const elapsedSec = Math.max(0, (nowWallclockMs - state.lastSyncTime) / 1000);
  return state.lastSyncPosition + elapsedSec;
}

/**
 * Decide whether the local <video>.currentTime needs a correction. Pure;
 * returns either { kind: 'ok' } or { kind: 'seek', to } so the caller
 * (the card's render loop) can apply the seek without re-deriving the
 * target value.
 *
 * Special cases:
 *   * If the expected position is past the duration AND we know the
 *     duration, we clamp to duration - epsilon so we don't try to seek
 *     past the end of the file (the browser silently no-ops + the next
 *     correction pass would loop on "fix me!"). The caller is responsible
 *     for stopping playback in that case.
 *   * If duration is NaN (file not yet loaded), the threshold check still
 *     runs against the raw extrapolation.
 */
export type DriftDecision =
  | { kind: 'ok' }
  | { kind: 'seek'; to: number };

export function decideDriftCorrection(
  state: VideoboxSyncState,
  localPositionSec: number,
  nowWallclockMs: number,
  durationSec: number,
): DriftDecision {
  let expected = expectedPosition(state, nowWallclockMs);
  if (Number.isFinite(durationSec) && durationSec > 0 && expected > durationSec) {
    expected = Math.max(0, durationSec - 0.05);
  }
  const drift = Math.abs(localPositionSec - expected);
  if (drift > DRIFT_THRESHOLD_SEC) return { kind: 'seek', to: expected };
  return { kind: 'ok' };
}

/**
 * Build the state the writer should commit to Yjs when the user takes
 * a local play / pause / seek action. Caller writes this verbatim into
 * `patch.nodes[id].data` (inside a transact).
 *
 * `currentPositionSec` is the <video>.currentTime at the moment of the
 * action; for play/pause it's where the head is right now; for a seek
 * it's the new target position the user just dragged to.
 *
 * `nowWallclockMs` should be Date.now() — passed in so tests can be
 * deterministic. We DON'T fold in any latency compensation (no
 * round-trip estimate, no half-RTT adjustment) — peers tolerate up to
 * DRIFT_THRESHOLD_SEC of slack before correcting, which covers the
 * typical Yjs broadcast latency over WebSocket on the same network.
 */
export function buildSyncWrite(args: {
  isPlaying: boolean;
  currentPositionSec: number;
  nowWallclockMs: number;
}): VideoboxSyncState {
  return {
    isPlaying: args.isPlaying,
    lastSyncTime: args.nowWallclockMs,
    lastSyncPosition: args.currentPositionSec,
  };
}

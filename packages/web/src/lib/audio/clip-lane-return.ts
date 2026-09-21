// Clip Player lane N returns to MIXMSTRS channel N after the live-input gain.
// Instrument cables stay connected: board-in capture taps are before that
// gain, and recorded playback mutes only the live branch. An explicit cable
// carrying this same return to its matching channel replaces the internal
// stereo connection and disables that channel's automatic live-input duck.
// Playback transitions are scheduled in AudioContext time, matching source
// starts/stops instead of deriving audio boundaries from timer ticks.

/** Historical MON-mode types retained for compatibility tests. The shipped
 * mixer has no MON control; source choice belongs to each clip. */
export type ClipLaneMonMode = 'live' | 'both' | 'clip-auto';

/** The MON values in param order — index N is the param's discrete value N. */
export const CLIP_LANE_MON_MODES = ['live', 'both', 'clip-auto'] as const;

/** DEFAULT MON. `clip-auto`, per the owner's pick: the zero-gesture behaviour
 *  is the one a new user gets. */
export const DEFAULT_CLIP_LANE_MON: ClipLaneMonMode = 'clip-auto';

/** Coerce a stored/param value to a MON mode. NEVER fails — an unknown value is
 *  the default, so a corrupt patch monitors rather than going silent. Accepts
 *  both the string and the discrete param index. PURE. */
export function coerceClipLaneMon(v: unknown): ClipLaneMonMode {
  if (typeof v === 'string') {
    return (CLIP_LANE_MON_MODES as readonly string[]).includes(v)
      ? (v as ClipLaneMonMode)
      : DEFAULT_CLIP_LANE_MON;
  }
  if (typeof v === 'number' && Number.isFinite(v)) {
    return CLIP_LANE_MON_MODES[Math.round(v)] ?? DEFAULT_CLIP_LANE_MON;
  }
  return DEFAULT_CLIP_LANE_MON;
}

/** One scheduled change of a lane's playing state, in the ONE currency the
 *  audio thread can act on: a value and the CONTEXT TIME it takes effect.
 *
 *  ⚠ `atTime` IS A `ctx.currentTime`-DOMAIN SECOND, and it is the SAME instant
 *  the clip's own source node is started or stopped on — not "when the main
 *  thread noticed". That is what makes the duck land on the clip's first sample
 *  instead of somewhere inside the quantum that observed it. */
export interface ClipLanePlayingEdge {
  /** 0..CLIP_LANES-1 — which lane changed, and therefore which mixer channel. */
  lane: number;
  /** True when the lane's clip STARTS sounding at `atTime`, false when it
   *  stops. */
  playing: boolean;
  /** The `AudioContext.currentTime`-domain instant the change takes effect. */
  atTime: number;
}

/** Coerce a raw cross-module value to a `ClipLanePlayingEdge`, or null.
 *
 *  The edge crosses a module boundary (clipplayer publishes it through the
 *  engine's `write` seam; mixmstrs consumes it), so the consumer validates at
 *  the boundary rather than trusting the sender's spelling — a renamed field
 *  must become a dropped edge here, never a `NaN` scheduled onto an AudioParam
 *  (`setTargetAtTime(NaN, …)` throws inside the mixer's write handler). PURE. */
export function coerceClipLanePlayingEdge(v: unknown): ClipLanePlayingEdge | null {
  if (!v || typeof v !== 'object') return null;
  const e = v as Record<string, unknown>;
  const lane = e.lane;
  if (typeof lane !== 'number' || !Number.isInteger(lane) || lane < 0) return null;
  if (typeof e.playing !== 'boolean') return null;
  if (typeof e.atTime !== 'number' || !Number.isFinite(e.atTime)) return null;
  return { lane, playing: e.playing, atTime: e.atTime };
}

/** Legacy MON-mode calculation; current runtime uses per-clip source edges. */
export function clipLaneLiveGain(mon: ClipLaneMonMode, lanePlaying: boolean): number {
  if (mon === 'live') return 1;
  if (mon === 'both') return 1;
  return lanePlaying ? 0 : 1; // clip-auto
}

/** Keep the internal return while an instrument is patched for recording.
 * An explicit cable carrying this same Clip Player return into this channel
 * replaces the internal connection so the recording is never doubled. */
export function clipLaneNormalConnected(hasExplicitClipReturn: boolean): boolean {
  return !hasExplicitClipReturn;
}

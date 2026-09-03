// packages/web/src/lib/audio/clip-lane-return.ts
//
// THE NORMALLED RETURN — launcher lane N back into mixmstrs channel N.
//
// Owner decision, 2026-09-02: "record a loop and hear it take over" must work
// with ZERO cable moves. Lane N of the clip launcher is internally NORMALLED
// into mixmstrs channel N's input, exactly like a hardware normal: the internal
// connection BREAKS the moment a cable is patched into that channel's input
// jack, and the lane's own output jack keeps working either way (so the
// tape-return patterns people already build are untouched).
//
// This file is the SEAM ONLY — types and one pure decision function, no state
// and no nodes. mixmstrs (the MON param, the duck gain, the normal) and
// clipplayer (the return source) both import it; NEITHER owns it, because a
// contract owned by one end of a normal is a contract the other end can drift
// from.
//
// ── WHY THE DUCK IS SCHEDULED, NOT POLLED ──────────────────────────────────
//
// The duck's input is "is lane N's clip playing right now", and the naive
// reading of "the duck consumes it every render quantum" is a per-quantum read
// of lane state. That is the one implementation this file exists to rule out:
//
//   - A Y.Doc / syncedStore read per quantum is the CV-modulation write-storm
//     defect wearing a different hat, and it is not even available on the audio
//     thread.
//   - A main-thread `Map` (the `clip-lane-phase.ts` shape) is cheap, but the
//     audio thread cannot see it either. Bridging it with a per-tick param
//     write would re-derive a boundary from a TICK COUNT, and deriving a
//     boundary from ticks instead of the context clock is the blood failure:
//     29,846 frames/s produced against 48,000 demanded, 38 % of every output
//     sample a hard zero.
//
// So lane-playing reaches the audio thread the way every other boundary in this
// design does — as a value SCHEDULED AT A CONTEXT TIME. Playback already knows
// the exact `ctx.currentTime` at which a lane's clip starts and stops (it is
// the same launch boundary the clip is scheduled on), so the mixer ramps the
// live branch's gain AT that instant with one AudioParam event per transition.
// Two events per launch, not 375 reads per second, and the duck lands on the
// same sample the clip does rather than up to one quantum away.
//
// ── WHERE THE DUCK SITS IN THE CHAIN ───────────────────────────────────────
//
//   channel N input jack ──► [ RECORDING TAP ] ──► [ duck gain ] ──┐
//                                                                  ├─► merger ─► Faust
//   launcher lane N (normalled, broken by a patched cable) ────────┘
//
// ⚠ THE TAP IS BEFORE THE DUCK, AND THAT ORDER IS LOAD-BEARING. A take must be
// able to capture the live input WHILE a previous take is playing and ducking
// that same input — otherwise the second pass of an overdub-by-hand records the
// silence the first pass caused. Ducking before the tap would make the feature
// quietly record nothing, which is the failure mode that looks like success.
//
// ⚠ AND THE RETURN IS NOT DUCKED. The duck attenuates the LIVE branch only; the
// normalled return sums in after it. `clip-auto` means "the clip replaces the
// live input", not "the channel goes quiet".

/** How a mixmstrs channel treats its normalled launcher return — the `MON`
 *  param. A real param (CV-drivable, and claimed as channel-scoped by the
 *  `ch{N}_` naming rule like every other per-channel control).
 *
 *  - `live`      — ignore the return; the channel is its patched input, full
 *                  stop. The pre-feature behaviour, kept reachable.
 *  - `both`      — sum them. The DOUBLING pattern, and explicit: a player who
 *                  wants to play along with their own loop asks for it.
 *  - `clip-auto` — DEFAULT. The live input is muted while that lane's clip is
 *                  PLAYING and restored when it stops. This is the setting that
 *                  makes "record a loop, hear it take over" need no cable
 *                  moves and no second gesture. */
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

/** The gain the LIVE branch of channel N should hold, given the channel's MON
 *  mode and whether that lane's clip is currently playing.
 *
 *  Deliberately returns a GAIN and not a boolean: the caller ramps an
 *  AudioParam to it over a short de-zipper, and a boolean would invite a hard
 *  `.value =` write — a discontinuity, i.e. a click, on every launch.
 *
 *  PURE, and the SINGLE definition of what MON means. The mixer schedules it
 *  and the face explains it from the same function, so the tooltip cannot
 *  promise behaviour the audio does not have. */
export function clipLaneLiveGain(mon: ClipLaneMonMode, lanePlaying: boolean): number {
  if (mon === 'live') return 1;
  if (mon === 'both') return 1;
  return lanePlaying ? 0 : 1; // clip-auto
}

/** Whether the internal normal from lane N to channel N is CONNECTED.
 *
 *  A hardware normal is broken by inserting a jack, and this is that rule and
 *  nothing more: `channelHasPatchedInput` is a GRAPH fact (does any cable land
 *  on this channel's input port), never an audio probe. "Is anything actually
 *  coming out of that cable" is exactly the runtime "is it really X?" heuristic
 *  the stereo policy bans by name — a patched-but-silent source still breaks
 *  the normal, on hardware and here. PURE. */
export function clipLaneNormalConnected(channelHasPatchedInput: boolean): boolean {
  return !channelHasPatchedInput;
}

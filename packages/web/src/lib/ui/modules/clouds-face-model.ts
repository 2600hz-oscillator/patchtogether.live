// packages/web/src/lib/ui/modules/clouds-face-model.ts
//
// The PURE MODEL behind the CLOUDS faceplate — every number the hero, the
// readouts and the ring picture print, derived from the live params through the
// worklet's OWN control laws.
//
// ⚠ WHY THIS FILE EXISTS AT ALL, in one paragraph. clouds has no dead controls
// and no clipping hazard; what it has is INVISIBILITY. Its most confusing
// behaviour — that it is bit-silent at spawn, then ~12 dB down until the ring
// has filled — is a function of TIME and of SIZE and is stated nowhere. Its
// strongest control (POSITION) moves the output waveform ENTIRELY while moving
// its level by 0.17 dB, so every RMS-based sweep in the repo, and three of the
// spec's own passes, report "POSITION does nothing". A `paramId` readout on
// either prints a correct number that says none of it.
//
// (The third thing it had was a real DEAD ZONE — SIZE's top 19.50 % rendered
// bit-identical output, which this model printed as `CLAMPED` rather than
// painting a dead dial as a working one. Fixed in the DSP in #1456; the badge
// is gone and the oracle that pinned it is now inverted, asserting the whole
// travel is ALIVE against the shipping worklet.)
//
// Every law below is the worklet's, re-derived rather than approximated, and
// each is anchored to `cloudsMath` (the pure-math mirror of the worklet) by an
// ORACLE leg in clouds-face-model.test.ts — so a DSP change turns a stale claim
// RED instead of letting the faceplate keep insisting on it.
//
// PURE: no DOM, no engine, no store.

import {
  CLOUDS_BUFFER_SECONDS,
  CLOUDS_GRAIN_CAP_FRACTION,
  CLOUDS_GRAIN_MAX_MS,
  CLOUDS_GRAIN_MIN_MS,
  CLOUDS_MAX_GRAINS,
  CLOUDS_SPAWN_MAX_HZ,
  CLOUDS_SPAWN_MIN_HZ,
} from '$lib/audio/modules/clouds';

export interface CloudsFaceParams {
  position: number;
  size: number;
  pitch: number;
  density: number;
  texture: number;
  blend: number;
}

/** Read the six macros through the caller's reader (which already resolves def
 *  defaults for untouched params). TOTAL — a missing read falls back to the
 *  def's own default, never to NaN. */
export function cloudsFaceParams(read: (paramId: string) => number | undefined): CloudsFaceParams {
  const g = (id: string, dflt: number): number => {
    const v = read(id);
    return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
  };
  return {
    position: g('position', 0.5),
    size: g('size', 0.5),
    pitch: g('pitch', 0),
    density: g('density', 0.5),
    texture: g('texture', 0.5),
    blend: g('blend', 0.5),
  };
}

// ── GRAIN LENGTH, AND THE TOP FIFTH OF THE SIZE KNOB ────────────────────────

/** The grain length SIZE asks for, before the buffer clamps it. The worklet's
 *  `ms = minMs * (maxMs/minMs)^size` (packages/dsp/src/clouds.ts spawnGrain). */
export function cloudsRequestedGrainMs(size: number): number {
  const s = Math.max(0, Math.min(1, size));
  return CLOUDS_GRAIN_MIN_MS * Math.pow(CLOUDS_GRAIN_MAX_MS / CLOUDS_GRAIN_MIN_MS, s);
}

/**
 * The hard ceiling: `safeLen = min(lengthSamples, floor(bufLen · fraction))`.
 *
 * ⚠ THIS USED TO BE 800 ms AGAINST A LAW THAT ASKED FOR 1500, AND THE
 * DISAGREEMENT WAS A DEAD ZONE — the top 19.50 % of SIZE rendered bit-identical
 * output. Fixed in the DSP (#1456): `CLOUDS_GRAIN_MAX_MS` is now derived from
 * `CLOUDS_GRAIN_CAP_FRACTION`, so the two are the same number by construction
 * and the clamp never binds. Kept mirrored here — including the `Math.min` in
 * `cloudsGrainMs` below — because this model's contract is to compute what the
 * worklet computes, not what it currently happens to reduce to. The
 * never-binding property is asserted (both directions) in
 * clouds-face-model.test.ts and against the SHIPPING WORKLET in
 * art/scenarios/clouds/size-travel.test.ts.
 */
export const CLOUDS_GRAIN_CEILING_MS =
  CLOUDS_BUFFER_SECONDS * CLOUDS_GRAIN_CAP_FRACTION * 1000;

/** The grain length actually used, in OUTPUT milliseconds. */
export function cloudsGrainMs(size: number): number {
  return Math.min(cloudsRequestedGrainMs(size), CLOUDS_GRAIN_CEILING_MS);
}

/**
 * The grain length in SOURCE milliseconds — how much BUFFER one grain covers.
 *
 * ⚠ TWO CLOCKS, AND THIS IS THE SECOND ONE. `g.age` advances one per OUTPUT
 * sample while `g.readPos` advances by `pitchRatio`, so a transposed grain
 * sounds for the same time and reads a different amount of tape. They differ by
 * exactly `2^(pitch/12)`, which is why the readout names its frame.
 */
export function cloudsSourceGrainMs(p: CloudsFaceParams): number {
  return cloudsGrainMs(p.size) * Math.pow(2, p.pitch / 12);
}

// ── THE GRAIN POOL, AND WHY DENSITY'S TOP HALF IS LEVEL-FLAT ────────────────

/** Grains per second at this DENSITY (the worklet's spawn interval inverted). */
export function cloudsSpawnHz(density: number): number {
  const d = Math.max(0, Math.min(1, density));
  return CLOUDS_SPAWN_MIN_HZ * Math.pow(CLOUDS_SPAWN_MAX_HZ / CLOUDS_SPAWN_MIN_HZ, d);
}

/**
 * The AVERAGE CONCURRENT grain count — spawn rate × grain length, capped at the
 * pool size. A spawn with no free slot is silently DROPPED (`findFreeGrain`
 * returns −1 and `spawnGrain` returns), so above the cap the knob keeps
 * spawning and the count does not move.
 *
 * ⚠ THIS IS THE MECHANISM BEHIND THE ONE MEASUREMENT THAT LOOKS LIKE A DEAD
 * CONTROL. DENSITY's level span is 8.80 dB and ALL of it is below 0.5
 * (−14.27 / −9.60 / −5.47 / −5.53 / −5.50 across the travel): at the shipped
 * SIZE the pool is FULL from density ≈ 0.49, so the top half changes the sound
 * completely (max|Δ| 0.73–0.96 against density 0.5) and the level not at all.
 * It depends on SIZE as well as DENSITY, which is exactly what a `paramId:
 * 'density'` readout is blind to.
 */
export function cloudsGrainCount(p: CloudsFaceParams): number {
  return Math.min(CLOUDS_MAX_GRAINS, cloudsSpawnHz(p.density) * (cloudsGrainMs(p.size) / 1000));
}

/** Is the pool saturated — i.e. is DENSITY spawning grains that get dropped? */
export function cloudsPoolFull(p: CloudsFaceParams): boolean {
  return cloudsSpawnHz(p.density) * (cloudsGrainMs(p.size) / 1000) >= CLOUDS_MAX_GRAINS;
}

/** The DENSITY at which the pool first saturates, at this SIZE (null when even
 *  density 1 cannot fill it — a long-grain / low-rate corner). */
export function cloudsPoolFullAt(size: number): number | null {
  const need = CLOUDS_MAX_GRAINS / (cloudsGrainMs(size) / 1000);
  if (need > CLOUDS_SPAWN_MAX_HZ) return null;
  if (need <= CLOUDS_SPAWN_MIN_HZ) return 0;
  return (
    Math.log(need / CLOUDS_SPAWN_MIN_HZ) / Math.log(CLOUDS_SPAWN_MAX_HZ / CLOUDS_SPAWN_MIN_HZ)
  );
}

// ── WHERE POSITION READS, IN THE BUFFER'S OWN UNITS ─────────────────────────

/**
 * The read window POSITION selects, as SECONDS BACK from the write head.
 *
 * `offset = safeLen + position * (bufLen − safeLen)` — so the NEAREST a grain
 * can ever start is one grain length behind the write head, and the furthest is
 * the whole 2.0 s ring. Both ends move with SIZE, which is the blindness a
 * `paramId: 'position'` readout has: it prints `0.50` at every size while the
 * reachable span shrinks from 1.94 s at SIZE 0 to 0.50 s at SIZE 1.
 */
export function cloudsPositionReach(p: CloudsFaceParams): { near: number; far: number } {
  return { near: cloudsGrainMs(p.size) / 1000, far: CLOUDS_BUFFER_SECONDS };
}

/** Where the grain STARTS, in seconds behind the write head. */
export function cloudsPositionSecondsBack(p: CloudsFaceParams): number {
  const { near, far } = cloudsPositionReach(p);
  return near + Math.max(0, Math.min(1, p.position)) * (far - near);
}

// ── THE TWO SECONDS, AND THE SILENCE BEFORE THEM ────────────────────────────

/**
 * How long the wet path is BIT-ZERO after a spawn (or a buffer clear).
 *
 * ⚠ IT IS EXACTLY ONE GRAIN LENGTH, and that is a measurement, not a guess.
 * While the ring is filling, `availableHistory = fillLevel`, so
 * `readPos = (1 − position)·(fillLevel − safeLen)` — negative, i.e. pointing
 * into never-written buffer, until `fillLevel` reaches `safeLen`. MEASURED
 * through the SHIPPING WORKLET (art/scenarios/clouds/size-travel.test.ts, and
 * mirrored against `cloudsMath` here), first non-zero output sample:
 *
 *   size 0    → 60.0 ms    (grain 60 ms)
 *   size 0.25 → 134.1 ms   (grain 134 ms)
 *   size 0.5  → 300.0 ms   (grain 300 ms)   ← the shipped default
 *   size 0.75 → 670.8 ms   (grain 671 ms)
 *   size 0.9  → 1087.2 ms  (grain 1087 ms)
 *   size 1    → 1500.0 ms  (grain 1500 ms)
 *
 * POSITION-invariant to the sample. The face spec authored against `main` said
 * "the first quarter second is bit-zero"; that was a bucket artifact of its own
 * 0.25 s measurement grid. The real quantity is a grain length and it MOVES —
 * across a 25× range now that SIZE's top fifth is no longer clamped (it was a
 * 13× range and flat above 0.8047 before #1456).
 */
export function cloudsSilenceMs(p: CloudsFaceParams): number {
  return cloudsGrainMs(p.size);
}

/**
 * When the output reaches full level, in seconds from spawn.
 *
 * The ring fills at exactly `BUFFER_SECONDS`, but a grain spawned an instant
 * before that still reads partly-unwritten tape for its whole life — so the
 * last quiet grain retires one grain length later. MEASURED (50 ms buckets,
 * broadband, blend 1): −17.8 dB at 2.00 s, −15.4 at 2.05, −10.9 at 2.10, −7.7
 * at 2.15, −6.4 at 2.20, steady −5.4 by 2.35 — a RAMP that starts at ≈2.02 s
 * and completes at ≈2.30 s, which is 2.0 s + the 300 ms grain. The spec's "the
 * step lands at t = 2.000 s to the sample" is the ring FILLING; it is not when
 * the module gets loud.
 */
export function cloudsFullLevelS(p: CloudsFaceParams): number {
  return CLOUDS_BUFFER_SECONDS + cloudsGrainMs(p.size) / 1000;
}

/**
 * The level cost of leaving PITCH 0, at the shipped defaults.
 *
 * ⚠ A CONSTANT AND NOT A FORMULA, DELIBERATELY. The mechanism is coherence: at
 * pitch 0 every grain reads the buffer at exactly the write rate, so the
 * overlapping grains stay phase-locked and sum LINEARLY; at any other pitch
 * they decorrelate and sum in POWER. The first-principles ratio is
 * `10·log10(N · E[env]² / E[env²])`, which lands at 12.55 dB for the shipped
 * 24 grains and a triangular window — and the measured step is 10.60 dB,
 * because the output `tanh` compresses the coherent case that the ratio does
 * not model. At TEXTURE 0 the formula is 4.7 dB out for the same reason. So
 * printing a derived dB would be a confident wrong number; the face prints the
 * STATE (coherent / spread) plus this measured constant, and the oracle leg in
 * clouds-face-model.test.ts re-derives the real step from `cloudsMath` so the
 * constant cannot go stale.
 */
export const CLOUDS_COHERENCE_DROP_DB = 10.6;

/** Is the pitch knob EXACTLY at the coherence detent? A threshold, not a
 *  slope: measured −5.47 dB at 0 against −17.60 at ±0.5 st, a musically
 *  negligible detune that costs the whole 12 dB. */
export function cloudsCoherent(p: CloudsFaceParams): boolean {
  return p.pitch === 0;
}

// ── FORMATTERS (what the readouts actually print) ───────────────────────────

function fmtMs(ms: number): string {
  return `${ms < 100 ? ms.toFixed(0) : Math.round(ms)} ms`;
}
function fmtS(s: number): string {
  return `${s.toFixed(2)} s`;
}

/** `300 ms out` · `1500 ms out` · `300 ms out · 600 ms of buffer`.
 *
 *  ⚠ THERE USED TO BE A THIRD FORM, `800 ms out · CLAMPED`, and its removal is
 *  the visible half of the DSP fix: SIZE's top fifth was bit-identical to its
 *  maximum, so the readout refused to paint that dial as working. The dial
 *  works now — 60 ms at SIZE 0 through 1500 ms at SIZE 1, every step distinct
 *  through the shipping worklet — so the badge would be a lie the other way. */
export function cloudsGrainText(p: CloudsFaceParams): string {
  const parts = [`${fmtMs(cloudsGrainMs(p.size))} out`];
  if (p.pitch !== 0) parts.push(`${fmtMs(cloudsSourceGrainMs(p))} of buffer`);
  return parts.join(' · ');
}

/** `24 of 24 · POOL FULL` · `7 of 24`. */
export function cloudsGrainCountText(p: CloudsFaceParams): string {
  const n = cloudsGrainCount(p);
  const head = `${n >= CLOUDS_MAX_GRAINS ? n.toFixed(0) : n.toFixed(1)} of ${CLOUDS_MAX_GRAINS}`;
  return cloudsPoolFull(p) ? `${head} · POOL FULL` : head;
}

/** `1.15 s back · of 0.30–2.00 s`. */
export function cloudsPositionText(p: CloudsFaceParams): string {
  const { near, far } = cloudsPositionReach(p);
  return `${fmtS(cloudsPositionSecondsBack(p))} back · of ${near.toFixed(2)}–${far.toFixed(2)} s`;
}

/** `COHERENT · 24 grains in phase` · `spread · 24 grains in power`. */
export function cloudsCoherenceText(p: CloudsFaceParams): string {
  const n = cloudsGrainCount(p);
  const grains = `${n >= CLOUDS_MAX_GRAINS ? n.toFixed(0) : n.toFixed(1)} grains`;
  return cloudsCoherent(p)
    ? `COHERENT · ${grains} in phase`
    : `spread · ${grains} in power`;
}

/** `300 ms` — the bit-zero window after a spawn or a clear. */
export function cloudsSilenceText(p: CloudsFaceParams): string {
  return fmtMs(cloudsSilenceMs(p));
}

/** `2.30 s` — 2.0 s of ring plus the last quiet grain. */
export function cloudsFullLevelText(p: CloudsFaceParams): string {
  return fmtS(cloudsFullLevelS(p));
}

// ── THE RING PICTURE (hero panel geometry) ──────────────────────────────────

/** How the hero panel labels the tape. PRIVATE VIEW STATE in the component —
 *  never `node.data` — and the panel's declared operability probe. */
export type CloudsAxisMode = 'time' | 'grains';

/**
 * One axis caption, at `t` in 0..1 of the ring (0 = the write head).
 *
 * ⚠ THE TWO MODES CAN NEVER RENDER THE SAME STRING, and that is load-bearing
 * rather than tidy: the panel's faces-parity probe is a `text` assertion that
 * the axis row CHANGED, so a tick that reads identically in both modes would
 * weaken the probe (and at t = 0 the naive forms are both "0"). The unit
 * suffix differs unconditionally, which the model test asserts across the whole
 * SIZE travel rather than at the default alone.
 */
export function cloudsAxisCaption(
  t: number,
  p: CloudsFaceParams,
  mode: CloudsAxisMode,
): string {
  const secondsBack = t * CLOUDS_BUFFER_SECONDS;
  if (mode === 'time') return `${secondsBack.toFixed(2)} s`;
  return `${(secondsBack / (cloudsGrainMs(p.size) / 1000)).toFixed(1)} ×`;
}

/** One drawn grain: a bar across the strip, in 0..1 of the 2.0 s ring where
 *  0 = the write head (NOW) and 1 = two seconds ago. */
export interface CloudsRingGrain {
  /** Nearest edge (smallest seconds-back), 0..1. */
  from: number;
  /** Furthest edge, 0..1. */
  to: number;
}

export interface CloudsRingPlan {
  /** Grain length in output ms. */
  grainMs: number;
  /** Where the read window starts / ends, in 0..1 of the ring. */
  readFrom: number;
  readTo: number;
  /** The band POSITION can never place a grain START inside — the newest
   *  `grain` seconds. Drawn shaded, because "one grain behind, minimum" is not
   *  a fact any dial says. */
  deadNoseTo: number;
  /** The grains, staggered deterministically across the read window. */
  grains: readonly CloudsRingGrain[];
  /** Concurrent grain count and whether the pool is saturated. */
  grainCount: number;
  poolFull: boolean;
  /** Seconds-back of the read start (the hero's headline number). */
  secondsBack: number;
}

/**
 * The ring strip, as a PURE FUNCTION OF THE PARAMS.
 *
 * ⚠ NO CLOCK, NO ENGINE POLL, AND THAT IS THE DESIGN RATHER THAN A SHORTCUT.
 * The obvious hero for this module is a live write head sweeping the ring, and
 * it is exactly the wrong thing to draw: the observable that would drive it —
 * the worklet's `fillLevel` — is not an AudioParam and is not posted to the
 * host, so there is nothing honest to read, and anything derived from
 * `AudioContext.currentTime` would make the VRT baseline a race against boot
 * time. Every quantity here is a function of the six macros, so the picture is
 * byte-deterministic on a frozen graph, on a live graph, and on a rack that has
 * never made a sound. What the picture cannot show — that the ring is still
 * filling right now — is stated as a NUMBER instead (`silent for` / `full level
 * at`), where it is true without needing a clock.
 *
 * ⚠ THE GRAIN STAGGER IS THE WORKLET'S OWN DRIFT LAW, and getting it right is
 * what makes this picture teach the module's headline surprise instead of
 * decorating it. Everything here is drawn in ONE frame — SECONDS BEHIND THE
 * WRITE HEAD — and in that frame a grain does not sit still: it was spawned at
 * offset `O` when the head was `a` seconds earlier, and since then `readPos`
 * has advanced by `a·ratio` while the head advanced by `a`, so it now sits at
 *
 *     O + a·(1 − ratio)
 *
 * At PITCH 0 that term is exactly ZERO for every grain — all N track the head
 * at the same distance and are therefore reading THE SAME SAMPLE at the same
 * moment, which is not a coincidence, it IS the coherence that makes pitch 0
 * ~10.6 dB louder than anywhere else. Transpose and they fan out across a grain
 * length and decorrelate. So the aligned stack and the fan are the two states
 * the level jumps between, drawn.
 *
 * (A first draft staggered them by `i/n` of a window — a plausible "comb of
 * overlap" that would have looked busy and taught the opposite of the truth at
 * the default. Caught by screenshotting the thing and looking at it.)
 *
 * Ages are spread evenly over one grain length rather than sampled from the
 * worklet's LCG, because the picture is of the SCHEDULE, not of one realisation
 * of it.
 */
export function cloudsRingPlan(p: CloudsFaceParams): CloudsRingPlan {
  const grainMs = cloudsGrainMs(p.size);
  const grainS = grainMs / 1000;
  const grainFrac = grainS / CLOUDS_BUFFER_SECONDS;
  const start = cloudsPositionSecondsBack(p) / CLOUDS_BUFFER_SECONDS;
  // A grain reads FORWARD (toward the present) from its start offset, covering
  // `grain × 2^(pitch/12)` seconds of tape.
  const ratio = Math.pow(2, p.pitch / 12);
  const span = Math.min(1, (cloudsSourceGrainMs(p) / 1000) / CLOUDS_BUFFER_SECONDS);
  const readTo = start;
  const readFrom = Math.max(0, start - span);

  const n = Math.max(1, Math.round(cloudsGrainCount(p)));
  const drawn = Math.min(n, 12);
  const grains: CloudsRingGrain[] = [];
  for (let i = 0; i < drawn; i++) {
    const age = drawn > 1 ? (i / drawn) * grainS : 0;
    const shift = (age * (1 - ratio)) / CLOUDS_BUFFER_SECONDS;
    grains.push({
      from: Math.max(0, Math.min(1, readFrom + shift)),
      to: Math.max(0, Math.min(1, readTo + shift)),
    });
  }

  return {
    grainMs,
    readFrom,
    readTo,
    deadNoseTo: grainFrac,
    grains,
    grainCount: cloudsGrainCount(p),
    poolFull: cloudsPoolFull(p),
    secondsBack: cloudsPositionSecondsBack(p),
  };
}

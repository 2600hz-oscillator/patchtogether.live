// packages/web/src/lib/ui/modules/cofefve-face-model.ts
//
// THE PURE MODEL BEHIND COFEFVE's FACEPLATE — the enabler graph the sidebar
// prints, the effective echo geometry the hero picture draws, and the three
// hero readouts.
//
// ⚠ ONE LAW, EVERY SURFACE. `echoTrain` is the only place the picture's
// geometry is written down, and `ENABLER_PAIRS` is the only place the
// dependency graph is written down: the sidebar lines, the `waiting` count and
// the greyed-out WOW ripple all read the SAME two structures. A panel that drew
// its own train beside a count computed from a second list would be two
// pictures of two modules that happen to agree at the defaults — the divergence
// class CLAUDE.md documents.
//
// ⚠ NO RANGE, CURVE OR DEFAULT IS RE-TYPED HERE. `cofefveFaceParams` resolves a
// missing value off `cofefveDelayDef`, and the only constants below are the
// DSP's own, each named after the line of `analog-delay-core.ts` it mirrors —
// and `FEEDBACK_MAX` / `SYNC_BEATS` are IMPORTED from that file rather than
// copied, so a DSP edit moves this model with it instead of silently past it.
//
// WHERE THE ENABLER GRAPH COMES FROM. Every edge below is a line of
// `AnalogDelayCore.processSample`, not an opinion:
//
//   lfoAmount   → lfoFrequency     `wow = clamp(lfoAmount,0,.5) * sin(phase)`
//                                  — a zero depth multiplies the whole sine
//                                  out, so the rate is unobservable.
//   duckAmount  → duckAttack,      `duckGain = 1 / (1 + clamp(duckAmount,0,10)
//                  duckRelease      * duckEnv)` — at 0 the gain is exactly 1
//                                  whatever the envelope's coefficients are.
//   tempoSync   → clockSource      `if (syncIdx > 0 && beatPeriodS > 0)` is the
//                                  ONLY reader of the bridged beat period, and
//                                  clockSource exists only to choose which
//                                  tempo that bridge resolves.
//   pan         → panMode          modes 0 and 2 rotate by an angle built from
//                                  `s.pan`; at 0 both are the identity, and
//                                  mode 2's rotation RATE is `π|pan|/sr`, so it
//                                  does not even turn.
//   stereoOffset→ panMode          mode 1 SWAPS fbL and fbR. A swap of two
//                                  equal things is the identity, so ping-pong
//                                  needs a genuine L/R difference — which on a
//                                  mono source only STEREO can create. It is
//                                  INDEPENDENT of pan.
//   driveGain   → driveMix,        `if (s.driveGain <= 0) return x` is an exact
//                  driveIterations  bypass; above it the saturator is
//                                  `tanh(y * (1 + driveGain))`, so at the
//                                  shipped 0.1 both shaping controls are
//                                  operating on a curve that is barely a curve.
//
// PURE — no DOM, no Svelte, no engine. Node-testable.

import { cofefveDelayDef } from '$lib/audio/modules/cofefve';
// The shipping DSP's own constants, imported via a RELATIVE path (not the
// `@patchtogether.live/dsp/src/...` alias) for the same reason cube.ts does:
// worktrees may not symlink the workspace package under node_modules, and the
// TS path-alias rules don't reliably resolve TS source out of
// node_modules/@patchtogether.live/dsp/src.
import {
  FEEDBACK_MAX,
  SYNC_BEATS,
} from '../../../../../dsp/src/lib/analog-delay-core';

/**
 * The threshold below which a dependent is called NEARLY inert rather than
 * inert. Only DRIVE uses it: every other enabler multiplies its dependents out
 * of the arithmetic exactly, so their pairs are bit-exact and need no
 * threshold at all. Expressed as a fraction of the enabler's own range so the
 * statement is "1 % of the control's travel", not a magic number.
 */
export const DRIVE_NEARLY_OFF_FRACTION = 0.02;

/** The DSP's own zero test — `DriveStage.step`'s `if (s.driveGain <= 0)`. */
export const DRIVE_BYPASS_AT = 0;

/** How far below the peak an echo has to fall to stop counting (−60 dB). */
export const ECHO_FLOOR = 1e-3;

/** Every param this model reads. A def-side rename throws rather than
 *  silently falling back to a default. */
export interface CofefveFaceParams {
  delayTime: number;
  tempoSync: number;
  feedback: number;
  stereoOffset: number;
  pan: number;
  panMode: number;
  lfoAmount: number;
  lfoFrequency: number;
  driftAmount: number;
  duckAmount: number;
  driveGain: number;
  dryVolume: number;
  wetVolume: number;
}

export const COFEFVE_FACE_PARAM_IDS = [
  'delayTime', 'tempoSync', 'feedback', 'stereoOffset', 'pan', 'panMode',
  'lfoAmount', 'lfoFrequency', 'driftAmount', 'duckAmount', 'driveGain',
  'dryVolume', 'wetVolume',
] as const satisfies readonly (keyof CofefveFaceParams)[];

/**
 * Live values in, resolving the DEF DEFAULT for anything the reader has no
 * answer for.
 *
 * ⚠ `node.params` is a SPARSE OVERLAY of what has been TOUCHED, not the
 * module's state — a freshly spawned delay has an empty map, so reading it bare
 * would compute every number from zeros and report a 1 ms echo beside a dial
 * reading 200 ms. A missing param id THROWS: that is a rename, and it must be
 * loud.
 */
export function cofefveFaceParams(
  read: (paramId: string) => number | undefined,
): CofefveFaceParams {
  const val = (id: string): number => {
    const v = read(id);
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    const pd = cofefveDelayDef.params.find((p) => p.id === id);
    if (!pd) throw new Error(`cofefve-face-model: cofefve has no param '${id}'`);
    return pd.defaultValue;
  };
  const out = {} as Record<string, number>;
  for (const id of COFEFVE_FACE_PARAM_IDS) out[id] = val(id);
  return out as unknown as CofefveFaceParams;
}

// ── THE ENABLER GRAPH ───────────────────────────────────────────────────────

/**
 * One enabler pair. `open` answers "is the enabler open?" from the live params
 * — it is a PREDICATE rather than a threshold field because the five pairs do
 * not share a shape: three test a single value against zero, DRIVE tests a
 * fraction of a range, and PAN MODE has TWO enablers with different
 * jurisdictions over different dependents.
 */
export interface EnablerPair {
  /** Stable key, for the sidebar and the tests. */
  id: 'wow' | 'duck' | 'sync' | 'pan' | 'drive';
  /** The param ids that do nothing while this pair is closed. */
  dependents: readonly string[];
  /** Is the pair open — i.e. are its dependents audible? */
  open: (p: CofefveFaceParams) => boolean;
  /** `true` when a closed pair silences its dependents BIT-EXACTLY (the
   *  enabler multiplies them out of the arithmetic), `false` when it merely
   *  reduces their authority to near nothing. Only DRIVE is the latter. */
  exact: boolean;
  /** The live line the sidebar prints. */
  text: (p: CofefveFaceParams) => string;
}

/**
 * THE FIVE PAIRS, in `face.order` rank order of their enablers.
 *
 * ⚠ PAN MODE IS ONE ENTRY WITH TWO ENABLERS, and collapsing it to one would
 * have shipped the error the spec made. Its three modes have different
 * prerequisites: STATIC and CIRCULAR rotate by an angle built from PAN, so PAN
 * governs them; PING-PONG swaps the two channels' feedback, which needs a
 * left/right DIFFERENCE and is independent of PAN entirely. The pair is
 * therefore open when EITHER holds, and its text names which of the two is
 * missing rather than printing one enabler and being wrong about the other.
 */
export const ENABLER_PAIRS: readonly EnablerPair[] = [
  {
    id: 'wow',
    dependents: ['lfoFrequency'],
    exact: true,
    open: (p) => p.lfoAmount > 0,
    text: (p) =>
      p.lfoAmount > 0
        ? `amt ${p.lfoAmount.toFixed(2)} · rate live`
        : `amt 0 · RATE inert`,
  },
  {
    id: 'duck',
    dependents: ['duckAttack', 'duckRelease'],
    exact: true,
    open: (p) => p.duckAmount > 0,
    text: (p) =>
      p.duckAmount > 0
        ? `amt ${p.duckAmount.toFixed(1)} · atk + rel live`
        : `amt 0 · ATK + REL inert`,
  },
  {
    id: 'sync',
    dependents: ['clockSource'],
    exact: true,
    open: (p) => Math.round(p.tempoSync) > 0,
    text: (p) =>
      Math.round(p.tempoSync) > 0
        ? `${syncLabel(p.tempoSync)} · clk src live`
        : `off · CLK SRC inert`,
  },
  {
    id: 'pan',
    dependents: ['panMode'],
    exact: true,
    open: (p) => p.pan !== 0 || p.stereoOffset !== 0,
    text: (p) => {
      const circ = p.pan !== 0;
      const ping = p.stereoOffset !== 0;
      if (circ && ping) return `pan ${p.pan.toFixed(2)} · stereo ${p.stereoOffset.toFixed(2)} · all 3 live`;
      if (circ) return `pan ${p.pan.toFixed(2)} · circular live, PING-PONG needs STEREO`;
      if (ping) return `stereo ${p.stereoOffset.toFixed(2)} · ping-pong live, CIRCULAR needs PAN`;
      // ⚠ THE CAVEAT IS IN THE CAPTION, because the model cannot see the
      // patch. PING-PONG needs a left/right DIFFERENCE, and a genuinely
      // stereo SOURCE supplies one without any param moving — which no
      // param reader can know. So the closed line says "on mono" rather
      // than claiming the mode is dead for everyone.
      return `pan 0, stereo 0 · MODE inert on mono`;
    },
  },
  {
    id: 'drive',
    dependents: ['driveMix', 'driveIterations'],
    exact: false,
    open: (p) => p.driveGain > driveNearlyOffAt(),
    text: (p) =>
      p.driveGain > driveNearlyOffAt()
        ? `gain ${p.driveGain.toFixed(1)} · mix + iters live`
        : p.driveGain <= DRIVE_BYPASS_AT
          ? `gain 0 · bypassed, MIX + ITERS inert`
          : `gain ${p.driveGain.toFixed(2)} · MIX + ITERS ~inert`,
  },
];

/** The DRIVE GAIN below which its two shaping controls are called near-inert —
 *  a fraction of the param's OWN declared range, read off the def. */
export function driveNearlyOffAt(): number {
  const pd = cofefveDelayDef.params.find((p) => p.id === 'driveGain');
  if (!pd) throw new Error('cofefve-face-model: no driveGain param');
  return (pd.max - pd.min) * DRIVE_NEARLY_OFF_FRACTION;
}

/** The dependent param ids that are currently doing nothing. */
export function asleepControls(p: CofefveFaceParams): string[] {
  const out: string[] = [];
  for (const pair of ENABLER_PAIRS) if (!pair.open(p)) out.push(...pair.dependents);
  return out;
}

/** `6 asleep` / `1 asleep` / `all live`. THE module's argument, in one caption. */
export function asleepText(p: CofefveFaceParams): string {
  const n = asleepControls(p).length;
  return n === 0 ? 'all live' : `${n} asleep`;
}

// ── THE EFFECTIVE ECHO GEOMETRY ─────────────────────────────────────────────

/** The `SYNC_BEATS` label roster, index-aligned — imported from the def rather
 *  than restated, and index 0 is the Off sentinel in both. */
function syncLabel(tempoSync: number): string {
  const i = Math.round(tempoSync);
  const pd = cofefveDelayDef.params.find((q) => q.id === 'tempoSync');
  return pd?.options?.find((o) => o.value === i)?.label ?? String(i);
}

/** Is SYNC engaged — i.e. is TIME bypassed? `processSample`'s `syncIdx > 0`. */
export function syncEngaged(p: CofefveFaceParams): boolean {
  const i = Math.round(p.tempoSync);
  return i > 0 && i < SYNC_BEATS.length;
}

/**
 * THE ECHO SPACING, as the caption prints it.
 *
 * ⚠ NOT a `delayTime` readback, and the difference is not cosmetic: while SYNC
 * is on the DSP REPLACES the base delay with `beatPeriodS × SYNC_BEATS[i]`, so
 * a dial reading `200 ms` is describing a delay the module is not using. The
 * beat period itself is bridged in from the host (TIMELORDE or MIDI clock) and
 * is not a param, so the honest synced answer is the DIVISION plus the fact
 * that TIME is bypassed — a number here would be a guess at the rack's tempo.
 */
export function echoSpacingText(p: CofefveFaceParams): string {
  if (syncEngaged(p)) return `${syncLabel(p.tempoSync)} · TIME bypassed`;
  return fmtSeconds(p.delayTime);
}

/** `1 ms` / `200 ms` / `1.50 s` — the def declares delayTime in SECONDS and the
 *  useful half of its range is milliseconds, so the unit is chosen per value
 *  and always printed. */
export function fmtSeconds(s: number): string {
  if (!Number.isFinite(s)) return '—';
  if (s < 1) return `${s < 0.01 ? (s * 1000).toFixed(1) : Math.round(s * 1000)} ms`;
  return `${s.toFixed(2)} s`;
}

/**
 * HOW MANY REPEATS SURVIVE — the number of trips round the loop before its
 * gain falls under −60 dB.
 *
 * `|feedback| × FEEDBACK_MAX` is the loop gain (`processSample`'s `fbGain`),
 * so the count is `log(1e-3) / log(gain)`. Two properties make this worth
 * deriving rather than printing the knob:
 *   • it is a function of the MAGNITUDE only, so ±0.5 must give the SAME
 *     answer — measured against the real worklet, the tails at −0.5 and +0.5
 *     are identical to the sample, while a `feedback` readback prints two
 *     different numbers;
 *   • it is a COUNT, so TIME must not move it — which is what separates it
 *     from the tail-in-seconds a reader might expect, and the reason the
 *     spacing readout sits beside it.
 *
 * An UPPER BOUND, and labelled as one: the in-loop tone filter takes further
 * energy on every pass, so the audible count is at most this. Measured with
 * the filter wide open the closed form lands within 4 % of the real −60 dB
 * tail; at the shipped cutoff the real tail is shorter.
 */
export function echoRepeats(p: CofefveFaceParams): number {
  const g = Math.min(0.999999, Math.abs(p.feedback) * FEEDBACK_MAX);
  if (!(g > 0)) return 0;
  return Math.log(ECHO_FLOOR) / Math.log(g);
}

/** `≤ 10` / `none` / `≤ 999+`. */
export function echoRepeatsText(p: CofefveFaceParams): string {
  const n = echoRepeats(p);
  if (!(n > 0)) return 'none';
  if (n >= 999) return '≤ 999+';
  return `≤ ${Math.round(n)}`;
}

/**
 * THE L/R SKEW in seconds — `processSample`'s `targetL = base·(1−skew)` vs
 * `targetR = base·(1+skew)`, so the two channels sit `2·|skew|·base` apart.
 * A `stereoOffset` readback is blind to TIME and a `delayTime` readback is
 * blind to the offset; the ear hears only this product.
 */
export function stereoSkewS(p: CofefveFaceParams): number {
  const skew = Math.min(0.5, Math.max(-0.5, p.stereoOffset));
  return 2 * Math.abs(skew) * baseDelayS(p);
}

/** The base delay the DSP clamps TIME to (`clamp(delayTime, 0.0005, 10)`).
 *  When SYNC is on the DSP uses the bridged beat period instead — which is not
 *  a param, so the picture keeps drawing TIME and the caption says so. */
export function baseDelayS(p: CofefveFaceParams): number {
  return Math.min(10, Math.max(0.0005, p.delayTime));
}

// ── THE HERO PICTURE ────────────────────────────────────────────────────────

/** One drawn echo. `t` seconds after the dry hit, `level` relative to it. */
export interface EchoHit {
  /** Repeat index — 0 is the dry hit itself. */
  n: number;
  /** Seconds after the dry hit, for the LEFT channel. */
  tL: number;
  /** …and the RIGHT, which differs only when STEREO is non-zero. */
  tR: number;
  /** Linear level relative to the dry hit (1 at n = 0). */
  level: number;
  /** `true` when the loop gain is negative, so this repeat is inverted. */
  inverted: boolean;
}

/**
 * THE ECHO TRAIN the hero draws: the dry hit plus every repeat above the floor
 * that fits inside `windowS`.
 *
 * The wet path's contribution is `wetVolume` and the dry hit's is `dryVolume`,
 * so the first repeat is NOT at the loop gain — it is at `gain·wet/dry`. That
 * detail is the difference between a picture of the FEEDBACK LOOP and a picture
 * of what comes OUT, and the caption promises the latter.
 */
export function echoTrain(p: CofefveFaceParams, windowS: number, maxHits = 64): EchoHit[] {
  const g = Math.min(0.999999, Math.abs(p.feedback) * FEEDBACK_MAX);
  const spacing = baseDelayS(p);
  const skew = Math.min(0.5, Math.max(-0.5, p.stereoOffset));
  const dry = Math.max(0, p.dryVolume);
  const wet = Math.max(0, p.wetVolume);
  // Normalise to the LOUDER of the two so the picture always has a full-height
  // reference; a train drawn relative to a dry level of 0 would be invisible on
  // a fully-wet patch, which is a legitimate and common setting here.
  const ref = Math.max(dry, wet * g, 1e-6);
  const out: EchoHit[] = [{ n: 0, tL: 0, tR: 0, level: dry / ref, inverted: false }];
  for (let n = 1; n <= maxHits; n++) {
    const level = (wet * Math.pow(g, n)) / ref;
    const tL = n * spacing * (1 - skew);
    const tR = n * spacing * (1 + skew);
    if (Math.min(tL, tR) > windowS) break;
    if (level < ECHO_FLOOR) break;
    out.push({ n, tL, tR, level, inverted: p.feedback < 0 && n % 2 === 1 });
  }
  return out;
}

/**
 * The WOW ripple's depth as a drawable fraction, and ZERO at the shipped
 * default — which is the point. The picture greys the ripple out entirely
 * rather than drawing a still train that looks like a working one.
 */
export function wowDepth(p: CofefveFaceParams): number {
  return Math.min(0.5, Math.max(0, p.lfoAmount));
}

/**
 * The hero plot's time WINDOWS, in seconds. Two, because the useful range of
 * TIME is 1 ms – 2 s and a train at feedback 0.9 outruns 2 s: the short window
 * resolves a slapback, the long one shows the whole tail.
 *
 * ⚠ NO TWO WINDOWS MAY RENDER THE SAME TICK ROW. The window button is the
 * panel's declared operability probe and its `effect` is the tick row's TEXT,
 * so a pair of windows that ticked identically would make the probe VACUOUS —
 * a dead button would pass. Asserted, over every pair, in the model test.
 */
export const ECHO_WINDOWS: readonly number[] = [2, 8];

/** The plot's x-axis ticks for a window: four evenly spaced marks from 0. */
export function windowTicks(windowS: number, count = 4): number[] {
  const out: number[] = [];
  for (let i = 0; i < Math.max(2, count); i++) out.push((windowS * i) / Math.max(2, count));
  return out;
}

// ── THE SIDEBAR LINES ───────────────────────────────────────────────────────

/** `id → the live sidebar line`, so the readout registry stays a one-liner and
 *  a new pair cannot be added to `ENABLER_PAIRS` without a line to print. */
export function enablerText(id: EnablerPair['id'], p: CofefveFaceParams): string {
  const pair = ENABLER_PAIRS.find((q) => q.id === id);
  if (!pair) throw new Error(`cofefve-face-model: no enabler pair '${id}'`);
  return pair.text(p);
}

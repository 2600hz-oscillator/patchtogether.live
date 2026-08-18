// packages/web/src/lib/ui/modules/mixmstrs-face-model.ts
//
// THE PURE MODEL BEHIND MIXMSTRS' FACEPLATE — the console's ranking axis, and
// the four hero readouts.
//
// ⚠ NOTHING HERE RE-TYPES A RANGE, A DEFAULT OR A POPULATION. Every list is
// built from `MIXMSTRS_CHANNELS` / `MIXMSTRS_RETURNS` (the def's own exported
// single-source-of-truth lists), every fallback value is resolved off
// `mixmstrsDef.params`, and the compressor's enable law is `mapCompMacro`
// IMPORTED from the def rather than restated — so a ninth channel, a re-ranged
// fader or a change to the macro's mapping moves this model with it instead of
// silently past it.
//
// ── THE RANKING AXIS: SCOPE ────────────────────────────────────────────────
//
// A mixer is N interchangeable channel strips, and #1701 named the trap: a rank
// over N identical controls has no priority to express. There, the resolution
// was to rank on an INTRINSIC axis (a filter bank's centre frequency, low→high).
// Here the intrinsic axis exists and it is SCOPE — how many of the mixer's ten
// stereo inputs a control's effect reaches, read straight off the DSP's summing
// expression (`mixmstrs.dsp:329-336`):
//
//   master_volume      × the SUM of eight channels and two returns   scope 10
//   send{R}Pre         re-taps all eight channels for one send bus   scope  8
//   ret{R}_volume      one return path                               scope  1 return
//   ret{R}_{lo,md,hi}  one band of one return path                   scope  1 return
//   ch{N}_*            one channel                                   scope  1 channel
//
// That axis is TOTAL over the eleven bus-scoped controls and exactly TIED over
// the eighty channel-scoped ones. **The tie is not a defect of the axis — it is
// the truth about a console**, and the face is arranged so the tie never has to
// be consulted: the eleven bus-scoped controls take ranks 1–11, which is longer
// than the largest lane tier (`FACE_TIER_CAPS.full`), so NO LANE TIER EVER
// PAINTS A CHANNEL-SCOPED CONTROL and no channel is ever privileged over
// another. `mixmstrs-face-model.test.ts` asserts exactly that, derived from the
// def on both sides.
//
// The alternative — `master_volume` then `ch1_volume … ch5_volume` — makes the
// six-cell plate look like a FIVE-CHANNEL MIXER. That is not a subset of an
// eight-channel mixer, it is a different and wrong instrument, and a player
// with only channel 6 patched would see a fader that does nothing to their
// signal. That is #1701's defect with faders instead of filter knobs.
//
// Within the bus-scoped block: `master_volume` (largest scope AND the largest
// measured mover), then the two return STRIPS whole, then the two PRE/POST
// switches last — because they are BIT-EXACTLY INERT until a send opens
// (measured 0.0000e+0 across both positions with every send at 0, against
// 3.2138e-1 with the sends at 0.5) and their enablers are channel-scoped, so
// "enabler outranks dependent" and the scope axis cannot both hold as a total
// order. The property that is kept is the operational half — NO LANE TIER MAY
// PAINT A CONTROL INERT AT THE SHIPPED DEFAULTS — since a lane tier is the only
// place `order` decides what a player meets as a subset.
//
// Within the channel block the order is FUNCTION-MAJOR, CHANNEL-MINOR: the
// eight instances of one control, in strip order, then the next control. The
// channel index therefore never discriminates between two DIFFERENT controls —
// it only orders the eight instances of the SAME one, where "left to right" is
// the console's own numbering and expresses nothing more.
//
// PURE — no DOM, no Svelte, no engine. Node-testable.

import {
  MIXMSTRS_CHANNELS,
  MIXMSTRS_RETURNS,
  mapCompMacro,
  mixmstrsChannelIndex,
  mixmstrsDef,
} from '$lib/audio/modules/mixmstrs';

/** The reader a `FaceReadoutValue` is handed: params only, `undefined` when the
 *  node has never written one (a fresh spawn). */
type Read = (paramId: string) => number | undefined;

// ── ID BUILDERS — derived, never typed ─────────────────────────────────────

/** The eight instances of one per-channel control, in strip order. */
export const perChannel = (suffix: string): string[] =>
  MIXMSTRS_CHANNELS.map((c) => `ch${c}_${suffix}`);

/** The eight COMP macros. `comp{N}`, not `ch{N}_comp` — the def's own naming. */
export const compMacroIds = (): string[] => MIXMSTRS_CHANNELS.map((c) => `comp${c}`);

/** One send-bus PRE/POST flag per bus. There is exactly one send bus per RETURN
 *  (the bus feeds the effect, the return brings the wet back), which is why the
 *  same index list drives both families. */
export const sendPreIds = (): string[] => MIXMSTRS_RETURNS.map((r) => `send${r}Pre`);

/** One return strip, in signal order: level, then its three EQ bands. */
export const returnStripIds = (r: number): string[] => [
  `ret${r}_volume`,
  `ret${r}_low`,
  `ret${r}_mid`,
  `ret${r}_high`,
];

/**
 * Does this param act on exactly ONE channel — i.e. is it a member of the
 * interchangeable set?
 *
 * ⚠ A PREDICATE OVER THE DEF'S OWN NAMING, NOT A COPY OF `face.order`. The
 * ranking lives in exactly one place (the def), and the gate reads it back
 * THROUGH this predicate: a second list here would be a second opinion that
 * agrees at authoring time and drifts the first time a channel control is
 * added. `mixmstrs-face-model.test.ts` anchors it both ways against the live
 * def — every param matches this or is one of the eleven bus-scoped ids, and
 * the two sets partition `mixmstrsDef.params` with nothing left over.
 *
 * ⚠ THE REGEX ITSELF MOVED TO THE DEF (#1825, `mixmstrsChannelIndex`), because
 * the face's per-column LANE COLOUR needs the same question answered with a
 * channel INDEX rather than a yes/no. Two regexes over one naming convention is
 * the drift this comment was already warning about; this predicate is now a
 * thin `!== null` over the one that lives beside the loop that builds the ids.
 */
export const isChannelScoped = (paramId: string): boolean =>
  mixmstrsChannelIndex(paramId) !== null;

// ── THE PARAM SNAPSHOT ─────────────────────────────────────────────────────

/** The def's declared default for an id — the fallback for a param a fresh node
 *  has never written. Resolved off the def, never re-typed. */
function declaredDefault(paramId: string): number {
  return mixmstrsDef.params?.find((p) => p.id === paramId)?.defaultValue ?? 0;
}

/** One finite reading, or the declared default. Guards the TOTALITY leg: the
 *  readout functions run on every render, so a NaN from a half-written node
 *  must not reach the arithmetic. */
function num(read: Read, paramId: string): number {
  const v = read(paramId);
  return typeof v === 'number' && Number.isFinite(v) ? v : declaredDefault(paramId);
}

export interface MixmstrsFaceParams {
  master: number;
  chVolume: number[];
  retVolume: number[];
  /** Per channel, the COMP macro (0 = bypass). */
  compMacro: number[];
  /** Per channel, the MANUAL compressor enable. */
  compEnable: number[];
  /** Per bus, then per channel: the send amount. */
  sendAmount: number[][];
  /** Per bus: the PRE/POST flag. */
  sendPre: number[];
}

export function mixmstrsFaceParams(read: Read): MixmstrsFaceParams {
  return {
    master: num(read, 'master_volume'),
    chVolume: perChannel('volume').map((id) => num(read, id)),
    retVolume: MIXMSTRS_RETURNS.map((r) => num(read, `ret${r}_volume`)),
    compMacro: compMacroIds().map((id) => num(read, id)),
    compEnable: perChannel('compEnable').map((id) => num(read, id)),
    sendAmount: MIXMSTRS_RETURNS.map((r) =>
      MIXMSTRS_CHANNELS.map((c) => num(read, `ch${c}_send${r}`)),
    ),
    sendPre: sendPreIds().map((id) => num(read, id)),
  };
}

// ── READOUT 1 · THE BUS — the number ninety-one faders cannot add up ───────
//
// masterL is `(Σ channel_out + ret1_out + ret2_out) × master_volume`
// (`mixmstrs.dsp:329`), so the fully-correlated worst-case gain for unit
// sources on all ten stereo inputs is
//
//     (Σ ch{N}_volume + Σ ret{R}_volume) × master_volume
//
// MEASURED against the shipped Faust wasm, ten correlated full-scale saws at
// the factory defaults: masterL peak **6.7187**, against the formula's
// (8×0.8 + 2×1.0) × 0.8 = 6.72. Mute both returns and it is **5.1190** against
// 8×0.8×0.8 = 5.12. The ladder by channel count, all defaults:
//
//     1 ch 0.6399 · 2 ch 1.2797 · 3 ch 1.9196 · 4 ch 2.5595 · 8 ch 5.1190
//
// **TWO correlated full-scale sources already clip the bus at the shipped
// defaults**, nothing in the module limits or soft-clips, and `master_volume`
// cannot exceed 1.0. Ninety-one faders and not one of them says that.
//
// ⚠ IT IS A BOUND, NOT A READING, and the caption says so with `≤`.
// Decorrelated sources sum in POWER, not amplitude; this is the correlated
// worst case, which is the number that matters because it is the one that
// clips.

/** The worst-case (fully correlated) linear gain from a unit source on every
 *  input to the master bus. */
export function busGainLinear(p: MixmstrsFaceParams): number {
  const sum = [...p.chVolume, ...p.retVolume].reduce((a, b) => a + b, 0);
  return sum * p.master;
}

export function busGainText(p: MixmstrsFaceParams): string {
  const g = busGainLinear(p);
  if (!Number.isFinite(g)) return '—';
  if (g <= 0) return '0× · −∞ dB';
  const db = 20 * Math.log10(g);
  return `≤ ${g.toFixed(2)}× · ${db >= 0 ? '+' : '−'}${Math.abs(db).toFixed(1)} dB`;
}

// ── READOUT 2 · ASLEEP — the module's own argument, counted ────────────────
//
// The per-channel compressor rests BYPASSED (`ch{N}_compEnable` default 0,
// `comp{N}` macro default 0), and while it is bypassed `ch{N}_thresh` and
// `ch{N}_ratio` do NOTHING. Measured on the shipped DSP with all twenty audio
// inputs driven: sweeping `ch1_thresh` across its ENTIRE declared travel
// (−36 → 0 dB) moves masterL by **0.0000e+0**, and `ch1_ratio` (1 → 10) by
// **0.0000e+0**. Open the enable and the same two sweeps move it by
// **1.8631e-1** and **1.1563e-1**.
//
// Bit-identity alone would not settle it, so the floor is measured from the
// other side: the smallest move ANY control on this module makes over the same
// harness is `ch1_volume` 0.800 → 0.801 = **2.9062e-4**. The inert plateau is
// not two values landing in one bucket — the module's finest audible step is
// 2.9e-4 and these do exactly 0.0 across their whole range.
//
// So **sixteen of ninety-one faders are decoration on a factory-fresh
// mixmstrs**, the module ships two independent ways to wake them, and no
// surface says either is required.

/** The two per-channel params the compressor's enable gates. NAMES, not a
 *  count — the readout multiplies by this list's length so the day a third
 *  dependent is added the number follows. Both measured inert above. */
export const COMP_DEPENDENT_SUFFIXES = ['thresh', 'ratio'] as const;

/**
 * Channel indices (0-based into `MIXMSTRS_CHANNELS`) whose compressor is
 * BYPASSED — nothing on the face claims it is on.
 *
 * ⚠ IT READS BOTH ENABLERS, and that is the whole point. `comp{N}` is a MACRO
 * that writes `compEnable` downstream through `mapCompMacro` (imported, not
 * restated), so a readout that watched only the manual switch would print
 * `16 asleep` while the macro had already woken the pair. The two legs are each
 * other's negative controls in `mixmstrs-face-model.test.ts`.
 */
export function bypassedChannels(p: MixmstrsFaceParams): number[] {
  const out: number[] = [];
  MIXMSTRS_CHANNELS.forEach((_, i) => {
    const byMacro = mapCompMacro(p.compMacro[i] ?? 0).enable >= 1;
    const byManual = (p.compEnable[i] ?? 0) >= 0.5;
    if (!byMacro && !byManual) out.push(i);
  });
  return out;
}

export function compAsleepText(p: MixmstrsFaceParams): string {
  const n = bypassedChannels(p).length * COMP_DEPENDENT_SUFFIXES.length;
  return n === 0 ? 'all live' : `${n} asleep`;
}

// ── READOUT 3/4 · THE SEND BUSES — the tap point, and whether it is alive ──
//
// `send{R}Pre` chooses where the bus taps each channel: POST-fader (the
// default) follows the volume fader; PRE-fader taps after EQ and compressor but
// BEFORE it, so a RETURN keeps carrying sound while the channel it sits on is
// muted. Measured, `ch1_send1 = 1`, send1L rms by fader position —
// POST: −∞ / −22.83 / −12.73 / −10.79 dB at vol 0 / 0.25 / 0.8 / 1.0;
// PRE: **−10.79 dB at every one of them**. That is the whole feature in one row.
//
// ⚠ AND IT IS INERT UNTIL A SEND OPENS. All sixteen send amounts default to 0,
// and with them shut, flipping `send1Pre` 0 → 1 moves send1L by **0.0000e+0**
// and masterL by **0.0000e+0**. Open every send to 0.5 and the same flip moves
// send1L by **3.2138e-1**. The switch is on the panel, it clicks, it changes
// nothing, and no surface says why — which matters because this is the control
// the owner's ES-9 send/return rack depends on
// (`e2e/tests/es9-per-leg-patching.spec.ts:11-14`).
//
// So the readout states the ENABLER, not the switch: a caption that merely
// echoed `PRE` would imply something happened.

export function sendText(busIndex: number, p: MixmstrsFaceParams): string {
  const amounts = p.sendAmount[busIndex] ?? [];
  const open = amounts.filter((a) => a > 0).length;
  const tap = (p.sendPre[busIndex] ?? 0) >= 0.5 ? 'PRE' : 'POST';
  return open === 0 ? `${tap} · off` : `${tap} · ${open} ch`;
}

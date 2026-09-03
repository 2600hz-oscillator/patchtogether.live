// packages/web/src/lib/audio/modules/mixmstrs.ts
//
// MIXMSTRS — 8-channel stereo mixer with EQ, compressor, two stereo aux sends,
// two stereo returns. Multiple instances are allowed (submixes / parallel
// master buses); each instance sums its inputs to the destination additively.
//
// 20 audio inputs (8 ch × stereo + 2 returns × stereo) + 14 worklet audio
// outputs: 6 patchable module ports (master L/R + send1 L/R + send2 L/R) plus
// 8 internal POST-FADER per-channel level taps (NOT module ports) feeding the
// VU read('levels'). The AudioParams are whatever `buildParams()` emits — a
// per-channel strip plus the master, the two send-bus flags and the two return
// strips. (The count that used to be written here said 81 and the truth was 91:
// the return strips and the pre/post flags were added and the sentence was not.
// Per CLAUDE.md a population count is never the right shape — read buildParams.)
//
// Per-channel `comp` macro (added in feat/audio-fidelity-mixmstrs-comp-swolevco):
//
//   The DSP carries a per-channel compressor with three controls (thresh,
//   ratio, compEnable). Tuning all three simultaneously is fiddly. The new
//   `comp{N}` knob (one per channel, 0..1) collapses those into a single
//   "amount" macro:
//
//     * comp = 0       → compEnable=0 (full bypass; identity passthrough)
//     * comp ∈ (0, 1]  → compEnable=1 AND thresh interpolates from 0 dB
//                        (no compression) at comp=ε to -20 dB at comp=1, AND
//                        ratio interpolates from 1.0 (no compression) at
//                        comp=ε to 4.0 at comp=1.
//
//   At comp=1 the channel sees a moderate compression curve (-20dB threshold,
//   4:1 ratio, the existing 5ms attack / 100ms release baked into the Faust
//   DSP) — enough to "isolate" the channel against louder sources in the
//   mix without obvious pumping.
//
//   The original `chN_thresh` / `chN_ratio` / `chN_compEnable` params remain
//   exposed (cv inputs + UI knobs) for power users who want manual control.
//   The `comp` macro just writes ALL three downstream params; if a user
//   patches CV into both `comp1` and `ch1_thresh` simultaneously, the comp
//   macro wins (it overwrites on every setParam call).
//
// Inputs:
//   ch{1..8}L / ch{1..8}R (audio): eight stereo channel inputs (8 × stereo = 16 ports).
//   ret1L / ret1R / ret2L / ret2R (audio): two stereo aux returns.
//   ch{N}_{volume,low,mid,high,thresh,ratio,compEnable,send1,send2} (cv, linear or discrete,
//     paramTarget=…): per-channel CV inputs for every param. Linear unless the param is discrete.
//   comp{1..8} (cv, linear, paramTarget=…): per-channel compressor macro CV.
//   master_volume (cv, linear, paramTarget=master_volume): displaces the master volume.
//
// Outputs:
//   masterL / masterR (audio): main stereo mix bus.
//   send1L / send1R (audio): stereo aux-send 1 output.
//   send2L / send2R (audio): stereo aux-send 2 output.
//
// Params (built programmatically — see buildParams() below):
//   master_volume (linear 0..1, default 0.8): bus output gain.
//   per-channel × 8: volume / low / mid / high (linear ±12 dB) /
//     thresh (-36..0 dB) / ratio (1..10) / compEnable (discrete) /
//     comp (linear 0..1 macro) / send1 / send2 (linear 0..1).

import { instantiateFaustModule } from '$lib/audio/faust-runtime';
import { markJsConsumedParam } from '$lib/audio/cv-shadow';
// The ONE definition of what MON means. Neither end of the normal owns it: a
// contract owned by one end is a contract the other end can drift from.
import { clipLaneLiveGain, coerceClipLaneMon } from '$lib/audio/clip-lane-return';
import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import type { ParamDef, PortDef } from '$lib/graph/types';
import wasmUrl from '@patchtogether.live/dsp/dist/mixmstrs.wasm?url';
import metaUrl from '@patchtogether.live/dsp/dist/mixmstrs.json?url';
import workletUrl from '@patchtogether.live/dsp/dist/mixmstrs.worklet.js?url';

const PARAM_PREFIX = '/MIXMSTRS';

// Channel count — single source of truth for the 8-channel layout. The Faust
// process() declares channels in this order, then the two stereo returns.
export const MIXMSTRS_CHANNELS = [1, 2, 3, 4, 5, 6, 7, 8] as const;
/** The two stereo AUX RETURNS, each now a real strip (volume + 3-band EQ)
 *  rather than a bare unity-gain summing input. Derived list so the params,
 *  the docs and the card can never drift apart. */
export const MIXMSTRS_RETURNS = [1, 2] as const;
const NUM_CHANNELS = MIXMSTRS_CHANNELS.length;

/** De-zipper time constant for the MON duck. A `setTargetAtTime` glide, never a
 *  `.value =` write: a hard step on the live branch is a discontinuity, i.e. a
 *  click, on every launch. Short enough to read as "the clip took over", long
 *  enough not to snap. */
const DUCK_GLIDE_S = 0.005;

/** Per-channel CLIP-RECORD arm ids (`ch{N}_rec`), derived from the channel list. */
export const MIXMSTRS_REC_ARM_IDS: readonly string[] = MIXMSTRS_CHANNELS.map((ch) => `ch${ch}_rec`);
/** Per-channel MON ids (`ch{N}_mon`), derived from the channel list. */
export const MIXMSTRS_MON_IDS: readonly string[] = MIXMSTRS_CHANNELS.map((ch) => `ch${ch}_mon`);
/** The bus-scoped clip-record controls. */
export const MIXMSTRS_REC_BUS_IDS: readonly string[] = ['recTap', 'recQuality'];

// ---------------- Comp macro mapping ----------------
//
// Pure helper extracted so the unit test can verify the boundary behavior
// without spinning up Web Audio.
//
// Returns the (compEnable, thresh, ratio) that the macro writes for a
// given comp ∈ [0, 1].
//
//   comp = 0      → { enable: 0, thresh: 0,    ratio: 1 } (bypass)
//   comp = 0.001  → { enable: 1, thresh: ≈0,   ratio: ≈1 } (just barely on)
//   comp = 1      → { enable: 1, thresh: -20,  ratio: 4 }
//
// thresh + ratio interpolate linearly with comp ∈ (0, 1].
export function mapCompMacro(comp: number): {
  enable: 0 | 1;
  thresh: number;
  ratio: number;
} {
  const c = Math.max(0, Math.min(1, comp));
  if (c === 0) return { enable: 0, thresh: 0, ratio: 1 };
  // Lerp thresh: 0 dB → -20 dB; ratio: 1 → 4.
  return {
    enable: 1,
    thresh: 0 + (-20 - 0) * c,
    ratio: 1 + (4 - 1) * c,
  };
}

// ---------------- Post-fader meter helper ----------------
//
// Pure RMS over a time-domain sample window — the same math scope.ts /
// engine RMS use. Extracted so the unit test can assert level ordering/scale
// deterministically (feed known buffers, read the levels) without spinning up
// Web Audio. `read('levels')` runs this over each channel's post-fader tap
// analyser buffer (see the factory below).
export function rmsLevel(buf: Float32Array): number {
  if (buf.length === 0) return 0;
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i]! * buf[i]!;
  return Math.sqrt(s / buf.length);
}

// Build the 81-param schema programmatically — 9 controls + 1 comp macro per
// channel × 8 channels + 1 master.
function buildParams(): readonly ParamDef[] {
  const params: ParamDef[] = [];
  for (const ch of MIXMSTRS_CHANNELS) {
    params.push({ id: `ch${ch}_volume`,      label: `${ch}V`,   defaultValue: 0.8, min: 0,    max: 1,   curve: 'linear' });
    params.push({ id: `ch${ch}_low`,         label: `${ch}Lo`,  defaultValue: 0,   min: -12,  max: 12,  curve: 'linear', units: 'dB' });
    params.push({ id: `ch${ch}_mid`,         label: `${ch}Md`,  defaultValue: 0,   min: -12,  max: 12,  curve: 'linear', units: 'dB' });
    params.push({ id: `ch${ch}_high`,        label: `${ch}Hi`,  defaultValue: 0,   min: -12,  max: 12,  curve: 'linear', units: 'dB' });
    params.push({ id: `ch${ch}_thresh`,      label: `${ch}Th`,  defaultValue: -12, min: -36,  max: 0,   curve: 'linear', units: 'dB' });
    params.push({ id: `ch${ch}_ratio`,       label: `${ch}Rt`,  defaultValue: 2,   min: 1,    max: 10,  curve: 'linear' });
    params.push({ id: `ch${ch}_compEnable`,  label: `${ch}Cp`,  defaultValue: 0,   min: 0,    max: 1,   curve: 'discrete' });
    // Per-channel comp macro (added in audio-fidelity PR). Default 0 = bypass —
    // every existing patch keeps its previous compressor behavior unchanged.
    params.push({ id: `comp${ch}`,           label: `${ch}Cm`,  defaultValue: 0,   min: 0,    max: 1,   curve: 'linear' });
    params.push({ id: `ch${ch}_send1`,       label: `${ch}S1`,  defaultValue: 0,   min: 0,    max: 1,   curve: 'linear' });
    params.push({ id: `ch${ch}_send2`,       label: `${ch}S2`,  defaultValue: 0,   min: 0,    max: 1,   curve: 'linear' });
    // ── CLIP RECORDING, per channel ───────────────────────────────────────
    //
    // ⚠ THE `ch{N}_` PREFIX IS LOAD-BEARING, NOT A STYLE CHOICE.
    // `mixmstrsChannelIndex` claims a param for channel N by that naming rule,
    // and three derived things then read it with ZERO edits here: the lane
    // colour (`channelAccent`), `bareCells`, and the face model's
    // `isChannelScoped`. A param named `rec{N}` would be silently
    // mis-classified as BUS-scoped and would take lane ranks it must not have.
    params.push({
      id: `ch${ch}_rec`, label: `${ch}Rc`, defaultValue: 0, min: 0, max: 2, curve: 'discrete',
      options: [
        { value: 0, label: 'off', title: 'Not armed for clip recording' },
        { value: 1, label: 'once', title: 'Arm SINGLE — record exactly one loop into the launcher, then stop' },
        { value: 2, label: 'inf', title: 'Arm ENDLESS — record until STOP, which lands at the END of the current loop' },
      ],
    });
    // MONITORING of this channel's NORMALLED launcher return (the one contract
    // lives in `$lib/audio/clip-lane-return`). Default `clip-auto` is the
    // owner's pick: record a loop and hear it take over, no cable moves and no
    // second gesture.
    params.push({
      id: `ch${ch}_mon`, label: `${ch}Mn`, defaultValue: 2, min: 0, max: 2, curve: 'discrete',
      options: [
        { value: 0, label: 'live', title: 'Ignore the launcher return — this channel is its patched input, full stop' },
        { value: 1, label: 'both', title: 'Sum the patched input AND lane N of the clip launcher (play along with your loop)' },
        { value: 2, label: 'auto', title: 'CLIP-AUTO (default) — mute the live input while lane N of the launcher is playing' },
      ],
    });
  }
  params.push({ id: 'master_volume', label: 'Master', defaultValue: 0.8, min: 0, max: 1, curve: 'linear' });
  // ── CLIP RECORDING, bus-scoped ──────────────────────────────────────────
  //
  // ⚠ THESE TWO MUST **NOT** MATCH `/^ch(\d+)_/`. They are bus-scoped by
  // construction, and the SCOPE partition the face model asserts in both
  // directions depends on the naming staying that way.
  //
  // ⚠ `recTap` NAMES A STATE THIS BUILD CANNOT HONOUR, AND THAT IS FLAGGED.
  // The owner kept the roster as designed, so all three tap points are named.
  // Only BOARD IN is wired: POST FADER needs the `.dsp`'s own noted future
  // change (8 STEREO taps replacing the 8 mono ones — the existing taps are
  // measurably phase-blind and cannot serve), and MASTER, while cheap, is not
  // wired in v1 either. Nothing consumes this param yet — the recorder lands in
  // a later slice — so nothing is broken TODAY, but the slice that wires the
  // recorder owns REFUSING a tap it cannot deliver rather than silently
  // substituting BOARD IN. Stated here so that obligation cannot be lost.
  params.push({
    id: 'recTap', label: 'Tap', defaultValue: 0, min: 0, max: 2, curve: 'discrete',
    options: [
      { value: 0, label: 'board', title: 'BOARD IN — the RAW patched channel input, before EQ, comp and fader (the only wired tap)' },
      { value: 1, label: 'post',  title: 'POST FADER — needs the DSP stereo meter taps; not available in this build' },
      { value: 2, label: 'mast',  title: 'MASTER — record the whole mix bus; not wired in this build' },
    ],
  });
  // The quality ladder. `studio` is the default and is NOT overkill: the tap is
  // PRE-BOARD, where a hot module can already exceed +/-1.0 before the board
  // sees it (this module's own fully-correlated worst case is 6.7187x at the
  // shipped defaults), so i16 would clip it permanently and silently. f32 also
  // costs NO conversion at all — the samples are already f32, so it is the
  // cheapest tier by CPU, which is the resource that matters when eight lanes
  // record at once.
  params.push({
    id: 'recQuality', label: 'Qual', defaultValue: 0, min: 0, max: 2, curve: 'discrete',
    options: [
      { value: 0, label: 'stud', title: 'STUDIO (default) — PCM f32 at the context rate; cannot clip a hot pre-board tap' },
      { value: 1, label: 'std',  title: 'STANDARD — PCM i16, half the bytes; clips at +/-1.0' },
      { value: 2, label: 'comp', title: 'COMPACT — Opus 128 kb/s; a Worker encoder per lane' },
    ],
  });
  // PRE/POST-FADER select per SEND BUS. 0 = POST (the default — every existing
  // patch keeps its current behaviour exactly), 1 = PRE. ONE flag per bus, so
  // send 1 and send 2 can sit in DIFFERENT modes at the same time. The ids match
  // the Faust hslider labels (`send1Pre`/`send2Pre`) — that name equality IS the
  // wiring (`params.get(`${PARAM_PREFIX}/${def.id}`)`), so renaming one without
  // the other silently disconnects the switch.
  params.push({ id: 'send1Pre', label: 'S1Pre', defaultValue: 0, min: 0, max: 1, curve: 'discrete' });
  params.push({ id: 'send2Pre', label: 'S2Pre', defaultValue: 0, min: 0, max: 1, curve: 'discrete' });
  // RETURN strips. The returns used to sum into the master at fixed unity with
  // no control at all, which made pre-fader sends only half a feature — you
  // could feed a muted channel to an effect but had no way to set how loud the
  // wet came back. VOLUME DEFAULTS TO 1.0, NOT the channels' 0.8: unity is what
  // the returns did before, and 0.8 would silently drop the return level in
  // every patch that already exists. No send controls on a return (return →
  // its own send is a feedback loop).
  for (const r of MIXMSTRS_RETURNS) {
    params.push({ id: `ret${r}_volume`, label: `R${r}V`,  defaultValue: 1, min: 0,   max: 1,  curve: 'linear' });
    params.push({ id: `ret${r}_low`,    label: `R${r}Lo`, defaultValue: 0, min: -12, max: 12, curve: 'linear', units: 'dB' });
    params.push({ id: `ret${r}_mid`,    label: `R${r}Md`, defaultValue: 0, min: -12, max: 12, curve: 'linear', units: 'dB' });
    params.push({ id: `ret${r}_high`,   label: `R${r}Hi`, defaultValue: 0, min: -12, max: 12, curve: 'linear', units: 'dB' });
  }
  return params;
}

const PARAMS = buildParams();

/**
 * The CHANNEL a param belongs to, as a 0-based index into `MIXMSTRS_CHANNELS`,
 * or `null` for a BUS-scoped param (`master_volume`, `send{R}Pre`, the return
 * strips).
 *
 * ⚠ ONE STATEMENT OF THE NAMING CONVENTION, and it lives beside the loop that
 * creates the names. Two things read it and neither may re-type it: the face
 * model's `isChannelScoped` (the SCOPE ranking axis) and `face.channelAccent`
 * (#1825's per-column lane colour). A second regex somewhere else would agree
 * on the day it was written and drift the first time a channel control is
 * added — the failure this repo has paid for repeatedly.
 *
 * ⚠ IT MATCHES ON THE INDEX, NOT ON A SUFFIX LIST. `ch{N}_anything` and
 * `comp{N}` are the two shapes `buildParams` emits, so a NEW per-channel
 * control is claimed automatically and gets its colour with no edit here.
 */
export function mixmstrsChannelIndex(paramId: string): number | null {
  const m = /^ch(\d+)_/.exec(paramId) ?? /^comp(\d+)$/.exec(paramId);
  if (!m) return null;
  const i = (MIXMSTRS_CHANNELS as readonly number[]).indexOf(Number(m[1]));
  return i >= 0 ? i : null;
}

/**
 * The params whose per-cell CAPTION survives on the faceplate — the exceptions
 * `face.bareCells` is derived against (see the note there).
 *
 * A NAMED exemption per instance rather than a positive list of the eighty-odd
 * bare ones: the rule is "a caption is redundant when a cluster heading and a
 * column already name the control", and these two are exactly the cells that
 * sit outside that arrangement. Anchored — `mixmstrs-face-model.test.ts`
 * asserts every id here is a real param, so a rename cannot leave a dead
 * exemption silently captioning nothing.
 */
const CAPTIONED_PARAM_IDS: ReadonlySet<string> = new Set<string>([
  ...MIXMSTRS_RETURNS.map((r) => `send${r}Pre`),
  // ⚠ EVERY PARAM WITH AN `options` ROSTER KEEPS ITS CAPTION, and this is a
  // RULE rather than a list of eighteen ids. A rostered param's readout is its
  // only STATE NAME — the cell paints `off` / `once` / `inf`, and with the
  // caption suppressed nothing on the plate says WHICH channel's arm that is.
  // `module-face-lint` enforces exactly this ("face.bareCells never silences a
  // param whose readout is its only STATE NAME"), and deriving membership from
  // `options` means the next rostered control is captioned automatically
  // instead of reddening a gate.
  ...MIXMSTRS_REC_ARM_IDS,
  ...MIXMSTRS_MON_IDS,
  ...MIXMSTRS_REC_BUS_IDS,
]);

// Audio input port ids in the exact order the Faust process() declares them:
// 16 channel ports (ch1L..ch8R) then the 4 return ports.
const AUDIO_IN_PORTS: readonly string[] = [
  ...MIXMSTRS_CHANNELS.flatMap((ch) => [`ch${ch}L`, `ch${ch}R`]),
  'ret1L', 'ret1R', 'ret2L', 'ret2R',
];

// Comp-macro ids, derived from the channel list so they never drift apart.
const COMP_MACRO_IDS: readonly string[] = MIXMSTRS_CHANNELS.map((ch) => `comp${ch}`);

/**
 * Params with NO backing Faust hslider, whose value a JS consumer reads.
 *
 * ⚠ MEMBERSHIP IS DERIVED, NEVER HAND-TYPED. Each is published on a shadow
 * `GainNode` fed by DC 1, so the shadow's OUTPUT is the EFFECTIVE (knob + CV)
 * value and a passive analyser can observe it — the comp-macro rig, reused
 * rather than re-invented. `markJsConsumedParam` then declares the consumer at
 * the construction site so `art/scenarios/cv-terminal` reads the declaration
 * instead of guessing that an unreachable param is a dead terminal.
 */
const JS_CONSUMED_PARAM_IDS: readonly string[] = [
  ...MIXMSTRS_REC_ARM_IDS,
  ...MIXMSTRS_MON_IDS,
  ...MIXMSTRS_REC_BUS_IDS,
];

// Inputs: the 20 audio ports above, plus one paramTarget CV input per param.
//
// Every CV input gets a `cvScale: linear` hint per
// docs/adr/004-cv-range-convention.md so an LFO at ±1 sweeps the param's
// full natural range centered on the user's knob position. All MIXMSTRS
// params have linear knob curves (volume, dB EQ bands, dB threshold,
// ratio, send amounts); none use log scaling natively, so linear here is
// the right match.
function buildInputs(): PortDef[] {
  const inputs: PortDef[] = AUDIO_IN_PORTS.map((id) => ({ id, type: 'audio' as const }));
  for (const p of PARAMS) {
    inputs.push({
      id: p.id,
      type: 'cv',
      paramTarget: p.id,
      cvScale: { mode: p.curve === 'discrete' ? 'discrete' : 'linear' },
    });
  }
  return inputs;
}

export const mixmstrsDef: AudioModuleDef = {
  type: 'mixmstrs',
  palette: { top: 'Audio modules', sub: 'Mixing' },
  domain: 'audio',
  label: 'mixmstrs',
  category: 'utilities',
  stereoPairs: [
    ...MIXMSTRS_CHANNELS.map((ch) => [`ch${ch}L`, `ch${ch}R`] as [string, string]),
    ['ret1L', 'ret1R'],
    ['ret2L', 'ret2R'],
  ],

  inputs: buildInputs(),
  outputs: [
    { id: 'masterL', type: 'audio' },
    { id: 'masterR', type: 'audio' },
    { id: 'send1L',  type: 'audio' },
    { id: 'send1R',  type: 'audio' },
    { id: 'send2L',  type: 'audio' },
    { id: 'send2R',  type: 'audio' },
  ],
  params: PARAMS,

  // ── THE FACEPLATE ─────────────────────────────────────────────────────────
  //
  // The largest face in the repo, and the design problem is stated by the
  // module itself: a mixer is N INTERCHANGEABLE CHANNEL STRIPS. The eight
  // channels are bit-identical in every declared property — same ids modulo the
  // index, same ranges, same curves, same defaults — so a rank over them has no
  // priority to express (#1701, the two Moog filter banks).
  //
  // THE AXIS IS SCOPE: how many of the ten stereo inputs a control's effect
  // reaches, read off the summing expression at `mixmstrs.dsp:329-336`. It is
  // TOTAL over the thirteen bus-scoped controls and exactly TIED over the ninety-six
  // channel-scoped ones, and the face is built so the tie is never consulted —
  // ranks 1-13 are the whole bus-scoped block, which is longer than the largest
  // lane tier, so no lane tier ever paints a channel control and no channel is
  // ever privileged over another. The argument and the measurements are in
  // `$lib/ui/modules/mixmstrs-face-model.ts`; the invariant is asserted from
  // the live def, both directions, in `mixmstrs-face-model.test.ts`.
  //
  // ⚠ WHY THERE IS NO PANEL, stated because the sibling case went the other way.
  // `warrensspectrum` earned a PF-14 bank panel because its bank lives in
  // `node.data` and the card was its ONLY editor. Here the STOP-2 grep comes
  // back clean: every affordance on `MixmstrsCard.svelte` is a `ParamDef` (the
  // two `.prepost` buttons write `send{R}Pre`; the ◆ toggle is card-local view
  // state), so promotion removes no way of getting data in. And a panel could
  // not carry the fader bank even if it wanted to — faces-parity asserts EXACT
  // multiset equality between the dock's `control-<paramId>` testids and the
  // def's params, and a panel may never emit one (`shell-cells.ts` rule 1). The
  // only panel available here would be a read-only console PICTURE, whose
  // natural content is the per-channel VU — and that tap is MEASURABLY BLIND:
  // `ch{N}Level` is `(L+R)/2` (`mixmstrs.dsp:349-356`), so an anti-phase channel
  // reads rms 0.0000e+0 while masterL and masterR each carry 0.184216, byte-
  // identical to the in-phase render. Painting bars off it is the ninelives /
  // buggles glyph hazard (#1692, #1706) with a live tap instead of a dead one.
  face: {
    // 1-13 · BUS-SCOPED. Master first (scope 10, and the largest measured mover
    // on the module), then the two return STRIPS whole — level, then the
    // low→mid→high frequency axis #1701 ranked its filter banks with. Ordering
    // the returns strip-major rather than function-major is what makes the
    // six-cell plate coherent: `Master · R1V · R1Lo · R1Md · R1Hi · R2V`, a
    // master fader plus one COMPLETE return strip, rather than a scatter of
    // single bands across two returns.
    //
    // ⚠ THE TWO PRE/POST SWITCHES RANK LAST IN THIS BLOCK, at 10-11, and that
    // is a measurement rather than taste. Both are BIT-EXACTLY INERT until a
    // send opens (0.0000e+0 on send1L and masterL across both positions with
    // every send at 0, against 3.2138e-1 with the sends at 0.5), and their
    // enablers — the sixteen per-channel send amounts — are channel-scoped, so
    // the enabler-above-dependent rule and the scope axis cannot BOTH be
    // satisfied by a total order. The rule that actually protects a player is
    // the operational half of it: no LANE TIER may paint a control that is
    // inert at the shipped defaults, because a lane tier is the only place
    // `order` decides what a player meets as a subset. Ranks 10-11 are below
    // every lane budget, so the switches are dock-only, and the two `send N`
    // hero readouts state the enabler on the same face. Asserted, with the
    // inert set derived, in mixmstrs-face-model.test.ts.
    //
    // 14+ · CHANNEL-SCOPED, FUNCTION-MAJOR / CHANNEL-MINOR — the eight
    // instances of one control, in strip order, then the next control. The
    // channel index therefore never separates two DIFFERENT controls; it only
    // orders the eight instances of the SAME one. Within this block the
    // enabler rule holds outright: the COMP macro and the manual enable both
    // outrank the thresh/ratio pair they gate.
    order: [
      'master_volume',
      ...MIXMSTRS_RETURNS.flatMap((r) => [
        `ret${r}_volume`, `ret${r}_low`, `ret${r}_mid`, `ret${r}_high`,
      ]),
      ...MIXMSTRS_RETURNS.map((r) => `send${r}Pre`),
      // 12-13 · The bus-scoped CLIP-RECORD controls, ranked BELOW the pre/post
      // switches for the same measured reason those two rank last: both are
      // INERT AT THE SHIPPED DEFAULTS. Nothing consumes `recTap` or
      // `recQuality` until the recorder lands, so a lane tier that painted
      // either would be offering a player a control that does nothing — the
      // operational half of the enabler rule, and the one that actually
      // protects someone. Ranks 12-13 are below every lane budget, so both are
      // dock-only. The bus-scoped block grows 11 -> 13 and therefore stays
      // LONGER than the largest lane tier, which is the invariant that keeps a
      // lane tier from ever painting a channel control.
      ...MIXMSTRS_REC_BUS_IDS,
      ...MIXMSTRS_CHANNELS.map((c) => `ch${c}_volume`),
      ...MIXMSTRS_CHANNELS.map((c) => `comp${c}`),
      ...MIXMSTRS_CHANNELS.map((c) => `ch${c}_send1`),
      ...MIXMSTRS_CHANNELS.map((c) => `ch${c}_send2`),
      ...MIXMSTRS_CHANNELS.map((c) => `ch${c}_low`),
      ...MIXMSTRS_CHANNELS.map((c) => `ch${c}_mid`),
      ...MIXMSTRS_CHANNELS.map((c) => `ch${c}_high`),
      ...MIXMSTRS_CHANNELS.map((c) => `ch${c}_compEnable`),
      ...MIXMSTRS_CHANNELS.map((c) => `ch${c}_thresh`),
      ...MIXMSTRS_CHANNELS.map((c) => `ch${c}_ratio`),
      // LAST · the per-channel CLIP-RECORD arm and its MONITOR mode. Inert at
      // the shipped defaults like their bus-scoped siblings (`off`, and a
      // `clip-auto` duck that cannot engage until a lane plays), so they take
      // the lowest ranks on the module and no lane tier can reach them.
      ...MIXMSTRS_REC_ARM_IDS,
      ...MIXMSTRS_MON_IDS,
    ],

    // FIVE bands, under a ceiling this module cannot be allowed to
    // cross. At `DOCK_TAB_MIN_BANDS = 7` the dock becomes a TAB RAIL and
    // renders exactly one band at a time — which on a mixer destroys the single
    // thing the surface exists for, letting you balance eight faders against
    // each other. So membership is grouped BY FUNCTION, never by channel (eight
    // channel bands plus returns plus master would be eleven), and the
    // eight-channel structure is carried by `clusters` — a ~14 px sub-header
    // instead of a ~81 px band (`graph/types.ts:502-507`: a PAGE is a different
    // IDEA, a CLUSTER is the same idea twice; eight channels' LOW is the same
    // idea eight times).
    //
    // Every cluster holds exactly `MIXMSTRS_CHANNELS.length` cells in strip
    // order, so column N of every cluster is channel N and the page reads as a
    // CONSOLE GRID — rows are functions, columns are channels. That alignment is
    // the whole layout, and it is why the EQ is three clusters of eight rather
    // than one flat band of twenty-four (`.page-controls` is flex-wrap; a
    // 24-cell row wraps mid-bank and the columns stop lining up).
    //
    // ⚠ THE FADER HEADS ITS OWN CHANNEL'S COLUMN — owner review of #1738:
    // *"the faders need to be above the 8 channels."* The first draft put the
    // eight faders in a `levels` band of their own ABOVE a separate `eq` band,
    // which is "above" in reading order but not in COLUMN order: two bands are
    // two independently-laid-out rows, so fader N did not sit over EQ N and the
    // narrower band did not line up with the grid under it. Merging them makes
    // one band whose four clusters are `level / low / mid / high`, so column N
    // is channel N all the way down and a column reads as an actual CHANNEL
    // STRIP — fader, then its three tone controls.
    //
    // That is a CLUSTER merge, not a page merge in disguise: the type's own rule
    // is "reach for a PAGE when the controls are a different IDEA; a CLUSTER
    // when they are the same idea twice", and a channel's level and its tone are
    // one idea — the strip — eight times over.
    //
    // ⚠ AND IT COSTS THE RANKING NOTHING. `order` is the PRIORITY ranking (it
    // decides which controls a LANE TIER paints as a subset); `pages` is the
    // DOCK's arrangement, which renders everything. They are separate fields the
    // skill explicitly invites to disagree, and every assertion behind the SCOPE
    // axis reads `order` / `laneOrder` — never `pages`. So the thirteen bus-scoped
    // controls still take every lane rank and no channel is privileged, with
    // this layout or the previous one.
    //
    // ⚠ `pages` STILL DISAGREES WITH SIGNAL ORDER IN EXACTLY ONE PLACE. A
    // channel runs EQ → comp → fader → send tap, so signal order would put the
    // fader after the EQ inside this band. It leads instead, because the dock
    // capture and the 720p fold both see roughly the top 425 px and on a console
    // the faders are what must be there. Every other band is in the DSP's order.
    pages: [
      { id: 'channels', label: 'channels',
        controls: [
          'master_volume',
          ...MIXMSTRS_CHANNELS.map((c) => `ch${c}_volume`),
          ...MIXMSTRS_CHANNELS.map((c) => `ch${c}_low`),
          ...MIXMSTRS_CHANNELS.map((c) => `ch${c}_mid`),
          ...MIXMSTRS_CHANNELS.map((c) => `ch${c}_high`),
        ],
        // `master_volume` is claimed by the band (which is what lets the hero
        // MOVE it) but belongs to no cluster — it is not one of the eight, and
        // the hero removes it before this band renders.
        clusters: [
          { label: 'level', controls: MIXMSTRS_CHANNELS.map((c) => `ch${c}_volume`) },
          { label: 'low', controls: MIXMSTRS_CHANNELS.map((c) => `ch${c}_low`) },
          { label: 'mid', controls: MIXMSTRS_CHANNELS.map((c) => `ch${c}_mid`) },
          { label: 'high', controls: MIXMSTRS_CHANNELS.map((c) => `ch${c}_high`) },
        ] },
      { id: 'dynamics', label: 'dynamics',
        controls: [
          ...MIXMSTRS_CHANNELS.map((c) => `comp${c}`),
          ...MIXMSTRS_CHANNELS.map((c) => `ch${c}_compEnable`),
          ...MIXMSTRS_CHANNELS.map((c) => `ch${c}_thresh`),
          ...MIXMSTRS_CHANNELS.map((c) => `ch${c}_ratio`),
        ],
        clusters: [
          { label: 'amount', controls: MIXMSTRS_CHANNELS.map((c) => `comp${c}`) },
          // ⚠ 'enable compressor', not 'enable' — owner review, 2026-08-17:
          // *"the "enable" label shoud say "enable compressor""*. With the
          // per-cell `1CP…8CP` captions gone (see `bareCells`) this heading is
          // the ONLY text naming the row, so it has to say what it enables.
          // Lowercase per the repo's label convention; `.cluster-label`
          // uppercases it in CSS.
          { label: 'enable compressor', controls: MIXMSTRS_CHANNELS.map((c) => `ch${c}_compEnable`) },
          { label: 'threshold', controls: MIXMSTRS_CHANNELS.map((c) => `ch${c}_thresh`) },
          { label: 'ratio', controls: MIXMSTRS_CHANNELS.map((c) => `ch${c}_ratio`) },
        ] },
      { id: 'sends', label: 'aux sends',
        controls: [
          ...MIXMSTRS_CHANNELS.map((c) => `ch${c}_send1`), 'send1Pre',
          ...MIXMSTRS_CHANNELS.map((c) => `ch${c}_send2`), 'send2Pre',
        ],
        clusters: MIXMSTRS_RETURNS.map((r) => ({
          label: `send ${r}`,
          controls: [...MIXMSTRS_CHANNELS.map((c) => `ch${c}_send${r}`), `send${r}Pre`],
        })) },
      // ⚠ THE ONE BAND WHOSE CLUSTERS SIT SIDE BY SIDE — owner, 2026-08-17:
      // *"return 1 and return 2 can sit next to each other, too, saving on
      // vertical space and reducing unused horizontal space"*. The two returns
      // are PEERS (one strip each, identical shape), not two rows of one table,
      // so nothing is aligned by stacking them — unlike `channels`, where
      // column N of `level`/`low`/`mid`/`high` is channel N and the stack IS
      // the console grid. Declaring `'row'` turns the console grid off for this
      // band, which is correct and not a loss: the alignment it would provide
      // is between return 1's fader and return 2's fader, which nobody reads.
      //
      // It only fits because the captions went first: a return strip was
      // `[fader][LO][MD][HI]` plus four caption lines and four value lines, and
      // is now four bare cells.
      { id: 'returns', label: 'returns', clusterFlow: 'row',
        controls: MIXMSTRS_RETURNS.flatMap((r) => [
          `ret${r}_volume`, `ret${r}_low`, `ret${r}_mid`, `ret${r}_high`,
        ]),
        clusters: MIXMSTRS_RETURNS.map((r) => ({
          label: `return ${r}`,
          controls: [`ret${r}_volume`, `ret${r}_low`, `ret${r}_mid`, `ret${r}_high`],
        })) },
      // ⚠ THE FIFTH BAND, AND THE LAST ONE THIS MODULE CAN AFFORD TO ADD AS A
      // PAGE. `DOCK_TAB_MIN_BANDS = 7` turns the dock into a TAB RAIL that
      // renders one band at a time, which on a mixer destroys the single thing
      // the surface exists for — balancing eight faders against each other.
      // Five is safe; the deferred `pan{N}` row would be the sixth, and a
      // seventh trips it. So the record band and a pan band CANNOT both be new
      // pages: whichever lands second folds into an existing band, most
      // naturally `channels`. Sequenced, not parallelised.
      //
      // Column N is channel N here too, like every other console band: the arm
      // and monitor clusters are eight cells each in strip order, so a column
      // reads down as one channel's record strip.
      //
      // ⚠ RESTING TEXT IS OPTION NAMES ONLY (`off` / `once` / `inf`,
      // `live` / `both` / `auto`), which is the permitted role. No elapsed
      // time, no take size, no sample count anywhere on the faceplate — those
      // go to `title`/`aria`.
      { id: 'record', label: 'record',
        controls: [
          ...MIXMSTRS_REC_ARM_IDS,
          ...MIXMSTRS_MON_IDS,
          ...MIXMSTRS_REC_BUS_IDS,
        ],
        // ⚠ THIS BAND IS DELIBERATELY **NOT** ON THE FACE-WIDE CONSOLE RULER,
        // and the reason is measured rather than preferred.
        //
        // Every control here is SEGMENTED (each declares a three-option
        // roster), and a segmented cell is far wider than a knob because its
        // width is set by its option labels. Putting the band on the shared
        // ruler was tried: the face went from ONE column pitch to FOUR —
        // `[168.2, 161.2, 161.1, 111.6]` CSS px — because `max-content` tracks
        // shared across bands take the widest cell in any of them. That is
        // exactly the defect #1825 exists to prevent ("three pitches, and by
        // channel 8 the same channel's cells were 90 px apart"), so a record
        // row cannot share the fader ruler without destroying it for the three
        // bands that depend on it.
        //
        // `consoleGridCols` returns null unless EVERY cluster in a band has the
        // same cell count, so the two singleton clusters below are what keep
        // this band off the ruler — a structural consequence, stated here so it
        // reads as the decision it is rather than an accident someone might
        // "fix". Within the band the arm row is still eight cells in strip
        // order, left to right; it simply does not share the pitch of the
        // faders two bands up.
        //
        // ⚠ OWNER PREVIEW: this is the one visual compromise in the slice.
        clusters: [
          { label: 'arm', controls: [...MIXMSTRS_REC_ARM_IDS] },
          { label: 'monitor', controls: [...MIXMSTRS_MON_IDS] },
          { label: 'source', controls: ['recTap'] },
          { label: 'quality', controls: ['recQuality'] },
        ] },
    ],

    // A live tap on `masterL`, and the resolution is ESTABLISHED rather than
    // assumed. `primaryAudioOutPortId` takes the FIRST `audio`-typed output
    // (`shell-glyph-live.ts:95`), which here is `masterL` — the master bus this
    // module exists to produce. That is NOT true of every multi-out mixer:
    // #1667 is open precisely because `attenumix.outputs[0]` is a per-channel
    // DIRECT OUT, so the same resolver grabs channel one there. mixmstrs is on
    // the right side of that bug by construction, and the assertion in
    // `mixmstrs-face-model.test.ts` names the port so a future output reorder
    // reddens instead of silently re-pointing the meter.
    //
    // ⚠ NOT the per-channel VU. `read('levels')` is a MONO-SUM tap and is
    // measurably blind to phase (see the note above the face); `masterL` is the
    // real bus. UNLIT and deterministic on a silent rack — this is a mixer with
    // no generator in it, so with nothing patched the output is bit-exactly
    // zero and there is no analogVco-class VRT instability.
    glyph: 'meter',

    // EVERY LEVEL IS A FADER, because that is what a console is and `fader` is
    // the declared way a def says "this level is a THROW, not a dial"
    // (`ModuleFace.paramCells`, owner directive 2026-08-10). The eight channel
    // volumes, the two return levels and the master. The send AMOUNTS are
    // levels too and stay dials: on a console an aux send is a rotary, and the
    // fader row is what a hand finds without looking.
    //
    // Width was checked rather than guessed: `PARAM_CELL_WIDTH_CLASS.fader` is
    // 'column' (a 12 px slot — narrower than a knob's 40-68.8 px), so the
    // eight-fader `levels` band still packs as ONE row under
    // `DOCK_ROW_MAX_CONTROLS = 10`.
    //
    // ⚠ THIS SAID `'neon-fader'` UNTIL #1794. That kind existed only while the
    // old `Fader.svelte` was still mounted by ~90 cards — owner review of
    // #1738 asked for *"a new UI control for faders that matches our blue neon
    // controls"*, and adopting it one declaration at a time was how the new
    // throw shipped without moving every other module's baseline. The owner
    // then ruled the migration global (*"all the old style faders need to be
    // replaced with the new ones"*), `Fader.svelte` is deleted, and `'fader'`
    // now MEANS the neon throw — so the two kinds collapsed into one and this
    // declaration lost its adjective without losing its meaning.
    // ── THE CAPTIONS THAT ARE NOT THERE ───────────────────────────────────
    //
    // Owner review, 2026-08-17: *"the 1lo 1md 1hi etc labels should also go
    // away because the low/mid/high labels above the knob rows convey that
    // fine"*, *"we do not need a 1cp etc label under it"*, *"all the threshold
    // ratio abd send knobs should not have white numbers or 1S1 etc labels"*,
    // *"all of our white decimely representatons of fader state and the fader
    // labels should be removed"*.
    //
    // ⚠ THE RULE IS REDUNDANCY, NOT TIDINESS, and the owner drew the line
    // himself in the same review: *"mixmstrs is different than tidyvco because
    // tidyvco does need some of the gray labels -- like a/d/s/r would not be
    // comprehensible without them"*. On tidyVco `F.A`/`F.D`/`F.S`/`F.R` are the
    // ONLY thing separating four identical dials. Here every cell sits in a
    // cluster whose heading already names the function and whose COLUMN already
    // names the channel — `1LO` under a `LOW` heading in column 1 says nothing
    // the grid has not said twice. That is why this is a per-param list and not
    // a face-wide or tier-wide flag: the two faces need opposite answers.
    //
    // DERIVED MEMBERSHIP, both directions: it is EVERY declared param except
    // the ones no heading names, so a ninth channel or a new per-channel
    // control arrives bare without anyone editing this list, and the exceptions
    // are the thing that has to be justified rather than the rule.
    //
    //   send{R}Pre  the ONLY exception, and the tail of an `aux sends` cluster
    //               whose heading says `SEND 1` — which names the send AMOUNT
    //               row, not the tap point. `S1PRE` is the only surface saying
    //               this switch is the pre/post select, and the header echo
    //               that used to say it a second time went in #1738.
    //
    // ⚠ `master_volume` WAS AN EXCEPTION AND IS NOT ANY MORE. It sits alone
    // above every band with no cluster heading over it, which is a real reason
    // to keep a caption and is why it survived the first pass — the owner then
    // named it explicitly (*"[MASTER 1.00 …] these numbers and text should go
    // away"*), so the hero is bare too.
    bareCells: PARAMS.map((p) => p.id).filter(
      (id) => !CAPTIONED_PARAM_IDS.has(id),
    ),

    paramCells: Object.fromEntries([
      ['master_volume', 'fader' as const],
      ...MIXMSTRS_CHANNELS.map((c) => [`ch${c}_volume`, 'fader' as const]),
      ...MIXMSTRS_RETURNS.map((r) => [`ret${r}_volume`, 'fader' as const]),
    ]),

    // ── CHANNEL N IS LANE N (#1825) ────────────────────────────────────────
    //
    // Owner, 2026-08-17: *"for mixmstrs only, ch1-8 instead of neon blue, all
    // controls should match the assigned color of its lane."*
    //
    // A mixmstrs channel is not an anonymous strip — it is the SAME index that
    // names a rack lane everywhere else: the automation lane, the clip row, the
    // "assign to channel N" action, the assigned card's border, the Launchpad
    // pad. On a console of eight bit-identical strips the colour is the only
    // thing that says WHICH one you are touching, and the face-model header
    // already argues that the eight channels are exactly TIED on every axis the
    // module has — so identity has to come from outside the module, and the
    // lane is where it already lives.
    //
    // ⚠ DERIVED FROM `PARAMS` THROUGH THE DEF'S OWN NAMING RULE, not typed. A
    // ninth channel, or a tenth per-channel control, joins with no edit here.
    // ⚠ AND THE RETURN STRIPS ARE DELIBERATELY ABSENT: `ret1_*` is not channel
    // one, it is the wet coming back from send one, so it keeps the domain
    // accent. `mixmstrsChannelIndex` answers `null` for it, which is the whole
    // reason the mapping is a predicate over ids and not a column position —
    // the `returns` band is a 4-column table whose columns are NOT channels.
    channelAccent: MIXMSTRS_CHANNELS.map((_, i) =>
      PARAMS.filter((p) => mixmstrsChannelIndex(p.id) === i).map((p) => p.id),
    ),

    // THE HERO: the master fader, and four derived readouts.
    //
    // ⚠ `master_volume` IS PROMOTED WHERE moog914 REFUSED TO PROMOTE ANYTHING,
    // and the difference is the whole test of a rank. There, all fourteen levels
    // were interchangeable, so elevating one was an arbitrary claim. Here the
    // master is the single control that is NOT one of a symmetric set: unique on
    // the module, scope 10 against every channel's 1, and the largest measured
    // mover. The argument would be WRONG for the filter banks, which is what
    // makes it an argument rather than a preference.
    //
    // No `hero.cell` — see the no-panel note above the face. That also means
    // the shell glyph is NOT suppressed at the dock, so the meter paints.
    //
    // Each readout is negative-controlled PERMANENTLY on the input a knob
    // readback is blind to, in `mixmstrs-face-model.test.ts`:
    //
    //   bus     the fully-correlated worst-case gain into the master, which no
    //           single fader can show. Measured 6.7187 against the formula's
    //           6.72 on ten correlated full-scale sources at the defaults —
    //           i.e. TWO hot channels already clip and nothing here limits.
    //           `ch1_thresh` (bit-exactly inert) must not move it; `ret1_volume`
    //           must, which is the leg that catches a readout that summed only
    //           the channels.
    //   asleep  the sixteen faders that do nothing. Reads BOTH enablers through
    //           `mapCompMacro`, so the manual switch and the macro are each
    //           other's controls; `ch1_volume` must move neither.
    //   send 1  the tap point AND whether the bus is alive, because the switch
    //   send 2  is bit-exactly inert until a send opens. Must print `off` in
    //           BOTH switch positions while the sends are shut — a caption that
    //           echoed the switch would print PRE and imply something happened.
    hero: {
      control: 'master_volume',
      // ⚠ THERE ARE NO HERO READOUTS, AND `BUS` WAS THE FACE'S OWN MERIT
      // ARGUMENT — recorded here rather than quietly dropped.
      //
      // Two derived values used to print here. `BUS` was the fully-correlated
      // worst-case gain into the master (measured 6.7187 against the formula's
      // 6.72 on ten correlated full-scale sources at the defaults — i.e. TWO
      // hot channels already clip and nothing on this module limits), and
      // `ASLEEP` counted the thresh/ratio pair on every bypassed channel. Both
      // were justified as facts NO SINGLE FADER CAN SHOW, and that justification
      // was true; the `send N` pair above it had already gone in #1738 for the
      // weaker reason that they echoed a switch on the same face.
      //
      // The owner has now looked at the shipped result and ruled anyway
      // (2026-08-17): *"[MASTER 1.00 / BUS ≤ 8.60× · +18.7 dB / ASLEEP 16
      // asleep] these numbers and text should go away"*, and generally *"we
      // don't want text like that in our faceplates"*. So the trade is real and
      // it is the owner's to make: the headroom warning is no longer on the
      // panel at all. It survives in the module's authored `docs`, which is
      // where the explanation belongs (faces carry near-zero authored prose).
      //
      // ⚠ AND THE COMPUTATION WENT WITH THE DISPLAY. `busGainText` /
      // `compAsleepText` / `sendText` and the param snapshot they read are
      // DELETED from `mixmstrs-face-model.ts`, not left dangling behind an
      // unrendered declaration — a derived value nothing paints is a silent
      // no-op that reads like a shipped decision.
    },
  },

  docs: (() => {
    const inputs: Record<string, string> = {};
    const controls: Record<string, string> = {};
    for (const ch of MIXMSTRS_CHANNELS) {
      // Stereo audio inputs.
      inputs[`ch${ch}L`] = `Channel ${ch} left audio input. Pairs with ${`ch${ch}R`} as the stereo source for mixer channel ${ch}.`;
      inputs[`ch${ch}R`] = `Channel ${ch} right audio input, partnering ch${ch}L.`;
      // Per-channel param controls.
      controls[`ch${ch}_volume`] = `Channel ${ch} VOLUME fader (0..1) — the channel's level into the master bus + aux sends. CV via the ch${ch}_volume input.`;
      controls[`ch${ch}_low`] = `Channel ${ch} LOW EQ band (±12 dB) — boost/cut the lows on channel ${ch}. CV via the ch${ch}_low input.`;
      controls[`ch${ch}_mid`] = `Channel ${ch} MID EQ band (±12 dB) — boost/cut the mids on channel ${ch}. CV via the ch${ch}_mid input.`;
      controls[`ch${ch}_high`] = `Channel ${ch} HIGH EQ band (±12 dB) — boost/cut the highs on channel ${ch}. CV via the ch${ch}_high input.`;
      controls[`ch${ch}_thresh`] = `Channel ${ch} compressor THRESHOLD (−36..0 dB) — the level above which channel ${ch}'s compressor starts gain-reduction (only when COMP ENABLE / the COMP macro is on). CV via the ch${ch}_thresh input.`;
      controls[`ch${ch}_ratio`] = `Channel ${ch} compressor RATIO (1..10) — how hard channel ${ch}'s compressor reduces gain above the threshold (1 = none, 10 = strong). CV via the ch${ch}_ratio input.`;
      controls[`ch${ch}_compEnable`] = `Channel ${ch} compressor ENABLE (on/off) — bypasses or engages channel ${ch}'s compressor directly (the manual control under the COMP macro). CV via the ch${ch}_compEnable input.`;
      controls[`comp${ch}`] = `Channel ${ch} COMP macro (0..1) — one knob that collapses the per-channel compressor: 0 = bypass, and (0,1] enables it while interpolating the threshold from 0 dB down to −20 dB and the ratio from 1:1 up to 4:1, for a quick "isolate this channel" amount. Overrides the manual thresh/ratio/enable when moved. CV via the comp${ch} input.`;
      controls[`ch${ch}_send1`] = `Channel ${ch} SEND 1 amount (0..1) — how much of channel ${ch} is tapped to aux-send bus 1 (the send1L/R outputs, e.g. for an external reverb). CV via the ch${ch}_send1 input.`;
      controls[`ch${ch}_send2`] = `Channel ${ch} SEND 2 amount (0..1) — how much of channel ${ch} feeds aux-send bus 2. CV via the ch${ch}_send2 input.`;
      // Per-channel CV inputs (paramTarget = the same id).
      inputs[`ch${ch}_volume`] = `CV that offsets channel ${ch}'s VOLUME fader (±1 CV sweeps the full 0..1 span around the knob).`;
      inputs[`ch${ch}_low`] = `CV that offsets channel ${ch}'s LOW EQ band.`;
      inputs[`ch${ch}_mid`] = `CV that offsets channel ${ch}'s MID EQ band.`;
      inputs[`ch${ch}_high`] = `CV that offsets channel ${ch}'s HIGH EQ band.`;
      inputs[`ch${ch}_thresh`] = `CV that offsets channel ${ch}'s compressor THRESHOLD.`;
      inputs[`ch${ch}_ratio`] = `CV that offsets channel ${ch}'s compressor RATIO.`;
      inputs[`ch${ch}_compEnable`] = `CV (discrete) that toggles channel ${ch}'s compressor ENABLE.`;
      inputs[`comp${ch}`] = `CV that offsets channel ${ch}'s COMP macro amount.`;
      inputs[`ch${ch}_send1`] = `CV that offsets channel ${ch}'s SEND 1 amount.`;
      inputs[`ch${ch}_send2`] = `CV that offsets channel ${ch}'s SEND 2 amount.`;
      controls[`ch${ch}_rec`] = `CLIP-RECORD ARM for channel ${ch}. OFF (default), ONCE = record exactly one loop into the clip launcher and stop, INF = record until STOP, which lands at the END of the current loop rather than immediately. The take is captured PRE-BOARD — the raw signal you patched in, before EQ, before the compressor, before the fader — so a muted channel still records, and a hot module that already exceeds ±1.0 is captured intact. Channel ${ch} records into launcher LANE ${ch}: the channel number and the lane number are the same number everywhere in this product. CV via the ch${ch}_rec input, so a gate can arm a channel.`;
      inputs[`ch${ch}_rec`] = `CV (discrete) that sets channel ${ch}'s CLIP-RECORD arm — a gate can arm a channel: low = off, mid = one loop, high = record until STOP.`;
      inputs[`ch${ch}_mon`] = `CV (discrete) that sets channel ${ch}'s launcher-return MONITOR mode (live / both / clip-auto).`;
      controls[`ch${ch}_mon`] = `MONITOR mode for channel ${ch}'s launcher return. Lane ${ch} of the clip launcher is NORMALLED into this channel — an internal connection that BREAKS the moment you patch a cable into channel ${ch}'s input, exactly like a hardware normal. AUTO (the default) mutes the live input while lane ${ch}'s clip is playing, so recording a loop and hearing it take over needs no cable moves; BOTH sums the live input and the clip, for playing along with your own loop; LIVE ignores the return entirely. Only the LIVE branch is ducked — the returning clip is never attenuated. CV via the ch${ch}_mon input.`;
    }
    // Stereo aux returns.
    inputs.ret1L = 'Aux RETURN 1 left input — the wet signal coming back from the effect on send 1; summed (stereo) into the master bus.';
    inputs.ret1R = 'Aux RETURN 1 right input, partnering ret1L.';
    inputs.ret2L = 'Aux RETURN 2 left input — the wet return for send 2; summed into the master bus.';
    inputs.ret2R = 'Aux RETURN 2 right input, partnering ret2L.';
    // Master CV.
    inputs.master_volume = 'CV that offsets the MASTER volume — modulate the overall output level of the whole mix.';
    // Per-BUS pre/post-fader select.
    controls.send1Pre = "SEND 1 PRE/POST-fader switch. POST (the default) taps each channel AFTER its volume fader, so pulling a fader down takes its send with it. PRE taps after EQ + compressor but BEFORE the fader, so the send level is the channel's signal × its SEND 1 amount no matter where the fader sits — which is how a RETURN keeps carrying sound while the channel it sits on is muted (a monitor feed, or a reverb that should ring on through a mute). Affects the whole send-1 bus, and is independent of SEND 2's switch.";
    controls.send2Pre = "SEND 2 PRE/POST-fader switch — the same choice as send1Pre, for the send-2 bus, and set independently of it: send 1 can be PRE while send 2 stays POST.";
    inputs.send1Pre = 'CV (discrete) that switches the SEND 1 bus between POST-fader (low) and PRE-fader (high).';
    inputs.send2Pre = 'CV (discrete) that switches the SEND 2 bus between POST-fader (low) and PRE-fader (high).';
    // Bus-scoped clip-record controls.
    controls.recTap = "WHERE a clip take is tapped from. BOARD IN (the default, and the only wired option) is the RAW patched channel input — before EQ, before the compressor, before the fader. Note that this is NOT the same point as a PRE-fader send: send1Pre/send2Pre's PRE means post-EQ, post-compressor, pre-fader, so 'pre-board' and 'pre-fader' are two different taps on this module. POST FADER would need the DSP's stereo per-channel taps (the shipped mono ones sum L+R and are measurably blind to phase, so they cannot serve), and MASTER would record the whole mix bus; neither is wired in this build.";
    controls.recQuality = 'RECORDING QUALITY for clip takes. STUDIO (the default) stores PCM f32 at the context sample rate: it costs no conversion at all — the samples are already f32 — and it is the only tier that cannot clip a hot pre-board tap, which matters because a module patched into a channel can exceed ±1.0 before the board ever sees it. STANDARD is PCM i16, half the bytes, and clips at ±1.0. COMPACT is Opus, which needs a Worker encoder per recording lane.';
    inputs.recTap = 'CV (discrete) that selects the clip-recording TAP point.';
    inputs.recQuality = 'CV (discrete) that selects the clip-recording QUALITY tier.';
    // Return strips.
    for (const r of MIXMSTRS_RETURNS) {
      controls[`ret${r}_volume`] = `RETURN ${r} level (0..1, default 1 = unity) — how loud the wet signal coming back from the effect on send ${r} sits in the master. This is the knob that makes a PRE-fader send usable: with send ${r} switched to PRE, the return keeps sounding while the source channel is muted, and this sets how loud. CV via the ret${r}_volume input.`;
      controls[`ret${r}_low`] = `RETURN ${r} LOW EQ band (±12 dB) — shape the returning wet signal (e.g. roll the lows out of a reverb). Bypassed entirely while all three return-${r} bands sit at 0 dB. CV via the ret${r}_low input.`;
      controls[`ret${r}_mid`] = `RETURN ${r} MID EQ band (±12 dB). CV via the ret${r}_mid input.`;
      controls[`ret${r}_high`] = `RETURN ${r} HIGH EQ band (±12 dB). CV via the ret${r}_high input.`;
      inputs[`ret${r}_volume`] = `CV that offsets RETURN ${r}'s level.`;
      inputs[`ret${r}_low`] = `CV that offsets RETURN ${r}'s LOW EQ band.`;
      inputs[`ret${r}_mid`] = `CV that offsets RETURN ${r}'s MID EQ band.`;
      inputs[`ret${r}_high`] = `CV that offsets RETURN ${r}'s HIGH EQ band.`;
    }
    return {
      explanation:
        "An 8-channel stereo mixer with a channel strip on every input — the master bus of a patch. Each of the eight channels takes a stereo pair, runs it through a 3-band EQ (low/mid/high, ±12 dB), an optional compressor, and a volume fader, then sums into the stereo MASTER output. Two stereo AUX SENDS tap each channel (per-channel SEND 1 / SEND 2 amounts) out to send1L/R and send2L/R — patch an external reverb/delay off a send and bring its wet signal back into the matching stereo RETURN, which sums into the master. The compressor is exposed two ways: manual THRESH / RATIO / ENABLE per channel, OR a single COMP macro knob that collapses all three into one 'amount' (0 = bypass, up to a moderate −20 dB / 4:1 at full). EVERY parameter also has a CV input (so an LFO can ride a fader, EQ band, or send), and the card shows a post-fader VU meter per channel. Multiple MIXMSTRS instances are allowed for submixes / parallel buses — each sums additively into its destination.",
      inputs,
      outputs: {
        masterL: 'MASTER bus left output — all eight channels (post EQ/comp/fader) plus the two aux returns, summed. The main stereo mix out.',
        masterR: 'MASTER bus right output, the partner of masterL.',
        send1L: "AUX SEND 1 left output — the sum of every channel scaled by its SEND 1 amount. Patch it into an external effect, then return the wet to ret1L/R. The tap point follows the send1Pre switch: POST-fader by default, or PRE-fader (before the volume fader) so the bus keeps carrying a muted channel.",
        send1R: 'AUX SEND 1 right output, the partner of send1L.',
        send2L: 'AUX SEND 2 left output — the sum of every channel scaled by its SEND 2 amount. Return its wet to ret2L/R.',
        send2R: 'AUX SEND 2 right output, the partner of send2L.',
      },
      controls: {
        ...controls,
        master_volume: 'MASTER output level (0..1) — the overall gain of the whole mix bus. CV via the master_volume input.',
      },
    };
  })(),

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const f = await instantiateFaustModule(ctx, { name: 'mixmstrs', wasmUrl, metaUrl, workletUrl }, node);

    // 20 mono audio inputs into the Faust worklet (channel-merger of 20).
    // The Faust process() takes 20 args in the same order our inputs declare.
    const NUM_AUDIO_IN = AUDIO_IN_PORTS.length; // 20
    const merger = ctx.createChannelMerger(NUM_AUDIO_IN);
    merger.connect(f);
    // Silence keeps each channel active even with nothing patched in.
    const silenceSources: ConstantSourceNode[] = [];
    for (let i = 0; i < NUM_AUDIO_IN; i++) {
      const sil = ctx.createConstantSource();
      sil.offset.value = 0;
      sil.start();
      silenceSources.push(sil);
    }

    // ── THE PRE-BOARD INSERT ────────────────────────────────────────────────
    //
    // Every audio input port now lands on a unity GainNode instead of straight
    // on the merger, and the chain per port is:
    //
    //     jack --> boardIn[i] --> duck[i] --> merger, input i --> Faust
    //                  |
    //                  '--> (the clip recorder taps HERE, a later slice)
    //
    // ⚠ TWO NODES, NOT ONE, AND THE ORDER IS THE FEATURE. `boardIn` is the TAP
    // POINT — the raw patched channel input, before EQ, before the compressor,
    // before the fader, which is the only place on this module where the audio
    // is what the player patched in. `duck` is MON's attenuator and sits
    // DOWNSTREAM of it. Folding the two into one node would duck the tap, and a
    // take recorded WHILE a previous take plays and ducks that same input would
    // capture the silence the first take caused — a failure that produces a
    // file, green tests, and nothing audible in it.
    //
    // ⚠ "PRE-BOARD" IS NOT "PRE-FADER" ON THIS MODULE. `send{R}Pre = 1` already
    // means post-EQ, post-comp, PRE-FADER, and `mixmstrs.dsp:81-84` says a
    // pre-EQ tap would be "a THIRD mode, not a redefinition of this one". This
    // is that third mode. Owner-confirmed.
    //
    // ⚠ `x * 1.0` IS IDENTITY FOR EVERY FINITE IEEE-754 FLOAT — AND IT IS
    // ASSERTED, NOT ASSUMED. This module has been bitten by exactly this class
    // of claim before: `mixmstrs.dsp:205-216` records that an algebraically
    // identical pre/post crossfade moved the send baselines by 1-2 ULP on ~35%
    // of samples. `art/scenarios/mixmstrs/board-insert-identity.test.ts` renders
    // the REAL factory through an OfflineAudioContext with and without the
    // insert and reports the measured max |delta-sample|, with a negative
    // control proving the comparison can fail.
    const boardIn: GainNode[] = [];
    const duckGain: GainNode[] = [];
    for (let i = 0; i < NUM_AUDIO_IN; i++) {
      const bi = ctx.createGain();
      bi.gain.value = 1;
      const dk = ctx.createGain();
      dk.gain.value = 1; // MON has no effect until a lane actually plays
      bi.connect(dk);
      dk.connect(merger, 0, i);
      // Silence keeps the chain active with nothing patched in — fed at the
      // HEAD of the insert so the whole chain renders, not just the tail.
      silenceSources[i]!.connect(bi);
      boardIn.push(bi);
      duckGain.push(dk);
    }

    // Output splitter: 14 channels. 0..5 are the patchable module outputs
    // (masterL/R, send1L/R, send2L/R); 6..13 are the per-channel POST-FADER
    // meter taps the DSP now emits (post EQ → comp → fader). The meter taps
    // are NOT exposed as module ports — they only feed the VU analysers below.
    const NUM_OUT = 6 + NUM_CHANNELS; // 14
    const splitter = ctx.createChannelSplitter(NUM_OUT);
    f.connect(splitter);

    const params = f.parameters as unknown as Map<string, AudioParam>;
    // Track comp macro values JS-side (they don't have a backing Faust param;
    // they fan out to the existing thresh/ratio/compEnable triple via setParam).
    const compMacro: Record<string, number> = {};
    for (const id of COMP_MACRO_IDS) compMacro[id] = 0;
    for (const def of PARAMS) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      if (def.id.startsWith('comp')) {
        // Macro: store JS-side, then apply via the same code path setParam uses.
        compMacro[def.id] = v;
        // ⚠ #1737: apply the macro at build ONLY when the rack actually SAVED a
        // value for it. `buildParams()` emits comp{N} AFTER the manual triple,
        // so applying the DEFAULT here ran `mapCompMacro(0)` over whatever
        // ch{N}_{thresh,ratio,compEnable} the rack had just restored — a rack
        // saved before the macro existed came back +29.17 dB louder,
        // uncompressed, on every load (measured on the shipped wasm, #1737).
        // A fresh spawn changes NOTHING audible by skipping this: compEnable's
        // default is 0 (bypassed) either way — but thresh/ratio now genuinely
        // hold their DECLARED defaults, so the card and readLive agree.
        if (node.params != null && def.id in node.params) applyCompMacro(def.id, v);
        continue;
      }
      params.get(`${PARAM_PREFIX}/${def.id}`)?.setValueAtTime(v, ctx.currentTime);
    }

    function applyCompMacro(macroId: string, value: number) {
      // macroId is one of 'comp1'..'comp8'. The N is the channel number.
      const ch = macroId.slice('comp'.length);
      const m = mapCompMacro(value);
      params.get(`${PARAM_PREFIX}/ch${ch}_compEnable`)?.setValueAtTime(m.enable, ctx.currentTime);
      params.get(`${PARAM_PREFIX}/ch${ch}_thresh`)?.setValueAtTime(m.thresh, ctx.currentTime);
      params.get(`${PARAM_PREFIX}/ch${ch}_ratio`)?.setValueAtTime(m.ratio, ctx.currentTime);
    }

    // ── Per-channel POST-FADER meter taps — read('levels') → number[8] ──
    //
    // ACCURATE VU for the Electra MIXMASTER meter row (and any on-card meter):
    // the Faust DSP emits one mono POST-FADER level per channel (post EQ →
    // comp → volume fader) on worklet outputs 6..11. We split those off and run
    // each through an AnalyserNode; read('levels') returns their RMS. Unlike the
    // prior JS input-tap approximation (input-RMS × live chN_volume, which
    // ignored EQ + comp gain), this reflects exactly what the channel feeds the
    // master bus. (Master VU stays separate via audioOut.read('outputSnapshot').)
    // The analysers are passive sinks — never connected onward — so they add no
    // audible signal and can't alter the mix.
    //
    // splitter channels 6..13 = ch1..ch8 post-fader level taps.
    const meterAnalysers: AnalyserNode[] = [];
    const meterBufs: Float32Array<ArrayBuffer>[] = [];
    const METER_TAP_OFFSET = 6; // outputs 0..5 are master+sends; 6..11 are taps
    for (let ch = 0; ch < NUM_CHANNELS; ch++) {
      const ana = ctx.createAnalyser();
      ana.fftSize = 1024;
      ana.smoothingTimeConstant = 0.3;
      splitter.connect(ana, METER_TAP_OFFSET + ch);
      meterAnalysers.push(ana);
      meterBufs.push(new Float32Array(ana.fftSize));
    }
    function readChannelLevels(): number[] {
      const out: number[] = [];
      for (let ch = 0; ch < NUM_CHANNELS; ch++) {
        const ana = meterAnalysers[ch]!;
        const buf = meterBufs[ch]!;
        ana.getFloatTimeDomainData(buf);
        out.push(rmsLevel(buf));
      }
      return out;
    }

    // Build inputs map: the audio ports at fixed merger indices, then one
    // CV-target per param — Faust-backed except the comp macros, which are
    // published on a shadow GainNode instead.
    //
    // #1662/#1737: the shadow is no longer a dead end. Its DC-1 input makes
    // its output the EFFECTIVE (knob + CV) macro value, a passive AnalyserNode
    // observes it, and `pumpCompMacros` re-applies the macro mapping whenever
    // the combined value moves — so a CV cable and clip automation (which the
    // engine writes onto `inputs[id].param`, i.e. g.gain) are both audible.
    // The wavesculpt CamShadow rig is the template; cv-path.test.ts asserts
    // the LIVE behaviour where it used to characterize the dead end.
    //
    // The backing AudioParam also keeps the engine's CV → AudioParam tap
    // analyser working (motorized fader feedback), as before.
    const compShadow: Record<string, GainNode> = {};
    // #1737: the shadow is now READ BACK. Its input is DC 1, so its OUTPUT is
    // the EFFECTIVE gain — knob base (g.gain.value) PLUS any audio-rate CV the
    // engine connected onto g.gain — and a passive AnalyserNode on that output
    // is where the combined value can actually be observed (the wavesculpt
    // CamShadow template). `pumpCompMacros()` reads each analyser tail and
    // re-applies the macro mapping when the value moved, which is what makes a
    // CV cable (and clip automation via inputs[id].param) AUDIBLE instead of a
    // dead end. The analysers are passive sinks — nothing connects onward, so
    // they cannot alter the mix.
    const compShadowAna: Record<string, { ana: AnalyserNode; buf: Float32Array<ArrayBuffer> }> = {};
    for (const macroId of COMP_MACRO_IDS) {
      const g = ctx.createGain();
      g.gain.setValueAtTime(compMacro[macroId] ?? 0, ctx.currentTime);
      const sink = ctx.createConstantSource();
      sink.offset.value = 1; // DC 1 → g's output IS the effective (knob+CV) gain
      sink.start();
      sink.connect(g);
      const ana = ctx.createAnalyser();
      ana.fftSize = 32;
      g.connect(ana); // passive observation tap; g still feeds no audible path
      // DECLARE the consumer at the construction site. `g.gain` reaches no
      // declared output and never will — the pump above IS its consumer — which
      // is the CORRECT shape for a JS-consumed pad and indistinguishable by
      // reachability alone from the #1661 dead terminal it used to be. Marking
      // it makes `art/scenarios/cv-terminal` read the declaration instead of
      // guessing, and makes membership DERIVED: the eight hand-named
      // `known-defect` entries this module carried there are deleted with this
      // change, exactly as that gate's own message instructs. The claim is
      // checked in both directions — a marked param that DOES reach an output
      // reddens the LYING leg — so this is not an escape hatch.
      markJsConsumedParam(g.gain);
      silenceSources.push(sink);
      compShadow[macroId] = g;
      compShadowAna[macroId] = { ana, buf: new Float32Array(ana.fftSize) };
    }

    // ⚠ READINESS IS A PROPERTY OF THE CLOCK, NEVER OF THE VALUE.
    //
    // The analyser holds zeros until the graph has actually rendered a quantum
    // with the shadow branch in place, so a read before then is NO DATA — not
    // "the macro is 0". wavesculpt's `readCamShadow` distinguishes the two by
    // the value (`tail !== 0 || gain.value === 0 ? tail : gain.value`) and that
    // form CANNOT: a CV cable that cancels the knob to exactly 0 produces the
    // same bit pattern as an unrendered analyser. For this macro 0 is BYPASS —
    // the single most likely place a cable puts it — so the value-based form
    // reinstates the very dead end #1737 is about. Measured with knob 0.5 and
    // CV −0.5 (effective 0): it returned 0.5, and all eight comp CV cables read
    // a bit-exact 0.0000e+0 peak |Δsample| in cv-path.test.ts.
    //
    // The clock cannot be spoofed by a value: `ctx.currentTime` advances only
    // when quanta render, so a suspended context (autoplay policy) still holds
    // the pump off, which is the case the wavesculpt fallback existed to cover.
    // One RENDER QUANTUM is 128 frames by spec — a physical constant of the
    // rendering model, not a population — and the shadow's own connection is
    // applied on a quantum boundary, so two of them is the first read that is
    // certainly backed by rendered samples (fftSize 32 < 128, so the whole tap
    // window is real by then).
    const RENDER_QUANTUM_FRAMES = 128;
    const compShadowsBuiltAt = ctx.currentTime;
    const COMP_SHADOW_READY_S = (2 * RENDER_QUANTUM_FRAMES) / ctx.sampleRate;
    // Last COMBINED (knob + CV) value actually APPLIED to the Faust triple, per
    // macro — the pump's change detector, seeded from the build-time knob so an
    // unmoved shadow never re-applies (and never clobbers a manual triple).
    //
    // ⚠ SEPARATE FROM `compMacro`, WHICH STAYS THE KNOB INTRINSIC. The pump must
    // not write the combined value back into what `readParam` reports:
    // `AudioEngine.readParam` adds the modulator tap ON TOP of the handle's
    // intrinsic for the motorized fader, so a combined intrinsic counts the
    // cable twice. `cv-shadow`'s `knob()` states the same contract for every
    // other JS-consumed pad, and this is one of those now.
    const compApplied: Record<string, number> = { ...compMacro };
    function pumpCompMacros() {
      if (ctx.currentTime - compShadowsBuiltAt < COMP_SHADOW_READY_S) return;
      for (const macroId of COMP_MACRO_IDS) {
        const s = compShadowAna[macroId];
        if (!s) continue;
        s.ana.getFloatTimeDomainData(s.buf);
        // DC 1 in → the tap's newest sample IS the effective (knob + CV) macro
        // value, in the macro's own 0..1 units.
        const combined = Math.max(0, Math.min(1, s.buf[s.buf.length - 1] ?? 0));
        if (Math.abs(combined - (compApplied[macroId] ?? 0)) > 1e-6) {
          compApplied[macroId] = combined;
          applyCompMacro(macroId, combined);
        }
      }
    }
    // Live path: one slow main-thread tick. 48 ms is control-rate for a macro
    // that fans out to setTargetAtTime'd Faust params — audio-rate fidelity is
    // neither possible (the mapping is a JS piecewise) nor needed. Offline
    // (ART) renders call the pump deterministically via read('pumpCompMacros')
    // at suspend points instead of racing this wall-clock timer.
    const COMP_PUMP_MS = 48;
    const compPumpTimer = setInterval(pumpCompMacros, COMP_PUMP_MS);

    // ── CLIP-RECORD PARAM SHADOWS (ch{N}_rec, ch{N}_mon, recTap, recQuality) ──
    //
    // The comp-macro rig, reused verbatim in shape: a shadow GainNode fed DC 1
    // so its OUTPUT is the EFFECTIVE (knob + CV) value, a passive analyser to
    // observe it, and `markJsConsumedParam` to declare the consumer at the
    // construction site. Nothing here connects onward to audio, so none of it
    // can alter the mix.
    //
    // ⚠ THE CONSUMER IS REAL TODAY, not a promise. `read('recState')` returns
    // these effective values, which is what makes a CV cable into `ch1_rec`
    // observable from the moment this ships rather than in a later slice. MON
    // additionally drives the duck below. The RECORDER that acts on the arm and
    // the tap lands in a later slice; the state it will read is already live.
    const jsKnob: Record<string, number> = {};
    for (const def of PARAMS) {
      if (JS_CONSUMED_PARAM_IDS.includes(def.id)) jsKnob[def.id] = def.defaultValue;
    }
    const jsShadow: Record<string, GainNode> = {};
    const jsShadowAna: Record<string, { ana: AnalyserNode; buf: Float32Array<ArrayBuffer> }> = {};
    for (const id of JS_CONSUMED_PARAM_IDS) {
      const g = ctx.createGain();
      g.gain.setValueAtTime(jsKnob[id] ?? 0, ctx.currentTime);
      const sink = ctx.createConstantSource();
      sink.offset.value = 1; // DC 1 → g's output IS the effective (knob + CV) value
      sink.start();
      sink.connect(g);
      const ana = ctx.createAnalyser();
      ana.fftSize = 32;
      g.connect(ana); // passive observation tap; feeds no audible path
      markJsConsumedParam(g.gain);
      silenceSources.push(sink);
      jsShadow[id] = g;
      jsShadowAna[id] = { ana, buf: new Float32Array(ana.fftSize) };
    }

    /** The effective (knob + CV) value of a JS-consumed param, clamped to its
     *  declared range. Falls back to the knob intrinsic until the graph has
     *  rendered — readiness is a property of the CLOCK, never of the value. */
    function jsEffective(id: string, min: number, max: number): number {
      const knob = jsKnob[id] ?? 0;
      if (ctx.currentTime - compShadowsBuiltAt < COMP_SHADOW_READY_S) return knob;
      const s = jsShadowAna[id];
      if (!s) return knob;
      s.ana.getFloatTimeDomainData(s.buf);
      const v = s.buf[s.buf.length - 1] ?? knob;
      return Math.max(min, Math.min(max, v));
    }

    /** Snap a continuous effective value onto one of the three discrete steps. */
    const snap3 = (v: number): number => Math.max(0, Math.min(2, Math.round(v)));

    /** The module's live clip-record state, as the recorder will read it. */
    function readRecState(): {
      arm: number[];
      mon: number[];
      tap: number;
      quality: number;
    } {
      return {
        arm: MIXMSTRS_REC_ARM_IDS.map((id) => snap3(jsEffective(id, 0, 2))),
        mon: MIXMSTRS_MON_IDS.map((id) => snap3(jsEffective(id, 0, 2))),
        tap: snap3(jsEffective('recTap', 0, 2)),
        quality: snap3(jsEffective('recQuality', 0, 2)),
      };
    }

    // ── THE MON DUCK ────────────────────────────────────────────────────────
    //
    // ⚠ IN THIS SLICE THE DUCK NEVER ENGAGES, AND THAT IS THE POINT. Its only
    // other input is "is lane N of the launcher playing", which arrives as a
    // `ClipLanePlayingEdge` scheduled at a context time — and nothing publishes
    // one until the return is wired in a later slice. `clipLaneLiveGain(mon,
    // false)` is 1 in EVERY mode, so every duck gain stays at unity and this
    // module's audio is bit-identical to before. The identity ART leg asserts
    // exactly that.
    //
    // ⚠ AND WHEN IT DOES ENGAGE IT WILL BE SCHEDULED, NOT POLLED. The gain is
    // ramped at the `ctx.currentTime` the clip's own source node starts or
    // stops on — one AudioParam event per transition, landing on the clip's
    // first sample. A per-quantum read of lane state is unavailable on the
    // audio thread and would derive a boundary from a tick count, which is the
    // blood failure (62 % of demand delivered, 38 % of every output sample a
    // hard zero). This pump only tracks the MON KNOB; it is not the boundary.
    const lanePlaying: boolean[] = new Array(NUM_CHANNELS).fill(false);
    const duckApplied: number[] = new Array(NUM_CHANNELS).fill(1);
    function pumpMonDuck() {
      if (ctx.currentTime - compShadowsBuiltAt < COMP_SHADOW_READY_S) return;
      for (let c = 0; c < NUM_CHANNELS; c++) {
        const mon = coerceClipLaneMon(snap3(jsEffective(MIXMSTRS_MON_IDS[c]!, 0, 2)));
        const want = clipLaneLiveGain(mon, lanePlaying[c] === true);
        if (Math.abs(want - (duckApplied[c] ?? 1)) <= 1e-6) continue;
        duckApplied[c] = want;
        // Both legs of the channel move together — one MON, one stereo pair.
        for (const leg of [2 * c, 2 * c + 1]) {
          duckGain[leg]?.gain.setTargetAtTime(want, ctx.currentTime, DUCK_GLIDE_S);
        }
      }
    }
    const monPumpTimer = setInterval(pumpMonDuck, COMP_PUMP_MS);

    const inputsMap = new Map<string, { node: AudioNode; input: number; param?: AudioParam }>();
    AUDIO_IN_PORTS.forEach((id, i) => {
      // The cable lands on the INSERT HEAD, not on the merger — so the tap sees
      // the patched signal before MON's duck can touch it.
      inputsMap.set(id, { node: boardIn[i]!, input: 0 });
    });
    for (const p of PARAMS) {
      if (p.id.startsWith('comp')) {
        // CV input for the comp macro: route to the shadow AudioParam so the
        // engine's CV-tap analyser sees modulator activity. The actual
        // application of comp → (enable, thresh, ratio) happens in setParam.
        const g = compShadow[p.id];
        if (g) inputsMap.set(p.id, { node: g, input: 0, param: g.gain });
        continue;
      }
      if (jsShadow[p.id]) {
        // The same treatment for the clip-record controls: the CV input routes
        // to the shadow's AudioParam, which is exactly what
        // `AudioEngine.addEdge` connects a cable to.
        //
        // ⚠ WITHOUT THIS THE PORT IS DECLARED AND ANSWERS NOTHING. A cable
        // would have no AudioParam to land on — the #1734 dead-terminal shape,
        // where the def promises a CV input the handle cannot honour. It was
        // caught by `art/scenarios/cv-terminal` ("every DECLARED paramTarget
        // port is answered by the live handle"), which is precisely the gate
        // that exists for it.
        const g = jsShadow[p.id]!;
        inputsMap.set(p.id, { node: g, input: 0, param: g.gain });
        continue;
      }
      const ap = params.get(`${PARAM_PREFIX}/${p.id}`);
      if (ap) inputsMap.set(p.id, { node: f, input: 0, param: ap });
    }

    const outputsMap = new Map<string, { node: AudioNode; output: number }>();
    ['masterL','masterR','send1L','send1R','send2L','send2R'].forEach((id, i) => {
      outputsMap.set(id, { node: splitter, output: i });
    });

    return {
      domain: 'audio',
      inputs: inputsMap,
      outputs: outputsMap,
      setParam(paramId, value) {
        if (paramId.startsWith('comp')) {
          compMacro[paramId] = value;
          // The knob write applies immediately; sync the pump's change
          // detector so the next tick doesn't re-apply the same value (#1737).
          compApplied[paramId] = value;
          // Update the shadow AudioParam so readParam returns the live value.
          compShadow[paramId]?.gain.setValueAtTime(value, ctx.currentTime);
          applyCompMacro(paramId, value);
          return;
        }
        if (jsShadow[paramId]) {
          // A JS-consumed clip-record control. The knob intrinsic is what
          // `readParam` reports (the engine folds the modulator tap on top of
          // it — reporting the combined value here would count a patched cable
          // twice on the motorized fader), and the shadow carries the same
          // value so the EFFECTIVE reading stays knob + CV.
          jsKnob[paramId] = value;
          jsShadow[paramId]?.gain.setValueAtTime(value, ctx.currentTime);
          // MON moved: let the duck re-evaluate on the next pump rather than
          // writing the gain here, so there is exactly ONE place that decides
          // what the live branch is worth.
          return;
        }
        params.get(`${PARAM_PREFIX}/${paramId}`)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        // comp{N}: the KNOB INTRINSIC, deliberately not the pumped combined
        // value — `AudioEngine.readParam` folds the modulator tap in on top of
        // whatever this returns, so reporting the combined value here would
        // double-count a patched cable on the motorized fader (#1737).
        if (paramId.startsWith('comp')) return compMacro[paramId];
        // Same contract for the JS-consumed clip-record controls.
        if (jsShadow[paramId]) return jsKnob[paramId];
        return params.get(`${PARAM_PREFIX}/${paramId}`)?.value;
      },
      read(key) {
        // Per-channel POST-FADER VU for the Electra MIXMASTER meter row + any
        // on-card meters. Returns number[8] of linear RMS levels (~0..1), one
        // per channel, read off the DSP's post-fader taps. See
        // readChannelLevels() above.
        if (key === 'levels') return readChannelLevels();
        // #1737: deterministic pump seam for OFFLINE renders — the ART harness
        // calls this at OfflineAudioContext suspend points, where the
        // wall-clock interval above cannot be relied on to tick. Returns a bare
        // acknowledgement so a caller can tell the seam from an unknown key;
        // never audio data, and never anything worth asserting on.
        if (key === 'pumpCompMacros') {
          pumpCompMacros();
          return true;
        }
        // THE CLIP-RECORD STATE, as the recorder will read it: EFFECTIVE
        // (knob + CV) values, snapped to their discrete steps. This is the
        // consumer that makes `markJsConsumedParam` true for these params
        // TODAY — a cable into `ch1_rec` moves what this returns, from the
        // moment the module ships, not in a later slice.
        if (key === 'recState') return readRecState();
        // Deterministic MON-duck pump seam, the sibling of `pumpCompMacros`
        // above and for the same reason: a wall-clock interval cannot be relied
        // on to tick inside an offline render.
        if (key === 'pumpMonDuck') {
          pumpMonDuck();
          return true;
        }
        return undefined;
      },
      dispose() {
        clearInterval(compPumpTimer);
        clearInterval(monPumpTimer);
        for (const s of silenceSources) {
          try { s.stop(); } catch { /* */ }
          s.disconnect();
        }
        for (const g of Object.values(compShadow)) g.disconnect();
        for (const { ana } of Object.values(compShadowAna)) ana.disconnect();
        for (const g of Object.values(jsShadow)) g.disconnect();
        for (const { ana } of Object.values(jsShadowAna)) ana.disconnect();
        for (const g of boardIn) g.disconnect();
        for (const g of duckGain) g.disconnect();
        for (const ana of meterAnalysers) ana.disconnect();
        merger.disconnect();
        splitter.disconnect();
        f.disconnect();
      },
    };
  },
};

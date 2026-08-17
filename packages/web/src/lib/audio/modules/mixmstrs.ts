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
  }
  params.push({ id: 'master_volume', label: 'Master', defaultValue: 0.8, min: 0, max: 1, curve: 'linear' });
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
  'master_volume',
  ...MIXMSTRS_RETURNS.map((r) => `send${r}Pre`),
]);

// Audio input port ids in the exact order the Faust process() declares them:
// 16 channel ports (ch1L..ch8R) then the 4 return ports.
const AUDIO_IN_PORTS: readonly string[] = [
  ...MIXMSTRS_CHANNELS.flatMap((ch) => [`ch${ch}L`, `ch${ch}R`]),
  'ret1L', 'ret1R', 'ret2L', 'ret2R',
];

// Comp-macro ids, derived from the channel list so they never drift apart.
const COMP_MACRO_IDS: readonly string[] = MIXMSTRS_CHANNELS.map((ch) => `comp${ch}`);

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
  // TOTAL over the eleven bus-scoped controls and exactly TIED over the eighty
  // channel-scoped ones, and the face is built so the tie is never consulted —
  // ranks 1-11 are the whole bus-scoped block, which is longer than the largest
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
    // 1-11 · BUS-SCOPED. Master first (scope 10, and the largest measured mover
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
    // 12+ · CHANNEL-SCOPED, FUNCTION-MAJOR / CHANNEL-MINOR — the eight
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
    ],

    // FOUR bands, under a ceiling this module cannot be allowed to
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
    // axis reads `order` / `laneOrder` — never `pages`. So the eleven bus-scoped
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
    // 'column' (a 22 px track — narrower than a knob's 40-68.8 px), so the
    // eight-fader `levels` band still packs as ONE row under
    // `DOCK_ROW_MAX_CONTROLS = 10`.
    //
    // ⚠ `neon-fader`, NOT `fader` — owner review of #1738: *"we need to re-do
    // that level setting fader entirely with a new UI control for faders that
    // matches our blue neon controls."* `NeonFader.svelte` is the same throw
    // gesture drawn in `KnobConic`'s vocabulary (the `--_ka` chain, the 5 px
    // pointer glow, the 9 px mono readout), so on a console the level and its
    // three tone dials read as one family BY CONSTRUCTION rather than by a
    // matched hex. Adopting it is ONE declaration per module, which is why it
    // is a KIND and not an edit to the shared `Fader.svelte` that 93 cards and
    // eight other faced modules mount.
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
    //   master_volume  the HERO. It sits alone above every band with no cluster
    //                  heading over it, so `MASTER` is its only name.
    //   send{R}Pre     the tail of an `aux sends` cluster whose heading says
    //                  `SEND 1` — which is the send AMOUNT row, not the tap
    //                  point. `S1PRE` is the only surface that says this switch
    //                  is the pre/post select, and the header echo that used to
    //                  say it a second time was removed in #1738.
    bareCells: PARAMS.map((p) => p.id).filter(
      (id) => !CAPTIONED_PARAM_IDS.has(id),
    ),

    paramCells: Object.fromEntries([
      ['master_volume', 'neon-fader' as const],
      ...MIXMSTRS_CHANNELS.map((c) => [`ch${c}_volume`, 'neon-fader' as const]),
      ...MIXMSTRS_RETURNS.map((r) => [`ret${r}_volume`, 'neon-fader' as const]),
    ]),

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
      // ⚠ THE SEND PRE/POST READOUTS ARE GONE FROM THE HEADER — owner review of
      // #1738: *"we don't need the send pre/post in the header here."*
      //
      // The two remaining readouts are the ones that state something a player
      // cannot see anywhere else on the face: BUS is the summed headroom (the
      // measured 1.2797 clip at the defaults), ASLEEP is how many of the
      // ninety-one controls are bit-exactly inert right now. `send1Pre` /
      // `send2Pre` are ORDINARY CONTROLS — they have their own cells at the end
      // of each `aux sends` cluster, where the thing they modify is, so the
      // header was printing a second copy of a switch that is already on screen
      // and already labelled.
      //
      // ⚠ THE CONTROLS ARE NOT REMOVED, only the header echo: `faces-parity`
      // asserts one `control-<paramId>` per def param across the whole
      // faceplate, so deleting a cell would be RED, and deleting only the
      // readout is invisible to it — which is why the tray e2e asserts the two
      // switch cells are still present and still reachable by name.
      readouts: [
        { label: 'bus', valueId: 'mixmstrs-bus-gain' },
        { label: 'asleep', valueId: 'mixmstrs-comp-asleep' },
      ],
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
      sil.connect(merger, 0, i);
      silenceSources.push(sil);
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
        applyCompMacro(def.id, v);
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
    // ⚠ #1662: a cable on one of those shadow params is a DEAD END — the
    // GainNode's output goes nowhere and nothing reads `g.gain` back, so CV and
    // clip automation of `comp{N}` are bit-exactly inert while the motorized
    // knob still animates off the engine's param tap. Measured in
    // art/scenarios/mixmstrs/cv-path.test.ts. `wavesculpt.ts:1501` is the fix
    // template (an AnalyserNode on the shadow + a main-thread pump).
    //
    // For comp macros we still need a backing AudioParam so the engine's
    // CV → AudioParam tap analyser works (motorized fader feedback). We
    // route to a hidden GainNode whose .gain is the macro's "shadow" param;
    // setParam reads the shadow's `.value` and applies the macro mapping
    // each time. This mirrors how wavviz handles its foldAmount macro.
    const compShadow: Record<string, GainNode> = {};
    for (const macroId of COMP_MACRO_IDS) {
      const g = ctx.createGain();
      g.gain.setValueAtTime(compMacro[macroId] ?? 0, ctx.currentTime);
      // Connect to a sink ConstantSource(0) so the shadow stays in the
      // active processing graph. We connect g's output to silence (a
      // no-op merger input) so it doesn't actually contribute to audio.
      const sink = ctx.createConstantSource();
      sink.offset.value = 0;
      sink.start();
      sink.connect(g); // sink → g (silent input, keeps g alive)
      // We DON'T connect g downstream — the cv tap analyser reads g.gain,
      // we periodically read it back from setParam to apply the macro mapping.
      silenceSources.push(sink);
      compShadow[macroId] = g;
    }

    const inputsMap = new Map<string, { node: AudioNode; input: number; param?: AudioParam }>();
    AUDIO_IN_PORTS.forEach((id, i) => {
      inputsMap.set(id, { node: merger, input: i });
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
          // Update the shadow AudioParam so readParam returns the live value.
          compShadow[paramId]?.gain.setValueAtTime(value, ctx.currentTime);
          applyCompMacro(paramId, value);
          return;
        }
        params.get(`${PARAM_PREFIX}/${paramId}`)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        if (paramId.startsWith('comp')) return compMacro[paramId];
        return params.get(`${PARAM_PREFIX}/${paramId}`)?.value;
      },
      read(key) {
        // Per-channel POST-FADER VU for the Electra MIXMASTER meter row + any
        // on-card meters. Returns number[8] of linear RMS levels (~0..1), one
        // per channel, read off the DSP's post-fader taps. See
        // readChannelLevels() above.
        if (key === 'levels') return readChannelLevels();
        return undefined;
      },
      dispose() {
        for (const s of silenceSources) {
          try { s.stop(); } catch { /* */ }
          s.disconnect();
        }
        for (const g of Object.values(compShadow)) g.disconnect();
        for (const ana of meterAnalysers) ana.disconnect();
        merger.disconnect();
        splitter.disconnect();
        f.disconnect();
      },
    };
  },
};

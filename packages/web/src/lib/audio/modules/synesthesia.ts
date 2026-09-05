// packages/web/src/lib/audio/modules/synesthesia.ts
//
// SYNESTHESIA — web module def + factory. Two independent copies (A/B) of a
// 4-band audio-analysis circuit. Each copy: mono in → 4 MUSICAL bands
// (bass 20–200 / low-mid 200–1k / high-mid 1k–4k / treble 4k+) → per-band gain
// (master floor + band) → per-band audio, slow (500 ms) + fast (50 ms)
// envelope-follower CV, a hysteresis gate, and a per-band BEAT TRIGGER
// (spectral-flux onset → ~10 ms pulse, LZX-Sensory-Translator style). A 10-bar
// VU meter per band is driven by a `snapshot` posted from the worklet. DSP
// lives in packages/dsp/src/synesthesia.ts.
//
// Worklet I/O (see packages/dsp/src/synesthesia.ts):
//   inputs:  0 = copy A in, 1 = copy B in   (mono)
//   outputs: 0=audioA 1=audioB 2=slowA 3=slowB 4=fastA 5=fastB 6=gateA 7=gateB
//            8=trigA 9=trigB   (each 4 channels = the 4 bands)
//
// VIDEO mode (per copy, independent): a_mode/b_mode params (0=AUDIO, 1=VIDEO).
// In VIDEO mode the 4 lanes become R/G/B/Luma of the patched frame: the CARD
// reads the incoming video frame's pixels (only the DOM has the canvas; the
// worklet can't), averages them to 4 channel levels via videoChannelLevels(),
// and writes them to the worklet via handle.write('video_levels_a'|'_b', …)
// each frame. The worklet sample-and-holds the levels through the same env/
// gate/meter stage. The cross-domain video inputs a_video_in/b_video_in are
// consumed card-side (WAVESCULPT wall precedent) — the engine ignores the
// audio↔audio video-frame edge.
// The factory fans each 4-channel output through a ChannelSplitter into 4 mono
// GainNodes so every band/kind is an individually-patchable port. Each band's
// AUDIO tap also feeds a per-band mono-video "rasterize" output (audio→video):
// an AnalyserNode → drawBandRaster() painting the band's samples as a raster.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/synesthesia.js?url';
import { drawBandRaster } from './synesthesia-draw';

import { createWorkletNode } from '$lib/audio/worklet-guard';
// ---- DETERMINISTIC render-smoke (DRS) seam — zero production impact ----
// The per-band `*_raster` video output paints the band's LIVE analyser
// time-domain window (drawBandRaster) each frame. That window carries whatever
// the audio thread last DMA'd in, which varies by tens of microseconds (= many
// audio samples) run-to-run — the exact non-determinism class wavesculpt's
// __wavesculptVrtFreeze cures. There is NO wall-clock / time / accumulation term
// in the raster draw (it's a stateless function of the current analyser buffer),
// so the seam is NOT a clock-freeze: when the flag is set we OVERRIDE the live
// analyser readout with a FIXED synthetic per-band waveform so the rastered frame
// is byte-stable across runs (non-black + spatially structured by construction).
// The flag is never set in production; the audio/env/gate/meter path is untouched
// (only the raster's source buffer is swapped). Parallels wavesculpt's scope
// freeze + b3ntb0x/bentbox's clock-freeze test seams.
function synesthesiaVrtFrozen(): boolean {
  return (
    (globalThis as unknown as { __synesthesiaVrtFreeze?: boolean }).__synesthesiaVrtFreeze === true
  );
}

/** Fill `buf` with a FIXED synthetic per-band waveform (deterministic raster
 *  source under the VRT-freeze flag). `band` (0..3) picks distinct cycle counts
 *  so the four bands' rasters are visually distinguishable + non-trivially
 *  structured; amplitude 0.6 clears drawBandRaster's ×3 → near-full-scale green
 *  without saturating, so nonZeroFrac + variance floors both hold. */
function fillFrozenBand(buf: Float32Array, band: number): void {
  const cycles = (band + 1) * 1.5; // 1.5 / 3 / 4.5 / 6 cycles across the window
  const amp = 0.6;
  const n = buf.length;
  for (let i = 0; i < n; i++) buf[i] = amp * Math.sin((i / n) * Math.PI * 2 * cycles);
}

const COPIES = ['a', 'b'] as const;
const BANDS = [1, 2, 3, 4] as const;

// Output streams, in worklet-output order. Each entry is one 4-channel worklet
// output (channel index = band index). `port` is the per-band port-id kind.
const OUT_STREAMS: Array<{ outIndex: number; copy: 'a' | 'b'; kind: string; type: 'audio' | 'cv' | 'gate' }> = [
  { outIndex: 0, copy: 'a', kind: 'audio',    type: 'audio' },
  { outIndex: 1, copy: 'b', kind: 'audio',    type: 'audio' },
  { outIndex: 2, copy: 'a', kind: 'env_slow', type: 'cv' },
  { outIndex: 3, copy: 'b', kind: 'env_slow', type: 'cv' },
  { outIndex: 4, copy: 'a', kind: 'env_fast', type: 'cv' },
  { outIndex: 5, copy: 'b', kind: 'env_fast', type: 'cv' },
  { outIndex: 6, copy: 'a', kind: 'gate',     type: 'gate' },
  { outIndex: 7, copy: 'b', kind: 'gate',     type: 'gate' },
  // Per-band beat triggers (spectral-flux onset; ~10 ms pulse). Worklet
  // outputs 8/9; fanned into 4 per-band gate ports each, same as `gate`.
  { outIndex: 8, copy: 'a', kind: 'trig',     type: 'gate' },
  { outIndex: 9, copy: 'b', kind: 'trig',     type: 'gate' },
];

const PARAM_DEFAULTS: Record<string, number> = {};
for (const c of COPIES) {
  PARAM_DEFAULTS[`${c}_master`] = 1;
  PARAM_DEFAULTS[`${c}_mode`] = 0; // 0 = AUDIO (spectral bands), 1 = VIDEO (R/G/B/Luma)
  PARAM_DEFAULTS[`${c}_bipolar`] = 0; // 0 = UNIPOLAR env CV [0,1], 1 = BIPOLAR [-1,+1]
  for (const b of BANDS) {
    PARAM_DEFAULTS[`${c}_gain${b}`] = 1;
    // Per-band ENV-OUTPUT depth: scales BOTH env CV outputs (env_slow +
    // env_fast) for that band. Default 1.0 = unchanged.
    PARAM_DEFAULTS[`${c}_envdepth${b}`] = 1;
  }
}

const loadedContexts = new WeakSet<BaseAudioContext>();

export interface SynesthesiaSnapshot {
  levelsA: number[];
  levelsB: number[];
}

export const synesthesiaDef: AudioModuleDef = {
  type: 'synesthesia',
  palette: { top: 'Hybrid', sub: 'Hybrid' },
  domain: 'audio',
  label: 'synesthesia',
  category: 'hybrid',

  inputs: [
    { id: 'a_in', type: 'audio' },
    { id: 'b_in', type: 'audio' },
    // Cross-domain VIDEO inputs (one per copy). In VIDEO mode the card reads
    // the patched frame's pixels and writes R/G/B/Luma channel levels to the
    // worklet. The frame handoff is done card-side (the engine ignores an
    // audio↔audio video-frame edge — see PatchEngine.addEdge), matching
    // WAVESCULPT's wall inputs.
    { id: 'a_video_in', type: 'video' },
    { id: 'b_video_in', type: 'video' },
  ],
  // 2 copies × 4 bands × {audio, env_slow, env_fast, gate, trig, raster} = 48
  // outputs. Written as a literal list (not a flatMap) so the docs
  // module-manifest's static literal-array port extractor stays in sync (see
  // module-manifest.ts). `trig` is the per-band beat trigger (spectral-flux onset).
  outputs: [
    // ---- Copy A ----
    { id: 'a_band1_audio',    type: 'audio' },
    { id: 'a_band1_env_slow', type: 'cv' },
    { id: 'a_band1_env_fast', type: 'cv' },
    { id: 'a_band1_gate',     type: 'gate', edge: 'gate' },
    { id: 'a_band1_trig',     type: 'gate', edge: 'trigger' },
    { id: 'a_band1_raster',   type: 'mono-video' },
    { id: 'a_band2_audio',    type: 'audio' },
    { id: 'a_band2_env_slow', type: 'cv' },
    { id: 'a_band2_env_fast', type: 'cv' },
    { id: 'a_band2_gate',     type: 'gate', edge: 'gate' },
    { id: 'a_band2_trig',     type: 'gate', edge: 'trigger' },
    { id: 'a_band2_raster',   type: 'mono-video' },
    { id: 'a_band3_audio',    type: 'audio' },
    { id: 'a_band3_env_slow', type: 'cv' },
    { id: 'a_band3_env_fast', type: 'cv' },
    { id: 'a_band3_gate',     type: 'gate', edge: 'gate' },
    { id: 'a_band3_trig',     type: 'gate', edge: 'trigger' },
    { id: 'a_band3_raster',   type: 'mono-video' },
    { id: 'a_band4_audio',    type: 'audio' },
    { id: 'a_band4_env_slow', type: 'cv' },
    { id: 'a_band4_env_fast', type: 'cv' },
    { id: 'a_band4_gate',     type: 'gate', edge: 'gate' },
    { id: 'a_band4_trig',     type: 'gate', edge: 'trigger' },
    { id: 'a_band4_raster',   type: 'mono-video' },
    // ---- Copy B ----
    { id: 'b_band1_audio',    type: 'audio' },
    { id: 'b_band1_env_slow', type: 'cv' },
    { id: 'b_band1_env_fast', type: 'cv' },
    { id: 'b_band1_gate',     type: 'gate', edge: 'gate' },
    { id: 'b_band1_trig',     type: 'gate', edge: 'trigger' },
    { id: 'b_band1_raster',   type: 'mono-video' },
    { id: 'b_band2_audio',    type: 'audio' },
    { id: 'b_band2_env_slow', type: 'cv' },
    { id: 'b_band2_env_fast', type: 'cv' },
    { id: 'b_band2_gate',     type: 'gate', edge: 'gate' },
    { id: 'b_band2_trig',     type: 'gate', edge: 'trigger' },
    { id: 'b_band2_raster',   type: 'mono-video' },
    { id: 'b_band3_audio',    type: 'audio' },
    { id: 'b_band3_env_slow', type: 'cv' },
    { id: 'b_band3_env_fast', type: 'cv' },
    { id: 'b_band3_gate',     type: 'gate', edge: 'gate' },
    { id: 'b_band3_trig',     type: 'gate', edge: 'trigger' },
    { id: 'b_band3_raster',   type: 'mono-video' },
    { id: 'b_band4_audio',    type: 'audio' },
    { id: 'b_band4_env_slow', type: 'cv' },
    { id: 'b_band4_env_fast', type: 'cv' },
    { id: 'b_band4_gate',     type: 'gate', edge: 'gate' },
    { id: 'b_band4_trig',     type: 'gate', edge: 'trigger' },
    { id: 'b_band4_raster',   type: 'mono-video' },
  ],
  params: [
    // Per-copy MODE: 0 = AUDIO (spectral bands), 1 = VIDEO (R/G/B/Luma). Each
    // copy switches independently. Discrete 0/1 (a toggle on the card).
    //
    // ⚠ THE `options` ROSTER IS NOT DECORATION — it is what makes the DOCK cell
    // a NAMED two-state control instead of an unnamed switch. `paramCellKind`
    // (shell-control-kind.ts:312-316) tests `p.options?.length` BEFORE
    // `looksLikeToggle`, so without a roster this resolves to a bare `toggle`
    // whose two positions carry no words at all — and this module has printed
    // `AUDIO` / `VIDEO` on its own button since it shipped
    // (SynesthesiaCard.svelte:233). The labels below are THAT string, verbatim,
    // and the same pair the def's own `docs.controls` and the worklet header
    // (packages/dsp/src/synesthesia.ts:30) use. An option NAME is permitted
    // resting text precisely because it disambiguates a control's own position.
    //
    // ⚠ NO `optionsExhaustive`. The roster is DENSE (one option per discrete
    // step of a 0..1 param), which `param-vocabulary` treats as redundant.
    { id: 'a_mode', label: 'A Mode', defaultValue: 0, min: 0, max: 1, curve: 'discrete',
      options: [
        { value: 0, label: 'AUDIO', title: 'analyse the audio input into 4 spectral bands' },
        { value: 1, label: 'VIDEO', title: 'the 4 lanes become R / G / B / Luma of the patched frame' },
      ] },
    { id: 'b_mode', label: 'B Mode', defaultValue: 0, min: 0, max: 1, curve: 'discrete',
      options: [
        { value: 0, label: 'AUDIO', title: 'analyse the audio input into 4 spectral bands' },
        { value: 1, label: 'VIDEO', title: 'the 4 lanes become R / G / B / Luma of the patched frame' },
      ] },
    // Per-copy POLARITY of the env CV outputs: 0 = UNIPOLAR [0,1] (default,
    // preserves existing patches), 1 = BIPOLAR [-1,+1]. Bipolar makes a strong
    // kick sweep the FULL destination range through the knob-centered cv→video
    // bridge instead of just the upper half. Discrete 0/1 (a toggle on the card).
    // Roster: the card's own button strings (SynesthesiaCard.svelte:242).
    { id: 'a_bipolar', label: 'A Polarity', defaultValue: 0, min: 0, max: 1, curve: 'discrete',
      options: [
        { value: 0, label: 'UNI', title: 'unipolar env CV — 0..1' },
        { value: 1, label: 'BI', title: 'bipolar env CV — −1..+1, so an onset sweeps a destination’s full range' },
      ] },
    { id: 'b_bipolar', label: 'B Polarity', defaultValue: 0, min: 0, max: 1, curve: 'discrete',
      options: [
        { value: 0, label: 'UNI', title: 'unipolar env CV — 0..1' },
        { value: 1, label: 'BI', title: 'bipolar env CV — −1..+1, so an onset sweeps a destination’s full range' },
      ] },
    // Master gain: 0.5×@7:00 → 1.5×@5:00 (unity at 12:00) — raises/lowers floor.
    { id: 'a_master', label: 'A Mas', defaultValue: 1, min: 0.5, max: 1.5, curve: 'linear' },
    { id: 'b_master', label: 'B Mas', defaultValue: 1, min: 0.5, max: 1.5, curve: 'linear' },
    // Per-band gain: 1×@7:00 → 2×@5:00.
    { id: 'a_gain1', label: 'A1', defaultValue: 1, min: 1, max: 2, curve: 'linear' },
    { id: 'a_gain2', label: 'A2', defaultValue: 1, min: 1, max: 2, curve: 'linear' },
    { id: 'a_gain3', label: 'A3', defaultValue: 1, min: 1, max: 2, curve: 'linear' },
    { id: 'a_gain4', label: 'A4', defaultValue: 1, min: 1, max: 2, curve: 'linear' },
    { id: 'b_gain1', label: 'B1', defaultValue: 1, min: 1, max: 2, curve: 'linear' },
    { id: 'b_gain2', label: 'B2', defaultValue: 1, min: 1, max: 2, curve: 'linear' },
    { id: 'b_gain3', label: 'B3', defaultValue: 1, min: 1, max: 2, curve: 'linear' },
    { id: 'b_gain4', label: 'B4', defaultValue: 1, min: 1, max: 2, curve: 'linear' },
    // Per-band ENV-OUTPUT DEPTH (8 = 2 copies × 4 bands). Each knob scales BOTH
    // env CV outputs (env_slow + env_fast) for that copy/band — the source-side
    // modulation-depth control. 0×@7:00 (silenced) → 2×@5:00 (doubled, clamped
    // to the 0..1 CV ceiling); default 1.0 (unity) at 12:00 = unchanged.
    { id: 'a_envdepth1', label: 'a1 dpt', defaultValue: 1, min: 0, max: 2, curve: 'linear' },
    { id: 'a_envdepth2', label: 'a2 dpt', defaultValue: 1, min: 0, max: 2, curve: 'linear' },
    { id: 'a_envdepth3', label: 'a3 dpt', defaultValue: 1, min: 0, max: 2, curve: 'linear' },
    { id: 'a_envdepth4', label: 'a4 dpt', defaultValue: 1, min: 0, max: 2, curve: 'linear' },
    { id: 'b_envdepth1', label: 'b1 dpt', defaultValue: 1, min: 0, max: 2, curve: 'linear' },
    { id: 'b_envdepth2', label: 'b2 dpt', defaultValue: 1, min: 0, max: 2, curve: 'linear' },
    { id: 'b_envdepth3', label: 'b3 dpt', defaultValue: 1, min: 0, max: 2, curve: 'linear' },
    { id: 'b_envdepth4', label: 'b4 dpt', defaultValue: 1, min: 0, max: 2, curve: 'linear' },
  ],

  // ── FACE (PF-20) ──────────────────────────────────────────────────────────
  //
  // WHAT IT IS FOR, MUSICALLY: SYNESTHESIA is the rack's LISTENER. Every other
  // modulation source in the box decides on its own what to do — an LFO runs, an
  // envelope answers a gate. This one has no opinion at all: it takes a signal
  // you are ALREADY making, splits it four ways, and hands back four independent
  // streams of "how loud is this part of it right now". The verb a player
  // performs is BALANCE — deciding which quarter of the spectrum drives the
  // patch, and how hard. And it does that twice, on two copies that share
  // nothing but a box, so one rack can listen to the kick and the pads at once.
  //
  // ⚠ RANKED BY COPY, NOT INTERLEAVED — the scope argument, and it is the one
  // rank on this face worth defending. The obvious alternative reads better as a
  // TABLE (`a_master, b_master, a_gain1, b_gain1, …`) and worse as an
  // INSTRUMENT: a player working on SYNESTHESIA is listening to ONE source
  // through ONE copy, and interleaving makes every adjustment a two-column hunt.
  // Copy A is ranked whole, then copy B is ranked whole.
  //
  // Within a copy the rank descends the DSP, not the declaration order:
  //   1. `master` — the ONLY control that moves all four of that copy's bands at
  //      once, so it is the highest-leverage knob on the copy by construction.
  //   2. `mode`   — AUDIO vs VIDEO decides what the four lanes MEAN; every
  //      control below it is interpreted through that choice, and it is the one
  //      switch a lane tile can usefully carry.
  //   3. the four band GAINS — the balance you actually ride.
  //   4. the four env DEPTHS — downstream of the analysis; they scale what the
  //      module SENDS, not what it hears.
  //   5. `bipolar` — a patching CONVENTION set once for the destination you are
  //      driving and then left alone (the `ch1Range` shape on scope).
  //
  // Read back as a sentence: the LANE tile is copy A's trim, its AUDIO/VIDEO
  // switch and its bass band (compact = 3 cells, no glyph); the full-in-lane
  // plate adds copy A's other three bands; everything from copy A's depths
  // onward is DOCK-ONLY. Copy B never reaches a lane tier, which is honest — a
  // rack that patches both copies is working in the dock anyway.
  //
  // ⚠ `pages` DISAGREES WITH `order` ON PURPOSE. `order` is priority (copy A
  // entirely, then copy B); `pages` is SIGNAL ORDER, so each band holds the same
  // stage of BOTH copies with the copies as CLUSTERS. That is the field's own
  // worked example — two copies of one circuit are "the same idea, twice", which
  // is a ~14 px sub-header, not a ~81 px band each. Eight per-copy bands would
  // have been padding, and `clusterFlow: 'row'` sets the two copies side by side
  // so the whole face is four rows instead of eight.
  //
  // ⚠ NO TAB RAIL, and the count is not the reason — the ARGUMENT is.
  // `DOCK_TAB_MIN_BANDS` is 7 and this is 3, but the owner's control-heavy
  // ruling is about "lots of controls of DIFFERENT types", and 22 params here
  // are FOUR types (two named two-state switches, two masters, eight gains,
  // eight depths) laid out in perfect A/B symmetry. This is control-REPETITIVE,
  // the mixmstrs shape, not the backdraft shape — and the ruling's own words are
  // *never pad pages to force the rail*.
  //
  // ⚠ NO `bareCells`. Every caption here is the tidyVco side of that ruling, not
  // the mixmstrs side: `A1`…`A4` under a `copy a` cluster are the ONLY thing
  // separating four otherwise-identical dials, and hiding them would leave a row
  // of anonymous knobs. The clusters carry the copy; the captions carry the band.
  //
  // ⚠ NO HERO. `heroFacePlan` MOVES a promoted key out of its band, and there is
  // no picture here to promote: this module's picture is the VU wall, which is
  // not a `panel` CELL at all (nothing on it is editable) but the module's own
  // full-width surface — see `extension` below.
  face: {
    order: COPIES.flatMap((c) => [
      `${c}_master`,
      `${c}_mode`,
      ...BANDS.map((b) => `${c}_gain${b}`),
      ...BANDS.map((b) => `${c}_envdepth${b}`),
      `${c}_bipolar`,
    ]),

    pages: [
      {
        id: 'input',
        label: 'input',
        hint: 'what each copy is listening to, and how hard it is driven',
        controls: COPIES.flatMap((c) => [`${c}_mode`, `${c}_master`]),
        clusters: COPIES.map((c) => ({
          label: `copy ${c}`,
          controls: [`${c}_mode`, `${c}_master`],
        })),
        clusterFlow: 'row',
      },
      {
        id: 'bands',
        label: 'band gain',
        hint: 'balance the four bands against each other before they are followed',
        controls: COPIES.flatMap((c) => BANDS.map((b) => `${c}_gain${b}`)),
        clusters: COPIES.map((c) => ({
          label: `copy ${c}`,
          controls: BANDS.map((b) => `${c}_gain${b}`),
        })),
        clusterFlow: 'row',
      },
      {
        id: 'env',
        label: 'env out',
        hint: 'how much modulation each band sends',
        controls: COPIES.flatMap((c) => BANDS.map((b) => `${c}_envdepth${b}`)),
        clusters: COPIES.map((c) => ({
          label: `copy ${c}`,
          controls: BANDS.map((b) => `${c}_envdepth${b}`),
        })),
        clusterFlow: 'row',
      },
      // ⚠ POLARITY IS ITS OWN BAND, AND A MEASUREMENT PUT IT THERE.
      //
      // It was first authored INSIDE the `env out` clusters, on a real argument:
      // it is a statement about the SAME two cables DEPTH scales, and scope
      // reached exactly that conclusion about `ch1Range` and put it inside the
      // CH1 cluster. The dock scene's width assertion falsified the arrangement,
      // not the argument.
      //
      // MEASURED on the faceplate (linux CI and reproduced locally, identical
      // numbers): content 591 CSS px, `.faceplate-body` 686 — 95 px of empty
      // plate against a 40 px ceiling. Ablated in the live DOM, one element at a
      // time: hiding the VU wall, the title row, the badge row, the `input` band
      // or the `band gain` band moved the body NOT AT ALL (686 every time);
      // hiding the `env out` band dropped it to 537; and hiding JUST ITS TWO
      // SEGMENTED CELLS dropped it to 537 as well. So the two POLARITY cells
      // sitting in a cluster of four knobs were the entire 149 px, while drawing
      // 70 px each.
      //
      // A four-knob cluster and a segmented cell are different cell SHAPES, and
      // a cluster is for the same idea TWICE — four band depths are that, a
      // polarity switch is not. Splitting it out costs one ~81 px band and buys
      // back 95 px of width the owner ruling calls useless grey space; it also
      // leaves `env out` the identical shape as `band gain`, which measures 537.
      // Still four bands, still under `DOCK_TAB_MIN_BANDS`, still signal-ordered:
      // in → balance the bands → how much they send → in which polarity.
      {
        id: 'polarity',
        label: 'cv polarity',
        hint: 'the convention the env CV outputs follow — set once for the destination',
        controls: COPIES.map((c) => `${c}_bipolar`),
        clusters: COPIES.map((c) => ({
          label: `copy ${c}`,
          controls: [`${c}_bipolar`],
        })),
        clusterFlow: 'row',
      },
    ],

    // ⚠ `'none'` — AND IT IS REFUSED FOR SCOPE'S REASON, NOT DOCKSCOPE'S.
    //
    // dockscope declares `outputs: []`, so `primaryAudioOutPortId` returns null,
    // every glyph literal falls to `{kind:'static'}` and the dead-glyph clause
    // catches it. That refusal is MECHANICAL — a gate makes it for you.
    //
    // SYNESTHESIA HAS NO SUCH PROTECTION. `a_band1_audio` is the FIRST declared
    // `type: 'audio'` output on this def, so `primaryAudioOutPortId` returns it
    // and `glyphBinding` short-circuits to
    // `{ kind: 'live-audio', portId: 'a_band1_audio' }` — LIVE, green on the
    // dead-glyph clause, green on `VALID_GLYPHS`, red nowhere. And the picture
    // would still be false, in the way that matters most on THIS module: that
    // port is copy A's BASS band and nothing else. A trace on it is invariant to
    // the other three bands, to copy B entirely (half the instrument), to both
    // envelope stages, to every depth, to both polarities and to VIDEO mode.
    // This module's entire product is the COMPARISON ACROSS BANDS; a
    // single-band waveform is exactly the picture a player would read as "the
    // analysis", so it would not fail to inform — it would MISINFORM.
    //
    // ⚠ A `'meter'` LITERAL DOES NOT RESCUE IT. `glyphBinding` never looks at
    // which literal was written once a primary audio out exists (the
    // `if (audioOut) return live-audio` short-circuit at shell-glyph-live.ts:184
    // catches 'scope', 'meter' and 'waveform' alike), so `'meter'` resolves to
    // the SAME single-band tap and renders it as one RMS bar instead of four
    // columns — strictly less of the picture, not more.
    //
    // ⚠ AND `'algorithm'` IS NOT THE ESCAPE EITHER. The #2160 widening resolves
    // an extension arm ahead of that short-circuit, so this def COULD legally
    // declare a layout-source glyph — but `ShellExtensionGlyphProps` is
    // `{ num, numbers?, testid? }`, with no `nodeId`, no engine and no store, so
    // every instance would draw a byte-identical SVG that cannot vary per node
    // or over time. The widening removed the refusal; it did not add a data path.
    //
    // The lane consequence is stated rather than discovered: with `'none'` and a
    // dock-only body, SYNESTHESIA's lane tile paints its three ranked cells and
    // no picture at all — and, because `laneGlyphFor` reads 'none', that tile
    // gets THREE cells rather than the two a glyph-bearing face would.
    glyph: 'none',

    // ⚠ THE VU WALL IS WHY THIS PROMOTION IS SAFE AT ALL, and it arrives here.
    //
    // Promotion stops BOTH surfaces rendering `SynesthesiaCard.svelte`, and that
    // card owns the two 10-bar-per-band VU meters — the only place the analysis
    // is VISIBLE. `synesthesia` is already in `CARD_PRODUCER_LANE_TYPES`
    // (dom-source-modules.ts:208), so the headless host keeps the real card
    // mounted OFF-SCREEN and the engine-side work (the VIDEO-mode
    // `write(node,'video_levels_a'/'_b')` pump) survives promotion untouched.
    // But off-screen is not on screen: without this slot a faced SYNESTHESIA
    // would be twenty-two ways to adjust an analysis nobody can see.
    //
    // The samples are reachable through exactly ONE seam — the engine handle's
    // `read('snapshot')` key — and no glyph binding calls `engine.read`. A
    // `fullViewBody` is the wired slot that can. `$lib/ui/modules/synesthesia/
    // shell-extension.ts` is that, and it draws through `drawVuMeters`, this
    // module's OWN pure function, which is what stops the card and the faceplate
    // from ever disagreeing about what the meters look like.
    extension: 'synesthesia',

    // ⚠ OUTPUTS GROUPED BY COPY — a split that MEANS something, which is the bar
    // for authoring one at all. The derived default splits the 48 output jacks
    // by CABLE DOMAIN (audio / cv / gate / mono-video), and that restates
    // information the rail already carries in colour. The split that is NOT
    // already on screen is which COPY a jack belongs to: A and B are two
    // independent instruments that share only a chassis, and patching the wrong
    // one is the mistake this rail can actually prevent. It is also PARITY —
    // `SynesthesiaCard`'s own PatchPanel has always sectioned its jacks
    // `Copy A` / `Copy B` (SynesthesiaCard.svelte:77-80).
    //
    // ⚠ `direction: 'output'` ON BOTH, and it is load-bearing: the field
    // DEFAULTS to `'input'`, and an output group that forgets it resolves to no
    // port at all and silently never renders.
    //
    // ⚠ THE INPUTS ARE DELIBERATELY NOT AUTHORED. All four (`a_in`, `b_in`,
    // `a_video_in`, `b_video_in`) carry no `paramTarget`, so the derived rule
    // files them into the leading `signal` band together — four jacks, one
    // section, already right. Declaring a curated INPUT group here would have to
    // claim `'voice'`/`'signal'` or name a page id to reach a slot at all, and
    // splitting four jacks two ways buys nothing.
    rear: {
      groups: COPIES.map((c) => ({
        id: `copy-${c}`,
        label: `copy ${c}`,
        direction: 'output' as const,
        ports: BANDS.flatMap((b) => [
          `${c}_band${b}_audio`,
          `${c}_band${b}_env_slow`,
          `${c}_band${b}_env_fast`,
          `${c}_band${b}_gate`,
          `${c}_band${b}_trig`,
          `${c}_band${b}_raster`,
        ]),
      })),
    },
  },

  docs: (() => {
    const BAND_NAMES: Record<number, string> = {
      1: 'bass (20–200 Hz)',
      2: 'low-mid (200 Hz–1 kHz)',
      3: 'high-mid (1–4 kHz)',
      4: 'treble (4 kHz+)',
    };
    const outputs: Record<string, string> = {};
    const controls: Record<string, string> = {};
    for (const c of COPIES) {
      const C = c.toUpperCase();
      controls[`${c}_mode`] = `Copy ${C} MODE — AUDIO (analyse the audio input into 4 spectral bands) vs VIDEO (the 4 lanes become R / G / B / Luma of the patched ${c}_video_in frame, sampled surface-side). Toggle on the faceplate.`;
      controls[`${c}_bipolar`] = `Copy ${C} env POLARITY — UNIPOLAR (env CV outputs run 0..1, the default) vs BIPOLAR (−1..+1, so a strong onset sweeps a destination's FULL range through a knob-centred CV→video bridge). Toggle on the faceplate.`;
      controls[`${c}_master`] = `Copy ${C} MASTER gain (0.5×..1.5×, unity at noon) — raises or lowers the floor of all four of copy ${C}'s bands together.`;
      for (const b of BANDS) {
        controls[`${c}_gain${b}`] = `Copy ${C} band ${b} GAIN (1×..2×) — boosts the ${BAND_NAMES[b]} band's level for copy ${C} (affects its audio tap + how hard it drives the envelopes/gate/meter).`;
        controls[`${c}_envdepth${b}`] = `Copy ${C} band ${b} ENV DEPTH (0×..2×, unity at noon) — scales BOTH env CV outputs (slow + fast) for copy ${C}'s ${BAND_NAMES[b]} band; 0 silences that band's modulation, 2 doubles it (clamped to the CV ceiling).`;
        outputs[`${c}_band${b}_audio`] = `Copy ${C} band ${b} AUDIO — the isolated ${BAND_NAMES[b]} band of copy ${C}'s input (post gain). Patch it as a band-split audio signal.`;
        outputs[`${c}_band${b}_env_slow`] = `Copy ${C} band ${b} SLOW envelope CV — a ~500 ms envelope-follower tracking the ${BAND_NAMES[b]} band's level; smooth modulation that rides the band's overall energy. Polarity set by copy ${C}'s POLARITY.`;
        outputs[`${c}_band${b}_env_fast`] = `Copy ${C} band ${b} FAST envelope CV — a ~50 ms envelope-follower on the ${BAND_NAMES[b]} band; snappier modulation that tracks transients. Polarity set by copy ${C}'s POLARITY.`;
        outputs[`${c}_band${b}_gate`] = `Copy ${C} band ${b} GATE — goes high while the ${BAND_NAMES[b]} band's level is above a hysteresis threshold and low when it falls below; a level-sensitive gate that follows energy in that band.`;
        outputs[`${c}_band${b}_trig`] = `Copy ${C} band ${b} TRIGGER — a short ~10 ms pulse on each spectral-flux onset (beat) detected in the ${BAND_NAMES[b]} band (LZX-Sensory-Translator style). Patch into envelopes/drum voices to fire on that band's hits.`;
        outputs[`${c}_band${b}_raster`] = `Copy ${C} band ${b} RASTER — a mono-video output painting the ${BAND_NAMES[b]} band's live waveform as a raster (audio→video), for patching into video destinations.`;
      }
    }
    return {
      explanation:
        "SYNESTHESIA is a dual 4-band audio analyser + envelope/gate/trigger generator — an audio-reactive modulation source. It holds TWO independent copies (A and B); each takes a mono input and splits it into four MUSICAL bands (bass / low-mid / high-mid / treble). For every band of every copy it emits a rich fan of outputs: the isolated band audio, a SLOW (~500 ms) and a FAST (~50 ms) envelope-follower CV, a hysteresis GATE that opens while the band is loud, a beat TRIGGER fired on each spectral-flux onset in that band, and a mono-video RASTER of the band's waveform — 4 bands × 6 kinds × 2 copies = 48 outputs. Each copy can instead run in VIDEO mode, where the 4 lanes become R/G/B/Luma of a patched video frame (sampled surface-side) and flow through the same envelope/gate/meter stage. Per-band GAIN, per-copy MASTER, an env-output DEPTH per band, and a UNIPOLAR/BIPOLAR polarity switch shape the modulation; a 10-bar VU meter per band is drawn on the faceplate.",
      inputs: {
        a_in: 'Copy A audio input — the mono signal copy A splits into its 4 spectral bands (in AUDIO mode).',
        b_in: 'Copy B audio input — the mono signal copy B splits into its 4 spectral bands (in AUDIO mode).',
        a_video_in: "Copy A video input — used only when copy A is in VIDEO mode: the module reads this frame's pixels, averages them to R/G/B/Luma levels, and feeds those through copy A's 4 lanes (the frame handoff happens surface-side, not as an audio edge).",
        b_video_in: 'Copy B video input — the VIDEO-mode frame source for copy B (same surface-side handoff as copy A).',
      },
      outputs,
      controls,
    };
  })(),

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = createWorkletNode(node, ctx, 'synesthesia', {
      numberOfInputs: 2,
      numberOfOutputs: 10, // +2: per-band beat-trigger streams (trig A / trig B)
      outputChannelCount: [4, 4, 4, 4, 4, 4, 4, 4, 4, 4],
    });

    // Keep-alive: an AudioWorkletNode only runs process() while it has a path
    // to ctx.destination. SYNESTHESIA is an analyser — its outputs are often
    // unpatched — so without this the worklet would never process: no VU
    // levels, envelopes, gates, OR per-band beat triggers (the DOOM
    // audio_l/audio_r orphan-silent class of bug; same fix samsloop's record
    // tap uses). connect() with no output index pulls worklet output 0, which
    // keeps the WHOLE processor (all 10 outputs incl. the new trig 8/9)
    // running every quantum even while their fan-out ports sit unpatched.
    // Route through a muted gain so it always runs but is inaudible.
    const keepAlive = ctx.createGain();
    keepAlive.gain.value = 0;
    workletNode.connect(keepAlive);
    keepAlive.connect(ctx.destination);

    const splitters: ChannelSplitterNode[] = [];
    const outGains: GainNode[] = [];
    const rasterAnalysers: AnalyserNode[] = [];
    const outputs = new Map<string, { node: AudioNode; output: number }>();
    const videoSources = new Map<
      string,
      { analyser: AnalyserNode; sampleRate: number; drawFrame: (c: OffscreenCanvas | HTMLCanvasElement) => void }
    >();

    // Fan each 4-channel worklet output into 4 mono GainNodes (one per band).
    // For the two AUDIO streams (copy A / B) we ALSO tap each band into an
    // analyser feeding a per-band mono-video "rasterize" output (audio→video).
    for (const stream of OUT_STREAMS) {
      const splitter = ctx.createChannelSplitter(4);
      workletNode.connect(splitter, stream.outIndex, 0);
      splitters.push(splitter);
      for (let b = 0; b < BANDS.length; b++) {
        const g = ctx.createGain();
        g.gain.value = 1;
        splitter.connect(g, b, 0);
        outGains.push(g);
        outputs.set(`${stream.copy}_band${b + 1}_${stream.kind}`, { node: g, output: 0 });

        if (stream.kind === 'audio') {
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 2048;
          analyser.smoothingTimeConstant = 0;
          g.connect(analyser);
          // Route the analyser through the muted keep-alive so it stays pulled
          // (and keeps filling) even when the raster output isn't patched.
          analyser.connect(keepAlive);
          rasterAnalysers.push(analyser);
          const buf = new Float32Array(analyser.fftSize);
          const bandIdx = b; // 0..3, captured per band for the deterministic seam
          const drawFrame = (canvas: OffscreenCanvas | HTMLCanvasElement): void => {
            const c2d = canvas.getContext('2d') as
              | CanvasRenderingContext2D
              | OffscreenCanvasRenderingContext2D
              | null;
            if (!c2d) return;
            // DRS seam: under __synesthesiaVrtFreeze paint a FIXED synthetic
            // waveform (deterministic raster); otherwise the LIVE analyser window.
            if (synesthesiaVrtFrozen()) fillFrozenBand(buf, bandIdx);
            else analyser.getFloatTimeDomainData(buf);
            drawBandRaster(c2d, buf, canvas.width, canvas.height);
          };
          videoSources.set(`${stream.copy}_band${b + 1}_raster`, {
            analyser,
            sampleRate: ctx.sampleRate,
            drawFrame,
          });
        }
      }
    }

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    const nodeParams = node.params ?? {};
    for (const name of Object.keys(PARAM_DEFAULTS)) {
      params.get(name)?.setValueAtTime(nodeParams[name] ?? PARAM_DEFAULTS[name]!, ctx.currentTime);
    }

    // ---- VU snapshot pipe ----
    let levelsA: number[] = [0, 0, 0, 0];
    let levelsB: number[] = [0, 0, 0, 0];
    workletNode.port.onmessage = (e: MessageEvent) => {
      const m = e.data as { type?: string; levelsA?: Float32Array; levelsB?: Float32Array } | undefined;
      if (!m || m.type !== 'snapshot') return;
      if (m.levelsA) levelsA = Array.from(m.levelsA);
      if (m.levelsB) levelsB = Array.from(m.levelsB);
    };

    const inputs = new Map<string, { node: AudioNode; input: number; param?: AudioParam }>();
    inputs.set('a_in', { node: workletNode, input: 0 });
    inputs.set('b_in', { node: workletNode, input: 1 });

    return {
      domain: 'audio',
      inputs,
      outputs,
      videoSources,
      setParam(paramId, value) {
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      read(key) {
        if (key === 'snapshot') return { levelsA, levelsB } satisfies SynesthesiaSnapshot;
        return undefined;
      },
      // VIDEO mode: the card reads the patched frame's pixels, computes the
      // R/G/B/Luma channel levels, and writes them here each video frame. We
      // forward to the worklet, which sample-and-holds them across the quantum.
      // Keys: 'video_levels_a' / 'video_levels_b'; value is a length-4 array.
      write(key, value) {
        const copy = key === 'video_levels_b' ? 'b' : key === 'video_levels_a' ? 'a' : null;
        if (!copy || !Array.isArray(value)) return;
        try {
          workletNode.port.postMessage({ type: 'video', copy, levels: value as number[] });
        } catch {
          /* port may be closed during teardown */
        }
      },
      dispose() {
        try { workletNode.port.onmessage = null; } catch { /* ignore */ }
        for (const g of outGains) g.disconnect();
        for (const a of rasterAnalysers) a.disconnect();
        for (const s of splitters) s.disconnect();
        keepAlive.disconnect();
        workletNode.disconnect();
      },
    };
  },
};

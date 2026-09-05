// packages/web/src/lib/audio/modules/twotracks.ts
//
// TWOTRACKS — two-reel tape loop emulator: two independent decks in one box,
// mixed to a stereo output. Live waveform + WAV export.
//
// ⚠ THIS HEADER IS PROSE AND PROSE DRIFTS. The authoritative roster is the
// `params` / `inputs` / `outputs` arrays below and the `docs` block beside them
// (which `contract-lock.txt` pins). An earlier version of this header listed
// `decay_a` — a param that has never existed anywhere in the tree — and called
// the filter "HP/LP/BP", three modes in the wrong order with no `off`, against
// the four the param actually has. Two prose records of one roster were free to
// disagree because NEITHER was the source; the filter roster is now an exported
// symbol (`TWOTRACKS_FILTER_MODES`) that the def and the UI both import.
//
// Per reel (suffix `_a` / `_b`):
//   inputs:  audio_l_in, audio_r_in (stereo record path), rec_start, rec_arm,
//            overdub (gates), rate_cv
//   params:  rate (varispeed −3..+3), mode (one-shot/loop), echoes, start, end
//            (the loop window), overdub_flag, eqLow/eqMid/eqHigh,
//            filterMode/cutoff/reso
// Global params: ab (crossfade), a2b / b2a (cross-feed), lofi, monitor
// Outputs: out_l, out_r
//
// Single worklet node handles both reels.
// Playhead messages: { type:'playhead', reel:'a'|'b', pos:0..1, state }
// ⚠ The playhead is TRANSIENT ENGINE STATE, deliberately: it is read through
// `engine.read(node,'playheadA')` per frame and is neither a param nor a
// `node.data` key. See the note on `TwoTracksData` below.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { patch as livePatch } from '$lib/graph/store';
import workletUrl from '@patchtogether.live/dsp/dist/twotracks.js?url';

import { createWorkletNode } from '$lib/audio/worklet-guard';
// Loop start/end clamp helpers live in the worklet's pure engine (the code the
// worklet actually runs) and are re-exported here so the card + its unit tests
// share ONE import surface for the scrubber math. clampLoopStart/End enforce the
// "can't drag a handle past the playhead while rolling" rule.
// Relative path (not the package alias) — svelte-check only resolves TS source
// out of node_modules/@patchtogether.live/dsp via the dist build; the cube.ts /
// sample-hold.ts engines re-export the same way.
export { clampLoopStart, clampLoopEnd, MIN_LOOP_GAP } from '../../../../../dsp/src/lib/twotracks-engine';

const loadedContexts = new WeakSet<BaseAudioContext>();

/** Maximum tape buffer length in samples — the fixed physical "blank tape"
 *  length (≈20 s at 48 kHz). Recording fills this left→right; the card draws the
 *  whole tape and the recorded region grows into it. Sized for a usable
 *  loop/echo length while keeping per-instance memory + the live peaks scan
 *  cheap (≈3.7 MB/reel stereo). */
export const TWOTRACKS_MAX_SAMPLES = 960_000;

/** How often to poll node.data for param changes (ms). */
const POLL_MS = 100;

/**
 * THE FILTER ROSTER — ONE source, imported by the def's `options` below and by
 * every surface that names a mode. Never re-type these strings.
 *
 * ⚠ READ THE ORDER OFF THE DSP, NOT OFF PROSE. Three records of this roster
 * existed and they contradicted each other:
 *   * this file's header said "HP/LP/BP" — right order, but no `off`;
 *   * the `docs` string said "off / low-pass / high-pass / band-pass" — it has
 *     the `off`, and it has modes 1 and 2 THE WRONG WAY ROUND;
 *   * `packages/dsp/src/twotracks.ts` — which is the code that runs — steps the
 *     SVF and selects `taps.hp` at 1, `taps.lp` at 2, `taps.bp` at 3
 *     (`:746-756`), bypassing at 0.
 * The DSP is the consumer, so the DSP decides, and the doc string has been
 * corrected to match it. This mattered the moment the roster became VISIBLE: the
 * card's nameless modulo-4 cycle button could not be wrong about a name it never
 * painted, but a segmented control built from the doc string would have labelled
 * the high-pass "LP" on every faceplate.
 *
 * Cosmetic for the contract (`contract-lock` records id/min/max/curve/default/
 * units and nothing else), so naming these moves no contract line.
 */
export const TWOTRACKS_FILTER_MODES = [
  { value: 0, label: 'OFF', title: 'Filter bypassed — the tape plays through untouched' },
  { value: 1, label: 'HP', title: 'High-pass — keeps the highs, rolls off below CUTOFF' },
  { value: 2, label: 'LP', title: 'Low-pass — keeps the lows, rolls off above CUTOFF' },
  { value: 3, label: 'BP', title: 'Band-pass — keeps a band around CUTOFF, rolls off either side' },
] as const;

/**
 * THE LOFI ROSTER — same argument, second instance. The card carried these four
 * names as a private `LOFI_LABELS` array in its own markup, so the def could not
 * see them and no other surface could reuse them: the exact shape of the
 * card-disagrees-with-its-def class. Now the def declares them and the card
 * imports this.
 */
export const TWOTRACKS_LOFI_MODES = [
  { value: 0, label: 'OFF', title: 'Clean — no tape degradation' },
  { value: 1, label: 'LOW', title: 'Gentle wow/flutter and grit' },
  { value: 2, label: 'HIGH', title: 'Heavy degradation' },
  { value: 3, label: 'ERROR', title: 'Broken-transport extreme — the tape is falling apart' },
] as const;

export interface TwoTracksData {
  /** Reel A transport state (posted from worklet). */
  transportState_a?: 'idle' | 'play' | 'armed' | 'rec' | 'overdub';
  /** Reel B transport state (posted from worklet). */
  transportState_b?: 'idle' | 'play' | 'armed' | 'rec' | 'overdub';
  /** How many samples reel A's ring buffer holds (for duration display + SAVE enabled). */
  bufLenA?: number;
  /** How many samples reel B's ring buffer holds. */
  bufLenB?: number;
  /** Faceplate SCREEN switch: is the reel picture collapsed? Fleet-standard key
   *  (`previewCollapsed`), on `node.data` rather than component `$state` so it
   *  survives the card/face unmount that a dock LRU eviction or a tab flip
   *  causes, and so a saved rack re-opens the way it was left. */
  previewCollapsed?: boolean;
}

// ⚠ THERE IS DELIBERATELY NO `playhead_a` / `playhead_b` HERE, and there is no
// `playhead_*` PARAM either. Both once existed and NEITHER was ever written or
// read: the message handler below routes `msg.pos` to a module-scope volatile
// (`localPlayheadA`) which the UI polls through `engine.read(node,'playheadA')`,
// and the handler's own comment says ONLY transport state + bufLen reach the
// Y.Doc. The param pair additionally sat in the PUBLIC CONTRACT
// (`contract-lock.txt`) describing a control no surface has ever offered.
//
// Keep it that way. The playhead moves at frame rate, so a param would put it on
// the undo stack and in the Y.Doc every frame — the CV-modulation write-storm
// class this repo has a standing rule against. The scrub gesture is an engine
// message (`{type:'seek'}`), which is the correct seam for a transient
// performance gesture, and the loop markers are params because they are a
// durable setting. That split is the point.

// NOTE: the tape transport math (record-window span, varispeed record/advance,
// playhead, ECHOES→decay) lives in the worklet's pure engine
// (packages/dsp/src/lib/twotracks-engine.ts) and is unit-tested there against
// synthetic audio — that's the code the worklet actually runs. This module only
// owns wiring + the A/B gain law (used by the card).

// ---------------------------------------------------------------------------
// Tape persistence codec (pure) — perf-zip round-trip of recorded reel audio.
// ---------------------------------------------------------------------------
//
// The reel ring buffers are worklet-owned Float32 (NOT on node.data — a
// ~7.7 MB/reel typed array can't ride the Y.Doc envelope). For the portable
// .zip we dump them, encode to compact 16-bit interleaved-stereo PCM (halves
// the byte count), bundle the bytes out-of-band as an 'audio' media entry, and
// on load decode + re-send via the worklet's `load-tape`. Pure functions so the
// round-trip is unit-tested without a worklet.

/** Encode a reel's L/R Float32 tape (the recorded [0,bufLen) portion) to 16-bit
 *  interleaved-stereo PCM bytes for the .zip. Returns an empty array for an
 *  empty take. */
export function encodeTapeBytes(bufL: Float32Array, bufR: Float32Array, bufLen: number): Uint8Array {
  const n = Math.max(0, Math.min(bufLen | 0, bufL.length, bufR.length));
  if (n === 0) return new Uint8Array(0);
  const out = new Uint8Array(n * 4); // 2 ch × 2 bytes
  const view = new DataView(out.buffer);
  let off = 0;
  for (let i = 0; i < n; i++) {
    const l = Math.max(-1, Math.min(1, bufL[i] ?? 0));
    const r = Math.max(-1, Math.min(1, bufR[i] ?? 0));
    view.setInt16(off, Math.round(l * 0x7fff), true); off += 2;
    view.setInt16(off, Math.round(r * 0x7fff), true); off += 2;
  }
  return out;
}

/** Decode 16-bit interleaved-stereo PCM tape bytes back to parallel L/R Float32
 *  buffers + the frame count, ready to re-send to the reel worklet. */
export function decodeTapeBytes(bytes: Uint8Array): { bufL: Float32Array; bufR: Float32Array; bufLen: number } {
  const frames = Math.floor(bytes.byteLength / 4);
  const bufL = new Float32Array(frames);
  const bufR = new Float32Array(frames);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 0;
  for (let i = 0; i < frames; i++) {
    bufL[i] = view.getInt16(off, true) / 0x7fff; off += 2;
    bufR[i] = view.getInt16(off, true) / 0x7fff; off += 2;
  }
  return { bufL, bufR, bufLen: frames };
}

/** Exported pure A/B gain law — used by the card and unit tests. */
export function abGains(ab: number): { gainA: number; gainB: number } {
  const t = ab < 0 ? 0 : ab > 1 ? 1 : ab;
  if (t <= 0.5) {
    return { gainA: 1.0, gainB: t * 2 };
  } else {
    return { gainA: (1 - t) * 2, gainB: 1.0 };
  }
}

/** Download a stereo WAV file from raw Float32Array buffers. */
function downloadWav(bufL: Float32Array, bufR: Float32Array, bufLen: number, label: string): void {
  const sr = 48000;
  const numChannels = 2;
  const bitsPerSample = 16;
  const numFrames = Math.min(bufLen, bufL.length, bufR.length);
  const byteRate = sr * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataBytes = numFrames * blockAlign;
  const ab = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(ab);
  const enc = new TextEncoder();
  const w4 = (offset: number, str: string) => {
    const bytes = enc.encode(str);
    for (let i = 0; i < 4; i++) view.setUint8(offset + i, bytes[i] ?? 0);
  };
  w4(0, 'RIFF'); view.setUint32(4, 36 + dataBytes, true);
  w4(8, 'WAVE'); w4(12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, numChannels, true);
  view.setUint32(24, sr, true); view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true); view.setUint16(34, bitsPerSample, true);
  w4(36, 'data'); view.setUint32(40, dataBytes, true);
  let off = 44;
  for (let i = 0; i < numFrames; i++) {
    view.setInt16(off, Math.round(Math.max(-1, Math.min(1, bufL[i] ?? 0)) * 0x7fff), true); off += 2;
    view.setInt16(off, Math.round(Math.max(-1, Math.min(1, bufR[i] ?? 0)) * 0x7fff), true); off += 2;
  }
  const blob = new Blob([ab], { type: 'audio/wav' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${label}-${Date.now()}.wav`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export const twotracksDef: AudioModuleDef = {
  type: 'twotracks',
  label: 'twotracks', // MUST be lowercase (card CSS uppercases for display)
  palette: { top: 'Audio modules', sub: 'VCOs' },
  domain: 'audio',
  category: 'effects',

  // Workflow channel-columns override (owner "fixable in code" directive):
  // TWOTRACKS is "too weird to be a source easily" — it has FOUR audio inputs
  // (reel A + reel B stereo pairs), so which pair is "the" insert input is
  // genuinely ambiguous to the default main-in resolution. Declare the insert
  // IN = reel A's stereo audio input and the chain OUT = the mixed A/B stereo
  // output. (This override is precedence 0 — it wins over the `stereoPairs`
  // branch below, which would otherwise resolve reel A by declaration order.
  // Same answer either way; the override is what pins it.) Role
  // 'both': dropped on an EMPTY column it acts as a source (out → mixer);
  // inserted UNDER a source (e.g. tidyvco) it takes tidyvco → reel-A-in and its
  // A-side out → downstream, exactly the owner's TWOTRACKS scenario.
  chainWiring: {
    role: 'both',
    inPorts: ['audio_l_in_a', 'audio_r_in_a'],
    outPorts: ['out_l', 'out_r'],
  },

  // VARISPEED CV — one jack per reel, the tape-deck's speed control input.
  //
  // Both reels already ran their RATE knob through an **a-rate** AudioParam
  // (`rate` / `rate_b`, ±3, read per-SAMPLE by `processReel` as
  // `av(pRate, i, 1)` and handed straight to `advanceCursor`) — so the DSP
  // side of varispeed CV was already there and only the jack was missing.
  // That is why these route through the engine's CV→AudioParam fast path
  // (`paramTarget` + `cvScale`) rather than a new worklet node input: the
  // param the CV must move IS an AudioParam, at audio rate.
  //
  // `cvScale: { mode: 'linear' }` is REQUIRED, not decorative. RATE's natural
  // span is 6 units wide (−3..+3); Web Audio's default sum-into-AudioParam
  // would let a full-scale ±1 LFO command only a 2-unit swing — 33 % of the
  // control — and from the default knob (1) it would never reach EITHER end.
  // With the hint, `attachCvScale` interposes a WaveShaper whose curve is
  // cv → (clamp(knob + cv·3, −3, 3) − knob), so ±1 commands the full 6-unit
  // span centred on the knob. This is exactly the declaration `wavetableVco`'s
  // WAVE POSITION omits, and the reason half a bipolar LFO is bit-exactly dead
  // there. Proof for both reels — both ends reached, plus the passthrough
  // negative control — lives in `twotracks-rate-cv.test.ts`.
  inputs: [
    // Reel A
    { id: 'audio_l_in_a', type: 'audio' },
    { id: 'audio_r_in_a', type: 'audio' },
    { id: 'rec_start_a',  type: 'gate', edge: 'trigger' },
    { id: 'rec_arm_a',    type: 'gate', edge: 'trigger' },
    { id: 'overdub_a',    type: 'gate', edge: 'trigger' },
    { id: 'rate_cv_a',    type: 'cv', paramTarget: 'rate_a', cvScale: { mode: 'linear' } },
    // Reel B
    { id: 'audio_l_in_b', type: 'audio' },
    { id: 'audio_r_in_b', type: 'audio' },
    { id: 'rec_start_b',  type: 'gate', edge: 'trigger' },
    { id: 'rec_arm_b',    type: 'gate', edge: 'trigger' },
    { id: 'overdub_b',    type: 'gate', edge: 'trigger' },
    { id: 'rate_cv_b',    type: 'cv', paramTarget: 'rate_b', cvScale: { mode: 'linear' } },
  ],

  outputs: [
    { id: 'out_l', type: 'audio' },
    { id: 'out_r', type: 'audio' },
  ],

  // The module's stereo topology, declared. THREE pairs: reel A's stereo input,
  // reel B's stereo input, and the mixed stereo output. All three are genuinely
  // two-channel in the DSP — reel A reads worklet inputs 0/1 and reel B 2/3,
  // each reel keeps parallel L/R ring buffers, and the output bus carries two
  // channels — so the def has to say so. This is what the stereo auto-wire
  // planner reads (`$lib/graph/stereo-autowire`): patching a stereo source's L
  // into `audio_l_in_a` now also wires its R into `audio_r_in_a`, and
  // `out_l` → a stereo target's L also wires `out_r` → its R.
  //
  // It does NOT change chain/column wiring: `chainWiring` below is precedence 0
  // in resolveMainAudioIn/Out, ahead of the stereoPairs branch, and
  // patch-convenience-columns.test.ts pins that resolution.
  stereoPairs: [
    ['audio_l_in_a', 'audio_r_in_a'],
    ['audio_l_in_b', 'audio_r_in_b'],
    ['out_l', 'out_r'],
  ],

  params: [
    // ---- Reel A ----
    { id: 'rate_a',         label: 'Rate A',    defaultValue: 1,     min: -3,  max: 3,     curve: 'linear' },
    { id: 'mode_a',         label: 'Mode A',    defaultValue: 1,     min: 0,   max: 1,     curve: 'discrete' },
    { id: 'echoes_a',       label: 'Echoes A',  defaultValue: 3,     min: 1,   max: 5,     curve: 'discrete' },
    { id: 'start_a',        label: 'Start A',   defaultValue: 0,     min: 0,   max: 1,     curve: 'linear' },
    { id: 'end_a',          label: 'End A',     defaultValue: 1,     min: 0,   max: 1,     curve: 'linear' },
    { id: 'overdub_flag_a', label: 'Overdub A', defaultValue: 0,     min: 0,   max: 1,     curve: 'discrete' },
    // EQ reel A
    { id: 'eqLow_a',        label: 'EQ Low A',  defaultValue: 0,     min: -12, max: 12,    curve: 'linear', units: 'dB' },
    { id: 'eqMid_a',        label: 'EQ Mid A',  defaultValue: 0,     min: -12, max: 12,    curve: 'linear', units: 'dB' },
    { id: 'eqHigh_a',       label: 'EQ Hi A',   defaultValue: 0,     min: -12, max: 12,    curve: 'linear', units: 'dB' },
    // Filter reel A
    { id: 'filterMode_a',   label: 'Flt Mode A',defaultValue: 0,     min: 0,   max: 3,     curve: 'discrete', options: TWOTRACKS_FILTER_MODES },
    { id: 'cutoff_a',       label: 'Cutoff A',  defaultValue: 20000, min: 20,  max: 20000, curve: 'log', units: 'Hz' },
    { id: 'reso_a',         label: 'Reso A',    defaultValue: 0,     min: 0,   max: 1,     curve: 'linear' },

    // ---- Reel B ----
    { id: 'rate_b',         label: 'Rate B',    defaultValue: 1,     min: -3,  max: 3,     curve: 'linear' },
    { id: 'mode_b',         label: 'Mode B',    defaultValue: 1,     min: 0,   max: 1,     curve: 'discrete' },
    { id: 'echoes_b',       label: 'Echoes B',  defaultValue: 3,     min: 1,   max: 5,     curve: 'discrete' },
    { id: 'start_b',        label: 'Start B',   defaultValue: 0,     min: 0,   max: 1,     curve: 'linear' },
    { id: 'end_b',          label: 'End B',     defaultValue: 1,     min: 0,   max: 1,     curve: 'linear' },
    { id: 'overdub_flag_b', label: 'Overdub B', defaultValue: 0,     min: 0,   max: 1,     curve: 'discrete' },
    // EQ reel B
    { id: 'eqLow_b',        label: 'EQ Low B',  defaultValue: 0,     min: -12, max: 12,    curve: 'linear', units: 'dB' },
    { id: 'eqMid_b',        label: 'EQ Mid B',  defaultValue: 0,     min: -12, max: 12,    curve: 'linear', units: 'dB' },
    { id: 'eqHigh_b',       label: 'EQ Hi B',   defaultValue: 0,     min: -12, max: 12,    curve: 'linear', units: 'dB' },
    // Filter reel B
    { id: 'filterMode_b',   label: 'Flt Mode B',defaultValue: 0,     min: 0,   max: 3,     curve: 'discrete', options: TWOTRACKS_FILTER_MODES },
    { id: 'cutoff_b',       label: 'Cutoff B',  defaultValue: 20000, min: 20,  max: 20000, curve: 'log', units: 'Hz' },
    { id: 'reso_b',         label: 'Reso B',    defaultValue: 0,     min: 0,   max: 1,     curve: 'linear' },

    // ---- Global ----
    { id: 'ab',             label: 'A/B',       defaultValue: 0,     min: 0,   max: 1,     curve: 'linear' },
    // Cross-feed: A's playback → B's input path (a2b) and B → A (b2a). Off = 0.
    { id: 'a2b',            label: 'A→B',       defaultValue: 0,     min: 0,   max: 1,     curve: 'linear' },
    { id: 'b2a',            label: 'B→A',       defaultValue: 0,     min: 0,   max: 1,     curve: 'linear' },
    { id: 'lofi',           label: 'Lofi',      defaultValue: 0,     min: 0,   max: 3,     curve: 'discrete', options: TWOTRACKS_LOFI_MODES },
    { id: 'monitor',        label: 'Monitor',   defaultValue: 0,     min: 0,   max: 1,     curve: 'discrete' },
  ],

  // ── THE NON-PARAM AFFORDANCES ───────────────────────────────────────────
  //
  // Four per reel, and NOT ONE OF THEM WRITES A PARAM: REC / PLAY / STOP post a
  // transport message to the reel worklet, and SAVE TAPE asks the worklet to
  // dump its buffer so the module can turn it into a WAV. A param-only face
  // would therefore silently DELETE the transport — promotion stops both
  // surfaces rendering the card, so an affordance that is not a cell is gone —
  // which is why they are declared here and ranked in `face.order` alongside
  // the knobs.
  //
  // ⚠ THE `testidPrefix`ES ARE ASYMMETRIC, AND THAT IS THE CARD'S SHAPE RATHER
  // THAN A TYPO. Reel A's card buttons are `twotracks-rec` / `-play` / `-stop` /
  // `-save` with NO suffix while reel B's carry `-b`, so nothing in a reel-A
  // locator says which reel it is. `module-docs-lint` greps these prefixes
  // against the card source, so they have to be the strings the card actually
  // emits — declaring the symmetric names it does not emit would be a green
  // declaration describing a testid that is not there. The FACE does not inherit
  // the asymmetry: a face cell's test id is `shell-cell-<familyId>`, and the
  // family IDS below are symmetric. Renaming the card's testids is a mechanical
  // change across every twotracks spec and belongs in its own diff.
  controlFamilies: [
    { id: 'twotracks-rec-a',  label: 'Reel A record',  kind: 'transport', testidPrefix: 'twotracks-rec' },
    { id: 'twotracks-play-a', label: 'Reel A play',    kind: 'transport', testidPrefix: 'twotracks-play' },
    { id: 'twotracks-stop-a', label: 'Reel A stop',    kind: 'transport', testidPrefix: 'twotracks-stop' },
    { id: 'twotracks-save-a', label: 'Reel A export',  kind: 'other',     testidPrefix: 'twotracks-save' },
    { id: 'twotracks-rec-b',  label: 'Reel B record',  kind: 'transport', testidPrefix: 'twotracks-rec-b' },
    { id: 'twotracks-play-b', label: 'Reel B play',    kind: 'transport', testidPrefix: 'twotracks-play-b' },
    { id: 'twotracks-stop-b', label: 'Reel B stop',    kind: 'transport', testidPrefix: 'twotracks-stop-b' },
    { id: 'twotracks-save-b', label: 'Reel B export',  kind: 'other',     testidPrefix: 'twotracks-save-b' },
  ],

  docs: (() => {
    const inputs: Record<string, string> = {};
    const controls: Record<string, string> = {};
    const reels = [
      { suffix: 'a', name: 'A' },
      { suffix: 'b', name: 'B' },
    ];
    for (const { suffix: s, name: R } of reels) {
      // Per-reel gate inputs (transport).
      inputs[`audio_l_in_${s}`] = `Left audio into reel ${R}'s record path. While reel ${R} is recording or overdubbing, this is what gets written to the tape; pairs with the right input.`;
      inputs[`audio_r_in_${s}`] = `Right audio into reel ${R}'s record path, partnering the left input.`;
      inputs[`rec_start_${s}`] = `Reel ${R} record START gate: a rising edge starts (or restarts) recording onto reel ${R} from the head of the tape. Drive it from a clock/button to capture a take hands-free.`;
      inputs[`rec_arm_${s}`] = `Reel ${R} record ARM gate: a rising edge arms reel ${R} so the next pass (or the next REC START) drops into record — the "ready to record" toggle.`;
      inputs[`overdub_${s}`] = `Reel ${R} OVERDUB gate: a rising edge toggles overdub (sound-on-sound) mode, layering new input onto the existing loop instead of erasing it.`;
      inputs[`rate_cv_${s}`] = `Reel ${R} RATE CV — varispeed control voltage for reel ${R}'s tape speed. A bipolar −1..+1 CV sweeps the RATE control across its full −3..+3 span centred on wherever you left the knob, so an LFO here wows and flutters the tape, an envelope does a tape-stop, and a slow ramp through zero turns the reel around into reverse. Modulates the same speed the record head runs at, so it varispeeds a take being recorded as well as one being played back.`;
      // Per-reel params.
      controls[`rate_${s}`] = `Reel ${R} tape RATE (−3..+3) — playback/record speed and direction; 1 = normal, fractions slow it down and pitch it lower, negatives play the tape backwards.`;
      controls[`mode_${s}`] = `Reel ${R} MODE (LOOP vs ONE-SHOT) — whether the reel loops continuously or plays its take once.`;
      controls[`echoes_${s}`] = `Reel ${R} ECHOES (1..5) — sets the feedback/repeat behavior: how many times the recorded loop re-circulates (and decays) like a tape echo.`;
      controls[`start_${s}`] = `Reel ${R} loop START (0..1) — the left edge of the playback window within the recorded tape (you can't drag it past the playhead while rolling).`;
      controls[`end_${s}`] = `Reel ${R} loop END (0..1) — the right edge of the playback window within the recorded tape.`;
      controls[`overdub_flag_${s}`] = `Reel ${R} overdub state flag (0/1) — the persisted on/off of overdub mode (the button form of the OVERDUB gate); when on, new input layers onto the existing loop.`;
      controls[`eqLow_${s}`] = `Reel ${R} EQ LOW (±12 dB) — low-band shelf on reel ${R}'s playback.`;
      controls[`eqMid_${s}`] = `Reel ${R} EQ MID (±12 dB) — mid-band on reel ${R}'s playback.`;
      controls[`eqHigh_${s}`] = `Reel ${R} EQ HIGH (±12 dB) — high-band shelf on reel ${R}'s playback.`;
      controls[`filterMode_${s}`] = `Reel ${R} FILTER MODE — ${TWOTRACKS_FILTER_MODES.map((m) => m.label).join(' / ')} selector for reel ${R}'s playback filter (0 = off, and the state-variable filter's high-pass tap comes BEFORE its low-pass one: 1 = HP, 2 = LP, 3 = BP, as the worklet selects them).`;
      controls[`cutoff_${s}`] = `Reel ${R} filter CUTOFF (20 Hz..20 kHz, log) — the corner of reel ${R}'s playback filter (active per FILTER MODE).`;
      controls[`reso_${s}`] = `Reel ${R} filter RESONANCE (0..1) — emphasis at reel ${R}'s filter cutoff.`;
      // The four non-param affordances, documented under the `-{n}` template a
      // control family is ranked by.
      controls[`twotracks-rec-${s}-{n}`] = `Reel ${R} REC — drop the reel into record from the head of the tape. With OVERDUB off this erases what was there; with OVERDUB on it layers the new input over the existing loop, sound-on-sound. The same thing the REC START gate input does, so a sequencer can take a hands-free take.`;
      controls[`twotracks-play-${s}-{n}`] = `Reel ${R} PLAY — roll the tape from the loop window's START. In LOOP TAPE mode it keeps circling the window; in TAPE mode it plays the take once and stops.`;
      controls[`twotracks-stop-${s}-{n}`] = `Reel ${R} STOP — halt the reel, whether it was playing, recording or overdubbing. The tape is kept: pressing PLAY again rolls the same take.`;
      controls[`twotracks-save-${s}-{n}`] = `Reel ${R} SAVE TAPE — export this reel's recorded take as a stereo 48 kHz 16-bit WAV. A reel with nothing on it exports nothing; the take also travels inside a saved performance without needing this.`;
    }
    return {
      explanation:
        "A two-reel tape-loop emulator — two independent tape decks (reel A and reel B) in one box, mixed to a stereo output. Each reel records the stereo audio at its inputs onto a fixed-length 'blank tape', then plays the captured take back: you set a loop window (START / END) within the tape, a tape RATE (which slows, speeds, or reverses playback and pitch like a varispeed reel), an ECHOES feedback amount for tape-echo-style repeats, and per-reel 3-band EQ + a multimode filter to colour the playback. Recording is driven hands-free by the per-reel REC START / REC ARM / OVERDUB gate inputs (or the faceplate\'s transport), and OVERDUB layers new input onto the existing loop sound-on-sound. The two reels are blended by the global A/B crossfader, can cross-feed into each other (A→B and B→A) for runaway tape-loop textures, and a global LOFI option degrades the sound; MONITOR passes the live input through. The faceplate draws each reel's live waveform + playhead and can export a take to WAV.",
      inputs,
      outputs: {
        out_l: 'Left channel of the mixed stereo output — reels A and B summed per the A/B crossfader (and any cross-feed), post per-reel EQ/filter and the global LOFI stage.',
        out_r: 'Right channel of the mixed stereo output, the partner of OUT L.',
      },
      controls: {
        ...controls,
        // Global controls.
        ab: 'A/B crossfade (0..1) — blends the two reels in the output: 0 = reel A only, 0.5 = both at unity, 1 = reel B only.',
        a2b: 'Cross-feed A→B (0..1) — routes reel A\'s playback into reel B\'s input/record path; with overdub this builds layered, evolving tape loops (raise carefully — it can run away).',
        b2a: 'Cross-feed B→A (0..1) — routes reel B\'s playback into reel A\'s input/record path (the mirror of A→B).',
        lofi: `LOFI degradation (${TWOTRACKS_LOFI_MODES.map((m) => m.label).join(' / ')}) — a global tape-degradation amount that adds wow/flutter/bit-grit character; OFF = clean.`,
        monitor: 'MONITOR (on/off) — passes the live input signal through to the output so you can hear what you\'re about to record (input monitoring), independent of playback.',
      },
    };
  })(),

  // ── THE FACE ────────────────────────────────────────────────────────────
  //
  // The mental model this has to serve: you work on ONE REEL AT A TIME, and
  // while you work you need to see that reel's tape — where the audio is, where
  // the loop window sits, where the playhead is. Everything else is a setting.
  // That is a tab rail with a persistent picture.
  //
  // ── RANK: what a lane tile shows ────────────────────────────────────────
  //
  // Ranks 1-6 are the whole lane budget, so on a module with twenty-nine params
  // the ranking is a real decision rather than a formality. It is grouped by
  // WHAT A PLAYER REACHES FOR DURING A TAKE, not by the declaration order and
  // deliberately NOT by reel:
  //
  //   * `ab` is rank 1 because it is the only control that means something
  //     whichever reel you are working on.
  //   * the two RATEs follow, because varispeed is what makes this a tape
  //     machine rather than a looper — it is the module's signature gesture and
  //     the one a player rides live.
  //   * the two ECHOES next, then MONITOR (hear the input at all).
  //
  // ⚠ THE REJECTED ALTERNATIVE, NAMED. Ranking reel A's whole block first
  // (`rate_a, echoes_a, start_a, end_a, mode_a, overdub_flag_a`) would spend the
  // entire lane budget on ONE REEL and put reel B's existence below the fold. On
  // a two-reel module that is the wrong first impression: the tile would read as
  // a one-reel looper.
  //
  // ── SEVEN BANDS, AND THE RAIL ENGAGES THROUGH THE ORDINARY THRESHOLD ────
  //
  // `DOCK_TAB_MIN_BANDS` is 7 and these are seven, so `face.tabbed` is NOT
  // declared and must not be: that opt-in is owner-instruction-only, recorded
  // verbatim, and there is no instruction here. The grouping is the hardware's:
  // a tape machine's TRANSPORT, its TAPE MOTION and its TONE section are three
  // different things, twice over, plus the mix.
  //
  // ⚠ AND THE GROUPING IS A JUDGEMENT A REVIEWER MAY OVERTURN. Someone could
  // reasonably say TAPE and TONE are one idea per reel, which collapses this to
  // three bands and turns the rail off. If that is the ruling, SHIP IT UNTABBED
  // — do NOT re-split to win the rail back. Padding pages to reach a threshold
  // is the exact thing the rule forbids, and `ruttetra` is the precedent for a
  // heavy face shipping as one column.
  //
  // ⚠ WHAT THE RAIL DOES **NOT** BUY, measured rather than assumed, because the
  // opposite is the natural guess. A tabbed face does NOT mount one band at a
  // time: `dockBandVisible` is documented as "CSS-HIDDEN, never unmounted" and
  // `ModuleShell` renders every band unconditionally with a plain `hidden`
  // attribute, because `faces-parity` asserts one cell per control across the
  // WHOLE faceplate and unmounting would read as a face that lost thirty
  // controls. So every one of these cells is in the DOM on every tab, and the
  // rail is a READABILITY device only. It buys nothing on mount cost, and this
  // face should not be described as if it did.
  //
  // ── NO HERO, AND NO LANE PICTURE ────────────────────────────────────────
  //
  // No `hero`: a hero MOVES a control out of its band and can EMPTY it, which
  // would change the band count and therefore whether the rail engages at all.
  // There is also no single control that deserves to dominate — `ab` is rank 1
  // but a crossfader is not the instrument.
  //
  // `glyph: 'none'`, and ⚠ THIS ONE IS UNPROTECTED, which is why it is argued
  // here and asserted in `twotracks-face-model.test.ts` rather than left to a
  // gate. `out_l` is `type: 'audio'`, so `primaryAudioOutPortId` resolves and a
  // live-audio glyph literal would be LEGAL — the dead-glyph clause stays green
  // and nothing anywhere reddens. It is refused because it would be
  // UNINFORMATIVE, not because it would be dead: what a player wants from a tape
  // machine at a glance is *is there tape on this reel, and where is the
  // playhead*, and an output trace answers neither. A stopped reel holding a
  // full take, a rolling reel with a blank tape, and a reel monitoring silence
  // ALL READ FLAT at `out_l` — three distinct states, one picture. The module's
  // own picture is per-instance by definition and a layout-source glyph gets no
  // `nodeId`, so it could only draw the same tape for every instance.
  face: {
    order: [
      // 1-6 — the lane budget. See the argument above.
      'ab', 'rate_a', 'rate_b', 'echoes_a', 'echoes_b', 'monitor',
      // 7+ — dock only, in band order.
      'mode_a', 'overdub_flag_a',
      'twotracks-rec-a-{n}', 'twotracks-play-a-{n}', 'twotracks-stop-a-{n}', 'twotracks-save-a-{n}',
      'start_a', 'end_a',
      'eqLow_a', 'eqMid_a', 'eqHigh_a', 'filterMode_a', 'cutoff_a', 'reso_a',
      'mode_b', 'overdub_flag_b',
      'twotracks-rec-b-{n}', 'twotracks-play-b-{n}', 'twotracks-stop-b-{n}', 'twotracks-save-b-{n}',
      'start_b', 'end_b',
      'eqLow_b', 'eqMid_b', 'eqHigh_b', 'filterMode_b', 'cutoff_b', 'reso_b',
      'a2b', 'b2a', 'lofi',
    ],

    // ⚠ EVERY RANKED KEY IS CLAIMED BY A PAGE, and that is load-bearing rather
    // than tidy: `dockFacePlan` sweeps anything unclaimed into a defensive
    // `__unpaged` tail band, which would silently make this an EIGHT-band face.
    pages: [
      {
        id: 'a-transport',
        label: 'A · transport',
        controls: [
          'mode_a', 'overdub_flag_a',
          'twotracks-rec-a-{n}', 'twotracks-play-a-{n}', 'twotracks-stop-a-{n}',
          'twotracks-save-a-{n}',
        ],
      },
      { id: 'a-tape', label: 'A · tape', controls: ['rate_a', 'echoes_a', 'start_a', 'end_a'] },
      {
        id: 'a-tone',
        label: 'A · tone',
        controls: ['eqLow_a', 'eqMid_a', 'eqHigh_a', 'filterMode_a', 'cutoff_a', 'reso_a'],
        // Two stages in series, not six knobs: a 3-band EQ and then a multimode
        // filter. The sub-headings are the only thing that says which knob
        // belongs to which stage — CUTOFF and RESONANCE mean nothing without
        // FILTER MODE beside them.
        //
        // ⚠ `clusterFlow: 'row'` IS LOAD-BEARING AND IT IS NOT ABOUT WIDTH.
        // Stacked, these two equal-sized clusters would satisfy the CONSOLE GRID
        // shape rule and this band would be handed a column ruler — which claims
        // that COLUMN j MEANS THE SAME THING IN BOTH CLUSTERS. Here it does not:
        // column 1 is EQ LOW above FILTER MODE, column 2 is EQ MID above CUTOFF.
        // That is mixmstrs' channel strips and moog984's matrix rows read
        // backwards — a table implying a correspondence the module does not
        // have. Side by side there is nothing to align and the rule correctly
        // stands down. The band is also one row instead of two, which is the
        // compact default rather than the reason.
        clusterFlow: 'row',
        clusters: [
          { label: 'eq', controls: ['eqLow_a', 'eqMid_a', 'eqHigh_a'] },
          { label: 'filter', controls: ['filterMode_a', 'cutoff_a', 'reso_a'] },
        ],
      },
      {
        id: 'b-transport',
        label: 'B · transport',
        controls: [
          'mode_b', 'overdub_flag_b',
          'twotracks-rec-b-{n}', 'twotracks-play-b-{n}', 'twotracks-stop-b-{n}',
          'twotracks-save-b-{n}',
        ],
      },
      { id: 'b-tape', label: 'B · tape', controls: ['rate_b', 'echoes_b', 'start_b', 'end_b'] },
      {
        id: 'b-tone',
        label: 'B · tone',
        controls: ['eqLow_b', 'eqMid_b', 'eqHigh_b', 'filterMode_b', 'cutoff_b', 'reso_b'],
        // Same band, same argument — see reel A's above for why the clusters
        // flow as a ROW rather than stacking into a console grid.
        clusterFlow: 'row',
        clusters: [
          { label: 'eq', controls: ['eqLow_b', 'eqMid_b', 'eqHigh_b'] },
          { label: 'filter', controls: ['filterMode_b', 'cutoff_b', 'reso_b'] },
        ],
      },
      { id: 'mix', label: 'mix', controls: ['ab', 'a2b', 'b2a', 'lofi', 'monitor'] },
    ],

    // ⚠ LATCHING, BOTH OF THEM, CLASSIFIED AT THE READ SITE — see
    // `ACKNOWLEDGED_LATCHING` in module-face-lint for the acknowledgement. They
    // are named here too because `face.momentary` is where the opposite answer
    // would go and its absence should be a decision, not an omission.
    // `overdub_flag_*` is a persisted mode the player sets and leaves (the
    // module turns a CHANGE in it into one pulsed `overdub_toggle`, so a
    // momentary render would fire that pulse twice per press and land back
    // where it started), and `monitor` is read as a plain level once per block
    // in the worklet.
    glyph: 'none',

    // The reel picture. Dock-only, paints above the control bands, replaces the
    // hero glyph, and leaves every param cell intact.
    extension: 'twotracks',
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    // 4 audio inputs: [0]=A-L, [1]=A-R, [2]=B-L, [3]=B-R
    // Gate inputs route as AudioParams (rec_start, rec_arm, overdub_toggle per reel).
    const workletNode = createWorkletNode(node, ctx, 'twotracks', {
      numberOfInputs: 4, // [0]=A-L, [1]=A-R, [2]=B-L, [3]=B-R
      numberOfOutputs: 1,
      outputChannelCount: [2], // stereo
    });

    // STEREO IS A SPLITTER, NOT TWO REFERENCES TO THE SAME BUS.
    //
    // The worklet has ONE output carrying TWO channels (numberOfOutputs: 1,
    // outputChannelCount: [2]). Mapping both port handles at
    // `{ node: workletNode, output: 0 }` — which is what shipped — makes
    // `out_l` and `out_r` the SAME graph edge, so patching them into two mono
    // destinations hands each one the whole 2-channel bus and Web Audio
    // down-mixes it to (L+R)/2 at BOTH. The tape is genuinely stereo (the reel
    // ring buffers are parallel L/R, the WAV export writes interleaved stereo,
    // and the docs describe OUT L / OUT R as separate channels), so the module
    // has to actually deliver two channels. Note the INPUT side was always
    // right — reel A takes worklet inputs 0/1 and reel B 2/3 — which is what
    // makes this an output-side mistake rather than a mono design.
    //
    // Why it survived: a mono source recorded to both reel channels gives
    // L === R, so the collapse is inaudible unless the two channels genuinely
    // differ (a stereo source, or per-channel processing). Same failure and
    // same fix as RINGBACK — see ringback.ts.
    const splitter = ctx.createChannelSplitter(2);
    workletNode.connect(splitter, 0, 0);

    // Muted keep-alive
    const sink = ctx.createGain();
    sink.gain.value = 0;
    try {
      workletNode.connect(sink);
      sink.connect(ctx.destination);
    } catch { /* ignore if context already closed */ }

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;

    // Apply initial param values
    for (const def of twotracksDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      const wId = cardParamToWorkletParam(def.id);
      if (wId) params.get(wId)?.setValueAtTime(v, ctx.currentTime);
    }

    // Local volatile render state — Float32Array must NOT go through Y.Doc
    // (Y.Doc can't encode typed arrays; peaks are per-frame, not synced state).
    // Card polls these via eng.read(node, 'peaksA'/'peaksB'), same pattern as SCOPE.
    let localPeaksA: Float32Array | null = null;
    let localPeaksB: Float32Array | null = null;
    // Playhead position is per-frame, transient render state — it must NOT be
    // written to the live Y.Doc (a ~90 Hz proxy write during playback is the
    // render-storm class from cv-modulation-live-store-write-storm). Kept local
    // and read by the card's rAF poll, exactly like peaks.
    let localPlayheadA = 0;
    let localPlayheadB = 0;

    // Pending tape-dump requests, keyed by reel. The perf-zip exporter calls
    // dumpTapeAsync(reel) to capture a reel's recorded PCM out-of-band (the tape
    // is worklet-owned — it never lives on node.data, so this request/response
    // over the port is the only way to reach it). The WAV-download path (the
    // card's requestDumpTape) uses the OTHER 'tape-data' branch and is
    // unaffected: we tag export dumps so only those resolve a pending promise.
    const pendingTapeDumps = new Map<'a' | 'b', (r: { bufL: Float32Array; bufR: Float32Array; bufLen: number } | null) => void>();

    // Handle worklet → host messages (playhead + peaks; tape-data for WAV export)
    workletNode.port.onmessage = (e: MessageEvent) => {
      const msg = e.data as {
        type: string;
        reel?: 'a' | 'b';
        pos?: number;
        state?: string;
        bufLen?: number;
        peaks?: Float32Array;
        // tape-data fields (transferred buffers arrive as ArrayBuffer)
      } | null;
      if (!msg) return;

      if (msg.type === 'playhead') {
        const reelId = msg.reel ?? 'a';
        // Peaks stay local — never written to Y.Doc to avoid Float32Array encoding
        // issues and write-storm on every 11ms playhead interval.
        if (msg.peaks instanceof Float32Array) {
          if (reelId === 'a') localPeaksA = msg.peaks;
          else localPeaksB = msg.peaks;
        }
        // Playhead position → local volatile only (polled by the card's rAF).
        if (typeof msg.pos === 'number') {
          if (reelId === 'a') localPlayheadA = msg.pos;
          else localPlayheadB = msg.pos;
        }
        try {
          const live = livePatch.nodes[node.id];
          if (!live) return;
          if (!live.data) (live as { data: TwoTracksData }).data = {} as TwoTracksData;
          const d = live.data as TwoTracksData;
          // ONLY transport state + bufLen go to the Y.Doc — both change rarely
          // (on transport transitions / record growth), not per frame. The
          // worklet already posts these only on change.
          if (reelId === 'a') {
            if (typeof msg.state === 'string' && d.transportState_a !== msg.state) {
              d.transportState_a = msg.state as TwoTracksData['transportState_a'];
            }
            if (typeof msg.bufLen === 'number' && d.bufLenA !== msg.bufLen) d.bufLenA = msg.bufLen;
          } else {
            if (typeof msg.state === 'string' && d.transportState_b !== msg.state) {
              d.transportState_b = msg.state as TwoTracksData['transportState_b'];
            }
            if (typeof msg.bufLen === 'number' && d.bufLenB !== msg.bufLen) d.bufLenB = msg.bufLen;
          }
        } catch { /* node may be deleted */ }

      } else if (msg.type === 'tape-data') {
        // Transferred buffers arrive as plain objects with array data after structured clone
        const raw = e.data as { type: string; reel: 'a' | 'b'; bufLen: number; bufL?: ArrayBuffer; bufR?: ArrayBuffer };
        const reelId = raw.reel ?? 'a';
        const pending = pendingTapeDumps.get(reelId);
        if (pending) {
          // Export-dump response: hand the raw PCM to the perf-zip exporter
          // (NOT a WAV download). One-shot — clear the resolver.
          pendingTapeDumps.delete(reelId);
          pending(
            raw.bufL && raw.bufR
              ? { bufL: new Float32Array(raw.bufL), bufR: new Float32Array(raw.bufR), bufLen: raw.bufLen }
              : null,
          );
        } else if (raw.bufL && raw.bufR) {
          // Card's SAVE button: synthesize + download a WAV.
          downloadWav(
            new Float32Array(raw.bufL),
            new Float32Array(raw.bufR),
            raw.bufLen,
            `twotracks-reel-${reelId}`,
          );
        }
      }
    };

    // Poll node.params for changes (overdub flags + all continuous params)
    // Seed from the node's initial flags (NOT -1) — otherwise the first poll
    // sees a change (0 ≠ -1) and fires a spurious overdub_toggle pulse on spawn,
    // flipping the reel into overdub before the user touches anything.
    let lastOverdubFlagA = (node.params ?? {})['overdub_flag_a'] ?? 0;
    let lastOverdubFlagB = (node.params ?? {})['overdub_flag_b'] ?? 0;
    let alive = true;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    function pollParams(): void {
      if (!alive) return;
      const live = livePatch.nodes[node.id];
      if (live) {
        const p = live.params as Record<string, number>;

        // Reel A continuous params
        params.get('rate')?.setValueAtTime(p.rate_a ?? 1, ctx.currentTime);
        params.get('mode')?.setValueAtTime(p.mode_a ?? 1, ctx.currentTime);
        params.get('echoes')?.setValueAtTime(p.echoes_a ?? 3, ctx.currentTime);
        params.get('start')?.setValueAtTime(p.start_a ?? 0, ctx.currentTime);
        params.get('end')?.setValueAtTime(p.end_a ?? 1, ctx.currentTime);
        params.get('eqLow_a')?.setValueAtTime(p.eqLow_a ?? 0, ctx.currentTime);
        params.get('eqMid_a')?.setValueAtTime(p.eqMid_a ?? 0, ctx.currentTime);
        params.get('eqHigh_a')?.setValueAtTime(p.eqHigh_a ?? 0, ctx.currentTime);
        params.get('filterMode_a')?.setValueAtTime(p.filterMode_a ?? 0, ctx.currentTime);
        params.get('cutoff_a')?.setValueAtTime(p.cutoff_a ?? 20000, ctx.currentTime);
        params.get('reso_a')?.setValueAtTime(p.reso_a ?? 0, ctx.currentTime);

        // Reel B continuous params
        params.get('rate_b')?.setValueAtTime(p.rate_b ?? 1, ctx.currentTime);
        params.get('mode_b')?.setValueAtTime(p.mode_b ?? 1, ctx.currentTime);
        params.get('echoes_b')?.setValueAtTime(p.echoes_b ?? 3, ctx.currentTime);
        params.get('start_b')?.setValueAtTime(p.start_b ?? 0, ctx.currentTime);
        params.get('end_b')?.setValueAtTime(p.end_b ?? 1, ctx.currentTime);
        params.get('eqLow_b')?.setValueAtTime(p.eqLow_b ?? 0, ctx.currentTime);
        params.get('eqMid_b')?.setValueAtTime(p.eqMid_b ?? 0, ctx.currentTime);
        params.get('eqHigh_b')?.setValueAtTime(p.eqHigh_b ?? 0, ctx.currentTime);
        params.get('filterMode_b')?.setValueAtTime(p.filterMode_b ?? 0, ctx.currentTime);
        params.get('cutoff_b')?.setValueAtTime(p.cutoff_b ?? 20000, ctx.currentTime);
        params.get('reso_b')?.setValueAtTime(p.reso_b ?? 0, ctx.currentTime);

        // Global A/B
        params.get('ab')?.setValueAtTime(p.ab ?? 0, ctx.currentTime);

        // Global cross-feed (A→B / B→A)
        params.get('a2b')?.setValueAtTime(p.a2b ?? 0, ctx.currentTime);
        params.get('b2a')?.setValueAtTime(p.b2a ?? 0, ctx.currentTime);

        // Global Lofi
        params.get('lofi')?.setValueAtTime(p.lofi ?? 0, ctx.currentTime);

        // Global Monitor (input passthrough)
        params.get('monitor')?.setValueAtTime(p.monitor ?? 0, ctx.currentTime);

        // Overdub toggle pulses (rising-edge driven)
        const ovFlagA = p.overdub_flag_a ?? 0;
        if (ovFlagA !== lastOverdubFlagA) {
          lastOverdubFlagA = ovFlagA;
          const tp = params.get('overdub_toggle');
          if (tp) {
            tp.setValueAtTime(0, ctx.currentTime);
            tp.setValueAtTime(1, ctx.currentTime + 0.001);
            tp.setValueAtTime(0, ctx.currentTime + 0.002);
          }
        }
        const ovFlagB = p.overdub_flag_b ?? 0;
        if (ovFlagB !== lastOverdubFlagB) {
          lastOverdubFlagB = ovFlagB;
          const tp = params.get('overdub_toggle_b');
          if (tp) {
            tp.setValueAtTime(0, ctx.currentTime);
            tp.setValueAtTime(1, ctx.currentTime + 0.001);
            tp.setValueAtTime(0, ctx.currentTime + 0.002);
          }
        }
      }
      pollTimer = setTimeout(pollParams, POLL_MS);
    }
    pollTimer = setTimeout(pollParams, POLL_MS);

    return {
      domain: 'audio',

      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        // Reel A audio + gates
        ['audio_l_in_a', { node: workletNode, input: 0 }],
        ['audio_r_in_a', { node: workletNode, input: 1 }],
        ['rec_start_a',  { node: workletNode, input: 0, param: params.get('rec_start')! }],
        ['rec_arm_a',    { node: workletNode, input: 0, param: params.get('rec_arm')! }],
        ['overdub_a',    { node: workletNode, input: 0, param: params.get('overdub_toggle')! }],
        // Reel A varispeed CV → the SAME a-rate AudioParam the RATE knob writes.
        // NOTE the worklet-side name is the un-suffixed `rate` (reel A keeps the
        // pre-reel-B param names for back-compat) — hence the indirection
        // through cardParamToWorkletParam rather than a literal, so a rename on
        // one side can't leave this pointing at an AudioParam that doesn't
        // exist (`params.get` would return undefined and the jack would be a
        // silent no-op — the exact `echoes_b` failure twotracks already shipped
        // once, which twotracks-worklet-params.test.ts now pins).
        ['rate_cv_a',    { node: workletNode, input: 0, param: params.get(cardParamToWorkletParam('rate_a')!)! }],
        // Reel B audio + gates
        ['audio_l_in_b', { node: workletNode, input: 2 }],
        ['audio_r_in_b', { node: workletNode, input: 3 }],
        ['rec_start_b',  { node: workletNode, input: 0, param: params.get('rec_start_b')! }],
        ['rec_arm_b',    { node: workletNode, input: 0, param: params.get('rec_arm_b')! }],
        ['overdub_b',    { node: workletNode, input: 0, param: params.get('overdub_toggle_b')! }],
        ['rate_cv_b',    { node: workletNode, input: 0, param: params.get(cardParamToWorkletParam('rate_b')!)! }],
      ]),

      // Two DIFFERENT splitter outputs — not two references to one stereo bus.
      // See the ChannelSplitter comment in the factory body above.
      outputs: new Map([
        ['out_l', { node: splitter, output: 0 }],
        ['out_r', { node: splitter, output: 1 }],
      ]),

      setParam(paramId: string, value: number) {
        const wId = cardParamToWorkletParam(paramId);
        if (wId) params.get(wId)?.setValueAtTime(value, ctx.currentTime);
      },

      readParam(paramId: string) {
        const wId = cardParamToWorkletParam(paramId);
        if (wId) return params.get(wId)?.value;
        return undefined;
      },

      read(key: string) {
        if (key === 'workletPort') return workletNode.port;
        if (key === 'sampleRate') return ctx.sampleRate;
        if (key === 'peaksA') return localPeaksA;
        if (key === 'peaksB') return localPeaksB;
        if (key === 'playheadA') return localPlayheadA;
        if (key === 'playheadB') return localPlayheadB;
        // Perf-zip persistence: dump a reel's recorded tape PCM (request →
        // 'tape-data' response, resolved by the pendingTapeDumps map above).
        // Resolves null on no recording / timeout, so the exporter just omits
        // an empty reel. The tape is worklet-owned, so this port round-trip is
        // the only way the pure exporter can reach the bytes.
        if (key === 'dumpTapeAsync') {
          return (reel: 'a' | 'b'): Promise<{ bufL: Float32Array; bufR: Float32Array; bufLen: number } | null> =>
            new Promise((resolve) => {
              let to: ReturnType<typeof setTimeout> | null = null;
              // The resolver stashed in the map clears the timeout + resolves
              // exactly once. The 'tape-data' handler calls this on response;
              // the timeout calls it if the worklet never answers (empty reel
              // → the worklet skips the response, so we resolve null).
              const settle = (r: { bufL: Float32Array; bufR: Float32Array; bufLen: number } | null): void => {
                if (to !== null) { clearTimeout(to); to = null; }
                resolve(r);
              };
              pendingTapeDumps.set(reel, settle);
              to = setTimeout(() => {
                if (pendingTapeDumps.get(reel) === settle) pendingTapeDumps.delete(reel);
                resolve(null);
              }, 1500);
              try {
                workletNode.port.postMessage({ type: 'dump-tape', reel });
              } catch {
                if (pendingTapeDumps.get(reel) === settle) pendingTapeDumps.delete(reel);
                settle(null);
              }
            });
        }
        // Perf-zip restore: refill a reel's ring buffer from persisted PCM.
        if (key === 'loadTape') {
          return (reel: 'a' | 'b', bufL: Float32Array, bufR: Float32Array, bufLen: number): void => {
            try {
              // Copy into fresh transferable buffers (the caller's may be reused).
              const l = bufL.slice(0);
              const r = bufR.slice(0);
              workletNode.port.postMessage(
                { type: 'load-tape', reel, bufLen, bufL: l.buffer, bufR: r.buffer },
                [l.buffer, r.buffer],
              );
            } catch { /* node may be torn down */ }
          };
        }
        return undefined;
      },

      dispose() {
        alive = false;
        localPeaksA = null;
        localPeaksB = null;
        localPlayheadA = 0;
        localPlayheadB = 0;
        if (pollTimer !== null) clearTimeout(pollTimer);
        try { workletNode.port.onmessage = null; } catch { /* */ }
        try { workletNode.disconnect(); } catch { /* */ }
        try { splitter.disconnect(); } catch { /* */ }
        try { sink.disconnect(); } catch { /* */ }
      },
    };
  },
};

/**
 * Map a card-side param ID to the worklet AudioParam name.
 * Returns null for display-only params (playhead_{a,b}).
 *
 * EXPORTED for `twotracks-worklet-params.test.ts`, which cross-checks every
 * value here against the worklet.s own `parameterDescriptors`. A name in this
 * table that the worklet does not declare is a PERMANENT NO-OP knob —
 * `params.get(name)` returns undefined and the optional-chained
 * `setValueAtTime` silently does nothing. That is exactly what `echoes_b` was.
 */
export function cardParamToWorkletParam(cardId: string): string | null {
  const MAP: Record<string, string> = {
    // Reel A — core (keep backward-compat worklet param names)
    rate_a:          'rate',
    mode_a:          'mode',
    echoes_a:        'echoes',
    start_a:         'start',
    end_a:           'end',
    // EQ reel A (worklet param names match card IDs)
    eqLow_a:         'eqLow_a',
    eqMid_a:         'eqMid_a',
    eqHigh_a:        'eqHigh_a',
    // Filter reel A
    filterMode_a:    'filterMode_a',
    cutoff_a:        'cutoff_a',
    reso_a:          'reso_a',
    // Reel B — all params use _b suffix in worklet too
    rate_b:          'rate_b',
    mode_b:          'mode_b',
    echoes_b:        'echoes_b',
    start_b:         'start_b',
    end_b:           'end_b',
    eqLow_b:         'eqLow_b',
    eqMid_b:         'eqMid_b',
    eqHigh_b:        'eqHigh_b',
    filterMode_b:    'filterMode_b',
    cutoff_b:        'cutoff_b',
    reso_b:          'reso_b',
    // Global
    ab:              'ab',
    a2b:             'a2b',
    b2a:             'b2a',
    lofi:            'lofi',
    monitor:         'monitor',
    // Transient scrub-velocity params (not in def.params, not persisted)
    scrubVelocity_a: 'scrubVelocity_a',
    scrubVelocity_b: 'scrubVelocity_b',
    // Toggle-handled params — no direct AudioParam
    // overdub_flag_a: handled via pulsed overdub_toggle
    // overdub_flag_b: handled via pulsed overdub_toggle_b
  };
  return MAP[cardId] ?? null;
}

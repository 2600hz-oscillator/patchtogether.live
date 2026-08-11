// packages/web/src/lib/audio/modules/clouds.ts
//
// CLOUDS — granular texture processor. Audio-domain module + pure-math
// mirror of the worklet engine. Worklet at packages/dsp/src/clouds.ts.
// Algorithm after Émilie Gillet's Mutable Instruments Clouds (MIT-licensed);
// attribution in the worklet header. Buffers ~2-4 seconds of input audio,
// spawns overlapping grains within the buffer, and recombines them into
// a textural / drone / pitch-shifted output. POSITION picks the playhead
// into the buffer; SIZE sets grain length; DENSITY sets grain overlap;
// FREEZE latches the buffer at the current snapshot so the texture
// keeps playing without further input.
//
// Inputs:
//   in_l / in_r (audio): stereo source feeding the granular buffer.
//   pitch (pitch): V/oct global pitch input (sums with the pitch param).
//   freeze_gate (gate): toggles the FREEZE state on rising edge.
//   position_cv (cv, linear, paramTarget=position): displaces buffer position.
//   size_cv (cv, linear, paramTarget=size): displaces grain size.
//   pitch_cv (cv, linear, paramTarget=pitch): displaces the pitch knob (semis).
//   density_cv (cv, linear, paramTarget=density): displaces grain density.
//   texture_cv (cv, linear, paramTarget=texture): displaces texture / grain-window shape.
//   blend_cv (cv, linear, paramTarget=blend): displaces dry/wet blend.
//
// Outputs:
//   out_l / out_r (audio): stereo granular output.
//
// Params:
//   position (linear 0..1, default 0.5): playhead position into the buffer.
//   size (linear 0..1, default 0.5): grain length.
//   pitch (linear -24..24 st, default 0): per-grain pitch shift.
//   density (linear 0..1, default 0.5): grain trigger density.
//   texture (linear 0..1, default 0.5): grain-window shape macro.
//   blend (linear 0..1, default 0.5): dry/wet balance.
//   freeze (discrete 0..1, default 0): 1 = freeze the buffer.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/clouds.js?url';

import { createWorkletNode } from '$lib/audio/worklet-guard';
const loadedContexts = new WeakSet<BaseAudioContext>();

// ----------------------------------------------------------------------------
// Pure-math mirror — keep numerically identical to the worklet.
// ----------------------------------------------------------------------------

// ── THE WORKLET'S CONSTANTS, EXPORTED ───────────────────────────────────────
//
// Numerically identical to packages/dsp/src/clouds.ts (the mirror contract in
// this file's header). They are EXPORTED because the faceplate has to state
// them — "2.0 s of ring", "24 grains", "the grain runs 60…1500 ms" are the
// three facts this module's panel exists to make visible — and a second copy
// typed into the UI is exactly the card-disagrees-with-its-def class CLAUDE.md
// is about. $lib/ui/modules/clouds-face-model imports them from here.
export const CLOUDS_BUFFER_SECONDS = 2.0;
export const CLOUDS_MAX_GRAINS = 24;
/** Grain length law: `minMs · (maxMs/minMs)^size`, before the buffer clamp. */
export const CLOUDS_GRAIN_MIN_MS = 60;
/**
 * `safeLen = min(lengthSamples, floor(bufLen · this))` — the ceiling a grain is
 * hard-limited to, and the physical guard POSITION's travel is carved out of
 * (`headroom = availableHistory − safeLen`).
 *
 * ⚠ IT USED TO BE 0.4, AND THE LAW'S TOP USED TO BE A SEPARATE LITERAL 1500 ms.
 * The two disagreed, and the disagreement was a DEAD ZONE: the clamp bound from
 * SIZE 0.804744 upward, so the top 19.50 % of the dial rendered BIT-IDENTICAL
 * output (measured on the shipping worklet — art/scenarios/clouds/size-travel.test.ts,
 * against a `Math.floor` quantisation floor of Δsize ≈ 1e-5 everywhere else).
 * `CLOUDS_GRAIN_MAX_MS` is now DERIVED from this fraction, so the clamp cannot
 * contradict the law again and no part of SIZE is dead.
 */
export const CLOUDS_GRAIN_CAP_FRACTION = 0.75;
/** DERIVED from the cap, never re-typed — 1500 ms, the same top the law always
 *  declared, now actually reachable. */
export const CLOUDS_GRAIN_MAX_MS =
  CLOUDS_BUFFER_SECONDS * CLOUDS_GRAIN_CAP_FRACTION * 1000;
/** Spawn rate law: `sr/maxIntervalSamples` … `sr/minIntervalSamples`, i.e.
 *  grains per second at density 0 and density 1. */
export const CLOUDS_SPAWN_MIN_HZ = 6;
export const CLOUDS_SPAWN_MAX_HZ = 1200;

const _BUFFER_SECONDS = CLOUDS_BUFFER_SECONDS;
const _MAX_GRAINS = CLOUDS_MAX_GRAINS;

interface _Grain {
  active: boolean;
  readPos: number;
  pitchRatio: number;
  age: number;
  length: number;
  gainL: number;
  gainR: number;
}

class _LcgRng {
  state: number;
  constructor(seed: number) {
    this.state = seed | 0;
    if (this.state === 0) this.state = 1;
  }
  next(): number {
    this.state = Math.imul(this.state, 16807) | 0;
    return (this.state & 0x7fffffff) / 0x7fffffff;
  }
}

function _grainEnvelope(phase: number, texture: number): number {
  if (phase < 0 || phase >= 1) return 0;
  const rect = 1;
  const tri = 1 - Math.abs(2 * phase - 1);
  const hann = 0.5 - 0.5 * Math.cos(2 * Math.PI * phase);
  if (texture < 0.5) {
    const t = texture * 2;
    return rect * (1 - t) + tri * t;
  }
  const t = (texture - 0.5) * 2;
  return tri * (1 - t) + hann * t;
}

function _readBufferLerp(buf: Float32Array, pos: number): number {
  const len = buf.length;
  let p = pos - Math.floor(pos / len) * len;
  const i0 = Math.floor(p);
  const i1 = i0 + 1 === len ? 0 : i0 + 1;
  const frac = p - i0;
  return buf[i0]! * (1 - frac) + buf[i1]! * frac;
}

class _GranularEngine {
  bufL: Float32Array;
  bufR: Float32Array;
  writeHead = 0;
  bufLen: number;
  fillLevel = 0;
  grains: _Grain[] = [];
  spawnPhasor = 0;
  rng = new _LcgRng(0xc0ffee);
  sr: number;

  constructor(sr: number) {
    this.sr = sr;
    this.bufLen = Math.max(2, Math.floor(sr * _BUFFER_SECONDS));
    this.bufL = new Float32Array(this.bufLen);
    this.bufR = new Float32Array(this.bufLen);
    for (let i = 0; i < _MAX_GRAINS; i++) {
      this.grains.push({
        active: false, readPos: 0, pitchRatio: 1, age: 0, length: 0,
        gainL: 0.7, gainR: 0.7,
      });
    }
  }

  reset(): void {
    for (let i = 0; i < this.bufLen; i++) { this.bufL[i] = 0; this.bufR[i] = 0; }
    this.writeHead = 0;
    this.fillLevel = 0;
    this.spawnPhasor = 0;
    for (const g of this.grains) { g.active = false; g.age = 0; }
  }

  private findFreeGrain(): number {
    for (let i = 0; i < this.grains.length; i++) {
      if (!this.grains[i]!.active) return i;
    }
    return -1;
  }

  private spawnGrain(position: number, size: number, pitchRatio: number): void {
    const idx = this.findFreeGrain();
    if (idx < 0) return;
    const g = this.grains[idx]!;
    const minMs = CLOUDS_GRAIN_MIN_MS;
    const maxMs = CLOUDS_GRAIN_MAX_MS;
    const ms = minMs * Math.pow(maxMs / minMs, size);
    const lengthSamples = Math.max(8, Math.floor((ms / 1000) * this.sr));
    const safeLen = Math.min(lengthSamples, Math.floor(this.bufLen * CLOUDS_GRAIN_CAP_FRACTION));
    g.length = safeLen;
    g.age = 0;
    const availableHistory = Math.max(safeLen + 1, Math.min(this.fillLevel, this.bufLen));
    const headroom = Math.max(0, availableHistory - safeLen);
    const offset = safeLen + position * headroom;
    g.readPos = this.writeHead - offset;
    g.pitchRatio = pitchRatio;
    const pan = 0.3 + this.rng.next() * 0.4;
    g.gainL = Math.cos(pan * Math.PI * 0.5);
    g.gainR = Math.sin(pan * Math.PI * 0.5);
    g.active = true;
  }

  tick(
    inL: number, inR: number,
    position: number, size: number, pitchSemitones: number,
    density: number, texture: number, blend: number,
    freeze: boolean,
  ): [number, number] {
    if (!freeze) {
      this.bufL[this.writeHead] = inL;
      this.bufR[this.writeHead] = inR;
      if (this.fillLevel < this.bufLen) this.fillLevel++;
    }
    const clampedSemis = Math.max(-24, Math.min(24, pitchSemitones));
    const pitchRatio = Math.pow(2, clampedSemis / 12);

    const minIntervalSamples = this.sr / CLOUDS_SPAWN_MAX_HZ;
    const maxIntervalSamples = this.sr / CLOUDS_SPAWN_MIN_HZ;
    const interval = maxIntervalSamples * Math.pow(minIntervalSamples / maxIntervalSamples, density);
    this.spawnPhasor += 1;
    if (this.spawnPhasor >= interval) {
      this.spawnPhasor -= interval;
      this.spawnGrain(position, size, pitchRatio);
    }

    let wetL = 0;
    let wetR = 0;
    let activeCount = 0;
    for (let i = 0; i < this.grains.length; i++) {
      const g = this.grains[i]!;
      if (!g.active) continue;
      const phase = g.age / g.length;
      const env = _grainEnvelope(phase, texture);
      const sL = _readBufferLerp(this.bufL, g.readPos);
      const sR = _readBufferLerp(this.bufR, g.readPos);
      wetL += sL * env * g.gainL;
      wetR += sR * env * g.gainR;
      g.readPos += g.pitchRatio;
      g.age += 1;
      activeCount++;
      if (g.age >= g.length) g.active = false;
    }
    if (activeCount > 1) {
      const norm = 1 / Math.sqrt(activeCount);
      wetL *= norm;
      wetR *= norm;
    }
    wetL *= 1.4;
    wetR *= 1.4;
    wetL = Math.tanh(wetL);
    wetR = Math.tanh(wetR);

    const outL = inL * (1 - blend) + wetL * blend;
    const outR = inR * (1 - blend) + wetR * blend;
    this.writeHead = (this.writeHead + 1) % this.bufLen;
    return [outL, outR];
  }
}

export interface CloudsParams {
  position: number;
  size: number;
  pitch: number;
  density: number;
  texture: number;
  blend: number;
}

export const cloudsMath = {
  grainEnvelope(phase: number, texture: number): number {
    return _grainEnvelope(phase, texture);
  },

  render(
    inL: Float32Array,
    inR: Float32Array,
    sr: number,
    pitchV: number,
    params: CloudsParams,
    options?: { freezeAt?: number },
  ): { outL: Float32Array; outR: Float32Array } {
    const n = Math.min(inL.length, inR.length);
    const eng = new _GranularEngine(sr);
    const outL = new Float32Array(n);
    const outR = new Float32Array(n);
    const pitchSemis = pitchV * 12 + params.pitch;
    let frozen = false;
    const freezeAt = options?.freezeAt;
    for (let i = 0; i < n; i++) {
      if (freezeAt !== undefined && i === freezeAt) frozen = true;
      const [l, r] = eng.tick(
        inL[i]!, inR[i]!,
        params.position, params.size, pitchSemis,
        params.density, params.texture, params.blend,
        frozen,
      );
      outL[i] = l;
      outR[i] = r;
    }
    return { outL, outR };
  },
};

export const cloudsDef: AudioModuleDef = {
  type: 'clouds',
  palette: { top: 'Audio modules', sub: 'Effects' },
  domain: 'audio',
  label: 'clouds',
  category: 'effects',
  stereoPairs: [['in_l', 'in_r'], ['out_l', 'out_r']],
  ossAttribution: { author: 'Émilie Gillet' },

  inputs: [
    { id: 'in_l',        type: 'audio' },
    { id: 'in_r',        type: 'audio' },
    { id: 'pitch',       type: 'pitch' },
    { id: 'freeze_gate', type: 'gate', edge: 'trigger' },
    { id: 'position_cv', type: 'cv', paramTarget: 'position', cvScale: { mode: 'linear' } },
    { id: 'size_cv',     type: 'cv', paramTarget: 'size',     cvScale: { mode: 'linear' } },
    { id: 'pitch_cv',    type: 'cv', paramTarget: 'pitch',    cvScale: { mode: 'linear' } },
    { id: 'density_cv',  type: 'cv', paramTarget: 'density',  cvScale: { mode: 'linear' } },
    { id: 'texture_cv',  type: 'cv', paramTarget: 'texture',  cvScale: { mode: 'linear' } },
    { id: 'blend_cv',    type: 'cv', paramTarget: 'blend',    cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'out_l', type: 'audio' },
    { id: 'out_r', type: 'audio' },
  ],
  params: [
    { id: 'position', label: 'Position', defaultValue: 0.5, min: 0,   max: 1,  curve: 'linear' },
    { id: 'size',     label: 'Size',     defaultValue: 0.5, min: 0,   max: 1,  curve: 'linear' },
    { id: 'pitch',    label: 'Pitch',    defaultValue: 0,   min: -24, max: 24, curve: 'linear', units: 'st' },
    { id: 'density',  label: 'Density',  defaultValue: 0.5, min: 0,   max: 1,  curve: 'linear' },
    { id: 'texture',  label: 'Texture',  defaultValue: 0.5, min: 0,   max: 1,  curve: 'linear' },
    { id: 'blend',    label: 'Blend',    defaultValue: 0.5, min: 0,   max: 1,  curve: 'linear' },
    { id: 'freeze',   label: 'Freeze',   defaultValue: 0,   min: 0,   max: 1,  curve: 'discrete' },
  ],

  controlFamilies: [
    {
      // The ring buffer with its read window — the faceplate's hero picture.
      // A control FAMILY (a `cell`) rather than a param because it is a
      // picture, not a value: nothing about it is stored, undoable or
      // MIDI-learnable.
      id: 'clouds-buffer',
      label: 'Ring buffer',
      kind: 'cell' as const,
      testidPrefix: 'clouds-buffer',
    },
  ],

  docs: {
    explanation:
      "A granular texture processor after Mutable Instruments' Clouds. It continuously records the incoming stereo audio into a short ring buffer, then sprays overlapping grains — tiny windowed snippets — out of that buffer to recombine the sound into a shimmering cloud, a smeared pad, a pitch-shifted drone, or a frozen ambient texture. POSITION picks where in the buffer the grains read from, SIZE sets each grain's length, DENSITY sets how many grains overlap, TEXTURE morphs the grain window from soft to hard, PITCH transposes the grains, and FREEZE latches the buffer so the texture keeps playing with no fresh input. BLEND crossfades the grain cloud against the dry signal. Mental model: it turns any source into a controllable swarm of micro-loops. IT IS SILENT WHEN YOU PATCH IT, and that is the module rather than a fault: the ring is empty at spawn, a grain always starts at least one grain-length behind the write head, and until the head has written that far there is nothing to read — so the wet path is bit-zero for exactly one grain length (300 ms at the shipped SIZE, 60 ms at SIZE 0, 1500 ms at the top) and then runs about 12 dB below its steady level until the whole 2-second ring has been written. Full level arrives at 2.0 s plus one more grain. The same silence recurs on every FREEZE taken before anything was recorded.",
    inputs: {
      in_l: 'Left channel of the stereo source continuously written into the granular ring buffer (unless FREEZE is engaged, which stops new writes).',
      in_r: 'Right channel of the stereo source written into the buffer alongside in_l. If unpatched it is normalled from in_l, so a mono source into in_l alone fills both halves of the buffer and the grain cloud comes back centred rather than hard-left.',
      pitch: 'V/oct pitch input that sums with the PITCH knob, transposing every grain — patch a sequencer or keyboard here to play the granular cloud melodically.',
      freeze_gate: 'A gate that toggles FREEZE on each rising edge: high-going flips the buffer between live-recording and frozen (looping the captured snapshot). Use it to capture a moment and hold the texture hands-free.',
      position_cv: 'CV that displaces the POSITION knob, sweeping the grain read-head through the buffer — modulate it for scanning/scrubbing textures.',
      size_cv: "CV that displaces the SIZE knob, modulating grain length (short grains = granular stutter, long grains = smooth smear).",
      pitch_cv: 'CV that displaces the PITCH knob in semitones (separate from the V/oct pitch input, which sums on top).',
      density_cv: 'CV that displaces the DENSITY knob, modulating how many grains spawn — sweep it for swelling/thinning clouds.',
      texture_cv: 'CV that displaces the TEXTURE knob, morphing the grain-window shape (soft Hann-like to hard rectangular).',
      blend_cv: 'CV that displaces the BLEND knob, modulating the dry/wet balance.',
    },
    outputs: {
      out_l: 'Left channel of the overlap-add granular output (the summed, normalised cloud of all active grains), blended with the dry input per BLEND.',
      out_r: 'Right channel of the granular output, blended with the dry input per BLEND.',
    },
    controls: {
      position: 'Playhead position into the recorded buffer (0..1): where grains are sampled from. Sweep it to scrub through the captured audio; with FREEZE on it scans the held snapshot.',
      size: "Grain length (0..1), mapped exponentially onto 60 ms at 0 through 1500 ms at 1. Short grains give a fine granular stutter/buzz; long grains overlap into a smooth, time-stretched smear. THE WHOLE TRAVEL IS LIVE — until #1456 a grain was capped at 800 ms while the dial still asked for 1500, so its top 19.5 % rendered bit-identical output; the ceiling is now the law's own top. Two consequences of a long grain, both real and neither obvious: the module is bit-silent for one grain length after a spawn or a clear (1.5 s at the top of this dial), and POSITION's reachable window is the ring MINUS one grain, so it shrinks from 1.94 s of travel at SIZE 0 to 0.50 s at SIZE 1.",
      pitch: 'Per-grain pitch shift in semitones (-24..+24). Sums with the V/oct PITCH input; pitch the grains up for shimmer, down for sub-octave drones.',
      density: 'How densely grains are triggered (0..1). Low density leaves audible gaps (sparse, pointillist); high density packs grains into a continuous wash.',
      texture: 'Grain-window shape macro (0..1): morphs the envelope each grain fades in/out with, from a soft rounded window (gentle, smooth) to a harder edge (grittier, more pronounced grain attacks).',
      blend: 'Dry / wet balance (0..1): 0 passes the input through, 1 is the granular cloud only, between crossfades the two.',
      freeze: 'Freeze toggle (0/1): when 1, the module stops writing new audio into the buffer and loops the captured snapshot, so the texture sustains indefinitely with no fresh input. A LATCH — it stays engaged where you leave it, and clicking again releases it. Mirrored by the FREEZE button on the card and by the FRZ gate input, which toggles the same latch on each rising edge. Freezing before anything has been recorded holds the buffer at digital silence.',
      'clouds-buffer-{n}': 'The RING BUFFER picture: two seconds of tape drawn newest-first, with the read window POSITION selects, one bar per concurrent grain, and the near band no grain can start inside (a grain always begins at least one grain-length behind the write head). It is the only surface that shows what POSITION does, because POSITION changes the output waveform completely while moving its level by 0.17 dB — every level-based reading of this control says it is dead. Drawn from the live macros through the grain scheduler’s own laws, so it says what the cloud IS reading rather than tracing what came out.',
    },
  },

  // ── THE FACEPLATE ─────────────────────────────────────────────────────────
  //
  // Authored from what this module IS: a granular TEXTURE processor — a
  // two-second ring buffer sprayed back out as up to 24 overlapping grains.
  //
  // ⚠ THE ARGUMENT FOR THIS FACE IS NOT THAT ANYTHING IS BROKEN. clouds has no
  // dead controls in the ordinary sense, and it is the best-behaved module in
  // its batch on level (0 of 54 measured corners exceed full scale; the worst
  // is −0.10 dBFS, against sidecar's +17.98 and resofilter's +44.4). What it
  // has is INVISIBILITY, three times over, and every instance is invisible to
  // the exact instruments the repo would reach for:
  //
  //   1 · IT IS SILENT WHEN YOU PATCH IT. Bit-zero for one grain length, then
  //       ~12 dB down until the ring has filled. Nothing anywhere said so — not
  //       the def, not the manifest, not the card — and "I patched it and
  //       nothing happened" is the correct description of its first second.
  //   2 · POSITION IS THE STRONGEST CONTROL AND NO LEVEL METRIC CAN SEE IT.
  //       0.17 dB of span across the whole travel on broadband; max|Δ| 0.99
  //       against a marked source, i.e. an entirely different waveform at every
  //       setting. An RMS sweep would stay green if it broke tomorrow.
  //   3 · PITCH IS A ~10.6 dB FADER AT ZERO. Not a slope — a THRESHOLD:
  //       −5.47 dB at pitch 0 against −17.60 at ±0.5 st, a detune no player
  //       would call a transposition.
  //
  // So the face is the fix. Its readouts are DERIVED (clouds-face-model), never
  // a knob relabelled, and each is negative-controlled on the input a knob
  // readback would be blind to — permanently, in clouds-face-model.test.ts,
  // with ORACLE legs that re-derive the claim from `cloudsMath` so a DSP change
  // reddens a stale sentence instead of leaving the faceplate insisting on it.
  //
  // ⚠ IT ALSO REFUSED TO PAINT ONE CONTROL AS WORKING, AND THAT WORKED. The
  // face shipped with a `CLAMPED` badge on SIZE's top 19.50 % — `safeLen =
  // min(lengthSamples, 0.4·bufLen)` capped the grain at 800 ms while the dial
  // asked for 1500, so 0.805 / 0.85 / 0.9 / 1.0 rendered BIT-IDENTICAL output —
  // and a bit-identity oracle pinned that claim to the DSP so a fix would turn
  // it red. #1456 fixed it (the ceiling is derived from the law now), the
  // oracle went red as designed, and the badge is gone. What replaced it is the
  // inverse assertion, against the SHIPPING WORKLET rather than the mirror:
  // art/scenarios/clouds/size-travel.test.ts renders the whole top of the dial
  // and requires every step to differ, with the OLD ceiling kept alive as the
  // negative control so "all different" can never quietly become vacuous.
  face: {
    // 1-6 are the LANE budget (faceTierCap('full') = 6). BLEND leads because
    // this is a processor that is inaudible for its first moments and BLEND is
    // the control that tells you whether you are hearing it at all; DENSITY
    // second (the largest real span, 8.80 dB); PITCH third because the 10.6 dB
    // step at zero is the module's most surprising behaviour.
    //
    // ⚠ POSITION IS RANKED 5, NOT HIGHER, AND THE DEMOTION IS THE POINT. It is
    // the strongest control on the module — and at a 192×180 lane tile it would
    // show as a dial that does nothing, because what it changes cannot be a
    // number. It is promoted to the DOCK hero instead, beside the one picture
    // that can show it.
    //
    // Rank 7 for the panel: module-face-lint refuses a PANEL selected at a lane
    // tier, and the cap is 6, so a hero picture's first legal rank is 7. Eight
    // keys total, so it is reachable.
    order: [
      'blend',
      'density',
      'pitch',
      'size',
      'position',
      'freeze',
      'clouds-buffer-{n}',
      'texture',
    ],

    // THREE BANDS. The split is the module's own: the TAPE (what is recorded
    // and where you read it), the GRAIN SCHEDULER (how many, how long, what
    // shape), and the OUTPUT (transpose + crossfade).
    //
    // ⚠ BAND 1 KEEPS ITS LABEL DOING REAL WORK. `face.title`, `face.hint` and
    // every band `hint` are ANNOTATION — `facePageHeader` returns null and
    // `bandHeaderPlan` blanks the hint unless the switch is on — so a band
    // LABEL is one of the few surfaces on a faceplate that always paints. The
    // two-second fact lives there and in the readouts, never in a hint.
    // (41 characters. The longest band label shipped anywhere in the repo is
    // 46; measured rendered width is checked in clouds-face.spec.ts, because a
    // CSS ellipsis leaves no trace in `textContent` and faces-parity reads
    // exactly that.)
    pages: [
      {
        id: 'buffer',
        label: '1 · the ring — 2 s, and it must FILL',
        hint:
          'Measured from spawn: BIT-ZERO for exactly one grain length (300 ms at the shipped SIZE, ' +
          '60 ms at SIZE 0, 1.5 s at the top), then ~12 dB down until the whole 2.0 s ring has ' +
          'been written, reaching full level one grain after that. FREEZE latches the buffer so ' +
          'the texture keeps playing with no input — and freezing BEFORE anything has been ' +
          'recorded holds it at digital silence.',
        controls: ['clouds-buffer-{n}', 'position', 'freeze'],
      },
      {
        id: 'grains',
        label: '2 · the grains — a pool of 24',
        hint:
          'DENSITY is the spawn rate (6/s to 1200/s) and SIZE the grain length, and together they ' +
          'fill a pool of 24: at the shipped SIZE the pool is FULL from DENSITY 0.49, so the top ' +
          'half of that dial spawns grains that are DROPPED — it changes the sound completely ' +
          '(max|Δ| 0.73–0.96) and the level by 0.07 dB. SIZE runs 60 ms to 1500 ms and every step ' +
          'of it is live — its top 19.5 % was bit-identical to maximum until #1456 raised the ' +
          'grain ceiling to meet the law. TEXTURE’s upper half is worth 0.01 dB.',
        controls: ['density', 'size', 'texture'],
      },
      {
        id: 'out',
        label: '3 · pitch — 0 is a detent — and blend',
        hint:
          'At PITCH 0 every grain reads the buffer at exactly the write rate, so the grains stay ' +
          'phase-coherent and sum linearly; anywhere else they decorrelate and sum in power. The ' +
          'step is a THRESHOLD, not a slope — ≈10.6 dB, and ±0.5 st already costs all of it. ' +
          'BLEND dips 1.05 dB BELOW dry around 0.2–0.25 where the partly-decorrelated wet ' +
          'cancels the dry it is crossfading against; BLEND 0 is bit-exact dry.',
        controls: ['pitch', 'blend'],
      },
    ],

    // A VuMeter on `out`. Not a scope: this is an INSERT, so a lane tile is
    // looking at a module that is silent until something is patched through it
    // — and how hot the wet cloud is running is the one thing a 64 px tile can
    // honestly say. (Deterministic for the mixer/reverb reason, not the
    // analogVco one: with nothing patched both outputs are exactly zero, so the
    // meter is unlit and the tile would baseline cleanly even without #1420's
    // audio freeze.)
    glyph: 'meter',

    title: 'Texture',
    hint:
      'A 2-second ring buffer sprayed back out as up to 24 overlapping grains. It is bit-silent ' +
      'for one grain length after you patch it and ~12 dB down until the ring has filled at ' +
      '2.0 s. POSITION changes the sound completely and the level by 0.17 dB. PITCH is not just ' +
      'a transpose: at 0 the grains are phase-coherent, and leaving zero in either direction ' +
      'costs about 10.6 dB.',

    // THE HERO. The picture, POSITION promoted beside it at XL, and the three
    // numbers that are not on any dial.
    //
    // ⚠ NO `action`. clouds is an insert with nothing to strike — its "play me"
    // affordance is FREEZE, which is a real param and is ranked. An audition
    // cell here would be a second implementation of a control the def owns.
    hero: {
      cell: 'clouds-buffer-{n}',
      control: 'position',
      // ⚠ ALL THREE DERIVED, and each because the nearest knob is blind to
      // something that genuinely changes the answer:
      //
      //   reads  — a `paramId: 'position'` readout prints 0.50 at every SIZE,
      //            while the reachable span shrinks from 1.94 s to 0.50 s and
      //            the read point moves 1.03 s → 1.75 s. It is the number that
      //            makes the module's most invisible control legible at all.
      //            (That span is WIDER since #1456, because POSITION's window is
      //            the ring minus one grain and the grain now reaches 1.5 s —
      //            the same readout, one more thing it is right about.)
      //   grain  — a `paramId: 'size'` readout prints 0.50 for a 300 ms grain,
      //            says nothing about the 60…1500 ms law behind it, and cannot
      //            express that a transposed grain covers a DIFFERENT amount of
      //            tape than it sounds for (the two clocks differ by
      //            2^(pitch/12), and the value names its frame for that reason).
      //   pitch  — a `paramId: 'pitch'` readout prints `0.50 st` for a detune
      //            that costs the FULL ~10.6 dB, because coherence is a
      //            threshold and a semitone readback is a slope.
      readouts: [
        { label: 'reads', valueId: 'clouds-position-reach' },
        { label: 'grain', valueId: 'clouds-grain-ms' },
        { label: 'pitch', valueId: 'clouds-coherence' },
      ],
    },

    sidebar: [
      {
        kind: 'readouts',
        // THE TWO SECONDS, as numbers rather than as a moving picture. The
        // panel cannot draw a filling ring honestly — `fillLevel` is not an
        // AudioParam and the worklet posts nothing, so there is no observable
        // to read, and a clock-derived head would make the VRT baseline a race
        // against boot time (see clouds-face-model's ring-plan note). These say
        // the same thing without needing a clock, and both MOVE with SIZE.
        label: 'the two seconds',
        entries: [
          { label: 'silent for', valueId: 'clouds-silence' },
          { label: 'full level at', valueId: 'clouds-full-level' },
          { label: 'grain pool', valueId: 'clouds-grain-count' },
          // MEASURED, not derived, and the model test re-derives it from
          // `cloudsMath` on every run so it cannot go stale. A first-principles
          // coherence ratio (10·log10(N·E[env]²/E[env²])) reads 12.55 dB here
          // and is 4.7 dB out at TEXTURE 0, because it does not model the
          // output tanh — a confident wrong number is worse than a constant
          // that says which setting it was taken at.
          { label: 'pitch ≠ 0', text: '≈ −10.6 dB (defaults)' },
          { label: 'blend 0', text: 'bit-exact dry' },
        ],
      },
    ],

    // REAR CARD. The derivation already puts each CV hole on the band holding
    // the param it targets, so only the audio-rate ticks need declaring: in_l /
    // in_r / pitch / freeze_gate are worklet NODE inputs (the factory wires
    // them to inputs 0-3), not AudioParam connections like the six `*_cv`
    // holes.
    rear: {
      audioRate: ['in_l', 'in_r', 'pitch', 'freeze_gate'],
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = createWorkletNode(node, ctx, 'clouds', {
      numberOfInputs: 4,
      numberOfOutputs: 2,
      outputChannelCount: [1, 1],
    });

    // Liveness pin on input 0 ONLY. A ConstantSource on input 1 makes Chrome
    // hand the processor a (silent) channel for input 1 forever, which defeats
    // the DSP's `inputs[1]?.[0] ?? inputs[0]?.[0]` mono normal and renders an
    // unpatched R as digital silence. Enforced by mono-normal-not-defeated.test.ts.
    const silenceL = ctx.createConstantSource();
    silenceL.offset.value = 0;
    silenceL.start();
    silenceL.connect(workletNode, 0, 0);

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of cloudsDef.params) {
      if (def.id === 'freeze') continue;
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    // ── THE FREEZE LATCH, AND THE HOST MIRROR IT NEEDS ──────────────────────
    //
    // `freeze` is NOT a level the worklet reads. The processor ORs the param
    // with the FRZ gate input and TOGGLES an internal flag on each RISING EDGE
    // (packages/dsp/src/clouds.ts) — so the host's job is to send one pulse per
    // intended STATE CHANGE, and the state lives in the worklet.
    //
    // ⚠ THE OLD `setParam` PULSED ON EVERY WRITE, WHATEVER THE VALUE, which
    // makes `freeze` the one param on this module where writing the value it
    // already has is not a no-op — it INVERTS it. Any route that re-states the
    // current value (a preset recall, an automation lane resending 0, a
    // duplicate sync write, a MIDI-learned CC bouncing) silently freezes a
    // running buffer or thaws a held one, with the card still painting the old
    // state. Fixed here rather than in the DSP: the seam is a host-side
    // protocol, so the mirror belongs host-side.
    //
    // ⚠ WHAT THE MIRROR STILL CANNOT SEE, stated rather than hidden: a cable
    // patched into `freeze_gate` toggles the SAME worklet flag as a node input,
    // and no host-side reader reaches a worklet node input. So after a gate
    // edge the mirror is inverted relative to the engine until the next host
    // write re-syncs it. That is irreducible without a worklet-side report and
    // it is not new — `readParam('freeze')` previously answered `undefined`,
    // which is the same blindness with no value at all.
    let freezeLatched = ((node.params ?? {})['freeze'] ?? 0) >= 0.5;
    /** ONE rising edge. `holdS` is 50 ms at spawn (the worklet may not have
     *  pulled a block yet, and an a-rate ramp shorter than one render quantum
     *  can be stepped over) and 5 ms thereafter, which is the original code's
     *  split preserved rather than an inconsistency. */
    const pulseFreeze = (holdS: number): void => {
      params.get('freeze')?.setValueAtTime(1, ctx.currentTime);
      params.get('freeze')?.setValueAtTime(0, ctx.currentTime + holdS);
    };
    if (freezeLatched) pulseFreeze(0.05);

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['in_l',        { node: workletNode, input: 0 }],
        ['in_r',        { node: workletNode, input: 1 }],
        ['pitch',       { node: workletNode, input: 2 }],
        ['freeze_gate', { node: workletNode, input: 3 }],
        ['position_cv', { node: workletNode, input: 0, param: params.get('position')! }],
        ['size_cv',     { node: workletNode, input: 0, param: params.get('size')! }],
        ['pitch_cv',    { node: workletNode, input: 0, param: params.get('pitch')! }],
        ['density_cv',  { node: workletNode, input: 0, param: params.get('density')! }],
        ['texture_cv',  { node: workletNode, input: 0, param: params.get('texture')! }],
        ['blend_cv',    { node: workletNode, input: 0, param: params.get('blend')! }],
      ]),
      outputs: new Map([
        ['out_l', { node: workletNode, output: 0 }],
        ['out_r', { node: workletNode, output: 1 }],
      ]),
      setParam(paramId, value) {
        if (paramId === 'freeze') {
          // ONE PULSE PER STATE CHANGE — see the mirror note above. Re-writing
          // the value it already holds must be a no-op, or a preset recall
          // inverts the latch.
          const want = value >= 0.5;
          if (want === freezeLatched) return;
          freezeLatched = want;
          pulseFreeze(0.005);
          return;
        }
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        // The host MIRROR, not the AudioParam: the a-rate `freeze` param is a
        // 5 ms pulse that rests at 0, so reading it back answered 0 while the
        // buffer was held (it used to answer `undefined` for that reason).
        if (paramId === 'freeze') return freezeLatched ? 1 : 0;
        return params.get(paramId)?.value;
      },
      dispose() {
        try { silenceL.stop(); } catch { /* */ }
        try { silenceL.disconnect(); } catch { /* */ }
        try { workletNode.disconnect(); } catch { /* */ }
      },
    };
  },
};

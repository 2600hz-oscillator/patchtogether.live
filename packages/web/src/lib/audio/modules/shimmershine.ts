// packages/web/src/lib/audio/modules/shimmershine.ts
//
// SHIMMERSHINE — stereo shimmer reverb. Pure-TS AudioWorklet wraps a
// Schroeder reverb tank (4 combs + 2 allpasses per channel) with a
// pitch-shifted feedback loop (+12 semis via granular fade) for the
// signature crystalline shimmer tail. Use it as the project's "ambient
// halo" reverb: the plain REVERB with an octave-up regeneration loop
// bolted onto its tank, which is the module's defining feature.
//
// Inputs:
//   in_l / in_r (audio): stereo input (separate, identically-tuned tanks;
//     the channels never cross-feed). NOTE: the worklet's `inputs[1]?.[0] ??
//     inputs[0]?.[0]` mono fallback is DEAD in practice — the factory wires a
//     0-valued ConstantSource into BOTH worklet inputs, so Chrome always hands
//     input 1 a (silent) channel and in_r never normals from in_l. Verified in
//     Chrome; an unpatched in_r = a silent right tank.
//   decay_cv (cv, linear, paramTarget=decay): displaces the decay macro.
//   shimmer_cv (cv, linear, paramTarget=shimmer): displaces the octave-up feedback amount.
//   size_cv (cv, linear, paramTarget=size): displaces the comb-feedback macro.
//   mix_cv (cv, linear, paramTarget=mix): displaces dry/wet mix.
//   (No damp_cv — DAMP is the one param with no CV jack.)
//   All four params are k-rate in the worklet, so every CV jack is read once
//   per 128-sample render quantum (block-rate, NOT audio-rate).
//
// Outputs:
//   out_l / out_r (audio): stereo wet+dry output, dry*(1-mix) + tankWet*mix.
//
// Params:
//   decay (linear 0..1, default 0.6): multiplies SIZE's comb feedback —
//     effSize = size * (0.5 + 0.5*decay). Inert when size = 0.
//   shimmer (linear 0..1, default 0.4): +1 octave feedback amount (knob*0.55
//     into the loop, tanh-saturated) — the shimmer tail intensity.
//   size (linear 0..1, default 0.6): comb feedback 0.70..0.88. Does NOT
//     rescale the delay lines — the tank's geometry is fixed at build time.
//   damp (linear 0..1, default 0.4): one-pole LP inside each comb's feedback
//     path. At 1 the LP state freezes at 0 and the tank feedback stops.
//   mix (linear 0..1, default 0.4): dry/wet balance.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/shimmershine.js?url';

const loadedContexts = new WeakSet<BaseAudioContext>();

// ----------------------------------------------------------------------------
// Pure DSP helpers — reflected from the worklet (packages/dsp/src/shimmershine.ts)
// so unit tests can exercise the pitch-shifter math + full signal chain in
// node (the worklet itself can't be imported from node because it references
// the AudioWorkletGlobalScope-only `AudioWorkletProcessor` base class at
// module load). Any change here MUST mirror the worklet implementation.
// ----------------------------------------------------------------------------

const COMB_LENGTHS_44 = [1116, 1188, 1277, 1356];
const ALLPASS_LENGTHS_44 = [556, 441];

class _CombLP {
  buf: Float32Array;
  idx = 0;
  fbStore = 0;
  constructor(len: number) { this.buf = new Float32Array(len); }
  tick(x: number, fb: number, damp: number): number {
    const y = this.buf[this.idx]!;
    this.fbStore = this.fbStore * damp + y * (1 - damp);
    this.buf[this.idx] = x + this.fbStore * fb;
    this.idx = (this.idx + 1) % this.buf.length;
    return y;
  }
}

class _Allpass {
  buf: Float32Array;
  idx = 0;
  constructor(len: number) { this.buf = new Float32Array(len); }
  tick(x: number): number {
    const stored = this.buf[this.idx]!;
    const out = -x + stored;
    this.buf[this.idx] = x + stored * 0.5;
    this.idx = (this.idx + 1) % this.buf.length;
    return out;
  }
}

class _SchroederTank {
  combs: _CombLP[];
  allpasses: _Allpass[];
  constructor(sr: number) {
    const scale = sr / 44100;
    this.combs = COMB_LENGTHS_44.map((n) => new _CombLP(Math.max(8, Math.round(n * scale))));
    this.allpasses = ALLPASS_LENGTHS_44.map(
      (n) => new _Allpass(Math.max(8, Math.round(n * scale))),
    );
  }
  tick(x: number, size: number, damp: number): number {
    // Comb feedback range 0.70..0.88 — pulled back from 0.92 so the
    // worst-case combination (size=1, damp=0, decay=1) is still stable
    // when summed across 4 parallel combs + a shimmer feedback loop.
    const fb = 0.70 + 0.18 * size;
    let y = 0;
    for (const c of this.combs) y += c.tick(x, fb, damp);
    y *= 0.25;
    for (const a of this.allpasses) y = a.tick(y);
    return y;
  }
}

class _GranularPitchShifter {
  buf: Float32Array;
  writeIdx = 0;
  headOffsetA: number;
  headOffsetB: number;
  windowSamples: number;
  rate: number;
  constructor(sr: number, rate: number, windowMs: number) {
    this.windowSamples = Math.max(64, Math.round((windowMs / 1000) * sr));
    this.rate = rate;
    this.buf = new Float32Array(this.windowSamples * 4);
    // headOffsetA starts at W (full window behind write — phase 0 in the
    // window, zero crossfade gain at startup so silence comes out cleanly).
    // headOffsetB starts at W/2 (mid-window, peak gain) so it carries the
    // signal while A is at the window edge.
    this.headOffsetA = this.windowSamples;
    this.headOffsetB = this.windowSamples * 0.5;
  }
  private cosWindow(phase: number): number {
    return 0.5 * (1 - Math.cos(2 * Math.PI * phase));
  }
  private readAt(pos: number): number {
    const len = this.buf.length;
    let p = pos % len;
    if (p < 0) p += len;
    const i0 = Math.floor(p);
    const i1 = (i0 + 1) % len;
    const frac = p - i0;
    return this.buf[i0]! * (1 - frac) + this.buf[i1]! * frac;
  }
  tick(x: number): number {
    this.buf[this.writeIdx] = x;
    const W = this.windowSamples;
    // For pitch UP (rate > 1) the read heads must walk forward faster than
    // the write head — i.e. they approach the write head over time, so the
    // headOffset (distance behind write) SHRINKS by (rate - 1) per tick.
    // When the read head catches up (headOffset crosses 0) we wrap it back
    // by W samples; the partner head, offset by W/2, covers the wrap with
    // its mid-window crossfade gain.
    const a = this.readAt(this.writeIdx - this.headOffsetA);
    const b = this.readAt(this.writeIdx - this.headOffsetB);
    // Phase = (W - headOffset) / W within the [0..W] envelope window.
    const phaseA = 1 - this.headOffsetA / W;
    const phaseB = 1 - this.headOffsetB / W;
    const gA = this.cosWindow(phaseA);
    const gB = this.cosWindow(phaseB);
    const out = a * gA + b * gB;
    const delta = this.rate - 1;
    this.headOffsetA -= delta;
    this.headOffsetB -= delta;
    // Wrap: when offset drops below 0 (caught up to write), jump back W.
    if (this.headOffsetA <= 0) this.headOffsetA += W;
    if (this.headOffsetB <= 0) this.headOffsetB += W;
    this.writeIdx = (this.writeIdx + 1) % this.buf.length;
    return out;
  }
}

/** Pure helpers for unit tests + ART scenarios. The actual audio runs in
 *  the worklet at packages/dsp/src/shimmershine.ts; this mirror keeps the
 *  same math reachable from node. */
export const shimmershineMath = {
  hannWindow(phase: number): number {
    return 0.5 * (1 - Math.cos(2 * Math.PI * phase));
  },
  renderPitchShifter(
    input: Float32Array,
    sr: number,
    rate: number,
    windowMs: number,
  ): Float32Array {
    const shifter = new _GranularPitchShifter(sr, rate, windowMs);
    const out = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) {
      out[i] = shifter.tick(input[i]!);
    }
    return out;
  },
  renderShimmer(
    input: Float32Array,
    sr: number,
    params: { decay: number; shimmer: number; size: number; damp: number; mix: number },
  ): Float32Array {
    const tank = new _SchroederTank(sr);
    const shifter = new _GranularPitchShifter(sr, 2.0, 25);
    const out = new Float32Array(input.length);
    const effSize = params.size * (0.5 + 0.5 * params.decay);
    const FB_CAP = 0.55;
    const fbGain = params.shimmer * FB_CAP;
    let fb = 0;
    for (let i = 0; i < input.length; i++) {
      const dry = input[i]!;
      // tanh-limit the tank input too — a defensive cap on what the
      // combs can ever see, so even with damp=0 + size=1 + ongoing
      // input the recirculating energy can't blow past ±1.
      const wet = Math.tanh(tank.tick(dry + fb, effSize, params.damp));
      const shifted = shifter.tick(wet);
      fb = Math.tanh(shifted * fbGain);
      out[i] = dry * (1 - params.mix) + wet * params.mix;
    }
    return out;
  },
};

export const shimmershineDef: AudioModuleDef = {
  type: 'shimmershine',
  palette: { top: 'Audio modules', sub: 'Effects' },
  domain: 'audio',
  label: 'shimmershine',
  category: 'effects',
  stereoPairs: [['in_l', 'in_r'], ['out_l', 'out_r']],

  inputs: [
    { id: 'in_l',       type: 'audio' },
    { id: 'in_r',       type: 'audio' },
    // CV scaling per .myrobots/plans/cv-range-standard.md — all linear 0..1.
    { id: 'decay_cv',   type: 'cv', paramTarget: 'decay',   cvScale: { mode: 'linear' } },
    { id: 'shimmer_cv', type: 'cv', paramTarget: 'shimmer', cvScale: { mode: 'linear' } },
    { id: 'size_cv',    type: 'cv', paramTarget: 'size',    cvScale: { mode: 'linear' } },
    { id: 'mix_cv',     type: 'cv', paramTarget: 'mix',     cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'out_l', type: 'audio' },
    { id: 'out_r', type: 'audio' },
  ],
  params: [
    { id: 'decay',   label: 'Decay',   defaultValue: 0.6, min: 0, max: 1, curve: 'linear' },
    { id: 'shimmer', label: 'Shimmer', defaultValue: 0.4, min: 0, max: 1, curve: 'linear' },
    { id: 'size',    label: 'Size',    defaultValue: 0.6, min: 0, max: 1, curve: 'linear' },
    { id: 'damp',    label: 'Damp',    defaultValue: 0.4, min: 0, max: 1, curve: 'linear' },
    { id: 'mix',     label: 'Mix',     defaultValue: 0.4, min: 0, max: 1, curve: 'linear' },
  ],

  // ── RACKLINE FACE (P1 batch 2) ────────────────────────────────────────────
  // DESIGNED from intent, not transcribed from the old five-fader card.
  //
  // You reach for SHIMMERSHINE over REVERB or CLOUDSEED for exactly one
  // reason: the octave-up regeneration loop. So the hero ladder leads with it
  //   mini    (1) → shimmer — the identity knob. Its travel takes the module
  //                  from "plain Schroeder room" to "self-sustaining
  //                  crystalline drone", so it is the one control that has to
  //                  survive down to the smallest tile.
  //   compact (3) → + mix, decay — how much of it you hear, how long it rings
  //                  (the cloudseed FX archetype's wet/dry blend at rank 2).
  //   full    (8) → + size, damp — the tank completed.
  //
  // Dock bands follow SIGNAL FLOW, the same way the cloudseed face does: the
  // tank the dry hits first, then the pitch-shifted feedback loop that taps
  // it, then the output blend. Three small bands (rather than one roster) is
  // what makes the rear jack field legible — the CV holes land under the stage
  // they steer.
  //
  // GLYPH = 'meter' (live RMS off out_l via the shell's analyser tap). The
  // perceptual signature of this module is the TAIL — whether it is fading,
  // blooming, or (past ~half SHIMMER) refusing to stop — and an RMS meter is
  // the only glyph that reads that at 84 px. A waveform trace of a diffuse
  // reverb wash is visual mush, and there is no assigned shape to derive a
  // DUAL param-wave from (this is a processor, not a shape-identity source).
  face: {
    order: ['shimmer', 'mix', 'decay', 'size', 'damp'],
    pages: [
      { id: 'tank',    label: 'reverb tank',  controls: ['decay', 'size', 'damp'] },
      { id: 'shimmer', label: 'shimmer loop', controls: ['shimmer'] },
      { id: 'output',  label: 'output blend', controls: ['mix'] },
    ],
    glyph: 'meter',
    // REAR CARD curation (rear-card-model). Derivation already files each
    // per-param CV hole under its target's page band, so the only exception is
    // the leading input band: name it by FUNCTION ('stereo in') instead of the
    // generic derived 'signal'. Deliberately NO `audioRate` entries — every
    // parameterDescriptor in the worklet is k-rate, so all four CV jacks are
    // consumed once per 128-sample render quantum; a `~` tick would be a lie.
    rear: {
      groups: [{ id: 'signal', label: 'stereo in', ports: ['in_l', 'in_r'] }],
    },
  },

  docs: {
    explanation:
      "A stereo shimmer reverb: a plain Schroeder tank wired into an octave-up regeneration loop. Each channel gets its own tank — four parallel comb filters, each with a one-pole lowpass in its feedback path, then two series allpasses for diffusion (the first four of Freeverb's comb tunings and its first two allpasses — 1116/1188/1277/1356 and 556/441 samples at 44.1 kHz, rescaled to the running sample rate). What makes it SHIMMER is what happens to the tank's output: it is fed through a +12-semitone granular pitch shifter (two read heads chasing the write head at 2× speed, cosine-crossfaded over a 25 ms window to hide each wrap) and summed back into the tank input, so every trip round the loop transposes the tail up another octave and a held note grows a rising ladder of octaves above itself. Only the tank output is blended to the outs, so the shimmer never touches the direct sound — it emerges in the tail, tens of milliseconds behind the note. The loop gain is hard-capped at 0.55 with a tanh saturator on each side of it, which bounds the LEVEL but not the SUSTAIN: with SHIMMER off this is a modest room (roughly a 0.7–1.7 s RT60 across the whole DECAY / SIZE / DAMP space), and past about the middle of SHIMMER's travel the loop stops decaying and settles into a continuous, level-bounded crystalline drone. Left and right run independent, identically-tuned tanks with no cross-feed, so it faithfully passes on the stereo image it is given rather than synthesising width. Patch it as a stereo insert and ride MIX, or feed it from an aux send with MIX at 1.",
    inputs: {
      in_l: 'Left channel of the stereo input. It is summed with the loop’s pitch-shifted feedback and drives the LEFT reverb tank; left and right are separate, identically-tuned tanks that never cross-feed.',
      in_r: 'Right channel of the stereo input, driving the right-hand tank on the same signal path. It is NOT normalled from IN L: leaving this jack empty means the right tank sees silence, so a mono source patched to IN L alone comes back hard-left — split it to both inputs if you want the halo centred.',
      decay_cv:
        'CV that displaces the DECAY knob. Linear on a 0–1 param: ±1 moves it by up to ±0.5 and pins at the ends. The worklet’s params are k-rate, so this is sampled once per 128-sample render quantum (~2.7 ms at 48 kHz) — automate swelling and collapsing tails with it, not audio-rate modulation.',
      shimmer_cv:
        'CV that displaces SHIMMER, the octave-up feedback amount (±1 = ±0.5 of the 0–1 range, block-rate). The expressive jack: an envelope here blooms the halo per note, and since the loop turns self-sustaining past roughly half travel, a slow LFO walks the tail in and out of a drone.',
      size_cv:
        'CV that displaces SIZE, modulating the tank’s comb feedback — how long and dense the tail is, not how big the delay lines are (they are fixed), so sweeping it changes ring time without any pitch artifact. ±1 = ±0.5 of the 0–1 range, block-rate.',
      mix_cv:
        'CV that displaces MIX, the dry/wet crossfade (±1 = ±0.5 of the 0–1 range, block-rate) — patch an envelope or LFO for ducked or pumping wet swells. The tank and the shimmer loop keep running whatever MIX is doing, so the tail is already there when the CV brings the wet back up.',
    },
    outputs: {
      out_l:
        'Left output: dry × (1 − MIX) + left-tank wet × MIX. The wet half is the TANK output, so the octave-up shimmer only reaches here after it has recirculated — the direct signal is never pitch-shifted. That tank output is tanh-limited, so however hard the loop is driven the wet half stays inside ±1.',
      out_r:
        'Right output — the same blend computed on the right-hand tank, which keeps entirely separate comb, allpass and pitch-shifter state. The two sides never cross-feed and the two tanks are tuned identically, so the module adds no width of its own: the field that comes out is exactly as wide as the one you patched in.',
    },
    controls: {
      decay:
        'Stretches the tail. DECAY and SIZE multiply internally — the tank’s comb feedback is set by size × (0.5 + 0.5 × decay) — so this scales SIZE’s effect rather than setting an absolute time, and with SIZE at 0 it does nothing at all. With SHIMMER off, the whole DECAY / SIZE plane spans roughly a 0.7–1.7 s RT60: it is a room control, not an infinite-reverb control (that is what SHIMMER is for).',
      shimmer:
        "The module's signature: how much of the tank's output is transposed +1 octave and fed back into it. At 0 this is a plain Schroeder reverb. Turn it up and each recirculation stacks another octave, so a held note grows a rising crystalline ladder above itself. The loop gain is the knob × 0.55 with a tanh saturator on both sides, so the LEVEL is always bounded — but the sustain is not: past roughly half travel (earlier with DECAY and SIZE up and DAMP down) the loop stops decaying and rings on as a continuous drone until you pull the knob back. Even at the 0.4 default the tail keeps a faint halo that very slowly blooms rather than fading to nothing.",
      size:
        'Sets the tank’s comb feedback — 0.70 with SIZE at 0, rising to 0.88 with SIZE and DECAY both wide open — which reads as a longer, denser, more sustained space. It does NOT resize the room: the comb and allpass delay lines are fixed at build time, so the tank’s timbre and modal colour stay put and only the ring time changes. Nothing is being re-tuned, so you can sweep it without the pitch artifact a real delay-length morph would give.',
      damp:
        'High-frequency damping — a one-pole lowpass inside each comb’s feedback path, so every recirculation comes back a little darker than the last. That is what keeps the stacked octaves from turning brittle. At 0 the tail stays bright and rings longest; raising it both darkens and shortens the tail; at 1 the lowpass is fully closed (its state freezes at zero), which stops the comb feedback outright and collapses the reverb to a short diffuse burst of about 0.2 s. The only control with no CV jack.',
      mix:
        'The dry/wet crossfade at the output: out = dry × (1 − mix) + wet × mix. 0 is the untouched input, 1 is wet only, in between is a straight linear blend. The tank and the shimmer loop run regardless of where MIX sits, so a tail — or a drone — you built at MIX 1 is still ringing when you bring the knob back up. Insert use lives around the 0.4 default; on an aux send put it at 1.',
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = new AudioWorkletNode(ctx, 'shimmershine', {
      numberOfInputs: 2,
      numberOfOutputs: 2,
      outputChannelCount: [1, 1],
    });

    const silenceL = ctx.createConstantSource();
    const silenceR = ctx.createConstantSource();
    silenceL.offset.value = 0;
    silenceR.offset.value = 0;
    silenceL.start();
    silenceR.start();
    silenceL.connect(workletNode, 0, 0);
    silenceR.connect(workletNode, 0, 1);

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of shimmershineDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }
    const pDecay = params.get('decay');
    const pShimmer = params.get('shimmer');
    const pSize = params.get('size');
    const pMix = params.get('mix');

    return {
      domain: 'audio',
      inputs: new Map([
        ['in_l',       { node: workletNode, input: 0 }],
        ['in_r',       { node: workletNode, input: 1 }],
        ['decay_cv',   { node: workletNode, input: 0, param: pDecay! }],
        ['shimmer_cv', { node: workletNode, input: 0, param: pShimmer! }],
        ['size_cv',    { node: workletNode, input: 0, param: pSize! }],
        ['mix_cv',     { node: workletNode, input: 0, param: pMix! }],
      ]),
      outputs: new Map([
        ['out_l', { node: workletNode, output: 0 }],
        ['out_r', { node: workletNode, output: 1 }],
      ]),
      setParam(paramId, value) {
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      dispose() {
        try { silenceL.stop(); } catch { /* */ }
        try { silenceR.stop(); } catch { /* */ }
        silenceL.disconnect();
        silenceR.disconnect();
        workletNode.disconnect();
      },
    };
  },
};

// packages/web/src/lib/audio/modules/destroy.ts
//
// DESTROY — bitcrusher / sample-rate decimator. The grungy lo-fi effect
// the project ships under that name. Faust-compiled DSP
// (packages/dsp/src/destroy.dsp) — three controls: SR decimation (1..64;
// hold every Nth sample), bit-depth reduction (1..16 bits), and a wet/
// dry mix. Pull DECIMATE up for a slo-mo grainy aliasing texture; pull
// BITS down for thick quantization grit; the WET knob keeps the dry
// signal blendable so it works as a parallel-distortion send too.
//
// Inputs:
//   audio (audio): dry signal.
//   decimate (cv, linear, paramTarget=decimate): displaces the SR-decimation count.
//   bits (cv, linear, paramTarget=bits): displaces the bit-depth target.
//   wet (cv, linear, paramTarget=wet): displaces wet/dry mix.
//
// Outputs:
//   audio (audio): destroyed signal.
//
// Params:
//   decimate (linear 1..64, default 1): hold each sample for round(N) samples
//     (1 = pristine). ROUND, not truncate — #1716.
//   bits (linear 1..16, default 16): quantization bit depth (16 = pristine).
//   wet (linear 0..1, default 1): dry/wet mix (0 = dry, 1 = wet).

import { instantiateFaustModule } from '$lib/audio/faust-runtime';
import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import wasmUrl from '@patchtogether.live/dsp/dist/destroy.wasm?url';
import metaUrl from '@patchtogether.live/dsp/dist/destroy.json?url';
import workletUrl from '@patchtogether.live/dsp/dist/destroy.worklet.js?url';

const PARAM_PREFIX = '/DESTROY';

export const destroyDef: AudioModuleDef = {
  type: 'destroy',
  palette: { top: 'Audio modules', sub: 'Effects' },
  domain: 'audio',
  label: 'destroy',
  category: 'effects',
  inputs: [
    { id: 'audio',    type: 'audio' },
    // CV scaling per docs/adr/004-cv-range-convention.md.
    // decimate: linear (1..64; cv=±1 sweeps ±31.5 from knob).
    // bits: linear (1..16).
    // wet: linear (0..1).
    { id: 'decimate', type: 'cv', paramTarget: 'decimate', cvScale: { mode: 'linear' } },
    { id: 'bits',     type: 'cv', paramTarget: 'bits',     cvScale: { mode: 'linear' } },
    { id: 'wet',      type: 'cv', paramTarget: 'wet',      cvScale: { mode: 'linear' } },
  ],
  outputs: [{ id: 'audio', type: 'audio' }],
  params: [
    // `Decimate`, not `Dec`: this card said one and the def said the other, and
    // the divergence sat in `VOCABULARY_DEBT` until this PR. A face PR is that
    // ledger's release condition — `ModuleShell` renders the dock full view
    // straight off the `ParamDef`, so from promotion onward the DEF's label is
    // the name a player learns. The def took the CARD's wording (the
    // charlottesEchos precedent), so no pixel moved and nothing was renamed.
    { id: 'decimate', label: 'Decimate', defaultValue: 1,  min: 1, max: 64, curve: 'linear' },
    { id: 'bits',     label: 'Bits',     defaultValue: 16, min: 1, max: 16, curve: 'linear' },
    { id: 'wet',      label: 'Wet',      defaultValue: 1,  min: 0, max: 1,  curve: 'linear' },
  ],

  // ── PF-20 — THE FACEPLATE ───────────────────────────────────────────────
  //
  // WHAT THIS MODULE IS FOR, in one sentence: it is the rack's RESOLUTION
  // control — the only place a player lowers a signal's sample rate and its
  // bit depth, the two axes of digital resolution, independently. The verb is
  // "coarsen", and the module's identity is that its two stages are audibly
  // DIFFERENT KINDS of damage: DECIMATE damages TIME (a fold frequency, and
  // aliases that come back down as wrong pitches), BITS damages LEVEL (a noise
  // floor, and a dead zone that swallows quiet material whole).
  //
  // THE RANK, measured on the shipping wasm through `art/setup/faust-offline`
  // (`art/scenarios/destroy/face-audit.test.ts`), one metric for both dials —
  // the RMS of (output − dry) over the settled tail, i.e. how far from clean:
  //
  //   1 decimate  99.2 dB of travel (−101.1 → −1.86 dBFS on broadband) AND it
  //               is the TIMBRAL axis: it drags the spectral centroid from
  //               11 906 Hz to 4 393 Hz, a −7 513 Hz collapse.
  //   2 bits      90.3 dB of travel (−101.1 → −10.8 dBFS) over the same
  //               source, but the centroid moves +99 Hz — it raises a floor,
  //               it does not change the colour. It owns the module's biggest
  //               surprise (the dead zone) rather than its biggest sound.
  //   3 wet       LAST, and not because it is small: because AT THE SHIPPED
  //               DEFAULTS IT DOES NOTHING AT ALL. decimate 1 + bits 16 is a
  //               transparent chain, so sweeping WET 0 → 1 moves the output by
  //               less than the float32 noise floor. It is an amount, and
  //               there is nothing to have an amount of until one of the two
  //               above is moved.
  //
  // TIER LADDER, as a sentence: the mini tile is DECIMATE, because that is the
  // axis this module is named for; the compact tile is DECIMATE + BITS beside
  // the trace, which is the whole instrument; the plate and the dock add WET
  // and the readout row.
  //
  // NO `pages`. Three params, one of them promoted to the hero, leaves two —
  // and a band header over "BITS, WET" would have to be a word that covers a
  // quantiser and a crossfade, which is a word that means nothing. The single
  // `__all` band is the honest shape (the illogic / ninelives precedent).
  //
  // NO `sidebar`, DECLARED ABSENT rather than forgotten. A staircase picture
  // is the obvious candidate and it would restate what the `scope` glyph draws
  // LIVE — the stair-step IS this module's output, unlike `filter`, whose
  // sidebar exists because a scope cannot show a frequency response.
  //
  // NO `hero.action`: an insert has nothing to audition without an input, and
  // synthesising a test signal would be a DSP change in a face wave.
  face: {
    order: ['decimate', 'bits', 'wet'],

    // ⚠ ESTABLISHED, NOT ASSUMED. This module declares one `audio` output, so
    // `primaryAudioOutPortId` returns 'audio' and every glyph literal but
    // 'none' resolves `{ kind: 'live-audio' }` — the live analyser trace. That
    // is checked by calling both functions in `destroy-face-model.test.ts`
    // rather than by trusting this comment.
    //
    // 'scope' rather than the FX-family default 'meter', ON A MEASUREMENT: a
    // level meter is INVARIANT TO THIS MODULE'S PRIMARY CONTROL. Across the
    // whole DECIMATE travel the output RMS moves 0.12 dB on broadband noise
    // and 0.00 dB on a sine (−6.11 dBFS at DECIMATE 1 and at 64 alike), while
    // the error-vs-dry over the same travel moves 99.2 dB. A meter here would
    // be a dead indicator over the dial a player is turning. A trace shows the
    // stair-step and the collapsed grid, which is the module doing its job.
    //
    // Like every other insert's trace it is a flat line on a silent rack —
    // this module makes no sound of its own — and #1420's pre-frame graph
    // freeze is what makes that deterministic.
    glyph: 'scope',

    // THE HERO. DECIMATE is PROMOTED out of the band, not copied
    // (`heroFacePlan` removes it, so the param multiset faces-parity asserts
    // is unchanged).
    //
    // ⚠ ALL FOUR READOUTS ARE DERIVED AND NONE IS A DIAL RELABELLED. Each is
    // negative-controlled PERMANENTLY, on the input its nearest dial is blind
    // to, in `destroy-face-model.test.ts`; the arithmetic is anchored to the
    // real compiled wasm in `art/scenarios/destroy/face-audit.test.ts`:
    //
    //   rate    the reciprocal of the dial, through an INTEGER hold length.
    //           `48.0 kHz` at DECIMATE 1, `750 Hz` at 64. Invariant to BITS
    //           and WET. This readout is why the face exists, and #1716 is why
    //           the rounding in it is load-bearing rather than cosmetic.
    //   stream  bits × rate, in kbit/s — the ONE number that moves with both
    //           crush dials, so it is neither one's relabel. `768` at the
    //           defaults, `24` at DECIMATE 8 / BITS 4.
    //   floor   where the bit stage's artefact sits, `20log10(wet · step/√12)`
    //           — a JOIN with WET, and the ONLY readout WET moves at all.
    //           Matched the wasm within 0.09 dB at every corner measured.
    //   mute    the level below which the quantiser outputs EXACTLY ZERO,
    //           `−6.02 × bits` dBFS. `floor`'s control on WET: WET moves the
    //           floor by 20log10(wet) and moves this by nothing.
    hero: {
      control: 'decimate',
    },
  },

  docs: {
    explanation:
      "A bitcrusher / sample-rate decimator — the project's grungy lo-fi destroyer, and the only module that lowers a signal's RESOLUTION on its two axes independently. Two classic digital-degradation stages run in series on the input: DECIMATE holds every Nth sample (a sample-rate reduction that adds aliasing and a slo-mo grainy texture), and BITS quantizes the amplitude to fewer bits (the gritty, steppy crunch of low bit-depth). A WET knob crossfades the mangled signal against the clean dry, so it doubles as a parallel-distortion send. THREE THINGS TO KNOW BEFORE YOU PATCH IT, all measured on the shipping compiled DSP (art/scenarios/destroy/face-audit.test.ts). First, THE TWO STAGES DO DIFFERENT KINDS OF DAMAGE AND ONLY ONE OF THEM IS TIMBRAL. Over its full travel DECIMATE drags the spectral centroid of broadband material from 11906 Hz down to 4393 Hz; BITS over its full travel moves the same number by 99 Hz. BITS does not make a signal darker or brighter, it raises a noise floor underneath it and eventually swallows it. Second, ABOVE THE FOLD FREQUENCY YOUR PITCH IS WRONG, NOT JUST GRAINY. Decimation is a real sample-rate reduction with no anti-alias filter, so the effective rate is 48000/N and anything above half of that folds back down as a DIFFERENT note: at DECIMATE 8 (6.0 kHz effective) a 5 kHz tone comes out at 1 kHz, 13.8 dB LOUDER than the 5 kHz you played. The faceplate prints the effective rate live as `rate`. Third, BITS HAS A DEAD ZONE AND IT IS A CLIFF. The quantizer rounds to the nearest step, so any input under half a step becomes exactly zero: below -6.0 dBFS at 1 bit, -24.1 dBFS at 4 bits, -48.2 dBFS at 8 bits. Measured at 1 bit, a source 1.2x over the threshold leaves at -4.3 dBFS and one at 0.98x of it leaves at -99.0 dBFS. Quiet passages and reverb tails do not get grittier, they disappear; the faceplate prints that threshold as `mute`. All three controls are CV-patchable for rhythmic crush sweeps.",
    inputs: {
      audio: 'The dry signal fed into the decimator + bit-reducer chain. Also passed to the dry side of the WET blend.',
      decimate: 'CV that displaces the DECIMATE knob (linear), modulating the sample-rate reduction — patch an envelope or LFO for rhythmic aliasing sweeps. A ±1V CV sweeps roughly ±31 steps from the knob position.',
      bits: 'CV that displaces the BITS knob (linear), modulating the quantization depth live.',
      wet: 'CV that displaces the WET knob, modulating the dry/wet crush amount.',
    },
    outputs: {
      audio:
        "The processed (destroyed) signal blended with the dry input per WET. It is UNITY-GAIN in level terms and that is worth knowing before you reach for a meter to set it up: across DECIMATE's entire 1..64 travel the output RMS moves 0.12 dB on broadband noise and 0.00 dB on a sine, so a level meter is blind to the module\'s primary control (which is why the faceplate\'s glyph is a TRACE, not a meter). BITS moves it a little more (1.8 dB) and non-monotonically. The signal is also never bit-identical sample to sample even inside a held plateau, because the WET smoothing leaves a residual dry path 89.8 dB down: compare output samples with a tolerance, never for equality.",
    },
    controls: {
      decimate:
        "Sample-rate decimation (1..64, default 1): hold every Nth input sample. 1 is pristine; higher values drop the effective sample rate to 48000/N for aliasing artifacts and a coarse, downsampled grain. THE DIAL IS CONTINUOUS AND THE HOLD IS AN INTEGER, so the value is ROUNDED to the nearest whole sample — a CV that lands at 7.4 holds 7 samples and one at 7.6 holds 8. (It used to TRUNCATE, which made every integer position one step short and DECIMATE 2 a bit-exact no-op; #1716.) THE ONE THING TO WATCH is the fold frequency, half the effective rate: 24 kHz at DECIMATE 1, 3 kHz at 8, 375 Hz at 64. There is no anti-alias filter, so material above the fold does not vanish, it comes back down as a different pitch — measured at DECIMATE 8, a 5 kHz tone leaves at 1 kHz 13.8 dB louder than its own fundamental. The faceplate prints the effective rate as `rate` and the resulting data rate (bits x rate) as `stream`.",
      bits:
        "Quantization bit depth (1..16, default 16): 16 is pristine; lower values quantize the amplitude to a grid of 2^bits steps for the thick, steppy crunch of a low-bit converter. IT IS NOT A TONE CONTROL — over its whole travel it moves the spectral centroid of broadband material by 99 Hz, against DECIMATE's 7513 Hz. What it moves is the noise floor: the crush artifact sits at 20log10(step/sqrt(12)), i.e. -101 dBFS at 16 bits, -52.9 at 8, -28.8 at 4, -10.8 at 1 (measured within 0.09 dB of that closed form at every depth). AND IT HAS A DEAD ZONE, which is the thing nothing else says: the quantizer rounds to the nearest step, so any input below half a step (-6.02 x bits dBFS) becomes EXACTLY ZERO. That is -24.1 dBFS at 4 bits and -6.0 dBFS at 1, and it is a cliff rather than a fade — at 1 bit a source 1.2x over the threshold leaves at -4.3 dBFS and one at 0.98x leaves at -99.0. So `1 bit` is near-square-wave destruction for loud material and a hard mute for anything quiet. The faceplate prints both edges, as `floor` and `mute`.",
      wet:
        "Dry / wet mix (0..1, default 1): 0 is the clean input, 1 is the fully crushed signal, between blends them — useful as a parallel-distortion amount. It is a true crossfade over the ERROR: the output is dry + wet x (crushed - dry), so halving WET drops the crush artifact by exactly 6.02 dB and leaves the dry signal at full level (measured -28.8 dBFS at WET 1 and -34.8 at WET 0.5, 4 bits). AT THE SHIPPED DEFAULTS IT DOES NOTHING, because DECIMATE 1 + BITS 16 is a transparent chain and there is nothing to blend against; it becomes a control the moment either of the other two is moved. Two smaller notes: the crushed path's dead zone is unaffected by WET (a sub-threshold input still quantizes to zero, it just arrives through the dry side instead), and the internal smoothing on this control never quite reaches its endpoint, so at WET 1 a residual dry signal survives 89.8 dB down — inaudible, but it is why output samples inside a held plateau are never bit-identical and must be compared with a tolerance.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const f = await instantiateFaustModule(ctx, { name: 'destroy', wasmUrl, metaUrl, workletUrl }, node);
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    silence.connect(f);
    const params = f.parameters as unknown as Map<string, AudioParam>;
    for (const def of destroyDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(`${PARAM_PREFIX}/${def.id}`)?.setValueAtTime(v, ctx.currentTime);
    }
    const pDecimate = params.get(`${PARAM_PREFIX}/decimate`);
    const pBits     = params.get(`${PARAM_PREFIX}/bits`);
    const pWet      = params.get(`${PARAM_PREFIX}/wet`);
    return {
      domain: 'audio',
      inputs: new Map([
        ['audio',    { node: f, input: 0 }],
        ['decimate', { node: f, input: 0, param: pDecimate! }],
        ['bits',     { node: f, input: 0, param: pBits! }],
        ['wet',      { node: f, input: 0, param: pWet! }],
      ]),
      outputs: new Map([['audio', { node: f, output: 0 }]]),
      setParam(paramId, value) {
        params.get(`${PARAM_PREFIX}/${paramId}`)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(`${PARAM_PREFIX}/${paramId}`)?.value;
      },
      dispose() {
        try { silence.stop(); } catch { /* already stopped */ }
        silence.disconnect();
        f.disconnect();
      },
    };
  },
};

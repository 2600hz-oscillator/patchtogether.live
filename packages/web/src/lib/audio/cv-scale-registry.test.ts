// packages/web/src/lib/audio/cv-scale-registry.test.ts
//
// Belt-and-suspenders pin: confirm that every module's CV-typed input port
// EITHER carries a `cvScale` hint OR is an intentional "passthrough" case
// (i.e. the destination DSP scales internally — filter.dsp). This catches
// regressions where a new CV port lands without scaling and a future LFO
// connection touches only ~10% of the slider's range.

import { describe, it, expect } from 'vitest';
import '$lib/audio/modules'; // side-effect: register all modules
import { listModuleDefs } from '$lib/audio/module-registry';

// Modules whose CV input(s) intentionally omit cvScale because the
// destination DSP (Faust .dsp source) implements its own ±1-cv-sweeps-
// full-musical-range mapping. New entries here MUST be justified in
// .myrobots/plans/cv-range-standard.md.
const PASSTHROUGH_BY_DESIGN: Record<string, string[]> = {
  // filter.dsp: cutoffCv → pow(2, 5*cv) ±5 octaves; resCv: additive clamp.
  filter: ['cutoff', 'res'],
  // wavviz.wavePos: audio-rate input (no paramTarget); not subject to scaling.
  wavviz: ['wavePos'],
  // wavetableVco.wavePos: same as wavviz — audio-rate input, no paramTarget.
  wavetableVco: ['wavePos'],
  // moog921Vco.width_cv: same shape as wavetableVco.wavePos — the worklet
  // sums the WIDTH knob + this CV per-sample (audio-rate), NOT through the
  // CV→AudioParam fast-path, so cvScale wouldn't apply. The width param is
  // already bounded 0.02..0.98 and the per-sample sum is clamped to that
  // range in the worklet, so a ±1 CV sweeps the full duty-cycle range.
  moog921Vco: ['width_cv'],
  // moog904a.{cutoff_cv,reso_cv}: audio-rate summing CONTROL INPUTS. The
  // worklet sums knob + CV per-sample (cutoff_cv via a 1V/oct exponential
  // map, reso_cv additively, both clamped to range) — NOT through the
  // CV→AudioParam fast-path, so cvScale wouldn't apply (same shape as the
  // 921's width_cv).
  moog904a: ['cutoff_cv', 'reso_cv'],
  // dx7.pitch_cv: V/oct (audio-rate), not a knob param.
  dx7: ['pitch_cv'],
  // helm.{pitch_cv,gate,midi_in,seq_reset}: pitch_cv = V/oct fallback
  // (audio-rate); gate = trigger fallback; midi_in = visual-only
  // placeholder (the actual MIDI flows through the Web MIDI API, not
  // through a cable, so this port never carries audio data); seq_reset =
  // gate trigger that snaps the step pointer back to -1 (next gate →
  // step 0). All four are stuck-without-paramTarget by design — same
  // shape as dx7's fallback inputs.
  helm: ['pitch_cv', 'gate', 'midi_in', 'seq_reset'],
  // illogic in1..in4: passthrough attenuverter inputs (the module IS the attenuverter).
  illogic: ['in1', 'in2', 'in3', 'in4'],
  // unityscalemathematik u_in / a_in / b_in: signal inputs that the module
  // ITSELF shapes via attenuvert + (for A/B) curve. These are audio-rate
  // node connections to the worklet, not CV->AudioParam routings, so
  // cvScale doesn't apply. The atten/curve CV ports do carry cvScale.
  unityscalemathematik: ['u_in', 'a_in', 'b_in'],
  // cartesian x_cv/y_cv: address-selector signals (-1..+1 = full grid select).
  cartesian: ['x_cv', 'y_cv'],
  // VCA.cv: audio-rate gain control. base + cvAmount * cv with cvAmount knob
  // already implementing per-edge depth control. Not a CV→AudioParam case.
  vca: ['cv'],
  // SCOPE has a separate, pre-existing bug: setParam stores into a JS-side
  // params record but the engine's CV-routing writes to a stub gain1.gain
  // AudioParam the module never reads. Adding cvScale here would not fix
  // that bug — it'd modulate the wrong AudioParam. SCOPE's CV→param routing
  // needs an architectural fix (separate PR — see
  // .myrobots/plans/cv-range-standard.md "Deferred" section).
  scope: ['timeMs', 'ch1Scale', 'ch1Offset', 'ch1Range', 'ch2Scale', 'ch2Offset', 'ch2Range', 'mode'],
  // RASTERIZE: same architecture as SCOPE — CV inputs route through the
  // cross-domain CV bridge's setParam(portId), which writes into a JS-side
  // params record (read live by the per-frame painter). The `param`
  // (inGain.gain) on each input is only a stub sink so the engine's
  // per-param tap analyser fires for motorized faders; the module never
  // reads it. Interposing a cvScale WaveShaper would scale the wrong
  // AudioParam and do nothing to the value reaching setParam. The raster
  // params (cursor px, samples/frame, gain, wrap) are consumed raw by the
  // mapping math, which is the intended "untamed" behaviour for this module.
  rasterize: ['cursor', 'samplesPerFrame', 'gain', 'wrap'],
  // BUGGLES: clock_cv / chaos_cv have NO paramTarget — they're sampled into
  // a JS shadow on each woggle event (setTimeout-driven), not routed onto
  // an AudioParam. The CV's -1..+1 range is summed onto the rate/chaos
  // shadow values in the woggle scheduler itself, so the wogglebug semantic
  // (CV pushes the knob ±half-its-natural-range) is implemented inside the
  // module rather than by interposing a WaveShaperNode. Adding cvScale would
  // do nothing — there's no AudioParam fast path to scale.
  buggles: ['clock_cv', 'chaos_cv'],
  // STEREOVCA strength_l/r: raw bipolar carrier consumed directly in the
  // per-sample multiply (out = in * (strength + offset) * level). No
  // scaling — slow CV gives tremolo, audio-rate CV gives ring modulation.
  stereovca: ['strength_l', 'strength_r'],
  // VEILS cv1..cv4: per-channel gain CV summed directly with the gain knob
  // inside the worklet's per-sample multiply. The gain knob's natural
  // range is [0, 2], so a ±1V LFO at unity-knob already swings the
  // effective gain from 0 to 2 — already a full natural-range sweep.
  // Applying cvScale 'linear' would compute scale = (max-min)/2 = 1.0
  // and pass the CV through unchanged anyway.
  veils: ['cv1', 'cv2', 'cv3', 'cv4'],
  // ATTENUMIX cv1..cv4: per-channel attenuator CV summed with the knob
  // inside the worklet's per-sample multiply (then clamp 0..1). The
  // attenuator's natural range is [0, 1], so a ±1V LFO at knob=0 already
  // sweeps full range (clamp drops the negative half, the positive half
  // opens the channel). A `linear` cvScale would compute (1-0)/2 = 0.5
  // and HALVE the LFO's reach — strictly worse than passthrough.
  attenumix: ['cv1', 'cv2', 'cv3', 'cv4'],
  // BLADES voct1/voct2 + cutoff1_cv/cutoff2_cv: these are audio-rate
  // node inputs that the worklet itself maps onto octaves via
  // pow(2, voct + cv*5). Interposing a WaveShaperNode here would
  // double-process the signal (the worklet already applies a musical
  // octave mapping). The res_cv / color_cv / mix_mode_cv ports DO carry
  // cvScale because they route via the AudioParam fast path.
  blades: ['voct1', 'voct2', 'cutoff1_cv', 'cutoff2_cv'],
  // PONG paddle_left / paddle_right: CV is sampled per scheduler-tick into
  // a JS-side stepper (paddleCvToY maps -1..+1 → 0..1 paddle Y). No
  // AudioParam fast path — the CV doesn't modulate any knob, it IS the
  // paddle position. Same shape as BUGGLES.clock_cv / chaos_cv above.
  pong: ['paddle_left', 'paddle_right'],
  // SM64 stick_x_cv / stick_y_cv: bipolar CV sampled per scheduler-tick
  // into a JS-side stepper (cvToStickValue maps -1..+1 → ±64 N64-native).
  // No AudioParam fast path — the CV doesn't modulate any knob, it IS the
  // analog stick position handed to the sm64js bundle's playerInput
  // global. Same shape as PONG's paddle CVs above.
  sm64: ['stick_x_cv', 'stick_y_cv'],
  // MIDI-OUT-BUDDY pitch / velocity: CV sampled at the gate rising edge in a
  // JS-side scheduler-tick (AnalyserNode tap), then converted to a MIDI note
  // number (V/oct → nearest semitone) / velocity (0..1 → 1..127). No
  // AudioParam fast path — the CV doesn't modulate a knob, it IS the outgoing
  // MIDI note/velocity. Same shape as PONG / SM64's stepper CVs above.
  midiOutBuddy: ['pitch', 'velocity'],
  // ANALOGLOGICMATHS a / b: raw bipolar signal inputs consumed directly by
  // the worklet's per-sample MIN/MAX/DIFF/SUM/PRODUCT. The module IS the
  // shaper — the user attenuverts via the attA / attB knobs (which DO carry
  // cvScale on their respective _cv ports). No AudioParam fast path on
  // a / b themselves, and the math is amplitude-preserving by design.
  analogLogicMaths: ['a', 'b'],
  // WAVESCULPT pitch_cv1..4: per-oscillator V/oct inputs that the module IS
  // the oscillator for — pitch is consumed directly in the per-voice osc
  // graph (oscillator.frequency.value = midiToHz(60 + cv*60)). No AudioParam
  // fast path / WaveShaperNode interposition would apply meaningfully — the
  // V/oct mapping is intrinsic to the module. Same shape as DX7.pitch_cv.
  wavesculpt: ["pitch_cv1", "pitch_cv2", "pitch_cv3", "pitch_cv4"],
  // NUMPAD+ layer: CV value 0..1 selects the active layer (0..3) via
  // round(cv*4). Consumed directly in the module's tick() — not
  // routed onto an AudioParam, so cvScale doesn't apply. Same shape
  // as cartesian's address-selector inputs.
  numpadPlus: ['layer'],
  // SLEWSWITCH in1..in4: raw CV signals routed through the worklet's
  // per-channel one-pole slewer. The module IS the smoother — no
  // AudioParam fast path / cvScale would apply. The slew*_cv ports
  // (which DO target the slew{N} AudioParam) carry cvScale.
  slewSwitch: ['in1', 'in2', 'in3', 'in4'],
  // ATLANTISCATALYST seed_cv: bias-direction input read directly by the
  // JS orchestrator each tick (sampled into the next-scene picker).
  // Same shape as buggles.chaos_cv — no AudioParam fast path.
  atlantisCatalyst: ['seed_cv'],
  // GRIDS map/density/chaos/swing CV: sampled into a JS shadow each
  // scheduler tick (most-recent analyser sample → unitToByte → 0..255
  // pattern parameter), then summed onto the corresponding knob inside
  // the pattern engine. There's no AudioParam fast path — the CV value IS
  // a pattern coordinate / fill / randomness amount, not a knob modulator
  // routed through a WaveShaperNode. Same shape as cartesian's x_cv/y_cv
  // address selectors + buggles.chaos_cv.
  grids: ['mapX_cv', 'mapY_cv', 'bdDensity_cv', 'sdDensity_cv', 'hhDensity_cv', 'chaos_cv', 'swing_cv'],
  // 4PLEXER in1..in4: raw signal inputs (audio OR cv) routed straight to
  // the selected output by the worklet's per-output select — they are the
  // signal being switched, NOT a knob modulator, so there is no AudioParam
  // fast path and cvScale doesn't apply. Same shape as SLEWSWITCH.in1..in4.
  // The gate1..gate4 advance inputs are `gate`-typed and so aren't checked.
  fourplexer: ['in1', 'in2', 'in3', 'in4'],
  // CHOWKICK pitch_cv: 1V/oct pitch CV consumed directly by the worklet —
  // freq *= 2^pitch_cv applied per-sample. Same shape as dx7.pitch_cv and
  // helm.pitch_cv: a V/oct fallback input with no paramTarget (a freq
  // AudioParam additive cvScale would NOT be 1V/oct, so we route the
  // pitch CV as its own audio-rate node input + apply the octave map
  // inside the per-sample DSP).
  chowkick: ['pitch_cv'],
  // CUBE pitch: V/oct input consumed directly by the worklet as its own
  // audio-rate node input (freq = C4·2^(pitch + tune/12 + fine/1200), applied
  // per-sample). No paramTarget — same V/oct-fallback shape as dx7.pitch_cv /
  // chowkick.pitch_cv. CUBE's OTHER cv inputs (slice_y/rx/ry/rz, morph_fc,
  // connect, crush, tune) DO have paramTarget + cvScale:linear; only the raw
  // V/oct pitch is passthrough-by-design.
  cube: ['pitch'],
};

describe('cv-scale / registry coverage', () => {
  it('every module CV input either has cvScale or is in PASSTHROUGH_BY_DESIGN', () => {
    const offenders: Array<{ module: string; port: string; reason: string }> = [];
    for (const def of listModuleDefs()) {
      if (def.domain !== 'audio') continue;
      for (const port of def.inputs) {
        if (port.type !== 'cv') continue;
        if (port.cvScale) continue; // explicit hint present
        const passthroughOk = PASSTHROUGH_BY_DESIGN[def.type as string] ?? [];
        if (passthroughOk.includes(port.id)) continue;
        offenders.push({
          module: def.type as string,
          port: port.id,
          reason: port.paramTarget
            ? `cv → AudioParam (${port.paramTarget}) without cvScale; LFO ±1 will sum directly into param.value, sweeping only the param's "intrinsic ± 1" slice rather than its full natural range. Either add cvScale: { mode: 'linear'|'log'|'discrete' } or document as PASSTHROUGH_BY_DESIGN with a justification.`
            : 'cv input without paramTarget; if it modulates a knob, add paramTarget + cvScale. Otherwise add to PASSTHROUGH_BY_DESIGN with the rationale.',
        });
      }
    }
    expect(
      offenders,
      `Modules with CV inputs lacking cvScale (and not in PASSTHROUGH_BY_DESIGN):\n` +
        offenders.map((o) => `  - ${o.module}.${o.port}: ${o.reason}`).join('\n'),
    ).toEqual([]);
  });

  it('every cvScale.paramTarget points at a real param', () => {
    const broken: Array<{ module: string; port: string; paramTarget: string }> = [];
    for (const def of listModuleDefs()) {
      if (def.domain !== 'audio') continue;
      for (const port of def.inputs) {
        if (!port.cvScale || !port.paramTarget) continue;
        const param = def.params.find((p) => p.id === port.paramTarget);
        if (!param) {
          broken.push({
            module: def.type as string,
            port: port.id,
            paramTarget: port.paramTarget,
          });
        }
      }
    }
    expect(broken).toEqual([]);
  });
});

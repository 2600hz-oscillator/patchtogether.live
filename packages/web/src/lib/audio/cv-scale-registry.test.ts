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
  // dx7.pitch_cv: V/oct (audio-rate), not a knob param.
  dx7: ['pitch_cv'],
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
  // ANALOGLOGICMATHS a / b: raw bipolar signal inputs consumed directly by
  // the worklet's per-sample MIN/MAX/DIFF/SUM/PRODUCT. The module IS the
  // shaper — the user attenuverts via the attA / attB knobs (which DO carry
  // cvScale on their respective _cv ports). No AudioParam fast path on
  // a / b themselves, and the math is amplitude-preserving by design.
  analogLogicMaths: ['a', 'b'],
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

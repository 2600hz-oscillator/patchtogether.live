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

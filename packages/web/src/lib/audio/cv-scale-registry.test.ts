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
  // polarizer/depolarizer/negativity: 1-in/1-out CV-math UTILITIES — `in` is the
  // signal being transformed directly (out = f(in): polarizer 2·in−1, depolarizer
  // in/2+0.5, negativity −in), NOT a knob modulator routed onto an AudioParam (the
  // DEPTH knob, where present, is a separate control). So cvScale doesn't apply —
  // same shape as moog992's passive CV panel.
  polarizer: ['in'],
  depolarizer: ['in'],
  negativity: ['in'],
  // moog992 cv1..cv4: a passive CV PANEL — these inputs are the signals being
  // attenuated + summed into cv_out (no paramTarget, not modulating a knob), so
  // cvScale doesn't apply. The per-channel attenuator knobs scale them.
  moog992: ['cv1', 'cv2', 'cv3', 'cv4'],
  // moog993 env_in1/env_in2: a passive routing panel — envelope CV passes
  // straight through to env_out1/2 (no paramTarget); not scaled.
  moog993: ['env_in1', 'env_in2'],
  // moog962 in1..in3: a sequential SWITCH — the inputs are the signals being
  // routed to `out` (no paramTarget, not modulating a knob), so cvScale doesn't
  // apply. The shift gate advances which one passes.
  moog962: ['in1', 'in2', 'in3'],
  // filter.dsp: cutoffCv → pow(2, 5*cv) ±5 octaves; resCv: additive clamp.
  filter: ['cutoff', 'res'],
  // wavetableVco.wavePos: audio-rate input (no paramTarget); not subject to scaling.
  wavetableVco: ['wavePos'],
  // moog921Vco.width_cv: same shape as wavetableVco.wavePos — the worklet
  // sums the WIDTH knob + this CV per-sample (audio-rate), NOT through the
  // CV→AudioParam fast-path, so cvScale wouldn't apply. The width param is
  // already bounded 0.02..0.98 and the per-sample sum is clamped to that
  // range in the worklet, so a ±1 CV sweeps the full duty-cycle range.
  moog921Vco: ['width_cv'],
  // moogCp3.ext4: the 4th-input EXTERNAL jack — a raw signal (audio or cv)
  // summed with in4 then attenuated by the attenuator4 knob, all at audio-
  // rate inside the worklet. It's the SIGNAL being mixed, not a knob
  // modulator routed onto an AudioParam, so cvScale doesn't apply. Same
  // shape as slewSwitch.in1..in4 / fourplexer.in1..in4 (raw signal inputs
  // the module itself shapes).
  moogCp3: ['ext4'],
  // moog904a.{cutoff_cv,reso_cv}: audio-rate summing CONTROL INPUTS. The
  // worklet sums knob + CV per-sample (cutoff_cv via a 1V/oct exponential
  // map, reso_cv additively, both clamped to range) — NOT through the
  // CV→AudioParam fast-path, so cvScale wouldn't apply (same shape as the
  // 921's width_cv).
  moog904a: ['cutoff_cv', 'reso_cv'],
  // moog902.{cv,fcv}: audio-rate summing CONTROL INPUTS. The worklet builds
  // the control sum (gain knob + cvAmount*cv + fcv) per-sample and applies
  // the LIN/EXP gain-law map + x3 clamp itself — NOT through the CV→AudioParam
  // fast-path, so cvScale wouldn't apply (same shape as the 921's width_cv +
  // the 904A's cutoff_cv/reso_cv).
  moog902: ['cv', 'fcv'],
  // moog904b.cutoff_cv: audio-rate summing 1 V/oct CONTROL INPUT. The worklet
  // sums knob + CV per-sample, applying the 1 V/oct exponential map itself
  // (cutoffHz *= 2^cutoff_cv, then clamped 4..20000 Hz) — NOT through the
  // CV→AudioParam fast-path, so cvScale wouldn't apply (same shape as the
  // 904A's cutoff_cv: a 1 V/oct jack mapped inside the DSP).
  moog904b: ['cutoff_cv'],
  // moog921a.width_cv: audio-rate summing WIDTH CONTROL INPUT. The worklet
  // sums the WIDTH knob + this CV per-sample (clamped 0..1) onto width_bus —
  // NOT through the CV→AudioParam fast-path, so cvScale wouldn't apply (same
  // shape as the 921 VCO's width_cv). (freq_cv is `pitch`-typed → not checked.)
  moog921a: ['width_cv'],
  // moog921b.{freq_bus,width_bus}: audio-rate CONTROL INPUTS from a 921A driver
  // — the slave VCO reads them per-sample as ITS pitch (freq_bus, V/oct) and
  // pulse width (width_bus). They have NO paramTarget by design (no matching
  // knob — they ARE the slaved pitch/width supplied by the master driver), so
  // there's no AudioParam fast-path to scale. Same passthrough shape as the
  // 921 VCO's width_cv / dx7.pitch_cv (a raw control signal mapped in the DSP).
  moog921b: ['freq_bus', 'width_bus'],
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
  scope: ['timeMs', 'ch1Scale', 'ch1Offset', 'ch1Range', 'ch2Scale', 'ch2Offset', 'ch2Range', 'mode', 'intensity'],
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
  // PONG paddle_left / paddle_right: CV is sampled per scheduler-tick into
  // a JS-side stepper (paddleCvToY maps -1..+1 → 0..1 paddle Y). No
  // AudioParam fast path — the CV doesn't modulate any knob, it IS the
  // paddle position. Same shape as BUGGLES.clock_cv / chaos_cv above.
  pong: ['paddle_left', 'paddle_right'],
  // SKIFREE x / y: bipolar CV sampled per scheduler-tick into the bundle
  // controller's setCursor (cvToCanvasCoord maps -1..+1 → 0..canvas-px). No
  // AudioParam fast path — the CV doesn't modulate any knob, it IS the mouse-
  // cursor position the skier steers toward. Same shape as PONG's paddle CVs.
  skifree: ['x', 'y'],
  // MIDI-OUT-BUDDY pitch / velocity: CV sampled at the gate rising edge in a
  // JS-side scheduler-tick (AnalyserNode tap), then converted to a MIDI note
  // number (V/oct → nearest semitone) / velocity (0..1 → 1..127). No
  // AudioParam fast path — the CV doesn't modulate a knob, it IS the outgoing
  // MIDI note/velocity. Same shape as PONG's stepper CVs above.
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
  // SAMPLE & HOLD cv_in: the raw signal being sampled / quantized — consumed
  // directly by the worklet (latched on the gate edge, snapped to the scale
  // grid for cv_quant). It's NOT a knob modulator and has no paramTarget, so
  // there is no AudioParam fast path / WaveShaperNode interposition that would
  // apply. As a 1V/oct value any scaling would also corrupt the pitch
  // quantization. Same shape as SLEWSWITCH.in1..in4 + CUBE.pitch.
  sampleHold: ['cv_in'],
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
  // freq *= 2^pitch_cv applied per-sample. Same shape as dx7.pitch_cv:
  // a V/oct fallback input with no paramTarget (a freq
  // AudioParam additive cvScale would NOT be 1V/oct, so we route the
  // pitch CV as its own audio-rate node input + apply the octave map
  // inside the per-sample DSP).
  chowkick: ['pitch_cv'],
  // KICKDRUM pitch_cv: V/oct consumed directly by the worklet as its own
  // audio-rate node input (tune × 2^pitch_cv per-sample — an additive
  // AudioParam cvScale would NOT be 1V/oct). Same shape as chowkick.pitch_cv
  // / dx7.pitch_cv. accent_in: a raw per-hit 0..1 value SAMPLED at the
  // trigger edge inside the worklet (a latch input, not a knob modulator —
  // no paramTarget), so cvScale doesn't apply.
  kickdrum: ['pitch_cv', 'accent_in'],
  // SNARE DRUM pitch_cv / accent_in / roll_speed_cv: all consumed DIRECTLY by
  // the worklet as its own audio-rate node inputs, not AudioParams — pitch_cv is
  // V/oct (tune × 2^pitch_cv per-sample; an additive AudioParam cvScale would
  // NOT be 1V/oct), accent_in is a raw 0..1 value SAMPLED at each strike (a latch
  // input, no paramTarget), and roll_speed_cv is a 1V/oct multiply on the roll
  // rate consumed per-sample inside the roll engine. Same shape as
  // kickdrum.pitch_cv / accent_in and dx7/chowkick.pitch_cv.
  snaredrum: ['pitch_cv', 'accent_in', 'roll_speed_cv'],
  // CUBE pitch: V/oct input consumed directly by the worklet as its own
  // audio-rate node input (freq = C4·2^(pitch + tune/12 + fine/1200), applied
  // per-sample). No paramTarget — same V/oct-fallback shape as dx7.pitch_cv /
  // chowkick.pitch_cv. CUBE's OTHER cv inputs (slice_y/rx/ry/rz, morph_fc,
  // connect, crush, tune) DO have paramTarget + cvScale:linear; only the raw
  // V/oct pitch is passthrough-by-design.
  cube: ['pitch'],
  // HYPERCUBE (the 4D tesseract sibling of CUBE): identical V/oct pitch shape —
  // pitch is the raw audio-rate node input with no paramTarget. Its OTHER cv
  // inputs (slice_y/rx/ry/rz, morph_fc, connect, crush, fold_cv, ALPHA, tune)
  // all carry paramTarget + cvScale:linear; only the V/oct pitch is passthrough.
  hypercube: ['pitch'],
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

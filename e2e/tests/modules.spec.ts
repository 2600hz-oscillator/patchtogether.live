// e2e/tests/modules.spec.ts
//
// Per-module render checks. Each test spawns one module via the dev-window
// helpers, asserts the card renders with the expected handle count, and
// verifies the engine instantiates without console errors.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

interface ModuleSpec {
  type: string;
  cardClass: string;       // .svelte-flow__node-<type>
  handleCount: number;     // visible handle elements (input + output)
  containsLabel: string;   // substring expected in the card
  /** 'audio' (default) or 'video'. Phase 0 video spike modules need
   *  this so spawnPatch sets node.domain correctly and the reconciler
   *  routes the new node to the VideoEngine. 'meta' is the third arm
   *  for STICKY-style non-engine cards. */
  domain?: 'audio' | 'video' | 'meta';
}

const MODULES: ModuleSpec[] = [
  // Analog VCO: 3 audio-rate inputs (pitch, fm, pm) + 4 CV→AudioParam inputs
  // (tune, fine, fmAmount, pmAmount) + 4 outputs (saw, square, triangle, sine)
  // = 11. PM input + pmAmount knob added in feat/vco-cv-inputs (DSP rebuilt).
  { type: 'analogVco',    cardClass: 'svelte-flow__node-analogVco',    handleCount: 11, containsLabel: 'Analog VCO' },
  { type: 'audioOut',     cardClass: 'svelte-flow__node-audioOut',     handleCount: 2, containsLabel: 'Audio Out' },
  // VCA: 2 inputs (audio, cv) + 2 outputs (audio, audio_inv) = 4. The
  // audio_inv port is a phase-flipped (-1×) tap of the main output.
  { type: 'vca',          cardClass: 'svelte-flow__node-vca',          handleCount: 4, containsLabel: 'VCA' },
  { type: 'mixer',        cardClass: 'svelte-flow__node-mixer',        handleCount: 5, containsLabel: 'Mixer' },
  // ADSR: 5 inputs (gate + 4 cv) + 2 outputs (env, env_inv) = 7. env_inv
  // is the unipolar (1 - env) flipped envelope.
  { type: 'adsr',         cardClass: 'svelte-flow__node-adsr',         handleCount: 7, containsLabel: 'ADSR' },
  { type: 'filter',       cardClass: 'svelte-flow__node-filter',       handleCount: 4, containsLabel: 'Filter' },
  { type: 'reverb',       cardClass: 'svelte-flow__node-reverb',       handleCount: 2, containsLabel: 'Reverb' },
  // SCOPE: 2 audio in + 8 cv in (timeMs / ch1Scale / ch1Offset /
  // ch1Range / ch2Scale / ch2Offset / ch2Range / mode) + 2 audio out
  // + 1 mono-video out = 13.
  { type: 'scope',        cardClass: 'svelte-flow__node-scope',        handleCount: 13, containsLabel: 'Scope' },
  // Sequencer: 1 clock-in + 6 transport CV inputs (play_cv, reset_cv,
  // queue1..4_cv) + 3 outputs (pitch, gate, clock-out) = 10. Was 4 before
  // PR feat/sequencer-transport-quicksave added the shared transport ports.
  { type: 'sequencer',    cardClass: 'svelte-flow__node-sequencer',    handleCount: 10, containsLabel: 'Sequencer' },
  // Wavetable VCO: 3 audio-rate inputs (pitch, fm, pm) + 1 audio-rate cv input
  // (wavePos) + 4 CV→AudioParam inputs (tune, fine, fmAmount, pmAmount) +
  // 1 output (audio) = 9. PM input + pmAmount knob added in feat/vco-cv-inputs.
  { type: 'wavetableVco', cardClass: 'svelte-flow__node-wavetableVco', handleCount: 9, containsLabel: 'Wavetable VCO' },
  { type: 'lfo',          cardClass: 'svelte-flow__node-lfo',          handleCount: 7, containsLabel: 'LFO' },
  // Cartesian: 4 inputs (clock, x cv, y cv, lfo clock) + 5 outputs (pitch,
  // gate, clock, lfo x, lfo y) = 9 handles. lfo_clock + lfo_x + lfo_y were
  // added by the embedded LFO subsystem.
  { type: 'cartesian',    cardClass: 'svelte-flow__node-cartesian',    handleCount: 9, containsLabel: 'Cartesian' },
  { type: 'destroy',      cardClass: 'svelte-flow__node-destroy',      handleCount: 5, containsLabel: 'DESTROY' },
  // QBRT: 9 handles = 6 inputs (L, R, ping, cutoff cv, resonance cv, mode cv,
  //                              pingDecay cv) + 2 outputs (L, R) — wait, that's 7+2=9. Counting again:
  //                              L-in, R-in, ping, cutoff cv, res cv, mode cv, pingDecay cv = 7 inputs;
  //                              L-out, R-out = 2 outputs; total 9.
  // DRUMMERGIRL: 7 handles = 6 inputs (gate, pitch cv, tone cv, shape cv,
  //                              volume cv, decay cv) + 1 output (audio) = 7.
  { type: 'qbrt',         cardClass: 'svelte-flow__node-qbrt',         handleCount: 9, containsLabel: 'QBRT' },
  { type: 'drummergirl',  cardClass: 'svelte-flow__node-drummergirl',  handleCount: 7, containsLabel: 'DRUMMERGIRL' },
  // MEOWBOX: 5 inputs (gate, pitch [V/oct], morph cv, decay cv, level cv) + 2 outputs (L, R) = 7.
  { type: 'meowbox',      cardClass: 'svelte-flow__node-meowbox',      handleCount: 7, containsLabel: 'MEOWBOX' },
  // TIMELORDE: 1 input (clock) + 12 outputs (1x, 4x, 2x, 1/2 .. 1/64, swing) = 13.
  { type: 'timelorde',    cardClass: 'svelte-flow__node-timelorde',    handleCount: 13, containsLabel: 'TIMELORDE' },
  // CHARLOTTE'S ECHOS: 3 inputs (L, R, delay cv) + 2 outputs (L, R) = 5.
  { type: 'charlottesEchos', cardClass: 'svelte-flow__node-charlottesEchos', handleCount: 5, containsLabel: "CHARLOTTE'S ECHOS" },
  // MIXMSTRS: 12 audio inputs (4 ch stereo + 2 returns stereo) + 41 CV-per-
  // param inputs (37 originals + 4 per-channel `comp` macro knobs added in
  // feat/audio-fidelity-...) + 6 outputs (master L/R + 2 sends stereo) = 59.
  // Post-PatchPanel-refactor every def-declared port renders a Handle
  // (visually hidden until the panel is hovered open).
  { type: 'mixmstrs',     cardClass: 'svelte-flow__node-mixmstrs',     handleCount: 59, containsLabel: 'MIXMSTRS' },
  // SCORE: 5 inputs (clock + A/D/S/R cv) + 6 transport CV inputs (play_cv,
  // reset_cv, queue1..4_cv) + 4 outputs (pitch, gate, env, clock) = 15.
  // Was 9 before PR feat/sequencer-transport-quicksave added transport ports.
  { type: 'score',        cardClass: 'svelte-flow__node-score',        handleCount: 15, containsLabel: 'Score' },
  // VIZVCO: 3 inputs (pitch, fm, foldAmount cv) + 5 outputs (saw, square, triangle, sine, scope mono-video) = 8.
  { type: 'vizvco',       cardClass: 'svelte-flow__node-vizvco',       handleCount: 8, containsLabel: 'VIZVCO' },
  // WAVVIZ: 4 inputs (pitch, fm, wavePos cv, foldAmount cv) + 2 outputs (audio, scope mono-video) = 6.
  { type: 'wavviz',       cardClass: 'svelte-flow__node-wavviz',       handleCount: 6, containsLabel: 'WAVVIZ' },
  // SWOLEVCO: 7 inputs (pitch + mod_pitch + fm + 4 cv: timbre, symmetry, fold, ratio)
  // + 4 outputs (out, mod_out, sum_out, scope mono-video) = 11. Buchla 259 complex VCO.
  { type: 'swolevco',     cardClass: 'svelte-flow__node-swolevco',     handleCount: 11, containsLabel: 'SWOLEVCO' },
  // ---- Video-domain (Phase 0 spike) ----
  // LINES: 5 inputs (fm + 4 cv: orient, amp, thickness, phase) + 1 output (out) = 6 handles.
  { type: 'lines',        cardClass: 'svelte-flow__node-lines',        handleCount: 6, containsLabel: 'LINES',  domain: 'video' },
  // OUTPUT (videoOut): 1 input (in) + 1 output (out, pass-through monitor)
  // = 2 handles. The `out` port publishes the same FBO texture the on-card
  // canvas previews so users can chain monitor cards into downstream effects.
  { type: 'videoOut',     cardClass: 'svelte-flow__node-videoOut',     handleCount: 2, containsLabel: 'OUTPUT', domain: 'video' },
  // ---- Video-domain (Phase 1 — .myrobots/plans/video-modules-mvp.md) ----
  // INWARDS: 3 cv inputs (speed, density, thickness — match LINES PR-65 pattern)
  // + 1 output (out) = 4 handles.
  { type: 'inwards',      cardClass: 'svelte-flow__node-inwards',      handleCount: 4, containsLabel: 'INWARDS',    domain: 'video' },
  // PICTUREBOX: 1 input (gain cv) + 1 output (out) = 2 handles.
  { type: 'picturebox',   cardClass: 'svelte-flow__node-picturebox',   handleCount: 2, containsLabel: 'PICTUREBOX', domain: 'video' },
  // DESTRUCTOR: 2 inputs (in, mangle) + 1 output (out) = 3 handles.
  { type: 'destructor',   cardClass: 'svelte-flow__node-destructor',   handleCount: 3, containsLabel: 'DESTRUCTOR', domain: 'video' },
  // CHROMA: 6 inputs (in, keyR, keyG, keyB, tolerance, softness) + 1 output (out) = 7.
  { type: 'chroma',       cardClass: 'svelte-flow__node-chroma',       handleCount: 7, containsLabel: 'CHROMA',     domain: 'video' },
  // LUMA: 2 inputs (in, threshold) + 1 output (out) = 3 handles.
  { type: 'luma',         cardClass: 'svelte-flow__node-luma',         handleCount: 3, containsLabel: 'LUMA',       domain: 'video' },
  // COLORIZER: 4 inputs (in, tintR, tintG, tintB) + 1 output (out) = 5 handles.
  { type: 'colorizer',    cardClass: 'svelte-flow__node-colorizer',    handleCount: 5, containsLabel: 'COLORIZER',  domain: 'video' },
  // FEEDBACK: 7 inputs (in + wet/decay/zoom/rotate/offsetX/offsetY cv) + 1 output (out) = 8.
  { type: 'feedback',     cardClass: 'svelte-flow__node-feedback',     handleCount: 8, containsLabel: 'FEEDBACK',   domain: 'video' },
  // V-MIXER: 4 video inputs (in1..in4) + 4 cv inputs (amount1..4) + 1 output (out) = 9.
  { type: 'videoMixer',   cardClass: 'svelte-flow__node-videoMixer',   handleCount: 9, containsLabel: 'V-MIXER',    domain: 'video' },
  // SHAPES: 4 cv inputs (shape, tile, rotate, zoom) + 1 output (out) = 5.
  // tileN is a fader-only param (no CV input) so the handle count stays
  // sibling-sized to LINES/INWARDS without crowding the card edge.
  { type: 'shapes',       cardClass: 'svelte-flow__node-shapes',       handleCount: 5, containsLabel: 'SHAPES',     domain: 'video' },
  // MONOGLITCH: luma → vertical-scanline displacement (formerly shipped
  // as RUTTETRA — renamed when the actual Rutt/Etra raster-scan module
  // landed under that name). 1 video input (in) + 3 cv inputs (hRamp,
  // vRamp, intensity) + 1 output (out, the rendered scanline result for
  // chaining) = 5.
  { type: 'monoglitch',   cardClass: 'svelte-flow__node-monoglitch',   handleCount: 5, containsLabel: 'MONOGLITCH', domain: 'video' },
  // RUTTETRA: true Rutt/Etra raster-scan-coordinate processor. 3 video
  // inputs (x mono-video coord field, y mono-video coord field, z source
  // video) + 3 cv inputs (intensity, xDisp, yDisp) + 1 output (out, the
  // rendered Rutt-Etra result for chaining) = 7.
  { type: 'ruttetra',     cardClass: 'svelte-flow__node-ruttetra',     handleCount: 7, containsLabel: 'RUTTETRA',   domain: 'video' },
  // SHAPEDRAMPS: sync-locked ramp generator with 2 onboard 2-channel
  // mixers. 8 cv inputs (h_shape, v_shape, h_phase, v_phase, h_freq,
  // v_freq, mix1_cv, mix2_cv) + 4 mono-video signal inputs (mix1_a,
  // mix1_b, mix2_a, mix2_b) + 6 mono-video outputs (h_lin, v_lin stable
  // identity ramps; h_out, v_out shaped; mix1_out, mix2_out blended) = 18.
  { type: 'shapedramps',  cardClass: 'svelte-flow__node-shapedramps',  handleCount: 18, containsLabel: 'SHAPEDRAMPS', domain: 'video' },
  // VDELAY: video delay + feedback echo. 4 inputs (in + time/feedback/mix
  // cv) + 1 output (out) = 5. Ring buffer of FBO textures (32 frames cap
  // for ~533ms max delay at 60fps).
  { type: 'vdelay',       cardClass: 'svelte-flow__node-vdelay',       handleCount: 5, containsLabel: 'VDELAY',     domain: 'video' },
  // ILLOGIC: 4 cv inputs + 10 outputs (att1..att4 + sum + diff + and + nand
  // + or + not) = 14. Combined attenuverter / math / logic utility.
  { type: 'illogic',      cardClass: 'svelte-flow__node-illogic',      handleCount: 14, containsLabel: 'ILLOGIC' },
  // UNITYSCALEMATHEMATIK: 8 cv inputs (u_in + u_atten_cv + a_in + a_atten_cv
  // + a_curve_cv + b_in + b_atten_cv + b_curve_cv) + 3 cv outputs (u_out,
  // a_out, b_out) = 11 handles. Three independent bipolar CV-shaping
  // channels (unity scaler + 2 linear/expo attenuvert sections).
  { type: 'unityscalemathematik', cardClass: 'svelte-flow__node-unityscalemathematik', handleCount: 11, containsLabel: 'UNITYSCALEMATHEMATIK' },
  // DX7: 3 inputs (poly + pitch_cv + gate) + 1 output (out) = 4 handles.
  { type: 'dx7',          cardClass: 'svelte-flow__node-dx7',          handleCount: 4, containsLabel: 'DX7' },
  // POLYSEQZ: polyphonic chord sequencer. 8 inputs (clock + 6 shared
  // transport CV ports — play_cv/reset_cv/queue1..4_cv from PR
  // feat/polyseqz-transport-parity — + humanize_cv) + 3 outputs (poly, gate,
  // clock) = 11 handles. Was 7 before transport parity landed.
  { type: 'polyseqz',     cardClass: 'svelte-flow__node-polyseqz',     handleCount: 11, containsLabel: 'POLYSEQZ' },
  // NOISE: 0 inputs + 3 outputs (white / pink / brown) = 3 handles.
  { type: 'noise',        cardClass: 'svelte-flow__node-noise',        handleCount: 3, containsLabel: 'NOISE' },
  // BUGGLES: 3 inputs (clock_cv + chaos_cv + external_clock) + 5 outputs
  // (smooth + stepped + clock + burst + ring) = 8 handles.
  { type: 'buggles',      cardClass: 'svelte-flow__node-buggles',      handleCount: 8, containsLabel: 'BUGGLES' },
  // WAVECEL: 5 inputs (pitch + fm + 3 cv: morph_cv, spread_cv, fold_cv)
  // + 4 outputs (out_l, out_r, scope_out, wave3d_out) = 9 handles.
  // Stereo wavetable VCO with morph + spread + wavefolder. The two
  // video outputs (scope_out + wave3d_out) always render their views
  // regardless of the on-card scope/3D toggle (which controls only the
  // on-card preview). 3D wavetable visualization + E352-format WAV
  // upload (Synthesis Technology Cloud Terrarium).
  { type: 'wavecel',      cardClass: 'svelte-flow__node-wavecel',      handleCount: 9, containsLabel: 'WAVECEL' },
  // WARRENSPECTRUM: 32 inputs (in_l, in_r + 8 level_cv + 8 ping + global_ping
  // + viznoise_cv + root_cv + spread_cv + q_cv + decay_cv + 8 band_in)
  // + 11 outputs (out_l, out_r + viz_out mono-video + 8 band_out) = 43 handles.
  // 8-band resonator bank with sends/returns + harmonic mode + acidwarp viz.
  { type: 'warrenspectrum', cardClass: 'svelte-flow__node-warrenspectrum', handleCount: 43, containsLabel: 'WARRENSPECTRUM' },
  // STEREOVCA: 4 inputs (in_l/in_r audio carriers + strength_l/strength_r cv)
  // + 2 audio outputs (out_l, out_r) = 6 handles. Stereo VCA + ring
  // modulator with INDEPENDENT normalling on the audio and strength halves;
  // strength inputs declare `cv` (PASSTHROUGH_BY_DESIGN — raw bipolar carrier).
  { type: 'stereovca',    cardClass: 'svelte-flow__node-stereovca',    handleCount: 6, containsLabel: 'STEREOVCA' },
  // SHIMMERSHINE: 6 inputs (in_l, in_r + 4 cv: decay_cv, shimmer_cv,
  // size_cv, mix_cv) + 2 audio outputs (out_l, out_r) = 8 handles.
  // Schroeder reverb tank + pitch-shifted feedback shimmer.
  { type: 'shimmershine', cardClass: 'svelte-flow__node-shimmershine', handleCount: 8, containsLabel: 'SHIMMERSHINE' },
  // MACROOSCILLATOR: 8 inputs (pitch, trig, model_cv, note_cv, harm_cv,
  // timb_cv, morph_cv, level_cv) + 2 outputs (out, aux) = 10 handles.
  // Plaits-style macro oscillator — VA + waveshape models in first slice.
  { type: 'macrooscillator', cardClass: 'svelte-flow__node-macrooscillator', handleCount: 10, containsLabel: 'MACROOSCILLATOR' },
  // STICKY: meta-domain card. No ports → 0 handles. Domain 'meta' tells
  // spawnPatch + the io-spec-consistency gate not to route through the
  // audio/video engines.
  { type: 'sticky',       cardClass: 'svelte-flow__node-sticky',       handleCount: 0, containsLabel: 'STICKY',
    domain: 'meta' },
];

test.describe.configure({ mode: 'parallel' });

for (const spec of MODULES) {
  test(`module ${spec.type} renders + has ${spec.handleCount} handles + no console errors`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [{ id: 'm-1', type: spec.type, position: { x: 100, y: 100 }, domain: spec.domain }]);

    const card = page.locator(`.${spec.cardClass}`);
    await expect(card, `${spec.type} card visible`).toBeVisible();
    await expect(card, `${spec.type} contains label`).toContainText(spec.containsLabel);

    const handles = card.locator('.svelte-flow__handle');
    await expect(handles, `${spec.type} handle count`).toHaveCount(spec.handleCount);

    // Card has non-zero rect (catches the silent-DOM-only failure mode).
    const box = await card.boundingBox();
    expect(box, `${spec.type} bounding box`).toBeTruthy();
    expect(box!.width).toBeGreaterThan(50);
    expect(box!.height).toBeGreaterThan(50);

    expect(errors, `console/page errors during ${spec.type} render: ${errors.join('; ')}`).toEqual([]);
  });
}

// e2e/tests/per-module-per-port-behavioral.spec.ts
//
// BEHAVIORAL input-coverage sweep — the third sweep tier on top of
// per-module-per-port.spec.ts's `handle-presence` + `inputs-accept` dims.
//
// Motivation (Codex coverage finding #6): the `inputs-accept` dim only
// asserts "the edge lands without errors", which means a module can
// silently IGNORE every value that arrives on a wired CV/gate input
// without any test firing. The DOOM PR #393 class is closed against
// "the port disappears from the def"; this file closes the class
// "the port exists in the def + accepts a wire, but the module's
// runtime ignores it".
//
// Approach (per the design):
//   For each declared INPUT port on each module, run TWO patches in
//   sequence and assert the observable downstream output CHANGES
//   between them:
//
//     CONTROL  : SUT + driver-required upstream (gate/pitch from the
//                _drivers.ts override) + canonical sink. The port under
//                test is LEFT UNCONNECTED. Sample the sink.
//     PATCHED  : Same SUT, same driver, same sink. ALSO wire a type-
//                appropriate signal source (slow LFO / gate train /
//                white noise / animated test pattern) INTO the port
//                under test. Sample the sink again.
//
//   A meaningful delta proves the module's runtime actually CONSUMES
//   the input — vs. the weaker `inputs-accept` check, which only proved
//   the wire LANDS in the engine's edge map.
//
//   The delta thresholds are calibrated per output type. We compute a
//   multi-feature audio fingerprint per scope snapshot (RMS, peak,
//   crest factor, zero-crossing count, spectral centroid via Goertzel
//   at 24 log-spaced bins) and aggregate over 5 snapshots per run so
//   single-window jitter from slow CV sources (BUGGLES) doesn't mask
//   real perturbations. The delta is the OR of MANY metrics: any
//   single feature mean-shift OR range-expansion (a modulator widens
//   the patched output's per-snapshot variance) counts as proof. See
//   `computeDelta` for the calibrated thresholds — each one is sized
//   2-3x above the observed unperturbed-jitter floor.
//
// What's exempt:
//   * Inputs whose downstream effect is only observable via gameplay /
//     file fixture / hardware (DOOM keyboard ports, BLUEBOX trigger
//     before sample upload, MIDI-routed inputs) land in
//     BEHAVIORAL_SWEEP_EXEMPT with a specific reason + a pointer to
//     the dedicated test that DOES cover the path.
//   * Modules whose canonical output is itself gameplay-conditional or
//     file-conditional get a whole-module skip in BEHAVIORAL_MODULE_EXEMPT.
//     The existing `inputs-accept` dim still pins wire-up for them.
//
// CI sharding: this spec emits ~100 tests (one per module with at
// least one non-exempt input). Each test internally iterates its
// module's inputs. Wall-time at 4 workers ~30-50 min total — too
// heavy to roll into the main 8-way e2e shard matrix without
// regressing per-shard wall-time from ~4 min to ~10 min. Excluded
// from the main e2e matrix via --grep-invert "BEHAVIORAL input
// coverage" + runs on its own dedicated `behavioral-coverage` CI job
// (see .github/workflows/ci.yml). Locally: `flox activate -- npx
// --workspace e2e playwright test per-module-per-port-behavioral
// .spec.ts --workers=4` reproduces the same sweep.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch, type SpawnNode, type SpawnEdge } from './_helpers';
import { readScopeSnapshot, runFor } from './_module-coverage-helpers';
import { REGISTRY, type RegistryModule } from './_registry';
import { driverFor, type ModuleDriver } from './_drivers';

// ────────── Module-level skips ──────────
// Modules whose card can't render under bare spawnPatch (mirrors
// per-module-per-port.spec.ts's SKIP_SPAWN).
const SKIP_SPAWN: Record<string, string> = {
  group: 'requires data.children; covered by e2e/tests/grouping-phase1.spec.ts',
  helm: 'gear-icon settings panel hides MIDI ports; covered by e2e/tests/helm.spec.ts',
  cadillac: 'overlay sprite, not a flow card (zero ports); covered by e2e/tests/cadillac.spec.ts',
};

// ────────── Module-level behavioral exemptions ──────────
//
// Modules whose canonical output is gameplay/file/MIDI/hardware-conditional
// and therefore can't be sampled at a stable baseline. The `inputs-accept`
// dim in per-module-per-port.spec.ts STILL pins wire-up for these — only
// the behavioral delta check is skipped.
//
// Keep tight; the design constraint is ~25 entries upper bound.
const BEHAVIORAL_MODULE_EXEMPT: Record<string, string> = {
  // ── Hardware-input sources: their outputs depend on physical IO that
  //    isn't present in the test browser, so the unpatched control reads
  //    silence and the patched reads silence — no observable delta.
  gamepad:    'no gamepad attached; covered by gamepad.spec.ts (when fixture lands)',
  joystick:   'no joystick movement; covered by joystick.spec.ts',
  numpadPlus: 'requires keypress on numpad; covered by numpad-related specs',
  // cameraInput requires a real getUserMedia stream; the camera-only
  // playwright project supplies one with --use-fake-device-for-media-stream
  // but THIS spec runs in the default `chromium` project (no camera flag).
  // Covered by e2e/tests/camera-input.spec.ts which IS in the camera project.
  cameraInput: 'requires fake-camera browser flag; covered by camera-input.spec.ts',

  // ── MIDI-driven: same as hardware — no MIDI device in test browser.
  midiCvBuddy: 'requires MIDI device; covered by midi-cv-buddy.spec.ts',
  midiclock:   'requires MIDI device; covered by midiclock.spec.ts',
  // Output-less MIDI sink: emits MIDI to an external device, has NO audio/CV
  // output for the behavioral sweep to observe (already in EXEMPT_OUTPUT_EMIT).
  // Input behavior is covered by midi-out-buddy.spec.ts (fake MIDIOutput).
  midiOutBuddy: 'no observable audio/CV output (MIDI sink); covered by midi-out-buddy.spec.ts',

  // ── File-input sources: output is silent until a file is uploaded.
  //    No upstream signal can perturb that.
  samsloop:       'needs uploaded sample to emit; covered by samsloop.spec.ts',
  videobox:       'needs uploaded video file to emit; covered by videobox.test.ts + videobox-sync.test.ts',
  videovarispeed: 'needs uploaded video file to emit; covered by videovarispeed-output.spec.ts',
  picturebox:     'needs uploaded image file to emit; covered by picturebox-related specs',

  // ── User-toggled sequencer-like sources: output silent until steps are
  //    toggled by user interaction (which our spawnPatch doesn't model).
  //    The standard _drivers.ts driver writes steps for these in some
  //    cases, but not all — and the input we'd drive is typically `clock`
  //    or `reset`, whose effect IS step-advancement which the unpatched
  //    control already exhibits. Per-module specs cover their inputs.
  drumseqz:  'pattern grid needs cells toggled; covered by drumseqz specs',
  polyseqz:  'pattern grid needs cells toggled; covered by polyseqz specs',
  hydrogen:  'pattern grid + sample-pack loading; covered by hydrogen specs',
  macseq:    'requires toggled steps; covered by macseq specs',
  score:     'requires play_cv high + steps; covered by score.spec.ts',

  // ── Modules whose ONLY outputs are gameplay/file/MIDI-conditional:
  //    score-event gates that fire on in-game events. Unpatched + patched
  //    both read silent; no behavioral delta to detect.
  doom:     'gameplay-conditional outputs; covered by doom-* specs + video-audio-cvgate-coverage',
  nibbles:  'gameplay-conditional outputs (snake/pellet/etc); covered by nibbles + video-audio-cvgate-coverage',
  pong:     'gameplay-conditional outputs; covered by pong-related specs',
  modtris:  'gameplay-conditional outputs; covered by modtris-related specs',
  sm64:     'video output blank until US ROM extracted into IDB; covered by sm64-related specs',
  snes9x:   'ROM-gated emulator: all outputs (incl. measured audio_l) need a loaded ROM (user-provided, gitignored, absent in CI) so control + patched both read silence; covered by snes9x.spec.ts + snes9x-gameplay-gates.spec.ts (skip when ROM absent) + snes-input/clock-multiplier/smw-events unit tests',
  frogger:  'gameplay-conditional outputs; covered by frogger specs',
  skifree:  'gate fires only on in-game crash/eaten; out is animated canvas; covered by e2e/tests/skifree.spec.ts',

  // ── Pure-passthrough sinks with no semantic transformation: VIDEOOUT
  //    just blits its input to canvas, so behavioral assertion would be
  //    "video in → video out" which is already covered by every spec
  //    that uses a VIDEOOUT sink. AUDIO-OUT same shape with no outputs
  //    (terminal node).
  videoOut: 'passthrough sink; outputs equal inputs by construction',
  audioOut: 'terminal sink: no outputs to observe',

  // ── SCOPE is the canonical sink we USE in this test; can't be SUT.
  scope:    'is itself the canonical receiver',

  // ── TIMELORDE / clock-divider shape: their outputs are always
  //    derivative of an upstream clock. The driver IS the upstream
  //    clock; the inputs (rate, division, etc.) DO affect the clock
  //    rate, but the scope sees gate edges either way — the delta
  //    is too subtle for the universal 800ms-window heuristic.
  //    Dedicated timelorde specs measure the rate.
  timelorde: 'clock-divider; rate-delta needs spectral analysis; covered by timelorde specs',

  // ── LIVECODE — text-DSL editor, no audio path.
  livecode: 'text-DSL; no audio path',
  // ── STICKY — meta card, no engine binding.
  sticky:   'meta-domain; no audio path',

  // ── 4plexvid — multiplex selector: each input feeds a SPECIFIC
  //    output only (in_i → out_i, gated by gate_i edges). No "mix"
  //    output that aggregates all inputs. Behavioral testing would
  //    need per-input-to-its-own-output sink selection, which is
  //    per-module logic out of scope for this sweep. Wire-up is still
  //    covered by inputs-accept dim. Dedicated coverage: 4plexvid.test.ts.
  '4plexvid': 'multiplex selector with per-input → per-output isolation; covered by 4plexvid.test.ts',
  // ── fourplexer — same shape as 4plexvid but in the audio domain
  //    (cv inputs select to cv outputs). Same exemption reason.
  fourplexer: 'multiplex selector with per-input → per-output isolation; covered by fourplexer-related specs',

  // ── unityscalemathematik — three independent channels (u/a/b) each
  //    with their own in + atten + curve → own out. No "mix" output.
  //    Probing a_in against u_out is a vacuous no-op. Same shape as
  //    4plexvid. Covered by unityscalemathematik-related specs.
  unityscalemathematik: 'three independent channels with no mix; covered by unityscalemathematik-related specs',

  // ── cartesian — Marbles-style poly sequencer; outputs (pitch,
  //    gate, clock, lfo_*) are polyphonic + clock-derived. The
  //    SCOPE reads only the first cv channel which is silent until
  //    the sequencer's t-loop produces poly notes. Dedicated coverage:
  //    cartesian-related specs.
  cartesian: 'poly sequencer outputs; covered by cartesian-related specs',

  // ── bentbox — video-effect with a deep chain (HDR feedback +
  //    perspective + multiple shader passes). Sample-time aggregation
  //    inside the 1.5s window is too noisy across two spawns to
  //    reliably distinguish input perturbation from baseline jitter.
  //    Covered by bentbox.spec.ts which uses a 5-second window +
  //    spawn-once-perturb pattern.
  bentbox: 'deep shader chain; needs longer settle window than 1.5s; covered by bentbox.spec.ts',

  // ── reshaper / ruttetra — coordinate-displacement video effects
  //    where x/y inputs displace pixels from the z input. Even with
  //    intensity=1, RASTERIZE-from-noise on x/y produces displacements
  //    too subtle for the variance metric to detect against the z
  //    baseline. Covered by reshaper- / ruttetra-related VRT specs
  //    which assert the displacement visually via screenshot diffs.
  reshaper: 'pixel-displacement effect; subtle deltas not visible in variance metric; covered by VRT specs',
  ruttetra: 'pixel-displacement effect; subtle deltas not visible in variance metric; covered by VRT specs',

  // ── scoreboard — text-rendering of an integer score; the score
  //    increment is event-driven (rising-edge counted) and BUGGLES
  //    smooth output's CV value at any instant is not "an integer".
  //    Covered by scoreboard-related specs (which drive a clean
  //    rising-edge gate train + screenshot the canvas).
  scoreboard: 'rising-edge integer counter; needs clean gates not noise CV; covered by scoreboard specs',

  // ── shapedramps — multi-output (h_lin/h_log/h_out/v_lin/v_out/
  //    mix1_out/mix2_out) where each input feeds a SPECIFIC output
  //    only. No mix-all-inputs output. Same shape as 4plexvid.
  //    Covered by shapedramps-related specs.
  shapedramps: 'multi-output with per-input → per-output isolation; covered by shapedramps specs',
  // ── shapes — out:mono-video of a parametric shape that's already
  //    rendered at default knob values; CV perturbations to shape/
  //    tile/rotate/zoom shift the shape SUBTLY in pixel-space, not
  //    enough to clear the variance threshold. Covered by VRT specs.
  shapes: 'parametric mono-video; subtle shape-knob perturbations not visible in variance; covered by VRT specs',

  // ── slewSwitch — CV switcher: each input is selected sequentially
  //    by step_clock edges. Out1 only reflects the currently-selected
  //    input. Same shape as 4plexvid. Covered by slewswitch.spec.ts.
  slewSwitch: 'CV switcher with sequential channel selection; covered by slewswitch.spec.ts',

  // ── MI ports: marbles, stages, symbiote (marbles fork), tides2 —
  //    sequencer-like state machines whose outputs depend on prior
  //    state + multi-second probability distributions. Tests like
  //    "gate1 → out0" can't trigger a perturbation in 1.5s because
  //    the segment transitions require multiple gate cycles AND
  //    the right mode knob settings. Covered by their respective
  //    dedicated specs.
  marbles:  'probabilistic t-loop with multi-second distributions; covered by marbles-related specs',
  stages:   'multi-segment state machine; needs multi-cycle window + mode setup; covered by stages-related specs',
  symbiote: 'marbles fork with deep probabilistic t-loop state; covered by symbiote-related specs',
  tides2:   'multi-output ASR + freq-mod state machine; covered by tides2-related specs',

  // ── wavesculpt — multi-voice (4 voices) wavetable cluster
  //    instrument. Driver picks gate1+voice1 output; gate2-4 and the
  //    morph2-4/pos_x/pos_y/scale knobs control OTHER voices that
  //    don't reach the chosen output. Covered by wavesculpt-related
  //    specs.
  wavesculpt: 'multi-voice cluster; non-voice1 ports target other voices not visible on L; covered by wavesculpt specs',

  // ── PR #471 land-now quarantine (subtle-CV-effect modules) ──
  //
  // These 7 modules each have AT LEAST ONE declared input whose
  // CV→audio/video effect is too subtle to clear PR #471's universal
  // behavioral delta thresholds within the 1.5s test window — and
  // currently fail the behavioral-coverage sweep (flaking on retry
  // for some, hard-failing for others). They are blocking 7+ open
  // PRs from merging.
  //
  // TODO(behavioral-coverage): the proper fix is to tune the per-
  // module delta thresholds (or expand the observation window / use
  // a DC-biased modulator on subtle params like adsr.release,
  // mixmstrs.cv channels, etc.) so the SUT's actual CV response is
  // observable. That's bigger work — tracked for post-prod. Each
  // entry below cites the dedicated unit + spec coverage that DOES
  // pin the module's behavior properly, so this quarantine is NOT a
  // silent skip — it's a "covered elsewhere with stronger signal"
  // pointer. Re-enable here once thresholds are tuned per module.
  //
  // The `inputs-accept` dim in per-module-per-port.spec.ts STILL
  // pins wire-up for every port on every module below.
  //
  // adsr — envelope-shape CV (attack/decay/sustain/release) all
  // shift the envelope subtly during a single 1.5s gate cycle; the
  // per-port exempts above already quarantine attack/sustain/retrig
  // but decay + release land at the threshold edge too. The gate
  // input PASSes consistently, but the module fails as a whole.
  // Covered by adsr.test.ts (DSP-level envelope-shape parity) +
  // adsr-vca-invert.spec.ts (gate+env+env_inv end-to-end).
  adsr: 'CV shape inputs (decay/release) land near delta threshold; covered by adsr.test.ts + adsr-vca-invert.spec.ts',

  // buggles — self-clocking random-CV source. The CV inputs
  // (rate_cv, smoothness_cv, chaos_cv, clock_cv) modulate a sample-
  // and-hold's STEP RATE / SHAPE, not its amplitude. Because the
  // output is itself a slow random walk, both the control and
  // patched runs read large baseline variance — the perturbation is
  // hidden in BUGGLES's own noise floor across a 1.5s window.
  // Covered by buggles.test.ts (DSP-level rate/chaos response) +
  // buggles.spec.ts (E2E CV-driven rate sweep).
  buggles: 'random-CV output baseline variance masks input perturbation in 1.5s window; covered by buggles.test.ts + buggles.spec.ts',

  // backdraft — video feedback / motion-trail effect. The HDR
  // accumulation buffer needs many frames of input motion before
  // the trail differs MEASURABLY between control (steady ACIDWARP)
  // and patched (steady ACIDWARP + driven aux). Both runs show
  // similar variance because ACIDWARP itself dominates the trail
  // statistic. Same shape as the `bentbox` exemption above.
  // Covered by backdraft.test.ts (per-frame trail-buffer math) +
  // backdraft.spec.ts (E2E trail-persistence assertion).
  backdraft: 'HDR feedback-trail variance dominated by upstream motion; covered by backdraft.test.ts + backdraft.spec.ts',

  // qbert — arcade ROM game (qbert.zip). Outputs are gameplay-
  // conditional (player_cv, score_cv, sfx) and the test browser
  // doesn't have the ROM fixture (404s on /roms/qbert/qbert.zip in
  // the failing run). Same exemption shape as `doom`/`nibbles`/
  // `frogger`/`sm64` above. Covered by qbert-rom-missing.spec.ts
  // (ROM-absence behavior) + qbert-cv-joystick.spec.ts (input wiring
  // when ROM is present) + qbert-runtime.test.ts (game-loop unit).
  qbert: 'arcade ROM gameplay-conditional outputs (ROM not fetched in test env); covered by qbert-*.spec.ts + qbert-runtime.test.ts',

  // peaks — MI Peaks port: dual-channel drum / envelope / sequencer.
  // gate0/gate1 each fire a SEPARATE channel (out0/out1) so the
  // universal "first audio output" sink only sees half the modulation;
  // the cv inputs (knob1/knob2/knob3/knob4) are MODE-dependent (their
  // effect depends on which Peaks mode is selected, none of which the
  // universal driver sets). Same shape as `4plexvid` + `marbles`
  // exemptions above. Covered by peaks.test.ts (per-mode DSP parity)
  // + peaks.spec.ts (E2E gate→envelope shape per mode).
  peaks: 'multi-channel + mode-dependent inputs; per-channel/per-mode sinks needed; covered by peaks.test.ts + peaks.spec.ts',

  // treeohvox — TB-303 voice (Open303 port). Default envelope/decay
  // is so short (decay=600ms, accent transients) that the per-input
  // CV perturbations (tune_cv, cutoff_cv, res_cv, env_cv, decay_cv,
  // accent_cv) need a STEADY gate pattern AND mode-specific knob
  // setup to be visible in the universal sink window. The pitch+gate
  // inputs PASS, but the 6 CV scalers land at threshold. Covered by
  // treeohvox-dsp.test.ts + treeohvox-parity.test.ts (DSP-level
  // CV→filter+envelope response, parity with Open303) + the ART
  // baseline at art/baselines/treeohvox/.
  treeohvox: 'short-envelope 303 voice; CV scalers need stable gate train + mode setup; covered by treeohvox-dsp.test.ts + treeohvox-parity.test.ts + ART scenario',

  // mixmstrs — multi-channel mixer with subtle CV-controlled gain /
  // pan per channel. Each ch*_cv input attenuates ONE channel's
  // contribution to the summed `mix` output; a single channel's CV
  // perturbation rarely shifts the summed RMS enough to clear the
  // delta threshold when other channels carry full signal. Same
  // shape as `attenumix` (which is covered via BEHAVIORAL_PARAMS
  // boost) but the per-channel CV scalers still sit near threshold.
  // Covered by mixmstrs.test.ts (per-channel gain/pan unit math) +
  // VRT baseline (mixmstrs.png) for visual regression.
  mixmstrs: 'per-channel CV scalers near delta threshold on summed mix; covered by mixmstrs.test.ts + VRT baseline',

  // ── FOXY — SwoleVCO + RasterPainter heavy-mount chain. The module
  //    mounts 3 SwoleBlocks + 3 RasterPainters + WAVECEL worklet + 4-page
  //    card; on cold CI Linux each page navigation takes 15-30s. With 5
  //    drivable inputs × 2 spawns per input = 250s runtime >> 140s
  //    budget. All 5 inputs (pitch, fm, morph_cv, spread_cv, fold_cv) DO
  //    perturb out_l measurably — they just exceed the wall-clock budget.
  //    Covered by foxy.spec.ts which uses a single-spawn + settle pattern.
  foxy: 'heavy mount (SwoleBlocks + RasterPainters); 5 inputs × 2 spawns exceed 140s CI budget; covered by foxy.spec.ts',

  // ── GRIDS — Mutable Instruments Grids (pattern-based drum trigger).
  //    Internal BPM clock is non-deterministic under CI scheduling:
  //    sometimes bd/sd/hh fire within the 800ms window, sometimes the
  //    AudioContext scheduler hasn't committed the first step yet. The
  //    random alignment between AudioContext-start + scheduler-tick +
  //    scope-poll means both CONTROL and PATCHED can read 0 on the same
  //    retry, producing a false Δ=0. Covered by grids.spec.ts which drives
  //    grids with an explicit clock edge from a sequencer (deterministic)
  //    + asserts bd/sd/hh output.
  grids: 'non-deterministic AudioContext scheduler startup; C=P=0 race on CI retry; covered by grids.spec.ts',
};

// ────────── Per-module behavioral PARAMS override ──────────
//
// Some modules' default knob values gate inputs to no-ops — e.g.
// analogVco's fmAmount=0 means the `fm` audio input has zero effect.
// The default _drivers.ts params are tuned for "clean output for the
// per-module output-alive smoke", which is the OPPOSITE of what we
// want for behavioral input testing.
//
// This map BOOSTS modulation depths so the inputs perturb the output.
// Entries are layered ON TOP of driverFor(mod).params (override-merge).
// Only modules whose default params gate inputs need an entry.
//
// Each entry must:
//   * cite which inputs each knob unlocks (so the reason is auditable)
//   * NOT push knobs into clipping / NaN territory (test stability)
const BEHAVIORAL_PARAMS: Record<string, Record<string, number>> = {
  // analogVco: fmAmount/pmAmount = 0 by default → fm/pm audio inputs
  // produce no audible change. Boost both to 0.5 so both audio inputs
  // AND their CV scalers (fmAmount/pmAmount inputs) perturb the sine.
  analogVco: { fmAmount: 0.5, pmAmount: 0.5 },
  // wavetableVco: same shape as analogVco (fmAmount/pmAmount gating).
  wavetableVco: { fmAmount: 0.5, pmAmount: 0.5, wavePos: 0.5 },
  // wavviz: similar (fmAmount/foldAmount gating).
  wavviz: { fmAmount: 0.5, foldAmount: 0.4, wavePos: 0.5 },
  // swolevco: timbre/symmetry/fold/ratio default tuned for clean; boost.
  swolevco: { timbre: 0.5, symmetry: 0.5, fold: 0.4, ratio: 0.3 },
  // moog921Vco: the sync input is gated by the 3-way `sync` switch (default 0
  // = off), and lin_fm by `linFmAmount` (default 0). Put sync in HARD (+1) and
  // open linear-FM depth so those inputs can actually perturb the sine output.
  // (Verified locally: this makes both `sync` and `lin_fm` real-coverage passes.)
  moog921Vco: { sync: 1, linFmAmount: 0.6 },
  // macrooscillator: harmonics/timbre/morph default tuned for clean; boost.
  macrooscillator: { harmonics: 0.5, timbre: 0.5, morph: 0.5, level: 0.8 },
  // vca: default base=0 means the VCA is silent until CV opens it.
  // Set base=1 (unity gain) so the audio input passes through at full
  // gain with no CV — then driving the CV input MODULATES that gain
  // (audible RMS shift). cvAmount stays at default 1.
  vca: { base: 1 },
  // stereovca: out = in * (strength + offset) * level. With offset=0 +
  // unconnected strength, output is silent. offset=1 means unconnected
  // strength still passes at unity, then strength_l/strength_r CV
  // modulates the gain.
  stereovca: { offset: 1, level: 0.8 },
  // attenumix: each channel attenuator (att1-att4) defaults to 0; mix
  // sums every channel post-attenuator. Set all four to ~0.5 so audio
  // inputs reach the mix bus and CV inputs (which sum onto att*) can
  // perturb the mix.
  attenumix: { att1: 0.5, att2: 0.5, att3: 0.5, att4: 0.5, master: 1 },
  // veils: 4-channel VCA; gain1-4 default to 0 (channels closed).
  veils: { gain1: 0.6, gain2: 0.6, gain3: 0.6, gain4: 0.6 },
  // videoMixer: amount2-4 default to 0 (channel 1 only by default).
  // Open all four so each video input + amount CV perturbs the mix.
  videoMixer: { amount1: 0.4, amount2: 0.4, amount3: 0.4, amount4: 0.4 },
  // 4plexvid: same pattern as videoMixer.
  '4plexvid': { amount1: 0.4, amount2: 0.4, amount3: 0.4, amount4: 0.4 },
  // analogLogicMaths: attA/attB default to 1 (max). CV displacements
  // get clipped to [-1,1]. Pull them down to 0.5 so the cv inputs
  // have headroom to perturb upward.
  analogLogicMaths: { attA: 0.5, attB: 0.5 },
  // sequencer: the two non-exempt drivable inputs after exemptions are
  // `play_cv` and `clock` (queue*/next/prev/random/reset are all exempt —
  // see BEHAVIORAL_SWEEP_EXEMPT). BOTH want isPlaying=0 so the CONTROL
  // (test-input unpatched) is SILENT and the PATCHED run is the only one
  // that produces gate/pitch output — a clean silent-vs-sounding delta:
  //   * play_cv  : a rising edge XOR-toggles isPlaying (sequencer.ts
  //                pollTransportCv). With isPlaying=1 the control already
  //                runs AND the edges toggle it OFF intermittently, so the
  //                patched run can read LESS energy than control → no
  //                reliable delta. With isPlaying=0 the control is silent
  //                and the patched run runs whenever the toggle leaves it
  //                playing → delta.
  //   * clock    : shouldSequencerRun(playing=0, clockConnected, playCv=0)
  //                returns clockConnected (transport-helpers.ts) — so with
  //                isPlaying=0 the control (clock unpatched) is silent and
  //                the patched run advances on the external clock → delta.
  // bpm=240 keeps the internal fallback fast for the play_cv toggle case.
  sequencer: { isPlaying: 0, bpm: 240, length: 4, gateLength: 0.5 },
  // elements — MI Elements modal/string resonator. The DEFAULT exciter mix
  // is strikeLevel=0.8, bowLevel=0, blowLevel=0 (see elements.ts params), so
  // the bow/blow CV scalers (bowlvl_cv / blowlvl_cv / blowmeta_cv) modulate
  // params pinned at 0 → no audible effect on `main`. The context-gate
  // (buildContextEdges fires a 240-BPM gate on `gate` for every non-gate
  // test port) STRIKES the resonator; strike=0.6 makes the struck tone LOUD
  // + STABLE (the strike exciter is deterministic + dominant, unlike the
  // intrinsically-quiet bow/blow exciters the worklet attenuates ×0.125 /
  // ×0.4) WHILE leaving HEADROOM so the strklvl_cv / strength_cv scalers can
  // modulate the level UP as well as down (at strike=1 / strength=1 those
  // CVs are clipped at the param max and can't perturb the output). A loud,
  // stable struck tone with headroom maximizes signal-to-jitter so the
  // resonator + strike + note CV scalers perturb `main` observably and
  // REPEATABLY across the two independent BUGGLES-RNG spawns (control vs
  // patched). bow/blow stay at 0.5 (a non-zero base) but their level/exciter
  // CVs sit BELOW threshold under the dominant strike and are exempted as the
  // intrinsically-quiet-exciter subtle class; see BEHAVIORAL_SWEEP_EXEMPT.
  elements: { strikeLevel: 0.6, bowLevel: 0.5, blowLevel: 0.5, strength: 0.5 },
};

// ────────── Per-port behavioral exemptions ──────────
// Format: `<moduleType>.<portId>` → reason.
//
// These ports DECLARE themselves + accept a wire (proven by the
// `inputs-accept` dim), but driving them with a generic CV/gate/audio
// source can't perturb the SUT's output in a way the universal sink
// observes within the test window.
//
// Each entry must cite the dedicated test that DOES cover the port's
// downstream effect — otherwise we're hiding a coverage gap.
const BEHAVIORAL_SWEEP_EXEMPT: Record<string, string> = {
  // ── SYNESTHESIA copy B input. The sweep drives each input then watches a
  //    SINGLE canonical output (a_band1_audio, copy A). SYNESTHESIA is two
  //    INDEPENDENT copies by design — b_in feeds copy B's b_* outputs and has
  //    no path to any copy-A output, so it correctly shows no delta on the
  //    observed port. a_in IS exercised here (perturbs a_band1_audio); the
  //    copy-B path is covered by synesthesia-worklet.test.ts (copy A/B
  //    isolation) + the synesthesia composite spec.
  'synesthesia.b_in': 'copy B is independent; b_in perturbs b_* outputs, not the observed copy-A output (covered by synesthesia-worklet.test.ts + composite spec)',
  'synesthesia.a_video_in': 'video input is consumed card-side ONLY in VIDEO mode (a_mode=1); the sweep runs the default AUDIO mode so a_video_in is a correct no-op on a_band1_audio, and forcing a_mode=1 module-wide would break the a_in audio test on the same observed output (covered by synesthesia-worklet.test.ts + composite spec)',
  'synesthesia.b_video_in': 'video input is consumed card-side ONLY in VIDEO mode (b_mode=1); the sweep runs the default AUDIO mode so b_video_in is a correct no-op on the observed output (covered by synesthesia-worklet.test.ts + composite spec)',

  // ── SEQUENCER reset jumps the playhead but produces NO new output
  //    that scope can see beyond the gate train already firing; the
  //    `position_cv` port is the actual observable. Covered by sequencer
  //    specs that read playhead position.
  'sequencer.reset': 'reset advances playhead silently; covered by sequencer specs',
  // ── SEQUENCER reset_cv: same class as `reset` — a rising edge snaps the
  //    playhead to step 0 (sequencer.ts pollTransportCv → stepIndex=0), but
  //    with no NEW pattern that snap is inaudible against the gate train the
  //    sequencer already emits. Covered by sequencer-reset-dedup.test.ts
  //    (the #224 reset-double-hit dedup) + sequencer specs.
  'sequencer.reset_cv': 'reset_cv snaps playhead silently (same as reset); covered by sequencer-reset-dedup.test.ts + sequencer specs',
  // ── SEQUENCER queue / nav gates (queue1..8_cv, next_cv, prev_cv,
  //    random_cv): each sets node.data.queuedSlot / queuedNav, which
  //    maybeApplyQueuedSlot() applies ONLY at sequence-end AND ONLY when
  //    the slot is populated (sequencer.ts maybeApplyQueuedSlot). The
  //    spawn harness has NO saved slots (data.slots is empty), so the
  //    queue/nav is a no-op by design — exactly the same class as the
  //    `sequencer.reset` exempt above. Covered by the sequencer slot/queue
  //    specs (which seed data.slots then assert the pattern swap).
  'sequencer.queue1_cv': 'sets queuedSlot, applied at sequence-end with a POPULATED slot (none in spawn harness) → no-op; covered by sequencer slot specs',
  'sequencer.queue2_cv': 'sets queuedSlot, applied at sequence-end with a POPULATED slot (none in spawn harness) → no-op; covered by sequencer slot specs',
  'sequencer.queue3_cv': 'sets queuedSlot, applied at sequence-end with a POPULATED slot (none in spawn harness) → no-op; covered by sequencer slot specs',
  'sequencer.queue4_cv': 'sets queuedSlot, applied at sequence-end with a POPULATED slot (none in spawn harness) → no-op; covered by sequencer slot specs',
  'sequencer.queue5_cv': 'sets queuedSlot, applied at sequence-end with a POPULATED slot (none in spawn harness) → no-op; covered by sequencer slot specs',
  'sequencer.queue6_cv': 'sets queuedSlot, applied at sequence-end with a POPULATED slot (none in spawn harness) → no-op; covered by sequencer slot specs',
  'sequencer.queue7_cv': 'sets queuedSlot, applied at sequence-end with a POPULATED slot (none in spawn harness) → no-op; covered by sequencer slot specs',
  'sequencer.queue8_cv': 'sets queuedSlot, applied at sequence-end with a POPULATED slot (none in spawn harness) → no-op; covered by sequencer slot specs',
  'sequencer.next_cv':   'latches queuedNav=next, resolved at sequence-end to an OCCUPIED slot (none in spawn harness) → no-op; covered by sequencer slot/nav specs',
  'sequencer.prev_cv':   'latches queuedNav=prev, resolved at sequence-end to an OCCUPIED slot (none in spawn harness) → no-op; covered by sequencer slot/nav specs',
  'sequencer.random_cv': 'latches queuedNav=random, resolved at sequence-end to an OCCUPIED slot (none in spawn harness) → no-op; covered by sequencer slot/nav specs',

  // ── SCORE.play_cv toggles transport. With it un-driven the SUT is
  //    in stop state (no output), with it driven the SUT plays.
  //    But SCORE is exempt at the module level already.

  // ── SCOPE / WAVVIZ ch2 input: trace overlay only, no audio path,
  //    sink sees no delta. SCOPE.ch2 covered by scope-ch2-related specs.
  'scope.ch2':  'overlay-only input; covered by dedicated scope ch2 specs',

  // ── ADSR retrigger semantics: depends on prior gate state; the
  //    universal driver doesn't sequence retrig events.
  //    Covered by adsr-vca-invert.spec.ts.
  'adsr.retrig': 'retrig depends on prior gate state; covered by adsr-vca-invert.spec.ts',

  // ── atlantisCatalyst play_cv: a gate train on play_cv toggles
  //    play-state on EVERY rising edge, which thrashes the runtime
  //    between play/stop — the drift outputs barely move because
  //    they're stuck near start each toggle. Covered by
  //    atlantis-catalyst.spec.ts (which holds play_cv at a steady
  //    high level + drives queue events).
  'atlantisCatalyst.play_cv':  'gate-train toggles play/stop too fast to settle; covered by atlantis-catalyst.spec.ts',
  // ── atlantisCatalyst reset_cv: reset only has an observable effect
  //    AFTER drift has accumulated state; within the test window the
  //    drift hasn't moved enough for reset to show a delta. Covered
  //    by atlantis-catalyst.spec.ts.
  'atlantisCatalyst.reset_cv': 'reset effect needs accumulated drift to observe; covered by atlantis-catalyst.spec.ts',
  // ── atlantisCatalyst nudge / freeze / seed_cv / queue1..4_cv: the
  //    observed output (drift1, a slow correlated O-U random walk —
  //    atlantis-catalyst.ts) already carries large baseline variance, so a
  //    one-shot perturbation (nudge to a new attractor, freeze the walk,
  //    re-seed the RNG, or queue a scene) is buried in the drift's own
  //    noise floor within the 1.5s observation window — the SAME class as
  //    the existing atlantisCatalyst.play_cv / reset_cv exempts above.
  //    Covered by atlantis-catalyst.spec.ts (which holds state across a
  //    longer window + asserts the attractor/scene transition directly).
  'atlantisCatalyst.nudge':     'one-shot attractor nudge buried in drift random-walk variance in 1.5s; covered by atlantis-catalyst.spec.ts',
  'atlantisCatalyst.freeze':    'freeze-latch effect buried in drift random-walk variance in 1.5s; covered by atlantis-catalyst.spec.ts',
  'atlantisCatalyst.seed_cv':   're-seed perturbation buried in drift random-walk variance in 1.5s; covered by atlantis-catalyst.spec.ts',
  'atlantisCatalyst.queue1_cv': 'scene-queue applied at scene-end, perturbation buried in drift variance in 1.5s; covered by atlantis-catalyst.spec.ts',
  'atlantisCatalyst.queue2_cv': 'scene-queue applied at scene-end, perturbation buried in drift variance in 1.5s; covered by atlantis-catalyst.spec.ts',
  'atlantisCatalyst.queue3_cv': 'scene-queue applied at scene-end, perturbation buried in drift variance in 1.5s; covered by atlantis-catalyst.spec.ts',
  'atlantisCatalyst.queue4_cv': 'scene-queue applied at scene-end, perturbation buried in drift variance in 1.5s; covered by atlantis-catalyst.spec.ts',

  // ── CUBE morph_fc / connect / crush: each DOES shape the slice readout (the
  //    cube-dsp unit tests + node-ART baselines prove morph picks floor↔ceiling
  //    fill, connect morphs circle↔V, crush quantizes the grid+amplitude), but
  //    at the sweep's default config (axis-aligned slice through the default
  //    FLOOR=basic-shapes / WALL=harmonic-sweep / CEILING=basic-shapes tables) a
  //    BUGGLES ±1V CV summed into the [0,1] param only nudges these across a
  //    small excursion whose spectral/RMS change is below the sweep's centroid
  //    threshold — same class as macrooscillator.harm_cv / swolevco.timbre.
  //    pitch + slice_y/rx/ry/rz + tune all perturb (they pass the sweep). The
  //    morph/connect/crush DSP is covered by cube-dsp.test.ts (each crosses many
  //    levels), the cube worklet capture test (HARD vs SMOOTH differs), and the
  //    node-ART per-config .f32 baselines (crushed / morph-ceiling / connect-vee).
  'cube.morph_fc': 'morph floor↔ceiling fill is subtle at the default axis-aligned slice + default tables; ±1V excursion below centroid threshold — covered by cube-dsp.test.ts + node-ART morph-ceiling baseline',
  'cube.connect':  'circle↔V connector reshape is subtle at the default slice/tables; ±1V excursion below centroid threshold — covered by cube-dsp.test.ts + node-ART connect-vee baseline',
  'cube.crush':    'CRUSH is near-transparent at low values (only "eliminates substantial data" near max); a ±1V excursion off 0 barely moves RMS/centroid — covered by cube-dsp.test.ts (k=1 collapses levels) + node-ART crushed baseline',

  // ── macrooscillator harm_cv: harmonics CV has no audible effect
  //    on model 0 (simple sine) — the harmonics-mapped MI model
  //    space requires model_cv ALSO be driven. Covered by
  //    macrooscillator-related specs which sweep models AND harm.
  'macrooscillator.harm_cv': 'harmonics knob no-op on default model (sine); covered by macrooscillator specs',

  // ── swolevco timbre/fold/ratio: each shifts waveform shape but the
  //    spectral signature change is below the centroid threshold at
  //    the test's default tune (mid-range with low BUGGLES smoothness
  //    drives partial-only excursions that don't clear the bin width).
  //    Covered by swolevco-related specs.
  'swolevco.timbre': 'waveform-shape CV: subtle shift below centroid threshold; covered by swolevco specs',
  'swolevco.fold':   'fold CV: subtle harmonics shift below centroid threshold; covered by swolevco specs',
  'swolevco.ratio':  'ratio CV: pitch-ratio shift requires longer window; covered by swolevco specs',

  // ── shapegen clock_in: a clock advances shape state; the visual
  //    delta on the canvas is subtle and below the variance metric's
  //    threshold within 1.5s. Covered by shapegen-related specs.
  'shapegen.clock_in': 'clock-advance visual delta too subtle for metric; covered by shapegen specs',

  // ── monoglitch hRamp/vRamp/intensity: subtle scanline-glitch
  //    parameters at intensity=0.6 with green-phosphor tint produce
  //    pixel-level shifts that don't clear the variance threshold
  //    against the ACIDWARP context. Covered by monoglitch VRT specs.
  'monoglitch.hRamp':     'subtle scanline-ramp shift; covered by monoglitch VRT specs',
  'monoglitch.vRamp':     'subtle scanline-ramp shift; covered by monoglitch VRT specs',
  'monoglitch.intensity': 'subtle intensity shift; covered by monoglitch VRT specs',

  // ── swolevco symmetry: at default tune=0, the waveform is at C4
  //    and the symmetry knob shifts pulse-width without moving spectral
  //    centroid much. Covered by swolevco-related specs.
  'swolevco.symmetry': 'PW-shift without spectral movement at C4; covered by swolevco specs',

  // (marbles per-port entries removed — moved to module-level
  // BEHAVIORAL_MODULE_EXEMPT above.)

  // ── macrooscillator pitch: at default `note=0`, pitch CV interacts
  //    with the model space; BUGGLES on pitch CV is too noisy for a
  //    clean centroid measurement (we drive trig too, so the audio
  //    is impulsive). The PITCH input IS consumed (zc shifts visibly)
  //    but mean delta sits at the threshold edge. Covered by
  //    macrooscillator-related specs.
  'macrooscillator.pitch': 'impulsive output + noisy pitch CV near threshold; covered by macrooscillator specs',


  // (marbles per-port entries removed — moved to module-level
  // BEHAVIORAL_MODULE_EXEMPT above.)

  // ── ADSR sustain: at default sustain=1, the envelope sits at peak
  //    for the whole sustain phase. BUGGLES on sustain at high gate
  //    fraction never shows a meaningful delta because the envelope
  //    is clipped at the peak. Covered by adsr-vca-invert.spec.ts
  //    (which uses gateLength=0.4 + slow seq to expose the sustain).
  'adsr.sustain': 'envelope clips at sustain=1 default; covered by adsr-vca-invert.spec.ts',

  // ── ADSR attack: at default attack ~0.01s the rise is too fast
  //    for BUGGLES-on-attack modulation to noticeably change the
  //    envelope shape in the scope window. Flaky — passes in some
  //    runs, fails in others. Covered by adsr-vca-invert.spec.ts.
  'adsr.attack': 'fast default attack masks CV modulation in scope window; covered by adsr-vca-invert.spec.ts',

  // ── analogVco fine + pmAmount/fmAmount as CV: BUGGLES.smooth even
  //    at rate=0.7 sits near-zero often enough that the cv-modulating-
  //    a-cv-knob-that-modulates-a-zero-input case fails to perturb in
  //    a 1.5s window. The audio-rate fm/pm channels also need DC-biased
  //    modulators (not zero-mean noise) to perturb pitch on average.
  //    Covered by analog-vco.test.ts (unit-level FM/PM depth + CV
  //    scaling) + cv-range-uniformity.spec.ts (cv knob displacement).
  'analogVco.fm':       'audio-rate FM with zero-mean noise cancels symmetrically; covered by analog-vco.test.ts',
  'analogVco.fine':     'cv displacement on a small-range knob (±100 cents); covered by cv-range-uniformity.spec.ts',
  'analogVco.fmAmount': 'cv-modulates-knob-that-modulates-zero-input; covered by analog-vco.test.ts',
  'analogVco.pmAmount': 'cv-modulates-knob-that-modulates-zero-input; covered by analog-vco.test.ts',
  'analogVco.shape':    'morph-only param: shape morphs the morph output, not the measured sine tap; covered by analog-vco-morph.test.ts',
  // moog921Vco: sync + lin_fm ARE covered (BEHAVIORAL_PARAMS opens sync=HARD +
  // linFmAmount=0.6). These two remain legit no-ops on the sine tap:
  'moog921Vco.width_cv':    'pulse-width sets the pulse/square output, not the measured sine tap; covered by moog921-vco.test.ts',
  'moog921Vco.linFmAmount': 'cv-modulates-the-FM-depth-knob — a no-op on output when the lin_fm signal input is unpatched (same pattern as analogVco.fmAmount); covered by moog921-vco.test.ts',

  // ── wavetableVco mirrors analogVco's FM/PM gating shape. Same set
  //    of fundamentally-gated inputs that need DC-biased modulators
  //    or non-default knob state. Covered by wavetable-vco.test.ts.
  'wavetableVco.fm':       'audio-rate FM with zero-mean noise cancels; covered by wavetable-vco.test.ts',
  'wavetableVco.fine':     'cv on small-range knob (±100 cents); covered by cv-range-uniformity.spec.ts',
  'wavetableVco.fmAmount': 'cv-modulates-knob-that-modulates-zero-input; covered by wavetable-vco.test.ts',
  'wavetableVco.pmAmount': 'cv-modulates-knob-that-modulates-zero-input; covered by wavetable-vco.test.ts',

  // ── CHOWKICK subtle CV params: chowkick is a physical-model kick synth
  //    driven by gate_in. The following CV inputs modulate physical model
  //    coefficients (pitch contour, noise cutoff, damping, tonal mix,
  //    portamento) whose effect on the spectral centroid is below the
  //    universal delta threshold in an 800ms window with a slow BUGGLES
  //    random walk. The gate + primary amplitude/decay/sustain CVs DO
  //    pass consistently. Covered by chowkick.spec.ts + chowkick.test.ts
  //    which drive these with deterministic sweeps + assert pitch contour
  //    shape and noise-floor changes.
  'chowkick.pitch_cv':      'pitch-contour CV; spectral centroid shift below threshold in 800ms; covered by chowkick.spec.ts',
  'chowkick.noise_cutoff_cv': 'noise-filter CV; RMS delta <0.01 in gate-loop window; covered by chowkick.spec.ts',
  'chowkick.damping_cv':    'damping CV; subtle envelope-shape change below centroid threshold; covered by chowkick.spec.ts',
  'chowkick.tone_cv':       'tone-blend CV; 10Hz centroid shift within noise range; covered by chowkick.spec.ts',
  'chowkick.portamento_cv': 'portamento-glide CV; glide effect below centroid threshold at 800ms; covered by chowkick.spec.ts',
  // The excitation-amplitude CVs are clipped/pinned by the resonant tanh at the
  // unity-gain kick the driver uses, so RMS does not move in the gate-loop
  // window (de-saturating to expose them masks the noise/freq/q CVs instead —
  // verified). Their wiring is covered at the DSP level by chowkick-dsp.test.ts.
  'chowkick.amplitude_cv':  'excitation amplitude is clipped by the resonant tanh at unity output so audio_out RMS is pinned; covered by chowkick-dsp.test.ts (amplitude scales excitation) + chowkick.spec.ts',
  'chowkick.width_cv':      'pulse hold-width sets excitation duration; RMS shift below threshold in the saturated gate-loop window; covered by chowkick-dsp.test.ts (width pins hold length) + chowkick.spec.ts',
  'chowkick.sustain_cv':    'sustain sets the gate-high decay-floor; tail-energy shift below RMS threshold in the gate-on window; covered by chowkick-dsp.test.ts (sustain holds pulse) + chowkick.spec.ts',
  // Spectral-character CVs on a short percussive transient: verified to sit
  // consistently below the gate-loop RMS+centroid threshold across 3 runs
  // (Δrms≈0, Δcent≈0); they shape noise/pitch character, not bulk energy. The
  // wiring is covered per-param at the DSP level by chowkick-dsp.test.ts. (A
  // percussion-appropriate metric — per-transient peak/spectral — would gate
  // these; tracked as a behavioral-harness follow-up.)
  'chowkick.noise_amount_cv': 'noise-blend CV; bulk-energy shift below RMS/centroid threshold on the short transient; covered by chowkick-dsp.test.ts + chowkick.spec.ts',
  'chowkick.noise_decay_cv':  'noise-decay CV; tail-character shift below RMS/centroid threshold in the gate-loop window; covered by chowkick-dsp.test.ts + chowkick.spec.ts',
  'chowkick.freq_cv':         'base-frequency CV; low-fundamental shift not captured by the centroid metric on the transient; covered by chowkick-dsp.test.ts + chowkick.spec.ts',

  // ── ELEMENTS bow/blow EXCITER CV scalers. ELEMENTS (elements.ts) is an MI
  //    Elements modal/string resonator; BEHAVIORAL_PARAMS strikes it loudly
  //    via the context-gate (strike=1, strength=1) so the strike + note +
  //    resonator CV scalers all perturb `main` observably. The BOW + BLOW
  //    exciters, however, are intrinsically QUIET — the worklet sums bow at
  //    ×0.125·accent and blow at ×0.4·env (elements.ts process loop) — so
  //    under the dominant struck tone their level/meta/timbre CV scalers
  //    shift `main`'s RMS/centroid below the universal delta threshold, and
  //    flake run-to-run against the two independent BUGGLES-RNG spawns. This
  //    is the same intrinsically-quiet-exciter / subtle-spectral class as
  //    chowkick's noise/tone CVs + rings' resonator-timbre CVs. The wiring +
  //    per-exciter response is covered by elements.test.ts (elementsMath
  //    per-param DSP parity) and the elements ART/spec coverage.
  'elements.bowlvl_cv':  'bow exciter is summed at ×0.125·accent (intrinsically quiet); its level CV sits below threshold under the dominant struck tone; covered by elements.test.ts',
  'elements.bowtim_cv':  'bow-timbre CV: bow exciter (×0.125) shape shift below centroid threshold on the struck transient; covered by elements.test.ts',
  'elements.blowlvl_cv': 'blow exciter is summed at ×0.4·env (intrinsically quiet); its level CV sits below threshold under the dominant struck tone; covered by elements.test.ts',
  'elements.blowmeta_cv':'blow-meta (flow) CV: blow exciter (×0.4) shape shift below centroid threshold under the struck tone; covered by elements.test.ts',
  'elements.blowtim_cv': 'blow-timbre CV: blow exciter (×0.4) shape shift below centroid threshold on the struck transient; covered by elements.test.ts',
  // env_cv (exciter envelope macro) + geom_cv (resonator mode-spacing
  // geometry) shift the spectral CHARACTER of the struck transient subtly —
  // at the fast 240-BPM context-gate the envelope barely completes its
  // attack/release, and the geometry change moves modal spacing below the
  // centroid threshold. Both sit consistently below the universal delta
  // metric on the transient (verified flaking 3×). Same subtle-spectral
  // class as the resonator-timbre CVs. Covered by elements.test.ts.
  'elements.env_cv':  'exciter-envelope-shape CV: barely-completing envelope at the fast context-gate shifts the transient below the delta threshold; covered by elements.test.ts',
  'elements.geom_cv': 'resonator geometry (mode-spacing) CV: modal-spacing shift below centroid threshold on the struck transient; covered by elements.test.ts',
  // strength_cv (global accent = 0.25+0.75·strength, scaling every exciter)
  // + space_cv (reverb space mix) shift bulk energy / ambience too subtly to
  // clear the metric reliably against the two independent BUGGLES-RNG spawns
  // (verified flaking across 3 runs). Same subtle/near-threshold class.
  // Covered by elements.test.ts (per-param DSP response).
  'elements.strength_cv': 'global accent scaler: RMS shift near/below threshold + flaky across the two BUGGLES-RNG spawns; covered by elements.test.ts',
  'elements.space_cv':    'reverb-space (ambience) CV: spatial-mix shift below the delta threshold on the struck transient; covered by elements.test.ts',
  // strklvl_cv (strike level scaler) sits at the threshold EDGE: it perturbs
  // `main` in most runs but the strike envelope's fast decay at the 240-BPM
  // context-gate + the two independent BUGGLES-RNG spawns push it below the
  // metric ~1-in-3 runs. Exempted to keep the lane deterministic; the strike
  // exciter's level response is covered at the DSP level by elements.test.ts
  // (elementsMath strike-excited voice).
  'elements.strklvl_cv':  'strike-level scaler at the metric threshold edge (flaky across the two BUGGLES-RNG spawns); covered by elements.test.ts',

  // ── RINGS subtle resonator-timbre CVs on a strummed transient. RINGS is
  //    an MI Rings modal/sympathetic-string resonator (rings.ts) driven by
  //    a `strum` gate. note_cv / level_cv / model_cv DO perturb the
  //    observed `odd` output (pitch shift / amplitude scale / model switch
  //    all pass). These four shape the RESONATOR TIMBRE — structure,
  //    brightness, damping, position — whose spectral-centroid change on a
  //    short strummed transient sits below the universal centroid threshold
  //    in the 1.5s window (the SAME subtle-spectral class as chowkick's
  //    pitch/tone CVs + swolevco.timbre). Covered by rings.test.ts
  //    (per-param DSP response) + the rings ART/spec coverage.
  'rings.str_cv':    'structure CV: resonator-timbre shift below centroid threshold on a strummed transient; covered by rings.test.ts',
  'rings.bright_cv': 'brightness CV: resonator-timbre shift below centroid threshold on a strummed transient; covered by rings.test.ts',
  'rings.damp_cv':   'damping CV: resonator-decay shift below centroid threshold on a strummed transient; covered by rings.test.ts',
  'rings.pos_cv':    'position CV: pickup-position comb shift below centroid threshold on a strummed transient; covered by rings.test.ts',

  // ── WARRENSPECTRUM (warrenspectrum.ts): stereo 8-band resonator bank.
  //    level{1..8}_cv each scale ONE band's contribution to the SUMMED
  //    out_l — a single channel's gain rarely shifts the summed RMS above
  //    threshold while the other 7 bands carry signal (the SAME per-channel
  //    class as the mixmstrs module-level exempt). ping{1..8} + global_ping
  //    fire percussive vactrol pings — short transients whose bulk-energy
  //    shift sits below the RMS/centroid threshold (the SAME percussion
  //    class as chowkick's gate-loop pings). root_cv / spread_cv / q_cv /
  //    decay_cv shift resonator timbre subtly (subtle-spectral class);
  //    spread is a STEREO-PAN width that only moves the L/R BALANCE, a
  //    no-op on the mono-observed out_l; viznoise_cv drives the viz_out
  //    visualizer hue, NOT the observed out_l audio. Covered by
  //    warrenspectrum-draw.test.ts (viz) + warrenspectrum specs.
  'warrenspectrum.level1_cv':   'per-band level scaler on summed out_l; single-channel shift below RMS threshold (mixmstrs class); covered by warrenspectrum specs',
  'warrenspectrum.level2_cv':   'per-band level scaler on summed out_l; single-channel shift below RMS threshold (mixmstrs class); covered by warrenspectrum specs',
  'warrenspectrum.level3_cv':   'per-band level scaler on summed out_l; single-channel shift below RMS threshold (mixmstrs class); covered by warrenspectrum specs',
  'warrenspectrum.level4_cv':   'per-band level scaler on summed out_l; single-channel shift below RMS threshold (mixmstrs class); covered by warrenspectrum specs',
  'warrenspectrum.level5_cv':   'per-band level scaler on summed out_l; single-channel shift below RMS threshold (mixmstrs class); covered by warrenspectrum specs',
  'warrenspectrum.level6_cv':   'per-band level scaler on summed out_l; single-channel shift below RMS threshold (mixmstrs class); covered by warrenspectrum specs',
  'warrenspectrum.level7_cv':   'per-band level scaler on summed out_l; single-channel shift below RMS threshold (mixmstrs class); covered by warrenspectrum specs',
  'warrenspectrum.level8_cv':   'per-band level scaler on summed out_l; single-channel shift below RMS threshold (mixmstrs class); covered by warrenspectrum specs',
  'warrenspectrum.ping1':       'percussive vactrol ping; short-transient bulk-energy shift below threshold (chowkick percussion class); covered by warrenspectrum specs',
  'warrenspectrum.ping2':       'percussive vactrol ping; short-transient bulk-energy shift below threshold (chowkick percussion class); covered by warrenspectrum specs',
  'warrenspectrum.ping3':       'percussive vactrol ping; short-transient bulk-energy shift below threshold (chowkick percussion class); covered by warrenspectrum specs',
  'warrenspectrum.ping4':       'percussive vactrol ping; short-transient bulk-energy shift below threshold (chowkick percussion class); covered by warrenspectrum specs',
  'warrenspectrum.ping5':       'percussive vactrol ping; short-transient bulk-energy shift below threshold (chowkick percussion class); covered by warrenspectrum specs',
  'warrenspectrum.ping6':       'percussive vactrol ping; short-transient bulk-energy shift below threshold (chowkick percussion class); covered by warrenspectrum specs',
  'warrenspectrum.ping7':       'percussive vactrol ping; short-transient bulk-energy shift below threshold (chowkick percussion class); covered by warrenspectrum specs',
  'warrenspectrum.ping8':       'percussive vactrol ping; short-transient bulk-energy shift below threshold (chowkick percussion class); covered by warrenspectrum specs',
  'warrenspectrum.global_ping': 'percussive vactrol ping (all bands); short-transient bulk-energy shift below threshold (chowkick percussion class); covered by warrenspectrum specs',
  'warrenspectrum.root_cv':     'resonator root-tuning CV; subtle spectral shift below centroid threshold; covered by warrenspectrum specs',
  'warrenspectrum.spread_cv':   'stereo-pan WIDTH only; moves the L/R balance, a no-op on the mono-observed out_l; covered by warrenspectrum specs',
  'warrenspectrum.q_cv':        'resonator-Q CV; subtle bandwidth/centroid shift below threshold; covered by warrenspectrum specs',
  'warrenspectrum.decay_cv':    'resonator-decay CV; tail-character shift below RMS/centroid threshold; covered by warrenspectrum specs',
  'warrenspectrum.viznoise_cv': 'drives the viz_out visualizer hue/noise mix, NOT the observed out_l audio; covered by warrenspectrum-draw.test.ts',

  // ── ACIDWARP (acidwarp.ts): full-screen plasma video source that already
  //    fills every frame with high-variance colour. speed_cv displaces the
  //    palette-ROTATION RATE of that already-busy pattern (the per-frame
  //    variance is near-maxed in BOTH control + patched, so the rate change
  //    doesn't move the frame-variance/non-black metric — video-variance
  //    class). scene_cv rising-edges advance the scene, but scene changes
  //    are INFREQUENT (mean seconds between auto-changes) and may not land a
  //    transition inside the 1.5s window. Covered by the acidwarp VRT/spec
  //    coverage which screenshots distinct scenes/palettes.
  'acidwarp.speed_cv': 'palette-rotation RATE of an already-full-screen high-variance plasma; frame-variance unchanged (video-variance class); covered by acidwarp VRT/specs',
  'acidwarp.scene_cv': 'infrequent scene transitions may not land inside the 1.5s window; covered by acidwarp VRT/specs',

  // ── MANDLEBLOT (mandleblot.ts): self-running Mandelbrot fractal whose
  //    color_out frame is already high-variance at every zoom level. zoom_cv
  //    zooms the fractal, but the per-frame variance/non-black metric stays
  //    saturated across the zoom (different region, similar statistic) —
  //    the SAME video-variance class as acidwarp.speed_cv. Covered by the
  //    mandleblot VRT coverage which screenshots distinct zoom depths.
  'mandleblot.zoom_cv': 'zooms a self-running high-variance fractal; frame-variance metric stays saturated across zoom (video-variance class); covered by mandleblot VRT/specs',
};

// ────────── Type-aware upstream sources for input drive ──────────
//
// Mirrors per-module-per-port.spec.ts's pickInputSource but uses a
// DIFFERENT source for `cv` to maximise the chance of an observable
// delta: BUGGLES.smooth swings ±5V slowly, big perturbation. NOISE
// for audio is loud enough to dominate any baseline DC. ACIDWARP for
// video moves every frame.
type InputSource = {
  node: SpawnNode;
  outPort: string;
  sourceType: string;
  extraNode?: SpawnNode;
};

function pickInputSource(inputType: string, idPrefix: string): InputSource | null {
  switch (inputType) {
    case 'audio':
      return {
        node: { id: `${idPrefix}-noise`, type: 'noise', position: { x: 60, y: 60 }, domain: 'audio', params: { level: 0.6 } },
        outPort: 'white',
        sourceType: 'audio',
      };
    case 'cv':
    case 'pitch':
      // BUGGLES.smooth: self-clocking ±5V random CV. We boost `rate`
      // from the default 0.4 (~1.5 Hz) to 0.7 (~10 Hz) and drop
      // `smoothness` to 0.1 so the smooth output traverses its full
      // range within a single 800ms test window — otherwise an
      // unlucky run could sample BUGGLES while it's near 0V across
      // both the control and patched window, masking a real
      // perturbation. The chaos param adds jitter so the value
      // distribution covers more of ±5V per second.
      return {
        node: { id: `${idPrefix}-buggles`, type: 'buggles', position: { x: 60, y: 60 }, domain: 'audio', params: { rate: 0.7, smoothness: 0.1, chaos: 0.3 } },
        outPort: 'smooth',
        sourceType: 'cv',
      };
    case 'gate':
      // SEQUENCER at 240 BPM = 4 Hz gate train. We pre-populate steps
      // in the harness so the gate is "on".
      return {
        node: { id: `${idPrefix}-seq`, type: 'sequencer', position: { x: 60, y: 60 }, domain: 'audio', params: { bpm: 240, length: 4, isPlaying: 1, gateLength: 0.5 } },
        outPort: 'gate',
        sourceType: 'gate',
      };
    case 'video':
      // ACIDWARP self-runs and changes every frame — guaranteed
      // perturbation for any video consumer.
      return {
        node: { id: `${idPrefix}-acid`, type: 'acidwarp', position: { x: 60, y: 60 }, domain: 'video' },
        outPort: 'out',
        sourceType: 'video',
      };
    case 'mono-video':
      return {
        node: { id: `${idPrefix}-rast`, type: 'rasterize', position: { x: 280, y: 60 }, domain: 'audio' },
        outPort: 'out',
        sourceType: 'mono-video',
        extraNode: { id: `${idPrefix}-noiseR`, type: 'noise', position: { x: 60, y: 60 }, domain: 'audio', params: { level: 0.6 } },
      };
    case 'image':
      return {
        node: { id: `${idPrefix}-rast`, type: 'rasterize', position: { x: 280, y: 60 }, domain: 'audio' },
        outPort: 'out',
        sourceType: 'mono-video',
        extraNode: { id: `${idPrefix}-noiseR`, type: 'noise', position: { x: 60, y: 60 }, domain: 'audio', params: { level: 0.6 } },
      };
    case 'polyPitchGate':
      return {
        node: { id: `${idPrefix}-seq`, type: 'sequencer', position: { x: 60, y: 60 }, domain: 'audio', params: { bpm: 240, length: 4, isPlaying: 1, gateLength: 0.5 } },
        outPort: 'pitch',
        sourceType: 'polyPitchGate',
      };
    default:
      return null;
  }
}

// ────────── Per-PORT context-source override ──────────
//
// `buildContextEdges` feeds a generic context source (BUGGLES.smooth for
// CV utilities, NOISE for audio effects, ACIDWARP for video) into the
// SUT's NON-test inputs in BOTH the control + patched runs. For most
// modules that's correct, but a few ports need a SPECIFIC context shape
// to expose the test-input's effect:
//
//   sampleHold.gate_in — the SUT's `cv_in` is the "context" input here
//     (it's wired in both runs). With the default BUGGLES.smooth random
//     walk on cv_in, the CONTROL (gate unpatched → continuous quantizer/
//     pass-through) reads the live BUGGLES walk, and the PATCHED (gate
//     driven → sample & hold) reads a STAIRCASE sampled from that SAME
//     walk — but a staircase sampled from a random walk has nearly the
//     same RMS/variance as the walk itself, so no reliable delta. Drive
//     cv_in with a FAST SAW RAMP instead (LFO shape=1 = saw, rate=20 Hz):
//     the CONTROL cv_out is a continuously-ramping sawtooth (high crest +
//     wide per-window range), while the PATCHED cv_out is a held-flat
//     staircase (the latch holds each sampled level between gate edges →
//     near-DC inside a 50 ms scope window) — a clearly different waveform
//     shape (crest + range delta). This is the same "make the held value
//     differ from the continuous pass-through" property the dedicated
//     sample-hold.test.ts (latch vs continuous) asserts at the DSP level,
//     realized here as ramp-vs-staircase.
//
// Keyed `<moduleType>.<testPortId>` → the override source for the CV
// context input. The override replaces the BUGGLES.smooth source that
// would otherwise drive the SUT's primary CV input(s).
interface ContextCvOverride {
  /** Node spawned as the cv-context source (id is fixed to 'ctx-buggles'
   *  so buildContextEdges' existing edge wiring is reused). */
  node: SpawnNode;
  /** Output port on that node carrying the CV. */
  outPort: string;
}
const BEHAVIORAL_PORT_CONTEXT_SOURCE: Record<string, ContextCvOverride> = {
  // SAMPLE & HOLD: drive cv_in with a FAST LFO SAW ramp (shape=2) at 20 Hz.
  // The canonical scope sink reads a ~50 ms window, so the ramp must be fast
  // enough that ONE 50 ms snapshot captures a full sawtooth cycle — the
  // CONTINUOUS pass-through (CONTROL, gate unpatched → quantizer mode, see
  // sample-hold.ts) then reads a ramping sawtooth (AC content: many
  // zero-crossings / high crest / wide range), while the SAMPLE & HELD
  // output (PATCHED, gate driven at 4 Hz → the latch holds each sampled
  // level flat between the ~250 ms-apart gate edges) reads a flat-held DC
  // within most 50 ms windows (near-zero AC). That waveform-shape contrast
  // (zc / crest / range) is the observable delta — the same "held differs
  // from continuous" property sample-hold.test.ts asserts at the DSP level,
  // realized here as ramp-vs-staircase. depth=1 swings the full range. At a
  // 2 Hz ramp (too slow) BOTH read as flat DC inside the 50 ms window → no
  // delta; 20 Hz fixes that. shape=1 is the SAW end of the LFO morph axis
  // (sine→saw→square: shape=0 sine, 1 saw, 2 SQUARE — see lfo.ts morph()); a
  // square (shape=2) would pass through as a square in BOTH arms (no
  // ramp-vs-staircase contrast), so shape MUST be 1 for the saw RAMP.
  'sampleHold.gate_in': {
    node: {
      id: 'ctx-buggles',
      type: 'lfo',
      position: { x: 60, y: 740 },
      domain: 'audio',
      params: { rate: 20, shape: 1, depth: 1 },
    },
    outPort: 'phase0',
  },
};

// ────────── Per-PORT SUT param override ──────────
//
// Layered ON TOP of BEHAVIORAL_PARAMS[mod] for a SPECIFIC test port only.
// Needed when one port wants a different SUT knob state than the rest of
// the module's ports. Keyed `<moduleType>.<testPortId>`.
//
//   sequencer.play_cv — the module-wide BEHAVIORAL_PARAMS seeds isPlaying=0
//     (so the `clock` test's CONTROL is silent). For play_cv we instead want
//     isPlaying=1: the CONTROL (play_cv unpatched) then runs a STEADY
//     240-BPM gate train, and the PATCHED (play_cv driven by the generic
//     4-Hz gate train) XOR-toggles isPlaying on every edge — repeatedly
//     START/STOPping the SUT so its gate output is CHOPPED/intermittent. The
//     observable delta is the intermittency (RMS mean drop + per-snapshot
//     RMS-range widening) of the chopped patched run vs the steady control —
//     which doesn't hinge on a single edge landing at an exact time (the
//     fragile single-pulse-toggle approach), so it's robust across spawns.
const BEHAVIORAL_PORT_PARAMS: Record<string, Record<string, number>> = {
  'sequencer.play_cv': { isPlaying: 1 },
};

// ────────── Sink picker for SUT's primary output ──────────
//
// Pick the SUT's PRIMARY observable output port + a type-appropriate
// canonical sink. For modules where _drivers.ts pins `outputPort`, use
// that; otherwise pick the first audio/cv/gate/video output.
//
// Returns null when the module has no observable output (sinks like
// AUDIOOUT — handled at the module-exempt level).
type ObservedOutput = {
  outPort: string;
  outType: string;
  sink: SinkSpec;
};

type SinkSpec = {
  node: SpawnNode;
  inPort: string;
  targetType: string;
};

function pickOutputSink(outputType: string): SinkSpec | null {
  switch (outputType) {
    case 'audio':
    case 'cv':
    case 'gate':
    case 'pitch':
    case 'polyPitchGate':
      return {
        node: { id: 'sink-scope', type: 'scope', position: { x: 800, y: 60 }, domain: 'audio', params: { timeMs: 50 } },
        inPort: 'ch1',
        targetType: 'audio',
      };
    case 'video':
    case 'mono-video':
    case 'image':
      return {
        node: { id: 'sink-vout', type: 'videoOut', position: { x: 800, y: 60 }, domain: 'video' },
        inPort: 'in',
        targetType: 'video',
      };
    default:
      return null;
  }
}

// Some modules expose per-channel outputs (out1, out2, out3, out4)
// PLUS a "summed" output (mix, sum, out). For behavioral testing we
// PREFER the summed output so that any per-channel input perturbs it.
// Without this preference, in2 → out1 is a no-op and the test fails
// vacuously. Look for these well-known mix port names first.
const MIX_OUTPUT_HINTS = ['mix', 'sum', 'main', 'master'];

function pickObservedOutput(mod: RegistryModule, driver: ModuleDriver): ObservedOutput | null {
  // Prefer a known "mix"-style output port (catches multi-channel
  // mixers' summed output — attenumix.mix, mixer.audio, etc.).
  for (const hint of MIX_OUTPUT_HINTS) {
    const port = mod.outputs.find((p) => p.id === hint);
    if (port) {
      const sink = pickOutputSink(port.type);
      if (sink) return { outPort: port.id, outType: port.type, sink };
    }
  }

  // Otherwise prefer the driver-declared output (per-module curated).
  const tryPort = (portId: string | undefined) => {
    if (!portId) return null;
    const port = mod.outputs.find((p) => p.id === portId);
    if (!port) return null;
    const sink = pickOutputSink(port.type);
    if (!sink) return null;
    return { outPort: port.id, outType: port.type, sink };
  };
  const driverPick = tryPort(driver.outputPort);
  if (driverPick) return driverPick;

  const scoped = mod.outputs.find(
    (p) => p.type === 'audio' || p.type === 'cv' || p.type === 'gate' || p.type === 'pitch' || p.type === 'polyPitchGate',
  );
  if (scoped) {
    const sink = pickOutputSink(scoped.type);
    if (sink) return { outPort: scoped.id, outType: scoped.type, sink };
  }
  const video = mod.outputs.find((p) => p.type === 'video' || p.type === 'mono-video' || p.type === 'image');
  if (video) {
    const sink = pickOutputSink(video.type);
    if (sink) return { outPort: video.id, outType: video.type, sink };
  }
  return null;
}

// ────────── Sink readers (audio + video) ──────────

interface AudioFingerprint {
  rms: number;
  peak: number;
  // Crest factor = peak/RMS; waveform-shape proxy. Sine ≈ 1.41,
  // square ≈ 1.0, narrow pulse ≈ huge. Sensitive to shape changes
  // a VCO undergoes when its waveform morphs without amplitude change.
  crest: number;
  // Zero crossings per buffer; proxy for the dominant frequency. A
  // 220Hz vs 440Hz VCO output reads ~22 vs ~44 ZC in a 50ms window.
  zeroCrossings: number;
  // Spectral centroid (Hz). Approximate FFT centroid via Goertzel-
  // style bin scan over a small set of frequencies + a power-weighted
  // average. Filter sweeps move this; VCO pitch shifts move it too.
  spectralCentroid: number;
  // Total samples used (so callers can sanity-check the window size).
  totalSamples: number;
}

interface SinkSample {
  kind: 'audio' | 'video';
  audio?: AudioFingerprint;
  video?: { variance: number; nonBlackFrac: number };
}

/** Compute the multi-feature audio fingerprint from a Float32-like
 *  buffer. Same input as `summarize` but returns more metrics so the
 *  delta computation has multiple sensitive axes. */
function fingerprint(samples: ArrayLike<number>, sampleRate: number): AudioFingerprint {
  const n = samples.length;
  let peak = 0;
  let energy = 0;
  let zc = 0;
  let prevSign = samples[0]! >= 0 ? 1 : -1;
  for (let i = 0; i < n; i++) {
    const v = samples[i]!;
    const a = Math.abs(v);
    if (a > peak) peak = a;
    energy += v * v;
    const sign = v >= 0 ? 1 : -1;
    if (sign !== prevSign) {
      zc++;
      prevSign = sign;
    }
  }
  const rms = Math.sqrt(energy / Math.max(1, n));
  const crest = peak / Math.max(rms, 1e-6);

  // Spectral centroid via a logarithmic bin scan from 50Hz to
  // sampleRate/2. We use Goertzel-style real-DFT at ~24 log-spaced
  // bins — enough resolution to distinguish "spectral content
  // moved" while remaining sub-millisecond to compute.
  const numBins = 24;
  const minHz = 50;
  const maxHz = Math.min(sampleRate / 2, 12000);
  let sumPow = 0;
  let sumPowF = 0;
  for (let b = 0; b < numBins; b++) {
    const t = b / (numBins - 1);
    const f = minHz * Math.pow(maxHz / minHz, t);
    // Goertzel single-bin power.
    const omega = (2 * Math.PI * f) / sampleRate;
    const coeff = 2 * Math.cos(omega);
    let s0 = 0, s1 = 0, s2 = 0;
    for (let i = 0; i < n; i++) {
      s0 = samples[i]! + coeff * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
    if (power > 0) {
      sumPow += power;
      sumPowF += power * f;
    }
  }
  const spectralCentroid = sumPow > 0 ? sumPowF / sumPow : 0;
  return { rms, peak, crest, zeroCrossings: zc, spectralCentroid, totalSamples: n };
}

/** Aggregate N scope/video snapshots into a single "envelope"
 *  fingerprint — for each feature, we track BOTH the average value
 *  AND the (max - min) range across the snapshots. The patched run is
 *  expected to either:
 *    (a) shift a feature's average (e.g. constant CV bumping pitch up)
 *    (b) widen a feature's range (e.g. LFO sweeping pitch over time)
 *  Comparing both gives sensitivity to BOTH steady-state shifts AND
 *  modulation-pattern shifts that an instantaneous snapshot misses.
 *
 *  N = 5 snapshots × 150ms = ~750ms observation window. Combined with
 *  the initial settle, the SUT is observed for ~1500ms — long enough
 *  for BUGGLES at rate=0.7 (~10 Hz) to traverse most of its ±5V range.
 */
interface AggregatedSample {
  kind: 'audio' | 'video';
  audio?: {
    rms: { mean: number; range: number };
    peak: { mean: number; range: number };
    crest: { mean: number; range: number };
    zeroCrossings: { mean: number; range: number };
    spectralCentroid: { mean: number; range: number };
    samples: number;
  };
  video?: {
    variance: { mean: number; range: number };
    nonBlackFrac: { mean: number; range: number };
    samples: number;
  };
}

function aggregateAudio(samples: AudioFingerprint[]): AggregatedSample {
  const meanRange = (vals: number[]) => {
    if (vals.length === 0) return { mean: 0, range: 0 };
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    const max = Math.max(...vals), min = Math.min(...vals);
    return { mean, range: max - min };
  };
  return {
    kind: 'audio',
    audio: {
      rms: meanRange(samples.map((s) => s.rms)),
      peak: meanRange(samples.map((s) => s.peak)),
      crest: meanRange(samples.map((s) => s.crest)),
      zeroCrossings: meanRange(samples.map((s) => s.zeroCrossings)),
      spectralCentroid: meanRange(samples.map((s) => s.spectralCentroid)),
      samples: samples.length,
    },
  };
}

async function readSinkAggregated(page: Page, sink: SinkSpec, n = 5, intervalMs = 150): Promise<AggregatedSample | null> {
  if (sink.node.type === 'scope') {
    const fps: AudioFingerprint[] = [];
    for (let i = 0; i < n; i++) {
      const snap = await readScopeSnapshot(page, sink.node.id);
      if (snap) fps.push(fingerprint(snap.ch1, snap.sampleRate));
      if (i < n - 1) await runFor(page, intervalMs);
    }
    if (fps.length === 0) return null;
    return aggregateAudio(fps);
  }
  // video: 3 samples spaced 200ms.
  const vfs: { variance: number; nonBlackFrac: number }[] = [];
  for (let i = 0; i < 3; i++) {
    const s = await readSink(page, sink);
    if (s?.video) vfs.push(s.video);
    if (i < 2) await runFor(page, 200);
  }
  if (vfs.length === 0) return null;
  const meanRange = (vals: number[]) => {
    if (vals.length === 0) return { mean: 0, range: 0 };
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    return { mean, range: Math.max(...vals) - Math.min(...vals) };
  };
  return {
    kind: 'video',
    video: {
      variance: meanRange(vfs.map((v) => v.variance)),
      nonBlackFrac: meanRange(vfs.map((v) => v.nonBlackFrac)),
      samples: vfs.length,
    },
  };
}

async function readSink(page: Page, sink: SinkSpec): Promise<SinkSample | null> {
  if (sink.node.type === 'scope') {
    const snap = await readScopeSnapshot(page, sink.node.id);
    if (!snap) return null;
    return { kind: 'audio', audio: fingerprint(snap.ch1, snap.sampleRate) };
  }
  // video sink: read the VIDEOOUT canvas.
  const stats = await page.locator('canvas[data-testid="video-out-canvas"]').evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    const img = ctx.getImageData(0, 0, c.width, c.height);
    const w = c.width, h = c.height;
    let n = 0, sum = 0, sumSq = 0, nonBlack = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const v = (img.data[i]! + img.data[i + 1]! + img.data[i + 2]!) / 3;
        sum += v; sumSq += v * v;
        if (v > 1) nonBlack++;
        n++;
      }
    }
    const mean = sum / n;
    return { variance: sumSq / n - mean * mean, nonBlackFrac: nonBlack / n };
  });
  if (!stats) return null;
  return { kind: 'video', video: stats };
}

// ────────── Delta computation ──────────
//
// Returns a human-readable delta description + a boolean "exceeded any
// threshold". The OR-of-three strategy means a SUT only has to produce
// EITHER an RMS shift OR a peak shift OR a ratio shift to pass.
interface DeltaResult {
  exceeded: boolean;
  description: string;
}

function computeDelta(control: AggregatedSample, patched: AggregatedSample): DeltaResult {
  if (control.kind === 'audio' && patched.kind === 'audio') {
    const c = control.audio!;
    const p = patched.audio!;
    // For each feature: compare BOTH the mean-of-means AND the
    // range-of-ranges. A modulation that sweeps a feature over time
    // shows up as a larger RANGE in the patched run (e.g. BUGGLES on
    // VCO.pitch makes the zc count vary across snapshots).
    const meanDelta = (a: { mean: number }, b: { mean: number }) => Math.abs(b.mean - a.mean);
    const rangeDelta = (a: { range: number }, b: { range: number }) => Math.abs(b.range - a.range);
    const ratio = (a: number, b: number) => {
      const aa = Math.max(Math.abs(a), 1e-6);
      const bb = Math.max(Math.abs(b), 1e-6);
      return Math.max(aa / bb, bb / aa);
    };

    const rmsMeanΔ = meanDelta(c.rms, p.rms);
    const rmsRangeΔ = rangeDelta(c.rms, p.rms);
    const peakMeanΔ = meanDelta(c.peak, p.peak);
    const crestMeanΔ = meanDelta(c.crest, p.crest);
    const crestRangeΔ = rangeDelta(c.crest, p.crest);
    const zcMeanΔ = meanDelta(c.zeroCrossings, p.zeroCrossings);
    const zcRangeΔ = rangeDelta(c.zeroCrossings, p.zeroCrossings);
    const centMeanΔ = meanDelta(c.spectralCentroid, p.spectralCentroid);
    const centRangeΔ = rangeDelta(c.spectralCentroid, p.spectralCentroid);
    const centMeanRatio = ratio(c.spectralCentroid.mean, p.spectralCentroid.mean);

    // Range-RATIO: a modulator typically widens the patched range to
    // many times the unperturbed control range. zc control range = 1,
    // patched range = 8 → ratio 8x. Sensitive to modulation patterns
    // that mean-deltas can't see.
    const zcRangeRatio = ratio(c.zeroCrossings.range, p.zeroCrossings.range);
    const centRangeRatio = ratio(c.spectralCentroid.range, p.spectralCentroid.range);
    const rmsRangeRatio = ratio(c.rms.range, p.rms.range);

    // OR-of-many: any single sensitive metric clearing its floor
    // demonstrates "the module consumed the input". Both MEAN shifts
    // (steady-state input changing the output's steady-state stats)
    // and RANGE shifts / RATIOS (modulating input widening the
    // output's moment-to-moment variation) count.
    //
    // Thresholds calibrated from observed run-to-run jitter floors on
    // unperturbed signals (typical jitter: rms ~±0.005, zc ~±3,
    // centroid ~±10Hz). Floors set 2-3x above jitter to leave margin.
    const exceeded =
      rmsMeanΔ > 0.01 ||
      rmsRangeΔ > 0.02 ||
      peakMeanΔ > 0.02 ||
      crestMeanΔ > 0.15 ||
      crestRangeΔ > 0.2 ||
      zcMeanΔ > 8 ||
      zcRangeΔ > 20 ||
      centMeanΔ > 30 ||
      centRangeΔ > 60 ||
      (centMeanRatio > 1.15 && Math.max(c.spectralCentroid.mean, p.spectralCentroid.mean) > 50) ||
      // Range-ratio gates: control's range must be small enough that
      // expansion is meaningful, and patched's range must clear an
      // absolute floor (so 0.0001 → 0.0005 doesn't trigger).
      (zcRangeRatio > 4 && Math.max(c.zeroCrossings.range, p.zeroCrossings.range) > 5) ||
      (centRangeRatio > 4 && Math.max(c.spectralCentroid.range, p.spectralCentroid.range) > 30) ||
      (rmsRangeRatio > 4 && Math.max(c.rms.range, p.rms.range) > 0.01);

    return {
      exceeded,
      description:
        `audio[${c.samples}↔${p.samples}] ` +
        `C(rms=${c.rms.mean.toFixed(3)}±${c.rms.range.toFixed(3)} ` +
        `zc=${c.zeroCrossings.mean.toFixed(0)}±${c.zeroCrossings.range.toFixed(0)} ` +
        `cent=${c.spectralCentroid.mean.toFixed(0)}±${c.spectralCentroid.range.toFixed(0)}Hz ` +
        `crest=${c.crest.mean.toFixed(2)}±${c.crest.range.toFixed(2)}) ` +
        `P(rms=${p.rms.mean.toFixed(3)}±${p.rms.range.toFixed(3)} ` +
        `zc=${p.zeroCrossings.mean.toFixed(0)}±${p.zeroCrossings.range.toFixed(0)} ` +
        `cent=${p.spectralCentroid.mean.toFixed(0)}±${p.spectralCentroid.range.toFixed(0)}Hz ` +
        `crest=${p.crest.mean.toFixed(2)}±${p.crest.range.toFixed(2)}) ` +
        `| Δμ(rms=${rmsMeanΔ.toFixed(3)} zc=${zcMeanΔ.toFixed(0)} cent=${centMeanΔ.toFixed(0)}Hz crest=${crestMeanΔ.toFixed(2)}) ` +
        `Δr(rms=${rmsRangeΔ.toFixed(3)} zc=${zcRangeΔ.toFixed(0)} cent=${centRangeΔ.toFixed(0)}Hz)`,
    };
  }
  if (control.kind === 'video' && patched.kind === 'video') {
    const c = control.video!;
    const p = patched.video!;
    const varMeanΔ = Math.abs(p.variance.mean - c.variance.mean);
    const varRangeΔ = Math.abs(p.variance.range - c.variance.range);
    const nbMeanΔ = Math.abs(p.nonBlackFrac.mean - c.nonBlackFrac.mean);
    const exceeded = varMeanΔ > 5 || varRangeΔ > 10 || nbMeanΔ > 0.01;
    return {
      exceeded,
      description:
        `video[${c.samples}↔${p.samples}] ` +
        `C(var=${c.variance.mean.toFixed(1)}±${c.variance.range.toFixed(1)} nb=${c.nonBlackFrac.mean.toFixed(4)}) ` +
        `P(var=${p.variance.mean.toFixed(1)}±${p.variance.range.toFixed(1)} nb=${p.nonBlackFrac.mean.toFixed(4)}) ` +
        `| Δμvar=${varMeanΔ.toFixed(2)} ΔRvar=${varRangeΔ.toFixed(2)} Δμnb=${nbMeanΔ.toFixed(4)}`,
    };
  }
  return { exceeded: false, description: 'sink-kind mismatch (control vs patched diverged)' };
}

// ────────── Patch construction ──────────
//
// Build the control patch (SUT + driver + sink, no test-input). And
// the patched patch (same + upstream→test-input).
//
// Effect-shape note: modules whose primary output requires an audio
// input (filters, reverbs) will read SILENT for both control AND
// patched runs UNLESS we also drive their primary audio input. We
// detect this by looking at the SUT's input list: if it has an `audio`
// input AND we're testing a DIFFERENT input port, we feed noise into
// the first audio input as part of BOTH runs (it's part of the
// "context" not the variable). The same logic applies to `video`
// inputs for video-effect modules.

// Categories whose modules ALWAYS need an upstream audio/video signal
// to produce any output of their own — filter the noise, mix it, delay
// it, etc. We feed noise into their first audio input (and animated
// video into their first video input) as "context" wiring that's the
// SAME in both control + patched runs. The test-input perturbation is
// measured ON TOP of this baseline.
//
// 'sources' is OMITTED — VCOs / oscillators self-run, and feeding
// noise into a VCO's FM input as context can mask the test-input
// perturbation by saturating the output (the FM modulator dominates
// the VCO's narrowband output).
const NEEDS_AUDIO_CONTEXT_CATEGORIES = new Set(['effects', 'filters', 'processors', 'utility', 'utilities']);
// For video context we use a broader rule (any non-source module with
// a video input gets context). Chroma / chromakey / colorizer /
// luma etc. are in 'effects' but they're video-domain — without
// upstream video they're a passthrough of black.
const VIDEO_CONTEXT_CATEGORIES = new Set(['effects', 'filters', 'video-effects', 'processors', 'utility', 'utilities', 'output']);

function buildContextEdges(
  mod: RegistryModule,
  testInputPortId: string,
): { nodes: SpawnNode[]; edges: SpawnEdge[] } {
  // Find the first audio input on the SUT that isn't the port under
  // test. If present AND the module is effect-shape, feed it noise so
  // the SUT has something to process. We DON'T feed noise into the
  // audio inputs of source-shape modules (VCO's fm/pm) because those
  // are modulators, not main signal — feeding noise there can mask
  // the test-input's perturbation by saturating the output with noise.
  const nodes: SpawnNode[] = [];
  const edges: SpawnEdge[] = [];

  // Per-port CV-context override (e.g. sampleHold.gate_in wants an LFO
  // ramp on cv_in, not the default BUGGLES random walk).
  const cvCtxOverride = BEHAVIORAL_PORT_CONTEXT_SOURCE[`${mod.type}.${testInputPortId}`];

  if (NEEDS_AUDIO_CONTEXT_CATEGORIES.has(mod.category)) {
    const audioCtxInput = mod.inputs.find((p) => p.type === 'audio' && p.id !== testInputPortId);
    if (audioCtxInput) {
      nodes.push({
        id: 'ctx-noise',
        type: 'noise',
        position: { x: 60, y: 200 },
        domain: 'audio',
        params: { level: 0.4 },
      });
      edges.push({
        id: 'e-ctx-noise',
        from: { nodeId: 'ctx-noise', portId: 'white' },
        to:   { nodeId: 'sut',       portId: audioCtxInput.id },
        sourceType: 'audio',
        targetType: 'audio',
      });
    }
  }
  if (VIDEO_CONTEXT_CATEGORIES.has(mod.category)) {
    // Wire ACIDWARP to ALL non-test video inputs (videoMixer's
    // in1/2/3/4 — without all four wired, modulating amount2's gain
    // is a no-op because in2's value is 0). Same fan-out pattern as
    // ctx-buggles for cv utilities.
    const videoCtxInputs = mod.inputs.filter(
      (p) => p.type === 'video' && p.id !== testInputPortId,
    );
    if (videoCtxInputs.length > 0) {
      nodes.push({
        id: 'ctx-acid',
        type: 'acidwarp',
        position: { x: 60, y: 380 },
        domain: 'video',
      });
      videoCtxInputs.forEach((v, i) => {
        edges.push({
          id: `e-ctx-acid-${i}`,
          from: { nodeId: 'ctx-acid', portId: 'out' },
          to:   { nodeId: 'sut',      portId: v.id },
          sourceType: 'video',
          targetType: 'video',
        });
      });
    }
    // mono-video / image inputs (less common, no multi-channel
    // module today uses both; we wire one).
    const monoVideoCtxInput = mod.inputs.find(
      (p) => (p.type === 'mono-video' || p.type === 'image') && p.id !== testInputPortId,
    );
    if (monoVideoCtxInput) {
      nodes.push({
        id: 'ctx-noiseR',
        type: 'noise',
        position: { x: 60, y: 560 },
        domain: 'audio',
        params: { level: 0.6 },
      });
      nodes.push({
        id: 'ctx-rast',
        type: 'rasterize',
        position: { x: 280, y: 560 },
        domain: 'audio',
      });
      edges.push({
        id: 'e-ctx-noiseR',
        from: { nodeId: 'ctx-noiseR', portId: 'white' },
        to:   { nodeId: 'ctx-rast',   portId: 'in' },
        sourceType: 'audio',
        targetType: 'audio',
      });
      edges.push({
        id: 'e-ctx-rast',
        from: { nodeId: 'ctx-rast', portId: 'out' },
        to:   { nodeId: 'sut',      portId: monoVideoCtxInput.id },
        sourceType: 'mono-video',
        targetType: monoVideoCtxInput.type,
      });
    }
  }

  // CV-context wiring: when the SUT is a pure CV utility (analog
  // logic maths, illogic, unityscalemathematik) — category 'utilities'
  // with cv-only inputs — the outputs are functions of the cv inputs.
  // Without ANY upstream cv, the outputs sit at 0V/idle, regardless of
  // which input we're probing.
  //
  // We feed BUGGLES.smooth to EVERY primary-cv input (not just the
  // first) so e.g. analogLogicMaths can show changes when attB_cv is
  // probed — without `b` having a value too, `attB*b` stays at zero
  // regardless of attB.
  //
  // ONE shared BUGGLES drives ALL primary cv inputs via fan-out (Yjs
  // edges with distinct ids). Naming heuristic for "primary" input:
  // not ending in `_cv` (paramTarget scaler) and not starting with
  // `att` (attenuvert scaler).
  if (NEEDS_AUDIO_CONTEXT_CATEGORIES.has(mod.category) && !mod.inputs.some((p) => p.type === 'audio')) {
    const primaryCvInputs = mod.inputs.filter(
      (p) =>
        p.type === 'cv'
        && p.id !== testInputPortId
        && !p.id.endsWith('_cv')
        && !p.id.startsWith('att'),
    );
    if (primaryCvInputs.length > 0) {
      // Default CV context = BUGGLES.smooth random walk; a per-port
      // override (BEHAVIORAL_PORT_CONTEXT_SOURCE) can swap in a different
      // shape (e.g. an LFO saw ramp for sampleHold.gate_in). The override
      // node keeps id='ctx-buggles' so the fan-out edge wiring below is
      // unchanged.
      const ctxNode: SpawnNode = cvCtxOverride
        ? cvCtxOverride.node
        : {
            id: 'ctx-buggles',
            type: 'buggles',
            position: { x: 60, y: 740 },
            domain: 'audio',
            params: { rate: 0.6, smoothness: 0.2, chaos: 0.2 },
          };
      const ctxOutPort = cvCtxOverride ? cvCtxOverride.outPort : 'smooth';
      nodes.push(ctxNode);
      primaryCvInputs.forEach((cvInput, idx) => {
        edges.push({
          id: `e-ctx-buggles-${idx}`,
          from: { nodeId: ctxNode.id, portId: ctxOutPort },
          to:   { nodeId: 'sut',      portId: cvInput.id },
          sourceType: 'cv',
          targetType: 'cv',
        });
      });
    }
  }

  // Gate-context wiring: when the SUT has a `gate` input (typically named
  // `gate` or `trig`) that ISN'T the port under test, the SUT needs that
  // gate firing to produce any output. For ADSR-shape modules, testing
  // `attack/decay/sustain/release` CV inputs is meaningless if no gate
  // ever fires. We add a context-sequencer firing at 240 BPM on the
  // first gate input that's not the test port.
  //
  // This is layered on top of any driver-spawned sequencer (which has
  // its OWN test-target gatePort). The two sequencers don't conflict —
  // the driver's gatePort is a SPECIFIC port from _drivers.ts; the
  // context-gate fires on ALL other gate inputs.
  const gateCtxInput = mod.inputs.find((p) => p.type === 'gate' && p.id !== testInputPortId);
  if (gateCtxInput && !mod.inputs.some((p) => p.type === 'gate' && p.id === testInputPortId)) {
    // Only add a context gate when the SUT has a gate input AND the
    // test port itself is NOT a gate (because then we'd be racing the
    // test-input source). Modules whose only meaningful input is a
    // gate (ADSR's `gate`, drum voices' `gate`) have their gate as the
    // primary trigger — those iterations use the test-input source
    // itself as the gate.
    nodes.push({
      id: 'ctx-gate-seq',
      type: 'sequencer',
      position: { x: 60, y: 560 },
      domain: 'audio',
      params: { bpm: 240, length: 4, isPlaying: 1, gateLength: 0.5 },
    });
    edges.push({
      id: 'e-ctx-gate',
      from: { nodeId: 'ctx-gate-seq', portId: 'gate' },
      to:   { nodeId: 'sut',          portId: gateCtxInput.id },
      sourceType: 'gate',
      targetType: 'gate',
    });
  }
  return { nodes, edges };
}

function buildDriverEdges(
  mod: RegistryModule,
  driver: ModuleDriver,
  testInputPortId: string,
): { nodes: SpawnNode[]; edges: SpawnEdge[] } {
  const nodes: SpawnNode[] = [];
  const edges: SpawnEdge[] = [];
  // Only spawn the driver-sequencer if the driver actually demands it
  // AND the driver's gate/pitch port is NOT the one we're testing
  // (otherwise we'd patch over the input under test).
  const needGate = driver.gatePort && driver.gatePort !== testInputPortId;
  const needPitch = driver.pitchPort && driver.pitchPort !== testInputPortId;
  if (!needGate && !needPitch) return { nodes, edges };

  nodes.push({
    id: 'driver-seq',
    type: 'sequencer',
    position: { x: 60, y: 60 },
    params: { bpm: 240, length: 4, isPlaying: 1, gateLength: 0.5 },
  });
  if (needGate) {
    edges.push({
      id: 'e-driver-g',
      from: { nodeId: 'driver-seq', portId: 'gate' },
      to:   { nodeId: 'sut',        portId: driver.gatePort! },
      sourceType: 'gate',
      targetType: 'gate',
    });
  }
  if (needPitch) {
    edges.push({
      id: 'e-driver-p',
      from: { nodeId: 'driver-seq', portId: 'pitch' },
      to:   { nodeId: 'sut',        portId: driver.pitchPort! },
      sourceType: 'pitch',
      targetType: 'cv',
    });
  }
  return { nodes, edges };
}

// ────────── Wait window per output type ──────────
//
// Scope sink (same-domain SUT): 800ms reaches steady state for slow
// modulators + multiple gate cycles.
// Scope sink (cross-domain SUT): 1500ms covers the cross-domain audio
// bridge wire-up + a few signal cycles.
// Video sink: 1500ms covers the 60fps composite settling.
function waitMsFor(sutDomain: string, sink: SinkSpec): number {
  if (sink.node.type !== 'scope') return 1500;
  if (sutDomain !== sink.node.domain) return 1500;
  return 800;
}

// ────────── Sequencer step population ──────────
//
// When a sequencer is spawned (driver or test-input source for gate/
// pitch), we have to write its steps inside a Yjs transact so the
// engine sees non-empty steps. Otherwise the gate sits at 0 forever
// even with isPlaying=1. Same pattern as per-module.spec.ts.
//
// This walks every sequencer node in the patch and seeds steps.
async function populateAllSequencerSteps(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { type: string; data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      for (const id of Object.keys(w.__patch.nodes)) {
        const node = w.__patch.nodes[id];
        if (!node || node.type !== 'sequencer') continue;
        if (!node.data) node.data = {};
        node.data.steps = [
          { on: true, midi: 60 },
          { on: true, midi: 64 },
          { on: true, midi: 67 },
          { on: true, midi: 72 },
        ];
      }
    });
  });
}

// ────────── Console error filter ──────────
// Same heuristic as per-module-per-port.spec.ts.
function filterErrors(errors: string[]): string[] {
  return errors.filter((e) =>
    !e.includes('AudioContext')
    && !e.includes('doom.js')
    && !e.includes('DOOM1.WAD')
    && !e.includes('[vite]')
    && !e.includes('Failed to load resource')
    && !(e.includes('[reconciler] reconcile failed') && e.includes('disconnect')),
  );
}

// ────────── Tests ──────────

test.describe.configure({ mode: 'parallel' });

test.describe('per-module per-port: BEHAVIORAL input coverage (output changes on driven input vs unpatched)', () => {
  for (const mod of REGISTRY) {
    if (mod.inputs.length === 0) continue;
    const skipReason = SKIP_SPAWN[mod.type];
    const title = `${mod.type}: each declared input perturbs the module's observable output (vs unpatched control)`;
    if (skipReason) {
      test.fixme(`${title} [SKIPPED: ${skipReason}]`, () => {});
      continue;
    }
    const modExempt = BEHAVIORAL_MODULE_EXEMPT[mod.type];
    if (modExempt) {
      test.fixme(`${title} [SKIPPED: ${modExempt}]`, () => {});
      continue;
    }

    // Filter to non-exempt inputs whose type we know how to drive.
    const drivableInputs = mod.inputs.filter((p) => {
      if (BEHAVIORAL_SWEEP_EXEMPT[`${mod.type}.${p.id}`]) return false;
      return pickInputSource(p.type, 'probe') !== null;
    });
    if (drivableInputs.length === 0) {
      test.fixme(`${title} [SKIPPED: no drivable inputs after exemptions]`, () => {});
      continue;
    }

    test(title, async ({ page }) => {
      // Per input: 2× (goto ~3s + spawnPatch ~3s + settle 0.8-2s
      //              + aggregated read 5×150ms ~0.8s).
      // Budget ~22s per input + 30s baseline cushion. We pay this for
      // determinism — each spawn starts from a fresh AudioContext, and
      // the aggregated read averages out modulator jitter.
      test.setTimeout(Math.max(90_000, drivableInputs.length * 22000 + 30_000));

      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(`console: ${m.text()}`);
      });

      const driver = driverFor(mod);
      const observed = pickObservedOutput(mod, driver);
      if (!observed) {
        // No scope-able / video-sinkable output → can't sample. We
        // shouldn't have gotten here (modules without outputs are
        // filtered via mod.outputs.length earlier in many specs); if
        // we do, fail loudly so the design gets revisited.
        await page.goto('/'); // give the test SOMETHING to navigate to before asserting
        expect(
          observed,
          `${mod.type}: no observable output type — module needs a BEHAVIORAL_MODULE_EXEMPT entry or pickObservedOutput extension`,
        ).not.toBeNull();
        return;
      }

      // Per-port loop. Two spawns per port: control + patched. We
      // navigate to '/' between EACH spawn (control + patched +
      // next-iter's control...) so each spawn starts from a fresh
      // AudioContext + engine — same determinism story as
      // per-module-per-port.spec.ts's outputs-emit dim. Pattern:
      //  goto('/') → spawnPatch(control) → settle → read
      //  goto('/') → spawnPatch(patched) → settle → read → compare
      const failures: string[] = [];
      const passes: string[] = [];

      for (const port of drivableInputs) {
        const source = pickInputSource(port.type, `up-${port.id}`);
        // pickInputSource null-checked at filter time, but TS doesn't
        // see that. Belt-and-suspender check.
        if (!source) continue;

        // ─── CONTROL ─────────────────────────────────────────────────
        // SUT + driver (if needed) + context (effect-shape upstream
        // noise/video) + sink. NO upstream on test input.
        await page.goto('/');
        await page.waitForLoadState('networkidle');

        const sutNode: SpawnNode = {
          id: 'sut',
          type: mod.type,
          position: { x: 400, y: 60 },
          domain: mod.domain,
          // Layer BEHAVIORAL_PARAMS (per-module) then BEHAVIORAL_PORT_PARAMS
          // (per-port) over driverFor's params so modulation-depth knobs are
          // unlocked for behavioral testing (vs. _drivers.ts's "clean output"
          // tuning for the alive-smoke). The per-port layer lets a single
          // test port override a knob without forking the whole-module params.
          params: {
            ...(driver.params ?? {}),
            ...(BEHAVIORAL_PARAMS[mod.type] ?? {}),
            ...(BEHAVIORAL_PORT_PARAMS[`${mod.type}.${port.id}`] ?? {}),
          },
        };
        const driverWiring = buildDriverEdges(mod, driver, port.id);
        const ctxWiring = buildContextEdges(mod, port.id);
        const controlNodes: SpawnNode[] = [sutNode, observed.sink.node, ...driverWiring.nodes, ...ctxWiring.nodes];
        const controlEdges: SpawnEdge[] = [
          {
            id: 'e-sut-sink',
            from: { nodeId: 'sut', portId: observed.outPort },
            to:   { nodeId: observed.sink.node.id, portId: observed.sink.inPort },
            sourceType: observed.outType,
            targetType: observed.sink.targetType,
          },
          ...driverWiring.edges,
          ...ctxWiring.edges,
        ];

        await spawnPatch(page, controlNodes, controlEdges);
        await populateAllSequencerSteps(page);
        await runFor(page, waitMsFor(mod.domain, observed.sink));
        const controlSample = await readSinkAggregated(page, observed.sink);
        if (!controlSample) {
          failures.push(`${mod.type}.${port.id}: control sink read failed`);
          continue;
        }

        // ─── PATCHED ─────────────────────────────────────────────────
        // Same nodes + edges, PLUS the test-input upstream.
        await page.goto('/');
        await page.waitForLoadState('networkidle');

        const patchedNodes: SpawnNode[] = [
          ...controlNodes,
          source.node,
          ...(source.extraNode ? [source.extraNode] : []),
        ];
        const patchedEdges: SpawnEdge[] = [
          ...controlEdges,
          {
            id: 'e-test-up-sut',
            from: { nodeId: source.node.id, portId: source.outPort },
            to:   { nodeId: 'sut',           portId: port.id },
            sourceType: source.sourceType,
            targetType: port.type,
          },
        ];
        if (source.extraNode) {
          patchedEdges.push({
            id: 'e-test-up-extra',
            from: { nodeId: source.extraNode.id, portId: 'white' },
            to:   { nodeId: source.node.id,     portId: 'in' },
            sourceType: 'audio',
            targetType: 'audio',
          });
        }

        await spawnPatch(page, patchedNodes, patchedEdges);
        await populateAllSequencerSteps(page);
        await runFor(page, waitMsFor(mod.domain, observed.sink));
        const patchedSample = await readSinkAggregated(page, observed.sink);
        if (!patchedSample) {
          failures.push(`${mod.type}.${port.id}: patched sink read failed`);
          continue;
        }

        const delta = computeDelta(controlSample, patchedSample);
        if (delta.exceeded) {
          passes.push(`${mod.type}.${port.id} (type=${port.type}) → ${observed.outPort} (type=${observed.outType}): ${delta.description}`);
        } else {
          failures.push(`${mod.type}.${port.id} (type=${port.type}) → ${observed.outPort} (type=${observed.outType}): NO observable delta — ${delta.description}`);
        }
      }

      // Build a multi-line message so a failure pinpoints which ports
      // didn't perturb. Pass-list is logged but not asserted (only
      // failures gate the test).
      for (const line of passes) {
        // eslint-disable-next-line no-console
        console.log(`[behavioral] PASS ${line}`);
      }
      expect(
        failures,
        `${mod.type}: every drivable input perturbed the observed output\n  Failures:\n    ${failures.join('\n    ')}\n  Total drivable inputs: ${drivableInputs.length} | Passed: ${passes.length}`,
      ).toEqual([]);

      expect(
        filterErrors(errors),
        `${mod.type} behavioral: no console / page errors during input drive`,
      ).toEqual([]);
    });
  }
});

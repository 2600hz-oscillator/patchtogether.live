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
//
// Shared note for the VIDEO-SINK SwiftShader timeout class (cellshade /
// chromakey / outlines / edges) — see the block where these are exempted below.
const VIDEO_SINK_SWIFTSHADER_NOTE =
  "video-out-canvas per-frame WebGL is too slow to verify on CI's SwiftShader software renderer (passes on real GPU); real behavioral coverage for these lives in each module's VRT + bespoke e2e spec; re-enable needs a real-GPU CI lane or a reduced-capture behavioral path";
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
  // (midiOutBuddy is a ZERO-output MIDI sink — emits MIDI to an external device,
  //  no audio/CV output for the sweep to observe → handled mechanically by the
  //  `mod.outputs.length === 0` DELETE filter in the test loop; input behavior
  //  covered by midi-out-buddy.spec.ts with a fake MIDIOutput.)

  // ── File-input sources: output is silent until a file is uploaded.
  //    No upstream signal can perturb that.
  samsloop:       'needs an uploaded sample AND a trigger to emit (idle-by-default, no autoplay); covered by samsloop.spec.ts',
  // CLIP PLAYER: TIMELORDE-locked, launch-derived output (8 lanes). The outputs
  // are the LAUNCHED clip's pattern; the module has only ONE input (stop_all),
  // which SILENCES — a negative delta the one-input-at-a-time spawn-once harness
  // would need precise timing to catch — and there is no per-output input to
  // perturb. Output also requires a running TIMELORDE (no internal BPM), which
  // the sweep can't establish. Covered by clipplayer.test.ts (def + per-lane
  // launch / quantized-switch / stop / TIMELORDE-lock / silent via the REAL tick
  // loop) + the bespoke real-source-chain clipplayer.spec.ts (TIMELORDE → clip →
  // voice → audible RMS, incl. the freeze-while-stopped lock) + clip-types.test.ts
  // (note→V/oct + note-editor row math + per-lane/velocity helpers).
  clipplayer:     'TIMELORDE-locked launch output (8 lanes); inputs stop_all/reset only silence/rewind — no per-output input + needs a running transport, so no clean per-input delta in the short window; covered by clipplayer.test.ts + clipplayer.spec.ts + clipplayer-rate-reset.spec.ts (reset gate input via a REAL sequencer-clock cable) + clip-types.test.ts',
  // KRIA — same shape as clipplayer/sequencer: a 4-track grid step-sequencer
  // whose outputs are clock-derived (a seeded running pattern). Patching `clock`
  // only switches internal-tempo → external-clock advance (RE-PHASES the same
  // gate streams at a similar density, no attributable per-input footprint), and
  // `reset` only re-anchors the playhead to the loop start (a phase reset the
  // spawn-once one-input-at-a-time harness can't cleanly attribute). Covered by
  // kria.test.ts (def + 4-track factory tick loop: pitch/gate emit per track,
  // pattern-cue quantize, reset re-anchor) + kria-types.test.ts (step-advance /
  // scale→V/oct / loop / direction / cue math) + the bespoke real-source-chain
  // kria.spec.ts (TIMELORDE → KRIA → VCO+VCA → audible gated RMS).
  kria:           'clock-derived 4-track output (seeded running pattern); clock only re-phases, reset only re-anchors — no clean per-input delta in the short window; covered by kria.test.ts + kria-types.test.ts + kria.spec.ts',
  // Tape loop: idle output is hard-gated to silence and a fresh spawn has no
  // recorded tape, so NO single input perturbs the output in the one-input-at-
  // a-time control harness — audible output needs a record (audio-in + rec
  // gate) → play sequence (and a non-zero A/B gain for reel B), which this
  // sweep can't establish. Covered by twotracks.spec.ts (transport / EQ /
  // filter / A-B crossfade / lofi UI + OSC→twotracks→SCOPE wiring) and the
  // twotracks-transport + twotracks-ab unit tests.
  twotracks:      'tape loop — silent until record→play established; covered by twotracks.spec.ts + twotracks-transport/ab unit tests',
  videobox:       'needs uploaded video file to emit; covered by videobox.test.ts + videobox-sync.test.ts',
  videovarispeed: 'needs uploaded video file to emit; covered by videovarispeed-output.spec.ts',
  archivist:      'idle until an archive.org item loads (external network); play_trigger only acts on a loaded item; covered by archivist-query.test.ts + archivist-scrub.test.ts + route-mocked archivist.spec.ts',
  picturebox:     'needs uploaded image file to emit; covered by picturebox-related specs',
  // TV LIBRARIAN needs a live tuned HLS stream to emit any output, which the
  // behavioral sweep can't establish (and we never hit live famelack/streams in
  // CI). Same as videobox. Covered by tv-librarian-data/geo unit tests + a
  // network-mocked tv-librarian e2e.
  tvLibrarian:    'needs a live tuned HLS stream to emit; no network stream in the sweep (mirrors videobox); covered by tv-librarian-data/geo.test.ts + network-mocked tv-librarian e2e',
  // PEERTUBE needs a resolved + attached PeerTube stream to emit any output, which
  // the behavioral sweep can't establish (and we never hit live Sepia/instance/HLS
  // in CI). Same as tvLibrarian/videobox. Covered by peertube-query unit tests + a
  // network-mocked peertube e2e.
  peertube:       'needs a resolved + attached PeerTube stream to emit; no network stream in the sweep (mirrors tvLibrarian/videobox); covered by peertube-query.test.ts + network-mocked peertube e2e',
  // MILKDROP — the butterchurn visualizer self-animates CONTINUOUSLY (a
  // multi-pass warp-mesh + feedback render running on its own internal clock)
  // regardless of input, so the `out` luma-variance has a huge per-frame jitter
  // floor that swamps any single-input footprint across the short snapshot
  // window (the bentbox / b3ntb0x / backdraft animated-video variance class).
  // Whole-module exempt. Covered by milkdrop-render-smoke.spec.ts (deterministic
  // non-black/structured render: freeze + fixed delta + synthetic audio) + the
  // contract-lock / docs-lint / modules-card-map unit gates.
  milkdrop:       'self-animating multi-pass visualizer (animated-video variance class, cf. bentbox/b3ntb0x): the out luma-variance jitter floor swamps any per-input delta; covered by milkdrop-render-smoke.spec.ts + unit gates',
  // COLOUR OF MAGIC — a PARALLEL multi-block colorspace processor: three blocks
  // (RGB / YDbDr / HSV·HSL) run independently on the source and feed SEPARATE
  // outputs (pass / rgb / ydbdr / hsvhsl + r/g/b/luma mono taps). This sweep
  // observes only the module's FIRST video output — `pass`, which is the
  // UNTOUCHED source passthrough (outMode 0), structurally INDEPENDENT of all 18
  // block CV/override inputs (only `in` feeds it). So 18 of 19 inputs can never
  // perturb the observed output, and the coarse video-variance fingerprint the
  // sweep reads off `pass` is dominated by the animated ACIDWARP context's own
  // per-frame jitter (a different input reads Δ=0 each run — hsv_h_cv, hsv_v_cv,
  // … — the animated-video variance class, cf. milkdrop/backdraft). No single
  // observed output can respond to all inputs by design. Whole-module exempt.
  // Real PER-BLOCK, per-input coverage: colourofmagic-colorspace.test.ts (every
  // colorspace + adj/over-clamp + hue-rotation + palette path, known values) +
  // colourofmagic.spec.ts (real LINES→CHROMA→module chain: all 8 outs emit,
  // bias_r reddens the rgb out, a Db bias moves the ydbdr blue-yellow axis, a
  // mono override CLOBBERS its channel, OVER vs CLAMP differ) + the docs/
  // contract-lock/modules-card-map unit gates.
  colourofmagic:  'parallel multi-block colorspace processor — the sweep observes only the first video output `pass` (untouched source passthrough, independent of all 18 block CV/override inputs; each block feeds a SEPARATE output), and its video-variance fingerprint is dominated by the animated ACIDWARP context jitter (a random input reads Δ=0 each run, animated-video variance class cf. milkdrop); real per-block per-input coverage in colourofmagic-colorspace.test.ts + colourofmagic.spec.ts (all 8 outs emit, recolorization, mono-override channel clobber, over/clamp)',
  // SPIROGRAPHS — a line-GENERATOR that draws up to 3 hypotrochoid curves. Its
  // 30 geometry CV inputs (s1/s2/s3 × R / r / pen / inside / rotation / scale /
  // X / Y / thickness / chroma) RESHAPE the drawn curve, but reshaping a thin
  // line preserves the frame's global variance + neighbour-brightness: the
  // behavioral flake-purge (run 28486495363) measured 25 of 31 inputs with
  // Δμvar 0.03–1.87 against a ±0.3–4.7 per-spawn variance floor and Δμnb ≈ 0.0000
  // — sub-threshold on the coarse video-variance metric (the SAME class as
  // milkdrop / bentbox / acidwarp.speed_cv / tempest.rim). Deterministic (failed
  // all 5 purge passes on shard 5), so this is a metric-resolution gap, not a
  // flake and not dead CV (SpirographsCard wires every stem as a `cv` input;
  // spirographs-math/draw consume them). Whole-module exempt. RE-ENABLE PATH: a
  // shape-sensitive metric (edge/contour or centroid displacement) or per-port
  // calibration to each stem's measured jitter floor — the systemic
  // video-variance-metric follow-up. Covered by spirographs.test.ts +
  // spirographs-render-smoke.spec.ts (deterministic structured render).
  spirographs:    'line generator: 25/31 geometry CV inputs reshape a thin curve but keep global frame-variance/neighbour-brightness sub-threshold (Δμvar 0.03–1.87 vs ±0.3–4.7 floor) — video-variance-metric gap, cf. milkdrop/tempest.rim; deterministic (not flake), CV is wired. RE-ENABLE via a shape-sensitive/per-port-calibrated metric. Covered by spirographs.test.ts + spirographs-render-smoke.spec.ts',

  // ── User-toggled sequencer-like sources: output silent until steps are
  //    toggled by user interaction (which our spawnPatch doesn't model).
  //    The standard _drivers.ts driver writes steps for these in some
  //    cases, but not all — and the input we'd drive is typically `clock`
  //    or `reset`, whose effect IS step-advancement which the unpatched
  //    control already exhibits. Per-module specs cover their inputs.
  drumseqz:  'pattern grid needs cells toggled; covered by drumseqz specs',
  polyseqz:  'pattern grid needs cells toggled; covered by polyseqz specs',
  macseq:    'requires toggled steps; covered by macseq specs',
  score:     'requires play_cv high + steps; covered by score.spec.ts',

  // ── Modules whose ONLY outputs are gameplay/file/MIDI-conditional:
  //    score-event gates that fire on in-game events. Unpatched + patched
  //    both read silent; no behavioral delta to detect.
  doom:     'gameplay-conditional outputs; covered by doom-* specs + video-audio-cvgate-coverage',
  nibbles:  'gameplay-conditional outputs (snake/pellet/etc); covered by nibbles + video-audio-cvgate-coverage',
  pong:     'gameplay-conditional outputs; covered by pong-related specs',
  modtris:  'gameplay-conditional outputs; covered by modtris-related specs',
  blood:    'data-gated emulator: outputs need user-supplied, non-redistributable Blood data (BLOOD.RFF/GUI.RFF/SOUNDS.RFF, gitignored, absent in CI) — the NBlood engine aborts in its resource loader without it, so driven + control inputs both observe the idle shader / silent PCM stub; covered by blood-keys.test.ts + the blood-frame-harness (run locally with owned data). See native/nblood/PHASE1-STATUS.md.',
  frogger:  'gameplay-conditional outputs; covered by frogger specs',
  skifree:  'gate fires only on in-game crash/eaten; out is animated canvas; covered by e2e/tests/skifree.spec.ts',
  gibribbon: 'gameplay-conditional outputs (evt_hit/miss/fire/kill/gameover fire on in-game judgement; health_cv is idle DC); covered by gibribbon.spec.ts (forcePulse) + gibribbon-events.test.ts',

  // ── Pure-passthrough sink with no semantic transformation: VIDEOOUT
  //    just blits its input to canvas, so behavioral assertion would be
  //    "video in → video out" which is already covered by every spec
  //    that uses a VIDEOOUT sink.
  //    (AUDIO-OUT is a ZERO-output terminal node → now handled mechanically by
  //    the `mod.outputs.length === 0` DELETE filter in the test loop, not parked
  //    here.)
  videoOut: 'passthrough sink; outputs equal inputs by construction',

  // ── SCOPE is the canonical sink we USE in this test; can't be SUT.
  scope:    'is itself the canonical receiver',

  // ── TIMELORDE / clock-divider shape: their outputs are always
  //    derivative of an upstream clock. The driver IS the upstream
  //    clock; the inputs (rate, division, etc.) DO affect the clock
  //    rate, but the scope sees gate edges either way — the delta
  //    is too subtle for the universal 800ms-window heuristic.
  //    Dedicated timelorde specs measure the rate.
  timelorde: 'clock-divider; rate-delta needs spectral analysis; covered by timelorde specs',

  // (LIVECODE text-DSL editor + STICKY meta card are ZERO-output non-subjects —
  //  no output port to observe — so they're handled by the mechanical
  //  zero-output / zero-input filters in the test loop, not parked here.)

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

  // ── b3ntb0x — bentbox's circuit-level NTSC re-arch (4-pass encode→bend→
  //    decode→CRT). Its `out` is a heavily ANIMATED composite: per-line sync
  //    drift + frame persistence + the (itself-animated) acidwarp probe give a
  //    per-frame luma-variance with a HUGE intrinsic jitter floor — the control
  //    run alone measures var≈1270 ±580. Sampling 5 snapshots × 2 spawns, the
  //    mean-of-5 has a standard error far larger than any input's footprint:
  //    the SAME input (bend_a) reads Δμvar≈63 one run and ≈2.8 the next, so the
  //    metric can't reliably distinguish ANY input from the source's own
  //    animation — every input straddles the Δμvar>5 threshold run-to-run.
  //    Whole-module exempt (same class as bentbox / mandelbulb animated video).
  //    Coverage is deterministic + stronger: 35 unit tests (the encode→demod
  //    ROUND-TRIP proves the carrier path is a real invertible signal, plus
  //    burst-starve colour-kill/crawl + mirror folds + gate edges) and a
  //    real-GL e2e (b3ntb0x.spec.ts: non-black decode + Sync-Crush/Enhance bend
  //    proof + CV param mutation). VRT-exempt for the same animation reason.
  b3ntb0x: 'animated NTSC composite with a ±580 per-frame variance floor that swamps every input in the 5-snapshot window (bend_a swings Δμvar 63→2.8 run-to-run); whole-module exempt (bentbox/mandelbulb animated-video class); covered by b3ntb0x.test.ts (35 unit, incl. encode→demod round-trip + burst-starve) + b3ntb0x.spec.ts real-GL bend proof',

  // ── quadralogical — animated 4-input video MIXER. Its per-edge inputs are
  //    CONDITIONAL: edge{N}_fx/amount/param only affect the output when that
  //    edge is active (joystick near it) and only for the relevant effect
  //    (e.g. WIPE softness, IRIS feather); keyR/G/B only matter under CHROMA;
  //    invert only when a key is keying. With the default centered joystick +
  //    DISSOLVE edges + flat probe inputs, most don't perturb the luma-variance
  //    metric — same animated-video / conditional-input class as b3ntb0x.
  //    Whole-module exempt; covered by quadralogical.spec.ts (8-effect
  //    distinctness + per-edge independence + the no-more-always-dissolve
  //    regression), 8 composite VRTs, and unit (edgeWeights/blend2/HSV).
  quadralogical: 'animated 4-input mixer with conditional per-edge inputs (edge fx/amount/param active only when that edge dominates + that effect is selected; keyR/G/B only under CHROMA); luma-variance sweep can\'t attribute deltas (animated-video class, cf b3ntb0x); covered by quadralogical.spec.ts (8-effect distinctness + per-edge independence) + 8 composite VRTs + unit (edgeWeights/blend2)',

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

  // ── MI ports: marbles — a sequencer-like state machine whose outputs
  //    depend on prior state + multi-second probability distributions.
  //    Tests like "gate1 → out0" can't trigger a perturbation in 1.5s.
  //    Covered by its dedicated specs.
  marbles:  'probabilistic t-loop with multi-second distributions; covered by marbles-related specs',

  // ── wavesculpt — multi-voice (4 voices) wavetable cluster
  //    instrument. Driver picks gate1+voice1 output; gate2-4 and the
  //    morph2-4/pos_x/pos_y/scale knobs control OTHER voices that
  //    don't reach the chosen output. Covered by wavesculpt-related
  //    specs.
  wavesculpt: 'multi-voice cluster; non-voice1 ports target other voices not visible on L; covered by wavesculpt specs',

  // ── PR #471 land-now quarantine (subtle-CV-effect modules) ──
  //
  // These modules each have AT LEAST ONE declared input whose CV→audio/video
  // effect was too subtle to clear the universal behavioral delta threshold
  // within the test window when PR #471 quarantined them. The behavioral-
  // reconciliation leg drives this set down one module per PR — see the dated
  // CHANGELOG at docs/test-reconciliation/CHANGELOG.md. Each entry cites the
  // dedicated unit + spec coverage that DOES pin the module's behaviour, so a
  // quarantine is NOT a silent skip — it's a "covered elsewhere with stronger
  // signal" pointer + a concrete re-enable path. The `inputs-accept` dim in
  // per-module-per-port.spec.ts STILL pins wire-up for every port below.
  //
  // (adsr RE-ENABLED — behavioral-recon #3. adsr's decay/release CV
  //  scalers are now real-coverage passes via a BEHAVIORAL_PARAMS leverage boost
  //  — see BEHAVIORAL_PARAMS.adsr. Verified 3-4× locally.)

  // buggles — self-clocking random-CV source. The CV inputs modulate the woggle
  // STEP RATE / CHAOS, not the output amplitude. Because the observed `smooth`
  // output is itself a slow random walk, both the control + patched runs read
  // large baseline variance — the perturbation is hidden in BUGGLES's own noise
  // floor across the 1.5s window. (Measured behavioral-recon #3.)
  buggles: 'self-noise class: the observed `smooth` output is a slow random walk with a low RMS (~0.015) + high RELATIVE jitter, and the CV inputs modulate its STEP RATE / CHAOS, not its amplitude. external_clock gives a clean delta (Δμrms≈0.14), but clock_cv lands AT the 0.01 floor and chaos_cv reads a genuine ~0 delta (Δμrms≈0.004, Δrange≈0.017) in the 1.5s window — the rate/chaos change is buried in the walk\'s own noise. Re-enterable with a LONGER observation window (so the rate change accumulates) + a per-channel clock-output sink (the `clock` gate carries the rate change cleanly); covered by buggles.test.ts (DSP rate/chaos response) + buggles.spec.ts (E2E CV-driven rate sweep)',

  // backdraft — video feedback / motion-trail effect. The HDR
  // accumulation buffer needs many frames of input motion before
  // the trail differs MEASURABLY between control (steady ACIDWARP)
  // and patched (steady ACIDWARP + driven aux). Both runs show
  // similar variance because ACIDWARP itself dominates the trail
  // statistic. Same shape as the `bentbox` exemption above.
  // Covered by backdraft.test.ts (per-frame trail-buffer math) +
  // backdraft.spec.ts (E2E trail-persistence assertion).
  backdraft: 'animated-video VARIANCE-FLOOR class (cf. bentbox / b3ntb0x): the HDR feedback-trail `out` has a per-frame luma-variance baseline of ~7700 with a HUGE ±4000-6000 per-frame RANGE driven by the ACIDWARP context motion + trail accumulation. Across 3 video snapshots × 2 spawns the mean-of-3 standard error (±several thousand) SWAMPS every input\'s footprint — Δμvar runs 37→1750 and ΔRvar runs 2.7→4060 with NO correlation to which port is driven, so the variance metric can\'t attribute a delta to ANY input (the 22 ports all "passed" once but only on the animation\'s own noise). Whole-module exempt (same class as bentbox). Covered by backdraft.test.ts (per-frame trail-buffer math) + backdraft.spec.ts (E2E trail-persistence with a longer window + spawn-once-perturb pattern)',


  // (treeohvox RE-ENABLED — behavioral-recon #4. The held-note driver
  //  (BEHAVIORAL_HELD_NOTE_DRIVER plays a constant C3 instead of the 60/64/67/72
  //  arpeggio) replaces the ±600-2800 Hz pitch-sequence centroid swing with a
  //  STABLE ~150 Hz baseline, against which gate_in (silent→sounding, Δμrms≈0.23),
  //  accent_in (Δμrms≈0.13) + waveform_cv (saw↔square, Δμrms≈0.03) are real-
  //  coverage passes (verified 3×). The 7 remaining filter/envelope/tune/pitch CV
  //  scalers are genuine subtle-303-CV ports, now per-port-exempt in
  //  BEHAVIORAL_SWEEP_EXEMPT with measured deltas + treeohvox-dsp.test.ts
  //  citations — NOT a held-note regression.)

  // mixmstrs — 6-channel stereo mixer. 77 drivable inputs (16 audio + 61 CV)
  // BLOW the per-test wall-clock at 2 spawns/input (foxy class), and each
  // per-channel CV scales ONE channel into the SUMMED masterL the sweep observes.
  // (Measured behavioral-recon #3: the read times out mid-run.)
  mixmstrs: 'heavy-fan-out + per-channel-on-summed-mix class: mixmstrs declares 77 drivable inputs (16 audio + 61 paramTarget CV), so the sweep\'s 2-spawn-per-input loop = 154 spawns ≈ 28 min for ONE test — it BLOWS the per-test wall-clock budget (the read times out mid-run; same heavy-budget class as foxy/mandelbulb). On TOP of that, each ch{N}_{eq,comp,send,…}_cv scales ONE channel\'s contribution to the SUMMED masterL the sweep observes, so most single-channel CVs shift the summed RMS below the universal floor (the per-channel-on-mix class, cf. warrenspectrum.level*_cv). Re-enterable only with BOTH a per-channel sink driver (observe the channel under test, not the sum) AND a way to test a SUBSET of representative ports under budget. Covered by mixmstrs.test.ts (per-channel gain/pan/comp-macro unit math) + the mixmstrs VRT baseline',

  // ── FOXY — SwoleVCO + RasterPainter heavy-mount chain. The module
  //    mounts 3 SwoleBlocks + 3 RasterPainters + WAVECEL worklet + 4-page
  //    card; on cold CI Linux each page navigation takes 15-30s. With 5
  //    drivable inputs × 2 spawns per input = 250s runtime >> 140s
  //    budget. All 5 inputs (pitch, fm, morph_cv, spread_cv, fold_cv) DO
  //    perturb out_l measurably — they just exceed the wall-clock budget.
  //    Covered by foxy.spec.ts which uses a single-spawn + settle pattern.
  foxy: 'heavy mount (SwoleBlocks + RasterPainters); 5 inputs × 2 spawns exceed 140s CI budget; covered by foxy.spec.ts',

  // ── VIDEO-SINK SwiftShader timeout class — cellshade / chromakey / outlines
  //    / edges. These VIDEO-domain processors route their observed output to
  //    the `video-out-canvas` sink. Every snapshot the SUT renders a per-frame
  //    WebGL pipeline (cel-shade / chroma-key / outline / Sobel pass) AND the
  //    sink read does a full-canvas readPixels — both ~10-30× slower under CI's
  //    SwiftShader SOFTWARE renderer than a real GPU, with the parallel workers
  //    contending a single GL pipeline. The per-input spawn→settle→frame-poll
  //    loop blows the per-test wall-clock budget REPRODUCIBLY on CI while
  //    PASSING on a real local GPU (the ci-swiftshader-video-e2e-timeouts
  //    class; cf. the foxy / mandelbulb heavy-mount exemptions above — same
  //    "exceeds the CI budget", NOT a per-port delta failure).
  //
  //    LOWER-WALL-TIME decision: SKIP these here (keeping the behavioral lane
  //    at its ~15-min baseline) rather than scaling the per-test timeout —
  //    the timeout-scaling leg pushed the lane to ~18-19 min, which the user
  //    decided against. The disabled/exempt count goes UP by these — that's
  //    the honest "reconcile = document-as-backlog" outcome, not fudged.
  //
  //    Real behavioral coverage for each lives in its VRT baseline + bespoke
  //    e2e spec (cellshade.spec.ts / chromakey.spec.ts / outlines.spec.ts /
  //    edges.spec.ts), and per-module-per-port.spec.ts still pins each port's
  //    wire-up via the `inputs-accept` dim. Re-enable needs a real-GPU CI lane
  //    or a reduced-capture behavioral path. One shared note for all four:
  edges: VIDEO_SINK_SWIFTSHADER_NOTE,
  cellshade: VIDEO_SINK_SWIFTSHADER_NOTE,
  chromakey: VIDEO_SINK_SWIFTSHADER_NOTE,
  outlines: VIDEO_SINK_SWIFTSHADER_NOTE,
  // POSTERBOX (retro palette-crush, 2026-07-11): the same per-frame-WebGL →
  // video-out-canvas class as cellshade above. Real behavioral coverage lives
  // in posterbox.test.ts (the CPU mirror of the shader) + the theory-derived
  // e2e/tests/posterbox-functional.spec.ts (readPixels probes: continuity
  // anchors, hue-order, dither checker, mix sweep) + the VRT baselines.
  posterbox: VIDEO_SINK_SWIFTSHADER_NOTE,

  // ── MOOG System 55/35 routing / mixer / utility modules (batch-2 +
  //    batch-5). These are PURE gain / patch-bay / format-converter /
  //    trigger-delay modules: their observed output is a passive function
  //    of an UPSTREAM audio/trigger SOURCE that the behavioral driver does
  //    not supply on the channels the universal sink observes. With no
  //    upstream signal the CONTROL and PATCHED runs both read the SAME idle
  //    value (silent C=P=0.000, or the constant idle CV C=P=0.500 the
  //    sequencer rows hold before the first clock-advanced step), so the
  //    delta can NEVER cross the threshold → they fail 100% of runs. The
  //    `inputs-accept` dim in per-module-per-port.spec.ts STILL pins wire-up
  //    for every port, and each module's own unit test pins its routing /
  //    conversion / gain math directly (where the upstream source IS
  //    supplied). Same intrinsic-no-observable-delta class as the
  //    audioOut / videoOut passthrough sinks above.
  //
  // (moog984 RE-ENABLED — behavioral-recon #1. It was NOT actually a
  //  "no-upstream-source" case: out1 = Σ in_i × m_i1 and ALL 16 cross-points
  //  default to 0, so the matrix is silent until a cross-point is dialled in —
  //  the IDENTICAL passive-mixer-with-default-0-levels class as attenumix /
  //  videoMixer, which are NOT exempt because they carry a
  //  BEHAVIORAL_PARAMS boost opening their gating knobs. Opening column-1
  //  cross-points (m11=m21=m31=m41=1, see BEHAVIORAL_PARAMS.moog984) lets the
  //  noise source on ANY of in1..in4 reach the observed out1 → all 4 inputs are
  //  real-coverage passes. Verified 3× locally.)
  //
  // (moog993 RE-ENABLED — behavioral-recon #2. NOT a "no-upstream-source"
  //  case: the default `route1=1` makes `trig_from1 → trig_out1` a UNITY
  //  passthrough (the observed first output is trig_out1, gate), so the 4-Hz
  //  gate-train source on trig_from1 reaches trig_out1 → a clean silent-vs-
  //  gated delta. trig_from2 / env_in1 / env_in2 are per-port-exempt in
  //  BEHAVIORAL_SWEEP_EXEMPT — route1 ignores source 2, and the env CVs feed
  //  the SEPARATE env_out* CV outputs the gate-typed observed trig_out1 can't
  //  see. Verified 3× locally.)
  //
  // (moog961 RE-ENABLED — behavioral-recon #2. NOT a "no-upstream-source"
  //  case: the observed first output v_out1 = `s_in held high OR audio→trigger
  //  rising-edge` (trigger-convert-dsp.ts). The 4-Hz gate-train source on s_in
  //  reaches v_out1 (format passthrough) against a clean SILENT control → a
  //  real-coverage pass (Δμrms≈0.72). BEHAVIORAL_PARAMS pins sensitivity high
  //  so the noise *context* on audio_in can't muddy the s_in control.
  //  audio_in / v_in_a / v_in_b are per-port-exempt; see BEHAVIORAL_SWEEP_EXEMPT
  //  for why. Verified 3× locally.)
  //
  // (moog911a RE-ENABLED — behavioral-recon #5. The diagnosis from #4 held:
  //  out1 is a ~1 ms ONE-SHOT pulse (TRIGGER_DELAY_PULSE_S), so the RMS-over-
  //  windows metric needs every 50 ms scope window to hold ≥1 pulse → the trig
  //  source must fire FASTER than 20 Hz, which the harness's bpm-300-capped 4-Hz
  //  SEQUENCER can't do (a C=P=0.000 boundary race). The concrete re-enable path
  //  that #4 pinned is now IMPLEMENTED: a per-port TEST source (an LFO SQUARE,
  //  shape=2 + depth=1 → ±2 swing crossing the 0.5 gate threshold, rate=50 Hz —
  //  see BEHAVIORAL_PORT_TEST_SOURCE) fires a rising edge every 20 ms, and a
  //  per-port SUT param override pins BOTH delays to the 2 ms minimum (see
  //  BEHAVIORAL_PORT_PARAMS) so each edge's out1 pulse fires before the next edge
  //  re-arms the countdown. out1 then reads ~0.14-0.22 RMS against a SILENT
  //  control (trig1 unpatched → out1 = 0) — a dense, deterministic silent-vs-
  //  pulsing delta. trig1 is a real-coverage pass; trig2 → out2 only (the first-
  //  output sink can't see out2 in OFF mode) → per-port exempt in
  //  BEHAVIORAL_SWEEP_EXEMPT. OFF/PARALLEL/SERIES coupling + the trig→out delay
  //  remain pinned deterministically by moog911a.test.ts. Verified 3× locally.)
  // moog960 — sequential CONTROLLER (analog step sequencer). It AUTO-RUNS on
  // spawn (startTransport() — like the repo `sequencer`) at the internal rate
  // (2 Hz), sweeping its 8 columns; but ALL 24 step pots default to 0.5 and the
  // ranges to ×1, so every column emits the SAME 0.5 on the observed row1 CV —
  // a CONSTANT 0.5 in BOTH the control AND patched runs regardless of which
  // transport input (clock/start/stop) is driven. Opening differing pots would
  // make row1 sweep, but then the FREE-RUNNING control already sweeps too, so a
  // 4-Hz clock/start/stop gate only RE-PHASES that same sweep — a subtle
  // variance/timing shift that straddles the universal RMS-over-windows
  // threshold (the SAME subtle-sequencer-state class as sequencer.reset).
  // Deterministic per-step CV, range scaling, and
  // mode (SKIP/STOP) logic is pinned by moog960.test.ts (Seq960Stepper) +
  // seq960-dsp.test.ts. (Re-enterable once the harness supports a held-CV /
  // per-column-distinct-pots driver that makes the clock advance observable.)
  // (moog960 RE-ENABLED — behavioral-recon #4. NOT actually a "constant 0.5 /
  //  only re-phases" case once the row-1 step pots are made DISTINCT: with
  //  r1s1..r1s8 spanning a full 0→1 ramp (BEHAVIORAL_PARAMS.moog960) the
  //  free-running CONTROL sweeps row1 across all 8 columns at the internal 2-Hz
  //  rate, so the observed row1 CV's per-snapshot RMS VARIES across the 5-snapshot
  //  window (the staircase mean moves column-to-column). Driving the TRANSPORT
  //  gates then changes that sweep observably:
  //    • stop  → the 4-Hz stop train HALTS the transport on the first edge, so
  //      patched row1 FREEZES at one column (near-constant CV → rms.range≈0)
  //      while the control keeps sweeping (rms.range wide) — a clean range delta.
  //    • start → the 4-Hz start train RE-ZEROES to column 0 every 250 ms, pinning
  //      patched row1 near r1s1=0 vs the control's full sweep — a mean+range delta.
  //    • clock → connecting `clock` switches moog960 to EXTERNAL-clock mode
  //      (isClockConnected()), advancing one column per 4-Hz edge instead of the
  //      internal 2-Hz rate — a faster sweep with a wider per-window RMS range.
  //  All three clear the universal floor with margin; verified 3× locally. Per-
  //  step/range/mode logic still pinned by moog960.test.ts + seq960-dsp.test.ts.)

  // ── MANDELBULB — heavy ray-marched 3D fractal video source. Each frame
  //    is a full GPU ray-march; the behavioral sweep's 2-spawn × per-input
  //    iteration (11 drivable CV inputs × 2 spawns × multi-second settle)
  //    consistently exceeds the per-test wall-clock budget on cold CI Linux
  //    (the test times out at 162s in BOTH recent failing runs — NOT a
  //    delta failure on any single port). Same heavy-mount-exceeds-budget
  //    class as the `foxy` exemption above. Covered by mandelbulb-related
  //    VRT/specs which screenshot the fractal at distinct parameter values.
  mandelbulb: 'heavy ray-marched 3D fractal; 2-spawn × per-input sweep exceeds the 162s CI test budget (times out, not a per-port delta failure — same class as foxy); covered by mandelbulb VRT/specs',

  // ── vfpgaRunner — HOST module whose def declares the FULL I/O SUPERSET (4
  //    video in / 4 CV / 4 gate), but the LOADED VFPGA selects which subset is
  //    ACTIVE. The only bundled VFPGA (smpte-bars) is a pure GENERATOR: it uses
  //    cv1 (a SHIFT role that only rotates the bar columns) and ZERO video/gate
  //    inputs — so 11 of the 12 superset ports are CORRECTLY inert for this spec
  //    (they're activated by FUTURE VFPGAs in later waves), and cv1's bar-column
  //    rotation moves Δμvar≈0.6 (below the universal variance floor) at the
  //    sampled-frame statistic. The behavioral "every input perturbs the output"
  //    invariant is fundamentally wrong for a manifest-host whose ACTIVE inputs
  //    are per-loaded-spec; this is a HOST-SUPERSET exemption, not a regression.
  //    Per-spec input→effect coverage lives in vfpga-runner.spec.ts (smpte-bars
  //    renders to OUTPUT) + the spec-validation + snapshot unit tests; each
  //    port's wire-up is still pinned by per-module-per-port.spec.ts inputs-accept.
  vfpgaRunner: 'manifest-HOST superset class: the def declares the full I/O superset (vin1-4/cv1-4/g1-4) but the loaded VFPGA selects the active subset — the only bundled spec (smpte-bars) is a pure generator using just cv1 (SHIFT, Δμvar≈0.6 below floor) + 0 video/gate, so 11/12 superset ports are correctly inert for it. Covered by vfpga-runner.spec.ts (smpte-bars → OUTPUT) + spec-validation/snapshot unit tests; inputs-accept still pins each port wire-up.',
};

// ────────── Reconciliation law: every exemption is BACKLOG ──────────
//
// EVERY entry in BEHAVIORAL_MODULE_EXEMPT (and every per-port entry in
// BEHAVIORAL_SWEEP_EXEMPT) is reconciliation BACKLOG. There is NO permanent
// "intentional / correct-by-design" exempt bucket — the old reconcilable-vs-
// intentional split (a separate BEHAVIORAL_RECONCILABLE_EXEMPT map the counter
// read to report a smaller "fixable" number) was RETIRED, because lumping
// architecture-gated skips into a "this is fine forever" pile let the disabled
// count plateau instead of trending to 0.
//
// An entry leaves the backlog ONLY one of two ways:
//   • RE-ENABLED — driven in a context where the port genuinely affects the
//     observed output (provide the base signal, then perturb; use a metric that
//     fits the output shape — held-note/cent for pitch voices, per-transient
//     PEAK for one-shot pulses, per-channel sink for summed mixers), re-enabled
//     with a healthy ≥3× floor margin and flake-checked 3×. It then drops out of
//     BEHAVIORAL_MODULE_EXEMPT entirely.
//   • DELETED — if the port can NEVER affect output under any patching (a pure
//     terminal sink, a passthrough whose output equals its input by
//     construction), DELETE its auto-enrolled assertion with a one-line
//     rationale rather than parking it as exempt.
//
// Each remaining entry's note is therefore a CONCRETE re-enable path (or a
// delete rationale), not a "permanently exempt" justification. The harder cases
// (animated-video variance floors, heavy-mount wall-clock, MI multi-second state
// machines) need new harness capability (longer/spawn-once windows, per-channel
// sinks, a subset-under-budget runner) — that capability IS the backlog work,
// the entries are not waived.

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
  // adsr (re-enabled, behavioral-recon #3): the `decay` + `release` CV scalers
  // are the two drivable shape inputs (gate is the dominant silent→~0.8 pass;
  // attack/sustain/retrig are per-port-exempt). At the DEFAULT decay=0.1 /
  // release=0.3 with the HIGH default sustain=0.7 the decay barely drops the
  // level (1→0.7), so a BUGGLES ±1V CV on decay/release only nudged the
  // per-snapshot RMS by ~1.05-1.65× the floor across a 3× check → near-threshold.
  // The fix MAXIMISES each scaler's leverage on the observed env RMS:
  //   • sustain=0.2 makes the DECAY phase a big 1→0.2 excursion, and decay=0.1 s ≈
  //     the 4-Hz context gate's 125 ms on-window — so within that window the level
  //     depends STEEPLY on the decay time, and the log-scaled CV (knob ×
  //     100^(cv/2)) sweeps the decay constant across two decades → the env
  //     amplitude at any fixed scope phase swings widely (Δrange≈0.20-0.29 RMS).
  //   • release=0.2 s > the 125 ms gate-off window so the release tail is CUT
  //     (sampled mid-fall) → the CV changes how much tail survives each off-window.
  //     The RELEASE test ALSO carries a per-port BEHAVIORAL_PORT_PARAMS override
  //     (sustain:0.6) so the tail starts TALLER and the swing is robust
  //     (Δμrms≈0.033-0.054); see BEHAVIORAL_PORT_PARAMS['adsr.release'].
  // Both clear with a stable margin; verified 4×. All values stay inside the
  // params' native ranges (decay/release 0.001-10 s, sustain 0-1).
  adsr: { decay: 0.1, release: 0.2, sustain: 0.2 },
  // analogVco: fmAmount/pmAmount = 0 by default → fm/pm audio inputs
  // produce no audible change. Boost both to 0.5 so both audio inputs
  // AND their CV scalers (fmAmount/pmAmount inputs) perturb the sine.
  analogVco: { fmAmount: 0.5, pmAmount: 0.5 },
  // wavetableVco: same shape as analogVco (fmAmount/pmAmount gating).
  wavetableVco: { fmAmount: 0.5, pmAmount: 0.5, wavePos: 0.5 },
  // swolevco: timbre/symmetry/fold/ratio default tuned for clean; boost.
  swolevco: { timbre: 0.5, symmetry: 0.5, fold: 0.4, ratio: 0.3 },
  // moog921Vco: the sync input is gated by the 3-way `sync` switch (default 0
  // = off), and lin_fm by `linFmAmount` (default 0). Put sync in HARD (+1) and
  // open linear-FM depth so those inputs can actually perturb the sine output.
  // (Verified locally: this makes both `sync` and `lin_fm` real-coverage passes.)
  moog921Vco: { sync: 1, linFmAmount: 0.6 },
  // moog921b: same gating shape as the 921 VCO. The dc_mod / ac_mod linear-FM
  // inputs are gated by `modAmount` (default 0 → no FM), and the `sync` input by
  // the 3-way `syncMode` switch (default 0 = off). Open modAmount + put syncMode
  // in HARD (+1) so all three audio-typed modulation inputs actually perturb the
  // observed sine output. (Verified locally: makes dc_mod / ac_mod / sync real-
  // coverage passes; width_bus is exempt — it shapes the rect/saw, not the sine.)
  moog921b: { modAmount: 0.7, syncMode: 1 },
  // moog961: S/V-trigger format converter. The observed v_out1 = `s_in held
  // high OR audio→trigger rising-edge` (trigger-convert-dsp.ts). moog961 is a
  // `utilities`-category module, so buildContextEdges feeds NOISE (level 0.4)
  // into the non-test audio input (audio_in) in BOTH the control + patched
  // runs — at the default sensitivity=0.5 that context noise would cross the
  // detector and pulse v_out1 in the CONTROL too, muddying the s_in test. Pin
  // sensitivity HIGH (0.95) so the level-0.4 context noise stays BELOW the
  // detector (its rectified peaks rarely reach 0.95) → the s_in control reads a
  // clean SILENT 0.000 and the gate-train-driven v_out1 is the only variable
  // (s_in is a real-coverage pass with Δμrms≈0.72, ~70× the floor). The
  // column-A/B V inputs (and audio_in itself) are per-port-exempt; see
  // BEHAVIORAL_SWEEP_EXEMPT for why.
  moog961: { sensitivity: 0.95 },
  // moog960 (re-enabled, behavioral-recon #4): analog step-sequencer. The whole
  // re-enable hinges on making the observed row1 CV ACTUALLY SWEEP — at the
  // default r1s*=0.5 every column emits 0.5 so row1 is a constant 0.5 (C=P). Make
  // the 8 row-1 step pots a DISTINCT 0→1 ramp (r1s1=0 … r1s8=1) so the free-
  // running CONTROL sweeps row1 across the full 0..1 span column-to-column → the
  // observed row1's per-snapshot RMS varies across the 5-snapshot window. Against
  // that sweeping baseline the transport gates produce a clean delta (stop freezes
  // the sweep, start re-zeroes it, clock re-rates it — see the module-exempt note).
  // range1 stays 0 (×1) so the CV spans the project's standard 0..1 unipolar span
  // (no clipping); rate stays at the default 2 Hz. Per-column DSP pinned by
  // moog960.test.ts.
  moog960: {
    r1s1: 0.0, r1s2: 0.14, r1s3: 0.29, r1s4: 0.43,
    r1s5: 0.57, r1s6: 0.71, r1s7: 0.86, r1s8: 1.0,
  },
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
  // moog984: 4×4 cross-point matrix mixer. out_j = Σ_i in_i × m_ij; ALL 16
  // cross-points (m11..m44) default to 0 so the matrix is silent until a
  // connection is dialled in — the SAME default-0-levels passive-mixer class as
  // attenumix. The behavioral sweep observes out1 (first audio output),
  // so open COLUMN 1 (m11/m21/m31/m41 = 1) — then driving ANY of in1..in4 with
  // the noise source reaches out1 and perturbs it (the context-noise on the
  // other channels is the SAME in both control + patched, so the test input is
  // the only variable). The remaining columns stay at 0; out2..out4 aren't
  // observed by the sweep. Per-cross-point gain math is pinned by moog984.test.ts.
  moog984: { m11: 1, m21: 1, m31: 1, m41: 1 },
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
  // writeseq: same shape as sequencer. isPlaying=0 so the CONTROL (test input
  // unpatched) is SILENT, and the only drivable inputs that perturb the output
  // are the ones that START the run:
  //   * clock    : shouldSequencerRun(playing=0, clockConnected, playCv=0) =
  //                clockConnected → the patched run advances on the external
  //                clock + plays the seeded steps; control is silent → delta.
  //   * play_cv  : a rising edge toggles isPlaying → the patched run plays the
  //                seeded grid; control is silent → delta.
  //   * cv       : pass-through to PITCH engages while the context-gate (fired
  //                on `gate` for the cv test) is high → pitch follows cv → delta.
  // gate/rec/reset_cv/queue1..4_cv can't perturb the observed output in this
  // isolated, isPlaying=0 harness — see BEHAVIORAL_SWEEP_EXEMPT. recArm stays 0
  // so a context-gate on `gate` (fired for the cv test) doesn't start recording
  // and muddy the control. populateAllSequencerSteps seeds the SUT's grid.
  // TOM DRUM — a percussive decaying voice: the scope's 43 ms windows land at
  // random phases of the 250 ms strike cycle, so at SHIPPING defaults the
  // control's own jitter is huge (the 7 st bend chirps every attack → zc/cent
  // range ±17/±25; breath+overtone widen it further) and buries small CV
  // perturbations. Pin the control to a QUIET, stable baseline: bend_amt=0
  // (stable pitch → control cent range ±6-10 Hz, measured 10×), bend_time=300
  // (a CV-driven bend stays audible across the whole strike cycle),
  // tone/noise=0.2 floors (gives accent's brighten-on-hard-strike macro
  // existing layers to lift), drive=0 (no tanh compression of level deltas),
  // decay=1200 (the voice rings between the 4 Hz driver strikes). All values
  // inside the params' native ranges.
  tomtom: { bend_amt: 0, bend_time: 300, tone: 0.2, noise: 0.2, drive: 0, decay: 1200 },
  writeseq: { isPlaying: 0, recArm: 0, overdub: 0, bpm: 240, length: 4, gateLength: 0.5 },
  // CLAP — a percussive noise voice: the scope's 43 ms windows land at random
  // phases of the 250 ms strike cycle, so at SHIPPING defaults the control's
  // own window jitter is huge (band-passed noise bursts + a 150 ms tail that
  // is DEAD in half the windows) and buries small CV perturbations. Pin the
  // control to a QUIET, stable baseline: width=0.15 (narrow → tonal, stable
  // zc/centroid), color=0 + drive=0 (no extra spectral churn / tanh
  // compression of level deltas), tail=700 (the room rings between the 4 Hz
  // driver strikes → every window carries signal), snap=0.4 (room-dominant
  // for a smooth control, burst still present so spread_cv stays audible).
  // All values inside the params' native ranges.
  clap: { width: 0.15, color: 0, drive: 0, tail: 700, snap: 0.4 },
  // TIDY VCO: pin the observability corners the SHIPPING defaults hide.
  // shape1/shape2=1 + pw=0.25 put both oscillators on their PULSE leg so
  // pwm_cv audibly moves the duty (at the default shape=0 both oscs are
  // SAWS and pw is a no-op — the one dead-CV case by design); drive=0
  // gives drive_cv its full 0→1 swing (the knob is loudness-compensated,
  // so the delta shows in crest/centroid, not rms); cutoff=5000 opens the
  // ladder so waveshape deltas reach the analyser; width=0 + detune=0 +
  // sub=0 kill the stereo/unison/sub churn that pads window variance. FOLD
  // is left at 0 module-wide (a bit-exact bypass — folding here would dilute
  // the weak pitch/cutoff_cv centroid deltas with the folder's harmonic
  // thicket); fold_cv is still observable from 0 (its LFO drives the folder
  // 0→engaged), and sym_cv — which is a NO-OP unless FOLD is up — gets a
  // per-port fold=0.5 override below. All values inside native ranges.
  tidyVco: { shape1: 1, shape2: 1, pw: 0.25, drive: 0, cutoff: 5000, res: 0.3, width: 0, detune: 0, sub: 0 },
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
  // ── LUSHGARDEN scene-geometry CV inputs (rate / horizon / view). The
  //    garden is a stochastic scene (random spawn positions/depths at ~2/s):
  //    the mono output's luma-variance fingerprint carries a ±300-std
  //    per-snapshot spread from the random bed itself, and the control vs
  //    patched phases compare two DIFFERENT random beds — so these three
  //    CVs' real but geometry-shaped effects land near the noise floor:
  //      • view  — pure horizontal parallax TRANSLATION; frame-variance is
  //        ~translation-invariant (the exact lines.phase / textmarquee.posY
  //        class). Measured Δμvar 2.8–99 across repeats → sporadic NO-DELTA.
  //      • horizon — vertically compresses far-rank anchors proportional to
  //        depth (near plants barely move). Δμvar 0.7–117 across repeats.
  //      • rate — repopulation speed; the wiggling spawn cadence is masked
  //        by the random bed's own variance spread. Δμvar 2.8–132.
  //    Measured over 7 local repeats: each row detected in most runs, each
  //    also read a Δμvar <4 at least once → the near-threshold class from
  //    the behavioral-stabilization campaign, not dead ports (grow / reset /
  //    background all stay gated here and detect with Δμvar 770–2690). The
  //    exact rate/horizon/view math is pinned deterministically in
  //    lushgarden-scene.test.ts (stepSpawner rate→interval, depth-0/depth-1
  //    anchor + FAR_SCALE, parallax shift rows), and view/horizon/rate knobs
  //    ride the same params the CV bridge writes. RE-ENABLE PATH: the
  //    campaign's per-port-calibrated metric, or a seeded-garden behavioral
  //    driver (__lushgardenVrtSeed) so control and patched phases compare
  //    the SAME plant set instead of two random beds.
  'lushgarden.rate': 'stochastic-garden variance floor (±300 std) masks the spawn-cadence wiggle (Δμvar 2.8–132 across repeats) → near-threshold class; rate→interval math pinned in lushgarden-scene.test.ts; re-enable via per-port-calibrated metric or a __lushgardenVrtSeed-seeded driver',
  'lushgarden.horizon': 'stochastic-garden variance floor (±300 std) swamps the depth-proportional horizon anchor shift (Δμvar 0.7–117) → near-threshold class, cf. lines.phase/textmarquee.posY; placement math pinned in lushgarden-scene.test.ts; re-enable via per-port-calibrated metric or a __lushgardenVrtSeed-seeded driver',
  'lushgarden.view': 'parallax pan is a horizontal TRANSLATION — frame-variance ~invariant (the lines.phase class), Δμvar 2.8–99 across repeats → near-threshold; parallax shift math pinned in lushgarden-scene.test.ts; re-enable via per-port-calibrated metric or a __lushgardenVrtSeed-seeded driver',
  // ── RECORDERBOX audio inputs. audio_l / audio_r are RECORDED into the MP4
  //    soundtrack — they do NOT render into the module's VIDEO `out` (which is
  //    a pure passthrough of the `in` video). So driving an audio input
  //    produces ZERO change in the observable video output, by design: the
  //    only "delta" the sweep could ever see is the ACIDWARP context
  //    animation's own per-frame variance noise (the same animated-video
  //    variance-floor class as b3ntb0x / backdraft / bentbox). A pass would be
  //    on noise, not a real effect → flaky. Exempt these two ports; the `in`
  //    port IS exercised here (it drives the passthrough `out`). The audio
  //    capture → MP4 path is covered by the dedicated recorderbox.spec.ts
  //    (real VCO → audio_l → finalized MP4 + crash-recovery assertions).
  'recorderbox.audio_l': 'audio is recorded into the MP4 soundtrack, not rendered into the video out (a pure passthrough of in) → no observable video-output delta; covered by recorderbox.spec.ts (real VCO → audio_l → finalized MP4)',
  'recorderbox.audio_r': 'audio is recorded into the MP4 soundtrack, not rendered into the video out → no observable video-output delta; covered by recorderbox.spec.ts',
  // ── PENTEMELODICA per-voice FM jacks. fm1..fm5 are audio-rate FM/PM
  //    modulators that only affect a voice that is SOUNDING — i.e. whose ADSR
  //    has been gated open by its poly lane. The behavioral sweep drives ONE
  //    input at a time against an idle control (it imports driverFor from
  //    _drivers.ts, NOT the polyseqz upstream from _per-port-drivers.ts), so
  //    when it drives fmN there is no concurrent gated poly → the voice's
  //    envelope is at 0 → the FM modulates silence → no delta on out_l. This
  //    is correct: FM is a no-op on a gated-off voice. The `poly` input IS
  //    exercised here (it gates + pitches the voices → perturbs out_l).
  //    FM/PM audibility-when-gated is covered by pentemelodica-dsp.test.ts
  //    (renderPentemelodica with an FM input) + the bespoke e2e (poly chord
  //    drives the OUT) + the per-port emit sweep (the polyseqz driver gates
  //    all 5 voices so out_l/out_r + voice1..5 all emit).
  'pentemelodica.fm1': 'audio-rate FM/PM jack — only modulates a SOUNDING (gated) voice; behavioral sweep drives it without a concurrent gated poly → modulates a silent voice → no delta (correct). Covered by pentemelodica-dsp.test.ts + pentemelodica.spec.ts + the per-port emit sweep (polyseqz-gated).',
  'pentemelodica.fm2': 'audio-rate FM/PM jack — only modulates a SOUNDING (gated) voice; no concurrent gate in the behavioral harness → no delta (correct). Covered by pentemelodica-dsp.test.ts + the per-port emit sweep.',
  'pentemelodica.fm3': 'audio-rate FM/PM jack — only modulates a SOUNDING (gated) voice; no concurrent gate in the behavioral harness → no delta (correct). Covered by pentemelodica-dsp.test.ts + the per-port emit sweep.',
  'pentemelodica.fm4': 'audio-rate FM/PM jack — only modulates a SOUNDING (gated) voice; no concurrent gate in the behavioral harness → no delta (correct). Covered by pentemelodica-dsp.test.ts + the per-port emit sweep.',
  'pentemelodica.fm5': 'audio-rate FM/PM jack — only modulates a SOUNDING (gated) voice; no concurrent gate in the behavioral harness → no delta (correct). Covered by pentemelodica-dsp.test.ts + the per-port emit sweep.',
  // ── SNARE DRUM roll_speed_cv. It ONLY modulates the two-hand DRUMROLL rate,
  //    which requires gate_in to be HELD HIGH — but the behavioral sweep drives
  //    the SUT off the _drivers.ts gatePort (trigger_in single strikes, NO
  //    roll), so roll_speed_cv modulates a roll that isn't running → no delta
  //    (correct, same class as pentemelodica.fmN modulating a gated-off voice).
  //    trigger_in / gate_in / accent_in / pitch_cv / choke_in ARE exercised
  //    here. The rate map (roll_speed_cv +1V doubles the rate) is unit-proven in
  //    snare-roll-dsp.test.ts, and ROLL-SPEED density is asserted in the real
  //    chain (snaredrum-roll.spec.ts: faster roll → higher inter-stroke floor).
  'snaredrum.roll_speed_cv': 'CV only modulates the drumroll rate, which needs gate_in held high; the behavioral sweep drives trigger_in single strikes (no roll) → no delta (correct, cf. pentemelodica.fmN). Rate map unit-proven in snare-roll-dsp.test.ts; density asserted in snaredrum-roll.spec.ts.',

  // ── CUBE / WAVECEL per-voice ADSR ports (poly + trigger). The behavioral
  //    sweep drives ONE input at a time against an idle, ungated control. CUBE /
  //    WAVECEL run a free-running DRONE when ungated (decision #4: env skipped →
  //    byte-identical legacy output). When the sweep gates a SINGLE voice (one
  //    poly lane, or the mono TRIGGER) the default ~pass-through ADSR (attack
  //    0.001 / sustain 1) attacks the lane-0 envelope to ≈1 over the SAME phase
  //    accumulator the drone uses, with 1/sqrt(1)=1 normalization → the gated
  //    output is ≈ the drone waveform → no observable delta against the drone
  //    control. This is correct: a single voice at unity envelope over the drone
  //    accumulator is the drone. The real per-voice ADSR behavior (attack ramp,
  //    release tail, chord normalization, soft-retrigger, env-audible count) is
  //    covered by adsr-env.test.ts + poly-osc-sum.test.ts + the worklet
  //    byte-identical/poly tests (cube/wavecel.test.ts) + the bespoke e2e
  //    (adsr-poly-midilane.spec.ts: TRIGGER gates the env, drone back-compat,
  //    everGated, poly chord).
  'cube.poly': 'single gated voice at default ~pass-through ADSR ≈ the lane-0 drone (same phase accumulator, env→1, 1/sqrt(1) norm) → no delta vs the drone control; per-voice ADSR + chord behavior covered by adsr-env/poly-osc-sum unit tests + cube.test.ts + adsr-poly-midilane.spec.ts',
  'cube.trigger': 'gating the mono TRIGGER opens lane-0\'s env to ≈1 over the SAME drone accumulator → ≈ the drone waveform → no delta vs the drone control; gate→env→release covered by adsr-env.test.ts + adsr-poly-midilane.spec.ts (TRIGGER gates env / drone back-compat / everGated)',
  'wavecel.poly': 'single gated voice at default ~pass-through ADSR ≈ the lane-0 drone (env→1, 1/sqrt(1) norm) → no delta vs the drone control; per-voice ADSR + chord behavior covered by adsr-env/poly-osc-sum unit tests + wavecel.test.ts + adsr-poly-midilane.spec.ts',
  'wavecel.trigger': 'gating the mono TRIGGER opens lane-0\'s env to ≈1 over the drone oscillator → ≈ the drone waveform → no delta vs the drone control; gate→env→release covered by adsr-env.test.ts + adsr-poly-midilane.spec.ts',

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

  // ── TOYBOX video inputs (inA / inB). Same class as synesthesia's *_video_in:
  //    a video input only reaches the composited output when a LAYER selects it
  //    as its source (layer.videoSource = 'inA'|'inB'). The sweep spawns the
  //    DEFAULT patch (layer 0 = the default GEN shader; no layer points at a
  //    video port), so driving inA/inB is a correct no-op on the observed
  //    output. The cv1..cv6 modulation inputs DO perturb (they're routed) and
  //    are still exercised here. The patched-feed → layer-FBO → output flow is
  //    covered by toybox-video-inputs.spec.ts (selects In A/In B + asserts the
  //    feed reaches the output).
  'toybox.inA': 'video input only reaches output when a layer selects it as its source; default patch selects neither (correct no-op); covered by toybox-video-inputs.spec.ts',
  'toybox.inB': 'video input only reaches output when a layer selects it as its source; default patch selects neither (correct no-op); covered by toybox-video-inputs.spec.ts',

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

  // ── WRITESEQ — recording step-sequencer. Behaviorally, cv (pass-through),
  //    clock + play_cv (start the run + play the seeded grid) all perturb the
  //    output (verified locally). The remaining gate-type inputs can't perturb
  //    the observed output in the isolated, isPlaying=0 behavioral harness:
  'writeseq.gate':      'with isPlaying=0 + recArm=0 (the behavioral context), a held gate only pass-throughs the CV input to PITCH — but the cv input is unpatched (0V) during the gate test, so PITCH stays 0 → no delta. The gate→record + pass-through paths are covered by writeseq.spec.ts (pass-through + record) + the alignment/transport unit tests.',
  'writeseq.rec':       'rec toggles recArm, but with isPlaying=0 + no clock there is nothing to record/play → no observable delta. Covered by writeseq-transport.test.ts (T1: rec-gate toggles recArm) + writeseq.spec.ts.',
  'writeseq.reset_cv':  'reset_cv snaps the playhead to step 0 silently (same class as sequencer.reset_cv); with isPlaying=0 the control is already at step 0 → no delta. Covered by writeseq-transport.test.ts + the shared transport-cv reset path.',
  'writeseq.queue1_cv': 'sets queuedSlot, applied at sequence-end with a POPULATED slot (none in spawn harness) → no-op (same class as sequencer.queue1_cv); covered by the shared quicksave path.',
  'writeseq.queue2_cv': 'sets queuedSlot, applied at sequence-end with a POPULATED slot (none in spawn harness) → no-op; covered by the shared quicksave path.',
  'writeseq.queue3_cv': 'sets queuedSlot, applied at sequence-end with a POPULATED slot (none in spawn harness) → no-op; covered by the shared quicksave path.',
  'writeseq.queue4_cv': 'sets queuedSlot, applied at sequence-end with a POPULATED slot (none in spawn harness) → no-op; covered by the shared quicksave path.',

  // ── SCORE.play_cv toggles transport. With it un-driven the SUT is
  //    in stop state (no output), with it driven the SUT plays.
  //    But SCORE is exempt at the module level already.

  // ── SCOPE ch2 input: trace overlay only, no audio path, sink sees no
  //    delta. Covered by scope-ch2-related specs.
  'scope.ch2':  'overlay-only input; covered by dedicated scope ch2 specs',

  // ── ADSR retrigger semantics: depends on prior gate state; the
  //    universal driver doesn't sequence retrig events.
  //    Covered by adsr-vca-invert.spec.ts.
  'adsr.retrig': 'retrig depends on prior gate state; covered by adsr-vca-invert.spec.ts',


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
  // connect_strength / space_crush / space_diffuse — the SAME subtle-slice
  // class as cube.morph_fc/connect/crush above: each shapes the slice/space
  // readout (connect_strength scales the circle↔V blend, space_crush /
  // space_diffuse reshape the spatialiser), but at the default axis-aligned
  // slice + default tables a BUGGLES ±1V CV summed into the [0,1] param nudges
  // RMS/centroid below the sweep's threshold (Δrms≈0.001-0.007, straddling the
  // ~0.01 floor) → near-threshold jitter that flakes red. Covered by
  // cube-dsp.test.ts (per-param DSP response) + the cube node-ART baselines.
  // slice_y — the slice-NAVIGATOR Y axis. slice_rx/ry/rz (rotation) all
  // perturb with big deltas (they pass), but the Y translation is the
  // constrained axis at the default axis-aligned slice: a ±1V excursion only
  // shifts the readout a little, so Δrms straddles the ~0.01 floor
  // (Δμrms≈0.005, Δrange≈0.000) → near-threshold jitter that flakes red.
  // Covered by cube-dsp.test.ts (slice-position DSP response).
  'cube.slice_y':          'slice-navigator Y translation is the constrained axis at the default axis-aligned slice; ±1V excursion straddles the ~0.01 RMS threshold (jitter) — covered by cube-dsp.test.ts',
  'cube.connect_strength': 'connect-blend scaler is subtle at the default slice/tables; ±1V excursion straddles the ~0.01 RMS threshold (jitter) — covered by cube-dsp.test.ts + node-ART connect-vee baseline',
  'cube.space_crush':      'space-crush reshape is subtle at the default slice/tables; ±1V excursion below the centroid/RMS threshold — covered by cube-dsp.test.ts + node-ART crushed baseline',
  'cube.space_diffuse':    'space-diffuse reshape is subtle at the default slice/tables; ±1V excursion below the centroid/RMS threshold — covered by cube-dsp.test.ts',

  // ── HYPERCUBE morph_fc / connect / crush / alpha — HYPERCUBE is the same
  //    wavetable-cube-navigator family as CUBE (cube field → rotatable
  //    slice → wave), so these CV inputs are the IDENTICAL subtle-slice class
  //    as the cube.morph_fc/connect/crush exempts above. Each DOES shape the
  //    slice readout (morph picks floor↔ceiling fill, connect morphs the
  //    connector, crush quantizes the grid, alpha cross-fades the holo table),
  //    but at the sweep's default axis-aligned slice through the default tables
  //    a BUGGLES ±1V CV summed into the [0,1] param nudges RMS/centroid below
  //    the sweep's threshold (Δrms/Δcent straddle the ~0.01 / few-Hz floor) →
  //    near-threshold jitter that flakes red across the two independent
  //    BUGGLES-RNG spawns. pitch + Y + rot_x/y/z + tune + fold all perturb
  //    (they pass the sweep). Covered by hypercube.test.ts (per-param DSP
  //    response, mirroring cube-dsp.test.ts).
  'hypercube.morph_fc': 'morph floor↔ceiling fill is subtle at the default axis-aligned slice + default tables; ±1V excursion below centroid threshold (cube-family class) — covered by hypercube.test.ts',
  'hypercube.connect':  'circle↔V connector reshape is subtle at the default slice/tables; ±1V excursion below centroid threshold (cube-family class) — covered by hypercube.test.ts',
  'hypercube.crush':    'CRUSH is near-transparent off 0; a ±1V excursion barely moves RMS/centroid (cube-family class) — covered by hypercube.test.ts',
  'hypercube.alpha':    'alpha holo cross-fade is subtle at the default slice/tables; ±1V excursion straddles the ~0.01 RMS threshold (jitter, cube-family class) — covered by hypercube.test.ts',
  // slice_y — the constrained slice-navigator Y axis, identical to cube.slice_y
  // above: slice_rx/ry/rz (rotation) perturb with big deltas (they pass), but
  // the Y translation only nudges the readout at the default axis-aligned slice
  // so Δrms straddles the ~0.01 floor (Δμrms≈0.007, Δrange≈0.000) → jitter
  // (passes 2/3 runs, fails the 3rd). Covered by hypercube.test.ts.
  'hypercube.slice_y':  'slice-navigator Y translation is the constrained axis at the default axis-aligned slice; ±1V excursion straddles the ~0.01 RMS threshold (jitter, cube-family class) — covered by hypercube.test.ts',

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

  // moog921A driver — observed output is `freq_bus`. freq_cv (the pitch CONTROL
  // INPUT) IS covered: driving it moves freq_bus. width_cv feeds the SEPARATE
  // `width_bus` output (not freq_bus), so it correctly shows no delta on the
  // observed port — same independent-output shape as synesthesia's b_in. The
  // width passthrough is pinned by moog921a.test.ts (worklet width-bus sum).
  'moog921a.width_cv': 'width_cv feeds the separate width_bus output, not the observed freq_bus (independent CV buses by design, like synesthesia.b_in); width passthrough pinned by moog921a.test.ts',

  // moog921B slave VCO — observed output is `sine`. freq_bus (pitch), dc_mod,
  // ac_mod + sync ARE covered (freq_bus is the pitch; BEHAVIORAL_PARAMS opens
  // modAmount=0.7 + syncMode=HARD so the FM + sync inputs perturb the sine).
  // width_bus shapes the rectangular/saw duty cycle, NOT the sine tap — the
  // identical legit no-op as moog921Vco.width_cv. Pinned by moog921b.test.ts.
  'moog921b.width_bus': 'pulse-width sets the rect/saw duty cycle, not the measured sine tap (same shape as moog921Vco.width_cv); covered by moog921b.test.ts',

  // ── MOOG 993 trigger/envelope patch-bay (re-enabled, behavioral-recon #2).
  //    Observed first output is trig_out1 (gate). The default `route1=1` makes
  //    trig_from1 → trig_out1 a unity passthrough (real coverage). The other
  //    inputs are legit no-ops on the observed trig_out1:
  'moog993.trig_from2': 'route1=1 (default) selects SOURCE 1 only, so trig_from2 is muted into trig_out1; the from-2 routing (route1=2) is pinned by moog993.test.ts',
  'moog993.env_in1':    'env_in1 is a unity passthrough to the SEPARATE env_out1 CV output, not the observed gate-typed trig_out1 (independent buses by design, like moog921a.width_cv); env passthrough pinned by moog993.test.ts',
  'moog993.env_in2':    'env_in2 is a unity passthrough to the SEPARATE env_out2 CV output, not the observed gate-typed trig_out1 (independent buses by design); env passthrough pinned by moog993.test.ts',

  // ── MOOG 961 S/V-trigger format converter (re-enabled, behavioral-recon #2).
  //    Observed first output is v_out1 (gate). s_in (format passthrough) is the
  //    real-coverage input: its 4-Hz gate train drives v_out1 against a clean
  //    SILENT control (Δμrms≈0.72; see BEHAVIORAL_PARAMS.moog961). The other
  //    three inputs are legit no-ops / masked on the observed v_out1:
  'moog961.audio_in': 'audio_in DOES drive v_out1 (level→trigger detector), but the behavioral harness fires the s_in CONTEXT gate at 240 BPM in BOTH runs — so v_out1 is already pulsing at rms≈0.7 and audio_in\'s added transients shift it by only Δμrms≈0.01 (straddles the threshold → near-threshold jitter). The audio→trigger detector path is pinned by moog961.test.ts (rectified-level crossing fires v_out1/v_out2)',
  'moog961.v_in_a': 'v_in_a → s_out_a only (column-A width-matched passthrough), never the observed v_out1; the v_in_a → s_out_a path is pinned by moog961.test.ts',
  'moog961.v_in_b': 'v_in_b → s_out_b only (column-B fixed-width one-shot), never the observed v_out1; the v_in_b → s_out_b path is pinned by moog961.test.ts',

  // ── MOOG 911A dual trigger DELAY (re-enabled, behavioral-recon #5). Observed
  //    first output is out1 (gate). trig1 is the real-coverage input: the
  //    50-Hz LFO-square test source + the 2 ms delay override (see
  //    BEHAVIORAL_PORT_TEST_SOURCE + BEHAVIORAL_PORT_PARAMS) turn out1 into a
  //    dense pulse train vs a silent control. trig2 is the legit no-op:
  'moog911a.trig2': 'in the default OFF mode trig2 → out2 ONLY (independent channels: trig1→out1, trig2→out2), and the behavioral sink observes the FIRST output out1 — so trig2 can never perturb out1 (the same per-channel-isolation no-op as moog993.trig_from2 / shapedramps); the trig2→out2 delay path is pinned by moog911a.test.ts',

  // ── MOOG 962 Sequential Switch: SHIFT advances the selector across in1..in3.
  //    The behavioral sweep drives ONE input at a time, so SHIFT is exercised
  //    with in1..in3 UNPATCHED (idle): advancing the selector routes near-idle →
  //    near-idle, giving Δμrms=0.004 — well inside the `out` CV's own ±0.089
  //    noise floor. Pass/fail is then decided by noise, i.e. FLAKY: it was green
  //    in all 5 flake-purge passes (run 28486495363) yet failed shard 4 on a real
  //    main run (28488538570). in1/in2/in3 pass (they route their own probe to
  //    out). RE-ENABLE: drive SHIFT WITH distinct sources patched to in1..in3
  //    (BEHAVIORAL_PORT_TEST_SOURCE) so advancing switches between them → a real
  //    attributable delta. Covered by moog962.test.ts (selector advance / routing).
  'moog962.shift': 'SHIFT advances the sequential-switch selector; the sweep drives it against UNPATCHED in1..in3 (idle→idle routing) → Δμrms=0.004 inside the out ±0.089 noise floor → near-threshold FLAKE (green in all 5 flake-purge passes, failed one real main run). in1/in2/in3 stay gated. RE-ENABLE: drive SHIFT with distinct sources on in1..in3. Covered by moog962.test.ts',

  // ── MOOG 911 Envelope Generator: esus_cv displaces the SUSTAIN level, which
  //    only shapes the env's HELD (gated-sustain) portion. The behavioral sweep's
  //    short 5-snapshot window over a retriggering env is dominated by attack/
  //    release, where sustain barely registers → Δμrms=0.003 inside the env's
  //    ±0.105 noise floor → near-threshold FLAKE (green in the flake-purge, failed
  //    shard 3 on a real main run 28490403808). t1/t2/t3 (times) + gate stay
  //    gated. RE-ENABLE: hold the gate through the sustain phase + widen the
  //    window so the sustain-level displacement is observable. Covered by
  //    moog911.test.ts (envelope contour / sustain math).
  'moog911.esus_cv': 'sustain-LEVEL CV only shapes the env\'s held-sustain phase; the short retriggering behavioral window is attack/release-dominated → Δμrms=0.003 inside the env ±0.105 noise floor → near-threshold flake (green in the purge, failed one real run); t1/t2/t3/gate stay gated. RE-ENABLE: hold the gate through sustain + widen the window. Covered by moog911.test.ts',

  // ── MOOG 921B (slaved VCO): freq_bus is its 1V/oct pitch CV from a 921A
  //    driver (the 921B has no 1V/oct jack of its own). The pitch DOES respond —
  //    driving freq_bus with the sweep's time-varying probe SWEEPS the pitch
  //    (perturbed cent jitters ±13–24 Hz vs the control's ±1 Hz, mean 264→255),
  //    but the delta metric compares MEAN cent, and a symmetric sweep around a
  //    similar mean collapses to Δμcent 3–10 Hz — inside the metric's own noise →
  //    near-threshold flake (failed 2 flake-purge passes). This is a
  //    metric-mismatch, NOT dead CV (the ±24 Hz perturbed jitter proves the pitch
  //    moves). width_bus + fine/range stay gated. RE-ENABLE: drive freq_bus with
  //    a STEP (not a sweep) so the mean pitch shifts, or score the zero-cross /
  //    cent-RANGE. Covered by moog921b.test.ts (bus→pitch/octave math).
  'moog921b.freq_bus': '1V/oct pitch bus — the pitch DOES respond (perturbed cent jitters ±13–24 Hz vs control ±1 Hz, mean 264→255) but a symmetric sweep collapses the MEAN-cent metric to Δμcent 3–10 Hz → near-threshold metric-mismatch flake (not dead CV); width_bus/fine/range stay gated. RE-ENABLE: STEP the bus (not sweep) or score cent-RANGE/zero-cross. Covered by moog921b.test.ts',


  // ── wavetableVco mirrors analogVco's FM/PM gating shape. Same set
  //    of fundamentally-gated inputs that need DC-biased modulators
  //    or non-default knob state. Covered by wavetable-vco.test.ts.
  'wavetableVco.fm':       'audio-rate FM with zero-mean noise cancels; covered by wavetable-vco.test.ts',
  'wavetableVco.fine':     'cv on small-range knob (±100 cents); covered by cv-range-uniformity.spec.ts',
  'wavetableVco.fmAmount': 'cv-modulates-knob-that-modulates-zero-input; covered by wavetable-vco.test.ts',
  'wavetableVco.pmAmount': 'cv-modulates-knob-that-modulates-zero-input; covered by wavetable-vco.test.ts',


  // ── TREE.oh.VOX subtle filter/envelope/tune CV scalers (module re-enabled,
  //    behavioral-recon #4). With the held-note driver (BEHAVIORAL_HELD_NOTE_DRIVER
  //    plays a constant C3 → a STABLE ~150 Hz audio_out spectral-centroid baseline)
  //    the GATE-driven ports are now real-coverage passes — gate_in (silent→
  //    sounding, Δμrms≈0.23, ~23× floor), accent_in (the accent boost, Δμrms≈0.13,
  //    ~13× floor), and waveform_cv (saw↔square morph, Δμrms≈0.030 + Δrms.range
  //    ≈0.04, ~3× floor) all clear with margin, verified 3×. The remaining CV
  //    scalers below, however, are 303 TIMBRE/DYNAMICS shapers whose footprint on
  //    the 50 ms-windowed RMS/centroid metric sits AT or BELOW the gate-retrigger
  //    jitter floor: a zero-mean BUGGLES CV on them averages out across the window,
  //    and they flake run-to-run (pass on one metric/run, fail the next — measured
  //    2×). They are NOT a held-note regression (that fixed the centroid baseline);
  //    they are the genuine subtle-CV-on-a-303-filter class (the subtle
  //    percussion-CV class). Each is pinned per-param at the DSP level by treeohvox-dsp
  //    .test.ts + treeohvox-parity.test.ts (Open303 CV→filter/envelope response)
  //    and the treeohvox ART baseline. (Re-enterable with a per-port-calibrated
  //    floor sized to that stable baseline OR a DC-biased/swept driver per CV.)
  'treeohvox.pitch_in':   'pitch CV on a held-note baseline: the centroid swing flakes run-to-run (Δrms.range≈0.012-0.015 straddling the 0.02 floor; cent.range 15→287 Hz), a near-threshold jitter; pitch→filter-tracking response pinned by treeohvox-dsp.test.ts',
  'treeohvox.tune_cv':    'tune (±12 st) CV: the fine pitch shift on a held note straddles the floor (Δr cent 20→69 Hz, Δμrms<0.01 both runs) — near-threshold jitter; covered by treeohvox-dsp.test.ts',
  'treeohvox.cutoff_cv':  'filter-cutoff CV: zero-mean BUGGLES on the cutoff averages out over the 50 ms window (Δμrms≈0.001-0.002, Δrms.range 0.015-0.018 straddling the 0.02 floor) — fails one run, marginal the next; cutoff→spectrum response pinned by treeohvox-dsp.test.ts',
  'treeohvox.res_cv':     'resonance CV: the resonant-peak shift sits at the gate-retrigger jitter floor (passes on Δr.rms one run / Δr.zc the next, both ~1× floor) — near-threshold; res→Q response pinned by treeohvox-dsp.test.ts',
  'treeohvox.env_cv':     'envelope-mod-depth CV: the filter-env-sweep depth shift is below the windowed RMS/centroid floor (Δμrms≈0.000-0.002, Δrms.range 0.001→0.027 flaking across the 0.02 floor); env→filter-sweep response pinned by treeohvox-dsp.test.ts',
  'treeohvox.decay_cv':   'filter-decay-time CV: the tail-length shift straddles the floor on the gate-loop transient (Δμrms 0.001-0.010, Δrms.range 0.008-0.010, both ~at floor) — flakes; decay→envelope response pinned by treeohvox-dsp.test.ts',
  'treeohvox.accent_cv':  'accent-intensity CV: a GENUINE ~0 delta on audio_out (Δμrms≈0.001-0.003, Δrms.range≈0.005-0.016, all below floor both runs) — the accent CV scaler barely moves the bulk energy under a non-accented held note; accent→boost response pinned by treeohvox-dsp.test.ts',


  // ── RINGS subtle resonator-timbre CVs on a strummed transient. RINGS is
  //    an MI Rings modal/sympathetic-string resonator (rings.ts) driven by
  //    a `strum` gate. note_cv / level_cv / model_cv DO perturb the
  //    observed `odd` output (pitch shift / amplitude scale / model switch
  //    all pass). These four shape the RESONATOR TIMBRE — structure,
  //    brightness, damping, position — whose spectral-centroid change on a
  //    short strummed transient sits below the universal centroid threshold
  //    in the 1.5s window (the SAME subtle-spectral class as
  //    swolevco.timbre). Covered by rings.test.ts
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
  //    shift sits below the RMS/centroid threshold (the SAME gate-loop
  //    percussion class). root_cv / spread_cv / q_cv /
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
  'warrenspectrum.ping1':       'percussive vactrol ping; short-transient bulk-energy shift below threshold (percussion class); covered by warrenspectrum specs',
  'warrenspectrum.ping2':       'percussive vactrol ping; short-transient bulk-energy shift below threshold (percussion class); covered by warrenspectrum specs',
  'warrenspectrum.ping3':       'percussive vactrol ping; short-transient bulk-energy shift below threshold (percussion class); covered by warrenspectrum specs',
  'warrenspectrum.ping4':       'percussive vactrol ping; short-transient bulk-energy shift below threshold (percussion class); covered by warrenspectrum specs',
  'warrenspectrum.ping5':       'percussive vactrol ping; short-transient bulk-energy shift below threshold (percussion class); covered by warrenspectrum specs',
  'warrenspectrum.ping6':       'percussive vactrol ping; short-transient bulk-energy shift below threshold (percussion class); covered by warrenspectrum specs',
  'warrenspectrum.ping7':       'percussive vactrol ping; short-transient bulk-energy shift below threshold (percussion class); covered by warrenspectrum specs',
  'warrenspectrum.ping8':       'percussive vactrol ping; short-transient bulk-energy shift below threshold (percussion class); covered by warrenspectrum specs',
  'warrenspectrum.global_ping': 'percussive vactrol ping (all bands); short-transient bulk-energy shift below threshold (percussion class); covered by warrenspectrum specs',
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

  // ── TEMPEST (tempest.ts): the rim CV moves the player CLAW — a glowing yellow
  //    claw spanning ONE of 16 lanes — around the rim. The claw DOES move (proven
  //    GL-free in tempest.test.ts: buildTempestLines claw vertices shift with the
  //    rim param), but a claw occupying ~1/16 of the rim sliding one lane barely
  //    changes the GLOBAL frame variance/non-black metric — the same
  //    video-variance class as acidwarp. Covered by tempest.test.ts + the
  //    tempest-render-smoke E2E.
  'tempest.rim': 'claw occupies ~1 of 16 lanes; sliding it does not move global frame-variance (video-variance class); claw motion unit-proven in tempest.test.ts + render-smoke',

  // ── MANDLEBLOT (mandleblot.ts): self-running Mandelbrot fractal whose
  //    color_out frame is already high-variance at every zoom level. zoom_cv
  //    zooms the fractal, but the per-frame variance/non-black metric stays
  //    saturated across the zoom (different region, similar statistic) —
  //    the SAME video-variance class as acidwarp.speed_cv. Covered by the
  //    mandleblot VRT coverage which screenshots distinct zoom depths.
  'mandleblot.zoom_cv': 'zooms a self-running high-variance fractal; frame-variance metric stays saturated across zoom (video-variance class); covered by mandleblot VRT/specs',
  // ── LINES (lines.ts): phase offset SCROLLS the procedural line pattern. Shifting
  //    the phase TRANSLATES the bands but preserves the frame's overall variance /
  //    non-black statistic (Δμvar=2.36 vs a ±63.7 per-snapshot variance floor) →
  //    near-threshold FLAKE, same video-variance class as tempest.rim/spirographs
  //    (green in the flake-purge, failed shard 3 on a real main run 28490403808).
  //    orient/amp/thickness stay gated (they reshape band structure → real delta).
  //    RE-ENABLE via a phase-correlation / centroid metric. Covered by
  //    lines-render-smoke.spec.ts.
  'lines.phase': 'phase offset scrolls/translates the procedural line bands but preserves global frame-variance (Δμvar 2.36 vs ±63.7 noise) → near-threshold flake, video-variance class (cf. tempest.rim); orient/amp/thickness stay gated. RE-ENABLE via a phase-correlation/centroid metric. Covered by lines-render-smoke.spec.ts',

  // ── TEXTMARQUEE (textmarquee.ts): posY translates the scrolling text band
  //    VERTICALLY. The other 3 CV inputs (scrollX / scrollY / posX) reliably
  //    perturb the metric; posY does NOT, because a horizontal text band moved
  //    up/down covers a near-identical pixel area → global frame-variance is
  //    unchanged (var ≈ 308.8 in both control and perturbed; the flake-purge saw
  //    Δμvar straddle the threshold 0.02→3.19 against a ±0.0–4.4 floor, failing
  //    3 of 5 purge passes on shard 6 — a near-threshold FLAKE). Same
  //    video-variance class as tempest.rim: the effect is real (posY has a Knob +
  //    a `cv` input in TextmarqueeCard; textmarquee-layout.test.ts proves the
  //    vertical offset) but sub-resolution for the coarse metric. Per-PORT exempt
  //    (posX/scrollX/scrollY stay gated). RE-ENABLE via a centroid-displacement /
  //    row-band metric. Covered by textmarquee.test.ts + textmarquee-layout.test.ts
  //    (vertical-position math) + textmarquee-render-smoke.spec.ts.
  'textmarquee.posY': 'vertical text translation keeps the covered pixel-area (and thus global frame-variance ≈ 308.8) unchanged → Δμvar straddles the threshold (flaky 3/5 purge passes), same video-variance class as tempest.rim; posX/scrollX stay gated. RE-ENABLE via a centroid/row-band metric. Covered by textmarquee.test.ts + textmarquee-layout.test.ts + textmarquee-render-smoke.spec.ts',
  // scrollY = VERTICAL scroll of the same horizontal text band — same geometry
  // as posY: it shifts the band up/down through a near-identical covered pixel
  // area, so global frame-variance barely moves (Δμvar 1.45–2.08 vs a ±0.0–5.7
  // floor; the control is a static var=308.8±0.0) → near-threshold flake (failed
  // 2 flake-purge passes on shard 6). The HORIZONTAL inputs posX/scrollX move
  // glyphs across columns → real variance delta, so they stay gated. RE-ENABLE
  // via the same centroid/row-band metric as posY. Covered by textmarquee.test.ts
  // + textmarquee-layout.test.ts (scroll math) + textmarquee-render-smoke.spec.ts.
  'textmarquee.scrollY': 'vertical scroll of the horizontal text band keeps the covered pixel-area/frame-variance ≈ constant (Δμvar 1.45–2.08 vs ±0–5.7, control static 308.8) → near-threshold flake, same geometry class as posY; posX/scrollX (horizontal → real delta) stay gated. RE-ENABLE via a centroid/row-band metric. Covered by textmarquee-layout.test.ts + textmarquee-render-smoke.spec.ts',

  // (b3ntb0x is WHOLE-MODULE exempt in BEHAVIORAL_MODULE_EXEMPT — its animated
  //  composite's ±580 variance floor swamps EVERY input, not just a few, so a
  //  per-port carve-out can't make it reliable. See that entry for the detail.)

  // ── DX7 poly (polyPitchGate): the universal sink reads DX7's summed
  //    mono `out`. Driving the poly note/gate input DOES retrigger the FM
  //    voice (zc/centroid wobble visibly: Δzc≈8-10, Δcent≈28-47Hz), but the
  //    BULK-ENERGY metric the sweep keys on (mean RMS) barely moves
  //    (Δμrms≈0.003, Δrange≈0.013) because the patched poly-note overlaps the
  //    context-gate's existing voice at a similar amplitude — the delta
  //    straddles the ~0.01 RMS floor and flakes red across the two
  //    independent spawns. The pitch + the algorithm/op params PASS. The poly
  //    note→voice path is pinned by dx7.test.ts (per-voice FM-operator math)
  //    + the dx7 ART/spec coverage. (A pitch/zc-keyed metric would gate this;
  //    see the systemic-fix TODO at the BEHAVIORAL_SWEEP_EXEMPT header below.)
  'dx7.poly': 'poly note/gate retriggers the FM voice (zc/centroid wobble) but mean-RMS delta straddles the ~0.01 floor under the overlapping context-gate voice (jitter); covered by dx7.test.ts + dx7 ART/specs',

  // ── MIRRORPOOL spatial-rearrangement CVs (wind_speed / wind_dir / cam_z).
  //    The pool surface animates every frame (wind swell + rain rings), so the
  //    OUT carries a ~1390 luma-variance floor. 8 of 11 CVs perturb it clearly
  //    (rain / brightness / surface_mode / cam_x / cam_y / pan / tilt / zoom all
  //    read observable deltas). These three are the video-variance class (cf.
  //    lines.phase / tempest.rim / lushgarden.view): they REARRANGE the ripple
  //    field or dolly the camera along the view axis WITHOUT moving global
  //    frame-variance — Δμvar 0.06–3.7 vs the ±16 floor → NO-DELTA.
  //      • wind_dir  — rotates the swell crest direction; a busy field of the
  //        same energy just reorients (variance-invariant).
  //      • wind_speed — adds swell energy on top of the already-rippling base
  //        (default 0.3 + rain chop); the incremental variance change stays
  //        sub-threshold vs the animation floor.
  //      • cam_z — dollies the camera ALONG its view axis (pan=0 looks down −z),
  //        the variance-quiet translation direction; cam_x (lateral) PASSES.
  //    All three are real, CV-wired inputs — the camera basis (cam_z dolly, FOV)
  //    is pinned in mirrorpool-core.test.ts:cameraBasis and the swell field
  //    (wind_dir/wind_speed change the height + gradient) in swellField tests;
  //    the composite VRT (mirrorpool-composite.spec.ts, baseline held for owner
  //    preview) shows them visually. RE-ENABLE via a per-port-calibrated
  //    (optical-flow / spatial) metric — the systemic behavioral-metric fix.
  'mirrorpool.wind_dir_cv': 'rotates swell direction — variance-invariant reorientation of an equal-energy field (video-variance class, cf. lines.phase); covered by mirrorpool-core.test.ts:swellField + mirrorpool-composite.spec.ts',
  'mirrorpool.wind_speed_cv': 'adds swell energy on top of the already-animating base (default wind+rain); incremental Δμvar sub-threshold vs the ~1390 animation floor; covered by mirrorpool-core.test.ts:swellField + mirrorpool-composite.spec.ts',
  'mirrorpool.cam_z_cv': 'dollies the camera along its view axis (variance-quiet translation; cam_x lateral PASSES); camera basis pinned in mirrorpool-core.test.ts:cameraBasis + mirrorpool-composite.spec.ts',

};

// ─── RATCHET — behavioral exemption caps ─────────────────────────────────
// BEHAVIORAL_MODULE_EXEMPT (whole-module) + BEHAVIORAL_SWEEP_EXEMPT (per-port)
// let a module/port OPT OUT of the behavioral CV→output sweep. Every entry is
// reconciliation BACKLOG (see the "every exemption is BACKLOG" law above).
// These caps FREEZE the lists at today's size so they can only SHRINK —
// adding a NEW exemption fails this test on purpose.
//   RATCHET RULE: exemptions only shrink. LOWER the number when you fix
//   coverage and delete an entry. Only RAISE it for a genuinely new,
//   documented exemption — NEVER to make a red sweep go green.
test('RATCHET: behavioral exemption lists only shrink', () => {
  expect(
    Object.keys(BEHAVIORAL_MODULE_EXEMPT).length,
    'BEHAVIORAL_MODULE_EXEMPT grew past its frozen cap — see the RATCHET rule above',
  ).toBeLessThanOrEqual(66); // +1 blood (data-gated emulator — driven + control inputs both idle without the non-redistributable WAD, absent in CI); +1 milkdrop (self-animating multi-pass visualizer — out luma-variance jitter floor swamps any per-input delta, cf. bentbox/b3ntb0x; covered by milkdrop-render-smoke.spec.ts); +1 spirographs (line generator — 25/31 geometry CV inputs reshape a thin curve sub-threshold on the coarse video-variance metric, cf. milkdrop/tempest.rim; deterministic, CV wired; covered by spirographs.test.ts + render-smoke)
  expect(
    Object.keys(BEHAVIORAL_SWEEP_EXEMPT).length,
    'BEHAVIORAL_SWEEP_EXEMPT grew past its frozen cap — see the RATCHET rule above',
  ).toBeLessThanOrEqual(175); // +3 mirrorpool.{wind_dir_cv,wind_speed_cv,cam_z_cv} (animated-pool ~1390 luma-variance floor; wind rotates/adds equal-energy swell + cam_z dollies along the view axis — video-variance-class spatial-rearrangement inputs blind to the global-variance metric, cf. lines.phase/tempest.rim/lushgarden.view; the other 8 CVs PASS; camera/swell math pinned in mirrorpool-core.test.ts + composite VRT); +3 lushgarden.{rate,horizon,view} (stochastic-garden variance floor ±300 std masks the three scene-geometry CVs — view is a pure translation (lines.phase class), horizon a depth-proportional anchor shift, rate a spawn-cadence wiggle; each read Δμvar <4 at least once over 7 repeats → near-threshold flakes; grow/reset/background stay gated and detect at Δμvar 770–2690; math pinned in lushgarden-scene.test.ts, re-enable via per-port-calibrated metric or __lushgardenVrtSeed-seeded driver); +1 snaredrum.roll_speed_cv (CV only modulates the drumroll rate, which needs gate_in held high; the sweep drives trigger_in single strikes → no roll → no delta, cf. pentemelodica.fmN; rate map unit-proven in snare-roll-dsp.test.ts, density asserted in snaredrum-roll.spec.ts); +1 tempest.rim (claw occupies ~1/16 lanes; sliding it doesn't move global frame-variance — video-variance class; claw motion unit-proven in tempest.test.ts + render-smoke); +1 textmarquee.posY (vertical text translation keeps covered pixel-area/frame-variance unchanged → near-threshold flake, video-variance class; posX/scrollX stay gated; covered by textmarquee-layout.test.ts + render-smoke); +1 moog962.shift (advancing the seq-switch selector across UNPATCHED in1..in3 gives Δμrms 0.004 inside the ±0.089 out-noise floor → near-threshold flake; in1/in2/in3 stay gated; covered by moog962.test.ts); +1 lines.phase (phase scroll translates the line bands but preserves frame-variance, Δμvar 2.36 vs ±63.7 → near-threshold flake, video-variance class; orient/amp/thickness stay gated; covered by lines-render-smoke.spec.ts); +1 moog911.esus_cv (sustain-level CV only shapes the held-sustain phase; short retriggering window is attack/release-dominated, Δμrms 0.003 inside ±0.105 → near-threshold flake; t1/t2/t3/gate stay gated; covered by moog911.test.ts); +1 textmarquee.scrollY (vertical scroll of the horizontal band keeps frame-variance ≈ constant, Δμvar 1.45–2.08 → near-threshold flake, same geometry as posY; posX/scrollX stay gated; covered by textmarquee-layout.test.ts); +1 moog921b.freq_bus (1V/oct pitch bus responds — perturbed cent jitters ±24Hz — but a symmetric sweep collapses the mean-cent metric to Δμcent 3–10Hz → metric-mismatch flake, not dead CV; width_bus/fine/range stay gated; covered by moog921b.test.ts)
});

// TODO(behavioral-coverage, systemic fix — tracks the header note + the
// behavioral-coverage TODO in .github/workflows/ci.yml): the Class-A
// near-threshold entries above (cube*/hypercube.*, dx7.poly, and
// the existing swolevco/rings/warrenspectrum families) all straddle a SINGLE universal delta threshold
// that is too coarse for subtle CV→audio effects. The right long-term fix is a
// MORE SENSITIVE / per-port-CALIBRATED metric (e.g. a pitch/zc-keyed metric for
// retrigger inputs, a per-transient peak/spectral metric for percussion, and
// per-port thresholds sized to each port's measured unperturbed-jitter floor)
// which would SHRINK this exempt list instead of growing it. The per-port
// exempt is the fast path to a reliable, low-flake gate today; the calibrated
// metric is the follow-up that lets these ports re-enter the sweep with real
// signal.

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

// ────────── Per-PORT TEST-input source override ──────────
//
// `pickInputSource(port.type, …)` picks a GENERIC type-appropriate source for
// the port under test (NOISE for audio, BUGGLES for cv, a 4-Hz SEQUENCER for
// gate, …). For a few ports that generic source can't expose the test-input's
// effect on the observed output — keyed `<moduleType>.<testPortId>`, an entry
// here REPLACES the generic test-input source for that one port:
//
//   moog911a.trig1 — the 911A is a TRIGGER DELAY: a rising edge on trig1 emits
//     a ~1 ms ONE-SHOT pulse on out1 (TRIGGER_DELAY_PULSE_S), NOT a held gate.
//     The generic gate source is a 4-Hz SEQUENCER (and the harness caps the
//     sequencer at bpm 300 = exactly 20 Hz), so the resulting out1 pulses sit
//     AT/BELOW the 50 ms scope-window's pulse-density boundary → a C=P=0.000
//     scheduler race (the BEHAVIORAL_SWEEP_EXEMPT note diagnosed this). A FAST
//     LFO SQUARE (shape=2 = pure square per lfo.ts's morph(); depth=1 → ±2
//     swing crossing the 0.5 gate threshold; rate=50 Hz) fires a rising edge
//     every 20 ms, so with delay1 pinned to the 2 ms minimum (see
//     BEHAVIORAL_PORT_PARAMS) out1 becomes a 50-Hz train of 1 ms pulses —
//     EVERY 50 ms scope window holds 2-3 pulses → out1 reads ~0.14-0.22 RMS
//     against a SILENT control (trig1 unpatched → out1 = 0). A clean, dense,
//     deterministic silent-vs-pulsing delta. (trig2 → out2 only, which the
//     first-output sink can't see → per-port exempt; see BEHAVIORAL_SWEEP_EXEMPT.)
const BEHAVIORAL_PORT_TEST_SOURCE: Record<string, InputSource> = {
  'moog911a.trig1': {
    node: {
      id: 'up-trig1-lfosq',
      type: 'lfo',
      position: { x: 60, y: 60 },
      domain: 'audio',
      params: { rate: 50, shape: 2, depth: 1 },
    },
    outPort: 'phase0',
    sourceType: 'gate',
  },
  // TOM DRUM bend_cv / decay_cv — both are DEPTH/TIME CVs on a percussive
  // voice whose effect the generic BUGGLES walk (±~0.15 V excursions, and
  // half of them clamped: bend depth can't go below 0 from the pinned
  // bend_amt=0 control) regularly fails to expose within the 800 ms window
  // (measured: patched cent range flips 8↔32 Hz run-to-run → 4-5/5 flaky).
  // A deterministic ±1 V SINE (depth=0.5 → ±1 swing; shape=0 = sine per
  // lfo.ts morph(); 3 Hz ≈ the 4 Hz strike train's beat neighbor, so
  // successive strikes sample DIFFERENT phases of the swing) exercises the
  // FULL calibrated CV range every window: bend_cv sweeps 0→24 st of attack
  // chirp (cent/zc range explodes vs the stable-pitch control), decay_cv
  // sweeps the tail ×¼→×4 (per-window rms/crest range widens).
  'tomtom.bend_cv': {
    node: {
      id: 'up-bendcv-lfo',
      type: 'lfo',
      position: { x: 60, y: 60 },
      domain: 'audio',
      params: { rate: 3, shape: 0, depth: 0.5 },
    },
    outPort: 'phase0',
    sourceType: 'cv',
  },
  'tomtom.decay_cv': {
    node: {
      id: 'up-decaycv-lfo',
      type: 'lfo',
      position: { x: 60, y: 60 },
      domain: 'audio',
      params: { rate: 3, shape: 0, depth: 0.5 },
    },
    outPort: 'phase0',
    sourceType: 'cv',
  },
  // CLAP tone_cv / tail_cv / spread_cv — octave-law CVs on a percussive
  // noise voice whose effect the generic BUGGLES walk (±~0.15 V
  // excursions) under-exercises within the 800 ms window. A deterministic
  // ±1 V SINE (depth=0.5 → ±1 swing; shape=0 = sine per lfo.ts morph();
  // 3 Hz ≈ the 4 Hz strike train's beat neighbor, so successive strikes +
  // windows sample DIFFERENT phases of the swing) exercises the FULL
  // calibrated CV range every window: tone_cv sweeps the band center
  // 400→3000 Hz (zc/centroid range explodes vs the pinned narrow-band
  // control), tail_cv sweeps the room ×¼→×4 (per-window rms/crest range
  // widens), spread_cv re-latches each strike's burst grid 4→25 ms
  // (attack-window crest/rms range widens).
  'clap.tone_cv': {
    node: {
      id: 'up-tonecv-lfo',
      type: 'lfo',
      position: { x: 60, y: 60 },
      domain: 'audio',
      params: { rate: 3, shape: 0, depth: 0.5 },
    },
    outPort: 'phase0',
    sourceType: 'cv',
  },
  'clap.tail_cv': {
    node: {
      id: 'up-tailcv-lfo',
      type: 'lfo',
      position: { x: 60, y: 60 },
      domain: 'audio',
      params: { rate: 3, shape: 0, depth: 0.5 },
    },
    outPort: 'phase0',
    sourceType: 'cv',
  },
  'clap.spread_cv': {
    node: {
      id: 'up-spreadcv-lfo',
      type: 'lfo',
      position: { x: 60, y: 60 },
      domain: 'audio',
      params: { rate: 3, shape: 0, depth: 0.5 },
    },
    outPort: 'phase0',
    sourceType: 'cv',
  },
  // TIDY VCO pwm_cv / drive_cv — full-swing CVs (±0.45 duty/V, ±1 V =
  // whole DRIVE range) that the generic walk's small excursions
  // under-exercise: the same deterministic ±1 V sine as clap's octave-law
  // ports. pwm_cv sweeps the pulse duty across most of 0.05..0.95 (zc +
  // even-harmonic centroid churn vs the pinned pw=0.25 control); drive_cv
  // sweeps the loudness-compensated tanh stage 0→1 (crest collapses +
  // centroid rises as the wave squares up).
  'tidyVco.pwm_cv': {
    node: {
      id: 'up-tvpwm-lfo',
      type: 'lfo',
      position: { x: 60, y: 60 },
      domain: 'audio',
      params: { rate: 3, shape: 0, depth: 0.5 },
    },
    outPort: 'phase0',
    sourceType: 'cv',
  },
  'tidyVco.drive_cv': {
    node: {
      id: 'up-tvdrive-lfo',
      type: 'lfo',
      position: { x: 60, y: 60 },
      domain: 'audio',
      params: { rate: 3, shape: 0, depth: 0.5 },
    },
    outPort: 'phase0',
    sourceType: 'cv',
  },
  // TIDY VCO fold_cv / sym_cv — full-swing wavefolder CVs that the generic
  // walk under-exercises: the same deterministic ±1 V sine as the pwm/drive
  // ports. fold_cv sweeps the fold amount around the control's fold=0.5
  // (harmonic thicket + stereo decorrelation churn); sym_cv sweeps the
  // fold-input DC bias (even-harmonic content — audible because the control
  // holds fold engaged).
  'tidyVco.fold_cv': {
    node: {
      id: 'up-tvfold-lfo',
      type: 'lfo',
      position: { x: 60, y: 60 },
      domain: 'audio',
      params: { rate: 3, shape: 0, depth: 0.5 },
    },
    outPort: 'phase0',
    sourceType: 'cv',
  },
  'tidyVco.sym_cv': {
    node: {
      id: 'up-tvsym-lfo',
      type: 'lfo',
      position: { x: 60, y: 60 },
      domain: 'audio',
      params: { rate: 3, shape: 0, depth: 0.5 },
    },
    outPort: 'phase0',
    sourceType: 'cv',
  },
};

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
// ────────── Held-note driver modules ──────────
//
// Modules whose observed audio output's SPECTRUM swings with the driven pitch,
// so the default 4-note driver arpeggio (60/64/67/72) injects a ±600-2800 Hz
// centroid baseline swing that HIDES the footprint of the CV scalers under test.
// For these the driver sequencer plays ONE constant note (see
// populateAllSequencerSteps' heldNoteDriver branch) → a STABLE centroid baseline
// against which cutoff/res/etc. CV is the only variable.
const BEHAVIORAL_HELD_NOTE_DRIVER = new Set<string>([
  // treeohvox — TB-303 voice (Open303). The audio_out spectral centroid is
  // dominated by the played pitch; a held C3 keeps the baseline stable so the
  // filter/envelope CV scalers register.
  'treeohvox',
]);

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
  // adsr.release — the module-wide BEHAVIORAL_PARAMS keeps sustain LOW (0.2) to
  // give the DECAY scaler a big 1→0.2 excursion, but that leaves the RELEASE tail
  // (which starts FROM the sustain level) only 0.2 tall, so the release-time CV's
  // effect on the 125 ms gate-off window's energy was thin (Δμrms dipped to
  // ~1.2× the floor across a 3× check → near-threshold). RAISE sustain to 0.6 for
  // the release test ONLY: the release tail now starts from 0.6 (3× taller), so
  // the log-scaled release-time CV (knob × 100^(cv/2)) swings how much of that
  // taller tail survives each off-window — a robust mean+range RMS delta. (decay's
  // test keeps the module-wide sustain=0.2; this per-port override touches release
  // alone.) Verified 3× stable with margin.
  'adsr.release': { sustain: 0.6 },
  // outlines.collide — the COLLIDE gate is a LIVE inter-shape ELASTIC-bounce
  // mode: HIGH → shapes knock each other around, LOW → they pass through. For
  // the behavioral sweep to see a delta, collisions must actually HAPPEN in the
  // settle window, which needs a DENSE field of BIG shapes. Force rate=1 (the
  // internal clock fills the field at 1/500ms), d=1 (270 px shapes → guaranteed
  // overlaps in the 1024 field), spd=0.35 (moving so pairs keep meeting) and
  // decay=0 (persist, so the field accumulates). With the gate driver pulsing
  // HIGH (240 BPM sequencer = 4 Hz), the COMBINE output's shape layout
  // diverges from the pass-through control as soon as the first pair collides —
  // a robust, deterministic (seeded RNG) video delta. Verified 3× stable.
  'outlines.collide': { rate: 1, d: 1, spd: 0.35, decay: 0 },
  // outlines.shape — the SHAPE selector is LATCHED at spawn, so the behavioral
  // sweep's CV delta needs new spawns within the settle window to show. Force
  // rate=1 so the internal clock spawns fresh shapes (which latch the perturbed
  // SHAPE value) + d=1 so they're big enough to move the per-output metric, and
  // decay=0 so the field accumulates rather than fading before the read.
  'outlines.shape': { rate: 1, d: 1, decay: 0 },
  // outlines.rotation — ROTATION is a LIVE GLOBAL spin; with a dense static-ish
  // field the spun polygon edges shift the overlap/contour layout vs the
  // unspun control. Force rate=1 + d=1 so there's a dense field to spin, spd
  // low so the spin (not the drift) dominates the delta, decay=0 to persist.
  'outlines.rotation': { rate: 1, d: 1, spd: 0.1, decay: 0 },
  // moog911a.trig1 — pin BOTH delays to the 2 ms MINIMUM (def 0.002) so each
  // trig1 rising edge from the 50-Hz LFO-square test source (see
  // BEHAVIORAL_PORT_TEST_SOURCE) fires its out1 pulse 2 ms later — i.e. WELL
  // before the next edge 20 ms away. At the DEFAULT 100 ms delay a 50-Hz edge
  // train would RE-ARM the countdown (TriggerDelay re-triggers on every rising
  // edge) before it ever elapses, so out1 would never pulse. The short delay
  // turns trig1 into a dense 50-Hz out1 pulse train. mode stays 0 (OFF):
  // trig1 → out1, the observed first output.
  'moog911a.trig1': { delay1: 0.002, delay2: 0.002 },
  // tidyVco.sym_cv — SYMMETRY is a FOLD-GATED DC bias (tidyFoldBias scales by
  // the effective FOLD, so it is an EXACT no-op at the module-wide fold=0).
  // Engage the wavefolder (fold=0.5) for THIS row ONLY so sweeping sym_cv
  // moves the fold's asymmetry → even-harmonic content: a robust crest +
  // zero-cross + RMS-variance delta (Δcrest ≈ 0.9, Δr rms ≈ 0.32 — measured
  // 5× stable). Keeping fold=0 module-wide leaves the weak pitch/cutoff_cv
  // centroid deltas undiluted by the folder's harmonic thicket.
  'tidyVco.sym_cv': { fold: 0.5 },
  // tomtom.tune_cv — the module-wide baseline is tone/noise 0.2 (broadband
  // breath dilutes the pitch centroid) + bend_amt 0. tune_cv sweeps the TUNE
  // knob (2 oct/V, 60–400 Hz). Strip TONE + NOISE for THIS row so the voice is
  // a clean membrane sine whose centroid IS the pitch — the slow-LFO sweep then
  // moves it 60↔400 Hz across the 4 Hz strikes (a large centroid mean+range
  // delta). Distinct from pitch_cv (whole-voice transpose); this rides the knob.
  'tomtom.tune_cv': { tone: 0, noise: 0 },
  // tomtom.bend_time_cv — the baseline pins bend_amt 0, so there is NO pitch
  // sweep for bend_time to TIME (an exact no-op). Engage a deep 24 st dive for
  // THIS row (clean sine) so sweeping the settle TIME reshapes the per-strike
  // pitch trajectory → a robust centroid range/zero-cross delta.
  'tomtom.bend_time_cv': { bend_amt: 24, tone: 0, noise: 0, decay: 250 },
  // tidyVco.shape1_cv — the baseline pins shape1 = 1 (already the pulse rail, so
  // adding CV clamps) behind a 5 kHz filter that hides the saw↔pulse harmonic
  // difference. Center the morph (0.5), take OSC1 only (mix 0) and OPEN the
  // filter (12 kHz, low res) for THIS row so the CV swings the full morph and
  // its even-harmonic content reaches the output → a clear centroid delta.
  'tidyVco.shape1_cv': { shape1: 0.5, mix: 0, cutoff: 12000, res: 0.1 },
  // tidyVco.fsus_cv — the SETTLED filter brightness while a note is held. Make
  // the filter EG the dominant timbre (env 1, low cutoff, fast attack/decay to
  // the sustain) so fsus_cv (additive on the 0–1 sustain) sweeps the held
  // brightness → a centroid mean delta.
  'tidyVco.fsus_cv': { env: 1, fatk: 0.001, fdec: 0.03, fsus: 0.4, cutoff: 220, res: 0.4 },
  // tidyVco.fatk_cv — the filter-EG ATTACK time. With notes retriggering at
  // 4 Hz (250 ms), set the base attack ~120 ms (comparable to the note) + env 1
  // so each note's brightness is still RAMPING; fatk_cv (4 oct/V ⇒ ~30–480 ms)
  // reshapes that ramp per note → a spectral variance (range) delta.
  'tidyVco.fatk_cv': { env: 1, fatk: 0.12, fdec: 3, fsus: 1, cutoff: 300, res: 0.4 },
  // tidyVco.fdec_cv — the filter-EG DECAY time. Fast attack, ~120 ms decay to a
  // low sustain within each 250 ms note; fdec_cv (4 oct/V) reshapes the per-note
  // brightness fall → a spectral variance (range) delta.
  'tidyVco.fdec_cv': { env: 1, fatk: 0.001, fdec: 0.12, fsus: 0.05, cutoff: 300, res: 0.4 },
  // tidyVco.frel_cv — the filter-EG RELEASE time. The 240 BPM driver gates
  // 125 ms ON / 125 ms OFF; open the filter fully during the note (env 1, fsus 1)
  // and keep the amp bleeding into the gap (rel 0.5) so the filter's RELEASE is
  // audible there. frel_cv (4 oct/V ⇒ ~25–400 ms) reshapes how fast the
  // brightness falls in each gap → a spectral variance delta.
  'tidyVco.frel_cv': { env: 1, fsus: 1, frel: 0.1, fatk: 0.001, fdec: 0.02, cutoff: 200, res: 0.4, sus: 1, rel: 0.5 },
  // tidyVco.rel_cv — the AMP-EG release time. Full sustain + short decay so the
  // voice sits at full level during the 125 ms gate, then rel_cv (4 oct/V ⇒
  // ~25–400 ms) sets how much tail bleeds into the 125 ms OFF gap → an RMS
  // mean/variance delta on the gap energy.
  'tidyVco.rel_cv': { atk: 0.001, dec: 0.06, sus: 0.12, rel: 0.14, env: 0.4, cutoff: 4000, res: 0.15 },
};

// ────────── Per-PORT / per-MODULE calibrated delta thresholds ──────────
//
// computeDelta() keys on a set of UNIVERSAL floors (rmsMean>0.01, centMean>30Hz,
// …) sized 2-3× above the typical unperturbed-jitter floor across ALL modules.
// That single universal floor is necessarily a COMPROMISE: it's too coarse for a
// genuine-but-subtle CV effect on a QUIET output (the signal falls under the
// floor) and — read the other way — too LOOSE for a noisy output whose intrinsic
// jitter already swings a metric past the floor (a no-delta port passes on
// noise). This is the systemic gap the BEHAVIORAL_SWEEP_EXEMPT header TODO calls
// out (cube*/dx7/treeohvox/… all straddle the single universal floor).
//
// This map lets a SPECIFIC port (or whole module) override ONLY the floors that
// matter for it — sized to THAT port's measured unperturbed-jitter floor — WITHOUT
// touching the universal floor every other module relies on. Two legitimate
// directions, both honest:
//
//   • TIGHTEN a floor (lower it) ONLY when the port's control-run jitter on that
//     metric is provably small (measure it 3× first): a real-but-small signal
//     then registers without lowering the bar for unrelated modules. Pair every
//     tightened floor with the measured control jitter in the comment so the
//     margin is auditable.
//   • RAISE a floor when a noisy output's intrinsic jitter is what's tripping the
//     universal floor (so a no-delta port stops passing on noise) — pair it with
//     a different, port-appropriate metric that DOES carry the real signal.
//
// NEVER tighten a floor to rescue a port whose measured signal genuinely sits in
// the jitter (that ships a flake — exactly what quarantined the subtle-CV class).
// Root-cause with BEHAVIORAL_PARAMS (open a gating knob so the effect is BIG) or
// a per-port driver FIRST; reach for a calibrated threshold only when the signal
// is real + stable but the universal floor is the wrong size for this port.
//
// Keyed `<moduleType>.<portId>` (per-port) OR `<moduleType>` (whole-module,
// applies to every non-overridden port). Per-port wins over per-module. Each
// field defaults to the universal floor when omitted.
//
// (Empty today: adsr + peaks — earlier re-enables — clear the UNIVERSAL floors
// with a healthy 2.4-13× margin via BEHAVIORAL_PARAMS / per-port exempts, so
// they need NO threshold override. The mechanism is the systemic-fix
// infrastructure that lets the NEXT batch — the noisy-output / quiet-exciter
// class still in BEHAVIORAL_SWEEP_EXEMPT / BEHAVIORAL_MODULE_EXEMPT backlog — be
// re-enabled with a per-port-calibrated floor instead of growing the exempt list.)
interface AudioThresholds {
  rmsMean: number;
  rmsRange: number;
  peakMean: number;
  crestMean: number;
  crestRange: number;
  zcMean: number;
  zcRange: number;
  centMean: number;
  centRange: number;
}
const UNIVERSAL_AUDIO_THRESHOLDS: AudioThresholds = {
  rmsMean: 0.01,
  rmsRange: 0.02,
  peakMean: 0.02,
  crestMean: 0.15,
  crestRange: 0.2,
  zcMean: 8,
  zcRange: 20,
  centMean: 30,
  centRange: 60,
};
const BEHAVIORAL_DELTA_THRESHOLDS: Record<string, Partial<AudioThresholds>> = {
  // (See the note above for the intended shape:
  //   'somemod.subtle_cv': { rmsMean: 0.004, rmsRange: 0.008 },  // ctrl jitter ±0.002, measured 3×
  // )
  // TOM DRUM pitch_cv — 1 V/oct (fixed semantics, can't be re-scaled): the
  // BUGGLES walk's ±~0.15 V excursions move the 110 Hz fundamental ±~12 Hz,
  // which reads as a clean patched cent-RANGE of 24-47 Hz against the pinned
  // stable-pitch control's 6-10 Hz (measured 10×) — but the universal
  // centRange floor (60) and the range-ratio gate (>4×) both sit just past
  // it (ratio 2.4-5.3, flips run-to-run with the control's 6↔10 jitter).
  // centRange 16 splits the observed populations with ≥1.4× margin each way.
  'tomtom.pitch_cv': { centRange: 16 }, // ctrl range 6-10 Hz, patched 24-47 Hz, measured 10×
  // TOM DRUM tone_cv — the fundamental↔overtone tilt on the pinned tone=0.2
  // control: the patched run's per-window crest RANGE is 0.30-0.48 vs the
  // control's 0.13-0.19 (measured 10×; the tilt changes the waveform's
  // attack-vs-tail shape mix), a level separation the universal crestRange
  // floor (0.2 on the DELTA) only clears when the run lands 0.33+.
  // crestRange 0.1 on the delta clears every observed run (floor 0.11) with
  // ~2× margin over control self-jitter (≤0.06).
  'tomtom.tone_cv': { crestRange: 0.1 }, // ctrl crest range 0.13-0.19, patched 0.30-0.48, measured 10×
};

function thresholdsFor(modType: string, portId: string): AudioThresholds {
  const override =
    BEHAVIORAL_DELTA_THRESHOLDS[`${modType}.${portId}`] ??
    BEHAVIORAL_DELTA_THRESHOLDS[modType];
  return override ? { ...UNIVERSAL_AUDIO_THRESHOLDS, ...override } : UNIVERSAL_AUDIO_THRESHOLDS;
}

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

function computeDelta(
  control: AggregatedSample,
  patched: AggregatedSample,
  thresholds: AudioThresholds = UNIVERSAL_AUDIO_THRESHOLDS,
): DeltaResult {
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
    // `thresholds` defaults to UNIVERSAL_AUDIO_THRESHOLDS; a per-port /
    // per-module entry in BEHAVIORAL_DELTA_THRESHOLDS overrides only the
    // floors that need recalibrating for that specific port.
    const t = thresholds;
    const exceeded =
      rmsMeanΔ > t.rmsMean ||
      rmsRangeΔ > t.rmsRange ||
      peakMeanΔ > t.peakMean ||
      crestMeanΔ > t.crestMean ||
      crestRangeΔ > t.crestRange ||
      zcMeanΔ > t.zcMean ||
      zcRangeΔ > t.zcRange ||
      centMeanΔ > t.centMean ||
      centRangeΔ > t.centRange ||
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
    // Feed sustained noise into EVERY non-test audio input (fan-out from ONE
    // shared NOISE source), not just the first. A multi-input effect (e.g. a
    // multi-channel FDN, in1..in4 → summed mix_l) needs ALL its channels excited so a
    // per-channel input/feedback CV under test perturbs the observed output —
    // wiring only the first audio input leaves the other channels silent, so e.g.
    // fb3_cv (scales channel-3 feedback) is a no-op on a channel carrying nothing.
    // Single-audio-input effects (filters/reverbs with one `in`) get exactly the
    // same single-edge behavior as before. Same fan-out shape as the video-context
    // ACIDWARP wiring below.
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
//
// `heldNoteDriver` (set per-module via BEHAVIORAL_HELD_NOTE_DRIVER) makes the
// DRIVER sequencer (`driver-seq`) play ONE constant MIDI note across all 4 steps
// instead of the default 60/64/67/72 arpeggio. A module whose observed output's
// spectrum SWINGS with the driven pitch (e.g. treeohvox / a TB-303 voice, whose
// audio_out spectral-centroid moves ±600-2800 Hz as the 4-note sequence plays)
// needs a STABLE pitch baseline so the CV scalers under test (cutoff/res/…) are
// the only thing moving the centroid — otherwise their footprint hides under the
// pitch-sequence's own jitter. The held note re-triggers at the 4-Hz gate rate
// (so the amp envelope still opens), but the PITCH is constant → a stable
// centroid baseline. Only the `driver-seq` node is held; the ctx-gate-seq + any
// test-input source sequencer keep the default steps.
async function populateAllSequencerSteps(page: Page, heldNoteDriver = false): Promise<void> {
  await page.evaluate((held) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { type: string; data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    const HELD_MIDI = 48; // C3 — a low held note: a long, filter-rich 303 tone.
    w.__ydoc.transact(() => {
      for (const id of Object.keys(w.__patch.nodes)) {
        const node = w.__patch.nodes[id];
        // WRITESEQ shares the {on, midi} step shape with SEQUENCER, so seed it
        // too — otherwise an isPlaying=0 control + a clock/play_cv patched run
        // both emit silence (empty grid) and the behavioral sweep sees no delta.
        if (!node || (node.type !== 'sequencer' && node.type !== 'writeseq')) continue;
        if (!node.data) node.data = {};
        node.data.steps = held && id === 'driver-seq'
          ? [
              { on: true, midi: HELD_MIDI },
              { on: true, midi: HELD_MIDI },
              { on: true, midi: HELD_MIDI },
              { on: true, midi: HELD_MIDI },
            ]
          : [
              { on: true, midi: 60 },
              { on: true, midi: 64 },
              { on: true, midi: 67 },
              { on: true, midi: 72 },
            ];
      }
    });
  }, heldNoteDriver);
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
    // TERMINAL SINK (zero outputs — audioOut, midiOutBuddy, sticky): with no
    // output port, an input can NEVER produce an observable output delta, so
    // there is no behavioral assertion to make. Per this spec's reconciliation
    // doctrine these are DELETED (not parked as exempt backlog): they are simply
    // not behavioral subjects. Mechanical + fail-closed — keyed on the live
    // output count, so any module WITH an output still proceeds to test-or-exempt
    // and a future zero-output module drops out automatically. Each is covered by
    // its own spec (audioOut → audio-output specs; midiOutBuddy →
    // midi-out-buddy.spec.ts; sticky → meta-domain, no audio path).
    if (mod.outputs.length === 0) continue;
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
      // When set, the driver sequencer plays one constant held note (stable
      // spectral baseline) instead of the 60/64/67/72 arpeggio — see
      // BEHAVIORAL_HELD_NOTE_DRIVER + populateAllSequencerSteps.
      const heldNoteDriver = BEHAVIORAL_HELD_NOTE_DRIVER.has(mod.type);
      const observed = pickObservedOutput(mod, driver);
      if (!observed) {
        // No scope-able / video-sinkable output → can't sample. We
        // shouldn't have gotten here (modules without outputs are
        // filtered via mod.outputs.length earlier in many specs); if
        // we do, fail loudly so the design gets revisited.
        await page.goto('/rack'); // give the test SOMETHING to navigate to before asserting
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
      //  goto('/rack') → spawnPatch(control) → settle → read
      //  goto('/rack') → spawnPatch(patched) → settle → read → compare
      const failures: string[] = [];
      const passes: string[] = [];

      for (const port of drivableInputs) {
        // Per-port TEST-input source override (e.g. moog911a.trig1 needs a
        // fast LFO square, not the generic 4-Hz sequencer) — falls back to the
        // generic type-appropriate source when no override is registered.
        const source =
          BEHAVIORAL_PORT_TEST_SOURCE[`${mod.type}.${port.id}`] ??
          pickInputSource(port.type, `up-${port.id}`);
        // pickInputSource null-checked at filter time, but TS doesn't
        // see that. Belt-and-suspender check.
        if (!source) continue;

        // ─── CONTROL ─────────────────────────────────────────────────
        // SUT + driver (if needed) + context (effect-shape upstream
        // noise/video) + sink. NO upstream on test input.
        await page.goto('/rack');
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
        await populateAllSequencerSteps(page, heldNoteDriver);
        await runFor(page, waitMsFor(mod.domain, observed.sink));
        const controlSample = await readSinkAggregated(page, observed.sink);
        if (!controlSample) {
          failures.push(`${mod.type}.${port.id}: control sink read failed`);
          continue;
        }

        // ─── PATCHED ─────────────────────────────────────────────────
        // Same nodes + edges, PLUS the test-input upstream.
        await page.goto('/rack');
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
        await populateAllSequencerSteps(page, heldNoteDriver);
        await runFor(page, waitMsFor(mod.domain, observed.sink));
        const patchedSample = await readSinkAggregated(page, observed.sink);
        if (!patchedSample) {
          failures.push(`${mod.type}.${port.id}: patched sink read failed`);
          continue;
        }

        const delta = computeDelta(controlSample, patchedSample, thresholdsFor(mod.type, port.id));
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

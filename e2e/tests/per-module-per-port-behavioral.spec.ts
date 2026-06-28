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
  clipplayer:     'TIMELORDE-locked launch output (8 lanes); only input stop_all silences, no per-output input + needs a running transport — no clean per-input delta in the short window; covered by clipplayer.test.ts + clipplayer.spec.ts + clip-types.test.ts',
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
  snes9x:   'ROM-gated emulator: all outputs (incl. measured audio_l) need a loaded ROM (user-provided, gitignored, absent in CI) so control + patched both read silence; covered by snes9x.spec.ts + snes9x-gameplay-gates.spec.ts (skip when ROM absent) + snes-input/clock-multiplier/smw-events unit tests',
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
  // (adsr + peaks RE-ENABLED — behavioral-recon #3. adsr's decay/release CV
  //  scalers are now real-coverage passes via a BEHAVIORAL_PARAMS leverage boost
  //  — see BEHAVIORAL_PARAMS.adsr; peaks' channel-0 ports clear out0 with a big
  //  margin while its channel-1 ports are per-port-exempt as independent-output —
  //  see the peaks.* entries in BEHAVIORAL_SWEEP_EXEMPT. Verified 3-4× locally.)

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

  // qbert — arcade ROM game (qbert.zip). Outputs are gameplay-
  // conditional (player_cv, score_cv, sfx) and the test browser
  // doesn't have the ROM fixture (404s on /roms/qbert/qbert.zip in
  // the failing run). Same exemption shape as `doom`/`nibbles`/
  // `frogger` above. Covered by qbert-rom-missing.spec.ts
  // (ROM-absence behavior) + qbert-cv-joystick.spec.ts (input wiring
  // when ROM is present) + qbert-runtime.test.ts (game-loop unit).
  qbert: 'arcade ROM gameplay-conditional outputs (ROM not fetched in test env); covered by qbert-*.spec.ts + qbert-runtime.test.ts',

  // (peaks RE-ENABLED — behavioral-recon #3. It IS a dual-INDEPENDENT-channel
  //  module — gate0/mode0/k1_0/k2_0 → out0, gate1/mode1/k1_1/k2_1 → out1 — but
  //  the channel-0 ports DO clear the observed out0 with a big margin, and the
  //  channel-1 ports are now per-port-exempt as independent-output, not whole-
  //  module exempt. See the peaks.* entries in BEHAVIORAL_SWEEP_EXEMPT.)

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

  // ── aquaTank — 4-channel Hadamard feedback delay network (FDN). REMAINS
  //    reconcilable (behavioral-recon #4 investigated + measured but did NOT
  //    re-enable). The earlier note ("observe out1, near-silent") was only HALF
  //    the story; observing the SUMMED `mix_l` (driver outputPort) + exciting all
  //    channels makes the output LOUD, but the per-channel CV footprint is still
  //    genuinely below the floor. Measured this leg, two regimes:
  //      • NOISE excitation (per-spawn RNG seed) → the FDN integrates the noise
  //        into a random-walk ring whose energy DIFFERS spawn-to-spawn; ports
  //        "pass" only on that RNG jitter (fb3_cv read Δμrms=0.006 / Δrange=0.016,
  //        BELOW floor, the same run others passed on noise — a FLAKE, exactly the
  //        class that quarantined it).
  //      • DETERMINISTIC excitation (a 110 Hz analogVco sine fanned into all 4
  //        inputs, identical across both spawns) → C and P are stable (±0.007) but
  //        the deltas collapse to ~0: in3/in4/fb1_cv/fb2_cv/fb3_cv/fb4_cv/tilt_cv
  //        ALL read Δμrms≈0.000, Δcent≈0-8 Hz, Δcrest≈0.00 — i.e. modulating ONE
  //        channel's feedback/input genuinely barely moves the soft-limited,
  //        damped, SUMMED mix_l (the tanh + one-pole damp + cross-mix average out
  //        a single channel's contribution).
  //    So the per-channel-CV-on-a-summed-FDN footprint is REAL-but-tiny, not a
  //    harness blind spot. Re-enterable only with a per-CHANNEL sink (observe
  //    out{N} for fb{N}_cv, not the sum) AND a deterministic per-channel source —
  //    the same per-channel-sink-selection follow-up mixmstrs needs. The `inputs-
  //    accept` dim still pins wire-up for every port; per-tap feedback/routing math
  //    pinned by aquatank.test.ts (with a sustained source + per-channel taps).
  aquaTank: 'per-channel-CV-on-summed-FDN class: observing the loud summed mix_l (not the near-silent out1) + exciting all 4 channels, the per-channel footprint is still real-but-tiny — a DETERMINISTIC 110 Hz tone fanned into all inputs (identical both spawns) gives stable C≈P with in3/in4/fb1-4_cv/tilt_cv ALL at Δμrms≈0.000 / Δcent≈0-8 Hz (the tanh + damp + cross-mix average out one channel\'s contribution to the sum), while NOISE excitation only "passes" on per-spawn RNG ring jitter (fb3_cv Δμrms=0.006 below floor = flake); re-enterable with a per-CHANNEL sink (out{N} for fb{N}_cv) + deterministic per-channel source (same per-channel-sink follow-up as mixmstrs); covered by aquatank.test.ts (per-tap feedback/routing with a sustained source)',

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
  //  veils / videoMixer, which are NOT exempt because they carry a
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
  // threshold (the SAME subtle-sequencer-state class as sequencer.reset /
  // atlantisCatalyst.reset_cv). Deterministic per-step CV, range scaling, and
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
  // veils: 4-channel VCA; gain1-4 default to 0 (channels closed).
  veils: { gain1: 0.6, gain2: 0.6, gain3: 0.6, gain4: 0.6 },
  // moog984: 4×4 cross-point matrix mixer. out_j = Σ_i in_i × m_ij; ALL 16
  // cross-points (m11..m44) default to 0 so the matrix is silent until a
  // connection is dialled in — the SAME default-0-levels passive-mixer class as
  // attenumix / veils. The behavioral sweep observes out1 (first audio output),
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
  writeseq: { isPlaying: 0, recArm: 0, overdub: 0, bpm: 240, length: 4, gateLength: 0.5 },
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
  // riotgirls — open the aux FX bus so the DESTROY/Reverb ports perturb the
  // output. The driver + context gate fire VOICE 1 (trig1) and OPEN ALL four
  // voices' sends + both return levels with HEADROOM so the whole FX bus carries
  // signal. With this:
  //   * vN_sendA / vN_sendB CV modulates each per-voice send level,
  //   * returnA / returnB CV modulates the wet-return level into the master sum,
  //   * bc_* (decimate/bits/wet) reshapes the DESTROY (bitcrush) path,
  //   * rv_* (size/damp/mix) reshapes the Reverb path.
  // bc_wet=1 keeps DESTROY's crush fully wet (so bc_decimate/bits move the output);
  // rv_mix=0.5 keeps the reverb path half-wet with headroom for rv_* to swing it.
  // Verified locally: ALL 53 drivable riotgirls inputs perturb outL (no
  // BEHAVIORAL_SWEEP_EXEMPT needed) — opening every voice's send (not just
  // voice 1's) lets the context-gate-fired transients hit both FX buses, so the
  // per-voice sends + returns + bc_*/rv_* all clear the delta metric.
  riotgirls: {
    v1_volume: 1.6, v1_decay: 0.4,
    v1_sendA: 0.6, v1_sendB: 0.6,
    v2_sendA: 0.6, v2_sendB: 0.6,
    v3_sendA: 0.6, v3_sendB: 0.6,
    v4_sendA: 0.6, v4_sendB: 0.6,
    returnA: 0.7, returnB: 0.7,
    bc_decimate: 1, bc_bits: 16, bc_wet: 1,
    rv_size: 0.6, rv_damp: 0.3, rv_mix: 0.5,
    flt_cutoff: 18000,
  },
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

  // ── PEAKS channel-1 inputs (re-enabled module, behavioral-recon #3). PEAKS is
  //    TWO INDEPENDENT channels (Émilie Gillet's dual-mode Peaks): gate0/mode0/
  //    k1_0/k2_0 drive worklet output 0 (out0), and gate1/mode1/k1_1/k2_1 drive
  //    the SEPARATE worklet output 1 (out1) — see the factory's inputs/outputs
  //    map (input 1 → ch1 → output 1). The behavioral sweep observes out0 (the
  //    first output), so the channel-1 ports correctly show NO delta on out0 —
  //    the IDENTICAL independent-output shape as synesthesia.b_in / moog921a.
  //    width_cv. The channel-0 ports (gate0/mode0_cv/k1_0_cv/k2_0_cv) ARE real-
  //    coverage passes with healthy margins (gate0 Δμrms≈0.36; mode0_cv switches
  //    out0 LFO→drum so Δzc≈530 + Δcent≈3000Hz; k1_0_cv/k2_0_cv Δrange≈0.6/0.8 —
  //    the LFO rate/wave knobs widen out0's per-snapshot RMS range). The per-
  //    channel/per-mode DSP is pinned by peaks.test.ts + peaks.spec.ts.
  'peaks.gate1':    'channel-1 trigger → worklet out1 ONLY, never the observed out0 (two independent channels by design, like synesthesia.b_in); ch1 path pinned by peaks.test.ts + peaks.spec.ts',
  'peaks.mode1_cv': 'channel-1 mode selector → out1 ONLY, never the observed out0 (independent channel); per-mode ch1 path pinned by peaks.test.ts',
  'peaks.k1_1_cv':  'channel-1 knob1 → out1 ONLY, never the observed out0 (independent channel); ch1 knob math pinned by peaks.test.ts',
  'peaks.k2_1_cv':  'channel-1 knob2 → out1 ONLY, never the observed out0 (independent channel); ch1 knob math pinned by peaks.test.ts',

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
  // q_cv (resonance) + decay_cv (amplitude-envelope decay) sit at the metric
  // threshold EDGE on the short percussive transient: q_cv shifts the resonant
  // filter bandwidth (Δrms≈0.008-0.017, straddling the ~0.01 floor) and
  // decay_cv shapes the tail length — both perturb in some runs but fall below
  // the RMS/centroid threshold in others (near-threshold jitter, same subtle/
  // percussion-transient class as the chowkick CVs above). The wiring +
  // per-param response is pinned at the DSP level by chowkick-dsp.test.ts.
  'chowkick.q_cv':            'resonance CV; bandwidth shift straddles the ~0.01 RMS threshold on the short transient (jitter); covered by chowkick-dsp.test.ts + chowkick.spec.ts',
  'chowkick.decay_cv':        'amplitude-decay CV; tail-length shift near/below the RMS/centroid threshold on the gate-loop transient (jitter); covered by chowkick-dsp.test.ts + chowkick.spec.ts',
  // pitch_amount/pitch_decay/drive (PR feat/chowkick-oomph) all shape the kick
  // CHARACTER, not its bulk energy: pitch_amount/pitch_decay set the per-trigger
  // downward PITCH SWEEP (attack frequency contour → 2-7 Hz centroid wobble,
  // pitch_cv class) and drive sets the body waveshaper drive (harmonic content
  // + weight, mostly absorbed by the body's safety tanh at the unity-gain kick
  // the driver fires). All three straddle the universal RMS/centroid threshold
  // on the short percussive transient (Δrms≈0.001-0.04, jitters pass/fail run-
  // to-run) — same subtle percussion-transient class as the chowkick CVs above.
  // Wiring + per-param response pinned deterministically at the DSP level by
  // chowkick-dsp.test.ts (pitchEnvStep sweeps down + retriggers; bodyDriveStep
  // saturates loud / passes quiet) and end-to-end by chowkick.spec.ts.
  'chowkick.pitch_amount_cv': 'pitch-sweep DEPTH CV; modulates attack pitch contour not bulk energy → 2-7 Hz centroid wobble straddles the RMS/centroid threshold (jitter, pitch_cv class); covered by chowkick-dsp.test.ts + chowkick.spec.ts',
  'chowkick.pitch_decay_cv':  'pitch-sweep TIME CV; modulates attack pitch contour not bulk energy → sub-threshold centroid shift on the short transient (jitter, pitch_cv class); covered by chowkick-dsp.test.ts + chowkick.spec.ts',
  'chowkick.drive_cv':        'body-waveshaper DRIVE CV; adds harmonics/weight largely absorbed by the body safety tanh on the unity-gain kick → Δrms straddles the ~0.01 threshold on the short transient (jitter, percussion class); covered by chowkick-dsp.test.ts (bodyDriveStep) + chowkick.spec.ts',

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
  //    they are the genuine subtle-CV-on-a-303-filter class (cf chowkick's pitch/
  //    noise/tone CVs). Each is pinned per-param at the DSP level by treeohvox-dsp
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

  // ── POLYHELM midi_in / seq_reset: two intrinsically non-perturbing inputs.
  //    * midi_in is a VISUAL-ONLY marker port (Web MIDI flows via the gear
  //      panel / message port, NOT a cable) — a cabled CV into it is a correct
  //      no-op on out_l by design (the worklet's inputs[3] is unused; see
  //      polyhelm.ts header). Same shape as the helm whole-module MIDI exempt.
  //    * seq_reset only does anything while the internal step sequencer is ON
  //      (default OFF, and the sweep doesn't enable it via the card), so a
  //      reset edge is a no-op on the observed audio. The seq-reset edge logic
  //      is unit-tested in packages/dsp/src/lib/helm-engine.test.ts
  //      (tickSequencerEdges). The headline poly/pitch_cv/gate paths PASS and
  //      the live MIDI-LANE→poly→audio chain is covered by
  //      e2e/tests/polyhelm-poly-chain.spec.ts.
  'polyhelm.midi_in':   'visual-only MIDI marker port (Web MIDI flows via the gear panel/message port, not a cable) → correct no-op on out_l; same class as the helm MIDI exempt',
  'polyhelm.seq_reset': 'no-op while the internal step sequencer is OFF (default; sweep does not enable it); seq-reset edge logic covered by helm-engine.test.ts (tickSequencerEdges)',

  // (aquaTank moved to BEHAVIORAL_MODULE_EXEMPT — its observed out1 is
  //  intrinsically near-silent (~0.005 RMS) so MANY ports straddle the
  //  floor, NOT just the fb*_cv sends: a 3× local flake-check showed in3
  //  (an AUDIO input) jitter too, so the per-port fb{1..4}_cv approach
  //  doesn't converge. Module-level exempt is the reliable fix.)

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
  ).toBeLessThanOrEqual(64); // +1 blood (data-gated emulator — driven + control inputs both idle without the non-redistributable WAD, absent in CI)
  expect(
    Object.keys(BEHAVIORAL_SWEEP_EXEMPT).length,
    'BEHAVIORAL_SWEEP_EXEMPT grew past its frozen cap — see the RATCHET rule above',
  ).toBeLessThanOrEqual(161); // +1 tempest.rim (claw occupies ~1/16 lanes; sliding it doesn't move global frame-variance — video-variance class; claw motion unit-proven in tempest.test.ts + render-smoke)
});

// TODO(behavioral-coverage, systemic fix — tracks the header note + the
// behavioral-coverage TODO in .github/workflows/ci.yml): the Class-A
// near-threshold entries above (cube*/hypercube.*, chowkick.q_cv/decay_cv,
// dx7.poly, the module-level aquaTank quiet-tank exempt, and
// the existing swolevco/elements/rings/warrenspectrum families) all straddle a SINGLE universal delta threshold
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
// out (cube*/chowkick/dx7/treeohvox/… all straddle the single universal floor).
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
  // (No entries yet — see the note above. Example of the intended shape, for the
  // next reconciliation batch:
  //   'somemod.subtle_cv': { rmsMean: 0.004, rmsRange: 0.008 },  // ctrl jitter ±0.002, measured 3×
  // )
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
    // shared NOISE source), not just the first. A multi-input effect (e.g. the
    // aquaTank FDN, in1..in4 → summed mix_l) needs ALL its channels excited so a
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
        await populateAllSequencerSteps(page, heldNoteDriver);
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

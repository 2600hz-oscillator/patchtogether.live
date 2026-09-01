// e2e/tests/_per-module-per-port-shared.ts
//
// Per-module per-port coverage sweep — the regression net for the class
// of bugs where a module silently loses an I/O port and no test fires.
//
// Motivation (DOOM PR #393): the DOOM module's def lost its
// CV-controlled per-player inputs (p1_up / p1_down / …) in one PR with
// zero failing tests, because no spec pinned the input port list. The
// downstream effect — game characters un-controllable from a patched
// CV cable — only surfaced when a user tried to play a multi-context
// rack. This file slams that door shut for EVERY module.
//
// Three sweep dimensions per module (one test per dim per module):
//
//   1. handle presence: every declared input + output renders a
//      `[data-handleid="<port.id>"]` element on the rendered card.
//      Fails clearly when a port is dropped from the def OR when
//      the card's PatchPanel rendering loop loses the port row.
//
//   2. outputs emit: for every declared OUTPUT port, route it to a
//      type-appropriate sink (SCOPE.ch1 for audio/cv/gate via the
//      cross-domain bridge that #414 fixed; VIDEOOUT.in for video /
//      mono-video) and assert the sink observes a signal. Ports
//      that genuinely can't emit without gameplay / file fixtures
//      land in EXEMPT_OUTPUT_EMIT with a documented reason.
//
//   3. inputs accept: for every declared INPUT port, spawn a type-
//      compatible upstream source, patch it into the input, and
//      assert (a) no console / page errors fired during the patch,
//      and (b) the engine actually materialised the edge. The "edge
//      lands without errors" check is the minimal "the input port
//      wires up" coverage; modules whose downstream effect is also
//      observable (filter cutoff CV moves the filter's audio output)
//      get a stricter assert via downstream-tap. Ports whose effect
//      is gameplay-deep land in EXEMPT_INPUT_DRIVE.
//
// Coverage philosophy: an exemption skips ONLY the signal-flow check
// for that one port; the module's handle-presence test STILL pins the
// port's existence. Exemptions are documented one-by-one with reasons
// AND a pointer at the dedicated coverage if any. If the exemption
// list grows past ~25 entries, the test design is wrong (PR comment
// flag).
//
// CI sharding: this spec emits ~3 tests × ~109 modules = ~327 tests.
// Playwright's --shard fan-out (8 shards in CI) distributes by test
// title hash — this file's titles are <module>-keyed so distribution
// is naturally uniform across shards.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch, type SpawnNode, type SpawnEdge } from './_helpers';
import { observeScopePeak, runFor } from './_module-coverage-helpers';
import { collectPageErrors } from './_page-errors';
import { REGISTRY, type RegistryModule, type RegistryPort } from './_registry';
import { driverFor } from './_drivers';
import { perPortDriverFor } from './_per-port-drivers';

// ────────── Module-level skips ──────────
// Modules whose card body can't be rendered under bare spawnPatch (mirrors
// io-spec-consistency.spec.ts SKIP_DEF_VS_UI). For these we skip ALL three dims —
// the dedicated specs at the cited paths cover their I/O.
export const SKIP_SPAWN: Record<string, string> = {
  group: 'requires data.children; covered by e2e/tests/grouping-phase1.spec.ts',
  cadillac: 'overlay sprite, not a flow card (zero ports); covered by e2e/tests/cadillac.spec.ts',
};

// ────────── Module-level output-emit exemptions ──────────
//
// Whole-module skips for cases where EVERY output port shares the same
// blocker AND no category-appropriate test driver can synthesize the
// trigger from inside Playwright (no real file decoder, no ROM in IDB,
// no in-game event reachable within the sweep budget). Handle-presence
// is STILL asserted for these — only the signal-flow check is skipped.
//
// MOST modules previously listed here have moved to active driver-backed
// coverage via `_per-port-drivers.ts` (test/driver-backed-per-port-sweep):
//   * Hardware sources (GAMEPAD, JOYSTICK, NUMPAD+) → addInitScript shims
//     + synthetic input events.
//   * MIDI-driven (MIDICLOCK, MIDICVBUDDY) → navigator.requestMIDIAccess
//     mock + synthetic 0xFA / 0xF8 / note-on messages routed via the
//     module's cardApi.connect() hook.
//   * Self-running clock modules (TIMELORDE, MARBLES) → just removed
//     (the old "needs upstream clock" comment was wrong; defaults
//     already self-run).
//   * Step sequencers (SCORE, KRIA)
//     → driver seeds isPlaying=1 + node.data.steps so the
//     internal scheduler fires.
//   * CV/gate utilities (ILLOGIC, SLEWSWITCH) → driver wires BUGGLES +
//     SEQUENCER upstream.
//   * ADSR → SEQUENCER.gate → ADSR.gate (already supported via driverFor).
//   * VIDEOOUT → ACIDWARP.out → VIDEOOUT.in (passthrough sweep).
//
// What stays exempt: only the irreducibly-asset-or-ROM-bound modules
// (~5-7 entries). Each has a one-line citation of the dedicated spec
// that exercises the full path with the real asset present.
export const EXEMPT_OUTPUT_EMIT_MODULES: Record<string, string> = {
  // ES9 — every output carries signal from PHYSICAL ES-9 hardware via the
  // es9-bridge native app's localhost WebSocket; neither exists in CI, so no
  // output can emit (module sits in its documented "bridge not found" idle
  // state). Handle-presence + input-accept still run. Signal flow is covered
  // by the dsp es9-bridge-core unit suite (ring, scaling, hysteresis,
  // underrun policies) + on-hardware verification steps in the native repo
  // (patchtogether.es9/docs/inet-modular-es9-module-plan.md).
  es9: 'all outputs source from physical ES-9 hardware via the native bridge (absent in CI); ring/scaling/policy logic covered by dsp es9-bridge-core tests, flow verified on hardware per the native repo plan',
  // VST BRIDGE cards — outputs carry the mounted PLUGIN's audio via the
  // vst-bridge native helper's localhost WebSocket (patchtogether.nativeapps,
  // ws://127.0.0.1:9309); neither helper nor plugins exist in CI, so a bare
  // spawn emits nothing (vstInstrument: silence without the helper; vstFx:
  // local bypass of its own UNDRIVEN inputs, which the generic emit sweep
  // does not wire — the fader precedent). Handle-presence + input-accept
  // still run. CV→MIDI conversion is pinned by dsp vst-bridge-core tests,
  // the wire codecs by vst/vst-transport tests; live-helper flow is
  // owner-verified per #1953 (the checklist lands with its M4 PR).
  vstInstrument: 'outputs source from a mounted AU plugin via the vst-bridge helper (absent in CI); CV→MIDI pinned by dsp vst-bridge-core tests, codecs by vst-transport tests, live flow owner-verified',
  vstFx: 'outputs are the helper round trip (absent in CI) or a local bypass of inputs the emit sweep does not drive (fader precedent); codecs/bypass pinned by vst-transport + dsp vst-bridge tests, live flow owner-verified',
  // FADER is a two-source video MIXER: both outputs (OUT = dry/wet of the A/B
  // mix; SEND = a copy of the A/B mix) are a blend of in_a/in_b/return, so with
  // nothing patched they are opaque black — there is no signal to emit until an
  // input is driven (which the generic emit sweep doesn't wire). Handle-presence
  // + input-accept still run here; the blend math is unit-tested
  // (fader-transitions) and the card↔engine param wiring by fader.spec.ts.
  fader: 'video mixer; OUT/SEND are blends of in_a/in_b/return — black until an input is driven (not per-output emit-drivable); blend covered by fader-transitions.test + fader.spec.ts',
  // ── Pure analysers whose outputs are input-conditional ──
  // SYNESTHESIA derives per-band audio / envelope CV / gates from its mono
  // inputs — every output is silent until a_in/b_in are driven AND a band
  // crosses threshold, which the generic sweep doesn't set up per-output. The
  // dedicated composite spec (VCO→VCA→ADSR←SEQUENCER→SYNESTHESIA) asserts that
  // the correct bands trigger. Handle-presence + input-drive still run here.
  synesthesia: 'outputs are input-conditional (band audio/env/gate); signal flow covered by the synesthesia composite spec',
  // FEATURECV is a pure broadband analyser: loud/bright/punch CV + the onset
  // trigger are all silent (the bipolar CVs sit at the -1 silence rail) until
  // its `in` is driven, which the generic emit sweep doesn't wire. Handle-
  // presence + input-drive still run here; the REAL source→featurecv→param
  // signal flow is asserted by e2e/tests/featurecv-source-chain.spec.ts
  // (noise → featurecv.bright → filter.cutoff → audible change) and the pure
  // core by packages/dsp/src/lib/featurecv-dsp.test.ts + the ART scenario.
  featurecv: 'outputs are input-conditional (broadband RMS/ZCR/crest CV + flux onset, silent until `in` is driven); signal flow covered by featurecv-source-chain.spec.ts + featurecv-dsp.test.ts',
  // FLIPPER is a gate flip-flop: each output only fires on alternate input
  // rising edges (FLIP on the 1st, FLOP on the 2nd, …), so the generic
  // "drive input → measure this output emits" sweep can't trigger the right
  // output per port. The alternating logic (incl. either-input + gate
  // duration) is exhaustively proven by packages/dsp/src/lib/flipper-dsp.test.ts.
  // Handle-presence + input-drive still run here.
  flipper: 'gate flip-flop; FLIP/FLOP fire on alternate input edges (not per-output drivable); logic covered by flipper-dsp.test.ts',
  // ── Hardware-input sources ──
  gamepad:    'no gamepad attached in test browser; covered by gamepad.spec.ts',
  joystick:   'no joystick movement in test browser; covered by joystick.spec.ts',
  moog956:    'ribbon controller; pitch/gate emitted only while the ribbon is touched (no pointer drag in the per-port harness); covered by moog956.test.ts',
  audioIn:    'requires live mic input; no audio device in CI; covered by audio-in.spec.ts',
  // ── MIDI-driven ──
  midiCvBuddy: 'requires MIDI device; covered by midi-cv-buddy.spec.ts',
  // MIDI-OUT-BUDDY emits MIDI to an external device, not audio/CV into the
  // graph — it has ZERO output ports, so the "every output emits" sweep has
  // nothing to assert. Listed here (like other output-less modules) so the
  // sweep documents the intentional absence. Its CV→MIDI send path + the
  // gate/pitch/velocity input handles are covered by midi-out-buddy.spec.ts.
  midiOutBuddy: 'no audio/CV outputs (emits MIDI to external gear); covered by midi-out-buddy.spec.ts',
  // CV BUDDY — its pitchCv/gate/velCv outputs are UNITY PASSTHROUGHS (silent
  // until a lane drives the pitch/gate/velocity inputs, which the bare-spawn
  // emit sweep does not), and its run/clock outputs are OWNER-ONLY + only fire
  // while a TIMELORDE transport is RUNNING (none in the solo spawn). So no
  // output emits from a bare spawn. Handle-presence + input-drive still run.
  // Signal logic is covered by the pure slot-alloc / clock-math / reconcile unit
  // tests; on-hardware flow is owner-verified at the ES-9 jacks (Part A preview).
  cvBuddy: 'passthrough note outputs (silent until inputs driven) + owner-only run/clock that need a running TIMELORDE transport; no output emits from a bare spawn. Covered by cv-buddy slot-alloc/clock-math/es9-reconcile unit tests; on-hardware flow owner-verified at the jacks',
  // Same module minus velocity — same four reasons, same coverage. It shares
  // `createCvBuddyHandle`, so there is no second clock to test separately.
  cvBuddyMini: 'passthrough note outputs (silent until inputs driven) + owner-only run/clock that need a running TIMELORDE transport; no output emits from a bare spawn. Shares createCvBuddyHandle with cvBuddy; covered by the same slot-alloc/clock-math/es9-reconcile unit tests plus the mini slot-layout cases',
  // ── Clock / divider / sequencer-like modules that need an upstream clock ──
  timelorde: 'clock divider; needs upstream clock; covered by timelorde-related specs',
  // TEMPOLOCK — every output is input-conditional BY DESIGN: from cold the
  // tracker emits nothing at all (no clock, bpm rail at 0, locked low) until
  // ~4 consistent inter-onset intervals declare the first lock — pinned by
  // tempolock-tracker.test.ts fixture 7 — and even DRIVEN, `clock` is a 10 ms
  // pulse every ~500 ms (the midiclock scope-window class) while `bpm` and
  // `locked` are DC levels (the moogCp3 DC class). The real signal flow is
  // covered end-to-end by tempolock.spec.ts (deterministic pulse train →
  // tempolock → SCOPE pulse capture + TIMELORDE CLOCK IN follow) plus the
  // pure tracker suite. Handle-presence + input-drive still run here, and the
  // BEHAVIORAL sweep drives `in` and asserts the bpm rail moves.
  tempolock: 'all outputs input-conditional by design (silent until first lock; then sparse 10 ms clock pulses + DC bpm/locked levels); covered by tempolock.spec.ts + tempolock-tracker.test.ts',
  marbles:   'requires UI-enabled internal clock; covered by marbles-related specs',
  // ── CV/gate utility modules with no self-running source ──
  illogic:    'boolean logic on inputs; no upstream → no output; covered by illogic.spec.ts',
  // Moog batch-2 passive routers: like 994/995/984 (auto-skipped as audio
  // effect-shape) but with CV/gate ports, so the audio-only auto-skip misses
  // them. moog992 sums attenuated CV (silent w/o a driven cv input); moog993
  // routes triggers (silent w/o a driven trig input). Wiring + summing/routing
  // is pinned by moog992.test.ts / moog993.test.ts. Handle-presence +
  // input-drive still run here.
  moog992:    'passive CV summer/attenuator; output is input-conditional; covered by moog992.test.ts',
  moog993:    'passive trigger/envelope router; output is input-conditional; covered by moog993.test.ts',
  // Batch-5 input-conditional outputs: moog911a fires a brief delayed pulse only
  // after an input trigger (not in the generic emit window — timing in
  // trigger-delay-dsp.test.ts); moog962's output carries only the currently-
  // selected input (the sweep drives one input, not the selected one — selector
  // in moog962-dsp.test.ts).
  moog911a:   'trigger-delay; outputs are delayed pulses on an input trigger (input-conditional); covered by trigger-delay-dsp.test.ts',
  moog962:    'sequential switch; output carries only the selected input (input-conditional); covered by moog962-dsp.test.ts',
  // ── User-toggled sequencer-like sources ──
  score:     'requires play_cv high + steps; covered by score.spec.ts',
  // ── Button-press-driven instruments (silent until a key is pressed) ──
  bluebox:   'silent until a button is pressed; covered by bluebox.spec.ts which clicks the keys',
  // ── File-input modules ──
  // Each needs a real decoder pipeline (Web Codecs for video, AudioBuffer
  // decode for samples) that we don't bring up inside the sweep. The
  // dedicated specs build a small fixture file + seed via the card's
  // upload handler; signal-flow assertion lives there.
  samsloop:       'needs a decoded sample buffer AND a trigger to emit (idle-by-default, no autoplay); both covered by samsloop.spec.ts (upload + TRIGGER button → SCOPE)',
  twotracks:      'needs a recorded buffer to emit (idle until first record pass); signal-flow covered by twotracks.spec.ts (record → play → SCOPE RMS assert)',
  videobox:       'needs decoded video file (Web Codecs pipeline); covered by videobox.test.ts',
  videovarispeed: 'needs decoded video file + varispeed scrubber; covered by videovarispeed-output.spec.ts',
  // TV LIBRARIAN — every output (video/audio_l/audio_r + the channel_changed/
  // stream_online gates) needs a LIVE HLS stream tuned in (country picked →
  // channel selected → hls.js attached); the generic sweep brings up no network
  // stream (and we never hit live famelack/streams in CI). Same shape as
  // videobox. Pure data/geo cores are unit-tested + e2e mocks the dataset+HLS.
  tvLibrarian:    'needs a live tuned HLS stream for any output; no network stream in the sweep (mirrors videobox); covered by tv-librarian-data.test.ts + tv-librarian-geo.test.ts + network-mocked tv-librarian e2e',
  // PEERTUBE — every output (video/audio_l/audio_r + loaded/ended/playing gates +
  // playhead CV) needs a video resolved + attached (search → pick → HLS via
  // hls.js); the generic sweep resolves no network stream (and we never hit live
  // Sepia/instance/HLS in CI). Same shape as tvLibrarian/videobox. Pure cores are
  // unit-tested + e2e mocks Sepia + the stream.
  peertube:       'needs a resolved + attached PeerTube stream for any output; no network stream in the sweep (mirrors tvLibrarian/videobox); covered by peertube-query.test.ts + network-mocked peertube e2e',
  archivist:      'all outputs (image/video/audio/gates/playhead) are idle until an archive.org item loads (external network); covered by archivist-query.test.ts + archivist-scrub.test.ts + route-mocked archivist.spec.ts',
  // MILKDROP — the single `out` video needs the async preset chunk
  // (dynamic import of the butterchurn preset pack) loaded AND a few butterchurn
  // warmup frames before it emits a non-black frame; that exceeds the generic
  // ~2s emit window on CI. The deterministic non-black/structured render is
  // proven by milkdrop-render-smoke.spec.ts (it polls read('ready') for the
  // preset load, then drives fixed steps with synthetic audio + a fixed delta).
  milkdrop:       'video out needs the async preset chunk loaded + butterchurn warmup before it emits, exceeding the generic emit window; deterministic non-black render proven by milkdrop-render-smoke.spec.ts',
  // VIDEOCUBE now has EIGHT outputs — video_out + audio_out + SIX per-port-gated
  // slice-viz jacks (scope/slice/depth/smooth/morph/chaos). Sweeping each with a
  // fresh page-nav is the SwiftShader per-frame-WebGL→video-out-canvas timeout
  // class ×N (the exact reason the BEHAVIORAL sweep already whole-module-exempts
  // it), and it would add ~6 serial ~6–20 s navigations of pure CI wall-time. The
  // audio-derived jacks (audio_out, scope_out) are silent through the bare-spawn
  // budget (async worklet load + rings must fill), and the viz jacks are gated —
  // an unpatched jack renders nothing. ALL are covered by the dedicated
  // videocube.spec.ts (real 3-source chain → video_out non-blank + each viz jack
  // non-black-only-when-patched + slice_view/reader/Y·rot response + triptych
  // divergence + depth-brightness + audio_out RMS + scope-tracks-wave) plus the
  // pure CPU mirror videocube-core.test.ts and the factory seam videocube.test.ts.
  // Handle-presence still pins every output port here.
  videocube: 'video isomorph of audio CUBE with 8 outputs (video_out + audio drone + 6 per-port-gated slice-viz jacks); the video-out-canvas SwiftShader timeout class ×N + audio-derived/gated jacks; fully covered by videocube.spec.ts + videocube-core.test.ts + videocube.test.ts',
  // ── Game modules whose outputs ONLY fire on rare in-game events ──
  // MODTRIS line clears require ~10 piece drops + a full row filled;
  // PONG scores require a ball-miss after several bounces. Both exceed
  // the sweep's 2-second window, even at max gravity. The dedicated
  // specs simulate full games + drive scoring deterministically.
  modtris: 'line_cleared/overfill only fire after ~10 piece drops; covered by modtris-related specs (simulated)',
  pong:    'score_left/score_right only fire on ball-miss after bounces; covered by pong-related specs',
  // BLOOD — ⚠ REASON CORRECTED 2026-08-13 (#1497). The old reason ("data is
  // user-supplied, non-redistributable, gitignored, absent in CI — the engine
  // aborts in its resource loader") was false in every clause: the 1997
  // shareware set is COMMITTED (ADR-007), ci.yml materialises it into the
  // preview bundle these shards download, and the engine boots. The real reason
  // is BOOT COST vs this sweep's window: the dedicated specs allow 20–25 s for
  // `blood-ready` (a 5.9 MB ASYNCIFY WASM through the whole Build engine init)
  // and the sweep's emit window is ~2 s. After boot the engine sits in the MENU;
  // audio_l/audio_r only carry level music + SFX once something drives the menu
  // into a level (8 scancodes), which blood-audio-output.spec.ts does.
  blood: 'boot cost, not data: the bundled shareware IS committed + materialized on CI (docs/adr/007-game-asset-distribution.md), but reaching `blood-ready` takes the dedicated specs 20–25 s (5.9 MB ASYNCIFY WASM + full Build engine init) against this sweep\'s ~2 s emit window, and after boot the engine idles in the MENU until something drives it into a level; real coverage = blood-audio-output.spec.ts (menu→level→fire→SCOPE peak) + blood-ingame/blood-mount specs + blood-keys.test.ts',
  // ── Driver page.evaluate / postSpawn hangs ──
  // These modules' drivers time out under CI load — the per-output
  // serial loop (8 × 20 s, 7 × 20 s) exhausts the test budget before
  // all ports resolve. Handle-presence still asserts the ports exist.
  // ⚠ NINE, not eight: `poly` (polyPitchGate) landed after this reason was
  // written, so the entry understated its own cost. Still correct in substance.
  numpadPlus:  'driver page.evaluate hangs under CI load (9 outputs × 20s exceeds budget)',
  slewSwitch:  'driver setup hangs in CI (7 outputs × 20s exceeds budget)',
  // ── MIDICLOCK: clock/midistop pulses are too brief for the scope window ──
  // The MIDI-clock driver sends 0xF8 pulses but each pulse is a
  // single-frame gate (~0.7 ms at 120 BPM) and the SCOPE poll may
  // land between beats. Handle-presence still pins the ports.
  midiclock:   'clock/midistop pulses are sub-frame gates; scope polls miss the edge; covered by midiclock-related specs',
};

// ────────── Per-port output-emit exemptions ──────────
// Format: `<moduleType>.<portId>` → human-readable reason.
// These are SUBPORT exemptions on modules whose OTHER outputs DO emit —
// we want signal-flow assertions on the working ports + skip on the
// gameplay-conditional ones. Modules entirely covered by
// EXEMPT_OUTPUT_EMIT_MODULES belong THERE; this list is for the
// partial-skip cases.
//
// Keep this list tight too (~10-15 entries).
export const EXEMPT_OUTPUT_EMIT: Record<string, string> = {
  // SIX STRUM — a plucked-string voice, silent until struck. The output-emit is
  // covered by the IDENTICAL drive in the dedicated e2e/tests/sixstrum-poly.spec.ts
  // (SEQUENCER.gate → strum1 → SCOPE audible RMS + SEQUENCER.pitch → poly → RMS),
  // plus the worklet-wiring unit test (strum1/poly → audible). Handle-presence +
  // input-drive still run here.
  //
  // ⚠ THE ORIGINAL REASON FOR THIS EXEMPTION IS GONE, and the `why` below no
  // longer claims it. Driving sixstrum in the generic sweep needs a _drivers.ts
  // gatePort entry, and that append used to force a full collab re-attest
  // because _drivers.ts was a collab-attest basis file — the treadmill task #160
  // exists to kill. collab-attest was deleted 2026-08-17, so the append is now
  // free. This exemption is therefore PAYABLE and should be paid: add the
  // gatePort driver and delete this entry. It stayed in this PR only because
  // that changes what the sweep asserts, which does not belong in a CI-deletion
  // change.
  'sixstrum.out': 'plucked-string voice, silent-until-struck; covered by the same drive in sixstrum-poly.spec.ts (gate→strum1→RMS, pitch→poly→RMS) + worklet-wiring unit. PAYABLE: the _drivers.ts gatePort append that would retire this is no longer blocked by a collab re-attest',
  // ── OUTLINES.mapped is doubly input-conditional: it shows the `video` INPUT
  // wherever ≥2 shapes overlap, so it needs BOTH a patched video source AND a
  // ≥2-overlap region to land in the same sweep window. The driver wires
  // ACIDWARP → video + maxes diameter so overlap forms, but the exact ≥2 region
  // lining up with non-black source pixels inside the budget is timing-fragile.
  // OVERLAP / CONTOUR / COMBINE DO emit from the same driver (rate-clock spawns
  // overlapping shapes). The mapped path is covered deterministically by
  // e2e/tests/outlines.spec.ts (drives the video input + asserts mapped shows it
  // where overlapped) + the mappedMaskAt unit test (≥2 rule).
  'outlines.mapped': 'doubly input-conditional (video input AND a ≥2-overlap region within the window); covered by outlines.spec.ts + mappedMaskAt unit test',
  // ── MANDELBULB: audio_out is silent UNLESS the SLICE toggle is ON (default
  // OFF — the backwards-compat video-identity guarantee), and bringing it up
  // needs a worklet load + an off-thread bulb-slice scan that exceeds the
  // bare-spawn sweep budget. The PORT is still pinned by the handle-presence dim;
  // the slice→waveform→audio path is covered by the mandelbulb factory unit
  // tests (slice-on wiring posts a setWave) + the mandelbulb-osc worklet test.
  'mandelbulb.audio_out': 'silent until the SLICE toggle is ON (default off); covered by mandelbulb.test.ts (factory slice-on wiring) + mandelbulb-osc.test.ts',
  // (VIDEOCUBE is now WHOLE-MODULE exempt in EXEMPT_OUTPUT_EMIT_MODULES above —
  // its 8 outputs incl. the 6 slice-viz jacks are covered by videocube.spec.ts;
  // the former per-port 'videocube.audio_out' entry folded into that.)
  // ── DOOM: video out is fine BUT WASM init + game tic exceeds sweep budget;
  // audio + gate outputs are gameplay/forcePulse-conditional. Whole-module
  // skip is wrong because the module legitimately renders a video frame on
  // load, but the WASM startup window is long enough that whole-module skip
  // is the right call here too. Promote to MODULES for simpler bookkeeping.
  'doom.audio_l':   'WASM init + first SFX outside test budget; covered by video-audio-cvgate-coverage + doom-wasm specs',
  'doom.audio_r':   'WASM init + first SFX outside test budget; covered by video-audio-cvgate-coverage + doom-wasm specs',
  'doom.evt_kill':  'requires in-game enemy death; covered by video-audio-cvgate-coverage (forcePulse)',
  'doom.evt_door':  'requires in-game door trigger; covered by video-audio-cvgate-coverage (forcePulse)',
  'doom.evt_gun_p1': 'requires in-game weapon fire; covered by video-audio-cvgate-coverage (forcePulse)',
  'doom.evt_gun_p2': 'requires in-game weapon fire P2; covered by engine-bridge unit sweep',
  'doom.evt_gun_p3': 'requires in-game weapon fire P3; covered by engine-bridge unit sweep',
  'doom.evt_gun_p4': 'requires in-game weapon fire P4; covered by engine-bridge unit sweep',
  // feat/doom-per-type-death-gates: per-monster-type kill + per-player
  // death gates fire only on real game events (or forcePulse). The
  // engine-video-audio-bridge .each sweep proves every gate wires through
  // the dispatcher; doom-per-type-death-gates.spec.ts covers forcePulse
  // → SCOPE for a representative sample.
  'doom.evt_kill_zombieman':   'requires in-game zombieman kill; covered by engine-bridge unit sweep',
  'doom.evt_kill_shotguy':     'requires in-game shotgunner kill; covered by engine-bridge unit sweep',
  'doom.evt_kill_imp':         'requires in-game imp kill; covered by doom-per-type-death-gates (forcePulse)',
  'doom.evt_kill_demon':       'requires in-game demon kill; covered by doom-per-type-death-gates (forcePulse)',
  'doom.evt_kill_spectre':     'requires in-game spectre kill; covered by engine-bridge unit sweep',
  'doom.evt_kill_lostsoul':    'requires in-game lost-soul kill; covered by engine-bridge unit sweep',
  'doom.evt_kill_caco':        'requires in-game caco kill; covered by engine-bridge unit sweep',
  'doom.evt_kill_baron':       'requires in-game baron kill; covered by engine-bridge unit sweep',
  'doom.evt_kill_chainguy':    'requires in-game chaingunner kill (DOOM II only); covered by engine-bridge unit sweep',
  'doom.evt_kill_revenant':    'requires in-game revenant kill (DOOM II only); covered by engine-bridge unit sweep',
  'doom.evt_kill_mancubus':    'requires in-game mancubus kill (DOOM II only); covered by engine-bridge unit sweep',
  'doom.evt_kill_vile':        'requires in-game arch-vile kill (DOOM II only); covered by engine-bridge unit sweep',
  'doom.evt_kill_knight':      'requires in-game hell knight kill (DOOM II only); covered by engine-bridge unit sweep',
  'doom.evt_kill_pain':        'requires in-game pain elemental kill (DOOM II only); covered by engine-bridge unit sweep',
  'doom.evt_kill_arachnotron': 'requires in-game arachnotron kill (DOOM II only); covered by engine-bridge unit sweep',
  'doom.evt_kill_spidermind':  'requires in-game spider mastermind kill (DOOM II only); covered by engine-bridge unit sweep',
  'doom.evt_kill_cyber':       'requires in-game cyberdemon kill (DOOM II only); covered by engine-bridge unit sweep',
  'doom.evt_kill_wolfss':      'requires in-game wolf SS kill (DOOM II only); covered by engine-bridge unit sweep',
  'doom.evt_kill_keen':        'requires in-game commander keen kill (DOOM II only); covered by engine-bridge unit sweep',
  'doom.evt_p1_dies':          'requires in-game P1 death; covered by doom-per-type-death-gates (forcePulse)',
  'doom.evt_p2_dies':          'requires in-game P2 death; covered by engine-bridge unit sweep',
  'doom.evt_p3_dies':          'requires in-game P3 death; covered by engine-bridge unit sweep',
  'doom.evt_p4_dies':          'requires in-game P4 death; covered by engine-bridge unit sweep',
  'doom.out':       'WASM render loop > sweep budget; covered by doom-wasm.spec.ts',
  // (file-input + MIDI-driven + hardware-input modules with ALL outputs
  // exempt are listed in EXEMPT_OUTPUT_EMIT_MODULES above — fewer entries
  // here, clearer audit list.)
  // NIBBLES gameplay-conditional gates: only fire when the snake eats /
  // dies / turns mid-run. The default driver doesn't drive in-game events.
  // Covered by video-audio-cvgate-coverage.spec.ts via forcePulse().
  'nibbles.pellet':     'requires in-game pellet-eaten event; covered by video-audio-cvgate-coverage.spec.ts (forcePulse)',
  'nibbles.death':      'requires in-game death event; covered by engine-bridge unit sweep',
  'nibbles.dir_change': 'requires in-game direction change; covered by engine-bridge unit sweep',
  // NIBBLES `gated` is the snake oscillator passed through an internal
  // VCA that opens on `pellet` — silent until a pellet is eaten.
  'nibbles.gated': 'requires in-game pellet event to open internal VCA; covered by nibbles-related specs',
  // NIBBLES length_cv encodes snake length; at idle the snake has a
  // constant length so the CV is a steady DC value — but lengthToCv(4)
  // is below the SCOPE.ch1 peak floor (≈-0.93). When the snake eats /
  // dies, the value steps; only THEN does scope.ch1 read a delta.
  // Covered by video-audio-cvgate-coverage.spec.ts (NIBBLES.length_cv
  // → SCOPE with forcePulse) at a non-zero target value.
  'nibbles.length_cv': 'idle DC value ≈-0.93 is constant + within scope noise floor; covered by video-audio-cvgate-coverage.spec.ts',
  // ── BUGGLES partial: `clock` + `burst` gates fire at ~0.5 Hz, may
  // miss the 800ms scope window. The `smooth` + `stepped` CV outs and
  // `ring` audio out are continuous and assert reliably from the same
  // module-level test pass.
  'buggles.clock': 'gate fires at burst-rate (~0.5 Hz); test window can miss; covered by buggles-related specs',
  'buggles.burst': 'gate fires at burst-rate (~0.5 Hz); test window can miss; covered by buggles-related specs',
  // ── TIMELORDE partial: the slow per-bar dividers (1/8, 1/12, 1/16,
  // 1/32, 1/64) have periods of 1.6 s, 2.4 s, 3.2 s, 6.4 s, 12.8 s
  // respectively at our test BPM of 300. Even with a wide poll budget
  // that's too long to wait per-port for a sweep that already iterates
  // 13 outputs serially. The faster outputs (1x..1/4, swing) ARE
  // driven + asserted from the same TIMELORDE test, so the worklet's
  // output dispatch is covered + the per-divider math is unit-tested
  // in timelorde.test.ts.
  'timelorde.1/8':  'period 1.6 s @ test BPM 300; sweep budget 1.2 s; covered by timelorde-related specs',
  'timelorde.1/12': 'period 2.4 s @ test BPM 300; sweep budget 1.2 s; covered by timelorde-related specs',
  'timelorde.1/16': 'period 3.2 s @ test BPM 300; sweep budget 1.2 s; covered by timelorde-related specs',
  'timelorde.1/32': 'period 6.4 s @ test BPM 300; sweep budget 1.2 s; covered by timelorde-related specs',
  'timelorde.1/64': 'period 12.8 s @ test BPM 300; sweep budget 1.2 s; covered by timelorde-related specs',
  // ── ILLOGIC partial: the LOGIC outputs (and/nand/or/not) only fire
  // when their inputs cross specific threshold combinations. With
  // BUGGLES.smooth as a slow ±1V random walk on in1 and SEQUENCER.gate
  // as a 50%-duty gate on in2, the AND output requires BOTH > 0.5
  // simultaneously — a probabilistic alignment that can miss the test
  // window. The 6 NON-logic outputs (att1/2/3/4 + sum + diff) ARE
  // driven + asserted; the math half of the module is covered. The
  // logic half is unit-tested in illogic.test.ts with deterministic
  // input patterns.
  'illogic.and':  'AND fires only when in1 AND in2 both > 0.5; probabilistic alignment; covered by illogic.spec.ts',
  'illogic.nand': 'NAND inverse of AND; same probabilistic alignment; covered by illogic.spec.ts',
  'illogic.or':   'OR fires often but its complement NOT may miss; same shape; covered by illogic.spec.ts',
  'illogic.not':  'NOT inverse of in1>0.5; depends on bipolar BUGGLES range; covered by illogic.spec.ts',
  // ── MOOG CP3 partial: the ±reference trunk outs are CONSTANT DC rails
  // (+12V → +2.4, −6V → −1.2 normalized). The SCOPE.ch1 emit floor (0.005)
  // is a peak-above-noise check tuned for AC signals; a steady DC offset
  // isn't reliably read as "peak" by the analyser snapshot (it AC-couples).
  // These are STATIC reference sources by design — handle-presence pins
  // their existence + the DSP unit test asserts the exact constants. The
  // mixer outs (out_positive / out_negative) + the MULTIPLE (multiple_one/
  // two/three) ARE driven (NOISE.white → in1 via the per-port driver) +
  // asserted.
  'moogCp3.plus_twelve': 'constant +12V DC reference rail; static source (EXEMPT_OUTPUT_EMIT); exact value pinned by moog-cp3-dsp.test.ts',
  'moogCp3.minus_six':   'constant −6V DC reference rail; static source (EXEMPT_OUTPUT_EMIT); exact value pinned by moog-cp3-dsp.test.ts',
  // ── MIDI LANE partial: pitch_cv / gate / velocity_cv / cc_a / cc_b ARE
  // driven (per-port driver mocks requestMIDIAccess + sends a sustained
  // note-on + CC1/CC7), so the note + CC-tap path is asserted. The two
  // remaining outputs are conditional:
  //   * note_gate fires a single ~6 ms one-shot pulse on the selected MIDI
  //     note (default 36). Like MIDICLOCK's sub-frame clock gate, a single
  //     brief pulse sent once at postSpawn is below the scope poll window's
  //     resolution. The by-note → gate logic is asserted in the bespoke
  //     unit spec (midi-lane.test.ts: note 36 → note_gate pulse).
  //   * poly NOW carries the held chord in BOTH modes (#674 fix — the dedicated
  //     POLY port is always live). But a polyPitchGate→SCOPE edge routes lane-0
  //     PITCH (a steady DC V/oct from the sustained note), which the AC-coupled
  //     scope peak-floor can't read (same DC-rail shape as moogCp3 references).
  //     The chord allocation + always-live poly is unit-tested in
  //     midi-lane.test.ts, and the live POLY→synth→audio chain in
  //     adsr-poly-midilane.spec.ts + pentemelodica.spec.ts, so we keep the driver mono + exempt poly.
  // ── TRAILS partial: the twelve X/Y/gate jacks ARE driven in this sweep (see
  // the `trails` driver in _per-port-drivers.ts — a simulated Bela Trails
  // streams real 14-bit CC through the real decoder). `clock` is the one that
  // cannot be: it emits a 5 ms one-shot per division (the shared MIDICLOCK
  // GATE_PULSE_S), which is below the scope poll resolution — the identical
  // midiLane.note_gate / midiclock shape. The divider math + the pulse pair are
  // pinned in trails.test.ts against the factory's own automation timeline.
  'trails.clock': 'a 5 ms one-shot per division (the shared MIDICLOCK GATE_PULSE_S) is below the scope poll resolution, like midiLane.note_gate; divider math + the high/low pulse pair pinned by trails.test.ts',
  'midiLane.note_gate': 'single ~6 ms one-shot pulse below the scope poll resolution (like midiclock sub-frame gates); by-note→gate logic covered by midi-lane.test.ts',
  'midiLane.poly':      'poly is always live (#674) but a poly→SCOPE edge reads lane-0 PITCH (steady DC, AC-scope can\'t peak it); always-live behavior covered by midi-lane.test.ts + adsr-poly-midilane.spec.ts',
  // ── SKIFREE partial: the `gate` output fires ONLY on a crash / eaten-by-
  // yeti event, which requires the skier to actually hit terrain — random
  // obstacle spawns won't reliably land inside the sweep window. The `out`
  // video port renders the animated game canvas (no still frame; the bundle
  // self-drives via rAF), outside the sweep's deterministic sampling. Both
  // are covered by e2e/tests/skifree.spec.ts which drives the skier into a
  // crash (and an eat) via the controller's _forceCrash / _forceEaten hooks
  // and asserts the gate pulse reaches a downstream SCOPE.
  //
  // ⚠ THAT SENTENCE WAS TRUE AND SAID NOTHING ABOUT THE SHIPPING SURFACE, and
  // the `why` strings below now say so. `skifree.spec.ts` boots
  // `/rack?shell=legacy`, so until #2192 moved the game onto the NODE the cited
  // coverage existed only on a shell no player meets — and the hooks it drives
  // were the CARD's controller. Both halves are now node-owned, and
  // `skifree-face.spec.ts` asserts the same gate → SCOPE path on the DEFAULT
  // shell with the screen switched OFF, which is the state the sweep's own
  // exemption is really about.
  'skifree.gate': 'fires only on in-game crash/eaten event; covered by e2e/tests/skifree.spec.ts (_forceCrash/_forceEaten → gate → SCOPE, ?shell=legacy) AND e2e/tests/skifree-face.spec.ts (the same path on the DEFAULT shell, with SCREEN OFF)',
  'skifree.out':  'animated game canvas (rAF self-driven, no still frame); covered by e2e/tests/skifree.spec.ts + skifree.test.ts (CV→cursor + gate hook) + skifree-face.spec.ts (the surfaces that blit it)',
  // ── GIBRIBBON gameplay-conditional gates: evt_hit/miss/fire/kill/gameover
  // fire only on an in-game judgement (a correct ABXY press clears an event /
  // an uncleared event HITS the marine), which the generic sweep doesn't
  // orchestrate (it needs an ANALYSED AUDIO course plus button edges). The
  // video `out` port renders the white-ribbon line-art immediately and IS
  // driven by the sweep. The bespoke gibribbon.spec.ts drives the full path —
  // a real audio cable, the band-seam course, the death run — AND uses
  // forcePulse() to assert each gate reaches a downstream SCOPE deterministically.
  'gibribbon.evt_hit':      'fires only on an in-game clear; covered by gibribbon.spec.ts (forcePulse → SCOPE + full audio-course/button play)',
  'gibribbon.evt_miss':     'fires only when an uncleared event hits the marine; covered by gibribbon.spec.ts (forcePulse → SCOPE + the death-path run)',
  'gibribbon.evt_fire':     'fires only when the marine fires on an enemy clear; covered by gibribbon.spec.ts (forcePulse → SCOPE)',
  'gibribbon.evt_kill':     'fires only on an enemy death; covered by gibribbon.spec.ts (forcePulse → SCOPE)',
  'gibribbon.evt_gameover': 'fires only on GAME OVER; covered by gibribbon.spec.ts (forcePulse → SCOPE + the death-path run reaching dead)',
  // health_cv idles at a constant DC (healthy = 0.75); the SCOPE.ch1 emit
  // floor is an AC-peak check that AC-couples a steady DC offset away (same
  // shape as nibbles.length_cv / moogCp3 reference rails). Pinned by the pure
  // healthToCv() unit test + the bespoke spec asserts it MOVES on a miss.
  'gibribbon.health_cv':    'idle DC (healthy=0.75) is constant + AC-coupled below the scope floor; covered by gibribbon-engine.test.ts (healthToCv) + gibribbon.spec.ts',
};

// ─── DENY BY DEFAULT — the output-emit exemption lists are pinned KEY BY KEY ──
//
// EXEMPT_OUTPUT_EMIT_MODULES (whole-module) + EXEMPT_OUTPUT_EMIT (per-port) let
// a module/port OPT OUT of the per-port output-emit signal-flow assertion.
// Every entry is coverage we still owe, so every edit to either list has to be
// reviewed — which means every edit has to be VISIBLE and has to FAIL a gate.
//
// WHY A KEY LIST AND NOT A COUNT (changed 2026-08-03). These were COUNT
// ratchets: `Object.keys(…).length <= 43` and `<= 65`. Three failure modes,
// all three observed in this repo, and the first two were LIVE right here:
//
//   1. SLACK IS PRE-AUTHORISATION. The caps read 43 / 65 against an ACTUAL
//      40 / 63 — FIVE unreviewed exemption slots standing open. Under a cap
//      with slack, adding a missing-coverage exemption is GREEN and there is
//      nothing in the diff a reviewer is prompted to look at. The old cap
//      comments recorded four historical adds doing exactly that, verbatim:
//      "count 40 ≤ 43, fits within slack, no raise". Commit 72734704
//      (sixstrum.out) added an entry without touching the cap at all.
//   2. A NUMBER CANNOT MERGE-CONFLICT. Two PRs can each be green ALONE and RED
//      COMBINED — #1311 pinned a count against a tree that lacked a module,
//      #1308 added that module, and main went red twice in one day. A key LIST
//      collides textually, so git forces the reconciliation at rebase time
//      rather than on main.
//   3. A COUNT IS BLIND TO A SWAP. Delete one entry, add another: the length
//      is unchanged and a brand-new exemption lands in total silence.
//
// So both lists are pinned KEY BY KEY against a sorted frozen array AND
// ANCHORED TO THE ARTIFACT: every module key must still name a live REGISTRY
// module, and every per-port key a live OUTPUT port on that module. An
// exemption that outlives the thing it exempts is RED — a stale exemption is
// one nobody is watching.
//
// TO EDIT: change the map above AND the frozen array below in the SAME commit,
// then re-pin the generated ledger (`flox activate -- task test:ledger:accept`
// — scripts/test-ledger.mjs counts BOTH maps into
// docs/testing/test-ledger.generated.md, and a stale ledger is a hard red in
// the unit lane). Removing an entry is the good direction and is exactly as
// loud as adding one. That is the point: the gate has no opinion about the
// direction, only about whether a human looked.
//
// THIS TEST IS DELIBERATELY TOP-LEVEL — do NOT wrap it in a `test.describe`.
// The required e2e lane runs a `--grep-invert` that drops the collab and
// capacity tag families plus the BEHAVIORAL input-coverage sweep (ci.yml holds
// the literal pattern), and it shards by title — so an un-tagged, top-level
// title survives every filter. Nesting this under a describe that later picks
// up one of those tags would silently demote the gate to informational without
// changing one line of its body.
//
// The tag literals are not reproduced here, in prose or anywhere else in this
// file. That used to be load-bearing: the collab attest BASIS was resolved by
// grepping spec CONTENT for those two tokens in their sigil form (COLLAB_TAG_RE
// in scripts/collab-attest-lib.ts), so quoting them in a comment enrolled the
// file in the basis and made every future edit cost a re-attest. collab-attest
// was deleted 2026-08-17, so nothing greps for them now — writing them bare is
// still the house style, but it is no longer a constraint.
//
// SCOPE — what this gate is structurally UNABLE to see, stated here so a green
// run is not read as more than it is:
//   * The two AUTO-skips in the emit sweep below — the effect-shape heuristic
//     (an audio/video/image input ⇒ "needs an upstream") and
//     PURE_CV_GATE_UTILITY — exempt modules with NO list entry at all. They
//     are COMPUTED, not DECLARED, so nothing here can enumerate them.
//   * SKIP_SPAWN and EXEMPT_INPUT_DRIVE are separate lists and are not pinned
//     key-by-key (they are counted in the generated ledger only).
//   * Whether an entry's cited "covered by …" spec exists, or asserts what its
//     prose claims. The anchor proves the PORT is real; it proves exactly
//     nothing about the coverage the reason promises.

// The EXACT key set of EXEMPT_OUTPUT_EMIT_MODULES, sorted. Deliberate
// duplication: this array is the review surface and the merge-conflict surface.
export const PINNED_MODULE_EXEMPT_KEYS: readonly string[] = Object.freeze([
  'archivist', 'audioIn', 'blood', 'bluebox', 'cvBuddy', 'cvBuddyMini',
  'es9',
  'fader', 'featurecv', 'flipper', 'gamepad', 'illogic', 'joystick',
  'marbles', 'midiCvBuddy', 'midiOutBuddy', 'midiclock', 'milkdrop', 'modtris',
  'moog911a', 'moog956', 'moog962', 'moog992', 'moog993', 'numpadPlus',
  'peertube', 'pong', 'samsloop', 'score',
  'slewSwitch', 'synesthesia', 'tempolock', 'timelorde', 'tvLibrarian', 'twotracks',
  'videobox', 'videocube', 'videovarispeed', 'vstFx', 'vstInstrument',
]);

// The EXACT key set of EXEMPT_OUTPUT_EMIT, sorted. `<moduleType>.<outputPortId>`
// — split on the FIRST '.', which is what the sweep's `${mod.type}.${p.id}`
// lookup does (module types contain no dot; port ids may contain '/', e.g.
// 'timelorde.1/8').
export const PINNED_PER_PORT_EXEMPT_KEYS: readonly string[] = Object.freeze([
  'buggles.burst', 'buggles.clock',
  'doom.audio_l', 'doom.audio_r', 'doom.evt_door', 'doom.evt_gun_p1',
  'doom.evt_gun_p2', 'doom.evt_gun_p3', 'doom.evt_gun_p4', 'doom.evt_kill',
  'doom.evt_kill_arachnotron', 'doom.evt_kill_baron', 'doom.evt_kill_caco',
  'doom.evt_kill_chainguy', 'doom.evt_kill_cyber', 'doom.evt_kill_demon',
  'doom.evt_kill_imp', 'doom.evt_kill_keen', 'doom.evt_kill_knight',
  'doom.evt_kill_lostsoul', 'doom.evt_kill_mancubus', 'doom.evt_kill_pain',
  'doom.evt_kill_revenant', 'doom.evt_kill_shotguy', 'doom.evt_kill_spectre',
  'doom.evt_kill_spidermind', 'doom.evt_kill_vile', 'doom.evt_kill_wolfss',
  'doom.evt_kill_zombieman', 'doom.evt_p1_dies', 'doom.evt_p2_dies',
  'doom.evt_p3_dies', 'doom.evt_p4_dies', 'doom.out',
  'gibribbon.evt_fire', 'gibribbon.evt_gameover', 'gibribbon.evt_hit',
  'gibribbon.evt_kill', 'gibribbon.evt_miss', 'gibribbon.health_cv',
  'illogic.and', 'illogic.nand', 'illogic.not', 'illogic.or',
  'mandelbulb.audio_out',
  'midiLane.note_gate', 'midiLane.poly',
  'moogCp3.minus_six', 'moogCp3.plus_twelve',
  'nibbles.death', 'nibbles.dir_change', 'nibbles.gated', 'nibbles.length_cv',
  'nibbles.pellet',
  'outlines.mapped',
  'sixstrum.out',
  'skifree.gate', 'skifree.out',
  'timelorde.1/12', 'timelorde.1/16', 'timelorde.1/32', 'timelorde.1/64',
  'timelorde.1/8',
  'trails.clock',
]);

// ─── REACHABILITY LEDGER — entries that exist but can never be READ ───────────
//
// Anchoring "the key names a live port" is necessary but not sufficient: an
// entry can name a perfectly real port and still be DEAD CODE, because an
// earlier branch of the emit sweep already skipped the module. Those are stale
// in the sense that matters — nobody is watching them — while looking pristine
// to a name-only check. Found 2026-08-03 while replacing the caps; the audit
// that commissioned this work reported "0 of 63 keys are stale" and by its own
// definition (does the key resolve?) that was correct. Both are pinned so a
// NEW dead entry is RED, and so is a module leaving the whole-module list and
// silently resurrecting its per-port entries without a re-read.

// EXEMPT_OUTPUT_EMIT_MODULES is consulted BEFORE EXEMPT_OUTPUT_EMIT (see the
// `moduleExempt` branch in the emit sweep — it `test.fixme`s and `continue`s),
// so a per-port entry on an already-whole-module-exempt module is UNREACHABLE.
// ILLOGIC (4) and TIMELORDE (5) each carry both. Kept rather than deleted: if
// either module ever earns a driver and leaves the whole-module list, these
// ports go live again and each reason deserves a fresh review, not a silent
// resurrection.
export const PINNED_SHADOWED_PER_PORT_KEYS: readonly string[] = Object.freeze([
  'illogic.and', 'illogic.nand', 'illogic.not', 'illogic.or',
  'timelorde.1/12', 'timelorde.1/16', 'timelorde.1/32', 'timelorde.1/64',
  'timelorde.1/8',
]);

// The emit sweep `continue`s on `mod.outputs.length === 0` BEFORE it reads
// EXEMPT_OUTPUT_EMIT_MODULES, so a whole-module entry for an output-LESS module
// is documentation only (MIDI-OUT-BUDDY's own comment says exactly that — it is
// listed so the sweep records the intentional absence). Pinned so a SECOND one
// cannot appear unnoticed and be mistaken for real coverage bookkeeping.
export const PINNED_MODULE_EXEMPT_WITHOUT_OUTPUTS: readonly string[] = Object.freeze([
  'midiOutBuddy',
]);

test('output-emit exemption lists are pinned key-by-key and anchored to REGISTRY', () => {
  const modulesByType = new Map(REGISTRY.map((m) => [m.type, m]));
  const totalOutputPorts = REGISTRY.reduce((n, m) => n + m.outputs.length, 0);

  // ── 0. VACUITY FLOOR ──
  // Every assertion below is a lookup against REGISTRY. If REGISTRY resolved
  // nothing, "no key is stale" would be trivially true and this test would pass
  // while proving NOTHING — the RAW_PARAM_WRITE failure mode (a bracket-only
  // filter that saw 3 of 99 writes; every assertion it made was true). These
  // are sanity FLOORS, not ratchets: the tree carries ~195 modules / ~674
  // output ports, so they only trip if the manifest is empty or truncated.
  expect(
    REGISTRY.length,
    'VACUITY: REGISTRY resolved almost no modules — every anchor below would pass trivially. '
    + 'Run `flox activate -- task test:emit-manifest` (e2e/.generated/registry-manifest.json).',
  ).toBeGreaterThan(100);
  expect(
    totalOutputPorts,
    `VACUITY: REGISTRY declares ${totalOutputPorts} output ports across ${REGISTRY.length} modules — `
    + 'far too few for the anchor to be able to fail. The manifest emitter is broken.',
  ).toBeGreaterThan(300);

  // ── 1. SET EQUALITY — deny by default ──
  expect(
    Object.keys(EXEMPT_OUTPUT_EMIT_MODULES).sort(),
    'EXEMPT_OUTPUT_EMIT_MODULES no longer matches PINNED_MODULE_EXEMPT_KEYS. '
    + 'ADDING an exemption is missing coverage — justify it in the PR and add the key below. '
    + 'REMOVING one is coverage reclaimed — delete the key below too. '
    + 'Either way also re-pin the ledger: `flox activate -- task test:ledger:accept`.',
  ).toEqual([...PINNED_MODULE_EXEMPT_KEYS]);
  expect(
    Object.keys(EXEMPT_OUTPUT_EMIT).sort(),
    'EXEMPT_OUTPUT_EMIT no longer matches PINNED_PER_PORT_EXEMPT_KEYS. '
    + 'ADDING an exemption is missing coverage — justify it in the PR and add the key below. '
    + 'REMOVING one is coverage reclaimed — delete the key below too. '
    + 'Either way also re-pin the ledger: `flox activate -- task test:ledger:accept`.',
  ).toEqual([...PINNED_PER_PORT_EXEMPT_KEYS]);

  // ── 2. ARTIFACT ANCHOR — every key must still name something that exists ──
  // Ground truth is the REGISTRY module/port, not the list. A list entry that
  // outlives its port is RED.
  const moduleKeyIsLive = (moduleType: string): boolean => modulesByType.has(moduleType);
  const portKeyIsLive = (key: string): boolean => {
    const dot = key.indexOf('.');
    if (dot < 0) return false;
    const mod = modulesByType.get(key.slice(0, dot));
    if (!mod) return false;
    const portId = key.slice(dot + 1);
    return mod.outputs.some((p) => p.id === portId);
  };

  expect(
    Object.keys(EXEMPT_OUTPUT_EMIT_MODULES).filter((k) => !moduleKeyIsLive(k)),
    'STALE EXEMPTION: these EXEMPT_OUTPUT_EMIT_MODULES keys name modules that are no longer in '
    + 'REGISTRY. The module was renamed or deleted — delete the exemption (and re-pin the ledger).',
  ).toEqual([]);
  expect(
    Object.keys(EXEMPT_OUTPUT_EMIT).filter((k) => !portKeyIsLive(k)),
    'STALE EXEMPTION: these EXEMPT_OUTPUT_EMIT keys name a `<moduleType>.<outputPortId>` pair that '
    + 'no longer exists in REGISTRY (module gone, or the OUTPUT port was renamed/dropped). If the '
    + 'port was dropped deliberately, delete the exemption; if it was dropped by accident, that is '
    + 'the DOOM #393 bug class and the handle-presence sweep should also be red.',
  ).toEqual([]);

  // ── 3. PERMANENT NEGATIVE CONTROL, BOTH DIRECTIONS ──
  // Runs on EVERY execution, not once at authoring time. Without it, an anchor
  // that silently resolved nothing (wrong split, empty map, a refactor that
  // made the resolver return `true` unconditionally) prints the same empty
  // array as a genuinely clean tree — "no stale keys" and "never looked" are
  // indistinguishable from the output. So force both answers out of the same
  // resolvers the assertions above used.
  const liveModule = REGISTRY.find((m) => m.outputs.length > 0);
  expect(liveModule, 'NEGATIVE CONTROL: no REGISTRY module has an output port').toBeTruthy();
  const liveType = liveModule!.type;
  const livePort = liveModule!.outputs[0].id;

  expect(
    moduleKeyIsLive('__no_such_module__'),
    'NEGATIVE CONTROL (false leg): the module resolver called a non-existent module type LIVE — '
    + 'it accepts anything, so the stale-module assertion above is decoration.',
  ).toBe(false);
  expect(
    moduleKeyIsLive(liveType),
    `NEGATIVE CONTROL (true leg): the module resolver called the real module "${liveType}" STALE — `
    + 'it rejects everything, so it would have reddened on a clean tree.',
  ).toBe(true);
  expect(
    portKeyIsLive('__no_such_module__.out'),
    'NEGATIVE CONTROL (false leg, module half): the port resolver called a port on a non-existent '
    + 'module LIVE.',
  ).toBe(false);
  expect(
    portKeyIsLive(`${liveType}.__no_such_port__`),
    `NEGATIVE CONTROL (false leg, PORT half): the port resolver called "${liveType}.__no_such_port__" `
    + 'LIVE — it only checks the module and never looks at the port id, so a renamed port would '
    + 'never be caught.',
  ).toBe(false);
  expect(
    portKeyIsLive(`${liveType}.${livePort}`),
    `NEGATIVE CONTROL (true leg): the port resolver called the real port "${liveType}.${livePort}" `
    + 'STALE — it rejects everything, so the empty stale-list above proves nothing.',
  ).toBe(true);

  // ── 4. REACHABILITY LEDGER — an entry that can never be READ is also stale ──
  const shadowed = Object.keys(EXEMPT_OUTPUT_EMIT)
    .filter((k) => EXEMPT_OUTPUT_EMIT_MODULES[k.slice(0, k.indexOf('.'))])
    .sort();
  expect(
    shadowed,
    'UNREACHABLE EXEMPTION: these per-port EXEMPT_OUTPUT_EMIT entries sit on a module that is ALSO '
    + 'whole-module exempt. The emit sweep reads EXEMPT_OUTPUT_EMIT_MODULES first and skips the '
    + 'whole test, so these reasons are never consulted. If the list SHRANK, a module just left '
    + 'EXEMPT_OUTPUT_EMIT_MODULES and its per-port entries are live again — RE-READ each reason '
    + 'before updating this pin. If it GREW, prefer one whole-module entry over N per-port ones.',
  ).toEqual([...PINNED_SHADOWED_PER_PORT_KEYS]);

  const exemptWithoutOutputs = Object.keys(EXEMPT_OUTPUT_EMIT_MODULES)
    .filter((t) => modulesByType.get(t)?.outputs.length === 0)
    .sort();
  expect(
    exemptWithoutOutputs,
    'UNREACHABLE EXEMPTION: these EXEMPT_OUTPUT_EMIT_MODULES entries name modules with ZERO output '
    + 'ports. The emit sweep `continue`s on an empty output list BEFORE it reads the exemption, so '
    + 'the entry is documentation only and buys no coverage bookkeeping. Intentional for '
    + 'midiOutBuddy (it emits MIDI to external gear); anything else here is a mistake.',
  ).toEqual([...PINNED_MODULE_EXEMPT_WITHOUT_OUTPUTS]);
});

// ────────── Per-port input-drive exemptions ──────────
// Format: `<moduleType>.<portId>` → human-readable reason.
// These inputs DECLARE themselves but their downstream effect from a
// generic upstream source isn't reachable inside the sweep. The wire-up
// check (edge materialises + no console errors) still runs for every
// non-exempt port; exemptions skip even THAT minimal step (e.g. the
// upstream source isn't compatible enough to wire under canConnect).
//
// Most of these are DOOM's deep-WASM keyboard ports: wiring a SEQUENCER
// gate to them IS expected to work (edge lands clean), but the in-game
// consequence isn't visible to the sweep — for that we rely on
// e2e/tests/doom-keyboard-routing.spec.ts. Keep them OUT of the
// exemption list so the sweep DOES pin "the input port wires up".
export const EXEMPT_INPUT_DRIVE: Record<string, string> = {
  // ── TOYBOX: the two VIDEO inputs (inA / inB) only drive the output when a
  // LAYER selects that port as its source (layer.videoSource = 'inA'|'inB').
  // The default patch's layers select NEITHER, so a feed patched into inA/inB
  // with no layer pointing at it is a CORRECT no-op — the sweep's edge-lands
  // check would wire ACIDWARP.out in fine, but there's nothing downstream to
  // observe and asserting a visible effect would be vacuous. Handle-presence
  // (the rendered inA/inB handles) + inputs-accept (no console errors during
  // wire-up) still cover the ports for free; the patched-feed → layer-FBO flow
  // is covered by the dedicated e2e/tests/toybox-video-inputs.spec.ts (selects
  // a layer's source = In A/In B and asserts the FBO shows the feed).
  'toybox.inA': 'video input only drives output when a layer selects it as its source; default patch selects neither (correct no-op); covered by toybox-video-inputs.spec.ts',
  'toybox.inB': 'video input only drives output when a layer selects it as its source; default patch selects neither (correct no-op); covered by toybox-video-inputs.spec.ts',
};

// ────────── Type-aware upstream sources for input drive ──────────
//
// Maps an input port `type` → a SpawnNode + edge fragment that drives it.
// Sources are chosen to be self-running (no further upstream needed) so
// the sweep's wire-up step is uniform across types.
export type InputSource = {
  // SpawnNode to add upstream (id, type, domain).
  node: SpawnNode;
  // Output port id on the upstream source.
  outPort: string;
  // Cable type for the edge.
  sourceType: string;
  // Optional second node (e.g. SEQUENCER for gate, since SEQUENCER's
  // `gate` is the only self-clocking gate source in the registry that
  // doesn't need its own clock). Spawned alongside `node` when present.
  extraNode?: SpawnNode;
};

/**
 * Pick a self-running upstream source compatible with the given input
 * port type. Returns null if no source maps cleanly — caller adds the
 * port to EXEMPT_INPUT_DRIVE or rethinks the design.
 *
 * Sources are deliberately MINIMAL (no params needed to emit):
 *   audio  → NOISE.white               (~white noise, self-running)
 *   cv     → BUGGLES.smooth            (slow random CV, self-running)
 *   pitch  → BUGGLES.smooth            (cv-family interchanges per
 *                                       canConnect)
 *   gate   → SEQUENCER.gate            (240 BPM gate train; needs the
 *                                       sequencer to also be in the
 *                                       graph — supplied via extraNode)
 *   video  → ACIDWARP.out              (self-running video source, no
 *                                       inputs required)
 *   mono-video → RASTERIZE.out         (needs an audio input — supplied
 *                                       via extraNode NOISE)
 *   image  → (none — no self-running STILL source exists; mono-video
 *             does NOT widen into image, that is a motion reduction)
 *   polyPitchGate → SEQUENCER.pitch    (the only self-running ppg source)
 */
export function pickInputSource(inputType: string, idPrefix: string): InputSource | null {
  switch (inputType) {
    case 'audio':
      return {
        node: { id: `${idPrefix}-noise`, type: 'noise', position: { x: 60, y: 60 }, domain: 'audio', params: { level: 0.6 } },
        outPort: 'white',
        sourceType: 'audio',
      };
    case 'cv':
    case 'pitch':
    case 'modsignal':
      // BUGGLES.smooth is a self-clocking CV source (no clock input
      // required), ranges ±5V, perfect for proving "input accepts cv".
      // A `modsignal` input (TOYBOX's 6-input modulation section) accepts
      // cv/gate/audio; cv is the canonical driver here.
      return {
        node: { id: `${idPrefix}-buggles`, type: 'buggles', position: { x: 60, y: 60 }, domain: 'audio' },
        outPort: 'smooth',
        sourceType: 'cv',
      };
    case 'gate':
      // SEQUENCER.gate emits a gate train when isPlaying=1. The extraNode
      // pattern keeps spawnPatch's contract (one nodes array, one edges
      // array) intact while letting this function return a "logical
      // source" with its own dependencies.
      return {
        node: { id: `${idPrefix}-seq`, type: 'kria', position: { x: 60, y: 60 }, domain: 'audio', params: { bpm: 240, running: 1} },
        outPort: 'gate',
        sourceType: 'gate',
      };
    case 'video':
      return {
        node: { id: `${idPrefix}-acid`, type: 'acidwarp', position: { x: 60, y: 60 }, domain: 'video' },
        outPort: 'out',
        sourceType: 'video',
      };
    case 'mono-video':
      // RASTERIZE needs an audio input; the extraNode supplies one.
      return {
        node: { id: `${idPrefix}-rast`, type: 'rasterize', position: { x: 280, y: 60 }, domain: 'audio' },
        outPort: 'out',
        sourceType: 'mono-video',
        extraNode: { id: `${idPrefix}-noiseR`, type: 'noise', position: { x: 60, y: 60 }, domain: 'audio', params: { level: 0.6 } },
      };
    // `image` deliberately has NO entry — see the doc block above. It used to
    // reuse the mono-video source "because image upcasts from mono-video",
    // which is false and always was: mono-video is ANIMATED and image is
    // STILL, so that is a reduction on the motion axis and `canConnect`
    // refuses it (#1780). Unreachable today (no def declares an `image`
    // input), so nothing ever failed — but it would have built a forbidden
    // edge the first time one appeared. `null` is the loud path.
    case 'polyPitchGate':
      return {
        node: { id: `${idPrefix}-seq`, type: 'kria', position: { x: 60, y: 60 }, domain: 'audio', params: { bpm: 240, running: 1} },
        outPort: 'pitch',
        sourceType: 'polyPitchGate',
      };
    default:
      return null;
  }
}

// ────────── Sink picker for output emit ──────────
//
// Pick a type-appropriate canonical sink for an output port. SCOPE.ch1
// is the universal audio-domain sink (audio/cv/gate via the cross-domain
// bridge — see #414); VIDEOOUT.in is the universal video-domain sink.
// Pitch outputs land on SCOPE.ch1 too (the SCOPE accepts cv-family on
// ch1 unmodified, the analyser reads the DC offset).
export type SinkSpec = {
  node: SpawnNode;
  inPort: string;
  /** sourceType to declare on the edge (matches the producer port's
   *  type). Targets are always 'audio' for SCOPE or 'video' for OUTPUT
   *  per canConnect's downcast rules. */
  targetType: string;
};

export function pickOutputSink(outputType: string): SinkSpec | null {
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

// ────────── DOOM-asset gating ──────────

export async function doomAssetsPresent(page: Page): Promise<{ wasm: boolean; wad: boolean }> {
  return await page.evaluate(async () => {
    let wasm = false, wad = false;
    try { wasm = (await fetch('/doom/doom.js', { method: 'HEAD' })).ok; } catch { /* ignore */ }
    try { wad  = (await fetch('/doom/DOOM1.WAD', { method: 'HEAD' })).ok; } catch { /* ignore */ }
    return { wasm, wad };
  });
}

// ────────── Page-side edge enumeration ──────────

/** Read the materialised edges from the patch graph. Used by the input
 *  drive check to confirm that the edge we just inserted is still
 *  present after the engine has processed it (engine.addEdge could
 *  conceivably drop an edge silently if the source/target node wasn't
 *  ready — that's the #414 bug class repackaged). */
export async function readEdgeIds(page: Page): Promise<string[]> {
  return await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch?: { edges: Record<string, { id: string }> };
    };
    return Object.keys(w.__patch?.edges ?? {});
  });
}

// ────────── Tests ──────────


// Console-error policy lives in `_page-errors.ts` — ONE definition shared with
// the behavioral sweep and gibribbon.spec.ts.
//
// It used to be a private copy here whose fifth clause was an unconditional
// `!e.includes('Failed to load resource')`. That single line blinded every test
// below to a module that FAILS TO LOAD: the `inputs accept signal` dim's other
// assertion reads the patch store, so an edge materialises whether or not the
// engine behind it ever came up, and (measured 2026-08-12) 58 module types have
// no other live per-port dimension at all. A 404'd worklet was therefore a
// GREEN row. The replacement records `location().url` and exempts by NAMED,
// gitignore-anchored resource; `_page-errors.ts` carries the measurement, the
// stated scope, and the re-derivation command.

// ────────── Heavy-WebGL module predicate ──────────
//
// "Heavy WebGL" = the module mounts the VideoEngine's GL pipeline, which is
// the thing that's brutally slow on CI's SwiftShader software renderer and
// drives the recurring per-port shard flake class (mandleblot/mandelbulb
// timeouts, wavesculpt "peak=0, polls=1" — the heavy 3D mount eats the
// wall-clock budget so the emit poll is cancelled mid-sample).
//
// A module touches the video pipeline if it has ANY video output OR ANY
// video / mono-video INPUT port — NOT just if `domain === 'video'`. This
// distinction is load-bearing: WAVESCULPT is registered `domain: 'audio'`
// (its primary L/R taps are audio) yet mounts a full 3D cube GL viewport via
// its wall1..wall6 video inputs + video_out output, so a `domain === 'video'`
// gate would miss it (and any future audio-domain module with a viewport).
// Keying on the actual video PORTS catches every current + future heavy-GL
// card generically — no per-module allow-list to keep in sync.
export function touchesVideo(mod: RegistryModule): boolean {
  return (
    mod.hasVideoOutput ||
    mod.outputs.some((p) => p.type === 'video' || p.type === 'mono-video') ||
    mod.inputs.some((p) => p.type === 'video' || p.type === 'mono-video')
  );
}

// ────────── The heavy-GL budget: a TAX that ADDS, not a floor that SWALLOWS ──
//
// WHAT WAS WRONG (main, run 30791843249 / PR #1319 shard 8). This was
//
//     Math.max(90_000, perPortScaled)
//
// which reads as "scaled, with a floor" and BEHAVED as a flat constant. At the
// wire-up call site the scaled term is `inputs * 2_000 + 30_000`, so the floor
// only stops binding at **31 inputs**. MEASURED against the live registry:
// **74 of the 78 touchesVideo modules are under that crossover**, so 95 % of
// the sweep got the identical 90 000 ms — a 3-input module and a 26-input
// module were budgeted the same.
//
// That is worse than an honest constant, because it DEFEATS REVIEW: the
// formula reads as though someone had already priced per-port cost, so nobody
// re-derives it. It is the same shape as the ratchets audited on 2026-08-02 —
// a filter applied before the check that quietly redefines the check's subject.
//
// The module it hurt most is the one that went red. `wavesculpt` has 26 inputs
// → derives 82 000 → floored back up to 90 000, i.e. **8 000 ms of its own
// scaling silently discarded**, and it is the largest module below the
// crossover. (videocube loses 16 000; b3ntb0x / grainsOfVision / quadralogical
// lose 22 000 each.)
//
// WHY ADDITIVE IS THE HONEST MODEL, not a bigger number. The 90 000 was never
// a port-count budget at all. The modules it was calibrated on are small:
// foxy has 5 inputs, mandelbulb 10, mandleblot 1. It prices the COLD
// SwiftShader first-paint / shader-compile mount, which is a fixed per-TEST
// cost that does not care how many ports the module has. So it belongs on the
// BASE, added to the per-port term — not maxed against it, which throws the
// per-port term away.
//
// THE CONSTANT IS PRESERVED, NOT RAISED. `HEAVY_GL_MOUNT_MS` is pinned by the
// requirement that a heavy-GL module with ZERO ports still budget exactly the
// historical 90 000 (30_000 base + 0 + 60_000). Every module's budget is
// therefore >= what it gets today, with equality at zero ports — asserted
// below, so this cannot silently become a loosening.
export const HEAVY_GL_MOUNT_MS = 60_000;

export function heavyVideoTimeout(perPortScaled: number): number {
  return perPortScaled + HEAVY_GL_MOUNT_MS;
}

/** Base cost of ONE per-port test: nav + spawn + fixed setup, port count aside. */
export const PER_PORT_BASE_MS = 30_000;
/** Marginal cost of ONE more wired input on the wire-up sweep. */
export const PER_INPUT_MS = 2_000;

/**
 * The wire-up sweep's budget for a heavy-GL module with `inputs` inputs.
 *
 * The per-input term is LIVE AT EVERY PORT COUNT — the crossover is 0, where it
 * used to be 31. That is the whole change; `heavyVideoBudgetCrossoverInputs`
 * below computes it from these constants rather than restating it, so it cannot
 * drift out of the comment.
 */
export function wireUpBudgetMs(inputs: number): number {
  return heavyVideoTimeout(inputs * PER_INPUT_MS + PER_PORT_BASE_MS);
}

/** The OLD budget, kept only so the gates can prove nothing shrank. */
export function legacyWireUpBudgetMs(inputs: number): number {
  return Math.max(90_000, Math.max(45_000, inputs * PER_INPUT_MS + PER_PORT_BASE_MS));
}

/**
 * The LARGEST input count still sitting on a budget's flat floor — i.e. the
 * width of its dead zone. The per-port term starts binding at this value **+ 1**.
 *
 * STATED AS CODE, not prose, because the defect this replaces was invisible
 * precisely because the crossover was never written down: a reader could not
 * tell at a glance whether the scaling was live for the modules they cared
 * about. 0 means every port pays. The old budget returned **30** — inputs 0
 * through 30 all got the identical 90 000 ms, and scaling began at 31.
 */
export function budgetFlatUntilInputs(budget: (inputs: number) => number, limit = 200): number {
  for (let i = 0; i < limit; i++) if (budget(i + 1) > budget(i)) return i;
  return limit;
}

// ────────── Heavy-WebGL render suppression ──────────
//
// The handle-presence + inputs-accept sweeps assert at the graph/DOM level
// only (a Svelte-Flow handle element; a materialised edge in the patch
// store). For heavy WebGL video modules the card's GL pipeline renders an
// expensive frame on every rAF tick while we wire inputs one-by-one — pure
// waste here, and brutal on CI's SwiftShader software renderer (b3ntb0x's
// 4-pass float NTSC pipeline used to time out at 144s wiring 19 cables).
//
// This installs a page-scoped flag, BEFORE the app boots, that
// VideoEngine.step() reads to skip its per-frame draw passes (the bridge
// ticks + every module's GL draw) while still mounting cards, rendering
// handles, and reconciling edges. Scoped to these sweeps only: nothing in
// production or any pixel-asserting spec (bespoke video specs, VRT,
// behavioral) sets it, so those keep rendering real pixels.
//
// addInitScript runs at document_start on every navigation for this page,
// so a single call covers the spawnPatch re-navigations the inputs-accept
// loop performs.
export async function freezeVideoRender(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (globalThis as unknown as { __videoEngineFreezeRender?: boolean })
      .__videoEngineFreezeRender = true;
  });
}

// Helper: spawn a module solo (the canonical handle-presence + emit
// setup), with a separate `extraNodes` / `extraEdges` for the upstream-
// source or downstream-sink wiring.
export async function spawnSolo(
  page: Page,
  mod: RegistryModule,
  extraNodes: SpawnNode[] = [],
  extraEdges: SpawnEdge[] = [],
): Promise<void> {
  const driver = driverFor(mod);
  const nodes: SpawnNode[] = [
    {
      id: 'sut',
      type: mod.type,
      position: { x: 400, y: 60 },
      domain: mod.domain,
      params: driver.params,
    },
    ...extraNodes,
  ];
  await spawnPatch(page, nodes, extraEdges);
}

// ────────── DIM 1: handle presence ──────────
//
// Every declared port renders a handle. ONE test per module — the bulk
// approach gives a clear failure message ("module X expected port Y but
// it's missing") without exploding the shard count.


// ── emit-budget helpers ───────────────────────────────────────────────────
// Moved here because the heavy-GL BUDGET describe (now in -inputs) and the
// outputs sweep BOTH call them. Leaving them beside one describe would have
// made the split a cross-file reference, which is exactly how it first broke:
// `ReferenceError: emitBudgetMs is not defined`.
export const NOT_EFFECT_DESPITE_AUDIO_INPUT = new Set([
      'foxy',     // out_l/out_r ring at default tune=0
      'wavetableVco',
      'swolevco',
      // MOOG 921 VCO — a self-running oscillator: its four waveform jacks
      // ring at default settings (C4) with no upstream. The audio-typed
      // lin_fm / sync inputs are OPTIONAL modulation, not a required source.
      'moog921Vco',
      // MOOG 921B — slave VCO (batch 1). Like the 921 VCO it self-runs: with
      // freq_bus unpatched the worklet reads 0 V/oct → C4 and width_bus normals
      // to 0.5 (square), so all four waveform jacks (sine/triangle/saw/rect)
      // ring at default fine=0 / range=0 / level=1. The audio-typed dc_mod /
      // ac_mod / sync inputs are OPTIONAL modulation (linear-FM + sync), not a
      // required source — so it takes the normal outputs-emit path.
      'moog921b',
      // MOOG 904A VCF — an effect (audio in → low-pass out), BUT its
      // REGENERATION self-oscillates: the per-port driver seeds
      // regeneration=1 so the ladder rings as a VC sine generator with no
      // upstream, making its `audio` output a driven signal we can assert
      // (slice-1-style driven-signal check). Without the driver it would be
      // silent at default regeneration=0.
      'moog904a',
      // ANALOG VCO — self-running oscillator: saw/square/triangle/sine/morph
      // ring at C4 with no upstream and `sync` (sync_out) pulses once per
      // cycle. Its audio-typed fm / pm / sync inputs are OPTIONAL modulation,
      // not a required source — so the outputs-emit sweep (incl. the new
      // sync_out) applies, same as moog921Vco / wavetableVco.
  'analogVco',
]);

/** Pure CV/gate modulator with NO audio/video output AND at least one cv/gate
 *  INPUT — arithmetic / logic / clock-divider utilities whose outputs are
 *  functions of their inputs. Without an upstream the outputs are deterministic
 *  but typically 0 V / gate low, indistinguishable from "wire dead" via the
 *  scope-peak smoke. Covered by the dedicated specs at their respective names;
 *  per-port EXEMPT_OUTPUT_EMIT entries catch the slivers, this catches shape. */
export const PURE_CV_GATE_UTILITY = new Set([
  'analogLogicMaths', 'fourplexer', 'unityscalemathematik',
  'cartesian', 'frogger',
]);

export function emitSkipReason(mod: RegistryModule): string | null {
  if (mod.outputs.length === 0) return 'no outputs';
  if (SKIP_SPAWN[mod.type]) return SKIP_SPAWN[mod.type]!;

  // If a per-port driver registers extra setup for this module (upstream graph,
  // seeded params, seeded data, page init, post-spawn event dispatch), it is
  // SUPPLYING what the effect needs — bypass both effect-shape skips. (Example:
  // VIDEOOUT has a video input but the VIDEOOUT driver wires ACIDWARP.out into
  // it, so the .out passthrough becomes assertable. POLYSEQZ has cv inputs but
  // the driver seeds isPlaying=1 + steps so it self-runs.)
  const ppDriverModule = perPortDriverFor(mod.type);
  const hasDriverSetup = !!(
    ppDriverModule
    && (ppDriverModule.upstream || ppDriverModule.params || ppDriverModule.data || ppDriverModule.pageSetup || ppDriverModule.postSpawn)
  );

  // Effect-shape skip: modules whose primary path is "audio/video in →
  // audio/cv/gate/video out" (filters, reverbs, delays, mixers, SCOPE
  // passthrough, video-domain compositors) can't emit anything without an
  // upstream source. The dedicated specs cover their outputs against real
  // sources; here we'd just re-assert the bare-spawn-emits-silence trivial
  // case. Mirrors the same heuristic in per-module.spec.ts. (Many MI Eurorack
  // ports — RINGS, ELEMENTS, WARPS — also fall in this bucket.)
  const hasUpstreamMediaInput = mod.inputs.some(
    (p) => p.type === 'audio' || p.type === 'video' || p.type === 'mono-video' || p.type === 'image',
  );
  if (hasUpstreamMediaInput && !NOT_EFFECT_DESPITE_AUDIO_INPUT.has(mod.type) && !hasDriverSetup) {
    return 'effect-shape (audio/video input — needs upstream source); covered by dedicated specs';
  }
  if (PURE_CV_GATE_UTILITY.has(mod.type) && !hasDriverSetup) {
    return 'pure CV/gate utility (output = f(inputs); needs upstream CV/gate); covered by dedicated specs';
  }

  // Module-level explicit exempt (file-input, MIDI-driven, hardware,
  // clock-divider, user-toggled sequencer, etc.).
  if (EXEMPT_OUTPUT_EMIT_MODULES[mod.type]) return EXEMPT_OUTPUT_EMIT_MODULES[mod.type]!;

  // If ALL of the module's outputs are exempt at the per-port level, skip the
  // whole test (handle-presence already pins them).
  if (mod.outputs.every((p) => EXEMPT_OUTPUT_EMIT[`${mod.type}.${p.id}`])) {
    return 'all outputs exempt — see EXEMPT_OUTPUT_EMIT';
  }
  return null;
}

/** Outputs the emit sweep actually visits — the ones it does NOT `continue` past. */
export function liveEmitOutputs(mod: RegistryModule): number {
  return mod.outputs.filter((p) => !EXEMPT_OUTPUT_EMIT[`${mod.type}.${p.id}`]).length;
}

/**
 * Marginal cost of ONE more visited output on the emit sweep.
 *
 * WAS 20 000 ms, and the old accumulator stacked a SECOND scaled term under it
 * (`outputs > 8 → outputs × 5 000 + 30 000`) that the first one always
 * swallowed — the same floor-under-a-floor shape #1327 removed from the wire-up
 * site. One term now, so the number is reviewable.
 *
 * WHY 5 000. MEASURED end-to-end against the PREVIEW bundle (what CI serves —
 * `E2E_USE_PREVIEW=1`, not the dev server) under `E2E_SWIFTSHADER=1`:
 *
 *   clipplayer  24 outputs   6.3 s total   → ~0.26 s per output
 *   foxy         5 outputs  10.5 s total   → ~2.1 s per output (heavy-GL)
 *   midiLane     5 outputs   1.5 s total   → ~0.30 s per output
 *
 * 5 000 ms per output is ~19× the measured cost on the widest module and ~2.4×
 * on the most expensive per-port one, on top of a 30 000 ms base that already
 * carries the cold first navigation (~1.8 s measured) and, for heavy-GL, the
 * 60 000 ms mount tax. For reference the worst renderer penalty this repo has
 * ever measured is 7.6× (backdraft PURE TV, #1214), and that is a per-FRAME GL
 * number — the emit sweep's cost is dominated by navigation and engine boot,
 * not by frames.
 */
export const PER_OUTPUT_MS = 5_000;

/**
 * The worst per-NAVIGATION cost the emit sweep has been MEASURED at, for a
 * heavy-GL module, ON CI UNDER REAL SHARD LOAD.
 *
 * From the #1984 trace (freezeframe, shard 8/10, SwiftShader, preview bundle):
 * its five navigations cost 20.6, 21.9, 23.9, 24.2 and ~24.7 s. Each is a full
 * `goto` → engine boot → spawn of the SUT's GL chain (ACIDWARP → FREEZEFRAME →
 * VIDEOOUT) → canvas read, with the GL draw running throughout.
 *
 * ⚠ This is a CI-UNDER-LOAD number and is ~10× the per-output figures quoted on
 * `PER_OUTPUT_MS`, which were measured with ONE worker on a developer machine
 * and on modules whose outputs read a SCOPE. Do not reconcile the two by
 * picking the smaller — they measure different plans on different hardware.
 */
export const MEASURED_HEAVY_EMIT_NAV_MS = 24_700;

/**
 * What each ADDITIONAL navigation costs a heavy-GL module on the emit sweep.
 *
 * 35 000 ms = 1.42× `MEASURED_HEAVY_EMIT_NAV_MS`. The first navigation is not
 * charged this — it keeps the full `HEAVY_GL_MOUNT_MS` cold-mount tax, which is
 * 2.4× the measured navigation and covers first-paint shader compilation.
 *
 * WHY NOT SIMPLY 60 000 (the cold tax, per navigation). Because the shard
 * envelope will not carry it: the widest heavy-GL emit plans (`foxy` and
 * `freezeframe`, 5 live outputs each) would budget 355 s, and the gate prices
 * the worst plan across `ATTEMPTS = 2` against half the 20-minute shard job —
 * 710 s against a 600 s ceiling, RED. At 35 000 the worst plan is 255 s → 510 s,
 * 85 % of that ceiling. The remaining headroom is deliberate: the gate's own
 * message says the fix for a plan that no longer fits is a CHEAPER PLAN, not a
 * bigger job timeout, and the cheaper plan is real but out of scope here — see
 * the follow-up named in #1984 (freeze the GL draw during the SETUP phase of
 * each iteration and unfreeze only for the pixel read; ~19 s of every 24.7 s
 * navigation is main-thread starvation from a draw nothing is observing yet).
 */
export const HEAVY_GL_RENAV_MS = 35_000;

/**
 * The emit sweep's budget for ONE module — the SINGLE definition, used by the
 * test that spends it and by the shard-envelope gate that prices it.
 *
 * The gate used to keep its own hand-rolled copy of the accumulator. Two copies
 * of a formula is one drift away from a gate that certifies a number nothing
 * uses; anchoring both here is the same fix as `emitSkipReason` above.
 *
 * Returns 0 for a module whose emit test does not exist, so "the worst plan"
 * means the worst plan that RUNS.
 */
export function emitBudgetMs(mod: RegistryModule): number {
  if (emitSkipReason(mod)) return 0;
  const live = liveEmitOutputs(mod);
  if (live === 0) return 0;
  const scaled = live * PER_OUTPUT_MS + PER_PORT_BASE_MS;
  // ANY module that mounts the VideoEngine GL pipeline (touchesVideo: a video
  // port on either side, NOT just domain === 'video') pays the heavy-GL mount
  // tax — its per-pixel first paint on CI's SwiftShader software renderer is
  // far slower than a real GPU (ci-swiftshader-video-e2e-timeouts). Keying on
  // the video PORT rather than the domain field catches WAVESCULPT
  // (domain: 'audio' + a 3D cube viewport) with zero per-module maintenance.
  //
  // NOTE: the emit sweep does NOT freezeVideoRender — unlike the handle-presence
  // and inputs-accept sweeps (DOM-only asserts), it reads real pixels off the
  // VIDEOOUT canvas for video-typed outputs, so the GL draw must keep running.
  //
  // The old explicit `doom → max(scaled, 90_000)` floor is GONE because it can
  // no longer bind: doom is touchesVideo, and a heavy-GL module with even ONE
  // live output already budgets 5 000 + 30 000 + 60 000 = 95 000 > 90 000. That
  // is asserted in the gate below rather than asserted about here.
  if (!touchesVideo(mod)) return scaled;
  // ── THE MOUNT TAX IS PER NAVIGATION, NOT PER TEST (#1984) ──────────────────
  //
  // `HEAVY_GL_MOUNT_MS` describes itself as "a fixed per-TEST cost that does not
  // care how many ports the module has". That is TRUE at the wire-up call site
  // and FALSE here, and the constant was calibrated there and reused verbatim.
  //
  // The two sweeps have opposite SHAPES:
  //   * wire-up (-inputs): ONE `page.goto` before the loop, and it calls
  //     `freezeVideoRender`. The GL pipeline mounts once, then never draws.
  //   * emit (-outputs): `page.goto` INSIDE the loop — a deliberate fresh
  //     navigation per output so a previous iteration's sticky audio source
  //     cannot turn a dead port green — and it never freezes. So EVERY visited
  //     output re-mounts the whole GL chain on SwiftShader and keeps it drawing.
  //
  // Charging a per-navigation cost once per test makes the budget per navigation
  // COLLAPSE as the output count rises — the opposite of what the cost does:
  //
  //     1 live output  → 95 000 ms budget → 95 s per navigation
  //     5 live outputs → 115 000 ms       → 23 s per navigation
  //
  // MEASURED (#1984), freezeframe, CI shard 8/10 under load, SwiftShader,
  // E2E_USE_PREVIEW=1 — TWO traces, on OPPOSITE SIDES of the #1971 merge that
  // touched freezeframe.ts, which is what rules out a code regression:
  //
  //   PR #1983 (freezeframe.ts PRE-#1971):  20.6 21.9 23.9 24.2 ~24.8 s  (mean 23.1)
  //   PR #1969 (freezeframe.ts POST-#1971): 22.7 24.2 22.2 22.7 ~24.0 s  (mean 23.2)
  //
  // Same cost either side, so #1971 is not implicated: its 19 deleted lines are
  // all inside the def's `face:` object (a `hero.readouts` pair), and this sweep
  // navigates to `?shell=legacy`, which does not render a faceplate at all.
  //
  // In both, the test needed ~116 s against a 115 s budget and expired on the
  // FIFTH of five iterations. NOT a hang — no step stalled in either trace, and
  // every action completed with an ordinary duration; the plan is simply priced
  // below its own cost. The two sightings differ only in luck: #1983 squeaked
  // under on its retry (reported `flaky`), #1969 missed on both attempts
  // (reported `failed`). One boundary, two samples — not an escalation.
  //
  // ⚠ Do NOT read a leak into this. The cost drifts up ~20 % across #1983's five
  // navigations and is FLAT across #1969's, so "each fresh page leaks the
  // previous GL context" is NOT established by these two traces. If a
  // super-linear term is ever needed, measure it first.
  //
  // So the first navigation keeps the full cold-mount tax and each ADDITIONAL
  // navigation pays `HEAVY_GL_RENAV_MS`. Two properties this shape has on
  // purpose:
  //   * it is ADDITIVE and non-negative, so NO module's budget shrinks — a flake
  //     fix must never tighten a budget that is currently passing;
  //   * equality at ONE live output (30 000 + 5 000 + 60 000 = 95 000, exactly
  //     today's number), mirroring `wireUpBudgetMs`'s equality-at-zero-ports
  //     invariant, so this cannot be a silent loosening of the calibrated case.
  // Both are asserted in the gate in `per-module-per-port-inputs.spec.ts`.
  return heavyVideoTimeout(scaled) + (live - 1) * HEAVY_GL_RENAV_MS;
}

// Re-exported so the three split spec files have ONE import site for everything
// the shared prelude already pulls in — they never import these directly, which
// keeps the dependency surface of the split identical to the original file's.
export { spawnPatch } from './_helpers';
export type { SpawnNode, SpawnEdge } from './_helpers';
export { observeScopePeak, runFor, readEmitDiagnostics, formatEmitDiagnostics } from './_module-coverage-helpers';
export { collectPageErrors } from './_page-errors';
export { REGISTRY } from './_registry';
export type { RegistryModule, RegistryPort } from './_registry';
export { driverFor } from './_drivers';
export { perPortDriverFor } from './_per-port-drivers';
export type { Page } from '@playwright/test';

// e2e/vrt/vrt-exemptions.ts
//
// Single source of truth for "modules that intentionally don't ship a
// VRT baseline (yet, or by design)". Consumed by:
//   * e2e/vrt/vrt.spec.ts                              — to derive the
//     MODULES list from the registry minus this set, so new modules
//     auto-enrol in VRT unless explicitly listed here.
//   * packages/web/src/lib/audio/modules/vrt-meta.test.ts
//                                                      — to assert that
//     every registered module is either covered or exempted.
//
// Each entry needs a reason + (where applicable) the alternative test
// that covers the same surface. Reasons are surfaced in test output and
// the vrt-meta self-test enforces length > 10 so "TODO" placeholders
// can't sneak in.
//
// Per-module-card MASK config also lives here, keyed by module type.
// Masks fill non-deterministic regions (animated canvas, scope sweep,
// camera frames) with a uniform colour in both baseline + actual
// before pixel-diff, so the chrome around the canvas still asserts.

export interface MaskRect {
  selector: string;
}

/** Modules that ship a VRT baseline today and may need region masks.
 *  Modules with an entry in VRT_SCENES (see e2e/vrt/vrt-scenes.ts) get
 *  their mask SKIPPED at capture time — the scene drives the canvas
 *  with deterministic content and the post-spawn AudioContext freeze
 *  keeps the rendered pixels stable across runs, so the canvas is
 *  included in the diff (catches rendering regressions). */
export const VRT_MODULE_MASKS: Record<string, MaskRect[]> = {
  // SCOPE: covered by VRT_SCENES — the scene drives a 261 Hz sine in,
  // then freezes the audio so the trace is pixel-stable. Mask entry
  // intentionally absent (vrt.spec.ts ignores the mask map for
  // scene-driven modules anyway, but keeping the table accurate).
  // WAVVIZ / SWOLEVCO carry a video-out preview canvas.
  wavviz: [{ selector: 'canvas' }],
  swolevco: [{ selector: 'canvas' }],
  // WARRENSPECTRUM has the acidwarp video viz canvas.
  warrenspectrum: [{ selector: 'canvas' }],
  // SAMSLOOP — loop-based WAV sample player. The waveform canvas is
  // static after upload, but unloaded shows "NO SAMPLE LOADED" text —
  // mask the canvas so the chrome diffs deterministically.
  samsloop: [{ selector: 'canvas' }],
  // ----- video domain — every video module renders a preview canvas;
  // mask it and assert the chrome around it.
  lines: [{ selector: 'canvas' }],
  videoOut: [{ selector: 'canvas' }],
  inwards: [{ selector: 'canvas' }],
  picturebox: [{ selector: 'canvas' }],
  destructor: [{ selector: 'canvas' }],
  chroma: [{ selector: 'canvas' }],
  luma: [{ selector: 'canvas' }],
  colorizer: [{ selector: 'canvas' }],
  feedback: [{ selector: 'canvas' }],
  videoMixer: [{ selector: 'canvas' }],
  shapes: [{ selector: 'canvas' }],
  monoglitch: [{ selector: 'canvas' }],
  // RESHAPER (formerly RUTTETRA): coord-remap; canvas masked (flat content
  // when X/Y/Z unpatched).
  reshaper: [{ selector: 'canvas' }],
  // RUTTETRA: authentic forward-scatter scope. Its canvas is INCLUDED in
  // the diff via the VRT scene (SHAPES → RUTTETRA) so the baseline proves
  // real 3D scanlines, not a flat quad. The scene auto-overrides this mask
  // (vrt.spec.ts: `mod.type in VRT_SCENES ? [] : masks`), kept here as the
  // no-scene fallback.
  ruttetra: [{ selector: 'canvas' }],
  shapedramps: [{ selector: 'canvas' }],
  vdelay: [{ selector: 'canvas' }],
  // 4PLEXVID carries a live OUT-1 preview canvas; mask it so the
  // deterministic chrome (4 selector knobs + handle rows) diffs while the
  // live render is excluded. (Kept here for the follow-up baseline; the
  // module is currently in EXEMPT_FROM_VRT below — promote it into MODULES
  // when the darwin/linux PNGs are captured.)
  '4plexvid': [{ selector: 'canvas' }],
};

/** Modules intentionally skipped from VRT entirely. Each entry needs a
 *  ≥10-char reason — the vrt-meta self-test enforces this. */
export const EXEMPT_FROM_VRT: Record<string, string> = {
  // 4PLEXVID — 4-in/4-out video router. Card carries a live OUT-1 preview
  // canvas; the rest is static chrome (4 discrete selector knobs + handle
  // rows). VRT baseline pending platform-specific capture. Functional
  // coverage: e2e/tests/4plexvid.spec.ts (proves each output shows its
  // SELECTED input, gate rising-edge advances + wraps, outputs are
  // independent) + the plex-select unit suite (selector-advance + gate
  // edge-detect). Promote into MODULES + capture darwin/linux PNGs (the
  // canvas mask above masks the live preview) in a follow-up PR.
  '4plexvid': 'VRT baseline pending; e2e/tests/4plexvid.spec.ts + plex-select unit tests provide coverage. Promote + capture darwin/linux baselines (live preview masked) in a follow-up PR.',
  // CAMERA renders a live MediaStream into a canvas. Even with the
  // fake-camera flag the synthetic frame is non-deterministic enough
  // (frame-time clock) that the baseline would flap. Functional coverage
  // is e2e/tests/camera-input.spec.ts.
  cameraInput: 'live MediaStream defeats deterministic capture',
  // GROUP is a Phase-1 collapse-N-modules container with no engine
  // binding. A bare GROUP! has no exposed ports → its visual surface
  // is just the card chrome + label, which carries no module-specific
  // pixels worth fingerprinting. Functional coverage is
  // e2e/tests/grouping-phase1.spec.ts.
  group: 'no-op render until exposed-ports are set by Create-Group; e2e covers the full flow',
  // CLOUDS first-slice PR (#166): VRT baseline pending; ART + unit + E2E
  // provide coverage. Promote into MODULES + capture baselines on both
  // platforms in a follow-up PR.
  clouds: 'VRT baseline pending; ART + unit + E2E provide coverage.',
  // MACSEQ — VRT baseline pending. Functional coverage is e2e/tests/macseq.spec.ts
  // which proves the headline MACSEQ→MACROOSCILLATOR MODELCV wiring works.
  // A follow-up PR will capture the darwin + linux pixel baselines.
  macseq: 'VRT baseline pending; e2e/tests/macseq.spec.ts covers MODELCV wiring',
  // RINGS first-slice PR: VRT baseline pending; ART + unit + E2E
  // provide coverage. Linux baseline is darwin-only for v1; a
  // follow-up PR will capture both platforms and promote into MODULES.
  rings: 'VRT baseline pending; ART + unit + E2E provide coverage. Linux baseline is darwin-only for v1.',
  elements: 'No custom visualization — card is standard Fader controls (like rings). ART + unit tests provide DSP coverage.',
  // PEAKS first-slice PR: VRT baseline pending; ART + unit + E2E provide
  // coverage. Promote into MODULES + capture baselines on both platforms
  // in a follow-up PR.
  peaks: 'VRT baseline pending; ART + unit + E2E provide coverage.',
  // TIDES2: the card is plain knobs + mode buttons (no custom canvas
  // visualization), so a VRT scene adds no signal over the unit pass that
  // pins the four-output DSP math. Capture a baseline only if a future PR
  // adds a slope-preview scope to the card.
  tides2: 'Card has no custom visualization (knobs + mode buttons); unit tests pin the DSP. No VRT scene needed.',
  // MARBLES / SYMBIOTE first-slice PR: plain fader cards (no custom canvas
  // viz), so VRT adds little; unit tests cover the DSP cores. Promote +
  // capture baselines in a follow-up PR.
  marbles: 'VRT baseline pending; standard fader card; unit tests cover the DSP core.',
  symbiote: 'VRT baseline pending; standard fader card; unit tests cover the DSP core.',
  // WARPS first-slice PR: VRT baseline pending; ART + unit + E2E provide
  // coverage. Promote into MODULES + capture baselines on both platforms
  // in a follow-up PR.
  warps: 'VRT baseline pending; ART + unit + E2E provide coverage.',
  // VEILS quad-VCA: VRT baseline pending; ART + unit + E2E provide coverage.
  veils: 'VRT baseline pending; ART + unit + E2E provide coverage',
  // ATTENUMIX simple mixer: VRT baseline pending; ART + unit + E2E cover it.
  // 4 attenuator faders + master + standard PatchPanel — no unique visual
  // surface beyond what VEILS already exercises; baseline can be promoted
  // in a follow-up. Same rationale as VEILS.
  attenumix: 'VRT baseline pending; ART + unit + E2E provide coverage',
  // CLOUDSEED first-slice PR: VRT baseline pending; complex card (4 panels
  // + bottom mix + preset bar). ART + unit + E2E provide coverage. Promote
  // into MODULES + capture darwin/linux baselines in a follow-up PR.
  cloudseed: 'VRT baseline pending; complex card; ART + unit + E2E provide coverage.',
  // LIVECODE is a CodeMirror editor card with no ports. Cursor blink +
  // syntax highlight transitions make baselines flap. Functional
  // coverage is e2e/tests/livecode.spec.ts + the JS-runtime unit suite.
  livecode: 'CodeMirror caret + syntax-highlight transitions defeat deterministic capture; e2e + unit tests cover behavior',
  // CLOCKED runner — same CodeMirror caret issue as LIVECODE.
  clockedRunner: 'CodeMirror caret + dynamic status (fires-since-mount counter) defeat deterministic capture; e2e + unit tests cover behavior',
  // HELM is a dense polyphonic synth card (~720px wide, multi-row knob
  // grid + 16-step pattern + gear-icon-toggled settings panel). Baseline
  // would need to capture both the main panel and the settings panel
  // separately, and the settings panel state depends on MIDI device list
  // (which is non-deterministic on a fresh CI runner). ART + unit + E2E
  // provide functional coverage; promote to MODULES in a follow-up PR
  // once we have a way to stub the MIDI device list deterministically.
  helm: 'VRT baseline pending; complex dense card + MIDI-dependent settings panel; ART + unit + E2E provide coverage.',
  // MIDI-CV-BUDDY card body depends on connected MIDI device (which
  // doesn't exist under VRT) — the "Connect MIDI…" empty state would
  // be the only deterministic baseline, and even that paints differently
  // once the user has previously granted permission. Functional coverage
  // is e2e/tests/midi-cv-buddy.spec.ts.
  midiCvBuddy: 'card content depends on connected MIDI device; unit + E2E provide coverage',
  // MIDICLOCK: same rationale as midiCvBuddy — pre-Connect state shows a
  // "Connect MIDI…" button (deterministic) but post-connect the device list
  // depends on hardware that isn't present in CI. Unit + E2E (mock-MIDI smoke)
  // provide coverage.
  midiclock: 'card content depends on connected MIDI device; unit + E2E provide coverage',
  // PONG research prototype: animated game state (ball moving) defeats a
  // deterministic single-frame baseline. Unit + ART + E2E provide coverage
  // until either (a) a deterministic-time test harness is added so VRT can
  // freeze the ball at a known position, or (b) the prototype is promoted
  // out of research/.
  pong: 'animated game state defeats deterministic capture; unit + ART + E2E provide coverage',
  // MODTRIS research prototype: same rationale as PONG.
  modtris: 'animated game state defeats deterministic capture; unit + ART + E2E provide coverage',
  // FROGGER research prototype: sprite-tick advances every ~10 ms of game-
  // time + the start_gate auto-fire on first tick produces a moving frame
  // by the time Playwright snapshots. Same rationale as PONG / MODTRIS;
  // unit + E2E provide coverage. Promote to a real VRT baseline once a
  // deterministic-time test hook is added so the scene can freeze the
  // game at a known tick.
  frogger: 'animated sprite motion (cars/logs/turtles) + auto-start defeat deterministic single-frame capture; unit + E2E provide coverage',
  // ANALOGLOGICMATHS first-slice PR: VRT baseline pending; ART + unit + E2E
  // provide coverage. Card is small (2 attenuverter knobs + patch panel) and
  // stable; a follow-up PR will capture darwin + linux baselines once the
  // user has dogfooded any UI tweaks.
  analogLogicMaths: 'VRT baseline pending; ART + unit + E2E provide coverage. UI is stable but new — pinning baselines in a follow-up PR.',
  // BENTBOX — CRT-emulation OUTPUT. Frame feedback + per-line sync jitter
  // animated by uTime defeats a deterministic single-frame baseline.
  bentbox: 'animated CRT simulation (feedback + per-line time drift) defeats deterministic capture; unit + E2E provide coverage',
  // ACIDWARP — 320×240 plasma with rotating palette + auto scene cycler.
  // Both rotation and scene-advance are time-driven; deterministic capture
  // is impossible without freezing the engine clock. Pattern/palette unit
  // coverage in acidwarp-patterns.test.ts; integration coverage via E2E.
  acidwarp: 'animated palette rotation + auto scene cycler defeats deterministic capture; unit + E2E provide coverage',
  // JOYSTICK first-slice PR: card is small + simple (XY pad + four CV
  // ports), VRT baseline pending. Unit + E2E provide coverage.
  joystick: 'VRT baseline pending; unit + E2E provide coverage. UI is small + stable — pinning baselines in a follow-up PR.',
  // GAMEPAD — card content depends on the connected controller's live
  // state (stick dot positions, button LEDs, trigger fill bars), all
  // changing at rAF rate. A deterministic baseline would need to stub
  // navigator.getGamepads(), out of scope here. Unit + E2E cover the
  // def shape + helper functions; the live path is per-user.
  gamepad: 'card content driven by live navigator.getGamepads() poll; defeats deterministic capture. Unit + E2E cover the def + helpers.',
  // NUMPAD+ — card has a current-step highlight box + REC ARM pulse
  // animation that animates whether the sequence is running or not.
  // Functional coverage via the e2e spec; pinning baselines pending.
  numpadPlus: 'live step-highlight box + REC ARM animation defeat deterministic capture; unit + E2E provide coverage',
  // ATLANTIS-PATCH support trio. VRT baselines pending; the demo
  // patch itself is the integration test.
  slewSwitch: 'VRT baseline pending — first-slice ATLANTIS-PATCH module; unit + Atlantis-patch E2E provide coverage',
  atlantisCatalyst: 'card has a live scene-countdown + pulsing NUDGE button; capture is non-deterministic. Unit covers the def + pure helpers; Atlantis E2E covers the wired-up patch',
  aquaTank: 'VRT baseline pending — first-slice ATLANTIS-PATCH module; unit covers def shape, Atlantis-patch E2E covers the wired-up FDN',
  // WAVESCULPT: previously VRT-exempt (animated 3D render + CRT feedback
  // defeated single-frame capture). The alpha-rotate bugfix PR adds a
  // deterministic render-freeze hook (globalThis.__wavesculptVrtFreeze →
  // card pins time/wave-phase/field-parity) so it now has a real VRT
  // scene (see vrt-scenes.ts: wavesculpt) capturing the ALPHA layer at a
  // non-zero rotation. No longer exempt.
  // HYDROGEN first-slice PR: card is a wide 16-row × 16-step pattern grid +
  // transport row + per-row mute/solo. No canvas / animation — the chrome
  // is static once the playhead is parked at step 0 — but the baseline
  // needs to be captured on both platforms; promote into MODULES in a
  // follow-up PR.
  hydrogen: 'VRT baseline pending; unit + ART + E2E provide coverage. Promote into MODULES + capture darwin + linux pngs in a follow-up PR.',
  // DELAY first-slice PR (PR #228): simple 3-fader card
  // (time / feedback / mix); baseline pending platform-specific
  // capture. Unit + E2E cover the module-def shape + the
  // delay-line topology assertions.
  delay: 'VRT baseline pending; unit + E2E provide coverage.',
  // DOOM — live game-loop framebuffer defeats deterministic capture
  // by definition; the WASM blob's per-frame contents depend on
  // wall-clock + input queue history. Unit suites cover the TS shim
  // (doom-runtime, doom-presence, cv-gate-edge); a multi-tab e2e for
  // host migration + spectator-frame relay is the follow-up.
  doom: 'live game-loop framebuffer defeats deterministic capture; unit suites cover TS shim + presence + CV-gate edge detector',
  // CALLSINE first-slice PR: VRT baseline pending; unit + ART + E2E
  // provide coverage. Card is a standard 6-fader layout (model + 5
  // continuous macros) — pinning baselines in a follow-up PR after
  // any UI tweaks.
  callsine: 'VRT baseline pending; unit + ART + E2E provide coverage. Standard 6-fader card — pinning baselines in a follow-up PR.',
  // VIDEOBOX — live <video> element + animated drop-target border + a
  // playhead readout that ticks at 100ms. Same rationale as CAMERA: the
  // moving frame defeats single-shot pixel capture. Unit suites cover
  // the module-def shape (videobox.test.ts) + the playhead-sync drift
  // math (videobox-sync.test.ts); E2E spawn smoke covers card render.
  videobox: 'live <video> element + ticking playhead readout defeat deterministic capture; unit + sync-math + per-module spawn smoke provide coverage',
  // VIDEOVARISPEED — sibling of VIDEOBOX: a live <video> element streamed
  // via rVFC at a varying (varispeed) cadence, plus a ticking playhead
  // readout. Both defeat deterministic single-frame capture, same as
  // VIDEOBOX / CAMERA. Unit suites cover the module-def shape
  // (videovarispeed.test.ts) + the varispeed transport math
  // (videovarispeed-transport.test.ts); e2e (videovarispeed-output.spec.ts)
  // covers the wired-up output path + spawn smoke covers card render.
  videovarispeed: 'live <video> element streamed at varispeed + ticking playhead readout defeat deterministic capture; unit + transport-math + e2e output spec + per-module spawn smoke provide coverage',
  // CHROMAKEY — new 2-input compositor; card chrome is static but baseline
  // capture pending. Unit + E2E (video-controls.spec.ts) provide coverage.
  // Promote into MODULES + capture darwin/linux baselines in a follow-up PR.
  chromakey: 'VRT baseline pending; unit + E2E provide coverage. Promote into MODULES + capture darwin/linux baselines in a follow-up PR.',
  // LUMAKEY — new 2-input compositor; same rationale as CHROMAKEY.
  lumakey: 'VRT baseline pending; unit + E2E provide coverage. Promote into MODULES + capture darwin/linux baselines in a follow-up PR.',
  // CHROMA — v3 reshape (this PR) changed the card layout + stripe colour
  // entirely (was a 5-fader mask-extractor; now a 3-fader hue-shifter +
  // tint swatch). Old baselines were deleted; regenerate via
  // `task vrt:update` on each platform in a follow-up PR.
  chroma: 'VRT baseline pending — v3 reshape (PR feat/keyers-and-restore-chroma-luma) deleted obsolete baselines; regenerate via `task vrt:update` on each platform.',
  // LUMA — v2 reshape (this PR) same rationale as CHROMA above.
  luma: 'VRT baseline pending — v2 reshape (PR feat/keyers-and-restore-chroma-luma) deleted obsolete baselines; regenerate via `task vrt:update` on each platform.',
  // GRIDS — fader + button card (no custom visualization), so VRT adds
  // little over the unit + spawn-smoke coverage. Baseline pending; promote
  // into MODULES + capture darwin/linux baselines in a follow-up PR.
  grids: 'VRT baseline pending; standard fader/button card (no custom viz). Unit tests (grids.test.ts) + per-module spawn smoke provide coverage. Capture darwin/linux baselines via `task vrt:update` in a follow-up PR.',
  // 4PLEXER — first-slice PR. The card is fully deterministic (4 discrete
  // selector knobs at default positions + static input/output readouts, no
  // canvas / animation), so it is a good VRT candidate; baselines are
  // pending a `task vrt:update` run on each platform (the worktree this PR
  // was authored in lacks the faustwasm toolchain needed to boot the full
  // dev server for capture). Unit (def shape + pure selector-advance) + E2E
  // (4plexer.spec.ts: routing + per-output gate advance + wrap + audio/cv
  // sources) provide functional coverage; promote into MODULES once the
  // darwin + linux pngs are captured.
  fourplexer: 'VRT baseline pending — deterministic card (4 selector knobs, no canvas); capture via `task vrt:update` on each platform. Unit + E2E (routing + gate-advance + wrap + audio/cv) provide coverage.',
};

/** Per-(platform, type) baselines intentionally missing while a follow-
 *  up CI capture lands the other platform's PNG. The exempted pair is
 *  SKIPPED at the test level rather than allowed to fail. */
export const EXEMPT_BASELINE_PAIRS = new Set<string>([
  'linux/macrooscillator',
  'linux/samsloop',
  'linux/blades',
  'linux/stages',
  // SCOPE: this PR re-captures the darwin baseline with deterministic
  // audio content (via VRT_SCENES). The linux baseline still shows the
  // old magenta-masked canvas — a follow-up `task vrt:update` run on
  // linux will re-capture, then this entry comes out.
  'linux/scope',
  // VIDEO-OUT: this PR re-captures the darwin baseline with a real,
  // frozen VIDEOBOX frame driven through the output (via VRT_SCENES) to
  // prove the VIDEOBOX -> VIDEO-OUT path renders video content. VP9
  // decode isn't bit-identical across platforms, so the linux baseline
  // is pending a `task vrt:update` run on linux CI; the hard non-black +
  // moving gate is e2e/tests/videobox-output.spec.ts.
  'linux/videoOut',
  // RASTERIZE (crossing-the-streams slice 1): the darwin baseline is
  // captured on this machine via VRT_SCENES (261 Hz sine → raster banding,
  // frozen on AudioContext suspend). The linux baseline is pending a
  // `task vrt:update` run on linux CI — raster pixel values can differ
  // sub-thresholdly across the AudioContext sine-table + analyser refill
  // timing per platform, so we capture darwin here and defer linux.
  'linux/rasterize',
  // RESHAPER (renamed from RUTTETRA): the darwin baseline is captured on
  // this machine (canvas masked — coord-remap shows flat content when
  // unpatched). Linux baseline pending a `task vrt:update` run on linux CI.
  'linux/reshaper',
  // RUTTETRA (new authentic forward-scatter scope): darwin baseline
  // captured here via VRT_SCENES (SHAPES → RUTTETRA), proving real 3D
  // scanlines. WebGL line-rasterization isn't bit-identical across GPUs/
  // platforms, so the linux baseline is pending a `task vrt:update` run on
  // linux CI.
  'linux/ruttetra',
  // WAVESCULPT (alpha-rotate bugfix): darwin baseline captured on this
  // machine via VRT_SCENES (ALPHA layer at rot=0.45, deterministic
  // render-freeze hook). The linux baseline is pending a `task vrt:update`
  // run on linux CI — WebGL ribbon AA + CRT post differs sub-thresholdly
  // across GPU drivers, so we capture darwin here and defer linux.
  'linux/wavesculpt',
  // BACKDRAFT (video feedback generator): darwin baseline captured on this
  // machine via VRT_SCENES (SHAPES sources → frozen feedback tunnel/spiral,
  // params.freeze=1 holds the accumulator). The spatial-transform feedback
  // loop + WebGL bilinear sampling differs sub-thresholdly across GPU
  // drivers, so the linux baseline is pending a `task vrt:update` run on
  // linux CI; the deterministic darwin capture is the regression gate here.
  'linux/backdraft',
  // LFO (DEPTH knob added): the card grew a knob row + DEPTH input port, so
  // the darwin baseline is re-captured here. The linux baseline is pending a
  // `task vrt:update` run on linux CI (this dev machine is darwin-only).
  'linux/lfo',
  // COCOA DELAY (Cocoa Delay GPL-3.0 port): darwin baseline captured on this
  // machine (static knob/fader/dropdown card — no canvas/animation, so it's
  // deterministic). The linux baseline is pending a `task vrt:update` run on
  // linux CI (sub-pixel text AA differs across platforms); darwin is the
  // regression gate here.
  'linux/cocoadelay',
  // FOXY (hybrid SWOLEVCO→RASTERIZE→XYZ→live-wavetable→WAVECEL): darwin
  // baseline captured on this machine via VRT_SCENES (self-driving internal
  // chain, frozen on AudioContext suspend). The pipeline mixes the
  // AudioContext sine-table + analyser refill timing (raster) with CPU
  // float math (XYZ field + wavetable), which can differ sub-thresholdly
  // across platforms, so the linux baseline is pending a `task vrt:update`
  // run on linux CI; the deterministic darwin capture is the gate here.
  'linux/foxy',
  // In-card-title sweep (PR #383): the per-card title chrome was moved
  // into ModuleTitle.svelte. Cards whose `<header class="title">…` was
  // previously inlined in the card scope lost their per-card title CSS
  // (font-family / margin / letter-spacing) once the element moved into
  // a child component; ModuleTitle publishes a single shared baseline
  // (font-size: 0.85rem, weight: 500, text-align: center, margin: 0 0 8px,
  // letter-spacing: 0.05em). Darwin baselines captured here; linux baselines
  // pending regen after in-card-title sweep — darwin captured here.
  'linux/feedback',
  'linux/lines',
  'linux/monoglitch',
  'linux/riotgirls',
  'linux/shapedramps',
  'linux/unityscalemathematik',
  'linux/vdelay',
  'linux/warrenspectrum',
]);

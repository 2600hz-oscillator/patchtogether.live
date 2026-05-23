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
  ruttetra: [{ selector: 'canvas' }],
  shapedramps: [{ selector: 'canvas' }],
  vdelay: [{ selector: 'canvas' }],
};

/** Modules intentionally skipped from VRT entirely. Each entry needs a
 *  ≥10-char reason — the vrt-meta self-test enforces this. */
export const EXEMPT_FROM_VRT: Record<string, string> = {
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
  // PEAKS first-slice PR: VRT baseline pending; ART + unit + E2E provide
  // coverage. Promote into MODULES + capture baselines on both platforms
  // in a follow-up PR.
  peaks: 'VRT baseline pending; ART + unit + E2E provide coverage.',
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
  // ANALOGLOGICMATHS first-slice PR: VRT baseline pending; ART + unit + E2E
  // provide coverage. Card is small (2 attenuverter knobs + patch panel) and
  // stable; a follow-up PR will capture darwin + linux baselines once the
  // user has dogfooded any UI tweaks.
  analogLogicMaths: 'VRT baseline pending; ART + unit + E2E provide coverage. UI is stable but new — pinning baselines in a follow-up PR.',
  // BENTBOX — CRT-emulation OUTPUT. Frame feedback + per-line sync jitter
  // animated by uTime defeats a deterministic single-frame baseline.
  bentbox: 'animated CRT simulation (feedback + per-line time drift) defeats deterministic capture; unit + E2E provide coverage',
  // JOYSTICK first-slice PR: card is small + simple (XY pad + four CV
  // ports), VRT baseline pending. Unit + E2E provide coverage.
  joystick: 'VRT baseline pending; unit + E2E provide coverage. UI is small + stable — pinning baselines in a follow-up PR.',
  // GAMEPAD — card content depends on the connected controller's live
  // state (stick dot positions, button LEDs, trigger fill bars), all
  // changing at rAF rate. A deterministic baseline would need to stub
  // navigator.getGamepads(), out of scope here. Unit + E2E cover the
  // def shape + helper functions; the live path is per-user.
  gamepad: 'card content driven by live navigator.getGamepads() poll; defeats deterministic capture. Unit + E2E cover the def + helpers.',
  // WAVESCULPT first-slice PR: animated 3D render + CRT feedback means a
  // single-frame pixel baseline can't match between runs.
  wavesculpt: 'animated 3D ribbon render + CRT frame-feedback defeats deterministic capture; unit + E2E provide coverage',
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
]);

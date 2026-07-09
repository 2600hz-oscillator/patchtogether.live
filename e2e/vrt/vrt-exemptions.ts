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
  // SWOLEVCO carries a video-out preview canvas.
  swolevco: [{ selector: 'canvas' }],
  // CUBE: live rotating 3D WebGL2 render (issue #2) + snapshot-driven OUTPUT
  // scope — both animate continuously (camera + rAF), so mask the canvases and
  // gate on the deterministic card chrome. No VRT scene (removed; the canvas
  // can't be pinned to a single frame). Render correctness covered elsewhere.
  cube: [{ selector: 'canvas' }],
  // HYPERCUBE: same as CUBE — a live rotating WebGL2 Schlegel-tesseract render +
  // snapshot-driven OUTPUT scope, both animate continuously, so mask the
  // canvases and gate on the deterministic card chrome.
  hypercube: [{ selector: 'canvas' }],
  // WARRENSPECTRUM has the acidwarp video viz canvas.
  warrenspectrum: [{ selector: 'canvas' }],
  // SAMSLOOP — loop-based WAV sample player. The waveform canvas is
  // static after upload, but unloaded shows "NO SAMPLE LOADED" text —
  // mask the canvas so the chrome diffs deterministically.
  samsloop: [{ selector: 'canvas' }],
  // TWOTRACKS — 2-reel tape-loop emulator. Each reel has a waveform
  // canvas (empty on fresh spawn); mask both canvases so the card chrome
  // diffs deterministically.
  twotracks: [{ selector: 'canvas' }],
  // TILER: live tiled-OUT preview canvas (non-deterministic per frame) — mask it;
  // the card chrome (TILE fader + PatchPanel) is VRT'd. Baseline via vrt-update.
  tiler: [{ selector: 'canvas' }],
  // ----- video domain — every video module renders a preview canvas;
  // mask it and assert the chrome around it.
  lines: [{ selector: 'canvas' }],
  // VFPGA-RUNNER — host card with a live preview canvas + per-CV always-on
  // scope canvases (both animate off the card rAF), so mask every canvas and
  // gate on the deterministic chrome (preset select + param knob grid + CV
  // SCALE/OFFSET knobs + gate LEDs + port handle rows). Currently in
  // EXEMPT_FROM_VRT below; the mask covers the canvases if promoted into
  // MODULES once darwin/linux baselines are captured.
  vfpgaRunner: [{ selector: 'canvas' }],
  // OUTLINES — stateful particle generator; the card carries a live COMBINE
  // preview canvas (shapes spawn + move + spin off the engine rAF), so the
  // canvas region is non-deterministic in the standard solo-spawn VRT. Mask it
  // and gate on the deterministic chrome (7 knobs D/V/SPD/DEC/SHP/ROT/RATE +
  // GATE/COL/D/V/SPD/DEC/SHP/ROT/VID input rows + OVR/CNT/CMB/MAP output rows +
  // the SHAPE/ROT readouts). Promoted into the VRT baseline set (the canvas mask
  // covers the live preview). Only the DARWIN baseline was regenerated via
  // vrt-update.yml after the SHAPE+ROTATION card change; the LINUX baseline is
  // still pending a workflow_dispatch, so `linux/outlines` stays in
  // EXEMPT_BASELINE_PAIRS below (the recorderbox/cellshade new-module pattern).
  outlines: [{ selector: 'canvas' }],
  videoOut: [{ selector: 'canvas' }],
  // RECORDERBOX — live preview canvas (+ a hidden full-res capture canvas,
  // off-screen at left:-9999px so its mask rect lands outside the captured
  // card box). Mask the canvas + gate on the deterministic chrome (title,
  // IN/OUT/A·L/A·R handles, FILE field, RECORD button).
  recorderbox: [{ selector: 'canvas' }],
  inwards: [{ selector: 'canvas' }],
  picturebox: [{ selector: 'canvas' }],
  destructor: [{ selector: 'canvas' }],
  chroma: [{ selector: 'canvas' }],
  luma: [{ selector: 'canvas' }],
  colorizer: [{ selector: 'canvas' }],
  feedback: [{ selector: 'canvas' }],
  videoMixer: [{ selector: 'canvas' }],
  shapes: [{ selector: 'canvas' }],
  // SPIROGRAPHS — live spirograph generator with a continuously-animated OUT
  // preview canvas (each spiro's center drifts + bounces every frame off the
  // engine clock). Mask the canvas so the deterministic chrome (COUNT fader +
  // 1/2/3 spiro selector + IN/OUT toggle + chroma colorwheel + per-spiro fader
  // bank + the sectioned PatchPanel) is the regression gate. Currently in
  // EXEMPT_FROM_VRT below; the mask covers the live preview if promoted into
  // MODULES once darwin/linux baselines are captured.
  spirographs: [{ selector: 'canvas' }],
  monoglitch: [{ selector: 'canvas' }],
  // TOYBOX — swappable fragment-shader source. The card carries a live
  // animated preview canvas (the layer-0 shader runs off the engine clock),
  // so the canvas region is non-deterministic in the standard solo-spawn
  // VRT; mask it and gate on the deterministic chrome (CONTENT dropdown +
  // per-param faders + OUT handle). The real shader-render correctness is
  // proven by the dedicated frozen VRT (vrt-toybox.spec.ts) which pins
  // iTime via window.__toyboxFreeze and includes the canvas in the diff.
  toybox: [{ selector: 'canvas' }],
  // RESHAPER (formerly RUTTETRA): coord-remap; canvas masked (flat content
  // when X/Y/Z unpatched).
  reshaper: [{ selector: 'canvas' }],
  // RUTTETRA: authentic forward-scatter scope. Its canvas is INCLUDED in
  // the diff via the VRT scene (SHAPES → RUTTETRA) so the baseline proves
  // real 3D scanlines, not a flat quad. The scene auto-overrides this mask
  // (vrt.spec.ts: `mod.type in VRT_SCENES ? [] : masks`), kept here as the
  // no-scene fallback.
  ruttetra: [{ selector: 'canvas' }],
  // GRAPHIC EQ carries a live audio-reactive preview canvas; mask it (it is
  // also EXEMPT_FROM_VRT — animated bars defeat deterministic capture).
  graphicEq: [{ selector: 'canvas' }],
  shapedramps: [{ selector: 'canvas' }],
  vdelay: [{ selector: 'canvas' }],
  // FREEZEFRAME carries a live video_out preview canvas; mask it so the
  // deterministic chrome (4 QUANT knobs + VID/GATE/OUT/R/G/B/L handle rows)
  // is the regression gate. The S&H + posterize correctness is covered by
  // freezeframe.test.ts (unit) + the freezeframe e2e (pixel sampling).
  freezeframe: [{ selector: 'canvas' }],
  // CELLSHADE (cel-shader video processor) carries a live OUT preview
  // canvas; mask it so the deterministic chrome (THRESH/THICK/BITS faders +
  // IN/T/W/B/OUT handle rows + the BITS readout) is the regression gate.
  // The quantize + edge-ink correctness is covered by cellshade.test.ts
  // (CPU mirror of the shader) + the bespoke cellshade e2e (pixel sampling).
  cellshade: [{ selector: 'canvas' }],
  // TEXTMARQUEE carries a live OUT preview canvas (continuously animated when
  // scrolling) — mask it. The card ALSO contains a contenteditable region whose
  // rendered SYSTEM-FONT glyphs rasterize differently across platforms (the
  // exact known linux-VRT glyph nondeterminism), so the LINUX baseline is
  // exempted via EXEMPT_BASELINE_PAIRS below; the darwin baseline gates the
  // chrome (toolbar buttons + FG/BG swatches + the four knob rows).
  textmarquee: [{ selector: 'canvas' }],
  // 4PLEXVID carries a live OUT-1 preview canvas; mask it so the
  // deterministic chrome (4 selector knobs + handle rows) diffs while the
  // live render is excluded. (Kept here for the follow-up baseline; the
  // module is currently in EXEMPT_FROM_VRT below — promote it into MODULES
  // when the darwin/linux PNGs are captured.)
  '4plexvid': [{ selector: 'canvas' }],
  // ONE TO NINE — 1-in/9-out 3×3 splitter. The card carries a live MONITOR
  // preview canvas (input + grid + numbers via blitOutputToDrawingBuffer off
  // the engine clock); mask it so the deterministic chrome (GRID toggle +
  // IN/OUT1..OUT9 patch-panel) is the regression gate. The crop math is
  // covered by onetonine.test.ts + the bespoke onetonine e2e.
  onetonine: [{ selector: 'canvas' }],
  shapegen: [{ selector: 'canvas' }],
  // SOURCERY — 2-input region shape-match recolor. The card carries a live
  // on-card preview canvas (blitOutputToDrawingBuffer off the engine clock,
  // black when nothing is patched) and v1 segmentation is source-dependent +
  // shimmers frame-to-frame, so the canvas region is non-deterministic; mask it
  // and gate on the deterministic card chrome. Correctness is covered by the
  // pure core (sourcery-core.test.ts) + the bespoke e2e (sourcery.spec.ts).
  sourcery: [{ selector: 'canvas' }],
  // MANDLEBLOT — Mandelbrot fractal with time-driven hue cycle. The
  // shader's colour mode mixes mu + uTime + log(uZoom) into the hue, so
  // every frame is a different colour even at zero motion. Mask the
  // canvas so the chrome diff (6 knobs + zoom readout + handles) is
  // the regression gate; the shader correctness is covered by unit +
  // E2E. Pinning the canvas as well would need a deterministic-time
  // hook on the engine clock — deferred to a follow-up.
  mandleblot: [{ selector: 'canvas' }],
  // MANDELBULB — live ray-marched 3D fractal preview + auto-spin; mask the
  // canvas so the deterministic chrome (6 knobs + SPIN/SCRN toggles + CV
  // handle rows + VIDEO out) is the regression gate.
  mandelbulb: [{ selector: 'canvas' }],
  // SCOREBOARD — 4-digit 7-segment counter widget. The card carries a live
  // preview canvas; the counter starts at 0 on factory mount (or 1234 when
  // the VRT scene sets `__scoreboardVrtSeed`). Canvas masked here as the
  // fallback so the chrome (port handles + COLOR knob) diffs deterministically
  // when the module is promoted into MODULES without a registered scene.
  scoreboard: [{ selector: 'canvas' }],
  // QUADRALOGICAL — 4-input video mixer. The card carries a live on-card MIX
  // preview canvas (blitOutputToDrawingBuffer off the engine clock), so the
  // canvas region is non-deterministic in the standard solo-spawn VRT; mask it
  // and gate on the deterministic chrome (XY pad + yellow diamond + 8-button
  // transition row + dynamic faders + FG/BG toggle + handle rows). The
  // weight-model + composite correctness is covered by the unit suite
  // (quadralogical.test.ts) + the dedicated e2e (quadralogical.spec.ts).
  quadralogical: [{ selector: 'canvas' }],
  // COLOUR OF MAGIC — multi-colorspace processor. The solo-spawn card carries a
  // live on-card preview canvas (blitOutputToDrawingBuffer off the engine clock,
  // black when nothing is patched), so the standard solo VRT is non-deterministic;
  // mask it and gate on the deterministic chrome (preview pill row + the three
  // RGB/YDbDr/HSV block columns of knobs + OVER/CLAMP pills + REPLACE/HSL toggles
  // + palette swatches + handle rows). The deterministic per-block composite VRT
  // (recolorization / mono-override clobber / palette remap) lives in
  // vrt-colourofmagic.spec.ts.
  colourofmagic: [{ selector: 'canvas' }],
  // ANALOG VCO — now carries a live single-cycle waveform scope at the top of
  // the card (off an AnalyserNode on the morph output). The trace is animated
  // + device-/timing-dependent, so mask the canvas; the deterministic chrome
  // (6 faders incl. the new Wave knob + the saw/square/triangle/sine/morph
  // handle rows) is the regression gate. The morph DSP is covered by
  // analog-vco-morph.test.ts; the scope-window logic by analog-vco-scope.test.ts.
  analogVco: [{ selector: 'canvas' }],
  // BACKDRAFT — video feedback generator, now USER-RESIZABLE with full output
  // capabilities (Full Frame / Full Screen / Present). The live feedback preview
  // canvas is non-deterministic (and variable-size), so mask it; the
  // deterministic frozen capture lives in VRT_SCENES.backdraft (the scene
  // auto-overrides this mask: `mod.type in VRT_SCENES ? [] : masks`). Currently
  // in EXEMPT_FROM_VRT below pending a fresh darwin/linux baseline after the
  // resizable redesign; this mask covers the live preview when re-promoted.
  backdraft: [{ selector: 'canvas' }],
  // MILKDROP — butterchurn music visualizer. The card carries a live preview
  // canvas (blitOutputToDrawingBuffer off the engine clock + an async-loaded
  // preset that animates continuously), so the canvas region is non-deterministic
  // in the solo-spawn VRT; mask it and gate on the deterministic chrome (port
  // handle rows + RCT/SPD/PST/MPH knobs + preset readout). Currently in
  // EXEMPT_FROM_VRT below (chaotic/time-based, like doom/mandelbulb); this mask
  // covers the live preview if it is ever promoted into MODULES.
  milkdrop: [{ selector: 'canvas' }],
};

/** Modules intentionally skipped from VRT entirely. Each entry needs a
 *  ≥10-char reason — the vrt-meta self-test enforces this. */
export const EXEMPT_FROM_VRT: Record<string, string> = {
  // MILKDROP — butterchurn (Winamp Milkdrop) visualizer. The live preview is a
  // continuously-animating multi-pass warp-mesh render driven off the engine
  // clock + an async-loaded preset; pixel-exact VRT would flake on every frame
  // (chaotic/time-based, like doom/mandelbulb). The deterministic render-smoke
  // (milkdrop-render-smoke.spec.ts: freeze + fixed delta + synthetic audio +
  // fixed steps → non-black/structured/no-GL-error) is the real pixel gate.
  milkdrop: 'continuously-animating multi-pass butterchurn visualizer (chaotic/time-based) defeats deterministic single-frame capture; covered by milkdrop-render-smoke.spec.ts (freeze + fixed delta + synthetic audio) + the modules-card-map / contract-lock / docs-lint unit gates',
  // GRAPHIC EQ — Winamp-style VU-meter video output. The card preview is a
  // live audio-reactive bar/box meter render (heights driven by the patched
  // signal's FFT) — animated + input-dependent, so a single-frame baseline
  // can't be pinned. Coverage: graphic-eq-core.test.ts (pure bin→8-band fold,
  // mono fold, segment quantization, stereo split-rect layout, colour ramp) +
  // e2e/tests/graphic-eq-render-smoke.spec.ts (deterministic non-black /
  // structured / zero-GL-error render smoke).
  graphicEq: 'animated audio-reactive bars defeat deterministic capture; pure-core unit tests (bin→8-band fold / mono / segment / split-rect / colour) + deterministic render-smoke e2e cover it',
  // ARCHIVIST — Internet Archive (archive.org) media source. LIVE external
  // network source (search + stream of random items) + a live <video>/<audio>
  // element + ticking playhead readout + a per-item preview that depends on
  // archive.org content — all non-deterministic, so a single-frame baseline
  // can't be pinned. Coverage: archivist-query.test.ts + archivist-scrub.test.ts
  // (pure cores: query builder, response parser, best-file picker, scrub math)
  // + e2e/tests/archivist.spec.ts (route-mocked archive.org — never live).
  archivist: 'live external archive.org source + live <video>/<audio> + ticking playhead defeat deterministic capture; pure-core unit tests (query/parse/file-pick/scrub) + route-mocked e2e provide coverage',
  // 4PLEXVID — 4-in/4-out video router. Card carries a live OUT-1 preview
  // canvas; the rest is static chrome (4 discrete selector knobs + handle
  // rows). VRT baseline pending platform-specific capture. Functional
  // coverage: e2e/tests/4plexvid.spec.ts (proves each output shows its
  // SELECTED input, gate rising-edge advances + wraps, outputs are
  // independent) + the plex-select unit suite (selector-advance + gate
  // edge-detect). Promote into MODULES + capture darwin/linux PNGs (the
  // canvas mask above masks the live preview) in a follow-up PR.
  '4plexvid': 'VRT baseline pending; e2e/tests/4plexvid.spec.ts + plex-select unit tests provide coverage. Promote + capture darwin/linux baselines (live preview masked) in a follow-up PR.',
  // ONE TO NINE — 1-in/9-out fixed 3×3 splitter. The card is a live MONITOR
  // preview canvas (input + grid + numbers) + a GRID toggle + the IN/OUT1..OUT9
  // patch panel; nothing patched is a black preview, and the live render is
  // non-deterministic chrome. Coverage: onetonine.test.ts (pure cell→source-rect
  // crop math: cell 1 top-left/high-v, cell 9 bottom-right/low-v, exact tiling)
  // + e2e/tests/onetonine.spec.ts (real source→onetonine→output: monitor
  // non-blank + structured, out1 vs out9 non-blank AND spatially different).
  // Promote + capture darwin/linux baselines (live preview masked) in a
  // follow-up PR.
  onetonine: 'VRT baseline pending; onetonine.test.ts (crop math) + e2e/tests/onetonine.spec.ts (real source→splitter→output, monitor structured, out1≠out9) provide coverage. Promote + capture darwin/linux baselines (live monitor preview masked) in a follow-up PR.',
  // SHAPEGEN — first-slice PR extracts FOXY's 3dShapeGen path into a
  // standalone video module (3 raster inputs, SIZE/ROT knobs, SOLIDS
  // toggle). Unit + e2e coverage; VRT baseline pending. The
  // window.__shapegenVrtSeed hook is wired in the factory for the
  // follow-up baseline capture (synthetic deterministic 3-raster scene
  // + frozen rotation), and the canvas mask above covers the live
  // preview if the module is promoted into MODULES before the seed
  // path is finished.
  shapegen: 'VRT baseline pending; first-slice PR — unit + e2e provide coverage. Capture darwin/linux baselines once the __shapegenVrtSeed deterministic scene path is wired.',
  // SOURCERY — 2-input region shape-match recolor. v1 output is
  // source-dependent (needs A + B patched) AND shimmers/boils frame-to-frame
  // (per-frame-independent segmentation), so a solo-spawn VRT canvas is
  // non-deterministic. Real coverage lives in the pure core
  // (sourcery-core.test.ts — CCL/moments/Hu/match/rel→uvB/hue-skew, 37 cases)
  // + the bespoke e2e (sourcery.spec.ts — real 2-source chain, non-black +
  // structured + param-response). Promote once a deterministic seed path exists.
  sourcery: 'VRT baseline pending; v1 segmentation is source-dependent + shimmers frame-to-frame, so the solo-spawn canvas is non-deterministic. Coverage = sourcery-core.test.ts (CCL/moments/Hu/match/rel→uvB/hue-skew) + e2e/tests/sourcery.spec.ts (real 2-source chain, non-black + structured + param response). Capture darwin/linux baselines once a deterministic seed path is wired.',
  // SCOREBOARD — first-slice PR ships the module + draw helper + factory
  // gate tests + e2e (gate→counter advance, RESET, wrap-at-10000). The
  // VRT scene path is wired (window.__scoreboardVrtSeed → counter at
  // 1234 for a stable, all-segments-touching baseline) — promote into
  // MODULES + capture darwin/linux PNGs in a follow-up PR. The canvas
  // mask above covers the live preview if promotion happens without the
  // scene path being driven yet.
  scoreboard: 'VRT baseline pending; unit + factory gate tests + e2e provide coverage. Promote + capture darwin/linux baselines (seed counter at 1234 via window.__scoreboardVrtSeed for a stable, all-segments-touching baseline) in a follow-up PR.',
  // CAMERA renders a live MediaStream into a canvas. Even with the
  // fake-camera flag the synthetic frame is non-deterministic enough
  // (frame-time clock) that the baseline would flap. Functional coverage
  // is e2e/tests/camera-input.spec.ts.
  cameraInput: 'live MediaStream defeats deterministic capture',
  // LOOPBACK renders a live getDisplayMedia tab-capture into a recursive
  // preview (a video-feedback tunnel) — non-deterministic by construction, same
  // as CAMERA. Functional + render coverage is e2e/tests/loopback.spec.ts
  // (deterministic synthetic-frame render smoke + crop-toggle + recorderbox
  // chain) + loopback-crop.test.ts (pure crop math) + loopback.test.ts (def).
  loopback: 'live getDisplayMedia tab-capture + recursive preview defeat deterministic capture; covered by loopback.spec.ts (synthetic-frame render smoke + crop-toggle + recorderbox chain) + loopback-crop/loopback unit tests',
  // AUDIO IN — system mic / line-in source. Card state depends on
  // getUserMedia permission + presence of audio inputs (both non-
  // deterministic across CI runners); the LED + status text would
  // differ between idle/streaming/no-inputs states. Functional coverage
  // is e2e/tests/audio-in.spec.ts (chromium-audio-in project, fake-mic
  // injected); unit tests cover the def shape + device-picker helpers.
  audioIn: 'card state depends on getUserMedia permission + audioinput presence (varies across CI runners); e2e/tests/audio-in.spec.ts + devices.test.ts + audioin.test.ts provide coverage',
  // GROUP is a Phase-1 collapse-N-modules container with no engine
  // binding. A bare GROUP! has no exposed ports → its visual surface
  // is just the card chrome + label, which carries no module-specific
  // pixels worth fingerprinting. Functional coverage is
  // e2e/tests/grouping-phase1.spec.ts.
  group: 'no-op render until exposed-ports are set by Create-Group; e2e covers the full flow',
  // CADILLAC — singleton meta module with NO card render at all (the
  // module is a roaming overlay sprite rendered by CadillacOverlay, not
  // a SvelteFlow node body). The reconciler skips meta-domain nodes, so
  // there is no per-card visual surface to baseline. Unit tests cover
  // the pure collision math; E2E covers the deletion + self-destruct +
  // TIMELORDE-survives flows.
  cadillac: 'no card render — roaming overlay sprite, not a SvelteFlow node body. Unit (collision math) + E2E (deletion, self-destruct, timelorde-survives) provide coverage.',
  // CONTROL SURFACE — meta module whose entire body is binding-dependent
  // (proxied controls vary per patch); a fresh surface is just a blank
  // square + lock button. No stable module-specific pixels worth
  // fingerprinting. Covered by control-surface.test.ts (model) + the
  // control-surface e2e (spawn → send → proxy drives source → collapse).
  controlSurface: 'content is binding-dependent (proxied controls vary by patch); empty state is a blank square. Covered by control-surface.test.ts + control-surface.spec.ts.',
  // MATRIXMIX — meta module (EMS-Synthi / Buchla patch matrix) whose entire
  // grid body is patch-dependent: a solo-spawned card shows only two axis
  // dropdowns + a "pick a module" hint (the matrix only materializes once both
  // axes name a module that exists in the patch), so the grid has no stable
  // module-specific pixels to fingerprint. Like CONTROL SURFACE, covered by
  // the pure-core unit (matrixmix-grid.test.ts), the real-Y.Doc edge writer
  // (matrixmix-ydoc.test.ts), and the live-chain e2e (matrixmix.spec.ts:
  // spawn matrix + two modules → select axes → click cell → assert edge + dot).
  matrixMix: 'grid body is patch-dependent — solo-spawn shows only the axis dropdowns + a pick-a-module hint (no stable module-specific pixels). Covered by matrixmix-grid.test.ts + matrixmix-ydoc.test.ts + e2e/tests/matrixmix.spec.ts.',
  // LAUNCHPAD CONTROL LEFT / RIGHT — meta control-surface cards that bind a
  // physical Novation Launchpad pair to a clip-player. Like CONTROL SURFACE /
  // ELECTRA, the card body is DEVICE-dependent (Pair / Bind state + a status
  // line that varies with whether MIDI access + a paired pair exist — all
  // absent in CI). The deterministic solo-spawn state is just the blurb + a
  // "Pair Launchpads" button + a colour legend (no module-specific pixels worth
  // pinning beyond the legend, which is itself driven by the live map constants
  // exercised in the unit suite). Coverage: launchpad-sysex.test.ts (codec
  // golden vectors), launchpad-map.test.ts (placement + RGB colour language),
  // launchpad-control.test.ts (binding mode-machine), and the real-source-chain
  // e2e launchpad-clip-launch.spec.ts (TIMELORDE → clipplayer → simulated pad →
  // audible RMS). Same treatment as controlSurface/matrixMix (fully exempt).
  launchpadControlLeft: 'meta control-surface card (consolidated launchpad-control pair); body is device/binding-dependent (Pair/Bind state + status absent in CI), like controlSurface/electraControl. Covered by launchpad-sysex/map/control unit suites + the real-source-chain launchpad-clip-launch e2e (pad → audible RMS).',
  // CLOUDS first-slice PR (#166): VRT baseline pending; ART + unit + E2E
  // provide coverage. Promote into MODULES + capture baselines on both
  // platforms in a follow-up PR.
  clouds: 'VRT baseline pending; ART + unit + E2E provide coverage.',
  // MACSEQ — VRT baseline pending. Functional coverage is e2e/tests/macseq.spec.ts
  // which proves the headline MACSEQ→MACROOSCILLATOR MODELCV wiring works.
  // A follow-up PR will capture the darwin + linux pixel baselines.
  macseq: 'VRT baseline pending; e2e/tests/macseq.spec.ts covers MODELCV wiring',
  // WRITESEQ — recording step-sequencer. VRT baseline pending (the card is a
  // standard grid + fader card with a pulsing REC indicator + animated
  // playhead, like MACSEQ, which would need masking before a stable pixel
  // baseline). Functional coverage is the deterministic alignment +
  // transport-rule unit tests (writeseq.test.ts / writeseq-alignment.test.ts /
  // writeseq-transport.test.ts) + e2e/tests/writeseq.spec.ts. A follow-up PR
  // captures the darwin + linux baselines via the vrt-update.yml workflow.
  writeseq: 'VRT baseline pending; unit (alignment + transport) + e2e/tests/writeseq.spec.ts provide coverage. Capture darwin/linux baselines via vrt-update.yml in a follow-up.',
  // RINGS first-slice PR: VRT baseline pending; ART + unit + E2E
  // provide coverage. Linux baseline is darwin-only for v1; a
  // follow-up PR will capture both platforms and promote into MODULES.
  rings: 'VRT baseline pending; ART + unit + E2E provide coverage. Linux baseline is darwin-only for v1.',
  // MARBLES first-slice PR: plain fader card (no custom canvas
  // viz), so VRT adds little; unit tests cover the DSP core. Promote +
  // capture baselines in a follow-up PR.
  marbles: 'VRT baseline pending; standard fader card; unit tests cover the DSP core.',
  // ATTENUMIX simple mixer: VRT baseline pending; ART + unit + E2E cover it.
  // 4 attenuator faders + master + standard PatchPanel — no unique visual
  // surface; baseline can be promoted in a follow-up.
  attenumix: 'VRT baseline pending; ART + unit + E2E provide coverage',
  // SIDECAR stereo sidechain compressor: VRT baseline pending; standard
  // 8-knob fader card + standard PatchPanel — no unique visual surface
  // beyond what RESOFILTER / ATTENUMIX already exercise. ART + unit +
  // E2E provide full DSP + behavior coverage. Promote into MODULES +
  // capture darwin/linux baselines in a follow-up PR.
  sidecar: 'VRT baseline pending; standard 8-knob card; ART + unit + E2E provide coverage',
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
  // MIDI-CV-BUDDY card body depends on connected MIDI device (which
  // doesn't exist under VRT) — the "Connect MIDI…" empty state would
  // be the only deterministic baseline, and even that paints differently
  // once the user has previously granted permission. Functional coverage
  // is e2e/tests/midi-cv-buddy.spec.ts.
  midiCvBuddy: 'card content depends on connected MIDI device; unit + E2E provide coverage',
  // MIDI-OUT-BUDDY: same rationale as midiCvBuddy — the card's device picker
  // depends on the connected MIDI OUTPUT list (no hardware in CI), and the
  // pre-Connect state is just the "Connect MIDI…" button. Unit + E2E
  // (fake-output capture) provide coverage. See e2e/tests/midi-out-buddy.spec.ts.
  midiOutBuddy: 'card content depends on connected MIDI device; unit + E2E provide coverage',
  // MIDICLOCK: same rationale as midiCvBuddy — pre-Connect state shows a
  // "Connect MIDI…" button (deterministic) but post-connect the device list
  // depends on hardware that isn't present in CI. Unit + E2E (mock-MIDI smoke)
  // provide coverage.
  midiclock: 'card content depends on connected MIDI device; unit + E2E provide coverage',
  // MIDI LANE: same rationale as midiCvBuddy — the rich card UI (device
  // picker, channel/mode/CC/note controls, live readout) only appears AFTER
  // Connect, which depends on hardware absent in CI; the pre-Connect state is
  // just the "Connect MIDI…" button + hint. Unit (midi-lane.test.ts) + E2E
  // (midi-lane.spec.ts + per-port driver) provide coverage.
  midiLane: 'card content depends on connected MIDI device; unit + E2E provide coverage',
  // PONG research prototype: animated game state (ball moving) defeats a
  // deterministic single-frame baseline. Unit + ART + E2E provide coverage
  // until either (a) a deterministic-time test harness is added so VRT can
  // freeze the ball at a known position, or (b) the prototype is promoted
  // out of research/.
  pong: 'animated game state defeats deterministic capture; unit + ART + E2E provide coverage',
  // MODTRIS research prototype: same rationale as PONG.
  modtris: 'animated game state defeats deterministic capture; unit + ART + E2E provide coverage',
  // GIBRIBBON — Vib-Ribbon-style ribbon scroller: the ribbon + sprites scroll
  // continuously (per-frame scroll + clock-driven spawns), so no naturally
  // still frame. Same rationale as PONG / MODTRIS / FROGGER. Pure event
  // generator + WAD sprite decoder are unit-tested; e2e/tests/gibribbon.spec.ts
  // covers spawn→clear→score, miss→degrade, + every event gate → SCOPE bridge.
  gibribbon: 'animated scrolling ribbon + sprites defeat deterministic single-frame capture; gibribbon-events + wad-sprites unit tests + gibribbon.spec.ts provide coverage',
  // FROGGER research prototype: sprite-tick advances every ~10 ms of game-
  // time + the start_gate auto-fire on first tick produces a moving frame
  // by the time Playwright snapshots. Same rationale as PONG / MODTRIS;
  // unit + E2E provide coverage. Promote to a real VRT baseline once a
  // deterministic-time test hook is added so the scene can freeze the
  // game at a known tick.
  frogger: 'animated sprite motion (cars/logs/turtles) + auto-start defeat deterministic single-frame capture; unit + E2E provide coverage',
  // SKIFREE — the skifree.js engine self-drives via requestAnimationFrame
  // (terrain scrolls, snowboarders/yeti move, skier animation cycles) the
  // moment the bundle loads, so there is no naturally still frame to
  // baseline. Same rationale as FROGGER / SM64 / PONG. Unit (cvToCanvasCoord
  // + gate hook) + E2E (e2e/tests/skifree.spec.ts: CV-cursor steering +
  // crash/eaten → gate → SCOPE) provide coverage. Promote to a real VRT
  // baseline once a deterministic-time render-freeze hook is added so the
  // scene can be pinned at a known frame.
  skifree: 'animated ski-slope (rAF-self-driven terrain + sprites + skier anim) defeats deterministic single-frame capture; unit + E2E provide coverage',
  // ANALOGLOGICMATHS first-slice PR: VRT baseline pending; ART + unit + E2E
  // provide coverage. Card is small (2 attenuverter knobs + patch panel) and
  // stable; a follow-up PR will capture darwin + linux baselines once the
  // user has dogfooded any UI tweaks.
  analogLogicMaths: 'VRT baseline pending; ART + unit + E2E provide coverage. UI is stable but new — pinning baselines in a follow-up PR.',
  // BENTBOX — CRT-emulation OUTPUT. Frame feedback + per-line sync jitter
  // animated by uTime defeats a deterministic single-frame baseline.
  bentbox: 'animated CRT simulation (feedback + per-line time drift) defeats deterministic capture; unit + E2E provide coverage',
  // B3NTB0X — circuit-level NTSC composite re-arch (encode->bend->decode->CRT).
  // The composite carrier drifts per-frame (subcarrier drift + recovered sync
  // offset) and the CRT pass carries frame persistence, so a single-frame
  // baseline flaps. Same rationale as BENTBOX/ACIDWARP. Unit (encode->demod
  // round-trip + nonlinearity bounds in b3ntb0x.test.ts) + E2E provide coverage.
  b3ntb0x: 'animated NTSC composite simulation (per-line sync drift + frame persistence) defeats deterministic capture; unit (encode->demod round-trip) + E2E provide coverage',
  // ACIDWARP — 320×240 plasma with rotating palette + auto scene cycler.
  // Both rotation and scene-advance are time-driven; deterministic capture
  // is impossible without freezing the engine clock. Pattern/palette unit
  // coverage in acidwarp-patterns.test.ts; integration coverage via E2E.
  acidwarp: 'animated palette rotation + auto scene cycler defeats deterministic capture; unit + E2E provide coverage',
  // TEMPEST (P1) — additive-line vector well; the live preview is an animated GL
  // render (claw/CV-driven, later enemies). Geometry is unit-tested GL-free
  // (tempest-core.test.ts + tempest.test.ts) + a render-smoke E2E; a masked/baselined
  // card can replace this exemption in a later phase.
  tempest: 'animated additive-line vector render defeats deterministic capture; unit (tempest-core/tempest) + render-smoke E2E provide coverage',
  // VFPGA-RUNNER — host module shipping the smpte-bars VFPGA. The card carries
  // a live preview canvas + per-CV always-on scope canvases (animated off the
  // card rAF), so the standard solo-spawn capture is non-deterministic. Unit
  // (snapshot/spec-validation/factory) + the bespoke e2e (vfpga-runner.spec.ts:
  // preset loads, vout1 emits, CV scope animates) provide coverage. Promote
  // into MODULES + capture darwin/linux baselines (the canvas mask above covers
  // the live preview + scopes) in a follow-up PR.
  vfpgaRunner: 'VRT baseline pending; host card with live preview + CV scope canvases defeats deterministic solo-spawn capture. Unit (snapshot + spec-validation) + e2e (vfpga-runner.spec.ts) provide coverage. Capture darwin/linux baselines (canvases masked) in a follow-up.',
  // MANDELBULB — promoted into MODULES (no longer exempt). The card carries
  // a live ray-marched 3D preview canvas that auto-spins by default, so the
  // canvas region is non-deterministic; it's MASKED via VRT_MODULE_MASKS
  // (`mandelbulb: [{ selector: 'canvas' }]`, same as MANDLEBLOT / CUBE /
  // ACIDWARP-family video cards) and the surrounding deterministic chrome
  // (6 knobs ZOOM/ROT X/ROT Y/POWER/DETAIL/HUE + SPIN/SCRN toggles + 6 CV
  // handle rows + VIDEO out) is the regression gate. Darwin baseline captured
  // here; linux baseline pending a `task vrt:update` run on linux CI (see
  // EXEMPT_BASELINE_PAIRS → linux/mandelbulb). DE/shading correctness is
  // additionally covered by mandelbulb-math.test.ts + mandelbulb.test.ts.
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
  // ATLANTIS-PATCH support module. VRT baseline pending; the demo
  // patch itself is the integration test.
  slewSwitch: 'VRT baseline pending — first-slice ATLANTIS-PATCH module; unit + E2E provide coverage',
  // WAVESCULPT: previously VRT-exempt (animated 3D render + CRT feedback
  // defeated single-frame capture). The alpha-rotate bugfix PR adds a
  // deterministic render-freeze hook (globalThis.__wavesculptVrtFreeze →
  // card pins time/wave-phase/field-parity) so it now has a real VRT
  // scene (see vrt-scenes.ts: wavesculpt) capturing the ALPHA layer at a
  // non-zero rotation. No longer exempt.
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
  // BLOOD — NBlood (Build engine) port. Same rationale as DOOM: a live
  // game-loop framebuffer defeats deterministic capture. Additionally the
  // game data (BLOOD.RFF/GUI.RFF/SOUNDS.RFF/TILES000.ART) is user-supplied +
  // gitignored + NOT redistributable, so CI has no data — the card only ever
  // shows the "data missing — run task setup:blood" overlay on the runner, and
  // there is no rendered frame to baseline. Unit suites cover the TS shim
  // (blood-runtime) + the CV-gate scancode map (blood-keys).
  blood: 'live game-loop framebuffer + user-supplied non-redistributable data (no frame on CI) defeats deterministic capture; unit suites cover blood-runtime shim + blood-keys scancode map',
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
  // TV LIBRARIAN — like VIDEOBOX, a live external <video> (a remote HLS stream
  // via hls.js) plus a runtime-fetched channel list (network-dependent + the
  // famelack dataset/streams change), so the card has no deterministic frame to
  // capture. Pure cores (dataset parse/filter/next/random + geo projection)
  // are unit-tested; e2e mocks the network (no live famelack/streams in CI).
  tvLibrarian: 'live external HLS <video> + runtime-fetched, ever-changing channel list defeat deterministic capture (same as videobox); pure-core unit tests + network-mocked e2e provide coverage',
  // PEERTUBE — like TV LIBRARIAN, a live external <video> (a remote PeerTube HLS
  // stream via hls.js) plus a runtime Sepia-Search results list (network-
  // dependent + ever-changing fediverse content + live thumbnails), so the card
  // has no deterministic frame to capture. Pure cores (Sepia query build/parse +
  // per-instance stream resolution) are unit-tested; e2e mocks the network (no
  // live Sepia/instance/HLS in CI).
  peertube: 'live external PeerTube HLS <video> + runtime-fetched, ever-changing Sepia-Search results + live thumbnails defeat deterministic capture (same as tvLibrarian/videobox); pure-core unit tests (query/parse/stream-resolve) + network-mocked e2e provide coverage',
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
  // FADER — new 2-source video mixer (control-only card: 2 faders + 2 transition
  // dropdowns over a 5-port PatchPanel, no canvas). VRT baseline pending the
  // new-module pattern; the transition math is unit-tested (fader-transitions)
  // + the card↔engine wiring by fader.spec.ts. Promote + capture darwin/linux
  // baselines in a follow-up.
  fader: 'VRT baseline pending — control-only mixer card (2 faders + 2 transition dropdowns); covered by fader-transitions.test + fader.spec.ts. Promote + capture darwin/linux baselines in a follow-up.',
  // LUMAKEY — new 2-input compositor; same rationale as CHROMAKEY.
  lumakey: 'VRT baseline pending; unit + E2E provide coverage. Promote into MODULES + capture darwin/linux baselines in a follow-up PR.',
  // QUADRALOGICAL — 4-input video mixer (Phase 2: per-edge effects). The SOLO-
  // spawn card carries a live on-card MIX preview canvas, so the SOLO VRT is
  // still exempt (the canvas is non-deterministic when nothing is patched). The
  // DETERMINISTIC composite VRT now lives in vrt-quadralogical.spec.ts — flat-
  // colour sources → CHROMA(tintMix=1) → a frozen mix, one baseline per effect.
  // Functional coverage: quadralogical.test.ts (weight model + edge-weight
  // composite + all 8 blend2 branches + normalling) + e2e/tests/quadralogical
  // .spec.ts (corner dominance + per-edge distinctness + independence + freeze).
  quadralogical: 'SOLO-spawn VRT exempt (live MIX preview canvas with nothing patched). The deterministic per-edge composite VRT is vrt-quadralogical.spec.ts (8 effect baselines, darwin captured; linux via EXEMPT_BASELINE_PAIRS). Unit (weight model + edge composite + all 8 blends) + e2e (corner dominance + per-edge distinctness/independence) provide coverage.',
  // COLOUR OF MAGIC — multi-colorspace processor. SOLO-spawn VRT exempt (live
  // preview canvas; nothing patched renders black). The deterministic per-block
  // composite VRT is vrt-colourofmagic.spec.ts (6 scenes: pass / rgb / ydbdr /
  // hsv recolorization + mono-override channel clobber + palette CMY remap,
  // clock-pinned structured source, darwin captured; linux via
  // EXEMPT_BASELINE_PAIRS). Unit (colourofmagic-colorspace.test.ts — every
  // colorspace + adj/over-clamp + hue-rotation + palette path) + e2e
  // (colourofmagic.spec.ts — all 8 outs emit, recolorization, mono-override
  // clobber, over/clamp) provide coverage.
  colourofmagic: 'SOLO-spawn VRT exempt (live preview canvas; nothing patched is black). The deterministic per-block composite VRT is vrt-colourofmagic.spec.ts (6 scenes: pass/rgb/ydbdr/hsv recolorization + mono-override channel clobber + palette CMY remap, darwin captured; linux via EXEMPT_BASELINE_PAIRS). Unit (colourofmagic-colorspace.test.ts) + e2e (colourofmagic.spec.ts) provide coverage.',
  // MAPPY — multi-surface manual projection mapper (v1). The SOLO-spawn card
  // carries a LIVE composite preview canvas + an SVG corner-drag overlay whose
  // handles only appear for CONNECTED inputs, so a SOLO (nothing-patched) VRT
  // is non-deterministic chrome over a black/empty preview. Functional
  // coverage: mappy.test.ts (homography-bridge: full-frame back-projection,
  // forward warp onto a dragged quad, round-trip, degenerate-quad null, surface
  // normalization/clamp) + the shared mappy-homography.test.ts (DLT solve /
  // apply / invert / column-major) + e2e/tests/mappy-output.spec.ts (real
  // source → mappy → output: composite non-blank + warping a surface / driving
  // an input changes the output, renderer-tolerant pixel deltas). Promote into
  // MODULES + capture deterministic darwin/linux composite baselines (flat
  // sources → a frozen warp) in a follow-up PR.
  mappy: 'SOLO-spawn VRT exempt (live composite preview canvas + connected-only corner overlay; nothing patched is non-deterministic chrome over a black preview). Unit (mappy.test.ts surface-normalize + homography-bridge warp/back-project/round-trip/degenerate) + mappy-homography.test.ts + e2e (mappy-output.spec.ts: real source→mappy→output, composite non-blank, warp/drive changes output) provide coverage. Capture deterministic darwin/linux composite baselines in a follow-up PR.',
  // CHROMA — v3 reshape (this PR) changed the card layout + stripe colour
  // entirely (was a 5-fader mask-extractor; now a 3-fader hue-shifter +
  // tint swatch). Old baselines were deleted; regenerate via
  // `task vrt:update` on each platform in a follow-up PR.
  chroma: 'VRT baseline pending — v3 reshape (PR feat/keyers-and-restore-chroma-luma) deleted obsolete baselines; regenerate via `task vrt:update` on each platform.',
  // LUMA — v2 reshape (this PR) same rationale as CHROMA above.
  luma: 'VRT baseline pending — v2 reshape (PR feat/keyers-and-restore-chroma-luma) deleted obsolete baselines; regenerate via `task vrt:update` on each platform.',
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
  // TREE.oh.VOX — TB-303 voice slice (Open303 port). Deterministic card:
  // 6 knobs in 2 rows + 9 patch inputs + 1 output, no canvas. Capture via
  // `task vrt:update` on each platform when this lands; unit (43 tests
  // including coefficient stability + envelope shape + accent contrast)
  // and ART (canonical 303 pattern baseline-pinned) provide coverage.
  treeohvox: 'VRT baseline pending — deterministic card (6 knobs, no canvas); capture via `task vrt:update` on each platform. Unit + ART (canonical 303 pattern baseline-pinned + cutoff sweep + accent) + parity (structural Open303 properties) provide coverage. Promote out once both platform PNGs land.',
  // BLUEBOX — first-slice PR. Static keypad UI (12 buttons in standard phone
  // layout + two phreaker buttons, no canvas / animation), so deterministic
  // capture is straightforward; pending a `task vrt:update` run on each
  // platform (this worktree doesn't have a captured display). Unit (DTMF
  // table pinned + processor smoke FFT + manifest sync) + E2E (per-button
  // peaks at the SCOPE analyser) provide coverage.
  bluebox: 'VRT baseline pending — deterministic keypad card (12 static buttons, no canvas/animation); capture via `task vrt:update` on each platform. Unit + E2E provide coverage.',
  // MOOG 921 VCO — first Moog System 55/35 clone module. Deterministic beige
  // faceplate (5 knobs + a 3-position SYNC switch, no canvas / animation) so
  // it's a good VRT candidate; baselines are pending a `task vrt:update` run
  // on each platform (this authoring worktree can't reliably boot the full
  // faustwasm-backed dev server for capture). DSP unit (moog-vco-dsp.test.ts +
  // moog921-vco.test.ts worklet) + ART (source-SHA-pinned .f32) + per-module-
  // per-port e2e provide functional coverage. Promote into MODULES once the
  // darwin + linux PNGs are captured.
  moog921Vco: 'VRT baseline pending — deterministic beige Moog faceplate (5 knobs + 3-position SYNC switch, no canvas/animation); capture via `task vrt:update` on each platform. DSP unit + ART (SHA-pinned) + per-module-per-port e2e provide coverage. Promote into MODULES once darwin + linux baselines land.',
  // MOOG CP3 console mixer — same beige-faceplate family as the 921.
  // Deterministic (5 knobs, no canvas / animation) so it's a good VRT
  // candidate; baselines are pending a `task vrt:update` run on each platform
  // (same authoring-worktree capture limitation as the 921). DSP unit
  // (moog-cp3-dsp.test.ts + moog-cp3.test.ts worklet) + ART (source-SHA-pinned
  // .f32) + per-module-per-port e2e provide functional coverage. Promote into
  // MODULES once the darwin + linux PNGs are captured.
  moogCp3: 'VRT baseline pending — deterministic beige Moog faceplate (5 knobs, no canvas/animation); capture via `task vrt:update` on each platform. DSP unit + ART (SHA-pinned) + per-module-per-port e2e provide coverage. Promote into MODULES once darwin + linux baselines land.',
  // MOOG 904A VCF — Moog System 55/35 clone slice 2. Same shape as the 921:
  // deterministic beige faceplate (2 knobs + a 3-position RANGE switch, no
  // canvas / animation), so a good VRT candidate; baselines are pending a
  // `task vrt:update` run on each platform (this authoring worktree can't
  // reliably boot the full faustwasm-backed dev server for capture). DSP unit
  // (moog-ladder-dsp.test.ts + moog904a.test.ts worklet) + ART (source-SHA-
  // pinned .f32 self-osc) + per-module-per-port e2e provide functional
  // coverage. Promote into MODULES once the darwin + linux PNGs are captured.
  moog904a: 'VRT baseline pending — deterministic beige Moog faceplate (2 knobs + 3-position RANGE switch, no canvas/animation); capture via `task vrt:update` on each platform. DSP unit + ART (SHA-pinned self-osc) + per-module-per-port e2e provide coverage. Promote into MODULES once darwin + linux baselines land.',
  // MOOG 911 EG — Moog System 55/35 contour generator. Deterministic beige
  // faceplate (4 knobs: T1 / T2 / ESUS / T3, no canvas / animation) like the
  // 921; baselines pending a `task vrt:update` run on each platform. DSP unit
  // (moog911.test.ts worklet — 3-stage contour) + ART (source-SHA-pinned
  // .f32) + per-module-per-port e2e (gate-driven env emit) provide functional
  // coverage. Promote into MODULES once darwin + linux PNGs are captured.
  moog911: 'VRT baseline pending — deterministic beige Moog faceplate (4 knobs T1/T2/ESUS/T3, no canvas/animation); capture via `task vrt:update` on each platform. DSP unit + ART (SHA-pinned) + per-module-per-port e2e provide coverage. Promote into MODULES once darwin + linux baselines land.',
  // MOOG 902 VCA — Moog System 55/35 clone slice 3. Same shape as the 921 +
  // 904A: a deterministic beige faceplate (2 knobs + a 2-position LIN/EXP
  // switch, no canvas / animation), so a good VRT candidate; baselines are
  // pending a `task vrt:update` run on each platform (this authoring worktree
  // can't reliably boot the full dev server for capture). DSP unit
  // (moog902.test.ts: gain-law + ×2-at-6V + ×3-ceiling + CV summing + inverted
  // output) + ART (source-SHA-pinned .f32) + per-module-per-port e2e provide
  // functional coverage. Promote into MODULES once the darwin + linux PNGs are
  // captured.
  moog902: 'VRT baseline pending — deterministic beige Moog faceplate (2 knobs + 2-position LIN/EXP switch, no canvas/animation); capture via `task vrt:update` on each platform. DSP unit + ART (SHA-pinned) + per-module-per-port e2e provide coverage. Promote into MODULES once darwin + linux baselines land.',
  // PAINTER (new video module) — VRT baseline pending (the new-module pattern).
  // The card is an interactive MS-Paint surface; its drawing canvas content is
  // user/op-driven (not deterministic at first paint), and CI runs linux-only so
  // a darwin baseline can\'t be captured from this authoring machine. Functional
  // coverage: painter.test.ts (palette/coerceOps/applyVectorOp/floodFill PCU) +
  // per-module-per-port (handle presence + OUT emits) + painter.spec.ts (the real
  // draw → canvas → synced-op chain + FILL + CLEAR). Promote into MODULES once a
  // deterministic darwin + linux baseline is captured via `vrt-update.yml`
  // (mask the canvas, like the other canvas cards above).
  painter: 'VRT baseline pending — interactive MS-Paint canvas (op-driven, non-deterministic first paint); covered by painter.test.ts (PCU) + per-module-per-port + painter.spec.ts (draw/fill/clear). Promote into MODULES with a canvas mask once darwin + linux baselines land via vrt-update.yml.',
  // MOOG 921A / 921B / 904B (batch 1) — PROMOTED out of EXEMPT_FROM_VRT: darwin
  // baselines captured in this PR (the shared MoogPanel label fix is what makes
  // the engraved-black control captions legible on the beige faceplate, so the
  // baselines pin the FIXED appearance). All three are deterministic beige Moog
  // faceplates (knobs + a discrete RANGE/SYNC switch, no canvas / animation).
  // Linux baselines are darwin-only for now — see EXEMPT_BASELINE_PAIRS
  // (linux/moog921a, linux/moog921b, linux/moog904b) pending a `task vrt:update`
  // run on linux CI. DSP unit + ART (source-SHA-pinned .f32) + per-module-
  // per-port e2e provide the functional coverage.
  // TWOTRACKS — 2-reel tape-loop emulator (P1). Waveform canvases are masked
  // (see MODULES canvas entry above). The card chrome (buttons/knobs/LEDs/labels)
  // is deterministic but VRT baselines are pending a `task vrt:update` run on
  // each platform. Unit (transport state machine) + e2e (record→play RMS assert)
  // + per-module-per-port provide functional coverage. Promote + capture baselines
  // once darwin + linux PNGs are captured via vrt-update.yml workflow_dispatch.
  twotracks: 'VRT baseline pending — 2-reel tape-loop emulator P1. Waveform canvas masked in MODULES. Unit (transport) + e2e (record→play→SCOPE RMS) + per-module-per-port cover function. Promote once darwin + linux baselines captured via vrt-update.yml.',
  // BACKDRAFT (video feedback generator) — given FULL OUTPUT CAPABILITIES in
  // this PR (corner-resize + Full Frame / Full Screen / Present on other
  // display, mirroring videoOut/bentbox). The card is now USER-RESIZABLE, so the
  // preview canvas has a variable size + the chrome (resize handle, 2-col
  // layout, default 720×540 footprint) changed — the prior frozen-feedback
  // darwin baseline is stale, and like the other resizable video cards
  // (ruttetra/videoOut/toybox) the live feedback preview is non-deterministic
  // (it's MASKED in VRT_MODULE_MASKS above; the deterministic frozen capture
  // lives in VRT_SCENES.backdraft for a future re-promotion). Functional
  // coverage: backdraft.test.ts (PCU) + e2e/tests/backdraft.spec.ts (feedback
  // render / freeze / spatial-transform / pixelate / mirror / clk-override /
  // faders) + e2e/tests/backdraft-full-output.spec.ts (resize + Full Frame /
  // Full Screen / Present menu). Promote back into MODULES (canvas masked) +
  // capture fresh darwin/linux baselines via vrt-update.yml in a follow-up PR.
  backdraft: 'given full output capabilities (corner-resize + Full Frame/Full Screen/Present) so the preview is now variable-size + non-deterministic (live feedback), like ruttetra/videoOut/toybox — masked in VRT_MODULE_MASKS, deterministic capture in VRT_SCENES.backdraft. Unit (backdraft.test.ts) + e2e (backdraft.spec.ts + backdraft-full-output.spec.ts) provide coverage. Re-capture darwin/linux baselines via vrt-update.yml in a follow-up.',
  // SPIROGRAPHS is intentionally NOT exempt: its live drifting/bouncing OUT
  // preview canvas is MASKED in VRT_MODULE_MASKS above, and the deterministic
  // card chrome (COUNT fader + 1/2/3 spiro selector + IN/OUT toggle + chroma
  // colorwheel + per-spiro fader bank + sectioned PatchPanel) ships dual-platform
  // baselines (captured via vrt-update.yml). New modules don't grow this list.
};

/** Strict VRT subset — the deterministic, pure-DOM/CSS knob-and-fader cards
 *  that ship a baseline on BOTH platforms (darwin + linux), aren't masked
 *  for canvas non-determinism, and aren't in EXEMPT_BASELINE_PAIRS pending a
 *  fresh capture. These are the ones safe to promote into `task ci` as a
 *  required gate — a diff here is virtually guaranteed to be a real UI
 *  regression, not platform/GPU/timing flake.
 *
 *  Driven by `VRT_STRICT=1` (see e2e/vrt/vrt.spec.ts + `task vrt:strict` in
 *  the root Taskfile). The full `task vrt` sweep continues to cover the
 *  canvas-driven + darwin-only + linux-pending cards as the informational
 *  lane.
 *
 *  Promotion rules (add to this set when ALL conditions hold):
 *    1. Module has a baseline PNG on BOTH platforms.
 *    2. Module is NOT in VRT_MODULE_MASKS (no canvas mask → diff is
 *       semantically meaningful end-to-end).
 *    3. Module is NOT in EXEMPT_BASELINE_PAIRS for either platform (no
 *       pending re-capture; both baselines reflect current UI).
 *    4. Card has no animated chrome (LED pulse, blinking cursor, time-
 *       driven readouts). Pure CSS-styled knobs/faders/ports only.
 *
 *  Demotion rule: if a strict card flakes ONCE in CI, demote it back to
 *  the full lane and root-cause. Per memory `feedback_no_flake_tolerance`:
 *  a strict subset that flakes IS a flake to fix; the whole point of the
 *  lane is signal. */
export const STRICT_VRT_MODULES = new Set<string>([
  // Audio domain — pure knob/fader cards, no canvas
  'adsr',                 // 4-knob envelope card
  // analogVco: removed from strict lane — the card now carries a live
  // single-cycle waveform scope (animated canvas off the morph output), which
  // disqualifies it from the no-animated-chrome strict subset. It stays in
  // the full VRT lane with the scope canvas masked (see VRT_MODULE_MASKS).
  // audioOut: removed from strict lane. This PR added the OUT device
  // dropdown row (setSinkId picker), growing the card from 320x313 to
  // 360x401. The darwin baseline was re-captured (f1cd0e5f); the linux
  // baseline still shows the old 320x313 layout (pre-device-picker).
  // Re-add once linux baseline is re-captured + linux/audioOut removed
  // from EXEMPT_BASELINE_PAIRS.
  'buggles',              // bug-themed audio card
  'cartesian',            // X/Y grid sequencer card (S&H header toggle; linux baseline regenerated)
  'charlottesEchos',      // delay/echo knob card
  'destroy',              // destruction/distortion knob card
  'drummergirl',          // drum-sample card (chrome only — sample preview is static post-load)
  'drumseqz',             // 16-step drum sequencer (static at step 0 with no playhead)
  'dx7',                  // DX7 FM synth card (operator grid)
  'filter',               // filter knob card
  'illogic',              // logic-gate knob card
  'meowbox',              // meow-themed card
  'mixer',                // 4-channel mixer fader card
  'mixmstrs',             // master mixer fader card
  'noise',                // noise-source knob card
  'polyseqz',             // poly chord sequencer card (S&H header toggle; linux baseline regenerated)
  'qbrt',                 // q-bit/quantizer knob card
  'reverb',               // reverb knob card
  'score',                // score/note display card
  'sequencer',            // 32-step sequencer card (S&H header toggle; linux baseline regenerated)
  'shimmershine',         // shimmer-reverb knob card
  'stereovca',            // stereo VCA fader card
  'sticky',               // sticky-note widget (static)
  // timelorde: TEMPORARILY demoted from the strict lane. The card big display
  // is the owner's OWL PAINTING whose YELLOW EYES + BLUE BORDER beat-pulse
  // (the colour boost is FROZEN to the idle/steady owl under
  // prefers-reduced-motion, so the capture IS deterministic) + an owl toggle +
  // a gate input row. The darwin baseline was regenerated, but the linux
  // baseline is pending a `vrt-update.yml` workflow_dispatch (see
  // EXEMPT_BASELINE_PAIRS → linux/timelorde). The strict lane requires BOTH
  // platform baselines current (vrt-meta self-test), so timelorde rides the
  // full (informational) VRT lane until the linux baseline lands — then
  // re-add it here + drop linux/timelorde from EXEMPT_BASELINE_PAIRS.
  'vca',                  // mono VCA card
  'wavecel',              // wave-cell knob card
  'wavetableVco',         // wavetable VCO card
  // CV-utility cards — promoted to the strict gate after Track-2 batch 1 (#951)
  // captured + validated their linux baselines (both platforms now committed;
  // pure-DOM, ≤1 knob, no canvas → deterministic). They diff on darwin+linux.
  'depolarizer',          // bipolar→unipolar CV util (DEPTH knob)
  'polarizer',            // unipolar→bipolar CV util (DEPTH knob)
  'scaler',               // 1-in/1-out CV multiplier (AMOUNT knob)
  // MOOG cluster — promoted to the strict gate after Track-2 batch 2 (#953)
  // captured + validated their linux baselines (both platforms; deterministic
  // beige-faceplate knob/fader/seq cards, no canvas/animation). 20 cards.
  'moog903a',             // random-source card
  'moog904b',             // band-pass filter
  'moog904c',             // hi/lo coupler
  'moog905',              // spring reverb
  'moog907a',             // fixed filter bank (System 35)
  'moog911a',             // dual trigger delay
  'moog912',              // envelope follower
  'moog914',              // extended fixed filter bank (1/3-oct band column)
  'moog921a',             // oscillator driver
  'moog921b',             // oscillator
  'moog923',              // noise/filter
  'moog956',              // ribbon controller
  'moog960',              // sequential controller (8×3 step grid)
  'moog961',              // interface
  'moog962',              // sequential switch
  'moog984',              // 4×4 matrix mixer
  'moog992',              // control voltages
  'moog993',              // trigger/envelope
  'moog994',              // multiples
  'moog995',              // attenuators
]);

/** Per-(platform, type) baselines intentionally missing while a follow-
 *  up CI capture lands the other platform's PNG. The exempted pair is
 *  SKIPPED at the test level rather than allowed to fail. */
export const EXEMPT_BASELINE_PAIRS = new Set<string>([
  // CLIPPLAYER: darwin baseline (the clip-launcher card — 8×8 launch grid +
  // piano-roll note editor + transport knobs; no animated canvas) captured
  // locally; linux baseline pending a `vrt-update.yml` workflow_dispatch on
  // this branch. Functional coverage is clip-types.test.ts + clipplayer.test.ts
  // (def + factory launch/quantized-switch/stop via the real tick loop) + the
  // per-module-per-port + behavioral sweeps + the bespoke real-source-chain
  // clipplayer.spec.ts (TIMELORDE → clip → voice → audible RMS).
  'linux/clipplayer',
  // KRIA: darwin baseline (the 4-track grid sequencer card — track/page
  // selectors + a 16-step editor grid + a 16-slot pattern strip + BPM knob; no
  // animated canvas) captured locally; linux baseline pending a `vrt-update.yml`
  // workflow_dispatch on this branch (same pattern as CLIPPLAYER above).
  // Functional coverage is kria-types.test.ts + kria.test.ts (def + factory
  // 4-track tick loop / pattern-cue quantize / reset) + kria-grid.test.ts (grid
  // binding edits + LED frame) + the per-module-per-port + behavioral sweeps +
  // the bespoke real-source-chain kria.spec.ts (TIMELORDE → KRIA → voice → RMS).
  'linux/kria',
  // SCALER / POLARIZER / DEPOLARIZER: the tiny CV-utility cards
  // (1-in/1-out, ≤1 knob, no canvas) — linux baselines CAPTURED (vrt-update.yml
  // linux dispatch), so their pairs are dropped from here: they now DIFF on both
  // platforms in the full `vrt` lane (informational). First Track-2 linux-coverage
  // batch; once these prove stable on CI they get promoted to STRICT_VRT_MODULES.
  // RINGBACK: darwin baseline (the static stereo-crush card — title + subtitle +
  // L/R IN + L/R OUT handles + RATE/SIZE/FB/MIX knobs; no animated canvas)
  // captured locally; linux baseline pending a `vrt-update.yml`
  // workflow_dispatch on this branch. Functional coverage is ringback-core.test.ts
  // (the crush DSP) + ringback.test.ts (def + factory) + the per-port sweep +
  // the bespoke ringback.spec.ts (real VCO → stereo in → audible RMS at L/R out).
  'linux/ringback',
  // SPECTROGRAPH: darwin baseline (the scrolling-sonogram card — its live
  // preview canvas is DE-EXEMPTED via the __spectrographVrtFreeze scene in
  // vrt-scenes.ts, which fills the buffer from a FIXED synthetic spectrum so
  // the preview is pixel-stable; plus the deterministic chrome: title + GAIN
  // knob + COLOR/B-W view toggle + the yellow PatchPanel IN/COLOR/B-W
  // drill-down) captured locally; linux baseline pending a `vrt-update.yml`
  // workflow_dispatch on this branch (same new-module pattern as RECORDERBOX
  // above). Functional coverage is spectrograph-draw.test.ts (the pure
  // log-bin + heat/inverted-grayscale colormap core) + the per-module-per-port
  // + behavioral sweeps + the bespoke spectrograph.spec.ts (real VCO → IN →
  // COLOR/B-W OUT → non-black structured frame at the video OUTPUT).
  'linux/spectrograph',
  // FEATURECV: darwin baseline (the audio→CV feature-extractor card — title +
  // LOUD/BRIGHT/PUNCH meter bars + ONSET led (all snapshot-driven; with nothing
  // patched the features read 0 so the chrome is pixel-stable, NO canvas to
  // mask) + GAIN/ATK/REL knobs + the BI/UNI polarity toggle + SENS/DEBNCE knobs
  // over the yellow PatchPanel IN/LOUD/BRIGHT/PUNCH/ONSET drill-down) captured
  // locally; linux baseline pending a `vrt-update.yml` workflow_dispatch on this
  // branch (same new-module pattern as SPECTROGRAPH above). Functional coverage
  // is featurecv-dsp.test.ts (the pure rms/zcr/crest/flux/onset core) + the ART
  // scenario + the per-module-per-port + behavioral sweeps + the bespoke
  // featurecv-source-chain.spec.ts (noise → featurecv.bright → filter.cutoff →
  // audible RMS change).
  'linux/featurecv',
  // OUTLINES (was CIRCLES): the card gained a SHAPE selector + ROTATION knob
  // (+ their CV input rows + small readouts), so the deterministic chrome
  // changed and the baseline was regenerated. The live COMBINE preview canvas
  // is masked, so the chrome (7 knobs D/V/SPD/DEC/SHP/ROT/RATE +
  // GATE/COL/D/V/SPD/DEC/SHP/ROT/VID input rows + OVR/CNT/CMB/MAP output rows)
  // is the gate. Darwin baseline regenerated locally; linux pending a
  // `vrt-update.yml` workflow_dispatch on this branch. Functional coverage is
  // outlines.test.ts + outlines.spec.ts + the per-module-per-port + behavioral
  // sweeps.
  'linux/outlines',
  // RECORDERBOX: darwin baseline (the recorder sink card — preview canvas
  // masked, deterministic chrome: title + IN/OUT/A·L/A·R handles + FILE field
  // + RECORD button) captured locally; linux baseline pending a
  // `vrt-update.yml` workflow_dispatch on this branch. Functional coverage is
  // recorderbox.test.ts + recorderbox-recorder.test.ts + the per-port sweep +
  // the bespoke recorderbox.spec.ts (real VCO + ACIDWARP → finalized MP4 +
  // crash-recovery).
  'linux/recorderbox',
  // SYNESTHESIA: darwin baseline captured on this machine via VRT_SCENES
  // (analogVco→a_in, band 2 lit, freeze-on-suspend). Linux baseline pending a
  // `task vrt:update` run on linux CI; functional coverage is the
  // synesthesia-dsp + worklet unit tests.
  'linux/synesthesia',
  // FLIPPER: darwin baseline captured locally; linux pending a `task vrt:update`
  // on linux CI. Static card (no animation); functional coverage is
  // flipper-dsp.test.ts.
  'linux/flipper',
  'linux/macrooscillator',
  // PENTEMELODICA: darwin baseline (the 5-voice card: 5 strips + mixer +
  // filter, static computed waveform previews — no animated canvas) captured
  // locally; linux baseline pending a `vrt-update.yml` workflow_dispatch on
  // this branch. Functional coverage is pentemelodica-dsp.test.ts +
  // pentemelodica.test.ts + the per-port sweep + the bespoke e2e.
  'linux/pentemelodica',
  'linux/samsloop',
  'linux/stages',
  // SCOPE: this PR re-captures the darwin baseline with deterministic
  // audio content (via VRT_SCENES). The linux baseline still shows the
  // old magenta-masked canvas — a follow-up `task vrt:update` run on
  // linux will re-capture, then this entry comes out.
  'linux/scope',
  // SCOPE X/Y + INTENSITY scenes (vrt-scope-modes.spec.ts): darwin baselines
  // captured here; linux pending a `task vrt:update` on linux CI (same as the
  // base `linux/scope` card above). Without these the new scenes run on linux
  // with no baseline and fail the required VRT check.
  'linux/scope-xy-lissajous',
  'linux/scope-intensity-dot',
  'linux/scope-intensity-long',
  // VIDEO-OUT: this PR re-captures the darwin baseline with a real,
  // frozen VIDEOBOX frame driven through the output (via VRT_SCENES) to
  // prove the VIDEOBOX -> VIDEO-OUT path renders video content. VP9
  // decode isn't bit-identical across platforms, so the linux baseline
  // is pending a `task vrt:update` run on linux CI; the hard non-black +
  // moving gate is e2e/tests/videobox-output.spec.ts.
  'linux/videoOut',
  // RASTERIZE (crossing-the-streams slice 1): the darwin baseline is
  // captured on this machine via VRT_SCENES with the deterministic
  // `__rasterizeVrtSeed` seed (fix for task #198 — see rasterize.ts +
  // vrt-scenes.ts). The seed makes the painted frame bit-deterministic
  // (synthetic 261 Hz sine, no analyser / no wall clock), so both
  // platforms render identical CANVAS pixels — only the surrounding
  // chrome AA differs across platforms. Linux baseline pending a
  // `task vrt:update` run on linux CI to capture that chrome.
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
  // CUBE (3D wavetable-navigator oscillator, first slice): darwin baseline
  // captured on this machine via VRT_SCENES (analogVco → pitch, rotated/morphed
  // slice through the default tables, freeze-on-suspend so the snapshot-driven
  // 2D viz holds). The 2D surface-height + waveform canvases differ
  // sub-thresholdly across platforms (canvas AA), so the linux baseline is
  // pending a `task vrt:update` run on linux CI — functional coverage is the
  // cube-dsp unit tests + cube worklet capture test + node-ART baselines +
  // the per-port e2e. NOT in STRICT_VRT_MODULES (the missing linux baseline
  // runs only in the informational full-VRT lane, not the merge gate).
  'linux/cube',
  // HYPERCUBE (the 4D tesseract sibling of CUBE): same canvas-AA story as cube
  // — a live WebGL2 Schlegel-tesseract render + a snapshot-driven 2D viz, so the
  // canvases are masked and the darwin baseline was captured in this PR. Linux
  // baseline is pending a `task vrt:update` run on linux CI. Functional coverage
  // = the shared cube-dsp HYPERCUBE unit tests (off=identity + alpha audibility)
  // + the hypercube worklet capture test + the hypercube node-ART baselines +
  // the per-port e2e. NOT in STRICT_VRT_MODULES.
  'linux/hypercube',
  // AUDIO OUT (device picker dropdown added): the card grew an OUT device
  // dropdown row (setSinkId picker) so the darwin baseline was regen'd in
  // this PR. Linux baseline pending a `task vrt:update` run on linux CI.
  'linux/audioOut',
  // ANALOG VCO (live waveform scope + Wave morph knob added): the card grew a
  // single-cycle scope canvas at the top + a 6th fader (Wave), so the darwin
  // baseline was re-captured in this PR (canvas masked). Linux baseline pending
  // a `task vrt:update` run on linux CI. Module also moved out of the strict
  // VRT lane (animated chrome).
  'linux/analogVco',
  // BACKDRAFT — moved to EXEMPT_FROM_VRT (above) when it gained full output
  // capabilities (corner-resize + Full Frame/Full Screen/Present): the preview
  // is now variable-size + non-deterministic, so the whole module is exempt
  // pending a fresh darwin/linux baseline. The stale darwin baseline PNG was
  // deleted; this linux/backdraft pair is no longer needed.
  // LFO (DEPTH knob added): the card grew a knob row + DEPTH input port, so
  // the darwin baseline is re-captured here. The linux baseline is pending a
  // `task vrt:update` run on linux CI (this dev machine is darwin-only).
  'linux/lfo',
  // COFEFVE DELAY (own-code analog delay, replaced COCOA DELAY): darwin
  // baseline captured on this machine (static knob/fader/dropdown card — no
  // canvas/animation, so it's deterministic). The linux baseline is pending a
  // `task vrt:update` run on linux CI (sub-pixel text AA differs across
  // platforms); darwin is the regression gate here.
  'linux/cofefve',
  // RESOFILTER (Resonarium MultiFilter port): darwin baseline captured on this
  // machine (static knob card — no canvas/animation, deterministic). Linux
  // baseline pending a `task vrt:update` run on linux CI (sub-pixel AA differs
  // across platforms); darwin is the regression gate here.
  'linux/resofilter',
  // SAMPLE & HOLD / quantizer: darwin baseline captured on this machine
  // (static SCALE-knob card + scale-name label — no canvas/animation, so it's
  // deterministic). Linux baseline pending a `task vrt:update` run on linux CI
  // (sub-pixel text AA differs across platforms); darwin is the regression gate
  // here. Functional coverage is the sample-hold-dsp unit tests + the worklet
  // capture test + the composite ART scenario + e2e/tests/sample-hold.spec.ts.
  'linux/sampleHold',
  // FOXY (hybrid SWOLEVCO→RASTERIZE→XYZ→live-wavetable→WAVECEL): darwin
  // baseline captured on this machine via VRT_SCENES (self-driving internal
  // chain, frozen on AudioContext suspend). The pipeline mixes the
  // AudioContext sine-table + analyser refill timing (raster) with CPU
  // float math (XYZ field + wavetable), which can differ sub-thresholdly
  // across platforms, so the linux baseline is pending a `task vrt:update`
  // run on linux CI; the deterministic darwin capture is the gate here.
  'linux/foxy',
  // PEAKSTATE (animated mandala generator): darwin baseline captured on this
  // machine via VRT_SCENES (self-driving internal pen + ring, frozen on the
  // `__peakstateVrtSeed` flag → one deterministic 120-sample paint then no
  // further advance). The 2D canvas-to-GL upload + bilinear-filtered blit
  // can differ sub-thresholdly across GPU drivers, so the linux baseline is
  // pending a `task vrt:update` run on linux CI; the deterministic darwin
  // capture is the regression gate here.
  'linux/peakstate',
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
  // EDGES (Sobel edge-detection video processor): deterministic card chrome
  // (IN/threshold/thickness handles + 2 faders, no canvas/animation), so it
  // ships a REAL solo-spawn baseline. Darwin baseline captured on this
  // machine; linux baseline pending a `vrt-update.yml` workflow_dispatch on
  // this branch (sub-pixel text AA differs across platforms) — darwin is the
  // regression gate here. The edge-render correctness is proven by the pure
  // Sobel/threshold/thickness unit suite (edges.test.ts) + the bespoke
  // e2e/tests/edges.spec.ts (SHAPES → EDGES → OUTPUT shows edges; raising
  // threshold drops edge pixels; raising thickness adds them).
  'linux/edges',
  // LUSH GARDEN (generative garden video source): ships a REAL deterministic
  // baseline via the VRT_SCENES.lushgarden seeded scene (__lushgardenVrtSeed
  // → fixed fully-grown 24-plant set, spawning suppressed, capture waits for
  // every referenced cutout bake to settle). Darwin baseline captured on this
  // machine; linux baseline pending a `vrt-update.yml` workflow_dispatch on
  // this branch — darwin is the regression gate here. Garden behavior is
  // additionally proven by the pure scene-math unit suite
  // (lushgarden-scene.test.ts) + the bespoke e2e/tests/lushgarden.spec.ts
  // (continuous spawn / gated growth / reset / background passthrough).
  'linux/lushgarden',
  // MAPPER (video keyer / matte processor — generalises OUTLINES' `mapped`
  // output to an arbitrary key): deterministic card chrome (VID/KEY/threshold
  // handles + 1 fader, no canvas/animation), so it ships a REAL solo-spawn
  // baseline. Darwin baseline captured on this machine; linux baseline pending
  // a `vrt-update.yml` workflow_dispatch on this branch (sub-pixel text AA
  // differs across platforms) — darwin is the regression gate here. The keyer
  // correctness is proven by the pure luma/mask/pixel unit suite
  // (mapper.test.ts) + the bespoke e2e/tests/mapper.spec.ts (SHAPES key +
  // ACIDWARP video → MAPPER → OUTPUT shows the video only in the keyed region;
  // raising threshold shrinks the keyed area).
  'linux/mapper',
  'linux/monoglitch',
  'linux/shapedramps',
  'linux/unityscalemathematik',
  'linux/vdelay',
  'linux/warrenspectrum',
  // FREEZEFRAME (video sample & hold + per-channel posterize): darwin
  // baseline captured on this machine (live preview canvas masked — see
  // VRT_MODULE_MASKS). linux baseline pending a `task vrt:update` run on
  // linux CI; the deterministic chrome (4 QUANT knobs + 7 handle rows) is
  // the same across platforms but the masked-canvas chrome PNG can shift
  // sub-thresholdly under linux Chromium timing.
  'linux/freezeframe',
  // CELLSHADE (cel-shader video processor): darwin baseline captured on this
  // machine (live OUT preview canvas masked — see VRT_MODULE_MASKS). linux
  // baseline pending a `vrt-update.yml` workflow_dispatch on this branch;
  // the deterministic chrome (THRESH/THICK/BITS faders + 5 handle rows + the
  // BITS readout) is the same across platforms but the masked-canvas chrome
  // PNG can shift sub-thresholdly under linux Chromium timing. The quantize +
  // edge-ink correctness is proven by cellshade.test.ts (CPU mirror) + the
  // bespoke e2e/tests/cellshade.spec.ts (posterize + ink + BITS/THRESH sweeps).
  'linux/cellshade',
  // TEXTMARQUEE (rich-text marquee video generator): darwin baseline captured
  // on this machine (the live OUT preview canvas is masked — see
  // VRT_MODULE_MASKS). The card embeds a contenteditable rich-text region whose
  // SYSTEM-FONT glyphs rasterize differently across platforms — the EXACT known
  // linux-VRT glyph nondeterminism ([[vrt-flake-1px-layout-rounding]] +
  // CLAUDE.md text-rendering note) — so the linux baseline is exempted rather
  // than fighting cross-platform font rasterization. The pos/scroll/wrap math +
  // the rich-text layout/measurement are proven cross-platform by
  // textmarquee-layout.test.ts (pure, deterministic), and the spawn/edit/CV
  // surface by textmarquee.spec.ts.
  'linux/textmarquee',
  // MANDLEBLOT (Mandelbrot fractal generator): darwin baseline captured on
  // this machine (canvas masked — the colour pass cycles hue with uTime, so
  // the canvas region is non-deterministic; the chrome around it diffs).
  // The linux baseline is pending a `task vrt:update` run on linux CI; the
  // shader pipeline is the same across platforms but Playwright's
  // `<canvas>` masking timing on linux Chromium can shift the chrome PNG
  // sub-thresholdly — darwin is the regression gate here.
  'linux/mandleblot',
  // MANDELBULB (WebGL2 ray-marched 3D fractal video source): darwin baseline
  // captured on this machine (live raymarch preview + auto-spin canvas masked
  // via VRT_MODULE_MASKS — every frame differs, so the canvas region is
  // non-deterministic; the chrome around it diffs). The linux baseline is
  // pending a `task vrt:update` run on linux CI; the shader pipeline is the
  // same across platforms but Playwright's `<canvas>` masking timing on linux
  // Chromium can shift the chrome PNG sub-thresholdly — darwin is the
  // regression gate here. Same rationale as MANDLEBLOT above.
  'linux/mandelbulb',
  // NIBBLES (new snake-game video module): darwin baseline captured on this
  // machine via VRT_SCENES (__nibblesVrtSeed pins the RNG → deterministic
  // snake + food placement; freezeAudio suspends the rAF preview poll). The
  // CPU rasteriser is bit-deterministic, but the captured frame depends on
  // how many game ticks land in the settle window which can vary sub-
  // thresholdly across platforms; linux baseline pending a `task vrt:update`
  // run on linux CI.
  'linux/nibbles',
  // TOYBOX (swappable fragment-shader source, Phase 1): darwin baseline
  // captured on this machine (live animated preview canvas masked via
  // VRT_MODULE_MASKS — the layer-0 shader runs off the engine clock, so the
  // canvas region is non-deterministic; the chrome around it diffs). The
  // linux baseline is pending a `task vrt:update` run on linux CI; the
  // shader pipeline is the same across platforms but the masked-canvas
  // chrome PNG can shift sub-thresholdly under linux Chromium timing —
  // darwin is the regression gate here. The dedicated frozen render proof
  // (real per-shader content, distinct across the 4 entries) lives in
  // e2e/vrt/vrt-toybox.spec.ts, also darwin-only by the same precedent.
  'linux/toybox',
  // TOYBOX Phase 4 (the bespoke SVG combine-graph editor): the combine-composite
  // frozen render + the deterministic editor-SVG capture are darwin baselines
  // captured locally; linux pending a `task vrt:update` on linux CI (same
  // shader/SVG pipeline, sub-threshold cross-platform paint timing). Functional
  // coverage: toybox-combine*.test.ts (graph mutations + Yjs round-trip) +
  // e2e/tests/toybox-combine-editor.spec.ts (add/connect/cycle-reject via real
  // clicks + a live-output delta).
  'linux/toybox-combine-composite',
  'linux/toybox-combine-editor',
  // TOYBOX Phase 6 texmap (OBJ surface = another layer's rendered output,
  // UV-mapped): the obj-tex-sphere (primitive uv) + obj-tex-teapot (zero-vt
  // PLANAR-UV fallback) frozen renders + the textured-sphere preset are darwin
  // baselines captured locally; linux pending a `task vrt:update` on linux CI
  // (same WebGL/shader pipeline, sub-threshold cross-platform paint timing).
  // Functional coverage: toybox-surface.test.ts (render-order + cycle/self
  // guard) + obj-parse.test.ts (planar-uv fallback) + the texmap e2e
  // (e2e/tests/toybox-texture-source.spec.ts).
  'linux/toybox-obj-tex-sphere',
  'linux/toybox-obj-tex-teapot',
  'linux/toybox-preset-textured-sphere',
  // TOYBOX content-bank expansion: representative frozen baselines for the new
  // GEN shader (truchet), the new builtin primitive (icosahedron, an OBJ-pass
  // render), and a FRAG shader over a base layer (frag-kaleido folds layer 0
  // via iChannel0). Darwin baselines captured locally; linux pending a
  // `task vrt:update` on linux CI (same WebGL/shader pipeline, sub-threshold
  // cross-platform paint timing). The remaining new shaders/builtins are
  // covered by toybox-manifest-integrity.test.ts + primitives.test.ts + the
  // live compile-smoke e2e — per-asset VRT baselines would bloat the gate.
  'linux/toybox-truchet',
  'linux/toybox-obj-icosahedron',
  'linux/toybox-frag-kaleido',
  // TOYBOX birds + the FLIGHTY animated scene: the flighty preset (a CC0 bird
  // flapping over the animated flighty-sky GEN, luma-keyed) + the bird-ernest
  // OBJ per-model baseline. Darwin baselines captured locally; linux pending a
  // `task vrt:update` on linux CI (same WebGL/shader pipeline — the flap is
  // plain vertex arithmetic + the sky is value-noise fBm, both renderer-
  // tolerant, but the masked-canvas paint timing shifts sub-thresholdly on
  // linux Chromium). Functional coverage: toybox-manifest-integrity.test.ts
  // (bird OBJs exist + licensed, flighty-sky GEN convention) +
  // toybox-presets.test.ts (flighty structure + cvRoutes) + the toybox e2e.
  'linux/toybox-preset-flighty',
  'linux/toybox-obj-bird-ernest',
  // COMPOSITE VRT — first category (vrt-composite.spec.ts). Captures
  // NIBBLES.length_cv → SCOPE.ch1 at 5 CV levels via the
  // `__nibblesForceLength` test hook. Darwin baselines captured on this
  // machine; the linux baselines depend on cross-platform paint timing of
  // BOTH cards in the same viewport — pending a `task vrt:update` run on
  // linux CI. The hard regression-coverage gate lives in
  // `e2e/tests/nibbles-cv-scope.spec.ts` (asserts SCOPE.ch1 sample tracks
  // lengthToCv(length) — i.e. the CV signal actually arrives at the SCOPE
  // input — and is monotonic across the 5-step sweep).
  'linux/nibbles-cv-min',
  'linux/nibbles-cv-25',
  'linux/nibbles-cv-50',
  'linux/nibbles-cv-75',
  'linux/nibbles-cv-max',
  // MOOG cluster (921a/921b/904b/992/993/994/995/984/903a/923/904c/907a/914/
  // 911a/961/962/912/960/956/905) — 20 deterministic beige-faceplate knob/fader/
  // seq cards (no canvas/animation). linux baselines CAPTURED via a linux-only
  // grep-scoped vrt-update.yml dispatch, so their pairs are dropped here: they
  // now diff on BOTH platforms in the full `vrt` lane. Track-2 batch 2; promoted
  // to STRICT_VRT_MODULES once proven stable on CI.
  // ELECTRA CONTROL — fixed 6×6 Electra-laid-out control surface. Unlike CONTROL
  // SURFACE (binding-dependent body → VRT-exempt), the empty grid is fully
  // DETERMINISTIC (fixed chrome + 3 bank groups + 36 dim placeholder dials, no
  // canvas/animation), so it ships a REAL baseline (not exempt). Darwin baseline
  // captured on this machine; linux baseline pending a `vrt-update.yml`
  // workflow_dispatch on this branch (sub-pixel text AA differs across
  // platforms) — darwin is the regression gate here. Functional coverage:
  // electra-control.test.ts (geometry + real-Y.Doc mutators) + the bespoke
  // electra-control.spec.ts (assign → grid → label → flash).
  'linux/electraControl',
  // ---- darwin-side QUARANTINE: pre-existing flakes verified on main
  // (reproduced by reverting the cards-shrink-to-fit CSS in PR #447 and
  // re-running VRT — same failures on a clean main checkout). Quarantined
  // here so #447 unblocks. ROOT-CAUSE fix is OWED on the tracked tasks
  // below — these entries come out when the fix lands.
  // rasterize: canvas-render timing variance flake, tracked as task #198
  'darwin/rasterize',
  // wavesculpt-blink-scopes-trial: canvas-render timing variance flake, tracked as task #202
  'darwin/wavesculpt-blink-scopes-trial',
  // wavesculpt-blink-scopes-trial-wiggle: canvas-render timing variance flake, tracked as task #202
  'darwin/wavesculpt-blink-scopes-trial-wiggle',
  // wavesculpt-blink-custom-colors: canvas-render timing variance flake, tracked as task #202
  'darwin/wavesculpt-blink-custom-colors',
  // QUADRALOGICAL Phase-2 per-edge effect VRT scenes (vrt-quadralogical.spec.ts):
  // darwin baselines captured on this machine (flat-colour sources → CHROMA
  // tintMix=1 → deterministic mix, frozen on quad.freeze + AudioContext
  // suspend). WebGL fragment blend math differs sub-thresholdly across GPU
  // drivers, so the linux baselines are pending a `vrt-update.yml`
  // workflow_dispatch on linux CI; the deterministic darwin captures are the
  // regression gate here. Functional coverage = quadralogical.test.ts (all 8
  // blend2 branches + edge-weight model) + e2e/tests/quadralogical.spec.ts
  // (per-edge effect distinctness + independence).
  'linux/edge-dissolve',
  'linux/edge-add',
  'linux/edge-multiply',
  'linux/edge-wipe',
  'linux/edge-chroma',
  'linux/edge-luma',
  'linux/edge-diff',
  'linux/edge-iris',
  // COLOUR OF MAGIC per-block composite VRT (vrt-colourofmagic.spec.ts): darwin
  // baselines captured locally (clock-pinned structured source → frozen frame).
  // WebGL colorspace decode math differs sub-thresholdly across GPU drivers, so
  // the linux baselines are pending a `vrt-update.yml` workflow_dispatch on
  // linux CI; the darwin captures are the regression gate here. Functional
  // coverage = colourofmagic-colorspace.test.ts + e2e/tests/colourofmagic.spec.ts.
  'linux/com-pass',
  'linux/com-rgb',
  'linux/com-ydbdr',
  'linux/com-hsv',
  'linux/com-yiq',
  'linux/com-ycc',
  'linux/com-yiq-i-tap',
  'linux/com-override',
  'linux/com-palette',
  // OUTPUT aspect 16:9 preview card (vrt-aspect-16x9.spec.ts): darwin baseline
  // captured locally; linux pending a `vrt-update.yml` workflow_dispatch on
  // linux CI. WebGL blit/AA differs sub-thresholdly across GPU drivers. The
  // in-place engine realloc + LINES→OUTPUT survival is covered functionally by
  // e2e/tests/video-aspect-switch.spec.ts; the geometry math by
  // video-res.test.ts.
  'linux/aspect16x9-output',
  // TIMELORDE: the card big display is the owner's OWL PAINTING (a bundled
  // static asset) whose YELLOW EYES + BLUE BORDER beat-pulse (a colour-keyed
  // brightness boost) + an owl show/hide toggle button + a `gate` input row.
  // The boost is FROZEN to the idle/steady owl under prefers-reduced-motion
  // (which the VRT runner sets) so the capture stays deterministic — but the
  // darwin baseline was regenerated for the new art and the linux baseline is
  // pending a `vrt-update.yml` workflow_dispatch on this branch (same pattern
  // as SCALER / OUTLINES above). Functional coverage: the pure
  // timelorde-wizard.test.ts (beat-pulse math, colour-key boost, gate→on/off,
  // display-mode) + timelorde.test.ts (gate→wizardOn factory write-through) +
  // the per-module-per-port sweep + timelorde-video.spec.ts (owl ↔ feed).
  'linux/timelorde',
  // NINE LIVES (2026-06-28): darwin baseline captured locally (the 9-output LFO
  // card is deterministic chrome — Rate + Waveform faders over the yellow
  // PatchPanel RESET/OUT1..OUT9 drill-down, NO canvas/animation); linux baseline
  // pending a `vrt-update.yml` workflow_dispatch on this branch (the darwin-first
  // new-module pattern, same as SCALER / RINGBACK / FEATURECV above). Functional
  // coverage: packages/dsp/src/lib/ninelives-dsp.test.ts (the ⅓ rate ladder +
  // reset re-sync + no-NaN sweep) + ninelives.test.ts (def shape + factory
  // wiring) + the per-module-per-port emit/handle sweep (all 9 outputs always
  // emit; reset accepts a gate source).
  'linux/ninelives',
  // KICK DRUM (2026-07-02): darwin baseline captured locally (the wide 3u
  // banded kick-voice card is deterministic chrome — SUB·BODY·CLICK /
  // DRIVE·EQ·TRANSLATE / DYNAMICS·STEREO·OUT fader bands + the HARD toggle
  // over the PatchPanel TRIG/ACC/V-OCT/CHOKE → OUT L/R drill-down, NO
  // canvas/animation); linux baseline pending a `vrt-update.yml`
  // workflow_dispatch on the PR branch (the darwin-first new-module pattern,
  // same as NINE LIVES / RINGBACK / FEATURECV above). Functional coverage:
  // packages/dsp/src/lib/kickdrum-dsp.test.ts (the pure Phase-1 core) +
  // kickdrum.test.ts (def contract + worklet stereo/choke/accent/level) +
  // the ART audio profile (art/scenarios/kickdrum/profile.test.ts) + the
  // per-module-per-port sweep + the bespoke real-source-chain
  // e2e/tests/kickdrum.spec.ts (SEQUENCER → trigger_in → AUDIOOUT, audible
  // RMS + sub-dominant spectrum).
  'linux/kickdrum',
  // SNARE DRUM (2026-07-04): darwin baseline captured locally (the wide 3u
  // banded snare-voice card is deterministic chrome — HEAD·BODY·WIRE /
  // CRACK·ROLL·DRIVE / STEREO·OUT fader bands + the HARD toggle over the
  // PatchPanel TRIG/ROLL/SPD/ACC/V-OCT/CHOKE → OUT L/R drill-down, NO
  // canvas/animation); linux baseline pending a `vrt-update.yml`
  // workflow_dispatch on the PR branch (the darwin-first new-module pattern,
  // same as KICK DRUM above). Functional coverage: the pure cores
  // packages/dsp/src/lib/snaredrum-dsp.test.ts + snare-roll-dsp.test.ts +
  // snaredrum.test.ts (def contract + worklet roll/choke/accent/stereo) + the
  // ART audio profile (art/scenarios/snaredrum/profile.test.ts) + the
  // per-module-per-port sweep + the bespoke real-source-chain
  // e2e/tests/snaredrum-roll.spec.ts (SEQUENCER → trigger_in single hit AND
  // held gate_in → sustained two-hand roll, audible stereo RMS on both L/R).
  'linux/snaredrum',
]);

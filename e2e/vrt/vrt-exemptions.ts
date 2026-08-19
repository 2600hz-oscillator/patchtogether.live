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
// the vrt-meta self-test enforces length > 40 so "TODO" and "no baseline"
// placeholders can't sneak in.
//
// Per-module-card MASK config also lives here, keyed by module type.
// Masks fill non-deterministic regions (animated canvas, scope sweep,
// camera frames) with a uniform colour in both baseline + actual
// before pixel-diff, so the chrome around the canvas still asserts.
// Every MaskRect carries a REQUIRED `why` naming the cause — see MaskRect.

export interface MaskRect {
  selector: string;
  /**
   * REQUIRED. What is non-deterministic about this region, and what gates the
   * card instead. A mask DELETES pixels from the diff with nothing replacing
   * them — the card can render that region blank forever and still pass — so
   * every one is a reviewed decision and the reason lives beside the selector.
   *
   * ⚠ This field replaced `LEGACY_UNCOMPANIONED_MASK_CEILING = 12`
   * (vrt-live-surfaces.test.ts, deleted 2026-08-10). The ceiling counted how
   * many of these masks had no companion assertion and could say nothing about
   * any of them — the measured table it carried (masked area ÷ card area, four
   * entries larger than the worst mask the live-surface registry argues for)
   * had to be written in a comment because the number could not express it.
   * A name with a reason is checkable; a number is not.
   *
   * PREFER A COMPANION. `e2e/vrt/vrt-live-surfaces.ts` masks the same region
   * but pairs it with a measured ink/variance assertion plus a per-run negative
   * control, so a region that goes blank is RED instead of green. Migrating an
   * entry there is strictly better than writing a better `why` here.
   */
  why: string;
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
  //
  // ⚠ DELETED, NOT MOVED — 10 entries were DEAD SELECTORS. Measured
  // 2026-07-31 with the VRT_PROBE tool: spawned the way vrt.spec.ts spawns
  // them, these cards contain ZERO <canvas> elements, so `{ selector:
  // 'canvas' }` matched nothing and masked nothing. The entries read as "this
  // region is handled" while the card was already being diffed in full. The
  // canvases were removed from the cards at some point and the table was never
  // swept. Removing them is a strict no-op at capture time.
  //   swolevco, lines, inwards, picturebox, destructor, colorizer, videoMixer,
  //   shapes, shapedramps, vdelay  — confirmed 0 canvases each
  //   (`grep -c canvas <Card>.svelte` = 0 for all of them).
  //
  // MIGRATED to e2e/vrt/vrt-live-surfaces.ts (same mask, now with a measured
  // companion + a per-run negative control, so the region can no longer go
  // blank unnoticed): cube, mandelbulb, reshaper,
  // toybox, analogVco.
  //
  // SAMSLOOP — loop-based WAV sample player. The waveform canvas is
  // static after upload, but unloaded shows "NO SAMPLE LOADED" text —
  // mask the canvas so the chrome diffs deterministically.
  samsloop: [
    { selector: 'canvas', why: 'the waveform canvas is empty on a fresh spawn and shows only placeholder text until a WAV is loaded, so it is not a stable render; the card chrome is the gate.' },
  ],
  // TWOTRACKS — 2-reel tape-loop emulator. Each reel has a waveform
  // canvas (empty on fresh spawn); mask both canvases so the card chrome
  // diffs deterministically.
  twotracks: [
    { selector: 'canvas', why: 'both reel waveform canvases are empty on a fresh spawn; the transport + reel chrome is the gate.' },
  ],
  // TILER: live tiled-OUT preview canvas (non-deterministic per frame) — mask it;
  // the card chrome (TILE fader + PatchPanel) is VRT'd. Baseline via vrt-update.
  tiler: [
    { selector: 'canvas', why: 'live tiled-OUT preview canvas, a different frame every rAF; the TILE fader + PatchPanel chrome is the gate.' },
  ],
  // VFPGA-RUNNER — host card with a live preview canvas + per-CV always-on
  // scope canvases (both animate off the card rAF), so mask every canvas and
  // gate on the deterministic chrome (preset select + param knob grid + CV
  // SCALE/OFFSET knobs + gate LEDs + port handle rows). Currently in
  // EXEMPT_FROM_VRT below; the mask covers the canvases if promoted into
  // MODULES once darwin/linux baselines are captured.
  vfpgaRunner: [
    { selector: 'canvas', why: 'a live preview canvas plus per-CV always-on scope canvases, all animating off the card rAF; the preset select, knob grid and gate LEDs are the gate.' },
  ],
  // OUTLINES — stateful particle generator; the card carries a live COMBINE
  // preview canvas (shapes spawn + move + spin off the engine rAF), so the
  // canvas region is non-deterministic in the standard solo-spawn VRT. Mask it
  // and gate on the deterministic chrome (7 knobs D/V/SPD/DEC/SHP/ROT/RATE +
  // GATE/COL/D/V/SPD/DEC/SHP/ROT/VID input rows + OVR/CNT/CMB/MAP output rows +
  // the SHAPE/ROT readouts). Promoted into the VRT baseline set (the canvas mask
  // covers the live preview). There is ONE baseline, authored by the
  // vrt-update.yml dispatch on linux CI — the split that used to be described
  // here ("only the DARWIN baseline was regenerated after the SHAPE+ROTATION
  // card change; the LINUX one is still pending") is exactly the two-population
  // problem the {platform} collapse removed, and it cannot recur.
  outlines: [
    { selector: 'canvas', why: 'live COMBINE preview canvas — particles spawn, move and spin off the engine rAF; the 7 knobs + handle rows are the gate.' },
  ],
  videoOut: [
    { selector: 'canvas', why: 'the output canvas renders whatever is patched into it and repaints off the engine clock; the solo-spawn chrome is the gate.' },
  ],
  // RECORDERBOX — live preview canvas (+ a hidden full-res capture canvas,
  // off-screen at left:-9999px so its mask rect lands outside the captured
  // card box). Mask the canvas + gate on the deterministic chrome (title,
  // IN/OUT/A·L/A·R handles, FILE field, RECORD button).
  recorderbox: [
    { selector: 'canvas', why: 'a live preview canvas blitted off the engine clock, plus a hidden off-screen full-res capture canvas; the title, handles, FILE field and RECORD button are the gate.' },
  ],
  chroma: [
    { selector: 'canvas', why: 'live keyed-output preview canvas repainting off the engine clock; the key controls and handle rows are the gate.' },
  ],
  luma: [
    { selector: 'canvas', why: 'live keyed-output preview canvas repainting off the engine clock; the key controls and handle rows are the gate.' },
  ],
  feedback: [
    { selector: 'canvas', why: 'a live video feedback render loop that never reaches a fixed point, so no two frames match; the fader + handle chrome is the gate.' },
  ],
  // SPIROGRAPHS — live spirograph generator with a continuously-animated OUT
  // preview canvas (each spiro's center drifts + bounces every frame off the
  // engine clock). Mask the canvas so the deterministic chrome (COUNT fader +
  // 1/2/3 spiro selector + IN/OUT toggle + chroma colorwheel + per-spiro fader
  // bank + the sectioned PatchPanel) is the regression gate.
  //
  // ⚠ THE "Currently in EXEMPT_FROM_VRT below" NOTE THAT USED TO SIT HERE WAS
  // STALE AND IT COST A WRONG PREDICTION (2026-08-18). `spirographs` is NOT in
  // that list — it has a real card baseline (`vrt.spec.ts/spirographs.png`) and
  // this mask is what makes it deterministic. Predicting a capture off this
  // comment rather than off the list gave "2 committed" against an actual 3,
  // which is exactly the reconciliation the vrt-watch red flag exists to force.
  // Read the LIST, not the prose next to it.
  spirographs: [
    { selector: 'canvas', why: 'live spirograph preview — each spiro\'s centre drifts and bounces every frame off the engine clock; the COUNT fader, selector, colorwheel and fader bank are the gate.' },
  ],
  monoglitch: [
    { selector: 'canvas', why: 'live glitch preview canvas that re-randomises off the engine clock; the fader and handle-row chrome is the gate.' },
  ],
  // RUTTETRA: authentic forward-scatter scope. Its canvas is INCLUDED in
  // the diff via the VRT scene (SHAPES → RUTTETRA) so the baseline proves
  // real 3D scanlines, not a flat quad. The scene auto-overrides this mask
  // (vrt.spec.ts: `mod.type in VRT_SCENES ? [] : masks`), kept here as the
  // no-scene fallback.
  ruttetra: [
    { selector: 'canvas', why: 'NO-SCENE FALLBACK ONLY — the SHAPES→RUTTETRA scene overrides this mask and diffs the canvas for real (vrt.spec.ts drops masks for scened modules).' },
  ],
  // GRAPHIC EQ carries a live audio-reactive preview canvas; mask it (it is
  // also EXEMPT_FROM_VRT — animated bars defeat deterministic capture).
  graphicEq: [
    { selector: 'canvas', why: 'analyser-driven bar canvas; the bars move with the audio and defeat deterministic capture, so the chrome is the gate.' },
  ],
  // FREEZEFRAME carries a live video_out preview canvas; mask it so the
  // deterministic chrome (4 QUANT knobs + VID/GATE/OUT/R/G/B/L handle rows)
  // is the regression gate. The S&H + posterize correctness is covered by
  // freezeframe.test.ts (unit) + the freezeframe e2e (pixel sampling).
  freezeframe: [
    { selector: 'canvas', why: 'live video_out preview canvas repainting off the engine clock; the S&H + posterize correctness is covered by freezeframe.test.ts and the freezeframe e2e pixel probes instead.' },
  ],
  // CELLSHADE (rebuilt 4-pass cel-shader) carries a live OUT preview
  // canvas; mask it so the deterministic chrome (THRESH/THICK/BANDS/SOFT/
  // SMOOTH/INK faders + handle rows + the BANDS readout) is the regression
  // gate. The banding + smoothing + edge-ink correctness is covered by
  // cellshade.test.ts (CPU mirror of all 4 passes), the theory-derived
  // cellshade-functional e2e, and the UNMASKED frozen composite scenes in
  // cellshade-composite.spec.ts.
  cellshade: [
    { selector: 'canvas', why: 'live OUT preview canvas repainting off the engine clock; all 4 shader passes are covered by cellshade.test.ts (CPU mirror) and by the UNMASKED frozen composite scenes.' },
  ],
  // POSTERBOX (retro palette-crush video processor) carries a live OUT
  // preview canvas; mask it so the deterministic chrome (DEPTH/DITHER/MIX
  // faders + the DEPTH readout + the PatchPanel drill-down) is the
  // regression gate. The quantizer + Bayer-dither correctness is covered by
  // posterbox.test.ts (CPU mirror of the shader) + the theory-derived
  // posterbox-functional.spec.ts (readPixels probes).
  posterbox: [
    { selector: 'canvas', why: 'live OUT preview canvas repainting off the engine clock; the quantizer and Bayer dither are covered by posterbox.test.ts and posterbox-functional.spec.ts readPixels probes.' },
  ],
  // TEXTMARQUEE carries a live OUT preview canvas (continuously animated when
  // scrolling) — mask it. The card ALSO contains a contenteditable region whose
  // rendered SYSTEM-FONT glyphs rasterize differently across platforms (the
  // exact known linux-VRT glyph nondeterminism), so the LINUX baseline is
  // captured by the vrt-update.yml dispatch; the committed baseline gates the
  // chrome (toolbar buttons + FG/BG swatches + the four knob rows).
  textmarquee: [
    { selector: 'canvas', why: 'live OUT preview canvas, continuously animated off the rAF loop while scrolling; the toolbar, FG/BG swatches and four knob rows are the gate.' },
  ],
  // 4PLEXVID carries a live OUT-1 preview canvas; mask it so the
  // deterministic chrome (4 selector knobs + handle rows) diffs while the
  // live render is excluded. (Kept here for the follow-up baseline; the
  // module is currently in EXEMPT_FROM_VRT below — promote it into MODULES
  // when the darwin/linux PNGs are captured.)
  '4plexvid': [
    { selector: 'canvas', why: 'live OUT-1 preview canvas blitted off the engine clock; the four selector knobs and the handle rows are the gate.' },
  ],
  // ONE TO NINE — 1-in/9-out 3×3 splitter. The card carries a live MONITOR
  // preview canvas (input + grid + numbers via blitOutputToDrawingBuffer off
  // the engine clock); mask it so the deterministic chrome (GRID toggle +
  // IN/OUT1..OUT9 patch-panel) is the regression gate. The crop math is
  // covered by onetonine.test.ts + the bespoke onetonine e2e.
  onetonine: [
    { selector: 'canvas', why: 'live MONITOR preview canvas blitted off the engine clock; the crop math is covered by onetonine.test.ts and the bespoke onetonine e2e.' },
  ],
  shapegen: [
    { selector: 'canvas', why: 'live generated-shape preview canvas repainting off the engine clock; the shape and knob chrome is the gate.' },
  ],
  // SOURCERY — 2-input region shape-match recolor. The card carries a live
  // on-card preview canvas (blitOutputToDrawingBuffer off the engine clock,
  // black when nothing is patched) and v1 segmentation is source-dependent +
  // shimmers frame-to-frame, so the canvas region is non-deterministic; mask it
  // and gate on the deterministic card chrome. Correctness is covered by the
  // pure core (sourcery-core.test.ts) + the bespoke e2e (sourcery.spec.ts).
  sourcery: [
    { selector: 'canvas', why: 'a live preview canvas blitted off the engine clock, plus v1 segmentation that is source-dependent and shimmers frame to frame; sourcery-core.test.ts and sourcery.spec.ts cover correctness.' },
  ],
  // WARREN'S VISIONS — the 2D spectral video resynthesizer. Only the live
  // preview canvas is non-deterministic (a blit off the engine clock, black
  // with nothing patched). Everything else on the card — the COHERENCE dial,
  // the LIVE/FREEZE toggle, the 10-knob grid and the 10-port panel — is static
  // DOM and IS the gate, so this is a MASK and NOT an exemption: the module
  // stays in the sweep and gets a real baseline. Algorithm correctness is
  // covered by warrensvisions-core.test.ts and warrensvisions.spec.ts.
  warrensvisions: [
    { selector: 'canvas', why: 'a live preview canvas blitted off the engine clock; the card chrome is deterministic and is what this baseline gates. warrensvisions-core.test.ts and warrensvisions.spec.ts cover the algorithm.' },
  ],
  // MANDLEBLOT — Mandelbrot fractal with time-driven hue cycle. The
  // shader's colour mode mixes mu + uTime + log(uZoom) into the hue, so
  // every frame is a different colour even at zero motion. Mask the
  // canvas so the chrome diff (6 knobs + zoom readout + handles) is
  // the regression gate; the shader correctness is covered by unit +
  // E2E. Pinning the canvas as well would need a deterministic-time
  // hook on the engine clock — deferred to a follow-up.
  mandleblot: [
    { selector: 'canvas', why: 'the WebGL shader mixes uTime into the hue, so every frame is a different colour even at zero motion; the 6 knobs and the zoom readout are the gate.' },
  ],
  // MIRRORPOOL — live orbit/free-look liquid-pool render (wind swell + rain
  // rings + Fresnel reflect/refract); the preview is animated + time-based, so
  // mask the canvas and let the deterministic chrome (two camera X-Y pads +
  // WIND/DIR/RAIN/BRIGHT/MODE/DIST/ZOOM faders + POOL/SCENE + CV handle rows +
  // VIDEO out) gate. NOTE: the solo-spawn baseline is DEFERRED
  // entirely — no baseline is pinned (mirrorpool is HELD for owner
  // look-preview — a look-affecting video module never captures a baseline
  // before the owner approves the look). Physics coverage is
  // mirrorpool-core.test.ts + the (baseline-deferred) mirrorpool-composite.spec.ts.
  mirrorpool: [
    { selector: 'canvas', why: 'live orbit/free-look WebGL pool render (wind swell, rain rings, Fresnel reflect/refract); the physics is covered by mirrorpool-core.test.ts.' },
  ],
  // GRAINS OF VISION — granular video synth; the OUT preview is a live,
  // self-animating render (temporal grains + feedback trails + reverb tail), so
  // mask the canvas and let the deterministic chrome (GRAIN/FEEDBACK/REVERB/COMP
  // fader sections + A/B + the CV handle rows + OUT/GRAINS out) gate. NOTE: held
  // for owner look-preview (maximally look-affecting) — no solo-spawn baseline is
  // pinned; it is also in EXEMPT_FROM_VRT below (mirrorpool precedent). Grain /
  // feedback / reverb / composite math is covered by grainsOfVision.test.ts + the
  // bespoke grains-of-vision.spec.ts.
  grainsOfVision: [
    { selector: 'canvas', why: 'a self-animating granular render loop with feedback trails and a reverb tail; grain/feedback/reverb math is covered by grainsOfVision.test.ts and its bespoke e2e.' },
  ],
  // FRAMETABLE — video wavetable oscillator (60-frame ring → per-pixel frame
  // SELECT). The card carries a live video_out preview canvas; mask it so the
  // deterministic chrome (FREEZE/SAVE buttons + MORPH/SPREAD/SHIMMER/SHAPE faders +
  // the PatchPanel drill-down) is the regression gate. Held for owner look-preview
  // (look-affecting WebGL) — no solo-spawn baseline is pinned; also in
  // EXEMPT_FROM_VRT below (mirrorpool/grains precedent). The inverse-CDF selection
  // + freeze/save math is covered by frametable-core.test.ts + frametable.spec.ts.
  frametable: [
    { selector: 'canvas', why: 'live video_out preview of a 60-frame ring, blitted off the engine clock; the inverse-CDF selection and freeze/save math is covered by frametable-core.test.ts.' },
  ],
  // VIDEOCUBE — the video isomorph of the audio CUBE. The card carries a live
  // video_out preview canvas (blitOutputToDrawingBuffer off the engine clock);
  // mask it so the deterministic chrome (WRAP/MATERIAL/SCREEN toggles + the
  // READER row + the 15-knob CUBE bank + the 3 slot pickers + the PatchPanel
  // drill-down) is the regression gate. Held for owner look-preview (look-
  // affecting WebGL) — no solo-spawn baseline pinned; also in EXEMPT_FROM_VRT
  // below (mirrorpool/frametable precedent). The occupancy combine + luma-
  // reduction math is covered by videocube-core.test.ts + videocube.spec.ts.
  videocube: [
    { selector: 'canvas', why: 'live video_out preview blitted off the engine clock; occupancy combine and luma reduction are covered by videocube-core.test.ts.' },
  ],
  // SCOREBOARD — 4-digit 7-segment counter widget. The card carries a live
  // preview canvas; the counter starts at 0 on factory mount (or 1234 when
  // the VRT scene sets `__scoreboardVrtSeed`). Canvas masked here as the
  // fallback so the chrome (port handles + COLOR knob) diffs deterministically
  // when the module is promoted into MODULES without a registered scene.
  scoreboard: [
    { selector: 'canvas', why: 'NO-SCENE FALLBACK: the counter canvas reads 0 on a bare mount and 1234 under the VRT scene seed, so a solo capture is not a stable render.' },
  ],
  // QUADRALOGICAL — 4-input video mixer. The card carries a live on-card MIX
  // preview canvas (blitOutputToDrawingBuffer off the engine clock), so the
  // canvas region is non-deterministic in the standard solo-spawn VRT; mask it
  // and gate on the deterministic chrome (XY pad + yellow diamond + 8-button
  // transition row + dynamic faders + FG/BG toggle + handle rows). The
  // weight-model + composite correctness is covered by the unit suite
  // (quadralogical.test.ts) + the dedicated e2e (quadralogical.spec.ts).
  quadralogical: [
    { selector: 'canvas', why: 'live MIX preview canvas blitted off the engine clock; the weight model and composite are covered by quadralogical.test.ts and quadralogical.spec.ts.' },
  ],
  // COLOUR OF MAGIC — multi-colorspace processor. The solo-spawn card carries a
  // live on-card preview canvas (blitOutputToDrawingBuffer off the engine clock,
  // black when nothing is patched), so the standard solo VRT is non-deterministic;
  // mask it and gate on the deterministic chrome (preview pill row + the three
  // RGB/YDbDr/HSV block columns of knobs + OVER/CLAMP pills + REPLACE/HSL toggles
  // + palette swatches + handle rows). The deterministic per-block composite VRT
  // (recolorization / mono-override clobber / palette remap) lives in
  // vrt-colourofmagic.spec.ts.
  colourofmagic: [
    { selector: 'canvas', why: 'live on-card preview canvas blitted off the engine clock, black when nothing is patched; the deterministic per-block composite VRT lives in vrt-colourofmagic.spec.ts.' },
  ],
  // ANALOG VCO — the mask was DELETED, not migrated, and this comment said the
  // opposite for months. CORRECTED 2026-08-08.
  //
  // It used to live here as a bare `analogVco: [{ selector: 'canvas' }]`, which
  // masked the legacy CARD's single-cycle waveform scope out of the diff and
  // asserted NOTHING about it. The 2026-08-01 round-4 derivation then measured
  // that card UNMASKED at 10/10 separate gate processes PASS (see the table in
  // vrt-live-surfaces.ts), so the entry was removed and 27.6 % of the card came
  // BACK into the pixel diff. That is the outcome — no mask, full strictness.
  //
  // The wording it replaced ("MIGRATED to the live-surface registry… now
  // carries a measured companion") described a `VRT_LIVE_SURFACES` entry that
  // never existed, and it read as reassurance while nothing was watching.
  //
  // ⚠ AND DO NOT RE-ADD ONE FOR THE FACE EITHER. analogVco has a SECOND live
  // surface — `face-analogVco-compact`, the PF-20 lane tile, whose `scope`
  // GLYPH moves because the oscillator free-runs — and an earlier cut of that
  // face shipped a registry entry to mask it. That entry was DELETED before
  // merge: #1420 suspends the AudioContext in `bootWithFace` before the tile is
  // framed, so the glyph tap reads zeros and the tile is strict-stable
  // (measured 0 px frozen vs 394 px unfrozen, 10/10 separate gate processes
  // unmasked). Both of this module's surfaces are unmasked, for two different
  // reasons; neither needs a companion.
  //
  // The morph DSP is still covered by analog-vco-morph.test.ts and the
  // scope-window logic by analog-vco-scope.test.ts.
  // BACKDRAFT deliberately has NO mask entry, for TWO independent reasons —
  // and the wording here has flip-flopped with the card, so state both.
  //   (1) There is nothing on the faceplate to mask. The in-card display was
  //       removed; the <canvas> that remains is the output surface for Full
  //       Frame / Full Screen / Present and is 0×0 + never painted in the rack.
  //   (2) Even if there were, a mask here would be DEAD CODE: backdraft has a
  //       VRT_SCENES entry, and a scened module is REMOVED from this map ON
  //       PURPOSE (see the header note in vrt-scenes.ts) — the scene's
  //       deterministic patch + settle is what makes a region diffable, and
  //       vrt.spec.ts:171 enforces the split (`mod.type in VRT_SCENES ? [] :
  //       masks`), so an entry would read as "this region is masked" while it
  //       is not.
  // backdraft is still in EXEMPT_FROM_VRT below, but now only for the
  // mechanical reason (no darwin/linux baseline PNGs) — see that entry.
  // MILKDROP — butterchurn music visualizer. The card carries a live preview
  // canvas (blitOutputToDrawingBuffer off the engine clock + an async-loaded
  // preset that animates continuously), so the canvas region is non-deterministic
  // in the solo-spawn VRT; mask it and gate on the deterministic chrome (port
  // handle rows + RCT/SPD/PST/MPH knobs + preset readout). Currently in
  // EXEMPT_FROM_VRT below (chaotic/time-based, like doom/mandelbulb); this mask
  // covers the live preview if it is ever promoted into MODULES.
  milkdrop: [
    { selector: 'canvas', why: 'the butterchurn preset animates continuously off the engine clock after an async load; the handle rows and RCT/SPD/PST/MPH knobs are the gate.' },
  ],
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
  cvBuddy: 'VRT baseline pending — hardware-facing card whose look is NOT yet owner-locked (Part A preview; the slot/clock readout + ES-9 mirror will likely change on owner feedback), so a baseline now would just churn. Card behavior is covered by cv-buddy slot-alloc/clock-math/es9-reconcile unit tests; promote + capture darwin/linux baselines once the look is approved.',
  // OUT TO LAUNCH — Launchpad Mini Mk3 as a live 9×9 RGB video monitor. The
  // card is a live MONITOR preview canvas (the 9×9 grid) driven by the module's
  // per-frame GPU readback + a device-picker; nothing patched is a black grid,
  // and the live render + Web-MIDI device list vary across runners. Coverage:
  // the pure surface mapping (launchpad-monitor.test.ts: lpMonitorIndex /
  // rgb8ToLp / monitorGridToLeds), the monitor device binding
  // (launchpad-device.test.ts: bind/claim/setMonitorFrame diff/unbind), and the
  // module def+factory (out-to-launch.test.ts). Promote + capture darwin/linux
  // baselines (live preview masked) via vrt-update.yml in a follow-up PR.
  outToLaunch: 'VRT baseline pending; live 9×9 monitor preview + Web-MIDI device list are non-deterministic. Coverage = launchpad-monitor.test.ts (surface mapping) + launchpad-device.test.ts (monitor bind/claim/diff/unbind) + out-to-launch.test.ts (def+factory). Capture darwin/linux baselines (live preview masked) in a follow-up PR.',
  // ES9 — native-bridge 16×16 hardware I/O. The card is static chrome
  // (status LED + class selectors + sectioned patch panel, no canvas), so
  // it IS baseline-able — pending the darwin/linux capture pass (4plexvid
  // precedent). Functional coverage: es9-bridge-core unit tests (dsp: ring,
  // class scaling, gate hysteresis, underrun policies) + es9.test.ts (def
  // shape, class→worklet mapping) + the per-module handle-presence sweep.
  es9: 'VRT baseline pending; es9-bridge-core (dsp) + es9.test.ts unit suites cover the logic, card is static chrome. Promote + capture darwin/linux baselines in a follow-up PR.',
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
  // SIX STRUM — 6-voice guitar/bass/harp instrument (first-slice PR). The card
  // is static deterministic chrome (4 fader bands + selectors + STRUM button +
  // per-string PatchPanel + per-knob CV sections), so it IS baseline-able —
  // pending the darwin/linux capture pass. Coverage = sixstrum-dsp/-tuning (26)
  // + sixstrum.test (12: worklet wiring incl. anti-silent-poly + the per-knob
  // CV scaling/quantization + CV inputsMap→AudioParam routing) + ART profile +
  // e2e/tests/sixstrum-poly.spec.ts (real SEQUENCER→poly/strum→audible RMS).
  sixstrum: 'VRT baseline pending; card is static chrome — unit (sixstrum-dsp/-tuning/worklet-wiring) + ART + e2e/tests/sixstrum-poly.spec.ts provide coverage. Capture darwin/linux baselines via vrt-update.yml in a follow-up.',
  // MIRRORPOOL — maximally look-affecting WebGL water video source, HELD for
  // owner preview: no VRT baseline is pinned pre-approval. Coverage meanwhile:
  // mirrorpool-core.test.ts (Fresnel/swell/normal/Poisson/PTZ) + per-port +
  // behavioral. Capture darwin/linux baselines via vrt-update.yml once the owner
  // approves the look (then capture the composite scenes with `task vrt:commit`).
  mirrorpool: 'VRT baseline pending owner look-approval (look-affecting WebGL video); mirrorpool-core.test.ts + per-port + behavioral provide coverage. Capture darwin/linux baselines via vrt-update.yml in a follow-up.',
  // GRAINS OF VISION — maximally look-affecting WebGL granular video synth, HELD
  // for owner preview: no VRT baseline is pinned pre-approval (mirrorpool
  // precedent). Coverage meanwhile: grainsOfVision.test.ts (grain window / hash /
  // temporal-blend / feedback-UV / reverb-accumulate / composite-mode CPU mirror)
  // + per-module-per-port (handle presence + ACIDWARP→in_a outputs-emit) + the
  // bespoke grains-of-vision.spec.ts (real source→grains→OUT non-black + COMPOSITE
  // with a 2nd source). Capture darwin/linux baselines via vrt-update.yml once the
  // owner approves the look (the canvas mask above covers the live preview).
  grainsOfVision: 'VRT baseline pending owner look-approval (look-affecting WebGL granular video); grainsOfVision.test.ts + per-port (ACIDWARP→in_a emit) + grains-of-vision.spec.ts provide coverage. Capture darwin/linux baselines via vrt-update.yml in a follow-up.',
  // FRAMETABLE — look-affecting WebGL video wavetable oscillator, HELD for owner
  // preview: no VRT baseline pinned pre-approval (mirrorpool/grains precedent).
  // Coverage meanwhile: frametable-core.test.ts (inverse-CDF distribution / ring
  // wrap / still-image consistency / freeze+save reducers CPU mirror) + per-module-
  // per-port (handle presence + ACIDWARP→video_in outputs-emit) + the bespoke
  // frametable.spec.ts (real source→video_out non-blank variance-probe + FREEZE
  // holds while the input changes). Capture darwin/linux baselines via
  // vrt-update.yml once the owner approves the look (the canvas mask covers the
  // live preview).
  frametable: 'VRT baseline pending owner look-approval (look-affecting WebGL video wavetable); frametable-core.test.ts + per-port (ACIDWARP→video_in emit) + frametable.spec.ts provide coverage. Capture darwin/linux baselines via vrt-update.yml in a follow-up.',
  // VIDEOCUBE — look-affecting WebGL video isomorph of the audio CUBE, HELD for
  // owner preview: no VRT baseline pinned pre-approval (mirrorpool/grains/
  // frametable precedent). Coverage meanwhile: videocube-core.test.ts (occupancy
  // combine + colour blend + luma-reduction CPU mirror) + per-module-per-port
  // (handle presence + ACIDWARP→video_a outputs-emit) + the bespoke
  // videocube.spec.ts (real 3-source chain → video_out non-blank variance-probe +
  // audio_out RMS). Capture darwin/linux baselines via vrt-update.yml once the
  // owner approves the look (the canvas mask covers the live preview).
  videocube: 'VRT baseline pending owner look-approval (look-affecting WebGL video CUBE isomorph); videocube-core.test.ts + per-port (ACIDWARP→video_a emit) + videocube.spec.ts provide coverage. Capture darwin/linux baselines via vrt-update.yml in a follow-up.',
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
  // ⚠ The third file this reason used to name — an `audioin` unit test —
  // HAS NEVER EXISTED (#1524). No gate could see that: every check over this record reads
  // the key + the reason's LENGTH, never the filesystem. `devices.test.ts`
  // covers the device-picker helpers for real; the def-shape half is covered by
  // modules-card-map.test.ts, which is what now stands in the reason.
  // `scripts/exemption-coverage-anchors.test.ts` makes this class un-writable.
  audioIn: 'card state depends on getUserMedia permission + audioinput presence (varies across CI runners); e2e/tests/audio-in.spec.ts + devices.test.ts + modules-card-map.test.ts provide coverage',
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
  push2Control: 'meta control-surface card (Ableton Push 2); body is device/binding-dependent (Connect/Bind state + view segment absent in CI) AND the push-card preview canvas renders whatever module happens to be in lane 1, so the card face is patch-dependent — like launchpadControlLeft/electraControl. Covered by push2-sysex/map/control/lane/schema/model/layout/paint unit suites + the real-source-chain push2-clip-launch e2e (sim pad → audible RMS + lane select → the push card + a display encoder → that card param + master encoder → MixMasters + D-Pad nav).',
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
  // RINGS: the legacy CARD has no baseline. Its faceplate does — as of the face
  // PR, `face-rings-compact` and `face-rings-dock` are captured by the linux
  // job like every other face scene — so the pixel surface a migrated module
  // actually presents IS covered; this entry is only about the `?shell=legacy`
  // card. ⚠ The previous reason here said "Linux baseline is darwin-only for
  // v1", which is stale prose: #1458 deleted the `{platform}` dimension and
  // there is now ONE baseline set, authored by linux CI.
  rings: 'VRT baseline pending for the legacy card; the FACEPLATE is baselined (face-rings-compact/dock). ART + unit + E2E cover the module.',
  // MARBLES first-slice PR: plain fader card (no custom canvas
  // viz), so VRT adds little; unit tests cover the DSP core. Promote +
  // capture baselines in a follow-up PR.
  marbles: 'VRT baseline pending; standard fader card; unit tests cover the DSP core.',
  // ATTENUMIX simple mixer: 4 attenuator faders + master + standard PatchPanel
  // — no unique visual surface on the LEGACY card. ⚠ This entry is now ONLY
  // about the `?shell=legacy` card: attenumix entered STRICT_FACES with the
  // faceplate queue's Q6, so the surface real users operate is the FACEPLATE,
  // and `face-attenumix-compact` / `face-attenumix-dock` ARE captured by the
  // linux job like every other face scene (the rings precedent, three entries
  // above). The pixel surface the module actually presents is covered.
  attenumix: 'VRT baseline pending for the legacy card; the FACEPLATE is baselined (face-attenumix-compact/dock). ART + unit + E2E cover the module.',
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
  // coverage in acidwarp.test.ts (generatePattern + buildPalette/rotatePalette); integration coverage via E2E.
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
  // canvas region is non-deterministic; it's MASKED via the live-surface
  // registry (e2e/vrt/vrt-live-surfaces.ts — same mask it used to have in
  // VRT_MODULE_MASKS, now with a measured ink/spread/chroma companion so the
  // preview cannot go blank unnoticed) and the surrounding deterministic chrome
  // (6 knobs ZOOM/ROT X/ROT Y/POWER/DETAIL/HUE + SPIN/SCRN toggles + 6 CV
  // handle rows + VIDEO out) is the regression gate. Darwin baseline captured
  // here; linux baseline pending a `task vrt:update` run on linux CI (see
  // the vrt-update.yml capture on linux CI). DE/shading correctness is
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
  // game-loop framebuffer defeats deterministic capture.
  // ⚠ CORRECTED 2026-08-13 (#1497): this used to read "user-supplied +
  // gitignored + NOT redistributable, so CI has no data … the card only ever
  // shows the data-missing overlay". That was false in every clause. The 1997
  // shareware set IS committed (ADR-007), ci.yml materialises it from LFS into
  // the preview bundle, and blood-mount.spec.ts asserts the data-missing prompt
  // does NOT appear on CI. The card boots and the menu ANIMATES by design (the
  // engine-clock fix, PHASE1-STATUS.md §3) — which is the real, and sufficient,
  // reason a screenshot of it cannot be a baseline. Unit suites cover the TS
  // shim (blood-runtime) + the CV-gate scancode map (blood-keys).
  blood: 'live game-loop framebuffer defeats deterministic capture: the bundled shareware boots on CI and the main menu animates by design (engine-clock fix), so successive captures differ by construction — NOT a data-availability exemption (the data is committed; see docs/adr/007-game-asset-distribution.md); unit suites cover blood-runtime shim + blood-keys scancode map',
  // WARREN'S SPECTRUM — ⚠ THE OLD `why` HERE IS SPENT, and rewriting it is
  // part of face batch 6 rather than a tidy-up. It read "VRT baseline pending:
  // the curated dock FACE lands on the faceplate platform (#1301) in a
  // follow-up and will replace this card layout wholesale". #1301 has landed
  // and that follow-up is this change — so the reason named an event that has
  // already happened, which is exactly the stale-ledger shape CLAUDE.md refuses
  // ("a ledger entry naming something that no longer exists is RED").
  //
  // The module is now in STRICT_FACES, so what a workflow-mode player actually
  // operates is the ModuleShell faceplate, and THAT has two committed baselines
  // (`face-warrensspectrum-compact` / `-dock`, workflow-shell-faces.spec.ts),
  // which is the same disposition sidecar, rings, marbles and clouds carry.
  // This entry now covers only the LEGACY card — reachable at `?shell=legacy`
  // — whose exemption stands on the ordinary grounds: 15 faders, a band strip
  // and a PatchPanel, no unique visual surface beyond what the faced scenes
  // already capture.
  warrensspectrum: 'faced (STRICT_FACES): the operated surface is the ModuleShell faceplate, captured by face-warrensspectrum-{compact,dock}. This entry covers only the LEGACY card (?shell=legacy) — 15 faders + band strip + PatchPanel, no unique visual surface. ART audio profile + dsp unit gates + per-port sweep cover behaviour.',
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
  quadralogical: 'SOLO-spawn VRT exempt (live MIX preview canvas with nothing patched). The deterministic per-edge composite VRT is vrt-quadralogical.spec.ts (8 effect baselines captured by linux CI). Unit (weight model + edge composite + all 8 blends) + e2e (corner dominance + per-edge distinctness/independence) provide coverage.',
  // COLOUR OF MAGIC — multi-colorspace processor. SOLO-spawn VRT exempt (live
  // preview canvas; nothing patched renders black). The deterministic per-block
  // composite VRT is vrt-colourofmagic.spec.ts (6 scenes: pass / rgb / ydbdr /
  // hsv recolorization + mono-override channel clobber + palette CMY remap,
  // clock-pinned structured source, darwin captured; linux via
  // the vrt-update.yml capture). Unit (colourofmagic-colorspace.test.ts — every
  // colorspace + adj/over-clamp + hue-rotation + palette path) + e2e
  // (colourofmagic.spec.ts — all 8 outs emit, recolorization, mono-override
  // clobber, over/clamp) provide coverage.
  colourofmagic: 'SOLO-spawn VRT exempt (live preview canvas; nothing patched is black). The deterministic per-block composite VRT is vrt-colourofmagic.spec.ts (6 scenes: pass/rgb/ydbdr/hsv recolorization + mono-override channel clobber + palette CMY remap, captured by linux CI). Unit (colourofmagic-colorspace.test.ts) + e2e (colourofmagic.spec.ts) provide coverage.',
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
  // ⚠ REWRITTEN WITH THE FACE PR (Q39). Two things in the old reason no longer
  // held, and the second was already true when it was written:
  //
  //  1. It described the SUBJECT as "2 knobs + a 3-position RANGE switch" —
  //     i.e. `Moog904aVcfCard.svelte`. `moog904a` is now in STRICT_FACES, so
  //     `migrated()` is true and NEITHER surface renders that card: the lane
  //     draws a ModuleShell tile and the dock a ModuleShell full view.
  //  2. It credited "ART (SHA-pinned self-osc)" as functional coverage of this
  //     module. `art/scenarios/moog904a/profile.test.ts` exists — but it
  //     imports `MoogLadder` from the shared lib and drives it directly, with
  //     `DRIVE = 0.5 + REGEN * 0.8` HAND-COPIED out of the worklet (its `:47`
  //     even names the line it was copied from). So it pins the LADDER LIB, not
  //     `moog904a`'s processor, and a change to the worklet's drive law, its
  //     RANGE handling, its clamp or its dither would not move that baseline at
  //     all (#1913). Real coverage, narrower than the sentence claimed.
  moog904a: 'No card VRT baseline — and the card is unreachable: moog904a is in STRICT_FACES, so both surfaces render ModuleShell instead of Moog904aVcfCard. Pixel coverage is the two face scenes (face-moog904a-compact / face-moog904a-dock) in the shell-faces roster. Functional coverage: moog904a.test.ts (the real worklet), moog-ladder-dsp.test.ts, moog904a-face-model.ts (the delivered-cutoff join + the measured self-oscillation threshold), per-module-per-port e2e. ⚠ The ART profile pins the shared LADDER LIB driven directly with a hand-copied drive expression, NOT this worklet — so it cannot see a worklet-level drift (#1913).',
  // MOOG 911 EG — Moog System 55/35 contour generator. Deterministic beige
  // faceplate (4 knobs: T1 / T2 / ESUS / T3, no canvas / animation) like the
  // 921; baselines pending a `task vrt:update` run on each platform. DSP unit
  // (moog911.test.ts worklet — 3-stage contour) + ART (source-SHA-pinned
  // .f32) + per-module-per-port e2e (gate-driven env emit) provide functional
  // coverage. Promote into MODULES once darwin + linux PNGs are captured.
  moog911: 'VRT baseline pending — deterministic beige Moog faceplate (4 knobs T1/T2/ESUS/T3, no canvas/animation); capture via `task vrt:update` on each platform. DSP unit + ART (SHA-pinned) + per-module-per-port e2e provide coverage. Promote into MODULES once darwin + linux baselines land.',
  // MOOG 902 VCA — Moog System 55/35 clone slice 3.
  //
  // ⚠ THIS ENTRY CARRIED TWO FALSE CLAIMS UNTIL THE FACE PR (#1912), and they
  // failed in opposite directions — one described an artifact that no longer
  // exists, the other credited coverage that never did:
  //
  //  1. It described the SUBJECT as "2 knobs + a 2-position LIN/EXP switch",
  //     i.e. `Moog902VcaCard.svelte`. `moog902` is now in STRICT_FACES, so
  //     `migrated()` is true and neither surface renders that card any more —
  //     the lane draws a ModuleShell tile and the dock a ModuleShell full view.
  //     An exemption reason naming a card nobody can reach is an exemption
  //     nobody is watching.
  //  2. It claimed "ART (source-SHA-pinned .f32)" coverage. There is NO
  //     `art/scenarios/moog902/` in the tree and `moog902` is listed in the ART
  //     BACKLOG (`art/setup/profile-coverage.ts`), so that leg of the argument
  //     was empty — checked, not assumed.
  //
  // What is actually true: the module has no committed card baseline, and its
  // real pixel coverage now comes from the two FACE scenes
  // (`face-moog902-compact` / `face-moog902-dock`, rostered in
  // `e2e/vrt/_shell-faces.ts`) rather than from a card capture that was never
  // taken. Functional coverage is the DSP worklet unit (gain law, the ×2-at-6V
  // anchor, the mode-dependent ×3 ceiling, CV summing, the bit-exact inverted
  // output), the face model's own negative controls, and per-module-per-port
  // e2e.
  moog902: 'No card VRT baseline — and the card is unreachable: moog902 is in STRICT_FACES, so both surfaces render ModuleShell instead of Moog902VcaCard. Pixel coverage is the two face scenes (face-moog902-compact / face-moog902-dock) in the shell-faces roster. Functional coverage: DSP worklet unit (gain law + x2-at-6V anchor + the mode-dependent x3 ceiling + CV summing + bit-exact inverted output), moog902-face-model unit, per-module-per-port e2e. NOT ART-covered — moog902 is in the ART backlog and has no scenario (this reason previously claimed otherwise, #1912).',
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
  // Baselines are authored by linux CI (`task vrt:commit`)
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
  // BACKDRAFT (video feedback generator) — the ORIGINAL reason was a PAIR:
  // user-resizable (variable size) AND a live, non-deterministic feedback
  // PREVIEW (like ruttetra / videoOut / toybox). Both halves are now gone:
  //
  //   variable SIZE   gone. Fixed 4hp×3u tier (rack-sizes.ts) with the
  //                   corner-resize retired; 3u is pinned min AND max.
  //   live CANVAS     gone from the rack. The <canvas> still EXISTS as the
  //                   output surface for Full Frame / Full Screen / Present,
  //                   but in the rack it is 0×0 and never painted, so there is
  //                   no non-deterministic region on the faceplate at all.
  //
  // ⚠ THIS MODULE IS THEREFORE A PROMOTION CANDIDATE, and the only thing left
  // blocking it is MECHANICAL: there are no darwin/linux baseline PNGs, and
  // capturing them is the vrt-update.yml drain-then-dispatch dance on two
  // platforms — a separate PR's CI budget, not this one's. Promoting it here
  // would ALSO have to re-scene it: `backdraft` is a SCENED module, so
  // vrt.spec.ts drops its mask by design, and the scene still settles on
  // WALL CLOCK (settleMs: 700) — which is fine now that the card paints no
  // picture, but the scene should be re-read before it is relied on.
  //
  // Functional coverage meanwhile: backdraft.test.ts + backdraft-tv.test.ts
  // (PCU/model) + backdraft.spec.ts (feedback render / freeze / spatial
  // transform / pixelate / mirror / clk-override / faders) +
  // backdraft-pure-tv.spec.ts + the three TV-mode cases in
  // card-control-overflow.spec.ts (card layout in every mode) + the card-size
  // and hidden-surface geometry in backdraft-full-output.spec.ts.
  // FOLLOW-UP: promote into MODULES + capture darwin/linux baselines via
  // vrt-update.yml.
  backdraft: 'BOTH original reasons are gone — the card is a fixed 4hp×3u tier (corner-resize retired) and its in-rack feedback DISPLAY was removed, so the faceplate carries no non-deterministic region (the <canvas> survives only as the 0×0, never-painted output surface for Full Frame / Full Screen / Present). What still blocks promotion is purely mechanical: no darwin/linux baseline PNGs, which is the vrt-update.yml drain-then-dispatch dance on two platforms and a separate PR\'s CI budget. Coverage meanwhile: backdraft.test.ts + backdraft-tv.test.ts + backdraft.spec.ts + backdraft-pure-tv.spec.ts + the three TV-mode card-control-overflow cases + the card-size and hidden-surface geometry in backdraft-full-output.spec.ts.',
  // SPIROGRAPHS is intentionally NOT exempt: its live drifting/bouncing OUT
  // preview canvas is MASKED in VRT_MODULE_MASKS above, and the deterministic
  // card chrome (COUNT fader + 1/2/3 spiro selector + IN/OUT toggle + chroma
  // colorwheel + per-spiro fader bank + sectioned PatchPanel) ships dual-platform
  // baselines (captured via vrt-update.yml). New modules don't grow this list.
};

/** THE FROZEN PERMANENT-EXEMPT ALLOWLIST — the brake on EXEMPT_FROM_VRT.
 *
 *  WHY THIS EXISTS. EXEMPT_FROM_VRT was a pure OPT-OUT: any module could
 *  remove itself from visual coverage by adding a key with a >10-character
 *  reason. The reason gate proved the string was long, never that skipping was
 *  justified — so the list grew 76 -> 81 with nothing able to notice, and each
 *  addition silently shrank the visual gate. That is the repo's deny-by-default
 *  inversion applied to VRT: a guard that is OPT-IN is itself an instance of
 *  the class it guards.
 *
 *  THE RULE. Every EXEMPT_FROM_VRT key must appear here, and the two lists must
 *  match EXACTLY — vrt-meta.test.ts asserts set equality in both directions, so:
 *
 *    * a NEW module CANNOT self-exempt — adding a key to EXEMPT_FROM_VRT
 *      without an allowlist edit fails vrt-meta.test.ts in ~1 s. Shipping a
 *      module with no VRT is now a REVIEWED decision, not a side effect.
 *    * the set only ever SHRINKS BY NAME. When a module earns baselines, delete
 *      it from BOTH lists. There is no count to keep in step — the ceiling that
 *      used to shadow this list was deleted 2026-08-10 (see the note above the
 *      deny-by-default block in vrt-meta.test.ts): a hand-typed population count
 *      is a merge hazard by construction, and set equality already refuses
 *      every drift the count could have caught.
 *
 *  NOT AN ENDORSEMENT. Membership records that a module was exempt on the day
 *  the brake landed — nothing more. Many entries are mechanical ("no baseline
 *  captured yet") rather than permanent, and draining them is the
 *  vrt-zero-exemptions campaign
 *  (.myrobots/plans/vrt-zero-exemptions-campaign-2026-06-21.md), whose target
 *  is a handful of genuinely-chaotic renderers (doom, mandelbulb, milkdrop).
 *  This PR builds the brake the campaign always assumed and never had; it does
 *  not do the draining.
 *
 *  ANCHORED TO THE ARTIFACT: an entry here naming a module that is NOT in
 *  EXEMPT_FROM_VRT is RED, so a drained module cannot leave a stale licence to
 *  re-exempt itself lying around. */
export const ALLOWED_PERMANENT_EXEMPT: ReadonlySet<string> = new Set([
  'milkdrop', 'graphicEq', 'archivist', '4plexvid',
  'cvBuddy', 'outToLaunch', 'es9', 'onetonine',
  'shapegen', 'sixstrum', 'mirrorpool', 'grainsOfVision',
  'frametable', 'videocube', 'sourcery', 'scoreboard',
  'cameraInput', 'loopback', 'audioIn', 'group',
  'cadillac', 'controlSurface', 'matrixMix', 'launchpadControlLeft',
  'push2Control', 'clouds', 'macseq', 'writeseq',
  'rings', 'marbles', 'attenumix', 'sidecar',
  'cloudseed', 'livecode', 'clockedRunner', 'midiCvBuddy',
  'midiOutBuddy', 'midiclock', 'midiLane', 'pong',
  'modtris', 'gibribbon', 'frogger', 'skifree',
  'analogLogicMaths', 'bentbox', 'b3ntb0x', 'acidwarp',
  'tempest', 'vfpgaRunner', 'joystick', 'gamepad',
  'numpadPlus', 'slewSwitch', 'delay', 'doom',
  'blood', 'warrensspectrum', 'videobox', 'tvLibrarian',
  'peertube', 'videovarispeed', 'chromakey', 'fader',
  'lumakey', 'quadralogical', 'colourofmagic', 'mappy',
  'chroma', 'luma', 'fourplexer', 'treeohvox',
  'bluebox', 'moog921Vco', 'moogCp3', 'moog904a',
  'moog911', 'moog902', 'painter', 'twotracks',
  'backdraft',
]);

/** Strict VRT subset — the deterministic, pure-DOM/CSS knob-and-fader cards
 *  that ship a baseline on BOTH platforms (darwin + linux), aren't masked
 *  for canvas non-determinism, and have a committed baseline rather than a
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
 *    3. Module has a COMMITTED baseline (no
 *       pending re-capture; both baselines reflect current UI).
 *    4. Card has no animated chrome (LED pulse, blinking cursor, time-
 *       driven readouts). Pure CSS-styled knobs/faders/ports only.
 *
 *  Demotion rule: if a strict card flakes ONCE in CI, demote it back to
 *  the full lane and root-cause. Per memory `feedback_no_flake_tolerance`:
 *  a strict subset that flakes IS a flake to fix; the whole point of the
 *  lane is signal.
 *
 *  ── ⚠ WHY THE VISUAL BAR IS SO MUCH NARROWER THAN THE DOCS BAR ────────────
 *
 *  Asked and measured 2026-08-12 (figures are prose, dated; re-derive with
 *  `wc -l e2e/.generated/registry-manifest.json` and a grep of each list, do
 *  not trust them):
 *
 *    registered modules            196
 *    EXEMPT_FROM_VRT                81   → 115 have a baseline at all
 *    STRICT_VRT_MODULES             49   → the REQUIRED lane
 *    STRICT_DOCS                   185   → the docs bar, on the same registry
 *
 *  The gap is not that cards are harder to cover than prose. It is that the
 *  two bars have OPPOSITE ENROLMENT RULES, and only one of them converges:
 *
 *    STRICT_DOCS is a DOCUMENT-ON-TOUCH RATCHET. Every NEW module ships in it,
 *    and any module you incidentally touch is brought up to the bar then. Its
 *    membership therefore chases the registry by construction, which is why it
 *    is at 185 of 196 without anyone running a campaign.
 *
 *    STRICT_VRT_MODULES has NO enrolment rule at all. A new module auto-enrols
 *    into the INFORMATIONAL sweep (vrt.spec.ts covers everything not exempt —
 *    deny-by-default, and ALLOWED_PERMANENT_EXEMPT above is the brake that
 *    stops a module self-exempting). But promotion into the REQUIRED subset is
 *    a purely OPT-IN act with four hand-checked conditions and no trigger, so
 *    it only ever moves when someone deliberately moves it.
 *
 *  That is the repo's own "a guard for that class that is OPT-IN is itself an
 *  instance of it", sitting inside the required visual gate: 66 modules have a
 *  committed, diffed baseline that cannot fail a merge. Two of the four
 *  promotion conditions are also now stale — 1 and 3 both say "BOTH platforms",
 *  and the {platform} dimension was deleted in #1458 (there is ONE baseline
 *  set, authored by linux CI).
 *
 *  NOT FIXED HERE, deliberately: promoting 66 cards is a per-card determinism
 *  judgement (condition 4 is the real filter — animated chrome), each one a
 *  potential flake in the blocking lane, and this branch is already moving the
 *  faceplates into that lane. What IS fixed here is the far worse instance of
 *  the same shape: the 64 FACE baselines, which had no required coverage at
 *  all until workflow-shell-faces.spec.ts joined STRICT_MATCH. The card
 *  backlog is visible and merely narrow; the face lane was invisible. */
export const STRICT_VRT_MODULES = new Set<string>([
  // Audio domain — pure knob/fader cards, no canvas
  'adsr',                 // 4-knob envelope card
  // analogVco: removed from strict lane — the card carries a live single-cycle
  // waveform scope (animated canvas off the morph output), which disqualifies
  // it from the no-animated-chrome strict subset. It stays in the full VRT
  // lane, and — CORRECTED 2026-08-08 — the scope canvas is NOT masked there:
  // the round-4 derivation measured the unmasked card at 10/10 gate processes
  // PASS and deleted the VRT_MODULE_MASKS entry, so the trace is in the diff.
  // audioOut: removed from strict lane. This PR added the OUT device
  // dropdown row (setSinkId picker), growing the card from 320x313 to
  // 360x401. The darwin baseline was re-captured (f1cd0e5f); the linux
  // baseline still shows the old 320x313 layout (pre-device-picker).
  // Re-add once linux baseline is re-captured + linux/audioOut removed
  // by the vrt-update.yml capture.
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
  'noise',                // noise-source FADER card (like mixer/mixmstrs above,
                          //   not a knob card — the distinction is the whole
                          //   point of its `face.paramCells: { level: 'fader' }`)
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
  // the vrt-update.yml capture). The strict lane requires a current
  // platform baselines current (vrt-meta self-test), so timelorde rides the
  // full (informational) VRT lane until the linux baseline lands — then
  // re-add it here once `task vrt:commit` has captured it.
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


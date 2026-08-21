// packages/web/src/lib/video/modules/monoglitch.ts
//
// MONOGLITCH — luma → vertical-scanline displacement OUTPUT. Originally
// shipped as RUTTETRA (PR-99) but renamed when the actual Rutt/Etra
// raster-coordinate-remap model landed in its own module. MONOGLITCH is
// NOT a true Rutt/Etra raster-scan processor — it's a luma-driven
// scanline-displacement glitch effect (a useful aesthetic in its own
// right, just a different abstraction). For the coord-remap effect see
// packages/web/src/lib/video/modules/reshaper.ts; for the authentic
// forward-scatter scan scope see
// packages/web/src/lib/video/modules/ruttetra.ts.
//
// Architecture parity with OUTPUT (videoOut, post-PR-85):
//   - Renders into its own per-instance FBO. The card driving the visible
//     <canvas> calls `engine.blitOutputToDrawingBuffer(nodeId)` right
//     before its `drawImage(engine.canvas, ...)` blit so each card pulls
//     its own per-instance content (multi-MONOGLITCH + multi-OUTPUT patches
//     stay independent — no last-output-wins coupling on the shared FB).
//   - CHAINABLE OUTPUT: exposes its FBO texture via the standard `out`
//     port (same surface.texture used by the on-card preview), so users
//     can chain MONOGLITCH into downstream video modules.
//
// Render approach: per-scanline displacement in a fragment shader. We
// sample the input video, derive luminance per pixel, and for each
// horizontal scanline draw a thin band whose vertical position is
// shifted by luminance × intensity. The H/V CV inputs act as additional
// pan/zoom-style sweep offsets so plugging in saw LFOs makes the canvas
// pan as expected.
//
// Inputs:
//   in (video): RGB input (luma is extracted for the displacement amount).
//   hRamp / vRamp / intensity (cv, paramTarget=…): per-param CV.
//
// Outputs:
//   out (video): glitched RGB.
//
// Params:
//   hRamp (linear -1..1): horizontal sweep offset.
//   vRamp (linear -1..1): vertical sweep offset.
//   intensity (linear 0..1): luma-to-displacement scale.
//   lines (linear 8..240): scanline count.
//   spacing (linear 0..0.95): scanline duty cycle (1 = full bands, 0 = thin lines).
//   tintR / tintG / tintB (linear 0..1): tint applied to the drawn bands.

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';

const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uTex;
uniform float uHasInput;
uniform float uHRamp;       // -1..1 — horizontal pan from external CV
uniform float uVRamp;       // -1..1 — vertical pan from external CV
uniform float uIntensity;   // 0..1 — luminance → displacement magnitude
uniform float uLines;       // 8..240 — scanline count
uniform float uSpacing;     // 0..1 — extra row gap (visual line separation)
uniform float uTintR;
uniform float uTintG;
uniform float uTintB;

float luma(vec3 rgb) {
  return dot(rgb, vec3(0.299, 0.587, 0.114));
}

void main() {
  if (uHasInput < 0.5) {
    // Idle pattern matches OUTPUT — dark navy with a faint sweep so the
    // user can see the card is alive even when nothing's patched in.
    float v = vUv.y * 0.05;
    outColor = vec4(0.04, 0.06, 0.10 + v, 1.0);
    return;
  }

  // Apply ramp offsets (pan). Wrap at the edges so a saw LFO produces
  // smooth horizontal/vertical scrolling instead of clipping.
  vec2 srcUv = vec2(
    fract(vUv.x + uHRamp * 0.5 + 1.0),
    fract(vUv.y + uVRamp * 0.5 + 1.0)
  );

  // Quantize to N scanlines along Y. For each pixel, find which
  // scanline it belongs to + how close it is to the line center after
  // luminance displacement. The "line center" is the scanline's base Y
  // shifted upward by luminance × intensity.
  float n = max(8.0, uLines);
  float scanIdx = floor(srcUv.y * n);
  // Sample luminance once per scanline at the row's horizontal position
  // (matching the source pixel for this fragment).
  vec2 sampleUv = vec2(srcUv.x, (scanIdx + 0.5) / n);
  vec3 src = texture(uTex, sampleUv).rgb;
  float l = luma(src);

  // Each scanline's nominal Y in the destination canvas, biased upward
  // by luminance × intensity so bright pixels lift the line. The 0.4
  // factor caps maximum displacement so even at uIntensity=1 a fully-
  // bright scanline can't overlap the line above by more than ~half a
  // band.
  float baseY = (scanIdx + 0.5) / n;
  float displacedY = baseY - l * uIntensity * 0.4;

  // Distance of THIS fragment from the displaced line center, in
  // canvas-Y units. Compare against a thin band whose height shrinks
  // as line count grows so dense scanlines stay readable.
  float bandHeight = (1.0 / n) * (1.0 - clamp(uSpacing, 0.0, 0.95)) * 0.5;
  float d = abs(vUv.y - displacedY);
  float intensity = 1.0 - smoothstep(bandHeight * 0.5, bandHeight, d);

  // Color: tint × intensity, with a subtle brightness bonus from the
  // source luminance so a "bright" pixel reads brighter than a "dim"
  // displaced one.
  vec3 col = vec3(uTintR, uTintG, uTintB) * intensity * (0.4 + l * 0.8);
  outColor = vec4(col, 1.0);
}`;

interface MonoglitchParams {
  hRamp: number;
  vRamp: number;
  intensity: number;
  lines: number;
  spacing: number;
  tintR: number;
  tintG: number;
  tintB: number;
}

const DEFAULTS: MonoglitchParams = {
  hRamp: 0,
  vRamp: 0,
  intensity: 0.6,
  lines: 96,
  spacing: 0.2,
  // Default tint: classic green phosphor.
  tintR: 0.4,
  tintG: 1.0,
  tintB: 0.5,
};

// ⚠ THE MONITOR BOX IS NOT ON THIS DEF, deliberately. It lives at
// `$lib/ui/modules/monoglitch/monitor-box.ts`, beside the faced body, and the
// card imports it from there — ONE source, as the backdraft rule requires; the
// only question this answers is WHERE that source sits. `lib/video/**` is swept
// wholesale into the WebGL attest basis, so putting six layout numbers here
// would make every edit to them a real-GPU re-attest for values that cannot
// change a rendered GL pixel. See that file's header for the measurement.

export const monoglitchDef: VideoModuleDef = {
  type: 'monoglitch',
  palette: { top: 'Video modules', sub: 'Processors' },
  domain: 'video',
  label: 'monoglitch',
  category: 'output',
  inputs: [
    // Video source. `video` is the polymorphic type so users can patch
    // mono-video / image / keys via the engine's implicit upcasts.
    { id: 'in',        type: 'video' },
    // CV inputs — port id == param id so the cross-domain CV bridge in
    // PatchEngine routes audio cv signals into setParam(portId).
    { id: 'hRamp',     type: 'cv', paramTarget: 'hRamp', cvScale: { mode: 'linear' } },
    { id: 'vRamp',     type: 'cv', paramTarget: 'vRamp', cvScale: { mode: 'linear' } },
    { id: 'intensity', type: 'cv', paramTarget: 'intensity', cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'out', type: 'video' },
  ],
  params: [
    { id: 'hRamp',     label: 'H Ramp',    defaultValue: DEFAULTS.hRamp,     min: -1, max: 1, curve: 'linear' },
    { id: 'vRamp',     label: 'V Ramp',    defaultValue: DEFAULTS.vRamp,     min: -1, max: 1, curve: 'linear' },
    { id: 'intensity', label: 'Z',         defaultValue: DEFAULTS.intensity, min: 0,  max: 1, curve: 'linear' },
    { id: 'lines',     label: 'Lines',     defaultValue: DEFAULTS.lines,     min: 8,  max: 240, curve: 'linear' },
    { id: 'spacing',   label: 'Spacing',   defaultValue: DEFAULTS.spacing,   min: 0,  max: 0.95, curve: 'linear' },
    { id: 'tintR',     label: 'Tint R',    defaultValue: DEFAULTS.tintR,     min: 0,  max: 1, curve: 'linear' },
    { id: 'tintG',     label: 'Tint G',    defaultValue: DEFAULTS.tintG,     min: 0,  max: 1, curve: 'linear' },
    { id: 'tintB',     label: 'Tint B',    defaultValue: DEFAULTS.tintB,     min: 0,  max: 1, curve: 'linear' },
  ],

  // ── THE FACEPLATE ────────────────────────────────────────────────────────
  //
  // WHAT IT IS, MUSICALLY. MONOGLITCH quantises the incoming picture into a
  // stack of horizontal scanlines and LIFTS each line by the luma it samples at
  // its own row centre, so bright rows bow upward and dark rows stay flat. That
  // is the whole module: one displacement term, `baseY - luma * Z * 0.4`. Its
  // two siblings do different things with the same family of idea — `ruttetra`
  // scatters a 320x180 GRID into 3D relief, `reshaper` remaps coordinates — so
  // the thing only this one does is a PER-LINE vertical bend with a phosphor
  // tint. The verb a player performs is LIFT.
  //
  // THE TIER LADDER, read back as a sentence: at mini you get Z, the luma->lift
  // scale that IS the effect (at 0 the module is an inert flat line-stack); at
  // compact, Z and LINES — how hard the picture bends the stack, and how many
  // lines there are to bend; at plate, GAP and the two pan ramps join them; the
  // phosphor triple is dock-only.
  //
  // ⚠ THE PLATE BOUNDARY FALLS INSIDE THE TINT TRIPLE, and the rank is NOT
  // distorted to avoid it. `LANE_PLATE_MAX_CELLS` is 6 and this module has
  // exactly five geometry params, so the sixth slot is a tint whatever order is
  // authored — there is no arrangement that keeps R/G/B whole below the dock.
  // Promoting a pan offset over the module's colour to tidy the boundary would
  // rank a default-0, CV-driven convenience above a control that is always
  // live, which is a worse claim than showing one channel of three.
  //
  // ⚠ ORDER AND PAGES DISAGREE, deliberately. `order` is PRIORITY (what the
  // tiers showing a subset choose); `pages` is SIGNAL ORDER (how the shader
  // actually reads: sample -> quantise -> displace -> colour). So `intensity`
  // is rank 1 while its page sits first for a different reason, and the two pan
  // ramps rank below `spacing` while forming their own page.
  face: {
    order: ['intensity', 'lines', 'spacing', 'hRamp', 'vRamp', 'tintR', 'tintG', 'tintB'],

    // Four pages, one per TERM of the fragment shader — not four groupings of
    // taste. `DOCK_TAB_MIN_BANDS` is 7, so this renders as ONE COLUMN and that
    // is correct; padding to a rail is refused by the owner ruling. All four
    // bands total 8 controls, under `DOCK_ROW_MAX_CONTROLS = 10`, so PF-21
    // packs them into a single row.
    pages: [
      {
        id: 'lift',
        label: 'lift',
        hint: 'the luma x Z displacement term - the module\'s whole identity: how far a bright scanline rises out of the flat stack. At 0 every line sits at its nominal position and the effect is off',
        controls: ['intensity'],
      },
      {
        id: 'raster',
        label: 'raster',
        hint: 'the line stack the picture is quantised into before anything displaces it - how many lines span the frame, and how much of each line\'s slot is drawn as band rather than gap',
        controls: ['lines', 'spacing'],
      },
      {
        id: 'pan',
        label: 'pan',
        hint: 'the sampling offset applied before quantisation, wrapped at the edges - the CV seam, where a saw LFO scrolls the whole field rather than clipping it',
        controls: ['hRamp', 'vRamp'],
      },
      {
        id: 'tint',
        label: 'tint',
        hint: 'the phosphor colour every band is multiplied by. Disjoint from the geometry above: these three move colour and nothing else',
        controls: ['tintR', 'tintG', 'tintB'],
      },
    ],

    // ⚠ MANDATORY AND COUNTER-INTUITIVE, the same trap ruttetra, backdraft,
    // spirographs and mirrorpool all document. `primaryAudioOutPortId` needs a
    // `type: 'audio'` output and this def has none, so ANY other glyph literal
    // falls through `glyphBinding` to `{kind:'static'}` and reddens
    // module-face-lint's dead-glyph clause. The live picture arrives from two
    // OTHER seams — `hasVideoSurface(def)` mounting VideoTileThumb at the lane,
    // and the `fullViewBody` extension at the dock — so assert
    // `hasVideoSurface`, never this declaration.
    glyph: 'none',

    // THE SCREEN SWITCH, THE MONITOR TOGGLE AND THE RESIZE HANDLE ALL ARRIVE
    // THROUGH THIS SLOT (#1928 / #2009). Promotion sets `migrated('monoglitch')`
    // true and neither surface renders `MonoglitchCard.svelte` again, so
    // anything living only on that card is deleted by the promotion meant to
    // keep it.
    extension: 'monoglitch',

    // ⚠ MONITOR MODE. `MonoglitchCard.svelte` mounts `hideControls` — the
    // toggle at `:210-217`, the resizable canvas at `:221-229` — and this def's
    // own `docs.explanation` has advertised the gesture since it shipped ("in
    // hide-controls mode the preview is resizable by dragging the corner
    // handle"). This is the SECOND of the five cards #2009 named; ruttetra
    // proved the seam and this is the first inheritor of it.
    //
    // ⚠ VERIFIED AGAINST THE CARD, NOT THE PROSE. The docs sentence alone is
    // not evidence the affordance exists — that is precisely the failure mode
    // #2009 describes, where a def-reading gate believes the def that tells the
    // lie. The card genuinely mounts the key, so the mode is honest here.
    monitor: {
      why:
        'MONOGLITCH\'s output is a PICTURE YOU READ BY LOOKING: a stack of scanlines whose bend IS '
        + 'the luma of the source, so the thing you are judging — does that bow read as the image, '
        + 'or as noise — is a shape no control reports. Every dial here aims at that one picture '
        + '(the lift term, the raster it bends, the pan that scrolls it, the phosphor it is drawn '
        + 'in), which makes "set it, then watch it" the module\'s actual working loop rather than a '
        + 'convenience. Its docs have advertised the monitor since it shipped, and at high LINES '
        + 'counts the moire between the band grid and the source is only visible at size.',
    },

    // The card draws all eight as `<NeonFader>` THROWS, and nothing in a
    // ParamDef separates "a throw" from any other continuous scalar — so
    // undeclared, the face would repaint every one as a dial and stop looking
    // like the control the player already knows.
    //
    // ⚠ UNLIKE RUTTETRA THERE IS NO EXCEPTION HERE, and it is worth saying why
    // rather than leaving the asymmetry to look like an oversight: ruttetra
    // keeps `xShape`/`yShape` as dials because they declare `landmarks`, which
    // ONLY `KnobConic` renders. NO monoglitch param declares `landmarks` or
    // `options` — every one is a plain continuous scalar — so declaring `fader`
    // across the board deletes nothing.
    paramCells: {
      intensity: 'fader', lines: 'fader', spacing: 'fader',
      hRamp: 'fader', vRamp: 'fader',
      tintR: 'fader', tintG: 'fader', tintB: 'fader',
    },

    // ⚠ NO `bareCells`. The `tint` heading says these three are the phosphor
    // colour; it does NOT say which is which. R/G/B are the only thing
    // separating three otherwise-identical faders, so hiding those captions is
    // the one thing that would make them indistinguishable — the tidyVco side
    // of that ruling, not the mixmstrs side.
    //
    // ⚠ NO `hero`, NO READOUT ROW, NO SIDEBAR — the 2026-08-19 rulings deleted
    // the shapes. Naming the finding that lost its surface, as the ruling
    // requires: the BAND HEIGHT, `(1/lines) * (1 - spacing) * 0.5`, which is the
    // one derived quantity on this module a player cannot read off either dial
    // — at lines=240 the bands are thinner than a device pixel and GAP stops
    // doing anything visible. It survives in `docs.controls` (corrected in this
    // diff, where it should have been all along) rather than as resting text.
  },

  docs: {
    explanation: "MONOGLITCH is a luma-driven scanline-displacement glitch effect that doubles as a chainable video OUTPUT. It quantizes the incoming video into a stack of horizontal scanlines (Lines count) and, per line, samples the source luminance at the row center and lifts that line's vertical position upward by luma x Z, so bright pixels bow the lines up while dark areas leave them flat. Each line is rendered as a thin tinted band whose thickness is set by Gap and whose color comes from the R/G/B tint (default a green-phosphor look); the source luminance also gives bright bands a subtle brightness bonus (band color scales by 0.4 + luma x 0.8). H Ramp and V Ramp pan the sampled image horizontally/vertically and wrap at the edges, so feeding them saw LFOs scrolls the whole field. Despite the historical RUTTETRA name it is NOT a true Rutt/Etra raster remap (see reshaper/ruttetra for that) - it is a stylized oscilloscope/CRT-glitch aesthetic. Patch a video source into IN, dial Lines and Z for the scan density and warp, tint to taste, then take OUT into another video module or to screen. With nothing patched it shows a dark-navy idle sweep. There is a live preview screen with the picture, and two switches beside it that do opposite things: SCREEN turns the preview off to reclaim its space (the module goes on rendering either way), and MONITOR hides the control bands so the picture has the whole plate to itself - drag the bottom-right corner to size it, and click MONITOR again to bring the controls back. Either way it is a viewport only; neither changes the output resolution.",
    inputs: {
      in: "Video source. Its per-pixel luminance (sampled once per scanline at the row center) is what drives every scanline's vertical displacement; with no input the card shows a dark-navy idle sweep. Accepts video/image/keys via the engine's implicit upcasts.",
      hRamp: "CV that modulates the H Ramp control (horizontal pan). Sampling wraps at the edges, so a saw LFO here scrolls the image left/right seamlessly.",
      vRamp: "CV that modulates the V Ramp control (vertical pan). Wraps at the edges, so a saw LFO here scrolls the scanline field up/down seamlessly.",
      intensity: "CV that modulates the Z control (luma-to-displacement scale) - the amount each scanline lifts upward in response to source brightness.",
    },
    outputs: {
      out: "Glitched RGB video: the tinted, luma-displaced scanline field rendered into this module's own per-instance FBO. Chainable into downstream video modules or to an OUTPUT/screen.",
    },
    controls: {
      hRamp: "H Ramp (labeled H, -1..1): horizontal pan offset applied to the sampled image; wraps at the edges so it scrolls rather than clips. 0 = no pan.",
      vRamp: "V Ramp (labeled V, -1..1): vertical pan offset applied to the sampled image; wraps at the edges so it scrolls rather than clips. 0 = no pan.",
      intensity: "Z (labeled Z, 0..1): luma-to-displacement scale. Higher values lift bright scanlines further upward (max upward shift = luma x Z x 0.4 of canvas height, so a fully-bright line at Z=1 won't overlap the line above by more than ~half a band); 0 leaves all lines flat at their nominal positions. Default 0.6.",
      lines: "Lines (labeled Lines, 8..240): number of horizontal scanlines the image is quantized into. More lines = a denser, finer scan; band thickness auto-shrinks as the count rises to stay readable. Default 96.",
      spacing: "Spacing (labeled Gap, 0..0.95): scanline gap / band thinning. 0 = thickest bands; toward 0.95 = thin lines with wide dark gaps between them. Default 0.2. The drawn band height is (1 / Lines) x (1 - Gap) x 0.5 of the frame - so it depends on BOTH controls, and neither dial can report it alone. That matters at the top of the Lines range: at Lines = 240 the band is under a device pixel tall on a 1080-line output even at Gap = 0, so raising Gap further stops making a visible difference and the picture just dims.",
      tintR: "Tint R (labeled R, 0..1): red component of the band color. Default 0.4 (part of the green-phosphor default tint).",
      tintG: "Tint G (labeled G, 0..1): green component of the band color. Default 1.0 (part of the green-phosphor default tint).",
      tintB: "Tint B (labeled B, 0..1): blue component of the band color. Default 0.5 (part of the green-phosphor default tint).",
    },
  },
  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);

    const uTex       = gl.getUniformLocation(program, 'uTex');
    const uHasInput  = gl.getUniformLocation(program, 'uHasInput');
    const uHRamp     = gl.getUniformLocation(program, 'uHRamp');
    const uVRamp     = gl.getUniformLocation(program, 'uVRamp');
    const uIntensity = gl.getUniformLocation(program, 'uIntensity');
    const uLines     = gl.getUniformLocation(program, 'uLines');
    const uSpacing   = gl.getUniformLocation(program, 'uSpacing');
    const uTintR     = gl.getUniformLocation(program, 'uTintR');
    const uTintG     = gl.getUniformLocation(program, 'uTintG');
    const uTintB     = gl.getUniformLocation(program, 'uTintB');

    // Own FBO for test-harness reads + future per-OUTPUT visible-canvas
    // routing. Mirrors videoOut's pattern.
    const { fbo, texture } = ctx.createFbo();

    const params: MonoglitchParams = { ...DEFAULTS, ...(node.params as Partial<MonoglitchParams>) };
    let lastInputTexture: WebGLTexture | null = null;

    function bindInputAndUniforms(inputTex: WebGLTexture | null) {
      gl.uniform1f(uHasInput, inputTex ? 1.0 : 0.0);
      if (inputTex) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, inputTex);
        gl.uniform1i(uTex, 0);
      }
      gl.uniform1f(uHRamp,     params.hRamp);
      gl.uniform1f(uVRamp,     params.vRamp);
      gl.uniform1f(uIntensity, params.intensity);
      gl.uniform1f(uLines,     params.lines);
      gl.uniform1f(uSpacing,   params.spacing);
      gl.uniform1f(uTintR,     params.tintR);
      gl.uniform1f(uTintG,     params.tintG);
      gl.uniform1f(uTintB,     params.tintB);
    }

    const surface: VideoNodeSurface = {
      fbo,
      texture,
      draw(frame) {
        const g = frame.gl;
        const inputTex = frame.getInputTexture(node.id, 'in');
        lastInputTexture = inputTex;

        // Render into our own per-instance FBO. The card's draw() calls
        // engine.blitOutputToDrawingBuffer(nodeId) right before its
        // drawImage(engine.canvas) blit, so each MONOGLITCH card shows its
        // own input rather than racing other OUTPUTs through the shared
        // default framebuffer (PR-85 multi-OUTPUT pattern).
        g.bindFramebuffer(g.FRAMEBUFFER, fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.useProgram(program);
        bindInputAndUniforms(inputTex);
        ctx.drawFullscreenQuad();
      },
      dispose() {
        gl.deleteFramebuffer(fbo);
        gl.deleteTexture(texture);
        gl.deleteProgram(program);
      },
    };

    return {
      domain: 'video',
      surface,
      setParam(paramId, value) {
        if (paramId in params) (params as unknown as Record<string, number>)[paramId] = value;
      },
      readParam(paramId) {
        return (params as unknown as Record<string, number>)[paramId];
      },
      read(key) {
        if (key === 'hasInput') return lastInputTexture !== null;
        if (key === 'fboTexture') return texture;
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};

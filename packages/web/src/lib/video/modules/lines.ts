// packages/web/src/lib/video/modules/lines.ts
//
// LINES — procedural line/grid mono-video source. Phase 0 implementation
// of the spec at
//
// What renders this round:
//   - Procedural sin-wave-edged lines at a chosen orientation, frequency,
//     and thickness. Phase scrolls slowly so the demo is visibly animated.
//   - FM input (mono-video texture port) — not yet wired in this Phase 0
//     spike; the input port exists so the I/O surface is forward-compatible
//     and tests can assert handle parity. The shader will pick it up in
//     Phase 3 (fmDepth uniform plumbing complete here, so it's literally
//     a one-line shader change).
//
// Output type is `mono-video`; downstream consumers (OUTPUT, future
// MIXER mono pots, COLORIZER via implicit upcast to video) will route
// through the engine's input-texture lookup.
//
// Inputs:
//   fm (mono-video): optional FM modulator (Phase-3 hookup; depth uniform plumbed).
//   orient / amp / thickness / phase (cv, paramTarget=…): per-param CV.
//
// Outputs:
//   out (mono-video): the rendered procedural line pattern.
//
// Params:
//   orient (linear 0..1): line orientation (0 = horizontal → 1 = vertical).
//   amp (linear 0.5..50 lpx): line frequency (lines per width).
//   thickness (linear 0..1): line duty cycle.
//   phase (linear 0..1): phase offset (scrolls slowly over time).
//   fmDepth (linear 0..1): depth of the (forward-compatible) FM modulator.

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';

const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform float uOrient;     // 0 = horizontal, 0.5 = diagonal, 1 = vertical
uniform float uAmp;        // lines per screen
uniform float uThickness;  // 0..1 — band half-width
uniform float uPhase;      // 0..1 — scroll
uniform float uFmDepth;    // 0..1 — modulator gain (Phase 3 wiring)

void main() {
  // Rotate UV so 'orient' selects the line direction. We center on (0.5,
  // 0.5) so the rotation happens around the canvas middle instead of the
  // bottom-left corner, which would slide the pattern off-screen at high
  // orient values.
  //
  // Spec convention: orient=0 -> HORIZONTAL lines (wave varies along Y),
  // orient=1 -> VERTICAL lines (wave varies along X). We swap sin/cos
  // from the naive (cos, sin) ordering so theta=0 reads t = c.y and
  // theta=PI/2 reads t = c.x. The earlier r1 mapping had this inverted
  // (orient=0 produced vertical lines); this is the section 3.7 fix
  // carried into Phase-1.
  float theta = uOrient * 1.5707963; // 0 → 0, 1 → π/2
  vec2 c = vUv - 0.5;
  float t = c.x * sin(theta) + c.y * cos(theta);

  // Procedural line waveform. The sin() argument is the per-pixel phase;
  // we use smoothstep on its absolute distance from a zero crossing to
  // get a soft-edged stripe. Higher uAmp → more lines on screen.
  // uThickness in [0, 1] maps to band half-width: 0 = razor-thin, 1 =
  // fully white. We want bright bands where |wave| < uThickness, with
  // a soft edge straddling that threshold.
  float wave = abs(sin(6.2831853 * uAmp * (t + uPhase)));
  float edge = max(0.005, uThickness * 0.5);
  float band = 1.0 - smoothstep(uThickness - edge, uThickness + edge, wave);

  // Phase 0: emit the band as a mono signal in the red channel; the
  // other two RGB channels are zero. Downstream consumers that treat
  // this as a mono-video stream (engine-level upcast to grayscale) only
  // sample R; the implicit-upcast set is documented in graph/types.ts.
  outColor = vec4(band, band, band, 1.0);

  // Suppress unused-uniform warnings until Phase 3 plumbs FM.
  outColor.rgb *= 1.0 + uFmDepth * 0.0;
}`;

interface LinesParams {
  orient: number;
  amp: number;
  thickness: number;
  phase: number;
  fmDepth: number;
}

const DEFAULTS: LinesParams = {
  orient: 0.0,        // horizontal lines by default
  amp: 12,            // 12 lines per screen
  thickness: 0.35,    // ~35% duty — bright/dark stripes, plenty of contrast
  phase: 0.0,         // scrolls per frame in render loop
  fmDepth: 0.0,
};

export const linesDef: VideoModuleDef = {
  type: 'lines',
  palette: { top: 'Video modules', sub: 'Sources' },
  domain: 'video',
  label: 'lines',
  category: 'sources',
  inputs: [
    { id: 'fm', type: 'mono-video' },
    // Per-param CV inputs. The cross-domain CV bridge in PatchEngine
    // routes audio-side cv signals into VideoEngine.setParam, where the
    // target param id == this input port id. So the port ids MUST match
    // the param ids exactly (`orient`, `amp`, `thickness`, `phase`).
    // `fmDepth` is omitted — that's what the `fm` mono-video input is
    // for; modulating its depth via cv would double-up the same idea.
    { id: 'orient',    type: 'cv', paramTarget: 'orient', cvScale: { mode: 'linear' } },
    { id: 'amp',       type: 'cv', paramTarget: 'amp', cvScale: { mode: 'linear' } },
    { id: 'thickness', type: 'cv', paramTarget: 'thickness', cvScale: { mode: 'linear' } },
    { id: 'phase',     type: 'cv', paramTarget: 'phase', cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'out', type: 'mono-video' },
  ],
  params: [
    { id: 'orient',    label: 'Orient',    defaultValue: DEFAULTS.orient,    min: 0,    max: 1,  curve: 'linear' },
    { id: 'amp',       label: 'Amp',       defaultValue: DEFAULTS.amp,       min: 0.5,  max: 50, curve: 'linear', units: 'lpx' },
    { id: 'thickness', label: 'Thickness', defaultValue: DEFAULTS.thickness, min: 0,    max: 1,  curve: 'linear' },
    { id: 'phase',     label: 'Phase',     defaultValue: DEFAULTS.phase,     min: 0,    max: 1,  curve: 'linear' },
    { id: 'fmDepth',   label: 'FM Depth',  defaultValue: DEFAULTS.fmDepth,   min: 0,    max: 1,  curve: 'linear' },
  ],

  // ── #1726 — the param with NO USER CONTROL ────────────────────────────────
  //
  // ⚠ `fmDepth` IS DELIBERATELY INERT, NOT BROKEN, and the distinction is the
  // whole reason this declaration exists rather than a rank. Its own docs say
  // it: "The uniform is plumbed but multiplied by 0.0 in this Phase 0 shader,
  // and there is no CV input or card fader for it, so it currently has no
  // visible effect." The `fm` mono-video input is the same Phase-3
  // forward-compatibility. Nothing is wrong; the feature is not built yet.
  //
  // But `module-face-lint` COMPLETENESS requires every param to be ranked AND
  // to render exactly one interactive cell, so ranking it would paint a control
  // the shader multiplies by zero — "a faceplate must not paint a dead control
  // as a working one" (the macrooscillator rule). Declaring it here satisfies
  // completeness while asserting the OPPOSITE of a rank: the dock render-plan
  // parity gate then requires it to render EXACTLY ZERO cells, so the claim is
  // falsifiable in both directions rather than skipped.
  //
  // ⚠ `writer: 'internal'` IS THE MECHANICALLY CORRECT ARM, checked before it
  // was written. The union is `'cv-port' | 'internal'`, and `'internal'` is
  // defined as "NOTHING on the patch surface targets it … Asserted to have no
  // such port, so the day one is added this entry stops being true and says
  // so." `lines in fm` is `mono-video`, and no input declares
  // `paramTarget: 'fmDepth'` — so `cvWritersOf()` returns empty and the
  // 'cv-port' arm would have gone RED on the first lint run. The field is
  // anchored in BOTH directions, which is what makes it a declaration rather
  // than an excuse: WIRE the Phase-3 CV port and this entry reddens and gets
  // re-read by whoever wired it.
  noUserControl: [
    {
      param: 'fmDepth',
      writer: 'internal',
      why:
        'Phase-0 forward compatibility, not a control: the uniform is plumbed but the shader '
        + 'multiplies it by 0.0, and nothing on the patch surface targets it (the `fm` input is '
        + 'a mono-video texture port, not a paramTarget). Painting it would put a knob on the '
        + 'faceplate that provably cannot change a pixel. Phase 3 wires the shader and the CV '
        + 'port; at that point this entry stops being true and the anchor says so.',
    },
  ],

  // ── FACE (batch 23a) ──────────────────────────────────────────────────────
  //
  // WHAT LINES IS FOR: it is a GRATING. One trigonometric stripe field, dialled
  // by angle, density, duty and offset, emitted as mono-video. Its siblings
  // generate other primitives — `shapes` draws filled figures, `inwards` draws
  // concentric rings — and the thing only this one does is produce a straight
  // parallel field at an arbitrary angle, which is what makes it the fleet's
  // structural test pattern and a modulation texture for everything downstream.
  // The verb is RULE (as in ruled lines).
  //
  // THE TIER LADDER, read back as a sentence: at the smallest tier you get AMP,
  // the line COUNT — a 0.5..50 lpx span is the widest authority on this plate
  // by an order of magnitude, taking the picture from a couple of broad bands
  // to a fine moiré, and it is the control that decides what the pattern IS.
  // Add one and you get ORIENT, which decides which way it runs (0 horizontal,
  // 1 vertical, between = diagonal). Then THICKNESS, the duty cycle — it
  // changes how much ink is on screen but not the figure, and near 1 it just
  // floods the frame white. PHASE is LAST, and the reason is in the def's own
  // prose: the pattern "auto-scrolls on its own … so it is visibly alive
  // without touching a knob; your Phase value adds on top of that drift." It is
  // an offset onto an animation that runs regardless — the least load-bearing
  // control here, and the only one whose effect a player might never notice.
  face: {
    order: ['amp', 'orient', 'thickness', 'phase'],

    // ⚠ NO `pages`. Four controls describing ONE grating are a single honest
    // band. Splitting angle from density would buy two headings over four
    // faders and describe the shader's uniform list rather than the module.

    // ⚠ FADERS, NOT KNOBS — the parity-critical declaration. `LinesCard.svelte`
    // draws all four with `NeonFader`, and nothing in a ParamDef separates "a
    // level" from any other continuous scalar, so an undeclared face resolves
    // them to KNOBS and the promotion silently substitutes dials for throws.
    // ⚠ NO DEF-READING GATE CAN SEE THAT — `contract-lock`, `module-docs-lint`
    // and the range assertions all read this same def, which says nothing about
    // the primitive. Declared, not inferred.
    // ⚠ `fmDepth` IS ABSENT because it renders no cell at all (see
    // `noUserControl` above) — a `paramCells` entry for it would be a declared
    // primitive for a control that does not exist, which module-face-lint
    // refuses as a no-op declaration.
    paramCells: { amp: 'fader', orient: 'fader', thickness: 'fader', phase: 'fader' },

    // ⚠ NO `bareCells`. One unlabelled band, so no section heading exists to
    // make a caption redundant, and `Amp`/`Orient`/`Thickness`/`Phase` are the
    // only thing separating four identical throws — the tidyVco side of the
    // per-control-label ruling, not the mixmstrs side.

    // ⚠ MANDATORY FOR A VIDEO DEF — `primaryAudioOutPortId` needs a
    // `type: 'audio'` output and this def has none (`out` is `mono-video`), so
    // any other glyph literal falls through `glyphBinding` to a dead
    // `{kind:'static'}` that reddens module-face-lint's dead-glyph clause. The
    // live picture arrives from `hasVideoSurface(def)` at the lane and the
    // `fullViewBody` extension at the dock — assert THAT, never this.
    glyph: 'none',

    // SCREEN ON/OFF arrives through this slot (#1928). An ADDITION rather than
    // a port: `LinesCard.svelte` draws no preview.
    // See `$lib/ui/modules/lines/shell-extension.ts`.
    extension: 'lines',
  },

  docs: {
    explanation: "LINES is a procedural mono-video source that renders soft-edged parallel stripes whose orientation, count, thickness, and scroll you dial in. The shader rotates the UV space by Orient (0 = horizontal lines, 1 = vertical, anything between = diagonal), then computes wave = abs(sin(2pi * Amp * (position + Phase))) along that axis and lights up bright bands wherever the wave falls under the Thickness threshold, with a smoothstep soft edge straddling it. The result is a grayscale grating written equally to all three RGB channels (alpha 1). The pattern auto-scrolls on its own (Phase advances steadily over time, time * 0.15 wrapped to 0..1) so it is visibly alive without touching a knob; your Phase value adds on top of that drift. Patch the OUT into an OUTPUT screen, a video mixer, or a colorizer; use it as a structural test pattern or as a moving modulation texture for downstream video modules.",
    inputs: {
      fm: "mono-video FM modulator input. The fmDepth uniform is plumbed but this Phase 0 build does not yet feed the texture into the shader, so patching it has no visible effect for now; the port exists so the I/O surface stays forward-compatible (Phase 3 hookup).",
      orient: "CV input that modulates the Orient control, rotating the grating between horizontal (0) and vertical (1) through diagonal in between.",
      amp: "CV input that modulates the Amp control, changing how many stripes pack across the screen (the spatial frequency of the grating).",
      thickness: "CV input that modulates the Thickness control, widening or narrowing the bright bands (the stripe duty cycle).",
      phase: "CV input that modulates the Phase control, sliding the stripe pattern along its axis on top of the built-in auto-scroll.",
    },
    outputs: {
      out: "mono-video output carrying the rendered grayscale line/grating pattern. Route it to an OUTPUT screen, a video mixer, or a colorizer.",
    },
    controls: {
      orient: "Line orientation, 0 to 1 (linear). 0 = horizontal lines (the wave varies along Y), 1 = vertical lines (varies along X), intermediate values rotate the grating diagonally through pi/2. Default 0.",
      amp: "Line frequency in lines-per-width (lpx), 0.5 to 50 (linear). Higher values pack more stripes across the frame; low values give a few broad bands. Default 12.",
      thickness: "Band duty cycle, 0 to 1 (linear). It is the threshold below which the wave lights up: 0 = razor-thin bright lines, raising it fattens the bright bands until near 1 the frame goes mostly white. Default 0.35.",
      phase: "Phase offset, 0 to 1 (linear), sliding the stripes along their axis. Added on top of the steady built-in auto-scroll, so the pattern drifts even at 0. Default 0.",
      fmDepth: "Depth of the forward-compatible FM modulator, 0 to 1 (linear). The uniform is plumbed but multiplied by 0.0 in this Phase 0 shader, and there is no CV input or card fader for it, so it currently has no visible effect. Default 0.",
    },
  },
  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);

    const uOrient    = gl.getUniformLocation(program, 'uOrient');
    const uAmp       = gl.getUniformLocation(program, 'uAmp');
    const uThickness = gl.getUniformLocation(program, 'uThickness');
    const uPhase     = gl.getUniformLocation(program, 'uPhase');
    const uFmDepth   = gl.getUniformLocation(program, 'uFmDepth');

    const { fbo, texture } = ctx.createFbo();

    const params: LinesParams = { ...DEFAULTS, ...(node.params as Partial<LinesParams>) };

    const surface: VideoNodeSurface = {
      fbo,
      texture,
      draw(frame) {
        const g = frame.gl;
        g.bindFramebuffer(g.FRAMEBUFFER, fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.useProgram(program);

        // Auto-scroll: phase advances at a steady rate so the demo is
        // obviously alive without the user touching a knob. The user's
        // explicit `phase` param is added on top.
        const autoPhase = (frame.time * 0.15) % 1;
        g.uniform1f(uOrient,    params.orient);
        g.uniform1f(uAmp,       params.amp);
        g.uniform1f(uThickness, params.thickness);
        g.uniform1f(uPhase,     params.phase + autoPhase);
        g.uniform1f(uFmDepth,   params.fmDepth);

        ctx.drawFullscreenQuad();
        g.bindFramebuffer(g.FRAMEBUFFER, null);
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
      dispose() { surface.dispose(); },
    };
  },
};

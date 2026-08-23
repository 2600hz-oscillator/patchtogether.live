// packages/web/src/lib/video/modules/inwards.ts
//
// INWARDS — inward-zooming radial pattern generator (Phase-1 source module).
//
// The spec at originally framed
// INWARDS as a webcam source. For the Phase-1 module set we re-purpose the
// name (per the "8 modules to ship" plan in the agent kickoff): it is now
// a procedural source that draws concentric rings zooming inward, giving
// users a deterministic visual that doesn't depend on getUserMedia /
// device permissions. Webcam input belongs to a future INWARDS-CAM module
// once getUserMedia plumbing lands.
//
// What this draws: alternating bright/dark concentric rings centered on
// the canvas, with their phase scrolling inward over time. The `speed`
// param sets the zoom rate (positive = inward), `density` controls how
// many rings fit on screen, `thickness` controls the duty cycle.
//
// Output: mono-video. Cheap procedural shader; no input textures.
//
// Inputs:
//   speed / density / thickness (cv, paramTarget=…): per-param CV.
//
// Outputs:
//   out (mono-video): the concentric-rings render.
//
// Params:
//   speed (linear -2..2): zoom rate (positive = inward, negative = outward).
//   density (linear 1..50): rings-per-screen.
//   thickness (linear 0..1): bright-ring duty cycle.

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';

const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform float uTime;
uniform float uSpeed;     // zoom rate; positive = inward sweep
uniform float uDensity;   // rings per screen
uniform float uThickness; // 0..1 — band duty cycle

void main() {
  // Centered radial coordinate. We rescale so radius ~= 1.0 at the
  // canvas edge along the longer dimension, and then offset by time so
  // rings appear to zoom INTO the center as uTime increases.
  vec2 c = vUv - 0.5;
  float r = length(c);

  // Phase moves inward (subtract time*speed) so each ring contracts
  // toward the center over time. Scale density so a sane default
  // (~10) gives a pleasant ring count.
  float phase = r * uDensity - uTime * uSpeed;
  float wave = abs(sin(6.2831853 * phase));

  // Soft band around zero crossings, identical shaping to LINES so the
  // two source modules feel like siblings.
  float edge = max(0.005, uThickness * 0.5);
  float band = 1.0 - smoothstep(uThickness - edge, uThickness + edge, wave);

  outColor = vec4(band, band, band, 1.0);
}`;

interface InwardsParams {
  speed: number;
  density: number;
  thickness: number;
}

const DEFAULTS: InwardsParams = {
  speed: 0.5,
  density: 10,
  thickness: 0.35,
};

export const inwardsDef: VideoModuleDef = {
  type: 'inwards',
  palette: { top: 'Video modules', sub: 'Sources' },
  domain: 'video',
  label: 'inwards',
  category: 'sources',
  inputs: [
    // Per-param CV inputs. Mirrors the LINES CV pattern (PR-65): the
    // cross-domain CV bridge in PatchEngine routes audio-side cv signals
    // into VideoEngine.setParam, where the target param id == this input
    // port id. So the port ids MUST match the param ids exactly
    // (`speed`, `density`, `thickness`).
    { id: 'speed',     type: 'cv', paramTarget: 'speed', cvScale: { mode: 'linear' } },
    { id: 'density',   type: 'cv', paramTarget: 'density', cvScale: { mode: 'linear' } },
    { id: 'thickness', type: 'cv', paramTarget: 'thickness', cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'out', type: 'mono-video' },
  ],
  params: [
    { id: 'speed',     label: 'Speed',     defaultValue: DEFAULTS.speed,     min: -2,   max: 2,   curve: 'linear' },
    { id: 'density',   label: 'Density',   defaultValue: DEFAULTS.density,   min: 1,    max: 50,  curve: 'linear' },
    { id: 'thickness', label: 'Thickness', defaultValue: DEFAULTS.thickness, min: 0,    max: 1,   curve: 'linear' },
  ],

  // ── FACE (batch-22 · the video thin tail) ─────────────────────────────────
  face: {
    order: ['speed', 'density', 'thickness'],

    // ⚠ NO `pages`. Three controls that jointly describe ONE ring field — how
    // fast it sweeps, how many rings fit, how fat each band is — are a single
    // honest band. Sectioning them would be three headings over three controls.

    // ⚠ FADERS, NOT KNOBS — the parity-critical declaration on this face.
    // `InwardsCard.svelte` draws all three with `NeonFader`. Nothing in a
    // ParamDef separates "a level" from any other continuous scalar, so an
    // undeclared face resolves them to KNOBS and the promotion silently swaps a
    // dial in for a throw — invisible to every def-reading gate, since they all
    // read this same def.
    //
    // ⚠ `speed` IS BIPOLAR (-2..2) AND STILL A FADER. Its centre detent is the
    // still frame and the sign is the sweep DIRECTION (positive inward,
    // negative outward); a throw shows that zero crossing as a position, which
    // is the reading the card already gives players.
    paramCells: { speed: 'fader', density: 'fader', thickness: 'fader' },

    // ⚠ NO `bareCells` — no section heading exists to make Speed/Density/
    // Thickness redundant, and they name three genuinely different quantities.

    // ⚠ MANDATORY FOR A VIDEO DEF — this def has no `type: 'audio'` output
    // (`out` is `mono-video`), so `primaryAudioOutPortId` is null and any other
    // glyph literal resolves to a dead `{kind:'static'}` that reddens
    // module-face-lint.
    //
    // ⚠ AND THE PICTURE THIS FACE PAINTS IS A MOVING ONE, which is this
    // module's one determinism note: it is the only SOURCE in the batch and its
    // shader advances with `uTime` at the shipped default (Speed 0.5). Its VRT
    // scene therefore pins `__videoEngineFreezeTime` through `simPin` rather
    // than declaring a `freeze` ParamDef — the render is a pure function of
    // (wall clock, params), so pinning the clock alone is sufficient here in a
    // way it explicitly is NOT for `mirrorpool`, whose ping-pong field keeps
    // integrating. Adding a `freeze` param would have been a contract change
    // for a determinism problem the engine already solves.
    glyph: 'none',

    // SCREEN ON/OFF arrives through this slot (#1928): promotion stops BOTH
    // surfaces rendering `InwardsCard.svelte`. On a SOURCE the switch is the
    // more pointed case — the body keeps the watch mark alive while the screen
    // is off, so turning the picture off never mutes the generator every
    // downstream node is sampling. See
    // `$lib/ui/modules/inwards/shell-extension.ts`.
    extension: 'inwards',
  },

  docs: {
    explanation:
      "A procedural source that synthesizes a field of concentric rings centered on the frame, with their phase scrolling inward over time so the bands appear to zoom toward the center (positive Speed) or outward (negative). The shader takes the radial distance from center, multiplies it by Density to set how many rings fit on screen, then subtracts time*Speed to animate the sweep; an abs(sin) wave is soft-banded by Thickness to render alternating bright and dark grayscale rings. There is no video input — it generates its image entirely from time and the three params, so it works without camera permissions. Use it as a hypnotic radial backdrop or a moving mask/wipe source: patch an LFO or envelope into Speed for pulsing zoom, or sweep Density for a tunnel-breathing effect.",
    inputs: {
      speed: "CV input that modulates the Speed control — the zoom rate of the inward ring sweep. Positive values pull rings toward the center, negative push them outward.",
      density: "CV input that modulates the Density control, setting how many concentric rings are packed onto the screen. Higher CV tightens the spacing into a finer pattern.",
      thickness: "CV input that modulates the Thickness control — the duty cycle of the bright bands, i.e. how wide the lit rings are versus the dark gaps between them.",
    },
    outputs: {
      out: "Mono-video output carrying the rendered grayscale concentric-rings frame (bright bands on a dark field), ready to patch into any video input.",
    },
    controls: {
      speed: "Speed (-2 to 2, default 0.5): the zoom rate of the rings. Positive values sweep the pattern inward toward the center, negative values sweep it outward; 0 freezes the rings still.",
      density: "Density (1 to 50, default 10): the number of rings per screen. Low values give a few broad rings; high values pack the frame with many tight, fine concentric bands.",
      thickness: "Thickness (0 to 1, default 0.35): the bright-ring duty cycle. Low values give thin bright rings on a wide dark field; higher values widen the lit bands and shrink the gaps between them.",
    },
  },
  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);

    const uTime      = gl.getUniformLocation(program, 'uTime');
    const uSpeed     = gl.getUniformLocation(program, 'uSpeed');
    const uDensity   = gl.getUniformLocation(program, 'uDensity');
    const uThickness = gl.getUniformLocation(program, 'uThickness');

    const { fbo, texture } = ctx.createFbo();

    const params: InwardsParams = { ...DEFAULTS, ...(node.params as Partial<InwardsParams>) };

    const surface: VideoNodeSurface = {
      fbo,
      texture,
      draw(frame) {
        const g = frame.gl;
        g.bindFramebuffer(g.FRAMEBUFFER, fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.useProgram(program);

        g.uniform1f(uTime,      frame.time);
        g.uniform1f(uSpeed,     params.speed);
        g.uniform1f(uDensity,   params.density);
        g.uniform1f(uThickness, params.thickness);

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

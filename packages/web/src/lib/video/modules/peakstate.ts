// packages/web/src/lib/video/modules/peakstate.ts
//
// PEAKSTATE — animated mandala generator (kaleidoscope mirror-arm
// pen-trace). Inspired by florianjs/Mandala-JS (MIT) — same idea, ported
// to the patchtogether.live video-module model with three distinct
// outputs:
//
//   mono_out — white pen on black, no colour cycling.
//   rgb_out  — HSL hue cycling at the COLOR rate.
//   out_3d   — same mandala painted with a tilted + rotating "fake 3D"
//              transform + a vertically-mirrored bowl twin (fat-line
//              v1 per the spec — a real tube fragment shader is a
//              future-PR upgrade).
//
// Architecture:
//   - The pen + ring-buffer + draw routines are PURE (peakstate-draw.ts)
//     so they're unit-testable + reusable. This file owns the GL side:
//     three OffscreenCanvas surfaces, three GL textures, three FBOs.
//   - Per frame we draw into the OffscreenCanvas via the pure routines,
//     then upload the canvas pixels to the texture via texSubImage2D.
//     The FBO is rendered by copying the texture (with a passthrough
//     shader) — same pattern DOOM uses for its CPU-rendered framebuffer.
//   - Module owns its own copy program (the engine's
//     drawFullscreenQuad path expects a texture sampler; we wire one
//     directly to keep this self-contained).
//   - 3D rotation derives from `speed` exactly as the spec dictates:
//     omega = speed * 0.3 rad/s, so 1× speed = ~17°/s, ~20 s/revolution.

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface, VideoEngineContext } from '$lib/video/engine';
import {
  makePenState,
  advancePen,
  drawMandalaFrame,
  drawMandalaTubeFrame,
  hueAtTime,
  hslToRgb,
  orbitCenter,
  type PenState,
  type RenderOpts,
} from './peakstate-draw';

/** Internal canvas resolution. Smaller than the engine FBO (640×480) so
 *  per-frame 2D draw + upload stays cheap; the GL copy bilinear-filters
 *  it back up. Matches ACIDWARP's "render small, upscale via GL filter"
 *  cadence. Square because the mandala is radially symmetric — a 4:3 or
 *  16:9 canvas would either crop the radii or paint dead pixels. */
const INTERNAL_DIM = 360;

interface PeakstateParams {
  speed: number;
  complexity: number;
  color_speed: number;
  /** Orbit amplitude for the spirograph centre — 0 pins the mandala at
   *  the canvas centre, 1 orbits at ORBIT_RADIUS_FRACTION × min(w,h). */
  move: number;
  /** Orbit eccentricity — 0 = perfect circle, 1 = near-horizontal tube
   *  (Y radius = OBLONG_MIN_Y_SCALE × X radius). */
  oblong: number;
}

const DEFAULTS: PeakstateParams = {
  speed: 1,
  complexity: 12,
  color_speed: 1,
  move: 0,
  oblong: 0,
};

// Passthrough copy shader. Used to blit each output's CPU-rendered
// texture into its own FBO so downstream consumers see fresh content.
// Y-flipped because the OffscreenCanvas's 2D origin (top-left) is
// opposite GL's bottom-left.
const COPY_FRAG_SRC = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
void main() {
  // Engine vertex shader flips Y at draw time so vUv = aPos*0.5+0.5;
  // we want the canvas's top row to land at the GL TOP, which after
  // FLIP_Y_WEBGL on upload is already correct. Sample directly.
  outColor = texture(uTex, vUv);
}`;

export const peakstateDef: VideoModuleDef = {
  type: 'peakstate',
  palette: { top: 'Video modules', sub: 'Sources' },
  domain: 'video',
  label: 'peakstate',
  // No 'video-effects' category in this registry (verified at write
  // time); 'sources' is the closest fit — PEAKSTATE generates a video
  // signal from internal state, with no input ports.
  category: 'sources',
  inputs: [
    // CV inputs are cheap to add (mirrors LINES / SHAPEDRAMPS) — port id
    // == param id so the cross-domain CV bridge routes audio cv signals
    // directly into VideoEngine.setParam.
    { id: 'speed_cv',       type: 'cv', paramTarget: 'speed',       cvScale: { mode: 'linear' } },
    { id: 'complexity_cv',  type: 'cv', paramTarget: 'complexity',  cvScale: { mode: 'linear' } },
    { id: 'color_speed_cv', type: 'cv', paramTarget: 'color_speed', cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'mono_out', type: 'mono-video' },
    { id: 'rgb_out',  type: 'video' },
    { id: 'out_3d',   type: 'video' },
  ],
  params: [
    { id: 'speed',       label: 'Speed',      defaultValue: DEFAULTS.speed,       min: 0.1, max: 4,  curve: 'linear' },
    { id: 'complexity',  label: 'Complexity', defaultValue: DEFAULTS.complexity,  min: 4,   max: 32, curve: 'discrete' },
    { id: 'color_speed', label: 'Color',      defaultValue: DEFAULTS.color_speed, min: 0,   max: 4,  curve: 'linear' },
    // MOVE + OBLONG drive the spirograph centre orbit (PR #__). The
    // existing speed/complexity knobs supply the harmonic ratio (arm
    // rotation × orbital period) that makes the curve trace as a
    // hypotrochoid-style rosette.
    { id: 'move',        label: 'Move',       defaultValue: DEFAULTS.move,        min: 0,   max: 1,  curve: 'linear' },
    { id: 'oblong',      label: 'Oblong',     defaultValue: DEFAULTS.oblong,      min: 0,   max: 1,  curve: 'linear' },
  ],

  // docs-hash-ignore:start
  docs: {
    explanation: `peakstate is a self-running mandala/kaleidoscope generator — a video SOURCE with no video input. An internal "pen" traces a deterministic drifting Lissajous path (penAtTime: x = 0.5·cos(0.7t), y = 0.5·sin(1.3t + 0.4·cos(0.3t))) through a centred unit disc, pushing one sample per frame into a 600-sample ring buffer (~10s of comet trail). Each frame the whole trail is redrawn once per kaleidoscope arm — rotated by 2π/complexity and mirrored about the arm axis — over a translucent black overlay that decays the previous frame, giving the classic mirror-arm bloom. MOVE + OBLONG add a slow spirograph orbit of the mandala's centre (period ~20s at Speed 1): MOVE sets orbit radius, OBLONG squashes the orbit's vertical extent from a circle toward a near-horizontal "rolling tube". The module emits three coherent views of the SAME pen trail with different palette/transform. Usage: drop it in for a generative kaleidoscope bloom, patch an LFO or envelope into the CV jacks to pulse the speed/arm-count/hue, and pick the mono, full-colour, or pseudo-3D output to suit the look.`,
    inputs: {
      speed_cv: "CV in that modulates the Speed control (linear), scaling how fast the pen advances along its trail and how fast the spirograph orbit and 3D rotation turn. Patch an LFO/envelope to pulse the whole bloom faster or slower.",
      complexity_cv: "CV in that modulates the Complexity control (linear) — the number of kaleidoscope mirror arms. Modulating it changes the radial symmetry (arm count) live; the value is rounded to a whole number of arms.",
      color_speed_cv: "CV in that modulates the Color control (linear), the hue-cycling rate of the RGB and 3D outputs. At 0 the hue is frozen; higher values sweep the HSL hue around the wheel faster (hue = t·color·60 mod 360).",
    },
    outputs: {
      mono_out: "Monochrome video out (mono-video cable): the white pen trail (#eee) on black, no hue cycling. The cleanest line-art view of the kaleidoscope, ideal for keying or feeding a colouriser downstream.",
      rgb_out: "Full-colour video out (video cable) and the module's primary/preview surface: the same mandala stroked in an HSL hue that cycles at the Color rate. This is what the on-card preview screen shows.",
      out_3d: "Pseudo-3D video out (video cable): the same mandala drawn with a fixed ~15° pitch tilt plus a continuous rotation (omega = Speed·0.3 rad/s, ~20s/turn) and a dimmed vertically-mirrored bowl twin, so it reads as a rotating sculpture on a horizon. Slightly desaturated and with faster trail decay than RGB.",
    },
    controls: {
      speed: "Speed (0.1–4, default 1): rate the pen advances along its trail; also drives the spirograph orbit speed and the 3D output's rotation (omega = Speed·0.3 rad/s). Modulatable via the SPD CV jack.",
      complexity: "Complexity (4–32, discrete, default 12): number of kaleidoscope mirror arms repeated around the centre — the radial symmetry order. Rounded to an integer. Modulatable via the CMP CV jack.",
      color_speed: "Color (0–4, default 1): hue-cycling rate for the RGB and 3D outputs (hue = t·color·60 mod 360); 0 freezes the hue, has no effect on the white mono output. Modulatable via the CLR CV jack.",
      move: "Move (0–1, default 0): spirograph orbit amplitude — at 0 the mandala is pinned dead centre; toward 1 its centre orbits along a path up to 0.25·min(width,height) from centre (period ~20s at Speed 1). No CV jack.",
      oblong: "Oblong (0–1, default 0): orbit eccentricity — 0 is a perfect circular orbit; toward 1 the orbit's vertical extent collapses to ~5% of its width, turning the spirograph into a near-horizontal rolling tube. Only matters when Move > 0. No CV jack.",
    },
  },
  // docs-hash-ignore:end
  factory(ctx: VideoEngineContext, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(COPY_FRAG_SRC);
    const uTex = gl.getUniformLocation(program, 'uTex');

    // One FBO + texture per output. Each is the FINAL render target the
    // engine's lookupInput consumer reads via outputTexture:<portId>.
    const fboMono = ctx.createFbo();
    const fboRgb  = ctx.createFbo();
    const fbo3d   = ctx.createFbo();

    // Per-output OffscreenCanvas surfaces. We draw the mandala onto
    // these with 2D context calls, then upload to the GL texture below.
    // OffscreenCanvas is mainstream-browser-only; fall back to a
    // regular HTMLCanvasElement in jsdom (tests) — the unit tests don't
    // exercise the factory's draw path, but the type-check still wants
    // a valid TexImageSource so we keep the fall-back in place.
    function makeCanvas(): { canvas: OffscreenCanvas | HTMLCanvasElement; ctx2d: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D } {
      if (typeof OffscreenCanvas !== 'undefined') {
        const c = new OffscreenCanvas(INTERNAL_DIM, INTERNAL_DIM);
        const cx = c.getContext('2d', { alpha: false }) as OffscreenCanvasRenderingContext2D | null;
        if (!cx) throw new Error('PEAKSTATE: OffscreenCanvas 2D context unavailable');
        return { canvas: c, ctx2d: cx };
      }
      if (typeof document !== 'undefined') {
        const c = document.createElement('canvas');
        c.width = INTERNAL_DIM; c.height = INTERNAL_DIM;
        const cx = c.getContext('2d', { alpha: false });
        if (!cx) throw new Error('PEAKSTATE: HTMLCanvas 2D context unavailable');
        return { canvas: c, ctx2d: cx };
      }
      throw new Error('PEAKSTATE: no canvas surface available');
    }
    const cvMono = makeCanvas();
    const cvRgb  = makeCanvas();
    const cv3d   = makeCanvas();

    // Per-output upload textures. We bind these as samplers to the copy
    // shader and run a fullscreen-quad into the matching FBO.
    function makeUploadTex(): WebGLTexture {
      const t = gl.createTexture();
      if (!t) throw new Error('PEAKSTATE: createTexture failed');
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, INTERNAL_DIM, INTERNAL_DIM, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    }
    const texMono = makeUploadTex();
    const texRgb  = makeUploadTex();
    const tex3d   = makeUploadTex();

    const params: PeakstateParams = { ...DEFAULTS, ...(node.params as Partial<PeakstateParams>) };
    // One shared pen state — the SAME pen drives all three outputs so
    // they're visually coherent (same trail, different palette/transform).
    const pen: PenState = makePenState();

    let lastTime = -1;
    /** Cumulative rotation for the 3D output. Independent of the pen
     *  clock so it advances even at color_speed=0; tied to params.speed
     *  per the spec (omega = speed * 0.3 rad/s). */
    let rotation3d = 0;
    /** VRT seed flag — set once in the draw() after the harness's
     *  `__peakstateVrtSeed = true` is seen. Resets the ring + t + rotation
     *  to fixed values, paints once at those values, then BLOCKS further
     *  pen advance + rotation advance so the frame is pixel-stable across
     *  runs. Mirrors the `__foxyVrtSeed` pattern. */
    let vrtSeeded = false;
    function vrtSeedActive(): boolean {
      return !!(globalThis as unknown as { __peakstateVrtSeed?: boolean }).__peakstateVrtSeed;
    }

    // Pitch (camera tilt) is fixed at 15° per the spec. Lifted into a
    // const so the 3D output reads the same pitch every frame.
    const PITCH_RAD = (15 * Math.PI) / 180;

    /** Upload a 2D canvas's pixels into a pre-allocated GL texture and
     *  copy it into the named output FBO via the passthrough shader.
     *  This is the per-frame transfer for one of the three outputs. */
    function uploadAndBlit(
      canvas: OffscreenCanvas | HTMLCanvasElement,
      tex: WebGLTexture,
      fboOut: WebGLFramebuffer,
    ): void {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      // FLIP_Y so canvas top-row → GL top after sampler reads. We
      // restore the default afterward so unrelated module uploads
      // aren't affected.
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0, 0,
        gl.RGBA, gl.UNSIGNED_BYTE,
        canvas as unknown as TexImageSource,
      );
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

      gl.bindFramebuffer(gl.FRAMEBUFFER, fboOut);
      gl.viewport(0, 0, ctx.res.width, ctx.res.height);
      gl.useProgram(program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(uTex, 0);
      ctx.drawFullscreenQuad();
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    const surface: VideoNodeSurface = {
      fbo: fboRgb.fbo,         // canonical surface — rgb_out is the "primary"
      texture: fboRgb.texture, // (cards' single-output preview reads this)
      draw(frame) {
        const tNow = frame.time;
        const dt = lastTime < 0 ? 0 : Math.max(0, tNow - lastTime);
        lastTime = tNow;

        // Coerce knob ranges to legal values. Clamp keeps a misconfigured
        // CV from blowing up the algorithm.
        const speed = Math.max(0, params.speed);
        const complexity = Math.max(1, Math.round(params.complexity));
        const colorSpeed = Math.max(0, params.color_speed);
        // MOVE + OBLONG clamp to [0,1]; the spirograph orbit collapses to
        // a degenerate "no motion" at move=0 (which orbitCenter() honours
        // exactly — no float drift past baseCx, baseCy).
        const move = Math.max(0, Math.min(1, params.move));
        const oblong = Math.max(0, Math.min(1, params.oblong));

        // VRT-seed path: paint ONCE from a deterministic ring + frozen
        // rotation, then HOLD that frame across subsequent draws. The
        // captured baseline is pixel-stable across runs because nothing
        // advances after the seed fills the ring.
        if (vrtSeedActive()) {
          if (!vrtSeeded) {
            pen.ring.reset();
            pen.t = 0;
            rotation3d = 0;
            // Seed the ring at fixed time steps so the trail is the same
            // every run. ~120 samples is enough to draw a recognisable
            // mandala without overflowing the test budget.
            for (let i = 0; i < 120; i++) {
              advancePen(pen, 1 / 60, 1);
            }
            // ONE-SHOT determinism prime (DRS / VRT): clear all three
            // OffscreenCanvases to FULL-OPAQUE black on the seeding frame so
            // frame 1 starts from a deterministic clean base instead of
            // whatever happened to be on the canvas at boot. The comet-trail
            // residue then settles from an IDENTICAL start on every run /
            // renderer, so a short warmup converges it — the render-smoke no
            // longer needs a 48-step warmup to wash out boot garbage.
            for (const cv of [cvMono, cvRgb, cv3d]) {
              cv.ctx2d.save();
              cv.ctx2d.globalAlpha = 1;
              cv.ctx2d.fillStyle = 'rgb(0, 0, 0)';
              cv.ctx2d.fillRect(0, 0, INTERNAL_DIM, INTERNAL_DIM);
              cv.ctx2d.restore();
            }
            vrtSeeded = true;
          }
          // No further pen / rotation advance — the frame is frozen.
        } else {
          // Advance the pen + ring buffer. ONE write per frame, shared
          // across all three outputs (so they're always coherent).
          advancePen(pen, dt, speed);
          // Rotation for the 3D output. omega = speed * 0.3 rad/s.
          rotation3d += dt * speed * 0.3;
        }

        // Macro orbit for the spirograph: the same (cx, cy) is shared
        // across all three outputs so they stay coherent (same pen, same
        // orbit, different palette/transform). Uses the engine-time
        // `pen.t` so the orbit clock and the pen clock are bit-equal —
        // critical for the VRT-seed path (vrtSeeded freezes pen.t at 0,
        // which orbitCenter() resolves to (baseCx, baseCy) exactly).
        const baseCx = INTERNAL_DIM / 2;
        const baseCy = INTERNAL_DIM / 2;
        const { cx, cy } = orbitCenter(
          pen.t, baseCx, baseCy, move, oblong, speed, INTERNAL_DIM, INTERNAL_DIM,
        );

        // --- mono_out: white pen on black, no colour cycling. ---
        const monoOpts: RenderOpts = {
          complexity,
          color: { r: 238, g: 238, b: 238 }, // #eee from the spec
          decayAlpha: 0.05,
          centerX: cx,
          centerY: cy,
        };
        drawMandalaFrame(cvMono.ctx2d as unknown as Parameters<typeof drawMandalaFrame>[0], INTERNAL_DIM, INTERNAL_DIM, pen.ring, monoOpts);
        uploadAndBlit(cvMono.canvas, texMono, fboMono.fbo);

        // --- rgb_out: HSL hue cycling. ---
        const hue = hueAtTime(pen.t, colorSpeed);
        const rgb = hslToRgb(hue, 0.8, 0.6);
        const rgbOpts: RenderOpts = {
          complexity,
          color: rgb,
          decayAlpha: 0.05,
          centerX: cx,
          centerY: cy,
        };
        drawMandalaFrame(cvRgb.ctx2d as unknown as Parameters<typeof drawMandalaFrame>[0], INTERNAL_DIM, INTERNAL_DIM, pen.ring, rgbOpts);
        uploadAndBlit(cvRgb.canvas, texRgb, fboRgb.fbo);

        // --- out_3d: tilted + rotating + bowl-twin. Slightly desaturated
        // colour so the "depth" reads. ---
        const hue3d = hueAtTime(pen.t, colorSpeed);
        const rgb3d = hslToRgb(hue3d, 0.5, 0.55);
        const tubeOpts: RenderOpts = {
          complexity,
          color: rgb3d,
          decayAlpha: 0.08, // slightly faster decay so the rotating
                            // sculpture doesn't smear into a blur
          centerX: cx,
          centerY: cy,
        };
        drawMandalaTubeFrame(
          cv3d.ctx2d as unknown as Parameters<typeof drawMandalaTubeFrame>[0],
          INTERNAL_DIM,
          INTERNAL_DIM,
          pen.ring,
          tubeOpts,
          PITCH_RAD,
          rotation3d,
        );
        uploadAndBlit(cv3d.canvas, tex3d, fbo3d.fbo);
      },
      dispose() {
        gl.deleteFramebuffer(fboMono.fbo);
        gl.deleteTexture(fboMono.texture);
        gl.deleteFramebuffer(fboRgb.fbo);
        gl.deleteTexture(fboRgb.texture);
        gl.deleteFramebuffer(fbo3d.fbo);
        gl.deleteTexture(fbo3d.texture);
        gl.deleteTexture(texMono);
        gl.deleteTexture(texRgb);
        gl.deleteTexture(tex3d);
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
        // Per-output texture lookup — the engine's lookupInput honors
        // outputTexture:<portId> before falling back to surface.texture
        // (see VideoEngine.lookupInput + SHAPEDRAMPS for the precedent).
        if (key === 'outputTexture:mono_out') return fboMono.texture;
        if (key === 'outputTexture:rgb_out')  return fboRgb.texture;
        if (key === 'outputTexture:out_3d')   return fbo3d.texture;
        // Card preview reads the RGB output canvas directly (cheap; no GL
        // readback). Same access pattern as ACIDWARP's 'snapshot'.
        if (key === 'previewCanvas') return cvRgb.canvas;
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};

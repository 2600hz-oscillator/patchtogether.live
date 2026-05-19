<script lang="ts">
  // WavesculptCard — hybrid 4-oscillator 3D video synth.
  //
  // The card is dense: a small per-osc strip up top, the rendered video
  // screen + camera controls in the middle, and the "bentscreen wiggles"
  // (12 BENTBOX knobs) at the bottom. The card is resizeable.
  //
  // Rendering: a private WebGL2 context attached to an OffscreenCanvas
  // (or a hidden HTMLCanvasElement on jsdom). We render the 3D ribbons
  // (one per oscillator, colored by index) in clip space using a vertex
  // shader that takes (sample-along-vector, ribbon-side) attributes and
  // a fragment shader that applies the BENTBOX post-pass. Two passes:
  //   1. Render ribbons → scene FBO.
  //   2. Apply BENTBOX shader on scene FBO → display FBO (which is also
  //      the OffscreenCanvas's default framebuffer).
  // The OffscreenCanvas pixels are then blitted onto:
  //   * the visible on-card <canvas> via drawImage() each rAF tick;
  //   * the engine's video bridge (via the module's drawFrame hook), so
  //     downstream video modules see the rendered scene as a texture.

  import { onMount, onDestroy } from 'svelte';
  import { useStore, type NodeProps } from '@xyflow/svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { patch } from '$lib/graph/store';
  import { startCornerResize } from './card-resize';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import type { ModuleNode } from '$lib/graph/types';
  import {
    wavesculptDef,
    installWavesculptFrameDrawer,
    uninstallWavesculptFrameDrawer,
  } from '$lib/audio/modules/wavesculpt';
  import { clampJoy } from '$lib/audio/modules/joystick';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();
  const flowStore = useStore();

  // ----- Resize plumbing (mirror BentboxCard) -----
  const DEFAULT_WIDTH = 1280;
  const DEFAULT_HEIGHT = 820;
  const MIN_WIDTH = 960;
  const MIN_HEIGHT = 680;
  const ENGINE_W = 640;
  const ENGINE_H = 360;

  let cardWidth = $derived<number>(
    (node?.data?.width as number | undefined) ?? DEFAULT_WIDTH,
  );
  let cardHeight = $derived<number>(
    (node?.data?.height as number | undefined) ?? DEFAULT_HEIGHT,
  );

  // ---- Reactive params ----
  const defaultFor = (key: string): number =>
    wavesculptDef.params.find((p) => p.id === key)!.defaultValue;

  function pget(key: string): number {
    return (node?.params?.[key] ?? defaultFor(key)) as number;
  }

  const set = (k: string) => (v: number) => {
    const t = patch.nodes[id]; if (t) t.params[k] = v;
  };
  const live = (k: string) => () => {
    const e = engineCtx.get(); if (!e || !node) return undefined;
    return e.readParam(node, k);
  };

  // Per-osc params bundled — we read these via pget() inside the render
  // loop, so we don't need granular $derived bindings for every one.
  // But we DO need top-level $derived for the bentscreen knobs (they're
  // bound directly to the <Knob> components below).
  let hsync_drift        = $derived(pget('hsync_drift'));
  let hsync_loss         = $derived(pget('hsync_loss'));
  let vsync_drift        = $derived(pget('vsync_drift'));
  let scan_wobble        = $derived(pget('scan_wobble'));
  let chroma_phase       = $derived(pget('chroma_phase'));
  let chroma_instability = $derived(pget('chroma_instability'));
  let feedback_gain      = $derived(pget('feedback_gain'));
  let feedback_delay     = $derived(pget('feedback_delay'));
  let wavefold           = $derived(pget('wavefold'));
  let bloom              = $derived(pget('bloom'));
  let noise              = $derived(pget('noise'));
  let master_gain        = $derived(pget('master_gain'));

  // Camera params
  let pos_x = $derived(clampJoy(pget('pos_x')));
  let pos_y = $derived(clampJoy(pget('pos_y')));
  let pos_z = $derived(clampJoy(pget('pos_z')));
  let zoom  = $derived(pget('zoom'));
  let unison = $derived(pget('unison'));
  let detune = $derived(pget('detune'));

  // Per-osc top-strip values (bind to <Knob> in DOM).
  let morph1 = $derived(pget('morph1'));
  let morph2 = $derived(pget('morph2'));
  let morph3 = $derived(pget('morph3'));
  let morph4 = $derived(pget('morph4'));
  let A1 = $derived(pget('A1'));
  let D1 = $derived(pget('D1'));
  let S1 = $derived(pget('S1'));
  let R1 = $derived(pget('R1'));
  let A2 = $derived(pget('A2'));
  let D2 = $derived(pget('D2'));
  let S2 = $derived(pget('S2'));
  let R2 = $derived(pget('R2'));
  let A3 = $derived(pget('A3'));
  let D3 = $derived(pget('D3'));
  let S3 = $derived(pget('S3'));
  let R3 = $derived(pget('R3'));
  let A4 = $derived(pget('A4'));
  let D4 = $derived(pget('D4'));
  let S4 = $derived(pget('S4'));
  let R4 = $derived(pget('R4'));

  // ---- XY pad (joystick) on the card ----
  let padEl: HTMLDivElement | null = $state(null);
  let dragging = $state(false);
  const PAD_PX = 120;
  let dotX = $derived(((pos_x + 1) / 2) * PAD_PX);
  let dotY = $derived(((-pos_y + 1) / 2) * PAD_PX);

  function writeXY(x: number, y: number) {
    const t = patch.nodes[id]; if (!t) return;
    t.params.pos_x = clampJoy(x);
    t.params.pos_y = clampJoy(y);
  }
  function updateFromPointer(ev: PointerEvent) {
    if (!padEl) return;
    const rect = padEl.getBoundingClientRect();
    const px = (ev.clientX - rect.left) / rect.width;
    const py = (ev.clientY - rect.top) / rect.height;
    writeXY(px * 2 - 1, -(py * 2 - 1));
  }
  function padDown(ev: PointerEvent) {
    if (!padEl) return;
    dragging = true;
    padEl.setPointerCapture(ev.pointerId);
    updateFromPointer(ev);
    ev.preventDefault();
    ev.stopPropagation();
  }
  function padMove(ev: PointerEvent) {
    if (!dragging) return;
    updateFromPointer(ev);
  }
  function padUp(ev: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    try { padEl?.releasePointerCapture(ev.pointerId); } catch { /* */ }
    // No snap-back on the WAVESCULPT pad — the user expects the camera
    // to stay where they put it (vs the standalone JOYSTICK module
    // which DOES snap back). Keeps gestural performance steady.
  }

  // ---- WebGL2 renderer ----
  //
  // We build a private OffscreenCanvas + WebGL2 context the moment the
  // card mounts. The same canvas is the source for:
  //   (a) the on-card preview <canvas> (drawImage'd each rAF tick), and
  //   (b) the audio engine's drawFrame video bridge (we register a
  //       closure on the audio handle so its drawFrame writes our
  //       OffscreenCanvas pixels onto the bridge canvas).

  let renderCanvas: OffscreenCanvas | HTMLCanvasElement | null = null;
  let gl: WebGL2RenderingContext | null = null;
  let ribbonProgram: WebGLProgram | null = null;
  let bentboxProgram: WebGLProgram | null = null;
  let ribbonVao: WebGLVertexArrayObject | null = null;
  let quadVao: WebGLVertexArrayObject | null = null;
  let sceneFbo: WebGLFramebuffer | null = null;
  let sceneTex: WebGLTexture | null = null;
  let prevFbo: WebGLFramebuffer | null = null;
  let prevTex: WebGLTexture | null = null;
  let ribbonSamplesBuf: WebGLBuffer | null = null;
  let postPingTex: WebGLTexture | null = null;
  let postPingFbo: WebGLFramebuffer | null = null;

  // Number of segments per ribbon. 32 is plenty for v1 (the visual
  // language is "wave with thickness", not "high-res 3D model").
  const RIBBON_SEGMENTS = 32;
  const RES_W = 320;
  const RES_H = 240;

  // Vertex + fragment shader for the ribbon pass.
  // attributes:
  //   aIdx  — float, sample-along-vector index in [0, RIBBON_SEGMENTS-1]
  //   aSide — float, ribbon-side flag (0 = "top" of strip, 1 = "bottom")
  //   aOsc  — float, oscillator index in [0..3] (acts as color picker
  //           via a uniform array)
  // uniforms:
  //   uMVP        — mat4 model-view-projection (the user-camera)
  //   uOscColor[4] — vec4 per-osc RGBA color (alpha controls visibility)
  //   uSrc[4]     — vec4 (x,y,z, _) per-osc source position
  //   uVec[4]     — vec4 (x,y,z, _) per-osc inward direction
  //   uMorph[4]   — float per-osc morph (0..1; 0=saw, 0.5=sine, 1=tri)
  //   uEnv[4]     — float per-osc envelope amplitude (0..1)
  //   uTime       — seconds since start (for animated phase)
  //   uPhase[4]   — float per-osc audible Hz / scale factor (we pass a
  //                low-frequency "visual" phase rate to keep motion
  //                readable — audio Hz would alias badly at 60fps).
  const RIBBON_VS = `#version 300 es
in float aIdx;
in float aSide;
in float aOsc;

uniform mat4  uMVP;
uniform vec4  uSrc[4];
uniform vec4  uVec[4];
uniform float uMorph[4];
uniform float uEnv[4];
uniform float uPhase[4];

out float vT;     // 0..1 along ribbon
flat out int vOsc;

const float PI = 3.14159265;

float wave(float morph, float t, float env) {
  // Map t∈[0..1] to phase∈[0..4π] so we get 2 visible periods along
  // the ribbon. Selects saw / sine / triangle by morph (closest-shape
  // with smooth crossfade so the visual flows).
  float phi = t * 4.0 * PI + uPhase[0]; // shared visual phase — replaced per-osc below
  // saw: 2*frac(t/(2π)) - 1
  float saw = 2.0 * fract(phi / (2.0 * PI)) - 1.0;
  // sine
  float sine = sin(phi);
  // triangle: 2*|2*frac(t/(2π)) - 1| - 1
  float tri = 2.0 * abs(2.0 * fract(phi / (2.0 * PI)) - 1.0) - 1.0;
  // Crossfade by morph ∈ [0..1]: 0=saw, 0.5=sine, 1=tri.
  float w;
  if (morph < 0.5) {
    float k = morph * 2.0;
    w = mix(saw, sine, k);
  } else {
    float k = (morph - 0.5) * 2.0;
    w = mix(sine, tri, k);
  }
  // Scale by envelope amplitude.
  return w * env;
}

void main() {
  int idx = int(aOsc);
  vec3 src = uSrc[idx].xyz;
  vec3 dir = normalize(uVec[idx].xyz);
  float t = aIdx / float(${RIBBON_SEGMENTS - 1}); // 0..1

  // Position along the inward Vector.
  vec3 along = src + dir * (t * 2.0);   // walk across the box (length 2)

  // Build a perpendicular axis for the ribbon's "width". We use Y-up
  // unless dir is parallel to Y, in which case we use Z-up.
  vec3 up = abs(dir.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(0.0, 0.0, 1.0);
  vec3 perp = normalize(cross(dir, up));

  // Wave offset: oscillator-specific phase. We re-derive it inside the
  // shader because the uPhase[] array is referenced via dynamic index
  // (some GLSL impls reject that). Simpler: compute morph result with
  // a per-osc phase term added.
  float phi = t * 4.0 * PI + uPhase[idx];
  float saw = 2.0 * fract(phi / (2.0 * PI)) - 1.0;
  float sine = sin(phi);
  float tri = 2.0 * abs(2.0 * fract(phi / (2.0 * PI)) - 1.0) - 1.0;
  float w;
  float m = uMorph[idx];
  if (m < 0.5) {
    w = mix(saw, sine, m * 2.0);
  } else {
    w = mix(sine, tri, (m - 0.5) * 2.0);
  }
  // Scale wave by env, then by a "visual amplitude" constant so even
  // env=1 doesn't fly out of the box.
  float wAmt = w * uEnv[idx] * 0.45;

  // Ribbon thickness — small (0.02 units of the unit box).
  float side = aSide * 2.0 - 1.0; // -1 or +1
  vec3 thick = perp * side * 0.02 * (0.6 + 0.4 * uEnv[idx]);

  // Final position: along + perp displacement (the wave) + thickness.
  vec3 p = along + perp * wAmt + thick;
  gl_Position = uMVP * vec4(p, 1.0);
  vT = t;
  vOsc = idx;
}`;

  const RIBBON_FS = `#version 300 es
precision highp float;
in float vT;
flat in int vOsc;
out vec4 outColor;

uniform vec4 uOscColor[4];
uniform float uEnv[4];

void main() {
  vec4 base = uOscColor[vOsc];
  float env = uEnv[vOsc];
  // Glow along the ribbon (brighter in the middle, dimmer at ends).
  float band = smoothstep(0.0, 0.15, vT) * smoothstep(1.0, 0.85, vT);
  vec3 col = base.rgb * (0.6 + 0.6 * band) * (0.4 + 0.6 * env);
  outColor = vec4(col, base.a * (0.3 + 0.7 * env));
}`;

  // BENTBOX post-process. Same algorithmic shape as bentbox.ts. We
  // inline the shader source rather than import it; the spec asks us to
  // not refactor bentbox.ts.
  const BENT_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;

uniform sampler2D uIn;
uniform sampler2D uPrev;
uniform float uTime;
uniform float uFieldParity;

uniform float uHsyncDrift;
uniform float uHsyncLoss;
uniform float uVsyncDrift;
uniform float uScanWobble;
uniform float uChromaPhase;
uniform float uChromaInstability;
uniform float uFeedbackGain;
uniform float uFeedbackDelay;
uniform float uWavefold;
uniform float uBloom;
uniform float uNoise;
uniform float uMasterGain;

const float LINES = 240.0;
const float TWO_PI = 6.2831853;

float hash11(float n) {
  return fract(sin(n * 78.233) * 43758.5453);
}
float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}
vec3 rgb2yiq(vec3 c) {
  return vec3(
    0.299*c.r + 0.587*c.g + 0.114*c.b,
    0.596*c.r - 0.274*c.g - 0.322*c.b,
    0.211*c.r - 0.523*c.g + 0.312*c.b
  );
}
vec3 yiq2rgb(vec3 c) {
  return clamp(vec3(
    c.x + 0.956*c.y + 0.621*c.z,
    c.x - 0.272*c.y - 0.647*c.z,
    c.x - 1.106*c.y + 1.703*c.z
  ), 0.0, 1.0);
}
float wavefold(float v, float amt) {
  if (amt <= 0.0) return v;
  float s = v * (1.0 + amt * 3.0);
  float t = mod(s + 1.0, 4.0) - 1.0;
  if (t > 1.0) return 2.0 - t;
  if (t < -1.0) return -2.0 - t;
  return t;
}
float softClip(float v) {
  float v2 = v * v;
  return v * (27.0 + v2) / (27.0 + 9.0 * v2);
}

void main() {
  float lineIdx = floor(vUv.y * LINES);
  float lineY = (lineIdx + 0.5) / LINES;
  float driftRand = (hash11(lineIdx + floor(uTime * 12.0)) - 0.5) * 2.0;
  float hWobble = sin(lineIdx * 0.21 + uTime * 1.7) * uScanWobble * 0.06;
  float hOffset = driftRand * uHsyncDrift * 0.12 + hWobble;
  float lossRoll = hash11(lineIdx * 1.913 + floor(uTime * 3.7));
  if (lossRoll < uHsyncLoss * 0.18) {
    hOffset += (hash11(lineIdx * 7.91 + uTime) - 0.5) * 0.6;
  }
  float vOff = sin(uTime * 0.7) * uVsyncDrift * 0.4 + (uTime * uVsyncDrift * 0.05);
  vec2 sampleUv = vec2(fract(vUv.x + hOffset), fract(lineY + vOff));
  vec3 src = texture(uIn, sampleUv).rgb;
  vec3 yiq = rgb2yiq(src);
  float phaseNoise = (hash11(lineIdx * 2.31 + uTime * 0.9) - 0.5) * uChromaInstability;
  float ang = (uChromaPhase + phaseNoise) * TWO_PI;
  float ca = cos(ang); float sa = sin(ang);
  vec2 iq = vec2(yiq.y * ca - yiq.z * sa, yiq.y * sa + yiq.z * ca);
  yiq.y = iq.x; yiq.z = iq.y;
  float comp = yiq.x + (iq.x + iq.y) * 0.5;
  comp = wavefold(comp, uWavefold);
  comp = softClip(comp * uMasterGain);
  yiq.x = mix(yiq.x, comp - (iq.x + iq.y) * 0.5, uWavefold * 0.7 + uMasterGain * 0.1);
  vec3 decoded = yiq2rgb(yiq);
  vec2 prevUv = vec2(sampleUv.x, fract(sampleUv.y + uFeedbackDelay * 0.04 - 0.02));
  vec3 prev = texture(uPrev, prevUv).rgb;
  decoded = mix(decoded, max(decoded, prev), uFeedbackGain);
  if (uBloom > 0.0) {
    float luma = dot(decoded, vec3(0.299, 0.587, 0.114));
    float bloomBoost = smoothstep(0.6, 1.0, luma) * uBloom * 0.5;
    decoded += bloomBoost;
  }
  float lineFrac = fract(vUv.y * LINES + uFieldParity * 0.5);
  float scanDark = 0.4 + 0.6 * smoothstep(0.0, 0.4, lineFrac) * smoothstep(1.0, 0.6, lineFrac);
  decoded *= scanDark;
  float col = floor(vUv.x * 240.0 * 3.0);
  float phase = mod(col, 3.0);
  vec3 mask = vec3(
    phase < 0.5 ? 1.15 : 0.85,
    phase >= 0.5 && phase < 1.5 ? 1.15 : 0.85,
    phase >= 1.5 ? 1.15 : 0.85
  );
  decoded *= mask;
  if (uNoise > 0.0) {
    float n = hash21(vUv * vec2(740.0, 421.0) + uTime) - 0.5;
    decoded += vec3(n) * uNoise * 0.18;
  }
  outColor = vec4(clamp(decoded, 0.0, 1.0), 1.0);
}`;

  const QUAD_VS = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

  function compileShader(g: WebGL2RenderingContext, type: number, src: string): WebGLShader {
    const s = g.createShader(type);
    if (!s) throw new Error('createShader failed');
    g.shaderSource(s, src);
    g.compileShader(s);
    if (!g.getShaderParameter(s, g.COMPILE_STATUS)) {
      const log = g.getShaderInfoLog(s) || '<unknown>';
      console.error('[WAVESCULPT] shader compile failed:', log, '\n', src);
      g.deleteShader(s);
      throw new Error('shader compile failed: ' + log);
    }
    return s;
  }

  function linkProgram(g: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
    const vs = compileShader(g, g.VERTEX_SHADER, vsSrc);
    const fs = compileShader(g, g.FRAGMENT_SHADER, fsSrc);
    const p = g.createProgram();
    if (!p) throw new Error('createProgram failed');
    g.attachShader(p, vs);
    g.attachShader(p, fs);
    g.linkProgram(p);
    if (!g.getProgramParameter(p, g.LINK_STATUS)) {
      const log = g.getProgramInfoLog(p) || '<unknown>';
      console.error('[WAVESCULPT] program link failed:', log);
      g.deleteProgram(p);
      throw new Error('program link failed: ' + log);
    }
    g.deleteShader(vs);
    g.deleteShader(fs);
    return p;
  }

  function createFboTex(g: WebGL2RenderingContext, w: number, h: number): { fbo: WebGLFramebuffer; tex: WebGLTexture } {
    const tex = g.createTexture();
    if (!tex) throw new Error('createTexture failed');
    g.bindTexture(g.TEXTURE_2D, tex);
    g.texImage2D(g.TEXTURE_2D, 0, g.RGBA8, w, h, 0, g.RGBA, g.UNSIGNED_BYTE, null);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
    const fbo = g.createFramebuffer();
    if (!fbo) { g.deleteTexture(tex); throw new Error('createFramebuffer failed'); }
    g.bindFramebuffer(g.FRAMEBUFFER, fbo);
    g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, tex, 0);
    g.bindFramebuffer(g.FRAMEBUFFER, null);
    return { fbo, tex };
  }

  // Build ribbon geometry once.
  // Per oscillator, RIBBON_SEGMENTS samples × 2 sides → triangle strip.
  // Each vertex carries (aIdx, aSide, aOsc). We use a single big strip
  // of 4 ribbons stitched with degenerate triangles between them.
  function buildRibbonGeometry(): Float32Array {
    const verts: number[] = [];
    for (let osc = 0; osc < 4; osc++) {
      if (osc > 0) {
        // Degenerate stitch: repeat last vertex of prev ribbon + first
        // of this one so the strip "skips" between ribbons without
        // drawing connecting triangles.
        const prevLastIdx = RIBBON_SEGMENTS - 1;
        verts.push(prevLastIdx, 1, osc - 1);
        verts.push(0, 0, osc);
      }
      for (let i = 0; i < RIBBON_SEGMENTS; i++) {
        verts.push(i, 0, osc); // top of strip
        verts.push(i, 1, osc); // bottom
      }
    }
    return new Float32Array(verts);
  }

  // 4×4 matrix helpers — written tight to avoid pulling gl-matrix.
  //
  // CONVENTION: matrices are stored COLUMN-MAJOR per OpenGL convention,
  // i.e. m[col*4 + row]. mat4Perspective and mat4LookAt below produce
  // column-major matrices, and uniformMatrix4fv is called with
  // transpose=false — the multiply must therefore also operate
  // column-major. Previous bug: indices were laid out column-major but
  // the multiply used row-major math, producing a garbage MVP that
  // collapsed all geometry off-screen (black screen).
  function mat4Multiply(out: Float32Array, a: Float32Array, b: Float32Array): void {
    // out = a × b, all column-major: out[col*4 + row].
    for (let col = 0; col < 4; col++) {
      for (let row = 0; row < 4; row++) {
        let s = 0;
        for (let k = 0; k < 4; k++) {
          // A[row, k] = a[k*4 + row]; B[k, col] = b[col*4 + k].
          s += a[k * 4 + row]! * b[col * 4 + k]!;
        }
        out[col * 4 + row] = s;
      }
    }
  }
  function mat4Perspective(out: Float32Array, fovy: number, aspect: number, near: number, far: number): void {
    const f = 1 / Math.tan(fovy / 2);
    out.fill(0);
    out[0] = f / aspect;
    out[5] = f;
    out[10] = (far + near) / (near - far);
    out[11] = -1;
    out[14] = (2 * far * near) / (near - far);
  }
  function mat4LookAt(out: Float32Array, eye: [number, number, number], target: [number, number, number], up: [number, number, number]): void {
    const zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
    const zl = Math.hypot(zx, zy, zz) || 1;
    const fz = [zx / zl, zy / zl, zz / zl];
    // right = up × fz
    const rx = up[1] * fz[2]! - up[2] * fz[1]!;
    const ry = up[2] * fz[0]! - up[0] * fz[2]!;
    const rz = up[0] * fz[1]! - up[1] * fz[0]!;
    const rl = Math.hypot(rx, ry, rz) || 1;
    const r = [rx / rl, ry / rl, rz / rl];
    // upN = fz × right
    const ux = fz[1]! * r[2]! - fz[2]! * r[1]!;
    const uy = fz[2]! * r[0]! - fz[0]! * r[2]!;
    const uz = fz[0]! * r[1]! - fz[1]! * r[0]!;
    out[0] = r[0]!;  out[1] = ux;    out[2] = fz[0]!; out[3] = 0;
    out[4] = r[1]!;  out[5] = uy;    out[6] = fz[1]!; out[7] = 0;
    out[8] = r[2]!;  out[9] = uz;    out[10] = fz[2]!; out[11] = 0;
    out[12] = -(r[0]! * eye[0] + r[1]! * eye[1] + r[2]! * eye[2]);
    out[13] = -(ux * eye[0] + uy * eye[1] + uz * eye[2]);
    out[14] = -(fz[0]! * eye[0] + fz[1]! * eye[1] + fz[2]! * eye[2]);
    out[15] = 1;
  }

  let viewMat = new Float32Array(16);
  let projMat = new Float32Array(16);
  let mvpMat = new Float32Array(16);

  // Oscillator base RGBA colors.
  const OSC_COLORS: Array<[number, number, number, number]> = [
    [1.0, 0.20, 0.20, 1.0], // RED
    [0.20, 1.0, 0.30, 1.0], // GREEN
    [0.30, 0.50, 1.0, 1.0], // BLUE
    [0.85, 0.85, 0.85, 0.7], // ALPHA → faint white (v1 deferral note: this
    //                       would otherwise mask the alpha channel; v1
    //                       just shows it as a soft white outline so the
    //                       user still sees the fourth voice fire.)
  ];

  // Per-osc visual phase rate (rotations per second). Visual phase is
  // DECOUPLED from audio phase — audio is at ~hundreds-of-Hz which would
  // alias to noise at 60fps. We use a slow visible rate that responds to
  // pitch_cv readings via voiceState (read each frame).
  const VISUAL_PHASE_RATE = 0.8; // rotations / second per osc

  let renderStartMs = 0;
  let frameCount = 0;
  let phaseAcc: number[] = [0, 0, 0, 0];
  let lastFrameMs = 0;

  function initGl(): boolean {
    // Use OffscreenCanvas where available; in tests/jsdom this may be
    // undefined — fall back to a hidden HTMLCanvasElement.
    if (typeof OffscreenCanvas !== 'undefined') {
      renderCanvas = new OffscreenCanvas(RES_W, RES_H);
    } else if (typeof document !== 'undefined') {
      const c = document.createElement('canvas');
      c.width = RES_W;
      c.height = RES_H;
      renderCanvas = c;
    } else {
      return false;
    }
    gl = renderCanvas.getContext('webgl2', {
      alpha: false,
      premultipliedAlpha: false,
      antialias: false,
      preserveDrawingBuffer: true,
    }) as WebGL2RenderingContext | null;
    if (!gl) {
      console.warn('[WAVESCULPT] WebGL2 not available; card will not render');
      return false;
    }
    try {
      ribbonProgram = linkProgram(gl, RIBBON_VS, RIBBON_FS);
      bentboxProgram = linkProgram(gl, QUAD_VS, BENT_FS);
    } catch (err) {
      console.error('[WAVESCULPT] shader setup failed:', err);
      return false;
    }
    // Ribbon VAO/buffer.
    const geom = buildRibbonGeometry();
    ribbonVao = gl.createVertexArray();
    gl.bindVertexArray(ribbonVao);
    ribbonSamplesBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, ribbonSamplesBuf);
    gl.bufferData(gl.ARRAY_BUFFER, geom, gl.STATIC_DRAW);
    // attributes: aIdx (0), aSide (1), aOsc (2) — 3 floats each.
    const aIdxLoc = gl.getAttribLocation(ribbonProgram!, 'aIdx');
    const aSideLoc = gl.getAttribLocation(ribbonProgram!, 'aSide');
    const aOscLoc = gl.getAttribLocation(ribbonProgram!, 'aOsc');
    const stride = 3 * 4;
    if (aIdxLoc >= 0) {
      gl.enableVertexAttribArray(aIdxLoc);
      gl.vertexAttribPointer(aIdxLoc, 1, gl.FLOAT, false, stride, 0);
    }
    if (aSideLoc >= 0) {
      gl.enableVertexAttribArray(aSideLoc);
      gl.vertexAttribPointer(aSideLoc, 1, gl.FLOAT, false, stride, 4);
    }
    if (aOscLoc >= 0) {
      gl.enableVertexAttribArray(aOscLoc);
      gl.vertexAttribPointer(aOscLoc, 1, gl.FLOAT, false, stride, 8);
    }
    gl.bindVertexArray(null);

    // Quad VAO/buffer for the bentbox post-pass.
    quadVao = gl.createVertexArray();
    gl.bindVertexArray(quadVao);
    const qbuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, qbuf);
    gl.bufferData(gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW);
    const qPosLoc = gl.getAttribLocation(bentboxProgram!, 'aPos');
    if (qPosLoc >= 0) {
      gl.enableVertexAttribArray(qPosLoc);
      gl.vertexAttribPointer(qPosLoc, 2, gl.FLOAT, false, 0, 0);
    }
    gl.bindVertexArray(null);

    const fboA = createFboTex(gl, RES_W, RES_H);
    sceneFbo = fboA.fbo; sceneTex = fboA.tex;
    const fboB = createFboTex(gl, RES_W, RES_H);
    prevFbo = fboB.fbo; prevTex = fboB.tex;
    const fboC = createFboTex(gl, RES_W, RES_H);
    postPingFbo = fboC.fbo; postPingTex = fboC.tex;

    renderStartMs = performance.now();
    lastFrameMs = renderStartMs;
    return true;
  }

  function disposeGl(): void {
    if (!gl) return;
    try {
      if (ribbonProgram) gl.deleteProgram(ribbonProgram);
      if (bentboxProgram) gl.deleteProgram(bentboxProgram);
      if (ribbonVao) gl.deleteVertexArray(ribbonVao);
      if (quadVao) gl.deleteVertexArray(quadVao);
      if (sceneFbo) gl.deleteFramebuffer(sceneFbo);
      if (sceneTex) gl.deleteTexture(sceneTex);
      if (prevFbo) gl.deleteFramebuffer(prevFbo);
      if (prevTex) gl.deleteTexture(prevTex);
      if (postPingFbo) gl.deleteFramebuffer(postPingFbo);
      if (postPingTex) gl.deleteTexture(postPingTex);
      if (ribbonSamplesBuf) gl.deleteBuffer(ribbonSamplesBuf);
    } catch { /* */ }
    gl = null;
    renderCanvas = null;
  }

  function renderToOffscreen() {
    if (!gl || !ribbonProgram || !bentboxProgram) return;
    const g = gl;
    // 1) Render ribbons into sceneFbo.
    g.bindFramebuffer(g.FRAMEBUFFER, sceneFbo);
    g.viewport(0, 0, RES_W, RES_H);
    g.clearColor(0, 0, 0, 1);
    g.clear(g.COLOR_BUFFER_BIT);
    g.enable(g.BLEND);
    g.blendFunc(g.SRC_ALPHA, g.ONE);

    g.useProgram(ribbonProgram);

    // Camera setup. Read the LIVE AudioParam values (knob + CV-summed)
    // via engine.readParam so patched CV actually moves the camera —
    // node.params.* is the static knob value only and doesn't see CV.
    const ePcam = engineCtx.get();
    const liveOr = (k: string, fb: number): number => {
      const v = node && ePcam ? (ePcam.readParam(node, k) as number | undefined) : undefined;
      return typeof v === 'number' ? v : fb;
    };
    const camX = clampJoy(liveOr('pos_x', (node?.params.pos_x as number) ?? 0));
    const camY = clampJoy(liveOr('pos_y', (node?.params.pos_y as number) ?? 0));
    const camZ = clampJoy(liveOr('pos_z', (node?.params.pos_z as number) ?? 0));
    const zoomVal = Math.max(0.3, Math.min(3, liveOr('zoom', (node?.params.zoom as number) ?? 1)));
    const fovy = 1.2 / zoomVal; // shrink fov as zoom increases
    const aspect = RES_W / RES_H;
    mat4Perspective(projMat, fovy, aspect, 0.05, 6.0);
    // Eye is the user-camera; we look at the box center (0,0,0).
    const eye: [number, number, number] = [camX * 1.5, camY * 1.5, camZ * 1.5 + 2.5];
    mat4LookAt(viewMat, eye, [0, 0, 0], [0, 1, 0]);
    mat4Multiply(mvpMat, projMat, viewMat);

    const uMVP = g.getUniformLocation(ribbonProgram, 'uMVP');
    g.uniformMatrix4fv(uMVP, false, mvpMat);

    // Per-osc uniforms.
    const e = engineCtx.get();
    let voiceEnv: number[] = [0, 0, 0, 0];
    if (e && node) {
      // Engine.read(node, 'voiceState') → array of {env, phase}.
      try {
        const vs = e.read(node, 'voiceState') as Array<{ env: number; phase: string }> | undefined;
        if (Array.isArray(vs)) {
          voiceEnv = vs.map((v) => v?.env ?? 0);
        }
      } catch { /* engine may not be ready yet */ }
    }

    // Update visual phase per-osc — slow constant rate so motion stays
    // readable. Per-osc rate scales mildly with osc index for variation.
    const now = performance.now();
    const dt = Math.max(0, Math.min(0.5, (now - lastFrameMs) / 1000));
    lastFrameMs = now;
    for (let i = 0; i < 4; i++) {
      phaseAcc[i] = (phaseAcc[i]! + VISUAL_PHASE_RATE * (0.8 + 0.4 * i) * dt) % (Math.PI * 2);
    }

    // Pass per-osc arrays as Float32Array.
    const srcArr = new Float32Array(16);
    const vecArr = new Float32Array(16);
    const colArr = new Float32Array(16);
    const morphArr = new Float32Array(4);
    const envArr = new Float32Array(4);
    const phaseArr = new Float32Array(4);
    for (let i = 0; i < 4; i++) {
      const wall = [
        [ 1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0],
      ][i]!;
      const vec = [
        [-1, 0, 0], [ 1, 0, 0], [0,-1, 0], [0,  1, 0],
      ][i]!;
      srcArr[i * 4 + 0] = wall[0]!;
      srcArr[i * 4 + 1] = wall[1]!;
      srcArr[i * 4 + 2] = wall[2]!;
      srcArr[i * 4 + 3] = 0;
      vecArr[i * 4 + 0] = vec[0]!;
      vecArr[i * 4 + 1] = vec[1]!;
      vecArr[i * 4 + 2] = vec[2]!;
      vecArr[i * 4 + 3] = 0;
      const col = OSC_COLORS[i]!;
      colArr[i * 4 + 0] = col[0]!;
      colArr[i * 4 + 1] = col[1]!;
      colArr[i * 4 + 2] = col[2]!;
      colArr[i * 4 + 3] = col[3]!;
      morphArr[i] = (node?.params?.[`morph${i + 1}`] as number | undefined) ?? 0.5;
      envArr[i] = voiceEnv[i] ?? 0;
      phaseArr[i] = phaseAcc[i]!;
    }
    const uSrcLoc = g.getUniformLocation(ribbonProgram, 'uSrc[0]');
    const uVecLoc = g.getUniformLocation(ribbonProgram, 'uVec[0]');
    const uColLoc = g.getUniformLocation(ribbonProgram, 'uOscColor[0]');
    const uMorphLoc = g.getUniformLocation(ribbonProgram, 'uMorph[0]');
    const uEnvLoc = g.getUniformLocation(ribbonProgram, 'uEnv[0]');
    const uPhaseLoc = g.getUniformLocation(ribbonProgram, 'uPhase[0]');
    if (uSrcLoc) g.uniform4fv(uSrcLoc, srcArr);
    if (uVecLoc) g.uniform4fv(uVecLoc, vecArr);
    if (uColLoc) g.uniform4fv(uColLoc, colArr);
    if (uMorphLoc) g.uniform1fv(uMorphLoc, morphArr);
    if (uEnvLoc) g.uniform1fv(uEnvLoc, envArr);
    if (uPhaseLoc) g.uniform1fv(uPhaseLoc, phaseArr);

    // Draw the big stitched triangle strip.
    g.bindVertexArray(ribbonVao);
    // Total verts: 4 ribbons × 2*RIBBON_SEGMENTS + 3 stitches × 2 (degenerate pairs)
    const ribbonVerts = 4 * (2 * RIBBON_SEGMENTS) + 3 * 2;
    g.drawArrays(g.TRIANGLE_STRIP, 0, ribbonVerts);
    g.bindVertexArray(null);
    g.disable(g.BLEND);

    // 2) Bentbox post-pass: sceneTex + prevTex → postPingFbo (or default).
    g.bindFramebuffer(g.FRAMEBUFFER, postPingFbo);
    g.viewport(0, 0, RES_W, RES_H);
    g.useProgram(bentboxProgram);
    g.activeTexture(g.TEXTURE0);
    g.bindTexture(g.TEXTURE_2D, sceneTex);
    const uIn = g.getUniformLocation(bentboxProgram, 'uIn');
    if (uIn) g.uniform1i(uIn, 0);
    g.activeTexture(g.TEXTURE1);
    g.bindTexture(g.TEXTURE_2D, prevTex);
    const uPrev = g.getUniformLocation(bentboxProgram, 'uPrev');
    if (uPrev) g.uniform1i(uPrev, 1);
    const tSec = (performance.now() - renderStartMs) / 1000;
    g.uniform1f(g.getUniformLocation(bentboxProgram, 'uTime'), tSec);
    g.uniform1f(g.getUniformLocation(bentboxProgram, 'uFieldParity'), (frameCount & 1) ? 1 : 0);
    const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
    const clampSym = (v: number) => Math.max(-1, Math.min(1, v));
    g.uniform1f(g.getUniformLocation(bentboxProgram, 'uHsyncDrift'),        clamp01(node?.params?.hsync_drift as number ?? 0));
    g.uniform1f(g.getUniformLocation(bentboxProgram, 'uHsyncLoss'),         clamp01(node?.params?.hsync_loss as number ?? 0));
    g.uniform1f(g.getUniformLocation(bentboxProgram, 'uVsyncDrift'),        clamp01(node?.params?.vsync_drift as number ?? 0));
    g.uniform1f(g.getUniformLocation(bentboxProgram, 'uScanWobble'),        clamp01(node?.params?.scan_wobble as number ?? 0));
    g.uniform1f(g.getUniformLocation(bentboxProgram, 'uChromaPhase'),       clampSym(node?.params?.chroma_phase as number ?? 0));
    g.uniform1f(g.getUniformLocation(bentboxProgram, 'uChromaInstability'), clamp01(node?.params?.chroma_instability as number ?? 0));
    g.uniform1f(g.getUniformLocation(bentboxProgram, 'uFeedbackGain'),      clamp01(node?.params?.feedback_gain as number ?? 0));
    g.uniform1f(g.getUniformLocation(bentboxProgram, 'uFeedbackDelay'),     clamp01(node?.params?.feedback_delay as number ?? 0));
    g.uniform1f(g.getUniformLocation(bentboxProgram, 'uWavefold'),          clamp01(node?.params?.wavefold as number ?? 0));
    g.uniform1f(g.getUniformLocation(bentboxProgram, 'uBloom'),             clamp01(node?.params?.bloom as number ?? 0.4));
    g.uniform1f(g.getUniformLocation(bentboxProgram, 'uNoise'),             clamp01(node?.params?.noise as number ?? 0.05));
    g.uniform1f(g.getUniformLocation(bentboxProgram, 'uMasterGain'),        Math.max(0, Math.min(2, node?.params?.master_gain as number ?? 1)));
    g.bindVertexArray(quadVao);
    g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
    g.bindVertexArray(null);

    // 3) Blit postPing → default framebuffer (the OffscreenCanvas surface).
    g.bindFramebuffer(g.FRAMEBUFFER, null);
    g.viewport(0, 0, RES_W, RES_H);
    g.useProgram(bentboxProgram);
    g.activeTexture(g.TEXTURE0);
    g.bindTexture(g.TEXTURE_2D, postPingTex);
    if (uIn) g.uniform1i(uIn, 0);
    // 4) Save current post output as next-frame's feedback source by
    //    swapping prevTex with postPingTex names — simplest path is to
    //    just copy the postPing texture into prevTex via a copy pass.
    //    For v1, we re-use sceneFbo's prev slot by drawing again.
    // Simpler v1: snapshot postPing → prevTex by re-binding.
    g.bindFramebuffer(g.FRAMEBUFFER, prevFbo);
    g.viewport(0, 0, RES_W, RES_H);
    g.useProgram(bentboxProgram);
    g.activeTexture(g.TEXTURE0);
    g.bindTexture(g.TEXTURE_2D, postPingTex);
    if (uIn) g.uniform1i(uIn, 0);
    g.bindVertexArray(quadVao);
    g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
    g.bindVertexArray(null);
    g.bindFramebuffer(g.FRAMEBUFFER, null);

    // Render the final image to default fb a second time so the canvas
    // shows the user-visible frame (we just clobbered the canvas's
    // default fb with the prevFbo draw above).
    g.viewport(0, 0, RES_W, RES_H);
    g.useProgram(bentboxProgram);
    g.activeTexture(g.TEXTURE0);
    g.bindTexture(g.TEXTURE_2D, postPingTex);
    if (uIn) g.uniform1i(uIn, 0);
    g.bindVertexArray(quadVao);
    g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
    g.bindVertexArray(null);

    frameCount++;
  }

  // Install our drawFrame on the audio handle so the video bridge calls
  // into us. We also drive the on-card preview canvas from the same
  // render output.
  function installBridgeFrameDrawer(): void {
    // Install (or re-install) the card's renderer as this node's frame
    // drawer in the shared registry. The audio module's drawFrame reads
    // from that registry; the bridge calls drawFrame each video frame.
    installWavesculptFrameDrawer(id, (targetCanvas) => {
      if (!renderCanvas || !gl) return;
      // The renderer paints into renderCanvas (private OffscreenCanvas);
      // here we composite that onto the bridge's target canvas.
      const tc2d = targetCanvas.getContext('2d') as
        | OffscreenCanvasRenderingContext2D
        | CanvasRenderingContext2D
        | null;
      if (!tc2d) return;
      tc2d.fillStyle = '#000';
      tc2d.fillRect(0, 0, targetCanvas.width, targetCanvas.height);
      const cw = targetCanvas.width;
      const ch = targetCanvas.height;
      const srcAspect = RES_W / RES_H;
      const dstAspect = cw / ch;
      let w, h, x, y;
      if (dstAspect > srcAspect) {
        h = ch; w = Math.round(h * srcAspect);
        x = Math.round((cw - w) / 2); y = 0;
      } else {
        w = cw; h = Math.round(w / srcAspect);
        x = 0; y = Math.round((ch - h) / 2);
      }
      tc2d.drawImage(renderCanvas as CanvasImageSource, x, y, w, h);
    });
  }

  // ---- on-card preview canvas ----
  let displayCanvas: HTMLCanvasElement | null = $state(null);
  let rafId: number | null = null;

  function tick() {
    rafId = null;
    if (!gl) {
      // Lazy GL init in case the parent only just mounted us.
      initGl();
    }
    renderToOffscreen();
    if (displayCanvas && renderCanvas) {
      const dc2 = displayCanvas.getContext('2d', { alpha: false });
      if (dc2) {
        dc2.fillStyle = '#050608';
        dc2.fillRect(0, 0, displayCanvas.width, displayCanvas.height);
        const cw = displayCanvas.width;
        const ch = displayCanvas.height;
        const srcAspect = RES_W / RES_H;
        const dstAspect = cw / ch;
        let w, h, x, y;
        if (dstAspect > srcAspect) {
          h = ch; w = Math.round(h * srcAspect);
          x = Math.round((cw - w) / 2); y = 0;
        } else {
          w = cw; h = Math.round(w / srcAspect);
          x = 0; y = Math.round((ch - h) / 2);
        }
        // Y-flip (WebGL bottom-left vs canvas2d top-left).
        dc2.save();
        dc2.translate(x, y + h);
        dc2.scale(1, -1);
        dc2.drawImage(renderCanvas as CanvasImageSource, 0, 0, w, h);
        dc2.restore();
      }
    }
    rafId = requestAnimationFrame(tick);
  }

  onMount(() => {
    initGl();
    installBridgeFrameDrawer();
    rafId = requestAnimationFrame(tick);
  });
  onDestroy(() => {
    if (rafId !== null) cancelAnimationFrame(rafId);
    uninstallWavesculptFrameDrawer(id);
    disposeGl();
    if (resizeAbort) resizeAbort.abort();
  });

  // ---- Resize handle ----
  let resizing = $state(false);
  let resizeAbort: AbortController | null = null;
  function onResizeStart(ev: PointerEvent) {
    resizeAbort = startCornerResize(ev, {
      flowStore,
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      getStartSize: () => ({ width: cardWidth, height: cardHeight }),
      apply: (w, h) => {
        const target = patch.nodes[id];
        if (target) {
          if (!target.data) target.data = {};
          target.data.width = w;
          target.data.height = h;
        }
      },
      onStart: () => { resizing = true; },
      onEnd: () => { resizing = false; resizeAbort = null; },
    });
  }

  // ---- Ports ----
  const inputs: PortDescriptor[] = [
    { id: 'gate1',     label: 'G1', cable: 'gate' },
    { id: 'pitch_cv1', label: 'P1', cable: 'cv' },
    { id: 'gate2',     label: 'G2', cable: 'gate' },
    { id: 'pitch_cv2', label: 'P2', cable: 'cv' },
    { id: 'gate3',     label: 'G3', cable: 'gate' },
    { id: 'pitch_cv3', label: 'P3', cable: 'cv' },
    { id: 'gate4',     label: 'G4', cable: 'gate' },
    { id: 'pitch_cv4', label: 'P4', cable: 'cv' },
    { id: 'pos_x',     label: 'X',  cable: 'cv' },
    { id: 'pos_y',     label: 'Y',  cable: 'cv' },
    { id: 'pos_z',     label: 'H',  cable: 'cv' },
    { id: 'zoom',      label: 'Z',  cable: 'cv' },
    { id: 'alpha_in',  label: 'A',  cable: 'video' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'L',         label: 'L',   cable: 'audio' },
    { id: 'R',         label: 'R',   cable: 'audio' },
    { id: 'video_out', label: 'OUT', cable: 'mono-video' },
  ];

  // Strip definitions used inside the per-osc grid.
  const OSC_COLOR_LABELS = ['RED', 'GRN', 'BLU', 'ALP'];
</script>

<div
  class="card wavesculpt"
  class:resizing
  style="width: {cardWidth}px; height: {cardHeight}px;"
  data-testid="wavesculpt-card"
  data-node-id={id}
>
  <div class="stripe"></div>
  <header class="title">WAVESCULPT</header>

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="body">
      <!-- Per-oscillator strip -->
      <div class="osc-grid">
        {#each [0, 1, 2, 3] as i}
          <div class="osc-strip osc-{i}">
            <div class="osc-label">{OSC_COLOR_LABELS[i]}</div>
            <div class="osc-knobs">
              <Knob
                value={i === 0 ? morph1 : i === 1 ? morph2 : i === 2 ? morph3 : morph4}
                min={0} max={1} defaultValue={0.5} label="Morph" curve="linear"
                onchange={set(`morph${i + 1}`)} readLive={live(`morph${i + 1}`)}
              />
              <Knob
                value={i === 0 ? A1 : i === 1 ? A2 : i === 2 ? A3 : A4}
                min={0.001} max={5} defaultValue={0.01} label="A" curve="log" units="s"
                onchange={set(`A${i + 1}`)} readLive={live(`A${i + 1}`)}
              />
              <Knob
                value={i === 0 ? D1 : i === 1 ? D2 : i === 2 ? D3 : D4}
                min={0.001} max={5} defaultValue={0.1} label="D" curve="log" units="s"
                onchange={set(`D${i + 1}`)} readLive={live(`D${i + 1}`)}
              />
              <Knob
                value={i === 0 ? S1 : i === 1 ? S2 : i === 2 ? S3 : S4}
                min={0} max={1} defaultValue={0.7} label="S" curve="linear"
                onchange={set(`S${i + 1}`)} readLive={live(`S${i + 1}`)}
              />
              <Knob
                value={i === 0 ? R1 : i === 1 ? R2 : i === 2 ? R3 : R4}
                min={0.001} max={5} defaultValue={0.5} label="R" curve="log" units="s"
                onchange={set(`R${i + 1}`)} readLive={live(`R${i + 1}`)}
              />
            </div>
          </div>
        {/each}
      </div>

      <!-- Middle: rendered screen + camera controls -->
      <div class="mid-row">
        <div class="cam-controls">
          <div class="cam-section-label">CAMERA</div>
          <div
            class="pad nodrag"
            bind:this={padEl}
            style="width: {PAD_PX}px; height: {PAD_PX}px;"
            role="application"
            aria-label="Wavesculpt camera XY pad"
            data-testid="wavesculpt-pad"
            onpointerdown={padDown}
            onpointermove={padMove}
            onpointerup={padUp}
            onpointercancel={padUp}
          >
            <div class="cross-h"></div>
            <div class="cross-v"></div>
            <div class="dot" class:active={dragging} style="left: {dotX}px; top: {dotY}px;"></div>
          </div>
          <Knob value={pos_z} min={-1} max={1} defaultValue={0} label="Height" curve="linear" onchange={set('pos_z')} readLive={live('pos_z')} />
          <Knob value={zoom} min={0.3} max={3} defaultValue={1} label="Zoom" curve="log" onchange={set('zoom')} readLive={live('zoom')} />
        </div>

        <div class="screen-wrap" data-testid="wavesculpt-screen-wrap">
          <canvas
            bind:this={displayCanvas}
            width={ENGINE_W}
            height={ENGINE_H}
            data-testid="wavesculpt-canvas"
            data-node-id={id}
          ></canvas>
        </div>

        <div class="right-controls">
          <button
            type="button"
            class="unison-toggle"
            class:on={unison >= 0.5}
            data-testid="wavesculpt-unison"
            onclick={() => set('unison')(unison >= 0.5 ? 0 : 1)}
          >UNISON</button>
          <Knob value={detune} min={-1} max={1} defaultValue={0} label="Detune" curve="linear" onchange={set('detune')} readLive={live('detune')} />
        </div>
      </div>

      <!-- Bottom: bentscreen wiggles -->
      <div class="bent-section">
        <div class="bent-label">BENTSCREEN WIGGLES</div>
        <div class="bent-grid">
          <Knob value={hsync_drift}        min={0}  max={1} defaultValue={0}    label="HS Drift"  curve="linear" onchange={set('hsync_drift')}        readLive={live('hsync_drift')} />
          <Knob value={hsync_loss}         min={0}  max={1} defaultValue={0}    label="HS Loss"   curve="linear" onchange={set('hsync_loss')}         readLive={live('hsync_loss')} />
          <Knob value={vsync_drift}        min={0}  max={1} defaultValue={0}    label="VS Drift"  curve="linear" onchange={set('vsync_drift')}        readLive={live('vsync_drift')} />
          <Knob value={scan_wobble}        min={0}  max={1} defaultValue={0}    label="Wobble"    curve="linear" onchange={set('scan_wobble')}        readLive={live('scan_wobble')} />
          <Knob value={chroma_phase}       min={-1} max={1} defaultValue={0}    label="Hue"       curve="linear" onchange={set('chroma_phase')}       readLive={live('chroma_phase')} />
          <Knob value={chroma_instability} min={0}  max={1} defaultValue={0}    label="Shimmer"   curve="linear" onchange={set('chroma_instability')} readLive={live('chroma_instability')} />
          <Knob value={feedback_gain}      min={0}  max={1} defaultValue={0}    label="Feedback"  curve="linear" onchange={set('feedback_gain')}      readLive={live('feedback_gain')} />
          <Knob value={feedback_delay}     min={0}  max={1} defaultValue={0}    label="Delay"     curve="linear" onchange={set('feedback_delay')}     readLive={live('feedback_delay')} />
          <Knob value={wavefold}           min={0}  max={1} defaultValue={0}    label="Wavefold"  curve="linear" onchange={set('wavefold')}           readLive={live('wavefold')} />
          <Knob value={bloom}              min={0}  max={1} defaultValue={0.4}  label="Bloom"     curve="linear" onchange={set('bloom')}              readLive={live('bloom')} />
          <Knob value={noise}              min={0}  max={1} defaultValue={0.05} label="Noise"     curve="linear" onchange={set('noise')}              readLive={live('noise')} />
          <Knob value={master_gain}        min={0}  max={2} defaultValue={1}    label="Gain"      curve="linear" onchange={set('master_gain')}        readLive={live('master_gain')} />
        </div>
      </div>
    </div>
  </PatchPanel>

  <div
    class="resize-handle nodrag"
    role="separator"
    aria-label="Resize WAVESCULPT"
    data-testid="wavesculpt-resize-handle"
    onpointerdown={onResizeStart}
  ></div>
</div>

<style>
  .card.wavesculpt {
    background-color: #08090c;
    border: 1px solid var(--border);
    border-radius: 3px;
    color: var(--text);
    padding: 18px 12px 14px;
    position: relative;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    overflow: hidden;
    isolation: isolate;
  }
  :global(.svelte-flow__node:hover) .card.wavesculpt {
    border-color: var(--accent-dim);
  }
  :global(.svelte-flow__node.selected) .card.wavesculpt {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .card.wavesculpt.resizing { transition: none; }
  .stripe {
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    border-radius: 2px 2px 0 0;
    background: linear-gradient(90deg,
      #e23, #2c3, #36e, rgba(255,255,255,0.5));
  }
  .title {
    font-size: 0.85rem;
    font-weight: 500;
    text-align: center;
    margin: 0 0 8px;
    letter-spacing: 0.06em;
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .osc-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 6px;
  }
  .osc-strip {
    border: 1px solid var(--border-dim, rgba(255,255,255,0.08));
    border-radius: 2px;
    padding: 4px;
    background: rgba(255,255,255,0.02);
  }
  .osc-strip.osc-0 { border-left: 2px solid rgba(255, 80, 80, 0.7); }
  .osc-strip.osc-1 { border-left: 2px solid rgba(80, 220, 100, 0.7); }
  .osc-strip.osc-2 { border-left: 2px solid rgba(100, 130, 255, 0.7); }
  .osc-strip.osc-3 { border-left: 2px solid rgba(210, 210, 210, 0.7); }
  .osc-label {
    font-size: 0.62rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    margin-bottom: 2px;
    text-align: center;
    color: var(--text-dim);
  }
  .osc-knobs {
    display: flex;
    gap: 2px;
    justify-content: space-around;
  }
  .mid-row {
    display: grid;
    grid-template-columns: auto 1fr auto;
    gap: 8px;
    align-items: stretch;
  }
  .cam-controls, .right-controls {
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: center;
  }
  .cam-section-label, .bent-label {
    font-size: 0.62rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    color: var(--text-dim);
  }
  .pad {
    position: relative;
    background: #050608;
    border: 1px solid var(--cable-cv, #6cf);
    border-radius: 2px;
    touch-action: none;
    cursor: grab;
    user-select: none;
  }
  .pad:active { cursor: grabbing; }
  .cross-h, .cross-v {
    position: absolute;
    background: rgba(255,255,255,0.08);
    pointer-events: none;
  }
  .cross-h { left: 0; right: 0; top: 50%; height: 1px; transform: translateY(-0.5px); }
  .cross-v { top: 0; bottom: 0; left: 50%; width: 1px; transform: translateX(-0.5px); }
  .dot {
    position: absolute;
    width: 12px; height: 12px;
    border-radius: 50%;
    background: var(--cable-cv, #6cf);
    border: 1px solid #fff;
    transform: translate(-50%, -50%);
    pointer-events: none;
    box-shadow: 0 0 6px rgba(120, 200, 255, 0.4);
  }
  .dot.active { box-shadow: 0 0 12px rgba(120, 200, 255, 0.8); }
  .screen-wrap {
    background: #000;
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 2px;
    display: flex;
    justify-content: center;
    align-items: center;
    min-height: 200px;
  }
  .screen-wrap canvas {
    width: 100%;
    height: 100%;
    display: block;
    background: #000;
  }
  .unison-toggle {
    appearance: none;
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border-dim, rgba(255,255,255,0.15));
    color: var(--text-dim);
    font-size: 0.65rem;
    font-weight: 600;
    letter-spacing: 0.07em;
    padding: 4px 8px;
    border-radius: 2px;
    cursor: pointer;
    transition: background 80ms ease-out, color 80ms ease-out;
  }
  .unison-toggle.on {
    background: var(--accent, #6cf);
    color: #000;
    border-color: var(--accent, #6cf);
  }
  .bent-section {
    border-top: 1px solid var(--border-dim, rgba(255,255,255,0.08));
    padding-top: 6px;
  }
  .bent-grid {
    display: grid;
    grid-template-columns: repeat(6, 1fr);
    gap: 4px 6px;
    margin-top: 4px;
  }
  .resize-handle {
    position: absolute;
    right: 0;
    bottom: 0;
    width: 16px;
    height: 16px;
    cursor: nwse-resize;
    background: linear-gradient(
      135deg,
      transparent 50%,
      var(--cable-cv) 50%,
      var(--cable-cv) 60%,
      transparent 60%,
      transparent 70%,
      var(--cable-cv) 70%,
      var(--cable-cv) 80%,
      transparent 80%
    );
    opacity: 0.7;
    z-index: 5;
  }
  .resize-handle:hover { opacity: 1; }
</style>

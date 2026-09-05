<script lang="ts">
  // WavesculptVizSurface — THE wavesculpt renderer, extracted so that every view
  // paints the SAME picture from the SAME code. It was ~1900 lines living
  // inside a 3644-line surface; nothing in it belonged to that surface except
  // where the presentation canvas was sized.
  //
  // ⚠ WHY EXTRACTED RATHER THAN RE-DRAWN, AND WHY NOT A BLIT. Two cheaper
  // routes were rejected. A second WebGL2 context in the body would be a
  // SECOND RENDERER for one node — two program sets and two texture uploads
  // for a module that already uploads six wall textures — and it would enter
  // the attest basis on its own, so every future edit to it pays another GPU
  // run. Blitting a frame produced by the headless card is worse in a way no
  // reader could check: with no drawer installed this module's drawFrame fills
  // the canvas SOLID BLACK (measured: nonBlack 0/3072 px, maxLuma 0), so the
  // body's picture would silently depend on a headless mount that
  // `needsHeadlessSourceMount` does not promise for every card kind. This
  // route has no such dependency: whoever mounts the surface gets the picture.
  //
  // THE THREE VIEWS ALL LIVE HERE, because they are one control (video_mode)
  // choosing between them:
  //   0 PROXIMITY   — the WebGL2 3D ribbon scene (the pipeline below);
  //   1 BIRDSEYE    — a pure-2D top-down floorplan drawn straight onto the
  //                   presentation canvas, bypassing GL entirely;
  //   2 SPECTROGRAPH— a scrolling STFT, likewise pure 2D.
  //
  // Rendering: a private OffscreenCanvas + WebGL2 context. Two-pass:
  //   1a. Ribbon Z-prepass + color pass into sceneFbo (4 ribbons).
  //   1b. Alpha-mask pass into alphaMaskFbo (ALPHA osc only, in red).
  //   2.  BENTBOX post-pass into postPingFbo (also writes the alpha_in
  //       composite where uAlphaMask > 0).
  //   3.  Snapshot postPing -> prevTex (next-frame feedback source).
  //   4.  Final blit to the 2D presentation canvas.
  //
  // uWaveTex: a 256x4 RGBA8 texture, one row per oscillator, holds the current
  // wavetable frame (snapshot at the per-osc morph position) packed as 0..255
  // in R = (sample + 1) * 127.5. The ribbon vertex shader samples it at
  // (aIdx/(RIBBON_SEGMENTS-1), osc/4) so the drawn shape stays in lockstep
  // with what is audibly being synthesized.
  //
  // ⚠ THE GL CONTEXT IS WHY THIS FILE IS IN THE WEBGL ATTEST BASIS AND THE
  // CARD NO LONGER IS. `resolveWebglBasis` auto-enrols any `.svelte` under
  // lib/ui/modules whose source creates a WebGL context, so moving
  // `getContext('webgl2')` here moved the basis entry off WavesculptCard.svelte
  // and onto this file. (wavesculpt.ts is in the basis separately, by name.)
  //
  // ⚠ THIS COMPONENT EMITS NO `control-<paramId>` TESTID. It paints; it owns
  // no control. VIEW / BLINK / the camera pads are the caller's business.
  //
  // ⚠ IT RENDERS EXACTLY ONE ELEMENT — the presentation <canvas>, with no
  // wrapper. The card mounts it as a direct flex child of `.screen-wrap` and
  // that layout is VRT-pinned, so a wrapper div here would move a baseline.

  import { onMount, onDestroy } from 'svelte';
  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import {
    wavesculptDef,
    eyeFromCamera,
    distanceGain,
    WALL_LAYOUT,
    VIDEO_WALL_FACES,
    installWavesculptFrameDrawer,
    uninstallWavesculptFrameDrawer,
    getWavesculptFrames,
    ribbonStripRange,
    voctToHz,
    detuneOctaveOffset,
    pitchToWiggle,
    unpackColor01,
    DEFAULT_OSC_COLOR_PACKED,
    lineWallCrossings,
    setWavesculptLuma,
    clampMasterGain,
    MASTER_GAIN_DEFAULT,
  } from '$lib/audio/modules/wavesculpt';
  import { clampJoy } from '$lib/audio/modules/joystick';
  import type { VideoEngine } from '$lib/video/engine';
  import { VIDEO_RES } from '$lib/video/engine';

  interface Props {
    nodeId: string;
    /** Backing-store size of the presentation canvas, in device px. */
    width?: number;
    height?: number;
    /**
     * OWN the cross-domain `video_out` frame drawer + the DRS
     * `__wavesculptStep` seam. Exactly ONE mounted surface per node should.
     *
     * ⚠ The registry is owner-checked for this hazard (wavesculpt.ts): under
     * the faceplate shell one node's card MOVES between mounts, and an
     * unconditional `delete` lets a STALE mount's teardown erase the drawer
     * the LIVE mount just installed, leaving the node permanently black with
     * both mounts believing they are fine. The extraction makes that harder
     * rather than merely handled — install and uninstall are now the SAME
     * component's lifecycle — and this flag exists so a second, viewer-only
     * mount can opt out of owning the seam at all.
     */
    ownsVideoOut?: boolean;
    /**
     * Called once per rendered frame, BEFORE the frame is drawn.
     *
     * ⚠ THIS IS A CADENCE GUARANTEE, NOT A CONVENIENCE. A viewer polls the
     * camera CV here to move its joystick dots, and that poll rides rAF
     * for a measured reason: as a standalone setInterval(30ms) it was STARVED
     * and coalesced behind this renderer on a busy main thread, so a
     * gamepad-driven dot updated far too slowly to reach the stick's extremes.
     * Riding the render's own frame pins it to the render cadence and it can
     * no longer be coalesced away by the render it shares a frame with.
     */
    onFrame?: () => void;
  }
  let {
    nodeId,
    width = VIDEO_RES.width,
    height = VIDEO_RES.height,
    ownsVideoOut = true,
    onFrame,
  }: Props = $props();

  const engineCtx = useEngine();

  // ⚠ THE VERSION IS CARRIED IN THE RESULT (the ModuleShell `liveCell`
  // pattern). A bare SyncedStore proxy is `===` to itself, so a derived that
  // read `patch.nodes[id]` alone would hand every downstream derived the same
  // object forever and they would freeze at their first value.
  let live = $derived.by(() => ({ v: nodeVersion(nodeId), n: patch.nodes[nodeId] }));

  // The moved renderer reads `node` and `id` by their original names ~40
  // times, all of them IMPERATIVELY from inside the rAF loop — and an
  // identity-stale proxy still reads live values, so those reads are correct
  // whatever Svelte thinks about identity. Only the two `$derived`s below are
  // reactive consumers, and they read `live` itself so they cannot freeze.
  let node = $derived(live.n);
  let id = $derived(nodeId);

  const defaultFor = (key: string): number =>
    wavesculptDef.params.find((p) => p.id === key)!.defaultValue;

  function pget(key: string): number {
    return (live.n?.params?.[key] ?? defaultFor(key)) as number;
  }

  // Per-osc base colour (RED/GRN/BLU; ALPHA has none by design — it is the
  // alpha/mask layer). Packed 0xRRGGBB, unpacked for the render uniforms.
  const COLOR_PARAM = ['red_color', 'grn_color', 'blu_color'] as const;
  function colorPacked(oscIdx: number): number {
    const key = COLOR_PARAM[oscIdx];
    const def = oscIdx === 0
      ? DEFAULT_OSC_COLOR_PACKED.red
      : oscIdx === 1 ? DEFAULT_OSC_COLOR_PACKED.grn : DEFAULT_OSC_COLOR_PACKED.blu;
    return (live.n?.params?.[key] as number | undefined) ?? def;
  }

  // WHICH view to paint, and (inside the 3D view) HOW to draw the four
  // oscillators. Both are ordinary discrete params whose states are NAMED by
  // the def's rosters (VIDEO_MODE_OPTIONS / BLINK_MODE_OPTIONS) — the card's
  // VIEW and BLINK buttons and the dock's Segmented rows are just two ways of
  // writing them, so this file needs the number and not the vocabulary.
  //
  // ⚠ These read `live` (via pget) rather than a bare node proxy, which is
  // what keeps them from freezing at their first value.
  let video_mode = $derived(pget('video_mode'));
  let blink_mode = $derived(Math.round(pget('blink_mode')));

  // ---- WebGL2 renderer ----

  let renderCanvas: OffscreenCanvas | HTMLCanvasElement | null = null;
  let gl: WebGL2RenderingContext | null = null;
  let ribbonProgram: WebGLProgram | null = null;
  let bentboxProgram: WebGLProgram | null = null;
  let ribbonVao: WebGLVertexArrayObject | null = null;
  let quadVao: WebGLVertexArrayObject | null = null;
  let sceneFbo: WebGLFramebuffer | null = null;
  let sceneTex: WebGLTexture | null = null;
  let sceneDepthRb: WebGLRenderbuffer | null = null;
  let prevFbo: WebGLFramebuffer | null = null;
  let prevTex: WebGLTexture | null = null;
  let ribbonSamplesBuf: WebGLBuffer | null = null;
  let postPingTex: WebGLTexture | null = null;
  let postPingFbo: WebGLFramebuffer | null = null;
  let alphaMaskFbo: WebGLFramebuffer | null = null;
  let alphaMaskTex: WebGLTexture | null = null;
  let alphaMaskDepthRb: WebGLRenderbuffer | null = null;
  let alphaInTex: WebGLTexture | null = null;
  let hasAlphaInPatched = false;

  // ---- VIDEO WALLS (6 faces of the room) ----
  // Each cross-domain video input wall1..wall6 is uploaded into one of these
  // textures every frame and drawn as a quad on the matching box face inside
  // the room. The wall program tessellates the face into a grid so the
  // DISTORT control can displace the quad toward the room centre into a
  // convex hemisphere (flat at distort=0, full dome at distort=1). A scratch
  // canvas + 2D ctx services the self-feedback / audio-domain-source draw
  // path (the source module's drawFrame paints into it; we then upload it).
  let wallProgram: WebGLProgram | null = null;
  let wallVao: WebGLVertexArrayObject | null = null;
  let wallBuf: WebGLBuffer | null = null;
  let wallTextures: (WebGLTexture | null)[] = [];
  // Per-wall: is a source currently patched + did this frame's upload succeed.
  let wallPatched: boolean[] = [false, false, false, false, false, false];
  // Scratch 2D canvas reused for drawFrame-based (audio-domain / self) walls.
  let wallScratchCanvas: OffscreenCanvas | HTMLCanvasElement | null = null;
  // ---- LUMINOSITY → BANDPASS sampling ----
  // Per wall we keep a small downsampled LUMINANCE grid (LUMA_GRID×LUMA_GRID,
  // row-major, 0..1) refreshed on each successful wall upload. The line-vs-wall
  // luminosity samples (for the bandpass) read from these tiny grids instead of
  // doing a GPU readback per line per frame (cheap + off the hot GL path). A
  // shared tiny 2D canvas downsamples each uploaded wall frame into the grid.
  const LUMA_GRID = 16;
  let wallLumaGrids: (Float32Array | null)[] = [null, null, null, null, null, null];
  let lumaSampleCanvas: OffscreenCanvas | HTMLCanvasElement | null = null;
  let lumaSampleCtx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;
  // Wall grid tessellation. 16×16 quads gives a smooth dome at distort=1
  // without an expensive vertex count (6 walls × 16×16×6 ≈ 9.2k verts).
  const WALL_GRID = 16;
  // Vertices per wall = GRID×GRID quads × 6 verts (two triangles).
  const WALL_VERTS_PER = WALL_GRID * WALL_GRID * 6;
  // NEW v2: per-osc wavetable frame texture. 256 wide × 4 tall RGBA8.
  // R holds the sample value (0..255 = -1..+1 mapped to 0..1 = mid + half-range).
  // Updated each frame from the audio module's snapshot of the current
  // wavetable frame per osc (so the ribbon's drawn shape stays in lockstep
  // with what's audibly being synthesized).
  let waveTex: WebGLTexture | null = null;
  const WAVE_TEX_W = 256;
  const WAVE_TEX_H = 4;
  // Reusable CPU buffer for the texImage2D upload. Allocate once + reuse
  // every frame to avoid GC churn (60fps × Float32→Uint8 conversion).
  const waveTexUploadBuf = new Uint8Array(WAVE_TEX_W * WAVE_TEX_H * 4);

  // ---- BLINK scope modes (1 = SCOPES TRIAL, 2 = REALITY BASED COMMUNITY) ----
  // A second strip program draws each oscillator's LIVE oscilloscope trace
  // as a line/tube emitted from a floor corner up+inward at 45°. The live
  // per-osc time-domain samples ride a scopeTex (SCOPE_TEX_W × 4 RGBA8,
  // R = sample mapped [-1..1]→[0..1]), refreshed each frame from the audio
  // module's read('scopes'). Lazily created on first BLINK-mode frame so
  // BLINK mode 0 + the non-3D video modes pay nothing.
  let scopeProgram: WebGLProgram | null = null;
  let scopeVao: WebGLVertexArrayObject | null = null;
  let scopeSamplesBuf: WebGLBuffer | null = null;
  let scopeTex: WebGLTexture | null = null;
  const SCOPE_TEX_W = 512;   // matches the audio module's scope fftSize
  const SCOPE_TEX_H = 4;
  const SCOPE_SEGMENTS = 128; // line resolution along each trace
  // Ring vertices around the swept tube (REALITY BASED COMMUNITY mode). 8
  // sides reads as a round neon tube at card resolution without exploding
  // the vertex count (128 segments × (8+1) ring verts × 4 oscs ≈ 4.6k).
  const TUBE_SIDES = 8;
  const scopeTexUploadBuf = new Uint8Array(SCOPE_TEX_W * SCOPE_TEX_H * 4);
  let scopeInitDone = false;

  const RIBBON_SEGMENTS = 64;
  const RES_W = 320;
  const RES_H = 240;

  // Vertex + fragment shader for the ribbon pass.
  //
  // NEW v2 — uWaveTex sampled at (vT, osc/4) gives the actual current
  // wavetable sample per ribbon vertex. The vertex shader decodes
  // R-channel back to [-1, +1] via (r*2 - 1) and uses it as the wave
  // amplitude (vs v1's analytic saw/sine/tri mix).
  const RIBBON_VS = `#version 300 es
in float aIdx;
in float aSide;
in float aOsc;

uniform mat4  uMVP;
uniform vec4  uSrc[4];
uniform vec4  uVec[4];
uniform float uThickness[4];
uniform float uWavePhase[4];
uniform sampler2D uWaveTex;

out float vT;
flat out int vOsc;

void main() {
  int idx = int(aOsc);
  vec3 src = uSrc[idx].xyz;
  vec3 dir = normalize(uVec[idx].xyz);
  float t = aIdx / float(${RIBBON_SEGMENTS - 1}); // 0..1

  vec3 along = src + dir * (t * 2.0);
  vec3 up = abs(dir.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(0.0, 0.0, 1.0);
  vec3 perp = normalize(cross(dir, up));

  // Sample the wavetable texture. Row per osc, column per ribbon segment.
  // u walks along the wavetable's 256 samples per osc, shifted by the
  // per-osc phase so the wave appears to TRAVEL from the source wall
  // outward through space (oscillators are always running — visual
  // should reflect that, not show a static snapshot). REPEAT wrap on
  // the wave texture handles the seam.
  // v = (osc + 0.5)/4 → centers the sample at the row's middle.
  float u = t - uWavePhase[idx];
  float v = (float(idx) + 0.5) / 4.0;
  float sampleR = texture(uWaveTex, vec2(u, v)).r;
  // Decode R in [0..1] → sample in [-1..+1].
  float wAmt = (sampleR * 2.0 - 1.0) * 0.45;

  float side = aSide * 2.0 - 1.0;
  float tParam = clamp(uThickness[idx], 0.0, 1.0);
  float thicknessAmt = 0.012 + (tParam * tParam) * 0.6;
  vec3 thick = perp * side * thicknessAmt;

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

uniform vec4  uOscColor[4];
uniform float uBolt[4];
uniform float uBoltPhase[4];

float hashB(float n) { return fract(sin(n * 91.3458) * 47453.5453); }

void main() {
  vec4 base = uOscColor[vOsc];
  float bolt = uBolt[vOsc];
  float band = smoothstep(0.0, 0.15, vT) * smoothstep(1.0, 0.85, vT);
  vec3 col = base.rgb * (0.4 + 0.5 * band);
  float alpha = base.a * (0.35 + 0.35 * band);

  // GATE ELECTRICITY — when a voice is gated (bolt = its envelope level,
  // 0 when silent so the effect stays GATED on the audio input) the ribbon
  // visibly electrifies. Three traveling arc heads sweep the trace (the
  // primary at uBoltPhase, two more offset around the ribbon so the
  // crackle covers most of its length), each a sharp bright spike, plus a
  // fast high-freq crackle riding the whole lit band. Strength scales with
  // the gate level; capped so a hot gate reads as electricity, not a flash
  // that washes the image white.
  if (bolt > 0.001) {
    float ph = uBoltPhase[vOsc];
    // Three arc heads at different points along the ribbon (wrap with fract).
    float d0 = vT - ph;
    float d1 = vT - fract(ph + 0.37);
    float d2 = vT - fract(ph + 0.71);
    // Tighter sigma → sharper, more lightning-like spikes; sum the three.
    // Narrow Gaussians keep the underlying waveform shape readable BETWEEN
    // the arcs rather than flooding the whole ribbon to white.
    float arc = exp(-d0 * d0 / 0.0016)
              + exp(-d1 * d1 / 0.0022) * 0.8
              + exp(-d2 * d2 / 0.0030) * 0.65;
    // High-frequency crackle — SPARSE flickering filaments riding the lit
    // band (deterministic hash of position + phase so it sparkles, frozen-
    // stable under the VRT freeze hook since ph is pinned there). A high
    // threshold + steep power keeps it to occasional bright specks, NOT a
    // solid fill, so the underlying waveform reads through.
    float crackleRaw = hashB(floor(vT * 120.0) + floor(ph * 60.0));
    float crackle = smoothstep(0.86, 1.0, crackleRaw) * band;
    // Cool electric-blue/white arc colour.
    vec3 arcCol = vec3(0.55, 0.75, 1.0);
    vec3 hotCol = vec3(0.85, 0.95, 1.0);
    float energy = bolt;
    col += arcCol * arc * energy * 1.9;       // bright traveling arcs
    col += hotCol * crackle * energy * 1.5;   // crackling filaments (sparse)
    // Faint electric charge over the band so even between arcs the gated
    // ribbon reads as energised — kept low to avoid a white flood.
    col += arcCol * band * energy * 0.12;
    alpha = min(1.0, alpha + (arc * 0.7 + crackle * 0.6 + band * 0.08) * energy);
    // Keep colour bounded so a hot gate electrifies without blowing to flat
    // white — clamp the additive overshoot a touch above 1 then let the
    // BENTBOX post softClip/bloom handle the highlight roll-off.
    col = min(col, vec3(1.5));
  }

  outColor = vec4(col, alpha);
}`;

  const BENT_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;

uniform sampler2D uIn;
uniform sampler2D uPrev;
uniform sampler2D uAlphaMask;
uniform sampler2D uAlphaInTex;
uniform float uHasAlphaIn;
uniform float uAlphaBrightness;
uniform float uTime;
uniform float uFieldParity;

uniform float uMasterGain;

const float LINES = 240.0;

// WAVESCULPT's own light CRT character. These were user params identical to
// BENTBOX's; they are now fixed at the values the module shipped with, so a
// default render looks exactly as it did. For adjustable (and CV-able) CRT,
// patch video_out -> BENTBOX.
const float BLOOM = 0.4;
const float NOISE = 0.05;

float hash21(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
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
float softClip(float v) {
  float v2 = v * v;
  return v * (27.0 + v2) / (27.0 + 9.0 * v2);
}

void main() {
  float lineIdx = floor(vUv.y * LINES);
  float lineY = (lineIdx + 0.5) / LINES;
  // No sync drift / loss / wobble: those were the BENTBOX-duplicate params and
  // all defaulted to 0, so the sample was already an identity fetch.
  vec2 sampleUv = vec2(fract(vUv.x), fract(lineY));
  vec3 src = texture(uIn, sampleUv).rgb;
  vec3 yiq = rgb2yiq(src);
  // Chroma phase/instability defaulted to 0 => rotation angle 0 => iq is the
  // unrotated (I, Q) pair. MASTER GAIN's composite drive is kept: it is a live
  // param and its ~1% contribution is part of today's picture.
  vec2 iq = vec2(yiq.y, yiq.z);
  float comp = yiq.x + (iq.x + iq.y) * 0.5;
  comp = softClip(comp * uMasterGain);
  yiq.x = mix(yiq.x, comp - (iq.x + iq.y) * 0.5, uMasterGain * 0.1);
  vec3 decoded = yiq2rgb(yiq);
  // Frame feedback removed with its two params (both defaulted to 0, so the
  // mix was an identity). uPrev/prevTex plumbing is retained by the render
  // loop: stage 3 also resets uHasAlphaIn for the final pass.
  float luma = dot(decoded, vec3(0.299, 0.587, 0.114));
  decoded += smoothstep(0.6, 1.0, luma) * BLOOM * 0.5;
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
  float n = hash21(vUv * vec2(740.0, 421.0) + uTime) - 0.5;
  decoded += vec3(n) * NOISE * 0.18;

  float alphaMaskStrength = texture(uAlphaMask, vUv).r;
  if (uHasAlphaIn > 0.5 && alphaMaskStrength > 0.001) {
    vec3 alphaInSample = clamp(texture(uAlphaInTex, vUv).rgb * uAlphaBrightness, 0.0, 1.0);
    decoded = mix(decoded, alphaInSample, clamp(alphaMaskStrength, 0.0, 1.0));
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

  // ---- VIDEO WALL program (textured box faces with convex DISTORT) ----
  //
  // Geometry: per wall a flat grid quad on its face plane (the GRID×GRID
  // tessellation lets us bend it). Attributes per vertex: aGx, aGy in [0..1]
  // (grid UV across the face). The CPU sets, per draw, the face's two in-
  // plane basis vectors (uU, uV), the face centre (uCentre) and the inward
  // normal (uInward). The DISTORT amount (uDistort, 0..1) blends each vertex
  // from its FLAT position on the face toward a HEMISPHERE bulging inward:
  //
  //   flat   = centre + uU*(gx*2-1) + uV*(gy*2-1)
  //   dome   = flat   + uInward * bulge,  bulge = cos(r·π/2)*depth
  //
  // where r is the radial distance from the face centre (0 at centre, 1 at
  // the rim). cos(r·π/2) is 1 at the centre and 0 at the rim → a smooth
  // convex cap anchored to the face edges (the rim stays put so adjacent
  // walls don't tear apart), bulging toward the room centre we look up into.
  // A fisheye UV warp (sampling toward the centre as the dome bulges) sells
  // the "looking up into a dome" read. distort=0 → flat quad, untouched.
  const WALL_VS = `#version 300 es
in float aGx;
in float aGy;

uniform mat4  uMVP;
uniform vec3  uCentre;
uniform vec3  uU;       // in-plane basis (half-extent already baked: spans -1..+1 face)
uniform vec3  uV;
uniform vec3  uInward;  // unit inward normal (toward room centre)
uniform float uDistort; // 0 flat .. 1 full dome

out vec2 vUv;

void main() {
  // Grid coord centred at the face: sx, sy in [-1..+1].
  float sx = aGx * 2.0 - 1.0;
  float sy = aGy * 2.0 - 1.0;
  vec3 flatPos = uCentre + uU * sx + uV * sy;

  // Radial distance from face centre, clamped to the unit disc.
  float r = clamp(length(vec2(sx, sy)), 0.0, 1.0);
  // Convex cap profile: 1 at centre → 0 at rim (rim anchored).
  float cap = cos(r * 1.5707963);
  // Bulge depth scales with distort. 0.95 ≈ almost a full hemisphere at
  // distort=1 (the inward normal reaches nearly to the room centre).
  float bulge = cap * uDistort * 0.95;
  vec3 pos = flatPos + uInward * bulge;

  gl_Position = uMVP * vec4(pos, 1.0);

  // Fisheye UV: as the dome bulges, pull the sampling toward the centre so
  // the texture appears wrapped over the inside of the cap. At distort=0 the
  // UV is the flat grid UV (1:1). Mix by distort so the morph is continuous.
  float warp = mix(1.0, 0.62, uDistort * (1.0 - r * 0.4));
  vec2 fishUv = vec2(0.5) + vec2(sx, sy) * 0.5 * warp;
  vUv = mix(vec2(aGx, aGy), fishUv, uDistort);
}`;

  const WALL_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;

uniform sampler2D uWallTex;
uniform float uWallAlpha;   // 0..1 transparency (1 = fully opaque)

// REGRESSION FIX (waveform lines vs walls): the walls are a textured
// BACKDROP; the waveform ribbons / BLINK scope traces are the FOREGROUND
// energy and draw ADDITIVELY (SRC_ALPHA, ONE) on top of the scene. A wall
// at full opacity (alpha 100, the default) used to fill the room near
// saturation, leaving no additive headroom — the bright traces clamped into
// the equally-bright wall and read as INVISIBLE (the "scopestrial" /
// "reality based" community patches went blank). Dimming the wall to a true
// backdrop level restores the additive headroom so the energy lines always
// punch through, WITHOUT touching transparency / convex distort / self-
// feedback (those are all upstream of this multiply). 0.6 keeps the wall
// clearly legible while reserving ~40% additive headroom for the traces.
const float WALL_BACKDROP_DIM = 0.6;

void main() {
  vec3 c = texture(uWallTex, vUv).rgb * WALL_BACKDROP_DIM;
  outColor = vec4(c, clamp(uWallAlpha, 0.0, 1.0));
}`;

  // ---- BLINK scope program (modes 1 + 2) ----
  //
  // The two non-default BLINK modes draw each oscillator's signal as the
  // EXACT oscilloscope waveform SHAPE the SCOPE module renders (the card
  // reads the SAME per-osc time-domain analyser windows the SCOPE tuner
  // reads — see wavesculpt.ts read('scopes')). The trace runs along a ray
  // that originates at one of the 4 floor corners and is aimed UP + INWARD
  // at 45°; the scope sample at parameter t displaces the trace
  // perpendicular to the ray. SCALE multiplies that displacement (reusing
  // SCOPE's ch1Scale amplitude semantics), so at equal SCALE the shape
  // matches a SCOPE patched to the same signal.
  //
  //   * SCOPES TRIAL (uMode 1): a THIN scope LINE. WIDTH = line thickness.
  //   * REALITY BASED COMMUNITY (uMode 2): a REAL swept 3D TUBE — actual
  //     ring geometry (TUBE_SIDES verts) extruded around the waveform path,
  //     not a screen-space-thickened strip. WIDTH = tube radius. Lit with a
  //     view-facing neon rim + hot core so it reads as a glowing solid tube.
  //
  // Geometry (buildScopeTube): per segment a ring of TUBE_SIDES vertices.
  // aRing (0..TUBE_SIDES) selects the angle around the path; the VS places
  // it using the path's local frame (tangent + two perpendiculars). The
  // WIGGLE rotation is applied CPU-side to uAim / uOrigin per frame, so the
  // whole tube sweeps through 3D space at a rate + magnitude set by pitch.
  const SCOPE_VS = `#version 300 es
in float aIdx;     // segment index along the path (0..SCOPE_SEGMENTS-1)
in float aRing;    // ring-vertex index around the tube (0..TUBE_SIDES)
in float aOsc;

uniform mat4  uMVP;
uniform vec4  uOrigin[4];  // (possibly wiggle-orbited) ray origin per osc
uniform vec4  uAim[4];     // (possibly wiggle-rotated) ray direction per osc
uniform float uWidth[4];   // 0..1 WIDTH control per osc (line thick / radius)
uniform float uScale[4];   // SCOPE-style amplitude scale per osc
uniform float uMode;       // 1 = thin line, 2 = tube
uniform sampler2D uScopeTex;

out float vT;
out float vRimDot;   // |normal · view-ish| for tube shading (0 edge, 1 face)
flat out int vOsc;

const float TUBE_SIDES = ${TUBE_SIDES}.0;

void main() {
  int osc = int(aOsc);
  vec3 origin = uOrigin[osc].xyz;
  vec3 aim = normalize(uAim[osc].xyz);
  float t = aIdx / float(${SCOPE_SEGMENTS - 1}); // 0..1 along the ray

  // Path point: walk most of the cube diagonal from the corner inward.
  vec3 base = origin + aim * (t * 2.6);

  // Orthonormal frame around the ray. pDisp = displacement plane (the
  // waveform bends in this plane), pWide = the third axis.
  vec3 ref = abs(aim.y) < 0.95 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 pDisp = normalize(cross(aim, ref));
  vec3 pWide = normalize(cross(aim, pDisp));

  // Live scope sample → [-1..+1] (the SAME shape SCOPE draws), * SCALE.
  float u = t;
  float v = (float(osc) + 0.5) / 4.0;
  float s = (texture(uScopeTex, vec2(u, v)).r * 2.0 - 1.0) * clamp(uScale[osc], 0.0, 10.0);
  // Endpoint taper so the trace fades in/out instead of ending in a spike.
  float taper = smoothstep(0.0, 0.06, t) * smoothstep(1.0, 0.9, t);

  // The waveform-displaced centreline.
  vec3 centre = base + pDisp * (s * 0.9 * taper);

  float w = clamp(uWidth[osc], 0.0, 1.0);
  // Mode 1 = thin line: a small radius that grows modestly with WIDTH.
  // Mode 2 = tube: WIDTH = real tube radius (max ≈ fills the box).
  float radius = (uMode > 1.5) ? (0.02 + w * 0.32) : (0.006 + w * 0.05);

  // Place the ring vertex around the centreline using the frame. The ring
  // angle sweeps a full circle in the (pDisp, pWide) plane.
  float ang = (aRing / TUBE_SIDES) * 6.2831853;
  vec3 nrm = normalize(pDisp * cos(ang) + pWide * sin(ang));
  vec3 p = centre + nrm * radius;

  gl_Position = uMVP * vec4(p, 1.0);
  vT = t;
  // Cheap face/rim term: the ring normal's alignment with the aim's
  // perpendicular toward +Z (a stand-in for the view dir) — gives the tube
  // a lit face and darker silhouette without needing the real eye vector.
  // Mapped to a WIDE 0.12..1.0 range so the silhouette goes genuinely dark
  // and the face↔silhouette gradient reads as real 3D shading.
  vRimDot = clamp(abs(nrm.z) * 0.88 + 0.12, 0.12, 1.0);
  vOsc = osc;
}`;

  const SCOPE_FS = `#version 300 es
precision highp float;
in float vT;
in float vRimDot;
flat in int vOsc;
out vec4 outColor;

uniform vec4  uNeon[4];   // per-osc neon colour
uniform float uMode;      // 1 = thin scope line, 2 = real neon tube
uniform float uActive[4]; // per-osc activity alpha (0 = silent → draw NOTHING)

void main() {
  vec3 base = uNeon[vOsc].rgb;
  float edge = smoothstep(0.0, 0.12, vT) * smoothstep(1.0, 0.88, vT);
  float act = uActive[vOsc];

  if (uMode > 1.5) {
    // REAL TUBE: HUE-DOMINANT 3D shading. The osc's neon chroma rides from a
    // dark silhouette (ambient floor) up to a bright SATURATED colored face,
    // with only a tiny white specular highlight at the very brightest point —
    // so it reads as a glowing COLORED neon tube, never a white blob.
    // vRimDot is high on the lit face, low (dark) on the silhouette.
    float face = vRimDot;
    vec3 body = base * (0.22 + 0.95 * face); // ambient → diffuse in the osc hue
    float spec = pow(face, 9.0) * 0.35;       // tiny white hot highlight only at the face
    vec3 col = body + vec3(spec);
    float alpha = (0.5 + 0.5 * face) * (0.5 + 0.5 * edge) * act;
    outColor = vec4(col, alpha);
  } else {
    // THIN SCOPE LINE: bright, near-uniform neon trace.
    vec3 col = base * 1.4;
    float alpha = (0.6 + 0.4 * vRimDot) * (0.45 + 0.55 * edge) * act;
    outColor = vec4(col, alpha);
  }
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

  function createFboTex(
    g: WebGL2RenderingContext,
    w: number,
    h: number,
    withDepth = false,
  ): { fbo: WebGLFramebuffer; tex: WebGLTexture; depth: WebGLRenderbuffer | null } {
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
    let depth: WebGLRenderbuffer | null = null;
    if (withDepth) {
      depth = g.createRenderbuffer();
      if (depth) {
        g.bindRenderbuffer(g.RENDERBUFFER, depth);
        g.renderbufferStorage(g.RENDERBUFFER, g.DEPTH_COMPONENT24, w, h);
        g.framebufferRenderbuffer(g.FRAMEBUFFER, g.DEPTH_ATTACHMENT, g.RENDERBUFFER, depth);
        g.bindRenderbuffer(g.RENDERBUFFER, null);
      }
    }
    g.bindFramebuffer(g.FRAMEBUFFER, null);
    return { fbo, tex, depth };
  }

  function buildRibbonGeometry(): Float32Array {
    const verts: number[] = [];
    for (let osc = 0; osc < 4; osc++) {
      if (osc > 0) {
        const prevLastIdx = RIBBON_SEGMENTS - 1;
        verts.push(prevLastIdx, 1, osc - 1);
        verts.push(0, 0, osc);
      }
      for (let i = 0; i < RIBBON_SEGMENTS; i++) {
        verts.push(i, 0, osc);
        verts.push(i, 1, osc);
      }
    }
    return new Float32Array(verts);
  }

  // One wall's tessellated grid quad. Attributes per vertex: aGx, aGy in
  // [0..1]. Reused for ALL 6 walls (the per-face placement + distort is set
  // via uniforms in drawWalls), so we build it once. gl.TRIANGLES list.
  function buildWallGrid(): Float32Array {
    const verts: number[] = [];
    for (let gy = 0; gy < WALL_GRID; gy++) {
      for (let gx = 0; gx < WALL_GRID; gx++) {
        const x0 = gx / WALL_GRID, x1 = (gx + 1) / WALL_GRID;
        const y0 = gy / WALL_GRID, y1 = (gy + 1) / WALL_GRID;
        // Two triangles per cell.
        verts.push(x0, y0, x1, y0, x1, y1);
        verts.push(x0, y0, x1, y1, x0, y1);
      }
    }
    return new Float32Array(verts);
  }

  // Real swept-TUBE geometry for the BLINK scope modes. For each osc we
  // emit a tube: at every segment along the path there's a ring of
  // TUBE_SIDES vertices; between adjacent segments we stitch a quad (two
  // triangles) per ring side. The VS positions each ring vertex around the
  // waveform-displaced centreline using the path's local frame (so this is
  // genuine 3D geometry, NOT a screen-space-thickened strip). Drawn as a
  // gl.TRIANGLES list — all 4 oscs in one buffer / one draw call.
  // Attributes per vertex: aIdx (segment), aRing (ring angle index), aOsc.
  //
  // SCOPES TRIAL (mode 1) reuses the SAME geometry with a tiny radius, so
  // it reads as a thin line; REALITY BASED COMMUNITY (mode 2) uses the full
  // radius → a fat glowing tube.
  function buildScopeTube(): Float32Array {
    const verts: number[] = [];
    const push = (i: number, ring: number, osc: number) => {
      verts.push(i, ring, osc);
    };
    for (let osc = 0; osc < 4; osc++) {
      for (let i = 0; i < SCOPE_SEGMENTS - 1; i++) {
        for (let j = 0; j < TUBE_SIDES; j++) {
          const j1 = j + 1; // ring wraps; aRing=TUBE_SIDES maps to angle 2π
          // Quad (i,j)-(i+1,j)-(i+1,j1)-(i,j1) → 2 triangles.
          push(i, j, osc);     push(i + 1, j, osc);  push(i + 1, j1, osc);
          push(i, j, osc);     push(i + 1, j1, osc); push(i, j1, osc);
        }
      }
    }
    return new Float32Array(verts);
  }
  // Vertices per osc tube = (SCOPE_SEGMENTS-1) rings × TUBE_SIDES quads × 6.
  const SCOPE_TUBE_VERTS = 4 * (SCOPE_SEGMENTS - 1) * TUBE_SIDES * 6;

  function mat4Multiply(out: Float32Array, a: Float32Array, b: Float32Array): void {
    for (let col = 0; col < 4; col++) {
      for (let row = 0; row < 4; row++) {
        let s = 0;
        for (let k = 0; k < 4; k++) {
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
    const rx = up[1] * fz[2]! - up[2] * fz[1]!;
    const ry = up[2] * fz[0]! - up[0] * fz[2]!;
    const rz = up[0] * fz[1]! - up[1] * fz[0]!;
    const rl = Math.hypot(rx, ry, rz) || 1;
    const r = [rx / rl, ry / rl, rz / rl];
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

  /** Rotate vector v around unit axis k by angle θ (Rodrigues' formula).
   *  Used by WIGGLE to swing each osc's aim direction through 3D space. */
  function rotateAroundAxis(
    v: [number, number, number],
    k: [number, number, number],
    theta: number,
  ): [number, number, number] {
    const c = Math.cos(theta), s = Math.sin(theta);
    const kl = Math.hypot(k[0], k[1], k[2]) || 1;
    const kx = k[0] / kl, ky = k[1] / kl, kz = k[2] / kl;
    const dot = kx * v[0] + ky * v[1] + kz * v[2];
    // crossKV = k × v
    const cx = ky * v[2] - kz * v[1];
    const cy = kz * v[0] - kx * v[2];
    const cz = kx * v[1] - ky * v[0];
    return [
      v[0] * c + cx * s + kx * dot * (1 - c),
      v[1] * c + cy * s + ky * dot * (1 - c),
      v[2] * c + cz * s + kz * dot * (1 - c),
    ];
  }

  let viewMat = new Float32Array(16);
  let projMat = new Float32Array(16);
  let mvpMat = new Float32Array(16);

  const OSC_COLORS: Array<[number, number, number, number]> = [
    [1.0, 0.20, 0.20, 1.0],
    [0.20, 1.0, 0.30, 1.0],
    [0.30, 0.50, 1.0, 1.0],
    [0.85, 0.85, 0.85, 0.7],
  ];

  // Neon palette for the BLINK scope modes — hot, saturated, additive-
  // friendly colours that read as "neon" against black (hot pink, cyan,
  // electric purple, acid green). Per-osc, RED/GRN/BLU/ALP order.
  const NEON_COLORS: Array<[number, number, number, number]> = [
    [1.0, 0.15, 0.55, 1.0], // hot pink
    [0.15, 1.0, 0.85, 1.0], // cyan
    [0.55, 0.25, 1.0, 1.0], // electric purple
    [0.65, 1.0, 0.15, 1.0], // acid green
  ];

  // Resolve the per-osc render colour from the CHROMA picker param. For the
  // three colour oscillators (RED/GRN/BLU = idx 0/1/2) the picked base colour
  // REPLACES the hard-coded hue in ALL THREE blink modes (ribbon, scope line,
  // neon tube). The ALP oscillator (idx 3) has no picker — it keeps its
  // baseline colour (white-ish mask / acid-green neon) unchanged. We preserve
  // the per-mode ALPHA channel (ribbon translucency vs neon opacity) by
  // reading it from the supplied base palette, so brightness/intensity
  // behaviour is unchanged — only the hue is user-controlled.
  function oscRenderColor(
    i: number,
    base: ReadonlyArray<readonly [number, number, number, number]>,
  ): [number, number, number, number] {
    const b = base[i]!;
    if (i >= 3) return [b[0], b[1], b[2], b[3]];
    const [r, g, bl] = unpackColor01(colorPacked(i));
    return [r, g, bl, b[3]];
  }

  // The four FLOOR CORNERS of the unit cube (y=-1), and a unit direction
  // aimed UP and INWARD toward the centre at 45° from each. These seed
  // uOrigin/uAim for the scope tube shader (WIGGLE rotates them per frame).
  // Inward = toward the XZ origin; up = +Y; normalized so "45°" means equal
  // up + inward components.
  //
  // Corner→osc mapping (owner kept the ribbon corner mapping):
  //   RED=−X−Z, GRN=+X−Z, BLU=+X+Z, ALP=−X+Z.
  const SCOPE_CORNERS: Array<[number, number, number]> = [
    [-1, -1, -1],
    [ 1, -1, -1],
    [ 1, -1,  1],
    [-1, -1,  1],
  ];
  const SCOPE_AIMS: Array<[number, number, number]> = SCOPE_CORNERS.map(([x, y, z]) => {
    // Horizontal inward = toward origin in XZ; vertical = up (+Y). Mix
    // 50/50 then normalize → 45° between the floor plane and straight up.
    const inwardX = -x, inwardZ = -z;
    const ih = Math.hypot(inwardX, inwardZ) || 1;
    const hx = inwardX / ih, hz = inwardZ / ih;
    // up component = 1, horizontal magnitude = 1 → 45°.
    const v: [number, number, number] = [hx, 1, hz];
    const len = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / len, v[1] / len, v[2] / len];
  });

  /** Draw the BLINK scope traces (mode 1 = thin scope lines, mode 2 = real
   *  swept neon tubes) into the bound scene FBO. The trace is the exact
   *  oscilloscope waveform SHAPE SCOPE renders; SCALE multiplies the
   *  amplitude; WIGGLE swings each osc's aim + origin through 3D space at a
   *  rate + magnitude proportional to that osc's pitch. Reuses mvpMat (set
   *  for this frame). Additive + depth-disabled (order-independent glow). */
  function drawScopes(g: WebGL2RenderingContext, mode: number): void {
    if (!scopeProgram || !scopeVao) return;
    const meta = uploadScopeTex();
    g.useProgram(scopeProgram);

    // Per-osc WIGGLE tilt. The phase is advanced once per frame in the main
    // render loop (single advancer); here we just read it and scale by the
    // magnitude from the DETECTED pitch (meta.pitches) — the actual audible
    // pitch of each voice — and the WIGGLE strength. wiggle=0 → tilt 0.
    const wiggleMag: number[] = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) {
      const { magnitude } = pitchToWiggle(meta.pitches[i] ?? null, meta.wiggle);
      wiggleMag[i] = Math.sin(scopeWigglePhase[i]!) * magnitude;
    }

    const originArr = new Float32Array(16);
    const aimArr = new Float32Array(16);
    const neonArr = new Float32Array(16);
    const widthArr = new Float32Array(4);
    const scaleArr = new Float32Array(4);
    // Per-osc ACTIVITY alpha. A silent / OFF / unpatched osc has amp ≈ 0 and
    // must contribute ZERO coverage (so it draws NOTHING — no static straight
    // diagonal line). Active voices fade in smoothly with their envelope. The
    // smoothstep knee (ACT_LO..ACT_HI) suppresses true silence + analyser
    // noise while still showing a barely-audible voice once above the floor.
    const ACT_LO = 0.02;   // below this peak amplitude → treated as silence (alpha 0)
    const ACT_HI = 0.12;   // at/above this → fully visible (alpha 1)
    const activeArr = new Float32Array(4);
    for (let i = 0; i < 4; i++) {
      const amp = meta.amp[i] ?? 0;
      // smooth ramp: silence/OFF → 0, normal signal → 1, no hard pop.
      const t = Math.max(0, Math.min(1, (amp - ACT_LO) / (ACT_HI - ACT_LO)));
      activeArr[i] = t * t * (3 - 2 * t);
    }
    for (let i = 0; i < 4; i++) {
      const c = SCOPE_CORNERS[i]!, a0 = SCOPE_AIMS[i]!, n = oscRenderColor(i, NEON_COLORS);
      // WIGGLE: rotate the aim direction (and orbit the origin slightly)
      // around a fixed perpendicular axis by the per-osc tilt angle. The
      // whole trace sweeps through 3D space. At wiggle=0 the angle is 0 →
      // the aim/origin are unchanged (the existing fixed-direction look).
      const theta = wiggleMag[i]!;
      // Axis: a horizontal axis perpendicular to the corner's inward XZ
      // direction, so the trace swings up/down + sideways rather than just
      // spinning about its own length.
      const axis: [number, number, number] = [-c[2], 0, c[0]];
      const aim = theta !== 0 ? rotateAroundAxis(a0, axis, theta) : a0;
      // Orbit the origin a touch so the base of the trace also moves.
      const orbited = theta !== 0 ? rotateAroundAxis(c, [0, 1, 0], theta * 0.4) : c;
      originArr[i * 4] = orbited[0]; originArr[i * 4 + 1] = orbited[1]; originArr[i * 4 + 2] = orbited[2];
      aimArr[i * 4] = aim[0]; aimArr[i * 4 + 1] = aim[1]; aimArr[i * 4 + 2] = aim[2];
      neonArr[i * 4] = n[0]; neonArr[i * 4 + 1] = n[1]; neonArr[i * 4 + 2] = n[2]; neonArr[i * 4 + 3] = n[3];
      // WIDTH = the per-osc THICK control. Scope-line thickness (mode 1) /
      // tube radius (mode 2). Max → trace nearly fills the box.
      widthArr[i] = (node?.params?.[`thickness${i + 1}`] as number | undefined) ?? 0.3;
      scaleArr[i] = meta.scale[i] ?? 1;
    }
    g.uniformMatrix4fv(g.getUniformLocation(scopeProgram, 'uMVP'), false, mvpMat);
    g.uniform4fv(g.getUniformLocation(scopeProgram, 'uOrigin[0]'), originArr);
    g.uniform4fv(g.getUniformLocation(scopeProgram, 'uAim[0]'), aimArr);
    g.uniform4fv(g.getUniformLocation(scopeProgram, 'uNeon[0]'), neonArr);
    g.uniform1fv(g.getUniformLocation(scopeProgram, 'uWidth[0]'), widthArr);
    g.uniform1fv(g.getUniformLocation(scopeProgram, 'uScale[0]'), scaleArr);
    g.uniform1fv(g.getUniformLocation(scopeProgram, 'uActive[0]'), activeArr);
    g.uniform1f(g.getUniformLocation(scopeProgram, 'uMode'), mode);
    g.activeTexture(g.TEXTURE0);
    g.bindTexture(g.TEXTURE_2D, scopeTex);
    g.uniform1i(g.getUniformLocation(scopeProgram, 'uScopeTex'), 0);

    // Additive, depth-disabled: the four neon traces are translucent glow
    // and must show through one another regardless of camera angle.
    g.disable(g.DEPTH_TEST);
    g.depthMask(false);
    g.colorMask(true, true, true, true);
    g.enable(g.BLEND);
    g.blendFunc(g.SRC_ALPHA, g.ONE);
    g.bindVertexArray(scopeVao);
    g.drawArrays(g.TRIANGLES, 0, SCOPE_TUBE_VERTS);
    g.bindVertexArray(null);
    g.disable(g.BLEND);
  }

  let renderStartMs = 0;

  // ---- VRT determinism hook ----
  // The live render is time-driven (wavePhase scroll, uTime noise/scan,
  // CRT field-parity, bolt phase), which is why WAVESCULPT was VRT-exempt.
  // When the test harness sets globalThis.__wavesculptVrtFreeze = true we
  // pin every time-derived input to a FIXED value so a single-frame
  // screenshot is reproducible across runs/rAFs. No effect in production
  // (flag is never set). The fixed phase is deliberately non-zero so the
  // ribbon shows real wave displacement (not a flat line) in the baseline.
  function vrtFrozen(): boolean {
    return (globalThis as unknown as { __wavesculptVrtFreeze?: boolean })
      .__wavesculptVrtFreeze === true;
  }
  const VRT_FIXED_TSEC = 2.0;       // pinned uTime
  const VRT_FIXED_WAVE_PHASE = 0.0; // pinned per-osc wavetable scroll
  // ⚠ PINNED BECAUSE ITS ABSENCE COST A MASK. `boltPhase` drives the three
  // travelling electric arc heads along each ribbon; unpinned they sit at a
  // different point on every capture, and MEASURED (2026-08-01) that took the
  // two blink_mode-0 scenes to "13 consecutive settle attempts differing
  // 11 812-24 677 px, then Failed to take two consecutive stable screenshots".
  // Those two scenes were MASKED instead — 84.8 % of the frame, the most
  // expensive mask in the roster — and the mask's own note named this line as
  // the fix, blocked on a real-GPU re-attest that has now been paid. So the pin
  // ships and both masks are deleted. 0.35 is arbitrary-but-fixed, exactly as
  // VRT_FIXED_WAVE_PHASE and the wiggle phase below are.
  const VRT_FIXED_BOLT_PHASE = 0.35;

  // ---- DRS card-step seam (deterministic render-smoke; e2e only) ----
  // Independent of __wavesculptVrtFreeze (which only pins shader time for a VRT
  // screenshot). When __wavesculptStepMode is set true, the card rAF loop STOPS
  // self-scheduling so a test owns the exact frame count; __wavesculptStep(t)
  // pins the clock + runs ONE synchronous tick() per call. Every time-derived
  // input reads clockNow() instead of performance.now(), so a fixed pin makes
  // the frame deterministic. No effect in production (the flag is never set;
  // clockNow() falls back to performance.now()).
  let stepCount = 0;                  // ++ once per tick() in ALL 3 video modes
  let pinnedClockMs: number | null = null;
  function cardStepMode(): boolean {
    return (globalThis as unknown as { __wavesculptStepMode?: boolean })
      .__wavesculptStepMode === true;
  }
  function clockNow(): number {
    return pinnedClockMs !== null ? pinnedClockMs : performance.now();
  }

  // Per-osc wavetable scroll phase (units: wavetable cycles). Advances
  // each frame by the osc's playback frequency × dt × WAVE_PHASE_GAIN —
  // visually the wave "travels" from the source wall outward through the
  // ribbon, never sitting static the way it would if we sampled the
  // wavetable at a fixed offset. The shader subtracts the phase from
  // each vertex's t coordinate; REPEAT wrap on the wave texture handles
  // the seam, and the existing endpoint band-attenuation in the FS masks
  // the visible discontinuity.
  let wavePhase: number[] = [0, 0, 0, 0];
  // sqrt(hz) * gain → cycles/sec. Picked for legible motion across the
  // audible band: ~0.8 cyc/sec at C4 (calm groove), ~1.6 cyc/sec at A5,
  // ~7 cyc/sec at the 20kHz nyquist ceiling (fast-scroll blur — the eye
  // can't track individual cycles up there anyway).
  const WAVE_PHASE_GAIN = 0.05;
  let frameCount = 0;
  let boltPhase: number[] = [0, 0, 0, 0];
  const BOLT_SPEED = 0.6;
  let lastFrameMs = 0;

  // WIGGLE rotation phase per osc (radians). Advanced once per frame in the
  // main render loop by pitchToWiggle(pitch, wiggle).rate * dt; the tilt
  // applied to the ribbon vec / scope aim+origin is sin(phase) * magnitude.
  // Pinned (no advance) under the VRT freeze hook so the baseline is stable
  // at a fixed non-zero phase.
  let scopeWigglePhase: number[] = [0, 0, 0, 0];

  function findAlphaInSource(): { nodeId: string; portId: string } | null {
    return findInputSource('alpha_in');
  }

  function tryUploadAlphaIn(): void {
    if (!gl || !alphaInTex) {
      hasAlphaInPatched = false;
      return;
    }
    const src = findAlphaInSource();
    if (!src) { hasAlphaInPatched = false; return; }
    const e = engineCtx.get();
    if (!e) { hasAlphaInPatched = false; return; }
    let videoEngine: VideoEngine | undefined;
    try { videoEngine = e.getDomain<VideoEngine>('video'); } catch { videoEngine = undefined; }
    if (!videoEngine) { hasAlphaInPatched = false; return; }
    try {
      videoEngine.blitOutputToDrawingBuffer(src.nodeId);
    } catch {
      hasAlphaInPatched = false;
      return;
    }
    const srcCanvas = videoEngine.canvas as CanvasImageSource | undefined;
    if (!srcCanvas) { hasAlphaInPatched = false; return; }
    try {
      gl.bindTexture(gl.TEXTURE_2D, alphaInTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE,
        srcCanvas as TexImageSource,
      );
      hasAlphaInPatched = true;
    } catch {
      hasAlphaInPatched = false;
    }
  }

  /** Resolve the upstream (sourceNodeId, sourcePortId) currently patched
   *  into one of this card's inputs by walking the live patch edges. Returns
   *  null when the input is unpatched. Shared by the wall + alpha paths. */
  function findInputSource(portId: string): { nodeId: string; portId: string } | null {
    for (const eid of Object.keys(patch.edges)) {
      const e = patch.edges[eid];
      if (!e) continue;
      if (e.target?.nodeId === id && e.target?.portId === portId) {
        return { nodeId: e.source.nodeId, portId: e.source.portId };
      }
    }
    return null;
  }

  /** Upload one frame from whatever is patched into wall{wallIdx+1} into
   *  wallTextures[wallIdx]. Returns true if a frame was uploaded.
   *
   *  Source-domain handling (the cross-domain wiring):
   *   - VIDEO-domain source (ACIDWARP, LINES, VIDEOBOX, …): selectively
   *     render its FBO into the shared video-engine drawing buffer via
   *     blitOutputToDrawingBuffer(), then upload videoEngine.canvas — the
   *     SAME path alpha_in uses. This covers the per-port sweep (acidwarp).
   *   - AUDIO-domain source with a mono-video output (RASTERIZE, FOXY's
   *     viz, and crucially WAVESCULPT ITSELF): pull its drawFrame via the
   *     audio engine's getVideoSource(), paint into a scratch 2D canvas,
   *     then upload that. This is what makes SELF-FEEDBACK work — patching
   *     this card's own video_out into a wall draws the card's last frame
   *     (its FRAME_DRAWER blits renderCanvas), which the wall textures back
   *     into the scene → recursive feedback through the BENTBOX prevFbo. We
   *     deliberately DON'T special-case-block self-patching. */
  function tryUploadWall(wallIdx: number): boolean {
    if (!gl) return false;
    const tex = wallTextures[wallIdx];
    if (!tex) return false;
    const src = findInputSource(`wall${wallIdx + 1}`);
    if (!src) return false;
    const e = engineCtx.get();
    if (!e) return false;
    const srcNode = patch.nodes[src.nodeId];
    const srcDomain = srcNode?.domain ?? 'audio';

    let imageSource: CanvasImageSource | undefined;
    if (srcDomain === 'video') {
      // Cross-domain: render the source video module's FBO into the shared
      // drawing buffer, then sample that buffer.
      let videoEngine: VideoEngine | undefined;
      try { videoEngine = e.getDomain<VideoEngine>('video'); } catch { videoEngine = undefined; }
      if (!videoEngine) return false;
      try { videoEngine.blitOutputToDrawingBuffer(src.nodeId); } catch { return false; }
      imageSource = videoEngine.canvas as CanvasImageSource | undefined;
    } else {
      // Audio-domain (incl. self): ask the audio engine for the source's
      // mono-video drawFrame + render it into a scratch canvas.
      let audioEngine: { getVideoSource?: (n: string, p: string) => { drawFrame?: (c: OffscreenCanvas | HTMLCanvasElement) => void } | null } | undefined;
      try {
        audioEngine = e.getDomain('audio') as unknown as typeof audioEngine;
      } catch { audioEngine = undefined; }
      const vsrc = audioEngine?.getVideoSource?.(src.nodeId, src.portId) ?? null;
      if (!vsrc?.drawFrame) return false;
      if (!wallScratchCanvas) {
        if (typeof OffscreenCanvas !== 'undefined') {
          wallScratchCanvas = new OffscreenCanvas(RES_W, RES_H);
        } else if (typeof document !== 'undefined') {
          const c = document.createElement('canvas');
          c.width = RES_W; c.height = RES_H;
          wallScratchCanvas = c;
        } else {
          return false;
        }
      }
      try { vsrc.drawFrame(wallScratchCanvas); } catch { return false; }
      imageSource = wallScratchCanvas as CanvasImageSource;
    }
    if (!imageSource) return false;
    try {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE,
        imageSource as TexImageSource,
      );
      // Refresh this wall's downsampled luminance grid (for the luminosity →
      // bandpass feature). Cheap: one drawImage downscale + a small readback.
      refreshWallLumaGrid(wallIdx, imageSource);
      return true;
    } catch {
      return false;
    }
  }

  /** Downsample one uploaded wall frame into wallLumaGrids[wallIdx] (a
   *  LUMA_GRID×LUMA_GRID row-major 0..1 luminance grid). Used by the
   *  luminosity → bandpass sampler. Defensive: any failure leaves the grid
   *  null (sampler then falls back to a neutral mid luminosity). */
  function refreshWallLumaGrid(wallIdx: number, src: CanvasImageSource): void {
    try {
      if (!lumaSampleCanvas) {
        if (typeof OffscreenCanvas !== 'undefined') {
          lumaSampleCanvas = new OffscreenCanvas(LUMA_GRID, LUMA_GRID);
        } else if (typeof document !== 'undefined') {
          const c = document.createElement('canvas');
          c.width = LUMA_GRID; c.height = LUMA_GRID;
          lumaSampleCanvas = c;
        } else return;
        lumaSampleCtx = (lumaSampleCanvas as HTMLCanvasElement).getContext('2d', { willReadFrequently: true }) as
          | OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
      }
      const ctx2d = lumaSampleCtx;
      if (!ctx2d) return;
      ctx2d.clearRect(0, 0, LUMA_GRID, LUMA_GRID);
      ctx2d.drawImage(src, 0, 0, LUMA_GRID, LUMA_GRID);
      const img = ctx2d.getImageData(0, 0, LUMA_GRID, LUMA_GRID).data;
      let grid = wallLumaGrids[wallIdx];
      if (!grid) { grid = new Float32Array(LUMA_GRID * LUMA_GRID); wallLumaGrids[wallIdx] = grid; }
      for (let p = 0, q = 0; p < img.length; p += 4, q++) {
        // Rec.601 luma, 0..1.
        grid[q] = (0.299 * img[p]! + 0.587 * img[p + 1]! + 0.114 * img[p + 2]!) / 255;
      }
    } catch { /* leave grid as-is */ }
  }

  /** Sample a wall's luminance grid at in-face UV (0..1). Returns a neutral
   *  mid (0.5) when no grid exists (wall unpatched / not yet sampled) so an
   *  unpatched wall yields a moderate, non-extreme band — the line is neither
   *  fully open nor silent. */
  function sampleWallLuma(wallIdx: number, u: number, v: number): number {
    const grid = wallLumaGrids[wallIdx];
    if (!grid || !wallPatched[wallIdx]) return 0.5;
    const gx = Math.max(0, Math.min(LUMA_GRID - 1, Math.round(u * (LUMA_GRID - 1))));
    const gy = Math.max(0, Math.min(LUMA_GRID - 1, Math.round(v * (LUMA_GRID - 1))));
    return grid[gy * LUMA_GRID + gx] ?? 0.5;
  }

  /** Per-frame: for each of the 4 osc lines, find the two walls it crosses,
   *  sample the luminosity at the crossing centre points, and post the per-line
   *  pair to the audio module (LUMA_REGISTRY → factory tick → worklet band-pass
   *  params). The line ray uses the CURRENT BLINK mode's emit geometry: scope
   *  corners/aims for modes 1/2, the ribbon wall/vec for mode 0. Skipped (cheap
   *  early-out) when lum_depth is 0 — the feature is OFF so no sampling cost. */
  function postLineLuminosities(): void {
    const depth = (node?.params?.lum_depth as number | undefined) ?? 0;
    if (depth <= 0) return;
    const blinkMode = Math.round((node?.params?.blink_mode as number | undefined) ?? 0);
    const lumA: [number, number, number, number] = [0.5, 0.5, 0.5, 0.5];
    const lumB: [number, number, number, number] = [0.5, 0.5, 0.5, 0.5];
    for (let i = 0; i < 4; i++) {
      let origin: [number, number, number];
      let dir: [number, number, number];
      if (blinkMode > 0) {
        origin = SCOPE_CORNERS[i]!;
        dir = SCOPE_AIMS[i]!;
      } else {
        // Ribbon mode: emit from the wall source toward the origin (WALL_LAYOUT
        // src + vec). Match the card's ribbon uSrc/uVec (the wall/vec0 arrays).
        const wall = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]][i]! as [number, number, number];
        const v0 = [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0]][i]! as [number, number, number];
        origin = wall;
        dir = v0;
      }
      const cr = lineWallCrossings(origin, dir);
      if (cr) {
        lumA[i] = sampleWallLuma(cr[0].faceIdx, cr[0].u, cr[0].v);
        lumB[i] = sampleWallLuma(cr[1].faceIdx, cr[1].u, cr[1].v);
      }
    }
    setWavesculptLuma(id, { lumA, lumB });
  }

  /** Refresh all 6 wall textures from their patched sources. Records which
   *  walls have live content in wallPatched[] (drawWalls skips the rest). */
  function tryUploadWalls(): void {
    for (let w = 0; w < 6; w++) {
      wallPatched[w] = tryUploadWall(w);
    }
  }

  /** Draw the textured + distortable wall quads onto their box faces into
   *  the currently-bound (scene) FBO. Standard alpha blending so the wall
   *  composites OVER the cleared scene; depth WRITE on so closer dome
   *  geometry occludes correctly, but depth TEST against the ribbons is
   *  handled by drawing walls FIRST (ribbons are additive + depth-disabled
   *  and draw after, layering on top). uMVP is the live camera matrix. */
  function drawWalls(g: WebGL2RenderingContext): void {
    if (!wallProgram || !wallVao) return;
    let anyPatched = false;
    for (let w = 0; w < 6; w++) if (wallPatched[w]) { anyPatched = true; break; }
    if (!anyPatched) return;

    g.useProgram(wallProgram);
    g.uniformMatrix4fv(g.getUniformLocation(wallProgram, 'uMVP'), false, mvpMat);
    const uCentre  = g.getUniformLocation(wallProgram, 'uCentre');
    const uU       = g.getUniformLocation(wallProgram, 'uU');
    const uV       = g.getUniformLocation(wallProgram, 'uV');
    const uInward  = g.getUniformLocation(wallProgram, 'uInward');
    const uDistort = g.getUniformLocation(wallProgram, 'uDistort');
    const uWallTex = g.getUniformLocation(wallProgram, 'uWallTex');
    const uWallAlpha = g.getUniformLocation(wallProgram, 'uWallAlpha');

    // Walls are opaque-ish backdrop quads: depth test + write so a bulged
    // dome self-occludes; blend so transparency works.
    g.enable(g.DEPTH_TEST);
    g.depthFunc(g.LEQUAL);
    g.depthMask(true);
    g.enable(g.BLEND);
    g.blendFunc(g.SRC_ALPHA, g.ONE_MINUS_SRC_ALPHA);
    g.bindVertexArray(wallVao);

    for (const face of VIDEO_WALL_FACES) {
      const w = face.wallIdx;
      if (!wallPatched[w]) continue;
      const alpha01 = Math.max(0, Math.min(1,
        ((node?.params?.[`wall${w + 1}_alpha`] as number | undefined) ?? 100) / 100));
      if (alpha01 <= 0) continue; // fully transparent → skip
      const distort = Math.max(0, Math.min(1,
        (node?.params?.[`wall${w + 1}_distort`] as number | undefined) ?? 0));

      // Build the face's frame: centre on the face plane (axis at sign·1),
      // two in-plane basis vectors spanning the full -1..+1 face, and the
      // inward normal (−sign on the face axis). The box is [-1,+1]^3.
      const centre: [number, number, number] = [0, 0, 0];
      centre[face.axis] = face.sign;
      // Pick two world axes orthogonal to the face axis as the in-plane basis.
      const a = face.axis;
      const ax1 = (a + 1) % 3;
      const ax2 = (a + 2) % 3;
      const u: [number, number, number] = [0, 0, 0];
      const v: [number, number, number] = [0, 0, 0];
      u[ax1] = 1;
      v[ax2] = 1;
      const inward: [number, number, number] = [0, 0, 0];
      inward[face.axis] = -face.sign;

      g.uniform3f(uCentre, centre[0], centre[1], centre[2]);
      g.uniform3f(uU, u[0], u[1], u[2]);
      g.uniform3f(uV, v[0], v[1], v[2]);
      g.uniform3f(uInward, inward[0], inward[1], inward[2]);
      g.uniform1f(uDistort, distort);
      g.uniform1f(uWallAlpha, alpha01);
      g.activeTexture(g.TEXTURE0);
      g.bindTexture(g.TEXTURE_2D, wallTextures[w]!);
      g.uniform1i(uWallTex, 0);
      g.drawArrays(g.TRIANGLES, 0, WALL_VERTS_PER);
    }

    g.bindVertexArray(null);
    g.disable(g.BLEND);
    g.disable(g.DEPTH_TEST);
    g.depthMask(true);
  }

  /** Upload the current per-osc wavetable frames into the ribbon's
   *  wave-shape texture. Reads from the audio module's registry (which
   *  the factory keeps in sync with node.data on its 200ms poll).
   *
   *  Sampling strategy: each osc's row in the texture is filled with a
   *  resampling of the active frame at WAVE_TEX_W (= 256) bins. The
   *  active frame index is round(morph * (frameCount-1)). Default (no
   *  frames loaded yet) writes a faint baseline so the ribbon shows
   *  SOMETHING during the first ~200ms before the poll loop fires.
   *
   *  Cost: 256×4 bytes per upload × 60fps = ~60 KB/s. Cheap. */
  function uploadWaveTex(): void {
    if (!gl || !waveTex) return;
    const allFrames = getWavesculptFrames(id);
    const buf = waveTexUploadBuf;
    for (let osc = 0; osc < 4; osc++) {
      const m = (node?.params?.[`morph${osc + 1}`] as number | undefined) ?? 0;
      const frames = allFrames?.[osc] ?? [];
      let activeFrame: Float32Array | null = null;
      if (frames.length > 0) {
        const idx = Math.max(
          0, Math.min(frames.length - 1, Math.round(m * (frames.length - 1))),
        );
        activeFrame = frames[idx] ?? null;
      }
      const rowOffset = osc * WAVE_TEX_W * 4;
      if (activeFrame && activeFrame.length === WAVE_TEX_W) {
        for (let i = 0; i < WAVE_TEX_W; i++) {
          // Map sample in [-1..+1] → byte in [0..255].
          const s = activeFrame[i]!;
          const v = Math.max(0, Math.min(255, Math.round((s + 1) * 127.5)));
          const o = rowOffset + i * 4;
          buf[o] = v; buf[o + 1] = v; buf[o + 2] = v; buf[o + 3] = 255;
        }
      } else {
        // Faint sine fallback so the ribbon isn't a dead line during init.
        for (let i = 0; i < WAVE_TEX_W; i++) {
          const ph = (i / WAVE_TEX_W) * Math.PI * 2;
          const s = Math.sin(ph) * 0.3;
          const v = Math.max(0, Math.min(255, Math.round((s + 1) * 127.5)));
          const o = rowOffset + i * 4;
          buf[o] = v; buf[o + 1] = v; buf[o + 2] = v; buf[o + 3] = 255;
        }
      }
    }
    gl.bindTexture(gl.TEXTURE_2D, waveTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA8,
      WAVE_TEX_W, WAVE_TEX_H, 0,
      gl.RGBA, gl.UNSIGNED_BYTE,
      buf,
    );
  }

  // Lazily build the BLINK scope program + geometry + texture the first
  // time a BLINK scope mode renders. Keeps BLINK mode 0 (default) + the
  // non-3D video modes free of the extra GL objects. Returns false if the
  // program can't be built (then the caller falls back to the ribbon).
  function ensureScopeGl(): boolean {
    if (!gl) return false;
    if (scopeInitDone) return scopeProgram !== null;
    scopeInitDone = true;
    try {
      scopeProgram = linkProgram(gl, SCOPE_VS, SCOPE_FS);
    } catch (err) {
      console.error('[WAVESCULPT] scope shader setup failed:', err);
      scopeProgram = null;
      return false;
    }
    const geom = buildScopeTube();
    scopeVao = gl.createVertexArray();
    gl.bindVertexArray(scopeVao);
    scopeSamplesBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, scopeSamplesBuf);
    gl.bufferData(gl.ARRAY_BUFFER, geom, gl.STATIC_DRAW);
    const aIdxLoc = gl.getAttribLocation(scopeProgram, 'aIdx');
    const aRingLoc = gl.getAttribLocation(scopeProgram, 'aRing');
    const aOscLoc = gl.getAttribLocation(scopeProgram, 'aOsc');
    const stride = 3 * 4;
    if (aIdxLoc >= 0) { gl.enableVertexAttribArray(aIdxLoc); gl.vertexAttribPointer(aIdxLoc, 1, gl.FLOAT, false, stride, 0); }
    if (aRingLoc >= 0) { gl.enableVertexAttribArray(aRingLoc); gl.vertexAttribPointer(aRingLoc, 1, gl.FLOAT, false, stride, 4); }
    if (aOscLoc >= 0) { gl.enableVertexAttribArray(aOscLoc); gl.vertexAttribPointer(aOscLoc, 1, gl.FLOAT, false, stride, 8); }
    gl.bindVertexArray(null);

    scopeTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, scopeTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, SCOPE_TEX_W, SCOPE_TEX_H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return true;
  }

  interface ScopeMeta {
    scale: number[];          // per-osc SCALE (uniform knob+CV; same value × 4)
    wiggle: number;           // global WIGGLE strength (knob + CV)
    pitches: Array<number | null>; // per-osc detected pitch
    amp: number[];            // per-osc peak |sample| over the window (0 = silent / no trace)
  }

  // Refresh scopeTex from the audio module's live per-osc time-domain
  // traces — the SAME analyser windows the SCOPE module reads, so the
  // rendered trace is the exact oscilloscope waveform SHAPE SCOPE draws.
  // R channel holds the sample mapped [-1..1]→[0..255]; the scope VS
  // decodes it back and multiplies by SCALE (matching SCOPE's ch1Scale).
  // Returns the per-osc SCALE + global WIGGLE + per-osc pitch so drawScopes
  // can apply SCALE in the shader and drive the WIGGLE rotation. Falls back
  // to silence (flat mid-line) + defaults when the engine isn't ready.
  function uploadScopeTex(): ScopeMeta {
    const meta: ScopeMeta = { scale: [1, 1, 1, 1], wiggle: 0, pitches: [null, null, null, null], amp: [0, 0, 0, 0] };
    if (!gl || !scopeTex) return meta;
    const buf = scopeTexUploadBuf;
    const e = engineCtx.get();
    let traces: Float32Array[] | undefined;
    let traceLen = 0;
    if (e && node) {
      try {
        const s = e.read(node, 'scopes') as
          | { traces: Float32Array[]; length: number; scale?: number; wiggle?: number; pitches?: Array<number | null> }
          | undefined;
        if (s) {
          traces = s.traces; traceLen = s.length;
          const sc = s.scale ?? 1;
          meta.scale = [sc, sc, sc, sc];
          meta.wiggle = s.wiggle ?? 0;
          if (Array.isArray(s.pitches)) meta.pitches = s.pitches.slice(0, 4);
        }
      } catch { /* engine not ready */ }
    }
    for (let osc = 0; osc < 4; osc++) {
      const tr = traces?.[osc];
      const rowOffset = osc * SCOPE_TEX_W * 4;
      // Track peak |sample| of the decoded -1..+1 trace so silent / OFF /
      // unpatched oscillators (which fill a flat mid-line) can be gated to
      // ZERO coverage in the shader — no static straight diagonal ray.
      let peak = 0;
      for (let i = 0; i < SCOPE_TEX_W; i++) {
        let s = 0;
        if (tr && traceLen > 0) {
          // Map the texture column to the trace window.
          const srcIdx = Math.min(traceLen - 1, Math.round((i / (SCOPE_TEX_W - 1)) * (traceLen - 1)));
          s = tr[srcIdx] ?? 0;
        }
        const a = Math.abs(s);
        if (a > peak) peak = a;
        const v = Math.max(0, Math.min(255, Math.round((s + 1) * 127.5)));
        const o = rowOffset + i * 4;
        buf[o] = v; buf[o + 1] = v; buf[o + 2] = v; buf[o + 3] = 255;
      }
      // No trace at all → amp 0 (definitely silent). Otherwise the window's
      // peak abs amplitude (0..~1).
      meta.amp[osc] = (tr && traceLen > 0) ? peak : 0;
    }
    gl.bindTexture(gl.TEXTURE_2D, scopeTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, SCOPE_TEX_W, SCOPE_TEX_H, 0, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return meta;
  }

  function initGl(): boolean {
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
      wallProgram = linkProgram(gl, WALL_VS, WALL_FS);
    } catch (err) {
      console.error('[WAVESCULPT] shader setup failed:', err);
      return false;
    }

    const geom = buildRibbonGeometry();
    ribbonVao = gl.createVertexArray();
    gl.bindVertexArray(ribbonVao);
    ribbonSamplesBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, ribbonSamplesBuf);
    gl.bufferData(gl.ARRAY_BUFFER, geom, gl.STATIC_DRAW);
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

    // ---- VIDEO WALL geometry + per-face textures ----
    wallVao = gl.createVertexArray();
    gl.bindVertexArray(wallVao);
    wallBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, wallBuf);
    gl.bufferData(gl.ARRAY_BUFFER, buildWallGrid(), gl.STATIC_DRAW);
    const aGxLoc = gl.getAttribLocation(wallProgram!, 'aGx');
    const aGyLoc = gl.getAttribLocation(wallProgram!, 'aGy');
    const wStride = 2 * 4;
    if (aGxLoc >= 0) { gl.enableVertexAttribArray(aGxLoc); gl.vertexAttribPointer(aGxLoc, 1, gl.FLOAT, false, wStride, 0); }
    if (aGyLoc >= 0) { gl.enableVertexAttribArray(aGyLoc); gl.vertexAttribPointer(aGyLoc, 1, gl.FLOAT, false, wStride, 4); }
    gl.bindVertexArray(null);

    wallTextures = [];
    for (let w = 0; w < 6; w++) {
      const t = gl.createTexture();
      if (t) {
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
          new Uint8Array([0, 0, 0, 255]));
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      }
      wallTextures.push(t);
    }

    const fboA = createFboTex(gl, RES_W, RES_H, true);
    sceneFbo = fboA.fbo; sceneTex = fboA.tex; sceneDepthRb = fboA.depth;
    const fboB = createFboTex(gl, RES_W, RES_H);
    prevFbo = fboB.fbo; prevTex = fboB.tex;
    const fboC = createFboTex(gl, RES_W, RES_H);
    postPingFbo = fboC.fbo; postPingTex = fboC.tex;
    const fboD = createFboTex(gl, RES_W, RES_H, true);
    alphaMaskFbo = fboD.fbo; alphaMaskTex = fboD.tex; alphaMaskDepthRb = fboD.depth;

    alphaInTex = gl.createTexture();
    if (alphaInTex) {
      gl.bindTexture(gl.TEXTURE_2D, alphaInTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
        new Uint8Array([0, 0, 0, 255]));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }

    // NEW v2: wavetable shape texture (256×4 RGBA8).
    waveTex = gl.createTexture();
    if (waveTex) {
      gl.bindTexture(gl.TEXTURE_2D, waveTex);
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RGBA8,
        WAVE_TEX_W, WAVE_TEX_H, 0,
        gl.RGBA, gl.UNSIGNED_BYTE,
        null,
      );
      // LINEAR sampling so the ribbon shape stays smooth at low segment
      // counts. REPEAT on the U axis so the per-osc phase scroll in the
      // ribbon vertex shader can advance past the wavetable boundary
      // cleanly (the wave is a periodic signal — sampling the next cycle
      // is the natural extension). CLAMP_TO_EDGE on V so adjacent osc
      // rows don't bleed into each other when the texture is sampled at
      // a row boundary.
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }

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
      if (sceneDepthRb) gl.deleteRenderbuffer(sceneDepthRb);
      if (prevFbo) gl.deleteFramebuffer(prevFbo);
      if (prevTex) gl.deleteTexture(prevTex);
      if (postPingFbo) gl.deleteFramebuffer(postPingFbo);
      if (postPingTex) gl.deleteTexture(postPingTex);
      if (alphaMaskFbo) gl.deleteFramebuffer(alphaMaskFbo);
      if (alphaMaskTex) gl.deleteTexture(alphaMaskTex);
      if (alphaMaskDepthRb) gl.deleteRenderbuffer(alphaMaskDepthRb);
      if (alphaInTex) gl.deleteTexture(alphaInTex);
      if (waveTex) gl.deleteTexture(waveTex);
      if (wallProgram) gl.deleteProgram(wallProgram);
      if (wallVao) gl.deleteVertexArray(wallVao);
      if (wallBuf) gl.deleteBuffer(wallBuf);
      for (const t of wallTextures) if (t) gl.deleteTexture(t);
      if (ribbonSamplesBuf) gl.deleteBuffer(ribbonSamplesBuf);
      if (scopeProgram) gl.deleteProgram(scopeProgram);
      if (scopeVao) gl.deleteVertexArray(scopeVao);
      if (scopeSamplesBuf) gl.deleteBuffer(scopeSamplesBuf);
      if (scopeTex) gl.deleteTexture(scopeTex);
    } catch { /* */ }
    scopeProgram = null;
    scopeVao = null;
    scopeSamplesBuf = null;
    scopeTex = null;
    scopeInitDone = false;
    wallProgram = null;
    wallVao = null;
    wallBuf = null;
    wallTextures = [];
    wallScratchCanvas = null;
    wallPatched = [false, false, false, false, false, false];
    wallLumaGrids = [null, null, null, null, null, null];
    lumaSampleCanvas = null;
    lumaSampleCtx = null;
    gl = null;
    renderCanvas = null;
  }

  function renderToOffscreen() {
    if (!gl || !ribbonProgram || !bentboxProgram) return;
    const g = gl;

    tryUploadAlphaIn();
    tryUploadWalls();
    postLineLuminosities();
    uploadWaveTex();

    g.bindFramebuffer(g.FRAMEBUFFER, sceneFbo);
    g.viewport(0, 0, RES_W, RES_H);
    g.clearColor(0, 0, 0, 1);
    g.clearDepth(1.0);
    g.clear(g.COLOR_BUFFER_BIT | g.DEPTH_BUFFER_BIT);

    // Camera setup — use the shared eyeFromCamera helper so zoom/rot
    // semantics stay paired with the audio side's distGain math.
    //
    // ONE READ. engine.read(node, 'camera') returns the SAME instant
    // the spatial audio mix is computing right now (both read the
    // same shadow-gain analyser samples in the factory). The joystick
    // UI does the same thing from the CARD, in the `onFrame` hook this
    // renderer calls at the top of every tick — so the two reads land in
    // the same frame and cannot disagree. That gives us a single source
    // of truth: knob, CV, audio mix, ribbon viewport, and joystick dot
    // all move together.
    //
    // ⚠ The picture's camera is THIS read, not the card's pad position:
    // the pad shows the KNOB, CV moves the PICTURE, and those are two
    // different numbers that are both correct.
    const eng = engineCtx.get();
    const cam = (eng && node ? (eng.read(node, 'camera') as
      | { pos_x: number; pos_y: number; pos_z: number; zoom: number; rot: number }
      | undefined) : undefined) ?? {
      pos_x: (node?.params?.pos_x as number | undefined) ?? 0,
      pos_y: (node?.params?.pos_y as number | undefined) ?? 0,
      pos_z: (node?.params?.pos_z as number | undefined) ?? 0,
      zoom:  (node?.params?.zoom  as number | undefined) ?? 1,
      rot:   (node?.params?.rot   as number | undefined) ?? 0,
    };
    const camX = clampJoy(cam.pos_x);
    const camY = clampJoy(cam.pos_y);
    const camZ = clampJoy(cam.pos_z);
    const zoomVal = Math.max(0.3, Math.min(3, cam.zoom));
    const rotVal  = clampJoy(cam.rot);
    const eye = eyeFromCamera(camX, camY, camZ, zoomVal, rotVal);
    // FOV stays fixed; zoom now moves the eye instead of changing fov,
    // so the visual cue tracks the audio cue 1:1.
    const fovy = 1.0;
    const aspect = RES_W / RES_H;
    mat4Perspective(projMat, fovy, aspect, 0.05, 12.0);
    mat4LookAt(viewMat, eye, [0, 0, 0], [0, 1, 0]);
    mat4Multiply(mvpMat, projMat, viewMat);

    // VIDEO WALL pass — textured box faces (with convex DISTORT) drawn into
    // the just-cleared scene FBO BEFORE the ribbons. The ribbons/scopes draw
    // additively with depth disabled afterwards, so they layer on top of the
    // room walls. drawWalls early-outs when no wall is patched, so the
    // existing ribbon-only scene is byte-identical when no walls are wired.
    drawWalls(g);

    g.useProgram(ribbonProgram);
    const uMVP = g.getUniformLocation(ribbonProgram, 'uMVP');
    g.uniformMatrix4fv(uMVP, false, mvpMat);

    const e = engineCtx.get();
    let voiceEnv: number[] = [0, 0, 0, 0];
    if (e && node) {
      try {
        const vs = e.read(node, 'voiceState') as Array<{ env: number; phase: string }> | undefined;
        if (Array.isArray(vs)) {
          voiceEnv = vs.map((v) => v?.env ?? 0);
        }
      } catch { /* engine may not be ready yet */ }
    }

    const now = clockNow();
    const dt = Math.max(0, Math.min(0.5, (now - lastFrameMs) / 1000));
    lastFrameMs = now;
    const unison = (node?.params?.unison as number | undefined) ?? 0;
    const detune = (node?.params?.detune as number | undefined) ?? 0;
    // WIGGLE strength: combined knob+CV (engine.readParam sums them), else
    // the raw knob. Drives the per-osc 3D rotation in ALL blink modes.
    let wiggleStrength = (node?.params?.wiggle as number | undefined) ?? 0;
    if (e && node) {
      try {
        const wv = e.readParam(node, 'wiggle');
        if (typeof wv === 'number') wiggleStrength = wv;
      } catch { /* engine not ready */ }
    }
    // Per-osc WIGGLE tilt (radians), advanced HERE (single advancer for the
    // wiggle phase) so both the ribbon vec rotation and the scope-tube
    // drawScopes() read the same phase. rate + magnitude ∝ pitch.
    const wiggleTilt: number[] = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) {
      boltPhase[i] = vrtFrozen()
        ? VRT_FIXED_BOLT_PHASE
        : (boltPhase[i]! + BOLT_SPEED * dt) % 1.0;
      // Effective osc frequency from knobs (pitch_cv input is dynamic
      // and would require an engine-side modulator-tap read — skipped
      // here; the visual still scrolls correctly when the user drives
      // with the cv via the audible result, just with a static UI cue).
      const tune = (node?.params?.[`tune${i + 1}`] as number | undefined) ?? 0;
      const fine = (node?.params?.[`fine${i + 1}`] as number | undefined) ?? 0;
      const voct = (tune + fine / 100) / 12
        + (unison >= 0.5 ? detuneOctaveOffset(i, detune) : 0);
      const hz = voctToHz(voct);
      // sqrt(hz) * gain → cycles/sec. Modulo-1 to keep precision; we
      // only feed the fractional component to the shader so the UV
      // shift never grows unbounded over long sessions.
      const cyclesPerSec = Math.sqrt(Math.max(0, hz)) * WAVE_PHASE_GAIN;
      wavePhase[i] = vrtFrozen()
        ? VRT_FIXED_WAVE_PHASE
        : (wavePhase[i]! + cyclesPerSec * dt) % 1.0;
      // WIGGLE: derive rate + magnitude from this osc's pitch (the knob hz
      // mirrors the audible voice). Advance the phase; tilt = sin(phase)·mag.
      const { rate, magnitude } = pitchToWiggle(hz, wiggleStrength);
      if (vrtFrozen()) {
        scopeWigglePhase[i] = 0.6; // fixed non-zero phase for a stable VRT
      } else {
        scopeWigglePhase[i] = (scopeWigglePhase[i]! + rate * dt) % (Math.PI * 2);
      }
      wiggleTilt[i] = Math.sin(scopeWigglePhase[i]!) * magnitude;
    }

    const srcArr = new Float32Array(16);
    const vecArr = new Float32Array(16);
    const colArr = new Float32Array(16);
    const thicknessArr = new Float32Array(4);
    const boltArr = new Float32Array(4);
    const boltPhaseArr = new Float32Array(4);
    const wavePhaseArr = new Float32Array(4);
    for (let i = 0; i < 4; i++) {
      const wall = [[ 1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]][i]!;
      const vec0 = [[-1, 0, 0], [ 1, 0, 0], [0,-1, 0], [0,  1, 0]][i]! as [number, number, number];
      // Apply WIGGLE: rotate the ribbon emit direction around the +Y axis
      // (and a touch of Z) by the per-osc tilt. wiggle=0 → tilt 0 → the
      // original fixed direction (no behaviour change).
      const vec = wiggleTilt[i] !== 0
        ? rotateAroundAxis(vec0, [0, 1, 0.35], wiggleTilt[i]!)
        : vec0;
      srcArr[i * 4 + 0] = wall[0]!;
      srcArr[i * 4 + 1] = wall[1]!;
      srcArr[i * 4 + 2] = wall[2]!;
      srcArr[i * 4 + 3] = 0;
      vecArr[i * 4 + 0] = vec[0]!;
      vecArr[i * 4 + 1] = vec[1]!;
      vecArr[i * 4 + 2] = vec[2]!;
      vecArr[i * 4 + 3] = 0;
      const col = oscRenderColor(i, OSC_COLORS);
      colArr[i * 4 + 0] = col[0]!;
      colArr[i * 4 + 1] = col[1]!;
      colArr[i * 4 + 2] = col[2]!;
      colArr[i * 4 + 3] = col[3]!;
      thicknessArr[i] = (node?.params?.[`thickness${i + 1}`] as number | undefined) ?? 0.3;
      boltArr[i] = voiceEnv[i] ?? 0;
      boltPhaseArr[i] = boltPhase[i]!;
      wavePhaseArr[i] = wavePhase[i]!;
    }
    const uSrcLoc = g.getUniformLocation(ribbonProgram, 'uSrc[0]');
    const uVecLoc = g.getUniformLocation(ribbonProgram, 'uVec[0]');
    const uColLoc = g.getUniformLocation(ribbonProgram, 'uOscColor[0]');
    const uThicknessLoc = g.getUniformLocation(ribbonProgram, 'uThickness[0]');
    const uWavePhaseLoc = g.getUniformLocation(ribbonProgram, 'uWavePhase[0]');
    const uBoltLoc = g.getUniformLocation(ribbonProgram, 'uBolt[0]');
    const uBoltPhaseLoc = g.getUniformLocation(ribbonProgram, 'uBoltPhase[0]');
    const uWaveTexLoc = g.getUniformLocation(ribbonProgram, 'uWaveTex');
    if (uSrcLoc) g.uniform4fv(uSrcLoc, srcArr);
    if (uVecLoc) g.uniform4fv(uVecLoc, vecArr);
    if (uColLoc) g.uniform4fv(uColLoc, colArr);
    if (uThicknessLoc) g.uniform1fv(uThicknessLoc, thicknessArr);
    if (uWavePhaseLoc) g.uniform1fv(uWavePhaseLoc, wavePhaseArr);
    if (uBoltLoc) g.uniform1fv(uBoltLoc, boltArr);
    if (uBoltPhaseLoc) g.uniform1fv(uBoltPhaseLoc, boltPhaseArr);
    // Bind waveTex on TEXTURE0 for the ribbon program.
    g.activeTexture(g.TEXTURE0);
    g.bindTexture(g.TEXTURE_2D, waveTex);
    if (uWaveTexLoc) g.uniform1i(uWaveTexLoc, 0);

    const ribbonVerts = 4 * (2 * RIBBON_SEGMENTS) + 3 * 2;

    // BLINK mode: 0 = wavetable ribbons, 1 = SCOPES TRIAL (thin scope
    // lines), 2 = REALITY BASED COMMUNITY (real 3D neon tubes). Modes 1/2
    // replace the ribbon visual with the per-osc oscilloscope traces; the
    // BENT post + alpha-mask passes are shared.
    const blinkMode = Math.round((node?.params?.blink_mode as number | undefined) ?? 0);

    if (blinkMode > 0 && ensureScopeGl() && scopeProgram) {
      drawScopes(g, blinkMode);
    } else {
      // Scene pass — additive translucent ribbons.
      //
      // BUGFIX (alpha-rotate, #361): this pass previously primed the depth
      // buffer with an opaque DEPTH-ONLY pre-pass over ALL four ribbons
      // (LESS, depthMask on), then drew the additive colour pass with
      // LEQUAL. That made the ribbons MUTUALLY OCCLUDE: whichever ribbon
      // was nearest the camera wrote depth that depth-rejected the ribbons
      // behind it. At rot=0 the ALPHA emitter (-Z wall) sits nearest the
      // camera so it survived — but ANY rotation brought an RGB ribbon in
      // front, whose primed depth then culled the ALPHA ribbon → the ALPHA
      // layer vanished the instant the view rotated.
      //
      // Additive blending (SRC_ALPHA, ONE) is order-independent and the
      // ribbons are translucent energy traces MEANT to show through one
      // another — so there should be no inter-ribbon depth occlusion.
      // Drop the depth pre-pass and draw the additive ribbons with the
      // depth test disabled. Every ribbon composites regardless of camera
      // angle.
      g.disable(g.DEPTH_TEST);
      g.depthMask(false);
      g.colorMask(true, true, true, true);
      g.enable(g.BLEND);
      g.blendFunc(g.SRC_ALPHA, g.ONE);
      g.bindVertexArray(ribbonVao);
      g.drawArrays(g.TRIANGLE_STRIP, 0, ribbonVerts);
      g.bindVertexArray(null);
    }

    // 1c) ALPHA-mask pass (osc 3 only → red mask). Re-bind the ribbon
    // program + its waveTex on TEXTURE0 (drawScopes may have switched the
    // active program + texture when a BLINK scope mode is active).
    //
    // BUGFIX (alpha-rotate, #361): this pass must draw ONLY the ALPHA
    // ribbon (osc 3) AND must not be depth-occluded. Previously it drew all
    // four ribbons with a depth pre-pass, so under rotation an RGB ribbon
    // in front culled the ALPHA fragments → the red mask was never written
    // → the composited alpha_in image vanished off-axis. We now draw ONLY
    // osc 3's sub-strip with the depth test disabled, so the mask is
    // written at any camera angle. ribbonStripRange (exported from
    // wavesculpt.ts — single source of truth) returns the {start,count}
    // covering osc 3's real verts within the strip.
    //
    // NOTE the ALPHA mask always uses the RIBBON geometry (not the scope
    // geometry), so the alpha_in composite stays consistent across all
    // BLINK modes — the BLINK render is purely cosmetic for the visible
    // RGB layers; the ALPHA mask region is driven by osc 3's ribbon.
    g.useProgram(ribbonProgram);
    g.activeTexture(g.TEXTURE0);
    g.bindTexture(g.TEXTURE_2D, waveTex);
    if (uWaveTexLoc) g.uniform1i(uWaveTexLoc, 0);
    g.bindFramebuffer(g.FRAMEBUFFER, alphaMaskFbo);
    g.viewport(0, 0, RES_W, RES_H);
    g.clearColor(0, 0, 0, 1);
    g.clearDepth(1.0);
    g.clear(g.COLOR_BUFFER_BIT | g.DEPTH_BUFFER_BIT);
    const maskColArr = new Float32Array(16);
    maskColArr[3 * 4 + 0] = 1.0;
    maskColArr[3 * 4 + 1] = 0.0;
    maskColArr[3 * 4 + 2] = 0.0;
    maskColArr[3 * 4 + 3] = 1.0;
    if (uColLoc) g.uniform4fv(uColLoc, maskColArr);
    const zeros4 = new Float32Array(4);
    if (uBoltLoc) g.uniform1fv(uBoltLoc, zeros4);
    const { start: alphaStripStart, count: alphaStripCount } = ribbonStripRange(3, RIBBON_SEGMENTS);
    g.disable(g.DEPTH_TEST);
    g.depthMask(false);
    g.colorMask(true, true, true, true);
    g.enable(g.BLEND);
    g.blendFunc(g.SRC_ALPHA, g.ONE);
    g.bindVertexArray(ribbonVao);
    g.drawArrays(g.TRIANGLE_STRIP, alphaStripStart, alphaStripCount);
    g.bindVertexArray(null);
    g.disable(g.BLEND);
    g.disable(g.DEPTH_TEST);
    g.depthMask(true);

    // 2) BENTBOX post-pass.
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
    g.activeTexture(g.TEXTURE2);
    g.bindTexture(g.TEXTURE_2D, alphaMaskTex);
    const uAlphaMask = g.getUniformLocation(bentboxProgram, 'uAlphaMask');
    if (uAlphaMask) g.uniform1i(uAlphaMask, 2);
    g.activeTexture(g.TEXTURE3);
    g.bindTexture(g.TEXTURE_2D, alphaInTex);
    const uAlphaInTexLoc = g.getUniformLocation(bentboxProgram, 'uAlphaInTex');
    if (uAlphaInTexLoc) g.uniform1i(uAlphaInTexLoc, 3);
    const uHasAlphaInLoc = g.getUniformLocation(bentboxProgram, 'uHasAlphaIn');
    if (uHasAlphaInLoc) g.uniform1f(uHasAlphaInLoc, hasAlphaInPatched ? 1.0 : 0.0);
    const uAlphaBrightnessLoc = g.getUniformLocation(bentboxProgram, 'uAlphaBrightness');
    if (uAlphaBrightnessLoc) {
      const ab = node?.params?.alpha_brightness as number | undefined;
      g.uniform1f(uAlphaBrightnessLoc, Math.max(0, Math.min(2, ab ?? 1)));
    }
    const tSec = vrtFrozen() ? VRT_FIXED_TSEC : (clockNow() - renderStartMs) / 1000;
    g.uniform1f(g.getUniformLocation(bentboxProgram, 'uTime'), tSec);
    g.uniform1f(g.getUniformLocation(bentboxProgram, 'uFieldParity'), vrtFrozen() ? 0 : ((frameCount & 1) ? 1 : 0));
    // MASTER GAIN drives the audio bus (wavesculpt.ts setParam) AND this
    // uniform off the SAME param, clamped by the SAME helper — the def owns
    // the range, so the two consumers cannot drift apart.
    g.uniform1f(g.getUniformLocation(bentboxProgram, 'uMasterGain'),        clampMasterGain(node?.params?.master_gain as number ?? MASTER_GAIN_DEFAULT));
    g.bindVertexArray(quadVao);
    g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
    g.bindVertexArray(null);

    // 3) Snapshot postPing → prevTex.
    if (uHasAlphaInLoc) g.uniform1f(uHasAlphaInLoc, 0.0);
    g.bindFramebuffer(g.FRAMEBUFFER, prevFbo);
    g.viewport(0, 0, RES_W, RES_H);
    g.activeTexture(g.TEXTURE0);
    g.bindTexture(g.TEXTURE_2D, postPingTex);
    if (uIn) g.uniform1i(uIn, 0);
    g.bindVertexArray(quadVao);
    g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
    g.bindVertexArray(null);
    g.bindFramebuffer(g.FRAMEBUFFER, null);

    // 4) Final blit.
    g.viewport(0, 0, RES_W, RES_H);
    g.activeTexture(g.TEXTURE0);
    g.bindTexture(g.TEXTURE_2D, postPingTex);
    if (uIn) g.uniform1i(uIn, 0);
    g.bindVertexArray(quadVao);
    g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
    g.bindVertexArray(null);

    frameCount++;
  }

  /** The drawer THIS mount installed. Kept so onDestroy can hand it back for
   *  the OWNER CHECK (#1587): a card MOVE between the headless host and the
   *  dock full-view is an unmount + a mount with no ordering guarantee, and a
   *  blind `uninstall(id)` from the stale mount would erase the live mount's
   *  drawer — leaving the node black forever. */
  let myFrameDrawer: ((c: OffscreenCanvas | HTMLCanvasElement) => void) | null = null;

  function installBridgeFrameDrawer(): void {
    myFrameDrawer = (targetCanvas: OffscreenCanvas | HTMLCanvasElement) => {
      if (!renderCanvas || !gl) return;
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
    };
    installWavesculptFrameDrawer(id, myFrameDrawer);
  }

  let displayCanvas: HTMLCanvasElement | null = $state(null);
  let rafId: number | null = null;

  // ---- SPECTROGRAPH state ----
  // Circular column buffer of dB magnitude values. SPEC_W columns of
  // SPEC_H log-binned rows. The newest column is written each tick at
  // `specWriteCol`; the canvas blit shifts columns left visually. Kept
  // here (not inside drawSpectrograph) so the buffer persists between
  // frames — the whole point of a spectrograph is the scrolling history.
  const SPEC_W = 256;
  const SPEC_H = 128;
  // Init to a low-floor value so the texture starts as "silence" black,
  // not garbage memory. Web Audio's getFloatFrequencyData uses dBFS
  // (~-100..0); we clamp display to [-90 .. -10].
  const specBuf = new Float32Array(SPEC_W * SPEC_H).fill(-100);
  let specWriteCol = 0;
  // Pre-allocate the ImageData buffer reused every frame for the column
  // write — avoids per-frame GC.
  let specImageData: ImageData | null = null;

  /** Draw the BIRDSEYE 2D view directly onto the display canvas. The
   *  view is a top-down look at the unit cube (XZ plane) — Y axis
   *  ignored. Each osc emitter is a colored disc at its wall midpoint
   *  + a per-osc audio ripple sized by the latest env*distGain. Camera
   *  is a yellow + crosshair. Distance lines connect camera to each
   *  emitter. */
  function drawBirdseye(ctx2d: CanvasRenderingContext2D, cw: number, ch: number, time: number): void {
    // Black background like the 3D mode.
    ctx2d.fillStyle = '#050608';
    ctx2d.fillRect(0, 0, cw, ch);

    // The unit cube spans [-1, +1] on each axis. Map XZ → screen
    // with a margin. Square viewport in the middle.
    const margin = 12;
    const viewSize = Math.min(cw, ch) - margin * 2;
    const left = (cw - viewSize) / 2;
    const top  = (ch - viewSize) / 2;
    const x2px = (x: number): number => left + ((x + 1) / 2) * viewSize;
    const z2py = (z: number): number => top  + ((-z + 1) / 2) * viewSize; // +Z forward (top of screen)

    // Box outline.
    ctx2d.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx2d.lineWidth = 1;
    ctx2d.strokeRect(left, top, viewSize, viewSize);

    // Grid (8×8) — faint reference.
    ctx2d.strokeStyle = 'rgba(255,255,255,0.06)';
    for (let g = 1; g < 8; g++) {
      const f = g / 8;
      ctx2d.beginPath();
      ctx2d.moveTo(left + f * viewSize, top);
      ctx2d.lineTo(left + f * viewSize, top + viewSize);
      ctx2d.stroke();
      ctx2d.beginPath();
      ctx2d.moveTo(left,            top + f * viewSize);
      ctx2d.lineTo(left + viewSize, top + f * viewSize);
      ctx2d.stroke();
    }

    // Pull live state for emitters + camera. WALL_LAYOUT[i].src holds
    // the emitter source position; we project XZ. distanceGain math
    // is mirrored from the audio engine so the ripple intensity
    // matches what you hear.
    //
    // Same unified read as the WebGL ribbon tick: engine.read(node,
    // 'camera') returns the LIVE combined (knob + CV) sample from
    // the factory's shadow analyser — the same instant the audio mix
    // is reading.
    const eng = engineCtx.get();
    const cam = eng && node ? (eng.read(node, 'camera') as
      | { pos_x: number; pos_y: number; pos_z: number; zoom: number; rot: number }
      | undefined) : undefined;
    const camX = clampJoy(cam?.pos_x ?? pget('pos_x'));
    const camY = clampJoy(cam?.pos_y ?? pget('pos_y'));
    const camZ = clampJoy(cam?.pos_z ?? pget('pos_z'));
    const camZoom = cam?.zoom ?? pget('zoom') ?? 1;
    const camRot  = cam?.rot  ?? pget('rot')  ?? 0;
    const camPos = eyeFromCamera(camX, camY, camZ, camZoom, camRot);

    // Voice state — for env ripples. Falls back to zero env when the
    // engine isn't ready (early frames).
    const voiceState = eng && node ? (eng.read(node, 'voiceState') as Array<{ env: number; phase: string }> | undefined) : undefined;

    // RED/GREEN/BLUE/ALPHA per-osc colors. Matches the .osc-strip
    // border accents.
    const OSC_COLORS = [
      'rgb(255, 80, 80)',     // RED
      'rgb(80, 220, 100)',    // GREEN
      'rgb(100, 130, 255)',   // BLUE
      'rgb(220, 220, 220)',   // ALPHA (white-ish)
    ];

    // Draw distance lines from camera to each emitter (subtle).
    const camPx = x2px(camPos[0]);
    const camPy = z2py(camPos[2]);
    for (let i = 0; i < 4; i++) {
      const src = WALL_LAYOUT[i]!.src;
      const ex = x2px(src[0]);
      const ey = z2py(src[2]);
      ctx2d.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx2d.lineWidth = 1;
      ctx2d.beginPath();
      ctx2d.moveTo(camPx, camPy);
      ctx2d.lineTo(ex, ey);
      ctx2d.stroke();
    }

    // Draw per-osc audio-energy ripples behind the emitter disc.
    // Ripple radius pulses with time + sized by env*distGain so the
    // user can SEE the spatial gain modulation.
    for (let i = 0; i < 4; i++) {
      const src = WALL_LAYOUT[i]!.src;
      const ex = x2px(src[0]);
      const ey = z2py(src[2]);
      const env = voiceState?.[i]?.env ?? 0;
      const distG = distanceGain(src, WALL_LAYOUT[i]!.vec, camPos);
      const intensity = env * distG;
      if (intensity > 0.01) {
        // Two concentric ripples, time-modulated phase.
        for (let r = 0; r < 2; r++) {
          const phase = (time * 0.0015 + r * 0.5 + i * 0.13) % 1;
          const radius = phase * 26 + 4;
          const alpha  = (1 - phase) * intensity * 0.6;
          ctx2d.strokeStyle = OSC_COLORS[i]!.replace('rgb(', 'rgba(').replace(')', `, ${alpha.toFixed(3)})`);
          ctx2d.lineWidth = 2;
          ctx2d.beginPath();
          ctx2d.arc(ex, ey, radius, 0, Math.PI * 2);
          ctx2d.stroke();
        }
      }
      // Emitter disc.
      ctx2d.fillStyle = OSC_COLORS[i]!;
      ctx2d.beginPath();
      ctx2d.arc(ex, ey, 5, 0, Math.PI * 2);
      ctx2d.fill();
    }

    // Camera marker — yellow + crosshair, with a small filled dot.
    ctx2d.strokeStyle = 'rgb(255, 220, 60)';
    ctx2d.lineWidth = 1.5;
    ctx2d.beginPath();
    ctx2d.moveTo(camPx - 7, camPy);
    ctx2d.lineTo(camPx + 7, camPy);
    ctx2d.stroke();
    ctx2d.beginPath();
    ctx2d.moveTo(camPx, camPy - 7);
    ctx2d.lineTo(camPx, camPy + 7);
    ctx2d.stroke();
    ctx2d.fillStyle = 'rgb(255, 220, 60)';
    ctx2d.beginPath();
    ctx2d.arc(camPx, camPy, 2, 0, Math.PI * 2);
    ctx2d.fill();

    // Mode label, top-left.
    ctx2d.fillStyle = 'rgba(255,255,255,0.45)';
    ctx2d.font = '9px ui-monospace, Menlo, monospace';
    ctx2d.fillText('BIRDSEYE', left + 4, top + 12);
  }

  /** Map a normalised magnitude m in [0..1] to an RGB heatmap (dark
   *  blue → cyan → yellow → red). Inlined arithmetic so it stays fast
   *  inside the per-pixel column-write loop. */
  function heatmapRgb(m: number): [number, number, number] {
    const v = Math.max(0, Math.min(1, m));
    if (v < 0.25) {
      // Black → dark blue
      const t = v / 0.25;
      return [0, 0, Math.round(80 + t * 100)];
    }
    if (v < 0.5) {
      // Blue → cyan
      const t = (v - 0.25) / 0.25;
      return [0, Math.round(t * 200), Math.round(180 + t * 75)];
    }
    if (v < 0.75) {
      // Cyan → yellow
      const t = (v - 0.5) / 0.25;
      return [Math.round(t * 255), Math.round(200 + t * 55), Math.round(255 - t * 255)];
    }
    // Yellow → red
    const t = (v - 0.75) / 0.25;
    return [255, Math.round(255 - t * 255), 0];
  }

  /** Draw the SPECTROGRAPH view. Pulls the latest FFT bin magnitudes
   *  from the audio module (engine.read(node, 'spectrum') returns
   *  Float32Array of dBFS values + sampleRate + fftSize), log-bins them
   *  into SPEC_H perceptual rows (20Hz..20kHz), writes the new column at
   *  specWriteCol, then blits the circular buffer to the canvas with the
   *  newest column on the right.
   *
   *  Performance: O(SPEC_H + SPEC_W * SPEC_H) per frame. SPEC_W=256,
   *  SPEC_H=128 — single-frame ImageData of 256×128 = 128 KB pixels;
   *  ~2-3 ms on a current laptop. Cheap. */
  function drawSpectrograph(ctx2d: CanvasRenderingContext2D, cw: number, ch: number): void {
    const eng = engineCtx.get();
    const spec = eng && node ? (eng.read(node, 'spectrum') as
      | { bins: Float32Array; sampleRate: number; fftSize: number }
      | undefined) : undefined;

    if (spec) {
      // Log-bin the FFT into SPEC_H rows spanning [20 Hz .. 20 kHz].
      // The audio source is busL after master gain — its sample rate is
      // ctx.sampleRate. Bin k of an fftSize-length FFT covers
      // (k * sampleRate / fftSize) Hz. We map row r → target Hz, then
      // pick the FFT bin nearest to that Hz; for rows whose Hz < bin0
      // resolution, this gracefully clamps to bin 1 (DC is skipped).
      const F_LO = 20;
      const F_HI = Math.min(20000, spec.sampleRate * 0.5);
      const logLo = Math.log(F_LO);
      const logHi = Math.log(F_HI);
      const binCount = spec.bins.length;
      const hzPerBin = spec.sampleRate / spec.fftSize;
      // Write into the circular column. Row 0 = top of canvas = high
      // Hz, row SPEC_H-1 = bottom = low Hz (matches the "vertical axis
      // = frequency, log scale" spec, low at the bottom).
      for (let r = 0; r < SPEC_H; r++) {
        const t = 1 - r / (SPEC_H - 1); // 0 at bottom, 1 at top
        const hz = Math.exp(logLo + t * (logHi - logLo));
        const binIdx = Math.max(1, Math.min(binCount - 1, Math.round(hz / hzPerBin)));
        specBuf[specWriteCol * SPEC_H + r] = spec.bins[binIdx] ?? -100;
      }
      specWriteCol = (specWriteCol + 1) % SPEC_W;
    }

    // Blit the circular buffer into an ImageData. Newest column lives
    // at specWriteCol-1; we walk SPEC_W columns leftward from there so
    // the rightmost screen column is the freshest data.
    if (!specImageData) {
      // Fall back to manual buffer if createImageData fails on this
      // canvas (shouldn't happen for a 2D context, but defensive).
      try { specImageData = ctx2d.createImageData(SPEC_W, SPEC_H); }
      catch { return; }
    }
    const img = specImageData;
    const data = img.data;
    // Display range: -90 dBFS (very quiet) → -10 dBFS (loud). Normalize
    // to [0..1] for the heatmap. Linear-in-dB feels more natural than
    // mapping the raw amplitude (which would crush quiet content).
    const DB_LO = -90;
    const DB_HI = -10;
    const dbRange = DB_HI - DB_LO;
    for (let x = 0; x < SPEC_W; x++) {
      // Source column = (specWriteCol - SPEC_W + x) mod SPEC_W; the
      // oldest column lives at specWriteCol, the newest at
      // specWriteCol-1 mod SPEC_W.
      const srcCol = (specWriteCol + x) % SPEC_W;
      for (let y = 0; y < SPEC_H; y++) {
        const db = specBuf[srcCol * SPEC_H + y] ?? -100;
        const norm = (db - DB_LO) / dbRange;
        const [rr, gg, bb] = heatmapRgb(norm);
        const o = (y * SPEC_W + x) * 4;
        data[o]     = rr;
        data[o + 1] = gg;
        data[o + 2] = bb;
        data[o + 3] = 255;
      }
    }

    // Black background outside the spectrograph blit region.
    ctx2d.fillStyle = '#050608';
    ctx2d.fillRect(0, 0, cw, ch);
    // Scale the ImageData to fill the canvas via an offscreen step
    // (putImageData ignores transforms — so paint into a 1:1 buffer on
    // a private detached canvas, then drawImage that with scaling).
    if (!spectrographScratch) {
      spectrographScratch = document.createElement('canvas');
      spectrographScratch.width = SPEC_W;
      spectrographScratch.height = SPEC_H;
    }
    const scratchCtx = spectrographScratch.getContext('2d');
    if (!scratchCtx) return;
    scratchCtx.putImageData(img, 0, 0);
    // Stretch to fill the display canvas.
    ctx2d.imageSmoothingEnabled = true;
    ctx2d.drawImage(spectrographScratch, 0, 0, SPEC_W, SPEC_H, 0, 0, cw, ch);

    // Mode label, top-left.
    ctx2d.fillStyle = 'rgba(255,255,255,0.7)';
    ctx2d.font = '9px ui-monospace, Menlo, monospace';
    ctx2d.fillText('SPECTROGRAPH', 6, 14);
  }
  // Detached scratch canvas for the spectrograph ImageData→scaled-blit
  // path. Lives at module scope (well, instance scope via let) so it's
  // built once and reused every frame.
  let spectrographScratch: HTMLCanvasElement | null = null;

  function tick() {
    rafId = null;
    stepCount++; // mode-agnostic frame counter for the DRS card-step seam (all 3 modes)
    // Live camera/joystick poll first, every frame, BEFORE the early-return
    // branches below — so the joystick dots track a patched gamepad (or LFO)
    // at the full render cadence in ALL video modes, not just the 3D path.
    onFrame?.();
    const mode = Math.round(video_mode);
    if (mode === 1) {
      // BIRDSEYE — pure-2D draw, bypass the WebGL ribbon renderer
      // (cheaper + a totally different visual aesthetic).
      if (displayCanvas) {
        const dc2 = displayCanvas.getContext('2d', { alpha: false });
        if (dc2) {
          drawBirdseye(dc2, displayCanvas.width, displayCanvas.height, clockNow());
        }
      }
      if (!cardStepMode()) rafId = requestAnimationFrame(tick);
      return;
    }
    if (mode === 2) {
      // SPECTROGRAPH — pure-2D draw, taps the audio module's
      // dedicated AnalyserNode via engine.read(node, 'spectrum').
      if (displayCanvas) {
        const dc2 = displayCanvas.getContext('2d', { alpha: false });
        if (dc2) {
          drawSpectrograph(dc2, displayCanvas.width, displayCanvas.height);
        }
      }
      if (!cardStepMode()) rafId = requestAnimationFrame(tick);
      return;
    }

    // PROXIMITY (3D) — original path.
    if (!gl) {
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
    if (ownsVideoOut) {
      installBridgeFrameDrawer();
      // DRS card-step seam (e2e only). __wavesculptStep(t) pins the clock + runs
      // ONE synchronous tick() and returns the new step count (for an exact
      // test-side delta); it sets __wavesculptStepMode so tick() stops
      // self-scheduling -> the test owns the frame count. Call with no arg to
      // resume the normal rAF loop.
      const g = globalThis as unknown as {
        __wavesculptStep?: (t?: number) => number;
        __wavesculptStepCount?: () => number;
        __wavesculptStepMode?: boolean;
      };
      g.__wavesculptStep = (t?: number) => {
        if (typeof t === 'number') {
          g.__wavesculptStepMode = true;
          pinnedClockMs = t;
          if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
          tick(); // one synchronous frame; tick() won't reschedule in step mode
        } else {
          g.__wavesculptStepMode = false;
          pinnedClockMs = null;
          if (rafId === null) rafId = requestAnimationFrame(tick);
        }
        return stepCount;
      };
      g.__wavesculptStepCount = () => stepCount;
    }
    rafId = requestAnimationFrame(tick);
  });

  onDestroy(() => {
    if (rafId !== null) cancelAnimationFrame(rafId);
    // Owner-checked — see myFrameDrawer. A stale mount must not erase the
    // drawer a newer mount already installed.
    if (ownsVideoOut) {
      uninstallWavesculptFrameDrawer(id, myFrameDrawer ?? undefined);
      myFrameDrawer = null;
    }
    disposeGl();
  });
</script>

<canvas
  bind:this={displayCanvas}
  class="wavesculpt-viz"
  {width}
  {height}
  data-testid="wavesculpt-canvas"
  data-node-id={nodeId}
></canvas>

<style>
  /* Moved with the canvas: these were `.screen-wrap canvas` on the card, and
     Svelte's scoped CSS does not reach a child component's element. The
     surface renders no wrapper, so it is still a direct flex child of
     `.screen-wrap` and the box it fills is unchanged. */
  .wavesculpt-viz {
    width: 100%;
    height: 100%;
    display: block;
    background: #000;
  }
</style>

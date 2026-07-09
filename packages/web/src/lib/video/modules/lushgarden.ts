// packages/web/src/lib/video/modules/lushgarden.ts
//
// LUSH GARDEN — generative layered-garden video SOURCE. Assembles a dense
// 2D English-garden bed from a bank of plant cutout PNGs (flowers, bushes,
// small trees — static/lushgarden/manifest.json is the atlas contract) and
// renders the SAME scene through FOUR style pipelines, one per output:
//
//   mono        — OUTLINES ONLY: white-on-black silhouette edges (Sobel on
//                 the cutout's alpha channel, baked at image-load time).
//   watercolor  — each plant's own colours bled/blurred WITHIN its
//                 silhouette (separable blur of the premultiplied cutout,
//                 re-masked by the original alpha so colour never escapes
//                 the plant boundary; slight edge darkening).
//   psychedelic — hue-rotated trippy colours, animated over time with a
//                 per-plant phase offset, STRICTLY inside each plant's
//                 alpha boundary (per-frame hue uniform over the baked
//                 clean sprite — the only per-frame effect).
//   clean       — the plain composite (canonical surface: card preview +
//                 default VRT capture).
//
// SCENE MODEL (pure math in lushgarden-scene.ts — see its header):
//   ground plane from the bottom edge up to an INVISIBLE horizon (the
//   `horizon` param positions placement geometry ONLY — no output draws any
//   line/gradient/ground fill at it); plants spawn at random (worldX,
//   depth); depth maps the ground anchor bottom-edge→horizon and scales the
//   sprite (perspective, lerp 1→FAR_SCALE) on top of the per-kind canonical
//   scale (tree > bush > flower); painter's algorithm far→near; `view` pans
//   a viewport across a 2.5-frame-wide world with depth-proportional
//   parallax (near sweeps, far crawls); plants GROW IN from their ground
//   anchor (~350 ms ease-out); at the 350-sprite cap each spawn replaces
//   the OLDEST plant so the garden keeps evolving.
//
// SPAWNING: continuous at `rate` spawns/sec — UNLESS the `grow` gate input
// is patched (SHAPEGEN clock_in pattern: first CV-bridge setParam arrival
// latches gated mode; the card shows a [GATED] badge), in which case
// exactly ONE plant spawns per rising edge (gateEdge hysteresis detector,
// PortDef.edge:'trigger'). `reset` (edge:'trigger') clears all plants.
//
// BAKE-AT-LOAD STRATEGY (why 4 outputs stay cheap): outline + watercolor
// are STATIC per cutout, so both are baked ONCE per manifest entry when its
// image loads (5 small GL passes: white-key/premultiply prep → alpha-Sobel
// outline → half-res separable blur ×2 → silhouette-masked recombine), into
// per-entry cached textures shared by every sprite instance of that entry.
// Per frame each output is just N textured-quad draws (viewport-rect +
// fullscreen-quad trick — no custom vertex pipeline); only psychedelic
// carries any per-frame math (one hue uniform). Outputs are rendered ONLY
// when their port drives a downstream consumer (frame.connectedOutputPorts,
// the COLOUR OF MAGIC per-port gate) — except `clean`, which always renders
// because it feeds the on-card preview. An absent helper (test mocks)
// renders everything, per the engine contract.
//
// BACKGROUND INPUT: an optional upstream video renders UNPROCESSED as the
// backdrop of ALL FOUR outputs, plants compositing on top (for `mono` the
// white outlines draw over the background too — flagged in the PR body for
// owner veto; unpatched = black backdrop).
//
// ASSETS load LAZILY at runtime (toybox-style manifest → fetch on spawn →
// texture cache; images are NEVER JS-bundled). A failed fetch marks the
// entry failed and its sprites are simply skipped. Baked textures are
// capped (tree 384 / bush 288 / flower 192 px tall; watercolor at half
// res) to bound GPU memory to ~tens of MB with the full 140–170-cutout
// atlas resident, at a ≤1.5× upscale worst case for the nearest sprites.
//
// VRT DETERMINISM: `window.__lushgardenVrtSeed = <number>` re-seeds the
// garden with a FIXED fully-grown plant set (fixed RNG) and suppresses all
// further spawning, so the frozen scene captures pixel-stable (mirrors
// __shapegenVrtSeed / __nibblesVrtSeed). The hidden `freeze` param
// (quadralogical convention) additionally holds the last rendered frames.

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface, VideoFrameContext } from '$lib/video/engine';
import { gateEdge, makeGateState, type GateState } from '$lib/video/plex-select';
import {
  createRng,
  createScene,
  createSpawnScheduler,
  growFactor,
  layoutPlant,
  parseLushgardenManifest,
  resetScene,
  sortPlantsForRender,
  spawnPlant,
  stepSpawner,
  HORIZON_DEFAULT,
  RATE_DEFAULT,
  RATE_MAX,
  RATE_MIN,
  VIEW_DEFAULT,
  type LushgardenManifestEntry,
  type PlantKind,
} from './lushgarden-scene';

// ----------------- exported wiring constants ------------------------------

/** Gate-input port ids + their hidden synthetic CV params (SHAPEGEN's
 *  cv_clock convention — the engine CV-bridge writes the gate sample into
 *  setParam(<param>, v), where a gateEdge detector fires the action). */
export const LUSHGARDEN_GROW_PORT_ID = 'grow';
export const LUSHGARDEN_GROW_PARAM_ID = 'cv_grow';
export const LUSHGARDEN_RESET_PORT_ID = 'reset';
export const LUSHGARDEN_RESET_PARAM_ID = 'cv_reset';

/** The four style outputs. `clean` is the canonical surface (card preview);
 *  the others resolve via read('outputTexture:<port>') (QUADRALOGICAL /
 *  COLOUR OF MAGIC multi-output convention). */
export const LUSHGARDEN_OUTPUT_PORTS = ['mono', 'watercolor', 'psychedelic', 'clean'] as const;

/** Atlas location (SvelteKit static/). */
export const LUSHGARDEN_MANIFEST_URL = '/lushgarden/manifest.json';
export const LUSHGARDEN_ASSET_BASE = '/lushgarden/';

/** Bake-texture height caps per kind (px). Watercolor bakes at half these.
 *  Chosen so the full atlas resident stays ~tens of MB of GPU memory while
 *  the nearest fully-grown sprite upscales ≤1.5× (documented trade-off). */
export const LUSHGARDEN_BAKE_HEIGHT: Record<PlantKind, number> = {
  flower: 192,
  bush: 288,
  tree: 384,
};
const BAKE_MAX_W = 512;

/** Max image bakes drained per frame (spreads GL upload cost). */
const BAKES_PER_FRAME = 2;

/** Psychedelic hue rotation speed (turns/sec) — per-plant phase on top. */
export const LUSHGARDEN_HUE_SPEED = 0.12;

/** Plant count of the deterministic __lushgardenVrtSeed scene. */
export const LUSHGARDEN_VRT_PLANTS = 24;

// ----------------- params -------------------------------------------------

interface LushgardenParams {
  rate: number;    // 0.5..10 spawns/sec (log knob)
  horizon: number; // 0..1 — INVISIBLE placement ceiling (no drawn line)
  view: number;    // 0..1 — parallax pan
  cv_grow: number; // hidden synthetic gate param (grow trigger)
  cv_reset: number;// hidden synthetic gate param (reset trigger)
  freeze: number;  // hidden VRT/determinism hold (quadralogical convention)
}

const DEFAULTS: LushgardenParams = {
  rate: RATE_DEFAULT,
  horizon: HORIZON_DEFAULT,
  view: VIEW_DEFAULT,
  cv_grow: 0,
  cv_reset: 0,
  freeze: 0,
};

// ----------------- shaders (fragment-only, engine quad) -------------------

// PREP — straight-alpha source → premultiplied "clean" bake. For
// matte:'white' entries the flat white backdrop is keyed out first
// (high-luma + low-saturation → transparent, soft ramp).
const PREP_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSrc;
uniform float uMatteWhite;
uniform vec3 uKeyColor;  // per-entry estimated backdrop colour (border-ring median)
uniform float uKeyTol;   // inner tolerance — fully transparent below this distance

void main() {
  vec4 c = texture(uSrc, vUv);
  if (uMatteWhite > 0.5) {
    // Chroma-distance key against the SAMPLED backdrop colour (not a fixed
    // "white"): the real atlas mixes bright-white scans, beige/aged paper
    // (saturation up to ~0.24 — a plain luma+low-sat gate misses those and
    // the plates rendered as opaque rectangles) and even black-mounted
    // engravings. The soft ramp keeps anti-aliased plant edges.
    float d = distance(c.rgb, uKeyColor);
    c.a *= smoothstep(uKeyTol, uKeyTol * 1.9 + 0.02, d);
  }
  outColor = vec4(c.rgb * c.a, c.a); // premultiply
}`;

// OUTLINE — Sobel on the clean bake's ALPHA channel → premultiplied white
// edges on transparent. Crisp silhouette outline, baked once per entry.
const OUTLINE_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSrc;
uniform vec2 uTexel;

float a(vec2 o) { return texture(uSrc, vUv + o * uTexel).a; }

void main() {
  float gx = (a(vec2(1.,-1.)) + 2.0*a(vec2(1.,0.)) + a(vec2(1.,1.)))
           - (a(vec2(-1.,-1.)) + 2.0*a(vec2(-1.,0.)) + a(vec2(-1.,1.)));
  float gy = (a(vec2(-1.,1.)) + 2.0*a(vec2(0.,1.)) + a(vec2(1.,1.)))
           - (a(vec2(-1.,-1.)) + 2.0*a(vec2(0.,-1.)) + a(vec2(1.,-1.)));
  float g = length(vec2(gx, gy));
  float e = smoothstep(0.35, 1.1, g);
  outColor = vec4(e); // premultiplied white edge
}`;

// BLUR — 9-tap separable Gaussian over the PREMULTIPLIED clean bake (so the
// colour bleed weights by coverage). Run twice (H then V) at half res.
const BLUR_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSrc;
uniform vec2 uDir; // texel-scaled blur direction

void main() {
  vec4 acc = texture(uSrc, vUv) * 0.227027;
  vec2 o1 = uDir * 1.3846153846;
  vec2 o2 = uDir * 3.2307692308;
  acc += (texture(uSrc, vUv + o1) + texture(uSrc, vUv - o1)) * 0.3162162162;
  acc += (texture(uSrc, vUv + o2) + texture(uSrc, vUv - o2)) * 0.0702702703;
  outColor = acc;
}`;

// WATERCOLOR combine — un-premultiply the bled colour, re-mask STRICTLY by
// the ORIGINAL silhouette alpha (colour never bleeds outside the plant),
// darken slightly along the alpha gradient (watercolour edge pooling).
const WATERCOLOR_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uBlur;
uniform sampler2D uClean;
uniform vec2 uTexel;

float ca(vec2 o) { return texture(uClean, vUv + o * uTexel).a; }

void main() {
  vec4 b = texture(uBlur, vUv);
  float aC = texture(uClean, vUv).a;
  vec3 col = b.rgb / max(b.a, 1e-4);
  float gx = ca(vec2(1., 0.)) - ca(vec2(-1., 0.));
  float gy = ca(vec2(0., 1.)) - ca(vec2(0., -1.));
  float edge = smoothstep(0.25, 1.0, length(vec2(gx, gy)));
  col *= 1.0 - 0.3 * edge;
  outColor = vec4(col * aC, aC); // premultiplied, masked by the silhouette
}`;

// SPRITE — plain premultiplied sample (clean / mono / watercolor passes).
const SPRITE_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;

void main() { outColor = texture(uTex, vUv); }`;

// PSYCHEDELIC sprite — YIQ hue rotation + saturation/value warp over the
// baked clean sprite, strictly inside its alpha (premultiplied in/out).
const PSYCHE_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform float uHue; // radians

void main() {
  vec4 c = texture(uTex, vUv);
  vec3 rgb = c.rgb / max(c.a, 1e-4);
  // YIQ hue rotation
  vec3 yiq = vec3(
    dot(rgb, vec3(0.299, 0.587, 0.114)),
    dot(rgb, vec3(0.5959, -0.2746, -0.3213)),
    dot(rgb, vec3(0.2115, -0.5227, 0.3112)));
  float cs = cos(uHue);
  float sn = sin(uHue);
  yiq.yz = mat2(cs, -sn, sn, cs) * yiq.yz;
  rgb = vec3(
    dot(yiq, vec3(1.0, 0.956, 0.619)),
    dot(yiq, vec3(1.0, -0.272, -0.647)),
    dot(yiq, vec3(1.0, -1.106, 1.703)));
  // saturation push + gentle value warp
  float l = dot(rgb, vec3(0.299, 0.587, 0.114));
  rgb = mix(vec3(l), rgb, 1.7);
  rgb = clamp(rgb, 0.0, 1.0);
  rgb = pow(rgb, vec3(0.85));
  outColor = vec4(rgb * c.a, c.a);
}`;

// COPY — background passthrough (UNPROCESSED backdrop under the plants).
const COPY_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSrc;

void main() { outColor = vec4(texture(uSrc, vUv).rgb, 1.0); }`;

// ----------------- per-entry baked texture cache ---------------------------

type EntryStatus = 'idle' | 'loading' | 'ready' | 'failed';

interface BakedEntry {
  status: EntryStatus;
  clean: WebGLTexture | null;
  outline: WebGLTexture | null;
  watercolor: WebGLTexture | null;
}

// ----------------- module def ---------------------------------------------

export const lushgardenDef: VideoModuleDef = {
  type: 'lushgarden',
  palette: { top: 'Video modules', sub: 'Sources' },
  domain: 'video',
  label: 'lush garden',
  category: 'sources',
  card: 'LushGardenCard',
  inputs: [
    // Optional backdrop: passes through UNPROCESSED under the plants on all
    // four outputs (unpatched = black).
    { id: 'background', type: 'video' },
    { id: 'rate',    type: 'cv', paramTarget: 'rate',    cvScale: { mode: 'log' } },
    { id: 'horizon', type: 'cv', paramTarget: 'horizon', cvScale: { mode: 'linear' } },
    { id: 'view',    type: 'cv', paramTarget: 'view',    cvScale: { mode: 'linear' } },
    // grow: patched → rate-spawning stops; ONE plant per rising edge.
    { id: LUSHGARDEN_GROW_PORT_ID,  type: 'gate', edge: 'trigger', paramTarget: LUSHGARDEN_GROW_PARAM_ID },
    // reset: rising edge clears all plants.
    { id: LUSHGARDEN_RESET_PORT_ID, type: 'gate', edge: 'trigger', paramTarget: LUSHGARDEN_RESET_PARAM_ID },
  ],
  outputs: [
    { id: 'mono',        type: 'video' },
    { id: 'watercolor',  type: 'video' },
    { id: 'psychedelic', type: 'video' },
    { id: 'clean',       type: 'video' },
  ],
  params: [
    { id: 'rate',    label: 'Rate',    defaultValue: DEFAULTS.rate,    min: RATE_MIN, max: RATE_MAX, curve: 'log' },
    { id: 'horizon', label: 'Horizon', defaultValue: DEFAULTS.horizon, min: 0, max: 1, curve: 'linear' },
    { id: 'view',    label: 'View',    defaultValue: DEFAULTS.view,    min: 0, max: 1, curve: 'linear' },
    // Hidden synthetic gate params (SHAPEGEN cv_clock convention) — rendered
    // as the grow/reset jacks via the standard port rows, not as knobs.
    { id: LUSHGARDEN_GROW_PARAM_ID,  label: 'GRW', defaultValue: 0, min: 0, max: 1, curve: 'linear' },
    { id: LUSHGARDEN_RESET_PARAM_ID, label: 'RST', defaultValue: 0, min: 0, max: 1, curve: 'linear' },
    // Hidden determinism hold — no card control (quadralogical convention).
    { id: 'freeze', label: 'Freeze', defaultValue: 0, min: 0, max: 1, curve: 'linear' },
  ],

  // docs-hash-ignore:start
  docs: {
    explanation:
      "lush garden is a generative video source that grows a dense, layered 2D English-garden bed out of a bank of ~150 real plant cutouts (flowers, bushes, small trees). Plants spawn continuously at the RATE knob's spawns-per-second onto a virtual ground plane that runs from the bottom edge up to an INVISIBLE horizon: each plant lands at a random (x, depth), where depth places its ground anchor between the bottom edge (near) and the horizon (far) and scales it down with distance on top of the natural kind scale (trees > bushes > flowers; the spawn mix is roughly 70% flowers / 20% bushes / 10% trees). New plants grow in from their ground anchor with a quick ~350 ms ease-out. The scene composites back-to-front (painter's algorithm), and VIEW pans a viewport across a world ~2.5 frames wide with depth-proportional parallax — near plants sweep past while the far rank barely moves, a deliberately flat, theatre-flat parallax. At the 350-plant cap each new spawn replaces the OLDEST plant, so a full bed keeps slowly turning over instead of freezing. Patch a gate into GROW to take manual control: continuous spawning stops entirely and exactly one plant grows per rising edge (the card shows [GATED]); pulse RESET to clear the bed. The same scene renders through four simultaneous outputs — clean (the plain composite, also the card preview), mono (white silhouette outlines), watercolor (colours bled inside each plant's boundary), and psychedelic (animated hue-cycled colours, phase-offset per plant) — and an optional background video passes through unprocessed behind the plants on all four. Usage: run it bare as an evolving backdrop; clock GROW from a sequencer so the garden grows on the beat; sweep VIEW with a slow LFO for a drifting parallax pan; or feed a camera into background and outlines into a mixer for a garden-stencil overlay.",
    inputs: {
      background: "Optional backdrop video. When patched, the upstream frame renders UNPROCESSED behind the plants on ALL FOUR outputs (the per-plant styling stays strictly inside plant silhouettes; on mono the white outlines draw over it too). Unpatched: black backdrop.",
      rate: "CV over RATE (log scale): modulates the continuous spawn rate between 0.5 and 10 plants per second. Ignored while a cable is patched into GROW (gated mode spawns only on edges).",
      horizon: "CV over HORIZON: moves the invisible placement ceiling that far plants anchor against — see the HORIZON control. No line or seam is ever drawn at it.",
      view: "CV over VIEW: pans the parallax viewport across the wide garden world. A slow LFO here gives the signature drifting near-fast/far-slow pan.",
      grow: "Trigger input (rising edge). PATCHING this port switches the module to gated growth: continuous RATE spawning stops entirely and exactly ONE plant grows in per rising edge (hysteresis 0.6/0.4). The card shows a [GATED] badge while wired. Unpatching holds gated mode until the module is respawned (Eurorack-style latch, same as shapegen's CLK).",
      reset: "Trigger input (rising edge): clears every plant — the bed starts over from bare ground (spawning continues per the current mode).",
    },
    outputs: {
      mono: "OUTLINES ONLY: crisp white plant-silhouette edges (a Sobel over each cutout's alpha channel, baked per cutout) on black — or drawn over the background video when one is patched.",
      watercolor: "Soft watercolour composite: each plant's own colours heavily bled/blurred WITHIN its silhouette (never outside it), with slight darkening along the silhouette edge. Backdrop passes through untouched.",
      psychedelic: "Trippy composite: each plant's colours hue-rotate continuously over time with a per-plant phase offset plus saturation/value warping, strictly inside its silhouette. Backdrop passes through untouched.",
      clean: "The plain composite — every cutout with its normal image data over the backdrop. This is the canonical output and what the on-card preview shows.",
    },
    controls: {
      rate: "RATE (0.5–10 spawns/sec, log, default 2): how fast new plants appear in continuous mode. Has no effect while GROW is patched (gated mode).",
      horizon: "HORIZON (0–1, default 0.65): the height of the INVISIBLE horizon — a placement control only. It caps how high far plants anchor and sets the perspective scale gradient; no output ever draws a line, gradient or ground fill at it (its existence is only inferable from where plants stop appearing).",
      view: "VIEW (0–1, default 0.5): pans the virtual viewport across the ~2.5-frame-wide garden. Near plants shift proportionally more than far ones (2D parallax), revealing/hiding plants at the edges.",
      cv_grow: "Hidden synthetic gate param backing the GROW jack (not a knob). The engine CV-bridge writes the gate sample here; a rising edge (0.6/0.4 hysteresis) spawns exactly one plant, and the first write latches gated mode.",
      cv_reset: "Hidden synthetic gate param backing the RESET jack (not a knob). A rising edge clears all plants.",
      freeze: "Freeze (0 to 1, hidden): a determinism toggle for deterministic capture — at >=0.5 the renderer holds the last frame and stops drawing; no card control.",
    },
  },
  // docs-hash-ignore:end
  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;

    // ---- programs ----
    const prepProgram = ctx.compileFragment(PREP_FRAG);
    const outlineProgram = ctx.compileFragment(OUTLINE_FRAG);
    const blurProgram = ctx.compileFragment(BLUR_FRAG);
    const watercolorProgram = ctx.compileFragment(WATERCOLOR_FRAG);
    const spriteProgram = ctx.compileFragment(SPRITE_FRAG);
    const psycheProgram = ctx.compileFragment(PSYCHE_FRAG);
    const copyProgram = ctx.compileFragment(COPY_FRAG);

    const uPrepSrc = gl.getUniformLocation(prepProgram, 'uSrc');
    const uPrepMatte = gl.getUniformLocation(prepProgram, 'uMatteWhite');
    const uPrepKeyColor = gl.getUniformLocation(prepProgram, 'uKeyColor');
    const uPrepKeyTol = gl.getUniformLocation(prepProgram, 'uKeyTol');
    const uOutlineSrc = gl.getUniformLocation(outlineProgram, 'uSrc');
    const uOutlineTexel = gl.getUniformLocation(outlineProgram, 'uTexel');
    const uBlurSrc = gl.getUniformLocation(blurProgram, 'uSrc');
    const uBlurDir = gl.getUniformLocation(blurProgram, 'uDir');
    const uWcBlur = gl.getUniformLocation(watercolorProgram, 'uBlur');
    const uWcClean = gl.getUniformLocation(watercolorProgram, 'uClean');
    const uWcTexel = gl.getUniformLocation(watercolorProgram, 'uTexel');
    const uSpriteTex = gl.getUniformLocation(spriteProgram, 'uTex');
    const uPsycheTex = gl.getUniformLocation(psycheProgram, 'uTex');
    const uPsycheHue = gl.getUniformLocation(psycheProgram, 'uHue');
    const uCopySrc = gl.getUniformLocation(copyProgram, 'uSrc');

    // ---- output FBOs (engine-managed → auto-resized on aspect switch) ----
    const fbos = {
      mono: ctx.createFbo(),
      watercolor: ctx.createFbo(),
      psychedelic: ctx.createFbo(),
      clean: ctx.createFbo(),
    };

    // ---- bake scratch (one FBO re-attached per pass + 2 scratch textures) --
    const bakeFbo = gl.createFramebuffer();
    if (!bakeFbo) throw new Error('LUSHGARDEN: createFramebuffer failed (bakeFbo)');
    function makeTex(w: number, h: number): WebGLTexture {
      const t = gl.createTexture();
      if (!t) throw new Error('LUSHGARDEN: createTexture failed');
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    }
    let scratchA: WebGLTexture | null = null; // half-res blur ping
    let scratchB: WebGLTexture | null = null; // half-res blur pong

    // ---- manifest + per-entry baked texture cache ----
    let entries: LushgardenManifestEntry[] = [];
    let manifestFailed = false;
    const baked = new Map<string, BakedEntry>();
    const entryById = new Map<string, LushgardenManifestEntry>();
    /** Per-entry backdrop key estimate for matte:'white' plates. */
    interface KeyEstimate { r: number; g: number; b: number; tol: number }
    const DEFAULT_KEY: KeyEstimate = { r: 1, g: 1, b: 1, tol: 0.12 };
    /** Decoded bitmaps awaiting their GL bake (drained inside draw()). */
    const pendingBakes: Array<{
      entry: LushgardenManifestEntry;
      bitmap: ImageBitmap;
      key: KeyEstimate;
    }> = [];

    /**
     * Estimate a matte plate's backdrop colour from its BORDER RING (2 px,
     * downscaled ≤160 px wide): per-channel MEDIAN (robust to a stem or
     * caption crossing the border) + a luma median-abs-deviation-derived
     * tolerance. Handles bright-white scans, beige/aged paper AND
     * black-mounted engravings uniformly — measured across the real atlas
     * the border satMean runs 0→0.24, which a fixed "white" key misses.
     * Falls back to DEFAULT_KEY when 2D canvas readback is unavailable.
     */
    function estimateKeyBackdrop(bitmap: ImageBitmap): KeyEstimate {
      try {
        if (typeof OffscreenCanvas === 'undefined') return DEFAULT_KEY;
        const w = Math.max(8, Math.min(160, bitmap.width));
        const h = Math.max(8, Math.round((bitmap.height / bitmap.width) * w));
        const canvas = new OffscreenCanvas(w, h);
        const c2d = canvas.getContext('2d', { willReadFrequently: true });
        if (!c2d) return DEFAULT_KEY;
        c2d.drawImage(bitmap, 0, 0, w, h);
        const img = c2d.getImageData(0, 0, w, h).data;
        const rs: number[] = [];
        const gs: number[] = [];
        const bs: number[] = [];
        const push = (x: number, y: number): void => {
          const o = (y * w + x) * 4;
          rs.push(img[o]! / 255);
          gs.push(img[o + 1]! / 255);
          bs.push(img[o + 2]! / 255);
        };
        for (let x = 0; x < w; x++) { push(x, 0); push(x, 1); push(x, h - 1); push(x, h - 2); }
        for (let y = 2; y < h - 2; y++) { push(0, y); push(1, y); push(w - 1, y); push(w - 2, y); }
        const median = (a: number[]): number => {
          const s = [...a].sort((p, q) => p - q);
          return s[s.length >> 1] ?? 1;
        };
        const r = median(rs);
        const g = median(gs);
        const b = median(bs);
        const lum = (i: number): number => 0.299 * rs[i]! + 0.587 * gs[i]! + 0.114 * bs[i]!;
        const lumMed = 0.299 * r + 0.587 * g + 0.114 * b;
        const devs: number[] = [];
        for (let i = 0; i < rs.length; i++) devs.push(Math.abs(lum(i) - lumMed));
        const mad = median(devs);
        // Paper grain sets the floor; a plant crossing the border inflates
        // MAD a little — clamp keeps the key usable either way.
        const tol = Math.min(0.16, Math.max(0.08, 4 * mad + 0.05));
        return { r, g, b, tol };
      } catch {
        return DEFAULT_KEY;
      }
    }

    const canFetch = typeof fetch === 'function';
    if (canFetch) {
      fetch(LUSHGARDEN_MANIFEST_URL)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((json) => {
          entries = parseLushgardenManifest(json);
          for (const e of entries) entryById.set(e.id, e);
        })
        .catch((err) => {
          manifestFailed = true;
          console.warn('[lushgarden] manifest load failed:', err);
        });
    }

    /** Kick off the lazy fetch+decode for an entry (idempotent). The GL
     *  bake itself runs inside draw() so all GL work stays in-frame. */
    function ensureEntryLoaded(entryId: string): void {
      const cached = baked.get(entryId);
      if (cached && cached.status !== 'idle') return;
      const entry = entryById.get(entryId);
      if (!entry || !canFetch || typeof createImageBitmap !== 'function') return;
      baked.set(entryId, { status: 'loading', clean: null, outline: null, watercolor: null });
      fetch(LUSHGARDEN_ASSET_BASE + entry.file)
        .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`HTTP ${r.status}`))))
        // Flip AT DECODE TIME: UNPACK_FLIP_Y_WEBGL is spec-IGNORED for
        // ImageBitmap sources (verified in this Chromium — a FLIP_Y upload
        // still put image-row-0 at v=0, rendering every cutout upside-down;
        // the INGA plate's mirrored caption exposed it). imageOrientation
        // is the sanctioned control; premultiplyAlpha 'none' keeps the
        // texels straight-alpha for the PREP shader's own premultiply.
        .then((blob) => createImageBitmap(blob, {
          imageOrientation: 'flipY',
          premultiplyAlpha: 'none',
        }))
        .then((bitmap) => {
          const key = entry.matte === 'white' ? estimateKeyBackdrop(bitmap) : DEFAULT_KEY;
          pendingBakes.push({ entry, bitmap, key });
        })
        .catch((err) => {
          const b = baked.get(entryId);
          if (b) b.status = 'failed'; // sprites of this entry are skipped
          console.warn(`[lushgarden] cutout load failed (${entry.file}):`, err);
        });
    }

    /** Run the 5-pass bake for one decoded cutout. All passes render with
     *  blending OFF into bakeFbo-attached textures at capped dims. */
    function bakeEntry(entry: LushgardenManifestEntry, bitmap: ImageBitmap, key: KeyEstimate): void {
      const rec = baked.get(entry.id);
      if (!rec) return;
      const bakeH = LUSHGARDEN_BAKE_HEIGHT[entry.kind];
      const bakeW = Math.max(8, Math.min(BAKE_MAX_W, Math.round(bakeH * (entry.w / entry.h))));
      const halfW = Math.max(4, bakeW >> 1);
      const halfH = Math.max(4, bakeH >> 1);

      // 0. Upload the straight-alpha source. Orientation was handled at
      //    DECODE time (createImageBitmap imageOrientation:'flipY') — the
      //    UNPACK_FLIP_Y_WEBGL pixel-store flag is spec-ignored for
      //    ImageBitmap sources, so setting it here would be a silent no-op.
      const srcTex = makeTex(1, 1);
      gl.bindTexture(gl.TEXTURE_2D, srcTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);

      const clean = makeTex(bakeW, bakeH);
      const outline = makeTex(bakeW, bakeH);
      const watercolor = makeTex(bakeW, bakeH);
      if (!scratchA) scratchA = makeTex(halfW, halfH);
      else { gl.bindTexture(gl.TEXTURE_2D, scratchA); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, halfW, halfH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null); }
      if (!scratchB) scratchB = makeTex(halfW, halfH);
      else { gl.bindTexture(gl.TEXTURE_2D, scratchB); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, halfW, halfH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null); }

      gl.disable(gl.BLEND);
      gl.bindFramebuffer(gl.FRAMEBUFFER, bakeFbo);

      const pass = (target: WebGLTexture, w: number, h: number, program: WebGLProgram,
        bind: () => void): void => {
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
        gl.viewport(0, 0, w, h);
        gl.useProgram(program);
        bind();
        ctx.drawFullscreenQuad();
      };

      // 1. PREP → clean (backdrop-distance key + premultiply)
      pass(clean, bakeW, bakeH, prepProgram, () => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, srcTex);
        gl.uniform1i(uPrepSrc, 0);
        gl.uniform1f(uPrepMatte, entry.matte === 'white' ? 1 : 0);
        gl.uniform3f(uPrepKeyColor, key.r, key.g, key.b);
        gl.uniform1f(uPrepKeyTol, key.tol);
      });
      // 2. OUTLINE ← clean alpha Sobel
      pass(outline, bakeW, bakeH, outlineProgram, () => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, clean);
        gl.uniform1i(uOutlineSrc, 0);
        gl.uniform2f(uOutlineTexel, 1 / bakeW, 1 / bakeH);
      });
      // 3+4. Half-res separable blur of the premultiplied clean — TWO
      // H+V rounds with wide taps for a heavy, genuinely-bled wash (a
      // single narrow round read as barely-soft on flat-colour cutouts).
      const blurPass = (src: WebGLTexture, dst: WebGLTexture, dx: number, dy: number): void => {
        pass(dst, halfW, halfH, blurProgram, () => {
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, src);
          gl.uniform1i(uBlurSrc, 0);
          gl.uniform2f(uBlurDir, dx, dy);
        });
      };
      blurPass(clean, scratchA!, 2.5 / halfW, 0);
      blurPass(scratchA!, scratchB!, 0, 2.5 / halfH);
      blurPass(scratchB!, scratchA!, 2.5 / halfW, 0);
      blurPass(scratchA!, scratchB!, 0, 2.5 / halfH);
      // 5. WATERCOLOR ← blurred colour re-masked by the clean silhouette.
      pass(watercolor, bakeW, bakeH, watercolorProgram, () => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, scratchB!);
        gl.uniform1i(uWcBlur, 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, clean);
        gl.uniform1i(uWcClean, 1);
        gl.uniform2f(uWcTexel, 1 / bakeW, 1 / bakeH);
      });

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteTexture(srcTex);
      bitmap.close();

      // Mipmaps: sprites render mostly minified (perspective + grow-in) —
      // trilinear kills the shimmer for a one-off bake cost.
      for (const t of [clean, outline, watercolor]) {
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      }
      gl.bindTexture(gl.TEXTURE_2D, null);

      rec.clean = clean;
      rec.outline = outline;
      rec.watercolor = watercolor;
      rec.status = 'ready';
    }

    // ---- scene / spawn state ----
    const params: LushgardenParams = { ...DEFAULTS, ...(node.params as Partial<LushgardenParams>) };
    const scene = createScene();
    const spawner = createSpawnScheduler();
    // Fixed-seed RNG: deterministic garden for a given spawn sequence.
    const rng = createRng(0x10c4a11);

    // Gate state (SHAPEGEN cv_clock pattern): patched-detection latches on
    // the first CV-bridge setParam arrival; gateEdge detects rising edges.
    let growPatched = false;
    const growGate: GateState = makeGateState();
    const resetGate: GateState = makeGateState();
    let pendingGrowSpawns = 0;
    let pendingReset = false;
    let resetCount = 0;

    // VRT determinism hook (mirrors __shapegenVrtSeed / __nibblesVrtSeed).
    let vrtMode = false;
    let vrtSeeded = false;
    let appliedVrtSeed: number | null = null;

    let lastTime: number | null = null;
    let framesElapsed = 0;

    function spawnOne(now: number): void {
      const p = spawnPlant(scene, entries, rng, now);
      if (p) ensureEntryLoaded(p.entryId);
    }

    const surface: VideoNodeSurface = {
      fbo: fbos.clean.fbo,
      texture: fbos.clean.texture,
      draw(frame: VideoFrameContext) {
        const g = frame.gl;
        const now = frame.time;
        const dt = lastTime === null ? 0 : Math.max(0, now - lastTime);
        lastTime = now;
        framesElapsed++;

        // freeze (VRT/determinism): hold the last rendered frames.
        if (params.freeze >= 0.5) return;

        // ---- VRT seed hook: fixed fully-grown garden, spawning suppressed.
        const seedFlag = (globalThis as unknown as { __lushgardenVrtSeed?: unknown })
          .__lushgardenVrtSeed;
        if (typeof seedFlag === 'number' && seedFlag !== appliedVrtSeed) {
          appliedVrtSeed = seedFlag;
          vrtMode = true;
          vrtSeeded = false;
          resetScene(scene);
        }
        if (vrtMode && !vrtSeeded && entries.length > 0) {
          const vrtRng = createRng(appliedVrtSeed ?? 1);
          for (let i = 0; i < LUSHGARDEN_VRT_PLANTS; i++) {
            const p = spawnPlant(scene, entries, vrtRng, now - 10); // fully grown
            if (p) {
              p.visibleAt = p.bornAt; // pin the grow-in reference
              ensureEntryLoaded(p.entryId);
            }
          }
          vrtSeeded = true;
        }

        // ---- 1. Spawning (skipped entirely in VRT-seed mode) ----
        if (!vrtMode) {
          if (pendingReset) {
            pendingReset = false;
            resetScene(scene);
          }
          while (pendingGrowSpawns > 0) {
            pendingGrowSpawns--;
            spawnOne(now);
          }
          const n = stepSpawner(spawner, dt, params.rate, growPatched);
          for (let i = 0; i < n; i++) spawnOne(now);
        } else {
          pendingGrowSpawns = 0;
          pendingReset = false;
        }

        // ---- 2. Drain queued image bakes (bounded per frame) ----
        for (let i = 0; i < BAKES_PER_FRAME && pendingBakes.length > 0; i++) {
          const job = pendingBakes.shift()!;
          try {
            bakeEntry(job.entry, job.bitmap, job.key);
          } catch (err) {
            const b = baked.get(job.entry.id);
            if (b) b.status = 'failed';
            console.warn('[lushgarden] bake failed:', err);
          }
        }

        // ---- 3. Layout + painter's sort (shared by all four outputs) ----
        const layout = {
          horizon: params.horizon,
          view: params.view,
          now,
          resW: ctx.res.width,
          resH: ctx.res.height,
        };
        const ordered = sortPlantsForRender(scene.plants);
        const draws: Array<{ rec: BakedEntry; rect: { x: number; y: number; w: number; h: number }; phase: number }> = [];
        for (const plant of ordered) {
          const rec = baked.get(plant.entryId);
          if (!rec || rec.status !== 'ready') continue;
          if (plant.visibleAt === null) plant.visibleAt = now; // grow-in starts when renderable
          const rect = layoutPlant(plant, layout);
          if (!rect) continue;
          draws.push({ rec, rect, phase: plant.phase });
        }

        // ---- 4. Render each CONNECTED output (clean always: card preview).
        // Absent helper (test mocks) → render everything, per the engine
        // contract ("connectivity unknown → never wrongly go dark").
        const connected = frame.connectedOutputPorts?.(node.id);
        const bgTex = frame.getInputTexture(node.id, 'background');
        const hueBase = now * LUSHGARDEN_HUE_SPEED * Math.PI * 2;

        const renderOutput = (
          port: (typeof LUSHGARDEN_OUTPUT_PORTS)[number],
          fbo: WebGLFramebuffer,
          pickTex: (rec: BakedEntry) => WebGLTexture | null,
          psychedelic: boolean,
        ): void => {
          if (connected && port !== 'clean' && !connected.has(port)) return;
          g.bindFramebuffer(g.FRAMEBUFFER, fbo);
          g.viewport(0, 0, ctx.res.width, ctx.res.height);
          // Backdrop: patched upstream passes through UNPROCESSED; else black.
          if (bgTex) {
            g.disable(g.BLEND);
            g.useProgram(copyProgram);
            g.activeTexture(g.TEXTURE0);
            g.bindTexture(g.TEXTURE_2D, bgTex);
            g.uniform1i(uCopySrc, 0);
            ctx.drawFullscreenQuad();
          } else {
            g.clearColor(0, 0, 0, 1);
            g.clear(g.COLOR_BUFFER_BIT);
          }
          // Sprites far→near, premultiplied-alpha blending, viewport-rect quads.
          g.enable(g.BLEND);
          g.blendFunc(g.ONE, g.ONE_MINUS_SRC_ALPHA);
          const program = psychedelic ? psycheProgram : spriteProgram;
          g.useProgram(program);
          g.activeTexture(g.TEXTURE0);
          g.uniform1i(psychedelic ? uPsycheTex : uSpriteTex, 0);
          for (const d of draws) {
            const tex = pickTex(d.rec);
            if (!tex) continue;
            g.bindTexture(g.TEXTURE_2D, tex);
            if (psychedelic) g.uniform1f(uPsycheHue, hueBase + d.phase * Math.PI * 2);
            g.viewport(d.rect.x, d.rect.y, d.rect.w, d.rect.h);
            ctx.drawFullscreenQuad();
          }
          g.disable(g.BLEND);
        };

        renderOutput('clean', fbos.clean.fbo, (r) => r.clean, false);
        renderOutput('mono', fbos.mono.fbo, (r) => r.outline, false);
        renderOutput('watercolor', fbos.watercolor.fbo, (r) => r.watercolor, false);
        renderOutput('psychedelic', fbos.psychedelic.fbo, (r) => r.clean, true);

        g.bindFramebuffer(g.FRAMEBUFFER, null);
      },
      dispose() {
        for (const f of Object.values(fbos)) {
          gl.deleteFramebuffer(f.fbo);
          gl.deleteTexture(f.texture);
        }
        gl.deleteFramebuffer(bakeFbo);
        if (scratchA) gl.deleteTexture(scratchA);
        if (scratchB) gl.deleteTexture(scratchB);
        for (const rec of baked.values()) {
          if (rec.clean) gl.deleteTexture(rec.clean);
          if (rec.outline) gl.deleteTexture(rec.outline);
          if (rec.watercolor) gl.deleteTexture(rec.watercolor);
        }
        baked.clear();
        for (const job of pendingBakes) job.bitmap.close();
        pendingBakes.length = 0;
        for (const p of [prepProgram, outlineProgram, blurProgram, watercolorProgram,
          spriteProgram, psycheProgram, copyProgram]) {
          gl.deleteProgram(p);
        }
      },
    };

    return {
      domain: 'video',
      surface,
      setParam(paramId, value) {
        if (paramId === LUSHGARDEN_GROW_PARAM_ID) {
          // First bridge write latches gated mode (SHAPEGEN convention —
          // the bridge only materializes when a cable is patched).
          growPatched = true;
          params.cv_grow = value;
          if (gateEdge(growGate, value)) pendingGrowSpawns++;
          return;
        }
        if (paramId === LUSHGARDEN_RESET_PARAM_ID) {
          params.cv_reset = value;
          if (gateEdge(resetGate, value)) {
            pendingReset = true;
            resetCount++;
          }
          return;
        }
        if (paramId in params) (params as unknown as Record<string, number>)[paramId] = value;
      },
      readParam(paramId) {
        return (params as unknown as Record<string, number>)[paramId];
      },
      read(key) {
        // Multi-output escape hatch — engine.lookupInput checks these BEFORE
        // surface.texture (quadralogical convention).
        if (key === 'outputTexture:mono') return fbos.mono.texture;
        if (key === 'outputTexture:watercolor') return fbos.watercolor.texture;
        if (key === 'outputTexture:psychedelic') return fbos.psychedelic.texture;
        if (key === 'outputTexture:clean') return fbos.clean.texture;
        // Engine probes for the card + tests (shapegen regenCount pattern).
        if (key === 'plantCount') return scene.plants.length;
        if (key === 'spawnCount') return scene.nextSerial - 1;
        if (key === 'growPatched') return growPatched ? 1 : 0;
        if (key === 'resetCount') return resetCount;
        if (key === 'manifestCount') return entries.length;
        if (key === 'manifestFailed') return manifestFailed ? 1 : 0;
        if (key === 'readyCount') {
          let n = 0;
          for (const r of baked.values()) if (r.status === 'ready') n++;
          return n;
        }
        // In-flight cutout loads (fetch → decode → queued GL bake; the
        // status stays 'loading' until the bake completes). 0 = every
        // requested entry has settled (ready or failed) — the VRT scene
        // polls this to know the seeded garden is fully renderable.
        if (key === 'pendingLoads') {
          let n = 0;
          for (const r of baked.values()) if (r.status === 'loading') n++;
          return n;
        }
        if (key === 'framesElapsed') return framesElapsed;
        if (key === 'vrtSeeded') return vrtSeeded ? 1 : 0;
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};

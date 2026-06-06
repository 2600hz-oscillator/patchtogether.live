// packages/web/src/lib/video/toybox-shadertoy.ts
//
// TOYBOX Shadertoy runtime — pure helpers (no GL).
//
// This file holds the parts of the Shadertoy compatibility layer that are
// independent of WebGL state, so they can be unit-tested as pure functions:
//   - the `mainImage(out vec4, in vec2)` → `main()` shim + the full Shadertoy
//     uniform preamble (iTime / iResolution / iMouse / iChannelN / …),
//   - the iMouse pointer→engine coordinate mapping (client px → engine px,
//     with the GL bottom-origin Y-flip) and the Shadertoy .xy/.z/.w press
//     semantics,
//   - the multi-buffer PASS topo-ordering (producers before consumers, the
//     Image pass last) and per-pass channel resolution.
//
// The GL side (FBO allocation, ping-pong feedback, uniform binding) lives in
// modules/toybox.ts and CONSUMES these helpers. See the design in
// .myrobots / the PR for the full plan; the contract here is the testable seam.

// ----------------------------------------------------------------------
// 1. Single-pass shim + uniform preamble
// ----------------------------------------------------------------------

/**
 * The full Shadertoy uniform block, declared exactly as the official site does
 * (so a pasted shader compiles unchanged). `iResolution` is a vec3 (w, h, 1);
 * `iMouse` / `iDate` are vec4; iChannel0-3 are sampler2D + a vec3[4]
 * iChannelResolution. We also bridge `iTimeDelta` / `iFrame` / `iFrameRate`.
 *
 * NOTE: the engine's shared vertex shader already declares `out vec2 vUv`, so
 * here we declare the matching `in vec2 vUv` and an `out vec4` for the result.
 * We do NOT redeclare `precision` — the wrapper prepends it once (see below).
 */
export const SHADERTOY_UNIFORM_BLOCK = `uniform vec3      iResolution;
uniform float     iTime;
uniform float     iTimeDelta;
uniform float     iFrameRate;
uniform int       iFrame;
uniform vec4      iMouse;
uniform vec4      iDate;
uniform sampler2D iChannel0;
uniform sampler2D iChannel1;
uniform sampler2D iChannel2;
uniform sampler2D iChannel3;
uniform vec3      iChannelResolution[4];`;

/** Number of Shadertoy iChannel sampler slots. */
export const SHADERTOY_CHANNELS = 4;

/**
 * Detect whether a GLSL source is written in the Shadertoy convention (defines
 * `void mainImage(out vec4 ..., in vec2 ...)`) rather than the engine's own
 * `void main(){ ... outColor ... }` convention. Used so the SAME content path
 * can host both hand-authored engine shaders and pasted Shadertoy shaders.
 *
 * Heuristic but robust: matches a `mainImage` function signature with an `out
 * vec4` first parameter. Whitespace-tolerant; ignores // line comments on the
 * signature line is unnecessary because the regex only needs the tokens.
 */
export function isShadertoySource(src: string): boolean {
  return /\bvoid\s+mainImage\s*\(\s*out\s+vec4\b/.test(src);
}

/**
 * Wrap a Shadertoy `mainImage` source into the engine's fullscreen-quad
 * `main()` convention, prepending the `#version`, a single `precision`
 * declaration, the engine varyings + the full Shadertoy uniform block, an
 * optional `common` chunk (shared GLSL prepended to every pass), and the body.
 *
 * The generated `main()` calls `mainImage(_fragColor, gl_FragCoord.xy)` — using
 * `gl_FragCoord` (the GL window-space pixel centre, bottom-origin) so the shader
 * sees Shadertoy's `fragCoord` semantics exactly (0..iResolution, y-up).
 *
 * Pure string transform: deterministic, no GL. The engine compiles the result.
 *
 * @param body     the pasted Shadertoy GLSL (its `mainImage` + helpers).
 * @param common   optional shared GLSL (the Shadertoy "Common" tab) prepended
 *                 ahead of the body so every pass sees the same helpers.
 * @param paramNames TOYBOX content's declared float-uniform names, emitted as
 *                 `uniform float <name>;` so a Shadertoy shader can read the
 *                 card faders (Shadertoy itself has no custom uniforms; this is
 *                 TOYBOX's content-param extension). Names colliding with a
 *                 Shadertoy uniform (iTime etc.) are skipped.
 * @param precision GLSL float precision (default highp — Shadertoy is highp).
 */
export function wrapShadertoySource(
  body: string,
  common = '',
  paramNames: string[] = [],
  precision: 'highp' | 'mediump' = 'highp',
): string {
  // If the source already has a #version line, strip it — we control the
  // version + precision header so the prepended uniforms/varyings are valid.
  const stripped = body.replace(/^\s*#version[^\n]*\n/, '');
  const commonStripped = common.replace(/^\s*#version[^\n]*\n/, '');
  const reserved = new Set([
    'iResolution', 'iTime', 'iTimeDelta', 'iFrameRate', 'iFrame', 'iMouse',
    'iDate', 'iChannel0', 'iChannel1', 'iChannel2', 'iChannel3', 'iChannelResolution',
  ]);
  const paramDecls = paramNames
    .filter((n) => /^[A-Za-z_]\w*$/.test(n) && !reserved.has(n))
    .map((n) => `uniform float ${n};`)
    .join('\n');
  return `#version 300 es
precision ${precision} float;
precision ${precision} int;
in vec2 vUv;
out vec4 _stFragColor;
${SHADERTOY_UNIFORM_BLOCK}
${paramDecls}

${commonStripped}

${stripped}

void main() {
  vec4 _c = vec4(0.0, 0.0, 0.0, 1.0);
  mainImage(_c, gl_FragCoord.xy);
  _stFragColor = _c;
}
`;
}

// ----------------------------------------------------------------------
// 2. iMouse pointer routing
// ----------------------------------------------------------------------

/**
 * The letterbox rectangle the preview canvas draws the engine framebuffer into
 * (computed by the card's `fitRect`). We invert it to map a client/canvas pixel
 * back into engine pixel space.
 */
export interface FitRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Map a pointer position from CANVAS (client, top-origin) pixels into ENGINE
 * (Shadertoy fragCoord, BOTTOM-origin) pixels, accounting for the letterbox
 * `rect` the engine frame is drawn into and the engine resolution.
 *
 * Returns null when the pointer is outside the letterboxed image area (so the
 * caller can ignore clicks on the black bars). PURE.
 *
 *   - x: 0..engineW, left→right (same as Shadertoy).
 *   - y: 0..engineH, BOTTOM→top (GL/Shadertoy fragCoord origin), so we flip the
 *        canvas's top-origin y.
 */
export function canvasToEnginePx(
  canvasX: number,
  canvasY: number,
  rect: FitRect,
  engineW: number,
  engineH: number,
): { x: number; y: number } | null {
  if (rect.w <= 0 || rect.h <= 0) return null;
  // Normalised position within the drawn image (0..1, top-origin).
  const nx = (canvasX - rect.x) / rect.w;
  const nyTop = (canvasY - rect.y) / rect.h;
  if (nx < 0 || nx > 1 || nyTop < 0 || nyTop > 1) return null;
  // Engine x is the same direction; engine y flips to bottom-origin.
  return {
    x: nx * engineW,
    y: (1 - nyTop) * engineH,
  };
}

/**
 * Shadertoy iMouse state. Per the official semantics:
 *   - .xy = current pixel position while the button is DOWN; on release it
 *           HOLDS the last position (does not reset).
 *   - .z  = the x pixel of the press; its SIGN is positive while the button is
 *           held and NEGATIVE once released (abs() recovers the press x).
 *   - .w  = the y pixel of the press; its SIGN is positive ONLY on the exact
 *           frame the button was pressed (the "click" frame), negative
 *           otherwise.
 *
 * We model that with a small state machine fed by pointer events. `pressFrame`
 * tracks whether THIS is the press frame so .w's sign can be set, then cleared.
 */
export interface MouseState {
  /** current x (engine px). */
  x: number;
  /** current y (engine px, bottom-origin). */
  y: number;
  /** press x (engine px). */
  pressX: number;
  /** press y (engine px, bottom-origin). */
  pressY: number;
  /** button currently held. */
  down: boolean;
  /** true only on the frame the button went down (consumed by toVec4). */
  clickedThisFrame: boolean;
}

/** A fresh, neutral mouse state (no interaction yet → iMouse all zero). */
export function makeMouseState(): MouseState {
  return { x: 0, y: 0, pressX: 0, pressY: 0, down: false, clickedThisFrame: false };
}

/** Apply a pointer-DOWN at engine pixel (x,y): start a press. */
export function mouseDown(s: MouseState, x: number, y: number): void {
  s.x = x;
  s.y = y;
  s.pressX = x;
  s.pressY = y;
  s.down = true;
  s.clickedThisFrame = true;
}

/** Apply a pointer-MOVE at engine pixel (x,y): track current position only
 *  while the button is held (Shadertoy ignores hover moves for .xy). */
export function mouseMove(s: MouseState, x: number, y: number): void {
  if (!s.down) return;
  s.x = x;
  s.y = y;
}

/** Apply a pointer-UP: release the press (keeps .xy at the last position). */
export function mouseUp(s: MouseState): void {
  s.down = false;
}

/**
 * Produce the iMouse vec4 [x, y, z, w] for the CURRENT frame and ADVANCE the
 * one-shot click flag (so .w's positive sign only lasts the press frame, exactly
 * like Shadertoy). Call this ONCE per pass-group per frame.
 *
 *   z = down ?  pressX : -pressX
 *   w = (down && clickedThisFrame) ?  pressY : -pressY
 *
 * Before any interaction (never pressed) iMouse is all zero.
 */
export function mouseToVec4(s: MouseState): [number, number, number, number] {
  const everPressed = s.pressX !== 0 || s.pressY !== 0 || s.down;
  if (!everPressed) return [0, 0, 0, 0];
  const z = s.down ? s.pressX : -s.pressX;
  const w = s.down && s.clickedThisFrame ? s.pressY : -s.pressY;
  // The click frame is consumed after one read.
  s.clickedThisFrame = false;
  return [s.x, s.y, z, w];
}

// ----------------------------------------------------------------------
// 3. Multi-buffer project model + pass topo-ordering + channel resolution
// ----------------------------------------------------------------------

/** A single iChannel binding for a pass. Discriminated union, all plain JSON
 *  (Yjs-safe). `buffer` samples another pass's output; `self` samples this
 *  pass's PREVIOUS frame (ping-pong feedback); `keyboard` is the stubbed
 *  keyboard texture; `scene` samples the composited layer below; `layer-input`
 *  samples the LAYER INPUT feedback tap (Phase 1: the module's prev-frame OUT
 *  composite — like `self`, a one-frame-late tap that is NOT a same-frame
 *  dependency, so it's excluded from the pass topo-order); `none` binds an inert
 *  dummy (the sampler stays defined). */
export type ShadertoyChannel =
  | { type: 'buffer'; pass: string }
  | { type: 'self' }
  | { type: 'keyboard' }
  | { type: 'scene' }
  | { type: 'layer-input' }
  | { type: 'none' };

/** One pass of a Shadertoy project. `id` is unique within the project; the
 *  Image pass has id 'image'. `float: true` requests an RGBA32F render target
 *  (createFloatFbo, precision 'full') for passes that pack data via
 *  intBitsToFloat / need signed-/out-of-[0,1] precision (e.g. a growable
 *  heightmap feedback buffer). */
export interface ShadertoyPass {
  /** Unique pass id ('image' for the final pass; 'bufferA'.. for buffers). */
  id: string;
  /** The pass's GLSL (`mainImage` + helpers). */
  src: string;
  /** iChannel0-3 bindings (length up to 4; missing slots → 'none'). */
  channels: ShadertoyChannel[];
  /** Request an RGBA32F float render target (precision packing / feedback). */
  float?: boolean;
}

/** A full Shadertoy project: an optional Common chunk + N passes. The pass with
 *  id 'image' is the final output; others are buffers. */
export interface ShadertoyProject {
  /** Shared GLSL prepended to EVERY pass (the Shadertoy "Common" tab). */
  common?: string;
  /** The passes, in any order — topoOrderPasses sorts producers first. */
  passes: ShadertoyPass[];
}

/** The id of the final (Image) pass. */
export const IMAGE_PASS_ID = 'image';

/**
 * Topologically order a project's passes so every producer runs BEFORE the
 * consumer that samples it via a `buffer` channel, with the Image pass forced
 * last. `self` (ping-pong feedback) channels are NOT dependencies — a pass
 * sampling its own previous frame can run in any order relative to itself.
 *
 * Cyclic buffer references (A→B→A, excluding self) are broken by emitting the
 * remaining nodes in declaration order (a soft fallback — Shadertoy itself
 * forbids non-self buffer cycles, so this only guards malformed input).
 *
 * Returns the ordered pass ids. PURE.
 */
export function topoOrderPasses(project: ShadertoyProject): string[] {
  const passes = project.passes;
  const ids = passes.map((p) => p.id);
  const idSet = new Set(ids);
  const byId = new Map(passes.map((p) => [p.id, p]));

  // Build dependency edges: pass → the passes it samples via `buffer`
  // (excluding self-references and unknown targets). The Image pass depends on
  // everything it samples too, then we force it last regardless.
  const deps = new Map<string, Set<string>>();
  for (const p of passes) deps.set(p.id, new Set());
  for (const p of passes) {
    for (const ch of p.channels) {
      if (ch.type === 'buffer' && ch.pass !== p.id && idSet.has(ch.pass)) {
        deps.get(p.id)!.add(ch.pass);
      }
    }
  }

  const ordered: string[] = [];
  const visited = new Set<string>();
  const onStack = new Set<string>();

  // DFS post-order = topo order (deps emitted before the consumer). Skip the
  // image pass in the main walk so it always lands last.
  const visit = (id: string): void => {
    if (visited.has(id) || id === IMAGE_PASS_ID) return;
    if (onStack.has(id)) return; // cycle guard — drop the back-edge
    onStack.add(id);
    for (const d of deps.get(id) ?? []) {
      if (d !== IMAGE_PASS_ID) visit(d);
    }
    onStack.delete(id);
    visited.add(id);
    ordered.push(id);
  };

  // Visit in declaration order for a stable result on ties.
  for (const id of ids) visit(id);

  // Any pass not yet emitted (shouldn't happen except for malformed cycles) →
  // append in declaration order so nothing is dropped.
  for (const id of ids) {
    if (!visited.has(id) && id !== IMAGE_PASS_ID) {
      visited.add(id);
      ordered.push(id);
    }
  }

  // Force the Image pass last (it consumes the buffers + renders the frame).
  if (byId.has(IMAGE_PASS_ID)) ordered.push(IMAGE_PASS_ID);

  return ordered;
}

/** Resolve a pass's 4 channel bindings to a fixed-length array, filling missing
 *  slots with `{type:'none'}`. PURE — the GL side maps each entry to a texture. */
export function resolveChannels(pass: ShadertoyPass): ShadertoyChannel[] {
  const out: ShadertoyChannel[] = [];
  for (let i = 0; i < SHADERTOY_CHANNELS; i++) {
    out.push(pass.channels[i] ?? { type: 'none' });
  }
  return out;
}

/** Type-guard: is `v` a structurally-valid ShadertoyProject? Used by the
 *  factory + card to decide whether a layer holds a multi-pass project (vs a
 *  single content shader). Tolerant of plain Y.Map-backed objects. */
export function isShadertoyProject(v: unknown): v is ShadertoyProject {
  if (!v || typeof v !== 'object') return false;
  const p = v as { passes?: unknown };
  if (!Array.isArray(p.passes) || p.passes.length === 0) return false;
  return p.passes.every(
    (x) =>
      x &&
      typeof x === 'object' &&
      typeof (x as ShadertoyPass).id === 'string' &&
      typeof (x as ShadertoyPass).src === 'string' &&
      Array.isArray((x as ShadertoyPass).channels),
  );
}

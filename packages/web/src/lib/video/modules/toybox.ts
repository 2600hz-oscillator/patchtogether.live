// packages/web/src/lib/video/modules/toybox.ts
//
// TOYBOX — swappable 4-layer video compositor (Phase 2).
//
// The foundation of a planned shader/video/OBJ compositor with an editable
// combine graph, CV targets, presets and a node editor. PHASE 1 shipped ONE
// renderable layer. PHASE 2 lights up all four layers + a combine stage:
//
//   - 4 LAYERS. Each `node.data.layers[i]` (kind shader|gen|video|off) is
//     resolved to a texture every frame:
//       · shader/gen → compile its bundled GLSL + fullscreen-quad into the
//         layer's own FBO (P1's renderLayer, generalized to i=0..3).
//       · video      → the texture is `frame.getInputTexture(id,'layer<i>_in')`
//         from the matching video INPUT port; null → black sentinel.
//       · off (+ obj, deferred to P3) → black sentinel.
//     So the combine stage always has 4 real textures.
//
//   - COMBINE STAGE. `node.data.combine` is a small data-driven graph (op
//     nodes + edges; see toybox-content.ts). P2 builds a FIXED default chain
//     in code when it's empty — fade(L0,L1) → map(screen, that, L2) →
//     lumakey(fg=L3, bg=that) → output — and topo-walks it (Kahn, the engine's
//     pattern). Each op runs ONE fullscreen pass into a small pool of scratch
//     FBOs (ping-pong); the output-connected texture is blitted to the
//     module's output FBO. Data-driven so P4 just swaps the default for an
//     editable graph.
//
// Combine-op math is ported VERBATIM from the standalone modules: fade =
// mix(A,B,t); lumakey = LUMAKEY.ts (~36-69); chromakey = CHROMAKEY.ts; map =
// selectable blend mode (screen/multiply/add/darken/lighten/difference/
// overlay) + mix amount.
//
// BACKWARDS-COMPAT: a P1-shaped node (only layer0 set, layers 1..3 off, no
// combine) renders layer0 straight to output, byte-identical to P1 — the
// factory short-circuits the combine when layers 1..3 are all off.
//
// Persistence: node.data.layers (LAYER_COUNT array of {kind,contentId,params})
// + node.data.combine (ToyboxCombine). The card mutates these directly (rides
// Y.Doc to rack-mates); the factory reads the LIVE node each frame so edits
// take effect without an engine round-trip.
//
// Inputs:  layer0_in..layer3_in (video) — feed the video-kind layers.
// Outputs: out (video) — the combined frame.

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface, VideoEngineContext } from '$lib/video/engine';
import { patch as livePatch } from '$lib/graph/store';
import {
  DEFAULT_CONTENT_ID,
  LAYER_COUNT,
  COMBINE_OP_DEFAULTS,
  ensureToyboxCatalog,
  getContent,
  getContentMeta,
  makeDefaultLayers,
  makeDefaultCombine,
  layerSourceId,
  type ToyboxLayer,
  type ToyboxCombine,
  type ToyboxCombineNode,
} from '$lib/video/toybox-content';

// ---------------- Combine-op fragment shaders ----------------
//
// Each op samples uA (primary) + uB (secondary). uHasA/uHasB flag whether the
// input is patched (black sentinel otherwise) — mirrors LUMAKEY/CHROMAKEY's
// half-patched tolerance so an empty branch isn't a black hole.

/** fade — mix(A, B, t). */
const FADE_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uA;
uniform sampler2D uB;
uniform float uT;
void main() {
  vec3 a = texture(uA, vUv).rgb;
  vec3 b = texture(uB, vUv).rgb;
  outColor = vec4(mix(a, b, clamp(uT, 0.0, 1.0)), 1.0);
}`;

/** lumakey — math ported verbatim from lumakey.ts (~36-69). A = foreground,
 *  B = background. */
const LUMAKEY_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uA; // fg
uniform sampler2D uB; // bg
uniform float uHasA;
uniform float uThreshold;
uniform float uSoftness;
uniform float uInvert;
void main() {
  vec3 fg = texture(uA, vUv).rgb;
  vec3 bg = texture(uB, vUv).rgb;
  if (uHasA < 0.5) { outColor = vec4(bg, 1.0); return; }
  float luma = dot(fg, vec3(0.299, 0.587, 0.114));
  float tol  = clamp(uThreshold, 0.0, 1.0);
  float soft = max(clamp(uSoftness, 0.0, 0.5), 0.001);
  float alpha = smoothstep(tol - soft, tol + soft, luma);
  if (uInvert > 0.5) alpha = 1.0 - alpha;
  outColor = vec4(mix(bg, fg, alpha), 1.0);
}`;

/** chromakey — math ported verbatim from chromakey.ts. A = foreground (keyed),
 *  B = background. */
const CHROMAKEY_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uA; // fg
uniform sampler2D uB; // bg
uniform float uHasA;
uniform float uKeyR;
uniform float uKeyG;
uniform float uKeyB;
uniform float uThreshold;
uniform float uSoftness;
uniform float uSpillSuppress;

vec3 rgbToHsv(vec3 c) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float v = mx;
  float d = mx - mn;
  float s = (mx > 0.0001) ? d / mx : 0.0;
  float h = 0.0;
  if (d > 0.0001) {
    if (mx == c.r) { h = (c.g - c.b) / d; if (h < 0.0) h += 6.0; }
    else if (mx == c.g) { h = (c.b - c.r) / d + 2.0; }
    else { h = (c.r - c.g) / d + 4.0; }
    h /= 6.0;
  }
  return vec3(h, s, v);
}
vec3 hsvToRgb(vec3 hsv) {
  float h = hsv.x;
  float s = clamp(hsv.y, 0.0, 1.0);
  float v = clamp(hsv.z, 0.0, 1.0);
  float h6 = h * 6.0;
  float c = v * s;
  float x = c * (1.0 - abs(mod(h6, 2.0) - 1.0));
  vec3 rgb;
  if      (h6 < 1.0) rgb = vec3(c, x, 0.0);
  else if (h6 < 2.0) rgb = vec3(x, c, 0.0);
  else if (h6 < 3.0) rgb = vec3(0.0, c, x);
  else if (h6 < 4.0) rgb = vec3(0.0, x, c);
  else if (h6 < 5.0) rgb = vec3(x, 0.0, c);
  else               rgb = vec3(c, 0.0, x);
  float m = v - c;
  return rgb + m;
}
float hueDistance(float a, float b) { float d = abs(a - b); return min(d, 1.0 - d); }

void main() {
  vec3 fg = texture(uA, vUv).rgb;
  vec3 bg = texture(uB, vUv).rgb;
  if (uHasA < 0.5) { outColor = vec4(bg, 1.0); return; }
  vec3 fgHSV  = rgbToHsv(fg);
  vec3 keyHSV = rgbToHsv(vec3(uKeyR, uKeyG, uKeyB));
  float hd = hueDistance(fgHSV.x, keyHSV.x);
  float satGate = smoothstep(0.04, 0.18, fgHSV.y);
  float tol  = clamp(uThreshold, 0.0, 1.0);
  float soft = max(clamp(uSoftness, 0.0, 0.5), 0.001);
  float tolH  = tol  * 0.5;
  float softH = soft * 0.5;
  float hueAlpha = smoothstep(tolH, tolH + softH, hd);
  float alpha = mix(1.0, hueAlpha, satGate);
  if (uSpillSuppress > 0.001) {
    float pull = (1.0 - alpha) * clamp(uSpillSuppress, 0.0, 1.0);
    fg = hsvToRgb(vec3(fgHSV.x, fgHSV.y * (1.0 - pull), fgHSV.z));
  }
  outColor = vec4(mix(bg, fg, alpha), 1.0);
}`;

/** map — selectable per-pixel blend operator + mix amount. uMode selects the
 *  blend (index into TOYBOX_BLEND_MODES); the blended result is mixed back
 *  toward A by uMix. Photoshop-standard blend formulas. */
const MAP_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uA;
uniform sampler2D uB;
uniform float uMode;
uniform float uMix;

vec3 blend(vec3 a, vec3 b, int mode) {
  if (mode == 0) return 1.0 - (1.0 - a) * (1.0 - b);      // screen
  if (mode == 1) return a * b;                            // multiply
  if (mode == 2) return min(a + b, vec3(1.0));            // add
  if (mode == 3) return min(a, b);                        // darken
  if (mode == 4) return max(a, b);                        // lighten
  if (mode == 5) return abs(a - b);                       // difference
  // overlay (mode 6)
  vec3 lo = 2.0 * a * b;
  vec3 hi = 1.0 - 2.0 * (1.0 - a) * (1.0 - b);
  vec3 sel = step(vec3(0.5), a);
  return mix(lo, hi, sel);
}

void main() {
  vec3 a = texture(uA, vUv).rgb;
  vec3 b = texture(uB, vUv).rgb;
  int mode = int(uMode + 0.5);
  vec3 blended = clamp(blend(a, b, mode), 0.0, 1.0);
  outColor = vec4(mix(a, blended, clamp(uMix, 0.0, 1.0)), 1.0);
}`;

/** Number of scratch FBOs in the ping-pong pool. The default chain needs at
 *  most 2 live op outputs at once; 3 leaves headroom for editor graphs. */
const SCRATCH_POOL = 3;

export const toyboxDef: VideoModuleDef = {
  type: 'toybox',
  palette: { top: 'Video modules', sub: 'Sources' },
  domain: 'video',
  label: 'TOYBOX',
  category: 'sources',
  schemaVersion: 1,
  // Four video INPUT ports feed the video-kind layers (layer<i> kind 'video'
  // samples layer<i>_in). They're optional: an unpatched / non-video layer
  // reads a black sentinel. No paramTarget — they're media inputs, not CV.
  inputs: [
    { id: 'layer0_in', type: 'video' },
    { id: 'layer1_in', type: 'video' },
    { id: 'layer2_in', type: 'video' },
    { id: 'layer3_in', type: 'video' },
  ],
  outputs: [
    { id: 'out', type: 'video' },
  ],
  // No numeric engine params — content + per-layer floats + combine-op params
  // all live in node.data (the card writes them, the factory reads the live
  // node). The empty params array keeps the per-port / docs sweeps happy.
  params: [],

  factory(ctx: VideoEngineContext, node): VideoNodeHandle {
    const gl = ctx.gl;
    const { fbo: outFbo, texture: outTex } = ctx.createFbo();

    void ensureToyboxCatalog();

    // ---- 1×1 black sentinel for off / unpatched layers ----
    const emptyTex = gl.createTexture();
    if (!emptyTex) throw new Error('TOYBOX: createTexture failed');
    gl.bindTexture(gl.TEXTURE_2D, emptyTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // ---- Per-layer FBOs (one per layer, allocated up front) ----
    const layerFbos: { fbo: WebGLFramebuffer; texture: WebGLTexture }[] = [];
    for (let i = 0; i < LAYER_COUNT; i++) layerFbos.push(ctx.createFbo());

    // ---- Scratch ping-pong pool for combine op passes ----
    const scratch: { fbo: WebGLFramebuffer; texture: WebGLTexture }[] = [];
    for (let i = 0; i < SCRATCH_POOL; i++) scratch.push(ctx.createFbo());

    // ---- Content compiled-program cache (keyed by contentId) ----
    interface CompiledShader {
      program: WebGLProgram;
      uTime: WebGLUniformLocation | null;
      uResolution: WebGLUniformLocation | null;
      uParams: Map<string, WebGLUniformLocation | null>;
    }
    const programs = new Map<string, CompiledShader>();
    const inflight = new Set<string>();
    const failed = new Set<string>();

    function ensureProgram(contentId: string): void {
      if (programs.has(contentId) || inflight.has(contentId) || failed.has(contentId)) return;
      inflight.add(contentId);
      void (async () => {
        try {
          const { meta, glsl } = await getContent(contentId);
          const program = ctx.compileFragment(glsl);
          const uParams = new Map<string, WebGLUniformLocation | null>();
          for (const p of meta.params) uParams.set(p.id, gl.getUniformLocation(program, p.id));
          programs.set(contentId, {
            program,
            uTime: gl.getUniformLocation(program, 'iTime'),
            uResolution: gl.getUniformLocation(program, 'iResolution'),
            uParams,
          });
        } catch (err) {
          failed.add(contentId);
          console.warn(`[TOYBOX] content '${contentId}' failed to compile:`, err);
        } finally {
          inflight.delete(contentId);
        }
      })();
    }
    ensureProgram(DEFAULT_CONTENT_ID);

    // ---- Combine-op programs (compiled once; uniform locations cached) ----
    type OpKey = 'fade' | 'lumakey' | 'chromakey' | 'map';
    interface CompiledOp {
      program: WebGLProgram;
      uA: WebGLUniformLocation | null;
      uB: WebGLUniformLocation | null;
      u: Map<string, WebGLUniformLocation | null>;
    }
    function compileOp(src: string, names: string[]): CompiledOp {
      const program = ctx.compileFragment(src);
      const u = new Map<string, WebGLUniformLocation | null>();
      for (const n of names) u.set(n, gl.getUniformLocation(program, n));
      return {
        program,
        uA: gl.getUniformLocation(program, 'uA'),
        uB: gl.getUniformLocation(program, 'uB'),
        u,
      };
    }
    const ops: Record<OpKey, CompiledOp> = {
      fade: compileOp(FADE_FRAG, ['uT']),
      lumakey: compileOp(LUMAKEY_FRAG, ['uHasA', 'uThreshold', 'uSoftness', 'uInvert']),
      chromakey: compileOp(CHROMAKEY_FRAG, [
        'uHasA', 'uKeyR', 'uKeyG', 'uKeyB', 'uThreshold', 'uSoftness', 'uSpillSuppress',
      ]),
      map: compileOp(MAP_FRAG, ['uMode', 'uMix']),
    };

    /** Resolve the live layer array for THIS node from the store. */
    function liveLayers(): ToyboxLayer[] {
      const live = livePatch.nodes[node.id];
      const raw =
        (live?.data?.layers as ToyboxLayer[] | undefined) ??
        (node.data?.layers as ToyboxLayer[] | undefined);
      if (!raw || raw.length === 0) return makeDefaultLayers();
      const out = raw.slice(0, LAYER_COUNT);
      while (out.length < LAYER_COUNT) out.push({ kind: 'off', contentId: null, params: {} });
      return out;
    }

    /** Resolve the live combine graph; empty → the fixed default chain. */
    function liveCombine(): ToyboxCombine {
      const live = livePatch.nodes[node.id];
      const raw =
        (live?.data?.combine as ToyboxCombine | undefined) ??
        (node.data?.combine as ToyboxCombine | undefined);
      if (!raw || !Array.isArray(raw.nodes) || raw.nodes.length === 0) return makeDefaultCombine();
      return raw;
    }

    /**
     * Render shader/gen layer `i` into its own FBO. Returns true if it drew
     * (program ready); false if the layer's program isn't compiled yet
     * (caller leaves the layer FBO cleared to black).
     */
    function renderShaderLayer(i: number, layer: ToyboxLayer, time: number): boolean {
      if (!layer.contentId) return false;
      const contentId = layer.contentId;
      ensureProgram(contentId);
      const compiled = programs.get(contentId);
      if (!compiled) return false;

      const g = gl;
      g.bindFramebuffer(g.FRAMEBUFFER, layerFbos[i]!.fbo);
      g.viewport(0, 0, ctx.res.width, ctx.res.height);
      g.clearColor(0, 0, 0, 1);
      g.clear(g.COLOR_BUFFER_BIT);
      g.useProgram(compiled.program);
      if (compiled.uTime) g.uniform1f(compiled.uTime, time);
      if (compiled.uResolution) g.uniform2f(compiled.uResolution, ctx.res.width, ctx.res.height);
      const meta = getContentMeta(contentId);
      if (meta) {
        for (const p of meta.params) {
          const loc = compiled.uParams.get(p.id);
          if (!loc) continue;
          const v = layer.params?.[p.id];
          g.uniform1f(loc, typeof v === 'number' ? v : p.default);
        }
      }
      ctx.drawFullscreenQuad();
      return true;
    }

    /**
     * Resolve the source texture for layer `i`:
     *   shader/gen → render into layerFbos[i], return its texture (or the
     *                black sentinel until the program compiles).
     *   video      → the layer<i>_in input texture (or sentinel if unpatched).
     *   off / obj  → the black sentinel.
     */
    function layerTexture(
      i: number,
      layer: ToyboxLayer,
      frame: { getInputTexture(nid: string, port: string): WebGLTexture | null },
      time: number,
    ): WebGLTexture {
      if (layer.kind === 'shader' || layer.kind === 'gen') {
        return renderShaderLayer(i, layer, time) ? layerFbos[i]!.texture : emptyTex;
      }
      if (layer.kind === 'video') {
        return frame.getInputTexture(node.id, `layer${i}_in`) ?? emptyTex;
      }
      // 'off' (and 'obj', deferred to P3) → black.
      return emptyTex;
    }

    /** Run one combine op pass into a scratch FBO; returns its texture. */
    function runOp(
      cnode: ToyboxCombineNode,
      texA: WebGLTexture,
      hasA: boolean,
      texB: WebGLTexture,
      scratchIdx: number,
    ): WebGLTexture {
      const opKey = (cnode.op ?? 'fade') as OpKey;
      const op = ops[opKey];
      const defaults = COMBINE_OP_DEFAULTS[opKey];
      const p = (id: string): number => {
        const v = cnode.params?.[id];
        return typeof v === 'number' ? v : (defaults[id] ?? 0);
      };

      const g = gl;
      const target = scratch[scratchIdx]!;
      g.bindFramebuffer(g.FRAMEBUFFER, target.fbo);
      g.viewport(0, 0, ctx.res.width, ctx.res.height);
      g.useProgram(op.program);
      g.activeTexture(g.TEXTURE0);
      g.bindTexture(g.TEXTURE_2D, texA);
      if (op.uA) g.uniform1i(op.uA, 0);
      g.activeTexture(g.TEXTURE1);
      g.bindTexture(g.TEXTURE_2D, texB);
      if (op.uB) g.uniform1i(op.uB, 1);

      const set = (name: string, val: number) => {
        const loc = op.u.get(name);
        if (loc) g.uniform1f(loc, val);
      };
      switch (opKey) {
        case 'fade':
          set('uT', p('t'));
          break;
        case 'lumakey':
          set('uHasA', hasA ? 1 : 0);
          set('uThreshold', p('threshold'));
          set('uSoftness', p('softness'));
          set('uInvert', p('invert'));
          break;
        case 'chromakey':
          set('uHasA', hasA ? 1 : 0);
          set('uKeyR', p('keyR'));
          set('uKeyG', p('keyG'));
          set('uKeyB', p('keyB'));
          set('uThreshold', p('tolerance'));
          set('uSoftness', p('softness'));
          set('uSpillSuppress', p('spillSuppress') || 0);
          break;
        case 'map':
          set('uMode', p('mode'));
          set('uMix', p('mix'));
          break;
      }
      ctx.drawFullscreenQuad();
      return target.texture;
    }

    /**
     * Topo-walk the combine graph (Kahn, mirroring engine.recomputeTopo) and
     * run each op into a scratch FBO. Returns the texture wired to the
     * 'output' node (or null if the graph has no valid output). `sources`
     * maps layerN ids + has-flags to the resolved layer textures.
     */
    function runCombine(
      combine: ToyboxCombine,
      sources: Map<string, { tex: WebGLTexture; has: boolean }>,
    ): { tex: WebGLTexture; has: boolean } | null {
      const nodeById = new Map(combine.nodes.map((n) => [n.id, n]));
      // Build adjacency over OP/OUTPUT nodes only (layer sources are leaves).
      const indeg = new Map<string, number>();
      const adj = new Map<string, string[]>();
      for (const n of combine.nodes) {
        indeg.set(n.id, 0);
        adj.set(n.id, []);
      }
      // Per-node resolved inlet textures.
      const inlets = new Map<string, { a?: { tex: WebGLTexture; has: boolean }; b?: { tex: WebGLTexture; has: boolean }; in?: { tex: WebGLTexture; has: boolean } }>();
      for (const n of combine.nodes) inlets.set(n.id, {});

      for (const e of combine.edges) {
        if (!nodeById.has(e.target)) continue;
        const slot = inlets.get(e.target)!;
        const src = sources.get(e.source);
        if (src) {
          // Layer source → leaf input, resolved immediately.
          if (e.inlet === 'a') slot.a = src;
          else if (e.inlet === 'b') slot.b = src;
          else slot.in = src;
        } else if (nodeById.has(e.source)) {
          // Edge from another op node → dependency for topo + resolved later.
          indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
          adj.get(e.source)!.push(e.target);
        }
      }

      // Kahn's algorithm (id-sorted ties for stability, like the engine).
      const q: string[] = [];
      for (const [id, n] of indeg) if (n === 0) q.push(id);
      q.sort();
      const order: string[] = [];
      while (q.length) {
        const id = q.shift()!;
        order.push(id);
        for (const nb of adj.get(id) ?? []) {
          indeg.set(nb, (indeg.get(nb) ?? 0) - 1);
          if (indeg.get(nb) === 0) {
            let i = 0;
            while (i < q.length && q[i]! < nb) i++;
            q.splice(i, 0, nb);
          }
        }
      }
      if (order.length !== combine.nodes.length) {
        console.warn('[TOYBOX] combine graph has a cycle; falling back to source0');
        return sources.get(layerSourceId(0)) ?? null;
      }

      const outputs = new Map<string, { tex: WebGLTexture; has: boolean }>();
      let scratchIdx = 0;
      const blackSrc = { tex: emptyTex, has: false };
      for (const id of order) {
        const cn = nodeById.get(id)!;
        const slot = inlets.get(id)!;
        // Resolve op-fed inlets from upstream op outputs.
        for (const e of combine.edges) {
          if (e.target !== id) continue;
          const upstream = outputs.get(e.source);
          if (!upstream) continue;
          if (e.inlet === 'a') slot.a = upstream;
          else if (e.inlet === 'b') slot.b = upstream;
          else slot.in = upstream;
        }
        if (cn.type === 'output') {
          outputs.set(id, slot.in ?? slot.a ?? blackSrc);
          continue;
        }
        const a = slot.a ?? blackSrc;
        const b = slot.b ?? blackSrc;
        const tex = runOp(cn, a.tex, a.has, b.tex, scratchIdx);
        outputs.set(id, { tex, has: true });
        scratchIdx = (scratchIdx + 1) % SCRATCH_POOL;
      }

      const outNode = combine.nodes.find((n) => n.type === 'output');
      if (!outNode) return null;
      return outputs.get(outNode.id) ?? null;
    }

    // Blit a texture into the output FBO (pass-through copy).
    const copyOp = compileOp(FADE_FRAG, ['uT']); // mix(a,a,0)=a → straight copy
    function blitToOutput(tex: WebGLTexture): void {
      const g = gl;
      g.bindFramebuffer(g.FRAMEBUFFER, outFbo);
      g.viewport(0, 0, ctx.res.width, ctx.res.height);
      g.useProgram(copyOp.program);
      g.activeTexture(g.TEXTURE0);
      g.bindTexture(g.TEXTURE_2D, tex);
      if (copyOp.uA) g.uniform1i(copyOp.uA, 0);
      g.activeTexture(g.TEXTURE1);
      g.bindTexture(g.TEXTURE_2D, tex);
      if (copyOp.uB) g.uniform1i(copyOp.uB, 1);
      const uT = copyOp.u.get('uT');
      if (uT) g.uniform1f(uT, 0.0);
      ctx.drawFullscreenQuad();
    }

    function frozenTime(): number | null {
      const g = globalThis as unknown as { __toyboxFreezeTime?: number | null };
      return typeof g.__toyboxFreezeTime === 'number' ? g.__toyboxFreezeTime : null;
    }

    const surface: VideoNodeSurface = {
      fbo: outFbo,
      texture: outTex,
      draw(frame) {
        const g = frame.gl;
        const time = frozenTime() ?? frame.time;
        const layers = liveLayers();

        // Resolve every layer to a texture (+ has-flag).
        const sources = new Map<string, { tex: WebGLTexture; has: boolean }>();
        for (let i = 0; i < LAYER_COUNT; i++) {
          const layer = layers[i]!;
          const tex = layerTexture(i, layer, frame, time);
          const has = tex !== emptyTex;
          sources.set(layerSourceId(i), { tex, has });
        }

        // BACKWARDS-COMPAT short-circuit: if layers 1..3 are all off/empty,
        // render layer0 straight to output (byte-identical to P1).
        const onlyLayer0 = layers.slice(1).every((l) => l.kind === 'off' || (!l.contentId && l.kind !== 'video'));
        if (onlyLayer0) {
          g.bindFramebuffer(g.FRAMEBUFFER, outFbo);
          g.viewport(0, 0, ctx.res.width, ctx.res.height);
          g.clearColor(0, 0, 0, 1);
          g.clear(g.COLOR_BUFFER_BIT);
          const src0 = sources.get(layerSourceId(0))!;
          if (src0.has) blitToOutput(src0.tex);
          g.bindFramebuffer(g.FRAMEBUFFER, null);
          return;
        }

        // Full combine path: topo-walk the graph, blit the output texture.
        const combine = liveCombine();
        const result = runCombine(combine, sources);

        g.bindFramebuffer(g.FRAMEBUFFER, outFbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.clearColor(0, 0, 0, 1);
        g.clear(g.COLOR_BUFFER_BIT);
        if (result && result.has) blitToOutput(result.tex);
        g.bindFramebuffer(g.FRAMEBUFFER, null);
      },
      dispose() {
        gl.deleteFramebuffer(outFbo);
        gl.deleteTexture(outTex);
        gl.deleteTexture(emptyTex);
        for (const l of layerFbos) { gl.deleteFramebuffer(l.fbo); gl.deleteTexture(l.texture); }
        for (const s of scratch) { gl.deleteFramebuffer(s.fbo); gl.deleteTexture(s.texture); }
        for (const c of programs.values()) gl.deleteProgram(c.program);
        programs.clear();
        for (const o of Object.values(ops)) gl.deleteProgram(o.program);
        gl.deleteProgram(copyOp.program);
      },
    };

    return {
      domain: 'video',
      surface,
      setParam() { /* no numeric engine params — see node.data */ },
      readParam() { return undefined; },
      read(key) {
        if (key === 'fboTexture') return surface.texture;
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};

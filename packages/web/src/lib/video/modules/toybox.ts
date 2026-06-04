// packages/web/src/lib/video/modules/toybox.ts
//
// TOYBOX — multi-layer video compositor (Phases 1-3).
//
// FOUR layers, each rendered into its OWN framebuffer, then reduced to the
// module output by a combine DAG. A layer's `kind` selects its source:
//   - 'shader' (FX) / 'gen' (GEN): a fragment-shader content entry from the
//     bundled MIT bank (toybox-content.ts; GLSL fetched lazily on selection,
//     never JS-bundled). Uniforms iTime / iResolution + the content's
//     declared float params.
//   - 'obj' (PHASE 3): a 3D mesh — a bundled CC0 OBJ (in-house parser,
//     obj-parse.ts) OR a built-in procedural primitive (primitives.ts:
//     cube/sphere/torus/hypercube). Matcap-shaded (the matcap is SYNTHESIZED
//     procedurally in-shader, zero asset surface) with depth testing into the
//     layer FBO; transform + matcap style + tint live in layer.material.
//   - 'video' / 'off': render nothing (reserved / explicitly empty).
//
// OBJ render discipline (mirrors RUTTETRA): the layer FBO gets a depth
// renderbuffer attached once at build (ctx.createFbo() is colour-only); the
// pass binds it, clears COLOR|DEPTH, enables DEPTH_TEST, draws the mesh via a
// VAO + interleaved VBO + IBO with drawElements(TRIANGLES, …, UNSIGNED_INT),
// then RESTORES GL state (disable DEPTH_TEST, unbind VAO) so the fullscreen-
// quad combine passes after it aren't corrupted.
//
// Combine: layer 0 is the base; each combine step blends one further layer's
// texture over the running accumulator (fade / lumakey / chromakey / map).
// The result lands in the module's output FBO (surface.texture).
//
// Persistence: node.data.layers (LAYER_COUNT array of ToyboxLayer) +
// node.data.combine (ToyboxCombine). The card mutates the live node (rides
// Y.Doc); the factory reads the live node each frame.
//
// Inputs:  cv1..cv8 (cv) — a FIXED pool of generic CV ports (Phase 5). Each is
//          routed to an addressed layer/combine/obj param via node.data.cvRoutes
//          and re-scaled to that param's range inside setParam (see
//          toybox-cv-routes.ts). The generic ports stay neutral-linear.
// Outputs: out (video) — the composited frame.

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface, VideoEngineContext } from '$lib/video/engine';
import { patch as livePatch } from '$lib/graph/store';
import {
  DEFAULT_CONTENT_ID,
  LAYER_COUNT,
  MATCAP_STYLES,
  ensureToyboxCatalog,
  getContent,
  getContentMeta,
  getModelMeta,
  getModelObj,
  makeDefaultLayers,
  makeDefaultObjMaterial,
  type ToyboxCombine,
  type ToyboxLayer,
  type ToyboxObjMaterial,
} from '$lib/video/toybox-content';
import {
  OP_SHADER_INDEX,
  isCombineGraph,
  makeDefaultCombineGraph,
  topoSort,
  type ToyboxCombineGraph,
  type ToyboxOpKind,
} from '$lib/video/toybox-combine-graph';
import {
  CV_PORT_IDS,
  isCvPortId,
  resolveRoute,
  scaleRoutedValue,
  type CvRouteTarget,
  type CvRoutes,
} from '$lib/video/toybox-cv-routes';
import { parseObj } from '$lib/video/obj-parse';
import { makePrimitive, type BuiltinPrimitive } from '$lib/video/primitives';
import type { Mesh } from '$lib/video/mesh';
import {
  MESH_FLOATS_PER_VERT,
  MESH_OFFSET_NORMAL,
  MESH_OFFSET_POS,
  MESH_OFFSET_UV,
  MESH_STRIDE_BYTES,
} from '$lib/video/mesh';
import {
  modelMatrix,
  multiply,
  normalMatrix,
  perspective,
  translation,
  type Mat4,
} from '$lib/video/mat4';

// ---------------- OBJ matcap shader (GLSL ES 300) ----------------
//
// Vertex: transform position by uMVP; pass the view-space (here: model-space,
// the camera is fixed) normal to the fragment. Fragment: synthesize a
// hemispheric matcap from the normal's xy and a style index, tint it.

const OBJ_VERT_SRC = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec2 aUv;
uniform mat4 uMVP;
uniform mat3 uNormalMat;
out vec3 vNormal;
out vec2 vUv;
void main() {
  vNormal = normalize(uNormalMat * aNormal);
  vUv = aUv;
  gl_Position = uMVP * vec4(aPos, 1.0);
}`;

const OBJ_FRAG_SRC = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec2 vUv;
out vec4 outColor;
uniform int uMatcap;     // style index 0..${MATCAP_STYLES - 1}
uniform vec3 uTint;

// Procedural hemispheric matcap. muv in [0,1]^2 from the (camera-space)
// normal; r = distance from the matcap centre (1 at the silhouette edge).
vec3 matcap(vec2 muv, int style) {
  vec2 c = muv * 2.0 - 1.0;       // [-1,1]
  float r = clamp(length(c), 0.0, 1.0);
  float rim = pow(r, 3.0);        // bright edge
  float core = 1.0 - r;           // bright centre
  // A fake top-left key light.
  float key = clamp(dot(normalize(vec3(c, 0.6)), normalize(vec3(-0.5, 0.6, 0.6))), 0.0, 1.0);
  key = pow(key, 2.0);
  if (style == 0) {
    // CHROME: cool steel with a hot specular pip + rim.
    vec3 base = mix(vec3(0.10, 0.12, 0.16), vec3(0.55, 0.62, 0.72), core);
    base += vec3(0.9) * pow(key, 6.0);          // specular
    base += vec3(0.25, 0.35, 0.5) * rim;        // cool rim
    return base;
  } else if (style == 1) {
    // CLAY: warm matte, soft shading, faint rim.
    vec3 base = mix(vec3(0.18, 0.10, 0.08), vec3(0.78, 0.52, 0.40), 0.3 + 0.7 * key);
    base += vec3(0.15, 0.10, 0.08) * rim;
    return base;
  } else {
    // NEON: dark body, electric edge glow + magenta/cyan ramp.
    vec3 inner = vec3(0.02, 0.0, 0.05);
    vec3 edge = mix(vec3(0.0, 1.0, 0.9), vec3(1.0, 0.1, 0.8), muv.x);
    vec3 base = mix(inner, edge, pow(r, 2.0));
    base += edge * pow(key, 3.0) * 0.6;
    return base;
  }
}

void main() {
  vec3 n = normalize(vNormal);
  // Map normal.xy → matcap uv (the canonical sphere-normal matcap lookup).
  vec2 muv = n.xy * 0.5 + 0.5;
  vec3 col = matcap(muv, uMatcap) * uTint;
  outColor = vec4(col, 1.0);
}`;

export const toyboxDef: VideoModuleDef = {
  type: 'toybox',
  palette: { top: 'Video modules', sub: 'Sources' },
  domain: 'video',
  label: 'TOYBOX',
  category: 'sources',
  schemaVersion: 1,
  // PHASE 5 — a FIXED pool of 8 generic CV input ports. A layer's shader (and
  // its uniforms) is chosen at runtime, so we can't declare a port per possible
  // uniform; instead the card routes each generic cv port to an addressed param
  // via node.data.cvRoutes, and setParam (below) resolves + RE-SCALES the value
  // to that param's range. Each port carries a neutral cvScale:{mode:'linear'}
  // hint but NO paramTarget — so the cv-bridge degrades to RAW passthrough
  // (buildCvBridgeMapping can't resolve a param named 'cvN') and hands setParam
  // the raw ±1 sample; TOYBOX does the per-target range scaling itself.
  inputs: CV_PORT_IDS.map((id) => ({
    id,
    type: 'cv' as const,
    cvScale: { mode: 'linear' as const },
  })),
  outputs: [
    { id: 'out', type: 'video' },
  ],
  params: [],

  factory(ctx: VideoEngineContext, node): VideoNodeHandle {
    const gl = ctx.gl;
    // The module's OUTPUT fbo (combine result + chainable `out` texture).
    const { fbo: outFbo, texture: outTexture } = ctx.createFbo();

    void ensureToyboxCatalog();

    // ---- Per-layer FBOs (one render target each; combine samples these) ----
    // Each gets a colour texture (from createFbo) + a depth renderbuffer
    // attached here (createFbo is colour-only) so OBJ layers can depth-test.
    interface LayerTarget {
      fbo: WebGLFramebuffer;
      texture: WebGLTexture;
      depth: WebGLRenderbuffer;
    }
    const layerTargets: LayerTarget[] = [];
    for (let i = 0; i < LAYER_COUNT; i++) {
      const { fbo, texture } = ctx.createFbo();
      const depth = gl.createRenderbuffer();
      if (!depth) throw new Error('TOYBOX: createRenderbuffer (depth) failed');
      gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, ctx.res.width, ctx.res.height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
      gl.bindRenderbuffer(gl.RENDERBUFFER, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      layerTargets.push({ fbo, texture, depth });
    }

    // ---------------- Fragment-shader content programs ----------------
    interface CompiledShader {
      program: WebGLProgram;
      uTime: WebGLUniformLocation | null;
      uResolution: WebGLUniformLocation | null;
      uParams: Map<string, WebGLUniformLocation | null>;
    }
    const programs = new Map<string, CompiledShader>();
    const inflightShader = new Set<string>();
    const failedShader = new Set<string>();

    function ensureProgram(contentId: string): void {
      if (programs.has(contentId) || inflightShader.has(contentId) || failedShader.has(contentId)) return;
      inflightShader.add(contentId);
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
          failedShader.add(contentId);
          console.warn(`[TOYBOX] content '${contentId}' failed to compile:`, err);
        } finally {
          inflightShader.delete(contentId);
        }
      })();
    }
    ensureProgram(DEFAULT_CONTENT_ID);

    // ---------------- OBJ mesh program + per-model GPU buffers ----------------
    const objProgram = compileObjProgram(gl);
    const uMVP = gl.getUniformLocation(objProgram, 'uMVP');
    const uNormalMat = gl.getUniformLocation(objProgram, 'uNormalMat');
    const uMatcap = gl.getUniformLocation(objProgram, 'uMatcap');
    const uTint = gl.getUniformLocation(objProgram, 'uTint');

    interface GpuMesh {
      vao: WebGLVertexArrayObject;
      vbo: WebGLBuffer;
      ibo: WebGLBuffer;
      indexCount: number;
      frameCenter: [number, number, number];
      frameScale: number;
    }
    const meshes = new Map<string, GpuMesh>();
    const inflightModel = new Set<string>();
    const failedModel = new Set<string>();

    /** Upload an interleaved mesh into a VAO+VBO+IBO. */
    function uploadMesh(
      mesh: Mesh & { frame: { center: [number, number, number]; scale: number } },
    ): GpuMesh {
      const vao = gl.createVertexArray();
      const vbo = gl.createBuffer();
      const ibo = gl.createBuffer();
      if (!vao || !vbo || !ibo) throw new Error('TOYBOX: OBJ buffer alloc failed');
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.interleaved, gl.STATIC_DRAW);
      // location 0 = pos(3), 1 = normal(3), 2 = uv(2).
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, MESH_STRIDE_BYTES, MESH_OFFSET_POS);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, MESH_STRIDE_BYTES, MESH_OFFSET_NORMAL);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 2, gl.FLOAT, false, MESH_STRIDE_BYTES, MESH_OFFSET_UV);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      return {
        vao,
        vbo,
        ibo,
        indexCount: mesh.indices.length,
        frameCenter: mesh.frame.center,
        frameScale: mesh.frame.scale,
      };
    }

    /** Ensure the GPU mesh for `modelId` is built. Built-in primitives are
     *  generated synchronously; bundled OBJs are fetched + parsed async. */
    function ensureMesh(modelId: string): void {
      if (meshes.has(modelId) || inflightModel.has(modelId) || failedModel.has(modelId)) return;
      const meta = getModelMeta(modelId);
      // Built-in primitive → synchronous (also handles the manifest-not-loaded
      // case if the id happens to be a known primitive name).
      const builtin =
        (meta?.builtin as BuiltinPrimitive | undefined) ??
        (['cube', 'sphere', 'torus', 'hypercube'].includes(modelId)
          ? (modelId as BuiltinPrimitive)
          : undefined);
      if (builtin) {
        try {
          meshes.set(modelId, uploadMesh(makePrimitive(builtin)));
        } catch (err) {
          failedModel.add(modelId);
          console.warn(`[TOYBOX] primitive '${modelId}' failed:`, err);
        }
        return;
      }
      // Bundled OBJ → async fetch + parse + upload.
      inflightModel.add(modelId);
      void (async () => {
        try {
          const { obj } = await getModelObj(modelId);
          const parsed = parseObj(obj);
          meshes.set(modelId, uploadMesh(parsed));
        } catch (err) {
          failedModel.add(modelId);
          console.warn(`[TOYBOX] model '${modelId}' failed to load:`, err);
        } finally {
          inflightModel.delete(modelId);
        }
      })();
    }

    // ---------------- Combine programs (one per op) ----------------
    const combineProgram = compileCombineProgram(gl);
    const cuBase = gl.getUniformLocation(combineProgram, 'uBase');
    const cuTop = gl.getUniformLocation(combineProgram, 'uTop');
    const cuOp = gl.getUniformLocation(combineProgram, 'uOp');
    const cuAmount = gl.getUniformLocation(combineProgram, 'uAmount');
    const cuSoft = gl.getUniformLocation(combineProgram, 'uSoft');
    const cuInvert = gl.getUniformLocation(combineProgram, 'uInvert');
    const cuKey = gl.getUniformLocation(combineProgram, 'uKey');
    const cuMode = gl.getUniformLocation(combineProgram, 'uMode');

    // Scratch FBO POOL for the combine pass. The legacy linear chain needs two
    // ping-pong targets; the Phase-4 GRAPH needs one target PER op node (each
    // op writes its result into its own scratch so downstream ops can sample
    // it). The pool grows on demand (an op node added in the editor can need a
    // fresh target) + every entry is freed in dispose().
    const scratchPool: { fbo: WebGLFramebuffer; texture: WebGLTexture }[] = [];
    function scratch(i: number): { fbo: WebGLFramebuffer; texture: WebGLTexture } {
      while (scratchPool.length <= i) scratchPool.push(ctx.createFbo());
      return scratchPool[i]!;
    }
    // Seed two (the linear-chain ping-pong minimum).
    const scratchA = scratch(0);
    const scratchB = scratch(1);

    // ---- live node helpers ----
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
    /** The live combine field — either the Phase-4 GRAPH ({nodes,edges}) or the
     *  legacy linear chain ({steps}). Falls back to the default GRAPH so a card
     *  that has never been edited still composites like the Phase-1..3 default. */
    function liveCombineRaw(): ToyboxCombineGraph | ToyboxCombine {
      const live = livePatch.nodes[node.id];
      const raw =
        (live?.data?.combine as unknown) ?? (node.data?.combine as unknown);
      if (isCombineGraph(raw)) return raw as ToyboxCombineGraph;
      if (raw && Array.isArray((raw as ToyboxCombine).steps)) return raw as ToyboxCombine;
      return makeDefaultCombineGraph();
    }

    /** The live cvRoutes map (Phase 5). Absent → no routes (all generic cv
     *  ports unrouted, their setParam writes ignored). */
    function liveCvRoutes(): CvRoutes {
      const live = livePatch.nodes[node.id];
      const raw =
        (live?.data?.cvRoutes as CvRoutes | undefined) ??
        (node.data?.cvRoutes as CvRoutes | undefined);
      return raw && typeof raw === 'object' ? raw : {};
    }

    function frozenTime(): number | null {
      const g = globalThis as unknown as { __toyboxFreezeTime?: number | null };
      return typeof g.__toyboxFreezeTime === 'number' ? g.__toyboxFreezeTime : null;
    }

    // ---- PHASE 5: per-port CV base (modulation centre) snapshot ----
    //
    // The cv-bridge writes setParam(cvN, raw) every frame with the raw ±1
    // sample. We re-scale that across the routed param's range CENTRED on the
    // param's CURRENT value — but if we centred on the live (already-CV-written)
    // value each frame it would drift away unboundedly. So, mirroring the audio
    // cv-bridge's bake-once-at-attach semantics, we SNAPSHOT the param's value
    // as the modulation centre the first time a (port → target/param) routing is
    // seen, and re-snapshot only when that routing CHANGES (different target,
    // param, or no route). The signature captures the routing identity.
    const cvBase = new Map<string, { sig: string; base: number }>();

    /** Apply a raw cv sample arriving on generic port `portId`: resolve its
     *  route against the LIVE layers/combine, re-scale across the target param's
     *  range (centred on the snapshot base), and write it into the live param. */
    function applyCvRoute(portId: string, raw: number): void {
      const routes = liveCvRoutes();
      const route = routes[portId] as CvRouteTarget | null | undefined;
      if (!route) {
        // Unrouted → drop any stale base snapshot + ignore (no-op).
        cvBase.delete(portId);
        return;
      }
      const layers = liveLayers();
      const combine = liveCombineRaw();
      const resolved = resolveRoute(route, layers, combine);
      if (!resolved) {
        cvBase.delete(portId);
        return;
      }
      // Snapshot / refresh the modulation centre when the routing identity
      // changes (so the sweep re-centres on the user's knob after a re-route).
      const sig = `${route.target}|${route.layer ?? ''}|${route.nodeId ?? ''}|${route.param}`;
      const prev = cvBase.get(portId);
      const base = prev && prev.sig === sig ? prev.base : resolved.current;
      if (!prev || prev.sig !== sig) cvBase.set(portId, { sig, base });
      resolved.apply(scaleRoutedValue(raw, base, resolved.min, resolved.max));
    }

    // ---- Fixed camera (perspective) for the OBJ pass. Looks down -Z at the
    //      origin from z=+3.2; the model is auto-framed to ~unit at the origin
    //      so any model fits. ----
    function projView(): Mat4 {
      const aspect = ctx.res.width / ctx.res.height;
      const proj = perspective((50 * Math.PI) / 180, aspect, 0.1, 100);
      const view = translation(0, 0, -3.2);
      return multiply(proj, view);
    }

    /**
     * Render an OBJ-kind layer into target FBO `i`. Returns true if it drew.
     * Restores GL state (DEPTH_TEST off, VAO unbound) so combine's fullscreen
     * quads are not corrupted.
     */
    function renderObjLayer(i: number, layer: ToyboxLayer, time: number): boolean {
      const mat: ToyboxObjMaterial = layer.material ?? makeDefaultObjMaterial();
      const modelId = mat.modelId;
      if (!modelId) return false;
      ensureMesh(modelId);
      const m = meshes.get(modelId);
      if (!m) return false; // still loading / failed → caller leaves it cleared

      const g = gl;
      const target = layerTargets[i]!;
      g.bindFramebuffer(g.FRAMEBUFFER, target.fbo);
      g.viewport(0, 0, ctx.res.width, ctx.res.height);
      g.clearColor(0, 0, 0, 0); // transparent → combine treats as "no content"
      g.clearDepth(1.0);
      g.clear(g.COLOR_BUFFER_BIT | g.DEPTH_BUFFER_BIT);
      g.enable(g.DEPTH_TEST);
      g.depthFunc(g.LEQUAL);

      // Model matrix: auto-frame (centre + fit) → user transform → spin.
      const spinY = mat.spin * time;
      // Center+fit baked into a translate(-center)*scale chain via modelMatrix
      // by pre-translating: build fit = scale(frameScale) then translate by
      // -center*frameScale, folded into the user transform.
      const userModel = modelMatrix(
        mat.rotX,
        mat.rotY + spinY,
        mat.rotZ,
        mat.scale * m.frameScale,
      );
      // Pre-center: shift the mesh so its bounds-centre lands at the origin
      // BEFORE the user transform. translation acts in model space (applied
      // first), so compose userModel · translate(-center).
      const preCenter = translation(-m.frameCenter[0], -m.frameCenter[1], -m.frameCenter[2]);
      const model = multiply(userModel, preCenter);
      const mvp = multiply(projView(), model);
      const nrm = normalMatrix(model);

      g.useProgram(objProgram);
      if (uMVP) g.uniformMatrix4fv(uMVP, false, mvp);
      if (uNormalMat) g.uniformMatrix3fv(uNormalMat, false, nrm);
      if (uMatcap) g.uniform1i(uMatcap, Math.max(0, Math.min(MATCAP_STYLES - 1, Math.round(mat.matcap))));
      if (uTint) g.uniform3f(uTint, mat.tintR, mat.tintG, mat.tintB);

      g.bindVertexArray(m.vao);
      g.drawElements(g.TRIANGLES, m.indexCount, g.UNSIGNED_INT, 0);

      // RESTORE GL state for the fullscreen-quad combine passes.
      g.bindVertexArray(null);
      g.disable(g.DEPTH_TEST);
      return true;
    }

    /** Render a fragment-shader (shader/gen) layer into target FBO `i`. */
    function renderShaderLayer(i: number, layer: ToyboxLayer, time: number): boolean {
      if (!layer.contentId) return false;
      ensureProgram(layer.contentId);
      const compiled = programs.get(layer.contentId);
      if (!compiled) return false;
      const g = gl;
      const target = layerTargets[i]!;
      g.bindFramebuffer(g.FRAMEBUFFER, target.fbo);
      g.viewport(0, 0, ctx.res.width, ctx.res.height);
      g.useProgram(compiled.program);
      if (compiled.uTime) g.uniform1f(compiled.uTime, time);
      if (compiled.uResolution) g.uniform2f(compiled.uResolution, ctx.res.width, ctx.res.height);
      const meta = getContentMeta(layer.contentId);
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

    /** Clear layer target `i` to transparent (empty layer). */
    function clearLayer(i: number): void {
      const g = gl;
      g.bindFramebuffer(g.FRAMEBUFFER, layerTargets[i]!.fbo);
      g.viewport(0, 0, ctx.res.width, ctx.res.height);
      g.clearColor(0, 0, 0, 0);
      g.clear(g.COLOR_BUFFER_BIT);
    }

    /** Render layer `i` into its FBO; returns whether it produced content. */
    function renderLayer(i: number, layers: ToyboxLayer[], time: number): boolean {
      const layer = layers[i];
      if (!layer) {
        clearLayer(i);
        return false;
      }
      let drew = false;
      if (layer.kind === 'obj') drew = renderObjLayer(i, layer, time);
      else if (layer.kind === 'shader' || layer.kind === 'gen') drew = renderShaderLayer(i, layer, time);
      // 'video' / 'off' → nothing.
      if (!drew) clearLayer(i);
      return drew;
    }

    /** Extra (op-dependent) combine params beyond `amount`. */
    interface CombineExtra {
      soft?: number;
      invert?: number;
      key?: number;
      mode?: number;
    }

    /** Run one combine step: blend `topTex` over `baseTex` into `dstFbo`. */
    function combineStep(
      baseTex: WebGLTexture,
      topTex: WebGLTexture,
      dstFbo: WebGLFramebuffer,
      op: number,
      amount: number,
      extra?: CombineExtra,
    ): void {
      const g = gl;
      g.bindFramebuffer(g.FRAMEBUFFER, dstFbo);
      g.viewport(0, 0, ctx.res.width, ctx.res.height);
      g.useProgram(combineProgram);
      g.activeTexture(g.TEXTURE0);
      g.bindTexture(g.TEXTURE_2D, baseTex);
      if (cuBase) g.uniform1i(cuBase, 0);
      g.activeTexture(g.TEXTURE1);
      g.bindTexture(g.TEXTURE_2D, topTex);
      if (cuTop) g.uniform1i(cuTop, 1);
      if (cuOp) g.uniform1i(cuOp, op);
      if (cuAmount) g.uniform1f(cuAmount, amount);
      if (cuSoft) g.uniform1f(cuSoft, extra?.soft ?? 0);
      if (cuInvert) g.uniform1f(cuInvert, extra?.invert ?? 0);
      // chromakey: default key colour 'green' (0.33) matches the prior shader.
      if (cuKey) g.uniform1f(cuKey, extra?.key ?? 0.33);
      if (cuMode) g.uniform1f(cuMode, extra?.mode ?? 0);
      ctx.drawFullscreenQuad();
      g.activeTexture(g.TEXTURE0);
    }

    const OP_INDEX: Record<string, number> = { fade: 0, lumakey: 1, chromakey: 2, map: 3 };

    /**
     * Evaluate the legacy LINEAR chain ({steps}) via ping-pong scratch, exactly
     * as Phases 1-3 did. Returns the accumulator texture (layer 0 base + folded
     * steps).
     */
    function evalLinear(combine: ToyboxCombine, produced: boolean[]): WebGLTexture {
      let accTex = layerTargets[0]!.texture;
      let scratchFront = scratchA;
      let scratchBack = scratchB;
      for (const step of combine.steps) {
        const li = step.layer;
        if (li < 1 || li >= LAYER_COUNT) continue;
        if (!produced[li]) continue; // empty layer → skip
        const op = OP_INDEX[step.op] ?? 0;
        combineStep(accTex, layerTargets[li]!.texture, scratchFront.fbo, op, step.amount);
        accTex = scratchFront.texture;
        const t = scratchFront; scratchFront = scratchBack; scratchBack = t;
      }
      return accTex;
    }

    /**
     * Evaluate the Phase-4 combine GRAPH ({nodes,edges}) and return the texture
     * feeding the OUTPUT node. Topo-sorts the DAG (Kahn), evaluates each op node
     * into its OWN scratch FBO (so downstream ops can sample it), and returns
     * the texture wired into the OUTPUT node's in0. An invalid graph (no OUTPUT,
     * or OUTPUT's input unwired / its upstream unresolved) returns null → the
     * caller renders BLACK. Never loops (topoSort drops cycle members).
     */
    function evalGraph(graph: ToyboxCombineGraph, produced: boolean[]): WebGLTexture | null {
      const { order } = topoSort(graph);
      // texForNode[id] = the texture each node OUTPUTS (sources → layer tex;
      // ops → their scratch result). undefined = unresolved (no/missing input).
      const texForNode = new Map<string, WebGLTexture | null>();
      // Assign a scratch slot to each op node (deterministic by topo order),
      // starting past the two reserved ping-pong slots so they don't collide
      // if some future caller mixes paths in one frame.
      let scratchSlot = 0;
      const opOf = (kind: string): number | null =>
        kind === 'fade' || kind === 'lumakey' || kind === 'chromakey' || kind === 'map'
          ? OP_SHADER_INDEX[kind as ToyboxOpKind]
          : null;

      for (const id of order) {
        const n = graph.nodes.find((x) => x.id === id);
        if (!n) continue;
        if (n.kind === 'source') {
          const li = typeof n.layer === 'number' ? n.layer : -1;
          // A source with no content → null (unwired/black downstream).
          texForNode.set(id, li >= 0 && li < LAYER_COUNT && produced[li] ? layerTargets[li]!.texture : null);
          continue;
        }
        if (n.kind === 'output') {
          // Resolved when step 3 copies; nothing to compute here.
          continue;
        }
        const op = opOf(n.kind);
        if (op === null) {
          texForNode.set(id, null);
          continue;
        }
        // Gather this op's two inputs from incoming edges.
        const inEdge = (port: string) => graph.edges.find((e) => e.to === id && e.toPort === port);
        const baseE = inEdge('in0');
        const topE = inEdge('in1');
        const baseTex = baseE ? texForNode.get(baseE.from) ?? null : null;
        const topTex = topE ? texForNode.get(topE.from) ?? null : null;
        // If neither input is wired, this op produces nothing (null).
        if (!baseTex && !topTex) {
          texForNode.set(id, null);
          continue;
        }
        // A missing base behaves as black; a missing top means "just the base".
        const slot = scratch(2 + scratchSlot++); // past the 2 ping-pong slots
        const p = n.params ?? {};
        const amount = typeof p.amount === 'number' ? p.amount : 1;
        const extra = { soft: p.soft, invert: p.invert, key: p.key, mode: p.mode };
        if (baseTex && !topTex) {
          // Top unwired → pass the base through (copy: fade at amount 0).
          combineStep(baseTex, baseTex, slot.fbo, 0, 0);
        } else if (!baseTex && topTex) {
          // Base unwired → the top IS the result (copy).
          combineStep(topTex, topTex, slot.fbo, 0, 0);
        } else {
          combineStep(baseTex!, topTex!, slot.fbo, op, amount, extra);
        }
        texForNode.set(id, slot.texture);
      }

      // The OUTPUT node's in0 edge tells us the final texture.
      const out = graph.nodes.find((x) => x.kind === 'output');
      if (!out) return null;
      const outE = graph.edges.find((e) => e.to === out.id && e.toPort === 'in0');
      if (!outE) return null;
      return texForNode.get(outE.from) ?? null;
    }

    const surface: VideoNodeSurface = {
      fbo: outFbo,
      texture: outTexture,
      draw(frame) {
        const g = frame.gl;
        const time = frozenTime() ?? frame.time;
        const layers = liveLayers();

        // 1) Render every layer into its own FBO.
        const produced: boolean[] = [];
        for (let i = 0; i < LAYER_COUNT; i++) produced[i] = renderLayer(i, layers, time);

        // 2) Combine: evaluate the live combine (Phase-4 GRAPH or legacy chain).
        const combine = liveCombineRaw();
        const accTex = isCombineGraph(combine)
          ? evalGraph(combine as ToyboxCombineGraph, produced)
          : evalLinear(combine as ToyboxCombine, produced);

        // 3) Copy the result into the OUTPUT fbo. A null result (invalid/
        //    disconnected output, or every source empty) → BLACK, never a crash.
        g.bindFramebuffer(g.FRAMEBUFFER, outFbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.clearColor(0, 0, 0, 1);
        g.clear(g.COLOR_BUFFER_BIT);
        if (accTex) {
          // op 0 (fade) at amount 0 = pure base → straight copy of accTex.
          combineStep(accTex, accTex, outFbo, 0, 0);
        }
        // else: leave the black clear (disconnected output renders black).

        g.bindFramebuffer(g.FRAMEBUFFER, null);
      },
      dispose() {
        gl.deleteFramebuffer(outFbo);
        gl.deleteTexture(outTexture);
        for (const t of layerTargets) {
          gl.deleteFramebuffer(t.fbo);
          gl.deleteTexture(t.texture);
          gl.deleteRenderbuffer(t.depth);
        }
        for (const s of scratchPool) {
          gl.deleteFramebuffer(s.fbo);
          gl.deleteTexture(s.texture);
        }
        scratchPool.length = 0;
        for (const c of programs.values()) gl.deleteProgram(c.program);
        programs.clear();
        gl.deleteProgram(objProgram);
        gl.deleteProgram(combineProgram);
        for (const m of meshes.values()) {
          gl.deleteVertexArray(m.vao);
          gl.deleteBuffer(m.vbo);
          gl.deleteBuffer(m.ibo);
        }
        meshes.clear();
      },
    };

    return {
      domain: 'video',
      surface,
      setParam(portId, value) {
        // PHASE 5: a generic cv pool port (cv1..cv8) → resolve its route +
        // re-scale into the addressed live layer/combine param. Any other
        // portId is ignored (TOYBOX has no numeric engine params — content /
        // material / combine all live in node.data).
        if (isCvPortId(portId)) applyCvRoute(portId, value);
      },
      readParam() { return undefined; },
      read(key) {
        if (key === 'fboTexture') return surface.texture;
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};

// ---------------- GLSL program compile helpers (raw, not the fullscreen
//                  fragment path — the OBJ pass needs its own vertex shader) -

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error('TOYBOX: createShader failed');
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`TOYBOX: shader compile failed: ${log}`);
  }
  return sh;
}

function linkProgram(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
  const program = gl.createProgram();
  if (!program) throw new Error('TOYBOX: createProgram failed');
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`TOYBOX: program link failed: ${log}`);
  }
  return program;
}

function compileObjProgram(gl: WebGL2RenderingContext): WebGLProgram {
  return linkProgram(gl, OBJ_VERT_SRC, OBJ_FRAG_SRC);
}

// Combine: a fullscreen-quad pass that blends two textures by op + amount.
// Uses the engine's fullscreen-quad attribute layout (location 0 = aPos in
// clip space) and derives vUv from it, so ctx.drawFullscreenQuad() drives it.
const COMBINE_VERT_SRC = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const COMBINE_FRAG_SRC = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uBase;
uniform sampler2D uTop;
uniform int uOp;        // 0 fade, 1 lumakey, 2 chromakey, 3 map
uniform float uAmount;  // op-dependent: fade.t / lumakey.thr / chromakey.tol / map.mix
uniform float uSoft;    // lumakey/chromakey edge softness (0 = hard)
uniform float uInvert;  // lumakey: >0.5 flips the keep test
uniform float uKey;     // chromakey: which colour to key (0 R .. 0.33 G .. 0.66 B)
uniform float uMode;    // map: 0 = multiply, 1 = screen

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

void main() {
  vec4 b = texture(uBase, vUv);
  vec4 t = texture(uTop, vUv);
  vec3 outc = b.rgb;
  float a = clamp(uAmount, 0.0, 1.0);
  float soft = max(0.0, uSoft);
  if (uOp == 0) {
    // FADE: alpha-aware crossfade by amount (premultiplied over base).
    float k = a * t.a;
    outc = mix(b.rgb, t.rgb, k);
  } else if (uOp == 1) {
    // LUMAKEY: keep top where its luma exceeds the threshold (= amount). SOFT
    // feathers the cut; INVERT flips it (keep BELOW the threshold instead).
    float l = luma(t.rgb);
    float keep = smoothstep(a - soft, a + soft + 0.0001, l);
    if (uInvert > 0.5) keep = 1.0 - keep;
    keep *= t.a;
    outc = mix(b.rgb, t.rgb, keep);
  } else if (uOp == 2) {
    // CHROMAKEY: drop top where it is near the KEY colour (R/G/B by uKey);
    // amount = tolerance, soft = edge feather.
    float chan = uKey < 0.25 ? (t.r - max(t.g, t.b))
               : uKey < 0.58 ? (t.g - max(t.r, t.b))
               :               (t.b - max(t.r, t.g));
    float key = 1.0 - smoothstep(a, a + soft + 0.001, chan);
    outc = mix(b.rgb, t.rgb, key * t.a);
  } else {
    // MAP: top modulates base (MULTIPLY or SCREEN by uMode), mixed by amount.
    vec3 m = uMode > 0.5
      ? (1.0 - (1.0 - b.rgb) * (1.0 - t.rgb))  // screen
      : b.rgb * t.rgb;                          // multiply
    outc = mix(b.rgb, m, a * t.a);
  }
  outColor = vec4(outc, 1.0);
}`;

function compileCombineProgram(gl: WebGL2RenderingContext): WebGLProgram {
  return linkProgram(gl, COMBINE_VERT_SRC, COMBINE_FRAG_SRC);
}

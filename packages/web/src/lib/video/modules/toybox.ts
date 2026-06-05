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
// Inputs:  cv1..cv6 (cv) — a FIXED pool of generic modulation ports (the
//          Structure-style 6-input section). Each accepts EITHER a CV or an
//          AUDIO source: the cross-domain bridge auto-detects the patched
//          source's type (engine.ts) — a cv source feeds its folded 0..1 sample
//          straight; an audio source is ENVELOPE-FOLLOWED (RMS over the analyser
//          window) to a 0..1 modulation value. Each port is routed to an
//          addressed layer/combine/obj param via node.data.cvRoutes, with a
//          per-input bipolar SCALE (attenuverter) + OFFSET; setParam applies
//          effectiveCvValue(signal, scale, offset, min, max) (see
//          toybox-cv-routes.ts / toybox-cv-math.ts). The card reads live per-
//          input values back via the `inputs` handle-extras bridge to drive the
//          always-on inline scopes.
// Outputs: out (video) — the composited frame.

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface, VideoEngineContext, VideoFrameContext } from '$lib/video/engine';
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
import { buildProjectorViewProj, projectorFromMaterial } from '$lib/video/toybox-projective';
import { createVideoFrameUploader } from '$lib/video/video-frame-upload';
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
  getCvInput,
  effectiveCvValue,
  foldCvToUnipolar,
  type CvRouteTarget,
  type CvRoutes,
  type CvInputs,
} from '$lib/video/toybox-cv-routes';
import { parseObj } from '$lib/video/obj-parse';
import { resolveRenderOrder } from '$lib/video/toybox-surface';
import {
  wrapShadertoySource,
  isShadertoySource,
  topoOrderPasses,
  resolveChannels,
  isShadertoyProject,
  SHADERTOY_CHANNELS,
  IMAGE_PASS_ID,
  type ShadertoyProject,
  type ShadertoyPass,
} from '$lib/video/toybox-shadertoy';
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
uniform mat4 uModel;       // model→world (for projective surface mapping)
uniform mat3 uNormalMat;
out vec3 vNormal;          // world-space normal (used for matcap + projective front-face)
out vec2 vUv;
out vec3 vWorldPos;        // world-space position (projective mapping)
void main() {
  vNormal = normalize(uNormalMat * aNormal);
  vUv = aUv;
  vec4 world = uModel * vec4(aPos, 1.0);
  vWorldPos = world.xyz;
  gl_Position = uMVP * vec4(aPos, 1.0);
}`;

const OBJ_FRAG_SRC = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec2 vUv;
in vec3 vWorldPos;
out vec4 outColor;
uniform int uMatcap;       // style index 0..${MATCAP_STYLES - 1}
uniform vec3 uTint;
uniform sampler2D uSurface; // another layer's rendered FBO (texmap)
uniform int uUseSurface;    // 1 = blend the sampled layer over the matcap
uniform float uSurfaceMix;  // 0..1 blend amount (1 = full texture replace)
uniform int uProjMode;      // 0 = UV-map the surface; 1 = PROJECTIVE
uniform mat4 uProjVP;       // projector view-projection (projective mode)
uniform vec3 uProjEye;      // projector eye world pos (projective front-face)

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
  vec3 mat = matcap(muv, uMatcap);

  vec3 outc = mat;
  if (uUseSurface == 1) {
    float mixAmt = clamp(uSurfaceMix, 0.0, 1.0);
    if (uProjMode == 1) {
      // PROJECTIVE: transform the world position into the projector's clip
      // space, divide by w, and sample the source there. Guards (no back-wrap,
      // no projection behind the projector, no spill outside the frustum) make
      // the projection fall back to the matcap rather than smearing.
      vec4 clip = uProjVP * vec4(vWorldPos, 1.0);
      if (clip.w > 1e-4) {
        vec3 ndc = clip.xyz / clip.w;          // [-1,1]
        vec2 ps = ndc.xy * 0.5 + 0.5;          // [0,1] texcoords
        // FRONT-FACING: the surface normal must point toward the projector,
        // else the image wraps onto the far side of the mesh.
        vec3 toProj = normalize(uProjEye - vWorldPos);
        bool front = dot(n, toProj) > 0.0;
        bool inFrustum = ps.x >= 0.0 && ps.x <= 1.0 && ps.y >= 0.0 && ps.y <= 1.0
                         && ndc.z >= -1.0 && ndc.z <= 1.0;
        if (front && inFrustum) {
          // Source FBO is GL top-origin; flip v to match the UV path.
          vec3 surf = texture(uSurface, vec2(ps.x, 1.0 - ps.y)).rgb;
          outc = mix(mat, surf, mixAmt);
        }
        // else: outside the projection cone / behind it → keep the matcap.
      }
    } else {
      // UV-map: sample the bound source-layer FBO by the mesh UV. OBJ v is
      // bottom-origin vs GL top-origin, so flip v.
      vec3 surf = texture(uSurface, vec2(vUv.x, 1.0 - vUv.y)).rgb;
      outc = mix(mat, surf, mixAmt);
    }
  }
  vec3 col = outc * uTint;
  outColor = vec4(col, 1.0);
}`;

/** Handle extras exposed via the TOYBOX node's `read('extras')` channel. The
 *  card drives per-layer image/video input through these — addressing a LAYER
 *  index because TOYBOX is one engine node hosting up to LAYER_COUNT input
 *  layers (vs PICTUREBOX/VIDEOBOX which are one module = one source). */
export interface ToyboxHandleExtras {
  /** Upload an ImageBitmap/HTMLImageElement into layer `i`'s source texture
   *  (PICTUREBOX-style). Pass null to clear it back to the idle pattern. */
  setLayerImage(i: number, bitmap: ImageBitmap | HTMLImageElement | null): void;
  /** Attach a card-owned <video> element to layer `i`'s frame-upload pump
   *  (VIDEOBOX-style). Pass null to detach. */
  attachLayerVideo(i: number, el: HTMLVideoElement | null): void;
}

/** One generic-input's live modulation snapshot, surfaced to the card's
 *  always-on inline scope via the batched `read('cvScope')` channel. */
export interface ToyboxScopeState {
  /** The post scale+offset value mapped into the routed param's [min,max] (so
   *  it normalizes EXACTLY like the param). When unrouted it falls back to the
   *  raw 0..1 norm so the scope still shows the OFFSET/signal level. */
  effective: number;
  /** The routed param's range (the scope normalizes `effective` against this).
   *  Defaults to 0..1 when there is no resolvable route. */
  min: number;
  max: number;
  /** The auto-detected source kind: 'cv' | 'gate' | 'audio' from the inbound
   *  edge's sourceType, or 'idle' when no cable is patched (so the scope is
   *  ALWAYS-ON, showing the OFFSET level when idle). */
  kind: 'cv' | 'gate' | 'audio' | 'idle';
  /** A short rolling window of the most-recent audio time-domain samples
   *  (−1..+1), present only for an AUDIO source — the scope draws it as a
   *  raw-waveform overlay under the modulation trace. Absent for cv/gate/idle. */
  wave?: Float32Array;
}

/** The batched cvScope snapshot the card reads ONCE per rAF: one entry per
 *  generic input port id (cv1..cv6). */
export type ToyboxScopeSnapshot = Record<string, ToyboxScopeState>;

export const toyboxDef: VideoModuleDef = {
  type: 'toybox',
  palette: { top: 'Video modules', sub: 'Sources' },
  domain: 'video',
  label: 'TOYBOX',
  category: 'sources',
  schemaVersion: 2,
  migrate: migrateToyboxData,
  // A FIXED pool of 6 generic modulation input ports (the Structure-style
  // section). A layer's shader (and its uniforms) is chosen at runtime, so we
  // can't declare a port per possible uniform; instead the card routes each
  // port to an addressed param via node.data.cvRoutes (with a per-input SCALE +
  // OFFSET), and setParam (below) resolves + applies effectiveCvValue.
  //
  // Each port is typed `cv` but ACCEPTS BOTH cv AND audio sources: canConnect
  // permits audio→cv, and the audio engine's cross-domain dispatch sends an
  // audio-sourceType edge through the SAME sample-and-hold cv-bridge — which
  // auto-detects the source kind and envelope-follows audio. The neutral
  // cvScale:{mode:'linear'} hint + NO paramTarget keep the bridge in RAW
  // passthrough (it hands setParam the raw signal); TOYBOX shapes it itself.
  inputs: CV_PORT_IDS.map((id) => ({
    id,
    // `modsignal` accepts cv, gate, OR audio (canConnect scopes audio→non-audio
    // to this type only). The port IDs stay cv1..cv6 (so isCvPortId / setParam /
    // presets / cvRoutes are untouched); only the cable TYPE widens.
    type: 'modsignal' as const,
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

    // A tiny 1×1 placeholder texture for the OBJ surface sampler when a layer
    // has NO surface source. We must bind SOME texture (the sampler is always
    // declared), but binding the layer's OWN FBO colour texture while rendering
    // into that FBO is a WebGL feedback loop (undefined → black/incomplete on
    // many drivers), so we bind this inert dummy instead. uUseSurface=0 means
    // the shader never samples it; it only keeps the sampler state defined.
    const dummyTex = gl.createTexture();
    if (!dummyTex) throw new Error('TOYBOX: createTexture (dummy surface) failed');
    gl.bindTexture(gl.TEXTURE_2D, dummyTex);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 255]),
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindTexture(gl.TEXTURE_2D, null);

    // ---------------- Fragment-shader content programs ----------------
    //
    // A content program is EITHER a hand-authored engine shader (plain `main()`
    // + iTime/iResolution-as-vec2 + its declared float params) OR a SHADERTOY
    // shader (`void mainImage(out vec4, in vec2)` — wrapped by the mainImage→main
    // shim + the FULL Shadertoy uniform set, with iResolution as a vec3). We grab
    // the full Shadertoy uniform locations for every program; on a non-shadertoy
    // shader the extra ones simply resolve null (harmless).
    const stUni = collectShadertoyUniformGetters(gl);
    interface CompiledShader {
      program: WebGLProgram;
      /** True when the source was wrapped through the Shadertoy mainImage shim
       *  (iResolution is a vec3 + the full uniform set is live). */
      shadertoy: boolean;
      /** Receives the composited layers below as iChannel0 (FRAG family). */
      sceneInput: boolean;
      uTime: WebGLUniformLocation | null;
      uResolution: WebGLUniformLocation | null;
      uTimeDelta: WebGLUniformLocation | null;
      uFrameRate: WebGLUniformLocation | null;
      uFrame: WebGLUniformLocation | null;
      uMouse: WebGLUniformLocation | null;
      uDate: WebGLUniformLocation | null;
      uChannel: Array<WebGLUniformLocation | null>;
      uChannelRes: WebGLUniformLocation | null;
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
          // A content is Shadertoy if the manifest flags it OR the source uses
          // the mainImage convention. Wrap it through the shim; engine shaders
          // (plain main) compile as-is.
          const isSt = meta.shadertoy === true || isShadertoySource(glsl);
          const src = isSt
            ? wrapShadertoySource(glsl, '', meta.params.map((p) => p.id))
            : glsl;
          const program = ctx.compileFragment(src);
          const uParams = new Map<string, WebGLUniformLocation | null>();
          for (const p of meta.params) uParams.set(p.id, gl.getUniformLocation(program, p.id));
          const u = stUni(program);
          programs.set(contentId, {
            program,
            shadertoy: isSt,
            sceneInput: meta.input === 'scene',
            uTime: gl.getUniformLocation(program, 'iTime'),
            uResolution: gl.getUniformLocation(program, 'iResolution'),
            uTimeDelta: u.uTimeDelta,
            uFrameRate: u.uFrameRate,
            uFrame: u.uFrame,
            uMouse: u.uMouse,
            uDate: u.uDate,
            uChannel: u.uChannel,
            uChannelRes: u.uChannelRes,
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

    // ---------------- Shadertoy multi-buffer runtime ----------------
    // A 'frag'/'gen' layer can host a multi-pass PROJECT (Common + buffer passes
    // + an Image pass with iChannelN wiring). Each pass owns its own FBO(s); the
    // runtime topo-orders producers before consumers, ping-pongs feedback passes
    // (a `self` channel = the pass's PREVIOUS-frame texture), binds iChannel0-3 +
    // iChannelResolution per pass, and renders the Image pass last into the
    // layer's FBO. Float passes use createFloatFbo (RGBA32F → intBitsToFloat
    // packing) and degrade to RGBA8 when the GPU can't render float.
    const shadertoyRt = makeShadertoyRuntime(ctx, stUni, dummyTex, node.id);

    // ---------------- OBJ mesh program + per-model GPU buffers ----------------
    const objProgram = compileObjProgram(gl);
    const uMVP = gl.getUniformLocation(objProgram, 'uMVP');
    const uModel = gl.getUniformLocation(objProgram, 'uModel');
    const uNormalMat = gl.getUniformLocation(objProgram, 'uNormalMat');
    const uMatcap = gl.getUniformLocation(objProgram, 'uMatcap');
    const uTint = gl.getUniformLocation(objProgram, 'uTint');
    const uSurface = gl.getUniformLocation(objProgram, 'uSurface');
    const uUseSurface = gl.getUniformLocation(objProgram, 'uUseSurface');
    const uSurfaceMix = gl.getUniformLocation(objProgram, 'uSurfaceMix');
    const uProjMode = gl.getUniformLocation(objProgram, 'uProjMode');
    const uProjVP = gl.getUniformLocation(objProgram, 'uProjVP');
    const uProjEye = gl.getUniformLocation(objProgram, 'uProjEye');

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
        ((
          [
            'cube', 'sphere', 'torus', 'hypercube',
            'tetrahedron', 'octahedron', 'icosahedron',
            'cylinder', 'cone', 'torus-knot',
          ] as const
        ).includes(modelId as BuiltinPrimitive)
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

    // ---------------- Input-source (image / video) program ----------------
    // A fullscreen-quad passthrough that samples a source texture into the layer
    // FBO. When no source is present it paints the same dark-teal idle pattern as
    // PICTUREBOX/VIDEOBOX so an empty input layer reads as "alive but empty".
    // Re-implements the VIDEOBOX/PICTUREBOX sample path INSIDE toybox (this IS
    // toybox work — toybox owns its layer render factory).
    const inputProgram = compileInputProgram(gl);
    const iuTex = gl.getUniformLocation(inputProgram, 'uTex');
    const iuHasInput = gl.getUniformLocation(inputProgram, 'uHasInput');
    const iuGain = gl.getUniformLocation(inputProgram, 'uGain');

    // Per-layer IMAGE source textures (PICTUREBOX-style: the card uploads an
    // ImageBitmap via the layer extras → texImage2D here). Lazily created.
    interface ImageSource {
      tex: WebGLTexture;
      hasImage: boolean;
    }
    const imageSources = new Map<number, ImageSource>();
    function ensureImageSource(i: number): ImageSource {
      let src = imageSources.get(i);
      if (!src) {
        const tex = gl.createTexture();
        if (!tex) throw new Error('TOYBOX: createTexture (layer image) failed');
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
          new Uint8Array([0, 0, 0, 255]));
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.bindTexture(gl.TEXTURE_2D, null);
        src = { tex, hasImage: false };
        imageSources.set(i, src);
      }
      return src;
    }
    /** Upload an ImageBitmap/HTMLImageElement into layer `i`'s source texture
     *  (or clear it when null). Driven by the card via the layer extras. */
    function setLayerImage(i: number, bitmap: ImageBitmap | HTMLImageElement | null): void {
      const idx = Math.trunc(i);
      if (idx < 0 || idx >= LAYER_COUNT) return;
      const src = ensureImageSource(idx);
      if (!bitmap) {
        src.hasImage = false;
        return;
      }
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      src.hasImage = true;
    }

    // Per-layer VIDEO frame uploaders (VIDEOBOX-style rVFC-driven pump). The
    // card attaches its own card-owned <video> element per video layer.
    const videoUploaders = new Map<number, ReturnType<typeof createVideoFrameUploader>>();
    function ensureVideoUploader(i: number): ReturnType<typeof createVideoFrameUploader> {
      let up = videoUploaders.get(i);
      if (!up) {
        up = createVideoFrameUploader({ gl, width: ctx.res.width, height: ctx.res.height });
        videoUploaders.set(i, up);
      }
      return up;
    }
    /** Attach (or detach with null) a card-owned <video> element to layer `i`. */
    function attachLayerVideo(i: number, el: HTMLVideoElement | null): void {
      const idx = Math.trunc(i);
      if (idx < 0 || idx >= LAYER_COUNT) return;
      const up = ensureVideoUploader(idx);
      if (el) up.attach(el);
      else up.detach();
    }

    // Handle extras — the card drives per-layer image/video uploads through
    // these (read('extras')). The factory stays DOM-free (testable in jsdom);
    // the card owns the file picker / ImageBitmap decode / <video> element and
    // hands the result here, addressing a specific LAYER index (TOYBOX is ONE
    // engine node with up to LAYER_COUNT input layers, so the per-module
    // PICTUREBOX/VIDEOBOX setImage/attach pattern is generalised with an index).
    const extras: ToyboxHandleExtras = {
      setLayerImage,
      attachLayerVideo,
    };

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

    /** The live per-input scale/offset map (cvInputs). Absent → all defaults
     *  (scale +1, offset 0 → a fresh cable modulates immediately). */
    function liveCvInputs(): CvInputs {
      const live = livePatch.nodes[node.id];
      const raw =
        (live?.data?.cvInputs as CvInputs | undefined) ??
        (node.data?.cvInputs as CvInputs | undefined);
      return raw && typeof raw === 'object' ? raw : {};
    }

    function frozenTime(): number | null {
      const g = globalThis as unknown as { __toyboxFreezeTime?: number | null };
      return typeof g.__toyboxFreezeTime === 'number' ? g.__toyboxFreezeTime : null;
    }

    // ---- Per-input modulation state (drives the always-on inline scopes) ----
    //
    // setParam(cvN, signal) lands here each frame via the cross-domain bridge
    // (the bridge folds nothing — cv/gate arrive as the raw ±1/0..1 sample,
    // audio arrives already-0..1 from followEnvelope; we detect which by the
    // inbound edge's sourceType). We DON'T snapshot a modulation centre anymore:
    // the value written = effectiveCvValue(unipolarSignal, scale, offset, min,
    // max), a pure function of the live signal + the input's scale/offset, so
    // there is no drift to defend against (the cvBase snapshot is gone).
    const SCOPE_WAVE_LEN = 64;
    interface InputRuntime {
      /** Latest unipolar 0..1 signal (folded cv / audio envelope / 0). */
      signal: number;
      /** Latest audio time-domain window (−1..+1), only for audio sources. */
      wave: Float32Array | null;
    }
    const inputRuntime = new Map<string, InputRuntime>();
    function runtimeFor(portId: string): InputRuntime {
      let r = inputRuntime.get(portId);
      if (!r) { r = { signal: 0, wave: null }; inputRuntime.set(portId, r); }
      return r;
    }

    /** The inbound edge driving `portId` (a cable into this TOYBOX node's port),
     *  or undefined when unpatched. Read off the LIVE patch each call (the card
     *  draws/redraws cables off the same store). */
    function inboundEdge(portId: string): { sourceType?: string } | undefined {
      const edges = livePatch.edges;
      if (!edges) return undefined;
      for (const id of Object.keys(edges)) {
        const e = edges[id];
        if (e && e.target?.nodeId === node.id && e.target?.portId === portId) return e;
      }
      return undefined;
    }

    /** The auto-detected source kind for a port (from the inbound edge's
     *  sourceType), or 'idle' when no cable is patched. */
    function kindFor(portId: string): ToyboxScopeState['kind'] {
      const e = inboundEdge(portId);
      const st = e?.sourceType;
      if (st === 'audio') return 'audio';
      if (st === 'gate') return 'gate';
      if (st === 'cv' || st === 'pitch') return 'cv';
      return 'idle';
    }

    /**
     * Apply a signal arriving on generic port `portId` via the cv-bridge: fold
     * it to the unipolar 0..1 convention (cv/gate fold, audio is already 0..1),
     * resolve the route against the LIVE layers/combine, then write
     * effectiveCvValue(signal, scale, offset, min, max). A no-op (but still
     * records the signal for the scope) when unrouted/unresolvable.
     */
    function applyCvRoute(portId: string, raw: number): void {
      const kind = kindFor(portId);
      // audio → already a 0..1 envelope; cv/gate (and idle 'idle' samples) fold.
      const signal = kind === 'audio' ? Math.max(0, Math.min(1, raw)) : foldCvToUnipolar(raw);
      runtimeFor(portId).signal = signal;
      const route = liveCvRoutes()[portId] as CvRouteTarget | null | undefined;
      if (!route) return; // unrouted: the signal is recorded for the scope only
      const resolved = resolveRoute(route, liveLayers(), liveCombineRaw());
      if (!resolved) return;
      const { scale, offset } = getCvInput(liveCvInputs(), portId);
      resolved.apply(effectiveCvValue(signal, scale, offset, resolved.min, resolved.max));
    }

    /**
     * Record the latest audio time-domain window for a port (for the scope's
     * raw-waveform overlay). Called by the engine's audio cv-bridge only; cv/gate
     * bridges never call it (the runtime.wave stays null → no overlay).
     */
    function setParamWave(portId: string, window: Float32Array): void {
      if (!isCvPortId(portId)) return;
      const r = runtimeFor(portId);
      // Downsample into a fixed-length ring so the card draws a stable width.
      let buf = r.wave;
      if (!buf || buf.length !== SCOPE_WAVE_LEN) buf = new Float32Array(SCOPE_WAVE_LEN);
      const step = window.length > 0 ? window.length / SCOPE_WAVE_LEN : 0;
      for (let i = 0; i < SCOPE_WAVE_LEN; i++) {
        buf[i] = window[Math.min(window.length - 1, Math.floor(i * step))] ?? 0;
      }
      r.wave = buf;
    }

    /**
     * For every ROUTED port that has NO inbound cable, write the OFFSET-as-manual
     * value (signal 0) into its param: min + clamp01(offset)*(max-min). When a
     * cable IS patched the bridge's setParam owns the write, so we skip it (and
     * also clear any stale audio wave). Called at the TOP of surface.draw.
     */
    function applyUnpatchedOffsets(): void {
      const routes = liveCvRoutes();
      const inputs = liveCvInputs();
      for (const portId of CV_PORT_IDS) {
        const route = routes[portId] as CvRouteTarget | null | undefined;
        const patched = !!inboundEdge(portId);
        if (patched) continue; // the cv-bridge owns the write this frame
        // No cable: keep the scope/runtime in the "idle, signal 0" state so the
        // scope shows the OFFSET level, and clear any leftover audio wave.
        const r = runtimeFor(portId);
        r.signal = 0;
        r.wave = null;
        if (!route) continue;
        // OFFSET-as-manual is OPT-IN: only take over the param when the user has
        // dialed an explicit cvInputs entry for this port. Until then a routed-
        // but-unpatched port leaves the param at its AUTHORED value (so a preset
        // that routes a port without setting scale/offset keeps its seeded combine
        // /layer value, instead of being forced to OFFSET-default 0 = param min).
        const entry = inputs[portId];
        if (!entry || typeof entry !== 'object') continue;
        const resolved = resolveRoute(route, liveLayers(), liveCombineRaw());
        if (!resolved) continue;
        const { scale, offset } = getCvInput(inputs, portId);
        // signal 0 → norm = clamp01(offset); scale only matters for a live signal.
        resolved.apply(effectiveCvValue(0, scale, offset, resolved.min, resolved.max));
      }
    }

    /** Build the batched cvScope snapshot the card reads ONCE per rAF. Each
     *  port: effective = the post scale+offset value mapped into the param's
     *  [min,max] (or the raw norm over 0..1 when unrouted), kind, and the audio
     *  wave overlay when present. */
    function readCvScope(): ToyboxScopeSnapshot {
      const routes = liveCvRoutes();
      const inputs = liveCvInputs();
      const layers = liveLayers();
      const combine = liveCombineRaw();
      const out: ToyboxScopeSnapshot = {};
      for (const portId of CV_PORT_IDS) {
        const r = runtimeFor(portId);
        const { scale, offset } = getCvInput(inputs, portId);
        const route = routes[portId] as CvRouteTarget | null | undefined;
        const resolved = route ? resolveRoute(route, layers, combine) : null;
        const min = resolved?.min ?? 0;
        const max = resolved?.max ?? 1;
        const effective = effectiveCvValue(r.signal, scale, offset, min, max);
        const kind = kindFor(portId);
        out[portId] = {
          effective,
          min,
          max,
          kind,
          ...(kind === 'audio' && r.wave ? { wave: r.wave } : {}),
        };
      }
      return out;
    }

    // ---- Fixed camera (perspective) for the OBJ pass. Looks down -Z at the
    //      origin from z=+3.2; the model is auto-framed to ~unit at the origin
    //      so any model fits. ----
    // The render camera's eye + look direction in WORLD space (view =
    // translation(0,0,-3.2) ⇒ eye at +z, looking down -Z). Shared with the
    // projective surface mode's "use camera" option so the projector can ride
    // the render viewpoint.
    const CAMERA_EYE: [number, number, number] = [0, 0, 3.2];
    const CAMERA_DIR: [number, number, number] = [0, 0, -1];
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
     *
     * `safeSource` (resolved per-frame in draw()) is the layer index whose
     * already-rendered FBO is SAFE to UV-map onto this mesh as a surface
     * texture, or -1 = matcap-only. It is guaranteed (by resolveRenderOrder) to
     * be in-range, non-self, non-cyclic, and rendered BEFORE this layer this
     * frame — so binding it can never create a WebGL feedback loop.
     */
    function renderObjLayer(i: number, layer: ToyboxLayer, time: number, safeSource: number): boolean {
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
      if (uModel) g.uniformMatrix4fv(uModel, false, model);
      if (uNormalMat) g.uniformMatrix3fv(uNormalMat, false, nrm);
      if (uMatcap) g.uniform1i(uMatcap, Math.max(0, Math.min(MATCAP_STYLES - 1, Math.round(mat.matcap))));
      if (uTint) g.uniform3f(uTint, mat.tintR, mat.tintG, mat.tintB);

      // Texmap: when this layer has a SAFE surface source (rendered earlier this
      // frame, non-self, non-cyclic), bind that layer's FBO colour texture and
      // flip uUseSurface on. Otherwise bind an inert 1×1 DUMMY texture (NOT this
      // layer's own FBO colour texture — that would be a WebGL feedback loop with
      // the current render target, undefined → black on many drivers). The
      // sampler stays defined; uUseSurface=0 means the shader ignores it.
      // TEXTURE0 is safe: combineStep re-binds TEXTURE0/1 + resets
      // activeTexture(TEXTURE0), so the unit state self-heals before the
      // fullscreen-quad combine passes.
      const useSurf = safeSource >= 0 && safeSource < LAYER_COUNT && safeSource !== i;
      g.activeTexture(g.TEXTURE0);
      g.bindTexture(g.TEXTURE_2D, useSurf ? layerTargets[safeSource]!.texture : dummyTex);
      if (uSurface) g.uniform1i(uSurface, 0);
      if (uUseSurface) g.uniform1i(uUseSurface, useSurf ? 1 : 0);
      if (uSurfaceMix) {
        const mix = typeof mat.surfaceMix === 'number' ? mat.surfaceMix : 1;
        g.uniform1f(uSurfaceMix, useSurf ? mix : 0);
      }

      // PROJECTIVE surface mode (Phase 7): when this OBJ has a surface source AND
      // material.surfaceMode === 'projective', project the source from a viewpoint
      // instead of UV-mapping it. Build the projector view-projection (CPU) +
      // upload it; the frag shader does the per-fragment world→clip transform +
      // front-face / in-frustum guards. UV mode (default) leaves uProjMode=0.
      const projective = useSurf && mat.surfaceMode === 'projective';
      if (uProjMode) g.uniform1i(uProjMode, projective ? 1 : 0);
      if (projective) {
        const aspect = ctx.res.width / ctx.res.height;
        const projector = projectorFromMaterial(
          mat,
          { eye: CAMERA_EYE, dir: CAMERA_DIR },
          aspect,
        );
        const vp = buildProjectorViewProj(projector);
        if (uProjVP) g.uniformMatrix4fv(uProjVP, false, vp);
        if (uProjEye) g.uniform3f(uProjEye, projector.eye[0], projector.eye[1], projector.eye[2]);
      }

      g.bindVertexArray(m.vao);
      g.drawElements(g.TRIANGLES, m.indexCount, g.UNSIGNED_INT, 0);

      // RESTORE GL state for the fullscreen-quad combine passes.
      g.bindVertexArray(null);
      g.disable(g.DEPTH_TEST);
      return true;
    }

    /**
     * Render a fragment-shader (shader / gen / frag) layer into target FBO `i`.
     *
     * Three modes:
     *   - a multi-buffer PROJECT (layer.project) → the Shadertoy runtime renders
     *     the Common + buffer passes + Image pass into the layer FBO (own FBOs,
     *     ping-pong feedback, iMouse click-paint, iChannelN wiring).
     *   - a single Shadertoy content shader → wrapped via the mainImage shim; the
     *     full Shadertoy uniform set is bound (iResolution=vec3, iMouse, iFrame,
     *     iDate, iTimeDelta, iFrameRate). A FRAG/scene-input content gets the
     *     below-layer FBO (`safeSource`) bound as iChannel0.
     *   - a plain engine shader → iTime (float) + iResolution (vec2) + params.
     *
     * `frame` carries iFrame/iMouse/dt; `safeSource` is the resolved
     * below/texmap layer index (or -1) for a FRAG/scene-input layer.
     */
    function renderShaderLayer(
      i: number,
      layer: ToyboxLayer,
      time: number,
      frame: VideoFrameContext,
      safeSource: number,
    ): boolean {
      const g = gl;
      const target = layerTargets[i]!;
      const sceneTex =
        safeSource >= 0 && safeSource < LAYER_COUNT && safeSource !== i
          ? layerTargets[safeSource]!.texture
          : null;

      // ---- Multi-buffer project ----
      if (isShadertoyProject(layer.project)) {
        return shadertoyRt.renderProject(
          layer.project as unknown as ShadertoyProject,
          i,
          target.fbo,
          time,
          frame,
          sceneTex,
        );
      }

      // ---- Single content shader ----
      if (!layer.contentId) return false;
      ensureProgram(layer.contentId);
      const compiled = programs.get(layer.contentId);
      if (!compiled) return false;
      g.bindFramebuffer(g.FRAMEBUFFER, target.fbo);
      g.viewport(0, 0, ctx.res.width, ctx.res.height);
      g.useProgram(compiled.program);
      if (compiled.uTime) g.uniform1f(compiled.uTime, time);
      if (compiled.shadertoy) {
        // Shadertoy convention: iResolution is a vec3 (w, h, 1) + the full set.
        if (compiled.uResolution) g.uniform3f(compiled.uResolution, ctx.res.width, ctx.res.height, 1);
        setShadertoyFrameUniforms(g, compiled, frame, i);
        // Scene-input (FRAG): bind the composited layer below as iChannel0.
        const wantScene = compiled.sceneInput && !!sceneTex;
        bindShadertoyChannels(g, compiled, [
          wantScene ? sceneTex! : dummyTex,
          dummyTex,
          dummyTex,
          dummyTex,
        ]);
      } else if (compiled.uResolution) {
        // Engine convention: iResolution is a vec2.
        g.uniform2f(compiled.uResolution, ctx.res.width, ctx.res.height);
      }
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
      g.activeTexture(g.TEXTURE0);
      return true;
    }

    /** Set iTime-adjacent Shadertoy uniforms (delta, rate, frame, mouse, date)
     *  on a compiled single-pass program from the frame context. */
    function setShadertoyFrameUniforms(
      g: WebGL2RenderingContext,
      c: CompiledShader,
      frame: VideoFrameContext,
      nodeIdForMouse: number,
    ): void {
      if (c.uTimeDelta) g.uniform1f(c.uTimeDelta, frame.timeDelta ?? 1 / 60);
      if (c.uFrameRate) g.uniform1f(c.uFrameRate, frame.frameRate ?? 60);
      if (c.uFrame) g.uniform1i(c.uFrame, frame.frame | 0);
      if (c.uMouse) {
        const m = frame.getMouse ? frame.getMouse(node.id) : [0, 0, 0, 0];
        g.uniform4f(c.uMouse, m[0]!, m[1]!, m[2]!, m[3]!);
      }
      if (c.uDate) {
        const d = new Date();
        const secs = d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() + d.getMilliseconds() / 1000;
        g.uniform4f(c.uDate, d.getFullYear(), d.getMonth(), d.getDate(), secs);
      }
      void nodeIdForMouse;
    }

    /** Bind 4 textures to a compiled program's iChannel0-3 samplers + set
     *  iChannelResolution[4] (engine res for all — our FBOs are engine-sized). */
    function bindShadertoyChannels(
      g: WebGL2RenderingContext,
      c: CompiledShader,
      texs: Array<WebGLTexture>,
    ): void {
      for (let s = 0; s < SHADERTOY_CHANNELS; s++) {
        g.activeTexture(g.TEXTURE0 + s);
        g.bindTexture(g.TEXTURE_2D, texs[s] ?? dummyTex);
        if (c.uChannel[s]) g.uniform1i(c.uChannel[s]!, s);
      }
      if (c.uChannelRes) {
        const res = new Float32Array(SHADERTOY_CHANNELS * 3);
        for (let s = 0; s < SHADERTOY_CHANNELS; s++) {
          res[s * 3] = ctx.res.width;
          res[s * 3 + 1] = ctx.res.height;
          res[s * 3 + 2] = 1;
        }
        g.uniform3fv(c.uChannelRes, res);
      }
      g.activeTexture(g.TEXTURE0);
    }

    /** Clear layer target `i` to transparent (empty layer). */
    function clearLayer(i: number): void {
      const g = gl;
      g.bindFramebuffer(g.FRAMEBUFFER, layerTargets[i]!.fbo);
      g.viewport(0, 0, ctx.res.width, ctx.res.height);
      g.clearColor(0, 0, 0, 0);
      g.clear(g.COLOR_BUFFER_BIT);
    }

    /**
     * Render an IMAGE-kind layer (PICTUREBOX-style) into target FBO `i`. The
     * card uploads an ImageBitmap into this layer's source texture via the
     * handle extras (setLayerImage); here we sample it onto a fullscreen quad.
     * Until a file is set the input shader paints its idle pattern (uHasInput=0)
     * — so an image layer is ALWAYS "produced" (returns true), the same way
     * PICTUREBOX always renders. Returns true so combine treats it as content.
     */
    function renderImageLayer(i: number): boolean {
      const g = gl;
      const target = layerTargets[i]!;
      const src = imageSources.get(i);
      const has = !!src && src.hasImage;
      g.bindFramebuffer(g.FRAMEBUFFER, target.fbo);
      g.viewport(0, 0, ctx.res.width, ctx.res.height);
      g.useProgram(inputProgram);
      g.activeTexture(g.TEXTURE0);
      // Bind the layer's source texture when present, else the inert dummy (the
      // shader ignores it when uHasInput=0, but the sampler must be defined).
      g.bindTexture(g.TEXTURE_2D, has ? src!.tex : dummyTex);
      if (iuTex) g.uniform1i(iuTex, 0);
      if (iuHasInput) g.uniform1f(iuHasInput, has ? 1 : 0);
      if (iuGain) g.uniform1f(iuGain, 1);
      ctx.drawFullscreenQuad();
      g.activeTexture(g.TEXTURE0);
      return true;
    }

    /**
     * Render a VIDEO-kind layer (VIDEOBOX-style) into target FBO `i`. The card
     * attaches a card-owned <video> element via the handle extras
     * (attachLayerVideo); the per-layer frame uploader pumps decoded frames into
     * a GL texture at the element's decode cadence. Until a frame is ready the
     * input shader paints its idle pattern. Returns true (always "produced").
     */
    function renderVideoLayer(i: number): boolean {
      const g = gl;
      const target = layerTargets[i]!;
      const up = videoUploaders.get(i);
      // Only pumps a GPU upload when rVFC reports a new decoded frame; otherwise
      // rebinds the existing texture. Returns false until a frame is ready.
      const ready = up ? up.uploadIfReady() : false;
      const srcTex = up ? up.texture : null;
      g.bindFramebuffer(g.FRAMEBUFFER, target.fbo);
      g.viewport(0, 0, ctx.res.width, ctx.res.height);
      g.useProgram(inputProgram);
      g.activeTexture(g.TEXTURE0);
      g.bindTexture(g.TEXTURE_2D, ready && srcTex ? srcTex : dummyTex);
      if (iuTex) g.uniform1i(iuTex, 0);
      if (iuHasInput) g.uniform1f(iuHasInput, ready && srcTex ? 1 : 0);
      if (iuGain) g.uniform1f(iuGain, 1);
      ctx.drawFullscreenQuad();
      g.activeTexture(g.TEXTURE0);
      return true;
    }

    /** Render layer `i` into its FBO; returns whether it produced content.
     *  `safeSource` is the per-frame texmap source index for an OBJ layer (or
     *  -1; ignored for non-OBJ layers). */
    function renderLayer(
      i: number,
      layers: ToyboxLayer[],
      time: number,
      safeSource: number,
      frame: VideoFrameContext,
    ): boolean {
      const layer = layers[i];
      if (!layer) {
        clearLayer(i);
        return false;
      }
      let drew = false;
      if (layer.kind === 'obj') drew = renderObjLayer(i, layer, time, safeSource);
      else if (layer.kind === 'shader' || layer.kind === 'gen' || layer.kind === 'frag')
        drew = renderShaderLayer(i, layer, time, frame, safeSource);
      else if (layer.kind === 'image') drew = renderImageLayer(i);
      else if (layer.kind === 'video') drew = renderVideoLayer(i);
      // 'off' → nothing.
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
        // OFFSET-as-manual: for any ROUTED port with no inbound cable, write the
        // OFFSET value (signal 0) so the param tracks the OFFSET knob even with
        // no modulator. A patched port is owned by the cv-bridge's setParam, so
        // applyUnpatchedOffsets skips it. (When VRT-frozen, __toyboxFreeze owns
        // the scope state + params, so we leave them pinned.)
        if (frozenTime() === null) applyUnpatchedOffsets();
        const layers = liveLayers();

        // 1) Render every layer into its own FBO. The SEQUENCE follows a
        //    per-frame dependency order so an OBJ layer that UV-maps another
        //    layer's FBO (material.surfaceSource) renders AFTER that source —
        //    while still writing produced[trueIndex] so the combine graph (which
        //    indexes layerTargets[N] by TRUE layer index) is unaffected. A
        //    cyclic / self / out-of-range surfaceSource degrades to matcap-only
        //    (safeSource = -1) — never a WebGL feedback loop.
        const produced: boolean[] = new Array(LAYER_COUNT).fill(false);
        const { order, safeSource } = resolveRenderOrder(layers);
        for (const i of order) produced[i] = renderLayer(i, layers, time, safeSource[i] ?? -1, frame);

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
        gl.deleteTexture(dummyTex);
        for (const s of scratchPool) {
          gl.deleteFramebuffer(s.fbo);
          gl.deleteTexture(s.texture);
        }
        scratchPool.length = 0;
        // Per-layer input sources (image textures + video frame uploaders).
        for (const src of imageSources.values()) gl.deleteTexture(src.tex);
        imageSources.clear();
        for (const up of videoUploaders.values()) up.dispose();
        videoUploaders.clear();
        for (const c of programs.values()) gl.deleteProgram(c.program);
        programs.clear();
        shadertoyRt.dispose();
        gl.deleteProgram(objProgram);
        gl.deleteProgram(combineProgram);
        gl.deleteProgram(inputProgram);
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
        // A generic modulation input (cv1..cv6) → fold the signal, resolve its
        // route + apply the per-input scale/offset into the addressed live
        // layer/combine param. Any other portId is ignored (TOYBOX has no
        // numeric engine params — content / material / combine all live in
        // node.data).
        if (isCvPortId(portId)) applyCvRoute(portId, value);
      },
      // The engine's AUDIO cv-bridge hands us the latest time-domain window for
      // a modulation input so the card's scope can draw a raw-waveform overlay
      // (cv/gate bridges never call this). Stored per port; surfaced via
      // read('cvScope').wave.
      setParamWave,
      readParam() { return undefined; },
      read(key) {
        if (key === 'fboTexture') return surface.texture;
        if (key === 'extras') return extras;
        // The batched per-input modulation snapshot the card reads ONCE per rAF
        // to drive all 6 always-on inline scopes (effective/min/max/kind/wave).
        if (key === 'cvScope') return readCvScope();
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};

/**
 * Migrate saved TOYBOX data forward (schemaVersion 1 → 2). v1 declared 8 generic
 * input ports (cv1..cv8); v2 reduced the pool to 6. A saved patch may carry
 * cvRoutes for the now-dropped cv7/cv8 — strip them so they don't linger (their
 * setParam writes are already harmless no-ops, but a dangling route would show
 * nothing in the 6-row UI). Edges wired to cv7/cv8 are tolerated by the engine
 * (setParam to an unknown port no-ops); we don't rewrite them (there's no
 * sensible remap target), so they simply stop doing anything. Pure: returns the
 * (possibly mutated) data object.
 */
export function migrateToyboxData(data: unknown, fromVersion: number): unknown {
  if (fromVersion >= 2 || !data || typeof data !== 'object') return data;
  const d = data as { cvRoutes?: Record<string, unknown> };
  if (d.cvRoutes && typeof d.cvRoutes === 'object') {
    for (const key of Object.keys(d.cvRoutes)) {
      if (!isCvPortId(key)) delete d.cvRoutes[key]; // drops cv7 / cv8 / anything stale
    }
  }
  return data;
}

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

// Input-source (image / video) pass: a fullscreen-quad passthrough that samples
// a source texture into the layer FBO. When no source is bound it paints the
// same dark-teal idle pattern as PICTUREBOX/VIDEOBOX so an empty input layer
// reads as "alive but empty" rather than "broken". Mirrors the engine's
// fullscreen-quad attribute layout (location 0 = aPos in clip space) so
// ctx.drawFullscreenQuad() drives it; the source textures are uploaded with
// UNPACK_FLIP_Y_WEBGL=true (PICTUREBOX/VIDEOBOX convention) so vUv samples them
// upright.
const INPUT_VERT_SRC = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const INPUT_FRAG_SRC = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform float uHasInput;   // 0 = idle pattern, 1 = sample uTex
uniform float uGain;       // RGB multiplier (reserved for future CV)
void main() {
  if (uHasInput < 0.5) {
    // Idle: subtle dark teal with a faint vertical ramp (PICTUREBOX +
    // VIDEOBOX idle look) so an empty input layer reads as alive-but-empty.
    float v = vUv.y * 0.05;
    outColor = vec4(0.04, 0.07, 0.09 + v, 1.0);
    return;
  }
  vec3 col = texture(uTex, vUv).rgb * uGain;
  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

function compileInputProgram(gl: WebGL2RenderingContext): WebGLProgram {
  return linkProgram(gl, INPUT_VERT_SRC, INPUT_FRAG_SRC);
}

// ---------------- Shadertoy GLSL runtime (single-pass uniforms + multi-buffer)

/** The full Shadertoy uniform locations for a compiled program. Shared between
 *  single-pass content shaders + multi-buffer project passes. */
interface ShadertoyUniformLocs {
  uTimeDelta: WebGLUniformLocation | null;
  uFrameRate: WebGLUniformLocation | null;
  uFrame: WebGLUniformLocation | null;
  uMouse: WebGLUniformLocation | null;
  uDate: WebGLUniformLocation | null;
  uChannel: Array<WebGLUniformLocation | null>;
  uChannelRes: WebGLUniformLocation | null;
}

/** Build a getter that extracts the Shadertoy uniform locations from any
 *  compiled program (returns nulls for the ones a given shader doesn't use). */
function collectShadertoyUniformGetters(
  gl: WebGL2RenderingContext,
): (program: WebGLProgram) => ShadertoyUniformLocs {
  return (program: WebGLProgram): ShadertoyUniformLocs => ({
    uTimeDelta: gl.getUniformLocation(program, 'iTimeDelta'),
    uFrameRate: gl.getUniformLocation(program, 'iFrameRate'),
    uFrame: gl.getUniformLocation(program, 'iFrame'),
    uMouse: gl.getUniformLocation(program, 'iMouse'),
    uDate: gl.getUniformLocation(program, 'iDate'),
    uChannel: [
      gl.getUniformLocation(program, 'iChannel0'),
      gl.getUniformLocation(program, 'iChannel1'),
      gl.getUniformLocation(program, 'iChannel2'),
      gl.getUniformLocation(program, 'iChannel3'),
    ],
    uChannelRes: gl.getUniformLocation(program, 'iChannelResolution'),
  });
}

/** A compiled multi-buffer pass: program + uniforms + its ping-pong render
 *  targets. Two FBOs so a `self` channel reads the PREVIOUS frame while we
 *  render into the other; we swap front/back after the whole project renders. */
interface CompiledStPass {
  id: string;
  src: string; // the resolved source (for change detection)
  program: WebGLProgram;
  uTime: WebGLUniformLocation | null;
  uResolution: WebGLUniformLocation | null;
  u: ShadertoyUniformLocs;
  channels: ReturnType<typeof resolveChannels>;
  float: boolean;
  front: { fbo: WebGLFramebuffer; texture: WebGLTexture };
  back: { fbo: WebGLFramebuffer; texture: WebGLTexture };
}

/** A compiled project keyed by a content signature so an edited project
 *  recompiles. Holds the per-pass programs + the topo order. */
interface CompiledStProject {
  sig: string;
  passes: Map<string, CompiledStPass>;
  order: string[];
  /** frame index when this project last rendered — drives iFrame reset on a
   *  fresh project so the painted-buffer "reset in first frame" logic fires. */
  localFrame: number;
}

interface ShadertoyRuntime {
  /** Render a multi-buffer project into `layerFbo`. Returns true (it always
   *  produces content once the passes compile). */
  renderProject(
    project: ShadertoyProject,
    layerIndex: number,
    layerFbo: WebGLFramebuffer,
    time: number,
    frame: VideoFrameContext,
    sceneTex: WebGLTexture | null,
  ): boolean;
  dispose(): void;
}

/**
 * Build the Shadertoy multi-buffer runtime. It compiles each pass through the
 * mainImage→main shim (Common prepended), allocates ping-pong FBOs per pass
 * (RGBA32F via createFloatFbo for `float` passes, RGBA8 otherwise), resolves
 * iChannel0-3 to textures (another pass's CURRENT output / a `self` PREVIOUS
 * frame / a keyboard stub / the scene composite / an inert dummy), and renders
 * in topo order with the Image pass last into the layer FBO. Feedback buffers
 * ping-pong: each pass renders into `front` (sampling `back` for `self`), then
 * we swap after the frame so next frame's `back` is this frame's output.
 */
function makeShadertoyRuntime(
  ctx: VideoEngineContext,
  stUni: (program: WebGLProgram) => ShadertoyUniformLocs,
  dummyTex: WebGLTexture,
  nodeId: string,
): ShadertoyRuntime {
  const gl = ctx.gl;
  const W = ctx.res.width;
  const H = ctx.res.height;

  // One keyboard stub (1×1 black) — Shadertoy's keyboard texture; we don't wire
  // real keys yet, so texelFetch returns 0 (no reset / no toggles).
  const keyboardTex = gl.createTexture();
  if (!keyboardTex) throw new Error('TOYBOX: createTexture (keyboard stub) failed');
  gl.bindTexture(gl.TEXTURE_2D, keyboardTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.bindTexture(gl.TEXTURE_2D, null);

  // Compiled projects keyed by layer index (each layer hosts at most one).
  const compiled = new Map<number, CompiledStProject>();

  /** A stable signature of the project's source so we recompile on edits. */
  function projectSig(p: ShadertoyProject): string {
    return JSON.stringify({
      c: p.common ?? '',
      p: p.passes.map((x) => ({ id: x.id, s: x.src, f: !!x.float, ch: x.channels })),
    });
  }

  function makeTarget(float: boolean): { fbo: WebGLFramebuffer; texture: WebGLTexture } {
    if (float && ctx.createFloatFbo) {
      const r = ctx.createFloatFbo(W, H, { filter: 'nearest', precision: 'full' });
      return { fbo: r.fbo, texture: r.texture };
    }
    return ctx.createFbo();
  }

  function compileProject(project: ShadertoyProject): CompiledStProject {
    const passes = new Map<string, CompiledStPass>();
    for (const p of project.passes) {
      // Project passes are always Shadertoy (mainImage) sources; wrap each with
      // the shim + the shared Common chunk prepended.
      const wrapped = wrapShadertoySource(p.src, project.common ?? '');
      let program: WebGLProgram;
      try {
        program = ctx.compileFragment(wrapped);
      } catch (err) {
        console.warn(`[TOYBOX] shadertoy pass '${p.id}' failed to compile:`, err);
        continue;
      }
      const u = stUni(program);
      passes.set(p.id, {
        id: p.id,
        src: p.src,
        program,
        uTime: gl.getUniformLocation(program, 'iTime'),
        uResolution: gl.getUniformLocation(program, 'iResolution'),
        u,
        channels: resolveChannels(p as ShadertoyPass),
        float: !!p.float,
        front: makeTarget(!!p.float),
        back: makeTarget(!!p.float),
      });
    }
    return { sig: projectSig(project), passes, order: topoOrderPasses(project), localFrame: 0 };
  }

  function disposePass(p: CompiledStPass): void {
    gl.deleteProgram(p.program);
    gl.deleteFramebuffer(p.front.fbo);
    gl.deleteTexture(p.front.texture);
    gl.deleteFramebuffer(p.back.fbo);
    gl.deleteTexture(p.back.texture);
  }
  function disposeProject(cp: CompiledStProject): void {
    for (const p of cp.passes.values()) disposePass(p);
    cp.passes.clear();
  }

  /** Resolve one channel binding to a texture for the CURRENT frame.
   *   - buffer: another pass's CURRENT-frame output (front, just rendered).
   *   - self:   THIS pass's PREVIOUS frame (back).
   *   - keyboard: the 1×1 stub.
   *   - scene:  the composited layer below (or dummy when absent).
   *   - none:   inert dummy. */
  function channelTexture(
    ch: ReturnType<typeof resolveChannels>[number],
    selfPass: CompiledStPass,
    byId: Map<string, CompiledStPass>,
    sceneTex: WebGLTexture | null,
  ): WebGLTexture {
    switch (ch.type) {
      case 'buffer': {
        const src = byId.get(ch.pass);
        return src ? src.front.texture : dummyTex;
      }
      case 'self':
        return selfPass.back.texture;
      case 'keyboard':
        return keyboardTex;
      case 'scene':
        return sceneTex ?? dummyTex;
      default:
        return dummyTex;
    }
  }

  function renderProject(
    project: ShadertoyProject,
    layerIndex: number,
    layerFbo: WebGLFramebuffer,
    time: number,
    frame: VideoFrameContext,
    sceneTex: WebGLTexture | null,
  ): boolean {
    // (Re)compile on first sight or when the source signature changes.
    let cp = compiled.get(layerIndex);
    const sig = projectSig(project);
    if (!cp || cp.sig !== sig) {
      if (cp) disposeProject(cp);
      cp = compileProject(project);
      compiled.set(layerIndex, cp);
    }
    if (cp.passes.size === 0) return false;

    const date = new Date();
    const dateSecs =
      date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds() + date.getMilliseconds() / 1000;
    const localFrame = cp.localFrame;

    // Render each pass in topo order into its FRONT target (sampling BACK for a
    // self channel = previous frame).
    for (const id of cp.order) {
      const p = cp.passes.get(id);
      if (!p) continue;
      const isImage = id === IMAGE_PASS_ID;
      const dstFbo = isImage ? layerFbo : p.front.fbo;
      gl.bindFramebuffer(gl.FRAMEBUFFER, dstFbo);
      gl.viewport(0, 0, W, H);
      gl.useProgram(p.program);
      if (p.uTime) gl.uniform1f(p.uTime, time);
      if (p.uResolution) gl.uniform3f(p.uResolution, W, H, 1);
      if (p.u.uTimeDelta) gl.uniform1f(p.u.uTimeDelta, frame.timeDelta ?? 1 / 60);
      if (p.u.uFrameRate) gl.uniform1f(p.u.uFrameRate, frame.frameRate ?? 60);
      // iFrame is the PROJECT-LOCAL frame so the buffer's "if (iFrame < 2)"
      // reset fires when the project is (re)loaded, not at engine boot.
      if (p.u.uFrame) gl.uniform1i(p.u.uFrame, localFrame | 0);
      if (p.u.uMouse) {
        const m = frame.getMouse ? frame.getMouse(nodeId) : [0, 0, 0, 0];
        gl.uniform4f(p.u.uMouse, m[0]!, m[1]!, m[2]!, m[3]!);
      }
      if (p.u.uDate) gl.uniform4f(p.u.uDate, date.getFullYear(), date.getMonth(), date.getDate(), dateSecs);
      // Channels → textures + iChannelResolution.
      for (let s = 0; s < SHADERTOY_CHANNELS; s++) {
        const tex = channelTexture(p.channels[s]!, p, cp.passes, sceneTex);
        gl.activeTexture(gl.TEXTURE0 + s);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        if (p.u.uChannel[s]) gl.uniform1i(p.u.uChannel[s]!, s);
      }
      if (p.u.uChannelRes) {
        const res = new Float32Array(SHADERTOY_CHANNELS * 3);
        for (let s = 0; s < SHADERTOY_CHANNELS; s++) {
          res[s * 3] = W;
          res[s * 3 + 1] = H;
          res[s * 3 + 2] = 1;
        }
        gl.uniform3fv(p.u.uChannelRes, res);
      }
      ctx.drawFullscreenQuad();
      gl.activeTexture(gl.TEXTURE0);
    }

    // Swap front/back on every buffer pass so this frame's output becomes next
    // frame's `back` (the `self` previous-frame source). The Image pass renders
    // straight into the layer FBO so it has nothing to swap.
    for (const p of cp.passes.values()) {
      if (p.id === IMAGE_PASS_ID) continue;
      const t = p.front;
      p.front = p.back;
      p.back = t;
    }
    cp.localFrame = localFrame + 1;
    return true;
  }

  function dispose(): void {
    for (const cp of compiled.values()) disposeProject(cp);
    compiled.clear();
    gl.deleteTexture(keyboardTex);
  }

  return { renderProject, dispose };
}

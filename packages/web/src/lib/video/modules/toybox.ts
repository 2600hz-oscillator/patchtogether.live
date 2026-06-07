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
//          inA / inB (video) — two patched-feed VIDEO inputs. A VIDEO-kind
//          layer whose `videoSource` is 'inA'/'inB' sources the texture patched
//          into that port (frame.getInputTexture) instead of a local file /
//          camera, blitted through the same inputProgram fullscreen quad into
//          the layer FBO (so combine + UV-texmap + projective surface mapping
//          compose on a live patched feed). Unpatched / unselected → idle pattern.
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
  customShaderKey,
  customObjKey,
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
  isCombineOpKind,
  isStatefulKind,
  opHistoryDepth,
  combineExtraFor,
  exquisiteUniforms,
  makeDefaultCombineGraph,
  topoSort,
  type ToyboxCombineGraph,
  type ToyboxOpKind,
} from '$lib/video/toybox-combine-graph';
import { historyUniforms } from '$lib/video/toybox-history';
import { feedbackUniforms, feedbackResetState } from '$lib/video/toybox-feedback';
import {
  CV_PORT_IDS,
  isCvPortId,
  resolveRoute,
  getCvInput,
  effectiveCvValue,
  foldCvToUnipolar,
  imageVideoParamValue,
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
import {
  BUFFER_RES_SD,
  BUFFER_RES_1080,
  clampBufferResValue,
  effectiveBufferDims,
} from '$lib/video/buffer-res';

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
  schemaVersion: 4,
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
  inputs: [
    ...CV_PORT_IDS.map((id) => ({
      id,
      // `modsignal` accepts cv, gate, OR audio (canConnect scopes audio→non-audio
      // to this type only). The port IDs stay cv1..cv6 (so isCvPortId / setParam /
      // presets / cvRoutes are untouched); only the cable TYPE widens.
      type: 'modsignal' as const,
      cvScale: { mode: 'linear' as const },
    })),
    // Two VIDEO input ports (VID A / VID B), AFTER the 6 cv ports so cv1..cv6
    // ordering is undisturbed (the card + CV routing read ports by id). A
    // VIDEO-kind layer can select 'inA'/'inB' as its source (layer.videoSource)
    // — the layer then sources the patched feed instead of a local file/camera,
    // composing through the SAME inputProgram fullscreen-quad blit into the
    // layer FBO (so UV-texmap + projective surface mapping just work on it).
    // The default patch selects NEITHER, so a feed patched into inA/inB without
    // a layer pointing at it is a correct no-op (see EXEMPT_INPUT_DRIVE).
    { id: 'inA', type: 'video' as const },
    { id: 'inB', type: 'video' as const },
  ],
  outputs: [
    { id: 'out', type: 'video' },
  ],
  params: [
    // HD per-module heavy-buffer res (0=SD/1=720p/2=1080p) for the frame-history
    // / feedback float rings (RGBA32F, up to 33-deep → the headline VRAM hog,
    // ~1 GB/node at 1080p). Default SD even in HD; 720/1080 only honored when
    // global HD is on locally (hd-toggle §4.5). The rings upscale on read into
    // the engine-res layer pipeline.
    { id: 'bufferRes', label: 'Res', defaultValue: BUFFER_RES_SD, min: BUFFER_RES_SD, max: BUFFER_RES_1080, curve: 'linear' },
  ],

  factory(ctx: VideoEngineContext, node): VideoNodeHandle {
    const gl = ctx.gl;
    // Heavy-buffer res for the float feedback/history rings (the VRAM hogs).
    // Clamped to SD when global HD is off locally (hd-toggle §4.5). Read once at
    // construction; a change re-adds the node (like any ring-size change).
    const bufferRes = clampBufferResValue(node.params?.bufferRes);
    const ringDims = effectiveBufferDims(bufferRes, ctx.hdActive ?? false, ctx.res);
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

    /**
     * Ensure the compiled program for `cacheKey` exists. Two source modes:
     *   - bundled content (inlineSrc omitted): fetch the GLSL by id from the
     *     manifest (`getContent`), detect Shadertoy via the manifest flag OR the
     *     mainImage convention, wrap with the content's declared params.
     *   - custom disk-loaded shader (inlineSrc given, `cacheKey` is a
     *     `custom-shader:<hash>` synthetic id): compile THAT source directly.
     *     Shadertoy-vs-GEN is detected from the source alone; a custom shader
     *     declares NO params (the card shows no faders) so we wrap with [].
     *     Scene-input (FRAG) for a custom FRAG-layer shader is decided by the
     *     CALLER (renderShaderLayer) from layer.kind, not the manifest.
     * The failed-compile guard degrades a bad uploaded shader gracefully
     * (console.warn, no crash) exactly like a bundled one.
     */
    function ensureProgram(cacheKey: string, inlineSrc?: string): void {
      if (programs.has(cacheKey) || inflightShader.has(cacheKey) || failedShader.has(cacheKey)) return;
      inflightShader.add(cacheKey);
      void (async () => {
        try {
          let glsl: string;
          let isSt: boolean;
          let paramIds: string[];
          let sceneInput: boolean;
          if (typeof inlineSrc === 'string') {
            // Custom disk-loaded source: compile directly, no manifest fetch.
            glsl = inlineSrc;
            isSt = isShadertoySource(glsl);
            paramIds = []; // custom shaders declare no params
            // A custom Shadertoy source that reads iChannel0 (a FRAG-style FX)
            // gets the composited layers below bound to iChannel0 — same as a
            // bundled scene-input content. Cheap textual probe; harmless when
            // false (the shader just ignores the channel).
            sceneInput = isSt && /\biChannel0\b/.test(glsl);
          } else {
            const { meta, glsl: fetched } = await getContent(cacheKey);
            glsl = fetched;
            // A content is Shadertoy if the manifest flags it OR the source uses
            // the mainImage convention. Wrap it through the shim; engine shaders
            // (plain main) compile as-is.
            isSt = meta.shadertoy === true || isShadertoySource(glsl);
            paramIds = meta.params.map((p) => p.id);
            sceneInput = meta.input === 'scene';
          }
          const src = isSt ? wrapShadertoySource(glsl, '', paramIds) : glsl;
          const program = ctx.compileFragment(src);
          const uParams = new Map<string, WebGLUniformLocation | null>();
          for (const pid of paramIds) uParams.set(pid, gl.getUniformLocation(program, pid));
          const u = stUni(program);
          programs.set(cacheKey, {
            program,
            shadertoy: isSt,
            sceneInput,
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
          failedShader.add(cacheKey);
          console.warn(`[TOYBOX] content '${cacheKey}' failed to compile:`, err);
        } finally {
          inflightShader.delete(cacheKey);
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

    /** Ensure the GPU mesh for `cacheKey` is built. Three source modes:
     *   - inline custom OBJ (inlineObj given, `cacheKey` is a `custom-obj:<hash>`
     *     synthetic id): parse THAT text directly (synchronous, no fetch);
     *   - built-in primitive (cube/sphere/…): generated synchronously;
     *   - bundled OBJ: fetched + parsed async by id.
     *  The failed-parse guard degrades a bad uploaded OBJ gracefully. */
    function ensureMesh(cacheKey: string, inlineObj?: string): void {
      if (meshes.has(cacheKey) || inflightModel.has(cacheKey) || failedModel.has(cacheKey)) return;
      // Custom disk-loaded OBJ: parse the inline text directly, synchronously.
      if (typeof inlineObj === 'string') {
        try {
          meshes.set(cacheKey, uploadMesh(parseObj(inlineObj)));
        } catch (err) {
          failedModel.add(cacheKey);
          console.warn(`[TOYBOX] custom OBJ '${cacheKey}' failed to parse:`, err);
        }
        return;
      }
      const modelId = cacheKey;
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
    const cuKeyR = gl.getUniformLocation(combineProgram, 'uKeyR');
    const cuKeyG = gl.getUniformLocation(combineProgram, 'uKeyG');
    const cuKeyB = gl.getUniformLocation(combineProgram, 'uKeyB');
    const cuMode = gl.getUniformLocation(combineProgram, 'uMode');
    const cuP0 = gl.getUniformLocation(combineProgram, 'uP0');
    const cuP1 = gl.getUniformLocation(combineProgram, 'uP1');
    const cuP2 = gl.getUniformLocation(combineProgram, 'uP2');
    const cuP3 = gl.getUniformLocation(combineProgram, 'uP3');
    const cuP4 = gl.getUniformLocation(combineProgram, 'uP4');
    const cuP5 = gl.getUniformLocation(combineProgram, 'uP5');

    // ---------------- FEEDBACK program (the first STATEFUL combine op) --------
    // Its own fullscreen-quad program: samples this node's PREVIOUS frame
    // (uFeedback = the ping-pong back texture) + the upstream in0 (uInput) and
    // writes a NEW frame. See FEEDBACK_FRAG_SRC + toybox-feedback.ts.
    const feedbackProgram = compileFeedbackProgram(gl);
    const fuFeedback = gl.getUniformLocation(feedbackProgram, 'uFeedback');
    const fuInput = gl.getUniformLocation(feedbackProgram, 'uInput');
    const fuHasInput = gl.getUniformLocation(feedbackProgram, 'uHasInput');
    const fuTexel = gl.getUniformLocation(feedbackProgram, 'uTexel');
    const fuMode = gl.getUniformLocation(feedbackProgram, 'uMode');
    const fuZoom = gl.getUniformLocation(feedbackProgram, 'uZoom');
    const fuRotate = gl.getUniformLocation(feedbackProgram, 'uRotate');
    const fuScaleP = gl.getUniformLocation(feedbackProgram, 'uScaleP');
    const fuTx = gl.getUniformLocation(feedbackProgram, 'uTx');
    const fuTy = gl.getUniformLocation(feedbackProgram, 'uTy');
    const fuDecay = gl.getUniformLocation(feedbackProgram, 'uDecay');
    const fuGain = gl.getUniformLocation(feedbackProgram, 'uGain');
    const fuThresh = gl.getUniformLocation(feedbackProgram, 'uThresh');
    const fuHue = gl.getUniformLocation(feedbackProgram, 'uHue');
    const fuBlur = gl.getUniformLocation(feedbackProgram, 'uBlur');
    const fuSlitPos = gl.getUniformLocation(feedbackProgram, 'uSlitPos');
    const fuSlitWidth = gl.getUniformLocation(feedbackProgram, 'uSlitWidth');
    const fuFlow = gl.getUniformLocation(feedbackProgram, 'uFlow');
    const fuIntensity = gl.getUniformLocation(feedbackProgram, 'uIntensity');

    // ---------------- EXQUISITE program (multi-input, up to 4 feeds) -----------
    const exqProgram = compileExquisiteProgram(gl);
    const xuIn = [0, 1, 2, 3].map((i) => gl.getUniformLocation(exqProgram, `uIn${i}`));
    const xuHas = [0, 1, 2, 3].map((i) => gl.getUniformLocation(exqProgram, `uHas${i}`));
    const xuBands = gl.getUniformLocation(exqProgram, 'uBands');
    const xuWarp = gl.getUniformLocation(exqProgram, 'uWarp');
    const xuSeam = gl.getUniformLocation(exqProgram, 'uSeam');
    const xuHue = gl.getUniformLocation(exqProgram, 'uHue');

    // ---------------- FRAME-HISTORY program (framedelay/channeldesync/…) -------
    // One shared program for the 5 history ops: samples the upstream in0 (+ in1
    // for dreammelt) + up to THREE delayed taps out of the node's ring + the most-
    // recent prev frame, branching on uOp. See HISTORY_FRAG_SRC + toybox-history.ts.
    const histProgram = compileHistoryProgram(gl);
    const huPrev = gl.getUniformLocation(histProgram, 'uPrev');
    const huTapR = gl.getUniformLocation(histProgram, 'uTapR');
    const huTapG = gl.getUniformLocation(histProgram, 'uTapG');
    const huTapB = gl.getUniformLocation(histProgram, 'uTapB');
    const huIn = gl.getUniformLocation(histProgram, 'uInput');
    const huIn1 = gl.getUniformLocation(histProgram, 'uInput1');
    const huHasIn = gl.getUniformLocation(histProgram, 'uHasInput');
    const huHasIn1 = gl.getUniformLocation(histProgram, 'uHasInput1');
    const huTexel = gl.getUniformLocation(histProgram, 'uTexel');
    const huTime = gl.getUniformLocation(histProgram, 'uTime');
    const huOp = gl.getUniformLocation(histProgram, 'uOp');
    const huMix = gl.getUniformLocation(histProgram, 'uMix');
    const huOffset = gl.getUniformLocation(histProgram, 'uOffsetMag');
    const huFlowStr = gl.getUniformLocation(histProgram, 'uFlowStrength');
    const huNoiseScale = gl.getUniformLocation(histProgram, 'uNoiseScale');
    const huPersist = gl.getUniformLocation(histProgram, 'uPersistence');
    const huMelt = gl.getUniformLocation(histProgram, 'uMeltAmount');
    const huDrip = gl.getUniformLocation(histProgram, 'uDripSpeed');
    const huThresh = gl.getUniformLocation(histProgram, 'uThreshold');
    const huFlowScale = gl.getUniformLocation(histProgram, 'uFlowScale');
    const huHold = gl.getUniformLocation(histProgram, 'uHoldGate');
    const huDecay = gl.getUniformLocation(histProgram, 'uDecay');
    const huStorePass = gl.getUniformLocation(histProgram, 'uStorePass');

    // ---------------- Per-feedback-node ping-pong float buffers ----------------
    //
    // Each FEEDBACK node in the combine graph owns a PING-PONG pair of float FBOs
    // (RGBA32F via createFloatFbo, degrading to RGBA8 when the GPU can't render
    // float — guarded). One frame: render into `front` while SAMPLING `back` (the
    // previous frame), then swap. Keyed by the graph node id so adding/removing a
    // feedback node allocs/frees its buffers (reconciled each frame against the
    // live graph). `clearPending` forces both buffers cleared to black next
    // render (the "Reset feedback" menu action bumps the reset counter the card
    // writes to node.data; we diff it per node id).
    interface FloatTarget { fbo: WebGLFramebuffer; texture: WebGLTexture }
    interface FeedbackBuf {
      /** The frame-history ring. `ring[head]` is the slot rendered NEXT;
       *  ring[(head-1+N)%N] is the most-recent frame; ring[(head-1-d+N)%N] is the
       *  frame `d` frames ago. A FEEDBACK/1-deep op uses N=2 (classic ping-pong:
       *  render into head, sample the other). framedelay/channeldesync use a
       *  deeper ring so a DELAYED tap reads a frame from `delay` frames back. */
      ring: FloatTarget[];
      /** Next slot to render into (advances mod ring.length each step). */
      head: number;
      /** A dedicated OUTPUT target for the DELAY-LINE ops (framedelay/
       *  channeldesync), whose ring holds the LIVE INPUT history (a store pass)
       *  and whose visible output is rendered here (a read pass) so downstream
       *  samples the delayed result, not the just-stored input. Absent for the
       *  recursive 1-deep ops (their ring slot IS the output). */
      out?: FloatTarget;
      /** The op KIND this buffer serves (so a kind change re-allocs the ring). */
      kind: string;
      /** True until the ring has been cleared once (fresh alloc / explicit
       *  reset) — a fresh float texture's contents are undefined. */
      clearPending: boolean;
      /** Last-seen reset token for this node (`_reset` param); when it changes we
       *  re-arm clearPending. */
      resetToken: number;
    }
    const feedbackBufs = new Map<string, FeedbackBuf>();

    function allocFloatTarget(): FloatTarget {
      if (ctx.createFloatFbo) {
        // NEAREST filter: LINEAR on a float colour attachment silently reads 0.0
        // without OES_texture_float_linear (see engine.ts) — which made the whole
        // loop render black. Spatial taps are fine on NEAREST.
        // Allocate at the per-module ring res (bufferRes), NOT engine res — this
        // is the VRAM-hungry float ring; it upscales on read into the pipeline.
        const r = ctx.createFloatFbo(ringDims.width, ringDims.height, { filter: 'nearest', precision: 'full' });
        return { fbo: r.fbo, texture: r.texture };
      }
      // RGBA8 fallback at ring res (createSizedFbo when present, else engine res).
      return ctx.createSizedFbo
        ? ctx.createSizedFbo(ringDims.width, ringDims.height)
        : ctx.createFbo();
    }

    /** Allocate a frame-history ring for a stateful node of `kind`. depth=1 →
     *  N=2 (classic ping-pong); depth=D → N=D+1 (so a tap `D` frames back exists
     *  alongside the slot being written this frame). */
    function makeFeedbackBuf(kind: string): FeedbackBuf {
      const depth = opHistoryDepth(kind);
      const n = Math.max(2, depth + 1);
      const ring: FloatTarget[] = [];
      for (let i = 0; i < n; i++) ring.push(allocFloatTarget());
      // Delay-line ops (depth > 1) need a separate visible-output target (their
      // ring holds the live-input history; the read pass renders the delay here).
      const out = depth > 1 ? allocFloatTarget() : undefined;
      return { ring, head: 0, out, kind, clearPending: true, resetToken: 0 };
    }

    function freeFeedbackBuf(b: FeedbackBuf): void {
      for (const t of b.ring) {
        gl.deleteFramebuffer(t.fbo);
        gl.deleteTexture(t.texture);
      }
      if (b.out) {
        gl.deleteFramebuffer(b.out.fbo);
        gl.deleteTexture(b.out.texture);
      }
    }

    /** Reconcile the feedbackBufs map against the live graph's STATEFUL node ids
     *  (feedback + the frame-history ops): alloc a ring for any new stateful node
     *  (or one whose KIND changed → different ring depth), free + drop rings whose
     *  node is gone. Called once per frame from evalGraph before rendering. */
    function reconcileFeedbackBufs(graph: ToyboxCombineGraph): Set<string> {
      const liveKind = new Map<string, string>();
      for (const n of graph.nodes) if (isStatefulKind(n.kind)) liveKind.set(n.id, n.kind);
      // Free buffers for removed stateful nodes (or ones whose kind changed).
      for (const [nid, buf] of feedbackBufs) {
        const k = liveKind.get(nid);
        if (k === undefined || k !== buf.kind) {
          freeFeedbackBuf(buf);
          feedbackBufs.delete(nid);
        }
      }
      // Alloc buffers for new stateful nodes.
      for (const [nid, k] of liveKind) {
        if (!feedbackBufs.has(nid)) feedbackBufs.set(nid, makeFeedbackBuf(k));
      }
      return new Set(liveKind.keys());
    }

    /** Clear a buffer's whole ring to black (fresh alloc / reset). A freshly-
     *  created float texture has undefined contents, so we MUST clear before the
     *  first sample to avoid reading garbage as a "previous frame". */
    function clearFeedbackBuf(b: FeedbackBuf): void {
      const g = gl;
      const targets = b.out ? [...b.ring, b.out] : b.ring;
      for (const t of targets) {
        g.bindFramebuffer(g.FRAMEBUFFER, t.fbo);
        // Ring targets are ringDims-sized (bufferRes), not engine res.
        g.viewport(0, 0, ringDims.width, ringDims.height);
        g.clearColor(0, 0, 0, 1);
        g.clear(g.COLOR_BUFFER_BIT);
      }
      b.clearPending = false;
    }

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
    const iuOpacity = gl.getUniformLocation(inputProgram, 'uOpacity');

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
      // A custom disk-loaded OBJ (layer.objSrc) takes precedence over the bundled
      // material.modelId: parse THAT directly under a synthetic mesh-cache key.
      const customObj =
        typeof layer.objSrc === 'string' && layer.objSrc.length > 0 ? layer.objSrc : null;
      const meshKey = customObj ? customObjKey(customObj) : mat.modelId;
      if (!meshKey) return false;
      ensureMesh(meshKey, customObj ?? undefined);
      const m = meshes.get(meshKey);
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
      // A custom disk-loaded source (layer.shaderSrc) takes precedence over the
      // bundled contentId: compile THAT directly under a synthetic cache key.
      const customSrc =
        typeof layer.shaderSrc === 'string' && layer.shaderSrc.length > 0
          ? layer.shaderSrc
          : null;
      const cacheKey = customSrc ? customShaderKey(customSrc) : layer.contentId;
      if (!cacheKey) return false;
      ensureProgram(cacheKey, customSrc ?? undefined);
      const compiled = programs.get(cacheKey);
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
      // Custom disk-loaded shaders declare no params; only bundled content does.
      const meta = customSrc ? null : layer.contentId ? getContentMeta(layer.contentId) : null;
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
    function renderImageLayer(i: number, layer: ToyboxLayer): boolean {
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
      // BRIGHTNESS + OPACITY (#57): read off the layer's params (CV-writable).
      if (iuGain) g.uniform1f(iuGain, imageVideoParamValue(layer.params, 'brightness'));
      if (iuOpacity) g.uniform1f(iuOpacity, imageVideoParamValue(layer.params, 'opacity'));
      ctx.drawFullscreenQuad();
      g.activeTexture(g.TEXTURE0);
      return true;
    }

    /**
     * Render a VIDEO-kind layer into target FBO `i`. The layer's `videoSource`
     * selects where the texture comes from:
     *   - 'inA' / 'inB' (PATCHED FEED): the texture patched into this TOYBOX
     *     node's video input port — `frame.getInputTexture(node.id, 'inA'|'inB')`.
     *     Null (unpatched) → idle pattern. Blitted through the SAME inputProgram
     *     fullscreen quad as the file/camera path, so the layer FBO holds the
     *     patched feed and combine + OBJ UV-texmap + projective surface mapping
     *     all compose on it identically.
     *   - 'file' / 'camera' (the #603 default): a card-owned <video> element
     *     attached via the handle extras (attachLayerVideo); the per-layer frame
     *     uploader pumps decoded frames into a GL texture at decode cadence.
     * Until a source frame is ready the input shader paints its idle pattern.
     * Returns true (always "produced"), exactly like the file path.
     *
     * `frame` is OPTIONAL (trailing): a direct unit-caller that doesn't thread a
     * frame degrades to the file/camera path with no patched-input lookup,
     * rather than crashing. The live draw() always passes it.
     */
    function renderVideoLayer(i: number, layer: ToyboxLayer, frame?: VideoFrameContext): boolean {
      const g = gl;
      const target = layerTargets[i]!;

      // Resolve the source texture for the layer's videoSource.
      let srcTex: WebGLTexture | null = null;
      const source = layer.videoSource;
      if (source === 'inA' || source === 'inB') {
        // PATCHED FEED: bind the texture on this node's video input port. Null
        // (no cable / source has no texture) → idle pattern (uHasInput=0).
        srcTex = frame ? frame.getInputTexture(node.id, source) : null;
      } else {
        // FILE / CAMERA (#603 path): pump the card-owned <video> uploader. Only
        // re-uploads when rVFC reports a new decoded frame; else rebinds the
        // existing texture. Null until a frame is ready.
        const up = videoUploaders.get(i);
        const ready = up ? up.uploadIfReady() : false;
        srcTex = ready && up ? up.texture : null;
      }

      g.bindFramebuffer(g.FRAMEBUFFER, target.fbo);
      g.viewport(0, 0, ctx.res.width, ctx.res.height);
      g.useProgram(inputProgram);
      g.activeTexture(g.TEXTURE0);
      g.bindTexture(g.TEXTURE_2D, srcTex ?? dummyTex);
      if (iuTex) g.uniform1i(iuTex, 0);
      if (iuHasInput) g.uniform1f(iuHasInput, srcTex ? 1 : 0);
      // BRIGHTNESS + OPACITY (#57): read off the layer's params (CV-writable).
      if (iuGain) g.uniform1f(iuGain, imageVideoParamValue(layer.params, 'brightness'));
      if (iuOpacity) g.uniform1f(iuOpacity, imageVideoParamValue(layer.params, 'opacity'));
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
      else if (layer.kind === 'image') drew = renderImageLayer(i, layer);
      else if (layer.kind === 'video') drew = renderVideoLayer(i, layer, frame);
      // 'off' → nothing.
      if (!drew) clearLayer(i);
      return drew;
    }

    /** Extra (op-dependent) combine params beyond `amount`. uP0..uP5 are the
     *  generic batch-op param slots (tile/mirror/displace/bitbend/biocells). */
    interface CombineExtra {
      soft?: number;
      invert?: number;
      keyR?: number;
      keyG?: number;
      keyB?: number;
      mode?: number;
      p0?: number;
      p1?: number;
      p2?: number;
      p3?: number;
      p4?: number;
      p5?: number;
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
      // chromakey: default key COLOUR is green-screen (0,1,0), matching the
      // standalone CHROMAKEY module + chromakey OP_PARAMS defaults.
      if (cuKeyR) g.uniform1f(cuKeyR, extra?.keyR ?? 0);
      if (cuKeyG) g.uniform1f(cuKeyG, extra?.keyG ?? 1);
      if (cuKeyB) g.uniform1f(cuKeyB, extra?.keyB ?? 0);
      if (cuMode) g.uniform1f(cuMode, extra?.mode ?? 0);
      if (cuP0) g.uniform1f(cuP0, extra?.p0 ?? 0);
      if (cuP1) g.uniform1f(cuP1, extra?.p1 ?? 0);
      if (cuP2) g.uniform1f(cuP2, extra?.p2 ?? 0);
      if (cuP3) g.uniform1f(cuP3, extra?.p3 ?? 0);
      if (cuP4) g.uniform1f(cuP4, extra?.p4 ?? 0);
      if (cuP5) g.uniform1f(cuP5, extra?.p5 ?? 0);
      ctx.drawFullscreenQuad();
      g.activeTexture(g.TEXTURE0);
    }

    const OP_INDEX: Record<string, number> = { fade: 0, lumakey: 1, chromakey: 2, map: 3 };

    /**
     * Run ONE feedback step for a feedback node: render into `buf.front` while
     * SAMPLING `buf.back` (the previous frame) + the upstream `inputTex`, then
     * swap front↔back so this frame's output is next frame's previous. Returns
     * the texture other nodes should sample (= the just-rendered front, which is
     * `buf.back` AFTER the swap). `inputTex` null = in0 unwired (loop reads black
     * for the input term). Uniforms are derived (clamped) from the node params by
     * the pure feedbackUniforms() so a CV write + manual knob land identically.
     */
    function runFeedbackStep(
      buf: FeedbackBuf,
      inputTex: WebGLTexture | null,
      params: Record<string, number> | undefined,
    ): WebGLTexture {
      const g = gl;
      if (buf.clearPending) clearFeedbackBuf(buf);
      const u = feedbackUniforms(params);
      const N = buf.ring.length;
      // Classic ping-pong over the ring: render into `head`, sample the previous
      // slot (head-1). prev = most-recent rendered frame.
      const dst = buf.ring[buf.head]!;
      const prev = buf.ring[(buf.head - 1 + N) % N]!;
      g.bindFramebuffer(g.FRAMEBUFFER, dst.fbo);
      // Ring targets are ringDims-sized (bufferRes); render + texel-step at that
      // res. The output texture upscales on read into the engine-res pipeline.
      g.viewport(0, 0, ringDims.width, ringDims.height);
      g.useProgram(feedbackProgram);
      // uFeedback = previous frame, uInput = upstream in0.
      g.activeTexture(g.TEXTURE0);
      g.bindTexture(g.TEXTURE_2D, prev.texture);
      if (fuFeedback) g.uniform1i(fuFeedback, 0);
      g.activeTexture(g.TEXTURE1);
      g.bindTexture(g.TEXTURE_2D, inputTex ?? dummyTex);
      if (fuInput) g.uniform1i(fuInput, 1);
      if (fuHasInput) g.uniform1f(fuHasInput, inputTex ? 1 : 0);
      if (fuTexel) g.uniform2f(fuTexel, 1 / ringDims.width, 1 / ringDims.height);
      if (fuMode) g.uniform1i(fuMode, u.mode);
      if (fuZoom) g.uniform1f(fuZoom, u.zoom);
      if (fuRotate) g.uniform1f(fuRotate, u.rotate);
      if (fuScaleP) g.uniform1f(fuScaleP, u.scaleP);
      if (fuTx) g.uniform1f(fuTx, u.tx);
      if (fuTy) g.uniform1f(fuTy, u.ty);
      if (fuDecay) g.uniform1f(fuDecay, u.decay);
      if (fuGain) g.uniform1f(fuGain, u.gain);
      if (fuThresh) g.uniform1f(fuThresh, u.thresh);
      if (fuHue) g.uniform1f(fuHue, u.hue);
      if (fuBlur) g.uniform1f(fuBlur, u.blur);
      if (fuSlitPos) g.uniform1f(fuSlitPos, u.slitPos);
      if (fuSlitWidth) g.uniform1f(fuSlitWidth, u.slitWidth);
      if (fuFlow) g.uniform1f(fuFlow, u.flow);
      if (fuIntensity) g.uniform1f(fuIntensity, u.intensity);
      ctx.drawFullscreenQuad();
      g.activeTexture(g.TEXTURE0);
      // Advance the ring head; downstream samples the JUST-RENDERED slot.
      const out = dst.texture;
      buf.head = (buf.head + 1) % N;
      return out;
    }

    /**
     * Run the EXQUISITE multi-input band-splicer into `slot`. `ins` are the (up
     * to 4) wired input textures (null = unwired). Renders into a plain scratch
     * FBO (stateless), returns its texture. Uses its OWN program so it can read
     * 4 samplers (combineStep only binds 2).
     */
    function runExquisiteStep(
      slot: { fbo: WebGLFramebuffer; texture: WebGLTexture },
      ins: (WebGLTexture | null)[],
      params: Record<string, number> | undefined,
    ): WebGLTexture {
      const g = gl;
      const u = exquisiteUniforms(params);
      g.bindFramebuffer(g.FRAMEBUFFER, slot.fbo);
      g.viewport(0, 0, ctx.res.width, ctx.res.height);
      g.useProgram(exqProgram);
      for (let i = 0; i < 4; i++) {
        g.activeTexture(g.TEXTURE0 + i);
        g.bindTexture(g.TEXTURE_2D, ins[i] ?? dummyTex);
        if (xuIn[i]) g.uniform1i(xuIn[i]!, i);
        if (xuHas[i]) g.uniform1f(xuHas[i]!, ins[i] ? 1 : 0);
      }
      if (xuBands) g.uniform1f(xuBands, u.bands);
      if (xuWarp) g.uniform1f(xuWarp, u.boundaryWarp);
      if (xuSeam) g.uniform1f(xuSeam, u.seamBlend);
      if (xuHue) g.uniform1f(xuHue, u.hueShift);
      ctx.drawFullscreenQuad();
      g.activeTexture(g.TEXTURE0);
      return slot.texture;
    }

    /**
     * Run ONE step of a FRAME-HISTORY op (framedelay/channeldesync/flowsmear/
     * dreammelt/datamosh) into the node's ring. Reads the upstream in0 (+ in1 for
     * dreammelt), the most-recent prev frame, and up to 3 DELAYED taps out of the
     * ring (for framedelay/channeldesync), branching on uOp. Renders into the ring
     * head, advances head, returns the just-rendered texture.
     */
    function runHistoryStep(
      buf: FeedbackBuf,
      kind: string,
      inputTex: WebGLTexture | null,
      inputTex1: WebGLTexture | null,
      params: Record<string, number> | undefined,
    ): WebGLTexture {
      const g = gl;
      if (buf.clearPending) clearFeedbackBuf(buf);
      const u = historyUniforms(kind, params);
      const N = buf.ring.length;
      const dst = buf.ring[buf.head]!;
      const delayLine = !!buf.out; // framedelay / channeldesync (ring = input history)
      // For DELAY-LINE ops we STORE the live input at ring[head] this frame, so a
      // delay of `d` reads ring[head-d] (delay 0 = the just-stored input). For
      // RECURSIVE ops the most-recent rendered slot is ring[head-1], so prev =
      // tap(0) = ring[head-1].
      const tapBase = delayLine ? buf.head : buf.head - 1;
      const tap = (d: number) => buf.ring[(tapBase - d + 100 * N) % N]!;
      const prev = buf.ring[(buf.head - 1 + N) % N]!;
      const bind = (unit: number, tex: WebGLTexture, loc: WebGLUniformLocation | null) => {
        g.activeTexture(g.TEXTURE0 + unit);
        g.bindTexture(g.TEXTURE_2D, tex);
        if (loc) g.uniform1i(loc, unit);
      };
      g.useProgram(histProgram);

      // ── Pass A (delay-line only): STORE the live input into the ring slot, so
      //    the per-channel/frame taps read a TRUE history of the input. ──
      if (delayLine) {
        g.bindFramebuffer(g.FRAMEBUFFER, dst.fbo);
        // Ring targets are ringDims-sized (bufferRes).
        g.viewport(0, 0, ringDims.width, ringDims.height);
        bind(4, inputTex ?? dummyTex, huIn);
        if (huHasIn) g.uniform1f(huHasIn, inputTex ? 1 : 0);
        if (huStorePass) g.uniform1f(huStorePass, 1);
        ctx.drawFullscreenQuad();
      }

      // ── Render pass: the visible output. Delay-line ops read the now-current
      //    ring taps into buf.out; recursive ops render into the ring slot
      //    sampling prev (and that slot IS the output). ──
      const target = delayLine ? buf.out! : dst;
      g.bindFramebuffer(g.FRAMEBUFFER, target.fbo);
      // Both dst + buf.out are ringDims-sized (bufferRes).
      g.viewport(0, 0, ringDims.width, ringDims.height);
      // FRAMEDELAY reads its single delay off uTapB; CHANNELDESYNC reads per-
      // channel taps off uTapR/G/B. (flowsmear/dreammelt/datamosh use uPrev only.)
      const rD = kind === 'channeldesync' ? u.rDelay : 0;
      const gD = kind === 'channeldesync' ? u.gDelay : 0;
      const bD = kind === 'framedelay' ? u.delay : kind === 'channeldesync' ? u.bDelay : 0;
      bind(0, prev.texture, huPrev);
      bind(1, tap(rD).texture, huTapR);
      bind(2, tap(gD).texture, huTapG);
      bind(3, tap(bD).texture, huTapB);
      bind(4, inputTex ?? dummyTex, huIn);
      bind(5, inputTex1 ?? dummyTex, huIn1);
      if (huHasIn) g.uniform1f(huHasIn, inputTex ? 1 : 0);
      if (huHasIn1) g.uniform1f(huHasIn1, inputTex1 ? 1 : 0);
      if (huStorePass) g.uniform1f(huStorePass, 0);
      if (huTexel) g.uniform2f(huTexel, 1 / ringDims.width, 1 / ringDims.height);
      if (huTime) g.uniform1f(huTime, frozenTime() ?? (typeof performance !== 'undefined' ? performance.now() / 1000 : 0));
      if (huOp) g.uniform1i(huOp, u.op);
      if (huMix) g.uniform1f(huMix, u.mix);
      if (huOffset) g.uniform1f(huOffset, u.offsetMag);
      if (huFlowStr) g.uniform1f(huFlowStr, u.flowStrength);
      if (huNoiseScale) g.uniform1f(huNoiseScale, u.noiseScale);
      if (huPersist) g.uniform1f(huPersist, u.persistence);
      if (huMelt) g.uniform1f(huMelt, u.meltAmount);
      if (huDrip) g.uniform1f(huDrip, u.dripSpeed);
      if (huThresh) g.uniform1f(huThresh, u.threshold);
      if (huFlowScale) g.uniform1f(huFlowScale, u.flowScale);
      if (huHold) g.uniform1f(huHold, u.holdGate);
      if (huDecay) g.uniform1f(huDecay, u.decay);
      ctx.drawFullscreenQuad();
      g.activeTexture(g.TEXTURE0);
      const out = target.texture;
      buf.head = (buf.head + 1) % N;
      return out;
    }

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
      // Reconcile the per-feedback-node ping-pong float buffers against the live
      // graph (alloc on add / free on remove) BEFORE rendering this frame's ops.
      reconcileFeedbackBufs(graph);
      // texForNode[id] = the texture each node OUTPUTS (sources → layer tex;
      // ops → their scratch result; feedback → its ping-pong result). undefined =
      // unresolved (no/missing input).
      const texForNode = new Map<string, WebGLTexture | null>();
      // Assign a scratch slot to each op node (deterministic by topo order),
      // starting past the two reserved ping-pong slots so they don't collide
      // if some future caller mixes paths in one frame.
      let scratchSlot = 0;
      // Only the STATELESS single-pass ops have a combineStep uOp index; FEEDBACK
      // / EXQUISITE / the frame-history ops run their own programs (handled
      // separately below). isCombineOpKind is the shared whitelist.
      const opOf = (kind: string): number | null =>
        isCombineOpKind(kind as ToyboxOpKind) ? OP_SHADER_INDEX[kind as ToyboxOpKind] : null;

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
        if (isStatefulKind(n.kind)) {
          // STATEFUL: run the feedback OR a frame-history program against this
          // node's per-node buffer (ping-pong / N-frame ring), sampling its own
          // previous frame(s) + the upstream in0 (+ in1 for dreammelt). The
          // buffer is guaranteed allocated by reconcileFeedbackBufs above.
          const buf = feedbackBufs.get(id);
          if (!buf) { texForNode.set(id, null); continue; }
          const p = n.params ?? {};
          // "Reset" bumps `_reset`; re-arm the clear when it changes (the GL
          // clear is e2e/VRT-only; the *decision* is the pure feedbackResetState).
          const reset = feedbackResetState(buf.resetToken, p);
          if (reset.clear) {
            buf.resetToken = reset.token;
            buf.clearPending = true;
          }
          const inEdge0 = graph.edges.find((e) => e.to === id && e.toPort === 'in0');
          const inputTex = inEdge0 ? texForNode.get(inEdge0.from) ?? null : null;
          if (n.kind === 'feedback') {
            texForNode.set(id, runFeedbackStep(buf, inputTex, p));
          } else {
            // A frame-history op (framedelay/channeldesync/flowsmear/dreammelt/
            // datamosh). dreammelt is 2-input (in1 = the dissolve target).
            const inEdge1 = graph.edges.find((e) => e.to === id && e.toPort === 'in1');
            const inputTex1 = inEdge1 ? texForNode.get(inEdge1.from) ?? null : null;
            texForNode.set(id, runHistoryStep(buf, n.kind, inputTex, inputTex1, p));
          }
          continue;
        }
        // EXQUISITE: own multi-input program (up to 4 feeds, in0..in3).
        if (n.kind === 'exquisite') {
          const inEdge = (port: string) => graph.edges.find((e) => e.to === id && e.toPort === port);
          const texOf = (port: string): WebGLTexture | null => {
            const e = inEdge(port);
            return e ? texForNode.get(e.from) ?? null : null;
          };
          const ins = (['in0', 'in1', 'in2', 'in3'] as const).map(texOf);
          if (!ins.some((t) => t)) { texForNode.set(id, null); continue; }
          const slot = scratch(2 + scratchSlot++);
          texForNode.set(id, runExquisiteStep(slot, ins, n.params));
          continue;
        }

        const op = opOf(n.kind);
        if (op === null) {
          texForNode.set(id, null);
          continue;
        }
        // Gather this op's inputs from incoming edges.
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
        const slot = scratch(2 + scratchSlot++); // past the 2 ping-pong slots
        const ex = combineExtraFor(n.kind as ToyboxOpKind, n.params);
        // 1-input ops (tile/mirror/bitbend/biocells) transform their single in0:
        // base = top = the single feed. The shader reads uBase for these.
        const oneInput = topE === undefined && n.kind !== 'fade' && n.kind !== 'lumakey'
          && n.kind !== 'chromakey' && n.kind !== 'map' && n.kind !== 'over' && n.kind !== 'displace';
        if (oneInput && baseTex) {
          combineStep(baseTex, baseTex, slot.fbo, op, ex.amount, ex);
        } else if (baseTex && !topTex) {
          // 2-input op, top unwired → pass the base through (copy: fade at 0).
          combineStep(baseTex, baseTex, slot.fbo, 0, 0);
        } else if (!baseTex && topTex) {
          // Base unwired → the top IS the result (copy).
          combineStep(topTex, topTex, slot.fbo, 0, 0);
        } else {
          combineStep(baseTex!, topTex!, slot.fbo, op, ex.amount, ex);
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
        // Per-feedback-node ping-pong float buffers (no GL leak).
        for (const b of feedbackBufs.values()) freeFeedbackBuf(b);
        feedbackBufs.clear();
        gl.deleteProgram(objProgram);
        gl.deleteProgram(combineProgram);
        gl.deleteProgram(feedbackProgram);
        gl.deleteProgram(exqProgram);
        gl.deleteProgram(histProgram);
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
 * Migrate saved TOYBOX data forward.
 *
 *  v1 → v2: v1 declared 8 generic input ports (cv1..cv8); v2 reduced the pool to
 *    6. A saved patch may carry cvRoutes for the now-dropped cv7/cv8 — strip them
 *    so they don't linger (their setParam writes are already harmless no-ops, but
 *    a dangling route would show nothing in the 6-row UI). Edges wired to cv7/cv8
 *    are tolerated by the engine (setParam to an unknown port no-ops); we don't
 *    rewrite them (no sensible remap target), so they simply stop doing anything.
 *
 *  v2 → v3: the chromakey combine OP changed from a single `key` channel-select
 *    scalar (0 = R, 0.33 = G, 0.66 = B) to an HSV key COLOUR (keyR/keyG/keyB
 *    floats). Translate any saved combine chromakey node's `key` into the
 *    matching primary RGB and drop the stale `key`. Also strips any chromakey
 *    cvRoute that targeted the now-removed `key` param (its setParam would be a
 *    no-op, but a dangling route would show nothing valid in the param dropdown).
 *
 * Pure: returns the (possibly mutated) data object.
 */
export function migrateToyboxData(data: unknown, fromVersion: number): unknown {
  if (fromVersion >= 4 || !data || typeof data !== 'object') return data;
  const d = data as {
    cvRoutes?: Record<string, { param?: string } | null>;
    combine?: { nodes?: Array<{ kind?: string; params?: Record<string, number> }> };
  };
  if (fromVersion < 2 && d.cvRoutes && typeof d.cvRoutes === 'object') {
    for (const key of Object.keys(d.cvRoutes)) {
      if (!isCvPortId(key)) delete d.cvRoutes[key]; // drops cv7 / cv8 / anything stale
    }
  }
  // v2 → v3: chromakey `key` scalar → keyR/keyG/keyB colour.
  if (fromVersion < 3 && d.combine && Array.isArray(d.combine.nodes)) {
    for (const n of d.combine.nodes) {
      if (n?.kind !== 'chromakey' || !n.params || typeof n.params !== 'object') continue;
      const p = n.params;
      if (typeof p.key === 'number') {
        // Map the old channel-select scalar to a primary RGB key colour.
        const [r, g, b] = p.key < 0.25 ? [1, 0, 0] : p.key < 0.58 ? [0, 1, 0] : [0, 0, 1];
        if (typeof p.keyR !== 'number') p.keyR = r;
        if (typeof p.keyG !== 'number') p.keyG = g;
        if (typeof p.keyB !== 'number') p.keyB = b;
        delete p.key;
      }
    }
  }
  // v2 → v3: drop any chromakey cvRoute that pointed at the removed `key` param.
  if (fromVersion < 3 && d.cvRoutes && typeof d.cvRoutes === 'object') {
    for (const port of Object.keys(d.cvRoutes)) {
      const route = d.cvRoutes[port];
      if (route && route.param === 'key') d.cvRoutes[port] = null;
    }
  }
  // v3 → v4: feedback gained an `intensity` (wet/dry mix) param. Backfill the
  // schema default on existing feedback nodes so old saves load with a sensible
  // half-wet mix rather than 0 (which would read as a pure dry pass-through).
  if (fromVersion < 4 && d.combine && Array.isArray(d.combine.nodes)) {
    for (const n of d.combine.nodes) {
      if (n?.kind !== 'feedback' || !n.params || typeof n.params !== 'object') continue;
      if (typeof n.params.intensity !== 'number') n.params.intensity = 0.5;
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
uniform float uAmount;  // op-dependent: fade.t / lumakey.thr / chromakey.threshold / map.mix
uniform float uSoft;    // lumakey/chromakey edge softness/sharpness (0 = hard)
uniform float uInvert;  // lumakey: >0.5 flips the keep test
uniform float uKeyR;    // chromakey: key colour R (0..1)
uniform float uKeyG;    // chromakey: key colour G (0..1)
uniform float uKeyB;    // chromakey: key colour B (0..1)
uniform float uMode;    // map: 0 = multiply, 1 = screen / mirror: mode / bitbend: op
// ── batch op uniforms (tile/mirror/displace/bitbend/biocells) ──────────────
uniform float uP0;      // generic op param 0 (tilesX / segments / channel / mask / cellCount)
uniform float uP1;      // generic op param 1 (tilesY / rotation / —      / —    / lumaJitter)
uniform float uP2;      // generic op param 2 (mirror / —        / —      / —    / edgeWidth)
uniform float uP3;      // generic op param 3 (offX   / —        / —      / perR / edgeColor)
uniform float uP4;      // generic op param 4 (offY   / —        / —      / perG / —)
uniform float uP5;      // generic op param 5 (rotate / —        / —      / perB / —)

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

// Cheap 2D hash → [0,1]. Used by BIOCELLS for per-cell jitter.
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
mat2 rot2(float a) { float s = sin(a), c = cos(a); return mat2(c, -s, s, c); }

// HSV conversion + hue distance, PORTED VERBATIM from modules/chromakey.ts so
// the in-card chromakey op matches the standalone CHROMAKEY module's keying.
vec3 rgbToHsv(vec3 c) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float v = mx;
  float d = mx - mn;
  float s = (mx > 0.0001) ? d / mx : 0.0;
  float h = 0.0;
  if (d > 0.0001) {
    if (mx == c.r) {
      h = (c.g - c.b) / d;
      if (h < 0.0) h += 6.0;
    } else if (mx == c.g) {
      h = (c.b - c.r) / d + 2.0;
    } else {
      h = (c.r - c.g) / d + 4.0;
    }
    h /= 6.0;
  }
  return vec3(h, s, v);
}
float hueDistance(float a, float b) {
  float d = abs(a - b);
  return min(d, 1.0 - d);
}

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
    // LUMAKEY: keep top where its luma exceeds the THRESHOLD (= amount). SOFT
    // (SHARPNESS) feathers the cut; INVERT flips it (keep BELOW instead).
    float l = luma(t.rgb);
    float keep = smoothstep(a - soft, a + soft + 0.0001, l);
    if (uInvert > 0.5) keep = 1.0 - keep;
    keep *= t.a;
    outc = mix(b.rgb, t.rgb, keep);
  } else if (uOp == 2) {
    // CHROMAKEY: HSV hue-distance key (ported from modules/chromakey.ts).
    // amount = THRESHOLD (how close to the key hue counts as keyed), soft =
    // SHARPNESS (edge feather), keyR/G/B = the key COLOUR. A saturation gate
    // pulls grey-ish pixels toward keep so shadows/highlights aren't keyed.
    vec3 topHSV = rgbToHsv(t.rgb);
    vec3 keyHSV = rgbToHsv(vec3(uKeyR, uKeyG, uKeyB));
    float hd = hueDistance(topHSV.x, keyHSV.x);
    float satGate = smoothstep(0.04, 0.18, topHSV.y);
    float tol  = clamp(a, 0.0, 1.0);
    float sft  = max(clamp(soft, 0.0, 0.5), 0.001);
    float tolH  = tol * 0.5;
    float softH = sft * 0.5;
    float hueAlpha = smoothstep(tolH, tolH + softH, hd);
    // alpha = how much of the TOP to KEEP (1 = keep, 0 = drop to base). Grey
    // pixels (low saturation) are kept regardless of hue noise.
    float keep = mix(1.0, hueAlpha, satGate);
    outc = mix(b.rgb, t.rgb, keep * t.a);
  } else if (uOp == 3) {
    // MAP: top modulates base (MULTIPLY or SCREEN by uMode), mixed by amount.
    vec3 m = uMode > 0.5
      ? (1.0 - (1.0 - b.rgb) * (1.0 - t.rgb))  // screen
      : b.rgb * t.rgb;                          // multiply
    outc = mix(b.rgb, m, a * t.a);
  } else if (uOp == 4) {
    // OVER (2-input): premultiplied source-over. in1 (top) over in0 (base).
    // amount scales the source alpha (OPACITY). Premultiplied:
    //   out.rgb = s.rgb + d.rgb*(1-s.a);  out.a = s.a + d.a*(1-s.a)
    float sa = clamp(t.a * a, 0.0, 1.0);
    vec3 sp = t.rgb * sa;          // premultiply source
    vec3 dp = b.rgb * b.a;         // premultiply dest
    vec3 op = sp + dp * (1.0 - sa);
    float oa = sa + b.a * (1.0 - sa);
    outc = oa > 0.0001 ? op / oa : op;  // un-premultiply for the RGBA8 store
  } else if (uOp == 5) {
    // TILE (1-input): repeat across uP0 x uP1 cells with offset + per-cell
    // rotation; uP2 (mirror) reflects alternating cells instead of wrapping.
    vec2 tiles = max(vec2(uP0, uP1), vec2(1.0));
    vec2 off = vec2(uP3, uP4);
    vec2 tc = vUv * tiles + off;
    vec2 cell = floor(tc);
    vec2 f = fract(tc);
    if (uP2 > 0.5) {
      // mirror: flip f on odd cells so the tiling reflects (seamless).
      vec2 odd = mod(cell, 2.0);
      f = mix(f, 1.0 - f, odd);
    }
    // per-cell rotation about the cell centre.
    f = rot2(uP5) * (f - 0.5) + 0.5;
    outc = texture(uBase, clamp(f, 0.0, 1.0)).rgb;
  } else if (uOp == 6) {
    // MIRROR (1-input): uMode 0 H-flip, 1 V-flip, 2 quad-fold, 3 kaleidoscope.
    int mm = int(uMode + 0.5);
    vec2 muv = vUv;
    if (mm == 0) {
      muv = vec2(vUv.x < 0.5 ? vUv.x * 2.0 : (1.0 - vUv.x) * 2.0, vUv.y);
    } else if (mm == 1) {
      muv = vec2(vUv.x, vUv.y < 0.5 ? vUv.y * 2.0 : (1.0 - vUv.y) * 2.0);
    } else if (mm == 2) {
      // quad-fold: mirror both axes into the lower-left quadrant.
      muv = abs(vUv - 0.5) * 2.0;
    } else {
      // kaleidoscope: fold the polar angle into uP0 wedges + reflect.
      vec2 p = vUv - 0.5;
      float ang = atan(p.y, p.x) + uP1;   // uP1 = rotation
      float rad = length(p);
      float seg = 6.2831853 / max(uP0, 2.0);  // uP0 = segments
      ang = mod(ang, seg);
      ang = abs(ang - seg * 0.5);
      muv = vec2(cos(ang), sin(ang)) * rad + 0.5;
    }
    outc = texture(uBase, clamp(muv, 0.0, 1.0)).rgb;
  } else if (uOp == 7) {
    // DISPLACE (2-input): in1 (top) displaces in0's (base) UVs by uAmount.
    // uMode (channel): 0 = luma scalar displace, 1 = RG vector displace.
    vec2 d = uMode > 0.5 ? (t.rg - 0.5) : vec2(luma(t.rgb) - 0.5);
    vec2 duv = vUv + d * uAmount;
    outc = texture(uBase, clamp(duv, 0.0, 1.0)).rgb;
  } else if (uOp == 8) {
    // BITBEND (1-input): per-channel integer bit-op vs uP0 (mask, 0..255).
    // uMode (op): 0 XOR, 1 AND, 2 OR, 3 bit-rotate. uP3/uP4/uP5 gate R/G/B.
    int mask = int(clamp(uP0, 0.0, 255.0) + 0.5);
    ivec3 ci = ivec3(clamp(b.rgb, 0.0, 1.0) * 255.0 + 0.5);
    int oo = int(uMode + 0.5);
    ivec3 r3 = ci;
    if (oo == 0) r3 = ci ^ ivec3(mask);
    else if (oo == 1) r3 = ci & ivec3(mask);
    else if (oo == 2) r3 = ci | ivec3(mask);
    else {
      // bit-rotate left by (mask & 7) within 8 bits.
      int sh = mask & 7;
      r3 = ((ci << sh) | (ci >> (8 - sh))) & ivec3(255);
    }
    vec3 bent = vec3(r3) / 255.0;
    outc = vec3(
      uP3 > 0.5 ? bent.r : b.r,
      uP4 > 0.5 ? bent.g : b.g,
      uP5 > 0.5 ? bent.b : b.b
    );
  } else {
    // BIOCELLS (1-input, uOp 9): Voronoi cell quantiser. uP0 = cellCount (grid
    // density), uP1 = lumaJitter, uP2 = edgeWidth, uP3 = edgeColor.
    float n = clamp(uP0, 2.0, 64.0);
    vec2 gc = vUv * n;
    vec2 gi = floor(gc);
    vec2 gf = fract(gc);
    float d1 = 8.0, d2 = 8.0;     // nearest + 2nd-nearest
    vec2 bestCell = gi;
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec2 nb = vec2(float(i), float(j));
        vec2 cellId = gi + nb;
        // jitter the cell centre by a hash + the input luma at that cell.
        vec2 jit = vec2(hash21(cellId), hash21(cellId + vec2(13.7, 7.3)));
        float lj = luma(texture(uBase, (cellId + 0.5) / n).rgb);
        jit += (lj - 0.5) * uP1;
        vec2 cp = nb + clamp(jit, 0.0, 1.0) - gf;
        float dd = dot(cp, cp);
        if (dd < d1) { d2 = d1; d1 = dd; bestCell = cellId; }
        else if (dd < d2) { d2 = dd; }
      }
    }
    vec3 cellCol = texture(uBase, (bestCell + 0.5) / n).rgb;
    float edge = smoothstep(0.0, uP2 * 0.5 + 0.001, sqrt(d2) - sqrt(d1));
    outc = mix(vec3(uP3), cellCol, edge);
  }
  outColor = vec4(outc, 1.0);
}`;

function compileCombineProgram(gl: WebGL2RenderingContext): WebGLProgram {
  return linkProgram(gl, COMBINE_VERT_SRC, COMBINE_FRAG_SRC);
}

// ---------------- FEEDBACK shader (the first STATEFUL combine op) ------------
//
// FEEDBACK runs its OWN fullscreen-quad program (NOT combineStep): it samples
// its OWN PREVIOUS frame (uFeedback, the ping-pong float buffer's back texture)
// + the single upstream input (uInput), and writes a NEW frame that becomes next
// frame's previous. The shader switches on uMode (0..11) — see toybox-feedback.ts
// FEEDBACK_MODES for the catalogue. Most modes INJECT a little of uInput into the
// loop each frame so it's driven (not just decaying to a constant). Ranges of the
// uniforms match OP_PARAMS['feedback'] / feedbackUniforms().
//
// Float buffer: the previous frame is an RGBA32F (or degraded RGBA8) texture so
// trails / additive accumulation / reaction-diffusion don't quantise to mush.
const FEEDBACK_FRAG_SRC = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uFeedback;   // this node's PREVIOUS frame (ping-pong back)
uniform sampler2D uInput;      // the upstream in0 texture (drives the loop)
uniform float uHasInput;       // 0 = in0 unwired (input reads black)
uniform vec2  uTexel;          // 1/resolution (for blur / edge taps)
uniform int   uMode;           // 0..11 feedback mode
uniform float uZoom;           // TUNNEL: per-frame zoom (.5..1)
uniform float uRotate;         // TUNNEL/GEOMETRIC: per-frame rotation (±π)
uniform float uScaleP;         // GEOMETRIC: per-frame scale (.5..1.5)
uniform float uTx;             // GEOMETRIC: per-frame translate x (±1)
uniform float uTy;             // GEOMETRIC: per-frame translate y (±1)
uniform float uDecay;          // ADDITIVE/BLUR/EDGE: trail persistence (0..1.5)
uniform float uGain;           // ADDITIVE/DISPLACE/REACTION: input/feedback gain (0..2)
uniform float uThresh;         // LUMAGATE: luma threshold (0..1)
uniform float uHue;            // COLOR: hue-rotate amount (0..1)
uniform float uBlur;           // BLUR: tap radius scale (0..4)
uniform float uSlitPos;        // SLIT: boundary x (0..1)
uniform float uSlitWidth;      // SLIT: boundary feather (0..1)
uniform float uFlow;           // VECTOR: advection strength (0..1)
uniform float uIntensity;      // WET/DRY mix: 0 = dry input, 1 = full effect (0..1)

vec4 fb(vec2 uv) { return texture(uFeedback, clamp(uv, 0.0, 1.0)); }
vec4 inp(vec2 uv) { return uHasInput > 0.5 ? texture(uInput, clamp(uv, 0.0, 1.0)) : vec4(0.0); }
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

mat2 rot(float a) {
  float s = sin(a), c = cos(a);
  return mat2(c, -s, s, c);
}

// Hue rotation by t turns (0..1) around the luma axis.
vec3 hueRotate(vec3 col, float t) {
  float a = t * 6.2831853;
  vec3 k = vec3(0.57735);
  float cs = cos(a), sn = sin(a);
  return col * cs + cross(k, col) * sn + k * dot(k, col) * (1.0 - cs);
}

void main() {
  vec2 uv = vUv;
  vec4 prev = fb(uv);
  vec4 src = inp(uv);
  vec4 outc;

  if (uMode == 0) {
    // TUNNEL — a true recursive Droste / video-feedback hall-of-mirrors: a camera
    // pointed at its own monitor. Each frame the PREVIOUS frame is re-displayed
    // scaled a touch LARGER about the centre + spun, so prior content recedes
    // INWARD to a vanishing point (nested frames → infinite tunnel depth as the
    // loop iterates). The live source enters ONLY at the new outer RING the zoom
    // vacates — exactly the band that falls outside the previous frame. There is
    // ZERO flat full-frame source in the interior: the interior is pure recursive
    // feedback. (Replaces the prior multi-tap composite, which over-composited the
    // flat full-frame source via mix(mirrors, src.rgb, 0.10 + 0.35*src.a) into the
    // whole frame, so at full wet the interior was still ~45% flat source.)
    //
    // uZoom (.5..1) is the per-frame contraction: smaller uZoom => deeper/faster
    // tunnel. We sample the prev frame a factor 1/uZoom (>=1) further from centre,
    // so what's near centre this frame came from a wider region last frame (=> it
    // shrinks inward). uRotate spins the spiral; uDecay is the loop persistence
    // (how fast the receding nest dims toward the vanishing point). uIntensity is
    // the wet/dry mix: fully wet (1) = the PURE hall-of-mirrors (source only in the
    // thin outer ring); fully dry (0) = the live input.
    //
    // The per-pixel ring/interior + tap geometry is mirrored EXACTLY by the pure
    // tunnelTap() in toybox-feedback.ts (unit-tested: at full wet the interior owns
    // the frame, zero flat-source bleed) — keep the two in lock-step if you touch
    // either.
    vec2 d = uv - 0.5;
    d = rot(uRotate) * d;
    float zoom = 1.0 / max(uZoom, 1e-3);     // .5..1 -> 2..1 (>= 1 => recede inward)
    vec2 fuv = 0.5 + d * zoom;
    // The tap is in the new outer ring exactly when it leaves the prev frame.
    bool ring = fuv.x < 0.0 || fuv.x > 1.0 || fuv.y < 0.0 || fuv.y > 1.0;
    vec3 mirror = fb(fuv).rgb * uDecay;       // recursive nesting, dimmed by decay
    // Source ONLY in the new ring; the interior is pure recursive feedback. No
    // flat full-frame source anywhere — a complete hall-of-mirrors at full wet.
    vec3 hall = ring ? src.rgb : mirror;
    // INTENSITY wet/dry: at uIntensity=1 → pure hall (source only in the ring);
    // at uIntensity=0 → the live input. The flat source NEVER floods the interior.
    outc = vec4(mix(src.rgb, hall, uIntensity), 1.0);
  } else if (uMode == 1) {
    // GEOMETRIC — scale + rotate + translate the loop each frame (kaleido drift).
    // INTENSITY raises the feedback contribution (luma-weighted) so trails
    // accumulate noticeably stronger than the old fixed-12% blend.
    vec2 p = (uv - 0.5) * uScaleP;
    p = rot(uRotate) * p;
    p += vec2(uTx, uTy) * 0.1;
    p += 0.5;
    vec3 loop = fb(p).rgb;
    // Feed back MORE the brighter the loop already is (luma-weighted persistence)
    // and the higher INTENSITY is, so the affine drift builds up rich trails.
    float fbAmt = mix(0.55, 0.97, uIntensity);
    fbAmt = clamp(fbAmt + luma(loop) * 0.25 * uIntensity, 0.0, 0.985);
    vec3 acc = loop * fbAmt + src.rgb * (1.0 - fbAmt * 0.5);
    outc = vec4(acc, 1.0);
  } else if (uMode == 2) {
    // SLIT — slit-scan: a moving boundary; left of it holds the loop (trails),
    // right shows the live input. slitWidth feathers the seam.
    float edge = smoothstep(uSlitPos - uSlitWidth - 0.0001, uSlitPos + uSlitWidth, uv.x);
    // Left region samples the loop shifted slightly so it scrolls (a slit-scan).
    vec3 loop = fb(uv + vec2(0.0, 0.0)).rgb;
    vec3 live = src.rgb;
    outc = vec4(mix(loop, live, edge), 1.0);
  } else if (uMode == 3) {
    // ADDITIVE — prev*decay + input*gain (glowing trails; high decay saturates).
    outc = vec4(prev.rgb * uDecay + src.rgb * uGain, 1.0);
  } else if (uMode == 4) {
    // DIFF — abs(input − prev): edge / motion ghosts. Feed a touch of input so a
    // static scene still shows its outline rather than going black.
    vec3 d = abs(src.rgb - prev.rgb);
    outc = vec4(max(d, src.rgb * 0.04), 1.0);
  } else if (uMode == 5) {
    // BLUR — 4-tap diagonal blur of the loop * decay (smoke / diffusion). Inject
    // input so the smoke has a continuous source.
    float r = uBlur;
    vec3 b =
      fb(uv + uTexel * vec2( r,  r)).rgb +
      fb(uv + uTexel * vec2(-r,  r)).rgb +
      fb(uv + uTexel * vec2( r, -r)).rgb +
      fb(uv + uTexel * vec2(-r, -r)).rgb;
    b *= 0.25;
    outc = vec4(b * uDecay + src.rgb * 0.15, 1.0);
  } else if (uMode == 6) {
    // EDGE — gradient of the loop fed back (growing line webs). The old gain
    // (e*4.0 + prev.r*decay*0.5) saturated to white static within a few frames;
    // tame BOTH the edge gain and the feedback term so it grows thin line-webs
    // instead of blowing to noise. The feedback is also leaked toward 0 (the
    // (1-x) factor) so a fully-lit pixel decays rather than self-reinforcing.
    float dx = uTexel.x * (1.0 + uBlur);
    float e = abs(fb(uv + vec2(dx, 0.0)).r - fb(uv - vec2(dx, 0.0)).r) +
              abs(fb(uv + vec2(0.0, dx)).r - fb(uv - vec2(0.0, dx)).r);
    float edge = clamp(e * 1.1, 0.0, 1.0);
    // Leaky feedback: bright pixels lose energy (1.0 - prev.r), so the web stays
    // sparse. uGain trims the edge contribution further (default 1 ⇒ ~0.45).
    float keep = prev.r * uDecay * 0.6 * (1.0 - prev.r);
    float v = clamp(edge * 0.45 * uGain + keep + luma(src.rgb) * 0.05, 0.0, 1.0);
    outc = vec4(vec3(v), 1.0);
  } else if (uMode == 7) {
    // COLOR — hue-rotate the loop each frame (channel cycling). The old
    // uHue*0.1 was barely visible; bump the per-frame rotation rate ~6× so the
    // channel cycling is clearly visible. INTENSITY is the wet/dry mix.
    vec3 c = hueRotate(prev.rgb, uHue * 0.6);
    vec3 wet = mix(c, src.rgb, 0.1 + 0.4 * src.a);
    outc = vec4(mix(src.rgb, wet, uIntensity), 1.0);
  } else if (uMode == 8) {
    // DISPLACE — self-displacement by the loop's RG (liquid / turbulence). The
    // old *0.02 step was too small to read as motion; bump it ~6× (and let uFlow
    // scale it, matching the popover knob) so the liquid/turbulence is visible.
    // INTENSITY is the wet/dry mix.
    vec2 disp = fb(uv).rg - 0.5;
    vec3 d = fb(uv + disp * 0.12 * (0.5 + uFlow)).rgb;
    vec3 wet = mix(d, src.rgb, 0.08 + 0.4 * src.a);
    outc = vec4(mix(src.rgb, wet, uIntensity), 1.0);
  } else if (uMode == 9) {
    // REACTION — reaction-diffusion (cells/spots). The old logistic
    // (b + gain*0.5*b*(1-b)) had no decay, so every cell ratcheted up to b=1 and
    // the whole field went uniform — and the colour map vec3(v,v*0.7,1-v) reads
    // as a flat YELLOW wash at that fixed point. Fix BOTH:
    //  1. Add a Laplacian-driven diffusion + a small DECAY so activity settles
    //     into stable spots instead of saturating everywhere.
    //  2. Map the value through hueRotate (varied colour), not the yellowing
    //     vec3(v, v*0.7, 1-v).
    float r = 1.0 + uBlur;
    float c0 = fb(uv).r;
    float lap =
      (fb(uv + uTexel * vec2( r, 0.0)).r +
       fb(uv + uTexel * vec2(-r, 0.0)).r +
       fb(uv + uTexel * vec2(0.0,  r)).r +
       fb(uv + uTexel * vec2(0.0, -r)).r) * 0.25 - c0;
    // Bounded reaction: a gentle nonlinear bump that PUSHES AWAY from the 0.5
    // mid-point (so cells separate into hi/lo) but is damped by uGain and a small
    // leak toward 0, so it can't run away to a uniform field.
    float react = uGain * 0.18 * (c0 - 0.5) * (1.0 - c0) * c0 * 6.0;
    float v = c0 + lap * 0.35 + react - 0.02 * c0; // diffuse + react − leak
    v = clamp(v + luma(src.rgb) * 0.06, 0.0, 1.0);
    // Varied colour: rotate a teal/magenta base by the value + the THRESH knob so
    // spots read as distinct colours, never a flat yellow.
    vec3 baseCol = vec3(0.2, 0.85, 0.7);
    vec3 col = hueRotate(baseCol, v * 0.5 + uThresh * 0.5) * (0.25 + 0.9 * v);
    outc = vec4(col, 1.0);
  } else if (uMode == 10) {
    // LUMAGATE — keep only bright structure (luma-key persistence). Feed input
    // into the kept region so new bright pixels can join.
    float m = step(uThresh, luma(prev.rgb));
    vec3 kept = prev.rgb * m;
    outc = vec4(max(kept, src.rgb * step(uThresh, luma(src.rgb))), 1.0);
  } else {
    // VECTOR (11) — LZX-style flow-field advection: the input's RG is a velocity
    // field that advects the loop. The old *0.02 step barely moved the image;
    // bump it ~8× (with a flow floor so there's always some drift) so the
    // advection visibly transports the picture. INTENSITY is the wet/dry mix.
    vec2 flowv = src.rg - 0.5;
    vec3 advected = fb(uv + flowv * 0.16 * (0.25 + uFlow)).rgb;
    vec3 wet = mix(advected, src.rgb, 0.06 + 0.3 * src.a);
    outc = vec4(mix(src.rgb, wet, uIntensity), 1.0);
  }

  outColor = vec4(clamp(outc.rgb, 0.0, 8.0), 1.0);
}`;

function compileFeedbackProgram(gl: WebGL2RenderingContext): WebGLProgram {
  return linkProgram(gl, COMBINE_VERT_SRC, FEEDBACK_FRAG_SRC);
}

// ---------------- EXQUISITE shader (multi-input band splicer) ----------------
//
// Splits the frame into uBands horizontal bands; band i shows input (i mod
// #wired). Boundaries are wobbled by uWarp (a per-band sine of the band index +
// uv.x), feathered by uSeam, and alternating bands are hue-shifted by uHue. Reads
// up to 4 input samplers (combineStep only binds 2, so this needs its own
// program). Stateless — rendered into a plain scratch FBO.
const EXQUISITE_FRAG_SRC = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uIn0;
uniform sampler2D uIn1;
uniform sampler2D uIn2;
uniform sampler2D uIn3;
uniform float uHas0;
uniform float uHas1;
uniform float uHas2;
uniform float uHas3;
uniform float uBands;   // 2..8 band count
uniform float uWarp;    // 0..1 boundary wobble
uniform float uSeam;    // 0..1 seam feather
uniform float uHue;     // 0..1 alternating-band hue shift

vec3 hueRotate(vec3 col, float t) {
  float a = t * 6.2831853;
  vec3 k = vec3(0.57735);
  float cs = cos(a), sn = sin(a);
  return col * cs + cross(k, col) * sn + k * dot(k, col) * (1.0 - cs);
}

// Sample input n (0..3); falls back to in0 when n's feed is unwired so a band
// always shows SOMETHING (an exquisite-corpse with a missing limb reuses in0).
vec3 sampleIn(int n, vec2 uv) {
  if (n == 1 && uHas1 > 0.5) return texture(uIn1, uv).rgb;
  if (n == 2 && uHas2 > 0.5) return texture(uIn2, uv).rgb;
  if (n == 3 && uHas3 > 0.5) return texture(uIn3, uv).rgb;
  return texture(uIn0, uv).rgb;
}

// How many inputs are wired (for the i mod #wired band assignment). At least 1.
int wiredCount() {
  int c = 0;
  if (uHas0 > 0.5) c++;
  if (uHas1 > 0.5) c++;
  if (uHas2 > 0.5) c++;
  if (uHas3 > 0.5) c++;
  return max(c, 1);
}

void main() {
  float bands = max(uBands, 2.0);
  // warp the vertical band coordinate by a sine so seams aren't dead-straight.
  float warp = sin(vUv.x * 6.2831853 * 2.0) * uWarp * 0.5 / bands;
  float by = clamp(vUv.y + warp, 0.0, 0.99999);
  float bf = by * bands;
  int band = int(floor(bf));
  int wired = wiredCount();
  int idx = band - (band / wired) * wired;  // band mod wired
  vec3 col = sampleIn(idx, vUv);
  // feather the seam to the next band.
  float frac = fract(bf);
  float seam = uSeam * 0.5;
  if (seam > 0.001 && frac > 1.0 - seam) {
    int nb = band + 1;
    int nidx = nb - (nb / wired) * wired;
    vec3 nc = sampleIn(nidx, vUv);
    float t = (frac - (1.0 - seam)) / seam * 0.5;
    col = mix(col, nc, t);
  }
  // hue-shift alternating bands.
  if (uHue > 0.001 && (band - (band / 2) * 2) == 1) col = hueRotate(col, uHue);
  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

function compileExquisiteProgram(gl: WebGL2RenderingContext): WebGLProgram {
  return linkProgram(gl, COMBINE_VERT_SRC, EXQUISITE_FRAG_SRC);
}

// ---------------- FRAME-HISTORY shader (the 5 stateful batch ops) ------------
//
// ONE program for framedelay/channeldesync/flowsmear/dreammelt/datamosh (uOp
// 0..4). Reads the upstream in0 (+ in1 for dreammelt), the most-recent prev
// frame, and up to 3 DELAYED ring taps (uTapR/G/B = the per-channel / frame-delay
// taps the engine bound from the node's ring). Each op branches on uOp; ranges
// match toybox-history.ts historyUniforms(). Float buffer so delayed taps /
// melt-state / decay don't quantise.
const HISTORY_FRAG_SRC = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uPrev;     // most-recent rendered frame (tap 0)
uniform sampler2D uTapR;     // delayed tap (channeldesync R / —)
uniform sampler2D uTapG;     // delayed tap (channeldesync G / —)
uniform sampler2D uTapB;     // delayed tap (framedelay delay / channeldesync B)
uniform sampler2D uInput;    // upstream in0 (live)
uniform sampler2D uInput1;   // upstream in1 (dreammelt dissolve target)
uniform float uHasInput;
uniform float uHasInput1;
uniform vec2  uTexel;
uniform float uTime;
uniform int   uOp;            // 0 framedelay,1 channeldesync,2 flowsmear,3 dreammelt,4 datamosh
uniform float uMix;           // framedelay
uniform float uOffsetMag;     // channeldesync
uniform float uFlowStrength;  // flowsmear
uniform float uNoiseScale;    // flowsmear
uniform float uPersistence;   // flowsmear
uniform float uMeltAmount;    // dreammelt
uniform float uDripSpeed;     // dreammelt
uniform float uThreshold;     // dreammelt
uniform float uFlowScale;     // datamosh
uniform float uHoldGate;      // datamosh
uniform float uDecay;         // datamosh
uniform float uStorePass;     // 1 = STORE the live input into the ring (delay-line
                              //     ops, pass A); 0 = render the visible output.

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
// value noise for the flow field.
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i), b = hash21(i + vec2(1, 0));
  float c = hash21(i + vec2(0, 1)), d = hash21(i + vec2(1, 1));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
vec2 curl(vec2 p) {
  float e = 0.01;
  float n1 = vnoise(p + vec2(0.0, e));
  float n2 = vnoise(p - vec2(0.0, e));
  float n3 = vnoise(p + vec2(e, 0.0));
  float n4 = vnoise(p - vec2(e, 0.0));
  return vec2((n1 - n2), -(n3 - n4)) / (2.0 * e);
}
vec4 src(vec2 uv) { return uHasInput > 0.5 ? texture(uInput, clamp(uv, 0.0, 1.0)) : vec4(0.0); }
vec4 src1(vec2 uv) { return uHasInput1 > 0.5 ? texture(uInput1, clamp(uv, 0.0, 1.0)) : vec4(0.0); }

void main() {
  vec2 uv = vUv;
  vec4 outc;
  // STORE pass (delay-line ops): just copy the live input into the ring slot so
  // the per-channel/frame taps read a TRUE history of the input (not feedback).
  if (uStorePass > 0.5) {
    outColor = vec4(clamp(src(uv).rgb, 0.0, 8.0), 1.0);
    return;
  }
  if (uOp == 0) {
    // FRAMEDELAY: uTapB is the ring slot delay-frames back (a true input delay).
    // Output = the live input crossfaded with that delayed tap by uMix (mix=1 =
    // pure delay/echo).
    vec3 delayed = texture(uTapB, uv).rgb;
    vec3 live = src(uv).rgb;
    outc = vec4(mix(live, delayed, uMix), 1.0);
  } else if (uOp == 1) {
    // CHANNELDESYNC: each channel reads a DIFFERENT delayed input tap (uTapR/G/B
    // = rDelay/gDelay/bDelay frames back) at its own spatial offset → RGB drift.
    vec2 o = vec2(uOffsetMag, 0.0);
    float r = texture(uTapR, clamp(uv + o, 0.0, 1.0)).r;
    float g = texture(uTapG, clamp(uv, 0.0, 1.0)).g;
    float b = texture(uTapB, clamp(uv - o, 0.0, 1.0)).b;
    outc = vec4(r, g, b, 1.0);
  } else if (uOp == 2) {
    // FLOWSMEAR: curl-noise flow advects the prev frame; persistence mixes with
    // the live input.
    vec2 flow = curl(uv * uNoiseScale + uTime * 0.1);
    vec3 prev = texture(uPrev, clamp(uv - flow * uFlowStrength * 0.02, 0.0, 1.0)).rgb;
    vec3 live = src(uv).rgb;
    outc = vec4(mix(live, prev, uPersistence), 1.0);
  } else if (uOp == 3) {
    // DREAMMELT: pixels drip downward proportional to a melt-state accumulated in
    // the prev frame's alpha; dissolve in0 -> in1 as melt progresses.
    float meltPrev = texture(uPrev, uv).a;
    // accumulate melt where the input is bright enough.
    float lum = luma(src(uv).rgb);
    float grow = step(uThreshold, lum) * uDripSpeed * 0.1;
    float melt = clamp(meltPrev + grow * uMeltAmount, 0.0, 1.0);
    // sample from ABOVE proportional to melt (the drip).
    vec2 drip = vec2(0.0, melt * uMeltAmount * 0.3);
    vec3 a = src(uv + drip).rgb;
    vec3 b = src1(uv + drip).rgb;
    vec3 col = mix(a, b, melt);
    outc = vec4(col, melt);
  } else {
    // DATAMOSH: estimate flow from luma gradient + temporal diff, advect prev
    // OUTPUT by it, withhold new input while the HOLD gate is active, decay.
    vec3 cur = src(uv).rgb;
    vec3 pv = texture(uPrev, uv).rgb;
    float It = luma(cur) - luma(pv);
    vec2 gI = vec2(
      luma(src(uv + vec2(uTexel.x, 0.0)).rgb) - luma(src(uv - vec2(uTexel.x, 0.0)).rgb),
      luma(src(uv + vec2(0.0, uTexel.y)).rgb) - luma(src(uv - vec2(0.0, uTexel.y)).rgb)
    );
    vec2 flow = -(It * gI) / (dot(gI, gI) + 0.001);
    vec3 advected = texture(uPrev, clamp(uv - flow * uFlowScale * 0.05, 0.0, 1.0)).rgb;
    // HOLD gate: when the per-pixel motion exceeds the gate, KEEP the smear
    // (P-frame) instead of accepting the new input (I-frame); else accept input.
    float motion = abs(It);
    float hold = step(uHoldGate * 0.5, motion);
    vec3 moshed = mix(cur, advected * uDecay, hold);
    outc = vec4(moshed, 1.0);
  }
  outColor = vec4(clamp(outc.rgb, 0.0, 8.0), outc.a);
}`;

function compileHistoryProgram(gl: WebGL2RenderingContext): WebGLProgram {
  return linkProgram(gl, COMBINE_VERT_SRC, HISTORY_FRAG_SRC);
}

/** TEST-ONLY: the feedback fragment GLSL, exposed so a unit test can assert the
 *  shader switches on every one of the 12 modes (it is GLSL, not extractable as
 *  a pure JS helper). Not used by the engine. */
export const __FEEDBACK_FRAG_SRC_FOR_TEST = FEEDBACK_FRAG_SRC;

/** TEST-ONLY: the combine fragment GLSL, exposed so a unit test can assert the
 *  chromakey HSV keying was ported from chromakey.ts verbatim (it is GLSL, not
 *  extractable as a pure JS helper). Not used by the engine. */
export const __COMBINE_FRAG_SRC_FOR_TEST = COMBINE_FRAG_SRC;

/** TEST-ONLY: the EXQUISITE + FRAME-HISTORY fragment GLSL, exposed so a unit test
 *  can assert each program declares its inputs + branches on every op. */
export const __EXQUISITE_FRAG_SRC_FOR_TEST = EXQUISITE_FRAG_SRC;
export const __HISTORY_FRAG_SRC_FOR_TEST = HISTORY_FRAG_SRC;

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
uniform float uGain;       // BRIGHTNESS: RGB multiplier (#57 CV target)
uniform float uOpacity;    // OPACITY: written into alpha so combine fades it (#57 CV target)
void main() {
  if (uHasInput < 0.5) {
    // Idle: subtle dark teal with a faint vertical ramp (PICTUREBOX +
    // VIDEOBOX idle look) so an empty input layer reads as alive-but-empty.
    float v = vUv.y * 0.05;
    outColor = vec4(0.04, 0.07, 0.09 + v, 1.0);
    return;
  }
  // BRIGHTNESS scales RGB; OPACITY is written to alpha so the alpha-aware
  // combine ops (fade/lumakey/chromakey/map all multiply by t.a) honour it.
  vec3 col = texture(uTex, vUv).rgb * uGain;
  outColor = vec4(clamp(col, 0.0, 1.0), clamp(uOpacity, 0.0, 1.0));
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

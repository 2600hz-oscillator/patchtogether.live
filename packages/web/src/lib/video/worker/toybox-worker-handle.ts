// packages/web/src/lib/video/worker/toybox-worker-handle.ts
//
// Fix E Phase 2 — the WORKER-SIDE TOYBOX renderer (texture co-processor).
//
// TOYBOX is the most complex video module in the codebase (3377-line main-
// thread factory). This file implements the SUBSET of its rendering that is
// safe to run in a worker: pure-GL, DOM-free layers with no video/image inputs
// and no Yjs reads. Main-thread video/image layers render black quads here
// (Phase 2B will add cross-thread texture sharing; for now they gracefully
// degrade).
//
// Architecture:
//  - The main-thread TOYBOX factory keeps running unmodified (it still handles
//    the full render, CV routing, video uploaders, card extras, Yjs reads, etc.)
//  - When renderLocus:'worker' is active, a WorkerProxyHandle wraps the main-
//    thread factory. The proxy also sets up a poll timer that sends a
//    MsgToyboxSync whenever node.data changes, carrying the serialized
//    layers+combine snapshot.
//  - On the worker side, this module maintains a state snapshot received via
//    MsgToyboxSync and renders ELIGIBLE layers (shader/gen/frag/obj) into FBOs
//    using the same GL programs as the main-thread factory. Video/image layers
//    render a black placeholder quad.
//  - Finished frames transfer as ImageBitmaps to the main thread exactly like
//    ACIDWARP — WorkerProxyHandle uploads each bitmap into a main-GL texture
//    that downstream + OUTPUT sample identically.
//
// Worker-eligible layer kinds (Phase 2A):
//   'shader', 'gen', 'frag'  — fragment-shader + Shadertoy single-pass content
//   'obj'                    — 3D mesh (built-in primitives + bundled OBJs)
//   'background'             — solid fill (stub, rendered as black for now)
//   'off'                    — empty, cleared to transparent
//
// Ineligible layers (Phase 2A, render black):
//   'video'  — patched feed / file / camera (requires DOM or cross-thread tex)
//   'image'  — card-uploaded ImageBitmap (requires DOM bridge)
//
// Combine graph: fully supported (all stateless + stateful ops).
// Feedback rings: fully supported (ping-pong float FBOs).
// CV routing: the main thread resolves CV→param values and sends setParam()
//   calls which forward to the worker via MsgSetParam — the worker does not
//   need to know about cvRoutes at all.
//
// IMPORTANT: this file must NOT import from '$lib/graph/store', '$lib/graph',
// or any Svelte module — those are DOM-bound and would break the worker bundle.

import type { VideoEngineContext, VideoNodeHandle, VideoNodeSurface, VideoFrameContext } from '$lib/video/engine';
import type { ModuleNode } from '$lib/graph/types';
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
  type ToyboxLayer,
} from '$lib/video/toybox-content';
import { buildProjectorViewProj, projectorFromMaterial } from '$lib/video/toybox-projective';
import {
  OP_SHADER_INDEX,
  isCombineGraph,
  isCombineOpKind,
  isStatefulKind,
  isMeltStateKind,
  opHistoryDepth,
  combineExtraFor,
  exquisiteUniforms,
  makeDefaultCombineGraph,
  propagateFreshness,
  topoSort,
  type ToyboxCombineGraph,
  type ToyboxOpKind,
} from '$lib/video/toybox-combine-graph';
import { type ToyboxCombine } from '$lib/video/toybox-content';
import { historyUniforms } from '$lib/video/toybox-history';
import { feedbackUniforms, feedbackResetState } from '$lib/video/toybox-feedback';
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
} from '$lib/video/mat4';

// ---- OBJ matcap vertex + fragment shaders (verbatim from toybox.ts) ----
const OBJ_VERT_SRC = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec2 aUv;
uniform mat4 uMVP;
uniform mat4 uModel;
uniform mat3 uNormalMat;
out vec3 vNormal;
out vec2 vUv;
out vec3 vWorldPos;
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
uniform int uMatcap;
uniform vec3 uTint;
uniform sampler2D uSurface;
uniform int uUseSurface;
uniform float uSurfaceMix;
uniform int uProjMode;
uniform mat4 uProjVP;
uniform vec3 uProjEye;
vec3 matcap(vec2 muv, int style) {
  vec2 c = muv * 2.0 - 1.0;
  float r = clamp(length(c), 0.0, 1.0);
  float rim = pow(r, 3.0);
  float core = 1.0 - r;
  float key = clamp(dot(normalize(vec3(c, 0.6)), normalize(vec3(-0.5, 0.6, 0.6))), 0.0, 1.0);
  key = pow(key, 2.0);
  if (style == 0) {
    vec3 base = mix(vec3(0.10, 0.12, 0.16), vec3(0.55, 0.62, 0.72), core);
    base += vec3(0.9) * pow(key, 6.0);
    base += vec3(0.25, 0.35, 0.5) * rim;
    return base;
  } else if (style == 1) {
    vec3 base = mix(vec3(0.18, 0.10, 0.08), vec3(0.78, 0.52, 0.40), 0.3 + 0.7 * key);
    base += vec3(0.15, 0.10, 0.08) * rim;
    return base;
  } else {
    vec3 inner = vec3(0.02, 0.0, 0.05);
    vec3 edge = mix(vec3(0.0, 1.0, 0.9), vec3(1.0, 0.1, 0.8), muv.x);
    vec3 base = mix(inner, edge, pow(r, 2.0));
    base += edge * pow(key, 3.0) * 0.6;
    return base;
  }
}
void main() {
  vec3 n = normalize(vNormal);
  vec2 muv = n.xy * 0.5 + 0.5;
  vec3 mat = matcap(muv, uMatcap);
  vec3 outc = mat;
  if (uUseSurface == 1) {
    float mixAmt = clamp(uSurfaceMix, 0.0, 1.0);
    if (uProjMode == 1) {
      vec4 clip = uProjVP * vec4(vWorldPos, 1.0);
      if (clip.w > 1e-4) {
        vec3 ndc = clip.xyz / clip.w;
        vec2 ps = ndc.xy * 0.5 + 0.5;
        vec3 toProj = normalize(uProjEye - vWorldPos);
        bool front = dot(n, toProj) > 0.0;
        bool inFrustum = ps.x >= 0.0 && ps.x <= 1.0 && ps.y >= 0.0 && ps.y <= 1.0 && ndc.z >= -1.0 && ndc.z <= 1.0;
        if (front && inFrustum) {
          vec3 surf = texture(uSurface, vec2(ps.x, 1.0 - ps.y)).rgb;
          outc = mix(mat, surf, mixAmt);
        }
      }
    } else {
      vec3 surf = texture(uSurface, vec2(vUv.x, 1.0 - vUv.y)).rgb;
      outc = mix(mat, surf, mixAmt);
    }
  }
  outColor = vec4(outc * uTint, 1.0);
}`;

// ---- Combine (stateless blend) ----
const COMBINE_VERT_SRC = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// (COMBINE_FRAG_SRC is large but must be verbatim — copy from toybox.ts)
const COMBINE_FRAG_SRC = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uBase;
uniform sampler2D uTop;
uniform int uOp;
uniform float uAmount;
uniform float uSoft;
uniform float uInvert;
uniform float uKeyR;
uniform float uKeyG;
uniform float uKeyB;
uniform float uMode;
uniform float uP0;
uniform float uP1;
uniform float uP2;
uniform float uP3;
uniform float uP4;
uniform float uP5;
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
mat2 rot2(float a) { float s = sin(a), c = cos(a); return mat2(c, -s, s, c); }
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
float hueDistance(float a, float b) { float d = abs(a - b); return min(d, 1.0 - d); }
void main() {
  vec4 b = texture(uBase, vUv);
  vec4 t = texture(uTop, vUv);
  vec3 outc = b.rgb;
  float a = clamp(uAmount, 0.0, 1.0);
  float soft = max(0.0, uSoft);
  if (uOp == 0) {
    float k = a * t.a; outc = mix(b.rgb, t.rgb, k);
  } else if (uOp == 1) {
    float l = luma(t.rgb);
    float keep = smoothstep(a - soft, a + soft + 0.0001, l);
    if (uInvert > 0.5) keep = 1.0 - keep;
    keep *= t.a; outc = mix(b.rgb, t.rgb, keep);
  } else if (uOp == 2) {
    vec3 topHSV = rgbToHsv(t.rgb);
    vec3 keyHSV = rgbToHsv(vec3(uKeyR, uKeyG, uKeyB));
    float hd = hueDistance(topHSV.x, keyHSV.x);
    float satGate = smoothstep(0.04, 0.18, topHSV.y);
    float tol = clamp(a, 0.0, 1.0);
    float sft = max(clamp(soft, 0.0, 0.5), 0.001);
    float tolH = tol * 0.5; float softH = sft * 0.5;
    float hueAlpha = smoothstep(tolH, tolH + softH, hd);
    float keep = mix(1.0, hueAlpha, satGate);
    outc = mix(b.rgb, t.rgb, keep * t.a);
  } else if (uOp == 3) {
    vec3 m = uMode > 0.5 ? (1.0-(1.0-b.rgb)*(1.0-t.rgb)) : b.rgb*t.rgb;
    outc = mix(b.rgb, m, a * t.a);
  } else if (uOp == 4) {
    float sa = clamp(t.a * a, 0.0, 1.0);
    vec3 sp = t.rgb * sa; vec3 dp = b.rgb * b.a;
    vec3 op = sp + dp * (1.0 - sa);
    float oa = sa + b.a * (1.0 - sa);
    outc = oa > 0.0001 ? op / oa : op;
  } else if (uOp == 5) {
    vec2 tiles = max(vec2(uP0, uP1), vec2(1.0));
    vec2 off = vec2(uP3, uP4);
    vec2 tc = vUv * tiles + off;
    vec2 cell = floor(tc); vec2 f = fract(tc);
    if (uP2 > 0.5) { vec2 odd = mod(cell, 2.0); f = mix(f, 1.0-f, odd); }
    f = rot2(uP5) * (f - 0.5) + 0.5;
    outc = texture(uBase, clamp(f, 0.0, 1.0)).rgb;
  } else if (uOp == 6) {
    int mm = int(uMode + 0.5); vec2 muv = vUv;
    if (mm == 0) { muv = vec2(vUv.x < 0.5 ? vUv.x*2.0 : (1.0-vUv.x)*2.0, vUv.y); }
    else if (mm == 1) { muv = vec2(vUv.x, vUv.y < 0.5 ? vUv.y*2.0 : (1.0-vUv.y)*2.0); }
    else if (mm == 2) { muv = abs(vUv - 0.5) * 2.0; }
    else {
      vec2 p = vUv - 0.5;
      float ang = atan(p.y, p.x) + uP1;
      float rad = length(p);
      float seg = 6.2831853 / max(uP0, 2.0);
      ang = mod(ang, seg); ang = abs(ang - seg * 0.5);
      muv = vec2(cos(ang), sin(ang)) * rad + 0.5;
    }
    outc = texture(uBase, clamp(muv, 0.0, 1.0)).rgb;
  } else if (uOp == 7) {
    vec2 d = uMode > 0.5 ? (t.rg - 0.5) : vec2(luma(t.rgb) - 0.5);
    outc = texture(uBase, clamp(vUv + d * uAmount, 0.0, 1.0)).rgb;
  } else if (uOp == 8) {
    int mask = int(clamp(uP0, 0.0, 255.0) + 0.5);
    ivec3 ci = ivec3(clamp(b.rgb, 0.0, 1.0) * 255.0 + 0.5);
    int oo = int(uMode + 0.5); ivec3 r3 = ci;
    if (oo == 0) r3 = ci ^ ivec3(mask);
    else if (oo == 1) r3 = ci & ivec3(mask);
    else if (oo == 2) r3 = ci | ivec3(mask);
    else { int sh = mask & 7; r3 = ((ci << sh) | (ci >> (8 - sh))) & ivec3(255); }
    vec3 bent = vec3(r3) / 255.0;
    outc = vec3(uP3 > 0.5 ? bent.r : b.r, uP4 > 0.5 ? bent.g : b.g, uP5 > 0.5 ? bent.b : b.b);
  } else {
    float n = clamp(uP0, 2.0, 64.0);
    vec2 gc = vUv * n; vec2 gi = floor(gc); vec2 gf = fract(gc);
    float d1 = 8.0, d2 = 8.0; vec2 bestCell = gi;
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec2 nb = vec2(float(i), float(j)); vec2 cellId = gi + nb;
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

const FEEDBACK_FRAG_SRC = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uFeedback;
uniform sampler2D uInput;
uniform float uHasInput;
uniform vec2 uTexel;
uniform int uMode;
uniform float uZoom; uniform float uRotate; uniform float uScaleP;
uniform float uTx; uniform float uTy; uniform float uDecay; uniform float uGain;
uniform float uThresh; uniform float uHue; uniform float uBlur;
uniform float uSlitPos; uniform float uSlitWidth; uniform float uFlow;
uniform float uIntensity;
vec4 fb(vec2 uv) { return texture(uFeedback, clamp(uv,0.0,1.0)); }
vec4 inp(vec2 uv) { return uHasInput>0.5?texture(uInput,clamp(uv,0.0,1.0)):vec4(0.0); }
float luma(vec3 c){return dot(c,vec3(0.299,0.587,0.114));}
mat2 rot(float a){float s=sin(a),c=cos(a);return mat2(c,-s,s,c);}
vec3 hueRotate(vec3 col,float t){
  float a=t*6.2831853; vec3 k=vec3(0.57735);
  float cs=cos(a),sn=sin(a);
  return col*cs+cross(k,col)*sn+k*dot(k,col)*(1.0-cs);
}
void main(){
  vec2 uv=vUv;
  vec4 prev=fb(uv); vec4 src=inp(uv); vec4 outc;
  if(uMode==0){
    vec2 d=uv-0.5; d=rot(uRotate)*d;
    float zoom=1.0/max(uZoom,1e-3); vec2 fuv=0.5+d*zoom;
    bool ring=fuv.x<0.0||fuv.x>1.0||fuv.y<0.0||fuv.y>1.0;
    vec3 mirror=fb(fuv).rgb*uDecay;
    vec3 hall=ring?src.rgb:mirror;
    outc=vec4(mix(src.rgb,hall,uIntensity),1.0);
  } else if(uMode==1){
    vec2 p=(uv-0.5)*uScaleP; p=rot(uRotate)*p; p+=vec2(uTx,uTy)*0.1; p+=0.5;
    vec3 loop=fb(p).rgb;
    float fbAmt=mix(0.55,0.97,uIntensity);
    fbAmt=clamp(fbAmt+luma(loop)*0.25*uIntensity,0.0,0.985);
    outc=vec4(loop*fbAmt+src.rgb*(1.0-fbAmt*0.5),1.0);
  } else if(uMode==2){
    float edge=smoothstep(uSlitPos-uSlitWidth-0.0001,uSlitPos+uSlitWidth,uv.x);
    vec3 loop=fb(uv).rgb;
    outc=vec4(mix(loop,src.rgb,edge),1.0);
  } else if(uMode==3){
    outc=vec4(prev.rgb*uDecay+src.rgb*uGain,1.0);
  } else if(uMode==4){
    vec3 d=abs(src.rgb-prev.rgb);
    outc=vec4(max(d,src.rgb*0.04),1.0);
  } else if(uMode==5){
    float r=uBlur;
    vec3 bl=(fb(uv+uTexel*vec2(r,r)).rgb+fb(uv+uTexel*vec2(-r,r)).rgb+
             fb(uv+uTexel*vec2(r,-r)).rgb+fb(uv+uTexel*vec2(-r,-r)).rgb)*0.25;
    outc=vec4(bl*uDecay+src.rgb*0.15,1.0);
  } else if(uMode==6){
    float dx=uTexel.x*(1.0+uBlur);
    float e=abs(fb(uv+vec2(dx,0.0)).r-fb(uv-vec2(dx,0.0)).r)+
            abs(fb(uv+vec2(0.0,dx)).r-fb(uv-vec2(0.0,dx)).r);
    float edge2=clamp(e*1.1,0.0,1.0);
    float keep=prev.r*uDecay*0.6*(1.0-prev.r);
    float v=clamp(edge2*0.45*uGain+keep+luma(src.rgb)*0.05,0.0,1.0);
    outc=vec4(vec3(v),1.0);
  } else if(uMode==7){
    vec3 c=hueRotate(prev.rgb,uHue*0.6);
    vec3 wet=mix(c,src.rgb,0.1+0.4*src.a);
    outc=vec4(mix(src.rgb,wet,uIntensity),1.0);
  } else if(uMode==8){
    vec2 disp=fb(uv).rg-0.5;
    vec3 d=fb(uv+disp*0.12*(0.5+uFlow)).rgb;
    vec3 wet=mix(d,src.rgb,0.08+0.4*src.a);
    outc=vec4(mix(src.rgb,wet,uIntensity),1.0);
  } else if(uMode==9){
    float r=1.0+uBlur;
    float c0=fb(uv).r;
    float lap=(fb(uv+uTexel*vec2(r,0.0)).r+fb(uv-uTexel*vec2(r,0.0)).r+
               fb(uv+uTexel*vec2(0.0,r)).r+fb(uv-uTexel*vec2(0.0,r)).r)*0.25-c0;
    float react=uGain*0.18*(c0-0.5)*(1.0-c0)*c0*6.0;
    float v=c0+lap*0.35+react-0.02*c0;
    v=clamp(v+luma(src.rgb)*0.06,0.0,1.0);
    vec3 baseCol=vec3(0.2,0.85,0.7);
    vec3 col=hueRotate(baseCol,v*0.5+uThresh*0.5)*(0.25+0.9*v);
    outc=vec4(col,1.0);
  } else if(uMode==10){
    float m=step(uThresh,luma(prev.rgb));
    vec3 kept=prev.rgb*m;
    outc=vec4(max(kept,src.rgb*step(uThresh,luma(src.rgb))),1.0);
  } else {
    vec2 flowv=src.rg-0.5;
    vec3 advected=fb(uv+flowv*0.16*(0.25+uFlow)).rgb;
    vec3 wet=mix(advected,src.rgb,0.06+0.3*src.a);
    outc=vec4(mix(src.rgb,wet,uIntensity),1.0);
  }
  outColor=vec4(clamp(outc.rgb,0.0,8.0),1.0);
}`;

const EXQUISITE_FRAG_SRC = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uIn0; uniform sampler2D uIn1; uniform sampler2D uIn2; uniform sampler2D uIn3;
uniform float uHas0; uniform float uHas1; uniform float uHas2; uniform float uHas3;
uniform float uBands; uniform float uWarp; uniform float uSeam; uniform float uHue;
vec3 hueRotate(vec3 col,float t){
  float a=t*6.2831853; vec3 k=vec3(0.57735);
  float cs=cos(a),sn=sin(a);
  return col*cs+cross(k,col)*sn+k*dot(k,col)*(1.0-cs);
}
vec3 sampleIn(int n,vec2 uv){
  if(n==1&&uHas1>0.5)return texture(uIn1,uv).rgb;
  if(n==2&&uHas2>0.5)return texture(uIn2,uv).rgb;
  if(n==3&&uHas3>0.5)return texture(uIn3,uv).rgb;
  return texture(uIn0,uv).rgb;
}
int wiredCount(){
  int c=0;
  if(uHas0>0.5)c++; if(uHas1>0.5)c++; if(uHas2>0.5)c++; if(uHas3>0.5)c++;
  return max(c,1);
}
int wiredSlot(int k){
  int seen=0;
  if(uHas0>0.5){if(seen==k)return 0;seen++;}
  if(uHas1>0.5){if(seen==k)return 1;seen++;}
  if(uHas2>0.5){if(seen==k)return 2;seen++;}
  if(uHas3>0.5){if(seen==k)return 3;seen++;}
  return 0;
}
void main(){
  float bands=max(uBands,2.0);
  float warp=sin(vUv.x*6.2831853*2.0)*uWarp*0.5/bands;
  float by=clamp(vUv.y+warp,0.0,0.99999);
  float bf=by*bands;
  int band=int(floor(bf));
  int wired=wiredCount();
  int slot=band-(band/wired)*wired;
  int idx=wiredSlot(slot);
  vec3 col=sampleIn(idx,vUv);
  float frac=fract(bf);
  float seam=uSeam*0.5;
  if(seam>0.001&&frac>1.0-seam){
    int nb=band+1; int nslot=nb-(nb/wired)*wired; int nidx=wiredSlot(nslot);
    vec3 nc=sampleIn(nidx,vUv);
    float t=(frac-(1.0-seam))/seam*0.5;
    col=mix(col,nc,t);
  }
  if(uHue>0.001&&(band-(band/2)*2)==1)col=hueRotate(col,uHue);
  outColor=vec4(clamp(col,0.0,1.0),1.0);
}`;

// NOTE: HISTORY_FRAG_SRC is long and needed for framedelay/channeldesync/etc.
// We copy it verbatim from toybox.ts so the worker shader parity is maintained.
const HISTORY_FRAG_SRC = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uPrev;
uniform sampler2D uTapR; uniform sampler2D uTapG; uniform sampler2D uTapB;
uniform sampler2D uInput; uniform sampler2D uInput1;
uniform float uHasInput; uniform float uHasInput1;
uniform vec2 uTexel; uniform float uTime; uniform int uOp;
uniform float uMix; uniform float uOffsetMag; uniform float uFlowStrength;
uniform float uNoiseScale; uniform float uPersistence;
uniform float uMeltAmount; uniform float uDripSpeed; uniform float uThreshold;
uniform float uFlowScale; uniform float uHoldGate; uniform float uDecay;
uniform float uStorePass;
float luma(vec3 c){return dot(c,vec3(0.299,0.587,0.114));}
float hash21(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
float vnoise(vec2 p){
  vec2 i=floor(p),f=fract(p);
  vec2 u=f*f*(3.0-2.0*f);
  float a=hash21(i),b=hash21(i+vec2(1,0)),c=hash21(i+vec2(0,1)),d=hash21(i+vec2(1,1));
  return mix(mix(a,b,u.x),mix(c,d,u.x),u.y);
}
vec2 curl(vec2 p){
  float e=0.01;
  return vec2((vnoise(p+vec2(0,e))-vnoise(p-vec2(0,e))),(-(vnoise(p+vec2(e,0))-vnoise(p-vec2(e,0)))))/(2.0*e);
}
vec4 src(vec2 uv){return uHasInput>0.5?texture(uInput,clamp(uv,0.0,1.0)):vec4(0.0);}
vec4 src1(vec2 uv){return uHasInput1>0.5?texture(uInput1,clamp(uv,0.0,1.0)):vec4(0.0);}
void main(){
  vec2 uv=vUv; vec4 outc;
  if(uStorePass>0.5){outColor=vec4(clamp(src(uv).rgb,0.0,8.0),1.0);return;}
  if(uOp==0){
    vec3 delayed=texture(uTapB,uv).rgb;
    outc=vec4(mix(src(uv).rgb,delayed,uMix),1.0);
  } else if(uOp==1){
    vec2 o=vec2(uOffsetMag,0.0);
    float r=texture(uTapR,clamp(uv+o,0.0,1.0)).r;
    float g=texture(uTapG,clamp(uv,0.0,1.0)).g;
    float b=texture(uTapB,clamp(uv-o,0.0,1.0)).b;
    outc=vec4(r,g,b,1.0);
  } else if(uOp==2){
    vec2 flow=curl(uv*uNoiseScale+uTime*0.1);
    vec3 prev=texture(uPrev,clamp(uv-flow*uFlowStrength*0.02,0.0,1.0)).rgb;
    outc=vec4(mix(src(uv).rgb,prev,uPersistence),1.0);
  } else if(uOp==3){
    float meltPrev=texture(uPrev,uv).a;
    float lum=luma(src(uv).rgb);
    float grow=step(uThreshold,lum)*uDripSpeed*0.1;
    float melt=clamp(meltPrev+grow*uMeltAmount,0.0,1.0);
    vec2 drip=vec2(0.0,melt*uMeltAmount*0.3);
    vec3 a=src(uv+drip).rgb;
    vec3 b=src1(uv+drip).rgb;
    outc=vec4(mix(a,b,melt),melt);
  } else {
    vec3 cur=src(uv).rgb; vec3 pv=texture(uPrev,uv).rgb;
    float It=luma(cur)-luma(pv);
    vec2 gI=vec2(
      luma(src(uv+vec2(uTexel.x,0.0)).rgb)-luma(src(uv-vec2(uTexel.x,0.0)).rgb),
      luma(src(uv+vec2(0.0,uTexel.y)).rgb)-luma(src(uv-vec2(0.0,uTexel.y)).rgb));
    vec2 flow=-(It*gI)/(dot(gI,gI)+0.001);
    vec3 advected=texture(uPrev,clamp(uv-flow*uFlowScale*0.05,0.0,1.0)).rgb;
    float motion=abs(It);
    float hold=step(uHoldGate*0.5,motion);
    outc=vec4(mix(cur,advected*uDecay,hold),1.0);
  }
  outColor=vec4(clamp(outc.rgb,0.0,8.0),outc.a);
}`;

// ---- Internal types ----

/** ToyboxNodeData shape we receive from main thread via MsgToyboxSync. */
interface ToyboxNodeData {
  layers?: ToyboxLayer[];
  combine?: unknown;
  cvRoutes?: unknown;
}

interface CompiledShader {
  program: WebGLProgram;
  shadertoy: boolean;
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

interface LayerTarget {
  fbo: WebGLFramebuffer;
  texture: WebGLTexture;
  depth: WebGLRenderbuffer;
}

interface GpuMesh {
  vao: WebGLVertexArrayObject;
  vbo: WebGLBuffer;
  ibo: WebGLBuffer;
  indexCount: number;
  frameCenter: [number, number, number];
  frameScale: number;
}

interface FloatTarget { fbo: WebGLFramebuffer; texture: WebGLTexture }
interface FeedbackBuf {
  ring: FloatTarget[];
  head: number;
  out?: FloatTarget;
  kind: string;
  clearPending: boolean;
  resetToken: number;
}

// ---- compile helpers ----

function compileShaderSrc(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error('TOYBOX-worker: createShader failed');
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`TOYBOX-worker: shader compile failed: ${log}`);
  }
  return sh;
}

function linkProg(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
  const vs = compileShaderSrc(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compileShaderSrc(gl, gl.FRAGMENT_SHADER, fsSrc);
  const prog = gl.createProgram();
  if (!prog) throw new Error('TOYBOX-worker: createProgram failed');
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error(`TOYBOX-worker: program link failed: ${log}`);
  }
  return prog;
}

/**
 * The worker-side TOYBOX factory.
 *
 * Returns a VideoNodeHandle whose `surface.draw()` renders the eligible layers
 * (shader/gen/frag/obj) from the last-received state snapshot and composites
 * them via the combine graph. Ineligible layers (video/image) render as black.
 *
 * The handle exposes a `syncState(data)` method (accessed via the worker
 * engine's per-node dispatch in `worker-engine.ts`) that the render-worker
 * calls when a MsgToyboxSync arrives.
 */
export function createToyboxWorkerHandle(
  ctx: VideoEngineContext,
  node: ModuleNode,
): VideoNodeHandle {
  const gl = ctx.gl;

  // The module's output FBO.
  const { fbo: outFbo, texture: outTexture } = ctx.createFbo();

  void ensureToyboxCatalog();

  // ---- Per-layer FBOs (colour + depth) ----
  const layerTargets: LayerTarget[] = [];
  for (let i = 0; i < LAYER_COUNT; i++) {
    const { fbo, texture } = ctx.createFbo({ managed: false });
    const depth = gl.createRenderbuffer();
    if (!depth) throw new Error('TOYBOX-worker: createRenderbuffer (depth) failed');
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, ctx.res.width, ctx.res.height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    layerTargets.push({ fbo, texture, depth });
  }

  // Dummy 1×1 texture for unbound samplers.
  const dummyTex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, dummyTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.bindTexture(gl.TEXTURE_2D, null);

  // ---- Content shader programs ----
  const programs = new Map<string, CompiledShader>();
  const inflightShader = new Set<string>();
  const failedShader = new Set<string>();

  function stUniLocs(program: WebGLProgram) {
    return {
      uTimeDelta: gl.getUniformLocation(program, 'iTimeDelta'),
      uFrameRate: gl.getUniformLocation(program, 'iFrameRate'),
      uFrame: gl.getUniformLocation(program, 'iFrame'),
      uMouse: gl.getUniformLocation(program, 'iMouse'),
      uDate: gl.getUniformLocation(program, 'iDate'),
      uChannel: [0, 1, 2, 3].map((i) => gl.getUniformLocation(program, `iChannel${i}`)),
      uChannelRes: gl.getUniformLocation(program, 'iChannelResolution'),
    };
  }

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
          glsl = inlineSrc;
          isSt = isShadertoySource(glsl);
          paramIds = [];
          sceneInput = isSt && /\biChannel0\b/.test(glsl);
        } else {
          const { meta, glsl: fetched } = await getContent(cacheKey);
          glsl = fetched;
          isSt = meta.shadertoy === true || isShadertoySource(glsl);
          paramIds = meta.params.map((p) => p.id);
          sceneInput = meta.input === 'scene';
        }
        const src = isSt ? wrapShadertoySource(glsl, '', paramIds) : glsl;
        const program = ctx.compileFragment(src);
        const uParams = new Map<string, WebGLUniformLocation | null>();
        for (const pid of paramIds) uParams.set(pid, gl.getUniformLocation(program, pid));
        const u = stUniLocs(program);
        programs.set(cacheKey, {
          program, shadertoy: isSt, sceneInput,
          uTime: gl.getUniformLocation(program, 'iTime'),
          uResolution: gl.getUniformLocation(program, 'iResolution'),
          uTimeDelta: u.uTimeDelta, uFrameRate: u.uFrameRate, uFrame: u.uFrame,
          uMouse: u.uMouse, uDate: u.uDate,
          uChannel: u.uChannel, uChannelRes: u.uChannelRes, uParams,
        });
      } catch (err) {
        failedShader.add(cacheKey);
        console.warn(`[TOYBOX-worker] content '${cacheKey}' compile failed:`, err);
      } finally {
        inflightShader.delete(cacheKey);
      }
    })();
  }
  ensureProgram(DEFAULT_CONTENT_ID);

  // ---- OBJ program ----
  const objProgram = linkProg(gl, OBJ_VERT_SRC, OBJ_FRAG_SRC);
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

  const meshes = new Map<string, GpuMesh>();
  const inflightModel = new Set<string>();
  const failedModel = new Set<string>();

  function uploadMesh(mesh: Mesh & { frame: { center: [number, number, number]; scale: number } }): GpuMesh {
    const vao = gl.createVertexArray()!;
    const vbo = gl.createBuffer()!;
    const ibo = gl.createBuffer()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.interleaved, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, MESH_STRIDE_BYTES, MESH_OFFSET_POS);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, MESH_STRIDE_BYTES, MESH_OFFSET_NORMAL);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, MESH_STRIDE_BYTES, MESH_OFFSET_UV);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return { vao, vbo, ibo, indexCount: mesh.indices.length, frameCenter: mesh.frame.center, frameScale: mesh.frame.scale };
  }

  function ensureMesh(cacheKey: string, inlineObj?: string): void {
    if (meshes.has(cacheKey) || inflightModel.has(cacheKey) || failedModel.has(cacheKey)) return;
    if (typeof inlineObj === 'string') {
      try { meshes.set(cacheKey, uploadMesh(parseObj(inlineObj))); }
      catch (err) { failedModel.add(cacheKey); console.warn(`[TOYBOX-worker] custom OBJ '${cacheKey}' failed:`, err); }
      return;
    }
    const modelId = cacheKey;
    const meta = getModelMeta(modelId);
    const builtinNames = ['cube','sphere','torus','hypercube','tetrahedron','octahedron','icosahedron','cylinder','cone','torus-knot'] as const;
    const builtin = (meta?.builtin as BuiltinPrimitive | undefined) ??
      (builtinNames.includes(modelId as (typeof builtinNames)[number]) ? modelId as BuiltinPrimitive : undefined);
    if (builtin) {
      try { meshes.set(modelId, uploadMesh(makePrimitive(builtin))); }
      catch (err) { failedModel.add(modelId); console.warn(`[TOYBOX-worker] primitive '${modelId}' failed:`, err); }
      return;
    }
    inflightModel.add(modelId);
    void (async () => {
      try {
        const { obj } = await getModelObj(modelId);
        meshes.set(modelId, uploadMesh(parseObj(obj)));
      } catch (err) {
        failedModel.add(modelId);
        console.warn(`[TOYBOX-worker] model '${modelId}' failed:`, err);
      } finally {
        inflightModel.delete(modelId);
      }
    })();
  }

  // ---- Combine program ----
  const combineProgram = linkProg(gl, COMBINE_VERT_SRC, COMBINE_FRAG_SRC);
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

  // ---- Feedback program ----
  const feedbackProgram = linkProg(gl, COMBINE_VERT_SRC, FEEDBACK_FRAG_SRC);
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

  // ---- Exquisite program ----
  const exqProgram = linkProg(gl, COMBINE_VERT_SRC, EXQUISITE_FRAG_SRC);
  const xuIn = [0, 1, 2, 3].map((i) => gl.getUniformLocation(exqProgram, `uIn${i}`));
  const xuHas = [0, 1, 2, 3].map((i) => gl.getUniformLocation(exqProgram, `uHas${i}`));
  const xuBands = gl.getUniformLocation(exqProgram, 'uBands');
  const xuWarp = gl.getUniformLocation(exqProgram, 'uWarp');
  const xuSeam = gl.getUniformLocation(exqProgram, 'uSeam');
  const xuHue = gl.getUniformLocation(exqProgram, 'uHue');

  // ---- History program ----
  const histProgram = linkProg(gl, COMBINE_VERT_SRC, HISTORY_FRAG_SRC);
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

  // ---- Per-stateful-node feedback/history buffers ----
  const feedbackBufs = new Map<string, FeedbackBuf>();

  const floatLinearOk = (() => {
    try {
      if ((gl as WebGL2RenderingContext).getExtension('OES_texture_float_linear')) return true;
      return (gl as WebGL2RenderingContext).getExtension('EXT_color_buffer_float') == null;
    } catch { return false; }
  })();

  function allocFloatTarget(): FloatTarget {
    if (ctx.createFloatFbo) {
      const r = ctx.createFloatFbo(ctx.res.width, ctx.res.height, { filter: floatLinearOk ? 'linear' : 'nearest', precision: 'full' });
      return { fbo: r.fbo, texture: r.texture };
    }
    return ctx.createFbo();
  }

  function makeFeedbackBuf(kind: string): FeedbackBuf {
    const depth = opHistoryDepth(kind);
    const n = Math.max(2, depth + 1);
    const ring: FloatTarget[] = [];
    for (let i = 0; i < n; i++) ring.push(allocFloatTarget());
    const out = depth > 1 ? allocFloatTarget() : undefined;
    return { ring, head: 0, out, kind, clearPending: true, resetToken: 0 };
  }

  function freeFeedbackBuf(b: FeedbackBuf): void {
    for (const t of b.ring) { gl.deleteFramebuffer(t.fbo); gl.deleteTexture(t.texture); }
    if (b.out) { gl.deleteFramebuffer(b.out.fbo); gl.deleteTexture(b.out.texture); }
  }

  function reconcileFeedbackBufs(graph: ToyboxCombineGraph): void {
    const liveKind = new Map<string, string>();
    for (const n of graph.nodes) if (isStatefulKind(n.kind)) liveKind.set(n.id, n.kind);
    for (const [nid, buf] of feedbackBufs) {
      const k = liveKind.get(nid);
      if (k === undefined || k !== buf.kind) { freeFeedbackBuf(buf); feedbackBufs.delete(nid); }
    }
    for (const [nid, k] of liveKind) {
      if (!feedbackBufs.has(nid)) feedbackBufs.set(nid, makeFeedbackBuf(k));
    }
  }

  function clearFeedbackBuf(b: FeedbackBuf): void {
    const a = isMeltStateKind(b.kind) ? 0 : 1;
    for (const t of [...b.ring, ...(b.out ? [b.out] : [])]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
      gl.viewport(0, 0, ctx.res.width, ctx.res.height);
      gl.clearColor(0, 0, 0, a);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    b.clearPending = false;
  }

  // ---- Scratch pool ----
  const scratchPool: { fbo: WebGLFramebuffer; texture: WebGLTexture }[] = [];
  function scratch(i: number): { fbo: WebGLFramebuffer; texture: WebGLTexture } {
    while (scratchPool.length <= i) scratchPool.push(ctx.createFbo({ managed: false }));
    return scratchPool[i]!;
  }
  scratch(0); scratch(1);

  // ---- State snapshot (updated by syncState from main) ----
  let stateLayers: ToyboxLayer[] = makeDefaultLayers();
  let stateCombine: ToyboxCombineGraph | ToyboxCombine = makeDefaultCombineGraph();

  /** Apply a serialized ToyboxNodeData snapshot received from the main thread. */
  function syncState(data: unknown): void {
    const d = data as ToyboxNodeData | null;
    if (!d || typeof d !== 'object') return;
    const rawLayers = d.layers;
    if (Array.isArray(rawLayers) && rawLayers.length > 0) {
      const arr = (rawLayers as ToyboxLayer[]).slice(0, LAYER_COUNT);
      while (arr.length < LAYER_COUNT) arr.push({ kind: 'off', contentId: null, params: {} });
      stateLayers = arr;
    } else {
      stateLayers = makeDefaultLayers();
    }
    const rawCombine = d.combine as unknown;
    if (rawCombine && typeof rawCombine === 'object' &&
        (Array.isArray((rawCombine as ToyboxCombineGraph).nodes) ||
         Array.isArray((rawCombine as ToyboxCombine).steps))) {
      stateCombine = rawCombine as ToyboxCombineGraph | ToyboxCombine;
    } else {
      stateCombine = makeDefaultCombineGraph();
    }
  }

  // ---- Layer render helpers ----

  const layerFresh: boolean[] = new Array(LAYER_COUNT).fill(true);

  function clearLayer(i: number): void {
    gl.bindFramebuffer(gl.FRAMEBUFFER, layerTargets[i]!.fbo);
    gl.viewport(0, 0, ctx.res.width, ctx.res.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  const CAMERA_EYE: [number, number, number] = [0, 0, 3.2];
  const CAMERA_DIR: [number, number, number] = [0, 0, -1];
  function projView() {
    const aspect = ctx.res.width / ctx.res.height;
    const proj = perspective((50 * Math.PI) / 180, aspect, 0.1, 100);
    const view = translation(0, 0, -3.2);
    return multiply(proj, view);
  }

  function renderObjLayer(i: number, layer: ToyboxLayer, time: number, safeSource: number): boolean {
    const mat = layer.material ?? makeDefaultObjMaterial();
    const customObj = typeof layer.objSrc === 'string' && layer.objSrc.length > 0 ? layer.objSrc : null;
    const meshKey = customObj ? customObjKey(customObj) : mat.modelId;
    if (!meshKey) return false;
    ensureMesh(meshKey, customObj ?? undefined);
    const m = meshes.get(meshKey);
    if (!m) return false;
    const g = gl;
    const target = layerTargets[i]!;
    g.bindFramebuffer(g.FRAMEBUFFER, target.fbo);
    g.viewport(0, 0, ctx.res.width, ctx.res.height);
    g.clearColor(0, 0, 0, 0);
    g.clearDepth(1.0);
    g.clear(g.COLOR_BUFFER_BIT | g.DEPTH_BUFFER_BIT);
    g.enable(g.DEPTH_TEST);
    g.depthFunc(g.LEQUAL);
    const spinY = mat.spin * time;
    const userModel = modelMatrix(mat.rotX, mat.rotY + spinY, mat.rotZ, mat.scale * m.frameScale);
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
    const useSurf = safeSource >= 0 && safeSource < LAYER_COUNT && safeSource !== i;
    g.activeTexture(g.TEXTURE0);
    g.bindTexture(g.TEXTURE_2D, useSurf ? layerTargets[safeSource]!.texture : dummyTex);
    if (uSurface) g.uniform1i(uSurface, 0);
    if (uUseSurface) g.uniform1i(uUseSurface, useSurf ? 1 : 0);
    if (uSurfaceMix) g.uniform1f(uSurfaceMix, useSurf ? (typeof mat.surfaceMix === 'number' ? mat.surfaceMix : 1) : 0);
    const projective = useSurf && mat.surfaceMode === 'projective';
    if (uProjMode) g.uniform1i(uProjMode, projective ? 1 : 0);
    if (projective) {
      const aspect = ctx.res.width / ctx.res.height;
      const projector = projectorFromMaterial(mat, { eye: CAMERA_EYE, dir: CAMERA_DIR }, aspect);
      const vp = buildProjectorViewProj(projector);
      if (uProjVP) g.uniformMatrix4fv(uProjVP, false, vp);
      if (uProjEye) g.uniform3f(uProjEye, projector.eye[0], projector.eye[1], projector.eye[2]);
    }
    g.bindVertexArray(m.vao);
    g.drawElements(g.TRIANGLES, m.indexCount, g.UNSIGNED_INT, 0);
    g.bindVertexArray(null);
    g.disable(g.DEPTH_TEST);
    return true;
  }

  function renderShaderLayer(i: number, layer: ToyboxLayer, time: number, frame: VideoFrameContext, safeSource: number): boolean {
    const g = gl;
    const target = layerTargets[i]!;
    const sceneTex = safeSource >= 0 && safeSource < LAYER_COUNT && safeSource !== i ? layerTargets[safeSource]!.texture : null;
    // Multi-buffer shadertoy projects: not supported in Phase 2A worker
    // (requires its own FBO pool that would need createFloatFbo + per-pass state).
    // Degrade gracefully: render as single-pass using the contentId if present.
    const customSrc = typeof layer.shaderSrc === 'string' && layer.shaderSrc.length > 0 ? layer.shaderSrc : null;
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
      if (compiled.uResolution) g.uniform3f(compiled.uResolution, ctx.res.width, ctx.res.height, 1);
      if (compiled.uTimeDelta) g.uniform1f(compiled.uTimeDelta, frame.timeDelta ?? 1 / 60);
      if (compiled.uFrameRate) g.uniform1f(compiled.uFrameRate, frame.frameRate ?? 60);
      if (compiled.uFrame) g.uniform1i(compiled.uFrame, frame.frame | 0);
      if (compiled.uMouse) g.uniform4f(compiled.uMouse, 0, 0, 0, 0);
      if (compiled.uDate) {
        const d = new Date();
        const secs = d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() + d.getMilliseconds() / 1000;
        g.uniform4f(compiled.uDate, d.getFullYear(), d.getMonth(), d.getDate(), secs);
      }
      const wantScene = compiled.sceneInput && !!sceneTex;
      const texs = [wantScene ? sceneTex! : dummyTex, dummyTex, dummyTex, dummyTex];
      for (let s = 0; s < SHADERTOY_CHANNELS; s++) {
        g.activeTexture(g.TEXTURE0 + s);
        g.bindTexture(g.TEXTURE_2D, texs[s] ?? dummyTex);
        if (compiled.uChannel[s]) g.uniform1i(compiled.uChannel[s]!, s);
      }
      if (compiled.uChannelRes) {
        const res = new Float32Array(SHADERTOY_CHANNELS * 3);
        for (let s = 0; s < SHADERTOY_CHANNELS; s++) { res[s*3]=ctx.res.width; res[s*3+1]=ctx.res.height; res[s*3+2]=1; }
        g.uniform3fv(compiled.uChannelRes, res);
      }
    } else if (compiled.uResolution) {
      g.uniform2f(compiled.uResolution, ctx.res.width, ctx.res.height);
    }
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

  // ---- Combine helpers ----

  interface CombineExtra {
    soft?: number; invert?: number;
    keyR?: number; keyG?: number; keyB?: number;
    mode?: number; p0?: number; p1?: number; p2?: number; p3?: number; p4?: number; p5?: number;
  }

  function combineStep(baseTex: WebGLTexture, topTex: WebGLTexture, dstFbo: WebGLFramebuffer, op: number, amount: number, extra?: CombineExtra): void {
    const g = gl;
    g.bindFramebuffer(g.FRAMEBUFFER, dstFbo);
    g.viewport(0, 0, ctx.res.width, ctx.res.height);
    g.useProgram(combineProgram);
    g.activeTexture(g.TEXTURE0); g.bindTexture(g.TEXTURE_2D, baseTex);
    if (cuBase) g.uniform1i(cuBase, 0);
    g.activeTexture(g.TEXTURE1); g.bindTexture(g.TEXTURE_2D, topTex);
    if (cuTop) g.uniform1i(cuTop, 1);
    if (cuOp) g.uniform1i(cuOp, op);
    if (cuAmount) g.uniform1f(cuAmount, amount);
    if (cuSoft) g.uniform1f(cuSoft, extra?.soft ?? 0);
    if (cuInvert) g.uniform1f(cuInvert, extra?.invert ?? 0);
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

  function runFeedbackStep(buf: FeedbackBuf, inputTex: WebGLTexture | null, params: Record<string, number> | undefined): WebGLTexture {
    const g = gl;
    if (buf.clearPending) clearFeedbackBuf(buf);
    const u = feedbackUniforms(params);
    const N = buf.ring.length;
    const dst = buf.ring[buf.head]!;
    const prev = buf.ring[(buf.head - 1 + N) % N]!;
    g.bindFramebuffer(g.FRAMEBUFFER, dst.fbo);
    g.viewport(0, 0, ctx.res.width, ctx.res.height);
    g.useProgram(feedbackProgram);
    g.activeTexture(g.TEXTURE0); g.bindTexture(g.TEXTURE_2D, prev.texture);
    if (fuFeedback) g.uniform1i(fuFeedback, 0);
    g.activeTexture(g.TEXTURE1); g.bindTexture(g.TEXTURE_2D, inputTex ?? dummyTex);
    if (fuInput) g.uniform1i(fuInput, 1);
    if (fuHasInput) g.uniform1f(fuHasInput, inputTex ? 1 : 0);
    if (fuTexel) g.uniform2f(fuTexel, 1 / ctx.res.width, 1 / ctx.res.height);
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
    const out = dst.texture;
    buf.head = (buf.head + 1) % N;
    return out;
  }

  function runExquisiteStep(slot: { fbo: WebGLFramebuffer; texture: WebGLTexture }, ins: (WebGLTexture | null)[], params: Record<string, number> | undefined): WebGLTexture {
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

  function runHistoryStep(buf: FeedbackBuf, kind: string, inputTex: WebGLTexture | null, inputTex1: WebGLTexture | null, params: Record<string, number> | undefined, fresh = true): WebGLTexture {
    const g = gl;
    if (buf.clearPending) clearFeedbackBuf(buf);
    if (!fresh) {
      const Nh = buf.ring.length;
      if (buf.out) return buf.out.texture;
      return buf.ring[(buf.head - 1 + Nh) % Nh]!.texture;
    }
    const u = historyUniforms(kind, params);
    const N = buf.ring.length;
    const dst = buf.ring[buf.head]!;
    const delayLine = !!buf.out;
    const tapBase = delayLine ? buf.head : buf.head - 1;
    const tap = (d: number) => buf.ring[(tapBase - d + 100 * N) % N]!;
    const prev = buf.ring[(buf.head - 1 + N) % N]!;
    const bind = (unit: number, tex: WebGLTexture, loc: WebGLUniformLocation | null) => {
      g.activeTexture(g.TEXTURE0 + unit);
      g.bindTexture(g.TEXTURE_2D, tex);
      if (loc) g.uniform1i(loc, unit);
    };
    g.useProgram(histProgram);
    if (delayLine) {
      g.bindFramebuffer(g.FRAMEBUFFER, dst.fbo);
      g.viewport(0, 0, ctx.res.width, ctx.res.height);
      bind(4, inputTex ?? dummyTex, huIn);
      if (huHasIn) g.uniform1f(huHasIn, inputTex ? 1 : 0);
      if (huStorePass) g.uniform1f(huStorePass, 1);
      ctx.drawFullscreenQuad();
    }
    const target = delayLine ? buf.out! : dst;
    g.bindFramebuffer(g.FRAMEBUFFER, target.fbo);
    g.viewport(0, 0, ctx.res.width, ctx.res.height);
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
    if (huTexel) g.uniform2f(huTexel, 1 / ctx.res.width, 1 / ctx.res.height);
    if (huTime) g.uniform1f(huTime, typeof performance !== 'undefined' ? performance.now() / 1000 : 0);
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

  function evalLinear(combine: ToyboxCombine, produced: boolean[]): WebGLTexture {
    let accTex = layerTargets[0]!.texture;
    let scratchFront = scratch(0);
    let scratchBack = scratch(1);
    const OP_INDEX: Record<string, number> = { fade: 0, lumakey: 1, chromakey: 2, map: 3 };
    for (const step of combine.steps) {
      const li = step.layer;
      if (li < 1 || li >= LAYER_COUNT || !produced[li]) continue;
      const op = OP_INDEX[step.op] ?? 0;
      combineStep(accTex, layerTargets[li]!.texture, scratchFront.fbo, op, step.amount);
      accTex = scratchFront.texture;
      const t = scratchFront; scratchFront = scratchBack; scratchBack = t;
    }
    return accTex;
  }

  function evalGraph(graph: ToyboxCombineGraph, produced: boolean[]): WebGLTexture | null {
    const { order } = topoSort(graph);
    reconcileFeedbackBufs(graph);
    const texForNode = new Map<string, WebGLTexture | null>();
    const freshForNode = propagateFreshness(graph, layerFresh);
    let scratchSlot = 0;
    const opOf = (kind: string): number | null =>
      isCombineOpKind(kind as ToyboxOpKind) ? OP_SHADER_INDEX[kind as ToyboxOpKind] : null;
    for (const id of order) {
      const n = graph.nodes.find((x) => x.id === id);
      if (!n) continue;
      if (n.kind === 'source') {
        const li = typeof n.layer === 'number' ? n.layer : -1;
        texForNode.set(id, li >= 0 && li < LAYER_COUNT && produced[li] ? layerTargets[li]!.texture : null);
        continue;
      }
      if (n.kind === 'output') continue;
      if (isStatefulKind(n.kind)) {
        const buf = feedbackBufs.get(id);
        if (!buf) { texForNode.set(id, null); continue; }
        const p = n.params ?? {};
        const reset = feedbackResetState(buf.resetToken, p);
        if (reset.clear) { buf.resetToken = reset.token; buf.clearPending = true; }
        const inEdge0 = graph.edges.find((e) => e.to === id && e.toPort === 'in0');
        const inputTex = inEdge0 ? texForNode.get(inEdge0.from) ?? null : null;
        const fresh = freshForNode.get(id) ?? true;
        if (n.kind === 'feedback') {
          texForNode.set(id, runFeedbackStep(buf, inputTex, p));
        } else {
          const inEdge1 = graph.edges.find((e) => e.to === id && e.toPort === 'in1');
          const inputTex1 = inEdge1 ? texForNode.get(inEdge1.from) ?? null : null;
          texForNode.set(id, runHistoryStep(buf, n.kind, inputTex, inputTex1, p, fresh));
        }
        continue;
      }
      if (n.kind === 'exquisite') {
        const inEdge = (port: string) => graph.edges.find((e) => e.to === id && e.toPort === port);
        const texOf = (port: string): WebGLTexture | null => { const e = inEdge(port); return e ? texForNode.get(e.from) ?? null : null; };
        const ins = (['in0','in1','in2','in3'] as const).map(texOf);
        if (!ins.some((t) => t)) { texForNode.set(id, null); continue; }
        const slot = scratch(2 + scratchSlot++);
        texForNode.set(id, runExquisiteStep(slot, ins, n.params));
        continue;
      }
      const op = opOf(n.kind);
      if (op === null) { texForNode.set(id, null); continue; }
      const inEdge = (port: string) => graph.edges.find((e) => e.to === id && e.toPort === port);
      const baseE = inEdge('in0');
      const topE = inEdge('in1');
      const baseTex = baseE ? texForNode.get(baseE.from) ?? null : null;
      const topTex = topE ? texForNode.get(topE.from) ?? null : null;
      if (!baseTex && !topTex) { texForNode.set(id, null); continue; }
      const slot = scratch(2 + scratchSlot++);
      const ex = combineExtraFor(n.kind as ToyboxOpKind, n.params);
      const oneInput = topE === undefined && n.kind !== 'fade' && n.kind !== 'lumakey'
        && n.kind !== 'chromakey' && n.kind !== 'map' && n.kind !== 'over' && n.kind !== 'displace';
      if (oneInput && baseTex) {
        combineStep(baseTex, baseTex, slot.fbo, op, ex.amount, ex);
      } else if (baseTex && !topTex) {
        combineStep(baseTex, baseTex, slot.fbo, 0, 0);
      } else if (!baseTex && topTex) {
        combineStep(topTex, topTex, slot.fbo, 0, 0);
      } else {
        combineStep(baseTex!, topTex!, slot.fbo, op, ex.amount, ex);
      }
      texForNode.set(id, slot.texture);
    }
    const out = graph.nodes.find((x) => x.kind === 'output');
    if (!out) return null;
    const outE = graph.edges.find((e) => e.to === out.id && e.toPort === 'in0');
    if (!outE) return null;
    return texForNode.get(outE.from) ?? null;
  }

  // ---- Surface ----

  const surface: VideoNodeSurface = {
    fbo: outFbo,
    texture: outTexture,
    draw(frame: VideoFrameContext) {
      const g = frame.gl;
      const time = frame.time;
      const layers = stateLayers;
      const combine = stateCombine;

      // Render each eligible layer into its FBO.
      const produced: boolean[] = new Array(LAYER_COUNT).fill(false);
      layerFresh.fill(true);
      const { order, safeSource } = resolveRenderOrder(layers);
      for (const i of order) {
        const layer = layers[i];
        if (!layer) { clearLayer(i); continue; }
        let drew = false;
        if (layer.kind === 'obj') {
          drew = renderObjLayer(i, layer, time, safeSource[i] ?? -1);
        } else if (layer.kind === 'shader' || layer.kind === 'gen' || layer.kind === 'frag') {
          drew = renderShaderLayer(i, layer, time, frame, safeSource[i] ?? -1);
        }
        // video/image/background/off → black (Phase 2A: ineligible or empty).
        if (!drew) clearLayer(i);
        produced[i] = drew;
      }

      // Evaluate combine graph (or legacy linear chain).
      const accTex = isCombineGraph(combine)
        ? evalGraph(combine as ToyboxCombineGraph, produced)
        : evalLinear(combine as ToyboxCombine, produced);

      // Copy result into output FBO.
      g.bindFramebuffer(g.FRAMEBUFFER, outFbo);
      g.viewport(0, 0, ctx.res.width, ctx.res.height);
      g.clearColor(0, 0, 0, 1);
      g.clear(g.COLOR_BUFFER_BIT);
      if (accTex) {
        combineStep(accTex, accTex, outFbo, 0, 0);
      }
      g.bindFramebuffer(g.FRAMEBUFFER, null);
    },
    resize(w: number, h: number) {
      const W = Math.max(2, Math.round(w));
      const H = Math.max(2, Math.round(h));
      for (const t of layerTargets) {
        gl.bindTexture(gl.TEXTURE_2D, t.texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.bindRenderbuffer(gl.RENDERBUFFER, t.depth);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, W, H);
      }
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.bindRenderbuffer(gl.RENDERBUFFER, null);
      for (const s of scratchPool) {
        gl.bindTexture(gl.TEXTURE_2D, s.texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      }
      gl.bindTexture(gl.TEXTURE_2D, null);
      for (const b of feedbackBufs.values()) freeFeedbackBuf(b);
      feedbackBufs.clear();
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
      for (const s of scratchPool) { gl.deleteFramebuffer(s.fbo); gl.deleteTexture(s.texture); }
      scratchPool.length = 0;
      for (const c of programs.values()) gl.deleteProgram(c.program);
      programs.clear();
      for (const b of feedbackBufs.values()) freeFeedbackBuf(b);
      feedbackBufs.clear();
      gl.deleteProgram(objProgram);
      gl.deleteProgram(combineProgram);
      gl.deleteProgram(feedbackProgram);
      gl.deleteProgram(exqProgram);
      gl.deleteProgram(histProgram);
      for (const m of meshes.values()) {
        gl.deleteVertexArray(m.vao);
        gl.deleteBuffer(m.vbo);
        gl.deleteBuffer(m.ibo);
      }
      meshes.clear();
    },
  };

  const handle: VideoNodeHandle & { syncState: (data: unknown) => void } = {
    domain: 'video' as const,
    surface,
    syncState,
    setParam(_paramId: string, _value: number) {
      // CV values for TOYBOX are resolved on the main thread via applyCvRoute
      // and applied there. The worker path doesn't need per-param state because
      // the main sends the full layer/combine snapshot via syncState which
      // already contains the post-CV param values.
    },
    readParam(_paramId: string) { return undefined; },
    read(_key: string) { return undefined; },
    dispose() { surface.dispose(); },
  };

  return handle;
}

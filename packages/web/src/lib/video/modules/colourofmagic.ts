// packages/web/src/lib/video/modules/colourofmagic.ts
//
// COLOUR OF MAGIC — real-time multi-colorspace video processor.
//
// One video IN; FIVE PARALLEL colorspace blocks — RGB, YDbDr (SECAM), HSV-or-HSL,
// YIQ (NTSC composite), and YCbCr BT.601 STUDIO-SWING (broadcast-legal) — each
// with a per-channel bias knob + CV, a per-channel mono OVERRIDE input, and an
// OVER/CLAMP overflow toggle. TWENTY-TWO outputs: pass / rgb / ydbdr / hsvhsl /
// yiq / ycc (colorized video) + per-block grayscale channel taps — r / g / b /
// luma (RGB), ydb_y/db/dr (YDbDr), hsv_h/s/v (HSV·HSL), yiq_y/i/q (YIQ),
// ycc_y/cb/cr (YCbCr studio-swing). Informed by (not copied from) LZX Swatch:
// encode → per-component adjust in a 0..1 signal space (bipolar chroma on a 0.5
// pedestal; studio-swing chroma on the authentic 128/255 = 0.502 pedestal) →
// decode, with wrap-vs-clip overflow.
//
// PLUS (owner addendum 2026-07-03): the RGB block has a palette-picker REPLACE
// mode — three colour swatches remap the (adjusted) R/G/B channels to chosen
// output colours (duotone/tritone), pre-output. Picking a swatch auto-enables
// REPLACE; the swatches default to a non-identity teal/orange/violet duotone so
// the effect is immediately visible.
//
// ALL colorspace math is a 1:1 mirror of the PURE CORE in
// $lib/video/colourofmagic-colorspace (constants copied, never re-derived);
// that core + its unit suite are the correctness gate, not the GPU.
//
// RENDER: one fragment program with uOutMode selecting which value to write.
// LAZY FBO: only the output FBOs that are actually PATCHED downstream (queried
// via frame.connectedOutputPorts) PLUS the currently-PREVIEWED output are drawn
// each frame — not all 22 — keeping the per-frame cost near the old 9-pass level
// on CI's SwiftShader. A final pass renders the `preview`-param output into the
// canonical surface FBO so the on-card preview blit shows the chosen output.
// Unpatched samplers bind a shared 1×1 black emptyTex — NEVER the module's own
// FBO (that is a GL feedback loop). Per-port textures are exposed via
// read('outputTexture:<id>').

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';
import { unpackColor01 } from '$lib/video/colourofmagic-colorspace';

// ─────────────────────────── GLSL (mirror of the pure core) ───────────────────────────

const FRAG_SRC = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;

uniform sampler2D uTex;                 // source picture
uniform float uHasInput;

// per-channel override samplers + connected flags
uniform sampler2D uMonoRgbR, uMonoRgbG, uMonoRgbB;
uniform sampler2D uMonoY,   uMonoDb,  uMonoDr;
uniform sampler2D uMonoH,   uMonoS,   uMonoV;
uniform sampler2D uMonoYiqY, uMonoYiqI, uMonoYiqQ;
uniform sampler2D uMonoYccY, uMonoYccCb, uMonoYccCr;
uniform float uHasRgbR,uHasRgbG,uHasRgbB;
uniform float uHasY,uHasDb,uHasDr;
uniform float uHasH,uHasS,uHasV;
uniform float uHasYiqY,uHasYiqI,uHasYiqQ;
uniform float uHasYccY,uHasYccCb,uHasYccCr;

// biases (knob+CV already summed by the engine into these)
uniform float uBiasR,uBiasG,uBiasB;
uniform float uBiasY,uBiasDb,uBiasDr;
uniform float uBiasH,uBiasS,uBiasV;     // uBiasH is DEGREES
uniform float uBiasYiqY,uBiasYiqI,uBiasYiqQ;
uniform float uBiasYccY,uBiasYccCb,uBiasYccCr;

// over/clamp toggles (0=clamp,1=wrap). hue always wraps → no uOverH.
uniform float uOverR,uOverG,uOverB;
uniform float uOverY,uOverDb,uOverDr;
uniform float uOverS,uOverV;
uniform float uOverYiqY,uOverYiqI,uOverYiqQ;
uniform float uOverYccY,uOverYccCb,uOverYccCr;

uniform float uHsl;                     // 0=HSV,1=HSL
uniform float uReplace;                 // RGB palette REPLACE on/off
uniform vec3  uPalR,uPalG,uPalB;        // picked palette colours (0..1)
uniform int   uOutMode;                 // 0..21 (see OUTPUTS)

const vec3 W601 = vec3(0.299, 0.587, 0.114);

// ---- YDbDr (SECAM) — dot form (constants copied from the pure core) ----
vec3 rgb2ydbdr(vec3 c){
  return vec3(dot(c, W601),
              dot(c, vec3(-0.450, -0.883,  1.333)),
              dot(c, vec3(-1.333,  1.116,  0.217)));
}
vec3 ydbdr2rgb(vec3 y){                 // y=(Y,Db,Dr)
  return vec3(y.x                    - 0.525912*y.z,
              y.x - 0.129133*y.y + 0.267899*y.z,
              y.x + 0.664679*y.y);
}
vec3 packYdbdr(vec3 y){ return vec3(y.x, y.y*0.375 + 0.5, y.z*0.375 + 0.5); }
vec3 unpackYdbdr(vec3 n){ return vec3(n.x, (n.y-0.5)*2.66667, (n.z-0.5)*2.66667); }

// ---- YIQ (NTSC composite) — dot form, mirrors the YDbDr precedent ----
vec3 rgb2yiq(vec3 c){
  return vec3(dot(c, vec3(0.299,   0.587,   0.114)),   // Y  Rec.601 luma
              dot(c, vec3(0.5959, -0.2746, -0.3213)),  // I  orange<->cyan (flesh)
              dot(c, vec3(0.2115, -0.5227,  0.3112))); // Q  green<->magenta
}
vec3 yiq2rgb(vec3 y){                 // y = (Y, I, Q)  exact FCC inverse
  return vec3(y.x + 0.9563*y.y + 0.6210*y.z,
              y.x - 0.2721*y.y - 0.6474*y.z,
              y.x - 1.1070*y.y + 1.7046*y.z);
}
vec3 packYiq(vec3 y){ return vec3(y.x, y.y*0.8391 + 0.5, y.z*0.9566 + 0.5); }
vec3 unpackYiq(vec3 n){ return vec3(n.x, (n.y-0.5)*(1.0/0.8391), (n.z-0.5)*(1.0/0.9566)); }

// ---- YCbCr BT.601 STUDIO-SWING (16..235 luma, 16..240 chroma) ----
// pack IS the encode (legal-range levels baked in); chroma neutral = 128/255 = 0.502.
vec3 rgb2ycc_ss(vec3 c){
  float Yf = dot(c, vec3( 0.299,     0.587,     0.114));      // full-range luma 0..1
  float Pb = dot(c, vec3(-0.168736, -0.331264,  0.5));        // +/-0.5
  float Pr = dot(c, vec3( 0.5,      -0.418688, -0.081312));   // +/-0.5
  return vec3(16.0/255.0  + (219.0/255.0) * Yf,   // luma -> footroom/headroom
              128.0/255.0 + (224.0/255.0) * Pb,   // Cb   -> 16..240, pedestal 0.502
              128.0/255.0 + (224.0/255.0) * Pr);  // Cr
}
vec3 ycc_ss2rgb(vec3 s){
  float y  = (s.x - 16.0/255.0)  * (255.0/219.0);  // expand: the ~1.16x crush
  float cb = (s.y - 128.0/255.0) * (255.0/224.0);  // -> +/-0.5 (illegal > +/-0.5)
  float cr = (s.z - 128.0/255.0) * (255.0/224.0);
  return vec3(y            + 1.402000*cr,
              y - 0.344136*cb - 0.714136*cr,
              y + 1.772000*cb);
}

// ---- HSV (branchless; matches hsvshift/cellshade) ----
vec3 rgb2hsv(vec3 c){
  vec4 K=vec4(0.,-1./3.,2./3.,-1.);
  vec4 p=mix(vec4(c.bg,K.wz),vec4(c.gb,K.xy),step(c.b,c.g));
  vec4 q=mix(vec4(p.xyw,c.r),vec4(c.r,p.yzx),step(p.x,c.r));
  float d=q.x-min(q.w,q.y), e=1e-10;
  return vec3(abs(q.z+(q.w-q.y)/(6.*d+e)), d/(q.x+e), q.x);
}
vec3 hsv2rgb(vec3 c){
  vec4 K=vec4(1.,2./3.,1./3.,3.);
  vec3 p=abs(fract(c.xxx+K.xyz)*6.-K.www);
  return c.z*mix(K.xxx,clamp(p-K.xxx,0.,1.),c.y);
}
// ---- HSL (independent, exact) ----
vec3 rgb2hsl(vec3 c){
  float mx=max(max(c.r,c.g),c.b), mn=min(min(c.r,c.g),c.b), C=mx-mn;
  float L=(mx+mn)*0.5;
  float S=(L<=0.0||L>=1.0)?0.0:C/(1.0-abs(2.0*L-1.0));
  float H=0.0;
  if(C>1e-10){
    if(mx==c.r)      H=mod((c.g-c.b)/C,6.0);
    else if(mx==c.g) H=(c.b-c.r)/C+2.0;
    else             H=(c.r-c.g)/C+4.0;
    H/=6.0; if(H<0.0)H+=1.0;
  }
  return vec3(H,S,L);
}
vec3 hsl2rgb(vec3 hsl){
  float H=hsl.x,S=hsl.y,L=hsl.z;
  float C=(1.0-abs(2.0*L-1.0))*S;
  float X=C*(1.0-abs(mod(H*6.0,2.0)-1.0));
  float m=L-0.5*C; float h6=H*6.0; vec3 r;
  if(h6<1.0)r=vec3(C,X,0);else if(h6<2.0)r=vec3(X,C,0);
  else if(h6<3.0)r=vec3(0,C,X);else if(h6<4.0)r=vec3(0,X,C);
  else if(h6<5.0)r=vec3(X,0,C);else r=vec3(C,0,X);
  return r+m;
}

// ---- per-channel adjust (identity when bias=0, no mono, clamp mode) ----
float adj(float v, float bias, float over, float mono, float hasMono){
  float x = (hasMono > 0.5) ? mono : v;   // MONO OVERRIDE replaces the channel
  x = x + bias;                           // knob(+CV) offset; 0 => identity
  return (over > 0.5) ? fract(x) : clamp(x, 0.0, 1.0);
}
float adjHue(float v, float biasDeg, float mono, float hasMono){
  float x = (hasMono > 0.5) ? mono : v;
  x = x + biasDeg/360.0;
  return fract(x);                        // hue ALWAYS wraps
}

// adjusted RGB channel SCALARS (feeds mono r/g/b/luma outs)
vec3 rgbBlock(vec3 src){
  return vec3(
    adj(src.r, uBiasR, uOverR, texture(uMonoRgbR,vUv).r, uHasRgbR),
    adj(src.g, uBiasG, uOverG, texture(uMonoRgbG,vUv).r, uHasRgbG),
    adj(src.b, uBiasB, uOverB, texture(uMonoRgbB,vUv).r, uHasRgbB));
}
// REPLACE remap (identity when off / at pure-RGB picks) — RGB colour out only.
vec3 applyPalette(vec3 a){
  if (uReplace < 0.5) return a;
  return uPalR*a.r + uPalG*a.g + uPalB*a.b;
}
// Adjusted PACKED channels split out of each block so the mono taps can emit them
// raw (vec3(channel)) without decoding — the exact rgbBlock/mono-tap precedent.
vec3 ydbdrChannels(vec3 src){
  vec3 n = packYdbdr(rgb2ydbdr(src));
  return vec3(
    adj(n.x, uBiasY,  uOverY,  texture(uMonoY,vUv).r,  uHasY),
    adj(n.y, uBiasDb, uOverDb, texture(uMonoDb,vUv).r, uHasDb),
    adj(n.z, uBiasDr, uOverDr, texture(uMonoDr,vUv).r, uHasDr));
}
vec3 ydbdrBlock(vec3 src){ return ydbdr2rgb(unpackYdbdr(ydbdrChannels(src))); }

vec3 hsvChannels(vec3 src){
  bool hsl = uHsl > 0.5;
  vec3 h = hsl ? rgb2hsl(src) : rgb2hsv(src);
  return vec3(
    adjHue(h.x, uBiasH, texture(uMonoH,vUv).r, uHasH),
    adj   (h.y, uBiasS, uOverS, texture(uMonoS,vUv).r, uHasS),
    adj   (h.z, uBiasV, uOverV, texture(uMonoV,vUv).r, uHasV));
}
vec3 hsvBlock(vec3 src){
  bool hsl = uHsl > 0.5;
  vec3 h = hsvChannels(src);
  return hsl ? hsl2rgb(h) : hsv2rgb(h);
}

vec3 yiqChannels(vec3 src){
  vec3 n = packYiq(rgb2yiq(src));
  return vec3(
    adj(n.x, uBiasYiqY, uOverYiqY, texture(uMonoYiqY,vUv).r, uHasYiqY),
    adj(n.y, uBiasYiqI, uOverYiqI, texture(uMonoYiqI,vUv).r, uHasYiqI),
    adj(n.z, uBiasYiqQ, uOverYiqQ, texture(uMonoYiqQ,vUv).r, uHasYiqQ));
}
vec3 yiqBlock(vec3 src){ return yiq2rgb(unpackYiq(yiqChannels(src))); }

vec3 yccChannels(vec3 src){
  vec3 n = rgb2ycc_ss(src);
  return vec3(
    adj(n.x, uBiasYccY,  uOverYccY,  texture(uMonoYccY,vUv).r,  uHasYccY),
    adj(n.y, uBiasYccCb, uOverYccCb, texture(uMonoYccCb,vUv).r, uHasYccCb),
    adj(n.z, uBiasYccCr, uOverYccCr, texture(uMonoYccCr,vUv).r, uHasYccCr));
}
vec3 yccBlock(vec3 src){ return ycc_ss2rgb(yccChannels(src)); }

void main(){
  if (uHasInput < 0.5){ outColor = vec4(0.0,0.0,0.0,1.0); return; }
  vec3 src = texture(uTex, vUv).rgb;

  vec3 outRgb;
  if (uOutMode == 0) {                     // passthrough
    outRgb = src;
  } else if (uOutMode == 2) {              // ydbdr colorized
    outRgb = ydbdrBlock(src);
  } else if (uOutMode == 3) {              // hsv/hsl colorized
    outRgb = hsvBlock(src);
  } else if (uOutMode == 14) {             // yiq colorized
    outRgb = yiqBlock(src);
  } else if (uOutMode == 18) {             // ycc studio-swing colorized
    outRgb = yccBlock(src);
  } else if (uOutMode >= 8 && uOutMode <= 10) {   // ydbdr y/db/dr taps
    vec3 n = ydbdrChannels(src);
    float v = (uOutMode == 8) ? n.x : (uOutMode == 9) ? n.y : n.z;
    outRgb = vec3(v);
  } else if (uOutMode >= 11 && uOutMode <= 13) {  // hsv h/s/v taps
    vec3 n = hsvChannels(src);
    float v = (uOutMode == 11) ? n.x : (uOutMode == 12) ? n.y : n.z;
    outRgb = vec3(v);
  } else if (uOutMode >= 15 && uOutMode <= 17) {  // yiq y/i/q taps
    vec3 n = yiqChannels(src);
    float v = (uOutMode == 15) ? n.x : (uOutMode == 16) ? n.y : n.z;
    outRgb = vec3(v);
  } else if (uOutMode >= 19 && uOutMode <= 21) {  // ycc y/cb/cr taps
    vec3 n = yccChannels(src);
    float v = (uOutMode == 19) ? n.x : (uOutMode == 20) ? n.y : n.z;
    outRgb = vec3(v);
  } else {                                 // 1 rgb, 4/5/6 mono r/g/b, 7 luma
    vec3 a = rgbBlock(src);
    if      (uOutMode == 1) outRgb = applyPalette(a);
    else if (uOutMode == 4) outRgb = vec3(a.r);
    else if (uOutMode == 5) outRgb = vec3(a.g);
    else if (uOutMode == 6) outRgb = vec3(a.b);
    else                    outRgb = vec3(dot(a, W601));   // luma of ADJUSTED rgb
  }
  outColor = vec4(outRgb, 1.0);
}`;

// ─────────────────────────── params ───────────────────────────

interface ColourParams {
  bias_r: number; bias_g: number; bias_b: number;
  bias_y: number; bias_db: number; bias_dr: number;
  bias_h: number; bias_s: number; bias_v: number;
  bias_yiq_y: number; bias_yiq_i: number; bias_yiq_q: number;
  bias_ycc_y: number; bias_ycc_cb: number; bias_ycc_cr: number;
  over_r: number; over_g: number; over_b: number;
  over_y: number; over_db: number; over_dr: number;
  over_s: number; over_v: number; over_h: number; // over_h advisory (hue always wraps)
  over_yiq_y: number; over_yiq_i: number; over_yiq_q: number;
  over_ycc_y: number; over_ycc_cb: number; over_ycc_cr: number;
  mode_hsl: number;
  replace: number;
  pal_r: number; pal_g: number; pal_b: number; // packed 0xRRGGBB
  preview: number;
  freeze: number;
}

const DEFAULTS: ColourParams = {
  bias_r: 0, bias_g: 0, bias_b: 0,
  bias_y: 0, bias_db: 0, bias_dr: 0,
  bias_h: 0, bias_s: 0, bias_v: 0,
  bias_yiq_y: 0, bias_yiq_i: 0, bias_yiq_q: 0,
  bias_ycc_y: 0, bias_ycc_cb: 0, bias_ycc_cr: 0,
  over_r: 0, over_g: 0, over_b: 0,
  over_y: 0, over_db: 0, over_dr: 0,
  over_s: 0, over_v: 0, over_h: 0,
  over_yiq_y: 0, over_yiq_i: 0, over_yiq_q: 0,
  over_ycc_y: 0, over_ycc_cb: 0, over_ycc_cr: 0,
  mode_hsl: 0,
  replace: 0,
  // Non-identity duotone (teal / orange / violet) so REPLACE visibly recolours
  // the moment it is toggled on or a swatch is picked (the discoverability nudge).
  pal_r: 0xff6a00, pal_g: 0x00e0c0, pal_b: 0x7a3cff,
  preview: 1, // default preview = rgb
  freeze: 0,
};

// Per-channel MONO override inputs → sampler + flag uniform names + texture unit.
// unit 0 = uTex (source); mono overrides use units 1..15 (16 samplers total =
// the WebGL2 MAX_TEXTURE_IMAGE_UNITS minimum guarantee).
const MONO_INPUTS: ReadonlyArray<{ id: string; tex: string; has: string; unit: number }> = [
  { id: 'rgb_r_in',  tex: 'uMonoRgbR', has: 'uHasRgbR', unit: 1 },
  { id: 'rgb_g_in',  tex: 'uMonoRgbG', has: 'uHasRgbG', unit: 2 },
  { id: 'rgb_b_in',  tex: 'uMonoRgbB', has: 'uHasRgbB', unit: 3 },
  { id: 'ydb_y_in',  tex: 'uMonoY',    has: 'uHasY',    unit: 4 },
  { id: 'ydb_db_in', tex: 'uMonoDb',   has: 'uHasDb',   unit: 5 },
  { id: 'ydb_dr_in', tex: 'uMonoDr',   has: 'uHasDr',   unit: 6 },
  { id: 'hsv_h_in',  tex: 'uMonoH',    has: 'uHasH',    unit: 7 },
  { id: 'hsv_s_in',  tex: 'uMonoS',    has: 'uHasS',    unit: 8 },
  { id: 'hsv_v_in',  tex: 'uMonoV',    has: 'uHasV',    unit: 9 },
  { id: 'yiq_y_in',  tex: 'uMonoYiqY', has: 'uHasYiqY', unit: 10 },
  { id: 'yiq_i_in',  tex: 'uMonoYiqI', has: 'uHasYiqI', unit: 11 },
  { id: 'yiq_q_in',  tex: 'uMonoYiqQ', has: 'uHasYiqQ', unit: 12 },
  { id: 'ycc_y_in',  tex: 'uMonoYccY',  has: 'uHasYccY',  unit: 13 },
  { id: 'ycc_cb_in', tex: 'uMonoYccCb', has: 'uHasYccCb', unit: 14 },
  { id: 'ycc_cr_in', tex: 'uMonoYccCr', has: 'uHasYccCr', unit: 15 },
];

// Output port → uOutMode. read('outputTexture:<id>') returns that FBO texture.
const OUTPUTS: ReadonlyArray<{ id: string; mode: number }> = [
  { id: 'pass',   mode: 0 },
  { id: 'rgb',    mode: 1 },
  { id: 'ydbdr',  mode: 2 },
  { id: 'hsvhsl', mode: 3 },
  { id: 'r',      mode: 4 },
  { id: 'g',      mode: 5 },
  { id: 'b',      mode: 6 },
  { id: 'luma',   mode: 7 },
  { id: 'ydb_y',  mode: 8 },
  { id: 'ydb_db', mode: 9 },
  { id: 'ydb_dr', mode: 10 },
  { id: 'hsv_h',  mode: 11 },
  { id: 'hsv_s',  mode: 12 },
  { id: 'hsv_v',  mode: 13 },
  { id: 'yiq',    mode: 14 },
  { id: 'yiq_y',  mode: 15 },
  { id: 'yiq_i',  mode: 16 },
  { id: 'yiq_q',  mode: 17 },
  { id: 'ycc',    mode: 18 },
  { id: 'ycc_y',  mode: 19 },
  { id: 'ycc_cb', mode: 20 },
  { id: 'ycc_cr', mode: 21 },
];

// Highest uOutMode / preview index (kept in sync with OUTPUTS + preview.max).
const MAX_OUT_MODE = 21;

export const colourofmagicDef: VideoModuleDef = {
  type: 'colourofmagic',
  palette: { top: 'Video modules', sub: 'Processors' },
  domain: 'video',
  label: 'colour of magic',
  category: 'effects',
  schemaVersion: 1,
  renderLocus: 'main',
  inputs: [
    { id: 'in', type: 'video' },
    { id: 'rgb_r_cv', type: 'cv', paramTarget: 'bias_r', cvScale: { mode: 'linear' } },
    { id: 'rgb_r_in', type: 'mono-video', accepts: ['keys', 'image', 'video'] },
    { id: 'rgb_g_cv', type: 'cv', paramTarget: 'bias_g', cvScale: { mode: 'linear' } },
    { id: 'rgb_g_in', type: 'mono-video', accepts: ['keys', 'image', 'video'] },
    { id: 'rgb_b_cv', type: 'cv', paramTarget: 'bias_b', cvScale: { mode: 'linear' } },
    { id: 'rgb_b_in', type: 'mono-video', accepts: ['keys', 'image', 'video'] },
    { id: 'ydb_y_cv', type: 'cv', paramTarget: 'bias_y', cvScale: { mode: 'linear' } },
    { id: 'ydb_y_in', type: 'mono-video', accepts: ['keys', 'image', 'video'] },
    { id: 'ydb_db_cv', type: 'cv', paramTarget: 'bias_db', cvScale: { mode: 'linear' } },
    { id: 'ydb_db_in', type: 'mono-video', accepts: ['keys', 'image', 'video'] },
    { id: 'ydb_dr_cv', type: 'cv', paramTarget: 'bias_dr', cvScale: { mode: 'linear' } },
    { id: 'ydb_dr_in', type: 'mono-video', accepts: ['keys', 'image', 'video'] },
    { id: 'hsv_h_cv', type: 'cv', paramTarget: 'bias_h', cvScale: { mode: 'linear' } },
    { id: 'hsv_h_in', type: 'mono-video', accepts: ['keys', 'image', 'video'] },
    { id: 'hsv_s_cv', type: 'cv', paramTarget: 'bias_s', cvScale: { mode: 'linear' } },
    { id: 'hsv_s_in', type: 'mono-video', accepts: ['keys', 'image', 'video'] },
    { id: 'hsv_v_cv', type: 'cv', paramTarget: 'bias_v', cvScale: { mode: 'linear' } },
    { id: 'hsv_v_in', type: 'mono-video', accepts: ['keys', 'image', 'video'] },
    { id: 'yiq_y_cv', type: 'cv', paramTarget: 'bias_yiq_y', cvScale: { mode: 'linear' } },
    { id: 'yiq_y_in', type: 'mono-video', accepts: ['keys', 'image', 'video'] },
    { id: 'yiq_i_cv', type: 'cv', paramTarget: 'bias_yiq_i', cvScale: { mode: 'linear' } },
    { id: 'yiq_i_in', type: 'mono-video', accepts: ['keys', 'image', 'video'] },
    { id: 'yiq_q_cv', type: 'cv', paramTarget: 'bias_yiq_q', cvScale: { mode: 'linear' } },
    { id: 'yiq_q_in', type: 'mono-video', accepts: ['keys', 'image', 'video'] },
    { id: 'ycc_y_cv', type: 'cv', paramTarget: 'bias_ycc_y', cvScale: { mode: 'linear' } },
    { id: 'ycc_y_in', type: 'mono-video', accepts: ['keys', 'image', 'video'] },
    { id: 'ycc_cb_cv', type: 'cv', paramTarget: 'bias_ycc_cb', cvScale: { mode: 'linear' } },
    { id: 'ycc_cb_in', type: 'mono-video', accepts: ['keys', 'image', 'video'] },
    { id: 'ycc_cr_cv', type: 'cv', paramTarget: 'bias_ycc_cr', cvScale: { mode: 'linear' } },
    { id: 'ycc_cr_in', type: 'mono-video', accepts: ['keys', 'image', 'video'] },
  ],
  outputs: [
    { id: 'pass',   type: 'video' },
    { id: 'rgb',    type: 'video' },
    { id: 'ydbdr',  type: 'video' },
    { id: 'hsvhsl', type: 'video' },
    { id: 'r',      type: 'mono-video' },
    { id: 'g',      type: 'mono-video' },
    { id: 'b',      type: 'mono-video' },
    { id: 'luma',   type: 'mono-video' },
    { id: 'ydb_y',  type: 'mono-video' },
    { id: 'ydb_db', type: 'mono-video' },
    { id: 'ydb_dr', type: 'mono-video' },
    { id: 'hsv_h',  type: 'mono-video' },
    { id: 'hsv_s',  type: 'mono-video' },
    { id: 'hsv_v',  type: 'mono-video' },
    { id: 'yiq',    type: 'video' },
    { id: 'yiq_y',  type: 'mono-video' },
    { id: 'yiq_i',  type: 'mono-video' },
    { id: 'yiq_q',  type: 'mono-video' },
    { id: 'ycc',    type: 'video' },
    { id: 'ycc_y',  type: 'mono-video' },
    { id: 'ycc_cb', type: 'mono-video' },
    { id: 'ycc_cr', type: 'mono-video' },
  ],
  params: [
    { id: 'bias_r',  label: 'r',  defaultValue: DEFAULTS.bias_r,  min: -1,   max: 1,   curve: 'linear' },
    { id: 'bias_g',  label: 'g',  defaultValue: DEFAULTS.bias_g,  min: -1,   max: 1,   curve: 'linear' },
    { id: 'bias_b',  label: 'b',  defaultValue: DEFAULTS.bias_b,  min: -1,   max: 1,   curve: 'linear' },
    { id: 'bias_y',  label: 'y',  defaultValue: DEFAULTS.bias_y,  min: -1,   max: 1,   curve: 'linear' },
    { id: 'bias_db', label: 'db', defaultValue: DEFAULTS.bias_db, min: -1,   max: 1,   curve: 'linear' },
    { id: 'bias_dr', label: 'dr', defaultValue: DEFAULTS.bias_dr, min: -1,   max: 1,   curve: 'linear' },
    { id: 'bias_h',  label: 'h',  defaultValue: DEFAULTS.bias_h,  min: -180, max: 180, curve: 'linear', units: 'deg' },
    { id: 'bias_s',  label: 's',  defaultValue: DEFAULTS.bias_s,  min: -1,   max: 1,   curve: 'linear' },
    { id: 'bias_v',  label: 'v',  defaultValue: DEFAULTS.bias_v,  min: -1,   max: 1,   curve: 'linear' },
    { id: 'bias_yiq_y', label: 'y',  defaultValue: DEFAULTS.bias_yiq_y, min: -1, max: 1, curve: 'linear' },
    { id: 'bias_yiq_i', label: 'i',  defaultValue: DEFAULTS.bias_yiq_i, min: -1, max: 1, curve: 'linear' },
    { id: 'bias_yiq_q', label: 'q',  defaultValue: DEFAULTS.bias_yiq_q, min: -1, max: 1, curve: 'linear' },
    { id: 'bias_ycc_y', label: 'y',  defaultValue: DEFAULTS.bias_ycc_y, min: -1, max: 1, curve: 'linear' },
    { id: 'bias_ycc_cb', label: 'cb', defaultValue: DEFAULTS.bias_ycc_cb, min: -1, max: 1, curve: 'linear' },
    { id: 'bias_ycc_cr', label: 'cr', defaultValue: DEFAULTS.bias_ycc_cr, min: -1, max: 1, curve: 'linear' },
    { id: 'over_r',  label: 'r wrap',  defaultValue: DEFAULTS.over_r,  min: 0, max: 1, curve: 'discrete' },
    { id: 'over_g',  label: 'g wrap',  defaultValue: DEFAULTS.over_g,  min: 0, max: 1, curve: 'discrete' },
    { id: 'over_b',  label: 'b wrap',  defaultValue: DEFAULTS.over_b,  min: 0, max: 1, curve: 'discrete' },
    { id: 'over_y',  label: 'y wrap',  defaultValue: DEFAULTS.over_y,  min: 0, max: 1, curve: 'discrete' },
    { id: 'over_db', label: 'db wrap', defaultValue: DEFAULTS.over_db, min: 0, max: 1, curve: 'discrete' },
    { id: 'over_dr', label: 'dr wrap', defaultValue: DEFAULTS.over_dr, min: 0, max: 1, curve: 'discrete' },
    { id: 'over_s',  label: 's wrap',  defaultValue: DEFAULTS.over_s,  min: 0, max: 1, curve: 'discrete' },
    { id: 'over_v',  label: 'v wrap',  defaultValue: DEFAULTS.over_v,  min: 0, max: 1, curve: 'discrete' },
    { id: 'over_h',  label: 'h wrap',  defaultValue: DEFAULTS.over_h,  min: 0, max: 1, curve: 'discrete' },
    { id: 'over_yiq_y', label: 'y wrap', defaultValue: DEFAULTS.over_yiq_y, min: 0, max: 1, curve: 'discrete' },
    { id: 'over_yiq_i', label: 'i wrap', defaultValue: DEFAULTS.over_yiq_i, min: 0, max: 1, curve: 'discrete' },
    { id: 'over_yiq_q', label: 'q wrap', defaultValue: DEFAULTS.over_yiq_q, min: 0, max: 1, curve: 'discrete' },
    { id: 'over_ycc_y', label: 'y wrap', defaultValue: DEFAULTS.over_ycc_y, min: 0, max: 1, curve: 'discrete' },
    { id: 'over_ycc_cb', label: 'cb wrap', defaultValue: DEFAULTS.over_ycc_cb, min: 0, max: 1, curve: 'discrete' },
    { id: 'over_ycc_cr', label: 'cr wrap', defaultValue: DEFAULTS.over_ycc_cr, min: 0, max: 1, curve: 'discrete' },
    { id: 'mode_hsl', label: 'hsl', defaultValue: DEFAULTS.mode_hsl, min: 0, max: 1, curve: 'discrete' },
    { id: 'replace', label: 'replace', defaultValue: DEFAULTS.replace, min: 0, max: 1, curve: 'discrete' },
    { id: 'pal_r', label: 'pal r', defaultValue: DEFAULTS.pal_r, min: 0, max: 0xffffff, curve: 'discrete' },
    { id: 'pal_g', label: 'pal g', defaultValue: DEFAULTS.pal_g, min: 0, max: 0xffffff, curve: 'discrete' },
    { id: 'pal_b', label: 'pal b', defaultValue: DEFAULTS.pal_b, min: 0, max: 0xffffff, curve: 'discrete' },
    { id: 'preview', label: 'preview', defaultValue: DEFAULTS.preview, min: 0, max: 21, curve: 'discrete' },
    { id: 'freeze', label: 'freeze', defaultValue: DEFAULTS.freeze, min: 0, max: 1, curve: 'discrete' },
  ],

  // docs-hash-ignore:start
  docs: {
    explanation:
      "COLOUR OF MAGIC is a multi-colorspace video processor. It takes ONE video input and runs it through FIVE parallel colorspace blocks at once — RGB, YDbDr (the SECAM broadcast luma+chroma space), HSV-or-HSL, YIQ (the NTSC composite space), and YCbCr BT.601 STUDIO-SWING (the broadcast-legal 16–235 / 16–240 quantization) — each block encoding the picture into that space, adjusting each component, then decoding back to RGB. Every block has, per channel: a BIAS knob (additive offset, identity at 0) that also sums any CV patched into its cv input; a MONO OVERRIDE input that REPLACES that channel's value with an incoming grayscale/video stream (bias still adds on top, so a patched key can still be offset); and an OVER/CLAMP toggle that decides what happens out of range — CLAMP clips to 0..1 (a legal, safe clip) while OVER wraps it around (fract(), the LZX chroma-wrap look where over-driven values fold back through the spectrum). Chroma components ride on a 0.5 pedestal (YDbDr Db/Dr, YIQ I/Q) or the authentic 128/255 = 0.502 pedestal (studio-swing Cb/Cr) so a bias pushes the colour-difference axes symmetrically; HUE always wraps regardless of the toggle. The third block switches between HSV and HSL with the HSL toggle. YIQ rotates the colour-difference plane onto the orange↔cyan flesh-tone (I) and green↔magenta (Q) axes — one I bias is a whole teal-&-orange grade. Studio-swing compresses into the legal window and decode expands it ~1.16×, so a bias CRUSHES super-black/white the way a proc-amp / legalizer does. TWENTY-TWO outputs run in parallel: pass (the untouched source); rgb / ydbdr / hsvhsl / yiq / ycc (each block's colorized picture); and per-block grayscale channel taps — r / g / b / luma (RGB), ydb_y/db/dr (YDbDr), hsv_h/s/v (HSV·HSL), yiq_y/i/q (YIQ), ycc_y/cb/cr (studio-swing). The mono taps emit the adjusted packed channel as grayscale — a mono I tap is a ready-made skin/warmth key; a hue tap has a hard black↔white seam at hue 0≡1 (the correct grayscale image of a circular quantity). The RGB block additionally has a palette REPLACE mode: three colour swatches remap the adjusted R/G/B channels to chosen output colours (a duotone/tritone recolour) before the rgb output; picking a swatch auto-enables REPLACE and the swatches default to a non-identity teal/orange/violet so the recolour is immediately visible. With no input patched all outputs are opaque black. Only the outputs you PATCH downstream (plus the one you PREVIEW on the card) are actually rendered each frame, so the many taps stay cheap. Patch a source into IN, choose which output to preview on the card, and use the block knobs / channel overrides / palette to recolour, split, or key the picture.",
    inputs: {
      in: "The source picture. All three blocks read it in parallel. With nothing patched here every output is opaque black.",
      rgb_r_cv: "CV that modulates the RGB block's r bias (linear -1..1 additive offset on the red channel).",
      rgb_r_in: "Mono override for the RGB red channel: when patched, its value REPLACES red before the bias/CV offset and OVER/CLAMP. Accepts a keys/mono-video stream (a full video/image lands legally and is read as its red).",
      rgb_g_cv: "CV that modulates the RGB block's g bias (linear -1..1 offset on green).",
      rgb_g_in: "Mono override for the RGB green channel (replaces green pre-offset). Accepts keys/mono-video/video/image.",
      rgb_b_cv: "CV that modulates the RGB block's b bias (linear -1..1 offset on blue).",
      rgb_b_in: "Mono override for the RGB blue channel (replaces blue pre-offset). Accepts keys/mono-video/video/image.",
      ydb_y_cv: "CV that modulates the YDbDr block's y (luma) bias (linear -1..1 offset in the packed 0..1 space).",
      ydb_y_in: "Mono override for the YDbDr luma (Y) channel, packed 0..1 (replaces Y pre-offset).",
      ydb_db_cv: "CV that modulates the YDbDr Db (blue-yellow chroma) bias (linear -1..1 in packed space).",
      ydb_db_in: "Mono override for the YDbDr Db chroma channel, packed 0..1 (0.5 = neutral).",
      ydb_dr_cv: "CV that modulates the YDbDr Dr (red-cyan chroma) bias (linear -1..1 in packed space).",
      ydb_dr_in: "Mono override for the YDbDr Dr chroma channel, packed 0..1 (0.5 = neutral).",
      hsv_h_cv: "CV that modulates the HSV/HSL block's hue bias (linear -180..180 degrees; hue always wraps).",
      hsv_h_in: "Mono override for HUE (0..1, wraps): replaces the hue angle before the degree bias.",
      hsv_s_cv: "CV that modulates the HSV/HSL block's saturation bias (linear -1..1 offset).",
      hsv_s_in: "Mono override for SATURATION (0..1): replaces saturation pre-offset.",
      hsv_v_cv: "CV that modulates the HSV/HSL block's value/lightness bias (linear -1..1 offset).",
      hsv_v_in: "Mono override for VALUE (HSV) / LIGHTNESS (HSL), 0..1: replaces it pre-offset.",
      yiq_y_cv: "CV that modulates the YIQ block's Y (luma) bias (linear -1..1 offset in packed 0..1 space).",
      yiq_y_in: "Mono override for the YIQ luma (Y) channel, packed 0..1 (replaces Y pre-offset).",
      yiq_i_cv: "CV that modulates the YIQ I (orange↔cyan flesh-tone) bias (linear -1..1 in packed space).",
      yiq_i_in: "Mono override for the YIQ I chroma channel, packed 0..1 (0.5 = neutral; a warmth/skin key).",
      yiq_q_cv: "CV that modulates the YIQ Q (green↔magenta) bias (linear -1..1 in packed space).",
      yiq_q_in: "Mono override for the YIQ Q chroma channel, packed 0..1 (0.5 = neutral).",
      ycc_y_cv: "CV that modulates the studio-swing Y' (studio luma) bias (linear -1..1; decode amplifies it ~1.16×).",
      ycc_y_in: "Mono override for the studio-swing luma (Y') channel, encoded 0..1 (blacks ~0.063, whites ~0.922).",
      ycc_cb_cv: "CV that modulates the studio-swing Cb (blue-yellow legal chroma) bias (linear -1..1).",
      ycc_cb_in: "Mono override for the studio-swing Cb chroma channel, encoded 0..1 (0.502 = neutral).",
      ycc_cr_cv: "CV that modulates the studio-swing Cr (red-cyan legal chroma) bias (linear -1..1).",
      ycc_cr_in: "Mono override for the studio-swing Cr chroma channel, encoded 0..1 (0.502 = neutral).",
    },
    outputs: {
      pass: "The source video, UNMODIFIED — independent of all three blocks. Opaque black when IN is unpatched.",
      rgb: "The RGB block's colorized output: per-channel adjusted red/green/blue, then the optional palette REPLACE remap.",
      ydbdr: "The YDbDr block's colorized output: adjusted Y/Db/Dr decoded back to RGB (the SECAM look).",
      hsvhsl: "The HSV or HSL block's colorized output (per the HSL toggle): adjusted hue/sat/value(lightness) decoded to RGB.",
      r: "Mono-video: the R channel of the ADJUSTED RGB block as grayscale (before the palette remap).",
      g: "Mono-video: the G channel of the ADJUSTED RGB block as grayscale.",
      b: "Mono-video: the B channel of the ADJUSTED RGB block as grayscale.",
      luma: "Mono-video: Rec.601 luma (0.299R+0.587G+0.114B) of the ADJUSTED RGB block, grayscale.",
      ydb_y: "Mono-video: the adjusted YDbDr luma (Y) channel as grayscale (packed 0..1).",
      ydb_db: "Mono-video: the adjusted YDbDr Db (blue-yellow) chroma as grayscale (0.5 = neutral).",
      ydb_dr: "Mono-video: the adjusted YDbDr Dr (red-cyan) chroma as grayscale (0.5 = neutral).",
      hsv_h: "Mono-video: the adjusted HUE as grayscale (0..1, circular — a hard black↔white seam at 0≡1 is correct, not a defect).",
      hsv_s: "Mono-video: the adjusted SATURATION as grayscale (0..1).",
      hsv_v: "Mono-video: the adjusted VALUE (HSV) / LIGHTNESS (HSL) as grayscale (0..1).",
      yiq: "The YIQ block's colorized output: adjusted Y/I/Q decoded back to RGB (the NTSC composite look).",
      yiq_y: "Mono-video: the adjusted YIQ luma (Y) channel as grayscale (same Rec.601 luma as `luma`).",
      yiq_i: "Mono-video: the adjusted YIQ I (orange↔cyan flesh-tone) chroma as grayscale — a ready-made warmth/skin key (0.5 = neutral).",
      yiq_q: "Mono-video: the adjusted YIQ Q (green↔magenta) chroma as grayscale (0.5 = neutral).",
      ycc: "The studio-swing block's colorized output: adjusted Y'/Cb/Cr expanded + decoded to RGB (the broadcast-legal crush look).",
      ycc_y: "Mono-video: the adjusted studio-swing luma (Y') as grayscale (studio range — blacks ~0.063, whites ~0.922).",
      ycc_cb: "Mono-video: the adjusted studio-swing Cb (blue-yellow legal chroma) as grayscale (0.502 = neutral).",
      ycc_cr: "Mono-video: the adjusted studio-swing Cr (red-cyan legal chroma) as grayscale (0.502 = neutral).",
    },
    controls: {
      bias_r: "r: additive offset on the RGB red channel, -1 to 1 (default 0 = no change). Sums with the rgb_r_cv input.",
      bias_g: "g: additive offset on the RGB green channel, -1 to 1 (default 0). Sums with rgb_g_cv.",
      bias_b: "b: additive offset on the RGB blue channel, -1 to 1 (default 0). Sums with rgb_b_cv.",
      bias_y: "y: additive offset on the YDbDr luma channel (packed 0..1 space), -1 to 1 (default 0). Sums with ydb_y_cv.",
      bias_db: "db: additive offset on the YDbDr Db (blue-yellow) chroma, -1 to 1 (default 0), around the 0.5 pedestal. Sums with ydb_db_cv.",
      bias_dr: "dr: additive offset on the YDbDr Dr (red-cyan) chroma, -1 to 1 (default 0), around the 0.5 pedestal. Sums with ydb_dr_cv.",
      bias_h: "h: hue rotation for the HSV/HSL block, -180 to 180 degrees (default 0). Hue always wraps. Sums with hsv_h_cv.",
      bias_s: "s: additive offset on saturation, -1 to 1 (default 0). Sums with hsv_s_cv.",
      bias_v: "v: additive offset on value (HSV) or lightness (HSL), -1 to 1 (default 0). Sums with hsv_v_cv.",
      bias_yiq_y: "y: additive offset on the YIQ luma channel (packed 0..1 space), -1 to 1 (default 0). Sums with yiq_y_cv.",
      bias_yiq_i: "i: additive offset on the YIQ I (orange↔cyan flesh-tone) chroma, -1 to 1 (default 0), around the 0.5 pedestal — one nudge is a whole teal-&-orange grade. Sums with yiq_i_cv.",
      bias_yiq_q: "q: additive offset on the YIQ Q (green↔magenta) chroma, -1 to 1 (default 0), around the 0.5 pedestal. Sums with yiq_q_cv.",
      bias_ycc_y: "y: additive offset on the studio-swing luma (Y'), -1 to 1 (default 0). Decode expands studio→full range, so the offset is AMPLIFIED ~1.16× (the broadcast crush). Sums with ycc_y_cv.",
      bias_ycc_cb: "cb: additive offset on the studio-swing Cb (blue-yellow legal chroma), -1 to 1 (default 0), around the 0.502 pedestal. Sums with ycc_cb_cv.",
      bias_ycc_cr: "cr: additive offset on the studio-swing Cr (red-cyan legal chroma), -1 to 1 (default 0), around the 0.502 pedestal. Sums with ycc_cr_cv.",
      over_r: "r wrap: overflow for the RGB red channel — CLAMP (0, default) clips out-of-range to 0..1; WRAP (1) folds it around via fract().",
      over_g: "g wrap: overflow mode for the RGB green channel (CLAMP default / WRAP).",
      over_b: "b wrap: overflow mode for the RGB blue channel (CLAMP default / WRAP).",
      over_y: "y wrap: overflow mode for the YDbDr luma channel (CLAMP default / WRAP).",
      over_db: "db wrap: overflow mode for the YDbDr Db chroma (CLAMP default / WRAP).",
      over_dr: "dr wrap: overflow mode for the YDbDr Dr chroma (CLAMP default / WRAP).",
      over_s: "s wrap: overflow mode for saturation (CLAMP default / WRAP).",
      over_v: "v wrap: overflow mode for value/lightness (CLAMP default / WRAP).",
      over_h: "h wrap: ADVISORY only — hue ALWAYS wraps regardless of this toggle. Declared for UI symmetry with the other channels; disabled on the card.",
      over_yiq_y: "y wrap: overflow mode for the YIQ luma channel (CLAMP default / WRAP).",
      over_yiq_i: "i wrap: overflow mode for the YIQ I chroma (CLAMP default / WRAP — WRAP on the narrow-band chroma is the NTSC chroma-crawl fold).",
      over_yiq_q: "q wrap: overflow mode for the YIQ Q chroma (CLAMP default / WRAP).",
      over_ycc_y: "y wrap: overflow mode for the studio-swing luma (CLAMP clips at the legal boundary — a legalizer; WRAP folds super-white through black).",
      over_ycc_cb: "cb wrap: overflow mode for the studio-swing Cb chroma (CLAMP default / WRAP — the illegal-chroma fold).",
      over_ycc_cr: "cr wrap: overflow mode for the studio-swing Cr chroma (CLAMP default / WRAP — the illegal-chroma fold).",
      mode_hsl: "hsl: selects the third block's colorspace — HSV (0, default) or HSL (1). Affects the hsvhsl output + the v channel's meaning (value vs lightness).",
      replace: "replace: turns the RGB palette REPLACE mode on (1) or off (0, default). When on, the adjusted R/G/B channels are recomposed from the three picked palette colours (duotone/tritone). Picking any swatch auto-enables it, and the swatches default to a non-identity teal/orange/violet, so it visibly recolours the rgb out as soon as it is on.",
      pal_r: "pal r: the palette colour the RGB red channel maps to under REPLACE (packed 0xRRGGBB, default orange). Set via the card's colour picker (which auto-enables REPLACE).",
      pal_g: "pal g: the palette colour the RGB green channel maps to under REPLACE (packed 0xRRGGBB, default teal). Set via the card's colour picker.",
      pal_b: "pal b: the palette colour the RGB blue channel maps to under REPLACE (packed 0xRRGGBB, default violet). Set via the card's colour picker.",
      preview: "preview: which of the 22 outputs the on-card preview canvas shows (discrete 0..21: 0 pass, 1 rgb, 2 ydbdr, 3 hsvhsl, 4 r, 5 g, 6 b, 7 luma, 8 ydb_y, 9 ydb_db, 10 ydb_dr, 11 hsv_h, 12 hsv_s, 13 hsv_v, 14 yiq, 15 yiq_y, 16 yiq_i, 17 yiq_q, 18 ycc, 19 ycc_y, 20 ycc_cb, 21 ycc_cr). Default 1 (rgb). The previewed output is always rendered even when unpatched; other outputs render only when patched downstream.",
      freeze: "freeze: hidden determinism toggle — at 1 the renderer holds its last rendered frame (no redraw) for stable VRT capture. Default 0; no card control.",
    },
  },
  // docs-hash-ignore:end

  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);

    // ---- uniform locations (resolved once) ----
    const uTex = gl.getUniformLocation(program, 'uTex');
    const uHasInput = gl.getUniformLocation(program, 'uHasInput');
    const uHsl = gl.getUniformLocation(program, 'uHsl');
    const uReplace = gl.getUniformLocation(program, 'uReplace');
    const uPalR = gl.getUniformLocation(program, 'uPalR');
    const uPalG = gl.getUniformLocation(program, 'uPalG');
    const uPalB = gl.getUniformLocation(program, 'uPalB');
    const uOutMode = gl.getUniformLocation(program, 'uOutMode');
    const uBias = {
      r: gl.getUniformLocation(program, 'uBiasR'),
      g: gl.getUniformLocation(program, 'uBiasG'),
      b: gl.getUniformLocation(program, 'uBiasB'),
      y: gl.getUniformLocation(program, 'uBiasY'),
      db: gl.getUniformLocation(program, 'uBiasDb'),
      dr: gl.getUniformLocation(program, 'uBiasDr'),
      h: gl.getUniformLocation(program, 'uBiasH'),
      s: gl.getUniformLocation(program, 'uBiasS'),
      v: gl.getUniformLocation(program, 'uBiasV'),
      yiqY: gl.getUniformLocation(program, 'uBiasYiqY'),
      yiqI: gl.getUniformLocation(program, 'uBiasYiqI'),
      yiqQ: gl.getUniformLocation(program, 'uBiasYiqQ'),
      yccY: gl.getUniformLocation(program, 'uBiasYccY'),
      yccCb: gl.getUniformLocation(program, 'uBiasYccCb'),
      yccCr: gl.getUniformLocation(program, 'uBiasYccCr'),
    };
    const uOver = {
      r: gl.getUniformLocation(program, 'uOverR'),
      g: gl.getUniformLocation(program, 'uOverG'),
      b: gl.getUniformLocation(program, 'uOverB'),
      y: gl.getUniformLocation(program, 'uOverY'),
      db: gl.getUniformLocation(program, 'uOverDb'),
      dr: gl.getUniformLocation(program, 'uOverDr'),
      s: gl.getUniformLocation(program, 'uOverS'),
      v: gl.getUniformLocation(program, 'uOverV'),
      yiqY: gl.getUniformLocation(program, 'uOverYiqY'),
      yiqI: gl.getUniformLocation(program, 'uOverYiqI'),
      yiqQ: gl.getUniformLocation(program, 'uOverYiqQ'),
      yccY: gl.getUniformLocation(program, 'uOverYccY'),
      yccCb: gl.getUniformLocation(program, 'uOverYccCb'),
      yccCr: gl.getUniformLocation(program, 'uOverYccCr'),
    };
    const monoLoc = MONO_INPUTS.map((m) => ({
      ...m,
      texLoc: gl.getUniformLocation(program, m.tex),
      hasLoc: gl.getUniformLocation(program, m.has),
    }));

    // ---- one output FBO per port + a final (canonical surface) preview FBO ----
    const fbos = OUTPUTS.map((o) => ({ ...o, ...ctx.createFbo() }));
    const previewFbo = ctx.createFbo();
    const fboByPort = new Map(fbos.map((f) => [f.id, f.texture]));
    // Set of output ids to render each frame — reused (cleared, not re-alloc'd).
    const renderSet = new Set<string>();

    // Shared 1×1 black sentinel for unpatched samplers. NEVER bind our own FBO
    // texture (a read+write feedback loop → garbage on Chrome).
    const emptyTex = gl.createTexture();
    if (!emptyTex) throw new Error('COLOUR OF MAGIC: createTexture failed');
    gl.bindTexture(gl.TEXTURE_2D, emptyTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const params: ColourParams = { ...DEFAULTS, ...(node.params as Partial<ColourParams>) };

    const surface: VideoNodeSurface = {
      fbo: previewFbo.fbo,
      texture: previewFbo.texture,
      draw(frame) {
        // freeze (VRT determinism): hold the last rendered frame in every FBO.
        if (params.freeze >= 0.5) return;

        const g = frame.gl;
        g.useProgram(program);

        // ---- bind the source picture (unit 0) + connected flag ----
        const inputTex = frame.getInputTexture(node.id, 'in');
        g.uniform1f(uHasInput, inputTex ? 1.0 : 0.0);
        g.activeTexture(g.TEXTURE0);
        g.bindTexture(g.TEXTURE_2D, inputTex ?? emptyTex);
        g.uniform1i(uTex, 0);

        // ---- bind the 15 mono overrides (units 1..15) + connected flags ----
        for (const m of monoLoc) {
          const tex = frame.getInputTexture(node.id, m.id);
          g.activeTexture(g.TEXTURE0 + m.unit);
          g.bindTexture(g.TEXTURE_2D, tex ?? emptyTex);
          g.uniform1i(m.texLoc, m.unit);
          g.uniform1f(m.hasLoc, tex ? 1.0 : 0.0);
        }

        // ---- scalar/vector uniforms (same every pass; uOutMode set per pass) ----
        g.uniform1f(uBias.r, params.bias_r);
        g.uniform1f(uBias.g, params.bias_g);
        g.uniform1f(uBias.b, params.bias_b);
        g.uniform1f(uBias.y, params.bias_y);
        g.uniform1f(uBias.db, params.bias_db);
        g.uniform1f(uBias.dr, params.bias_dr);
        g.uniform1f(uBias.h, params.bias_h);
        g.uniform1f(uBias.s, params.bias_s);
        g.uniform1f(uBias.v, params.bias_v);
        g.uniform1f(uBias.yiqY, params.bias_yiq_y);
        g.uniform1f(uBias.yiqI, params.bias_yiq_i);
        g.uniform1f(uBias.yiqQ, params.bias_yiq_q);
        g.uniform1f(uBias.yccY, params.bias_ycc_y);
        g.uniform1f(uBias.yccCb, params.bias_ycc_cb);
        g.uniform1f(uBias.yccCr, params.bias_ycc_cr);
        g.uniform1f(uOver.r, params.over_r);
        g.uniform1f(uOver.g, params.over_g);
        g.uniform1f(uOver.b, params.over_b);
        g.uniform1f(uOver.y, params.over_y);
        g.uniform1f(uOver.db, params.over_db);
        g.uniform1f(uOver.dr, params.over_dr);
        g.uniform1f(uOver.s, params.over_s);
        g.uniform1f(uOver.v, params.over_v);
        g.uniform1f(uOver.yiqY, params.over_yiq_y);
        g.uniform1f(uOver.yiqI, params.over_yiq_i);
        g.uniform1f(uOver.yiqQ, params.over_yiq_q);
        g.uniform1f(uOver.yccY, params.over_ycc_y);
        g.uniform1f(uOver.yccCb, params.over_ycc_cb);
        g.uniform1f(uOver.yccCr, params.over_ycc_cr);
        g.uniform1f(uHsl, params.mode_hsl);
        g.uniform1f(uReplace, params.replace);
        const pr = unpackColor01(params.pal_r);
        const pg = unpackColor01(params.pal_g);
        const pb = unpackColor01(params.pal_b);
        g.uniform3f(uPalR, pr[0], pr[1], pr[2]);
        g.uniform3f(uPalG, pg[0], pg[1], pg[2]);
        g.uniform3f(uPalB, pb[0], pb[1], pb[2]);

        // ---- LAZY FBO: render only outputs that are PATCHED downstream + the
        //      one being PREVIEWED, not all 22 (keeps the SwiftShader cost low).
        //      Falls back to render-ALL when the engine can't report connectivity
        //      (older builds / test mocks) so no consumer ever goes dark.
        const previewMode = Math.max(0, Math.min(MAX_OUT_MODE, Math.round(params.preview)));
        const connected = frame.connectedOutputPorts?.(node.id);
        renderSet.clear();
        for (const f of fbos) {
          const render = connected ? connected.has(f.id) || f.mode === previewMode : true;
          if (!render) continue;
          renderSet.add(f.id);
          g.bindFramebuffer(g.FRAMEBUFFER, f.fbo);
          g.viewport(0, 0, ctx.res.width, ctx.res.height);
          g.uniform1i(uOutMode, f.mode);
          ctx.drawFullscreenQuad();
        }

        // ---- final pass: the preview-selected output into the canonical surface,
        //      so blitOutputToDrawingBuffer (which reads surface.texture) shows it.
        g.bindFramebuffer(g.FRAMEBUFFER, previewFbo.fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.uniform1i(uOutMode, previewMode);
        ctx.drawFullscreenQuad();

        g.bindFramebuffer(g.FRAMEBUFFER, null);
      },
      dispose() {
        for (const f of fbos) {
          gl.deleteFramebuffer(f.fbo);
          gl.deleteTexture(f.texture);
        }
        gl.deleteFramebuffer(previewFbo.fbo);
        gl.deleteTexture(previewFbo.texture);
        gl.deleteTexture(emptyTex);
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
        // Per-output texture escape hatch — engine.lookupInput checks this
        // BEFORE surface.texture, so each output port resolves to its own FBO.
        if (key.startsWith('outputTexture:')) {
          return fboByPort.get(key.slice('outputTexture:'.length));
        }
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};

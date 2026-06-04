// packages/web/src/lib/video/modules/b3ntb0x.ts
//
// B3NTB0X — a circuit-level NTSC composite RE-ARCHITECTURE of BENTBOX.
//
// Where BENTBOX does a single symbolic RGB/YIQ-domain pass, B3NTB0X runs a
// REAL multi-pass composite pipeline that synthesizes an actual per-column
// composite VOLTAGE, processes that voltage through an analog bend circuit,
// then demodulates it back to RGB and renders it on a CRT. Sync crush,
// dot-crawl, and rainbow EMERGE from the signal path — they are not cosmetic.
//
// FOUR chained passes in ONE module factory (mirrors shapedramps.ts: bind
// FBO → viewport → useProgram → bind prior-pass texture(s) → set uniforms →
// drawFullscreenQuad → bindFramebuffer(null) at the end):
//
//   1. EncodeComposite → fboEncode (FLOAT RGBA16F, OVERSAMPLED width).
//      R = composite voltage (Y + I·cos φ + Q·sin φ in active region; sync /
//      blank / burst voltages elsewhere). G = clean Y (luma helper). B =
//      burst-reference phase φ (so the decoder demods by the SAME phase).
//      A = sync mask (0 sync / 0.25 blank / 0.5 burst / 1.0 active).
//      RGBA16F is MANDATORY: R swings < -0.3 (sync tip) and > 1.0 (overdrive
//      headroom) — RGBA8 can't hold it (it degrades — "reduced precision").
//
//   2. BendCircuit → fboBend (FLOAT, SAME oversampled size). Processes
//      fboEncode.R as an analog voltage (AC/DC coupling → gain/ENHANCE →
//      bias → soft-clip + diode-clamp). Carries G/B/A through unchanged so
//      the decoder can still recover phase even when sync is crushed. ONE
//      ping-pong float pair so the AC-coupling leaky baseline (+ Phase-2
//      sync-feedback) can read last frame's baseline (channel A of the back
//      buffer — see below). Bend A-D taps + WAVEFOLD are Phase-2 stubs.
//
//   3. DecodeComposite → fboDecode (RGBA8, ENGINE RES). For each output
//      pixel: recover line-start x-offset from the (damaged) sync, then run a
//      13-tap (N=6) quadrature demod across the oversampled neighbours,
//      phase from B (recovered burst), Gaussian-weighted LP. Decoder type
//      P1 = single forgiving-CRT path; TBC/Lock blends the recovered offset
//      toward nominal.
//
//   4. CRTDisplay → fboCrtA / fboCrtB (RGBA8 ping-pong, persistence). Beam
//      blur, phosphor RGB-triad mask, scanline gap (interlace via field
//      parity derived from decoded line timing), bloom, persistence,
//      overscan + barrel + 4:3 active area INSIDE the shader (never re-impose
//      4:3 in the card blit). The CRT front buffer is surface.texture/fbo,
//      repointed at end of draw() so downstream chaining + the card blit see
//      the fresh frame.
//
// Total P1 FBOs = encode(1 float) + bend(2 float) + decode(1 rgba8) +
// crt(2 rgba8) = 6.
//
// The pure DSP math (rgbToYiq, encodeComposite, quadDemod, softClip, …) lives
// in ./b3ntb0x-dsp.ts and is unit-tested in jsdom (no GL). The GLSL below
// mirrors it. NOTHING is imported from BENTBOX / TOYBOX / QUADRALOGICAL.
//
// Attribution: YIQ matrix + 3.579545 MHz subcarrier + RS-170A line geometry
// are public-domain physics. Algorithm shape informed by LMP88959 NTSC-CRT
// (MIT) + Blargg ntsc (MIT) — no code copied.

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';
import { detectEdge, makeEdgeState, type EdgeState } from '$lib/doom/cv-gate-edge';

// ---------- knobs / constants ----------

/** Horizontal oversample factor for the composite carrier. The real NTSC
 *  line holds 227.5 subcarrier cycles; 8× oversample over a 640px engine
 *  width gives tens of cycles per active line — enough for visible dot-crawl
 *  without exploding cost. This is the deliberate fidelity↔cost knob (raise
 *  in Phase 2 for higher subcarrier fidelity). */
export const OVERSAMPLE = 8;

/** Oversampled pixels per subcarrier cycle. With OVERSAMPLE=8 a 4-px period
 *  packs 2 cycles per engine pixel of active width — plenty of carrier for
 *  the demod loop to integrate over while staying cheap. */
export const SUBCARRIER_PERIOD = 4;

// ---------- pure mirror re-exports (shared with the unit test) ----------

export {
  rgbToYiq,
  yiqToRgb,
  softClip,
  diodeClamp,
  asymSat,
  onePoleHP,
  acCoupleMix,
  enhancePeak,
  subcarrierPhase,
  encodeComposite,
  quadDemod,
  gaussianWeight,
  syncVoltageForColumn,
  regionTagForColumn,
  burstVoltage,
  b3ntb0xMirrorUv,
} from './b3ntb0x-dsp';

// ---------- MIRROR gate edge tracking (clean, NOT imported from bentbox) ----------

export interface B3ntb0xMirrorGateState {
  x: EdgeState;
  y: EdgeState;
}
export function makeB3ntb0xMirrorGateState(): B3ntb0xMirrorGateState {
  return { x: makeEdgeState(), y: makeEdgeState() };
}
/** Feed one gate sample; true iff it produced a RISING edge (caller flips the
 *  matching mirror boolean). Mutates `edge` in place. */
export function b3ntb0xMirrorGateTick(edge: EdgeState, sample: number): boolean {
  return detectEdge(edge, sample)?.pressed === true;
}

// ===========================================================================
// PASS 1 — EncodeComposite. RGB input → oversampled composite-voltage FLOAT
// texture. Output column u maps to a position along the NTSC line.
// ===========================================================================

const ENCODE_FRAG = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uIn;       // upstream RGB (active picture)
uniform float uHasInput;
uniform float uTime;         // for subcarrier drift
uniform float uBurstStarve;  // 0..1 — starves the burst phase reference
uniform float uHue;          // -1..1 — rotates the whole carrier (burst phase)
uniform float uSubDrift;     // 0..1 — subcarrier drift rate

const float PI = 3.14159265;
const float TWO_PI = 6.2831853;

// Region fractions of the line (must match b3ntb0x-dsp.ts).
const float SYNC_TIP_END = 0.075;
const float BLANK_END    = 0.10;
const float BURST_END    = 0.14;
const float ACTIVE_START  = 0.16;
const float SYNC_TIP_V   = -0.3;
const float BURST_AMP    = 0.15;

const float OVERSAMPLE       = ${OVERSAMPLE}.0;
const float SUBCARRIER_PERIOD = ${SUBCARRIER_PERIOD}.0;

vec3 rgb2yiq(vec3 c) {
  return vec3(
    0.299 * c.r + 0.587 * c.g + 0.114 * c.b,
    0.595716 * c.r - 0.274453 * c.g - 0.321263 * c.b,
    0.211456 * c.r - 0.522591 * c.g + 0.311135 * c.b
  );
}

void main() {
  // vUv.x runs across the oversampled width; it IS the line-fraction.
  float lineFrac = vUv.x;

  // Burst phase: 180deg reference + Hue rotation + slow drift.
  float burstPhase = PI + (uHue * 0.5 + uSubDrift * uTime * 0.15) * TWO_PI;

  // Region tag (A channel).
  float region;
  if (lineFrac < SYNC_TIP_END)      region = 0.0;   // sync tip
  else if (lineFrac < BLANK_END)    region = 0.25;  // blanking / front porch
  else if (lineFrac < BURST_END)    region = 0.5;   // colour burst
  else if (lineFrac < ACTIVE_START) region = 0.25;  // back porch
  else                              region = 1.0;    // active video

  // Oversampled column index along the ACTIVE region (for the carrier phase).
  // Map the active span [ACTIVE_START,1) to oversampled column indices.
  float activeFrac = (lineFrac - ACTIVE_START) / (1.0 - ACTIVE_START);
  float activeColIdx = activeFrac * (1.0 - ACTIVE_START) * 640.0 * OVERSAMPLE / SUBCARRIER_PERIOD;
  float phase = activeColIdx * TWO_PI + burstPhase;

  float comp;   // R: composite voltage
  float cleanY = 0.0; // G: undistorted luma helper

  if (region < 0.1) {
    comp = SYNC_TIP_V;               // sync tip below blanking
  } else if (region > 0.4 && region < 0.6) {
    // Colour burst on the back porch: blanking + starvable carrier.
    float burst = BURST_AMP * (1.0 - clamp(uBurstStarve, 0.0, 1.0)) * cos(phase + PI);
    comp = burst;
  } else if (region < 0.9) {
    comp = 0.0;                       // blanking / porches
  } else {
    // ACTIVE: sample the picture at the active fraction (vertical = vUv.y).
    vec3 src = uHasInput > 0.5 ? texture(uIn, vec2(clamp(activeFrac, 0.0, 1.0), vUv.y)).rgb : vec3(0.0);
    vec3 yiq = rgb2yiq(src);
    cleanY = yiq.x;
    comp = yiq.x + yiq.y * cos(phase) + yiq.z * sin(phase);
  }

  // R = composite voltage, G = clean Y, B = carrier phase reference
  // (wrapped to [0,1) so it survives RGBA16F), A = region tag.
  float phaseRef = fract(phase / TWO_PI);
  outColor = vec4(comp, cleanY, phaseRef, region);
}`;

// ===========================================================================
// PASS 2 — BendCircuit. Processes fboEncode.R as an analog composite voltage;
// G/B/A pass through. Reads last frame's baseline from the back buffer's A
// channel (we repurpose the bend buffer's .a to carry the leaky baseline so
// AC coupling is a real cross-frame one-pole integrator).
// ===========================================================================

const BEND_FRAG = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uEncode;   // this frame's composite (R=v, G=Y, B=phase, A=region)
uniform sampler2D uPrevBend; // last frame's bend output (A = baseline state)
uniform float uHasPrev;

uniform float uEnhance;    // 0..1 HF peaking
uniform float uBias;       // -1..1 DC offset before clip
uniform float uAcDc;       // 0..1 coupling (0=DC passthrough, 1=AC leaky-HP)
uniform float uSyncCrush;  // 0..2 transistor/master gain into the clip
uniform float uBendA;      // -1..1 (P1 stub — identity)
uniform float uBendB;
uniform float uBendC;
uniform float uBendD;

const float OVERSAMPLE = ${OVERSAMPLE}.0;

float softClip(float v) {
  float v2 = v * v;
  return v * (27.0 + v2) / (27.0 + 9.0 * v2);
}

void main() {
  vec4 enc = texture(uEncode, vUv);
  float v = enc.r;          // composite voltage
  float region = enc.a;

  // --- 1. INPUT COUPLING (AC/DC). Leaky baseline lives in prev .a. ---
  float baseline = uHasPrev > 0.5 ? texture(uPrevBend, vUv).a : 0.0;
  // Slow one-pole leak toward v.
  float alpha = 0.02;
  float nb = baseline + alpha * (v - baseline);
  float vHp = v - nb;
  float c = clamp(uAcDc, 0.0, 1.0);
  float vc = v * (1.0 - c) + vHp * c;

  // --- 2. TRANSISTOR GAIN + ENHANCE (HF peaking). ---
  // Neighbour average for the HF high-pass (one oversampled px each side).
  float dx = 1.0 / (640.0 * OVERSAMPLE);
  float vl = texture(uEncode, vec2(vUv.x - dx, vUv.y)).r;
  float vr = texture(uEncode, vec2(vUv.x + dx, vUv.y)).r;
  float neighborAvg = (vl + vr) * 0.5;
  vc = vc + (vc - neighborAvg) * uEnhance * 2.0;
  vc = vc * uSyncCrush;

  // --- 3. BIAS (asymmetric clip). ---
  vc = vc + uBias;

  // --- 4. NONLINEARITY: soft-clip + one-sided diode clamp. ---
  // No clamp protecting the sync region: high gain/bias drag the sync tip
  // up THROUGH the clamp and crush it -> the decoder later fails to lock.
  vc = softClip(vc);
  vc = clamp(vc, -0.6, 1.4);   // diode clamp (asymmetric ceil/floor)

  // --- 5. BEND NETWORK (Bend A-D) — P1 identity passthrough (uniforms read
  // so they're not optimized out; live cross-coupling lands in Phase 2). ---
  vc += (uBendA + uBendB + uBendC + uBendD) * 0.0;

  // --- 6. OUTPUT COUPLING (DC restore) — re-center lightly before decode. ---
  vc = vc - nb * c * 0.5;

  // Write R = bent voltage; carry G (clean Y) + B (phase) + store the NEW
  // baseline in A for next frame's leaky integrator. NOTE: A no longer
  // carries the region tag for the decoder — the decoder reads the region
  // from the ENCODE texture's A (helper side-channel), not from bend.
  outColor = vec4(vc, enc.g, enc.b, nb);
}`;

// ===========================================================================
// PASS 3 — DecodeComposite. Quadrature demod + horizontal LP back to RGB at
// engine res. Reads bent voltage (R) from fboBend, region/phase helpers from
// fboEncode (the side-channel truth: region tag A + clean Y G), recovered
// phase from fboBend.B.
// ===========================================================================

const DECODE_FRAG = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uBend;    // bent composite (R=v, G=Y, B=phase, A=baseline)
uniform sampler2D uEncode;  // helper truth (A=region tag, B=clean phase)
uniform float uChromaLeak;  // 0..1 — chroma the LP leaks into luma (dot crawl)
uniform float uLumaPeak;    // 0..1 — decode-side unsharp on Y
uniform float uTbc;         // 0..1 — line-relock strength
uniform float uBurstStarve; // 0..1 — colour-burst starvation (decoder loses lock)

const float PI = 3.14159265;
const float TWO_PI = 6.2831853;
const float OVERSAMPLE        = ${OVERSAMPLE}.0;
const float ACTIVE_START      = 0.16;
const float SUBCARRIER_PERIOD = ${SUBCARRIER_PERIOD}.0;
const float N = 6.0;

vec3 yiq2rgb(vec3 c) {
  return clamp(vec3(
    c.x + 0.9563 * c.y + 0.6210 * c.z,
    c.x - 0.2721 * c.y - 0.6474 * c.z,
    c.x - 1.1070 * c.y + 1.7046 * c.z
  ), 0.0, 1.0);
}

// Recover the line-start x-offset by searching the bent sync near line start
// for the sync-tip -> blanking rising edge in R (threshold crossing).
float recoverLineOffset(float y) {
  float dx = 1.0 / (640.0 * OVERSAMPLE);
  float nominalEdge = 0.075; // SYNC_TIP_END
  float detected = nominalEdge;
  // Scan a small window around the nominal sync-tip end.
  for (int k = 0; k < 24; k++) {
    float x = 0.02 + float(k) * (0.10 / 24.0);
    float v = texture(uBend, vec2(x, y)).r;
    // sync tip is the most-negative region; the edge is where v rises above
    // a mid-sync threshold.
    if (v > -0.15) { detected = x; break; }
  }
  float rawOffset = detected - nominalEdge;
  // TBC blends the recovered offset toward 0 (nominal). 0 = trust damaged
  // sync fully (max glitch); 1 = full time-base-correct (rock steady).
  return rawOffset * (1.0 - clamp(uTbc, 0.0, 1.0));
}

void main() {
  // Map this output pixel to the active region of the oversampled line.
  float y = vUv.y;
  float offset = recoverLineOffset(y);

  // Output x in [0,1) -> active fraction -> oversampled center column.
  float activeFrac = vUv.x;
  float centerLineFrac = ACTIVE_START + activeFrac * (1.0 - ACTIVE_START) - offset;
  float dx = 1.0 / (640.0 * OVERSAMPLE);

  float ySum = 0.0;
  float iSum = 0.0;
  float qSum = 0.0;
  float wSum = 0.0;

  // 13-tap quadrature demod loop (k = -6..6) across oversampled neighbours.
  for (int k = -6; k <= 6; k++) {
    float fk = float(k);
    float lf = centerLineFrac + fk * dx;
    vec4 b = texture(uBend, vec2(clamp(lf, 0.0, 1.0), y));
    float c = b.r;
    // Recovered carrier phase from B (wrapped fraction -> radians).
    float phase = b.z * TWO_PI;
    float w = exp(-(fk * fk) / (N * N) * 2.0);
    ySum += c * w;
    iSum += c * 2.0 * cos(phase) * w;
    qSum += c * 2.0 * sin(phase) * w;
    wSum += w;
  }

  float Y = ySum / wSum;
  float I = iSum / wSum;
  float Q = qSum / wSum;

  // BURST STARVE: starving the colour burst robs the decoder of its phase /
  // ACC reference. Two faithful consequences, both keyed off uBurstStarve:
  //   1) COLOUR KILLER — chroma gain collapses toward 0 -> the picture
  //      desaturates toward monochrome.
  //   2) SUBCARRIER CRAWL — with no burst lock the chroma subcarrier is no
  //      longer cleanly notched out of luma, so its RAW (pre-kill) energy
  //      crawls into the B&W picture as dot-crawl / herringbone. That is a
  //      real LUMINANCE change (not just chroma), so it survives a luma-only
  //      observer — the colour killer alone would be invisible to one.
  // (CPU mirror + unit test: b3ntb0xBurstStarve in b3ntb0x-dsp.ts. Keep the
  //  0.35 crawl strength in sync with BURST_STARVE_CRAWL there.)
  float burstStarve = clamp(uBurstStarve, 0.0, 1.0);
  float subcarrierEnergy = abs(I) + abs(Q); // pre-kill, for the luma crawl
  float colourKill = 1.0 - burstStarve;
  I *= colourKill;
  Q *= colourKill;
  Y += subcarrierEnergy * burstStarve * 0.35;

  // CHROMA LEAK: let some chroma energy bleed into luma (under-filtered
  // chroma -> dot crawl on the luma). Intentional.
  Y += (abs(I) + abs(Q)) * uChromaLeak * 0.25;

  // LUMA PEAK: decode-side unsharp on Y using the bent neighbours.
  if (uLumaPeak > 0.0) {
    float yl = texture(uBend, vec2(clamp(centerLineFrac - 3.0 * dx, 0.0, 1.0), y)).r;
    float yr = texture(uBend, vec2(clamp(centerLineFrac + 3.0 * dx, 0.0, 1.0), y)).r;
    Y += (Y - (yl + yr) * 0.5) * uLumaPeak;
  }

  vec3 rgb = yiq2rgb(vec3(Y, I, Q));
  outColor = vec4(rgb, 1.0);
}`;

// ===========================================================================
// PASS 4 — CRTDisplay. Decoded RGB + persistence -> CRT-rendered RGBA8 at
// engine res. 4:3 active area inside 16:9 FBO, overscan, barrel, beam blur,
// phosphor triad, scanline gap (interlace), bloom, persistence.
// ===========================================================================

const CRT_FRAG = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uDecode;
uniform sampler2D uPrev;     // last CRT frame (persistence)
uniform float uHasPrev;
uniform float uFieldParity;  // 0/1 — interlace field (decoded line timing)
uniform float uTubeBloom;    // 0..1
uniform float uFeedback;     // 0..1 persistence amount
uniform float uOverscan;     // 0..1
uniform float uBarrel;       // 0..1
uniform float uMirrorX;
uniform float uMirrorY;

const float TWO_PI = 6.2831853;
const float LINES = 240.0;

vec2 mirrorUv(vec2 uv) {
  if (uMirrorX > 0.5) uv.x = uv.x < 0.5 ? uv.x : (1.0 - uv.x);
  if (uMirrorY > 0.5) uv.y = uv.y >= 0.5 ? uv.y : (1.0 - uv.y);
  return uv;
}

void main() {
  vec2 uv = mirrorUv(vUv);

  // --- 4:3 active area inside the 16:9 FBO (pillarbox in-shader). ---
  // Engine FBO is 640x480 (4:3) already, but we still carve a centered 4:3
  // active region + apply overscan so edges fall outside the visible area
  // (real TVs overscan). For a 4:3 FBO the active fraction is the full width;
  // we keep the pillarbox math so it's correct if the FBO aspect changes.
  float activeW = 1.0;     // full width on a 4:3 FBO
  float pillar = (1.0 - activeW) * 0.5;
  vec2 a = vec2((uv.x - pillar) / activeW, uv.y);

  // --- Overscan: scale the sampled UV slightly > 1 about the center. ---
  float scale = 1.0 + uOverscan * 0.08;
  a = (a - 0.5) / scale + 0.5;

  // --- Barrel distortion: bend outward about center; mask outside. ---
  vec2 cc = a - 0.5;
  float r2 = dot(cc, cc);
  a = 0.5 + cc * (1.0 + uBarrel * 0.42 * r2);

  // Outside the curved active area -> black bezel.
  if (a.x < 0.0 || a.x > 1.0 || a.y < 0.0 || a.y > 1.0) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  // --- BEAM BLUR: small horizontal-biased gaussian (beam wider than a px). ---
  float dx = 1.0 / 640.0;
  vec3 col = texture(uDecode, a).rgb * 0.5;
  col += texture(uDecode, a + vec2(dx, 0.0)).rgb * 0.2;
  col += texture(uDecode, a - vec2(dx, 0.0)).rgb * 0.2;
  col += texture(uDecode, a + vec2(2.0 * dx, 0.0)).rgb * 0.05;
  col += texture(uDecode, a - vec2(2.0 * dx, 0.0)).rgb * 0.05;

  // --- BLOOM / HALATION: bright areas SPILL into their neighbours (the glass +
  //     phosphor glow). A real spatial gather of the bright-pass — horizontally
  //     biased (the beam smears along the line) — added back, so highlights bleed
  //     and bloom instead of just getting brighter in place. Off at 0 (guarded).
  if (uTubeBloom > 0.0) {
    vec3 glow = vec3(0.0);
    float wsum = 0.0;
    for (int i = -4; i <= 4; i++) {
      for (int j = -2; j <= 2; j++) {
        vec2 off = vec2(float(i) * 2.0 * dx, float(j) * 1.5 / LINES);
        vec3 s = texture(uDecode, a + off).rgb;
        float bright = max(dot(s, vec3(0.299, 0.587, 0.114)) - 0.4, 0.0);
        // horizontally-biased gaussian (beam wider along the scanline)
        float gw = exp(-(float(i * i) * 0.12 + float(j * j) * 0.6));
        glow += s * bright * gw;
        wsum += gw;
      }
    }
    vec3 halo = (glow / max(wsum, 1e-3)) * uTubeBloom * 2.8;
    halo *= vec3(1.0, 0.97, 0.90);                 // warm phosphor glow (CRT halation runs warm)
    col += halo;
    // Highlight blow-out: the brightest phosphors saturate the tube + wash toward white.
    float hi = smoothstep(0.85, 1.3, dot(col, vec3(0.299, 0.587, 0.114)));
    col = mix(col, vec3(max(max(col.r, col.g), col.b)), hi * uTubeBloom * 0.4);
  }

  // --- SCANLINE GAP (240p), field parity offsets the gap half a line. ---
  float lineFrac = fract(a.y * LINES + uFieldParity * 0.5);
  float scanDark = 0.45 + 0.55 * smoothstep(0.0, 0.4, lineFrac) *
                                 smoothstep(1.0, 0.6, lineFrac);
  col *= scanDark;

  // --- APERTURE-GRILLE PHOSPHOR (screen-space, smooth, BLENDED). ---
  // The phosphor stripes are a property of the physical SCREEN, not the picture,
  // so key them off gl_FragCoord (the real output pixel) — they stay straight
  // while the image warps behind them (that's what reads as "image behind glass"
  // instead of an RGB pattern painted INTO the picture). Smooth cosine lobes
  // (period 3px = one R/G/B triad) instead of hard 1.15/0.85 bands, mean lifted
  // to ~1 so it doesn't net-darken, then MIXED toward neutral so the underlying
  // video colour reads through the grille rather than being replaced by it.
  float ph = gl_FragCoord.x * (TWO_PI / 3.0);
  vec3 grille = 0.55 + 0.45 * cos(ph - vec3(0.0, 1.0, 2.0) * (TWO_PI / 3.0));
  grille *= 1.0 / 0.55;                       // lift mean to ~1 (no net darkening)
  col *= mix(vec3(1.0), grille, 0.6);         // 60% grille / 40% flat → present but image reads through

  // --- VIGNETTE: corners fall off with the glass curvature, selling the bulge
  //     (scaled by barrel + a touch of overscan; identity when both are 0). ---
  float vig = 1.0 - (uBarrel * 0.65 + uOverscan * 0.22) * r2 * 1.8;
  col *= clamp(vig, 0.0, 1.0);

  vec3 cur = clamp(col, 0.0, 1.0);

  // --- PERSISTENCE: phosphor decay / motion trails. ---
  if (uHasPrev > 0.5 && uFeedback > 0.0) {
    vec3 prev = texture(uPrev, vUv).rgb;
    cur = max(cur, prev * uFeedback);
  }

  outColor = vec4(clamp(cur, 0.0, 1.0), 1.0);
}`;

// ---------- module def ----------

interface B3ntb0xParams {
  enhance: number;
  bias: number;
  ac_dc: number;
  sync_crush: number;
  burst_starve: number;
  chroma_leak: number;
  luma_peak: number;
  bend_a: number;
  bend_b: number;
  bend_c: number;
  bend_d: number;
  feedback: number;
  tbc: number;
  tube_bloom: number;
  overscan: number;
  barrel: number;
  hue: number;
  sub_drift: number;
  mirrorX: number;
  mirrorY: number;
  mirrorXGate: number;
  mirrorYGate: number;
}

const DEFAULTS: B3ntb0xParams = {
  enhance: 0,
  bias: 0,
  ac_dc: 0,
  sync_crush: 1,
  burst_starve: 0,
  chroma_leak: 0.15,
  luma_peak: 0,
  bend_a: 0,
  bend_b: 0,
  bend_c: 0,
  bend_d: 0,
  feedback: 0,
  tbc: 1, // default rock-steady (trust the time-base corrector)
  tube_bloom: 0.35,
  overscan: 0.2,
  barrel: 0.25,
  hue: 0,
  sub_drift: 0,
  mirrorX: 0,
  mirrorY: 0,
  mirrorXGate: 0,
  mirrorYGate: 0,
};

export const b3ntb0xDef: VideoModuleDef = {
  type: 'b3ntb0x',
  palette: { top: 'Video modules', sub: 'Processors' },
  domain: 'video',
  label: 'B3NTB0X',
  category: 'output',
  schemaVersion: 1,
  inputs: [
    { id: 'in',              type: 'video' },
    { id: 'enhance_cv',      type: 'cv', paramTarget: 'enhance',      cvScale: { mode: 'linear' } },
    { id: 'bias_cv',         type: 'cv', paramTarget: 'bias',         cvScale: { mode: 'linear' } },
    { id: 'ac_dc_cv',        type: 'cv', paramTarget: 'ac_dc',        cvScale: { mode: 'linear' } },
    { id: 'sync_crush_cv',   type: 'cv', paramTarget: 'sync_crush',   cvScale: { mode: 'linear' } },
    { id: 'burst_starve_cv', type: 'cv', paramTarget: 'burst_starve', cvScale: { mode: 'linear' } },
    { id: 'chroma_leak_cv',  type: 'cv', paramTarget: 'chroma_leak',  cvScale: { mode: 'linear' } },
    { id: 'luma_peak_cv',    type: 'cv', paramTarget: 'luma_peak',    cvScale: { mode: 'linear' } },
    { id: 'bend_a_cv',       type: 'cv', paramTarget: 'bend_a',       cvScale: { mode: 'linear' } },
    { id: 'bend_b_cv',       type: 'cv', paramTarget: 'bend_b',       cvScale: { mode: 'linear' } },
    { id: 'bend_c_cv',       type: 'cv', paramTarget: 'bend_c',       cvScale: { mode: 'linear' } },
    { id: 'bend_d_cv',       type: 'cv', paramTarget: 'bend_d',       cvScale: { mode: 'linear' } },
    { id: 'feedback_cv',     type: 'cv', paramTarget: 'feedback',     cvScale: { mode: 'linear' } },
    { id: 'tbc_cv',          type: 'cv', paramTarget: 'tbc',          cvScale: { mode: 'linear' } },
    { id: 'tube_bloom_cv',   type: 'cv', paramTarget: 'tube_bloom',   cvScale: { mode: 'linear' } },
    { id: 'overscan_cv',     type: 'cv', paramTarget: 'overscan',     cvScale: { mode: 'linear' } },
    { id: 'barrel_cv',       type: 'cv', paramTarget: 'barrel',       cvScale: { mode: 'linear' } },
    // MIRROR gate inputs — gate/clock style (NO cvScale => raw passthrough).
    { id: 'mirror_x_gate',   type: 'cv', paramTarget: 'mirrorXGate' },
    { id: 'mirror_y_gate',   type: 'cv', paramTarget: 'mirrorYGate' },
  ],
  outputs: [
    { id: 'out', type: 'video' },
  ],
  params: [
    { id: 'enhance',      label: 'Enhance',     defaultValue: DEFAULTS.enhance,      min: 0,  max: 1, curve: 'linear' },
    { id: 'bias',         label: 'Bias',        defaultValue: DEFAULTS.bias,         min: -1, max: 1, curve: 'linear' },
    { id: 'ac_dc',        label: 'AC/DC',       defaultValue: DEFAULTS.ac_dc,        min: 0,  max: 1, curve: 'linear' },
    { id: 'sync_crush',   label: 'Sync Crush',  defaultValue: DEFAULTS.sync_crush,   min: 0,  max: 2, curve: 'linear' },
    { id: 'burst_starve', label: 'Burst Starve',defaultValue: DEFAULTS.burst_starve, min: 0,  max: 1, curve: 'linear' },
    { id: 'chroma_leak',  label: 'Chroma Leak', defaultValue: DEFAULTS.chroma_leak,  min: 0,  max: 1, curve: 'linear' },
    { id: 'luma_peak',    label: 'Luma Peak',   defaultValue: DEFAULTS.luma_peak,    min: 0,  max: 1, curve: 'linear' },
    { id: 'bend_a',       label: 'Bend A',      defaultValue: DEFAULTS.bend_a,       min: -1, max: 1, curve: 'linear' },
    { id: 'bend_b',       label: 'Bend B',      defaultValue: DEFAULTS.bend_b,       min: -1, max: 1, curve: 'linear' },
    { id: 'bend_c',       label: 'Bend C',      defaultValue: DEFAULTS.bend_c,       min: -1, max: 1, curve: 'linear' },
    { id: 'bend_d',       label: 'Bend D',      defaultValue: DEFAULTS.bend_d,       min: -1, max: 1, curve: 'linear' },
    { id: 'feedback',     label: 'Feedback',    defaultValue: DEFAULTS.feedback,     min: 0,  max: 1, curve: 'linear' },
    { id: 'tbc',          label: 'TBC/Lock',    defaultValue: DEFAULTS.tbc,          min: 0,  max: 1, curve: 'linear' },
    { id: 'tube_bloom',   label: 'Tube Bloom',  defaultValue: DEFAULTS.tube_bloom,   min: 0,  max: 1, curve: 'linear' },
    { id: 'overscan',     label: 'Overscan',    defaultValue: DEFAULTS.overscan,     min: 0,  max: 1, curve: 'linear' },
    { id: 'barrel',       label: 'Barrel',      defaultValue: DEFAULTS.barrel,       min: 0,  max: 1, curve: 'linear' },
    { id: 'hue',          label: 'Hue',         defaultValue: DEFAULTS.hue,          min: -1, max: 1, curve: 'linear' },
    { id: 'sub_drift',    label: 'Drift',       defaultValue: DEFAULTS.sub_drift,    min: 0,  max: 1, curve: 'linear' },
    { id: 'mirrorX',      label: 'Mirror X',    defaultValue: DEFAULTS.mirrorX,      min: 0,  max: 1, curve: 'linear' },
    { id: 'mirrorY',      label: 'Mirror Y',    defaultValue: DEFAULTS.mirrorY,      min: 0,  max: 1, curve: 'linear' },
    { id: 'mirrorXGate',  label: 'Mir X Gate',  defaultValue: DEFAULTS.mirrorXGate,  min: 0,  max: 1, curve: 'linear' },
    { id: 'mirrorYGate',  label: 'Mir Y Gate',  defaultValue: DEFAULTS.mirrorYGate,  min: 0,  max: 1, curve: 'linear' },
  ],

  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const encodeProgram = ctx.compileFragment(ENCODE_FRAG);
    const bendProgram = ctx.compileFragment(BEND_FRAG);
    const decodeProgram = ctx.compileFragment(DECODE_FRAG);
    const crtProgram = ctx.compileFragment(CRT_FRAG);

    // Oversampled float FBOs for encode + bend ping-pong. createFloatFbo is
    // optional on the interface (test mocks omit it) but the real engine always
    // provides it; assert here rather than degrade silently.
    if (!ctx.createFloatFbo) throw new Error('B3NTB0X: engine ctx lacks createFloatFbo');
    const createFloatFbo = ctx.createFloatFbo.bind(ctx);
    const osWidth = ctx.res.width * OVERSAMPLE;
    const fboEncode = createFloatFbo(osWidth, ctx.res.height, { filter: 'nearest' });
    const fboBendA = createFloatFbo(osWidth, ctx.res.height, { filter: 'nearest' });
    const fboBendB = createFloatFbo(osWidth, ctx.res.height, { filter: 'nearest' });
    // True iff the GPU could give us real float targets (else reduced precision).
    const isFloat = fboEncode.isFloat && fboBendA.isFloat && fboBendB.isFloat;

    // Engine-res RGBA8 for decode + CRT ping-pong.
    const fboDecode = ctx.createFbo();
    const fboCrtA = ctx.createFbo();
    const fboCrtB = ctx.createFbo();

    // Cache uniform locations.
    const eU = {
      uIn: gl.getUniformLocation(encodeProgram, 'uIn'),
      uHasInput: gl.getUniformLocation(encodeProgram, 'uHasInput'),
      uTime: gl.getUniformLocation(encodeProgram, 'uTime'),
      uBurstStarve: gl.getUniformLocation(encodeProgram, 'uBurstStarve'),
      uHue: gl.getUniformLocation(encodeProgram, 'uHue'),
      uSubDrift: gl.getUniformLocation(encodeProgram, 'uSubDrift'),
    };
    const bU = {
      uEncode: gl.getUniformLocation(bendProgram, 'uEncode'),
      uPrevBend: gl.getUniformLocation(bendProgram, 'uPrevBend'),
      uHasPrev: gl.getUniformLocation(bendProgram, 'uHasPrev'),
      uEnhance: gl.getUniformLocation(bendProgram, 'uEnhance'),
      uBias: gl.getUniformLocation(bendProgram, 'uBias'),
      uAcDc: gl.getUniformLocation(bendProgram, 'uAcDc'),
      uSyncCrush: gl.getUniformLocation(bendProgram, 'uSyncCrush'),
      uBendA: gl.getUniformLocation(bendProgram, 'uBendA'),
      uBendB: gl.getUniformLocation(bendProgram, 'uBendB'),
      uBendC: gl.getUniformLocation(bendProgram, 'uBendC'),
      uBendD: gl.getUniformLocation(bendProgram, 'uBendD'),
    };
    const dU = {
      uBend: gl.getUniformLocation(decodeProgram, 'uBend'),
      uEncode: gl.getUniformLocation(decodeProgram, 'uEncode'),
      uChromaLeak: gl.getUniformLocation(decodeProgram, 'uChromaLeak'),
      uLumaPeak: gl.getUniformLocation(decodeProgram, 'uLumaPeak'),
      uTbc: gl.getUniformLocation(decodeProgram, 'uTbc'),
      uBurstStarve: gl.getUniformLocation(decodeProgram, 'uBurstStarve'),
    };
    const cU = {
      uDecode: gl.getUniformLocation(crtProgram, 'uDecode'),
      uPrev: gl.getUniformLocation(crtProgram, 'uPrev'),
      uHasPrev: gl.getUniformLocation(crtProgram, 'uHasPrev'),
      uFieldParity: gl.getUniformLocation(crtProgram, 'uFieldParity'),
      uTubeBloom: gl.getUniformLocation(crtProgram, 'uTubeBloom'),
      uFeedback: gl.getUniformLocation(crtProgram, 'uFeedback'),
      uOverscan: gl.getUniformLocation(crtProgram, 'uOverscan'),
      uBarrel: gl.getUniformLocation(crtProgram, 'uBarrel'),
      uMirrorX: gl.getUniformLocation(crtProgram, 'uMirrorX'),
      uMirrorY: gl.getUniformLocation(crtProgram, 'uMirrorY'),
    };

    // Black sentinel for cold-start feedback reads.
    const emptyTex = gl.createTexture();
    if (!emptyTex) throw new Error('B3NTB0X: createTexture failed');
    gl.bindTexture(gl.TEXTURE_2D, emptyTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 0]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const params: B3ntb0xParams = { ...DEFAULTS, ...(node.params as Partial<B3ntb0xParams>) };
    let framesElapsed = 0;
    let bendFrontIsA = true; // which bend buffer is SAMPLED as uPrevBend next
    let crtFrontIsA = true;  // which CRT buffer holds the latest frame
    const mirrorGate = makeB3ntb0xMirrorGateState();
    const startWallMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
    const clampSym = (v: number) => Math.max(-1, Math.min(1, v));

    const surface: VideoNodeSurface = {
      // surface.texture/fbo point at the CRT front buffer (the chainable out).
      get fbo() { return crtFrontIsA ? fboCrtA.fbo : fboCrtB.fbo; },
      get texture() { return crtFrontIsA ? fboCrtA.texture : fboCrtB.texture; },
      draw(frame) {
        const g = frame.gl;
        const inputTex = frame.getInputTexture(node.id, 'in');
        const tSec = ((typeof performance !== 'undefined' ? performance.now() : Date.now()) - startWallMs) / 1000;

        // MIRROR gate rising edge flips the matching mirror boolean.
        if (b3ntb0xMirrorGateTick(mirrorGate.x, params.mirrorXGate)) {
          params.mirrorX = params.mirrorX >= 0.5 ? 0 : 1;
        }
        if (b3ntb0xMirrorGateTick(mirrorGate.y, params.mirrorYGate)) {
          params.mirrorY = params.mirrorY >= 0.5 ? 0 : 1;
        }

        // ---- PASS 1: EncodeComposite -> fboEncode (oversampled float) ----
        g.bindFramebuffer(g.FRAMEBUFFER, fboEncode.fbo);
        g.viewport(0, 0, osWidth, ctx.res.height);
        g.useProgram(encodeProgram);
        g.activeTexture(g.TEXTURE0);
        g.bindTexture(g.TEXTURE_2D, inputTex ?? emptyTex);
        g.uniform1i(eU.uIn, 0);
        g.uniform1f(eU.uHasInput, inputTex ? 1.0 : 0.0);
        g.uniform1f(eU.uTime, tSec);
        g.uniform1f(eU.uBurstStarve, clamp01(params.burst_starve));
        g.uniform1f(eU.uHue, clampSym(params.hue));
        g.uniform1f(eU.uSubDrift, clamp01(params.sub_drift));
        ctx.drawFullscreenQuad();

        // ---- PASS 2: BendCircuit -> fboBend (ping-pong float) ----
        const bendWrite = bendFrontIsA ? fboBendB : fboBendA;
        const bendPrev = framesElapsed > 0 ? (bendFrontIsA ? fboBendA.texture : fboBendB.texture) : null;
        g.bindFramebuffer(g.FRAMEBUFFER, bendWrite.fbo);
        g.viewport(0, 0, osWidth, ctx.res.height);
        g.useProgram(bendProgram);
        g.activeTexture(g.TEXTURE0);
        g.bindTexture(g.TEXTURE_2D, fboEncode.texture);
        g.uniform1i(bU.uEncode, 0);
        g.activeTexture(g.TEXTURE1);
        g.bindTexture(g.TEXTURE_2D, bendPrev ?? emptyTex);
        g.uniform1i(bU.uPrevBend, 1);
        g.uniform1f(bU.uHasPrev, bendPrev ? 1.0 : 0.0);
        g.uniform1f(bU.uEnhance, clamp01(params.enhance));
        g.uniform1f(bU.uBias, clampSym(params.bias));
        g.uniform1f(bU.uAcDc, clamp01(params.ac_dc));
        g.uniform1f(bU.uSyncCrush, Math.max(0, Math.min(2, params.sync_crush)));
        g.uniform1f(bU.uBendA, clampSym(params.bend_a));
        g.uniform1f(bU.uBendB, clampSym(params.bend_b));
        g.uniform1f(bU.uBendC, clampSym(params.bend_c));
        g.uniform1f(bU.uBendD, clampSym(params.bend_d));
        ctx.drawFullscreenQuad();
        const bentTex = bendWrite.texture;

        // ---- PASS 3: DecodeComposite -> fboDecode (engine res RGBA8) ----
        g.bindFramebuffer(g.FRAMEBUFFER, fboDecode.fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.useProgram(decodeProgram);
        g.activeTexture(g.TEXTURE0);
        g.bindTexture(g.TEXTURE_2D, bentTex);
        g.uniform1i(dU.uBend, 0);
        g.activeTexture(g.TEXTURE1);
        g.bindTexture(g.TEXTURE_2D, fboEncode.texture);
        g.uniform1i(dU.uEncode, 1);
        g.uniform1f(dU.uChromaLeak, clamp01(params.chroma_leak));
        g.uniform1f(dU.uLumaPeak, clamp01(params.luma_peak));
        g.uniform1f(dU.uTbc, clamp01(params.tbc));
        g.uniform1f(dU.uBurstStarve, clamp01(params.burst_starve));
        ctx.drawFullscreenQuad();

        // ---- PASS 4: CRTDisplay -> CRT ping-pong (engine res RGBA8) ----
        const crtWrite = crtFrontIsA ? fboCrtB : fboCrtA;
        const crtPrev = framesElapsed > 0 ? (crtFrontIsA ? fboCrtA.texture : fboCrtB.texture) : null;
        g.bindFramebuffer(g.FRAMEBUFFER, crtWrite.fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.useProgram(crtProgram);
        g.activeTexture(g.TEXTURE0);
        g.bindTexture(g.TEXTURE_2D, fboDecode.texture);
        g.uniform1i(cU.uDecode, 0);
        g.activeTexture(g.TEXTURE1);
        g.bindTexture(g.TEXTURE_2D, crtPrev ?? emptyTex);
        g.uniform1i(cU.uPrev, 1);
        g.uniform1f(cU.uHasPrev, crtPrev ? 1.0 : 0.0);
        g.uniform1f(cU.uFieldParity, framesElapsed & 1 ? 1.0 : 0.0);
        g.uniform1f(cU.uTubeBloom, clamp01(params.tube_bloom));
        g.uniform1f(cU.uFeedback, clamp01(params.feedback));
        g.uniform1f(cU.uOverscan, clamp01(params.overscan));
        g.uniform1f(cU.uBarrel, clamp01(params.barrel));
        g.uniform1f(cU.uMirrorX, params.mirrorX >= 0.5 ? 1.0 : 0.0);
        g.uniform1f(cU.uMirrorY, params.mirrorY >= 0.5 ? 1.0 : 0.0);
        ctx.drawFullscreenQuad();

        g.bindFramebuffer(g.FRAMEBUFFER, null);

        // Repoint surface to the just-written CRT buffer + swap states.
        bendFrontIsA = !bendFrontIsA;
        crtFrontIsA = !crtFrontIsA;
        framesElapsed++;
      },
      dispose() {
        for (const f of [fboEncode, fboBendA, fboBendB, fboDecode, fboCrtA, fboCrtB]) {
          gl.deleteFramebuffer(f.fbo);
          gl.deleteTexture(f.texture);
        }
        gl.deleteTexture(emptyTex);
        gl.deleteProgram(encodeProgram);
        gl.deleteProgram(bendProgram);
        gl.deleteProgram(decodeProgram);
        gl.deleteProgram(crtProgram);
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
        if (key === 'hasInput') return framesElapsed > 0;
        if (key === 'framesElapsed') return framesElapsed;
        // Surfaced so the card can show a "reduced precision" badge when the
        // GPU couldn't allocate float targets (EXT_color_buffer_float absent).
        if (key === 'isFloat') return isFloat;
        if (key === 'fboTexture') return crtFrontIsA ? fboCrtA.texture : fboCrtB.texture;
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};

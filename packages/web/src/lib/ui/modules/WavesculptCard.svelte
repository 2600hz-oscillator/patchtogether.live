<script lang="ts">
  // WavesculptCard — hybrid 4-oscillator 3D video synth (v2 = wavetable engine).
  //
  // Card layout:
  //   * Top: per-osc strip × 4. Each strip has WAV selector + LOAD button +
  //     5 knobs (tune, fine, morph, spread, fold) + ADSR (A/D/S/R) + thickness.
  //     The per-osc waveform preview was REMOVED in v2 — the ribbon in the
  //     3D scene IS the waveform feedback now (ribbon vertices displace
  //     according to the live wavetable frame sampled into a small texture).
  //   * Middle: rendered video screen + TWO joysticks (camera XY pos +
  //     zoom/rot) + height (Z) + UNISON + Detune + alpha-brightness.
  //     The standalone zoom + rot knobs are GONE — the second joystick
  //     drives both axes (X = zoom, Y = rot). Both stay CV-patchable on
  //     their existing ports.
  //   * Bottom: BENTSCREEN WIGGLES — 12 BENTBOX knobs (unchanged from v1).
  //
  // Rendering: a private OffscreenCanvas + WebGL2 context. Two-pass:
  //   1a. Ribbon Z-prepass + color pass into sceneFbo (4 ribbons).
  //   1b. Alpha-mask pass into alphaMaskFbo (ALPHA osc only, in red).
  //   2.  BENTBOX post-pass into postPingFbo (also writes the alpha_in
  //       composite where uAlphaMask > 0).
  //   3.  Snapshot postPing → prevTex (next-frame feedback source).
  //   4.  Final blit to default fb.
  //
  // New in v2 — uWaveTex: a 256×4 RGBA8 texture, one row per oscillator,
  // holds the current wavetable frame (snapshot at the per-osc morph
  // position) packed as 0..255 in R = (sample + 1) * 127.5. The ribbon
  // vertex shader samples this texture at (aIdx/(RIBBON_SEGMENTS-1), osc/4)
  // and uses the decoded sample as the wave amplitude. Replaces the v1
  // synth formula (mix of saw/sine/triangle morph).

  import { onMount, onDestroy } from 'svelte';
  import { useStore, type NodeProps } from '@xyflow/svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { patch } from '$lib/graph/store';
  import { startCornerResize } from './card-resize';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import type { ModuleNode } from '$lib/graph/types';
  import {
    wavesculptDef,
    eyeFromCamera,
    distanceGain,
    WALL_LAYOUT,
    installWavesculptFrameDrawer,
    uninstallWavesculptFrameDrawer,
    getWavesculptFrames,
    voctToHz,
    detuneOctaveOffset,
    type WavesculptData,
    type WavesculptOscData,
  } from '$lib/audio/modules/wavesculpt';
  import { clampJoy } from '$lib/audio/modules/joystick';
  import {
    getFactoryTables,
    DEFAULT_FACTORY_TABLE_ID,
    framesToPlain,
  } from '$lib/audio/wavetable-factory-tables';
  import { parseE352Wav } from '$lib/audio/wavetable-parser';
  import type { VideoEngine } from '$lib/video/engine';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();
  const flowStore = useStore();

  // ----- Resize plumbing (mirror BentboxCard) -----
  const DEFAULT_WIDTH = 1280;
  const DEFAULT_HEIGHT = 880;
  const MIN_WIDTH = 1024;
  const MIN_HEIGHT = 720;
  const ENGINE_W = 640;
  const ENGINE_H = 360;

  let cardWidth = $derived<number>(
    (node?.data?.width as number | undefined) ?? DEFAULT_WIDTH,
  );
  let cardHeight = $derived<number>(
    (node?.data?.height as number | undefined) ?? DEFAULT_HEIGHT,
  );

  // ---- Reactive params ----
  const defaultFor = (key: string): number =>
    wavesculptDef.params.find((p) => p.id === key)!.defaultValue;

  function pget(key: string): number {
    return (node?.params?.[key] ?? defaultFor(key)) as number;
  }

  const set = (k: string) => (v: number) => {
    const t = patch.nodes[id]; if (t) t.params[k] = v;
  };
  const live = (k: string) => () => {
    const e = engineCtx.get(); if (!e || !node) return undefined;
    return e.readParam(node, k);
  };

  // Bentscreen knobs (bound to <Knob> components below).
  let hsync_drift        = $derived(pget('hsync_drift'));
  let hsync_loss         = $derived(pget('hsync_loss'));
  let vsync_drift        = $derived(pget('vsync_drift'));
  let scan_wobble        = $derived(pget('scan_wobble'));
  let chroma_phase       = $derived(pget('chroma_phase'));
  let chroma_instability = $derived(pget('chroma_instability'));
  let feedback_gain      = $derived(pget('feedback_gain'));
  let feedback_delay     = $derived(pget('feedback_delay'));
  let wavefold           = $derived(pget('wavefold'));
  let bloom              = $derived(pget('bloom'));
  let noise              = $derived(pget('noise'));
  let master_gain        = $derived(pget('master_gain'));

  // Drag state for the two joystick pads. Declared here (hoisted ahead
  // of the camera-derived block below) so the derived expressions can
  // reference them. The pad's onpointerdown/up flips these — while
  // true, the camera-derived `pos_x` etc. ignore the live-CV poll so
  // the dot tracks the user's gesture instead of fighting it.
  let draggingPos = $state(false);
  let draggingZR  = $state(false);

  // Camera params — knob values plus a live-CV poll so a patched LFO
  // moves the joystick dot in real time (motorized-fader style). The
  // poll calls engine.readParam(), which returns intrinsic-knob +
  // most-recent-CV-sample (see engine.ts:readParam). During an active
  // drag the polled value is suppressed so the user's gesture owns
  // the dot — the engine still updates the underlying AudioParam.
  let livePosX = $state<number | null>(null);
  let livePosY = $state<number | null>(null);
  let livePosZ = $state<number | null>(null);
  let liveZoom = $state<number | null>(null);
  let liveRot  = $state<number | null>(null);
  let pos_x = $derived(clampJoy(!draggingPos && livePosX !== null ? livePosX : pget('pos_x')));
  let pos_y = $derived(clampJoy(!draggingPos && livePosY !== null ? livePosY : pget('pos_y')));
  let pos_z = $derived(clampJoy(livePosZ !== null ? livePosZ : pget('pos_z')));
  let zoom  = $derived(!draggingZR && liveZoom !== null ? liveZoom : pget('zoom'));
  let rot   = $derived(clampJoy(!draggingZR && liveRot !== null ? liveRot : pget('rot')));
  let unison = $derived(pget('unison'));
  let detune = $derived(pget('detune'));
  // Chord mode: button toggles, knob picks the chord quality (major / minor).
  // While chord_mode is on every voice plays the same root pitch (voice 1)
  // plus a per-voice chord-interval offset (factory tick() writes those to
  // the worklet tune AudioParams). chord_quality is a discrete-curve knob;
  // we surface it as a clickable major/minor segment toggle in the UI so
  // the user doesn't have to dial a knob between two values.
  let chord_mode    = $derived(pget('chord_mode'));
  let chord_quality = $derived(pget('chord_quality'));
  let alpha_brightness = $derived(pget('alpha_brightness'));

  // Per-osc params (bound in the strip <Knob>s).
  let tune1 = $derived(pget('tune1'));
  let tune2 = $derived(pget('tune2'));
  let tune3 = $derived(pget('tune3'));
  let tune4 = $derived(pget('tune4'));
  let fine1 = $derived(pget('fine1'));
  let fine2 = $derived(pget('fine2'));
  let fine3 = $derived(pget('fine3'));
  let fine4 = $derived(pget('fine4'));
  let morph1 = $derived(pget('morph1'));
  let morph2 = $derived(pget('morph2'));
  let morph3 = $derived(pget('morph3'));
  let morph4 = $derived(pget('morph4'));
  let spread1 = $derived(pget('spread1'));
  let spread2 = $derived(pget('spread2'));
  let spread3 = $derived(pget('spread3'));
  let spread4 = $derived(pget('spread4'));
  let fold1 = $derived(pget('fold1'));
  let fold2 = $derived(pget('fold2'));
  let fold3 = $derived(pget('fold3'));
  let fold4 = $derived(pget('fold4'));
  let A1 = $derived(pget('A1'));
  let D1 = $derived(pget('D1'));
  let S1 = $derived(pget('S1'));
  let R1 = $derived(pget('R1'));
  let A2 = $derived(pget('A2'));
  let D2 = $derived(pget('D2'));
  let S2 = $derived(pget('S2'));
  let R2 = $derived(pget('R2'));
  let A3 = $derived(pget('A3'));
  let D3 = $derived(pget('D3'));
  let S3 = $derived(pget('S3'));
  let R3 = $derived(pget('R3'));
  let A4 = $derived(pget('A4'));
  let D4 = $derived(pget('D4'));
  let S4 = $derived(pget('S4'));
  let R4 = $derived(pget('R4'));
  let thickness1 = $derived(pget('thickness1'));
  let thickness2 = $derived(pget('thickness2'));
  let thickness3 = $derived(pget('thickness3'));
  let thickness4 = $derived(pget('thickness4'));

  // ---- per-osc FX slot helpers ----
  // fxType: 0=OFF, 1=REVERB, 2=DELAY. Click-cycles OFF→REVERB→DELAY→OFF.
  function fxTypeFor(i: number): number {
    return Math.round(pget(`fxType${i + 1}`));
  }
  function fxAmountFor(i: number): number {
    return pget(`fxAmount${i + 1}`);
  }
  function cycleFxType(i: number): void {
    const next = (fxTypeFor(i) + 1) % 3;
    set(`fxType${i + 1}`)(next);
  }
  function fxLabel(t: number): string {
    return t === 0 ? 'OFF' : t === 1 ? 'REVERB' : 'DELAY';
  }

  // Per-osc wavetable source (rides node.data).
  function oscData(i: number): WavesculptOscData {
    const d = (node?.data ?? {}) as WavesculptData;
    return (d[`osc${i + 1}` as keyof WavesculptData] as WavesculptOscData | undefined) ?? {};
  }
  function oscSource(i: number): string {
    return oscData(i).wavetableSource ?? `factory:${DEFAULT_FACTORY_TABLE_ID}`;
  }
  function oscLabel(i: number): string {
    const od = oscData(i);
    if (od.wavetableSource === 'user' && od.wavetableLabel) return od.wavetableLabel;
    const id = (od.wavetableSource ?? `factory:${DEFAULT_FACTORY_TABLE_ID}`).slice('factory:'.length);
    return getFactoryTables().find((t) => t.id === id)?.label ?? getFactoryTables()[0]!.label;
  }
  function selectFactory(oscIdx: number, factoryId: string): void {
    const t = patch.nodes[id]; if (!t) return;
    if (!t.data) t.data = {};
    const d = t.data as WavesculptData;
    const key = `osc${oscIdx + 1}` as keyof WavesculptData;
    if (!d[key]) (d as Record<string, unknown>)[key as string] = {};
    const od = d[key] as WavesculptOscData;
    od.wavetableSource = `factory:${factoryId}`;
    delete od.wavetableFrames;
    delete od.wavetableLabel;
  }
  let uploadStatus = $state<Record<number, string | null>>({});
  let uploadError = $state<Record<number, string | null>>({});
  async function onWavFileChange(oscIdx: number, ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    uploadError[oscIdx] = null;
    uploadStatus[oscIdx] = 'parsing...';
    try {
      const buf = await file.arrayBuffer();
      const parsed = parseE352Wav(buf);
      const target = patch.nodes[id];
      if (!target) return;
      if (!target.data) target.data = {};
      const d = target.data as WavesculptData;
      const key = `osc${oscIdx + 1}` as keyof WavesculptData;
      if (!d[key]) (d as Record<string, unknown>)[key as string] = {};
      const od = d[key] as WavesculptOscData;
      od.wavetableSource = 'user';
      od.wavetableFrames = framesToPlain(parsed.frames);
      od.wavetableLabel = file.name.replace(/\.wav$/i, '').toUpperCase().slice(0, 24);
      uploadStatus[oscIdx] = `loaded ${parsed.frames.length} frames`;
    } catch (err) {
      uploadError[oscIdx] = err instanceof Error ? err.message : String(err);
      uploadStatus[oscIdx] = null;
    } finally {
      try { input.value = ''; } catch { /* */ }
    }
  }

  // ---- XY pads (TWO joysticks: camera position + zoom/rot) ----
  const PAD_PX = 110;

  // Pad 1 — camera position (X = pos_x, Y = pos_y).
  let padPosEl: HTMLDivElement | null = $state(null);
  // `draggingPos` is declared at the top of the script so the camera-
  // derived block above can reference it.
  let dotPosX = $derived(((pos_x + 1) / 2) * PAD_PX);
  let dotPosY = $derived(((-pos_y + 1) / 2) * PAD_PX);
  function writePos(x: number, y: number): void {
    const t = patch.nodes[id]; if (!t) return;
    t.params.pos_x = clampJoy(x);
    t.params.pos_y = clampJoy(y);
  }
  function posDown(ev: PointerEvent): void {
    if (!padPosEl) return;
    draggingPos = true;
    padPosEl.setPointerCapture(ev.pointerId);
    updateFromPosPointer(ev);
    ev.preventDefault();
    ev.stopPropagation();
  }
  function updateFromPosPointer(ev: PointerEvent): void {
    if (!padPosEl) return;
    const rect = padPosEl.getBoundingClientRect();
    const px = (ev.clientX - rect.left) / rect.width;
    const py = (ev.clientY - rect.top) / rect.height;
    writePos(px * 2 - 1, -(py * 2 - 1));
  }
  function posMove(ev: PointerEvent): void {
    if (!draggingPos) return;
    updateFromPosPointer(ev);
  }
  function posUp(ev: PointerEvent): void {
    if (!draggingPos) return;
    draggingPos = false;
    try { padPosEl?.releasePointerCapture(ev.pointerId); } catch { /* */ }
    // No snap-back: camera stays where you put it (matches v1 behavior +
    // gestural-performance intent).
  }

  // Pad 2 — zoom/rot (X = zoom mapped to [0.3..3], Y = rot mapped to [-1..+1]).
  // X-axis = zoom (right = closer/louder); Y-axis = rot (up = +rot).
  let padZRel: HTMLDivElement | null = $state(null);
  // `draggingZR` is declared at the top of the script (camera derived
  // references it).
  // Map zoom param ([0.3..3]) → pad X coord ([0..PAD_PX]). Log-scale because
  // the underlying knob curve is 'log'; matches the user's perception of
  // "halfway-right = unity zoom" — at zoom=1 the dot sits at PAD_PX/2.
  function zoomToPadX(z: number): number {
    const clamped = Math.max(0.3, Math.min(3, z));
    const logMin = Math.log(0.3); const logMax = Math.log(3);
    return ((Math.log(clamped) - logMin) / (logMax - logMin)) * PAD_PX;
  }
  function padXToZoom(px: number): number {
    const t = Math.max(0, Math.min(1, px / PAD_PX));
    const logMin = Math.log(0.3); const logMax = Math.log(3);
    return Math.exp(logMin + t * (logMax - logMin));
  }
  let dotZRX = $derived(zoomToPadX(zoom));
  let dotZRY = $derived(((-rot + 1) / 2) * PAD_PX);
  function writeZR(zoomVal: number, rotVal: number): void {
    const t = patch.nodes[id]; if (!t) return;
    t.params.zoom = Math.max(0.3, Math.min(3, zoomVal));
    t.params.rot = clampJoy(rotVal);
  }
  /** Map pad-X fraction [0..1] → zoom in [0.3..3] via log curve. Same
   *  curve as the underlying `zoom` param (curve: 'log'). */
  function fracToZoom(frac: number): number {
    const t = Math.max(0, Math.min(1, frac));
    const logMin = Math.log(0.3); const logMax = Math.log(3);
    return Math.exp(logMin + t * (logMax - logMin));
  }
  function updateFromZRPointer(ev: PointerEvent): void {
    if (!padZRel) return;
    const rect = padZRel.getBoundingClientRect();
    // Use the pad's actual rect so the mapping survives any CSS scaling
    // (Playwright sometimes computes box dimensions differently than the
    // nominal CSS px we authored).
    const fracX = (ev.clientX - rect.left) / rect.width;
    const py = (ev.clientY - rect.top) / rect.height;
    writeZR(fracToZoom(fracX), -(py * 2 - 1));
  }
  function zrDown(ev: PointerEvent): void {
    if (!padZRel) return;
    draggingZR = true;
    padZRel.setPointerCapture(ev.pointerId);
    updateFromZRPointer(ev);
    ev.preventDefault();
    ev.stopPropagation();
  }
  function zrMove(ev: PointerEvent): void {
    if (!draggingZR) return;
    updateFromZRPointer(ev);
  }
  function zrUp(ev: PointerEvent): void {
    if (!draggingZR) return;
    draggingZR = false;
    try { padZRel?.releasePointerCapture(ev.pointerId); } catch { /* */ }
    // Same no-snap policy as the camera-pos pad.
  }

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

void main() {
  vec4 base = uOscColor[vOsc];
  float bolt = uBolt[vOsc];
  float band = smoothstep(0.0, 0.15, vT) * smoothstep(1.0, 0.85, vT);
  vec3 col = base.rgb * (0.4 + 0.5 * band);
  float alpha = base.a * (0.35 + 0.35 * band);

  if (bolt > 0.001) {
    float d = vT - uBoltPhase[vOsc];
    float pulse = exp(-d * d / 0.012);
    vec3 boltCol = vec3(0.35, 0.55, 1.0) * pulse * bolt * 0.9;
    col += boltCol;
    alpha = min(1.0, alpha + pulse * bolt * 0.6);
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

uniform float uHsyncDrift;
uniform float uHsyncLoss;
uniform float uVsyncDrift;
uniform float uScanWobble;
uniform float uChromaPhase;
uniform float uChromaInstability;
uniform float uFeedbackGain;
uniform float uFeedbackDelay;
uniform float uWavefold;
uniform float uBloom;
uniform float uNoise;
uniform float uMasterGain;

const float LINES = 240.0;
const float TWO_PI = 6.2831853;

float hash11(float n) { return fract(sin(n * 78.233) * 43758.5453); }
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
float wavefold(float v, float amt) {
  if (amt <= 0.0) return v;
  float s = v * (1.0 + amt * 3.0);
  float t = mod(s + 1.0, 4.0) - 1.0;
  if (t > 1.0) return 2.0 - t;
  if (t < -1.0) return -2.0 - t;
  return t;
}
float softClip(float v) {
  float v2 = v * v;
  return v * (27.0 + v2) / (27.0 + 9.0 * v2);
}

void main() {
  float lineIdx = floor(vUv.y * LINES);
  float lineY = (lineIdx + 0.5) / LINES;
  float driftRand = (hash11(lineIdx + floor(uTime * 12.0)) - 0.5) * 2.0;
  float hWobble = sin(lineIdx * 0.21 + uTime * 1.7) * uScanWobble * 0.06;
  float hOffset = driftRand * uHsyncDrift * 0.12 + hWobble;
  float lossRoll = hash11(lineIdx * 1.913 + floor(uTime * 3.7));
  if (lossRoll < uHsyncLoss * 0.18) {
    hOffset += (hash11(lineIdx * 7.91 + uTime) - 0.5) * 0.6;
  }
  float vOff = sin(uTime * 0.7) * uVsyncDrift * 0.4 + (uTime * uVsyncDrift * 0.05);
  vec2 sampleUv = vec2(fract(vUv.x + hOffset), fract(lineY + vOff));
  vec3 src = texture(uIn, sampleUv).rgb;
  vec3 yiq = rgb2yiq(src);
  float phaseNoise = (hash11(lineIdx * 2.31 + uTime * 0.9) - 0.5) * uChromaInstability;
  float ang = (uChromaPhase + phaseNoise) * TWO_PI;
  float ca = cos(ang); float sa = sin(ang);
  vec2 iq = vec2(yiq.y * ca - yiq.z * sa, yiq.y * sa + yiq.z * ca);
  yiq.y = iq.x; yiq.z = iq.y;
  float comp = yiq.x + (iq.x + iq.y) * 0.5;
  comp = wavefold(comp, uWavefold);
  comp = softClip(comp * uMasterGain);
  yiq.x = mix(yiq.x, comp - (iq.x + iq.y) * 0.5, uWavefold * 0.7 + uMasterGain * 0.1);
  vec3 decoded = yiq2rgb(yiq);
  vec2 prevUv = vec2(sampleUv.x, fract(sampleUv.y + uFeedbackDelay * 0.04 - 0.02));
  vec3 prev = texture(uPrev, prevUv).rgb;
  decoded = mix(decoded, max(decoded, prev), uFeedbackGain);
  if (uBloom > 0.0) {
    float luma = dot(decoded, vec3(0.299, 0.587, 0.114));
    float bloomBoost = smoothstep(0.6, 1.0, luma) * uBloom * 0.5;
    decoded += bloomBoost;
  }
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
  if (uNoise > 0.0) {
    float n = hash21(vUv * vec2(740.0, 421.0) + uTime) - 0.5;
    decoded += vec3(n) * uNoise * 0.18;
  }

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

  let viewMat = new Float32Array(16);
  let projMat = new Float32Array(16);
  let mvpMat = new Float32Array(16);

  const OSC_COLORS: Array<[number, number, number, number]> = [
    [1.0, 0.20, 0.20, 1.0],
    [0.20, 1.0, 0.30, 1.0],
    [0.30, 0.50, 1.0, 1.0],
    [0.85, 0.85, 0.85, 0.7],
  ];

  let renderStartMs = 0;
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

  function findAlphaInSource(): { nodeId: string; portId: string } | null {
    for (const eid of Object.keys(patch.edges)) {
      const e = patch.edges[eid];
      if (!e) continue;
      if (e.target?.nodeId === id && e.target?.portId === 'alpha_in') {
        return { nodeId: e.source.nodeId, portId: e.source.portId };
      }
    }
    return null;
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
      if (ribbonSamplesBuf) gl.deleteBuffer(ribbonSamplesBuf);
    } catch { /* */ }
    gl = null;
    renderCanvas = null;
  }

  function renderToOffscreen() {
    if (!gl || !ribbonProgram || !bentboxProgram) return;
    const g = gl;

    tryUploadAlphaIn();
    uploadWaveTex();

    g.bindFramebuffer(g.FRAMEBUFFER, sceneFbo);
    g.viewport(0, 0, RES_W, RES_H);
    g.clearColor(0, 0, 0, 1);
    g.clearDepth(1.0);
    g.clear(g.COLOR_BUFFER_BIT | g.DEPTH_BUFFER_BIT);

    g.useProgram(ribbonProgram);

    // Camera setup — use the shared eyeFromCamera helper so zoom/rot
    // semantics stay paired with the audio side's distGain math.
    //
    // ONE READ. engine.read(node, 'camera') returns the SAME instant
    // the spatial audio mix is computing right now (both read the
    // same shadow-gain analyser samples in the factory). Joystick UI
    // does the same thing — see pollCamLive. That gives us a single
    // source of truth: knob, CV, audio mix, ribbon viewport, and
    // joystick dot all move together.
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

    const now = performance.now();
    const dt = Math.max(0, Math.min(0.5, (now - lastFrameMs) / 1000));
    lastFrameMs = now;
    const unison = (node?.params?.unison as number | undefined) ?? 0;
    const detune = (node?.params?.detune as number | undefined) ?? 0;
    for (let i = 0; i < 4; i++) {
      boltPhase[i] = (boltPhase[i]! + BOLT_SPEED * dt) % 1.0;
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
      wavePhase[i] = (wavePhase[i]! + cyclesPerSec * dt) % 1.0;
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
      const vec = [[-1, 0, 0], [ 1, 0, 0], [0,-1, 0], [0,  1, 0]][i]!;
      srcArr[i * 4 + 0] = wall[0]!;
      srcArr[i * 4 + 1] = wall[1]!;
      srcArr[i * 4 + 2] = wall[2]!;
      srcArr[i * 4 + 3] = 0;
      vecArr[i * 4 + 0] = vec[0]!;
      vecArr[i * 4 + 1] = vec[1]!;
      vecArr[i * 4 + 2] = vec[2]!;
      vecArr[i * 4 + 3] = 0;
      const col = OSC_COLORS[i]!;
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

    g.disable(g.BLEND);
    g.colorMask(false, false, false, false);
    g.enable(g.DEPTH_TEST);
    g.depthFunc(g.LESS);
    g.depthMask(true);
    g.bindVertexArray(ribbonVao);
    g.drawArrays(g.TRIANGLE_STRIP, 0, ribbonVerts);
    g.bindVertexArray(null);

    g.colorMask(true, true, true, true);
    g.depthFunc(g.LEQUAL);
    g.depthMask(false);
    g.enable(g.BLEND);
    g.blendFunc(g.SRC_ALPHA, g.ONE);
    g.bindVertexArray(ribbonVao);
    g.drawArrays(g.TRIANGLE_STRIP, 0, ribbonVerts);
    g.bindVertexArray(null);

    // 1c) ALPHA-mask pass (osc 3 only → red mask).
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
    g.disable(g.BLEND);
    g.colorMask(false, false, false, false);
    g.enable(g.DEPTH_TEST);
    g.depthFunc(g.LESS);
    g.depthMask(true);
    g.bindVertexArray(ribbonVao);
    g.drawArrays(g.TRIANGLE_STRIP, 0, ribbonVerts);
    g.bindVertexArray(null);
    g.colorMask(true, true, true, true);
    g.depthFunc(g.LEQUAL);
    g.depthMask(false);
    g.enable(g.BLEND);
    g.blendFunc(g.SRC_ALPHA, g.ONE);
    g.bindVertexArray(ribbonVao);
    g.drawArrays(g.TRIANGLE_STRIP, 0, ribbonVerts);
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
    const tSec = (performance.now() - renderStartMs) / 1000;
    g.uniform1f(g.getUniformLocation(bentboxProgram, 'uTime'), tSec);
    g.uniform1f(g.getUniformLocation(bentboxProgram, 'uFieldParity'), (frameCount & 1) ? 1 : 0);
    const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
    const clampSym = (v: number) => Math.max(-1, Math.min(1, v));
    g.uniform1f(g.getUniformLocation(bentboxProgram, 'uHsyncDrift'),        clamp01(node?.params?.hsync_drift as number ?? 0));
    g.uniform1f(g.getUniformLocation(bentboxProgram, 'uHsyncLoss'),         clamp01(node?.params?.hsync_loss as number ?? 0));
    g.uniform1f(g.getUniformLocation(bentboxProgram, 'uVsyncDrift'),        clamp01(node?.params?.vsync_drift as number ?? 0));
    g.uniform1f(g.getUniformLocation(bentboxProgram, 'uScanWobble'),        clamp01(node?.params?.scan_wobble as number ?? 0));
    g.uniform1f(g.getUniformLocation(bentboxProgram, 'uChromaPhase'),       clampSym(node?.params?.chroma_phase as number ?? 0));
    g.uniform1f(g.getUniformLocation(bentboxProgram, 'uChromaInstability'), clamp01(node?.params?.chroma_instability as number ?? 0));
    g.uniform1f(g.getUniformLocation(bentboxProgram, 'uFeedbackGain'),      clamp01(node?.params?.feedback_gain as number ?? 0));
    g.uniform1f(g.getUniformLocation(bentboxProgram, 'uFeedbackDelay'),     clamp01(node?.params?.feedback_delay as number ?? 0));
    g.uniform1f(g.getUniformLocation(bentboxProgram, 'uWavefold'),          clamp01(node?.params?.wavefold as number ?? 0));
    g.uniform1f(g.getUniformLocation(bentboxProgram, 'uBloom'),             clamp01(node?.params?.bloom as number ?? 0.4));
    g.uniform1f(g.getUniformLocation(bentboxProgram, 'uNoise'),             clamp01(node?.params?.noise as number ?? 0.05));
    g.uniform1f(g.getUniformLocation(bentboxProgram, 'uMasterGain'),        Math.max(0, Math.min(2, node?.params?.master_gain as number ?? 1)));
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

  function installBridgeFrameDrawer(): void {
    installWavesculptFrameDrawer(id, (targetCanvas) => {
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
    });
  }

  let displayCanvas: HTMLCanvasElement | null = $state(null);
  let rafId: number | null = null;

  // Video mode: 0 = PROXIMITY (3D ribbons inside the unit cube),
  // 1 = BIRDSEYE (top-down 2D floorplan of the unit cube showing
  // the 4 emitters + camera + audio-energy ripples). Picked via the
  // discrete video_mode param; the on-card View toggle button writes
  // it.
  let video_mode = $derived(pget('video_mode'));

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

  function tick() {
    rafId = null;
    const mode = Math.round(video_mode);
    if (mode === 1) {
      // BIRDSEYE — pure-2D draw, bypass the WebGL ribbon renderer
      // (cheaper + a totally different visual aesthetic).
      if (displayCanvas) {
        const dc2 = displayCanvas.getContext('2d', { alpha: false });
        if (dc2) {
          drawBirdseye(dc2, displayCanvas.width, displayCanvas.height, performance.now());
        }
      }
      rafId = requestAnimationFrame(tick);
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

  // Camera-CV live-poll loop. ONE cross-domain call per tick that
  // pulls the entire camera snapshot from engine.read(node, 'camera')
  // — the SAME shadow-analyser samples the spatial audio mix reads.
  // This is the single-source-of-truth read: joystick dot, ribbon
  // viewport (see WebGL tick above), and audio distGain all reflect
  // the same instant. Cheap (1 call × 33 fps).
  const CAM_POLL_MS = 30;
  let camPollId: ReturnType<typeof setInterval> | null = null;
  function pollCamLive() {
    const e = engineCtx.get();
    if (!e || !node) return;
    const cam = e.read(node, 'camera') as
      | { pos_x: number; pos_y: number; pos_z: number; zoom: number; rot: number }
      | undefined;
    if (!cam) return;
    if (cam.pos_x !== livePosX) livePosX = cam.pos_x;
    if (cam.pos_y !== livePosY) livePosY = cam.pos_y;
    if (cam.pos_z !== livePosZ) livePosZ = cam.pos_z;
    if (cam.zoom  !== liveZoom) liveZoom = cam.zoom;
    if (cam.rot   !== liveRot)  liveRot  = cam.rot;
  }

  onMount(() => {
    initGl();
    installBridgeFrameDrawer();
    rafId = requestAnimationFrame(tick);
    camPollId = setInterval(pollCamLive, CAM_POLL_MS);
  });
  onDestroy(() => {
    if (rafId !== null) cancelAnimationFrame(rafId);
    if (camPollId !== null) clearInterval(camPollId);
    uninstallWavesculptFrameDrawer(id);
    disposeGl();
    if (resizeAbort) resizeAbort.abort();
  });

  let resizing = $state(false);
  let resizeAbort: AbortController | null = null;
  function onResizeStart(ev: PointerEvent) {
    resizeAbort = startCornerResize(ev, {
      flowStore,
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      getStartSize: () => ({ width: cardWidth, height: cardHeight }),
      apply: (w, h) => {
        const target = patch.nodes[id];
        if (target) {
          if (!target.data) target.data = {};
          target.data.width = w;
          target.data.height = h;
        }
      },
      onStart: () => { resizing = true; },
      onEnd: () => { resizing = false; resizeAbort = null; },
    });
  }

  // Per-osc gate/pitch/morph then camera CV then alpha video. The
  // morph{N}_cv ports were shipped on the engine side in PR #225 but
  // weren't surfaced as patchable handles until this PR.
  const inputs: PortDescriptor[] = [
    { id: 'gate1',     label: 'G1', cable: 'gate' },
    { id: 'pitch_cv1', label: 'P1', cable: 'cv' },
    { id: 'morph1_cv', label: 'M1', cable: 'cv' },
    { id: 'gate2',     label: 'G2', cable: 'gate' },
    { id: 'pitch_cv2', label: 'P2', cable: 'cv' },
    { id: 'morph2_cv', label: 'M2', cable: 'cv' },
    { id: 'gate3',     label: 'G3', cable: 'gate' },
    { id: 'pitch_cv3', label: 'P3', cable: 'cv' },
    { id: 'morph3_cv', label: 'M3', cable: 'cv' },
    { id: 'gate4',     label: 'G4', cable: 'gate' },
    { id: 'pitch_cv4', label: 'P4', cable: 'cv' },
    { id: 'morph4_cv', label: 'M4', cable: 'cv' },
    { id: 'pos_x',     label: 'X',  cable: 'cv' },
    { id: 'pos_y',     label: 'Y',  cable: 'cv' },
    { id: 'pos_z',     label: 'H',  cable: 'cv' },
    { id: 'zoom',      label: 'Z',  cable: 'cv' },
    { id: 'rot',       label: 'R',  cable: 'cv' },
    { id: 'alpha_in',  label: 'A',  cable: 'video' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'L',         label: 'L',   cable: 'audio' },
    { id: 'R',         label: 'R',   cable: 'audio' },
    { id: 'video_out', label: 'OUT', cable: 'mono-video' },
  ];

  const OSC_COLOR_LABELS = ['RED', 'GRN', 'BLU', 'ALP'];
</script>

<div
  class="card wavesculpt"
  class:resizing
  style="width: {cardWidth}px; height: {cardHeight}px;"
  data-testid="wavesculpt-card"
  data-node-id={id}
>
  <div class="stripe"></div>
  <header class="title">WAVESCULPT</header>

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="body">
      <!-- Per-oscillator strip: WAV / LOAD / tune / fine / morph / spread / fold / ADSR / thickness -->
      <div class="osc-grid">
        {#each [0, 1, 2, 3] as i}
          <div class="osc-strip osc-{i}" data-testid={`wavesculpt-osc-${i + 1}`}>
            <div class="osc-label">{OSC_COLOR_LABELS[i]}</div>
            <div class="wt-row">
              <select
                class="wt-select"
                value={oscSource(i)}
                onchange={(e) => {
                  const v = (e.target as HTMLSelectElement).value;
                  if (v === 'user') return;
                  const factoryId = v.startsWith('factory:') ? v.slice('factory:'.length) : v;
                  selectFactory(i, factoryId);
                }}
                data-testid={`wavesculpt-osc-${i + 1}-wav-select`}
              >
                {#each getFactoryTables() as t (t.id)}
                  <option value={`factory:${t.id}`}>{t.label}</option>
                {/each}
                {#if oscSource(i) === 'user'}
                  <option value="user">USER · {oscLabel(i)}</option>
                {/if}
              </select>
              <label class="upload-btn" data-testid={`wavesculpt-osc-${i + 1}-load`}>
                <input
                  type="file"
                  accept=".wav,audio/wav"
                  onchange={(ev) => onWavFileChange(i, ev)}
                />
                <span>LOAD</span>
              </label>
            </div>
            {#if uploadStatus[i]}
              <div class="upload-status">{uploadStatus[i]}</div>
            {/if}
            {#if uploadError[i]}
              <div class="upload-error">{uploadError[i]}</div>
            {/if}
            <div class="osc-knobs">
              <Knob value={i === 0 ? tune1 : i === 1 ? tune2 : i === 2 ? tune3 : tune4}
                min={-36} max={36} defaultValue={0} label="Tune" units="st" curve="linear"
                onchange={set(`tune${i + 1}`)} readLive={live(`tune${i + 1}`)} />
              <Knob value={i === 0 ? fine1 : i === 1 ? fine2 : i === 2 ? fine3 : fine4}
                min={-100} max={100} defaultValue={0} label="Fine" units="¢" curve="linear"
                onchange={set(`fine${i + 1}`)} readLive={live(`fine${i + 1}`)} />
              <Knob value={i === 0 ? morph1 : i === 1 ? morph2 : i === 2 ? morph3 : morph4}
                min={0} max={1} defaultValue={0} label="Morph" curve="linear"
                onchange={set(`morph${i + 1}`)} readLive={live(`morph${i + 1}`)} />
              <Knob value={i === 0 ? spread1 : i === 1 ? spread2 : i === 2 ? spread3 : spread4}
                min={1} max={5} defaultValue={1} label="Sprd" curve="linear"
                onchange={set(`spread${i + 1}`)} readLive={live(`spread${i + 1}`)} />
              <Knob value={i === 0 ? fold1 : i === 1 ? fold2 : i === 2 ? fold3 : fold4}
                min={0} max={1} defaultValue={0} label="Fold" curve="linear"
                onchange={set(`fold${i + 1}`)} readLive={live(`fold${i + 1}`)} />
              <Knob value={i === 0 ? thickness1 : i === 1 ? thickness2 : i === 2 ? thickness3 : thickness4}
                min={0} max={1} defaultValue={0.3} label="Thick" curve="linear"
                onchange={set(`thickness${i + 1}`)} readLive={live(`thickness${i + 1}`)} />
            </div>
            <div class="osc-knobs">
              <Knob value={i === 0 ? A1 : i === 1 ? A2 : i === 2 ? A3 : A4}
                min={0.001} max={5} defaultValue={0.01} label="A" curve="log" units="s"
                onchange={set(`A${i + 1}`)} readLive={live(`A${i + 1}`)} />
              <Knob value={i === 0 ? D1 : i === 1 ? D2 : i === 2 ? D3 : D4}
                min={0.001} max={5} defaultValue={0.1} label="D" curve="log" units="s"
                onchange={set(`D${i + 1}`)} readLive={live(`D${i + 1}`)} />
              <Knob value={i === 0 ? S1 : i === 1 ? S2 : i === 2 ? S3 : S4}
                min={0} max={1} defaultValue={0.7} label="S" curve="linear"
                onchange={set(`S${i + 1}`)} readLive={live(`S${i + 1}`)} />
              <Knob value={i === 0 ? R1 : i === 1 ? R2 : i === 2 ? R3 : R4}
                min={0.001} max={5} defaultValue={0.5} label="R" curve="log" units="s"
                onchange={set(`R${i + 1}`)} readLive={live(`R${i + 1}`)} />
              <!-- Per-osc FX slot. Single click-cycle button + an amount
                   knob. Button cycles OFF → REVERB → DELAY → OFF.
                   Reverb wet is auto-modulated by distance to the
                   camera in the engine; the knob is the BASE amount. -->
              <button
                type="button"
                class="fx-btn fx-btn-{fxTypeFor(i)}"
                onclick={() => cycleFxType(i)}
                data-testid={`wavesculpt-fx-btn-${i + 1}`}
                title="FX slot — click to cycle OFF / REVERB / DELAY"
              >{fxLabel(fxTypeFor(i))}</button>
              <Knob value={fxAmountFor(i)} min={0} max={1} defaultValue={0.4}
                label="FX" curve="linear"
                onchange={set(`fxAmount${i + 1}`)} readLive={live(`fxAmount${i + 1}`)} />
            </div>
          </div>
        {/each}
      </div>

      <!-- Middle: rendered screen + TWO joysticks + height + UNISON + Detune + alpha-brightness -->
      <div class="mid-row">
        <div class="cam-controls">
          <div class="cam-section-label">CAMERA</div>
          <div
            class="pad nodrag"
            bind:this={padPosEl}
            style="width: {PAD_PX}px; height: {PAD_PX}px;"
            role="application"
            aria-label="Wavesculpt camera XY pad"
            data-testid="wavesculpt-pad"
            onpointerdown={posDown}
            onpointermove={posMove}
            onpointerup={posUp}
            onpointercancel={posUp}
          >
            <div class="cross-h"></div>
            <div class="cross-v"></div>
            <div class="dot" class:active={draggingPos} style="left: {dotPosX}px; top: {dotPosY}px;"></div>
          </div>
          <div class="pad-label">pos x/y</div>
          <Knob value={pos_z} min={-1} max={1} defaultValue={0} label="Height" curve="linear" onchange={set('pos_z')} readLive={live('pos_z')} />
          <div
            class="pad nodrag pad-zr"
            bind:this={padZRel}
            style="width: {PAD_PX}px; height: {PAD_PX}px;"
            role="application"
            aria-label="Wavesculpt zoom/rotation pad"
            data-testid="wavesculpt-pad-zoomrot"
            onpointerdown={zrDown}
            onpointermove={zrMove}
            onpointerup={zrUp}
            onpointercancel={zrUp}
          >
            <div class="cross-h"></div>
            <div class="cross-v"></div>
            <div class="dot" class:active={draggingZR} style="left: {dotZRX}px; top: {dotZRY}px;"></div>
          </div>
          <div class="pad-label">zoom / rot</div>
        </div>

        <div class="screen-wrap" data-testid="wavesculpt-screen-wrap">
          <canvas
            bind:this={displayCanvas}
            width={ENGINE_W}
            height={ENGINE_H}
            data-testid="wavesculpt-canvas"
            data-node-id={id}
          ></canvas>
        </div>

        <div class="right-controls">
          <!-- VIEW toggle: PROXIMITY (3D ribbons, original render) vs
               BIRDSEYE (top-down 2D floorplan showing the spatial
               system: 4 emitter dots + camera marker + audio-energy
               ripples). Click cycles. The 3D mode is the gorgeous
               default; BIRDSEYE is useful when you're tweaking the
               camera + want to SEE what the spatial system is doing. -->
          <button
            type="button"
            class="unison-toggle view-toggle"
            class:on={video_mode >= 0.5}
            data-testid="wavesculpt-view-toggle"
            title="View mode: PROXIMITY (3D ribbons) vs BIRDSEYE (top-down floorplan)"
            onclick={() => set('video_mode')(video_mode >= 0.5 ? 0 : 1)}
          >{video_mode >= 0.5 ? 'BIRDSEYE' : '3D'}</button>
          <button
            type="button"
            class="unison-toggle"
            class:on={unison >= 0.5}
            data-testid="wavesculpt-unison"
            onclick={() => set('unison')(unison >= 0.5 ? 0 : 1)}
          >UNISON</button>
          <Knob value={detune} min={-1} max={1} defaultValue={0} label="Detune" curve="linear" onchange={set('detune')} readLive={live('detune')} />
          <button
            type="button"
            class="unison-toggle chord-toggle"
            class:on={chord_mode >= 0.5}
            data-testid="wavesculpt-chord-mode"
            title="Chord mode: voice 1 plays the root, voices 2-4 add chord-tone offsets in semitones"
            onclick={() => set('chord_mode')(chord_mode >= 0.5 ? 0 : 1)}
          >CHORD</button>
          <div class="chord-quality" data-testid="wavesculpt-chord-quality" role="radiogroup" aria-label="Chord quality">
            <button
              type="button"
              class="chord-quality-opt"
              class:on={chord_quality < 0.5}
              data-testid="wavesculpt-chord-major"
              role="radio"
              aria-checked={chord_quality < 0.5}
              onclick={() => set('chord_quality')(0)}
            >MAJ</button>
            <button
              type="button"
              class="chord-quality-opt"
              class:on={chord_quality >= 0.5}
              data-testid="wavesculpt-chord-minor"
              role="radio"
              aria-checked={chord_quality >= 0.5}
              onclick={() => set('chord_quality')(1)}
            >MIN</button>
          </div>
          <Knob
            value={alpha_brightness} min={0} max={2} defaultValue={1}
            label="A Bright" curve="linear"
            onchange={set('alpha_brightness')} readLive={live('alpha_brightness')}
          />
        </div>
      </div>

      <!-- Bottom: bentscreen wiggles -->
      <div class="bent-section">
        <div class="bent-label">BENTSCREEN WIGGLES</div>
        <div class="bent-grid">
          <Knob value={hsync_drift}        min={0}  max={1} defaultValue={0}    label="HS Drift"  curve="linear" onchange={set('hsync_drift')}        readLive={live('hsync_drift')} />
          <Knob value={hsync_loss}         min={0}  max={1} defaultValue={0}    label="HS Loss"   curve="linear" onchange={set('hsync_loss')}         readLive={live('hsync_loss')} />
          <Knob value={vsync_drift}        min={0}  max={1} defaultValue={0}    label="VS Drift"  curve="linear" onchange={set('vsync_drift')}        readLive={live('vsync_drift')} />
          <Knob value={scan_wobble}        min={0}  max={1} defaultValue={0}    label="Wobble"    curve="linear" onchange={set('scan_wobble')}        readLive={live('scan_wobble')} />
          <Knob value={chroma_phase}       min={-1} max={1} defaultValue={0}    label="Hue"       curve="linear" onchange={set('chroma_phase')}       readLive={live('chroma_phase')} />
          <Knob value={chroma_instability} min={0}  max={1} defaultValue={0}    label="Shimmer"   curve="linear" onchange={set('chroma_instability')} readLive={live('chroma_instability')} />
          <Knob value={feedback_gain}      min={0}  max={1} defaultValue={0}    label="Feedback"  curve="linear" onchange={set('feedback_gain')}      readLive={live('feedback_gain')} />
          <Knob value={feedback_delay}     min={0}  max={1} defaultValue={0}    label="Delay"     curve="linear" onchange={set('feedback_delay')}     readLive={live('feedback_delay')} />
          <Knob value={wavefold}           min={0}  max={1} defaultValue={0}    label="Wavefold"  curve="linear" onchange={set('wavefold')}           readLive={live('wavefold')} />
          <Knob value={bloom}              min={0}  max={1} defaultValue={0.4}  label="Bloom"     curve="linear" onchange={set('bloom')}              readLive={live('bloom')} />
          <Knob value={noise}              min={0}  max={1} defaultValue={0.05} label="Noise"     curve="linear" onchange={set('noise')}              readLive={live('noise')} />
          <Knob value={master_gain}        min={0}  max={2} defaultValue={1}    label="Gain"      curve="linear" onchange={set('master_gain')}        readLive={live('master_gain')} />
        </div>
      </div>
    </div>
  </PatchPanel>

  <div
    class="resize-handle nodrag"
    role="separator"
    aria-label="Resize WAVESCULPT"
    data-testid="wavesculpt-resize-handle"
    onpointerdown={onResizeStart}
  ></div>
</div>

<style>
  .card.wavesculpt {
    background-color: #08090c;
    border: 1px solid var(--border);
    border-radius: 3px;
    color: var(--text);
    padding: 18px 12px 14px;
    position: relative;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    overflow: hidden;
    isolation: isolate;
  }
  :global(.svelte-flow__node:hover) .card.wavesculpt {
    border-color: var(--accent-dim);
  }
  :global(.svelte-flow__node.selected) .card.wavesculpt {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .card.wavesculpt.resizing { transition: none; }
  .stripe {
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    border-radius: 2px 2px 0 0;
    background: linear-gradient(90deg,
      #e23, #2c3, #36e, rgba(255,255,255,0.5));
  }
  .title {
    font-size: 0.85rem;
    font-weight: 500;
    text-align: center;
    margin: 0 0 8px;
    letter-spacing: 0.06em;
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .osc-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 6px;
  }
  .osc-strip {
    border: 1px solid var(--border-dim, rgba(255,255,255,0.08));
    border-radius: 2px;
    padding: 4px;
    background: rgba(255,255,255,0.02);
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .osc-strip.osc-0 { border-left: 2px solid rgba(255, 80, 80, 0.7); }
  .osc-strip.osc-1 { border-left: 2px solid rgba(80, 220, 100, 0.7); }
  .osc-strip.osc-2 { border-left: 2px solid rgba(100, 130, 255, 0.7); }
  .osc-strip.osc-3 { border-left: 2px solid rgba(210, 210, 210, 0.7); }
  /* Per-osc FX slot button — small chip styled to match the other
     button-toggles on the card. Color shifts with FX type so the user
     can scan all 4 slots at a glance. */
  .fx-btn {
    appearance: none;
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border-dim, rgba(255,255,255,0.15));
    color: var(--text-dim);
    font-size: 0.6rem;
    font-weight: 700;
    letter-spacing: 0.05em;
    padding: 4px 6px;
    border-radius: 2px;
    cursor: pointer;
    transition: background 80ms ease-out, color 80ms ease-out, border-color 80ms ease-out;
  }
  .fx-btn-1 {  /* REVERB */
    background: var(--cable-cv, #6cf);
    color: #000;
    border-color: var(--cable-cv, #6cf);
  }
  .fx-btn-2 {  /* DELAY */
    background: var(--cable-audio, #f80);
    color: #000;
    border-color: var(--cable-audio, #f80);
  }
  .osc-label {
    font-size: 0.62rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-align: center;
    color: var(--text-dim);
  }
  .wt-row {
    display: flex;
    gap: 4px;
    align-items: stretch;
  }
  .wt-select {
    flex: 1;
    background: #1a1f2a;
    color: var(--text, #d8dde6);
    border: 1px solid #2a2f3a;
    border-radius: 2px;
    padding: 1px 4px;
    font-size: 0.55rem;
    font-family: ui-monospace, monospace;
    min-width: 0;
  }
  .upload-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: #1a1f2a;
    color: var(--text-dim);
    border: 1px dashed #404652;
    border-radius: 2px;
    padding: 1px 6px;
    font-size: 0.55rem;
    cursor: pointer;
    letter-spacing: 0.05em;
  }
  .upload-btn input[type='file'] { display: none; }
  .upload-btn:hover { color: var(--text, #d8dde6); border-color: #6a7282; }
  .upload-status {
    font-size: 0.5rem;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
    text-align: center;
  }
  .upload-error {
    font-size: 0.5rem;
    color: #ff6b6b;
    font-family: ui-monospace, monospace;
    text-align: center;
  }
  .osc-knobs {
    display: flex;
    gap: 2px;
    justify-content: space-around;
    flex-wrap: wrap;
  }
  .mid-row {
    display: grid;
    grid-template-columns: auto 1fr auto;
    gap: 8px;
    align-items: stretch;
  }
  .cam-controls, .right-controls {
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: center;
  }
  .cam-section-label, .bent-label {
    font-size: 0.62rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    color: var(--text-dim);
  }
  .pad-label {
    font-size: 0.55rem;
    color: var(--text-dim);
    letter-spacing: 0.05em;
    margin-top: -2px;
  }
  .pad {
    position: relative;
    background: #050608;
    border: 1px solid var(--cable-cv, #6cf);
    border-radius: 2px;
    touch-action: none;
    cursor: grab;
    user-select: none;
  }
  .pad-zr {
    border-color: var(--accent, #d6a);
  }
  .pad:active { cursor: grabbing; }
  .cross-h, .cross-v {
    position: absolute;
    background: rgba(255,255,255,0.08);
    pointer-events: none;
  }
  .cross-h { left: 0; right: 0; top: 50%; height: 1px; transform: translateY(-0.5px); }
  .cross-v { top: 0; bottom: 0; left: 50%; width: 1px; transform: translateX(-0.5px); }
  .dot {
    position: absolute;
    width: 12px; height: 12px;
    border-radius: 50%;
    background: var(--cable-cv, #6cf);
    border: 1px solid #fff;
    transform: translate(-50%, -50%);
    pointer-events: none;
    box-shadow: 0 0 6px rgba(120, 200, 255, 0.4);
  }
  .pad-zr .dot {
    background: var(--accent, #d6a);
    box-shadow: 0 0 6px rgba(210, 110, 200, 0.4);
  }
  .dot.active { box-shadow: 0 0 12px rgba(120, 200, 255, 0.8); }
  .pad-zr .dot.active { box-shadow: 0 0 12px rgba(210, 110, 200, 0.9); }
  .screen-wrap {
    background: #000;
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 2px;
    display: flex;
    justify-content: center;
    align-items: center;
    min-height: 200px;
  }
  .screen-wrap canvas {
    width: 100%;
    height: 100%;
    display: block;
    background: #000;
  }
  .unison-toggle {
    appearance: none;
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border-dim, rgba(255,255,255,0.15));
    color: var(--text-dim);
    font-size: 0.65rem;
    font-weight: 600;
    letter-spacing: 0.07em;
    padding: 4px 8px;
    border-radius: 2px;
    cursor: pointer;
    transition: background 80ms ease-out, color 80ms ease-out;
  }
  .unison-toggle.on {
    background: var(--accent, #6cf);
    color: #000;
    border-color: var(--accent, #6cf);
  }
  /* Chord-quality segment: two adjacent buttons, the active one inherits
     the .unison-toggle.on accent. */
  .chord-quality {
    display: inline-flex;
    gap: 0;
    border: 1px solid var(--border-dim, rgba(255,255,255,0.15));
    border-radius: 2px;
    overflow: hidden;
  }
  .chord-quality-opt {
    appearance: none;
    background: transparent;
    color: var(--text-dim);
    font-size: 0.6rem;
    font-weight: 600;
    letter-spacing: 0.05em;
    padding: 4px 6px;
    border: none;
    cursor: pointer;
    transition: background 80ms ease-out, color 80ms ease-out;
  }
  .chord-quality-opt:not(:last-child) {
    border-right: 1px solid var(--border-dim, rgba(255,255,255,0.15));
  }
  .chord-quality-opt.on {
    background: var(--accent, #6cf);
    color: #000;
  }
  .bent-section {
    border-top: 1px solid var(--border-dim, rgba(255,255,255,0.08));
    padding-top: 6px;
  }
  .bent-grid {
    display: grid;
    grid-template-columns: repeat(6, 1fr);
    gap: 4px 6px;
    margin-top: 4px;
  }
  .resize-handle {
    position: absolute;
    right: 0;
    bottom: 0;
    width: 16px;
    height: 16px;
    cursor: nwse-resize;
    background: linear-gradient(
      135deg,
      transparent 50%,
      var(--cable-cv) 50%,
      var(--cable-cv) 60%,
      transparent 60%,
      transparent 70%,
      var(--cable-cv) 70%,
      var(--cable-cv) 80%,
      transparent 80%
    );
    opacity: 0.7;
    z-index: 5;
  }
  .resize-handle:hover { opacity: 1; }
</style>

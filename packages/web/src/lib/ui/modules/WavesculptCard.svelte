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
    VIDEO_WALL_FACES,
    installWavesculptFrameDrawer,
    uninstallWavesculptFrameDrawer,
    getWavesculptFrames,
    ribbonStripRange,
    voctToHz,
    detuneOctaveOffset,
    pitchToWiggle,
    packColor01,
    unpackColor01,
    DEFAULT_OSC_COLOR_PACKED,
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
  import {
    WAVETABLE_PRESETS,
    loadWavetablePreset,
  } from '$lib/audio/wavetable-presets';
  import type { VideoEngine } from '$lib/video/engine';
  import ModuleTitle from './ModuleTitle.svelte';

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
  const ENGINE_H = 480;

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
  // BLINK scope-render controls.
  let scale  = $derived(pget('scale'));
  let wiggle = $derived(pget('wiggle'));

  // ---- VIDEO WALL per-face controls (transparency + distort) ----
  // Static face metadata for the UI labels (matches VIDEO_WALL_FACES).
  const WALL_UI = [
    { n: 1, face: 'FRONT' },
    { n: 2, face: 'BACK' },
    { n: 3, face: 'LEFT' },
    { n: 4, face: 'RIGHT' },
    { n: 5, face: 'FLOOR' },
    { n: 6, face: 'CEILING' },
  ];
  function wallAlpha(n: number): number { return pget(`wall${n}_alpha`); }
  function wallDistort(n: number): number { return pget(`wall${n}_distort`); }

  // ---- per-osc CHROMA base colour (RED/GRN/BLU only; ALP has none) ----
  // Each colour osc stores a packed 0xRRGGBB integer param. The native
  // <input type="color"> writes hex; we pack on write, unpack for display +
  // for feeding the render uniforms. Defaults = historical r/g/b.
  const COLOR_PARAM = ['red_color', 'grn_color', 'blu_color'] as const;
  function colorPacked(oscIdx: number): number {
    const key = COLOR_PARAM[oscIdx];
    const def = oscIdx === 0
      ? DEFAULT_OSC_COLOR_PACKED.red
      : oscIdx === 1 ? DEFAULT_OSC_COLOR_PACKED.grn : DEFAULT_OSC_COLOR_PACKED.blu;
    return (node?.params?.[key] as number | undefined) ?? def;
  }
  function colorHex(oscIdx: number): string {
    return '#' + (colorPacked(oscIdx) & 0xffffff).toString(16).padStart(6, '0');
  }
  function onColorPick(oscIdx: number, ev: Event): void {
    const hex = (ev.target as HTMLInputElement).value;
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    const t = patch.nodes[id]; if (!t) return;
    t.params[COLOR_PARAM[oscIdx]!] = packColor01(r, g, b);
  }
  // Reactive hexes for the three swatches (re-derive when params change).
  let redHex = $derived((pget('red_color'), colorHex(0)));
  let grnHex = $derived((pget('grn_color'), colorHex(1)));
  let bluHex = $derived((pget('blu_color'), colorHex(2)));

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

  // Per-osc baked-in preset loader. Decision: ONE dropdown PER OSC (×4)
  // rather than a single shared dropdown plus an osc-select. The card's
  // per-osc strip already groups every per-osc control (wav-select, knob row,
  // ADSR, thickness), so the preset picker reads cleanly when it lives
  // alongside its sibling controls — the same hand reaching for an osc-3
  // upload button now reaches for the osc-3 preset picker right next to it.
  // Same plumbing as the file-upload path: writes node.data.osc{i}.* so the
  // wavesculpt factory's poll loop posts loadWavetable (no worklet edits).
  let presetSelection = $state<Record<number, string>>({});
  async function onPresetChange(oscIdx: number, ev: Event): Promise<void> {
    const sel = ev.target as HTMLSelectElement;
    const presetId = sel.value;
    if (!presetId) return;
    const preset = WAVETABLE_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    uploadError[oscIdx] = null;
    uploadStatus[oscIdx] = `loading ${preset.label}...`;
    try {
      const parsed = await loadWavetablePreset(preset.url);
      const target = patch.nodes[id];
      if (!target) return;
      if (!target.data) target.data = {};
      const d = target.data as WavesculptData;
      const key = `osc${oscIdx + 1}` as keyof WavesculptData;
      if (!d[key]) (d as Record<string, unknown>)[key as string] = {};
      const od = d[key] as WavesculptOscData;
      od.wavetableSource = 'user';
      od.wavetableFrames = parsed.frames;
      od.wavetableLabel = preset.label;
      uploadStatus[oscIdx] = `loaded ${parsed.frames.length} frames`;
    } catch (err) {
      uploadError[oscIdx] = err instanceof Error ? err.message : String(err);
      uploadStatus[oscIdx] = null;
    } finally {
      presetSelection[oscIdx] = '';
    }
  }

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

  // ---- VIDEO WALLS (6 faces of the room) ----
  // Each cross-domain video input wall1..wall6 is uploaded into one of these
  // textures every frame and drawn as a quad on the matching box face inside
  // the room. The wall program tessellates the face into a grid so the
  // DISTORT control can displace the quad toward the room centre into a
  // convex hemisphere (flat at distort=0, full dome at distort=1). A scratch
  // canvas + 2D ctx services the self-feedback / audio-domain-source draw
  // path (the source module's drawFrame paints into it; we then upload it).
  let wallProgram: WebGLProgram | null = null;
  let wallVao: WebGLVertexArrayObject | null = null;
  let wallBuf: WebGLBuffer | null = null;
  let wallTextures: (WebGLTexture | null)[] = [];
  // Per-wall: is a source currently patched + did this frame's upload succeed.
  let wallPatched: boolean[] = [false, false, false, false, false, false];
  // Scratch 2D canvas reused for drawFrame-based (audio-domain / self) walls.
  let wallScratchCanvas: OffscreenCanvas | HTMLCanvasElement | null = null;
  // Wall grid tessellation. 16×16 quads gives a smooth dome at distort=1
  // without an expensive vertex count (6 walls × 16×16×6 ≈ 9.2k verts).
  const WALL_GRID = 16;
  // Vertices per wall = GRID×GRID quads × 6 verts (two triangles).
  const WALL_VERTS_PER = WALL_GRID * WALL_GRID * 6;
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

  // ---- BLINK scope modes (1 = SCOPES TRIAL, 2 = REALITY BASED COMMUNITY) ----
  // A second strip program draws each oscillator's LIVE oscilloscope trace
  // as a line/tube emitted from a floor corner up+inward at 45°. The live
  // per-osc time-domain samples ride a scopeTex (SCOPE_TEX_W × 4 RGBA8,
  // R = sample mapped [-1..1]→[0..1]), refreshed each frame from the audio
  // module's read('scopes'). Lazily created on first BLINK-mode frame so
  // BLINK mode 0 + the non-3D video modes pay nothing.
  let scopeProgram: WebGLProgram | null = null;
  let scopeVao: WebGLVertexArrayObject | null = null;
  let scopeSamplesBuf: WebGLBuffer | null = null;
  let scopeTex: WebGLTexture | null = null;
  const SCOPE_TEX_W = 512;   // matches the audio module's scope fftSize
  const SCOPE_TEX_H = 4;
  const SCOPE_SEGMENTS = 128; // line resolution along each trace
  // Ring vertices around the swept tube (REALITY BASED COMMUNITY mode). 8
  // sides reads as a round neon tube at card resolution without exploding
  // the vertex count (128 segments × (8+1) ring verts × 4 oscs ≈ 4.6k).
  const TUBE_SIDES = 8;
  const scopeTexUploadBuf = new Uint8Array(SCOPE_TEX_W * SCOPE_TEX_H * 4);
  let scopeInitDone = false;

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

float hashB(float n) { return fract(sin(n * 91.3458) * 47453.5453); }

void main() {
  vec4 base = uOscColor[vOsc];
  float bolt = uBolt[vOsc];
  float band = smoothstep(0.0, 0.15, vT) * smoothstep(1.0, 0.85, vT);
  vec3 col = base.rgb * (0.4 + 0.5 * band);
  float alpha = base.a * (0.35 + 0.35 * band);

  // GATE ELECTRICITY — when a voice is gated (bolt = its envelope level,
  // 0 when silent so the effect stays GATED on the audio input) the ribbon
  // visibly electrifies. Three traveling arc heads sweep the trace (the
  // primary at uBoltPhase, two more offset around the ribbon so the
  // crackle covers most of its length), each a sharp bright spike, plus a
  // fast high-freq crackle riding the whole lit band. Strength scales with
  // the gate level; capped so a hot gate reads as electricity, not a flash
  // that washes the image white.
  if (bolt > 0.001) {
    float ph = uBoltPhase[vOsc];
    // Three arc heads at different points along the ribbon (wrap with fract).
    float d0 = vT - ph;
    float d1 = vT - fract(ph + 0.37);
    float d2 = vT - fract(ph + 0.71);
    // Tighter sigma → sharper, more lightning-like spikes; sum the three.
    // Narrow Gaussians keep the underlying waveform shape readable BETWEEN
    // the arcs rather than flooding the whole ribbon to white.
    float arc = exp(-d0 * d0 / 0.0016)
              + exp(-d1 * d1 / 0.0022) * 0.8
              + exp(-d2 * d2 / 0.0030) * 0.65;
    // High-frequency crackle — SPARSE flickering filaments riding the lit
    // band (deterministic hash of position + phase so it sparkles, frozen-
    // stable under the VRT freeze hook since ph is pinned there). A high
    // threshold + steep power keeps it to occasional bright specks, NOT a
    // solid fill, so the underlying waveform reads through.
    float crackleRaw = hashB(floor(vT * 120.0) + floor(ph * 60.0));
    float crackle = smoothstep(0.86, 1.0, crackleRaw) * band;
    // Cool electric-blue/white arc colour.
    vec3 arcCol = vec3(0.55, 0.75, 1.0);
    vec3 hotCol = vec3(0.85, 0.95, 1.0);
    float energy = bolt;
    col += arcCol * arc * energy * 1.9;       // bright traveling arcs
    col += hotCol * crackle * energy * 1.5;   // crackling filaments (sparse)
    // Faint electric charge over the band so even between arcs the gated
    // ribbon reads as energised — kept low to avoid a white flood.
    col += arcCol * band * energy * 0.12;
    alpha = min(1.0, alpha + (arc * 0.7 + crackle * 0.6 + band * 0.08) * energy);
    // Keep colour bounded so a hot gate electrifies without blowing to flat
    // white — clamp the additive overshoot a touch above 1 then let the
    // BENTBOX post softClip/bloom handle the highlight roll-off.
    col = min(col, vec3(1.5));
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

  // ---- VIDEO WALL program (textured box faces with convex DISTORT) ----
  //
  // Geometry: per wall a flat grid quad on its face plane (the GRID×GRID
  // tessellation lets us bend it). Attributes per vertex: aGx, aGy in [0..1]
  // (grid UV across the face). The CPU sets, per draw, the face's two in-
  // plane basis vectors (uU, uV), the face centre (uCentre) and the inward
  // normal (uInward). The DISTORT amount (uDistort, 0..1) blends each vertex
  // from its FLAT position on the face toward a HEMISPHERE bulging inward:
  //
  //   flat   = centre + uU*(gx*2-1) + uV*(gy*2-1)
  //   dome   = flat   + uInward * bulge,  bulge = cos(r·π/2)*depth
  //
  // where r is the radial distance from the face centre (0 at centre, 1 at
  // the rim). cos(r·π/2) is 1 at the centre and 0 at the rim → a smooth
  // convex cap anchored to the face edges (the rim stays put so adjacent
  // walls don't tear apart), bulging toward the room centre we look up into.
  // A fisheye UV warp (sampling toward the centre as the dome bulges) sells
  // the "looking up into a dome" read. distort=0 → flat quad, untouched.
  const WALL_VS = `#version 300 es
in float aGx;
in float aGy;

uniform mat4  uMVP;
uniform vec3  uCentre;
uniform vec3  uU;       // in-plane basis (half-extent already baked: spans -1..+1 face)
uniform vec3  uV;
uniform vec3  uInward;  // unit inward normal (toward room centre)
uniform float uDistort; // 0 flat .. 1 full dome

out vec2 vUv;

void main() {
  // Grid coord centred at the face: sx, sy in [-1..+1].
  float sx = aGx * 2.0 - 1.0;
  float sy = aGy * 2.0 - 1.0;
  vec3 flatPos = uCentre + uU * sx + uV * sy;

  // Radial distance from face centre, clamped to the unit disc.
  float r = clamp(length(vec2(sx, sy)), 0.0, 1.0);
  // Convex cap profile: 1 at centre → 0 at rim (rim anchored).
  float cap = cos(r * 1.5707963);
  // Bulge depth scales with distort. 0.95 ≈ almost a full hemisphere at
  // distort=1 (the inward normal reaches nearly to the room centre).
  float bulge = cap * uDistort * 0.95;
  vec3 pos = flatPos + uInward * bulge;

  gl_Position = uMVP * vec4(pos, 1.0);

  // Fisheye UV: as the dome bulges, pull the sampling toward the centre so
  // the texture appears wrapped over the inside of the cap. At distort=0 the
  // UV is the flat grid UV (1:1). Mix by distort so the morph is continuous.
  float warp = mix(1.0, 0.62, uDistort * (1.0 - r * 0.4));
  vec2 fishUv = vec2(0.5) + vec2(sx, sy) * 0.5 * warp;
  vUv = mix(vec2(aGx, aGy), fishUv, uDistort);
}`;

  const WALL_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;

uniform sampler2D uWallTex;
uniform float uWallAlpha;   // 0..1 transparency (1 = fully opaque)

void main() {
  vec3 c = texture(uWallTex, vUv).rgb;
  // Premultiply-free additive-friendly: the scene pass uses standard alpha
  // blending (SRC_ALPHA, ONE_MINUS_SRC_ALPHA), so the wall composites OVER
  // the cleared scene by uWallAlpha. The ribbons (additive) then draw on
  // top, so the walls read as the room's textured backdrop.
  outColor = vec4(c, clamp(uWallAlpha, 0.0, 1.0));
}`;

  // ---- BLINK scope program (modes 1 + 2) ----
  //
  // The two non-default BLINK modes draw each oscillator's signal as the
  // EXACT oscilloscope waveform SHAPE the SCOPE module renders (the card
  // reads the SAME per-osc time-domain analyser windows the SCOPE tuner
  // reads — see wavesculpt.ts read('scopes')). The trace runs along a ray
  // that originates at one of the 4 floor corners and is aimed UP + INWARD
  // at 45°; the scope sample at parameter t displaces the trace
  // perpendicular to the ray. SCALE multiplies that displacement (reusing
  // SCOPE's ch1Scale amplitude semantics), so at equal SCALE the shape
  // matches a SCOPE patched to the same signal.
  //
  //   * SCOPES TRIAL (uMode 1): a THIN scope LINE. WIDTH = line thickness.
  //   * REALITY BASED COMMUNITY (uMode 2): a REAL swept 3D TUBE — actual
  //     ring geometry (TUBE_SIDES verts) extruded around the waveform path,
  //     not a screen-space-thickened strip. WIDTH = tube radius. Lit with a
  //     view-facing neon rim + hot core so it reads as a glowing solid tube.
  //
  // Geometry (buildScopeTube): per segment a ring of TUBE_SIDES vertices.
  // aRing (0..TUBE_SIDES) selects the angle around the path; the VS places
  // it using the path's local frame (tangent + two perpendiculars). The
  // WIGGLE rotation is applied CPU-side to uAim / uOrigin per frame, so the
  // whole tube sweeps through 3D space at a rate + magnitude set by pitch.
  const SCOPE_VS = `#version 300 es
in float aIdx;     // segment index along the path (0..SCOPE_SEGMENTS-1)
in float aRing;    // ring-vertex index around the tube (0..TUBE_SIDES)
in float aOsc;

uniform mat4  uMVP;
uniform vec4  uOrigin[4];  // (possibly wiggle-orbited) ray origin per osc
uniform vec4  uAim[4];     // (possibly wiggle-rotated) ray direction per osc
uniform float uWidth[4];   // 0..1 WIDTH control per osc (line thick / radius)
uniform float uScale[4];   // SCOPE-style amplitude scale per osc
uniform float uMode;       // 1 = thin line, 2 = tube
uniform sampler2D uScopeTex;

out float vT;
out float vRimDot;   // |normal · view-ish| for tube shading (0 edge, 1 face)
flat out int vOsc;

const float TUBE_SIDES = ${TUBE_SIDES}.0;

void main() {
  int osc = int(aOsc);
  vec3 origin = uOrigin[osc].xyz;
  vec3 aim = normalize(uAim[osc].xyz);
  float t = aIdx / float(${SCOPE_SEGMENTS - 1}); // 0..1 along the ray

  // Path point: walk most of the cube diagonal from the corner inward.
  vec3 base = origin + aim * (t * 2.6);

  // Orthonormal frame around the ray. pDisp = displacement plane (the
  // waveform bends in this plane), pWide = the third axis.
  vec3 ref = abs(aim.y) < 0.95 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 pDisp = normalize(cross(aim, ref));
  vec3 pWide = normalize(cross(aim, pDisp));

  // Live scope sample → [-1..+1] (the SAME shape SCOPE draws), * SCALE.
  float u = t;
  float v = (float(osc) + 0.5) / 4.0;
  float s = (texture(uScopeTex, vec2(u, v)).r * 2.0 - 1.0) * clamp(uScale[osc], 0.0, 10.0);
  // Endpoint taper so the trace fades in/out instead of ending in a spike.
  float taper = smoothstep(0.0, 0.06, t) * smoothstep(1.0, 0.9, t);

  // The waveform-displaced centreline.
  vec3 centre = base + pDisp * (s * 0.9 * taper);

  float w = clamp(uWidth[osc], 0.0, 1.0);
  // Mode 1 = thin line: a small radius that grows modestly with WIDTH.
  // Mode 2 = tube: WIDTH = real tube radius (max ≈ fills the box).
  float radius = (uMode > 1.5) ? (0.02 + w * 0.32) : (0.006 + w * 0.05);

  // Place the ring vertex around the centreline using the frame. The ring
  // angle sweeps a full circle in the (pDisp, pWide) plane.
  float ang = (aRing / TUBE_SIDES) * 6.2831853;
  vec3 nrm = normalize(pDisp * cos(ang) + pWide * sin(ang));
  vec3 p = centre + nrm * radius;

  gl_Position = uMVP * vec4(p, 1.0);
  vT = t;
  // Cheap face/rim term: the ring normal's alignment with the aim's
  // perpendicular toward +Z (a stand-in for the view dir) — gives the tube
  // a lit face and darker silhouette without needing the real eye vector.
  // Mapped to a WIDE 0.12..1.0 range so the silhouette goes genuinely dark
  // and the face↔silhouette gradient reads as real 3D shading.
  vRimDot = clamp(abs(nrm.z) * 0.88 + 0.12, 0.12, 1.0);
  vOsc = osc;
}`;

  const SCOPE_FS = `#version 300 es
precision highp float;
in float vT;
in float vRimDot;
flat in int vOsc;
out vec4 outColor;

uniform vec4  uNeon[4];   // per-osc neon colour
uniform float uMode;      // 1 = thin scope line, 2 = real neon tube
uniform float uActive[4]; // per-osc activity alpha (0 = silent → draw NOTHING)

void main() {
  vec3 base = uNeon[vOsc].rgb;
  float edge = smoothstep(0.0, 0.12, vT) * smoothstep(1.0, 0.88, vT);
  float act = uActive[vOsc];

  if (uMode > 1.5) {
    // REAL TUBE: HUE-DOMINANT 3D shading. The osc's neon chroma rides from a
    // dark silhouette (ambient floor) up to a bright SATURATED colored face,
    // with only a tiny white specular highlight at the very brightest point —
    // so it reads as a glowing COLORED neon tube, never a white blob.
    // vRimDot is high on the lit face, low (dark) on the silhouette.
    float face = vRimDot;
    vec3 body = base * (0.22 + 0.95 * face); // ambient → diffuse in the osc hue
    float spec = pow(face, 9.0) * 0.35;       // tiny white hot highlight only at the face
    vec3 col = body + vec3(spec);
    float alpha = (0.5 + 0.5 * face) * (0.5 + 0.5 * edge) * act;
    outColor = vec4(col, alpha);
  } else {
    // THIN SCOPE LINE: bright, near-uniform neon trace.
    vec3 col = base * 1.4;
    float alpha = (0.6 + 0.4 * vRimDot) * (0.45 + 0.55 * edge) * act;
    outColor = vec4(col, alpha);
  }
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

  // One wall's tessellated grid quad. Attributes per vertex: aGx, aGy in
  // [0..1]. Reused for ALL 6 walls (the per-face placement + distort is set
  // via uniforms in drawWalls), so we build it once. gl.TRIANGLES list.
  function buildWallGrid(): Float32Array {
    const verts: number[] = [];
    for (let gy = 0; gy < WALL_GRID; gy++) {
      for (let gx = 0; gx < WALL_GRID; gx++) {
        const x0 = gx / WALL_GRID, x1 = (gx + 1) / WALL_GRID;
        const y0 = gy / WALL_GRID, y1 = (gy + 1) / WALL_GRID;
        // Two triangles per cell.
        verts.push(x0, y0, x1, y0, x1, y1);
        verts.push(x0, y0, x1, y1, x0, y1);
      }
    }
    return new Float32Array(verts);
  }

  // Real swept-TUBE geometry for the BLINK scope modes. For each osc we
  // emit a tube: at every segment along the path there's a ring of
  // TUBE_SIDES vertices; between adjacent segments we stitch a quad (two
  // triangles) per ring side. The VS positions each ring vertex around the
  // waveform-displaced centreline using the path's local frame (so this is
  // genuine 3D geometry, NOT a screen-space-thickened strip). Drawn as a
  // gl.TRIANGLES list — all 4 oscs in one buffer / one draw call.
  // Attributes per vertex: aIdx (segment), aRing (ring angle index), aOsc.
  //
  // SCOPES TRIAL (mode 1) reuses the SAME geometry with a tiny radius, so
  // it reads as a thin line; REALITY BASED COMMUNITY (mode 2) uses the full
  // radius → a fat glowing tube.
  function buildScopeTube(): Float32Array {
    const verts: number[] = [];
    const push = (i: number, ring: number, osc: number) => {
      verts.push(i, ring, osc);
    };
    for (let osc = 0; osc < 4; osc++) {
      for (let i = 0; i < SCOPE_SEGMENTS - 1; i++) {
        for (let j = 0; j < TUBE_SIDES; j++) {
          const j1 = j + 1; // ring wraps; aRing=TUBE_SIDES maps to angle 2π
          // Quad (i,j)-(i+1,j)-(i+1,j1)-(i,j1) → 2 triangles.
          push(i, j, osc);     push(i + 1, j, osc);  push(i + 1, j1, osc);
          push(i, j, osc);     push(i + 1, j1, osc); push(i, j1, osc);
        }
      }
    }
    return new Float32Array(verts);
  }
  // Vertices per osc tube = (SCOPE_SEGMENTS-1) rings × TUBE_SIDES quads × 6.
  const SCOPE_TUBE_VERTS = 4 * (SCOPE_SEGMENTS - 1) * TUBE_SIDES * 6;

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

  /** Rotate vector v around unit axis k by angle θ (Rodrigues' formula).
   *  Used by WIGGLE to swing each osc's aim direction through 3D space. */
  function rotateAroundAxis(
    v: [number, number, number],
    k: [number, number, number],
    theta: number,
  ): [number, number, number] {
    const c = Math.cos(theta), s = Math.sin(theta);
    const kl = Math.hypot(k[0], k[1], k[2]) || 1;
    const kx = k[0] / kl, ky = k[1] / kl, kz = k[2] / kl;
    const dot = kx * v[0] + ky * v[1] + kz * v[2];
    // crossKV = k × v
    const cx = ky * v[2] - kz * v[1];
    const cy = kz * v[0] - kx * v[2];
    const cz = kx * v[1] - ky * v[0];
    return [
      v[0] * c + cx * s + kx * dot * (1 - c),
      v[1] * c + cy * s + ky * dot * (1 - c),
      v[2] * c + cz * s + kz * dot * (1 - c),
    ];
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

  // Neon palette for the BLINK scope modes — hot, saturated, additive-
  // friendly colours that read as "neon" against black (hot pink, cyan,
  // electric purple, acid green). Per-osc, RED/GRN/BLU/ALP order.
  const NEON_COLORS: Array<[number, number, number, number]> = [
    [1.0, 0.15, 0.55, 1.0], // hot pink
    [0.15, 1.0, 0.85, 1.0], // cyan
    [0.55, 0.25, 1.0, 1.0], // electric purple
    [0.65, 1.0, 0.15, 1.0], // acid green
  ];

  // Resolve the per-osc render colour from the CHROMA picker param. For the
  // three colour oscillators (RED/GRN/BLU = idx 0/1/2) the picked base colour
  // REPLACES the hard-coded hue in ALL THREE blink modes (ribbon, scope line,
  // neon tube). The ALP oscillator (idx 3) has no picker — it keeps its
  // baseline colour (white-ish mask / acid-green neon) unchanged. We preserve
  // the per-mode ALPHA channel (ribbon translucency vs neon opacity) by
  // reading it from the supplied base palette, so brightness/intensity
  // behaviour is unchanged — only the hue is user-controlled.
  function oscRenderColor(
    i: number,
    base: ReadonlyArray<readonly [number, number, number, number]>,
  ): [number, number, number, number] {
    const b = base[i]!;
    if (i >= 3) return [b[0], b[1], b[2], b[3]];
    const [r, g, bl] = unpackColor01(colorPacked(i));
    return [r, g, bl, b[3]];
  }

  // The four FLOOR CORNERS of the unit cube (y=-1), and a unit direction
  // aimed UP and INWARD toward the centre at 45° from each. These seed
  // uOrigin/uAim for the scope tube shader (WIGGLE rotates them per frame).
  // Inward = toward the XZ origin; up = +Y; normalized so "45°" means equal
  // up + inward components.
  //
  // Corner→osc mapping (owner kept the ribbon corner mapping):
  //   RED=−X−Z, GRN=+X−Z, BLU=+X+Z, ALP=−X+Z.
  const SCOPE_CORNERS: Array<[number, number, number]> = [
    [-1, -1, -1],
    [ 1, -1, -1],
    [ 1, -1,  1],
    [-1, -1,  1],
  ];
  const SCOPE_AIMS: Array<[number, number, number]> = SCOPE_CORNERS.map(([x, y, z]) => {
    // Horizontal inward = toward origin in XZ; vertical = up (+Y). Mix
    // 50/50 then normalize → 45° between the floor plane and straight up.
    const inwardX = -x, inwardZ = -z;
    const ih = Math.hypot(inwardX, inwardZ) || 1;
    const hx = inwardX / ih, hz = inwardZ / ih;
    // up component = 1, horizontal magnitude = 1 → 45°.
    const v: [number, number, number] = [hx, 1, hz];
    const len = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / len, v[1] / len, v[2] / len];
  });

  /** Draw the BLINK scope traces (mode 1 = thin scope lines, mode 2 = real
   *  swept neon tubes) into the bound scene FBO. The trace is the exact
   *  oscilloscope waveform SHAPE SCOPE renders; SCALE multiplies the
   *  amplitude; WIGGLE swings each osc's aim + origin through 3D space at a
   *  rate + magnitude proportional to that osc's pitch. Reuses mvpMat (set
   *  for this frame). Additive + depth-disabled (order-independent glow). */
  function drawScopes(g: WebGL2RenderingContext, mode: number): void {
    if (!scopeProgram || !scopeVao) return;
    const meta = uploadScopeTex();
    g.useProgram(scopeProgram);

    // Per-osc WIGGLE tilt. The phase is advanced once per frame in the main
    // render loop (single advancer); here we just read it and scale by the
    // magnitude from the DETECTED pitch (meta.pitches) — the actual audible
    // pitch of each voice — and the WIGGLE strength. wiggle=0 → tilt 0.
    const wiggleMag: number[] = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) {
      const { magnitude } = pitchToWiggle(meta.pitches[i] ?? null, meta.wiggle);
      wiggleMag[i] = Math.sin(scopeWigglePhase[i]!) * magnitude;
    }

    const originArr = new Float32Array(16);
    const aimArr = new Float32Array(16);
    const neonArr = new Float32Array(16);
    const widthArr = new Float32Array(4);
    const scaleArr = new Float32Array(4);
    // Per-osc ACTIVITY alpha. A silent / OFF / unpatched osc has amp ≈ 0 and
    // must contribute ZERO coverage (so it draws NOTHING — no static straight
    // diagonal line). Active voices fade in smoothly with their envelope. The
    // smoothstep knee (ACT_LO..ACT_HI) suppresses true silence + analyser
    // noise while still showing a barely-audible voice once above the floor.
    const ACT_LO = 0.02;   // below this peak amplitude → treated as silence (alpha 0)
    const ACT_HI = 0.12;   // at/above this → fully visible (alpha 1)
    const activeArr = new Float32Array(4);
    for (let i = 0; i < 4; i++) {
      const amp = meta.amp[i] ?? 0;
      // smooth ramp: silence/OFF → 0, normal signal → 1, no hard pop.
      const t = Math.max(0, Math.min(1, (amp - ACT_LO) / (ACT_HI - ACT_LO)));
      activeArr[i] = t * t * (3 - 2 * t);
    }
    for (let i = 0; i < 4; i++) {
      const c = SCOPE_CORNERS[i]!, a0 = SCOPE_AIMS[i]!, n = oscRenderColor(i, NEON_COLORS);
      // WIGGLE: rotate the aim direction (and orbit the origin slightly)
      // around a fixed perpendicular axis by the per-osc tilt angle. The
      // whole trace sweeps through 3D space. At wiggle=0 the angle is 0 →
      // the aim/origin are unchanged (the existing fixed-direction look).
      const theta = wiggleMag[i]!;
      // Axis: a horizontal axis perpendicular to the corner's inward XZ
      // direction, so the trace swings up/down + sideways rather than just
      // spinning about its own length.
      const axis: [number, number, number] = [-c[2], 0, c[0]];
      const aim = theta !== 0 ? rotateAroundAxis(a0, axis, theta) : a0;
      // Orbit the origin a touch so the base of the trace also moves.
      const orbited = theta !== 0 ? rotateAroundAxis(c, [0, 1, 0], theta * 0.4) : c;
      originArr[i * 4] = orbited[0]; originArr[i * 4 + 1] = orbited[1]; originArr[i * 4 + 2] = orbited[2];
      aimArr[i * 4] = aim[0]; aimArr[i * 4 + 1] = aim[1]; aimArr[i * 4 + 2] = aim[2];
      neonArr[i * 4] = n[0]; neonArr[i * 4 + 1] = n[1]; neonArr[i * 4 + 2] = n[2]; neonArr[i * 4 + 3] = n[3];
      // WIDTH = the per-osc THICK control. Scope-line thickness (mode 1) /
      // tube radius (mode 2). Max → trace nearly fills the box.
      widthArr[i] = (node?.params?.[`thickness${i + 1}`] as number | undefined) ?? 0.3;
      scaleArr[i] = meta.scale[i] ?? 1;
    }
    g.uniformMatrix4fv(g.getUniformLocation(scopeProgram, 'uMVP'), false, mvpMat);
    g.uniform4fv(g.getUniformLocation(scopeProgram, 'uOrigin[0]'), originArr);
    g.uniform4fv(g.getUniformLocation(scopeProgram, 'uAim[0]'), aimArr);
    g.uniform4fv(g.getUniformLocation(scopeProgram, 'uNeon[0]'), neonArr);
    g.uniform1fv(g.getUniformLocation(scopeProgram, 'uWidth[0]'), widthArr);
    g.uniform1fv(g.getUniformLocation(scopeProgram, 'uScale[0]'), scaleArr);
    g.uniform1fv(g.getUniformLocation(scopeProgram, 'uActive[0]'), activeArr);
    g.uniform1f(g.getUniformLocation(scopeProgram, 'uMode'), mode);
    g.activeTexture(g.TEXTURE0);
    g.bindTexture(g.TEXTURE_2D, scopeTex);
    g.uniform1i(g.getUniformLocation(scopeProgram, 'uScopeTex'), 0);

    // Additive, depth-disabled: the four neon traces are translucent glow
    // and must show through one another regardless of camera angle.
    g.disable(g.DEPTH_TEST);
    g.depthMask(false);
    g.colorMask(true, true, true, true);
    g.enable(g.BLEND);
    g.blendFunc(g.SRC_ALPHA, g.ONE);
    g.bindVertexArray(scopeVao);
    g.drawArrays(g.TRIANGLES, 0, SCOPE_TUBE_VERTS);
    g.bindVertexArray(null);
    g.disable(g.BLEND);
  }

  let renderStartMs = 0;

  // ---- VRT determinism hook ----
  // The live render is time-driven (wavePhase scroll, uTime noise/scan,
  // CRT field-parity, bolt phase), which is why WAVESCULPT was VRT-exempt.
  // When the test harness sets globalThis.__wavesculptVrtFreeze = true we
  // pin every time-derived input to a FIXED value so a single-frame
  // screenshot is reproducible across runs/rAFs. No effect in production
  // (flag is never set). The fixed phase is deliberately non-zero so the
  // ribbon shows real wave displacement (not a flat line) in the baseline.
  function vrtFrozen(): boolean {
    return (globalThis as unknown as { __wavesculptVrtFreeze?: boolean })
      .__wavesculptVrtFreeze === true;
  }
  const VRT_FIXED_TSEC = 2.0;       // pinned uTime
  const VRT_FIXED_WAVE_PHASE = 0.0; // pinned per-osc wavetable scroll

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

  // WIGGLE rotation phase per osc (radians). Advanced once per frame in the
  // main render loop by pitchToWiggle(pitch, wiggle).rate * dt; the tilt
  // applied to the ribbon vec / scope aim+origin is sin(phase) * magnitude.
  // Pinned (no advance) under the VRT freeze hook so the baseline is stable
  // at a fixed non-zero phase.
  let scopeWigglePhase: number[] = [0, 0, 0, 0];

  function findAlphaInSource(): { nodeId: string; portId: string } | null {
    return findInputSource('alpha_in');
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

  /** Resolve the upstream (sourceNodeId, sourcePortId) currently patched
   *  into one of this card's inputs by walking the live patch edges. Returns
   *  null when the input is unpatched. Shared by the wall + alpha paths. */
  function findInputSource(portId: string): { nodeId: string; portId: string } | null {
    for (const eid of Object.keys(patch.edges)) {
      const e = patch.edges[eid];
      if (!e) continue;
      if (e.target?.nodeId === id && e.target?.portId === portId) {
        return { nodeId: e.source.nodeId, portId: e.source.portId };
      }
    }
    return null;
  }

  /** Upload one frame from whatever is patched into wall{wallIdx+1} into
   *  wallTextures[wallIdx]. Returns true if a frame was uploaded.
   *
   *  Source-domain handling (the cross-domain wiring):
   *   - VIDEO-domain source (ACIDWARP, LINES, VIDEOBOX, …): selectively
   *     render its FBO into the shared video-engine drawing buffer via
   *     blitOutputToDrawingBuffer(), then upload videoEngine.canvas — the
   *     SAME path alpha_in uses. This covers the per-port sweep (acidwarp).
   *   - AUDIO-domain source with a mono-video output (RASTERIZE, FOXY's
   *     viz, and crucially WAVESCULPT ITSELF): pull its drawFrame via the
   *     audio engine's getVideoSource(), paint into a scratch 2D canvas,
   *     then upload that. This is what makes SELF-FEEDBACK work — patching
   *     this card's own video_out into a wall draws the card's last frame
   *     (its FRAME_DRAWER blits renderCanvas), which the wall textures back
   *     into the scene → recursive feedback through the BENTBOX prevFbo. We
   *     deliberately DON'T special-case-block self-patching. */
  function tryUploadWall(wallIdx: number): boolean {
    if (!gl) return false;
    const tex = wallTextures[wallIdx];
    if (!tex) return false;
    const src = findInputSource(`wall${wallIdx + 1}`);
    if (!src) return false;
    const e = engineCtx.get();
    if (!e) return false;
    const srcNode = patch.nodes[src.nodeId];
    const srcDomain = srcNode?.domain ?? 'audio';

    let imageSource: CanvasImageSource | undefined;
    if (srcDomain === 'video') {
      // Cross-domain: render the source video module's FBO into the shared
      // drawing buffer, then sample that buffer.
      let videoEngine: VideoEngine | undefined;
      try { videoEngine = e.getDomain<VideoEngine>('video'); } catch { videoEngine = undefined; }
      if (!videoEngine) return false;
      try { videoEngine.blitOutputToDrawingBuffer(src.nodeId); } catch { return false; }
      imageSource = videoEngine.canvas as CanvasImageSource | undefined;
    } else {
      // Audio-domain (incl. self): ask the audio engine for the source's
      // mono-video drawFrame + render it into a scratch canvas.
      let audioEngine: { getVideoSource?: (n: string, p: string) => { drawFrame?: (c: OffscreenCanvas | HTMLCanvasElement) => void } | null } | undefined;
      try {
        audioEngine = e.getDomain('audio') as unknown as typeof audioEngine;
      } catch { audioEngine = undefined; }
      const vsrc = audioEngine?.getVideoSource?.(src.nodeId, src.portId) ?? null;
      if (!vsrc?.drawFrame) return false;
      if (!wallScratchCanvas) {
        if (typeof OffscreenCanvas !== 'undefined') {
          wallScratchCanvas = new OffscreenCanvas(RES_W, RES_H);
        } else if (typeof document !== 'undefined') {
          const c = document.createElement('canvas');
          c.width = RES_W; c.height = RES_H;
          wallScratchCanvas = c;
        } else {
          return false;
        }
      }
      try { vsrc.drawFrame(wallScratchCanvas); } catch { return false; }
      imageSource = wallScratchCanvas as CanvasImageSource;
    }
    if (!imageSource) return false;
    try {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE,
        imageSource as TexImageSource,
      );
      return true;
    } catch {
      return false;
    }
  }

  /** Refresh all 6 wall textures from their patched sources. Records which
   *  walls have live content in wallPatched[] (drawWalls skips the rest). */
  function tryUploadWalls(): void {
    for (let w = 0; w < 6; w++) {
      wallPatched[w] = tryUploadWall(w);
    }
  }

  /** Draw the textured + distortable wall quads onto their box faces into
   *  the currently-bound (scene) FBO. Standard alpha blending so the wall
   *  composites OVER the cleared scene; depth WRITE on so closer dome
   *  geometry occludes correctly, but depth TEST against the ribbons is
   *  handled by drawing walls FIRST (ribbons are additive + depth-disabled
   *  and draw after, layering on top). uMVP is the live camera matrix. */
  function drawWalls(g: WebGL2RenderingContext): void {
    if (!wallProgram || !wallVao) return;
    let anyPatched = false;
    for (let w = 0; w < 6; w++) if (wallPatched[w]) { anyPatched = true; break; }
    if (!anyPatched) return;

    g.useProgram(wallProgram);
    g.uniformMatrix4fv(g.getUniformLocation(wallProgram, 'uMVP'), false, mvpMat);
    const uCentre  = g.getUniformLocation(wallProgram, 'uCentre');
    const uU       = g.getUniformLocation(wallProgram, 'uU');
    const uV       = g.getUniformLocation(wallProgram, 'uV');
    const uInward  = g.getUniformLocation(wallProgram, 'uInward');
    const uDistort = g.getUniformLocation(wallProgram, 'uDistort');
    const uWallTex = g.getUniformLocation(wallProgram, 'uWallTex');
    const uWallAlpha = g.getUniformLocation(wallProgram, 'uWallAlpha');

    // Walls are opaque-ish backdrop quads: depth test + write so a bulged
    // dome self-occludes; blend so transparency works.
    g.enable(g.DEPTH_TEST);
    g.depthFunc(g.LEQUAL);
    g.depthMask(true);
    g.enable(g.BLEND);
    g.blendFunc(g.SRC_ALPHA, g.ONE_MINUS_SRC_ALPHA);
    g.bindVertexArray(wallVao);

    for (const face of VIDEO_WALL_FACES) {
      const w = face.wallIdx;
      if (!wallPatched[w]) continue;
      const alpha01 = Math.max(0, Math.min(1,
        ((node?.params?.[`wall${w + 1}_alpha`] as number | undefined) ?? 100) / 100));
      if (alpha01 <= 0) continue; // fully transparent → skip
      const distort = Math.max(0, Math.min(1,
        (node?.params?.[`wall${w + 1}_distort`] as number | undefined) ?? 0));

      // Build the face's frame: centre on the face plane (axis at sign·1),
      // two in-plane basis vectors spanning the full -1..+1 face, and the
      // inward normal (−sign on the face axis). The box is [-1,+1]^3.
      const centre: [number, number, number] = [0, 0, 0];
      centre[face.axis] = face.sign;
      // Pick two world axes orthogonal to the face axis as the in-plane basis.
      const a = face.axis;
      const ax1 = (a + 1) % 3;
      const ax2 = (a + 2) % 3;
      const u: [number, number, number] = [0, 0, 0];
      const v: [number, number, number] = [0, 0, 0];
      u[ax1] = 1;
      v[ax2] = 1;
      const inward: [number, number, number] = [0, 0, 0];
      inward[face.axis] = -face.sign;

      g.uniform3f(uCentre, centre[0], centre[1], centre[2]);
      g.uniform3f(uU, u[0], u[1], u[2]);
      g.uniform3f(uV, v[0], v[1], v[2]);
      g.uniform3f(uInward, inward[0], inward[1], inward[2]);
      g.uniform1f(uDistort, distort);
      g.uniform1f(uWallAlpha, alpha01);
      g.activeTexture(g.TEXTURE0);
      g.bindTexture(g.TEXTURE_2D, wallTextures[w]!);
      g.uniform1i(uWallTex, 0);
      g.drawArrays(g.TRIANGLES, 0, WALL_VERTS_PER);
    }

    g.bindVertexArray(null);
    g.disable(g.BLEND);
    g.disable(g.DEPTH_TEST);
    g.depthMask(true);
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

  // Lazily build the BLINK scope program + geometry + texture the first
  // time a BLINK scope mode renders. Keeps BLINK mode 0 (default) + the
  // non-3D video modes free of the extra GL objects. Returns false if the
  // program can't be built (then the caller falls back to the ribbon).
  function ensureScopeGl(): boolean {
    if (!gl) return false;
    if (scopeInitDone) return scopeProgram !== null;
    scopeInitDone = true;
    try {
      scopeProgram = linkProgram(gl, SCOPE_VS, SCOPE_FS);
    } catch (err) {
      console.error('[WAVESCULPT] scope shader setup failed:', err);
      scopeProgram = null;
      return false;
    }
    const geom = buildScopeTube();
    scopeVao = gl.createVertexArray();
    gl.bindVertexArray(scopeVao);
    scopeSamplesBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, scopeSamplesBuf);
    gl.bufferData(gl.ARRAY_BUFFER, geom, gl.STATIC_DRAW);
    const aIdxLoc = gl.getAttribLocation(scopeProgram, 'aIdx');
    const aRingLoc = gl.getAttribLocation(scopeProgram, 'aRing');
    const aOscLoc = gl.getAttribLocation(scopeProgram, 'aOsc');
    const stride = 3 * 4;
    if (aIdxLoc >= 0) { gl.enableVertexAttribArray(aIdxLoc); gl.vertexAttribPointer(aIdxLoc, 1, gl.FLOAT, false, stride, 0); }
    if (aRingLoc >= 0) { gl.enableVertexAttribArray(aRingLoc); gl.vertexAttribPointer(aRingLoc, 1, gl.FLOAT, false, stride, 4); }
    if (aOscLoc >= 0) { gl.enableVertexAttribArray(aOscLoc); gl.vertexAttribPointer(aOscLoc, 1, gl.FLOAT, false, stride, 8); }
    gl.bindVertexArray(null);

    scopeTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, scopeTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, SCOPE_TEX_W, SCOPE_TEX_H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return true;
  }

  interface ScopeMeta {
    scale: number[];          // per-osc SCALE (uniform knob+CV; same value × 4)
    wiggle: number;           // global WIGGLE strength (knob + CV)
    pitches: Array<number | null>; // per-osc detected pitch
    amp: number[];            // per-osc peak |sample| over the window (0 = silent / no trace)
  }

  // Refresh scopeTex from the audio module's live per-osc time-domain
  // traces — the SAME analyser windows the SCOPE module reads, so the
  // rendered trace is the exact oscilloscope waveform SHAPE SCOPE draws.
  // R channel holds the sample mapped [-1..1]→[0..255]; the scope VS
  // decodes it back and multiplies by SCALE (matching SCOPE's ch1Scale).
  // Returns the per-osc SCALE + global WIGGLE + per-osc pitch so drawScopes
  // can apply SCALE in the shader and drive the WIGGLE rotation. Falls back
  // to silence (flat mid-line) + defaults when the engine isn't ready.
  function uploadScopeTex(): ScopeMeta {
    const meta: ScopeMeta = { scale: [1, 1, 1, 1], wiggle: 0, pitches: [null, null, null, null], amp: [0, 0, 0, 0] };
    if (!gl || !scopeTex) return meta;
    const buf = scopeTexUploadBuf;
    const e = engineCtx.get();
    let traces: Float32Array[] | undefined;
    let traceLen = 0;
    if (e && node) {
      try {
        const s = e.read(node, 'scopes') as
          | { traces: Float32Array[]; length: number; scale?: number; wiggle?: number; pitches?: Array<number | null> }
          | undefined;
        if (s) {
          traces = s.traces; traceLen = s.length;
          const sc = s.scale ?? 1;
          meta.scale = [sc, sc, sc, sc];
          meta.wiggle = s.wiggle ?? 0;
          if (Array.isArray(s.pitches)) meta.pitches = s.pitches.slice(0, 4);
        }
      } catch { /* engine not ready */ }
    }
    for (let osc = 0; osc < 4; osc++) {
      const tr = traces?.[osc];
      const rowOffset = osc * SCOPE_TEX_W * 4;
      // Track peak |sample| of the decoded -1..+1 trace so silent / OFF /
      // unpatched oscillators (which fill a flat mid-line) can be gated to
      // ZERO coverage in the shader — no static straight diagonal ray.
      let peak = 0;
      for (let i = 0; i < SCOPE_TEX_W; i++) {
        let s = 0;
        if (tr && traceLen > 0) {
          // Map the texture column to the trace window.
          const srcIdx = Math.min(traceLen - 1, Math.round((i / (SCOPE_TEX_W - 1)) * (traceLen - 1)));
          s = tr[srcIdx] ?? 0;
        }
        const a = Math.abs(s);
        if (a > peak) peak = a;
        const v = Math.max(0, Math.min(255, Math.round((s + 1) * 127.5)));
        const o = rowOffset + i * 4;
        buf[o] = v; buf[o + 1] = v; buf[o + 2] = v; buf[o + 3] = 255;
      }
      // No trace at all → amp 0 (definitely silent). Otherwise the window's
      // peak abs amplitude (0..~1).
      meta.amp[osc] = (tr && traceLen > 0) ? peak : 0;
    }
    gl.bindTexture(gl.TEXTURE_2D, scopeTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, SCOPE_TEX_W, SCOPE_TEX_H, 0, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return meta;
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
      wallProgram = linkProgram(gl, WALL_VS, WALL_FS);
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

    // ---- VIDEO WALL geometry + per-face textures ----
    wallVao = gl.createVertexArray();
    gl.bindVertexArray(wallVao);
    wallBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, wallBuf);
    gl.bufferData(gl.ARRAY_BUFFER, buildWallGrid(), gl.STATIC_DRAW);
    const aGxLoc = gl.getAttribLocation(wallProgram!, 'aGx');
    const aGyLoc = gl.getAttribLocation(wallProgram!, 'aGy');
    const wStride = 2 * 4;
    if (aGxLoc >= 0) { gl.enableVertexAttribArray(aGxLoc); gl.vertexAttribPointer(aGxLoc, 1, gl.FLOAT, false, wStride, 0); }
    if (aGyLoc >= 0) { gl.enableVertexAttribArray(aGyLoc); gl.vertexAttribPointer(aGyLoc, 1, gl.FLOAT, false, wStride, 4); }
    gl.bindVertexArray(null);

    wallTextures = [];
    for (let w = 0; w < 6; w++) {
      const t = gl.createTexture();
      if (t) {
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
          new Uint8Array([0, 0, 0, 255]));
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      }
      wallTextures.push(t);
    }

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
      if (wallProgram) gl.deleteProgram(wallProgram);
      if (wallVao) gl.deleteVertexArray(wallVao);
      if (wallBuf) gl.deleteBuffer(wallBuf);
      for (const t of wallTextures) if (t) gl.deleteTexture(t);
      if (ribbonSamplesBuf) gl.deleteBuffer(ribbonSamplesBuf);
      if (scopeProgram) gl.deleteProgram(scopeProgram);
      if (scopeVao) gl.deleteVertexArray(scopeVao);
      if (scopeSamplesBuf) gl.deleteBuffer(scopeSamplesBuf);
      if (scopeTex) gl.deleteTexture(scopeTex);
    } catch { /* */ }
    scopeProgram = null;
    scopeVao = null;
    scopeSamplesBuf = null;
    scopeTex = null;
    scopeInitDone = false;
    wallProgram = null;
    wallVao = null;
    wallBuf = null;
    wallTextures = [];
    wallScratchCanvas = null;
    wallPatched = [false, false, false, false, false, false];
    gl = null;
    renderCanvas = null;
  }

  function renderToOffscreen() {
    if (!gl || !ribbonProgram || !bentboxProgram) return;
    const g = gl;

    tryUploadAlphaIn();
    tryUploadWalls();
    uploadWaveTex();

    g.bindFramebuffer(g.FRAMEBUFFER, sceneFbo);
    g.viewport(0, 0, RES_W, RES_H);
    g.clearColor(0, 0, 0, 1);
    g.clearDepth(1.0);
    g.clear(g.COLOR_BUFFER_BIT | g.DEPTH_BUFFER_BIT);

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

    // VIDEO WALL pass — textured box faces (with convex DISTORT) drawn into
    // the just-cleared scene FBO BEFORE the ribbons. The ribbons/scopes draw
    // additively with depth disabled afterwards, so they layer on top of the
    // room walls. drawWalls early-outs when no wall is patched, so the
    // existing ribbon-only scene is byte-identical when no walls are wired.
    drawWalls(g);

    g.useProgram(ribbonProgram);
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
    // WIGGLE strength: combined knob+CV (engine.readParam sums them), else
    // the raw knob. Drives the per-osc 3D rotation in ALL blink modes.
    let wiggleStrength = (node?.params?.wiggle as number | undefined) ?? 0;
    if (e && node) {
      try {
        const wv = e.readParam(node, 'wiggle');
        if (typeof wv === 'number') wiggleStrength = wv;
      } catch { /* engine not ready */ }
    }
    // Per-osc WIGGLE tilt (radians), advanced HERE (single advancer for the
    // wiggle phase) so both the ribbon vec rotation and the scope-tube
    // drawScopes() read the same phase. rate + magnitude ∝ pitch.
    const wiggleTilt: number[] = [0, 0, 0, 0];
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
      wavePhase[i] = vrtFrozen()
        ? VRT_FIXED_WAVE_PHASE
        : (wavePhase[i]! + cyclesPerSec * dt) % 1.0;
      // WIGGLE: derive rate + magnitude from this osc's pitch (the knob hz
      // mirrors the audible voice). Advance the phase; tilt = sin(phase)·mag.
      const { rate, magnitude } = pitchToWiggle(hz, wiggleStrength);
      if (vrtFrozen()) {
        scopeWigglePhase[i] = 0.6; // fixed non-zero phase for a stable VRT
      } else {
        scopeWigglePhase[i] = (scopeWigglePhase[i]! + rate * dt) % (Math.PI * 2);
      }
      wiggleTilt[i] = Math.sin(scopeWigglePhase[i]!) * magnitude;
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
      const vec0 = [[-1, 0, 0], [ 1, 0, 0], [0,-1, 0], [0,  1, 0]][i]! as [number, number, number];
      // Apply WIGGLE: rotate the ribbon emit direction around the +Y axis
      // (and a touch of Z) by the per-osc tilt. wiggle=0 → tilt 0 → the
      // original fixed direction (no behaviour change).
      const vec = wiggleTilt[i] !== 0
        ? rotateAroundAxis(vec0, [0, 1, 0.35], wiggleTilt[i]!)
        : vec0;
      srcArr[i * 4 + 0] = wall[0]!;
      srcArr[i * 4 + 1] = wall[1]!;
      srcArr[i * 4 + 2] = wall[2]!;
      srcArr[i * 4 + 3] = 0;
      vecArr[i * 4 + 0] = vec[0]!;
      vecArr[i * 4 + 1] = vec[1]!;
      vecArr[i * 4 + 2] = vec[2]!;
      vecArr[i * 4 + 3] = 0;
      const col = oscRenderColor(i, OSC_COLORS);
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

    // BLINK mode: 0 = wavetable ribbons, 1 = SCOPES TRIAL (thin scope
    // lines), 2 = REALITY BASED COMMUNITY (real 3D neon tubes). Modes 1/2
    // replace the ribbon visual with the per-osc oscilloscope traces; the
    // BENT post + alpha-mask passes are shared.
    const blinkMode = Math.round((node?.params?.blink_mode as number | undefined) ?? 0);

    if (blinkMode > 0 && ensureScopeGl() && scopeProgram) {
      drawScopes(g, blinkMode);
    } else {
      // Scene pass — additive translucent ribbons.
      //
      // BUGFIX (alpha-rotate, #361): this pass previously primed the depth
      // buffer with an opaque DEPTH-ONLY pre-pass over ALL four ribbons
      // (LESS, depthMask on), then drew the additive colour pass with
      // LEQUAL. That made the ribbons MUTUALLY OCCLUDE: whichever ribbon
      // was nearest the camera wrote depth that depth-rejected the ribbons
      // behind it. At rot=0 the ALPHA emitter (-Z wall) sits nearest the
      // camera so it survived — but ANY rotation brought an RGB ribbon in
      // front, whose primed depth then culled the ALPHA ribbon → the ALPHA
      // layer vanished the instant the view rotated.
      //
      // Additive blending (SRC_ALPHA, ONE) is order-independent and the
      // ribbons are translucent energy traces MEANT to show through one
      // another — so there should be no inter-ribbon depth occlusion.
      // Drop the depth pre-pass and draw the additive ribbons with the
      // depth test disabled. Every ribbon composites regardless of camera
      // angle.
      g.disable(g.DEPTH_TEST);
      g.depthMask(false);
      g.colorMask(true, true, true, true);
      g.enable(g.BLEND);
      g.blendFunc(g.SRC_ALPHA, g.ONE);
      g.bindVertexArray(ribbonVao);
      g.drawArrays(g.TRIANGLE_STRIP, 0, ribbonVerts);
      g.bindVertexArray(null);
    }

    // 1c) ALPHA-mask pass (osc 3 only → red mask). Re-bind the ribbon
    // program + its waveTex on TEXTURE0 (drawScopes may have switched the
    // active program + texture when a BLINK scope mode is active).
    //
    // BUGFIX (alpha-rotate, #361): this pass must draw ONLY the ALPHA
    // ribbon (osc 3) AND must not be depth-occluded. Previously it drew all
    // four ribbons with a depth pre-pass, so under rotation an RGB ribbon
    // in front culled the ALPHA fragments → the red mask was never written
    // → the composited alpha_in image vanished off-axis. We now draw ONLY
    // osc 3's sub-strip with the depth test disabled, so the mask is
    // written at any camera angle. ribbonStripRange (exported from
    // wavesculpt.ts — single source of truth) returns the {start,count}
    // covering osc 3's real verts within the strip.
    //
    // NOTE the ALPHA mask always uses the RIBBON geometry (not the scope
    // geometry), so the alpha_in composite stays consistent across all
    // BLINK modes — the BLINK render is purely cosmetic for the visible
    // RGB layers; the ALPHA mask region is driven by osc 3's ribbon.
    g.useProgram(ribbonProgram);
    g.activeTexture(g.TEXTURE0);
    g.bindTexture(g.TEXTURE_2D, waveTex);
    if (uWaveTexLoc) g.uniform1i(uWaveTexLoc, 0);
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
    const { start: alphaStripStart, count: alphaStripCount } = ribbonStripRange(3, RIBBON_SEGMENTS);
    g.disable(g.DEPTH_TEST);
    g.depthMask(false);
    g.colorMask(true, true, true, true);
    g.enable(g.BLEND);
    g.blendFunc(g.SRC_ALPHA, g.ONE);
    g.bindVertexArray(ribbonVao);
    g.drawArrays(g.TRIANGLE_STRIP, alphaStripStart, alphaStripCount);
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
    const tSec = vrtFrozen() ? VRT_FIXED_TSEC : (performance.now() - renderStartMs) / 1000;
    g.uniform1f(g.getUniformLocation(bentboxProgram, 'uTime'), tSec);
    g.uniform1f(g.getUniformLocation(bentboxProgram, 'uFieldParity'), vrtFrozen() ? 0 : ((frameCount & 1) ? 1 : 0));
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
  // the 4 emitters + camera + audio-energy ripples),
  // 2 = SPECTROGRAPH (scrolling STFT of the combined audio output —
  // log-Hz vertical axis, time scrolling right-to-left). Picked via
  // the discrete video_mode param; the on-card View toggle button
  // cycles through all three options.
  let video_mode = $derived(pget('video_mode'));

  // BLINK render mode (within the 3D PROXIMITY view): 0 = (current)
  // wavetable ribbons, 1 = SCOPES TRIAL (live oscilloscope traces from
  // the 4 floor corners), 2 = REALITY BASED COMMUNITY (neon 3D tubes).
  // Persisted + multiplayer-synced via the discrete blink_mode param; the
  // on-card BLINK button cycles 0→1→2→0.
  let blink_mode = $derived(Math.round(pget('blink_mode')));
  const BLINK_MODE_NAMES = ['', 'SCOPES TRIAL', 'REALITY BASED COMMUNITY'];
  let blinkModeName = $derived(BLINK_MODE_NAMES[blink_mode] ?? '');

  // ---- SPECTROGRAPH state ----
  // Circular column buffer of dB magnitude values. SPEC_W columns of
  // SPEC_H log-binned rows. The newest column is written each tick at
  // `specWriteCol`; the canvas blit shifts columns left visually. Kept
  // here (not inside drawSpectrograph) so the buffer persists between
  // frames — the whole point of a spectrograph is the scrolling history.
  const SPEC_W = 256;
  const SPEC_H = 128;
  // Init to a low-floor value so the texture starts as "silence" black,
  // not garbage memory. Web Audio's getFloatFrequencyData uses dBFS
  // (~-100..0); we clamp display to [-90 .. -10].
  const specBuf = new Float32Array(SPEC_W * SPEC_H).fill(-100);
  let specWriteCol = 0;
  // Pre-allocate the ImageData buffer reused every frame for the column
  // write — avoids per-frame GC.
  let specImageData: ImageData | null = null;

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

  /** Map a normalised magnitude m in [0..1] to an RGB heatmap (dark
   *  blue → cyan → yellow → red). Inlined arithmetic so it stays fast
   *  inside the per-pixel column-write loop. */
  function heatmapRgb(m: number): [number, number, number] {
    const v = Math.max(0, Math.min(1, m));
    if (v < 0.25) {
      // Black → dark blue
      const t = v / 0.25;
      return [0, 0, Math.round(80 + t * 100)];
    }
    if (v < 0.5) {
      // Blue → cyan
      const t = (v - 0.25) / 0.25;
      return [0, Math.round(t * 200), Math.round(180 + t * 75)];
    }
    if (v < 0.75) {
      // Cyan → yellow
      const t = (v - 0.5) / 0.25;
      return [Math.round(t * 255), Math.round(200 + t * 55), Math.round(255 - t * 255)];
    }
    // Yellow → red
    const t = (v - 0.75) / 0.25;
    return [255, Math.round(255 - t * 255), 0];
  }

  /** Draw the SPECTROGRAPH view. Pulls the latest FFT bin magnitudes
   *  from the audio module (engine.read(node, 'spectrum') returns
   *  Float32Array of dBFS values + sampleRate + fftSize), log-bins them
   *  into SPEC_H perceptual rows (20Hz..20kHz), writes the new column at
   *  specWriteCol, then blits the circular buffer to the canvas with the
   *  newest column on the right.
   *
   *  Performance: O(SPEC_H + SPEC_W * SPEC_H) per frame. SPEC_W=256,
   *  SPEC_H=128 — single-frame ImageData of 256×128 = 128 KB pixels;
   *  ~2-3 ms on a current laptop. Cheap. */
  function drawSpectrograph(ctx2d: CanvasRenderingContext2D, cw: number, ch: number): void {
    const eng = engineCtx.get();
    const spec = eng && node ? (eng.read(node, 'spectrum') as
      | { bins: Float32Array; sampleRate: number; fftSize: number }
      | undefined) : undefined;

    if (spec) {
      // Log-bin the FFT into SPEC_H rows spanning [20 Hz .. 20 kHz].
      // The audio source is busL after master gain — its sample rate is
      // ctx.sampleRate. Bin k of an fftSize-length FFT covers
      // (k * sampleRate / fftSize) Hz. We map row r → target Hz, then
      // pick the FFT bin nearest to that Hz; for rows whose Hz < bin0
      // resolution, this gracefully clamps to bin 1 (DC is skipped).
      const F_LO = 20;
      const F_HI = Math.min(20000, spec.sampleRate * 0.5);
      const logLo = Math.log(F_LO);
      const logHi = Math.log(F_HI);
      const binCount = spec.bins.length;
      const hzPerBin = spec.sampleRate / spec.fftSize;
      // Write into the circular column. Row 0 = top of canvas = high
      // Hz, row SPEC_H-1 = bottom = low Hz (matches the "vertical axis
      // = frequency, log scale" spec, low at the bottom).
      for (let r = 0; r < SPEC_H; r++) {
        const t = 1 - r / (SPEC_H - 1); // 0 at bottom, 1 at top
        const hz = Math.exp(logLo + t * (logHi - logLo));
        const binIdx = Math.max(1, Math.min(binCount - 1, Math.round(hz / hzPerBin)));
        specBuf[specWriteCol * SPEC_H + r] = spec.bins[binIdx] ?? -100;
      }
      specWriteCol = (specWriteCol + 1) % SPEC_W;
    }

    // Blit the circular buffer into an ImageData. Newest column lives
    // at specWriteCol-1; we walk SPEC_W columns leftward from there so
    // the rightmost screen column is the freshest data.
    if (!specImageData) {
      // Fall back to manual buffer if createImageData fails on this
      // canvas (shouldn't happen for a 2D context, but defensive).
      try { specImageData = ctx2d.createImageData(SPEC_W, SPEC_H); }
      catch { return; }
    }
    const img = specImageData;
    const data = img.data;
    // Display range: -90 dBFS (very quiet) → -10 dBFS (loud). Normalize
    // to [0..1] for the heatmap. Linear-in-dB feels more natural than
    // mapping the raw amplitude (which would crush quiet content).
    const DB_LO = -90;
    const DB_HI = -10;
    const dbRange = DB_HI - DB_LO;
    for (let x = 0; x < SPEC_W; x++) {
      // Source column = (specWriteCol - SPEC_W + x) mod SPEC_W; the
      // oldest column lives at specWriteCol, the newest at
      // specWriteCol-1 mod SPEC_W.
      const srcCol = (specWriteCol + x) % SPEC_W;
      for (let y = 0; y < SPEC_H; y++) {
        const db = specBuf[srcCol * SPEC_H + y] ?? -100;
        const norm = (db - DB_LO) / dbRange;
        const [rr, gg, bb] = heatmapRgb(norm);
        const o = (y * SPEC_W + x) * 4;
        data[o]     = rr;
        data[o + 1] = gg;
        data[o + 2] = bb;
        data[o + 3] = 255;
      }
    }

    // Black background outside the spectrograph blit region.
    ctx2d.fillStyle = '#050608';
    ctx2d.fillRect(0, 0, cw, ch);
    // Scale the ImageData to fill the canvas via an offscreen step
    // (putImageData ignores transforms — so paint into a 1:1 buffer on
    // a private detached canvas, then drawImage that with scaling).
    if (!spectrographScratch) {
      spectrographScratch = document.createElement('canvas');
      spectrographScratch.width = SPEC_W;
      spectrographScratch.height = SPEC_H;
    }
    const scratchCtx = spectrographScratch.getContext('2d');
    if (!scratchCtx) return;
    scratchCtx.putImageData(img, 0, 0);
    // Stretch to fill the display canvas.
    ctx2d.imageSmoothingEnabled = true;
    ctx2d.drawImage(spectrographScratch, 0, 0, SPEC_W, SPEC_H, 0, 0, cw, ch);

    // Mode label, top-left.
    ctx2d.fillStyle = 'rgba(255,255,255,0.7)';
    ctx2d.font = '9px ui-monospace, Menlo, monospace';
    ctx2d.fillText('SPECTROGRAPH', 6, 14);
  }
  // Detached scratch canvas for the spectrograph ImageData→scaled-blit
  // path. Lives at module scope (well, instance scope via let) so it's
  // built once and reused every frame.
  let spectrographScratch: HTMLCanvasElement | null = null;

  function tick() {
    rafId = null;
    // Live camera/joystick poll first, every frame, BEFORE the early-return
    // branches below — so the joystick dots track a patched gamepad (or LFO)
    // at the full render cadence in ALL video modes, not just the 3D path.
    pollCamLive();
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
    if (mode === 2) {
      // SPECTROGRAPH — pure-2D draw, taps the audio module's
      // dedicated AnalyserNode via engine.read(node, 'spectrum').
      if (displayCanvas) {
        const dc2 = displayCanvas.getContext('2d', { alpha: false });
        if (dc2) {
          drawSpectrograph(dc2, displayCanvas.width, displayCanvas.height);
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

  // Camera-CV live-poll. ONE cross-domain call per frame that pulls the
  // entire camera snapshot from engine.read(node, 'camera') — the SAME
  // shadow-analyser samples the spatial audio mix reads. This is the
  // single-source-of-truth read: joystick dot, ribbon viewport (see the
  // WebGL tick above), and audio distGain all reflect the same instant.
  //
  // Runs on rAF (driven from tick()), NOT a setInterval. A standalone
  // setInterval(30ms) here was the gamepad-joystick regression: when a
  // gamepad drives pos_x/pos_y the dot's only path to the screen is this
  // poll (unlike a mouse drag, which writes node.params.* and re-renders
  // the dot synchronously via Svelte reactivity). A setInterval callback
  // gets STARVED + coalesced behind this card's own heavy WebGL render
  // on a busy main thread, so the dot updated horribly slowly and looked
  // like it couldn't reach the stick's extremes (it was just badly under-
  // sampled). Riding rAF pins the poll to the render cadence (~60 Hz, the
  // same rate the mouse path effectively gets) and — crucially — it can no
  // longer be coalesced away by the render it shares a frame with. Audio
  // SCHEDULING stays on the jank-immune scheduler-clock worker tick; only
  // this UI/visual read moves to rAF (per the input-path convention).
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
  });
  onDestroy(() => {
    if (rafId !== null) cancelAnimationFrame(rafId);
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
    // BLINK scope-render controls — CV-modulatable like the camera params
    // (owner intent). Must render a handle so def<->UI parity holds and
    // patches anchor; see e2e/tests/io-spec-consistency.spec.ts.
    { id: 'scale',     label: 'Sc', cable: 'cv' },
    { id: 'wiggle',    label: 'Wg', cable: 'cv' },
    { id: 'alpha_in',  label: 'A',  cable: 'video' },
    // VIDEO WALLS — six cross-domain video inputs, one per box face. Each
    // MUST render a handle (per-module-per-port handle-presence sweep reads
    // the def's literal inputs). Labels match VIDEO_WALL_FACES.
    { id: 'wall1',     label: 'W1·Fr', cable: 'video' },
    { id: 'wall2',     label: 'W2·Bk', cable: 'video' },
    { id: 'wall3',     label: 'W3·Lf', cable: 'video' },
    { id: 'wall4',     label: 'W4·Rt', cable: 'video' },
    { id: 'wall5',     label: 'W5·Fl', cable: 'video' },
    { id: 'wall6',     label: 'W6·Ce', cable: 'video' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'L',         label: 'L',   cable: 'audio' },
    { id: 'R',         label: 'R',   cable: 'audio' },
    // Per-oscillator audio taps (RED/GRN/BLU/ALP) — each emits that one
    // oscillator's signal (post env+dist+pan), the same per-osc source
    // the BLINK oscilloscope reads. Grouped right after L/R so the
    // per-voice outs sit next to the summed main mix. Every declared
    // port MUST render a handle — see e2e/tests/io-spec-consistency.spec.ts
    // (#359/#362 handle/io-spec parity).
    { id: 'out_red',   label: 'RED', cable: 'audio' },
    { id: 'out_grn',   label: 'GRN', cable: 'audio' },
    { id: 'out_blu',   label: 'BLU', cable: 'audio' },
    { id: 'out_alp',   label: 'ALP', cable: 'audio' },
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
  <ModuleTitle {id} {data} defaultLabel="WAVESCULPT" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="body">
      <!-- Per-oscillator strip: WAV / LOAD / tune / fine / morph / spread / fold / ADSR / thickness -->
      <div class="osc-grid">
        {#each [0, 1, 2, 3] as i}
          <div class="osc-strip osc-{i}" data-testid={`wavesculpt-osc-${i + 1}`}>
            <div class="osc-label">
              <span>{OSC_COLOR_LABELS[i]}</span>
              {#if i < 3}
                <!-- CHROMA SELECTOR WHEEL: per-osc custom base colour. A
                     native colour picker (same component pattern as
                     CHROMA/LUMA keyer cards). Picked colour tints this osc
                     in ALL 3 blink modes. Not a single-CC param → uses a
                     native <input type="color">, NOT a Knob/Fader, so it's
                     correctly exempt from the MIDI-Learn audit. -->
                <label
                  class="chroma-swatch-wrap"
                  title="Pick this oscillator's base colour"
                >
                  <span
                    class="chroma-swatch"
                    style="background: {i === 0 ? redHex : i === 1 ? grnHex : bluHex};"
                  ></span>
                  <input
                    type="color"
                    class="chroma-color-input"
                    value={i === 0 ? redHex : i === 1 ? grnHex : bluHex}
                    oninput={(ev) => onColorPick(i, ev)}
                    data-testid={`wavesculpt-osc-${i + 1}-color`}
                  />
                </label>
              {/if}
            </div>
            <div class="wt-row preset-row">
              <select
                class="wt-select preset-select"
                value={presetSelection[i] ?? ''}
                onchange={(ev) => onPresetChange(i, ev)}
                data-testid={`wavesculpt-osc-${i + 1}-preset-select`}
              >
                <option value="">— pick a preset —</option>
                {#each WAVETABLE_PRESETS as p (p.id)}
                  <option value={p.id}>{p.label}</option>
                {/each}
              </select>
            </div>
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
                onchange={set(`tune${i + 1}`)} moduleId={id} paramId={`tune${i + 1}`} readLive={live(`tune${i + 1}`)} />
              <Knob value={i === 0 ? fine1 : i === 1 ? fine2 : i === 2 ? fine3 : fine4}
                min={-100} max={100} defaultValue={0} label="Fine" units="¢" curve="linear"
                onchange={set(`fine${i + 1}`)} moduleId={id} paramId={`fine${i + 1}`} readLive={live(`fine${i + 1}`)} />
              <Knob value={i === 0 ? morph1 : i === 1 ? morph2 : i === 2 ? morph3 : morph4}
                min={0} max={1} defaultValue={0} label="Morph" curve="linear"
                onchange={set(`morph${i + 1}`)} moduleId={id} paramId={`morph${i + 1}`} readLive={live(`morph${i + 1}`)} />
              <Knob value={i === 0 ? spread1 : i === 1 ? spread2 : i === 2 ? spread3 : spread4}
                min={1} max={5} defaultValue={1} label="Sprd" curve="linear"
                onchange={set(`spread${i + 1}`)} moduleId={id} paramId={`spread${i + 1}`} readLive={live(`spread${i + 1}`)} />
              <Knob value={i === 0 ? fold1 : i === 1 ? fold2 : i === 2 ? fold3 : fold4}
                min={0} max={1} defaultValue={0} label="Fold" curve="linear"
                onchange={set(`fold${i + 1}`)} moduleId={id} paramId={`fold${i + 1}`} readLive={live(`fold${i + 1}`)} />
              <Knob value={i === 0 ? thickness1 : i === 1 ? thickness2 : i === 2 ? thickness3 : thickness4}
                min={0} max={1} defaultValue={0.3} label="Thick" curve="linear"
                onchange={set(`thickness${i + 1}`)} moduleId={id} paramId={`thickness${i + 1}`} readLive={live(`thickness${i + 1}`)} />
            </div>
            <div class="osc-knobs">
              <Knob value={i === 0 ? A1 : i === 1 ? A2 : i === 2 ? A3 : A4}
                min={0.001} max={5} defaultValue={0.01} label="A" curve="log" units="s"
                onchange={set(`A${i + 1}`)} moduleId={id} paramId={`A${i + 1}`} readLive={live(`A${i + 1}`)} />
              <Knob value={i === 0 ? D1 : i === 1 ? D2 : i === 2 ? D3 : D4}
                min={0.001} max={5} defaultValue={0.1} label="D" curve="log" units="s"
                onchange={set(`D${i + 1}`)} moduleId={id} paramId={`D${i + 1}`} readLive={live(`D${i + 1}`)} />
              <Knob value={i === 0 ? S1 : i === 1 ? S2 : i === 2 ? S3 : S4}
                min={0} max={1} defaultValue={0.7} label="S" curve="linear"
                onchange={set(`S${i + 1}`)} moduleId={id} paramId={`S${i + 1}`} readLive={live(`S${i + 1}`)} />
              <Knob value={i === 0 ? R1 : i === 1 ? R2 : i === 2 ? R3 : R4}
                min={0.001} max={5} defaultValue={0.5} label="R" curve="log" units="s"
                onchange={set(`R${i + 1}`)} moduleId={id} paramId={`R${i + 1}`} readLive={live(`R${i + 1}`)} />
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
                onchange={set(`fxAmount${i + 1}`)} moduleId={id} paramId={`fxAmount${i + 1}`} readLive={live(`fxAmount${i + 1}`)} />
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
          <Knob value={pos_z} min={-1} max={1} defaultValue={0} label="Height" curve="linear" onchange={set('pos_z')} moduleId={id} paramId="pos_z" readLive={live('pos_z')} />
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
          <!-- VIEW toggle cycles through three render modes:
               0 = PROXIMITY (3D ribbons, original render),
               1 = BIRDSEYE (top-down 2D floorplan showing the spatial
                   system: 4 emitter dots + camera marker + audio-energy
                   ripples),
               2 = SPECTROGRAPH (scrolling STFT of the combined audio
                   output — log-Hz vertical axis, time scrolling
                   right-to-left). 3D is the gorgeous default; BIRDSEYE
                   is useful when tweaking the camera; SPECTROGRAPH is
                   the dogfood audio-analysis view. -->
          <button
            type="button"
            class="unison-toggle view-toggle"
            class:on={Math.round(video_mode) !== 0}
            data-testid="wavesculpt-view-toggle"
            title="View mode: PROXIMITY (3D ribbons) / BIRDSEYE (top-down floorplan) / SPECTROGRAPH (scrolling STFT)"
            onclick={() => set('video_mode')((Math.round(video_mode) + 1) % 3)}
          >{Math.round(video_mode) === 0 ? '3D' : Math.round(video_mode) === 1 ? 'BIRDSEYE' : 'SPECTRO'}</button>
          <!-- BLINK cycles three render modes inside the 3D view:
               0 = (current) wavetable ribbons,
               1 = SCOPES TRIAL — live oscilloscope traces from the 4
                   floor corners aimed up+inward at 45°; WIDTH thickens
                   the scope line,
               2 = REALITY BASED COMMUNITY — same, as 3D neon tubes;
                   WIDTH sets the tube radius. -->
          <button
            type="button"
            class="unison-toggle blink-toggle"
            class:on={blink_mode !== 0}
            data-testid="wavesculpt-blink-toggle"
            title="BLINK render mode: current ribbons / SCOPES TRIAL / REALITY BASED COMMUNITY"
            onclick={() => set('blink_mode')((blink_mode + 1) % 3)}
          >BLINK</button>
          {#if blink_mode !== 0}
            <div class="blink-mode-name" data-testid="wavesculpt-blink-mode-name">{blinkModeName}</div>
          {/if}
          <!-- SCALE — amplitude/zoom of the BLINK scope waveform (reuses
               SCOPE's ch1Scale semantics: log 0.1..10, unity at 1). Applies
               in SCOPES TRIAL + REALITY BASED COMMUNITY. -->
          <Knob value={scale} min={0.1} max={10} defaultValue={1}
            label="Scale" curve="log"
            onchange={set('scale')} moduleId={id} paramId="scale" readLive={live('scale')} />
          <!-- WIGGLE — pitch-driven 3D rotation of each osc's line/tube/
               ribbon. 0 = OFF (fixed direction). Rotation speed + magnitude
               scale with each osc's pitch; this knob scales overall strength.
               Standard knob dial: min (OFF) lower-left, max lower-right. -->
          <Knob value={wiggle} min={0} max={1} defaultValue={0}
            label="Wiggle" curve="linear"
            onchange={set('wiggle')} moduleId={id} paramId="wiggle" readLive={live('wiggle')} />
          <button
            type="button"
            class="unison-toggle"
            class:on={unison >= 0.5}
            data-testid="wavesculpt-unison"
            onclick={() => set('unison')(unison >= 0.5 ? 0 : 1)}
          >UNISON</button>
          <Knob value={detune} min={-1} max={1} defaultValue={0} label="Detune" curve="linear" onchange={set('detune')} moduleId={id} paramId="detune" readLive={live('detune')} />
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
            onchange={set('alpha_brightness')} moduleId={id} paramId="alpha_brightness" readLive={live('alpha_brightness')}
          />
        </div>
      </div>

      <!-- Bottom: bentscreen wiggles -->
      <div class="bent-section">
        <div class="bent-label">BENTSCREEN WIGGLES</div>
        <div class="bent-grid">
          <Knob value={hsync_drift}        min={0}  max={1} defaultValue={0}    label="HS Drift"  curve="linear" onchange={set('hsync_drift')} moduleId={id} paramId="hsync_drift"        readLive={live('hsync_drift')} />
          <Knob value={hsync_loss}         min={0}  max={1} defaultValue={0}    label="HS Loss"   curve="linear" onchange={set('hsync_loss')} moduleId={id} paramId="hsync_loss"         readLive={live('hsync_loss')} />
          <Knob value={vsync_drift}        min={0}  max={1} defaultValue={0}    label="VS Drift"  curve="linear" onchange={set('vsync_drift')} moduleId={id} paramId="vsync_drift"        readLive={live('vsync_drift')} />
          <Knob value={scan_wobble}        min={0}  max={1} defaultValue={0}    label="Wobble"    curve="linear" onchange={set('scan_wobble')} moduleId={id} paramId="scan_wobble"        readLive={live('scan_wobble')} />
          <Knob value={chroma_phase}       min={-1} max={1} defaultValue={0}    label="Hue"       curve="linear" onchange={set('chroma_phase')} moduleId={id} paramId="chroma_phase"       readLive={live('chroma_phase')} />
          <Knob value={chroma_instability} min={0}  max={1} defaultValue={0}    label="Shimmer"   curve="linear" onchange={set('chroma_instability')} moduleId={id} paramId="chroma_instability" readLive={live('chroma_instability')} />
          <Knob value={feedback_gain}      min={0}  max={1} defaultValue={0}    label="Feedback"  curve="linear" onchange={set('feedback_gain')} moduleId={id} paramId="feedback_gain"      readLive={live('feedback_gain')} />
          <Knob value={feedback_delay}     min={0}  max={1} defaultValue={0}    label="Delay"     curve="linear" onchange={set('feedback_delay')} moduleId={id} paramId="feedback_delay"     readLive={live('feedback_delay')} />
          <Knob value={wavefold}           min={0}  max={1} defaultValue={0}    label="Wavefold"  curve="linear" onchange={set('wavefold')} moduleId={id} paramId="wavefold"           readLive={live('wavefold')} />
          <Knob value={bloom}              min={0}  max={1} defaultValue={0.4}  label="Bloom"     curve="linear" onchange={set('bloom')} moduleId={id} paramId="bloom"              readLive={live('bloom')} />
          <Knob value={noise}              min={0}  max={1} defaultValue={0.05} label="Noise"     curve="linear" onchange={set('noise')} moduleId={id} paramId="noise"              readLive={live('noise')} />
          <Knob value={master_gain}        min={0}  max={2} defaultValue={1}    label="Gain"      curve="linear" onchange={set('master_gain')} moduleId={id} paramId="master_gain"        readLive={live('master_gain')} />
        </div>
      </div>

      <!-- VIDEO WALLS — per-face transparency + convex distort. Each row
           pairs a TRANSPARENCY (0-100%) + DISTORT (flat→dome, 0-1) knob for
           one face. Patch a video module into the matching wall{N} input
           (handles in the patch panel) to texture that face; patch
           WAVESCULPT's own OUT back into a wall for recursive feedback. -->
      <div class="bent-section wall-section" data-testid="wavesculpt-wall-section">
        <div class="bent-label">VIDEO WALLS</div>
        <div class="wall-grid">
          {#each WALL_UI as w (w.n)}
            <div class="wall-cell" data-testid={`wavesculpt-wall-${w.n}`}>
              <div class="wall-face-label">W{w.n} · {w.face}</div>
              <div class="wall-knobs">
                <Knob value={wallAlpha(w.n)} min={0} max={100} defaultValue={100}
                  label="Alpha" units="%" curve="linear"
                  onchange={set(`wall${w.n}_alpha`)} moduleId={id} paramId={`wall${w.n}_alpha`} readLive={live(`wall${w.n}_alpha`)} />
                <Knob value={wallDistort(w.n)} min={0} max={1} defaultValue={0}
                  label="Distort" curve="linear"
                  onchange={set(`wall${w.n}_distort`)} moduleId={id} paramId={`wall${w.n}_distort`} readLive={live(`wall${w.n}_distort`)} />
              </div>
            </div>
          {/each}
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
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
  }
  .chroma-swatch-wrap {
    position: relative;
    display: inline-flex;
    align-items: center;
    cursor: pointer;
  }
  .chroma-swatch {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 1px solid var(--border, #2a2f3a);
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.4);
    display: inline-block;
  }
  .chroma-swatch-wrap:hover .chroma-swatch {
    border-color: var(--accent-dim, #6a7a9a);
  }
  .chroma-color-input {
    position: absolute;
    inset: 0;
    opacity: 0;
    width: 100%;
    height: 100%;
    cursor: pointer;
    border: 0;
    padding: 0;
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
  /* Active BLINK render-mode name, shown under the BLINK button. */
  .blink-mode-name {
    font-size: 0.55rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    line-height: 1.1;
    color: var(--accent, #6cf);
    text-align: center;
    max-width: 80px;
    word-break: break-word;
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
  .wall-section { margin-top: 6px; }
  .wall-grid {
    display: grid;
    grid-template-columns: repeat(6, 1fr);
    gap: 6px;
    margin-top: 4px;
  }
  .wall-cell {
    border: 1px solid var(--border-dim, rgba(255,255,255,0.08));
    border-radius: 2px;
    padding: 3px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    background: rgba(255,255,255,0.02);
  }
  .wall-face-label {
    font-size: 0.5rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    color: var(--text-dim);
    text-align: center;
  }
  .wall-knobs {
    display: flex;
    gap: 2px;
    justify-content: center;
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

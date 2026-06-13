<script lang="ts">
  // HypercubeCard — 4D tesseract oscillator UI (sibling of CubeCard).
  //
  // Cloned from CubeCard, extended for HYPERCUBE:
  //   • a FOURTH wavetable dropdown (HOLO) — auto via the HYPERCUBE_SLOTS loop.
  //   • an ALPHA knob + ALPHA CV port (the slice's 4th-dimension w coordinate).
  //   • the rendered field is the ALPHA-BLENDED tesseract cross-section
  //     (f4 = (1-alpha)·f3 + alpha·dH) so the picture matches the sound — the
  //     SHARED cube-dsp.fieldFromHeights handles the blend when given holoH +
  //     alpha (no-op when absent, so ALPHA=0 looks exactly like a 3-table CUBE).
  //   • SCHLEGEL TESSERACT viz: an inner cube (the HOLO / alpha=1 field) nested
  //     inside the outer cube (the alpha=0 field), with 8 connector edges — the
  //     classic cube-within-a-cube tesseract projection. The live selection slice
  //     plane lerps inward toward the inner cube as ALPHA rises (alpha = the w
  //     depth). rebuildVolume + cubeEdges are reused for both cubes.
  //
  // PatchPanel exposes EVERY input handle (pitch + 9 CVs incl. ALPHA) + the
  // L / R audio output handles + the video_out.

  import type { NodeProps } from '@xyflow/svelte';
  import { onDestroy, onMount } from 'svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import ModuleTitle from './ModuleTitle.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch, ydoc } from '$lib/graph/store';
  import { setNodeParam } from '$lib/graph/mutate';
  import { hypercubeDef, HYPERCUBE_SLOTS, HYPERCUBE_DEFAULT_TABLES, installHypercubeFrameDrawer, uninstallHypercubeFrameDrawer, type HypercubeSlot, type HypercubeData, type HypercubeSlotData } from '$lib/audio/modules/hypercube';
  import { getFactoryTables, framesToPlain } from '$lib/audio/wavetable-factory-tables';
  import { WAVETABLE_PRESETS, loadWavetablePreset } from '$lib/audio/wavetable-presets';
  import { parseE352Wav } from '$lib/audio/wavetable-parser';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import {
    columnHeights,
    fieldFromHeights,
    type FieldParams,
    type Material,
  } from '../../../../../dsp/src/lib/cube-dsp';

  const VIDEO_OUT_PORT_ID = 'video_out';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  const defaultFor = (pid: string): number =>
    hypercubeDef.params.find((p) => p.id === pid)!.defaultValue;
  const minFor = (pid: string): number => hypercubeDef.params.find((p) => p.id === pid)!.min;
  const maxFor = (pid: string): number => hypercubeDef.params.find((p) => p.id === pid)!.max;

  function paramVal(k: string): number {
    const v = node?.params?.[k];
    return typeof v === 'number' ? v : defaultFor(k);
  }
  const set = (pid: string) => (v: number) => {
    setNodeParam(id, pid, v);
  };
  const live = (pid: string) => () => {
    const e = engineCtx.get(); if (!e || !node) return undefined;
    return e.readParam(node, pid);
  };

  // ───────────────── toggles ─────────────────
  let wrapOn = $derived(paramVal('wrap') >= 0.5);
  let materialHard = $derived(paramVal('material') >= 0.5);
  function toggleWrap(): void { set('wrap')(wrapOn ? 0 : 1); }
  function toggleMaterial(): void { set('material')(materialHard ? 0 : 1); }

  // ───────────────── SCREEN on/off + downstream detection ─────────────────
  let screenOn = $derived(paramVal('screen_on') >= 0.5);
  function toggleScreen(): void { set('screen_on')(screenOn ? 0 : 1); }

  let edgesVersion = $state(0);
  let videoOutPatched = $derived<boolean>(
    (void edgesVersion,
      Object.values(patch.edges ?? {}).some(
        (e) => e?.source?.nodeId === id && e?.source?.portId === VIDEO_OUT_PORT_ID,
      )),
  );
  let vizActive = $derived<boolean>(screenOn || videoOutPatched);
  let edgesObserver: (() => void) | null = null;
  function attachEdgesObserver(): void {
    try {
      const edgesMap = ydoc.getMap('edges');
      const handler = (): void => { edgesVersion++; };
      edgesMap.observeDeep(handler);
      edgesObserver = () => { try { edgesMap.unobserveDeep(handler); } catch { /* */ } };
      edgesVersion++;
    } catch { /* ydoc unavailable (test env) — videoOutPatched stays false */ }
  }

  // ───────────────── per-slot wavetable selection (node.data) ─────────────────
  const SLOT_LABEL: Record<HypercubeSlot, string> = { floor: 'FLOOR', wall: 'WALL', ceiling: 'CEILING', holo: 'HOLO' };

  function slotData(slot: HypercubeSlot): HypercubeSlotData {
    const d = (node?.data ?? {}) as HypercubeData;
    return (d[slot] as HypercubeSlotData | undefined) ?? {};
  }
  function slotSelectValue(slot: HypercubeSlot): string {
    const sd = slotData(slot);
    if (sd.source === 'user') return 'user';
    return sd.source ?? `factory:${HYPERCUBE_DEFAULT_TABLES[slot]}`;
  }
  function slotLabel(slot: HypercubeSlot): string {
    const sd = slotData(slot);
    if (sd.source === 'user') return sd.label ?? 'USER';
    const src = sd.source ?? `factory:${HYPERCUBE_DEFAULT_TABLES[slot]}`;
    if (src.startsWith('factory:')) {
      const fid = src.slice('factory:'.length);
      return factoryTables.find((t) => t.id === fid)?.label ?? fid;
    }
    return src;
  }
  function slotTableSig(slot: HypercubeSlot): string {
    const sd = slotData(slot);
    return `${sd.source ?? `factory:${HYPERCUBE_DEFAULT_TABLES[slot]}`}:${sd.label ?? ''}:${sd.frames?.length ?? 0}`;
  }
  let tableSig = $derived(HYPERCUBE_SLOTS.map((s) => slotTableSig(s)).join('|'));

  let slotStatus = $state<Record<HypercubeSlot, string | null>>({ floor: null, wall: null, ceiling: null, holo: null });
  let presetSelection = $state<Record<HypercubeSlot, string>>({ floor: '', wall: '', ceiling: '', holo: '' });

  function ensureSlot(slot: HypercubeSlot): HypercubeSlotData | null {
    const t = patch.nodes[id];
    if (!t) return null;
    if (!t.data) t.data = {};
    const d = t.data as HypercubeData;
    if (!d[slot]) (d as Record<string, unknown>)[slot] = {};
    return d[slot] as HypercubeSlotData;
  }
  function selectFactory(slot: HypercubeSlot, factoryId: string): void {
    const sd = ensureSlot(slot); if (!sd) return;
    sd.source = `factory:${factoryId}`;
    delete sd.frames;
    delete sd.label;
    slotStatus[slot] = null;
  }
  async function selectPreset(slot: HypercubeSlot, presetId: string): Promise<void> {
    const preset = WAVETABLE_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    slotStatus[slot] = `loading ${preset.label}…`;
    try {
      const parsed = await loadWavetablePreset(preset.url);
      const sd = ensureSlot(slot); if (!sd) return;
      sd.source = 'user';
      sd.frames = parsed.frames;
      sd.label = preset.label;
      slotStatus[slot] = `loaded ${parsed.frames.length} frames`;
    } catch (err) {
      slotStatus[slot] = err instanceof Error ? err.message : String(err);
    } finally {
      presetSelection[slot] = '';
    }
  }
  function onPresetChange(slot: HypercubeSlot, ev: Event): void {
    const v = (ev.target as HTMLSelectElement).value;
    if (!v) return;
    void selectPreset(slot, v);
  }
  async function onSlotFileChange(slot: HypercubeSlot, ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    slotStatus[slot] = 'parsing…';
    try {
      const buf = await file.arrayBuffer();
      const parsed = parseE352Wav(buf);
      const sd = ensureSlot(slot); if (!sd) return;
      sd.source = 'user';
      sd.frames = framesToPlain(parsed.frames);
      sd.label = file.name.replace(/\.wav$/i, '').toUpperCase().slice(0, 24);
      slotStatus[slot] = `loaded ${parsed.frames.length} frames`;
    } catch (err) {
      slotStatus[slot] = err instanceof Error ? err.message : String(err);
    } finally {
      try { input.value = ''; } catch { /* */ }
    }
  }
  function onSlotChange(slot: HypercubeSlot, ev: Event): void {
    const sel = ev.target as HTMLSelectElement;
    const v = sel.value;
    if (v === 'user') return;
    if (v.startsWith('factory:')) selectFactory(slot, v.slice('factory:'.length));
    else if (v.startsWith('preset:')) void selectPreset(slot, v.slice('preset:'.length));
  }

  // ═══════════════ SCHLEGEL TESSERACT VISUALIZATION (WebGL2) ═══════════════
  //
  // Two nested cubes: the OUTER cube renders the alpha=0 field (the base 3-table
  // CUBE), the INNER cube (scaled toward the centre) renders the alpha=1 field
  // (fully HOLO-blended), with 8 connector edges between matching corners — the
  // classic Schlegel diagram of a tesseract. The volume slice-stack itself uses
  // the LIVE alpha-blended field so the picture matches the sound. The selection
  // slice plane lerps inward (toward the inner cube) as ALPHA rises.

  const RES = 320;
  const VOL = 24;
  const SLICE_LAYERS = 28;
  const INNER_SCALE = 0.5;       // Schlegel inner cube size (fraction of outer)
  let glCanvas = $state<HTMLCanvasElement | null>(null);
  let waveCanvas = $state<HTMLCanvasElement | null>(null);
  let sliceCanvas = $state<HTMLCanvasElement | null>(null);
  let raf: number | null = null;

  let offscreen: OffscreenCanvas | HTMLCanvasElement | null = null;
  let gl: WebGL2RenderingContext | null = null;
  let glReady = false;
  let glFailed = false;
  let volProgram: WebGLProgram | null = null;
  let planeProgram: WebGLProgram | null = null;
  let wireProgram: WebGLProgram | null = null;
  let quadBuf: WebGLBuffer | null = null;
  let layerBuf: WebGLBuffer | null = null;
  let wireBuf: WebGLBuffer | null = null;        // outer cube edges
  let innerWireBuf: WebGLBuffer | null = null;   // inner (Schlegel) cube edges
  let connectorBuf: WebGLBuffer | null = null;   // 8 corner-to-corner connectors
  let volTex: WebGLTexture | null = null;
  let lastFieldSig = '';
  let lastSceneSig = '';
  let renderedOnce = false;

  // ---- minimal mat4 helpers ----
  function m4Mul(out: Float32Array, a: Float32Array, b: Float32Array): void {
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!;
      out[c * 4 + r] = s;
    }
  }
  function m4Perspective(out: Float32Array, fovy: number, aspect: number, near: number, far: number): void {
    const f = 1 / Math.tan(fovy / 2);
    out.fill(0);
    out[0] = f / aspect; out[5] = f;
    out[10] = (far + near) / (near - far); out[11] = -1;
    out[14] = (2 * far * near) / (near - far);
  }
  function m4LookAt(out: Float32Array, eye: number[], tgt: number[], up: number[]): void {
    const zx = eye[0]! - tgt[0]!, zy = eye[1]! - tgt[1]!, zz = eye[2]! - tgt[2]!;
    const zl = Math.hypot(zx, zy, zz) || 1;
    const fz = [zx / zl, zy / zl, zz / zl];
    const rx = up[1]! * fz[2]! - up[2]! * fz[1]!;
    const ry = up[2]! * fz[0]! - up[0]! * fz[2]!;
    const rz = up[0]! * fz[1]! - up[1]! * fz[0]!;
    const rl = Math.hypot(rx, ry, rz) || 1;
    const r = [rx / rl, ry / rl, rz / rl];
    const ux = fz[1]! * r[2]! - fz[2]! * r[1]!;
    const uy = fz[2]! * r[0]! - fz[0]! * r[2]!;
    const uz = fz[0]! * r[1]! - fz[1]! * r[0]!;
    out[0] = r[0]!; out[1] = ux; out[2] = fz[0]!; out[3] = 0;
    out[4] = r[1]!; out[5] = uy; out[6] = fz[1]!; out[7] = 0;
    out[8] = r[2]!; out[9] = uz; out[10] = fz[2]!; out[11] = 0;
    out[12] = -(r[0]! * eye[0]! + r[1]! * eye[1]! + r[2]! * eye[2]!);
    out[13] = -(ux * eye[0]! + uy * eye[1]! + uz * eye[2]!);
    out[14] = -(fz[0]! * eye[0]! + fz[1]! * eye[1]! + fz[2]! * eye[2]!);
    out[15] = 1;
  }
  function eulerMat(out: Float32Array, rx: number, ry: number, rz: number): void {
    const cx = Math.cos(rx), sx = Math.sin(rx);
    const cy = Math.cos(ry), sy = Math.sin(ry);
    const cz = Math.cos(rz), sz = Math.sin(rz);
    const m00 = cy * cz, m01 = sx * sy * cz - cx * sz, m02 = cx * sy * cz + sx * sz;
    const m10 = cy * sz, m11 = sx * sy * sz + cx * cz, m12 = cx * sy * sz - sx * cz;
    const m20 = -sy,     m21 = sx * cy,                m22 = cx * cy;
    out[0] = m00; out[1] = m10; out[2] = m20; out[3] = 0;
    out[4] = m01; out[5] = m11; out[6] = m21; out[7] = 0;
    out[8] = m02; out[9] = m12; out[10] = m22; out[11] = 0;
    out[12] = 0;  out[13] = 0;  out[14] = 0;   out[15] = 1;
  }

  function compile(g: WebGL2RenderingContext, type: number, src: string): WebGLShader {
    const s = g.createShader(type)!;
    g.shaderSource(s, src); g.compileShader(s);
    if (!g.getShaderParameter(s, g.COMPILE_STATUS)) {
      const log = g.getShaderInfoLog(s) || '?';
      g.deleteShader(s); throw new Error('shader: ' + log);
    }
    return s;
  }
  function link(g: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
    const p = g.createProgram()!;
    g.attachShader(p, compile(g, g.VERTEX_SHADER, vs));
    g.attachShader(p, compile(g, g.FRAGMENT_SHADER, fs));
    g.linkProgram(p);
    if (!g.getProgramParameter(p, g.LINK_STATUS)) {
      const log = g.getProgramInfoLog(p) || '?';
      g.deleteProgram(p); throw new Error('link: ' + log);
    }
    return p;
  }

  const ATLAS_COLS = 5;
  const ATLAS_ROWS = Math.ceil(VOL / ATLAS_COLS);
  const ATLAS_W = ATLAS_COLS * VOL;
  const ATLAS_H = ATLAS_ROWS * VOL;

  const ATLAS_SAMPLE = `
    float atlasAt(sampler2D atlas, float zi, vec2 uv) {
      zi = clamp(zi, 0.0, ${(VOL - 1).toFixed(1)});
      float col = mod(zi, ${ATLAS_COLS.toFixed(1)});
      float row = floor(zi / ${ATLAS_COLS.toFixed(1)});
      vec2 cell = (vec2(col, row) + clamp(uv, 0.001, 0.999)) / vec2(${ATLAS_COLS.toFixed(1)}, ${ATLAS_ROWS.toFixed(1)});
      return texture(atlas, cell).r;
    }`;

  const VOL_VS = `#version 300 es
  precision highp float;
  in vec2 aQuad;
  in float aLayer;
  uniform mat4 uMVP;
  out vec2 vUV; out float vZ;
  void main(){
    float t = aLayer / ${(SLICE_LAYERS - 1).toFixed(1)};
    vUV = aQuad + 0.5;
    vZ = t;
    vec3 p = vec3(aQuad + 0.5, t);
    gl_Position = uMVP * vec4(p - 0.5, 1.0);
  }`;
  const VOL_FS = `#version 300 es
  precision highp float;
  in vec2 vUV; in float vZ;
  uniform sampler2D uAtlas;
  out vec4 frag;
  ${ATLAS_SAMPLE}
  void main(){
    float zi = vZ * ${(VOL - 1).toFixed(1)};
    float d = atlasAt(uAtlas, floor(zi + 0.5), vUV);
    if (d < 0.02) discard;
    // violet→white density ramp (distinguishes HYPERCUBE from CUBE's teal)
    vec3 col = mix(vec3(0.34,0.18,0.5), vec3(0.85,0.7,1.0), d);
    frag = vec4(col, d * 0.14);
  }`;

  const PLANE_VS = `#version 300 es
  precision highp float;
  in vec2 aQuad;
  uniform mat4 uMVP;
  uniform mat4 uRot;
  uniform float uSliceY;
  uniform float uShrink;   // ALPHA-driven inward lerp (Schlegel w-depth)
  out vec3 vPos;
  void main(){
    vec3 local = vec3(aQuad.x, aQuad.y, 0.0) * uShrink;
    vec3 world = (uRot * vec4(local, 1.0)).xyz + vec3(0.0, 0.0, uSliceY - 0.5) + vec3(0.5);
    vPos = world;
    // scale the whole plane toward the cube centre by uShrink (alpha → inner cube)
    vec3 centered = (world - 0.5) * uShrink;
    gl_Position = uMVP * vec4(centered, 1.0);
  }`;
  const PLANE_FS = `#version 300 es
  precision highp float;
  in vec3 vPos;
  uniform sampler2D uAtlas;
  out vec4 frag;
  ${ATLAS_SAMPLE}
  void main(){
    float zi = clamp(vPos.z, 0.0, 1.0) * ${(VOL - 1).toFixed(1)};
    float d = atlasAt(uAtlas, floor(zi + 0.5), clamp(vPos.xy, 0.0, 1.0));
    vec3 hot = mix(vec3(1.0,0.4,0.7), vec3(1.0,0.85,0.55), d);
    frag = vec4(hot, 0.42 + d * 0.4);
  }`;

  const WIRE_VS = `#version 300 es
  precision highp float;
  in vec3 aPos;
  uniform mat4 uMVP;
  void main(){ gl_Position = uMVP * vec4(aPos - 0.5, 1.0); }`;
  const WIRE_FS = `#version 300 es
  precision highp float;
  uniform vec4 uColor;
  out vec4 frag;
  void main(){ frag = uColor; }`;

  // Cube edges scaled about the centre (0.5,0.5,0.5) by `scale` — used for both
  // the outer (scale=1) and inner Schlegel (scale=INNER_SCALE) cubes.
  function cubeEdges(scale = 1): Float32Array {
    const c = [
      [0,0,0],[1,0,0],[1,1,0],[0,1,0],
      [0,0,1],[1,0,1],[1,1,1],[0,1,1],
    ].map(([x, y, z]) => [0.5 + (x! - 0.5) * scale, 0.5 + (y! - 0.5) * scale, 0.5 + (z! - 0.5) * scale]);
    const e = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
    const out: number[] = [];
    for (const [a, b] of e) { out.push(...c[a!]!, ...c[b!]!); }
    return new Float32Array(out);
  }
  // The 8 connector edges of a Schlegel tesseract: each outer corner → the
  // matching inner-cube corner.
  function connectorEdges(scale: number): Float32Array {
    const corners = [
      [0,0,0],[1,0,0],[1,1,0],[0,1,0],
      [0,0,1],[1,0,1],[1,1,1],[0,1,1],
    ];
    const out: number[] = [];
    for (const [x, y, z] of corners) {
      const inner = [0.5 + (x! - 0.5) * scale, 0.5 + (y! - 0.5) * scale, 0.5 + (z! - 0.5) * scale];
      out.push(x!, y!, z!, ...inner);
    }
    return new Float32Array(out);
  }

  function initGl(): boolean {
    if (glFailed) return false;
    try {
      if (typeof OffscreenCanvas !== 'undefined') offscreen = new OffscreenCanvas(RES, RES);
      else if (typeof document !== 'undefined') {
        const c = document.createElement('canvas'); c.width = RES; c.height = RES; offscreen = c;
      } else return false;
      gl = offscreen.getContext('webgl2', { alpha: false, antialias: true, premultipliedAlpha: false }) as WebGL2RenderingContext | null;
      if (!gl) { glFailed = true; return false; }
      const g = gl;
      volProgram = link(g, VOL_VS, VOL_FS);
      planeProgram = link(g, PLANE_VS, PLANE_FS);
      wireProgram = link(g, WIRE_VS, WIRE_FS);

      quadBuf = g.createBuffer();
      g.bindBuffer(g.ARRAY_BUFFER, quadBuf);
      g.bufferData(g.ARRAY_BUFFER, new Float32Array([-0.5,-0.5, 0.5,-0.5, -0.5,0.5, 0.5,0.5]), g.STATIC_DRAW);

      const layers = new Float32Array(SLICE_LAYERS);
      for (let i = 0; i < SLICE_LAYERS; i++) layers[i] = i;
      layerBuf = g.createBuffer();
      g.bindBuffer(g.ARRAY_BUFFER, layerBuf);
      g.bufferData(g.ARRAY_BUFFER, layers, g.STATIC_DRAW);

      wireBuf = g.createBuffer();
      g.bindBuffer(g.ARRAY_BUFFER, wireBuf);
      g.bufferData(g.ARRAY_BUFFER, cubeEdges(1), g.STATIC_DRAW);

      innerWireBuf = g.createBuffer();
      g.bindBuffer(g.ARRAY_BUFFER, innerWireBuf);
      g.bufferData(g.ARRAY_BUFFER, cubeEdges(INNER_SCALE), g.STATIC_DRAW);

      connectorBuf = g.createBuffer();
      g.bindBuffer(g.ARRAY_BUFFER, connectorBuf);
      g.bufferData(g.ARRAY_BUFFER, connectorEdges(INNER_SCALE), g.STATIC_DRAW);

      volTex = g.createTexture();
      g.bindTexture(g.TEXTURE_2D, volTex);
      g.texImage2D(g.TEXTURE_2D, 0, g.R8, ATLAS_W, ATLAS_H, 0, g.RED, g.UNSIGNED_BYTE, null);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);

      glReady = true;
      return true;
    } catch (err) {
      console.warn('[hypercube] WebGL2 init failed; falling back to 2D', err);
      glFailed = true; glReady = false;
      return false;
    }
  }

  // Rebuild the field volume atlas from the live shaping params + 4 loaded
  // tables. `fp` carries the ALPHA + the holo frames are read here so the
  // rendered field is the ALPHA-BLENDED tesseract cross-section (picture matches
  // the sound — fieldFromHeights handles the blend, no-op at alpha=0 / no holo).
  function rebuildVolume(g: WebGL2RenderingContext, fp: FieldParams): boolean {
    const e = engineCtx.get();
    const fr = (e && node ? e.read(node, 'frames') as
      { floor: Float32Array[]; wall: Float32Array[]; ceiling: Float32Array[]; holo: Float32Array[] } | undefined : undefined);
    if (!fr || !fr.floor.length || !fr.wall.length || !fr.ceiling.length || !fr.holo.length) return false;
    const atlas = new Uint8Array(ATLAS_W * ATLAS_H);
    const denom = VOL - 1;
    for (let zi = 0; zi < VOL; zi++) {
      const cellCol = zi % ATLAS_COLS;
      const cellRow = Math.floor(zi / ATLAS_COLS);
      const z = zi / denom;
      for (let yi = 0; yi < VOL; yi++) {
        const y = yi / denom;
        for (let xi = 0; xi < VOL; xi++) {
          const x = xi / denom;
          const h = columnHeights(fr.floor, fr.wall, fr.ceiling, x, y, fr.holo);
          const d = fieldFromHeights(z, h, fp); // [0,1], alpha-blended
          const px = cellCol * VOL + xi;
          const py = cellRow * VOL + yi;
          atlas[py * ATLAS_W + px] = Math.max(0, Math.min(255, Math.round(d * 255)));
        }
      }
    }
    g.bindTexture(g.TEXTURE_2D, volTex);
    g.pixelStorei(g.UNPACK_ALIGNMENT, 1);
    g.texSubImage2D(g.TEXTURE_2D, 0, 0, 0, ATLAS_W, ATLAS_H, g.RED, g.UNSIGNED_BYTE, atlas);
    return true;
  }

  function liveParam(pid: string, fallback: number): number {
    const e = engineCtx.get();
    if (e && node) { const v = e.readParam(node, pid); if (typeof v === 'number') return v; }
    return paramVal(pid) ?? fallback;
  }

  const projMat = new Float32Array(16);
  const viewMat = new Float32Array(16);
  const mvpMat = new Float32Array(16);
  const rotMat = new Float32Array(16);

  function drawWire(g: WebGL2RenderingContext, buf: WebGLBuffer | null, count: number, color: [number, number, number, number]): void {
    if (!buf) return;
    g.uniform4f(g.getUniformLocation(wireProgram!, 'uColor'), color[0], color[1], color[2], color[3]);
    const wq = g.getAttribLocation(wireProgram!, 'aPos');
    g.bindBuffer(g.ARRAY_BUFFER, buf);
    g.enableVertexAttribArray(wq); g.vertexAttribPointer(wq, 3, g.FLOAT, false, 0, 0);
    g.drawArrays(g.LINES, 0, count);
  }

  function renderGl(force = false): boolean {
    if (!gl || !glReady) return false;
    const g = gl;

    const morphFC = liveParam('morph_fc', 0);
    const connect = liveParam('connect', 0);
    const materialHardV = liveParam('material', 0) >= 0.5;
    const alpha = Math.max(0, Math.min(1, liveParam('alpha', 0)));
    const fp: FieldParams = { morphFC, connect, alpha, material: (materialHardV ? 'hard' : 'smooth') as Material };
    const sliceY = liveParam('slice_y', 0.5);
    const srx = liveParam('slice_rx', 0), sry = liveParam('slice_ry', 0), srz = liveParam('slice_rz', 0);

    const zoom = Math.max(0.3, Math.min(3, liveParam('view_zoom', 1)));
    const vrx = liveParam('view_rot_x', 0.6), vry = liveParam('view_rot_y', 0.7);

    const tsig = tableSig;
    const q = (v: number) => Math.round(v * 1000);
    const sceneSig =
      `${q(morphFC)}|${q(connect)}|${materialHardV ? 1 : 0}|${q(alpha)}|${q(sliceY)}|` +
      `${q(srx)}|${q(sry)}|${q(srz)}|${q(zoom)}|${q(vrx)}|${q(vry)}|${tsig}`;
    if (!force && renderedOnce && sceneSig === lastSceneSig) return false;
    lastSceneSig = sceneSig;

    // Field sig folds in ALPHA (the blended field changes with it).
    const fsig = `${q(morphFC)}|${q(connect)}|${materialHardV ? 1 : 0}|${q(alpha)}|${tsig}`;
    if (fsig !== lastFieldSig) {
      if (rebuildVolume(g, fp)) lastFieldSig = fsig;
      else lastSceneSig = '';
    }

    const dist = 2.6 / zoom;
    const ex = dist * Math.cos(vrx) * Math.sin(vry);
    const ey = dist * Math.sin(vrx);
    const ez = dist * Math.cos(vrx) * Math.cos(vry);

    const vizAspect = glCanvas ? glCanvas.width / glCanvas.height : 1.0;
    m4Perspective(projMat, 1.0, vizAspect, 0.05, 20.0);
    m4LookAt(viewMat, [ex, ey, ez], [0, 0, 0], [0, 1, 0]);
    m4Mul(mvpMat, projMat, viewMat);
    eulerMat(rotMat, srx, sry, srz);

    g.bindFramebuffer(g.FRAMEBUFFER, null);
    g.viewport(0, 0, RES, RES);
    g.clearColor(0.05, 0.04, 0.08, 1);
    g.clear(g.COLOR_BUFFER_BIT | g.DEPTH_BUFFER_BIT);
    g.enable(g.BLEND);
    g.blendFunc(g.SRC_ALPHA, g.ONE_MINUS_SRC_ALPHA);
    g.disable(g.DEPTH_TEST);

    g.activeTexture(g.TEXTURE0);
    g.bindTexture(g.TEXTURE_2D, volTex);

    // 1) volume slice stack (the alpha-blended field)
    g.useProgram(volProgram);
    g.uniformMatrix4fv(g.getUniformLocation(volProgram!, 'uMVP'), false, mvpMat);
    g.uniform1i(g.getUniformLocation(volProgram!, 'uAtlas'), 0);
    const vq = g.getAttribLocation(volProgram!, 'aQuad');
    const vl = g.getAttribLocation(volProgram!, 'aLayer');
    g.bindBuffer(g.ARRAY_BUFFER, quadBuf);
    g.enableVertexAttribArray(vq); g.vertexAttribPointer(vq, 2, g.FLOAT, false, 0, 0); g.vertexAttribDivisor(vq, 0);
    g.bindBuffer(g.ARRAY_BUFFER, layerBuf);
    g.enableVertexAttribArray(vl); g.vertexAttribPointer(vl, 1, g.FLOAT, false, 0, 0); g.vertexAttribDivisor(vl, 1);
    g.drawArraysInstanced(g.TRIANGLE_STRIP, 0, 4, SLICE_LAYERS);
    g.vertexAttribDivisor(vl, 0);

    // 2) the live selection slice plane — lerps inward (toward the inner cube)
    //    by ALPHA: shrink from full size (alpha=0) to INNER_SCALE (alpha=1).
    const shrink = 1 - (1 - INNER_SCALE) * alpha;
    g.useProgram(planeProgram);
    g.uniformMatrix4fv(g.getUniformLocation(planeProgram!, 'uMVP'), false, mvpMat);
    g.uniformMatrix4fv(g.getUniformLocation(planeProgram!, 'uRot'), false, rotMat);
    g.uniform1f(g.getUniformLocation(planeProgram!, 'uSliceY'), sliceY);
    g.uniform1f(g.getUniformLocation(planeProgram!, 'uShrink'), shrink);
    g.uniform1i(g.getUniformLocation(planeProgram!, 'uAtlas'), 0);
    const pq = g.getAttribLocation(planeProgram!, 'aQuad');
    g.bindBuffer(g.ARRAY_BUFFER, quadBuf);
    g.enableVertexAttribArray(pq); g.vertexAttribPointer(pq, 2, g.FLOAT, false, 0, 0);
    g.drawArrays(g.TRIANGLE_STRIP, 0, 4);

    // 3) the Schlegel tesseract: outer cube + inner cube + 8 connectors.
    g.useProgram(wireProgram);
    g.uniformMatrix4fv(g.getUniformLocation(wireProgram!, 'uMVP'), false, mvpMat);
    drawWire(g, wireBuf, 24, [0.7, 0.6, 0.9, 0.55]);          // outer (alpha=0 field)
    drawWire(g, innerWireBuf, 24, [1.0, 0.55, 0.85, 0.5 + 0.4 * alpha]); // inner (HOLO)
    drawWire(g, connectorBuf, 16, [0.6, 0.5, 0.8, 0.18 + 0.4 * alpha]);  // connectors

    renderedOnce = true;
    if (glCanvas && screenOn) blitCube(glCanvas);
    else if (glCanvas && !screenOn) { screenOffPainted = false; paintScreenOff(); }
    return true;
  }

  function blitCube(target: OffscreenCanvas | HTMLCanvasElement): void {
    if (!offscreen) return;
    const c2d = target.getContext('2d') as
      | CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!c2d) return;
    c2d.clearRect(0, 0, target.width, target.height);
    c2d.drawImage(offscreen as CanvasImageSource, 0, 0, target.width, target.height);
    c2d.fillStyle = 'rgba(255,255,255,0.55)';
    c2d.font = '9px monospace';
    c2d.fillText('HYPERCUBE', 5, 12);
  }

  function drawWave(c: HTMLCanvasElement, wave: Float32Array): void {
    const ctx2d = c.getContext('2d'); if (!ctx2d) return;
    const W = c.width, H = c.height;
    ctx2d.fillStyle = '#0c0a12'; ctx2d.fillRect(0, 0, W, H);
    ctx2d.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx2d.beginPath(); ctx2d.moveTo(0, H / 2); ctx2d.lineTo(W, H / 2); ctx2d.stroke();
    ctx2d.strokeStyle = '#c79bff'; ctx2d.lineWidth = 1.5;
    ctx2d.beginPath();
    const n = wave.length;
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * W;
      const y = H / 2 - (wave[i] ?? 0) * (H / 2) * 0.92;
      if (i === 0) ctx2d.moveTo(x, y); else ctx2d.lineTo(x, y);
    }
    ctx2d.stroke();
    ctx2d.fillStyle = 'rgba(255,255,255,0.5)'; ctx2d.font = '9px monospace';
    ctx2d.fillText('OUTPUT', 5, 12);
  }

  // ───────────────── 2D SLICE cross-section heatmap (alpha-blended) ─────────────────
  const SLICE_RES = 56;
  let sliceImage: ImageData | null = null;
  let lastSliceSig = '';
  let slicePainted = false;
  let sliceScratch: HTMLCanvasElement | OffscreenCanvas | null = null;

  function rotateVec(
    x: number, y: number, z: number, rx: number, ry: number, rz: number,
  ): [number, number, number] {
    const cx = Math.cos(rx), sx = Math.sin(rx);
    const cy = Math.cos(ry), sy = Math.sin(ry);
    const cz = Math.cos(rz), sz = Math.sin(rz);
    const x1 = x, y1 = y * cx - z * sx, z1 = y * sx + z * cx;
    const x2 = x1 * cy + z1 * sy, y2 = y1, z2 = -x1 * sy + z1 * cy;
    const x3 = x2 * cz - y2 * sz, y3 = x2 * sz + y2 * cz, z3 = z2;
    return [x3, y3, z3];
  }

  function drawSlice(c: HTMLCanvasElement): void {
    const ctx2d = c.getContext('2d'); if (!ctx2d) return;
    const W = c.width, H = c.height;
    const e = engineCtx.get();
    const fr = (e && node ? e.read(node, 'frames') as
      { floor: Float32Array[]; wall: Float32Array[]; ceiling: Float32Array[]; holo: Float32Array[] } | undefined : undefined);
    if (!fr || !fr.floor.length || !fr.wall.length || !fr.ceiling.length || !fr.holo.length) {
      ctx2d.fillStyle = '#0c0a12'; ctx2d.fillRect(0, 0, W, H);
      return;
    }
    const morphFC = liveParam('morph_fc', 0);
    const connect = liveParam('connect', 0);
    const materialHardV = liveParam('material', 0) >= 0.5;
    const alpha = Math.max(0, Math.min(1, liveParam('alpha', 0)));
    const sliceY = liveParam('slice_y', 0.5);
    const srx = liveParam('slice_rx', 0), sry = liveParam('slice_ry', 0), srz = liveParam('slice_rz', 0);
    const fp: FieldParams = { morphFC, connect, alpha, material: (materialHardV ? 'hard' : 'smooth') as Material };

    const sig = `${morphFC.toFixed(3)}|${connect.toFixed(3)}|${materialHardV ? 1 : 0}|${alpha.toFixed(3)}|` +
      `${sliceY.toFixed(3)}|${srx.toFixed(3)}|${sry.toFixed(3)}|${srz.toFixed(3)}|${tableSig}`;
    if (sig === lastSliceSig && slicePainted && sliceImage) return;
    if (sig !== lastSliceSig || !sliceImage) {
      const img = ctx2d.createImageData(SLICE_RES, SLICE_RES);
      for (let sv = 0; sv < SLICE_RES; sv++) {
        const py = 0.5 - sv / (SLICE_RES - 1);
        for (let su = 0; su < SLICE_RES; su++) {
          const px = su / (SLICE_RES - 1) - 0.5;
          const [rxv, ryv, rzv] = rotateVec(px, py, 0, srx, sry, srz);
          const x = rxv + 0.5, y = ryv + 0.5, z = rzv + sliceY;
          let d = 0;
          if (x >= 0 && x <= 1 && y >= 0 && y <= 1 && z >= 0 && z <= 1) {
            const h = columnHeights(fr.floor, fr.wall, fr.ceiling, x, y, fr.holo);
            d = fieldFromHeights(z, h, fp);
          }
          const r = 0.34 + (0.85 - 0.34) * d;
          const g = 0.18 + (0.7 - 0.18) * d;
          const b = 0.5 + (1.0 - 0.5) * d;
          const o = (sv * SLICE_RES + su) * 4;
          img.data[o] = Math.round(r * 255 * (0.15 + 0.85 * d));
          img.data[o + 1] = Math.round(g * 255 * (0.15 + 0.85 * d));
          img.data[o + 2] = Math.round(b * 255 * (0.15 + 0.85 * d));
          img.data[o + 3] = 255;
        }
      }
      sliceImage = img;
      lastSliceSig = sig;
    }

    if (!sliceScratch) {
      sliceScratch = typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(SLICE_RES, SLICE_RES)
        : (() => { const cc = document.createElement('canvas'); cc.width = SLICE_RES; cc.height = SLICE_RES; return cc; })();
    }
    const sctx = sliceScratch.getContext('2d') as
      | CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (sctx && sliceImage) {
      sctx.putImageData(sliceImage, 0, 0);
      ctx2d.imageSmoothingEnabled = true;
      ctx2d.drawImage(sliceScratch as CanvasImageSource, 0, 0, W, H);
    }
    ctx2d.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx2d.strokeRect(0.5, 0.5, W - 1, H - 1);
    ctx2d.fillStyle = 'rgba(255,255,255,0.6)'; ctx2d.font = '9px monospace';
    ctx2d.fillText('SLICE', 5, 12);
    slicePainted = true;
  }

  function videoFrame(canvas: OffscreenCanvas | HTMLCanvasElement): void {
    if (!glReady && !glFailed) initGl();
    if (!glReady) {
      const c2d = canvas.getContext('2d') as
        | CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
      if (c2d) { c2d.fillStyle = '#0c0a12'; c2d.fillRect(0, 0, canvas.width, canvas.height); }
      return;
    }
    renderGl(true);
    blitCube(canvas);
  }

  let screenOffPainted = false;
  function paintScreenOff(): void {
    if (screenOffPainted || !glCanvas) return;
    const c2d = glCanvas.getContext('2d') as CanvasRenderingContext2D | null;
    if (!c2d) return;
    c2d.fillStyle = '#0c0a12';
    c2d.fillRect(0, 0, glCanvas.width, glCanvas.height);
    c2d.fillStyle = 'rgba(255,255,255,0.28)';
    c2d.font = '11px monospace';
    c2d.fillText('SCREEN OFF', 10, 20);
    screenOffPainted = true;
  }

  const VIZ_FRAME_MS = 1000 / 30;
  let lastFrameTs = 0;
  let lastSnapRef: Float32Array | null = null;

  $effect(() => {
    if (!glReady && !glFailed) initGl();
    if (id) installHypercubeFrameDrawer(id, videoFrame);
    void vizActive;
    lastSceneSig = '';
    lastSliceSig = '';
    slicePainted = false;
    screenOffPainted = false;
    lastSnapRef = null;
    function tick(ts: number) {
      raf = requestAnimationFrame(tick);
      if (!vizActive) {
        paintScreenOff();
        return;
      }
      if (ts - lastFrameTs < VIZ_FRAME_MS) return;
      lastFrameTs = ts;
      if (glReady) renderGl();
      const e = engineCtx.get();
      if (e && node) {
        if (screenOn) {
          const snap = e.read(node, 'snapshot') as Float32Array | undefined;
          if (snap && snap !== lastSnapRef && waveCanvas) {
            drawWave(waveCanvas, snap);
            lastSnapRef = snap;
          }
          if (sliceCanvas) drawSlice(sliceCanvas);
        }
      }
    }
    raf = requestAnimationFrame(tick);
    return () => { if (raf !== null) cancelAnimationFrame(raf); raf = null; };
  });
  function disposeGl(): void {
    if (!gl) return;
    try {
      if (volProgram) gl.deleteProgram(volProgram);
      if (planeProgram) gl.deleteProgram(planeProgram);
      if (wireProgram) gl.deleteProgram(wireProgram);
      if (quadBuf) gl.deleteBuffer(quadBuf);
      if (layerBuf) gl.deleteBuffer(layerBuf);
      if (wireBuf) gl.deleteBuffer(wireBuf);
      if (innerWireBuf) gl.deleteBuffer(innerWireBuf);
      if (connectorBuf) gl.deleteBuffer(connectorBuf);
      if (volTex) gl.deleteTexture(volTex);
    } catch { /* */ }
    gl = null; offscreen = null; glReady = false;
  }
  onMount(() => {
    attachEdgesObserver();
  });
  onDestroy(() => {
    if (raf !== null) cancelAnimationFrame(raf);
    if (id) uninstallHypercubeFrameDrawer(id);
    if (edgesObserver) { edgesObserver(); edgesObserver = null; }
    disposeGl();
  });

  // ───────────────── patch panel ports ─────────────────
  const inputs: PortDescriptor[] = [
    { id: 'pitch',    label: 'PITCH',   cable: 'cv' },
    { id: 'slice_y',  label: 'Y',       cable: 'cv' },
    { id: 'slice_rx', label: 'ROT X',   cable: 'cv' },
    { id: 'slice_ry', label: 'ROT Y',   cable: 'cv' },
    { id: 'slice_rz', label: 'ROT Z',   cable: 'cv' },
    { id: 'morph_fc', label: 'MORPH',   cable: 'cv' },
    { id: 'connect',  label: 'CONNECT', cable: 'cv' },
    { id: 'crush',    label: 'CRUSH',   cable: 'cv' },
    { id: 'fold_cv',  label: 'FOLD',    cable: 'cv' },
    { id: 'alpha',    label: 'ALPHA',   cable: 'cv' },
    { id: 'tune',     label: 'TUNE',    cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'L', label: 'L', cable: 'audio' },
    { id: 'R', label: 'R', cable: 'audio' },
    { id: 'video_out', label: 'VIDEO', cable: 'mono-video' },
  ];

  const factoryTables = getFactoryTables();

  const KNOBS: Array<{ pid: string; label: string; units?: string }> = [
    { pid: 'tune', label: 'Tune', units: 'st' },
    { pid: 'fine', label: 'Fine', units: '¢' },
    { pid: 'morph_fc', label: 'Morph' },
    { pid: 'connect', label: 'Connect' },
    { pid: 'crush', label: 'Crush' },
    { pid: 'fold', label: 'Fold' },
    { pid: 'alpha', label: 'Alpha' },
    { pid: 'spread', label: 'Spread' },
    { pid: 'slice_y', label: 'Y' },
    { pid: 'slice_rx', label: 'Rot X' },
    { pid: 'slice_ry', label: 'Rot Y' },
    { pid: 'slice_rz', label: 'Rot Z' },
    { pid: 'level', label: 'Level' },
  ];
  const VIEW_KNOBS: Array<{ pid: string; label: string }> = [
    { pid: 'view_zoom', label: 'Zoom' },
    { pid: 'view_rot_x', label: 'View X' },
    { pid: 'view_rot_y', label: 'View Y' },
    { pid: 'view_rot_z', label: 'View Z' },
  ];
</script>

<div class="mod-card hypercube-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <ModuleTitle {id} {data} defaultLabel="HYPERCUBE" />

  <PatchPanel nodeId={id} {inputs} {outputs} panelWidth={360}>
    <div class="cube-body">
      <!-- LEFT column: the tesseract viewport (+ SLICE / OUTPUT) and the four
           wavetable source selectors. RIGHT column: toggles, knobs, view. -->
      <div class="cube-col cube-col-left">
      <div class="viz-col">
        <canvas
          bind:this={glCanvas}
          class="viz cube-viz"
          width={320}
          height={260}
          data-testid="hypercube-3d-viz"
        ></canvas>
        <div class="viz-row">
          <canvas
            bind:this={sliceCanvas}
            class="viz slice-viz"
            width={150}
            height={120}
            data-testid="hypercube-slice-viz"
          ></canvas>
          <canvas
            bind:this={waveCanvas}
            class="viz wave-viz"
            width={162}
            height={120}
            data-testid="hypercube-wave-viz"
          ></canvas>
        </div>
      </div>

      <div class="wt-selects">
        {#each HYPERCUBE_SLOTS as slot (slot)}
          <div class="wt-row">
            <span class="wt-label">{SLOT_LABEL[slot]}</span>
            <select
              class="wt-select"
              value={slotSelectValue(slot)}
              onchange={(ev) => onSlotChange(slot, ev)}
              data-testid={`hypercube-${slot}-select`}
            >
              {#each factoryTables as t (t.id)}
                <option value={`factory:${t.id}`}>{t.label}</option>
              {/each}
              {#if slotSelectValue(slot) === 'user'}
                <option value="user">USER · {slotLabel(slot)}</option>
              {/if}
            </select>
            <select
              class="wt-select preset-select"
              value={presetSelection[slot]}
              onchange={(ev) => onPresetChange(slot, ev)}
              data-testid={`hypercube-${slot}-preset-select`}
            >
              <option value="">— preset —</option>
              {#each WAVETABLE_PRESETS as p (p.id)}
                <option value={p.id}>{p.label}</option>
              {/each}
            </select>
            <label class="upload-btn" data-testid={`hypercube-${slot}-load`}>
              <input
                type="file"
                accept=".wav,audio/wav"
                onchange={(ev) => onSlotFileChange(slot, ev)}
              />
              <span>LOAD</span>
            </label>
            {#if slotStatus[slot]}
              <span class="wt-status">{slotStatus[slot]}</span>
            {/if}
          </div>
        {/each}
      </div>
      </div>

      <div class="cube-col cube-col-right">
      <div class="toggles">
        <button
          class="toggle"
          class:on={wrapOn}
          onclick={toggleWrap}
          data-testid="hypercube-wrap-toggle"
          title="WRAP: out-of-cube slice is silent (off) or mirror-folds back in (on)"
        >WRAP: {wrapOn ? 'ON' : 'OFF'}</button>
        <button
          class="toggle"
          class:on={materialHard}
          onclick={toggleMaterial}
          data-testid="hypercube-material-toggle"
          title="MATERIAL: SMOOTH (continuous density) or HARD (binary solid)"
        >MAT: {materialHard ? 'HARD' : 'SMOOTH'}</button>
        <button
          class="toggle"
          class:on={screenOn}
          onclick={toggleScreen}
          data-testid="hypercube-screen-toggle"
          title="SCREEN: turn the viz OFF to save performance. When OFF and VIDEO is unpatched, ALL visual computation is skipped (audio keeps running)."
        >SCRN: {screenOn ? 'ON' : 'OFF'}</button>
      </div>

      <div class="knobs">
        {#each KNOBS as k (k.pid)}
          <Knob
            value={paramVal(k.pid)}
            min={minFor(k.pid)}
            max={maxFor(k.pid)}
            defaultValue={defaultFor(k.pid)}
            label={k.label}
            units={k.units}
            curve="linear"
            onchange={set(k.pid)}
            moduleId={id}
            paramId={k.pid}
            readLive={live(k.pid)}
          />
        {/each}
      </div>

      <div class="view-section">
        <div class="view-head">VIEW (visualization only)</div>
        <div class="knobs view-knobs">
          {#each VIEW_KNOBS as k (k.pid)}
            <Knob
              value={paramVal(k.pid)}
              min={minFor(k.pid)}
              max={maxFor(k.pid)}
              defaultValue={defaultFor(k.pid)}
              label={k.label}
              curve={k.pid === 'view_zoom' ? 'log' : 'linear'}
              onchange={set(k.pid)}
              moduleId={id}
              paramId={k.pid}
              readLive={live(k.pid)}
            />
          {/each}
        </div>
      </div>
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .hypercube-card {
    width: 360px;
    background: var(--hypercube-bg, #15121d);
    color: #ece8e2;
  }
  /* 2-column layout for the wide (4hp) rack box: viewport + sources on the
     left, controls on the right. */
  .cube-body { padding: 6px 10px 8px; display: flex; flex-direction: row; gap: 14px; align-items: flex-start; }
  .cube-col { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  .cube-col-left { flex: 0 0 auto; }
  .cube-col-right { flex: 1 1 340px; min-width: 320px; }
  .viz-col { display: flex; flex-direction: column; gap: 6px; align-items: center; }
  .viz-row { display: flex; gap: 6px; justify-content: center; }
  .viz { border-radius: 4px; background: #0c0a12; border: 1px solid rgba(255,255,255,0.08); }
  .cube-viz { width: 320px; height: 260px; image-rendering: auto; }
  .slice-viz { width: 150px; height: 120px; image-rendering: auto; }
  .wave-viz { width: 162px; height: 120px; }
  .wt-selects { display: flex; flex-direction: column; gap: 4px; }
  .wt-row { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
  .wt-label {
    font-family: var(--font-mono, monospace);
    font-size: 0.6rem; letter-spacing: 0.04em; color: #b9a6d6;
    width: 52px; flex: none;
  }
  .wt-select {
    flex: 1; min-width: 80px; font-size: 0.62rem; background: #1f1b29; color: #ece8e2;
    border: 1px solid rgba(255,255,255,0.12); border-radius: 3px; padding: 2px 4px;
  }
  .preset-select { flex: 0 1 96px; min-width: 70px; }
  .upload-btn {
    flex: none; display: inline-flex; align-items: center; cursor: pointer;
    font-family: var(--font-mono, monospace); font-size: 0.55rem; color: #b9a6d6;
    background: #1f1b29; border: 1px solid rgba(255,255,255,0.14);
    border-radius: 3px; padding: 2px 6px;
  }
  .upload-btn input[type='file'] { display: none; }
  .upload-btn:hover { background: #2a2438; color: #e9d9ff; }
  .wt-status { font-size: 0.52rem; color: #a07fd6; white-space: nowrap; max-width: 100%; overflow: hidden; text-overflow: ellipsis; flex-basis: 100%; }
  .toggles { display: flex; gap: 8px; }
  .toggle {
    flex: 1; font-family: var(--font-mono, monospace); font-size: 0.6rem;
    padding: 4px 6px; border-radius: 3px; cursor: pointer;
    background: #1f1b29; color: #b9a6d6; border: 1px solid rgba(255,255,255,0.14);
  }
  .toggle.on { background: #4a2f74; color: #e9d9ff; border-color: #8a5cc0; }
  .knobs { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-end; justify-content: flex-start; }
  .view-section { border-top: 1px solid rgba(255,255,255,0.08); padding-top: 6px; }
  .view-head { font-family: var(--font-mono, monospace); font-size: 0.55rem; letter-spacing: 0.04em; color: #948294; margin-bottom: 4px; }
  .view-knobs { gap: 12px; }
</style>

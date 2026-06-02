<script lang="ts">
  // CubeCard — 3D wavetable-navigator oscillator UI (slice 4).
  //
  // Controls:
  //   • 3 wavetable dropdowns (FLOOR / WALL / CEILING), each picking a factory
  //     table or a baked preset (reuses WAVESCULPT's loader + list — writes
  //     node.data[slot] so the cube factory's poll loop posts loadWavetable).
  //   • Knobs: TUNE / FINE / MORPH / CONNECT / CRUSH / SPREAD / Y /
  //     ROT X / ROT Y / ROT Z / LEVEL.
  //   • Toggles: WRAP (silent↔mirror-fold), MATERIAL (SMOOTH↔HARD).
  //   • View-only camera: ZOOM / VIEW X / VIEW Y / VIEW Z — transform the
  //     visualization only (no effect on sound or selected slice).
  //
  // Visualization (issue #2): an actual rotatable 3D WebGL2 render of the CUBE.
  //   The scalar field ("the cube" — the floor/wall/ceiling morph volume) is
  //   sampled on the CPU into a small voxel volume and drawn as a back-to-front
  //   alpha-blended stack of axis-aligned Z-slices (translucent voxel volume).
  //   The live SELECTION SLICE is rendered as a square plane cutting through the
  //   cube, positioned by slice_y + rotated by slice_rx/ry/rz — exactly the
  //   plane the surface-height scan reads. The view-only camera (view_zoom +
  //   view_rot_x/y/z) orbits it. The OUTPUT waveform readout (from the worklet
  //   snapshot) is folded in as a 2D overlay.
  //
  //   Pipeline reuses WAVESCULPT's proven approach: a private OffscreenCanvas +
  //   WebGL2 (scene FBO → blit to the visible <canvas> via drawImage). The field
  //   math is the SAME pure cube-dsp.ts the worklet/ART run — imported via a
  //   relative path (the bluebox.ts pattern), so the picture matches the sound.
  //
  // PatchPanel exposes EVERY input handle (pitch + 8 CVs) + the L / R audio
  // output handles.

  import type { NodeProps } from '@xyflow/svelte';
  import { onDestroy } from 'svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import ModuleTitle from './ModuleTitle.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { cubeDef, CUBE_SLOTS, CUBE_DEFAULT_TABLES, type CubeSlot, type CubeData, type CubeSlotData } from '$lib/audio/modules/cube';
  import { getFactoryTables } from '$lib/audio/wavetable-factory-tables';
  import { WAVETABLE_PRESETS, loadWavetablePreset } from '$lib/audio/wavetable-presets';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import {
    columnHeights,
    fieldFromHeights,
    type FieldParams,
    type Material,
  } from '../../../../../dsp/src/lib/cube-dsp';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  const defaultFor = (pid: string): number =>
    cubeDef.params.find((p) => p.id === pid)!.defaultValue;
  const minFor = (pid: string): number => cubeDef.params.find((p) => p.id === pid)!.min;
  const maxFor = (pid: string): number => cubeDef.params.find((p) => p.id === pid)!.max;

  function paramVal(k: string): number {
    const v = node?.params?.[k];
    return typeof v === 'number' ? v : defaultFor(k);
  }
  const set = (pid: string) => (v: number) => {
    const t = patch.nodes[id]; if (t) t.params[pid] = v;
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

  // ───────────────── per-slot wavetable selection (node.data) ─────────────────
  const SLOT_LABEL: Record<CubeSlot, string> = { floor: 'FLOOR', wall: 'WALL', ceiling: 'CEILING' };

  function slotData(slot: CubeSlot): CubeSlotData {
    const d = (node?.data ?? {}) as CubeData;
    return (d[slot] as CubeSlotData | undefined) ?? {};
  }
  // The <select> value MUST equal an existing <option> value or the dropdown
  // renders blank. A loaded preset/file stores source:'user' (+ a label), which
  // matches no factory:/preset: option — so (issue #3) we select the synthetic
  // 'user' option and render it labelled with the stored filename. This mirrors
  // WAVESCULPT's oscSource/oscLabel + `<option value="user">USER · …` pattern,
  // and because it reads straight from node.data it survives a patch reload.
  function slotSelectValue(slot: CubeSlot): string {
    const sd = slotData(slot);
    if (sd.source === 'user') return 'user';
    return sd.source ?? `factory:${CUBE_DEFAULT_TABLES[slot]}`;
  }
  /** Human label of the currently-loaded table for a slot (the loaded filename
   *  for a user table, else the factory table's label). */
  function slotLabel(slot: CubeSlot): string {
    const sd = slotData(slot);
    if (sd.source === 'user') return sd.label ?? 'USER';
    const src = sd.source ?? `factory:${CUBE_DEFAULT_TABLES[slot]}`;
    if (src.startsWith('factory:')) {
      const fid = src.slice('factory:'.length);
      return factoryTables.find((t) => t.id === fid)?.label ?? fid;
    }
    return src;
  }
  let slotStatus = $state<Record<CubeSlot, string | null>>({ floor: null, wall: null, ceiling: null });

  function ensureSlot(slot: CubeSlot): CubeSlotData | null {
    const t = patch.nodes[id];
    if (!t) return null;
    if (!t.data) t.data = {};
    const d = t.data as CubeData;
    if (!d[slot]) (d as Record<string, unknown>)[slot] = {};
    return d[slot] as CubeSlotData;
  }
  function selectFactory(slot: CubeSlot, factoryId: string): void {
    const sd = ensureSlot(slot); if (!sd) return;
    sd.source = `factory:${factoryId}`;
    delete sd.frames;
    delete sd.label;
    slotStatus[slot] = null;
  }
  async function selectPreset(slot: CubeSlot, presetId: string): Promise<void> {
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
    }
  }
  function onSlotChange(slot: CubeSlot, ev: Event): void {
    const sel = ev.target as HTMLSelectElement;
    const v = sel.value;
    if (v.startsWith('factory:')) selectFactory(slot, v.slice('factory:'.length));
    else if (v.startsWith('preset:')) void selectPreset(slot, v.slice('preset:'.length));
  }

  // ═══════════════ 3D CUBE VISUALIZATION (WebGL2) — issue #2 ═══════════════
  //
  // Renders the actual 3D box: the scalar field as a back-to-front alpha-blended
  // stack of axis-aligned Z-slices (translucent voxel volume) sampling a small
  // CPU-computed field texture, the live selection slice as a square plane
  // cutting through it, the cube wireframe for orientation, and the OUTPUT
  // waveform from the worklet snapshot as a 2D overlay. The view-only camera
  // (view_zoom / view_rot_x/y/z) orbits the scene.

  const RES = 320;                 // square offscreen render resolution
  const VOL = 24;                  // field voxel resolution per axis (CPU side)
  const SLICE_LAYERS = 28;         // alpha-blended Z-slice quads for the volume
  let glCanvas = $state<HTMLCanvasElement | null>(null);     // visible 3D canvas
  let waveCanvas = $state<HTMLCanvasElement | null>(null);   // OUTPUT overlay
  let raf: number | null = null;

  let offscreen: OffscreenCanvas | HTMLCanvasElement | null = null;
  let gl: WebGL2RenderingContext | null = null;
  let glReady = false;
  let glFailed = false;
  let volProgram: WebGLProgram | null = null;
  let planeProgram: WebGLProgram | null = null;
  let wireProgram: WebGLProgram | null = null;
  let quadBuf: WebGLBuffer | null = null;     // unit quad [-0.5,0.5]^2
  let layerBuf: WebGLBuffer | null = null;    // per-layer z index
  let wireBuf: WebGLBuffer | null = null;     // cube edge line segments
  let volTex: WebGLTexture | null = null;     // VOL×VOL×VOL field as 2D atlas
  // Field signature so we only rebuild the (cheap but non-trivial) volume
  // texture when a shaping param actually changed — NOT every frame.
  let lastFieldSig = '';

  // ---- minimal mat4 helpers (mirrors WavesculptCard's) ----
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
  // Euler rotation (X→Y→Z) matching cube-dsp.rotate() so the rendered plane sits
  // where the slice actually reads.
  function eulerMat(out: Float32Array, rx: number, ry: number, rz: number): void {
    const cx = Math.cos(rx), sx = Math.sin(rx);
    const cy = Math.cos(ry), sy = Math.sin(ry);
    const cz = Math.cos(rz), sz = Math.sin(rz);
    // Combined R = Rz·Ry·Rx applied to a column vector (matches the dsp's
    // x→y→z application order on (px,0,0) and (0,0,1)).
    const m00 = cy * cz, m01 = sx * sy * cz - cx * sz, m02 = cx * sy * cz + sx * sz;
    const m10 = cy * sz, m11 = sx * sy * sz + cx * cz, m12 = cx * sy * sz - sx * cz;
    const m20 = -sy,     m21 = sx * cy,                m22 = cx * cy;
    // column-major 4x4
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

  // The field volume is uploaded as a 2D ATLAS texture: VOL z-layers laid out in
  // a grid (atlasCols × atlasRows), each VOL×VOL, so we avoid TEXTURE_3D /
  // sampler3D portability concerns. The volume-slice fragment shader samples its
  // own z-layer; the plane shader trilinearly samples across two adjacent layers.
  const ATLAS_COLS = 5;
  const ATLAS_ROWS = Math.ceil(VOL / ATLAS_COLS); // 5 → 5 rows for VOL=24 (25 cells)
  const ATLAS_W = ATLAS_COLS * VOL;
  const ATLAS_H = ATLAS_ROWS * VOL;

  // GLSL helper: sample the field atlas at integer z-layer + (u,v) in [0,1].
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
  in vec2 aQuad;       // [-0.5,0.5]^2
  in float aLayer;     // 0..SLICE_LAYERS-1
  uniform mat4 uMVP;
  out vec2 vUV; out float vZ;
  void main(){
    float t = aLayer / ${(SLICE_LAYERS - 1).toFixed(1)}; // 0..1 along Z
    vUV = aQuad + 0.5;
    vZ = t;
    vec3 p = vec3(aQuad + 0.5, t);   // unit cube [0,1]^3
    gl_Position = uMVP * vec4(p - 0.5, 1.0); // center the cube on origin
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
    // teal→white density ramp, low per-layer alpha so the stack reads as volume
    vec3 col = mix(vec3(0.12,0.36,0.45), vec3(0.6,0.92,1.0), d);
    frag = vec4(col, d * 0.14);
  }`;

  const PLANE_VS = `#version 300 es
  precision highp float;
  in vec2 aQuad;       // [-0.5,0.5]^2 scan square
  uniform mat4 uMVP;
  uniform mat4 uRot;   // slice euler rotation
  uniform float uSliceY;
  out vec3 vPos;
  void main(){
    // square in plane local space (scan axis = x, the other = y), normal = z
    vec3 local = vec3(aQuad.x, aQuad.y, 0.0);
    vec3 world = (uRot * vec4(local, 1.0)).xyz + vec3(0.0, 0.0, uSliceY - 0.5) + vec3(0.5);
    vPos = world;
    gl_Position = uMVP * vec4(world - 0.5, 1.0);
  }`;
  const PLANE_FS = `#version 300 es
  precision highp float;
  in vec3 vPos;
  uniform sampler2D uAtlas;
  out vec4 frag;
  ${ATLAS_SAMPLE}
  void main(){
    // tint the plane by the field density it cuts through
    float zi = clamp(vPos.z, 0.0, 1.0) * ${(VOL - 1).toFixed(1)};
    float d = atlasAt(uAtlas, floor(zi + 0.5), clamp(vPos.xy, 0.0, 1.0));
    vec3 hot = mix(vec3(1.0,0.55,0.15), vec3(1.0,0.9,0.4), d);
    frag = vec4(hot, 0.42 + d * 0.4);
  }`;

  const WIRE_VS = `#version 300 es
  precision highp float;
  in vec3 aPos;        // cube corners in [0,1]
  uniform mat4 uMVP;
  void main(){ gl_Position = uMVP * vec4(aPos - 0.5, 1.0); }`;
  const WIRE_FS = `#version 300 es
  precision highp float;
  out vec4 frag;
  void main(){ frag = vec4(0.55, 0.72, 0.85, 0.5); }`;

  function cubeEdges(): Float32Array {
    const c = [
      [0,0,0],[1,0,0],[1,1,0],[0,1,0],
      [0,0,1],[1,0,1],[1,1,1],[0,1,1],
    ];
    const e = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
    const out: number[] = [];
    for (const [a, b] of e) { out.push(...c[a!]!, ...c[b!]!); }
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
      g.bufferData(g.ARRAY_BUFFER, cubeEdges(), g.STATIC_DRAW);

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
      console.warn('[cube] WebGL2 init failed; falling back to 2D', err);
      glFailed = true; glReady = false;
      return false;
    }
  }

  // Rebuild the field volume atlas from the live shaping params + loaded tables.
  function rebuildVolume(g: WebGL2RenderingContext, fp: FieldParams): void {
    const e = engineCtx.get();
    const fr = (e && node ? e.read(node, 'frames') as
      { floor: Float32Array[]; wall: Float32Array[]; ceiling: Float32Array[] } | undefined : undefined);
    if (!fr || !fr.floor.length || !fr.wall.length || !fr.ceiling.length) return;
    const atlas = new Uint8Array(ATLAS_W * ATLAS_H);
    const denom = VOL - 1; // VOL is a fixed >1 const, so never zero
    for (let zi = 0; zi < VOL; zi++) {
      const cellCol = zi % ATLAS_COLS;
      const cellRow = Math.floor(zi / ATLAS_COLS);
      const z = zi / denom;
      for (let yi = 0; yi < VOL; yi++) {
        const y = yi / denom;
        for (let xi = 0; xi < VOL; xi++) {
          const x = xi / denom;
          const h = columnHeights(fr.floor, fr.wall, fr.ceiling, x, y);
          const d = fieldFromHeights(z, h, fp); // [0,1]
          const px = cellCol * VOL + xi;
          const py = cellRow * VOL + yi;
          atlas[py * ATLAS_W + px] = Math.max(0, Math.min(255, Math.round(d * 255)));
        }
      }
    }
    g.bindTexture(g.TEXTURE_2D, volTex);
    g.pixelStorei(g.UNPACK_ALIGNMENT, 1);
    g.texSubImage2D(g.TEXTURE_2D, 0, 0, 0, ATLAS_W, ATLAS_H, g.RED, g.UNSIGNED_BYTE, atlas);
  }

  // ---- live param reads (knob + CV via the engine) ----
  function liveParam(pid: string, fallback: number): number {
    const e = engineCtx.get();
    if (e && node) { const v = e.readParam(node, pid); if (typeof v === 'number') return v; }
    return paramVal(pid) ?? fallback;
  }

  const projMat = new Float32Array(16);
  const viewMat = new Float32Array(16);
  const mvpMat = new Float32Array(16);
  const rotMat = new Float32Array(16);

  function renderGl(): void {
    if (!gl || !glReady) return;
    const g = gl;

    // Live shaping params drive the field; view params drive the camera.
    const morphFC = liveParam('morph_fc', 0);
    const connect = liveParam('connect', 0);
    const materialHardV = liveParam('material', 0) >= 0.5;
    const fp: FieldParams = { morphFC, connect, material: (materialHardV ? 'hard' : 'smooth') as Material };
    const sliceY = liveParam('slice_y', 0.5);
    const srx = liveParam('slice_rx', 0), sry = liveParam('slice_ry', 0), srz = liveParam('slice_rz', 0);

    const fsig = `${morphFC.toFixed(3)}|${connect.toFixed(3)}|${materialHardV ? 1 : 0}`;
    if (fsig !== lastFieldSig) { rebuildVolume(g, fp); lastFieldSig = fsig; }

    // Camera (view-only).
    const zoom = Math.max(0.3, Math.min(3, liveParam('view_zoom', 1)));
    const vrx = liveParam('view_rot_x', 0.6), vry = liveParam('view_rot_y', 0.7);
    const dist = 2.6 / zoom;
    const ex = dist * Math.cos(vrx) * Math.sin(vry);
    const ey = dist * Math.sin(vrx);
    const ez = dist * Math.cos(vrx) * Math.cos(vry);

    m4Perspective(projMat, 1.0, 1.0, 0.05, 20.0);
    m4LookAt(viewMat, [ex, ey, ez], [0, 0, 0], [0, 1, 0]);
    m4Mul(mvpMat, projMat, viewMat);
    eulerMat(rotMat, srx, sry, srz);

    g.bindFramebuffer(g.FRAMEBUFFER, null);
    g.viewport(0, 0, RES, RES);
    g.clearColor(0.039, 0.047, 0.07, 1);
    g.clear(g.COLOR_BUFFER_BIT | g.DEPTH_BUFFER_BIT);
    g.enable(g.BLEND);
    g.blendFunc(g.SRC_ALPHA, g.ONE_MINUS_SRC_ALPHA);
    g.disable(g.DEPTH_TEST); // translucent stack composites order-independently enough

    g.activeTexture(g.TEXTURE0);
    g.bindTexture(g.TEXTURE_2D, volTex);

    // 1) volume slice stack (instanced quads, one per Z layer)
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

    // 2) the live selection slice plane
    g.useProgram(planeProgram);
    g.uniformMatrix4fv(g.getUniformLocation(planeProgram!, 'uMVP'), false, mvpMat);
    g.uniformMatrix4fv(g.getUniformLocation(planeProgram!, 'uRot'), false, rotMat);
    g.uniform1f(g.getUniformLocation(planeProgram!, 'uSliceY'), sliceY);
    g.uniform1i(g.getUniformLocation(planeProgram!, 'uAtlas'), 0);
    const pq = g.getAttribLocation(planeProgram!, 'aQuad');
    g.bindBuffer(g.ARRAY_BUFFER, quadBuf);
    g.enableVertexAttribArray(pq); g.vertexAttribPointer(pq, 2, g.FLOAT, false, 0, 0);
    g.drawArrays(g.TRIANGLE_STRIP, 0, 4);

    // 3) cube wireframe
    g.useProgram(wireProgram);
    g.uniformMatrix4fv(g.getUniformLocation(wireProgram!, 'uMVP'), false, mvpMat);
    const wq = g.getAttribLocation(wireProgram!, 'aPos');
    g.bindBuffer(g.ARRAY_BUFFER, wireBuf);
    g.enableVertexAttribArray(wq); g.vertexAttribPointer(wq, 3, g.FLOAT, false, 0, 0);
    g.drawArrays(g.LINES, 0, 24);

    // blit to the visible canvas
    if (glCanvas && offscreen) {
      const c2d = glCanvas.getContext('2d');
      if (c2d) {
        c2d.clearRect(0, 0, glCanvas.width, glCanvas.height);
        c2d.drawImage(offscreen as CanvasImageSource, 0, 0, glCanvas.width, glCanvas.height);
        c2d.fillStyle = 'rgba(255,255,255,0.55)';
        c2d.font = '9px monospace';
        c2d.fillText('CUBE', 5, 12);
      }
    }
  }

  // OUTPUT waveform overlay (folded in from the worklet snapshot).
  function drawWave(c: HTMLCanvasElement, wave: Float32Array): void {
    const ctx2d = c.getContext('2d'); if (!ctx2d) return;
    const W = c.width, H = c.height;
    ctx2d.fillStyle = '#0a0c12'; ctx2d.fillRect(0, 0, W, H);
    ctx2d.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx2d.beginPath(); ctx2d.moveTo(0, H / 2); ctx2d.lineTo(W, H / 2); ctx2d.stroke();
    ctx2d.strokeStyle = '#5ad1ff'; ctx2d.lineWidth = 1.5;
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

  $effect(() => {
    if (!glReady && !glFailed) initGl();
    function tick() {
      if (glReady) renderGl();
      const e = engineCtx.get();
      if (e && node) {
        const snap = e.read(node, 'snapshot') as Float32Array | undefined;
        if (snap && waveCanvas) drawWave(waveCanvas, snap);
      }
      raf = requestAnimationFrame(tick);
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
      if (volTex) gl.deleteTexture(volTex);
    } catch { /* */ }
    gl = null; offscreen = null; glReady = false;
  }
  onDestroy(() => { if (raf !== null) cancelAnimationFrame(raf); disposeGl(); });

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
    { id: 'tune',     label: 'TUNE',    cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'L', label: 'L', cable: 'audio' },
    { id: 'R', label: 'R', cable: 'audio' },
  ];

  const factoryTables = getFactoryTables();

  // Knob descriptor list (driven from the def so ranges/curves stay in sync).
  const KNOBS: Array<{ pid: string; label: string; units?: string }> = [
    { pid: 'tune', label: 'Tune', units: 'st' },
    { pid: 'fine', label: 'Fine', units: '¢' },
    { pid: 'morph_fc', label: 'Morph' },
    { pid: 'connect', label: 'Connect' },
    { pid: 'crush', label: 'Crush' },
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

<div class="mod-card cube-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <ModuleTitle {id} {data} defaultLabel="CUBE" />

  <PatchPanel nodeId={id} {inputs} {outputs} panelWidth={360}>
    <div class="cube-body">
      <!-- Visualization: the 3D cube (headline) + OUTPUT waveform overlay -->
      <div class="viz-col">
        <canvas
          bind:this={glCanvas}
          class="viz cube-viz"
          width={320}
          height={320}
          data-testid="cube-3d-viz"
        ></canvas>
        <canvas
          bind:this={waveCanvas}
          class="viz wave-viz"
          width={320}
          height={64}
          data-testid="cube-wave-viz"
        ></canvas>
      </div>

      <!-- Wavetable selectors -->
      <div class="wt-selects">
        {#each CUBE_SLOTS as slot (slot)}
          <div class="wt-row">
            <span class="wt-label">{SLOT_LABEL[slot]}</span>
            <select
              class="wt-select"
              value={slotSelectValue(slot)}
              onchange={(ev) => onSlotChange(slot, ev)}
              data-testid={`cube-${slot}-select`}
            >
              <optgroup label="Factory">
                {#each factoryTables as t (t.id)}
                  <option value={`factory:${t.id}`}>{t.label}</option>
                {/each}
              </optgroup>
              <optgroup label="Presets">
                {#each WAVETABLE_PRESETS as p (p.id)}
                  <option value={`preset:${p.id}`}>{p.label}</option>
                {/each}
              </optgroup>
              <!-- Synthetic option so a loaded user table (source:'user') has a
                   matching <option> + the dropdown shows its filename (issue #3,
                   persists across reload since it reads node.data). -->
              {#if slotSelectValue(slot) === 'user'}
                <option value="user">USER · {slotLabel(slot)}</option>
              {/if}
            </select>
            {#if slotStatus[slot]}
              <span class="wt-status">{slotStatus[slot]}</span>
            {/if}
          </div>
        {/each}
      </div>

      <!-- Toggles -->
      <div class="toggles">
        <button
          class="toggle"
          class:on={wrapOn}
          onclick={toggleWrap}
          data-testid="cube-wrap-toggle"
          title="WRAP: out-of-cube slice is silent (off) or mirror-folds back in (on)"
        >WRAP: {wrapOn ? 'ON' : 'OFF'}</button>
        <button
          class="toggle"
          class:on={materialHard}
          onclick={toggleMaterial}
          data-testid="cube-material-toggle"
          title="MATERIAL: SMOOTH (continuous density) or HARD (binary solid)"
        >MAT: {materialHard ? 'HARD' : 'SMOOTH'}</button>
      </div>

      <!-- Audio knobs -->
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

      <!-- View-only camera controls -->
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
  </PatchPanel>
</div>

<style>
  .cube-card {
    width: 360px;
    background: var(--cube-bg, #12141b);
    color: #ece8e2;
  }
  .cube-body { padding: 6px 10px 8px; display: flex; flex-direction: column; gap: 8px; }
  .viz-col { display: flex; flex-direction: column; gap: 6px; align-items: center; }
  .viz { border-radius: 4px; background: #0a0c12; border: 1px solid rgba(255,255,255,0.08); }
  .cube-viz { width: 320px; height: 320px; image-rendering: auto; }
  .wave-viz { width: 320px; height: 64px; }
  .wt-selects { display: flex; flex-direction: column; gap: 4px; }
  .wt-row { display: flex; align-items: center; gap: 6px; }
  .wt-label {
    font-family: var(--font-mono, monospace);
    font-size: 0.6rem; letter-spacing: 0.04em; color: #9fb6c9;
    width: 52px; flex: none;
  }
  .wt-select {
    flex: 1; font-size: 0.62rem; background: #1b1f29; color: #ece8e2;
    border: 1px solid rgba(255,255,255,0.12); border-radius: 3px; padding: 2px 4px;
  }
  .wt-status { font-size: 0.52rem; color: #7fd6a0; white-space: nowrap; max-width: 80px; overflow: hidden; text-overflow: ellipsis; }
  .toggles { display: flex; gap: 8px; }
  .toggle {
    flex: 1; font-family: var(--font-mono, monospace); font-size: 0.6rem;
    padding: 4px 6px; border-radius: 3px; cursor: pointer;
    background: #1b1f29; color: #9fb6c9; border: 1px solid rgba(255,255,255,0.14);
  }
  .toggle.on { background: #1f5e74; color: #d9f4ff; border-color: #3a9cc0; }
  .knobs { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-end; justify-content: flex-start; }
  .view-section { border-top: 1px solid rgba(255,255,255,0.08); padding-top: 6px; }
  .view-head { font-family: var(--font-mono, monospace); font-size: 0.55rem; letter-spacing: 0.04em; color: #8294a4; margin-bottom: 4px; }
  .view-knobs { gap: 12px; }
</style>

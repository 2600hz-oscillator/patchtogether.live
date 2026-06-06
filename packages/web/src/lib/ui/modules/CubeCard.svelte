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
  // output handles + the SYNC sine reference + the VIDEO out.

  import type { NodeProps } from '@xyflow/svelte';
  import { onDestroy, onMount } from 'svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import ModuleTitle from './ModuleTitle.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch, ydoc } from '$lib/graph/store';
  import { cubeDef, CUBE_SLOTS, CUBE_DEFAULT_TABLES, installCubeFrameDrawer, uninstallCubeFrameDrawer, type CubeSlot, type CubeData, type CubeSlotData } from '$lib/audio/modules/cube';
  import { getFactoryTables, framesToPlain } from '$lib/audio/wavetable-factory-tables';
  import { WAVETABLE_PRESETS, loadWavetablePreset } from '$lib/audio/wavetable-presets';
  import { parseE352Wav } from '$lib/audio/wavetable-parser';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import {
    columnHeights,
    fieldFromHeights,
    spaceCrushCoord,
    diffusePull,
    lowestInfoFace,
    type FieldParams,
    type DiffuseTarget,
    type Material,
  } from '../../../../../dsp/src/lib/cube-dsp';

  // CUBE video_out source port — used to detect a downstream consumer so the
  // viz can keep rendering even when the screen is toggled OFF (item #2).
  const VIDEO_OUT_PORT_ID = 'video_out';

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

  // ───────────────── SCREEN on/off + downstream detection (item #2) ─────────────────
  //
  // SCREEN OFF + video_out UNPATCHED ⇒ skip ALL visual computation (the rAF GL
  // render loop AND the display-only field/slice/wave draws). Audio is untouched.
  // When the screen is ON, *or* video_out has a downstream consumer, the viz
  // renders as normal (a patched video_out must keep emitting frames).
  let screenOn = $derived(paramVal('screen_on') >= 0.5);
  function toggleScreen(): void { set('screen_on')(screenOn ? 0 : 1); }

  // patch.edges is a Yjs-backed proxy; reading it in a $derived isn't reactive
  // on its own. Mirror DoomCard's pattern: an edges-map observer bumps a real
  // $state signal so videoOutPatched re-derives when a cable is added/removed
  // (including a far-side patch in a multiplayer rack).
  let edgesVersion = $state(0);
  let videoOutPatched = $derived<boolean>(
    (void edgesVersion,
      Object.values(patch.edges ?? {}).some(
        (e) => e?.source?.nodeId === id && e?.source?.portId === VIDEO_OUT_PORT_ID,
      )),
  );
  // Should the viz compute/render at all this frame? (the central perf gate.)
  let vizActive = $derived<boolean>(screenOn || videoOutPatched);
  let edgesObserver: (() => void) | null = null;
  function attachEdgesObserver(): void {
    try {
      const edgesMap = ydoc.getMap('edges');
      const handler = (): void => { edgesVersion++; };
      edgesMap.observeDeep(handler);
      edgesObserver = () => { try { edgesMap.unobserveDeep(handler); } catch { /* */ } };
      edgesVersion++; // seed for an already-patched cable at mount
    } catch { /* ydoc unavailable (test env) — videoOutPatched stays false */ }
  }

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
  // A cheap signature of WHICH table each slot currently holds, so the viz
  // rebuilds (item #1: viz updates on reload + item #3: only when it must).
  // Reads node.data (reactive via the snapshot bus) so it changes the instant a
  // table is swapped. Doesn't include frame contents — the source/label change
  // on every distinct table, which is enough to invalidate the cached field.
  function slotTableSig(slot: CubeSlot): string {
    const sd = slotData(slot);
    return `${sd.source ?? `factory:${CUBE_DEFAULT_TABLES[slot]}`}:${sd.label ?? ''}:${sd.frames?.length ?? 0}`;
  }
  let tableSig = $derived(`${slotTableSig('floor')}|${slotTableSig('wall')}|${slotTableSig('ceiling')}`);

  let slotStatus = $state<Record<CubeSlot, string | null>>({ floor: null, wall: null, ceiling: null });
  // RELOAD FIX (item #1): the preset <select> gets its OWN selection state that
  // is reset to '' after every load — so re-picking the SAME preset (or a
  // different one) ALWAYS fires `change` (a controlled <select> whose bound
  // value never changes won't re-fire on re-select). The old combined dropdown
  // pinned its value to 'user' after any load, so loading a different table
  // could silently no-op. Mirrors WAVESCULPT's separate preset selector +
  // file-input value reset.
  let presetSelection = $state<Record<CubeSlot, string>>({ floor: '', wall: '', ceiling: '' });

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
    } finally {
      // Reset so the SAME preset can be picked again (re-fires `change`).
      presetSelection[slot] = '';
    }
  }
  function onPresetChange(slot: CubeSlot, ev: Event): void {
    const v = (ev.target as HTMLSelectElement).value;
    if (!v) return;
    void selectPreset(slot, v);
  }
  // File LOAD (item #1): parse a user .wav into the slot, then ALWAYS reset
  // input.value so re-selecting the same/different file fires `change` again.
  async function onSlotFileChange(slot: CubeSlot, ev: Event): Promise<void> {
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
  function onSlotChange(slot: CubeSlot, ev: Event): void {
    const sel = ev.target as HTMLSelectElement;
    const v = sel.value;
    if (v === 'user') return; // synthetic option — ignore (keeps the loaded table)
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
  let waveCanvas = $state<HTMLCanvasElement | null>(null);   // OUTPUT waveform
  let sliceCanvas = $state<HTMLCanvasElement | null>(null);  // 2D slice cross-section
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
  // Scene signature (field + slice + camera) — perf item #3: the GL draw calls
  // are SKIPPED entirely when nothing the picture depends on changed since the
  // last rendered frame, so an idle CUBE costs ~0 GPU work instead of a full
  // re-draw every rAF. Reset to '' to force the next frame to render.
  let lastSceneSig = '';
  let renderedOnce = false;

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
  // Returns true only if the rebuild actually uploaded (frames were ready) —
  // item #4: on mount the engine frames may not be resolved on the very first
  // frame, so the caller must NOT cache the field signature until a real upload
  // happened, else the cube stays empty until a param change bumps the sig.
  function rebuildVolume(
    g: WebGL2RenderingContext,
    fp: FieldParams,
    sc: number,
    sd: number,
    diffuseTarget: DiffuseTarget | null,
  ): boolean {
    const e = engineCtx.get();
    const fr = (e && node ? e.read(node, 'frames') as
      { floor: Float32Array[]; wall: Float32Array[]; ceiling: Float32Array[] } | undefined : undefined);
    if (!fr || !fr.floor.length || !fr.wall.length || !fr.ceiling.length) return false;
    const atlas = new Uint8Array(ATLAS_W * ATLAS_H);
    const denom = VOL - 1; // VOL is a fixed >1 const, so never zero
    for (let zi = 0; zi < VOL; zi++) {
      const cellCol = zi % ATLAS_COLS;
      const cellRow = Math.floor(zi / ATLAS_COLS);
      const z0 = zi / denom;
      for (let yi = 0; yi < VOL; yi++) {
        const y0 = yi / denom;
        for (let xi = 0; xi < VOL; xi++) {
          const x0 = xi / denom;
          // SPACE DIFFUSE (pull toward the emptiest wall) THEN SPACE CRUSH
          // (voxelize the lookup coords) — same compose order the DSP scan runs,
          // so the picture matches the sound. Both identity at 0.
          let x = x0, y = y0, z = z0;
          if (diffuseTarget) {
            if (diffuseTarget.axis === 0) x = diffusePull(x, sd, diffuseTarget.dir);
            else if (diffuseTarget.axis === 1) y = diffusePull(y, sd, diffuseTarget.dir);
            else z = diffusePull(z, sd, diffuseTarget.dir);
          }
          x = spaceCrushCoord(x, sc);
          y = spaceCrushCoord(y, sc);
          z = spaceCrushCoord(z, sc);
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
    return true;
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

  // `force` (used by the video_out frame-drawer) bypasses the scene-dirty skip
  // so the bridge always receives a freshly-rendered frame even when nothing
  // changed. Returns true if a GL draw happened this call.
  function renderGl(force = false): boolean {
    if (!gl || !glReady) return false;
    const g = gl;

    // Live shaping params drive the field; view params drive the camera.
    const morphFC = liveParam('morph_fc', 0);
    const connect = liveParam('connect', 0);
    const connectStrength = liveParam('connect_strength', 0);
    const spaceCrush = liveParam('space_crush', 0);
    const spaceDiffuse = liveParam('space_diffuse', 0);
    const materialHardV = liveParam('material', 0) >= 0.5;
    const fp: FieldParams = {
      morphFC, connect, connectStrength,
      material: (materialHardV ? 'hard' : 'smooth') as Material,
    };
    const sliceY = liveParam('slice_y', 0.5);
    const srx = liveParam('slice_rx', 0), sry = liveParam('slice_ry', 0), srz = liveParam('slice_rz', 0);

    // Camera (view-only).
    const zoom = Math.max(0.3, Math.min(3, liveParam('view_zoom', 1)));
    const vrx = liveParam('view_rot_x', 0.6), vry = liveParam('view_rot_y', 0.7);

    // PERF (item #3): skip the whole draw when neither the field, the slice, nor
    // the camera moved since the last rendered frame. tsig folds in the loaded
    // tables (item #1: a reload invalidates the cached field). Coarse rounding
    // (~1e-3) avoids re-rendering on float jitter while staying visually smooth.
    const tsig = tableSig;
    const q = (v: number) => Math.round(v * 1000);
    const sceneSig =
      `${q(morphFC)}|${q(connect)}|${q(connectStrength)}|${q(spaceCrush)}|${q(spaceDiffuse)}|` +
      `${materialHardV ? 1 : 0}|${q(sliceY)}|` +
      `${q(srx)}|${q(sry)}|${q(srz)}|${q(zoom)}|${q(vrx)}|${q(vry)}|${tsig}`;
    if (!force && renderedOnce && sceneSig === lastSceneSig) return false;
    lastSceneSig = sceneSig;

    // SPACE DIFFUSE target: resolve the emptiest wall ONCE per render (depends
    // only on the field, not the diffuse amount → latches on table/morph change,
    // matching the DSP scan). null when off so OFF stays a true identity.
    let diffuseTarget: DiffuseTarget | null = null;
    if (spaceDiffuse > 0) {
      const e = engineCtx.get();
      const frd = (e && node ? e.read(node, 'frames') as
        { floor: Float32Array[]; wall: Float32Array[]; ceiling: Float32Array[] } | undefined : undefined);
      if (frd && frd.floor.length && frd.wall.length && frd.ceiling.length) {
        diffuseTarget = lowestInfoFace(frd.floor, frd.wall, frd.ceiling, fp);
      }
    }

    // Rebuild the volume texture only when the field/tables changed. Cache the
    // signature ONLY on a successful upload (item #4) so a first frame that runs
    // before the engine resolves the tables doesn't wedge an empty cube.
    const fsig =
      `${q(morphFC)}|${q(connect)}|${q(connectStrength)}|${q(spaceCrush)}|${q(spaceDiffuse)}|` +
      `${materialHardV ? 1 : 0}|${tsig}`;
    if (fsig !== lastFieldSig) {
      if (rebuildVolume(g, fp, spaceCrush, spaceDiffuse, diffuseTarget)) lastFieldSig = fsig;
      else lastSceneSig = ''; // frames not ready yet → re-attempt next frame
    }

    const dist = 2.6 / zoom;
    const ex = dist * Math.cos(vrx) * Math.sin(vry);
    const ey = dist * Math.sin(vrx);
    const ez = dist * Math.cos(vrx) * Math.cos(vry);

    // The GL scene renders square (RES×RES) then blits to the (non-square) card
    // canvas via drawImage, which stretches it. Pre-compensate by setting the
    // projection aspect to the visible canvas aspect so the cube stays
    // undistorted after the stretch (320×260 → ~1.23).
    const vizAspect = glCanvas ? glCanvas.width / glCanvas.height : 1.0;
    m4Perspective(projMat, 1.0, vizAspect, 0.05, 20.0);
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

    renderedOnce = true;
    // Blit to the visible on-card 3D canvas only when the screen is ON. When
    // the screen is OFF but video_out is patched we still RENDER into `offscreen`
    // (so the bridge frame is live) but the card itself shows the placeholder.
    if (glCanvas && screenOn) blitCube(glCanvas);
    else if (glCanvas && !screenOn) { screenOffPainted = false; paintScreenOff(); }
    return true;
  }

  // Blit the just-rendered GL scene (in `offscreen`) onto a target 2D canvas
  // and stamp the CUBE label. Used for both the on-card canvas and the
  // cross-domain video_out bridge canvas (which renders the SAME 3D cube view).
  function blitCube(target: OffscreenCanvas | HTMLCanvasElement): void {
    if (!offscreen) return;
    const c2d = target.getContext('2d') as
      | CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!c2d) return;
    c2d.clearRect(0, 0, target.width, target.height);
    c2d.drawImage(offscreen as CanvasImageSource, 0, 0, target.width, target.height);
    c2d.fillStyle = 'rgba(255,255,255,0.55)';
    c2d.font = '9px monospace';
    c2d.fillText('CUBE', 5, 12);
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

  // ───────────────── 2D SLICE cross-section heatmap ─────────────────
  //
  // The square cross-section the slice PLANE cuts through the cube field: for
  // each pixel (su, sv) of the slice square we rotate the local plane point by
  // the slice euler angles (matching cube-dsp.rotate / the 3D plane shader),
  // translate to the cube centre at height sliceY, and read the field DENSITY at
  // that 3D point. The result is a heatmap showing the wavetable content the
  // slice actually reads — across ALL THREE tables (floor↔ceiling morph + wall),
  // so the floor / ceiling contribution is visible (not just the wall). This is
  // the SLICE view from pre-v2 (#528), upgraded from a 1D silhouette to the true
  // 2D square the user asked for. Rebuilt only when a shaping param changes.
  const SLICE_RES = 56; // CPU sample grid per axis (kept small; bilinear-scaled)
  let sliceImage: ImageData | null = null;
  let lastSliceSig = '';
  let slicePainted = false; // perf: true once the slice canvas holds the current sig
  // Reusable scratch canvas to upscale the low-res slice grid smoothly.
  let sliceScratch: HTMLCanvasElement | OffscreenCanvas | null = null;

  function rotateVec(
    x: number, y: number, z: number, rx: number, ry: number, rz: number,
  ): [number, number, number] {
    const cx = Math.cos(rx), sx = Math.sin(rx);
    const cy = Math.cos(ry), sy = Math.sin(ry);
    const cz = Math.cos(rz), sz = Math.sin(rz);
    const x1 = x, y1 = y * cx - z * sx, z1 = y * sx + z * cx;       // X
    const x2 = x1 * cy + z1 * sy, y2 = y1, z2 = -x1 * sy + z1 * cy; // Y
    const x3 = x2 * cz - y2 * sz, y3 = x2 * sz + y2 * cz, z3 = z2;  // Z
    return [x3, y3, z3];
  }

  function drawSlice(c: HTMLCanvasElement): void {
    const ctx2d = c.getContext('2d'); if (!ctx2d) return;
    const W = c.width, H = c.height;
    const e = engineCtx.get();
    const fr = (e && node ? e.read(node, 'frames') as
      { floor: Float32Array[]; wall: Float32Array[]; ceiling: Float32Array[] } | undefined : undefined);
    if (!fr || !fr.floor.length || !fr.wall.length || !fr.ceiling.length) {
      ctx2d.fillStyle = '#0a0c12'; ctx2d.fillRect(0, 0, W, H);
      return;
    }
    const morphFC = liveParam('morph_fc', 0);
    const connect = liveParam('connect', 0);
    const connectStrength = liveParam('connect_strength', 0);
    const spaceCrush = liveParam('space_crush', 0);
    const spaceDiffuse = liveParam('space_diffuse', 0);
    const materialHardV = liveParam('material', 0) >= 0.5;
    const sliceY = liveParam('slice_y', 0.5);
    const srx = liveParam('slice_rx', 0), sry = liveParam('slice_ry', 0), srz = liveParam('slice_rz', 0);
    const fp: FieldParams = {
      morphFC, connect, connectStrength,
      material: (materialHardV ? 'hard' : 'smooth') as Material,
    };
    // SPACE DIFFUSE target: resolve the emptiest wall ONCE per draw (latches on
    // the field, not the knob), matching the 3D rebuild + the DSP scan. null off.
    const diffuseTarget: DiffuseTarget | null =
      spaceDiffuse > 0 ? lowestInfoFace(fr.floor, fr.wall, fr.ceiling, fp) : null;

    const sig = `${morphFC.toFixed(3)}|${connect.toFixed(3)}|${connectStrength.toFixed(3)}|` +
      `${spaceCrush.toFixed(3)}|${spaceDiffuse.toFixed(3)}|${materialHardV ? 1 : 0}|` +
      `${sliceY.toFixed(3)}|${srx.toFixed(3)}|${sry.toFixed(3)}|${srz.toFixed(3)}|${tableSig}`;
    // PERF (item #3): nothing changed + already painted → skip the whole redraw
    // (the expensive SLICE_RES² field grid AND the upscale blit).
    if (sig === lastSliceSig && slicePainted && sliceImage) return;
    if (sig !== lastSliceSig || !sliceImage) {
      const img = ctx2d.createImageData(SLICE_RES, SLICE_RES);
      for (let sv = 0; sv < SLICE_RES; sv++) {
        // plane "other" axis in [-0.5, 0.5]; top row = +0.5.
        const py = 0.5 - sv / (SLICE_RES - 1);
        for (let su = 0; su < SLICE_RES; su++) {
          const px = su / (SLICE_RES - 1) - 0.5; // scan axis
          const [rxv, ryv, rzv] = rotateVec(px, py, 0, srx, sry, srz);
          let x = rxv + 0.5, y = ryv + 0.5, z = rzv + sliceY;
          // SPACE DIFFUSE (toward the emptiest wall) THEN SPACE CRUSH (voxelize
          // the lookup coords) — same compose order as the DSP scan + 3D rebuild.
          if (diffuseTarget) {
            if (diffuseTarget.axis === 0) x = diffusePull(x, spaceDiffuse, diffuseTarget.dir);
            else if (diffuseTarget.axis === 1) y = diffusePull(y, spaceDiffuse, diffuseTarget.dir);
            else z = diffusePull(z, spaceDiffuse, diffuseTarget.dir);
          }
          x = spaceCrushCoord(x, spaceCrush);
          y = spaceCrushCoord(y, spaceCrush);
          z = spaceCrushCoord(z, spaceCrush);
          let d = 0;
          if (x >= 0 && x <= 1 && y >= 0 && y <= 1 && z >= 0 && z <= 1) {
            const h = columnHeights(fr.floor, fr.wall, fr.ceiling, x, y);
            d = fieldFromHeights(z, h, fp); // [0,1]
          }
          // teal→white density ramp (matches the 3D volume colour).
          const r = 0.12 + (0.6 - 0.12) * d;
          const g = 0.36 + (0.92 - 0.36) * d;
          const b = 0.45 + (1.0 - 0.45) * d;
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

    // Upscale the low-res grid onto the visible canvas with smoothing.
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

  // video_out frame-drawer: render the SAME 3D cube scene then blit it into the
  // cross-domain bridge canvas. Installed by node id so the audio module's
  // videoSources.drawFrame can delegate to it (mirrors WAVESCULPT's pattern).
  // `force=true`: the bridge pulls frames on its own clock, so it must always
  // get a freshly-rendered scene regardless of the on-card scene-dirty skip.
  function videoFrame(canvas: OffscreenCanvas | HTMLCanvasElement): void {
    if (!glReady && !glFailed) initGl();
    if (!glReady) {
      const c2d = canvas.getContext('2d') as
        | CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
      if (c2d) { c2d.fillStyle = '#0a0c12'; c2d.fillRect(0, 0, canvas.width, canvas.height); }
      return;
    }
    renderGl(true);      // refresh the GL scene into `offscreen` (forced)
    blitCube(canvas);    // draw it onto the bridge canvas
  }

  // Paint the on-card 3D canvas a flat "screen off" panel (only when actually
  // visible — the bridge canvas is unaffected so a patched video_out still gets
  // live frames via videoFrame()). Cheap + idempotent.
  let screenOffPainted = false;
  function paintScreenOff(): void {
    if (screenOffPainted || !glCanvas) return;
    const c2d = glCanvas.getContext('2d') as CanvasRenderingContext2D | null;
    if (!c2d) return;
    c2d.fillStyle = '#0a0c12';
    c2d.fillRect(0, 0, glCanvas.width, glCanvas.height);
    c2d.fillStyle = 'rgba(255,255,255,0.28)';
    c2d.font = '11px monospace';
    c2d.fillText('SCREEN OFF', 10, 20);
    screenOffPainted = true;
  }

  // PERF (item #2 + #3): throttle the viz to ~30 FPS (the 3D cube reads as
  // smooth at 30; halving the rAF cadence ~halves the per-frame GPU+CPU cost),
  // and skip the whole loop body when the viz is inactive (screen OFF AND
  // video_out unpatched). Snapshot dirty-tracking avoids redundant wave redraws.
  const VIZ_FRAME_MS = 1000 / 30;
  let lastFrameTs = 0;
  let lastSnapRef: Float32Array | null = null;

  $effect(() => {
    if (!glReady && !glFailed) initGl();
    if (id) installCubeFrameDrawer(id, videoFrame);
    // Read the reactive viz gate so this $effect re-runs when the screen toggle
    // flips or a video_out cable is added/removed — re-seeding the dirty flags
    // so the picture catches up the instant it becomes active again.
    void vizActive;
    lastSceneSig = '';
    lastSliceSig = '';
    slicePainted = false;
    screenOffPainted = false;
    lastSnapRef = null;
    function tick(ts: number) {
      raf = requestAnimationFrame(tick);
      if (!vizActive) {
        // Visuals are entirely OFF — paint the placeholder ONCE, do no compute.
        paintScreenOff();
        return;
      }
      // FPS throttle: bail until ~1/30 s has elapsed.
      if (ts - lastFrameTs < VIZ_FRAME_MS) return;
      lastFrameTs = ts;
      if (glReady) renderGl();
      const e = engineCtx.get();
      if (e && node) {
        // Only the on-card display draws gate on screenOn; a video_out-only
        // consumer is served by the bridge's own videoFrame() pulls.
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
      if (volTex) gl.deleteTexture(volTex);
    } catch { /* */ }
    gl = null; offscreen = null; glReady = false;
  }
  onMount(() => {
    attachEdgesObserver();
  });
  onDestroy(() => {
    if (raf !== null) cancelAnimationFrame(raf);
    if (id) uninstallCubeFrameDrawer(id);
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
    { id: 'connect_strength', label: 'CNCT STR', cable: 'cv' },
    { id: 'crush',    label: 'CRUSH',   cable: 'cv' },
    { id: 'space_crush',   label: 'SPC CRUSH', cable: 'cv' },
    { id: 'space_diffuse', label: 'SPC DIFF',  cable: 'cv' },
    { id: 'fold_cv',  label: 'FOLD',    cable: 'cv' },
    { id: 'tune',     label: 'TUNE',    cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'L', label: 'L', cable: 'audio' },
    { id: 'R', label: 'R', cable: 'audio' },
    // SYNC — a pure sine at the playback fundamental, phase-locked to the L/R
    // slice readout. Hard-sync other oscillators to CUBE or use it as a clean
    // reference / sub.
    { id: 'sync', label: 'SYNC', cable: 'audio' },
    { id: 'video_out', label: 'VIDEO', cable: 'mono-video' },
  ];

  const factoryTables = getFactoryTables();

  // Knob descriptor list (driven from the def so ranges/curves stay in sync).
  const KNOBS: Array<{ pid: string; label: string; units?: string }> = [
    { pid: 'tune', label: 'Tune', units: 'st' },
    { pid: 'fine', label: 'Fine', units: '¢' },
    { pid: 'morph_fc', label: 'Morph' },
    { pid: 'connect', label: 'Connect' },
    { pid: 'connect_strength', label: 'Cnct Str' },
    { pid: 'crush', label: 'Crush' },
    { pid: 'space_crush', label: 'Space Crush' },
    { pid: 'space_diffuse', label: 'Space Diffuse' },
    { pid: 'fold', label: 'Fold' },
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
      <!-- Visualization: all THREE views — the 3D cube (headline) on top, the
           2D SLICE cross-section + OUTPUT WAVEFORM side-by-side beneath. -->
      <div class="viz-col">
        <canvas
          bind:this={glCanvas}
          class="viz cube-viz"
          width={320}
          height={260}
          data-testid="cube-3d-viz"
        ></canvas>
        <div class="viz-row">
          <canvas
            bind:this={sliceCanvas}
            class="viz slice-viz"
            width={150}
            height={120}
            data-testid="cube-slice-viz"
          ></canvas>
          <canvas
            bind:this={waveCanvas}
            class="viz wave-viz"
            width={162}
            height={120}
            data-testid="cube-wave-viz"
          ></canvas>
        </div>
      </div>

      <!-- Wavetable selectors. The FACTORY dropdown is the steady-state source
           selector (+ the synthetic USER option so a loaded table shows its
           filename and survives reload). The PRESET dropdown + file LOAD button
           are separate (RELOAD FIX, item #1): the preset <select> resets to
           blank after each load and the file <input> resets its value, so
           re-selecting the same OR a different table ALWAYS re-fires `change`. -->
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
              {#each factoryTables as t (t.id)}
                <option value={`factory:${t.id}`}>{t.label}</option>
              {/each}
              <!-- Synthetic option so a loaded user table (source:'user') has a
                   matching <option> + the dropdown shows its filename (issue #3,
                   persists across reload since it reads node.data). -->
              {#if slotSelectValue(slot) === 'user'}
                <option value="user">USER · {slotLabel(slot)}</option>
              {/if}
            </select>
            <select
              class="wt-select preset-select"
              value={presetSelection[slot]}
              onchange={(ev) => onPresetChange(slot, ev)}
              data-testid={`cube-${slot}-preset-select`}
            >
              <option value="">— preset —</option>
              {#each WAVETABLE_PRESETS as p (p.id)}
                <option value={p.id}>{p.label}</option>
              {/each}
            </select>
            <label class="upload-btn" data-testid={`cube-${slot}-load`}>
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
        <button
          class="toggle"
          class:on={screenOn}
          onclick={toggleScreen}
          data-testid="cube-screen-toggle"
          title="SCREEN: turn the 3D viz OFF to save performance. When OFF and VIDEO is unpatched, ALL visual computation is skipped (audio keeps running)."
        >SCRN: {screenOn ? 'ON' : 'OFF'}</button>
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
  .viz-row { display: flex; gap: 6px; justify-content: center; }
  .viz { border-radius: 4px; background: #0a0c12; border: 1px solid rgba(255,255,255,0.08); }
  .cube-viz { width: 320px; height: 260px; image-rendering: auto; }
  .slice-viz { width: 150px; height: 120px; image-rendering: auto; }
  .wave-viz { width: 162px; height: 120px; }
  .wt-selects { display: flex; flex-direction: column; gap: 4px; }
  .wt-row { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
  .wt-label {
    font-family: var(--font-mono, monospace);
    font-size: 0.6rem; letter-spacing: 0.04em; color: #9fb6c9;
    width: 52px; flex: none;
  }
  .wt-select {
    flex: 1; min-width: 80px; font-size: 0.62rem; background: #1b1f29; color: #ece8e2;
    border: 1px solid rgba(255,255,255,0.12); border-radius: 3px; padding: 2px 4px;
  }
  .preset-select { flex: 0 1 96px; min-width: 70px; }
  .upload-btn {
    flex: none; display: inline-flex; align-items: center; cursor: pointer;
    font-family: var(--font-mono, monospace); font-size: 0.55rem; color: #9fb6c9;
    background: #1b1f29; border: 1px solid rgba(255,255,255,0.14);
    border-radius: 3px; padding: 2px 6px;
  }
  .upload-btn input[type='file'] { display: none; }
  .upload-btn:hover { background: #232838; color: #d9f4ff; }
  .wt-status { font-size: 0.52rem; color: #7fd6a0; white-space: nowrap; max-width: 100%; overflow: hidden; text-overflow: ellipsis; flex-basis: 100%; }
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

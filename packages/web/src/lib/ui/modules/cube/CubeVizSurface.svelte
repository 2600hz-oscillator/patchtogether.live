<script lang="ts">
  // CubeVizSurface — THE cube renderer, extracted from CubeCard.svelte so the
  // legacy card and the faceplate HERO paint the SAME picture from the SAME
  // code. It was 600-odd lines living inside the card; nothing about it was
  // card-specific except where the canvases were sized.
  //
  // ⚠ WHY EXTRACTED RATHER THAN RE-DRAWN. The face spec's cheaper route was a
  // 2-D hero that blits a reduced picture. cube's whole instrument is "a solid
  // and a cut", and the only surface anywhere that shows the CUT INSIDE THE
  // SOLID is this volume render. A reduction would have been a second, weaker
  // renderer to keep in step with the DSP — the drift class this repo keeps
  // paying for. So the hero re-houses this work; it does not replace it.
  //
  // THREE SURFACES, all of which the faceplate keeps (owner directive):
  //   1. the rotatable WebGL2 VOLUME — SLICE_LAYERS alpha-blended Z-slice quads
  //      sampling a CPU-computed field atlas, the cube wireframe, and the live
  //      slicing PLANE positioned by slice_y + slice_rx/ry/rz, orbited by the
  //      view-only camera (view_zoom / view_rot_x / view_rot_y);
  //   2. the 2-D SLICE cross-section — the field density the plane actually
  //      cuts through, as a heatmap;
  //   3. the OUTPUT waveform — the worklet's posted snapshot, i.e. the 256
  //      samples the plane read, which ARE one cycle of the sound.
  //
  // The field math is the SAME pure cube-dsp.ts the worklet + node-ART run
  // (imported by relative path, the bluebox.ts pattern), so the picture matches
  // the sound rather than approximating it.
  //
  // ⚠ THIS COMPONENT EMITS NO `control-<paramId>` TESTID (shell-cells rule 1).
  // It paints; it owns no control. WRAP / MATERIAL / SCREEN and the camera
  // knobs are param cells in their bands.
  //
  // ⚠ IT IS THE FILE THE WEBGL ATTEST BASIS NOW POINTS AT. `resolveWebglBasis`
  // auto-enrols any `.svelte` under lib/ui/modules whose source creates a WebGL
  // context, so moving `getContext('webgl2')` here moved the basis entry off
  // CubeCard.svelte and onto this file. The rendersWebGL↔card cross-check in
  // webgl-attest-coverage.test.ts follows the card's `.svelte` imports for
  // exactly this reason.

  import { onDestroy, onMount } from 'svelte';
  import { patch, ydoc } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import {
    cubeDef,
    installCubeFrameDrawer,
    uninstallCubeFrameDrawer,
    type CubeSlot,
  } from '$lib/audio/modules/cube';
  import { cubeSlotFrames, cubeSlotTableSig } from './cube-table-actions';
  import {
    columnHeights,
    fieldFromHeights,
    spaceCrushCoord,
    diffusePull,
    lowestInfoFace,
    type FieldParams,
    type DiffuseTarget,
    type Material,
  } from '../../../../../../dsp/src/lib/cube-dsp';

  interface Props {
    nodeId: string;
    /** 3-D viewport size in CSS/backing px. */
    vizW?: number;
    vizH?: number;
    /** 2-D SLICE cross-section size. */
    sliceW?: number;
    sliceH?: number;
    /** OUTPUT waveform size. */
    waveW?: number;
    waveH?: number;
    /**
     * OWN the cross-domain `video_out` frame drawer + the DRS `__cubeStep`
     * seam. Exactly ONE mounted surface per node should — the legacy card in
     * canvas mode, the hero panel under `?shell=1` (they never co-exist,
     * because `migrated('cube')` swaps one for the other). Passing false makes
     * a second surface a pure viewer.
     */
    ownsVideoOut?: boolean;
    /**
     * Drag-to-ORBIT. When given, a pointer drag across the 3-D view reports its
     * delta in CSS px and the caller writes the camera params. The surface
     * itself writes NOTHING — a renderer that owned a param write would be a
     * second, invisible source of truth beside the `view` band's knobs.
     */
    onOrbit?: (dxPx: number, dyPx: number) => void;
  }
  let {
    nodeId,
    vizW = 320,
    vizH = 260,
    sliceW = 150,
    sliceH = 120,
    waveW = 162,
    waveH = 120,
    ownsVideoOut = true,
    onOrbit,
  }: Props = $props();

  const engineCtx = useEngine();

  // ⚠ THE VERSION IS CARRIED IN THE RESULT (the ModuleShell `liveCell`
  // pattern) — a bare SyncedStore proxy is `===` to itself, so a derived that
  // read `patch.nodes[id]` alone would freeze at the values it first saw.
  let live = $derived.by(() => ({ v: nodeVersion(nodeId), n: patch.nodes[nodeId] }));
  /** The live node, for the IMPERATIVE readers (the rAF loop, the GL rebuild).
   *
   *  ⚠ IT IS NOT A REACTIVITY SOURCE, and forgetting that cost a real bug.
   *  `$derived(live.n)` returns the SAME proxy every time, so Svelte's
   *  equality check stops the update there and every downstream `$derived`
   *  built on it FREEZES AT ITS FIRST VALUE — measured: with the gate written
   *  that way, toggling SCREEN off left the volume painted (12874 lit pixels
   *  against a 2575 budget) because `screenOn` never recomputed. A reactive
   *  consumer must read `live` itself, whose identity changes with the
   *  version; see `screenOn` / `tableSig` below. */
  const node = () => live.n;

  const defaultFor = (pid: string): number =>
    cubeDef.params.find((p) => p.id === pid)?.defaultValue ?? 0;
  function paramVal(k: string): number {
    const v = node()?.params?.[k];
    return typeof v === 'number' ? v : defaultFor(k);
  }

  // CUBE video_out source port — used to detect a downstream consumer so the
  // viz can keep rendering even when the screen is toggled OFF (item #2).
  const VIDEO_OUT_PORT_ID = 'video_out';

  // ───────────────── SCREEN on/off + downstream detection (item #2) ─────────
  //
  // SCREEN OFF + video_out UNPATCHED ⇒ skip ALL visual computation (the rAF GL
  // render loop AND the display-only field/slice/wave draws). Audio is
  // untouched. When the screen is ON, *or* video_out has a downstream consumer,
  // the viz renders as normal (a patched video_out must keep emitting frames).
  let screenOn = $derived.by(() => (void live.v, paramVal('screen_on') >= 0.5));

  // patch.edges is a Yjs-backed proxy; reading it in a $derived isn't reactive
  // on its own. Mirror DoomCard's pattern: an edges-map observer bumps a real
  // $state signal so videoOutPatched re-derives when a cable is added/removed
  // (including a far-side patch in a multiplayer rack).
  let edgesVersion = $state(0);
  let videoOutPatched = $derived<boolean>(
    (void edgesVersion,
      Object.values(patch.edges ?? {}).some(
        (e) => e?.source?.nodeId === nodeId && e?.source?.portId === VIDEO_OUT_PORT_ID,
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

  // ───────────────── which wavetable each slot holds ─────────────────
  //
  // A cheap signature of WHICH table each slot currently holds, so the viz
  // rebuilds (item #1: viz updates on reload + item #3: only when it must).
  // It does NOT include frame contents — the source/label/count change on every
  // distinct table, which is enough to invalidate the cached field — and it is
  // the SAME function `cubeSlotFrames` memoises on, so the picture and its
  // frames can never disagree about whether a table moved.
  let tableSig = $derived.by(() =>
    (void live.v,
      (['floor', 'wall', 'ceiling'] as CubeSlot[])
        .map((slot) => cubeSlotTableSig(node(), slot))
        .join('|')));

  /**
   * The three tables' frames.
   *
   * ⚠ THE ENGINE IS THE PREFERRED SOURCE BUT NOT THE ONLY ONE, and that is what
   * lets this surface paint in the faceplate. `engine.read(node,'frames')`
   * returns exactly what was posted to the worklet, so it is the truth when a
   * live node exists; `resolveSlotFrames` recomputes the identical thing from
   * `node.data` alone (it is the function the factory itself calls), so a
   * hero panel on a graph with no engine — a VRT capture, a headless render —
   * draws the real field instead of a black box. Memoised in
   * `cube-table-actions` on WHICH table each slot holds, because the fallback
   * would otherwise copy every frame on every call.
   */
  type CubeFrames = {
    floor: readonly Float32Array[];
    wall: readonly Float32Array[];
    ceiling: readonly Float32Array[];
  };
  function frames(): CubeFrames | undefined {
    const e = engineCtx.get();
    const n = node();
    const fr = (e && n ? e.read(n, 'frames') as CubeFrames | undefined : undefined);
    if (fr && fr.floor.length && fr.wall.length && fr.ceiling.length) return fr;
    // `cubeSlotFrames` memoises on WHICH table the slot holds, so this costs a
    // map lookup per frame rather than ~50 k float copies.
    return {
      floor: cubeSlotFrames(n, 'floor'),
      wall: cubeSlotFrames(n, 'wall'),
      ceiling: cubeSlotFrames(n, 'ceiling'),
    };
  }

  // ═══════════════ 3D CUBE VISUALIZATION (WebGL2) — issue #2 ═══════════════
  //
  // Renders the actual 3D box: the scalar field as a back-to-front alpha-blended
  // stack of axis-aligned Z-slices (translucent voxel volume) sampling a small
  // CPU-computed field texture, the live selection slice as a square plane
  // cutting through it, the cube wireframe for orientation, and the OUTPUT
  // waveform from the worklet snapshot as a 2D overlay. The view-only camera
  // (view_zoom / view_rot_x/y) orbits the scene.

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
    const fr = frames();
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
    const n = node();
    if (e && n) { const v = e.readParam(n, pid); if (typeof v === 'number') return v; }
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
      const frd = frames();
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

    // The GL scene renders square (RES×RES) then blits to the (non-square)
    // canvas via drawImage, which stretches it. Pre-compensate by setting the
    // projection aspect to the visible canvas aspect so the cube stays
    // undistorted after the stretch.
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
    // Blit to the visible 3D canvas only when the screen is ON. When the screen
    // is OFF but video_out is patched we still RENDER into `offscreen` (so the
    // bridge frame is live) but the surface itself shows the placeholder.
    if (glCanvas && screenOn) blitCube(glCanvas);
    else if (glCanvas && !screenOn) { screenOffPainted = false; paintScreenOff(); }
    return true;
  }

  // Blit the just-rendered GL scene (in `offscreen`) onto a target 2D canvas
  // and stamp the CUBE label. Used for both the visible canvas and the
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
  // so the floor / ceiling contribution is visible (not just the wall).
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
    const fr = frames();
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
  // get a freshly-rendered scene regardless of the on-surface scene-dirty skip.
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

  // Paint the visible 3D canvas a flat "screen off" panel (only when actually
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

  // ---- DRS card-step seam (deterministic render-smoke; e2e only) ----
  // CUBE's viz is param + audio-snapshot driven (NOT time-animated — rotation is
  // the view_rot_* params, not a clock), so a deterministic render just needs a
  // forced SYNCHRONOUS frame that bypasses the 30 FPS throttle + pauses the rAF
  // self-schedule so the test owns the frame count. __cubeStep() drives one
  // tick() (full render) and returns the mode-agnostic counter. No prod effect
  // (the flag is never set). Mirrors WavesculptCard's __wavesculptStep.
  let cubeStepMode = false;
  let cubeStepCount = 0;
  let cubeTickRef: ((ts: number) => void) | null = null;

  $effect(() => {
    if (!glReady && !glFailed) initGl();
    if (ownsVideoOut && nodeId) installCubeFrameDrawer(nodeId, videoFrame);
    // Read the reactive viz gate so this $effect re-runs when the screen toggle
    // flips or a video_out cable is added/removed — re-seeding the dirty flags
    // so the picture catches up the instant it becomes active again.
    void vizActive;
    lastSceneSig = '';
    lastSliceSig = '';
    slicePainted = false;
    screenOffPainted = false;
    lastSnapRef = null;
    cubeTickRef = tick;
    function tick(ts: number) {
      cubeStepCount++; // mode-agnostic frame counter for the DRS step seam
      // In step-mode the test drives frames synchronously — don't self-schedule
      // (the test owns the count) and don't throttle (render every driven frame).
      if (!cubeStepMode) raf = requestAnimationFrame(tick);
      if (!vizActive) {
        // Visuals are entirely OFF — paint the placeholder ONCE, do no compute.
        paintScreenOff();
        return;
      }
      // FPS throttle: bail until ~1/30 s has elapsed (skipped when step-driving).
      if (!cubeStepMode && ts - lastFrameTs < VIZ_FRAME_MS) return;
      lastFrameTs = ts;
      if (glReady) renderGl();
      const e = engineCtx.get();
      const n = node();
      if (e && n) {
        // Only the visible display draws gate on screenOn; a video_out-only
        // consumer is served by the bridge's own videoFrame() pulls.
        if (screenOn) {
          const snap = e.read(n, 'snapshot') as Float32Array | undefined;
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
    if (!ownsVideoOut) return;
    // DRS card-step seam (e2e only): drive ONE synchronous viz frame (full
    // render, throttle bypassed) + halt the rAF self-schedule so the test owns
    // the frame count. Returns the mode-agnostic counter for an exact delta.
    const g = globalThis as unknown as {
      __cubeStep?: (t?: number) => number;
      __cubeStepCount?: () => number;
    };
    g.__cubeStep = (t?: number) => {
      cubeStepMode = true;
      if (raf !== null) { cancelAnimationFrame(raf); raf = null; }
      cubeTickRef?.(typeof t === 'number' ? t : 0);
      return cubeStepCount;
    };
    g.__cubeStepCount = () => cubeStepCount;
  });
  // ---- drag-to-orbit (opt-in via `onOrbit`) ----
  // Pointer capture so a drag that leaves the canvas keeps orbiting, and the
  // delta is reported per MOVE (not accumulated here) so the caller decides
  // the sensitivity and the clamp against the def's declared range.
  let orbiting = $state(false);
  let lastX = 0;
  let lastY = 0;
  function orbitDown(ev: PointerEvent): void {
    if (!onOrbit) return;
    orbiting = true;
    lastX = ev.clientX; lastY = ev.clientY;
    (ev.currentTarget as HTMLElement).setPointerCapture?.(ev.pointerId);
    ev.preventDefault();
  }
  function orbitMove(ev: PointerEvent): void {
    if (!orbiting || !onOrbit) return;
    const dx = ev.clientX - lastX, dy = ev.clientY - lastY;
    lastX = ev.clientX; lastY = ev.clientY;
    if (dx !== 0 || dy !== 0) onOrbit(dx, dy);
  }
  function orbitUp(ev: PointerEvent): void {
    if (!orbiting) return;
    orbiting = false;
    (ev.currentTarget as HTMLElement).releasePointerCapture?.(ev.pointerId);
  }

  onDestroy(() => {
    if (raf !== null) cancelAnimationFrame(raf);
    if (ownsVideoOut && nodeId) uninstallCubeFrameDrawer(nodeId, videoFrame);
    if (edgesObserver) { edgesObserver(); edgesObserver = null; }
    disposeGl();
  });
</script>

<div class="viz-col">
  <canvas
    bind:this={glCanvas}
    class="viz cube-viz"
    class:orbitable={!!onOrbit}
    width={vizW}
    height={vizH}
    style="width:{vizW}px;height:{vizH}px"
    data-testid="cube-3d-viz"
    onpointerdown={orbitDown}
    onpointermove={orbitMove}
    onpointerup={orbitUp}
    onpointercancel={orbitUp}
  ></canvas>
  <div class="viz-row">
    <canvas
      bind:this={sliceCanvas}
      class="viz slice-viz"
      width={sliceW}
      height={sliceH}
      style="width:{sliceW}px;height:{sliceH}px"
      data-testid="cube-slice-viz"
    ></canvas>
    <canvas
      bind:this={waveCanvas}
      class="viz wave-viz"
      width={waveW}
      height={waveH}
      style="width:{waveW}px;height:{waveH}px"
      data-testid="cube-wave-viz"
    ></canvas>
  </div>
</div>

<style>
  .viz-col { display: flex; flex-direction: column; gap: 6px; align-items: center; }
  .viz-row { display: flex; gap: 6px; justify-content: center; }
  .viz { border-radius: 4px; background: #0a0c12; border: 1px solid rgba(255,255,255,0.08); }
  .cube-viz { image-rendering: auto; }
  .cube-viz.orbitable { cursor: grab; touch-action: none; }
  .cube-viz.orbitable:active { cursor: grabbing; }
  .slice-viz { image-rendering: auto; }
</style>

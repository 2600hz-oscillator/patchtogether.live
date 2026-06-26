// packages/web/src/lib/blood/blood-runtime.ts
//
// Thin TypeScript shim around the NBlood WASM build at /blood/blood.js
// (+ blood.wasm) — the BLOOD analogue of doom-runtime.ts. It drives the
// `bpt_*` ("Blood PatchTogether") C-export seam:
//
//   const { runtime } = await BloodRuntime.load();
//   await runtime.init(dataFiles);   // writes user RFFs into MEMFS, boots engine
//   runtime.runFrame();              // resume app_main to the next presented frame
//   runtime.setKey(SC_UP_ARROW, true);
//   const fb = runtime.getFramebuffer();   // RGBA8 view (xres*yres*4)
//   runtime.dispose();
//
// Framebuffer views are ZERO-COPY into WASM linear memory; refreshed lazily on
// each getFramebuffer (ALLOW_MEMORY_GROWTH invalidates old views).
//
// The engine's app_main is a blocking loop driven via ASYNCIFY (see
// native/nblood/bloodgeneric_patchtogether.cpp): bpt_init boots it to the first
// presented frame + suspends; each bpt_tick resumes it to the next frame.
//
// DATA: Blood game files (BLOOD.RFF / GUI.RFF / SOUNDS.RFF / TILES000.ART / …)
// are user-supplied + NOT redistributable (native/nblood/PHASE0-STATUS.md §3).
// Without them the engine aborts in its resource loader, so the card shows a
// "Blood data missing — run `task setup:blood`" overlay (no out-of-box play).

/** The subset of the emcc Module surface our shim talks to. */
export interface BloodModule {
  HEAPU8: Uint8Array;
  HEAPU32: Uint32Array;
  HEAPF32: Float32Array;
  ccall: (
    name: string,
    returnType: 'number' | 'string' | null,
    argTypes: Array<'number' | 'string'>,
    args: Array<number | string>,
  ) => number;
  FS: {
    writeFile: (path: string, data: Uint8Array) => void;
    mkdir?: (path: string) => void;
    chdir?: (path: string) => void;
    analyzePath?: (path: string) => { exists: boolean };
  };
}

export type BloodModuleLoader = () => Promise<BloodModule>;

/** A user-supplied Blood data file written into MEMFS before boot. */
export interface BloodDataFile {
  name: string; // e.g. 'BLOOD.RFF'
  bytes: Uint8Array;
}

export interface BloodLoadResult {
  runtime: BloodRuntime | null;
  error?: string;
}

const WASM_SHIM_URL = '/blood/blood.js';
const DATA_DIR_URL = '/blood'; // served static dir (user-supplied via task setup:blood)

// The required data files Blood loads at startup (blood.cpp: gSysRes/gGuiRes/
// gSoundRes.Init). TILES000.ART carries the tile art the renderer needs.
export const BLOOD_REQUIRED_FILES = ['BLOOD.RFF', 'GUI.RFF', 'SOUNDS.RFF'] as const;

/** Fetch the user-supplied Blood data files from /blood/. Returns the files
 *  present + a list of any REQUIRED ones that are missing (the card surfaces
 *  "data missing"). We never ship these — they're user-provided. */
export async function loadBloodData(): Promise<{ files: BloodDataFile[]; missing: string[] }> {
  const files: BloodDataFile[] = [];
  const missing: string[] = [];
  for (const name of BLOOD_REQUIRED_FILES) {
    try {
      const r = await fetch(`${DATA_DIR_URL}/${name}`);
      if (!r.ok) {
        missing.push(name);
        continue;
      }
      files.push({ name, bytes: new Uint8Array(await r.arrayBuffer()) });
    } catch {
      missing.push(name);
    }
  }
  return { files, missing };
}

/** Dynamic-import the emcc ES-module shim. Surfaces "not built yet" cleanly
 *  (a contributor who hasn't run build-blood-wasm.sh gets a 404). */
export async function loadBloodModule(): Promise<{ module: BloodModule | null; error?: string }> {
  try {
    const mod = (await import(/* @vite-ignore */ WASM_SHIM_URL)) as { default: BloodModuleLoader };
    const loaded = await mod.default();
    return { module: loaded };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('404') || msg.toLowerCase().includes('not found')) {
      return {
        module: null,
        error:
          'BLOOD WASM not built. Run `BLOOD_LINK=1 bash packages/web/native/build-blood-wasm.sh` to generate /blood/blood.js + blood.wasm.',
      };
    }
    return { module: null, error: msg };
  }
}

export class BloodRuntime {
  private mod: BloodModule;
  private initialized = false;
  private fbPtr = 0;
  private fbSize = 0;
  private resX = 0;
  private resY = 0;

  constructor(module: BloodModule) {
    this.mod = module;
  }

  static async load(): Promise<BloodLoadResult> {
    const { module, error } = await loadBloodModule();
    if (!module) return { runtime: null, error };
    return { runtime: new BloodRuntime(module) };
  }

  /** Write the user-supplied data files into MEMFS, then boot the engine to its
   *  first presented frame (bpt_init runs app_main on the ASYNCIFY stack until
   *  the first videoShowFrame). Throws the engine's abort message if data is
   *  missing (the card catches + shows the data-missing overlay). */
  init(files: BloodDataFile[]): void {
    if (this.initialized) return;
    try {
      this.mod.FS.mkdir?.('/blood');
    } catch {
      /* may exist */
    }
    let total = 0;
    for (const f of files) {
      this.mod.FS.writeFile(`/blood/${f.name}`, f.bytes);
      total += f.bytes.length;
    }
    // app_main searches the cwd for the RFFs; chdir into the data dir.
    try {
      this.mod.FS.chdir?.('/blood');
    } catch {
      /* */
    }
    this.mod.ccall('bpt_init', null, ['number'], [total]);
    this.fbPtr = this.mod.ccall('bpt_get_framebuffer', 'number', [], []);
    this.fbSize = this.mod.ccall('bpt_get_framebuffer_size', 'number', [], []);
    this.resX = this.mod.ccall('bpt_get_resx', 'number', [], []);
    this.resY = this.mod.ccall('bpt_get_resy', 'number', [], []);
    this.initialized = true;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  /** True once the engine has presented at least one frame. */
  hasFrame(): boolean {
    if (!this.initialized) return false;
    return this.mod.ccall('bpt_has_frame', 'number', [], []) !== 0;
  }

  resolution(): { width: number; height: number } {
    // Re-read each call: the engine sets the video mode after init, so the
    // framebuffer dims may grow once the first real frame is painted.
    if (this.initialized) {
      this.resX = this.mod.ccall('bpt_get_resx', 'number', [], []);
      this.resY = this.mod.ccall('bpt_get_resy', 'number', [], []);
      this.fbPtr = this.mod.ccall('bpt_get_framebuffer', 'number', [], []);
      this.fbSize = this.mod.ccall('bpt_get_framebuffer_size', 'number', [], []);
    }
    return { width: this.resX, height: this.resY };
  }

  /** Resume the suspended app_main to the next presented frame. */
  runFrame(): void {
    if (!this.initialized) return;
    this.mod.ccall('bpt_tick', null, [], []);
  }

  /** Push one Build scancode event into the engine input queue. */
  setKey(scancode: number, pressed: boolean): void {
    if (!this.initialized) return;
    this.mod.ccall('bpt_set_key', null, ['number', 'number'], [scancode & 0xff, pressed ? 1 : 0]);
  }

  /** Zero-copy RGBA8 view of the current framebuffer (xres*yres*4). Do NOT
   *  cache across frames (memory growth + res change invalidate the pointer). */
  getFramebuffer(): Uint8ClampedArray | null {
    if (!this.initialized || !this.fbPtr || this.fbSize <= 0) return null;
    const heap = this.mod.HEAPU8;
    return new Uint8ClampedArray(heap.buffer, this.fbPtr, this.fbSize);
  }

  dispose(): void {
    this.initialized = false;
  }
}

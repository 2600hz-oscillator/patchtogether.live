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
// gSoundRes.Init). These three MUST be present or the engine aborts in its
// resource loader; their absence is what the card reports as "missing".
export const BLOOD_REQUIRED_FILES = ['BLOOD.RFF', 'GUI.RFF', 'SOUNDS.RFF'] as const;

// The full BUNDLED 1997 Blood SHAREWARE data set. The 3 REQUIRED RFFs above
// plus the engine data tables (SURFACE/TABLES/VOXEL.DAT), the shareware tile
// art (SHARE000.ART — the shareware analogue of the full game's TILES000.ART),
// and the episode descriptor BLOOD.INI. These ship in static/blood/ (un-ignored
// in .gitignore, LFS-tracked) so the BLOOD card boots OUT-OF-BOX on the
// beta-gated deploys with no picker. The extra (non-RFF) files are fetched
// best-effort: present → written into MEMFS; absent → silently skipped (only the
// REQUIRED set gates the "missing" prompt).
//
// BLOOD.INI is the plain-text episode/level table the game reads on boot
// (levels.cpp → levelLoadDefaults); without it the engine aborts at
// "Initialization: BLOOD.INI does not exist". It is NOT inside BLOOD.RFF — the
// shareware ships it as a separate on-disk file — so it MUST be in this bundle.
export const BLOOD_BUNDLED_FILES = [
  'BLOOD.RFF',
  'GUI.RFF',
  'SOUNDS.RFF',
  'SURFACE.DAT',
  'TABLES.DAT',
  'VOXEL.DAT',
  'SHARE000.ART',
  'BLOOD.INI',
] as const;

// ── In-browser injected data (the HOSTED-preview path) ─────────────────────
// The owner can't drop proprietary Blood data onto the hosted server, so the
// card lets them PICK their files in-browser; those bytes are registered here.
// `loadBloodData()` prefers injected files over the server fetch — so the same
// runtime works both locally (where `task setup:blood` populated static/blood)
// AND on the hosted CF Pages preview (where the owner supplies their own data).
let injectedFiles: BloodDataFile[] = [];

/** Register user-picked / IndexedDB-restored Blood data. These take PRIORITY
 *  over the server fetch in loadBloodData(). Names are canonicalised UPPER to
 *  match the engine's resource loader (it looks for BLOOD.RFF, not blood.rff). */
export function setInjectedBloodData(files: BloodDataFile[]): void {
  injectedFiles = files.map((f) => ({ name: f.name.toUpperCase(), bytes: f.bytes }));
}

/** Clear any injected data (back to the server-fetch path). */
export function clearInjectedBloodData(): void {
  injectedFiles = [];
}

/** True when in-browser data has been injected this session. */
export function hasInjectedBloodData(): boolean {
  return injectedFiles.length > 0;
}

/** Resolve the Blood data files + any REQUIRED ones still missing.
 *  PRIORITY: injected (in-browser-picked / IndexedDB-restored) files first;
 *  only fall back to the /blood/ server fetch when nothing is injected (the
 *  local `task setup:blood` path). The card surfaces `missing` as the
 *  "load your data" prompt. We never ship these — they're user-provided. */
export async function loadBloodData(): Promise<{ files: BloodDataFile[]; missing: string[] }> {
  // Injected (in-browser) data wins — this is the hosted-preview path.
  if (injectedFiles.length > 0) {
    const byName = new Map(injectedFiles.map((f) => [f.name.toUpperCase(), f]));
    const missing = BLOOD_REQUIRED_FILES.filter((n) => !byName.has(n));
    // Pass ALL injected files through (extra ART/DAT the owner included are
    // written into MEMFS too), but report only the REQUIRED ones as missing.
    return { files: injectedFiles, missing: [...missing] };
  }

  // Fallback: fetch from the served static dir. On the beta-gated deploys this
  // is the BUNDLED 1997 shareware (committed to static/blood/), so the card
  // boots OUT-OF-BOX. Locally it's whatever `task setup:blood` populated. We
  // fetch the FULL bundled set; only the REQUIRED RFFs gate the "missing"
  // prompt (the extra DAT/ART are best-effort — skipped if absent).
  const files: BloodDataFile[] = [];
  const missing: string[] = [];
  const required = new Set<string>(BLOOD_REQUIRED_FILES);
  for (const name of BLOOD_BUNDLED_FILES) {
    try {
      const r = await fetch(`${DATA_DIR_URL}/${name}`);
      if (!r.ok) {
        if (required.has(name)) missing.push(name);
        continue;
      }
      files.push({ name, bytes: new Uint8Array(await r.arrayBuffer()) });
    } catch {
      if (required.has(name)) missing.push(name);
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

// packages/web/src/lib/snes9x/snes9x-runtime.ts
//
// Thin TypeScript shim around the snes9x2005 WASM build at /snes9x/snes9x.js
// (+ snes9x.wasm), mirroring doom-runtime.ts. The shim provides a small
// class-shaped surface the SNES9X module factory drives:
//
//   const rt = await Snes9xRuntime.load();
//   rt.loadRom(romBytes);          // → boolean
//   rt.runFrame();
//   rt.setInput(mask);             // RETRO_DEVICE_ID_JOYPAD_* bitmask
//   const fb = rt.getFramebuffer();// Uint8ClampedArray (RGBA8888), zero-copy
//   const a  = rt.getAudio();      // Int16Array stereo-interleaved, zero-copy
//   const wram = rt.getWram();     // Uint8Array (128 KB), zero-copy
//   rt.readWram(0x0100);           // byte
//   rt.dispose();
//
// All HEAP views are ZERO-COPY into the WASM linear memory; when the memory
// grows (ALLOW_MEMORY_GROWTH=1) the cached views go stale, so we refresh
// the relevant view lazily on each accessor call (same pattern DOOM uses).
//
// The actual WASM is loaded via a dynamic import of the emcc ES-module shim
// (-sMODULARIZE -sEXPORT_ES6 -sEXPORT_NAME=loadSnes9x). Tested via
// snes9x-runtime.test.ts which stubs the module exports directly (no emcc,
// no .wasm download); the real WASM path is exercised by the snes9x e2e.

/** Subset of the emcc Module surface our shim talks to. */
export interface Snes9xModule {
  HEAPU8: Uint8Array;
  HEAPU16: Uint16Array;
  HEAPU32: Uint32Array;
  HEAP16: Int16Array;
  _malloc: (n: number) => number;
  _free: (p: number) => void;
  _snes_init: () => void;
  _snes_load_rom: (ptr: number, len: number) => number;
  _snes_rom_loaded: () => number;
  _snes_run_frame: () => void;
  _snes_get_framebuffer: () => number;
  _snes_get_fb_width: () => number;
  _snes_get_fb_height: () => number;
  _snes_get_audio_buffer: () => number;
  _snes_get_audio_frames: () => number;
  _snes_set_input: (mask: number) => void;
  _snes_get_wram: () => number;
  _snes_get_wram_size: () => number;
  _snes_read_wram: (addr: number) => number;
}

export type Snes9xModuleLoader = (opts?: Record<string, unknown>) => Promise<Snes9xModule>;

const WASM_SHIM_URL = '/snes9x/snes9x.js';

/** Locked SNES video/audio modes (no user control, per spec). */
export const SNES_NATIVE_WIDTH = 256;
export const SNES_NATIVE_HEIGHT_MAX = 239;
export const SNES_AUDIO_SAMPLE_RATE = 32000;
export const SNES_WRAM_SIZE = 0x20000; // 128 KB

export class Snes9xRuntime {
  private mod: Snes9xModule;
  private romLoaded = false;

  private constructor(mod: Snes9xModule) {
    this.mod = mod;
  }

  /** Dynamically import the emcc shim + initialise the core. Returns a
   *  ready runtime or throws with a clear reason (caller renders an
   *  overlay). The loader can be injected for tests. */
  static async load(loader?: Snes9xModuleLoader): Promise<Snes9xRuntime> {
    let load: Snes9xModuleLoader;
    if (loader) {
      load = loader;
    } else {
      // @vite-ignore — the URL is a runtime static asset, not a bundled module.
      const m = (await import(/* @vite-ignore */ WASM_SHIM_URL)) as {
        default: Snes9xModuleLoader;
      };
      load = m.default;
    }
    const mod = await load();
    mod._snes_init();
    return new Snes9xRuntime(mod);
  }

  /** Load a ROM from raw bytes. Returns true on success. */
  loadRom(bytes: Uint8Array): boolean {
    const ptr = this.mod._malloc(bytes.length);
    if (!ptr) return false;
    try {
      this.mod.HEAPU8.set(bytes, ptr);
      const ok = this.mod._snes_load_rom(ptr, bytes.length) === 1;
      this.romLoaded = ok;
      return ok;
    } finally {
      this.mod._free(ptr);
    }
  }

  isRomLoaded(): boolean {
    return this.romLoaded && this.mod._snes_rom_loaded() === 1;
  }

  /** Advance one emulated frame. No-op until a ROM is loaded. */
  runFrame(): void {
    if (!this.romLoaded) return;
    this.mod._snes_run_frame();
  }

  /** Set the player-1 joypad button bitmask (RETRO_DEVICE_ID_JOYPAD_*). */
  setInput(mask: number): void {
    this.mod._snes_set_input(mask | 0);
  }

  getFbWidth(): number { return this.mod._snes_get_fb_width(); }
  getFbHeight(): number { return this.mod._snes_get_fb_height(); }

  /** Zero-copy RGBA8888 framebuffer view (width*height*4 bytes). The view
   *  is re-derived each call so heap-growth can't leave it stale. */
  getFramebuffer(): Uint8ClampedArray {
    const w = this.getFbWidth();
    const h = this.getFbHeight();
    const ptr = this.mod._snes_get_framebuffer() >>> 0;
    const buf = this.mod.HEAPU8.buffer;
    return new Uint8ClampedArray(buf, ptr, w * h * 4);
  }

  /** Zero-copy interleaved S16 stereo audio written THIS frame. Length =
   *  frames*2 (L,R,L,R,…). Empty when no audio this frame. */
  getAudio(): Int16Array {
    const frames = this.mod._snes_get_audio_frames();
    if (frames <= 0) return new Int16Array(0);
    const ptr = this.mod._snes_get_audio_buffer() >>> 0;
    const buf = this.mod.HEAP16.buffer;
    // HEAP16 is Int16, ptr is a byte offset → divide by 2 for element index.
    return new Int16Array(buf, ptr, frames * 2);
  }

  /** Zero-copy 128 KB SNES WRAM view (= retro_get_memory_data SYSTEM_RAM). */
  getWram(): Uint8Array {
    const ptr = this.mod._snes_get_wram() >>> 0;
    const size = this.mod._snes_get_wram_size() || SNES_WRAM_SIZE;
    if (!ptr) return new Uint8Array(0);
    return new Uint8Array(this.mod.HEAPU8.buffer, ptr, size);
  }

  /** Read a single WRAM byte (addr & 0x1FFFF). */
  readWram(addr: number): number {
    return this.mod._snes_read_wram(addr | 0);
  }

  dispose(): void {
    // The emcc module + its linear memory are GC'd with the runtime object.
    // No explicit teardown export (the core has no allocation we own beyond
    // the per-load ROM blob, which we free immediately). Kept for symmetry
    // with the DOOM runtime's dispose().
    this.romLoaded = false;
  }
}

/**
 * Fetch the autoload ROM from the static dir (DOOM-style Cache API
 * fallback). Returns the bytes, or null + a reason when absent (the
 * default clean-checkout / cloud-deploy state — the card then shows the
 * load-a-ROM dropzone). Exposed so the module factory + tests share one
 * fetch path; the test harness can stub `fetch`.
 */
export const AUTOLOAD_ROM_URL = '/roms/snes9x/game.sfc';

export async function loadAutoloadRom(): Promise<{ bytes: Uint8Array | null; error?: string }> {
  try {
    const r = await fetch(AUTOLOAD_ROM_URL);
    if (!r.ok) {
      return { bytes: null, error: `no autoload ROM (fetch ${r.status}) — load one` };
    }
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (bytes.length === 0) {
      return { bytes: null, error: 'autoload ROM empty — load one' };
    }
    return { bytes };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { bytes: null, error: `autoload ROM fetch failed: ${msg}` };
  }
}

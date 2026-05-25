// packages/web/src/lib/doom/doom-runtime.ts
//
// Thin TypeScript shim around the doomgeneric WASM build at
// /doom/doom.js (+ doom.wasm). The shim provides a tiny class-shaped
// surface that the video-domain DOOM module factory drives:
//
//   const runtime = await DoomRuntime.load();
//   await runtime.init(wadBytes);
//   runtime.runTic();
//   runtime.setKey(KEY_RIGHTARROW, true);
//   const fb = runtime.getFramebuffer();   // Uint8ClampedArray view
//   const pcm = runtime.getPcmBuffer();    // Float32Array view (slice 8)
//   runtime.dispose();
//
// All HEAP views are ZERO-COPY into the WASM linear memory (we do NOT
// clone on every frame — at 640×400 RGBA that's 1 MB per frame, and at
// 60 fps that's 60 MB/s of pointless copies). When the linear memory
// grows (sALLOW_MEMORY_GROWTH=1) the cached views become stale; the
// shim refreshes them lazily on every getFramebuffer/getPcmBuffer call.
//
// The actual WASM blob is loaded via a dynamic import of the static
// ES-module shim emcc generates. We accept the runtime cost (one fetch
// per module instance, but the browser caches both .js and .wasm
// aggressively) in exchange for build-system simplicity — no
// Emscripten-specific Vite plugin needed.
//
// Tested via doom-runtime.test.ts which stubs the WASM module exports
// directly (no emcc, no .wasm download). The real WASM path is
// exercised by the doom.spec.ts e2e suite.

import {
  KEY_FOR_KEYBOARD_CODE,
  KEY_FOR_CV_GATE,
  type CvGatePortId,
} from './doomkeys';

/**
 * The subset of the emcc-generated module surface our shim talks to.
 * Exposing it as an interface keeps the test path mock-friendly + makes
 * the C/JS contract searchable.
 */
export interface DoomModule {
  /** Linear-memory typed-array views. Refreshed on each access in case
   *  ALLOW_MEMORY_GROWTH=1 has caused the underlying ArrayBuffer to be
   *  swapped out from under us. */
  HEAPU8: Uint8Array;
  HEAPU32: Uint32Array;
  HEAPF32: Float32Array;
  /** Emcc cwrap/ccall surface. We call by name (ccall) to keep the
   *  TypeScript wrapper one function-pointer narrower than direct
   *  _function-name access. */
  ccall: (
    name: string,
    returnType: 'number' | 'string' | null,
    argTypes: Array<'number' | 'string'>,
    args: Array<number | string>,
  ) => number;
  /** Convenience method to write bytes into Emscripten's MEMFS. The
   *  emcc-generated shim exposes FS as a top-level prop only when
   *  -sFORCE_FILESYSTEM=1 is on. */
  FS: {
    writeFile: (path: string, data: Uint8Array) => void;
    readFile?: (path: string) => Uint8Array;
  };
}

/** Loader signature emcc gives us when we build with -sMODULARIZE=1
 *  -sEXPORT_ES6=1 -sEXPORT_NAME=loadDoom. */
export type DoomModuleLoader = () => Promise<DoomModule>;

/** Result of loadDoomModule: the fully-initialized emcc Module instance.
 *  Lazy because the .wasm fetch is async + we want to surface "not built
 *  yet" cleanly (no exception, just `null` so the card can render a
 *  helpful overlay). */
export interface DoomLoadResult {
  module: DoomModule | null;
  /** When module is null, this carries the reason. */
  error?: string;
}

const WASM_SHIM_URL = '/doom/doom.js';
const WAD_URL = '/doom/DOOM1.WAD';
const WAD_CACHE_NAME = 'doom-wads';

/**
 * Fetch the WAD with a Cache API fallback. First call hits the network
 * + caches; subsequent module spawns hit the cache immediately.
 *
 * Returns null + an explanation if (a) the WAD isn't on the server (404)
 * or (b) the browser doesn't expose the Cache API. The card shows an
 * overlay in either case.
 */
export async function loadWad(): Promise<{ bytes: Uint8Array | null; error?: string }> {
  try {
    if (typeof caches !== 'undefined') {
      const cache = await caches.open(WAD_CACHE_NAME);
      const cached = await cache.match(WAD_URL);
      if (cached) {
        return { bytes: new Uint8Array(await cached.arrayBuffer()) };
      }
      const r = await fetch(WAD_URL);
      if (!r.ok) return { bytes: null, error: `WAD fetch ${r.status} ${r.statusText}` };
      // Clone before reading the body twice (once to cache, once to use).
      const clone = r.clone();
      void cache.put(WAD_URL, clone);
      return { bytes: new Uint8Array(await r.arrayBuffer()) };
    }
    // No Cache API — fetch every spawn.
    const r = await fetch(WAD_URL);
    if (!r.ok) return { bytes: null, error: `WAD fetch ${r.status} ${r.statusText}` };
    return { bytes: new Uint8Array(await r.arrayBuffer()) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { bytes: null, error: `WAD load failed: ${msg}` };
  }
}

/**
 * Dynamically import the emcc-generated ES-module shim. Wrapped because
 * Vite's static analyzer chokes on dynamic imports with full URLs (vs.
 * relative paths), and because we want a single try/catch around the
 * whole load path. We pass the URL through the vite-ignore inline
 * comment (see the import() expression below) so Vite leaves the path
 * alone at build time (the file may not exist yet in dev — contributors
 * haven't run build-doom-wasm.sh).
 */
export async function loadDoomModule(): Promise<DoomLoadResult> {
  try {
    // @vite-ignore — the WASM shim lives in static/ and is fetched at
    // runtime; we don't want Vite trying to bundle it.
    const mod = (await import(/* @vite-ignore */ WASM_SHIM_URL)) as {
      default: DoomModuleLoader;
    };
    const loaded = await mod.default();
    return { module: loaded };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Common case: emcc hasn't been run yet → 404 on /doom/doom.js.
    // Surface a hint pointing at the build script.
    if (msg.includes('404') || msg.toLowerCase().includes('not found')) {
      return {
        module: null,
        error:
          'DOOM WASM not built. Run `bash packages/web/native/build-doom-wasm.sh` to generate /doom/doom.js + doom.wasm.',
      };
    }
    return { module: null, error: msg };
  }
}

// ---------------- DoomRuntime ----------------

/**
 * Object-shaped facade over the WASM module. Encapsulates HEAP-view
 * refreshing + the `dgpt_*` C export call signatures.
 *
 * Construction is async (load + init). For tests, pass a pre-built
 * `DoomModule` directly to the constructor — no fetch needed.
 */
export class DoomRuntime {
  private mod: DoomModule;
  private initialized = false;

  /** Cached HEAP base pointers — refreshed on each frame because
   *  -sALLOW_MEMORY_GROWTH=1 lets the engine grow linear memory, which
   *  invalidates Uint8Array views over the old ArrayBuffer. */
  private fbPtr = 0;
  private fbSize = 0;
  private pcmPtr = 0;
  private pcmSampleCount = 0;
  private resX = 640;
  private resY = 400;

  constructor(module: DoomModule) {
    this.mod = module;
  }

  /** Fetch + dynamic-import path. The async factory most callers use. */
  static async load(): Promise<{ runtime: DoomRuntime | null; error?: string }> {
    const { module, error } = await loadDoomModule();
    if (!module) return { runtime: null, error };
    return { runtime: new DoomRuntime(module) };
  }

  /**
   * Write `wadBytes` into MEMFS at /doom1.wad then call dgpt_init. After
   * this, runTic() is safe to call.
   */
  init(wadBytes: Uint8Array): void {
    if (this.initialized) return;
    this.mod.FS.writeFile('/doom1.wad', wadBytes);
    this.mod.ccall('dgpt_init', null, ['number'], [wadBytes.length]);
    // Cache the framebuffer + PCM pointers + their sizes (constants per
    // run — DOOMGENERIC_RESX/Y are compile-time, the PCM buffer is too).
    this.fbPtr = this.mod.ccall('dgpt_get_framebuffer', 'number', [], []);
    this.fbSize = this.mod.ccall('dgpt_get_framebuffer_size', 'number', [], []);
    this.pcmPtr = this.mod.ccall('dgpt_get_pcm_buffer', 'number', [], []);
    this.pcmSampleCount = this.mod.ccall('dgpt_get_pcm_buffer_size', 'number', [], []);
    this.resX = this.mod.ccall('dgpt_get_resx', 'number', [], []);
    this.resY = this.mod.ccall('dgpt_get_resy', 'number', [], []);
    this.initialized = true;
  }

  isInitialized(): boolean { return this.initialized; }

  /** Game width × height. Useful for the card to compute aspect-correct
   *  letterboxing without round-tripping through the GL shader. */
  resolution(): { width: number; height: number } {
    return { width: this.resX, height: this.resY };
  }

  /**
   * Run one game tic. Bump the engine's internal clock by `msDelta` first
   * (so doomgeneric's `DG_GetTicksMs` returns a wall-clock-like value);
   * then call dgpt_tick which drains the key queue + renders into
   * DG_ScreenBuffer.
   */
  runTic(msDelta = 16): void {
    if (!this.initialized) return;
    this.mod.ccall('dgpt_advance_clock', null, ['number'], [msDelta]);
    this.mod.ccall('dgpt_tick', null, [], []);
  }

  /**
   * Push one key event into the engine's input queue. `doomKey` is a
   * doomkeys.h constant; callers in the same file get the right values
   * via setKeyForKeyboardCode / setKeyForCvGate.
   */
  setKey(doomKey: number, pressed: boolean): void {
    if (!this.initialized) return;
    this.mod.ccall(
      'dgpt_set_key',
      null,
      ['number', 'number'],
      [doomKey & 0xff, pressed ? 1 : 0],
    );
  }

  /** Convenience: translate a KeyboardEvent.code into a doomkey + push. */
  setKeyForKeyboardCode(code: string, pressed: boolean): boolean {
    const key = KEY_FOR_KEYBOARD_CODE[code];
    if (key === undefined) return false;
    this.setKey(key, pressed);
    return true;
  }

  /** Convenience: CV-gate port id ('w'/'a'/.../'alt') → doomkey + push. */
  setKeyForCvGate(portId: CvGatePortId, pressed: boolean): boolean {
    const key = KEY_FOR_CV_GATE[portId];
    if (key === undefined) return false;
    this.setKey(key, pressed);
    return true;
  }

  /**
   * Zero-copy view of the current framebuffer in WASM linear memory.
   * Format: BGRA8 row-major at resolution()×4 bytes (doomgeneric's
   * DG_ScreenBuffer is uint32_t* under CMAP_OFF). Caller blits into a GL
   * texture each frame; do NOT cache the array reference across frames
   * (memory growth + framebuffer-pointer drift will invalidate it).
   */
  getFramebuffer(): Uint8ClampedArray {
    // Subarray over HEAPU8 — typed-array views share the underlying
    // buffer with the wasm heap, so no copy happens.
    const heap = this.mod.HEAPU8;
    return new Uint8ClampedArray(heap.buffer, this.fbPtr, this.fbSize);
  }

  /**
   * Zero-copy stereo PCM view (legacy slice-7 stub buffer — kept for
   * back-compat with tests that pinned the call shape). The mixer in
   * slice 8 publishes via `pullPcmFrames` below, not via this view.
   */
  getPcmBuffer(): Float32Array {
    const heap = this.mod.HEAPF32;
    // pcmSampleCount is the per-channel sample count; we store interleaved
    // stereo so the array is 2× that.
    return new Float32Array(heap.buffer, this.pcmPtr, this.pcmSampleCount * 2);
  }

  // ---------------- Slice 8 PCM pull ----------------
  //
  // The i_pcmgen.c mixer accumulates int16 mono samples into an internal
  // ring; the WASM export `dg_get_pcm_buffer(int16_t* dest, int frames)`
  // drains the ring. We allocate a scratch buffer in WASM linear memory
  // (one per runtime), call the export, then convert s16 → f32 in JS.
  //
  // Returns a freshly-allocated Float32Array (NOT a heap view — the
  // caller posts it to an AudioWorklet which transfers ownership; if we
  // returned a view the worklet would be reading freed wasm memory after
  // the next ring drain). Allocation cost is ~256 bytes * 60 Hz = trivial.

  /** Lazy scratch ptr (allocated on first pullPcmFrames). */
  private pcmScratchPtr = 0;
  private pcmScratchFrames = 0;

  private ensurePcmScratch(frames: number): number {
    if (this.pcmScratchPtr !== 0 && this.pcmScratchFrames >= frames) {
      return this.pcmScratchPtr;
    }
    // Free the old scratch if we need to grow.
    if (this.pcmScratchPtr !== 0) {
      this.mod.ccall('free', null, ['number'], [this.pcmScratchPtr]);
    }
    // 2 bytes per int16 frame. Round up to 256-frame multiples to
    // amortize reallocation as callers occasionally ask for more frames
    // (worklet-driven pumps may grow buffer size at startup).
    const grow = Math.max(256, Math.ceil(frames / 256) * 256);
    const bytes = grow * 2;
    this.pcmScratchPtr = this.mod.ccall('malloc', 'number', ['number'], [bytes]);
    this.pcmScratchFrames = grow;
    return this.pcmScratchPtr;
  }

  /**
   * Pull `frames` mono samples from the i_pcmgen ring. Returns a
   * Float32Array of length `frames` in [-1.0, +1.0]. Underrun pads
   * with silence. Safe to call from the main thread at video-frame
   * cadence; the worklet downstream queues + plays at audio rate.
   */
  getPcmFrames(frames: number): Float32Array {
    if (!this.initialized || frames <= 0) return new Float32Array(0);
    const ptr = this.ensurePcmScratch(frames);
    this.mod.ccall(
      'dg_get_pcm_buffer',
      'number',
      ['number', 'number'],
      [ptr, frames],
    );
    // Read s16 from WASM heap, convert to f32.
    const i16View = new Int16Array(this.mod.HEAPU8.buffer, ptr, frames);
    const out = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      out[i] = i16View[i]! / 32768;
    }
    return out;
  }

  /** How many mono frames are currently sitting in the WASM ring. JS
   *  side can use this to throttle the pump (skip a tick if we're
   *  already buffered far enough ahead). */
  getPcmBufferedFrames(): number {
    if (!this.initialized) return 0;
    return this.mod.ccall('dg_get_pcm_buffered_frames', 'number', [], []);
  }

  /** Native sample rate the i_pcmgen mixer emits at. The DOOM module
   *  asserts the AudioContext's sampleRate matches; otherwise we'd be
   *  pitched up or down. */
  getPcmSampleRate(): number {
    if (!this.initialized) return 44100;
    return this.mod.ccall('dg_get_pcm_sample_rate', 'number', [], []);
  }

  // ---------------- Player-state introspection ----------------
  //
  // Returns the active player's in-game mobj state. Used by the e2e
  // suite to verify that arrow keys actually move the player (vs the
  // framebuffer-diff signal, which is fooled by the screen-shrink bug
  // where ArrowUp was decoding as KEY_MINUS — see doomgeneric_patchtogether.c
  // header).
  //
  // Returns null when the player has no mobj yet (intro / menu / level
  // still loading). All values are DOOM's native fixed-point 16.16
  // coordinates; convert to integer map units via `>> 16` in callers
  // that just want a "did it change" signal.

  /** True once the player has spawned into a level (mobj is non-null). */
  hasPlayerMobj(): boolean {
    if (!this.initialized) return false;
    return this.mod.ccall('dgpt_has_player_mobj', 'number', [], []) !== 0;
  }

  /** Player position + facing angle in DOOM's native fixed-point coords,
   *  or null if no level is loaded. */
  getPlayerState(): { x: number; y: number; angle: number } | null {
    if (!this.initialized) return null;
    if (!this.hasPlayerMobj()) return null;
    return {
      x: this.mod.ccall('dgpt_get_player_x', 'number', [], []),
      y: this.mod.ccall('dgpt_get_player_y', 'number', [], []),
      angle: this.mod.ccall('dgpt_get_player_angle', 'number', [], []) >>> 0,
    };
  }

  // ---------------- Slice 4: netgame launch + state ----------------
  //
  // startNetGame(settings, consolePlayer) drives the C dgpt_start_netgame
  // export: it sets DOOM's game settings, marks the game a netgame with
  // `numPlayers` live slots, sets THIS peer's slot as consoleplayer, and
  // loads the level (G_InitNew). After it returns, runTic() advances the
  // level; getConsolePlayerState() reads THIS peer's own marine.

  /** GS_LEVEL / GS_INTERMISSION / GS_FINALE / GS_DEMOSCREEN — DOOM's
   *  gamestate_t as an int (doomdef.h ordering: LEVEL=0, INTERMISSION=1,
   *  FINALE=2, DEMOSCREEN=3). The card uses this to (a) confirm the level
   *  loaded after Launch and (b) lock the New Game dialog until intermission. */
  getGameState(): number {
    if (!this.initialized) return -1;
    return this.mod.ccall('dgpt_get_gamestate', 'number', [], []);
  }

  /** True once the level is loaded + actively running (gamestate==GS_LEVEL).
   *  GS_LEVEL is 0 in DOOM's enum. */
  isInLevel(): boolean {
    return this.getGameState() === 0;
  }

  /** Launch (or re-launch at the next map) a netgame on this peer.
   *
   *  All peers must call this with the SAME settings; only `consolePlayer`
   *  (this peer's slot) differs. Deterministic level load on identical
   *  (skill, episode, map) + numPlayers gives every peer the same world with
   *  marines at the per-slot coop starts; this peer drives its own
   *  players[consolePlayer]. */
  startNetGame(
    settings: {
      deathmatch: number;
      episode: number;
      map: number;
      skill: number;
      nomonsters: number;
      fastMonsters: number;
      respawnMonsters: number;
      numPlayers: number;
    },
    consolePlayer: number,
  ): void {
    if (!this.initialized) return;
    this.mod.ccall(
      'dgpt_start_netgame',
      null,
      ['number', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'number'],
      [
        settings.deathmatch,
        settings.episode,
        settings.map,
        settings.skill,
        settings.nomonsters,
        settings.fastMonsters,
        settings.respawnMonsters,
        settings.numPlayers,
        consolePlayer,
      ],
    );
  }

  /** This peer's slot (consoleplayer) per the C side, or 0 if not in a
   *  netgame (single-player default). */
  getConsolePlayer(): number {
    if (!this.initialized) return 0;
    return this.mod.ccall('dgpt_get_console_player', 'number', [], []);
  }

  /** True once THIS peer's console player has spawned into the level. */
  hasConsolePlayerMobj(): boolean {
    if (!this.initialized) return false;
    return this.mod.ccall('dgpt_has_console_player_mobj', 'number', [], []) !== 0;
  }

  /** Position of the player THIS peer controls (players[consoleplayer]) in
   *  DOOM fixed-point, or null if no level / not spawned. The e2e asserts
   *  two peers' console players occupy DIFFERENT positions after independent
   *  movement — the per-peer-instance proof. */
  getConsolePlayerState(): { x: number; y: number; slot: number } | null {
    if (!this.initialized) return null;
    if (!this.hasConsolePlayerMobj()) return null;
    return {
      x: this.mod.ccall('dgpt_get_console_player_x', 'number', [], []),
      y: this.mod.ccall('dgpt_get_console_player_y', 'number', [], []),
      slot: this.getConsolePlayer(),
    };
  }

  // ---------------- Slice 3: netcode bridge (Module.PTNet) ----------------
  //
  // The DOOM multiplayer netcode (doom-netcode.ts) needs two things from a
  // runtime: a handle to the emcc Module (so it can install the
  // `Module.PTNet` table the C EM_JS hooks read at send/poll time) and a
  // way to deliver inbound packets into the C-side recv queue
  // (`dgpt_net_inject_packet`). These two methods make DoomRuntime satisfy
  // the netcode's `NetcodeRuntime` structural interface for real (slice 2
  // unit-tested it against a hand-rolled mock).

  /** The raw emcc Module — the netcode installs `Module.PTNet` on it. The
   *  shape DoomRuntime keeps internally (DoomModule) is a superset of the
   *  netcode's NetcodeModule, so it satisfies that interface structurally.
   *  Returns null only if the runtime was disposed (mod reference dropped). */
  getModule(): DoomModule | null {
    return this.mod ?? null;
  }

  /**
   * Inbound packet path (JS → C). Copy `bytes` into a WASM heap buffer,
   * call `dgpt_net_inject_packet(ptr, len, srcPeerId)`, then free the
   * buffer. Returns true if the C recv queue accepted the packet (1) and
   * false if it was full (0) or the runtime isn't ready.
   *
   * We malloc/free per packet rather than keeping a persistent scratch
   * buffer because packets vary in size (handshake vs. per-tic gamedata)
   * and the call frequency (≤ a few per tic) makes the allocator churn
   * negligible. The C side memcpy's the bytes into its own NET_NewPacket
   * buffer synchronously, so freeing immediately after the call is safe.
   */
  injectNetPacket(bytes: Uint8Array, srcPeerId: number): boolean {
    if (!this.initialized) return false;
    const len = bytes.length;
    // Zero-length packets are degenerate but valid (the C side tolerates
    // len 0 / NULL); skip the malloc and pass a 0 ptr.
    if (len === 0) {
      const r0 = this.mod.ccall(
        'dgpt_net_inject_packet',
        'number',
        ['number', 'number', 'number'],
        [0, 0, srcPeerId],
      );
      return r0 !== 0;
    }
    const ptr = this.mod.ccall('malloc', 'number', ['number'], [len]);
    if (!ptr) return false;
    try {
      // Copy into the heap. HEAPU8 is re-read each call in case memory grew.
      this.mod.HEAPU8.set(bytes, ptr);
      const r = this.mod.ccall(
        'dgpt_net_inject_packet',
        'number',
        ['number', 'number', 'number'],
        [ptr, len, srcPeerId],
      );
      return r !== 0;
    } finally {
      this.mod.ccall('free', null, ['number'], [ptr]);
    }
  }

  /** No teardown beyond dropping references — Emscripten doesn't expose
   *  a clean "close module" verb. The browser's GC reclaims the wasm
   *  memory when the JS-side references go away (module instance,
   *  HEAPU8 view, etc.). */
  dispose(): void {
    this.initialized = false;
  }
}

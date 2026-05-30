// packages/web/src/lib/qbert/qbert-runtime.ts
//
// Q*Bert (Gottlieb 1982) — minimal arcade-hardware runtime.
//
// **MAME citation** (the canonical hardware reference): the memory map +
// ROM filename conventions trace to MAME's `src/mame/drivers/gottlieb.cpp`
// (the Gottlieb arcade hardware driver, GPL-2.0+ — AGPL-compatible).
// Mainline MAME (commit pin in the repo's MAME-reference clone TBD when
// the gameplay-grade port lands); the present runtime ports only the
// memory-map / ROM-name surface, not the CPU emulation itself. See:
//
//   - `src/mame/drivers/gottlieb.cpp` — main_cpu_map + qbert ROM_START
//     entries (qb-rom0..2.bin, qb-snd0..1.bin, qb-bg-0..1.bin)
//   - `src/mame/includes/gottlieb.h` — video RAM + palette layout
//
// **v1 scope** (per the QBERT module spec — "do not port any more of MAME
// than you have to"):
//   - Memory map: ROM at 0x0000-0x4FFF, video RAM at 0x5000-0x57FF,
//     palette at 0x5800-0x583F, scratch RAM elsewhere — addresses match
//     the Gottlieb driver verbatim so a future opcode-complete swap drops
//     in without a remap.
//   - Z80 main CPU: minimal opcode subset (NOP/HALT/LD/JP — see z80.ts);
//     enough to prove the wire-up + tick a stub ROM. Real ROM execution
//     needs the full opcode set + the I/O ports + DAC; gated behind a
//     follow-up that swaps in DrGoldfire/Z80.js.
//   - I8039 sound CPU: STUBBED — we don't emulate it. The runtime exposes
//     an audio output buffer that's filled with the event-synthesized
//     SFX (a 1 kHz square-wave blip on each `evt_move`); the real I8039
//     port is a separate follow-up so the audio path stays plumbed
//     without dragging in a second CPU core.
//   - Video: a 256×240 RGBA framebuffer rasterised at frame time from the
//     video-RAM region + palette. v1 paints a static demo grid (Q*Bert's
//     "diamond pyramid" silhouette) so the canvas isn't black before a
//     real ROM is decoded; the moment a ROM is loaded, the framebuffer
//     reflects whatever the CPU wrote into VRAM.
//   - Events: `evt_move` / `evt_die` / `evt_level` are driven by a tiny
//     synthetic event stream so the gate outputs are testable WITHOUT
//     running the real game logic. Once the gameplay-grade port lands,
//     the trampoline replaces the synthetic stream with the real
//     P_MoveQbert / P_KillQbert / P_AdvanceLevel hooks.
//
// **License**: this file is original code; its hardware-spec data
// (addresses, palette layout, ROM filename list) is documented public
// information mirrored from MAME's Gottlieb driver. The cite above is
// per the project's DSP-style attribution convention.
//
// Tested via qbert-runtime.test.ts (stubs the ROM bytes; never touches
// the static dir). The real ROM path is exercised by the
// qbert-cv-joystick e2e + the qbert-rom-missing e2e.

import { createZ80 } from './z80';
import { joyCvToDiagonal, type QbertDiagonal } from './joy-cv';
import { parseRomZip, type QbertRomMap } from './rom-zip';

// ---- Memory map (Gottlieb hardware) -----------------------------------

export const ROM_BASE = 0x0000;
export const ROM_END  = 0x4FFF;
export const VRAM_BASE = 0x5000;
export const VRAM_END  = 0x57FF;
export const PAL_BASE  = 0x5800;
export const PAL_END   = 0x583F;
export const RAM_BASE  = 0x6000;
export const RAM_END   = 0x6FFF;

/** Native pixel grid the canvas/FBO renders. Per Gottlieb hardware. */
export const QBERT_WIDTH = 256;
export const QBERT_HEIGHT = 240;

/** MAME `qbert` set's main-CPU ROM filename order, in 0x1000-byte chunks
 *  loaded at 0x0000, 0x1000, 0x2000, 0x3000, 0x4000. We treat ANY of these
 *  present as enough to initialize the Z80 (gameplay-grade execution is a
 *  follow-up; the test path just needs SOMETHING in ROM to fetch). */
export const MAIN_ROM_FILENAMES = [
  'qb-rom2.bin',  // 0x0000
  'qb-rom1.bin',  // 0x1000
  'qb-rom0.bin',  // 0x2000
] as const;

/** Q*Bert event types our event-gate outputs surface to the module. */
export type QbertEventType = 'move' | 'die' | 'level';

export interface QbertEvent {
  type: QbertEventType;
  /** Wall-clock tic when the event was queued. Useful for ordering;
   *  the gate-pulse path doesn't care about the value. */
  tic: number;
}

/** Public runtime surface — what the module factory talks to. */
export interface QbertRuntime {
  /** True once a ROM zip has been loaded + the Z80 is ticking. */
  isInitialized(): boolean;
  /** Last-known reason the runtime hasn't loaded (ROM missing, zip bad,
   *  …). Empty string when loaded OK. */
  loadError(): string;
  /** Snapshot the current 256×240 RGBA framebuffer (Uint8ClampedArray of
   *  length QBERT_WIDTH * QBERT_HEIGHT * 4). Returns a live view into
   *  the runtime's buffer — caller must not retain across runTic. */
  getFramebuffer(): Uint8ClampedArray;
  /** Advance the simulation by approximately `msDelta` real-time
   *  milliseconds (the runtime decides its own internal cycle budget). */
  runTic(msDelta: number): void;
  /** Rising-edge "insert coin" (COIN1 dip on Gottlieb hardware). */
  insertCoin(): void;
  /** Rising-edge "press 1P start". */
  pressStart(): void;
  /** Set the current joystick diagonal (translated by the module from CV). */
  setJoystick(dir: QbertDiagonal): void;
  /** Drain the event queue. Each call returns + clears the queue. */
  drainEvents(): QbertEvent[];
  /** Drain the synthesized audio buffer (Float32Array, mono, 44.1 kHz)
   *  for the audio worklet to push downstream. Empty array if the runtime
   *  isn't loaded. */
  getPcmFrames(maxSamples: number): Float32Array;
  /** Release all resources. Idempotent. */
  dispose(): void;
}

interface QbertRuntimeOpts {
  /** Pre-parsed ROM map (filename → bytes). Pass null to spawn a runtime
   *  that's "ROM missing" — the framebuffer renders the test pattern and
   *  no events fire. */
  roms: QbertRomMap | null;
  /** Reason for ROM absence (rendered in the card overlay). Ignored when
   *  `roms` is non-null. */
  loadError?: string;
}

/**
 * Build a Q*Bert runtime from a (possibly missing) parsed ROM map. The
 * QBERT module factory always constructs a runtime instance even when
 * the ROM fetch failed — passing `roms: null` + a `loadError` lets the
 * card render the "ROM missing" overlay without spawning a second branch.
 */
export function createQbertRuntime(opts: QbertRuntimeOpts): QbertRuntime {
  // ---- Memory: 64 KB linear, ROM region pre-loaded ----------------------
  const memory = new Uint8Array(64 * 1024);

  let initialized = false;
  let loadErr = opts.loadError ?? 'ROM not loaded';
  if (opts.roms) {
    // Copy each present main-ROM chunk into its native address. Missing
    // chunks leave that region as zeros; the Z80 then reads NOPs there.
    for (let i = 0; i < MAIN_ROM_FILENAMES.length; i++) {
      const name = MAIN_ROM_FILENAMES[i]!;
      const bytes = opts.roms.roms.get(name);
      if (!bytes) continue;
      const base = i * 0x1000;
      for (let j = 0; j < bytes.length && (base + j) <= ROM_END; j++) {
        memory[base + j] = bytes[j]!;
      }
    }
    initialized = true;
    loadErr = '';
  }

  // ---- Z80 main CPU ----------------------------------------------------
  //
  // Reads from ROM go through; writes to ROM are silently dropped. VRAM +
  // palette + RAM writes land in the linear buffer. Out-of-range addresses
  // wrap (& 0xFFFF) — same convention the Z80 uses internally.
  const cpu = createZ80({
    memory: {
      read: (addr) => memory[addr & 0xFFFF] ?? 0,
      write: (addr, value) => {
        const a = addr & 0xFFFF;
        if (a <= ROM_END) return; // ROM is read-only
        memory[a] = value & 0xFF;
      },
    },
  });

  // ---- Framebuffer -----------------------------------------------------
  //
  // Pre-paint a tiny "QBERT" diamond test pattern so the on-card canvas
  // isn't black before a real ROM rewrites VRAM. The runtime overwrites
  // this from VRAM on every runTic once initialized — but if the Z80
  // never touches VRAM (the v1 stub case), the pattern stays visible so
  // the user can see the card is alive.
  const framebuffer = new Uint8ClampedArray(QBERT_WIDTH * QBERT_HEIGHT * 4);
  for (let i = 3; i < framebuffer.length; i += 4) framebuffer[i] = 255;
  paintTestPattern(framebuffer);

  // ---- Event queue + synthesized event stream --------------------------
  //
  // v1 fires `evt_move` periodically while a direction is held + `evt_die`
  // after a fixed timeout (synthetic — gameplay-grade kill detection is a
  // follow-up). `evt_level` fires once every N moves.
  const events: QbertEvent[] = [];
  let tic = 0;
  let lastMoveTic = -999;
  let movesThisLevel = 0;
  let currentDir: QbertDiagonal = 'NEUTRAL';
  let coinsInserted = 0;
  let gameStarted = false;

  // ---- Audio (stub) ----------------------------------------------------
  //
  // Tiny ring buffer the runtime drains into the AudioWorklet. v1 emits a
  // 1 kHz square-wave "blip" (50 ms decay) on each evt_move, mirroring
  // Q*Bert's hop SFX texture — enough to wire audio_out end-to-end so the
  // module's audio path is testable without the I8039 port.
  const SAMPLE_RATE = 44100;
  const audioRing = new Float32Array(SAMPLE_RATE); // 1 second of headroom
  let audioWrite = 0;
  let audioRead = 0;
  let audioBlipPhase = 0;
  let audioBlipSamplesLeft = 0;
  const BLIP_HZ = 1000;
  const BLIP_DECAY_S = 0.05;

  function emitMoveBlip(): void {
    if (!initialized) return;
    audioBlipSamplesLeft = Math.floor(BLIP_DECAY_S * SAMPLE_RATE);
    audioBlipPhase = 0;
  }

  function pumpAudio(samples: number): void {
    const inc = (BLIP_HZ * 2) / SAMPLE_RATE; // 2 = full-cycle in [0,1)
    for (let i = 0; i < samples; i++) {
      let v = 0;
      if (audioBlipSamplesLeft > 0) {
        // Square wave with linear decay over BLIP_DECAY_S.
        const decay = audioBlipSamplesLeft / (BLIP_DECAY_S * SAMPLE_RATE);
        v = (audioBlipPhase < 0.5 ? 0.25 : -0.25) * decay;
        audioBlipPhase += inc;
        if (audioBlipPhase >= 1) audioBlipPhase -= 1;
        audioBlipSamplesLeft -= 1;
      }
      audioRing[audioWrite] = v;
      audioWrite = (audioWrite + 1) % audioRing.length;
      // If we'd overrun the reader, advance read pointer (drop oldest).
      if (audioWrite === audioRead) audioRead = (audioRead + 1) % audioRing.length;
    }
  }

  function runTic(msDelta: number): void {
    if (!initialized) {
      // Even without a ROM, keep the audio path silent (not stale).
      pumpAudio(Math.round((msDelta / 1000) * SAMPLE_RATE));
      return;
    }
    // Burn an opcode budget proportional to msDelta. Z80 ran at ~3.58 MHz
    // on Gottlieb hardware → ~3580 cycles per real ms. The stub opcodes
    // average ~5 T-states each, so cap step iterations to avoid an
    // infinite spin on a particularly weird ROM.
    const targetCycles = Math.min(50_000, Math.floor(msDelta * 3580));
    const cyclesStart = cpu.state.cycles;
    let safety = 100_000;
    while (cpu.state.cycles - cyclesStart < targetCycles && !cpu.state.halted && safety-- > 0) {
      cpu.step();
    }

    // Synthetic event stream:
    //   - `evt_move` every 8 tics a non-NEUTRAL direction has been held
    //     (Q*Bert hops at ~4 hops/sec at this cadence).
    //   - `evt_level` after every 28 moves (one cube-pyramid pass).
    //   - `evt_die` 200 tics after game start IF no direction has been
    //     held (proxy for "fell off the pyramid"). Auto-resets so the
    //     gate path is testable repeatedly.
    tic += 1;
    if (gameStarted && currentDir !== 'NEUTRAL' && tic - lastMoveTic >= 8) {
      events.push({ type: 'move', tic });
      lastMoveTic = tic;
      movesThisLevel += 1;
      emitMoveBlip();
      if (movesThisLevel >= 28) {
        events.push({ type: 'level', tic });
        movesThisLevel = 0;
      }
    }
    if (gameStarted && currentDir === 'NEUTRAL' && tic - lastMoveTic > 200) {
      events.push({ type: 'die', tic });
      lastMoveTic = tic;
      gameStarted = false; // require another coin/start
    }

    // Refresh framebuffer from VRAM (if the ROM wrote anything). The
    // stub path leaves VRAM as zeros, so the test pattern stays visible.
    let anyVram = false;
    for (let i = VRAM_BASE; i <= VRAM_END; i++) {
      if (memory[i] !== 0) { anyVram = true; break; }
    }
    if (anyVram) paintFromVram(framebuffer, memory);

    pumpAudio(Math.round((msDelta / 1000) * SAMPLE_RATE));
  }

  function insertCoin(): void {
    if (!initialized) return;
    coinsInserted += 1;
  }

  function pressStart(): void {
    if (!initialized) return;
    if (coinsInserted > 0 && !gameStarted) {
      gameStarted = true;
      lastMoveTic = tic;
      movesThisLevel = 0;
    }
  }

  function setJoystick(dir: QbertDiagonal): void {
    currentDir = dir;
  }

  function drainEvents(): QbertEvent[] {
    if (events.length === 0) return [];
    const out = events.slice();
    events.length = 0;
    return out;
  }

  function getPcmFrames(maxSamples: number): Float32Array {
    const avail = (audioWrite - audioRead + audioRing.length) % audioRing.length;
    const n = Math.min(maxSamples, avail);
    if (n === 0) return new Float32Array(0);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = audioRing[(audioRead + i) % audioRing.length]!;
    }
    audioRead = (audioRead + n) % audioRing.length;
    return out;
  }

  function dispose(): void {
    // Nothing to release — buffers are GC'd with the runtime object.
    // Keep the no-op so the module factory's dispose() path is symmetric
    // with the DOOM runtime.
  }

  return {
    isInitialized: () => initialized,
    loadError: () => loadErr,
    getFramebuffer: () => framebuffer,
    runTic,
    insertCoin,
    pressStart,
    setJoystick,
    drainEvents,
    getPcmFrames,
    dispose,
  };
}

/** Paint a simple diamond test pattern so the canvas isn't black until a
 *  real ROM populates VRAM. Pure pixel writes — no GL state. */
function paintTestPattern(fb: Uint8ClampedArray): void {
  // Dark blue background.
  for (let y = 0; y < QBERT_HEIGHT; y++) {
    for (let x = 0; x < QBERT_WIDTH; x++) {
      const p = (y * QBERT_WIDTH + x) * 4;
      fb[p]     = 0x10;
      fb[p + 1] = 0x10;
      fb[p + 2] = 0x28;
    }
  }
  // Magenta diamond outline ~ Q*Bert silhouette hint. Centred in the
  // 256×240 grid; radius ~80.
  const cx = QBERT_WIDTH / 2;
  const cy = QBERT_HEIGHT / 2;
  const r = 80;
  for (let i = 0; i <= 2 * r; i++) {
    const dx = i - r;
    const dy0 = r - Math.abs(dx);
    const dy1 = -dy0;
    for (const dy of [dy0, dy1]) {
      const x = Math.floor(cx + dx);
      const y = Math.floor(cy + dy);
      if (x < 0 || x >= QBERT_WIDTH || y < 0 || y >= QBERT_HEIGHT) continue;
      const p = (y * QBERT_WIDTH + x) * 4;
      fb[p]     = 0xFF;
      fb[p + 1] = 0x40;
      fb[p + 2] = 0xC0;
    }
  }
}

/** Copy VRAM into the framebuffer using the palette. Q*Bert's video RAM
 *  is one byte per pixel (palette index 0..0x3F); palette entries at
 *  0x5800-0x583F are packed RGB. v1 unpacks naively — enough to surface
 *  whatever bytes a real ROM lays into VRAM as visible pixels; faithful
 *  bit-pattern decoding ships with the gameplay-grade port. */
function paintFromVram(fb: Uint8ClampedArray, mem: Uint8Array): void {
  // Q*Bert's VRAM region (0x800 bytes) is smaller than 256×240, so we
  // tile-copy: every byte covers one pixel + we cover the framebuffer in
  // tiles of (VRAM_BASE+i % WIDTH). This is intentionally cosmetic for
  // v1 — the real Gottlieb video hardware character-maps 8×8 tiles via
  // bg-rom, which we don't decode yet.
  const palStart = PAL_BASE;
  for (let i = 0; i < QBERT_WIDTH * QBERT_HEIGHT; i++) {
    const vramIdx = i % 0x800;
    const idx = mem[VRAM_BASE + vramIdx]! & 0x3F;
    const palByte = mem[palStart + idx]! & 0xFF;
    // Naive RGB unpack: high 3 bits → R, mid 3 → G, low 2 → B. The real
    // Gottlieb palette uses a colour-PROM lookup; this is a v1 stand-in
    // that at least varies pixel colour with the byte value so a ROM
    // write becomes visible.
    const r = ((palByte >> 5) & 0x07) * 36;
    const g = ((palByte >> 2) & 0x07) * 36;
    const b = (palByte & 0x03) * 85;
    const p = i * 4;
    fb[p]     = r;
    fb[p + 1] = g;
    fb[p + 2] = b;
  }
}

// ---- ROM fetch (browser path) ----------------------------------------

const ROM_URL = '/roms/qbert/qbert.zip';

/**
 * Fetch + parse the Q*Bert ROM zip from the static dir. Returns the parsed
 * ROM map on success, or `{ roms: null, error }` when the zip is missing
 * or fails to extract. The QBERT module factory wraps this with the
 * runtime construction; the test harness can call it directly with a
 * stubbed `fetch` to exercise the "ROM missing" path deterministically.
 */
export async function loadQbertRoms(): Promise<{
  roms: QbertRomMap | null;
  error?: string;
}> {
  try {
    const r = await fetch(ROM_URL);
    if (!r.ok) {
      return {
        roms: null,
        error: `ROM missing — run \`task setup:qbert\` (fetch ${r.status})`,
      };
    }
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf.length === 0) {
      return { roms: null, error: 'ROM missing — run `task setup:qbert` (empty zip)' };
    }
    try {
      const parsed = parseRomZip(buf);
      return { roms: parsed };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { roms: null, error: `ROM zip extract failed: ${msg}` };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { roms: null, error: `ROM fetch failed: ${msg}` };
  }
}

// Re-exports so the module factory + tests have one stop-shop.
export { joyCvToDiagonal, parseRomZip };
export type { QbertDiagonal, QbertRomMap };

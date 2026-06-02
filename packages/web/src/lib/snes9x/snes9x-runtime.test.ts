// packages/web/src/lib/snes9x/snes9x-runtime.test.ts
//
// Stubs the Snes9xModule (emcc surface) + exercises the Snes9xRuntime
// wrapper end-to-end without real WASM. Pins the JS contract: loadRom
// copies bytes into HEAPU8 + calls _snes_load_rom; getFramebuffer returns
// a zero-copy RGBA view at the right offset/size; getAudio returns the
// per-frame stereo S16 view; getWram / readWram route to the right
// pointer. Real emulation is covered by the snes9x e2e.

import { describe, it, expect } from 'vitest';
import { Snes9xRuntime, type Snes9xModule } from './snes9x-runtime';

const FB_PTR = 0x100000;
const AUDIO_PTR = 0x200000;
const WRAM_PTR = 0x300000;

function makeStub(opts: {
  fbW?: number; fbH?: number; audioFrames?: number; loadOk?: boolean;
} = {}) {
  const heap = new ArrayBuffer(64 * 1024 * 1024);
  const HEAPU8 = new Uint8Array(heap);
  const HEAPU16 = new Uint16Array(heap);
  const HEAPU32 = new Uint32Array(heap);
  const HEAP16 = new Int16Array(heap);
  const calls: string[] = [];
  let lastInput = 0;
  let romLoaded = 0;
  let mallocPtr = 0x400000;
  const fbW = opts.fbW ?? 256;
  const fbH = opts.fbH ?? 224;
  const audioFrames = opts.audioFrames ?? 4;

  // Seed framebuffer + audio + WRAM with known patterns.
  for (let i = 0; i < fbW * fbH; i++) HEAPU32[(FB_PTR >> 2) + i] = 0xff112233;
  for (let i = 0; i < audioFrames * 2; i++) HEAP16[(AUDIO_PTR >> 1) + i] = 100 + i;
  HEAPU8[WRAM_PTR + 0x0100] = 0x13; // game mode
  HEAPU8[WRAM_PTR + 0x0dbe] = 0x04; // lives

  const mod: Snes9xModule = {
    HEAPU8, HEAPU16, HEAPU32, HEAP16,
    _malloc: (n) => { const p = mallocPtr; mallocPtr += n; return p; },
    _free: () => { calls.push('free'); },
    _snes_init: () => { calls.push('init'); },
    _snes_load_rom: (_ptr, _len) => { calls.push('load_rom'); romLoaded = opts.loadOk === false ? 0 : 1; return romLoaded; },
    _snes_rom_loaded: () => romLoaded,
    _snes_run_frame: () => { calls.push('run_frame'); },
    _snes_get_framebuffer: () => FB_PTR,
    _snes_get_fb_width: () => fbW,
    _snes_get_fb_height: () => fbH,
    _snes_get_audio_buffer: () => AUDIO_PTR,
    _snes_get_audio_frames: () => audioFrames,
    _snes_set_input: (m) => { lastInput = m; },
    _snes_get_wram: () => WRAM_PTR,
    _snes_get_wram_size: () => 0x20000,
    _snes_read_wram: (addr) => HEAPU8[WRAM_PTR + (addr & 0x1ffff)] ?? 0,
  };
  return { mod, calls, getLastInput: () => lastInput };
}

async function loadStub(opts?: Parameters<typeof makeStub>[0]) {
  const { mod, calls, getLastInput } = makeStub(opts);
  const rt = await Snes9xRuntime.load(async () => mod);
  return { rt, mod, calls, getLastInput };
}

describe('Snes9xRuntime.load', () => {
  it('calls _snes_init once', async () => {
    const { calls } = await loadStub();
    expect(calls).toContain('init');
  });
});

describe('loadRom', () => {
  it('copies bytes into HEAPU8 + calls _snes_load_rom, returns true', async () => {
    const { rt, mod } = await loadStub();
    const rom = new Uint8Array([1, 2, 3, 4, 5]);
    expect(rt.loadRom(rom)).toBe(true);
    // The bytes landed at the malloc ptr.
    expect(Array.from(mod.HEAPU8.subarray(0x400000, 0x400005))).toEqual([1, 2, 3, 4, 5]);
    expect(rt.isRomLoaded()).toBe(true);
  });

  it('returns false when the core rejects the ROM', async () => {
    const { rt } = await loadStub({ loadOk: false });
    expect(rt.loadRom(new Uint8Array([0]))).toBe(false);
    expect(rt.isRomLoaded()).toBe(false);
  });

  it('frees the ROM blob after load', async () => {
    const { rt, calls } = await loadStub();
    rt.loadRom(new Uint8Array([1]));
    expect(calls).toContain('free');
  });
});

describe('runFrame / setInput', () => {
  it('runFrame is a no-op until a ROM is loaded, then ticks', async () => {
    const { rt, calls } = await loadStub();
    rt.runFrame();
    expect(calls).not.toContain('run_frame');
    rt.loadRom(new Uint8Array([1]));
    rt.runFrame();
    expect(calls).toContain('run_frame');
  });

  it('setInput forwards the mask', async () => {
    const { rt, getLastInput } = await loadStub();
    rt.setInput(0b1010);
    expect(getLastInput()).toBe(0b1010);
  });
});

describe('getFramebuffer', () => {
  it('returns a zero-copy RGBA view of width*height*4 bytes', async () => {
    const { rt } = await loadStub({ fbW: 256, fbH: 224 });
    const fb = rt.getFramebuffer();
    expect(fb).toBeInstanceOf(Uint8ClampedArray);
    expect(fb.length).toBe(256 * 224 * 4);
    // 0xff112233 little-endian → bytes 0x33,0x22,0x11,0xff.
    expect(fb[0]).toBe(0x33);
    expect(fb[3]).toBe(0xff);
  });

  it('tracks dimension changes (224 ↔ 239)', async () => {
    const { rt } = await loadStub({ fbW: 256, fbH: 239 });
    expect(rt.getFbHeight()).toBe(239);
    expect(rt.getFramebuffer().length).toBe(256 * 239 * 4);
  });
});

describe('getAudio', () => {
  it('returns the per-frame interleaved S16 stereo view (frames*2)', async () => {
    const { rt } = await loadStub({ audioFrames: 4 });
    const a = rt.getAudio();
    expect(a).toBeInstanceOf(Int16Array);
    expect(a.length).toBe(8);
    expect(a[0]).toBe(100);
    expect(a[7]).toBe(107);
  });

  it('returns empty when no audio this frame', async () => {
    const { rt } = await loadStub({ audioFrames: 0 });
    expect(rt.getAudio().length).toBe(0);
  });
});

describe('getWram / readWram', () => {
  it('getWram returns a 128 KB zero-copy view', async () => {
    const { rt } = await loadStub();
    const wram = rt.getWram();
    expect(wram.length).toBe(0x20000);
    expect(wram[0x0100]).toBe(0x13);
    expect(wram[0x0dbe]).toBe(0x04);
  });

  it('readWram reads a single byte', async () => {
    const { rt } = await loadStub();
    expect(rt.readWram(0x0100)).toBe(0x13);
    expect(rt.readWram(0x0dbe)).toBe(0x04);
  });
});

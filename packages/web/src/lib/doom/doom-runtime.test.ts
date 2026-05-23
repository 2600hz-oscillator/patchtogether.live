// packages/web/src/lib/doom/doom-runtime.test.ts
//
// Stubs the DoomModule interface (the emcc surface) and exercises the
// DoomRuntime wrapper end-to-end without touching real WASM. What we
// pin here is the JS contract: init writes the WAD + caches pointers,
// setKey forwards to dgpt_set_key with the right args, getFramebuffer
// returns a Uint8ClampedArray VIEW (not a copy) into HEAPU8 starting
// at the cached pointer, and key-lookup helpers route via the right
// constant tables.
//
// The real WASM behaviour (BSP traversal, sprite drawing, etc.) is
// covered by the doom.spec.ts e2e suite, which renders against a real
// browser + a real DOOM1.WAD.

import { describe, it, expect, beforeEach } from 'vitest';
import { DoomRuntime, type DoomModule } from './doom-runtime';
import { KEY_FIRE, KEY_RCTRL, KEY_w } from './doomkeys';

// ---------------- Stub DoomModule ----------------

interface CCallRec {
  name: string;
  args: Array<number | string>;
}

function makeStubModule(opts: {
  resX?: number;
  resY?: number;
  pcmSampleCount?: number;
} = {}): { mod: DoomModule; calls: CCallRec[]; fs: Map<string, Uint8Array> } {
  const calls: CCallRec[] = [];
  const fs = new Map<string, Uint8Array>();
  const heapBuffer = new ArrayBuffer(64 * 1024 * 1024); // 64 MB stub heap

  // We pretend the framebuffer starts at offset 0x100000 and PCM at 0x200000.
  // Constants don't matter as long as the stub is internally consistent.
  const FB_PTR = 0x100000;
  const PCM_PTR = 0x200000;
  const resX = opts.resX ?? 640;
  const resY = opts.resY ?? 400;
  const fbSize = resX * resY * 4;
  const pcmSampleCount = opts.pcmSampleCount ?? 0;

  // Fill the framebuffer region with a known pattern so tests can verify
  // they're getting a view into the right offset (not just zero-filled).
  const u8 = new Uint8Array(heapBuffer, FB_PTR, fbSize);
  for (let i = 0; i < u8.length; i++) u8[i] = (i * 13) & 0xff;

  const mod: DoomModule = {
    get HEAPU8() { return new Uint8Array(heapBuffer); },
    get HEAPU32() { return new Uint32Array(heapBuffer); },
    get HEAPF32() { return new Float32Array(heapBuffer); },
    ccall(name, _ret, _argTypes, args) {
      calls.push({ name, args });
      switch (name) {
        case 'dgpt_get_framebuffer': return FB_PTR;
        case 'dgpt_get_framebuffer_size': return fbSize;
        case 'dgpt_get_pcm_buffer': return PCM_PTR;
        case 'dgpt_get_pcm_buffer_size': return pcmSampleCount;
        case 'dgpt_get_resx': return resX;
        case 'dgpt_get_resy': return resY;
        default: return 0;
      }
    },
    FS: {
      writeFile(path, data) { fs.set(path, data); },
      readFile(path) { return fs.get(path) ?? new Uint8Array(0); },
    },
  };

  return { mod, calls, fs };
}

describe('DoomRuntime — TS shim layer', () => {
  let stub: ReturnType<typeof makeStubModule>;
  let rt: DoomRuntime;

  beforeEach(() => {
    stub = makeStubModule();
    rt = new DoomRuntime(stub.mod);
  });

  it('init writes the WAD into MEMFS and calls dgpt_init', () => {
    const wad = new Uint8Array([1, 2, 3, 4, 5]);
    rt.init(wad);
    expect(stub.fs.get('/doom1.wad')).toEqual(wad);
    const initCall = stub.calls.find((c) => c.name === 'dgpt_init');
    expect(initCall).toBeTruthy();
    expect(initCall!.args).toEqual([5]);
  });

  it('init caches framebuffer + pcm pointers via the get_* exports', () => {
    rt.init(new Uint8Array([0]));
    const names = stub.calls.map((c) => c.name);
    expect(names).toContain('dgpt_get_framebuffer');
    expect(names).toContain('dgpt_get_framebuffer_size');
    expect(names).toContain('dgpt_get_pcm_buffer');
    expect(names).toContain('dgpt_get_pcm_buffer_size');
    expect(names).toContain('dgpt_get_resx');
    expect(names).toContain('dgpt_get_resy');
  });

  it('init is idempotent — a second call is a no-op', () => {
    rt.init(new Uint8Array([0]));
    const callsAfterFirst = stub.calls.length;
    rt.init(new Uint8Array([0]));
    expect(stub.calls.length).toBe(callsAfterFirst);
  });

  it('isInitialized flips to true after init', () => {
    expect(rt.isInitialized()).toBe(false);
    rt.init(new Uint8Array([0]));
    expect(rt.isInitialized()).toBe(true);
  });

  it('runTic advances the clock and ticks the engine in that order', () => {
    rt.init(new Uint8Array([0]));
    const before = stub.calls.length;
    rt.runTic(17);
    const newCalls = stub.calls.slice(before);
    expect(newCalls.map((c) => c.name)).toEqual([
      'dgpt_advance_clock',
      'dgpt_tick',
    ]);
    expect(newCalls[0]!.args).toEqual([17]);
  });

  it('runTic before init is a no-op (no native call fires)', () => {
    const before = stub.calls.length;
    rt.runTic(16);
    expect(stub.calls.length).toBe(before);
  });

  it('setKey forwards (doomKey, pressed?1:0) to dgpt_set_key', () => {
    rt.init(new Uint8Array([0]));
    const before = stub.calls.length;
    rt.setKey(KEY_FIRE, true);
    rt.setKey(KEY_RCTRL, false);
    const newCalls = stub.calls.slice(before);
    expect(newCalls).toEqual([
      { name: 'dgpt_set_key', args: [KEY_FIRE, 1] },
      { name: 'dgpt_set_key', args: [KEY_RCTRL, 0] },
    ]);
  });

  it('setKey clamps doomKey to 8 bits defensively', () => {
    rt.init(new Uint8Array([0]));
    const before = stub.calls.length;
    rt.setKey(0x1ff, true);
    const call = stub.calls.slice(before)[0]!;
    expect(call.args[0]).toBe(0xff);
  });

  it('setKeyForKeyboardCode translates via the KEY_FOR_KEYBOARD_CODE table', () => {
    rt.init(new Uint8Array([0]));
    const before = stub.calls.length;
    expect(rt.setKeyForKeyboardCode('KeyW', true)).toBe(true);
    expect(rt.setKeyForKeyboardCode('Space', false)).toBe(true);
    expect(rt.setKeyForKeyboardCode('UnknownCode', true)).toBe(false);
    const calls = stub.calls.slice(before).filter((c) => c.name === 'dgpt_set_key');
    expect(calls).toEqual([
      { name: 'dgpt_set_key', args: [KEY_w, 1] },
      { name: 'dgpt_set_key', args: [KEY_FIRE, 0] },
    ]);
  });

  it('setKeyForCvGate translates via the KEY_FOR_CV_GATE table', () => {
    rt.init(new Uint8Array([0]));
    const before = stub.calls.length;
    expect(rt.setKeyForCvGate('w', true)).toBe(true);
    expect(rt.setKeyForCvGate('space', false)).toBe(true);
    expect(rt.setKeyForCvGate('ctrl', true)).toBe(true);
    const calls = stub.calls.slice(before).filter((c) => c.name === 'dgpt_set_key');
    expect(calls).toEqual([
      { name: 'dgpt_set_key', args: [KEY_w, 1] },
      { name: 'dgpt_set_key', args: [KEY_FIRE, 0] },
      { name: 'dgpt_set_key', args: [KEY_RCTRL, 1] },
    ]);
  });

  it('getFramebuffer returns a Uint8ClampedArray VIEW into HEAPU8 (zero-copy)', () => {
    rt.init(new Uint8Array([0]));
    const fb = rt.getFramebuffer();
    expect(fb).toBeInstanceOf(Uint8ClampedArray);
    expect(fb.length).toBe(640 * 400 * 4);
    // The view's first few bytes should match the pattern the stub seeded
    // at the framebuffer offset (verifies we're looking at HEAPU8 starting
    // at fbPtr, not at the wasm heap origin).
    expect(fb[0]).toBe(0);                  // (0 * 13) & 0xff
    expect(fb[1]).toBe(13);                 // (1 * 13) & 0xff
    expect(fb[2]).toBe((2 * 13) & 0xff);    // 26
    expect(fb[10]).toBe((10 * 13) & 0xff);  // 130
    // The view is BACKED by the heap — mutating it changes the heap
    // (proves zero-copy). Restore afterwards so other assertions stand.
    const saved = fb[0]!;
    fb[0] = 0xab;
    const refreshed = rt.getFramebuffer();
    expect(refreshed[0]).toBe(0xab);
    fb[0] = saved;
  });

  it('resolution returns the cached 640x400 from dgpt_get_res{x,y}', () => {
    rt.init(new Uint8Array([0]));
    expect(rt.resolution()).toEqual({ width: 640, height: 400 });
  });

  it('getPcmBuffer is a Float32Array of zero length when audio is the null impl', () => {
    rt.init(new Uint8Array([0]));
    const pcm = rt.getPcmBuffer();
    expect(pcm).toBeInstanceOf(Float32Array);
    // pcmSampleCount default is 0 → view length 0.
    expect(pcm.length).toBe(0);
  });

  it('getPcmBuffer length tracks 2 * pcmSampleCount (stereo interleave)', () => {
    const s = makeStubModule({ pcmSampleCount: 4096 });
    const r = new DoomRuntime(s.mod);
    r.init(new Uint8Array([0]));
    expect(r.getPcmBuffer().length).toBe(4096 * 2);
  });

  it('dispose makes the runtime treat itself as un-initialized', () => {
    rt.init(new Uint8Array([0]));
    expect(rt.isInitialized()).toBe(true);
    rt.dispose();
    expect(rt.isInitialized()).toBe(false);
  });
});

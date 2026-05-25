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
import { KEY_FIRE, KEY_RCTRL, KEY_USE, KEY_UPARROW, KEY_w } from './doomkeys';

// ---------------- Stub DoomModule ----------------

interface CCallRec {
  name: string;
  args: Array<number | string>;
}

function makeStubModule(opts: {
  resX?: number;
  resY?: number;
  pcmSampleCount?: number;
  /** Slice-8 stub: if provided, dg_get_pcm_buffer copies these bytes
   *  into the destination scratch ptr (int16 little-endian). */
  pcmStream?: Int16Array;
  /** Slice-3 stub: make dgpt_net_inject_packet return 0 (full recv queue). */
  injectFull?: boolean;
} = {}): {
  mod: DoomModule;
  calls: CCallRec[];
  fs: Map<string, Uint8Array>;
  injected: Array<{ bytes: Uint8Array; srcPeerId: number }>;
} {
  const calls: CCallRec[] = [];
  const fs = new Map<string, Uint8Array>();
  const injected: Array<{ bytes: Uint8Array; srcPeerId: number }> = [];
  const heapBuffer = new ArrayBuffer(64 * 1024 * 1024); // 64 MB stub heap

  // We pretend the framebuffer starts at offset 0x100000 and PCM at 0x200000.
  // Constants don't matter as long as the stub is internally consistent.
  const FB_PTR = 0x100000;
  const PCM_PTR = 0x200000;
  const SCRATCH_PTR = 0x300000;  // dg_get_pcm_buffer dest target
  const resX = opts.resX ?? 640;
  const resY = opts.resY ?? 400;
  const fbSize = resX * resY * 4;
  const pcmSampleCount = opts.pcmSampleCount ?? 0;
  const pcmStream = opts.pcmStream ?? new Int16Array(0);
  let streamCursor = 0;
  let mallocOffset = SCRATCH_PTR;

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
        case 'malloc': {
          const ptr = mallocOffset;
          mallocOffset += args[0] as number;
          return ptr;
        }
        case 'free': return 0;
        case 'dg_get_pcm_buffer': {
          const dest = args[0] as number;
          const frames = args[1] as number;
          const view = new Int16Array(heapBuffer, dest, frames);
          let produced = 0;
          for (let i = 0; i < frames; i++) {
            if (streamCursor < pcmStream.length) {
              view[i] = pcmStream[streamCursor++]!;
              produced++;
            } else {
              view[i] = 0;
            }
          }
          return produced;
        }
        case 'dg_get_pcm_buffered_frames':
          return Math.max(0, pcmStream.length - streamCursor);
        case 'dg_get_pcm_sample_rate':
          return 44100;
        case 'dgpt_net_inject_packet': {
          // Slice 3: record the heap bytes the runtime copied in so the
          // inject test can assert the copy + the src-peer-id. Returns 1
          // (accepted) unless opts.injectFull simulates a full recv queue.
          const ptr = args[0] as number;
          const len = args[1] as number;
          const src = args[2] as number;
          const copied = len > 0
            ? new Uint8Array(heapBuffer.slice(ptr, ptr + len))
            : new Uint8Array(0);
          injected.push({ bytes: copied, srcPeerId: src });
          return opts.injectFull ? 0 : 1;
        }
        default: return 0;
      }
    },
    FS: {
      writeFile(path, data) { fs.set(path, data); },
      readFile(path) { return fs.get(path) ?? new Uint8Array(0); },
    },
  };

  return { mod, calls, fs, injected };
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
      // Space is now USE (open doors) — MacBook-friendly default.
      { name: 'dgpt_set_key', args: [KEY_USE, 0] },
    ]);
  });

  it('setKeyForCvGate translates via the KEY_FOR_CV_GATE table', () => {
    rt.init(new Uint8Array([0]));
    const before = stub.calls.length;
    expect(rt.setKeyForCvGate('up', true)).toBe(true);
    expect(rt.setKeyForCvGate('space', false)).toBe(true);
    expect(rt.setKeyForCvGate('ctrl', true)).toBe(true);
    const calls = stub.calls.slice(before).filter((c) => c.name === 'dgpt_set_key');
    // KEY_UPARROW = 0xae, but dgpt_set_key masks to 0xff (no change here);
    // KEY_FIRE = 0xa3; KEY_RCTRL = 0x9d. The reference to KEY_w stays in
    // the imports for KEY_FOR_KEYBOARD_CODE tests above — runtime still
    // honors KeyW.
    void KEY_w;
    expect(calls).toEqual([
      { name: 'dgpt_set_key', args: [KEY_UPARROW, 1] },
      // space gate = USE (doors), ctrl gate = FIRE (mirrors keyboard map).
      { name: 'dgpt_set_key', args: [KEY_USE, 0] },
      { name: 'dgpt_set_key', args: [KEY_FIRE, 1] },
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

  it('hasPlayerMobj returns false before init + reflects the WASM bool after', () => {
    // Before init.
    expect(rt.hasPlayerMobj()).toBe(false);
    // After init: stub returns 0 by default → false.
    rt.init(new Uint8Array([0]));
    expect(rt.hasPlayerMobj()).toBe(false);
    // Switch the stub to return 1 for dgpt_has_player_mobj and re-check.
    const customStub = makeStubModule();
    const origCcall = customStub.mod.ccall;
    customStub.mod.ccall = (name, ret, argTypes, args) => {
      if (name === 'dgpt_has_player_mobj') return 1;
      return origCcall.call(customStub.mod, name, ret, argTypes, args);
    };
    const r2 = new DoomRuntime(customStub.mod);
    r2.init(new Uint8Array([0]));
    expect(r2.hasPlayerMobj()).toBe(true);
  });

  it('getPlayerState returns null before mobj spawns, struct after', () => {
    // Before init.
    expect(rt.getPlayerState()).toBeNull();

    // Custom stub that pretends the mobj exists at (x=1024, y=2048, angle=0xC0000000).
    const custom = makeStubModule();
    const orig = custom.mod.ccall;
    custom.mod.ccall = (name, ret, argTypes, args) => {
      if (name === 'dgpt_has_player_mobj') return 1;
      if (name === 'dgpt_get_player_x') return 1024;
      if (name === 'dgpt_get_player_y') return 2048;
      if (name === 'dgpt_get_player_angle') return 0xC0000000; // bit 31 set
      return orig.call(custom.mod, name, ret, argTypes, args);
    };
    const r2 = new DoomRuntime(custom.mod);
    r2.init(new Uint8Array([0]));
    expect(r2.getPlayerState()).toEqual({
      x: 1024,
      y: 2048,
      angle: 0xC0000000, // verifies unsigned coercion via `>>> 0`
    });
  });
});

// ---------------- Slice-8 PCM pull ----------------

describe('DoomRuntime — slice 8 PCM pull (getPcmFrames)', () => {
  it('returns empty Float32Array before init', () => {
    const { mod } = makeStubModule();
    const rt = new DoomRuntime(mod);
    const out = rt.getPcmFrames(128);
    expect(out).toBeInstanceOf(Float32Array);
    expect(out.length).toBe(0);
  });

  it('round-trips s16 samples from the WASM mixer into normalized f32', () => {
    // Stream: alternating peak positives and negatives so we can
    // confirm both signs land in the normalized [-1, +1] range.
    const stream = new Int16Array([
      32767, -32768, 16384, -16384, 0, 8192, -8192, 100,
    ]);
    const { mod } = makeStubModule({ pcmStream: stream });
    const rt = new DoomRuntime(mod);
    rt.init(new Uint8Array([0]));
    const out = rt.getPcmFrames(stream.length);
    expect(out.length).toBe(stream.length);
    // The wrapper does /32768 — int16 peak positive (32767) lands at
    // ~0.99997, peak negative (-32768) lands at exactly -1.
    expect(out[0]).toBeCloseTo(32767 / 32768, 5);
    expect(out[1]).toBeCloseTo(-1, 5);
    expect(out[2]).toBeCloseTo(0.5, 5);
    expect(out[3]).toBeCloseTo(-0.5, 5);
    expect(out[4]).toBe(0);
    expect(out[7]).toBeCloseTo(100 / 32768, 5);
  });

  it('pads with silence on underrun', () => {
    const stream = new Int16Array([16384, 16384, 16384]);
    const { mod } = makeStubModule({ pcmStream: stream });
    const rt = new DoomRuntime(mod);
    rt.init(new Uint8Array([0]));
    const out = rt.getPcmFrames(8);
    // First 3 from stream, then 5 zeros.
    expect(out[0]).toBeCloseTo(0.5, 5);
    expect(out[1]).toBeCloseTo(0.5, 5);
    expect(out[2]).toBeCloseTo(0.5, 5);
    expect(out[3]).toBe(0);
    expect(out[7]).toBe(0);
  });

  it('allocates a scratch ptr lazily via malloc on first call', () => {
    const { mod, calls } = makeStubModule({ pcmStream: new Int16Array([1, 2, 3]) });
    const rt = new DoomRuntime(mod);
    rt.init(new Uint8Array([0]));
    const before = calls.filter((c) => c.name === 'malloc').length;
    rt.getPcmFrames(64);
    const after = calls.filter((c) => c.name === 'malloc').length;
    expect(after).toBeGreaterThan(before);
  });

  it('reuses the scratch ptr across same-size calls (no malloc churn)', () => {
    const { mod, calls } = makeStubModule({ pcmStream: new Int16Array(2048) });
    const rt = new DoomRuntime(mod);
    rt.init(new Uint8Array([0]));
    rt.getPcmFrames(128);
    const mallocsAfterFirst = calls.filter((c) => c.name === 'malloc').length;
    rt.getPcmFrames(128);
    rt.getPcmFrames(128);
    rt.getPcmFrames(128);
    const mallocsAfterFourth = calls.filter((c) => c.name === 'malloc').length;
    expect(mallocsAfterFourth).toBe(mallocsAfterFirst);
  });

  it('grows the scratch ptr when callers ask for more frames', () => {
    const { mod, calls } = makeStubModule({ pcmStream: new Int16Array(4096) });
    const rt = new DoomRuntime(mod);
    rt.init(new Uint8Array([0]));
    rt.getPcmFrames(128);
    const before = calls.filter((c) => c.name === 'malloc').length;
    rt.getPcmFrames(2048);  // bigger — must reallocate
    const after = calls.filter((c) => c.name === 'malloc').length;
    expect(after).toBe(before + 1);
    // And free the old.
    expect(calls.filter((c) => c.name === 'free').length).toBe(1);
  });

  it('getPcmSampleRate returns 44100 (mixer constant)', () => {
    const { mod } = makeStubModule();
    const rt = new DoomRuntime(mod);
    rt.init(new Uint8Array([0]));
    expect(rt.getPcmSampleRate()).toBe(44100);
  });

  it('getPcmBufferedFrames returns 0 before init + nonzero after', () => {
    const stream = new Int16Array(1024);
    const { mod } = makeStubModule({ pcmStream: stream });
    const rt = new DoomRuntime(mod);
    expect(rt.getPcmBufferedFrames()).toBe(0);
    rt.init(new Uint8Array([0]));
    expect(rt.getPcmBufferedFrames()).toBe(1024);
  });
});

// ---------------- Slice-3 netcode bridge (getModule + injectNetPacket) ----

describe('DoomRuntime — slice 3 netcode bridge', () => {
  it('getModule returns the emcc module (so netcode can install PTNet)', () => {
    const { mod } = makeStubModule();
    const rt = new DoomRuntime(mod);
    expect(rt.getModule()).toBe(mod);
    // The netcode installs Module.PTNet on it — confirm the handle is the
    // live object, not a copy.
    const m = rt.getModule()!;
    (m as unknown as { PTNet?: unknown }).PTNet = { marker: true };
    expect((mod as unknown as { PTNet?: { marker?: boolean } }).PTNet?.marker).toBe(true);
  });

  it('injectNetPacket is a no-op (false) before init', () => {
    const { mod, injected } = makeStubModule();
    const rt = new DoomRuntime(mod);
    expect(rt.injectNetPacket(new Uint8Array([1, 2, 3]), 0)).toBe(false);
    expect(injected.length).toBe(0);
  });

  it('copies bytes into the heap + calls dgpt_net_inject_packet with src peer id', () => {
    const { mod, injected, calls } = makeStubModule();
    const rt = new DoomRuntime(mod);
    rt.init(new Uint8Array([0]));
    const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x42]);
    const ok = rt.injectNetPacket(payload, 3);
    expect(ok).toBe(true);
    expect(injected.length).toBe(1);
    // The bytes the C side saw at `ptr` must equal what we passed in.
    expect(Array.from(injected[0]!.bytes)).toEqual(Array.from(payload));
    expect(injected[0]!.srcPeerId).toBe(3);
    // malloc + free bracket the inject call (no heap leak).
    const order = calls.map((c) => c.name).filter(
      (n) => n === 'malloc' || n === 'dgpt_net_inject_packet' || n === 'free',
    );
    const injectIdx = order.indexOf('dgpt_net_inject_packet');
    expect(order.lastIndexOf('malloc')).toBeLessThan(injectIdx);
    expect(order.indexOf('free', injectIdx)).toBeGreaterThan(injectIdx);
  });

  it('returns false when the C recv queue is full (inject returns 0)', () => {
    const { mod } = makeStubModule({ injectFull: true });
    const rt = new DoomRuntime(mod);
    rt.init(new Uint8Array([0]));
    expect(rt.injectNetPacket(new Uint8Array([1, 2, 3]), 1)).toBe(false);
  });

  it('handles a zero-length packet without mallocing', () => {
    const { mod, injected, calls } = makeStubModule();
    const rt = new DoomRuntime(mod);
    rt.init(new Uint8Array([0]));
    const mallocsBefore = calls.filter((c) => c.name === 'malloc').length;
    const ok = rt.injectNetPacket(new Uint8Array(0), 2);
    expect(ok).toBe(true);
    expect(injected.length).toBe(1);
    expect(injected[0]!.bytes.length).toBe(0);
    expect(injected[0]!.srcPeerId).toBe(2);
    // No malloc for the empty case.
    expect(calls.filter((c) => c.name === 'malloc').length).toBe(mallocsBefore);
  });
});

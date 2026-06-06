// packages/web/src/lib/qbert/qbert-runtime.test.ts
//
// Runtime wire-up smoke. Stubs the parsed ROM map (no static-dir touch)
// and asserts:
//   - "ROM missing" path: createQbertRuntime({ roms: null }) returns a
//     runtime that's NOT initialized + carries the error string.
//   - ROM-present path: createQbertRuntime({ roms: <stub> }) initializes
//     and ticks without throwing.
//   - Joystick + events: setJoystick('SE') → runTic enough → drainEvents
//     yields at least one `move`.
//   - PCM drain: after a move event fires, getPcmFrames returns non-zero
//     audio (proves the synthesized blip pipeline + ring buffer).

import { describe, it, expect } from 'vitest';
import {
  createQbertRuntime,
  MAIN_ROM_FILENAMES,
  QBERT_WIDTH,
  QBERT_HEIGHT,
  type QbertRomMap,
} from './qbert-runtime';

function stubRomMap(): QbertRomMap {
  // 4 KB chunk per main ROM, all NOPs (0x00). Enough for the Z80 to
  // happily tick without touching the unmapped opcode path.
  const chunk = new Uint8Array(0x1000);
  const roms = new Map<string, Uint8Array>();
  for (const name of MAIN_ROM_FILENAMES) roms.set(name, chunk);
  return { roms };
}

describe('createQbertRuntime — ROM missing path', () => {
  it('returns a non-initialized runtime + surfaces loadError', () => {
    const rt = createQbertRuntime({ roms: null, loadError: 'ROM missing — run `task setup:qbert`' });
    expect(rt.isInitialized()).toBe(false);
    expect(rt.loadError()).toMatch(/ROM missing/);
    // Framebuffer is still present (test pattern) so the canvas isn't
    // black.
    const fb = rt.getFramebuffer();
    expect(fb.length).toBe(QBERT_WIDTH * QBERT_HEIGHT * 4);
    // runTic is a no-op but must NOT throw.
    expect(() => rt.runTic(16)).not.toThrow();
    expect(rt.drainEvents()).toEqual([]);
  });
});

describe('createQbertRuntime — ROM present path', () => {
  it('initializes + ticks without throwing', () => {
    const rt = createQbertRuntime({ roms: stubRomMap() });
    expect(rt.isInitialized()).toBe(true);
    expect(rt.loadError()).toBe('');
    rt.runTic(16);
    // No coin → no events.
    expect(rt.drainEvents()).toEqual([]);
  });

  it('insertCoin + pressStart + setJoystick(SE) → move events accumulate', () => {
    const rt = createQbertRuntime({ roms: stubRomMap() });
    rt.insertCoin();
    rt.pressStart();
    rt.setJoystick('SE');
    // Tick enough internal tics to cross the 8-tic move threshold (each
    // runTic increments `tic` by 1). 20 calls is plenty.
    for (let i = 0; i < 20; i++) rt.runTic(16);
    const evts = rt.drainEvents();
    expect(evts.length).toBeGreaterThan(0);
    expect(evts.every((e) => e.type === 'move' || e.type === 'level')).toBe(true);
    // Second drain is empty (single-shot).
    expect(rt.drainEvents()).toEqual([]);
  });

  it('move event fires audio blip → PCM frames contain non-zero samples', () => {
    const rt = createQbertRuntime({ roms: stubRomMap() });
    rt.insertCoin();
    rt.pressStart();
    rt.setJoystick('SE');
    // Drive enough tics to fire AT LEAST one move event + populate the
    // audio ring. A blip = ~50ms = ~2205 samples; we drain on each tic to
    // keep the read pointer abreast of the writer so the post-event blip
    // is visible (otherwise the older silence at the head of the ring
    // would mask it).
    let totalNonZero = 0;
    for (let i = 0; i < 30; i++) {
      rt.runTic(16);
      const chunk = rt.getPcmFrames(4096);
      for (const v of chunk) if (v !== 0) totalNonZero += 1;
    }
    expect(totalNonZero).toBeGreaterThan(0);
  });
});

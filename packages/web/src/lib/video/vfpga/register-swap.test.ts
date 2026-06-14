// packages/web/src/lib/video/vfpga/register-swap.test.ts
//
// Pure (GL-free) unit tests for the register ping-pong SWAP — the fabric clock
// edge (P1). Mirrors the factory's real use: the host writes the FRONT buffer
// each frame and a `:prev` net reads the BACK buffer; after the swap the buffer
// just written becomes next frame's back (prev) read.

import { describe, expect, it } from 'vitest';
import { swapRegisters, type RegisterSwapPair } from './register-swap';

const PAIR: RegisterSwapPair = { front: 'fbo_r__a', back: 'fbo_r__b' };

describe('swapRegisters', () => {
  it('exchanges the front + back buffers under their stable ids', () => {
    const fbos = new Map<string, string>([
      ['fbo_r__a', 'A'], // front (written this frame)
      ['fbo_r__b', 'B'], // back (last frame, read via :prev)
    ]);
    swapRegisters(fbos, [PAIR]);
    // The just-written 'A' now sits under the BACK id → next frame's :prev reads it.
    expect(fbos.get('fbo_r__b')).toBe('A');
    // The stale 'B' rotates to the FRONT id → it's overwritten next frame.
    expect(fbos.get('fbo_r__a')).toBe('B');
  });

  it('clock semantics: a :prev read sees the buffer WRITTEN the previous frame', () => {
    // Model two frames. Each frame: write a fresh value into the FRONT id, then
    // a :prev read samples the BACK id, then swap.
    const fbos = new Map<string, string>([
      ['fbo_r__a', 'init-front'],
      ['fbo_r__b', 'init-back'],
    ]);
    // FRAME 0: write 'f0' into front; :prev reads back (the cold init).
    fbos.set('fbo_r__a', 'f0');
    expect(fbos.get('fbo_r__b')).toBe('init-back'); // prev = cold start
    swapRegisters(fbos, [PAIR]);
    // FRAME 1: :prev now reads 'f0' (what frame 0 wrote) — the clocked delay.
    expect(fbos.get('fbo_r__b')).toBe('f0');
    fbos.set('fbo_r__a', 'f1'); // write this frame into the (rotated) front
    swapRegisters(fbos, [PAIR]);
    // FRAME 2: :prev reads 'f1'.
    expect(fbos.get('fbo_r__b')).toBe('f1');
  });

  it('a double swap is the identity (no net change over two frames with no write)', () => {
    const fbos = new Map<string, string>([
      ['fbo_r__a', 'A'],
      ['fbo_r__b', 'B'],
    ]);
    swapRegisters(fbos, [PAIR]);
    swapRegisters(fbos, [PAIR]);
    expect(fbos.get('fbo_r__a')).toBe('A');
    expect(fbos.get('fbo_r__b')).toBe('B');
  });

  it('swaps every register pair independently', () => {
    const fbos = new Map<string, string>([
      ['fbo_r1__a', 'A1'], ['fbo_r1__b', 'B1'],
      ['fbo_r2__a', 'A2'], ['fbo_r2__b', 'B2'],
    ]);
    swapRegisters(fbos, [
      { front: 'fbo_r1__a', back: 'fbo_r1__b' },
      { front: 'fbo_r2__a', back: 'fbo_r2__b' },
    ]);
    expect(fbos.get('fbo_r1__b')).toBe('A1');
    expect(fbos.get('fbo_r2__b')).toBe('A2');
  });

  it('skips a pair whose ids are absent (degenerate surface-driving register)', () => {
    const fbos = new Map<string, string>([['fbo_r__a', 'A']]); // back id missing
    expect(() => swapRegisters(fbos, [PAIR])).not.toThrow();
    expect(fbos.get('fbo_r__a')).toBe('A'); // unchanged
  });

  it('an empty register list is a no-op', () => {
    const fbos = new Map<string, string>([['x', '1']]);
    swapRegisters(fbos, []);
    expect(fbos.get('x')).toBe('1');
  });
});

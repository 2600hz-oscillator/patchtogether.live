// packages/web/src/lib/video/vfpga/register-swap.ts
//
// The register ping-pong SWAP (P1, design §1.1/§4.3) — the fabric "clock edge".
// A register tile is a flip-flop: it WRITES its front buffer this frame, and a
// `<regId>:prev` net READS its back buffer (last frame). After a frame's passes
// draw, the host swaps front↔back so the buffer just written becomes next
// frame's `:prev` read. (The b3ntb0x / feedback ping-pong, generalised over the
// P&R'd register set.)
//
// Kept as a TINY pure function (over an `id → buffer` map) so the swap is
// unit-tested GL-FREE — the factory's draw() calls it on its real GL FBO map.

/** One register's two FBO ids (the P&R `VfpgaRegisterPair` minus diagnostics). */
export interface RegisterSwapPair {
  front: string;
  back: string;
}

/** Swap each register pair's front↔back entries in `fbos` (keyed by fbo id),
 *  IN PLACE. Generic over the buffer value type (the factory's `{fbo,texture}`,
 *  or a plain marker in tests) — exchanging the values under the two stable ids
 *  means the next frame's lookups resolve to the rotated buffers with no
 *  pass-binding rewrite. A pair whose ids are absent from `fbos` is skipped
 *  (defensive: a degenerate register that drives the surface 'output'). */
export function swapRegisters<T>(
  fbos: Map<string, T>,
  registers: readonly RegisterSwapPair[],
): void {
  for (const reg of registers) {
    const front = fbos.get(reg.front);
    const back = fbos.get(reg.back);
    if (front === undefined || back === undefined) continue;
    fbos.set(reg.front, back);
    fbos.set(reg.back, front);
  }
}

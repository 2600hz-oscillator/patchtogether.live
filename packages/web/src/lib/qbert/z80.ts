// packages/web/src/lib/qbert/z80.ts
//
// Minimal Z80 core — JUST enough to (a) prove the wire-up via the
// `LD A,1 / HALT / NOP` smoke test and (b) tick the QBERT main CPU
// in stub mode (the v1 emulator does not require cycle-accurate opcode
// coverage — see qbert-runtime.ts header for the full scope statement).
//
// Why hand-roll this instead of pulling in DrGoldfire/Z80.js?
//
// Z80.js (MIT, ~30 KB) was the recommendation in the QBERT module spec
// and remains the right answer if the project commits to playable
// gameplay — its opcode coverage is complete and battle-tested. For v1
// we ship the engine SHAPE (memory map + framebuffer + event-gates +
// ROM-zip plumbing) without a full opcode set, so a 100-line core that
// implements LD/NOP/HALT/JP is enough to keep the test green + the
// runtime ticking; the rest is gated behind a follow-up that swaps in
// Z80.js (or a WASM-backed core) once we want real gameplay. Hand-
// rolled keeps us inside a single source file with zero deps + zero
// licence drag in the meantime.
//
// Coverage:
//   - NOP (0x00)
//   - HALT (0x76) — sets `halted = true` + stops advancing PC
//   - LD A,n (0x3E) — load 8-bit immediate into A
//   - LD r,n for B/C/D/E/H/L (0x06/0x0E/0x16/0x1E/0x26/0x2E)
//   - JP nn (0xC3) — unconditional jump
//   - DI (0xF3) — disable interrupts (we don't fire interrupts in v1
//                 anyway; the opcode just consumes a byte)
//   - EI (0xFB) — enable interrupts (same caveat)
//
// Any other opcode is treated as a 1-byte NOP + logged via the
// `onUnknownOpcode` callback. The QBERT runtime test path only exercises
// the documented set; gameplay-grade opcode coverage is a separate slice.

/** Public state of the core — exposed for the smoke test + the runtime. */
export interface Z80State {
  /** Program counter. 16-bit unsigned. */
  pc: number;
  /** Stack pointer. 16-bit unsigned. */
  sp: number;
  /** 8-bit registers, little-endian within a pair. */
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  h: number;
  l: number;
  /** Interrupt-flip-flops 1 + 2. EI sets both, DI clears IFF1. */
  iff1: boolean;
  iff2: boolean;
  /** True once a HALT opcode has executed; the core stays at HALT until
   *  an interrupt would fire (we don't model that path in v1 — HALT is
   *  the test stop condition). */
  halted: boolean;
  /** Cumulative T-state count since reset. NOP = 4, HALT = 4, LD r,n = 7,
   *  JP nn = 10 — see Zilog reference. Used by the runtime to throttle
   *  the per-frame budget. */
  cycles: number;
}

/** Memory bus — the runtime owns the bytes (cartridge + RAM + I/O). */
export interface Z80Memory {
  /** Read one byte at address `addr` (16-bit). MUST handle the full 64 KB
   *  address space and never throw. */
  read(addr: number): number;
  /** Write one byte at address `addr` (16-bit). Reads from ROM ranges
   *  should be silently no-op'd; the core does NOT enforce ROM/RAM. */
  write(addr: number, value: number): void;
}

export interface Z80CoreOpts {
  memory: Z80Memory;
  /** Optional hook fired on any opcode the core treats as NOP. Useful for
   *  the test harness + the follow-up Z80.js swap so we can see what
   *  gameplay needs that the stub doesn't support. */
  onUnknownOpcode?: (pc: number, opcode: number) => void;
}

/** Create a fresh Z80 core. Returns a tiny object surface with `step()`
 *  + `state` access; the runtime calls `step()` in a tight loop until
 *  its cycle budget is exhausted. */
export function createZ80(opts: Z80CoreOpts): {
  state: Z80State;
  step(): void;
  reset(): void;
} {
  const state: Z80State = {
    pc: 0, sp: 0,
    a: 0, b: 0, c: 0, d: 0, e: 0, h: 0, l: 0,
    iff1: false, iff2: false,
    halted: false, cycles: 0,
  };
  const mem = opts.memory;

  function read8(addr: number): number {
    return mem.read(addr & 0xFFFF) & 0xFF;
  }

  function fetch8(): number {
    const v = read8(state.pc);
    state.pc = (state.pc + 1) & 0xFFFF;
    return v;
  }

  function fetch16(): number {
    const lo = fetch8();
    const hi = fetch8();
    return (hi << 8) | lo;
  }

  function step(): void {
    if (state.halted) {
      // HALT semantics — burn 4 T-states per tick without advancing PC.
      // The runtime's outer loop guards on `halted` to bail early when
      // appropriate.
      state.cycles += 4;
      return;
    }
    const op = fetch8();
    switch (op) {
      case 0x00: // NOP
        state.cycles += 4;
        return;
      case 0x76: // HALT
        state.halted = true;
        state.cycles += 4;
        return;
      case 0x06: state.b = fetch8(); state.cycles += 7; return; // LD B,n
      case 0x0E: state.c = fetch8(); state.cycles += 7; return; // LD C,n
      case 0x16: state.d = fetch8(); state.cycles += 7; return; // LD D,n
      case 0x1E: state.e = fetch8(); state.cycles += 7; return; // LD E,n
      case 0x26: state.h = fetch8(); state.cycles += 7; return; // LD H,n
      case 0x2E: state.l = fetch8(); state.cycles += 7; return; // LD L,n
      case 0x3E: state.a = fetch8(); state.cycles += 7; return; // LD A,n
      case 0xC3: state.pc = fetch16(); state.cycles += 10; return; // JP nn
      case 0xF3: state.iff1 = false; state.iff2 = false; state.cycles += 4; return; // DI
      case 0xFB: state.iff1 = true; state.iff2 = true; state.cycles += 4; return; // EI
      default:
        // Anything else: treat as 1-byte NOP + notify. Coverage matrix
        // for "gameplay-grade Q*Bert" lives behind the follow-up; in v1
        // we just keep the core ticking past unknown opcodes so the
        // smoke test + the surrounding plumbing (memory, framebuffer
        // upload, event-gate pulses) can be exercised end-to-end.
        if (opts.onUnknownOpcode) opts.onUnknownOpcode((state.pc - 1) & 0xFFFF, op);
        state.cycles += 4;
        return;
    }
  }

  function reset(): void {
    state.pc = 0; state.sp = 0;
    state.a = 0; state.b = 0; state.c = 0; state.d = 0;
    state.e = 0; state.h = 0; state.l = 0;
    state.iff1 = false; state.iff2 = false;
    state.halted = false; state.cycles = 0;
  }

  return { state, step, reset };
}

// packages/web/src/lib/qbert/z80.test.ts
//
// Smoke test: spin up the Z80 with a 16-byte synthetic ROM and assert the
// PC advances + HALT fires. Proves the core wires up to its memory bus
// AND the small opcode subset we ship in v1 (LD A,1 / HALT / NOPs).

import { describe, it, expect } from 'vitest';
import { createZ80, type Z80Memory } from './z80';

function rom(bytes: number[]): Z80Memory {
  const buf = new Uint8Array(64 * 1024);
  for (let i = 0; i < bytes.length; i++) buf[i] = bytes[i]! & 0xFF;
  return {
    read: (addr) => buf[addr & 0xFFFF] ?? 0,
    write: (addr, v) => { buf[addr & 0xFFFF] = v & 0xFF; },
  };
}

describe('Z80 core — wire-up smoke', () => {
  it('runs LD A,1 / HALT / NOP from a 16-byte ROM, advancing PC and halting', () => {
    // Program:
    //   0x0000: 3E 01    LD A,1
    //   0x0002: 76       HALT
    //   0x0003: 00 ... NOP pad to 16 bytes
    const program = [0x3E, 0x01, 0x76];
    while (program.length < 16) program.push(0x00);
    const core = createZ80({ memory: rom(program) });

    // Tick once → consume `LD A,1`. PC should advance by 2, A = 1.
    core.step();
    expect(core.state.pc).toBe(0x0002);
    expect(core.state.a).toBe(0x01);
    expect(core.state.halted).toBe(false);
    expect(core.state.cycles).toBe(7);

    // Tick again → consume `HALT`. PC advances by 1, halted = true.
    core.step();
    expect(core.state.pc).toBe(0x0003);
    expect(core.state.halted).toBe(true);
    // 7 (LD A,n) + 4 (HALT) = 11 T-states.
    expect(core.state.cycles).toBe(11);

    // Subsequent ticks must STAY halted (PC frozen).
    core.step();
    core.step();
    expect(core.state.halted).toBe(true);
    expect(core.state.pc).toBe(0x0003);
    // Each halted step still burns 4 T-states (HALT semantic).
    expect(core.state.cycles).toBe(11 + 4 + 4);
  });

  it('JP nn jumps PC + resets to 0 after explicit reset()', () => {
    // 0xC3 0x10 0x00 → JP 0x0010
    const core = createZ80({ memory: rom([0xC3, 0x10, 0x00]) });
    core.step();
    expect(core.state.pc).toBe(0x0010);
    expect(core.state.cycles).toBe(10);
    core.reset();
    expect(core.state.pc).toBe(0);
    expect(core.state.cycles).toBe(0);
  });

  it('unknown opcodes are NOP-with-callback (so gameplay-grade ROMs do not crash the core)', () => {
    const seen: number[] = [];
    const core = createZ80({
      memory: rom([0xED, 0x00]), // ED is unsupported in v1
      onUnknownOpcode: (_pc, op) => seen.push(op),
    });
    core.step();
    expect(seen).toEqual([0xED]);
    expect(core.state.pc).toBe(0x0001);
    expect(core.state.halted).toBe(false);
  });
});

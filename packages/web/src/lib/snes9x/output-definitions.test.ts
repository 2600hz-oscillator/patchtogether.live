// packages/web/src/lib/snes9x/output-definitions.test.ts
//
// Unit tests for the per-ROM output-definition registry + ROM identification
// (the data behind the "see output definition for CV/GATES" panel).

import { describe, it, expect } from 'vitest';
import {
  SMW_OUTPUT_DEF,
  GENERIC_OUTPUT_DEF,
  getOutputDefinition,
  identifyGame,
  readHeaderTitle,
} from './output-definitions';

describe('SMW_OUTPUT_DEF', () => {
  it('documents all 8 outputs (gate1..4, cv1..4)', () => {
    const ports = SMW_OUTPUT_DEF.outputs.map((o) => o.port);
    expect(ports).toEqual(['gate1', 'gate2', 'gate3', 'gate4', 'cv1', 'cv2', 'cv3', 'cv4']);
  });

  it('marks gate1/gate2/gate3/cv1 active and the rest reserved (SMW first-pass)', () => {
    const active = SMW_OUTPUT_DEF.outputs.filter((o) => o.active).map((o) => o.port);
    expect(active.sort()).toEqual(['cv1', 'gate1', 'gate2', 'gate3']);
  });

  it('every active output description names its RAM source', () => {
    for (const o of SMW_OUTPUT_DEF.outputs.filter((x) => x.active)) {
      expect(o.description).toMatch(/\$7E[0-9A-Fa-f]{4}/);
    }
  });

  it('notes document the world/level mapping + every RAM address', () => {
    const notes = SMW_OUTPUT_DEF.notes.join(' ');
    expect(notes).toMatch(/world\/level mapping/i);
    for (const addr of ['$7E0100', '$7E0DBE', '$7E0071', '$7E13BF', '$7E1F11', '$7E14C8']) {
      expect(notes).toContain(addr);
    }
  });
});

describe('getOutputDefinition', () => {
  it('returns the SMW def for "smw"', () => {
    expect(getOutputDefinition('smw')).toBe(SMW_OUTPUT_DEF);
  });
  it('falls back to generic for unknown ids', () => {
    expect(getOutputDefinition('zzz')).toBe(GENERIC_OUTPUT_DEF);
  });
});

describe('identifyGame / readHeaderTitle', () => {
  /** Build a LoROM-shaped ROM with a given internal title at $7FC0. */
  function romWithTitle(title: string, size = 0x10000): Uint8Array {
    const rom = new Uint8Array(size);
    const padded = (title + ' '.repeat(21)).slice(0, 21);
    for (let i = 0; i < 21; i++) rom[0x7fc0 + i] = padded.charCodeAt(i);
    return rom;
  }

  it('reads the LoROM header title', () => {
    const rom = romWithTitle('SUPER MARIOWORLD');
    expect(readHeaderTitle(rom)).toMatch(/SUPER MARIOWORLD/);
  });

  it('identifies Super Mario World → "smw"', () => {
    expect(identifyGame(romWithTitle('SUPER MARIOWORLD'))).toBe('smw');
  });

  it('unknown title → "generic"', () => {
    expect(identifyGame(romWithTitle('ZELDA NO DENSETSU'))).toBe('generic');
  });

  it('null / too-small ROM → "generic"', () => {
    expect(identifyGame(null)).toBe('generic');
    expect(identifyGame(new Uint8Array(16))).toBe('generic');
  });

  it('tolerates a 512-byte copier header', () => {
    const base = romWithTitle('SUPER MARIOWORLD', 0x10000);
    const withHeader = new Uint8Array(0x10000 + 512);
    withHeader.set(base, 512);
    expect(identifyGame(withHeader)).toBe('smw');
  });
});

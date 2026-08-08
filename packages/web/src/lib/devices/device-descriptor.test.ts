// packages/web/src/lib/devices/device-descriptor.test.ts
//
// DENY BY DEFAULT: every shipped descriptor must validate. The validator is
// itself negative-controlled here — each check is proved to FIRE on a
// deliberately broken descriptor, because a validator that silently returns
// `[]` for everything looks exactly like a codebase with no bugs in it.

import { describe, expect, it } from 'vitest';
import {
  actionControls,
  controlById,
  enumRangeAt,
  enumRangeValue,
  formatControlValue,
  matchPortByHint,
  resolveSlots,
  slottableControls,
  validateDescriptor,
  type DeviceControl,
  type DeviceDescriptor,
} from './device-descriptor';
import { CHROMA_CONSOLE, DEVICE_DESCRIPTORS } from './hologram-chroma-console';

/** A minimal valid descriptor to mutate per negative-control case. */
function baseDescriptor(overrides: Partial<DeviceDescriptor> = {}): DeviceDescriptor {
  const control: DeviceControl = {
    id: 'a',
    label: 'a',
    group: 'g',
    role: 'continuous',
    cc: 1,
    resolution: 7,
    default: 0,
    format: 'raw7',
    doc: 'doc',
    source: 'manual',
  };
  return {
    id: 'test',
    manufacturer: 'M',
    name: 'N',
    portHints: ['N'],
    defaultChannel: 1,
    readBack: 'none',
    controls: [control],
    defaultSlots: ['a'],
    ...overrides,
  };
}

describe('every SHIPPED descriptor validates', () => {
  it('the registry is non-empty (guards a barrel that silently no-ops)', () => {
    expect(DEVICE_DESCRIPTORS.length).toBeGreaterThan(0);
  });

  it.each(DEVICE_DESCRIPTORS.map((d) => [d.id, d] as const))('%s', (_id, descriptor) => {
    expect(validateDescriptor(descriptor), validateDescriptor(descriptor).join('\n')).toEqual([]);
  });
});

describe('validateDescriptor — each check actually FIRES (the instrument control)', () => {
  it('catches a duplicate control id', () => {
    const d = baseDescriptor();
    const dupe = { ...d.controls[0]!, cc: 2 };
    expect(validateDescriptor({ ...d, controls: [d.controls[0]!, dupe] }).join()).toMatch(
      /duplicate control id/,
    );
  });

  it('catches two controls sharing one CC', () => {
    const d = baseDescriptor();
    const clash = { ...d.controls[0]!, id: 'b' };
    expect(validateDescriptor({ ...d, controls: [d.controls[0]!, clash] }).join()).toMatch(
      /both use CC 1/,
    );
  });

  it('catches a 14-bit control whose LSB would be a defined function', () => {
    const d = baseDescriptor();
    const bad = { ...d.controls[0]!, cc: 64, resolution: 14 as const };
    expect(validateDescriptor({ ...d, controls: [bad], defaultSlots: ['a'] }).join()).toMatch(
      /cannot be 14-bit/,
    );
  });

  it('catches a 14-bit LSB colliding with another declared control', () => {
    const d = baseDescriptor();
    const msb = { ...d.controls[0]!, cc: 10, resolution: 14 as const };
    const lsbClash = { ...d.controls[0]!, id: 'b', cc: 42 };
    expect(
      validateDescriptor({ ...d, controls: [msb, lsbClash], defaultSlots: ['a'] }).join(),
    ).toMatch(/collides with b/);
  });

  it('catches an enum with no ranges', () => {
    const d = baseDescriptor();
    const bad = { ...d.controls[0]!, role: 'enum' as const, format: 'enum' as const };
    expect(validateDescriptor({ ...d, controls: [bad] }).join()).toMatch(/no ranges declared/);
  });

  it('catches overlapping enum ranges', () => {
    const d = baseDescriptor();
    const bad = {
      ...d.controls[0]!,
      role: 'enum' as const,
      format: 'enum' as const,
      default: 5,
      ranges: [
        { label: 'x', from: 0, to: 50 },
        { label: 'y', from: 40, to: 100 },
      ],
    };
    expect(validateDescriptor({ ...d, controls: [bad] }).join()).toMatch(/overlap/);
  });

  it('catches an enum default that lands in no range', () => {
    const d = baseDescriptor();
    const bad = {
      ...d.controls[0]!,
      role: 'enum' as const,
      format: 'enum' as const,
      default: 90,
      ranges: [{ label: 'x', from: 0, to: 50 }],
    };
    expect(validateDescriptor({ ...d, controls: [bad] }).join()).toMatch(/falls in no declared range/);
  });

  it('catches a quantized control rendered as a smooth value', () => {
    const d = baseDescriptor();
    const bad = {
      ...d.controls[0]!,
      format: 'raw7' as const,
      quantize: { kind: 'tempo-subdivision' as const, table: 'unmeasured' as const, note: 'n' },
    };
    expect(validateDescriptor({ ...d, controls: [bad] }).join()).toMatch(
      /disagrees with what the user hears/,
    );
  });

  it('catches defaultSlots naming a control that does not exist', () => {
    expect(validateDescriptor(baseDescriptor({ defaultSlots: ['nope'] })).join()).toMatch(
      /not a control/,
    );
  });

  it('REFUSES an ACTION in defaultSlots (an undo would re-fire it)', () => {
    const d = baseDescriptor();
    const action = { ...d.controls[0]!, role: 'action' as const };
    expect(validateDescriptor({ ...d, controls: [action] }).join()).toMatch(/an ACTION/);
  });

  it('catches an out-of-range MIDI channel and a missing port hint', () => {
    expect(validateDescriptor(baseDescriptor({ defaultChannel: 17 })).join()).toMatch(/1\.\.16/);
    expect(validateDescriptor(baseDescriptor({ portHints: [] })).join()).toMatch(/no portHints/);
  });

  it('accepts the base descriptor — so the cases above fail for their OWN reason', () => {
    expect(validateDescriptor(baseDescriptor())).toEqual([]);
  });
});

describe('CHROMA_CONSOLE — the transcription itself', () => {
  it('carries all 34 documented CCs (NOT the 28 the prior research claimed)', () => {
    expect(CHROMA_CONSOLE.controls).toHaveLength(34);
  });

  it('RATE is CC 66 and TIME is CC 68 — the pair the proposals doc had swapped', () => {
    expect(controlById(CHROMA_CONSOLE, 'rate')!.cc).toBe(66);
    expect(controlById(CHROMA_CONSOLE, 'time')!.cc).toBe(68);
  });

  it('every control is manual-sourced — nothing here is guessed', () => {
    const notManual = CHROMA_CONSOLE.controls.filter((c) => c.source !== 'manual');
    expect(notManual.map((c) => c.id)).toEqual([]);
  });

  it('the four PRIMARY amount CCs are 65/67/69/71 and the knobs 64/66/68/70', () => {
    const cc = (id: string) => controlById(CHROMA_CONSOLE, id)!.cc;
    expect([cc('tilt'), cc('rate'), cc('time'), cc('mix')]).toEqual([64, 66, 68, 70]);
    expect([
      cc('amountCharacter'),
      cc('amountMovement'),
      cc('amountDiffusion'),
      cc('amountTexture'),
    ]).toEqual([65, 67, 69, 71]);
  });

  it('RATE and TIME are the ONLY quantized controls, and both are unmeasured', () => {
    const quantized = CHROMA_CONSOLE.controls.filter((c) => c.quantize);
    expect(quantized.map((c) => c.id).sort()).toEqual(['rate', 'time']);
    for (const c of quantized) {
      expect(c.quantize!.table, 'never fabricate a subdivision table').toBe('unmeasured');
      expect(c.format).toBe('stepped-unmeasured');
    }
  });

  it('the destructive commands are ACTIONS, so they can never occupy an undoable slot', () => {
    expect(actionControls(CHROMA_CONSOLE).map((c) => c.id).sort()).toEqual([
      'calibrationMenu',
      'capture',
      'gesturePlayRec',
      'gestureStopErase',
      'tapTempo',
    ]);
    const slottableIds = new Set(slottableControls(CHROMA_CONSOLE).map((c) => c.id));
    for (const a of actionControls(CHROMA_CONSOLE)) {
      expect(slottableIds.has(a.id), `${a.id} must not be slottable`).toBe(false);
    }
  });

  it('is declared receive-only', () => {
    expect(CHROMA_CONSOLE.readBack).toBe('none');
  });

  it('defaultSlots is the eight PRIMARY knobs, in panel order', () => {
    expect(CHROMA_CONSOLE.defaultSlots).toEqual([
      'tilt', 'rate', 'time', 'mix',
      'amountCharacter', 'amountMovement', 'amountDiffusion', 'amountTexture',
    ]);
  });

  it('is JSON-serializable — no closures anywhere in the structure', () => {
    // The norns anti-pattern check, done structurally rather than by review.
    const round = JSON.parse(JSON.stringify(CHROMA_CONSOLE));
    expect(round).toEqual(CHROMA_CONSOLE);
  });
});

describe('enum range helpers', () => {
  const character = controlById(CHROMA_CONSOLE, 'characterModule')!;

  it('names the state a value falls in', () => {
    expect(enumRangeAt(character, 0)!.label).toBe('DRIVE');
    expect(enumRangeAt(character, 55)!.label).toBe('FUZZ');
    expect(enumRangeAt(character, 127)!.label).toBe('OFF');
  });

  it('range boundaries are inclusive on both ends and leave no gap', () => {
    for (let v = 0; v <= 127; v++) {
      expect(enumRangeAt(character, v), `value ${v} is unnamed`).toBeDefined();
    }
  });

  it('the representative value is the MIDPOINT, not the edge', () => {
    // Midpoint survives a firmware whose boundaries are off by one; an edge
    // value can fall into the neighbouring state.
    expect(enumRangeValue({ label: 'x', from: 44, to: 65 })).toBe(55);
    expect(enumRangeValue({ label: 'x', from: 0, to: 63 })).toBe(32);
  });
});

describe('formatControlValue — the named-spec vocabulary', () => {
  it('enum prints the state name', () => {
    expect(formatControlValue(controlById(CHROMA_CONSOLE, 'textureModule')!, 30)).toBe('SQUASH');
  });

  it('percent scales to full range', () => {
    expect(formatControlValue(controlById(CHROMA_CONSOLE, 'mix')!, 127)).toBe('100%');
    expect(formatControlValue(controlById(CHROMA_CONSOLE, 'mix')!, 0)).toBe('0%');
  });

  it('a device-quantized control is MARKED, never printed as a plain number', () => {
    const out = formatControlValue(controlById(CHROMA_CONSOLE, 'time')!, 64);
    expect(out).toContain('64');
    expect(out, 'the user must be able to see the pedal snaps this').not.toBe('64');
  });

  it('raw7 prints the bare value', () => {
    expect(formatControlValue(controlById(CHROMA_CONSOLE, 'tilt')!, 64)).toBe('64');
  });
});

describe('resolveSlots', () => {
  const SLOTS = ['slot1', 'slot2', 'slot3'];

  it('falls back to defaultSlots by position when nothing is saved', () => {
    const resolved = resolveSlots(CHROMA_CONSOLE, SLOTS, undefined);
    expect(resolved.map((s) => s.controlId)).toEqual(['tilt', 'rate', 'time']);
    expect(resolved.every((s) => !s.stale)).toBe(true);
  });

  it('a saved assignment overrides the default', () => {
    const resolved = resolveSlots(CHROMA_CONSOLE, SLOTS, { slot2: 'mix' });
    expect(resolved.map((s) => s.controlId)).toEqual(['tilt', 'mix', 'time']);
  });

  it('an explicitly EMPTY slot stays empty rather than reverting to the default', () => {
    const resolved = resolveSlots(CHROMA_CONSOLE, SLOTS, { slot1: '' });
    expect(resolved[0]!.controlId).toBeUndefined();
    expect(resolved[0]!.stale, 'cleared is not stale').toBe(false);
  });

  it('an assignment naming a VANISHED control is reported STALE, not silently empty', () => {
    // The saved-patch-meets-changed-descriptor case. A stale slot that behaved
    // like an empty one would leave automation writing into a dead lane with
    // nothing anywhere saying so.
    const resolved = resolveSlots(CHROMA_CONSOLE, SLOTS, { slot1: 'removedInV2' });
    expect(resolved[0]!.stale).toBe(true);
    expect(resolved[0]!.control).toBeUndefined();
    expect(resolved[0]!.controlId, 'the dangling id is preserved for the error message').toBe(
      'removedInV2',
    );
  });
});

describe('matchPortByHint', () => {
  it('finds the USB port by its enumerated name', () => {
    const ports = [
      { id: '1', name: 'IAC Driver Bus 1' },
      { id: '2', name: 'HOLOGRAM Chroma Console MIDI' },
    ];
    expect(matchPortByHint(CHROMA_CONSOLE, ports)).toBe(1);
  });

  it('is case-insensitive and matches a truncated name', () => {
    expect(matchPortByHint(CHROMA_CONSOLE, [{ id: '1', name: 'chroma console' }])).toBe(0);
  });

  it('prefers the EARLIER hint when several match', () => {
    const ports = [
      { id: '1', name: 'Chroma' },
      { id: '2', name: 'HOLOGRAM Chroma Console MIDI' },
    ];
    expect(matchPortByHint(CHROMA_CONSOLE, ports)).toBe(1);
  });

  it('returns -1 rather than guessing when nothing matches', () => {
    // Auto-selecting the wrong port sends a pedal's CCs into somebody's synth.
    expect(matchPortByHint(CHROMA_CONSOLE, [{ id: '1', name: 'Prophet Rev2' }])).toBe(-1);
    expect(matchPortByHint(CHROMA_CONSOLE, [])).toBe(-1);
  });

  it('tolerates a port with no name at all', () => {
    expect(matchPortByHint(CHROMA_CONSOLE, [{ id: '1', name: null }])).toBe(-1);
  });
});

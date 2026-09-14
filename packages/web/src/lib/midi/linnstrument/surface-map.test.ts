// Surface map — wire → application coordinates, region ownership, the
// asymmetric indexing (design.md:101). SYNTHETIC vectors.

import { describe, it, expect } from 'vitest';
import { keyboardCellToMidi } from '$lib/audio/modules/keyboard-map';
import { DEFAULT_LINN_PROFILE, RECOMMENDED_REGIONS, padXSpan, regionAt } from './profile';
import { createRawDecodeState, decodePhysicalMidi, type RawDecodeState } from './raw-decode';
import { appColToWireCol, appRowToLedRow, appRowToNoteChannel, createSurfaceMapState, mapSurface, wireColToAppCol, type SurfaceMapState } from './surface-map';
import type { LinnProfile, RuntimeEvent } from './types';

/** Bytes → raw → surface, threading both states. */
function run(messages: number[][], profile: LinnProfile = DEFAULT_LINN_PROFILE): RuntimeEvent[] {
  let raw: RawDecodeState = createRawDecodeState();
  let map: SurfaceMapState = createSurfaceMapState();
  const out: RuntimeEvent[] = [];
  messages.forEach((m, i) => {
    const r = decodePhysicalMidi(raw, m, i * 0.001);
    raw = r.state;
    for (const e of r.events) {
      const s = mapSurface(map, e, profile);
      map = s.state;
      out.push(...s.events);
    }
  });
  return out;
}
const kinds = (events: RuntimeEvent[]): string[] => events.map((e) => e.kind);

describe('surface-map: V01 geometry and the asymmetric indexing', () => {
  it('app (0,0) / (16,7) / (24,7) are wire columns 1 / 17 / 25', () => {
    expect([0, 16, 24].map(appColToWireCol)).toEqual([1, 17, 25]);
    expect([1, 17, 25].map(wireColToAppCol)).toEqual([0, 16, 24]);
  });

  it('note channel is row+1 while the LED row is row (design.md:101)', () => {
    expect(appRowToNoteChannel(7)).toBe(8);
    expect(appRowToLedRow(7)).toBe(7);
  });

  it('wire (1,row0) → keys lower-left; (17,row7) → R control; (25,row7) → pad upper-right', () => {
    const events = run([[0x90, 1, 100], [0x97, 17, 100], [0x97, 25, 100]]);
    expect(events[0]).toMatchObject({ kind: 'touch_start', region: 'keys', col: 0, row: 0, localCol: 0, localRow: 0, note: 36 });
    expect(events[1]).toMatchObject({ kind: 'control_edge', control: 'r', down: true });
    expect(events[2]).toMatchObject({ kind: 'touch_start', region: 'pad', col: 24, row: 7, localCol: 7, localRow: 7 });
    expect(events[3]).toMatchObject({ kind: 'pointer', phase: 'down' });
  });

  it('V02: root 36 — (0,0)=36, (5,0)=41, (0,1)=41, (15,7)=86, via the tree\'s keyboardCellToMidi', () => {
    const events = run([[0x90, 1, 100], [0x90, 6, 100], [0x91, 1, 100], [0x97, 16, 100]]);
    expect(events.map((e) => (e as { note: number }).note)).toEqual([36, 41, 41, 86]);
    expect(keyboardCellToMidi(15, 7, 36)).toBe(86);
    // Two 41s are two touches.
    expect(new Set(events.map((e) => (e as { touch: number }).touch)).size).toBe(4);
  });

  it('the pad uses its own root (60): app (17,0) → 60, (24,7) → 102', () => {
    const events = run([[0x90, 18, 100], [0x97, 25, 100]]).filter((e) => e.kind === 'touch_start');
    expect(events.map((e) => (e as { note: number }).note)).toEqual([60, 102]);
  });
});

describe('surface-map: every cell lands in exactly one region under the DEFAULT profile', () => {
  it('25 × 8 cells: 128 keys, 8 controls, 64 pad, 0 unmapped, no overlaps', () => {
    const counts = { keys: 0, controls: 0, pad: 0, none: 0 };
    for (let col = 0; col < DEFAULT_LINN_PROFILE.columns; col++) {
      for (let row = 0; row < DEFAULT_LINN_PROFILE.rows; row++) {
        const r = regionAt(DEFAULT_LINN_PROFILE, col, row);
        counts[r ?? 'none']++;
        // Overlap check: count rectangles containing the cell directly.
        const containing = (['keys', 'controls', 'pad'] as const).filter((name) => {
          const rect = DEFAULT_LINN_PROFILE.regions[name];
          return col >= rect.left && col < rect.left + rect.width && row >= rect.bottom && row < rect.bottom + rect.height;
        });
        expect(containing).toHaveLength(1);
      }
    }
    expect(counts).toEqual({ keys: 128, controls: 8, pad: 64, none: 0 });
  });

  it('a cell outside every rectangle is inert, not a note', () => {
    const profile: LinnProfile = { ...DEFAULT_LINN_PROFILE, regions: { ...RECOMMENDED_REGIONS, pad: { left: 17, bottom: 0, width: 7, height: 8 } } };
    const events = run([[0x90, 25, 100], [0x80, 25, 0]], profile);
    expect(events).toEqual([]);
  });
});

describe('surface-map: region rectangles are DATA', () => {
  it('swapping the profile moves the split and the map follows with no code change', () => {
    // A hypothetical 8×8 keys | 1×8 controls | 16×8 pad split.
    const profile: LinnProfile = {
      ...DEFAULT_LINN_PROFILE,
      regions: {
        keys: { left: 0, bottom: 0, width: 8, height: 8 },
        controls: { left: 8, bottom: 0, width: 1, height: 8 },
        pad: { left: 9, bottom: 0, width: 16, height: 8 },
      },
    };
    const events = run([[0x97, 9, 100], [0x90, 10, 100], [0x90, 25, 100]], profile);
    expect(events[0]).toMatchObject({ kind: 'control_edge', control: 'r' });
    expect(events[1]).toMatchObject({ kind: 'touch_start', region: 'pad', localCol: 0, note: 60 });
    expect(events[3]).toMatchObject({ kind: 'touch_start', region: 'pad', localCol: 15 });
    // Under the DEFAULT profile the same wire column 9 is a key, not a control.
    expect(run([[0x97, 9, 100]])[0]).toMatchObject({ kind: 'touch_start', region: 'keys' });
  });

  it('control rows are data too: moving R to row 0 moves the edge', () => {
    const profile: LinnProfile = { ...DEFAULT_LINN_PROFILE, controlRows: { ...DEFAULT_LINN_PROFILE.controlRows, r: 0, panic: 7 } };
    expect(run([[0x90, 17, 100]], profile)[0]).toMatchObject({ kind: 'control_edge', control: 'r' });
    expect(run([[0x97, 17, 100]], profile)[0]).toMatchObject({ kind: 'control_edge', control: 'panic' });
  });
});

describe('surface-map: pointer, expression and boundaries', () => {
  it('a pad touch emits touch_start + pointer down at the cell centre, then coherent moves from X and Y', () => {
    const span = padXSpan(DEFAULT_LINN_PROFILE);
    const events = run([[0x92, 20, 90], [0xb2, 52, 84], [0xb2, 20, 30], [0xb2, 84, 0]]);
    expect(kinds(events)).toEqual(['touch_start', 'pointer', 'touch_expression', 'pointer', 'touch_expression', 'pointer']);
    expect(events[1]).toMatchObject({ phase: 'down', u: (2 + 0.5) / 8, v: (2 + 0.5) / 8 });
    const u = (3924 - span.left) / (span.right - span.left);
    expect((events[3] as { u: number }).u).toBeCloseTo(u, 6);
    expect(events[5]).toMatchObject({ phase: 'move', v: 2 / 8 });
  });

  it('Z is pressure on the voice, never a pointer move', () => {
    const events = run([[0x92, 20, 90], [0xa2, 20, 64]]);
    expect(kinds(events)).toEqual(['touch_start', 'pointer', 'touch_expression']);
    expect(events[2]).toMatchObject({ pressure: 64 / 127 });
  });

  it('keys bend is X displacement from the first pair, in semitones of the raw prior', () => {
    const events = run([[0x90, 1, 100], [0xb0, 33, 0], [0xb0, 1, 8], [0xb0, 33, 0], [0xb0, 1, 9]]);
    const bends = events.filter((e) => e.kind === 'touch_expression').map((e) => (e as { bendSemitones: number }).bendSemitones);
    expect(bends[0]).toBe(0);
    expect(bends[1]).toBeCloseTo(128 / (4265 / 25), 6);
  });

  it('a horizontal slide inside the keys region keeps the touch: touch_slide, no new touch_start (V08)', () => {
    const events = run([[0x93, 12, 100], [0xb3, 119, 12], [0x93, 13, 100], [0x83, 12, 13]]);
    expect(kinds(events)).toEqual(['touch_start', 'touch_slide']);
    expect(events[1]).toMatchObject({ touch: 1, fromCol: 11, toCol: 12, row: 3 });
  });

  it('V11: a keys-origin slide into the selector column is a boundary end — no toggle, no note, and the touch is inert after', () => {
    const events = run([[0x97, 16, 100], [0xb7, 119, 16], [0x97, 17, 100], [0x87, 16, 17], [0xa7, 17, 50], [0x87, 17, 0]]);
    expect(kinds(events)).toEqual(['touch_start', 'touch_end']);
    expect(events[1]).toMatchObject({ region: 'keys', reason: 'boundary' });
  });

  it('a pad-origin slide into the selector column releases the pointer and never toggles', () => {
    const events = run([[0x97, 18, 100], [0xb7, 119, 18], [0x97, 17, 100], [0x87, 18, 17]]);
    expect(kinds(events)).toEqual(['touch_start', 'pointer', 'pointer', 'touch_end']);
    expect(events[2]).toMatchObject({ phase: 'up' });
    expect(events[3]).toMatchObject({ reason: 'boundary' });
  });

  it('a control-origin touch: fresh down/up edges only; a slide out clips the edge without a note', () => {
    const events = run([[0x96, 17, 100], [0xb6, 119, 17], [0x96, 16, 100], [0x86, 17, 16], [0x86, 16, 0]]);
    expect(events).toMatchObject([
      { kind: 'control_edge', control: 'g', down: true },
      { kind: 'control_edge', control: 'g', down: false },
    ]);
  });

  it('a mode notification resets tracking and becomes a session event; prior touches end with reason session', () => {
    const events = run([[0x90, 3, 100], [0xb0, 99, 1], [0xb0, 98, 117], [0xb0, 6, 0], [0xb0, 38, 1]]);
    expect(kinds(events)).toEqual(['touch_start', 'touch_end', 'session']);
    expect(events[1]).toMatchObject({ reason: 'session' });
    expect(events[2]).toMatchObject({ state: 'mode_changed', userMode: true, epoch: 2 });
  });

  it('rejected raw events map to nothing', () => {
    expect(run([[0x80, 3, 0]])).toEqual([]);
  });
});

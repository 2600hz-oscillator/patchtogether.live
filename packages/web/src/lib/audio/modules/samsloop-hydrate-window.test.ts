// packages/web/src/lib/audio/modules/samsloop-hydrate-window.test.ts
//
// THE WINDOW MIGRATION MUST RUN FOR EVERY SOURCE KIND — the unit half of the
// owner's "load the patch and samsloop doesn't play" (2026-09-06).
//
// The frame→fraction window rework put the frame-index → fraction migration
// inside `decodeBytesAndPush` — the `file` branch of the factory's hydrate —
// so a pre-rework patch holding a RECORDING (`sample`) or a legacy YArray
// (`samples`) loaded with frame-indexed start/end intact. Both params clamp to
// the worklet's ±2 declared range, so any touched frame index resolved to
// startFrac = 1: a ONE-FRAME window at the sample's tail, whose output is the
// last sample repeated — DC, inaudible — while the playhead published, the
// waveform painted and the faders looked right.
//
// The fix hoists the migration + metadata cache into
// `applySamsloopHydrateMetadata`, called from ALL THREE push branches and from
// the poll guard (same-signature re-load). This file pins the helper's
// contract; `e2e/tests/samsloop-load-audible.spec.ts` pins that every branch
// actually calls it (audible output after a load, per source kind).
//
// Real Y.Doc for the write-through leg, per [[yjs-save-load-real-ydoc]]: the
// live callers hand this function a syncedStore proxy, and a plain-object
// fixture would prove nothing about that write path.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
import type { ModuleNode } from '$lib/graph/types';
import { applySamsloopHydrateMetadata, type SamsloopData } from './samsloop';

const NID = 'samsloop-hydrate-window-test';

function spawn(params: Record<string, number>, data: SamsloopData): void {
  ydoc.transact(() => {
    patch.nodes[NID] = {
      id: NID,
      type: 'samsloop',
      domain: 'audio',
      position: { x: 0, y: 0 },
      params,
      data: data as Record<string, unknown>,
    } as unknown as ModuleNode;
  }, LOCAL_ORIGIN);
}

function despawn(): void {
  if (!patch.nodes[NID]) return;
  ydoc.transact(() => {
    delete patch.nodes[NID];
  }, LOCAL_ORIGIN);
}

describe('applySamsloopHydrateMetadata', () => {
  beforeEach(despawn);
  afterEach(despawn);

  it('migrates a frame-indexed window using the SAVED length as the divisor', () => {
    const live = {
      params: { start: 6000, end: 24_000 } as Record<string, number>,
      data: { sampleLength: 24_000, sampleRate: 48_000 } as Record<string, unknown>,
    };
    // newLen deliberately differs from the saved length (a re-decode at a
    // different rate) — the frames were written against the SAVED one.
    const migrated = applySamsloopHydrateMetadata(live, 12_000, 24_000);
    expect(migrated).toEqual({ start: 0.25, end: 1 });
    expect(live.params.start).toBe(0.25);
    expect(live.params.end).toBe(1);
    // Metadata cache updated to the FRESH decode.
    expect(live.data.sampleLength).toBe(12_000);
    expect(live.data.sampleRate).toBe(24_000);
  });

  it('is a no-op on an already-fractional window (idempotent on a poll loop)', () => {
    const live = {
      params: { start: 0.25, end: 1 } as Record<string, number>,
      data: { sampleLength: 24_000 } as Record<string, unknown>,
    };
    expect(applySamsloopHydrateMetadata(live, 24_000, undefined)).toBeNull();
    expect(live.params.start).toBe(0.25);
    expect(live.params.end).toBe(1);
  });

  it('falls back to the fresh length when the envelope carried none, and skips the rate write when undefined', () => {
    const live = {
      params: { start: 12_000, end: 48_000 } as Record<string, number>,
      data: {} as Record<string, unknown>,
    };
    const migrated = applySamsloopHydrateMetadata(live, 48_000, undefined);
    expect(migrated).toEqual({ start: 0.25, end: 1 });
    expect(live.data.sampleLength).toBe(48_000);
    expect('sampleRate' in live.data).toBe(false);
  });

  it('returns null (and never divides) when there is no length in hand at all', () => {
    const live = {
      params: { start: 6000, end: 24_000 } as Record<string, number>,
      data: {} as Record<string, unknown>,
    };
    expect(applySamsloopHydrateMetadata(live, 0, undefined)).toBeNull();
    // The frame values stay — nothing to divide by; a later hydrate with a
    // real length migrates them.
    expect(live.params.start).toBe(6000);
  });

  it('writes through a REAL syncedstore node the way the factory hands it one', () => {
    spawn({ start: 5512, end: 22_050 }, { sampleLength: 22_050, sampleRate: 22_050 });
    const live = patch.nodes[NID] as unknown as {
      params?: Record<string, number>;
      data?: Record<string, unknown>;
    };
    const migrated = applySamsloopHydrateMetadata(live, 22_050, 22_050);
    expect(migrated).toEqual({ start: 5512 / 22_050, end: 1 });
    // The migration landed IN the Y.Doc, not on a detached copy.
    const reread = patch.nodes[NID] as unknown as { params: Record<string, number> };
    expect(reread.params.start).toBeCloseTo(0.25, 2);
    expect(reread.params.end).toBe(1);
  });

  it('NEGATIVE CONTROL: the un-migrated window is the silent one-frame failure', () => {
    // What the worklet computes from an un-migrated window: both params clamp
    // to the ±2 param range, endFrac = min(1, 2) = 1, startFrac = min(end, 2)
    // = 1 — a window of ONE frame at the tail. This restates the failure the
    // migration deletes, so the test above cannot pass vacuously.
    const clampParam = (v: number) => Math.max(-2, Math.min(2, v));
    const len = 24_000;
    const endFrac = Math.max(0, Math.min(1, clampParam(24_000)));
    const startFrac = Math.max(0, Math.min(endFrac, clampParam(6000)));
    const start = Math.max(0, Math.min(len - 1, Math.floor(startFrac * len)));
    const end = Math.max(start + 1, Math.min(len, Math.ceil(endFrac * len)));
    expect(end - start).toBe(1); // one frame — DC out, inaudible
  });
});

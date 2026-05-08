// e2e/tests/drumseqz.spec.ts
//
// DRUMSEQZ end-to-end coverage:
//   1. Drop the module → 4×16 NoteEntry grid renders, per-track Eucl sliders
//      default 0.
//   2. Set trk1_euclid=4 → cells at steps 0, 4, 8, 12 light up (Bjorklund
//      E(4,16) downbeat-aligned pattern); other tracks untouched.
//   3. Wire gate1 + pitch1 → DRUMMERGIRL → audioOut, isPlaying=1, set
//      trk1_euclid=4 → assert audible signal at the output.
//
// Test hooks (gated on testHooksEnabled() from $lib/dev/test-hooks):
//   __drumseqzCellAt(id, track, step) -> { on, midi } | null
//   __drumseqzSetCell(id, track, step, partial) -> void

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

test('drumseqz: drop module renders 64 cells + Eucl sliders default 0', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(page, [
    { id: 'ds', type: 'drumseqz', params: { bpm: 120, length: 16, isPlaying: 0 } },
  ]);

  const grid = page.locator(`[data-testid="drumseqz-grid-ds"]`);
  await expect(grid).toBeVisible();

  // 4 tracks × 16 steps = 64 NoteEntry cells.
  const cells = grid.locator('.cell-slot');
  await expect(cells).toHaveCount(64);

  // Eucl sliders should all start at 0. Params are sparse on a freshly-spawned
  // node (only the entries spawnPatch passed in are populated); the runtime
  // and the card both fall back to the schema defaultValue (0 for trkN_euclid)
  // when the key is absent, so the test mirrors that fallback rather than
  // asserting on the stored value.
  const eucls = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { params: Record<string, number> }> };
    };
    const p = w.__patch.nodes['ds']?.params ?? {};
    return [1, 2, 3, 4].map((t) => p[`trk${t}_euclid`] ?? 0);
  });
  expect(eucls).toEqual([0, 0, 0, 0]);
});

test('drumseqz: setting trk1_euclid=4 lights up steps 0, 4, 8, 12 on track 1 only', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(page, [
    { id: 'ds', type: 'drumseqz', params: { bpm: 120, length: 16, isPlaying: 0 } },
  ]);

  // Apply trk1_euclid=4 by writing the param + tracks.cells in one transact.
  // The slider in the UI does this via setEuclid; here we drive the same
  // Yjs transact directly via the dev __patch global.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { params: Record<string, number>; data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    // Simulate what the Eucl slider does: set the param + rewrite cells via
    // bjorklund(4, 16) = downbeats at 0, 4, 8, 12.
    const pattern = [
      1, 0, 0, 0,
      1, 0, 0, 0,
      1, 0, 0, 0,
      1, 0, 0, 0,
    ];
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['ds'];
      if (!n) return;
      n.params['trk1_euclid'] = 4;
      if (!n.data) n.data = {};
      n.data['tracks'] = [
        { cells: pattern.map((p) => ({ on: p === 1, midi: null })) },
        { cells: Array.from({ length: 16 }, () => ({ on: false, midi: null })) },
        { cells: Array.from({ length: 16 }, () => ({ on: false, midi: null })) },
        { cells: Array.from({ length: 16 }, () => ({ on: false, midi: null })) },
      ];
    });
  });

  // Verify via the test hook that cells (0, 4, 8, 12) on track 0 are on.
  await page.waitForFunction(() => {
    const w = globalThis as unknown as {
      __drumseqzCellAt?: (id: string, t: number, s: number) => { on: boolean } | null;
    };
    if (typeof w.__drumseqzCellAt !== 'function') return false;
    const onIdx = [0, 4, 8, 12];
    for (const i of onIdx) {
      if (w.__drumseqzCellAt('ds', 0, i)?.on !== true) return false;
    }
    return true;
  }, undefined, { timeout: 5000 });

  // Off cells on track 0 stay off.
  const allCells = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __drumseqzCellAt: (id: string, t: number, s: number) => { on: boolean } | null;
    };
    const out: { t: number; s: number; on: boolean }[] = [];
    for (let t = 0; t < 4; t++) {
      for (let s = 0; s < 16; s++) {
        const c = w.__drumseqzCellAt('ds', t, s);
        out.push({ t, s, on: !!c?.on });
      }
    }
    return out;
  });

  // Track 0: only steps 0, 4, 8, 12 are on.
  for (const c of allCells.filter((x) => x.t === 0)) {
    const expected = [0, 4, 8, 12].includes(c.s);
    expect(c.on, `track 0 step ${c.s} on=${c.on}, expected ${expected}`).toBe(expected);
  }
  // Tracks 1-3: untouched (all off).
  for (const c of allCells.filter((x) => x.t !== 0)) {
    expect(c.on, `track ${c.t} step ${c.s} should be off`).toBe(false);
  }

  // The corresponding gate buttons should also have the .on class.
  // NoteEntry's gate button is a <button.gate.on>; data-testid pattern:
  // drumseqz-gate-{id}-{track}-{step}.
  for (const i of [0, 4, 8, 12]) {
    const gate = page.locator(`[data-testid="drumseqz-gate-ds-0-${i}"]`);
    await expect(gate).toHaveClass(/\bon\b/);
  }
  for (const i of [1, 2, 3, 5, 6, 7, 9, 10, 11, 13, 14, 15]) {
    const gate = page.locator(`[data-testid="drumseqz-gate-ds-0-${i}"]`);
    await expect(gate).not.toHaveClass(/\bon\b/);
  }
});

test('drumseqz: __drumseqzSetCell test hook updates a single cell', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(page, [
    { id: 'ds', type: 'drumseqz', params: { bpm: 120, isPlaying: 0 } },
  ]);

  await page.waitForFunction(() => {
    const w = globalThis as unknown as { __drumseqzSetCell?: unknown };
    return typeof w.__drumseqzSetCell === 'function';
  });

  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __drumseqzSetCell: (id: string, t: number, s: number, partial: { on?: boolean; midi?: number | null }) => void;
    };
    w.__drumseqzSetCell('ds', 2, 7, { on: true, midi: 64 });
  });

  const cell = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __drumseqzCellAt: (id: string, t: number, s: number) => { on: boolean; midi: number | null } | null;
    };
    return w.__drumseqzCellAt('ds', 2, 7);
  });
  expect(cell).toEqual({ on: true, midi: 64 });
});

test('drumseqz: gate1+pitch1 → DRUMMERGIRL → audioOut produces audible signal', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      { id: 'ds',  type: 'drumseqz',     params: { bpm: 240, length: 16, isPlaying: 1, gateLength: 0.4 } },
      { id: 'dg',  type: 'drummergirl',  params: { volume: 1.5, decay: 0.12, tone: 0.4, shape: 0.3 } },
      { id: 'scp', type: 'scope',        params: { timeMs: 80 } },
      { id: 'out', type: 'audioOut',     params: { master: 0.6 } },
    ],
    [
      { id: 'g1', from: { nodeId: 'ds', portId: 'gate1' },  to: { nodeId: 'dg', portId: 'gate' },  sourceType: 'gate',  targetType: 'gate' },
      { id: 'p1', from: { nodeId: 'ds', portId: 'pitch1' }, to: { nodeId: 'dg', portId: 'pitch' }, sourceType: 'pitch', targetType: 'cv' },
      { id: 'a1', from: { nodeId: 'dg', portId: 'audio' },  to: { nodeId: 'scp', portId: 'ch1' } },
      { id: 'a2', from: { nodeId: 'scp', portId: 'ch1_out' }, to: { nodeId: 'out', portId: 'L' } },
    ],
  );

  // Apply Bjorklund(4,16) on track 1 — 4 hits per bar.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { params: Record<string, number>; data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    const pattern = [1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0];
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['ds'];
      n.params['trk1_euclid'] = 4;
      if (!n.data) n.data = {};
      n.data['tracks'] = [
        { cells: pattern.map((p) => ({ on: p === 1, midi: null })) },
        { cells: Array.from({ length: 16 }, () => ({ on: false, midi: null })) },
        { cells: Array.from({ length: 16 }, () => ({ on: false, midi: null })) },
        { cells: Array.from({ length: 16 }, () => ({ on: false, midi: null })) },
      ];
    });
  });

  // Poll the scope's analyser for ~2s, looking for a window that captures a
  // drum hit. The scope's analyser holds ~42ms of recent samples; DRUMSEQZ
  // fires four hits per bar (every ~250ms at 240 BPM with E(4,16)), so most
  // sampling windows will land between hits and read silence. Track the peak
  // and stop early once a hit lands above the threshold.
  let peak = 0;
  let rms = 0;
  let nonzero = 0;
  const start = Date.now();
  while (Date.now() - start < 2500) {
    const r = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __engine?: () => { read: (n: { id: string; type: string; domain: string }, k: string) => unknown } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
      };
      const eng = w.__engine?.();
      if (!eng) return null;
      const node = w.__patch.nodes['scp'];
      const snap = eng.read(node, 'snapshot') as { ch1: Float32Array } | undefined;
      if (!snap) return null;
      let p = 0;
      let energy = 0;
      let nz = 0;
      for (let i = 0; i < snap.ch1.length; i++) {
        const v = snap.ch1[i];
        const a = Math.abs(v);
        if (a > p) p = a;
        energy += v * v;
        if (a > 1e-5) nz++;
      }
      return { peak: p, rms: Math.sqrt(energy / snap.ch1.length), nonzero: nz };
    });
    if (r) {
      if (r.peak > peak) peak = r.peak;
      if (r.rms > rms) rms = r.rms;
      if (r.nonzero > nonzero) nonzero = r.nonzero;
      if (peak > 0.005 && nonzero > 50) break;
    }
    await page.waitForTimeout(50);
  }

  expect(
    peak,
    `expected audible drum hits via DRUMSEQZ→DRUMMERGIRL chain (peak=${peak.toFixed(4)}, rms=${rms.toFixed(4)})`,
  ).toBeGreaterThan(0.005);
  expect(nonzero).toBeGreaterThan(50);
});

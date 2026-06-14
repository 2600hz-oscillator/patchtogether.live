// e2e/tests/samsloop-boundaries-roundtrip.spec.ts
//
// SAMSLOOP loop BOUNDARIES (start/stop) must survive a perf-zip round-trip.
//
// The owner reported SAMSLOOP "tries to save boundaries but load doesn't
// restore them right". The media (fileBytesB64) round-trips already
// (samsloop-persistence.spec.ts); THIS spec covers the start/end loop window:
//
//   1. Spawn SAMSLOOP, upload a real WAV → fileBytesB64 + sampleLength land.
//   2. Drag the loop window in (set start/end to a sub-window via setNodeParam).
//   3. Export performance .zip (via __perfZip) → clear the rack → load the zip.
//   4. Assert node.params.start/end + node.data.sampleLength are restored
//      EXACTLY (boundaries point at the right samples, fader bounds intact).

import { test, expect, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { spawnPatch } from './_helpers';

const WAV_FIXTURE = fileURLToPath(new URL('../fixtures/samsloop-test.wav', import.meta.url));
const SAMS_ID = 'sams';

async function setup(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  return errors;
}

async function readSams(page: Page, id: string) {
  return await page.evaluate((nid) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { params?: Record<string, number>; data?: Record<string, unknown> }> };
    };
    const n = w.__patch.nodes[nid];
    return {
      start: n?.params?.start ?? null,
      end: n?.params?.end ?? null,
      sampleLength: (n?.data?.sampleLength as number | undefined) ?? null,
      hasBytes: typeof n?.data?.fileBytesB64 === 'string' && (n!.data!.fileBytesB64 as string).length > 0,
    };
  }, id);
}

async function nodeCount(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const w = globalThis as unknown as { __patch: { nodes: Record<string, unknown> } };
    return Object.keys(w.__patch.nodes).length;
  });
}

test.describe('SAMSLOOP loop boundaries round-trip', () => {
  test('start/end + sampleLength restore exactly after a perf-zip round-trip', async ({ page }) => {
    const errors = await setup(page);

    await spawnPatch(page, [{ id: SAMS_ID, type: 'samsloop', position: { x: 200, y: 200 } }]);
    // Engine must be up before the upload (decode needs the AudioContext).
    await page.evaluate(async () => {
      const w = globalThis as unknown as { __ensureEngine?: () => Promise<void> };
      await w.__ensureEngine?.();
    });

    const card = page.locator(`.svelte-flow__node[data-id="${SAMS_ID}"]`);
    await card.locator('[data-testid="samsloop-wav-input"]').setInputFiles(WAV_FIXTURE);
    // Wait for the decode to land sampleLength on node.data.
    await expect.poll(() => readSams(page, SAMS_ID).then((s) => s.sampleLength), { timeout: 10000 })
      .toBeGreaterThan(0);

    const loaded = await readSams(page, SAMS_ID);
    expect(loaded.hasBytes, 'fileBytesB64 should be present after upload').toBe(true);
    expect(loaded.sampleLength!).toBeGreaterThan(0);

    // Set a sub-window loop boundary (a quarter..three-quarters slice).
    const len = loaded.sampleLength!;
    const wantStart = Math.round(len * 0.25);
    const wantEnd = Math.round(len * 0.75);
    await page.evaluate(({ id, s, e }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        w.__patch.nodes[id]!.params.start = s;
        w.__patch.nodes[id]!.params.end = e;
      });
    }, { id: SAMS_ID, s: wantStart, e: wantEnd });

    const before = await readSams(page, SAMS_ID);
    expect(before.start).toBe(wantStart);
    expect(before.end).toBe(wantEnd);

    // Export → clear → load.
    const zipB64 = await page.evaluate(async () => {
      const w = globalThis as unknown as { __perfZip: { export: () => Promise<Uint8Array> } };
      const bytes = await w.__perfZip.export();
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
      return btoa(bin);
    });
    expect(zipB64.length).toBeGreaterThan(100);

    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, unknown>; edges: Record<string, unknown> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        for (const id of Object.keys(w.__patch.edges)) delete w.__patch.edges[id];
        for (const id of Object.keys(w.__patch.nodes)) delete w.__patch.nodes[id];
      });
    });
    await expect.poll(() => nodeCount(page), { timeout: 5000 }).toBe(0);

    await page.evaluate(async (b64) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const w = globalThis as unknown as { __perfZip: { load: (b: Uint8Array) => Promise<void> } };
      await w.__perfZip.load(bytes);
    }, zipB64);

    await expect(page.locator(`.svelte-flow__node[data-id="${SAMS_ID}"]`)).toBeVisible({ timeout: 8000 });
    // Wait for the engine's hydrate decode to re-derive sampleLength.
    await expect.poll(() => readSams(page, SAMS_ID).then((s) => s.sampleLength), { timeout: 10000 })
      .toBeGreaterThan(0);

    const after = await readSams(page, SAMS_ID);
    // Boundaries must restore EXACTLY (they're absolute sample indices that
    // ride the envelope verbatim).
    expect(after.start, 'loop start must restore exactly').toBe(wantStart);
    expect(after.end, 'loop end must restore exactly').toBe(wantEnd);
    // sampleLength must re-derive to the same value so the faders bound the
    // window correctly (start/end stay meaningful against the buffer).
    expect(after.sampleLength, 'sampleLength must re-derive to the saved length').toBe(before.sampleLength);
    expect(after.hasBytes, 'media bytes must round-trip').toBe(true);

    expect(errors, errors.join('; ')).toEqual([]);
  });
});

// e2e/tests/twotracks-perfzip.spec.ts
//
// FIX 3: TWOTRACKS media (reel tape) + loop boundaries must round-trip through
// the portable performance .zip.
//
// Owner report: TWOTRACKS didn't save its media at all — the tape lives in
// worklet-owned Float32 ring buffers that never touch node.data, so a reload
// brought back the loop boundaries against an EMPTY (silent) tape. Now the
// exporter dumps each reel's PCM out-of-band ('audio' media) + the loader
// re-sends it to the worklet via `load-tape`, while start/end scrubbers +
// cross-feed ride node.params as before.
//
//   1. VCO → twotracks reel A; punch-record a take (REC → PLAY → STOP) so
//      bufLenA > 0; set a sub-window loop boundary + a cross-feed value.
//   2. Export → clear → load.
//   3. Assert: bufLenA restored (tape media survived), start_a/end_a + a2b
//      restored exactly, and the restored tape is AUDIBLE at out_l (RMS > 0).

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { runFor } from './_module-coverage-helpers';

const TT_ID = 'tt';
const VCO_ID = 'vco';
const SCOPE_ID = 'scope';

async function setup(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  return errors;
}

/** Send a transport command to a reel via the live worklet port. */
async function sendTransport(page: Page, reel: 'a' | 'b', action: 'rec' | 'play' | 'stop'): Promise<void> {
  await page.evaluate(({ id, r, a }) => {
    const w = globalThis as unknown as { __engine: () => { read: (n: unknown, k: string) => unknown } | null; __patch: { nodes: Record<string, unknown> } };
    const eng = w.__engine();
    const node = w.__patch.nodes[id];
    if (!eng || !node) return;
    const port = eng.read(node, 'workletPort') as MessagePort | undefined;
    if (port) port.postMessage({ type: 'transport', reel: r, action: a });
  }, { id: TT_ID, r: reel, a: action });
}

async function readTT(page: Page) {
  return await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { params?: Record<string, number>; data?: Record<string, number> }> };
    };
    const n = w.__patch.nodes[id];
    return {
      bufLenA: (n?.data?.bufLenA as number | undefined) ?? 0,
      start_a: n?.params?.start_a ?? null,
      end_a: n?.params?.end_a ?? null,
      a2b: n?.params?.a2b ?? null,
    };
  }, TT_ID);
}

async function nodeCount(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const w = globalThis as unknown as { __patch: { nodes: Record<string, unknown> } };
    return Object.keys(w.__patch.nodes).length;
  });
}

/** Peak |sample| out of the scope's latest ch1 waveform snapshot — proves the
 *  restored tape is audible at out_l (not a silent blank tape). */
async function scopePeak(page: Page): Promise<number> {
  return await page.evaluate((sid) => {
    const w = globalThis as unknown as { __engine: () => { read: (n: unknown, k: string) => unknown } | null; __patch: { nodes: Record<string, unknown> } };
    const eng = w.__engine();
    const node = w.__patch.nodes[sid];
    if (!eng || !node) return 0;
    const snap = eng.read(node, 'snapshot') as { ch1?: Float32Array } | null | undefined;
    const buf = snap?.ch1;
    if (!buf) return 0;
    let pk = 0;
    for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i] ?? 0); if (v > pk) pk = v; }
    return pk;
  }, SCOPE_ID);
}

test.describe('TWOTRACKS tape + boundaries perf-zip round-trip', () => {
  test('reel tape, loop boundaries + cross-feed survive a perf-zip round-trip + the tape plays back', async ({ page }) => {
    const errors = await setup(page);

    await spawnPatch(page, [
      { id: VCO_ID, type: 'analogVco', position: { x: 60, y: 200 }, params: { freq: 220, level: 1 } },
      { id: TT_ID, type: 'twotracks', position: { x: 320, y: 200 } },
      { id: SCOPE_ID, type: 'scope', position: { x: 720, y: 200 } },
    ], [
      { id: 'e1', from: { nodeId: VCO_ID, portId: 'saw' }, to: { nodeId: TT_ID, portId: 'audio_l_in_a' } },
      { id: 'e2', from: { nodeId: TT_ID, portId: 'out_l' }, to: { nodeId: SCOPE_ID, portId: 'ch1' } },
    ]);
    await page.locator('[data-testid="twotracks-card"]').waitFor({ state: 'visible', timeout: 15000 });

    // Record ~0.5 s of the VCO into reel A. Transport state machine:
    // idle --REC--> armed --PLAY--> rec (rolls + records from the top) --STOP--> idle.
    await sendTransport(page, 'a', 'rec');   // arm
    await runFor(page, 100);
    await sendTransport(page, 'a', 'play');  // engage record from top
    await runFor(page, 600);                 // capture ~0.6 s of audio
    await sendTransport(page, 'a', 'stop');
    await runFor(page, 200);

    // bufLenA reports the recorded length (posted by the worklet on change).
    await expect.poll(() => readTT(page).then((s) => s.bufLenA), { timeout: 8000 }).toBeGreaterThan(0);

    // Set a sub-window loop boundary + a cross-feed value (the settings owner
    // wants restored alongside the media).
    await page.evaluate((id) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const p = w.__patch.nodes[id]!.params;
        p.start_a = 0.2;
        p.end_a = 0.8;
        p.a2b = 0.5;
      });
    }, TT_ID);

    const before = await readTT(page);
    expect(before.bufLenA).toBeGreaterThan(0);
    expect(before.start_a).toBeCloseTo(0.2, 5);
    expect(before.end_a).toBeCloseTo(0.8, 5);
    expect(before.a2b).toBeCloseTo(0.5, 5);

    // Export → clear → load.
    const zipB64 = await page.evaluate(async () => {
      const w = globalThis as unknown as { __perfZip: { export: () => Promise<Uint8Array> } };
      const bytes = await w.__perfZip.export();
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
      return btoa(bin);
    });
    // The zip must carry the reel tape bytes out-of-band.
    expect(zipB64.length, 'zip should carry the reel tape bytes').toBeGreaterThan(2000);

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

    await expect(page.locator('[data-testid="twotracks-card"]')).toBeVisible({ timeout: 12000 });
    await expect.poll(() => nodeCount(page), { timeout: 8000 }).toBe(3);

    // MEDIA: the tape's bufLenA restored (the worklet refilled the ring buffer
    // via load-tape + posted the new bufLen back to node.data).
    await expect.poll(() => readTT(page).then((s) => s.bufLenA), { timeout: 10000 }).toBeGreaterThan(0);

    const after = await readTT(page);
    // SETTINGS: boundaries + cross-feed restored exactly (ride node.params).
    expect(after.start_a, 'loop start_a restored').toBeCloseTo(0.2, 5);
    expect(after.end_a, 'loop end_a restored').toBeCloseTo(0.8, 5);
    expect(after.a2b, 'cross-feed a2b restored').toBeCloseTo(0.5, 5);
    // bufLen should be the same recorded length (±a frame of transport slop).
    expect(after.bufLenA).toBeGreaterThan(before.bufLenA * 0.5);

    // AUDIBLE: roll the restored tape (PLAY) — the scope at out_l must see
    // non-silent audio, proving the tape MEDIA round-tripped (not a blank tape).
    await sendTransport(page, 'a', 'play');
    await runFor(page, 600);
    await expect.poll(() => scopePeak(page), { timeout: 8000 }).toBeGreaterThan(0.01);

    expect(errors, errors.join('; ')).toEqual([]);
  });
});

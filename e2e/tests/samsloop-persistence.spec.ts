// e2e/tests/samsloop-persistence.spec.ts
//
// SAMSLOOP recorded samples MUST survive a save → reload round-trip
// through the patch-envelope format — same trick PICTUREBOX uses for
// imageBytes (see PR #441 / GGR demo). The byte payload lives on
// node.data.sample.bytes; loadEnvelopeIntoStore puts it back where the
// card / engine find it.
//
// Coverage:
//   1. Patch NOISE → samsloop.audio_l_in, click REC, wait, click STOP.
//   2. Snapshot the envelope via window.__persistence.save().
//   3. Hard reload, apply the envelope via window.__persistence.load().
//   4. Assert node.data.sample is present + bytes count matches +
//      rate/bits/channels metadata identical.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

async function setupPage(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/rack');
  await page.waitForLoadState('domcontentloaded');
  return errors;
}

async function readSampleMeta(page: Page, nodeId: string) {
  return await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: { sample?: { bytesB64: string; byteLength: number; rate: number; bits: number; channels: number; durationSec: number } } }> };
    };
    const s = w.__patch.nodes[id]?.data?.sample;
    if (!s) return null;
    // Cheap rolling hash of the base64 string so we can prove the bytes
    // survive intact without round-tripping the whole payload through
    // page.evaluate.
    let h = 0;
    for (let i = 0; i < s.bytesB64.length; i++) {
      h = ((h << 5) - h + s.bytesB64.charCodeAt(i)) | 0;
    }
    return {
      bytesLen: s.byteLength,
      b64Len: s.bytesB64.length,
      bytesHash: h,
      rate: s.rate,
      bits: s.bits,
      channels: s.channels,
      durationSec: s.durationSec,
    };
  }, nodeId);
}

test.describe('SAMSLOOP persistence', () => {
  test('recorded sample survives save → reload round-trip', async ({ page }) => {
    const errors = await setupPage(page);

    // Build a small patch + record into it.
    await spawnPatch(
      page,
      [
        { id: 'n', type: 'noise', position: { x: 100, y: 200 } },
        { id: 's', type: 'samsloop', position: { x: 400, y: 200 } },
      ],
      [
        {
          id: 'e1',
          from: { nodeId: 'n', portId: 'white' },
          to:   { nodeId: 's', portId: 'audio_l_in' },
          sourceType: 'noise',
          targetType: 'samsloop',
        },
      ],
    );

    const rec = page.locator('[data-testid="samsloop-rec-button"]');
    await rec.click();
    await expect(rec).toContainText('STOP', { timeout: 3000 });
    await page.waitForTimeout(500);
    await rec.click();
    await expect(rec).toContainText('REC');

    // Pre-reload state.
    const before = await readSampleMeta(page, 's');
    expect(before, 'expected sample to be committed pre-reload').not.toBeNull();
    expect(before!.bytesLen).toBeGreaterThan(0);

    // Snapshot the envelope (what makeEnvelope(ydoc) produces — the
    // same shape Save-Performance stores). The DEV-only __persistence
    // global is set up by Canvas.svelte; it wraps makeEnvelope /
    // loadEnvelopeIntoStore.
    const envelope = await page.evaluate(() => {
      const w = window as unknown as { __persistence?: { save?: () => unknown } };
      return w.__persistence?.save?.();
    });
    expect(envelope, '__persistence.save() unavailable — DEV build expected').toBeTruthy();

    // Hard reload — wipes the in-memory store. Then re-load the
    // envelope into a fresh canvas via __persistence.load.
    await page.reload({ waitUntil: 'networkidle' });
    // Wait for the dev globals to be re-bound after the reload (Canvas's
    // $effect fires post-mount).
    await page.waitForFunction(() => {
      const w = window as unknown as { __persistence?: { load?: (env: unknown) => unknown } };
      return typeof w.__persistence?.load === 'function';
    });
    await page.evaluate((env) => {
      const w = window as unknown as { __persistence?: { load?: (env: unknown) => unknown } };
      w.__persistence!.load!(env);
    }, envelope);

    // Card should remount with the persisted sample intact.
    await expect(page.locator('.svelte-flow__node-samsloop')).toHaveCount(1, { timeout: 10_000 });

    const after = await readSampleMeta(page, 's');
    expect(after, 'expected sample to be present after reload').not.toBeNull();
    // Byte count + hash + metadata should be bit-identical.
    expect(after!.bytesLen).toBe(before!.bytesLen);
    expect(after!.b64Len).toBe(before!.b64Len);
    expect(after!.bytesHash).toBe(before!.bytesHash);
    expect(after!.rate).toBe(before!.rate);
    expect(after!.bits).toBe(before!.bits);
    expect(after!.channels).toBe(before!.channels);
    expect(after!.durationSec).toBeCloseTo(before!.durationSec, 6);

    expect(errors, errors.join('; ')).toEqual([]);
  });
});

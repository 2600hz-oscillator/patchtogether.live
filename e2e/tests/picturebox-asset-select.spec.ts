// e2e/tests/picturebox-asset-select.spec.ts
//
// PICTUREBOX 7-slot ASSET SELECTOR — image-domain (CI-safe; no video decode,
// no H.264 encoder). Loads TWO visually-distinct images into slots 0 and 1 via
// node.data, patches a source's PITCH + GATE into asset_pitch + asset_gate, and
// fires the gate at two different notes — asserting the routed VIDEO-OUT output
// switches between the two slots.
//
// Strategy (mirrors 4plexvid.spec):
//   slot 0 = a BRIGHT (near-white) image  → high mean luminance downstream.
//   slot 1 = a DARK  (near-black) image   → low  mean luminance downstream.
// We fire asset_gate (with asset_pitch = a note in slot 1's class, then slot
// 0's) by writing the synthetic params via the video engine's setParam — the
// same entry point the cross-domain CV bridge uses — and waiting one card poll
// tick between the rise and the release so the card's 33ms gate loop catches
// the edge. The card edge-detects, maps V/oct → slot, and selectSlot()s.
//
// Image (not video) so it runs deterministically under CI's SwiftShader with
// no OS H.264 encoder dependency.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { midiToVOct } from '../../packages/web/src/lib/audio/note-entry';
import { ASSET_SLOT_NOTES } from '../../packages/web/src/lib/video/asset-select';

async function setup(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  return errors;
}

/** Mean luminance over a VIDEO-OUT canvas (identified by its node id). */
async function meanLuma(page: Page, nodeId: string): Promise<number> {
  const handle = page.locator(`canvas[data-testid="video-out-canvas"][data-node-id="${nodeId}"]`);
  await expect(handle, `VIDEO-OUT ${nodeId} canvas present`).toHaveCount(1);
  return await handle.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (!ctx) return 0;
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) sum += (data[i]! + data[i + 1]! + data[i + 2]!) / 3;
    return sum / (data.length / 4);
  });
}

/** Poll a VIDEO-OUT until its mean luminance satisfies `pred`, or fail. */
async function waitForLuma(
  page: Page,
  nodeId: string,
  pred: (m: number) => boolean,
  timeout = 8000,
): Promise<{ ok: boolean; last: number }> {
  const deadline = Date.now() + timeout;
  let last = await meanLuma(page, nodeId);
  if (pred(last)) return { ok: true, last };
  while (Date.now() < deadline) {
    await page.waitForTimeout(120);
    last = await meanLuma(page, nodeId);
    if (pred(last)) return { ok: true, last };
  }
  return { ok: false, last };
}

/** Encode a solid-color JPEG (1024×768) as base64 — the same shape PICTUREBOX
 *  stores in data.assets. `gray` 0..255. */
async function solidImage(page: Page, gray: number): Promise<string> {
  return await page.evaluate(async (gray) => {
    const W = 1024, H = 768;
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = `rgb(${gray},${gray},${gray})`;
    ctx.fillRect(0, 0, W, H);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
    const buf = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < buf.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, Array.from(buf.subarray(i, i + CHUNK)));
    }
    return btoa(binary);
  }, gray);
}

/** Write the 7-slot assets array onto a picturebox node.data. */
async function writeAssets(page: Page, nodeId: string, assets: (string | null)[]): Promise<void> {
  await page.evaluate(({ nodeId, assets }) => {
    const w = window as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> } | undefined> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const t = w.__patch.nodes[nodeId];
      if (!t) throw new Error(`node ${nodeId} not found`);
      if (!t.data) t.data = {};
      t.data.assets = assets;
    });
  }, { nodeId, assets });
}

/** Fire an asset_gate rising edge with a given asset_pitch (raw V/oct) via the
 *  video engine setParam — and hold the gate high long enough (> one 33ms card
 *  poll tick) for the card's gate loop to catch the rising edge. */
async function fireAssetGate(page: Page, nodeId: string, voct: number): Promise<void> {
  await page.evaluate(({ nodeId, voct }) => {
    const w = globalThis as unknown as {
      __engine?: () => {
        getDomain?: (d: string) => { setParam?: (n: string, p: string, v: number) => void } | null;
      } | null;
    };
    const ve = w.__engine?.()?.getDomain?.('video');
    ve?.setParam?.(nodeId, 'asset_pitch', voct);
    ve?.setParam?.(nodeId, 'asset_gate', 1); // rising edge
  }, { nodeId, voct });
  await page.waitForTimeout(80); // > one 33ms card poll tick so the edge is seen
  await page.evaluate((nodeId) => {
    const w = globalThis as unknown as {
      __engine?: () => {
        getDomain?: (d: string) => { setParam?: (n: string, p: string, v: number) => void } | null;
      } | null;
    };
    const ve = w.__engine?.()?.getDomain?.('video');
    ve?.setParam?.(nodeId, 'asset_gate', 0); // release → re-arm
  }, nodeId);
}

// Slot 0 = bright (gray 240) → high downstream luma. Slot 1 = dark (gray 8) →
// low downstream luma. The two bands never overlap even under SwiftShader.
const BRIGHT = 120;
const DARK = 60;

test.describe('PICTUREBOX — 7-slot asset selector (image)', () => {
  test('a gate at note D shows slot 1; a gate at note C shows slot 0', async ({ page }) => {
    const errors = await setup(page);

    await spawnPatch(
      page,
      [
        { id: 'pb', type: 'picturebox', position: { x: 60, y: 60 }, domain: 'video' },
        { id: 'out', type: 'videoOut', position: { x: 520, y: 60 }, domain: 'video' },
      ],
      [
        { id: 'e_out', from: { nodeId: 'pb', portId: 'out' }, to: { nodeId: 'out', portId: 'in' }, sourceType: 'image', targetType: 'video' },
      ],
    );

    // Load two distinct images: slot 0 bright, slot 1 dark.
    const bright = await solidImage(page, 240);
    const dark = await solidImage(page, 8);
    await writeAssets(page, 'pb', [bright, dark, null, null, null, null, null]);

    // Default active slot = 0 (bright). Output is bright.
    {
      const r = await waitForLuma(page, 'out', (m) => m > BRIGHT);
      expect(r.ok, `default slot 0 bright (mean=${r.last.toFixed(1)})`).toBe(true);
    }

    // Gate at note D (slot 1, dark). Output goes dark.
    await fireAssetGate(page, 'pb', midiToVOct(ASSET_SLOT_NOTES[1]!));
    {
      const r = await waitForLuma(page, 'out', (m) => m < DARK);
      expect(r.ok, `slot 1 dark after D gate (mean=${r.last.toFixed(1)})`).toBe(true);
    }

    // Gate at note C (slot 0, bright). Output goes bright again.
    await fireAssetGate(page, 'pb', midiToVOct(ASSET_SLOT_NOTES[0]!));
    {
      const r = await waitForLuma(page, 'out', (m) => m > BRIGHT);
      expect(r.ok, `slot 0 bright after C gate (mean=${r.last.toFixed(1)})`).toBe(true);
    }

    // A black-key gate (C#, slot null) is ignored — output stays slot 0 bright.
    await fireAssetGate(page, 'pb', midiToVOct(ASSET_SLOT_NOTES[0]! + 1));
    {
      const r = await waitForLuma(page, 'out', (m) => m > BRIGHT);
      expect(r.ok, `black key ignored, stays bright (mean=${r.last.toFixed(1)})`).toBe(true);
    }

    expect(errors, `no page errors: ${errors.join('; ')}`).toEqual([]);
  });
});

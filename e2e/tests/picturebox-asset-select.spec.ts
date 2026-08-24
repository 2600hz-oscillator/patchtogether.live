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
// The pump's own sampling interval, imported from the product rather than
// re-typed — the two gate holds below are expressed in ITS ticks.
import { PUMP_INTERVAL_MS } from '../../packages/web/src/lib/ui/media/node-extras-registry';

async function setup(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/rack?shell=legacy&seed=none');
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

/**
 * Fire an asset_gate rising edge with a given asset_pitch (raw V/oct) via the
 * video engine setParam — the same entry point the cross-domain CV bridge uses.
 *
 * ⚠ THIS HELPER WAS UNSOUND AND THE SPEC FAILED 2 RUNS IN 5 ON PRISTINE MAIN
 * (2026-08-24, measured with REPEAT=5), always on the THIRD leg and always with
 * the identical reading `mean=7.7` — i.e. still showing slot 1 after a gate at
 * note C. It is a genuine race, not a renderer budget, and the mechanism is the
 * RELEASE rather than the rise:
 *
 * The consumer is `pictureboxProducer.pump` in `$lib/ui/media/extras-producers`.
 * It samples ONE value per tick and edge-detects with `last < 0.5 && g >= 0.5`,
 * so it can only see a rising edge if it has already OBSERVED THE LOW. This
 * helper used to write the gate back to 0 and return IMMEDIATELY, so the release
 * and the next rise landed inside a single tick whenever the two Playwright
 * round-trips took less than one interval — the pump read high-then-high, no
 * edge fired, and the displayed slot never moved. The three "green" legs were
 * green because a tick happened to land in the round-trip, which is exactly the
 * "ask why the GREEN runs are green" shape: the coverage was a coin flip.
 *
 * ⚠ AND THE SAMPLING RATE IS THE PRODUCT'S, NOT THE TEST'S. A gate narrower
 * than the pump's interval is genuinely invisible to this module — the card's
 * old interval had the same property and the move to the pump deliberately kept
 * it ("gate timing is unchanged by the move"). So the test respects the
 * product's rate; it does not ask the product to sample faster.
 *
 * The fix is a direct port of the one `extras-producer-lifetime.spec.ts` already
 * carries for the same jacks, including its reasoning — see the `pacing` note
 * there. Both holds derive from PUMP_INTERVAL_MS rather than re-typing 80.
 */
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
  // pacing: the HIGH half of a real product GATE WIDTH. The node-lifetime pump
  // samples asset_gate once per PUMP_INTERVAL_MS — defined by the product in
  // $lib/ui/media/node-extras-registry and imported here rather than re-typed —
  // so the level has to SIT high across at least one sample or a live detector
  // reads as dead. No number of rAF frames expresses "one setInterval tick".
  // Three ticks so a loaded runner cannot starve the single sample this needs.
  await page.waitForTimeout(PUMP_INTERVAL_MS * 3);
  await page.evaluate((nodeId) => {
    const w = globalThis as unknown as {
      __engine?: () => {
        getDomain?: (d: string) => { setParam?: (n: string, p: string, v: number) => void } | null;
      } | null;
    };
    const ve = w.__engine?.()?.getDomain?.('video');
    ve?.setParam?.(nodeId, 'asset_gate', 0); // release → re-arm
  }, nodeId);
  // pacing: THE LOW half, and the half whose absence made this spec unsound.
  // An edge detector re-arms only once it has OBSERVED the low, on the SAME
  // PUMP_INTERVAL_MS sample clock. Without this the release and the next rise
  // land inside one tick, the pump reads high-then-high, and the second gate
  // silently does nothing — which is precisely the 2-in-5 failure measured on
  // main. Same three-tick margin, same reason.
  await page.waitForTimeout(PUMP_INTERVAL_MS * 3);
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

// e2e/tests/clip-media-recover-reachable.spec.ts
//
// The CLIP-TAKE crash-recovery prompt must be REACHABLE, not merely rendered.
//
// Slice 2 of the clip-recording programme ships the media store, and with it a
// prompt that only ever exists in a state no ordinary test enters: a take that
// was still recording when its tab died. Two structural blind spots would
// otherwise leave it uncovered, and they are the same pair that let
// RECORDERBOX ship an unreachable recovery prompt:
//
//   1. `card-control-overflow` only spawns a module in its DEFAULT state, and
//      this prompt does not exist there.
//   2. Nothing else in the repo enters clip-media recovery at all.
//
// So this spec ENTERS THE STATE: it seeds the manifest into IndexedDB and the
// samples into OPFS directly — the same records `listRecoverableClipMedia` and
// `readClipMedia` scan for — and then asserts the buttons are inside the card's
// own box and hit-testable at their centre point.
//
// ⚠ `toBeVisible()` ALONE WOULD NOT CATCH THE BUG IT GUARDS. An element
// clipped by an ancestor's `overflow: hidden` still reports as visible: it has
// a non-empty box and is not `display: none`. The clipplayer card's height is
// hard-pinned by the rack tier and `.card` is `overflow: hidden`, so a prompt
// appended to the flow would read as visible and be unclickable. The assertion
// has to compare geometry against the CLIPPING ANCESTOR, which is what
// `boundingBox` + `elementFromPoint` do below.
//
// ⚠ THE SEEDED TAKE IS DELIBERATELY 2.5 LOOPS LONG. Recovery truncates to the
// last WHOLE loop, so this also proves the prompt is offered for a partial take
// at all — a scan that refused anything but an exact multiple would render
// nothing here and the spec would fail rather than pass quietly.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { BOOT_MS, SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';

const NODE_ID = 'cp1';
const MEDIA_ID = 'clip-e2e-interrupted';
/** 4 frames per loop × 8 bytes/frame (pcm-f32 stereo) = 32 bytes per loop. */
const UNIT_FRAMES = 4;
const BYTES_PER_FRAME = 8;
/** 10 frames = 2.5 loops. Recovery must offer 2 loops, never 2.5. */
const SEEDED_FRAMES = 10;

test.describe.configure({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

test.describe('CLIP media crash-recovery prompt', () => {
  test('Recover / Discard are inside the card and clickable', async ({ page }) => {
    await page.goto('/rack?shell=legacy&seed=none');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(
      () => typeof (globalThis as unknown as { __ensureEngine?: unknown }).__ensureEngine === 'function',
      undefined,
      { timeout: BOOT_MS },
    );

    // Seed BEFORE the card mounts — the scan runs on mount, so a later write
    // would not be picked up without a rescan.
    const seeded = await page.evaluate(
      async ({ nodeId, mediaId, unitFrames, bytesPerFrame, frames }) => {
        // 1. The SAMPLES, into OPFS at `clipmedia/<mediaId>`. `createWritable`
        //    is the main-thread OPFS write path (the store's own writer uses a
        //    sync access handle, which is worker-only).
        const root = await navigator.storage.getDirectory();
        const dir = await root.getDirectoryHandle('clipmedia', { create: true });
        const fh = await dir.getFileHandle(mediaId, { create: true });
        const w = await fh.createWritable();
        await w.write(new Uint8Array(frames * bytesPerFrame));
        await w.close();

        // 2. The MANIFEST, into IndexedDB. `status: 'recording'` is what makes
        //    it a recover candidate — and what makes the GC spare it.
        await new Promise<void>((resolve, reject) => {
          const req = indexedDB.open('patchtogether-clipmedia', 1);
          req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('manifests')) {
              db.createObjectStore('manifests', { keyPath: 'mediaId' });
            }
          };
          req.onsuccess = () => {
            const db = req.result;
            const tx = db.transaction('manifests', 'readwrite');
            tx.objectStore('manifests').put({
              mediaId,
              nodeId,
              lane: 0,
              slot: 0,
              startedAt: 1_750_000_000_000,
              status: 'recording',
              format: 'pcm-f32',
              sampleRate: 48_000,
              channels: 2,
              frames,
              unitFrames,
              lengthSteps: 16,
            });
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onerror = () => {
              db.close();
              reject(tx.error);
            };
          };
          req.onerror = () => reject(req.error);
        });

        const check = await (await fh.getFile()).size;
        return { bytesOnDisk: check };
      },
      {
        nodeId: NODE_ID,
        mediaId: MEDIA_ID,
        unitFrames: UNIT_FRAMES,
        bytesPerFrame: BYTES_PER_FRAME,
        frames: SEEDED_FRAMES,
      },
    );
    // The seed itself is asserted: a silently-failed OPFS write would leave the
    // prompt absent and the failure would read as "the feature is broken".
    expect(seeded.bytesOnDisk, 'the seeded take should be on disk').toBe(
      SEEDED_FRAMES * BYTES_PER_FRAME,
    );

    await spawnPatch(page, [
      { id: NODE_ID, type: 'clipplayer', domain: 'audio', position: { x: 200, y: 120 } },
    ]);

    const prompt = page.getByTestId('clipplayer-recover');
    await expect(prompt, 'the seeded manifest should raise the recovery prompt').toBeVisible({
      timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
    });

    // It offers the TRUNCATED length: 10 frames of a 4-frame loop is 2 loops.
    await expect(prompt, 'the prompt should offer WHOLE loops, never 2.5').toContainText('2 loops');

    // The clipping ancestor: `.card` carries the pinned height + overflow:hidden.
    const card = page.locator(`[data-id="${NODE_ID}"] .card`).first();
    const cardBox = await card.boundingBox();
    expect(cardBox, 'card should have a box').not.toBeNull();

    for (const testid of ['clipplayer-recover-save', 'clipplayer-recover-discard']) {
      const btn = page.getByTestId(testid);
      await expect(btn).toBeVisible();
      const box = await btn.boundingBox();
      expect(box, `${testid} should have a box`).not.toBeNull();

      // GEOMETRY, in viewport-scaled px (xyflow applies a zoom transform, so
      // these are NOT CSS px — but both boxes come through the same transform,
      // so the CONTAINMENT comparison is scale-invariant even though the
      // magnitudes are not).
      const overflowBottom = box!.y + box!.height - (cardBox!.y + cardBox!.height);
      expect(
        overflowBottom,
        `${testid} extends ${Math.round(overflowBottom)}px (viewport-scaled) past the bottom of ` +
          `the rack-pinned card, which is overflow:hidden — the control is unreachable`,
      ).toBeLessThanOrEqual(0);

      // HIT TEST — the assertion that actually proves usability. A button can
      // sit inside the card box and still be covered by a sibling; this checks
      // the element at its centre really is the button (or a descendant).
      const hit = await page.evaluate(
        ({ x, y, id }) => {
          const el = document.elementFromPoint(x, y);
          return !!el?.closest(`[data-testid="${id}"]`);
        },
        { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2, id: testid },
      );
      expect(hit, `${testid} is not the topmost element at its own centre — something covers it`).toBe(
        true,
      );

      await expect(btn).toBeEnabled();
    }

    // Discard actually resolves the prompt AND frees the bytes — so this spec
    // cannot pass on a decorative panel, and cannot pass on a button that only
    // hides the prompt.
    await page.getByTestId('clipplayer-recover-discard').click();
    await expect(prompt, 'discarding the only candidate should retire the prompt').toBeHidden({
      timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
    });

    const stillThere = await page.evaluate(async (mediaId) => {
      try {
        const root = await navigator.storage.getDirectory();
        const dir = await root.getDirectoryHandle('clipmedia', { create: false });
        await dir.getFileHandle(mediaId, { create: false });
        return true;
      } catch {
        return false;
      }
    }, MEDIA_ID);
    expect(stillThere, 'Discard should delete the take, not merely hide the prompt').toBe(false);
  });
});

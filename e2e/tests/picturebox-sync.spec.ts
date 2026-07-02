// e2e/tests/picturebox-sync.spec.ts
//
// @collab — verifies image content syncs across rack-mates via the
// Y.Doc. Two browser contexts attach to the same Hocuspocus rackspace,
// user A spawns a PICTUREBOX and loads an image into it, and user B's
// PICTUREBOX is asserted to:
//   1. receive the same `imageBytes` string in node.data, AND
//   2. render data-has-image="true" on its card.
//
// The image is generated in-browser (no fixture file needed) by
// drawing a known checkerboard pattern onto a canvas, exporting as
// PNG, and feeding it to the picturebox-encode pipeline (which then
// downscales to 640x480 JPEG). This keeps the spec deterministic and
// hermetic.

import { test, expect, type Page } from '@playwright/test';
import { SYNC_BUDGET_MS, SYNC_POLL_INTERVALS } from './_collab-helpers';

interface CollabContexts {
  pageA: Page;
  pageB: Page;
  rackspaceId: string;
  close: () => Promise<void>;
}

async function openTwoContexts(
  browser: import('@playwright/test').Browser,
): Promise<CollabContexts> {
  const rackspaceId = `pb-sync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  for (const p of [pageA, pageB]) {
    await p.goto('/rack');
    await p.waitForLoadState('networkidle');
    await p.waitForFunction(
      () =>
        typeof (window as unknown as { __attachProvider?: unknown }).__attachProvider === 'function',
    );
  }

  // Sequentially attach (rather than Promise.all) so HocuspocusProvider's
  // initial-sync handshakes don't race each other under Vite dev's HMR
  // chatter — the parallel form was triggering "execution context
  // destroyed" because the second attach completed mid-microtask while
  // the first page's reactive cascade was still settling.
  for (const p of [pageA, pageB]) {
    await p.evaluate(async (id) => {
      const w = window as unknown as { __attachProvider: (id: string) => Promise<unknown> };
      await w.__attachProvider(id);
    }, rackspaceId);
  }
  return {
    pageA,
    pageB,
    rackspaceId,
    async close() {
      await Promise.all([ctxA.close(), ctxB.close()]);
    },
  };
}

/** Spawn a PICTUREBOX in the given page via the dev __patch global. */
async function spawnPicturebox(page: Page, nodeId: string, creatorId: string): Promise<void> {
  await page.evaluate(
    ({ nodeId, creatorId }) => {
      const w = window as unknown as {
        __patch: { nodes: Record<string, unknown> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        w.__patch.nodes[nodeId] = {
          id: nodeId,
          type: 'picturebox',
          domain: 'video',
          position: { x: 200, y: 200 },
          params: {},
          data: { creatorId },
        };
      });
    },
    { nodeId, creatorId },
  );
}

/** Encode a PNG checkerboard inline (mirroring the card's downscale-
 *  and-encode pipeline) and write it into node.data via the patch.
 *  Inlined here rather than importing picturebox-encode.ts because
 *  Vite's `import('/src/...')` from inside page.evaluate occasionally
 *  trips the page's execution context when HMR catches the dynamic
 *  import and re-evaluates a module. Inline keeps the test hermetic. */
async function loadCheckerboardImage(page: Page, nodeId: string): Promise<string> {
  return await page.evaluate(async (nodeId) => {
    // Draw a 200x200 black/white checkerboard so the JPEG isn't all
    // one color (which compresses to absurdly few bytes and could mask
    // bugs in the encode path).
    const src = new OffscreenCanvas(200, 200);
    const sctx = src.getContext('2d')!;
    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < 10; x++) {
        sctx.fillStyle = (x + y) % 2 === 0 ? '#ffffff' : '#000000';
        sctx.fillRect(x * 20, y * 20, 20, 20);
      }
    }
    const srcBlob = await src.convertToBlob({ type: 'image/png' });

    // Mirror the card's downscale-and-encode (TARGET 640x480 cover,
    // JPEG q=0.85). Same shape as picturebox-encode.ts.
    const TARGET_W = 640;
    const TARGET_H = 480;
    const bitmap = await createImageBitmap(srcBlob);
    const dst = new OffscreenCanvas(TARGET_W, TARGET_H);
    const dctx = dst.getContext('2d')!;
    dctx.fillStyle = '#000';
    dctx.fillRect(0, 0, TARGET_W, TARGET_H);
    const scale = Math.max(TARGET_W / bitmap.width, TARGET_H / bitmap.height);
    const dw = bitmap.width * scale;
    const dh = bitmap.height * scale;
    const dx = (TARGET_W - dw) / 2;
    const dy = (TARGET_H - dh) / 2;
    dctx.drawImage(bitmap, dx, dy, dw, dh);
    const dstBlob = await dst.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
    const buf = new Uint8Array(await dstBlob.arrayBuffer());
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < buf.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, Array.from(buf.subarray(i, i + CHUNK)));
    }
    const base64 = btoa(binary);

    const w = window as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> } | undefined> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const target = w.__patch.nodes[nodeId];
      if (!target) throw new Error(`node ${nodeId} not found`);
      if (!target.data) target.data = {};
      const d = target.data as Record<string, unknown>;
      d.imageBytes = base64;
      d.imageMime = 'image/jpeg';
      d.imageName = 'checkerboard.png';
    });
    return base64;
  }, nodeId);
}

test.describe('@collab PICTUREBOX multiplayer image sync', () => {
  // 120s: two cross-context relay converges (B sees node, B sees the image
  // bytes) plus two has-image attribute waits, each on a generous budget. 60s
  // was too tight when A→relay→B image-bytes propagation stalls under CI relay
  // contention (the @collab de-flake).
  test.setTimeout(120_000);

  test('image bytes loaded in A appear in B and render the card as has-image', async ({ browser }) => {
    const s = await openTwoContexts(browser);
    try {
      const NODE = 'pbox-sync-1';

      // A creates the picturebox.
      await spawnPicturebox(s.pageA, NODE, 'user-a');

      // B sees it within a few seconds.
      await expect
        .poll(
          async () =>
            await s.pageB.evaluate(
              (id) =>
                Object.keys(
                  (window as unknown as { __patch: { nodes: Record<string, unknown> } }).__patch.nodes,
                ).includes(id),
              NODE,
            ),
          { timeout: SYNC_BUDGET_MS, intervals: SYNC_POLL_INTERVALS },
        )
        .toBe(true);

      // A loads an image. We capture A's base64 string for direct
      // comparison against B.
      const aBytes = await loadCheckerboardImage(s.pageA, NODE);
      expect(aBytes.length).toBeGreaterThan(100); // sanity: real JPEG bytes

      // B receives the same imageBytes string in its Y.Doc within a
      // few seconds.
      await expect
        .poll(
          async () =>
            await s.pageB.evaluate((id) => {
              const w = window as unknown as {
                __patch: { nodes: Record<string, { data?: { imageBytes?: string } } | undefined> };
              };
              return w.__patch.nodes[id]?.data?.imageBytes ?? null;
            }, NODE),
          { timeout: SYNC_BUDGET_MS, intervals: SYNC_POLL_INTERVALS },
        )
        .toBe(aBytes);

      // B's PICTUREBOX card should render data-has-image="true" once
      // the bytes have been decoded + applied to the texture. The card
      // sets this attribute reactively from `imageBytes !== null`.
      const cardSelector = `.svelte-flow__node-picturebox [data-testid="picturebox-card"]`;
      await expect(s.pageB.locator(cardSelector)).toHaveAttribute(
        'data-has-image',
        'true',
        { timeout: 15_000 },
      );

      // A's card should also be has-image (sanity: same code path runs
      // on the writer too).
      await expect(s.pageA.locator(cardSelector)).toHaveAttribute(
        'data-has-image',
        'true',
        { timeout: 15_000 },
      );
    } finally {
      await s.close();
    }
  });
});

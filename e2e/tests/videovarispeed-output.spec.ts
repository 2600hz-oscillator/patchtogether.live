// e2e/tests/videovarispeed-output.spec.ts
//
// VIDEOVARISPEED downstream-streams-at-ALL-speeds coverage.
//
// This is the LOAD-BEARING regression guard for the bug the rolled-back
// VIDEOBOX #291 had: at non-1× speed the `video` output STOPPED reaching
// downstream modules (VIDEO-OUT / BENTBOX). #291 coupled the texture upload
// cadence to the element's play/seek state, so any speed that scrubbed
// currentTime (or any rate != 1) left the element mid-seek / out of sync with
// the engine rAF and the downstream texture froze / went black.
//
// VIDEOVARISPEED drives the output upload off requestVideoFrameCallback (the
// element's OWN decode cadence, independent of playbackRate), so the output
// must show MOVING video at 2×, 0.5×, AND reverse. We assert exactly that:
// load the lobby clip into VIDEOVARISPEED -> VIDEO-OUT, set each speed, and
// require frame-to-frame change on the downstream canvas.

import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { spawnPatch } from './_helpers';

const FIXTURE = fileURLToPath(new URL('../fixtures/lobby-clip.webm', import.meta.url));

async function setup(page: import('@playwright/test').Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  return errors;
}

/** Mean luminance + per-channel max over a card canvas. */
async function canvasStats(
  page: import('@playwright/test').Page,
  testid: string,
): Promise<{ mean: number; max: number }> {
  const handle = page.locator(`canvas[data-testid="${testid}"]`);
  await expect(handle, `${testid} present`).toHaveCount(1);
  return await handle.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (!ctx) return { mean: 0, max: 0 };
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let sum = 0, max = 0;
    for (let i = 0; i < data.length; i += 4) {
      const v = (data[i]! + data[i + 1]! + data[i + 2]!) / 3;
      sum += v;
      if (v > max) max = v;
    }
    return { mean: sum / (data.length / 4), max };
  });
}

/** A signature of the canvas pixels for change detection. */
async function canvasSignature(
  page: import('@playwright/test').Page,
  testid: string,
): Promise<number> {
  const handle = page.locator(`canvas[data-testid="${testid}"]`);
  return await handle.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (!ctx) return 0;
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let sig = 0;
    for (let i = 0; i < data.length; i += 256) {
      sig += (data[i]! + data[i + 1]! * 2 + data[i + 2]! * 3) * ((i % 997) + 1);
    }
    return sig;
  });
}

/** Set a param on a node via the dev-mode window globals (deterministic). */
async function setNodeParam(
  page: import('@playwright/test').Page,
  nodeId: string,
  key: string,
  value: number,
): Promise<void> {
  await page.evaluate(
    ({ nodeId, key, value }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes[nodeId];
        if (n) n.params[key] = value;
      });
    },
    { nodeId, key, value },
  );
}

async function videoState(
  page: import('@playwright/test').Page,
): Promise<{ rate: number; time: number; paused: boolean }> {
  const v = page.locator('[data-testid="videovarispeed-video"]');
  return await v.evaluate((el) => {
    const ve = el as HTMLVideoElement;
    return { rate: ve.playbackRate, time: ve.currentTime, paused: ve.paused };
  });
}

/** Load the fixture into a VIDEOVARISPEED card + start playback. */
async function loadAndPlay(page: import('@playwright/test').Page) {
  await page.setInputFiles('[data-testid="videovarispeed-file-input"]', FIXTURE);
  await expect(page.locator('[data-testid="videovarispeed-card"]')).toHaveAttribute(
    'data-has-local-file', 'true', { timeout: 8000 },
  );
  await page.click('[data-testid="videovarispeed-play-btn"]');
  await expect(page.locator('[data-testid="videovarispeed-card"]')).toHaveAttribute(
    'data-is-playing', 'true', { timeout: 4000 },
  );
}

/** Assert the downstream VIDEO-OUT canvas shows MOVING video right now.
 *
 *  The brightness check is POLLED rather than read once: immediately after a
 *  speed change the rVFC-driven upload may not yet have presented a fresh
 *  decoded frame (the element re-arms its decode cadence at the new rate /
 *  after a reverse-scrub seek), so a single eager read can momentarily catch
 *  the idle pattern (max ~20) before the next frame flows through
 *  rVFC -> upload -> VIDEO-OUT. This was the slow-CI-runner flake on shard
 *  8/8 (max=19.67 at 2x / reverse). Polling lets a fresh frame settle while
 *  still asserting REAL video brightness (max > 40, well above the idle
 *  pattern's ceiling); the frame-change check below is the actual
 *  streams-at-all-speeds regression guard. */
async function assertDownstreamMoving(
  page: import('@playwright/test').Page,
  label: string,
) {
  await expect
    .poll(async () => (await canvasStats(page, 'video-out-canvas')).max, {
      timeout: 5000,
      message: `${label}: VIDEO-OUT has bright pixels (real frame, not idle)`,
    })
    .toBeGreaterThan(40);
  // Two reads ~400ms apart must differ -> the downstream texture is updating.
  const a = await canvasSignature(page, 'video-out-canvas');
  await page.waitForTimeout(450);
  const b = await canvasSignature(page, 'video-out-canvas');
  const rel = Math.abs(a - b) / Math.max(1, Math.abs(a));
  expect(rel, `${label}: VIDEO-OUT frame changed (a=${a} b=${b} rel=${rel.toFixed(5)})`).toBeGreaterThan(0.0005);
}

test.describe('VIDEOVARISPEED output streams downstream at ALL speeds', () => {
  test('1× / 2× / 0.5× / reverse all keep VIDEO-OUT showing moving video', async ({ page }) => {
    const errors = await setup(page);
    await spawnPatch(page,
      [
        { id: 'vv',  type: 'videovarispeed', position: { x: 40,  y: 40 }, domain: 'video' },
        { id: 'out', type: 'videoOut',       position: { x: 560, y: 40 }, domain: 'video' },
      ],
      [{ id: 'e1', from: { nodeId: 'vv', portId: 'video' }, to: { nodeId: 'out', portId: 'in' }, sourceType: 'video', targetType: 'video' }],
    );

    await loadAndPlay(page);
    await page.waitForTimeout(600);

    // --- 1× (default centre knob) ---
    await assertDownstreamMoving(page, '1x');

    // --- 2× forward: knob ~0.667 → +3×? Use knob 0.667→3; pick the spec 2×.
    // 2× = knob where 1 + (k-0.5)*6 = 2 → k = 0.6667.
    await setNodeParam(page, 'vv', 'speed', 0.6667);
    await expect.poll(async () => (await videoState(page)).rate, { timeout: 4000 }).toBeCloseTo(2, 0);
    await assertDownstreamMoving(page, '2x');

    // --- 0.5× forward: 1 + (k-0.5)*6 = 0.5 is < +1 so it's in the LEFT half:
    // -4 + k*10 = 0.5 → k = 0.45.
    await setNodeParam(page, 'vv', 'speed', 0.45);
    await expect.poll(async () => (await videoState(page)).rate, { timeout: 4000 }).toBeCloseTo(0.5, 1);
    await assertDownstreamMoving(page, '0.5x');

    // --- Reverse: knob 0 → -4×. The element is paused + scrubbed; the
    // downstream texture must STILL update (rVFC fires after each scrub).
    await setNodeParam(page, 'vv', 'speed', 0.0);
    await page.waitForTimeout(500);
    await assertDownstreamMoving(page, 'reverse');

    expect(errors, `no page errors: ${errors.join(' | ')}`).toEqual([]);
  });
});

test.describe('VIDEOVARISPEED transport', () => {
  test('SPEED knob drives <video>.playbackRate (forward varispeed)', async ({ page }) => {
    await setup(page);
    await spawnPatch(page,
      [{ id: 'vv', type: 'videovarispeed', position: { x: 40, y: 40 }, domain: 'video' }],
      [],
    );
    await loadAndPlay(page);
    await page.waitForTimeout(400);

    await setNodeParam(page, 'vv', 'speed', 1.0); // +4×
    await expect.poll(async () => (await videoState(page)).rate, { timeout: 4000 }).toBeCloseTo(4, 1);

    await setNodeParam(page, 'vv', 'speed', 0.5); // +1×
    await expect.poll(async () => (await videoState(page)).rate, { timeout: 4000 }).toBeCloseTo(1, 1);
  });

  test('START/END window: playback stays inside [start, end] and loops', async ({ page }) => {
    await setup(page);
    await spawnPatch(page,
      [{ id: 'vv', type: 'videovarispeed', position: { x: 40, y: 40 }, domain: 'video' }],
      [],
    );
    await page.setInputFiles('[data-testid="videovarispeed-file-input"]', FIXTURE);
    await expect(page.locator('[data-testid="videovarispeed-card"]')).toHaveAttribute(
      'data-has-local-file', 'true', { timeout: 8000 },
    );

    await setNodeParam(page, 'vv', 'start', 0.0);
    await setNodeParam(page, 'vv', 'end', 0.15);
    await expect(page.locator('[data-testid="videovarispeed-card"]')).toHaveAttribute('data-loop', 'true');
    await page.click('[data-testid="videovarispeed-play-btn"]');

    const samples: number[] = [];
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(120);
      samples.push((await videoState(page)).time);
    }
    const dur = await page.locator('[data-testid="videovarispeed-video"]').evaluate(
      (el) => (el as HTMLVideoElement).duration,
    );
    const endSec = dur * 0.15;
    for (const t of samples) {
      expect(t, `currentTime ${t.toFixed(2)} within window end ${endSec.toFixed(2)}`)
        .toBeLessThanOrEqual(endSec + 0.3);
    }
    expect(Math.max(...samples)).toBeGreaterThan(0);
  });

  test('LOOP button toggles to ONE-SHOT and back', async ({ page }) => {
    await setup(page);
    await spawnPatch(page,
      [{ id: 'vv', type: 'videovarispeed', position: { x: 40, y: 40 }, domain: 'video' }],
      [],
    );
    const card = page.locator('[data-testid="videovarispeed-card"]');
    await expect(card).toHaveAttribute('data-loop', 'true');
    await page.click('[data-testid="videovarispeed-loop-btn"]');
    await expect(card).toHaveAttribute('data-loop', 'false');
    await expect(page.locator('[data-testid="videovarispeed-loop-btn"]')).toHaveText('1-SHOT');
    await page.click('[data-testid="videovarispeed-loop-btn"]');
    await expect(card).toHaveAttribute('data-loop', 'true');
  });

  test('one-shot stops at END', async ({ page }) => {
    await setup(page);
    await spawnPatch(page,
      [{ id: 'vv', type: 'videovarispeed', position: { x: 40, y: 40 }, domain: 'video' }],
      [],
    );
    await page.setInputFiles('[data-testid="videovarispeed-file-input"]', FIXTURE);
    await expect(page.locator('[data-testid="videovarispeed-card"]')).toHaveAttribute(
      'data-has-local-file', 'true', { timeout: 8000 },
    );
    await page.click('[data-testid="videovarispeed-loop-btn"]');
    await expect(page.locator('[data-testid="videovarispeed-card"]')).toHaveAttribute('data-loop', 'false');
    await setNodeParam(page, 'vv', 'start', 0.0);
    await setNodeParam(page, 'vv', 'end', 0.1);
    await page.click('[data-testid="videovarispeed-play-btn"]');

    await expect.poll(async () => (await videoState(page)).paused, { timeout: 6000 }).toBe(true);
  });
});

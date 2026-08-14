// e2e/tests/recording-survives-card-collapse.spec.ts
//
// #1574 — collapsing RECORDERBOX must not destroy an in-progress recording.
//
// Owner, on dev: "when recorderbox is un-expanded, it stops the recording."
//
// RECORDERBOX is un-migrated, so under the faceplate shell its card exists ONLY inside
// the dock full-view. Collapsing UNMOUNTS the card, and the card's onDestroy ran
// `recorder.abandon()` plus `cancelAnimationFrame(rafId)` — a view action destroyed the
// take. The recorder, its capture canvas, its frame pump and its render lease now live in
// node-recorder-registry, keyed to the NODE.
//
// ── The assertion is CAUSAL, not statistical ─────────────────────────────────
//
// "Still recording" as a boolean is too weak: an entry can survive while the pump is dead,
// which is precisely the half-fix #1531 warned about (a projector that is open and dead).
// So the test requires the take to keep GROWING while the card is gone — elapsed time must
// advance and frames must keep arriving, sampled from the NODE's own record rather than
// from any card.
//
// ── Why this is capability-gated, and where it can actually run ──────────────
//
// CI's headless runner reports avc as config-supported but emits ZERO chunks for real
// frames, so a recording there never starts. The probe below is a real end-to-end encode
// (same approach as recorderbox.spec.ts) rather than isConfigSupported.
//
// Per the repo standard that a gate which cannot fail on CI is decoration, the skip is
// LOUD and defeatable: set `E2E_REQUIRE_RECORD=1` in any lane that promises a real
// encoder and the test FAILS instead of skipping, so a silently-never-run gate is not
// mistaken for a passing one.

import { test, expect, type Page } from './_fixtures';
import { spawnPatch } from './_helpers';

test.setTimeout(150_000);

/** Does this runtime ACTUALLY encode H.264 — i.e. does a real encode emit chunks? */
async function h264EncodeSupported(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    interface MiniEnc { configure(c: unknown): void; encode(f: unknown, o?: unknown): void; flush(): Promise<void>; close(): void }
    const g = globalThis as {
      VideoEncoder?: new (i: { output: () => void; error: () => void }) => MiniEnc;
      VideoFrame?: new (s: CanvasImageSource, i: { timestamp: number; duration?: number }) => { close(): void };
    };
    if (typeof g.VideoEncoder !== 'function' || typeof g.VideoFrame !== 'function') return false;
    const W = 64, H = 64;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    if (!ctx) return false;
    for (const codec of ['avc1.640028', 'avc1.42E01E']) {
      let chunks = 0, errored = false;
      let enc: MiniEnc | null = null;
      try {
        enc = new g.VideoEncoder({ output: () => { chunks++; }, error: () => { errored = true; } });
        enc.configure({ codec, width: W, height: H, bitrate: 1_000_000, framerate: 30 });
        for (let i = 0; i < 4 && !errored; i++) {
          ctx.fillStyle = `rgb(${(i * 60) % 256},${(i * 30) % 256},${(i * 90) % 256})`;
          ctx.fillRect(0, 0, W, H);
          ctx.fillStyle = '#fff';
          ctx.fillRect(i * 8, i * 8, 24, 24);
          const f = new g.VideoFrame(cv, { timestamp: i * 33_333, duration: 33_333 });
          enc.encode(f, { keyFrame: i === 0 });
          f.close();
        }
        await enc.flush();
      } catch { errored = true; } finally { try { enc?.close(); } catch { /* */ } }
      if (!errored && chunks > 0) return true;
    }
    return false;
  });
}

/** The NODE's own view of its recording — deliberately not read off the card. */
async function nodeRecording(page: Page, id: string) {
  return page.evaluate(
    (n) => (globalThis as unknown as { __nodeRecording(x: string): { recording: boolean; elapsed?: number; state?: string } }).__nodeRecording(n),
    id,
  );
}

/**
 * Wait until the node's recorded ELAPSED time passes `target`, accumulating IN THE PAGE.
 * Returns the samples seen so a failure says whether it was frozen or never looked —
 * "0.0000" from a starved poll loop and "0.0000" from a dead pump are indistinguishable
 * without this.
 */
async function waitForElapsedPast(page: Page, id: string, target: number, budgetMs: number) {
  return page.evaluate(
    async ({ id, target, budgetMs }) => {
      const api = (globalThis as unknown as { __nodeRecording(x: string): { recording: boolean; elapsed?: number } }).__nodeRecording;
      const seen: number[] = [];
      const t0 = performance.now();
      while (performance.now() - t0 < budgetMs) {
        const v = api(id);
        const e = v.elapsed ?? 0;
        if (seen[seen.length - 1] !== e) seen.push(e);
        if (e > target) return { ok: true, elapsed: e, samples: seen.length, seen: seen.slice(-6), elapsedMs: performance.now() - t0 };
        await new Promise((r) => requestAnimationFrame(() => r(null)));
      }
      const v = api(id);
      return { ok: false, elapsed: v.elapsed ?? 0, samples: seen.length, seen: seen.slice(-6), elapsedMs: performance.now() - t0 };
    },
    { id, target, budgetMs },
  );
}

test('a recording keeps GROWING while its card is collapsed', async ({ page }) => {
  await page.goto('/rack');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 30_000 });

  const canEncode = await h264EncodeSupported(page);
  if (!canEncode) {
    const required = !!process.env.E2E_REQUIRE_RECORD;
    // LOUD: say plainly that the gate did not run, so a green suite is not read as
    // "collapse-safe recording verified".
    // eslint-disable-next-line no-console
    console.log(
      `[#1574] SKIPPED — this runtime emits no H.264 chunks for real frames, so no recording can start. ` +
        `Set E2E_REQUIRE_RECORD=1 in a lane with a real encoder to make this a FAILURE instead.`,
    );
    expect(required, '#1574 gate did not run, but E2E_REQUIRE_RECORD demanded it').toBe(false);
    test.skip();
    return;
  }

  // A live picture to record: ACIDWARP -> RECORDERBOX.
  await spawnPatch(
    page,
    [
      { id: 'src', type: 'acidwarp', domain: 'video' },
      { id: 'rec', type: 'recorderbox', domain: 'video' },
    ],
    // ⚠ #1499: this edge was `{ from: 'src', fromPort: 'video_out', … }` — a
    // shape spawnPatch never accepted (it reads `from.nodeId`/`from.portId` and
    // keys by `e.id`), AND the port ids were wrong (acidwarp's out is 'out',
    // recorderbox's in is 'in'). The acidwarp→recorderbox cable never actually
    // materialized; the recording machinery was being exercised on an unfed
    // input.
    [
      {
        id: 'e-src-rec',
        from: { nodeId: 'src', portId: 'out' },
        to: { nodeId: 'rec', portId: 'in' },
        sourceType: 'video',
        targetType: 'video',
      },
    ],
    { mountTimeout: 40_000 },
  );

  // Record to the download fallback — no directory picker, no modal.
  await page.evaluate(() => {
    (globalThis as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker = undefined;
  });

  await page.evaluate((id) => (globalThis as unknown as { __openDockFullView(x: string): void }).__openDockFullView(id), 'rec');
  await expect(page.getByTestId('recorderbox-card')).toBeVisible({ timeout: 20_000 });

  await page.getByTestId('recorderbox-record').click();
  await expect
    .poll(async () => (await nodeRecording(page, 'rec')).recording, { timeout: 30_000 })
    .toBe(true);

  // Let it establish a real baseline while the card is still mounted.
  const before = await waitForElapsedPast(page, 'rec', 0.3, 15_000);
  expect(before.ok, `recording did not advance even WITH the card mounted: ${JSON.stringify(before)}`).toBe(true);

  // ── THE ACT UNDER TEST: collapse. This unmounts the card. ──
  await page.getByTestId('faceplate-collapse').click();
  await expect(page.getByTestId('recorderbox-card')).toHaveCount(0, { timeout: 15_000 });

  const atCollapse = (await nodeRecording(page, 'rec')).elapsed ?? 0;
  expect(
    (await nodeRecording(page, 'rec')).recording,
    'the recording was ABANDONED by the collapse — this is the #1574 regression',
  ).toBe(true);

  // ...and it must still be GROWING, not merely present. A surviving entry with a dead
  // pump is the half-fix; only accumulation distinguishes them.
  const after = await waitForElapsedPast(page, 'rec', atCollapse + 0.4, 25_000);
  expect(
    after.ok,
    `recording did not advance while collapsed (frozen pump). atCollapse=${atCollapse.toFixed(3)}s ` +
      `now=${after.elapsed.toFixed(3)}s distinct samples=${after.samples} last=${JSON.stringify(after.seen)} over ${Math.round(after.elapsedMs)}ms`,
  ).toBe(true);

  // Re-expand and stop: the take the user made is finalized, not lost.
  await page.evaluate((id) => (globalThis as unknown as { __openDockFullView(x: string): void }).__openDockFullView(id), 'rec');
  await expect(page.getByTestId('recorderbox-card')).toBeVisible({ timeout: 20_000 });
  // The re-mounted card shows the SAME running take, not a fresh idle one.
  await expect(page.getByTestId('recorderbox-rec-indicator')).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('recorderbox-record').click();
  await expect
    .poll(async () => (await nodeRecording(page, 'rec')).recording, { timeout: 30_000 })
    .toBe(false);
});

test('NEGATIVE CONTROL: deleting the node DOES end its recording', async ({ page }) => {
  // Without this leg the test above would pass just as happily if the registry simply
  // never ended a recording at all — which would be a leak, not a fix. This proves the
  // sweep can still tear down, so "survives collapse" is a real discrimination.
  await page.goto('/rack');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 30_000 });

  if (!(await h264EncodeSupported(page))) {
    const required = !!process.env.E2E_REQUIRE_RECORD;
    // eslint-disable-next-line no-console
    console.log('[#1574] NEGATIVE CONTROL SKIPPED — no real H.264 encoder in this runtime.');
    expect(required, '#1574 negative control did not run, but E2E_REQUIRE_RECORD demanded it').toBe(false);
    test.skip();
    return;
  }

  await spawnPatch(
    page,
    [
      { id: 'src', type: 'acidwarp', domain: 'video' },
      { id: 'rec', type: 'recorderbox', domain: 'video' },
    ],
    // ⚠ #1499: this edge was `{ from: 'src', fromPort: 'video_out', … }` — a
    // shape spawnPatch never accepted (it reads `from.nodeId`/`from.portId` and
    // keys by `e.id`), AND the port ids were wrong (acidwarp's out is 'out',
    // recorderbox's in is 'in'). The acidwarp→recorderbox cable never actually
    // materialized; the recording machinery was being exercised on an unfed
    // input.
    [
      {
        id: 'e-src-rec',
        from: { nodeId: 'src', portId: 'out' },
        to: { nodeId: 'rec', portId: 'in' },
        sourceType: 'video',
        targetType: 'video',
      },
    ],
    { mountTimeout: 40_000 },
  );
  await page.evaluate(() => {
    (globalThis as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker = undefined;
  });
  await page.evaluate((id) => (globalThis as unknown as { __openDockFullView(x: string): void }).__openDockFullView(id), 'rec');
  await expect(page.getByTestId('recorderbox-card')).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('recorderbox-record').click();
  await expect.poll(async () => (await nodeRecording(page, 'rec')).recording, { timeout: 30_000 }).toBe(true);

  // Remove the node from the graph — the ONE event that must end the recording.
  // `__patch` is the same live store spawnPatch writes nodes into, so this is a real
  // graph mutation and Canvas's sweep sees it exactly as it sees a menu/lasso delete.
  await page.evaluate(() => {
    const g = globalThis as unknown as { __patch: { nodes: Record<string, unknown> } };
    delete g.__patch.nodes['rec'];
  });

  await expect
    .poll(async () => (await nodeRecording(page, 'rec')).recording, { timeout: 20_000 })
    .toBe(false);
});

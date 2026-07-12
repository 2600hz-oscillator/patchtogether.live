// e2e/tests/cross-mode-load-guard.spec.ts
//
// CROSS-MODE patch-import guard (owner directive): a patch made in a WORKFLOW
// rack must NOT be importable into a dawless rack, and a dawless patch must NOT
// be importable into a workflow rack — the loader FAILS THE LOAD with a clear
// visible error and leaves the current graph exactly as it was.
//
// Exercised on the /rack scratch canvas (no DB/relay): /rack = dawless,
// /rack?mode=workflow = workflow. Both formats are driven through the real
// dev hooks the buttons call — __persistence.{save,load} (raw JSON envelope)
// and __perfZip.{export,load} (.ptperf zip) — so we test the SHIPPED guard, not
// a test-only path. The non-destructive property is asserted directly: a
// pre-existing node survives, the incoming patch's node never appears, and the
// node count is unchanged.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

const PINNED_IDS = ['pinned-mixmstrs', 'pinned-electraControl', 'pinned-clipplayer'] as const;

/** Wait until the workflow ensure effect has written the pinned trio. */
async function waitForPinnedTrio(page: Page): Promise<void> {
  await page.waitForFunction(
    (ids) => {
      const w = globalThis as unknown as {
        __patch?: { nodes: Record<string, { data?: { pinned?: boolean } } | undefined> };
      };
      if (!w.__patch) return false;
      return ids.every((id) => w.__patch!.nodes[id]?.data?.pinned === true);
    },
    PINNED_IDS as unknown as string[],
    { timeout: 15_000 },
  );
}

/** Boot the engine directly (the export path is engine-agnostic for a
 *  video-less rack, but boot defensively so the hooks are fully live). */
async function bootEngine(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const w = globalThis as unknown as { __ensureEngine?: () => Promise<unknown> };
    return typeof w.__ensureEngine === 'function';
  });
  await page.evaluate(async () => {
    const w = globalThis as unknown as { __ensureEngine: () => Promise<unknown> };
    await w.__ensureEngine();
  });
}

/** Sorted node ids currently in the live graph. */
async function nodeIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const w = globalThis as unknown as { __patch: { nodes: Record<string, unknown> } };
    return Object.keys(w.__patch.nodes).sort();
  });
}

/** Capture BOTH export formats from the current rack: the raw-JSON envelope
 *  (a plain object) and the .ptperf zip bytes (as a number[] so it survives
 *  page navigation via evaluate serialization). */
async function captureExports(page: Page): Promise<{ env: Record<string, unknown>; zip: number[] }> {
  const env = (await page.evaluate(() => {
    const w = globalThis as unknown as { __persistence: { save: () => unknown } };
    return w.__persistence.save() as Record<string, unknown>;
  })) as Record<string, unknown>;
  const zip = await page.evaluate(async () => {
    const w = globalThis as unknown as { __perfZip: { export: () => Promise<Uint8Array> } };
    return Array.from(await w.__perfZip.export());
  });
  return { env, zip };
}

async function importEnvelope(page: Page, env: Record<string, unknown>): Promise<void> {
  await page.evaluate((e) => {
    const w = globalThis as unknown as { __persistence: { load: (env: unknown) => unknown } };
    w.__persistence.load(e);
  }, env);
}

async function importZip(page: Page, zip: number[]): Promise<void> {
  await page.evaluate(async (arr) => {
    const w = globalThis as unknown as { __perfZip: { load: (b: Uint8Array) => Promise<void> } };
    await w.__perfZip.load(new Uint8Array(arr));
  }, zip);
}

test.describe('cross-mode patch-import guard', () => {
  test('a WORKFLOW patch is rejected by a dawless rack (raw JSON + .ptperf); graph unchanged', async ({ page }) => {
    // 1. Author + export from a workflow rack (pinned singletons make it a
    //    workflow patch; the export also stamps mode='workflow').
    await page.goto('/rack?mode=workflow');
    await waitForPinnedTrio(page);
    await bootEngine(page);
    const { env: wfEnv, zip: wfZip } = await captureExports(page);
    expect(wfEnv.mode).toBe('workflow'); // the raw-JSON stamp is present

    // 2. Open a dawless rack holding a known patch.
    await page.goto('/rack');
    await spawnPatch(page, [
      { id: 'keep-vco', type: 'analogVco', position: { x: 120, y: 120 } },
      { id: 'keep-scope', type: 'scope', position: { x: 400, y: 120 } },
    ]);
    const before = await nodeIds(page);
    expect(before).toEqual(['keep-scope', 'keep-vco']);

    // 3a. Raw-JSON import → rejected, visible error names the direction, graph intact.
    await importEnvelope(page, wfEnv);
    await expect(page.getByTestId('load-error')).toBeVisible();
    await expect(page.getByTestId('load-error')).toContainText('WORKFLOW');
    expect(await nodeIds(page)).toEqual(before);
    expect(await nodeIds(page)).not.toContain('pinned-mixmstrs'); // nothing from the workflow patch leaked in

    // 3b. Perf-zip import → same rejection, graph still intact.
    await importZip(page, wfZip);
    await expect(page.getByTestId('load-error')).toContainText('WORKFLOW');
    expect(await nodeIds(page)).toEqual(before);
    expect(await nodeIds(page)).not.toContain('pinned-mixmstrs');
  });

  test('a DAWLESS patch is rejected by a workflow rack (raw JSON + .ptperf); graph unchanged', async ({ page }) => {
    // 1. Author + export from a dawless rack.
    await page.goto('/rack');
    await spawnPatch(page, [{ id: 'dl-vco', type: 'analogVco', position: { x: 120, y: 120 } }]);
    const { env: dlEnv, zip: dlZip } = await captureExports(page);
    expect(dlEnv.mode).toBe('dawless');

    // 2. Open a workflow rack (pinned trio present).
    await page.goto('/rack?mode=workflow');
    await waitForPinnedTrio(page);
    const before = await nodeIds(page);
    expect(before).toContain('pinned-mixmstrs');

    // 3a. Raw-JSON import → rejected, graph intact (pins survive, dawless node never appears).
    await importEnvelope(page, dlEnv);
    await expect(page.getByTestId('load-error')).toBeVisible();
    await expect(page.getByTestId('load-error')).toContainText('dawless');
    expect(await nodeIds(page)).toContain('pinned-mixmstrs');
    expect(await nodeIds(page)).not.toContain('dl-vco');
    expect((await nodeIds(page)).length).toBe(before.length);

    // 3b. Perf-zip import → same rejection, graph still intact.
    await importZip(page, dlZip);
    await expect(page.getByTestId('load-error')).toContainText('dawless');
    expect(await nodeIds(page)).toContain('pinned-mixmstrs');
    expect(await nodeIds(page)).not.toContain('dl-vco');
    expect((await nodeIds(page)).length).toBe(before.length);
  });

  test('same-mode round-trips still load (dawless → dawless, both formats)', async ({ page }) => {
    await page.goto('/rack');
    await spawnPatch(page, [{ id: 'rt-marker', type: 'analogVco', position: { x: 120, y: 120 } }]);
    const { env, zip } = await captureExports(page);

    // Raw JSON: replace the graph, then load the export back → marker returns, no error.
    await spawnPatch(page, [{ id: 'decoy', type: 'scope', position: { x: 120, y: 120 } }]);
    await importEnvelope(page, env);
    await expect(page.locator('.svelte-flow__node[data-id="rt-marker"]')).toBeVisible();
    await expect(page.getByTestId('load-error')).toHaveCount(0);

    // Perf-zip: same round-trip.
    await spawnPatch(page, [{ id: 'decoy2', type: 'scope', position: { x: 120, y: 120 } }]);
    await importZip(page, zip);
    await expect(page.locator('.svelte-flow__node[data-id="rt-marker"]')).toBeVisible();
    await expect(page.getByTestId('load-error')).toHaveCount(0);
  });
});

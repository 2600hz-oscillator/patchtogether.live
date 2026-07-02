// e2e/tests/load-patch.spec.ts
//
// @load — regression test for the "load patch, no audio ~50% of the time" bug.
//
// Bug shape (fix/load-patch-audio-race):
//   The load handler in Canvas.svelte didn't call ensureEngine() before
//   applying the saved Yjs update. If Load was the user's first action in a
//   session, no engine + no reconciler existed; the update was applied but
//   nothing observed it → silence. The fix awaits ensureEngine() (which resumes
//   the AudioContext using the click as the user gesture) AND awaits a
//   synchronous reconciler.reconcile() after load instead of trusting the
//   doc.on('update') microtask scheduler.
//
// The manual Save/Load patch buttons were retired in rack Phase 3; the
// surviving cold-load entry point is the topbar's "Load Perf (.zip)" button,
// whose handler (loadPerformanceZipBytes) keeps the exact same
// ensureEngine()-before-apply + reconcile()-after contract. This spec now
// guards THAT path:
//   1. Generate a portable .ptperf.zip fixture on first run (analogVco →
//      scope → audioOut) and write it to e2e/fixtures/cold-load-patch.ptperf.zip.
//      The fixture comes from the real __perfZip.export() hook — same envelope
//      path the export button uses.
//   2. In a fresh browser context with NO prior user gesture, click
//      "Load Perf (.zip)", hand the fixture to the file picker, wait for the
//      engine to materialize, then read RMS off the scope. Assert RMS > 0.001.
//
// Why this matters: a fresh context with Load as the first gesture is the
// cold-load scenario the two reporting users hit in the wild.

import { test, expect, type Page } from '@playwright/test';
import { readFile, writeFile, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, '..', 'fixtures', 'cold-load-patch.ptperf.zip');

test.describe.configure({ mode: 'serial' }); // serial so fixture-gen happens before consumer

/** Build the fixture .ptperf.zip by booting the app, mutating the patch via the
 * dev globals, and calling __perfZip.export(). Pure setup — does not assert
 * audio. Same boot path the user takes (loaded once per CI run). */
async function generateFixtureIfMissing(page: Page): Promise<void> {
  try {
    await access(FIXTURE_PATH);
    return; // fixture already present
  } catch {
    // fall through to generation
  }
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  await page.waitForFunction(() => {
    const w = globalThis as unknown as { __ensureEngine?: () => Promise<unknown> };
    return typeof w.__ensureEngine === 'function';
  });
  // Ensure modules are registered (the persistence layer needs the registry
  // populated to write moduleSchemas, and to migrate on load).
  await page.evaluate(async () => {
    const w = globalThis as unknown as { __ensureEngine: () => Promise<unknown> };
    await w.__ensureEngine();
  });
  // Build a minimal patch directly through the patch graph globals: VCO sine
  // → Scope ch1 → AudioOut L. The VCO has internal default frequency and a
  // silence-injecting ConstantSource so it produces tone with nothing patched
  // into its inputs — perfect for "load → audio" verification.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, unknown>; edges: Record<string, unknown> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      for (const id of Object.keys(w.__patch.edges)) delete w.__patch.edges[id];
      for (const id of Object.keys(w.__patch.nodes)) delete w.__patch.nodes[id];
      w.__patch.nodes['vco'] = {
        id: 'vco',
        type: 'analogVco',
        domain: 'audio',
        position: { x: 100, y: 100 },
        // Default tune is C4-ish; leave defaults so any change to the VCO's
        // resting frequency doesn't silently break the assertion.
        params: {},
      };
      w.__patch.nodes['scp'] = {
        id: 'scp',
        type: 'scope',
        domain: 'audio',
        position: { x: 400, y: 100 },
        params: { timeMs: 50 },
      };
      w.__patch.nodes['out'] = {
        id: 'out',
        type: 'audioOut',
        domain: 'audio',
        position: { x: 700, y: 100 },
        params: { master: 0.5 },
      };
      w.__patch.edges['e1'] = {
        id: 'e1',
        source: { nodeId: 'vco', portId: 'sine' },
        target: { nodeId: 'scp', portId: 'ch1' },
        sourceType: 'audio',
        targetType: 'audio',
      };
      w.__patch.edges['e2'] = {
        id: 'e2',
        source: { nodeId: 'scp', portId: 'ch1_out' },
        target: { nodeId: 'out', portId: 'L' },
        sourceType: 'audio',
        targetType: 'audio',
      };
    });
  });
  const zipBytes = await page.evaluate(async () => {
    const w = globalThis as unknown as {
      __perfZip: { export: () => Promise<Uint8Array> };
    };
    const bytes = await w.__perfZip.export();
    return Array.from(bytes);
  });
  await writeFile(FIXTURE_PATH, Buffer.from(zipBytes));
}

test('@load cold-load: clicking Load as the first user action produces audio', async ({
  browser,
}, testInfo) => {
  // Step 1: generate the fixture in a throwaway context (does not pollute the
  // real test's "first user action" guarantee).
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await generateFixtureIfMissing(page);
    } finally {
      await ctx.close();
    }
  }

  // Step 2: fresh context, fresh page, NO prior interaction. Load is the
  // first thing the user does. This is the path the reported bug hits.
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    // Wait for the dev globals to be installed (so ensureEngine inside the
    // zip-load handler can resolve when the click handler runs). We do NOT call
    // __ensureEngine ourselves here — that would mask the bug we're guarding.
    await page.waitForFunction(() => {
      const w = globalThis as unknown as { __ensureEngine?: () => Promise<unknown> };
      return typeof w.__ensureEngine === 'function';
    });

    // Click "Load Perf (.zip)" — the click counts as the user gesture, so the
    // AudioContext can resume from inside ensureEngine() inside
    // loadPerformanceZipBytes().
    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Load Perf (.zip)', exact: true }).click();
    const chooser = await fileChooserPromise;
    await chooser.setFiles(FIXTURE_PATH);

    // Engine + reconciler must materialize the loaded nodes — the fix awaits
    // reconciler.reconcile() after the load, so by the time the click handler
    // settles, the DOM should already reflect 3 nodes. Allow some slack for
    // Faust runtime instantiation.
    await expect(page.locator('.svelte-flow__node')).toHaveCount(3, { timeout: 10_000 });

    // Wait for audio to flow. The Faust worklet takes a tick or two to start
    // emitting samples after instantiation.
    let rms = 0;
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      rms = await readScopeRms(page);
      if (rms > 0.001) break;
      await page.waitForTimeout(100);
    }

    expect(
      rms,
      `expected audio after cold load (rms=${rms.toFixed(6)}); ` +
        `bug fix: the zip-load handler must call ensureEngine() before applying ` +
        `the envelope and await reconciler.reconcile() after`
    ).toBeGreaterThan(0.001);

    // No surprise console errors during the load path.
    expect(
      errors.filter((e) => !e.toLowerCase().includes('clerk')),
      errors.join('; ')
    ).toEqual([]);

    // Capture diagnostic on failure for offline analysis.
    if (testInfo.status !== 'passed') {
      await testInfo.attach('rms', { body: String(rms), contentType: 'text/plain' });
    }
  } finally {
    await ctx.close();
  }
});

async function readScopeRms(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const w = globalThis as unknown as {
      __engine?: () => {
        read: (
          node: { id: string; type: string; domain: string },
          key: string
        ) => unknown;
      } | null;
      __patch: {
        nodes: Record<string, { id: string; type: string; domain: string }>;
      };
    };
    const eng = w.__engine?.();
    if (!eng) return 0;
    const node = w.__patch.nodes['scp'];
    if (!node) return 0;
    const snap = eng.read(node, 'snapshot') as
      | { ch1: Float32Array }
      | undefined;
    if (!snap) return 0;
    let energy = 0;
    for (let i = 0; i < snap.ch1.length; i++) {
      energy += snap.ch1[i] * snap.ch1[i];
    }
    return Math.sqrt(energy / snap.ch1.length);
  });
}

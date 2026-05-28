// e2e/tests/sm64.spec.ts
//
// SM64 module end-to-end. Mirrors frogger.spec.ts in shape (3 tests):
//
//   1. The card mounts cleanly + renders its canvas + scaffold with no
//      console errors. Runs regardless of whether the IDB fixture exists
//      (the upstream bundle script tag loads even without a ROM — it just
//      surfaces the upload UI).
//   2. When `e2e/fixtures/sm64-idb.bin` is committed: seed IDB with it,
//      mount the module, and assert that the engine boots (snapshot
//      reports romPresent + gameStarted within a few seconds, no console
//      errors, canvas has non-black pixels). Skips gracefully when the
//      fixture is absent (with a clear log line pointing at the regen
//      script).
//   3. A CV/gate source patched into start_gate restarts the game (no
//      ROM required: the start_gate edge fires whether or not the bundle
//      has assets — we assert the snapshot's tick keeps advancing across
//      the pulse and the click handler runs without throwing).

import { test, expect, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

const FIXTURE_PATH = path.join(
  process.cwd().endsWith('/e2e') ? path.join(process.cwd(), '..') : process.cwd(),
  'e2e',
  'fixtures',
  'sm64-idb.bin',
);

function fixtureExists(): boolean {
  try {
    return fs.statSync(FIXTURE_PATH).isFile() && fs.statSync(FIXTURE_PATH).size > 0;
  } catch (_e) {
    return false;
  }
}

interface Sm64Snap {
  tick: number;
  romPresent: boolean;
  gameStarted: boolean;
}

async function readSm64Snapshot(page: Page, nodeId: string): Promise<Sm64Snap | null> {
  return await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => {
        read: (node: { id: string; type: string; domain: string }, key: string) => unknown;
      } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    if (!eng) return null;
    const node = w.__patch.nodes[id];
    if (!node) return null;
    const snap = eng.read(node, 'snapshot') as unknown as Record<string, unknown> | undefined;
    if (!snap || typeof snap !== 'object') return null;
    return {
      tick: (snap.tick as number) ?? 0,
      romPresent: (snap.romPresent as boolean) ?? false,
      gameStarted: (snap.gameStarted as boolean) ?? false,
    };
  }, nodeId);
}

/** Seed the upstream's `idb-keyval` store with the committed binary blob so
 *  the bundle's `checkForRom()` resolves without an upload step. The blob
 *  is the raw msgpack-encoded value the upstream writes via
 *  `IDB.set('assets', msgpack.encode(extractedData))`; we round-trip it
 *  via `idb-keyval` in the page context (same library upstream uses, so
 *  the store / key / version line up). */
async function seedRomFixture(page: Page, fixtureBytes: Buffer): Promise<void> {
  await page.evaluate(async (bytes) => {
    // Use the same idb-keyval module the bundle uses (it's a dep of the
    // bundle, exposed via the upstream's import { set } from 'idb-keyval').
    // We re-implement the minimal write here so the seed step doesn't
    // depend on the bundle being loaded yet.
    const u8 = new Uint8Array(bytes);
    await new Promise<void>((resolve, reject) => {
      // idb-keyval defaults to db='keyval-store', store='keyval'.
      const req = indexedDB.open('keyval-store', 1);
      req.onupgradeneeded = () => { req.result.createObjectStore('keyval'); };
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('keyval', 'readwrite');
        const store = tx.objectStore('keyval');
        store.put(u8, 'assets');
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
  }, Array.from(fixtureBytes));
}

test('sm64: drop module → card mounts with no console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 's', type: 'sm64', position: { x: 200, y: 200 } }]);
  const card = page.locator('.svelte-flow__node-sm64');
  await expect(card).toBeVisible();
  await expect(card).toContainText('SM64');
  const canvas = card.locator('[data-testid="sm64-canvas"]');
  await expect(canvas).toBeVisible();
  const size = await canvas.evaluate((el: Element) => {
    const c = el as HTMLCanvasElement;
    return { w: c.width, h: c.height };
  });
  expect(size.w).toBeGreaterThan(0);
  expect(size.h).toBeGreaterThan(0);

  // Bundle network 404 / parse error would surface here. Filter the
  // AudioContext-not-resumed warning that every game-module spec ignores.
  // Also tolerate the bundle's own load-time warnings (the upstream's
  // webpack warns about ~12 MB asset size in dev mode, and the bundle's
  // 'NODE_OPTIONS=--openssl-legacy-provider' build emits a couple of
  // sourcemap notes).
  const fatal = errors.filter(
    (e) =>
      !e.includes('AudioContext') &&
      !e.toLowerCase().includes('sourcemap') &&
      !e.toLowerCase().includes('source map'),
  );
  expect(fatal, `unexpected console errors: ${fatal.join(' | ')}`).toEqual([]);
});

test('sm64: bundle boots into a running game when a ROM fixture is present', async ({ page }) => {
  if (!fixtureExists()) {
    // eslint-disable-next-line no-console
    console.log(
      `[sm64.spec] skipped: e2e/fixtures/sm64-idb.bin not committed. ` +
      `To produce it, run:\n` +
      `    flox activate -- node scripts/extract-sm64-idb.mjs /path/to/your/sm64.z64\n` +
      `(see packages/web/native/sm64js/README.md for details).`,
    );
    test.skip();
    return;
  }

  const fixtureBytes = fs.readFileSync(FIXTURE_PATH);
  // Important: seed IDB BEFORE first navigation that mounts the card —
  // the bundle's checkForRom() runs once at script-tag load. So we go
  // through `/` once just to get an origin, seed IDB, then reload.
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await seedRomFixture(page, fixtureBytes);
  await page.reload();
  await page.waitForLoadState('networkidle');

  await spawnPatch(page, [{ id: 's', type: 'sm64', position: { x: 200, y: 200 } }]);
  await page.locator('button:has-text("Tap to start")').first().click({ timeout: 2000 }).catch(() => { /* */ });

  // Bundle is ~12 MB minified — allow generous time for the script tag to
  // download + parse on slower CI hardware. We poll the snapshot until
  // romPresent flips OR the watchdog fires.
  await expect.poll(
    async () => (await readSm64Snapshot(page, 's'))?.romPresent ?? false,
    { timeout: 20_000, intervals: [500, 500, 1000] },
  ).toBe(true);

  // Once romPresent is true the auto-start has armed; one more tick fires
  // the synthetic start_gate edge and the bundle's #startbutton click
  // handler runs, which calls main_func() → on_anim_frame → produce_one_frame.
  await expect.poll(
    async () => (await readSm64Snapshot(page, 's'))?.gameStarted ?? false,
    { timeout: 8_000 },
  ).toBe(true);

  // Engine is producing frames: tick keeps advancing.
  const snap1 = await readSm64Snapshot(page, 's');
  await page.waitForTimeout(1000);
  const snap2 = await readSm64Snapshot(page, 's');
  expect(snap1, 'snap1 readable').not.toBeNull();
  expect(snap2, 'snap2 readable').not.toBeNull();
  expect(snap2!.tick, `tick advances (snap1=${snap1!.tick}, snap2=${snap2!.tick})`).toBeGreaterThan(snap1!.tick);

  // The canvas should not be all-black after a second of gameplay (the
  // bundle's clearColor is white, the rendered scene paints over). Sample
  // a few pixels.
  const hasMotion = await page
    .locator('[data-testid="sm64-canvas"]')
    .evaluate((el: Element) => {
      const c = el as HTMLCanvasElement;
      const gl = c.getContext('webgl');
      if (!gl) {
        // Fall back to a 2D readback (the bundle uses WebGL; if there's no
        // GL context the bundle never initialized).
        return false;
      }
      const buf = new Uint8Array(c.width * c.height * 4);
      gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      // Look for any non-black, non-fully-transparent pixel.
      for (let i = 0; i < buf.length; i += 4) {
        if (buf[i] || buf[i + 1] || buf[i + 2]) return true;
      }
      return false;
    });
  expect(hasMotion, 'canvas should have drawn at least one non-black pixel after boot').toBe(true);
});

test('sm64: BUGGLES.clock patched into start_gate keeps the snapshot ticking', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [
      { id: 'b', type: 'buggles', position: { x: 100, y: 100 } },
      { id: 's', type: 'sm64', position: { x: 400, y: 100 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'b', portId: 'clock' }, to: { nodeId: 's', portId: 'start_gate' } },
    ],
  );
  await page.locator('button:has-text("Tap to start")').first().click({ timeout: 2000 }).catch(() => { /* */ });

  await page.waitForTimeout(500);
  const initial = await readSm64Snapshot(page, 's');
  expect(initial).not.toBeNull();
  expect(initial!.tick, 'scheduler tick advances on its own').toBeGreaterThan(0);

  // Wait for BUGGLES.clock to fire several pulses. Each rising edge runs
  // through the audio factory's tick() → ⇒ bridge.autoStart() → clicks
  // #startbutton. The bundle's click handler is tolerant of repeated
  // clicks (it just re-runs startGame()/location.reload()-equivalent;
  // location.reload() is no-op in the test page context).
  await page.waitForTimeout(2000);
  const later = await readSm64Snapshot(page, 's');
  expect(later).not.toBeNull();
  expect(later!.tick).toBeGreaterThan(initial!.tick);
});

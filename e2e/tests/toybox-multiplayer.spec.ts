import { test, expect, type Page } from '@playwright/test';
import { spawnPatch, openToyboxDock } from './_helpers';
import { registerToyboxFixtures, seedPatch, fadeGraph, OFF, expectPixel } from './_toybox-fixture-helpers';
import { FIX_FLAT, FLAT_TOLERANCE, type Rgb01 } from '../_fixtures/toybox-fixture-shaders';

type Peer = {
  __attachProvider: (id: string) => Promise<unknown>;
  __ensureEngine: () => Promise<unknown>;
  __provider: { connect(): void; disconnect(): void };
  __ydoc: { transact(fn: () => void): void };
  __patch: { nodes: Record<string, { data: { layers: Array<{ params: Record<string, number> }> } }> };
};

async function connect(page: Page, room: string) {
  await page.goto('/rack?seed=none');
  await page.waitForFunction(() => typeof (window as unknown as Peer).__attachProvider === 'function');
  await page.evaluate(async room => {
    const w = window as unknown as Peer;
    await w.__attachProvider(room);
    await w.__ensureEngine();
  }, room);
}
async function editLayer(page: Page, layer: number, rgb: Rgb01) {
  await page.evaluate(({ layer, rgb }) => {
    const w = window as unknown as Peer;
    w.__ydoc.transact(() => {
      const params = w.__patch.nodes.tb!.data.layers[layer]!.params;
      params.fr = rgb[0]; params.fg = rgb[1]; params.fb = rgb[2];
    });
  }, { layer, rgb });
}
const flat = ([fr, fg, fb]: Rgb01) => ({ kind: 'gen', contentId: FIX_FLAT.id, params: { fr, fg, fb } });

test('@collab @multiplayer-critical multilayer output survives concurrent edits, offline reconnect, and a fresh peer', async ({ browser }) => {
  test.setTimeout(90_000);
  const room = 'layers-' + crypto.randomUUID();
  const contexts = [await browser.newContext(), await browser.newContext()];
  try {
    const pages = await Promise.all(contexts.map(c => c.newPage()));
    const [a, b] = pages as [Page, Page];
    await Promise.all(pages.map(p => connect(p, room)));
    await spawnPatch(a, [{ id: 'tb', type: 'toybox', domain: 'video', position: { x: 420, y: 40 } }]);
    for (const p of pages) {
      await p.waitForFunction(() => !!(window as unknown as Peer).__patch.nodes.tb);
      await openToyboxDock(p);
      await registerToyboxFixtures(p);
    }
    const pixels = (rgb: Rgb01, label: string) => Promise.all(pages.map(p =>
      expectPixel(p, 0.5, 0.5, rgb, FLAT_TOLERANCE, label)));
    await seedPatch(a, [flat([1, 0, 0]), flat([0, 1, 0]), OFF, OFF], fadeGraph(0.5));
    await pixels([0.5, 0.5, 0], 'initial composite');
    await Promise.all([editLayer(a, 0, [0, 0, 1]), editLayer(b, 1, [1, 1, 1])]);
    await pixels([0.5, 0.5, 1], 'both independent layer edits survive');
    await b.evaluate(() => (window as unknown as Peer).__provider.disconnect());
    await Promise.all([editLayer(a, 0, [1, 0, 0]), editLayer(b, 1, [0, 0, 1])]);
    await b.evaluate(() => (window as unknown as Peer).__provider.connect());
    await pixels([0.5, 0, 0.5], 'offline edits merge on reconnect');
    // A new document must reconstruct the same composite, not retain an old renderer.
    await b.reload();
    await b.waitForFunction(() => typeof (window as unknown as Peer).__attachProvider === 'function');
    // Fixture content must exist before the restored module compiles it, just
    // as shipped content is registered before a real rack loads.
    await registerToyboxFixtures(b);
    await b.evaluate(async room => {
      const w = window as unknown as Peer;
      await w.__attachProvider(room); await w.__ensureEngine();
    }, room);
    await b.waitForFunction(() => !!(window as unknown as Peer).__patch.nodes.tb);
    await openToyboxDock(b);
    await expectPixel(b, 0.5, 0.5, [0.5, 0, 0.5], FLAT_TOLERANCE, 'fresh peer composite');
    expect(await b.evaluate(() => (window as unknown as Peer).__patch.nodes.tb!.data.layers.length)).toBe(4);
  } finally { await Promise.all(contexts.map(c => c.close())); }
});

// e2e/tests/load-example-dropdown.spec.ts
//
// E2E for the consolidated "Load example…" topbar dropdown. It replaced the
// standalone "moogafakkin System 55", "moogafakkin System 35", "Load
// example", "GLITCHES GET RICHES", and "Media Burn" buttons with a single
// <select> action-menu.
//
// This is the adversarial gate: for EACH of the 5 options we select it and
// assert the patch ACTUALLY loaded (not merely that the option exists):
//   - Sequenced VCO  → the default voice demo (sequencer→VCO→ADSR→VCA→out;
//                       5 audio nodes with the well-known vd-* ids).
//   - System 55      → 27 non-overlapping moog* cabinet cards.
//   - System 35      → 17 non-overlapping moog* cabinet cards.
//   - Media Burn     → 15 PICTUREBOX tiles + 1 CADILLAC.
//   - Glitches Get Riches → >5 nodes incl. a PICTUREBOX carrying imageBytes.
//
// It also asserts the dropdown is an ACTION menu: after a selection the
// bound value resets to the placeholder, so the same example re-loads.
//
// Consolidates the retired cabinet-spawn.spec.ts, glitches-button.spec.ts,
// and media-burn-button.spec.ts.

import { test, expect, type Page } from '@playwright/test';

test.describe.configure({ mode: 'parallel' });

interface NodePos { x: number; y: number }
interface PatchNode { id: string; type: string; position: NodePos }

async function ready(page: Page) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  // Generous timeout: a cold dev server compiles the canvas route + the
  // large bundled example envelopes on-demand on the first hit of a worker.
  await page.waitForFunction(() => {
    const w = window as unknown as { __patch?: unknown; __flow?: unknown };
    return !!w.__patch && !!w.__flow;
  }, undefined, { timeout: 30_000 });
}

async function readNodes(page: Page): Promise<PatchNode[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __patch: { nodes: Record<string, PatchNode> } };
    return Object.values(w.__patch.nodes).filter(Boolean) as PatchNode[];
  });
}

async function readMoogNodes(page: Page): Promise<PatchNode[]> {
  return (await readNodes(page)).filter((n) => n.type.startsWith('moog'));
}

async function getInternalSize(page: Page, id: string): Promise<{ w: number; h: number }> {
  return page.evaluate((nid) => {
    const w = window as unknown as {
      __flow: { getInternalNode: (id: string) => { measured?: { width?: number; height?: number } } | undefined };
    };
    const internal = w.__flow.getInternalNode(nid);
    return { w: internal?.measured?.width ?? 240, h: internal?.measured?.height ?? 200 };
  }, id);
}

function rectsOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  const xOverlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const yOverlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return xOverlap > 0.5 && yOverlap > 0.5;
}

async function assertNoOverlaps(page: Page, nodes: PatchNode[]) {
  const sizes = await Promise.all(nodes.map((n) => getInternalSize(page, n.id)));
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const ri = { x: nodes[i].position.x, y: nodes[i].position.y, w: sizes[i].w, h: sizes[i].h };
      const rj = { x: nodes[j].position.x, y: nodes[j].position.y, w: sizes[j].w, h: sizes[j].h };
      expect(rectsOverlap(ri, rj), `cards ${nodes[i].id} and ${nodes[j].id} overlap`).toBe(false);
    }
  }
}

test('dropdown exposes exactly the 5 examples + the placeholder, and the old standalone buttons are gone', async ({ page }) => {
  await ready(page);
  const select = page.getByTestId('load-example-select');
  await expect(select).toHaveCount(1);

  // Option labels (placeholder + 5 examples, in order).
  const labels = await select.locator('option').allTextContents();
  expect(labels).toEqual([
    'Load example…',
    'Sequenced VCO',
    'System 55',
    'System 35',
    'Media Burn',
    'Glitches Get Riches',
  ]);

  // The retired standalone buttons must no longer be present.
  await expect(page.getByTestId('moog-system-55-btn')).toHaveCount(0);
  await expect(page.getByTestId('moog-system-35-btn')).toHaveCount(0);
  await expect(page.getByTestId('load-glitches-btn')).toHaveCount(0);
  await expect(page.getByTestId('load-media-burn-btn')).toHaveCount(0);

  // The "System ..." labels intentionally DROP the "moogafakkin" prefix.
  expect(labels.some((l) => /moogafakkin/i.test(l))).toBe(false);
});

test('Sequenced VCO option loads the default voice-demo patch + resets the dropdown', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await ready(page);
  const select = page.getByTestId('load-example-select');
  expect((await readNodes(page)).filter((n) => n.id.startsWith('vd-')).length).toBe(0);

  await select.selectOption('sequenced-vco');

  // The voice demo loads 5 well-known audio nodes (sequencer→VCO→ADSR→VCA→out).
  await expect
    .poll(async () => (await readNodes(page)).filter((n) => n.id.startsWith('vd-')).length)
    .toBe(5);
  const vd = (await readNodes(page)).filter((n) => n.id.startsWith('vd-'));
  const types = vd.map((n) => n.type).sort();
  expect(types).toEqual(['adsr', 'analogVco', 'audioOut', 'sequencer', 'vca']);

  // Action menu: value resets to the placeholder so it can be re-loaded.
  await expect.poll(async () => select.inputValue()).toBe('');

  expect(errors).toEqual([]);
});

test('System 55 option spawns 27 non-overlapping cabinet modules', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await ready(page);
  await page.getByTestId('load-example-select').selectOption('system-55');

  await expect(page.locator('.svelte-flow__node[data-id^="moog"]')).toHaveCount(27);
  await expect.poll(async () => (await readMoogNodes(page)).length).toBe(27);

  await page.waitForTimeout(300);
  await assertNoOverlaps(page, await readMoogNodes(page));
  expect(errors).toEqual([]);
});

test('System 35 option spawns 17 non-overlapping cabinet modules', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await ready(page);
  await page.getByTestId('load-example-select').selectOption('system-35');

  await expect(page.locator('.svelte-flow__node[data-id^="moog"]')).toHaveCount(17);
  await expect.poll(async () => (await readMoogNodes(page)).length).toBe(17);

  await page.waitForTimeout(300);
  await assertNoOverlaps(page, await readMoogNodes(page));
  expect(errors).toEqual([]);
});

test('Media Burn option loads 15 PICTUREBOX tiles + 1 CADILLAC', async ({ page }) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });

  await ready(page);
  expect((await readNodes(page)).filter((n) => n.type === 'picturebox' || n.type === 'cadillac').length).toBe(0);

  await page.getByTestId('load-example-select').selectOption('media-burn');

  await expect
    .poll(async () => (await readNodes(page)).filter((n) => n.type === 'picturebox').length, { timeout: 15_000 })
    .toBe(15);
  expect((await readNodes(page)).filter((n) => n.type === 'cadillac').length).toBe(1);

  // The CADILLAC sprite renders via the existing overlay.
  await expect(page.locator('[data-testid="cadillac-car"]')).toHaveCount(1);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('Glitches Get Riches option loads the demo patch with a PICTUREBOX carrying image bytes', async ({ page }) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });

  await ready(page);
  await page.getByTestId('load-example-select').selectOption('glitches');

  await expect
    .poll(async () => (await readNodes(page)).length, {
      message: 'patch nodes loaded from GLITCHES envelope',
      timeout: 15_000,
    })
    .toBeGreaterThan(5);

  // The bundled glitch.jpg landed as imageBytes on a PICTUREBOX node.
  const pictureboxInfo = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { id: string; type: string; data?: { imageBytes?: string | null; imageMime?: string } }> };
    };
    return Object.values(w.__patch.nodes)
      .filter((n) => n.type === 'picturebox')
      .map((n) => ({
        imageBytesLen: typeof n.data?.imageBytes === 'string' ? n.data.imageBytes.length : 0,
        imageMime: n.data?.imageMime ?? null,
      }));
  });
  expect(pictureboxInfo.length, 'envelope has a PICTUREBOX node').toBeGreaterThan(0);
  expect(pictureboxInfo[0].imageBytesLen, 'PICTUREBOX carries image bytes').toBeGreaterThan(1000);
  expect(pictureboxInfo[0].imageMime).toBe('image/jpeg');

  expect(errors, errors.join('\n')).toEqual([]);
});

// e2e/tests/cloudseed-face.spec.ts
//
// The two things about the CLOUDSEED face that only a live graph can prove.
//
// 1. PRESET RECALL IS A GRAPH EDIT (the LOSS-1 regression). The shipped bug was
//    a state-consistency bug, not a UI downgrade: the dock's `preset_index`
//    write pushed the whole preset into the WORKLET and explicitly left the
//    store alone, so the SOUND changed while the persisted Y.Doc kept the old
//    45 values — and the next knob move, save/reload or peer join silently
//    reverted it. Every def-reading gate stayed green through all of that,
//    which is why the assertion here is on `__patch` and nothing else. The
//    exact VALUES the stamp writes are pinned purely in
//    `cloudseed-preset-actions.test.ts`; this file pins that they reach the
//    graph at all, and that an edit made AFTER a recall survives.
//
// 2. THE DOCK TAB RAIL HIDES, IT DOES NOT UNMOUNT (PF-16). Eight section bands
//    at the measured ~90px band pitch are ~720px of content in a dock pane that
//    tops out around 550px of band room, so cloudseed is the one face that gets
//    a tab rail. The load-bearing property is that the inactive bands stay
//    MOUNTED: faces-parity asserts one control per def param across the whole
//    faceplate with `evaluateAll` (which matches hidden elements), so an
//    `{#if}`-unmounting rail would turn a tabbed face into a face that lost
//    forty controls. That is asserted directly below rather than trusted.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

const NODE = 'cs';
const SLOW_RENDER = process.env.E2E_SWIFTSHADER === '1' || !!process.env.CI;
/** The BOOT wait, not an assertion window. Whichever test runs first pays
 *  SvelteKit's on-demand /rack route compile — measured at >15 s on a cold dev
 *  server here, which failed only the alphabetically-first spec in the file
 *  while the two behind it passed in 45 s combined. Doubled under SLOW_RENDER:
 *  on CI that compile lands on a 4-vCPU runner already software-rasterizing
 *  three other workers' racks. It still fails hard if the topbar never mounts. */
const BOOT_MS = SLOW_RENDER ? 60_000 : 30_000;

/** Every param this node currently carries in the GRAPH. */
function graphParams(page: Page): Promise<Record<string, number>> {
  return page.evaluate((id) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { params?: Record<string, number> } | undefined> };
    };
    return { ...(w.__patch.nodes[id]?.params ?? {}) };
  }, NODE);
}

/** The def's declared param ids, off the live registry (never re-typed here). */
function defParamIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const w = globalThis as unknown as { __moduleSpecs?: { type: string; params: { id: string }[] }[] };
    return (w.__moduleSpecs?.find((s) => s.type === 'cloudseed')?.params ?? []).map((p) => p.id);
  });
}

async function openCloudseedDock(page: Page) {
  await page.goto('/rack?shell=legacy');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: BOOT_MS });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
  await spawnPatch(page, [{ id: NODE, type: 'cloudseed', position: { x: 460, y: 240 } }]);

  const shell = page.locator(`.svelte-flow__node[data-id="${NODE}"] [data-testid="module-shell"]`);
  await expect(shell).toBeVisible();
  await shell.getByTestId('shell-open-dock').click();
  const faceplate = page.getByTestId('dock-full-view');
  await expect(faceplate).toBeVisible();
  const dockShell = faceplate.locator('[data-testid="module-shell"][data-shell-tier="dock"]');
  await expect(dockShell).toBeVisible();
  return { faceplate, dockShell };
}

/** Pick a named PRESET segment in the dock and wait for the graph to settle on
 *  it (the write is storm-guarded, so it lands one settle window later). */
async function recallPreset(page: Page, dockShell: ReturnType<Page['locator']>, label: string) {
  const group = dockShell.locator('[data-testid="control-preset_index"]');
  await expect(group, 'PRESET renders as a real named-state row').toHaveAttribute(
    'role',
    'radiogroup',
  );
  const seg = group.locator('[role="radio"]', { hasText: label });
  await seg.scrollIntoViewIfNeeded();
  await seg.click();
  await expect(seg, `'${label}' lights up`).toHaveAttribute('aria-checked', 'true');
}

test.describe('cloudseed: preset recall is a GRAPH edit, not a hidden worklet push', () => {
  test('recalling a preset writes ALL 46 params into the graph, and a later knob edit survives', async ({
    page,
  }) => {
    test.setTimeout(SLOW_RENDER ? 90_000 : 60_000);
    const { dockShell } = await openCloudseedDock(page);

    // The spawn helper writes NO params, so "the recall wrote the surface" is
    // unambiguous: before, the node carries nothing at all.
    expect(Object.keys(await graphParams(page)), 'a fresh spawn carries no params').toEqual([]);

    // ── (i) recall SHORT ROOM ────────────────────────────────────────────
    await recallPreset(page, dockShell, 'short room');
    await expect
      .poll(async () => (await graphParams(page)).preset_index, {
        message: 'the active slot lands in the graph',
      })
      .toBe(1);

    // ── (iv) the WHOLE control surface landed, not just the index ────────
    // THE regression. The broken path wrote zero keys (worklet only); an
    // index-only write would have written exactly one.
    const ids = await defParamIds(page);
    expect(ids.length, 'the live def declares 46 params').toBe(46);
    const afterRecall = await graphParams(page);
    expect(
      Object.keys(afterRecall).sort(),
      'preset recall stamps every declared param into the graph',
    ).toEqual([...ids].sort());

    // ── (ii) edit ONE knob, through the real dock control ────────────────
    const decay = dockShell.locator('[data-testid="control-late_line_decay"]');
    await decay.scrollIntoViewIfNeeded();
    const box = (await decay.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx, cy - 60, { steps: 8 });
    await page.mouse.up();
    await expect
      .poll(async () => (await graphParams(page)).late_line_decay, {
        message: 'dragging DECAY commits into the graph',
      })
      .not.toBe(afterRecall.late_line_decay);
    const edited = (await graphParams(page)).late_line_decay;

    // ── (iii) the edit SURVIVES, and it did not drag the recall back ─────
    // The old failure mode: the store still held the pre-recall values, so the
    // first edit after a recall re-asserted them and the space snapped back.
    await page.waitForTimeout(600);
    const settled = await graphParams(page);
    expect(settled.late_line_decay, 'the DECAY edit is still there').toBe(edited);
    expect(settled.preset_index, 'the recall was not reverted').toBe(1);
    for (const id of ids) {
      if (id === 'late_line_decay') continue;
      expect(settled[id], `${id} still carries its recalled value`).toBe(afterRecall[id]);
    }

    // ── a DIFFERENT preset genuinely moves the surface ───────────────────
    // Without this, every clause above would pass on a recall that always
    // stamped the same values (a stamp that is a no-op looks identical to a
    // stamp that works, from the key set alone).
    await recallPreset(page, dockShell, 'infinite pad');
    await expect
      .poll(async () => (await graphParams(page)).preset_index)
      .toBe(3);
    const pad = await graphParams(page);
    const moved = ids.filter((id) => pad[id] !== settled[id]);
    expect(
      moved.length,
      `INFINITE PAD differs from SHORT ROOM in many params (moved: ${moved.join(', ')})`,
    ).toBeGreaterThan(5);
  });
});

test.describe('cloudseed: the dock tab rail (PF-16)', () => {
  test('eight tabs; the inactive bands are HIDDEN, never unmounted', async ({ page }) => {
    test.setTimeout(SLOW_RENDER ? 90_000 : 60_000);
    const { faceplate, dockShell } = await openCloudseedDock(page);

    const bands = dockShell.locator('[data-testid="face-page"]');
    await expect(bands, 'all eight section bands are MOUNTED').toHaveCount(8);
    await expect(faceplate.locator('[data-testid="faceplate-tabrail"] [role="tab"]')).toHaveCount(8);

    // Exactly one band is on screen — that is what the rail bought.
    expect(
      await dockShell.locator('[data-testid="face-page"]:visible').count(),
      'one band showing at a time',
    ).toBe(1);

    // THE PROPERTY faces-parity depends on: the control surface is all there,
    // whatever tab is up. An `{#if}`-unmounting rail would read 6 here.
    const controlsOnFirstTab = await dockShell.locator('[data-testid^="control-"]').count();
    expect(controlsOnFirstTab, 'every def param still has its cell in the DOM').toBe(46);

    // Front-of-face by default: the blend band, not an alphabetical accident.
    await expect(dockShell.locator('[data-testid="control-late_out"]')).toBeVisible();
    await expect(dockShell.locator('[data-testid="control-eq_cutoff"]')).toBeHidden();

    // Switching tabs swaps WHICH band shows, and nothing else.
    await faceplate.getByTestId('faceplate-tab-eq').click();
    await expect(dockShell.locator('[data-testid="control-eq_cutoff"]')).toBeVisible();
    await expect(dockShell.locator('[data-testid="control-late_out"]')).toBeHidden();
    expect(
      await dockShell.locator('[data-testid^="control-"]').count(),
      'the control count is tab-invariant (hidden, not unmounted)',
    ).toBe(controlsOnFirstTab);
    expect(await dockShell.locator('[data-testid="face-page"]:visible').count()).toBe(1);
  });

  test('CLEAR TAIL is a real action, and the OSS credit survives the migration', async ({ page }) => {
    test.setTimeout(SLOW_RENDER ? 90_000 : 60_000);
    const { dockShell } = await openCloudseedDock(page);

    // LOSS 5 — a gesture the module could always perform and never offered:
    // the worklet has handled `clearBuffers` since it shipped.
    const clear = dockShell.locator('[data-cell-key="cloudseed-clear-{n}"]');
    await expect(clear, 'the CLEAR TAIL cell renders on the first band').toBeVisible();
    await expect(clear, 'it is an ACTION cell, not an inert label').toHaveAttribute(
      'data-cell-control',
      'action',
    );
    await expect(clear.locator('button')).toBeEnabled();

    // LOSS 4 (PF-17) — the legacy card credited Ghost Note Audio; the migrated
    // shell dropped the line. Licence attribution is not decoration.
    await expect(
      dockShell.getByTestId('oss-attribution'),
      'the dock faceplate credits the upstream OSS author',
    ).toContainText('Ghost Note Audio');
  });
});

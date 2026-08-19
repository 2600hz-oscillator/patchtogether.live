// e2e/tests/dx7-operator-panel.spec.ts
//
// The DX7 OPERATOR VIEW — dx7 PR 6's deliverable.
//
// The pure models are pinned without a browser (dx7-op-map-model.test.ts, all
// 32 algorithms + a negative control) and the rendered pixels are pinned by the
// dock VRT baseline. What NEITHER can see is whether the panel's writes reach
// the graph — a map whose mute dot does nothing, or a STORE that never appends,
// renders identically to a working one.
//
// So every assertion below reads `__patch` (the real graph) rather than the
// DOM, except where the point IS the DOM (selection following a click).

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';

// Per-test budget scaled on CI (#1904). `dx7 op detail: STORE appends a named
// patch, REVERT clears the dirty state` recovered a `timedOut -> passed` flake
// on the same SHA against the flat 30 s default — on the run that took `main`
// red on 2026-08-19. A bound, not an assertion: see ../_helpers/boot-budget.ts.
test.describe.configure({ mode: 'parallel', timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

async function bootDx7Dock(page: Page): Promise<string> {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  await page.waitForFunction(() => {
    const w = globalThis as unknown as { __setSpawnFlowPos?: unknown; __spawnFromPalette?: unknown };
    return typeof w.__setSpawnFlowPos === 'function' && typeof w.__spawnFromPalette === 'function';
  });
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __setSpawnFlowPos: (p: { x: number; y: number }) => void;
      __spawnFromPalette: (t: string) => void;
    };
    // Inside lane 1's PAINTED band: the drop hit-test is 2-D, so the anchor
    // needs a Y in `[laneTopY, COLUMN_BASELINE_Y=4320)`, not just an X in the
    // column. 4280 is in-band at every lane height.
    w.__setSpawnFlowPos({ x: 30, y: 4280 });
    w.__spawnFromPalette('dx7');
  });
  await page.waitForFunction(() => {
    const w = globalThis as unknown as {
      __patch?: { nodes: Record<string, { data?: { columns?: Record<string, string[]> } } | undefined> };
    };
    return (w.__patch?.nodes['pinned-mixmstrs']?.data?.columns?.['1'] ?? []).length === 1;
  });
  const memberId = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: { columns?: Record<string, string[]> } } | undefined> };
    };
    return (w.__patch.nodes['pinned-mixmstrs']?.data?.columns?.['1'] ?? [])[0] ?? '';
  });

  // The panels are DOCK-ONLY by the face-lint rule, so the lane tile can never
  // show them — frame at the 'full' tier, then open the dock.
  await page.evaluate(
    ({ memberId, zoom }) => {
      const w = globalThis as unknown as {
        __flow: {
          getInternalNode: (id: string) => {
            internals?: { positionAbsolute?: { x: number; y: number } };
            position?: { x: number; y: number };
            measured?: { width?: number; height?: number };
          } | undefined;
          setViewport: (vp: { x: number; y: number; zoom: number }, o?: { duration?: number }) => void;
        };
      };
      const inode = w.__flow.getInternalNode(memberId);
      const x = inode?.internals?.positionAbsolute?.x ?? inode?.position?.x ?? 0;
      const y = inode?.internals?.positionAbsolute?.y ?? inode?.position?.y ?? 0;
      const cx = x + (inode?.measured?.width ?? 192) / 2;
      const cy = y + (inode?.measured?.height ?? 180) / 2;
      const pane = document.querySelector('.svelte-flow') as HTMLElement;
      const r = pane.getBoundingClientRect();
      w.__flow.setViewport({ x: r.width / 2 - cx * zoom, y: r.height / 2 - cy * zoom, zoom }, { duration: 0 });
    },
    { memberId, zoom: 0.7 },
  );
  await page.waitForFunction(
    (id) => {
      const el = document.querySelector(`.svelte-flow__node[data-id="${id}"] [data-testid="module-shell"]`);
      return !!el && el.getAttribute('data-shell-tier') === 'full';
    },
    memberId,
    { timeout: 15_000 },
  );
  await page
    .locator(`.svelte-flow__node[data-id="${memberId}"] [data-testid="module-shell"]`)
    .getByTestId('shell-open-dock')
    .click();
  await expect(page.getByTestId('dock-full-view')).toBeVisible();
  return memberId;
}

/** Read the live dx7 node out of the real graph. */
async function readDx7(page: Page) {
  return await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: {
        nodes: Record<string, {
          type: string;
          params?: Record<string, number>;
          data?: { opOn?: boolean[]; voiceRev?: number; userPatches?: { name?: string }[]; preset?: string;
                   voice?: { operators?: { level?: number; r?: number[]; l?: number[] }[] } };
        }>;
      };
    };
    const n = Object.values(w.__patch.nodes).find((x) => x?.type === 'dx7');
    return {
      opOn: n?.data?.opOn ?? null,
      voiceRev: n?.data?.voiceRev ?? 0,
      userPatches: (n?.data?.userPatches ?? []).map((v) => v?.name ?? ''),
      preset: n?.data?.preset ?? '',
      op0Level: n?.data?.voice?.operators?.[0]?.level ?? null,
    };
  });
}

test('dx7 operator map: renders all six operators plus the carrier rail', async ({ page }) => {
  await bootDx7Dock(page);
  const dock = page.getByTestId('dock-full-view');

  await expect(dock.getByTestId('dx7-operator-map')).toBeVisible({ timeout: 15_000 });
  for (let i = 1; i <= 6; i++) {
    await expect(dock.getByTestId(`dx7-op-tile-${i}`), `op ${i} tile`).toBeVisible();
  }

  // THE CARRIER RAIL is the colour-blind-safe cue for "these reach the output".
  // Role is otherwise only in the stroke colour, so if the rail ever stops
  // rendering the map silently degrades to a colour-only signal.
  const rail = dock.getByTestId('dx7-carrier-rail');
  await expect(rail).toBeAttached();
  const drops = await rail.locator('line').count();
  // 1 horizontal rail + one drop per carrier. Algorithm 5 has three carriers.
  expect(drops, 'rail + one drop per carrier').toBeGreaterThanOrEqual(2);
});

test('dx7 operator map: the ON/OFF dot mutes that operator in the GRAPH', async ({ page }) => {
  await bootDx7Dock(page);
  const dock = page.getByTestId('dock-full-view');
  await expect(dock.getByTestId('dx7-op-tile-2')).toBeVisible({ timeout: 15_000 });

  const before = await readDx7(page);
  await dock.getByTestId('dx7-op-onoff-2').click();

  // Asserts the FLAG changed, not merely that voiceRev advanced — a revision
  // bump alone passes on a dead button that edits nothing.
  await expect
    .poll(async () => (await readDx7(page)).opOn?.[1], { message: 'opOn[1] flips' })
    .toBe(false);

  const after = await readDx7(page);
  expect(after.voiceRev, 'voiceRev advances so the engine re-sends').toBeGreaterThan(
    before.voiceRev,
  );
  // The other five are untouched — a mute must not be a broadcast.
  expect(after.opOn?.filter((v) => v === false).length).toBe(1);
});

test('dx7 operator map: clicking a tile moves the DETAIL panel to that operator', async ({
  page,
}) => {
  await bootDx7Dock(page);
  const dock = page.getByTestId('dock-full-view');
  const detail = dock.getByTestId('dx7-op-detail');
  await expect(detail).toBeVisible({ timeout: 15_000 });
  await expect(detail).toContainText('OP 1');

  await dock.getByTestId('dx7-op-tile-4').click();
  await expect(detail, 'the detail panel follows the map selection').toContainText('OP 4');

  // Selection is per-viewer VIEW state and must NOT be written to the shared
  // node data — a rack-mate's click would otherwise yank this panel.
  const persisted = await page.evaluate(() => {
    const w = globalThis as unknown as { __patch: { nodes: Record<string, { type: string; data?: Record<string, unknown> }> } };
    const n = Object.values(w.__patch.nodes).find((x) => x?.type === 'dx7');
    return JSON.stringify(n?.data ?? {});
  });
  expect(persisted, 'selection must not reach node.data').not.toMatch(/selectedOp|"selected"/);
});

test('dx7 op detail: STORE appends a named patch, REVERT clears the dirty state', async ({
  page,
}) => {
  await bootDx7Dock(page);
  const dock = page.getByTestId('dock-full-view');
  const detail = dock.getByTestId('dx7-op-detail');
  await expect(detail).toBeVisible({ timeout: 15_000 });

  // Make the voice dirty by moving the selected operator's output level.
  await detail.getByTestId('dx7-op-level').fill('42');
  await expect
    .poll(async () => (await readDx7(page)).op0Level, { message: 'level edit reaches the voice' })
    .toBe(42);

  // A blank name is refused rather than silently storing an unnamed voice.
  await detail.getByTestId('dx7-store').click();
  await expect(detail.getByTestId('dx7-store-error')).toBeVisible();
  expect((await readDx7(page)).userPatches).toHaveLength(0);

  await detail.getByTestId('dx7-store-name').fill('MYVOICE');
  await detail.getByTestId('dx7-store').click();
  await expect
    .poll(async () => (await readDx7(page)).userPatches, { message: 'STORE appends the voice' })
    .toContain('MYVOICE');
  // …and selects it, so the edit buffer and the roster agree.
  expect((await readDx7(page)).preset).toBe('MYVOICE');

  // REVERT goes back to the stored voice — level 42 was stored INTO MYVOICE,
  // so reverting now is a no-op on level; the meaningful assertion is that the
  // control is disabled once nothing is dirty.
  await expect(detail.getByTestId('dx7-revert')).toBeDisabled();
});

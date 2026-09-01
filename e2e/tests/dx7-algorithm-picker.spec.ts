// e2e/tests/dx7-algorithm-picker.spec.ts
//
// The DX7 ALGORITHM PICKER — dx7 PR 4's user-facing deliverable, and the one
// part of it no other gate can see.
//
// What the existing gates DO cover: the geometry (dx7-glyph-model.test.ts pins
// all 32 pictures, pure), and the face's rendered pixels (the two
// `face-dx7-*` VRT baselines). What NOTHING covered until this spec is the
// INTERACTION: that the chip opens a 32-entry grid, that each entry draws its
// OWN algorithm rather than 32 copies of the current one, and that picking one
// actually commits the param and re-draws the face glyph.
//
// That gap is the same shape as the card-vs-def divergence in CLAUDE.md: a
// picker rendering 32 identical diagrams, or one wired to the wrong value,
// would pass every unit test and every VRT — the model is right, the pixels
// of the DEFAULT state are right, and no gate ever opens the popover.

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';

// ⚠ THE PER-TEST BUDGET IS A BOUND, AND IT WAS THE FLAT DEFAULT — which is the
// #1875 defect one level up: not a bare `toBeVisible()`, but the 30 s Playwright
// default that `e2e/playwright.config.ts` never overrides. Nothing in this file
// said "30000", so there was nothing to grep for except its absence.
//
// MEASURED, run 33472900654 (PR #2280, e2e shard 4/12). The `redraws the face
// glyph` test recovered `timedOut -> passed` on the SAME SHA:
//
//   attempt 1  33 225 ms  timedOut     ("Test timeout of 30000ms exceeded")
//   attempt 2  31 792 ms  passed       (~30 s of budget — it squeaked past)
//
// ⚠ AND THE TRACE SAYS NO ASSERTION EVER FAILED. The last recorded event of the
// failing attempt is the face-glyph check RESOLVING TRUE:
//
//   after call@389  result {"matches":true,"received":{"s":"22"}}
//
// The glyph redrew. The param committed. The body finished at ~29.9 s against a
// 30.0 s bound and the clock won. This is not a glyph defect and not a race —
// it is a lottery ticket, and #2280 re-pinned `e2e-timings`, which re-binned the
// shards and sat this spec next to `face-screen-render-suite` batches 3/8 and
// 4/8 (337 s and 299 s of continuous WebGL on a 2-core runner).
//
// Reproduced locally to prove the mechanism rather than assume it: this test
// costs 2.1 s on an idle box, 19.6 s at load ~20, and prints CI's exact
// `Test timeout of 30000ms exceeded` at load ~44 — with no assertion error,
// same as CI. The wall time is a function of the runner, not of the subject.
//
// So the budget comes from `boot-budget` (90 s on CI/SwiftShader, 30 s local)
// instead of the invisible default. A bound only costs wall-clock when it is
// EXCEEDED, so this adds exactly zero to a green run; lane cost stays gauged by
// `--global-timeout`, not by this.
test.describe.configure({ mode: 'parallel', timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

/** Boot `?shell=1` and spawn dx7 into lane 1 via the real palette-drop path
 *  (the same seam workflow-shell-faces.spec.ts uses — `paramCells` only
 *  renders through ModuleShell, so the legacy card route cannot exercise it). */
async function bootDx7Shell(page: Page): Promise<string> {
  await page.goto('/rack');
  // ⚠ NO `waitForLoadState('networkidle')` HERE. It is a CORRELATE — "the
  // network went quiet for 500 ms" — standing in for the thing the next line
  // actually needs, which is the spawn hooks being bound. On a dev server whose
  // HMR websocket never closes it is also the wrong shape of wait, and it cost
  // 1.3 s of a 30 s budget on the shard-4 attempt that then timed out. The
  // `waitForFunction` below is the CAUSAL wait on the subject's own state and
  // subsumes it entirely.
  await page.waitForFunction(() => {
    const w = globalThis as unknown as {
      __setSpawnFlowPos?: unknown;
      __spawnFromPalette?: unknown;
    };
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
  return await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: { columns?: Record<string, string[]> } } | undefined> };
    };
    return (w.__patch.nodes['pinned-mixmstrs']?.data?.columns?.['1'] ?? [])[0] ?? '';
  });
}

/** Open the DOCK full view for `memberId`.
 *
 *  The face glyph is TIER-GATED — it does not mount on the default lane tile,
 *  which is why the first version of this spec failed looking for it there.
 *  Same recipe as the dock VRT scene: frame at the 'full' tier so the jack-rail
 *  affordance is clickable, then open the dock. */
async function openDock(page: Page, memberId: string): Promise<void> {
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
      const el = document.querySelector(
        `.svelte-flow__node[data-id="${id}"] [data-testid="module-shell"]`,
      );
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
}

test('dx7 algorithm picker: the chip opens a 32-entry grid of DISTINCT diagrams', async ({
  page,
}) => {
  await bootDx7Shell(page);

  // The chip is the param's one `control-algorithm` element. It must exist
  // BEFORE any click — a missing chip means `face.paramCells` never resolved
  // to the 'grid' cell kind and the param silently fell back to a knob.
  const chip = page.locator('[data-testid="control-algorithm"]').first();
  await expect(chip, 'algorithm renders as a picture-state chip').toBeVisible({ timeout: 15_000 });

  await chip.click();

  // The grid is PORTALED to <body>, so it is addressed page-scoped by
  // `data-grid-param` rather than as a descendant of the card.
  const grid = page.locator('[data-grid-param="algorithm"]');
  await expect(grid, 'the portaled algorithm grid opens').toBeVisible();

  const cells = grid.locator('[role="radio"]');
  await expect(cells, 'the DX7 has exactly 32 algorithms').toHaveCount(32);

  // Every cell draws ITS OWN algorithm. `data-algorithm` is written by
  // Dx7AlgorithmGlyph from the layout it actually rendered, so this catches a
  // picker that passes the CURRENT value to all 32 cells — which would look
  // entirely plausible on screen.
  const drawn = await grid.locator('svg[data-algorithm]').evaluateAll((els) =>
    els.map((el) => Number(el.getAttribute('data-algorithm'))),
  );
  expect(drawn.length, 'every cell renders a diagram').toBe(32);
  expect([...drawn].sort((a, b) => a - b)).toEqual(
    Array.from({ length: 32 }, (_, i) => i + 1),
  );

  // NEGATIVE CONTROL on the RENDER, not just the attribute: the actual drawn
  // geometry must differ between cells. A component that read `data-algorithm`
  // correctly but drew a constant picture would pass the check above.
  const shapes = await grid.locator('svg[data-algorithm]').evaluateAll((els) =>
    els.map((el) =>
      Array.from(el.querySelectorAll('line'))
        .map((l) => `${l.getAttribute('x1')},${l.getAttribute('y1')}>${l.getAttribute('x2')},${l.getAttribute('y2')}`)
        .join(' '),
    ),
  );
  expect(new Set(shapes).size, 'the 32 cells must not all draw the same picture').toBeGreaterThan(20);
});

test('dx7 algorithm picker: choosing a diagram commits the param and redraws the face glyph', async ({
  page,
}) => {
  const memberId = await bootDx7Shell(page);
  await openDock(page, memberId);
  const faceplate = page.getByTestId('dock-full-view');

  // The face glyph starts on the default algorithm (5).
  const faceGlyph = faceplate.locator('svg[data-testid="shell-glyph-algorithm"]').first();
  await expect(faceGlyph).toBeVisible({ timeout: 15_000 });
  await expect(faceGlyph).toHaveAttribute('data-algorithm', '5');

  await faceplate.locator('[data-testid="control-algorithm"]').first().click();
  const grid = page.locator('[data-grid-param="algorithm"]');
  await expect(grid).toBeVisible();

  // Pick 22 — a fan-out algorithm (one modulator feeding several carriers), so
  // its picture is structurally unlike the default's three 2-op stacks.
  await grid.locator('[data-testid="grid-algorithm-22"]').click();

  // The DURABLE param moved. Read the graph, not the DOM, so this cannot pass
  // on a control that merely re-labelled itself.
  await expect
    .poll(
      async () =>
        await page.evaluate(() => {
          const w = globalThis as unknown as {
            __patch: { nodes: Record<string, { type: string; params?: Record<string, number> }> };
          };
          const dx7 = Object.values(w.__patch.nodes).find((n) => n?.type === 'dx7');
          return dx7?.params?.algorithm ?? -1;
        }),
      { message: 'picking a diagram commits `algorithm` to the graph' },
    )
    .toBe(22);

  // …and the FACE followed. This is the half a param-only assertion misses:
  // the glyph is derived state, so it can lag or stay pinned to a stale value.
  await expect(faceGlyph).toHaveAttribute('data-algorithm', '22');
});

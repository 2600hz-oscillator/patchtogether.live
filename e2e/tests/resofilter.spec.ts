// e2e/tests/resofilter.spec.ts
//
// RESOFILTER behavioral e2e: sweeping the `mode` param 0..4 updates the
// visible mode-name label on the card (the headline UX feature — not
// covered by the registry sweeps). The mount/param-roundtrip smoke and
// the param-corner no-crash sweep were deleted as weaker duplicates of
// the per-module-per-port + behavioral sweeps (LoC campaign row 2).

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';
import { setNodeParams } from './_module-coverage-helpers';

test.describe.configure({ mode: 'parallel' });

test('RESOFILTER mode segments follow the param BOTH ways — the def vocabulary on the face (LP → HP → BP → Notch → Allpass)', async ({ page, rack }) => {
  // Was the card's `resofilter-mode-name` long-form label. On the shell the
  // def vocabulary reaches the TILE as the `control-mode` SEGMENTED
  // radiogroup: each segment carries the long-form name as its title and
  // aria-checked tracks the param — the same claim (param → visible state),
  // on the surface users get, plus the reverse direction the card test never
  // had (segment click → param write).
  await spawnPatch(
    page,
    [
      { id: 'a-rf', type: 'resofilter', position: { x: 120, y: 120 }, domain: 'audio' },
    ],
    [],
  );

  const tile = page.locator('.svelte-flow__node[data-id="a-rf"] [data-testid="module-shell"]');
  await expect(tile).toBeVisible();
  // The TILE paints mode as a compact knob (aria-valuetext LP/HP/BP/NT/AP);
  // the LONG-FORM vocabulary the card label spoke lives on the DOCK ladder's
  // segmented radiogroup — drive that one.
  await tile.getByTestId('shell-open-dock').click();
  const dock = page.getByTestId('dock-full-view');
  await expect(dock).toBeVisible();
  const seg = dock.getByTestId('control-mode');
  await expect(seg).toBeVisible();

  const expected = [
    [0, 'Low-pass'],
    [1, 'High-pass'],
    [2, 'Band-pass'],
    [3, 'Notch'],
    [4, 'Allpass'],
  ] as const;

  for (const [mode, name] of expected) {
    await setNodeParams(page, 'a-rf', { mode: mode });
    await expect(seg.locator(`[role="radio"][title="${name}"]`)).toHaveAttribute(
      'aria-checked',
      'true',
    );
  }

  // The reverse direction: a segment CLICK writes the param.
  await seg.locator('[role="radio"][title="Notch"]').click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const w = globalThis as unknown as {
          __patch: { nodes: Record<string, { params?: Record<string, number> }> };
        };
        return Math.round(w.__patch.nodes['a-rf']?.params?.mode ?? 0);
      }),
    )
    .toBe(3);
});

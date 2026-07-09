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

test('RESOFILTER mode-name label updates as mode param changes (LP → HP → BP → Notch → Allpass)', async ({ page, rack }) => {
  await spawnPatch(
    page,
    [
      { id: 'a-rf', type: 'resofilter', position: { x: 120, y: 120 }, domain: 'audio' },
    ],
    [],
  );

  const card = page.locator('.svelte-flow__node-resofilter');
  await expect(card).toHaveCount(1);

  const label = page.locator('[data-testid="resofilter-mode-name"]');
  // mode 0 (default) → "Low-pass"
  await expect(label).toHaveText('Low-pass');

  const expected = [
    [0, 'Low-pass'],
    [1, 'High-pass'],
    [2, 'Band-pass'],
    [3, 'Notch'],
    [4, 'Allpass'],
  ] as const;

  for (const [mode, name] of expected) {
    await setNodeParams(page, 'a-rf', { mode: mode });
    await expect(label).toHaveText(name);
  }
});

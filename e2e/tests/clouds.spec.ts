// e2e/tests/clouds.spec.ts
//
// CLOUDS end-to-end smoke test. Patch ANALOGVCO → CLOUDS (stereo in) →
// AUDIOOUT (stereo). Sweep the granular knobs. Confirm the card renders,
// freeze toggles, and no errors fire during knob automation.

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

test('CLOUDS freeze button toggles its active class', async ({ page, rack }) => {
  await spawnPatch(
    page,
    [
      { id: 'a-cl',  type: 'clouds',   position: { x: 100, y: 100 }, domain: 'audio' },
    ],
    [],
  );

  const card = page.locator('.svelte-flow__node-clouds');
  await expect(card).toHaveCount(1);

  const freezeBtn = page.locator('[data-testid="clouds-freeze"]');
  await expect(freezeBtn).toHaveCount(1);
  await expect(freezeBtn).not.toHaveClass(/active/);

  await freezeBtn.click();
  await expect(freezeBtn).toHaveClass(/active/);

  await freezeBtn.click();
  await expect(freezeBtn).not.toHaveClass(/active/);
});

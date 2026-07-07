// e2e/tests/clipplayer-controls.spec.ts
//
// CLIP PLAYER + TIMELORDE card-control wiring (DOM/state, no audio):
//   - the per-lane MONO toggle (left of each launch row) flips node.data.mono
//     AND makes the note editor replace-on-add in that lane;
//   - TIMELORDE's global TRANSPORT (run) button flips `running` and hides when an
//     external transport (start_in) owns it.
// The pure note-entry math is unit-tested in clip-types.test.ts; this proves the
// card buttons are actually wired to the synced state.

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

type W = {
  __patch: { nodes: Record<string, { type?: string; params?: Record<string, number>; data?: Record<string, unknown> }> };
};

test('clip player: per-lane MONO toggle flips data + replaces-on-add in the editor', async ({ page, rack }) => {
  await spawnPatch(page, [{ id: 'cp', type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio' }]);

  const card = page.locator('.svelte-flow__node-clipplayer');
  await expect(card).toHaveCount(1);

  // Lane 0 starts POLY (button reads "5").
  const mono0 = page.getByTestId('clipplayer-mono-0');
  await expect(mono0).toHaveText('5');
  await expect(mono0).toHaveAttribute('aria-pressed', 'false');

  // Toggle → MONO (button reads "1", flag synced).
  await mono0.click();
  await expect(mono0).toHaveText('1');
  await expect(mono0).toHaveAttribute('aria-pressed', 'true');
  const monoFlag = await page.evaluate(
    () => ((globalThis as unknown as W).__patch.nodes['cp'].data?.mono as boolean[] | undefined)?.[0],
  );
  expect(monoFlag).toBe(true);

  // Open lane-0 slot-0's editor (double-click its launch pad), then place two
  // notes in the SAME column (different rows). Mono → the second REPLACES the
  // first, so that column holds exactly one note.
  await card.locator('[data-clip="0"]').dblclick();
  const roll = page.getByTestId('clipplayer-pianoroll');
  await expect(roll).toBeVisible();
  await roll.locator('[data-step="3"][data-row="5"]').click();
  await roll.locator('[data-step="3"][data-row="2"]').click();

  const col3 = await page.evaluate(() => {
    const clips = (globalThis as unknown as W).__patch.nodes['cp'].data?.clips as
      | Record<string, { steps?: { step: number }[] }>
      | undefined;
    return (clips?.['0']?.steps ?? []).filter((s) => s.step === 3).length;
  });
  expect(col3, 'mono lane: one note per column (replace-on-add)').toBe(1);
});

test('TIMELORDE: the global transport (run) button flips running', async ({ page, rack }) => {
  await spawnPatch(page, [{ id: 'tl', type: 'timelorde', position: { x: 80, y: 80 }, domain: 'audio' }]);

  const run = page.getByTestId('timelorde-run-tl');
  await expect(run).toBeVisible();
  await expect(run).toHaveText('■'); // default running=1 → STOP glyph
  await run.click();
  await expect(run).toHaveText('▶'); // stopped
  const running = await page.evaluate(
    () => (globalThis as unknown as W).__patch.nodes['tl'].params?.running,
  );
  expect(running).toBe(0);
});

test('TIMELORDE: the run button hides when an external transport (start_in) owns it', async ({ page, rack }) => {
  await spawnPatch(
    page,
    [
      { id: 'tl', type: 'timelorde', position: { x: 80, y: 80 }, domain: 'audio' },
      { id: 'mc', type: 'midiclock', position: { x: -260, y: 80 }, domain: 'audio' },
    ],
    [
      { id: 'ext', from: { nodeId: 'mc', portId: 'midistart' }, to: { nodeId: 'tl', portId: 'start_in' },
        sourceType: 'gate', targetType: 'gate' },
    ],
  );
  // MUTE stays (always shown); the global transport steps aside.
  await expect(page.getByTestId('timelorde-run-tl')).toHaveCount(0);
});

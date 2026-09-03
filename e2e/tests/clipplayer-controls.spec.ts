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

// ⏸ FLAKE-PARK #1847 — parked with `test.fixme`; the body and its assertions are UNCHANGED.
// NONDETERMINISM: 1 recovered-on-retry observation(s) across 1 SHA(s) / 1 branch(es) in the
// 96 h CI census to 2026-08-18 — never a hard failure, so every one of those jobs reported SUCCESS.
// LOST WHILE PARKED: that the per-lane MONO toggle both writes node.data.mono and switches the editor to replace-on-add — the button being wired to the synced state at all.
// Re-enable only on a root cause (#1847); "it passes now" is not one.
test.fixme('clip player: per-lane MONO toggle flips data + replaces-on-add in the editor', { annotation: { type: 'fixme', description: 'FLAKE-PARK #1847 — nondeterministic on CI: 1 recovered-on-retry observation in the 96 h census to 2026-08-18; parked until root-caused' } }, async ({ page, rack }) => {
  await spawnPatch(page, [{ id: 'cp', type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio' }]);

  const card = page.locator('.svelte-flow__node:has([data-shell-type="clipplayer"])');
  await expect(card).toHaveCount(1);

  // Lane 0 starts POLY (button reads "∑" — the glyph replaced a stale "5" that
  // named a poly width the cable has not had for a long time; the ARIA label
  // stays as words, since "∑" tells a screen reader nothing).
  const mono0 = page.getByTestId('clipplayer-mono-0');
  await expect(mono0).toHaveText('∑');
  await expect(mono0).toHaveAttribute('aria-pressed', 'false');
  await expect(mono0).toHaveAttribute('aria-label', 'channel 1 poly');

  // Toggle → MONO (button reads "1", flag synced).
  await mono0.click();
  await expect(mono0).toHaveText('1');
  await expect(mono0).toHaveAttribute('aria-pressed', 'true');
  await expect(mono0).toHaveAttribute('aria-label', 'channel 1 mono');
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

// ⏸ FLAKE-PARK #1847 — parked with `test.fixme`; the body and its assertions are UNCHANGED.
// NONDETERMINISM: 1 recovered-on-retry observation(s) across 1 SHA(s) / 1 branch(es) in the
// 96 h CI census to 2026-08-18 — never a hard failure, so every one of those jobs reported SUCCESS.
// LOST WHILE PARKED: that TIMELORDE's global transport button is actually wired to the synced `running` state — the rack's master play/stop.
// Re-enable only on a root cause (#1847); "it passes now" is not one.
test.fixme('TIMELORDE: the global transport (run) button flips running', { annotation: { type: 'fixme', description: 'FLAKE-PARK #1847 — nondeterministic on CI: 1 recovered-on-retry observation in the 96 h census to 2026-08-18; parked until root-caused' } }, async ({ page, rack }) => {
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

// ⏸ FLAKE-PARK #1847 — parked with `test.fixme`; the body and its assertions are UNCHANGED.
// NONDETERMINISM: 1 recovered-on-retry observation(s) across 1 SHA(s) / 1 branch(es) in the
// 96 h CI census to 2026-08-18 — never a hard failure, so every one of those jobs reported SUCCESS.
// LOST WHILE PARKED: the ownership handoff: when an external transport drives start_in, TIMELORDE's own run button hides instead of offering a control that silently does nothing.
// Re-enable only on a root cause (#1847); "it passes now" is not one.
test.fixme('TIMELORDE: the run button hides when an external transport (start_in) owns it', { annotation: { type: 'fixme', description: 'FLAKE-PARK #1847 — nondeterministic on CI: 1 recovered-on-retry observation in the 96 h census to 2026-08-18; parked until root-caused' } }, async ({ page, rack }) => {
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

// e2e/tests/clipplayer-card-parity.spec.ts
//
// CLIP PLAYER card parity + keyboard-1-8 (Part A + Part B of the card-parity
// design). These assert BEHAVIOUR (the synced node.data the engine consumes),
// not just presence:
//
//   - the 8-button control strip switches the card's 4 views (grid/clip/arranger
//     /control), mirroring the single-pad Launchpad's permanent top row;
//   - a card CONTROL-deck action (MUTE) writes the SAME node.data.muted[] field
//     the real single-pad Launchpad control view writes (parity by construction),
//     driven through the SAME simulated-device dispatch path hardware uses;
//   - computer keys 1..8 drive the strip ONLY while the card is the lone
//     selection, with HOLD on 8 (shift): hold-8 + click a cell cycles velocity;
//   - the stuck-shift guard force-releases shift on window blur;
//   - control-strip undo/redo (keys 6/7) revert a note edit;
//   - scene-launch / scene-repeat-SET / tempo write the shared node.data.

import type { Page } from '@playwright/test';
import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

type CPData = {
  clips?: Record<string, { steps?: { step: number; midi: number; velocity: number }[] }>;
  muted?: boolean[];
  queued?: (number | 'stop' | null)[];
  playing?: (number | null)[];
  sceneLaunch?: { slot: number; n: number };
  sceneRepeats?: Record<string, number>;
};
type W = {
  __patch: { nodes: Record<string, { params?: Record<string, number>; data?: CPData }> };
  __ydoc: { transact: (fn: () => void) => void };
  __launchpadTestInstallSingle?: (id: string) => Promise<boolean>;
  __launchpadSingleSim?: { press: (x: number, y: number) => void; cc: (c: number, v: number) => void };
};

const nodeData = (page: Page, id: string) =>
  page.evaluate((nid) => (globalThis as unknown as W).__patch.nodes[nid]?.data ?? null, id);

/** Seed a note clip at flat index `idx` (clipIndex = lane*64 + slot). */
async function seedClip(page: Page, id: string, idx: number) {
  await page.evaluate(({ nid, i }) => {
    const w = globalThis as unknown as W;
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes[nid];
      if (!n.data) n.data = {};
      const clips = (n.data.clips ?? {}) as Record<string, unknown>;
      clips[String(i)] = {
        kind: 'note', lengthSteps: 16, root: 48, loop: true,
        steps: [{ step: 0, midi: 60, velocity: 100, lengthSteps: 1 }],
      };
      n.data.clips = clips;
      n.data.sv = 2; // stride-64 → skip the legacy re-key migration
    });
  }, { nid: id, i: idx });
}

// ---------------------------------------------------------------------------

test('control strip switches the 4 card views (grid / clip / arranger / control)', async ({ page, rack }) => {
  await spawnPatch(page, [{ id: 'cp', type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio' }]);
  const card = page.getByTestId('clipplayer-card').first();
  await expect(card).toBeVisible();

  // Default = grid (launch matrix visible).
  await expect(page.getByTestId('clipplayer-grid')).toBeVisible();

  // CLIP (button 3) → the note editor.
  await page.getByTestId('clipplayer-strip-3-cp').click();
  await expect(page.getByTestId('clipplayer-editor')).toBeVisible();
  await expect(page.getByTestId('clipplayer-clip-ops-cp')).toBeVisible();

  // CONTROL (button 5) → the deck.
  await page.getByTestId('clipplayer-strip-5-cp').click();
  await expect(page.getByTestId('clipplayer-control-deck')).toBeVisible();
  await expect(page.getByTestId('clipplayer-mute-0')).toBeVisible();

  // ARR (button 4) → the song timeline.
  await page.getByTestId('clipplayer-strip-4-cp').click();
  await expect(page.locator('.song-tl')).toBeVisible();

  // GRID (button 2) → back to the matrix.
  await page.getByTestId('clipplayer-strip-2-cp').click();
  await expect(page.getByTestId('clipplayer-grid')).toBeVisible();
});

test('parity: card CONTROL-deck MUTE and the single-pad Launchpad MUTE write the SAME node.data.muted[]', async ({ page, rack }) => {
  await spawnPatch(page, [
    { id: 'cp', type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio' },
    { id: 'tl', type: 'timelorde', position: { x: 520, y: 80 }, domain: 'audio', params: { running: 0, bpm: 120 } },
  ]);
  await expect(page.getByTestId('clipplayer-card').first()).toBeVisible();

  // Install the SIMULATED single-pad Launchpad bound to the same clip node —
  // the SAME decode/dispatch path real hardware uses.
  const ok = await page.evaluate((id) => {
    const w = globalThis as unknown as W;
    return w.__launchpadTestInstallSingle ? w.__launchpadTestInstallSingle(id) : Promise.resolve(false);
  }, 'cp');
  expect(ok, 'single simulated Launchpad install hook present').toBe(true);

  // Launchpad: select CONTROL (permanent top row CC 95), then press its MUTE pad
  // for lane 0 (deck row 3, col 0) → node.data.muted[0] = true.
  await page.evaluate(() => {
    const s = (globalThis as unknown as W).__launchpadSingleSim!;
    s.cc(95, 127); s.cc(95, 0); // CONTROL view
    s.press(0, 3); // MUTE lane 0
  });
  await expect.poll(async () => (await nodeData(page, 'cp'))?.muted?.[0] ?? false).toBe(true);

  // Card: open the CONTROL deck (strip button 5), then click its MUTE for lane 0
  // → toggles the SAME muted[0] field the Launchpad just set → false. Same seam.
  await page.getByTestId('clipplayer-strip-5-cp').click();
  await page.getByTestId('clipplayer-mute-0').click();
  await expect.poll(async () => (await nodeData(page, 'cp'))?.muted?.[0] ?? true).toBe(false);

  // And the reverse: the CARD sets lane 2, the LAUNCHPAD clears it — proving the
  // two surfaces share one muted[] state bidirectionally.
  await page.getByTestId('clipplayer-mute-2').click();
  await expect.poll(async () => (await nodeData(page, 'cp'))?.muted?.[2] ?? false).toBe(true);
  await page.evaluate(() => { (globalThis as unknown as W).__launchpadSingleSim!.press(2, 3); });
  await expect.poll(async () => (await nodeData(page, 'cp'))?.muted?.[2] ?? true).toBe(false);
});

test('keyboard 1–8 drive the strip ONLY when the card is the single selection', async ({ page, rack }) => {
  await spawnPatch(page, [{ id: 'cp', type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio' }]);
  await expect(page.getByTestId('clipplayer-card').first()).toBeVisible();

  // Not selected → no "1–8" chip, digits are inert.
  await expect(page.getByTestId('clipplayer-kb-active-cp')).toHaveCount(0);
  await page.keyboard.press('5');
  await expect(page.getByTestId('clipplayer-control-deck')).toHaveCount(0);

  // Select the card (clicking a strip button selects its flow node) → chip lights.
  await page.getByTestId('clipplayer-strip-2-cp').click();
  await expect(page.getByTestId('clipplayer-kb-active-cp')).toBeVisible();

  // Key 5 → CONTROL deck; key 3 → CLIP editor; key 2 → GRID.
  await page.keyboard.press('5');
  await expect(page.getByTestId('clipplayer-control-deck')).toBeVisible();
  await page.keyboard.press('3');
  await expect(page.getByTestId('clipplayer-editor')).toBeVisible();
  await page.keyboard.press('2');
  await expect(page.getByTestId('clipplayer-grid')).toBeVisible();

  // Deselect (click empty canvas) → chip gone + digits inert again.
  await page.locator('.svelte-flow__pane').click({ position: { x: 5, y: 5 } });
  await expect(page.getByTestId('clipplayer-kb-active-cp')).toHaveCount(0);
  await page.keyboard.press('5');
  await expect(page.getByTestId('clipplayer-control-deck')).toHaveCount(0);
});

test('keyboard HOLD-8 (shift) + click a cell cycles velocity; blur force-releases the stuck shift', async ({ page, rack }) => {
  await spawnPatch(page, [{ id: 'cp', type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio' }]);
  await seedClip(page, 'cp', 0);
  await expect(page.getByTestId('clipplayer-card').first()).toBeVisible();

  // Select the card + open the CLIP editor via the strip.
  await page.getByTestId('clipplayer-strip-3-cp').click();
  await expect(page.getByTestId('clipplayer-editor')).toBeVisible();

  // Plain click an empty cell → a note appears (default velocity).
  const cell = page.getByTestId('clipplayer-cell-4-6');
  await cell.click();
  const v0 = await page.evaluate(() => {
    const s = (globalThis as unknown as W).__patch.nodes['cp'].data?.clips?.['0']?.steps ?? [];
    return s.find((n) => n.step === 6)?.velocity ?? null;
  });
  expect(v0, 'plain click placed a note').not.toBeNull();

  // HOLD key 8 (= shift): the shift strip button + VEL-mode hint light.
  await page.keyboard.down('8');
  await expect(page.getByTestId('clipplayer-strip-8-cp')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('clipplayer-velmode-cp')).toHaveClass(/on/);

  // While shift is HELD, clicking the SAME cell CYCLES velocity (keeps the note),
  // instead of toggling it off — the "hold-shift-then-click" flow.
  await cell.click();
  const after = await page.evaluate(() => {
    const s = (globalThis as unknown as W).__patch.nodes['cp'].data?.clips?.['0']?.steps ?? [];
    return { count: s.filter((n) => n.step === 6).length, vel: s.find((n) => n.step === 6)?.velocity ?? null };
  });
  expect(after.count, 'note kept (velocity mode, not toggled off)').toBe(1);
  expect(after.vel, 'velocity cycled').not.toBe(v0);

  // STUCK-SHIFT GUARD: a window blur (focus lost before keyup) force-releases
  // shift so it can't strand.
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(page.getByTestId('clipplayer-strip-8-cp')).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.up('8'); // clean up the physical key

  // Post-release, a plain click toggles again (removes the note).
  await cell.click();
  const gone = await page.evaluate(() => {
    const s = (globalThis as unknown as W).__patch.nodes['cp'].data?.clips?.['0']?.steps ?? [];
    return s.filter((n) => n.step === 6).length;
  });
  expect(gone, 'shift released → plain click toggles the note off').toBe(0);
});

test('control-strip undo / redo (keys 6/7) revert and re-apply a note edit', async ({ page, rack }) => {
  await spawnPatch(page, [{ id: 'cp', type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio' }]);
  await seedClip(page, 'cp', 0);
  await expect(page.getByTestId('clipplayer-card').first()).toBeVisible();

  await page.getByTestId('clipplayer-strip-3-cp').click(); // CLIP + select
  await expect(page.getByTestId('clipplayer-editor')).toBeVisible();

  const stepCount = () => page.evaluate(() => {
    const s = (globalThis as unknown as W).__patch.nodes['cp'].data?.clips?.['0']?.steps ?? [];
    return s.filter((n) => n.step === 9).length;
  });

  await page.getByTestId('clipplayer-cell-3-9').click();
  await expect.poll(stepCount).toBe(1);

  // Undo (button 6) → the note edit reverts.
  await page.getByTestId('clipplayer-strip-6-cp').click();
  await expect.poll(stepCount).toBe(0);

  // Redo (button 7) → the note returns.
  await page.getByTestId('clipplayer-strip-7-cp').click();
  await expect.poll(stepCount).toBe(1);
});

test('scene-launch fires a slot across content lanes; scene-repeat SET cycles the count', async ({ page, rack }) => {
  await spawnPatch(page, [{ id: 'cp', type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio', params: { quantize: 0 } }]);
  await seedClip(page, 'cp', 0); // lane 0, slot 0
  await expect(page.getByTestId('clipplayer-grid')).toBeVisible();

  // Scene-launch row 0 → fires slot 0 across content lanes (the SAME
  // applySceneLaunchWrite seam the Launchpad uses): d.sceneLaunch records the
  // fired scene, and content lane 0 begins playing slot 0. (queued clears back
  // to null the instant the free-run engine consumes the launch into playing.)
  await page.getByTestId('clipplayer-scene-launch-0').click();
  await expect.poll(async () => (await nodeData(page, 'cp'))?.sceneLaunch?.slot ?? -1).toBe(0);
  await expect.poll(async () => (await nodeData(page, 'cp'))?.playing?.[0] ?? -1).toBe(0);

  // Scene-repeat SET on scene 0 cycles ∞(absent) → 2.
  await page.getByTestId('clipplayer-scene-repeat-0').click();
  await expect.poll(async () => (await nodeData(page, 'cp'))?.sceneRepeats?.['0'] ?? 0).toBe(2);
});

test('control-deck Tempo ± nudges TIMELORDE bpm', async ({ page, rack }) => {
  await spawnPatch(page, [
    { id: 'cp', type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio' },
    { id: 'tl', type: 'timelorde', position: { x: 520, y: 80 }, domain: 'audio', params: { running: 0, bpm: 120 } },
  ]);
  await page.getByTestId('clipplayer-strip-5-cp').click(); // CONTROL deck
  await expect(page.getByTestId('clipplayer-control-deck')).toBeVisible();

  const bpm = () => page.evaluate(() => (globalThis as unknown as W).__patch.nodes['tl'].params?.bpm ?? null);
  const b0 = await bpm();
  await page.getByTestId('clipplayer-tempo-up-cp').click();
  await expect.poll(bpm).toBeGreaterThan(b0!);
  await page.getByTestId('clipplayer-tempo-down-cp').click();
  await page.getByTestId('clipplayer-tempo-down-cp').click();
  await expect.poll(bpm).toBeLessThan(b0!);
});

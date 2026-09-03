// e2e/tests/clipplayer-card-parity.spec.ts
//
// CLIP PLAYER surface parity (Part A + Part B of the card-parity design), on
// the DEFAULT SHELL. These assert BEHAVIOUR (the synced node.data the engine
// consumes), not just presence:
//
//   - a dock CONTROL-deck action (MUTE) writes the SAME node.data.muted[] field
//     the real single-pad Launchpad control view writes (parity by construction),
//     driven through the SAME simulated-device dispatch path hardware uses;
//   - VEL mode (the deck's VEL toggle, or a held Shift) makes a cell click CYCLE
//     velocity instead of toggling the note;
//   - the deck's undo/redo buttons revert and re-apply a note edit, and each
//     node's undo stack is its OWN (undoing on player A never reverts player B);
//   - scene-launch / scene-repeat-SET / tempo write the shared node.data.
//
// ⚠ WHAT DIED WITH THE CARD (fold-and-delete, see the S2 manifest): the
// 8-button view strip and its keyboard-1..8/focus-within/stuck-shift machinery
// were card-only chrome — the dock face paints grid, editor and deck at once,
// so there is no view to switch and no digit hijack surface left to guard.

import type { Page } from '@playwright/test';
import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

type CPData = {
  clips?: Record<
    string,
    {
      kind?: string;
      lengthSteps?: number;
      root?: number;
      loop?: boolean;
      steps?: { step: number; midi: number; velocity: number; lengthSteps?: number }[];
    }
  >;
  muted?: boolean[];
  queued?: (number | 'stop' | null)[];
  playing?: (number | null)[];
  sceneLaunch?: { slot: number; n: number };
  sceneRepeats?: Record<string, number>;
  /** Clip-store schema version — 2 = stride-64 keys (skips the legacy re-key migration). */
  sv?: number;
};
type W = {
  __patch: { nodes: Record<string, { params?: Record<string, number>; data?: CPData }> };
  __ydoc: { transact: (fn: () => void) => void };
  __launchpadTestInstallSingle?: (id: string) => Promise<boolean>;
  __launchpadSingleSim?: { press: (x: number, y: number) => void; cc: (c: number, v: number) => void };
  __openDockFullView?: (id: string) => void;
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
      const clips = (n.data.clips ?? {}) as NonNullable<CPData['clips']>;
      clips[String(i)] = {
        kind: 'note', lengthSteps: 16, root: 48, loop: true,
        steps: [{ step: 0, midi: 60, velocity: 100, lengthSteps: 1 }],
      };
      n.data.clips = clips;
      n.data.sv = 2; // stride-64 → skip the legacy re-key migration
    });
  }, { nid: id, i: idx });
}

/** Open the dock full view for `id` and return its pane (pane-scoped locators
 *  matter here — cell testids are NOT node-scoped and two players can have two
 *  panes open at once). */
async function openDockPane(page: Page, id: string) {
  await page.evaluate((nid) => (globalThis as unknown as W).__openDockFullView?.(nid), id);
  const pane = page.locator(`[data-testid="dock-fullview-pane"][data-pane-node="${id}"]`);
  await expect(pane).toBeVisible();
  return pane;
}

// ---------------------------------------------------------------------------

test('parity: dock CONTROL-deck MUTE and the single-pad Launchpad MUTE write the SAME node.data.muted[]', async ({ page, rack }) => {
  await spawnPatch(page, [
    { id: 'cp', type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio' },
    { id: 'tl', type: 'timelorde', position: { x: 520, y: 80 }, domain: 'audio', params: { running: 0, bpm: 120 } },
  ]);
  const pane = await openDockPane(page, 'cp');
  await expect(pane.getByTestId('clipplayer-face-deck')).toBeVisible();

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

  // Dock deck: click its MUTE for lane 0 → toggles the SAME muted[0] field the
  // Launchpad just set → false. Same seam.
  await pane.getByTestId('clipplayer-mute-0').click();
  await expect.poll(async () => (await nodeData(page, 'cp'))?.muted?.[0] ?? true).toBe(false);

  // And the reverse: the DOCK sets lane 2, the LAUNCHPAD clears it — proving the
  // two surfaces share one muted[] state bidirectionally.
  await pane.getByTestId('clipplayer-mute-2').click();
  await expect.poll(async () => (await nodeData(page, 'cp'))?.muted?.[2] ?? false).toBe(true);
  await page.evaluate(() => { (globalThis as unknown as W).__launchpadSingleSim!.press(2, 3); });
  await expect.poll(async () => (await nodeData(page, 'cp'))?.muted?.[2] ?? true).toBe(false);
});

test('VEL mode (deck toggle or held Shift) makes a cell click CYCLE velocity instead of toggling the note', async ({ page, rack }) => {
  await spawnPatch(page, [{ id: 'cp', type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio' }]);
  await seedClip(page, 'cp', 0);
  const pane = await openDockPane(page, 'cp');

  // Bind the editor band to clip 0 (it already exists, so this writes nothing).
  await pane.locator('[data-clip="0"]').dblclick();
  await expect(pane.getByTestId('clipplayer-pianoroll')).toBeVisible();

  // Plain click an empty cell → a note appears (default velocity).
  const cell = pane.getByTestId('clipplayer-cell-4-6');
  await cell.scrollIntoViewIfNeeded();
  await cell.click();
  const v0 = await page.evaluate(() => {
    const s = (globalThis as unknown as W).__patch.nodes['cp'].data?.clips?.['0']?.steps ?? [];
    return s.find((n) => n.step === 6)?.velocity ?? null;
  });
  expect(v0, 'plain click placed a note').not.toBeNull();

  // VEL mode ON (the deck's own toggle — the face home of the card's held-8).
  const vel = pane.getByTestId('clipplayer-velmode-cp');
  await vel.click();
  await expect(vel).toHaveAttribute('aria-pressed', 'true');

  // While VEL mode is on, clicking the SAME cell CYCLES velocity (keeps the
  // note), instead of toggling it off.
  await cell.click();
  const after = await page.evaluate(() => {
    const s = (globalThis as unknown as W).__patch.nodes['cp'].data?.clips?.['0']?.steps ?? [];
    return { count: s.filter((n) => n.step === 6).length, vel: s.find((n) => n.step === 6)?.velocity ?? null };
  });
  expect(after.count, 'note kept (velocity mode, not toggled off)').toBe(1);
  expect(after.vel, 'velocity cycled').not.toBe(v0);

  // VEL mode OFF → a held SHIFT still cycles (the modifier gesture, kept from
  // the card), and a plain click toggles the note away again.
  await vel.click();
  await expect(vel).toHaveAttribute('aria-pressed', 'false');
  await cell.click({ modifiers: ['Shift'] });
  const shifted = await page.evaluate(() => {
    const s = (globalThis as unknown as W).__patch.nodes['cp'].data?.clips?.['0']?.steps ?? [];
    return { count: s.filter((n) => n.step === 6).length, vel: s.find((n) => n.step === 6)?.velocity ?? null };
  });
  expect(shifted.count, 'shift-click also cycles, never deletes').toBe(1);
  expect(shifted.vel, 'shift-click moved the velocity again').not.toBe(after.vel);

  await cell.click();
  const gone = await page.evaluate(() => {
    const s = (globalThis as unknown as W).__patch.nodes['cp'].data?.clips?.['0']?.steps ?? [];
    return s.filter((n) => n.step === 6).length;
  });
  expect(gone, 'plain click toggles the note off').toBe(0);
});

test('deck undo / redo revert and re-apply a note edit', async ({ page, rack }) => {
  await spawnPatch(page, [{ id: 'cp', type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio' }]);
  await seedClip(page, 'cp', 0);
  const pane = await openDockPane(page, 'cp');

  await pane.locator('[data-clip="0"]').dblclick();
  await expect(pane.getByTestId('clipplayer-pianoroll')).toBeVisible();

  const stepCount = () => page.evaluate(() => {
    const s = (globalThis as unknown as W).__patch.nodes['cp'].data?.clips?.['0']?.steps ?? [];
    return s.filter((n) => n.step === 9).length;
  });

  await pane.getByTestId('clipplayer-cell-3-9').click();
  await expect.poll(stepCount).toBe(1);

  // Undo (the deck ↶) → the note edit reverts.
  await pane.getByTestId('clipplayer-strip-6-cp').click();
  await expect.poll(stepCount).toBe(0);

  // Redo (the deck ↷) → the note returns.
  await pane.getByTestId('clipplayer-strip-7-cp').click();
  await expect.poll(stepCount).toBe(1);
});

test('per-node undo scope: undoing on player A does NOT revert player B', async ({ page, rack }) => {
  await spawnPatch(page, [
    { id: 'cpa', type: 'clipplayer', position: { x: 60, y: 80 }, domain: 'audio' },
    { id: 'cpb', type: 'clipplayer', position: { x: 700, y: 80 }, domain: 'audio' },
  ]);
  await seedClip(page, 'cpa', 0);
  await seedClip(page, 'cpb', 0);

  // TWO panes at once — the dock supports it, and the per-node undo buttons
  // (`clipplayer-strip-6-<node>`) disambiguate; cells are scoped by pane.
  const paneA = await openDockPane(page, 'cpa');
  const paneB = await openDockPane(page, 'cpb');

  const stepCount = (nid: string, step: number) =>
    page.evaluate(({ i, s }) => {
      const arr = (globalThis as unknown as W).__patch.nodes[i].data?.clips?.['0']?.steps ?? [];
      return arr.filter((n) => n.step === s).length;
    }, { i: nid, s: step });

  // Player A: bind clip 0, add a note at step 9.
  await paneA.locator('[data-clip="0"]').dblclick();
  await paneA.getByTestId('clipplayer-cell-3-9').click();
  await expect.poll(() => stepCount('cpa', 9)).toBe(1);

  // Player B: bind clip 0, add a note at step 9 (its OWN independent edit).
  await paneB.locator('[data-clip="0"]').dblclick();
  await paneB.getByTestId('clipplayer-cell-3-9').click();
  await expect.poll(() => stepCount('cpb', 9)).toBe(1);

  // Undo on player A (its deck ↶) reverts ONLY A — player B's note survives
  // (the shared-stack leak this fix closes).
  await page.getByTestId('clipplayer-strip-6-cpa').click();
  await expect.poll(() => stepCount('cpa', 9)).toBe(0);
  await expect.poll(() => stepCount('cpb', 9)).toBe(1);

  // And player B undoes its own edit independently.
  await page.getByTestId('clipplayer-strip-6-cpb').click();
  await expect.poll(() => stepCount('cpb', 9)).toBe(0);
});

test('scene-launch fires a slot across content lanes; scene-repeat SET cycles the count', async ({ page, rack }) => {
  await spawnPatch(page, [{ id: 'cp', type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio', params: { quantize: 0 } }]);
  await seedClip(page, 'cp', 0); // lane 0, slot 0
  const pane = await openDockPane(page, 'cp');
  await expect(pane.getByTestId('clipplayer-face-grid')).toBeVisible();

  // Scene-launch row 0 → fires slot 0 across content lanes (the SAME
  // applySceneLaunchWrite seam the Launchpad uses): d.sceneLaunch records the
  // fired scene, and content lane 0 begins playing slot 0. (queued clears back
  // to null the instant the free-run engine consumes the launch into playing.)
  await pane.getByTestId('clipplayer-scene-launch-0').click();
  await expect.poll(async () => (await nodeData(page, 'cp'))?.sceneLaunch?.slot ?? -1).toBe(0);
  await expect.poll(async () => (await nodeData(page, 'cp'))?.playing?.[0] ?? -1).toBe(0);

  // Scene-repeat SET on scene 0 cycles ∞(absent) → 2.
  await pane.getByTestId('clipplayer-scene-repeat-0').click();
  await expect.poll(async () => (await nodeData(page, 'cp'))?.sceneRepeats?.['0'] ?? 0).toBe(2);
});

test('control-deck Tempo ± nudges TIMELORDE bpm', async ({ page, rack }) => {
  await spawnPatch(page, [
    { id: 'cp', type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio' },
    { id: 'tl', type: 'timelorde', position: { x: 520, y: 80 }, domain: 'audio', params: { running: 0, bpm: 120 } },
  ]);
  const pane = await openDockPane(page, 'cp');
  await expect(pane.getByTestId('clipplayer-face-deck')).toBeVisible();

  const bpm = () => page.evaluate(() => (globalThis as unknown as W).__patch.nodes['tl'].params?.bpm ?? null);
  const b0 = await bpm();
  await pane.getByTestId('clipplayer-tempo-up-cp').click();
  await expect.poll(bpm).toBeGreaterThan(b0!);
  await pane.getByTestId('clipplayer-tempo-down-cp').click();
  await pane.getByTestId('clipplayer-tempo-down-cp').click();
  await expect.poll(bpm).toBeLessThan(b0!);
});

// e2e/tests/clipplayer-songmode.spec.ts
//
// CLIP PLAYER song mode (Phase 1): record clip launches into the arrangement,
// toggle SESSION ⇄ ARRANGEMENT, and replay the log. No TIMELORDE in the rack →
// the clip player free-runs (transportRunning true) at the 120bpm fallback, so
// songBeat advances and the engine records/plays. Asserts the SYNCED data
// (node.data.arrangement / clipMode / playing) — the observable contract.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

type CPData = {
  clips?: Record<string, unknown>;
  arrangement?: { events?: { beat: number; lane: number; slot: number | 'stop' }[] };
  clipMode?: string;
  playing?: (number | null)[];
};
type W = {
  __patch: { nodes: Record<string, { data?: CPData }> };
  __ydoc: { transact: (fn: () => void) => void };
};

const NOTE_CLIP = {
  kind: 'note',
  lengthSteps: 4,
  root: 48,
  loop: true,
  steps: [{ step: 0, midi: 72, velocity: 127, lengthSteps: 1 }],
};

/** Seed note clips at the given flat indices (clipIndex = lane*8 + slot). */
async function seedClips(page: Page, nodeId: string, indices: number[]) {
  await page.evaluate(
    ({ nodeId, indices }) => {
      const w = globalThis as unknown as W & { __NOTE_CLIP?: unknown };
      const clip = {
        kind: 'note', lengthSteps: 4, root: 48, loop: true,
        steps: [{ step: 0, midi: 72, velocity: 127, lengthSteps: 1 }],
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes[nodeId];
        if (!n.data) n.data = {};
        const clips: Record<string, unknown> = {};
        for (const i of indices) clips[String(i)] = JSON.parse(JSON.stringify(clip));
        n.data.clips = clips;
      });
    },
    { nodeId, indices },
  );
}

async function readData(page: Page, nodeId: string): Promise<CPData> {
  return page.evaluate((nodeId) => {
    const w = globalThis as unknown as W;
    return (w.__patch.nodes[nodeId].data ?? {}) as CPData;
  }, nodeId);
}

test('song mode: arming RECORD captures clip launches into the arrangement', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  // quantize off → launches apply immediately (deterministic capture). No
  // TIMELORDE → free-run.
  await spawnPatch(page, [
    { id: 'cp', type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio', params: { quantize: 0 } },
  ]);
  await seedClips(page, 'cp', [0, 8]); // lane0/slot0 + lane1/slot0

  // Arm RECORD (the engine clears the log + restarts song time on the rising edge).
  await page.getByTestId('clipplayer-record-cp').click();
  await expect.poll(async () => (await readData(page, 'cp')).clipMode ?? 'session').toBe('session');
  await page.waitForTimeout(150); // let the clear-on-arm tick land first

  // Launch lane 0, then lane 1, spaced in time so they record at different beats.
  await page.locator('.svelte-flow__node-clipplayer [data-clip="0"]').click();
  await page.waitForTimeout(500);
  await page.locator('.svelte-flow__node-clipplayer [data-clip="8"]').click();
  await page.waitForTimeout(500);

  const evs = (await readData(page, 'cp')).arrangement?.events ?? [];
  expect(evs.length, 'two launches recorded').toBeGreaterThanOrEqual(2);
  const lanes = new Set(evs.map((e) => e.lane));
  expect(lanes.has(0)).toBe(true);
  expect(lanes.has(1)).toBe(true);
  // beats are non-decreasing (chronological log)
  for (let i = 1; i < evs.length; i++) expect(evs[i].beat).toBeGreaterThanOrEqual(evs[i - 1].beat);
});

test('song mode: the SES/ARR button flips clipMode', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'cp', type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio' }]);
  const modeBtn = page.getByTestId('clipplayer-mode-cp');
  await expect(modeBtn).toHaveText('SES');
  await modeBtn.click();
  await expect(modeBtn).toHaveText('ARR');
  await expect.poll(async () => (await readData(page, 'cp')).clipMode).toBe('arrangement');
  await modeBtn.click();
  await expect(modeBtn).toHaveText('SES');
});

test('song mode: ARRANGEMENT playback launches lanes from the recorded log', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'cp', type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio' }]);
  await seedClips(page, 'cp', [0, 8]);
  // Inject a pre-built arrangement (lane 0 + lane 1 both launch slot 0 at beat 0)
  // and switch to ARRANGEMENT mode. Free-run → the playback cursor fires it.
  await page.evaluate(() => {
    const w = globalThis as unknown as W;
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['cp'];
      if (!n.data) n.data = {};
      n.data.arrangement = {
        events: [
          { beat: 0, lane: 0, slot: 0 },
          { beat: 0, lane: 1, slot: 0 },
        ],
        lengthBeats: 4,
        loop: true,
      } as never;
      n.data.clipMode = 'arrangement';
    });
  });

  // The cursor should launch both lanes (data.playing[0]=0, [1]=0) shortly after start.
  await expect
    .poll(async () => {
      const pl = (await readData(page, 'cp')).playing ?? [];
      return pl[0] === 0 && pl[1] === 0;
    }, { timeout: 4000 })
    .toBe(true);
});

test('song view: renders blocks + select/delete edits the arrangement', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'cp', type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio' }]);
  await seedClips(page, 'cp', [0, 8]);
  // lane 0: slot 0 [0,8) then slot 1 [8,16); lane 1: slot 0 [0,16) → 3 blocks.
  await page.evaluate(() => {
    const w = globalThis as unknown as W;
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['cp'];
      if (!n.data) n.data = {};
      n.data.arrangement = {
        events: [
          { beat: 0, lane: 0, slot: 0 },
          { beat: 8, lane: 0, slot: 1 },
          { beat: 0, lane: 1, slot: 0 },
        ],
        lengthBeats: 16,
        loop: true,
      } as never;
      n.data.clipMode = 'arrangement';
    });
  });

  const blocks = page.locator('.song-block');
  await expect(blocks).toHaveCount(3);

  // Select the first block, then delete it → its launch event is removed.
  await blocks.first().click();
  await expect(blocks.first()).toHaveClass(/\bsel\b/);
  await page.getByTestId('clipplayer-song-del').click();

  await expect(blocks).toHaveCount(2);
  const evs = (await readData(page, 'cp')).arrangement?.events ?? [];
  expect(evs.length).toBe(2);
});

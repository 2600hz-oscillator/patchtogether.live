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
  await page.goto('/rack');
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
  await page.goto('/rack');
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
  await page.goto('/rack');
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
  await page.goto('/rack');
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

test('song mode: OVERDUB keeps the take + merges new launches (vs REPLACE wiping it)', async ({ page }) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  // quantize off → launches apply immediately. No TIMELORDE → free-run.
  await spawnPatch(page, [
    { id: 'cp', type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio', params: { quantize: 0 } },
  ]);
  await seedClips(page, 'cp', [0, 8]); // lane0/slot0 + lane1/slot0

  // Pre-seed a lane-2 launch + set OVERDUB mode (the arm must KEEP this take).
  await page.evaluate(() => {
    const w = globalThis as unknown as W;
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['cp'];
      if (!n.data) n.data = {};
      n.data.arrangement = {
        events: [{ beat: 0, lane: 2, slot: 0 }],
        lengthBeats: 8,
        loop: true,
      } as never;
      (n.data as { recordMode?: string }).recordMode = 'overdub';
    });
  });
  await expect(page.getByTestId('clipplayer-recmode-cp')).toHaveText('OVR');

  // Arm RECORD (overdub: does NOT clear), then launch lane 0 + lane 1 in time.
  await page.getByTestId('clipplayer-record-cp').click();
  await page.waitForTimeout(150);
  await page.locator('.svelte-flow__node-clipplayer [data-clip="0"]').click();
  await page.waitForTimeout(400);
  await page.locator('.svelte-flow__node-clipplayer [data-clip="8"]').click();
  await page.waitForTimeout(300);

  const evs = (await readData(page, 'cp')).arrangement?.events ?? [];
  // The pre-seeded lane-2 event survived AND the new launches merged in.
  expect(evs.length, 'overdub kept the take + added launches').toBeGreaterThanOrEqual(3);
  expect(evs.some((e) => e.lane === 2 && e.beat === 0), 'pre-seeded take kept').toBe(true);
  expect(evs.some((e) => e.lane === 0), 'lane 0 overdubbed').toBe(true);
  expect(evs.some((e) => e.lane === 1), 'lane 1 overdubbed').toBe(true);
  // beats stay non-decreasing (merged in song-beat order).
  for (let i = 1; i < evs.length; i++) expect(evs[i].beat).toBeGreaterThanOrEqual(evs[i - 1].beat);
});

test('song mode: REPLACE arming wipes the pre-seeded take (contrast control)', async ({ page }) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [
    { id: 'cp', type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio', params: { quantize: 0 } },
  ]);
  await seedClips(page, 'cp', [0]);

  // Pre-seed a take; recordMode is REPLACE (default/absent) → arming clears it.
  await page.evaluate(() => {
    const w = globalThis as unknown as W;
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['cp'];
      if (!n.data) n.data = {};
      n.data.arrangement = {
        events: [{ beat: 0, lane: 2, slot: 0 }, { beat: 4, lane: 3, slot: 1 }],
        lengthBeats: 8,
        loop: true,
      } as never;
    });
  });
  await expect(page.getByTestId('clipplayer-recmode-cp')).toHaveText('RPL');

  await page.getByTestId('clipplayer-record-cp').click();
  // The engine clears the log on the arm rising edge.
  await expect
    .poll(async () => ((await readData(page, 'cp')).arrangement?.events ?? []).length, { timeout: 3000 })
    .toBe(0);
});

test('drag-to-move: dragging a block retimes its launch + persists (bar-snapped)', async ({ page }) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'cp', type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio' }]);
  await seedClips(page, 'cp', [0, 1]); // lane0/slot0 + lane0/slot1
  // lane 0: slot 0 [0,8) then slot 1 [8,16); lengthBeats 16 so beat-8 → bar-4 = beat 4.
  await page.evaluate(() => {
    const w = globalThis as unknown as W;
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['cp'];
      if (!n.data) n.data = {};
      n.data.arrangement = {
        events: [
          { beat: 0, lane: 0, slot: 0 },
          { beat: 8, lane: 0, slot: 1 },
        ],
        lengthBeats: 16,
        loop: true,
      } as never;
      n.data.clipMode = 'arrangement';
    });
  });

  const svg = page.locator('.song-tl');
  await expect(svg).toBeVisible();
  const box = (await svg.boundingBox())!;
  // The beat-8 block (slot 1) sits at svg-x = (8/16)*width = mid; drag it to the
  // bar-4 position (beat 4 = quarter-width). The card svg width == lengthBeats px
  // mapping is proportional to the rendered box width.
  const fromX = box.x + box.width * (8 / 16) + 6; // a few px inside the block
  const toX = box.x + box.width * (4 / 16);
  const laneY = box.y + box.height * (0.5 / 8); // center of lane-0 row (row 0 of 8)

  await page.mouse.move(fromX, laneY);
  await page.mouse.down();
  await page.mouse.move(toX, laneY, { steps: 8 });
  await page.mouse.up();

  // The slot-1 launch is now at beat 4 (snapped), and the slot-0 launch is intact.
  await expect
    .poll(async () => {
      const evs = (await readData(page, 'cp')).arrangement?.events ?? [];
      const moved = evs.find((e) => e.slot === 1);
      return moved?.beat ?? -1;
    }, { timeout: 3000 })
    .toBe(4);
  const evs = (await readData(page, 'cp')).arrangement?.events ?? [];
  expect(evs.find((e) => e.slot === 0)?.beat, 'other block untouched').toBe(0);
  expect(evs.length).toBe(2);
});

test('pop-out editor: opens, edits the SAME synced arrangement, closes on Esc', async ({ page }) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'cp', type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio' }]);
  await seedClips(page, 'cp', [0, 8]);
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

  // Open the full-window editor.
  await page.getByTestId('clipplayer-arrange-open-cp').click();
  const dialog = page.getByTestId('cliparrange-editor');
  await expect(dialog).toBeVisible();

  // Select a block + delete it → the SHARED synced arrangement shrinks by one.
  const before = ((await readData(page, 'cp')).arrangement?.events ?? []).length;
  await dialog.locator('.block').first().click();
  await page.getByTestId('cliparrange-editor-del').click();
  await expect
    .poll(async () => ((await readData(page, 'cp')).arrangement?.events ?? []).length, { timeout: 3000 })
    .toBe(before - 1);

  // Esc closes the overlay.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

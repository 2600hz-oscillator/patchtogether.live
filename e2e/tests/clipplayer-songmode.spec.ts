// e2e/tests/clipplayer-songmode.spec.ts
//
// CLIP PLAYER song mode (Phase 1): record clip launches into the arrangement,
// toggle SESSION ⇄ ARRANGEMENT, and replay the log. No TIMELORDE in the rack →
// the clip player free-runs (transportRunning true) at the 120bpm fallback, so
// songBeat advances and the engine records/plays. Asserts the SYNCED data
// (node.data.arrangement / clipMode / playing) — the observable contract.
//
// On the default shell the deck (record/mode chips) and the launch grid live in
// the DOCK FULL VIEW, and the arrangement timeline is the full-window ARRANGE
// editor (`cliparrange-editor`) opened from the deck — the card's inline
// `.song-tl` view died with the card; the pop-out is the one timeline surface.

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

type CPData = {
  clips?: Record<string, unknown>;
  arrangement?: { events?: { beat: number; lane: number; slot: number | 'stop' }[] };
  clipMode?: string;
  playing?: (number | null)[];
  /** Clip-store schema version — 2 = stride-64 keys (skips the legacy re-key migration). */
  sv?: number;
};
type W = {
  __patch: { nodes: Record<string, { data?: CPData }> };
  __ydoc: { transact: (fn: () => void) => void };
};

/** Seed note clips at the given flat indices (clipIndex = lane*64 + slot,
 *  stride-64 schema v2). */
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
        n.data.sv = 2; // already stride-64 → skip the legacy re-key migration
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

/** Open the clip player's dock full view — the shell home of deck + grid. */
async function openDock(page: Page) {
  const tile = page.locator('.svelte-flow__node[data-id="cp"] [data-testid="module-shell"]');
  await expect(tile).toBeVisible();
  await tile.getByTestId('shell-open-dock').click();
  const dock = page.getByTestId('dock-full-view');
  await expect(dock).toBeVisible();
  return dock;
}

/** Open the full-window ARRANGE editor from the deck. */
async function openArrange(page: Page, dock: import('@playwright/test').Locator) {
  await dock.getByTestId('clipplayer-arrange-open-cp').scrollIntoViewIfNeeded();
  await dock.getByTestId('clipplayer-arrange-open-cp').click();
  const dialog = page.getByTestId('cliparrange-editor');
  await expect(dialog).toBeVisible();
  return dialog;
}

// ⏸ FLAKE-PARK #1847 — parked with `test.fixme`; the body was re-pointed at the
// dock full view by the S2 legacy-removal inversion (same assertions, shell
// surface). NONDETERMINISM: 7 recovered-on-retry observation(s) across 7 SHA(s) / 4 branch(es) in the
// 96 h CI census to 2026-08-18 — never a hard failure, so every one of those jobs reported SUCCESS.
// LOST WHILE PARKED: the capture half of song mode: arming RECORD writes clip launches into node.data.arrangement instead of dropping them.
// Re-enable only on a root cause (#1847); "it passes now" is not one.
test.fixme('song mode: arming RECORD captures clip launches into the arrangement', { annotation: { type: 'fixme', description: 'FLAKE-PARK #1847 — nondeterministic on CI: 7 recovered-on-retry observations in the 96 h census to 2026-08-18; parked until root-caused' } }, async ({ page, rack }) => {
  // quantize off → launches apply immediately (deterministic capture). No
  // TIMELORDE → free-run.
  await spawnPatch(page, [
    { id: 'cp', type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio', params: { quantize: 0 } },
  ]);
  await seedClips(page, 'cp', [0, 64]); // lane0/slot0 + lane1/slot0
  const dock = await openDock(page);

  // Arm RECORD (the engine clears the log + restarts song time on the rising edge).
  await dock.getByTestId('clipplayer-record-cp').click();
  await expect.poll(async () => (await readData(page, 'cp')).clipMode ?? 'session').toBe('session');
  await page.waitForTimeout(150); // let the clear-on-arm tick land first

  // Launch lane 0, then lane 1, spaced in time so they record at different beats.
  await dock.locator('[data-clip="0"]').click();
  await page.waitForTimeout(500);
  await dock.locator('[data-clip="64"]').click();
  await page.waitForTimeout(500);

  const evs = (await readData(page, 'cp')).arrangement?.events ?? [];
  expect(evs.length, 'two launches recorded').toBeGreaterThanOrEqual(2);
  const lanes = new Set(evs.map((e) => e.lane));
  expect(lanes.has(0)).toBe(true);
  expect(lanes.has(1)).toBe(true);
  // beats are non-decreasing (chronological log)
  for (let i = 1; i < evs.length; i++) expect(evs[i].beat).toBeGreaterThanOrEqual(evs[i - 1].beat);
});

// ⏸ FLAKE-PARK #1847 — parked with `test.fixme`; the body was re-pointed at the
// dock full view by the S2 legacy-removal inversion (same assertions, shell
// surface). NONDETERMINISM: 7 recovered-on-retry observation(s) across 7 SHA(s) / 4 branch(es) in the
// 96 h CI census to 2026-08-18 — never a hard failure, so every one of those jobs reported SUCCESS.
// LOST WHILE PARKED: that the SES/ARR button flips clipMode in synced state — the mode switch the other two song-mode assertions depend on.
// Re-enable only on a root cause (#1847); "it passes now" is not one.
test.fixme('song mode: the SES/ARR button flips clipMode', { annotation: { type: 'fixme', description: 'FLAKE-PARK #1847 — nondeterministic on CI: 7 recovered-on-retry observations in the 96 h census to 2026-08-18; parked until root-caused' } }, async ({ page, rack }) => {
  await spawnPatch(page, [{ id: 'cp', type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio' }]);
  const dock = await openDock(page);
  const modeBtn = dock.getByTestId('clipplayer-mode-cp');
  await expect(modeBtn).toHaveText('SES');
  await modeBtn.click();
  await expect(modeBtn).toHaveText('ARR');
  await expect.poll(async () => (await readData(page, 'cp')).clipMode).toBe('arrangement');
  await modeBtn.click();
  await expect(modeBtn).toHaveText('SES');
});

// ⏸ FLAKE-PARK #1847 — parked with `test.fixme`; the body is UNCHANGED by the S2
// legacy-removal inversion (it drives no module DOM at all — pure Y.Doc + engine).
// NONDETERMINISM: 4 recovered-on-retry observation(s) across 4 SHA(s) / 3 branch(es) in the
// 96 h CI census to 2026-08-18 — never a hard failure, so every one of those jobs reported SUCCESS.
// LOST WHILE PARKED: arrangement playback — that the recorded launch log actually re-launches lanes, which is the entire point of song mode.
// Re-enable only on a root cause (#1847); "it passes now" is not one.
test.fixme('song mode: ARRANGEMENT playback launches lanes from the recorded log', { annotation: { type: 'fixme', description: 'FLAKE-PARK #1847 — nondeterministic on CI: 4 recovered-on-retry observations in the 96 h census to 2026-08-18; parked until root-caused' } }, async ({ page, rack }) => {
  await spawnPatch(page, [{ id: 'cp', type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio' }]);
  await seedClips(page, 'cp', [0, 64]);
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

test('arrange view: renders blocks + select/delete edits the arrangement', async ({ page, rack }) => {
  await spawnPatch(page, [{ id: 'cp', type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio' }]);
  await seedClips(page, 'cp', [0, 64]);
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

  const dock = await openDock(page);
  const dialog = await openArrange(page, dock);
  const blocks = dialog.locator('.block');
  await expect(blocks).toHaveCount(3);

  // Select the first block, then delete it → its launch event is removed.
  await blocks.first().click();
  await expect(blocks.first()).toHaveClass(/\bsel\b/);
  await page.getByTestId('cliparrange-editor-del').click();

  await expect(blocks).toHaveCount(2);
  const evs = (await readData(page, 'cp')).arrangement?.events ?? [];
  expect(evs.length).toBe(2);
});

test('song mode: OVERDUB keeps the take + merges new launches (vs REPLACE wiping it)', async ({ page, rack }) => {
  // quantize off → launches apply immediately. No TIMELORDE → free-run.
  await spawnPatch(page, [
    { id: 'cp', type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio', params: { quantize: 0 } },
  ]);
  await seedClips(page, 'cp', [0, 64]); // lane0/slot0 + lane1/slot0
  const dock = await openDock(page);

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
  await expect(dock.getByTestId('clipplayer-recmode-cp')).toHaveText('OVR');

  // Arm RECORD (overdub: does NOT clear), then launch lane 0 + lane 1 in time.
  await dock.getByTestId('clipplayer-record-cp').click();
  await page.waitForTimeout(150);
  await dock.locator('[data-clip="0"]').click();
  await page.waitForTimeout(400);
  await dock.locator('[data-clip="64"]').click();
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

test('song mode: REPLACE arming wipes the pre-seeded take (contrast control)', async ({ page, rack }) => {
  await spawnPatch(page, [
    { id: 'cp', type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio', params: { quantize: 0 } },
  ]);
  await seedClips(page, 'cp', [0]);
  const dock = await openDock(page);

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
  await expect(dock.getByTestId('clipplayer-recmode-cp')).toHaveText('RPL');

  await dock.getByTestId('clipplayer-record-cp').click();
  // The engine clears the log on the arm rising edge.
  await expect
    .poll(async () => ((await readData(page, 'cp')).arrangement?.events ?? []).length, { timeout: 3000 })
    .toBe(0);
});

test('drag-to-move: dragging a block retimes its launch + persists (bar-snapped)', async ({ page, rack }) => {
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

  const dock = await openDock(page);
  await openArrange(page, dock);
  const svg = page.getByTestId('cliparrange-editor-tl');
  await expect(svg).toBeVisible();
  const box = (await svg.boundingBox())!;
  // The beat-8 block (slot 1) sits at svg-x = (8/16)*width = mid; drag it to the
  // bar-4 position (beat 4 = quarter-width). The timeline width == lengthBeats
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

test('pop-out editor: opens, edits the SAME synced arrangement, closes on Esc', async ({ page, rack }) => {
  await spawnPatch(page, [{ id: 'cp', type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio' }]);
  await seedClips(page, 'cp', [0, 64]);
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

  // Open the full-window editor from the dock deck.
  const dock = await openDock(page);
  const dialog = await openArrange(page, dock);

  // Select a block + delete it → the SHARED synced arrangement shrinks by one.
  const before = ((await readData(page, 'cp')).arrangement?.events ?? []).length;
  await dialog.locator('.block').first().click();
  await page.getByTestId('cliparrange-editor-del').click();
  await expect
    .poll(async () => ((await readData(page, 'cp')).arrangement?.events ?? []).length, { timeout: 3000 })
    .toBe(before - 1);

  // Esc closes the overlay. (⚠ It also closes the dock full view underneath —
  // the shared dock Esc — which is why this is the LAST gesture of the test.)
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

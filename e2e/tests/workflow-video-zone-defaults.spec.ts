// e2e/tests/workflow-video-zone-defaults.spec.ts
//
// WORKFLOW VIDEO ZONE DEFAULTS — a fresh workflow rack auto-spawns the video
// zone's default trio and auto-wires it to the MASTER buses:
//
//   1. videoOut       — the master video SINK (already shipped in #1152).
//   2. recorderbox    — records the master A/V. Its VIDEO input taps the
//      videoOut's pass-through OUT (= the master video the user monitors); its
//      AUDIO inputs take mixmstrs masterL/R (the master stereo mix).
//   3. synesthesia    — audio-reactive visuals from the whole mix: mixmstrs
//      masterL → A (a_in), masterR → B (b_in).
//
// The wiring uses DETERMINISTIC edge ids (`e-<src>-<srcPort>-<dst>-<dstPort>`)
// so this spec asserts the real edges MATERIALIZE in the live `__patch.edges`.
// Each module carries its OWN one-shot latch (on the pinned mixer) so a user
// DELETE is respected forever — the last test deletes recorderbox, reloads, and
// proves it does NOT respawn (the scratch IndexedDB replica rehydrates the
// latch). Driving /rack?mode=workflow keeps it in the normal e2e lane (no
// DB/relay). The pure spawn layout + wire plan are unit-tested in
// channel-columns.test.ts; this spec is the end-to-end WIRING proof.

import { test, expect, type Page } from '@playwright/test';

// ---- Deterministic ids (mirrored from graph/channel-columns.ts) ----
const VIDEO_OUT = 'workflow-videoOut';
const RECORDERBOX = 'workflow-recorderbox';
const SYNESTHESIA = 'workflow-synesthesia';
const MIX = 'pinned-mixmstrs';

// The five default edges (ids + endpoints), pinned to the def port contract.
const EXPECTED_EDGES = [
  { id: `e-${VIDEO_OUT}-out-${RECORDERBOX}-in`, src: [VIDEO_OUT, 'out'], dst: [RECORDERBOX, 'in'] },
  { id: `e-${MIX}-masterL-${RECORDERBOX}-audio_l`, src: [MIX, 'masterL'], dst: [RECORDERBOX, 'audio_l'] },
  { id: `e-${MIX}-masterR-${RECORDERBOX}-audio_r`, src: [MIX, 'masterR'], dst: [RECORDERBOX, 'audio_r'] },
  { id: `e-${MIX}-masterL-${SYNESTHESIA}-a_in`, src: [MIX, 'masterL'], dst: [SYNESTHESIA, 'a_in'] },
  { id: `e-${MIX}-masterR-${SYNESTHESIA}-b_in`, src: [MIX, 'masterR'], dst: [SYNESTHESIA, 'b_in'] },
] as const;

// ---- Scratch replica (mirror scratch-persist.spec.ts contract strings) ----
const REPLICA_DB_PREFIX = 'pt-rack-v1-';
const scratchStorageKey = (mode: 'workflow') => `pt:local-scratch-id:${mode}`;

type EdgeShape = { source: { nodeId: string; portId: string }; target: { nodeId: string; portId: string } };
type PatchView = {
  nodes: Record<string, { type?: string; data?: Record<string, unknown> } | undefined>;
  edges: Record<string, EdgeShape | undefined>;
};

async function waitForPatch(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !!(globalThis as unknown as { __patch?: unknown }).__patch,
    undefined,
    { timeout: 15_000 },
  );
}

/** Poll until the three video-zone default nodes AND the pinned mixer all exist. */
async function waitForVideoZoneTrio(page: Page): Promise<void> {
  await page.waitForFunction(
    (ids) => {
      const w = globalThis as unknown as { __patch?: PatchView };
      if (!w.__patch) return false;
      return ids.every((id) => !!w.__patch!.nodes[id]);
    },
    [VIDEO_OUT, RECORDERBOX, SYNESTHESIA, MIX],
    { timeout: 20_000 },
  );
}

/** Read the live nodes/edges snapshot. */
async function readGraph(page: Page): Promise<{
  types: string[];
  edges: Record<string, EdgeShape | undefined>;
  nodeIds: string[];
}> {
  return page.evaluate(() => {
    const w = globalThis as unknown as { __patch: PatchView };
    const nodeIds = Object.keys(w.__patch.nodes);
    const types = nodeIds.map((id) => w.__patch.nodes[id]?.type ?? '').filter(Boolean);
    return { types, edges: w.__patch.edges, nodeIds };
  }) as Promise<{ types: string[]; edges: Record<string, EdgeShape | undefined>; nodeIds: string[] }>;
}

async function replicaRowCount(page: Page, scratchId: string): Promise<number> {
  const dbName = `${REPLICA_DB_PREFIX}${scratchId}`;
  return page.evaluate(async (name) => {
    const list = (await (indexedDB as unknown as { databases?: () => Promise<{ name?: string }[]> })
      .databases?.()) ?? [];
    if (!list.some((d) => d.name === name)) return 0;
    return new Promise<number>((resolve) => {
      const req = indexedDB.open(name);
      req.onerror = () => resolve(0);
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('updates')) { db.close(); resolve(0); return; }
        const tx = db.transaction('updates', 'readonly');
        const keys = tx.objectStore('updates').getAllKeys();
        keys.onsuccess = () => { db.close(); resolve((keys.result as unknown[]).length); };
        keys.onerror = () => { db.close(); resolve(0); };
      };
    });
  }, dbName);
}

test.describe('workflow video zone defaults (recorderbox + synesthesia auto-wire)', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __ptScratchReplica?: boolean }).__ptScratchReplica = true;
    });
  });

  test('spawns exactly one videoOut/recorderbox/synesthesia and wires master A/V', async ({
    page,
  }) => {
    await page.goto('/rack?mode=workflow');
    await page.waitForLoadState('networkidle');
    await waitForPatch(page);
    await waitForVideoZoneTrio(page);

    // Exactly ONE of each type in the rack (the deterministic ids converge).
    const { types, edges } = await readGraph(page);
    for (const t of ['videoOut', 'recorderbox', 'synesthesia']) {
      expect(types.filter((x) => x === t).length, `exactly one ${t}`).toBe(1);
    }

    // Every default edge MATERIALIZES with the right endpoints.
    for (const e of EXPECTED_EDGES) {
      const edge = edges[e.id];
      expect(edge, `edge ${e.id} exists`).toBeTruthy();
      expect(edge!.source).toEqual({ nodeId: e.src[0], portId: e.src[1] });
      expect(edge!.target).toEqual({ nodeId: e.dst[0], portId: e.dst[1] });
    }
  });

  test('deleting recorderbox does NOT respawn it on reload (one-shot latch)', async ({ page }) => {
    await page.goto('/rack?mode=workflow');
    await page.waitForLoadState('networkidle');

    const idbOk = await page.evaluate(() => typeof indexedDB !== 'undefined' && indexedDB !== null);
    test.skip(!idbOk, 'IndexedDB unavailable — scratch replica cannot persist the latch');

    await waitForPatch(page);
    await waitForVideoZoneTrio(page);

    const scratchId = await page.evaluate(
      (key) => window.localStorage.getItem(key),
      scratchStorageKey('workflow'),
    );
    expect(scratchId, 'workflow scratch id minted').toBeTruthy();

    const before = await replicaRowCount(page, scratchId!);

    // Delete recorderbox + its inbound edges through the real live-doc path.
    await page.evaluate((rbId) => {
      const w = globalThis as unknown as {
        __patch: PatchView;
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        for (const [id, e] of Object.entries(w.__patch.edges)) {
          if (e && (e.source.nodeId === rbId || e.target.nodeId === rbId)) delete w.__patch.edges[id];
        }
        delete w.__patch.nodes[rbId];
      });
    }, RECORDERBOX);

    // The delete flushed to the IndexedDB replica (row count rose) — deterministic
    // signal that the reload will rehydrate the post-delete doc (latch + absence).
    await expect
      .poll(() => replicaRowCount(page, scratchId!), { timeout: 10_000 })
      .toBeGreaterThan(before);

    await page.reload();
    await page.waitForLoadState('networkidle');
    await waitForPatch(page);

    // The ensure ran again (videoOut + synesthesia rehydrated), and the pinned
    // mixer carries the recorderbox seed latch — so recorderbox stays deleted.
    await page.waitForFunction(
      (ids) => {
        const w = globalThis as unknown as { __patch?: PatchView };
        return !!w.__patch && ids.every((id) => !!w.__patch!.nodes[id]);
      },
      [VIDEO_OUT, SYNESTHESIA, MIX],
      { timeout: 20_000 },
    );
    await page.waitForFunction(
      () => (globalThis as unknown as { __patch?: PatchView }).__patch
        ?.nodes[`pinned-mixmstrs`]?.data?.workflowRecorderboxSeeded === true,
      undefined,
      { timeout: 20_000 },
    );

    // Recorderbox is gone and STAYS gone across several ensure passes.
    await expect
      .poll(async () => (await readGraph(page)).nodeIds.includes(RECORDERBOX), { timeout: 4_000 })
      .toBe(false);
  });
});

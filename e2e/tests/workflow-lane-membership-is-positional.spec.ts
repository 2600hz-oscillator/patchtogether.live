// e2e/tests/workflow-lane-membership-is-positional.spec.ts
//
// POSITION DECIDES MEMBERSHIP — the owner bug, verbatim:
//
//   "if we spawn a module on the grid outside of our lanes it should not be
//    associated with a lane. if we move an object outside of a lane it should
//    become unassociated with that lane. this doesn't work, LFO wants to be in
//    a lane when its spawned elsewhere"
//
// ROOT CAUSE. Both membership sites — the palette spawn (`wcolDropTarget`) and
// the card drag-stop (`handleNodeDragStop`) — resolved the lane with
// `columnForFlowX`, which is X-ONLY *by design*: it answers "which column's X
// band is this?" and knows nothing about Y. Used alone at a membership site it
// made the lanes INFINITELY TALL, so every point that merely SHARED a column's
// X — the whole grid above the lanes, and the video zone below the baseline —
// resolved to that channel. An LFO added anywhere in that half-plane was
// stamped `data.channel = N`, appended to the column's order array, teleported
// into the lane's flush stack and auto-wired by the reconciler.
//
// The fix is `laneTargetForFlowPoint` (channel-columns.ts): the same X test,
// gated on the band's LIVE Y extent `[laneTopY, COLUMN_BASELINE_Y)` — exactly
// the rect ChannelColumnsOverlay paints, so the hit-test and the user's eye
// agree. This spec drives the REAL seams (`__setSpawnFlowPos` +
// `__spawnFromPalette`, `__handleNodeDragStop`) rather than writing the graph,
// and covers all four directions: spawn outside, spawn inside, drag out, drag
// in.
//
// WHY BOTH POLARITIES ARE HERE. A test that only asserts "no lane" would pass
// against a hit-test that returned `null` for everything — including a fix that
// broke lane membership outright. Every "outside" leg is paired with an
// "inside" leg at the SAME X, so only the Y gate can explain the difference.
//
// Runs on /rack (the shell surface the owner reported against) in the normal
// e2e lane — no DB, no relay, no audio assertions.

import { test, expect, type Page } from '@playwright/test';

// ---------------- channel-columns.ts geometry (mirrored, as siblings do) ----

/** SHELL_COLUMN_W — the tight `?shell=1` column pitch. */
const SHELL_COLUMN_W = 216;
/** COLUMN_BASELINE_Y — COLUMN_SLOT_H(720) × COLUMN_MAX_SLOTS(6). The lane band's
 *  BOTTOM edge (the row the channel-number badges sit on); the video zone starts
 *  here. */
const COLUMN_BASELINE_Y = 4320;
/** SHELL_TILE_H_SLOT — the uniform lane tile height a shell member reserves.
 *  The drag hit-test probes the card's CENTER, so a dragged tile's probe Y is
 *  `position.y + SHELL_TILE_H_SLOT / 2`. */
const SHELL_TILE_H_SLOT = 180;

const PINNED_MIXER = 'pinned-mixmstrs';

/** X inside channel column `ch`'s band, at the shell pitch. */
const colX = (ch: number) => (ch - 1) * SHELL_COLUMN_W + 30;

// The three Y bands, chosen so they hold no matter how far the lanes have GROWN
// upward in this test (the band top is `BASELINE − max(360, tallest stack + 180)`;
// nothing here stacks more than a handful of 180px tiles).
/** Well ABOVE the lane band — free grid. This is the owner's "on the grid". */
const Y_ABOVE_LANES = 40;
/** Just inside the lane band, above the baseline. */
const Y_IN_LANE = COLUMN_BASELINE_Y - 40;
/** BELOW the baseline — inside the purple video zone, never an audio lane. */
const Y_BELOW_BASELINE = COLUMN_BASELINE_Y + 100;

/** A drag `position.y` (top-left) whose CENTER probe lands in the given band. */
const dragTopFor = (probeY: number) => probeY - SHELL_TILE_H_SLOT / 2;

// ---------------- Harness ---------------------------------------------------

async function gotoShellWorkflow(page: Page): Promise<void> {
  await page.goto('/rack');
  // 30s: first paint pays SvelteKit's on-demand route compile on a cold dev
  // server (and SwiftShader contention on CI). Measured locally: the first two
  // specs to hit /rack on a cold server blew a 15s budget while the third,
  // arriving after the route was compiled, took 5s. This is a bound on the
  // failure, not the gate — every assertion below is on graph state.
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(
    () => {
      const w = globalThis as unknown as {
        __patch?: { nodes: Record<string, { data?: { pinned?: boolean } } | undefined> };
        __setSpawnFlowPos?: unknown;
        __spawnFromPalette?: unknown;
        __handleNodeDragStop?: unknown;
      };
      return (
        typeof w.__setSpawnFlowPos === 'function' &&
        typeof w.__spawnFromPalette === 'function' &&
        typeof w.__handleNodeDragStop === 'function' &&
        !!w.__patch &&
        ['pinned-mixmstrs', 'pinned-clipplayer'].every(
          (id) => w.__patch!.nodes[id]?.data?.pinned === true,
        )
      );
    },
    undefined,
    { timeout: 30_000 },
  );
}

/** Drive the REAL palette-drop path at `pos`; returns the new node id. */
async function spawnAt(
  page: Page,
  type: string,
  pos: { x: number; y: number },
): Promise<string> {
  return page.evaluate(
    ({ type, pos }) => {
      const w = globalThis as unknown as {
        __setSpawnFlowPos: (p: { x: number; y: number }) => void;
        __spawnFromPalette: (t: string) => void;
        __patch: { nodes: Record<string, unknown> };
      };
      const before = new Set(Object.keys(w.__patch.nodes));
      w.__setSpawnFlowPos(pos);
      w.__spawnFromPalette(type);
      const added = Object.keys(w.__patch.nodes).find((id) => !before.has(id));
      if (!added) throw new Error(`spawn of ${type} added no node`);
      return added;
    },
    { type, pos },
  );
}

/** Drive the REAL drag-stop seam with the same payload SvelteFlow passes. */
async function dragTo(page: Page, id: string, pos: { x: number; y: number }): Promise<void> {
  await page.evaluate(
    ({ id, pos }) => {
      const w = globalThis as unknown as {
        __handleNodeDragStop: (p: {
          targetNode: unknown;
          nodes: { id: string; position: { x: number; y: number } }[];
        }) => void;
      };
      w.__handleNodeDragStop({ targetNode: null, nodes: [{ id, position: { ...pos } }] });
    },
    { id, pos },
  );
}

/** The membership scalar on a node — the CRDT truth the whole feature keys off. */
async function channelOf(page: Page, id: string): Promise<number | null> {
  return page.evaluate((nid) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: { channel?: number } } | undefined> };
    };
    const c = w.__patch.nodes[nid]?.data?.channel;
    return typeof c === 'number' ? c : null;
  }, id);
}

/** The pinned mixer's order array for a column — membership's other half. */
async function orderOf(page: Page, ch: number): Promise<string[]> {
  return page.evaluate((c) => {
    const w = globalThis as unknown as {
      __patch: {
        nodes: Record<string, { data?: { columns?: Record<string, string[]> } } | undefined>;
      };
    };
    return w.__patch.nodes['pinned-mixmstrs']?.data?.columns?.[String(c)] ?? [];
  }, ch);
}

/** Assert `id` is NOT in ANY column's order array — the reconciler's adopt-pass
 *  runs on every graph change, so this must stay true after it settles. */
async function inNoColumn(page: Page, id: string): Promise<boolean> {
  return page.evaluate((nid) => {
    const w = globalThis as unknown as {
      __patch: {
        nodes: Record<
          string,
          { data?: { columns?: Record<string, string[]>; sends?: Record<string, string[]> } } | undefined
        >;
      };
    };
    const d = w.__patch.nodes['pinned-mixmstrs']?.data;
    const all = [...Object.values(d?.columns ?? {}), ...Object.values(d?.sends ?? {})];
    return !all.some((arr) => (arr ?? []).includes(nid));
  }, id);
}

/** Any reconciler-owned edge touching `id`. A lane member gets wired; a free
 *  card must not. */
async function wcolEdgesTouching(page: Page, id: string): Promise<string[]> {
  return page.evaluate((nid) => {
    const w = globalThis as unknown as {
      __patch: {
        edges: Record<
          string,
          | { source: { nodeId: string; portId: string }; target: { nodeId: string; portId: string } }
          | undefined
        >;
      };
    };
    return Object.entries(w.__patch.edges)
      .filter(([eid, e]) => eid.startsWith('wcol-e-') && e && (e.source.nodeId === nid || e.target.nodeId === nid))
      .map(([, e]) => `${e!.source.nodeId}.${e!.source.portId}->${e!.target.nodeId}.${e!.target.portId}`);
  }, id);
}

// ---------------- The four directions ---------------------------------------

test.describe('workflow lanes: position decides membership', () => {
  test('SPAWN outside the lanes does not join one — inside the same column does (LFO)', async ({ page }) => {
    await gotoShellWorkflow(page);

    // (a) THE REPORTED BUG. Spawn an LFO on the free grid ABOVE the lanes, with
    // its X squarely inside column 3's band. Before the fix this was stamped
    // channel 3 and teleported into the lane's stack.
    const above = await spawnAt(page, 'lfo', { x: colX(3), y: Y_ABOVE_LANES });
    expect(await channelOf(page, above), 'LFO spawned above the lanes must have NO channel').toBeNull();

    // (b) The same X, but BELOW the baseline — the video zone, also not a lane.
    const below = await spawnAt(page, 'lfo', { x: colX(3), y: Y_BELOW_BASELINE });
    expect(await channelOf(page, below), 'LFO spawned in the video zone must have NO channel').toBeNull();

    // (c) THE PAIRED POSITIVE. Same column, inside the painted band → channel 3.
    // Without this leg, (a) and (b) would pass against a hit-test that returned
    // null for everything.
    const inside = await spawnAt(page, 'lfo', { x: colX(3), y: Y_IN_LANE });
    expect(await channelOf(page, inside), 'LFO spawned INSIDE lane 3 joins it').toBe(3);
    await expect.poll(async () => await orderOf(page, 3), { timeout: 8_000 }).toEqual([inside]);

    // The membership heal + wiring reconcile run on every graph change; give
    // them room and re-assert. The two free LFOs must stay out of every order
    // array (the adopt-pass must not claim them) and stay unwired.
    await expect
      .poll(async () => (await inNoColumn(page, above)) && (await inNoColumn(page, below)), { timeout: 8_000 })
      .toBe(true);
    expect(await channelOf(page, above)).toBeNull();
    expect(await channelOf(page, below)).toBeNull();
    expect(await wcolEdgesTouching(page, above), 'a free LFO is never auto-wired').toEqual([]);
    expect(await wcolEdgesTouching(page, below), 'a video-zone LFO is never auto-wired').toEqual([]);
  });

  test('DRAG out of a lane unassociates, and dragging back in re-associates', async ({ page }) => {
    await gotoShellWorkflow(page);

    // Start as a real lane-5 member through the real spawn path.
    const id = await spawnAt(page, 'lfo', { x: colX(5), y: Y_IN_LANE });
    expect(await channelOf(page, id)).toBe(5);
    await expect.poll(async () => await orderOf(page, 5), { timeout: 8_000 }).toEqual([id]);

    // (a) DRAG STRAIGHT UP onto the free grid — X unchanged, so ONLY the Y gate
    // can unassociate it. Before the fix the card kept channel 5 and was
    // snapped straight back into the stack.
    await dragTo(page, id, { x: colX(5), y: dragTopFor(Y_ABOVE_LANES) });
    await expect
      .poll(async () => await channelOf(page, id), { timeout: 8_000 })
      .toBeNull();
    await expect.poll(async () => await orderOf(page, 5), { timeout: 8_000 }).toEqual([]);
    await expect.poll(async () => await inNoColumn(page, id), { timeout: 8_000 }).toBe(true);
    // Unassociating retracts the reconciler-owned wiring too (that is the point
    // of the wcol- namespace: it prunes what membership no longer justifies).
    await expect.poll(async () => await wcolEdgesTouching(page, id), { timeout: 8_000 }).toEqual([]);

    // (b) DRAG BACK IN — the reverse direction, to a DIFFERENT column so the
    // assertion cannot pass on a stale value.
    await dragTo(page, id, { x: colX(2), y: dragTopFor(Y_IN_LANE) });
    await expect.poll(async () => await channelOf(page, id), { timeout: 8_000 }).toBe(2);
    await expect.poll(async () => await orderOf(page, 2), { timeout: 8_000 }).toEqual([id]);

    // (c) DRAG DOWN into the video zone — the other way out of the band.
    await dragTo(page, id, { x: colX(2), y: dragTopFor(Y_BELOW_BASELINE) });
    await expect.poll(async () => await channelOf(page, id), { timeout: 8_000 }).toBeNull();
    await expect.poll(async () => await orderOf(page, 2), { timeout: 8_000 }).toEqual([]);
  });

  test('a REORDER drag inside the lane still reorders (the Y gate does not eat in-lane drags)', async ({ page }) => {
    await gotoShellWorkflow(page);

    // Two members in lane 4. Index 0 is bottom-anchored; the tail is the top
    // tile (columnFlushPositions).
    const first = await spawnAt(page, 'lfo', { x: colX(4), y: Y_IN_LANE });
    const second = await spawnAt(page, 'lfo', { x: colX(4), y: Y_IN_LANE });
    await expect.poll(async () => await orderOf(page, 4), { timeout: 8_000 }).toEqual([first, second]);

    // Drag the TOP tile to the very bottom of the band — still inside it, so
    // this must be a REORDER, never an unassign. (The card-center probe is what
    // keeps a nudge near the band's top edge from dropping membership; this leg
    // pins the in-band case from the other end.)
    await dragTo(page, second, { x: colX(4), y: dragTopFor(COLUMN_BASELINE_Y - 10) });
    await expect.poll(async () => await orderOf(page, 4), { timeout: 8_000 }).toEqual([second, first]);
    expect(await channelOf(page, second), 'a reorder keeps membership').toBe(4);
  });
});

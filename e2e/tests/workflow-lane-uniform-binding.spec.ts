// e2e/tests/workflow-lane-uniform-binding.spec.ts
//
// EVERY MODULE BINDS TO A LANE THE SAME WAY — the #2247 owner rule, verbatim:
//
//   "all modules should be able to bind to a lane, binding automation and
//    growing the size of the lane and placing themselves correctly on top of
//    the stack in the lane. audio, video, voice or utility, all should be the
//    same in this regard and we should have no special logic or filtering.
//    the only special case is the (working) stereo autowiring of lanes, and
//    that should work in all cases, including the case where i have put
//    tidyvco in a lane, put a couple video modules on top of it, and then put
//    qbrt into the lane -- tidyvco would rewire its output through qbrt and
//    qbrt to mixmsters, ignoring any non-in-audio-path modules in the lane."
//
// WHAT ACTUALLY BROKE (the reported "fader does not snap in; videoout does").
// The membership machinery was ALREADY type-blind — the asymmetry was two
// GESTURE seams both keyed to drop geometry, which read as type filtering:
//
//   1. THE Y GATE AT THE PAINTED TOP. The band top hugs the tallest stack, so
//      the natural "drop it on top of the stack" release often ends a few px
//      ABOVE the painted line — the owner's fader was 6px short while their
//      videoOut, released lower, joined. Fixed by the REACH-UP grace
//      (laneTargetForFlowPoint topGraceY): a release within one slot above the
//      painted top still joins, and the lane grows underneath it.
//   2. DROP-TO-PATCH CLAIMING IN-BAND DROPS. resolveCardDrop claimed any
//      card-on-card release with a compatible port pair — so once a video card
//      topped a stack, dropping a second video-ported card dead-ON it snapped
//      back into the patch modal instead of joining. Fixed by the claim gate:
//      a release the SHARED laneGestureTarget resolves to a band is a
//      membership gesture, never a drop-to-patch.
//
// Drives the REAL seams (`__setSpawnFlowPos` + `__spawnFromPalette`,
// `__handleNodeDragStop`) for graph-truth legs and REAL pointer drags for the
// gesture legs, on /rack in the normal e2e lane — no DB, no relay, no audio
// assertions.

import {
  SHELL_COLUMN_W,
  COLUMN_ORIGIN_X,
  SHELL_LANE_BADGE_CLEARANCE_Y,
  computeShellLaneHeightPx,
  defaultLaneHeightPx,
  laneTopYForHeight,
} from '../../packages/web/src/lib/graph/channel-columns';
import { RACK_UNIT } from '../../packages/web/src/lib/ui/rack-grid';
import { test, expect, type Page } from '@playwright/test';
import { setFlowViewport } from './_helpers';

// ---------------- channel-columns.ts geometry (imported, never re-typed) ----

/** COLUMN_BASELINE_Y — the lane band's BOTTOM edge (badge row). */
const COLUMN_BASELINE_Y = 4320;
/** SHELL_TILE_H_SLOT — the uniform flush slot a shell lane member reserves;
 *  also the drag probe's height and the reach-up grace the drag site passes. */
const SHELL_TILE_H_SLOT = RACK_UNIT;

const PINNED_MIXER = 'pinned-mixmstrs';
const PINNED_CLIP = 'pinned-clipplayer';

/** X inside channel column `ch`'s band, at the shell pitch. */
const colX = (ch: number) => COLUMN_ORIGIN_X + (ch - 1) * SHELL_COLUMN_W + 30;

/** Well ABOVE the lane band — free grid (the owner's "on the grid"). */
const Y_ABOVE_LANES = 40;
/** Just inside the lane band, above the baseline. */
const Y_IN_LANE = COLUMN_BASELINE_Y - 40;
/** A drag `position.y` (top-left) whose CENTER probe lands at `probeY`. */
const dragTopFor = (probeY: number) => probeY - SHELL_TILE_H_SLOT / 2;

/** The LIVE painted band top for `memberCount` uniform shell tiles in the
 *  fullest lane — the same computeShellLaneHeightPx the Canvas derives it
 *  from, so the spec's "just above the painted top" is exact, not eyeballed. */
const paintedTopFor = (memberCount: number) =>
  laneTopYForHeight(
    // The default-band reference card is tidyVco's SLOT height — under the
    // shell that is the uniform tile slot (wcolCardHeightPx), NOT its 3u
    // legacy card.
    computeShellLaneHeightPx([memberCount * SHELL_TILE_H_SLOT], defaultLaneHeightPx(SHELL_TILE_H_SLOT)),
  );

// ---------------- Harness ---------------------------------------------------

async function gotoShellWorkflow(page: Page): Promise<void> {
  await page.goto('/rack');
  // 30s: first paint pays SvelteKit's on-demand route compile on a cold dev
  // server (and SwiftShader contention on CI) — a bound on the failure, not
  // the gate; every assertion below is on graph state or painted geometry.
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
async function spawnAt(page: Page, type: string, pos: { x: number; y: number }): Promise<string> {
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

/** The membership scalar on a node — the CRDT truth the feature keys off. */
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

/** The pinned clip player's automation binding for a module (0-based lane). */
async function autoLaneOf(page: Page, id: string): Promise<number | null> {
  return page.evaluate((nid) => {
    const w = globalThis as unknown as {
      __patch: {
        nodes: Record<string, { data?: { autoAssign?: Record<string, number> } } | undefined>;
      };
    };
    const a = w.__patch.nodes['pinned-clipplayer']?.data?.autoAssign?.[nid];
    return typeof a === 'number' ? a : null;
  }, id);
}

/** Every reconciler-owned edge, as `src.port->dst.port` strings. */
async function wcolEdges(page: Page): Promise<string[]> {
  return page.evaluate(() => {
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
      .filter(([eid, e]) => eid.startsWith('wcol-e-') && !!e)
      .map(([, e]) => `${e!.source.nodeId}.${e!.source.portId}->${e!.target.nodeId}.${e!.target.portId}`);
  });
}

/** Project a FLOW point to SCREEN px via the live SvelteFlow viewport. */
async function flowToScreen(page: Page, flow: { x: number; y: number }): Promise<{ x: number; y: number }> {
  return page.evaluate((p) => {
    const pane = document.querySelector('.svelte-flow')!;
    const vp = document.querySelector('.svelte-flow__viewport') as HTMLElement;
    const rect = pane.getBoundingClientRect();
    const m = new DOMMatrixReadOnly(getComputedStyle(vp).transform);
    return { x: rect.x + m.e + p.x * m.a, y: rect.y + m.f + p.y * m.d };
  }, flow);
}

/** REAL pointer drag: grab `id` by its header strip, release its TOP-LEFT at
 *  flow `toTopLeft`. The grab point rides the card, so the released top-left
 *  is exact — the drop rule probes the card, not the cursor. */
async function dragCardToFlow(page: Page, id: string, toTopLeft: { x: number; y: number }): Promise<void> {
  const box = (await page.locator(`.svelte-flow__node[data-id="${id}"]`).boundingBox())!;
  const target = await flowToScreen(page, toTopLeft);
  const gx = box.x + box.width / 2;
  const gy = box.y + 14; // header strip — never a knob or the fader control
  const tx = target.x + box.width / 2;
  const ty = target.y + 14;
  await page.mouse.move(gx, gy);
  await page.mouse.down();
  // 5 interpolation steps, not 16: every move fires drag-over work + a frame,
  // and CI's software renderer runs ~8 fps — 16 heavy frames blew a 30 s test
  // budget INSIDE mouse.move (e2e shard 9, twice). Five is still enough for
  // xyflow's drag threshold and the membership hit-test only reads the RELEASE.
  for (let i = 1; i <= 5; i++) {
    await page.mouse.move(gx + ((tx - gx) * i) / 5, gy + ((ty - gy) * i) / 5);
  }
  await page.mouse.up();
}

const scrim = (page: Page) => page.locator('[data-testid="patch-drop-scrim"]');

/** Wait for the fitView transition to SETTLE: the live viewport transform is
 *  identical across two consecutive rAF polls (a state poll on the real
 *  subject — never a wall-clock budget, #1523). */
async function viewportSettled(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const vp = document.querySelector('.svelte-flow__viewport');
    if (!vp) return false;
    const t = getComputedStyle(vp).transform;
    const w = globalThis as unknown as { __vpPrev?: string };
    const same = w.__vpPrev === t;
    w.__vpPrev = t;
    return same;
  });
}

// ---------------- The uniform-binding legs -----------------------------------

test.describe('workflow lanes: every module type binds identically', () => {
  test('UNIFORM: fader and videoOut joined by the same gesture get the same binding (channel + order + automation)', async ({ page }) => {
    await gotoShellWorkflow(page);
    const fader = await spawnAt(page, 'fader', { x: colX(6) + 400, y: Y_ABOVE_LANES });
    const vout = await spawnAt(page, 'videoOut', { x: colX(6) + 700, y: Y_ABOVE_LANES });
    await dragTo(page, vout, { x: colX(3), y: dragTopFor(Y_IN_LANE) });
    await dragTo(page, fader, { x: colX(3), y: dragTopFor(Y_IN_LANE) });
    // SAME channel, BOTH in the order array (newest on top = last), BOTH bound
    // to the lane's automation (0-based lane = ch-1). No type gets less.
    expect(await channelOf(page, vout)).toBe(3);
    expect(await channelOf(page, fader)).toBe(3);
    expect(await orderOf(page, 3)).toEqual([vout, fader]);
    await expect.poll(() => autoLaneOf(page, vout)).toBe(2);
    await expect.poll(() => autoLaneOf(page, fader)).toBe(2);
  });

  test('REACH-UP: a REAL drop released just ABOVE the painted band top still joins, and the lane grows to meet it', async ({ page }) => {
    // Pointer-drag legs pay the CI software renderer's frame rate (~8 fps
    // measured) across spawn + fitless framing + a real drag — a bound, not a
    // gate: every assertion below is on graph state.
    test.setTimeout(120_000);
    await gotoShellWorkflow(page);
    // The owner's exact state: an audio source in the lane with a videoOut on
    // top of it — the stack whose top the next card is dropped onto.
    const vco = await spawnAt(page, 'tidyVco', { x: colX(1), y: Y_IN_LANE });
    const vout = await spawnAt(page, 'videoOut', { x: colX(6) + 700, y: Y_ABOVE_LANES });
    await dragTo(page, vout, { x: colX(1), y: dragTopFor(Y_IN_LANE) });
    expect(await orderOf(page, 1)).toEqual([vco, vout]);
    const fader = await spawnAt(page, 'fader', { x: colX(5) + 60, y: Y_IN_LANE - 900 });
    // Deterministic framing: setViewport is INSTANT (no fitView transition to
    // race on a slow CI renderer — the settle poll could pass before the
    // animation even started, and the drag then read pre-move coordinates).
    // z=0.5 anchored to show the fader spawn AND the lane band bottom.
    await setFlowViewport(page, { x: 60, y: 40 - (Y_IN_LANE - 1000) * 0.5, zoom: 0.5 });
    await viewportSettled(page);
    // Release the fader with its probe 30px ABOVE the live painted top — the
    // owner's screenshot geometry (their fader's bottom edge was 6px shy of
    // the line). Inside the one-slot reach-up; REFUSED before #2247's grace.
    const paintedTop = paintedTopFor(2);
    await dragCardToFlow(page, fader, {
      x: colX(1),
      y: paintedTop - 30 - SHELL_TILE_H_SLOT / 2,
    });
    await expect.poll(() => channelOf(page, fader)).toBe(1);
    expect(await orderOf(page, 1)).toEqual([vco, vout, fader]);
    await expect(scrim(page)).toHaveCount(0);
    // Automation bound like any member, and the stack placed it on TOP: its
    // rendered tile sits directly above the videoOut's (position = render
    // output — the flush layout, not the release point).
    await expect.poll(() => autoLaneOf(page, fader)).toBe(0);
    const fBox = (await page.locator(`.svelte-flow__node[data-id="${fader}"]`).boundingBox())!;
    const vBox = (await page.locator(`.svelte-flow__node[data-id="${vout}"]`).boundingBox())!;
    expect(Math.abs(fBox.y + fBox.height - vBox.y)).toBeLessThan(2);
  });

  test('STACK DROP: releasing a card dead-ON the stack top card JOINS — never drop-to-patch, even for a compatible pair', async ({ page }) => {
    // Pointer-drag legs pay the CI software renderer's frame rate (~8 fps
    // measured) across spawn + fitless framing + a real drag — a bound, not a
    // gate: every assertion below is on graph state.
    test.setTimeout(120_000);
    await gotoShellWorkflow(page);
    // videoOut tops the stack; fader.out(video) → videoOut.in(video) is a
    // compatible pair, so before the claim gate this drop snapped back into
    // the patch modal — the exact "fader will not snap in" report.
    const vco = await spawnAt(page, 'tidyVco', { x: colX(2), y: Y_IN_LANE });
    const vout = await spawnAt(page, 'videoOut', { x: colX(6) + 700, y: Y_ABOVE_LANES });
    await dragTo(page, vout, { x: colX(2), y: dragTopFor(Y_IN_LANE) });
    const fader = await spawnAt(page, 'fader', { x: colX(5) + 60, y: Y_IN_LANE - 900 });
    // Deterministic framing — see the REACH-UP leg's note.
    await setFlowViewport(page, { x: 60, y: 40 - (Y_IN_LANE - 1000) * 0.5, zoom: 0.5 });
    await viewportSettled(page);
    // Dead-centre onto the videoOut tile: top-left = the tile's own flush
    // slot (the stack anchors one badge clearance above the baseline).
    const voutFlowTop = COLUMN_BASELINE_Y - SHELL_LANE_BADGE_CLEARANCE_Y - 2 * SHELL_TILE_H_SLOT;
    await dragCardToFlow(page, fader, { x: colX(2), y: voutFlowTop });
    await expect.poll(() => channelOf(page, fader)).toBe(2);
    expect(await orderOf(page, 2)).toContain(fader);
    await expect(scrim(page)).toHaveCount(0);
    void vco;
  });

  test('AUTOWIRE: the stereo chain threads through audio members ONLY — tidyVco → qbrt → mixer across interleaved video modules', async ({ page }) => {
    await gotoShellWorkflow(page);
    // The owner's scenario verbatim: tidyVco in a lane, a couple of video
    // modules on top of it, THEN qbrt — the chain must rewire vco → qbrt →
    // mixmstrs, ignoring the non-audio-path members entirely.
    const vco = await spawnAt(page, 'tidyVco', { x: colX(5), y: Y_IN_LANE });
    const com1 = await spawnAt(page, 'colourofmagic', { x: colX(7) + 400, y: Y_ABOVE_LANES });
    const com2 = await spawnAt(page, 'colourofmagic', { x: colX(7) + 700, y: Y_ABOVE_LANES });
    const qbrt = await spawnAt(page, 'qbrt', { x: colX(7) + 1000, y: Y_ABOVE_LANES });
    await dragTo(page, com1, { x: colX(5), y: dragTopFor(Y_IN_LANE) });
    await dragTo(page, com2, { x: colX(5), y: dragTopFor(Y_IN_LANE) });
    await dragTo(page, qbrt, { x: colX(5), y: dragTopFor(Y_IN_LANE) });
    expect(await orderOf(page, 5)).toEqual([vco, com1, com2, qbrt]);

    // The reconciler settles on the next graph pass — poll the edge set.
    await expect
      .poll(async () => (await wcolEdges(page)).filter((e) => e.startsWith(`${vco}.`) && e.includes(`->${qbrt}.`)).length)
      .toBeGreaterThan(0);
    const edges = await wcolEdges(page);
    // qbrt (the tail FX) sends to the mixer; the head does NOT go direct.
    expect(edges.some((e) => e.startsWith(`${qbrt}.`) && e.includes(`->${PINNED_MIXER}.`))).toBe(true);
    expect(edges.some((e) => e.startsWith(`${vco}.`) && e.includes(`->${PINNED_MIXER}.`))).toBe(false);
    // The video members are NOT in the audio path: no reconciler edge touches
    // them, in either direction.
    for (const vid of [com1, com2]) {
      expect(edges.filter((e) => e.includes(`${vid}.`)), `wcol edges touching ${vid}`).toEqual([]);
    }
    // …but they are STILL full lane members: automation-bound like the rest.
    for (const id of [vco, com1, com2, qbrt]) {
      await expect.poll(() => autoLaneOf(page, id), `${id} automation lane`).toBe(4);
    }
    void PINNED_CLIP;
  });
});

// e2e/tests/video-pull-eval.spec.ts
//
// SINK-DRIVEN PULL EVALUATION (stack-study adoption item 1) — the real-app
// gate: a heavy UNWATCHED generator chain must cost ZERO render work while a
// watched OUTPUT chain keeps its cadence.
//
// DETERMINISM: every assertion reads ENGINE PROBES (pullStats / framesDrawn
// counters), never pixel timing — SwiftShader-tolerant by construction. The
// "unwatched" condition is produced the way a user produces it: the heavy
// cards are spawned FAR outside the viewport, so the Canvas-level
// IntersectionObserver demotes their preview blits and the engine's pull walk
// drops them once the spawn grace decays (~1.5s). Cadence is asserted as a
// RATIO of per-node draw counts between two probe samples — the watched sink
// must advance 1:1 with the engine frame counter while the heavies advance 0.

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

/** The far-offscreen X the heavy generators are MOVED to after mount (well
 *  beyond any viewport at default zoom, plus the observer's 300px pre-wake
 *  margin). They spawn NEAR first — SvelteFlow's initial fitView spans every
 *  node, so spawning them far would push the whole rack (including the
 *  watched OUTPUT) out of the viewport. Moving them after the fit mimics the
 *  real user flow: build a patch, pan the heavy corner out of sight. */
const FAR_X = 24000;

/** Move a set of nodes to far-offscreen positions via the same dev-mode store
 *  globals spawnPatch uses (one Yjs transact). */
async function moveNodesFar(page: Page, ids: string[]): Promise<void> {
  await page.evaluate(
    ({ ids: nodeIds, farX }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { position: { x: number; y: number } }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        nodeIds.forEach((id, i) => {
          const n = w.__patch.nodes[id];
          if (n) n.position = { x: farX + (i % 2) * 480, y: 80 + Math.floor(i / 2) * 540 };
        });
      });
    },
    { ids, farX: FAR_X },
  );
}

interface PullProbe {
  frames: number;
  skipped: string[];
  evaluated: string[];
  enabled: boolean;
  drawn: Record<string, number>;
}

async function probe(page: Page, ids: string[]): Promise<PullProbe> {
  return page.evaluate((nodeIds) => {
    const w = globalThis as unknown as {
      __engine: () => {
        getDomain: (d: string) => {
          currentFrameCount: () => number;
          pullStats: () => { enabled: boolean; evaluated: string[]; skipped: string[] };
          framesDrawnFor: (id: string) => number;
        };
      };
    };
    const vid = w.__engine().getDomain('video');
    const stats = vid.pullStats();
    const drawn: Record<string, number> = {};
    for (const id of nodeIds) drawn[id] = vid.framesDrawnFor(id);
    return {
      frames: vid.currentFrameCount(),
      skipped: stats.skipped,
      evaluated: stats.evaluated,
      enabled: stats.enabled,
      drawn,
    };
  }, ids);
}

const HEAVIES = ['h1', 'h2', 'h3'];
const ALL = ['src', 'out', ...HEAVIES];

function pullPatchNodes() {
  return [
    { id: 'src', type: 'shapes', position: { x: 80, y: 80 }, domain: 'video' as const },
    { id: 'out', type: 'videoOut', position: { x: 560, y: 80 }, domain: 'video' as const },
    // Heavy generator chain (spirographs feeding lines — a real 2-node
    // subgraph, so the walk must skip a CHAIN, not just leaves) + one more
    // standalone generator. Spawned near (so fitView keeps the OUTPUT in
    // view), then moved far offscreen by moveNodesFar().
    { id: 'h1', type: 'spirographs', position: { x: 80, y: 560 }, domain: 'video' as const },
    { id: 'h2', type: 'lines', position: { x: 560, y: 560 }, domain: 'video' as const },
    { id: 'h3', type: 'spirographs', position: { x: 1040, y: 560 }, domain: 'video' as const },
  ];
}

function pullPatchEdges() {
  return [
    { id: 'e1', from: { nodeId: 'src', portId: 'out' }, to: { nodeId: 'out', portId: 'in' }, sourceType: 'mono-video', targetType: 'video' },
    // h1 -> h2 (fm input, mono-video): an UNWATCHED chain, not just isolated
    // leaves. Nothing downstream of h2 is observed. (spirographs' mono_out is
    // the mono-video matte — type-compatible with LINES' fm input.)
    { id: 'e2', from: { nodeId: 'h1', portId: 'mono_out' }, to: { nodeId: 'h2', portId: 'fm' }, sourceType: 'mono-video', targetType: 'mono-video' },
  ];
}

test.describe('video pull evaluation — unwatched chains cost zero', () => {
  test('offscreen generator chain stops drawing; watched OUTPUT keeps 1:1 cadence', async ({ page, errorWatch }) => {
    test.setTimeout(60_000);

    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, pullPatchNodes(), pullPatchEdges());

    await expect(page.locator('[data-testid="video-out-card"]'), 'output card mounted').toHaveCount(1);

    // Pan the heavy corner out of sight (the user flow pull-eval targets).
    await moveNodesFar(page, HEAVIES);

    // Wait for the spawn grace to decay + the IntersectionObserver to demote
    // the far cards: the pull walk must classify all three heavies as
    // SKIPPED. Bounded by real engine state, not a fixed sleep.
    await expect
      .poll(async () => {
        const p = await probe(page, ALL);
        return HEAVIES.every((h) => p.skipped.includes(h));
      }, { message: 'all far-offscreen heavies classified skipped', timeout: 20_000 })
      .toBe(true);

    // Two samples a bunch of engine frames apart: the watched chain advances
    // 1:1 with the engine frame counter; the heavies advance ZERO.
    const s1 = await probe(page, ALL);
    await expect
      .poll(async () => (await probe(page, ALL)).frames - s1.frames, {
        message: 'engine advanced ≥30 frames between samples',
        timeout: 15_000,
      })
      .toBeGreaterThanOrEqual(30);
    const s2 = await probe(page, ALL);

    const engineDelta = s2.frames - s1.frames;
    const srcDelta = s2.drawn.src! - s1.drawn.src!;
    const outDelta = s2.drawn.out! - s1.drawn.out!;
    expect(s2.enabled, 'pull eval is ON by default').toBe(true);
    // Watched sink + its source render every engine frame (full cadence).
    expect(outDelta, `OUTPUT drew ${outDelta}/${engineDelta} frames`).toBe(engineDelta);
    expect(srcDelta, `source drew ${srcDelta}/${engineDelta} frames`).toBe(engineDelta);
    // The unwatched heavies cost ZERO draws.
    for (const h of HEAVIES) {
      expect(s2.drawn[h]! - s1.drawn[h]!, `heavy ${h} drew 0 frames while unwatched`).toBe(0);
    }

    // The OUTPUT actually shows the watched source (floors only — content
    // varies, renderer varies; this is a sanity check that skipping the
    // heavies didn't take the watched chain dark).
    const nonBlack = await page
      .locator('[data-testid="video-out-canvas"]')
      .evaluate((el) => {
        const c = el as HTMLCanvasElement;
        const ctx = c.getContext('2d');
        if (!ctx) return 0;
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        let nonZero = 0;
        for (let i = 0; i < d.length; i += 16 * 4) {
          const v = (d[i]! + d[i + 1]! + d[i + 2]!) / 3;
          if (v > 8) nonZero++;
          n++;
        }
        return nonZero / n;
      });
    expect(nonBlack, 'watched OUTPUT stays live (non-black)').toBeGreaterThan(0.02);
  });

  test('kill switch (__videoPullEval=false) restores push evaluation for the same patch', async ({ page, errorWatch }) => {
    test.setTimeout(60_000);

    await page.addInitScript(() => {
      (globalThis as unknown as { __videoPullEval?: boolean }).__videoPullEval = false;
    });

    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, pullPatchNodes(), pullPatchEdges());
    await expect(page.locator('[data-testid="video-out-card"]')).toHaveCount(1);
    await moveNodesFar(page, HEAVIES);

    // Give the same decay window a chance (grace + observer), then verify the
    // heavies KEEP drawing — the kill switch means no node is ever skipped.
    const s1 = await probe(page, ALL);
    await expect
      .poll(async () => (await probe(page, ALL)).frames - s1.frames, {
        message: 'engine advanced ≥30 frames between samples',
        timeout: 15_000,
      })
      .toBeGreaterThanOrEqual(30);
    const s2 = await probe(page, ALL);

    expect(s2.enabled, 'pull eval reports disabled').toBe(false);
    expect(s2.skipped, 'nothing is ever skipped with the kill switch').toEqual([]);
    const engineDelta = s2.frames - s1.frames;
    for (const h of HEAVIES) {
      expect(
        s2.drawn[h]! - s1.drawn[h]!,
        `heavy ${h} draws every frame with pull eval off`,
      ).toBe(engineDelta);
    }
  });
});

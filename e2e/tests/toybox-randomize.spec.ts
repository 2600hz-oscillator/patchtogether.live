// e2e/tests/toybox-randomize.spec.ts
//
// TOYBOX RANDOMIZE (#1576, workstream 5) — the dice button, end to end.
//
// ── WHERE THIS RUNS ─────────────────────────────────────────────────────────
// This file matches `**/toybox-*.spec.ts` (a WEBGL_HEAVY glob), so on a PR the
// sharded lanes SKIP it entirely. Exactly ONE test below is tagged
// `@webgl-smoke` — the REQUIRED smoke job leaves E2E_WEBGL_HEAVY unset and
// selects by grep, so that tag is the ONLY reason the floor test executes on a
// PR (same discipline as toybox-shader-validate.spec.ts). The 20-seed sweep +
// the real-source-chain + undo/revert proofs live in the heavy lane.
//
// ── DETERMINISM ────────────────────────────────────────────────────────────
// Every roll here goes through `__toyboxRoll(seed)` (ToyboxCard) — the same
// probe → generate → one-transact apply path the button uses, but seeded, so a
// CI failure names a seed that replays locally. A SEEDED roll deliberately
// ignores the card's anti-repeat memory (replayability, prior-art R19); the
// anti-repeat property itself is unit-owned (toybox-random.test.ts).
//
// ── WAITS ──────────────────────────────────────────────────────────────────
// Paint readiness is polled INSIDE the page under a pinned engine clock
// (`__toyboxFreeze(t)` + a lit-pixel accumulator, the toybox-video-inputs
// pattern) — no waitForTimeout, no Playwright-side pixel polling. Wall-clock
// caps only BOUND the failure.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch, type SpawnEdge, type SpawnNode } from './_helpers';

interface RollResultShape {
  archetypeId: string;
  seed: number;
  fellBack: boolean;
  blob: {
    layers: Array<{ kind: string; videoSource?: string; contentId?: string | null }>;
    combine: { nodes: Array<{ id: string; kind: string; layer?: number }>; edges: Array<{ from: string; to: string }> };
    cvRoutes: Record<string, unknown>;
  };
}

type G = {
  __toyboxRoll?: (seed?: number) => Promise<RollResultShape | null>;
  __toyboxFreeze?: (t?: number) => void;
  __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
  __ydoc: { transact: (fn: () => void) => void };
};

/** Spawn a lone TOYBOX (id 'tb') and wait for the card + the roll hook. */
async function spawnToybox(page: Page, extraNodes: SpawnNode[] = [], edges: SpawnEdge[] = []): Promise<void> {
  await page.goto('/rack?shell=legacy&seed=none');
  await page.waitForLoadState('networkidle');
  const nodes: SpawnNode[] = [
    { id: 'tb', type: 'toybox', position: { x: 420, y: 40 }, domain: 'video' },
    ...extraNodes,
  ];
  await spawnPatch(page, nodes, edges);
  await page.locator('.svelte-flow__node-toybox').first().waitFor({ state: 'visible', timeout: 10_000 });
  await expect
    .poll(() => page.evaluate(() => typeof (globalThis as unknown as G).__toyboxRoll), {
      message: '__toyboxRoll hook must be installed by ToyboxCard',
    })
    .toBe('function');
}

/** Roll with an explicit seed through the card hook; returns the roll result. */
async function roll(page: Page, seed: number): Promise<RollResultShape> {
  const res = await page.evaluate(
    (seed) => (globalThis as unknown as G).__toyboxRoll!(seed),
    seed,
  );
  expect(res, `roll(seed=${seed}) applied`).not.toBeNull();
  return res!;
}

/** THIS node's live data as plain JSON (for change/undo assertions). */
async function dataSnapshot(page: Page): Promise<string> {
  return page.evaluate(() => {
    const n = (globalThis as unknown as G).__patch.nodes['tb'];
    return JSON.stringify(n?.data ?? null);
  });
}

/** A snapshot reduced to the fields undo/revert are ANSWERABLE for.
 *  `combineView` is CARD-managed layout state (auto-resized when the graph
 *  changes) and outside the roll scope in both directions — comparing it
 *  would pin a UI side effect, not the feature. */
function rollScope(json: string): unknown {
  const d = JSON.parse(json) as Record<string, unknown> | null;
  if (d && typeof d === 'object') delete d.combineView;
  return d;
}

/**
 * Pin the engine clock and poll IN-PAGE until the toybox preview canvas is
 * LIT (>2% of pixels above the near-black floor — the toybox-video-inputs
 * threshold, satisfied by any rendered content and NOT by a black frame).
 * Reports the last lit fraction in the failure message (units: fraction of
 * canvas pixels). Unfreezes afterwards so the next roll renders live.
 */
async function expectAlive(page: Page, freezeTime: number, label: string): Promise<void> {
  try {
    await page.waitForFunction(
      ({ freezeTime }) => {
        const g = globalThis as unknown as G;
        g.__toyboxFreeze?.(freezeTime);
        const canvas = document.querySelector(
          '[data-testid="toybox-canvas"]',
        ) as HTMLCanvasElement | null;
        if (!canvas) return false;
        const c2d = canvas.getContext('2d');
        if (!c2d) return false;
        const { data } = c2d.getImageData(0, 0, canvas.width, canvas.height);
        let lit = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i]! > 6 || data[i + 1]! > 6 || data[i + 2]! > 6) lit++;
        }
        const w = globalThis as unknown as { __rollLitFraction?: number };
        w.__rollLitFraction = lit / (canvas.width * canvas.height);
        return w.__rollLitFraction > 0.02;
      },
      { freezeTime },
      { timeout: 30_000 },
    );
  } catch (err) {
    const frac = await page
      .evaluate(() => (globalThis as unknown as { __rollLitFraction?: number }).__rollLitFraction)
      .catch(() => undefined);
    throw new Error(
      `${label}: canvas never lit (last lit fraction ${frac ?? 'n/a'} of pixels; floor 0.02)`,
      { cause: err },
    );
  } finally {
    await page.evaluate(() => (globalThis as unknown as G).__toyboxFreeze?.());
  }
}

// ---------------------------------------------------------------------------
// FLOOR (@webgl-smoke — the PR lane's proof the feature works at all)
// ---------------------------------------------------------------------------

test('@webgl-smoke three seeded rolls each apply a NEW patch and render non-black', async ({ page }) => {
  // 3 freeze-captures on SwiftShader (ci-swiftshader-video-e2e-timeouts: ≥90s,
  // scaled by capture count).
  test.setTimeout(150_000);
  await spawnToybox(page);
  let prev = await dataSnapshot(page);
  const seeds = [11, 22, 33];
  for (const seed of seeds) {
    const res = await roll(page, seed);
    expect(res.blob.layers.length, `seed ${seed}: layer array`).toBe(4);
    const next = await dataSnapshot(page);
    expect(next, `seed ${seed}: roll must change node.data`).not.toEqual(prev);
    prev = next;
    await expectAlive(page, 3 + seed, `seed ${seed}`);
  }
});

// ---------------------------------------------------------------------------
// HEAVY LANE — the full acceptance floor
// ---------------------------------------------------------------------------

test.describe('toybox randomize — heavy proofs', () => {
  test('20 consecutive seeded rolls: every one applies and renders non-black', async ({ page }) => {
    // 20 freeze-captures on SwiftShader — the priciest test in this file, and
    // deliberately NOT on the PR lane (heavy serialized lane only).
    test.setTimeout(420_000);
    await spawnToybox(page);
    const seeds = Array.from({ length: 20 }, (_, i) => 101 + i * 37);
    const archetypes = new Set<string>();
    let prev = await dataSnapshot(page);
    for (const seed of seeds) {
      const res = await roll(page, seed);
      archetypes.add(res.archetypeId);
      const next = await dataSnapshot(page);
      expect(next, `seed ${seed}: roll must change node.data`).not.toEqual(prev);
      prev = next;
      await expectAlive(page, 5 + seed, `sweep seed ${seed}`);
    }
    // Variety floor across the sweep — more than one structural family
    // (perceptual distinctness is the owner's review pass; this is the
    // machine-checkable floor, prior-art §6).
    expect(archetypes.size, `archetypes seen: ${[...archetypes].join(', ')}`).toBeGreaterThan(1);
  });

  test('REAL source chain: a patched video feed + LFO cv are load-bearing in every roll', async ({ page }) => {
    test.setTimeout(180_000);
    // The poly/MIDI "real default-mode source" rule transposed to video: a
    // REAL producer (ACIDWARP) through the REAL rack graph into inA, a REAL
    // LFO into cv1 — not synthetic context objects.
    await spawnToybox(
      page,
      [
        { id: 'acid', type: 'acidwarp', position: { x: 60, y: 40 }, domain: 'video' },
        { id: 'mod', type: 'lfo', position: { x: 60, y: 320 } },
      ],
      [
        {
          id: 'e-feed',
          from: { nodeId: 'acid', portId: 'out' },
          to: { nodeId: 'tb', portId: 'inA' },
          sourceType: 'video',
          targetType: 'video',
        },
        {
          id: 'e-cv',
          from: { nodeId: 'mod', portId: 'phase0' },
          to: { nodeId: 'tb', portId: 'cv1' },
          sourceType: 'cv',
          targetType: 'cv',
        },
      ],
    );
    for (const seed of [4242, 4243]) {
      const res = await roll(page, seed);
      // (a) the patched feed is a video layer in the applied blob…
      const vidIdx = res.blob.layers.findIndex(
        (l) => l.kind === 'video' && l.videoSource === 'inA',
      );
      expect(vidIdx, `seed ${seed}: rolled layers must include a video layer on inA`).toBeGreaterThanOrEqual(0);
      // (b) …and its SOURCE node reaches OUT (load-bearing, not decorative).
      const bearing = await page.evaluate((vidIdx) => {
        const n = (globalThis as unknown as G).__patch.nodes['tb'];
        const combine = (n?.data as { combine?: RollResultShape['blob']['combine'] })?.combine;
        if (!combine) return false;
        const into = new Map<string, string[]>();
        for (const e of combine.edges) {
          if (!into.has(e.to)) into.set(e.to, []);
          into.get(e.to)!.push(e.from);
        }
        const seen = new Set<string>();
        const stack = ['out'];
        while (stack.length) {
          const cur = stack.pop()!;
          if (seen.has(cur)) continue;
          seen.add(cur);
          for (const p of into.get(cur) ?? []) stack.push(p);
        }
        return combine.nodes.some(
          (nd) => nd.kind === 'source' && nd.layer === vidIdx && seen.has(nd.id),
        );
      }, vidIdx);
      expect(bearing, `seed ${seed}: the inA video layer must reach OUT`).toBe(true);
      // (c) the patched cv port owns a route in the applied state.
      expect(res.blob.cvRoutes['cv1'], `seed ${seed}: cv1 must be routed`).toBeTruthy();
      // (d) rack edges were NOT touched by the roll.
      const edgeIds = await page.evaluate(() =>
        Object.keys((globalThis as unknown as { __patch: { edges: Record<string, unknown> } }).__patch.edges).sort(),
      );
      expect(edgeIds).toEqual(['e-cv', 'e-feed']);
      // (e) and the composite is alive with the feed in it.
      await expectAlive(page, 7 + seed, `real-chain seed ${seed}`);
    }
  });

  test('one Cmd-Z reverts ONE roll; REVERT restores the pre-session patch', async ({ page }) => {
    test.setTimeout(150_000);
    await spawnToybox(page);
    // Seed a RECOGNIZABLE pre-roll state (fresh nodes may have no data yet —
    // seeding makes the restore point deterministic and the REVERT button's
    // target unambiguous).
    await page.evaluate(() => {
      const g = globalThis as unknown as G;
      g.__ydoc.transact(() => {
        const n = g.__patch.nodes['tb'];
        if (!n) return;
        if (!n.data) n.data = {};
        n.data.name = 'pre-roll toybox';
        n.data.layers = [
          { kind: 'gen', contentId: 'noise-fbm', params: {} },
          { kind: 'off', contentId: null, params: {} },
          { kind: 'off', contentId: null, params: {} },
          { kind: 'off', contentId: null, params: {} },
        ];
      });
    });
    const data0 = await dataSnapshot(page);

    const first = await roll(page, 501);
    expect(first.blob.layers.length).toBe(4);
    const data1 = await dataSnapshot(page);
    expect(data1).not.toEqual(data0);

    await roll(page, 502);
    const data2 = await dataSnapshot(page);
    expect(data2).not.toEqual(data1);

    // ONE undo = ONE roll (the second), never half a roll and never both.
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Meta+z');
    await expect
      .poll(async () => rollScope(await dataSnapshot(page)), {
        message: 'Cmd-Z must restore the FIRST roll exactly (roll scope)',
      })
      .toEqual(rollScope(data1));

    // REVERT restores the pre-session patch (R22) — visible only after a roll.
    // The seeded pre-roll data had NO combine/cvRoutes keys, so the restore
    // must DELETE them (a restore that leaves the last roll's graph underneath
    // the restored layers is the bug this fixture exists to catch).
    const revert = page.getByTestId('toybox-randomize-revert');
    await expect(revert).toBeVisible();
    await revert.click();
    await expect
      .poll(async () => rollScope(await dataSnapshot(page)), {
        message: 'REVERT must restore the pre-roll data blob (roll scope)',
      })
      .toEqual(rollScope(data0));
  });

  test('the dice BUTTON itself rolls (the real gesture, not just the hook)', async ({ page }) => {
    test.setTimeout(120_000);
    await spawnToybox(page);
    const before = await dataSnapshot(page);
    const dice = page.getByTestId('toybox-randomize');
    await expect(dice).toBeVisible();
    await dice.click();
    await expect
      .poll(() => dataSnapshot(page), { message: 'a dice press must write a rolled patch' })
      .not.toEqual(before);
    await expectAlive(page, 9, 'button roll');
  });
});

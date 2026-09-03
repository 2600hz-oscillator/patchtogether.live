// e2e/tests/toybox-randomize.spec.ts
//
// TOYBOX RANDOMIZE (#1576, workstreams 3+4+5) — the dice button, end to end.
//
// ── WHERE THIS RUNS ─────────────────────────────────────────────────────────
// This file matches `**/toybox-*.spec.ts` (a WEBGL_HEAVY glob), so on a PR the
// sharded lanes SKIP it entirely. Exactly ONE test below is tagged
// `@webgl-smoke` — the REQUIRED smoke job leaves E2E_WEBGL_HEAVY unset and
// selects by grep, so that tag is the ONLY reason the floor test executes on a
// PR (same discipline as toybox-shader-validate.spec.ts). Everything else
// lives in the heavy lane.
//
// ── THE PROBE, AND WHY IT IS PERCEPTUAL (the 2026-08-20 owner-black lesson) ─
// The first version of this spec counted a pixel "lit" at >6/255 and certified
// frames the owner correctly called SOLID BLACK: star-field solo measures mean
// 8.8/255 with ZERO pixels above 40/255 — litFrac(>6) = 1.0, a perfect pass on
// a dead-looking frame. The probe now demands PERCEPTIBLE output — a real
// fraction of pixels above 40/255 AND a mean floor — sampled TWICE on the LIVE
// clock (a second sample ~45 frames later, so a transient bright start cannot
// certify a state that settles dark). `star-field solo must FAIL the probe` is
// the permanent negative control of the instrument itself.
//
// Floor values are calibrated off the measured GEN catalog (2026-08-20 audit):
// star-field 0.000/8.8 (must FAIL), truchet 0.179/38.5 (dimmest content that
// must PASS). Units: fraction of canvas pixels above 40/255, and mean of the
// per-pixel max channel (0..255).
//
// ── DETERMINISM ────────────────────────────────────────────────────────────
// Rolls go through `__toyboxRoll(seed)` (ToyboxCard) — the same probe →
// generate → one-transact apply path as the button, but seeded, so a CI
// failure names a seed that replays locally. Waits are frame-based (rAF in
// page) or auto-retrying polls; wall-clock caps only bound the failure.

import { test, expect, type Page } from '@playwright/test';
import { ensureCombineOpen, spawnPatch, type SpawnEdge, type SpawnNode } from './_helpers';

interface RollResultShape {
  archetypeId: string;
  seed: number;
  fellBack: boolean;
  blob: {
    layers: Array<{ kind: string; videoSource?: string; contentId?: string | null; locked?: boolean }>;
    combine: {
      nodes: Array<{ id: string; kind: string; layer?: number; locked?: boolean }>;
      edges: Array<{ from: string; to: string; toPort: string }>;
    };
    cvRoutes: Record<string, unknown>;
  };
}

type G = {
  __toyboxRoll?: (seed?: number) => Promise<RollResultShape | null>;
  __toyboxDimGen?: string[];
  __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
  __ydoc: { transact: (fn: () => void) => void };
};

/** Perceptual floors (see header). */
const LIT40_FLOOR = 0.01;
const MEAN_FLOOR = 12;

/** Spawn a lone TOYBOX (id 'tb') on the LEGACY shell and wait for the hook. */
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

/**
 * Spawn a toybox under the DEFAULT shell and open its dock full view.
 *
 * ⚠ REWRITTEN 2026-09-02, WHEN TOYBOX WAS PROMOTED — the wave-6 §8 lesson
 * landing on the two rows in this file that were never on `?shell=legacy`.
 * They used to click the UN-MIGRATED placeholder's EXPAND button and then read
 * the legacy CARD inside the dock. A faced module has neither: the lane tile is
 * a `module-shell` with `shell-open-dock`, and what the dock mounts is
 * `toybox-face-body`. Both rows' SUBJECTS are unchanged — the owner-black
 * report and the stale-proxy editor repaint both happen in the DOCK, which is
 * exactly where the face now lives, so these are the rows most worth
 * re-subjecting rather than leaving green-and-blind on a surface no player
 * meets.
 *
 * `__toyboxRoll` is installed by the CONSOLE's `onMount`, and the console is
 * what BOTH surfaces render, so the hook arrives on this path exactly as it did
 * on the old one.
 */
async function openDockFace(page: Page): Promise<void> {
  await page.goto('/rack?seed=none');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'tb', type: 'toybox', position: { x: 300, y: 60 }, domain: 'video' }]);
  const shell = page.locator('.svelte-flow__node[data-id="tb"] [data-testid="module-shell"]');
  await shell.waitFor({ state: 'visible', timeout: 30_000 });
  // ⚠ THE SHIPPED HOOK, NOT A CLICK ON THE LANE TILE. `shell-open-dock` is not
  // reliably actionable under parallel shards — measured on face-toybox.spec.ts,
  // where clicking it failed all five tests on CI shard 1/12 while passing 15/15
  // locally. `__openDockFullView` is what every other dock spec here uses and is
  // CI-validated; see cartesian-face.spec.ts's header for the same finding.
  await page.waitForFunction(
    () =>
      typeof (globalThis as unknown as { __openDockFullView?: unknown }).__openDockFullView ===
      'function',
    undefined,
    { timeout: 30_000 },
  );
  await page.evaluate(
    (id) =>
      (globalThis as unknown as { __openDockFullView: (i: string) => void }).__openDockFullView(id),
    'tb',
  );
  const body = page.getByTestId('dock-full-view').getByTestId('toybox-face-body');
  await expect(body).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(() => page.evaluate(() => typeof (globalThis as unknown as G).__toyboxRoll), {
      message: '__toyboxRoll hook must be installed by the console the dock full view mounts',
    })
    .toBe('function');
}

async function roll(page: Page, seed: number): Promise<RollResultShape> {
  const res = await page.evaluate((seed) => (globalThis as unknown as G).__toyboxRoll!(seed), seed);
  expect(res, `roll(seed=${seed}) applied`).not.toBeNull();
  return res!;
}

async function dataSnapshot(page: Page): Promise<string> {
  return page.evaluate(() => {
    const n = (globalThis as unknown as G).__patch.nodes['tb'];
    return JSON.stringify(n?.data ?? null);
  });
}

/** Snapshot reduced to the fields undo/revert are ANSWERABLE for
 *  (`combineView` is CARD-managed layout state, outside the roll scope). */
function rollScope(json: string): unknown {
  const d = JSON.parse(json) as Record<string, unknown> | null;
  if (d && typeof d === 'object') delete d.combineView;
  return d;
}

/** One in-page perceptual sample of the toybox preview canvas. */
async function sampleCanvas(page: Page): Promise<{ lit40: number; mean: number } | null> {
  return page.evaluate(() => {
    // Either surface's canvas — see the note in `expectAlive`.
    const c = document.querySelector(
      '[data-testid="toybox-canvas"], [data-testid="toybox-face-canvas"]',
    ) as HTMLCanvasElement | null;
    if (!c) return null;
    const c2d = c.getContext('2d');
    if (!c2d) return null;
    const { data } = c2d.getImageData(0, 0, c.width, c.height);
    let lit40 = 0;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) {
      const mx = Math.max(data[i]!, data[i + 1]!, data[i + 2]!);
      sum += mx;
      if (mx > 40) lit40++;
    }
    const px = c.width * c.height;
    return { lit40: lit40 / px, mean: sum / px };
  });
}

async function waitFramesInPage(page: Page, n: number): Promise<void> {
  await page.evaluate(
    (n) =>
      new Promise<void>((r) => {
        let i = 0;
        const t = () => (++i >= n ? r() : requestAnimationFrame(t));
        requestAnimationFrame(t);
      }),
    n,
  );
}

/**
 * Assert the LIVE preview is PERCEPTIBLY alive: poll (in page, live clock)
 * until the perceptual floor holds — tolerating async GLSL compile — then
 * re-sample ~45 frames later and require the floor AGAIN (steady state; a
 * bright transient that settles dark must fail). Reports both samples with
 * units in the failure message.
 */
async function expectAlive(page: Page, label: string, capMs = 30_000): Promise<void> {
  try {
    await page.waitForFunction(
      ({ LIT40_FLOOR, MEAN_FLOOR }) => {
        // ⚠ EITHER SURFACE'S CANVAS. The legacy card spells it `toybox-canvas`;
        // the faceplate body spells it `toybox-face-canvas` (the fleet convention
        // `face-screen-render-suite` looks for). Two rows in this file boot the
        // DEFAULT shell and reach the dock, where after the 2026-09-02 promotion
        // the FACE is what mounts — so a probe that knew only the card's id would
        // report a black frame for a picture that is painting perfectly.
        const c = document.querySelector(
          '[data-testid="toybox-canvas"], [data-testid="toybox-face-canvas"]',
        ) as HTMLCanvasElement | null;
        if (!c) return false;
        const c2d = c.getContext('2d');
        if (!c2d) return false;
        const { data } = c2d.getImageData(0, 0, c.width, c.height);
        let lit40 = 0;
        let sum = 0;
        for (let i = 0; i < data.length; i += 4) {
          const mx = Math.max(data[i]!, data[i + 1]!, data[i + 2]!);
          sum += mx;
          if (mx > 40) lit40++;
        }
        const px = c.width * c.height;
        const w = globalThis as unknown as { __rollProbe?: { lit40: number; mean: number } };
        w.__rollProbe = { lit40: lit40 / px, mean: sum / px };
        return w.__rollProbe.lit40 > LIT40_FLOOR && w.__rollProbe.mean > MEAN_FLOOR;
      },
      { LIT40_FLOOR, MEAN_FLOOR },
      { timeout: capMs },
    );
  } catch (err) {
    const last = await page
      .evaluate(() => (globalThis as unknown as { __rollProbe?: unknown }).__rollProbe)
      .catch(() => undefined);
    throw new Error(
      `${label}: never perceptibly alive — last sample ${JSON.stringify(last)} ` +
        `(floors: >${LIT40_FLOOR} of pixels above 40/255 intensity, mean-of-max > ${MEAN_FLOOR}/255)`,
      { cause: err },
    );
  }
  const first = await sampleCanvas(page);
  await waitFramesInPage(page, 45);
  const second = await sampleCanvas(page);
  expect(
    second !== null && second.lit40 > LIT40_FLOOR && second.mean > MEAN_FLOOR,
    `${label}: steady-state sample fell below the perceptual floor — first ${JSON.stringify(first)}, ` +
      `second ${JSON.stringify(second)} (units: fraction of pixels above 40/255, mean of per-pixel max channel)`,
  ).toBe(true);
}

/** Seed layer 0 solo through a pass-through graph (instrument-control rig). */
async function seedSoloGen(page: Page, contentId: string): Promise<void> {
  await page.evaluate((contentId) => {
    const g = globalThis as unknown as G;
    g.__ydoc.transact(() => {
      const n = g.__patch.nodes['tb'];
      if (!n) return;
      if (!n.data) n.data = {};
      const data = n.data as { layers?: unknown; combine?: unknown };
      data.layers = [
        { kind: 'gen', contentId, params: {} },
        { kind: 'off', contentId: null, params: {} },
        { kind: 'off', contentId: null, params: {} },
        { kind: 'off', contentId: null, params: {} },
      ];
      data.combine = {
        nodes: [
          { id: 'src0', kind: 'source', layer: 0, x: 14, y: 14 },
          { id: 'src1', kind: 'source', layer: 1, x: 14, y: 66 },
          { id: 'src2', kind: 'source', layer: 2, x: 14, y: 118 },
          { id: 'src3', kind: 'source', layer: 3, x: 14, y: 170 },
          { id: 'out', kind: 'output', x: 286, y: 66 },
        ],
        edges: [{ id: 'e1', from: 'src0', to: 'out', toPort: 'in0' }],
      };
    });
  }, contentId);
}

// ---------------------------------------------------------------------------
// FLOOR (@webgl-smoke — the PR lane's proof the feature works at all)
// ---------------------------------------------------------------------------

test('@webgl-smoke three seeded rolls each apply a NEW patch and render PERCEPTIBLY (not merely non-black)', async ({ page }) => {
  // 3 perceptual probes (2 samples each) on SwiftShader; budget per the
  // ci-swiftshader-video-e2e-timeouts discipline.
  test.setTimeout(180_000);
  await spawnToybox(page);
  let prev = await dataSnapshot(page);
  for (const seed of [11, 22, 33]) {
    const res = await roll(page, seed);
    expect(res.blob.layers.length, `seed ${seed}: layer array`).toBe(4);
    const next = await dataSnapshot(page);
    expect(next, `seed ${seed}: roll must change node.data`).not.toEqual(prev);
    prev = next;
    await expectAlive(page, `seed ${seed}`);
  }
});

// ---------------------------------------------------------------------------
// HEAVY LANE — the full acceptance floor
// ---------------------------------------------------------------------------

test.describe('toybox randomize — heavy proofs', () => {
  test('NEGATIVE CONTROL: star-field solo must FAIL the perceptual probe', async ({ page }) => {
    // The instrument leg (CLAUDE.md: when the fix is to the INSTRUMENT,
    // negative-control it in both directions and keep one as a permanent
    // leg). This is the exact owner-black state (2026-08-20 screenshot):
    // litFrac(>6)=1.0 — the OLD probe's perfect pass — while nothing exceeds
    // 40/255. If this test ever sees expectAlive PASS on it, the probe has
    // gone blind again.
    test.setTimeout(120_000);
    await spawnToybox(page);
    await seedSoloGen(page, 'star-field');
    // Let the content swap land (same stale-frame hazard as the audit below):
    // the probe must judge STAR-FIELD's pixels, not a leftover bright frame.
    await waitFramesInPage(page, 90);
    let passed = false;
    try {
      await expectAlive(page, 'star-field solo (must fail)', 12_000);
      passed = true;
    } catch {
      // expected: the probe refuses the dead-looking frame
    }
    expect(passed, 'the perceptual probe CERTIFIED a star-field-solo frame — instrument blind').toBe(false);
  });

  test('GEN catalog audit: the DIM list matches measurement in BOTH directions', async ({ page }) => {
    // Renders every GEN content SOLO and classifies it against the perceptual
    // floor, then asserts the classification EQUALS the engine's
    // DIM_GEN_CONTENT list (via the __toyboxDimGen hook): an unlisted
    // under-floor content reddens (the dice could roll a dead-looking base),
    // and a listed content that brightened reddens too (stale entry).
    test.setTimeout(420_000);
    await spawnToybox(page);
    const genIds: string[] = await page.evaluate(async () => {
      const res = await fetch('/toybox/manifest.json');
      const m = (await res.json()) as { gen: Array<{ id: string }> };
      return m.gen.map((c) => c.id);
    });
    expect(genIds.length).toBeGreaterThan(0);
    const underFloor: string[] = [];
    for (const id of genIds) {
      await seedSoloGen(page, id);
      // ⚠ INSTRUMENT RACE (found on this test's own first run): right after
      // the seed, the canvas still shows the PREVIOUS content's frame while
      // the new GLSL fetches + compiles — classifying immediately certifies
      // the new content on the OLD content's pixels (star-field "passed" on
      // a leftover bright frame). Let the swap land first: while the new
      // shader is loading the layer contributes nothing, so the stale frame
      // goes dark before the new content paints.
      await waitFramesInPage(page, 90);
      // Let the shader fetch + compile + settle, on the live clock.
      const settled = await page
        .waitForFunction(
          ({ LIT40_FLOOR, MEAN_FLOOR }) => {
            const c = document.querySelector('[data-testid="toybox-canvas"]') as HTMLCanvasElement | null;
            if (!c) return false;
            const c2d = c.getContext('2d');
            if (!c2d) return false;
            const { data } = c2d.getImageData(0, 0, c.width, c.height);
            let lit40 = 0;
            let sum = 0;
            for (let i = 0; i < data.length; i += 4) {
              const mx = Math.max(data[i]!, data[i + 1]!, data[i + 2]!);
              sum += mx;
              if (mx > 40) lit40++;
            }
            const px = c.width * c.height;
            return lit40 / px > LIT40_FLOOR && sum / px > MEAN_FLOOR;
          },
          { LIT40_FLOOR, MEAN_FLOOR },
          { timeout: 15_000 },
        )
        .then(() => true)
        .catch(() => false);
      if (!settled) underFloor.push(id);
    }
    const dimList: string[] = await page.evaluate(
      () => (globalThis as unknown as G).__toyboxDimGen ?? [],
    );
    expect(underFloor.sort(), 'under-floor GEN contents must EQUAL the engine DIM list').toEqual(
      [...dimList].sort(),
    );
  });

  test('20 consecutive seeded rolls: every one applies and renders perceptibly', async ({ page }) => {
    test.setTimeout(600_000);
    await spawnToybox(page);
    const seeds = Array.from({ length: 20 }, (_, i) => 101 + i * 37);
    const archetypes = new Set<string>();
    const opCounts = new Set<number>();
    let prev = await dataSnapshot(page);
    for (const seed of seeds) {
      const res = await roll(page, seed);
      archetypes.add(res.archetypeId);
      opCounts.add(res.blob.combine.nodes.filter((n) => n.kind !== 'source' && n.kind !== 'output').length);
      const next = await dataSnapshot(page);
      expect(next, `seed ${seed}: roll must change node.data`).not.toEqual(prev);
      prev = next;
      await expectAlive(page, `sweep seed ${seed}`);
    }
    expect(archetypes.size, `archetypes seen: ${[...archetypes].join(', ')}`).toBeGreaterThan(1);
    // The GRAPH varies structurally across the sweep, not just in content
    // (owner demand — units: op nodes per rolled graph).
    expect(opCounts.size, `distinct op-node counts: ${[...opCounts].join(',')}`).toBeGreaterThan(2);
  });

  test('DOCK full view (the DEFAULT shell): fresh spawn paints, and a roll paints', async ({ page }) => {
    // The owner-black report came from the dock; the first spec never left
    // ?shell=legacy. This leg keeps the dock path and the FIRST-MOUNT default
    // state (no preset, no roll) covered — both were probe blind spots.
    test.setTimeout(180_000);
    await openDockFace(page);
    await expectAlive(page, 'dock first-mount (default state, no roll)');
    await roll(page, 71);
    await expectAlive(page, 'dock roll seed 71');
  });

  test('DOCK editor stays LIVE after rolls: labels painted, panel follows selection — no reload', async ({ page }) => {
    // Named for the 2026-08-20 round-two owner report: "after randomize the
    // labels vanish and the controls under the node graph do not update when
    // i change nodes … until f5". Root cause: `graph` returned the live store
    // proxy, whose reference never changes across a roll's in-place splice —
    // nothing downstream invalidated, and the dock (which, unlike the rack
    // canvas, pushes no fresh node snapshot on doc writes) kept rendering the
    // spliced-out nodes as DETACHED proxies: six `toybox-gnode-undefined`
    // boxes with blank labels over an 8-node data graph. The SECOND roll is
    // the load-bearing one here (the first roll from a fresh node changes the
    // reference and repaints even under the bug — which is exactly how the
    // original owner-report leg stayed green while the owner's session broke).
    test.setTimeout(240_000);
    await openDockFace(page);
    // ⚠ THE TAB IS THE COLLAPSE. On the card the combine editor has its own ▾
    // toggle; on the faceplate it is one of three tabs — the same capability
    // with one control instead of two. This row's SUBJECT (the editor
    // repainting after a roll rather than rendering detached proxies) is
    // unchanged either way.
    await page.getByTestId('toybox-face-tab-combine').click();
    await page.locator('[data-testid="toybox-graph-svg"]').last().waitFor({ state: 'visible', timeout: 10_000 });

    /** (a) every painted node id matches data AND its visible label is
     *  non-empty (a detached-proxy render is `gnode-undefined` + blank). */
    const editorSync = () =>
      page.evaluate(() => {
        const labels = [...document.querySelectorAll('.gnode-label')].map((t) => (t.textContent ?? '').trim());
        const domIds = [...document.querySelectorAll('[data-testid^="toybox-gnode-"]')]
          .map((el) => el.getAttribute('data-testid')!.slice('toybox-gnode-'.length))
          .filter((id) => !id.startsWith('lock-'))
          .sort();
        const n = (globalThis as unknown as G).__patch.nodes['tb'];
        const combine = (n?.data as { combine?: RollResultShape['blob']['combine'] })?.combine;
        return {
          domIds,
          dataIds: (combine?.nodes ?? []).map((x) => x.id).sort(),
          emptyLabels: labels.filter((l) => l.length === 0).length,
        };
      });

    // TWO rolls: the second exercises the reference-stable (stale-proxy) case.
    for (const seed of [821, 822]) {
      await roll(page, seed);
      await expect
        .poll(async () => {
          const s = await editorSync();
          return { inSync: JSON.stringify(s.domIds) === JSON.stringify(s.dataIds), emptyLabels: s.emptyLabels };
        }, { message: `seed ${seed}: dock editor must repaint ids AND labels (no detached-proxy render)` })
        .toEqual({ inSync: true, emptyLabels: 0 });
    }

    // (b) the under-graph panel FOLLOWS selection, same page, no reload. The
    // expectation is DERIVED from each clicked node's own data params — never
    // a hand-typed per-op list.
    const opIds: string[] = await page.evaluate(() => {
      const n = (globalThis as unknown as G).__patch.nodes['tb'];
      const combine = (n?.data as { combine?: RollResultShape['blob']['combine'] })?.combine;
      return (combine?.nodes ?? [])
        .filter((x) => x.kind !== 'source' && x.kind !== 'output')
        .map((x) => x.id);
    });
    expect(opIds.length, 'rolled graph must contain op nodes to select').toBeGreaterThan(0);
    for (const nid of opIds.slice(0, 2)) {
      await page
        .locator(`[data-testid="toybox-gnode-${nid}"]`)
        .last()
        .locator('rect')
        .click({ force: true, noWaitAfter: true });
      await expect
        .poll(
          () =>
            page.evaluate((nid) => {
              const panel = [...document.querySelectorAll('.combine-knob-cell')]
                .map((el) => el.getAttribute('data-param'))
                .sort();
              const n = (globalThis as unknown as G).__patch.nodes['tb'];
              const combine = (n?.data as { combine?: { nodes: Array<{ id: string; params?: Record<string, number> }> } })?.combine;
              const own = Object.keys(combine?.nodes.find((x) => x.id === nid)?.params ?? {})
                .filter((k) => !k.startsWith('_'))
                .sort();
              // `match` is the assertion; panel/own ride along so a failure
              // PRINTS both sides (which params the panel showed vs the node's).
              return { match: JSON.stringify(panel) === JSON.stringify(own), panel, own };
            }, nid),
          { message: `selecting ${nid} must show ITS OWN params in the under-graph panel (no reload)` },
        )
        .toMatchObject({ match: true });
    }
  });

  test('REAL source chain: a patched video feed + LFO cv are load-bearing in every roll', async ({ page }) => {
    test.setTimeout(240_000);
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
      const vidIdx = res.blob.layers.findIndex((l) => l.kind === 'video' && l.videoSource === 'inA');
      expect(vidIdx, `seed ${seed}: rolled layers must include a video layer on inA`).toBeGreaterThanOrEqual(0);
      const bearing = await page.evaluate((vidIdx) => {
        const n = (globalThis as unknown as G).__patch.nodes['tb'];
        const combine = (n?.data as { combine?: RollResultShape['blob']['combine'] })?.combine;
        if (!combine) return false;
        const into = new Map<string, string[]>();
        for (const e of combine.edges) {
          const toNode = combine.nodes.find((nd) => nd.id === e.to);
          if (toNode?.kind === 'source' && e.toPort === 'in0') continue; // layer-input tap
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
        return combine.nodes.some((nd) => nd.kind === 'source' && nd.layer === vidIdx && seen.has(nd.id));
      }, vidIdx);
      expect(bearing, `seed ${seed}: the inA video layer must reach OUT`).toBe(true);
      expect(res.blob.cvRoutes['cv1'], `seed ${seed}: cv1 must be routed`).toBeTruthy();
      const edgeIds = await page.evaluate(() =>
        Object.keys((globalThis as unknown as { __patch: { edges: Record<string, unknown> } }).__patch.edges).sort(),
      );
      expect(edgeIds, `seed ${seed}: a roll must never touch rack edges`).toEqual(['e-cv', 'e-feed']);
      await expectAlive(page, `real-chain seed ${seed}`);
    }
  });

  test('LOCKS: a locked layer survives rolls AND revert; unlock frees it (aria-pressed UI)', async ({ page }) => {
    test.setTimeout(240_000);
    await spawnToybox(page);
    // Roll once so every layer holds rolled content, then LOCK layer 1.
    await roll(page, 601);
    const lockBtn = page.getByTestId('toybox-layer-lock-1');
    await expect(lockBtn).toBeVisible();
    await expect(lockBtn).toHaveAttribute('aria-pressed', 'false');
    await lockBtn.click();
    await expect(lockBtn).toHaveAttribute('aria-pressed', 'true');
    const lockedLayer = await page.evaluate(() => {
      const n = (globalThis as unknown as G).__patch.nodes['tb'];
      return JSON.stringify((n?.data as { layers?: unknown[] })?.layers?.[1]);
    });
    expect(JSON.parse(lockedLayer).locked).toBe(true);

    // Two more rolls: layer 1 byte-identical, the rest changed.
    for (const seed of [602, 603]) {
      await roll(page, seed);
      const after = await page.evaluate(() => {
        const n = (globalThis as unknown as G).__patch.nodes['tb'];
        const layers = (n?.data as { layers?: unknown[] })?.layers ?? [];
        return { l1: JSON.stringify(layers[1]), all: JSON.stringify(layers) };
      });
      expect(after.l1, `seed ${seed}: locked layer changed`).toEqual(lockedLayer);
    }

    // REVERT honors the lock: layer 1 keeps its CURRENT (locked) content.
    await page.getByTestId('toybox-randomize-revert').click();
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const n = (globalThis as unknown as G).__patch.nodes['tb'];
            return JSON.stringify((n?.data as { layers?: unknown[] })?.layers?.[1]);
          }),
        { message: 'REVERT must keep the LOCKED layer as-is' },
      )
      .toEqual(lockedLayer);

    // Unlock → the next roll may change it (and reliably does: rolled content
    // carries fresh rolled params).
    await lockBtn.click();
    await expect(lockBtn).toHaveAttribute('aria-pressed', 'false');
    await roll(page, 604);
    const freed = await page.evaluate(() => {
      const n = (globalThis as unknown as G).__patch.nodes['tb'];
      return JSON.stringify((n?.data as { layers?: unknown[] })?.layers?.[1]);
    });
    expect(freed, 'unlocked layer must roll again').not.toEqual(lockedLayer);
    await expectAlive(page, 'post-lock-cycle roll');
  });

  test('LOCKS: a locked GRAPH NODE survives rolls with its feeds (menu toggle + badge)', async ({ page }) => {
    test.setTimeout(240_000);
    await spawnToybox(page);
    await roll(page, 701);
    // Open the combine editor and lock the first op node via the right-click
    // menu (the aria-pressed toggle). Uses the toybox-node-menu spec's proven
    // interaction shape: shared ensureCombineOpen + a retrying FORCE
    // right-click (a single right-click can land before the SVG is
    // interactive on cold renderers — the dominant node-menu flake).
    await ensureCombineOpen(page);
    const opNode = await page.evaluate(() => {
      const n = (globalThis as unknown as G).__patch.nodes['tb'];
      const combine = (n?.data as { combine?: RollResultShape['blob']['combine'] })?.combine;
      const op = combine?.nodes.find((nd) => nd.kind !== 'source' && nd.kind !== 'output');
      return op ? op.id : null;
    });
    expect(opNode, 'rolled graph must contain an op node').not.toBeNull();
    const gnode = page.locator(`[data-testid="toybox-gnode-${opNode}"]`).first();
    await gnode.waitFor({ state: 'visible', timeout: 15_000 });
    const menuLoc = page.getByTestId('toybox-node-menu');
    await expect(async () => {
      await gnode.click({ button: 'right', force: true, noWaitAfter: true });
      await expect(menuLoc).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 20_000 });
    const lockItem = page.getByTestId('toybox-menu-lock-node');
    await expect(lockItem).toBeVisible();
    await expect(lockItem).toHaveAttribute('aria-pressed', 'false');
    await lockItem.click();
    await expect(page.getByTestId(`toybox-gnode-lock-${opNode}`)).toBeVisible();
    const lockedNode = await page.evaluate((opNode) => {
      const n = (globalThis as unknown as G).__patch.nodes['tb'];
      const combine = (n?.data as { combine?: RollResultShape['blob']['combine'] })?.combine;
      return JSON.stringify(combine?.nodes.find((nd) => nd.id === opNode));
    }, opNode);
    expect(JSON.parse(lockedNode).locked).toBe(true);

    // Roll twice — the locked node survives byte-identical, with inbound feeds.
    for (const seed of [702, 703]) {
      const res = await roll(page, seed);
      const got = res.blob.combine.nodes.find((nd) => nd.id === opNode);
      expect(JSON.stringify(got), `seed ${seed}: locked node changed`).toEqual(lockedNode);
      const inbound = res.blob.combine.edges.filter((e) => e.to === opNode);
      expect(inbound.length, `seed ${seed}: locked node lost its feeds`).toBeGreaterThan(0);
    }
    await expectAlive(page, 'locked-node roll');
  });

  test('one Cmd-Z reverts ONE roll; REVERT restores the pre-session patch', async ({ page }) => {
    test.setTimeout(180_000);
    await spawnToybox(page);
    await page.evaluate(() => {
      const g = globalThis as unknown as G;
      g.__ydoc.transact(() => {
        const n = g.__patch.nodes['tb'];
        if (!n) return;
        if (!n.data) n.data = {};
        (n.data as Record<string, unknown>).name = 'pre-roll toybox';
        (n.data as Record<string, unknown>).layers = [
          { kind: 'gen', contentId: 'noise-fbm', params: {} },
          { kind: 'off', contentId: null, params: {} },
          { kind: 'off', contentId: null, params: {} },
          { kind: 'off', contentId: null, params: {} },
        ];
      });
    });
    const data0 = await dataSnapshot(page);

    await roll(page, 501);
    // pacing: Y.UndoManager captureTimeout (500 ms, the yjs default the store's
    // undo manager runs with) — transactions inside the window merge into the
    // OPEN undo item, so back-to-back hook rolls faster than any human press
    // must sit apart for "one Cmd-Z = one roll" to be the thing under test.
    await page.waitForTimeout(700);
    const data1 = await dataSnapshot(page);
    expect(data1).not.toEqual(data0);

    await roll(page, 502);
    // pacing: Y.UndoManager captureTimeout — see above.
    await page.waitForTimeout(700);
    const data2 = await dataSnapshot(page);
    expect(data2).not.toEqual(data1);

    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Meta+z');
    await expect
      .poll(async () => rollScope(await dataSnapshot(page)), {
        message: 'Cmd-Z must restore the FIRST roll exactly (roll scope)',
      })
      .toEqual(rollScope(data1));

    // REVERT restores the pre-session patch (R22). The seeded pre-roll data
    // had NO combine/cvRoutes keys, so the restore must DELETE them.
    const revert = page.getByTestId('toybox-randomize-revert');
    await expect(revert).toBeVisible();
    await revert.click();
    await expect
      .poll(async () => rollScope(await dataSnapshot(page)), {
        message: 'REVERT must restore the pre-roll data blob (roll scope)',
      })
      .toEqual(rollScope(data0));
  });

  test('OWNER-REPORT leg: RANDOM rerolls a VISIBLE new graph — never an emptied editor', async ({ page }) => {
    // Named for the 2026-08-20 owner report ("randomize appears to delete the
    // contents of the default node graph" — filed against a stale preview,
    // retracted, but the claim deserves a permanent gate on the owner's EXACT
    // path): fresh node, combine editor open on the DEFAULT graph, press the
    // real RANDOM button, and the editor must show the ROLLED graph — every
    // node in node.data painted in the DOM, at least one op, never an empty
    // or half-painted node map. The repaint equality is load-bearing: this
    // session already caught one "data written, editor never painted" gap
    // (the lock badge), and this leg makes that class impossible to ship for
    // the roll itself.
    test.setTimeout(180_000);
    await spawnToybox(page);
    await ensureCombineOpen(page);
    const domGraph = () =>
      page.evaluate(() => {
        const els = [...document.querySelectorAll('[data-testid^="toybox-gnode-"]')]
          .map((el) => el.getAttribute('data-testid')!.slice('toybox-gnode-'.length))
          // lock badges share the prefix (toybox-gnode-lock-<id>) — not nodes.
          .filter((id) => !id.startsWith('lock-'));
        const labels = [...document.querySelectorAll('.gnode-label')].map((t) => (t.textContent ?? '').trim());
        const n = (globalThis as unknown as G).__patch.nodes['tb'];
        const combine = (n?.data as { combine?: RollResultShape['blob']['combine'] })?.combine;
        return {
          domIds: els.sort(),
          dataIds: (combine?.nodes ?? []).map((x) => x.id).sort(),
          // A detached-proxy render paints a node but a BLANK label (the
          // round-two owner report) — count empties so the seeded-roll loop
          // below catches the stale-reference case in THIS mount too.
          emptyLabels: labels.filter((l) => l.length === 0).length,
          opKinds: (combine?.nodes ?? [])
            .filter((x) => x.kind !== 'source' && x.kind !== 'output')
            .map((x) => x.kind)
            .sort(),
          outWired: (combine?.edges ?? []).some((e) => e.to === 'out'),
        };
      });
    // The DEFAULT graph paints before any roll (4 sources + fade ladder + out).
    const before = await domGraph();
    expect(before.domIds.length, 'default graph must be painted').toBeGreaterThan(0);

    // The REAL gesture: press RANDOM, then the editor must repaint the rolled
    // graph COMPLETELY — DOM node ids exactly equal node.data's.
    await page.getByTestId('toybox-randomize').click();
    await expect
      .poll(async () => (await domGraph()).dataIds.length, {
        message: 'a press must write a rolled graph into node.data',
      })
      .toBeGreaterThan(0);
    await expect
      .poll(async () => {
        const g = await domGraph();
        return { domEqualsData: JSON.stringify(g.domIds) === JSON.stringify(g.dataIds), ops: g.opKinds.length, outWired: g.outWired };
      }, { message: 'the editor must PAINT every rolled node (no emptied/half-painted map)' })
      .toEqual({ domEqualsData: true, ops: expect.any(Number), outWired: true });
    const rolled1 = await domGraph();
    expect(rolled1.opKinds.length, 'a rolled graph must contain at least one op').toBeGreaterThan(0);

    // Two SEEDED rolls chosen to differ: the graph VISIBLY rerolls — node ids
    // repaint in lockstep with data both times, and the op-kind multiset
    // changes between them (deterministic; seeds pinned).
    const shapes: string[] = [];
    for (const seed of [911, 913]) {
      await roll(page, seed);
      await expect
        .poll(async () => {
          const g = await domGraph();
          return {
            inSync: JSON.stringify(g.domIds) === JSON.stringify(g.dataIds),
            emptyLabels: g.emptyLabels,
            outWired: g.outWired,
          };
        }, { message: `seed ${seed}: editor must repaint the rolled graph completely, labels included` })
        .toEqual({ inSync: true, emptyLabels: 0, outWired: true });
      shapes.push(JSON.stringify((await domGraph()).opKinds));
    }
    expect(shapes[0], `graph must visibly REROLL across seeds (both: ${shapes[0]})`).not.toEqual(shapes[1]);
  });

  test('the dice BUTTON itself rolls (the real gesture, not just the hook)', async ({ page }) => {
    // A button press is UNSEEDED, so a single press's liveness is a SAMPLE of
    // the engine's dud tail, not a deterministic property — asserting the
    // perceptual floor on one press makes this leg statistical by
    // construction (it went red once in a 30-execution flake-check on a
    // param-space dud the seeded gates cannot express). The floor's hard,
    // deterministic enforcement lives in the SEEDED 20-roll sweep above; what
    // this leg owns is the GESTURE plus the R17 loop the product actually
    // promises: every press writes a complete patch, re-roll is cheap, and
    // within a few presses the user has a live one. Cap 3 presses: with the
    // measured residual dud rate (~1/30 per press) three duds in a row is
    // ~4e-5 — a red here means the tail regressed, not bad luck.
    test.setTimeout(240_000);
    await spawnToybox(page);
    const dice = page.getByTestId('toybox-randomize');
    await expect(dice).toBeVisible();
    let prev = await dataSnapshot(page);
    let alive = false;
    const samples: string[] = [];
    for (let press = 1; press <= 3 && !alive; press++) {
      await dice.click();
      await expect
        .poll(() => dataSnapshot(page), { message: `press ${press} must write a rolled patch` })
        .not.toEqual(prev);
      prev = await dataSnapshot(page);
      try {
        await expectAlive(page, `button press ${press}`, 20_000);
        alive = true;
      } catch (err) {
        samples.push(String(err instanceof Error ? err.message : err));
      }
    }
    expect(
      alive,
      `no perceptibly-alive patch within 3 presses (dud tail regressed?): ${samples.join(' | ')}`,
    ).toBe(true);
  });
});

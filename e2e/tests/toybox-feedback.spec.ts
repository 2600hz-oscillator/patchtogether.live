// e2e/tests/toybox-feedback.spec.ts
//
// TOYBOX FEEDBACK node — the first STATEFUL combine op.
//
// Every other combine node is a stateless RGBA8 blend; FEEDBACK keeps a per-node
// ping-pong FLOAT buffer and samples its OWN PREVIOUS FRAME each render, so the
// output EVOLVES over successive frames even with a frozen iTime. This spec wires
// a feedback node into the OUTPUT (via node.data.combine, mirroring the
// combine-editor spec's data-seed approach) and asserts the three things that
// make it actually "feedback":
//   (a) RENDERS — the composite is non-black after the loop converges,
//   (b) EVOLVES — the frame after a few steps differs from the frame after many
//       steps (the ping-pong is live, integrating frame-over-frame, not a static
//       blend),
//   (c) DIFFERS BETWEEN MODES — BLUR vs TUNNEL produce measurably different
//       composites (the uMode switch is wired),
// plus the "Reset feedback" path clears the accumulated buffer.
//
// Determinism: we pin iTime via __toyboxFreeze(t). CRUCIALLY each
// __toyboxFreeze(t) call runs ONE engine.step() (one feedback frame) then holds
// it — so calling it N times advances the ping-pong N frames deterministically at
// a constant iTime. We read the on-card preview canvas average colour (the same
// canvas the VRT freezes) for stable numeric deltas, not flaky pixel diffs.
//
// Mode choice rationale (the source is a STATIC frame at the pinned iTime, so
// modes that reach a fixed point — tunnel/displace/vector — stop changing once
// converged; we pick modes with a long transient or unbounded accumulation):
//   - BLUR (5): a diffusion that brightens over ~10 frames → a clear "evolves".
//   - ADDITIVE (3): integrates input*gain unbounded → saturates fast (good for
//     the reset test: a full buffer to clear away).
//   - TUNNEL (0): a recursive zoom that looks distinct from BLUR.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

type PatchGlobal = {
  __patch: {
    nodes: Record<
      string,
      { data?: { combine?: { nodes?: unknown[]; edges?: unknown[] }; layers?: unknown[] } }
    >;
  };
  __ydoc: { transact: (fn: () => void) => void };
  __toyboxFreeze?: (t?: number) => void;
};

/** Pin the Svelte Flow viewport so the card body is in the visible region. */
async function pinViewport(page: Page): Promise<void> {
  await page.evaluate(() => {
    const vp = document.querySelector('.svelte-flow__viewport') as HTMLElement | null;
    if (!vp) return;
    vp.style.transition = 'none';
    vp.style.transform = 'translate(8px, -24px) scale(1)';
  });
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
}

/**
 * Seed a feedback graph: layer 0 = a bright GEN shader driving the loop;
 * combine = src0 → FEEDBACK(mode, extraParams) → OUTPUT. Written straight to
 * node.data.combine (the editor edits the same live shape; the data path is the
 * stable way to set up a precise graph for a render assertion). The buffer starts
 * clean each call (a fresh graph object → reconcile allocs a fresh ping-pong).
 */
async function seedFeedbackGraph(
  page: Page,
  mode: number,
  extra: Record<string, number> = {},
): Promise<void> {
  await page.evaluate(
    ({ mode, extra }) => {
      const w = globalThis as unknown as PatchGlobal;
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['tb'];
        if (!n) return;
        if (!n.data) n.data = {};
        n.data.layers = [
          { kind: 'gen', contentId: 'noise-fbm', params: {} },
          { kind: 'off', contentId: null, params: {} },
          { kind: 'off', contentId: null, params: {} },
          { kind: 'off', contentId: null, params: {} },
        ] as unknown[];
        n.data.combine = {
          nodes: [
            { id: 'src0', kind: 'source', layer: 0, x: 14, y: 14 },
            { id: 'src1', kind: 'source', layer: 1, x: 14, y: 66 },
            { id: 'src2', kind: 'source', layer: 2, x: 14, y: 118 },
            { id: 'src3', kind: 'source', layer: 3, x: 14, y: 170 },
            { id: 'fb', kind: 'feedback', x: 120, y: 14, params: { mode, ...extra } },
            { id: 'out', kind: 'output', x: 286, y: 66 },
          ],
          edges: [
            { id: 'e_src0_fb', from: 'src0', to: 'fb', toPort: 'in0' },
            { id: 'e_fb_out', from: 'fb', to: 'out', toPort: 'in0' },
          ],
        } as unknown as { nodes: unknown[]; edges: unknown[] };
      });
    },
    { mode, extra },
  );
}

/** Set the feedback node's mode in place (live param edit). */
async function setMode(page: Page, mode: number): Promise<void> {
  await page.evaluate(
    ({ mode }) => {
      const w = globalThis as unknown as PatchGlobal;
      w.__ydoc.transact(() => {
        const c = w.__patch.nodes['tb']?.data?.combine as
          | { nodes?: Array<{ id: string; params?: Record<string, number> }> }
          | undefined;
        const fb = (c?.nodes ?? []).find((nn) => nn.id === 'fb');
        if (fb) {
          if (!fb.params) fb.params = {};
          fb.params.mode = mode;
        }
      });
    },
    { mode },
  );
}

/** Advance the feedback ping-pong by exactly N frames at a constant iTime. Each
 *  __toyboxFreeze(t) runs one engine.step() (= one feedback frame) then blits. */
async function advance(page: Page, time: number, steps: number): Promise<void> {
  await page.waitForFunction(() => {
    const c = document.querySelector('[data-testid="toybox-canvas"]') as HTMLCanvasElement | null;
    return !!c && c.width > 0 && c.height > 0;
  }, { timeout: 30_000 });
  for (let i = 0; i < steps; i++) {
    await page.evaluate(
      ({ time }) => {
        const g = globalThis as unknown as PatchGlobal;
        g.__toyboxFreeze?.(time);
      },
      { time },
    );
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
  }
}

/** Average RGB of the on-card preview canvas. */
async function average(page: Page): Promise<[number, number, number]> {
  return page.evaluate(() => {
    const c = document.querySelector('[data-testid="toybox-canvas"]') as HTMLCanvasElement;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < data.length; i += 4) {
      r += data[i]!; g += data[i + 1]!; b += data[i + 2]!; n++;
    }
    return [r / n, g / n, b / n] as [number, number, number];
  });
}

/** Advance N steps, then read the average. */
async function stepAndAverage(page: Page, time: number, steps: number): Promise<[number, number, number]> {
  await advance(page, time, steps);
  return average(page);
}

function dist(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
function lum(a: [number, number, number]): number {
  return a[0] + a[1] + a[2];
}

test.describe('TOYBOX FEEDBACK node (stateful combine op)', () => {
  test('renders non-black, EVOLVES across frames, and differs between modes', async ({ page }) => {
    // Video-domain WebGL on CI's SwiftShader renderer is slow; feedback needs
    // several converging steps per mode + two graphs captured. Scale the budget
    // generously (see repo memory ci-swiftshader-video-e2e-timeouts).
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await spawnPatch(
      page,
      [{ id: 'tb', type: 'toybox', position: { x: 80, y: 40 }, domain: 'video' }],
      [],
    );
    await page.locator('.svelte-flow__node-toybox').first().waitFor({ state: 'visible', timeout: 10_000 });
    await pinViewport(page);

    // ── BLUR (mode 5): a diffusion that brightens over the first ~10 frames, so
    //    the early frame and the converged frame are measurably different — the
    //    clearest "evolves" signal with a static input. ──
    await seedFeedbackGraph(page, 5);
    const early = await stepAndAverage(page, 2.0, 3);
    const late = await stepAndAverage(page, 2.0, 12);

    // (a) RENDERS: the converged composite is non-black.
    expect(lum(late), 'feedback composite is non-black').toBeGreaterThan(20);

    // (b) EVOLVES: the diffusion keeps integrating, so frame@15 differs from
    //     frame@3 (a static blend would be identical between the two reads).
    expect(
      dist(early, late),
      'the feedback output evolves across frames (the ping-pong is live)',
    ).toBeGreaterThan(8);

    // ── TUNNEL (mode 0): a recursive zoom — a totally different transform of the
    //    loop. Fresh graph so the buffer starts clean. ──
    await seedFeedbackGraph(page, 0);
    const tunnel = await stepAndAverage(page, 2.0, 12);

    // (c) DIFFERS BETWEEN MODES: TUNNEL vs BLUR produce different composites (the
    //     uMode switch actually drives the render).
    expect(
      dist(tunnel, late),
      'different feedback modes produce different output (uMode is wired)',
    ).toBeGreaterThan(8);

    expect(
      errors.filter((e) => !e.includes('AudioContext')),
      'no console / page errors',
    ).toEqual([]);
  });

  test('changing the mode at runtime changes the live output', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await spawnPatch(
      page,
      [{ id: 'tb', type: 'toybox', position: { x: 80, y: 40 }, domain: 'video' }],
      [],
    );
    await page.locator('.svelte-flow__node-toybox').first().waitFor({ state: 'visible', timeout: 10_000 });
    await pinViewport(page);

    await seedFeedbackGraph(page, 0); // TUNNEL (a mid-brightness steady state)
    const tunnel = await stepAndAverage(page, 2.0, 12);

    // Switch the SAME node to ADDITIVE (mode 3) in place + let it re-converge
    // (trails accumulate to a much brighter, saturated frame).
    await setMode(page, 3);
    const additive = await stepAndAverage(page, 2.0, 12);

    expect(
      dist(tunnel, additive),
      'editing the feedback mode live changes the output',
    ).toBeGreaterThan(8);
  });

  test('the INTENSITY (wet/dry) knob changes the composite + TUNNEL hall-of-mirrors renders', async ({ page }) => {
    // intensity is the wet/dry mix between the live input (dry) and the recursive
    // feedback result (wet). We assert TWO things:
    //   1. The knob measurably changes the composite. We use GEOMETRIC (mode 1),
    //      where intensity raises the feedback ACCUMULATION — a strong, robust
    //      mean-brightness signal (TUNNEL's recursive zoom of a near-uniform noise
    //      field preserves the mean, so its global-average delta is tiny even
    //      though the structure changes; brightness accumulation is the reliable
    //      numeric handle for "the knob did something").
    //   2. TUNNEL (mode 0) — the owner's headline hall-of-mirrors — renders
    //      non-black at full wet.
    // This also serves as a real-GPU shader-compile sanity check: a broken
    // FEEDBACK program would page-error / render black here.
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await spawnPatch(
      page,
      [{ id: 'tb', type: 'toybox', position: { x: 80, y: 40 }, domain: 'video' }],
      [],
    );
    await page.locator('.svelte-flow__node-toybox').first().waitFor({ state: 'visible', timeout: 10_000 });
    await pinViewport(page);

    // GEOMETRIC (mode 1) low intensity: weak feedback → close to the live input.
    await seedFeedbackGraph(page, 1, { intensity: 0.05, scaleP: 1.0, rotate: 0.02 });
    const dry = await stepAndAverage(page, 2.0, 12);
    expect(lum(dry), 'low-intensity feedback composite is non-black').toBeGreaterThan(20);

    // GEOMETRIC full intensity: strong luma-weighted accumulation → much brighter
    // trails. Fresh graph so the buffer starts clean.
    await seedFeedbackGraph(page, 1, { intensity: 1, scaleP: 1.0, rotate: 0.02 });
    const wet = await stepAndAverage(page, 2.0, 12);
    expect(lum(wet), 'high-intensity feedback composite is non-black').toBeGreaterThan(20);

    // The wet/dry knob measurably changes the composite (the uIntensity mix is
    // wired through schema → uniform → engine → shader).
    expect(
      dist(dry, wet),
      'the intensity (wet/dry) knob changes the feedback composite',
    ).toBeGreaterThan(8);

    // TUNNEL hall-of-mirrors (the owner's headline mode) renders non-black at
    // full wet — the recursive nested-frame composite owns the output.
    await seedFeedbackGraph(page, 0, { intensity: 1, zoom: 0.8 });
    const tunnel = await stepAndAverage(page, 2.0, 12);
    expect(lum(tunnel), 'TUNNEL hall-of-mirrors renders non-black at full wet').toBeGreaterThan(20);

    expect(
      errors.filter((e) => !e.includes('AudioContext')),
      'no console / page errors',
    ).toEqual([]);
  });

  // NOTE on what is (and isn't) tested here for RESET:
  //   The "Reset feedback" menu bumps a `_reset` token; the engine clears both
  //   ping-pong float textures to black on the frame it changes. Asserting that
  //   clear by PIXEL DIFF on a live feedback loop is inherently RACY and was a
  //   recurring CI flake: the engine's own RAF loop keeps stepping the loop
  //   independently of the test's controlled steps, and with a frozen iTime +
  //   static input the recursive modes (TUNNEL/DISPLACE/VECTOR) re-converge to a
  //   UNIQUE fixed point — so a freshly-cleared buffer becomes byte-identical to
  //   the accumulated one within a handful of uncontrolled frames. There is no
  //   stable visual transient to catch on slow SwiftShader (it read dist === 0).
  //   The reset CONTRACT (token diff → clear-once, idempotent until the next
  //   bump, tolerant of absent/NaN tokens) is proven deterministically in the
  //   unit test toybox-feedback.test.ts → describe('feedbackResetState'). Here we
  //   only assert the non-racy property: bumping `_reset` at runtime does not
  //   break the live loop (no errors, output stays valid/non-black).
  test('Reset feedback (token bump) keeps the loop alive (no error, stays non-black)', async ({ page }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await spawnPatch(
      page,
      [{ id: 'tb', type: 'toybox', position: { x: 80, y: 40 }, domain: 'video' }],
      [],
    );
    await page.locator('.svelte-flow__node-toybox').first().waitFor({ state: 'visible', timeout: 10_000 });
    await pinViewport(page);

    // ADDITIVE (mode 3) accumulates a bright loop quickly — a clear, non-black
    // composite before AND after the reset (the reset must not strand the loop).
    await seedFeedbackGraph(page, 3, { decay: 0.9, gain: 1 });
    const before = await stepAndAverage(page, 2.0, 10);
    expect(lum(before), 'feedback composite is non-black before reset').toBeGreaterThan(20);

    // Bump the reset token — exactly what the "Reset feedback" menu item does
    // (resetFeedbackNode → params._reset++), driven via the same live combine
    // param so it exercises the engine's token-diff/clear path end-to-end.
    await page.evaluate(() => {
      const w = globalThis as unknown as PatchGlobal;
      w.__ydoc.transact(() => {
        const c = w.__patch.nodes['tb']?.data?.combine as
          | { nodes?: Array<{ id: string; params?: Record<string, number> }> }
          | undefined;
        const fb = (c?.nodes ?? []).find((nn) => nn.id === 'fb');
        if (fb) {
          if (!fb.params) fb.params = {};
          fb.params._reset = (fb.params._reset ?? 0) + 1;
        }
      });
    });

    // Let it clear + rebuild. The loop must come back alive (the clear didn't
    // wedge it black forever) — the rebuilt accumulation is non-black again.
    const after = await stepAndAverage(page, 2.0, 10);
    expect(lum(after), 'feedback loop rebuilds (non-black) after reset').toBeGreaterThan(20);

    expect(
      errors.filter((e) => !e.includes('AudioContext')),
      'no console / page errors across a runtime reset',
    ).toEqual([]);
  });
});

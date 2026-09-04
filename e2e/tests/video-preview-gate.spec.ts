// e2e/tests/video-preview-gate.spec.ts
//
// #1802 — "OFF" MUST MEAN "NOT THERE", AND ONLY WHEN NOTHING IS WATCHING.
//
// Every mounted video card used to run an unconditional rAF that blitted and
// `drawImage`d whether or not it was showing anything. The blit IS the watch
// mark, so a card that presents nothing still made its node a pull ROOT and
// dragged the whole upstream chain into every frame. MEASURED before the fix,
// `toybox → backdraft` with backdraft's output patched NOWHERE and its card not
// expanded: both nodes drew 481 frames in 4 s for a picture on no surface at
// all — on the same main thread the audio scheduler dispatches on (#1803).
//
// ── this is the #1721 / #1728 class, so the shape of the test matters ──────
//
// Collapsing a card has twice killed a live PRODUCER in this repo. "It stopped
// rendering" is the intended result here and the catastrophic bug there, and
// the two are indistinguishable from a counter that only went down. So every
// claim below is paired:
//
//   POSITIVE CONTROL FIRST — prove the picture is measurably ANIMATING (several
//   DISTINCT frames, not merely non-black) before the test says anything about
//   turning it off. Without this leg, a spec that asserts "frames stopped"
//   passes just as happily against a module that never rendered at all.
//
//   THE "STILL WATCHING" LEG — with the upstream cards off-screen but the
//   OUTPUT card still on screen, the GL chain MUST KEEP RENDERING. That is
//   pull evaluation working correctly, and it is why the saving depends on the
//   patch and not just on the toggle. A gate that stopped the chain here would
//   be the #1721 bug wearing this PR's clothes.
//
//   THE RETURN LEG — bring everything back and prove the picture is ANIMATING
//   again, not stale and not black. A frozen last-frame would satisfy a
//   non-black assertion forever.
//
// ── sampling ───────────────────────────────────────────────────────────────
//
// Frame signatures are accumulated INSIDE THE PAGE across rAF frames and
// returned once (CLAUDE.md: never sample a page-side quantity with a
// Playwright-side poll loop). Visibility transitions ARE polled, because
// `cardVisible` is an observable state and `expect.poll` on the real subject is
// the prescribed tool for state readiness.
//
// ⚠ DOOM is not spawned here and must not be added to this rack: its game clock
// IS its frame clock, so anything that changes how many frames it renders
// changes how far the marine walks.

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { waitFrames } from '../_helpers/frames';

/** How many rAF frames to watch when asking "is this animating?". Generous
 *  against the 30 fps preview cadence: at a 60 Hz display that is ~24 paints,
 *  and under SwiftShader (measured ~8 fps) it is fewer frames but each one is
 *  a fresh paint, so the DISTINCT-signature floor below stays reachable. */
const ANIMATION_FRAMES = 48;

interface ChainSample {
  /** Per-node engine draw counts over the sampled window. */
  drawn: Record<string, number>;
  /** Last preview decision per node: blit | skip:offscreen | skip:throttled. */
  decisions: Record<string, string>;
  /** Engine-side preview blits performed over the window. */
  blitCalls: number;
  /** Card visibility as the engine sees it. */
  cardVisible: Record<string, boolean>;
}

/** Draw counts + gate decisions over a window of ENGINE FRAMES (not ms): the
 *  window ends when the engine has stepped `frames` times, so it is the same
 *  amount of render opportunity on every renderer. */
async function sampleChain(page: Page, frames: number): Promise<ChainSample> {
  return page.evaluate(async (frames) => {
    const w = globalThis as unknown as {
      __engine: () => {
        getDomain: (d: string) => {
          pullStats: () => { framesDrawn: Record<string, number>; cardVisible: Record<string, boolean> };
          previewGateStats: () => Record<string, string>;
          renderCostStats: () => { blit: { calls: number } };
          resetRenderCost: () => void;
          currentFrameCount: () => number;
        };
      };
    };
    const vid = w.__engine().getDomain('video');
    const before = { ...vid.pullStats().framesDrawn };
    const startFrame = vid.currentFrameCount();
    vid.resetRenderCost();
    await new Promise<void>((resolve) => {
      // Wall-clock cap BOUNDS THE FAILURE; the engine frame count is the gate.
      const deadline = performance.now() + 20_000;
      const tick = (): void => {
        if (vid.currentFrameCount() - startFrame >= frames || performance.now() > deadline) {
          resolve();
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const ps = vid.pullStats();
    const drawn: Record<string, number> = {};
    for (const k of Object.keys(ps.framesDrawn)) {
      drawn[k] = (ps.framesDrawn[k] ?? 0) - (before[k] ?? 0);
    }
    return {
      drawn,
      decisions: vid.previewGateStats(),
      blitCalls: vid.renderCostStats().blit.calls,
      cardVisible: ps.cardVisible,
    };
  }, frames);
}

/**
 * IS THE PICTURE MOVING? Accumulates a cheap signature of the module's visible
 * canvas once per rAF, in the page, and returns how many DISTINCT ones were
 * seen plus the non-black fraction of the last one. Takes a full CSS selector
 * (on the default shell every video tile paints a `video-tile-thumb`, so the
 * selector must be node-scoped).
 *
 * Distinct signatures — not "non-black" — because a surface that froze on its
 * last good frame is non-black forever, and that is exactly the failure this
 * spec has to be able to see.
 */
async function animation(page: Page, selector: string, frames: number): Promise<{
  distinct: number;
  samples: number;
  nonZeroFrac: number;
}> {
  return page.evaluate(
    async ({ selector, frames }) => {
      const el = document.querySelector(selector) as HTMLCanvasElement | null;
      if (!el) return { distinct: 0, samples: 0, nonZeroFrac: 0 };
      const ctx = el.getContext('2d');
      if (!ctx) return { distinct: 0, samples: 0, nonZeroFrac: 0 };
      const seen = new Set<string>();
      let samples = 0;
      let nonZeroFrac = 0;
      await new Promise<void>((resolve) => {
        const deadline = performance.now() + 20_000;
        const tick = (): void => {
          const d = ctx.getImageData(0, 0, el.width, el.height).data;
          let sum = 0;
          let sumSq = 0;
          let n = 0;
          let nonZero = 0;
          // Sparse, at an ODD stride so the sampling grid cannot align with a
          // periodic pattern in the image and alias to a constant.
          for (let i = 0; i < d.length; i += 4 * 37) {
            const v = (d[i]! + d[i + 1]! + d[i + 2]!) / 3;
            sum += v;
            sumSq += v * v;
            n++;
            if (v > 8) nonZero++;
          }
          const mean = n ? sum / n : 0;
          const variance = n ? sumSq / n - mean * mean : 0;
          nonZeroFrac = n ? nonZero / n : 0;
          seen.add(`${mean.toFixed(3)}|${variance.toFixed(3)}`);
          samples++;
          if (samples >= frames || performance.now() > deadline) {
            resolve();
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      return { distinct: seen.size, samples, nonZeroFrac };
    },
    { selector, frames },
  );
}

/** Move nodes far below the viewport so the central IntersectionObserver
 *  reports them off-screen, then WAIT ON THE OBSERVABLE (engine visibility),
 *  never on a fixed budget. */
async function moveOffScreen(page: Page, ids: string[]): Promise<void> {
  await page.evaluate((ids) => {
    const w = globalThis as unknown as {
      __ydoc: { transact: (fn: () => void) => void };
      __patch: { nodes: Record<string, { position: { x: number; y: number } }> };
    };
    w.__ydoc.transact(() => {
      for (const id of ids) {
        const n = w.__patch.nodes[id];
        if (n) n.position = { x: n.position.x, y: n.position.y + 6000 };
      }
    });
  }, ids);
  await expect
    .poll(
      async () => {
        const vis = await page.evaluate(() => {
          const w = globalThis as unknown as {
            __engine: () => { getDomain: (d: string) => { pullStats: () => { cardVisible: Record<string, boolean> } } };
          };
          return w.__engine().getDomain('video').pullStats().cardVisible;
        });
        return ids.filter((id) => vis[id] !== false);
      },
      { message: `the IntersectionObserver reported ${ids.join(', ')} off-screen`, timeout: 20_000 },
    )
    .toEqual([]);
}

async function moveOnScreen(page: Page, ids: string[]): Promise<void> {
  await page.evaluate((ids) => {
    const w = globalThis as unknown as {
      __ydoc: { transact: (fn: () => void) => void };
      __patch: { nodes: Record<string, { position: { x: number; y: number } }> };
    };
    w.__ydoc.transact(() => {
      for (const id of ids) {
        const n = w.__patch.nodes[id];
        if (n) n.position = { x: n.position.x, y: n.position.y - 6000 };
      }
    });
  }, ids);
  await expect
    .poll(
      async () => {
        const vis = await page.evaluate(() => {
          const w = globalThis as unknown as {
            __engine: () => { getDomain: (d: string) => { pullStats: () => { cardVisible: Record<string, boolean> } } };
          };
          return w.__engine().getDomain('video').pullStats().cardVisible;
        });
        return ids.filter((id) => vis[id] !== true);
      },
      { message: `the IntersectionObserver reported ${ids.join(', ')} back on-screen`, timeout: 20_000 },
    )
    .toEqual([]);
}

test.describe('#1802 card preview gate', () => {
  test('an unwatched chain stops, a WATCHED one does not, and the picture comes back @webgl-smoke', async ({
    page,
    errorWatch,
  }) => {
    test.setTimeout(180_000);
    await page.goto('/rack?seed=none');
    await page.waitForLoadState('networkidle');

    // toybox → backdraft → VIDEO OUT. Three nodes so the test can separate
    // "this card's preview stopped" from "the chain it feeds stopped".
    await spawnPatch(
      page,
      [
        { id: 'src', type: 'toybox', position: { x: 40, y: 60 }, domain: 'video' },
        { id: 'fx', type: 'backdraft', position: { x: 430, y: 60 }, domain: 'video' },
        { id: 'out', type: 'videoOut', position: { x: 820, y: 60 }, domain: 'video' },
      ],
      [
        { id: 'e1', from: { nodeId: 'src', portId: 'out' }, to: { nodeId: 'fx', portId: 'in_a' }, sourceType: 'video', targetType: 'video' },
        { id: 'e2', from: { nodeId: 'fx', portId: 'out' }, to: { nodeId: 'out', portId: 'in' }, sourceType: 'video', targetType: 'video' },
      ],
    );
    await expect(
      page.locator('.svelte-flow__node[data-id="out"] [data-testid="module-shell"]'),
    ).toHaveCount(1);
    await waitFrames(page, 8);

    // ── (1) POSITIVE CONTROL: there is a LIVE, MOVING picture to lose ───────
    // The shell's visible per-node surface is the lane tile thumb (node-scoped
    // — every video tile paints one).
    const live = await animation(page, '.svelte-flow__node[data-id="out"] canvas[data-testid="video-tile-thumb"]', ANIMATION_FRAMES);
    console.log(`[preview-gate] baseline animation ${JSON.stringify(live)}`);
    expect(
      live.samples,
      'the OUTPUT canvas was sampled at all — 0 means the element never resolved and every ' +
        'assertion in this spec is vacuous',
    ).toBeGreaterThan(10);
    expect(
      live.nonZeroFrac,
      `the OUTPUT is painting a picture (nonBlack ${live.nonZeroFrac.toFixed(3)})`,
    ).toBeGreaterThan(0.02);
    expect(
      live.distinct,
      `POSITIVE CONTROL: the OUTPUT must be ANIMATING before this spec claims anything about ` +
        `turning it off — ${live.distinct} distinct frame signatures over ${live.samples} rAF ` +
        `samples. A frozen or never-started picture would make "frames stopped" pass for the ` +
        `wrong reason, which is the #1721/#1728 failure class this spec exists inside.`,
    ).toBeGreaterThan(2);

    const all = await sampleChain(page, 30);
    console.log(`[preview-gate] all on-screen ${JSON.stringify(all)}`);
    for (const id of ['src', 'fx', 'out']) {
      expect(all.drawn[id], `${id} renders while everything is on screen`).toBeGreaterThan(5);
    }
    expect(
      all.blitCalls,
      'preview blits happen while cards are on screen (the gate is not simply off)',
    ).toBeGreaterThan(0);

    // ── (2) UPSTREAM OFF-SCREEN, OUTPUT STILL WATCHING ──────────────────────
    // The previews stop. The CHAIN MUST NOT.
    await moveOffScreen(page, ['src', 'fx']);
    const watched = await sampleChain(page, 30);
    console.log(`[preview-gate] upstream off-screen, OUTPUT watching ${JSON.stringify(watched)}`);
    // On the default shell the refusal is enacted UPSTREAM of the engine's
    // decision ledger: the lane thumb's own IntersectionObserver releases its
    // blit loop entirely (VideoTileThumb), so no blit is attempted and no
    // per-node decision is recorded — `undefined` here IS the refusal. The
    // legacy card's unconditional rAF loop was what produced `skip:offscreen`
    // entries. Either spelling must never be `skip:throttled` (only the
    // viewport gate says "stop being an observer"); the engine's own view of
    // visibility is asserted alongside so a missing entry can't mask a broken
    // observer feed.
    expect(
      [undefined, 'skip:offscreen'],
      'the off-screen tile\'s preview is refused — the thumb released its loop ' +
        `(no decision recorded) or the engine refused with skip:offscreen; got ` +
        `\`${watched.decisions['src']}\``,
    ).toContain(watched.decisions['src']);
    expect(
      watched.cardVisible['src'],
      'the engine visibility feed really reports src off-screen',
    ).toBe(false);
    for (const id of ['src', 'fx', 'out']) {
      expect(
        watched.drawn[id],
        `${id} MUST KEEP RENDERING: the OUTPUT card is still on screen and still watching, so ` +
          `pull evaluation keeps the whole chain live. Stopping here would be the #1721 bug — ` +
          `a collapsed card killing a picture somebody is looking at. drawn=${JSON.stringify(watched.drawn)}`,
      ).toBeGreaterThan(5);
    }

    // ── (3) NOTHING WATCHING → EVERYTHING STOPS ─────────────────────────────
    await moveOffScreen(page, ['out']);
    const idle = await sampleChain(page, 30);
    console.log(`[preview-gate] nothing watching ${JSON.stringify(idle)}`);
    for (const id of ['src', 'fx', 'out']) {
      expect(
        idle.drawn[id],
        `${id} must STOP rendering once nothing observes the chain — that is the whole point ` +
          `of #1802: "off" has to mean "not there", not "cheaper". drawn=${JSON.stringify(idle.drawn)}`,
      ).toBe(0);
    }
    expect(
      idle.blitCalls,
      'and no preview blit is issued for a rack nobody can see',
    ).toBe(0);

    // ── (4) RETURN LEG: the picture comes back LIVE, not stale ──────────────
    await moveOnScreen(page, ['src', 'fx', 'out']);
    await waitFrames(page, 8);
    const back = await animation(page, '.svelte-flow__node[data-id="out"] canvas[data-testid="video-tile-thumb"]', ANIMATION_FRAMES);
    console.log(`[preview-gate] after return ${JSON.stringify(back)}`);
    expect(
      back.nonZeroFrac,
      `after returning to the viewport the OUTPUT paints a picture again ` +
        `(nonBlack ${back.nonZeroFrac.toFixed(3)})`,
    ).toBeGreaterThan(0.02);
    expect(
      back.distinct,
      `RETURN LEG: the picture must be ANIMATING again, not frozen on the last frame it had ` +
        `before it went off-screen — ${back.distinct} distinct signatures over ${back.samples} ` +
        `rAF samples. A stale frame satisfies "non-black" forever, which is why this asserts ` +
        `motion instead.`,
    ).toBeGreaterThan(2);
  });

  // ── THE PRESENTATION SURFACE THE VIEWPORT GATE CANNOT SEE ─────────────────
  //
  // `cardVisible` is fed by an IntersectionObserver over
  // `.svelte-flow__node[data-id]`. The DOCK FULL-VIEW renders the card OUTSIDE
  // that element, so a full-view can be the ONLY thing on screen while the
  // engine believes the card is off-screen. A viewport gate that consulted
  // nothing else would blank the dock — and "?shell=1 is not a complete gate"
  // plus the dock full-view are both already known blind spots in this repo.
  //
  // It works because presentation surfaces take a RENDER LEASE, and a lease
  // bypasses both the viewport gate and the cadence cap. That is derived from
  // the engine's own bookkeeping rather than special-cased per card, and this
  // test is what stops someone "simplifying" the lease branch away.
  test('a DOCK FULL-VIEW keeps its picture live with the flow node off-screen @webgl-smoke', async ({
    page,
    errorWatch,
  }) => {
    test.setTimeout(180_000);
    await page.goto('/rack?seed=none');
    await page.waitForLoadState('networkidle');
    await spawnPatch(
      page,
      [
        { id: 'src', type: 'toybox', position: { x: 40, y: 60 }, domain: 'video' },
        { id: 'out', type: 'videoOut', position: { x: 520, y: 60 }, domain: 'video' },
      ],
      [
        { id: 'e1', from: { nodeId: 'src', portId: 'out' }, to: { nodeId: 'out', portId: 'in' }, sourceType: 'video', targetType: 'video' },
      ],
    );
    await waitFrames(page, 8);

    // POSITIVE CONTROL first, as everywhere in this file: there is a moving
    // picture before the dock is involved at all.
    const before = await animation(page, '.svelte-flow__node[data-id="out"] canvas[data-testid="video-tile-thumb"]', ANIMATION_FRAMES);
    expect(before.distinct, 'POSITIVE CONTROL: the OUTPUT is animating to begin with').toBeGreaterThan(2);

    await page.evaluate(() => {
      (globalThis as unknown as { __openDockFullView: (id: string) => void }).__openDockFullView('out');
    });
    await waitFrames(page, 8);
    await moveOffScreen(page, ['src', 'out']);

    const sample = await sampleChain(page, 30);
    console.log(`[preview-gate] dock full-view, flow node off-screen ${JSON.stringify(sample)}`);
    expect(
      sample.cardVisible['out'],
      'the flow node really is off-screen — otherwise this test proves nothing about the dock',
    ).toBe(false);
    // The face body presents through its OWN rAF blit loop
    // (blitOutputToDrawingBuffer — the every-present-path funnel), so the
    // decision ledger the legacy card's gated loop wrote has no entry here.
    // The lease-beats-viewport fact is observable as ENGINE BLITS still being
    // issued while the engine believes the flow node is off-screen.
    expect(
      sample.blitCalls,
      'the dock full-view keeps issuing engine blits with the flow node off-screen — the ' +
        'presentation surface beats the viewport gate (a gate that consulted only ' +
        `cardVisible would have blanked the dock). blitCalls=${sample.blitCalls}`,
    ).toBeGreaterThan(0);
    for (const id of ['src', 'out']) {
      expect(
        sample.drawn[id],
        `${id} must keep rendering while a dock full-view presents the chain. ` +
          `drawn=${JSON.stringify(sample.drawn)}`,
      ).toBeGreaterThan(5);
    }

    // With the flow node off-screen the thumb has released; the LIVE surface
    // is the dock pane's face canvas (the lease holder).
    const dockLive = await animation(
      page,
      '[data-testid="dock-fullview-pane"][data-pane-node="out"] canvas[data-testid="videoout-face-canvas"]',
      ANIMATION_FRAMES,
    );
    console.log(`[preview-gate] dock full-view animation ${JSON.stringify(dockLive)}`);
    expect(
      dockLive.nonZeroFrac,
      `the dock full-view is painting (nonBlack ${dockLive.nonZeroFrac.toFixed(3)})`,
    ).toBeGreaterThan(0.02);
    expect(
      dockLive.distinct,
      `and it is ANIMATING, not holding the frame it had when the card left the viewport — ` +
        `${dockLive.distinct} distinct signatures over ${dockLive.samples} rAF samples.`,
    ).toBeGreaterThan(2);
  });
});

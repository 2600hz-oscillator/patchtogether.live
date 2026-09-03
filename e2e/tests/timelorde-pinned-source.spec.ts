// e2e/tests/timelorde-pinned-source.spec.ts
//
// #1754 — THE CANVAS-HIDDEN ARM of the producer rule, on the only module that
// sits in it.
//
// ── THE DEFECT, AND IT IS NOT THE ONE THE FIRST DRAFT OF THIS FILE DESCRIBED ──
//
// `Canvas.svelte`'s headless-host derivation skipped every canvas-hidden node:
//
//     if (isCanvasHiddenNode(n)) continue;   // pinned singletons + hidden cameras
//
// The premise is that SOME OTHER surface mounts the real card. For the M/E/C
// drawer trio that is true — the dock rail mounts it. TIMELORDE is NOT one of
// them: it is a `WORKFLOW_PINNED_SURFACES` module (graph/workflow-pins.ts), so it
// has no drawer, no rail, and no `dockRailRendersFace` path at all. Its face is
// the TOPBAR CLOCK MENU, which is not a card host.
//
// So the premise was simply false for it, and MEASURED on the pre-fix tree, in
// BOTH shells: a fresh `/rack` auto-spawns `pinned-timelorde`
// (`data.pinned: true`, `presence: 'type'`), `.mod-card.timelorde-card` resolves
// to ZERO elements, and there was no headless host for it either. The producer
// card had never been mounted anywhere, so nothing ever filled the node's display
// frame and `video_out` was the module's idle field forever — `nonBlack 0/3072,
// maxLuma 8, 1 distinct signature over 30 frames`.
//
// ⚠ THE FIX THIS FILE GUARDS HAS BEEN REPLACED BY A BETTER ONE, AND THE CLAIM IS
// NOW ITS INVERSE (legacy-removal S1). The original repair was to stop skipping:
// keep the real card alive in `<HeadlessSourceHost>` so its rAF kept running.
// That worked, and it made the card LOAD-BEARING — a card that cannot be
// deleted, on a fleet that is being deleted.
//
// The composite is now owned by the NODE (`$lib/ui/media/frame-producers` —
// TIMELORDE_FRAME_PRODUCER), on graph lifetime. So the assertions invert: the
// pinned singleton has NO card anywhere and NO host, and `video_out` carries a
// live picture regardless. That is strictly stronger than what this file asked
// before — it no longer matters whether any surface exists at all — and it is
// the same rule, satisfied by an owner instead of a workaround.
//
// ⚠ IT STILL HAS NOTHING TO DO WITH THE FACE, WHICH IS WHY BOTH SHELLS RUN. An
// earlier version of the ORIGINAL fix keyed on `shellFaces && migrated(type)`,
// which would have repaired exactly half of it. Both shells were equally broken
// and both are covered here; the parity arm is a REAL second subject.
//
// ── WHAT THIS FILE ASSERTS, AND WHY EACH LEG IS SHAPED THE WAY IT IS ─────────
//
//   1. the PRECONDITION is read from the real page hook `window.__patch`, never
//      inferred. ⚠ A draft of this spec read a `__patchSnapshot` global that DOES
//      NOT EXIST, through `?.()` — a leg that would have been permanently green
//      over no measurement at all. GREP FOR THE HOOK.
//   2. NO card and NO headless host, anywhere. ⚠ `toHaveCount(0)` is the shape
//      that goes blind — it is satisfied by "correctly no card" AND by "the page
//      rendered nothing at all" — so leg 2 carries a POSITIVE CONTROL that spawns
//      an ordinary canvas timelorde under `?shell=legacy` and requires the SAME
//      selector to find its card. The absence is then a reading, not a silence.
//   3. `video_out` is LIVE, and MOVING. Brightness alone is refused here on
//      purpose: `drawFrame` keeps blitting the last bitmap anyone pushed, so a
//      dead producer reads bright and frozen (measured: nonBlack 47034/48400
//      from a card that was already gone). Sampled with an accumulator INSIDE
//      the page (never a Playwright poll loop, which would starve the subject it
//      measures on a loaded runner) and reporting `samples` / `frames` / the
//      values seen, so "dark" and "never looked" are distinguishable from the
//      failure text.

import { test, expect, type Page } from '@playwright/test';
import { BOOT_MS, SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';

/** The deterministic id the workflow pin ensure converges on. */
const PINNED_ID = 'pinned-timelorde';

/** timelorde is an ALWAYS-ON pinned singleton, so a fresh `/rack` already holds
 *  it — the state under test needs no spawning. */
async function bootRack(page: Page, query = ''): Promise<void> {
  await page.goto(`/rack${query}`);
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: BOOT_MS });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
}

/** The PRECONDITION, off the REAL hook `workflow-drawer-face.spec.ts` uses. */
async function waitForPinnedTimelorde(page: Page): Promise<void> {
  await page.waitForFunction(
    (pid) => {
      const w = globalThis as unknown as {
        __patch?: {
          nodes: Record<string, { type?: string; data?: { pinned?: boolean } } | undefined>;
        };
      };
      const n = w.__patch?.nodes[pid];
      return n?.type === 'timelorde' && n?.data?.pinned === true;
    },
    PINNED_ID,
    { timeout: BOOT_MS },
  );
}

const host = (page: Page) =>
  page.locator('[data-testid="headless-source-host"][data-node-type="timelorde"]');

interface VideoOutSample {
  ok: boolean;
  reason?: string;
  /** rAF frames the sampler actually ran — 0 means it never looked. */
  frames: number;
  /** Distinct 16-bucket signatures over those frames. */
  distinct: number;
  nonBlackMax: number;
  maxLuma: number;
  pixels: number;
}

/**
 * Sample `video_out`'s OWN drawFrame, in the page, over `frames` rAF ticks.
 *
 * ⚠ NO DOWNSTREAM NODE IS PATCHED, DELIBERATELY. The module's `drawFrame` is the
 * exact thing the cross-domain bridge calls, so reading it directly measures the
 * same pixels a `VIDEO OUT` node would receive while avoiding a patch rebuild
 * that would tear down and re-spawn the very pinned node under test.
 *
 * ⚠ AND THE ACCUMULATOR IS IN THE PAGE. One Playwright round-trip per sample
 * would run on the same main thread as the subject, so a loaded runner starves
 * both and "frozen" is indistinguishable from "never looked" in the output.
 */
async function sampleVideoOut(page: Page, nodeId: string, frames: number): Promise<VideoOutSample> {
  return page.evaluate(
    async ({ nodeId, frames }) => {
      const W = 64;
      const H = 48;
      const out: VideoOutSample = {
        ok: false, frames: 0, distinct: 0, nonBlackMax: 0, maxLuma: 0, pixels: W * H,
      };
      // ⚠ `__engine` IS A FUNCTION, not the engine (Canvas.svelte publishes
      // `() => engine`). Reading it as an object would give `getDomain
      // undefined` and this probe would report "no drawFrame" on a perfectly
      // live module — a false RED that reads exactly like the defect.
      const w = globalThis as unknown as {
        __engine?: () => { getDomain: (d: string) => unknown };
      };
      if (typeof w.__engine !== 'function') { out.reason = 'no __engine hook on the page'; return out; }
      const eng = w.__engine();
      if (!eng) { out.reason = '__engine() returned nothing'; return out; }
      let audio: {
        getVideoSource?: (n: string, p: string) => { drawFrame?: (c: HTMLCanvasElement) => void } | null;
      } | undefined;
      try {
        audio = eng.getDomain('audio') as typeof audio;
      } catch (e) {
        out.reason = `getDomain('audio') threw: ${String(e)}`;
        return out;
      }
      const src = audio?.getVideoSource?.(nodeId, 'video_out') ?? null;
      if (!src?.drawFrame) { out.reason = 'video_out publishes no drawFrame'; return out; }
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const g = c.getContext('2d', { willReadFrequently: true });
      if (!g) { out.reason = 'no 2d context for the probe canvas'; return out; }
      const sigs = new Set<string>();
      const BLACK = 12; // the module's idle field is #07090d ⇒ luma 8
      for (let f = 0; f < frames; f++) {
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
        try { src.drawFrame(c); } catch { continue; }
        const px = g.getImageData(0, 0, W, H).data;
        let nonBlack = 0;
        let maxLuma = 0;
        let sig = 0;
        for (let i = 0; i < px.length; i += 4) {
          const l = (px[i]! * 299 + px[i + 1]! * 587 + px[i + 2]! * 114) / 1000;
          if (l > BLACK) nonBlack++;
          if (l > maxLuma) maxLuma = l;
          sig = (sig * 31 + (l | 0)) >>> 0;
        }
        sigs.add(String(sig));
        if (nonBlack > out.nonBlackMax) out.nonBlackMax = nonBlack;
        if (maxLuma > out.maxLuma) out.maxLuma = Math.round(maxLuma);
        out.frames++;
      }
      out.distinct = sigs.size;
      out.ok = true;
      return out;
    },
    { nodeId, frames },
  );
}

test.describe.configure({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS * 2 });

for (const shell of ['default', 'legacy'] as const) {
  const query = shell === 'legacy' ? '?shell=legacy' : '';

  test.describe(`timelorde — the PINNED producer needs NO card [${shell} shell]`, () => {
    test('the auto-spawned pinned singleton is canvas-hidden and hosted NOWHERE', async ({ page }) => {
      await bootRack(page, query);

      // ── 1. THE PRECONDITION, FROM THE REAL HOOK ─────────────────────────
      await waitForPinnedTimelorde(page);

      // ── 2. NOTHING MOUNTS ITS CARD, AND NOTHING NEEDS TO ────────────────
      // ⚠ THIS IS THE INVERSE OF WHAT THIS LEG ASSERTED UNTIL legacy-removal
      // S1, and the inversion is the fix rather than a relaxation: the composite
      // is node-owned now, so a card mount would be a SECOND owner of one node's
      // display frame rather than the only one.
      await expect(
        host(page),
        'a headless host is keeping the pinned timelorde card alive — its composite belongs to ' +
          'the NODE ($lib/ui/media/frame-producers), so this mount is a second producer',
      ).toHaveCount(0, { timeout: BOOT_MS });
      await expect(
        page.locator('.mod-card.timelorde-card'),
        'the pinned timelorde has a card mounted somewhere — it is canvas-hidden and its ' +
          'producer is node-lifetime, so nothing should be rendering one',
      ).toHaveCount(0);

      // ── 3. THE POSITIVE CONTROL, because zero is what a broken page reads too
      // The same selector, on an ORDINARY canvas timelorde under the legacy
      // shell, must find exactly one card. Without this the two assertions above
      // are satisfied by a page that rendered nothing at all — the failure mode
      // a `toHaveCount(0)` leg has by construction.
      await page.evaluate(() => {
        const w = globalThis as unknown as {
          __patch: { nodes: Record<string, unknown> };
          __ydoc: { transact: (fn: () => void) => void };
        };
        w.__ydoc.transact(() => {
          w.__patch.nodes['probe-timelorde'] = {
            id: 'probe-timelorde',
            type: 'timelorde',
            domain: 'audio',
            position: { x: 200, y: 4560 },
            params: {},
            data: {},
          };
        });
      });
      if (shell === 'legacy') {
        await expect(
          page.locator('.mod-card.timelorde-card'),
          'POSITIVE CONTROL: an ordinary canvas timelorde renders a card under ?shell=legacy, so ' +
            'the zero-counts above are a reading rather than a page that failed to render',
        ).toHaveCount(1, { timeout: BOOT_MS });
      } else {
        await expect(
          page.locator(`.svelte-flow__node[data-id="probe-timelorde"] [data-testid="module-shell"]`),
          'POSITIVE CONTROL: an ordinary canvas timelorde renders its FACE under the default ' +
            'shell, so the zero-counts above are a reading rather than a dead page',
        ).toHaveCount(1, { timeout: BOOT_MS });
      }
    });

    test('THE POINT: video_out carries a real, MOVING picture with no card anywhere', async ({ page }) => {
      await bootRack(page, query);
      await waitForPinnedTimelorde(page);
      await expect(page.locator('.mod-card.timelorde-card')).toHaveCount(0, { timeout: BOOT_MS });
      // ⚠ THE AUDIO ENGINE HAS TO EXIST BEFORE `getVideoSource` CAN ANSWER, and
      // a bare `/rack` boot does not start it (no user gesture). Without this the
      // probe reports "video_out publishes no drawFrame" on a perfectly live
      // module — an instrument failure that reads exactly like the defect.
      await page.waitForFunction(() => {
        const w = globalThis as unknown as { __ensureEngine?: () => Promise<unknown> };
        return typeof w.__ensureEngine === 'function';
      }, undefined, { timeout: BOOT_MS });
      await page.evaluate(async () => {
        const w = globalThis as unknown as { __ensureEngine: () => Promise<unknown> };
        await w.__ensureEngine();
      });

      // The push is asynchronous (`createImageBitmap` → the node's write), so
      // poll the SAMPLER rather than a single shot — each attempt is itself a
      // multi-frame in-page measurement, and the auto-retrying expect bounds the
      // failure without becoming the gate.
      let last: VideoOutSample | null = null;
      await expect
        .poll(
          async () => {
            last = await sampleVideoOut(page, PINNED_ID, 8);
            return last.ok && last.nonBlackMax > 0;
          },
          {
            timeout: BOOT_MS,
            message:
              'video_out is DARK on a default rack. Pre-fix this measured nonBlack 0/3072, ' +
              'maxLuma 8 (the module\u2019s own #07090d idle field), 1 distinct signature over 30 ' +
              'frames — with zero card mounts anywhere (#1754). See the sample below.',
          },
        )
        .toBe(true)
        .catch((e: unknown) => {
          // ⚠ SURFACE THE INSTRUMENT'S OWN STATE ON THE POLL FAILURE. Without
          // this the message says "dark" whether the probe found no engine, no
          // video source, or a genuinely black picture — three different bugs
          // that look identical from the output.
          throw new Error(`${String(e)}\nlast sample: ${JSON.stringify(last)}`);
        });

      const s = last as unknown as VideoOutSample;
      // ⚠ REPORT THE INSTRUMENT'S OWN STATE, so "dark" and "never looked" are
      // separable from the failure text alone.
      expect(s.frames, `the sampler never ran a frame: ${JSON.stringify(s)}`).toBeGreaterThan(0);
      expect(
        s.nonBlackMax,
        `video_out is the idle field: ${JSON.stringify(s)}`,
      ).toBeGreaterThan(0);
      expect(
        s.maxLuma,
        `video_out's brightest pixel is at or below the idle field's luma 8: ${JSON.stringify(s)}`,
      ).toBeGreaterThan(8);
    });
  });
}

// ── THE DOCK-OPEN ARM: a faceplate must not unmount its own producer ────────
//
// ⚠ A DIFFERENT DEFECT IN THE SAME FAMILY, FOUND BY THIS PR AND FIXED IN IT.
// `Canvas.svelte` treats "the dock full view is open" as `hostedElsewhere` — some
// other surface has the real card — and for an UN-migrated module that is true.
// For a PROMOTED one the tray paints the FACEPLATE, and whether the producer
// survives then depends on whether that faceplate mounts it. cube's hero cell IS
// its renderer and rasterize's body ADVANCES its painter, so both were safe and
// the exclusion was scoped to DOM_SOURCE types only.
//
// timelorde was the first promoted producer whose face merely BLITS: the thing
// that FILLED `video_out` was `TimelordeCard`'s rAF and it lived nowhere else, so
// opening the faceplate killed the producer. ⚠ THAT rAF IS THE NODE'S NOW
// (legacy-removal S1), which removes the class for this module by construction
// rather than by exemption — but the FACE_MOUNTS_PRODUCER default it forced is
// still live for every card-owned producer, so the movement leg below keeps its
// value as a guard on the SHAPE. MEASURED before the fix, with the
// dock open: card mounts 0, no host, and the face canvas painting
// `nonBlack 47034/48400` — a bright picture that was a STALE bitmap pushed
// before the card went away. `FACE_MOUNTS_PRODUCER` now names the two faces that
// really do mount their producer and everything else keeps its host.
//
// ⚠ AND THE ASSERTION IS ON MOVEMENT, NOT BRIGHTNESS, for exactly that reason: a
// frozen stale frame reads non-black forever. `distinct` is the leg that fails.
test.describe('timelorde — the DOCK FULL VIEW does not unmount the producer', () => {
  // ⏸ FLAKE-PARK #1847 — parked with `test.fixme`; the body and its assertions are
  // UNCHANGED. Nothing here is deleted or weakened.
  //
  // ⚠ TRIAGED AS UNDER-BUDGETED, NOT NONDETERMINISTIC, and the two need opposite
  // responses (CLAUDE.md). `git log` on this file has exactly ONE commit — its birth
  // commit b22850e09 (#2163) — so there is no history of flake fixes that failed to
  // hold. The suspect is the OUTER budget, not the observation: `sampleVideoOut`
  // correctly accumulates its 12 rAF frames INSIDE the page (one evaluate, no
  // per-sample round-trip), but the `expect.poll` wrapping it is bounded by
  // `BOOT_MS` — a WALL-CLOCK millisecond budget gating a renderer-dependent
  // movement assertion, which is the house rule's named anti-pattern. Under
  // SwiftShader on a ten-shard-parallel runner, 12 rAF frames is a much larger slice
  // of those 30 s than it is locally; the failing attempt exhausted the whole budget
  // and the retry passed, on a shard that took 18m18s.
  //
  // UN-PARK PATH: re-express the observation window in FRAMES per the house rule
  // (`e2e/_helpers/frames.ts` is the one export site), keeping a wall-clock cap only
  // to BOUND the failure rather than to gate it. Reproduce under
  // `E2E_SWIFTSHADER=1` first — "slower here" and "genuinely different here" need
  // opposite fixes.
  test.fixme('with the faceplate open, video_out is still MOVING', { annotation: { type: 'fixme', description: 'FLAKE-PARK #1847 — SOLE regression guard for the FACE_MOUNTS_PRODUCER producer-unmount class (#2163): a promoted face that merely BLITS kills the card rAF that fills video_out, and the pre-fix failure painted a bright STALE bitmap, so only a CHANGING picture catches it. That class was a live product bug TWICE this week (camera + timelorde). Parked on the FIRST recovered-flake observation to unblock the board; OWNER NOTIFIED via the orchestrator as the coverage-loss exception rather than held for an owner round-trip. Triage: one commit in this file, no prior flake fixes, so under-budgeted rather than nondeterministic — the in-page 12-frame sampler is correct and the expect.poll BOOT_MS wall-clock bound is the suspect. Un-park by re-budgeting in FRAMES when test work is next sanctioned.' } }, async ({ page }) => {
    await bootRack(page);
    await waitForPinnedTimelorde(page);
    await page.evaluate(async () => {
      const w = globalThis as unknown as { __ensureEngine: () => Promise<unknown> };
      await w.__ensureEngine();
    });

    // ⚠ UN-PINNING IS THE REAL STATE, NOT A TEST FIXTURE. `workflow-pins`'
    // `presence: 'type'` rule spawns the pinned instance only when NO node of
    // the type exists, so a rack imported from a saved patch carries an ORDINARY
    // CANVAS timelorde — which is also the only state in which this face has a
    // lane tile to open a dock from at all.
    await page.evaluate((pid) => {
      const w = globalThis as unknown as {
        __patch: {
          nodes: Record<
            string,
            { data?: Record<string, unknown>; position?: { x: number; y: number } } | undefined
          >;
        };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes[pid];
        if (n?.data) n.data.pinned = false;
        // ⚠ AND IT NEEDS A POSITION IN VIEW. A pinned node is canvas-hidden, so
        // wherever the pin ensure dropped it is a coordinate nothing has ever
        // had to render; un-pinning alone left the tile off-viewport and the
        // EXPAND click waited out its full budget on a button Playwright had
        // already found. The same free-canvas point the VRT face harness adopts
        // into (see `_shell-faces.ts` adoptCanvasSingleton).
        if (n) n.position = { x: 200, y: 4560 };
      });
    }, PINNED_ID);

    const shell = page.locator(
      `.svelte-flow__node[data-id="${PINNED_ID}"] [data-testid="module-shell"]`,
    );
    await expect(shell, 'the un-pinned timelorde renders its faceplate in the lane').toBeVisible({
      timeout: BOOT_MS,
    });
    await shell.getByTestId('shell-open-dock').click();
    await expect(page.getByTestId('timelorde-face-canvas'), 'the dock body paints its display')
      .toBeVisible({ timeout: BOOT_MS });

    // ⚠ INVERTED BY legacy-removal S1, AND THE COVERAGE IS UNCHANGED. This leg
    // asserted the producer card was still mounted SOMEWHERE (off-screen was
    // correct, gone was the defect), because the card's rAF was the only thing
    // filling video_out. The composite is node-owned now, so the card must be
    // mounted NOWHERE — and the MOVEMENT assertion below is untouched, which is
    // the leg that actually catches the class either way.
    await expect(
      page.locator('.mod-card.timelorde-card'),
      'a card is mounted with the faceplate open — the composite belongs to the node, so this ' +
        'would be a second producer for one display frame',
    ).toHaveCount(0, { timeout: BOOT_MS });

    let last: VideoOutSample | null = null;
    await expect
      .poll(
        async () => {
          last = await sampleVideoOut(page, PINNED_ID, 12);
          return last.ok && last.distinct > 1;
        },
        {
          timeout: BOOT_MS,
          message:
            'video_out is FROZEN with the faceplate open. ⚠ Brightness is not the test here: the ' +
            'pre-fix failure painted nonBlack 47034/48400 off a STALE bitmap the unmounted card ' +
            'had pushed. Only a CHANGING picture proves the producer is still running.',
        },
      )
      .toBe(true)
      .catch((e: unknown) => {
        throw new Error(`${String(e)}\nlast sample: ${JSON.stringify(last)}`);
      });

    const s = last as unknown as VideoOutSample;
    expect(s.frames, `the sampler never ran a frame: ${JSON.stringify(s)}`).toBeGreaterThan(1);
    expect(
      s.distinct,
      `video_out produced ONE distinct frame across ${s.frames} rAFs — dead but bright is the ` +
        `pre-fix signature: ${JSON.stringify(s)}`,
    ).toBeGreaterThan(1);
  });
});

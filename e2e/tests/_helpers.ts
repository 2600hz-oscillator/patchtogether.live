// e2e/tests/_helpers.ts
//
// Shared test helpers for spawning arbitrary modules + edges via the dev-mode
// `__patch` and `__ydoc` window globals (Canvas.svelte exposes these in dev).

import { expect, type Locator, type Page, type APIRequestContext } from '@playwright/test';

export interface SpawnNode {
  id: string;
  type: string;
  position?: { x: number; y: number };
  params?: Record<string, number>;
  /** Phase 0 video spike — when omitted, defaults to 'audio'. Tests that
   *  spawn video modules (LINES, OUTPUT) pass 'video' explicitly. The
   *  io-spec consistency test infers it from the registered module def
   *  by reading window.__moduleSpecs first; see that test's spawnPatch
   *  call for the pattern. The 'meta' domain covers non-engine cards
   *  (sticky notes, future paper-like utilities). */
  domain?: 'audio' | 'video' | 'meta';
}

export interface SpawnEdge {
  id: string;
  from: { nodeId: string; portId: string };
  to: { nodeId: string; portId: string };
  sourceType?: string;
  targetType?: string;
}

// (gotoCanvas was pruned as an unreferenced export — LoC campaign row 16.
// The route-move seam it reserved now lives in `_fixtures.ts`'s `rack`
// fixture, which converted specs actually use.)

/**
 * Match the Playwright/CDP errors thrown when the page's execution context
 * is torn down out-of-band during an `evaluate` / `waitForFunction` — most
 * commonly because Vite's HMR client lost its websocket under CPU pressure
 * (parallel-worker stress) and triggered a full reload (`[vite] connecting...`),
 * or because a navigation interrupted an in-flight evaluate. None of these
 * indicate a test-logic failure: the page recovers on its own, we just have
 * to redo the page-side work after it does.
 */
function isTransientPageError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('Execution context was destroyed') ||
    msg.includes('Target closed') ||
    msg.includes('Target page, context or browser has been closed') ||
    msg.includes('frame was detached') ||
    msg.includes('Cannot find context with specified id')
  );
}

/**
 * Viewport reveal — center the viewport on the given (just-injected) nodes when
 * they aren't already comfortably on-screen at a clickable zoom.
 *
 * Why: `spawnPatch` writes nodes DIRECTLY into `__patch` at their flow-space
 * position, bypassing the palette's `screenToFlowPosition` anchor. The default
 * viewport frames the pinned lanes + purple video zone, which sit far down in
 * flow space (large Y); a free-canvas card injected at a small-Y position is
 * therefore scrolled OFF-SCREEN. SvelteFlow transforms the pane (no native
 * scroll), so Playwright's click auto-scroll can't reach it and every
 * right-click / patch-trigger on that card times out. Real users never hit this
 * (palette spawns land at the in-view click point); this mirrors that.
 *
 * No-op when every target node's center already projects inside the pane at a
 * clickable zoom (≥ 0.4) — an already-framed spawn keeps its viewport
 * untouched. That internal early-return is why this is called UNCONDITIONALLY
 * (see spawnPatch): the check decides, not the URL.
 */
async function revealWorkflowNodes(page: Page, ids: string[]): Promise<void> {
  await page
    .evaluate((nodeIds) => {
      const w = globalThis as unknown as {
        __flow?: {
          getInternalNode?: (id: string) => {
            position?: { x: number; y: number };
            internals?: { positionAbsolute?: { x: number; y: number } };
            measured?: { width?: number; height?: number };
          } | undefined;
          getViewport?: () => { x: number; y: number; zoom: number };
          setViewport?: (vp: { x: number; y: number; zoom: number }) => void;
        };
      };
      const flow = w.__flow;
      if (!flow?.getInternalNode || !flow.getViewport || !flow.setViewport) return;

      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, any = false;
      for (const id of nodeIds) {
        const n = flow.getInternalNode(id);
        if (!n) continue;
        const p = n.internals?.positionAbsolute ?? n.position;
        if (!p) continue;
        const width = n.measured?.width ?? 200;
        const height = n.measured?.height ?? 120;
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x + width);
        maxY = Math.max(maxY, p.y + height);
        any = true;
      }
      if (!any) return;

      // ⚠ SCOPED TO THE MAIN CANVAS — see MAIN_CANVAS below. A bare
      // `querySelector('.svelte-flow__pane')` returns whichever comes FIRST in
      // the DOM, and a workflow rack now has up to three (the canvas plus one
      // per `HeadlessSourceHost`). It happens to be the canvas today only
      // because the host wrappers are later siblings inside `.flow`.
      const pane =
        document.querySelector('.flow > .svelte-flow .svelte-flow__pane')
        ?? document.querySelector('.flow > .svelte-flow');
      if (!pane) return;
      const rect = pane.getBoundingClientRect();
      const vp = flow.getViewport();

      // Pane-local projection of the union-bbox center (xyflow viewport maps
      // flow → pane-local px: local = flow*zoom + vp).
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      const localX = cx * vp.zoom + vp.x;
      const localY = cy * vp.zoom + vp.y;
      const onScreen =
        localX > 0 && localX < rect.width && localY > 0 && localY < rect.height;
      if (onScreen && vp.zoom >= 0.4) return; // already interactable

      // Frame the injected card(s) near the UPPER-LEFT (not dead-center): tests
      // often open a bottom drawer (C keymap → dock-zone-bottom) that covers the
      // lower half, and the bottom-right holds the minimap/feedback overlays. A
      // centered card would be occluded; upper-left mirrors the historical
      // near-origin placement these pre-lanes tests were written against.
      const zoom = 0.6; // readable — cards render large enough to click reliably
      flow.setViewport({ x: 220 - minX * zoom, y: 120 - minY * zoom, zoom });
    }, ids)
    .catch(() => {
      /* best-effort — a missing __flow (non-dev build) just leaves the viewport
         as-is; the subsequent interaction will surface any real problem. */
    });
}

// ── A CONTROL OUTSIDE THE PANE CAN ONLY BE CLICKED BY WINNING A RACE ────────
//
// SvelteFlow pans by TRANSFORMING `.svelte-flow__viewport`; the wrapper is
// `overflow: hidden`. An overflow:hidden box is still scrollable FROM SCRIPT,
// and a transformed descendant contributes to its scrollable overflow — so a
// tall card really does give `.svelte-flow` a scrollHeight far past its
// clientHeight, and Playwright's `scrollIntoViewIfNeeded` happily scrolls it.
// xyflow then UNDOES that scroll, by design, in
// `@xyflow/svelte/…/SvelteFlow/Wrapper.svelte`:
//
//     // Undo scroll events, preventing viewport from shifting when nodes
//     // outside of it are focused
//     function wrapperOnScroll(e) { e.currentTarget.scrollTo({top:0,left:0,…}) }
//
// So every click on an off-pane control is a RACE between Playwright's
// post-scroll mouse dispatch and that undo handler, and the loser is reported
// as a nonsense interception by whatever element now sits at the stale point.
//
// MEASURED on the clip editor (2026-08-13, this machine, one PASSING run):
// `.svelte-flow` clientHeight 622 / scrollHeight 1204 CSS px; the row-33
// checkbox sits at y=819 CSS px, i.e. 197 px BELOW the pane. A page-side
// scroll recorder caught the whole fight in the green run —
// `[{top:473},{top:0}]`, 0.04 ms apart. On CI (run 31726508578, shard 4/10)
// the undo won instead and `check()` on `clipplayer-scalerow-cp-52` timed out
// against "row g7 (…-103) intercepts pointer events": 819 − 473 = 346 px is
// exactly where row index 3 (g7) sits. Same layout, same scroll, opposite
// winner — that is a race, not a slow machine.
//
// THE FIX IS TO STOP NEEDING THE BROWSER SCROLL: pan the flow viewport, which
// is the app's own scroll model and the one thing xyflow will not undo. Once
// the element is genuinely inside the pane, `scrollIntoViewIfNeeded` is a
// no-op, no scroll event fires, and there is nothing left to race.

/** The SvelteFlow viewport (pan + zoom). Same seam `revealWorkflowNodes` uses. */
export interface FlowViewport {
  x: number;
  y: number;
  zoom: number;
}

/** Read the current flow viewport. Throws if the `__flow` dev seam is absent —
 *  a silent fallback here would put the caller back on the racy browser-scroll
 *  path with no marker. */
export async function getFlowViewport(page: Page): Promise<FlowViewport> {
  return await page.evaluate(() => {
    const flow = (
      globalThis as unknown as {
        __flow?: { getViewport?: () => { x: number; y: number; zoom: number } };
      }
    ).__flow;
    if (!flow?.getViewport) throw new Error('__flow.getViewport missing (non-dev build?)');
    return flow.getViewport();
  });
}

/** Restore a viewport captured with `getFlowViewport` (e.g. after revealing a
 *  control deep in a tall card, so the rest of the spec sees the framing it
 *  was written against). */
export async function setFlowViewport(page: Page, vp: FlowViewport): Promise<void> {
  await page.evaluate((v) => {
    const flow = (
      globalThis as unknown as {
        __flow?: { setViewport?: (vp: { x: number; y: number; zoom: number }) => void };
      }
    ).__flow;
    if (!flow?.setViewport) throw new Error('__flow.setViewport missing (non-dev build?)');
    flow.setViewport(v);
  }, vp);
}

/**
 * PAN the flow viewport until `target`'s box is fully inside the pane, then
 * WAIT until it actually is. No-op (and no pan) when it already is, so it is
 * cheap to call before every interaction in a loop.
 *
 * This is the sound alternative to letting Playwright scroll the wrapper: see
 * the block comment above for why that scroll is undone under us. Nothing here
 * is expressed in milliseconds — the wait is on the CONTAINMENT itself, which
 * is the signal that makes the element clickable.
 *
 * Fails loudly (never silently leaves the element outside) so a regression
 * reddens here, at the cause, instead of 30 s later as an interception by an
 * unrelated element.
 */
export async function revealInPane(page: Page, target: Locator, margin = 24): Promise<void> {
  const geometry = (el: Element, m: number) => {
    const pane =
      document.querySelector('.svelte-flow__pane') ?? document.querySelector('.svelte-flow');
    if (!pane) return null;
    const r = el.getBoundingClientRect();
    const p = pane.getBoundingClientRect();
    return {
      inside:
        r.left >= p.left + m &&
        r.right <= p.right - m &&
        r.top >= p.top + m &&
        r.bottom <= p.bottom - m,
      // Center the offending axis rather than edge-align it: the pane's own
      // bottom-right chrome (minimap, attribution) is clickable and would
      // happily intercept an element parked against the edge.
      dx:
        r.left >= p.left + m && r.right <= p.right - m
          ? 0
          : p.left + p.width / 2 - (r.left + r.width / 2),
      dy:
        r.top >= p.top + m && r.bottom <= p.bottom - m
          ? 0
          : p.top + p.height / 2 - (r.top + r.height / 2),
      el: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      pane: { x: Math.round(p.x), y: Math.round(p.y), w: Math.round(p.width), h: Math.round(p.height) },
    };
  };

  const before = await target.evaluate(geometry, margin);
  if (!before) throw new Error('revealInPane: no .svelte-flow pane on the page');
  if (before.inside) return;

  const vp = await getFlowViewport(page);
  await setFlowViewport(page, { x: vp.x + before.dx, y: vp.y + before.dy, zoom: vp.zoom });

  // Wait on the real signal — the box landing inside the pane — not on a
  // frame count or a sleep. Units are CSS px, stated in the message.
  await expect
    .poll(async () => (await target.evaluate(geometry, margin))?.inside ?? false, {
      timeout: 5000,
      message:
        `revealInPane: after panning by (${Math.round(before.dx)}, ${Math.round(before.dy)}) CSS px ` +
        `the target is STILL outside the pane (target ${JSON.stringify(before.el)} vs ` +
        `pane ${JSON.stringify(before.pane)}, margin ${margin} CSS px). Clicking it would ` +
        `depend on winning the scroll-undo race — see the block comment in _helpers.ts.`,
    })
    .toBe(true);
}

/**
 * NEGATIVE CONTROL for `revealInPane`, page-side (never a Playwright poll —
 * the accumulator lives in the page, so a starved main thread cannot make
 * "nothing scrolled" and "we never looked" identical).
 *
 * Installs a capture-phase scroll recorder on `.svelte-flow`. A non-empty
 * reading means SOMETHING needed the browser scroll that xyflow undoes, i.e.
 * the click was decided by a race. Verified to MOVE: with the reveal removed,
 * this recorder reads `[473, 0]` on an otherwise-GREEN local run of the
 * custom-scale spec — i.e. it reddens on the CAUSE while the symptom is hiding.
 */
export async function watchPaneScrollUndo(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = document.querySelector('.svelte-flow') as HTMLElement | null;
    if (!w) throw new Error('watchPaneScrollUndo: no .svelte-flow wrapper');
    const seen: number[] = [];
    (globalThis as unknown as { __paneScrollUndo?: number[] }).__paneScrollUndo = seen;
    w.addEventListener('scroll', () => seen.push(Math.round(w.scrollTop)), { capture: true });
  });
}

/** Read the scroll tops recorded since `watchPaneScrollUndo` — `[]` is the
 *  passing value. */
export async function readPaneScrollUndo(page: Page): Promise<number[]> {
  return await page.evaluate(
    () => (globalThis as unknown as { __paneScrollUndo?: number[] }).__paneScrollUndo ?? [],
  );
}

// ── THE MOUNT WAIT IS COUNTED IN FRAMES, NOT MILLISECONDS ───────────────────
//
// CLAUDE.md, verbatim: "NEVER express a renderer-dependent wait in
// MILLISECONDS — count FRAMES … a wall-clock budget silently becomes a
// DIFFERENT NUMBER OF FRAMES on every renderer, so it is not one assertion —
// it is a different assertion per machine."
//
// This wait was 5000 ms flat, and the CI red it cost was
// `<webgl2-card>: every declared output emits a measurable signal` timing out
// INSIDE spawnPatch on shard 7/10 (run 30727526282) — first attempt AND
// retry — while the same test passed locally under the SAME software renderer.
// (The module measured below was a live-WebGL2-card audio module, DELETED
// 2026-08-10; the numbers are kept because the ARGUMENT is about the renderer,
// not about that module — every other row reproduces it.)
//
// MEASURED, one machine, real GPU vs `E2E_SWIFTSHADER=1`. The left pair is
// what the old budget was denominated in; the right pair is what a mount
// actually costs:
//
//     module      spawnPatch WALL CLOCK      FRAMES to mount
//                   GPU / SwiftShader          GPU / SwiftShader
//     webgl2-card  190 ms /  1437 ms  7.6×      5  /  4      ← live WebGL2 card
//     b3ntb0x       62 ms /   371 ms  6.0×      4  /  4
//     cube         161 ms /   423 ms  2.6×      4  /  4
//     vca           66 ms /   247 ms  3.7×      4  /  3      ← plain DOM, control
//
// READ THE TWO COLUMNS AGAINST EACH OTHER — that is the whole argument, and it
// is a NEGATIVE CONTROL ON THE INSTRUMENT rather than an appeal to the rule:
// perturb the renderer and the wall clock moves 7.6×, while the frame count
// does not move at all (3–5 everywhere). A mount is a FIXED, SMALL amount of
// main-thread work; what the renderer changes is how long each of those frames
// takes. Milliseconds were measuring the renderer. Frames measure the mount.
//
// So the old 5000 ms bought that card ~26× headroom on a developer GPU and
// ~3.5× under SwiftShader — before CI's slower CPU and TEN parallel e2e
// shards, which is where it ran out. (The 7.6× is the same SwiftShader tax
// CLAUDE.md records for backdraft PURE TV. Not this module being special.)
//
// Playwright's `waitForFunction` polls on rAF, so counting invocations counts
// FRAMES. 300 frames is ~5 s at 60 fps — byte-for-byte today's behaviour on a
// healthy renderer, so nothing that passes now can start failing — and it is
// 75× the measured 4-frame worst case, which is the headroom that survives
// being carried onto a contended runner.
//
// WHY THIS IS NOT "BUMPING A TIMEOUT". The mount wait is a PRECONDITION of the
// test, never its assertion — the assertion is "every declared output emits a
// measurable signal". Its only failure mode is a false RED; no amount of
// patience can turn a broken module green. On a passing run the wait ends the
// instant the node mounts, so this costs ZERO CI wall-time. It only stops the
// harness giving up early on a starved main thread.
//
// The wall-clock cap survives in exactly the role CLAUDE.md leaves it — "keep
// a wall-clock cap only to BOUND THE FAILURE, never as the gate". Every caller
// that already passes `mountTimeout` (15 s / 20 s / 30 s) keeps the cap it
// chose.
//
// ⚠ NOT taken here, deliberately: the registry card sweep
// (`io-spec-consistency.spec.ts`, which absorbed `modules.spec.ts` in #1861)
// still carries a private hand-typed `HEAVY_RENDER` set naming seven modules.
// The slowest-to-mount module measured above was never on it, while `b3ntb0x`
// (4× faster) was; and no other registry-driven sweep can even read the list,
// which is why the per-port sweeps auto-enrol on the bare default. That set is
// no longer load-bearing now the default is frame-gated, but it is still a
// fact about modules living in one spec's literal (it is at least ANCHORED to
// REGISTRY now, so a name that stops resolving reddens). Consolidating it into
// something every sweep can read is its own change.

/** Frames of main-thread progress a node gets to appear in. ~5 s at 60 fps —
 *  identical to the old wall-clock gate on a healthy renderer — and 75× the
 *  measured 4-frame worst case (a live-WebGL2 card under SwiftShader). */
export const MOUNT_FRAME_BUDGET = 300;

/** Wall-clock cap. BOUNDS THE FAILURE so a wedged page cannot eat a whole
 *  per-test budget; it is NOT the gate. Sized off the measurement above: a
 *  mount is ~4 frames, so a page still unmounted after 30 s is wedged rather
 *  than slow, and 30 s is ~7500× the work the wait is actually waiting on. */
export const MOUNT_CAP_MS = 30_000;

/**
 * Wait until every `id` has a mounted SvelteFlow node wrapper, budgeted in
 * RENDERED FRAMES with a wall-clock cap.
 *
 * Assert by node ID (SvelteFlow tags each wrapper with `data-id="<nodeId>"`)
 * rather than a TOTAL-count equality: a synced rackspace auto-spawns the
 * singleton TIMELORDE clock, and in the 2-context @collab flow that auto-spawn
 * can land AFTER spawnPatch's clear+rebuild transact. A strict
 * `=== nodes.length` saw `doom + timelorde` (2 ≠ 1) and timed out; waiting for
 * the exact requested IDs is race-proof AND more precise — it verifies the
 * nodes we asked for actually mounted, instead of trusting a count an
 * auto-spawned node can spuriously satisfy.
 *
 * Exported so `spawn-mount-budget.spec.ts` can drive the policy under a
 * deliberately starved main thread — the wait is the thing that was wrong, so
 * the wait is the thing that gets a test.
 */
export async function waitForMounted(
  page: Page,
  ids: string[],
  opts: { frames?: number; capMs?: number; selector?: (id: string) => string } = {},
): Promise<void> {
  const frames = opts.frames ?? MOUNT_FRAME_BUDGET;
  const capMs = opts.capMs ?? MOUNT_CAP_MS;
  // A fresh counter key per wait: the predicate is re-evaluated in the page on
  // every rAF and has to accumulate ACROSS invocations, and two overlapping
  // waits must not share a tally.
  const key = `__mountFrames_${Math.random().toString(36).slice(2)}`;
  try {
    await page.waitForFunction(
      ({ ids, frames, key }) => {
        const w = globalThis as unknown as Record<string, number>;
        w[key] = (w[key] ?? 0) + 1; // one tick per rAF = one FRAME
        const missing = ids.filter(
          (id) => document.querySelector(`.svelte-flow__node[data-id="${id}"]`) === null,
        );
        if (missing.length === 0) return true;
        if (w[key]! >= frames) {
          throw new Error(
            `mount FRAME budget exhausted after ${w[key]} frames — not mounted: ` +
              `${missing.join(', ')}`,
          );
        }
        return false;
      },
      { ids, frames, key },
      // `polling: 'raf'` is Playwright's default; stated explicitly because the
      // frame COUNT above is only a frame count while it holds.
      { timeout: capMs, polling: 'raf' },
    );
  } finally {
    await page.evaluate((k) => {
      delete (globalThis as unknown as Record<string, unknown>)[k];
    }, key).catch(() => { /* context gone (HMR reload) — the retry loop owns it */ });
  }
}

/**
 * Spawn a set of nodes + edges into the patch graph atomically.
 * Requires the dev-only window globals (Canvas exposes them under `import.meta.env.DEV`).
 *
 * The whole sequence (wait-for-globals → ensureEngine → transact → wait-for-DOM)
 * is wrapped in a bounded retry loop so the helper survives a Vite-HMR full
 * reload mid-spawn: under `--workers=4 --repeat-each=10`+ stress, the dev
 * server's HMR websocket occasionally drops and reconnects, which destroys
 * the page's execution context out from under an in-flight `page.evaluate`.
 * Each retry re-waits for `__ensureEngine` to be re-bound by Canvas's $effect
 * after the reload, then restarts the sequence from scratch. Pre-existing
 * latent flake; Playwright's CI `retries: 1` masked it but it still slowed
 * stress runs. The retry is *not* a band-aid for an avoidable race — HMR
 * reload is async to the test and outside the helper's control; handling it
 * here is the correct seam.
 */
export async function spawnPatch(
  page: Page,
  nodes: SpawnNode[],
  edges: SpawnEdge[] = [],
  /** `mountTimeout` — the WALL-CLOCK CAP on the "node mounted in the DOM" wait.
   *  It BOUNDS THE FAILURE; it is no longer the gate (see MOUNT_FRAME_BUDGET).
   *  Callers that already pass a bigger number keep exactly the cap they chose.
   *  `mountFrames` overrides the frame gate itself. */
  opts?: { mountTimeout?: number; mountFrames?: number }
): Promise<void> {
  const mountCapMs = opts?.mountTimeout ?? MOUNT_CAP_MS;
  const mountFrames = opts?.mountFrames ?? MOUNT_FRAME_BUDGET;
  const MAX_ATTEMPTS = 3;
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      // Bootstrap the engine directly via the dev __ensureEngine global. We
      // intentionally don't click "Load example" — its auto-playing Sequencer
      // races spawnPatch's clear-then-add and leaves stale DOM. The browser
      // launch flag --autoplay-policy=no-user-gesture-required (in
      // playwright.config.ts) lets AudioContext start without a user gesture,
      // so no click is needed.
      await page.waitForFunction(() => {
        const w = globalThis as unknown as { __ensureEngine?: () => Promise<unknown> };
        return typeof w.__ensureEngine === 'function';
      });
      await page.evaluate(async () => {
        const w = globalThis as unknown as { __ensureEngine: () => Promise<unknown> };
        await w.__ensureEngine();
      });

      // Clear + rebuild the patch in a single page.evaluate to avoid race conditions
      // with the auto-reconciler. We bypass the Clear button (which has been seen
      // to flake under Playwright when the topbar re-renders mid-click) and mutate
      // the patch graph directly via the dev-mode window globals.
      await page.evaluate(
        ({ nodes, edges }) => {
          const w = globalThis as unknown as {
            __patch: { nodes: Record<string, unknown>; edges: Record<string, unknown> };
            __ydoc: { transact: (fn: () => void) => void };
          };
          w.__ydoc.transact(() => {
            for (const id of Object.keys(w.__patch.edges)) delete w.__patch.edges[id];
            for (const id of Object.keys(w.__patch.nodes)) delete w.__patch.nodes[id];
            for (const n of nodes) {
              w.__patch.nodes[n.id] = {
                id: n.id,
                type: n.type,
                domain: (n as { domain?: string }).domain ?? 'audio',
                position: n.position ?? { x: 100, y: 100 },
                params: n.params ?? {},
              };
            }
            for (const e of edges) {
              w.__patch.edges[e.id] = {
                id: e.id,
                source: e.from,
                target: e.to,
                sourceType: e.sourceType ?? 'audio',
                targetType: e.targetType ?? 'audio',
              };
            }
          });
        },
        { nodes, edges }
      );

      // Wait for Svelte Flow to render the requested nodes. Assert by node ID
      // (SvelteFlow tags each wrapper with `data-id="<nodeId>"`) rather than a
      // TOTAL-count equality: a synced rackspace auto-spawns the singleton
      // TIMELORDE clock, and in the 2-context @collab flow that auto-spawn can
      // land AFTER spawnPatch's clear+rebuild transact (the provider-sync poll
      // in Canvas fires on its own cadence). Under the prebuilt `vite preview`
      // bundle the app boots fast enough that this race is deterministic, so a
      // strict `=== nodes.length` saw `doom + timelorde` (2 ≠ 1) and timed
      // out. Waiting for the exact requested IDs is both race-proof AND more
      // precise — it verifies the nodes we asked for actually mounted, instead
      // of trusting a count that an auto-spawned node can spuriously satisfy.
      await waitForMounted(page, nodes.map((n) => n.id), {
        frames: mountFrames,
        capMs: mountCapMs,
      });

      // The default viewport frames the far-down pinned lanes + video zone
      // (large flow-Y), so a card injected DIRECTLY at a small-Y free-canvas
      // position (real palette spawns anchor at the in-view click point; this
      // harness bypasses that) renders OFF-SCREEN and is un-clickable — every
      // right-click/patch-trigger on it times out. Mirror the palette's in-view
      // spawn by centering the viewport on the just-injected nodes.
      //
      // ⚠ UNCONDITIONAL, and that is the fix. This used to be gated on
      // `page.url().includes('mode=workflow')` — a URL SNIFF standing in for
      // "is this the shell?". Every rack is the shell now, and `?shell=legacy`
      // does not contain that substring, so the gate would have silently
      // stopped firing for the entire suite the moment the default flipped:
      // hundreds of specs timing out on an off-screen card with no signal
      // pointing here. `revealWorkflowNodes` already no-ops when the nodes are
      // framed and clickable, so the CHECK decides — not the URL.
      await revealWorkflowNodes(page, nodes.map((n) => n.id));
      return;
    } catch (err) {
      lastErr = err;
      if (!isTransientPageError(err) || attempt === MAX_ATTEMPTS) throw err;
      // HMR full-reload tore down the context. Wait for the new document to
      // be parsed (so __ensureEngine can re-bind via Canvas's $effect) before
      // retrying. networkidle is too strict here (HMR ws stays open).
      await page.waitForLoadState('domcontentloaded').catch(() => {});
    }
  }
  // Unreachable — the loop either returns or throws — but TypeScript can't
  // see that, and we want a useful message if it ever does fall through.
  throw lastErr ?? new Error('spawnPatch: exhausted retries with no error captured');
}

// ---------------- THE MAIN CANVAS, scoped away from the headless hosts -------

/**
 * The MAIN rack canvas's SvelteFlow — the one a player looks at.
 *
 * ⚠ `.svelte-flow__pane` AND `.svelte-flow__node` ARE AMBIGUOUS ON A WORKFLOW
 * RACK, AND THE AMBIGUITY GREW, WHICH IS WHY THIS EXISTS. `HeadlessSourceHost`
 * mounts each hosted module's REAL card inside its OWN single-node SvelteFlow —
 * parked at `left:-9999px`, `aria-hidden`, `pointer-events:none` — so every one
 * of them contributes a second `.svelte-flow__pane` and its own
 * `.svelte-flow__node[data-id=…]`. MEASURED on this tree: `/rack` has THREE
 * panes (the canvas + the timelorde and synesthesia hosts) and
 * `/rack?shell=legacy` has TWO; this selector resolves to exactly ONE in both.
 *
 * ⚠ THE HOSTS LIVE *INSIDE* `.flow`, so `.flow …` does NOT scope them out — and
 * that was the premise several specs were written on. The distinguishing fact is
 * the CHILD combinator: the canvas's own SvelteFlow is a DIRECT child of
 * `.flow`, while a host's is a grandchild through the `.headless-source-host`
 * wrapper. (Moving the host out of `.flow` would read better and is refused for
 * a measured reason: `.flow :global(.svelte-flow) { position: absolute; inset: 0 }`
 * is what gives a SvelteFlow its height, and its own comment records that
 * without it the flow "renders with zero height … and the canvas appears empty
 * even though nodes exist in the DOM".)
 *
 * ⚠ AND `.first()` IS NOT A SUBSTITUTE. It happens to pick the canvas today
 * because the DOM order puts it first, which is a coincidence of markup order
 * rather than a property of what is being addressed — the shape that "resolves
 * to an arbitrary one" is exactly what a strict-mode violation is protecting
 * against.
 */
export const MAIN_CANVAS = '.flow > .svelte-flow';

/** The main canvas's pane — the click/drag target for lasso, spawn and palette. */
export function canvasPane(page: Page) {
  return page.locator(`${MAIN_CANVAS} .svelte-flow__pane`);
}

/** One node AS THE MAIN CANVAS RENDERS IT — never a headless host's copy. */
export function canvasNode(page: Page, id: string) {
  return page.locator(`${MAIN_CANVAS} .svelte-flow__node[data-id="${id}"]`);
}

/**
 * Every LANE TILE's LOD tier attribute, **scoped to the main canvas**.
 *
 * ⚠ THIS EXISTS BECAUSE A BARE `document.querySelectorAll('[data-shell-tier]')`
 * STOPPED MEANING "THE LANE TILES", AND IT DID SO WITHOUT ANY SPEC CHANGING.
 * `[data-shell-tier]` is stamped by `ModuleShell`, and until 2026-08-24 a
 * `ModuleShell` only ever existed in a lane tile or in a dock full view that a
 * test had deliberately opened. Promoting `audioOut` broke that premise
 * PASSIVELY: one instance of it is PINNED, its only surface is the topbar 🎧
 * panel, and **that panel is always MOUNTED** — it stays in the DOM whether the
 * menu is open or shut, because `AudioinCard` owns the live input stream and
 * closing the menu must not kill the rack's audio input. So on the DEFAULT
 * shell a `<ModuleShell view="drawer" tier="dock">` is now in the DOM of every
 * page, at all times, and it is not a lane tile.
 *
 * MEASURED, four shards on one push, two distinct mechanisms:
 *   * `tiles.every(el => tier === t)` NEVER became true — the panel's tier is
 *     permanently `dock` while the lane walks its LOD ladder — so four copies of
 *     the same `setLaneTier`/`setZoomTier` helper hit their 10 s timeout
 *     (`workflow-shell`, `ringback-face`, `delay-face`, `vca-face`);
 *   * `measureTiles` counted the panel's faceplate as a tile and reported two
 *     distinct widths where the assertion wants one.
 *
 * ⚠ THE DUPLICATION IS THE REASON ONE PRODUCT CHANGE COST FOUR SHARDS. That
 * helper had been copy-pasted into four specs, so there was no single place to
 * fix. It has one now, for the same reason `canvasPane`/`canvasNode` above have
 * one: the discriminator is subtle (a CHILD combinator), and a subtle
 * discriminator re-derived per spec is a defect waiting for its next occupant.
 *
 * ⚠ AND `:not([data-shell-view="drawer"])` IS NOT THE FIX, though it would go
 * green today. It names the panel's *rendering mode* rather than *where the
 * thing is*, so it would also exclude a genuine drawer-tray tile a future spec
 * wants to measure, and it says nothing about the next surface that mounts a
 * shell outside the canvas. Scoping to the canvas states the actual subject.
 */
export const LANE_SHELL_TIER = `${MAIN_CANVAS} [data-shell-tier]`;

/**
 * EVERY LANE TILE — a migrated `module-shell` or an un-migrated
 * `module-shell-placeholder` — **scoped to the main canvas**, for the same
 * reason as `LANE_SHELL_TIER` above.
 *
 * ⚠ THE UNSCOPED FORM FAILS TWO DIFFERENT WAYS, and only one of them is loud.
 * A COUNT taken as a DELTA (`before` … `toHaveCount(before + 1)`) survives the
 * extra element, because the constant cancels — but the pinned singletons are
 * ensured ASYNCHRONOUSLY, so a `before` read before the 🎧 panel's faceplate
 * mounts is satisfied by that mount rather than by the drop under test, and the
 * geometry read that follows races a tile that is not there yet. A COUNT taken
 * as a FLOOR (`not.toHaveCount(0)`) simply stops being able to fail.
 */
export const LANE_TILES =
  `${MAIN_CANVAS} [data-testid="module-shell-placeholder"], ` +
  `${MAIN_CANVAS} [data-testid="module-shell"]`;

/**
 * Wait until every LANE tile reports LOD tier `tier`.
 *
 * Page-side by construction (one `waitForFunction`, not a Playwright poll loop),
 * and it reports what it SAW on timeout rather than only that it timed out —
 * the failure this replaces said nothing about which tile was holding out.
 */
export async function waitForLaneTier(
  page: Page,
  tier: string,
  timeout = 10_000,
): Promise<void> {
  await page.waitForFunction(
    ({ sel, t }) => {
      const tiles = Array.from(document.querySelectorAll(sel));
      if (tiles.length === 0) return false;
      const seen = tiles.map((el) => el.getAttribute('data-shell-tier'));
      const w = globalThis as unknown as { __laneTierSeen?: (string | null)[] };
      w.__laneTierSeen = seen; // readable from a failing test's trace
      return seen.every((s) => s === t);
    },
    { sel: LANE_SHELL_TIER, t: tier },
    { timeout },
  );
}

// ---------------- Module palette (right-click) helper ----------------

/**
 * Open the module-add palette by RIGHT-CLICKING an empty spot on the canvas
 * pane — the production entry point (the topbar "+ Add module" button was
 * removed by the 1024px topbar-overflow fix; `onPaneContextMenu` in
 * Canvas.svelte is the flow that remains, and it anchors the spawn at the
 * click point via `screenToFlowPosition`).
 *
 * Robustness:
 *  - Pass `position` (viewport/client coords) to right-click exactly there —
 *    the caller guarantees it's empty pane (spawn-anchor assertions need a
 *    known coordinate).
 *  - Otherwise the helper scans a coarse grid over the pane's bounding box
 *    and picks the first point whose topmost element is the pane itself —
 *    NOT a module card or cable. Right-clicking a node opens the node
 *    context menu instead of the palette, and palette-spawned modules land
 *    AT the click point, so a fixed coordinate would break on the second
 *    open in the same test.
 *  - The (right-click → palette visible) pair is retried via toPass so a
 *    pre-paint click on a cold renderer can't strand the test.
 *
 * Returns the client coords that were right-clicked (the spawn anchor).
 */
export async function openModulePalette(
  page: Page,
  opts: { position?: { x: number; y: number } } = {},
): Promise<{ x: number; y: number }> {
  const pane = canvasPane(page);
  await pane.waitFor({ state: 'visible', timeout: 10_000 });

  let point = opts.position ?? null;
  if (!point) {
    const box = await pane.boundingBox();
    if (!box) throw new Error('openModulePalette: pane has no bounding box');
    const scan = (b: { x: number; y: number; width: number; height: number }) => {
      // Inset from the pane edges so candidates clear the corner overlays
      // (zoom Controls bottom-left, feedback bug bottom-right).
      const inset = 56;
      for (let y = b.y + inset; y <= b.y + b.height - inset; y += 90) {
        for (let x = b.x + inset; x <= b.x + b.width - inset; x += 110) {
          const el = document.elementFromPoint(x, y);
          if (
            el &&
            el.closest('.svelte-flow__pane') &&
            !el.closest('.svelte-flow__node') &&
            !el.closest('.svelte-flow__edge')
          ) {
            return { x, y };
          }
        }
      }
      return null;
    };
    // A crowded canvas (cards spawn AT the click point, so repeated opens
    // fill the pane) can leave no empty candidate — zoom OUT (wheel over the
    // pane centre; SvelteFlow zoomOnScroll) so the cards shrink and empty
    // pane reappears, then rescan. Bounded so a genuinely broken canvas
    // still fails loudly.
    for (let attempt = 0; attempt < 4 && !point; attempt++) {
      if (attempt > 0) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.wheel(0, 400);
        await page.waitForTimeout(200); // d3-zoom transform settle
      }
      point = await page.evaluate(scan, box as { x: number; y: number; width: number; height: number });
    }
    if (!point) {
      throw new Error('openModulePalette: no empty pane spot found to right-click (after zoom-out rescans)');
    }
  }

  const palette = page.locator('.module-palette');
  const p = point;
  await expect(
    async () => {
      await page.mouse.click(p.x, p.y, { button: 'right' });
      await expect(palette).toBeVisible({ timeout: 3_000 });
    },
    `module palette should open on pane right-click at (${p.x}, ${p.y})`,
  ).toPass({ timeout: 15_000 });
  return point;
}

// ---------------- TOYBOX collapsible-section helpers ----------------
//
// TOYBOX's COMBINE GRAPH + CV/MOD sections default OPEN in the wide 3-column
// card. Specs that previously clicked the toggle to OPEN now must be idempotent
// (a blind click would CLOSE an already-open section). These ensure the section
// is open without depending on its current state.

/** Ensure a TOYBOX section is OPEN: only click the toggle when the section's
 *  content (`contentTestId`) isn't already visible. Safe to call whatever the
 *  default open-state is. */
export async function ensureToyboxSectionOpen(
  page: Page,
  toggleTestId: string,
  contentTestId: string,
): Promise<void> {
  const content = page.locator(`[data-testid="${contentTestId}"]`);
  if (await content.isVisible().catch(() => false)) return;
  // Cold SwiftShader (CI + local --use-angle=swiftshader) can take well over 5s
  // to FIRST-paint the toybox card. Several sections (the combine editor) are
  // open-by-default — clicking the toggle on a not-yet-rendered-but-open section
  // would CLOSE it, then the old 5s wait timed out on now-hidden content (the
  // systemic toybox setup flake). So give the content a generous window to appear
  // naturally first; only toggle if it is genuinely still collapsed after that.
  const appeared = await content
    .waitFor({ state: 'visible', timeout: 12_000 })
    .then(() => true)
    .catch(() => false);
  if (appeared) return;
  await page.locator(`[data-testid="${toggleTestId}"]`).click({ force: true, noWaitAfter: true });
  await content.waitFor({ state: 'visible', timeout: 15_000 });
}

/** Ensure the COMBINE GRAPH editor section is open (its SVG is visible). */
export async function ensureCombineOpen(page: Page): Promise<void> {
  await ensureToyboxSectionOpen(page, 'toybox-combine-toggle', 'toybox-graph-svg');
}

// (openToyboxNodeMenu / ensureCvOpen were pruned as unreferenced exports —
// LoC campaign row 16. The toybox specs that needed them roll their own or
// use ensureToyboxSectionOpen directly.)

// ---------------- Rackspace seed helper ----------------
//
// Spec tests that target `/r/[id]` need a real rackspace row in the database;
// the route's +page.server.ts loader 404s otherwise. Before this helper,
// every such spec was either skip-pending-Clerk-seed or had to mock the
// loader, which left whole integration paths uncovered (Codex coverage
// finding #8).
//
// `seedRackspace(page, envelope?)` calls the dev-only POST /api/test/seed-rackspace
// endpoint (gated server-side on RACKSPACE_SEED_ENABLED='1' OR NODE_ENV=development;
// see routes/api/test/seed-rackspace/+server.ts) and returns the URL ready
// for `page.goto`. The URL includes the HMAC-derived `?invite=<code>` query
// string so anon visitors flow through /r/[id]/+page.server.ts's
// unauthed-with-invite path — no Clerk session required.
//
// Optional `envelope` is a PatchEnvelope object (from
// packages/web/src/lib/graph/persistence.ts) whose `update` field is stored
// into rack_snapshots; the Hocuspocus relay serves it on first connect so
// the rack appears pre-populated. Omit for a fresh empty rack.
export interface SeedEnvelope {
  envelopeVersion: number;
  update: string;
}

export interface SeededRackspace {
  /** Bare rackspace id (e.g. `r_abc23xy7`). */
  id: string;
  /** HMAC-derived invite code for anon access. */
  inviteCode: string;
  /** Full path to navigate to: `/r/<id>?invite=<code>`. */
  url: string;
}

/**
 * Seed a fresh rackspace via the test-only API and return navigation info.
 *
 * The page argument is used as a convenient `request` carrier so the call
 * inherits Playwright's baseURL + any configured httpCredentials
 * (beta-gate basic auth on the autotest tier). Doesn't navigate the page.
 */
export async function seedRackspace(
  page: Page,
  envelope?: SeedEnvelope,
  opts?: { name?: string; ownerUserId?: string },
): Promise<SeededRackspace> {
  return seedRackspaceVia(page.request, envelope, opts);
}

/** Same as seedRackspace but accepts a raw APIRequestContext (e.g. from
 *  a non-Page test scope, like @collab specs that share one request ctx). */
export async function seedRackspaceVia(
  request: APIRequestContext,
  envelope?: SeedEnvelope,
  opts?: { name?: string; ownerUserId?: string },
): Promise<SeededRackspace> {
  const body: Record<string, unknown> = {};
  if (envelope !== undefined) body.envelope = envelope;
  if (opts?.name) body.name = opts.name;
  if (opts?.ownerUserId) body.ownerUserId = opts.ownerUserId;
  const resp = await request.post('/api/test/seed-rackspace', {
    data: body,
    // Always send a JSON content-type so SvelteKit's body parser picks the
    // right path even when body is `{}`.
    headers: { 'content-type': 'application/json' },
  });
  if (!resp.ok()) {
    const text = await resp.text().catch(() => '<no body>');
    throw new Error(`seedRackspace: ${resp.status()} ${text.slice(0, 200)}`);
  }
  const json = (await resp.json()) as { id?: unknown; inviteCode?: unknown };
  if (typeof json.id !== 'string' || typeof json.inviteCode !== 'string') {
    throw new Error(`seedRackspace: malformed response: ${JSON.stringify(json)}`);
  }
  return {
    id: json.id,
    inviteCode: json.inviteCode,
    url: `/r/${json.id}?invite=${json.inviteCode}`,
  };
}

/** Read a status-bar field value (e.g., readStatus(page, 'nodes') → '5'). */
export async function readStatus(page: Page, field: string): Promise<string> {
  const text = (await page.locator('.bottombar').textContent()) ?? '';
  const m = text.match(new RegExp(`${field}\\s*(\\S+)`));
  return m?.[1] ?? '';
}

/**
 * Take a STICKY, focus-independent keyboard claim on a DOOM card, then VERIFY
 * the runtime actually claims keys before any are dispatched.
 *
 * DETERMINISTIC CLAIM (the @collab marine-move de-flake — shared by all DOOM-MP
 * specs): we do NOT rely on a DOM click/`.focus()`. In a 2-context Playwright
 * test only ONE page holds focus/activeElement; the backgrounded page's
 * document.activeElement stays on <body>, so a focus-based capture leaves
 * shouldClaimKey()'s focus-within branch false, the dispatched keydown is
 * silently dropped, and the marine never moves. Instead we invoke the card's
 * `forceClaimKeyboard()` dev hook (the SAME latchKeyboard() the "Click to
 * capture keyboard" onclick fires) which flips kbLatched=true — honoured by
 * shouldClaimKey() REGARDLESS of focus/foreground — then POLL
 * getState().shouldClaimKey === true to confirm the claim landed before keys
 * are dispatched. Works identically on the foreground and the background page.
 * (Real users still click to capture; that path is unchanged.)
 */
export async function claimKeyboard(page: Page, id: string, timeout = 5000): Promise<void> {
  await page.evaluate(
    (nid) =>
      (
        globalThis as unknown as {
          __doomCards?: Record<string, { forceClaimKeyboard?: () => void }>;
        }
      ).__doomCards?.[nid]?.forceClaimKeyboard?.(),
    id,
  );
  // Poll until the runtime confirms the claim landed (focus-independent). On
  // failure we fall through: the dispatch still runs so the spec's own
  // assertion surfaces a clear signal rather than a silent no-op.
  await page
    .waitForFunction(
      (nid) =>
        (
          globalThis as unknown as {
            __doomCards?: Record<string, { getState: () => { shouldClaimKey: boolean } }>;
          }
        ).__doomCards?.[nid]?.getState().shouldClaimKey === true,
      id,
      { timeout },
    )
    .catch(() => {});
}

/** Seed a KRIA node (post-spawn) so track 1 fires: all-16 trigs, a C-major
 *  degree contour, running transport assumed set via params. The ONE idiom
 *  every spec uses since the deprecated sequencers were deleted (2026-08-24)
 *  — was per-file `data.steps` seeds against the old SEQUENCER shape. */
/** Build a plain KriaData object (track 1 armed, tracks 2-4 empty) for
 *  seeding via page.evaluate — JSON-serializable, so it can cross the
 *  boundary as an argument. `steps` are (scale-degree, octave) pairs against
 *  the major scale on root 48: degree 0 / octave 1 = MIDI 60 (C4); degree 2 /
 *  octave 1 = 64 (E4); degree 4 / octave 1 = 67 (G4); degree 0 / octave 2 =
 *  72 (C5). Loop length = steps.length, so the pattern cycles exactly the
 *  steps given. */
export function buildKriaData(
  steps: Array<{ note: number; octave: number; trig?: boolean }>,
  opts?: { timeDivision?: number; duration?: number; scale?: string },
): Record<string, unknown> {
  const len = Math.max(1, steps.length);
  const track = (arm: boolean) => ({
    trig: Array.from({ length: 16 }, (_, i) => arm && i < len && (steps[i]?.trig ?? true)),
    ratchet: Array.from({ length: 16 }, () => 1),
    note: Array.from({ length: 16 }, (_, i) => steps[i % len]?.note ?? 0),
    octave: Array.from({ length: 16 }, (_, i) => steps[i % len]?.octave ?? 0),
    duration: Array.from({ length: 16 }, () => opts?.duration ?? 0.5),
    probability: Array.from({ length: 16 }, () => 1),
    glide: Array.from({ length: 16 }, () => 0),
    loopStart: 0,
    loopLength: len,
    timeDivision: opts?.timeDivision ?? 1,
    direction: 'forward',
    muted: false,
  });
  return {
    patterns: { '0': { tracks: [track(true), track(false), track(false), track(false)], scale: opts?.scale ?? 'major', root: 48 } },
    active: 0,
    cued: null,
    cueSteps: 0,
  };
}

/** Write a built KriaData object onto a node inside one Y.Doc transaction. */
export async function seedKriaWith(page: Page, nodeId: string, data: Record<string, unknown>): Promise<void> {
  await page.evaluate(({ id, d }) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes[id];
      if (!n) return;
      if (!n.data) n.data = {};
      for (const [k, v] of Object.entries(d)) n.data[k] = v;
    });
  }, { id: nodeId, d: data });
}

/** buildKriaData from RAW MIDI notes (null = rest), on the CHROMATIC scale
 *  (root 48) so ANY midi is representable exactly: note = (m-48) % 12,
 *  octave = floor((m-48) / 12).
 *
 *  Timing note for specs converted off the deleted SEQUENCER: that module
 *  stepped QUARTER notes at its bpm, while kria's base grid is 16ths — so
 *  keeping the node's ORIGINAL bpm and passing `timeDivision: 4` reproduces
 *  the old step rate exactly (rate = bpm·4/(60·div)). */
export function buildKriaMidiData(
  midis: Array<number | null>,
  opts?: { timeDivision?: number; duration?: number },
): Record<string, unknown> {
  const steps = midis.map((m) => (
    m === null
      ? { note: 0, octave: 0, trig: false }
      : { note: ((m - 48) % 12 + 12) % 12, octave: Math.floor((m - 48) / 12), trig: true }
  ));
  return buildKriaData(steps, { ...opts, scale: 'chromatic' });
}


export async function seedKriaGate(page: Page, nodeId: string, opts?: { steps?: number; note?: number; octave?: number }): Promise<void> {
  const steps = opts?.steps ?? 16;
  const note = opts?.note ?? null;
  const octave = opts?.octave ?? null;
  await page.evaluate(({ id, steps, note, octave }) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes[id];
      if (!n) return;
      if (!n.data) n.data = {};
      const track = (trig: boolean) => ({
        trig: Array.from({ length: 16 }, (_, i) => trig && i < steps),
        ratchet: Array.from({ length: 16 }, () => 1),
        note: note === null ? [0, 2, 4, 7, 0, 2, 4, 7, 0, 2, 4, 7, 0, 2, 4, 7] : Array.from({ length: 16 }, () => note),
        octave: Array.from({ length: 16 }, () => octave ?? 0),
        duration: Array.from({ length: 16 }, () => 0.5),
        probability: Array.from({ length: 16 }, () => 1),
        glide: Array.from({ length: 16 }, () => 0),
        loopStart: 0,
        loopLength: steps,
        timeDivision: 1,
        direction: 'forward',
        muted: false,
      });
      Object.assign(n.data, {
        patterns: { '0': { tracks: [track(true), track(false), track(false), track(false)], scale: 'major', root: 48 } },
        active: 0,
        cued: null,
        cueSteps: 0,
      });
    });
  }, { id: nodeId, steps, note, octave });
}

/** A self-running POLY chord source: KRIA (clock, track-1 trigs via
 *  seedPolySource) → CARTESIAN (all 16 pads maj chords, clocked walk), whose
 *  `pitch` out is the polyPitchGate bus. Replaces the deleted POLYSEQZ
 *  (2026-08-24). Spawn POLY_SOURCE_NODES + POLY_SOURCE_EDGES, then call
 *  seedPolySource(page) post-spawn; wire `poly-cart`.pitch → your consumer. */
export const POLY_SOURCE_NODES: SpawnNode[] = [
  { id: 'poly-clk', type: 'kria', position: { x: 40, y: 40 }, domain: 'audio', params: { bpm: 240, running: 1 } },
  { id: 'poly-cart', type: 'cartesian', position: { x: 40, y: 220 }, domain: 'audio' },
];
export const POLY_SOURCE_EDGES: SpawnEdge[] = [
  {
    id: 'e-poly-clk',
    from: { nodeId: 'poly-clk', portId: 'gate1' },
    to: { nodeId: 'poly-cart', portId: 'clock' },
    sourceType: 'gate',
    targetType: 'gate',
  },
];
export async function seedPolySource(page: Page): Promise<void> {
  await seedKriaGate(page, 'poly-clk');
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['poly-cart'];
      if (!n) return;
      if (!n.data) n.data = {};
      n.data.cells = Array.from({ length: 16 }, (_, i) => (
        { on: true, midi: [60, 65, 67, 72][i % 4], chord: 'maj' }
      ));
    });
  });
}

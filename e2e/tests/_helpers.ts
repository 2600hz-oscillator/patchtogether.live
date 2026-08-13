// e2e/tests/_helpers.ts
//
// Shared test helpers for spawning arbitrary modules + edges via the dev-mode
// `__patch` and `__ydoc` window globals (Canvas.svelte exposes these in dev).

import { expect, type Page } from '@playwright/test';

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

      const pane =
        document.querySelector('.svelte-flow__pane') ?? document.querySelector('.svelte-flow');
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
// ⚠ NOT taken here, deliberately: `modules.spec.ts` still carries a private
// hand-typed `HEAVY_RENDER` set naming six modules. The slowest-to-mount
// module measured above was never on it, while `b3ntb0x` (4× faster) was; and
// no other registry-driven sweep can even read the list, which is why
// `per-module-per-port.spec.ts` auto-enrolled it on the bare default. That set
// is no longer load-bearing now the default is frame-gated, but it is still a
// fact about modules living in one spec's literal. Consolidating it is its own
// change.

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
  const pane = page.locator('.svelte-flow__pane');
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
// NOTE (2026-08-12, #1501): the `seedRackspace` helpers were REMOVED here along
// with the only three specs that used them (audio-gate, rack-restoring-status,
// unsaved-guard). Those specs never executed in any CI lane: the seed endpoint
// reaches the DB through `neon()` (packages/web/src/lib/server/db.ts), the HTTP
// driver, and every CI lane's DATABASE_URL is a raw localhost Postgres it cannot
// speak to. Restoring them needs a Neon-HTTP-capable backend in CI first —
// tracked separately as the `/r/[id]` coverage gap. The SERVER-side seeding
// logic keeps its unit coverage in packages/web/src/lib/server/rackspaces.test.ts.


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

// e2e/tests/_grand-helpers.ts
//
// Helpers for the GRAND-INTEGRATION heavy attest spec
// (grand-integration.attest.spec.ts). Kept in a SEPARATE file (NOT _helpers.ts)
// on purpose: _helpers.ts + playwright.config.ts sit in the @collab AND WebGL
// attest bases, so editing them would force an unrelated collab/webgl re-attest.
// This file is in NEITHER basis (it is not a *.spec.ts, carries no @collab/
// @capacity tag, and is not a standalone-listed helper), so it is hash-free.
//
// Provides:
//   - addToPatch     — ADDITIVE spawn: adds nodes/edges via __ydoc.transact
//                      WITHOUT clearing existing nodes, so workflow mode's pinned
//                      singletons (pinned-clipplayer/-mixmstrs/-timelorde/
//                      -audioOut) survive. (spawnPatch WIPES all non-pinned nodes
//                      then relies on the ensure-effect to re-spawn the pinned
//                      graph — a race we avoid here.)
//   - readMixLevels / readMixLevelsOverWindow — the master mixer's post-fader
//                      per-channel VU taps (read('levels') → number[6]); the
//                      max-hold window mirrors readScopePeakOverWindow so a
//                      percussive decay never dips a truly-sounding channel under
//                      the floor.
//   - readSynLevels  — synesthesia read('snapshot') → {levelsA, levelsB}.
//
// (Recorderbox is a VIDEO-domain module read via
// __engine().getDomain('video').read(nodeId, key); its `audioStream` /
// `audioCapture` values are a MediaStream / a {port} Promise that can't cross
// page.evaluate, so the spec reads them INSIDE the browser — see the spec's
// Step 10 — rather than through a generic helper here.)

import type { Page } from '@playwright/test';

export interface GrandNode {
  id: string;
  type: string;
  domain?: 'audio' | 'video' | 'meta';
  position?: { x: number; y: number };
  params?: Record<string, number>;
}

export interface GrandEdge {
  id: string;
  from: { nodeId: string; portId: string };
  to: { nodeId: string; portId: string };
  sourceType?: string;
  targetType?: string;
}

/**
 * Bootstrap the audio engine via the dev `__ensureEngine` global (the same seam
 * spawnPatch uses). `window.__engine()` returns null until this runs, so every
 * engine read (`read('levels')`, `currentStep:L`, `readParam`, …) needs it
 * first. Idempotent — safe to call more than once.
 */
export async function ensureEngine(page: Page, timeout = 15_000): Promise<void> {
  await page.waitForFunction(
    () => typeof (globalThis as unknown as { __ensureEngine?: () => Promise<unknown> }).__ensureEngine === 'function',
    undefined,
    { timeout },
  );
  await page.evaluate(async () => {
    await (globalThis as unknown as { __ensureEngine: () => Promise<unknown> }).__ensureEngine();
  });
}

/**
 * ADDITIVELY add nodes + edges to the live patch, preserving every existing node
 * (crucially the workflow `pinned-*` singletons). Writes the SAME node/edge
 * object shapes as spawnPatch (`__patch.nodes[id] = {id,type,domain,position,
 * params}`, `__patch.edges[id] = {id, source, target, sourceType, targetType}`),
 * then waits for each added node's DOM wrapper to mount AND each edge to
 * materialize in `__patch.edges` (hard state — never a bare toBeVisible).
 */
export async function addToPatch(
  page: Page,
  nodes: GrandNode[],
  edges: GrandEdge[] = [],
  opts: { mountTimeout?: number } = {},
): Promise<void> {
  const mountTimeout = opts.mountTimeout ?? 10_000;
  // Bootstrap the audio engine FIRST (the same __ensureEngine seam spawnPatch
  // uses) — `__engine()` returns null until it runs, so every engine read
  // (read('levels'), currentStep, …) would otherwise fail. Idempotent.
  await ensureEngine(page, mountTimeout);
  await page.evaluate(
    ({ nodes, edges }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, unknown>; edges: Record<string, unknown> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
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
    { nodes, edges },
  );

  // Hard-wait: every added node's DOM wrapper mounted …
  if (nodes.length) {
    await page.waitForFunction(
      (ids) => ids.every((id) => document.querySelector(`.svelte-flow__node[data-id="${id}"]`) !== null),
      nodes.map((n) => n.id),
      { timeout: mountTimeout },
    );
  }
  // … and every edge materialized in the graph.
  if (edges.length) {
    await page.waitForFunction(
      (ids) => {
        const w = globalThis as unknown as { __patch?: { edges: Record<string, unknown> } };
        return !!w.__patch && ids.every((id) => !!w.__patch!.edges[id]);
      },
      edges.map((e) => e.id),
      { timeout: mountTimeout },
    );
  }
}

interface EngineRead {
  __engine?: () => { read: (n: unknown, k: string) => unknown } | null;
  __patch: { nodes: Record<string, unknown> };
}

/** Read the master mixer's post-fader per-channel VU taps (number[6]). */
export async function readMixLevels(page: Page, nodeId: string): Promise<number[] | null> {
  return page.evaluate((id) => {
    const w = globalThis as unknown as EngineRead;
    const eng = w.__engine?.();
    const node = w.__patch.nodes[id];
    if (!eng || !node) return null;
    const lv = eng.read(node, 'levels') as number[] | undefined;
    return lv ? Array.from(lv) : null;
  }, nodeId);
}

/**
 * MAX-HOLD the mixer's per-channel levels over a bounded window — deterministic
 * in the way that matters: a truly-silent channel never crosses the floor, a
 * sounding one always does within the window. Mirrors readScopePeakOverWindow so
 * percussive decays don't false-fail a single frozen read.
 */
export async function readMixLevelsOverWindow(
  page: Page,
  nodeId: string,
  windowMs: number,
  pollMs = 40,
): Promise<number[]> {
  const deadline = Date.now() + windowMs;
  let held: number[] = [];
  while (Date.now() < deadline) {
    const lv = await readMixLevels(page, nodeId);
    if (lv) {
      if (held.length === 0) held = lv.slice();
      else for (let i = 0; i < lv.length; i++) held[i] = Math.max(held[i]!, lv[i]!);
    }
    await page.waitForTimeout(pollMs);
  }
  return held;
}

/**
 * Move a canvas node so its top-left renders at a known-visible SCREEN point.
 * Additively-added nodes land at arbitrary flow coords the mount-time fitView
 * never re-fit, so a node can sit OUTSIDE the viewport — and Playwright can't
 * scroll a CSS-transformed flow node into view. This pins it on-screen (above
 * any bottom drawer) so its right-click menu + knobs are actionable.
 *
 * We first write the node's flow position under the requested screen point, then
 * PAN THE VIEWPORT so the node's ACTUAL post-write flow position maps to that
 * screen anchor. The pan step matters because workflow-mode lane geometry CLAMPS
 * a manual position write (a free canvas module can't be dropped below the
 * video-zone baseline — the position setter caps its Y), so the raw write alone
 * can leave the node parked off-screen. Panning to wherever the node is actually
 * allowed to sit reproduces the intended on-screen layout regardless of the clamp.
 */
export async function bringNodeOnScreen(page: Page, nodeId: string, screen: { x: number; y: number }): Promise<void> {
  const flowPos = await page.evaluate(
    (p) =>
      (
        globalThis as unknown as {
          __flow: { screenToFlowPosition: (q: { x: number; y: number }) => { x: number; y: number } };
        }
      ).__flow.screenToFlowPosition(p),
    screen,
  );
  await page.evaluate(
    ({ id, pos }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { position?: { x: number; y: number } }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes[id];
        if (n) n.position = { x: pos.x, y: pos.y };
      });
    },
    { id: nodeId, pos: flowPos },
  );
  // Pan the viewport so the node's actual (possibly clamped) flow position lands
  // at the requested screen anchor: screenTL = flowPos * zoom + viewport ⇒
  // viewport = anchor − flowPos * zoom.
  await page.evaluate(
    ({ id, anchor }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { position?: { x: number; y: number } }> };
        __flow: {
          getViewport: () => { x: number; y: number; zoom: number };
          setViewport: (vp: { x: number; y: number; zoom: number }) => void;
        };
      };
      const n = w.__patch?.nodes?.[id];
      if (!n?.position) return;
      const zoom = w.__flow.getViewport().zoom || 1;
      w.__flow.setViewport({ x: anchor.x - n.position.x * zoom, y: anchor.y - n.position.y * zoom, zoom });
    },
    { id: nodeId, anchor: screen },
  );
  await page.waitForFunction(
    (id) => {
      const el = document.querySelector(`.svelte-flow__node[data-id="${id}"]`);
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth && r.width > 0;
    },
    nodeId,
    { timeout: 8_000 },
  );
}

/** Read synesthesia read('snapshot') → {levelsA, levelsB}. */
export async function readSynLevels(
  page: Page,
  nodeId: string,
): Promise<{ levelsA: number[]; levelsB: number[] } | null> {
  return page.evaluate((id) => {
    const w = globalThis as unknown as EngineRead;
    const eng = w.__engine?.();
    const node = w.__patch.nodes[id];
    if (!eng || !node) return null;
    const snap = eng.read(node, 'snapshot') as { levelsA: number[]; levelsB: number[] } | undefined;
    if (!snap) return null;
    return { levelsA: Array.from(snap.levelsA), levelsB: Array.from(snap.levelsB) };
  }, nodeId);
}

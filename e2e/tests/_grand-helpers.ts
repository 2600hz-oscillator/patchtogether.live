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

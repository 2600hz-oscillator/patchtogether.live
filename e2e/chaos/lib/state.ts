// State snapshot read from the running browser. Returned shape is the
// minimum the runner + invariants need; we deliberately don't dump every
// AudioParam value or the entire patch.

import type { Page } from '@playwright/test';

export interface NodeSnapshot {
  id: string;
  type: string;
  params: Record<string, number>;
}

export interface EdgeSnapshot {
  id: string;
  source: { nodeId: string; portId: string };
  target: { nodeId: string; portId: string };
  sourceType: string;
  targetType: string;
}

export interface PatchSnapshot {
  nodes: NodeSnapshot[];
  edges: EdgeSnapshot[];
}

export interface EngineSnapshot {
  /** AudioContext.state — 'running' | 'suspended' | 'closed'. */
  ctxState: string;
  /** Sample rate. */
  sampleRate: number;
  /** Engine's current node count (NOT patch.nodes.length — that's separately
   *  in PatchSnapshot.nodes). Differing values across two adjacent reads is
   *  expected (reconciler is async); persistent divergence is a bug. */
  engineNodeCount: number;
  /** Same for edges. */
  engineEdgeCount: number;
}

export async function readPatch(page: Page): Promise<PatchSnapshot> {
  return await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: {
        nodes: Record<string, { id: string; type: string; params?: Record<string, number> }>;
        edges: Record<string, {
          id: string;
          source: { nodeId: string; portId: string };
          target: { nodeId: string; portId: string };
          sourceType: string;
          targetType: string;
        }>;
      };
    };
    return {
      nodes: Object.values(w.__patch.nodes).map((n) => ({
        id: n.id,
        type: n.type,
        params: { ...(n.params ?? {}) },
      })),
      edges: Object.values(w.__patch.edges).map((e) => ({
        id: e.id,
        source: { ...e.source },
        target: { ...e.target },
        sourceType: e.sourceType,
        targetType: e.targetType,
      })),
    };
  });
}

export async function readEngine(page: Page): Promise<EngineSnapshot> {
  return await page.evaluate(() => {
    const w = globalThis as unknown as {
      __engine?: () => null | {
        ctx?: AudioContext;
        getDomain?: (d: string) => { nodes: Map<string, unknown>; edges: Map<string, unknown> } | undefined;
      };
    };
    const eng = w.__engine?.();
    if (!eng) {
      return { ctxState: 'unknown', sampleRate: 0, engineNodeCount: 0, engineEdgeCount: 0 };
    }
    // The PatchEngine itself doesn't expose ctx directly; we fetch via
    // the audio domain's first node OR a separate global. Fall back to a
    // best-effort lookup via `__engineCtx` if present.
    const w2 = globalThis as unknown as { __engineCtx?: AudioContext };
    const ctx = w2.__engineCtx ?? eng.ctx;
    const audio = eng.getDomain?.('audio');
    return {
      ctxState: ctx?.state ?? 'unknown',
      sampleRate: ctx?.sampleRate ?? 0,
      engineNodeCount: audio?.nodes.size ?? 0,
      engineEdgeCount: audio?.edges.size ?? 0,
    };
  });
}

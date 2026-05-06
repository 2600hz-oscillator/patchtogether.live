// Stage-1 invariants. Single-user only.
//
// Each invariant is a pure function over the PatchSnapshot + EngineSnapshot +
// recent console log buffer. Returns null on pass, or a Violation describing
// what was wrong. The runner halts on the first violation and dumps an
// artifact bundle.
//
// Stage-1 set is deliberately small (the plan calls for 6-11; we ship 6
// here; the rest land as later iterations once these prove stable). A core
// design rule: no false positives. An invariant that flakes erodes trust
// in the whole runner.

import type { Catalog } from './catalog';
import type { PatchSnapshot, EngineSnapshot } from './state';

export interface ConsoleEvent {
  type: 'log' | 'info' | 'warning' | 'error' | 'pageerror';
  text: string;
  at: number;
}

export interface InvariantContext {
  patch: PatchSnapshot;
  engine: EngineSnapshot;
  /** Console events captured since the last check (newest last). */
  consoleEvents: ConsoleEvent[];
  /** Catalog of legal modules (used by edge-validity invariant). */
  catalog: Catalog;
}

export interface Violation {
  invariantId: string;
  message: string;
}

const ALLOWED_CONSOLE_PATTERNS: RegExp[] = [
  // SvelteKit / Svelte dev warnings (vite plugin) — present even on green
  // runs. Filtering keeps the invariant signal-only.
  /\[vite-plugin-svelte\]/,
  /\[Faust\]/,
  /DeprecationWarning/,
  // Clerk's no-Clerk-on-/ warning — only fires if someone tweaks layout.
  /clerk/i,
];

function isBenignConsoleMessage(text: string): boolean {
  return ALLOWED_CONSOLE_PATTERNS.some((re) => re.test(text));
}

export function checkInvariants(ctx: InvariantContext): Violation | null {
  // 1. AudioContext stays running.
  if (ctx.engine.ctxState !== 'running' && ctx.engine.ctxState !== 'unknown') {
    // 'unknown' is what readEngine returns when there's no engine yet (very
    // start of run). Real failures look like 'suspended' or 'closed' that
    // PERSIST across multiple checks; a brief 'suspended' during boot is OK.
    return {
      invariantId: 'audio-context-running',
      message: `AudioContext.state="${ctx.engine.ctxState}"; expected "running"`,
    };
  }

  // 2. No console errors (filtered through allowlist).
  const errs = ctx.consoleEvents.filter(
    (e) => (e.type === 'error' || e.type === 'pageerror') && !isBenignConsoleMessage(e.text),
  );
  if (errs.length > 0) {
    return {
      invariantId: 'no-console-errors',
      message: `${errs.length} console errors:\n  ${errs.slice(0, 3).map((e) => e.text.slice(0, 200)).join('\n  ')}`,
    };
  }

  // 3. No edges-to-nowhere — both endpoint nodes exist in patch.
  const nodeIds = new Set(ctx.patch.nodes.map((n) => n.id));
  for (const e of ctx.patch.edges) {
    if (!nodeIds.has(e.source.nodeId)) {
      return {
        invariantId: 'no-edges-to-nowhere',
        message: `edge ${e.id} references nonexistent source node ${e.source.nodeId}`,
      };
    }
    if (!nodeIds.has(e.target.nodeId)) {
      return {
        invariantId: 'no-edges-to-nowhere',
        message: `edge ${e.id} references nonexistent target node ${e.target.nodeId}`,
      };
    }
  }

  // 4. Every edge endpoint targets a port that exists on its module.
  for (const e of ctx.patch.edges) {
    const srcNode = ctx.patch.nodes.find((n) => n.id === e.source.nodeId);
    const tgtNode = ctx.patch.nodes.find((n) => n.id === e.target.nodeId);
    if (!srcNode || !tgtNode) continue; // covered by invariant 3
    const srcDef = ctx.catalog.find((m) => m.type === srcNode.type);
    const tgtDef = ctx.catalog.find((m) => m.type === tgtNode.type);
    if (!srcDef || !tgtDef) continue; // out-of-catalog (e.g., audioOut) — skip
    if (!srcDef.outputs.some((p) => p.id === e.source.portId)) {
      return {
        invariantId: 'edge-port-exists',
        message: `edge ${e.id} source port "${e.source.portId}" not on module ${srcNode.type}`,
      };
    }
    if (!tgtDef.inputs.some((p) => p.id === e.target.portId)) {
      return {
        invariantId: 'edge-port-exists',
        message: `edge ${e.id} target port "${e.target.portId}" not on module ${tgtNode.type}`,
      };
    }
  }

  // 5. Patch ↔ engine node count agreement (within a small grace, since the
  //    reconciler is async). Persistent divergence is the bug shape.
  const patchNodeCount = ctx.patch.nodes.length;
  if (Math.abs(patchNodeCount - ctx.engine.engineNodeCount) > 2) {
    return {
      invariantId: 'patch-engine-node-count',
      message: `patch has ${patchNodeCount} nodes; engine has ${ctx.engine.engineNodeCount} (delta > 2)`,
    };
  }

  // 6. Patch ↔ engine edge count agreement.
  const patchEdgeCount = ctx.patch.edges.length;
  if (Math.abs(patchEdgeCount - ctx.engine.engineEdgeCount) > 2) {
    return {
      invariantId: 'patch-engine-edge-count',
      message: `patch has ${patchEdgeCount} edges; engine has ${ctx.engine.engineEdgeCount} (delta > 2)`,
    };
  }

  return null;
}

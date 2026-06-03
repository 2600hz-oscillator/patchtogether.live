// packages/web/src/lib/video/modules/index.ts
//
// Auto-registers EVERY video module on first import — GLOB-DRIVEN. Mirrors
// packages/web/src/lib/audio/modules/index.ts.
//
// Adding a video module no longer requires editing this file: drop a new
// `packages/web/src/lib/video/modules/<name>.ts` exporting a
// `<name>Def: VideoModuleDef` and it is picked up automatically via Vite's
// `import.meta.glob`. This removes the per-module append-edit that used to
// collide across concurrent module PRs.

import { registerVideoModule, type VideoModuleDef } from '$lib/video/module-registry';
import { exposeModuleSpecsForTests } from '$lib/dev/module-specs';

// Eagerly import every sibling module file. Vite inlines this at build time
// and resolves the worklet / shader `?url` imports the def files do. The `!`
// patterns exclude `*.test.ts` (whose top-level describe()/it() must not be
// re-registered via this side-effect import) and the index barrel itself.
const MODULE_MODULES = import.meta.glob<Record<string, unknown>>(
  ['./*.ts', '!./*.test.ts', '!./index.ts'],
  { eager: true },
);

/** Does this exported value look like a video module def? Requires a string
 *  `type`, domain 'video', and a `factory` function (the shape `registerVideoModule`
 *  consumes). Helper exports that lack those are ignored. */
function looksLikeVideoDef(v: unknown): v is VideoModuleDef {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (typeof o.type !== 'string') return false;
  if (o.domain !== 'video') return false;
  return typeof o.factory === 'function';
}

/** Collect every video def, deduped by type, sorted by type id for a
 *  deterministic registration order. */
export function collectVideoDefs(): VideoModuleDef[] {
  const byType = new Map<string, VideoModuleDef>();
  for (const mod of Object.values(MODULE_MODULES)) {
    for (const [exportName, value] of Object.entries(mod)) {
      if (!exportName.endsWith('Def')) continue;
      if (!looksLikeVideoDef(value)) continue;
      if (!byType.has(value.type)) byType.set(value.type, value);
    }
  }
  return [...byType.values()].sort((a, b) => a.type.localeCompare(b.type));
}

let registered = false;

export function registerVideoModules(): void {
  if (registered) return;
  registered = true;
  for (const def of collectVideoDefs()) {
    registerVideoModule(def);
  }
  // Re-expose module specs so the (audio + video) combined snapshot lands on
  // window.__moduleSpecs. The audio barrel already calls this after
  // registering its own defs; we redo it here so the e2e io-spec-consistency
  // suite (which iterates over the published specs) sees the video defs too.
  exposeModuleSpecsForTests();
}

registerVideoModules();

// packages/web/src/lib/audio/modules/index.ts
//
// Auto-registers EVERY audio module on first import — GLOB-DRIVEN.
//
// Adding a module no longer requires editing this file. Drop a new
// `packages/web/src/lib/audio/modules/<name>.ts` that `export`s a
// `<name>Def: AudioModuleDef` and it is picked up automatically here via
// Vite's `import.meta.glob`. This eliminates the per-module append-edit that
// used to collide across concurrent module PRs (the "conflict tax").
//
// What counts as a module def: any EXPORTED const whose name ends in `Def`
// and whose value is an object carrying a `type` + a `factory` (or, for the
// synced LFO base, a `computeStateAt`). Helper files that export non-def
// symbols (shape math, draw helpers, *-engine mirrors, etc.) are ignored
// because they don't match that shape. See `looksLikeAudioDef` below.

import { registerModule, type AnyModuleDef } from '$lib/audio/module-registry';
import { testHooksEnabled } from '$lib/dev/test-hooks';
import { exposeModuleSpecsForTests } from '$lib/dev/module-specs';
// RIOTGIRLS exports a per-instance trigger helper alongside its def. The def
// itself is picked up by the glob below; this named helper is wired onto
// `window` for Playwright. riotgirls.ts is already eagerly imported by the
// glob, so this static import adds no extra bundle cost.
import { triggerVoice as riotgirlsTriggerVoice } from './riotgirls';

// Eagerly import every sibling module file. Vite inlines this at build time
// (and resolves the worklet `?url` imports the def files do). The `!` patterns
// EXCLUDE non-def siblings whose mere import side-effect would be wrong to
// run here: `*.test.ts` (their top-level describe()/it() would register an
// extra time, doubling + polluting shared-singleton test state) and the
// index barrel itself (would recurse). Helper files that DON'T export a def
// (shape math, draw helpers, *-engine mirrors) are still imported but
// harmlessly skipped by `looksLikeAudioDef` — importing them costs nothing
// since the real module files import them anyway.
const MODULE_MODULES = import.meta.glob<Record<string, unknown>>(
  ['./*.ts', '!./*.test.ts', '!./index.ts'],
  { eager: true },
);

/**
 * Heuristic: does this exported value look like an audio module def?
 *
 * The registry's `registerModule` only needs `type` + the def shape; the
 * factory is what distinguishes a real module def from the various helper
 * objects that also end in some `*Def`-ish name. We require a string `type`
 * and EITHER a `factory` function (the common case) OR a `computeStateAt`
 * function (SyncedModuleDef, e.g. lfo's base) so the synced arm is covered.
 */
function looksLikeAudioDef(v: unknown): v is AnyModuleDef {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (typeof o.type !== 'string') return false;
  if (o.domain !== 'audio') return false;
  return typeof o.factory === 'function';
}

/**
 * Collect every audio def exported anywhere under ./*.ts, deduped by `type`,
 * sorted by type id for a deterministic registration order (so console
 * warnings / iteration order are stable across runs + machines).
 */
export function collectAudioDefs(): AnyModuleDef[] {
  const byType = new Map<string, AnyModuleDef>();
  for (const mod of Object.values(MODULE_MODULES)) {
    for (const [exportName, value] of Object.entries(mod)) {
      if (!exportName.endsWith('Def')) continue;
      if (!looksLikeAudioDef(value)) continue;
      if (!byType.has(value.type)) byType.set(value.type, value);
    }
  }
  return [...byType.values()].sort((a, b) => a.type.localeCompare(b.type));
}

let registered = false;

export function registerAudioModules(): void {
  if (registered) return;
  registered = true;

  for (const def of collectAudioDefs()) {
    registerModule(def);
  }

  if (testHooksEnabled() && typeof window !== 'undefined') {
    // Per-instance trigger so Playwright can drive a specific RIOTGIRLS by
    // node id without spawning a Sequencer. Returns true if the voice was
    // triggered, false if no instance / voice found.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__riotgirlsTriggerVoice = (nodeId: string, voiceIdx: number) =>
      riotgirlsTriggerVoice(nodeId, voiceIdx);
  }
  exposeModuleSpecsForTests();
}

registerAudioModules();

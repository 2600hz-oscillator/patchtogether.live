// packages/web/src/lib/audio/engine-context.ts
//
// Module cards need access to the live PatchEngine so faders can read
// AudioParam values at frame rate (motorized fader convention). We pass the
// engine down via Svelte context as a getter, so even if the engine is
// re-created (e.g., AudioContext reset), card components see the current one.

import { getContext, setContext } from 'svelte';
import type { PatchEngine } from './engine';

export interface EngineContext {
  /** Returns the current PatchEngine, or null if not yet booted. */
  get(): PatchEngine | null;
}

const KEY = Symbol('engine-context');

export function provideEngineContext(getter: () => PatchEngine | null): void {
  setContext<EngineContext>(KEY, { get: getter });
}

export function useEngine(): EngineContext {
  const ctx = getContext<EngineContext | undefined>(KEY);
  if (!ctx) {
    return { get: () => null };
  }
  return ctx;
}

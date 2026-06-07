// packages/web/src/lib/audio/engine-ref.ts
//
// A tiny process-wide accessor for the live PatchEngine, for code that runs
// OUTSIDE the Svelte context tree where provideEngineContext / useEngine apply
// (e.g. a rackspace-bar button that is a sibling of Canvas, not a descendant).
//
// Canvas owns the engine lifecycle and registers it here; consumers read it via
// getActiveEngine(). This is deliberately NOT reactive — callers poll it at the
// moment of use (a button click, a feedback-pump tick), which is exactly when a
// non-null engine is required. Mirrors the existing engine-context contract but
// without the Svelte setContext/getContext coupling.

import type { PatchEngine } from '$lib/audio/engine';

let activeEngine: PatchEngine | null = null;

/** Canvas calls this whenever the engine is created / torn down. */
export function setActiveEngine(engine: PatchEngine | null): void {
  activeEngine = engine;
}

/** Read the live engine (null before AudioGate boots it). */
export function getActiveEngine(): PatchEngine | null {
  return activeEngine;
}

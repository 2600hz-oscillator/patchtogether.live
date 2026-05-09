// packages/web/src/lib/multiplayer/provider-context.ts
//
// Module cards may need access to the live HocuspocusProvider — for
// example, to write per-module presence into Y.Awareness (CAMERA card
// publishes its active node ids so rack-mates know "user X has CAMERA up
// here" without seeing the actual stream — see camera-presence.ts).
//
// Provided via Svelte context as a getter so descendants always see the
// current provider, even if it's swapped or attached late. On the public
// /' canvas (single-user), the getter returns null and presence helpers
// no-op gracefully.

import { getContext, setContext } from 'svelte';
import type { HocuspocusProvider } from '@hocuspocus/provider';

export interface ProviderContext {
  /** Returns the current HocuspocusProvider, or null if single-user. */
  get(): HocuspocusProvider | null;
}

const KEY = Symbol('multiplayer-provider-context');

export function provideProviderContext(
  getter: () => HocuspocusProvider | null,
): void {
  setContext<ProviderContext>(KEY, { get: getter });
}

export function useProvider(): ProviderContext {
  const ctx = getContext<ProviderContext | undefined>(KEY);
  if (!ctx) {
    return { get: () => null };
  }
  return ctx;
}

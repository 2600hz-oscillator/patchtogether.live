// Multiplayer provider — Stage B PR B.
//
// Attaches a HocuspocusProvider to an existing Yjs doc so updates flow
// across all participants in the same rackspace. The doc itself is the
// per-route Yjs doc from `createPatch()` (graph/store.ts), reused as-is —
// SyncedStore's proxy doesn't care that the underlying doc is now
// network-replicated.
//
// Stage B PR B scope: provider attach only. No layout split (positions
// are still in `node.position`, so dragging on one client moves on the
// other — that's PR B-b's fix). No reconciler tiebreak (PR D), no
// awareness (PR E).
//
// Connection lifecycle: caller (`/r/[id]/+page.svelte`) instantiates on
// mount, calls `provider.destroy()` on unmount.

import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';

export interface AttachProviderOptions {
  /** Rackspace id (used as Hocuspocus doc name). */
  rackspaceId: string;
  /** Existing Yjs doc to attach the provider to. */
  ydoc: Y.Doc;
  /** Auth token sent in the Hocuspocus auth handshake. Currently the
   *  server stub-accepts any value; PR C wires real Clerk verification. */
  token?: string;
  /** Optional WS URL override; defaults to env-configured. */
  url?: string;
  /** Optional: log connection state changes to console for debugging. */
  debug?: boolean;
  /** Called once when the server rejects the connection because the
   *  rackspace is at capacity (4/4). The page should route to /full. */
  onCapacityRejected?: () => void;
}

// Server-side wire-format string for capacity rejection. Mirrors
// CAPACITY_REJECTION.code in packages/server/src/capacity.ts; kept as a
// duplicated literal so the client doesn't depend on the server package.
export const CAPACITY_REJECTION_CODE = 'rackspace-full';

const DEFAULT_WS_URL = (() => {
  // SvelteKit exposes Vite env to client code via import.meta.env. The
  // VITE_SERVER_WS_URL var is read at build time. In dev the default
  // points at the local Hocuspocus server; in prod it points at the
  // deployed Fly.io instance. Port 1235 (not Hocuspocus's documented
  // 1234) to avoid colliding with BitwigStudio + other DAWs that reserve
  // 1234 for OSC.
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  return env?.VITE_SERVER_WS_URL ?? 'ws://localhost:1235';
})();

export function attachProvider(opts: AttachProviderOptions): HocuspocusProvider {
  const provider = new HocuspocusProvider({
    url: opts.url ?? DEFAULT_WS_URL,
    name: opts.rackspaceId,
    document: opts.ydoc,
    token: opts.token,
  });

  if (opts.debug) {
    provider.on('status', (e: { status: string }) => {
      // eslint-disable-next-line no-console
      console.log(`[hocuspocus] status: ${e.status}`);
    });
    provider.on('synced', () => {
      // eslint-disable-next-line no-console
      console.log(`[hocuspocus] synced`);
    });
  }

  // Server emits the rejection reason as a string-prefixed message. The
  // .startsWith check matches CAPACITY_REJECTION_CODE without forcing
  // the server to format JSON over the auth-handshake error channel.
  provider.on('authenticationFailed', (e: { reason: string }) => {
    if (e.reason?.startsWith(CAPACITY_REJECTION_CODE)) {
      // Tear down the provider so it doesn't keep retrying — Hocuspocus
      // re-attempts auth on a backoff schedule by default.
      try {
        provider.destroy();
      } catch {
        /* destroy is idempotent in practice */
      }
      opts.onCapacityRejected?.();
    }
  });

  return provider;
}

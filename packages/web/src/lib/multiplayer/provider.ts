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
  /** Auth token sent in the Hocuspocus auth handshake. Either a string
   *  or a callback that returns one (sync or async) — Hocuspocus calls
   *  it on every (re)connect, so passing Clerk's getToken() means the
   *  JWT is always fresh. PR-D format: `clerk:<jwt>` or `anon:<code>`. */
  token?: string | (() => string | Promise<string>);
  /** Optional WS URL override; defaults to env-configured. */
  url?: string;
  /** Optional: log connection state changes to console for debugging. */
  debug?: boolean;
  /** Called once when the server rejects the connection because the
   *  rackspace is at capacity (4/4). The page should route to /full. */
  onCapacityRejected?: () => void;
  /** Called once when the server rejects the connection because the
   *  auth token is missing/invalid/expired (PR-D). Signals the user
   *  needs to sign in again or the invite link is bad. */
  onAuthRejected?: (reason: string) => void;
}

// Server-side wire-format strings for handshake rejections. Mirror the
// values in packages/server/src/{capacity,auth}.ts; kept as duplicated
// literals so the client doesn't depend on the server package.
export const CAPACITY_REJECTION_CODE = 'rackspace-full';
export const AUTH_REJECTION_CODES = ['unauthorized', 'invalid-format'] as const;

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
    // Hocuspocus's typing splits sync vs async callbacks into a union of
    // function types — we accept the more permissive single-callback
    // shape and let the runtime handle either return shape.
    token: opts.token as string | (() => Promise<string>) | undefined,
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

  // Server emits the rejection reason as the .reason field of the
  // PermissionDenied wire message. We match by exact code rather than
  // .startsWith so future codes don't collide.
  provider.on('authenticationFailed', (e: { reason: string }) => {
    const reason = e.reason ?? '';
    const isCapacity = reason === CAPACITY_REJECTION_CODE;
    const isAuth = (AUTH_REJECTION_CODES as readonly string[]).includes(reason);
    if (!isCapacity && !isAuth) return;
    // Tear down the provider so it doesn't keep retrying — Hocuspocus
    // re-attempts auth on a backoff schedule by default.
    try {
      provider.destroy();
    } catch {
      /* destroy is idempotent in practice */
    }
    if (isCapacity) opts.onCapacityRejected?.();
    else opts.onAuthRejected?.(reason);
  });

  return provider;
}

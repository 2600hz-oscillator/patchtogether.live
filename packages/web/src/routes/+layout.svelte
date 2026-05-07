<script lang="ts">
  import '@xyflow/svelte/dist/style.css';
  import './global.css';
  import '$lib/ui/modules/_module-card.css';
  import { ClerkProvider } from 'svelte-clerk';
  import { page } from '$app/state';
  import { ydoc } from '$lib/graph/store';
  import { attachProvider } from '$lib/multiplayer/provider';
  import { testHooksEnabled } from '$lib/dev/test-hooks';

  let { data, children } = $props();

  // Stage B PR B-b: expose attachProvider as a dev global so Playwright
  // @collab + @capacity + @auth tests can wire browser contexts to the
  // same Hocuspocus doc without going through Clerk auth on /r/[id].
  // Server validates tokens (PR-D) — tests derive a valid `anon:<code>`
  // via the same dev-only HMAC secret used by lib/server/invites.ts and
  // packages/server/src/auth.ts. Tests can also pass an explicit `token`
  // to drive the rejection paths (e.g. `'clerk:invalid'`).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let _activeProviderRef: any = null;
  // Test hooks: VITE_E2E_HOOKS=1 in the autotest+dev deploy steps re-exposes
  // these on those tiers. The dev-secret token-derivation path inside still
  // only works under DEV (the hardcoded fallback secret is only a match
  // against local Hocuspocus). On autotest/dev tiers, callers must pass an
  // explicit token — fetch a real invite via /api/rackspaces and pass it as
  // `anon:<code>`.
  if (testHooksEnabled() && typeof window !== 'undefined') {
    // MUST stay in lockstep with the dev fallback in invites.ts and
    // auth.ts. If you change one, change all three.
    const DEV_INVITE_SECRET = 'dev-only-invite-secret-change-me-x'.padEnd(32, '_');
    const deriveAnonToken = async (docName: string): Promise<string> => {
      const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(DEV_INVITE_SECRET),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(docName));
      let hex = '';
      for (const b of new Uint8Array(sig)) hex += b.toString(16).padStart(2, '0');
      return `anon:${hex.slice(0, 16)}`;
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__attachProvider = async (rackspaceId: string, token?: string) => {
      const effectiveToken = token ?? (await deriveAnonToken(rackspaceId));
      let onCapacityRejected: () => void = () => {};
      let onAuthRejected: (r: string) => void = () => {};
      const provider = attachProvider({
        rackspaceId,
        ydoc,
        token: effectiveToken,
        debug: true,
        onCapacityRejected: () => onCapacityRejected(),
        onAuthRejected: (reason) => onAuthRejected(reason),
      });
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`provider sync timeout for ${rackspaceId}`)),
          5000,
        );
        onCapacityRejected = () => {
          clearTimeout(timeout);
          reject(new Error('rackspace-full'));
        };
        onAuthRejected = (reason) => {
          clearTimeout(timeout);
          reject(new Error(reason || 'unauthorized'));
        };
        provider.on('synced', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      _activeProviderRef = provider;
      return provider;
    };

    // Stage B PR B-c: small awareness helpers so @collab tests can publish
    // a presence identity + cursor without needing to plumb the provider
    // reference back through Playwright's evaluate() (HocuspocusProvider
    // doesn't survive structured-clone serialization).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__setAwarenessUser = (user: { id: string; displayName: string; color: string }) => {
      const a = _activeProviderRef?.awareness;
      if (!a) return false;
      a.setLocalStateField('user', user);
      return true;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__setAwarenessCursor = (x: number, y: number) => {
      const a = _activeProviderRef?.awareness;
      if (!a) return false;
      a.setLocalStateField('cursor', { x, y });
      return true;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__getAwarenessStates = () => {
      const a = _activeProviderRef?.awareness;
      if (!a) return [];
      const out: Array<{ clientId: number; user?: unknown; cursor?: unknown }> = [];
      for (const [clientId, state] of a.getStates()) {
        out.push({ clientId, ...(state as object) });
      }
      return out;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__getLocalClientId = () => {
      return _activeProviderRef?.awareness?.clientID ?? null;
    };
  }

  // Clerk's JS bundle is loaded cross-origin from clerk.accounts.dev. With
  // COEP=require-corp on every page (Faust prereq), the browser refuses to
  // load it unless the CDN sends Cross-Origin-Resource-Policy headers — and
  // Clerk's CDN doesn't. So we only mount ClerkProvider on routes that
  // actually need auth, leaving the public canvas at `/` free to use SAB.
  // Same prefix list as hooks.server.ts uses to scope the server handle.
  const AUTH_PREFIXES = ['/dashboard', '/r/', '/sign-in', '/sign-up'];
  let isAuthRoute = $derived(
    AUTH_PREFIXES.some((p) => page.url.pathname === p || page.url.pathname.startsWith(p)),
  );
</script>

{#if isAuthRoute}
  <ClerkProvider {...data}>
    {@render children()}
  </ClerkProvider>
{:else}
  {@render children()}
{/if}

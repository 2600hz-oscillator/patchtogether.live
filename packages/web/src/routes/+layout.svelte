<script lang="ts">
  import '@xyflow/svelte/dist/style.css';
  import './global.css';
  import '$lib/ui/modules/_module-card.css';
  import { ClerkProvider } from 'svelte-clerk';
  import { page } from '$app/state';
  import { ydoc } from '$lib/graph/store';
  import { attachProvider } from '$lib/multiplayer/provider';

  let { data, children } = $props();

  // Stage B PR B-b: expose attachProvider as a dev global so Playwright
  // @collab tests can wire two browser contexts to the same Hocuspocus
  // doc without going through Clerk auth on /r/[id]. Server is in
  // stub-accept mode (PR A); real auth lands in PR C. Returns a promise
  // that resolves once the provider has synced its initial state with
  // the server, so tests don't have to guess at a settle timeout.
  if (import.meta.env.DEV && typeof window !== 'undefined') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__attachProvider = async (rackspaceId: string, token = 'stub') => {
      const provider = attachProvider({ rackspaceId, ydoc, token, debug: true });
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`provider sync timeout for ${rackspaceId}`)),
          5000,
        );
        provider.on('synced', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      return provider;
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

<script lang="ts">
  import '@xyflow/svelte/dist/style.css';
  import './global.css';
  import '$lib/ui/modules/_module-card.css';
  import { ClerkProvider } from 'svelte-clerk';
  import { page } from '$app/state';

  let { data, children } = $props();

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

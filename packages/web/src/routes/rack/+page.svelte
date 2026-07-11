<script lang="ts">
  import { page } from '$app/state';
  import Canvas from '$lib/ui/Canvas.svelte';
  import { normalizeRackMode } from '$lib/graph/rack-mode';

  // `homeAuth` is derived SERVER-SIDE in +layout.server.ts (the scratch
  // canvas at `/rack` doesn't mount the client <ClerkProvider> — that would
  // break SharedArrayBuffer / cross-origin isolation needed by the audio
  // engine). We feed it to the header so a signed-in user sees their account
  // instead of "Sign in". It is NOT passed as `currentUserId`: that would flip
  // the canvas into multi-user layout mode, which `/rack` must not do.
  let { data } = $props();
  let headerAuth = $derived(
    data?.homeAuth
      ? {
          isSignedIn: data.homeAuth.isSignedIn,
          imageUrl: data.homeAuth.imageUrl,
          initials: data.homeAuth.initials,
        }
      : null,
  );

  // WORKFLOW MODE P1 — `/rack?mode=workflow` boots the scratch canvas in the
  // workflow shell (no rackspace / no DB): a local workflow sandbox, and the
  // seam the non-collab e2e lane uses to exercise the shell. Anything except
  // exactly 'workflow' is the dawless scratch canvas, unchanged.
  let mode = $derived(normalizeRackMode(page.url.searchParams.get('mode')));
</script>

<Canvas {headerAuth} {mode} />

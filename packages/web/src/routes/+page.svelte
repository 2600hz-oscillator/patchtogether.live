<script lang="ts">
  import Canvas from '$lib/ui/Canvas.svelte';

  // `homeAuth` is derived SERVER-SIDE in +layout.server.ts (the public `/`
  // canvas doesn't mount the client <ClerkProvider> — that would break
  // SharedArrayBuffer / cross-origin isolation needed by the audio engine).
  // We feed it to the header so a signed-in user sees their account instead
  // of "Sign in". It is NOT passed as `currentUserId`: that would flip the
  // canvas into multi-user layout mode, which `/` must not do.
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
</script>

<Canvas {headerAuth} />

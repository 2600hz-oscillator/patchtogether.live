<script lang="ts">
  import Canvas from '$lib/ui/Canvas.svelte';

  // `isAuthed` comes from the root +layout.server.ts (server-side Clerk
  // session), so the landing header can show a "Dashboard" affordance for
  // logged-in users WITHOUT mounting ClerkProvider here (which would break
  // SharedArrayBuffer / cross-origin isolation on `/`). The layout server
  // load runs for `/` even though this page is `ssr = false`.
  let { data } = $props();
</script>

<Canvas isAuthed={data.isAuthed} />

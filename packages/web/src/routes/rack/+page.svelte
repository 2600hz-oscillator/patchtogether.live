<script lang="ts">
  import { onDestroy } from 'svelte';
  import { page } from '$app/state';
  import Canvas from '$lib/ui/Canvas.svelte';
  import { normalizeRackMode } from '$lib/graph/rack-mode';
  import { ydoc, bindRackspace, unbindRackspace } from '$lib/graph/store';
  import { attachLocalReplica } from '$lib/multiplayer/local-replica';
  import { getOrCreateLocalScratchId } from '$lib/storage/local-scratch';

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

  // SCRATCH PERSISTENCE — the scratch canvas has no rackspace id and no relay,
  // so it never attached a durable sink and a refresh threw the whole patch
  // away. Give it a STABLE per-device id (localStorage, keyed by mode) and
  // mirror its Y.Doc into IndexedDB via the existing local-replica machinery,
  // so a reload rehydrates the doc in milliseconds — the warm-refresh
  // behaviour `/r/[id]` already has, minus the relay. This stays a SEPARATE
  // persistent local sandbox (Option A): signing in / joining a real rack does
  // NOT migrate the scratch patch — it simply persists locally.
  let scratchId = $derived(getOrCreateLocalScratchId(mode));

  // Bind the singleton store to this device+mode scratch doc BEFORE Canvas's
  // first render (mirrors the `/r/[id]` top-level bind), so Canvas mounts
  // against the correctly-bound `ydoc`/`patch`. bindRackspace is idempotent
  // for the same id; `ssr = false` on this route means this only ever runs
  // client-side.
  bindRackspace(scratchId);

  // Re-bind on a scratchId change (a `?mode=` switch) — idempotent for the
  // same id, so the initial top-level bind above makes the first run a no-op —
  // then attach the IndexedDB replica. Teardown detaches the replica but KEEPS
  // the stored data (that survival across reload is the whole point). The
  // `{#key scratchId}` wrapper below remounts Canvas whenever the id changes so
  // its `$derived`/`$effect` subscriptions reattach to the freshly-bound doc.
  $effect(() => {
    bindRackspace(scratchId);
    const replica = attachLocalReplica(scratchId, ydoc);
    return () => {
      void replica.destroy();
    };
  });

  onDestroy(() => {
    // Release the scratch doc + UndoManager so a later mount starts clean; the
    // stored IndexedDB replica is untouched, so re-entering re-seeds from it.
    unbindRackspace();
  });
</script>

{#key scratchId}
  <Canvas {headerAuth} {mode} rackspaceId={scratchId} />
{/key}

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

  // GATE the Canvas mount on the replica seed. Canvas's workflow "ensure"
  // effects (pinned-module trio + default wires) write default state into
  // DETERMINISTIC keys (`pinned-mixmstrs`, `pinned-timelorde`, …) on mount,
  // and on `/rack` there is NO provider to gate them (they only skip while
  // `provider && !providerHasSynced`). If they ran BEFORE the IndexedDB seed
  // lands, the fresh defaults would race the STORED pinned state at the same
  // Yjs key — a clientID tiebreak that ~half the time lets the empty defaults
  // win and discards the user's saved pinned-module settings (and can
  // resurrect a deleted default cable). Deferring the mount until the seed
  // resolves makes the ensures run against the ALREADY-SEEDED doc, where their
  // `if (patch.nodes[spec.id]) continue` correctly skips the restored nodes —
  // no race, no clobber. This is localized to the scratch route; Canvas's
  // shared ensure logic (which real `/r/[id]` racks rely on) is untouched.
  // `whenSeeded` resolves seeded|fresh|cleared-corrupt|disabled — mount on ANY
  // of them (a fresh/disabled doc has nothing to clobber). The seed is
  // near-instant, so the blank frame before it lands is imperceptible.
  let seeded = $state(false);

  // Bind the singleton store to this device+mode scratch doc, then attach the
  // IndexedDB replica to seed it; flip `seeded` once the seed resolves so the
  // `{#key scratchId}` block below mounts Canvas. Re-runs on a scratchId change
  // (a `?mode=` switch): resets the gate, rebinds (idempotent for the same id),
  // and re-seeds against the mode-correct doc. Teardown detaches the replica
  // but KEEPS the stored data (that survival across reload is the whole point).
  $effect(() => {
    const id = scratchId;
    seeded = false;
    bindRackspace(id);
    const replica = attachLocalReplica(id, ydoc);
    let cancelled = false;
    void replica.whenSeeded.then(() => {
      if (!cancelled) seeded = true;
    });
    return () => {
      cancelled = true;
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
  {#if seeded}
    <Canvas {headerAuth} {mode} rackspaceId={scratchId} />
  {/if}
{/key}

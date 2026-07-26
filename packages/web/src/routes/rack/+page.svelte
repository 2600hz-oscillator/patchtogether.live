<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { page } from '$app/state';
  import Canvas from '$lib/ui/Canvas.svelte';
  import { normalizeRackMode } from '$lib/graph/rack-mode';
  import { ydoc, bindRackspace, unbindRackspace } from '$lib/graph/store';
  import { attachLocalReplica } from '$lib/multiplayer/local-replica';
  import {
    getOrCreateLocalScratchId,
    recordLastScratchMode,
    resetLocalScratchId,
  } from '$lib/storage/local-scratch';

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

  // FRESH-SANDBOX ENTRY (?new=1) — the landing "new … rack" tiles link here with
  // `?new=1` because they must NOT resume the last session ("Return to last rack"
  // is the resume affordance). Mint a NEW per-device scratch id for this mode UP
  // FRONT — synchronously, before `scratchId` below is derived — so the canvas
  // binds an EMPTY doc instead of rehydrating the previous one from IndexedDB
  // (the same reset the in-app File → New rack performs via resetLocalScratchId).
  // Client-only + once per mount (a plain init statement, not reactive). The flag
  // is then stripped from the address bar in onMount below so a later REFRESH
  // reopens THIS fresh rack — getOrCreateLocalScratchId reads the now persisted
  // fresh id — rather than resetting to yet another empty doc.
  const freshScratchRequested =
    typeof window !== 'undefined' && page.url.searchParams.get('new') === '1';
  if (freshScratchRequested) resetLocalScratchId(mode);

  // SCRATCH PERSISTENCE — the scratch canvas has no rackspace id and no relay,
  // so it never attached a durable sink and a refresh threw the whole patch
  // away. Give it a STABLE per-device id (localStorage, keyed by mode) and
  // mirror its Y.Doc into IndexedDB via the existing local-replica machinery,
  // so a reload rehydrates the doc in milliseconds — the warm-refresh
  // behaviour `/r/[id]` already has, minus the relay. This stays a SEPARATE
  // persistent local sandbox (Option A): signing in / joining a real rack does
  // NOT migrate the scratch patch — it simply persists locally.
  let scratchId = $derived(getOrCreateLocalScratchId(mode));

  // E2E REPLICA OPT-OUT (default OFF only under an ACTUAL automated run). The
  // general e2e / per-module-per-port suite tests MODULE CORRECTNESS on `/rack`;
  // that is ORTHOGONAL to persistence, so those runs must stay ISOLATED from the
  // IndexedDB replica — otherwise the replica's mount-time attach can race a
  // cross-domain module's audio-graph build (the nibbles video→audio bridge)
  // and its cross-navigation persistence pollutes specs that re-`goto('/rack')`
  // expecting an ephemeral canvas.
  //
  // We key the opt-out on `navigator.webdriver` — TRUE only inside a live
  // Playwright/WebDriver session (nothing in e2e/playwright.config.ts disables
  // it) — a RUNTIME signal, NOT the VITE_E2E_HOOKS BUILD flag. That flag is set
  // on the dev + autotest DEPLOYS (dev.patchtogether.live, where the owner
  // works, and local `npm run dev`), so gating on `testHooksEnabled()` turned
  // persistence OFF for those REAL users too — the original Fix A regression
  // this fix repairs (add a module, refresh → lost rack). Persistence is now ON
  // for EVERY real user (prod AND the VITE_E2E_HOOKS=1 dev/autotest deploys AND
  // local `npm run dev`); it is disabled ONLY under a real webdriver-driven run,
  // where the isolation is required. Behaviour under e2e is IDENTICAL to Fix A
  // (per-port/general = OFF, opt-in specs = ON), so this cannot regress e2e. The
  // dedicated `scratch-persist.spec.ts` opts back IN via `window.__ptScratchReplica`
  // so the real cross-refresh persistence (incl. the workflow pinned-param
  // regression) is still covered.
  const replicaEnabled =
    (typeof window !== 'undefined' &&
      (window as unknown as { __ptScratchReplica?: boolean }).__ptScratchReplica === true) ||
    !(typeof navigator !== 'undefined' && navigator.webdriver === true);

  // SEED GATE for the workflow ensures (only meaningful when the replica is ON).
  // Canvas mounts IMMEDIATELY (engine ready for users + e2e — do NOT block the
  // whole canvas on the seed); we thread a `seeded` boolean down so Canvas's two
  // workflow "ensure" effects defer until the IndexedDB replica has seeded.
  // Without that, on the provider-less scratch canvas the ensures fire on mount
  // and write default pinned state into deterministic keys BEFORE the seed lands,
  // racing the restored state at the same Yjs key (clientID tiebreak) — ~half of
  // refreshes discard the user's saved pinned-module settings (and can resurrect
  // a deleted default cable). `whenSeeded` resolves seeded|fresh|cleared-corrupt|
  // disabled — release the gate on ANY of them. When the replica is OFF we pass
  // `scratchSeeded={undefined}` (NOT false) so the ensures run immediately.
  let seeded = $state(false);

  // Bind the singleton store to this device+mode scratch doc, then (when the
  // replica is enabled) attach it and flip `seeded` when the seed resolves.
  // Re-runs on a scratchId change (a `?mode=` switch): idempotent rebind + a
  // fresh replica against the mode-correct doc. Teardown detaches the replica
  // but KEEPS the stored data. The `{#key scratchId}` wrapper below remounts
  // Canvas whenever the id changes so its subscriptions reattach.
  $effect(() => {
    const id = scratchId;
    seeded = false;
    // Stamp this as the most-recently-opened scratch kind so the landing's
    // "Return to last rack" card knows which mode to reopen. Cheap localStorage
    // write; runs whether or not the IndexedDB replica is enabled (the card
    // additionally verifies the replica DB exists).
    recordLastScratchMode(mode);
    bindRackspace(id);
    if (!replicaEnabled) return; // ephemeral /rack (test harness, no opt-in)
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

  onMount(() => {
    if (!freshScratchRequested) return;
    // The fresh id is already minted (synchronous init above). Now drop `?new=1`
    // from the ADDRESS BAR — keeping `mode=` intact — so a REFRESH rehydrates
    // THIS rack (getOrCreateLocalScratchId reads the persisted fresh id) instead
    // of minting yet another empty doc on every reload. Native history.replaceState
    // (NOT SvelteKit's shallow replaceState, which throws depending on router
    // state — it did in workflow mode) with the existing history.state preserved
    // so back/forward tracking survives. We're only tidying the URL, not
    // navigating: page.url stays as-is, but nothing reactive here reads `new`
    // (mode is unchanged, so scratchId is stable and Canvas does not remount).
    try {
      const url = new URL(window.location.href);
      if (!url.searchParams.has('new')) return;
      url.searchParams.delete('new');
      history.replaceState(history.state, '', url.pathname + url.search);
    } catch {
      /* history unavailable → harmless: worst case a refresh re-mints an empty rack. */
    }
  });

  onDestroy(() => {
    // Release the scratch doc + UndoManager so a later mount starts clean; the
    // stored IndexedDB replica is untouched, so re-entering re-seeds from it.
    unbindRackspace();
  });
</script>

{#key scratchId}
  <Canvas
    {headerAuth}
    {mode}
    rackspaceId={scratchId}
    scratchSeeded={replicaEnabled ? seeded : undefined}
  />
{/key}

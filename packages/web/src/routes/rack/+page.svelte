<script lang="ts">
  import { onDestroy } from 'svelte';
  import Canvas from '$lib/ui/Canvas.svelte';
  import AudioGate from '$lib/ui/AudioGate.svelte';
  import { createAudioGate } from '$lib/audio/audio-gate.svelte';
  import { ydoc, bindRackspace, unbindRackspace } from '$lib/graph/store';
  import { attachLocalReplica } from '$lib/multiplayer/local-replica';
  import { getOrCreateLocalScratchId } from '$lib/storage/local-scratch';

  // AUDIO GATE (#1826). `ensureEngine()` builds the AudioContext, awaits
  // resume(), and only THEN reaches `new VideoEngine(...)` — so until a user
  // gesture runs it there is no engine AT ALL, video paints black and audio is
  // silent. `/r/[id]` has always mounted the overlay that says so; THIS route —
  // the default, and the one most people land on — did not, so the scratch rack
  // simply sat there dead with no explanation. (It was reported as "video output
  // is broken", which is what a silent dead engine looks like from outside.)
  //
  // The store is created here and threaded BOTH ways on purpose: `audioGate` into
  // Canvas so it can register `ensureEngine` as the booter and bind the live
  // AudioContext, and the same store into <AudioGate> so the overlay reflects it.
  // Passing only one half yields an overlay that renders and does nothing.
  //
  // ⚠ Coverage of this is a property of the ROUTE SET, not of this file: see
  // `canvas-routes-audio-gate.test.ts`, which derives every route that mounts
  // Canvas and requires both halves of the wiring on each of them.
  const audioGate = createAudioGate();

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

  // SCRATCH PERSISTENCE — the scratch canvas has no rackspace id and no relay,
  // so it never attached a durable sink and a refresh threw the whole patch
  // away. Give it a STABLE per-device id (localStorage) and mirror its Y.Doc
  // into IndexedDB via the existing local-replica machinery, so a reload
  // rehydrates the doc in milliseconds — the warm-refresh behaviour `/r/[id]`
  // already has, minus the relay. This stays a SEPARATE persistent local
  // sandbox (Option A): signing in / joining a real rack does NOT migrate the
  // scratch patch — it simply persists locally.
  //
  // `?mode=` is GONE: there is one rack shell, so there is one
  // scratch doc. (`?shell=legacy` selects legacy CARDS inside that same shell —
  // Canvas reads it directly from the URL; it does not fork the doc.)
  let scratchId = $derived(getOrCreateLocalScratchId());

  // E2E REPLICA OPT-OUT (default OFF only under an ACTUAL automated run). The
  // general e2e / per-module-per-port suite tests MODULE CORRECTNESS on `/rack`;
  // that is ORTHOGONAL to persistence, so those runs must stay ISOLATED from the
  // IndexedDB replica — its cross-navigation persistence pollutes specs that
  // re-`goto('/rack')` expecting an ephemeral canvas (livecode:258 "recreate
  // Load example" got duplicate node types from the re-seeded phase-1 patch).
  // THAT is the reason this opt-out exists, and it still holds.
  //
  // ⚠ CORRECTION (2026-08-02). #1131 ALSO claimed the replica's mount-time
  // attach races a cross-domain module's audio-graph build (nibbles' video→audio
  // `snake` output emitting 0), and left "engine-level fix (replica-attach vs
  // bridge-build ordering)" as an open follow-up. That claim does NOT reproduce:
  // driven with the replica explicitly opted IN, across 5 reload+re-seed rounds,
  // `nibbles.snake` carried audio every time with `pendingBridges=0`,
  // `appliedBridges=1` — and so did `videocube.audio_out` and
  // `mandelbulb.audio_out`. The engine already implements the "robust to an
  // endpoint arriving mid-build" half: a bridge that cannot wire is PARKED in
  // `PatchEngine.pendingBridges` and drained by `drainPendingForNode` /
  // `reapplyAudioBridgesForSource` when the node materializes or a video module
  // publishes its `audioSources` entry late (engine.ts ~919-1075). Verified
  // positively on mandelbulb, whose `audio_out` only surfaces once SLICE is on:
  // with SLICE off the bridge sits parked (pending=1, applied=0) and with SLICE
  // on it wires and sounds. So do NOT reach for this opt-out to explain a silent
  // cross-domain output — measure the observation window first.
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

  // Bind the singleton store to this device's scratch doc, then (when the
  // replica is enabled) attach it and flip `seeded` when the seed resolves.
  // Re-runs on a scratchId change (File → New rack mints a fresh id):
  // idempotent rebind + a fresh replica. Teardown detaches the replica but
  // KEEPS the stored data. The `{#key scratchId}` wrapper below remounts Canvas
  // whenever the id changes so its subscriptions reattach.
  //
  // The landing's "Return to last rack" card needs no separate stamp: the
  // persisted scratch id is minted HERE, on mount, so its mere existence is the
  // "this device has opened a rack" signal (see local-scratch.ts).
  $effect(() => {
    const id = scratchId;
    seeded = false;
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

  onDestroy(() => {
    // Release the scratch doc + UndoManager so a later mount starts clean; the
    // stored IndexedDB replica is untouched, so re-entering re-seeds from it.
    unbindRackspace();
  });
</script>

{#key scratchId}
  <Canvas
    {headerAuth}
    {audioGate}
    rackspaceId={scratchId}
    scratchSeeded={replicaEnabled ? seeded : undefined}
  />
{/key}
<!-- OUTSIDE {#key} — minting a fresh scratch id (File → New rack) remounts the
     canvas but must not tear down and re-raise the overlay over an AudioContext
     that is already running. Same placement as /r/[id]'s. -->
<AudioGate gate={audioGate} />

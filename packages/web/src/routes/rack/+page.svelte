<script lang="ts">
  import { onDestroy } from 'svelte';
  import Canvas from '$lib/ui/Canvas.svelte';
  import AudioGate from '$lib/ui/AudioGate.svelte';
  import { createAudioGate } from '$lib/audio/audio-gate.svelte';
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

  // AUDIO GATE (#1826) — /rack booted NO engine and showed NO prompt: the
  // AudioContext can't start without a gesture (autoplay policy), and unlike
  // /r/[id] there was no overlay saying so, so the default route sat silently
  // dead until the user happened to click something. Mount the same gate
  // /r/[id] uses: Canvas wires its booter, the overlay resumes+boots on first
  // click and hides while the ctx is `running`.
  //
  // ⚠ SUPPRESSED UNDER WEBDRIVER, same runtime signal (and same reasoning) as
  // `replicaEnabled` above: the overlay is full-screen and click-intercepting,
  // and the /rack e2e fixture population boots this route and clicks
  // immediately — their engine still boots from that first gesture, exactly
  // today's behavior. `window.__ptRackAudioGate = true` opts a spec back IN;
  // `rack-audio-gate.spec.ts` uses it to prove the real-user path (overlay
  // visible → click → ctx running) and that plain webdriver runs see nothing.
  const audioGate = createAudioGate();
  const audioGateVisible =
    (typeof window !== 'undefined' &&
      (window as unknown as { __ptRackAudioGate?: boolean }).__ptRackAudioGate === true) ||
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

  // ── BIND BEFORE <Canvas> EXISTS, not in an $effect ────────────────────────
  //
  // ⚠ THE BIND MUST HAPPEN AT COMPONENT INIT. This used to live only in the
  // `$effect` below, and Svelte 5 runs a CHILD's effects BEFORE its parent's:
  // <Canvas> mounted, published `__patch`/`__ydoc`, and ran all four of its
  // workflow seed effects (pinned trio + P2 surfaces, the MIXMSTRS→AUDIO OUT
  // default wires, the default videoOut, the recorderbox/synesthesia pair)
  // against the store's INITIAL module-scope doc — and only then did this
  // component's effect run `bindRackspace`, which DESTROYS that doc and
  // installs a fresh empty one. Every seed then had to run a SECOND time
  // against the real doc, so a fresh /rack boot did the entire shell seed
  // twice, with a full legacy-card mount of ten modules in between.
  //
  // Measured on the preview build, probe = console `[canvas] workflow: ensured
  // pinned modules` lines stamped with the live `__ydoc.guid`. TWO distinct
  // guids, one full seed cascade each, on every boot; the gap between them
  // grows with load (CDP `Emulation.setCPUThrottlingRate`):
  //
  //     throttle   seed #1    seed #2     gap    pinned trio visible in __patch
  //        1x       271 ms     306 ms    35 ms      402 ms
  //       12x      2719 ms    3142 ms   422 ms     3448 ms
  //       50x     11494 ms   13176 ms   1.7 s     14593 ms
  //       90x     21776 ms   26341 ms   4.6 s     29326 ms
  //
  // That is the #1847 `workflow-mode.spec.ts` boot flake. `waitForPinnedTrio`
  // watches `__patch`, which `bindRackspace` correctly re-points at the NEW
  // doc, so the wait CANNOT be satisfied by the first cascade — only by the
  // second. All seven observations in the 2026-08-31 census carry exactly that
  // fingerprint in their Playwright traces: two `ensured pinned modules` lines
  // 7.7–28.0 s apart, the second landing AFTER the wait had already expired.
  // CI's gap is much larger than CPU throttling alone reproduces because the
  // work sitting between the two cascades is a full legacy-card + video-engine
  // build of ten modules on SwiftShader, with three sibling workers competing
  // for the same 4 vCPUs — and it is then thrown away and done again. Raising
  // the bound 10 s → 30 s could not help: the cost being waited on is work the
  // app should never have done at all.
  //
  // Real users never saw it because `replicaEnabled` is true for them, which
  // makes `scratchSeeded` false and defers the seeds past the bind anyway. It
  // is reachable only where the replica is off — which is every webdriver run.
  //
  // Binding here (module init, before the template instantiates <Canvas>) is
  // the whole fix: the store's singleton is already the scratch doc when
  // Canvas's effects first run, so the seed happens ONCE, into the doc that
  // survives. `bindRackspace` is idempotent for an unchanged id, so the
  // `$effect` below re-binding on its first run is a no-op.
  bindRackspace(scratchId);

  // Attach the local replica (when enabled) and flip `seeded` when the seed
  // resolves; re-binds on a scratchId change (File → New rack mints a fresh
  // id): idempotent rebind + a fresh replica. Teardown detaches the replica
  // but KEEPS the stored data. The `{#key scratchId}` wrapper below remounts
  // Canvas whenever the id changes so its subscriptions reattach.
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
{#if audioGateVisible}
  <AudioGate gate={audioGate} />
{/if}

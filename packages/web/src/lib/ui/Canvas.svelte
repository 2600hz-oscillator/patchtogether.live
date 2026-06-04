<script lang="ts">
  // Day 7 — Svelte Flow canvas + module cards + auto-reactive engine.
  //
  // Click "Load example" → patch graph populates → Svelte Flow renders cards →
  // reconciler instantiates engine nodes → audio plays. Twiddle a knob →
  // patch graph mutates → reconciler calls engine.setParam → audible change.
  import { onDestroy } from 'svelte';
  import {
    SvelteFlow,
    Background,
    Controls,
    MiniMap,
    type Node as FlowNode,
    type Edge as FlowEdge,
    type Connection,
  } from '@xyflow/svelte';
  import { patch, ydoc, undoManager, LOCAL_ORIGIN } from '$lib/graph/store';
  import { buildDuplicate } from '$lib/graph/duplicate';
  import { getDefaultSnapshotBus, type PatchSnapshot } from '$lib/graph/snapshot';
  import {
    makeEnvelope,
    makePortableEnvelope,
    downloadEnvelope,
    pickAndLoadEnvelope,
    parseEnvelope,
    loadEnvelopeIntoStore,
    sanitizeFilename,
    DEFAULT_FILENAME,
    EnvelopeParseError,
    type PatchEnvelope,
  } from '$lib/graph/persistence';
  import {
    makePerformanceBundle,
    validateBundle,
    BundleParseError,
    mergeMidiBindings,
  } from '$lib/graph/performance-bundle';
  import {
    canPersistPerformances,
    savePerformanceSlot,
    loadPerformanceSlot,
    listPerformanceSlots,
    deletePerformanceSlot,
    MAX_PERFORMANCES,
  } from '$lib/graph/performance-store';
  import {
    exportBindings as exportMidiBindings,
    importBindings as importMidiBindings,
    connect as connectMidiLearn,
  } from '$lib/midi/midi-learn.svelte';
  import { getMidiClockSource } from '$lib/midi/midi-clock-source';

  function persistenceLoad(env: unknown, ydocArg: typeof ydoc, patchArg: typeof patch) {
    // Validate via parseEnvelope when a raw object is passed; if already typed,
    // pass through.
    let validated: PatchEnvelope;
    if (typeof env === 'object' && env !== null && (env as PatchEnvelope).envelopeVersion === 1) {
      validated = env as PatchEnvelope;
    } else {
      validated = parseEnvelope(JSON.stringify(env));
    }
    return loadEnvelopeIntoStore(validated, ydocArg, patchArg);
  }
  import { AudioEngine, PatchEngine } from '$lib/audio/engine';
  import { attachReconciler } from '$lib/audio/reconciler';
  import { getModuleDef, listModuleDefs } from '$lib/audio/module-registry';
  import { provideEngineContext } from '$lib/audio/engine-context';
  import { provideProviderContext } from '$lib/multiplayer/provider-context';
  import { testHooksEnabled } from '$lib/dev/test-hooks';
  import '$lib/audio/modules'; // auto-registers analogVcoDef + audioOutDef
  // Video-domain (Phase 0 spike) — sibling registry + engine class. Imported
  // here so module defs are present in the registry by the time the palette
  // reads listModuleDefs(); engine instance is created lazily in ensureEngine.
  import { VideoEngine } from '$lib/video/engine';
  import { listVideoModuleDefs, getVideoModuleDef } from '$lib/video/module-registry';
  import '$lib/video/modules'; // auto-registers linesDef + videoOutDef
  // Meta-domain registry — sticky notes etc. (no engine binding).
  import { listMetaModuleDefs, getMetaModuleDef } from '$lib/meta/module-registry';
  import '$lib/meta/modules'; // auto-registers stickyDef
  // Module cards are resolved GLOB-DRIVEN from $lib/ui/modules/*Card.svelte
  // via $lib/ui/modules-card-map — no hand-maintained per-card import list
  // (that append-edit was a top cross-PR conflict source). A new module just
  // drops its XyzCard.svelte here (matching the PascalCase(type)+Card
  // convention, or declaring `card` on its def) and is picked up automatically.
  import { buildNodeTypes } from '$lib/ui/modules-card-map';
  import { computeCabinetLayout } from '$lib/ui/canvas/cabinet-layout';
  // ModuleNameLabel moved INTO every module card's title chrome (see
  // ModuleTitle.svelte) when the floating-overhead NodeToolbar was dropped.
  // Canvas no longer renders the label directly.
  import ModulePalette from '$lib/ui/ModulePalette.svelte';
  import { canAddModule } from '$lib/doom/doom-gating';
  import SavedGroupsPicker from '$lib/ui/SavedGroupsPicker.svelte';
  import NodeContextMenu from '$lib/ui/NodeContextMenu.svelte';
  import PortContextMenu from '$lib/ui/PortContextMenu.svelte';
  import SelectionContextMenu from '$lib/ui/SelectionContextMenu.svelte';
  import GroupBuilderModal from '$lib/ui/GroupBuilderModal.svelte';
  import ExposedControlsModal from '$lib/ui/ExposedControlsModal.svelte';
  import LassoOverlay from '$lib/ui/LassoOverlay.svelte';
  import {
    buildPortCandidates,
    buildExposedPorts,
    planCreateGroup,
    planUngroup,
    planEditExposed,
    planDuplicateGroup,
    type PortCandidate,
    type PortLookupModule,
  } from '$lib/graph/group-actions';
  import type { ExposedPort, ExposedControl, GroupData } from '$lib/graph/group-projection';
  import { resolveExposedPort } from '$lib/graph/group-projection';
  import { listExposableControls, validateExposedControls } from '$lib/graph/group-controls';
  import {
    nextGroupNameForNewGroup,
    planDefaultGroupNames,
    LEGACY_GROUP_PLACEHOLDER,
  } from '$lib/graph/group-naming';
  import {
    extractSavedGroupPayload,
    resurrectSavedGroup,
  } from '$lib/graph/saved-group-resurrect';
  import type { SavedGroup } from '$lib/server/saved-groups';
  import { connectDragState } from '$lib/ui/connect-drag-state.svelte';
  import {
    buildModuleEntries,
    compatibleTargetPorts,
    type AnyDef,
    type CandidatePort,
    type ModuleEntry,
  } from '$lib/ui/port-patch-helpers';
  import AwarenessLayer from '$lib/ui/AwarenessLayer.svelte';
  import {
    setLocalGroupBuildingSelection,
    readRemoteGroupBuilding,
    indexRemoteGroupBuildingByNode,
    overlapsRemoteGroupBuilding,
    type RemoteGroupBuilding,
  } from '$lib/multiplayer/group-building-presence';
  import SkinSwitcher from '$lib/ui/SkinSwitcher.svelte';
  import FlowBridge, { type FlowBridgeApi, type InternalFlowNode } from '$lib/ui/FlowBridge.svelte';
  import CadillacOverlay from '$lib/ui/CadillacOverlay.svelte';
  import PickupCable from '$lib/ui/PickupCable.svelte';
  import { organizeLayout, type Box } from '$lib/ui/canvas/organize';
  import type { CableType, Edge, PortDef, ModuleNode } from '$lib/graph/types';
  import { canConnect } from '$lib/graph/types';
  import { getNodePosition, setNodePosition } from '$lib/multiplayer/layouts';
  import {
    pictureboxSpawnDecision,
    explainSpawnDenial,
    PICTUREBOX_TYPE,
  } from '$lib/multiplayer/picturebox-limits';
  import {
    samsloopSpawnDecision,
    SAMSLOOP_TYPE,
    SAMSLOOP_LIMIT_MESSAGE,
  } from '$lib/multiplayer/samsloop-limits';
  import {
    nextDefaultName,
    migrateAssignNames,
  } from '$lib/multiplayer/module-naming';
  // TIMELORDE auto-spawn — the rack always needs a system clock, so when the
  // patch loads (or boots empty) without one, drop a TIMELORDE in. Pure
  // helpers; the $effect that wires them lives further down with the other
  // snapshot-bus subscribers.
  import {
    shouldAutoSpawnTimelorde,
    pickTimelordeDefaultPosition,
  } from '$lib/audio/modules/timelorde-autospawn';
  import type { HocuspocusProvider } from '@hocuspocus/provider';
  import type { PresenceUser } from '$lib/multiplayer/presence';
  import { installSimulatedMidiDevice } from '$lib/midi/midi-learn.svelte';

  // Stage B PR B-b: when mounted under /r/[id] (multi-user), the parent
  // passes the current user's id so per-user layouts are scoped correctly.
  // On the public canvas at `/`, this stays undefined and the layout
  // helpers fall through to node.position (single-user behavior preserved).
  //
  // Awareness (provider + presenceUser): cursor broadcast + remote cursor
  // rendering. Audio gate: AudioGate store wires Canvas's ensureEngine into
  // the overlay so the AudioContext can resume from a user gesture. All
  // optional — the public `/` canvas leaves them undefined.
  interface Props {
    currentUserId?: string;
    provider?: HocuspocusProvider | null;
    presenceUser?: PresenceUser | null;
    audioGate?: import('$lib/audio/audio-gate.svelte').AudioGate;
    // Server-derived auth state for the header on routes that DON'T mount
    // the client <ClerkProvider> (the public `/` canvas keeps SAB / cross-
    // origin isolation, which Clerk's client scripts break). Drives the
    // header account/avatar vs. "Sign in" WITHOUT flipping the canvas into
    // multi-user mode — that's `currentUserId`'s job and stays undefined on
    // `/`. See lib/server/home-auth.ts + routes/+layout.server.ts.
    headerAuth?: {
      isSignedIn: boolean;
      imageUrl: string | null;
      initials: string | null;
    } | null;
  }
  let {
    currentUserId,
    provider = null,
    presenceUser = null,
    audioGate,
    headerAuth = null,
  }: Props = $props();

  // The header shows "Sign in" only when we're confident the user is signed
  // out. On the public `/` canvas (no client ClerkProvider) that signal is
  // server-derived via `headerAuth`; on `/r/[id]` (provider mounted) it's
  // `currentUserId`. Either being signed-in suppresses the link.
  let headerSignedIn = $derived(Boolean(currentUserId) || headerAuth?.isSignedIn === true);

  // Whether the LOCAL user owns the rackspace. `presenceUser.isRackOwner` is
  // published by r/[id]/+page.svelte (authed owner only; anon members never).
  // `undefined` (the public `/` canvas / no presence) = single-user / no-
  // provider rack with a sole de-facto owner — owner-only modules stay addable
  // there (canAddModule treats undefined as allowed). Used to gate the
  // owner-only DOOM widget in the palette + spawn path.
  let localIsRackOwner = $derived<boolean | undefined>(
    presenceUser ? presenceUser.isRackOwner === true : undefined,
  );

  // The SvelteFlow node-component map, derived from EVERY registered def
  // (audio + video + meta) via the glob-driven card resolver. Adding a
  // module needs no edit here. Built once at module scope (the registries
  // self-register on the barrel imports above, so the lists are populated).
  const nodeTypes = buildNodeTypes([
    ...listModuleDefs(),
    ...listVideoModuleDefs(),
    ...listMetaModuleDefs(),
  ]);

  let audioCtx: AudioContext | null = $state(null);
  let engine: PatchEngine | null = $state(null);
  let reconciler: { reconcile: () => Promise<void>; dispose: () => void } | null = $state(null);
  let booting = $state(false);
  let error = $state<string | null>(null);
  let log = $state<string[]>([]);

  // Provide the engine to descendant module-card components (motorized faders
  // use this to read live AudioParam values).
  provideEngineContext(() => engine);
  // Provide the multiplayer provider too, so cards can write per-module
  // presence into Y.Awareness (e.g., CAMERA publishes "this user has CAMERA
  // active here" without sending pixels — see camera-presence.ts).
  //
  // Fallback to (globalThis as any).__provider lets the public `/` canvas
  // pick up the dev-only provider that `__attachProvider` installs from
  // +layout.svelte (used by @collab Playwright tests that drive `/` rather
  // than `/r/[id]`). In prod the fallback stays null because the global is
  // only ever set in DEV.
  provideProviderContext(() => {
    if (provider) return provider;
    const g = globalThis as unknown as { __provider?: HocuspocusProvider | null };
    return g.__provider ?? null;
  });

  // Dev-only (gated on testHooksEnabled): expose patch + ydoc on window so
  // e2e tests + chaos musician-bots can drive arbitrary module-spawning
  // combinations without a UI palette. Stripped in prod builds (autotest
  // sets VITE_E2E_HOOKS=1 to re-enable).
  if (testHooksEnabled()) {
    $effect(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__patch = patch;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__ydoc = ydoc;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__engine = () => engine;
      // Tests bootstrap the engine without going through Load example (which
      // creates an auto-playing Sequencer that races bind:nodes during the
      // immediate clear-then-add transact spawnPatch does).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__ensureEngine = ensureEngine;
      // Module registry, exposed for the chaos runner. Stripped in prod.
      // Returned shape is the live ModuleDef array — chaos reads it once at
      // boot to avoid maintaining a stale catalog mirror.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__listModuleDefs = listModuleDefs;
      // Lets E2E tests exercise the palette spawn path (with all its
      // per-user / per-rackspace / maxInstances guards) without driving
      // the right-click → palette → click sequence. Used by SAMSLOOP
      // cap-enforcement tests in particular.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__spawnFromPalette = spawnFromPalette;
      // Drag-lock state for e2e — patch-menus-persist tests inspect this
      // to confirm the lock engaged + released at the right moments.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__connectDragState = connectDragState;
      // Port hold-to-menu gesture phase, exposed as a getter so e2e reads
      // the LIVE value. The drag-passes-to-xyflow spec polls this for the
      // 'cancelled-move' phase — a deterministic signal that the
      // pointermove cancelled the hold — instead of racing HOLD_FIRE_MS.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__portHoldPhase = () => holdPhase;
      // Lets E2E tests exercise the connect-commit path directly — the
      // same xyflow `Connection` envelope a real pointer drag would
      // synthesize. Used by the instrument-exposed-port-patching spec
      // to assert that dragging onto a group's exposed handle creates
      // an edge in the patch (the bug it was added to regress against:
      // pre-fix, group endpoints bailed before the edge was added
      // because the def lookup returned no group def).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__handleConnect = (c: Connection) => handleConnect(c);
      // Stage-B Playwright @collab tests use these to drive the
      // multi-user provider attach + per-user layout reads without
      // routing through Clerk auth. See e2e/tests/collab.spec.ts.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__getNodePosition = (userId: string | undefined, nodeId: string, fb: { x: number; y: number }) =>
        getNodePosition(ydoc, userId, nodeId, fb);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__setNodePosition = (userId: string | undefined, nodeId: string, pos: { x: number; y: number }) =>
        setNodePosition(ydoc, userId, nodeId, pos);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__persistence = {
        makeEnvelope,
        // Wrap the bound versions so tests can call without args.
        save: () => makeEnvelope(ydoc),
        load: (env: unknown) => {
          // Caller passes a parsed envelope object (or its JSON form).
          if (typeof env === 'string') {
            const parsed = JSON.parse(env);
            return loadEnvelopeFromObject(parsed);
          }
          return loadEnvelopeFromObject(env);
        },
      };
      // Right-click + Organize tests need flow-space coords + the same
      // spawn path as the in-app palette (collision offset + maxInstances
      // guard). Going through the in-app screenToFlowPosition keeps the
      // test honest: if FlowBridge breaks, every test using __flow fails.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__flow = {
        screenToFlowPosition: (p: { x: number; y: number }) =>
          flowApi?.screenToFlowPosition(p) ?? p,
        getInternalNode: (id: string) => flowApi?.getInternalNode(id),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__spawnAtFlowPos = (
        type: string,
        flowPos: { x: number; y: number },
      ) => {
        spawnFlowPos = flowPos;
        spawnFromPalette(type);
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__organizeModules = () => organizeModules();
      // Module-grouping Phase 1: tests need to drive the GroupBuilderModal
      // open + the commitGroup callback without going through the marquee +
      // right-click pipeline (which is hard to script reliably across
      // SvelteFlow's pointer-event handling). The hook takes the selection
      // ids and seeds the same state `openGroupBuilder` would.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__openGroupBuilder = (ids: string[]) => {
        selCtxMenuIds = ids;
        openGroupBuilder();
      };
      // Lasso mode test hook — Playwright drives lasso flow via these
      // entry points instead of synthesizing pointer events (deterministic
      // across CI + headed runs).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__lasso = {
        enter: (clientX: number, clientY: number) => enterLassoMode(clientX, clientY),
        setCursor: (clientX: number, clientY: number) => {
          if (!flowApi) return;
          lassoCursorScreen = { x: clientX, y: clientY };
          lassoCursorFlow = flowApi.screenToFlowPosition({ x: clientX, y: clientY });
          recomputeLassoHits();
        },
        commit: () => {
          const ids = lassoHitIds.slice();
          exitLassoMode();
          if (ids.length < 2) return;
          selCtxMenuIds = ids;
          openGroupBuilder();
        },
        cancel: () => exitLassoMode(),
        hits: () => lassoHitIds.slice(),
        active: () => lassoMode,
      };
    });
  }
  function loadEnvelopeFromObject(env: unknown) {
    // Indirection so the test global doesn't need its own import of
    // parseEnvelope / loadEnvelopeIntoStore.
    return persistenceLoad(env, ydoc, patch);
  }

  // B3: subscribe to the shared PatchSnapshot bus (one Yjs subscription
  // for the whole app). The audio reconciler subscribes to the same bus,
  // so UI + engine see the SAME id-sorted snapshot on the SAME tick. This
  // closed the "heard but didn't see" gap in two-window collab where the
  // engine materialized nodes from incoming Yjs ops but the canvas
  // didn't render them in lockstep.
  let snapshot = $state.raw<PatchSnapshot>(getDefaultSnapshotBus().current());
  $effect(() => {
    return getDefaultSnapshotBus().subscribe((snap) => {
      snapshot = snap;
      // Group-name migration runs any time a snapshot surfaces a group
      // node whose label is blank or the legacy "GROUP!" placeholder.
      // Triggered per-snapshot (rather than once-per-mount) so a second
      // group added after the first migration still picks up a name.
      // planDefaultGroupNames is no-op when every group already has a
      // real label, so the steady-state cost is one cheap scan.
      let needsMigration = false;
      for (const n of snap.nodes) {
        if (n.type !== 'group') continue;
        const lbl = (n.data as { label?: unknown } | undefined)?.label;
        if (typeof lbl !== 'string' || lbl.trim() === '' || lbl === LEGACY_GROUP_PLACEHOLDER) {
          needsMigration = true;
          break;
        }
      }
      if (needsMigration) maybeMigrateGroupNames();
    });
  });

  // ---------------- TIMELORDE auto-spawn ----------------
  //
  // The module-def header in timelorde.ts promises: "if a rack is opened
  // without a TIMELORDE, the auto-spawn path drops one in at a fixed
  // position so the rack is always musically coherent." This is that
  // path.
  //
  // SCOPE: only fires on RACKSPACE mounts (i.e. when a Hocuspocus
  // provider is bound — `/r/[id]` routes + the `/`+`__attachProvider`
  // collab-test pattern). The public `/` demo canvas (no provider) stays
  // empty until the user clicks Load example — auto-spawning there would
  // surprise the "demo a fresh engine" workflow and break a lot of e2e
  // tests that depend on a literally-empty canvas at `goto('/')`.
  // Real patching happens on `/r/[id]`, which is where the user
  // experienced the missing-TIMELORDE pain.
  //
  // When the effect fires:
  //   - After the Hocuspocus provider has fired 'synced' at least once.
  //     Otherwise the local snapshot is the empty pre-sync state and
  //     we'd race the server's actual state (which may already contain
  //     a TIMELORDE), ending up with two TIMELORDE nodes that
  //     maxInstances would then have to reconcile.
  //
  // Guards:
  //   - didAutoSpawnTimelorde latches once per Canvas mount, so a
  //     subsequent user-driven delete (impossible — undeletable: true —
  //     but defensive) followed by snapshot churn doesn't re-spawn.
  //   - shouldAutoSpawnTimelorde is the per-snapshot predicate.
  //   - Inside the Yjs transact, a final scan of `patch.nodes` catches
  //     any TIMELORDE written by a rack-mate between our snapshot read
  //     and the transact entering (minimizes the multiplayer race
  //     window).
  //
  // Multiplayer race: two clients hitting this $effect in the same
  // moment both observe the same TIMELORDE-less snapshot. The
  // transact-time re-check usually catches one of them; in the worst
  // case both write distinct ids and Yjs merges both, leaving the rack
  // momentarily with two TIMELORDE nodes. The engine's maxInstances=1
  // refuses to materialize the second one and the orphan node is
  // visually present but not audible — undeletable+singleton means the
  // user can't easily clean it up, so future work: a dedupe pass in
  // the reconciler that removes the loser by id-order. Acceptable for
  // now since the race is narrow (one tick).
  let didAutoSpawnTimelorde = $state(false);
  let providerHasSynced = $state(false);
  $effect(() => {
    // Read the prop reactively. On `/r/[id]` this is the real provider
    // and the $effect re-runs when it binds (which is BEFORE the user
    // sees any patch data).
    const fromProp = provider;
    if (fromProp) {
      if (fromProp.isSynced) providerHasSynced = true;
      const onSynced = () => {
        providerHasSynced = true;
      };
      fromProp.on('synced', onSynced);
      return () => {
        try { fromProp.off('synced', onSynced); } catch { /* */ }
      };
    }
    // No prop provider — @collab tests use `/` + __attachProvider,
    // which stashes the provider on window AFTER awaiting sync. The
    // global isn't reactive, so we poll briefly post-mount to pick it
    // up. 50 ms cadence × ~40 attempts = 2 s budget; after that we
    // give up (the public `/` demo canvas legitimately has no provider).
    let attempts = 0;
    const POLL_MS = 50;
    const POLL_MAX = 40;
    const timer = setInterval(() => {
      attempts++;
      const g = (globalThis as unknown as {
        __provider?: HocuspocusProvider | null;
      }).__provider ?? null;
      if (g) {
        clearInterval(timer);
        if (g.isSynced) providerHasSynced = true;
        const onSynced = () => {
          providerHasSynced = true;
        };
        g.on('synced', onSynced);
        // No teardown beyond clearInterval — the global provider
        // outlives the Canvas mount on `/` (tests keep it for the
        // duration of the test run).
        return;
      }
      if (attempts >= POLL_MAX) clearInterval(timer);
    }, POLL_MS);
    return () => {
      clearInterval(timer);
    };
  });

  // Pre-effect marker: written once at module-script eval time. The
  // e2e auto-spawn spec polls for this object as the "Canvas script
  // actually ran" signal — under parallel-worker stress an HMR
  // reload can drop the script reload, and waiting on the marker is
  // the cleanest way to detect it.
  if (testHooksEnabled()) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).__timelordeAutospawnDebug = {
      runs: 0,
      mountedAt: Date.now(),
      didAutoSpawnTimelorde: false,
      providerHasSynced: false,
      snapshotNodeCount: -1,
      hasTimelordeInSnap: false,
    };
  }
  $effect(() => {
    if (testHooksEnabled()) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const g = globalThis as any;
      g.__timelordeAutospawnDebug = {
        runs: (g.__timelordeAutospawnDebug?.runs ?? 0) + 1,
        didAutoSpawnTimelorde,
        providerHasSynced,
        snapshotNodeCount: snapshot.nodes.length,
        hasTimelordeInSnap: snapshot.nodes.some((n) => n.type === 'timelorde'),
      };
    }
    if (didAutoSpawnTimelorde) return;
    if (!providerHasSynced) return;
    if (!shouldAutoSpawnTimelorde(snapshot.nodes)) {
      // Existing TIMELORDE present (loaded patch, or a rack-mate spawned
      // one first). Latch so subsequent snapshot churn (e.g. cable
      // additions) doesn't re-trigger this check pointlessly.
      didAutoSpawnTimelorde = true;
      return;
    }
    // Pick a viewport-anchored top-left position so the new card lands
    // inside whatever the user is currently looking at (rather than at
    // a flow-space origin that might be panned off-screen).
    let viewportRect: { originX: number; originY: number; width: number; height: number } | undefined;
    if (flowApi && flowEl) {
      const rect = flowEl.getBoundingClientRect();
      const vp = flowApi.getViewport?.();
      const zoom = vp?.zoom && vp.zoom > 0 ? vp.zoom : 1;
      viewportRect = {
        originX: vp ? -vp.x / zoom : 0,
        originY: vp ? -vp.y / zoom : 0,
        width: rect.width / zoom,
        height: rect.height / zoom,
      };
    }
    const pos = pickTimelordeDefaultPosition(viewportRect);
    const id = `timelorde-${crypto.randomUUID().slice(0, 8)}`;
    // Transactional re-check inside the same Yjs op: the snapshot we
    // read might be stale by a few ticks; a concurrent rack-mate could
    // have spawned a TIMELORDE in the meantime. Re-check inside the
    // transact closure to minimize the race window. (Yjs doesn't expose
    // a true conditional-insert primitive, so this is best-effort + the
    // engine's maxInstances=1 is the ultimate safety net.)
    ydoc.transact(() => {
      let alreadyHasTimelorde = false;
      for (const node of Object.values(patch.nodes)) {
        if (node && node.type === 'timelorde') {
          alreadyHasTimelorde = true;
          break;
        }
      }
      if (alreadyHasTimelorde) return;
      patch.nodes[id] = {
        id,
        type: 'timelorde',
        domain: 'audio',
        position: pos,
        params: {},
        data: { name: nextDefaultName(patch.nodes, 'timelorde') },
      };
    }, LOCAL_ORIGIN);
    didAutoSpawnTimelorde = true;
    trace(`auto-spawned TIMELORDE at (${pos.x}, ${pos.y}) — rack had none`);
  });

  // Mirror snapshot → SvelteFlow node/edge arrays. We DROPPED bind:nodes /
  // bind:edges in favor of one-way props because the two-way bind let
  // Svelte Flow's internal cache stomp our just-computed arrays after a
  // rapid clear→load sequence — the immediate trigger of the B3 bug.
  // Drag stops still flow back via onnodedragstop.
  let flowNodes = $state.raw<FlowNode[]>([]);
  let flowEdges = $state.raw<FlowEdge[]>([]);
  // Card hover state for the cable-dim affordance: tracks the id of the
  // currently-hovered .svelte-flow__node. Declared up here so the edges
  // mapping below can read it without forward-references.
  let hoveredNodeId = $state<string | null>(null);
  // Most-recently-spawned node id. We lift this node's z-index so it
  // visually renders on top of any cards it overlaps — matches the
  // user's "place under cursor + on top" expectation. Cleared when the
  // user drags or interacts with a different node so subsequent spawns
  // get a fresh slot. xyflow honors a `zIndex` field on Node directly.
  let topNodeId = $state<string | null>(null);

  // Module-grouping Phase 1 — build the "collapsed groups" filter once per
  // snapshot. A child node whose data.parentGroupId points at an existing,
  // non-expanded GROUP! is hidden from the canvas (its handles + cables
  // route through the group's exposed ports instead). The group node
  // itself is always rendered as a single GroupCard.
  let collapsedGroupIds = $derived.by<Set<string>>(() => {
    const ids = new Set<string>();
    for (const n of snapshot.nodes) {
      if (n.type !== 'group') continue;
      const expanded = (n.data as { expanded?: boolean } | undefined)?.expanded === true;
      if (!expanded) ids.add(n.id);
    }
    return ids;
  });

  // Module-grouping Phase 1 — quick map from child node → its collapsed
  // group id, for edge-filtering below. Built per snapshot, O(n).
  let nodeIdToCollapsedGroupId = $derived.by<Map<string, string>>(() => {
    const map = new Map<string, string>();
    const collapsed = collapsedGroupIds;
    for (const n of snapshot.nodes) {
      const parentGroupId = (n.data as { parentGroupId?: string } | undefined)?.parentGroupId;
      if (parentGroupId && collapsed.has(parentGroupId)) {
        map.set(n.id, parentGroupId);
      }
    }
    return map;
  });

  $effect(() => {
    const snap = snapshot;
    const top = topNodeId;
    const collapsed = collapsedGroupIds;
    const remoteByNode = remoteGroupBuildingByNode;
    const next: FlowNode[] = [];
    for (const n of snap.nodes) {
      // Skip children belonging to a collapsed group — the group card
      // stands in for them visually. Phase 2 will flip to inline-rendering
      // children when data.expanded === true on the parent group.
      const parentGroupId = (n.data as { parentGroupId?: string } | undefined)?.parentGroupId;
      if (parentGroupId && collapsed.has(parentGroupId)) continue;
      // CADILLAC renders as a roaming overlay sprite (CadillacOverlay),
      // not as a SvelteFlow card. Filter it out of the node array so
      // xyflow doesn't draw a fallback white box at the spawn point.
      if (n.type === 'cadillac') continue;
      const remoteUser = remoteByNode[n.id];
      const node: FlowNode = {
        id: n.id,
        type: n.type,
        // Per-user layouts: getNodePosition returns the user's override
        // (when in multiplayer) or falls back to n.position (when single-
        // user OR when this user has no entry yet).
        position: getNodePosition(ydoc, currentUserId, n.id, { x: n.position.x, y: n.position.y }),
        data: {
          node: n,
          // Phase 3C: when a remote rack-mate has this node in their
          // active group-builder selection, expose the user's identity
          // so the per-card overlay can render the soft-lock badge.
          ...(remoteUser ? { remoteGrouping: remoteUser } : {}),
        },
        // Mark the SvelteFlow node with a class our global CSS can dim
        // via opacity, without each card having to wire its own
        // remote-state branching.
        ...(remoteUser ? { className: 'remote-group-building' } : {}),
      };
      // Lift the most-recently-spawned node above its siblings so it's
      // visible immediately when it lands on top of an existing card.
      // xyflow's default node zIndex is 0; bumping to 1000 puts the new
      // card above everything without colliding with selected-node
      // styling (which xyflow handles internally via the .selected class
      // rather than a competing zIndex).
      if (top === n.id) node.zIndex = 1000;
      next.push(node);
    }
    flowNodes = next;
  });

  $effect(() => {
    const snap = snapshot;
    const hovered = hoveredNodeId;
    const childToGroup = nodeIdToCollapsedGroupId;
    const next: FlowEdge[] = [];
    for (const e of snap.edges) {
      // Skip edges whose endpoint references a hidden child (i.e. a
      // member of a collapsed group). Internal edges between two children
      // of the same group are hidden entirely; external edges to a single
      // hidden child get rewritten at create-group time to terminate on
      // the group's exposed port, so they'd already point at the group
      // node here. A leftover edge to a hidden child indicates a
      // pre-group-creation snapshot — defensive drop.
      if (childToGroup.has(e.source.nodeId) || childToGroup.has(e.target.nodeId)) continue;
      const related = !!hovered && (e.source.nodeId === hovered || e.target.nodeId === hovered);
      const edge: FlowEdge = {
        id: e.id,
        source: e.source.nodeId,
        sourceHandle: e.source.portId,
        target: e.target.nodeId,
        targetHandle: e.target.portId,
        style: `stroke: var(--cable-${e.sourceType}); stroke-width: 3;`,
      };
      if (related) edge.class = 'cable-related';
      next.push(edge);
    }
    flowEdges = next;
  });

  function trace(line: string) {
    console.log('[canvas]', line);
    log = [...log.slice(-7), line];
  }

  // (ensureEngine moved below the palette section so its types are colocated)

  /** "Load example": Sequencer → VCO + ADSR → VCA → Audio Out. Pre-populated
   *  with an 8-note motif. Sequencer auto-starts (isPlaying = 1). This is
   *  the only demo button — a quick way for a new user to hear the engine
   *  doing something musical without learning the patching UI first. */
  async function loadExample() {
    error = null;
    booting = true;
    try {
      await ensureEngine();
      ydoc.transact(() => {
        const nodes: Record<string, { type: string; position: { x: number; y: number }; params: Record<string, number>; data?: Record<string, unknown> }> = {
          'vd-seq':  { type: 'sequencer', position: { x: 40, y: 60 },   params: { bpm: 180, length: 8, isPlaying: 1, gateLength: 0.4 },
            data: { steps: [
              // C-major motif starting at C4 (MIDI 60).
              { on: true, midi: 60 },
              { on: true, midi: 67 },
              { on: true, midi: 72 },
              { on: true, midi: 67 },
              { on: true, midi: 64 },
              { on: true, midi: 60 },
              { on: true, midi: 65 },
              { on: true, midi: 67 },
              ...Array.from({ length: 24 }, () => ({ on: false, midi: null })),
            ] } },
          'vd-vco':  { type: 'analogVco', position: { x: 620, y: 30 },  params: {} },
          'vd-adsr': { type: 'adsr',      position: { x: 620, y: 320 }, params: { attack: 0.005, decay: 0.08, sustain: 0.3, release: 0.15 } },
          'vd-vca':  { type: 'vca',       position: { x: 920, y: 130 }, params: { base: 0, cvAmount: 1 } },
          'vd-out':  { type: 'audioOut',  position: { x: 1200, y: 130 }, params: { master: 0.4 } },
        };
        for (const [id, n] of Object.entries(nodes)) {
          if (!patch.nodes[id]) {
            const autoName = nextDefaultName(patch.nodes, n.type);
            const data = { ...(n.data ?? {}), name: autoName };
            patch.nodes[id] = { id, type: n.type, domain: 'audio', position: n.position, params: n.params, data };
          }
        }
        const wires: Array<[string, string, string, string, 'pitch' | 'gate' | 'audio' | 'cv']> = [
          ['vd-seq',  'pitch', 'vd-vco',  'pitch', 'pitch'],
          ['vd-seq',  'gate',  'vd-adsr', 'gate',  'gate'],
          ['vd-vco',  'sine',  'vd-vca',  'audio', 'audio'],
          ['vd-adsr', 'env',   'vd-vca',  'cv',    'cv'],
          ['vd-vca',  'audio', 'vd-out',  'L',     'audio'],
          ['vd-vca',  'audio', 'vd-out',  'R',     'audio'],
        ];
        for (const [src, srcPort, dst, dstPort, type] of wires) {
          const id = `e-${src}-${srcPort}-${dst}-${dstPort}`;
          if (!patch.edges[id]) {
            patch.edges[id] = {
              id,
              source: { nodeId: src, portId: srcPort },
              target: { nodeId: dst, portId: dstPort },
              sourceType: type,
              targetType: type,
            };
          }
        }
      });
      trace('voice demo in store; reconciler instantiating');
      await reconciler?.reconcile();
      trace('voice demo live — sequencer playing 8-note motif');
    } catch (err) {
      console.error(err);
      error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    } finally {
      booting = false;
    }
  }

  /** "moogafakkin System 35/55" — spawn a full Moog cabinet, positioned to
   *  mirror the real service-manual cabinet layout (two rows, left-to-right,
   *  non-overlapping). The geometry comes from the pure
   *  computeCabinetLayout() helper; we filter each placement through the
   *  live module registry (skipping any unregistered type) and write ALL
   *  the nodes in ONE Yjs transaction so the cabinet is a single undo step
   *  and a single multiplayer broadcast. nextDefaultName is recomputed per
   *  node AFTER the prior insert (it scans patch.nodes, which we've already
   *  mutated) so numbering stays unique across the batch. */
  async function spawnCabinet(system: '35' | '55') {
    error = null;
    booting = true;
    try {
      await ensureEngine();
      const placements = computeCabinetLayout(system);
      ydoc.transact(() => {
        for (const { type, x, y } of placements) {
          // Skip gracefully if a type isn't registered — don't crash the
          // whole cabinet over one missing module.
          if (!getModuleDef(type as Parameters<typeof getModuleDef>[0])) continue;
          const id = `${type}-${crypto.randomUUID().slice(0, 8)}`;
          const autoName = nextDefaultName(patch.nodes, type as Parameters<typeof nextDefaultName>[1]);
          patch.nodes[id] = {
            id,
            type,
            domain: 'audio',
            position: { x, y },
            params: {},
            data: { name: autoName },
          };
        }
      }, LOCAL_ORIGIN);
      trace(`spawned moogafakkin System ${system} cabinet (${placements.length} modules)`);
      await reconciler?.reconcile();
    } catch (err) {
      console.error(err);
      error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    } finally {
      booting = false;
    }
  }

  /** GLITCHES GET RICHES — load the bundled video+audio demo envelope
   *  from packages/web/src/lib/ui/example-patches/glitches.imp.json.
   *  Mirrors loadExample()'s ensureEngine → load → reconcile shape;
   *  the envelope's PICTUREBOX node carries glitch.jpg as `data.imageBytes`
   *  so it renders on mount with no extra wiring.
   *
   *  Unlike the retired Visit-Atlantis loader (which built nodes + edges
   *  inline) this loader replays a real Yjs envelope through the
   *  canonical persistence path — same code as the Load button. */
  async function loadGlitches() {
    error = null;
    booting = true;
    try {
      await ensureEngine();
      const { loadGlitches: doLoad } = await import('$lib/ui/example-patches/glitches');
      const result = doLoad(ydoc, patch);
      trace(`GLITCHES patch in store (${result.nodesLoaded} nodes, ${result.edgesLoaded} edges); reconciler instantiating`);
      await reconciler?.reconcile();
      trace('GLITCHES live — picturebox showing glitch.jpg');
    } catch (err) {
      console.error(err);
      error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    } finally {
      booting = false;
    }
  }

  /** MEDIA BURN — homage to Ant Farm's 1975 piece. Loads 15 PICTUREBOX
   *  tiles reassembling the iconic Cadillac-into-TVs photo, plus a
   *  CADILLAC positioned to demolish the rightmost column ~1s after
   *  load. Same shape as loadGlitches: envelope → loadEnvelopeIntoStore.
   *
   *  Determinism: the envelope's CADILLAC node has NO spawnedAtMs, so
   *  the overlay's `?? Date.now()` fallback makes load-time === spawn-
   *  time. The 1-second-to-first-hit math (see media-burn-math.ts) holds
   *  every load, in single-user AND multiplayer modes. */
  async function loadMediaBurn() {
    error = null;
    booting = true;
    try {
      await ensureEngine();
      const { loadMediaBurn: doLoad } = await import('$lib/ui/example-patches/media-burn');
      const result = doLoad(ydoc, patch);
      trace(`MEDIA BURN patch in store (${result.nodesLoaded} nodes, ${result.edgesLoaded} edges); reconciler instantiating`);
      await reconciler?.reconcile();
      trace('MEDIA BURN live — 15 PICTUREBOX tiles + CADILLAC armed');
    } catch (err) {
      console.error(err);
      error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    } finally {
      booting = false;
    }
  }

  function clearPatch() {
    ydoc.transact(() => {
      for (const id of Object.keys(patch.edges)) delete patch.edges[id];
      for (const id of Object.keys(patch.nodes)) delete patch.nodes[id];
    });
    // No defensive flowNodes=[] anymore: B3's snapshot bus pushes the
    // empty snapshot to this $effect synchronously on the same Yjs
    // update, and SvelteFlow now consumes a one-way `nodes` prop so it
    // can't stomp the assignment.
    trace('cleared patch');
  }

  function savePatch() {
    const input = window.prompt('Save patch as…', DEFAULT_FILENAME);
    if (input === null) {
      trace('save cancelled');
      return;
    }
    const filename = sanitizeFilename(input);
    const env = makeEnvelope(ydoc);
    downloadEnvelope(env, filename);
    trace(`saved patch as ${filename} (${Object.keys(patch.nodes).length} nodes, ${Object.keys(patch.edges).length} edges)`);
  }

  async function loadPatch() {
    error = null;
    try {
      // Bootstrap engine + reconciler from inside the click handler so that
      // (a) the AudioContext resumes via this user gesture, and (b) a
      // reconciler exists to observe the Yjs update applied by
      // pickAndLoadEnvelope. Without this, loading a patch as the user's
      // first action would silently apply the update with nothing to
      // materialize the engine nodes — audio plays only ~50% of the time
      // depending on whether the user had previously bootstrapped via
      // Load example. Mirrors loadExample()'s ensureEngine + reconcile shape.
      await ensureEngine();
      const result = await pickAndLoadEnvelope(ydoc, patch);
      if (!result) {
        trace('load cancelled');
        return;
      }
      // Force a synchronous reconcile pass instead of trusting the
      // doc.on('update') microtask scheduler — same reason loadExample does it.
      await reconciler?.reconcile();
      trace(`loaded patch (${result.nodesLoaded} nodes, ${result.edgesLoaded} edges)`);
      if (result.diagnostics.length > 0) {
        for (const d of result.diagnostics) {
          console.warn(`[load] ${d.nodeId} (${d.type}): ${d.reason}`);
        }
      }
    } catch (e) {
      const msg = e instanceof EnvelopeParseError ? e.message : String(e);
      error = `Load failed: ${msg}`;
      trace(`load failed: ${msg}`);
    }
  }

  // ---------------- Save / Load Local Performance ----------------
  //
  // A "performance slot" is a named snapshot of the WHOLE track stored in this
  // browser's IndexedDB. The bundle is a superset of the patch envelope:
  //   * patch graph + edges + params + module positions + INLINE PICTUREBOX
  //     images + INLINE SAMSLOOP samples — all already in the envelope (free).
  //   * VIDEOBOX video files — NOT inlined. Their FileSystemFileHandles already
  //     persist in the existing video-handle IDB store (PR #102), keyed by the
  //     `fileMeta.handleId` that's saved in the envelope. So on the SAME browser
  //     profile, reloading the bundle re-applies the envelope, each VideoboxCard
  //     re-acquires its handle by handleId and shows the one-click "re-allow"
  //     (Chromium) — the video comes back. We record asset refs in the bundle
  //     for the picker summary + future cross-profile guided re-pick.
  //   * MIDI Learn CC maps (device-agnostic) + MIDI-CV-BUDDY device-by-NAME +
  //     gamepad-by-id metadata — see performance-bundle.ts.
  //
  // Browser support: IndexedDB-gated. Degrades gracefully — the buttons show a
  // notice (not a hard fail) where File System Access is absent (Firefox/Safari):
  // the patch + inline assets still restore; only the video files need a manual
  // re-pick via the existing VIDEOBOX re-link prompt.

  let perfSupported = $derived(canPersistPerformances());

  /** Resolve a MIDIInput.id → {name, manufacturer} from the live MIDIAccess,
   *  if one has been granted. Best-effort: returns null when Web MIDI isn't
   *  available / not yet granted (device metadata is then simply omitted). */
  async function resolveMidiDevices(): Promise<(id: string) => { name: string; manufacturer?: string } | null> {
    try {
      const nav = navigator as unknown as { requestMIDIAccess?: (o?: unknown) => Promise<{ inputs: Map<string, { name?: string | null; manufacturer?: string | null }> }> };
      if (typeof nav.requestMIDIAccess !== 'function') return () => null;
      const access = await nav.requestMIDIAccess({ sysex: false });
      return (id: string) => {
        const inp = access.inputs.get(id);
        if (!inp || !inp.name) return null;
        return { name: inp.name, manufacturer: inp.manufacturer ?? undefined };
      };
    } catch {
      return () => null;
    }
  }

  /** Resolve a gamepad slot index → connected gamepad.id, or null. */
  function resolveGamepad(slot: number): string | null {
    try {
      const pads = typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function'
        ? navigator.getGamepads()
        : [];
      return pads?.[slot]?.id ?? null;
    } catch {
      return null;
    }
  }

  async function savePerformance() {
    error = null;
    if (!perfSupported) {
      error = 'Save Local Performance needs IndexedDB (not available in this browser).';
      return;
    }
    // Show how many slots are used so the user knows they're approaching the
    // per-browser cap before they type a name. Best-effort — listing failures
    // shouldn't block the save.
    let usedCount = 0;
    try { usedCount = (await listPerformanceSlots()).length; } catch { /* */ }
    const input = window.prompt(
      `Save Local Performance as…\n(${usedCount}/${MAX_PERFORMANCES} slots used)`,
      'My Performance',
    );
    if (input === null) {
      trace('save performance cancelled');
      return;
    }
    const name = input.trim();
    if (!name) {
      error = 'Performance name cannot be empty.';
      return;
    }
    try {
      // Portable snapshot: bake THIS user's displayed positions into
      // node.position + drop the per-user layouts map, so the performance loads
      // with correct placement for any future loader (incl. a different user or
      // single-user reload). In single-user mode currentUserId is undefined and
      // this is equivalent to makeEnvelope (positions are already canonical).
      const envelope = makePortableEnvelope(ydoc, currentUserId);
      // Build the live node map (plain objects) for asset/device extraction.
      const nodes: Record<string, { id: string; type: string; data?: Record<string, unknown> | null; params?: Record<string, unknown> | null }> = {};
      for (const [id, n] of Object.entries(patch.nodes)) {
        if (n) nodes[id] = { id, type: n.type, data: n.data as Record<string, unknown> | null, params: n.params as Record<string, unknown> | null };
      }
      const resolveMidi = await resolveMidiDevices();
      const bundle = makePerformanceBundle({
        envelope,
        nodes,
        midiBindings: exportMidiBindings(),
        resolveMidiDevice: resolveMidi,
        resolveGamepad,
      });
      const res = await savePerformanceSlot(name, bundle);
      if (!res.ok) {
        if (res.reason === 'cap') {
          error = `You have reached the ${res.cap ?? MAX_PERFORMANCES}-performance cap. Delete one from the Load menu first.`;
        } else {
          error = 'Could not save the performance (storage unavailable or full).';
        }
        return;
      }
      const videoCount = bundle.assets.length;
      trace(`saved performance "${name}" (${Object.keys(nodes).length} nodes, ${videoCount} video assets)`);
      if (videoCount > 0) {
        error = `Saved "${name}". On reload, click each VIDEOBOX's "re-allow" to bring the ${videoCount} video file${videoCount === 1 ? '' : 's'} back (same browser profile).`;
      }
    } catch (e) {
      error = `Save Performance failed: ${e instanceof Error ? e.message : String(e)}`;
      trace(`save performance failed: ${String(e)}`);
    }
  }

  async function loadPerformance() {
    error = null;
    if (!perfSupported) {
      error = 'Load Local Performance needs IndexedDB (not available in this browser).';
      return;
    }
    try {
      const slots = await listPerformanceSlots();
      if (slots.length === 0) {
        error = 'No saved performances found in this browser.';
        return;
      }
      // Minimal picker: numbered prompt (no new modal component to keep the
      // MVP small + testable). Newest-first. Type `N` to load, `dN` to
      // delete slot N (e.g. `d3`). The slot cap is enforced at save time.
      const menu = slots
        .map((s, i) => `${i + 1}. ${s.name}${s.assetCount ? ` (${s.assetCount} video${s.assetCount === 1 ? '' : 's'})` : ''}`)
        .join('\n');
      const pick = window.prompt(
        `Load which performance? (${slots.length}/${MAX_PERFORMANCES} slots used)\n\n${menu}\n\nEnter a number to LOAD, or "dN" (e.g. d3) to DELETE slot N:`,
        '1',
      );
      if (pick === null) {
        trace('load performance cancelled');
        return;
      }
      const raw = pick.trim();
      const delMatch = /^d\s*(\d+)$/i.exec(raw);
      if (delMatch) {
        const dIdx = Number.parseInt(delMatch[1]!, 10) - 1;
        const target = slots[dIdx];
        if (!target) {
          error = `No performance #${delMatch[1]} to delete.`;
          return;
        }
        const confirmed = window.confirm(`Delete performance "${target.name}"? This cannot be undone.`);
        if (!confirmed) {
          trace('delete performance cancelled');
          return;
        }
        await deletePerformanceSlot(target.name);
        trace(`deleted performance "${target.name}"`);
        return;
      }
      const idx = Number.parseInt(raw, 10) - 1;
      const chosen = slots[idx];
      if (!chosen) {
        error = `No performance #${raw}.`;
        return;
      }

      const rec = await loadPerformanceSlot(chosen.name);
      if (!rec) {
        error = `Performance "${chosen.name}" could not be read.`;
        return;
      }
      const bundle = validateBundle(rec.bundle);

      // Bootstrap engine + reconciler inside this gesture (same reason as
      // loadPatch): resume AudioContext + have a reconciler observe the update.
      await ensureEngine();

      // Restore MIDI Learn CC maps (device-agnostic; merge so other patches'
      // bindings aren't clobbered). Done BEFORE applying the envelope so cards
      // re-register their setters against the restored bindings on mount.
      if (bundle.midiBindings.length > 0) {
        const merged = mergeMidiBindings(exportMidiBindings(), bundle.midiBindings);
        importMidiBindings(merged);
      }

      // Apply the patch envelope — restores nodes/edges/params/positions +
      // inline images/samples. Each VIDEOBOX card then re-acquires its video
      // handle by handleId (same-profile) on mount and offers the re-allow /
      // re-link prompt automatically (PR #102 path).
      const result = persistenceLoad(bundle.patch, ydoc, patch);
      await reconciler?.reconcile();

      trace(`loaded performance "${chosen.name}" (${result.nodesLoaded} nodes, ${result.edgesLoaded} edges)`);

      // Surface device re-bind status as a notice (not an error).
      const notes: string[] = [];
      if (bundle.assets.length > 0) {
        notes.push(`${bundle.assets.length} video file${bundle.assets.length === 1 ? '' : 's'}: click each VIDEOBOX "re-allow" to relink.`);
      }
      if (bundle.midiDevices.length > 0) {
        notes.push(`${bundle.midiDevices.length} MIDI device${bundle.midiDevices.length === 1 ? '' : 's'} recorded by name — open each MIDI-CV-BUDDY and pick the controller if not auto-selected.`);
      }
      if (result.diagnostics.length > 0) {
        for (const d of result.diagnostics) console.warn(`[load-perf] ${d.nodeId} (${d.type}): ${d.reason}`);
      }
      if (notes.length > 0) error = `Loaded "${chosen.name}". ${notes.join(' ')}`;
    } catch (e) {
      const msg = e instanceof BundleParseError || e instanceof EnvelopeParseError ? e.message : String(e);
      error = `Load Performance failed: ${msg}`;
      trace(`load performance failed: ${msg}`);
    }
  }

  // ---------------- Mirror Svelte Flow events back to the patch graph ----------------

  /** User dragged a connection between two handles. Create an edge in the patch.
   *  Behavior: an input accepts only ONE connection at a time — patching onto an
   *  occupied input replaces the existing edge. Outputs may fan out to many. */
  function handleConnect(connection: Connection) {
    // Drag committed — release any drag-induced PatchPanel lock.
    connectDragState.end();
    if (!connection.source || !connection.target) return;
    if (!connection.sourceHandle || !connection.targetHandle) return;

    const srcNode = patch.nodes[connection.source];
    const dstNode = patch.nodes[connection.target];
    if (!srcNode || !dstNode) return;

    // Group endpoints — exposed-port handles stand in for a child {nodeId,
    // portId}. The Yjs edge is stored with the group node + exposed handle
    // (so the canvas keeps rendering the cable at the group's boundary);
    // projectGroups() rewrites the endpoints to the child before the
    // reconciler runs. For cable-type resolution we read the exposed
    // port's declared cableType so the engine's resolveConnection picks
    // the correct splitter/merger/bridge plan when the underlying child
    // is e.g. video while the cable started life as audio.
    const srcExposed = resolveExposedPort(srcNode, connection.sourceHandle);
    const dstExposed = resolveExposedPort(dstNode, connection.targetHandle);

    // Phase 0 video spike: a node may belong to either domain registry.
    // Try audio first (the common case), fall back to video. Meta (group)
    // is handled above via resolveExposedPort, so a missing def here only
    // disqualifies a non-meta non-group node — those genuinely can't host
    // a connection.
    const srcDef = getModuleDef(srcNode.type) ?? getVideoModuleDef(srcNode.type);
    const dstDef = getModuleDef(dstNode.type) ?? getVideoModuleDef(dstNode.type);
    if (!srcExposed && !srcDef) return;
    if (!dstExposed && !dstDef) return;

    const srcPort = srcDef?.outputs.find((p) => p.id === connection.sourceHandle);
    const dstPort = dstDef?.inputs.find((p) => p.id === connection.targetHandle);
    const sourceType: CableType = srcExposed?.cableType ?? srcPort?.type ?? 'audio';
    const targetType: CableType = dstExposed?.cableType ?? dstPort?.type ?? sourceType;

    const id = `e-${connection.source}-${connection.sourceHandle}-${connection.target}-${connection.targetHandle}`;
    if (patch.edges[id]) return;

    ydoc.transact(() => {
      // Replace any existing edge targeting the same input.
      for (const [edgeId, edge] of Object.entries(patch.edges)) {
        if (
          edge &&
          edge.target.nodeId === connection.target &&
          edge.target.portId === connection.targetHandle
        ) {
          delete patch.edges[edgeId];
        }
      }
      patch.edges[id] = {
        id,
        source: { nodeId: connection.source!, portId: connection.sourceHandle! },
        target: { nodeId: connection.target!, portId: connection.targetHandle! },
        sourceType,
        targetType,
      };
    }, LOCAL_ORIGIN);
    trace(`connect ${connection.source}.${connection.sourceHandle} → ${connection.target}.${connection.targetHandle}`);
  }

  /** When the user starts dragging FROM an input handle, immediately detach any
   *  existing cable on that input. Lets you grab a patched input and rewire it
   *  somewhere else with one motion. */
  function handleConnectStart(_event: MouseEvent | TouchEvent, params: { nodeId: string | null; handleId: string | null; handleType: 'source' | 'target' | null }) {
    // Mark a connect-drag in flight — PatchPanels opened during this drag
    // will lock open until handleConnect / handleConnectEnd fires.
    connectDragState.begin();
    if (params.handleType !== 'target') return;
    if (!params.nodeId || !params.handleId) return;
    let removed = 0;
    ydoc.transact(() => {
      for (const [edgeId, edge] of Object.entries(patch.edges)) {
        if (
          edge &&
          edge.target.nodeId === params.nodeId &&
          edge.target.portId === params.handleId
        ) {
          delete patch.edges[edgeId];
          removed++;
        }
      }
    }, LOCAL_ORIGIN);
    if (removed > 0) trace(`detached cable from ${params.nodeId}.${params.handleId} (rewiring)`);
  }

  /** Cable drag finished — committed-or-not. Always release the drag-
   *  induced PatchPanel lock so the locked panel can resume normal
   *  hover-intent behaviour. */
  function handleConnectEnd() {
    connectDragState.end();
  }

  /** User clicked a handle without dragging past the connectionDragThreshold.
   *  Svelte Flow stores the source handle internally (clickConnectStartHandle)
   *  and will commit on the next handle click. We mirror that into our
   *  pickup state so PatchPanel locks + section expand-all engage the
   *  same way they do for a drag — and so the canvas can render a ghost
   *  cable from the source port to the cursor. Touchscreen-friendly
   *  alternative to the press-drag-release gesture. */
  function handleClickConnectStart(
    _event: MouseEvent | TouchEvent,
    params: { nodeId: string | null; handleId: string | null; handleType: 'source' | 'target' | null },
  ) {
    if (!params.nodeId || !params.handleId || !params.handleType) return;
    // Resolve cable type for compatibility filtering on the commit click.
    const node = patch.nodes[params.nodeId];
    const def = node ? defLookup(node.type) : undefined;
    let cableType: string | undefined;
    if (def) {
      const port =
        params.handleType === 'source'
          ? def.outputs.find((p) => p.id === params.handleId)
          : def.inputs.find((p) => p.id === params.handleId);
      cableType = port?.type as string | undefined;
    }
    connectDragState.pickup({
      nodeId: params.nodeId,
      portId: params.handleId,
      handleType: params.handleType,
      cableType,
    });
    // If this is a target-side pickup, immediately detach any cable already
    // on this input — same one-motion-rewire behaviour as drag-start.
    if (params.handleType === 'target') {
      let removed = 0;
      ydoc.transact(() => {
        for (const [edgeId, edge] of Object.entries(patch.edges)) {
          if (
            edge &&
            edge.target.nodeId === params.nodeId &&
            edge.target.portId === params.handleId
          ) {
            delete patch.edges[edgeId];
            removed++;
          }
        }
      }, LOCAL_ORIGIN);
      if (removed > 0) trace(`detached cable from ${params.nodeId}.${params.handleId} (pickup-rewire)`);
    }
    trace(`pickup-start ${params.nodeId}.${params.handleId}`);
  }

  /** Click-connect committed (user clicked a compatible target handle) OR
   *  the click-connect was abandoned by xyflow's internal logic. Either
   *  way clear pickup state. */
  function handleClickConnectEnd() {
    connectDragState.cancelPickup();
  }

  /** Svelte Flow deleted nodes/edges (Backspace on selection). Mirror to patch. */
  function handleDelete(payload: { nodes: FlowNode[]; edges: FlowEdge[] }) {
    if (payload.nodes.length === 0 && payload.edges.length === 0) return;
    ydoc.transact(() => {
      for (const e of payload.edges) {
        if (patch.edges[e.id]) delete patch.edges[e.id];
      }
      for (const n of payload.nodes) {
        if (patch.nodes[n.id]) delete patch.nodes[n.id];
        // Also drop any edges that referenced the deleted node.
        for (const [edgeId, edge] of Object.entries(patch.edges)) {
          if (edge && (edge.source.nodeId === n.id || edge.target.nodeId === n.id)) {
            delete patch.edges[edgeId];
          }
        }
      }
    }, LOCAL_ORIGIN);
    if (topNodeId && payload.nodes.some((n) => n.id === topNodeId)) {
      topNodeId = null;
    }
    trace(`deleted ${payload.nodes.length} node(s), ${payload.edges.length} edge(s)`);
  }

  /** User finished dragging one or more module cards. Persist new positions.
   *
   *  Multi-user mode (currentUserId defined): writes to layouts[userId][nodeId]
   *  via setNodePosition. Other users do NOT see the move.
   *
   *  Single-user mode (currentUserId undefined): writes to the shared
   *  node.position so a single-tab user sees layout persisted across
   *  reloads. (No-op for layouts since the helper short-circuits on
   *  undefined userId.) */
  function handleNodeDragStop({ targetNode, nodes }: { targetNode: FlowNode | null; nodes: FlowNode[] }) {
    const moved = nodes.length > 0 ? nodes : targetNode ? [targetNode] : [];
    if (moved.length === 0) return;
    // Drag of any other node clears the spawn-on-top hint — natural
    // stacking-by-DOM-order resumes for the next overlap interaction.
    if (topNodeId && !moved.some((n) => n.id === topNodeId)) {
      topNodeId = null;
    }
    ydoc.transact(() => {
      for (const n of moved) {
        if (currentUserId) {
          // Multi-user: write to per-user layout map only.
          setNodePosition(ydoc, currentUserId, n.id, { x: n.position.x, y: n.position.y });
        } else {
          // Single-user: write to the shared node.position (preserves
          // backward compat with patches saved pre-layouts-split).
          const target = patch.nodes[n.id];
          if (target) {
            target.position = { x: n.position.x, y: n.position.y };
          }
        }
      }
    }, LOCAL_ORIGIN);
  }

  // ---------------- Module-add palette ----------------

  let paletteOpen = $state(false);
  let palettePos = $state({ x: 0, y: 0 });
  let spawnFlowPos = $state({ x: 0, y: 0 });
  // The FlowBridge child of <SvelteFlow> calls useSvelteFlow() (which needs
  // the xyflow context) and assigns its API here. We use it to convert the
  // right-click client-space coords to flow-space coords so a spawned module
  // anchors at the click point regardless of pan/zoom.
  let flowApi = $state<FlowBridgeApi | null>(null);

  /** Right-click on canvas pane → open palette at cursor; spawn at that flow pos. */
  function onPaneContextMenu({ event }: { event: MouseEvent | TouchEvent }) {
    event.preventDefault();
    const me = event as MouseEvent;
    palettePos = { x: me.clientX, y: me.clientY };
    spawnFlowPos = flowApi
      ? flowApi.screenToFlowPosition({ x: me.clientX, y: me.clientY })
      : { x: me.clientX, y: me.clientY };
    paletteOpen = true;
  }

  /** Topbar button → open palette near top-left, spawn at canvas origin-ish. */
  function openPaletteFromButton() {
    palettePos = { x: 80, y: 60 };
    spawnFlowPos = flowApi
      ? flowApi.screenToFlowPosition({ x: 200, y: 200 })
      : { x: 200, y: 200 };
    paletteOpen = true;
  }

  // ---------------- Node right-click context menu ----------------

  let ctxMenuOpen = $state(false);
  let ctxMenuPos = $state({ x: 0, y: 0 });
  let ctxMenuNodeId = $state<string | null>(null);
  let ctxMenuLabel = $derived.by(() => {
    void snapshot; // recompute when graph changes
    if (!ctxMenuNodeId) return '';
    const n = patch.nodes[ctxMenuNodeId];
    if (!n) return '';
    return getModuleDef(n.type)?.label ?? n.type;
  });
  let ctxMenuNodeType = $derived.by<string | null>(() => {
    void snapshot;
    if (!ctxMenuNodeId) return null;
    const n = patch.nodes[ctxMenuNodeId];
    return n?.type ?? null;
  });
  // Module-grouping Phase 2A — track whether the right-clicked group is
  // currently expanded so the menu can label the toggle appropriately.
  let ctxMenuGroupExpanded = $derived.by<boolean>(() => {
    void snapshot;
    if (!ctxMenuNodeId) return false;
    const n = patch.nodes[ctxMenuNodeId];
    if (!n || n.type !== 'group') return false;
    return (n.data as { expanded?: boolean } | undefined)?.expanded === true;
  });

  // SNES9X — the right-clicked node is a snes9x with a ROM loaded → offer
  // the "see output definition for CV/GATES" menu item. The ROM-loaded check
  // reads the engine extras; defaults to false when the engine/extras aren't
  // available (the item just doesn't show).
  let ctxMenuCanSeeSnesOutputDef = $derived.by<boolean>(() => {
    void snapshot;
    if (!ctxMenuNodeId || ctxMenuNodeType !== 'snes9x') return false;
    const n = patch.nodes[ctxMenuNodeId];
    if (!n || !engine) return false;
    try {
      const extras = engine.read(n, 'extras') as { romLoaded?: () => boolean } | undefined;
      return extras?.romLoaded?.() === true;
    } catch {
      return false;
    }
  });

  function onNodeContextMenu({ event, node }: { event: MouseEvent | TouchEvent; node: FlowNode }) {
    event.preventDefault();
    // A right-click INSIDE the TOYBOX in-card combine-graph SVG is handled by
    // that editor's own contextual menu (ToyboxNodeMenu). Don't also open the
    // generic module menu for it — belt-and-suspenders against the capture-phase
    // event race (the SVG's element-level stopImmediatePropagation can't undo a
    // document/xyflow listener that already fired earlier in the path).
    if ((event.target as Element | null)?.closest?.('[data-testid="toybox-graph-svg"]')) return;
    const me = event as MouseEvent;
    ctxMenuPos = { x: me.clientX, y: me.clientY };
    ctxMenuNodeId = node.id;
    ctxMenuOpen = true;
  }

  // ---------------- Lasso group-select (right-click → Create group) --------
  //
  // SvelteFlow defaults restored: left-drag empty canvas pans (no marquee).
  // Grouping discovery now flows through the pane context menu:
  //   1. right-click empty pane → ModulePalette opens (existing flow)
  //   2. user clicks "Create group" tool entry → lasso mode engages
  //   3. cursor drags a bounding-box; nodes inside are previewed-selected
  //   4. right-click (or left-click) commits → GroupBuilderModal opens
  //   5. Esc cancels silently
  //
  // State lives in flow-space coords so pan/zoom mid-lasso keeps the box
  // anchored to the original click point. The overlay maps back to screen
  // px each render via flowApi.flowToScreenPosition.
  let lassoMode = $state(false);
  let lassoOriginFlow = $state<{ x: number; y: number } | null>(null);
  let lassoCursorFlow = $state<{ x: number; y: number } | null>(null);
  let lassoOriginScreen = $state<{ x: number; y: number }>({ x: 0, y: 0 });
  let lassoCursorScreen = $state<{ x: number; y: number }>({ x: 0, y: 0 });
  let lassoHitIds = $state<string[]>([]);

  function enterLassoMode(originClientX: number, originClientY: number) {
    if (!flowApi) return;
    const flowPt = flowApi.screenToFlowPosition({ x: originClientX, y: originClientY });
    lassoOriginFlow = flowPt;
    lassoCursorFlow = flowPt;
    lassoOriginScreen = { x: originClientX, y: originClientY };
    lassoCursorScreen = { x: originClientX, y: originClientY };
    lassoHitIds = [];
    lassoMode = true;
  }

  function exitLassoMode() {
    lassoMode = false;
    lassoOriginFlow = null;
    lassoCursorFlow = null;
    lassoHitIds = [];
  }

  function recomputeLassoHits(): void {
    if (!lassoOriginFlow || !lassoCursorFlow || !flowApi) {
      lassoHitIds = [];
      return;
    }
    const x1 = Math.min(lassoOriginFlow.x, lassoCursorFlow.x);
    const y1 = Math.min(lassoOriginFlow.y, lassoCursorFlow.y);
    const x2 = Math.max(lassoOriginFlow.x, lassoCursorFlow.x);
    const y2 = Math.max(lassoOriginFlow.y, lassoCursorFlow.y);
    const hits: string[] = [];
    for (const n of flowApi.getNodes()) {
      const w =
        (n as FlowNode & { measured?: { width?: number; height?: number } })
          .measured?.width ?? (n as FlowNode & { width?: number }).width ?? 0;
      const h =
        (n as FlowNode & { measured?: { width?: number; height?: number } })
          .measured?.height ?? (n as FlowNode & { height?: number }).height ?? 0;
      const nx1 = n.position.x;
      const ny1 = n.position.y;
      const nx2 = nx1 + w;
      const ny2 = ny1 + h;
      const overlap = !(nx2 < x1 || nx1 > x2 || ny2 < y1 || ny1 > y2);
      if (overlap) hits.push(n.id);
    }
    lassoHitIds = hits;
  }

  $effect(() => {
    if (!lassoMode) return;
    const onMove = (e: PointerEvent) => {
      if (!flowApi) return;
      lassoCursorScreen = { x: e.clientX, y: e.clientY };
      lassoCursorFlow = flowApi.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      recomputeLassoHits();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        exitLassoMode();
      }
    };
    const commit = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const ids = lassoHitIds.slice();
      exitLassoMode();
      if (ids.length < 2) return;
      selCtxMenuIds = ids;
      openGroupBuilder();
    };
    const onContextMenu = (e: MouseEvent) => { commit(e); };
    const onClick = (e: MouseEvent) => { commit(e); };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('contextmenu', onContextMenu, true);
    window.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('contextmenu', onContextMenu, true);
      window.removeEventListener('click', onClick, true);
    };
  });

  // Re-anchor the overlay's screen-space origin whenever flow-space coords
  // or viewport transform change. Keeps the rectangle glued to its initial
  // click point even while the user pans/zooms mid-lasso.
  $effect(() => {
    if (!lassoMode || !flowApi || !lassoOriginFlow) return;
    lassoOriginScreen = flowApi.flowToScreenPosition(lassoOriginFlow);
  });

  // Live highlight preview: mirror lassoHitIds → DOM classes on flow nodes.
  $effect(() => {
    if (!flowEl) return;
    const root = flowEl.querySelector('.svelte-flow');
    if (!root) return;
    const prev = root.querySelectorAll('.svelte-flow__node.lasso-hit');
    prev.forEach((el) => el.classList.remove('lasso-hit'));
    if (!lassoMode) return;
    for (const id of lassoHitIds) {
      const el = root.querySelector(`.svelte-flow__node[data-id="${id}"]`);
      if (el) el.classList.add('lasso-hit');
    }
  });

  // ---------------- Module-grouping Phase 1 ----------------
  //
  // Marquee-selection right-click → SelectionContextMenu (single item:
  // "Group modules…") → GroupBuilderModal (table of all ports across
  // the selection, pre-checked for cables crossing the boundary) →
  // "Create group" → planCreateGroup + ydoc.transact.
  //
  // The group is a meta-domain card with no engine binding; the
  // snapshot-projection layer (group-projection.ts) rewrites edge
  // endpoints from the group's exposed ports → the real child ports
  // before the reconciler runs. See packages/web/src/lib/graph/group-projection.ts.

  let selCtxMenuOpen = $state(false);
  let selCtxMenuPos = $state({ x: 0, y: 0 });
  let selCtxMenuIds = $state<string[]>([]);

  let groupBuilderOpen = $state(false);
  let groupBuilderCandidates = $state<PortCandidate[]>([]);
  let groupBuilderSelectionIds = $state<string[]>([]);
  let groupBuilderModuleLabels = $state<Map<string, string>>(new Map());

  // ---------------- Module-grouping Phase 3C — soft-lock via Y.Awareness ----
  //
  // When the local user opens the group builder, broadcast the selection
  // ids so remote rack-mates can dim those cards + badge them. Remote
  // peers' selections likewise flow IN here so we can disable our own
  // "Group modules…" action when any of our marquee selection overlaps
  // theirs. The actual rendering of the dim+badge is in AwarenessLayer
  // (Phase 3C consumes the indexRemoteGroupBuildingByNode helper output).
  let remoteGroupBuilders = $state<RemoteGroupBuilding[]>([]);
  $effect(() => {
    const p = provider;
    if (!p) {
      remoteGroupBuilders = [];
      return;
    }
    const awareness = p.awareness;
    if (!awareness) return;
    const refresh = () => {
      remoteGroupBuilders = readRemoteGroupBuilding(awareness, awareness.clientID);
    };
    refresh();
    awareness.on('change', refresh);
    awareness.on('update', refresh);
    return () => {
      awareness.off('change', refresh);
      awareness.off('update', refresh);
    };
  });
  let remoteGroupBuildingByNode = $derived<Record<string, PresenceUser>>(
    indexRemoteGroupBuildingByNode(remoteGroupBuilders),
  );
  // Sync the local user's group-builder selection out to peers whenever
  // the modal opens/closes/changes selection. Clearing on close uses
  // setLocalGroupBuildingSelection(null).
  $effect(() => {
    if (groupBuilderOpen && groupBuilderSelectionIds.length > 0) {
      setLocalGroupBuildingSelection(provider, groupBuilderSelectionIds);
    } else {
      setLocalGroupBuildingSelection(provider, null);
    }
  });

  function onSelectionContextMenu({ nodes, event }: { nodes: FlowNode[]; event: MouseEvent }) {
    event.preventDefault();
    const me = event as MouseEvent;
    selCtxMenuPos = { x: me.clientX, y: me.clientY };
    selCtxMenuIds = nodes.map((n) => n.id);
    selCtxMenuOpen = true;
  }

  /** Phase 3C — derive the displayName of any remote rack-mate whose
   *  group-builder selection currently overlaps the local marquee.
   *  Drives the SelectionContextMenu's lockedByRemote prop so user B
   *  sees "Alice is grouping…" instead of "Group modules…" when Alice
   *  is already in the middle of grouping any of those same nodes. */
  let selCtxMenuLockedByRemote = $derived.by<string | undefined>(() => {
    if (selCtxMenuIds.length === 0) return undefined;
    if (!overlapsRemoteGroupBuilding(selCtxMenuIds, remoteGroupBuilders)) return undefined;
    for (const id of selCtxMenuIds) {
      const u = remoteGroupBuildingByNode[id];
      if (u) return u.displayName;
    }
    return undefined;
  });

  function openGroupBuilder() {
    // Skip any selected nodes that are themselves groups or stickies —
    // Phase 1 doesn't nest groups; meta-domain non-port cards can't be
    // grouped meaningfully (sticky has no ports).
    const eligible = selCtxMenuIds.filter((id) => {
      const n = patch.nodes[id];
      if (!n) return false;
      if (n.type === 'group' || n.type === 'sticky') return false;
      return true;
    });
    if (eligible.length < 2) {
      trace(`group refused: only ${eligible.length} eligible module(s) selected`);
      return;
    }
    // Phase 3C soft-lock: if any of our eligible nodes intersects a
    // remote user's active group-builder selection, refuse to open the
    // modal. Two users would otherwise race-create overlapping groups.
    if (overlapsRemoteGroupBuilding(eligible, remoteGroupBuilders)) {
      const overlap = eligible.find((id) => remoteGroupBuildingByNode[id]);
      const blocker = overlap ? remoteGroupBuildingByNode[overlap] : undefined;
      const who = blocker?.displayName ?? 'another user';
      trace(`group refused: selection overlaps ${who}'s active group-builder selection`);
      const msg = `${who} is currently grouping these modules.`;
      error = msg;
      setTimeout(() => {
        if (error === msg) error = null;
      }, 4000);
      return;
    }

    const modulesById = new Map<string, PortLookupModule>();
    const labels = new Map<string, string>();
    for (const id of eligible) {
      const node = patch.nodes[id];
      if (!node) continue;
      const def = defLookup(node.type);
      if (!def) continue;
      modulesById.set(id, {
        id,
        type: node.type,
        inputs: def.inputs,
        outputs: def.outputs,
        label: def.label,
      });
      labels.set(id, def.label ?? node.type);
    }

    groupBuilderCandidates = buildPortCandidates({
      selectionIds: eligible,
      nodes: snapshot.nodes,
      edges: snapshot.edges,
      modulesById,
    });
    groupBuilderSelectionIds = eligible;
    groupBuilderModuleLabels = labels;
    groupBuilderOpen = true;
  }

  function commitGroup(selectedCandidates: PortCandidate[], label: string) {
    const ids = groupBuilderSelectionIds;
    const groupId = `group-${Math.random().toString(36).slice(2, 10)}`;
    const exposedPorts = buildExposedPorts({ selectedCandidates });
    // If the user accepted the placeholder name, bump to the next free
    // GROUP<N> slot so multiple groups in the same rack don't all show
    // the same label. A real user-typed name passes through untouched.
    const effectiveLabel =
      label.trim().length === 0 || label === LEGACY_GROUP_PLACEHOLDER
        ? nextGroupNameForNewGroup(patch.nodes)
        : label;
    const plan = planCreateGroup({
      groupId,
      selectionIds: ids,
      exposedPorts,
      nodes: snapshot.nodes,
      edges: snapshot.edges,
      label: effectiveLabel,
    });

    ydoc.transact(() => {
      patch.nodes[plan.groupNode.id] = plan.groupNode;
      // Instruments v1 — auto-enter edit mode after Create. The user is
      // expected to immediately drop into "arrange the layout" UX rather
      // than seeing a locked render they then have to right-click to edit.
      // Default to an empty layout map; per-element positions get written
      // as the user drags inside GroupExposedControls.
      const created = patch.nodes[plan.groupNode.id];
      if (created) {
        if (!created.data) created.data = {};
        (created.data as unknown as GroupData).instrumentLayout = {
          mode: 'edit',
          controls: {},
        };
      }
      for (const { childId, parentGroupId } of plan.childParentSets) {
        const target = patch.nodes[childId];
        if (!target) continue;
        if (!target.data) target.data = {};
        target.data.parentGroupId = parentGroupId;
      }
      for (const rw of plan.edges.rewrite) {
        const target = patch.edges[rw.id];
        if (!target) continue;
        if (rw.newSource) target.source = rw.newSource;
        if (rw.newTarget) target.target = rw.newTarget;
      }
      for (const id of plan.edges.deleteIds) {
        delete patch.edges[id];
      }
    }, LOCAL_ORIGIN);
    trace(`grouped ${ids.length} modules into ${groupId} (${exposedPorts.length} exposed, edit mode)`);
  }

  // Instruments v1 — flip an instrument between 'edit' and 'locked' modes.
  // Right-click "Edit Instrument" enters edit mode; the floating
  // "Save instrument" CTA returns to locked. The same toggle is reused by
  // ctx-toggle-expanded for backward compatibility with phase-2 tests; we
  // keep the legacy expanded-card branch (data.expanded) alongside the
  // new layout mode so neither path regresses.
  function setInstrumentMode(groupId: string, mode: 'edit' | 'locked') {
    const group = patch.nodes[groupId];
    if (!group || group.type !== 'group') return;
    ydoc.transact(() => {
      const target = patch.nodes[groupId];
      if (!target) return;
      if (!target.data) target.data = {};
      const data = target.data as unknown as GroupData;
      const existing = data.instrumentLayout;
      data.instrumentLayout = {
        mode,
        controls: existing?.controls ?? {},
      };
    }, LOCAL_ORIGIN);
    trace(`instrument ${groupId} layout-mode → ${mode}`);
  }

  function ungroupNode(groupId: string) {
    const groupNode = patch.nodes[groupId];
    if (!groupNode || groupNode.type !== 'group') {
      trace(`ungroup refused: ${groupId} is not a group`);
      return;
    }
    const plan = planUngroup({ groupNode: groupNode as unknown as ModuleNode, edges: snapshot.edges });
    ydoc.transact(() => {
      for (const rw of plan.rewrite) {
        const target = patch.edges[rw.id];
        if (!target) continue;
        if (rw.newSource) target.source = rw.newSource;
        if (rw.newTarget) target.target = rw.newTarget;
      }
      for (const childId of plan.childrenToClear) {
        const child = patch.nodes[childId];
        if (!child || !child.data) continue;
        delete child.data.parentGroupId;
      }
      delete patch.nodes[plan.groupNodeId];
    }, LOCAL_ORIGIN);
    trace(`ungrouped ${groupId} (restored ${plan.childrenToClear.length} children)`);
  }

  // ---------------- Module-grouping Phase 2A — edit-knob-positions ----------------
  //
  // Toggling `data.expanded` flips the group from "single GroupCard" mode
  // into "render children inline" mode. The flowNodes/flowEdges $effects
  // already respect the flag (children are skipped only when their parent
  // group is in `collapsedGroupIds`, which excludes expanded groups). The
  // GroupCard itself notices `expanded` and renders a thin header instead
  // of its full body. A floating "Update group" button surfaces above
  // the viewport while any group is expanded — clicking it collapses
  // all currently-expanded groups so the user can't get stuck.
  function toggleGroupExpanded(groupId: string) {
    const group = patch.nodes[groupId];
    if (!group || group.type !== 'group') return;
    // Instruments v1 — the right-click "Edit instrument" entry now drives
    // both the legacy expanded-card flag (so the GroupCard's thin-header
    // chrome flips for the "edit-knob-positions" workflow phase-2 ships)
    // AND the new instrumentLayout.mode flag so the new layout engine
    // un-locks. Both flags stay in sync — flipping one without the other
    // would leave the user with mismatched chrome.
    const current = (group.data as { expanded?: boolean } | undefined)?.expanded === true;
    const nextExpanded = !current;
    ydoc.transact(() => {
      const target = patch.nodes[groupId];
      if (!target) return;
      if (!target.data) target.data = {};
      (target.data as { expanded?: boolean }).expanded = nextExpanded;
      const data = target.data as unknown as GroupData;
      const existing = data.instrumentLayout;
      data.instrumentLayout = {
        mode: nextExpanded ? 'edit' : 'locked',
        controls: existing?.controls ?? {},
      };
    }, LOCAL_ORIGIN);
    trace(`instrument ${groupId} edit → ${nextExpanded}`);
  }

  /**
   * Set a group's user-facing name. Empty/whitespace input falls back to
   * the next free `GROUP<N>` slot so groups can never end up nameless.
   * The label is stored on `data.label` (already round-tripped by every
   * existing group code path — same field saved-group `payload.label`
   * is derived from).
   */
  function renameGroup(groupId: string, rawName: string) {
    const group = patch.nodes[groupId];
    if (!group || group.type !== 'group') return;
    const trimmed = rawName.trim();
    const next =
      trimmed.length === 0 || trimmed === LEGACY_GROUP_PLACEHOLDER
        ? nextGroupNameForNewGroup(patch.nodes)
        : trimmed;
    const currentLabel =
      typeof (group.data as { label?: unknown } | undefined)?.label === 'string'
        ? ((group.data as { label?: string }).label ?? '').trim()
        : '';
    if (currentLabel === next) return;
    ydoc.transact(() => {
      const target = patch.nodes[groupId];
      if (!target) return;
      if (!target.data) target.data = {};
      (target.data as { label?: string }).label = next;
    }, LOCAL_ORIGIN);
    trace(`renamed group ${groupId} → "${next}"`);
  }

  /**
   * Assign `GROUP<N>` to every group that's currently nameless or stuck on
   * the legacy "GROUP!" placeholder. Driven by the snapshot subscriber:
   * the migration runs any time a snapshot exposes a group needing a name,
   * so a second group added after the first migration still picks up a
   * fresh slot. The plan is id-sorted so peers running concurrently
   * produce identical assignments (Y.js conflict-resolution makes the
   * writes idempotent).
   */
  function maybeMigrateGroupNames() {
    const plan = planDefaultGroupNames(patch.nodes);
    if (plan.length === 0) return;
    ydoc.transact(() => {
      for (const { groupId, name } of plan) {
        const target = patch.nodes[groupId];
        if (!target) continue;
        // Mutate the existing data sub-object so syncedstore propagates the
        // change through the Y.Map view. Replacing `data` wholesale would
        // detach any references the caller (or test eval) is holding.
        if (!target.data || typeof target.data !== 'object') {
          target.data = { label: name };
        } else {
          (target.data as { label?: string }).label = name;
        }
      }
    }, LOCAL_ORIGIN);
    trace(`group-name migration: assigned default names to ${plan.length} group(s)`);
  }

  // Collapses every currently-expanded group. Wired to the floating
  // "Update group" button so a user can exit edit-knob mode in one click
  // regardless of how many groups they cracked open.
  function collapseAllExpandedGroups() {
    ydoc.transact(() => {
      for (const node of Object.values(patch.nodes)) {
        if (!node || node.type !== 'group') continue;
        const data = node.data as { expanded?: boolean } | undefined;
        if (data?.expanded === true) {
          (node.data as { expanded?: boolean }).expanded = false;
        }
        // Instruments v1 — when the user clicks "Save instrument", also
        // flip the new instrument layout into 'locked' so the next render
        // shows the frozen card. We mirror the expanded flip above so
        // legacy phase-2 tests + the new layout engine stay aligned.
        const igData = node.data as unknown as GroupData | undefined;
        if (igData?.instrumentLayout?.mode === 'edit') {
          (node.data as unknown as GroupData).instrumentLayout = {
            mode: 'locked',
            controls: igData.instrumentLayout.controls ?? {},
          };
        }
      }
    }, LOCAL_ORIGIN);
    trace('saved every editing instrument');
  }

  // Snapshot-derived: are there any expanded groups right now? Drives
  // the floating "Update group" button's visibility.
  let anyGroupExpanded = $derived.by(() => {
    void snapshot;
    for (const n of snapshot.nodes) {
      if (n.type !== 'group') continue;
      if ((n.data as { expanded?: boolean } | undefined)?.expanded === true) return true;
    }
    return false;
  });

  // ---------------- Module-grouping Phase 2B — edit-exposed-jacks ----------------
  //
  // Right-click → "Edit exposed patch jacks…" re-opens the GroupBuilderModal
  // in EDIT mode. The modal seeds checked rows from the group's current
  // exposedPorts list; on commit we diff old vs new via planEditExposed
  // and update the group + drop any cables to now-removed exposed ports.

  /** Active group-id being edited via the exposed-jacks modal. null when
   *  the modal is open in create mode. */
  let editExposedGroupId = $state<string | null>(null);
  let editExposedExistingPorts = $state<ExposedPort[] | undefined>(undefined);
  let editExposedExistingLabel = $state<string | undefined>(undefined);

  function openEditExposedJacks(groupId: string) {
    const group = patch.nodes[groupId];
    if (!group || group.type !== 'group') return;
    const data = group.data as unknown as GroupData | undefined;
    if (!data) return;
    const eligible = data.childIds.filter((id) => Boolean(patch.nodes[id]));
    if (eligible.length === 0) return;

    const modulesById = new Map<string, PortLookupModule>();
    const labels = new Map<string, string>();
    for (const id of eligible) {
      const node = patch.nodes[id];
      if (!node) continue;
      const def = defLookup(node.type);
      if (!def) continue;
      modulesById.set(id, {
        id,
        type: node.type,
        inputs: def.inputs,
        outputs: def.outputs,
        label: def.label,
      });
      labels.set(id, def.label ?? node.type);
    }

    groupBuilderCandidates = buildPortCandidates({
      selectionIds: eligible,
      nodes: snapshot.nodes,
      edges: snapshot.edges,
      modulesById,
    });
    groupBuilderSelectionIds = eligible;
    groupBuilderModuleLabels = labels;
    editExposedGroupId = groupId;
    editExposedExistingPorts = data.exposedPorts.slice();
    editExposedExistingLabel = data.label;
    groupBuilderOpen = true;
  }

  function commitEditExposed(selectedCandidates: PortCandidate[], label: string) {
    const groupId = editExposedGroupId;
    if (!groupId) return;
    const group = patch.nodes[groupId];
    if (!group || group.type !== 'group') return;
    const newExposed = buildExposedPorts({ selectedCandidates });
    const plan = planEditExposed({
      group: group as unknown as ModuleNode,
      edges: snapshot.edges,
      newExposedPorts: newExposed,
      newLabel: label,
    });
    ydoc.transact(() => {
      const target = patch.nodes[groupId];
      if (!target) return;
      if (!target.data) target.data = {};
      const data = target.data as unknown as GroupData;
      data.exposedPorts = plan.mergedExposedPorts;
      if (plan.newLabel !== undefined) data.label = plan.newLabel;
      for (const id of plan.deleteEdgeIds) delete patch.edges[id];
    }, LOCAL_ORIGIN);
    trace(
      `group ${groupId} re-exposed (${plan.mergedExposedPorts.length} ports, dropped ${plan.deleteEdgeIds.length} cables)`,
    );
  }

  // ---------------- Module-grouping Phase 4 — exposed controls ----------------
  //
  // Right-click on a group → "Configure exposed controls…" opens a modal
  // listing each child module's exposable controls (buttons + knobs the
  // module def declares). User-checked entries land in data.exposedControls
  // and surface as bounded boxes on the group bar (GroupExposedControls).

  let configureControlsOpen = $state(false);
  let configureControlsGroupId = $state<string | null>(null);
  interface ExposedControlsChildBlock {
    childId: string;
    label: string;
    controls: readonly import('$lib/audio/module-registry').ExposableControl[];
    /** Instruments v1 — child opts in to "Show step sequence" / "Show score". */
    canExposeSequence?: boolean;
    sequenceLabel?: string;
  }
  let configureControlsChildren = $state<ExposedControlsChildBlock[]>([]);
  let configureControlsExisting = $state<ExposedControl[]>([]);
  let configureControlsExistingSequences = $state<Record<string, boolean>>({});

  function openConfigureExposedControls(groupId: string) {
    const group = patch.nodes[groupId];
    if (!group || group.type !== 'group') return;
    const data = group.data as unknown as GroupData | undefined;
    if (!data) return;
    const blocks: ExposedControlsChildBlock[] = [];
    for (const cid of data.childIds) {
      const child = patch.nodes[cid];
      if (!child) continue;
      const def = defLookup(child.type);
      // exposesSequence is an Audio-domain flag; defLookup returns the
      // loose ModuleDef so we read it through the audio def lookup too.
      const audioDef = getModuleDef(child.type) as { exposesSequence?: boolean } | undefined;
      const controls = listExposableControls(child.type, (t: string) => getModuleDef(t));
      const canExposeSequence = audioDef?.exposesSequence === true;
      // Include the child even when it has zero exposable controls, so a
      // sequencer-with-no-knobs-yet still shows the "Show step sequence"
      // checkbox as a single-row block.
      if (controls.length === 0 && !canExposeSequence) continue;
      // Sequencers/score get a friendlier label than the generic default.
      const sequenceLabel =
        child.type === 'score' ? 'Show score' : 'Show step sequence';
      blocks.push({
        childId: cid,
        label: def?.label ?? child.type,
        controls,
        canExposeSequence,
        sequenceLabel,
      });
    }
    configureControlsChildren = blocks;
    configureControlsExisting = (data.exposedControls ?? []).slice();
    configureControlsExistingSequences = { ...(data.exposedSequences ?? {}) };
    configureControlsGroupId = groupId;
    configureControlsOpen = true;
  }

  function commitExposedControls(picks: ExposedControl[], sequences: Record<string, boolean>) {
    const groupId = configureControlsGroupId;
    if (!groupId) return;
    const group = patch.nodes[groupId];
    if (!group || group.type !== 'group') return;
    // Defensive: revalidate against the live patch in case a child was
    // deleted between modal-open and Save. validateExposedControls also
    // guards against any future ExposedControl bug-class like #187.
    const validated = validateExposedControls(picks, {
      nodes: patch.nodes as Record<string, ModuleNode | undefined>,
      defLookup: (t: string) => getModuleDef(t),
    });
    // Drop sequence entries pointing at non-existent children or modules
    // that don't actually declare exposesSequence (defensive against a
    // stale/buggy payload — matches validateExposedControls' role).
    const validSeqs: Record<string, boolean> = {};
    for (const [cid, on] of Object.entries(sequences)) {
      if (!on) continue;
      const child = patch.nodes[cid];
      if (!child) continue;
      const def = getModuleDef(child.type) as { exposesSequence?: boolean } | undefined;
      if (def?.exposesSequence !== true) continue;
      validSeqs[cid] = true;
    }
    ydoc.transact(() => {
      const target = patch.nodes[groupId];
      if (!target) return;
      if (!target.data) target.data = {};
      const data = target.data as unknown as GroupData;
      data.exposedControls = validated;
      data.exposedSequences = validSeqs;
    }, LOCAL_ORIGIN);
    trace(
      `instrument ${groupId} exposed controls updated (${validated.length} controls, ${Object.keys(validSeqs).length} sequences)`,
    );
  }

  // ---------------- Module-grouping Phase 2C — duplicate group ----------------
  //
  // Right-click → "Duplicate" on a group clones the group + every child
  // into a fresh id space, offsets by 30px down-right (cascading from
  // the source), and re-creates internal edges. External cables are NOT
  // cloned. Hits the same maxInstances guard as duplicateNode for each
  // child type.
  function duplicateGroupAction(groupId: string) {
    const group = patch.nodes[groupId];
    if (!group || group.type !== 'group') {
      trace(`duplicate-group refused: ${groupId} is not a group`);
      return;
    }
    const data = group.data as unknown as GroupData | undefined;
    if (!data) return;
    const children: ModuleNode[] = [];
    for (const id of data.childIds) {
      const n = patch.nodes[id];
      if (n) children.push(n as unknown as ModuleNode);
    }
    // maxInstances preflight: count each type that's at/over cap.
    const typeCounts = new Map<string, number>();
    for (const node of Object.values(patch.nodes)) {
      if (!node) continue;
      typeCounts.set(node.type, (typeCounts.get(node.type) ?? 0) + 1);
    }
    for (const child of children) {
      const def = defLookup(child.type);
      const cap = def?.maxInstances;
      if (cap === undefined) continue;
      const willBe = (typeCounts.get(child.type) ?? 0) + 1; // +1 because we're about to add one more
      if (willBe > cap) {
        const msg = `${def?.label ?? child.type}: duplicating this group would exceed instance cap (${willBe}/${cap})`;
        trace(`duplicate-group refused: ${child.type} would exceed cap (${willBe}/${cap})`);
        error = msg;
        setTimeout(() => {
          if (error === msg) error = null;
        }, 4000);
        return;
      }
      typeCounts.set(child.type, willBe);
    }

    const plan = planDuplicateGroup({
      group: group as unknown as ModuleNode,
      children,
      edges: snapshot.edges,
      existingNodeIds: Object.keys(patch.nodes),
      existingEdgeIds: Object.keys(patch.edges),
    });

    ydoc.transact(() => {
      for (const c of plan.newChildren) patch.nodes[c.id] = c;
      patch.nodes[plan.newGroup.id] = plan.newGroup;
      for (const e of plan.newEdges) patch.edges[e.id] = e;
    }, LOCAL_ORIGIN);
    trace(
      `duplicated group ${groupId} → ${plan.newGroup.id} (${plan.newChildren.length} children, ${plan.newEdges.length} internal edges)`,
    );
    void ensureEngine();
  }

  // ---------------- Saved-groups library ----------------
  let savingGroupId = $state<string | null>(null);

  async function saveGroupToLibrary(groupId: string) {
    const group = patch.nodes[groupId];
    if (!group || group.type !== 'group') return;
    if (!currentUserId) {
      error = 'Sign in to save groups to your library.';
      setTimeout(() => { if (error?.startsWith('Sign in to save')) error = null; }, 4000);
      return;
    }
    const extracted = extractSavedGroupPayload({
      group: group as unknown as ModuleNode,
      nodes: snapshot.nodes,
      edges: snapshot.edges,
    });
    if (!extracted) {
      trace(`save-group refused: ${groupId} has no group data`);
      return;
    }
    const name = window.prompt('Save group to your library as:', extracted.label);
    if (name === null) return;
    const trimmed = name.trim();
    if (trimmed.length === 0) return;

    savingGroupId = groupId;
    try {
      const res = await fetch('/api/saved-groups', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: trimmed, payload: extracted.payload }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        const msg = body.message ?? `Save failed: ${res.status}`;
        error = msg;
        setTimeout(() => { if (error === msg) error = null; }, 5000);
        trace(`save-group failed: ${msg}`);
        return;
      }
      trace(`saved group ${groupId} to library as "${trimmed}"`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      error = `Save failed: ${msg}`;
      setTimeout(() => { if (error === `Save failed: ${msg}`) error = null; }, 5000);
    } finally {
      savingGroupId = null;
    }
  }

  function insertSavedGroup(sg: SavedGroup) {
    const plan = resurrectSavedGroup({
      payload: sg.payload,
      existingNodeIds: Object.keys(patch.nodes),
      existingEdgeIds: Object.keys(patch.edges),
      groupPosition: { ...spawnFlowPos },
    });
    const typeCounts = new Map<string, number>();
    for (const node of Object.values(patch.nodes)) {
      if (!node) continue;
      typeCounts.set(node.type, (typeCounts.get(node.type) ?? 0) + 1);
    }
    for (const child of plan.newChildren) {
      const def = defLookup(child.type);
      const cap = def?.maxInstances;
      if (cap === undefined) continue;
      const willBe = (typeCounts.get(child.type) ?? 0) + 1;
      if (willBe > cap) {
        const msg = `${def?.label ?? child.type}: inserting this saved group would exceed instance cap (${willBe}/${cap})`;
        error = msg;
        setTimeout(() => { if (error === msg) error = null; }, 4000);
        trace(`insert-saved-group refused: ${child.type} would exceed cap`);
        return;
      }
      typeCounts.set(child.type, willBe);
    }
    ydoc.transact(() => {
      for (const c of plan.newChildren) patch.nodes[c.id] = c;
      patch.nodes[plan.newGroup.id] = plan.newGroup;
      for (const e of plan.newEdges) patch.edges[e.id] = e;
    }, LOCAL_ORIGIN);
    trace(`inserted saved group "${sg.label}" → ${plan.newGroup.id} (${plan.newChildren.length} children, ${plan.newEdges.length} internal edges)`);
    void ensureEngine();
  }

  let savedGroupsPickerOpen = $state(false);
  function openSavedGroupsPicker() {
    if (!currentUserId) return;
    savedGroupsPickerOpen = true;
  }

  // VRT interactions/groups specs drive the saved-groups modal without a
  // real Clerk session — the production trigger above is currentUserId-
  // gated, but the modal component itself is mounted unconditionally. This
  // dev-only hook flips its `open` prop directly so the visual surface can
  // be captured independently of auth state. Same pattern as the other
  // `__*` test hooks in this file.
  if (testHooksEnabled()) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).__openSavedGroupsPicker = () => {
      savedGroupsPickerOpen = true;
    };
  }

  function deleteGroupAndChildren(groupId: string) {
    const groupNode = patch.nodes[groupId];
    if (!groupNode || groupNode.type !== 'group') return;
    const data = groupNode.data as { childIds?: string[] } | undefined;
    const childIds = Array.isArray(data?.childIds) ? [...data!.childIds!] : [];
    const ok = window.confirm(
      `Delete this group and its ${childIds.length} module${childIds.length === 1 ? '' : 's'}? This can't be undone.`,
    );
    if (!ok) return;
    ydoc.transact(() => {
      const doomed = new Set<string>([groupId, ...childIds]);
      for (const [eid, edge] of Object.entries(patch.edges)) {
        if (!edge) continue;
        if (doomed.has(edge.source.nodeId) || doomed.has(edge.target.nodeId)) {
          delete patch.edges[eid];
        }
      }
      for (const id of doomed) delete patch.nodes[id];
    }, LOCAL_ORIGIN);
    trace(`deleted group ${groupId} + ${childIds.length} children`);
  }

  // ---------------- Port right-click context menu ("Patch to..." flow) ----------------
  //
  // Right-click on any handle dot opens a cascading menu: Patch to... →
  // every other module in the patch → that module's compatible ports.
  // Picking a port creates the same edge a drag-connect would.
  //
  // Wired as a delegated listener on the SvelteFlow root via a window-
  // level capture-phase contextmenu handler — Svelte Flow swallows the
  // event on handle elements so they never reach onnodecontextmenu /
  // onpanecontextmenu. Capture phase + closest('.svelte-flow__handle')
  // handles every card style (PatchPanel-mounted handles AND directly-
  // rendered handles on cards like LINES / VIDEOOUT / SCOPE).

  function defLookup(type: string): AnyDef | undefined {
    // Meta defs (sticky etc.) carry inputs/outputs/params shaped
    // identically to AudioModuleDef / VideoModuleDef; AnyDef is the
    // shared union. Meta domains never reach the engine, so the lack
    // of a factory is irrelevant for the patch-panel UI helpers.
    return getModuleDef(type) ?? getVideoModuleDef(type) ?? getMetaModuleDef(type);
  }

  let portMenuOpen = $state(false);
  let portMenuPos = $state({ x: 0, y: 0 });
  let portMenuSourceNodeId = $state<string | null>(null);
  let portMenuSourcePortId = $state<string | null>(null);
  let portMenuSourceDirection = $state<'output' | 'input'>('output');
  let portMenuSourceType = $state<string>('audio');

  let portMenuSourceLabel = $derived.by(() => {
    void snapshot;
    if (!portMenuSourceNodeId || !portMenuSourcePortId) return '';
    const n = patch.nodes[portMenuSourceNodeId];
    if (!n) return '';
    const def = defLookup(n.type);
    const typeLabel = def?.label ?? n.type;
    return `${typeLabel}.${portMenuSourcePortId}`;
  });

  let portMenuModuleEntries = $derived.by<ModuleEntry[]>(() => {
    void snapshot;
    if (!portMenuOpen || !portMenuSourceNodeId) return [];
    return buildModuleEntries(patch.nodes, defLookup, portMenuSourceNodeId);
  });

  function portMenuCandidatesFor(targetNodeId: string): CandidatePort[] {
    void snapshot;
    const n = patch.nodes[targetNodeId];
    if (!n) return [];
    const def = defLookup(n.type);
    if (!def) return [];
    return compatibleTargetPorts(
      portMenuSourceType,
      portMenuSourceDirection,
      def,
      targetNodeId,
      patch.edges,
      patch.nodes,
      defLookup,
    );
  }

  /** Resolve a contextmenu MouseEvent on a Handle DOM element to the
   *  source-port descriptor we need. Returns null if the click wasn't
   *  on a handle (so the regular pane / node menu can take over). */
  function handleInfoFromEvent(e: MouseEvent): {
    nodeId: string;
    portId: string;
    direction: 'output' | 'input';
    type: string;
  } | null {
    const target = e.target as HTMLElement | null;
    if (!target) return null;
    const handleEl = target.closest('.svelte-flow__handle') as HTMLElement | null;
    if (!handleEl) return null;
    const portId = handleEl.getAttribute('data-handleid');
    if (!portId) return null;
    const nodeEl = handleEl.closest('.svelte-flow__node') as HTMLElement | null;
    if (!nodeEl) return null;
    // Svelte Flow stores nodeId on the node wrapper as data-id.
    const nodeId = nodeEl.getAttribute('data-id');
    if (!nodeId) return null;
    const isSource = handleEl.classList.contains('source');
    const isTarget = handleEl.classList.contains('target');
    let direction: 'output' | 'input' = isSource ? 'output' : 'input';
    if (!isSource && !isTarget) {
      // Fallback: look up via the def. (xyflow always sets the class but
      // belt + braces.)
      direction = 'output';
    }
    const node = patch.nodes[nodeId];
    if (!node) return null;
    const def = defLookup(node.type);
    let type = 'audio';
    if (def) {
      const port =
        direction === 'output'
          ? def.outputs.find((p) => p.id === portId)
          : def.inputs.find((p) => p.id === portId);
      if (port) type = port.type as string;
    }
    return { nodeId, portId, direction, type };
  }

  function openPortMenu(e: MouseEvent, info: NonNullable<ReturnType<typeof handleInfoFromEvent>>) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    // Kill any in-flight xyflow connection state BEFORE the menu opens.
    // The pointerdown that produced this contextmenu/dblclick/hold-fire
    // fires on an .svelte-flow__handle, and xyflow's own pointerdown
    // handler starts a connection-drag — which renders a dashed yellow
    // preview line tracking the cursor. Without resetting that state,
    // the preview sits behind the PortContextMenu for as long as the
    // menu is open. cancelConnection clears both the click-connect
    // handle and the in-progress drag state.
    try {
      flowApi?.cancelConnection?.();
    } catch { /* defensive — never block the menu from opening */ }
    // Our own pickup-mode state (PickupCable ghost) may also have
    // briefly engaged on a fast pointerdown→contextmenu sequence; reset
    // it so we don't render a phantom pickup cable alongside the menu.
    if (connectDragState.mode === 'pickup') {
      connectDragState.cancelPickup();
    }
    portMenuPos = { x: e.clientX, y: e.clientY };
    portMenuSourceNodeId = info.nodeId;
    portMenuSourcePortId = info.portId;
    portMenuSourceDirection = info.direction;
    portMenuSourceType = info.type;
    portMenuOpen = true;
    // Lock the source-port's PatchPanel open while the cascade is up.
    connectDragState.beginCascade(info.nodeId);
  }

  function onPortContextMenu(e: MouseEvent) {
    // Right-clicks inside the TOYBOX combine-graph SVG are owned by that editor's
    // own contextual menu — never resolve them to the generic port-patch cascade
    // (the SVG's port dots are not svelte-flow handles, so handleInfoFromEvent
    // already returns null, but guard explicitly for clarity + robustness).
    if ((e.target as Element | null)?.closest?.('[data-testid="toybox-graph-svg"]')) return;
    const info = handleInfoFromEvent(e);
    if (!info) return;
    openPortMenu(e, info);
  }

  function onPortDoubleClick(e: MouseEvent) {
    const info = handleInfoFromEvent(e);
    if (info) {
      openPortMenu(e, info);
      return;
    }
    // Fallback: dblclick on a PatchPanel corner trigger opens the cascade
    // sourced from the module's first declared output port. Lets users
    // bypass the open-panel-then-find-the-handle dance for the common
    // "patch this module's main output somewhere" workflow.
    const triggerInfo = triggerInfoFromEvent(e);
    if (triggerInfo) {
      openPortMenu(e, triggerInfo);
    }
  }

  /** Resolve a dblclick MouseEvent on a PatchPanel corner trigger to the
   *  module's first declared output port. Returns null if the click wasn't
   *  on a trigger, or if the module has no outputs (no-op — no empty
   *  cascade). */
  function triggerInfoFromEvent(e: MouseEvent): {
    nodeId: string;
    portId: string;
    direction: 'output' | 'input';
    type: string;
  } | null {
    const target = e.target as HTMLElement | null;
    if (!target) return null;
    const triggerEl = target.closest('.patch-trigger') as HTMLElement | null;
    if (!triggerEl) return null;
    const hostEl = triggerEl.closest('[data-patch-panel-node]') as HTMLElement | null;
    if (!hostEl) return null;
    const nodeId = hostEl.getAttribute('data-patch-panel-node');
    if (!nodeId) return null;
    const node = patch.nodes[nodeId];
    if (!node) return null;
    const def = defLookup(node.type);
    if (!def) return null;
    const firstOut = def.outputs[0];
    if (!firstOut) return null;
    return {
      nodeId,
      portId: firstOut.id,
      direction: 'output',
      type: firstOut.type as string,
    };
  }

  // Capture-phase document listeners guarantee we fire before any xyflow
  // handling kicks in on the handle. Without capture, xyflow's own
  // contextmenu / pointerdown handling can swallow the event before
  // bubble-phase reaches our .flow div. Both right-click and double-click
  // route to the same openPortMenu — both gestures end at the same
  // PortContextMenu cascade.
  $effect(() => {
    const onDocCtxMenu = (e: MouseEvent) => {
      onPortContextMenu(e);
    };
    const onDocDblClick = (e: MouseEvent) => {
      onPortDoubleClick(e);
    };
    document.addEventListener('contextmenu', onDocCtxMenu, true);
    document.addEventListener('dblclick', onDocDblClick, true);
    return () => {
      document.removeEventListener('contextmenu', onDocCtxMenu, true);
      document.removeEventListener('dblclick', onDocDblClick, true);
    };
  });

  // ---------------- Click-and-hold port → patch menu ----------------
  //
  // Left-click on a port and HOLD without dragging > 4px for 50ms → open
  // the Patch-to menu rooted at that port. A fast click (release before
  // 50ms, < 4px motion) ALSO opens the menu — power users learn the hold
  // gesture but new users hitting fast clicks get the same affordance.
  // If the user drags > 4px before the timer fires, we cancel the hold
  // and xyflow's drag-to-connect takes over (original behavior).
  //
  // Capture-phase pointerdown is critical: xyflow attaches its own
  // pointerdown to .svelte-flow__handle and starts a drag-connection. We
  // run FIRST (capture, document-level), then DON'T stopPropagation —
  // letting xyflow set up its drag in parallel. If the user keeps still,
  // we abort xyflow's drag via cancelConnection() before opening the
  // menu. If the user drags, we just clear our timer and xyflow proceeds.
  //
  // The follow-up pointerup/click that lands AFTER our menu opens must
  // be swallowed so it doesn't fall through to any item-click handler on
  // the freshly-rendered menu. We mark the gesture "menu-consumed" and
  // suppress the next click via document-level capture-phase listeners.
  // 200 ms = the standard long-press threshold. Lower thresholds (50 ms
  // was the original) leave no headroom for pointermove dispatch latency:
  // on CI runners + Playwright's CDP path, the pointermove that should
  // cancel the hold can arrive AFTER the timer fires, making the menu
  // open mid-drag. 200 ms is well above CDP roundtrip + still under the
  // 300 ms "feels slow" perceptual threshold.
  const HOLD_FIRE_MS = 200;
  const HOLD_DRAG_TOLERANCE_PX = 4;
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  let holdStart: { x: number; y: number } | null = null;
  let holdInfo: ReturnType<typeof handleInfoFromEvent> | null = null;
  let holdMenuConsumed = false;
  // Observable gesture phase for deterministic e2e (dev-only hook below).
  // 'idle'           — no port-hold gesture in flight.
  // 'armed'          — pointerdown on a handle; hold timer running, not yet
  //                    fired or cancelled.
  // 'cancelled-move' — a pointermove past the drag tolerance cancelled the
  //                    hold; xyflow's drag-to-connect now owns the gesture.
  //                    THIS is the signal the drag-passes-to-xyflow test
  //                    polls for, so it never has to race HOLD_FIRE_MS.
  // 'fired'          — the hold timer elapsed and the patch menu opened.
  // 'released'       — pointerup ended an armed (un-moved) gesture.
  let holdPhase: 'idle' | 'armed' | 'cancelled-move' | 'fired' | 'released' =
    'idle';

  function clearHold(): void {
    if (holdTimer !== null) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
    holdStart = null;
    holdInfo = null;
  }

  /** Open the patch menu without a triggering MouseEvent — used by the
   *  hold-timer fire path (where we synthesize coordinates from the
   *  original pointerdown). */
  function openPortMenuAt(
    clientX: number,
    clientY: number,
    info: NonNullable<ReturnType<typeof handleInfoFromEvent>>,
  ): void {
    try {
      flowApi?.cancelConnection?.();
    } catch { /* defensive */ }
    if (connectDragState.mode === 'pickup') {
      connectDragState.cancelPickup();
    }
    portMenuPos = { x: clientX, y: clientY };
    portMenuSourceNodeId = info.nodeId;
    portMenuSourcePortId = info.portId;
    portMenuSourceDirection = info.direction;
    portMenuSourceType = info.type;
    portMenuOpen = true;
    connectDragState.beginCascade(info.nodeId);
    holdMenuConsumed = true;
    holdPhase = 'fired';
  }

  $effect(() => {
    const onPointerDown = (e: PointerEvent) => {
      // Left button only — right-click goes through contextmenu, middle
      // through xyflow's pan.
      if (e.button !== 0) return;
      // While pickup-cable mode is engaged, a click on another handle
      // commits the pickup (xyflow's click-connect). Don't shadow it
      // with our hold-to-menu gesture.
      if (connectDragState.mode === 'pickup') return;
      // If the port menu is already open, a click on a different port
      // should swap source — but the cleanest behavior is to let the
      // existing menu's outside-click handler close it and a fresh
      // contextmenu/dblclick on the new port reopen. Suppress hold here.
      if (portMenuOpen) return;
      // Only on handle elements.
      const info = handleInfoFromEvent(e);
      if (!info) return;
      // Initialize gesture state. We DO NOT stopPropagation here — xyflow
      // needs the pointerdown to set up its own drag tracking. If the
      // hold fires we'll cancel xyflow's connection via cancelConnection()
      // and open the menu instead.
      clearHold();
      holdMenuConsumed = false;
      holdStart = { x: e.clientX, y: e.clientY };
      holdInfo = info;
      holdPhase = 'armed';
      const startX = e.clientX;
      const startY = e.clientY;
      const startedInfo = info;
      holdTimer = setTimeout(() => {
        holdTimer = null;
        // Still tracking the same gesture (no pointermove > 4px / no
        // pointerup since pointerdown). Fire the menu.
        if (!holdStart || !holdInfo) return;
        openPortMenuAt(startX, startY, startedInfo);
      }, HOLD_FIRE_MS);
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!holdStart) return;
      const dx = e.clientX - holdStart.x;
      const dy = e.clientY - holdStart.y;
      if (Math.hypot(dx, dy) > HOLD_DRAG_TOLERANCE_PX) {
        // User is dragging — xyflow's drag-to-connect handles it from
        // here. Cancel our hold so the timer doesn't fire.
        clearHold();
        holdPhase = 'cancelled-move';
      }
    };
    const onPointerUp = (e: PointerEvent) => {
      if (!holdStart || !holdInfo) {
        // No active hold gesture — nothing to do.
        return;
      }
      const dx = e.clientX - holdStart.x;
      const dy = e.clientY - holdStart.y;
      const moved = Math.hypot(dx, dy) > HOLD_DRAG_TOLERANCE_PX;
      const info = holdInfo;
      const startX = holdStart.x;
      const startY = holdStart.y;
      const timerStillLive = holdTimer !== null;
      clearHold();
      if (moved) {
        holdPhase = 'cancelled-move';
        return; // xyflow handled the drag
      }
      if (timerStillLive) {
        // Fast click before the hold timer — treat as same gesture, open
        // menu. openPortMenuAt sets holdPhase = 'fired'.
        openPortMenuAt(startX, startY, info);
      }
      // If the timer already fired the menu is open, holdPhase is 'fired'
      // and holdMenuConsumed === true — leave it; the click-suppress
      // handler below swallows the trailing click event.
    };
    const onClick = (e: MouseEvent) => {
      // Swallow the click that follows a hold-fire so it can't propagate
      // into a freshly-rendered menu item or any other handler. We only
      // suppress ONE click per consumed gesture.
      if (!holdMenuConsumed) return;
      holdMenuConsumed = false;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('pointermove', onPointerMove, true);
    document.addEventListener('pointerup', onPointerUp, true);
    document.addEventListener('click', onClick, true);
    return () => {
      clearHold();
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('pointermove', onPointerMove, true);
      document.removeEventListener('pointerup', onPointerUp, true);
      document.removeEventListener('click', onClick, true);
    };
  });

  // ---------------- Pickup-mode cursor tracking + Esc cancel ----------------
  //
  // While pickup mode is active, the ghost cable follows the cursor. We
  // track mousemove globally and write into connectDragState; the ghost
  // cable rendering reads pickupCursor and draws an SVG path from the
  // source port to that screen-space point.
  //
  // Esc cancels pickup: clears our state AND xyflow's internal
  // clickConnectStartHandle so the next handle click starts a fresh
  // pickup instead of committing.
  $effect(() => {
    const onPointerMove = (e: PointerEvent) => {
      if (connectDragState.mode !== 'pickup') return;
      connectDragState.updatePickupCursor(e.clientX, e.clientY);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (connectDragState.mode !== 'pickup') return;
      e.preventDefault();
      e.stopPropagation();
      connectDragState.cancelPickup();
      flowApi?.cancelClickConnect();
      trace('pickup-cancelled (Esc)');
    };
    document.addEventListener('pointermove', onPointerMove, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointermove', onPointerMove, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  });

  function pickPortMenuTarget({ nodeId, portId }: { nodeId: string; portId: string }) {
    if (!portMenuSourceNodeId || !portMenuSourcePortId) return;
    // Cascade is committing — release the source PatchPanel's lock.
    connectDragState.endCascade();
    // Resolve source/target by direction. If the right-clicked port is an
    // OUTPUT, the picked port is the INPUT — cable runs srcNode.srcPort →
    // pickedNode.pickedPort. If the right-clicked port is an INPUT, the
    // picked port is the OUTPUT.
    let from: { nodeId: string; portId: string };
    let to: { nodeId: string; portId: string };
    if (portMenuSourceDirection === 'output') {
      from = { nodeId: portMenuSourceNodeId, portId: portMenuSourcePortId };
      to = { nodeId, portId };
    } else {
      from = { nodeId, portId };
      to = { nodeId: portMenuSourceNodeId, portId: portMenuSourcePortId };
    }
    const srcNode = patch.nodes[from.nodeId];
    const dstNode = patch.nodes[to.nodeId];
    if (!srcNode || !dstNode) return;
    const srcDef = defLookup(srcNode.type);
    const dstDef = defLookup(dstNode.type);
    if (!srcDef || !dstDef) return;
    // Group endpoints — chase the exposed-port → child handoff for the
    // cable-type fallback; see handleConnect's matching block for the
    // why. The edge stays addressed to the group endpoint itself; the
    // snapshot projection rewrites it before the engine sees it.
    const srcExposed = resolveExposedPort(srcNode, from.portId);
    const dstExposed = resolveExposedPort(dstNode, to.portId);
    const srcPort = srcDef.outputs.find((p) => p.id === from.portId);
    const dstPort = dstDef.inputs.find((p) => p.id === to.portId);
    const sourceType: CableType = srcExposed?.cableType ?? srcPort?.type ?? 'audio';
    const targetType: CableType = dstExposed?.cableType ?? dstPort?.type ?? sourceType;

    const id = `e-${from.nodeId}-${from.portId}-${to.nodeId}-${to.portId}`;
    if (patch.edges[id]) {
      trace(`patch-to: edge already exists ${id}`);
      return;
    }
    ydoc.transact(() => {
      for (const [edgeId, edge] of Object.entries(patch.edges)) {
        if (
          edge &&
          edge.target.nodeId === to.nodeId &&
          edge.target.portId === to.portId
        ) {
          delete patch.edges[edgeId];
        }
      }
      patch.edges[id] = {
        id,
        source: from,
        target: to,
        sourceType,
        targetType,
      };
    }, LOCAL_ORIGIN);
    trace(`patch-to ${from.nodeId}.${from.portId} → ${to.nodeId}.${to.portId}`);
  }

  function deleteNode(nodeId: string) {
    // Singleton-anchor protection: a def with `undeletable: true` (today
    // just TIMELORDE, the rack's always-on system clock) MUST persist.
    // The right-click "Delete" entry hides this for undeletable modules
    // too; this guard catches the keyboard-delete path + any future
    // bulk-delete code that forgets to filter.
    const target = patch.nodes[nodeId];
    if (target) {
      const def = defLookup(target.type);
      if (def?.undeletable) {
        trace(`delete refused: ${nodeId} (${target.type}) is undeletable`);
        return;
      }
    }
    ydoc.transact(() => {
      // Remove every edge touching this node first so the engine sees a clean
      // disconnect before disposal (avoids dangling-target warnings).
      for (const [eid, edge] of Object.entries(patch.edges)) {
        if (!edge) continue;
        if (edge.source.nodeId === nodeId || edge.target.nodeId === nodeId) {
          delete patch.edges[eid];
        }
      }
      delete patch.nodes[nodeId];
    }, LOCAL_ORIGIN);
    // No defensive flow* sync needed: snapshot bus + one-way prop (B3).
    if (topNodeId === nodeId) topNodeId = null;
    trace(`deleted ${nodeId}`);
  }

  function unpatchNode(nodeId: string) {
    ydoc.transact(() => {
      for (const [eid, edge] of Object.entries(patch.edges)) {
        if (!edge) continue;
        if (edge.source.nodeId === nodeId || edge.target.nodeId === nodeId) {
          delete patch.edges[eid];
        }
      }
    }, LOCAL_ORIGIN);
    trace(`unpatched ${nodeId}`);
  }

  /** Right-click → Duplicate. Clones the node with all data + params into a
   *  fresh id, offset 30px down-right of the source so the new card lands
   *  visibly on top. Edges are NOT copied — the duplicate starts unpatched.
   *  Refuses when the source's module def has a maxInstances cap that's
   *  already met (matches spawnFromPalette's gate). */
  function duplicateNode(nodeId: string) {
    const source = patch.nodes[nodeId];
    if (!source) {
      trace(`duplicate refused: node ${nodeId} not found`);
      return;
    }
    // Re-check the same maxInstances + per-user PICTUREBOX caps the
    // palette path enforces — duplicate is just another spawn route.
    const audioDef = getModuleDef(source.type);
    const videoDef = !audioDef ? getVideoModuleDef(source.type) : undefined;
    const metaDef = !audioDef && !videoDef ? getMetaModuleDef(source.type) : undefined;
    const def = audioDef ?? videoDef ?? metaDef;
    if (def?.maxInstances !== undefined) {
      let existing = 0;
      for (const node of Object.values(patch.nodes)) {
        if (node && node.type === source.type) existing++;
      }
      if (existing >= def.maxInstances) {
        const msg = `${def.label ?? source.type}: at instance cap (${existing}/${def.maxInstances})`;
        trace(`duplicate refused: ${source.type} at cap (${existing}/${def.maxInstances})`);
        error = msg;
        setTimeout(() => {
          if (error === msg) error = null;
        }, 4000);
        return;
      }
    }
    if (source.type === PICTUREBOX_TYPE) {
      const decision = pictureboxSpawnDecision(
        patch.nodes,
        currentUserId ?? null,
      );
      if (!decision.ok) {
        const msg = explainSpawnDenial(decision);
        trace(`duplicate refused: ${source.type} ${decision.reason} ${decision.current}/${decision.cap}`);
        error = msg;
        setTimeout(() => {
          if (error === msg) error = null;
        }, 4000);
        return;
      }
    }
    if (source.type === SAMSLOOP_TYPE) {
      // Mirror the spawnFromPalette per-user/per-rackspace gate for
      // duplicate-route adds. The exact `SAMSLOOP_LIMIT_MESSAGE` text
      // is mandated by the brief; we use it for both reasons so the
      // surface message is stable.
      const decision = samsloopSpawnDecision(
        patch.nodes,
        currentUserId ?? null,
      );
      if (!decision.ok) {
        trace(`duplicate refused: ${source.type} ${decision.reason} ${decision.current}/${decision.cap}`);
        const msg = SAMSLOOP_LIMIT_MESSAGE;
        error = msg;
        setTimeout(() => {
          if (error === msg) error = null;
        }, 4000);
        return;
      }
    }
    const dup = buildDuplicate(source, Object.keys(patch.nodes));
    ydoc.transact(() => {
      patch.nodes[dup.id] = dup;
    }, LOCAL_ORIGIN);
    trace(`duplicated ${nodeId} → ${dup.id}`);
    void ensureEngine();
  }

  /** "Organize modules" — pack the current layout densely while preserving the
   *  user's relative arrangement (top stays top, left stays left). Wraps to a
   *  new row when the visible viewport width is exceeded so the result fits on
   *  one screen at the current zoom.
   *
   *  Multi-user mode writes to per-user layouts; single-user writes to the
   *  shared node.position. Falls back to the snapshot's position + a default
   *  card size when the xyflow measured size isn't available yet. */
  function organizeModules() {
    const snapNodes = snapshot.nodes;
    if (snapNodes.length === 0) {
      trace('organize: no modules to organize');
      return;
    }
    const DEFAULT_W = 240;
    const DEFAULT_H = 200;
    const boxes: Box[] = snapNodes.map((n) => {
      const internal = flowApi?.getInternalNode(n.id);
      const measured = internal?.measured;
      const pos = getNodePosition(ydoc, currentUserId, n.id, n.position);
      return {
        id: n.id,
        x: pos.x,
        y: pos.y,
        w: measured?.width ?? DEFAULT_W,
        h: measured?.height ?? DEFAULT_H,
      };
    });
    // Viewport in flow-space: dom width / current zoom. Origin is the top-left
    // of the visible viewport in flow-space (xyflow's getViewport returns the
    // pan offset as { x, y } where {0,0} flow-coord maps to that screen pixel,
    // so visible flow-space top-left is (-x/zoom, -y/zoom)).
    let viewport: { width: number; height: number; originX: number; originY: number } | undefined;
    if (flowEl && flowApi) {
      const rect = flowEl.getBoundingClientRect();
      const vp = flowApi.getViewport?.();
      const zoom = vp?.zoom && vp.zoom > 0 ? vp.zoom : 1;
      const originX = vp ? -vp.x / zoom : 0;
      const originY = vp ? -vp.y / zoom : 0;
      const width = rect.width / zoom;
      const height = rect.height / zoom;
      if (width > 0 && height > 0) {
        viewport = { width, height, originX, originY };
      }
    }
    const next = organizeLayout(boxes, viewport ? { viewport } : {});
    const byId = new Map(next.map((p) => [p.id, p]));
    let movedCount = 0;
    ydoc.transact(() => {
      for (const b of boxes) {
        const p = byId.get(b.id);
        if (!p) continue;
        if (Math.abs(p.x - b.x) < 0.5 && Math.abs(p.y - b.y) < 0.5) continue;
        movedCount++;
        if (currentUserId) {
          setNodePosition(ydoc, currentUserId, b.id, { x: p.x, y: p.y });
        } else {
          const target = patch.nodes[b.id];
          if (target) target.position = { x: p.x, y: p.y };
        }
      }
    });
    trace(`organize: nudged ${movedCount}/${boxes.length} module(s)`);
  }

  function spawnFromPalette(type: string) {
    // Second-layer singleton guard. The palette filters at-cap modules out of
    // the picker, but spawn paths that bypass it (drag-drop, keyboard short-
    // cuts) still hit this. Pre-Yjs-write check inside transact closes the
    // double-spawn race for a single client; the engine.addNode rejection is
    // the ultimate defense for multiplayer.
    //
    // Domain dispatch: try audio, then video, then meta (sticky lives
    // here). The three registries are kept separate so domain-specific
    // def shapes don't bleed across; the spawn path just needs `domain`
    // + `maxInstances`.
    const audioDef = getModuleDef(type);
    const videoDef = !audioDef ? getVideoModuleDef(type) : undefined;
    const metaDef = !audioDef && !videoDef ? getMetaModuleDef(type) : undefined;
    const def = audioDef ?? videoDef ?? metaDef;
    const domain: 'audio' | 'video' | 'meta' = audioDef
      ? 'audio'
      : videoDef
        ? 'video'
        : 'meta';
    // Owner-only gate (round 5: DOOM is a host-only widget). The palette
    // already hides owner-only modules from non-owners, but the drag-drop /
    // keyboard / dev-hook spawn paths bypass it — so this is the defensive
    // last line. A non-owner attempting to add DOOM is refused quietly (a
    // trace, not an error band) rather than erroring ugly.
    if (!canAddModule(type, localIsRackOwner)) {
      trace(`refused spawn ${type}: owner-only module (local user is not the rack owner)`);
      return;
    }
    if (def?.maxInstances !== undefined) {
      let existing = 0;
      for (const node of Object.values(patch.nodes)) {
        if (node && node.type === type) existing++;
      }
      if (existing >= def.maxInstances) {
        trace(`refused spawn ${type}: at cap (${existing}/${def.maxInstances})`);
        return;
      }
    }
    // PICTUREBOX has its OWN per-user cap on top of the shared
    // maxInstances workspace cap (see picturebox-limits.ts). Per-user
    // is checked first because it's user-actionable ("delete one of
    // yours"); workspace-cap is a social constraint that the
    // maxInstances gate above already covers but we re-check via the
    // helper for a friendlier message + structured trace.
    //
    // Single-user mode (currentUserId undefined): the per-user cap is
    // moot — there's only one user, who can fill the whole workspace.
    // We pass `null` to the helper so it skips the per-user check and
    // only enforces the workspace cap (which the maxInstances gate
    // above already enforces; this is just for the friendlier message).
    if (type === PICTUREBOX_TYPE) {
      const decision = pictureboxSpawnDecision(
        patch.nodes,
        currentUserId ?? null,
      );
      if (!decision.ok) {
        const msg = explainSpawnDenial(decision);
        trace(`refused spawn ${type}: ${decision.reason} ${decision.current}/${decision.cap}`);
        // Surface to the user via the same `error` band the rest of
        // Canvas uses (loadPatch failures, etc). Auto-clear after 4s
        // so the band doesn't stick around forever.
        error = msg;
        setTimeout(() => {
          if (error === msg) error = null;
        }, 4000);
        return;
      }
    }
    // SAMSLOOP — same pattern as PICTUREBOX. Memory cost per instance
    // dominated by the syncedstore CRDT proxy chain wrapping the sample
    // payload; cap derived empirically. See
    // lib/multiplayer/samsloop-limits.ts for the bench + math.
    if (type === SAMSLOOP_TYPE) {
      const decision = samsloopSpawnDecision(
        patch.nodes,
        currentUserId ?? null,
      );
      if (!decision.ok) {
        trace(`refused spawn ${type}: ${decision.reason} ${decision.current}/${decision.cap}`);
        const msg = SAMSLOOP_LIMIT_MESSAGE;
        error = msg;
        setTimeout(() => {
          if (error === msg) error = null;
        }, 4000);
        return;
      }
    }
    const id = `${type}-${crypto.randomUUID().slice(0, 8)}`;
    // The new card is placed exactly under the cursor (spawnFlowPos was
    // computed via screenToFlowPosition by the caller). Earlier versions
    // here looped a STACK_OFFSET nudge to clear collisions; we removed it
    // so spawn-at-cursor honors the user intent literally — overlapping
    // is fine, the new card just renders on top via topNodeId/zIndex below.
    // Users who want a tidy layout still have right-click → Organize modules.
    const pos = { ...spawnFlowPos };
    // Per-module spawn-time data stamping. PICTUREBOX + SAMSLOOP both
    // write creatorId (only when we have a real userId — single-user
    // mode leaves it unattributed, matching the per-user-cap-skipped
    // behavior of the decision helpers). See
    // lib/multiplayer/picturebox-limits.ts and samsloop-limits.ts.
    //
    // Auto-name: every spawn assigns the next-available <TYPE><N> name.
    // The DSL evaluator + click-to-edit label both read node.data.name.
    // See lib/multiplayer/module-naming.ts.
    const autoName = nextDefaultName(patch.nodes, type);
    const initialData: Record<string, unknown> = { name: autoName };
    if ((type === PICTUREBOX_TYPE || type === SAMSLOOP_TYPE) && currentUserId) {
      initialData.creatorId = currentUserId;
    }
    // CADILLAC — overrides the cursor-anchored pos with a viewport-relative
    // launch point. x = right edge + ~80px so the car drives onstage from
    // offscreen-right. y = mid-viewport-y so the car cuts through the
    // user's current view. The overlay reads spawnedAtMs/spawnerClientId
    // from data and computes the constant-velocity x deterministically;
    // no awareness traffic for the car.
    if (type === 'cadillac' && flowApi) {
      const vp = flowApi.getViewport();
      const containerEl: HTMLElement = flowEl ?? document.documentElement;
      const rect = containerEl.getBoundingClientRect();
      const rightFlow = flowApi.screenToFlowPosition({
        x: rect.right,
        y: rect.top,
      });
      const midFlow = flowApi.screenToFlowPosition({
        x: (rect.left + rect.right) / 2,
        y: (rect.top + rect.bottom) / 2,
      });
      pos.x = rightFlow.x + 80;
      pos.y = midFlow.y;
      initialData.spawnedAtMs = Date.now();
      const clientId = provider?.awareness?.clientID;
      if (typeof clientId === 'number') {
        initialData.spawnerClientId = clientId;
      }
      // Reference vp to keep its read in scope (telemetry hook in the
      // future). Suppresses a no-unused warning.
      void vp;
    }

    // Insert-on-cable (Proposal B2): if the cursor is close to an
    // existing cable's midpoint AND the new module has a compatible
    // input + compatible output for the cable's cableType, splice the
    // new card into the cable (delete original, add src→new + new→dst).
    // Falls back to a plain spawn-at-cursor on no match.
    const splice = tryFindInsertSpliceTarget(spawnFlowPos, def);

    ydoc.transact(() => {
      patch.nodes[id] = {
        id,
        type,
        domain,
        position: pos,
        params: {},
        data: initialData,
      };
      if (splice) {
        delete patch.edges[splice.edge.id];
        const e1id = `e-${splice.edge.source.nodeId}-${splice.edge.source.portId}-${id}-${splice.inPort.id}`;
        const e2id = `e-${id}-${splice.outPort.id}-${splice.edge.target.nodeId}-${splice.edge.target.portId}`;
        patch.edges[e1id] = {
          id: e1id,
          source: { ...splice.edge.source },
          target: { nodeId: id, portId: splice.inPort.id },
          sourceType: splice.edge.sourceType,
          targetType: splice.inPort.type,
        };
        patch.edges[e2id] = {
          id: e2id,
          source: { nodeId: id, portId: splice.outPort.id },
          target: { ...splice.edge.target },
          sourceType: splice.outPort.type,
          targetType: splice.edge.targetType,
        };
      }
    }, LOCAL_ORIGIN);
    // Mark this node as the visual top of the stacking order so it
    // renders on top of any cards it overlaps. Cleared as soon as the
    // user touches a different card (drag, right-click) so the lift is
    // strictly an at-spawn affordance — long-lived "always on top"
    // would surprise users who expect drag-to-front to win later.
    topNodeId = id;
    if (splice) {
      trace(`spliced ${type} as ${autoName} (${id}) into edge ${splice.edge.id}`);
    } else {
      trace(`spawned ${type} as ${autoName} (${id})`);
    }
    // Engine instantiation happens via the reconciler microtask.
    void ensureEngine();
  }

  // ----- Insert-on-cable (Proposal B2) hit-test + compatibility -----

  /** Maximum distance (flow-space px) between cursor drop point and a
   *  cable's geometric midpoint that still counts as a splice. Matches
   *  the threshold called out in the B2 spec. */
  const INSERT_ON_CABLE_THRESHOLD_PX = 12;

  /** Best-effort flow-space midpoint of an edge. Reads xyflow's internal
   *  per-handle bounds when measured; falls back to the node's center
   *  when the bounds aren't computed yet (immediately post-spawn). */
  function edgeMidpoint(edge: Edge): { x: number; y: number } | null {
    if (!flowApi) return null;
    const src = flowApi.getInternalNode(edge.source.nodeId);
    const dst = flowApi.getInternalNode(edge.target.nodeId);
    if (!src || !dst) return null;
    const srcPt = handlePointAbsolute(src, 'source', edge.source.portId);
    const dstPt = handlePointAbsolute(dst, 'target', edge.target.portId);
    if (!srcPt || !dstPt) return null;
    return { x: (srcPt.x + dstPt.x) / 2, y: (srcPt.y + dstPt.y) / 2 };
  }

  function handlePointAbsolute(
    internal: InternalFlowNode,
    side: 'source' | 'target',
    portId: string,
  ): { x: number; y: number } | null {
    const pa = internal.internals?.positionAbsolute
      ?? { x: (internal.position?.x ?? 0), y: (internal.position?.y ?? 0) };
    const bucket = internal.internals?.handleBounds?.[side];
    const handle = bucket?.find((h) => h.id === portId);
    if (handle) {
      return {
        x: pa.x + handle.x + handle.width / 2,
        y: pa.y + handle.y + handle.height / 2,
      };
    }
    // Fallback: approximate as left/right midpoint of the node's
    // bounding box. Conservative — keeps the splice working immediately
    // after spawn before handle bounds get measured.
    const w = internal.measured?.width ?? 240;
    const h = internal.measured?.height ?? 200;
    return {
      x: pa.x + (side === 'source' ? w : 0),
      y: pa.y + h / 2,
    };
  }

  /** Pick the first input port on `inputs` whose type accepts a cable
   *  carrying `cableType`. Mirrors PR-118's first-declared selection
   *  rule so the spawn path and the dblclick-corner-trigger path agree. */
  function firstCompatibleInput(inputs: PortDef[] | undefined, cableType: CableType): PortDef | undefined {
    if (!inputs) return undefined;
    return inputs.find((p) => canConnect(cableType, p.type));
  }
  /** Pick the first output port whose type can drive `dstType`. */
  function firstCompatibleOutput(outputs: PortDef[] | undefined, dstType: CableType): PortDef | undefined {
    if (!outputs) return undefined;
    return outputs.find((p) => canConnect(p.type, dstType));
  }

  /** Search every edge in the current snapshot for one whose midpoint
   *  lies within INSERT_ON_CABLE_THRESHOLD_PX of `pos`, AND for which
   *  the new module def `newDef` has a compatible input + output for
   *  the cable's source / target types. Returns the first match (sorted
   *  by edge id for determinism) or null. */
  function tryFindInsertSpliceTarget(
    pos: { x: number; y: number },
    newDef: { inputs?: PortDef[]; outputs?: PortDef[] } | undefined,
  ): { edge: Edge; inPort: PortDef; outPort: PortDef } | null {
    if (!newDef) return null;
    const threshold = INSERT_ON_CABLE_THRESHOLD_PX;
    const t2 = threshold * threshold;
    const edges = [...snapshot.edges].sort((a, b) => a.id.localeCompare(b.id));
    for (const e of edges) {
      const mid = edgeMidpoint(e);
      if (!mid) continue;
      const dx = mid.x - pos.x;
      const dy = mid.y - pos.y;
      if (dx * dx + dy * dy > t2) continue;
      const inPort = firstCompatibleInput(newDef.inputs, e.sourceType);
      if (!inPort) continue;
      // Output side: pick the first declared output that can drive the
      // downstream port. The downstream port's declared type is
      // edge.targetType; canConnect(outPort.type, targetType) gates it.
      const outPort = firstCompatibleOutput(newDef.outputs, e.targetType);
      if (!outPort) continue;
      return { edge: e, inPort, outPort };
    }
    return null;
  }

  let bootPromise: Promise<PatchEngine> | null = null;
  async function ensureEngine(): Promise<PatchEngine> {
    if (engine) return engine;
    // Memoize the in-flight boot. Without this, two parallel callers
    // (e.g. two parallel callers) each create their
    // own AudioContext, racing to overwrite the engine + reconciler bindings.
    if (bootPromise) return bootPromise;
    bootPromise = (async () => {
      try {
        audioCtx = new AudioContext();
        if (audioCtx.state === 'suspended') await audioCtx.resume();
        const e = new PatchEngine();
        e.registerDomain(new AudioEngine(audioCtx));
        // Video engine — registers alongside audio so a single PatchEngine
        // dispatches both. Construction is cheap (no GL alloc until a video
        // module is added; OffscreenCanvas + WebGL2 init does happen here).
        // If WebGL2 is unsupported we surface the error via the trace log
        // but keep the audio path alive — this lets the existing audio
        // demo run on browsers that lack WebGL2.
        try {
          e.registerDomain(new VideoEngine());
          trace('video engine registered');
        } catch (videoErr) {
          console.warn('[canvas] video engine unavailable:', videoErr);
          trace(`video engine unavailable: ${videoErr instanceof Error ? videoErr.message : videoErr}`);
        }
        reconciler = attachReconciler(e);
        engine = e;
        trace(`engine + reconciler attached (sr=${audioCtx.sampleRate})`);
        return e;
      } catch (err) {
        bootPromise = null; // allow retry on next call
        throw err;
      }
    })();
    return bootPromise;
  }

  // ---------------- Awareness wiring (B4) ----------------
  //
  // Sets the local awareness state's `user` field once the provider attaches,
  // then forwards pointer-move events on the .flow region as `cursor` updates
  // throttled to ~60Hz via requestAnimationFrame. Y.Awareness GCs disconnected
  // peers automatically (30s default); the provider's destroy() also
  // broadcasts a null state so peers see cursors disappear immediately.
  let flowEl = $state<HTMLDivElement | null>(null);

  $effect(() => {
    const p = provider;
    const user = presenceUser;
    if (!p || !user) return;
    const awareness = p.awareness;
    if (!awareness) return;
    // Publish our presence identity now…
    awareness.setLocalStateField('user', user);
    // …and RE-PUBLISH it on every (re)connect / sync. This is the presence-
    // reliability fix for the relay-restart class: the Fly relay holds
    // awareness in PROCESS MEMORY (no persistence), so when it restarts (or a
    // client reconnects to a fresh machine) the server's awareness set is
    // EMPTY — every peer momentarily "alone in its own view" (the live
    // "1/4 members" / DOOM split-brain symptom). The HocuspocusProvider already
    // re-sends local awareness inside startSync() on reconnect, but only when
    // getLocalState() !== null; re-asserting the `user` field on the provider's
    // own connect/sync events guarantees it is re-broadcast even if our local
    // awareness was cleared in between, so presence reconverges within one
    // reconnect cycle instead of waiting for an unrelated future awareness
    // write. Cheap + idempotent (y-protocols dedupes an identical state).
    const republish = () => {
      try {
        awareness.setLocalStateField('user', user);
      } catch {
        /* provider mid-teardown — the next event will re-assert */
      }
    };
    // 'synced' fires on the initial handshake AND every reconnect handshake;
    // 'status' → connected covers the websocket-level reconnect. Subscribe to
    // both so neither a fresh relay machine nor an in-memory wipe leaves us
    // unseen. HocuspocusProvider's emitter tolerates unknown events as no-ops.
    p.on('synced', republish);
    p.on('status', republish);
    return () => {
      try {
        p.off('synced', republish);
        p.off('status', republish);
      } catch {
        /* emitter may be gone */
      }
      try {
        awareness.setLocalState(null);
      } catch {
        /* provider may already be torn down */
      }
    };
  });

  $effect(() => {
    const p = provider;
    const root = flowEl;
    if (!p || !root) return;
    const awareness = p.awareness;
    if (!awareness) return;
    let pendingX = 0;
    let pendingY = 0;
    let hasPending = false;
    let rafId: number | null = null;
    const flush = () => {
      rafId = null;
      if (!hasPending) return;
      hasPending = false;
      awareness.setLocalStateField('cursor', { x: pendingX, y: pendingY });
    };
    const onMove = (e: PointerEvent) => {
      const rect = root.getBoundingClientRect();
      pendingX = e.clientX - rect.left;
      pendingY = e.clientY - rect.top;
      hasPending = true;
      if (rafId === null) rafId = requestAnimationFrame(flush);
    };
    const onLeave = () => {
      hasPending = false;
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      const local = awareness.getLocalState();
      if (local && 'cursor' in (local as object)) {
        const next = { ...(local as Record<string, unknown>) };
        delete next.cursor;
        awareness.setLocalState(next);
      }
    };
    root.addEventListener('pointermove', onMove);
    root.addEventListener('pointerleave', onLeave);
    return () => {
      root.removeEventListener('pointermove', onMove);
      root.removeEventListener('pointerleave', onLeave);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  });

  // Dev-only: expose helpers so @collab Playwright tests can drive the
  // awareness layer without wiring real Clerk auth + pointer events.
  if (testHooksEnabled()) {
    $effect(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__setLocalCursor = (x: number, y: number) => {
        const a = provider?.awareness;
        if (!a) return false;
        a.setLocalStateField('cursor', { x, y });
        return true;
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__getRemoteCursors = () => {
        const a = provider?.awareness;
        if (!a) return [];
        const out: Array<{ clientId: number; user: unknown; cursor?: unknown }> = [];
        for (const [clientId, state] of a.getStates()) {
          if (clientId === a.clientID) continue;
          const s = state as { user?: unknown; cursor?: unknown };
          if (!s?.user) continue;
          out.push({ clientId, user: s.user, cursor: s.cursor });
        }
        return out;
      };
      // Simulated-MIDI injection hook for e2e: lazily installs an in-memory
      // fake MIDIAccess and pushes a Control-Change message through the same
      // dispatch path real hardware uses. DEV-only — stripped in prod builds.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__midiTestInject = (channel: number, cc: number, value: number) => {
        const send = installSimulatedMidiDevice();
        send(channel, cc, value);
        return true;
      };
      // Install the fake device WITHOUT sending — so a subsequent beginLearn()
      // resolves connect() against the sim device instead of the real
      // navigator.requestMIDIAccess() (which prompts / can hang in headless).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__midiTestInstall = () => {
        installSimulatedMidiDevice();
        return true;
      };
      // midi-learn singleton API for e2e. The midi REGRESSION spec needs to
      // drive exportBindings/importBindings/connect against the SAME module
      // singleton the app uses. It previously did `import('/src/lib/midi/...')`
      // inside page.evaluate, which only resolves under the Vite DEV server —
      // under the prebuilt `vite preview` bundle (E2E_USE_PREVIEW=1) that
      // /src/ path 404s. Exposing the already-bundled functions here keeps the
      // spec working against the production-like build.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__midiLearnApi = {
        exportBindings: () => exportMidiBindings(),
        importBindings: (b: unknown[]) => importMidiBindings(b as Parameters<typeof importMidiBindings>[0]),
        connect: () => connectMidiLearn(),
      };
      // midi-clock-source singleton accessor — same /src/-import-under-preview
      // problem as __midiLearnApi above (the MIDI Clock BPM-derivation spec).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__midiClockSource = () => getMidiClockSource();
      // picturebox encode/decode helpers — the video-orientation PICTUREBOX
      // spec drives the REAL production encode→decode path to inject a test
      // image. Lazily imported (the bundled $lib specifier, NOT a /src/ URL)
      // so it resolves under `vite preview` too. Lazy keeps the video chunk
      // out of the main canvas bundle for non-test prod builds.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__pictureboxEncode = async () => {
        const m = await import('$lib/video/modules/picturebox-encode');
        return { downscaleAndEncode: m.downscaleAndEncode, base64ToImageBitmap: m.base64ToImageBitmap };
      };
    });
  }

  // ---------------- B5 audio gate ----------------
  // The optional AudioGate store (passed in by /r/[id]/+page.svelte) needs
  // (a) the boot function to call on first user gesture and (b) the live
  // AudioContext so it can track suspend/resume state.
  $effect(() => {
    if (!audioGate) return;
    audioGate.setBooter(async () => {
      const e = await ensureEngine();
      return { ctx: audioCtx ?? undefined, engine: e };
    });
    return () => {
      audioGate.setBooter(null);
    };
  });
  $effect(() => {
    if (!audioGate) return;
    audioGate.bind(audioCtx);
  });

  // ---------------- Undo / redo (Cmd-Z / Cmd-Shift-Z) ----------------
  // Y.UndoManager scoped to this client's edits only (LOCAL_ORIGIN). Remote
  // collaborators' ops arrive with a different origin and are intentionally
  // skipped by the manager — Cmd-Z means "undo what I just did," matching
  // multiplayer expectations. captureTimeout (500ms) coalesces bursts so a
  // drag-knob-then-release becomes one undo entry instead of dozens.
  $effect(() => {
    function isUndo(e: KeyboardEvent): boolean {
      const mod = e.metaKey || e.ctrlKey;
      return mod && !e.shiftKey && (e.key === 'z' || e.key === 'Z');
    }
    function isRedo(e: KeyboardEvent): boolean {
      const mod = e.metaKey || e.ctrlKey;
      // Cmd-Shift-Z (mac standard) AND Cmd-Y (windows standard) both mapped.
      return (
        mod && ((e.shiftKey && (e.key === 'z' || e.key === 'Z')) || e.key === 'y' || e.key === 'Y')
      );
    }
    function shouldIgnore(target: EventTarget | null): boolean {
      // Don't hijack OS-level undo inside text inputs (note-name boxes,
      // save/load dialogs, anywhere a textarea is focused). Lets the
      // browser handle text-edit undo natively.
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return true;
      return false;
    }
    function onKey(e: KeyboardEvent) {
      if (shouldIgnore(e.target)) return;
      if (isUndo(e)) {
        if (undoManager.undoStack.length === 0) return;
        e.preventDefault();
        undoManager.undo();
        trace('undo');
      } else if (isRedo(e)) {
        if (undoManager.redoStack.length === 0) return;
        e.preventDefault();
        undoManager.redo();
        trace('redo');
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Dev-only: expose undoManager so e2e tests can assert state without
  // racing against the captureTimeout debouncer. Gated on testHooksEnabled()
  // so it's present in the preview bundle (VITE_E2E_HOOKS=1) too.
  if (testHooksEnabled()) {
    $effect(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__undoManager = undoManager;
    });
  }

  // ---------------- Card / cable hover affordances ----------------
  //
  // hoveredNodeId (declared near the top of <script>) is set on
  // .svelte-flow__node mouseenter and cleared on mouseleave. Two CSS
  // hooks consume it:
  //   1. a `data-hovered-node` attribute on the .svelte-flow root, so
  //      `.svelte-flow[data-hovered-node]` can dim non-related cables;
  //   2. a `cable-related` class on each edge whose source or target
  //      matches the hovered node, so dimmed sibling cables don't dim
  //      the ones a user is trying to trace.

  /** Programmatically wire mouseover/leave on the .flow root so we don't
   *  invite a11y warnings on a <div> that has no other interactive role.
   *  Walks up the DOM from e.target to find the nearest .svelte-flow__node
   *  and reads its data-id. */
  $effect(() => {
    const root = flowEl;
    if (!root) return;
    const onOver = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const node = target.closest('.svelte-flow__node');
      if (node) {
        const id = node.getAttribute('data-id');
        if (id && id !== hoveredNodeId) hoveredNodeId = id;
      } else if (hoveredNodeId !== null) {
        hoveredNodeId = null;
      }
    };
    const onLeave = () => {
      hoveredNodeId = null;
    };
    root.addEventListener('mouseover', onOver);
    root.addEventListener('mouseleave', onLeave);
    return () => {
      root.removeEventListener('mouseover', onOver);
      root.removeEventListener('mouseleave', onLeave);
    };
  });

  // (Edges receive the `cable-related` class via the snapshot→flowEdges
  // mapper above, which reads hoveredNodeId. Single source of truth, no
  // ping-pong between effects.)

  // Push the hovered-node id onto the .svelte-flow root so the global
  // [data-hovered-node] selector can fire.
  $effect(() => {
    if (!flowEl) return;
    const root = flowEl.querySelector('.svelte-flow');
    if (!root) return;
    if (hoveredNodeId) root.setAttribute('data-hovered-node', hoveredNodeId);
    else root.removeAttribute('data-hovered-node');
  });

  // ---------------- Module-name migration ----------------
  // First-paint: if any existing node lacks a `data.name`, assign it the
  // next-available <TYPE><N> default. Idempotent — re-runs are no-ops.
  // Wraps in a transact so the assigned names show up as one Yjs update
  // (single undo entry, one collaborative broadcast). The migration is
  // ordered by node id so two clients running it concurrently land on
  // identical names.
  $effect(() => {
    void snapshot; // re-check after snapshots arrive (e.g. multiplayer load)
    let needs = 0;
    for (const node of Object.values(patch.nodes)) {
      if (!node) continue;
      if (typeof node.data?.name === 'string') continue;
      needs++;
      if (needs > 0) break;
    }
    if (needs === 0) return;
    ydoc.transact(() => {
      migrateAssignNames(patch.nodes);
    }, LOCAL_ORIGIN);
  });

  // ---------------- MiniMap toggle ----------------
  let minimapOpen = $state(true);

  onDestroy(() => {
    reconciler?.dispose();
    engine?.dispose();
    audioGate?.bind(null);
  });

  let nodeCount = $derived(flowNodes.length);
  let edgeCount = $derived(flowEdges.length);
  let availableModules = $derived(listModuleDefs().length + listVideoModuleDefs().length);
</script>

<div class="root" class:lasso-mode={lassoMode} data-testid="canvas-root">
  <header class="topbar">
    <h1>2600hz</h1>
    <div class="actions">
      <button onclick={openPaletteFromButton}>+ Add module</button>
      <button
        onclick={() => spawnCabinet('55')}
        disabled={booting}
        data-testid="moog-system-55-btn"
        title="Spawn a full moogafakkin System 55 cabinet — every module laid out in two rows mirroring the real Moog cabinet (Fig 48)."
      >
        {booting ? 'Loading…' : 'moogafakkin System 55'}
      </button>
      <button
        onclick={() => spawnCabinet('35')}
        disabled={booting}
        data-testid="moog-system-35-btn"
        title="Spawn a full moogafakkin System 35 cabinet — every module laid out in two rows mirroring the real Moog cabinet (Fig 47)."
      >
        {booting ? 'Loading…' : 'moogafakkin System 35'}
      </button>
      <button onclick={loadExample} disabled={booting} class="primary">
        {booting ? 'Loading…' : 'Load example'}
      </button>
      <button
        onclick={loadGlitches}
        disabled={booting}
        class="primary glitches"
        title="Audio+video demo patch — loads a curated rackspace with PICTUREBOX (pre-loaded with glitch.jpg), Rutt-Etra, LFOs, drum machine, and modulation. Streams immediately."
        data-testid="load-glitches-btn"
      >
        {booting ? 'Loading…' : 'GLITCHES GET RICHES'}
      </button>
      <button
        onclick={loadMediaBurn}
        disabled={booting}
        class="primary glitches"
        title="Homage to Ant Farm's 1975 Media Burn — 15 PICTUREBOX tiles reassemble the photo, then a CADILLAC drives R→L and demolishes them ~1s after load."
        data-testid="load-media-burn-btn"
      >
        {booting ? 'Loading…' : 'Media Burn'}
      </button>
      <button
        onclick={savePatch}
        disabled={nodeCount === 0}
        title="Download a .imp.json backup of this rack (auto-save to your account already runs while you edit; this button gives you a portable file)."
      >Save</button>
      <button
        onclick={loadPatch}
        title="Replace the current rack with a .imp.json file from disk."
      >Load</button>
      <button onclick={clearPatch} disabled={nodeCount === 0}>Clear</button>
      <button
        onclick={savePerformance}
        disabled={nodeCount === 0 || !perfSupported}
        data-testid="save-perf-btn"
        title={perfSupported
          ? 'Save the WHOLE track (patch + positions + images + samples + video handles + MIDI/gamepad maps) into a named slot in THIS browser. Reload + Load Perf brings it all back on the same profile.'
          : 'Unavailable: needs IndexedDB (not in this browser).'}
      >Save Perf</button>
      <button
        onclick={loadPerformance}
        disabled={!perfSupported}
        data-testid="load-perf-btn"
        title={perfSupported
          ? 'Restore a saved local performance. Reloads the patch + inline assets; re-acquires video files (one click to re-allow on Chromium) + re-binds MIDI/gamepad.'
          : 'Unavailable: needs IndexedDB (not in this browser).'}
      >Load Perf</button>
      <SkinSwitcher />
      {#if headerSignedIn}
        <a
          class="account-link"
          href="/dashboard"
          data-testid="account-link"
          title="Your dashboard"
        >
          {#if headerAuth?.imageUrl}
            <img class="account-avatar" src={headerAuth.imageUrl} alt="Account" />
          {:else}
            <span class="account-avatar account-avatar-fallback">
              {headerAuth?.initials ?? '\u{1F464}'}
            </span>
          {/if}
        </a>
      {:else}
        <a class="signin-link" href="/dashboard" data-testid="signin-link">Sign in</a>
      {/if}
    </div>
  </header>

  {#if error}
    <pre class="error">{error}</pre>
  {/if}

  <div class="flow" bind:this={flowEl}>
    <SvelteFlow
      nodes={flowNodes}
      edges={flowEdges}
      {nodeTypes}
      fitView
      colorMode="dark"
      zoomOnDoubleClick={false}
      onconnect={handleConnect}
      onconnectstart={handleConnectStart}
      onconnectend={handleConnectEnd}
      onclickconnectstart={handleClickConnectStart}
      onclickconnectend={handleClickConnectEnd}
      connectionDragThreshold={5}
      ondelete={handleDelete}
      onnodedragstop={handleNodeDragStop}
      onpanecontextmenu={onPaneContextMenu}
      onnodecontextmenu={onNodeContextMenu}
      onselectioncontextmenu={onSelectionContextMenu}
    >
      <Background size={1} gap={16} bgColor="#0e1116" patternColor="#1f242c" />
      <Controls />
      {#if minimapOpen}
        <MiniMap
          position="bottom-right"
          width={160}
          height={110}
          pannable
          zoomable
          ariaLabel="Canvas overview"
          maskColor="rgba(0, 240, 255, 0.06)"
          nodeColor="#1c2a32"
          nodeStrokeColor="#00f0ff"
          nodeStrokeWidth={1}
          nodeBorderRadius={2}
        />
      {/if}
      <FlowBridge bind:api={flowApi} />
      <CadillacOverlay {provider} />
      <!-- 2026-05-27: the per-node editable name label moved INSIDE every
           module card's title chrome (see ModuleTitle.svelte). The floating
           NodeToolbar overhead label was dropped — the spec asks for the
           user-given instance name to sit "where the module name is", not
           hovering above the card. Removing this block also cleans up the
           "WAVESCULPT1" orange badge that used to overlap with the card
           title. The cards' new in-title name button keeps the same
           data-testid hooks ('name-label-button' / 'name-label-input' /
           'name-label-error') so existing e2e selectors still resolve. -->
    </SvelteFlow>
    <button
      type="button"
      class="minimap-toggle"
      class:open={minimapOpen}
      data-testid="minimap-toggle"
      title={minimapOpen ? 'Hide minimap' : 'Show minimap'}
      aria-pressed={minimapOpen}
      onclick={() => (minimapOpen = !minimapOpen)}
    >
      {minimapOpen ? '▾ map' : '▴ map'}
    </button>
    <AwarenessLayer {provider} />
    <PickupCable />
    {#if lassoMode && lassoOriginFlow}
      <LassoOverlay origin={lassoOriginScreen} cursor={lassoCursorScreen} />
    {/if}
    {#if anyGroupExpanded}
      <!-- Module-grouping Phase 2A: floating "Update group" CTA visible
           whenever any group is expanded. One click collapses every
           expanded group so the user never gets stuck in edit-knob mode. -->
      <button
        type="button"
        class="update-group-cta"
        data-testid="update-group-cta"
        onclick={collapseAllExpandedGroups}
        title="Finish editing instrument(s)"
      >
        Save instrument
      </button>
    {/if}
  </div>

  <footer class="bottombar">
    <div class="status">
      <span>nodes <b>{nodeCount}</b></span>
      <span>edges <b>{edgeCount}</b></span>
      <span title="Number of distinct module types in the registry (catalog size, not live instance count)">catalog <b>{availableModules}</b></span>
      <span>ctx <b>{audioCtx?.state ?? '—'}</b></span>
      <span>sr <b>{audioCtx?.sampleRate ?? '—'}</b></span>
    </div>
    <ul class="cable-legend">
      <li><span class="swatch audio"></span> audio</li>
      <li><span class="swatch pitch"></span> pitch</li>
      <li><span class="swatch gate"></span> gate</li>
      <li><span class="swatch cv"></span> CV</li>
      <li><span class="swatch polyPitchGate"></span> poly</li>
      <!-- Phase 0 video-domain cables. Swatch styles are colocated in the
           same .swatch ruleset below; declared here in legend order -->
      <li><span class="swatch keys"></span> keys</li>
      <li><span class="swatch image"></span> image</li>
      <li><span class="swatch mono-video"></span> m-video</li>
      <li><span class="swatch video"></span> video</li>
    </ul>
  </footer>

  <details class="trace-panel">
    <summary>trace ({log.length})</summary>
    {#each log as line, i (i)}
      <div class="log-line">{line}</div>
    {/each}
  </details>
</div>

<ModulePalette
  bind:open={paletteOpen}
  x={palettePos.x}
  y={palettePos.y}
  isRackOwner={localIsRackOwner}
  onselect={spawnFromPalette}
  onorganize={organizeModules}
  oncreategroup={() => enterLassoMode(palettePos.x, palettePos.y)}
  oninsertsavedgroup={currentUserId ? openSavedGroupsPicker : undefined}
  onclose={() => (paletteOpen = false)}
/>

<NodeContextMenu
  bind:open={ctxMenuOpen}
  x={ctxMenuPos.x}
  y={ctxMenuPos.y}
  nodeLabel={ctxMenuLabel}
  nodeType={ctxMenuNodeType}
  isGroup={ctxMenuNodeType === 'group'}
  groupExpanded={ctxMenuGroupExpanded}
  canSaveGroup={Boolean(currentUserId) && ctxMenuNodeType === 'group'}
  canSeeSnesOutputDef={ctxMenuCanSeeSnesOutputDef}
  onseesnesoutputdef={() => {
    if (!ctxMenuNodeId) return;
    // The Snes9xCard listens for this window event keyed by node id +
    // opens its per-ROM CV/GATE output-definition panel.
    window.dispatchEvent(
      new CustomEvent('snes9x:show-output-def', { detail: { nodeId: ctxMenuNodeId } }),
    );
  }}
  ondelete={() => {
    if (!ctxMenuNodeId) return;
    if (ctxMenuNodeType === 'group') deleteGroupAndChildren(ctxMenuNodeId);
    else deleteNode(ctxMenuNodeId);
  }}
  onduplicate={() => ctxMenuNodeId && duplicateNode(ctxMenuNodeId)}
  onunpatch={() => ctxMenuNodeId && unpatchNode(ctxMenuNodeId)}
  onungroup={() => ctxMenuNodeId && ungroupNode(ctxMenuNodeId)}
  ontoggleexpanded={() => ctxMenuNodeId && toggleGroupExpanded(ctxMenuNodeId)}
  oneditexposed={() => ctxMenuNodeId && openEditExposedJacks(ctxMenuNodeId)}
  onconfigurecontrols={() => ctxMenuNodeId && openConfigureExposedControls(ctxMenuNodeId)}
  onduplicategroup={() => ctxMenuNodeId && duplicateGroupAction(ctxMenuNodeId)}
  onsavegroup={() => ctxMenuNodeId && void saveGroupToLibrary(ctxMenuNodeId)}
  onclose={() => { ctxMenuOpen = false; ctxMenuNodeId = null; }}
/>

<SavedGroupsPicker
  bind:open={savedGroupsPickerOpen}
  oninsert={(sg) => insertSavedGroup(sg)}
  onclose={() => (savedGroupsPickerOpen = false)}
/>

<SelectionContextMenu
  bind:open={selCtxMenuOpen}
  x={selCtxMenuPos.x}
  y={selCtxMenuPos.y}
  selectionCount={selCtxMenuIds.length}
  lockedByRemote={selCtxMenuLockedByRemote}
  ongroup={openGroupBuilder}
  onclose={() => { selCtxMenuOpen = false; }}
/>

<GroupBuilderModal
  bind:open={groupBuilderOpen}
  candidates={groupBuilderCandidates}
  selectionIds={groupBuilderSelectionIds}
  moduleLabels={groupBuilderModuleLabels}
  existingExposedPorts={editExposedExistingPorts}
  existingLabel={editExposedExistingLabel}
  oncreate={(picks, label) => {
    if (editExposedGroupId) commitEditExposed(picks, label);
    else commitGroup(picks, label);
  }}
  onclose={() => {
    groupBuilderOpen = false;
    editExposedGroupId = null;
    editExposedExistingPorts = undefined;
    editExposedExistingLabel = undefined;
  }}
/>

<ExposedControlsModal
  bind:open={configureControlsOpen}
  children={configureControlsChildren}
  existing={configureControlsExisting}
  existingSequences={configureControlsExistingSequences}
  onsave={commitExposedControls}
  onclose={() => {
    configureControlsOpen = false;
    configureControlsGroupId = null;
    configureControlsChildren = [];
    configureControlsExisting = [];
    configureControlsExistingSequences = {};
  }}
/>

<PortContextMenu
  bind:open={portMenuOpen}
  x={portMenuPos.x}
  y={portMenuPos.y}
  sourceLabel={portMenuSourceLabel}
  moduleEntries={portMenuModuleEntries}
  candidatesFor={portMenuCandidatesFor}
  onpick={pickPortMenuTarget}
  onclose={() => {
    portMenuOpen = false;
    portMenuSourceNodeId = null;
    portMenuSourcePortId = null;
    connectDragState.endCascade();
  }}
/>

<style>
  .root {
    height: 100vh;
    display: flex;
    flex-direction: column;
    background: var(--bg);
    color: var(--text);
  }
  .root > .topbar,
  .root > .error,
  .root > .bottombar,
  .root > .trace-panel {
    flex: 0 0 auto;
  }
  .root > .flow {
    flex: 1 1 auto;
  }
  .topbar {
    display: flex;
    align-items: baseline;
    gap: 1rem;
    padding: 0.8rem 1.25rem;
    border-bottom: 1px solid #1f242c;
  }
  .topbar h1 {
    margin: 0;
    font-weight: 500;
    font-size: 1.05rem;
  }
  .topbar .caption {
    color: var(--text-dim);
    font-size: 0.8rem;
  }
  .topbar .actions {
    margin-left: auto;
    display: flex;
    gap: 0.4rem;
  }
  .topbar button {
    background: #2a2f3a;
    color: var(--text);
    border: 1px solid #404652;
    padding: 0.35rem 0.8rem;
    font-size: 0.8rem;
    border-radius: 4px;
    cursor: pointer;
  }
  .topbar button.primary {
    background: var(--cable-audio);
    color: #1a1d23;
    border-color: var(--cable-audio);
  }
  /* Glitches = big curated demo — distinct deep-aquatic styling so users
     read it as "this is the big one" vs the simpler Load-example.
     Inherited from the retired "Visit Atlantis" button (same slot, same
     visual weight); only the type-id changed. */
  .topbar button.primary.glitches {
    background: linear-gradient(135deg, #2c5b8f 0%, #1b3252 100%);
    color: #c5e3ff;
    border-color: #4a7daa;
    text-shadow: 0 1px 0 rgba(0, 0, 0, 0.4);
  }
  .topbar button.primary.glitches:hover:not(:disabled) {
    background: linear-gradient(135deg, #3a6ea8 0%, #25416a 100%);
    border-color: #6ba0d4;
  }
  .topbar button:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .topbar .signin-link {
    background: #2a2f3a;
    color: var(--text);
    border: 1px solid #404652;
    padding: 0.35rem 0.8rem;
    font-size: 0.8rem;
    border-radius: 4px;
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    margin-left: 0.4rem;
  }
  .topbar .signin-link:hover {
    background: #353a47;
  }
  .topbar .account-link {
    display: inline-flex;
    align-items: center;
    margin-left: 0.4rem;
    text-decoration: none;
  }
  .topbar .account-avatar {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    border: 1px solid #404652;
    object-fit: cover;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .topbar .account-avatar-fallback {
    background: #2a2f3a;
    color: var(--text);
    font-size: 0.72rem;
    font-weight: 600;
    line-height: 1;
  }
  .topbar .account-link:hover .account-avatar {
    border-color: #6ba0d4;
  }
  .flow {
    position: relative;
    width: 100%;
    min-height: 0;
    /* Svelte Flow expects an absolutely-positioned parent so its viewport
     * can fill it; without this, .svelte-flow renders with zero height in
     * a CSS grid 1fr row and the canvas appears empty even though nodes
     * exist in the DOM. */
  }
  .flow :global(.svelte-flow) {
    position: absolute;
    inset: 0;
    background: var(--bg);
  }
  /* MiniMap toggle: tiny pill above the bottom-right minimap. Pure chrome,
   * uses --accent for hover so a power user can collapse the overview when
   * working tight to the corner of the canvas. */
  .minimap-toggle {
    position: absolute;
    bottom: 8px;
    right: 12px;
    z-index: 6;
    background: rgba(14, 17, 22, 0.85);
    color: var(--text-dim);
    /* Skin-aware border; matches the lifted --border surface used by
     * .mod-card so chrome reads as one family across themes. */
    border: 1px solid var(--border);
    border-radius: 2px;
    padding: 2px 8px;
    font-size: 0.65rem;
    font-family: ui-monospace, monospace;
    letter-spacing: 0.04em;
    cursor: pointer;
    transition: color 80ms ease-out, border-color 80ms ease-out, bottom 120ms ease-out;
  }
  .minimap-toggle:hover {
    color: var(--accent);
    border-color: var(--accent-dim);
  }
  .minimap-toggle.open {
    bottom: 124px;
  }
  /* Module-grouping Phase 2A: "Update group" floating CTA pinned to the
   * top-center of the canvas viewport while any group is expanded. */
  .update-group-cta {
    position: absolute;
    top: 12px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 12;
    background: var(--accent, #60a5fa);
    color: #0e1116;
    border: 1px solid var(--accent, #60a5fa);
    border-radius: 4px;
    padding: 6px 14px;
    font-size: 0.8rem;
    font-family: inherit;
    cursor: pointer;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45);
  }
  .update-group-cta:hover {
    filter: brightness(1.05);
  }
  /* Phase 3C: cards in a remote rack-mate's active group-builder selection
   * render semi-transparent + with a dashed outline so the local user can
   * see at a glance which modules are off-limits. */
  :global(.svelte-flow__node.remote-group-building) {
    opacity: 0.55;
    outline: 1px dashed var(--accent, #60a5fa);
    outline-offset: 2px;
    transition: opacity 120ms ease-out;
  }
  /* Lasso group-select: live highlight preview while the user drags the
   * Create-group bounding box. Solid accent outline distinguishes from
   * the dashed remote-group-building state above. */
  :global(.svelte-flow__node.lasso-hit) {
    outline: 2px solid var(--accent, #60a5fa);
    outline-offset: 2px;
  }
  /* Crosshair cursor while lasso mode is active. Class is toggled on
   * .root via class:lasso-mode in the markup. */
  .root.lasso-mode :global(.svelte-flow),
  .root.lasso-mode :global(.svelte-flow__pane),
  .root.lasso-mode :global(.svelte-flow__node) {
    cursor: crosshair !important;
  }
  .error {
    margin: 0;
    padding: 0.6rem 1.25rem;
    border-bottom: 1px solid var(--cable-gate);
    background: rgba(248, 113, 113, 0.08);
    color: #fca5a5;
    font-family: ui-monospace, monospace;
    font-size: 0.8rem;
  }
  .bottombar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.5rem 1.25rem;
    border-top: 1px solid #1f242c;
    font-size: 0.75rem;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
  }
  .status {
    display: flex;
    gap: 1rem;
  }
  .status b {
    color: var(--text);
    font-weight: 500;
  }
  .cable-legend {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    gap: 0.8rem;
  }
  .cable-legend li {
    display: flex;
    align-items: center;
    gap: 0.3rem;
  }
  .swatch {
    width: 18px;
    height: 3px;
    border-radius: 2px;
  }
  .swatch.audio { background: var(--cable-audio); }
  .swatch.pitch { background: var(--cable-pitch); }
  .swatch.gate { background: var(--cable-gate); }
  .swatch.cv { background: var(--cable-cv); }
  .swatch.polyPitchGate { background: var(--cable-polyPitchGate); }
  /* (2026-05-27) `.node-name-toolbar` styles deleted — the per-node
   * editable name label moved INSIDE each card's title chrome and is no
   * longer rendered via NodeToolbar. ModuleNameLabel keeps its own
   * inline styles (see ModuleNameLabel.svelte). */
  /* Video-domain swatches (Phase 0 spike). The CSS-class name shape
   * mirrors the cable-type id exactly so e.g. mono-video lines up
   * with --cable-mono-video without an extra mapping table. */
  .swatch.keys { background: var(--cable-keys); }
  .swatch.image { background: var(--cable-image); }
  .swatch.mono-video { background: var(--cable-mono-video); }
  .swatch.video { background: var(--cable-video); }
  .trace-panel {
    padding: 0.4rem 1.25rem 0.6rem;
    border-top: 1px solid #1f242c;
    font-family: ui-monospace, monospace;
    font-size: 0.7rem;
    color: var(--text-dim);
  }
  .trace-panel summary {
    cursor: pointer;
    color: var(--text);
  }
  .log-line {
    padding-left: 1rem;
    line-height: 1.5;
  }
</style>

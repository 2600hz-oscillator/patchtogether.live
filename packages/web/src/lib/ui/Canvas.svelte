<script lang="ts">
  // Day 7 — Svelte Flow canvas + module cards + auto-reactive engine.
  //
  // Click "Load example" → patch graph populates → Svelte Flow renders cards →
  // reconciler instantiates engine nodes → audio plays. Twiddle a knob →
  // patch graph mutates → reconciler calls engine.setParam → audible change.
  import { onDestroy, onMount } from 'svelte';
  import {
    SvelteFlow,
    Background,
    Controls,
    ControlButton,
    MiniMap,
    ConnectionMode,
    type Node as FlowNode,
    type Edge as FlowEdge,
    type Connection,
  } from '@xyflow/svelte';
  import { patch, ydoc, undoManager, LOCAL_ORIGIN } from '$lib/graph/store';
  import { buildDuplicate } from '$lib/graph/duplicate';
  import { instanceCount, wouldExceedCap } from '$lib/graph/cap';
  import { setControlColor, setNodeLocked } from '$lib/graph/mutate';
  import { snapPositionToGrid, findFreeRackSlot, RACK_UNIT, type RackRect } from '$lib/ui/rack-grid';
  import { resolveControlColor } from '$lib/graph/control-color';
  import {
    planSingletonCleanup,
    isElectedDeleter,
    isSafeToDelete,
    type CleanupPeer,
  } from '$lib/graph/singleton-cleanup';
  import { getDefaultSnapshotBus, type PatchSnapshot } from '$lib/graph/snapshot';
  import {
    makeEnvelope,
    makePortableEnvelope,
    parseEnvelope,
    loadEnvelopeIntoStore,
    downloadEnvelope,
    pickAndLoadEnvelope,
    DEFAULT_FILENAME,
    EnvelopeParseError,
    readVideoAspectFromDoc,
    writeVideoAspectToDoc,
    SETTINGS_MAP_KEY,
    type PatchEnvelope,
  } from '$lib/graph/persistence';
  import { flushAllCcCommits } from '$lib/ui/controls/cc-commit';
  import {
    makePerformanceBundle,
    validateBundle,
    BundleParseError,
    mergeMidiBindings,
    resolveMidiDeviceId,
    MIDI_DEVICE_NODE_TYPES,
    type ConnectedMidiInput,
  } from '$lib/graph/performance-bundle';
  import {
    buildPerformanceZip,
    parsePerformanceZip,
    type PerformanceMedia,
  } from '$lib/graph/performance-zip';
  import { savePerformanceZip } from '$lib/graph/performance-save';
  // Quick-switch PRESET SLOT bar (top-left of the menu bar) + the portable
  // `.set` container that bundles all five slots + the MIDI map. The pure
  // (de)serialize core lives in preset-set.ts; the per-browser IndexedDB
  // persistence in preset-slot-store.ts (zips are large → never localStorage).
  import {
    buildSet,
    parseSet,
    SLOT_COUNT,
    type SetSlot,
  } from '$lib/graph/preset-set';
  import {
    putSlot,
    getSlot,
    clearSlot as clearSlotStore,
    listOccupied,
  } from '$lib/graph/preset-slot-store';
  import { resolveAllVideoExports } from '$lib/video/video-export-registry';
  import { putVideoFileBlob } from '$lib/video/video-file-store';
  import {
    exportBindings as exportMidiBindings,
    importBindings as importMidiBindings,
    connect as connectMidiLearn,
  } from '$lib/midi/midi-learn.svelte';
  import { getMidiClockSource } from '$lib/midi/midi-clock-source';
  import { encodeTapeBytes, decodeTapeBytes } from '$lib/audio/modules/twotracks';

  function persistenceLoad(env: unknown, ydocArg: typeof ydoc, patchArg: typeof patch) {
    // Validate via parseEnvelope when a raw object is passed; if already typed,
    // pass through.
    let validated: PatchEnvelope;
    if (typeof env === 'object' && env !== null && typeof (env as PatchEnvelope).envelopeVersion === 'number') {
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
  import { setActiveEngine } from '$lib/audio/engine-ref';
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
  import { RACK_SIZE_DEFAULTS } from '$lib/ui/rack-sizes';
  import { computeCabinetLayout } from '$lib/ui/canvas/cabinet-layout';
  // ModuleNameLabel moved INTO every module card's title chrome (see
  // ModuleTitle.svelte) when the floating-overhead NodeToolbar was dropped.
  // Canvas no longer renders the label directly.
  import ModulePalette from '$lib/ui/ModulePalette.svelte';
  import { canAddModule } from '$lib/doom/doom-gating';
  import SavedGroupsPicker from '$lib/ui/SavedGroupsPicker.svelte';
  import NodeContextMenu from '$lib/ui/NodeContextMenu.svelte';
  import { MODULE_DOCS } from '$lib/docs/module-docs.generated';
  import { isAnnotating, toggleAnnotate, clearAnnotate } from '$lib/ui/annotate-mode.svelte';
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
  import AspectToggle from '$lib/ui/AspectToggle.svelte';
  import { videoAspectStore } from '$lib/ui/video-aspect-store.svelte';
  import { audioLatencyStore, type AudioLatencyMode } from '$lib/ui/audio-latency-store.svelte';
  import FlowBridge, { type FlowBridgeApi, type InternalFlowNode } from '$lib/ui/FlowBridge.svelte';
  import CadillacOverlay from '$lib/ui/CadillacOverlay.svelte';
  import PickupCable from '$lib/ui/PickupCable.svelte';
  import { organizeLayout, type Box } from '$lib/ui/canvas/organize';
  import type { CableType, Edge, PortDef, ModuleNode } from '$lib/graph/types';
  import { canConnect } from '$lib/graph/types';
  import { validateEdge } from '$lib/graph/validate-edge';
  import { planStereoAutowire } from '$lib/graph/stereo-autowire';
  import { computeEdgeAlignedRect } from '$lib/ui/patch-menu-position';
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
  import { installSimulatedMidiDevice, installSimulatedNoteDevice } from '$lib/midi/midi-learn.svelte';
  import { installSimulatedLaunchpad, installSimulatedLaunchpadSingle } from '$lib/control/launchpad/launchpad-device.svelte';
  import { bindLaunchpadToClip, __test_setDeployment, __test_mode as __launchpadTestMode } from '$lib/control/launchpad/launchpad-control.svelte';

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

  // Rack sizing: module type → resolved { size, hp }. The flowNodes derivation
  // tags each card's SvelteFlow wrapper (rack-sized rack-{1u,3u} + an inline
  // --rack-hp) so the shared _module-card.css forces its tier height + hp width.
  // Resolution: the def's own `size`/`hp` WIN (a new module declares them on its
  // def); the bulk RACK_SIZE_DEFAULTS map (rack-sizes.ts) is the fallback that
  // classifies every existing module so every card snaps to the grid.
  const rackSizeByType: Record<string, { size?: string; hp?: number }> = {};
  for (const d of [...listModuleDefs(), ...listVideoModuleDefs(), ...listMetaModuleDefs()]) {
    const r = d as { type: string; size?: string; hp?: number };
    const fallback = RACK_SIZE_DEFAULTS[r.type];
    const size = r.size ?? fallback?.size;
    if (size) rackSizeByType[r.type] = { size, hp: r.hp ?? fallback?.hp };
  }

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
      // Lets E2E tests exercise the connect-commit path directly — the
      // same xyflow `Connection` envelope a real pointer drag would
      // synthesize. Used by the instrument-exposed-port-patching spec
      // to assert that dragging onto a group's exposed handle creates
      // an edge in the patch (the bug it was added to regress against:
      // pre-fix, group endpoints bailed before the edge was added
      // because the def lookup returned no group def).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__handleConnect = (c: Connection) => handleConnect(c);
      // Cable-drag drill-down (no-auto-patch) e2e: drive the REAL drag
      // lifecycle (start → end) the same way SvelteFlow's pointer drag does,
      // without synthesizing pixel-perfect pointer moves on a stacked-handle
      // card. __handleConnectStart records the grabbed source; __handleConnectEnd
      // takes an explicit screen drop point so handleConnectEnd's elementFromPoint
      // resolves the dropped-on card exactly. Together they exercise the
      // suppress-snap + open-drill-down path end-to-end.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__handleConnectStart = (
        params: { nodeId: string | null; handleId: string | null; handleType: 'source' | 'target' | null },
      ) => handleConnectStart(new MouseEvent('mousedown'), params);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__handleConnectEnd = (drop: { x: number; y: number }) =>
        handleConnectEnd(new MouseEvent('mouseup', { clientX: drop.x, clientY: drop.y }));
      // Phase 4a — expose the SvelteFlow drag-time gate so e2e can assert
      // the drag-reject predicate (the same fn wired to the
      // isValidConnection prop) without synthesizing a real pointer drag.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__isValidConnection = (c: Connection) => isValidConnection(c);
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
        // Wrap the bound versions so tests can call without args. Flush any
        // in-flight coalesced CC commits first so a save mid-twist captures
        // the latest value, never a lagging one.
        save: () => {
          flushAllCcCommits();
          return makeEnvelope(ydoc);
        },
        load: (env: unknown) => {
          // Caller passes a parsed envelope object (or its JSON form).
          if (typeof env === 'string') {
            const parsed = JSON.parse(env);
            return loadEnvelopeFromObject(parsed);
          }
          return loadEnvelopeFromObject(env);
        },
      };
      // Portable performance .zip round-trip hook (e2e): export captures the zip
      // bytes WITHOUT a download dialog; load restores from captured bytes
      // WITHOUT a file picker. Mirrors the real button handlers exactly.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__perfZip = {
        export: async (): Promise<Uint8Array> => buildPerformanceZipBytes(),
        load: async (bytes: Uint8Array): Promise<void> => loadPerformanceZipBytes(bytes),
      };
      // Preset-slot bar + `.set` round-trip hook (e2e): store/read/clear slots
      // + build/load a `.set` WITHOUT a file dialog. Mirrors the real handlers.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__presetSet = {
        // Store captured perf-zip bytes directly into a slot (skips the picker).
        putSlot: async (index: number, bytes: Uint8Array, label?: string): Promise<void> => {
          await putSlot(index, bytes, label);
          slotOccupied[index] = true;
        },
        loadSlot: async (index: number): Promise<void> => loadSlot(index),
        clearSlot: async (index: number): Promise<void> => clearSlot(index),
        occupied: (): boolean[] => [...slotOccupied],
        buildSet: async (): Promise<Uint8Array> => buildSetBytes(),
        loadSet: async (bytes: Uint8Array): Promise<void> => loadSetBytes(bytes),
        refresh: async (): Promise<void> => refreshSlotOccupancy(),
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
        // Edge-delete e2e: headless Playwright can't click the thin SVG edge,
        // so the spec selects it through xyflow's real `selected` mutation,
        // then presses the real Backspace deleteKey.
        setEdgeSelected: (id: string, selected: boolean) =>
          flowApi?.setEdgeSelected(id, selected),
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
  // provider is bound — `/r/[id]` routes + the `/rack`+`__attachProvider`
  // collab-test pattern). The scratch `/rack` demo canvas (no provider) stays
  // empty until the user clicks Load example — auto-spawning there would
  // surprise the "demo a fresh engine" workflow and break a lot of e2e
  // tests that depend on a literally-empty canvas at `goto('/rack')`.
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

  // ---------------- Phase 4c: post-merge singleton cleanup ----------------
  //
  // Closes the undeletable-ghost race the auto-spawn comment above flags as
  // "future work". Two peers can each insert a TIMELORDE (or any type-level
  // maxInstances:1 module) before either sees the other's write; Yjs merges
  // both → a duplicate that the engine drops at runtime but, being
  // `undeletable: true`, the user can NEVER remove. This pass runs on the
  // CONVERGED snapshot and deterministically deletes the surplus.
  //
  // COLLAB SAFETY (see graph/singleton-cleanup.ts for the full rationale):
  //   - DETERMINISTIC SURVIVOR: keep the lex-SMALLEST id, delete the lex-larger
  //     duplicate(s) — matches the engine's eviction tie-break (#705).
  //   - SINGLE ELECTED DELETER: only ONE peer issues the delete (owner-pref,
  //     else lowest awareness clientID). Every-peer-deletes could race the
  //     type down to ZERO. Non-elected peers wait for the merge to converge.
  //   - RE-CHECK IN TRANSACT + NEVER-DELETE-LAST: the delete re-reads the live
  //     count inside the Yjs transact (isSafeToDelete) and refuses if removal
  //     would drop the type to zero → idempotent, double-delete-proof even if
  //     two peers momentarily both think they're elected.
  //
  // This lives HERE (a snapshot $effect with ydoc + LOCAL_ORIGIN), NOT in the
  // audio reconciler — the reconciler is audio-only and runs on EVERY peer, so
  // a delete there would double-delete. SCOPE is type-level maxInstances only;
  // per-user caps (picturebox/camera/samsloop) are excluded inside the helper.
  $effect(() => {
    // React to snapshot convergence — re-runs whenever the merged doc changes.
    const nodes = snapshot.nodes;
    if (nodes.length === 0) return;

    // Build the awareness roster for the elected-deleter decision. No provider
    // (public `/` demo / single-user) → empty roster + null localClientID, and
    // isElectedDeleter treats that as "lone deleter".
    const aw = provider?.awareness;
    const localClientID: number | null = aw ? aw.clientID : null;
    const peers: CleanupPeer[] = [];
    if (aw) {
      for (const [clientID, state] of aw.getStates()) {
        const u = (state as { user?: { isRackOwner?: boolean } } | undefined)?.user;
        peers.push({ clientID, isRackOwner: u?.isRackOwner === true });
      }
    }
    if (!isElectedDeleter(localClientID, peers)) return; // a rack-mate handles it

    // Plan against the converged snapshot (deterministic lex-survivor).
    const plan = planSingletonCleanup(
      patch.nodes as Record<string, { id: string; type: string } | null | undefined>,
      defLookup,
    );
    if (plan.length === 0) return;

    // Issue the deletes in ONE transact, re-checking the live count per node so
    // we never drop a type to zero (never-delete-last) and skip anything a
    // rack-mate already removed.
    ydoc.transact(() => {
      for (const d of plan) {
        if (!isSafeToDelete(
          patch.nodes as Record<string, { type: string } | null | undefined>,
          d.id,
          d.type,
        )) {
          continue;
        }
        // Drop edges touching the doomed node first (mirror deleteNode), then
        // the node itself. We bypass the `undeletable` guard in deleteNode on
        // purpose: this surplus IS an undeletable ghost — removing it is the
        // whole point — and we've already proven the survivor remains.
        for (const [eid, edge] of Object.entries(patch.edges)) {
          if (!edge) continue;
          if (edge.source.nodeId === d.id || edge.target.nodeId === d.id) {
            delete patch.edges[eid];
          }
        }
        delete patch.nodes[d.id];
        trace(
          `singleton-cleanup: deleted duplicate ${d.id} (${d.type}); kept ${d.keptId}`,
        );
      }
    }, LOCAL_ORIGIN);
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
      // Rack sizing: tag declared cards so _module-card.css forces their tier
      // height (Nu) + hp width. Untagged (unmigrated) cards keep their size.
      const rack = rackSizeByType[n.type];
      if (rack?.size) {
        // xyflow applies `class` to the .svelte-flow__node wrapper; our shared
        // _module-card.css keys off `rack-sized` + the inline `--rack-u`
        // (height tiles) and `--rack-hp` (width tiles) to force the card box.
        const u = parseInt(rack.size, 10) || 1;
        node.class = node.class ? `${String(node.class)} rack-sized` : 'rack-sized';
        node.style = `${node.style ? node.style + ';' : ''}--rack-hp:${rack.hp ?? 1};--rack-u:${u}`;
      }
      // Virtual-rack Phase 2: a LOCKED ("screwed down") module is pinned to its
      // slot — SvelteFlow won't drag it (draggable=false) and a `node-locked`
      // class lights the lock-glyph affordance in _module-card.css. The flag is
      // shared patch data (node.data.rackLocked — distinct from the Control
      // Surface's own data.locked), so rack-mates see the same lock.
      const locked = (n.data as { rackLocked?: boolean } | undefined)?.rackLocked === true;
      if (locked) {
        node.draggable = false;
        node.class = node.class ? `${String(node.class)} node-locked` : 'node-locked';
      }
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

  /** GIBRIBBON game demo — load the bundled audio→video patch that drives
   *  the GibRibbon game (PR #620) from a sequenced MACROOSCILLATOR voice
   *  analysed by SYNESTHESIA. Same shape as loadMediaBurn: envelope →
   *  loadEnvelopeIntoStore. TIMELORDE + MACSEQ free-run on load, so the
   *  SYNESTHESIA slow envelopes start generating GibRibbon events
   *  immediately (cv1..cv4 → loop/jump/imp/zombie; 1× → scroll clock;
   *  MACSEQ gate → beat). See gibribbon-demo.ts + gibribbon-events.ts. */
  async function loadGibribbonDemo() {
    error = null;
    booting = true;
    try {
      await ensureEngine();
      const { loadGibribbonDemo: doLoad } = await import('$lib/ui/example-patches/gibribbon-demo');
      const result = doLoad(ydoc, patch);
      trace(`GIBRIBBON demo in store (${result.nodesLoaded} nodes, ${result.edgesLoaded} edges); reconciler instantiating`);
      await reconciler?.reconcile();
      trace('GIBRIBBON demo live — sequenced voice → SYNESTHESIA → game events');
    } catch (err) {
      console.error(err);
      error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    } finally {
      booting = false;
    }
  }

  /** Identifiers for the "Load example…" topbar dropdown. Each maps to one
   *  of the existing example loaders/spawners (kept byte-for-byte identical
   *  to the buttons they replaced). */
  type ExampleKey = 'sequenced-vco' | 'system-55' | 'system-35' | 'media-burn' | 'glitches' | 'gibribbon-demo';

  /** Action-menu dispatcher for the "Load example…" `<select>`. It's an
   *  action menu (not a persistent value), so we reset the bound value back
   *  to the placeholder after dispatching, letting the user re-select the
   *  same example to load it again. */
  let exampleChoice = $state('');
  async function onExampleChosen(key: ExampleKey) {
    switch (key) {
      case 'sequenced-vco': await loadExample(); break;
      case 'system-55':     await spawnCabinet('55'); break;
      case 'system-35':     await spawnCabinet('35'); break;
      case 'media-burn':    await loadMediaBurn(); break;
      case 'glitches':      await loadGlitches(); break;
      case 'gibribbon-demo': await loadGibribbonDemo(); break;
    }
    // Reset back to the placeholder so this stays an action menu.
    exampleChoice = '';
  }

  function clearPatch() {
    ydoc.transact(() => {
      for (const id of Object.keys(patch.edges)) delete patch.edges[id];
      for (const id of Object.keys(patch.nodes)) delete patch.nodes[id];
    }, LOCAL_ORIGIN);
    // No defensive flowNodes=[] anymore: B3's snapshot bus pushes the
    // empty snapshot to this $effect synchronously on the same Yjs
    // update, and SvelteFlow now consumes a one-way `nodes` prop so it
    // can't stomp the assignment.
    trace('cleared patch');
  }

  // ---------------- Raw JSON export / import ----------------
  //
  // The lightweight sibling of the portable .zip flow: download / load JUST the
  // patch ENVELOPE (graph + positions + params + INLINE assets the envelope
  // already carries — PICTUREBOX images, SAMSLOOP samples, CV routes,
  // control-surface bindings, module names). NO out-of-band media (VIDEOBOX
  // bytes, TWOTRACKS tape) and NO MIDI/gamepad maps — that's what the .zip is
  // for. This restores the convenience the old topbar "Save"/"Load" JSON
  // buttons gave (removed in #771); it reuses the canonical
  // makeEnvelope/downloadEnvelope + parseEnvelope/pickAndLoadEnvelope helpers —
  // the SAME serializer the .zip + persistence paths use. (The deliberately
  // deleted browser-localStorage "Save/Load Local Performance" feature is NOT
  // reintroduced — this is file export/import only.)

  /** "Export JSON (only)" — download the current patch as the JSON envelope
   *  ONLY (no media, no zip). Same envelope the old "Save" button produced. */
  function exportPatchJson() {
    error = null;
    try {
      // A save taken during/just after a hardware CC twist must capture the
      // settled value — flush the coalesced CC pumps before snapshotting.
      flushAllCcCommits();
      const env = makeEnvelope(ydoc);
      downloadEnvelope(env, DEFAULT_FILENAME);
      trace(
        `exported patch JSON (${Object.keys(patch.nodes).length} nodes, ${Object.keys(patch.edges).length} edges)`,
      );
    } catch (e) {
      error = `Export JSON failed: ${e instanceof Error ? e.message : String(e)}`;
      trace(`export JSON failed: ${String(e)}`);
    }
  }

  /** "Import JSON" — file-pick a `.json` envelope and load it into the live
   *  rack. Bootstraps the engine + reconciler from inside this click handler
   *  (the user gesture) so the AudioContext resumes and a reconciler exists to
   *  materialize the loaded nodes — mirrors loadExample()'s shape, identical to
   *  the old "Load" button. */
  async function importPatchJson() {
    error = null;
    try {
      await ensureEngine();
      const result = await pickAndLoadEnvelope(ydoc, patch);
      if (!result) {
        trace('import JSON cancelled');
        return;
      }
      await reconciler?.reconcile();
      trace(`imported patch JSON (${result.nodesLoaded} nodes, ${result.edgesLoaded} edges)`);
      if (result.diagnostics.length > 0) {
        for (const d of result.diagnostics) {
          console.warn(`[import-json] ${d.nodeId} (${d.type}): ${d.reason}`);
        }
      }
    } catch (e) {
      const msg = e instanceof EnvelopeParseError ? e.message : (e instanceof Error ? e.message : String(e));
      error = `Import JSON failed: ${msg}`;
      trace(`import JSON failed: ${msg}`);
    }
  }

  /** Action-menu dispatcher for the "Raw JSON" `<select>` (top-RIGHT of the
   *  topbar). Like the "Load example…" menu it's an ACTION menu, so the bound
   *  value resets to the placeholder after each dispatch — letting the user
   *  re-pick the same action. */
  type RawJsonKey = 'export-json' | 'import-json';
  let rawJsonChoice = $state('');
  async function onRawJsonChosen(key: RawJsonKey) {
    switch (key) {
      case 'export-json': exportPatchJson(); break;
      case 'import-json': await importPatchJson(); break;
    }
    rawJsonChoice = '';
  }

  // ---------------- Performance device-resolution helpers ----------------
  //
  // Shared by the portable Export Perf (.zip) path below: resolve live MIDI /
  // gamepad device metadata so the exported bundle can record device-by-NAME +
  // gamepad-by-id for guided re-bind on load. (The browser-slot "Save/Load
  // Local Performance" feature these once also served was retired — its
  // IndexedDB layer lived in performance-store.ts and was removed with it.)

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

  // ---------------- Export / Load PORTABLE Performance (.zip) ----------------
  //
  // The cross-machine sibling of Save/Load Local Performance: a single .zip that
  // carries the WHOLE rack — the patch envelope (graph + positions + INLINE
  // PICTUREBOX images / TOYBOX layer images-shaders-OBJs / SAMSLOOP samples / CV
  // routes / control-surface bindings / module names) PLUS the actual VIDEOBOX
  // video BYTES (the one asset the envelope can't inline) PLUS the MIDI/gamepad
  // mappings. Reloads on any machine: no FileSystemFileHandle, no re-pick.
  //
  // Build: makePortableEnvelope → makePerformanceBundle (existing manifest) →
  //        resolve loaded VIDEOBOX bytes via the export registry → buildPerformanceZip.
  // Load:  parsePerformanceZip → seed each video's bytes into the IDB handle store
  //        under its handleId (putVideoFileBlob) → import MIDI bindings → apply the
  //        envelope → reconcile. Each VIDEOBOX card's tryReloadFromHandle then
  //        finds its seeded (granted) blob handle on mount and auto-loads the clip.

  let perfZipBusy = $state(false);

  /** Dump every TWOTRACKS reel's recorded tape to out-of-band 'audio' media for
   *  the .zip. The tape is worklet-owned PCM (never on node.data), so we ask the
   *  engine handle to dump each reel, encode it to compact 16-bit PCM, and key it
   *  `<nodeId>:<reel>` so the loader routes it back to the right reel. Reels with
   *  no recording resolve null + are skipped. */
  async function collectTwotracksTapes(): Promise<PerformanceMedia[]> {
    const out: PerformanceMedia[] = [];
    const e = engine;
    if (!e) return out;
    for (const [nid, n] of Object.entries(patch.nodes)) {
      if (!n || n.type !== 'twotracks') continue;
      const dump = e.read(n, 'dumpTapeAsync') as
        | ((reel: 'a' | 'b') => Promise<{ bufL: Float32Array; bufR: Float32Array; bufLen: number } | null>)
        | undefined;
      if (typeof dump !== 'function') continue;
      for (const reel of ['a', 'b'] as const) {
        try {
          const tape = await dump(reel);
          if (!tape || tape.bufLen <= 0) continue;
          const bytes = encodeTapeBytes(tape.bufL, tape.bufR, tape.bufLen);
          if (bytes.length === 0) continue;
          out.push({ nodeId: nid, handleId: `${nid}:${reel}`, role: 'audio', name: `twotracks-${reel}.pcm`, bytes });
        } catch { /* skip a reel that can't be dumped */ }
      }
    }
    return out;
  }

  /** Build the portable performance .zip bytes for the current rack. Pure-ish:
   *  reads the live store + resolves loaded video bytes. Exposed for the e2e
   *  hook so the round-trip test can capture the bytes without a download. */
  async function buildPerformanceZipBytes(): Promise<Uint8Array> {
    // A zip export mid-twist must capture the settled knob values (the CC
    // coalescer defers store commits) — flush before snapshotting.
    flushAllCcCommits();
    // Resolve loaded video bytes across all VIDEOBOX cards FIRST (registry), so
    // we know which nodes carry out-of-band video before snapshotting the graph.
    const resolved = await resolveAllVideoExports();

    // Ensure every exported video SLOT has a STABLE handleId baked into its data
    // BEFORE we snapshot the envelope: on reload the restored card looks the
    // seeded blob handle up by THIS id. A file picked via the plain <input> (no
    // File System Access) never got a handleId, so we mint a deterministic id and
    // write it into the live node (rides the Yjs snapshot). Done in one transact,
    // before makeEnvelope.
    //
    //   * slot 0 → fileMeta.handleId (`bundle-<nodeId>`), the legacy single-video
    //     path the card's tryReloadFromHandle reads (VIDEOBOX + VVS slot 0).
    //   * slots 1..6 → slotMeta[slot].handleId (`bundle-<nodeId>-slot-<n>`), the
    //     VIDEOVARISPEED 7-slot path tryReloadSlotFromHandle reads. WITHOUT this,
    //     slots 1..6 bytes were dropped from the bundle entirely (Fix B): a perf
    //     with 7 videos lost 6. The slotMeta clone is PLAIN (never re-insert a
    //     live Y type — same trap as the sequencer save-to-slot bug).
    const handleIdFor = new Map<string, string>(); // `${nodeId}#${slot}` → handleId
    ydoc.transact(() => {
      for (const r of resolved) {
        const node = patch.nodes[r.nodeId];
        if (!node) continue;
        if (!node.data) node.data = {} as Record<string, unknown>;
        const d = node.data as Record<string, unknown>;
        const slot = r.slot ?? 0;
        if (slot === 0) {
          const fm = (d.fileMeta as { handleId?: unknown; name?: unknown; size?: unknown; duration?: unknown } | null | undefined) ?? null;
          const existing = typeof fm?.handleId === 'string' && fm.handleId.length > 0 ? fm.handleId : null;
          const handleId = existing ?? `bundle-${r.nodeId}`;
          handleIdFor.set(`${r.nodeId}#0`, handleId);
          if (!existing) {
            d.fileMeta = { ...(fm ?? {}), handleId, name: r.name, size: r.bytes.length };
          }
        } else {
          // Per-slot handleId, baked into a PLAIN-cloned slotMeta array.
          const cur = Array.isArray(d.slotMeta) ? (d.slotMeta as Array<Record<string, unknown> | null>) : [];
          const arr: Array<Record<string, unknown> | null> = [];
          const N = 7;
          for (let i = 0; i < N; i++) {
            const e = cur[i] as { name?: unknown; duration?: unknown; size?: unknown; handleId?: unknown } | null | undefined;
            if (i === slot) {
              const existing = typeof e?.handleId === 'string' && e.handleId.length > 0 ? (e.handleId as string) : null;
              const handleId = existing ?? `bundle-${r.nodeId}-slot-${slot}`;
              handleIdFor.set(`${r.nodeId}#${slot}`, handleId);
              arr.push({
                name: typeof e?.name === 'string' ? e.name : r.name,
                duration: typeof e?.duration === 'number' ? e.duration : 0,
                size: typeof e?.size === 'number' ? e.size : r.bytes.length,
                handleId,
              });
            } else {
              arr.push(e ? { name: e.name, duration: e.duration, size: e.size, handleId: e.handleId } : null);
            }
          }
          d.slotMeta = arr;
        }
      }
    });

    const envelope = makePortableEnvelope(ydoc, currentUserId);
    const nodes: Record<string, { id: string; type: string; data?: Record<string, unknown> | null; params?: Record<string, unknown> | null }> = {};
    for (const [nid, n] of Object.entries(patch.nodes)) {
      if (n) nodes[nid] = { id: nid, type: n.type, data: n.data as Record<string, unknown> | null, params: n.params as Record<string, unknown> | null };
    }
    const resolveMidi = await resolveMidiDevices();
    const bundle = makePerformanceBundle({
      envelope,
      nodes,
      midiBindings: exportMidiBindings(),
      resolveMidiDevice: resolveMidi,
      resolveGamepad,
    });
    // Map each resolved video SLOT to the handleId now stamped on its node, so
    // the loader seeds the bytes under the SAME id the restored card/slot looks
    // up. `slot` rides along so the loader restores into the matching slot index.
    const media: PerformanceMedia[] = resolved.map((r) => {
      const slot = r.slot ?? 0;
      const handleId =
        handleIdFor.get(`${r.nodeId}#${slot}`) ??
        (slot === 0 ? `bundle-${r.nodeId}` : `bundle-${r.nodeId}-slot-${slot}`);
      return {
        nodeId: r.nodeId,
        handleId,
        role: 'video' as const,
        name: r.name,
        bytes: r.bytes,
        slot,
      };
    });
    // TWOTRACKS reel tapes: worklet-owned PCM that can't ride the envelope.
    // Dump each reel out-of-band as 'audio' media keyed `<nodeId>:<reel>`.
    media.push(...(await collectTwotracksTapes()));
    return buildPerformanceZip({ bundle, media, savedAt: Date.now() });
  }

  async function exportPerformanceZip(): Promise<void> {
    error = null;
    if (perfZipBusy) return;
    perfZipBusy = true;
    try {
      const bytes = await buildPerformanceZipBytes();
      // Let the user NAME the file (Chromium: native Save dialog; elsewhere: a
      // name prompt + download) instead of force-saving a fixed name.
      const outcome = await savePerformanceZip(bytes);
      if (outcome === 'cancelled') {
        trace('export performance cancelled by user');
        return;
      }
      trace(`exported performance .zip (${(bytes.length / 1024).toFixed(0)} KB)`);
    } catch (e) {
      error = `Export performance failed: ${e instanceof Error ? e.message : String(e)}`;
      trace(`export performance failed: ${String(e)}`);
    } finally {
      perfZipBusy = false;
    }
  }

  /** Restore a parsed performance .zip into the live rack. Shared by the file
   *  picker + the e2e hook (which passes captured bytes). */
  async function loadPerformanceZipBytes(zipBytes: Uint8Array): Promise<void> {
    const parsed = parsePerformanceZip(zipBytes);
    const bundle = validateBundle(parsed.bundle);

    await ensureEngine();

    // Seed each out-of-band VIDEO's bytes into the IDB handle store under its
    // handleId BEFORE applying the envelope, so each VIDEOBOX / VIDEOVARISPEED
    // card mounting from the load finds a granted blob handle and auto-reloads
    // (no re-pick). AUDIO (TWOTRACKS tape) media is restored AFTER reconcile (it
    // needs the live worklet) — see below.
    for (const m of parsed.media) {
      if (m.role !== 'video' || !m.handleId) continue;
      const blob = new Blob([m.bytes as unknown as BlobPart], { type: 'video/mp4' });
      await putVideoFileBlob(m.handleId, blob, m.name);
    }

    // Restore MIDI Learn CC maps (merge so other patches' bindings survive),
    // before the envelope so cards re-register their setters on mount.
    if (bundle.midiBindings.length > 0) {
      const merged = mergeMidiBindings(exportMidiBindings(), bundle.midiBindings);
      importMidiBindings(merged);
    }

    const result = persistenceLoad(bundle.patch, ydoc, patch);
    await reconciler?.reconcile();
    trace(`loaded performance .zip (${result.nodesLoaded} nodes, ${result.edgesLoaded} edges, ${parsed.media.length} media assets)`);
    if (result.diagnostics.length > 0) {
      for (const d of result.diagnostics) console.warn(`[load-perf-zip] ${d.nodeId} (${d.type}): ${d.reason}`);
    }

    // Restore TWOTRACKS reel tapes (out-of-band 'audio' media): decode the
    // 16-bit PCM + send it to each reel's worklet via the engine handle's
    // `loadTape`. Done AFTER reconcile so the worklet exists. The reel stays
    // idle on load (load-tape never auto-rolls).
    await restoreTwotracksTapes(parsed.media);

    // FIX 1: auto-bind MIDI on zip load. After the rack is materialized, each
    // MIDI LANE / MIDICLOCK / MIDI-CV-BUDDY card mounts with its saved
    // `lastDeviceId` already on node.data — but Web MIDI access is strictly
    // on-demand (needs a user gesture), so without the manual per-card "Connect
    // MIDI…" click no device is ever attached. THIS load call IS that gesture
    // (the user clicked "Load performance"), so we request access ONCE here and
    // auto-bind every saved MIDI module to its device (by saved id, falling back
    // to NAME for cross-machine). No mappings → no prompt.
    await autoBindMidiDevices(bundle.midiDevices);
  }

  /** Restore each TWOTRACKS reel tape from the perf-zip's out-of-band 'audio'
   *  media. The handle's `loadTape` may not be ready the instant reconcile
   *  resolves (the worklet module loads async), so retry briefly per asset. */
  async function restoreTwotracksTapes(media: PerformanceMedia[]): Promise<void> {
    const tapes = media.filter((m) => m.role === 'audio');
    if (tapes.length === 0) return;
    const e = engine;
    if (!e) return;
    for (const m of tapes) {
      const node = patch.nodes[m.nodeId];
      if (!node || node.type !== 'twotracks') continue;
      const reel = m.handleId.endsWith(':b') ? 'b' : 'a';
      const decoded = decodeTapeBytes(m.bytes);
      if (decoded.bufLen <= 0) continue;
      // Retry until the engine handle exposes loadTape (worklet ready), ~3s.
      for (let attempt = 0; attempt < 30; attempt++) {
        const load = e.read(node, 'loadTape') as
          | ((r: 'a' | 'b', bufL: Float32Array, bufR: Float32Array, bufLen: number) => void)
          | undefined;
        if (typeof load === 'function') {
          load(reel, decoded.bufL, decoded.bufR, decoded.bufLen);
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  }

  /** Re-bind each saved MIDI module to its device after a performance load.
   *  Requests MIDI access ONCE (the load click is the user gesture), then for
   *  every MIDI LANE / MIDICLOCK / MIDI-CV-BUDDY node calls its card-api
   *  `connect()` + `selectDevice(resolvedId)` — resolved id-first then by NAME.
   *  Graceful: empty list → no prompt; access denied / unavailable → bail
   *  quietly (the cards keep their saved selection for a later manual connect /
   *  hot-plug); device absent → leave that module unbound with a clear trace. */
  async function autoBindMidiDevices(
    midiDevices: { nodeId: string; deviceName: string; deviceId?: string }[],
  ): Promise<void> {
    if (!midiDevices || midiDevices.length === 0) return; // no mappings → no prompt
    // The list of currently-connected inputs (id + name) for resolution. This
    // ALSO performs the one-time requestMIDIAccess (gated behind the load
    // gesture). On denial / unsupported it returns [] and we bail.
    let connected: ConnectedMidiInput[];
    try {
      const nav = navigator as unknown as {
        requestMIDIAccess?: (o?: unknown) => Promise<{ inputs: Map<string, { name?: string | null }> }>;
      };
      if (typeof nav.requestMIDIAccess !== 'function') return; // Web MIDI unsupported
      const access = await nav.requestMIDIAccess({ sysex: false });
      connected = [...access.inputs].map(([id, inp]) => ({ id, name: inp.name ?? id }));
    } catch {
      // Permission denied / hardware error — don't hang; the cards keep their
      // saved selection and the user can still click "Connect MIDI…" per card.
      trace('auto-bind MIDI: access denied or unavailable — leaving modules unbound');
      return;
    }
    const e = engine;
    if (!e) return;
    for (const dev of midiDevices) {
      const node = patch.nodes[dev.nodeId];
      if (!node || !(MIDI_DEVICE_NODE_TYPES as readonly string[]).includes(node.type)) continue;
      const api = e.read(node, 'card-api') as
        | { connect: () => Promise<boolean>; selectDevice: (id: string | null) => void }
        | undefined;
      if (!api || typeof api.connect !== 'function' || typeof api.selectDevice !== 'function') continue;
      try {
        // connect() resolves the singleton access + binds the saved id if it's
        // present in the live inputs (its pickDefaultDevice prefers the saved
        // selectedDeviceId). We additionally resolve id→name so a cross-machine
        // load (regenerated ids) still binds, then selectDevice the resolved id.
        await api.connect();
        const resolved = resolveMidiDeviceId(dev, connected);
        if (resolved) {
          api.selectDevice(resolved);
          trace(`auto-bound ${node.type} ${dev.nodeId} → "${dev.deviceName}"`);
        } else {
          trace(`auto-bind MIDI: device "${dev.deviceName}" absent — ${dev.nodeId} left unbound`);
        }
      } catch {
        // A single card's connect can fail (denied / removed mid-load); skip it
        // so one bad module doesn't abort the rest of the rack's re-bind.
      }
    }
  }

  async function loadPerformanceZip(): Promise<void> {
    error = null;
    if (perfZipBusy) return;
    perfZipBusy = true;
    try {
      const file = await pickPerformanceZipFile();
      if (!file) { trace('load performance .zip cancelled'); return; }
      const ab = await file.arrayBuffer();
      await loadPerformanceZipBytes(new Uint8Array(ab));
    } catch (e) {
      const msg = e instanceof BundleParseError || e instanceof EnvelopeParseError ? e.message : (e instanceof Error ? e.message : String(e));
      error = `Load performance failed: ${msg}`;
      trace(`load performance .zip failed: ${msg}`);
    } finally {
      perfZipBusy = false;
    }
  }

  /** Open the system file picker for a .zip; resolves null on cancel. */
  function pickPerformanceZipFile(): Promise<File | null> {
    return pickFile('.zip,application/zip');
  }

  /** Generic single-file picker; resolves the File or null on cancel. */
  function pickFile(accept: string): Promise<File | null> {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = accept;
      input.style.display = 'none';
      input.addEventListener('change', () => {
        const f = input.files?.[0] ?? null;
        input.remove();
        resolve(f);
      });
      input.addEventListener('cancel', () => { input.remove(); resolve(null); });
      document.body.appendChild(input);
      input.click();
    });
  }

  // ---------------- Preset SLOT bar + portable SET (top-left menu bar) ----------------
  //
  // Five numbered quick-switch slots: EMPTY = red, OCCUPIED = green.
  //   * right-click an EMPTY slot → Load… → pick a performance .zip → store in
  //     IndexedDB → slot turns green;
  //   * LEFT-click a GREEN slot → instantly load its stored zip (no dialog);
  //   * right-click a GREEN slot → Replace with… / Clear slot.
  // A `.set` bundles all five slots + the MIDI map into one zip-of-zips
  // (preset-set.ts) — Save Set downloads it, Load Set repopulates the bar.
  // Slots persist per-browser-profile in IndexedDB (zips are large) and are NOT
  // synced — this is the performer's personal quick-switch bar.

  // Reactive occupancy mirror (red/green). Seeded from IDB on mount; mutated by
  // the slot ops below so the bar re-colours without an IDB round-trip.
  let slotOccupied = $state<boolean[]>(new Array(SLOT_COUNT).fill(false));
  // Open per-slot context menu (right-click). null = closed.
  let slotMenu = $state<{ index: number; x: number; y: number } | null>(null);
  let slotBusy = $state(false);

  /** Refresh the whole bar's red/green state from IndexedDB. */
  async function refreshSlotOccupancy(): Promise<void> {
    slotOccupied = await listOccupied();
  }

  /** LEFT-click a slot: green → instantly load its stored perf zip; red →
   *  open the load picker (a convenience so an empty slot is also clickable). */
  async function onSlotClick(index: number): Promise<void> {
    if (slotBusy) return;
    if (slotOccupied[index]) {
      await loadSlot(index);
    } else {
      await loadIntoSlot(index);
    }
  }

  /** RIGHT-click a slot: open its context menu at the cursor. */
  function onSlotContextMenu(event: MouseEvent, index: number): void {
    event.preventDefault();
    event.stopPropagation();
    slotMenu = { index, x: event.clientX, y: event.clientY };
  }

  function closeSlotMenu(): void {
    slotMenu = null;
  }

  /** Load (or Replace) a slot from a picked performance .zip → store in IDB. */
  async function loadIntoSlot(index: number): Promise<void> {
    closeSlotMenu();
    error = null;
    if (slotBusy) return;
    slotBusy = true;
    try {
      const file = await pickPerformanceZipFile();
      if (!file) { trace(`slot ${index + 1}: load cancelled`); return; }
      const bytes = new Uint8Array(await file.arrayBuffer());
      // Validate it's a real performance zip before committing the slot.
      parsePerformanceZip(bytes);
      await putSlot(index, bytes, file.name);
      slotOccupied[index] = true;
      trace(`slot ${index + 1}: stored "${file.name}" (${(bytes.length / 1024).toFixed(0)} KB)`);
    } catch (e) {
      error = `Slot ${index + 1} load failed: ${e instanceof Error ? e.message : String(e)}`;
      trace(`slot ${index + 1} load failed: ${String(e)}`);
    } finally {
      slotBusy = false;
    }
  }

  /** Instantly switch to a green slot's stored performance (no file dialog). */
  async function loadSlot(index: number): Promise<void> {
    closeSlotMenu();
    error = null;
    if (slotBusy) return;
    slotBusy = true;
    try {
      const rec = await getSlot(index);
      if (!rec) { slotOccupied[index] = false; trace(`slot ${index + 1}: empty`); return; }
      await loadPerformanceZipBytes(rec.zipBytes);
      trace(`slot ${index + 1}: loaded "${rec.label ?? 'preset'}"`);
    } catch (e) {
      const msg = e instanceof BundleParseError || e instanceof EnvelopeParseError ? e.message : (e instanceof Error ? e.message : String(e));
      error = `Slot ${index + 1} switch failed: ${msg}`;
      trace(`slot ${index + 1} switch failed: ${msg}`);
    } finally {
      slotBusy = false;
    }
  }

  /** Clear a slot back to empty (red). */
  async function clearSlot(index: number): Promise<void> {
    closeSlotMenu();
    if (slotBusy) return;
    slotBusy = true;
    try {
      await clearSlotStore(index);
      slotOccupied[index] = false;
      trace(`slot ${index + 1}: cleared`);
    } finally {
      slotBusy = false;
    }
  }

  /** Save Set: bundle every occupied slot's perf zip + the MIDI map into one
   *  `.set` (zip-of-zips) and download it. */
  async function saveSet(): Promise<void> {
    error = null;
    if (slotBusy) return;
    slotBusy = true;
    try {
      const bytes = await buildSetBytes();
      const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'preset-bar.set';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch { /* */ } }, 60_000);
      trace(`saved .set (${(bytes.length / 1024).toFixed(0)} KB)`);
    } catch (e) {
      error = `Save Set failed: ${e instanceof Error ? e.message : String(e)}`;
      trace(`save set failed: ${String(e)}`);
    } finally {
      slotBusy = false;
    }
  }

  /** Build the `.set` bytes from the current slot bar + MIDI map. Exposed for
   *  the e2e hook so the round-trip test can capture bytes without a download. */
  async function buildSetBytes(): Promise<Uint8Array> {
    const slots: SetSlot[] = [];
    for (let i = 0; i < SLOT_COUNT; i++) {
      const rec = await getSlot(i);
      if (rec) slots.push({ index: i, zipBytes: rec.zipBytes, label: rec.label });
    }
    return buildSet({ slots, midiBindings: exportMidiBindings(), savedAt: Date.now() });
  }

  /** Load Set: replace ALL slot contents from a picked `.set`. */
  async function loadSet(): Promise<void> {
    error = null;
    if (slotBusy) return;
    slotBusy = true;
    try {
      const file = await pickFile('.set,.zip,application/zip');
      if (!file) { trace('load set cancelled'); return; }
      const bytes = new Uint8Array(await file.arrayBuffer());
      await loadSetBytes(bytes);
    } catch (e) {
      error = `Load Set failed: ${e instanceof Error ? e.message : String(e)}`;
      trace(`load set failed: ${String(e)}`);
    } finally {
      slotBusy = false;
    }
  }

  /** Apply a parsed `.set` to the slot bar: replace ALL slots (occupied ones
   *  from the set → green; absent ones cleared → red) + restore the MIDI map.
   *  Shared by the file picker + the e2e hook (which passes captured bytes). */
  async function loadSetBytes(bytes: Uint8Array): Promise<void> {
    const set = parseSet(bytes);
    const fromSet = new Map(set.slots.map((s) => [s.index, s] as const));
    for (let i = 0; i < SLOT_COUNT; i++) {
      const s = fromSet.get(i);
      if (s) {
        await putSlot(i, s.zipBytes, s.label);
        slotOccupied[i] = true;
      } else {
        await clearSlotStore(i);
        slotOccupied[i] = false;
      }
    }
    // Restore the MIDI Learn map (merge so other patches' bindings survive).
    if (set.midiBindings.length > 0) {
      importMidiBindings(mergeMidiBindings(exportMidiBindings(), set.midiBindings));
    }
    trace(`loaded .set (${set.slots.length} slot${set.slots.length === 1 ? '' : 's'})`);
  }

  // ---------------- Mirror Svelte Flow events back to the patch graph ----------------

  /** SvelteFlow drag-time gate. Runs continuously while a cable is being
   *  dragged toward a candidate handle; returning false makes SvelteFlow
   *  visually REJECT the drop (no commit, no handleConnect). We reuse the
   *  exact FW3 validator the commit path uses, so the drag preview and the
   *  commit agree on direction + canConnect type compatibility (incl. group
   *  exposed ports). Kept cheap: a couple of Record lookups + the pure
   *  validator. Endpoints can be null mid-drag (before a target is hovered);
   *  we permit those so the drag isn't killed before it reaches a handle. */
  function isValidConnection(connection: FlowEdge | Connection): boolean {
    const { source, target, sourceHandle, targetHandle } = connection;
    // Mid-drag with no candidate target yet — don't reject, let the drag run.
    if (!source || !target || !sourceHandle || !targetHandle) return true;
    // Orient by declared direction so a reverse drag (input → output, enabled
    // by connectionMode=loose) previews as valid — the commit path orients the
    // same way. (No PatchPanel short-circuit here: this predicate stays the
    // honest strict verdict so the drag preview + the validate-edge spec agree.
    // Drops onto a hidden-handle PatchPanel card are diverted to the drill-down
    // picker from onconnectend, independent of this verdict.)
    const oriented = orientConnection({
      source,
      sourceHandle,
      target,
      targetHandle,
    });
    const candidate: Edge = {
      id: `e-${oriented.source}-${oriented.sourceHandle}-${oriented.target}-${oriented.targetHandle}`,
      source: { nodeId: oriented.source!, portId: oriented.sourceHandle! },
      target: { nodeId: oriented.target!, portId: oriented.targetHandle! },
      // sourceType/targetType are ignored by validateEdge (it re-derives the
      // real port types); fill with a benign placeholder.
      sourceType: 'audio',
      targetType: 'audio',
    };
    return validateEdge(candidate, Object.values(patch.nodes) as ModuleNode[], defLookup).ok;
  }

  /** Module-wide stereo L/R auto-wire (WORKSTREAM A item 6). After a primary
   *  edge `from.OUTPUT → to.INPUT` is written, if BOTH the source and target
   *  declare a matching stereoPairs sibling AND the sibling target input is
   *  unpatched, write the SECOND (sibling) edge too — so out_l→in_l implies
   *  out_r→in_r. Naming-agnostic (resolves via stereoPairs tuples, never name
   *  patterns); a mono source leaves the sibling unpatched (engine normals R←L).
   *
   *  MUST be called INSIDE the same ydoc.transact as the primary edge write so
   *  both edges land atomically. Only AUDIO module defs carry stereoPairs, so we
   *  resolve via getModuleDef (the audio registry) — group/exposed/video
   *  endpoints have no stereoPairs and fall through to a no-op. */
  function writeStereoSiblingEdge(
    from: { nodeId: string; portId: string },
    to: { nodeId: string; portId: string },
  ): void {
    const srcNode = patch.nodes[from.nodeId];
    const dstNode = patch.nodes[to.nodeId];
    if (!srcNode || !dstNode) return;
    const fromDef = getModuleDef(srcNode.type);
    const toDef = getModuleDef(dstNode.type);
    if (!fromDef || !toDef) return; // only audio defs declare stereoPairs
    const plan = planStereoAutowire({
      fromPortId: from.portId,
      fromDef,
      toNodeId: to.nodeId,
      toPortId: to.portId,
      toDef,
      edges: patch.edges,
    });
    if (!plan) return;
    const sibId = `e-${from.nodeId}-${plan.siblingFromPortId}-${to.nodeId}-${plan.siblingToPortId}`;
    if (patch.edges[sibId]) return;
    patch.edges[sibId] = {
      id: sibId,
      source: { nodeId: from.nodeId, portId: plan.siblingFromPortId },
      target: { nodeId: to.nodeId, portId: plan.siblingToPortId },
      sourceType: plan.sourceType,
      targetType: plan.targetType,
    };
    trace(`stereo-autowire ${from.nodeId}.${plan.siblingFromPortId} → ${to.nodeId}.${plan.siblingToPortId}`);
  }

  /** True when a node's card renders the redesigned PatchPanel (its handles
   *  live in a hidden, pointer-events:none stack at the card corner) rather
   *  than raw, individually-positioned <Handle> dots. The discriminator is
   *  the `data-patch-panel-node` attribute PatchPanel sets on its host.
   *
   *  Why this matters: SvelteFlow snaps a dragged/click-connect cable to the
   *  geometrically-nearest registered handle within connectionRadius — and it
   *  IGNORES `pointer-events:none`, so on a PatchPanel card it snaps to an
   *  ARBITRARY one of the stacked corner handles and would auto-commit there.
   *  That is exactly the "click just patches something without opening the
   *  menu" bug. For these cards we must NOT honour the snap; instead the cable
   *  becomes a carry and the card's drill-down INPUT/OUTPUT picker opens so the
   *  user chooses the real destination port. Raw-handle cards (video/game
   *  cards with visible, distinct handles) keep the precise direct drop. */
  function isPatchPanelCard(nodeId: string): boolean {
    if (typeof document === 'undefined') return false;
    return !!document.querySelector(
      `.svelte-flow__node[data-id="${nodeId}"] [data-patch-panel-node="${nodeId}"]`,
    );
  }

  /** A cable gesture (native drag OR carry/click-connect) landed over a
   *  PatchPanel target card whose handles are a hidden stack. Rather than
   *  honour SvelteFlow's arbitrary nearest-handle snap, open that card's
   *  drill-down picker seeded with the carried SOURCE port + PRE-DRILLED into
   *  the dropped-on target module, so the user lands on its compatible-port
   *  list and picks the destination. No edge is written until the user picks. */
  function openDrillDownForCarry(
    from: { nodeId: string; portId: string; direction: 'output' | 'input'; type: string },
    targetNodeId: string,
  ): void {
    // Kill xyflow's in-flight connection so its dashed snap-preview doesn't
    // linger behind our picker, and drop any pickup ghost cable.
    try {
      flowApi?.cancelConnection?.();
    } catch { /* defensive — never block the picker */ }
    if (connectDragState.mode === 'pickup') connectDragState.cancelPickup();
    // Edge-align the picker to whichever side of the TARGET card is nearer the
    // pointer (mirrors openPortMenu). Default to left when unmeasured.
    const r = cardRectFor(targetNodeId);
    const cursor = lastPointer;
    const side: 'left' | 'right' =
      r && cursor.x > r.left + r.width / 2 ? 'right' : 'left';
    const pos = edgeAlignedMenuPos(targetNodeId, side, cursor);
    carrySide = side;
    openPortMenuAt(pos, {
      nodeId: from.nodeId,
      portId: from.portId,
      direction: from.direction,
      type: from.type,
    });
    // Pre-drill into the dropped-on target module so the user lands directly on
    // its compatible-port list (the drill-down menu the owner asked for), not
    // the full module list. PortContextMenu reads `preselectNodeId` to open at
    // its ports level for that one card.
    portMenuPreselectNodeId = targetNodeId;
    trace(`carry drill-down → ${targetNodeId} (source ${from.nodeId}.${from.portId})`);
  }

  /** Re-orient a connection so the edge SOURCE is the OUTPUT side and the
   *  TARGET is the INPUT side — the only orientation validateEdge accepts.
   *
   *  Fixes the reverse-drag snag: with connectionMode=loose the user can grab
   *  an INPUT handle and drag back to an OUTPUT, and SvelteFlow then reports the
   *  literal grabbed input as `source`. validateEdge requires output→input, so
   *  that cable would silently die. We can't infer direction from the def alone
   *  (many modules reuse the SAME port id for an input AND an output, e.g.
   *  filter `audio`), so orientation is driven by the xyflow HANDLE TYPE of the
   *  grabbed handle, captured at connect-start in `dragSourceHandle`:
   *    - grabbed a 'target' handle (an INPUT) → the literal source is the input,
   *      so SWAP to make the other endpoint the source.
   *  We only swap when the literal source matches the captured grabbed handle
   *  AND it was a 'target'. No drag context (the programmatic test hook) → never
   *  swap; trust the caller's stated source/target exactly. */
  function orientConnection(c: Connection): Connection {
    if (!c.source || !c.target || !c.sourceHandle || !c.targetHandle) return c;
    const grabbed = dragSourceHandle;
    if (
      grabbed &&
      grabbed.handleType === 'target' &&
      grabbed.nodeId === c.source &&
      grabbed.handleId === c.sourceHandle
    ) {
      return {
        source: c.target,
        sourceHandle: c.targetHandle,
        target: c.source,
        targetHandle: c.sourceHandle,
      };
    }
    return c;
  }

  /** User dragged a connection between two handles. Create an edge in the patch.
   *  Behavior: an input accepts only ONE connection at a time — patching onto an
   *  occupied input replaces the existing edge. Outputs may fan out to many.
   *
   *  EXCEPTION (redesign): if the drop landed on a PatchPanel card (hidden
   *  handle stack), do NOT honour SvelteFlow's arbitrary nearest-handle snap.
   *  Convert the gesture into the drill-down picker so the user picks the real
   *  destination port — never an auto-patch. */
  function handleConnect(rawConnection: Connection) {
    // Was this a real in-flight pointer drag (begun via handleConnectStart)?
    // The programmatic __handleConnect test hook commits a PRECISE connection
    // without a drag gesture — it names the exact target handle, so the
    // snap-ambiguity that motivates the drill-down redirect doesn't apply. We
    // only redirect genuine drags. Snapshot BEFORE end() clears the flag.
    const wasDragging = connectDragState.mode === 'dragging';
    // Drag committed — release any drag-induced PatchPanel lock.
    connectDragState.end();
    if (!rawConnection.source || !rawConnection.target) return;
    if (!rawConnection.sourceHandle || !rawConnection.targetHandle) return;

    // REVERSE-DRAG NORMALIZATION (fixes the "drag the other direction snags"
    // report). SvelteFlow reports `source`/`target` by the drag's literal
    // start/end handle. When the user grabs an INPUT and drags back to an
    // OUTPUT (target→source), the literal source is the INPUT — which our
    // output→input validator then rejects, so the cable silently dies (the
    // "snag"). orientConnection flips the endpoints when the grabbed handle (the
    // xyflow handle TYPE captured at connect-start) was a 'target' input, so the
    // OUTPUT becomes the edge source and the INPUT the target.
    const oriented = orientConnection(rawConnection);
    // orientConnection preserves the (already non-null) endpoints; re-narrow for
    // the type system.
    if (!oriented.source || !oriented.target || !oriented.sourceHandle || !oriented.targetHandle) return;
    const connection = {
      source: oriented.source,
      target: oriented.target,
      sourceHandle: oriented.sourceHandle,
      targetHandle: oriented.targetHandle,
    };

    // SUPPRESS auto-commit on a REAL drag that snapped onto a hidden-handle
    // PatchPanel target. SvelteFlow snaps the cable to the geometrically
    // nearest stacked handle and would auto-patch there — the "click just
    // patches something without opening the menu" bug. We instead let
    // handleConnectEnd (onconnectend) open the card's drill-down picker so the
    // user picks the real destination port. The programmatic test hook
    // (wasDragging=false) commits the precise connection it was given; raw-
    // handle target cards (visible, distinct handles) keep the direct drop.
    if (wasDragging && isPatchPanelCard(connection.target)) return;

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

    // FW3 final structural gate (Phase 4a). The endpoints/types/exposed
    // ports are resolved above, but nothing has confirmed the cable is
    // actually materializable — direction (output→input) + canConnect
    // domain/type compatibility. Run the pure validator against the LIVE
    // patch nodes + the def-lookup chain (defLookup === getModuleDef ??
    // getVideoModuleDef ?? getMetaModuleDef). srcExposed/dstExposed are
    // re-resolved inside the validator the same way, so group exposed-port
    // cables validate correctly. On failure: trace + silent return (no
    // throw), exactly like the resolve/dup guards above. The candidate
    // edge mirrors what we'd write, so the validator re-derives the real
    // port types itself.
    const candidate: Edge = {
      id,
      source: { nodeId: connection.source, portId: connection.sourceHandle },
      target: { nodeId: connection.target, portId: connection.targetHandle },
      sourceType,
      targetType,
    };
    const verdict = validateEdge(candidate, Object.values(patch.nodes) as ModuleNode[], defLookup);
    if (!verdict.ok) {
      trace(`reject connect ${connection.source}.${connection.sourceHandle} → ${connection.target}.${connection.targetHandle}: ${verdict.reason}`);
      return;
    }

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
      // Stereo L/R auto-wire — write the sibling edge in the SAME transact.
      writeStereoSiblingEdge(
        { nodeId: connection.source!, portId: connection.sourceHandle! },
        { nodeId: connection.target!, portId: connection.targetHandle! },
      );
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
    // Remember where the cable was grabbed so handleConnectEnd can open the
    // drill-down picker if the drag lands on a hidden-handle PatchPanel card.
    dragInFlight = true;
    dragSourceHandle =
      params.nodeId && params.handleId && params.handleType
        ? { nodeId: params.nodeId, handleId: params.handleId, handleType: params.handleType }
        : null;
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
   *  induced PatchPanel lock. If the drag was released OVER a hidden-handle
   *  PatchPanel card, open that card's drill-down picker (seeded with the
   *  grabbed source) so the user picks the destination port — instead of the
   *  arbitrary nearest-handle auto-patch that handleConnect suppressed. The
   *  drop card is resolved from the pointer (elementFromPoint), not xyflow's
   *  snap, so it's exact regardless of the stacked-handle geometry. */
  function handleConnectEnd(
    event?: MouseEvent | TouchEvent,
  ) {
    const wasDrag = dragInFlight;
    const grabbed = dragSourceHandle;
    dragInFlight = false;
    dragSourceHandle = null;
    connectDragState.end();
    if (!wasDrag || !grabbed) return;
    // Resolve the drop point. Touch events expose changedTouches; mouse the
    // clientX/Y. Fall back to the last tracked pointer.
    let dropX = lastPointer.x;
    let dropY = lastPointer.y;
    if (event) {
      const me = event as MouseEvent;
      const te = event as TouchEvent;
      if (typeof me.clientX === 'number' && (me.clientX || me.clientY)) {
        dropX = me.clientX;
        dropY = me.clientY;
      } else if (te.changedTouches && te.changedTouches.length > 0) {
        dropX = te.changedTouches[0].clientX;
        dropY = te.changedTouches[0].clientY;
      }
    }
    if (typeof document === 'undefined') return;
    const el = document.elementFromPoint(dropX, dropY) as HTMLElement | null;
    const nodeEl = el?.closest('.svelte-flow__node') as HTMLElement | null;
    const dropNodeId = nodeEl?.getAttribute('data-id') ?? null;
    // No card under the cursor, dropped on itself, or the drop card is NOT a
    // hidden-handle PatchPanel card → nothing to redirect (a raw-handle target
    // already committed in handleConnect; empty space cancels the gesture).
    if (!dropNodeId || dropNodeId === grabbed.nodeId) return;
    if (!isPatchPanelCard(dropNodeId)) return;
    // Resolve the grabbed source's direction + cable type. The drill-down
    // picker offers only ports COMPATIBLE with this source, so the user can
    // only complete a valid patch.
    const node = patch.nodes[grabbed.nodeId];
    const def = node ? defLookup(node.type) : undefined;
    const exposed = node ? resolveExposedPort(node, grabbed.handleId) : undefined;
    const direction: 'output' | 'input' =
      exposed?.direction ?? (grabbed.handleType === 'source' ? 'output' : 'input');
    let type = exposed?.cableType ?? 'audio';
    if (!exposed && def) {
      const port =
        direction === 'output'
          ? def.outputs.find((p) => p.id === grabbed.handleId)
          : def.inputs.find((p) => p.id === grabbed.handleId);
      if (port) type = port.type as CableType;
    }
    lastPointer = { x: dropX, y: dropY };
    openDrillDownForCarry(
      { nodeId: grabbed.nodeId, portId: grabbed.handleId, direction, type: type as string },
      dropNodeId,
    );
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

  /** Read the current screen position of a node, preferring the per-user layout
   *  override (multiplayer) and falling back to the shared node.position — the
   *  same resolution the flowNodes derivation uses via getNodePosition. */
  function currentNodePosition(nodeId: string): { x: number; y: number } | null {
    const n = patch.nodes[nodeId];
    if (!n) return null;
    return getNodePosition(ydoc, currentUserId, nodeId, { x: n.position.x, y: n.position.y });
  }

  /** Write a node's position through the SAME dual-path as handleNodeDragStop:
   *  per-user layout map in multiplayer, shared node.position single-user. */
  function writeNodePosition(nodeId: string, pos: { x: number; y: number }): void {
    if (currentUserId) {
      setNodePosition(ydoc, currentUserId, nodeId, pos);
    } else {
      ydoc.transact(() => {
        const target = patch.nodes[nodeId];
        if (target) target.position = { x: pos.x, y: pos.y };
      }, LOCAL_ORIGIN);
    }
  }

  /** Virtual-rack Phase 2 — "screw down" a module to its rack slot:
   *  1. snap like a real rack — X to the HP pitch (22.5px = 1u/8, 8 lock
   *     positions per 1u), Y to the U row (180px) — then nudge to the nearest
   *     FREE slot (HP-first), then
   *  2. persist data.locked=true (shared patch state → synced to rack-mates).
   *  The flowNodes derivation then renders it non-draggable + lock-marked.
   *  Snapping Y to every U line makes a 1u card land on a third of a 3u slot for
   *  free (no special-casing). */
  function lockNode(nodeId: string): void {
    const pos = currentNodePosition(nodeId);
    if (pos) {
      // Snap to the grid, then nudge to the nearest FREE slot so locking never
      // drops the card on top of a neighbour (Phase-2 §3 collision rule). The
      // footprint is each card's true rendered box (offsetWidth/Height is
      // zoom-independent = flow-space px), which covers forced-tier AND
      // user-resized cards uniformly.
      const snapped = snapPositionToGrid(pos);
      const size = nodeFootprintPx(nodeId);
      const others: RackRect[] = snapshot.nodes
        .filter((n) => n.id !== nodeId && n.type !== 'cadillac')
        .map((n) => {
          const p = currentNodePosition(n.id) ?? n.position;
          const s = nodeFootprintPx(n.id);
          return { x: p.x, y: p.y, w: s.w, h: s.h };
        });
      writeNodePosition(nodeId, findFreeRackSlot(snapped, size, others));
    }
    setNodeLocked(nodeId, true);
  }

  /** A node's true footprint in flow-space px (zoom-independent layout box).
   *  Falls back to a 1u tile if the element isn't in the DOM yet. */
  function nodeFootprintPx(nodeId: string): { w: number; h: number } {
    const el = document.querySelector(
      `.svelte-flow__node[data-id="${CSS.escape(nodeId)}"]`,
    ) as HTMLElement | null;
    return el ? { w: el.offsetWidth, h: el.offsetHeight } : { w: RACK_UNIT, h: RACK_UNIT };
  }

  /** Unscrew a module — clear the lock flag so it free-floats + drags again.
   *  Position is left where it snapped (the user can drag it away once free). */
  function unlockNode(nodeId: string): void {
    setNodeLocked(nodeId, false);
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

  // Living-docs: whether the right-clicked module has AUTHORED docs — gates the
  // "Annotate" entry. MODULE_DOCS is the committed authored-docs registry.
  let ctxMenuHasDocs = $derived.by<boolean>(() => {
    void snapshot;
    return !!ctxMenuNodeType && !!MODULE_DOCS[ctxMenuNodeType];
  });
  // Whether annotate mode is currently ON for the right-clicked node (toggle
  // label). isAnnotating is reactive ($state set), so this re-evals on toggle.
  let ctxMenuAnnotateActive = $derived<boolean>(
    !!ctxMenuNodeId && isAnnotating(ctxMenuNodeId),
  );
  // Module-grouping Phase 2A — track whether the right-clicked group is
  // currently expanded so the menu can label the toggle appropriately.
  let ctxMenuGroupExpanded = $derived.by<boolean>(() => {
    void snapshot;
    if (!ctxMenuNodeId) return false;
    const n = patch.nodes[ctxMenuNodeId];
    if (!n || n.type !== 'group') return false;
    return (n.data as { expanded?: boolean } | undefined)?.expanded === true;
  });

  // Virtual-rack Phase 2 — whether the right-clicked node is "screwed down" to
  // its rack slot, so the menu shows "Unlock" instead of "Lock".
  let ctxMenuLocked = $derived.by<boolean>(() => {
    void snapshot;
    if (!ctxMenuNodeId) return false;
    const n = patch.nodes[ctxMenuNodeId];
    return (n?.data as { rackLocked?: boolean } | undefined)?.rackLocked === true;
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

  // Control colour — the right-clicked module's CURRENT resolved colour (for the
  // menu preview swatch) + whether the user has explicitly assigned one (gates
  // "Reset to default"). Resolved LIVE from the node (passthrough); the auto
  // default applies even when unassigned.
  let ctxMenuControlColor = $derived.by<string | null>(() => {
    void snapshot;
    if (!ctxMenuNodeId) return null;
    return resolveControlColor(patch.nodes[ctxMenuNodeId] as ModuleNode | undefined);
  });
  let ctxMenuHasCustomColor = $derived.by<boolean>(() => {
    void snapshot;
    if (!ctxMenuNodeId) return false;
    const n = patch.nodes[ctxMenuNodeId];
    return typeof (n?.data as { controlColor?: unknown } | undefined)?.controlColor === 'string';
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
    // maxInstances preflight: walk the children, running each capped type's
    // count up from its current patch total (graph/cap.instanceCount) so a
    // group that adds several of the same type is gated correctly.
    const typeCounts = new Map<string, number>();
    for (const child of children) {
      const def = defLookup(child.type);
      const cap = def?.maxInstances;
      if (cap === undefined) continue;
      const current = typeCounts.get(child.type) ?? instanceCount(patch.nodes, child.type);
      const willBe = current + 1; // +1 because we're about to add one more
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
    // maxInstances preflight (see duplicateGroupAction): run each capped
    // type's count up from its current patch total via graph/cap.instanceCount.
    const typeCounts = new Map<string, number>();
    for (const child of plan.newChildren) {
      const def = defLookup(child.type);
      const cap = def?.maxInstances;
      if (cap === undefined) continue;
      const current = typeCounts.get(child.type) ?? instanceCount(patch.nodes, child.type);
      const willBe = current + 1;
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
  // Which card side the carry/patch-to picker edge-aligns to (UX item 1).
  // Seeded from the jack-click that started the carry; defaults to 'left'.
  let carrySide = $state<'left' | 'right'>('left');
  let portMenuSourceNodeId = $state<string | null>(null);
  let portMenuSourcePortId = $state<string | null>(null);
  let portMenuSourceDirection = $state<'output' | 'input'>('output');
  let portMenuSourceType = $state<string>('audio');
  // When a cable gesture lands on a PatchPanel (hidden-handle) target card, we
  // open the picker PRE-DRILLED into that one target module so the user lands
  // straight on its compatible-port list (the drill-down menu). null = the
  // normal full-module-list entry point (carry "patch to", contextmenu, etc.).
  let portMenuPreselectNodeId = $state<string | null>(null);
  // Last observed pointer position (screen px). A native SvelteFlow connect-
  // drag's `onconnect` carries no cursor coords, so we snapshot the pointer to
  // edge-align the drill-down picker to the dropped-on card side.
  let lastPointer = { x: 0, y: 0 };
  // The handle a native connect-DRAG started from (captured in
  // handleConnectStart). Read by handleConnectEnd to seed the drill-down picker
  // when the drag is released over a hidden-handle PatchPanel card. Null when
  // no drag is in flight. NOT a $state — it's gesture-scoped plumbing, not UI.
  let dragSourceHandle: { nodeId: string; handleId: string; handleType: 'source' | 'target' } | null = null;
  // True for the duration of a genuine pointer connect-drag (set on
  // connectstart, cleared on connectend). Distinguishes a real drag from the
  // programmatic __handleConnect test hook.
  let dragInFlight = false;

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
    // Edge-align the picker to whichever card side is nearer the click
    // (UX item 1): clicks on the right half of the card anchor the menu's
    // RIGHT edge to the card's right; otherwise the LEFT edge to the left.
    const r = cardRectFor(info.nodeId);
    const side: 'left' | 'right' =
      r && e.clientX > r.left + r.width / 2 ? 'right' : 'left';
    carrySide = side;
    portMenuPos = edgeAlignedMenuPos(info.nodeId, side, { x: e.clientX, y: e.clientY });
    portMenuSourceNodeId = info.nodeId;
    portMenuSourcePortId = info.portId;
    portMenuSourceDirection = info.direction;
    portMenuSourceType = info.type;
    portMenuPreselectNodeId = null; // contextmenu/dblclick → full module list
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

  // ---------------- Edge-aligned patch-to picker (redesign) ----------------
  //
  // The click-and-hold-to-open gesture is RETIRED. The patch menu now opens
  // via the PatchPanel trigger glyphs (handled inside PatchPanel.svelte) and
  // the "patch to" picker opens via the jack-click → carry flow below. Both
  // the contextmenu/dblclick fallbacks AND the carry-picker route through
  // edge-aligned coordinates so the PortContextMenu lines up with the card
  // side it opened from (UX item 1), instead of spawning at the raw cursor.

  /** Resolve a node's CARD bounding rect from the DOM (the svelte-flow node
   *  wrapper). Returns null when the card isn't mounted. */
  function cardRectFor(nodeId: string): DOMRect | null {
    if (typeof document === 'undefined') return null;
    const el = document.querySelector(
      `.svelte-flow__node[data-id="${nodeId}"]`,
    ) as HTMLElement | null;
    return el ? el.getBoundingClientRect() : null;
  }

  /** Edge-align the PortContextMenu to a card side. Falls back to the raw
   *  cursor point when the card rect can't be measured. The menu width
   *  estimate (200) matches PortContextMenu's min-width; the position core
   *  clamps it on-screen. */
  function edgeAlignedMenuPos(
    nodeId: string,
    side: 'left' | 'right',
    fallback: { x: number; y: number },
  ): { x: number; y: number } {
    const r = cardRectFor(nodeId);
    if (!r) return fallback;
    const { left, top } = computeEdgeAlignedRect({
      cardRect: {
        left: r.left,
        top: r.top,
        right: r.right,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
      },
      side,
      menuWidth: 200,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    });
    return { x: left, y: top };
  }

  /** Open the patch-to picker at an explicit position. Used by the carry
   *  ("patch to") flow + the contextmenu/dblclick fallbacks. Does NOT cancel
   *  an in-flight pickup — the carry path relies on the pickup state
   *  surviving until the commit. */
  function openPortMenuAt(
    pos: { x: number; y: number },
    info: NonNullable<ReturnType<typeof handleInfoFromEvent>>,
  ): void {
    try {
      flowApi?.cancelConnection?.();
    } catch { /* defensive */ }
    portMenuPos = pos;
    portMenuSourceNodeId = info.nodeId;
    portMenuSourcePortId = info.portId;
    portMenuSourceDirection = info.direction;
    portMenuSourceType = info.type;
    // Default entry = full module list. The cable-drop drill-down path sets
    // portMenuPreselectNodeId AFTER calling this to pre-drill into one target;
    // every other caller (carry "patch to", contextmenu/dblclick) wants the
    // module list, so clear any stale preselect here.
    portMenuPreselectNodeId = null;
    portMenuOpen = true;
    connectDragState.beginCascade(info.nodeId);
  }

  // ---------------- Jack-click → carry → patch-to picker ----------------
  //
  // PatchPanel dispatches two CustomEvents up the DOM:
  //   * 'patchpanel:jackclick' — the user clicked a port ROW. We begin a
  //     pickup-with-menu (a cable dangles from the cursor; the PatchPanel
  //     surfaces a "patch to" entry) and mark the cascade so the source
  //     panel stays logically in flight. NO menu opens yet — the dangling
  //     cable + the "patch to" entry are the affordance.
  //   * 'patchpanel:patchto' — the user clicked "patch to" in carry mode.
  //     We HIDE the dangling cable (carry/source state retained) + open the
  //     edge-aligned patch-to picker. The picker's port pick commits via
  //     pickPortMenuTarget (validated); Esc / negative-space discards.
  $effect(() => {
    const onJackClick = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        nodeId: string;
        portId: string;
        direction: 'input' | 'output';
        side: 'left' | 'right';
      } | null;
      if (!detail) return;
      const node = patch.nodes[detail.nodeId];
      const def = node ? defLookup(node.type) : undefined;
      let cableType: string | undefined;
      if (def) {
        const port =
          detail.direction === 'output'
            ? def.outputs.find((p) => p.id === detail.portId)
            : def.inputs.find((p) => p.id === detail.portId);
        cableType = port?.type as string | undefined;
      }
      // Detach an occupied input when grabbing it (one-motion rewire) —
      // mirrors handleClickConnectStart.
      if (detail.direction === 'input') {
        ydoc.transact(() => {
          for (const [edgeId, edge] of Object.entries(patch.edges)) {
            if (edge && edge.target.nodeId === detail.nodeId && edge.target.portId === detail.portId) {
              delete patch.edges[edgeId];
            }
          }
        }, LOCAL_ORIGIN);
      }
      connectDragState.beginPickupWithMenu({
        nodeId: detail.nodeId,
        portId: detail.portId,
        handleType: detail.direction === 'output' ? 'source' : 'target',
        cableType,
      });
      // Keep the source panel logically open underneath so its "patch to"
      // entry renders.
      connectDragState.beginCascade(detail.nodeId);
      // Remember the source descriptor + side for the patch-to picker.
      portMenuSourceNodeId = detail.nodeId;
      portMenuSourcePortId = detail.portId;
      portMenuSourceDirection = detail.direction;
      portMenuSourceType = cableType ?? 'audio';
      carrySide = detail.side;
      trace(`jackclick-pickup ${detail.nodeId}.${detail.portId}`);
    };
    const onPatchTo = (e: Event) => {
      const detail = (e as CustomEvent).detail as { nodeId: string } | null;
      if (!detail) return;
      if (connectDragState.mode !== 'pickup') return;
      // Hide the dangling cable; retain the carry/source state for commit.
      connectDragState.hideCableForPicker();
      if (!portMenuSourceNodeId || !portMenuSourcePortId) return;
      const pos = edgeAlignedMenuPos(portMenuSourceNodeId, carrySide, portMenuPos);
      openPortMenuAt(pos, {
        nodeId: portMenuSourceNodeId,
        portId: portMenuSourcePortId,
        direction: portMenuSourceDirection,
        type: portMenuSourceType,
      });
      trace(`patch-to picker opened for ${portMenuSourceNodeId}.${portMenuSourcePortId}`);
    };
    const onCarryCommit = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        nodeId: string;
        portId: string;
        direction: 'input' | 'output';
      } | null;
      if (!detail) return;
      const src = connectDragState.pickupSource;
      if (!src) return;
      // The carried cable runs SOURCE.output → TARGET.input. Resolve which
      // side the clicked row is. A carried OUTPUT lands on an INPUT row; a
      // carried INPUT (rewire) lands on an OUTPUT row.
      let from: { nodeId: string; portId: string };
      let to: { nodeId: string; portId: string };
      if (src.handleType === 'source') {
        from = { nodeId: src.nodeId, portId: src.portId };
        to = { nodeId: detail.nodeId, portId: detail.portId };
      } else {
        from = { nodeId: detail.nodeId, portId: detail.portId };
        to = { nodeId: src.nodeId, portId: src.portId };
      }
      // End the carry FIRST so the validated commit path (which mirrors the
      // picker commit) runs clean; commitCarriedEdge validates + writes or
      // silently discards on invalid (UX item 5).
      connectDragState.discard();
      connectDragState.endCascade();
      commitCarriedEdge(from, to);
    };
    document.addEventListener('patchpanel:jackclick', onJackClick);
    document.addEventListener('patchpanel:patchto', onPatchTo);
    document.addEventListener('patchpanel:carrycommit', onCarryCommit);
    return () => {
      document.removeEventListener('patchpanel:jackclick', onJackClick);
      document.removeEventListener('patchpanel:patchto', onPatchTo);
      document.removeEventListener('patchpanel:carrycommit', onCarryCommit);
    };
  });

  /** Validate + write a carried edge (UX item 5). Mirrors handleConnect's
   *  resolve + validateEdge + transact path, but for the carry/patch-to flow.
   *  On an invalid candidate (output→output, input→input, type-incompat) it
   *  returns SILENTLY — no patch, no toast — matching the drag-path's silent
   *  reject. Stereo L/R auto-wire fires in the same transact. */
  function commitCarriedEdge(
    from: { nodeId: string; portId: string },
    to: { nodeId: string; portId: string },
  ): void {
    const srcNode = patch.nodes[from.nodeId];
    const dstNode = patch.nodes[to.nodeId];
    if (!srcNode || !dstNode) return;
    const srcDef = defLookup(srcNode.type);
    const dstDef = defLookup(dstNode.type);
    if (!srcDef || !dstDef) return;
    const srcExposed = resolveExposedPort(srcNode, from.portId);
    const dstExposed = resolveExposedPort(dstNode, to.portId);
    const srcPort = srcDef.outputs.find((p) => p.id === from.portId);
    const dstPort = dstDef.inputs.find((p) => p.id === to.portId);
    const sourceType: CableType = srcExposed?.cableType ?? srcPort?.type ?? 'audio';
    const targetType: CableType = dstExposed?.cableType ?? dstPort?.type ?? sourceType;
    const id = `e-${from.nodeId}-${from.portId}-${to.nodeId}-${to.portId}`;
    if (patch.edges[id]) {
      trace(`carry-commit: edge already exists ${id}`);
      return;
    }
    const candidate: Edge = { id, source: from, target: to, sourceType, targetType };
    const verdict = validateEdge(candidate, Object.values(patch.nodes) as ModuleNode[], defLookup);
    if (!verdict.ok) {
      // SILENT discard — output→output / input→input / type-incompat.
      trace(`carry-commit reject ${from.nodeId}.${from.portId} → ${to.nodeId}.${to.portId}: ${verdict.reason}`);
      return;
    }
    ydoc.transact(() => {
      for (const [edgeId, edge] of Object.entries(patch.edges)) {
        if (edge && edge.target.nodeId === to.nodeId && edge.target.portId === to.portId) {
          delete patch.edges[edgeId];
        }
      }
      patch.edges[id] = { id, source: from, target: to, sourceType, targetType };
      writeStereoSiblingEdge(from, to);
    }, LOCAL_ORIGIN);
    trace(`carry-commit ${from.nodeId}.${from.portId} → ${to.nodeId}.${to.portId}`);
  }

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
      // Always snapshot the pointer so a native connect-drop (which gives us no
      // coords) can edge-align its drill-down picker.
      lastPointer = { x: e.clientX, y: e.clientY };
      if (connectDragState.mode !== 'pickup') return;
      connectDragState.updatePickupCursor(e.clientX, e.clientY);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (connectDragState.mode !== 'pickup') return;
      e.preventDefault();
      e.stopPropagation();
      connectDragState.cancelPickup();
      connectDragState.endCascade();
      // Also close the patch-to picker if it was up (carry → patch-to → Esc).
      portMenuOpen = false;
      portMenuSourceNodeId = null;
      portMenuSourcePortId = null;
      portMenuPreselectNodeId = null;
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
    // Cascade is committing — release the source PatchPanel's lock + end any
    // carry/pickup that fed this picker (the cable is consumed by the patch).
    connectDragState.endCascade();
    if (connectDragState.mode === 'pickup') connectDragState.discard();
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
    // FW3 structural gate (UX item 5): the candidate must be materializable
    // (direction + canConnect type compatibility). The cascade list is
    // already filtered to compatible ports, but the carry flow can reach
    // here for an output→output / input→input / type-incompat pick (e.g. a
    // future direct port-row picker) — validate + SILENTLY discard on
    // failure (no toast), matching the drag-path's silent return.
    const candidate: Edge = { id, source: from, target: to, sourceType, targetType };
    const verdict = validateEdge(candidate, Object.values(patch.nodes) as ModuleNode[], defLookup);
    if (!verdict.ok) {
      trace(`patch-to reject ${from.nodeId}.${from.portId} → ${to.nodeId}.${to.portId}: ${verdict.reason}`);
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
      // Stereo L/R auto-wire — write the sibling edge in the SAME transact.
      writeStereoSiblingEdge(from, to);
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
    clearAnnotate(nodeId); // drop any personal annotate-mode state for this node
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
    if (def?.maxInstances !== undefined && wouldExceedCap(patch.nodes, def)) {
      const existing = instanceCount(patch.nodes, source.type);
      const msg = `${def.label ?? source.type}: at instance cap (${existing}/${def.maxInstances})`;
      trace(`duplicate refused: ${source.type} at cap (${existing}/${def.maxInstances})`);
      error = msg;
      setTimeout(() => {
        if (error === msg) error = null;
      }, 4000);
      return;
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
    if (def?.maxInstances !== undefined && wouldExceedCap(patch.nodes, def)) {
      const existing = instanceCount(patch.nodes, type);
      trace(`refused spawn ${type}: at cap (${existing}/${def.maxInstances})`);
      return;
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
        // R-1: construct the context with the user's chosen buffer/latency
        // hint. `latencyHint` is only honoured at CONSTRUCTION — a bigger
        // buffer gives the render thread slack under main-thread CPU load
        // (the "clicks get worse when I touch the UI" symptom). The chosen
        // mode is persisted per-machine; a mid-session change applies on the
        // next reload (the footer selector shows a "reload to apply" hint).
        const chosenLatencyMode = audioLatencyStore.current;
        // A2a: pin the context to 48 kHz. Every ART baseline, DSP-core unit
        // test, and worklet time-constant is calibrated at 48 000 Hz; without
        // the pin a 44.1 kHz-native device (common on Macs) renders a graph
        // the baselines never verified. The browser resamples to the hardware
        // rate at the output — transparent, and far cheaper than every module
        // handling arbitrary rates.
        audioCtx = new AudioContext({
          latencyHint: audioLatencyStore.latencyHint,
          sampleRate: 48000,
        });
        audioLatencyStore.bootedWith(chosenLatencyMode);
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
          // Construct at the aspect store's current res — so an aspect picked
          // before boot (e.g. restored from a loaded patch via the doc) lands
          // at the right size from the first frame. 4:3 by default.
          const ve = new VideoEngine({ res: videoAspectStore.engineRes });
          e.registerDomain(ve);
          // Wire the store ↔ engine: set() drives an IN-PLACE realloc (NOT a
          // teardown — the patched OUTPUT survives the switch). The applier
          // also runs once now to apply the boot res.
          videoAspectStore.setEngineApplier((res) => ve.setResolution(res.width, res.height));
          trace(`video engine registered (res=${ve.res.width}x${ve.res.height})`);
        } catch (videoErr) {
          console.warn('[canvas] video engine unavailable:', videoErr);
          trace(`video engine unavailable: ${videoErr instanceof Error ? videoErr.message : videoErr}`);
        }
        reconciler = attachReconciler(e);
        engine = e;
        setActiveEngine(e); // expose to non-context consumers (Electra bar button)
        trace(`engine + reconciler attached (sr=${audioCtx.sampleRate}, latency=${chosenLatencyMode})`);
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
      // Simulated-MIDI NOTE injection (WORKSTREAM B): pushes a NOTE on/off
      // (velocity 0 = note-off) through the same dispatch path real hardware
      // uses, so NOTE learn + gate/button dispatch are exercised e2e. DEV-only.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__midiTestInjectNote = (channel: number, note: number, velocity: number) => {
        const send = installSimulatedNoteDevice();
        send(channel, note, velocity);
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
      // Simulated LAUNCHPAD pair for e2e: installs an in-memory L+R Launchpad
      // (no Web MIDI prompt), binds the pair to a clip-player node, and returns
      // a driver that pushes pad/CC presses through the SAME decode/dispatch path
      // real hardware uses (so the real-source-chain spec drives a pad → clip
      // launch → audible RMS). DEV-only — stripped from prod bundles.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__launchpadTestInstall = async (clipNodeId: string) => {
        const sim = await installSimulatedLaunchpad();
        bindLaunchpadToClip(clipNodeId);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (globalThis as any).__launchpadSim = {
          // press a clip pad on the LEFT (matrix) unit: x=slot, y=lane.
          pressL: (x: number, y: number) => sim.press('L', x, y),
          releaseL: (x: number, y: number) => sim.release('L', x, y),
          pressR: (x: number, y: number) => sim.press('R', x, y),
          releaseR: (x: number, y: number) => sim.release('R', x, y),
          ccR: (cc: number, value: number) => sim.cc('R', cc, value),
          ccL: (cc: number, value: number) => sim.cc('L', cc, value),
          // probe the binding's mode/keys state (for the KEYS real-source-chain spec).
          state: () => __launchpadTestMode(),
        };
        return true;
      };
      // SINGLE-UNIT Launchpad sim for e2e: installs ONE in-memory device bound to
      // the L slot, forces the single deployment, then binds the clip-player. The
      // lone device routes/paints by the active VIEW; every sim event flows on the
      // one device (sent on unit 'L'), so the driver exposes view-agnostic
      // press/cc + a viewFlip that drives the hardware CC-98 toggle.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__launchpadTestInstallSingle = async (clipNodeId: string) => {
        const sim = await installSimulatedLaunchpadSingle();
        __test_setDeployment('single', 'clip');
        bindLaunchpadToClip(clipNodeId);
        const CC_VIEW_FLIP = 98; // CC_TOP_SPARE_8 — the single-unit view toggle.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (globalThis as any).__launchpadSingleSim = {
          // press/cc on the ONE device (it's the L slot); routed by active view.
          press: (x: number, y: number) => sim.press('L', x, y),
          release: (x: number, y: number) => sim.release('L', x, y),
          cc: (cc: number, value: number) => sim.cc('L', cc, value),
          // flip clip↔control via the hardware CC-98 button (press+release).
          viewFlip: () => { sim.cc('L', CC_VIEW_FLIP, 127); sim.cc('L', CC_VIEW_FLIP, 0); },
          // probe the binding's view/mode state (deployment, activeView, mode).
          state: () => __launchpadTestMode(),
        };
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
    function isFlip(e: KeyboardEvent): boolean {
      // Plain Tab toggles rear view. We deliberately ignore any modifier combo
      // (Cmd/Ctrl/Alt/Shift-Tab) so OS/browser tab-switching + Shift-Tab focus
      // traversal are untouched — only a bare Tab is the rack-flip shortcut.
      return e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
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
      } else if (isFlip(e)) {
        // Tab flips the rack front↔rear. NOTE: this overrides Tab's native
        // focus-traversal while the canvas (not a text field) is focused — the
        // intended tradeoff (user-requested rack-flip shortcut). Text inputs +
        // contentEditable are already excluded by shouldIgnore() above.
        e.preventDefault();
        toggleRearView();
        trace('flip-rack-tab');
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

  // ---------------- Rear view ("flip rack") — rack Phase 3 ----------------
  //
  // LOCAL view state ONLY — a single global toggle that flips EVERY card over
  // its own Y axis IN PLACE to reveal its back panel (declared patch jacks), so
  // the user can trace wiring from behind. It is NOT synced patch data (never
  // written to the Y.Doc), NOT per-node. When on, the `.rear-view` class is set
  // on the flow container; pure CSS (in _module-card.css + global.css) drives
  // the per-card 3D flip + the cable emphasis. The back face itself is rendered
  // by PatchPanel (which already has each node's inputs/outputs).
  let rearView = $state(false);

  // Transient "flipping back to front" cue. CSS can animate the flip TO rear view
  // (the back panel mounts → `card-back-flip-in` keyframe), but it CANNOT animate
  // the return: leaving rear view just sets the back panel `display:none`, with no
  // element to keyframe. So on exit we set `flipBack` for the keyframe's duration —
  // `.flow.flip-back` runs `card-front-flip-in` (rotateY +90→0, the OPPOSITE
  // direction) on the now-visible card fronts — then clear it. (Re-entering rear
  // view immediately cancels a pending clear so the two never fight.)
  let flipBack = $state(false);
  let flipBackTimer: ReturnType<typeof setTimeout> | null = null;
  const FLIP_MS = 360; // mirrors card-front/back-flip-in duration in _module-card.css

  function setRearView(next: boolean) {
    if (next === rearView) return;
    if (flipBackTimer) {
      clearTimeout(flipBackTimer);
      flipBackTimer = null;
    }
    if (!next) {
      // Going front: arm the return animation, then clear it once it settles.
      flipBack = true;
      flipBackTimer = setTimeout(() => {
        flipBack = false;
        flipBackTimer = null;
      }, FLIP_MS);
    } else {
      // Going rear: the back panel's own keyframe handles the motion.
      flipBack = false;
    }
    rearView = next;
  }
  const toggleRearView = () => setRearView(!rearView);

  // ---------------- OUTPUT aspect (4:3/16:9) ↔ Y.Doc sync ----------------
  //
  // The canonical persisted value lives in the patch Y.Doc settings map (rides
  // save/load + perf export + multiplayer). The videoAspectStore is the reactive
  // reflection the topbar pill binds to + the bridge to VideoEngine. Here we:
  //   - register the persister (store.set → write the doc),
  //   - observe the doc settings map (remote edit / patch load) → reflect into
  //     the store WITHOUT re-persisting (avoids a write loop),
  //   - seed the store from the doc on mount (a rack that already has an aspect).
  let videoAspectObserver: (() => void) | null = null;
  onMount(() => {
    const settings = ydoc.getMap(SETTINGS_MAP_KEY);
    // Persister: store.set(aspect) writes it into the doc under LOCAL_ORIGIN.
    videoAspectStore.setPersist((aspect) => writeVideoAspectToDoc(ydoc, aspect, LOCAL_ORIGIN));
    // Reflect the doc → store (no re-persist) on any settings change.
    const onSettings = () => {
      const a = readVideoAspectFromDoc(ydoc);
      if (a && a !== videoAspectStore.aspect) videoAspectStore.set(a, /*persist*/ false);
    };
    settings.observe(onSettings);
    videoAspectObserver = () => settings.unobserve(onSettings);
    // Seed from the doc (a rack that already carries an aspect, e.g. a
    // collaborator joining a 16:9 rack). Legacy / fresh racks stay 4:3.
    onSettings();
    // Seed the preset-slot bar's red/green state from IndexedDB (this browser
    // profile's quick-switch slots persist across reloads).
    void refreshSlotOccupancy();
  });

  onDestroy(() => {
    videoAspectObserver?.();
    videoAspectObserver = null;
    videoAspectStore.setEngineApplier(null);
    videoAspectStore.setPersist(null);
    reconciler?.dispose();
    engine?.dispose();
    setActiveEngine(null); // clear the non-context engine ref on unmount
    audioGate?.bind(null);
  });

  let nodeCount = $derived(flowNodes.length);
  let edgeCount = $derived(flowEdges.length);
  let availableModules = $derived(listModuleDefs().length + listVideoModuleDefs().length);

  // Product version, inlined at build time from the root package.json (Vite
  // `define: { __APP_VERSION__ }`; see packages/web/vite.config.ts). Rendered
  // in the topbar brand heading below; the version-heading e2e asserts the
  // rendered `[data-testid="app-version"]` text equals `v<package version>`.
  const appVersion = __APP_VERSION__;
</script>

<div class="root" class:lasso-mode={lassoMode} data-testid="canvas-root">
  <header class="topbar">
    <h1>patchtogether <span class="app-version" data-testid="app-version">v{appVersion}</span></h1>
    <!-- Quick-switch PRESET SLOTS (top-left): five numbered buttons.
         EMPTY = red, OCCUPIED = green. Left-click a green slot to switch to it
         instantly; right-click any slot for Load / Replace / Clear. Save Set /
         Load Set bundle the whole bar (+ MIDI map) as a portable .set file. -->
    <div class="preset-bar" data-testid="preset-slot-bar">
      {#each Array(SLOT_COUNT) as _, i (i)}
        <button
          class="slot"
          class:occupied={slotOccupied[i]}
          data-testid={`preset-slot-${i + 1}`}
          data-occupied={slotOccupied[i] ? 'true' : 'false'}
          disabled={slotBusy}
          onclick={() => onSlotClick(i)}
          oncontextmenu={(e) => onSlotContextMenu(e, i)}
          title={slotOccupied[i]
            ? `Preset slot ${i + 1} (loaded) — click to switch, right-click to replace/clear`
            : `Preset slot ${i + 1} (empty) — right-click to load a performance .zip`}
        >{i + 1}</button>
      {/each}
      <button
        class="set-btn"
        data-testid="save-set-btn"
        disabled={slotBusy}
        onclick={saveSet}
        title="Save the whole preset bar (all loaded slots + MIDI mapping) as a portable .set file"
      >Save Set</button>
      <button
        class="set-btn"
        data-testid="load-set-btn"
        disabled={slotBusy}
        onclick={loadSet}
        title="Load a .set file — repopulates all five preset slots + restores the MIDI mapping"
      >Load Set</button>
    </div>
    <!-- No "+ Add module" button here: the module palette opens by
         right-clicking an empty spot on the canvas pane (onPaneContextMenu),
         which also anchors the spawn at the click point. The button was
         removed so the topbar fits narrow (1024px) viewports. -->
    <div class="actions">
      <!-- "Load example…" is an ACTION menu, not a persistent value: each
           option spawns/loads its example exactly as the old standalone
           buttons did, then onExampleChosen() resets the value back to the
           placeholder so the same example can be re-loaded. Replaces the
           old System 55/35, Load example, GLITCHES, and Media Burn buttons. -->
      <select
        class="primary load-example"
        data-testid="load-example-select"
        bind:value={exampleChoice}
        disabled={booting}
        onchange={(e) => onExampleChosen(e.currentTarget.value as ExampleKey)}
        title="Load a curated example patch or spawn a full Moog cabinet."
      >
        <option value="" disabled selected>{booting ? 'Loading…' : 'Load example…'}</option>
        <option value="sequenced-vco">Sequenced VCO</option>
        <option value="system-55">System 55</option>
        <option value="system-35">System 35</option>
        <option value="media-burn">Media Burn</option>
        <option value="glitches">Glitches Get Riches</option>
        <option value="gibribbon-demo">GIBRIBBON (game demo)</option>
      </select>
      <button onclick={clearPatch} disabled={nodeCount === 0}>Clear</button>
      <button
        onclick={exportPerformanceZip}
        disabled={nodeCount === 0 || perfZipBusy}
        data-testid="export-perf-zip-btn"
        title="Export the WHOLE rack as a portable .zip (patch + ALL embedded images/videos/samples + CV routes + control-surface + MIDI/gamepad maps). Move it to another machine and Load performance to reproduce the show exactly."
      >Export Perf (.zip)</button>
      <button
        onclick={loadPerformanceZip}
        disabled={perfZipBusy}
        data-testid="load-perf-zip-btn"
        title="Load a portable performance .zip into a fresh rack — restores the patch + ALL embedded media + mappings on any machine (no re-pick needed)."
      >Load Perf (.zip)</button>
      <!-- "Raw JSON" — lightweight envelope-only export/import (no media/zip).
           ACTION menu (like "Load example…"): each option fires its handler,
           then onRawJsonChosen() resets the value to the placeholder so the
           same action can be re-picked. Restores the raw-JSON convenience the
           old Save/Load buttons gave (removed in #771). Sits in the top-RIGHT
           actions cluster, clear of the top-LEFT preset slots. -->
      <select
        class="raw-json"
        data-testid="raw-json-select"
        aria-label="Raw JSON export / import"
        bind:value={rawJsonChoice}
        onchange={(e) => onRawJsonChosen(e.currentTarget.value as RawJsonKey)}
        title="Export the current patch as a raw JSON envelope (graph only, no media), or import one."
      >
        <option value="" disabled selected>Raw JSON</option>
        <option value="export-json">Export JSON (only)</option>
        <option value="import-json">Import JSON</option>
      </select>
      <AspectToggle />
      <SkinSwitcher />
      <!-- The "Send to Electra" button now lives ON the ELECTRA CONTROL card
           (ElectraControlCard.svelte), not the topbar — a rack without an
           ElectraControl module intentionally has no send button. -->
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

  <!-- Per-slot right-click context menu. A full-screen transparent backdrop
       closes it on any outside click / right-click. -->
  {#if slotMenu}
    {@const sm = slotMenu}
    <div
      class="slot-menu-backdrop"
      role="presentation"
      onclick={closeSlotMenu}
      oncontextmenu={(e) => { e.preventDefault(); closeSlotMenu(); }}
    ></div>
    <div
      class="slot-menu"
      data-testid="preset-slot-menu"
      style={`left:${sm.x}px; top:${sm.y}px;`}
      role="menu"
    >
      <div class="slot-menu-title">Slot {sm.index + 1}</div>
      {#if slotOccupied[sm.index]}
        <button role="menuitem" data-testid="slot-menu-switch" onclick={() => loadSlot(sm.index)}>Switch to this</button>
        <button role="menuitem" data-testid="slot-menu-replace" onclick={() => loadIntoSlot(sm.index)}>Replace with…</button>
        <button role="menuitem" data-testid="slot-menu-clear" onclick={() => clearSlot(sm.index)}>Clear slot</button>
      {:else}
        <button role="menuitem" data-testid="slot-menu-load" onclick={() => loadIntoSlot(sm.index)}>Load…</button>
      {/if}
    </div>
  {/if}

  {#if error}
    <pre class="error">{error}</pre>
  {/if}

  <div class="flow" class:rear-view={rearView} class:flip-back={flipBack} data-rear-view={rearView ? 'true' : undefined} bind:this={flowEl}>
    <SvelteFlow
      nodes={flowNodes}
      edges={flowEdges}
      {nodeTypes}
      fitView
      colorMode="dark"
      zoomOnDoubleClick={false}
      onconnect={handleConnect}
      {isValidConnection}
      onconnectstart={handleConnectStart}
      onconnectend={handleConnectEnd}
      onclickconnectstart={handleClickConnectStart}
      onclickconnectend={handleClickConnectEnd}
      connectionDragThreshold={5}
      connectionMode={ConnectionMode.Loose}
      ondelete={handleDelete}
      onnodedragstop={handleNodeDragStop}
      onpanecontextmenu={onPaneContextMenu}
      onnodecontextmenu={onNodeContextMenu}
      onselectioncontextmenu={onSelectionContextMenu}
    >
      <!-- Base canvas: the fine 16px dot field (legacy look, sets the bg fill). -->
      <Background id="fine" size={1} gap={16} bgColor="#0e1116" patternColor="#1f242c" />
      <!-- Virtual-rack grid (Phase 2): a true RING overlay aligned to the 180px
           rack unit (--rack-unit) in BOTH axes, so it lines up with the 1u×1u
           tile cards snap to. Pans/zooms WITH the canvas (each is a
           <Background>).

           Built as an ANNULUS from two FILLED dot layers (NOT a stroked
           circle): SvelteFlow's DotPattern anchors the <circle> at the
           pattern-cell origin, and STROKING it clips at the cell edges → warped
           flat-sided "rounded squares". FILLED dots tile cleanly. So:
             - ring layer  — filled dot, 20px outer Ø, --rack-grid-color
               (theme-aware --bg-grid-dot; follows the active skin, e.g.
               MATRIXCOWBOY → phosphor green).
             - hole layer  — filled dot, 10px Ø, painted the canvas background
               (--bg) and drawn ON TOP to punch the centre out → a clean 20px/10px
               ring at every 180px rack intersection.
           Both DotPattern circles centre on the SAME pattern origin (cx=cy=r,
           then -r offset), so the 10px hole sits dead-centre on the 20px ring
           regardless of size → concentric annulus. -->
      <Background id="rack-ring" gap={180} size={20} patternColor="var(--rack-grid-color)" />
      <Background id="rack-hole" gap={180} size={10} patternColor="var(--bg)" />
      <Controls>
        {#snippet before()}
          <!-- Flip rack (rear view): flips every card over its own Y axis in
               place to reveal the back-panel patch jacks for tracing wiring.
               LOCAL view state only — not synced, not per-node. Sits at the TOP
               of the Controls cluster via the `before` snippet. -->
          <ControlButton
            class="svelte-flow__controls-flip-rack"
            onclick={toggleRearView}
            aria-label="Flip rack (rear view)"
            aria-pressed={rearView}
            data-testid="flip-rack-btn"
            data-active={rearView ? 'true' : undefined}
            title={rearView ? 'Front view' : 'Flip rack (rear view)'}
          >
            <!-- Flip/rotate glyph: a rounded arrow pair suggesting a Y-axis flip. -->
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none">
              <path
                d="M5 9a7 7 0 0 1 12-3l2 2M19 15a7 7 0 0 1-12 3l-2-2"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
              <path d="M19 4v4h-4M5 20v-4h4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </ControlButton>
        {/snippet}
      </Controls>
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
      <span title="AudioContext latency. base = render/processing latency (fixed by the buffer); out = full output-pipeline latency to the speakers (Chromium; 0 elsewhere). The buffer size is set by the Buffer selector below (latencyHint) — a bigger buffer trades latency for slack against clicks under UI load.">
        lat <b>{audioCtx ? `${(audioCtx.baseLatency * 1000).toFixed(1)}ms` : '—'}</b>{#if audioCtx && audioCtx.outputLatency > 0}<b> / {(audioCtx.outputLatency * 1000).toFixed(1)}ms out</b>{/if}
      </span>
      <span class="audio-buffer-ctl" title={`Audio buffer / latency. A BIGGER buffer gives the audio render thread slack under main-thread CPU load (canvas pan, knob drag, video) so it doesn't underrun → fewer clicks/pops. A SMALLER buffer = lower latency for tight live jamming. ${audioLatencyStore.currentOption.hint} latencyHint is fixed at context creation, so a change applies on the next page reload.`}>
        buffer
        <select
          class="audio-buffer-select"
          data-testid="audio-buffer-select"
          aria-label="Audio buffer / latency"
          value={audioLatencyStore.current}
          onchange={(e) => audioLatencyStore.set(e.currentTarget.value as AudioLatencyMode)}
        >
          {#each audioLatencyStore.list() as opt (opt.id)}
            <option value={opt.id}>{opt.label}</option>
          {/each}
        </select>
        {#if audioLatencyStore.reloadPending}
          <span class="audio-buffer-reload" title="The new buffer setting applies on the next page reload — latencyHint can only be set when the AudioContext is created.">⟳ reload to apply</span>
        {/if}
      </span>
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
  hasDocs={ctxMenuHasDocs}
  annotateActive={ctxMenuAnnotateActive}
  onannotate={() => ctxMenuNodeId && toggleAnnotate(ctxMenuNodeId)}
  isGroup={ctxMenuNodeType === 'group'}
  groupExpanded={ctxMenuGroupExpanded}
  locked={ctxMenuLocked}
  canSaveGroup={Boolean(currentUserId) && ctxMenuNodeType === 'group'}
  canSeeSnesOutputDef={ctxMenuCanSeeSnesOutputDef}
  currentControlColor={ctxMenuControlColor}
  hasCustomControlColor={ctxMenuHasCustomColor}
  onsetcontrolcolor={(hex) => ctxMenuNodeId && setControlColor(ctxMenuNodeId, hex)}
  onresetcontrolcolor={() => ctxMenuNodeId && setControlColor(ctxMenuNodeId, null)}
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
  onlock={() => ctxMenuNodeId && lockNode(ctxMenuNodeId)}
  onunlock={() => ctxMenuNodeId && unlockNode(ctxMenuNodeId)}
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
  preselectModuleId={portMenuPreselectNodeId}
  onpick={pickPortMenuTarget}
  onclose={() => {
    portMenuOpen = false;
    portMenuSourceNodeId = null;
    portMenuSourcePortId = null;
    portMenuPreselectNodeId = null;
    connectDragState.endCascade();
    // Closing the picker without committing (Esc / negative-space) discards
    // any cable that was carried into it — silently, no patch made.
    if (connectDragState.mode === 'pickup') connectDragState.discard();
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
    /* DYNAMIC overflow guard (owner report: at narrow widths the row of
       topbar controls ran past the viewport and pushed the rightmost
       control — the Sign in / account link at the end of .actions — clean
       off the header; at 1280 it sat ~80px past the edge). flex-wrap lets
       a whole CLUSTER (the .actions div) flow to a second row instead, so
       every control stays inside the viewport at any width ≥ 1024px
       (guarded by the topbar-1024 e2e at 1024/1280/1920).

       VRT note: the wrap makes the topbar TALLER below ~1450px, including
       the 1280×720 VRT viewport, which moves the canvas origin. Per-card
       baselines (vrt.spec, the strict gate) are insulated from that:
       SvelteFlow nodes are transform-positioned (own composited layer,
       whole-pixel snapped), so a card's element screenshot doesn't change
       with the pane offset — verified by running the FULL vrt lane against
       the committed baselines with this wrap in place. Only the
       topbar/landing-page scenes (which frame the header itself) were
       re-captured. */
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.5rem 1rem;
    padding: 0.8rem 1.25rem;
    border-bottom: 1px solid #1f242c;
  }
  /* Never let the topbar's flex row squeeze the controls THEMSELVES. Under the
     default flex-shrink:1 a tight row compressed each control below its
     content width, and the ones with `white-space: normal` (the theme-picker
     dropdown + the aspect / Electra buttons, which live in CHILD components
     and so can't be reached by a `.topbar button` rule scoped to this file)
     wrapped their label to two lines. That ~doubled the row height, grew the
     topbar by a non-integer amount, and shifted the SvelteFlow canvas + every
     card down to a fractional Y — rastering all text-heavy module cards ±1px
     on CI (the documented VRT 1px-layout-rounding flake). Pinning children to
     flex-shrink:0 keeps each control at its natural single-line size; when a
     row gets tight the flex-wrap above moves whole controls to the next row
     instead of compressing them. (.actions below deliberately overrides this
     for ITSELF — it wraps internally, so shrinking it is safe.) */
  .topbar > * {
    flex-shrink: 0;
  }
  .topbar h1 {
    margin: 0;
    font-weight: 500;
    font-size: 1.05rem;
  }
  /* Version suffix: a subtle, dimmer, smaller tag after the brand word. Stays
     on the same single line so it never grows the topbar row height (see the
     .topbar > * flex-shrink:0 note above). The VRT masks this element so a
     version bump can't churn the topbar snapshot. */
  .topbar h1 .app-version {
    color: var(--text-dim);
    font-weight: 400;
    font-size: 0.8rem;
  }
  .topbar .caption {
    color: var(--text-dim);
    font-size: 0.8rem;
  }
  .topbar .actions {
    margin-left: auto;
    display: flex;
    /* The cluster wraps INTERNALLY: whole controls flow to the next row
       (each keeps its natural size via the .actions > * rule below), and
       rows stay right-anchored so the auth control hugs the right edge. */
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 0.4rem;
    /* Override .topbar > * flex-shrink:0 for the cluster itself: letting it
       shrink below its one-line content width is safe (it wraps instead of
       compressing) and guarantees it can never push past the viewport even
       if it ends up alone on a row narrower than its content. min-width:0
       lets flexbox actually take it below the content width. */
    flex-shrink: 1;
    min-width: 0;
  }
  .topbar .actions > * {
    flex-shrink: 0;
  }
  /* The two wide selects may give up a handful of px before the cluster
     wraps — a native select clips its label without changing height, so a
     slight squeeze is invisible while it saves a whole extra row on
     in-between viewport widths. Floored so they never collapse into an
     unusable sliver. (Higher specificity than the .actions > * pin above.) */
  .topbar select.load-example,
  .topbar select.raw-json {
    flex-shrink: 1;
    min-width: 6.5rem;
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
  /* "Load example…" dropdown — styled to read as the primary curated-demo
     control, mirroring the visual weight of the buttons it replaced. */
  .topbar select.load-example {
    background: var(--cable-audio);
    color: #1a1d23;
    border: 1px solid var(--cable-audio);
    padding: 0.35rem 0.8rem;
    font-size: 0.8rem;
    font-family: inherit;
    font-weight: 600;
    border-radius: 4px;
    cursor: pointer;
  }
  .topbar select.load-example:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  /* The dropdown's expanded options render in the OS-native menu, which
     ignores the dark control colors above; force readable contrast. */
  .topbar select.load-example option {
    background: #2a2f3a;
    color: var(--text);
  }
  /* "Raw JSON" dropdown — neutral utility control (matches .topbar button,
     not the accent .load-example): it's a convenience export/import, not a
     curated-demo loader. */
  .topbar select.raw-json {
    background: #2a2f3a;
    color: var(--text);
    border: 1px solid #404652;
    padding: 0.35rem 0.8rem;
    font-size: 0.8rem;
    font-family: inherit;
    border-radius: 4px;
    cursor: pointer;
  }
  .topbar select.raw-json option {
    background: #2a2f3a;
    color: var(--text);
  }
  .topbar button:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  /* ---- Preset SLOT bar (top-left) ---- */
  .topbar .preset-bar {
    display: flex;
    align-items: center;
    gap: 0.3rem;
  }
  .topbar .preset-bar .slot {
    /* Compact, fixed-width numbered button. EMPTY = red, OCCUPIED = green. */
    width: 1.7rem;
    padding: 0.3rem 0;
    text-align: center;
    font-weight: 600;
    /* Empty (default): red. */
    background: #5a2230;
    border-color: #8a3346;
    color: #ffd7df;
  }
  .topbar .preset-bar .slot.occupied {
    background: #1f5a32;
    border-color: #2f8a4c;
    color: #d7ffe2;
  }
  .topbar .preset-bar .slot:hover:not(:disabled) {
    filter: brightness(1.2);
  }
  .topbar .preset-bar .set-btn {
    margin-left: 0.2rem;
  }
  /* ---- Per-slot right-click context menu ---- */
  .slot-menu-backdrop {
    position: fixed;
    inset: 0;
    z-index: 9998;
    background: transparent;
  }
  .slot-menu {
    position: fixed;
    z-index: 9999;
    min-width: 9rem;
    background: #2a2f3a;
    border: 1px solid #404652;
    border-radius: 5px;
    padding: 0.25rem;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.5);
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .slot-menu .slot-menu-title {
    color: var(--text-dim);
    font-size: 0.72rem;
    padding: 0.2rem 0.45rem;
  }
  .slot-menu button {
    background: transparent;
    color: var(--text);
    border: none;
    text-align: left;
    padding: 0.35rem 0.45rem;
    font-size: 0.8rem;
    border-radius: 4px;
    cursor: pointer;
  }
  .slot-menu button:hover {
    background: #3a4150;
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
  /* R-1 audio buffer / latency selector — sits in the footer status row,
   * styled to match the load-example dropdown chrome. */
  .audio-buffer-ctl {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
  }
  .audio-buffer-select {
    background: #11151b;
    color: var(--text);
    border: 1px solid #2a313b;
    border-radius: 4px;
    padding: 0.05rem 0.25rem;
    font-family: ui-monospace, monospace;
    font-size: 0.72rem;
    cursor: pointer;
  }
  .audio-buffer-select:hover {
    border-color: var(--accent);
  }
  .audio-buffer-reload {
    color: var(--accent);
    font-size: 0.68rem;
    white-space: nowrap;
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

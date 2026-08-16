<script lang="ts">
  // Day 7 — Svelte Flow canvas + module cards + auto-reactive engine.
  //
  // Spawn a module from the palette → patch graph populates → Svelte Flow
  // renders cards → reconciler instantiates engine nodes → audio plays.
  // Twiddle a knob →
  // patch graph mutates → reconciler calls engine.setParam → audible change.
  import { onDestroy, onMount, untrack } from 'svelte';
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
  import { patch, ydoc, undoManager, LOCAL_ORIGIN, onBindRackspace } from '$lib/graph/store';
  import { buildDuplicate } from '$lib/graph/duplicate';
  import { instanceCount, wouldExceedCap } from '$lib/graph/cap';
  // MODULE-level clip automation: the module menu's "Assign to automation
  // lane" + the assigned-card lane-colour border + the graph-level prune.
  import {
    coerceAutoAssign,
    laneColorEff as autoLaneColorEff,
    scrubClipPlayerTransientData,
    CLIP_LANES as AUTO_CLIP_LANES,
    type ClipPlayerData as AutoClipPlayerData,
  } from '$lib/audio/modules/clip-types';
  import {
    listClipPlayers,
    assignAutomationLane,
    removeAutomationAssignment,
    automationAssignmentFor,
    pruneAllAutoAssignDangling,
    repairDuplicateAutoAssign,
  } from '$lib/graph/automation-assign';
  import { reconcileCvBuddyEs9 } from '$lib/graph/cv-buddy-es9-reconcile';
  import {
    isClipEligible,
    isMixerEligible,
    planClipControl,
    planSendToMixer,
  } from '$lib/graph/patch-convenience';
  import {
    reconcileColumns,
    PINNED_MIXER_ID as WCOL_MIXER_ID,
    PINNED_CLIP_ID as WCOL_CLIP_ID,
    type ColumnDefResolver,
  } from '$lib/graph/column-reconcile';
  import {
    COLUMN_COUNT,
    SEND_BOX_COUNT,
    laneTargetForFlowPoint,
    sendBoxForFlowX,
    columnPitch,
    indexForDropY,
    insertBottom,
    removeFrom,
    reorder,
    columnFlushPositions,
    sendFlushPositions,
    COLUMN_BASELINE_Y,
    defaultLaneHeightPx,
    computeLaneHeightPx,
    computeShellLaneHeightPx,
    shellStackAnchorY,
    laneTopYForHeight,
    planLanePushUps,
    needsDefaultVideoOut,
    rackLacksType,
    videoOutSpawnPos,
    videoZoneSlotPos,
    VIDEO_ZONE_DEFAULTS,
    DEFAULT_VIDEO_OUT_ID,
    VIDEO_ZONE_EXTRA_DEFAULTS,
    videoZoneWiresFor,
    resolveMasterVideoOutId,
    laneCenterViewport,
    videoAreaViewport,
    fitLanesViewport,
    spawnRevealViewport,
    type ModuleBoxLike,
    type ViewportMetrics,
  } from '$lib/graph/channel-columns';
  import { setControlColor, setNodeLocked, setNodeParam } from '$lib/graph/mutate';
  import { snapPositionToGrid, findFreeRackSlot, RACK_UNIT, type RackRect } from '$lib/ui/rack-grid';
  import { resolveControlColor } from '$lib/graph/control-color';
  import {
    planSingletonCleanup,
    isElectedDeleter,
    isSafeToDelete,
    type CleanupPeer,
  } from '$lib/graph/singleton-cleanup';
  import { getDefaultSnapshotBus, type PatchSnapshot } from '$lib/graph/snapshot';
  // STRATA semantic-zoom (P0.2): the shared workflow zoom store + the LOD tier
  // context. `setWorkflowZoom` is fed from the onmove handlers below;
  // `provideLodTier` publishes the derived tier on context for P0.3 cards.
  import { setWorkflowZoom, provideLodTier } from '$lib/ui/canvas/workflow-zoom';
  import {
    makeEnvelope,
    makePortableEnvelope,
    parseEnvelope,
    loadEnvelopeIntoStore,
    downloadEnvelope,
    DEFAULT_FILENAME,
    EnvelopeParseError,
    readVideoAspectFromDoc,
    writeVideoAspectToDoc,
    SETTINGS_MAP_KEY,
    type PatchEnvelope,
  } from '$lib/graph/persistence';
  import { summarizeLoadDiagnostics } from '$lib/graph/load-diagnostics';
  import { flushAllCcCommits } from '$lib/ui/controls/cc-commit';
  import {
    makePerformanceBundle,
    validateBundle,
    BundleParseError,
    mergeMidiBindings,
    resolveMidiDeviceId,
    MIDI_DEVICE_NODE_TYPES,
    MIDI_OUTPUT_DEVICE_NODE_TYPES,
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
  // P4: destructive-import confirm (persistence hardening).
  import {
    confirmDestructiveImport,
    IMPORT_REPLACE_CONFIRM_MESSAGE,
  } from '$lib/ui/canvas/import-confirm';

  function persistenceLoad(env: unknown, ydocArg: typeof ydoc, patchArg: typeof patch) {
    // Validate via parseEnvelope when a raw object is passed; if already typed,
    // pass through.
    let validated: PatchEnvelope;
    if (typeof env === 'object' && env !== null && typeof (env as PatchEnvelope).envelopeVersion === 'number') {
      validated = env as PatchEnvelope;
    } else {
      validated = parseEnvelope(JSON.stringify(env));
    }
    const result = loadEnvelopeIntoStore(validated, ydocArg, patchArg);
    // THE USER-FACING HALF of the unknown-type drop path. Until this existed
    // the loader dropped nodes AND every cable touching them, reported it to
    // `console.warn`, and the rack loaded "successfully" — silent data loss
    // with a plan attached, for all 18 previously-deleted module types. This
    // is deliberately a NON-BLOCKING notice: the rack really did load, so the
    // user must be able to keep working. Summary logic + its unit gate live
    // in $lib/graph/load-diagnostics.
    loadNotice = summarizeLoadDiagnostics(result.diagnostics);
    return result;
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
  // Card-viewport visibility feed for the video engine's sink-driven pull
  // evaluation (one central IntersectionObserver over the flow nodes).
  import { observeVideoCardVisibility } from '$lib/ui/video-card-visibility';
  // Persisted-rack VIDEO boot decision (fix/video-engine-persist-reconcile):
  // boot the engine once a restored graph with video in it has loaded, so the
  // render loop starts WITHOUT a manual add/delete.
  import { shouldBootEngineForRestoredVideo } from '$lib/ui/restored-video-boot';
  // Meta-domain registry — sticky notes etc. (no engine binding).
  import { listMetaModuleDefs, getMetaModuleDef } from '$lib/meta/module-registry';
  import '$lib/meta/modules'; // auto-registers stickyDef
  // Module cards are resolved GLOB-DRIVEN from $lib/ui/modules/*Card.svelte
  // via $lib/ui/modules-card-map — no hand-maintained per-card import list
  // (that append-edit was a top cross-PR conflict source). A new module just
  // drops its XyzCard.svelte here (matching the PascalCase(type)+Card
  // convention, or declaring `card` on its def) and is picked up automatically.
  import { buildNodeTypes } from '$lib/ui/modules-card-map';
  // P0.3b — the legacy-fallback MIGRATION bridge: a pure derivation deciding
  // which node component a module renders as in its workflow lane (legacy card /
  // curated ModuleShell / uniform placeholder / dock stub). Gated behind the
  // `?shell=1` opt-in preview flag so it's a strict no-op until owner sign-off.
  import { laneRenderKind, emittedTypeFor, isShellSwappable, NON_SHELL_LANE_TYPES } from '$lib/ui/workflow/legacy-fallback';
  import { migrated } from '$lib/ui/workflow/strict-faces';
  // DOM-SOURCE seam: a video module whose source lives on its CARD stays alive
  // in an off-screen host when the shell swaps its lane card away.
  import { HEADLESS_MOUNT_LANE_TYPES, needsHeadlessSourceMount } from '$lib/ui/workflow/dom-source-modules';
  import { groupCardHostsChildCard } from '$lib/ui/modules/group-viz-hosts';
  import { nodeMedia } from '$lib/ui/media/node-media-registry';
  import { nodeExtras } from '$lib/ui/media/node-extras';
  import { nodePresent } from '$lib/ui/modules/node-present-registry.svelte';
  import { nodeRecorder } from '$lib/ui/modules/node-recorder-registry.svelte';
  import { nodeSamsloop } from '$lib/ui/modules/node-samsloop-registry.svelte';
  import { nodeAudioInput } from '$lib/ui/modules/node-audio-input-registry.svelte';
  import { nodeDoomSession } from '$lib/ui/modules/node-doom-session-registry.svelte';
  import { nodeLaunchpadMonitor } from '$lib/ui/modules/node-launchpad-monitor-registry.svelte';
  import { RACK_SIZE_DEFAULTS } from '$lib/ui/rack-sizes';
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
  import UnpatchMenu from '$lib/ui/UnpatchMenu.svelte';
  import StereoExpandMenu from '$lib/ui/StereoExpandMenu.svelte';
  import StereoDropChoiceMenu from '$lib/ui/StereoDropChoiceMenu.svelte';
  import {
    isExpandableStereoJackModule,
    type StereoPairDefLike,
  } from '$lib/graph/stereo-pairs';
  import {
    isJackExpanded,
    setJackExpanded,
  } from '$lib/ui/stereo-jack-expansion.svelte';
  import { resolveVerboseLabel } from '$lib/ui/patch-panel-labels';
  import { buildUnpatchPlan, type UnpatchPlan, type UnpatchTarget } from '$lib/ui/unpatch-menu';
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
  import { assetLinks } from '$lib/media/asset-links.svelte';
  import { mediaLibrary } from '$lib/media/library.svelte';
  import { runAssetRebindSweep } from '$lib/media/asset-spawn';
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
  import { videoAspectStore } from '$lib/ui/video-aspect-store.svelte';
  import { audioLatencyStore, type AudioLatencyMode } from '$lib/ui/audio-latency-store.svelte';
  import { createAudioHealthMonitor } from '$lib/audio/audio-health.svelte';
  import { formatAudioHealth } from '$lib/audio/playback-stats';
  import FlowBridge, { type FlowBridgeApi, type InternalFlowNode } from '$lib/ui/FlowBridge.svelte';
  import CadillacOverlay from '$lib/ui/CadillacOverlay.svelte';
  import ChannelColumnsOverlay from '$lib/ui/ChannelColumnsOverlay.svelte';
  import PickupCable from '$lib/ui/PickupCable.svelte';
  import { organizeLayout, type Box } from '$lib/ui/canvas/organize';
  import type { CableType, Edge, PortDef, ModuleNode } from '$lib/graph/types';
  import { canConnect } from '$lib/graph/types';
  import { validateEdge } from '$lib/graph/validate-edge';
  import {
    audioEdgeId,
    expandLegGroups,
    planAudioCommit,
    siblingLegIds,
    type ChannelMode,
    type StereoDef,
  } from '$lib/graph/stereo-autowire';
  import { planDropChoice, type DropChoice } from '$lib/graph/stereo-drop-choice';
  import { computeLegGroups } from '$lib/ui/cable-leg-groups';
  import { stereoPairForPort } from '$lib/graph/stereo-pairs';
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
    resolveDisplayName,
  } from '$lib/multiplayer/module-naming';
  // TIMELORDE auto-spawn — the rack always needs a system clock, so when the
  // patch loads (or boots empty) without one, drop a TIMELORDE in. Pure
  // helpers; the $effect that wires them lives further down with the other
  // snapshot-bus subscribers.
  import {
    shouldAutoSpawnTimelorde,
    pickTimelordeDefaultPosition,
  } from '$lib/audio/modules/timelorde-autospawn';
  // THE SHELL. WorkflowTopbar (File.. menu = recomposed existing handlers),
  // the left rail, the pinned M/E/C singleton trio, and the docked drawer (the
  // first dock zone — $lib/ui/dock). None of it is conditional: there is one
  // rack shell, so the fork that used to gate every branch here is gone.
  import WorkflowTopbar from '$lib/ui/workflow/WorkflowTopbar.svelte';
  import {
    resolveWorkflowTimelorde,
    hasExternalClock as hasWorkflowExternalClock,
    isDinAssigned,
  } from '$lib/ui/workflow/workflow-surfaces';
  import {
    listWorkflowCameras,
    workflowCameraAtCap,
  } from '$lib/ui/workflow/workflow-cameras';
  import { isCanvasHiddenNode } from '$lib/graph/hidden-card';
  // DOCKING P2.5a — three dock zones (top rail / LEFT rail = the workflow
  // left toolbar / bottom drawer), plain-mount rail hosts (DockCardHost via
  // DockRail), the canvas-side DockStubCard swap, and the local tombstoned
  // dock store.
  import DockRail from '$lib/ui/dock/DockRail.svelte';
  import DockStubCard from '$lib/ui/dock/DockStubCard.svelte';
  // P0.3b — the workflow-shell lane components: the curated skeleton (migrated
  // modules) + the uniform placeholder (un-migrated). Registered as node types
  // alongside dockStub; emitted only under the `?shell=1` preview.
  import ModuleShell from '$lib/ui/modules/ModuleShell.svelte';
  import ModuleShellPlaceholder from '$lib/ui/modules/ModuleShellPlaceholder.svelte';
  // P0.3b re-spec — the bottom-drawer EXPANDED full-view faceplate (its own
  // full-width RACKLINE faceplate, NOT routed through DockCardHost's card flex).
  import DockFullView from '$lib/ui/dock/DockFullView.svelte';
  // Off-screen lifecycle host for DOM-source video modules the shell swapped out.
  import HeadlessSourceHost from '$lib/ui/workflow/HeadlessSourceHost.svelte';
  import { SHELL_TILE_W, SHELL_TILE_H_SLOT, SHELL_VIDEO_ZONE_TILE_INSET_Y, videoZonePackedXs } from '$lib/ui/workflow/module-shell-model';
  // DOCKING P2.5b: the pan-gesture screen-space cable tail (stub → rail).
  import DockPanTail, { type DockTailSpec } from '$lib/ui/dock/DockPanTail.svelte';
  import { dockStore } from '$lib/ui/dock/dock-store.svelte';
  import { isDockableType } from '$lib/ui/dock/dockable';
  import { hasEs9Bridge } from '$lib/audio/es9/bridge-owner';
  import type { DockZone } from '$lib/ui/dock/dock';
  import {
    WORKFLOW_PINNED_MODULES,
    WORKFLOW_PIN_SPAWN_ORIGIN,
    WORKFLOW_DEFAULT_WIRE_LATCH,
    DRAWER_KEY_TO_PINNED,
    planPinnedSpawns,
    planDefaultWires,
    isPinnedNode,
    isTypingTarget,
    isRackFlipKey,
    RACK_FLIP_KEY,
  } from '$lib/graph/workflow-pins';
  import { removePatchNode } from '$lib/graph/mutate';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { resetLocalScratchId } from '$lib/storage/local-scratch';
  import type { HocuspocusProvider } from '@hocuspocus/provider';
  import type { PresenceUser } from '$lib/multiplayer/presence';
  import { installSimulatedMidiDevice, installSimulatedNoteDevice } from '$lib/midi/midi-learn.svelte';
  import {
    installSimulatedLaunchpad,
    installSimulatedLaunchpadSingle,
    installSimulatedLaunchpadMonitorDevice,
    isMonitorBound,
    monitorOutputId,
    type SimulatedLaunchpadMonitorDevice,
  } from '$lib/control/launchpad/launchpad-device.svelte';
  import { bindLaunchpadToClip, __test_setDeployment, __test_mode as __launchpadTestMode } from '$lib/control/launchpad/launchpad-control.svelte';
  import {
    installSimulatedPush2AndBind,
    selectedChannelIndex as __push2SelectedChannel,
    currentPushCardView as __push2CardView,
    focusedModuleId as __push2FocusedModule,
  } from '$lib/control/push2/push2-control.svelte';

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
    // DOCKING P2.5a: the localStorage key scope for this rack's dock state
    // (`pt.dock.v2:${rackspaceId}`). /r/[id] passes the rackspace id; the
    // scratch canvases fall back to 'scratch'.
    rackspaceId?: string;
    // SCRATCH SEED GATE (/rack only). On the scratch canvas there is no relay
    // provider to gate the workflow "ensure" effects (pinned trio + default
    // wire) against, so they'd otherwise fire on mount and write default pinned
    // state into deterministic keys BEFORE the IndexedDB local replica finishes
    // seeding — racing the restored state at the same Yjs key (clientID
    // tiebreak) and ~half the time discarding the user's saved pinned-module
    // settings. /rack threads its replica-seeded boolean here (false while the
    // seed is pending, true once resolved); the two ensures defer on
    // `scratchSeeded === false`. UNDEFINED for real /r/[id] racks (they gate on
    // the provider sync instead) → their ensure behavior is unchanged. Canvas
    // otherwise mounts immediately regardless — only the ensures wait.
    scratchSeeded?: boolean;
  }
  let {
    currentUserId,
    provider = null,
    presenceUser = null,
    audioGate,
    headerAuth = null,
    rackspaceId = undefined,
    scratchSeeded = undefined,
  }: Props = $props();

  /** THE ONE UI SWITCH. Faceplates in the lane are the DEFAULT and need no
   *  querystring; `?shell=legacy` is the single escape hatch, rendering each
   *  module's verbatim *Card.svelte inside the same shell.
   *
   *  This was `shellPreview`, an opt-in `?shell=1` preview. The preview became
   *  the product, so the flag INVERTED: the default arm is now the new look and
   *  the flag selects the old one. Anything other than exactly `legacy` (including a
   *  stale `?shell=1` bookmark) resolves to faceplates. */
  let shellFaces = $derived(page.url?.searchParams?.get('shell') !== 'legacy');

  /** `?seed=none` — A TEST-ONLY EMPTY RACK. Suppresses the four one-shot
   *  SEEDERS below (the pinned M/E/C + surface singletons, the default
   *  MIXMSTRS→AUDIO OUT wire, the default videoOut, and the video-zone
   *  recorderbox/synesthesia), leaving a genuinely empty graph.
   *
   *  WHY IT EXISTS. Deleting the second shell deleted the only URL that gave an
   *  EMPTY canvas, and ~200 e2e specs are about MODULE behaviour, not about the
   *  shell: they spawn two nodes and assert the graph has two nodes, or
   *  right-click at (200,200) expecting bare pane. Against a rack that seeds
   *  ten nodes and frames its viewport on a video zone at flow-y 4320, every
   *  one of them fails for a reason that has nothing to do with what it tests.
   *  The alternative was rewriting all ~200 to add-and-subtract the seeded
   *  population, which buries the assertion each one actually makes.
   *
   *  ⚠ GATED ON `testHooksEnabled()` — the SAME seam as `__patch` / `__ydoc` /
   *  `__flow`, with the same reachability, stated precisely: ON under local
   *  dev and on the dev + autotest DEPLOYS (which set `VITE_E2E_HOOKS=1`), OFF
   *  on prod. So a prod user cannot reach it whatever they put in the URL, and
   *  on dev.patchtogether.live it is exactly as reachable as the other test
   *  hooks already are. It is a FIXTURE, not a product mode: nothing in the app
   *  links to it and no user-facing behaviour branches on it.
   *
   *  It suppresses SEEDING ONLY. The shell chrome, the lane geometry, the dock
   *  and `shellFaces` are all untouched — a `?seed=none` rack is the same UI,
   *  just without the starter content. */
  let seedShellDefaults = $derived(
    !(testHooksEnabled() && page.url?.searchParams?.get('seed') === 'none'),
  );

  /** The ACTIVE channel-column pitch (flow-space px): the tight 216px RACKLINE
   *  pitch under the `?shell=1` preview, else the app-scale 765px (34hp) band.
   *  Threaded into the RENDER-derived member positions, the drop/drag hit-tests,
   *  the lane overlay bands, and the viewport nav so the narrowed lanes are one
   *  coherent coordinate frame. Preview-OFF resolves to COLUMN_W → every geometry
   *  call is byte-identical. NEVER threaded into a PERSISTED write (drop-spawn x/y,
   *  the videoOut/A-V-defaults spawn, the grow-up push-ups all keep COLUMN_W), so
   *  the persisted graph + collab convergence are untouched — pure render deriv. */
  let wcolPitch = $derived(columnPitch(shellFaces));

  /** The flow-space Y the flush lane/send stacks bottom-anchor to. Under the
   *  `?shell=1` preview the stacks lift SHELL_LANE_BADGE_CLEARANCE_Y above the
   *  baseline so the lane-number badge renders fully visible below the bottom
   *  tile (owner rule); preview-OFF stays COLUMN_BASELINE_Y → every flush call
   *  is byte-identical. Threaded into the render-derived member positions, the
   *  drag-reorder sibling centers, and the in-lane drop-spawn position (which,
   *  like the pitch, persists the RENDERED frame under the preview so the tile
   *  never flashes at the un-lifted slot). */
  let wcolStackAnchorY = $derived(shellFaces ? shellStackAnchorY() : COLUMN_BASELINE_Y);

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
  const nodeTypes = {
    ...buildNodeTypes([
      ...listModuleDefs(),
      ...listVideoModuleDefs(),
      ...listMetaModuleDefs(),
    ]),
    // DOCKING P2.5a: the canvas-side stub a docked module's card swaps to
    // (same node id — cables stay attached). NOT a module def: it never
    // enters the registries, the card-map glob, or the VRT/per-port sweeps
    // (dock-by-default OFF is a hard invariant — nothing docks without a
    // user gesture).
    dockStub: DockStubCard as unknown as ReturnType<typeof buildNodeTypes>[string],
    // P0.3b: the workflow-shell lane node types the legacy-fallback bridge
    // emits under the `?shell=1` preview — the curated skeleton for MIGRATED
    // modules + the uniform placeholder for UN-MIGRATED ones. Like dockStub,
    // NOT module defs (never enter the registries / card-map glob / sweeps).
    moduleShell: ModuleShell as unknown as ReturnType<typeof buildNodeTypes>[string],
    moduleShellPlaceholder: ModuleShellPlaceholder as unknown as ReturnType<typeof buildNodeTypes>[string],
  };

  /** The set of module TYPES that resolve to a real card (the glob-built map,
   *  minus the non-def helpers above). The legacy-fallback bridge only swaps a
   *  type that HAS a card — a defless/special node keeps its current render. */
  const cardTypeSet = new Set(Object.keys(nodeTypes));

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

  /** A module TYPE's rendered card HEIGHT in flow-space px — its rack tier
   *  (`--rack-u` × RACK_UNIT), a per-TYPE constant. Deterministic across peers
   *  (both derive it from the same type), so it drives the collab-safe FLUSH
   *  column stack (columnFlushPositions). Falls back to one rack unit for an
   *  unsized (unmigrated) type. */
  function wcolCardHeightPx(type: string): number {
    // UNIFORM RACKLINE TILE (P0.3b re-spec): under the `?shell=1` preview a
    // shell/placeholder lane node reserves the ONE FIXED slot height
    // (SHELL_TILE_H_SLOT = 180) at EVERY zoom — the LOD tier swaps only the
    // CONTENT inside the box, never the box itself, so flush-stack Y positions
    // are byte-identical across zoom levels (the owner zoom-reposition fix,
    // option (c)). Shared with the tier-invariant _module-card.css height rule
    // (--shell-tile-h) so CSS/TS can't drift, and the RESERVED lane slot equals
    // the RENDERED tile (else the baseline number badge floats mid-card).
    // NON_SHELL_LANE_TYPES (clipplayer / control surfaces / group / sticky) keep
    // their LEGACY card in the lane, so they reserve their NATIVE rack tier, not
    // the shell tile. Preview-OFF keeps the per-TYPE rack tier for every type →
    // byte-identical.
    if (shellFaces && !NON_SHELL_LANE_TYPES.has(type)) return SHELL_TILE_H_SLOT;
    const size = rackSizeByType[type]?.size;
    const u = size ? parseInt(size, 10) || 1 : 1;
    return u * RACK_UNIT;
  }

  /** A module TYPE's rendered card WIDTH in flow-space px. Under the `?shell=1`
   *  preview a shell/placeholder tile is the UNIFORM SHELL_TILE_W (every module the
   *  SAME width — the owner "same-size horizontally" premise), so the reserved
   *  column slot == the rendered tile and band-CENTERING (card center == channel-
   *  number center) stays exact. NON_SHELL_LANE_TYPES keep their legacy card's
   *  NATIVE hp width. Preview-OFF (and every type there) uses the per-TYPE hp tier
   *  (`--rack-hp` × RACK_UNIT, the same math _module-card.css applies) → byte-
   *  identical. Falls back to one tile. */
  function wcolCardWidthPx(type: string): number {
    if (shellFaces && !NON_SHELL_LANE_TYPES.has(type)) return SHELL_TILE_W;
    return (rackSizeByType[type]?.hp ?? 1) * RACK_UNIT;
  }

  let audioCtx: AudioContext | null = $state(null);
  let engine: PatchEngine | null = $state(null);
  let reconciler: { reconcile: () => Promise<void>; dispose: () => void } | null = $state(null);
  let error = $state<string | null>(null);
  /** Non-blocking summary of the last load's diagnostics (null = clean). */
  let loadNotice = $state<string | null>(null);
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

  // The simulated Launchpad the OUT TO LAUNCH e2e installs (#1728), kept at
  // component scope so both dev hooks below can reach it. Plain `let`, not
  // `$state`: nothing renders from it and the hooks read it at call time.
  let simulatedMonitorDevice: SimulatedLaunchpadMonitorDevice | null = null;

  // Dev-only (gated on testHooksEnabled): expose patch + ydoc on window so
  // e2e tests + chaos musician-bots can drive arbitrary module-spawning
  // combinations without a UI palette. Stripped in prod builds (autotest
  // sets VITE_E2E_HOOKS=1 to re-enable).
  //
  // `onMount`, NOT `$effect` — this is mount-only work. Nothing in the body
  // is read reactively: `patch` / `ydoc` are plain module-scope `let` exports
  // of `$lib/graph/store` (a `.ts` file, so it has no runes), `connectDragState`
  // is an `export const` class instance, and every component `$state` this
  // publishes (`engine`, `flowApi`, `spawnFlowPos`, `slotOccupied`, …) is read
  // or written INSIDE a closure this body installs, at call time — never here.
  // So the effect had no dependencies and could only ever run once. It also has
  // no cleanup: the globals deliberately outlive the component, which `$effect`
  // (whose contract is "re-run and tear down") actively misdescribes.
  // ⚠ The invariant that makes this safe — expose a GETTER (`() => engine`),
  // never the reactive value itself — is enforced by
  // `scripts/canvas-mount-only-hooks.test.ts`. A bare reactive read added at
  // this body's top level would latch a stale value instead of re-installing.
  if (testHooksEnabled()) {
    onMount(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__patch = patch;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__ydoc = ydoc;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__engine = () => engine;
      // ES-9 bridge OWNERSHIP probe. The whole point of moving the connection
      // off the card is that it survives a card unmount, and that is invisible
      // from the DOM — an e2e can see the card disappear but not whether the
      // stream died with it. This exposes the one bit that matters.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__es9HasBridge = (nodeId: string) => hasEs9Bridge(nodeId);
      // Tests bootstrap the engine directly rather than through a UI action
      // that also writes nodes — an auto-playing Sequencer would race
      // bind:nodes during the immediate clear-then-add transact spawnPatch does.
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
      // Workflow channel-columns e2e: set the flow-space spawn anchor so the
      // NEXT __spawnFromPalette lands inside a specific column / send band
      // (exercises the REAL wcolDropTarget → membership + order + reconcile
      // path, not just a raw graph write).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__setSpawnFlowPos = (p: { x: number; y: number }) => {
        spawnFlowPos = { x: p.x, y: p.y };
      };
      // Workflow channel-columns e2e: drive the SvelteFlow drag-stop seam
      // directly (the same {targetNode, nodes} payload onnodedragstop passes)
      // so a test can DROP a card into a column band without synthesizing a
      // pixel-perfect pointer drag.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__handleNodeDragStop = (payload: { targetNode: FlowNode | null; nodes: FlowNode[] }) =>
        handleNodeDragStop(payload);
      // Workflow channel-columns e2e: drive the REAL right-click "Assign to
      // channel N" commit for a node without synthesizing the context-menu
      // pointer sequence (which is flaky for a card that moves into a column
      // mid-gesture). Sets the menu target + runs the exact handler the menu
      // fires — so the bug-3 splice/no-double behaviour is tested on the real
      // path. `channel` is 0-based (lane N), matching the menu callback.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__assignNodeToChannel = (nodeId: string, channel: number) => {
        ctxMenuNodeId = nodeId;
        commitAssignToChannel(channel);
      };
      // Dock full-view e2e: open a node's TRANSIENT dock full-view faceplate
      // directly — the same dockStore.openFullView call the shell tiles'
      // EXPAND buttons make. Needed because a NON_SHELL legacy lane card
      // (videoOut) has no tile/EXPAND affordance, yet the dock path for it
      // must still render live video (the owner dock regression).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__openDockFullView = (nodeId: string) => dockStore.openFullView(nodeId);
      // #1574: observe the NODE-owned recording from a spec. The whole point of
      // the registry is that this survives the card being unmounted, so the
      // probe must NOT read the card — it reads the node's own record.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__nodeRecording = (nodeId: string) => ({
        recording: nodeRecorder.isRecording(nodeId),
        ...(nodeRecorder.view(nodeId) ?? {}),
      });
      // #1588: the same probe for the NODE-owned SAMSLOOP take. `frames` (and
      // the `elapsed` derived from it) is the CAUSAL quantity — it moves only
      // when the tap posts and the accumulator appends. `wallElapsed` is the
      // wall clock and is deliberately reported alongside it, because a wall
      // clock advances whether or not a single sample arrived: asserting on it
      // would be a gate blind to exactly the defect this exists for. The shape
      // is built by the registry so the spec and the registry cannot drift.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__samsloopRecording = (nodeId: string) => nodeSamsloop.probe(nodeId);
      // #1590: the same probe for the NODE-owned live AUDIO INPUT. It reports
      // `trackLive` — the actual `MediaStreamTrack.readyState` — and not just
      // the registry's own opinion, because the defect was an IRREVERSIBLE
      // `t.stop()`: a probe that only echoed registry state could stay happy
      // while the device was already permanently `ended`.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__nodeAudioInput = (nodeId: string) => nodeAudioInput.probe(nodeId);
      // #1590: the NODE-owned DOOM session probe. `pumpRuns` is the CAUSAL
      // quantity (units: session-pump invocations, one per frame) — the exact
      // mechanism whose death starved every peer's lockstep barrier when the
      // card unmounted — and the probe folds in LIVE engine readings
      // (gametic/gamestate/PTNet bound) via the session wiring, so it is not
      // limited to the registry's opinion of itself. Reads the NODE's record,
      // never a card's: the card is the thing under test for being absent.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__nodeDoomSession = (nodeId: string) => nodeDoomSession.probe(nodeId);
      // #1728: the NODE-owned LAUNCHPAD MONITOR (OUT TO LAUNCH). Two halves,
      // and they are deliberately read from DIFFERENT places:
      //   * the CLAIM — `bound` / `outputId` come from the DEVICE layer's
      //     `monitors` map, which is the thing `unbindMonitor` deletes. Reading
      //     it off the registry would be the registry's opinion of a claim it
      //     does not itself hold.
      //   * the SURFACE — `device` reports what the simulated Launchpad
      //     BELIEVES (its decoded LED state + programmer/Live mode). The
      //     user-visible symptom is a dark device handed back to Live, and no
      //     host-side field can see that.
      // `framesPushed` is the registry's pump counter and is reported only
      // alongside `device.framesReceived`, the device-side count of frames that
      // actually landed.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__nodeLaunchpadMonitor = (nodeId: string) => {
        const reg = nodeLaunchpadMonitor.probe(nodeId);
        return {
          // THE CLAIM — device layer.
          bound: isMonitorBound(nodeId),
          outputId: monitorOutputId(nodeId),
          // THE PUMP — the registry's own counters. Never sufficient alone.
          hasEntry: reg.hasEntry,
          pumping: reg.pumping,
          framesPushed: reg.framesPushed,
          // THE SURFACE — the device's own decoded state.
          device: simulatedMonitorDevice
            ? {
                programmer: simulatedMonitorDevice.programmer(),
                // ROWS, not a count — a caller asserts PROPERTIES of the lit set
                // (empty / non-empty / which indices moved), never its size.
                litIndices: simulatedMonitorDevice.litIndices(),
                framesReceived: simulatedMonitorDevice.framesReceived(),
                ledAt11: simulatedMonitorDevice.ledAt(11),
                ledAt99: simulatedMonitorDevice.ledAt(99),
              }
            : null,
        };
      };
      // Installs an in-memory Launchpad that NO clip-launcher unit claims, so an
      // OUT TO LAUNCH monitor can bind it (the L/R sims above bind their ports
      // to units, which `isOutputClaimed` then refuses a monitor on, by design).
      // Returns the free output port id. DEV-only.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__launchpadMonitorTestInstall = async () => {
        const dev = await installSimulatedLaunchpadMonitorDevice();
        simulatedMonitorDevice = dev;
        return dev.outputId;
      };
      // #1589: observe the NODE-owned media entries from a spec. Same reasoning
      // as __nodeRecording — the point of the registry is that these outlive the
      // card, so the probe must read the NODE's record and never a card's state.
      // Rows only (no count anywhere): a caller asserts PROPERTIES of them.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__nodeMedia = (nodeId: string) =>
        nodeMedia.snapshot().filter((s) => s.nodeId === nodeId);
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
      // DOCKING P2.5a — programmatic dock/undock + store observability for
      // the workflow-dock e2e (the UI path is the node context menu; the
      // hook drives the same functions for setup-heavy specs like the
      // tombstone-revive round-trip). Stripped in prod.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__dock = {
        dock: (nodeId: string, zone: DockZone) => dockNode(nodeId, zone),
        undock: (nodeId: string) => undockNode(nodeId),
        entryFor: (nodeId: string) => dockStore.entryFor(nodeId),
        tombstoneCount: () => dockStore.tombstoneCount,
      };
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
        // Inverse of screenToFlowPosition — used by the workflow viewport-nav
        // e2e to project a flow-space point (a column band center, the video
        // zone corner) to on-screen px and assert where the pan framed it.
        flowToScreenPosition: (p: { x: number; y: number }) =>
          flowApi?.flowToScreenPosition(p) ?? p,
        getViewport: () => flowApi?.getViewport?.() ?? { x: 0, y: 0, zoom: 1 },
        // Set the viewport pan/zoom. Mirrors the flowApi seam the workflow
        // keyboard-nav uses; e2e helpers call it to bring a directly-injected
        // (spawnPatch) card into view when the default workflow viewport frames
        // the far-down lanes/video-zone instead of the flow origin.
        setViewport: (vp: { x: number; y: number; zoom: number }, opts?: { duration?: number }) =>
          flowApi?.setViewport?.(vp, opts),
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
  // empty until the user spawns something — auto-spawning there would
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

  // ── Persisted-rack VIDEO boot (fix/video-engine-persist-reconcile) ─────────
  //
  // Video renders with NO user gesture (unlike audio, which the browser
  // autoplay policy legitimately gates behind a click). But the PatchEngine —
  // and with it the VideoEngine's rAF render loop — is created lazily by
  // ensureEngine(), which today runs ONLY from user graph-mutations (spawn /
  // duplicate / load / import) and the audio-gate click. So a rack RESTORED from
  // persistence (the /rack scratch IndexedDB replica, or the /r/[id] Y.Doc sync)
  // shows its video CARDS but renders nothing: nothing booted the engine, so the
  // restored video nodes are never instantiated and the render loop never
  // starts. Video stays black/frozen until the user happens to add or delete a
  // node, whose ensureEngine() call finally boots + reconciles the whole (already
  // seeded) graph — reviving ALL restored video at once (the owner's symptoms).
  //
  // Fix: once the persisted graph has LOADED (scratch seed resolved, or the
  // collab provider synced) and it holds ≥1 video node, boot the engine here.
  // The SAME bus-driven reconciler the add/delete paths use then instantiates
  // the restored nodes and the loop starts — no gesture required.
  //
  // Idempotent + leak-free: ensureEngine() memoizes the engine+reconciler and
  // the reconciler diffs the snapshot against what it already applied, so a live
  // node is never rebuilt or torn down. Reading `engine` keeps this reactive —
  // it re-runs and early-returns once the boot completes (a failed boot leaves
  // `engine` null, so a later snapshot change retries). Scoped to video-bearing
  // RESTORED racks: an audio-only / empty rack keeps the lazy boot (no eager
  // AudioContext per page view — audio still waits for the gesture it needs),
  // and the ephemeral e2e /rack (replica opt-out, no provider) never trips it.
  $effect(() => {
    // Load-complete signal for the RESTORE path only — never the interactive
    // spawn path, which boots the engine itself. `scratchSeeded` is a boolean on
    // the persisted scratch canvas and undefined elsewhere; providerHasSynced
    // covers the collab /r/[id] first sync.
    const loaded = scratchSeeded === true || (provider != null && providerHasSynced);
    if (
      !shouldBootEngineForRestoredVideo({
        loaded,
        engineBooted: engine != null,
        nodes: snapshot.nodes,
      })
    ) {
      return;
    }
    void (async () => {
      // ⚠ RE-CHECK AT CALL TIME (#1623). The `engineBooted` guard above is
      // evaluated when the EFFECT fires; this async body runs later. In that
      // window something else can boot the engine (a user spawn, a test's
      // bootWithFace) — and `ensureEngine()` RESUMES a suspended AudioContext
      // on every call, so the stale queued boot then un-suspends a context
      // its owner deliberately froze. Measured: vrt-strict's face capture
      // (which suspends, then re-freezes SIX times) still caught a resume
      // landing after its last retry — this queued call, surfaced by the
      // 4-way shard co-schedule. For a user this TOCTOU is just redundant
      // work; for any deliberately-suspended graph it is a state change
      // nobody asked for. Same idempotence rule as the guard, applied at the
      // moment that matters.
      if (engine != null) return;
      await ensureEngine();
      // Explicit reconcile (mirrors handleDelete's shape) so the
      // restored graph is materialized deterministically on this load — the
      // reconciler also auto-runs on attach via the snapshot bus, so this is a
      // belt-and-suspenders no-op if the bus already fired.
      await reconciler?.reconcile();
    })();
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
    // WORKFLOW MODE P2: workflow racks get their always-on TIMELORDE from
    // the pinned ensure below (deterministic `pinned-timelorde`, canvas-
    // hidden — the topbar clock surface is its face). Racing this random-id
    // canvas auto-spawn against that ensure on an empty rack would seed TWO
    // clocks, so this canvas auto-spawn stands down entirely.
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

  // ---------------- WORKFLOW MODE P1: pinned M/E/C trio + dock drawer ----------------
  // ---------------- WORKFLOW MODE P2: + the topbar surface pins ----------------
  //
  // ENSURE: every workflow rack always holds one pinned MIXMSTRS, one
  // ELECTRA CONTROL and one CLIPPLAYER (graph/workflow-pins.ts) — plus,
  // since P2, the always-on topbar surface modules (TIMELORDE / the hidden
  // MIDICLOCK bridge / AUDIO IN / AUDIO OUT — WORKFLOW_PINNED_SURFACES;
  // TIMELORDE is presence-by-TYPE so an imported patch's canvas clock
  // satisfies it instead of gaining a hidden competitor). Runs on
  // every snapshot (no latch) so the set SELF-HEALS after any wholesale
  // node replacement (quickload / performance load / raw-JSON import all
  // wipe patch.nodes); planPinnedSpawns returns [] once present, so the
  // effect terminates. DETERMINISTIC ids (`pinned-<type>`) make racing
  // clients converge on ONE Y.Map entry per type — no duplicate race, no
  // cleanup dependency. Gate mirrors the TIMELORDE auto-spawn: with a
  // provider, wait for first sync (never race server state); without one
  // (the /rack scratch sandbox) spawn immediately.
  //
  // ⚠ THIS IS WHY `/rack` IS NO LONGER AN EMPTY CANVAS. Every rack is a shell
  // rack now, so every rack gets the pinned set (and the video-zone defaults
  // below). Specs that asserted a literally-empty `/rack` were asserting a
  // property of the deleted second shell; they count the seeded set instead.
  // Non-tracked origin → never on the undo stack.
  $effect(() => {
    // Wait for first sync WITH a provider (never race server state); WITHOUT a
    // provider on the scratch canvas, wait for the local replica seed instead
    // (scratchSeeded === false) so the ensure runs against the SEEDED doc and
    // its `if (patch.nodes[spec.id]) continue` skips restored pins — no clobber
    // race. scratchSeeded is undefined for real racks → guard unchanged.
    if ((provider && !providerHasSynced) || scratchSeeded === false) return;
    if (!seedShellDefaults) return; // ?seed=none — the empty-rack test fixture
    const missing = planPinnedSpawns(snapshot.nodes);
    if (missing.length === 0) return;
    ydoc.transact(() => {
      for (const spec of missing) {
        if (patch.nodes[spec.id]) continue; // in-transact re-check
        patch.nodes[spec.id] = {
          id: spec.id,
          type: spec.type,
          domain: spec.domain,
          // Position is inert while drawer-only (flowNodes skips pinned);
          // kept sane in case the Q3 default is reversed to on-canvas.
          position: { x: 24, y: 24 },
          params: {},
          data: { pinned: true, name: nextDefaultName(patch.nodes, spec.type) },
        };
      }
    }, WORKFLOW_PIN_SPAWN_ORIGIN);
    trace(`workflow: ensured pinned modules (${missing.map((s) => s.type).join(', ')})`);
  });

  // DEFAULT WIRING (owner directive): pinned MIXMSTRS master L/R → pinned
  // AUDIO OUT L/R, so a fresh workflow rack makes sound the moment anything
  // feeds the mixer. ONE-SHOT SEED, not an invariant: planDefaultWires only
  // plans while the `workflowDefaultWired` latch on the pinned AUDIO OUT is
  // unset, and the latch is written IN THE SAME TRANSACT as the wires — so a
  // user deleting the cable afterwards is respected forever (the ensure never
  // fights intent). Deterministic edge ids (the handleConnect `e-…` template)
  // make two racing clients converge on one Y.Map entry per wire; occupied
  // target inputs are skipped (a user's own patch into AUDIO OUT is never
  // replaced). Runs after the node ensure above lands both endpoints; a
  // wholesale node replacement re-seeds only when the loaded doc lacks the
  // latch (fresh pins), mirroring the node ensure's self-healing story.
  // Same non-tracked origin → never on the undo stack.
  $effect(() => {
    // Same seed gate as the pinned-module ensure above: defer on a pending
    // scratch replica seed so the default-wire seed can't resurrect a cable the
    // user deleted before their stored latch is restored. Undefined (real
    // racks) → guard unchanged.
    if ((provider && !providerHasSynced) || scratchSeeded === false) return;
    if (!seedShellDefaults) return; // ?seed=none — the empty-rack test fixture
    const plan = planDefaultWires(snapshot.nodes, snapshot.edges);
    if (!plan.latch) return;
    ydoc.transact(() => {
      const dst = patch.nodes['pinned-audioOut'];
      if (!dst) return; // raced a wholesale wipe — replan on the next snapshot
      const data = (dst.data ?? {}) as Record<string, unknown>;
      if (data[WORKFLOW_DEFAULT_WIRE_LATCH] === true) return; // in-transact re-check
      for (const wire of plan.wires) {
        if (patch.edges[wire.id]) continue;
        const occupied = Object.values(patch.edges).some(
          (e) => e && e.target.nodeId === wire.target.nodeId && e.target.portId === wire.target.portId,
        );
        if (occupied) continue;
        patch.edges[wire.id] = {
          id: wire.id,
          source: { nodeId: wire.source.nodeId, portId: wire.source.portId },
          target: { nodeId: wire.target.nodeId, portId: wire.target.portId },
          sourceType: wire.sourceType,
          targetType: wire.targetType,
        };
      }
      if (!dst.data) dst.data = {};
      dst.data[WORKFLOW_DEFAULT_WIRE_LATCH] = true;
    }, WORKFLOW_PIN_SPAWN_ORIGIN);
    trace('workflow: seeded default wires mixmstrs master L/R → audioOut (one-shot)');
  });

  // DEFAULT VIDEO SINK (owner directive): a fresh workflow rack auto-spawns ONE
  // videoOut inside the PURPLE video zone below the lanes — the video-domain
  // analog of the pinned mixer's audio-out. ONE-SHOT SEED (a latch on the pinned
  // mixer), not an invariant: once seeded a user deleting it is respected. The
  // node is a NORMAL canvas card (NOT data.pinned) so it renders in the zone;
  // the deterministic id converges racing clients on one Y.Map entry. Same seed
  // gate + non-tracked origin as the pinned ensure.
  $effect(() => {
    if ((provider && !providerHasSynced) || scratchSeeded === false) return;
    if (!seedShellDefaults) return; // ?seed=none — the empty-rack test fixture
    const mixer = patch.nodes[WCOL_MIXER_ID];
    if (!mixer) return; // wait for the pinned mixer (the latch home) to land
    const seeded = (mixer.data as { workflowVideoOutSeeded?: boolean } | undefined)?.workflowVideoOutSeeded === true;
    if (seeded) return; // one-shot done — respect a user delete forever
    if (!needsDefaultVideoOut(snapshot.nodes)) {
      // A videoOut already exists (loaded rack) — just set the latch so we never
      // add a second, without spawning.
      ydoc.transact(() => {
        const m = patch.nodes[WCOL_MIXER_ID];
        if (m) { if (!m.data) m.data = {}; (m.data as Record<string, unknown>).workflowVideoOutSeeded = true; }
      }, WORKFLOW_PIN_SPAWN_ORIGIN);
      return;
    }
    const pos = videoOutSpawnPos();
    ydoc.transact(() => {
      if (patch.nodes[DEFAULT_VIDEO_OUT_ID]) return; // in-transact re-check
      patch.nodes[DEFAULT_VIDEO_OUT_ID] = {
        id: DEFAULT_VIDEO_OUT_ID,
        type: 'videoOut',
        domain: 'video',
        position: { x: pos.x, y: pos.y },
        params: {},
        data: { name: nextDefaultName(patch.nodes, 'videoOut') },
      };
      const m = patch.nodes[WCOL_MIXER_ID];
      if (m) { if (!m.data) m.data = {}; (m.data as Record<string, unknown>).workflowVideoOutSeeded = true; }
    }, WORKFLOW_PIN_SPAWN_ORIGIN);
    trace('workflow: spawned default videoOut sink in the video zone (one-shot)');
  });

  // DEFAULT VIDEO-ZONE A/V DEFAULTS (owner directive): a fresh workflow rack
  // ALSO auto-spawns a RECORDERBOX (records the master video + master audio) and
  // a SYNESTHESIA (renders audio-reactive visuals from the master mix) beside the
  // default videoOut, and auto-WIRES both to the master buses. Same one-shot
  // mechanism as the videoOut seed above: each module carries its OWN latch on
  // the pinned mixer (spec.seededFlag) so once seeded a user delete is respected
  // forever; the wires are seeded in the SAME transact (deterministic edge ids,
  // occupied targets skipped) so a user deleting a module OR a cable is never
  // re-fought. Gated on the pinned mixer (the wire source + latch home); the
  // recorderbox spec additionally waits on a videoOut existing so its master-
  // video tap lands. Same seed gate + non-tracked origin as the pins.
  $effect(() => {
    if ((provider && !providerHasSynced) || scratchSeeded === false) return;
    if (!seedShellDefaults) return; // ?seed=none — the empty-rack test fixture
    const mixer = patch.nodes[WCOL_MIXER_ID];
    if (!mixer) return; // wait for the pinned mixer (the latch home + wire source)
    for (const spec of VIDEO_ZONE_EXTRA_DEFAULTS) {
      const seeded =
        (mixer.data as Record<string, unknown> | undefined)?.[spec.seededFlag] === true;
      if (seeded) continue; // one-shot done — respect a user delete forever
      if (!rackLacksType(snapshot.nodes, spec.type)) {
        // An instance already exists (loaded rack) — set the latch so we never
        // add a second, without spawning or wiring (respect the existing patch).
        ydoc.transact(() => {
          const m = patch.nodes[WCOL_MIXER_ID];
          if (m) { if (!m.data) m.data = {}; (m.data as Record<string, unknown>)[spec.seededFlag] = true; }
        }, WORKFLOW_PIN_SPAWN_ORIGIN);
        continue;
      }
      const videoOutId = resolveMasterVideoOutId(snapshot.nodes);
      // recorderbox taps the master videoOut's pass-through for the master video
      // — defer its seed until a videoOut exists so the video wire lands too.
      if (spec.requiresVideoOut && !videoOutId) continue;
      const wires = videoZoneWiresFor(spec.type as 'recorderbox' | 'synesthesia', videoOutId);
      const occupied = new Set<string>();
      for (const e of snapshot.edges) occupied.add(`${e.target.nodeId}:${e.target.portId}`);
      ydoc.transact(() => {
        if (patch.nodes[spec.id]) return; // in-transact re-check
        patch.nodes[spec.id] = {
          id: spec.id,
          type: spec.type,
          domain: spec.domain,
          position: { x: spec.pos.x, y: spec.pos.y },
          params: {},
          data: { name: nextDefaultName(patch.nodes, spec.type) },
        };
        for (const wire of wires) {
          if (patch.edges[wire.id]) continue;
          const busy = Object.values(patch.edges).some(
            (e) => e && e.target.nodeId === wire.target.nodeId && e.target.portId === wire.target.portId,
          );
          if (busy || occupied.has(`${wire.target.nodeId}:${wire.target.portId}`)) continue;
          patch.edges[wire.id] = {
            id: wire.id,
            source: { nodeId: wire.source.nodeId, portId: wire.source.portId },
            target: { nodeId: wire.target.nodeId, portId: wire.target.portId },
            sourceType: wire.sourceType,
            targetType: wire.targetType,
          };
        }
        const m = patch.nodes[WCOL_MIXER_ID];
        if (m) { if (!m.data) m.data = {}; (m.data as Record<string, unknown>)[spec.seededFlag] = true; }
      }, WORKFLOW_PIN_SPAWN_ORIGIN);
      trace(`workflow: spawned + wired default ${spec.type} in the video zone (one-shot)`);
    }
  });

  // DOCK KEYMAP: M / E / C toggle their pinned singleton's bottom-dock
  // surface — WHICH surface is declared per spec (workflow-pins.ts
  // `PinnedSurface`):
  //   * M / E ('drawer')   → the pinned M/E drawer (one card per zone, so
  //     opening the other replaces it);
  //   * C     ('fullView') → the built-in CLIP PLAYER as a dock FULL-VIEW
  //     PANE, exactly like a module's EXPAND pill (owner 2026-07-26) — so it
  //     sits SIDE-BY-SIDE 50/50 with a module instead of being mutually
  //     exclusive with it.
  // ESC closes whichever occupant is open. Workflow-only; inert while typing
  // (input/textarea/select/contenteditable — isTypingTarget) and under any
  // modifier. Plain listener (not capture) so capture-phase ESC consumers
  // (pickup-cancel, lasso, the File.. menu) win first.
  $effect(() => {
    function onDockKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      if (e.key === 'Escape') {
        // ONE bottom occupant (dock unification): pinned XOR full-view — ESC
        // closes whichever is open. The full-view closes AS A WHOLE (both
        // split panes at once — the chosen ESC semantics; per-pane close is
        // the faceplate's own ✕). (The order below is belt-and-braces; the
        // store invariant means at most one branch can ever be live.)
        if (dockStore.fullViewNodeIds.length > 0) {
          e.preventDefault();
          dockStore.closeFullView();
        } else if (dockStore.dockedNodeId('bottom')) {
          e.preventDefault();
          dockStore.close('bottom');
        }
        return;
      }
      if (isRackFlipKey(e)) {
        // FLIP SEAM (rear card): the bare flip key (Tab, see workflow-pins.ts
        // `isRackFlipKey`) flips the OPEN full-view to its rear/patch face —
        // both panes together (global flip). Only claim it while the
        // full-view is open; with it closed the canvas-wide `isFlip` below
        // owns the same key (SINGLE-OWNER, by occupancy).
        //
        // Tab-as-flip is an OWNER RULING (#1629): the flip gesture outranks
        // native focus traversal in this app (the #1508→#1599 rebind to `f`
        // was reversed). Shift-Tab and Tab inside typing targets stay native.
        if (dockStore.fullViewNodeIds.length > 0) {
          e.preventDefault();
          dockStore.toggleFullViewFlipped();
        }
        return;
      }
      const spec = DRAWER_KEY_TO_PINNED.get(e.key.toLowerCase());
      if (!spec) return;
      // Only toggle once the pinned node exists (the ensure above lands it
      // within the same tick on an empty rack; pre-sync there's nothing to
      // show yet).
      if (!patch.nodes[spec.id]) return;
      e.preventDefault();
      if (spec.surface === 'fullView') {
        // C = EXPAND (owner 2026-07-26, superseding the one-drawer-occupancy
        // rule for the clip player): the built-in CLIP PLAYER opens as a dock
        // FULL-VIEW PANE, identical to a module's EXPAND pill — so it can sit
        // SIDE-BY-SIDE 50/50 with a module instead of replacing it. It is a
        // REAL node (`pinned-clipplayer`), so it rides the SAME
        // fullViewNodeIds machinery: same faceplate + per-pane ✕, LRU
        // third-expand replacement, the flip key (Tab) flips it with its sibling. Toggling is
        // idempotent-by-construction (openFullView de-dupes), so two presses
        // can never stack two clip-player panes.
        dockStore.toggleFullView(spec.id);
        return;
      }
      // M/E (surface 'drawer'): toggle() owns the occupancy handoff — while
      // the full-view is open it closes and the requested pinned drawer OPENS
      // (replace, not stack).
      dockStore.toggle('bottom', spec.id);
    }
    window.addEventListener('keydown', onDockKey);
    return () => window.removeEventListener('keydown', onDockKey);
  });

  // The workflow viewport-pan animation duration (ms) — shared by the nav keys,
  // the on-add camera reveal, and the on-load lane framing.
  const WCOL_PAN_MS = 220;

  /** Read the LIVE workflow viewport metrics: the flow pane's SCREEN-space
   *  width/height (getBoundingClientRect) + the current zoom (kept fixed by the
   *  pan helpers). Null until the pane is laid out. Shared by every pan seam. */
  function readWorkflowViewportMetrics(): ViewportMetrics | null {
    if (!flowApi || !flowEl) return null;
    const rect = flowEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const vp = flowApi.getViewport?.();
    const zoom = vp?.zoom && vp.zoom > 0 ? vp.zoom : 1;
    return { widthPx: rect.width, heightPx: rect.height, zoom };
  }

  // WORKFLOW MODE — VIEWPORT NAVIGATION keys. Keeps the CURRENT zoom; only pans.
  //  * '1'..'8' → center that channel column horizontally in the viewport with
  //    its BASELINE (where the number sits) at the viewport BOTTOM. Numbers
  //    beyond the active column count (COLUMN_COUNT) are ignored.
  //  * 'v'/'V'  → snap the video zone's LOWER-LEFT corner to the viewport's
  //    LOWER-LEFT corner.
  // Inert while typing (isTypingTarget: input/textarea/select/contenteditable —
  // so a card control's number entry is never hijacked) and under any modifier.
  // The pure translate math lives in channel-columns (laneCenterViewport /
  // videoAreaViewport); here we read the live SCREEN-space pane size + current
  // zoom and hand the transform to xyflow's animated setViewport.
  $effect(() => {
    function onNavKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      // ── NO LANES ⇒ NO NAV. ────────────────────────────────────────────────
      // The pinned mixer owns the channel-column manifest, so without it there
      // are no lanes to centre on and `laneCenterViewport` would teleport the
      // camera into empty space by pure geometry. This used to be spelled
      // `if (!workflowMode) return` — dawless had no mixer — and has to be said
      // against the ARTIFACT now that every rack is a shell rack.
      if (!patch.nodes[WCOL_MIXER_ID]) return;
      // ── A CARD THAT OWNS THE KEYBOARD WINS. ───────────────────────────────
      // `isTypingTarget` only catches input/textarea/select/contenteditable. A
      // module card can own the keyboard WITHOUT any of those: the clip player
      // arms its 1–8 clip keys on FOCUS-WITHIN (you click into the card), and
      // its own spec asserts those digits are inert until you do. This listener
      // is on `window`, so before the shell became the only rack it simply did
      // not exist on the rack that spec ran against — now it fires on the same
      // keystroke and pans the camera to lane 5 while the card handles the 5.
      // Two features, one keystroke; the focused card is the one the user is
      // looking at, so it wins.
      const active = document.activeElement;
      if (active instanceof Element && active.closest('.svelte-flow__node')) return;
      const k = e.key;
      if (k === 'v' || k === 'V') {
        const vp = readWorkflowViewportMetrics();
        if (!vp || !flowApi) return;
        e.preventDefault();
        flowApi.setViewport(videoAreaViewport(vp, wcolPitch), { duration: WCOL_PAN_MS });
        return;
      }
      // '1'..'8' → center that lane (guard against '0'/'9'+ and > column count).
      if (k >= '1' && k <= '9') {
        const ch = k.charCodeAt(0) - 48;
        if (ch < 1 || ch > COLUMN_COUNT) return; // ignore > active column count
        const vp = readWorkflowViewportMetrics();
        if (!vp || !flowApi) return;
        e.preventDefault();
        flowApi.setViewport(laneCenterViewport(ch, vp, wcolPitch), { duration: WCOL_PAN_MS });
      }
    }
    window.addEventListener('keydown', onNavKey);
    return () => window.removeEventListener('keydown', onNavKey);
  });

  // WORKFLOW ON-LOAD LANE FRAMING (P0.3b camera fix, SECONDARY). A bare
  // <SvelteFlow fitView> frames only the xyflow-VISIBLE nodes; on a fresh
  // workflow rack the channel singletons are canvas-hidden, leaving just the
  // bottom VIDEO-ZONE trio — so fitView anchors the camera on the video strip and
  // the channel lanes sit ABOVE the viewport. Once the pane + flowApi are ready
  // (and the initial fitView has set the zoom), re-frame ONCE onto the lane band
  // (fitLanesViewport: band centered, baseline at viewport bottom) so the camera
  // lands on the work surface.
  //
  // GATED TO THE `?shell=1` PREVIEW (not all workflow mode): the on-load camera
  // is a STATIC view change, and the preview-off workflow VRT
  // (workflow-dock-composite) captures the canvas — so gating here keeps
  // preview-off byte-identical (the interaction-time add-pan below is unaffected;
  // it never changes the at-rest view a VRT captures). One-shot (a latch).
  let didFrameLanesOnLoad = false;
  $effect(() => {
    if (!shellFaces || didFrameLanesOnLoad) return;
    if (!flowApi || !flowEl) return; // not mounted yet — re-runs when they bind
    // rAF-poll (bounded) until SvelteFlow's on-init fitView has produced a real
    // viewport, then re-frame ONCE onto the lane band (inheriting the fitted
    // zoom). The poll avoids a race where flowApi binds a frame before fitView.
    let raf = 0;
    let tries = 0;
    const tick = () => {
      raf = 0;
      if (didFrameLanesOnLoad) return;
      const raw = flowApi?.getViewport?.();
      const vp = readWorkflowViewportMetrics();
      if (flowApi && vp && raw && raw.zoom > 0) {
        didFrameLanesOnLoad = true;
        flowApi.setViewport(fitLanesViewport(vp, wcolPitch), { duration: 0 });
        return;
      }
      if (++tries < 30) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      if (raf) cancelAnimationFrame(raf);
    };
  });

  // Dock hygiene + P2.5a persistence binding: each Canvas mount binds the
  // dock store to THIS rackspace's localStorage scope (loading its docked
  // entries + tombstones) and clears the transient pinned-drawer occupancy;
  // unmount unbinds (rackspace navigation remounts Canvas via
  // {#key rackspace.id}, so state never leaks across racks).
  $effect(() => {
    dockStore.bind(rackspaceId ?? 'scratch');
    return () => dockStore.unbind();
  });

  // WORKFLOW MODE P3 — asset-link hygiene. Same per-rackspace discipline
  // as the dock store: the local assetId↔nodeId map never leaks across
  // canvas mounts (asset ids are per-tab; nodeIds are per-rackspace).
  $effect(() => {
    assetLinks.clear();
    return () => assetLinks.clear();
  });

  // WORKFLOW MODE P3 — link prune + descriptor REBIND sweep. Re-runs when
  // the node set or the media library changes:
  //  * prune: links whose module was deleted by ANY path (Backspace,
  //    Clear, remote peer) drop, so picker rows un-highlight.
  //  * rebind: nodes carrying data.mediaDesc that match a loaded library
  //    item (dupe-key) re-link — and re-drive the module's own load path
  //    when its media is missing (asset-spawn.ts runAssetRebindSweep).
  // The sweep itself runs UNTRACKED (it reads + writes assetLinks; the
  // explicit deps above are the re-run triggers), and it's internally
  // reentrancy-guarded + idempotent.
  $effect(() => {
    const liveIds = new Set(snapshot.nodes.map((n) => n.id));
    void mediaLibrary.items.length; // track add/remove
    untrack(() => {
      assetLinks.pruneMissing(liveIds);
      void runAssetRebindSweep({
        currentUserId: currentUserId ?? null,
        ensureEngine,
      });
    });
  });

  // The docked pinned node (bottom zone), resolved from the snapshot; the
  // container only renders while it exists.
  let dockedBottomNode = $derived.by(() => {
    const id = dockStore.dockedNodeId('bottom');
    if (!id) return null;
    return snapshot.nodes.find((n) => n.id === id && isPinnedNode(n)) ?? null;
  });
  let dockedBottomSpec = $derived(
    dockedBottomNode
      ? WORKFLOW_PINNED_MODULES.find((s) => s.type === dockedBottomNode!.type) ?? null
      : null,
  );

  // ---------------- DOCKING P2.5a: dock/undock + rails + GC ----------------
  //
  // A docked module NEVER leaves patch.nodes/edges — docking is a LOCAL
  // projection (dock-store entries, per rackspace in localStorage): the
  // canvas swaps its card for a DockStubCard (same node id — cables stay
  // attached there) and the real card face renders in a screen-fixed rail
  // (DockRail → DockCardHost, outside the SvelteFlow provider — PatchPanel
  // self-gates).

  /** Transient dock toast (auto-evict / delete notices). LOCAL chrome. */
  let dockToast = $state<string | null>(null);
  let dockToastTimer: ReturnType<typeof setTimeout> | null = null;
  function showDockToast(msg: string): void {
    dockToast = msg;
    if (dockToastTimer) clearTimeout(dockToastTimer);
    dockToastTimer = setTimeout(() => (dockToast = null), 4000);
  }

  /** Display name for dock chrome (rail headers, toasts). */
  function dockDisplayName(node: ModuleNode): string {
    return resolveDisplayName(node, patch.nodes as Record<string, ModuleNode | undefined>);
  }

  /** Dock a canvas module into a zone (context-menu action; workflow racks
   *  + DOCKABLE_TYPES only — the menu is gated the same way, this re-checks).
   *  Captures restorePosition and BAKES the current canvas position through
   *  the existing layouts/node.position split, so .ptperf exports and
   *  newcomers always see a sane position while the module is docked. */
  function dockNode(nodeId: string, zone: DockZone): void {
    const n = patch.nodes[nodeId] as ModuleNode | undefined;
    if (!n || isPinnedNode(n) || !isDockableType(n.type)) return;
    const pos = currentNodePosition(nodeId);
    if (!pos) return;
    writeNodePosition(nodeId, pos); // bake (existing mutate path — no new surface)
    dockStore.dock(nodeId, zone, pos);
    trace(`docked ${nodeId} (${n.type}) → ${zone}`);
  }

  /** Undock: remove the local entry + return the node to its dock-time
   *  restorePosition through the SAME position split. NOT undoable (dock
   *  state lives outside the Y.Doc; undock is the explicit inverse). */
  function undockNode(nodeId: string): void {
    const entry = dockStore.undock(nodeId);
    if (!entry) return;
    writeNodePosition(nodeId, entry.restorePosition);
    trace(`undocked ${nodeId} → canvas (${entry.restorePosition.x},${entry.restorePosition.y})`);
  }

  // GC sweep: retire entries whose node vanished (quicksave slot switch,
  // peer delete) to TOMBSTONES — they revive when the id reappears
  // (quickload round-trip) — and auto-evict entries whose node a peer
  // folded into a collapsed group (with a toast; the card has no canvas
  // presence to stub). Runs per snapshot; untracked so the sweep's own
  // store writes never loop the effect.
  $effect(() => {
    const liveIds = new Set(snapshot.nodes.map((n) => n.id));
    const grouped = new Set<string>();
    for (const n of snapshot.nodes) {
      const pg = (n.data as { parentGroupId?: string } | undefined)?.parentGroupId;
      if (pg && collapsedGroupIds.has(pg)) grouped.add(n.id);
    }
    const names = new Map(snapshot.nodes.map((n) => [n.id, dockDisplayName(n)]));
    untrack(() => {
      const evicted = dockStore.sweep(liveIds, grouped);
      for (const id of evicted) {
        showDockToast(`${names.get(id) ?? id} was grouped — undocked`);
      }
    });
  });

  // DOCKING P2.5b eviction hardening: when a RACK-MATE deletes a node the
  // local user has docked, the sweep above evicts the rail card silently
  // (retire → tombstone, keeping the revive path if the id returns — e.g.
  // the peer undoes). The performer staring at a rail deserves a notice,
  // so observe the Y nodes map directly: remote-transaction deletes of a
  // DOCKED id toast. Local transactions are skipped (the local explicit-
  // delete path has its own toast via noteDockDeletes, and a local
  // quickload slot switch must stay silent — the P2.5a tombstone
  // round-trip semantics). A remote LOAD (delete+add in one transaction)
  // is also skipped: those ids are coming back, the entries just revive.
  //
  // Doc-swap seam: `bindRackspace()` REPLACES the whole Y.Doc when a
  // provider attaches mid-mount (the /rack + __attachProvider path — no
  // Canvas remount), so an observer taken from the mount-time `ydoc`
  // would sit on the destroyed doc and never fire. Re-point through
  // onBindRackspace, exactly like the snapshot bus does.
  $effect(() => {
    const onNodes = (event: { transaction: { local: boolean }; changes: { keys: Map<string, { action: string; oldValue?: unknown }> } }) => {
      if (event.transaction.local) return;
      let hasAdds = false;
      for (const [, change] of event.changes.keys) {
        if (change.action === 'add') { hasAdds = true; break; }
      }
      if (hasAdds) return; // bulk replace (peer load) — retire/revive, not a delete notice
      for (const [key, change] of event.changes.keys) {
        if (change.action !== 'delete') continue;
        if (!untrack(() => dockStore.isDocked(key))) continue;
        // Best-effort label: the deleted Y.Map may still expose its type.
        let label = key;
        try {
          const t = (change.oldValue as { get?: (k: string) => unknown } | null)?.get?.('type');
          if (typeof t === 'string' && t) label = t;
        } catch { /* deleted-type read — fall back to the id */ }
        showDockToast(`${label} was deleted by a rack-mate — undocked`);
      }
    };
    let nodesMap = ydoc.getMap('nodes');
    nodesMap.observe(onNodes);
    const offBind = onBindRackspace((_p, doc) => {
      try { nodesMap.unobserve(onNodes); } catch { /* previous doc destroyed */ }
      nodesMap = doc.getMap('nodes');
      nodesMap.observe(onNodes);
    });
    return () => {
      offBind();
      try { nodesMap.unobserve(onNodes); } catch { /* doc may be destroyed */ }
    };
  });

  /** Rail card lists (top/left; bottom adds the pinned occupant below).
   *  A docked id whose node is mid-retirement resolves to nothing here —
   *  the rail slot simply disappears until the tombstone revives. */
  function railCards(zone: DockZone): Array<{ node: ModuleNode; title: string; pinned: boolean }> {
    const out: Array<{ node: ModuleNode; title: string; pinned: boolean }> = [];
    for (const { nodeId } of dockStore.entriesFor(zone)) {
      const node = snapshot.nodes.find((n) => n.id === nodeId);
      if (!node) continue;
      out.push({ node, title: dockDisplayName(node), pinned: false });
    }
    return out;
  }
  let topRailCards = $derived(railCards('top'));
  let leftRailCards = $derived(railCards('left'));

  // ---------------- DOCKING P2.5b: the pan-gesture cable tail ----------------
  //
  // During a pan/zoom gesture, edges to a docked module ride the canvas
  // with the stub (accepted drift, owner Q1) — the tail bridges the gap
  // visually: one presentation-only screen-space bezier per docked-WITH-
  // EDGES node, stub → rail card, mounted on onmovestart and KILLED on
  // onmoveend. Zero cost when idle or when no docked node has edges
  // (dockPanTails stays [] → the overlay renders nothing and onmove does
  // no work). Endpoints: stub via store-derived flowToScreenPosition
  // (re-projected per onmove tick — same-frame, drift-free mid-pan); rail
  // via ONE gBCR at gesture start (rails are viewport-fixed).

  /** DockStubCard face-center offset in FLOW units (158×44 fixed face). */
  const DOCK_STUB_CENTER = { x: 79, y: 22 };

  let dockPanTails = $state<DockTailSpec[]>([]);
  let dockPanTick = $state(0);

  /** Where a tail lands on the rail card: the edge-center FACING the canvas. */
  function railTailAnchor(r: DOMRect, zone: DockZone): { x: number; y: number } {
    switch (zone) {
      case 'top': return { x: r.x + r.width / 2, y: r.bottom };
      case 'left': return { x: r.right, y: r.y + r.height / 2 };
      case 'right': return { x: r.x, y: r.y + r.height / 2 };
      default: return { x: r.x + r.width / 2, y: r.top }; // bottom drawer
    }
  }

  /** Snapshot the gesture's tails: docked nodes that (a) have ≥1 edge and
   *  (b) have a mounted rail card (collapsed rails degrade to no tail). */
  function buildDockPanTails(): DockTailSpec[] {
    if (!flowApi) return [];
    const ids = dockStore.dockedIds;
    if (ids.length === 0) return [];
    const docked = new Set(ids);
    const connected = new Set<string>();
    for (const e of snapshot.edges) {
      if (docked.has(e.source.nodeId)) connected.add(e.source.nodeId);
      if (docked.has(e.target.nodeId)) connected.add(e.target.nodeId);
    }
    if (connected.size === 0) return [];
    const out: DockTailSpec[] = [];
    for (const id of connected) {
      const entry = dockStore.entryFor(id);
      const n = snapshot.nodes.find((sn) => sn.id === id);
      if (!entry || !n) continue;
      const railEl = document.querySelector(`[data-dock-card="${CSS.escape(id)}"]`);
      if (!railEl) continue;
      const pos = getNodePosition(ydoc, currentUserId, id, { x: n.position.x, y: n.position.y });
      out.push({
        nodeId: id,
        flow: { x: pos.x + DOCK_STUB_CENTER.x, y: pos.y + DOCK_STUB_CENTER.y },
        rail: railTailAnchor(railEl.getBoundingClientRect(), entry.zone),
        zone: entry.zone,
      });
    }
    return out;
  }

  // Viewport tick for the workflow channel-columns overlay — re-projects its
  // flow-space bands to screen on every pan/zoom (workflow racks only).
  let wcolViewportTick = $state(0);
  // STRATA (P0.2): publish the derived LOD tier on context for descendant cards
  // (P0.3 consumes it; nothing does yet).
  provideLodTier();
  // Push the live viewport zoom into the shared workflow-zoom store from the
  // SAME onmove tick that re-projects the channel-columns overlay — no new
  // per-frame listener. `setWorkflowZoom` dedupes, so a pure pan is free.
  function publishWorkflowZoom(): void {
    const z = flowApi?.getViewport?.()?.zoom;
    if (typeof z === 'number') setWorkflowZoom(z);
  }
  function onViewportMoveStart(): void {
    dockPanTails = buildDockPanTails();
  }
  function onViewportMove(): void {
    if (dockPanTails.length > 0) dockPanTick++;
    wcolViewportTick++;
    publishWorkflowZoom();
  }
  function onViewportMoveEnd(): void {
    if (dockPanTails.length > 0) dockPanTails = [];
    wcolViewportTick++;
    publishWorkflowZoom();
  }

  /** The 8 channel colours for the overlay column badges — the canonical clip-
   *  player's per-lane automation colours (the single source of truth for
   *  channel colour). Recomputed on graph change. */
  let wcolColumnColors = $derived.by<string[]>(() => {
    void snapshot;
    const clip = wcolCanonClip();
    const data = clip ? (patch.nodes[clip]?.data as AutoClipPlayerData | undefined) : undefined;
    return Array.from({ length: COLUMN_COUNT }, (_, lane) => autoLaneColorEff(data, lane));
  });

  /** UNIFORM lane geometry (workflow only): the guide lines default to ~2× a
   *  tidyvco card tall and ALL grow upward together to the tallest column/send
   *  stack. Heights are the per-TYPE rack tiers → every peer converges. Returns
   *  the flow-space TOP Y the overlay draws every lane line from (baseline stays
   *  pinned at the bottom). */
  let wcolLaneTopY = $derived.by<number>(() => {
    void snapshot;
    const mixer = patch.nodes[WCOL_MIXER_ID];
    // NO PINNED MIXER ⇒ NO LANES ⇒ nothing for anything to clear. This used to
    // read `if (!workflowMode) return COLUMN_BASELINE_Y`, which is the same
    // claim expressed through the deleted shell fork: dawless had no mixer.
    // It has to be said against the ARTIFACT now, because a rack can be a shell
    // rack and still have no mixer (`?seed=none`, or the window before the
    // pinned ensure lands). Without it the derivation computes a lane top from
    // an absent mixer, the GROW-UP PUSH below treats every free-canvas card as
    // dipping into the lanes, and it rewrites their Y on every pass — a card
    // that never stops moving, which surfaced as Playwright's "element is not
    // stable" on a click that should be trivial.
    if (!mixer) return COLUMN_BASELINE_Y;
    const md = mixer?.data as
      | { columns?: Record<string, string[]>; sends?: Record<string, string[]> }
      | undefined;
    const cols = md?.columns ?? {};
    const sends = md?.sends ?? {};
    const stackH = (order: string[]) =>
      order.reduce((sum, id) => sum + wcolCardHeightPx(patch.nodes[id]?.type ?? ''), 0);
    const stacks: number[] = [];
    for (let ch = 1; ch <= COLUMN_COUNT; ch++) stacks.push(stackH(cols[String(ch)] ?? []));
    for (let s = 1; s <= SEND_BOX_COUNT; s++) stacks.push(stackH(sends[String(s)] ?? []));
    // `?shell=1` LANE HEADROOM (owner rule): the band top derives from the
    // TALLEST stack + the bottom badge clearance + half a module of EMPTY
    // headroom above the fullest lane's top tile, clamped to the default top
    // (short stacks keep today's look). Legacy (preview OFF) keeps the exact
    // max(default, tallest-stack) math → byte-identical.
    const height = shellFaces
      ? computeShellLaneHeightPx(stacks, defaultLaneHeightPx(wcolCardHeightPx('tidyVco')))
      : computeLaneHeightPx(stacks, defaultLaneHeightPx(wcolCardHeightPx('tidyVco')));
    return laneTopYForHeight(height);
  });

  // GROW-UP PUSH: when the lanes grow taller, NON-lane canvas modules sitting
  // above them that now dip into the lane region are pushed UP to clear it —
  // even LOCKED ones (we write committed graph position, not a drag). A
  // deterministic one-shot on the lane-top change: planLanePushUps returns an
  // EMPTY plan once everything clears, so this is idempotent (no write storm).
  // Lane members (data.channel/sendSlot), pinned singletons, video-domain cards
  // and the video area's contents are excluded.
  $effect(() => {
    const laneTopY = wcolLaneTopY; // dependency: re-run when lanes grow/shrink
    if ((provider && !providerHasSynced) || scratchSeeded === false) return;
    const candidates: ModuleBoxLike[] = [];
    for (const n of snapshot.nodes) {
      if (n.type === 'cadillac') continue;
      if (isCanvasHiddenNode(n)) continue; // pinned singletons + hidden cameras
      if (n.domain === 'video') continue; // the video zone owns these
      const d = n.data as { channel?: number; sendSlot?: number } | undefined;
      if (typeof d?.channel === 'number' || typeof d?.sendSlot === 'number') continue; // lane member
      const pos = currentNodePosition(n.id) ?? n.position;
      if (pos.y >= COLUMN_BASELINE_Y) continue; // in/below the video area, not above the lanes
      const size = nodeFootprintPx(n.id);
      candidates.push({ id: n.id, x: pos.x, y: pos.y, w: size.w, h: size.h });
    }
    const pushes = planLanePushUps(candidates, laneTopY);
    if (pushes.length === 0) return;
    ydoc.transact(() => {
      for (const p of pushes) {
        const target = patch.nodes[p.id];
        if (!target) continue;
        // Move the SHARED committed position (collab-convergent; every peer
        // computes the same target). Keep X; lift Y to the lockable row.
        target.position = { x: target.position.x, y: p.y };
      }
    }, WORKFLOW_PIN_SPAWN_ORIGIN);
    trace(`workflow: pushed ${pushes.length} module(s) up to clear grown lanes`);
  });

  /** P0.3b — the transient EXPANDED FULL-VIEW occupants (owner extension: up
   *  to TWO side-by-side 50/50 panes, open order = left→right): each is a
   *  node whose full faceplate is open in the bottom dock (an un-migrated
   *  module's verbatim legacy card via nodeTypes[type], or a migrated
   *  module's shell face). NEVER persisted entries — a pane closes to
   *  dockStore.closeFullView(id) and keeps the module's lane
   *  placeholder/shell in place (Option #1). */
  let fullViewCards = $derived.by(() => {
    const out: Array<{ node: ModuleNode; title: string }> = [];
    for (const id of dockStore.fullViewNodeIds) {
      const node = snapshot.nodes.find((n) => n.id === id);
      if (node) out.push({ node, title: dockDisplayName(node) });
    }
    return out;
  });

  /** Modules the shell swapped out of their lane whose ENGINE-VISIBLE state
   *  lives on their CARD — the nodes <HeadlessSourceHost> must keep mounted.
   *  Two halves, one union (see $lib/ui/workflow/dom-source-modules):
   *    - DOM_SOURCE_LANE_TYPES — the card-owned `<video>`/`<img>` must stay
   *      ATTACHED to the engine handle (node registration is graph-driven and
   *      already UI-independent, but SOURCE attachment was card-mount-driven,
   *      so camera/videobox/… → OUTPUT was patched-but-black under `?shell=1`);
   *    - CARD_PRODUCER_LANE_TYPES (#1587) — the card IS the producer: its rAF
   *      loop is the only writer of the module's picture/analysis, so
   *      wavesculpt/timelorde/synesthesia emitted black on a SAVED rack the
   *      user never touched.
   *
   *  Uses the SAME pure lane decision the flowNodes derivation uses, so the two
   *  can never disagree: 'legacy' (`?shell=legacy`, or a NON_SHELL carve-out
   *  like cameraInput/videoOut) and 'stub' (real card in the dock rail) both
   *  render the card SOMEWHERE and are excluded — only 'shell'/'placeholder'
   *  qualify. Additionally excluded:
   *    - a node whose full faceplate is OPEN in the dock (DockFullView already
   *      mounts its real card — a second mount would run two media elements for
   *      one node and the first to unmount would detach the survivor's source),
   *    - canvas-hidden nodes (pinned drawer / hiddenCard cameras): those render
   *      no lane card in preview-off EITHER, so hosting them would ADD engine
   *      state the shell-off rack doesn't have — the opposite of the parity
   *      this fix exists to guarantee.
   *
   *  ⚠ COLLAPSED-GROUP CHILDREN USED TO BE EXCLUDED HERE TOO, on that same
   *  parity reasoning, and for the DOM-SOURCE half they still are (see
   *  `needsHeadlessSourceMount`, which is where the argument now lives). For the
   *  PRODUCER half the exclusion was a hole (#1721): parity requires the two
   *  shells to AGREE, and BOTH were dark, because the collapsed-child skip in
   *  the flowNodes derivation below sits OUTSIDE its `shellFaces` branch.
   *  Measured on the pre-fix tree, wavesculpt.video_out → VIDEO OUT, 20 rAF
   *  frames of the module's own drawFrame into a 64×48 probe: `nonBlack
   *  170/3072, maxLuma 203, 20 distinct signatures` before the group, `0/3072,
   *  0, 1 signature` after it collapsed — identical in the default shell and
   *  under `?shell=legacy`.
   *
   *  ⚠ SO THIS DERIVATION IS NO LONGER A NO-OP UNDER `?shell=legacy`, and the
   *  `if (!shellFaces) return []` short-circuit that used to open it had to go.
   *  It is still a no-op for every arm except the collapsed-group one:
   *  `laneRenderKind` can only return 'legacy'/'stub' when shellFaces is false,
   *  and neither mounts. */
  /** NODE-OWNED MEDIA teardown. A DOM-source module's <video>/<img>, object URL
   *  and MediaStream are owned by $lib/ui/media/node-media-registry so they
   *  survive a CARD unmount (expand/collapse moves the real card between the
   *  headless host and the dock full-view — that is a card MOVE, not a node
   *  deletion, and tearing media down there is the owner-reported "stops
   *  playing when collapsed").
   *
   *  Teardown is therefore keyed to GRAPH lifetime instead, and reconciled
   *  against the live node set rather than hooked onto every delete path — a
   *  node removed by ANY route (context menu, lasso, undo, a peer's CRDT
   *  delete, Clear, a patch load) is swept here, so no delete site has to
   *  remember to call disposeNode.
   *
   *  The NODE-OWNED PROJECTOR ($lib/ui/modules/node-present-registry) is swept
   *  from the same place for the same reason: a "Present on second display"
   *  popup used to die with its card's onDestroy, which under the shell is a
   *  COLLAPSE. Graph lifetime is the only correct owner of both.
   *
   *  ...and the NODE-OWNED RECORDING ($lib/ui/modules/node-recorder-registry),
   *  third instance of the identical bug (#1574): collapsing recorderbox ran
   *  `recorder.abandon()` in the card's onDestroy and destroyed the take. Same
   *  cause, same owner, same sweep — a node deleted by ANY route (menu, lasso,
   *  undo, a peer's CRDT delete, Clear, a patch load) ends its recording here,
   *  so no delete site has to remember.
   *
   *  ...and the NODE-OWNED SAMSLOOP TAKE ($lib/ui/modules/node-samsloop-registry),
   *  fourth instance (#1588) and the worst of them: SamsloopCard's unmount
   *  `$effect` disabled the tap and dropped the PCM accumulator, and NOTHING
   *  called its `stopRecording()` on unmount — so unlike recorderbox there was
   *  no commit path at all and up to 60 s of live audio was destroyed with no
   *  recover candidate. Swept from here for the same reason as the other three.
   *
   *  ...and the NODE-OWNED DOOM SESSION ($lib/ui/modules/node-doom-session-registry),
   *  the #1583 family's last row (#1590): DoomCard's onDestroy ran stopNetcode()
   *  — closing every WebRTC peer connection + unbinding Module.PTNet from the
   *  RUNNING WASM — and killed the rAF loop that was also the lockstep pump, so
   *  a collapse froze EVERY peer of a netgame (#345: a starved barrier pauses by
   *  design). The netcode, the lockstep transport + cursors, the launch state
   *  and the pump loop are node-keyed now; the graph sweep here is the only
   *  non-user teardown.
   *
   *  ...and the NODE-OWNED LAUNCHPAD MONITOR
   *  ($lib/ui/modules/node-launchpad-monitor-registry), the family's first row
   *  to reach PHYSICAL HARDWARE (#1728): OutToLaunchCard's onDestroy ran
   *  `unbindMonitor(id)`, which blanks all 81 LEDs, sends the exit-programmer
   *  SysEx and drops the claim — so a collapse took the performer's Launchpad
   *  dark and handed it back to Live, with nothing re-binding on remount. The
   *  claim stays in the device layer (it arbitrates across the L/R clip-launcher
   *  units too, and two maps could disagree about who owns a surface); what
   *  moved to the node is the 30 fps LED PUMP and the release trigger. Swept
   *  from here for the same reason as the other six — and a Launchpad left in
   *  programmer mode with nothing driving it is unusable for control until a
   *  replug, so this sweep is load-bearing, not politeness. */
  $effect(() => {
    const liveIds = snapshot.nodes.map((n) => n.id);
    nodeMedia.sweep(liveIds);
    nodePresent.sweep(liveIds);
    nodeRecorder.sweep(liveIds);
    nodeSamsloop.sweep(liveIds);
    nodeAudioInput.sweep(liveIds);
    nodeDoomSession.sweep(liveIds);
    nodeLaunchpadMonitor.sweep(liveIds);
    nodeExtras.sweep(liveIds);
  });

  /** THE EXTRAS-CHANNEL PRODUCER SEAM (#1720). The sixth instance of the #1583
   *  class and the first that is NOT a teardown: painter, textmarquee,
   *  picturebox and toybox never INITIALISE without a card. Their picture is a
   *  pure function of persisted `node.data` (an op log, a rich-text model, a
   *  base64 image), and the CARD was the only thing that ever pushed it through
   *  `engine.read(id, 'extras')` — so under the shell, where an un-migrated
   *  module's card exists only inside the dock full-view, a SAVED rack rendered
   *  each module's BUILT-IN PLACEHOLDER on load, before anything was touched.
   *
   *  Measured on the default `/rack` with the content already in node.data,
   *  reading each node's own output texture: painter meanRGB (255,255,255) — a
   *  blank page — against (255,0,0) with the card mounted; textmarquee nonBlack
   *  446/49152 (the literal word "textmarquee") against 36992/49152; picturebox
   *  (5,15,20) against (0,0,254).
   *
   *  Deliberately NOT solved by adding them to CARD_PRODUCER_LANE_TYPES: that
   *  buys a PERMANENT off-screen mount of the real card on every rack, and none
   *  of these four is a live producer — each pushes ONCE from graph state. See
   *  $lib/ui/media/node-extras-registry for the full argument.
   *
   *  Runs on the SAME snapshot the sweep above reads, so a node that arrives,
   *  changes its data, or leaves is handled by one authority: the graph. */
  $effect(() => {
    nodeExtras.sync(snapshot.nodes, engine);
  });

  let headlessSourceNodes = $derived.by<ModuleNode[]>(() => {
    const collapsed = collapsedGroupIds;
    const out: ModuleNode[] = [];
    for (const n of snapshot.nodes) {
      if (!HEADLESS_MOUNT_LANE_TYPES.has(n.type)) continue;
      if (isCanvasHiddenNode(n)) continue;
      if (dockStore.isFullView(n.id)) continue;
      const parentGroupId = (n.data as { parentGroupId?: string } | undefined)?.parentGroupId;
      // The lane emits NO node for a collapsed group's child (see the flowNodes
      // derivation below), in EITHER shell — so `kind` describes a card that is
      // never reached, and the decision needs to know that rather than infer it.
      const laneOmitsNode = !!parentGroupId && collapsed.has(parentGroupId);
      const kind = laneRenderKind({
        shellFaces,
        userDocked: !!dockStore.entryFor(n.id),
        type: n.type,
        hasCard: isShellSwappable(n.type, cardTypeSet.has(n.type)),
        migrated: migrated(n.type),
      });
      if (
        needsHeadlessSourceMount({
          kind,
          type: n.type,
          laneOmitsNode,
          // GroupCard hidden-mounts a viz-passthrough child's REAL card for
          // exactly as long as the group is collapsed, so that node already has
          // a live host and a second one would be a double mount.
          hostedElsewhere: laneOmitsNode && groupCardHostsChildCard(n.type),
        })
      ) {
        out.push(n);
      }
    }
    return out;
  });

  // A VIDEO-domain module expanded in the dock full-view holds a HARD render
  // lease for as long as the faceplate is open: the dock mount is a live
  // presentation surface OUTSIDE the flow pane, but the central card-visibility
  // observer only tracks the node's LANE element — pan the lane copy off-screen
  // and pull-eval would demote the chain (~1.5s TTL), freezing the dock's
  // preview mid-view. Exactly the surface class acquireRenderLease exists for
  // (VideoOutCard's fullscreen/present modes use the same seam). Refcounted +
  // released the moment the full-view closes ($effect cleanup); non-video
  // occupants never reach the acquire.
  $effect(() => {
    const fvs = fullViewCards;
    const e = engine;
    if (fvs.length === 0 || !e) return;
    const videoFvs = fvs.filter((fv) => getVideoModuleDef(fv.node.type));
    if (videoFvs.length === 0) return;
    let ve: VideoEngine | undefined;
    try {
      ve = e.getDomain<VideoEngine>('video');
    } catch {
      return;
    }
    if (!ve) return;
    // One lease per VIDEO-domain pane (both split panes can be video).
    const releases = videoFvs.map((fv) => ve!.acquireRenderLease(fv.node.id));
    return () => {
      for (const release of releases) release();
    };
  });

  let bottomRailCards = $derived.by(() => {
    const docked = railCards('bottom');
    const out: Array<{ node: ModuleNode; title: string; pinned: boolean }> = [];
    // The pinned M/E/C occupant renders FIRST, alongside docked cards —
    // the P1 drawer generalized (pinned stays drawer-only per owner Q2).
    // NOTE: the EXPANDED full-view no longer routes through this card flex — it
    // owns its own full-width <DockFullView> faceplate below the bottom rail
    // (P0.3b re-spec); this list holds only the pinned occupant + docked entries.
    if (dockedBottomNode && dockedBottomSpec) {
      out.push({ node: dockedBottomNode, title: dockedBottomSpec.label, pinned: true });
    }
    out.push(...docked);
    return out;
  });

  // ---------------- WORKFLOW MODE P2: topbar surface plumbing ----------------
  //
  // Snapshot-derived nodes/state the three topbar surfaces (clock / MIDI
  // DIN / audio I/O) render from.
  let workflowTimelordeNode = $derived(
    resolveWorkflowTimelorde(snapshot.nodes),
  );
  let workflowMidiclockNode = $derived(
    snapshot.nodes.find((n) => n.id === 'pinned-midiclock') ?? null,
  );
  let workflowAudioInNode = $derived(
    snapshot.nodes.find((n) => n.id === 'pinned-audioIn') ?? null,
  );
  let workflowAudioOutNode = $derived(
    snapshot.nodes.find((n) => n.id === 'pinned-audioOut') ?? null,
  );
  /** A cable feeds TIMELORDE's clock input (DIN assignment or hand-patch)
   *  → tap tempo + tempo knob flip to the externally-clocked state. */
  let workflowExternallyClocked = $derived(
    hasWorkflowExternalClock(snapshot.edges, workflowTimelordeNode?.id ?? null),
  );
  /** The DIN bridge's clock edge into TIMELORDE exists (the ⚇ menu shows
   *  the assigned device + unassign ✕). */
  let workflowDinAssigned = $derived(
    isDinAssigned(snapshot.edges, 'pinned-midiclock', workflowTimelordeNode?.id ?? null),
  );
  // ---------------- WORKFLOW MODE P4: camera manager plumbing ----------------
  /** The mapped (hiddenCard) camera nodes the 📷 menu lists, in stable
   *  ordinal order. DYNAMIC (0..N, user-added) — never auto-ensured. */
  let workflowCameraNodes = $derived(
    listWorkflowCameras(snapshot.nodes),
  );
  /** One more camera would exceed cameraInput.maxInstances (the ＋ row's
   *  disabled state — hidden cameras + canvas CAMERA cards both count). */
  let workflowCameraAtCapNow = $derived(
    workflowCameraAtCap(snapshot.nodes),
  );

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

  // WORKFLOW MODE P1/P4 — ids of every canvas-hidden node: the pinned
  // drawer/topbar singletons (P1/P2) plus the hiddenCard headless camera
  // instances (P4), for the defensive edge filter below.
  let canvasHiddenNodeIds = $derived.by<Set<string>>(() => {
    const ids = new Set<string>();
    for (const n of snapshot.nodes) {
      if (isCanvasHiddenNode(n)) ids.add(n.id);
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

  // ── Per-entry FlowNode/FlowEdge identity reuse (per-commit-cascade fix) ──
  //
  // Layer 2 of the phase-2 MIDI-CC perf fix. The snapshot bus now emits
  // identity-stable entries for untouched nodes/edges (graph/snapshot.ts
  // memo); these effects extend that stability into the arrays fed to
  // SvelteFlow, because a FRESH FlowNode object per node per commit is what
  // makes xyflow rebuild every InternalNode: adoptUserNodes' checkEquality
  // (`userNode === internals.userNode`) misses, `measured` resets (our
  // objects were built without it), nodesInitialized flips false, and every
  // node + every HANDLE gets getBoundingClientRect re-measured — hundreds of
  // forced-layout reads per settled CC commit on a heavy video patch.
  //
  // Reuse rules (per node): the snapshot entry identity, the RESOLVED
  // per-user position (layouts live OUTSIDE the nodes map, so the memo
  // can't cover them), the remote-grouping badge ref, and the top-z flag
  // must all be unchanged. class/style/draggable are pure functions of the
  // entry (type + data content), so entry identity covers them.
  //
  // Reuse SOURCE: xyflow's CURRENT `internals.userNode` — after a measure/
  // selection writeback xyflow's store holds ITS OWN clone of our object,
  // so re-emitting OUR previous object would still miss checkEquality.
  // Re-emitting xyflow's clone is what makes the equality hit and keeps
  // measured/handleBounds alive. Guarded: only when our data wrapper +
  // type are literally the same (never resurrects a stale clone after a
  // clear→load id collision — the B3-stomp bug class that killed
  // bind:nodes; this stays strictly prop-rebuild reuse, NO bind:nodes).
  //
  // Rebuilt (dirty) entries carry xyflow-owned fields forward (`measured`,
  // `selected`) so a single dirty node doesn't re-measure either — with
  // `measured` present, xyflow's parseHandles keeps the existing
  // handleBounds instead of resetting them.
  interface PrevFlowNodeEntry {
    snapNode: ModuleNode;
    x: number;
    y: number;
    remoteUser: PresenceUser | undefined;
    top: boolean;
    /** DOCKING P2.5a: the type we EMITTED for this node ('dockStub' while
     *  docked, else the snapshot type). The reuse + carry-forward guards
     *  below compare against THIS, not n.type — comparing the snapshot
     *  type would permanently miss for stubs (the verifier's re-measure-
     *  churn catch) and dock/undock must dirty exactly one rebuild. */
    emittedType: string;
    /** Dock zone baked into a stub's data (re-dock to another zone must
     *  rebuild so the stub face relabels). Null when not docked. */
    dockZone: DockZone | null;
    /** MODULE-level automation assignment border: the assigned lane's colour
     *  hex (or null). In the guard so an assign / unassign / lane-recolour
     *  rebuilds the wrapper even though the MODULE's own snap node is
     *  unchanged (only the clip-player's data moved). */
    autoColor: string | null;
    obj: FlowNode;
  }
  /** The only-L / only-R channel tag's look. INLINE because xyflow portals the
   *  edge label out of the edge element (see the `labelStyle` note at the
   *  assignment site) — a stylesheet rule has nothing edge-specific to hang on.
   *  Deliberately quiet: the DASHES say "partial", the letter says WHICH half,
   *  and neither competes with the cable's own hue, which still means CABLE
   *  TYPE and nothing else. */
  const CABLE_SOLO_LABEL_STYLE =
    'font: 700 9px ui-monospace, monospace; color: var(--text-dim, #9aa2ad);' +
    'background: var(--bg, #0a0c0f); opacity: 0.85; padding: 0 2px; border-radius: 2px;';

  interface PrevFlowEdgeEntry {
    snapEdge: Edge;
    related: boolean;
    /** The leg-group verdict this FlowEdge was built from. In the reuse guard
     *  because it is NOT a function of `snapEdge` alone: a cable becomes /
     *  stops being an only-L when its SIBLING leg appears or disappears, and
     *  that edit never touches this edge's own record. Without it the dashes
     *  would go stale until something else rebuilt the array. */
    solo: 'left' | 'right' | null;
    obj: FlowEdge;
  }
  // Plain (non-reactive) maps — swept every pass, so deleted ids GC.
  // Component-instance state: the rackspace page remounts Canvas per
  // rackspace ({#key rackspace.id}), so a rebind never leaks entries.
  let prevFlowNodes = new Map<string, PrevFlowNodeEntry>();
  let prevFlowEdges = new Map<string, PrevFlowEdgeEntry>();

  $effect(() => {
    const snap = snapshot;
    const top = topNodeId;
    const collapsed = collapsedGroupIds;
    const remoteByNode = remoteGroupBuildingByNode;
    const next: FlowNode[] = [];
    const nextPrev = new Map<string, PrevFlowNodeEntry>();
    let rebuiltAny = false;
    // MODULE-level automation assignment → the ASSIGNED module's card wrapper
    // gets a thin border in its lane's colour (owner: "we assign entire
    // modules to a lane, they get the border"). Computed once per pass from
    // every clip-player's autoAssign at the SHARED node-wrapper seam, so it
    // works for every module type. When TWO players assign the same module,
    // the LOWEST player node id wins visually (deterministic; playback keeps
    // single-driver ownership regardless).
    const autoBorderByModule = new Map<string, string>();
    {
      const players = snap.nodes
        .filter((n) => n.type === 'clipplayer')
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      for (const p of players) {
        const pdata = p.data as AutoClipPlayerData | undefined;
        for (const [moduleId, lane] of Object.entries(coerceAutoAssign(pdata?.autoAssign))) {
          if (!autoBorderByModule.has(moduleId)) {
            autoBorderByModule.set(moduleId, autoLaneColorEff(pdata, lane));
          }
        }
      }
    }
    // WORKFLOW CHANNEL COLUMNS: a member's on-screen slot is COMPUTED from its
    // index in the column/send ORDER array (position = render output). So the
    // visual column always matches the DSP chain, a drag-nudge can never reorder
    // it, and per-user free layouts don't apply to column members. Built once per
    // pass from the pinned mixer's order manifest.
    const wcolPosByNode = new Map<string, { x: number; y: number }>();
    const mixer = snap.nodes.find((m) => m.id === WCOL_MIXER_ID);
    const md = mixer?.data as
      | { columns?: Record<string, string[]>; sends?: Record<string, string[]> }
      | undefined;
    const cols = md?.columns ?? {};
    const sends = md?.sends ?? {};
    // FLUSH bottom-up stacking (owner: no gaps, cards sit directly on top of
    // each other, FIRST-added card anchored at the very bottom, newest on top).
    // Heights are per-TYPE rack constants → deterministic + collab-convergent.
    const typeOf = new Map(snap.nodes.map((n) => [n.id, n.type]));
    const heightsFor = (order: string[]) =>
      order.map((id) => wcolCardHeightPx(typeOf.get(id) ?? ''));
    const widthsFor = (order: string[]) =>
      order.map((id) => wcolCardWidthPx(typeOf.get(id) ?? ''));
    for (let ch = 1; ch <= COLUMN_COUNT; ch++) {
      const order = cols[String(ch)] ?? [];
      const positions = columnFlushPositions(ch, heightsFor(order), widthsFor(order), wcolPitch, wcolStackAnchorY);
      order.forEach((id, i) => wcolPosByNode.set(id, positions[i]!));
    }
    for (let s = 1; s <= SEND_BOX_COUNT; s++) {
      const order = sends[String(s)] ?? [];
      const positions = sendFlushPositions(s, heightsFor(order), widthsFor(order), wcolPitch, wcolStackAnchorY);
      order.forEach((id, i) => wcolPosByNode.set(id, positions[i]!));
    }
    // SHELL PREVIEW: the video-zone default trio (videoOut / recorderbox /
    // synesthesia) is NOT a channel member, so it renders at its PERSISTED
    // spawn X — the wide 765px video-zone pitch. Under the narrowed lanes that
    // strands them far right of the tight columns, so RE-DERIVE their RENDER
    // position to the shell pitch, PACKED left-to-right (videoZonePackedXs):
    // a tile-swapped default reserves one uniform SHELL_TILE_W slot (an
    // all-tile zone packs to EXACTLY the historic fixed 216px slots), while a
    // LEGACY-rendered default — videoOut, the video-surface snowflake whose
    // real card stays in the lane — reserves its ACTUAL live width
    // (node.data.width, the freely-resizable card), so it never overlaps its
    // tile neighbours and a corner-drag resize simply pushes them right. The
    // override anchors POSITION only; the card sizes itself. Also nudge each
    // TOP DOWN by SHELL_VIDEO_ZONE_TILE_INSET_Y so the whole tile sits INSIDE
    // the darker video area — un-inset, the tile top lands on the zone's
    // dashed border (drawn at COLUMN_BASELINE_Y == the slot's un-inset top)
    // and its jack rail collides with the lane-number badges just above it.
    // Pure render OVERRIDE (like the channel members) — the persisted x/y is
    // untouched, so preview OFF is byte-identical and no Y.Doc write / collab
    // divergence.
    if (shellFaces) {
      const present = VIDEO_ZONE_DEFAULTS.filter((spec) => typeOf.has(spec.id));
      const widths = present.map((spec) => {
        if (!NON_SHELL_LANE_TYPES.has(spec.type)) return SHELL_TILE_W;
        // Legacy in-lane card (videoOut): its live resizable width.
        const n = snap.nodes.find((m) => m.id === spec.id);
        const w = (n?.data as { width?: number } | undefined)?.width;
        return typeof w === 'number' && w > 0 ? w : spec.nominalWidth;
      });
      const origin = videoZoneSlotPos(0, wcolPitch);
      const xs = videoZonePackedXs(origin.x, widths, wcolPitch);
      present.forEach((spec, i) => {
        wcolPosByNode.set(spec.id, { x: xs[i]!, y: origin.y + SHELL_VIDEO_ZONE_TILE_INSET_Y });
      });
    }
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
      // CANVAS-HIDDEN workflow nodes: PINNED singletons (data.pinned —
      // graph/workflow-pins.ts; drawer-only is the REVERSIBLE Q3 default)
      // and hiddenCard headless instances (data.hiddenCard —
      // graph/hidden-card.ts; the P4 camera manager's mapped cameras,
      // whose face is the topbar 📷 menu).
      if (isCanvasHiddenNode(n)) continue;
      const remoteUser = remoteByNode[n.id];
      // Per-user layouts: getNodePosition returns the user's override
      // (when in multiplayer) or falls back to n.position (when single-
      // user OR when this user has no entry yet).
      // Column/send members: position is DERIVED from the order array (above),
      // overriding the free/per-user position. Non-members fall back to the
      // normal per-user layout resolution.
      const resolved =
        wcolPosByNode.get(n.id) ??
        getNodePosition(ydoc, currentUserId, n.id, { x: n.position.x, y: n.position.y });
      const isTop = top === n.id;
      // DOCKING P2.5a: a docked node renders as a small DockStubCard IN ITS
      // PLACE — same node id, so every cable stays attached natively. The
      // real card face lives in the dock rail (DockCardHost). Reading
      // entryFor subscribes this pass to dock/undock.
      const dockEntry = dockStore.entryFor(n.id);
      // P0.3b LEGACY-FALLBACK BRIDGE: generalizes the docked→stub swap. A pure
      // derivation from mode + the `?shell=1` preview + user-dock + STRICT_FACES
      // membership — NEVER persisted. Preview OFF (default) ⇒ 'legacy' for every
      // non-docked node ⇒ byte-identical to the old `dockEntry ? 'dockStub' :
      // n.type`. Preview ON ⇒ un-migrated → placeholder, migrated → shell.
      const renderKind = laneRenderKind({
        shellFaces,
        userDocked: !!dockEntry,
        type: n.type,
        hasCard: isShellSwappable(n.type, cardTypeSet.has(n.type)),
        migrated: migrated(n.type),
      });
      const emittedType = emittedTypeFor(renderKind, n.type);
      const dockZone = dockEntry?.zone ?? null;
      // xyflow's current user-node for this id. untrack: nodeLookup is a
      // plain Map today, but an xyflow upgrade to reactive lookups must
      // not create an effect↔measure feedback loop.
      const cur = untrack(() => flowApi?.getInternalNode(n.id))?.internals?.userNode as
        | (FlowNode & { measured?: { width?: number; height?: number } })
        | undefined;
      const autoColor = autoBorderByModule.get(n.id) ?? null;
      const prev = prevFlowNodes.get(n.id);
      if (
        prev
        && prev.snapNode === n
        && prev.x === resolved.x
        && prev.y === resolved.y
        && prev.remoteUser === remoteUser
        && prev.top === isTop
        && prev.emittedType === emittedType
        && prev.dockZone === dockZone
        && prev.autoColor === autoColor
      ) {
        // Unchanged → reuse. Prefer xyflow's current userNode (see header
        // comment). Guard on PRIMITIVE fields only: after a writeback,
        // xyflow's local nodes live behind a Svelte 5 deep proxy, so nested
        // object identity (cur.data === …) can NEVER hit through it — but
        // id/type strings compare fine. The comparison is against the
        // EMITTED type (stub swap): comparing n.type would permanently miss
        // for docked stubs → re-measure churn every pass. Data lineage is
        // safe by construction: within a mount, internals.userNode for this
        // id is always the object WE last emitted for it or an xyflow
        // spread-clone descending from it (spreads preserve `data`), and
        // any change to what we emit goes through the rebuild branch below,
        // which resets prev.obj — so a matching id+type here cannot carry a
        // stale data payload.
        const reusable = cur && cur.id === n.id && cur.type === emittedType ? cur : prev.obj;
        next.push(reusable);
        nextPrev.set(n.id, { snapNode: n, x: resolved.x, y: resolved.y, remoteUser, top: isTop, emittedType, dockZone, autoColor, obj: reusable });
        continue;
      }
      rebuiltAny = true;
      const node: FlowNode = {
        // Carry xyflow-owned fields forward on a rebuild so ONE dirty node
        // doesn't reset measured/handleBounds (re-measure) or lose its
        // selection. Type-guarded against the EMITTED type so a same-id
        // different-type replacement — including the card↔stub dock swap —
        // never inherits a foreign card's dimensions.
        ...(cur && cur.type === emittedType ? { measured: cur.measured, selected: cur.selected } : {}),
        id: n.id,
        type: emittedType,
        position: resolved,
        data: {
          node: n,
          // DOCKING P2.5a: the stub face labels its zone + click-to-focus.
          ...(dockZone ? { dockZone } : {}),
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
      if (dockEntry) {
        // Stubs: fixed small face (no rack sizing), not draggable (undock
        // returns the node to restorePosition — a movable stub would make
        // that write-back ambiguous), `no-flip` so rear view neither
        // mirrors nor hides it (its cables must stay traceable).
        node.draggable = false;
        node.class = 'dock-stub no-flip';
        // A DOCKED assigned module keeps its lane border on the stub (its
        // canvas presence) so the assignment cue never silently disappears
        // when a module docks. (The dock-rail card face carries no lane
        // treatment yet — noted follow-up.)
        if (autoColor) {
          node.class += ' auto-lane-assigned';
          node.style = `${node.style ? node.style + ';' : ''}--auto-lane-color:${autoColor}`;
        }
        next.push(node);
        nextPrev.set(n.id, { snapNode: n, x: resolved.x, y: resolved.y, remoteUser, top: isTop, emittedType, dockZone, autoColor, obj: node });
        continue;
      }
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
      // MODULE-level automation assignment border (shared wrapper seam — works
      // for every module type): the assigned lane's colour as a thin outline.
      // UI-can't-lie: the inline var IS the lane colour from the assignment.
      if (autoColor) {
        node.class = node.class ? `${String(node.class)} auto-lane-assigned` : 'auto-lane-assigned';
        node.style = `${node.style ? node.style + ';' : ''}--auto-lane-color:${autoColor}`;
      }
      if (isTop) node.zIndex = 1000;
      next.push(node);
      nextPrev.set(n.id, { snapNode: n, x: resolved.x, y: resolved.y, remoteUser, top: isTop, emittedType, dockZone, autoColor, obj: node });
    }
    prevFlowNodes = nextPrev;
    // No-op short-circuit: if every entry is identity-reused AND the array
    // shape matches, skip the reassign — that skips the whole adoptUserNodes
    // pass for transactions that touched nothing we render (e.g. layouts).
    const current = untrack(() => flowNodes);
    if (!rebuiltAny && next.length === current.length) {
      let same = true;
      for (let i = 0; i < next.length; i++) {
        if (next[i] !== current[i]) { same = false; break; }
      }
      if (same) return;
    }
    flowNodes = next;
  });

  $effect(() => {
    const snap = snapshot;
    const hovered = hoveredNodeId;
    const childToGroup = nodeIdToCollapsedGroupId;
    const next: FlowEdge[] = [];
    const nextPrev = new Map<string, PrevFlowEdgeEntry>();
    let rebuiltAny = false;
    // xyflow's current edge array (selection clones included) — the edge
    // reuse source, mirroring internals.userNode for nodes. One map per
    // pass; getLayoutedEdges reuses an edge's LAYOUT iff the edge object +
    // both InternalNodes are reference-equal, so stable identities here
    // (+ stable nodes above) skip getEdgePosition for untouched cables.
    const curEdges = untrack(() => flowApi?.getEdges() ?? []);
    const curById = new Map<string, FlowEdge>();
    for (const ce of curEdges) curById.set(ce.id, ce);
    // ONE BEZIER PER LEG GROUP. A stereo cable is two Edge records between the
    // same two cards, anchored at the same hidden corner handle stack — drawing
    // both is one visually-fat cable that deletes half at a time. The left leg
    // draws it; the right is skipped here and re-joined by `expandLegGroups` on
    // delete/unpatch, so the picture and the removal agree. A group that is a
    // LONE leg (an only-L/R patch, or a legacy single-leg edge from a rack
    // saved before leg groups existed) keeps its bezier and gets the dashed
    // `cable-left-only` / `cable-right-only` treatment + an L / R tag.
    const legGroups = computeLegGroups(snap.edges, stereoDefForNode);
    for (const e of snap.edges) {
      // Skip edges whose endpoint references a hidden child (i.e. a
      // member of a collapsed group). Internal edges between two children
      // of the same group are hidden entirely; external edges to a single
      // hidden child get rewritten at create-group time to terminate on
      // the group's exposed port, so they'd already point at the group
      // node here. A leftover edge to a hidden child indicates a
      // pre-group-creation snapshot — defensive drop.
      if (childToGroup.has(e.source.nodeId) || childToGroup.has(e.target.nodeId)) continue;
      // Edges touching a CANVAS-HIDDEN node (pinned singleton OR
      // hiddenCard headless camera): the node isn't on the canvas, so the
      // cable can't render there either (defensive — same rationale as
      // the hidden-group-child drop above).
      if (canvasHiddenNodeIds.has(e.source.nodeId) || canvasHiddenNodeIds.has(e.target.nodeId)) continue;
      // The sibling leg of a rendered stereo cable: its partner draws the whole
      // group. An edge MISSING from the map is drawn plainly rather than
      // dropped — a cable nobody draws is a cable nobody can delete.
      const leg = legGroups.get(e.id);
      if (leg && !leg.render) continue;
      const solo = leg?.soloChannel ?? null;
      const related = !!hovered && (e.source.nodeId === hovered || e.target.nodeId === hovered);
      const prev = prevFlowEdges.get(e.id);
      if (prev && prev.snapEdge === e && prev.related === related && prev.solo === solo) {
        // Hover now flips identity for only the hovered node's cables
        // instead of rebuilding ALL edges on every hover change.
        const cur = curById.get(e.id);
        const reusable =
          cur
          && cur.source === prev.obj.source
          && cur.target === prev.obj.target
          && cur.sourceHandle === prev.obj.sourceHandle
          && cur.targetHandle === prev.obj.targetHandle
            ? cur
            : prev.obj;
        next.push(reusable);
        nextPrev.set(e.id, { snapEdge: e, related, solo, obj: reusable });
        continue;
      }
      rebuiltAny = true;
      const edge: FlowEdge = {
        id: e.id,
        source: e.source.nodeId,
        sourceHandle: e.source.portId,
        target: e.target.nodeId,
        targetHandle: e.target.portId,
        style: `stroke: var(--cable-${e.sourceType}); stroke-width: 3;`,
      };
      const classes: string[] = [];
      if (related) classes.push('cable-related');
      if (solo) {
        // Half a stereo image. Dashed at the SAME 4/4 rhythm as the PickupCable
        // ghost, so "in flight" and "only one channel" read as one visual
        // vocabulary, plus a one-letter channel tag on the cable itself.
        classes.push(solo === 'left' ? 'cable-left-only' : 'cable-right-only');
        edge.label = solo === 'left' ? 'L' : 'R';
        // ⚠ The label is an HTML div PORTALED OUT of the <g.svelte-flow__edge>
        // into xyflow's `edge-labels` container (EdgeLabel.svelte), so it can
        // be reached by NEITHER a descendant CSS selector on the edge NOR a
        // per-edge locator. Styling therefore has to ride inline via
        // `labelStyle`, and the tag carries its own `data-*` hook for tests.
        edge.labelStyle = CABLE_SOLO_LABEL_STYLE;
      }
      if (classes.length > 0) edge.class = classes.join(' ');
      // Carry xyflow-owned selection forward on a rebuild (mirror nodes).
      const cur = curById.get(e.id);
      if (cur && cur.selected !== undefined) edge.selected = cur.selected;
      next.push(edge);
      nextPrev.set(e.id, { snapEdge: e, related, solo, obj: edge });
    }
    prevFlowEdges = nextPrev;
    const current = untrack(() => flowEdges);
    if (!rebuiltAny && next.length === current.length) {
      let same = true;
      for (let i = 0; i < next.length; i++) {
        if (next[i] !== current[i]) { same = false; break; }
      }
      if (same) return;
    }
    flowEdges = next;
  });

  // Dev/test-only probes for the identity-reuse regression e2e: expose the
  // CURRENT flowNodes/flowEdges arrays + the xyflow internal-node lookup so
  // a spec can assert (in ONE page.evaluate) that an untouched card's
  // FlowNode object + measured stay reference-identical across a store
  // commit — the mechanism gate for the no-re-measure fix.
  if (testHooksEnabled()) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).__flowGraphProbe = () => ({
      nodes: flowNodes,
      edges: flowEdges,
      internal: (id: string) => flowApi?.getInternalNode(id),
    });
  }

  function trace(line: string) {
    console.log('[canvas]', line);
    log = [...log.slice(-7), line];
  }

  // (ensureEngine moved below the palette section so its types are colocated)

  function clearPatch() {
    ydoc.transact(() => {
      for (const id of Object.keys(patch.edges)) delete patch.edges[id];
      for (const id of Object.keys(patch.nodes)) {
        // PINNED workflow singletons survive Clear — they're structural to
        // a workflow rack (always-on M/E/C drawers). Their edges still go
        // (Clear = unpatch everything).
        if (isPinnedNode(patch.nodes[id])) continue;
        delete patch.nodes[id];
      }
    }, LOCAL_ORIGIN);
    // No defensive flowNodes=[] anymore: B3's snapshot bus pushes the
    // empty snapshot to this $effect synchronously on the same Yjs
    // update, and SvelteFlow now consumes a one-way `nodes` prop so it
    // can't stomp the assignment.
    trace('cleared patch');
  }

  // ---------------- File → New rack ----------------
  //
  // Create a FRESH rack of the CURRENT kind (mode preserved), reusing the two
  // existing create paths rather than a parallel system:
  //   - SIGNED IN  → POST /api/rackspaces {mode} (the dashboard's create call)
  //                  → navigate to the new /r/{id}. A brand-new doc id keeps it
  //                    collab-safe (a fresh Y.Doc, never a fork of this one).
  //   - LOGGED OUT → mint a fresh anonymous scratch id for this mode
  //                  (resetLocalScratchId) and reload the scratch route so the
  //                    replica rehydrates an EMPTY doc. The workflow shell's
  //                    pinned singletons re-spawn on mount either way.
  // If the signed-in create fails (offline / rack cap), we fall through to a
  // scratch rack rather than dead-ending the button.
  let newRackBusy = $state(false);
  async function newRack() {
    if (newRackBusy) return;
    newRackBusy = true;
    try {
      if (headerSignedIn) {
        try {
          const res = await fetch('/api/rackspaces', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'Untitled rackspace' }),
          });
          if (res.ok) {
            const { rackspace } = (await res.json()) as { rackspace: { id: string } };
            await goto(`/r/${rackspace.id}`);
            return;
          }
          // Non-OK (cap reached / auth lapsed) → fall through to a scratch rack.
        } catch {
          /* network error → fall through to a scratch rack. */
        }
      }
      // Logged-out (or the persisted create failed): a fresh scratch rack.
      // Reset the per-device id, then either hard-reload the scratch route
      // (already here → the derived id won't re-read localStorage, so reload
      // rebinds to the new empty doc) or navigate to it.
      resetLocalScratchId();
      const onScratch =
        typeof window !== 'undefined' && window.location.pathname === '/rack';
      if (onScratch) {
        window.location.reload();
      } else {
        await goto('/rack');
      }
    } finally {
      newRackBusy = false;
    }
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
   *  materialize the loaded nodes — identical to the old "Load" button. */
  async function importPatchJson() {
    error = null;
    try {
      // Pick + parse (non-destructive) FIRST — this replaces the old
      // pickAndLoadEnvelope, which loaded atomically and gave no seam to run a
      // precondition before the destructive wipe.
      const file = await pickFile('.imp.json,application/json');
      if (!file) {
        trace('import JSON cancelled');
        return;
      }
      const env = parseEnvelope(await file.text());
      // P4: DESTRUCTIVE-WIPE confirm. loadEnvelopeIntoStore clears-then-re-adds
      // the whole graph; in a shared rack that clear tombstones every peer's
      // copy + the relay snapshot + the journal — a durable, multi-user wipe.
      // When the current rack is NON-EMPTY, confirm first. The parse above is
      // non-destructive, so cancelling leaves the live graph untouched. An
      // empty rack skips the prompt and proceeds.
      if (
        !confirmDestructiveImport(Object.keys(patch.nodes).length, () =>
          window.confirm(IMPORT_REPLACE_CONFIRM_MESSAGE),
        )
      ) {
        trace('import JSON cancelled (kept current rack)');
        return;
      }
      await ensureEngine();
      // Routed through persistenceLoad (not loadEnvelopeIntoStore directly) so
      // this path gets the same non-blocking diagnostic notice as every other.
      const result = persistenceLoad(env, ydoc, patch);
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
  async function resolveMidiDevices(): Promise<{
    input: (id: string) => { name: string; manufacturer?: string } | null;
    output: (id: string) => { name: string; manufacturer?: string } | null;
  }> {
    const none = { input: () => null, output: () => null };
    try {
      type Dev = { name?: string | null; manufacturer?: string | null };
      const nav = navigator as unknown as {
        requestMIDIAccess?: (o?: unknown) => Promise<{ inputs: Map<string, Dev>; outputs: Map<string, Dev> }>;
      };
      if (typeof nav.requestMIDIAccess !== 'function') return none;
      const access = await nav.requestMIDIAccess({ sysex: false });
      const from = (m: Map<string, Dev>) => (id: string) => {
        const d = m.get(id);
        if (!d || !d.name) return null;
        return { name: d.name, manufacturer: d.manufacturer ?? undefined };
      };
      // BOTH halves of the access: input types (midiCvBuddy/midiLane/midiclock)
      // resolve against .inputs; midiOutBuddy against .outputs. Resolving an
      // output id against .inputs is why an all-output rig used to export
      // midiDevices: [] and load with no auto-bind (owner staircase, 2026-08-06).
      return { input: from(access.inputs), output: from(access.outputs) };
    } catch {
      return none;
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
      resolveMidiDevice: resolveMidi.input,
      resolveMidiOutputDevice: resolveMidi.output,
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
    // The lists of currently-connected inputs AND outputs (id + name) for
    // resolution — input-type nodes resolve against inputs, midiOutBuddy
    // against outputs. This ALSO performs the one-time requestMIDIAccess
    // (gated behind the load gesture). On denial / unsupported we bail.
    let connectedIns: ConnectedMidiInput[];
    let connectedOuts: ConnectedMidiInput[];
    try {
      type Dev = { name?: string | null };
      const nav = navigator as unknown as {
        requestMIDIAccess?: (o?: unknown) => Promise<{ inputs: Map<string, Dev>; outputs: Map<string, Dev> }>;
      };
      if (typeof nav.requestMIDIAccess !== 'function') return; // Web MIDI unsupported
      const access = await nav.requestMIDIAccess({ sysex: false });
      connectedIns = [...access.inputs].map(([id, inp]) => ({ id, name: inp.name ?? id }));
      connectedOuts = [...access.outputs].map(([id, out]) => ({ id, name: out.name ?? id }));
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
      if (!node) continue;
      const isOutputType = (MIDI_OUTPUT_DEVICE_NODE_TYPES as readonly string[]).includes(node.type);
      if (!isOutputType && !(MIDI_DEVICE_NODE_TYPES as readonly string[]).includes(node.type)) continue;
      const connected = isOutputType ? connectedOuts : connectedIns;
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
  let slotBusy = $state(false);

  /** Refresh the whole bar's red/green state from IndexedDB. */
  async function refreshSlotOccupancy(): Promise<void> {
    slotOccupied = await listOccupied();
  }


  /** Load (or Replace) a slot from a picked performance .zip → store in IDB. */
  async function loadIntoSlot(index: number): Promise<void> {
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

  /** WORKFLOW File..→Quicksave N: store the CURRENT rack into slot N —
   *  the same perf-zip bytes Export Perf produces, into the same IndexedDB
   *  slot store Save set / Load set bundle (pure recomposition — the slot
   *  store itself is unchanged). Replaces the slot's contents when
   *  already occupied (mirrors "Replace with…" semantics, minus the file
   *  picker). */
  async function quicksaveSlot(index: number): Promise<void> {
    error = null;
    if (slotBusy) return;
    slotBusy = true;
    try {
      // A quicksave taken mid-knob-twist must capture the settled value.
      flushAllCcCommits();
      const bytes = await buildPerformanceZipBytes();
      await putSlot(index, bytes, `quicksave-${index + 1}`);
      slotOccupied[index] = true;
      trace(`slot ${index + 1}: quicksaved current rack (${(bytes.length / 1024).toFixed(0)} KB)`);
    } catch (e) {
      error = `Quicksave ${index + 1} failed: ${e instanceof Error ? e.message : String(e)}`;
      trace(`quicksave ${index + 1} failed: ${String(e)}`);
    } finally {
      slotBusy = false;
    }
  }

  /** Clear a slot back to empty (red). */
  async function clearSlot(index: number): Promise<void> {
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

  /** The def a leg-group plan reads for a node, through the SAME three-registry
   *  lookup the commit paths validate with. Audio defs are where nearly all
   *  stereo pairs live, but not all: `videobox` / `videovarispeed` carry
   *  audio-typed `audio_l`/`audio_r` OUTPUTS on VIDEO defs, and those are real
   *  stereo cables. Pairing is audio-typed-ports-only inside stereo-pairs, so a
   *  video-typed L/R pair still resolves to nothing here. */
  function stereoDefForNode(nodeId: string): StereoDef | undefined {
    const n = patch.nodes[nodeId];
    return n ? (defLookup(n.type) as StereoDef | undefined) : undefined;
  }

  /** Detach whatever cable is seated on an INPUT patch point — WHOLE LEG GROUPS
   *  included. The one-motion rewire (grab a patched input, drag it elsewhere)
   *  fires this; without the expansion the user picks up T.inL, leaves T.inR
   *  still fed by the old source, and re-patches half a stereo cable onto a new
   *  one. Runs its own LOCAL_ORIGIN transact; returns the number of edges gone. */
  function detachInputLegGroup(nodeId: string, portId: string): number {
    const seeds: string[] = [];
    for (const [edgeId, edge] of Object.entries(patch.edges)) {
      if (edge && edge.target.nodeId === nodeId && edge.target.portId === portId) {
        seeds.push(edge.id ?? edgeId);
      }
    }
    if (seeds.length === 0) return 0;
    const ids = expandLegGroups(seeds, patch.edges, stereoDefForNode);
    let removed = 0;
    ydoc.transact(() => {
      for (const id of ids) {
        if (!patch.edges[id]) continue;
        delete patch.edges[id];
        removed++;
      }
    }, LOCAL_ORIGIN);
    return removed;
  }

  /** THE ONE audio commit writer. Every hand-made cable — drag, carry, picker —
   *  lands here, and it writes the whole LEG GROUP the planner returns rather
   *  than a single edge plus an optional sibling.
   *
   *  The policy is `$lib/graph/stereo-autowire`'s and is stated there in full;
   *  the part worth repeating at the call site is that a STEREO source into a
   *  MONO input writes BOTH legs (dual-mono, owner 2026-08-07) — it is not a
   *  sum and not a single leg, and there is no runtime check anywhere asking
   *  whether the two legs "are really the same signal".
   *
   *  Occupancy is LEG-LEVEL (Q4): the plan evicts exactly the edges seated on
   *  the input ports it writes to, so a full-stereo patch replaces both legs of
   *  the target while an only-L patch replaces only the L leg.
   *
   *  MUST be called INSIDE a ydoc.transact so the whole group lands atomically —
   *  one CRDT update, one undo entry, no frame where half a cable exists. */
  function writeAudioLegGroup(
    from: { nodeId: string; portId: string },
    to: { nodeId: string; portId: string },
    sourceType: CableType,
    targetType: CableType,
    channelMode: ChannelMode = 'both',
  ): void {
    const plan = planAudioCommit({
      fromNodeId: from.nodeId,
      fromPortId: from.portId,
      fromDef: stereoDefForNode(from.nodeId),
      toNodeId: to.nodeId,
      toPortId: to.portId,
      toDef: stereoDefForNode(to.nodeId),
      edges: patch.edges,
      sourceType,
      targetType,
      channelMode,
    });
    for (const id of plan.replaceEdgeIds) {
      if (patch.edges[id]) delete patch.edges[id];
    }
    const wrote: string[] = [];
    for (const leg of plan.legs) {
      if (patch.edges[leg.id]) continue;
      patch.edges[leg.id] = {
        id: leg.id,
        source: { nodeId: from.nodeId, portId: leg.fromPortId },
        target: { nodeId: to.nodeId, portId: leg.toPortId },
        sourceType: leg.sourceType,
        targetType: leg.targetType,
      };
      wrote.push(`${leg.channel[0]}:${leg.fromPortId}→${leg.toPortId}`);
    }
    if (wrote.length > 1) {
      trace(`leg-group ${from.nodeId}→${to.nodeId} [${wrote.join(', ')}]`);
    }
  }

  // ---------------- THE WIDTH-MISMATCH CHOOSER ----------------
  //
  // OWNER, 2026-08-12: "whenever we drop a mono source on a stereo jack or a
  // stereo source on a mono jack … we prompt a quick dialog asking which of the
  // 2 or both L/R to connect to, and then in the case of stereo → mono ask
  // which channel we want."
  //
  // ⚠ THIS SUPERSEDES THE SILENT DOUBLE-PATCH and does not coexist with it.
  // `planAudioCommit` still knows how to write every row of the matrix —
  // `channelMode` is untouched, and it is what the dialog drives — but on a
  // USER GESTURE the mode for those two rows now comes from a person. There is
  // no preference, no "remember my choice", and no path that still guesses.
  //
  // EVERY hand-made cable goes through `commitAudioCable`, which is the ONLY
  // caller of `writeAudioLegGroup` for the three gesture paths (drag, carry,
  // picker). Programmatic writers — the AI driver, the matrix mixer, the
  // workflow column autowire — call the PLANNER directly and are deliberately
  // unaffected: a batch that stopped to ask a question would deadlock.
  let dropChoiceOpen = $state(false);
  let dropChoicePos = $state({ x: 0, y: 0 });
  let dropChoice = $state<DropChoice | null>(null);
  let dropChoicePending = $state<{
    from: { nodeId: string; portId: string };
    to: { nodeId: string; portId: string };
    sourceType: CableType;
    targetType: CableType;
    title: string;
  } | null>(null);

  /** "<MODULE> <PORT> → <MODULE> <PORT>", through the SAME label resolver the
   *  patch panel rows use, so the dialog cannot name a jack differently from
   *  the card the user is looking at. */
  function cableTitle(
    from: { nodeId: string; portId: string },
    to: { nodeId: string; portId: string },
  ): string {
    const name = (nodeId: string) => {
      const n = patch.nodes[nodeId];
      return n ? (defLookup(n.type)?.label ?? n.type) : nodeId;
    };
    return (
      `${name(from.nodeId)} ${resolveVerboseLabel({ id: from.portId })}` +
      ` → ${name(to.nodeId)} ${resolveVerboseLabel({ id: to.portId })}`
    );
  }

  /**
   * THE ONE gesture-driven audio commit. Asks first when the drop's two ends
   * disagree about width; writes immediately when they do not.
   *
   * `channelMode` is the caller's EXPLICIT choice — the picker's "patch only L"
   * rows, or a per-leg target row. Pass it and no question is asked, because
   * one already was. Pass `undefined` (every drop gesture) and this decides.
   *
   * ⚠ It must NOT be called inside a `ydoc.transact`: on the ambiguous rows it
   * returns having written nothing and opened a dialog, and the commit happens
   * later from `resolveDropChoice` in its own transact.
   */
  function commitAudioCable(
    from: { nodeId: string; portId: string },
    to: { nodeId: string; portId: string },
    sourceType: CableType,
    targetType: CableType,
    channelMode?: ChannelMode,
  ): boolean {
    if (channelMode === undefined) {
      const choice = planDropChoice({
        fromNodeId: from.nodeId,
        fromPortId: from.portId,
        fromDef: stereoDefForNode(from.nodeId),
        toNodeId: to.nodeId,
        toPortId: to.portId,
        toDef: stereoDefForNode(to.nodeId),
        edges: patch.edges,
        sourceType,
        targetType,
      });
      if (choice) {
        dropChoice = choice;
        dropChoicePending = { from, to, sourceType, targetType, title: cableTitle(from, to) };
        dropChoicePos = { x: lastPointer.x, y: lastPointer.y };
        dropChoiceOpen = true;
        trace(
          `width mismatch ${from.nodeId}.${from.portId} → ${to.nodeId}.${to.portId}` +
            ` (${choice.kind}) — asking`,
        );
        return false;
      }
    }
    ydoc.transact(() => {
      writeAudioLegGroup(from, to, sourceType, targetType, channelMode ?? 'both');
    }, LOCAL_ORIGIN);
    return true;
  }

  /** The user picked a side. RE-PLANS from the live edge set rather than
   *  replaying the plan the dialog was built from — a collaborator may have
   *  patched that jack while the menu was open, and committing a stale
   *  `replaceEdgeIds` would delete an edge nobody warned them about.
   *
   *  ⚠ It passes `mode` EXPLICITLY, which is what stops the re-plan from
   *  re-opening the dialog it was just dismissed from. */
  function resolveDropChoice(mode: ChannelMode): void {
    const pending = dropChoicePending;
    closeDropChoice();
    if (!pending) return;
    commitAudioCable(pending.from, pending.to, pending.sourceType, pending.targetType, mode);
    trace(
      `drop-choice ${mode} ${pending.from.nodeId}.${pending.from.portId}` +
        ` → ${pending.to.nodeId}.${pending.to.portId}`,
    );
  }

  /** Escape / negative space — the PATCH IS ABANDONED. Dismissing the question
   *  must not fall back to a default, or the silent double-patch is back with
   *  one extra keystroke in front of it. */
  function closeDropChoice(): void {
    dropChoiceOpen = false;
    dropChoice = null;
    dropChoicePending = null;
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

    const id = audioEdgeId(
      connection.source,
      connection.sourceHandle,
      connection.target,
      connection.targetHandle,
    );
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

    // ONE writer: the chooser seam, then leg-group plan + LEG-LEVEL occupancy
    // eviction + every leg, atomically. (The eviction that used to live inline
    // here — "delete every edge targeting the same input" — is now the
    // planner's replaceEdgeIds, scoped to the input ports THIS plan writes to.)
    // No explicit channelMode: a native drag names a HOLE, never a side, so
    // this is exactly the gesture the width question is for.
    const wrote = commitAudioCable(
      { nodeId: connection.source!, portId: connection.sourceHandle! },
      { nodeId: connection.target!, portId: connection.targetHandle! },
      sourceType,
      targetType,
    );
    // Only trace a CONNECT when one was made. A width-mismatched drop has
    // written nothing yet — it traced "asking" — and a trace ring that says
    // `connect` for a cable that does not exist is worse than no trace.
    if (wrote) {
      trace(`connect ${connection.source}.${connection.sourceHandle} → ${connection.target}.${connection.targetHandle}`);
    }
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
    const removed = detachInputLegGroup(params.nodeId, params.handleId);
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
    // A directly-clicked INPUT handle while a VIRTUAL carry is in flight
    // COMMITS the carry to that input (parity with the PatchPanel-row
    // commit) instead of clobbering it with a fresh pickup. xyflow's own
    // click-connect (which just started internally) is cancelled so the
    // next handle click starts clean.
    const virtual = connectDragState.pickupVirtual;
    if (virtual && params.handleType === 'target') {
      const to = { nodeId: params.nodeId, portId: params.handleId };
      connectDragState.discard();
      connectDragState.endCascade();
      flowApi?.cancelClickConnect();
      void (async () => {
        const resolved = await virtual.resolve();
        if (!resolved) return;
        commitCarriedEdge(resolved, to);
      })();
      return;
    }
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
      const removed = detachInputLegGroup(params.nodeId, params.handleId);
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

  /** Svelte Flow deleted nodes/edges (Backspace on selection). Mirror to patch.
   *
   *  ⚠ The payload names the edges xyflow rendered. A STEREO cable is a LEG
   *  GROUP of two ordinary edges, and PR-4 dedupes those into ONE rendered
   *  cable — so deleting the payload verbatim would leave the other leg behind
   *  as a dangling half-cable with no affordance to remove it. `expandLegGroups`
   *  widens the id set to the whole group; the wcol detach-suppression then runs
   *  over the EXPANDED set, or the reconciler would re-add the sibling leg on
   *  its next pass. */
  function handleDelete(payload: { nodes: FlowNode[]; edges: FlowEdge[] }) {
    if (payload.nodes.length === 0 && payload.edges.length === 0) return;
    const edgeIds = expandLegGroups(
      payload.edges.map((e) => e.id),
      patch.edges,
      stereoDefForNode,
    );
    ydoc.transact(() => {
      for (const id of edgeIds) {
        const live = patch.edges[id];
        // MAJOR 1: an EXPLICIT user deletion of a managed (wcol-) cable durably
        // suppresses it (+ its stereo/control-pair siblings via the reconcile's
        // all-or-nothing yield) until the next deliberate column edit.
        if (live && id.startsWith('wcol-e-')) {
          const colKey = wcolEdgeColumnKey(live);
          if (colKey) wcolMarkDetached(id, colKey);
        }
        if (live) delete patch.edges[id];
      }
      for (const n of payload.nodes) {
        // Pinned drawer singletons never render as flow nodes, so they
        // can't be in a SvelteFlow delete payload — but guard anyway (the
        // shared delete discipline: pinned nodes are undeletable).
        if (isPinnedNode(patch.nodes[n.id])) continue;
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
    // DOCKING P2.5a: an EXPLICIT local delete hard-drops dock entries AND
    // tombstones (the one signal retirement must never revive from).
    noteDockDeletes(payload.nodes.map((n) => n.id));
    trace(`deleted ${payload.nodes.length} node(s), ${payload.edges.length} edge(s)`);
  }

  /** Hard-drop dock state for explicitly deleted nodes (+ toast when a
   *  docked card just vanished from a rail). */
  function noteDockDeletes(nodeIds: string[]): void {
    if (nodeIds.length === 0) return;
    const wasDocked = dockStore.noteExplicitDelete(nodeIds);
    for (const id of wasDocked) {
      showDockToast(`${id} was deleted — removed from its dock`);
    }
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

    // WORKFLOW CHANNEL COLUMNS: a drag RE-TARGETS membership + order. Because a
    // member's position is DERIVED from its array index (position = render
    // output), we update the ORDER array — not the free position — so a reorder
    // snaps to list order and a cross-column drag re-assigns the channel. A drag
    // OUT of every band unassigns (retract membership → the reconcile prunes its
    // wcol edges). Non-member drags fall through to the normal position write.
    if (patch.nodes[WCOL_MIXER_ID]) {
      const stillMember = new Set<string>();
      const laneReassign: { id: string; ch: number }[] = [];
      ydoc.transact(() => {
        for (const n of moved) {
          const node = patch.nodes[n.id];
          if (!node || isPinnedNode(node) || n.id === WCOL_MIXER_ID || n.id === WCOL_CLIP_ID) continue;
          // VIDEO cards belong to the video zone, never an audio channel. The
          // Y gate below already excludes the video zone (it sits BELOW the
          // baseline), but a video card dragged up INTO a lane band must still
          // be refused — the video zone owns it wherever it is parked.
          if (node.domain === 'video') continue;
          const d = node.data as { channel?: number; sendSlot?: number } | undefined;
          const oldCh = typeof d?.channel === 'number' ? d.channel : null;
          const oldSlot = typeof d?.sendSlot === 'number' ? d.sendSlot : null;
          // Drop center uses the dragged card's OWN flush height (matches the
          // flush layout the sibling centers are computed against).
          const dropCenterY = n.position.y + wcolCardHeightPx(node.type) / 2;
          // Hit-test the DROP against the ACTIVE pitch and the LIVE lane top:
          // under `?shell=1` the lanes render at the narrow pitch and grow
          // upward with the tallest stack, so the resolved column/send (a
          // persisted MEMBERSHIP scalar, never a position) must match what the
          // user visually dropped on. POSITION DECIDES MEMBERSHIP: a drop
          // outside the painted band in EITHER axis is `null` → unassigned.
          //
          // The Y probe is the card's CENTER, not its top edge, so "is the card
          // in the lane" survives the boundary: in legacy mode a full stack's
          // top tile sits with its top edge EXACTLY on laneTopY, and a top-edge
          // test would unassign it on a 1px nudge during an in-lane reorder.
          // (X stays the top-left, unchanged — the columns are wider than the
          // cards, and re-anchoring X would re-target existing side-of-band
          // drops.)
          const band = laneTargetForFlowPoint(
            { x: n.position.x, y: dropCenterY },
            wcolLaneTopY,
            wcolPitch,
          );
          if (typeof band === 'number') {
            if (oldCh === band) {
              // Reorder within the same column: index from the drop Y, against
              // the siblings' FLUSH slot centers.
              const order = wcolOrder('columns', band);
              const sibs = order.filter((id) => id !== n.id);
              const sibH = sibs.map((id) => wcolCardHeightPx(patch.nodes[id]?.type ?? ''));
              // Anchor-aware: under `?shell=1` the rendered stack bottoms sit
              // the badge clearance above the baseline, so the reorder centers
              // must live in the SAME lifted frame as the drop Y (preview OFF
              // passes the baseline → byte-identical). X is unused here.
              const sibPos = columnFlushPositions(band, sibH, undefined, wcolPitch, wcolStackAnchorY);
              const centers = sibPos.map((p, i) => p.y + sibH[i]! / 2);
              setWcolOrder('columns', band, reorder(order, n.id, indexForDropY(centers, dropCenterY)));
              wcolClearDetached(String(band));
            } else {
              // Move into column `band` from another column / send / free canvas.
              if (oldCh != null) { setWcolOrder('columns', oldCh, removeFrom(wcolOrder('columns', oldCh), n.id)); wcolClearDetached(String(oldCh)); }
              if (oldSlot != null) { setWcolOrder('sends', oldSlot, removeFrom(wcolOrder('sends', oldSlot), n.id)); wcolClearDetached('s' + oldSlot); }
              // Cross-column move: drop any carried head flag so it can't win head
              // in `band` via a sort race (re-promoted only if band is headless).
              wcolResetHead(n.id);
              setWcolMembership(n.id, band, null);
              setWcolOrder('columns', band, insertBottom(wcolOrder('columns', band), n.id));
              wcolClearDetached(String(band));
              laneReassign.push({ id: n.id, ch: band });
            }
            stillMember.add(n.id);
          } else if (band === 'send') {
            const slot = sendBoxForFlowX(n.position.x, wcolPitch);
            if (oldSlot === slot) {
              const order = wcolOrder('sends', slot);
              const sibs = order.filter((id) => id !== n.id);
              const sibH = sibs.map((id) => wcolCardHeightPx(patch.nodes[id]?.type ?? ''));
              // Anchor-aware like the column reorder above (send-box twin).
              const sibPos = sendFlushPositions(slot, sibH, undefined, wcolPitch, wcolStackAnchorY);
              const centers = sibPos.map((p, i) => p.y + sibH[i]! / 2);
              setWcolOrder('sends', slot, reorder(order, n.id, indexForDropY(centers, dropCenterY)));
              wcolClearDetached('s' + slot);
            } else {
              if (oldCh != null) { setWcolOrder('columns', oldCh, removeFrom(wcolOrder('columns', oldCh), n.id)); wcolClearDetached(String(oldCh)); }
              if (oldSlot != null) { setWcolOrder('sends', oldSlot, removeFrom(wcolOrder('sends', oldSlot), n.id)); wcolClearDetached('s' + oldSlot); }
              // Into a send box → no longer a column source: drop the head flag.
              if (oldCh != null) wcolResetHead(n.id);
              setWcolMembership(n.id, null, slot);
              setWcolOrder('sends', slot, insertBottom(wcolOrder('sends', slot), n.id));
              wcolClearDetached('s' + slot);
            }
            stillMember.add(n.id);
          } else {
            // Dragged OUT to free canvas → unassign. Fall through to the position
            // write below so the card stays where it was dropped.
            if (oldCh != null) { setWcolOrder('columns', oldCh, removeFrom(wcolOrder('columns', oldCh), n.id)); wcolClearDetached(String(oldCh)); }
            if (oldSlot != null) { setWcolOrder('sends', oldSlot, removeFrom(wcolOrder('sends', oldSlot), n.id)); wcolClearDetached('s' + oldSlot); }
            // Left every column → drop the head flag (was a column source).
            if (oldCh != null) wcolResetHead(n.id);
            if (oldCh != null || oldSlot != null) setWcolMembership(n.id, null, null);
          }
        }
      }, LOCAL_ORIGIN);
      // A cross-column move re-assigns the automation lane to the new channel.
      for (const { id, ch } of laneReassign) {
        const clip = wcolCanonClip();
        if (clip) assignAutomationLane(clip, id, ch - 1);
      }
      // Position writes ONLY for nodes NOT held as column/send members (theirs
      // is derived from the array). Members that stayed members get no write.
      const freeMoved = moved.filter((n) => !stillMember.has(n.id));
      if (freeMoved.length) writeMovedPositions(freeMoved);
      return;
    }

    writeMovedPositions(moved);
  }

  /** Persist dragged node positions through the dual-path (per-user layout map in
   *  multiplayer, shared node.position single-user) — the pre-workflow behavior. */
  function writeMovedPositions(moved: FlowNode[]): void {
    ydoc.transact(() => {
      for (const n of moved) {
        if (currentUserId) {
          setNodePosition(ydoc, currentUserId, n.id, { x: n.position.x, y: n.position.y });
        } else {
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
  // "Annotate" entry. MODULE_DOCS is the generated authored-docs registry (a build artifact).
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

  // DOCKING P2.5a — context-menu gating. "Dock to …" appears ONLY for
  // allowlisted types in workflow racks (owner Q3: control-first + scope,
  // workflow only); a right-clicked DockStubCard gets "Undock" instead.
  let ctxMenuDocked = $derived.by<boolean>(() => {
    if (!ctxMenuNodeId) return false;
    return dockStore.isDocked(ctxMenuNodeId);
  });
  let ctxMenuDockable = $derived.by<boolean>(() => {
    if (!ctxMenuNodeId || ctxMenuDocked) return false;
    const n = patch.nodes[ctxMenuNodeId];
    return !!n && !isPinnedNode(n as ModuleNode) && isDockableType(n.type);
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

  // WORKFLOW "Assign to channel N" (the three separate right-clicks folded into
  // ONE channel-indexed action). The CANONICAL clip-player + mixmstrs (lowest
  // node id — the deterministic tie-break the assignment reads use) are the
  // targets: channel N means automation lane N + clip channel N (both on the
  // canonical clip-player) + mixer channel N (on the canonical mixmstrs).
  let ctxMenuCanonClipPlayer = $derived.by<string | null>(() => {
    void snapshot;
    return listClipPlayers(patch.nodes).sort()[0] ?? null;
  });
  let ctxMenuCanonMixer = $derived.by<string | null>(() => {
    void snapshot;
    const mid = ctxMenuNodeId;
    const mixers = Object.entries(patch.nodes)
      .filter(([nid, node]) => node?.type === 'mixmstrs' && nid !== mid)
      .map(([nid]) => nid)
      .sort();
    return mixers[0] ?? null;
  });

  // The per-channel COLOURS (length = 8) of the canonical clip-player — each
  // channel button is tinted by its colour, which IS the automation-lane colour
  // (the per-channel clip colour). Empty ⇒ the whole assignment section is
  // hidden (no clip-player in the rack to hold the automation assignment).
  // Not offered for groups, clip-players themselves, or dock stubs.
  let ctxMenuChannelColors = $derived.by<string[]>(() => {
    void snapshot;
    const mid = ctxMenuNodeId;
    if (!mid) return [];
    const n = patch.nodes[mid];
    if (!n || n.type === 'group' || n.type === 'clipplayer') return [];
    const player = ctxMenuCanonClipPlayer;
    if (!player) return [];
    const data = patch.nodes[player]?.data as AutoClipPlayerData | undefined;
    return Array.from({ length: AUTO_CLIP_LANES }, (_, lane) => autoLaneColorEff(data, lane));
  });
  // THIS module's current automation lane (0-based) on ANY clip-player (lowest
  // id wins), or null — drives the ✓ + "Remove automation assignment".
  let ctxMenuAssignedChannel = $derived.by<number | null>(() => {
    void snapshot;
    const mid = ctxMenuNodeId;
    if (!mid) return null;
    return automationAssignmentFor(patch.nodes, mid)?.lane ?? null;
  });
  // Whether "Assign to channel N" will ALSO wire clip-control / send-to-mixer —
  // computed procedurally from the port def (no allow-list). Gate the mixer part
  // on a mixmstrs existing so the hint is truthful.
  let ctxMenuClipEligible = $derived.by<boolean>(() => {
    void snapshot;
    const mid = ctxMenuNodeId;
    const n = mid ? patch.nodes[mid] : undefined;
    if (!n || n.type === 'group') return false;
    const def = defLookup(n.type);
    return !!def && isClipEligible(def);
  });
  let ctxMenuMixerEligible = $derived.by<boolean>(() => {
    void snapshot;
    const mid = ctxMenuNodeId;
    const n = mid ? patch.nodes[mid] : undefined;
    if (!n || n.type === 'group' || !ctxMenuCanonMixer) return false;
    const def = defLookup(n.type);
    return !!def && isMixerEligible(def);
  });

  /** Write a set of pre-planned, node-qualified convenience edges in ONE undo
   *  step. Each edge carries its own source/target node ids (so clip-control and
   *  send-to-mixer edges — different node pairs — batch into one transaction).
   *  Types are re-resolved from the live defs (honouring exposed ports); an edge
   *  already present on a target port is replaced (occupancy). Unlike
   *  commitCarriedEdge this does NOT auto-fire writeStereoSiblingEdge — the plan
   *  is already explicit (mono→mixer emits both L and R itself). */
  /** ⚠ LEG GROUPS: this writer does NOT call `writeAudioLegGroup`, and that is
   *  deliberate. Its input is already a COMPLETE plan from `planSendToMixer` /
   *  `planClipControl`, which enumerate both legs themselves (a mono source
   *  fills ch{n}L AND ch{n}R; a stereo source maps L→L, R→R) over the module's
   *  MAIN pair rather than a clicked port. Running each planned edge back
   *  through the per-port planner would re-derive siblings that are already in
   *  the list. The two planners implement ONE matrix and are cross-checked
   *  against each other in patch-convenience-columns.test.ts ("agrees with
   *  planAudioCommit on all four rows"), which is what stops them drifting. */
  function commitConvenienceEdges(
    edges: Array<{ sourceNodeId: string; fromPortId: string; targetNodeId: string; toPortId: string }>,
  ): void {
    const planned = edges
      .map(({ sourceNodeId, fromPortId, targetNodeId, toPortId }): Edge | null => {
        const srcNode = patch.nodes[sourceNodeId];
        const dstNode = patch.nodes[targetNodeId];
        if (!srcNode || !dstNode) return null;
        const srcDef = defLookup(srcNode.type);
        const dstDef = defLookup(dstNode.type);
        if (!srcDef || !dstDef) return null;
        const srcExposed = resolveExposedPort(srcNode, fromPortId);
        const dstExposed = resolveExposedPort(dstNode, toPortId);
        const srcPort = srcDef.outputs.find((p) => p.id === fromPortId);
        const dstPort = dstDef.inputs.find((p) => p.id === toPortId);
        const sourceType: CableType = srcExposed?.cableType ?? srcPort?.type ?? 'audio';
        const targetType: CableType = dstExposed?.cableType ?? dstPort?.type ?? sourceType;
        const id = `e-${sourceNodeId}-${fromPortId}-${targetNodeId}-${toPortId}`;
        return {
          id,
          source: { nodeId: sourceNodeId, portId: fromPortId },
          target: { nodeId: targetNodeId, portId: toPortId },
          sourceType,
          targetType,
        };
      })
      .filter((edge): edge is Edge => edge !== null)
      .filter((edge) =>
        validateEdge(edge, Object.values(patch.nodes) as ModuleNode[], defLookup).ok,
      );
    if (planned.length === 0) return;
    ydoc.transact(() => {
      for (const edge of planned) {
        // Replace any existing edge on this target port (single owner).
        for (const [edgeId, existing] of Object.entries(patch.edges)) {
          if (
            existing &&
            existing.target.nodeId === edge.target.nodeId &&
            existing.target.portId === edge.target.portId
          ) {
            delete patch.edges[edgeId];
          }
        }
        patch.edges[edge.id] = edge;
      }
    }, LOCAL_ORIGIN);
  }

  /** Qualify a per-plan edge list (fromPortId/toPortId) with a fixed
   *  source→target node pair, for commitConvenienceEdges. */
  function qualifyPlan(
    plan: Array<{ fromPortId: string; toPortId: string }>,
    sourceNodeId: string,
    targetNodeId: string,
  ): Array<{ sourceNodeId: string; fromPortId: string; targetNodeId: string; toPortId: string }> {
    return plan.map(({ fromPortId, toPortId }) => ({ sourceNodeId, fromPortId, targetNodeId, toPortId }));
  }

  /** Unified "Assign to channel N" (0-based): (a) assign this module to
   *  automation lane N — ALWAYS (its existing synced write / own undo step); (b)
   *  if the module is a clip target, wire the canonical clip-player's channel N
   *  into it; (c) if it has a main audio out and a mixmstrs is present, send its
   *  out → the canonical mixer's channel N. Whatever the module can't accept is
   *  skipped (graceful subset). The two wiring plans land in ONE undo step. */
  function commitAssignToChannel(channel: number): void {
    const mid = ctxMenuNodeId;
    if (!mid) return;
    const node = patch.nodes[mid];
    const def = node && defLookup(node.type);
    if (!def) return;

    // WORKFLOW CHANNEL COLUMNS: when the pinned column system is active, "Assign
    // to channel N" means COLUMN MEMBERSHIP (channel scalar + order append), and
    // the reconciler owns ALL wiring — clip-control on sources, source→DSP
    // splicing on adjacent members, the tail's single send-to-mixer, and stale-
    // edge GC. Committing flat send-to-mixer edges here (the else-branch below)
    // would double a SECOND module straight into the same mixer channel instead
    // of splicing it through the first (owner bug: tidyvco + cloudseed on ch1
    // both reached the mixer, no tidyvco→cloudseed link). Route through the same
    // membership path the palette-drop uses so both gestures converge.
    if (patch.nodes[WCOL_MIXER_ID]) {
      const ch = channel + 1; // column channels are 1-based; lanes are 0-based
      ydoc.transact(() => {
        const d = node.data as { channel?: number; sendSlot?: number } | undefined;
        const oldCh = typeof d?.channel === 'number' ? d.channel : null;
        const oldSlot = typeof d?.sendSlot === 'number' ? d.sendSlot : null;
        if (oldCh != null && oldCh !== ch) {
          setWcolOrder('columns', oldCh, removeFrom(wcolOrder('columns', oldCh), mid));
          wcolClearDetached(String(oldCh));
          // Reassigned to a DIFFERENT column: drop any carried head flag so it
          // can't win head in the destination via a sort race.
          wcolResetHead(mid);
        }
        if (oldSlot != null) {
          setWcolOrder('sends', oldSlot, removeFrom(wcolOrder('sends', oldSlot), mid));
          wcolClearDetached('s' + oldSlot);
        }
        setWcolMembership(mid, ch, null);
        setWcolOrder('columns', ch, insertBottom(wcolOrder('columns', ch), mid));
        wcolClearDetached(String(ch));
      }, LOCAL_ORIGIN);
      // Bind the automation lane immediately (the reconciler's lane heal also
      // covers this, but do it here so the menu feedback is instant).
      const clip = wcolCanonClip();
      if (clip) assignAutomationLane(clip, mid, channel);
      // Reconcile now so the wcol edge set (splice + GC) settles synchronously,
      // not only on the next graph-change effect tick.
      reconcileColumns(wcolResolveDef);
      return;
    }

    const player = ctxMenuCanonClipPlayer;
    const mixer = ctxMenuCanonMixer;
    // (a) automation — always (needs a clip-player to hold the assignment).
    if (player) assignAutomationLane(player, mid, channel);
    // (b)+(c) clip-control (player → module) + send-to-mixer (module → mixer),
    // combined into ONE convenience-edge transaction (plan is 1-based).
    const wiring: Array<{ sourceNodeId: string; fromPortId: string; targetNodeId: string; toPortId: string }> = [];
    if (player) {
      const clip = planClipControl(def, channel + 1);
      if (clip) wiring.push(...qualifyPlan(clip, player, mid));
    }
    if (mixer) {
      const send = planSendToMixer(def, channel + 1);
      if (send) wiring.push(...qualifyPlan(send, mid, mixer));
    }
    if (wiring.length) commitConvenienceEdges(wiring);
  }

  /** "Assign automation only ▸ N" (0-based) — assign ONLY automation lane N (no
   *  clip/mixer wiring), so several modules can share one automation lane. */
  function commitAssignAutomationOnly(channel: number): void {
    const mid = ctxMenuNodeId;
    if (!mid) return;
    const player = ctxMenuCanonClipPlayer;
    if (player) assignAutomationLane(player, mid, channel);
  }

  // MULTI-SURFACE JANITOR (control-surface discipline): when a module is
  // deleted, drop its automation-lane assignment from EVERY clip-player; when
  // a merge race (or a legacy pre-scrub duplicate) leaves the same module
  // claimed twice, keep the LOWEST player id's claim. Runs from the
  // graph-change seam, so it works even when no clipplayer CARD is mounted
  // (docked / off-screen). Both are JANITOR writes (AUTO_JANITOR_ORIGIN —
  // never undo-tracked, so a peer-driven cleanup can't plant phantom undo
  // items) and no-ops (no transaction) when the graph is clean.
  $effect(() => {
    void snapshot; // re-run on any graph change (node deletes included)
    pruneAllAutoAssignDangling();
    repairDuplicateAutoAssign();
    // CV BUDDY → ES-9 janitor: wire each CV Buddy's note/transport outputs to
    // the single ES-9 node's jacks per the slot allocator + write the per-jack
    // classes; reset freed jacks to audio on unclaim. Idempotent + inert when
    // there is no ES-9 (lazy resolve). Same graph-change seam as the janitors
    // above. (NOTE: #1147 also edits this file on another branch — a merge
    // conflict here at integration is expected; this edit is intentionally
    // minimal + localized.)
    reconcileCvBuddyEs9();
  });

  // WORKFLOW CHANNEL-COLUMNS reconcile janitor — workflow racks only. On any
  // graph change: heal the column/send membership ORDER arrays against each
  // member's data.channel/sendSlot truth, then re-derive the reconciler-owned
  // wcol- edge set (clip-control on the source, chain links on adjacent pairs,
  // send-to-mixer on the tail). Idempotent + non-undo-tracked (AUTO_JANITOR_
  // ORIGIN inside the reconciler), so it self-heals on every peer without ever
  // fighting a hand-drawn cable (wcol- namespace + yield rule).
  const wcolResolveDef: ColumnDefResolver = (t) => defLookup(t) as never;
  $effect(() => {
    void snapshot; // re-run on any graph change
    reconcileColumns(wcolResolveDef);
  });

  // ---------------- Workflow channel-columns: membership writes ----------------

  /** The pinned mixer's order arrays live at pinned-mixmstrs.data.columns /
   *  .sends. Read one (or empty). */
  function wcolOrder(kind: 'columns' | 'sends', key: number): string[] {
    const m = patch.nodes[WCOL_MIXER_ID];
    const map = (m?.data as { columns?: Record<string, string[]>; sends?: Record<string, string[]> } | undefined)?.[kind];
    return map?.[String(key)] ?? [];
  }

  /** Write ONE column/send order array (single-key in-place) on the pinned
   *  mixer — never a whole-map rebuild. Caller wraps in a transact. */
  function setWcolOrder(kind: 'columns' | 'sends', key: number, ids: string[]): void {
    const live = patch.nodes[WCOL_MIXER_ID];
    if (!live) return;
    if (!live.data) live.data = {};
    const d = live.data as { columns?: Record<string, string[]>; sends?: Record<string, string[]> };
    if (!d[kind]) d[kind] = {};
    d[kind]![String(key)] = ids;
  }

  /** Set/clear a member node's channel/sendSlot membership scalar (the CRDT-safe
   *  membership truth). Caller wraps in a transact. */
  function setWcolMembership(nodeId: string, channel: number | null, sendSlot: number | null): void {
    const live = patch.nodes[nodeId];
    if (!live) return;
    if (!live.data) live.data = {};
    const d = live.data as { channel?: number; sendSlot?: number };
    // Guard every delete with an existence check — a SyncedStore proxy THROWS on
    // `delete` of a missing key (deleteProperty trap returns false), which would
    // abort the whole drag transact (the drag-into-column "drop" was dead
    // because a free node has no sendSlot to delete).
    if (channel != null) d.channel = channel;
    else if ('channel' in d) delete d.channel;
    if (sendSlot != null) d.sendSlot = sendSlot;
    else if ('sendSlot' in d) delete d.sendSlot;
  }

  /** CROSS-MOVE AIRTIGHTEN (round-3 follow-up): reset a node's persisted
   *  `data.isColumnHead` head flag when it LEAVES its column (moved to a
   *  DIFFERENT column, to a send, or out to free canvas). Otherwise a node that
   *  was the head of column A carries `isColumnHead: true` into column B and can
   *  win the head there via a resolveColumnHead sort race before the head-heal
   *  re-classifies it. Cleared → it arrives `undefined` (fresh) and is promoted
   *  ONLY if the destination column is headless. Guarded delete (a SyncedStore
   *  proxy throws on delete of a missing key). Caller wraps in a transact. */
  function wcolResetHead(nodeId: string): void {
    const live = patch.nodes[nodeId];
    if (!live?.data) return;
    const d = live.data as { isColumnHead?: boolean };
    if ('isColumnHead' in d) delete d.isColumnHead;
  }

  /** The canonical clip-player that holds column automation lanes (the pinned
   *  one in a workflow rack; else the lowest clip-player id). */
  function wcolCanonClip(): string | null {
    if (patch.nodes[WCOL_CLIP_ID]) return WCOL_CLIP_ID;
    return listClipPlayers(patch.nodes).sort()[0] ?? null;
  }

  // MAJOR 1 — durable manual override: a user-deleted managed (wcol-) cable must
  // NOT snap back. We record the deleted edge id in a per-column suppression set
  // on the pinned mixer (data.wcolDetached), which the reconcile respects, and
  // clear that column's set on the next deliberate column edit (re-manage).

  /** The column/send key a wcol- edge belongs to — from its member endpoint's
   *  channel/sendSlot scalar. '1'..'8' for a column, 's1'/'s2' for a send. */
  function wcolEdgeColumnKey(edge: Edge): string | null {
    for (const ep of [edge.source.nodeId, edge.target.nodeId]) {
      const d = patch.nodes[ep]?.data as { channel?: number; sendSlot?: number } | undefined;
      if (typeof d?.channel === 'number') return String(d.channel);
      if (typeof d?.sendSlot === 'number') return 's' + d.sendSlot;
    }
    return null;
  }

  /** Record a user-detached wcol- edge id under its column key (dedup). Caller
   *  wraps in a LOCAL_ORIGIN transact (durable + undoable with the delete). */
  function wcolMarkDetached(edgeId: string, colKey: string): void {
    const mixer = patch.nodes[WCOL_MIXER_ID];
    if (!mixer) return;
    if (!mixer.data) mixer.data = {};
    const d = mixer.data as { wcolDetached?: Record<string, string[]> };
    if (!d.wcolDetached) d.wcolDetached = {};
    const cur = d.wcolDetached[colKey] ?? [];
    if (!cur.includes(edgeId)) d.wcolDetached[colKey] = [...cur, edgeId];
  }

  /** Clear a column/send key's detach suppression — a fresh structural edit of
   *  that column re-manages all its links. Caller wraps in a transact. */
  function wcolClearDetached(colKey: string): void {
    const mixer = patch.nodes[WCOL_MIXER_ID];
    const d = mixer?.data as { wcolDetached?: Record<string, string[]> } | undefined;
    if (d?.wcolDetached && (d.wcolDetached[colKey]?.length ?? 0) > 0) d.wcolDetached[colKey] = [];
  }

  /** Owner north-star "it just works": when the FIRST FX lands in a send box,
   *  a correctly-patched send loop is still SILENT (every ch{i}_send{n} defaults
   *  to 0). Auto-raise the send amount to a modest 0.5 on each channel that
   *  currently HAS a column member, so the loop is audible immediately. Only
   *  bumps channels still at 0 (never overrides a user-set amount). */
  function wcolAutoRaiseSend(slot: number): void {
    const mixer = patch.nodes[WCOL_MIXER_ID];
    if (!mixer) return;
    for (let ch = 1; ch <= COLUMN_COUNT; ch++) {
      if (wcolOrder('columns', ch).length === 0) continue;
      const pid = `ch${ch}_send${slot}`;
      const cur = mixer.params?.[pid] ?? 0;
      if (cur <= 0) setNodeParam(WCOL_MIXER_ID, pid, 0.5);
    }
  }

  /**
   * Compute the workflow-column drop target for a spawn at `flowPos`, or null
   * when the drop is on free canvas (outside the painted lane band in EITHER
   * axis) or not a workflow rack.
   *
   * POSITION DECIDES MEMBERSHIP: the hit-test point is the CURSOR (which is
   * also the new card's top-left — the spawn is anchored under the cursor), and
   * it must land inside the band the user can actually see. This used to be an
   * X-ONLY test, which made the lanes infinitely tall: an LFO added "on the
   * grid" well above the lanes, or in the video zone below the baseline, joined
   * whichever channel shared its X and was teleported into that stack.
   */
  function wcolDropTarget(
    flowPos: { x: number; y: number },
  ): { channel?: number; sendSlot?: number } | null {
    if (!patch.nodes[WCOL_MIXER_ID]) return null;
    // Resolve against the ACTIVE pitch (narrow under `?shell=1`) and the LIVE
    // lane top: the spawn flow-pos comes from the cursor's screen→flow
    // projection over the RENDERED (narrowed, grown-upward) lanes, so the band
    // it lands in is a pitch- AND height-relative hit-test.
    const band = laneTargetForFlowPoint(flowPos, wcolLaneTopY, wcolPitch);
    if (typeof band === 'number') return { channel: band };
    if (band === 'send') return { sendSlot: sendBoxForFlowX(flowPos.x, wcolPitch) };
    return null;
  }

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
    noteDockDeletes([groupId, ...childIds]); // explicit delete → hard-drop dock state
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
  // ---- "patch only L" / "patch only R" (owner Q5) ----
  //
  // Which legs the NEXT commit out of this picker writes. It feeds
  // `planAudioCommit`'s `channelMode`, which has existed on the planner since
  // PR-3 with tests but no UI — this is the wire, not a new mechanism. Reset to
  // 'both' every time the picker opens, so a one-off only-L can never leak into
  // the next patch the user makes.
  let portMenuChannelMode = $state<ChannelMode>('both');
  /** The source port's DERIVED stereo pair, or null when there is no stereo
   *  image to take a side of — the rows are hidden then.
   *
   *  ⚠ COLLAPSE list, not the wiring one. "Only L / only R" is a claim about a
   *  jack the UI presents as ONE stereo signal; `rings`' odd/even taps are
   *  COLLAPSE_EXEMPT (two timbres, two jacks) and are correctly excluded — the
   *  rows would be mislabelled for them. Outputs only: the picker's INPUT
   *  direction is the one-motion rewire, where the user is choosing a source
   *  and the image is the source's to split. */
  let portMenuStereoPair = $derived.by(() => {
    void snapshot;
    if (!portMenuOpen || !portMenuSourceNodeId || !portMenuSourcePortId) return null;
    if (portMenuSourceDirection !== 'output') return null;
    const def = stereoDefForNode(portMenuSourceNodeId);
    if (!def) return null;
    return stereoPairForPort(def, portMenuSourcePortId, 'output');
  });
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
    portMenuChannelMode = 'both'; // a fresh picker always starts full-stereo
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

  /** Resolve a node's CARD bounding rect from the DOM. DOCK-HOSTED cards
   *  first: a docked/pinned card's real FACE lives in a rail or topbar
   *  panel (DockCardHost's [data-dock-card-frame]) while its only
   *  .svelte-flow__node element — if any — is the small canvas stub.
   *  Menus for a dock-hosted card must anchor to the face the user
   *  actually clicked: the pinned drawer occupants have NO canvas element
   *  at all, so the old stub-only lookup returned null and the patch-to
   *  picker fell back to a stale (0,0) → "menu spawns at the top-left of
   *  the screen" (owner report 2026-07-11). Canvas cards resolve exactly
   *  as before (no dock frame exists for them). Returns null when the
   *  card isn't mounted anywhere. */
  function cardRectFor(nodeId: string): DOMRect | null {
    if (typeof document === 'undefined') return null;
    const dockFrame = document.querySelector(
      `[data-dock-card="${CSS.escape(nodeId)}"] [data-dock-card-frame]`,
    ) as HTMLElement | null;
    if (dockFrame) return dockFrame.getBoundingClientRect();
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
    portMenuChannelMode = 'both'; // a fresh picker always starts full-stereo
    portMenuOpen = true;
    // POST-MOUNT viewport clamp: edgeAlignedMenuPos can only estimate the
    // picker's size before it renders (width 200, height unknown), so a
    // card near the BOTTOM edge — a dock-drawer card is the canonical case
    // — would open the picker spilling off-screen. One rAF later the real
    // chrome is measurable: slide it fully on-screen (the picker owns its
    // own overflow, max-height 70vh).
    requestAnimationFrame(() => {
      if (!portMenuOpen) return;
      const el = document.querySelector('[data-testid="port-context-menu"]') as HTMLElement | null;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const margin = 4;
      const x = Math.max(margin, Math.min(portMenuPos.x, window.innerWidth - r.width - margin));
      const y = Math.max(margin, Math.min(portMenuPos.y, window.innerHeight - r.height - margin));
      if (x !== portMenuPos.x || y !== portMenuPos.y) portMenuPos = { x, y };
    });
    connectDragState.beginCascade(info.nodeId);
  }

  // ---------------- Right-click → UNPATCH (every patch point) --------------
  //
  // Owner report: "there's no way to break a patch right now if i put six strum
  // in a lane and then want to unpatch poly." A cable is only a selectable
  // object on the free-rack EDGE LAYER; the workflow lanes and the flip-side
  // jack fields (legacy back panel + the dock full-view / flip-key RearCard)
  // render patch POINTS, not cables — so an auto-wired lane link had NO removal
  // affordance at all. Every jack field now dispatches a bubbling
  // `patchpanel:jackcontextmenu` for a PATCHED point and Canvas owns the ONE
  // menu + the ONE removal, so the behaviour is identical in every view.
  //
  // The removal REUSES the existing edge-delete seam VERBATIM — the same
  // LOCAL_ORIGIN `delete patch.edges[id]` transact handleDelete (Backspace)
  // runs, including the MAJOR-1 wcol detach suppression — so undo/redo
  // (the LOCAL_ORIGIN-tracked UndoManager) and multiplayer convergence are
  // INHERITED rather than re-implemented, and a reconciler-owned lane cable
  // stays gone instead of snapping straight back on the next reconcile pass.
  let unpatchOpen = $state(false);
  let unpatchPos = $state({ x: 0, y: 0 });
  let unpatchTarget = $state<UnpatchTarget | null>(null);

  let unpatchPlan = $derived.by<UnpatchPlan>(() => {
    void snapshot;
    const t = unpatchTarget;
    if (!unpatchOpen || !t) return { title: '', items: [], allLabel: null };
    return buildUnpatchPlan(patch.edges, patch.nodes, defLookup, t);
  });

  // A peer (or a reconcile) removing the last cable under an OPEN menu leaves
  // it empty — close rather than strand a menu with nothing to act on.
  $effect(() => {
    if (unpatchOpen && unpatchPlan.items.length === 0) closeUnpatchMenu();
  });

  /**
   * "Patch to…" on the UNPATCH menu — hand a PATCHED output straight to the
   * patch picker so a second cable can leave the same jack.
   *
   * Right-clicking a patched point opens the unpatch menu and returns (see
   * `PatchPanel.onPortRowContextMenu`), so before this an output with one cable
   * had no right-click route to another one — even though outputs fan out
   * freely (the owner's `masterL` drives three targets, and his two aux sends
   * leave ONE collapsed `SEND1` jack for two different ES-9 outputs).
   *
   * It reuses `openPortMenuAt`, the SAME entry point the unpatched right-click
   * uses, so the picker that appears is identical either way — including the
   * channel rows and the per-leg target drill-down.
   */
  function patchToFromUnpatch(): void {
    const t = unpatchTarget;
    const pos = unpatchPos;
    if (!t) return;
    const node = patch.nodes[t.nodeId];
    const def = node ? defLookup(node.type) : undefined;
    const port =
      t.direction === 'output'
        ? def?.outputs.find((p) => p.id === t.portId)
        : def?.inputs.find((p) => p.id === t.portId);
    closeUnpatchMenu();
    openPortMenuAt(
      { x: pos.x, y: pos.y },
      {
        nodeId: t.nodeId,
        portId: t.portId,
        direction: t.direction,
        type: (port?.type as string | undefined) ?? 'audio',
      },
    );
    connectDragState.beginCascade(t.nodeId);
  }

  function closeUnpatchMenu(): void {
    unpatchOpen = false;
    unpatchTarget = null;
  }

  // ---------------- Stereo jack EXPAND / COLLAPSE ----------------
  //
  // "right-click any stereo port and expand it to 2 L/R ports" (owner,
  // 2026-08-10). A collapsed jack is the right default — one cable, one
  // gesture, both legs — but it hides the two legs the def declares, so on
  // MIXMSTRS (where every audio rail is a pair) not one of the 26 legs had a
  // hole of its own to aim at, and a landed cable's side was unreadable.
  //
  // ONE ACTION, THREE ENTRY POINTS, because right-click is already claimed on
  // two of the three states a jack can be in:
  //   * UNPATCHED INPUT  → StereoExpandMenu (nothing opened here before);
  //   * PATCHED anything → UnpatchMenu grew an expand row;
  //   * UNPATCHED OUTPUT → the patch picker grew the same row.
  // All three call `applyStereoExpand`, so the gesture reads identically
  // wherever the user right-clicks and there is one place to change it.
  let stereoExpandOpen = $state(false);
  let stereoExpandPos = $state({ x: 0, y: 0 });
  let stereoExpandTarget = $state<{
    nodeId: string;
    portId: string;
    direction: 'input' | 'output';
  } | null>(null);

  /** The pair a jack belongs to on an OPTED-IN module, or null — the single
   *  predicate every expand entry point asks, so a row can never appear on a
   *  jack the action would then refuse. */
  function expandablePairAt(
    nodeId: string,
    portId: string,
    direction: 'input' | 'output',
  ): { left: string; right: string } | null {
    const node = patch.nodes[nodeId];
    if (!node || !isExpandableStereoJackModule(node.type)) return null;
    const def = defLookup(node.type) as StereoPairDefLike | undefined;
    if (!def) return null;
    const pair = stereoPairForPort(def, portId, direction);
    return pair ? { left: pair.left, right: pair.right } : null;
  }

  /** Is the jack under `(nodeId, portId, direction)` currently expanded? */
  function isExpandedAt(
    nodeId: string,
    portId: string,
    direction: 'input' | 'output',
  ): boolean {
    const pair = expandablePairAt(nodeId, portId, direction);
    return pair ? isJackExpanded(nodeId, direction, pair.left) : false;
  }

  /** Flip one jack. VIEW STATE ONLY — no edge is written, moved or removed, so
   *  this deliberately does NOT go through a Y.Doc transact or the undo stack
   *  (see `stereo-jack-expansion` for why per-viewer is the right scope). */
  function applyStereoExpand(
    nodeId: string,
    portId: string,
    direction: 'input' | 'output',
    value: boolean,
  ): void {
    const pair = expandablePairAt(nodeId, portId, direction);
    if (!pair) return;
    setJackExpanded(nodeId, direction, pair.left, value);
  }

  /** Header + the two leg labels for the standalone menu. The labels come from
   *  `resolveVerboseLabel` — the SAME resolver the rows themselves use — so the
   *  menu cannot promise a label the panel then renders differently. */
  let stereoExpandView = $derived.by(() => {
    const t = stereoExpandTarget;
    if (!stereoExpandOpen || !t) {
      return { title: '', expanded: false, legLabels: ['L', 'R'] as [string, string] };
    }
    const pair = expandablePairAt(t.nodeId, t.portId, t.direction);
    if (!pair) return { title: '', expanded: false, legLabels: ['L', 'R'] as [string, string] };
    const node = patch.nodes[t.nodeId];
    const label = node ? (defLookup(node.type)?.label ?? node.type) : '';
    return {
      title: `${label} ${resolveVerboseLabel({ id: pair.left })}`.trim(),
      expanded: isJackExpanded(t.nodeId, t.direction, pair.left),
      legLabels: [
        resolveVerboseLabel({ id: pair.left }),
        resolveVerboseLabel({ id: pair.right }),
      ] as [string, string],
    };
  });

  function closeStereoExpandMenu(): void {
    stereoExpandOpen = false;
    stereoExpandTarget = null;
  }

  /** "expand / collapse" picked from the UNPATCH menu. */
  function expandFromUnpatch(): void {
    const t = unpatchTarget;
    if (!t) return;
    applyStereoExpand(t.nodeId, t.portId, t.direction, !isExpandedAt(t.nodeId, t.portId, t.direction));
    closeUnpatchMenu();
  }

  /** "expand / collapse" picked from the PATCH PICKER (an unpatched output). */
  function expandFromPortMenu(): void {
    const nodeId = portMenuSourceNodeId;
    const portId = portMenuSourcePortId;
    if (!nodeId || !portId) return;
    applyStereoExpand(nodeId, portId, 'output', !isExpandedAt(nodeId, portId, 'output'));
    portMenuOpen = false;
  }

  /** Delete edges through the SHARED removal seam. Identical to handleDelete's
   *  edge branch: one LOCAL_ORIGIN transact (undoable + synced), with the
   *  managed-cable detach suppression so a user-removed wcol- lane link is not
   *  re-added by the next column reconcile — and the SAME leg-group expansion,
   *  so the seam removes whole cables no matter which id reached it. (The menu
   *  already hands over full groups; expanding again is idempotent and keeps
   *  the guarantee a property of the SEAM rather than of one caller.) */
  function unpatchEdges(seedEdgeIds: string[]): void {
    if (seedEdgeIds.length === 0) return;
    const edgeIds = expandLegGroups(seedEdgeIds, patch.edges, stereoDefForNode);
    let removed = 0;
    ydoc.transact(() => {
      for (const id of edgeIds) {
        const live = patch.edges[id];
        if (!live) continue;
        if (id.startsWith('wcol-e-')) {
          const colKey = wcolEdgeColumnKey(live);
          if (colKey) wcolMarkDetached(id, colKey);
        }
        delete patch.edges[id];
        removed++;
      }
    }, LOCAL_ORIGIN);
    if (removed > 0) trace(`unpatched ${removed} cable(s) via patch-point menu`);
  }

  /**
   * Change a LIVE cable's stereo mode from the unpatch menu (owner: right-click
   * an output and the option is there, patched or not).
   *
   * SEMANTICS: narrowing to L/R-only DROPS the other leg rather than muting it.
   * The leg-group model treats legs as real edges, and a muted-but-present edge
   * is invisible state — the class this repo keeps getting bitten by. Widening
   * back to `both` re-derives the missing leg, so the round trip is lossless.
   *
   * It goes through `planAudioCommit`'s existing `channelMode` so there is ONE
   * commit seam, and it plans from the SEED leg's own endpoints rather than
   * canonicalising to `pair.left` — that preserves a deliberate CROSS patch
   * (out_l→in_r), which canonicalising would silently straighten.
   *
   * ⚠ The plan's own `replaceEdgeIds` cannot do this job: it only evicts edges
   * seated on the input ports the plan WRITES, and the leg being dropped sits on
   * the OTHER input port. So the group's unwanted legs are deleted explicitly.
   */
  function setLegGroupChannelMode(seedEdgeId: string, mode: ChannelMode): void {
    const seed = patch.edges[seedEdgeId];
    if (!seed?.source || !seed?.target) return;
    const from = { nodeId: seed.source.nodeId, portId: seed.source.portId };
    const to = { nodeId: seed.target.nodeId, portId: seed.target.portId };
    const srcNode = patch.nodes[from.nodeId];
    const dstNode = patch.nodes[to.nodeId];
    if (!srcNode || !dstNode) return;
    const srcDef = defLookup(srcNode.type);
    const dstDef = defLookup(dstNode.type);
    const sourceType: CableType =
      (srcDef?.outputs.find((p) => p.id === from.portId)?.type as CableType) ?? 'audio';
    const targetType: CableType =
      (dstDef?.inputs.find((p) => p.id === to.portId)?.type as CableType) ?? sourceType;

    const groupIds = [seedEdgeId, ...siblingLegIds(seed, patch.edges, stereoDefForNode)];
    const plan = planAudioCommit({
      fromNodeId: from.nodeId,
      fromPortId: from.portId,
      fromDef: stereoDefForNode(from.nodeId),
      toNodeId: to.nodeId,
      toPortId: to.portId,
      toDef: stereoDefForNode(to.nodeId),
      edges: patch.edges,
      sourceType,
      targetType,
      channelMode: mode,
    });
    if (plan.legs.length === 0) return; // nothing committable — change nothing
    const wanted = new Set(plan.legs.map((l) => l.id));
    ydoc.transact(() => {
      for (const id of groupIds) {
        if (wanted.has(id)) continue;
        const live = patch.edges[id];
        if (!live) continue;
        // A user-driven narrowing of a MANAGED (wcol-) cable must durably
        // suppress the dropped leg, or the next column reconcile re-adds it and
        // the mode silently reverts — the same detach-suppression the unpatch
        // and Backspace paths run.
        if (id.startsWith('wcol-e-')) {
          const colKey = wcolEdgeColumnKey(live);
          if (colKey) wcolMarkDetached(id, colKey);
        }
        delete patch.edges[id];
      }
      for (const leg of plan.legs) {
        if (patch.edges[leg.id]) continue;
        patch.edges[leg.id] = {
          id: leg.id,
          source: { nodeId: from.nodeId, portId: leg.fromPortId },
          target: { nodeId: to.nodeId, portId: leg.toPortId },
          sourceType: leg.sourceType,
          targetType: leg.targetType,
        };
      }
    }, LOCAL_ORIGIN);
    trace(`channel mode ${mode} on ${from.nodeId}.${from.portId} → ${to.nodeId}.${to.portId}`);
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
        detachInputLegGroup(detail.nodeId, detail.portId);
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
      // `pos` is an OPTIONAL screen-space anchor: the workflow topbar
      // surfaces patch out of canvas-HIDDEN pinned nodes (no card rect to
      // edge-align to), so they pass the clicked menu row's coordinates
      // and edgeAlignedMenuPos falls back to them.
      const detail = (e as CustomEvent).detail as
        | { nodeId: string; pos?: { x: number; y: number } }
        | null;
      if (!detail) return;
      if (connectDragState.mode !== 'pickup') return;
      // Hide the dangling cable; retain the carry/source state for commit.
      connectDragState.hideCableForPicker();
      if (!portMenuSourceNodeId || !portMenuSourcePortId) return;
      const pos = edgeAlignedMenuPos(
        portMenuSourceNodeId,
        carrySide,
        detail.pos ?? portMenuPos,
      );
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
      // VIRTUAL-PORT carry (workflow assets picker — P3 primitive): the
      // source port doesn't exist yet. Resolve it NOW (creating/reusing
      // the asset's module), then run the SAME validated commit path.
      // Only an INPUT row can terminate a virtual carry (the resolved
      // source is always an output); anything else discards silently,
      // mirroring the invalid-commit rule.
      const virtual = connectDragState.pickupVirtual;
      if (virtual) {
        connectDragState.discard();
        connectDragState.endCascade();
        if (detail.direction !== 'input') {
          trace('virtual carry-commit reject: target row is not an input');
          return;
        }
        void (async () => {
          const resolved = await virtual.resolve();
          if (!resolved) return; // creation refused/failed — silent
          commitCarriedEdge(resolved, { nodeId: detail.nodeId, portId: detail.portId });
        })();
        return;
      }
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
    const onJackContextMenu = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { nodeId: string; portId: string; direction: 'input' | 'output'; x: number; y: number }
        | null;
      if (!detail) return;
      // A right-click never carries a cable — drop any in-flight carry so the
      // menu can't act on a half-finished gesture.
      if (connectDragState.mode === 'pickup') {
        connectDragState.discard();
        connectDragState.endCascade();
      }
      unpatchTarget = { nodeId: detail.nodeId, portId: detail.portId, direction: detail.direction };
      unpatchPos = { x: detail.x, y: detail.y };
      unpatchOpen = true;
    };
    // RIGHT-CLICK AN UNPATCHED STEREO OUTPUT → the patch-to picker with the
    // "patch only L / only R" rows. PatchPanel's port rows and back-panel jacks
    // dispatch this; the PATCHED case never reaches here (it claims the event
    // for the unpatch menu first), so the two right-click behaviours cannot
    // fight. Raw-handle cards (video/game) already reach the same picker
    // through the document-level handle contextmenu, so the rows appear there
    // too with no extra wiring — pairing is derived, not declared per card.
    const onPortMenu = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { nodeId: string; portId: string; direction: 'input' | 'output'; x: number; y: number }
        | null;
      if (!detail) return;
      if (connectDragState.mode === 'pickup') {
        connectDragState.discard();
        connectDragState.endCascade();
      }
      const node = patch.nodes[detail.nodeId];
      const def = node ? defLookup(node.type) : undefined;
      const port =
        detail.direction === 'output'
          ? def?.outputs.find((p) => p.id === detail.portId)
          : def?.inputs.find((p) => p.id === detail.portId);
      openPortMenuAt(
        { x: detail.x, y: detail.y },
        {
          nodeId: detail.nodeId,
          portId: detail.portId,
          direction: detail.direction,
          type: (port?.type as string | undefined) ?? 'audio',
        },
      );
      // Keep the invoking PatchPanel open underneath the picker (its
      // outside-click dismissal treats an engaged cascade as "inside").
      connectDragState.beginCascade(detail.nodeId);
      trace(`port menu opened for ${detail.nodeId}.${detail.portId}`);
    };
    document.addEventListener('patchpanel:jackclick', onJackClick);
    document.addEventListener('patchpanel:patchto', onPatchTo);
    document.addEventListener('patchpanel:carrycommit', onCarryCommit);
    // RIGHT-CLICK AN UNPATCHED STEREO INPUT on an opted-in module → the
    // expand/collapse menu. This is the ONE jack right-click that previously
    // fell through to the browser's own menu, which is why the owner's
    // "right-click any stereo port" gesture appeared to do nothing on the
    // MIXMSTRS channel and return inputs specifically. The patched and output
    // cases claim the event before it reaches here, so nothing fights.
    const onStereoExpand = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { nodeId: string; portId: string; direction: 'input' | 'output'; x: number; y: number }
        | null;
      if (!detail) return;
      if (connectDragState.mode === 'pickup') {
        connectDragState.discard();
        connectDragState.endCascade();
      }
      stereoExpandTarget = {
        nodeId: detail.nodeId,
        portId: detail.portId,
        direction: detail.direction,
      };
      stereoExpandPos = { x: detail.x, y: detail.y };
      stereoExpandOpen = true;
    };
    document.addEventListener('patchpanel:jackcontextmenu', onJackContextMenu);
    document.addEventListener('patchpanel:portmenu', onPortMenu);
    document.addEventListener('patchpanel:stereoexpand', onStereoExpand);
    return () => {
      document.removeEventListener('patchpanel:jackclick', onJackClick);
      document.removeEventListener('patchpanel:patchto', onPatchTo);
      document.removeEventListener('patchpanel:carrycommit', onCarryCommit);
      document.removeEventListener('patchpanel:jackcontextmenu', onJackContextMenu);
      document.removeEventListener('patchpanel:portmenu', onPortMenu);
      document.removeEventListener('patchpanel:stereoexpand', onStereoExpand);
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
    const id = audioEdgeId(from.nodeId, from.portId, to.nodeId, to.portId);
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
    // Same seam as the drag path: a carried cable clicked onto a port ROW names
    // a hole, not a side, so a width mismatch asks before it writes.
    if (commitAudioCable(from, to, sourceType, targetType)) {
      trace(`carry-commit ${from.nodeId}.${from.portId} → ${to.nodeId}.${to.portId}`);
    }
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

  function pickPortMenuTarget({
    nodeId,
    portId,
    leg,
    stereo,
  }: {
    nodeId: string;
    portId: string;
    leg?: 'left' | 'right';
    stereo?: boolean;
  }) {
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

    // The channel the user picked, snapshotted BEFORE the menu closes.
    //
    // TWO surfaces set it, and they are ONE control — "which side of the stereo
    // image does this patch carry?" — reachable from whichever end has the
    // image:
    //   * `leg` — the user picked a PER-LEG row of a collapsed stereo TARGET
    //     ("RET1 L"). This is the only per-side gesture available when the
    //     SOURCE is mono, which is the ES-9 return case (`es9.in14` → `ret1L`
    //     alone), and it WINS: it is a choice made about this specific target,
    //     after and more specifically than the source-side rows.
    //   * `portMenuChannelMode` — the picker's source-side "patch only L / only
    //     R" rows, meaningful only when the SOURCE really has a stereo image.
    //     A stale 'left' on an unpaired port would filter nothing
    //     (planAudioCommit never filters a `mono` leg) but reading the pair
    //     here keeps the trace honest.
    //
    //   * `stereo` — the user picked the WHOLE-PAIR row of a collapsed stereo
    //     target. That row exists BECAUSE the target is a pair and sits between
    //     its own "L" and "R" rows, so clicking it is a deliberate "both" about
    //     this target — the very question the width chooser asks. The picker
    //     already IS the chooser for mono → stereo, and re-asking would be a
    //     second dialog for a question the user just answered.
    //
    // ⚠ `undefined` means "the user has NOT said", and that is a THIRD state,
    // not a synonym for 'both'. It is what routes the pick into the width
    // chooser, and it is why `stereo` has to travel with the pick: an ordinary
    // MONO target row and a collapsed pair row both arrive with `leg`
    // undefined, and only one of them is an answer.
    //
    // A stereo SOURCE into a MONO target still asks, because the picker's
    // source-side rows render before a target is chosen and 'both' — dual-mono
    // — is no longer a legal outcome there.
    const explicitMode: ChannelMode | undefined =
      leg ??
      (portMenuStereoPair && portMenuChannelMode !== 'both' ? portMenuChannelMode : undefined) ??
      (stereo ? 'both' : undefined);
    const channelMode: ChannelMode = explicitMode ?? 'both';

    const id = audioEdgeId(from.nodeId, from.portId, to.nodeId, to.portId);
    // The already-exists short-circuit is about the CLICKED leg, so it only
    // speaks for a full-stereo commit. An only-R patch writes a DIFFERENT edge
    // id, and bailing on the L leg's presence would silently refuse it —
    // exactly the "nothing happened" bug. writeAudioLegGroup already skips any
    // leg that exists, so the single-channel paths need no guard here.
    if (channelMode === 'both' && patch.edges[id]) {
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
    if (commitAudioCable(from, to, sourceType, targetType, explicitMode)) {
      trace(
        `patch-to ${from.nodeId}.${from.portId} → ${to.nodeId}.${to.portId}` +
          (channelMode === 'both' ? '' : ` (only ${channelMode === 'left' ? 'L' : 'R'})`),
      );
    }
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
    // Shared delete primitive (graph/mutate.ts): removes the node + every
    // touching edge in one undoable transact, and REFUSES pinned workflow
    // singletons (node-level data.pinned — the M/E/C drawer trio).
    if (!removePatchNode(nodeId)) {
      if (target) trace(`delete refused: ${nodeId} (${target.type}) is pinned`);
      return;
    }
    // No defensive flow* sync needed: snapshot bus + one-way prop (B3).
    if (topNodeId === nodeId) topNodeId = null;
    clearAnnotate(nodeId); // drop any personal annotate-mode state for this node
    noteDockDeletes([nodeId]); // explicit delete → hard-drop dock entry/tombstone
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
    // A duplicated CLIP PLAYER copies content (clips, recorded automation,
    // settings, the arrangement) but never LIVE-PERFORMANCE state: playing/
    // queued sets, arranger + KEYS record arms, the per-lane automation arms
    // (a clone born armed with the source's recorderId would double-record),
    // and autoAssign (one lane per module is a GLOBAL invariant — a copied
    // claim would double-drive; the janitor repair also enforces this).
    if (dup.type === 'clipplayer') scrubClipPlayerTransientData(dup.data);
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

    // WORKFLOW CHANNEL COLUMNS: a drop inside a column / send band joins that
    // channel's DSP chain (or aux-send loop). Stamp the membership scalar, place
    // at the deterministic column slot, and SUPPRESS the cable-splice (in-band
    // drops order by the column array, never by proximity-splice — the two
    // splice paths must not both fire on one drop).
    // Video cards live in the video zone, not an audio channel — refused here
    // whatever the cursor is over (the video zone's own band sits BELOW the
    // baseline, which wcolDropTarget already excludes, but a video card spawned
    // with the cursor inside a lane must still stay out of the chain).
    const wcolDrop = type === 'cadillac' || domain === 'video' ? null : wcolDropTarget(spawnFlowPos);
    // Was the target send box empty BEFORE this drop? (First-FX auto-raise.)
    const wcolSendWasEmpty = wcolDrop?.sendSlot != null && wcolOrder('sends', wcolDrop.sendSlot).length === 0;
    if (wcolDrop?.channel != null) {
      initialData.channel = wcolDrop.channel;
      // Snap FLUSH onto the TOP of the column (newest member stacks up; the
      // first-added member stays anchored at the bottom); the flowNodes
      // derivation re-stacks the whole column flush next render.
      const existing = wcolOrder('columns', wcolDrop.channel);
      const heights = [...existing.map((id) => wcolCardHeightPx(patch.nodes[id]?.type ?? '')), wcolCardHeightPx(type)];
      const widths = [...existing.map((id) => wcolCardWidthPx(patch.nodes[id]?.type ?? '')), wcolCardWidthPx(type)];
      // PERSIST at the ACTIVE column pitch (narrow under `?shell=1`, COLUMN_W off)
      // so the spawned tile's persisted X matches the RENDER override's X — else,
      // under the preview, the node briefly renders at the WIDE 765px slot (far
      // right of the tight lane, "lands off-lane") for the frame before the
      // pitch-aware render override snaps it in. Preview OFF passes COLUMN_W →
      // byte-identical persisted position.
      // …and at the ACTIVE stack anchor (the badge-clearance lift under
      // `?shell=1`) for the same reason: persisted Y == the render override's Y.
      const p = columnFlushPositions(wcolDrop.channel, heights, widths, wcolPitch, wcolStackAnchorY)[existing.length]!;
      pos.x = p.x; pos.y = p.y;
    } else if (wcolDrop?.sendSlot != null) {
      initialData.sendSlot = wcolDrop.sendSlot;
      const existing = wcolOrder('sends', wcolDrop.sendSlot);
      const heights = [...existing.map((id) => wcolCardHeightPx(patch.nodes[id]?.type ?? '')), wcolCardHeightPx(type)];
      const widths = [...existing.map((id) => wcolCardWidthPx(patch.nodes[id]?.type ?? '')), wcolCardWidthPx(type)];
      const p = sendFlushPositions(wcolDrop.sendSlot, heights, widths, wcolPitch, wcolStackAnchorY)[existing.length]!;
      pos.x = p.x; pos.y = p.y;
    }

    // Insert-on-cable (Proposal B2): if the cursor is close to an
    // existing cable's midpoint AND the new module has a compatible
    // input + compatible output for the cable's cableType, splice the
    // new card into the cable (delete original, add src→new + new→dst).
    // Falls back to a plain spawn-at-cursor on no match. Suppressed for an
    // in-band workflow-column drop.
    const splice = wcolDrop ? null : tryFindInsertSpliceTarget(spawnFlowPos, def);

    ydoc.transact(() => {
      patch.nodes[id] = {
        id,
        type,
        domain,
        position: pos,
        params: {},
        data: initialData,
      };
      // WORKFLOW: append/insert the new member into the column/send order array
      // in the SAME transact (one undo step with the spawn). A structural edit of
      // the column re-manages its links → clear its detach suppression (MAJOR 1).
      if (wcolDrop?.channel != null) {
        setWcolOrder('columns', wcolDrop.channel, insertBottom(wcolOrder('columns', wcolDrop.channel), id));
        wcolClearDetached(String(wcolDrop.channel));
      } else if (wcolDrop?.sendSlot != null) {
        setWcolOrder('sends', wcolDrop.sendSlot, insertBottom(wcolOrder('sends', wcolDrop.sendSlot), id));
        wcolClearDetached('s' + wcolDrop.sendSlot);
      }
      // ⚠ INSERT-ON-CABLE + LEG GROUPS — a KNOWN GAP, named rather than
      // half-closed. Dropping a module onto a cable splices the ONE leg that
      // was dropped on; the sibling leg keeps running past the new module. That
      // is coherent TODAY, because both legs render as separate cables and the
      // user aimed at one of them. It stops being coherent in PR-4, where the
      // pair renders as a single cable and "insert on this cable" must splice
      // the whole group — which also has to decide WHICH port pair of the
      // inserted module each leg lands on. That belongs with the rendering
      // dedupe, not here. (insert-on-cable.spec.ts pins today's behaviour.)
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
    // WORKFLOW CAMERA REVEAL (P0.3b PRIMARY fix — "add a module → nothing
    // renders"): a column/send member is forced to its deterministic slot, which
    // stacks UPWARD from the baseline — so the newest tile can land ABOVE the
    // current viewport and only "pop in" once the user pans. The reveal decision
    // is made against the CURRENT viewport (spawnRevealViewport, pure):
    //   * tile already fully visible → null → NO camera move at all;
    //   * tile off-screen → the MINIMAL translate that tucks it just inside the
    //     violated edge(s), zoom kept, untouched axes unmoved.
    // The original P0.3b pan re-framed the whole lane (laneCenterViewport →
    // revealMemberViewport) on EVERY add — a 600-750px cross-canvas jump even
    // when the tile was already on screen (or 16px off one edge): the "adding a
    // module scrolls the viewport wildly" bug this replaces.
    if (wcolDrop?.channel != null || wcolDrop?.sendSlot != null) {
      const vp = readWorkflowViewportMetrics();
      const cur = flowApi?.getViewport?.();
      if (vp && flowApi && cur && cur.zoom > 0) {
        const target = spawnRevealViewport(
          { x: cur.x, y: cur.y, zoom: cur.zoom },
          { x: pos.x, y: pos.y, w: wcolCardWidthPx(type), h: wcolCardHeightPx(type) },
          vp,
        );
        if (target) flowApi.setViewport(target, { duration: WCOL_PAN_MS });
      }
    }
    // WORKFLOW: a column member ALSO joins automation lane N (per-module, its own
    // undo step, exactly like Assign-to-channel). Sends carry no automation lane
    // (a pure bus for v1). The reconcile $effect then wires the wcol- edges.
    if (wcolDrop?.channel != null) {
      const clip = wcolCanonClip();
      if (clip) assignAutomationLane(clip, id, wcolDrop.channel - 1);
    } else if (wcolDrop?.sendSlot != null && wcolSendWasEmpty) {
      // First FX into this send box → auto-raise send amount so it's audible.
      wcolAutoRaiseSend(wcolDrop.sendSlot);
    }
    if (splice) {
      trace(`spliced ${type} as ${autoName} (${id}) into edge ${splice.edge.id}`);
    } else if (wcolDrop?.channel != null) {
      trace(`spawned ${type} as ${autoName} (${id}) into workflow column ${wcolDrop.channel}`);
    } else if (wcolDrop?.sendSlot != null) {
      trace(`spawned ${type} as ${autoName} (${id}) into workflow send ${wcolDrop.sendSlot}`);
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
    if (engine) {
      // The engine may have been booted EAGERLY (no user gesture) to render a
      // restored VIDEO rack — see the persisted-rack boot effect below. That
      // boot could not resume the AudioContext (Chrome's autoplay policy needs
      // a gesture), so it starts suspended. Any LATER ensureEngine() call comes
      // from a real user action (spawn / duplicate / load / import), which IS a
      // gesture — resume a still-suspended context now so a mixed audio+video
      // restored rack isn't left silent. Idempotent + harmless when already
      // running or when this call isn't gesture-backed (resume() just no-ops).
      if (audioCtx && audioCtx.state === 'suspended') {
        void audioCtx.resume().catch(() => {});
      }
      return engine;
    }
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

  // ---------------- Video pull-eval: card viewport visibility ----------------
  // Feed each module card's viewport visibility to the VideoEngine so its
  // sink-driven pull evaluation ($lib/video/pull-eval) can stop rendering
  // chains whose previews are panned offscreen. ONE central
  // IntersectionObserver over the SvelteFlow node elements (no per-card
  // wiring); the engine fails OPEN on unknown ids, so this feed is a pure
  // demotion signal and its absence changes nothing.
  $effect(() => {
    const e = engine;
    const root = flowEl;
    if (!e || !root) return;
    let ve: VideoEngine | null = null;
    try {
      ve = e.getDomain<VideoEngine>('video');
    } catch {
      ve = null; // video engine unavailable (no WebGL2) — nothing to feed
    }
    if (!ve) return;
    const engineRef = ve;
    const obs = observeVideoCardVisibility({
      container: root,
      setVisibility: (nodeId, visible) => engineRef.setCardVisibility(nodeId, visible),
    });
    return () => obs.dispose();
  });

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
  //
  // `onMount`, NOT `$effect` — same reasoning as the hook block near the top of
  // this script. Every statement here assigns a function to `globalThis`; the
  // body reads no variable at all outside those closures (`provider` is read at
  // call time inside `__setLocalCursor` / `__getRemoteCursors`), so the effect
  // had no dependencies, and it installs no cleanup because the globals are
  // meant to outlive the component.
  if (testHooksEnabled()) {
    onMount(() => {
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
      // Simulated PUSH 2 for e2e: installs ONE in-memory Push (no Web MIDI
      // prompt), injects it as the Launchpad control surface (single deployment),
      // and binds the clip-player. Pad/CC presses route through the SAME
      // decode/classify/dispatch path real hardware uses, so the real-source-chain
      // spec drives a pad → clip launch → audible RMS, a LANE select → the push
      // card, a display encoder → that card's param, the master encoder →
      // MixMasters, and a D-Pad nav. DEV-only — stripped from prod bundles.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__push2TestInstall = async (clipNodeId: string) => {
        const sim = await installSimulatedPush2AndBind(clipNodeId);
        __test_setDeployment('single', 'grid');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (globalThis as any).__push2Sim = {
          // press/release an 8×8 pad (x = col, y from BOTTOM). Velocity-sensitive:
          // a hard hit is recorded/played at that velocity (defaults to 100).
          press: (x: number, y: number, velocity?: number) => sim.press(x, y, velocity),
          release: (x: number, y: number) => sim.release(x, y),
          // any Push CC (button press/release or an encoder relative tick).
          cc: (cc: number, value: number) => sim.cc(cc, value),
          // probe the parity brain's view/mode state + the Push-local channel.
          // probe the parity brain's view/mode state, the Push-local lane, and
          // the PUSH CARD the 960×160 screen is showing (module + focus +
          // position), so an e2e can assert the SELECTED CARD changed rather
          // than only that a param moved.
          state: () => {
            const card = __push2CardView();
            return {
              ...__launchpadTestMode(),
              selectedChannel: __push2SelectedChannel(),
              pushCard: {
                lane: card.lane,
                moduleType: card.moduleType,
                title: card.title,
                empty: card.empty,
                index: card.index,
                count: card.count,
                focus: __push2FocusedModule(),
                controls: card.strips.filter((s) => s.kind === 'param').map((s) => s.paramId),
              },
            };
          },
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

  // ---------------- Audio health readout (footer) ----------------
  //
  // The app had NO audio-health instrumentation before this: no underrun
  // detector, no jank detector, no worklet-death detector. So "it bogs down and
  // then stops" was indistinguishable from a throttled laptop, a suspended
  // context, or a latched processor. This binds the three new sensors to the
  // footer so the owner can read them without devtools:
  //
  //   underruns / dropout   AudioContext.playbackStats  (Chromium only)
  //   tick p99              scheduler-clock arrival lateness
  //   dead                  latched AudioWorkletProcessors
  //
  // Zero effect on the audio path — one getter read per second.
  const audioHealth = createAudioHealthMonitor();
  $effect(() => {
    audioHealth.bind(audioCtx);
  });
  onMount(() => {
    audioHealth.start();
    return () => audioHealth.stop();
  });

  // The SECOND half of the footer's `lat base/avg ms` readout: mean output-
  // pipeline latency to the speakers.
  //
  // ⚠ `playbackStats.averageLatency` and `AudioContext.outputLatency` are the
  // SAME quantity measured two ways, which is exactly why the two readouts were
  // folded into one field instead of printed side by side. Prefer the
  // playbackStats mean (it is an average over the session rather than an
  // instantaneous read); fall back to `outputLatency` so a Firefox/Safari user
  // keeps the number main already showed them; `—` when neither is available
  // (no context yet, or a null sink — headless Chromium reports outputLatency 0).
  const latAvgLabel = $derived.by(() => {
    const health = audioHealth.health;
    if (health.supported && health.avgLatencyMs > 0) return `${health.avgLatencyMs.toFixed(1)}ms`;
    if (audioCtx && audioCtx.outputLatency > 0) return `${(audioCtx.outputLatency * 1000).toFixed(1)}ms`;
    return '—';
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
      // The bare flip key (Tab — owner ruling #1629) toggles rear view. ONE
      // predicate shared with the dock owner above (workflow-pins.ts
      // `isRackFlipKey`), so the two can never drift onto different keys; it
      // rejects every modifier combo, so Shift-Tab stays native traversal and
      // Cmd/Ctrl/Alt-Tab stay with the OS.
      if (!isRackFlipKey(e)) return false;
      // Typing targets keep native Tab (blur/advance out of the field); this
      // also covers SELECT, which shouldIgnore() above (built for the
      // undo/redo pair) does not.
      if (isTypingTarget(e.target)) return false;
      // SINGLE-OWNER FLIP KEY (double-handler fix): while the dock full-view is
      // OPEN the DOCK owns it — onDockKey (above) flips the full-view panes to
      // their rear cards. Both handlers are plain `window` keydown listeners, so
      // preventDefault in one does NOT stop the other: one keystroke used to
      // toggle BOTH `dockStore.fullViewFlipped` AND this canvas-wide `rearView`.
      // Two independent flip states then PHASE-DIVERGE (flip in the dock, close
      // it, press the flip key on the canvas → the canvas came up already
      // inverted). Guarding on occupancy (not event ordering) makes exactly one
      // handler act per keystroke, whichever listener happens to be registered
      // first. With the full-view CLOSED, the canvas-wide flip is the owner.
      return dockStore.fullViewNodeIds.length === 0;
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
        // Bare Tab flips the rack front↔rear (owner ruling #1629 — the flip
        // gesture deliberately consumes Tab's native focus traversal outside
        // typing targets; the #1599 rebind to `f` was reversed).
        e.preventDefault();
        toggleRearView();
        trace('flip-rack-key');
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Dev-only: expose undoManager so e2e tests can assert state without
  // racing against the captureTimeout debouncer. Gated on testHooksEnabled()
  // so it's present in the preview bundle (VITE_E2E_HOOKS=1) too.
  //
  // Keep it FRESH across a `bindRackspace()` doc swap. `undoManager` is a
  // module-scope `let` export that bindRackspace reassigns (a NEW manager for
  // the new doc; the old one is destroyed) — and Svelte 5 does NOT re-run this
  // $effect on that reassignment. store.ts's dev-hook refresh re-points
  // __patch / __ydoc but NOT __undoManager. The /rack scratch canvas now calls
  // bindRackspace for local persistence, so without this re-point
  // window.__undoManager stayed on the DESTROYED mount-time manager while edits
  // accrued on the new one — e2e reads of __undoManager.undoStack / .undo()
  // then hit a dead manager (undo appears to no-op; matrixmix undo specs went
  // red). Re-point through onBindRackspace, exactly like the doc-swap seam
  // above and the snapshot bus. undoManager is reassigned BEFORE the bind
  // listeners fire, and the named import is a live binding, so reading it here
  // yields the fresh manager regardless of mount-effect ordering.
  if (testHooksEnabled()) {
    $effect(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__undoManager = undoManager;
      const offBind = onBindRackspace(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (globalThis as any).__undoManager = undoManager;
      });
      return () => offBind();
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
  <!-- THE topbar: the File.. menu. There is no second one — the old
       full-width slot bar + actions cluster was deleted with the second
       shell, and every action it carried lives in this menu (see
       WorkflowTopbar.svelte). -->
  <WorkflowTopbar
    {appVersion}
    {slotOccupied}
    {slotBusy}
    perfBusy={perfZipBusy}
    hasNodes={nodeCount > 0}
    newRackBusy={newRackBusy}
    onNewRack={newRack}
    onQuicksave={quicksaveSlot}
    onQuickload={loadSlot}
    onSavePerformance={exportPerformanceZip}
    onLoadPerformance={loadPerformanceZip}
    onExportJson={exportPatchJson}
    onImportJson={importPatchJson}
    onClear={clearPatch}
    onLoadIntoSlot={loadIntoSlot}
    onClearSlot={clearSlot}
    onSaveSet={saveSet}
    onLoadSet={loadSet}
    signedIn={headerSignedIn}
    {headerAuth}
    timelordeNode={workflowTimelordeNode}
    midiclockNode={workflowMidiclockNode}
    audioInNode={workflowAudioInNode}
    audioOutNode={workflowAudioOutNode}
    externallyClocked={workflowExternallyClocked}
    dinAssigned={workflowDinAssigned}
    nodeTypes={nodeTypes as unknown as Record<string, unknown>}
    {rackSizeByType}
    onEnsureEngine={ensureEngine}
    currentUserId={currentUserId ?? null}
    cameraNodes={workflowCameraNodes}
    cameraAtCap={workflowCameraAtCapNow}
  />

  {#if error}
    <pre class="error" data-testid="load-error">{error}</pre>
  {/if}

  {#if loadNotice}
    <!-- NON-BLOCKING. The rack loaded; this reports what it lost or changed.
         Dismissible because it describes a completed event, not a state. -->
    <div class="load-notice" data-testid="load-diagnostics" role="status" aria-live="polite">
      <span>{loadNotice}</span>
      <button type="button" data-testid="load-diagnostics-dismiss" onclick={() => (loadNotice = null)} aria-label="Dismiss">×</button>
    </div>
  {/if}

  <!-- DOCKING P2.5a: the TOP dock rail — a reserved-space flex sibling
       ABOVE the canvas row (never an overlay inside .svelte-flow). Empty
       → renders zero pixels. -->
  <DockRail
    zone="top"
    cards={topRailCards}
    nodeTypes={nodeTypes as unknown as Record<string, unknown>}
    {rackSizeByType}
    onUndock={undockNode}
    {rearView}
  />

  <!-- The canvas row: [left dock rail | flow]. -->
  <div class="canvas-row">
    <!-- The LEFT dock rail IS the workflow left toolbar (owner Q5):
         empty → the P1 44px scaffold strip; docked cards are its
         contents. Reserved-space flex sibling of .flow. -->
    <DockRail
      zone="left"
      cards={leftRailCards}
      nodeTypes={nodeTypes as unknown as Record<string, unknown>}
      {rackSizeByType}
      onUndock={undockNode}
      {rearView}
    />
  <div class="flow" class:rear-view={rearView} class:flip-back={flipBack} data-rear-view={rearView ? 'true' : undefined} bind:this={flowEl}>
    <!-- STRATA (P0.2): the zoom floor is 0.2 (not xyflow's 0.5) so fit-all can
         frame all 8 lanes + both sends (§3.4: ~0.22 at 1080p). fitViewOptions
         only lowers the FIT floor to match; padding + maxZoom stay at xyflow
         defaults. maxZoom is untouched. -->
    <SvelteFlow
      nodes={flowNodes}
      edges={flowEdges}
      {nodeTypes}
      fitView
      minZoom={0.2}
      fitViewOptions={{ minZoom: 0.2 }}
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
      onmovestart={onViewportMoveStart}
      onmove={onViewportMove}
      onmoveend={onViewportMoveEnd}
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
               of the Controls cluster via the `before` snippet.

               DISCOVERABILITY for the keyboard shortcut lives here, on the one
               visible affordance the gesture has (the dock full-view flip has
               no button at all). `aria-keyshortcuts` is the standards-correct
               place — a screen reader announces it WITHOUT changing the
               accessible name, so the aria-label stays the stable handle every
               spec locates the button by. The tooltip carries the same key for
               sighted users. Both read RACK_FLIP_KEY rather than restating the
               letter, so a rebind cannot leave the UI lying. -->
          <ControlButton
            class="svelte-flow__controls-flip-rack"
            onclick={toggleRearView}
            aria-label="Flip rack (rear view)"
            aria-pressed={rearView}
            aria-keyshortcuts={RACK_FLIP_KEY}
            data-testid="flip-rack-btn"
            data-active={rearView ? 'true' : undefined}
            title={`${rearView ? 'Front view' : 'Flip rack (rear view)'} — shortcut: ${RACK_FLIP_KEY}`}
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
      <!-- CHANNEL COLUMNS guide: 8 numbered columns + SEND 1/2 rail, pinned
           to flow space. -->
      <ChannelColumnsOverlay columnColors={wcolColumnColors} laneTopY={wcolLaneTopY} tick={wcolViewportTick} pitch={wcolPitch} paneLocalProjection={shellFaces} />
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
    <!-- THE BOTTOM DRAWER — ONE container, ONE occupant (dock unification,
         owner design call): EITHER the expanded full-view faceplate OR the
         P2.5a rail (the toggled pinned M/E/C occupant + cards docked to
         'bottom'). The {#if}/{:else} makes the exclusivity STRUCTURAL — the
         two bottom elements can never coexist in the DOM, so there is no
         z-fight for hotkeys to lose (the "c behind the full-view" bug). The
         dockStore occupancy invariant (pinned XOR full-view) keeps the state
         side equally exclusive; ESC closes whichever is open (dock-key
         handler above). Preview-off, fullViewCards is always empty → the
         rail renders exactly as shipped. -->
    {#if fullViewCards.length > 0}
      <!-- EXPANDED FULL-VIEW (P0.3b re-spec + owner split extension): up to
           TWO RACKLINE faceplates SIDE-BY-SIDE (50/50, open order =
           left→right), each an independently scrollable pane (its own
           overflow container — no shared scrollbar). A pane's ✕ closes just
           that pane (the survivor returns to full width); ESC / the M-E-C
           handoff close the whole view. data-fullview-flipped is the flip-key
           rear-card seam: ONE view-global flag, so with the 50/50 split
           BOTH panes flip together — each pane renders its RearCard (the
           flip-side patch field) while flipped. -->
      <div
        class="dock-fullview-drawer"
        data-testid="dock-fullview-drawer"
        data-pane-count={fullViewCards.length}
        data-fullview-flipped={dockStore.fullViewFlipped}
      >
        {#each fullViewCards as fv (fv.node.id)}
          <div class="dock-fullview-pane" data-testid="dock-fullview-pane" data-pane-node={fv.node.id}>
            <DockFullView
              node={fv.node}
              nodeTypes={nodeTypes as unknown as Record<string, unknown>}
              rackSize={rackSizeByType[fv.node.type]}
              migrated={migrated(fv.node.type)}
              title={fv.title}
              onClose={() => dockStore.closeFullView(fv.node.id)}
              onCollapse={() => dockStore.closeFullView(fv.node.id)}
              flipped={dockStore.fullViewFlipped}
            />
          </div>
        {/each}
      </div>
    {:else}
      <!-- The P1 M/E/C drawer GENERALIZED (P2.5a): the pinned occupant
           (drawer-only forever, owner Q2) alongside docked cards. Renders
           zero pixels when nothing is pinned-open or docked. -->
      <DockRail
        zone="bottom"
        cards={bottomRailCards}
        nodeTypes={nodeTypes as unknown as Record<string, unknown>}
        {rackSizeByType}
        onUndock={undockNode}
        onClosePinned={() => dockStore.close('bottom')}
        {rearView}
      />
    {/if}
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
    <!-- `?shell=1` DOM-SOURCE LIFECYCLE: a video module whose pixels come from a
         card-owned <video>/<img> (camera / videobox / archivist / …) loses its
         SOURCE when the shell swaps its lane card for a tile — the engine node
         exists but emits nothing, so the whole downstream chain is black. Keep
         those cards mounted OFF-SCREEN so `attachExternalSource` still runs and
         the engine's source set matches preview-off exactly. Renders NOTHING
         when the list is empty (always, preview-off). -->
    <HeadlessSourceHost
      nodes={headlessSourceNodes}
      nodeTypes={nodeTypes as unknown as Record<string, unknown>}
    />
    <PickupCable />
    {#if dockPanTails.length > 0 && flowApi}
      <!-- DOCKING P2.5b: gesture-scoped stub→rail tail (presentation-only;
           mounted onmovestart, killed onmoveend — zero idle cost). -->
      <DockPanTail
        tails={dockPanTails}
        toScreen={flowApi.flowToScreenPosition}
        tick={dockPanTick}
      />
    {/if}
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
    {#if dockToast}
      <!-- DOCKING P2.5a: transient local notice (auto-evict / delete). -->
      <div class="dock-toast" data-testid="dock-toast" role="status">{dockToast}</div>
    {/if}
  </div>
  </div>

  <footer class="bottombar">
    <div class="status">
      <span>nodes <b>{nodeCount}</b></span>
      <span>edges <b>{edgeCount}</b></span>
      <span title="Number of distinct module types in the registry (catalog size, not live instance count)">catalog <b>{availableModules}</b></span>
      <span>ctx <b>{audioCtx?.state ?? '—'}</b></span>
      <span>sr <b>{audioCtx?.sampleRate ?? '—'}</b></span>
      <!-- LAT + AUDIO HEALTH, ONE SPAN (underruns / main-thread jank / dead
           worklets), FOLDED INTO the pre-existing `lat` readout rather than
           added beside it.
           ⚠ WHY IT IS FOLDED, measured — do not split it back out. As a
           SEPARATE span the readout cost 281 px + a 14 px row gap, and the
           booted footer at 1280 px has only 147 px of free space between
           `.status` and `.cable-legend`. Overrunning it compressed the legend
           until its `li` text wrapped, which took the bottombar from 32.375 px
           to 41 px tall and the canvas from 612.484 px to 603.859 px — that
           8.6 px is what moved 133 VRT baselines and tipped the linux runner's
           card-size bistability. Folding is also honest rather than merely
           cheap: `playbackStats.averageLatency` and `AudioContext.outputLatency`
           are the SAME quantity (output-pipeline latency to the speakers), so
           `lat base/avg ms` states once what used to be stated twice.
           ⚠ The footer-height invariant is GATED, not hoped for:
           audio-health-readout.spec.ts hides this element and asserts the
           bottombar height is unchanged (and that the width DOES change, so the
           control cannot pass vacuously).
           Semantics are CUMULATIVE SINCE THE AUDIOCONTEXT WAS CREATED, never a
           rate — the tooltip says so, because a rising number must not be
           misread as "underrunning right now". `playbackStats` is Chromium-only
           and degrades to "—" on Firefox/Safari with no warning and no nag. -->
      <span
        class="audio-health"
        data-testid="audio-health"
        class:bad={audioHealth.health.underrunEvents > 0 || audioHealth.workletErrors > 0}
        title={
          `lat = output latency, BASE/AVERAGE in ms. base = render/processing latency, fixed by `
          + `the Buffer selector to the right (a bigger buffer trades latency for slack against `
          + `clicks under UI load). average = mean full output-pipeline latency to the speakers.\n\n`
          + (audioHealth.health.supported
            ? `Audio health, CUMULATIVE SINCE THIS AUDIOCONTEXT WAS CREATED (not a rate).\n`
              + `drop = underruns: COUNT / total starved time — times the audio device was starved `
              + `and played silence or a repeat `
              + `(${audioHealth.health.underrunEvents} in ${audioHealth.health.totalSec.toFixed(0)}s of output).\n`
              + `tick = main-thread scheduler lateness p99 — HIGH TICK WITH ZERO DROPS means the `
              + `MAIN THREAD is busy (UI/video), not the audio thread. They are different problems.\n`
              + `dead = AudioWorkletProcessors that threw. A processor that throws outputs silence for `
              + `the rest of its life (Web Audio spec) — that module is gone until you reload. The `
              + `badge is only rendered when the count is non-zero.\n`
              + `Drops rising? Set Buffer to Stable to the right and reload.`
            : 'drop = underruns: this browser does not implement AudioContext.playbackStats '
              + '(Chromium only today), so they cannot be counted here. The tick and dead '
              + 'counters still work.')
        }
      >
        <span class="ah-field"
          >lat <b class="ah-base">{audioCtx
            ? (audioCtx.baseLatency * 1000).toFixed(1)
            : '—'}</b>/<b class="ah-avg">{latAvgLabel}</b></span
        >
        <span class="ah-field"
          >drop <b class="ah-drop"
            >{formatAudioHealth(audioHealth.health).underruns}/{formatAudioHealth(
              audioHealth.health,
            ).dropout}</b
          ></span
        >
        <span class="ah-field"
          >tick <b class="ah-tick">{audioHealth.tick && audioHealth.tick.samples > 0
            ? `${audioHealth.tick.p99Ms.toFixed(0)}ms`
            : '—'}</b></span
        >
        {#if audioHealth.workletErrors > 0}
          <b class="audio-health-dead" data-testid="audio-health-dead"
            >dead {audioHealth.workletErrors}{audioHealth.lastWorkletError
              ? ` (${audioHealth.lastWorkletError.moduleType ?? audioHealth.lastWorkletError.processor})`
              : ''}</b
          >
        {/if}
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
  currentControlColor={ctxMenuControlColor}
  hasCustomControlColor={ctxMenuHasCustomColor}
  onsetcontrolcolor={(hex) => ctxMenuNodeId && setControlColor(ctxMenuNodeId, hex)}
  onresetcontrolcolor={() => ctxMenuNodeId && setControlColor(ctxMenuNodeId, null)}
  channelColors={ctxMenuChannelColors}
  assignedChannel={ctxMenuAssignedChannel}
  clipEligible={ctxMenuClipEligible}
  mixerEligible={ctxMenuMixerEligible}
  onassigntochannel={(channel) => commitAssignToChannel(channel)}
  onassignautomationonly={(channel) => commitAssignAutomationOnly(channel)}
  onremoveautomationlane={() => ctxMenuNodeId && removeAutomationAssignment(ctxMenuNodeId)}
  dockable={ctxMenuDockable}
  docked={ctxMenuDocked}
  ondock={(zone) => ctxMenuNodeId && dockNode(ctxMenuNodeId, zone)}
  onundock={() => ctxMenuNodeId && undockNode(ctxMenuNodeId)}
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
  stereoPair={portMenuStereoPair}
  channelMode={portMenuChannelMode}
  onchannelmode={(m) => (portMenuChannelMode = m)}
  moduleEntries={portMenuModuleEntries}
  candidatesFor={portMenuCandidatesFor}
  preselectModuleId={portMenuPreselectNodeId}
  onexpandstereo={
    portMenuSourceNodeId &&
    portMenuSourcePortId &&
    expandablePairAt(portMenuSourceNodeId, portMenuSourcePortId, 'output')
      ? expandFromPortMenu
      : undefined
  }
  stereoExpanded={
    portMenuSourceNodeId && portMenuSourcePortId
      ? isExpandedAt(portMenuSourceNodeId, portMenuSourcePortId, 'output')
      : false
  }
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

<!-- Right-click → UNPATCH on a patched patch point, in EVERY jack field
     (legacy PatchPanel rows + back panel, the RearCard in the dock full-view
     and the flip-key rear view). ONE menu, ONE removal seam. -->
<UnpatchMenu
  bind:open={unpatchOpen}
  x={unpatchPos.x}
  y={unpatchPos.y}
  title={unpatchPlan.title}
  items={unpatchPlan.items}
  allLabel={unpatchPlan.allLabel}
  onunpatch={unpatchEdges}
  onchannelmode={setLegGroupChannelMode}
  onpatchto={unpatchTarget?.direction === 'output' ? patchToFromUnpatch : undefined}
  onexpandstereo={
    unpatchTarget &&
    expandablePairAt(unpatchTarget.nodeId, unpatchTarget.portId, unpatchTarget.direction)
      ? expandFromUnpatch
      : undefined
  }
  stereoExpanded={
    unpatchTarget
      ? isExpandedAt(unpatchTarget.nodeId, unpatchTarget.portId, unpatchTarget.direction)
      : false
  }
  onclose={closeUnpatchMenu}
/>

<!-- Right-click → EXPAND a collapsed stereo jack into its two L/R holes, for
     the one case no other menu claims: an UNPATCHED audio input. -->
<StereoExpandMenu
  bind:open={stereoExpandOpen}
  x={stereoExpandPos.x}
  y={stereoExpandPos.y}
  title={stereoExpandView.title}
  expanded={stereoExpandView.expanded}
  legLabels={stereoExpandView.legLabels}
  onchange={(value) => {
    const t = stereoExpandTarget;
    if (t) applyStereoExpand(t.nodeId, t.portId, t.direction, value);
  }}
  onclose={closeStereoExpandMenu}
/>

<!-- A drop whose two ends disagree about width — mono source on a stereo jack,
     or stereo source on a mono jack. NOTHING is written until a row is picked;
     Escape / negative space abandons the patch. -->
<StereoDropChoiceMenu
  bind:open={dropChoiceOpen}
  x={dropChoicePos.x}
  y={dropChoicePos.y}
  title={dropChoicePending?.title ?? ''}
  choice={dropChoice}
  labelFor={(portId) => resolveVerboseLabel({ id: portId })}
  onpick={resolveDropChoice}
  oncancel={closeDropChoice}
/>

<style>
  .root {
    height: 100vh;
    display: flex;
    flex-direction: column;
    background: var(--bg);
    color: var(--text);
  }
  .root > .error,
  .root > .bottombar,
  .root > .trace-panel {
    flex: 0 0 auto;
  }
  /* DOCKING P2.5a: .flow sits inside .canvas-row — a flex ROW that hosts
   * the LEFT dock rail as a reserved-space sibling. The row takes the old
   * `.root > .flow` flex slot and .flow fills what the rail leaves. */
  .root > .canvas-row {
    flex: 1 1 auto;
    display: flex;
    flex-direction: row;
    min-height: 0;
  }
  .canvas-row > .flow {
    flex: 1 1 auto;
    min-width: 0;
  }
  /* DOCK UNIFICATION + owner split extension: the bottom drawer's full-view
   * container — the ONE bottom overlay while any faceplate is expanded (the
   * DockRail branch renders instead when it's closed). Up to two panes share
   * it 50/50; each pane is its OWN scroll context (DockFullView's
   * .faceplate-scroll), so the panes scroll independently in both axes. */
  .dock-fullview-drawer {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    /* Panes re-enable this. Without it the full-width drawer keeps eating
       pointer events over the area it no longer paints, so the canvas would
       LOOK exposed and not be clickable — visually fixed, functionally not. */
    pointer-events: none;
    z-index: 31;
    display: flex;
    flex-direction: row;
    gap: 8px;
    padding: 0 8px 8px;
    max-height: min(60vh, 680px);
  }
  .dock-fullview-pane {
    /* SHRINK-WRAP (#1573): panes size to their content instead of dividing the
       viewport. A ~400px card used to sit in a ~2000px tray, hiding the canvas
       behind 1600px of empty chrome and parking the ⤡/✕ controls a screen-width
       away from the card they act on.
       `0 1 auto` = never grow, still allowed to shrink; the content's own
       min-width governs (the 900px kit for curated faces, max-content for a
       legacy card frame). */
    flex: 0 1 auto;
    min-width: 0;
    display: flex;
    /* The drawer spans the viewport for POSITIONING only; re-enable hit-testing
       on the pane itself so the exposed canvas stays clickable. */
    pointer-events: auto;
  }
  /* DOCKING P2.5a: transient dock toast (auto-evict / delete notices). */
  .dock-toast {
    position: absolute;
    bottom: 14px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 40;
    background: rgba(14, 17, 22, 0.95);
    color: var(--text);
    border: 1px solid var(--accent-dim, #1d5f66);
    border-radius: 4px;
    padding: 6px 14px;
    font-size: 0.75rem;
    font-family: ui-monospace, monospace;
    pointer-events: none;
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
  /* MODULE-level automation assignment: the ASSIGNED module's card gets a
   * thin border in its lane's colour (--auto-lane-color, inline from the
   * clip-player's autoAssign). Applied at the shared node WRAPPER so it works
   * for every module type; reactive to assignment + lane-colour changes
   * (the flowNodes guard includes autoColor). Outline, not border, so no
   * card's own layout/border styling is disturbed. */
  :global(.svelte-flow__node.auto-lane-assigned) {
    outline: 2px solid var(--auto-lane-color);
    outline-offset: 2px;
    border-radius: 3px;
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
  .load-notice {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin: 0;
    padding: 0.5rem 1.25rem;
    border-bottom: 1px solid #3a3320;
    background: rgba(250, 204, 21, 0.08);
    color: #fde68a;
    font-family: ui-monospace, monospace;
    font-size: 0.75rem;
  }
  .load-notice span { flex: 1; }
  .load-notice button {
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    font-size: 1rem;
    line-height: 1;
    padding: 0 0.25rem;
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
    /* 0.5rem, not 1rem: the footer row has a hard width budget at 1280 px (see
     * `.audio-health`), and 6 gaps × 7 px is 42 px bought back for the health
     * readout WITHOUT making the footer wider. Row height is unaffected. */
    gap: 0.5rem;
  }
  .status b {
    color: var(--text);
    font-weight: 500;
  }
  /* Audio health readout — `lat base/avg ms · drop N/Dms · tick Pms`, plus a
   * `dead N (module)` badge when a worklet processor has latched. Muted until
   * something is actually wrong, so a healthy footer stays quiet.
   *
   * ⚠ THE WIDTH BUDGET IS REAL AND IT IS SMALL. Measured at the VRT viewport
   * (1280 CSS px, AudioContext booted): `.status` 545.063 px + `.cable-legend`
   * 547.625 px + 35 px of bottombar padding leaves 147.3 px of free space.
   * Spend more than that and the legend compresses until its `li` text wraps,
   * which grows the bottombar 32.375 px → 41 px and shrinks the canvas by the
   * same 8.6 px. That is a whole-app layout change driven by a footer label.
   * This block therefore buys the room back rather than borrowing it: `.status`
   * gap 1rem → 0.5rem and `.cable-legend` gap 0.8rem → 0.5rem (see those
   * rules), which is why the row still fits with ~54 px to spare.
   *
   * ⚠ RESERVED PER-FIELD WIDTHS, load-bearing rather than cosmetic. The text
   * changes after mount (em-dashes → "13.3" / "36.6ms" / "0/0.0ms" as the
   * context boots and the 1 Hz poll lands). A row that RESIZES a second after
   * first paint is a layout event with no fixed time, and VRT's two-
   * consecutive-stable-captures rule can straddle it. Tabular figures + a
   * min-width per value mean the row is the same width before and after every
   * value it will normally show, and it stops the footer twitching while the
   * numbers tick. The min-widths are sized to the TYPICAL value, not the
   * pathological one: a rack that is genuinely dropping out prints wider
   * numbers and eats into the ~54 px margin, which is the correct trade — at
   * that point the user has a real problem and a slightly wider footer is not
   * it. */
  .audio-health {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    cursor: help;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  /* ⚠ `inline-block`, NOT `inline-flex`. A flex container drops whitespace-only
   * anonymous items, so `lat <b>13.3</b>` rendered as "lat13.3" — the label and
   * its value ran together in all three fields and the row was materially
   * harder to read for zero width saved. Caught by screenshotting the footer,
   * which no assertion in this repo would have. */
  .audio-health .ah-field {
    display: inline-block;
  }
  .audio-health b {
    display: inline-block;
    text-align: left;
  }
  .audio-health .ah-base {
    min-width: 4ch;
  }
  .audio-health .ah-avg {
    min-width: 6ch;
  }
  .audio-health .ah-drop {
    min-width: 7ch;
  }
  .audio-health .ah-tick {
    min-width: 3ch;
  }
  .audio-health.bad b {
    color: #f0a04b;
  }
  .audio-health-dead {
    color: #f45c51 !important;
  }
  /* R-1 audio buffer / latency selector — sits in the footer status row,
   * styled to match the topbar dropdown chrome. */
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
    /* 0.5rem, not 0.8rem: 8 gaps × 4.2 px is another 33.6 px bought back for
     * the footer's width budget (see `.audio-health`). This list is the half of
     * the row that WRAPPED when the budget was blown — its `li` text going to
     * two lines is what grew the bottombar by 8.6 px and moved 133 VRT
     * baselines. Narrower gaps, same single line. */
    gap: 0.5rem;
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

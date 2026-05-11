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
    downloadEnvelope,
    pickAndLoadEnvelope,
    parseEnvelope,
    loadEnvelopeIntoStore,
    sanitizeFilename,
    DEFAULT_FILENAME,
    EnvelopeParseError,
    type PatchEnvelope,
  } from '$lib/graph/persistence';

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
  import '$lib/audio/modules'; // auto-registers analogVcoDef + audioOutDef
  // Video-domain (Phase 0 spike) — sibling registry + engine class. Imported
  // here so module defs are present in the registry by the time the palette
  // reads listModuleDefs(); engine instance is created lazily in ensureEngine.
  import { VideoEngine } from '$lib/video/engine';
  import { listVideoModuleDefs, getVideoModuleDef } from '$lib/video/module-registry';
  import '$lib/video/modules'; // auto-registers linesDef + videoOutDef
  import AnalogVcoCard from '$lib/ui/modules/AnalogVcoCard.svelte';
  import AudioOutCard from '$lib/ui/modules/AudioOutCard.svelte';
  import VcaCard from '$lib/ui/modules/VcaCard.svelte';
  import MixerCard from '$lib/ui/modules/MixerCard.svelte';
  import AdsrCard from '$lib/ui/modules/AdsrCard.svelte';
  import FilterCard from '$lib/ui/modules/FilterCard.svelte';
  import ReverbCard from '$lib/ui/modules/ReverbCard.svelte';
  import ScopeCard from '$lib/ui/modules/ScopeCard.svelte';
  import SequencerCard from '$lib/ui/modules/SequencerCard.svelte';
  import WavetableVcoCard from '$lib/ui/modules/WavetableVcoCard.svelte';
  import LfoCard from '$lib/ui/modules/LfoCard.svelte';
  import CartesianCard from '$lib/ui/modules/CartesianCard.svelte';
  import DestroyCard from '$lib/ui/modules/DestroyCard.svelte';
  import QbrtCard from '$lib/ui/modules/QbrtCard.svelte';
  import DrummergirlCard from '$lib/ui/modules/DrummergirlCard.svelte';
  import MeowboxCard from '$lib/ui/modules/MeowboxCard.svelte';
  import MixmstrsCard from '$lib/ui/modules/MixmstrsCard.svelte';
  import TimelordeCard from '$lib/ui/modules/TimelordeCard.svelte';
  import CharlottesEchosCard from '$lib/ui/modules/CharlottesEchosCard.svelte';
  import RiotgirlsCard from '$lib/ui/modules/RiotgirlsCard.svelte';
  import ScoreCard from '$lib/ui/modules/ScoreCard.svelte';
  import DrumseqzCard from '$lib/ui/modules/DrumseqzCard.svelte';
  import PolyseqzCard from '$lib/ui/modules/PolyseqzCard.svelte';
  import VizvcoCard from '$lib/ui/modules/VizvcoCard.svelte';
  import WavvizCard from '$lib/ui/modules/WavvizCard.svelte';
  // SWOLEVCO — Buchla 259-style complex VCO with built-in scope output.
  import SwolevcoCard from '$lib/ui/modules/SwolevcoCard.svelte';
  import LinesCard from '$lib/ui/modules/LinesCard.svelte';
  import VideoOutCard from '$lib/ui/modules/VideoOutCard.svelte';
  import ShapesCard from '$lib/ui/modules/ShapesCard.svelte';
  import MonoglitchCard from '$lib/ui/modules/MonoglitchCard.svelte';
  import RuttetraCard from '$lib/ui/modules/RuttetraCard.svelte';
  import ShapedrampsCard from '$lib/ui/modules/ShapedrampsCard.svelte';
  import VdelayCard from '$lib/ui/modules/VdelayCard.svelte';
  // Phase 1 video modules — see .myrobots/plans/video-modules-mvp.md.
  import InwardsCard from '$lib/ui/modules/InwardsCard.svelte';
  import PictureboxCard from '$lib/ui/modules/PictureboxCard.svelte';
  import DestructorCard from '$lib/ui/modules/DestructorCard.svelte';
  import ChromaCard from '$lib/ui/modules/ChromaCard.svelte';
  import LumaCard from '$lib/ui/modules/LumaCard.svelte';
  import ColorizerCard from '$lib/ui/modules/ColorizerCard.svelte';
  import FeedbackCard from '$lib/ui/modules/FeedbackCard.svelte';
  import VideoMixerCard from '$lib/ui/modules/VideoMixerCard.svelte';
  // CAMERA input (local-only) — see .myrobots/plans/module-camera-input.md.
  import CameraInputCard from '$lib/ui/modules/CameraInputCard.svelte';
  // ILLOGIC — combined attenuverter / math / logic utility (audio domain).
  import IllogicCard from '$lib/ui/modules/IllogicCard.svelte';
  // UNITYSCALEMATHEMATIK — bipolar CV shaper (unity scaler + 2 linear/expo
  // attenuvert sections).
  import UnityscalemathematikCard from '$lib/ui/modules/UnityscalemathematikCard.svelte';
  import Dx7Card from '$lib/ui/modules/Dx7Card.svelte';
  // NOISE — basic noise source (white / pink / brown).
  import NoiseCard from '$lib/ui/modules/NoiseCard.svelte';
  // BUGGLES — chaotic random voltage source (wogglebug-style).
  import BugglesCard from '$lib/ui/modules/BugglesCard.svelte';
  // WAVECEL — stereo wavetable VCO (E352 WAV loader, 3D viz, spread, fold).
  import WavecelCard from '$lib/ui/modules/WavecelCard.svelte';
  // WARRENSPECTRUM — 8-band filterbank with vactrol ping + acidwarp video viz.
  import WarrenspectrumCard from '$lib/ui/modules/WarrenspectrumCard.svelte';
  // STEREOVCA — stereo VCA + ring modulator.
  import StereovcaCard from '$lib/ui/modules/StereovcaCard.svelte';
  import ModulePalette from '$lib/ui/ModulePalette.svelte';
  import NodeContextMenu from '$lib/ui/NodeContextMenu.svelte';
  import PortContextMenu from '$lib/ui/PortContextMenu.svelte';
  import { connectDragState } from '$lib/ui/connect-drag-state.svelte';
  import {
    buildModuleEntries,
    compatibleTargetPorts,
    type AnyDef,
    type CandidatePort,
    type ModuleEntry,
  } from '$lib/ui/port-patch-helpers';
  import AwarenessLayer from '$lib/ui/AwarenessLayer.svelte';
  import SkinSwitcher from '$lib/ui/SkinSwitcher.svelte';
  import FlowBridge, { type FlowBridgeApi } from '$lib/ui/FlowBridge.svelte';
  import PickupCable from '$lib/ui/PickupCable.svelte';
  import { organizeLayout, type Box } from '$lib/ui/canvas/organize';
  import type { CableType } from '$lib/graph/types';
  import { getNodePosition, setNodePosition } from '$lib/multiplayer/layouts';
  import {
    pictureboxSpawnDecision,
    explainSpawnDenial,
    PICTUREBOX_TYPE,
  } from '$lib/multiplayer/picturebox-limits';
  import type { HocuspocusProvider } from '@hocuspocus/provider';
  import type { PresenceUser } from '$lib/multiplayer/presence';

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
  }
  let {
    currentUserId,
    provider = null,
    presenceUser = null,
    audioGate,
  }: Props = $props();

  const nodeTypes = {
    analogVco: AnalogVcoCard,
    audioOut: AudioOutCard,
    vca: VcaCard,
    mixer: MixerCard,
    adsr: AdsrCard,
    filter: FilterCard,
    reverb: ReverbCard,
    scope: ScopeCard,
    sequencer: SequencerCard,
    wavetableVco: WavetableVcoCard,
    lfo: LfoCard,
    cartesian: CartesianCard,
    destroy: DestroyCard,
    qbrt: QbrtCard,
    drummergirl: DrummergirlCard,
    meowbox: MeowboxCard,
    mixmstrs: MixmstrsCard,
    timelorde: TimelordeCard,
    charlottesEchos: CharlottesEchosCard,
    riotgirls: RiotgirlsCard,
    score: ScoreCard,
    drumseqz: DrumseqzCard,
    polyseqz: PolyseqzCard,
    vizvco: VizvcoCard,
    wavviz: WavvizCard,
    swolevco: SwolevcoCard,
    // Video-domain (Phase 0):
    lines: LinesCard,
    videoOut: VideoOutCard,
    shapes: ShapesCard,
    monoglitch: MonoglitchCard,
    ruttetra: RuttetraCard,
    shapedramps: ShapedrampsCard,
    vdelay: VdelayCard,
    // Video-domain (Phase 1):
    inwards: InwardsCard,
    picturebox: PictureboxCard,
    destructor: DestructorCard,
    chroma: ChromaCard,
    luma: LumaCard,
    colorizer: ColorizerCard,
    feedback: FeedbackCard,
    videoMixer: VideoMixerCard,
    // CAMERA input (local-only):
    cameraInput: CameraInputCard,
    illogic: IllogicCard,
    unityscalemathematik: UnityscalemathematikCard,
    dx7: Dx7Card,
    noise: NoiseCard,
    buggles: BugglesCard,
    wavecel: WavecelCard,
    warrenspectrum: WarrenspectrumCard,
    stereovca: StereovcaCard,
  };

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
  provideProviderContext(() => provider);

  // Dev-only: expose patch + ydoc on window so e2e tests can drive arbitrary
  // module-spawning combinations without a UI palette. Stripped in prod builds.
  if (import.meta.env.DEV) {
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
      // Drag-lock state for e2e — patch-menus-persist tests inspect this
      // to confirm the lock engaged + released at the right moments.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__connectDragState = connectDragState;
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
    });
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

  $effect(() => {
    const snap = snapshot;
    const top = topNodeId;
    flowNodes = snap.nodes.map((n) => {
      const node: FlowNode = {
        id: n.id,
        type: n.type,
        // Per-user layouts: getNodePosition returns the user's override
        // (when in multiplayer) or falls back to n.position (when single-
        // user OR when this user has no entry yet).
        position: getNodePosition(ydoc, currentUserId, n.id, { x: n.position.x, y: n.position.y }),
        data: { node: n },
      };
      // Lift the most-recently-spawned node above its siblings so it's
      // visible immediately when it lands on top of an existing card.
      // xyflow's default node zIndex is 0; bumping to 1000 puts the new
      // card above everything without colliding with selected-node
      // styling (which xyflow handles internally via the .selected class
      // rather than a competing zIndex).
      if (top === n.id) node.zIndex = 1000;
      return node;
    });
  });

  $effect(() => {
    const snap = snapshot;
    const hovered = hoveredNodeId;
    flowEdges = snap.edges.map((e) => {
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
      return edge;
    });
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
            patch.nodes[id] = { id, type: n.type, domain: 'audio', position: n.position, params: n.params, data: n.data };
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
    // Phase 0 video spike: a node may belong to either domain registry.
    // Try audio first (the common case), fall back to video so a video
    // module's port types resolve correctly.
    const srcDef = getModuleDef(srcNode.type) ?? getVideoModuleDef(srcNode.type);
    const dstDef = getModuleDef(dstNode.type) ?? getVideoModuleDef(dstNode.type);
    if (!srcDef || !dstDef) return;

    const srcPort = srcDef.outputs.find((p) => p.id === connection.sourceHandle);
    const dstPort = dstDef.inputs.find((p) => p.id === connection.targetHandle);
    const sourceType: CableType = srcPort?.type ?? 'audio';
    const targetType: CableType = dstPort?.type ?? sourceType;

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

  function onNodeContextMenu({ event, node }: { event: MouseEvent | TouchEvent; node: FlowNode }) {
    event.preventDefault();
    const me = event as MouseEvent;
    ctxMenuPos = { x: me.clientX, y: me.clientY };
    ctxMenuNodeId = node.id;
    ctxMenuOpen = true;
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
    return getModuleDef(type) ?? getVideoModuleDef(type);
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
    const srcPort = srcDef.outputs.find((p) => p.id === from.portId);
    const dstPort = dstDef.inputs.find((p) => p.id === to.portId);
    const sourceType: CableType = srcPort?.type ?? 'audio';
    const targetType: CableType = dstPort?.type ?? sourceType;

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
    const def = audioDef ?? videoDef;
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
    // Domain dispatch (Phase 0 video spike): try the audio registry first;
    // fall back to the video registry. The two registries are kept separate
    // so domain-specific def shapes don't bleed across; the spawn path just
    // needs the `domain` + `maxInstances` fields and either works.
    const audioDef = getModuleDef(type);
    const videoDef = !audioDef ? getVideoModuleDef(type) : undefined;
    const def = audioDef ?? videoDef;
    const domain: 'audio' | 'video' = audioDef ? 'audio' : 'video';
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
    const id = `${type}-${crypto.randomUUID().slice(0, 8)}`;
    // The new card is placed exactly under the cursor (spawnFlowPos was
    // computed via screenToFlowPosition by the caller). Earlier versions
    // here looped a STACK_OFFSET nudge to clear collisions; we removed it
    // so spawn-at-cursor honors the user intent literally — overlapping
    // is fine, the new card just renders on top via topNodeId/zIndex below.
    // Users who want a tidy layout still have right-click → Organize modules.
    const pos = { ...spawnFlowPos };
    // Per-module spawn-time data stamping. PICTUREBOX writes creatorId
    // (only when we have a real userId — single-user mode leaves it
    // unattributed, matching the per-user-cap-skipped behavior of the
    // decision helper above). See lib/multiplayer/picturebox-limits.ts.
    const initialData: Record<string, unknown> | undefined =
      type === PICTUREBOX_TYPE && currentUserId
        ? { creatorId: currentUserId }
        : undefined;

    ydoc.transact(() => {
      patch.nodes[id] = {
        id,
        type,
        domain,
        position: pos,
        params: {},
        ...(initialData ? { data: initialData } : {}),
      };
    }, LOCAL_ORIGIN);
    // Mark this node as the visual top of the stacking order so it
    // renders on top of any cards it overlaps. Cleared as soon as the
    // user touches a different card (drag, right-click) so the lift is
    // strictly an at-spawn affordance — long-lived "always on top"
    // would surprise users who expect drag-to-front to win later.
    topNodeId = id;
    trace(`spawned ${type} (${id})`);
    // Engine instantiation happens via the reconciler microtask.
    void ensureEngine();
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
    awareness.setLocalStateField('user', user);
    return () => {
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
  if (import.meta.env.DEV) {
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
  // racing against the captureTimeout debouncer. Stripped in prod.
  if (import.meta.env.DEV) {
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

<div class="root">
  <header class="topbar">
    <h1>2600hz</h1>
    <div class="actions">
      <button onclick={openPaletteFromButton}>+ Add module</button>
      <button onclick={loadExample} disabled={booting} class="primary">
        {booting ? 'Loading…' : 'Load example'}
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
      <SkinSwitcher />
      <a class="signin-link" href="/dashboard" data-testid="signin-link">Sign in</a>
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
  </div>

  <footer class="bottombar">
    <div class="status">
      <span>nodes <b>{nodeCount}</b></span>
      <span>edges <b>{edgeCount}</b></span>
      <span>modules registered <b>{availableModules}</b></span>
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
  onselect={spawnFromPalette}
  onorganize={organizeModules}
  onclose={() => (paletteOpen = false)}
/>

<NodeContextMenu
  bind:open={ctxMenuOpen}
  x={ctxMenuPos.x}
  y={ctxMenuPos.y}
  nodeLabel={ctxMenuLabel}
  nodeType={ctxMenuNodeType}
  ondelete={() => ctxMenuNodeId && deleteNode(ctxMenuNodeId)}
  onduplicate={() => ctxMenuNodeId && duplicateNode(ctxMenuNodeId)}
  onunpatch={() => ctxMenuNodeId && unpatchNode(ctxMenuNodeId)}
  onclose={() => { ctxMenuOpen = false; ctxMenuNodeId = null; }}
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

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
    type Node as FlowNode,
    type Edge as FlowEdge,
    type Connection,
  } from '@xyflow/svelte';
  import { patch, ydoc } from '$lib/graph/store';
  import { getDefaultSnapshotBus, type PatchSnapshot } from '$lib/graph/snapshot';
  import {
    makeEnvelope,
    downloadEnvelope,
    pickAndLoadEnvelope,
    parseEnvelope,
    loadEnvelopeIntoStore,
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
  import '$lib/audio/modules'; // auto-registers analogVcoDef + audioOutDef
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
  import ModulePalette from '$lib/ui/ModulePalette.svelte';
  import NodeContextMenu from '$lib/ui/NodeContextMenu.svelte';
  import type { CableType } from '$lib/graph/types';
  import { getNodePosition, setNodePosition } from '$lib/multiplayer/layouts';

  // Stage B PR B-b: when mounted under /r/[id] (multi-user), the parent
  // passes the current user's id so per-user layouts are scoped correctly.
  // On the public canvas at `/`, this stays undefined and the layout
  // helpers fall through to node.position (single-user behavior preserved).
  interface Props {
    currentUserId?: string;
  }
  let { currentUserId }: Props = $props();

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

  $effect(() => {
    const snap = snapshot;
    flowNodes = snap.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      // Per-user layouts: getNodePosition returns the user's override
      // (when in multiplayer) or falls back to n.position (when single-
      // user OR when this user has no entry yet).
      position: getNodePosition(ydoc, currentUserId, n.id, { x: n.position.x, y: n.position.y }),
      data: { node: n },
    }));
  });

  $effect(() => {
    const snap = snapshot;
    flowEdges = snap.edges.map((e) => ({
      id: e.id,
      source: e.source.nodeId,
      sourceHandle: e.source.portId,
      target: e.target.nodeId,
      targetHandle: e.target.portId,
      style: `stroke: var(--cable-${e.sourceType}); stroke-width: 3;`,
    }));
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
    const env = makeEnvelope(ydoc);
    downloadEnvelope(env);
    trace(`saved patch (${Object.keys(patch.nodes).length} nodes, ${Object.keys(patch.edges).length} edges)`);
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
    if (!connection.source || !connection.target) return;
    if (!connection.sourceHandle || !connection.targetHandle) return;

    const srcNode = patch.nodes[connection.source];
    const dstNode = patch.nodes[connection.target];
    if (!srcNode || !dstNode) return;
    const srcDef = getModuleDef(srcNode.type);
    const dstDef = getModuleDef(dstNode.type);
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
    });
    trace(`connect ${connection.source}.${connection.sourceHandle} → ${connection.target}.${connection.targetHandle}`);
  }

  /** When the user starts dragging FROM an input handle, immediately detach any
   *  existing cable on that input. Lets you grab a patched input and rewire it
   *  somewhere else with one motion. */
  function handleConnectStart(_event: MouseEvent | TouchEvent, params: { nodeId: string | null; handleId: string | null; handleType: 'source' | 'target' | null }) {
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
    });
    if (removed > 0) trace(`detached cable from ${params.nodeId}.${params.handleId} (rewiring)`);
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
    });
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
    });
  }

  // ---------------- Module-add palette ----------------

  let paletteOpen = $state(false);
  let palettePos = $state({ x: 0, y: 0 });
  let spawnFlowPos = $state({ x: 0, y: 0 });

  /** Right-click on canvas pane → open palette at cursor; spawn at that flow pos. */
  function onPaneContextMenu({ event }: { event: MouseEvent | TouchEvent }) {
    event.preventDefault();
    const me = event as MouseEvent;
    palettePos = { x: me.clientX, y: me.clientY };
    // Approximate flow-pos when viewport is roughly at (0,0,1). For zoomed/panned
    // viewports the spawn position will drift from the click location; users can
    // drag to reposition or use the Controls fit-view to recenter.
    spawnFlowPos = { x: me.clientX, y: me.clientY };
    paletteOpen = true;
  }

  /** Topbar button → open palette near top-left, spawn at canvas origin-ish. */
  function openPaletteFromButton() {
    palettePos = { x: 80, y: 60 };
    spawnFlowPos = { x: 200, y: 200 };
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

  function onNodeContextMenu({ event, node }: { event: MouseEvent | TouchEvent; node: FlowNode }) {
    event.preventDefault();
    const me = event as MouseEvent;
    ctxMenuPos = { x: me.clientX, y: me.clientY };
    ctxMenuNodeId = node.id;
    ctxMenuOpen = true;
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
    });
    // No defensive flow* sync needed: snapshot bus + one-way prop (B3).
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
    });
    trace(`unpatched ${nodeId}`);
  }

  function spawnFromPalette(type: string) {
    // Second-layer singleton guard. The palette filters at-cap modules out of
    // the picker, but spawn paths that bypass it (drag-drop, keyboard short-
    // cuts) still hit this. Pre-Yjs-write check inside transact closes the
    // double-spawn race for a single client; the engine.addNode rejection is
    // the ultimate defense for multiplayer.
    const def = getModuleDef(type);
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
    const id = `${type}-${crypto.randomUUID().slice(0, 8)}`;
    ydoc.transact(() => {
      patch.nodes[id] = {
        id,
        type,
        domain: 'audio',
        position: { ...spawnFlowPos },
        params: {},
      };
    });
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

  onDestroy(() => {
    reconciler?.dispose();
    engine?.dispose();
  });

  let nodeCount = $derived(flowNodes.length);
  let edgeCount = $derived(flowEdges.length);
  let availableModules = $derived(listModuleDefs().length);
</script>

<div class="root">
  <header class="topbar">
    <h1>patchtogether.live</h1>
    <span class="caption">Day 7 — Svelte Flow canvas + reactive engine</span>
    <div class="actions">
      <button onclick={openPaletteFromButton}>+ Add module</button>
      <button onclick={loadExample} disabled={booting} class="primary">
        {booting ? 'Loading…' : 'Load example'}
      </button>
      <button onclick={savePatch} disabled={nodeCount === 0}>Save</button>
      <button onclick={loadPatch}>Load</button>
      <button onclick={clearPatch} disabled={nodeCount === 0}>Clear</button>
      <a class="signin-link" href="/dashboard" data-testid="signin-link">Sign in</a>
    </div>
  </header>

  {#if error}
    <pre class="error">{error}</pre>
  {/if}

  <div class="flow">
    <SvelteFlow
      nodes={flowNodes}
      edges={flowEdges}
      {nodeTypes}
      fitView
      colorMode="dark"
      onconnect={handleConnect}
      onconnectstart={handleConnectStart}
      ondelete={handleDelete}
      onnodedragstop={handleNodeDragStop}
      onpanecontextmenu={onPaneContextMenu}
      onnodecontextmenu={onNodeContextMenu}
    >
      <Background size={1} gap={16} bgColor="#0e1116" patternColor="#1f242c" />
      <Controls />
    </SvelteFlow>
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
  onclose={() => (paletteOpen = false)}
/>

<NodeContextMenu
  bind:open={ctxMenuOpen}
  x={ctxMenuPos.x}
  y={ctxMenuPos.y}
  nodeLabel={ctxMenuLabel}
  ondelete={() => ctxMenuNodeId && deleteNode(ctxMenuNodeId)}
  onunpatch={() => ctxMenuNodeId && unpatchNode(ctxMenuNodeId)}
  onclose={() => { ctxMenuOpen = false; ctxMenuNodeId = null; }}
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

<script lang="ts">
  // VirtualModule — the LEFT column of the interactive doc page: a REAL, live
  // module card you can hover + open patch panels on. Because it renders the
  // ACTUAL card component (via the glob card-map), any faceplate change shows up
  // here automatically — no screenshot to regenerate.
  //
  // CLIENT-ONLY. xyflow + the cards touch `window` on mount, and prerender must
  // never execute them, so the page mounts this only behind `{#if browser}` /
  // onMount. The card map + SvelteFlow are loaded with a DYNAMIC import in
  // onMount so the prerender server bundle never pulls the client card code.
  //
  // SANDBOX ISOLATION (hard constraint #1 — cards write the GLOBAL patch/ydoc):
  //   The cards mutate the singleton `patch`/`ydoc` (graph/store + mutate.ts).
  //   A naive mount would scribble on the user's real rack. So on mount we
  //   `bindRackspace(<throwaway sandbox id>)` — which creates a FRESH, LOCAL
  //   Y.Doc and is provably local-only: bindRackspace does NOT attach the
  //   Hocuspocus relay/provider (that is a SEPARATE attachProvider call made
  //   only by the rackspace page, never here), so no multiplayer room is ever
  //   opened on the doc route. On unmount we tear the binding down (restore the
  //   prior bound id, else unbind) so the sandbox can NEVER leak into a real
  //   rack.
  //
  //   We are on a docs route: no real rack is mounted in this JS context (you
  //   left it to navigate here), so rebinding is safe — the real rack's doc is
  //   only live while the rack page is mounted.
  //
  // SvelteFlow context (hard constraint #2 — PatchPanel needs useStore()):
  //   We render the card INSIDE a minimal one-node `<SvelteFlow>`. That gives
  //   PatchPanel's `useStore()` a real flow store and lets SvelteFlow own the
  //   node render + handle measurement exactly as on the canvas, so panels open
  //   and ports get their `data-port-id`/`data-direction` attrs the hover action
  //   resolves against.

  import { onMount, onDestroy } from 'svelte';
  import {
    bindRackspace,
    unbindRackspace,
    getBoundRackspaceId,
    patch,
    ydoc,
    LOCAL_ORIGIN,
  } from '$lib/graph/store';
  import { provideEngineContext } from '$lib/audio/engine-context';
  import type { Component } from 'svelte';
  import type { ModuleNode } from '$lib/graph/types';
  import type { DocIndex } from '$lib/docs/doc-index';
  import { docHover, type DocHoverState } from './use-doc-hover.svelte';

  interface DefLike {
    type: string;
    domain?: string;
    card?: string;
    params?: { id: string; defaultValue: number | null }[];
  }

  interface Props {
    /** Module type id (e.g. 'adsr'). */
    type: string;
    /** The flat doc index — resolution target for the hover action. */
    docIndex: DocIndex;
    /** Reactive hover state (shared with the page's DocHoverPane). */
    hoverState: DocHoverState;
    /** Minimal def info (params + card override) from the server load —
     *  prerender-safe (no live-registry import). */
    def: DefLike;
  }

  let { type, docIndex, hoverState, def }: Props = $props();

  // Provide a NULL engine: cards read AudioParams via useEngine().get(); a null
  // engine makes readLive() a no-op (faders fall back to their stored value) and
  // the worklet/wasm factory never fires (it needs ensureEngine()). So the card
  // renders + is interactive with zero audio.
  provideEngineContext(() => null);

  // ---- Sandbox bind lifecycle ------------------------------------------------
  const DEMO_ID = 'demo';
  const SANDBOX_ID = `__docs-sandbox__:${type}`;
  let prevBoundId: string | null = null;
  let bound = $state(false);

  function seedSandboxNode() {
    // Defaults straight off the def's params (prerender-safe shape).
    const params: Record<string, number> = {};
    for (const p of def.params ?? []) {
      if (p.defaultValue !== null && p.defaultValue !== undefined) params[p.id] = p.defaultValue;
    }
    const node: ModuleNode = {
      id: DEMO_ID,
      type: type as ModuleNode['type'],
      domain: (def.domain ?? 'audio') as ModuleNode['domain'],
      position: { x: 0, y: 0 },
      params,
      data: {},
    };
    // Write into the SANDBOX patch (now the bound singleton) in one transaction.
    ydoc.transact(() => {
      patch.nodes[DEMO_ID] = node;
    }, LOCAL_ORIGIN);
  }

  // The live node the card reads from `data.node` — re-read from the sandbox
  // store so step grids / params that read `patch.nodes[id]` stay consistent.
  let demoNode = $state<ModuleNode | null>(null);

  // ---- Card-type map (dynamic, client-only) ---------------------------------
  let CardComponent = $state<Component | null>(null);
  // xyflow pieces, loaded dynamically so they never touch the prerender bundle.
  let Flow = $state<Component | null>(null);
  let nodeTypes = $state<Record<string, Component>>({});
  let flowNodes = $state<unknown[]>([]);

  onMount(() => {
    let cancelled = false;
    (async () => {
      // Capture + swap to the throwaway sandbox BEFORE the card mounts.
      prevBoundId = getBoundRackspaceId();
      bindRackspace(SANDBOX_ID);
      seedSandboxNode();
      demoNode = patch.nodes[DEMO_ID] as ModuleNode;

      // Dynamic imports keep all of this out of the prerender server bundle.
      const [{ buildNodeTypes }, { SvelteFlow }] = await Promise.all([
        import('$lib/ui/modules-card-map'),
        import('@xyflow/svelte'),
      ]);
      if (cancelled) return;
      const nt = buildNodeTypes([{ type: def.type, card: def.card }]);
      CardComponent = nt[def.type] ?? null;
      nodeTypes = nt;
      Flow = SvelteFlow as unknown as Component;
      flowNodes = [
        {
          id: DEMO_ID,
          type: def.type,
          position: { x: 0, y: 0 },
          // Mirror the canvas node-prop shape: the card reads `data.node`.
          data: { node: demoNode },
          draggable: false,
          selectable: false,
          deletable: false,
          connectable: true,
        },
      ];
      bound = true;
    })();

    return () => {
      cancelled = true;
    };
  });

  onDestroy(() => {
    // Tear the sandbox down so it can NEVER leak into a real rack. Remove the
    // demo node, then restore the prior binding (or unbind). On a docs route no
    // real rack doc is live in this context, so rebinding is a safe reset.
    try {
      if (getBoundRackspaceId() === SANDBOX_ID) {
        ydoc.transact(() => {
          delete patch.nodes[DEMO_ID];
        }, LOCAL_ORIGIN);
        if (prevBoundId && prevBoundId !== SANDBOX_ID) bindRackspace(prevBoundId);
        else unbindRackspace();
      }
    } catch {
      /* best-effort teardown */
    }
  });
</script>

<!--
  The hover action lives on the root so it captures hovers on BOTH the faceplate
  controls AND the portaled patch-panel chrome (the chrome portals to <body>, so
  the listener is delegated in CAPTURE phase from the document — but the chrome
  carries its own data-port-id rows, and the action's onOver is bound on this
  node in capture; the portaled rows bubble up via the body, so we also resolve
  port rows by their attributes regardless of DOM ancestry). To be robust to the
  portal, the page also wires a document-level fallback (see +page.svelte).
-->
<div
  class="virtual-module"
  data-testid="virtual-module"
  data-module-type={type}
  use:docHover={{ docIndex, state: hoverState }}
>
  {#if bound && Flow && CardComponent}
    {@const FlowC = Flow}
    <div class="flow-host" data-testid="virtual-module-flow">
      <FlowC
        nodes={flowNodes}
        edges={[]}
        {nodeTypes}
        fitView
        colorMode="dark"
        nodesDraggable={false}
        nodesConnectable={true}
        zoomOnScroll={false}
        zoomOnDoubleClick={false}
        panOnDrag={false}
        panOnScroll={false}
        preventScrolling={false}
        proOptions={{ hideAttribution: true }}
      />
    </div>
  {:else}
    <div class="vm-loading" data-testid="virtual-module-loading">loading live module…</div>
  {/if}
</div>

<style>
  .virtual-module {
    position: relative;
  }
  .flow-host {
    /* Medium-light gray inspector backdrop — SvelteFlow's pane defaults to
       white, which is jarring against the dark theme. */
    --vm-backdrop: #b4b9c0;
    position: relative;
    width: 100%;
    height: 420px;
    border: 1px solid var(--doc-border-dim, #062b32);
    border-radius: 6px;
    background: var(--vm-backdrop);
    --xy-background-color: var(--vm-backdrop);
    overflow: hidden;
  }
  /* Override SvelteFlow's pane background (the white that bleeds behind the
     card) with the gray backdrop. Scoped to this component's flow-host. */
  .flow-host :global(.svelte-flow),
  .flow-host :global(.svelte-flow__pane) {
    background: var(--vm-backdrop);
  }
  /* Keep the card legible in the doc viewport: xyflow's fitView handles scale. */
  .flow-host :global(.svelte-flow__attribution) {
    display: none;
  }
  .vm-loading {
    height: 420px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--doc-fg-dim, #6e7a82);
    border: 1px dashed var(--doc-border-dim, #062b32);
    border-radius: 6px;
    font-size: 0.85rem;
  }
</style>

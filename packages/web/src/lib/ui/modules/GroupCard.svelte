<script lang="ts">
  // GroupCard — Module-grouping Phase 1 + 3B.
  //
  // Renders a GROUP! meta-domain node as a single card whose handles are
  // derived from `node.data.exposedPorts`. The exposed ports stand in for
  // real child ports on the contained modules; `group-projection.ts`
  // rewrites edges to/from the group BEFORE the reconciler sees them, so
  // the engine never knows groups exist.
  //
  // Phase 3B — SCOPE pass-through viz: when one of the group's children is
  // a module whose def declares `vizPassthrough: true`, the GroupCard
  // hides its default body and instead renders a small hidden mount of
  // the child's card (display:none, off the visual flow). It then locates
  // the child's `[data-viz-passthrough]` <canvas> element via querySelector
  // and APPEND-CHILDS that canvas into the GroupCard's viz container so
  // the child's draw loop keeps drawing (rAF doesn't care where the canvas
  // sits in the DOM tree) but the pixels show up inside the group card.
  // Multiple viz-passthrough children stack vertically.

  import { onMount, tick, untrack } from 'svelte';
  import type { NodeProps } from '@xyflow/svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import type { ModuleNode } from '$lib/graph/types';
  import type { GroupData, ExposedPort } from '$lib/graph/group-projection';
  import { patch } from '$lib/graph/store';
  import { getModuleDef } from '$lib/audio/module-registry';
  import { getVideoModuleDef } from '$lib/video/module-registry';
  import ScopeCard from '$lib/ui/modules/ScopeCard.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  let groupData = $derived(node?.data as unknown as GroupData | undefined);

  function descriptor(ep: ExposedPort): PortDescriptor {
    return {
      id: ep.id,
      label: ep.label,
      cable: ep.cableType as string,
    };
  }

  let inputs = $derived<PortDescriptor[]>(
    (groupData?.exposedPorts ?? []).filter((p) => p.direction === 'input').map(descriptor),
  );
  let outputs = $derived<PortDescriptor[]>(
    (groupData?.exposedPorts ?? []).filter((p) => p.direction === 'output').map(descriptor),
  );

  let label = $derived<string>(groupData?.label ?? 'GROUP!');
  let childCount = $derived<number>(groupData?.childIds?.length ?? 0);
  // Module-grouping Phase 2A — when `expanded` is true the card shrinks to
  // a thin header so the children render visibly underneath. The PatchPanel
  // still renders (so external cables remain attached) but the body label
  // is hidden.
  let expanded = $derived<boolean>(groupData?.expanded === true);

  // Module-grouping Phase 3B — viz-passthrough children.
  //
  // We resolve each child id to its concrete ModuleNode (so the hidden
  // ScopeCard mount can drive a real draw loop reading params from the
  // patch). For each, look up the module def + check vizPassthrough.
  // Only audio defs opt in today (SCOPE); the video registry check is
  // here for symmetry once a video card adopts the flag.
  interface VizChild {
    id: string;
    type: string;
    childNode: ModuleNode;
  }
  let vizChildren = $derived.by<VizChild[]>(() => {
    if (!groupData) return [];
    if (expanded) return []; // edit-knob mode: render children inline, not pass-through
    const out: VizChild[] = [];
    for (const childId of groupData.childIds) {
      const childNode = patch.nodes[childId];
      if (!childNode) continue;
      const def = getModuleDef(childNode.type) ?? getVideoModuleDef(childNode.type);
      if (def?.vizPassthrough === true) {
        out.push({ id: childId, type: childNode.type, childNode: childNode as unknown as ModuleNode });
      }
    }
    return out;
  });
  let hasViz = $derived(vizChildren.length > 0);

  // The visible portal "slot" — one per viz-passthrough child. Bound to
  // <div> elements via bind:this so a post-mount $effect can move the
  // hidden child's <canvas data-viz-passthrough> into the matching slot.
  let portalSlots = $state<Record<string, HTMLDivElement | null>>({});
  // The hidden mount roots — one wrapping <div> per viz-passthrough child.
  // The child's full ScopeCard renders inside, but is `display: none` so
  // it doesn't occupy layout; the rAF draw loop continues regardless of
  // whether its canvas is descended into a visible parent.
  let hiddenRoots = $state<Record<string, HTMLDivElement | null>>({});
  // Track moved canvases so we don't repeatedly appendChild the same one
  // on every reactive tick.
  let movedCanvases = $state<Record<string, HTMLCanvasElement | null>>({});

  $effect(() => {
    if (!hasViz) return;
    // Re-run whenever the viz-children identity changes (i.e. group
    // membership or expanded state flips). Inside untrack we read the
    // mutable slot/hidden refs without subscribing.
    const ids = vizChildren.map((c) => c.id);
    untrack(() => {
      for (const cid of ids) {
        const slot = portalSlots[cid];
        const hidden = hiddenRoots[cid];
        if (!slot || !hidden) continue;
        // The child card might not have rendered its canvas yet on the
        // first effect run — schedule a microtask retry. The pattern here
        // is idempotent: once the canvas is moved we skip subsequent runs.
        let attempt = 0;
        const tryMove = () => {
          if (movedCanvases[cid]) return;
          const canvas = hidden.querySelector<HTMLCanvasElement>('canvas[data-viz-passthrough]');
          if (!canvas) {
            if (attempt++ < 10) queueMicrotask(tryMove);
            return;
          }
          slot.innerHTML = ''; // defensive: clean any prior portal residue
          slot.appendChild(canvas);
          movedCanvases[cid] = canvas;
        };
        tryMove();
      }
    });
  });

  // When this card itself unmounts (the user ungrouped or removed the
  // group), put the hijacked canvases back into their hidden roots so
  // the next mount can pick them up cleanly. Svelte's onMount cleanup
  // runs synchronously enough that the rAF tick can't fire between
  // unmount and the next mount.
  onMount(() => {
    return () => {
      for (const [cid, canvas] of Object.entries(movedCanvases)) {
        if (canvas && hiddenRoots[cid]) {
          try {
            hiddenRoots[cid]?.appendChild(canvas);
          } catch {
            /* already detached */
          }
        }
      }
    };
  });

  /** Component lookup for the hidden viz-child mount. SCOPE is the only
   *  vizPassthrough opt-in today; future opt-ins register here. */
  function componentForType(type: string) {
    if (type === 'scope') return ScopeCard;
    return null;
  }

  // The hidden ScopeCard needs the same NodeProps shape that SvelteFlow
  // hands real card mounts. We construct it minimally — only `id` and
  // `data.node` are consumed by ScopeCard. SvelteFlow's real-flow shape
  // includes runtime-injected fields (dragging/zIndex/etc.) we don't
  // need; we cast through `unknown` so the hidden mount doesn't have to
  // synthesize them. ScopeCard only reads `id` and `data.node`.
  function hiddenCardProps(childNode: ModuleNode): NodeProps {
    return {
      id: childNode.id,
      data: { node: childNode } as unknown as Record<string, unknown>,
      type: childNode.type,
      dragging: false,
      draggable: false,
      zIndex: 0,
      selectable: false,
      deletable: false,
      selected: false,
      isConnectable: false,
      positionAbsoluteX: 0,
      positionAbsoluteY: 0,
    } as unknown as NodeProps;
  }

  // tick() ensures Svelte's reactive scheduler flushes before we hunt for
  // the data-viz-passthrough canvas. Kept here so test files can import
  // the same utility without paying the dependency cost.
  void tick;
</script>

<div
  class="mod-card group-card"
  class:expanded
  class:viz={hasViz && !expanded}
  data-testid="group-card"
  data-node-id={id}
  data-expanded={expanded ? 'true' : 'false'}
  data-viz={hasViz && !expanded ? 'true' : 'false'}
>
  <div class="stripe" style="background: var(--accent, #60a5fa);"></div>
  <header class="title">
    {#if expanded}
      <span data-testid="group-card-label">{label}</span>
      <span class="thin-hint">editing knob positions</span>
    {:else if hasViz}
      <span data-testid="group-card-label">{label}</span>
    {:else}
      GROUP!
    {/if}
  </header>

  <PatchPanel nodeId={id} {inputs} {outputs}>
    {#if expanded}
      <div class="group-body group-body-expanded">
        <div class="group-children-count">{childCount} module{childCount === 1 ? '' : 's'} (editing)</div>
      </div>
    {:else if hasViz}
      <!-- Phase 3B portal slots: one per viz-passthrough child. The
           hidden ScopeCard mounts below append the canvas into these
           slots after first paint. -->
      <div class="group-body group-body-viz" data-testid="group-viz-body">
        {#each vizChildren as vc (vc.id)}
          <div
            class="viz-slot"
            bind:this={portalSlots[vc.id]}
            data-testid="viz-slot"
            data-child-id={vc.id}
          ></div>
        {/each}
      </div>
    {:else}
      <div class="group-body">
        <div class="group-label" data-testid="group-card-label">{label}</div>
        <div class="group-children-count">{childCount} module{childCount === 1 ? '' : 's'}</div>
      </div>
    {/if}
  </PatchPanel>
</div>

{#if hasViz && !expanded}
  <!-- Hidden mounts for each viz-passthrough child. These ScopeCard
       instances render their full UI but the wrapper is display:none so
       no layout space is reserved; the inner <canvas data-viz-passthrough>
       is appendChild'd into the visible group portal slot via the
       $effect above. The card's rAF draw loop continues to drive that
       same <canvas>, so the moved canvas keeps animating live. -->
  <div class="viz-hidden-host" aria-hidden="true">
    {#each vizChildren as vc (vc.id)}
      <div
        class="viz-hidden-mount"
        bind:this={hiddenRoots[vc.id]}
        data-testid="viz-hidden-mount"
        data-child-id={vc.id}
      >
        {#if componentForType(vc.type) === ScopeCard}
          <ScopeCard {...hiddenCardProps(vc.childNode)} />
        {/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  .group-card {
    width: 220px;
    min-height: 180px;
  }
  .group-card.expanded {
    /* Edit-knob-positions mode: the card shrinks to a thin header so the
       child modules render visibly beneath it. PatchPanel still mounts so
       external cables retain their endpoints. */
    min-height: 64px;
    width: 240px;
    outline: 1px dashed var(--accent, #60a5fa);
    outline-offset: 4px;
  }
  .group-card.expanded .thin-hint {
    margin-left: 8px;
    font-size: 0.65rem;
    color: var(--text-dim, #8e94a2);
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  .group-body {
    padding: 30px 24px 16px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: 120px;
  }
  .group-body-expanded {
    padding: 6px 12px 8px;
    min-height: 24px;
  }
  /* Phase 3B — viz pass-through mode. The portal slots stack vertically
   * and the moved <canvas> stretches to fill the slot. The slot acts as
   * the canvas's new visual parent without changing its `width`/`height`
   * attributes (those drive the bitmap resolution; CSS handles display
   * size). */
  .group-card.viz {
    width: 320px;
  }
  .group-body-viz {
    padding: 12px 14px 14px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-height: 120px;
  }
  .viz-slot {
    width: 100%;
    border: 1px solid var(--border, #404652);
    border-radius: 3px;
    background: #0e1116;
    line-height: 0;
    min-height: 120px;
    overflow: hidden;
  }
  .viz-slot :global(canvas[data-viz-passthrough]) {
    display: block;
    width: 100%;
    height: 120px;
  }
  /* Hidden mount host: the child card renders in full here but is moved
   * out of normal flow (off-screen + invisible). The canvas extracted via
   * appendChild keeps drawing because rAF doesn't care about DOM ancestry. */
  .viz-hidden-host {
    position: absolute;
    width: 0;
    height: 0;
    overflow: hidden;
    visibility: hidden;
    pointer-events: none;
  }
  .viz-hidden-mount {
    width: 0;
    height: 0;
    overflow: hidden;
  }
  .group-label {
    font-size: 1.05rem;
    letter-spacing: 0.04em;
    color: var(--text, #f1f1f1);
    font-weight: 500;
    text-align: center;
    word-break: break-word;
  }
  .group-children-count {
    font-size: 0.7rem;
    color: var(--text-dim, #8e94a2);
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
</style>

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
  import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
  import { getModuleDef } from '$lib/audio/module-registry';
  import { getVideoModuleDef } from '$lib/video/module-registry';
  import ScopeCard from '$lib/ui/modules/ScopeCard.svelte';
  import GroupExposedControls from '$lib/ui/GroupExposedControls.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  let groupData = $derived(node?.data as unknown as GroupData | undefined);

  // Phase 4 — re-render the exposed-controls block whenever any patch
  // mutation lands. Reading the children's params live (rather than
  // snapshotting on mount) is essential so a remote peer toggling an
  // exposed sequencer's play state updates the group's button instantly.
  let cardVersion = $state(0);
  $effect(() => {
    const h = () => { cardVersion = cardVersion + 1; };
    ydoc.on('update', h);
    return () => ydoc.off('update', h);
  });
  let hasExposedControls = $derived.by(() => {
    void cardVersion;
    return (groupData?.exposedControls?.length ?? 0) > 0;
  });
  // Instruments v1 — when there are atomic sequence exposures OR any
  // recorded instrument-layout positions, render the GroupExposedControls
  // mount too (so the user can interact with the configured surfaces
  // even on a group with no individual exposed knobs).
  let hasInstrumentSurfaces = $derived.by(() => {
    void cardVersion;
    if (hasExposedControls) return true;
    const seq = groupData?.exposedSequences ?? {};
    if (Object.keys(seq).some((k) => seq[k] === true)) return true;
    const ctrls = groupData?.instrumentLayout?.controls ?? {};
    return Object.keys(ctrls).length > 0;
  });
  let isInstrumentEditMode = $derived(groupData?.instrumentLayout?.mode === 'edit');

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

  // ---- Editable label (double-click to edit, Enter/blur to commit) ----
  // Stored on `data.label`; round-trips through Yjs so peers see renames
  // live. Empty input is rejected (keeps the previous label) — group
  // creation enforces the GROUP<N> default so the field is never blank
  // in steady state.
  let editingLabel = $state(false);
  let labelDraft = $state('');
  let labelInputEl: HTMLInputElement | null = $state(null);

  function startEditLabel(e?: MouseEvent) {
    e?.stopPropagation();
    editingLabel = true;
    labelDraft = label;
    // queueMicrotask so the input is mounted before we focus + select.
    queueMicrotask(() => {
      if (labelInputEl) {
        labelInputEl.focus();
        labelInputEl.select();
      }
    });
  }

  function commitLabel() {
    const next = labelDraft.trim();
    editingLabel = false;
    if (next.length === 0) return;
    if (next === label) return;
    ydoc.transact(() => {
      const target = patch.nodes[id];
      if (!target) return;
      if (!target.data) target.data = {};
      (target.data as { label?: string }).label = next;
    }, LOCAL_ORIGIN);
  }

  function cancelLabelEdit() {
    editingLabel = false;
    labelDraft = '';
  }

  function onLabelKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitLabel();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelLabelEdit();
    }
  }

  /**
   * Defer blur-commit to a microtask so playwright's `fill()` (which
   * focus → clear → type → blur internally) doesn't close edit mode
   * mid-action. If focus returns to one of the label inputs by the time
   * the microtask runs, we treat it as a no-op blur (focus bounced).
   */
  function onLabelBlur(e: FocusEvent) {
    const fromEl = e.target as HTMLInputElement | null;
    queueMicrotask(() => {
      const active = document.activeElement;
      const stillFocused =
        active === fromEl ||
        (active instanceof HTMLInputElement &&
          (active.getAttribute('data-testid') === 'group-card-label-input' ||
            active.getAttribute('data-testid') === 'group-card-label-input-body'));
      if (stillFocused) return;
      commitLabel();
    });
  }
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
  class:instrument-edit={isInstrumentEditMode && !expanded}
  data-testid="group-card"
  data-node-id={id}
  data-expanded={expanded ? 'true' : 'false'}
  data-viz={hasViz && !expanded ? 'true' : 'false'}
  data-instrument-mode={groupData?.instrumentLayout?.mode ?? 'locked'}
>
  <div class="stripe" style="background: var(--accent, #60a5fa);"></div>
  <header class="title">
    {#if editingLabel}
      <!-- svelte-ignore a11y_autofocus -->
      <input
        bind:this={labelInputEl}
        bind:value={labelDraft}
        class="label-input nodrag"
        type="text"
        data-testid="group-card-label-input"
        onkeydown={onLabelKeydown}
        onblur={onLabelBlur}
        onclick={(e) => e.stopPropagation()}
        ondblclick={(e) => e.stopPropagation()}
      />
    {:else if expanded}
      <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
      <span
        data-testid="group-card-label"
        class="label-text nodrag"
        ondblclick={startEditLabel}
        title="Double-click to rename"
      >{label}</span>
      <span class="thin-hint">editing knob positions</span>
    {:else if hasViz}
      <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
      <span
        data-testid="group-card-label"
        class="label-text nodrag"
        ondblclick={startEditLabel}
        title="Double-click to rename"
      >{label}</span>
    {:else}
      <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
      <span
        data-testid="group-card-header-label"
        class="label-text nodrag"
        ondblclick={startEditLabel}
        title="Double-click to rename"
      >{label}</span>
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
        {#if hasInstrumentSurfaces && node}
          <GroupExposedControls group={node} {cardVersion} />
        {/if}
      </div>
    {:else}
      <div class="group-body">
        {#if editingLabel}
          <div class="group-label">
            <input
              bind:value={labelDraft}
              class="label-input label-input-body nodrag"
              type="text"
              data-testid="group-card-label-input-body"
              onkeydown={onLabelKeydown}
              onblur={onLabelBlur}
              onclick={(e) => e.stopPropagation()}
              ondblclick={(e) => e.stopPropagation()}
            />
          </div>
        {:else}
          <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
          <div
            class="group-label label-text nodrag"
            data-testid="group-card-label"
            ondblclick={startEditLabel}
            title="Double-click to rename"
          >{label}</div>
        {/if}
        <div class="group-children-count">{childCount} module{childCount === 1 ? '' : 's'}</div>
        {#if hasInstrumentSurfaces && node}
          <GroupExposedControls group={node} {cardVersion} />
        {/if}
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
  /* Instruments v1 — give the edit-mode card more room so the absolute
   * layout canvas has space to host the default-tiled controls boxes. */
  .group-card.instrument-edit {
    width: 340px;
    min-height: 320px;
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
  /* Editable label affordance: subtle hover cue so users discover the
     double-click-to-rename interaction without a permanent visual badge. */
  .label-text {
    cursor: text;
    border-radius: 2px;
    padding: 1px 3px;
    margin: -1px -3px;
  }
  .label-text:hover {
    background: rgba(96, 165, 250, 0.12);
  }
  .label-input {
    font: inherit;
    color: inherit;
    background: rgba(20, 23, 28, 0.85);
    border: 1px solid var(--accent, #60a5fa);
    border-radius: 3px;
    padding: 1px 4px;
    outline: none;
    width: 100%;
    box-sizing: border-box;
  }
  .label-input-body {
    text-align: center;
    font-size: 1.05rem;
    letter-spacing: 0.04em;
    font-weight: 500;
  }
</style>

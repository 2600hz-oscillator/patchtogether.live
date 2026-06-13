<script lang="ts">
  // StickyCard — paper-style sticky note. Domain 'meta'; no engine
  // binding, no handles. Editable textarea (Yjs-synced via patch.nodes
  // proxy), corner-drag resize via the shared card-resize helper.
  // Pickup-mode never activates on a sticky because it has no Handle
  // elements (PR-130's click-pickup is gated on handle clicks).

  import { onDestroy } from 'svelte';
  import { useStore, type NodeProps } from '@xyflow/svelte';
  import { patch } from '$lib/graph/store';
  import { startCornerResize } from './card-resize';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const flowStore = useStore();

  const MIN_WIDTH = 140;
  const MIN_HEIGHT = 80;
  const DEFAULT_WIDTH = 200;
  const DEFAULT_HEIGHT = 120;

  let width = $derived<number>(
    (node?.data?.resizedWidth as number | undefined) ?? DEFAULT_WIDTH,
  );
  let height = $derived<number>(
    (node?.data?.resizedHeight as number | undefined) ?? DEFAULT_HEIGHT,
  );
  let text = $derived<string>(
    typeof node?.data?.text === 'string' ? (node!.data!.text as string) : '',
  );

  function onTextInput(ev: Event) {
    const t = ev.target as HTMLTextAreaElement;
    const target = patch.nodes[id];
    if (!target) return;
    if (!target.data) target.data = {};
    target.data.text = t.value;
  }

  let resizing = $state(false);
  let resizeAbort: AbortController | null = null;

  function onResizeStart(ev: PointerEvent) {
    resizeAbort = startCornerResize(ev, {
      flowStore,
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      snapTo: 1, // STICKY is a free-form note — no rack-grid snapping
      getStartSize: () => ({ width, height }),
      apply: (w, h) => {
        const target = patch.nodes[id];
        if (!target) return;
        if (!target.data) target.data = {};
        target.data.resizedWidth = w;
        target.data.resizedHeight = h;
      },
      onStart: () => { resizing = true; },
      onEnd: () => { resizing = false; resizeAbort = null; },
    });
  }

  onDestroy(() => {
    if (resizeAbort) resizeAbort.abort();
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions a11y_no_noninteractive_element_interactions -->
<div
  class="sticky-card"
  class:resizing
  style="width: {width}px; height: {height}px;"
  data-testid="sticky-card"
  data-node-id={id}
>
  <span class="sticky-badge" aria-label="STICKY">STICKY</span>
  <textarea
    class="sticky-text nodrag"
    value={text}
    oninput={onTextInput}
    placeholder="note…"
    spellcheck="false"
    data-testid="sticky-textarea"
    data-node-id={id}
  ></textarea>
  <div
    class="resize-handle nodrag"
    role="separator"
    aria-label="Resize sticky note"
    data-testid="sticky-resize-handle"
    onpointerdown={onResizeStart}
  ></div>
</div>

<style>
  .sticky-card {
    background: var(--sticky-bg, #f6e58d);
    color: var(--sticky-text, #2a2400);
    border: 1px solid var(--sticky-border, #d8c356);
    border-radius: 2px;
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25);
    position: relative;
    overflow: hidden;
    box-sizing: border-box;
  }
  .sticky-card.resizing {
    transition: none;
  }
  :global(.svelte-flow__node:hover) .sticky-card { border-color: var(--sticky-border-hover, #b8a13a); }
  :global(.svelte-flow__node.selected) .sticky-card {
    border-color: var(--accent, #60a5fa);
    box-shadow: 0 0 0 1px var(--accent-glow, rgba(96, 165, 250, 0.35)), 0 2px 6px rgba(0, 0, 0, 0.25);
  }
  .sticky-badge {
    position: absolute;
    top: 2px;
    left: 6px;
    font-size: 0.55rem;
    letter-spacing: 0.08em;
    color: rgba(42, 36, 0, 0.55);
    font-family: ui-monospace, monospace;
    pointer-events: none;
    user-select: none;
  }
  .sticky-text {
    width: 100%;
    height: 100%;
    background: transparent;
    border: none;
    outline: none;
    resize: none;
    color: inherit;
    font-family: inherit;
    font-size: 0.85rem;
    line-height: 1.3;
    padding: 8px 10px 14px;
    box-sizing: border-box;
  }
  .sticky-text::placeholder { color: rgba(42, 36, 0, 0.4); }
  .resize-handle {
    position: absolute;
    right: 0;
    bottom: 0;
    width: 14px;
    height: 14px;
    cursor: nwse-resize;
    background: linear-gradient(
      135deg,
      transparent 50%,
      var(--sticky-border, #d8c356) 50%,
      var(--sticky-border, #d8c356) 60%,
      transparent 60%,
      transparent 75%,
      var(--sticky-border, #d8c356) 75%,
      var(--sticky-border, #d8c356) 85%,
      transparent 85%
    );
    opacity: 0.7;
    z-index: 5;
  }
  .resize-handle:hover { opacity: 1; }
</style>

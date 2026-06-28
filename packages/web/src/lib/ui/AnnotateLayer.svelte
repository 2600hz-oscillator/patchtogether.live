<script lang="ts">
  // AnnotateLayer — drives "Annotate" mode for ONE live on-canvas module.
  //
  // Hosted by PatchPanel (every card has exactly one), so it mounts per-node with
  // the nodeId in hand. When annotate mode is ON for this node it:
  //   1. arms a DOCUMENT-level capture hover/focus resolver (reuse use-doc-hover's
  //      resolveHover) — listening on document, not the card, so it also catches
  //      the patch panel's PORTALED port rows (which live under <body>, not the
  //      card). Resolution is SCOPED to THIS node: a hovered element only resolves
  //      when it sits inside this node's card root OR this node's portaled chrome.
  //   2. renders the anchored AnnotatePopover next to the hovered element.
  //   3. shows a subtle "mode is on" cue (a 📖 badge + a faint outline on the card)
  //      so the user knows it's active.
  //
  // It does NOT intercept clicks/drags — the document listeners are passive
  // mouseover/focusin only, and the popover is pointer-events:none — so using the
  // module (turning a knob, clicking a port) works exactly as normal while on.
  import { onDestroy, untrack } from 'svelte';
  import type { DocIndex } from '$lib/docs/doc-index';
  import { resolveHover, type HoverRef } from '$lib/docs/interactive/use-doc-hover.svelte';
  import { isAnnotating } from '$lib/ui/annotate-mode.svelte';
  import AnnotatePopover from './AnnotatePopover.svelte';

  interface Props {
    nodeId: string;
    /** The live doc index for this module (null when undocumented → inert). */
    docIndex: DocIndex | null;
  }

  let { nodeId, docIndex }: Props = $props();

  let on = $derived(docIndex !== null && isAnnotating(nodeId));

  let hovered = $state<HoverRef | null>(null);
  let anchor = $state<DOMRect | null>(null);
  let anchorEl: HTMLElement | null = null;

  /** Is `el` part of THIS node's surfaces (its card root or its portaled chrome)?
   *  Scopes resolution so a second annotating card never resolves over this one. */
  function withinThisNode(el: Element): boolean {
    if (el.closest(`.svelte-flow__node[data-id="${CSS.escape(nodeId)}"]`)) return true;
    if (el.closest(`[data-patch-panel-chrome="${CSS.escape(nodeId)}"]`)) return true;
    return false;
  }

  function clear() {
    hovered = null;
    anchor = null;
    anchorEl = null;
  }

  function onOver(e: Event) {
    const target = e.target;
    if (!(target instanceof Element) || !docIndex) return;
    if (!withinThisNode(target)) {
      // Pointer moved to something that isn't this card/chrome → hide.
      if (hovered) clear();
      return;
    }
    const ref = resolveHover(target, docIndex);
    if (!ref) {
      // Inside the card but over blank chrome (title bar, gaps) → hide.
      if (hovered) clear();
      return;
    }
    // Anchor to the element the ref resolved FROM (the port row / control), so the
    // popover sits next to that exact element. Re-find it from the target chain.
    const el =
      target.closest<HTMLElement>('[data-port-id][data-direction]') ??
      target.closest<HTMLElement>('[data-testid^="control-"]') ??
      target.closest<HTMLElement>('[data-testid]') ??
      (target as HTMLElement);
    anchorEl = el;
    anchor = el.getBoundingClientRect();
    hovered = ref;
  }

  // Arm/disarm the document listeners with the mode. Capture phase so it sees
  // events before they're stopped, and reaches the portaled port rows too.
  $effect(() => {
    if (!on) {
      untrack(() => clear());
      return;
    }
    const over = (e: Event) => onOver(e);
    document.addEventListener('mouseover', over, true);
    document.addEventListener('focusin', over, true);
    return () => {
      document.removeEventListener('mouseover', over, true);
      document.removeEventListener('focusin', over, true);
    };
  });

  // Keep the popover glued to the anchor while open (the card pans/scrolls under
  // SvelteFlow, the patch panel chrome re-positions). Cheap rAF only while a hover
  // is live; re-reads the SAME element's rect, no Svelte re-render churn.
  $effect(() => {
    if (!on || !anchorEl) return;
    let raf = 0;
    const tick = () => {
      if (anchorEl && anchorEl.isConnected) anchor = anchorEl.getBoundingClientRect();
      else untrack(() => clear());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  });

  onDestroy(() => clear());

  // The "mode is on" cue: a 📖 badge anchored to the card top-center + a faint
  // outline. We portal a fixed-position badge tracking the card rect (the card
  // lives under the SvelteFlow transform, so a fixed badge avoids inheriting it).
  let badgeRect = $state<DOMRect | null>(null);
  $effect(() => {
    if (!on) {
      untrack(() => { badgeRect = null; });
      return;
    }
    let raf = 0;
    const tick = () => {
      const card = document.querySelector<HTMLElement>(
        `.svelte-flow__node[data-id="${CSS.escape(nodeId)}"]`,
      );
      badgeRect = card ? card.getBoundingClientRect() : null;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  });

  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return { destroy() { node.remove(); } };
  }
</script>

{#if on && docIndex}
  <!-- "Annotate ON" cue: a faint outline on the card + a 📖 badge. -->
  {#if badgeRect}
    <div use:portal>
      <div
        class="annotate-outline"
        aria-hidden="true"
        style:left="{badgeRect.left}px"
        style:top="{badgeRect.top}px"
        style:width="{badgeRect.width}px"
        style:height="{badgeRect.height}px"
      ></div>
      <div
        class="annotate-badge"
        data-testid="annotate-badge"
        data-node-id={nodeId}
        title="Annotate mode on — hover a control or port to see its docs"
        style:left="{badgeRect.left + badgeRect.width / 2}px"
        style:top="{badgeRect.top}px"
      >📖</div>
    </div>
  {/if}

  <AnnotatePopover {hovered} {anchor} {docIndex} />
{/if}

<style>
  .annotate-outline {
    position: fixed;
    z-index: 1100;
    pointer-events: none;
    border: 1.5px dashed var(--accent, #2bb6c8);
    border-radius: 4px;
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent, #2bb6c8) 18%, transparent);
    opacity: 0.7;
  }
  .annotate-badge {
    position: fixed;
    z-index: 1101;
    transform: translate(-50%, -55%);
    pointer-events: none;
    font-size: 13px;
    line-height: 1;
    padding: 2px 4px;
    border-radius: 4px;
    background: rgba(14, 17, 22, 0.95);
    border: 1px solid var(--accent, #2bb6c8);
    filter: drop-shadow(0 1px 3px rgba(0, 0, 0, 0.6));
  }
</style>

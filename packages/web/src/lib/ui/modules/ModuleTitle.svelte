<script lang="ts">
  // ModuleTitle — shared editable title for every module card.
  //
  // Owner spec: "lose the overhead labels and instead put the given label
  // name right on the module where the module name is and make it editable,
  // in all cases".
  //
  // Two render modes:
  //
  //   1. Default (`inline={false}`, the common case): renders the full
  //      `<header class="title">…</header>` so it's a drop-in for the
  //      legacy `<header class="title">XYZ</header>` element. Use this in
  //      cards whose header is just a static slug.
  //
  //   2. `inline={true}`: renders only the editable name span (no
  //      `<header>` wrapper). Use this in cards whose header has extra
  //      children — play buttons, mode toggles, gear menus — so the
  //      ModuleTitle can sit alongside them inside the existing header.
  //
  // ABOUT THE FIELD: the codebase already auto-assigns `node.data.name`
  // (e.g. `ANALOGVCO1`) at spawn + on a load-time migration, and the
  // multiplayer naming rules + uniqueness check live in
  // $lib/multiplayer/module-naming. The owner's spec mentioned `data.label`
  // (used today for GROUPS only); we route the per-module title through
  // the existing `data.name` channel so we don't break LIVECODE addressing,
  // the rename uniqueness validator, or the migration. Both fields end up
  // round-tripped through Y.Doc the same way, so peer-rename sync still
  // works. GroupCard continues to use `data.label` for the group-specific
  // rename UX (see carve-out note in the PR description).
  //
  // FOCUS / DRAG: ModuleNameLabel itself stopPropagation's pointer events
  // on the input and applies `.nodrag` so SvelteFlow doesn't treat a label
  // click as a drag-start.

  import ModuleNameLabel from '$lib/ui/ModuleNameLabel.svelte';
  import { patch } from '$lib/graph/store';
  import type { ModuleNode } from '$lib/graph/types';

  interface Props {
    /** The module node id (the FlowNode id). */
    id: string;
    /** SvelteFlow node-data payload as passed to every module card. */
    data: unknown;
    /** Default display when the user has never edited the name — almost
     *  always the module-type slug uppercased, e.g. "WAVESCULPT". */
    defaultLabel: string;
    /** When true, render only the editable label (no `<header>` wrapper).
     *  Use this in cards whose header has extra siblings (play buttons,
     *  mode toggles, etc.) and slot ModuleTitle alongside them inside the
     *  existing `<header class="title">`. Defaults to false. */
    inline?: boolean;
  }

  let { id, data, defaultLabel, inline = false }: Props = $props();

  // The card's `data` prop carries `{ node: ModuleNode, ... }`. Resolve
  // through the live patch store too so a remote rename lands here
  // without waiting for the parent to re-derive its $derived chain. If
  // neither source has the node (transient mount-before-snapshot), render
  // the default fallback string.
  let resolvedNode = $derived.by<ModuleNode | undefined>(() => {
    const fromData = (data as { node?: ModuleNode } | undefined)?.node;
    if (fromData) return fromData;
    return patch.nodes[id] as ModuleNode | undefined;
  });
</script>

{#if inline}
  {#if resolvedNode}
    <ModuleNameLabel node={resolvedNode} {defaultLabel} />
  {:else}
    <span class="fallback">{defaultLabel}</span>
  {/if}
{:else}
  <header class="title">
    {#if resolvedNode}
      <ModuleNameLabel node={resolvedNode} {defaultLabel} />
    {:else}
      <span class="fallback">{defaultLabel}</span>
    {/if}
  </header>
{/if}

<style>
  /* The .title selector lives in _module-card.css and is shared by every
   * card. We deliberately don't restate it here so the existing global
   * styling (font, size, letter-spacing, margin) keeps applying — the
   * unedited title renders byte-identically to before, which is what
   * keeps the VRT baselines stable.
   *
   * The fallback span is only hit on the briefest transient (node
   * unresolved); style it like the inline name button so the card
   * doesn't visibly snap on first paint. */
  .fallback {
    font: inherit;
    color: inherit;
  }
</style>

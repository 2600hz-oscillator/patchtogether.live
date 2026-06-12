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
  import { patch, ydoc } from '$lib/graph/store';
  import { resolveControlColor } from '$lib/graph/control-color';
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

  // Re-derive the colour dot on any Yjs update so an assign / reset / undo /
  // remote change reflects immediately (the dot has no other reactive trigger —
  // a nested node.data.controlColor write isn't deeply tracked through the
  // SyncedStore proxy by a plain $derived read). Mirrors the cards' cardVersion
  // pump, scoped to just the dot.
  let docVersion = $state(0);
  $effect(() => {
    const h = () => { docVersion = docVersion + 1; };
    ydoc.on('update', h);
    return () => ydoc.off('update', h);
  });

  // CONTROL COLOUR dot — a subtle swatch by the title showing this module's
  // resolved control colour, but ONLY once the user has EXPLICITLY assigned one
  // (data.controlColor). The auto per-instance default applies to every module,
  // so showing it always would put a dot on every card; we keep it subtle by
  // surfacing it only where the user actually set it. (Plan Decision D.) Reads
  // through the live patch node so a remote / undo colour change reflects.
  let controlColor = $derived.by<string | null>(() => {
    void docVersion;
    const live = patch.nodes[id] as ModuleNode | undefined;
    const assigned = (live?.data as { controlColor?: unknown } | undefined)?.controlColor;
    if (typeof assigned !== 'string') return null;
    return resolveControlColor(live); // normalized/quantized resolved colour
  });
</script>

{#if inline}
  {#if controlColor}
    <span
      class="control-color-dot"
      data-testid="control-color-dot"
      style:background={`#${controlColor}`}
      title="Control colour"
    ></span>
  {/if}
  {#if resolvedNode}
    <ModuleNameLabel node={resolvedNode} {defaultLabel} />
  {:else}
    <span class="fallback">{defaultLabel}</span>
  {/if}
{:else}
  <header class="title">
    {#if controlColor}
      <span
        class="control-color-dot"
        data-testid="control-color-dot"
        style:background={`#${controlColor}`}
        title="Control colour"
      ></span>
    {/if}
    {#if resolvedNode}
      <ModuleNameLabel node={resolvedNode} {defaultLabel} />
    {:else}
      <span class="fallback">{defaultLabel}</span>
    {/if}
  </header>
{/if}

<style>
  /* Title styling lives here, NOT in each card. When the title element
   * was inlined in each card's `<style>` block, Svelte's component-scoped
   * CSS applied. Now that ModuleTitle owns the <header.title> element,
   * those per-card scoped rules can't reach across component boundaries.
   * Restate the shared baseline here with `:global` so a card-local
   * scoped rule on `.title` can still override (e.g. cards that bump
   * font-size for a longer name don't need to change).
   *
   * Scoping to `.svelte-flow__node .title` keeps this from leaking out
   * to non-module surfaces that happen to use a `.title` class
   * (browser-level title chrome elsewhere). */
  :global(.svelte-flow__node .title) {
    font-size: 0.85rem;
    font-weight: 500;
    text-align: center;
    margin: 0 0 8px;
    /* Letter-spacing: pre-PR each card carried its own .title rule with a
     * per-card letter-spacing (0.02–0.12em range). Svelte's CSS scoping
     * removed those rules once `.title` moved into ModuleTitle's child
     * template, so we publish a SINGLE shared value here. 0.05em is the
     * mode across the 67 cards that previously declared one. VRT baselines
     * are regenerated for cards whose pre-PR value differed (legitimate
     * cosmetic drift; the title is byte-identical for the 41 cards that
     * already used 0.05em). */
    letter-spacing: 0.05em;
  }
  /* The fallback span is only hit on the briefest transient (node
   * unresolved); style it like the inline name button so the card
   * doesn't visibly snap on first paint. */
  .fallback {
    font: inherit;
    color: inherit;
  }
  /* Subtle control-colour swatch by the title (shown only when the user has
     explicitly assigned a colour). A small inline dot — purposely understated. */
  .control-color-dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    margin-right: 4px;
    vertical-align: middle;
    border: 1px solid rgba(0, 0, 0, 0.35);
    flex: none;
  }
</style>

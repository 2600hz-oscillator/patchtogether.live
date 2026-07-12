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
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
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

  // Node-scoped re-derive (phase-2 CC perf fix): subscribe to THIS node's
  // version from the shared registry (nodes.observeDeep) instead of a
  // per-component whole-doc ydoc.on('update') pump — a commit on another
  // module no longer re-runs this card's derived chain.
  let docVersion = $derived(nodeVersion(id));

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
   * (browser-level title chrome elsewhere). The `.dock-*-sized` selectors
   * are the DOCK-HOST mirror (P2.5a plain-mount: DockCardHost + the 🎧
   * panel hosts have no .svelte-flow__node wrapper) — without them a
   * dock-hosted card's title lost the centering/margin baseline and
   * rendered flush against the corner patch trigger. */
  :global(.svelte-flow__node .title),
  :global(.dock-rack-sized .title),
  :global(.dock-natural-sized .title) {
    font-size: 0.85rem;
    font-weight: 500;
    text-align: center;
    margin: 0 0 8px;
    /* Reserve the top-corner patch-panel drill-down jack icons (PatchPanel
     * `.patch-trigger.left/.right`: 18px wide at a ~4px inset, so each
     * occupies ~22px from its card edge, z-index above the title). The
     * title header spans the full card width and centers its text, so a
     * long name (up to the 32-char rename cap) previously ran UNDER those
     * corner icons — clipping "KICKDRUM"→"KICKD". Symmetric side padding
     * keeps the centered title box clear of both icons; because the padding
     * is symmetric, any title that still fits stays pixel-identically
     * centered (no baseline churn), and only a title too wide for the
     * reserved area truncates (ellipsis, see ModuleNameLabel) instead of
     * colliding with the icon. box-sizing:border-box so the padding eats
     * into the header's own width rather than widening the card. */
    box-sizing: border-box;
    padding-left: 26px;
    padding-right: 26px;
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

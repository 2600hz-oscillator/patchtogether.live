<script lang="ts">
  // Searchable popup palette for adding modules. Right-click an empty spot
  // on the canvas to open. Type to filter; click to spawn.
  //
  // Layout:
  //  - When the search box is EMPTY, render a 2-level nested menu:
  //      Audio modules ▸ (VCOs / Utility / Effects / Mixing / End of chain)
  //      Video modules ▸ (Sources / Processors / Utilities)
  //      Hybrid        ▸ (flat list — SCOPE + viz-VCOs + meta tools)
  //    Click a top-level row to expand its sub-categories; click a sub-
  //    category row to expand its items. One top + one sub stay expanded
  //    at a time so the panel doesn't grow unboundedly.
  //  - When the user TYPES, the menu collapses to a flat filtered list so
  //    `Reverb` <Enter> still picks Reverb without drilling. Existing
  //    palette E2E tests rely on this search-mode flatness.
  import { listModuleDefs } from '$lib/audio/module-registry';
  import { listVideoModuleDefs } from '$lib/video/module-registry';
  import { listMetaModuleDefs } from '$lib/meta/module-registry';
  import { patch } from '$lib/graph/store';
  import { groupDefs, TOP_ORDER, type TopCategory } from '$lib/ui/module-categories';
  import { canAddModule } from '$lib/doom/doom-gating';

  interface Props {
    open: boolean;
    /** Screen-space position to anchor the palette popup. */
    x: number;
    y: number;
    /** Whether the LOCAL user owns the rackspace. Owner-only modules (DOOM)
     *  are hidden from the palette for explicit non-owners. `undefined` =
     *  single-user / no-provider rack (sole de-facto owner — owner-only
     *  modules stay addable). */
    isRackOwner?: boolean;
    /** Called with the chosen module type when the user picks one. */
    onselect: (type: string) => void;
    /** Called when the palette wants to dismiss itself (Esc, click outside). */
    onclose: () => void;
    /** Optional: triggered by the Organize modules entry. When provided the
     *  entry is shown; the palette closes after invoking. */
    onorganize?: () => void;
    /** Optional: triggered by the Create group entry. When provided the
     *  entry is shown; the palette closes after invoking. The parent then
     *  enters lasso mode anchored at the click point. */
    oncreategroup?: () => void;
    /** Optional: triggered by the Insert-saved-group entry. When provided
     *  the entry is shown; the palette closes after invoking. Canvas only
     *  passes this for signed-in users. */
    oninsertsavedgroup?: () => void;
  }

  let {
    open = $bindable(false),
    x,
    y,
    isRackOwner,
    onselect,
    onclose,
    onorganize,
    oncreategroup,
    oninsertsavedgroup,
  }: Props = $props();

  /** Count instances of a module type currently in the patch. */
  function instanceCount(type: string): number {
    let n = 0;
    for (const node of Object.values(patch.nodes)) {
      if (node && node.type === type) n++;
    }
    return n;
  }

  let search = $state('');
  let inputEl: HTMLInputElement | null = $state(null);
  let paletteEl: HTMLDivElement | null = $state(null);
  let clampedX = $state(0);
  let clampedY = $state(0);

  // Which top + sub the user has drilled into. `null` means "show the
  // top-level list with all groups collapsed". Re-typed on every open
  // (and cleared when search is non-empty).
  let openTop: TopCategory | null = $state(null);
  let openSub: string | null = $state(null);

  // Clamp the popup into the viewport so right-click near the right or bottom
  // edge doesn't push the palette off-screen.
  $effect(() => {
    if (!open || !paletteEl) {
      clampedX = x;
      clampedY = y;
      return;
    }
    const w = paletteEl.offsetWidth;
    const h = paletteEl.offsetHeight;
    clampedX = Math.min(Math.max(0, x), Math.max(0, window.innerWidth - w));
    clampedY = Math.min(Math.max(0, y), Math.max(0, window.innerHeight - h));
  });

  // Re-read defs each open in case modules were registered after first
  // import. Also drop any module at its `maxInstances` cap — first-line UI
  // enforcement for singletons (engine.addNode is the defensive last line).
  let allDefs = $derived(
    open
      ? [
          ...listModuleDefs(),
          ...listVideoModuleDefs(),
          ...listMetaModuleDefs(),
        ].filter(
          (d) => d.maxInstances === undefined || instanceCount(d.type) < d.maxInstances,
        )
        // Owner-only modules (DOOM, round 5) are hidden from the palette for
        // explicit non-owners — they can't instantiate the widget.
        .filter((d) => canAddModule(d.type, isRackOwner))
      : [],
  );

  // Search mode: flat filtered list, RANKED so the most relevant match is
  // first (Enter picks filtered[0]). Without ranking a plain substring filter
  // returns defs in registry/alphabetical order, so typing a module's exact
  // name could surface an alphabetically-earlier substring match first (e.g.
  // "Reverb" → "moogafakkin 905 Spring Reverb" before the module literally
  // named "Reverb"). We score exact > prefix > substring (label or type),
  // stable within each tier so the prior order is otherwise preserved.
  function searchRank(d: { label: string; type: string }, q: string): number {
    const label = d.label.toLowerCase();
    const type = d.type.toLowerCase();
    if (label === q || type === q) return 0; // exact name/type
    if (label.startsWith(q) || type.startsWith(q)) return 1; // prefix
    if (label.includes(q) || type.includes(q)) return 2; // substring
    return -1; // no match
  }
  let filtered = $derived.by(() => {
    if (!search) return allDefs;
    const q = search.toLowerCase();
    return allDefs
      .map((d, i) => ({ d, i, rank: searchRank(d, q) }))
      .filter((x) => x.rank >= 0)
      .sort((a, b) => a.rank - b.rank || a.i - b.i) // stable: keep input order within a tier
      .map((x) => x.d);
  });

  // Nested mode: top → sub → defs. Unknown modules surface in an
  // Uncategorized bucket so newly-landed modules from parallel agents
  // (BLADES/STAGES/…) stay addable even before they're classified.
  let grouped = $derived(groupDefs(allDefs));

  $effect(() => {
    if (open) {
      // Defer focus to next microtask so the input is mounted.
      queueMicrotask(() => inputEl?.focus());
      // Re-open with everything collapsed so the user always lands on
      // the top-level list.
      openTop = null;
      openSub = null;
    } else {
      search = '';
    }
  });

  // Typing into the search box implicitly clears the drill-down state
  // so search results aren't visually confused with nested-mode rows.
  $effect(() => {
    if (search) {
      openTop = null;
      openSub = null;
    }
  });

  function pick(type: string) {
    onselect(type);
    onclose();
  }

  function pickOrganize() {
    onorganize?.();
    onclose();
  }

  function pickCreateGroup() {
    oncreategroup?.();
    onclose();
  }

  function pickInsertSavedGroup() {
    oninsertsavedgroup?.();
    onclose();
  }

  function toggleTop(t: TopCategory) {
    if (openTop === t) {
      openTop = null;
      openSub = null;
    } else {
      openTop = t;
      openSub = null;
    }
  }

  function toggleSub(name: string) {
    openSub = openSub === name ? null : name;
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onclose();
    } else if (e.key === 'Enter') {
      // Pick the first filtered module (search-mode shortcut).
      const first = filtered[0];
      if (first) pick(first.type);
    }
  }
</script>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="palette-overlay" onclick={onclose} role="presentation"></div>
  <div
    bind:this={paletteEl}
    class="module-palette"
    style:left="{clampedX}px"
    style:top="{clampedY}px"
    onkeydown={onKeydown}
    role="dialog"
    aria-label="Add module"
  >
    <input
      bind:this={inputEl}
      bind:value={search}
      placeholder="Add module… (type to filter, Enter to add)"
      autocomplete="off"
      spellcheck="false"
    />
    <div class="palette-body">
      {#if onorganize || oncreategroup || oninsertsavedgroup}
        <div class="category">tools</div>
        {#if oncreategroup}
          <button class="item tool" onclick={pickCreateGroup} data-testid="palette-create-group">
            Create instrument
          </button>
        {/if}
        {#if oninsertsavedgroup}
          <button
            class="item tool"
            onclick={pickInsertSavedGroup}
            data-testid="palette-insert-saved-group"
          >
            Insert saved instrument…
          </button>
        {/if}
        {#if onorganize}
          <button class="item tool" onclick={pickOrganize} data-testid="palette-organize">
            Organize modules
          </button>
        {/if}
      {/if}

      {#if search}
        <!-- Search mode: flat filtered results. -->
        {#if filtered.length === 0}
          <div class="empty">no matches</div>
        {/if}
        {#each filtered as def (def.type)}
          <button class="item" onclick={() => pick(def.type)} data-testid="palette-item-{def.type}">
            {def.label}
          </button>
        {/each}
      {:else}
        <!-- Nested mode: Audio / Video / Hybrid / (Uncategorized). -->
        {#if grouped.length === 0}
          <div class="empty">no modules registered</div>
        {/if}
        {#each grouped as g (g.top)}
          {@const expanded = openTop === g.top}
          <button
            type="button"
            class="top-row"
            class:expanded
            onclick={() => toggleTop(g.top)}
            data-testid="palette-top-{g.top.toLowerCase().replace(/\s+/g, '-')}"
            aria-expanded={expanded}
          >
            <span class="caret">{expanded ? '▾' : '▸'}</span>
            <span>{g.top}</span>
          </button>
          {#if expanded}
            {#each g.subs as sub (g.top + ':' + sub.name)}
              <!-- A sub whose name matches its top renders flat — items
                   live directly under the top-level row, no sub-category
                   indirection. Used by Hybrid (one sub named Hybrid) and
                   by Ports (mixed: Ports/Ports renders flat with dx7,
                   cloudseed; Ports/Mutable renders as a
                   labelled sub-expander below them). -->
              {@const flat = sub.name === g.top}
              {#if flat}
                {#each sub.defs as def (def.type)}
                  <button
                    class="item indented"
                    onclick={() => pick(def.type)}
                    data-testid="palette-item-{def.type}"
                  >
                    {def.label}
                  </button>
                {/each}
              {:else}
                {@const subExpanded = openSub === sub.name}
                <button
                  type="button"
                  class="sub-row"
                  class:expanded={subExpanded}
                  onclick={() => toggleSub(sub.name)}
                  data-testid="palette-sub-{sub.name.toLowerCase().replace(/\s+/g, '-')}"
                  aria-expanded={subExpanded}
                >
                  <span class="caret">{subExpanded ? '▾' : '▸'}</span>
                  <span>{sub.name}</span>
                </button>
                {#if subExpanded}
                  {#each sub.defs as def (def.type)}
                    <button
                      class="item indented-2"
                      onclick={() => pick(def.type)}
                      data-testid="palette-item-{def.type}"
                    >
                      {def.label}
                    </button>
                  {/each}
                {/if}
              {/if}
            {/each}
          {/if}
        {/each}
      {/if}
    </div>
  </div>
{/if}

<style>
  .palette-overlay {
    position: fixed;
    inset: 0;
    z-index: 100;
  }
  .module-palette {
    position: fixed;
    z-index: 101;
    width: 280px;
    max-height: 60vh;
    display: flex;
    flex-direction: column;
    background: var(--module-bg);
    border: 1px solid #404652;
    border-radius: 6px;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.5);
    overflow: hidden;
    font-size: 0.85rem;
  }
  .module-palette input {
    background: #14171c;
    color: var(--text);
    border: none;
    border-bottom: 1px solid #2a2f3a;
    padding: 0.6rem 0.8rem;
    outline: none;
    font-family: inherit;
    font-size: 0.85rem;
  }
  .module-palette input::placeholder {
    color: var(--text-dim);
  }
  .palette-body {
    overflow-y: auto;
    padding: 4px 0;
  }
  .top-row {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    background: rgba(96, 165, 250, 0.08);
    border: none;
    border-top: 1px solid #2a2f3a;
    border-bottom: 1px solid #2a2f3a;
    color: var(--text);
    text-align: left;
    padding: 8px 12px;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
  }
  .top-row:first-child {
    border-top: none;
  }
  .top-row:hover,
  .top-row:focus-visible {
    background: rgba(96, 165, 250, 0.16);
    outline: none;
  }
  .sub-row {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    background: transparent;
    border: none;
    color: var(--text-dim);
    text-align: left;
    padding: 6px 12px 6px 22px;
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-family: inherit;
    cursor: pointer;
  }
  .sub-row:hover,
  .sub-row:focus-visible {
    background: rgba(96, 165, 250, 0.1);
    color: var(--text);
    outline: none;
  }
  .caret {
    display: inline-block;
    width: 0.8em;
    color: var(--text-dim);
  }
  .category {
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-dim);
    padding: 8px 12px 4px;
    pointer-events: none;
  }
  .item {
    display: block;
    width: 100%;
    background: transparent;
    border: none;
    color: var(--text);
    text-align: left;
    padding: 6px 12px;
    font-size: 0.85rem;
    font-family: inherit;
    cursor: pointer;
  }
  .item.indented {
    padding-left: 24px;
  }
  .item.indented-2 {
    padding-left: 36px;
  }
  .item:hover,
  .item:focus-visible {
    background: rgba(96, 165, 250, 0.1);
    outline: none;
  }
  .item.tool {
    color: var(--text);
  }
  .empty {
    color: var(--text-dim);
    padding: 12px;
    text-align: center;
    font-size: 0.8rem;
  }
</style>

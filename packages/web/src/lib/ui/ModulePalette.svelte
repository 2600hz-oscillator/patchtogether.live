<script lang="ts">
  // Searchable popup palette for adding modules. Right-click the canvas (or
  // click the topbar's + Add module) to open. Type to filter; click to spawn.
  import { listModuleDefs } from '$lib/audio/module-registry';
  import { listVideoModuleDefs } from '$lib/video/module-registry';
  import { listMetaModuleDefs } from '$lib/meta/module-registry';
  import { patch } from '$lib/graph/store';

  interface Props {
    open: boolean;
    /** Screen-space position to anchor the palette popup. */
    x: number;
    y: number;
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
  }

  let {
    open = $bindable(false),
    x,
    y,
    onselect,
    onclose,
    onorganize,
    oncreategroup,
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

  // Re-read defs each open in case modules were registered after first import.
  // Also drop any module at its `maxInstances` cap — first-line UI enforcement
  // for singletons (engine.addNode is the defensive last line).
  //
  // Phase 0 video spike: list audio + video module defs side-by-side. The two
  // registries are kept distinct (different factory shapes) so the palette
  // stitches them at read-time. Audio defs appear first; users hit familiar
  // audio modules first when scanning.
  let allDefs = $derived(
    open
      ? [
          ...listModuleDefs(),
          ...listVideoModuleDefs(),
          ...listMetaModuleDefs(),
        ].filter(
          (d) => d.maxInstances === undefined || instanceCount(d.type) < d.maxInstances,
        )
      : [],
  );
  let filtered = $derived(
    allDefs.filter((d) => {
      if (!search) return true;
      const q = search.toLowerCase();
      return d.label.toLowerCase().includes(q) || d.type.toLowerCase().includes(q);
    })
  );

  // Group by domain first (AUDIO / VIDEO), then by category within each domain.
  // Domain headers separate the two worlds so users can scan an obviously-
  // visual section without sifting through 20+ audio modules. Category
  // sub-grouping inside each domain preserves the existing palette mental
  // model (sources → modulation → filters → ...).
  const CATEGORY_ORDER = ['sources', 'modulation', 'filters', 'effects', 'utilities', 'output', 'tools'];
  // Meta sits at the bottom — sticky-note-style tools live there. Putting
  // them last keeps the familiar audio→video reading order intact.
  const DOMAIN_ORDER: Array<'audio' | 'video' | 'meta'> = ['audio', 'video', 'meta'];
  const DOMAIN_LABEL: Record<string, string> = { audio: 'AUDIO', video: 'VIDEO', meta: 'META' };

  /** [domain, [category, defs]] tuples in deterministic order. */
  let groupedByDomain = $derived.by(() => {
    const byDomain: Record<string, Record<string, typeof filtered>> = { audio: {}, video: {}, meta: {} };
    for (const d of filtered) {
      const dom = (d.domain ?? 'audio') as 'audio' | 'video' | 'meta';
      const bucket = byDomain[dom] ?? (byDomain[dom] = {});
      (bucket[d.category] ??= []).push(d);
    }
    const out: Array<{ domain: 'audio' | 'video' | 'meta'; categories: Array<{ name: string; defs: typeof filtered }> }> = [];
    for (const dom of DOMAIN_ORDER) {
      const bucket = byDomain[dom] ?? {};
      const categories: Array<{ name: string; defs: typeof filtered }> = [];
      // Iterate the canonical order first, then any custom categories alphabetically.
      const seen = new Set<string>();
      for (const cat of CATEGORY_ORDER) {
        const defs = bucket[cat];
        if (defs && defs.length > 0) {
          categories.push({ name: cat, defs });
          seen.add(cat);
        }
      }
      for (const cat of Object.keys(bucket).sort()) {
        if (seen.has(cat)) continue;
        const defs = bucket[cat]!;
        if (defs.length > 0) categories.push({ name: cat, defs });
      }
      if (categories.length > 0) out.push({ domain: dom, categories });
    }
    return out;
  });

  $effect(() => {
    if (open) {
      // Defer focus to next microtask so the input is mounted.
      queueMicrotask(() => inputEl?.focus());
    } else {
      search = '';
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

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onclose();
    } else if (e.key === 'Enter') {
      // Pick the first filtered module
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
      {#if onorganize || oncreategroup}
        <div class="category">tools</div>
        {#if oncreategroup}
          <button class="item tool" onclick={pickCreateGroup} data-testid="palette-create-group">
            Create group
          </button>
        {/if}
        {#if onorganize}
          <button class="item tool" onclick={pickOrganize} data-testid="palette-organize">
            Organize modules
          </button>
        {/if}
      {/if}
      {#if groupedByDomain.length === 0}
        <div class="empty">no matches</div>
      {/if}
      {#each groupedByDomain as group (group.domain)}
        <div class="domain" data-testid="palette-domain-{group.domain}">
          {DOMAIN_LABEL[group.domain]}
        </div>
        {#each group.categories as cat (group.domain + ':' + cat.name)}
          <div class="category">{cat.name}</div>
          {#each cat.defs as def (def.type)}
            <button class="item" onclick={() => pick(def.type)} data-testid="palette-item-{def.type}">
              {def.label}
            </button>
          {/each}
        {/each}
      {/each}
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
  .domain {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--text);
    background: rgba(96, 165, 250, 0.08);
    border-top: 1px solid #2a2f3a;
    border-bottom: 1px solid #2a2f3a;
    padding: 6px 12px;
    pointer-events: none;
    font-weight: 600;
  }
  /* First domain header has no top border so it sits flush with the
   * search input divider. */
  .domain:first-child {
    border-top: none;
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

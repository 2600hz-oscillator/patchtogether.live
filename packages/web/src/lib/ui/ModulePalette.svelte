<script lang="ts">
  // Searchable popup palette for adding modules. Right-click the canvas (or
  // click the topbar's + Add module) to open. Type to filter; click to spawn.
  import { listModuleDefs } from '$lib/audio/module-registry';

  interface Props {
    open: boolean;
    /** Screen-space position to anchor the palette popup. */
    x: number;
    y: number;
    /** Called with the chosen module type when the user picks one. */
    onselect: (type: string) => void;
    /** Called when the palette wants to dismiss itself (Esc, click outside). */
    onclose: () => void;
  }

  let { open = $bindable(false), x, y, onselect, onclose }: Props = $props();

  let search = $state('');
  let inputEl: HTMLInputElement | null = $state(null);

  // Re-read defs each open in case modules were registered after first import.
  let allDefs = $derived(open ? listModuleDefs() : []);
  let filtered = $derived(
    allDefs.filter((d) => {
      if (!search) return true;
      const q = search.toLowerCase();
      return d.label.toLowerCase().includes(q) || d.type.toLowerCase().includes(q);
    })
  );

  // Group by category, preserving insertion order.
  let grouped = $derived.by(() => {
    const out: Record<string, typeof filtered> = {};
    const order = ['sources', 'modulation', 'filters', 'effects', 'utilities', 'output'];
    for (const cat of order) out[cat] = [];
    for (const d of filtered) {
      (out[d.category] ??= []).push(d);
    }
    // Drop empty categories
    return Object.fromEntries(Object.entries(out).filter(([_, v]) => v.length > 0));
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
    class="module-palette"
    style:left="{x}px"
    style:top="{y}px"
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
      {#if Object.keys(grouped).length === 0}
        <div class="empty">no matches</div>
      {/if}
      {#each Object.entries(grouped) as [cat, defs] (cat)}
        <div class="category">{cat}</div>
        {#each defs as def (def.type)}
          <button class="item" onclick={() => pick(def.type)}>
            {def.label}
          </button>
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
  .empty {
    color: var(--text-dim);
    padding: 12px;
    text-align: center;
    font-size: 0.8rem;
  }
</style>

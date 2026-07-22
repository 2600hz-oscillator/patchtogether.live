<script lang="ts">
  // RACK tab — chip strip + ONE-page CardStage pager (spec §3 RACK).
  //
  // Hard rule: ONE page mounted at a time (caps rAF load; never mounts
  // MixmstrsCard's 61 Knob loops — the mixmstrs chip jumps to MIX instead).
  // matrixMix (only present in imported desktop docs) is hidden entirely.
  // Chevrons + chip taps navigate; the card body does NOT swipe (every card
  // control is a touch-action:none drag surface — gesture collision).
  import CardStage from '$lib/mobile/CardStage.svelte';
  import AddModuleSheet from '$lib/mobile/AddModuleSheet.svelte';
  import {
    deleteNode,
    edgeCountFor,
    resolveAnyDef,
    spawnModule,
    unpatchNode,
  } from '$lib/mobile/mobile-host';
  import type { ModuleNode } from '$lib/graph/types';

  interface Props {
    nodes: ModuleNode[];
    onJumpToMix: () => void;
    toast: (msg: string) => void;
    undoPill: (msg: string) => void;
  }
  let { nodes, onJumpToMix, toast, undoPill }: Props = $props();

  function spawnSeqOf(n: ModuleNode): number {
    const v = (n.data as { spawnSeq?: number } | undefined)?.spawnSeq;
    return typeof v === 'number' ? v : Number.MAX_SAFE_INTEGER;
  }
  function nameOf(n: ModuleNode): string {
    return ((n.data as { name?: string } | undefined)?.name ?? n.type).toLowerCase();
  }

  // Chip strip = every module in spawn order. matrixMix hidden.
  let chips = $derived(
    nodes
      .filter((n) => n.type !== 'matrixMix')
      .sort((a, b) => spawnSeqOf(a) - spawnSeqOf(b) || (a.id < b.id ? -1 : 1)),
  );
  // Pager list = chips minus mixmstrs (its chip jumps to MIX).
  let pages = $derived(chips.filter((n) => n.type !== 'mixmstrs'));

  let currentId = $state<string | null>(null);
  let current = $derived(
    pages.find((n) => n.id === currentId) ?? pages[0],
  );
  let currentIndex = $derived(current ? pages.findIndex((n) => n.id === current!.id) : -1);

  export function showModule(id: string) {
    currentId = id;
  }

  function onChipTap(n: ModuleNode) {
    if (n.type === 'mixmstrs') {
      onJumpToMix();
      return;
    }
    currentId = n.id;
  }

  function step(delta: number) {
    if (pages.length === 0) return;
    const i = Math.max(0, currentIndex);
    const next = (i + delta + pages.length) % pages.length;
    currentId = pages[next]!.id;
  }

  // ── Add ──
  let addOpen = $state(false);
  function onAdd(type: string) {
    const id = spawnModule(type);
    addOpen = false;
    if (!id) return;
    if (type === 'mixmstrs') {
      onJumpToMix();
      return;
    }
    currentId = id;
    toast('wire it up in PATCH');
  }

  // ── Remove ──
  let removeOpen = $state(false);
  let currentUndeletable = $derived.by(() => {
    if (!current) return true;
    const def = resolveAnyDef(current.type) as { undeletable?: boolean } | undefined;
    return !!def?.undeletable;
  });
  function onDisconnectAll() {
    if (!current) return;
    unpatchNode(current.id);
    removeOpen = false;
    undoPill(`${nameOf(current)} disconnected`);
  }
  function onRemove() {
    if (!current) return;
    const name = nameOf(current);
    if (deleteNode(current.id)) {
      removeOpen = false;
      currentId = null;
      undoPill(`${name} removed`);
    }
  }
</script>

<div class="rack-tab" data-testid="m-rack-tab">
  <div class="chip-strip" data-testid="m-chip-strip">
    {#each chips as n (n.id)}
      <button
        class="chip"
        class:active={current?.id === n.id}
        class:mix={n.type === 'mixmstrs'}
        onclick={() => onChipTap(n)}
        data-testid={`m-chip-${n.type}`}
      >
        {nameOf(n)}
      </button>
    {/each}
  </div>

  {#if current}
    <div class="pager-head">
      <button class="nav-btn" onclick={() => step(-1)} aria-label="previous module">‹</button>
      <span class="pager-title" data-testid="m-pager-title">{nameOf(current)}</span>
      <div class="pager-right">
        {#if !currentUndeletable}
          <button
            class="nav-btn"
            onclick={() => (removeOpen = true)}
            aria-label="module actions"
            data-testid="m-pager-more"
          >
            …
          </button>
        {/if}
        <button class="nav-btn" onclick={() => step(1)} aria-label="next module">›</button>
      </div>
    </div>
    <div class="page">
      {#key current.id}
        <CardStage node={current} />
      {/key}
    </div>
  {:else}
    <div class="empty">
      <p>no modules yet</p>
    </div>
  {/if}

  <button class="fab" onclick={() => (addOpen = true)} aria-label="add module" data-testid="m-add-fab">
    +
  </button>

  <AddModuleSheet open={addOpen} onclose={() => (addOpen = false)} onadd={onAdd} />

  {#if removeOpen && current}
    <div class="remove-sheet" data-testid="m-remove-sheet">
      <div class="remove-card">
        <p class="remove-title">
          Remove {nameOf(current)}?
          {#if edgeCountFor(current.id) > 0}
            {edgeCountFor(current.id)} cable{edgeCountFor(current.id) === 1 ? '' : 's'} will be
            disconnected.
          {/if}
        </p>
        <button class="sheet-btn" onclick={onDisconnectAll} data-testid="m-disconnect-all">
          Disconnect all
        </button>
        <button class="sheet-btn danger" onclick={onRemove} data-testid="m-remove-confirm">
          Remove
        </button>
        <button class="sheet-btn" onclick={() => (removeOpen = false)}>Cancel</button>
      </div>
    </div>
  {/if}
</div>

<style>
  .rack-tab {
    display: flex;
    flex-direction: column;
    min-height: 100%;
    position: relative;
  }
  .chip-strip {
    display: flex;
    gap: 6px;
    overflow-x: auto;
    padding: 8px 10px;
    -webkit-overflow-scrolling: touch;
    flex: none;
  }
  .chip {
    flex: none;
    min-height: 40px;
    padding: 0 14px;
    border-radius: 20px;
    border: 1px solid #2a2f3a;
    background: rgba(255, 255, 255, 0.04);
    color: #b9c1d0;
    font-size: 13px;
    font-weight: 600;
  }
  .chip.active {
    background: rgba(79, 140, 255, 0.22);
    border-color: rgba(79, 140, 255, 0.6);
    color: #dbe2ee;
  }
  .chip.mix {
    border-style: dashed;
  }
  .pager-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 2px 10px;
    flex: none;
  }
  .pager-title {
    font-size: 14px;
    font-weight: 700;
    color: #dbe2ee;
  }
  .pager-right {
    display: flex;
    gap: 6px;
  }
  .nav-btn {
    min-width: 44px;
    min-height: 44px;
    border-radius: 10px;
    border: 1px solid #2a2f3a;
    background: rgba(255, 255, 255, 0.04);
    color: #dbe2ee;
    font-size: 20px;
  }
  .page {
    flex: 1;
    overflow-y: auto;
    padding: 4px 8px 96px;
  }
  .empty {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #8b93a3;
  }
  .fab {
    position: absolute;
    right: 14px;
    bottom: 14px;
    width: 56px;
    height: 56px;
    border-radius: 50%;
    border: none;
    background: var(--accent, #4f8cff);
    color: #fff;
    font-size: 28px;
    line-height: 1;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45);
  }
  .remove-sheet {
    position: fixed;
    inset: 0;
    z-index: 70;
    background: rgba(5, 7, 10, 0.6);
    display: flex;
    align-items: flex-end;
  }
  .remove-card {
    width: 100%;
    background: #141821;
    border-top: 1px solid #2a2f3a;
    border-radius: 16px 16px 0 0;
    padding: 16px 16px calc(16px + env(safe-area-inset-bottom));
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .remove-title {
    color: #dbe2ee;
    font-size: 15px;
    margin: 0 0 6px;
  }
  .sheet-btn {
    min-height: 56px;
    border-radius: 12px;
    border: 1px solid #2a2f3a;
    background: rgba(255, 255, 255, 0.05);
    color: #dbe2ee;
    font-size: 16px;
    font-weight: 600;
  }
  .sheet-btn.danger {
    background: rgba(226, 68, 92, 0.2);
    border-color: rgba(226, 68, 92, 0.6);
    color: #ff8b9b;
  }
</style>

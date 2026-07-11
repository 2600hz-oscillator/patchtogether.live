<script lang="ts">
  // WorkflowTopbar — the WORKFLOW-mode top toolbar (P1: the File.. menu).
  //
  // PURE RECOMPOSITION: every action here is an existing Canvas handler
  // passed in as a prop — the 5-slot preset-bar store (quicksave/quickload),
  // the portable performance .ptperf(.zip) export/import, the raw-JSON
  // envelope export/import, the SkinSwitcher theme picker, and the existing
  // sign-in/account link. NO new behavior lives in this component.
  //
  // In workflow mode the dawless top-left slot bar is NOT rendered — the
  // File.. menu REPLACES it (File → Quicksave/Quickload 1–5 drive the same
  // IndexedDB slots). REVERSIBLE DEFAULT pending owner question Q5
  // (replace vs. duplicate): re-rendering the bar next to File.. is a
  // one-line template change in Canvas.svelte.
  //
  // The other toolbar icons from the owner spec land in later phases —
  // clearly-marked disabled PLACEHOLDER SLOTS below keep the left→right
  // order stable so P2/P3/P4 fill slots instead of reflowing the bar:
  //   + media loader (P3) · assets picker (P3) · clock/Timelorde (P2) ·
  //   MIDI-clock DIN (P2) · audio I/O plug (P2) · cameras (P4).

  import { onMount } from 'svelte';
  import SkinSwitcher from '$lib/ui/SkinSwitcher.svelte';
  import { SLOT_COUNT } from '$lib/graph/preset-set';

  interface Props {
    appVersion: string;
    /** Per-slot occupancy mirror (red/green) — Canvas's slotOccupied. */
    slotOccupied: boolean[];
    /** True while any slot op is in flight — gates the quicksave/load rows. */
    slotBusy: boolean;
    /** True while a performance export/import is in flight. */
    perfBusy: boolean;
    /** Any nodes in the rack? Gates Save performance (mirrors dawless). */
    hasNodes: boolean;
    onQuicksave: (index: number) => void | Promise<void>;
    onQuickload: (index: number) => void | Promise<void>;
    onSavePerformance: () => void | Promise<void>;
    onLoadPerformance: () => void | Promise<void>;
    onExportJson: () => void;
    onImportJson: () => void | Promise<void>;
    /** Header account state (same seam as the dawless topbar). */
    signedIn: boolean;
    headerAuth?: { isSignedIn: boolean; imageUrl: string | null; initials: string | null } | null;
  }
  let {
    appVersion,
    slotOccupied,
    slotBusy,
    perfBusy,
    hasNodes,
    onQuicksave,
    onQuickload,
    onSavePerformance,
    onLoadPerformance,
    onExportJson,
    onImportJson,
    signedIn,
    headerAuth = null,
  }: Props = $props();

  // ---- File.. menu open/close + accordion section state ----
  let fileOpen = $state(false);
  /** Which submenu section is expanded ('quicksave' | 'quickload' | 'rawjson' | 'theme' | null). */
  let section = $state<string | null>(null);
  let menuEl: HTMLDivElement | null = $state(null);
  let triggerEl: HTMLButtonElement | null = $state(null);

  function toggleFile() {
    fileOpen = !fileOpen;
    if (!fileOpen) section = null;
  }
  function closeFile() {
    fileOpen = false;
    section = null;
  }
  function toggleSection(name: string) {
    section = section === name ? null : name;
  }

  /** Fire a menu action, then close (action menus don't linger). */
  async function fire(action: () => void | Promise<void>) {
    closeFile();
    await action();
  }

  onMount(() => {
    function onDocPointerDown(e: PointerEvent) {
      if (!fileOpen) return;
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (menuEl && menuEl.contains(t)) return;
      if (triggerEl && triggerEl.contains(t)) return;
      closeFile();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && fileOpen) {
        // Capture-phase + stopPropagation so the Canvas ESC keymap (which
        // closes the dock drawer) doesn't ALSO fire off this press.
        e.stopPropagation();
        closeFile();
        triggerEl?.focus();
      }
    }
    document.addEventListener('pointerdown', onDocPointerDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDocPointerDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  });

  /** The P2/P3/P4 placeholder slots, in the owner's left→right bar order. */
  const PLACEHOLDER_SLOTS: ReadonlyArray<{ id: string; glyph: string; label: string; phase: string }> = [
    { id: 'media-loader', glyph: '+', label: 'media loader', phase: 'P3' },
    { id: 'assets-picker', glyph: '💾', label: 'loaded assets', phase: 'P3' },
    { id: 'clock', glyph: '🕐', label: 'clock / timelorde', phase: 'P2' },
    { id: 'midi-din', glyph: '⚇', label: 'MIDI clock', phase: 'P2' },
    { id: 'audio-io', glyph: '🎧', label: 'audio in/out', phase: 'P2' },
    { id: 'cameras', glyph: '📷', label: 'cameras', phase: 'P4' },
  ];
</script>

<header class="workflow-topbar" data-testid="workflow-topbar">
  <h1>patchtogether <span class="app-version" data-testid="app-version">v{appVersion}</span></h1>

  <div class="file-anchor">
    <button
      class="file-trigger"
      data-testid="workflow-file-trigger"
      bind:this={triggerEl}
      onclick={toggleFile}
      aria-haspopup="menu"
      aria-expanded={fileOpen}
      title="File — quicksave/quickload, performance, raw JSON, theme, sign in"
    >File..</button>

    {#if fileOpen}
      <div class="file-menu" data-testid="workflow-file-menu" role="menu" bind:this={menuEl}>
        <!-- Quicksave 1–5: store the CURRENT rack into a preset slot
             (buildPerformanceZipBytes → the same IndexedDB slot store the
             dawless preset bar uses). -->
        <button
          class="row section"
          role="menuitem"
          data-testid="workflow-file-quicksave"
          aria-expanded={section === 'quicksave'}
          onclick={() => toggleSection('quicksave')}
        >Quicksave <span class="chev">{section === 'quicksave' ? '▾' : '▸'}</span></button>
        {#if section === 'quicksave'}
          <div class="slot-row" data-testid="workflow-quicksave-slots">
            {#each Array(SLOT_COUNT) as _, i (i)}
              <button
                class="slot"
                class:occupied={slotOccupied[i]}
                data-testid={`workflow-quicksave-${i + 1}`}
                disabled={slotBusy}
                onclick={() => fire(() => onQuicksave(i))}
                title={`Quicksave the current rack into slot ${i + 1}${slotOccupied[i] ? ' (replaces its contents)' : ''}`}
              >{i + 1}</button>
            {/each}
          </div>
        {/if}

        <!-- Quickload 1–5: switch to a stored slot (green only). -->
        <button
          class="row section"
          role="menuitem"
          data-testid="workflow-file-quickload"
          aria-expanded={section === 'quickload'}
          onclick={() => toggleSection('quickload')}
        >Quickload <span class="chev">{section === 'quickload' ? '▾' : '▸'}</span></button>
        {#if section === 'quickload'}
          <div class="slot-row" data-testid="workflow-quickload-slots">
            {#each Array(SLOT_COUNT) as _, i (i)}
              <button
                class="slot"
                class:occupied={slotOccupied[i]}
                data-testid={`workflow-quickload-${i + 1}`}
                disabled={slotBusy || !slotOccupied[i]}
                onclick={() => fire(() => onQuickload(i))}
                title={slotOccupied[i]
                  ? `Switch to the rack stored in slot ${i + 1}`
                  : `Slot ${i + 1} is empty — quicksave into it first`}
              >{i + 1}</button>
            {/each}
          </div>
        {/if}

        <div class="divider"></div>

        <!-- Portable performance (.ptperf zip) — the existing export/import. -->
        <button
          class="row"
          role="menuitem"
          data-testid="workflow-file-save-performance"
          disabled={perfBusy || !hasNodes}
          onclick={() => fire(onSavePerformance)}
          title="Export the whole rack (patch + embedded media + mappings) as a portable performance file"
        >Save performance</button>
        <button
          class="row"
          role="menuitem"
          data-testid="workflow-file-load-performance"
          disabled={perfBusy}
          onclick={() => fire(onLoadPerformance)}
          title="Load a portable performance file into this rack"
        >Load performance</button>

        <div class="divider"></div>

        <!-- Raw JSON (envelope only, no media) — the existing handlers. -->
        <button
          class="row section"
          role="menuitem"
          data-testid="workflow-file-rawjson"
          aria-expanded={section === 'rawjson'}
          onclick={() => toggleSection('rawjson')}
        >Raw JSON <span class="chev">{section === 'rawjson' ? '▾' : '▸'}</span></button>
        {#if section === 'rawjson'}
          <button
            class="row sub"
            role="menuitem"
            data-testid="workflow-file-export-json"
            onclick={() => fire(onExportJson)}
          >Export JSON (only)</button>
          <button
            class="row sub"
            role="menuitem"
            data-testid="workflow-file-import-json"
            onclick={() => fire(onImportJson)}
          >Import JSON</button>
        {/if}

        <div class="divider"></div>

        <!-- Theme: the EXISTING SkinSwitcher picker, hosted inline. -->
        <button
          class="row section"
          role="menuitem"
          data-testid="workflow-file-theme"
          aria-expanded={section === 'theme'}
          onclick={() => toggleSection('theme')}
        >Theme <span class="chev">{section === 'theme' ? '▾' : '▸'}</span></button>
        {#if section === 'theme'}
          <div class="theme-host" data-testid="workflow-theme-host">
            <SkinSwitcher />
          </div>
        {/if}

        <div class="divider"></div>

        <!-- Sign in / account — the existing link/flow. -->
        {#if signedIn}
          <a class="row link" role="menuitem" href="/dashboard" data-testid="workflow-file-account">
            {#if headerAuth?.imageUrl}
              <img class="account-avatar" src={headerAuth.imageUrl} alt="Account" />
            {:else}
              <span class="account-avatar account-avatar-fallback">{headerAuth?.initials ?? '\u{1F464}'}</span>
            {/if}
            Your dashboard
          </a>
        {:else}
          <a class="row link" role="menuitem" href="/dashboard" data-testid="workflow-file-signin">Sign in</a>
        {/if}
      </div>
    {/if}
  </div>

  <!-- P2/P3/P4 placeholder slots (disabled). See the header comment. -->
  <div class="placeholders" data-testid="workflow-topbar-placeholders">
    {#each PLACEHOLDER_SLOTS as p (p.id)}
      <button
        class="placeholder"
        data-testid={`workflow-topbar-slot-${p.id}`}
        disabled
        title={`${p.label} — lands in ${p.phase}`}
        aria-label={`${p.label} (coming in ${p.phase})`}
      >{p.glyph}</button>
    {/each}
  </div>

  <span class="spacer"></span>
  <span class="mode-tag" data-testid="workflow-mode-tag" title="This rackspace is a workflow patch">workflow</span>
</header>

<style>
  .workflow-topbar {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 1.25rem;
    border-bottom: 1px solid #1f242c;
    background: var(--bg);
    color: var(--text);
  }
  .workflow-topbar h1 {
    margin: 0;
    font-weight: 500;
    font-size: 1.05rem;
  }
  .app-version {
    color: var(--text-dim);
    font-size: 0.65rem;
    font-family: ui-monospace, monospace;
    margin-left: 4px;
  }
  .file-anchor {
    position: relative;
  }
  .file-trigger {
    background: #2a2f3a;
    color: var(--text);
    border: 1px solid #404652;
    padding: 4px 14px;
    border-radius: 3px;
    cursor: pointer;
    font-family: inherit;
    font-size: 0.8rem;
  }
  .file-trigger:hover {
    background: #353a47;
  }
  .file-menu {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    z-index: 60;
    min-width: 220px;
    display: flex;
    flex-direction: column;
    background: #14171c;
    border: 1px solid #404652;
    border-radius: 4px;
    padding: 4px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    background: transparent;
    color: var(--text);
    border: none;
    text-align: left;
    padding: 7px 10px;
    border-radius: 3px;
    cursor: pointer;
    font-family: inherit;
    font-size: 0.8rem;
    text-decoration: none;
  }
  .row:hover:not(:disabled) {
    background: #2a2f3a;
  }
  .row:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .row.section .chev {
    margin-left: auto;
    color: var(--text-dim);
    font-size: 0.7rem;
  }
  .row.sub {
    padding-left: 22px;
  }
  .slot-row {
    display: flex;
    gap: 4px;
    padding: 2px 10px 8px 22px;
  }
  /* Same red/green slot language as the dawless preset bar. */
  .slot {
    width: 26px;
    height: 24px;
    border-radius: 3px;
    border: 1px solid #7a2e2e;
    background: #2a1416;
    color: #f0a0a0;
    cursor: pointer;
    font-family: ui-monospace, monospace;
    font-size: 0.75rem;
  }
  .slot.occupied {
    border-color: #2e7a44;
    background: #12281a;
    color: #9ae6b4;
  }
  .slot:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .divider {
    height: 1px;
    background: #2a2f3a;
    margin: 4px 6px;
  }
  .theme-host {
    padding: 2px 10px 8px 22px;
  }
  .account-avatar {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    object-fit: cover;
  }
  .account-avatar-fallback {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: #2a2f3a;
    font-size: 0.65rem;
  }
  .placeholders {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .placeholder {
    width: 30px;
    height: 26px;
    border-radius: 3px;
    border: 1px dashed #33394a;
    background: transparent;
    color: var(--text-dim);
    opacity: 0.55;
    font-size: 0.8rem;
    cursor: not-allowed;
  }
  .spacer {
    flex: 1;
  }
  .mode-tag {
    color: var(--cable-gate, #f97316);
    border: 1px solid var(--cable-gate, #f97316);
    border-radius: 3px;
    padding: 1px 8px;
    font-family: ui-monospace, monospace;
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
</style>

<script lang="ts">
  // WorkflowTopbar — the WORKFLOW-mode top toolbar (P1: the File.. menu).
  //
  // PURE RECOMPOSITION: every action here is an existing Canvas handler
  // passed in as a prop — the 5-slot preset-bar store (quicksave/quickload),
  // the portable performance .ptperf(.zip) export/import, the raw-JSON
  // envelope export/import, the SkinSwitcher theme picker, the AspectToggle
  // output-aspect pill, Canvas.clearPatch, and the existing sign-in/account
  // link. NO new behavior lives in this component.
  //
  // TOPBAR PARITY. This is now the ONLY topbar — the second shell's
  // full-width bar (5-slot preset strip + actions cluster) was deleted with
  // that shell, so anything it carried had to arrive here first or be lost.
  // `Clear` and `AspectToggle` were ported in the earlier PR of that sequence;
  // `Save set` / `Load set` and the per-slot `Load into…` / `Clear slot` rows
  // were ported in the one that deleted it. Clear is the ONLY destructive
  // action in the menu and sits LAST, below its own danger divider — never
  // adjacent to Quicksave.
  //
  // The slot bar's four affordances map onto four menu sections:
  //   left-click a green slot  → Quickload N
  //   right-click → Replace    → Quicksave N (replaces in place)
  //   right-click → Load…      → Load into slot N
  //   right-click → Clear slot → Clear slot N
  //
  // P2 fills three of the reserved slots with LIVE surfaces (the pinned
  // module faces — see graph/workflow-pins.ts WORKFLOW_PINNED_SURFACES):
  //   🕐 clock  → ClockSurface (TIMELORDE: BPM readout / knob / tap / patch-out)
  //   ⚇ DIN     → MidiDinSurface (assign a MIDI input as TIMELORDE's clock)
  //   🎧 audio  → AudioIoSurface (always-on AUDIO IN + AUDIO OUT faces)
  // P3 fills the two media slots:
  //   +  media loader → MediaLoaderSurface (file/folder pick + drop target
  //      feeding the centralized mediaLibrary)
  //   💾 loaded assets → AssetsPickerSurface (images/videos/sounds
  //      submenus; click-to-patch via the virtual-port cable drag)
  // P4 fills the last slot:
  //   📷 cameras → CameraSurface (headless hiddenCard camera modules:
  //      ＋ map / ✕ unmap / source assign via the hosted REAL card /
  //      row-click virtual-port patching). Its card-host farm stays
  //      MOUNTED like the audio I/O panel — a mapped camera's stream
  //      must survive the menu closing.
  //
  // One menu at a time: File.. + the surface dropdowns share a single
  // `openMenu` slot; outside-click + ESC close whichever is up — EXCEPT
  // the assets picker, which is STICKY by spec ("stays open until an
  // asset is selected or ESC"): outside pointerdown leaves it up.
  // Clicks inside PORTALED overlay children (the MIDI-learn context menu a
  // topbar Knob opens, the patch-to picker) do NOT count as outside.

  import { onMount } from 'svelte';
  import SkinSwitcher from '$lib/ui/SkinSwitcher.svelte';
  import AspectToggle from '$lib/ui/AspectToggle.svelte';
  import { SLOT_COUNT } from '$lib/graph/preset-set';
  import ClockSurface from './ClockSurface.svelte';
  import MidiDinSurface from './MidiDinSurface.svelte';
  import AudioIoSurface from './AudioIoSurface.svelte';
  import MediaLoaderSurface from './MediaLoaderSurface.svelte';
  import AssetsPickerSurface from './AssetsPickerSurface.svelte';
  import CameraSurface from './CameraSurface.svelte';
  import type { ModuleNode } from '$lib/graph/types';

  interface Props {
    appVersion: string;
    /** Per-slot occupancy mirror (red/green) — Canvas's slotOccupied. */
    slotOccupied: boolean[];
    /** True while any slot op is in flight — gates the quicksave/load rows. */
    slotBusy: boolean;
    /** True while a performance export/import is in flight. */
    perfBusy: boolean;
    /** Any nodes in the rack? Gates Save performance. */
    hasNodes: boolean;
    /** True while a New rack create/navigate is in flight — gates the row. */
    newRackBusy: boolean;
    /** File → New rack: fresh rack of the current kind (see Canvas.newRack). */
    onNewRack: () => void | Promise<void>;
    onQuicksave: (index: number) => void | Promise<void>;
    onQuickload: (index: number) => void | Promise<void>;
    onSavePerformance: () => void | Promise<void>;
    onLoadPerformance: () => void | Promise<void>;
    onExportJson: () => void;
    onImportJson: () => void | Promise<void>;
    /** File → Clear rack: unpatch everything (Canvas.clearPatch). PINNED
     *  workflow singletons survive by design; their edges do not. */
    onClear: () => void;
    /** File → Load into slot N: file-pick a performance and store it in slot N
     *  WITHOUT loading it (the old per-slot right-click "Load…"). */
    onLoadIntoSlot: (index: number) => void | Promise<void>;
    /** File → Clear slot N: empty slot N (the old per-slot "Clear slot"). */
    onClearSlot: (index: number) => void | Promise<void>;
    /** File → Save set: bundle ALL five slots + the MIDI map into one portable
     *  `.set` file (the old topbar's "Save Set"). */
    onSaveSet: () => void | Promise<void>;
    /** File → Load set: restore all five slots + the MIDI map from a `.set`. */
    onLoadSet: () => void | Promise<void>;
    /** Header account state. */
    signedIn: boolean;
    headerAuth?: { isSignedIn: boolean; imageUrl: string | null; initials: string | null } | null;
    // ---- P2 surface plumbing (snapshot-derived by Canvas) ----
    /** THE rack timelorde (pinned, or an imported patch's canvas one). */
    timelordeNode?: ModuleNode | null;
    /** The hidden pinned MIDICLOCK bridge. */
    midiclockNode?: ModuleNode | null;
    /** The pinned always-on AUDIO IN / AUDIO OUT. */
    audioInNode?: ModuleNode | null;
    audioOutNode?: ModuleNode | null;
    /** True while a cable feeds TIMELORDE's `clock` input (any source). */
    externallyClocked?: boolean;
    /** True while the DIN bridge's clock edge into TIMELORDE exists. */
    dinAssigned?: boolean;
    /** The main canvas's glob-driven nodeTypes map (for the card hosts). */
    nodeTypes?: Record<string, unknown>;
    /** Canvas's type → rack {size, hp} map (the audio-I/O plain-mount hosts
     *  size their cards exactly like the dock drawers do). */
    rackSizeByType?: Record<string, { size?: string; hp?: number }>;
    /** Canvas's ensureEngine — surfaces whose backing api lives on the
     *  engine-side module boot it on first use. */
    onEnsureEngine?: (() => Promise<unknown>) | null;
    /** Multiplayer user id (asset-module cap checks + creatorId
     *  stamping) — null single-user, mirroring spawnFromPalette. */
    currentUserId?: string | null;
    // ---- P4 camera manager plumbing (snapshot-derived by Canvas) ----
    /** The mapped (hiddenCard) camera nodes, in stable menu order. */
    cameraNodes?: ModuleNode[];
    /** True when one more camera would exceed cameraInput.maxInstances. */
    cameraAtCap?: boolean;
  }
  let {
    appVersion,
    slotOccupied,
    slotBusy,
    perfBusy,
    hasNodes,
    newRackBusy,
    onNewRack,
    onQuicksave,
    onQuickload,
    onSavePerformance,
    onLoadPerformance,
    onExportJson,
    onImportJson,
    onClear,
    onLoadIntoSlot,
    onClearSlot,
    onSaveSet,
    onLoadSet,
    signedIn,
    headerAuth = null,
    timelordeNode = null,
    midiclockNode = null,
    audioInNode = null,
    audioOutNode = null,
    externallyClocked = false,
    dinAssigned = false,
    nodeTypes = {},
    rackSizeByType = {},
    onEnsureEngine = null,
    currentUserId = null,
    cameraNodes = [],
    cameraAtCap = false,
  }: Props = $props();

  // ---- Topbar menu state: ONE menu open at a time ----
  type MenuId = 'file' | 'clock' | 'din' | 'io' | 'assets' | 'cameras';
  let openMenu = $state<MenuId | null>(null);
  let fileOpen = $derived(openMenu === 'file');
  /** Which File.. submenu section is expanded ('quicksave' | 'quickload' |
   *  'loadinto' | 'clearslot' | 'rawjson' | 'theme' | null). */
  let section = $state<string | null>(null);
  let triggerEl: HTMLButtonElement | null = $state(null);

  function toggleMenu(id: MenuId) {
    openMenu = openMenu === id ? null : id;
    if (openMenu !== 'file') section = null;
  }
  function closeMenus() {
    openMenu = null;
    section = null;
  }
  function toggleFile() {
    toggleMenu('file');
  }
  function toggleSection(name: string) {
    section = section === name ? null : name;
  }

  /** Fire a menu action, then close (action menus don't linger). */
  async function fire(action: () => void | Promise<void>) {
    closeMenus();
    await action();
  }

  onMount(() => {
    function onDocPointerDown(e: PointerEvent) {
      if (openMenu === null) return;
      // STICKY assets picker (owner spec): an open submenu stays open
      // until an asset is SELECTED or ESC — outside clicks don't close it.
      if (openMenu === 'assets') return;
      const t = e.target as HTMLElement | null;
      if (!t) return;
      // Inside any topbar menu anchor (trigger or its dropdown)?
      if (t.closest('[data-wf-anchor]')) return;
      // Inside a PORTALED overlay a menu child opened (the MIDI-learn
      // context menu portals to <body>; the patch-to picker floats too)?
      // Those interactions must not slam the hosting dropdown shut.
      // The camera manager's fixed-position card hosts (the source
      // picker / live preview) are the same case: they float outside the
      // anchor, and working the hosted card's device dropdown must not
      // close the cameras menu (which would hide the host mid-pick).
      if (
        t.closest('.ctx-overlay') ||
        t.closest('[data-testid="control-context-menu"]') ||
        t.closest('[data-testid="port-context-menu"]') ||
        t.closest('[data-wf-camera-host]')
      ) {
        return;
      }
      closeMenus();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && openMenu !== null) {
        // Capture-phase + stopPropagation so the Canvas ESC keymap (which
        // closes the dock drawer) doesn't ALSO fire off this press.
        e.stopPropagation();
        closeMenus();
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

</script>

<header class="workflow-topbar" data-testid="workflow-topbar">
  <h1>patchtogether <span class="app-version" data-testid="app-version">v{appVersion}</span></h1>

  <div class="file-anchor" data-wf-anchor="file">
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
      <div class="file-menu" data-testid="workflow-file-menu" role="menu">
        <!-- New rack: a FRESH empty rack of the current (workflow) kind —
             signed-in a new saved rack, logged-out a clean scratch canvas. -->
        <button
          class="row"
          role="menuitem"
          data-testid="workflow-file-new-rack"
          disabled={newRackBusy}
          onclick={() => fire(onNewRack)}
          title="New rack — a fresh empty workflow rack (signed in: a new saved rack; logged out: a clean scratch canvas)"
        >New rack</button>

        <div class="divider"></div>

        <!-- Quicksave 1–5: store the CURRENT rack into a preset slot
             (buildPerformanceZipBytes → the same IndexedDB slot store the
             `Load set` bundle reads). -->
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

        <!-- Load into slot 1–5: file-pick a performance and PARK it in a slot
             without loading it. The old bar reached this by right-clicking a
             slot → "Load…"; deleting that bar without this row would have
             dropped the only way to populate a slot from a file. -->
        <button
          class="row section"
          role="menuitem"
          data-testid="workflow-file-load-into-slot"
          aria-expanded={section === 'loadinto'}
          onclick={() => toggleSection('loadinto')}
        >Load into slot <span class="chev">{section === 'loadinto' ? '▾' : '▸'}</span></button>
        {#if section === 'loadinto'}
          <div class="slot-row" data-testid="workflow-load-into-slots">
            {#each Array(SLOT_COUNT) as _, i (i)}
              <button
                class="slot"
                class:occupied={slotOccupied[i]}
                data-testid={`workflow-load-into-${i + 1}`}
                disabled={slotBusy}
                onclick={() => fire(() => onLoadIntoSlot(i))}
                title={`Pick a performance file and store it in slot ${i + 1}${slotOccupied[i] ? ' (replaces its contents)' : ''}`}
              >{i + 1}</button>
            {/each}
          </div>
        {/if}

        <!-- Clear slot 1–5: empty an occupied slot (old right-click → "Clear
             slot"). Green-only, like Quickload: clearing an empty slot is a
             no-op the UI should not offer. -->
        <button
          class="row section"
          role="menuitem"
          data-testid="workflow-file-clear-slot"
          aria-expanded={section === 'clearslot'}
          onclick={() => toggleSection('clearslot')}
        >Clear slot <span class="chev">{section === 'clearslot' ? '▾' : '▸'}</span></button>
        {#if section === 'clearslot'}
          <div class="slot-row" data-testid="workflow-clear-slots">
            {#each Array(SLOT_COUNT) as _, i (i)}
              <button
                class="slot"
                class:occupied={slotOccupied[i]}
                data-testid={`workflow-clear-slot-${i + 1}`}
                disabled={slotBusy || !slotOccupied[i]}
                onclick={() => fire(() => onClearSlot(i))}
                title={slotOccupied[i]
                  ? `Empty slot ${i + 1}`
                  : `Slot ${i + 1} is already empty`}
              >{i + 1}</button>
            {/each}
          </div>
        {/if}

        <div class="divider"></div>

        <!-- The `.set` bundle: ALL five slots + the MIDI map in one portable
             file. Ported verbatim from the deleted bar's Save Set / Load Set
             buttons — the ONLY whole-bar transport there is. -->
        <button
          class="row"
          role="menuitem"
          data-testid="workflow-file-save-set"
          disabled={slotBusy}
          onclick={() => fire(onSaveSet)}
          title="Save all five preset slots + the MIDI mapping as one portable .set file"
        >Save set</button>
        <button
          class="row"
          role="menuitem"
          data-testid="workflow-file-load-set"
          disabled={slotBusy}
          onclick={() => fire(onLoadSet)}
          title="Load a .set file — repopulates all five preset slots and restores the MIDI mapping"
        >Load set</button>

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

        <!-- Output aspect — the EXISTING AspectToggle, hosted inline next to
             Theme (both are display settings). Ported from the deleted
             topbar, where it sat bare in the .actions cluster. Hosted rather
             than wrapped in `fire()` so the menu STAYS OPEN and you can see
             the 4:3 ⇄ 16:9 state flip on the control itself. -->
        <!-- `group`, not a bare div: `role="menu"` permits `group` as a child
             but not an unlabelled generic, and the hosted <AspectToggle/> is a
             real control that must stay reachable. -->
        <div class="row static-row" role="group" aria-label="Output aspect" data-testid="workflow-file-aspect">
          <span class="row-label" aria-hidden="true">Output aspect</span>
          <span class="aspect-host" data-testid="workflow-aspect-host">
            <AspectToggle />
          </span>
        </div>

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

        <!-- DANGER ZONE, last and visually separated. Clear is the one
             DESTRUCTIVE action in this menu, so it deliberately does NOT sit
             next to Quicksave/Quickload where a slip costs you the rack.
             Behaviour is byte-for-byte the old `Clear` button
             (Canvas.clearPatch): same handler, same `nodeCount === 0`
             disable. PLACEMENT is the reviewable question — see the PR body. -->
        <div class="divider danger-divider"></div>
        <button
          class="row danger"
          role="menuitem"
          data-testid="workflow-file-clear"
          disabled={!hasNodes}
          onclick={() => fire(onClear)}
          title="Clear the rack — deletes every module and cable. Pinned workflow singletons (clock / audio I/O) survive; their cables do not."
        >Clear rack</button>
      </div>
    {/if}
  </div>

  <!-- Toolbar slots, in the owner's left→right order: P3 placeholders,
       then the LIVE P2 surfaces (clock / DIN / audio I/O), then the P4
       cameras placeholder. See the header comment. -->
  <div class="placeholders" data-testid="workflow-topbar-placeholders">
    <!-- + MEDIA LOADER — pick/drop sound, video + image files (P3). -->
    <MediaLoaderSurface />

    <!-- 💾 LOADED ASSETS — images/videos/sounds submenus; click a row to
         drag a patch wire out (the virtual-port drag). STICKY while open
         (see onDocPointerDown). -->
    <div class="slot-anchor" data-wf-anchor="assets">
      <button
        class="slot-trigger"
        class:open={openMenu === 'assets'}
        data-testid="workflow-topbar-slot-assets-picker"
        onclick={() => toggleMenu('assets')}
        aria-haspopup="menu"
        aria-expanded={openMenu === 'assets'}
        title="Loaded assets — click one to patch it into the rack"
        aria-label="Loaded assets picker"
      >💾</button>
      {#if openMenu === 'assets'}
        <AssetsPickerSurface
          currentUserId={currentUserId ?? null}
          {onEnsureEngine}
          onRequestClose={closeMenus}
        />
      {/if}
    </div>

    <!-- 🕐 CLOCK — TIMELORDE's workflow face (BPM / knob / tap / patch-out). -->
    <div class="slot-anchor" data-wf-anchor="clock">
      <button
        class="slot-trigger"
        class:open={openMenu === 'clock'}
        data-testid="workflow-topbar-slot-clock"
        onclick={() => toggleMenu('clock')}
        aria-haspopup="menu"
        aria-expanded={openMenu === 'clock'}
        title="Clock — tempo, tap tempo, and TIMELORDE patch-out"
        aria-label="Clock (TIMELORDE surface)"
      >🕐</button>
      {#if openMenu === 'clock'}
        <ClockSurface
          timelorde={timelordeNode}
          {externallyClocked}
          onRequestClose={closeMenus}
        />
      {/if}
    </div>

    <!-- ⚇ MIDI DIN — assign a MIDI input as TIMELORDE's clock source. -->
    <div class="slot-anchor" data-wf-anchor="din">
      <button
        class="slot-trigger"
        class:open={openMenu === 'din'}
        class:active={dinAssigned}
        data-testid="workflow-topbar-slot-midi-din"
        onclick={() => toggleMenu('din')}
        aria-haspopup="menu"
        aria-expanded={openMenu === 'din'}
        title={dinAssigned
          ? 'MIDI clock — a MIDI input is driving TIMELORDE'
          : 'MIDI clock — assign a MIDI input as the tempo source'}
        aria-label="MIDI clock source"
      >⚇</button>
      {#if openMenu === 'din'}
        <MidiDinSurface
          midiclock={midiclockNode}
          timelorde={timelordeNode}
          assigned={dinAssigned}
          {onEnsureEngine}
        />
      {/if}
    </div>

    <!-- 🎧 AUDIO I/O — the always-on AUDIO IN + AUDIO OUT faces. The panel
         stays MOUNTED (the hosted AudioinCard owns the live input stream);
         open/close only toggles its visibility. -->
    <div class="slot-anchor" data-wf-anchor="io">
      <button
        class="slot-trigger"
        class:open={openMenu === 'io'}
        data-testid="workflow-topbar-slot-audio-io"
        onclick={() => toggleMenu('io')}
        aria-haspopup="menu"
        aria-expanded={openMenu === 'io'}
        title="Audio in/out — input source, output device, and AUDIO IN patch-out"
        aria-label="Audio input and output"
      >🎧</button>
      <AudioIoSurface
        audioIn={audioInNode}
        audioOut={audioOutNode}
        {nodeTypes}
        {rackSizeByType}
        open={openMenu === 'io'}
        onRequestClose={closeMenus}
      />
    </div>

    <!-- 📷 CAMERAS — the camera manager: ＋ map / ✕ unmap / source assign /
         row-click virtual-port patching of headless camera modules. The
         panel + its card-host farm stay MOUNTED (a mapped camera's stream
         must survive menu close); open/close only toggles visibility. -->
    <div class="slot-anchor" data-wf-anchor="cameras">
      <button
        class="slot-trigger"
        class:open={openMenu === 'cameras'}
        class:active={cameraNodes.length > 0}
        data-testid="workflow-topbar-slot-cameras"
        onclick={() => toggleMenu('cameras')}
        aria-haspopup="menu"
        aria-expanded={openMenu === 'cameras'}
        title={cameraNodes.length > 0
          ? `Cameras — ${cameraNodes.length} mapped; click a row to patch its output`
          : 'Cameras — map a camera source and patch its output from the menu'}
        aria-label="Camera manager"
      >📷</button>
      <CameraSurface
        cameras={cameraNodes}
        atCap={cameraAtCap}
        {nodeTypes}
        open={openMenu === 'cameras'}
        onRequestClose={closeMenus}
        {onEnsureEngine}
      />
    </div>
  </div>

  <span class="spacer"></span>
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
  /* Same red/green slot language the preset bar used. */
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
  /* Thicker + warmer: the visual break before the one destructive row. */
  .danger-divider {
    height: 2px;
    background: #4a2226;
    margin: 8px 6px 4px;
  }
  .theme-host {
    padding: 2px 10px 8px 22px;
  }
  /* A .row that is a LAYOUT container (label + hosted control), not a
     clickable menuitem — `cursor` and hover must not read as actionable. */
  .row.static-row {
    cursor: default;
    justify-content: space-between;
  }
  .row.static-row:hover {
    background: transparent;
  }
  .row-label {
    color: var(--text-dim);
  }
  .aspect-host {
    display: inline-flex;
  }
  /* DESTRUCTIVE row — red text + red hover wash, so Clear can never be
     mistaken for the neutral file operations above it. */
  .row.danger {
    color: #f0a0a0;
  }
  .row.danger:hover:not(:disabled) {
    background: #3a1c20;
    color: #ffc4c4;
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
  .slot-anchor {
    position: relative;
  }
  .slot-trigger {
    width: 30px;
    height: 26px;
    border-radius: 3px;
    border: 1px solid #404652;
    background: #2a2f3a;
    color: var(--text);
    font-size: 0.8rem;
    cursor: pointer;
  }
  .slot-trigger:hover {
    background: #353a47;
  }
  .slot-trigger.open {
    border-color: var(--cable-gate, #f97316);
  }
  .slot-trigger.active {
    box-shadow: inset 0 -2px 0 var(--cable-gate, #f97316);
  }
  .spacer {
    flex: 1;
  }
</style>

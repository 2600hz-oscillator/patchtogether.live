<script lang="ts">
  // /m/synth — POCKET MODULAR (spec §3). Transport header + 3 bottom tabs
  // (RACK / PATCH / MIX), a start card over an empty doc (FIRST BLEEP /
  // empty rack / restore last session), a toast + 4s undo pill, and the
  // localStorage envelope autosave on visibilitychange.
  import { onDestroy, onMount } from 'svelte';
  import { undoManager } from '$lib/graph/store';
  import {
    ensureMobileEngine,
    getMobileAudioContext,
    getMobileEngine,
    disposeMobileEngine,
    hasMobileSession,
    installMobileTestHooks,
    restoreMobileSession,
    saveMobileSession,
    readParamValue,
    listTransportNodes,
    hasBpmParam,
  } from '$lib/mobile/mobile-host';
  import { spawnEmptyRack, spawnFirstBleep } from '$lib/mobile/first-bleep';
  import { provideEngineContext } from '$lib/audio/engine-context';
  import { createAudioGate } from '$lib/audio/audio-gate.svelte';
  import { getDefaultSnapshotBus, type PatchSnapshot } from '$lib/graph/snapshot';
  import { setNodeParam } from '$lib/graph/mutate';
  import RackTab from '$lib/mobile/RackTab.svelte';
  import MobileMatrix from '$lib/mobile/MobileMatrix.svelte';
  import MixLanes from '$lib/mobile/MixLanes.svelte';

  const gate = createAudioGate();
  gate.setBooter(() => ensureMobileEngine());
  provideEngineContext(() => getMobileEngine());

  // ── Snapshot pump (the card-standard reactivity source) ──
  let snapshot = $state<PatchSnapshot>({ nodes: [], edges: [] });
  const unsubscribeSnap = getDefaultSnapshotBus().subscribe((s) => (snapshot = s));

  let started = $derived(snapshot.nodes.length > 0);
  // ── MASTER transport: drive EVERY transport-bearing node, not just the
  // (often unwired) TIMELORDE. In FIRST BLEEP the audible clock is the
  // sequencer's own `isPlaying`, so controlling timelorde alone was inert. ──
  let transportNodes = $derived(listTransportNodes(snapshot.nodes));
  let hasTransport = $derived(transportNodes.length > 0);
  let running = $derived(transportNodes.some(({ node, param }) => readParamValue(node, param) >= 0.5));
  // Tempo: display + control the AUDIBLE tempo — prefer a sequencer's BPM
  // (what you hear in FIRST BLEEP), else any bpm-bearing node (timelorde).
  let bpmNodes = $derived(snapshot.nodes.filter((n) => hasBpmParam(n)));
  let bpmNode = $derived(bpmNodes.find((n) => n.type === 'sequencer') ?? bpmNodes[0]);
  let bpm = $derived(bpmNode ? Math.round(readParamValue(bpmNode, 'bpm')) : 120);

  // ── Tabs ──
  let activeTab = $state<'rack' | 'patch' | 'mix'>('rack');
  let rackTab = $state<{ showModule: (id: string) => void } | null>(null);

  function openModule(id: string) {
    activeTab = 'rack';
    rackTab?.showModule(id);
  }

  // ── Toast + undo pill ──
  let toastMsg = $state<string | null>(null);
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  function toast(msg: string) {
    toastMsg = msg;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastMsg = null), 2600);
  }
  let pillMsg = $state<string | null>(null);
  let pillTimer: ReturnType<typeof setTimeout> | null = null;
  function undoPill(msg: string) {
    pillMsg = msg;
    if (pillTimer) clearTimeout(pillTimer);
    pillTimer = setTimeout(() => (pillMsg = null), 4000);
  }
  function pillUndo() {
    undoManager.undo();
    pillMsg = null;
  }

  // ── Start card actions (each = the audio-gate gesture) ──
  let canRestore = $state(false);
  let booting = $state(false);
  async function boot(): Promise<boolean> {
    booting = true;
    try {
      await gate.resume();
      gate.bind(getMobileAudioContext());
      return true;
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      booting = false;
    }
  }
  async function onFirstBleep() {
    if (!(await boot())) return;
    spawnFirstBleep();
    toast('sequencer running — tweak it, then wire more in PATCH');
  }
  async function onEmptyRack() {
    if (!(await boot())) return;
    spawnEmptyRack();
    activeTab = 'rack';
  }
  async function onRestore() {
    if (!(await boot())) return;
    if (!restoreMobileSession()) toast('could not restore the last session');
  }

  // ── Transport ── (drive ALL transport nodes so ■ truly stops the sound and
  // ▶ resumes it; nudge writes every bpm-bearing node so tempo actually moves)
  function toggleRun() {
    const next = running ? 0 : 1;
    for (const { node, param } of transportNodes) setNodeParam(node.id, param, next);
  }
  function nudgeBpm(delta: number) {
    // 30..300 is the intersection of the sequencer (30..300) and timelorde
    // (10..300) BPM ranges — a value both engines accept.
    const next = Math.max(30, Math.min(300, bpm + delta));
    for (const n of bpmNodes) setNodeParam(n.id, 'bpm', next);
  }

  // ── Session autosave (iOS evicts tabs; the doc is memory-only) ──
  function onVisibility() {
    if (document.visibilityState === 'hidden') saveMobileSession();
  }

  onMount(() => {
    installMobileTestHooks();
    canRestore = hasMobileSession();
    document.addEventListener('visibilitychange', onVisibility);
  });

  onDestroy(() => {
    unsubscribeSnap();
    if (toastTimer) clearTimeout(toastTimer);
    if (pillTimer) clearTimeout(pillTimer);
    document.removeEventListener('visibilitychange', onVisibility);
    saveMobileSession();
    gate.bind(null);
    disposeMobileEngine();
  });
</script>

<svelte:head>
  <title>pocket modular — patchtogether</title>
</svelte:head>

<div class="synth-root" data-testid="m-synth-root" data-started={started}>
  <header class="topbar">
    <a class="brand" href="/m" data-sveltekit-reload>‹ pocket modular</a>
    {#if hasTransport}
      <div class="transport" data-testid="m-transport">
        <button class="bpm-btn" onclick={() => nudgeBpm(-1)} aria-label="bpm down">−</button>
        <span class="bpm" data-testid="m-bpm">{bpm}</span>
        <button class="bpm-btn" onclick={() => nudgeBpm(1)} aria-label="bpm up">+</button>
        <button
          class="run"
          class:on={running}
          onclick={toggleRun}
          data-testid="m-run-toggle"
          aria-label={running ? 'stop the clock' : 'run the clock'}
        >
          {running ? '■' : '▶'}
        </button>
      </div>
    {/if}
    <button class="undo" onclick={() => undoManager.undo()} data-testid="m-undo">UNDO</button>
  </header>

  <main class="content">
    {#if !started}
      <div class="start-card" data-testid="m-start-card">
        <h1>pocket modular</h1>
        <p class="sub">a real modular rack. sound in two taps.</p>
        <button class="bleep" onclick={onFirstBleep} disabled={booting} data-testid="m-first-bleep">
          {booting ? 'starting…' : 'FIRST BLEEP'}
        </button>
        <button class="ghost" onclick={onEmptyRack} disabled={booting} data-testid="m-empty-rack">
          empty rack
        </button>
        {#if canRestore}
          <button class="ghost" onclick={onRestore} disabled={booting} data-testid="m-restore">
            restore last session
          </button>
        {/if}
      </div>
    {:else if activeTab === 'rack'}
      <RackTab
        bind:this={rackTab}
        nodes={snapshot.nodes}
        onJumpToMix={() => (activeTab = 'mix')}
        {toast}
        {undoPill}
      />
    {:else if activeTab === 'patch'}
      <MobileMatrix
        nodes={snapshot.nodes}
        edges={snapshot.edges}
        {toast}
        {undoPill}
        onOpenModule={openModule}
      />
    {:else}
      <MixLanes nodes={snapshot.nodes} {undoPill} />
    {/if}
  </main>

  {#if started}
    <nav class="tabbar" data-testid="m-tabbar">
      <button class:on={activeTab === 'rack'} onclick={() => (activeTab = 'rack')} data-testid="m-tab-rack">
        RACK
      </button>
      <button
        class:on={activeTab === 'patch'}
        onclick={() => (activeTab = 'patch')}
        data-testid="m-tab-patch"
      >
        PATCH
      </button>
      <button class:on={activeTab === 'mix'} onclick={() => (activeTab = 'mix')} data-testid="m-tab-mix">
        MIX
      </button>
    </nav>
  {/if}

  {#if toastMsg}
    <div class="toast" data-testid="m-toast">{toastMsg}</div>
  {/if}
  {#if pillMsg}
    <div class="pill" data-testid="m-undo-pill">
      <span>{pillMsg}</span>
      <button onclick={pillUndo} data-testid="m-undo-pill-btn">UNDO</button>
    </div>
  {/if}
</div>

<style>
  .synth-root {
    position: fixed;
    inset: 0;
    display: flex;
    flex-direction: column;
    background: #0e1116;
    color: #dbe2ee;
    touch-action: manipulation;
  }
  .topbar {
    flex: none;
    height: calc(48px + env(safe-area-inset-top));
    padding: env(safe-area-inset-top) 10px 0;
    display: flex;
    align-items: center;
    gap: 8px;
    border-bottom: 1px solid #1c212b;
  }
  .brand {
    flex: 1;
    color: #dbe2ee;
    font-size: 14px;
    font-weight: 700;
    text-decoration: none;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .transport {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .bpm-btn {
    min-width: 44px;
    min-height: 44px;
    border-radius: 8px;
    border: 1px solid #2a2f3a;
    background: none;
    color: #8b93a3;
    font-size: 16px;
  }
  .bpm {
    min-width: 40px;
    text-align: center;
    font-size: 15px;
    font-weight: 800;
    font-variant-numeric: tabular-nums;
  }
  .run {
    min-width: 44px;
    min-height: 44px;
    border-radius: 8px;
    border: 1px solid #2a2f3a;
    background: none;
    color: #8b93a3;
    font-size: 14px;
  }
  .run.on {
    background: rgba(64, 200, 120, 0.2);
    border-color: rgba(64, 200, 120, 0.5);
    color: #7fe0a8;
  }
  .undo {
    min-height: 44px;
    padding: 0 12px;
    border-radius: 8px;
    border: 1px solid #2a2f3a;
    background: none;
    color: #8b93a3;
    font-size: 12px;
    font-weight: 700;
  }
  .content {
    flex: 1;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .content > :global(*) {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
  .start-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 24px;
    text-align: center;
  }
  .start-card h1 {
    font-size: 28px;
    margin: 0;
  }
  .sub {
    color: #8b93a3;
    margin: 0 0 8px;
  }
  .bleep {
    min-height: 72px;
    min-width: 240px;
    border-radius: 36px;
    border: none;
    background: var(--accent, #4f8cff);
    color: #fff;
    font-size: 20px;
    font-weight: 800;
    letter-spacing: 0.04em;
  }
  .bleep:disabled,
  .ghost:disabled {
    opacity: 0.6;
  }
  .ghost {
    min-height: 48px;
    padding: 0 20px;
    border-radius: 24px;
    border: 1px solid #2a2f3a;
    background: none;
    color: #8b93a3;
    font-size: 15px;
  }
  .tabbar {
    flex: none;
    display: flex;
    height: calc(56px + env(safe-area-inset-bottom));
    padding-bottom: env(safe-area-inset-bottom);
    border-top: 1px solid #1c212b;
    background: #10141b;
  }
  .tabbar button {
    flex: 1;
    border: none;
    background: none;
    color: #667085;
    font-size: 13px;
    font-weight: 800;
    letter-spacing: 0.08em;
  }
  .tabbar button.on {
    color: var(--accent, #4f8cff);
  }
  .toast {
    position: fixed;
    left: 50%;
    bottom: calc(76px + env(safe-area-inset-bottom));
    transform: translateX(-50%);
    background: rgba(20, 24, 33, 0.95);
    border: 1px solid #2a2f3a;
    color: #dbe2ee;
    padding: 10px 18px;
    border-radius: 20px;
    font-size: 13px;
    max-width: 86vw;
    text-align: center;
    z-index: 90;
    /* Purely informational — must NEVER intercept touch on the controls it
       floats over (it sits at the thumb zone, right on top of the MIX master
       lane + bottom rails). Without this the master fader was dead for the
       toast's 2.6s lifetime. */
    pointer-events: none;
  }
  .pill {
    position: fixed;
    left: 50%;
    bottom: calc(76px + env(safe-area-inset-bottom));
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 12px;
    background: rgba(20, 24, 33, 0.95);
    border: 1px solid #2a2f3a;
    color: #dbe2ee;
    padding: 8px 8px 8px 16px;
    border-radius: 24px;
    font-size: 13px;
    z-index: 91;
    /* Only the UNDO button is interactive; the pill body must not block the
       thumb-zone controls it floats over (same seam as .toast above). */
    pointer-events: none;
  }
  .pill button {
    min-height: 44px;
    padding: 0 14px;
    border-radius: 20px;
    border: none;
    background: rgba(79, 140, 255, 0.3);
    color: #dbe2ee;
    font-weight: 800;
    font-size: 12px;
    pointer-events: auto;
  }
</style>

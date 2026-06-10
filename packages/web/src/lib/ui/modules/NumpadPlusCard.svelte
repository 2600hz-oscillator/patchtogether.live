<script lang="ts">
  // NumpadPlusCard — UI for the numpad-driven 4-layer sequencer.
  //
  // Layout (top to bottom):
  //   1. Header: NUMPAD+ + octave display + arrow ↑/↓ to nudge
  //   2. Layer-select row: L1/L2/L3/L4 buttons; current active
  //      highlighted; the layer-CV input wins if patched.
  //   3. Transport row: PLAY/STOP + BPM knob + REC ARM + OVERDUB.
  //   4. 4×4 step grid: each cell shows note name when on; current-
  //      step highlight box moves with the playhead.
  //   5. Keymap legend (compact help): "1=C 2=C# 3=D … *=B + ↑oct − ↓oct".
  //
  // Cell interaction (matches Sequencer's spec):
  //   click toggles step on/off; click+drag changes the note.

  import { onDestroy, onMount } from 'svelte';
  import type { NodeProps } from '@xyflow/svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import { patch, ydoc } from '$lib/graph/store';
  import { setNodeParam } from '$lib/graph/mutate';
  import { useEngine } from '$lib/audio/engine-context';
  import {
    coerceLayers,
    defaultLayers,
    NUMPAD_PLUS_LAYERS,
    NUMPAD_PLUS_STEPS,
    DEFAULT_KEYMAP,
    SEMITONE_NAMES,
    keyCodeLabel,
    codeForSemitone,
    remapKeymap,
    OCTAVE_UP_ACTION,
    OCTAVE_DOWN_ACTION,
  } from '$lib/audio/modules/numpad-plus';
  import { noteNameForMidi } from '$lib/audio/note-entry';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  function pget(key: string, fb: number): number {
    const v = node?.params?.[key];
    return typeof v === 'number' ? v : fb;
  }
  const set = (k: string) => (v: number) => setNodeParam(id, k, v);

  // ─── Live readouts polled from the engine handle ─────────────────
  let activeLayerLive = $state(0);
  let stepIndexLive = $state(-1);
  let armedLive = $state(false);
  const POLL_MS = 33;
  let pollId: ReturnType<typeof setInterval> | null = null;
  function poll() {
    const e = engineCtx.get();
    if (!e || !node) return;
    const al = e.read(node, 'activeLayer');
    if (typeof al === 'number' && al !== activeLayerLive) activeLayerLive = al;
    const si = e.read(node, 'stepIndex');
    if (typeof si === 'number' && si !== stepIndexLive) stepIndexLive = si;
    const ar = e.read(node, 'armedRecording');
    if (typeof ar === 'boolean' && ar !== armedLive) armedLive = ar;
  }
  onMount(() => { pollId = setInterval(poll, POLL_MS); });
  onDestroy(() => { if (pollId !== null) clearInterval(pollId); pollId = null; });

  // ─── Layers data (node.data.layers) ──────────────────────────────
  let layers = $derived.by(() => {
    const raw = (node?.data as Record<string, unknown> | undefined)?.layers;
    return raw ? coerceLayers(raw) : defaultLayers();
  });

  function setStep(layerIdx: number, stepIdx: number, on: boolean, midi: number | null) {
    const t = patch.nodes[id];
    if (!t) return;
    ydoc.transact(() => {
      if (!t.data) t.data = {};
      const d = t.data as Record<string, unknown>;
      const cur = coerceLayers(d.layers);
      const layer = cur[layerIdx]!;
      layer[stepIdx] = { on, midi };
      d.layers = cur.map((l) => l.map((s) => ({ ...s })));
    });
  }
  function toggleStep(stepIdx: number) {
    const layer = layers[activeLayerLive];
    const cur = layer?.[stepIdx] ?? { on: false, midi: null };
    setStep(activeLayerLive, stepIdx, !cur.on, cur.midi ?? (12 + pget('octave', 4) * 12));
  }

  function nudgeOctave(delta: number) {
    const cur = pget('octave', 4);
    set('octave')(Math.max(0, Math.min(8, cur + delta)));
  }

  // ─── PatchPanel ports ────────────────────────────────────────────
  const inputs: PortDescriptor[] = [
    { id: 'clock', label: 'CLK', cable: 'gate' },
    { id: 'layer', label: 'LYR', cable: 'cv'   },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'l1_pitch', label: 'L1 P', cable: 'pitch' },
    { id: 'l1_gate',  label: 'L1 G', cable: 'gate'  },
    { id: 'l2_pitch', label: 'L2 P', cable: 'pitch' },
    { id: 'l2_gate',  label: 'L2 G', cable: 'gate'  },
    { id: 'l3_pitch', label: 'L3 P', cable: 'pitch' },
    { id: 'l3_gate',  label: 'L3 G', cable: 'gate'  },
    { id: 'l4_pitch', label: 'L4 P', cable: 'pitch' },
    { id: 'l4_gate',  label: 'L4 G', cable: 'gate'  },
    { id: 'poly',     label: 'POLY', cable: 'polyPitchGate' },
  ];

  // ─── Display helpers ─────────────────────────────────────────────
  function cellLabel(stepIdx: number): string {
    const layer = layers[activeLayerLive];
    const step = layer?.[stepIdx] ?? { on: false, midi: null };
    if (!step.on || step.midi === null) return '·';
    return noteNameForMidi(step.midi) || '?';
  }
  function isActiveStep(stepIdx: number): boolean {
    return stepIdx === stepIndexLive && pget('isPlaying', 0) >= 0.5;
  }

  // ─── Keymap (node.data.keymap: physical event.code → semitone 0..11) ──
  // Reactive view of the live keymap, falling back to the default layout.
  let keymap = $derived.by(() => {
    const raw = (node?.data as { keymap?: Record<string, number> } | undefined)?.keymap;
    return raw && typeof raw === 'object' ? raw : { ...DEFAULT_KEYMAP };
  });

  // Remap interaction state.
  let remapSemitone = $state<number | null>(null);          // note currently "listening" for a key
  let menuSemitone = $state<number | null>(null);           // note whose right-click menu is open
  let menuX = $state(0);
  let menuY = $state(0);

  function writeKeymap(next: Record<string, number>) {
    const t = patch.nodes[id];
    if (!t) return;
    ydoc.transact(() => {
      if (!t.data) t.data = {};
      (t.data as Record<string, unknown>).keymap = { ...next };
    });
  }
  function openKeyMenu(e: MouseEvent, semitone: number) {
    e.preventDefault();
    e.stopPropagation();
    menuSemitone = semitone;
    menuX = e.clientX;
    menuY = e.clientY;
  }
  function beginRemap(semitone: number) {
    menuSemitone = null;
    remapSemitone = semitone;
  }
  function resetKey(semitone: number) {
    menuSemitone = null;
    const defCode = codeForSemitone(DEFAULT_KEYMAP, semitone);
    if (defCode) writeKeymap(remapKeymap(keymap, defCode, semitone));
  }
  function physLabelFor(semitone: number): string {
    if (remapSemitone === semitone) return '…';
    const code = codeForSemitone(keymap, semitone);
    return code ? keyCodeLabel(code) : '—';
  }
  // Display name for a remap target: the note name for 0..11, or the octave
  // action label for the two sentinel targets.
  function targetLabel(target: number): string {
    if (target === OCTAVE_UP_ACTION) return 'OCT↑';
    if (target === OCTAVE_DOWN_ACTION) return 'OCT↓';
    return SEMITONE_NAMES[target] ?? '?';
  }

  // Portal the floating remap menu to <body>: it's position:fixed but the card
  // lives inside SvelteFlow's transformed/zoomed node, so a transformed ancestor
  // would anchor the menu to itself (wrong spot, drifts on pan/zoom). Appending
  // to <body> removes that ancestor so it spawns under the cursor. Mirrors
  // ControlContextMenu.svelte.
  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return { destroy() { node.remove(); } };
  }

  // While listening, capture the next physical keydown (ANY key) and bind it to
  // the target note. ESC cancels. Capture-phase + stopImmediatePropagation so
  // the keystroke binds instead of (also) playing/typing elsewhere.
  $effect(() => {
    if (remapSemitone === null) return;
    const target = remapSemitone;
    const onKey = (ev: KeyboardEvent) => {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      if (ev.code === 'Escape') { remapSemitone = null; return; }
      writeKeymap(remapKeymap(keymap, ev.code, target));
      remapSemitone = null;
    };
    document.addEventListener('keydown', onKey, { capture: true });
    return () => document.removeEventListener('keydown', onKey, { capture: true });
  });

  // ─── isPlaying / REC / OVD / POLY toggles ────────────────────────
  let isPlaying = $derived(pget('isPlaying', 0) >= 0.5);
  let recArm = $derived(pget('recArm', 0) >= 0.5);
  let overdub = $derived(pget('overdub', 0) >= 0.5);
  let poly = $derived(pget('poly', 0) >= 0.5);
  function togglePlay() { set('isPlaying')(isPlaying ? 0 : 1); }
  function toggleRecArm() { set('recArm')(recArm ? 0 : 1); }
  function toggleOverdub() { set('overdub')(overdub ? 0 : 1); }
  function togglePoly() { set('poly')(poly ? 0 : 1); }
</script>

<div class="card numpad-plus" data-testid="numpad-plus-card" data-node-id={id}>
  <div class="stripe"></div>
  <header class="title">
    <ModuleTitle {id} {data} defaultLabel="NUMPAD+" inline />
    <div class="octave-control nodrag">
      <span class="oct-label">Oct</span>
      <button type="button" class="oct-btn" onclick={() => nudgeOctave(-1)} data-testid="numpad-octave-down">▼</button>
      <span class="oct-value" data-testid="numpad-octave-value">{pget('octave', 4)}</span>
      <button type="button" class="oct-btn" onclick={() => nudgeOctave(+1)} data-testid="numpad-octave-up">▲</button>
    </div>
  </header>

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="body">
      <!-- Layer row -->
      <div class="layer-row">
        {#each [0, 1, 2, 3] as l (l)}
          <button
            type="button"
            class="layer-btn"
            class:on={activeLayerLive === l}
            onclick={() => set('activeLayer')(l)}
            data-testid={`numpad-layer-${l + 1}`}
          >L{l + 1}</button>
        {/each}
      </div>

      <!-- Transport -->
      <div class="transport-row">
        <button
          type="button"
          class="play-btn nodrag"
          class:on={isPlaying}
          onclick={togglePlay}
          data-testid="numpad-play"
        >{isPlaying ? '■ STOP' : '▶ PLAY'}</button>
        <Knob value={pget('bpm', 120)} min={30} max={300} defaultValue={120} label="BPM" units="bpm" curve="linear" onchange={set('bpm')} moduleId={id} paramId="bpm" />
        <button
          type="button"
          class="rec-btn nodrag"
          class:on={recArm}
          class:armed={armedLive}
          onclick={toggleRecArm}
          data-testid="numpad-rec-arm"
          title={armedLive ? 'Recording NOW (auto-disarms after 16 steps)' : 'REC ARM: arms; next play-from-start records'}
        >{armedLive ? '◉ REC' : 'ARM'}</button>
        <button
          type="button"
          class="ovd-btn nodrag"
          class:on={overdub}
          onclick={toggleOverdub}
          data-testid="numpad-overdub"
          title="OVERDUB: every keypress writes the nearest step"
        >OVD</button>
        <button
          type="button"
          class="poly-btn nodrag"
          class:on={poly}
          onclick={togglePoly}
          data-testid="numpad-poly"
          aria-pressed={poly}
          title="POLY: record up to 5 held keys per step (mono outs send the lowest; POLY out sends all)"
        >POLY</button>
      </div>

      <!-- 4x4 step grid -->
      <div class="grid">
        {#each Array(NUMPAD_PLUS_STEPS) as _, s (s)}
          <button
            type="button"
            class="cell"
            class:on={layers[activeLayerLive]?.[s]?.on ?? false}
            class:active={isActiveStep(s)}
            onclick={() => toggleStep(s)}
            data-testid={`numpad-cell-${s}`}
            aria-label={`Step ${s + 1}`}
          >{cellLabel(s)}</button>
        {/each}
      </div>

      <!-- Keymap: 12 remappable note-keys. Each shows the physical key bound to
           that note. Right-click → remap (press any key) or reset. -->
      <div class="keymap" data-testid="numpad-keymap"
           title="Right-click a key to remap it, then press any keyboard/numpad key">
        {#each Array(12) as _, st (st)}
          <button
            type="button"
            class="kmap-key nodrag"
            class:listening={remapSemitone === st}
            oncontextmenu={(e) => openKeyMenu(e, st)}
            data-testid={`numpad-key-${st}`}
            data-note={SEMITONE_NAMES[st]}
            aria-label={`${SEMITONE_NAMES[st]} — key ${physLabelFor(st)} (right-click to remap)`}
          >
            <span class="kmap-phys">{physLabelFor(st)}</span>
            <span class="kmap-note">{SEMITONE_NAMES[st]}</span>
          </button>
        {/each}
        <!-- Octave up/down: remappable keys (default numpad +/−) that nudge the
             module octave. Same right-click remap flow as the note keys. -->
        {#each [OCTAVE_UP_ACTION, OCTAVE_DOWN_ACTION] as act (act)}
          <button
            type="button"
            class="kmap-key oct-key nodrag"
            class:listening={remapSemitone === act}
            oncontextmenu={(e) => openKeyMenu(e, act)}
            data-testid={`numpad-octkey-${act}`}
            aria-label={`${targetLabel(act)} — key ${physLabelFor(act)} (right-click to remap)`}
          >
            <span class="kmap-phys">{physLabelFor(act)}</span>
            <span class="kmap-note">{targetLabel(act)}</span>
          </button>
        {/each}
      </div>

      {#if remapSemitone !== null}
        <div class="remap-hint" data-testid="numpad-remap-hint">
          Press any key to map it to <b>{targetLabel(remapSemitone)}</b> · Esc to cancel
        </div>
      {/if}

      <div class="hint">
        Mapped keys captured globally while this card exists (any physical key);
        recordings need REC ARM + play-from-start OR OVD toggle on.
        Layers used: {NUMPAD_PLUS_LAYERS} · steps/layer: {NUMPAD_PLUS_STEPS}.
      </div>
    </div>
  </PatchPanel>
</div>

{#if menuSemitone !== null}
  <!-- Portaled to <body> so position:fixed resolves against the viewport, not
       SvelteFlow's transformed node — otherwise the menu spawns off-cursor. -->
  <div use:portal>
    <div
      class="kmap-menu-backdrop"
      role="presentation"
      onpointerdown={() => (menuSemitone = null)}
      oncontextmenu={(e) => { e.preventDefault(); menuSemitone = null; }}
    ></div>
    <div class="kmap-menu nodrag" role="menu" style="left:{menuX}px; top:{menuY}px;" data-testid="numpad-key-menu">
      <button type="button" role="menuitem" class="kmap-menu-item"
        onclick={() => beginRemap(menuSemitone!)} data-testid="numpad-remap-item">Remap…</button>
      <button type="button" role="menuitem" class="kmap-menu-item"
        onclick={() => resetKey(menuSemitone!)} data-testid="numpad-reset-item">Reset to default</button>
    </div>
  </div>
{/if}

<style>
  .card {
    background: var(--module-bg);
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text);
    padding: 14px 12px 12px;
    position: relative;
    min-width: 360px;
  }
  .stripe {
    position: absolute; top: 0; left: 0; right: 0; height: 2px;
    background: var(--cable-gate);
  }
  .title {
    font-size: 13px; font-weight: 700; letter-spacing: 1px;
    text-align: center; margin-bottom: 8px;
    display: flex; align-items: center; justify-content: center; gap: 12px;
  }
  .octave-control {
    display: flex; align-items: center; gap: 4px;
    font-size: 0.7rem; font-weight: 400;
  }
  .oct-label { color: var(--text-dim); font-size: 0.65rem; }
  .oct-btn {
    appearance: none;
    background: rgba(10,12,16,0.7);
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text-dim);
    width: 18px; height: 18px;
    font-size: 0.6rem;
    cursor: pointer;
    line-height: 1;
  }
  .oct-btn:hover { color: var(--accent); border-color: var(--accent); }
  .oct-value {
    font-family: ui-monospace, monospace;
    color: var(--accent, #00f0ff);
    min-width: 14px; text-align: center;
  }

  .body { display: flex; flex-direction: column; gap: 6px; }

  .layer-row { display: flex; gap: 4px; }
  .layer-btn {
    flex: 1;
    appearance: none;
    background: rgba(10,12,16,0.7);
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text-dim);
    padding: 6px 0;
    font-size: 0.75rem; font-weight: 700;
    cursor: pointer;
    font-family: ui-monospace, monospace;
  }
  .layer-btn.on {
    background: var(--accent, #00f0ff);
    color: #000;
    border-color: var(--accent, #00f0ff);
  }

  .transport-row {
    display: flex; align-items: center; gap: 8px;
    padding: 4px 6px;
    background: rgba(0,0,0,0.2);
    border: 1px solid var(--border);
    border-radius: 2px;
  }
  .play-btn, .rec-btn, .ovd-btn, .poly-btn {
    appearance: none;
    background: rgba(10,12,16,0.7);
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text);
    padding: 4px 10px;
    font-size: 0.7rem;
    font-weight: 700;
    cursor: pointer;
  }
  .play-btn.on { background: var(--accent, #00f0ff); color: #000; border-color: var(--accent, #00f0ff); }
  .rec-btn.on  { background: #ff3030; color: #fff; border-color: #ff3030; }
  .rec-btn.armed { animation: pulse 0.5s steps(2) infinite; }
  .ovd-btn.on  { background: #ff8800; color: #000; border-color: #ff8800; }
  .poly-btn.on { background: #00f0ff; color: #000; border-color: #00f0ff; }

  @keyframes pulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(255,48,48,0.8); }
    50%      { box-shadow: 0 0 6px 2px rgba(255,48,48,0.8); }
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 3px;
  }
  .cell {
    appearance: none;
    aspect-ratio: 1.4 / 1;
    background: rgba(10,12,16,0.7);
    border: 1px solid var(--border);
    border-radius: 1px;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
    font-size: 0.7rem;
    cursor: pointer;
  }
  .cell.on {
    background: var(--cable-gate, #ffd000);
    color: #000;
    border-color: var(--cable-gate, #ffd000);
  }
  .cell.active {
    outline: 2px solid var(--accent, #00f0ff);
    outline-offset: -1px;
  }

  /* Remappable note-keys */
  .keymap {
    display: flex; flex-wrap: wrap; gap: 3px; align-items: center;
    padding: 4px 0;
    border-top: 1px dashed rgba(255,255,255,0.05);
  }
  .kmap-key {
    appearance: none;
    display: flex; flex-direction: column; align-items: center; gap: 1px;
    background: rgba(10,12,16,0.7);
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text);
    width: 26px; padding: 3px 0;
    cursor: pointer;
    font-family: ui-monospace, monospace;
  }
  .kmap-key:hover { border-color: var(--accent, #00f0ff); }
  .kmap-key.listening {
    border-color: #f5c248;
    box-shadow: 0 0 0 2px rgba(245,194,72,0.5);
    animation: pulse-remap 1s ease-in-out infinite;
  }
  @keyframes pulse-remap { 0%,100% { border-color:#f5c248; } 50% { border-color:rgba(245,194,72,0.3); } }
  .kmap-phys { font-size: 0.72rem; font-weight: 700; color: var(--accent, #00f0ff); line-height: 1; }
  .kmap-note { font-size: 0.5rem; color: var(--text-dim); line-height: 1; }
  .legend-mod { font-size: 0.55rem; color: var(--text-dim); font-family: ui-monospace, monospace; margin-left: 4px; }
  .legend-mod b { color: var(--accent, #00f0ff); margin-right: 2px; }

  .remap-hint {
    font-size: 0.62rem;
    color: #f5c248;
    font-family: ui-monospace, monospace;
    padding: 2px 0;
  }
  .remap-hint b { color: var(--accent, #00f0ff); }

  /* Floating remap context menu */
  .kmap-menu-backdrop {
    position: fixed; inset: 0; z-index: 999;
  }
  .kmap-menu {
    position: fixed; z-index: 1000;
    background: #14171c;
    border: 1px solid var(--border);
    border-radius: 3px;
    box-shadow: 0 4px 14px rgba(0,0,0,0.5);
    padding: 3px;
    display: flex; flex-direction: column;
    min-width: 130px;
  }
  .kmap-menu-item {
    appearance: none;
    background: transparent;
    border: none;
    color: var(--text);
    text-align: left;
    padding: 5px 8px;
    font-size: 0.72rem;
    border-radius: 2px;
    cursor: pointer;
  }
  .kmap-menu-item:hover { background: rgba(255,255,255,0.08); color: var(--accent, #00f0ff); }

  .hint {
    font-size: 0.6rem;
    color: var(--text-dim);
    line-height: 1.3;
    margin-top: 2px;
  }
</style>

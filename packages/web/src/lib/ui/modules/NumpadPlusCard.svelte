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
  import { useEngine } from '$lib/audio/engine-context';
  import {
    coerceLayers,
    defaultLayers,
    NUMPAD_PLUS_LAYERS,
    NUMPAD_PLUS_STEPS,
    DEFAULT_KEYMAP,
  } from '$lib/audio/modules/numpad-plus';
  import { noteNameForMidi } from '$lib/audio/note-entry';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  function pget(key: string, fb: number): number {
    const v = node?.params?.[key];
    return typeof v === 'number' ? v : fb;
  }
  const set = (k: string) => (v: number) => {
    const t = patch.nodes[id];
    if (t) t.params[k] = v;
  };

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

  // ─── Keymap legend (compact) ─────────────────────────────────────
  // Build "Numpad1=C, Numpad2=C#, …" from the default keymap, shown
  // as a compact "1:C 2:C# 3:D 4:D# 5:E 6:F 7:F# 8:G 9:G# 0:A /:A# *:B" line.
  const KEYMAP_LEGEND = (() => {
    const labels: { key: string; note: string }[] = [];
    const order = ['Numpad1','Numpad2','Numpad3','Numpad4','Numpad5','Numpad6',
                   'Numpad7','Numpad8','Numpad9','Numpad0','NumpadDivide','NumpadMultiply'];
    const noteNames = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    for (let i = 0; i < order.length; i++) {
      const display = order[i]!.replace('Numpad', '').replace('Divide', '/').replace('Multiply', '*');
      labels.push({ key: display, note: noteNames[i]! });
    }
    return labels;
  })();

  // ─── isPlaying / REC / OVD toggles ───────────────────────────────
  let isPlaying = $derived(pget('isPlaying', 0) >= 0.5);
  let recArm = $derived(pget('recArm', 0) >= 0.5);
  let overdub = $derived(pget('overdub', 0) >= 0.5);
  function togglePlay() { set('isPlaying')(isPlaying ? 0 : 1); }
  function toggleRecArm() { set('recArm')(recArm ? 0 : 1); }
  function toggleOverdub() { set('overdub')(overdub ? 0 : 1); }

  // Reference the keymap so the unused-import lint stays quiet — we
  // export DEFAULT_KEYMAP from the module so users can extend it.
  void DEFAULT_KEYMAP;
</script>

<div class="card numpad-plus" data-testid="numpad-plus-card" data-node-id={id}>
  <div class="stripe"></div>
  <header class="title">
    NUMPAD+
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
        <Knob value={pget('bpm', 120)} min={30} max={300} defaultValue={120} label="BPM" units="bpm" curve="linear" onchange={set('bpm')} />
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

      <!-- Keymap legend -->
      <div class="legend" title="Press these numpad keys to play the active layer">
        {#each KEYMAP_LEGEND as e (e.key)}
          <span class="legend-pair"><b>{e.key}</b>:{e.note}</span>
        {/each}
        <span class="legend-mod"><b>+</b>oct↑ <b>−</b>oct↓</span>
      </div>

      <div class="hint">
        Numpad keys captured globally while this card exists; recordings need REC ARM + play-from-start OR OVD toggle on.
        Layers used: {NUMPAD_PLUS_LAYERS} · steps/layer: {NUMPAD_PLUS_STEPS}.
      </div>
    </div>
  </PatchPanel>
</div>

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
  .play-btn, .rec-btn, .ovd-btn {
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

  .legend {
    display: flex; flex-wrap: wrap; gap: 6px;
    font-size: 0.62rem;
    font-family: ui-monospace, monospace;
    color: var(--text-dim);
    padding: 4px 0;
    border-top: 1px dashed rgba(255,255,255,0.05);
  }
  .legend-pair b, .legend-mod b { color: var(--accent, #00f0ff); margin-right: 2px; }

  .hint {
    font-size: 0.6rem;
    color: var(--text-dim);
    line-height: 1.3;
    margin-top: 2px;
  }
</style>

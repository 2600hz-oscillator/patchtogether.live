<script lang="ts">
  // AtlantisCatalystCard — the SCENECHANGE controller card. (Internal type
  // id stays `atlantisCatalyst` for back-compat with saved rackspaces.)
  //
  // Top row: a big circular "NUDGE" button + a 1..4 scene-slot row + freeze
  // toggle.
  //
  // Scene-slot click behavior:
  //   - plain click   → RECALL slot (if saved) / else stochastic transition
  //   - Shift+click   → SAVE current state into slot
  // A filled disc under the digit indicates the slot has a snapshot. The
  // 4 scene CV gate inputs (S1..S4) follow the same recall-if-saved /
  // re-roll fallback so the Atlantis demo patch keeps sounding right.
  //
  // Bottom row: drift / chaos / coherence / depth / bias / level faders.

  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch, ydoc } from '$lib/graph/store';
  import { setNodeParam } from '$lib/graph/mutate';
  import {
    atlantisCatalystDef,
    captureScene,
    coerceScene,
    type CatalystScene,
    type CatalystSceneSlot,
  } from '$lib/audio/modules/atlantis-catalyst';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import { onDestroy } from 'svelte';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  function defaultFor(k: string): number {
    return atlantisCatalystDef.params.find((p) => p.id === k)?.defaultValue ?? 0;
  }
  function paramVal(k: string): number {
    const v = node?.params?.[k];
    return typeof v === 'number' ? v : defaultFor(k);
  }
  const set = (k: string) => (v: number) => {
    setNodeParam(id, k, v);
  };
  const live = (k: string) => () => {
    const e = engineCtx.get(); if (!e || !node) return undefined;
    return e.readParam(node, k);
  };

  let scene = $state(0);
  let secsLeft = $state(0);
  let pulsing = $state(false);
  let frozen = $state(false);
  const poll = setInterval(() => {
    const e = engineCtx.get(); if (!e || !node) return;
    const s = e.read(node, 'scene'); if (typeof s === 'number') scene = s;
    const sl = e.read(node, 'secsToNextScene'); if (typeof sl === 'number') secsLeft = sl;
    const p = e.read(node, 'pulsing'); pulsing = p === true;
    const f = e.read(node, 'frozen'); frozen = f === true;
  }, 200);
  onDestroy(() => clearInterval(poll));

  // Re-render on Yjs updates so slot indicators reflect remote saves.
  let cardVersion = $state(0);
  $effect(() => {
    const h = () => { cardVersion = cardVersion + 1; };
    ydoc.on('update', h);
    return () => ydoc.off('update', h);
  });

  const SLOTS: CatalystSceneSlot[] = ['1', '2', '3', '4'];

  function readScenes(): Partial<Record<CatalystSceneSlot, CatalystScene | null>> {
    const raw = (node?.data as Record<string, unknown> | undefined)?.scenes;
    if (!raw || typeof raw !== 'object') return {};
    const out: Partial<Record<CatalystSceneSlot, CatalystScene | null>> = {};
    for (const s of SLOTS) out[s] = coerceScene((raw as Record<string, unknown>)[s]);
    return out;
  }
  let savedSlots = $derived((void cardVersion, readScenes()));
  function isSaved(slot: CatalystSceneSlot): boolean {
    return savedSlots[slot] != null;
  }

  function readLiveSnapshot(): CatalystScene | null {
    const e = engineCtx.get(); if (!e || !node) return null;
    const driftValues = e.read(node, 'driftValues');
    if (!Array.isArray(driftValues)) return null;
    // Prefer engine-side live params (reflects the smoothed audio-rate
    // gain / freshly-recalled state) over the patch-graph snapshot.
    const liveParams = {
      driftRate: (e.readParam(node, 'driftRate') as number) ?? paramVal('driftRate'),
      chaos: (e.readParam(node, 'chaos') as number) ?? paramVal('chaos'),
      coherence: (e.readParam(node, 'coherence') as number) ?? paramVal('coherence'),
      sceneDepth: (e.readParam(node, 'sceneDepth') as number) ?? paramVal('sceneDepth'),
      autoMode: (e.readParam(node, 'autoMode') as number) ?? paramVal('autoMode'),
      bias: (e.readParam(node, 'bias') as number) ?? paramVal('bias'),
      level: (e.readParam(node, 'level') as number) ?? paramVal('level'),
    };
    return captureScene(liveParams, driftValues as number[]);
  }

  function saveSlot(slot: CatalystSceneSlot) {
    const snap = readLiveSnapshot();
    if (!snap) return;
    const t = patch.nodes[id]; if (!t) return;
    ydoc.transact(() => {
      if (!t.data) t.data = {};
      const d = t.data as Record<string, unknown>;
      const cur = (d.scenes as Record<string, unknown> | undefined) ?? {};
      d.scenes = { ...cur, [slot]: snap };
    });
  }

  function recallSlot(slot: CatalystSceneSlot) {
    const t = patch.nodes[id]; if (!t) return;
    // Same uiSceneJump path the CV gates use — the engine reads it on its
    // next tick, decides recall-vs-stochastic, and ramps accordingly.
    t.params.uiSceneJump = Number(slot);
    setTimeout(() => {
      const tt = patch.nodes[id];
      if (tt && tt.params.uiSceneJump === Number(slot)) tt.params.uiSceneJump = 0;
    }, 100);
  }

  function handleSlotClick(slot: CatalystSceneSlot, ev: MouseEvent) {
    if (ev.shiftKey) saveSlot(slot);
    else recallSlot(slot);
  }

  function manualNudge() {
    // Cycle to the next scene index — falls through the same jumpToScene
    // path so a slot with a snapshot still triggers recall.
    const target = ((scene + 1) % 4) + 1;
    recallSlot(String(target) as CatalystSceneSlot);
  }

  function toggleFreeze() {
    const t = patch.nodes[id]; if (!t) return;
    t.params.uiFreeze = (t.params.uiFreeze ?? 0) >= 0.5 ? 0 : 1;
  }

  const inputs: PortDescriptor[] = [
    { id: 'nudge',     label: 'NDG',  cable: 'gate' },
    { id: 'freeze',    label: 'FRZ',  cable: 'gate' },
    { id: 'seed_cv',   label: 'SD',   cable: 'cv' },
    { id: 'play_cv',   label: 'PL',   cable: 'gate' },
    { id: 'reset_cv',  label: 'RST',  cable: 'gate' },
    { id: 'queue1_cv', label: 'S1',   cable: 'gate' },
    { id: 'queue2_cv', label: 'S2',   cable: 'gate' },
    { id: 'queue3_cv', label: 'S3',   cable: 'gate' },
    { id: 'queue4_cv', label: 'S4',   cable: 'gate' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'drift1', label: 'D1', cable: 'cv' },
    { id: 'drift2', label: 'D2', cable: 'cv' },
    { id: 'drift3', label: 'D3', cable: 'cv' },
    { id: 'drift4', label: 'D4', cable: 'cv' },
    { id: 'drift5', label: 'D5', cable: 'cv' },
    { id: 'drift6', label: 'D6', cable: 'cv' },
    { id: 'drift7', label: 'D7', cable: 'cv' },
    { id: 'drift8', label: 'D8', cable: 'cv' },
    { id: 'scene_pulse', label: 'PUL', cable: 'gate' },
    { id: 'scene_idx',   label: 'IDX', cable: 'cv' },
  ];
</script>

<div class="mod-card catalyst-card" class:pulsing>
  <div class="stripe" style="background: var(--cable-cv);"></div>
  <ModuleTitle {id} {data} defaultLabel="SCENECHANGE" />

  <PatchPanel nodeId={id} {inputs} {outputs} panelWidth={320}>
    <div class="body">
      <div class="top">
        <button
          class="nudge-btn"
          onclick={manualNudge}
          title="Advance to next scene (recall if saved)"
          data-testid="catalyst-nudge"
        >NUDGE</button>
        <div class="scenes" title="click = recall · shift+click = save">
          {#each SLOTS as slot (slot)}
            <button
              class="scene"
              class:active={scene + 1 === Number(slot)}
              class:saved={isSaved(slot)}
              onclick={(ev) => handleSlotClick(slot, ev)}
              data-testid={`catalyst-scene-${slot}`}
              data-saved={isSaved(slot) ? '1' : '0'}
              aria-label={`Scene ${slot} — click to recall, shift+click to save`}
            >
              <span class="digit">{slot}</span>
              <span class="dot" aria-hidden="true"></span>
            </button>
          {/each}
        </div>
        <button
          class="freeze-btn"
          class:on={frozen}
          onclick={toggleFreeze}
          data-testid="catalyst-freeze"
        >{frozen ? 'FROZEN' : 'FRZ'}</button>
      </div>
      <div class="readout">
        <span class="lbl">SCENE</span> <span class="val">{scene + 1}/4</span>
        <span class="sep">·</span>
        <span class="lbl">NEXT</span> <span class="val">{Math.ceil(secsLeft)}s</span>
        <span class="sep">·</span>
        <span class="hint">shift+click = save</span>
      </div>

      <div class="grid">
        <Fader value={paramVal('driftRate')}  min={0} max={1} defaultValue={defaultFor('driftRate')}  label="Drift"  curve="log"    onchange={set('driftRate')} moduleId={id} paramId="driftRate"  readLive={live('driftRate')} />
        <Fader value={paramVal('chaos')}      min={0} max={1} defaultValue={defaultFor('chaos')}      label="Chaos"  curve="linear" onchange={set('chaos')} moduleId={id} paramId="chaos"      readLive={live('chaos')} />
        <Fader value={paramVal('coherence')}  min={0} max={1} defaultValue={defaultFor('coherence')}  label="Coh"    curve="linear" onchange={set('coherence')} moduleId={id} paramId="coherence"  readLive={live('coherence')} />
        <Fader value={paramVal('sceneDepth')} min={0} max={1} defaultValue={defaultFor('sceneDepth')} label="Depth"  curve="linear" onchange={set('sceneDepth')} moduleId={id} paramId="sceneDepth" readLive={live('sceneDepth')} />
        <Fader value={paramVal('bias')}       min={-1} max={1} defaultValue={defaultFor('bias')}      label="Bias"   curve="linear" onchange={set('bias')} moduleId={id} paramId="bias"       readLive={live('bias')} />
        <Fader value={paramVal('level')}      min={0} max={1} defaultValue={defaultFor('level')}      label="Lvl"    curve="linear" onchange={set('level')} moduleId={id} paramId="level"      readLive={live('level')} />
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .mod-card {
    width: 360px;
    background: var(--module-bg);
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text);
    padding-top: 18px;
    padding-bottom: 14px;
    position: relative;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    transition: border-color 80ms ease-out, box-shadow 80ms ease-out;
  }
  :global(.svelte-flow__node:hover) .mod-card { border-color: var(--accent-dim); }
  :global(.svelte-flow__node.selected) .mod-card {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .stripe { position: absolute; top: 0; left: 0; right: 0; height: 2px; border-radius: 2px 2px 0 0; }
  .title { font-size: 0.85rem; font-weight: 500; text-align: center; margin: 0 0 8px; letter-spacing: 0.05em; }
  .body { padding: 4px 12px 10px; }
  .top {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .nudge-btn {
    width: 64px;
    height: 64px;
    border-radius: 50%;
    background: linear-gradient(180deg, #5d76b7 0%, #3a4a78 100%);
    color: white;
    border: 2px solid #1c233a;
    font-weight: 600;
    font-size: 0.75rem;
    letter-spacing: 0.08em;
    cursor: pointer;
    flex-shrink: 0;
    box-shadow: inset 0 1px 1px rgba(255,255,255,0.2), 0 2px 4px rgba(0,0,0,0.3);
  }
  .nudge-btn:hover { filter: brightness(1.15); }
  .nudge-btn:active { filter: brightness(0.9); }
  .pulsing .nudge-btn { box-shadow: inset 0 1px 1px rgba(255,255,255,0.2), 0 0 12px var(--accent-glow), 0 2px 4px rgba(0,0,0,0.3); }
  .scenes {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 4px;
    flex: 1;
  }
  .scene {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--module-bg);
    color: var(--text-dim);
    border: 1px solid var(--border);
    border-radius: 3px;
    font-size: 0.65rem;
    letter-spacing: 0.08em;
    padding: 6px;
    cursor: pointer;
    font-family: ui-monospace, monospace;
  }
  .scene.active {
    background: var(--accent-dim);
    color: var(--text);
    border-color: var(--accent);
  }
  .scene:hover { border-color: var(--accent-dim); }
  .scene .digit { line-height: 1; }
  .scene .dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    border: 1px solid var(--text-dim);
    background: transparent;
    margin-left: 5px;
    box-sizing: border-box;
  }
  .scene.saved .dot {
    background: var(--accent);
    border-color: var(--accent);
  }
  .freeze-btn {
    background: var(--module-bg);
    color: var(--text-dim);
    border: 1px solid var(--border);
    border-radius: 3px;
    font-size: 0.65rem;
    letter-spacing: 0.08em;
    padding: 6px 10px;
    cursor: pointer;
    font-family: ui-monospace, monospace;
  }
  .freeze-btn.on {
    background: rgba(135, 200, 255, 0.2);
    color: #87c8ff;
    border-color: #87c8ff;
  }
  .readout {
    margin-top: 8px;
    text-align: center;
    font-family: ui-monospace, monospace;
    font-size: 0.65rem;
    color: var(--text-dim);
    letter-spacing: 0.05em;
  }
  .readout .val { color: var(--text); }
  .readout .sep { margin: 0 6px; opacity: 0.4; }
  .readout .hint { opacity: 0.7; }
  .grid {
    margin-top: 12px;
    display: grid;
    grid-template-columns: repeat(6, 1fr);
    gap: 6px;
    justify-items: center;
  }
</style>

<script lang="ts">
  // AtlantisCatalystCard — the catalyst-controller card.
  //
  // Top row: a big circular "NUDGE" button + a small AUTO toggle + freeze
  // toggle, plus 4 scene buttons (jump to scene N) and a countdown showing
  // seconds until the next auto scene change.
  //
  // Bottom row: drift / chaos / coherence / depth / bias / level faders.
  //
  // PatchPanel handles the 11-ish IO ports (8 drift outs + 2 special outs,
  // nudge/freeze/seed + 6 transport-CV inputs). The visual focus is on the
  // big NUDGE button — clicking it manually transitions the system.

  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { atlantisCatalystDef } from '$lib/audio/modules/atlantis-catalyst';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import { onDestroy } from 'svelte';

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
    const t = patch.nodes[id]; if (t) t.params[k] = v;
  };
  const live = (k: string) => () => {
    const e = engineCtx.get(); if (!e || !node) return undefined;
    return e.readParam(node, k);
  };

  let scene = $state(0);
  let secsLeft = $state(0);
  let pulsing = $state(false);
  let frozen = $state(false);
  // Poll the engine for live state at 5 Hz — enough to keep the countdown
  // visibly ticking down without burning rAF on a card that mostly sits idle.
  const poll = setInterval(() => {
    const e = engineCtx.get(); if (!e || !node) return;
    const s = e.read(node, 'scene'); if (typeof s === 'number') scene = s;
    const sl = e.read(node, 'secsToNextScene'); if (typeof sl === 'number') secsLeft = sl;
    const p = e.read(node, 'pulsing'); pulsing = p === true;
    const f = e.read(node, 'frozen'); frozen = f === true;
  }, 200);
  onDestroy(() => clearInterval(poll));

  // Manual nudge: fire a tiny gate into the nudge input via a one-shot
  // ConstantSource? Simpler: just write a transient on the patch's
  // engine-readable param. The catalyst's drainInputAndStep polls the
  // nudge audio buf — we can't trigger that from the UI without an actual
  // audio source. So instead we directly call the engine's `setParam`
  // doesn't help either. The cleanest path: expose a 'nudge' read key that
  // the catalyst checks on every drain. For v1 we just bypass via param:
  // bump an internal counter the catalyst polls.
  function manualNudge() {
    const t = patch.nodes[id]; if (!t) return;
    // Set autoMode to 1 momentarily if it isn't, then trigger via a
    // queue1 path — the catalyst uses scene1..4 buttons via patch.nodes
    // already. Simplest: just cycle scene1 then back to current.
    // We expose direct scene jumps below — manualNudge advances scene.
    const cur = scene;
    fireScene((cur + 1) % 4);
  }

  function fireScene(target: number) {
    // The catalyst polls its `queue1_cv..queue4_cv` inputs for rising
    // edges. We can fake one from the UI by writing the scene index to a
    // patch-level marker — but the cleanest pure-card path is to call
    // engine `setParam` with a sentinel. For v1 we just write the target
    // scene to a special params key and let the catalyst read it.
    const t = patch.nodes[id]; if (!t) return;
    t.params.uiSceneJump = target + 1; // 1-indexed marker the catalyst polls
    // Also fire a one-shot timer to clear it so a second click re-fires.
    setTimeout(() => {
      const tt = patch.nodes[id]; if (tt && tt.params.uiSceneJump === target + 1) tt.params.uiSceneJump = 0;
    }, 100);
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
  <header class="title">CATALYST</header>

  <PatchPanel nodeId={id} {inputs} {outputs} panelWidth={320}>
    <div class="body">
      <div class="top">
        <button
          class="nudge-btn"
          onclick={manualNudge}
          title="Manually advance to the next scene"
          data-testid="catalyst-nudge"
        >NUDGE</button>
        <div class="scenes">
          {#each [0, 1, 2, 3] as i (i)}
            <button
              class="scene"
              class:active={scene === i}
              onclick={() => fireScene(i)}
              data-testid={`catalyst-scene-${i + 1}`}
            >{i + 1}</button>
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
      </div>

      <div class="grid">
        <Fader value={paramVal('driftRate')}  min={0} max={1} defaultValue={defaultFor('driftRate')}  label="Drift"  curve="log"    onchange={set('driftRate')}  readLive={live('driftRate')} />
        <Fader value={paramVal('chaos')}      min={0} max={1} defaultValue={defaultFor('chaos')}      label="Chaos"  curve="linear" onchange={set('chaos')}      readLive={live('chaos')} />
        <Fader value={paramVal('coherence')}  min={0} max={1} defaultValue={defaultFor('coherence')}  label="Coh"    curve="linear" onchange={set('coherence')}  readLive={live('coherence')} />
        <Fader value={paramVal('sceneDepth')} min={0} max={1} defaultValue={defaultFor('sceneDepth')} label="Depth"  curve="linear" onchange={set('sceneDepth')} readLive={live('sceneDepth')} />
        <Fader value={paramVal('bias')}       min={-1} max={1} defaultValue={defaultFor('bias')}      label="Bias"   curve="linear" onchange={set('bias')}       readLive={live('bias')} />
        <Fader value={paramVal('level')}      min={0} max={1} defaultValue={defaultFor('level')}      label="Lvl"    curve="linear" onchange={set('level')}      readLive={live('level')} />
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .mod-card {
    width: 360px;
    min-height: 320px;
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
  .grid {
    margin-top: 12px;
    display: grid;
    grid-template-columns: repeat(6, 1fr);
    gap: 6px;
    justify-items: center;
  }
</style>

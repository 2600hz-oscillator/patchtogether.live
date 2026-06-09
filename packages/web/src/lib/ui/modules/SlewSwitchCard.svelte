<script lang="ts">
  // SlewSwitchCard — quad slew limiter + 4→1 sequential CV switch.
  // PatchPanel-style port layout (mirrors AttenumixCard / IllogicCard).
  // 4 channel strips (each with a slew-time fader), plus mode/length/xfade
  // knobs in a small column below.

  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { setNodeParam } from '$lib/graph/mutate';
  import { slewSwitchDef } from '$lib/audio/modules/slewswitch';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  function defaultFor(k: string): number {
    return slewSwitchDef.params.find((p) => p.id === k)?.defaultValue ?? 0;
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

  const inputs: PortDescriptor[] = [
    { id: 'in1',        label: 'IN 1',   cable: 'cv' },
    { id: 'in2',        label: 'IN 2',   cable: 'cv' },
    { id: 'in3',        label: 'IN 3',   cable: 'cv' },
    { id: 'in4',        label: 'IN 4',   cable: 'cv' },
    { id: 'step_clock', label: 'CLK',    cable: 'gate' },
    { id: 'reset',      label: 'RST',    cable: 'gate' },
    { id: 'slew1_cv',   label: 'S1 CV',  cable: 'cv' },
    { id: 'slew2_cv',   label: 'S2 CV',  cable: 'cv' },
    { id: 'slew3_cv',   label: 'S3 CV',  cable: 'cv' },
    { id: 'slew4_cv',   label: 'S4 CV',  cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'out1',     label: 'OUT 1',    cable: 'cv' },
    { id: 'out2',     label: 'OUT 2',    cable: 'cv' },
    { id: 'out3',     label: 'OUT 3',    cable: 'cv' },
    { id: 'out4',     label: 'OUT 4',    cable: 'cv' },
    { id: 'switched', label: 'SW',       cable: 'cv' },
    { id: 'step_idx', label: 'IDX',      cable: 'cv' },
    { id: 'eoc',      label: 'EOC',      cable: 'gate' },
  ];

  const channels = [1, 2, 3, 4] as const;
  const modeLabels = ['→ FWD', '⇄ PND', '? RND'] as const;
  function cycleMode() {
    const t = patch.nodes[id]; if (!t) return;
    const cur = (t.params.mode ?? 0) | 0;
    t.params.mode = (cur + 1) % 3;
  }
  let modeLabel = $derived(modeLabels[((paramVal('mode') | 0) % 3)]);
  function cycleLength() {
    const t = patch.nodes[id]; if (!t) return;
    const cur = Math.max(1, Math.min(4, (t.params.length ?? 4) | 0));
    t.params.length = cur >= 4 ? 1 : cur + 1;
  }
  let lenLabel = $derived(`LEN ${Math.max(1, Math.min(4, paramVal('length') | 0))}`);
</script>

<div class="mod-card slewswitch-card">
  <div class="stripe" style="background: var(--cable-cv);"></div>
  <ModuleTitle {id} {data} defaultLabel="SLEWSWITCH" />

  <PatchPanel nodeId={id} {inputs} {outputs} panelWidth={300}>
    <div class="body">
      <div class="strips">
        {#each channels as ch (ch)}
          <div class="strip">
            <Fader
              value={paramVal(`slew${ch}`)}
              min={0.001} max={5} defaultValue={defaultFor(`slew${ch}`)}
              label={`Slew ${ch}`}
              curve="log"
              onchange={set(`slew${ch}`)} moduleId={id} paramId={`slew${ch}`}
              readLive={live(`slew${ch}`)}
            />
          </div>
        {/each}
      </div>
      <div class="controls">
        <button class="modebtn" onclick={cycleMode} data-testid="slewswitch-mode">{modeLabel}</button>
        <button class="modebtn" onclick={cycleLength} data-testid="slewswitch-length">{lenLabel}</button>
        <div class="xfade">
          <Fader
            value={paramVal('xfadeTime')}
            min={0.001} max={2} defaultValue={defaultFor('xfadeTime')}
            label="Xfd"
            curve="log"
            onchange={set('xfadeTime')} moduleId={id} paramId="xfadeTime"
            readLive={live('xfadeTime')}
          />
        </div>
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .mod-card {
    width: 320px;
    background: var(--module-bg);
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text);
    padding-top: 18px;
    padding-bottom: 14px;
    position: relative;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  :global(.svelte-flow__node:hover) .mod-card { border-color: var(--accent-dim); }
  :global(.svelte-flow__node.selected) .mod-card {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .stripe { position: absolute; top: 0; left: 0; right: 0; height: 2px; border-radius: 2px 2px 0 0; }
  .title { font-size: 0.85rem; font-weight: 500; text-align: center; margin: 0 0 8px; letter-spacing: 0.05em; }
  .body { padding: 4px 10px 10px; }
  .strips {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 6px;
    justify-items: center;
  }
  .controls {
    margin-top: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
  }
  .modebtn {
    background: var(--module-bg);
    color: var(--text-dim);
    border: 1px solid var(--border);
    border-radius: 3px;
    font-size: 0.65rem;
    letter-spacing: 0.08em;
    padding: 5px 10px;
    cursor: pointer;
    font-family: ui-monospace, monospace;
  }
  .modebtn:hover { border-color: var(--accent-dim); color: var(--text); }
  .xfade { width: 60px; }
</style>

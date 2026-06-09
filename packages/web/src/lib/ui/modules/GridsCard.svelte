<script lang="ts">
  // GridsCard — topographic drum pattern generator (Mutable Instruments Grids
  // port). Knobs for tempo / MAP-X / MAP-Y / per-channel density / chaos /
  // swing, a DRUMS|EUCLIDEAN mode toggle, and a RUN button. BD/SD/HH + accent
  // + clock gate outs; CV ins for every modulation target.
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import OssAttribution from '$lib/ui/modules/OssAttribution.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { setNodeParam } from '$lib/graph/mutate';
  import { gridsDef } from '$lib/audio/modules/grids';
  import { GRIDS_MODE_DRUMS } from '$lib/audio/modules/grids-engine';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  const def = (pid: string) => gridsDef.params.find((p) => p.id === pid)!;
  const defaultFor = (pid: string): number => def(pid).defaultValue;

  let mode = $derived(node?.params.mode ?? defaultFor('mode'));
  let isPlaying = $derived((node?.params.isPlaying ?? defaultFor('isPlaying')) >= 0.5);
  let modeLabel = $derived(Math.round(mode) === GRIDS_MODE_DRUMS ? 'DRUMS' : 'EUCLID');

  const set = (pid: string) => (v: number) => setNodeParam(id, pid, v);
  const live = (pid: string) => () => {
    const e = engineCtx.get(); if (!e || !node) return undefined;
    return e.readParam(node, pid);
  };

  function val(pid: string): number {
    return node?.params[pid] ?? defaultFor(pid);
  }
  function toggleMode(): void {
    const t = patch.nodes[id];
    if (t) t.params.mode = Math.round(mode) === GRIDS_MODE_DRUMS ? 0 : GRIDS_MODE_DRUMS;
  }
  function toggleRun(): void {
    const t = patch.nodes[id];
    if (t) t.params.isPlaying = isPlaying ? 0 : 1;
  }

  function fader(pid: string, label: string) {
    return { pid, label };
  }
  const densityFaders = [
    fader('bdDensity', 'BD'),
    fader('sdDensity', 'SD'),
    fader('hhDensity', 'HH'),
  ];

  const inputs: PortDescriptor[] = [
    { id: 'clock',        cable: 'gate' },
    { id: 'reset',        cable: 'gate' },
    { id: 'mapX_cv',      cable: 'cv' },
    { id: 'mapY_cv',      cable: 'cv' },
    { id: 'bdDensity_cv', cable: 'cv' },
    { id: 'sdDensity_cv', cable: 'cv' },
    { id: 'hhDensity_cv', cable: 'cv' },
    { id: 'chaos_cv',     cable: 'cv' },
    { id: 'swing_cv',     cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'bd',     cable: 'gate' },
    { id: 'sd',     cable: 'gate' },
    { id: 'hh',     cable: 'gate' },
    { id: 'accent', cable: 'gate' },
    { id: 'clock',  cable: 'gate' },
  ];
</script>

<div class="mod-card grids-card">
  <div class="stripe" style="background: var(--cable-gate);"></div>
  <ModuleTitle {id} {data} defaultLabel="GRIDS" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="controls">
      <div class="btn-row">
        <button type="button" class="mode-btn" data-testid="grids-mode" onclick={toggleMode}>{modeLabel}</button>
        <button
          type="button"
          class="run-btn"
          class:active={isPlaying}
          data-testid="grids-run"
          onclick={toggleRun}
        >{isPlaying ? 'RUN' : 'STOP'}</button>
      </div>

      <div class="fader-row">
        <Fader value={val('tempo')} min={def('tempo').min!} max={def('tempo').max!}
               defaultValue={defaultFor('tempo')} label="BPM" curve="linear"
               onchange={set('tempo')} moduleId={id} paramId="tempo" readLive={live('tempo')} />
        <Fader value={val('mapX')} min={def('mapX').min!} max={def('mapX').max!}
               defaultValue={defaultFor('mapX')} label="X" curve="linear"
               onchange={set('mapX')} moduleId={id} paramId="mapX" readLive={live('mapX')} />
        <Fader value={val('mapY')} min={def('mapY').min!} max={def('mapY').max!}
               defaultValue={defaultFor('mapY')} label="Y" curve="linear"
               onchange={set('mapY')} moduleId={id} paramId="mapY" readLive={live('mapY')} />
      </div>

      <div class="fader-row">
        {#each densityFaders as f (f.pid)}
          <Fader value={val(f.pid)} min={def(f.pid).min!} max={def(f.pid).max!}
                 defaultValue={defaultFor(f.pid)} label={f.label} curve="linear"
                 onchange={set(f.pid)} moduleId={id} paramId={f.pid} readLive={live(f.pid)} />
        {/each}
      </div>

      <div class="fader-row">
        <Fader value={val('chaos')} min={def('chaos').min!} max={def('chaos').max!}
               defaultValue={defaultFor('chaos')} label="Chaos" curve="linear"
               onchange={set('chaos')} moduleId={id} paramId="chaos" readLive={live('chaos')} />
        <Fader value={val('swing')} min={def('swing').min!} max={def('swing').max!}
               defaultValue={defaultFor('swing')} label="Swing" curve="linear"
               onchange={set('swing')} moduleId={id} paramId="swing" readLive={live('swing')} />
      </div>
    </div>
  </PatchPanel>
  <OssAttribution author={gridsDef.ossAttribution?.author} />
</div>

<style>
  .grids-card { width: 320px; }
  .grids-card .title {
    font-family: var(--font-display, inherit);
    font-size: 0.85rem;
    letter-spacing: 0.04em;
  }
  .grids-card .controls {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 0 16px;
    margin-top: 10px;
  }
  .grids-card .btn-row {
    display: flex;
    gap: 8px;
  }
  .grids-card .mode-btn,
  .grids-card .run-btn {
    flex: 1 1 0;
    border: 1px solid var(--border, #555);
    background: var(--bg-elevated, #1a1a1a);
    color: var(--text, #eee);
    padding: 4px 8px;
    font-family: var(--font-display, monospace);
    font-size: 0.7rem;
    letter-spacing: 0.06em;
    cursor: pointer;
  }
  .grids-card .mode-btn:hover,
  .grids-card .run-btn:hover {
    background: var(--bg-hover, #2a2a2a);
  }
  .grids-card .run-btn.active {
    border-color: var(--cable-gate, #4caf50);
    color: var(--cable-gate, #4caf50);
  }
  .grids-card .fader-row {
    display: flex;
    justify-content: space-around;
    gap: 8px;
  }
</style>

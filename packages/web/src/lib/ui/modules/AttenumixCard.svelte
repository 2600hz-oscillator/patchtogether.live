<script lang="ts">
  // AttenumixCard — the simple mixer. 4 channel strips, each with an
  // attenuator fader; a single MASTER fader at the right. Audio + CV
  // inputs and per-channel direct outs live on the PatchPanel; the MIX
  // output is the last port at the bottom of the outputs column.
  //
  // PatchPanel pattern (a quad-channel fader layout stripped of the
  // response toggle — ATTENUMIX is the no-extra-controls mixer).
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { setNodeParam } from '$lib/graph/mutate';
  import { attenumixDef } from '$lib/audio/modules/attenumix';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  function defaultFor(k: string): number {
    return attenumixDef.params.find((p) => p.id === k)?.defaultValue ?? 0;
  }
  function paramVal(k: string, fallback?: number): number {
    const v = node?.params?.[k];
    if (typeof v === 'number') return v;
    return fallback ?? defaultFor(k);
  }
  const set = (k: string) => (v: number) => {
    setNodeParam(id, k, v);
  };
  const live = (k: string) => () => {
    const e = engineCtx.get(); if (!e || !node) return undefined;
    return e.readParam(node, k);
  };

  // Ports — generated channel-by-channel so source order reads L→R per
  // channel (in1, cv1, out1, …). PatchPanel groups by cable type for
  // display, so this explicit ordering is just for readability here.
  const inputs: PortDescriptor[] = [
    { id: 'in1', label: 'IN 1', cable: 'audio' },
    { id: 'in2', label: 'IN 2', cable: 'audio' },
    { id: 'in3', label: 'IN 3', cable: 'audio' },
    { id: 'in4', label: 'IN 4', cable: 'audio' },
    { id: 'cv1', label: 'CV 1', cable: 'cv' },
    { id: 'cv2', label: 'CV 2', cable: 'cv' },
    { id: 'cv3', label: 'CV 3', cable: 'cv' },
    { id: 'cv4', label: 'CV 4', cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'out1', label: 'OUT 1', cable: 'audio' },
    { id: 'out2', label: 'OUT 2', cable: 'audio' },
    { id: 'out3', label: 'OUT 3', cable: 'audio' },
    { id: 'out4', label: 'OUT 4', cable: 'audio' },
    { id: 'mix',  label: 'MIX',   cable: 'audio' },
  ];

  const channels = [1, 2, 3, 4] as const;
</script>

<div class="mod-card attenumix-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <ModuleTitle {id} {data} defaultLabel="ATTENUMIX" />

  <PatchPanel nodeId={id} {inputs} {outputs} panelWidth={300}>
    <div class="body">
      <div class="strips">
        {#each channels as ch (ch)}
          <div class="strip">
            <Fader
              value={paramVal(`att${ch}`, 0)}
              min={0} max={1} defaultValue={defaultFor(`att${ch}`)}
              label={`Att ${ch}`}
              curve="linear"
              onchange={set(`att${ch}`)} moduleId={id} paramId={`att${ch}`}
              readLive={live(`att${ch}`)}
            />
          </div>
        {/each}
        <div class="strip master">
          <Fader
            value={paramVal('master', 1.0)}
            min={0} max={2} defaultValue={defaultFor('master')}
            label="Master"
            curve="linear"
            onchange={set('master')} moduleId={id} paramId="master"
            readLive={live('master')}
          />
        </div>
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .attenumix-card { width: 300px; }
  .attenumix-card .body { padding: 12px 14px 0; }
  .attenumix-card .strips {
    display: flex;
    gap: 8px;
    justify-content: space-between;
    align-items: flex-start;
  }
  .attenumix-card .strip {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
  }
  /* Visually offset the master strip — a subtle divider so users see at
     a glance which fader is per-channel vs. global. */
  .attenumix-card .strip.master {
    padding-left: 8px;
    margin-left: 4px;
    border-left: 1px solid var(--border-dim, #333);
  }
</style>

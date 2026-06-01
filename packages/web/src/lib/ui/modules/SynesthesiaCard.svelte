<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import type { SynesthesiaSnapshot } from '$lib/audio/modules/synesthesia';
  import { drawVuMeters } from '$lib/audio/modules/synesthesia-draw';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  function param(id_: string, fallback: number): number {
    const v = node?.params?.[id_];
    return typeof v === 'number' ? v : fallback;
  }
  const set = (id_: string) => (v: number) => {
    const t = patch.nodes[id];
    if (t) t.params[id_] = v;
  };
  const live = (id_: string) => () => {
    const e = engineCtx.get();
    if (!e || !node) return undefined;
    return e.readParam(node, id_);
  };

  const BANDS = [1, 2, 3, 4] as const;
  const BAND_LABELS = ['0–200', '200–500', '500–2k', '2k+'] as const;

  function copyPorts(c: 'a' | 'b'): { inputs: PortDescriptor[]; outputs: PortDescriptor[] } {
    return {
      inputs: [{ id: `${c}_in`, label: `${c.toUpperCase()} IN`, cable: 'audio' }],
      outputs: BANDS.flatMap((b, i) => [
        { id: `${c}_band${b}_audio`,    label: `B${b} ${BAND_LABELS[i]} OUT`, cable: 'audio' as const },
        { id: `${c}_band${b}_env_slow`, label: `B${b} SLOW ENV`,             cable: 'cv' as const },
        { id: `${c}_band${b}_env_fast`, label: `B${b} FAST ENV`,             cable: 'cv' as const },
        { id: `${c}_band${b}_gate`,     label: `B${b} GATE`,                 cable: 'gate' as const },
        { id: `${c}_band${b}_raster`,   label: `B${b} RASTER`,               cable: 'mono-video' as const },
      ]),
    };
  }
  const portsA = copyPorts('a');
  const portsB = copyPorts('b');
  const sections = [
    { label: 'Copy A', inputs: portsA.inputs, outputs: portsA.outputs },
    { label: 'Copy B', inputs: portsB.inputs, outputs: portsB.outputs },
  ];

  // ---- VU meters (one canvas per copy, each drawing 4 band columns) ----
  let canvasA: HTMLCanvasElement | null = $state(null);
  let canvasB: HTMLCanvasElement | null = $state(null);
  let raf: number | null = null;

  $effect(() => {
    if (!canvasA && !canvasB) return;
    function tick(): void {
      const eng = engineCtx.get();
      if (eng && node) {
        const snap = eng.read(node, 'snapshot') as SynesthesiaSnapshot | undefined;
        if (snap) {
          const ca = canvasA?.getContext('2d');
          if (ca && canvasA) drawVuMeters(ca, snap.levelsA, canvasA.width, canvasA.height);
          const cb = canvasB?.getContext('2d');
          if (cb && canvasB) drawVuMeters(cb, snap.levelsB, canvasB.width, canvasB.height);
        }
      }
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => {
      if (raf !== null) cancelAnimationFrame(raf);
      raf = null;
    };
  });

  onDestroy(() => {
    if (raf !== null) cancelAnimationFrame(raf);
  });
</script>

<div class="mod-card syn-card" data-testid="synesthesia-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <ModuleTitle {id} {data} defaultLabel="SYNESTHESIA" />

  <PatchPanel nodeId={id} groupingStrategy="sectioned" {sections} panelWidth={560}>
    <!-- Copy A -->
    <div class="copy">
      <div class="master">
        <Knob value={param('a_master', 1)} min={0.5} max={1.5} defaultValue={1} label="A MAS"
          curve="linear" onchange={set('a_master')} moduleId={id} paramId="a_master" readLive={live('a_master')} />
      </div>
      <div class="bands">
        <canvas bind:this={canvasA} width="208" height="96" data-testid="synesthesia-vu-a"></canvas>
        <div class="gain-row">
          {#each BANDS as b, i (b)}
            <div class="gcol">
              <Knob value={param(`a_gain${b}`, 1)} min={1} max={2} defaultValue={1} label={`B${b}`}
                curve="linear" onchange={set(`a_gain${b}`)} moduleId={id} paramId={`a_gain${b}`} readLive={live(`a_gain${b}`)} />
              <div class="band-label">{BAND_LABELS[i]}</div>
            </div>
          {/each}
        </div>
      </div>
    </div>

    <!-- Copy B -->
    <div class="copy">
      <div class="master">
        <Knob value={param('b_master', 1)} min={0.5} max={1.5} defaultValue={1} label="B MAS"
          curve="linear" onchange={set('b_master')} moduleId={id} paramId="b_master" readLive={live('b_master')} />
      </div>
      <div class="bands">
        <canvas bind:this={canvasB} width="208" height="96" data-testid="synesthesia-vu-b"></canvas>
        <div class="gain-row">
          {#each BANDS as b, i (b)}
            <div class="gcol">
              <Knob value={param(`b_gain${b}`, 1)} min={1} max={2} defaultValue={1} label={`B${b}`}
                curve="linear" onchange={set(`b_gain${b}`)} moduleId={id} paramId={`b_gain${b}`} readLive={live(`b_gain${b}`)} />
              <div class="band-label">{BAND_LABELS[i]}</div>
            </div>
          {/each}
        </div>
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .syn-card {
    width: 460px;
    min-height: 360px;
  }
  .copy {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    padding: 10px 16px;
  }
  .copy + .copy {
    border-top: 1px solid var(--border);
  }
  .master {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding-top: 4px;
  }
  .bands {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .bands canvas {
    display: block;
    width: 208px;
    height: 96px;
    border: 1px solid var(--border);
    border-radius: 3px;
    background: #0c0e12;
  }
  .gain-row {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 6px;
    width: 208px;
  }
  .gcol {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
  }
  .band-label {
    font-size: 0.5rem;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
    letter-spacing: 0.01em;
  }
</style>

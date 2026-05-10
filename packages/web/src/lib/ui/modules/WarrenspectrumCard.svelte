<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { drawWarrenspectrum, type WarrenspectrumSnapshot } from '$lib/audio/modules/warrenspectrum-draw';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';

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

  const BANDS = [1, 2, 3, 4, 5, 6, 7, 8] as const;
  const BAND_LABELS = ['80', '160', '320', '640', '1.3k', '2.6k', '5.1k', '10k'] as const;

  // PatchPanel sections: stereo audio + per-band CV + ping group + viznoise.
  // Grouped so the patch panel doesn't overflow; users will most often
  // hit pings + levels per band, so we section by band.
  const audioInputs: PortDescriptor[] = [
    { id: 'in_l', label: 'IN L', cable: 'audio' },
    { id: 'in_r', label: 'IN R', cable: 'audio' },
  ];
  const audioOutputs: PortDescriptor[] = [
    { id: 'out_l',   label: 'OUT L', cable: 'audio' },
    { id: 'out_r',   label: 'OUT R', cable: 'audio' },
    { id: 'viz_out', label: 'VIZ',   cable: 'mono-video' },
  ];
  const cvInputs: PortDescriptor[] = BANDS.flatMap((b, i) => [
    { id: `level${b}_cv`, label: `B${b} (${BAND_LABELS[i]}) LEVEL CV`, cable: 'cv' as const },
    { id: `ping${b}`,     label: `B${b} (${BAND_LABELS[i]}) PING`,     cable: 'gate' as const },
  ]);
  const vizInput: PortDescriptor[] = [
    { id: 'viznoise_cv', label: 'HUE CV', cable: 'cv' },
  ];

  const sections = [
    { label: 'Audio', inputs: audioInputs, outputs: audioOutputs },
    { label: 'Bands', inputs: cvInputs },
    { label: 'Viz',   inputs: vizInput },
  ];

  // ---- On-card visualization ----
  let canvasEl: HTMLCanvasElement | null = $state(null);
  let raf: number | null = null;

  $effect(() => {
    if (!canvasEl) return;
    function tick() {
      const eng = engineCtx.get();
      if (eng && node && canvasEl) {
        const snap = eng.read(node, 'snapshot') as WarrenspectrumSnapshot | undefined;
        if (snap) {
          const ctx2d = canvasEl.getContext('2d');
          if (ctx2d) drawWarrenspectrum(ctx2d, snap, canvasEl.width, canvasEl.height);
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

<div class="mod-card warren-card" data-testid="warrenspectrum-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <header class="title">WARRENSPECTRUM</header>

  <PatchPanel nodeId={id} groupingStrategy="sectioned" {sections} panelWidth={520}>
    <div class="viz-wrap">
      <canvas bind:this={canvasEl} width="360" height="120" data-testid="warrenspectrum-viz"></canvas>
    </div>

    <div class="band-row">
      {#each BANDS as b, i (b)}
        <div class="band-col">
          <Fader
            value={param(`level${b}`, 1.0)}
            min={0} max={2} defaultValue={1.0}
            label={`B${b}`}
            curve="linear"
            onchange={set(`level${b}`)}
            readLive={live(`level${b}`)}
          />
          <div class="band-label">{BAND_LABELS[i]}</div>
        </div>
      {/each}
    </div>

    <div class="side-knobs">
      <Knob value={param('master', 1.0)}     min={0} max={2} defaultValue={1.0} label="Mas"  curve="linear" onchange={set('master')}     readLive={live('master')} />
      <Knob value={param('ping_decay', 0.5)} min={0} max={1} defaultValue={0.5} label="Dcy"  curve="linear" onchange={set('ping_decay')} readLive={live('ping_decay')} />
      <Knob value={param('viznoise', 0.3)}   min={0} max={1} defaultValue={0.3} label="Hue"  curve="linear" onchange={set('viznoise')}   readLive={live('viznoise')} />
    </div>
  </PatchPanel>
</div>

<style>
  .warren-card {
    width: 440px;
    min-height: 320px;
  }
  .viz-wrap {
    margin: 14px 18px 8px;
    border: 1px solid var(--border);
    border-radius: 3px;
    overflow: hidden;
    line-height: 0;
  }
  .viz-wrap canvas {
    display: block;
    width: 100%;
    height: auto;
  }
  .band-row {
    display: grid;
    grid-template-columns: repeat(8, 1fr);
    gap: 4px;
    padding: 0 14px;
    margin-top: 8px;
  }
  .band-col {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
  }
  .band-label {
    font-size: 0.55rem;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
    letter-spacing: 0.02em;
  }
  .side-knobs {
    margin-top: 12px;
    display: flex;
    justify-content: center;
    gap: 16px;
  }
</style>

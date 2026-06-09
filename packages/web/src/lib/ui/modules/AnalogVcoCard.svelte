<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { setNodeParam } from '$lib/graph/mutate';
  import { analogVcoDef, type VcoWaveformSnapshot } from '$lib/audio/modules/analog-vco';
  import { drawVcoCycle } from '$lib/audio/modules/analog-vco-scope';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  const engineCtx = useEngine();

  let tune     = $derived(node?.params.tune     ?? analogVcoDef.params.find((p) => p.id === 'tune')!.defaultValue);
  let fine     = $derived(node?.params.fine     ?? analogVcoDef.params.find((p) => p.id === 'fine')!.defaultValue);
  let fmAmount = $derived(node?.params.fmAmount ?? analogVcoDef.params.find((p) => p.id === 'fmAmount')!.defaultValue);
  let pmAmount = $derived(node?.params.pmAmount ?? analogVcoDef.params.find((p) => p.id === 'pmAmount')!.defaultValue);
  let pw       = $derived(node?.params.pw       ?? analogVcoDef.params.find((p) => p.id === 'pw')!.defaultValue);
  let shape    = $derived(node?.params.shape    ?? analogVcoDef.params.find((p) => p.id === 'shape')!.defaultValue);

  function setParam(paramId: string) {
    return (v: number) => setNodeParam(id, paramId, v);
  }
  function readLive(paramId: string) {
    return () => {
      const eng = engineCtx.get();
      if (!eng || !node) return undefined;
      return eng.readParam(node, paramId);
    };
  }

  // ── Live single-cycle waveform scope (top of the card) ──
  // Reads the engine handle's read('waveform') snapshot — a time-domain
  // buffer off an AnalyserNode tapped on the MORPH output — and draws exactly
  // one period on rAF, so the trace tracks the live `shape` morph AND any
  // FM / pitch / PM modulation.
  let canvasEl: HTMLCanvasElement | null = $state(null);
  let raf: number | null = null;
  let traceColor = $state('#fbbf24');
  let axisColor = $state('rgba(255,255,255,0.12)');
  let bgColor = $state('#0d1014');

  onMount(() => {
    const cs = getComputedStyle(document.documentElement);
    traceColor = cs.getPropertyValue('--cable-audio').trim() || traceColor;
  });

  $effect(() => {
    if (!canvasEl) return;
    function tick() {
      const eng = engineCtx.get();
      if (eng && node && canvasEl) {
        const snap = eng.read(node, 'waveform') as VcoWaveformSnapshot | undefined;
        const ctx2d = canvasEl.getContext('2d');
        if (snap && ctx2d) {
          drawVcoCycle(
            ctx2d,
            snap.data,
            snap.sampleRate,
            snap.freqHz,
            canvasEl.width,
            canvasEl.height,
            { trace: traceColor, axis: axisColor, bg: bgColor },
          );
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

  const inputs: PortDescriptor[] = [
    { id: 'pitch',    cable: 'pitch' },
    { id: 'fm',       cable: 'audio' },
    { id: 'pm',       cable: 'audio' },
    { id: 'sync',     label: 'SYNC',   cable: 'audio' },
    { id: 'tune',     cable: 'cv' },
    { id: 'fine',     cable: 'cv' },
    { id: 'fmAmount', label: 'FM AMT', cable: 'cv' },
    { id: 'pmAmount', label: 'PM AMT', cable: 'cv' },
    { id: 'shape',    label: 'WAVE',   cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'saw',      cable: 'audio' },
    { id: 'square',   cable: 'audio' },
    { id: 'triangle', cable: 'audio' },
    { id: 'sine',     cable: 'audio' },
    { id: 'morph',    cable: 'audio' },
    { id: 'sync',     label: 'SYNC',   cable: 'audio' },
  ];
</script>

<div class="card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <ModuleTitle {id} {data} defaultLabel="Analog VCO" />

  <!-- Live single-cycle waveform of the MORPH output. Reflects the shape
       knob/CV plus any FM / pitch / PM modulation in real time. -->
  <div class="scope-wrap">
    <canvas
      bind:this={canvasEl}
      width="200"
      height="56"
      data-testid="analog-vco-scope"
    ></canvas>
  </div>

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="fader-row">
      <Fader value={tune}     min={-36} max={36}     defaultValue={0}   label="Tune" units="st" curve="linear" onchange={setParam('tune')} moduleId={id} paramId="tune"     readLive={readLive('tune')} />
      <Fader value={fine}     min={-100} max={100}   defaultValue={0}   label="Fine" units="¢"  curve="linear" onchange={setParam('fine')} moduleId={id} paramId="fine"     readLive={readLive('fine')} />
      <Fader value={fmAmount} min={0}   max={1}      defaultValue={0}   label="FM"              curve="linear" onchange={setParam('fmAmount')} moduleId={id} paramId="fmAmount" readLive={readLive('fmAmount')} />
      <Fader value={pmAmount} min={0}   max={1}      defaultValue={0}   label="PM"              curve="linear" onchange={setParam('pmAmount')} moduleId={id} paramId="pmAmount" readLive={readLive('pmAmount')} />
      <Fader value={pw}       min={0.05} max={0.95}  defaultValue={0.5} label="PW"              curve="linear" onchange={setParam('pw')} moduleId={id} paramId="pw"       readLive={readLive('pw')} />
      <Fader value={shape}    min={0}   max={1}      defaultValue={0}   label="Wave"            curve="linear" onchange={setParam('shape')} moduleId={id} paramId="shape"    readLive={readLive('shape')} />
    </div>
  </PatchPanel>
</div>

<style>
  .card {
    width: 240px;
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
  :global(.svelte-flow__node:hover) .card {
    border-color: var(--accent-dim);
  }
  :global(.svelte-flow__node.selected) .card {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .stripe {
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    border-radius: 2px 2px 0 0;
  }
  .title {
    font-size: 0.85rem;
    font-weight: 500;
    text-align: center;
    margin: 0 0 8px;
    letter-spacing: 0.02em;
  }
  .scope-wrap {
    margin: 10px 18px 0;
    border: 1px solid var(--border);
    border-radius: 3px;
    overflow: hidden;
    line-height: 0;
    background: #0d1014;
  }
  .scope-wrap canvas {
    display: block;
    width: 100%;
    height: 56px;
  }
  .fader-row {
    margin-top: 12px;
    display: flex;
    gap: 6px;
    padding: 0 18px;
    justify-content: space-between;
  }
</style>

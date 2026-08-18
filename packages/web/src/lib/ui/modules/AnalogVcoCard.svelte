<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import type { NodeProps } from '@xyflow/svelte';
  import NeonFader from '$lib/ui/controls/NeonFader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { setNodeParam } from '$lib/graph/mutate';
  import { analogVcoDef, type VcoWaveformSnapshot } from '$lib/audio/modules/analog-vco';
  import { drawVcoCycle } from '$lib/audio/modules/analog-vco-scope';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { paramSpec, portsFromDef } from './card-kit';

  // ⚠ FM / PM ARE BIPOLAR IN THE DEF AND THIS CARD SAID THEY WERE NOT.
  // `fmAmount` / `pmAmount` are declared `min: -1, max: 1` (inverted modulation
  // is half the point of a linear-FM index), and their `cv` jacks have always
  // driven the full ±1. The card re-typed `min={0}`, so the knob could only
  // reach the positive half while the DEF-DRIVEN dock face reached both — one
  // param, two ranges, depending on which surface you were looking at.
  //
  // Binding only THOSE TWO left the other four re-typed, agreeing with the def
  // by coincidence — which is the same latent defect, one edit away, and is what
  // `dead-control-fixes.test.ts` reddens on. So EVERY fader spreads its range
  // from the def and the card states no bound of its own.
  //
  // Deliberately narrow: `min` / `max` / `defaultValue` only. `label`, `units`
  // and `curve` stay authored in the markup because the card's display strings
  // differ from the def's canonical `units` on purpose (`st` vs `semi`, `¢` vs
  // `cent`) — spreading those would be a RENDER change smuggled into a
  // single-source-of-truth refactor. Verified value-identical to the six
  // ParamDefs at the time of the change, so nothing about this card moves.
  const spec = (pid: string) => {
    const p = paramSpec(analogVcoDef, pid);
    return { min: p.min, max: p.max, defaultValue: p.defaultValue };
  };

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

  const inputs = portsFromDef(analogVcoDef.inputs, {
    fmAmount: 'FM AMT', pmAmount: 'PM AMT', shape: 'WAVE',
  });
  const outputs = portsFromDef(analogVcoDef.outputs);
</script>

<div class="vcard card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <ModuleTitle {id} {data} defaultLabel="Analog VCO" />

  <!-- Live single-cycle waveform of the MORPH output. Reflects the shape
       knob/CV plus any FM / pitch / PM modulation in real time. -->
  <div class="scope-wrap">
    <canvas
      bind:this={canvasEl}
      width="200"
      height="168"
      data-testid="analog-vco-scope"
    ></canvas>
  </div>

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="fader-row">
      <NeonFader value={tune}     {...spec('tune')}     label="Tune" units="st" curve="linear" onchange={setParam('tune')} moduleId={id} paramId="tune"     readLive={readLive('tune')} />
      <NeonFader value={fine}     {...spec('fine')}     label="Fine" units="¢"  curve="linear" onchange={setParam('fine')} moduleId={id} paramId="fine"     readLive={readLive('fine')} />
      <NeonFader value={fmAmount} {...spec('fmAmount')} label="FM"              curve="linear" onchange={setParam('fmAmount')} moduleId={id} paramId="fmAmount" readLive={readLive('fmAmount')} />
      <NeonFader value={pmAmount} {...spec('pmAmount')} label="PM"              curve="linear" onchange={setParam('pmAmount')} moduleId={id} paramId="pmAmount" readLive={readLive('pmAmount')} />
      <NeonFader value={pw}       {...spec('pw')}       label="PW"              curve="linear" onchange={setParam('pw')} moduleId={id} paramId="pw"       readLive={readLive('pw')} />
      <NeonFader value={shape}    {...spec('shape')}    label="Wave"            curve="linear" onchange={setParam('shape')} moduleId={id} paramId="shape"    readLive={readLive('shape')} />
    </div>
  </PatchPanel>
</div>

<style>
  .card {
    width: 240px;
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
    height: 168px; /* 3× the old 56px — fills the 3u card's empty vertical space */
  }
  .fader-row {
    margin-top: 12px;
    display: flex;
    gap: 6px;
    padding: 0 18px;
    justify-content: space-between;
  }
</style>

<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { scopeDef, type ScopeSnapshot, type PitchResult } from '$lib/audio/modules/scope';
  import { drawScope } from '$lib/audio/modules/scope-draw';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';

  // Inputs: 2 audio channels + 1 CV per param. Port ids match SCOPE's
  // module def 1:1 (the io-spec consistency e2e test enforces this);
  // the CV bridge auto-routes via setParam(portId).
  const inputs: PortDescriptor[] = [
    { id: 'ch1', label: 'CHANNEL 1', cable: 'audio' },
    { id: 'ch2', label: 'CHANNEL 2', cable: 'audio' },
    { id: 'timeMs',    label: 'TIME (CV)',     cable: 'cv' },
    { id: 'ch1Scale',  label: 'CH1 SCALE (CV)',  cable: 'cv' },
    { id: 'ch1Offset', label: 'CH1 OFFSET (CV)', cable: 'cv' },
    // ch{1,2}Range and mode are discrete (0/1) but accepting CV is
    // useful: any signal ≥ 0.5 flips to the alt state. Stable Eurorack
    // gate convention.
    { id: 'ch1Range',  label: 'CH1 RANGE (CV)',  cable: 'cv' },
    { id: 'ch2Scale',  label: 'CH2 SCALE (CV)',  cable: 'cv' },
    { id: 'ch2Offset', label: 'CH2 OFFSET (CV)', cable: 'cv' },
    { id: 'ch2Range',  label: 'CH2 RANGE (CV)',  cable: 'cv' },
    { id: 'mode',      label: 'XY MODE (CV)',    cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'ch1_out', label: 'CHANNEL 1 OUT', cable: 'audio' },
    { id: 'ch2_out', label: 'CHANNEL 2 OUT', cable: 'audio' },
    { id: 'out', label: 'VIDEO OUT', cable: 'mono-video' },
  ];

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  // Scope params: read from the patch (single source of truth). The
  // engine's SCOPE handle keeps a parallel cache that drives the video-
  // bridge's drawFrame; that cache is updated both by the reconciler
  // (when the user moves a fader → patch.nodes[].params changes) and
  // by setParam from the cross-domain CV bridge (per-frame writes).
  // The card reads the patch directly so on-card and bridge renders
  // converge.
  let timeMs    = $derived(node?.params.timeMs    ?? scopeDef.params[0]!.defaultValue);
  let ch1Scale  = $derived(node?.params.ch1Scale  ?? scopeDef.params[1]!.defaultValue);
  let ch1Offset = $derived(node?.params.ch1Offset ?? scopeDef.params[2]!.defaultValue);
  let ch1Range  = $derived(node?.params.ch1Range  ?? scopeDef.params[3]!.defaultValue);
  let ch2Scale  = $derived(node?.params.ch2Scale  ?? scopeDef.params[4]!.defaultValue);
  let ch2Offset = $derived(node?.params.ch2Offset ?? scopeDef.params[5]!.defaultValue);
  let ch2Range  = $derived(node?.params.ch2Range  ?? scopeDef.params[6]!.defaultValue);
  let xyMode    = $derived((node?.params.mode ?? 0) >= 0.5);

  function setParam(paramId: string) {
    return (v: number) => {
      const target = patch.nodes[id];
      if (target) target.params[paramId] = v;
    };
  }
  function toggleXY() {
    const target = patch.nodes[id];
    if (target) target.params.mode = xyMode ? 0 : 1;
  }
  function toggleRange(channel: 1 | 2) {
    const target = patch.nodes[id];
    if (!target) return;
    const key = channel === 1 ? 'ch1Range' : 'ch2Range';
    target.params[key] = (target.params[key] ?? 0) >= 0.5 ? 0 : 1;
  }

  let canvasEl: HTMLCanvasElement | null = $state(null);
  let raf: number | null = null;

  // Pitch tuner readout — sampled at ~10 Hz (NOT rAF; frame-rate jitter would
  // make the Hz value flicker). When ch1 has no pitched signal, all three
  // fields read null and the UI shows em-dashes.
  let pitch: PitchResult = $state({ hz: null, note: null, cents: null, confidence: null });
  let pitchTimer: ReturnType<typeof setInterval> | null = null;

  // Resolve cable colors once at mount. $state so the draw() reads the
  // post-mount values (the existing warning called this out — making
  // these reactive both fixes the warning and ensures the on-card
  // canvas re-paints with the right colors on theme reload).
  let ch1Color = $state('#fbbf24');
  let ch2Color = $state('#60a5fa');
  onMount(() => {
    const cs = getComputedStyle(document.documentElement);
    ch1Color = cs.getPropertyValue('--cable-audio').trim() || ch1Color;
    ch2Color = cs.getPropertyValue('--cable-pitch').trim() || ch2Color;
  });

  $effect(() => {
    if (!canvasEl) return;
    function tick() {
      const eng = engineCtx.get();
      if (eng && node && canvasEl) {
        const snap = eng.read(node, 'snapshot') as ScopeSnapshot | undefined;
        if (snap) draw(canvasEl, snap);
      }
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => {
      if (raf !== null) cancelAnimationFrame(raf);
      raf = null;
    };
  });

  $effect(() => {
    pitchTimer = setInterval(() => {
      const eng = engineCtx.get();
      if (!eng || !node) return;
      const p = eng.read(node, 'pitch') as PitchResult | undefined;
      if (p) pitch = p;
    }, 100);
    return () => {
      if (pitchTimer !== null) clearInterval(pitchTimer);
      pitchTimer = null;
    };
  });

  onDestroy(() => {
    if (raf !== null) cancelAnimationFrame(raf);
    if (pitchTimer !== null) clearInterval(pitchTimer);
  });

  function fmtHz(hz: number | null): string {
    if (hz === null) return '—';
    return `${hz.toFixed(1)} Hz`;
  }
  // Tuning meter: cents → percentage offset from center. -50 → 0%, 0 → 50%, +50 → 100%.
  let meterPct = $derived(
    pitch.cents === null ? 50 : Math.max(0, Math.min(100, 50 + pitch.cents)),
  );
  let inTune = $derived(pitch.cents !== null && Math.abs(pitch.cents) <= 5);

  function draw(c: HTMLCanvasElement, snap: ScopeSnapshot) {
    const ctx2d = c.getContext('2d');
    if (!ctx2d) return;
    drawScope(
      ctx2d,
      snap,
      {
        timeMs,
        ch1Scale, ch1Offset, ch1Range,
        ch2Scale, ch2Offset, ch2Range,
        mode: node?.params.mode ?? 0,
        ch1Color, ch2Color,
      },
      c.width,
      c.height,
    );
  }
</script>

<div class="card">
  <div class="stripe"></div>
  <header class="title">
    Scope
    <button
      class="rng-btn"
      class:cv={ch1Range >= 0.5}
      style="color: {ch1Color};"
      onclick={() => toggleRange(1)}
      title={ch1Range >= 0.5 ? 'Ch1: CV range (±5)' : 'Ch1: audio range (±1)'}
    >
      1{ch1Range >= 0.5 ? 'cv' : 'a'}
    </button>
    <button
      class="rng-btn"
      class:cv={ch2Range >= 0.5}
      style="color: {ch2Color};"
      onclick={() => toggleRange(2)}
      title={ch2Range >= 0.5 ? 'Ch2: CV range (±5)' : 'Ch2: audio range (±1)'}
    >
      2{ch2Range >= 0.5 ? 'cv' : 'a'}
    </button>
    <button class="xy-btn" class:active={xyMode} onclick={toggleXY} title={xyMode ? 'Split mode' : 'XY mode'}>
      {xyMode ? 'XY' : '⇆'}
    </button>
  </header>

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="screen-wrap">
      <canvas bind:this={canvasEl} width="280" height="120"></canvas>
    </div>

    <div class="tuner" data-testid="scope-tuner">
      <div class="tuner-readout">
        <span class="lbl">PITCH</span>
        <span class="val val-hz" data-testid="pitch-hz">{fmtHz(pitch.hz)}</span>
        <span class="sep">|</span>
        <span class="lbl">NOTE</span>
        <span class="val val-note" data-testid="pitch-note">{pitch.note ?? '—'}</span>
      </div>
      <div class="meter" data-testid="tuning-meter">
        <div class="meter-tick" data-testid="tuning-meter-center"></div>
        <div
          class="meter-marker"
          class:in-tune={inTune}
          class:idle={pitch.cents === null}
          style="left: {meterPct}%;"
          data-testid="tuning-meter-marker"
        ></div>
      </div>
    </div>

    <div class="fader-row">
      <Fader value={timeMs}    min={1}    max={200} defaultValue={20} label="Time" units="ms" curve="log"    onchange={setParam('timeMs')} />
      <Fader value={ch1Scale}  min={0.1}  max={10}  defaultValue={1}  label="1 Sc"            curve="log"    onchange={setParam('ch1Scale')} />
      <Fader value={ch1Offset} min={-1}   max={1}   defaultValue={0}  label="1 Y"             curve="linear" onchange={setParam('ch1Offset')} />
      <Fader value={ch2Scale}  min={0.1}  max={10}  defaultValue={1}  label="2 Sc"            curve="log"    onchange={setParam('ch2Scale')} />
      <Fader value={ch2Offset} min={-1}   max={1}   defaultValue={0}  label="2 Y"             curve="linear" onchange={setParam('ch2Offset')} />
    </div>
  </PatchPanel>
</div>

<style>
  .card {
    width: 320px;
    min-height: 270px;
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
    background: var(--cable-cv);
    border-radius: 2px 2px 0 0;
  }
  .title {
    font-size: 0.85rem;
    font-weight: 500;
    text-align: center;
    margin: 0 0 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }
  .xy-btn {
    width: 28px;
    height: 18px;
    background: #2a2f3a;
    border: 1px solid #404652;
    color: var(--text-dim);
    border-radius: 3px;
    font-size: 0.65rem;
    cursor: pointer;
    padding: 0;
    line-height: 1;
    font-family: inherit;
  }
  .xy-btn.active {
    background: var(--accent);
    color: #1a1d23;
    border-color: var(--accent);
  }
  .rng-btn {
    height: 18px;
    min-width: 26px;
    padding: 0 4px;
    background: #14171c;
    border: 1px solid var(--border);
    border-radius: 3px;
    font-size: 0.6rem;
    font-family: ui-monospace, monospace;
    cursor: pointer;
    line-height: 1;
  }
  .rng-btn.cv {
    background: #1c2028;
    border-color: currentColor;
  }
  .screen-wrap {
    margin: 16px 30px 8px;
    border: 1px solid var(--border);
    border-radius: 3px;
    overflow: hidden;
    line-height: 0;
  }
  canvas {
    display: block;
    width: 100%;
    height: 120px;
  }
  .fader-row {
    display: flex;
    justify-content: center;
    gap: 6px;
    margin-top: 4px;
    padding: 0 12px;
  }
  .tuner {
    margin: 6px 30px 6px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    align-items: stretch;
  }
  .tuner-readout {
    display: flex;
    align-items: baseline;
    justify-content: center;
    gap: 6px;
    font-size: 0.6rem;
    color: var(--text-dim);
  }
  .tuner-readout .lbl {
    font-variant: small-caps;
    letter-spacing: 0.04em;
  }
  .tuner-readout .val {
    font-family: ui-monospace, monospace;
    color: var(--text);
    font-size: 0.7rem;
  }
  .tuner-readout .val-hz {
    min-width: 5.5em;
    text-align: right;
  }
  .tuner-readout .val-note {
    min-width: 2.5em;
    text-align: left;
  }
  .tuner-readout .sep {
    opacity: 0.4;
  }
  .meter {
    position: relative;
    height: 8px;
    background: #14171c;
    border: 1px solid var(--border);
    border-radius: 2px;
    margin: 0 auto;
    width: 100%;
    max-width: 220px;
  }
  .meter-tick {
    position: absolute;
    top: -1px;
    bottom: -1px;
    left: 50%;
    width: 1px;
    background: var(--text-dim);
    opacity: 0.6;
    transform: translateX(-0.5px);
  }
  .meter-marker {
    position: absolute;
    top: -2px;
    bottom: -2px;
    width: 3px;
    background: #f59e0b;
    border-radius: 1px;
    transform: translateX(-1.5px);
    transition: left 80ms linear, background 80ms linear;
  }
  .meter-marker.in-tune {
    background: #4ade80;
  }
  .meter-marker.idle {
    background: var(--text-dim);
    opacity: 0.3;
  }
</style>

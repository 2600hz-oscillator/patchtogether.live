<script lang="ts">
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { pentemelodicaDef, PENTE_VOICES } from '$lib/audio/modules/pentemelodica';
  import { moogWaves } from '../../../../../dsp/src/lib/moog-vco-dsp';
  import { waveMorph } from '../../../../../dsp/src/lib/pentemelodica-dsp';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  const engineCtx = useEngine();

  function def(paramId: string): number {
    return pentemelodicaDef.params.find((p) => p.id === paramId)!.defaultValue;
  }
  function pval(paramId: string): number {
    return node?.params?.[paramId] ?? def(paramId);
  }
  function setParam(paramId: string) {
    return (v: number) => {
      const target = patch.nodes[id];
      if (target) target.params[paramId] = v;
    };
  }
  function readLive(paramId: string) {
    return () => {
      const eng = engineCtx.get();
      if (!eng || !node) return undefined;
      return eng.readParam(node, paramId);
    };
  }

  const voices = Array.from({ length: PENTE_VOICES }, (_, i) => i + 1);

  // ONE shared amplitude ADSR (poly-adsr alignment with cube/wavecel/dx7): a
  // single A/D/S/R feeds every voice's gated envelope. A/D/R are log (units s);
  // S is linear 0..1 — same shape as CubeCard's AMP ADSR.
  const ADSR_FADERS: Array<{ pid: string; label: string; units?: string; curve: 'log' | 'linear' }> = [
    { pid: 'attack',  label: 'A', units: 's', curve: 'log' },
    { pid: 'decay',   label: 'D', units: 's', curve: 'log' },
    { pid: 'sustain', label: 'S', curve: 'linear' },
    { pid: 'release', label: 'R', units: 's', curve: 'log' },
  ];
  function pmin(pid: string): number {
    return pentemelodicaDef.params.find((p) => p.id === pid)!.min;
  }
  function pmax(pid: string): number {
    return pentemelodicaDef.params.find((p) => p.id === pid)!.max;
  }

  // ── Static single-cycle waveform preview per voice ──
  // Drawn from the SAME waveMorph()/moogWaves() the DSP uses, so the trace
  // tracks the voice's WAVE morph + pulse width. No rAF / no engine read →
  // deterministic for VRT (no canvas mask needed). Redrawn whenever the
  // voice's wave/pw params change.
  let traceColor = $state('#fbbf24');

  function drawVoice(canvas: HTMLCanvasElement | null, wave: number, pw: number): void {
    if (!canvas) return;
    const ctx2d = canvas.getContext('2d');
    if (!ctx2d) return;
    const w = canvas.width;
    const h = canvas.height;
    ctx2d.clearRect(0, 0, w, h);
    // bg
    ctx2d.fillStyle = '#0d1014';
    ctx2d.fillRect(0, 0, w, h);
    // mid axis
    ctx2d.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx2d.lineWidth = 1;
    ctx2d.beginPath();
    ctx2d.moveTo(0, h / 2);
    ctx2d.lineTo(w, h / 2);
    ctx2d.stroke();
    // one static cycle of the morphed wave. dt is tiny so the band-limited
    // residual is negligible — this is a shape preview, not the live signal.
    ctx2d.strokeStyle = traceColor;
    ctx2d.lineWidth = 1.5;
    ctx2d.beginPath();
    const dt = 1 / w;
    for (let x = 0; x < w; x++) {
      const phase = x / w;
      const waves = moogWaves(phase, dt, pw);
      const y = waveMorph(waves, wave);
      const py = (h / 2) - (y * (h / 2) * 0.9);
      if (x === 0) ctx2d.moveTo(x, py);
      else ctx2d.lineTo(x, py);
    }
    ctx2d.stroke();
  }

  // Per-voice canvas refs; redraw via $effect whenever wave/pw change.
  let canvases: (HTMLCanvasElement | null)[] = $state(new Array(PENTE_VOICES).fill(null));

  $effect(() => {
    const cs = getComputedStyle(document.documentElement);
    traceColor = cs.getPropertyValue('--cable-audio').trim() || traceColor;
    for (const v of voices) {
      // Touch the reactive params so the effect re-runs on change.
      const wave = pval(`v${v}_wave`);
      const pw = pval(`v${v}_pw`);
      drawVoice(canvases[v - 1], wave, pw);
    }
  });

  const inputs: PortDescriptor[] = [
    { id: 'poly', cable: 'polyPitchGate' },
    { id: 'fm1', label: 'FM 1', cable: 'audio' },
    { id: 'fm2', label: 'FM 2', cable: 'audio' },
    { id: 'fm3', label: 'FM 3', cable: 'audio' },
    { id: 'fm4', label: 'FM 4', cable: 'audio' },
    { id: 'fm5', label: 'FM 5', cable: 'audio' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'out_l', label: 'OUT L', cable: 'audio' },
    { id: 'out_r', label: 'OUT R', cable: 'audio' },
    { id: 'voice1', label: 'V1', cable: 'audio' },
    { id: 'voice2', label: 'V2', cable: 'audio' },
    { id: 'voice3', label: 'V3', cable: 'audio' },
    { id: 'voice4', label: 'V4', cable: 'audio' },
    { id: 'voice5', label: 'V5', cable: 'audio' },
  ];
</script>

<div class="card" data-testid="pentemelodica-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <ModuleTitle {id} {data} defaultLabel="PENTEMELODICA" />

  <div class="body">
    <div class="voices">
      {#each voices as v (v)}
        <div class="voice" data-testid={`pentemelodica-voice${v}`}>
          <div class="voice-num">{v}</div>
          <div class="scope-wrap">
            <canvas
              bind:this={canvases[v - 1]}
              width="84"
              height="40"
              data-testid={`pentemelodica-voice${v}-scope`}
            ></canvas>
          </div>
          <div class="strip">
            <Fader value={pval(`v${v}_tune`)} min={-36} max={36} defaultValue={0} label="TUNE" units="st" curve="linear" onchange={setParam(`v${v}_tune`)} moduleId={id} paramId={`v${v}_tune`} readLive={readLive(`v${v}_tune`)} />
            <Fader value={pval(`v${v}_fine`)} min={-100} max={100} defaultValue={0} label="FINE" units="¢" curve="linear" onchange={setParam(`v${v}_fine`)} moduleId={id} paramId={`v${v}_fine`} readLive={readLive(`v${v}_fine`)} />
            <Fader value={pval(`v${v}_fm`)} min={-1} max={1} defaultValue={0} label="FM" curve="linear" onchange={setParam(`v${v}_fm`)} moduleId={id} paramId={`v${v}_fm`} readLive={readLive(`v${v}_fm`)} />
            <Fader value={pval(`v${v}_pm`)} min={-1} max={1} defaultValue={0} label="PM" curve="linear" onchange={setParam(`v${v}_pm`)} moduleId={id} paramId={`v${v}_pm`} readLive={readLive(`v${v}_pm`)} />
            <Fader value={pval(`v${v}_pw`)} min={0.05} max={0.95} defaultValue={0.5} label="PW" curve="linear" onchange={setParam(`v${v}_pw`)} moduleId={id} paramId={`v${v}_pw`} readLive={readLive(`v${v}_pw`)} />
            <Fader value={pval(`v${v}_wave`)} min={0} max={1} defaultValue={0} label="WAVE" curve="linear" onchange={setParam(`v${v}_wave`)} moduleId={id} paramId={`v${v}_wave`} readLive={readLive(`v${v}_wave`)} glyphs={[{ frac: 0, kind: 'tri' }, { frac: 0.5, kind: 'saw' }, { frac: 1, kind: 'square' }]} />
          </div>
        </div>
      {/each}
    </div>

    <div class="side">
      <div class="block" data-testid="pentemelodica-mixer">
        <div class="block-title">MIXER</div>
        <div class="mixer-grid">
          {#each voices as v (v)}
            <div class="mix-col">
              <Fader value={pval(`v${v}_level`)} min={0} max={1} defaultValue={0.8} label={`L${v}`} curve="linear" onchange={setParam(`v${v}_level`)} moduleId={id} paramId={`v${v}_level`} readLive={readLive(`v${v}_level`)} />
              <Knob value={pval(`v${v}_pan`)} min={-1} max={1} defaultValue={0} label={`P${v}`} curve="linear" onchange={setParam(`v${v}_pan`)} moduleId={id} paramId={`v${v}_pan`} readLive={readLive(`v${v}_pan`)} />
            </div>
          {/each}
        </div>
      </div>

      <div class="block" data-testid="pentemelodica-adsr">
        <div class="block-title">AMP ADSR</div>
        <div class="adsr-row">
          {#each ADSR_FADERS as k (k.pid)}
            <Fader
              value={pval(k.pid)}
              min={pmin(k.pid)}
              max={pmax(k.pid)}
              defaultValue={def(k.pid)}
              label={k.label}
              units={k.units}
              curve={k.curve}
              onchange={setParam(k.pid)}
              moduleId={id}
              paramId={k.pid}
              readLive={readLive(k.pid)}
            />
          {/each}
        </div>
      </div>

      <div class="block" data-testid="pentemelodica-filter">
        <div class="block-title">FILTER</div>
        <div class="filter-row">
          <Knob value={pval('cutoff')} min={20} max={20000} defaultValue={1000} label="CUTOFF" units="Hz" curve="log" onchange={setParam('cutoff')} moduleId={id} paramId="cutoff" readLive={readLive('cutoff')} />
          <Knob value={pval('resonance')} min={0} max={0.99} defaultValue={0.2} label="RESO" curve="linear" onchange={setParam('resonance')} moduleId={id} paramId="resonance" readLive={readLive('resonance')} />
          <Knob value={pval('mode')} min={0} max={1} defaultValue={0} label="MODE" curve="linear" onchange={setParam('mode')} moduleId={id} paramId="mode" readLive={readLive('mode')} />
          <Knob value={pval('wetdry')} min={0} max={1} defaultValue={1} label="WET" curve="linear" onchange={setParam('wetdry')} moduleId={id} paramId="wetdry" readLive={readLive('wetdry')} />
        </div>
      </div>
    </div>
  </div>

  <PatchPanel nodeId={id} {inputs} {outputs} panelWidth={520} />
</div>

<style>
  .card {
    width: 1180px;
    background: var(--module-bg);
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text);
    padding-top: 18px;
    padding-bottom: 12px;
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
  .body {
    display: flex;
    gap: 10px;
    padding: 8px 12px 0;
    align-items: flex-start;
  }
  .voices {
    display: flex;
    gap: 6px;
    flex: 0 0 auto;
  }
  .voice {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 4px;
    border: 1px solid var(--border);
    border-radius: 3px;
    background: rgba(255, 255, 255, 0.015);
  }
  .voice-num {
    font-size: 0.7rem;
    font-weight: 600;
    opacity: 0.7;
    letter-spacing: 0.04em;
  }
  .scope-wrap {
    border: 1px solid var(--border);
    border-radius: 3px;
    overflow: hidden;
    line-height: 0;
    background: #0d1014;
  }
  .scope-wrap canvas {
    display: block;
  }
  .strip {
    display: flex;
    gap: 2px;
    justify-content: center;
  }
  .side {
    display: flex;
    flex-direction: column;
    gap: 8px;
    flex: 1 1 auto;
    min-width: 0;
  }
  .block {
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 6px 8px;
  }
  .block-title {
    font-size: 0.65rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    opacity: 0.6;
    margin-bottom: 4px;
  }
  .mixer-grid {
    display: flex;
    gap: 8px;
    justify-content: space-around;
  }
  .mix-col {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
  }
  .adsr-row {
    display: flex;
    gap: 8px;
    justify-content: space-around;
  }
  .filter-row {
    display: flex;
    gap: 12px;
    justify-content: space-around;
  }
</style>

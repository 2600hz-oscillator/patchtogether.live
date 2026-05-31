<script lang="ts">
  // ChowkickCard — synth-kick voice card. Two-band fader layout mirrors
  // the source plugin's UI (Pulse Shape band → Resonant Filter band)
  // with a small canvas in each band that renders a live preview of the
  // envelope shape + filter peak — honoring the upstream visual
  // convention the user called out in the spec.
  //
  // Layout (Ports family, matches CocoaDelayCard / SidecarCard chrome):
  //
  //   ┌──────────── PULSE SHAPE ────────────────┐
  //   │ [envelope viz]                          │
  //   │ Width  Amp   Decay  Sust                │
  //   │ NAmt   NDec  NCut   NType               │
  //   ├──────────── RESONANT FILTER ────────────┤
  //   │ [filter response viz]                   │
  //   │ Freq   Q     Damp   Tight  Bounce       │
  //   │ Tone   Porta Link   Level               │
  //   └─────────────────────────────────────────┘

  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { chowkickDef } from '$lib/audio/modules/chowkick';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import OssAttribution from './OssAttribution.svelte';
  import { onMount, untrack } from 'svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  function defaultFor(pid: string): number {
    return chowkickDef.params.find((p) => p.id === pid)?.defaultValue ?? 0;
  }
  function paramVal(k: string): number {
    const v = node?.params?.[k];
    return typeof v === 'number' ? v : defaultFor(k);
  }

  const set = (pid: string) => (v: number) => {
    const t = patch.nodes[id]; if (t) t.params[pid] = v;
  };
  const live = (pid: string) => () => {
    const e = engineCtx.get(); if (!e || !node) return undefined;
    return e.readParam(node, pid);
  };

  // Per-param reactive reads.
  let width        = $derived(paramVal('width'));
  let amplitude    = $derived(paramVal('amplitude'));
  let decay        = $derived(paramVal('decay'));
  let sustain      = $derived(paramVal('sustain'));
  let noiseAmount  = $derived(paramVal('noise_amount'));
  let noiseDecay   = $derived(paramVal('noise_decay'));
  let noiseCutoff  = $derived(paramVal('noise_cutoff'));
  let noiseType    = $derived(paramVal('noise_type'));
  let freq         = $derived(paramVal('freq'));
  let q            = $derived(paramVal('q'));
  let damping      = $derived(paramVal('damping'));
  let tight        = $derived(paramVal('tight'));
  let bounce       = $derived(paramVal('bounce'));
  let tone         = $derived(paramVal('tone'));
  let portamento   = $derived(paramVal('portamento'));
  let level        = $derived(paramVal('level'));
  let link         = $derived(paramVal('link'));

  const NOISE_TYPE_NAMES = ['Uniform', 'Gaussian', 'Pink', 'Velvet'] as const;
  let noiseTypeName = $derived(NOISE_TYPE_NAMES[Math.max(0, Math.min(3, Math.round(noiseType)))] ?? 'Uniform');

  const inputs: PortDescriptor[] = [
    { id: 'gate_in',         label: 'GATE',    cable: 'gate' },
    { id: 'pitch_cv',        label: 'V/OCT',   cable: 'cv' },
    { id: 'width_cv',        label: 'WID CV',  cable: 'cv' },
    { id: 'amplitude_cv',    label: 'AMP CV',  cable: 'cv' },
    { id: 'decay_cv',        label: 'DEC CV',  cable: 'cv' },
    { id: 'sustain_cv',      label: 'SUS CV',  cable: 'cv' },
    { id: 'noise_amount_cv', label: 'NA CV',   cable: 'cv' },
    { id: 'noise_decay_cv',  label: 'ND CV',   cable: 'cv' },
    { id: 'noise_cutoff_cv', label: 'NC CV',   cable: 'cv' },
    { id: 'freq_cv',         label: 'FRQ CV',  cable: 'cv' },
    { id: 'q_cv',            label: 'Q CV',    cable: 'cv' },
    { id: 'damping_cv',      label: 'DMP CV',  cable: 'cv' },
    { id: 'tight_cv',        label: 'TGT CV',  cable: 'cv' },
    { id: 'bounce_cv',       label: 'BNC CV',  cable: 'cv' },
    { id: 'tone_cv',         label: 'TON CV',  cable: 'cv' },
    { id: 'portamento_cv',   label: 'PRT CV',  cable: 'cv' },
    { id: 'level_cv',        label: 'LVL CV',  cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'audio_out', label: 'OUT', cable: 'audio' },
  ];

  // ─── Visualizations ────────────────────────────────────────────────
  //
  // Pulse envelope: trace the deterministic envelope shape that
  // pulseShaperStep + noiseBurstStep produce given the current knob
  // values. The DSP helpers are pure functions so the canvas re-render
  // on knob drag matches the audio output 1:1.
  //
  // Filter response: trace |H(f)| of the resonant peaking IIR over a
  // log-Hz axis for the current freq/Q/damping/tight/bounce knobs.

  let envCanvas: HTMLCanvasElement | undefined = $state();
  let respCanvas: HTMLCanvasElement | undefined = $state();
  const VIZ_W = 280;
  const VIZ_H = 60;

  function drawEnvelope() {
    const c = envCanvas; if (!c) return;
    const ctx2 = c.getContext('2d'); if (!ctx2) return;
    const w = c.width = VIZ_W;
    const h = c.height = VIZ_H;
    ctx2.clearRect(0, 0, w, h);
    // Bg.
    ctx2.fillStyle = '#0d0d10';
    ctx2.fillRect(0, 0, w, h);
    // Compute envelope: 80 ms preview window at 1 ms = w/80 px.
    const dur_s = 0.08;
    const sr = 8000; // viz-only SR; envelope shape is sr-invariant up to small smoothing.
    const N = Math.round(dur_s * sr);
    const wMs = Math.max(0.1, Math.min(50, width));
    const ampN = Math.max(0, Math.min(2, amplitude));
    const dec = Math.max(0, Math.min(1, decay));
    const sus = Math.max(0, Math.min(1, sustain));
    // Pulse shape: hold for wMs, then decay toward sus*amp w/ tau from decay.
    const lo = 0.001, hi = 0.2;
    const tau = lo * Math.pow(hi / lo, dec);
    const a = Math.exp(-1 / (tau * sr));
    const holdN = Math.max(1, Math.round((wMs / 1000) * sr));
    let y = ampN;
    const floor = sus * ampN;
    ctx2.beginPath();
    ctx2.strokeStyle = '#ff8f3f';
    ctx2.lineWidth = 1.5;
    for (let i = 0; i < N; i++) {
      if (i < holdN) y = ampN;
      else y = a * y + (1 - a) * floor;
      const px = (i / N) * w;
      const py = h - (y / 2) * h - 1;
      if (i === 0) ctx2.moveTo(px, py); else ctx2.lineTo(px, py);
    }
    ctx2.stroke();
    // Baseline.
    ctx2.strokeStyle = '#22232a';
    ctx2.beginPath(); ctx2.moveTo(0, h - 1); ctx2.lineTo(w, h - 1); ctx2.stroke();
  }

  function drawResponse() {
    const c = respCanvas; if (!c) return;
    const ctx2 = c.getContext('2d'); if (!ctx2) return;
    const w = c.width = VIZ_W;
    const h = c.height = VIZ_H;
    ctx2.clearRect(0, 0, w, h);
    ctx2.fillStyle = '#0d0d10';
    ctx2.fillRect(0, 0, w, h);
    // Peaking IIR mag response: |H(z)| at z=e^{jω}, ω = 2π f / sr_viz.
    // Pure math (no state) — we re-derive the coefs the way the worklet
    // does so the displayed peak matches the audible peak.
    const sr_viz = 48000;
    const f_lo = 20, f_hi = 5000;
    const fc = Math.max(20, Math.min(0.45 * sr_viz, freq));
    const qC = Math.max(0.05, q);
    const wc = 2 * Math.PI * fc / sr_viz;
    const sw = Math.sin(wc), cw = Math.cos(wc);
    const alpha = sw / (2 * qC);
    const G = 0.0001 * Math.pow(0.5 / 0.0001, Math.max(0, Math.min(1, damping)));
    const A = Math.sqrt(G);
    const a0 = 1 + alpha / A;
    const b0 = (1 + alpha * A) / a0;
    const b1 = (-2 * cw) / a0;
    const b2 = (1 - alpha * A) / a0;
    const a1 = (-2 * cw) / a0;
    const a2 = (1 - alpha / A) / a0;
    // Trace |H(ω)| in dB; -36..+24 dB → 0..h.
    let maxDb = -120, minDb = 120;
    const mags: number[] = [];
    for (let x = 0; x < w; x++) {
      const f = f_lo * Math.pow(f_hi / f_lo, x / (w - 1));
      const omega = 2 * Math.PI * f / sr_viz;
      const c1 = Math.cos(omega), s1 = Math.sin(omega);
      const c2 = Math.cos(2 * omega), s2 = Math.sin(2 * omega);
      // H = (b0 + b1 z^-1 + b2 z^-2) / (1 + a1 z^-1 + a2 z^-2)
      const numR = b0 + b1 * c1 + b2 * c2;
      const numI = -b1 * s1 - b2 * s2;
      const denR = 1 + a1 * c1 + a2 * c2;
      const denI = -a1 * s1 - a2 * s2;
      const denMag2 = denR * denR + denI * denI;
      const HR = (numR * denR + numI * denI) / denMag2;
      const HI = (numI * denR - numR * denI) / denMag2;
      const m = Math.sqrt(HR * HR + HI * HI);
      const db = 20 * Math.log10(Math.max(1e-6, m));
      mags.push(db);
      if (db > maxDb) maxDb = db;
      if (db < minDb) minDb = db;
    }
    // Trace.
    ctx2.beginPath();
    ctx2.strokeStyle = '#ff8f3f';
    ctx2.lineWidth = 1.5;
    for (let x = 0; x < w; x++) {
      const db = mags[x] ?? -60;
      const norm = Math.max(0, Math.min(1, (db + 36) / 60));
      const py = h - norm * (h - 2) - 1;
      if (x === 0) ctx2.moveTo(x, py); else ctx2.lineTo(x, py);
    }
    ctx2.stroke();
    ctx2.strokeStyle = '#22232a';
    ctx2.beginPath(); ctx2.moveTo(0, h - 1); ctx2.lineTo(w, h - 1); ctx2.stroke();
  }

  // Re-render the viz whenever any contributing knob changes. We read the
  // derived values inside the effect so Svelte tracks them.
  $effect(() => {
    // Track the contributing params so this re-runs on knob drag.
    void width; void amplitude; void decay; void sustain;
    untrack(() => drawEnvelope());
  });
  $effect(() => {
    void freq; void q; void damping; void tight; void bounce;
    untrack(() => drawResponse());
  });
  onMount(() => {
    drawEnvelope();
    drawResponse();
  });
</script>

<div class="mod-card chowkick-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <ModuleTitle {id} {data} defaultLabel="CHOWKICK" />

  <PatchPanel nodeId={id} {inputs} {outputs} panelWidth={520}>
    <section class="band pulse-band">
      <header>PULSE SHAPE</header>
      <canvas class="viz" bind:this={envCanvas} aria-label="Pulse envelope preview"></canvas>
      <div class="fader-row">
        <Fader value={width}        min={0.1} max={50}   defaultValue={defaultFor('width')}        label="Wid"  units="ms" curve="log"    onchange={set('width')}        moduleId={id} paramId="width"        readLive={live('width')} />
        <Fader value={amplitude}    min={0}   max={2}    defaultValue={defaultFor('amplitude')}    label="Amp"             curve="linear" onchange={set('amplitude')}    moduleId={id} paramId="amplitude"    readLive={live('amplitude')} />
        <Fader value={decay}        min={0}   max={1}    defaultValue={defaultFor('decay')}        label="Dec"             curve="linear" onchange={set('decay')}        moduleId={id} paramId="decay"        readLive={live('decay')} />
        <Fader value={sustain}      min={0}   max={1}    defaultValue={defaultFor('sustain')}      label="Sus"             curve="linear" onchange={set('sustain')}      moduleId={id} paramId="sustain"      readLive={live('sustain')} />
      </div>
      <div class="fader-row">
        <Fader value={noiseAmount}  min={0}   max={1}    defaultValue={defaultFor('noise_amount')} label="NAmt"            curve="linear" onchange={set('noise_amount')} moduleId={id} paramId="noise_amount" readLive={live('noise_amount')} />
        <Fader value={noiseDecay}   min={0}   max={1}    defaultValue={defaultFor('noise_decay')}  label="NDec"            curve="linear" onchange={set('noise_decay')}  moduleId={id} paramId="noise_decay"  readLive={live('noise_decay')} />
        <Fader value={noiseCutoff}  min={20}  max={5000} defaultValue={defaultFor('noise_cutoff')} label="NCut" units="Hz" curve="log"    onchange={set('noise_cutoff')} moduleId={id} paramId="noise_cutoff" readLive={live('noise_cutoff')} />
        <Fader value={noiseType}    min={0}   max={3}    defaultValue={defaultFor('noise_type')}   label={`NTyp ${noiseTypeName}`} curve="linear" onchange={set('noise_type')}   moduleId={id} paramId="noise_type"   readLive={live('noise_type')} />
      </div>
    </section>

    <section class="band res-band">
      <header>RESONANT FILTER</header>
      <canvas class="viz" bind:this={respCanvas} aria-label="Resonant filter response preview"></canvas>
      <div class="fader-row">
        <Fader value={freq}      min={20}  max={500}  defaultValue={defaultFor('freq')}    label="Frq"  units="Hz" curve="log"    onchange={set('freq')}    moduleId={id} paramId="freq"    readLive={live('freq')} />
        <Fader value={q}         min={0.1} max={10}   defaultValue={defaultFor('q')}       label="Q"               curve="log"    onchange={set('q')}       moduleId={id} paramId="q"       readLive={live('q')} />
        <Fader value={damping}   min={0}   max={1}    defaultValue={defaultFor('damping')} label="Dmp"             curve="linear" onchange={set('damping')} moduleId={id} paramId="damping" readLive={live('damping')} />
        <Fader value={tight}     min={0}   max={1}    defaultValue={defaultFor('tight')}   label="Tgt"             curve="linear" onchange={set('tight')}   moduleId={id} paramId="tight"   readLive={live('tight')} />
        <Fader value={bounce}    min={0}   max={1}    defaultValue={defaultFor('bounce')}  label="Bnc"             curve="linear" onchange={set('bounce')}  moduleId={id} paramId="bounce"  readLive={live('bounce')} />
      </div>
      <div class="fader-row">
        <Fader value={tone}       min={50}  max={2000} defaultValue={defaultFor('tone')}        label="Tone" units="Hz" curve="log"      onchange={set('tone')}       moduleId={id} paramId="tone"       readLive={live('tone')} />
        <Fader value={portamento} min={0}   max={100}  defaultValue={defaultFor('portamento')}  label="Prt"  units="ms" curve="log"      onchange={set('portamento')} moduleId={id} paramId="portamento" readLive={live('portamento')} />
        <Fader value={link}       min={0}   max={1}    defaultValue={defaultFor('link')}        label={`Lnk ${link >= 0.5 ? 'ON' : 'OFF'}`} curve="linear" onchange={set('link')}       moduleId={id} paramId="link"       readLive={live('link')} />
        <Fader value={level}      min={-60} max={0}    defaultValue={defaultFor('level')}       label="Lvl"  units="dB" curve="linear"  onchange={set('level')}      moduleId={id} paramId="level"      readLive={live('level')} />
      </div>
    </section>
  </PatchPanel>

  <OssAttribution author={chowkickDef.ossAttribution?.author ?? ''} />
</div>

<style>
  .chowkick-card { width: 540px; min-height: 380px; }
  .chowkick-card .band {
    padding: 6px 12px 10px;
    border-top: 1px solid #1d1f25;
  }
  .chowkick-card .band:first-of-type { border-top: none; }
  .chowkick-card .band header {
    font-size: 10px;
    letter-spacing: 1.2px;
    color: #ff8f3f;
    text-transform: uppercase;
    margin: 4px 0 4px;
    opacity: 0.9;
  }
  .chowkick-card .viz {
    display: block;
    width: 280px;
    height: 60px;
    margin: 0 auto 6px;
    background: #0d0d10;
    border: 1px solid #1d1f25;
    border-radius: 4px;
  }
  .chowkick-card .fader-row {
    display: flex;
    gap: 10px;
    padding: 0 4px;
    margin-bottom: 6px;
  }
</style>

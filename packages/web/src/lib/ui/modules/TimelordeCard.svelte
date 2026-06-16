<script lang="ts">
  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch, ydoc } from '$lib/graph/store';
  import { setNodeParam } from '$lib/graph/mutate';
  import { timelordeDef } from '$lib/audio/modules/timelorde';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  let cardVersion = $state(0);
  $effect(() => {
    const h = () => { cardVersion = cardVersion + 1; };
    ydoc.on('update', h);
    return () => ydoc.off('update', h);
  });

  // Live BPM the engine is currently locked to when an external clock
  // is patched (the worklet posts a measurement on each rising edge;
  // 0 means "no external lock right now, fall back to internal").
  // Polled at ~4 Hz — the worklet emits on edge so this just samples
  // the latest cached value.
  let measuredBpm = $state(0);
  $effect(() => {
    const e = engineCtx.get();
    if (!e || !node) return;
    const id = setInterval(() => {
      const v = e.read?.(node, 'measuredBpm');
      measuredBpm = typeof v === 'number' ? v : 0;
    }, 250);
    return () => clearInterval(id);
  });

  let bpm         = $derived((void cardVersion, node?.params.bpm         ?? 120));
  let swingAmount = $derived((void cardVersion, node?.params.swingAmount ?? 0));
  let swingSource = $derived((void cardVersion, node?.params.swingSource ?? 0));
  // v2: muteOutputs replaces isPlaying. Default 0 = unmuted/running.
  // Existing v1 patches save `isPlaying` (1=playing/0=stopped); the
  // factory's inline migrate-on-spawn flips them to muteOutputs, so
  // here we only read the new key.
  let muteOutputs = $derived((void cardVersion, (node?.params.muteOutputs ?? 0) >= 0.5));

  // running (v3): the GLOBAL transport. 1 = clock advances; 0 = HALTED (phase
  // freezes, gates go low). Distinct from MUTE (muteOutputs only silences gate
  // outputs; the internal clock keeps turning for LIVECODE). Every sequencer
  // locked to TIMELORDE — incl. the clip player — freezes when running = 0, so
  // this is the rack-wide stop/start.
  let running = $derived((void cardVersion, (node?.params.running ?? 1) >= 0.5));

  let hasExternalClock = $derived.by(() => {
    void cardVersion;
    for (const edge of Object.values(patch.edges)) {
      if (!edge) continue;
      if (edge.target.nodeId === id && edge.target.portId === 'clock') return true;
    }
    return false;
  });
  // When start_in / stop_in are patched, an external transport owns `running`
  // (MIDICLOCK etc.), so the card's transport button steps aside to avoid a fight.
  let transportSlaved = $derived.by(() => {
    void cardVersion;
    for (const edge of Object.values(patch.edges)) {
      if (!edge) continue;
      if (edge.target.nodeId === id && (edge.target.portId === 'start_in' || edge.target.portId === 'stop_in'))
        return true;
    }
    return false;
  });

  const set = (k: string) => (v: number) => setNodeParam(id, k, v);
  const live = (k: string) => () => {
    const e = engineCtx.get(); if (!e || !node) return undefined;
    return e.readParam(node, k);
  };

  function toggleMute() {
    // External clock no longer overrides — the user can mute the rack
    // even while MIDICLOCK drives TIMELORDE. The internal clock keeps
    // running for LIVECODE consumers regardless.
    set('muteOutputs')(muteOutputs ? 0 : 1);
  }
  function toggleRun() {
    // Global transport: halt/resume the whole rack clock. Musical position is
    // preserved (the worklet resumes from the frozen phase on restart).
    set('running')(running ? 0 : 1);
  }

  const OUT_LABELS = ['1x', '8x', '4x', '2x', '1/2', '1/3', '1/4', '1/8', '1/12', '1/16', '1/32', '1/64', 'swing'];
  const SRC_LABELS = ['1x', '8x', '4x', '2x', '1/2', '1/3', '1/4', '1/8', '1/12', '1/16', '1/32', '1/64'];

  const inputs: PortDescriptor[] = [
    { id: 'clock',    label: 'CLOCK IN', cable: 'gate' },
    // Transport gates — rising edge mirrors the ON / MUTE button.
    // Intended pairing: MIDICLOCK.midistart → START, MIDICLOCK.midistop → STOP.
    { id: 'start_in', label: 'START',    cable: 'gate' },
    { id: 'stop_in',  label: 'STOP',     cable: 'gate' },
  ];
  const outputs: PortDescriptor[] = OUT_LABELS.map((label) => ({
    id: label,
    label: `CLOCK ${label.toUpperCase()}`,
    cable: 'gate',
  }));
</script>

<div class="mod-card timelorde-card">
  <div class="stripe" style="background: var(--cable-gate);"></div>
  <header class="title">
    <ModuleTitle {id} {data} defaultLabel="TIMELORDE" inline />
    <!-- Global TRANSPORT (running): halts/resumes the whole rack clock — every
         sequencer locked to TIMELORDE (incl. the clip player) stops with it.
         Hidden when an external transport (start_in/stop_in) owns `running`. -->
    {#if !transportSlaved}
      <button class="play-btn run-btn" class:playing={running} onclick={toggleRun} title={running ? 'Stop transport (halt the rack clock)' : 'Start transport (resume the rack clock)'} data-testid={`timelorde-run-${id}`}>
        {running ? '■' : '▶'}
      </button>
    {/if}
    <!-- MUTE always shown (v2 — clock keeps running even when an
         external clock is patched; the mute only silences the gate
         outputs, not the internal phase that LIVECODE rides on). -->
    <button class="play-btn" class:playing={!muteOutputs} onclick={toggleMute} title={muteOutputs ? 'Unmute (gates fire)' : 'Mute (gates go silent; internal clock keeps running for LIVECODE)'}>
        {muteOutputs ? 'MUTE' : 'ON'}
      </button>
  </header>

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="knob-row">
      <Knob value={bpm}         min={10} max={300} defaultValue={120} label="BPM"   curve="log"      onchange={set('bpm')} moduleId={id} paramId="bpm"         readLive={live('bpm')} />
      <Knob value={swingAmount} min={0}  max={90}  defaultValue={0}   label="Swing" curve="linear"   onchange={set('swingAmount')} moduleId={id} paramId="swingAmount" readLive={live('swingAmount')} />
      <Knob value={swingSource} min={0}  max={10}  defaultValue={0}   label="Src"   curve="discrete" onchange={set('swingSource')} moduleId={id} paramId="swingSource" />
    </div>

    <div class="footer">
      {(hasExternalClock && measuredBpm > 0 ? measuredBpm : bpm).toFixed(0)} BPM ({hasExternalClock ? 'external' : 'internal'}) · src={SRC_LABELS[Math.round(swingSource)] ?? '1x'}
    </div>
  </PatchPanel>
</div>

<style>
  .timelorde-card {
    width: 280px;
    padding-bottom: 26px;
  }
  .timelorde-card > .title {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }
  .play-btn {
    width: 22px;
    height: 22px;
    background: #2a2f3a;
    border: 1px solid #404652;
    color: var(--text);
    border-radius: 3px;
    font-size: 0.7rem;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
    padding: 0;
  }
  .play-btn.playing {
    background: var(--cable-gate);
    color: #1a1d23;
    border-color: var(--cable-gate);
  }
  /* The global transport reads distinct from MUTE: accent-tinted while running. */
  .run-btn.playing {
    background: var(--accent, #6cf);
    border-color: var(--accent, #6cf);
    color: #1a1d23;
  }
  .knob-row {
    margin: 16px 0 0;
    display: flex;
    flex-direction: row;
    justify-content: center;
    gap: 14px;
  }
  .footer {
    margin-top: 12px;
    text-align: center;
    font-size: 0.6rem;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
    pointer-events: none;
  }
</style>

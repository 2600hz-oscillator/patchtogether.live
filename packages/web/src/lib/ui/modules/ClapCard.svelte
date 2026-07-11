<script lang="ts">
  // ClapCard — analog-modeled handclap voice card. Compact single-band
  // layout (curated 8-knob voice + level), Ports-family chrome:
  //
  //   ┌───── BURST ─────────┬──── NOISE ─────┬──── OUT ────────────┐
  //   │ Puls Sprd Snap      │ Tone Wdth Col  │ Tail Drv Lvl [CLAP] │
  //   └─────────────────────┴────────────────┴─────────────────────┘
  //
  // The CLAP pad is press-to-fire (the bluebox press-param pattern):
  // pointerdown writes 1 to the `strike` param + setParam-pushes it to the
  // engine for low-latency response; pointerup writes 0. The worklet ORs
  // the pad with trigger_in, so its rising edge fires exactly ONE clap.

  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { setNodeParam } from '$lib/graph/mutate';
  import { useEngine } from '$lib/audio/engine-context';
  import { clapDef } from '$lib/audio/modules/clap';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();
  const { defaultFor, paramVal, set, live } = cardParams(clapDef, () => id, () => node);

  // Per-param reactive reads.
  let pulses = $derived(paramVal('pulses'));
  let spread = $derived(paramVal('spread'));
  let snap   = $derived(paramVal('snap'));
  let tone   = $derived(paramVal('tone'));
  let width  = $derived(paramVal('width'));
  let color  = $derived(paramVal('color'));
  let tail   = $derived(paramVal('tail'));
  let drive  = $derived(paramVal('drive'));
  let level  = $derived(paramVal('level'));

  let clapping = $derived((node?.params?.['strike'] ?? 0) >= 0.5);

  /** Press/release the CLAP pad — write the param (peers + store see the
   *  held state) AND push straight to the engine for immediate strike. */
  function setStrike(v: 0 | 1): void {
    setNodeParam(id, 'strike', v);
    const e = engineCtx.get();
    if (e && node) e.setParam(node, 'strike', v);
  }
  function onClapDown(ev: PointerEvent): void {
    try {
      (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    } catch { /* synthetic event — fine */ }
    setStrike(1);
  }
  function onClapUp(ev: PointerEvent): void {
    try {
      (ev.currentTarget as HTMLElement).releasePointerCapture(ev.pointerId);
    } catch { /* not captured — fine */ }
    setStrike(0);
  }

  const inputs = portsFromDef(clapDef.inputs, {
    trigger_in: 'TRIG', accent_in: 'ACC',
    tone_cv: 'TONE', tail_cv: 'TAIL', spread_cv: 'SPRD',
  });
  const outputs = portsFromDef(clapDef.outputs, { audio_out: 'OUT' });
</script>

<div class="mod-card clap-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <ModuleTitle {id} {data} defaultLabel="CLAP" />

  <PatchPanel nodeId={id} {inputs} {outputs} panelWidth={440}>
    <section class="band">
      <div class="groups">
        <div class="group">
          <header>BURST</header>
          <div class="fader-row">
            <Fader value={pulses} min={2} max={5}  defaultValue={defaultFor('pulses')} label="Puls"           curve="discrete" onchange={set('pulses')} moduleId={id} paramId="pulses" readLive={live('pulses')} />
            <Fader value={spread} min={4} max={25} defaultValue={defaultFor('spread')} label="Sprd" units="ms" curve="log"      onchange={set('spread')} moduleId={id} paramId="spread" readLive={live('spread')} />
            <Fader value={snap}   min={0} max={1}  defaultValue={defaultFor('snap')}   label="Snap"           curve="linear"   onchange={set('snap')}   moduleId={id} paramId="snap"   readLive={live('snap')} />
          </div>
        </div>
        <div class="group">
          <header>NOISE</header>
          <div class="fader-row">
            <Fader value={tone}  min={400} max={3000} defaultValue={defaultFor('tone')}  label="Tone" units="Hz" curve="log"    onchange={set('tone')}  moduleId={id} paramId="tone"  readLive={live('tone')} />
            <Fader value={width} min={0}   max={1}    defaultValue={defaultFor('width')} label="Wdth"           curve="linear" onchange={set('width')} moduleId={id} paramId="width" readLive={live('width')} />
            <Fader value={color} min={0}   max={1}    defaultValue={defaultFor('color')} label="Col"            curve="linear" onchange={set('color')} moduleId={id} paramId="color" readLive={live('color')} />
          </div>
        </div>
        <div class="group wide">
          <header>ROOM · OUT</header>
          <div class="fader-row">
            <Fader value={tail}  min={30}  max={800} defaultValue={defaultFor('tail')}  label="Tail" units="ms" curve="log"    onchange={set('tail')}  moduleId={id} paramId="tail"  readLive={live('tail')} />
            <Fader value={drive} min={0}   max={1}   defaultValue={defaultFor('drive')} label="Drv"             curve="linear" onchange={set('drive')} moduleId={id} paramId="drive" readLive={live('drive')} />
            <Fader value={level} min={-24} max={12}  defaultValue={defaultFor('level')} label="Lvl"  units="dB" curve="linear" onchange={set('level')} moduleId={id} paramId="level" readLive={live('level')} />
            <button
              class="clap-pad"
              class:held={clapping}
              onpointerdown={onClapDown}
              onpointerup={onClapUp}
              onpointercancel={onClapUp}
              data-testid="clap-strike"
              title="CLAP: fire one hit (press edge = the strike)"
            >CLAP</button>
          </div>
        </div>
      </div>
    </section>
  </PatchPanel>
</div>

<style>
  .clap-card { width: 460px; min-height: 200px; }
  .clap-card .band { padding: 6px 12px 8px; }
  .clap-card .groups {
    display: flex;
    gap: 12px;
    align-items: stretch;
  }
  .clap-card .group {
    flex: 1;
    min-width: 0;
    border-right: 1px solid #1d1f25;
    padding-right: 10px;
  }
  .clap-card .group.wide { flex: 1.4; }
  .clap-card .group:last-child { border-right: none; padding-right: 0; }
  .clap-card .group header {
    font-size: 10px;
    letter-spacing: 1.2px;
    color: #ff8f3f;
    text-transform: uppercase;
    margin: 4px 0 4px;
    opacity: 0.9;
  }
  .clap-card .fader-row {
    display: flex;
    gap: 10px;
    padding: 0 2px;
    margin-bottom: 6px;
    align-items: flex-end;
  }
  .clap-card .clap-pad {
    align-self: center;
    font-family: var(--font-mono, monospace);
    font-size: 0.62rem;
    letter-spacing: 0.8px;
    padding: 14px 10px;
    background: #14151a;
    color: #9aa0ae;
    border: 1px solid #2a2d36;
    border-radius: 6px;
    cursor: pointer;
    white-space: nowrap;
    touch-action: none; /* keep pointerdown gestures from being eaten by scroll */
  }
  .clap-card .clap-pad.held {
    color: #ff8f3f;
    border-color: #ff8f3f;
    background: #1c1610;
  }
</style>

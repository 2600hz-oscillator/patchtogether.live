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
  import NeonFader from '$lib/ui/controls/NeonFader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { clapDef } from '$lib/audio/modules/clap';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, portsFromDef } from './card-kit';
  import { clearStuckMomentaryParams, setMomentaryParam } from './manual-strike-actions';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
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

  // ⚠ COMPONENT STATE, not a `node.params` read. The pad is MOMENTARY: it
  // never reaches the Y.Doc (see setStrike), so a param readback would be
  // permanently false and the pressed styling would never appear.
  let clapping = $state(false);

  // Repair a rack SAVED with the pad stuck down (the durable-write era below).
  // `AudioEngine.addNode` already refuses to apply such a value, so the voice
  // is playable regardless; this clears the dead number out of the document so
  // a re-save is clean.
  $effect(() => {
    if (node) clearStuckMomentaryParams(id, clapDef);
  });

  /**
   * Press/release the CLAP pad — ENGINE ONLY, never the Y.Doc.
   *
   * ⚠ It used to `setNodeParam(id, 'strike', v)`, which made a MOMENTARY
   * action write DURABLE state. When the release edge goes missing (the dock
   * closes, the module is deleted, the tab hides mid-hold — pointer capture
   * protects a moving pointer, not a deleted element) the 1 PERSISTS: it saves,
   * it syncs to every peer, and because packages/dsp/src/clap.ts ORs the pad
   * with `trigger_in` as LEVELS (`Math.max(inTrig[s], strike)`) the combined
   * trigger stays permanently high and NO external trigger can strike the
   * voice again for the rest of the session. tomtom and tidyVco were migrated
   * to `setMomentaryParam` for exactly this; clap was missed. It also registers
   * the pad with the window-level panic listeners, so a release this button
   * never sees still reaches the engine.
   */
  function setStrike(v: 0 | 1): void {
    clapping = v === 1;
    setMomentaryParam(id, 'strike', v === 1, defaultFor('strike'));
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
            <NeonFader value={pulses} min={2} max={5}  defaultValue={defaultFor('pulses')} label="Puls"           curve="discrete" onchange={set('pulses')} moduleId={id} paramId="pulses" readLive={live('pulses')} />
            <NeonFader value={spread} min={4} max={25} defaultValue={defaultFor('spread')} label="Sprd" units="ms" curve="log"      onchange={set('spread')} moduleId={id} paramId="spread" readLive={live('spread')} />
            <NeonFader value={snap}   min={0} max={1}  defaultValue={defaultFor('snap')}   label="Snap"           curve="linear"   onchange={set('snap')}   moduleId={id} paramId="snap"   readLive={live('snap')} />
          </div>
        </div>
        <div class="group">
          <header>NOISE</header>
          <div class="fader-row">
            <NeonFader value={tone}  min={400} max={3000} defaultValue={defaultFor('tone')}  label="Tone" units="Hz" curve="log"    onchange={set('tone')}  moduleId={id} paramId="tone"  readLive={live('tone')} />
            <NeonFader value={width} min={0}   max={1}    defaultValue={defaultFor('width')} label="Wdth"           curve="linear" onchange={set('width')} moduleId={id} paramId="width" readLive={live('width')} />
            <NeonFader value={color} min={0}   max={1}    defaultValue={defaultFor('color')} label="Col"            curve="linear" onchange={set('color')} moduleId={id} paramId="color" readLive={live('color')} />
          </div>
        </div>
        <div class="group wide">
          <header>ROOM · OUT</header>
          <div class="fader-row">
            <NeonFader value={tail}  min={30}  max={800} defaultValue={defaultFor('tail')}  label="Tail" units="ms" curve="log"    onchange={set('tail')}  moduleId={id} paramId="tail"  readLive={live('tail')} />
            <NeonFader value={drive} min={0}   max={1}   defaultValue={defaultFor('drive')} label="Drv"             curve="linear" onchange={set('drive')} moduleId={id} paramId="drive" readLive={live('drive')} />
            <NeonFader value={level} min={-24} max={12}  defaultValue={defaultFor('level')} label="Lvl"  units="dB" curve="linear" onchange={set('level')} moduleId={id} paramId="level" readLive={live('level')} />
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

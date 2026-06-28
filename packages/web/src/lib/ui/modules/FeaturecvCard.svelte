<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { setNodeParam } from '$lib/graph/mutate';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import type { FeaturecvSnapshot } from '$lib/audio/modules/featurecv';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  function param(id_: string, fallback: number): number {
    const v = node?.params?.[id_];
    return typeof v === 'number' ? v : fallback;
  }
  const set = (id_: string) => (v: number) => setNodeParam(id, id_, v);
  const live = (id_: string) => () => {
    const e = engineCtx.get();
    if (!e || !node) return undefined;
    return e.readParam(node, id_);
  };

  // POLARITY of the feature CV outputs: BI = bipolar [-1,+1] (default), UNI =
  // unipolar [0,1]. Reactive so the badge follows the param.
  let bipolar = $derived(Math.round(param('bipolar', 1)));
  const isBipolar = (): boolean => bipolar === 1;
  function togglePolarity(): void {
    set('bipolar')(bipolar === 1 ? 0 : 1);
  }

  // All ports live in the shared yellow drill-down <PatchPanel> (the post-#767
  // standard — no raw side <Handle> jacks).
  const inputs: PortDescriptor[] = [{ id: 'in', label: 'IN', cable: 'audio' }];
  const outputs: PortDescriptor[] = [
    { id: 'loud', label: 'LOUD', cable: 'cv' },
    { id: 'bright', label: 'BRIGHT', cable: 'cv' },
    { id: 'punch', label: 'PUNCH', cable: 'cv' },
    { id: 'onset', label: 'ONSET', cable: 'gate' },
  ];

  // ---- Display meters (snapshot-driven; NEVER writes the live Y.Doc) ----
  // The worklet posts UNIPOLAR feature levels (0..1) + an onset flag; we just
  // mirror them to the bars/blink each rAF. Pure read — render-local state only.
  let mLoud = $state(0);
  let mBright = $state(0);
  let mPunch = $state(0);
  let onsetGlow = $state(0);
  let raf: number | null = null;

  $effect(() => {
    function tick(): void {
      const e = engineCtx.get();
      if (e && node) {
        const snap = e.read(node, 'snapshot') as FeaturecvSnapshot | undefined;
        if (snap) {
          mLoud = snap.loud;
          mBright = snap.bright;
          mPunch = snap.punch;
          // Onset is a brief flag; decay a soft glow so a single hit is visible.
          if (snap.onset > 0.5) onsetGlow = 1;
          else onsetGlow = Math.max(0, onsetGlow - 0.08);
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

  const pct = (v: number): string => `${Math.max(0, Math.min(1, v)) * 100}%`;
</script>

<div class="mod-card featurecv-card" data-testid="featurecv-card">
  <div class="stripe" style="background: var(--cable-cv, #f59e0b);"></div>
  <ModuleTitle {id} {data} defaultLabel="FEATURE CV" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="body">
      <!-- Feature meters (display only). -->
      <div class="meters" data-testid="featurecv-meters">
        <div class="meter-row">
          <span class="meter-label">LOUD</span>
          <div class="bar"><div class="fill loud" style:width={pct(mLoud)}></div></div>
        </div>
        <div class="meter-row">
          <span class="meter-label">BRIGHT</span>
          <div class="bar"><div class="fill bright" style:width={pct(mBright)}></div></div>
        </div>
        <div class="meter-row">
          <span class="meter-label">PUNCH</span>
          <div class="bar"><div class="fill punch" style:width={pct(mPunch)}></div></div>
        </div>
        <div class="meter-row">
          <span class="meter-label">ONSET</span>
          <div class="onset-led" class:lit={onsetGlow > 0.05} style:opacity={0.25 + 0.75 * onsetGlow}></div>
        </div>
      </div>

      <div class="controls">
        <Knob value={param('gain', 1)} min={0.25} max={4} defaultValue={1} label="GAIN"
          curve="log" onchange={set('gain')} moduleId={id} paramId="gain" readLive={live('gain')} />
        <Knob value={param('attack', 10)} min={0.5} max={500} defaultValue={10} label="ATK"
          curve="log" onchange={set('attack')} moduleId={id} paramId="attack" readLive={live('attack')} />
        <Knob value={param('release', 100)} min={1} max={2000} defaultValue={100} label="REL"
          curve="log" onchange={set('release')} moduleId={id} paramId="release" readLive={live('release')} />
      </div>
      <div class="controls">
        <button
          type="button"
          class="polarity-toggle"
          class:bipolar={isBipolar()}
          data-testid="featurecv-polarity"
          data-polarity={isBipolar() ? 'bi' : 'uni'}
          onclick={togglePolarity}
          title="Feature CV polarity: BI [-1,+1] (default) or UNI [0,1]"
        >{isBipolar() ? 'BI' : 'UNI'}</button>
        <Knob value={param('onset_sens', 0.5)} min={0} max={1} defaultValue={0.5} label="SENS"
          curve="linear" onchange={set('onset_sens')} moduleId={id} paramId="onset_sens" readLive={live('onset_sens')} />
        <Knob value={param('onset_debounce', 80)} min={20} max={1000} defaultValue={80} label="DEBNCE"
          curve="log" onchange={set('onset_debounce')} moduleId={id} paramId="onset_debounce" readLive={live('onset_debounce')} />
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .featurecv-card {
    width: 260px;
    min-height: 220px;
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 10px 16px;
  }
  .meters {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .meter-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .meter-label {
    width: 48px;
    font-size: 0.5rem;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
    letter-spacing: 0.06em;
  }
  .bar {
    position: relative;
    flex: 1;
    height: 8px;
    border: 1px solid var(--border);
    border-radius: 2px;
    background: #0c0e12;
    overflow: hidden;
  }
  .fill {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    border-radius: 2px;
  }
  .fill.loud { background: var(--cable-cv, #f59e0b); }
  .fill.bright { background: #38bdf8; }
  .fill.punch { background: #f472b6; }
  .onset-led {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--cable-gate, #22c55e);
    box-shadow: 0 0 4px var(--cable-gate, #22c55e);
  }
  .onset-led.lit {
    box-shadow: 0 0 8px var(--cable-gate, #22c55e);
  }
  .controls {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 14px;
  }
  .polarity-toggle {
    font-size: 0.55rem;
    font-family: ui-monospace, monospace;
    letter-spacing: 0.04em;
    padding: 2px 6px;
    border: 1px solid var(--border);
    border-radius: 3px;
    background: #0c0e12;
    color: var(--text-dim);
    cursor: pointer;
    width: 52px;
    text-align: center;
  }
  .polarity-toggle.bipolar {
    color: var(--cable-cv, #f59e0b);
    border-color: var(--cable-cv, #f59e0b);
    box-shadow: 0 0 4px var(--cable-cv, #f59e0b);
  }
</style>

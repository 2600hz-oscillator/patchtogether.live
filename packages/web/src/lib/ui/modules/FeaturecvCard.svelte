<script lang="ts">
  // ⚠ EVERY RANGE, CURVE, UNIT **AND LABEL** IS BOUND TO THE DEF (`paramSpec`),
  // NEVER RE-TYPED — #1746, paid rather than deferred because promotion is what
  // makes the divergence user-visible. All five of this card's numeric props
  // AGREED with the def and all five of its `label`s DISAGREED:
  //
  //     gain            def 'Gain'    card 'GAIN'
  //     attack          def 'Atk'     card 'ATK'
  //     release         def 'Rel'     card 'REL'
  //     onset_sens      def 'Sens'    card 'SENS'
  //     onset_debounce  def 'Debnce'  card 'DEBNCE'
  //
  // All five were already sitting in `VOCABULARY_DEBT` (card-def-debt.ts), and
  // a face PR IS that ledger's release condition: `ModuleShell` renders the
  // dock full-view straight off the `ParamDef`, so shipping the face without
  // binding labels would rename five controls with nobody reviewing it. The
  // five entries are DELETED, not re-worded (CLAUDE.md: when debt is paid,
  // delete the mechanism); what guards it now is the unconditional
  // `unledgered(...) === []` clause plus RANGE_BOUND_CARDS + MAPPING_BOUND_CARDS.
  //
  // ⚠ NONE OF IT MOVES A PIXEL AT REST, and that is worth stating rather than
  // shrugging at, because it is exactly why five entries sat unpaid for two
  // weeks. The five label divergences were pure CASE and `Knob.svelte`'s
  // `.label` is `text-transform: uppercase`; the three `units` props are NEW
  // (the def has always declared `ms` and this card passed none) but a Knob
  // renders its value readout only inside `{#if dragging || hovering}`, so a
  // VRT capture never sees a unit either way. **A card/def divergence with no
  // pixel symptom is still a second copy of a name, and it is the second copy
  // that drifts** — the dock renders the DEF's label, and from promotion onward
  // that is the name a user learns.
  //
  // ⚠ THE METERS BELOW DISAGREE WITH THE JACKS THEY NAME (#1747), which is why
  // the FACEPLATE does not reproduce them: the worklet's `snapshot` carries the
  // extractor's UNSMOOTHED, always-UNIPOLAR target, so the PUNCH bar reads
  // 0.145 where the PUNCH jack sits at −0.703 at the shipped BIPOLAR default,
  // and no ATTACK or RELEASE setting moves a bar at all. Filed rather than
  // fixed here — the fix changes what a player watches while the module runs.
  import { onDestroy } from 'svelte';
  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import { featurecvDef, type FeaturecvSnapshot } from '$lib/audio/modules/featurecv';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, paramSpec } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();
  const { paramVal, set, live } = cardParams(featurecvDef, () => id, () => node);

  /** THE ONE COPY of every number, curve, unit and label this card paints. */
  const P = {
    gain: paramSpec(featurecvDef, 'gain'),
    attack: paramSpec(featurecvDef, 'attack'),
    release: paramSpec(featurecvDef, 'release'),
    onset_sens: paramSpec(featurecvDef, 'onset_sens'),
    onset_debounce: paramSpec(featurecvDef, 'onset_debounce'),
  };

  // POLARITY of the feature CV outputs: BI = bipolar [-1,+1] (default), UNI =
  // unipolar [0,1]. Reactive so the badge follows the param.
  let bipolar = $derived(Math.round(paramVal('bipolar')));
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
        <Knob value={paramVal('gain')} min={P.gain.min} max={P.gain.max} defaultValue={P.gain.defaultValue}
          label={P.gain.label} units={P.gain.units} curve={P.gain.curve}
          onchange={set('gain')} moduleId={id} paramId="gain" readLive={live('gain')} />
        <Knob value={paramVal('attack')} min={P.attack.min} max={P.attack.max} defaultValue={P.attack.defaultValue}
          label={P.attack.label} units={P.attack.units} curve={P.attack.curve}
          onchange={set('attack')} moduleId={id} paramId="attack" readLive={live('attack')} />
        <Knob value={paramVal('release')} min={P.release.min} max={P.release.max} defaultValue={P.release.defaultValue}
          label={P.release.label} units={P.release.units} curve={P.release.curve}
          onchange={set('release')} moduleId={id} paramId="release" readLive={live('release')} />
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
        <Knob value={paramVal('onset_sens')} min={P.onset_sens.min} max={P.onset_sens.max}
          defaultValue={P.onset_sens.defaultValue} label={P.onset_sens.label} units={P.onset_sens.units}
          curve={P.onset_sens.curve}
          onchange={set('onset_sens')} moduleId={id} paramId="onset_sens" readLive={live('onset_sens')} />
        <Knob value={paramVal('onset_debounce')} min={P.onset_debounce.min} max={P.onset_debounce.max}
          defaultValue={P.onset_debounce.defaultValue} label={P.onset_debounce.label}
          units={P.onset_debounce.units} curve={P.onset_debounce.curve}
          onchange={set('onset_debounce')} moduleId={id} paramId="onset_debounce" readLive={live('onset_debounce')} />
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

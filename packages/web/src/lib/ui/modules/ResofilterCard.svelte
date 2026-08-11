<script lang="ts">
  // ResofilterCard — multi-mode filter UI (Resonarium MultiFilter port).
  //
  // Layout:
  //   [ CUTOFF ]  [ RESO ]   [ MODE ]    [ MIX ]
  //                          ◐ "Low-pass"
  //                          ↑ the user-requested feature: a text label
  //                          next to the MODE knob displays the long-form
  //                          name of the currently selected mode and
  //                          updates reactively as the knob (or its CV /
  //                          MIDI Learn target) changes.
  //
  // Patch panel:
  //   inputs: AUDIO, CUTOFF, RESO
  //   outputs: L, R

  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import OssAttribution from '$lib/ui/modules/OssAttribution.svelte';
  import ModuleTitle from './ModuleTitle.svelte';
  import {
    resofilterDef,
    RESOFILTER_MODE_NAMES,
    RESOFILTER_MAX_MODE,
    type ResofilterMode,
  } from '$lib/audio/modules/resofilter';
  import type { ModuleNode } from '$lib/graph/types';
  import { cardParams, paramSpec, portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { set, live } = cardParams(resofilterDef, () => id, () => node);

  // ⚠ THE RANGES COME FROM THE DEF, ONCE. Every `min`/`max`/`defaultValue`
  // below used to be re-typed here — 0 and 1 four times over, plus the cutoff
  // pair reached for through an inline `.find()` — which is the backdraft
  // divergence class in its latent form: a card whose control writes values its
  // own def forbids is invisible to `contract-lock`, to `module-docs-lint` and
  // to every range assertion in the repo, because all of them read the DEF.
  // Enrolled in RANGE_BOUND_CARDS *and* MAPPING_BOUND_CARDS so a re-typed
  // literal is a source-level failure rather than a thing someone notices.
  //
  // ⚠ ONE OF THE FOUR BOUND CURVES BELOW CHANGES NOTHING THAT RENDERS, AND
  // SAYING SO IS THE POINT. MODE used to hand-type a linear curve where the def
  // declares `discrete`; it now passes the def's own value, which makes the
  // card and the def agree — but `Knob.svelte` branches on `log` and `exp`
  // only, so `discrete` falls straight through to the linear mapping and not a
  // pixel moves. This is CLAUDE.md's "before fixing a declaration to satisfy a
  // gate, check the consumer reads it": the binding removes a SECOND COPY of a
  // def field, which is real, and it does NOT make MODE a detented control,
  // which would need the primitive to change.
  //
  // (The literal is spelled out in prose rather than quoted because
  // `card-range-source`'s LITERAL_MAPPING grep is LINE-BASED and does not skip
  // comments — a quoted example in a comment reddens it. That is the safe
  // direction for a source grep to be wrong in, so it is recorded here rather
  // than worked around in the gate.)
  //
  // The honest repair for that is the five-state Segmented the def now declares
  // `options` for — which is what the DOCK FACEPLATE renders. It is not done
  // here because it moves this card's pixels: #1213 measured 865 px for exactly
  // this swap on `filter`, which is UNDER `DOCK_MAX_DIFF` and therefore both
  // invisible to the VRT gate and unrepinnable by `--update-snapshots`. It
  // wants its own PR, an owner preview, and a `git rm` of the baseline first.
  const P = (pid: string) => paramSpec(resofilterDef, pid);

  const defaultFor = (pid: string): number => P(pid).defaultValue;

  function paramVal(k: string): number {
    const v = node?.params?.[k];
    return typeof v === 'number' ? v : defaultFor(k);
  }


  function clampMode(v: number): ResofilterMode {
    const r = Math.round(v);
    if (r < 0) return 0;
    if (r > RESOFILTER_MAX_MODE) return RESOFILTER_MAX_MODE as ResofilterMode;
    return r as ResofilterMode;
  }

  // The mode-name label — the headline feature of this card. Tracks the
  // live `mode` param value (whether set by the user, CV, or MIDI Learn).
  let modeIdx = $derived(clampMode(paramVal('mode')));
  let modeName = $derived(RESOFILTER_MODE_NAMES[modeIdx]);

  const inputs = portsFromDef(resofilterDef.inputs, { cutoff_cv: 'CUTOFF', reso_cv: 'RESO' });
  const outputs = portsFromDef(resofilterDef.outputs, { out_l: 'OUT L', out_r: 'OUT R' });
</script>

<div class="mod-card resofilter-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <ModuleTitle {id} {data} defaultLabel="RESOFILTER" />

  <PatchPanel nodeId={id} {inputs} {outputs} panelWidth={340}>
    <div class="rf-body">
      <div class="knobs">
        <Knob
          value={paramVal('cutoff')}
          min={P('cutoff').min}
          max={P('cutoff').max}
          defaultValue={defaultFor('cutoff')}
          label="Cutoff"
          units={P('cutoff').units}
          curve={P('cutoff').curve}
          onchange={set('cutoff')}
          moduleId={id}
          paramId="cutoff"
          readLive={live('cutoff')}
        />
        <Knob
          value={paramVal('resonance')}
          min={P('resonance').min}
          max={P('resonance').max}
          defaultValue={defaultFor('resonance')}
          label="Reso"
          curve={P('resonance').curve}
          onchange={set('resonance')}
          moduleId={id}
          paramId="resonance"
          readLive={live('resonance')}
        />
        <div class="mode-group" data-testid="resofilter-mode-group">
          <Knob
            value={paramVal('mode')}
            min={P('mode').min}
            max={P('mode').max}
            defaultValue={defaultFor('mode')}
            label="Mode"
            curve={P('mode').curve}
            onchange={set('mode')}
            moduleId={id}
            paramId="mode"
            readLive={live('mode')}
          />
          <div class="mode-name" data-testid="resofilter-mode-name">{modeName}</div>
        </div>
        <Knob
          value={paramVal('mix')}
          min={P('mix').min}
          max={P('mix').max}
          defaultValue={defaultFor('mix')}
          label="Mix"
          curve={P('mix').curve}
          onchange={set('mix')}
          moduleId={id}
          paramId="mix"
          readLive={live('mix')}
        />
      </div>
    </div>
  </PatchPanel>

  <OssAttribution text="Multi-mode filter ported from gabrielsoule/resonarium (MultiFilter)" />
</div>

<style>
  .resofilter-card {
    width: 340px;
    background: var(--resofilter-bg, #16181f);
    color: #ece8e2;
  }
  .rf-body {
    padding: 6px 10px 4px;
  }
  .knobs {
    display: flex;
    gap: 14px;
    align-items: flex-end;
    justify-content: space-between;
  }
  .mode-group {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    /* Make sure the name label is roomy enough for "Band-pass" / "High-pass". */
    min-width: 72px;
  }
  .mode-name {
    font-family: var(--font-mono, monospace);
    font-size: 0.62rem;
    letter-spacing: 0.02em;
    color: #ffce6e;
    text-align: center;
    /* The label is the headline feature — keep it visible even when the
       card is narrow. ellipsizes only on truly extreme overflow. */
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
  }
</style>

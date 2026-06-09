<script lang="ts">
  // StagesCard — 6-segment cascadable function generator (Mutable
  // Instruments Stages archetype). Six column strips, each with:
  //   - TYPE button (cycles RAMP / HOLD / STEP)
  //   - primary fader (TIME for RAMP, LEVEL for HOLD/STEP)
  //   - secondary SHAPE fader (also acts as portamento for HOLD/STEP)
  // Plus 5 LINK toggles between adjacent columns; click to chain the
  // adjacent segments into one multi-stage envelope. All ports live on
  // the PatchPanel: per-segment GATE in + per-segment CV out + global TRIG.
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import OssAttribution from '$lib/ui/modules/OssAttribution.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { setNodeParam } from '$lib/graph/mutate';
  import {
    stagesDef,
    stagesMath,
    STAGES_NUM_SEGMENTS,
    STAGES_NUM_LINKS,
    STAGES_TYPE_NAMES,
    STAGES_NUM_TYPES,
  } from '$lib/audio/modules/stages';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  function defaultFor(k: string): number {
    return stagesDef.params.find((p) => p.id === k)?.defaultValue ?? 0;
  }
  function paramVal(k: string, fallback?: number): number {
    const v = node?.params?.[k];
    if (typeof v === 'number') return v;
    return fallback ?? defaultFor(k);
  }
  const set = (k: string) => (v: number) => {
    setNodeParam(id, k, v);
  };
  const live = (k: string) => () => {
    const e = engineCtx.get(); if (!e || !node) return undefined;
    return e.readParam(node, k);
  };

  function clampType(v: number): number {
    return Math.max(0, Math.min(STAGES_NUM_TYPES - 1, Math.round(v)));
  }
  function cycleType(seg: number): void {
    const k = `type${seg}`;
    const cur = clampType(paramVal(k));
    const next = (cur + 1) % STAGES_NUM_TYPES;
    setNodeParam(id, k, next);
  }
  function toggleLink(idx: number): void {
    const k = `link${idx}`;
    setNodeParam(id, k, (paramVal(k) >= 0.5) ? 0 : 1);
  }

  const segments = Array.from({ length: STAGES_NUM_SEGMENTS }, (_, i) => i);
  const linkIdxs = Array.from({ length: STAGES_NUM_LINKS }, (_, i) => i);

  // Ports: per-segment GATE + per-segment CV-OUT, plus a global TRIG +
  // per-segment CV inputs for the primary + shape knobs.
  const inputs: PortDescriptor[] = [
    { id: 'trig', label: 'TRIG', cable: 'gate' },
    ...segments.map((i) => ({ id: `gate${i}`, label: `GATE ${i + 1}`, cable: 'gate' as const })),
    ...segments.flatMap((i) => [
      { id: `primary${i}_cv`, label: `P${i + 1} CV`, cable: 'cv' as const },
      { id: `shape${i}_cv`,   label: `S${i + 1} CV`, cable: 'cv' as const },
    ]),
  ];
  const outputs: PortDescriptor[] = segments.map((i) => ({
    id: `out${i}`, label: `OUT ${i + 1}`, cable: 'cv' as const,
  }));
</script>

<div class="mod-card stages-card">
  <div class="stripe" style="background: var(--cable-cv);"></div>
  <ModuleTitle {id} {data} defaultLabel="STAGES" />

  <PatchPanel nodeId={id} {inputs} {outputs} panelWidth={420}>
    <div class="segments">
      {#each segments as seg (seg)}
        <div class="segment">
          <button
            type="button"
            class="type-btn type-{clampType(paramVal(`type${seg}`))}"
            data-testid={`stages-type${seg}`}
            onclick={() => cycleType(seg)}
            title="Click to cycle: RAMP / HOLD / STEP"
          >
            {STAGES_TYPE_NAMES[clampType(paramVal(`type${seg}`))]}
          </button>
          <Fader
            value={paramVal(`primary${seg}`, 0.3)}
            min={-1} max={1}
            defaultValue={defaultFor(`primary${seg}`)}
            label={stagesMath.knobLabels(clampType(paramVal(`type${seg}`))).primary}
            curve="linear"
            onchange={set(`primary${seg}`)} moduleId={id} paramId={`primary${seg}`}
            readLive={live(`primary${seg}`)}
          />
          <Fader
            value={paramVal(`shape${seg}`, 0.5)}
            min={0} max={1}
            defaultValue={defaultFor(`shape${seg}`)}
            label={stagesMath.knobLabels(clampType(paramVal(`type${seg}`))).shape}
            curve="linear"
            onchange={set(`shape${seg}`)} moduleId={id} paramId={`shape${seg}`}
            readLive={live(`shape${seg}`)}
          />
        </div>
        {#if seg < STAGES_NUM_SEGMENTS - 1}
          <button
            type="button"
            class="link-toggle"
            class:linked={paramVal(`link${linkIdxs[seg]}`) >= 0.5}
            data-testid={`stages-link${linkIdxs[seg]}`}
            onclick={() => toggleLink(linkIdxs[seg])}
            title="Link adjacent segments into one chain"
            aria-label={paramVal(`link${linkIdxs[seg]}`) >= 0.5 ? 'Linked' : 'Unlinked'}
          >{paramVal(`link${linkIdxs[seg]}`) >= 0.5 ? '—' : '·'}</button>
        {/if}
      {/each}
    </div>
  </PatchPanel>
  <OssAttribution author={stagesDef.ossAttribution?.author} />
</div>

<style>
  .stages-card { width: 460px; }
  .stages-card .title {
    font-family: var(--font-display, inherit);
    font-size: 0.85rem;
    letter-spacing: 0.04em;
  }
  .stages-card .segments {
    display: flex;
    align-items: stretch;
    gap: 2px;
    padding: 12px 14px 0;
    justify-content: space-between;
  }
  .stages-card .segment {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 5px;
    flex: 1 1 0;
  }
  .stages-card .type-btn {
    width: 100%;
    border: 1px solid var(--border, #555);
    background: var(--bg-elevated, #1a1a1a);
    color: var(--text, #eee);
    padding: 3px 4px;
    font-family: var(--font-display, monospace);
    font-size: 0.62rem;
    letter-spacing: 0.06em;
    cursor: pointer;
  }
  .stages-card .type-btn.type-0 { border-color: var(--cable-cv, #4af); }
  .stages-card .type-btn.type-1 { border-color: var(--cable-gate, #f80); }
  .stages-card .type-btn.type-2 { border-color: var(--cable-audio, #fc0); }
  .stages-card .type-btn:hover { background: var(--bg-hover, #2a2a2a); }
  .stages-card .link-toggle {
    align-self: center;
    width: 14px;
    height: 14px;
    margin-top: 18px;
    padding: 0;
    border: 1px solid var(--border-dim, #444);
    border-radius: 3px;
    background: var(--surface-deep, #1a1a1a);
    color: var(--text-dim, #888);
    cursor: pointer;
    font-size: 9px;
    font-family: var(--font-mono, monospace);
    line-height: 1;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .stages-card .link-toggle:hover {
    color: var(--text, #ddd);
    border-color: var(--text-dim, #888);
  }
  .stages-card .link-toggle.linked {
    color: var(--cable-cv, #4af);
    border-color: var(--cable-cv, #4af);
    background: var(--cable-cv, #4af);
    color: #000;
  }
</style>

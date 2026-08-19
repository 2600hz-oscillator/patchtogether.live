<script lang="ts">
  // MOOG 911 ENVELOPE GENERATOR card — the Moog System 55/35 contour
  // generator's faceplate (Fig 17). Four knobs: T1 (attack), T2 (initial
  // decay), ESUS (sustain level), T3 (final decay); a TRIGGER input jack;
  // and the OUTPUT (envelope CV) + inverted-output jacks in the patch panel.
  //
  // Uses the SHARED beige <MoogPanel> wrapper (re-bound control palette) so
  // the stock Knob / PatchPanel controls inherit the Moog-era look — same
  // reuse contract the 921 VCO card follows.
  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { setNodeParam } from '$lib/graph/mutate';
  import { moog911Def } from '$lib/audio/modules/moog911';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import MoogPanel from './moog/MoogPanel.svelte';
  import { paramSpec, portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  const engineCtx = useEngine();

  // Every knob carries its own ParamDef rather than re-typed literals. This
  // card hand-typed `min={0.0001} max={10} defaultValue={0.01}` on all four,
  // and `moog911` was outside RANGE_BOUND_CARDS, so nothing in the tree could
  // have SEEN a divergence open up. The four agreed with the def today — which
  // is exactly the AnalogLogicMathsCard case already in that list, and exactly
  // the state SwolevcoCard was in the day before one of its labels diverged.
  // From promotion the DOCK renders these controls straight off the ParamDef
  // while this card renders off its own literals, so a later edit to one side
  // would ship two surfaces calling one control two different things. Binding
  // the def forecloses the numbers, the units and the names in one edit.
  const P = {
    t1: paramSpec(moog911Def, 't1'),
    t2: paramSpec(moog911Def, 't2'),
    esus: paramSpec(moog911Def, 'esus'),
    t3: paramSpec(moog911Def, 't3'),
  } as const;
  // The panel's two physical rows: contour TIMES on top, LEVEL + release below
  // (the hardware's layout, and deliberately NOT the face's priority order —
  // the face ranks by what a player reaches for, this card mirrors Fig 17).
  const ROWS: readonly (readonly (keyof typeof P)[])[] = [
    ['t1', 't2'],
    ['esus', 't3'],
  ];

  function paramVal(key: keyof typeof P): number {
    const v = node?.params[P[key].id];
    return typeof v === 'number' ? v : P[key].defaultValue;
  }
  function setParam(paramId: string) {
    return (v: number) => setNodeParam(id, paramId, v);
  }
  function readLive(paramId: string) {
    return () => {
      const eng = engineCtx.get();
      if (!eng || !node) return undefined;
      return eng.readParam(node, paramId);
    };
  }

  const inputs = portsFromDef(moog911Def.inputs, {
    gate: 'TRIG', t1_cv: 'T1', t2_cv: 'T2', esus_cv: 'ESUS', t3_cv: 'T3',
  });
  const outputs = portsFromDef(moog911Def.outputs, { env: 'OUT', env_inv: 'INV' });
</script>

<MoogPanel {id} {data} defaultLabel="911 EG" width={232}>
  <PatchPanel nodeId={id} {inputs} {outputs}>
    {#each ROWS as row, i (i)}
      <div class="knob-row" data-testid={i === 0 ? 'moog911-time-row' : undefined}>
        {#each row as key (key)}
          <Knob
            value={paramVal(key)}
            min={P[key].min}
            max={P[key].max}
            defaultValue={P[key].defaultValue}
            label={P[key].label ?? P[key].id}
            units={P[key].units ?? ''}
            curve={P[key].curve}
            onchange={setParam(P[key].id)}
            moduleId={id}
            paramId={P[key].id}
            readLive={readLive(P[key].id)}
          />
        {/each}
      </div>
    {/each}
  </PatchPanel>
</MoogPanel>

<style>
  .knob-row {
    display: flex;
    gap: 14px;
    padding: 8px 18px 4px;
    justify-content: center;
  }
</style>

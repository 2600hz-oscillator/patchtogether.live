<script lang="ts">
  // MOOG 984 4-CHANNEL MATRIX MIXER card — the patch-bay router of the Moog
  // System 55/35 clone family. Laid out as the matrix itself: a 4×4 grid of
  // cross-point level knobs (rows = inputs IN 1..4, columns = outputs
  // OUT 1..4), the four input jacks down the left of the patch panel, and the
  // four summed-bus output jacks down the right.
  //
  // Uses the SHARED beige <MoogPanel> wrapper (re-bound control palette) so the
  // stock Knob / PatchPanel controls inherit the Moog-era look — same pattern
  // as MoogCp3MixerCard / Moog921aCard.
  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { setNodeParam } from '$lib/graph/mutate';
  import { moog984Def } from '$lib/audio/modules/moog984';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import MoogPanel from './moog/MoogPanel.svelte';
  import { portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  const engineCtx = useEngine();

  function def(pid: string) {
    return moog984Def.params.find((p) => p.id === pid)!;
  }

  // Live cross-point values keyed by param id (m11..m44). Re-derives whenever
  // the node's params change.
  let values = $derived.by(() => {
    const out: Record<string, number> = {};
    for (const p of moog984Def.params) {
      out[p.id] = node?.params[p.id] ?? def(p.id).defaultValue;
    }
    return out;
  });

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

  // Row = input (1..4), column = output (1..4); cross-point id = `m${i}${j}`.
  const ROWS = [1, 2, 3, 4];
  const COLS = [1, 2, 3, 4];
  const cellId = (i: number, j: number) => `m${i}${j}`;

  const inputs = portsFromDef(moog984Def.inputs, {
    in1: 'IN 1', in2: 'IN 2', in3: 'IN 3', in4: 'IN 4',
  });
  const outputs = portsFromDef(moog984Def.outputs, {
    out1: 'OUT 1', out2: 'OUT 2', out3: 'OUT 3', out4: 'OUT 4',
  });
</script>

<MoogPanel {id} {data} defaultLabel="984 Matrix" width={300}>
  <PatchPanel nodeId={id} {inputs} {outputs}>
    <!-- 4×4 cross-point matrix: rows = inputs, columns = outputs. A leading
         header row labels the output columns; each row is prefixed with its
         input label. -->
    <div class="matrix" data-testid="moog984-matrix">
      <span class="corner"></span>
      {#each COLS as j (j)}
        <span class="col-head">O{j}</span>
      {/each}

      {#each ROWS as i (i)}
        <span class="row-head">I{i}</span>
        {#each COLS as j (j)}
          {@const pid = cellId(i, j)}
          <div class="cell" data-cross={pid}>
            <Knob
              value={values[pid]}
              min={0}
              max={1}
              defaultValue={0}
              label={`${i}→${j}`}
              curve="linear"
              onchange={setParam(pid)}
              moduleId={id}
              paramId={pid}
              readLive={readLive(pid)}
            />
          </div>
        {/each}
      {/each}
    </div>
  </PatchPanel>
</MoogPanel>

<style>
  .matrix {
    display: grid;
    grid-template-columns: auto repeat(4, 1fr);
    align-items: center;
    justify-items: center;
    gap: 6px 10px;
    padding: 8px 16px 6px;
  }
  .corner {
    /* empty top-left cell */
  }
  .col-head,
  .row-head {
    font-size: 0.6rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    color: var(--text-dim);
  }
  .row-head {
    justify-self: end;
    padding-right: 2px;
  }
  .cell {
    display: flex;
    align-items: center;
    justify-content: center;
  }
</style>

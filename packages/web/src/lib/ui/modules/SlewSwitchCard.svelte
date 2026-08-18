<script lang="ts">
  // SlewSwitchCard — quad slew limiter + 4→1 sequential CV switch.
  // PatchPanel-style port layout (mirrors AttenumixCard / IllogicCard).
  // 4 channel strips (each with a slew-time fader), plus mode/length/xfade
  // knobs in a small column below.
  //
  // ⚠ EVERY RANGE, CURVE, UNIT, LABEL AND DETENT NAME IS BOUND TO THE DEF
  // (`paramSpec`), NEVER RE-TYPED — the #1681 rule. Two divergences were live
  // here before the Q14 faceplate audit, and both are the kind a def-reading
  // gate cannot see:
  //
  //   * the four slew faders printed `Slew 1`..`Slew 4` while the def declares
  //     `S1`..`S4`. The DOCK RENDERS THE DEF'S LABEL, so promotion would have
  //     silently renamed all four controls out from under anyone who had
  //     learned the card. The def's names win: they already match this card's
  //     own `S1 CV`..`S4 CV` jack labels, so binding removes the divergence in
  //     the direction that leaves ONE vocabulary on both surfaces.
  //   * the mode/length captions (`['→ FWD', '⇄ PND', '? RND']`, `LEN n`) were
  //     hardcoded HERE, in markup the migrated shell cannot read. They now live
  //     on the def as `ParamDef.options` and this card renders THAT roster, so
  //     the dock's Segmented row and this card's buttons cannot drift apart.
  //
  // The ranges agreed already (0.001..5, 0.001..2) — they were re-typed rather
  // than wrong, which is the state the rule exists to catch BEFORE it becomes
  // the analogVco backdraft.

  import type { NodeProps } from '@xyflow/svelte';
  import NeonFader from '$lib/ui/controls/NeonFader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { slewSwitchDef } from '$lib/audio/modules/slewswitch';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, paramSpec, portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { paramVal, set, live } = cardParams(slewSwitchDef, () => id, () => node);

  /** THE ONE COPY of every number, curve, unit, label and detent name. */
  const P = {
    slew1:     paramSpec(slewSwitchDef, 'slew1'),
    slew2:     paramSpec(slewSwitchDef, 'slew2'),
    slew3:     paramSpec(slewSwitchDef, 'slew3'),
    slew4:     paramSpec(slewSwitchDef, 'slew4'),
    mode:      paramSpec(slewSwitchDef, 'mode'),
    length:    paramSpec(slewSwitchDef, 'length'),
    xfadeTime: paramSpec(slewSwitchDef, 'xfadeTime'),
  };
  const slews = [P.slew1, P.slew2, P.slew3, P.slew4] as const;

  const inputs = portsFromDef(slewSwitchDef.inputs, {
    in1: 'IN 1', in2: 'IN 2', in3: 'IN 3', in4: 'IN 4', step_clock: 'CLK', reset: 'RST',
    slew1_cv: 'S1 CV', slew2_cv: 'S2 CV', slew3_cv: 'S3 CV', slew4_cv: 'S4 CV',
  });
  const outputs = portsFromDef(slewSwitchDef.outputs, {
    out1: 'OUT 1', out2: 'OUT 2', out3: 'OUT 3', out4: 'OUT 4', switched: 'SW',
    step_idx: 'IDX',
  });

  /** Step to the next detent of a DECLARED roster, wrapping. The roster is the
   *  def's, so "how many states are there" is never a number typed here.
   *
   *  ⚠ WRITES THROUGH `set()` (i.e. `setNodeParam`), NOT through
   *  `patch.nodes[id].params.x = v`. Both buttons used to write the Y.Doc
   *  directly, which is why this card carried a named `raw-write-ledger` DEBT
   *  entry — a user gesture that was neither undoable nor synced. It is paid
   *  here rather than re-worded, and the ledger entry is deleted. */
  function cycle(p: typeof P.mode) {
    const roster = p.options ?? [];
    if (roster.length === 0) return;
    const cur = paramVal(p.id);
    const i = roster.findIndex((o) => o.value === cur);
    set(p.id)(roster[(i + 1) % roster.length]!.value);
  }
  /** The declared caption for the param's CURRENT value — the same roster the
   *  dock's Segmented row paints. Falls back to the raw number rather than to a
   *  guess, so an out-of-roster value is visible instead of mislabelled. */
  function caption(p: typeof P.mode, v: number): string {
    return p.options?.find((o) => o.value === v)?.label ?? String(v);
  }
  let modeLabel = $derived(caption(P.mode, paramVal('mode')));
  let lenLabel = $derived(`LEN ${caption(P.length, paramVal('length'))}`);
</script>

<div class="mod-card slewswitch-card">
  <div class="stripe" style="background: var(--cable-cv);"></div>
  <ModuleTitle {id} {data} defaultLabel="SLEWSWITCH" />

  <PatchPanel nodeId={id} {inputs} {outputs} panelWidth={300}>
    <div class="body">
      <div class="strips">
        {#each slews as p (p.id)}
          <div class="strip">
            <NeonFader
              value={paramVal(p.id)}
              min={p.min} max={p.max} defaultValue={p.defaultValue}
              label={p.label} units={p.units}
              curve={p.curve}
              onchange={set(p.id)} moduleId={id} paramId={p.id}
              readLive={live(p.id)}
            />
          </div>
        {/each}
      </div>
      <div class="controls">
        <button class="modebtn" onclick={() => cycle(P.mode)} data-testid="slewswitch-mode">{modeLabel}</button>
        <button class="modebtn" onclick={() => cycle(P.length)} data-testid="slewswitch-length">{lenLabel}</button>
        <div class="xfade">
          <NeonFader
            value={paramVal('xfadeTime')}
            min={P.xfadeTime.min} max={P.xfadeTime.max} defaultValue={P.xfadeTime.defaultValue}
            label={P.xfadeTime.label} units={P.xfadeTime.units}
            curve={P.xfadeTime.curve}
            onchange={set('xfadeTime')} moduleId={id} paramId="xfadeTime"
            readLive={live('xfadeTime')}
          />
        </div>
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .mod-card {
    width: 320px;
    background: var(--module-bg);
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text);
    padding-top: 18px;
    padding-bottom: 14px;
    position: relative;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  :global(.svelte-flow__node:hover) .mod-card { border-color: var(--accent-dim); }
  :global(.svelte-flow__node.selected) .mod-card {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .stripe { position: absolute; top: 0; left: 0; right: 0; height: 2px; border-radius: 2px 2px 0 0; }  .body { padding: 4px 10px 10px; }
  .strips {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 6px;
    justify-items: center;
  }
  .controls {
    margin-top: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
  }
  .modebtn {
    background: var(--module-bg);
    color: var(--text-dim);
    border: 1px solid var(--border);
    border-radius: 3px;
    font-size: 0.65rem;
    letter-spacing: 0.08em;
    padding: 5px 10px;
    cursor: pointer;
    font-family: ui-monospace, monospace;
  }
  .modebtn:hover { border-color: var(--accent-dim); color: var(--text); }
  .xfade { width: 60px; }
</style>

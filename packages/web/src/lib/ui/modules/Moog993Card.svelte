<script lang="ts">
  // MOOG 993 TRIGGER & ENVELOPE VOLTAGES PANEL card — a patch-bay convenience
  // panel of the Moog System 55 clone family. Three ROUTE SWITCHES select each
  // trigger out's source (OFF / FROM 1 / FROM 2); the patch panel carries the
  // two trigger SOURCE jacks + two envelope-CV inputs on the left and the three
  // routed trigger outs + two envelope passthroughs on the right.
  //
  // ⚠ THE ROUTERS ARE SWITCHES, NOT KNOBS (#1911). They were three continuous
  // <Knob curve="linear"> dials over a DSP that selected on exact float
  // equality: of 201 positions across the travel, 149 delivered something other
  // than their nearest state, and every one of those was SILENCE. Declaring
  // `curve: 'discrete'` alone would NOT have fixed this surface — Knob.svelte
  // has no discrete branch (its fracToValue is continuous for anything that is
  // not log/exp), so the dial would have gone on emitting floats while the def
  // read as fixed. The control itself had to change: a segmented switch whose
  // only reachable values are the roster's, driven from the DEF's own exported
  // MOOG993_ROUTE_OPTIONS so the state names cannot drift from the contract.
  //
  // Uses the SHARED beige <MoogPanel> wrapper (re-bound control palette) so the
  // stock PatchPanel controls inherit the Moog-era look — same pattern as
  // MoogCp3MixerCard / Moog921aCard.
  import type { NodeProps } from '@xyflow/svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { setNodeParam } from '$lib/graph/mutate';
  import { moog993Def, MOOG993_ROUTE_OPTIONS } from '$lib/audio/modules/moog993';
  import type { ModuleNode } from '$lib/graph/types';
  import MoogPanel from './moog/MoogPanel.svelte';
  import { portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  function def(pid: string) {
    return moog993Def.params.find((p) => p.id === pid)!;
  }

  // The three routers, in def order — the row list is DERIVED from the params
  // rather than typed out, so a fourth router would appear here on its own.
  const ROUTE_PARAMS = moog993Def.params
    .filter((p) => p.id.startsWith('route'))
    .map((p) => ({ id: p.id, caption: p.label.toUpperCase() }));

  let routes = $derived(
    Object.fromEntries(
      ROUTE_PARAMS.map((r) => [r.id, node?.params[r.id] ?? def(r.id).defaultValue]),
    ) as Record<string, number>,
  );

  const inputs = portsFromDef(moog993Def.inputs, {
    trig_from1: 'TRIG 1', trig_from2: 'TRIG 2', env_in1: 'ENV 1', env_in2: 'ENV 2',
  });
  const outputs = portsFromDef(moog993Def.outputs, {
    trig_out1: 'OUT 1', trig_out2: 'OUT 2', trig_out3: 'OUT 3', env_out1: 'ENV 1',
    env_out2: 'ENV 2',
  });
</script>

<MoogPanel {id} {data} defaultLabel="993 Trig" width={220}>
  <PatchPanel nodeId={id} {inputs} {outputs}>
    <!-- Three ROUTE switches, one per trigger out. Every button writes a value
         straight off the def's roster, so no intermediate float exists. -->
    <div class="routes" data-testid="moog993-routes">
      {#each ROUTE_PARAMS as r (r.id)}
        <div class="route-row" data-testid="moog993-{r.id}-switch">
          <span class="route-label">{r.caption}</span>
          <div class="route-seg" role="radiogroup" aria-label={r.caption}>
            {#each MOOG993_ROUTE_OPTIONS as opt (opt.value)}
              <button
                type="button"
                class="route-btn"
                class:active={routes[r.id] === opt.value}
                role="radio"
                aria-checked={routes[r.id] === opt.value}
                title={opt.title}
                data-route-value={opt.value}
                onclick={() => setNodeParam(id, r.id, opt.value)}
              >{opt.label}</button>
            {/each}
          </div>
        </div>
      {/each}
    </div>
  </PatchPanel>
</MoogPanel>

<style>
  .routes {
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: 8px 14px 4px;
  }
  .route-row {
    display: flex;
    align-items: center;
    gap: 6px;
    justify-content: space-between;
  }
  .route-label {
    font-size: 0.55rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    color: var(--text-dim);
    white-space: nowrap;
  }
  .route-seg {
    display: inline-flex;
    border: 1px solid var(--border);
    border-radius: 3px;
    overflow: hidden;
  }
  .route-btn {
    appearance: none;
    border: none;
    background: var(--module-bg-deep);
    color: var(--text-dim);
    font: inherit;
    font-size: 0.55rem;
    font-weight: 600;
    letter-spacing: 0.03em;
    padding: 3px 6px;
    cursor: pointer;
    border-right: 1px solid var(--border);
    transition: background 80ms ease-out, color 80ms ease-out;
    white-space: nowrap;
  }
  .route-btn:last-child {
    border-right: none;
  }
  .route-btn:hover {
    color: var(--text);
  }
  .route-btn.active {
    background: var(--accent);
    color: var(--text-on-accent);
  }
  .route-btn:focus-visible {
    outline: 1px solid var(--accent);
    outline-offset: -1px;
  }
</style>

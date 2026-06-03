<script lang="ts">
  // MOOG 960 SEQUENTIAL CONTROLLER card — the System 55 step sequencer.
  // A wide faceplate: an 8-column × 3-row grid of step pots (the 24 CV knobs),
  // a per-column MODE switch (NORMAL / SKIP / STOP) under each column, a RANGE
  // knob per row (×1 / ×2 / ×4), and a RATE knob with transport (start/stop).
  //
  // Wrapped in the shared beige <MoogPanel> (so the stock Knob / PatchPanel
  // inherit the Moog look) then <PatchPanel> for the jacks — same contract as
  // Moog992Card / SequencerCard. The active-column indicator is polled from the
  // running node via engine.read(node, 'currentColumn'), like SequencerCard's
  // currentStep.
  import type { NodeProps } from '@xyflow/svelte';
  import { onDestroy } from 'svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { moog960Def } from '$lib/audio/modules/moog960';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import MoogPanel from './moog/MoogPanel.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  const engineCtx = useEngine();

  const COLUMNS = 8;
  const ROWS = 3;
  const MODE_LABELS = ['NORM', 'SKIP', 'STOP'];

  function def(pid: string) {
    return moog960Def.params.find((p) => p.id === pid)!;
  }
  function paramVal(pid: string): number {
    return node?.params[pid] ?? def(pid).defaultValue;
  }
  function stepPotId(row: number, col: number) {
    return `r${row}s${col}`;
  }

  function setParam(paramId: string) {
    return (v: number) => {
      const target = patch.nodes[id];
      if (target) target.params[paramId] = v;
    };
  }
  function readLive(paramId: string) {
    return () => {
      const eng = engineCtx.get();
      if (!eng || !node) return undefined;
      return eng.readParam(node, paramId);
    };
  }

  // --- Active-column indicator (polled from the engine, like SequencerCard) ---
  let currentColumn = $state(-1);
  let isRunning = $state(false);
  let raf: number | null = null;
  $effect(() => {
    function frame() {
      const e = engineCtx.get();
      if (e && node) {
        const running = e.read(node, 'isRunning');
        isRunning = running === true;
        const c = e.read(node, 'currentColumn');
        currentColumn = isRunning && typeof c === 'number' ? c : -1;
      }
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
    return () => {
      if (raf !== null) cancelAnimationFrame(raf);
      raf = null;
    };
  });
  onDestroy(() => {
    if (raf !== null) cancelAnimationFrame(raf);
  });

  // The card writes transport directly via the start/stop gate ports when
  // patched; for the on-card buttons we nudge the same gate ports by writing a
  // momentary value through the engine is not available, so the card exposes
  // the gates as jacks only (v1). Transport is driven by patched start/stop
  // gates — matching the hardware's front-panel jacks.

  // Inputs (left): clock + start/stop gates. Outputs (right): 3 row CV + clock.
  const inputs: PortDescriptor[] = [
    { id: 'clock', label: 'CLOCK', cable: 'gate' },
    { id: 'start', label: 'START', cable: 'gate' },
    { id: 'stop', label: 'STOP', cable: 'gate' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'row1', label: 'ROW 1', cable: 'cv' },
    { id: 'row2', label: 'ROW 2', cable: 'cv' },
    { id: 'row3', label: 'ROW 3', cable: 'cv' },
    { id: 'clock_out', label: 'CLK', cable: 'cv' },
  ];

  const cols = Array.from({ length: COLUMNS }, (_, i) => i + 1);
  const rows = Array.from({ length: ROWS }, (_, i) => i + 1);
</script>

<MoogPanel {id} {data} defaultLabel="Moog 960 Sequencer" width={520}>
  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="seq960" data-testid={`moog960-grid-${id}`}>
      <!-- Column index header row (highlights the active column). -->
      <div class="grid-row header">
        <div class="row-label"></div>
        {#each cols as c (c)}
          <div class="col-head" class:active={currentColumn === c - 1} data-col={c}>{c}</div>
        {/each}
        <div class="range-head">RANGE</div>
      </div>

      <!-- Three rows of 8 step pots, each row capped by its RANGE knob. -->
      {#each rows as r (r)}
        {@const rangePid = `range${r}`}
        <div class="grid-row">
          <div class="row-label">ROW {r}</div>
          {#each cols as c (c)}
            {@const pid = stepPotId(r, c)}
            <div class="cell" class:active={currentColumn === c - 1}>
              <Knob
                value={paramVal(pid)}
                min={0}
                max={1}
                defaultValue={0.5}
                label=""
                curve="linear"
                onchange={setParam(pid)}
                moduleId={id}
                paramId={pid}
                readLive={readLive(pid)}
              />
            </div>
          {/each}
          <div class="range-cell">
            <Knob
              value={paramVal(rangePid)}
              min={0}
              max={2}
              defaultValue={0}
              label={`×${[1, 2, 4][Math.round(paramVal(rangePid))] ?? 1}`}
              curve="discrete"
              onchange={setParam(rangePid)}
              moduleId={id}
              paramId={rangePid}
              readLive={readLive(rangePid)}
            />
          </div>
        </div>
      {/each}

      <!-- Per-column MODE switches (NORMAL / SKIP / STOP). -->
      <div class="grid-row mode">
        <div class="row-label">MODE</div>
        {#each cols as c (c)}
          {@const mpid = `mode${c}`}
          <div class="cell">
            <Knob
              value={paramVal(mpid)}
              min={0}
              max={2}
              defaultValue={0}
              label={MODE_LABELS[Math.round(paramVal(mpid))] ?? 'NORM'}
              curve="discrete"
              onchange={setParam(mpid)}
              moduleId={id}
              paramId={mpid}
              readLive={readLive(mpid)}
            />
          </div>
        {/each}
        <div class="range-cell"></div>
      </div>

      <!-- Transport: internal RATE (Hz) — drives when CLOCK is unpatched. -->
      <div class="transport-row">
        <div class="rate-knob">
          <Knob
            value={paramVal('rate')}
            min={0.1}
            max={20}
            defaultValue={2}
            label="RATE"
            units="Hz"
            curve="log"
            onchange={setParam('rate')}
            moduleId={id}
            paramId="rate"
            readLive={readLive('rate')}
          />
        </div>
        <div class="transport-status" class:running={isRunning}>
          {isRunning ? '▶ RUN' : '■ STOP'}
        </div>
      </div>
    </div>
  </PatchPanel>
</MoogPanel>

<style>
  .seq960 {
    padding: 8px 14px 4px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .grid-row {
    display: grid;
    grid-template-columns: 48px repeat(8, 1fr) 56px;
    align-items: center;
    gap: 4px;
  }
  .row-label {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-align: right;
    padding-right: 4px;
    color: var(--text);
  }
  .header .col-head {
    text-align: center;
    font-size: 11px;
    font-weight: 700;
    color: var(--text-dim);
    border-radius: 3px;
    padding: 2px 0;
  }
  .header .col-head.active {
    color: var(--text-on-accent);
    background: var(--accent);
  }
  .range-head {
    font-size: 9px;
    font-weight: 700;
    text-align: center;
    color: var(--text);
  }
  .cell {
    display: flex;
    justify-content: center;
    align-items: center;
    border-radius: 4px;
    padding: 1px 0;
  }
  .cell.active {
    background: var(--accent-glow);
  }
  .range-cell {
    display: flex;
    justify-content: center;
  }
  .mode .cell :global(.knob-wrap .label) {
    font-size: 8px;
  }
  .transport-row {
    display: flex;
    align-items: center;
    gap: 18px;
    padding-top: 6px;
    border-top: 1px solid var(--divider);
    margin-top: 2px;
  }
  .rate-knob {
    display: flex;
  }
  .transport-status {
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.06em;
    color: var(--text-dim);
  }
  .transport-status.running {
    color: var(--accent);
  }
</style>

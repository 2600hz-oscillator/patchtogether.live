<script lang="ts">
  // ClockSurface — the WORKFLOW topbar clock-icon dropdown: TIMELORDE's
  // face for workflow racks (the pinned instance renders no canvas card,
  // so THIS menu is where the rack clock lives).
  //
  // Pure recomposition of existing mechanisms:
  //  - live BPM readout — the same internal/external readout as the card
  //    footer (`params.bpm`, or the worklet's measured external tempo via
  //    engine read('measuredBpm') while a clock cable is patched);
  //  - the tempo knob — the REAL Knob bound to `bpm` via setNodeParam, so
  //    it's MIDI-learnable exactly like the card's knob (same
  //    moduleId:paramId binding key);
  //  - TAP tempo — the shared TapTempo helper (the Electra pad + card
  //    button precedent); DISABLED with an explanatory tooltip while an
  //    external clock owns the tempo;
  //  - patch-out — each TIMELORDE output row hands off to the EXISTING
  //    patch-menu drill-down (the `patchpanel:jackclick`→`patchpanel:patchto`
  //    CustomEvent seam Canvas already listens on); the PortContextMenu
  //    picker then wires the cable through the same validated commit path
  //    every card jack uses. Click-driven only — the drag-from-menu
  //    primitive is P3.

  import Knob from '$lib/ui/controls/Knob.svelte';
  import { setNodeParam } from '$lib/graph/mutate';
  import { useEngine } from '$lib/audio/engine-context';
  import { TapTempo } from '$lib/electra/tap-tempo';
  import { timelordeDef } from '$lib/audio/modules/timelorde';
  import type { ModuleNode } from '$lib/graph/types';
  import { tapWithExternalGuard } from './workflow-surfaces';

  interface Props {
    /** THE rack timelorde (snapshot-derived by Canvas; null pre-ensure). */
    timelorde: ModuleNode | null;
    /** True while a cable is patched into TIMELORDE's `clock` input. */
    externallyClocked: boolean;
    /** Close the dropdown (called after a patch-out hand-off). */
    onRequestClose: () => void;
  }
  let { timelorde, externallyClocked, onRequestClose }: Props = $props();

  const engineCtx = useEngine();

  const bpmDef = timelordeDef.params.find((p) => p.id === 'bpm')!;

  let bpm = $derived(timelorde?.params?.bpm ?? bpmDef.defaultValue);

  // Measured external tempo — polled at the card's 4 Hz cadence while the
  // menu is mounted (it only mounts while open). 0 = no lock yet.
  let measuredBpm = $state(0);
  $effect(() => {
    if (!externallyClocked) {
      measuredBpm = 0;
      return;
    }
    const node = timelorde;
    if (!node) return;
    const poll = () => {
      const e = engineCtx.get();
      const v = e?.read?.(node, 'measuredBpm');
      measuredBpm = typeof v === 'number' ? v : 0;
    };
    poll();
    const timer = setInterval(poll, 250);
    return () => clearInterval(timer);
  });

  let displayBpm = $derived(externallyClocked && measuredBpm > 0 ? measuredBpm : bpm);

  function setBpm(v: number): void {
    if (!timelorde) return;
    setNodeParam(timelorde.id, 'bpm', v);
  }
  function readLiveBpm(): number | undefined {
    const e = engineCtx.get();
    if (!e || !timelorde) return undefined;
    return e.readParam(timelorde, 'bpm');
  }

  // ---- TAP tempo (backlog task #25 — the topbar surface) ----
  // Same shared core as the card button + the Electra hardware pad; the
  // computed BPM goes through the normal `bpm` param write, so it
  // persists + syncs like a knob turn.
  const tapController = new TapTempo();
  function onTap(): void {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const bpmNow = tapWithExternalGuard(tapController, now, externallyClocked);
    if (bpmNow !== null) setBpm(bpmNow);
  }
  // External clock patched mid-count → forget the in-progress series so a
  // later un-patch starts clean (mirrors TimelordeCard).
  $effect(() => {
    if (externallyClocked) tapController.reset();
  });

  // ---- patch-out: TIMELORDE outputs → the drill-down picker ----
  const patchableOutputs = timelordeDef.outputs.map((p) => ({
    id: p.id,
    label: p.type === 'video' ? 'VIDEO OUT' : `CLOCK ${p.id.toUpperCase()}`,
    cable: p.type as string,
  }));

  function patchOut(portId: string, ev: MouseEvent): void {
    if (!timelorde) return;
    // Begin the carry from the (canvas-hidden) TIMELORDE output, then open
    // the picker. Canvas's patchpanel:* listeners resolve the cable type
    // from the def and route the pick through the validated commit path.
    document.dispatchEvent(
      new CustomEvent('patchpanel:jackclick', {
        detail: { nodeId: timelorde.id, portId, direction: 'output', side: 'right' },
      }),
    );
    document.dispatchEvent(
      new CustomEvent('patchpanel:patchto', {
        detail: { nodeId: timelorde.id, pos: { x: ev.clientX, y: ev.clientY } },
      }),
    );
    onRequestClose();
  }
</script>

<div class="clock-menu" data-testid="workflow-clock-menu" role="menu">
  {#if !timelorde}
    <div class="empty" data-testid="workflow-clock-empty">clock spawning…</div>
  {:else}
    <div
      class="bpm-readout"
      data-testid="workflow-clock-bpm"
      data-clock-source={externallyClocked ? 'external' : 'internal'}
    >
      <span class="bpm-value">{displayBpm.toFixed(0)}</span>
      <span class="bpm-unit">BPM</span>
      <span class="bpm-source">({externallyClocked ? 'external' : 'internal'})</span>
    </div>

    <div class="tempo-row">
      <div class="knob-host" data-testid="workflow-clock-knob">
        <Knob
          value={bpm}
          min={bpmDef.min}
          max={bpmDef.max}
          defaultValue={bpmDef.defaultValue}
          label="BPM"
          curve="log"
          onchange={setBpm}
          moduleId={timelorde.id}
          paramId="bpm"
          readLive={readLiveBpm}
        />
      </div>
      <button
        class="tap-btn"
        data-testid="workflow-clock-tap"
        onclick={onTap}
        disabled={externallyClocked}
        title={externallyClocked
          ? 'TAP disabled — tempo is locked to the external clock (unassign the MIDI clock or unpatch CLOCK IN to tap)'
          : 'Tap twice in time to set the tempo'}
      >TAP</button>
    </div>

    <div class="divider"></div>

    <div class="patchout-header">patch out</div>
    <div class="patchout" data-testid="workflow-clock-patchout">
      {#each patchableOutputs as p (p.id)}
        <button
          class="patchout-row"
          data-testid={`workflow-clock-patchout-${p.id}`}
          data-cable={p.cable}
          onclick={(e) => patchOut(p.id, e)}
          title={`Patch TIMELORDE ${p.id} to a compatible input on the canvas`}
        >
          <span class="jack" style={`background: var(--cable-${p.cable}, #888);`}></span>
          {p.label}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .clock-menu {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    z-index: 60;
    min-width: 230px;
    max-height: 70vh;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    background: #14171c;
    border: 1px solid #404652;
    border-radius: 4px;
    padding: 8px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
  }
  .empty {
    color: var(--text-dim);
    font-size: 0.75rem;
    padding: 8px;
  }
  .bpm-readout {
    display: flex;
    align-items: baseline;
    gap: 6px;
    padding: 2px 4px 8px;
    font-family: ui-monospace, monospace;
  }
  .bpm-value {
    font-size: 1.4rem;
    color: var(--text);
  }
  .bpm-unit {
    font-size: 0.7rem;
    color: var(--text-dim);
  }
  .bpm-source {
    font-size: 0.65rem;
    color: var(--cable-gate, #f97316);
  }
  .tempo-row {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 0 4px 6px;
  }
  .tap-btn {
    min-width: 52px;
    height: 34px;
    background: #2a2f3a;
    border: 1px solid #404652;
    color: var(--text);
    border-radius: 3px;
    cursor: pointer;
    font-family: inherit;
    font-size: 0.75rem;
  }
  .tap-btn:hover:not(:disabled) {
    background: #353a47;
  }
  .tap-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .divider {
    height: 1px;
    background: #2a2f3a;
    margin: 4px 2px;
  }
  .patchout-header {
    font-size: 0.6rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-dim);
    padding: 4px 4px 2px;
  }
  .patchout {
    display: flex;
    flex-direction: column;
  }
  .patchout-row {
    display: flex;
    align-items: center;
    gap: 8px;
    background: transparent;
    border: none;
    color: var(--text);
    text-align: left;
    padding: 4px 6px;
    border-radius: 3px;
    cursor: pointer;
    font-family: ui-monospace, monospace;
    font-size: 0.7rem;
  }
  .patchout-row:hover {
    background: #2a2f3a;
  }
  .jack {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex: 0 0 auto;
  }
</style>

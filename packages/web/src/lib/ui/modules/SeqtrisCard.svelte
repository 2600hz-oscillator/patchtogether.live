<script lang="ts">
  // SeqtrisCard — the 8×8 well, the eight game controls, and the Launchpad
  // binder.
  //
  // The card is a WINDOW, not the game. The board, the clock subscription and
  // the Launchpad claim all live in the module factory, so collapsing this card
  // never stops a running game and never hands the hardware back. What is here:
  // the picture of the well (in the SAME palette the pads are lit in, so the
  // screen and the hardware are one instrument), the eight controls laid out
  // exactly like the Launchpad's scene column so the mapping is learnable
  // without hardware, and CONNECT.
  //
  // DETERMINISTIC AT REST (VRT): with nothing patched into CLOCK the piece
  // never falls, and the piece bag is seeded from a fixed constant — so a fresh
  // spawn renders the same first piece at the top of an empty well, every time.
  // No timers, no counters, no live numbers on the plate.

  import { onDestroy } from 'svelte';
  import type { NodeProps } from '@xyflow/svelte';
  import { KnobConic } from '$lib/ui/controls';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, paramSpec, portsFromDef } from './card-kit';
  import type { ModuleNode } from '$lib/graph/types';
  import { seqtrisDef, type SeqtrisCardApi, type SeqtrisSnapshot } from '$lib/audio/modules/seqtris';
  import {
    SEQTRIS_COLS,
    SEQTRIS_ROWS,
    cellIndex,
    seqtrisCssColor,
    type SeqtrisPieceId,
  } from '$lib/audio/modules/seqtris-engine';
  import { SEQTRIS_SCENE_ACTIONS } from '$lib/audio/seqtris-launchpad';
  import type { LaunchpadPort } from '$lib/control/launchpad/launchpad-device.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode | undefined);
  const { paramVal, set, live, engineCtx } = cardParams(
    seqtrisDef,
    () => id,
    () => node,
  );

  const KNOBS = ['gravity', 'quantize'] as const;

  /** Button captions, top to bottom, matching SEQTRIS_SCENE_ACTIONS. */
  const CONTROL_LABELS: Record<string, string> = {
    reset: 'reset',
    drop: 'drop',
    rotateLeft: 'rot ←',
    rotateRight: 'rot →',
    moveLeft: 'move ←',
    moveRight: 'move →',
  };

  function api(): SeqtrisCardApi | null {
    const engine = engineCtx.get();
    if (!engine || !node) return null;
    return (engine.read(node, 'card-api') as SeqtrisCardApi | undefined) ?? null;
  }

  // The module pushes a change notification whenever the game state moves; the
  // card never polls. A subscription is re-established when the engine handle
  // for this node appears (a card can mount before the reconciler builds it).
  let snap = $state<SeqtrisSnapshot | null>(null);
  let unsubscribe: (() => void) | null = null;

  function attach(): void {
    if (unsubscribe) return;
    const a = api();
    if (!a) return;
    snap = a.snapshot();
    unsubscribe = a.subscribe(() => {
      snap = a.snapshot();
    });
  }
  $effect(() => {
    // Re-read on node identity change so a rebuilt handle re-attaches.
    void node;
    attach();
  });
  onDestroy(() => {
    unsubscribe?.();
    unsubscribe = null;
  });

  /** Bumped by user actions so the binder-backed reads re-run. */
  let revision = $state(0);

  let status = $derived.by(() => {
    void revision;
    return api()?.launchpadStatus() ?? null;
  });
  let ports = $derived<readonly LaunchpadPort[]>(status?.ports ?? []);
  let bound = $derived(status?.kind === 'bound');
  let problem = $derived(
    status !== null && (status.kind === 'no-device' || status.kind === 'claimed' || status.kind === 'unsupported'),
  );

  let board = $derived<readonly (SeqtrisPieceId | null)[]>(
    snap?.board ?? Array.from({ length: SEQTRIS_COLS * SEQTRIS_ROWS }, () => null),
  );
  const ROWS = Array.from({ length: SEQTRIS_ROWS }, (_, r) => r);
  const COLS = Array.from({ length: SEQTRIS_COLS }, (_, c) => c);

  function onConnect(): void {
    // Straight from the click handler — an await above requestMIDIAccess spends
    // the user activation and Chromium refuses to prompt.
    void api()?.connect().then(() => {
      revision++;
    });
    revision++;
  }
  function onPick(port: LaunchpadPort): void {
    api()?.bindPort(port);
    revision++;
  }
  function onUnbind(): void {
    api()?.unbindPort();
    revision++;
  }
  function onControl(index: number): void {
    const action = SEQTRIS_SCENE_ACTIONS[index];
    if (!action) return;
    api()?.press(action);
    revision++;
  }

  const inputs = portsFromDef(seqtrisDef.inputs);
  const outputs = portsFromDef(seqtrisDef.outputs);
</script>

<div class="mod-card seqtris-card" data-testid={`seqtris-card-${id}`}>
  <div class="stripe" style="background: var(--cable-polyPitchGate);"></div>
  <ModuleTitle {id} {data} defaultLabel="SEQTRIS" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="bind-row">
      <span class={`led ${bound ? 'led-bound' : ''}`} data-testid={`seqtris-led-${id}`}></span>
      {#if bound}
        <button type="button" class="mini" onclick={onUnbind} data-testid={`seqtris-unbind-${id}`}>
          Unbind
        </button>
      {:else}
        <button type="button" class="mini" onclick={onConnect} data-testid={`seqtris-connect-${id}`}>
          Connect Launchpad
        </button>
      {/if}
    </div>

    {#if !bound && ports.length > 0}
      <div class="picker" data-testid={`seqtris-picker-${id}`}>
        {#each ports as port, i (port.outputId + i)}
          <!-- keyed by INDEX, not name: Windows reports identical port names -->
          <button
            type="button"
            class="mini"
            onclick={() => onPick(port)}
            data-testid={`seqtris-port-${i}-${id}`}
          >
            {port.name}
          </button>
        {/each}
      </div>
    {/if}

    <p class="status" class:problem role={problem ? 'alert' : undefined} data-testid={`seqtris-status-${id}`}>
      {status?.message ?? ''}
    </p>

    <div class="play">
      <div
        class="well"
        role="img"
        aria-label={`Seqtris well, 8 by 8${snap?.piece ? `, current piece ${snap.piece}` : ''}`}
        data-testid={`seqtris-well-${id}`}
      >
        {#each ROWS as row (row)}
          {#each COLS as col (col)}
            {@const cell = board[cellIndex(row, col)] ?? null}
            <span
              class="cell"
              class:filled={cell !== null}
              style={`background: ${seqtrisCssColor(cell)};`}
              data-testid={`seqtris-cell-${row}-${col}-${id}`}
              data-piece={cell ?? ''}
            ></span>
          {/each}
        {/each}
      </div>

      <!-- The controls sit in a right-hand column in the SAME order as the
           Launchpad's scene-launch buttons, including the two dead ones, so the
           hardware mapping is legible from the card alone. -->
      <div class="controls" data-testid={`seqtris-controls-${id}`}>
        {#each SEQTRIS_SCENE_ACTIONS as action, i (i)}
          {#if action === null}
            <span class="scene dead" aria-hidden="true"></span>
          {:else}
            <button
              type="button"
              class="scene"
              onclick={() => onControl(i)}
              title={`Scene button ${i + 1} — ${CONTROL_LABELS[action]}`}
              data-testid={`seqtris-control-${action}-${id}`}
            >
              {CONTROL_LABELS[action]}
            </button>
          {/if}
        {/each}
      </div>
    </div>

    <div class="knob-row">
      {#each KNOBS as knobId (knobId)}
        {@const spec = paramSpec(seqtrisDef, knobId)}
        <!-- min/max/curve/defaultValue come from the DEF via paramSpec — never
             re-typed here (card-range-source / card-control-ranges gates). -->
        <KnobConic
          value={paramVal(knobId)}
          min={spec.min}
          max={spec.max}
          defaultValue={spec.defaultValue}
          curve={spec.curve}
          label={knobId}
          moduleId={id}
          paramId={knobId}
          onchange={set(knobId)}
          readLive={live(knobId)}
        />
      {/each}
    </div>
  </PatchPanel>
</div>

<style>
  .seqtris-card {
    width: 260px;
  }
  .stripe {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 2px;
    border-radius: 2px 2px 0 0;
  }
  .bind-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px 0;
  }
  .mini {
    font-size: 10px;
  }
  .picker {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 6px 14px 0;
  }
  .led {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #555;
    flex: none;
  }
  .led-bound {
    background: #4caf7d;
  }
  .status {
    margin: 0;
    padding: 4px 14px 0;
    font-size: 9px;
    line-height: 1.3;
    opacity: 0.75;
  }
  .status.problem {
    color: #d98a3a;
    opacity: 1;
  }
  .play {
    display: flex;
    gap: 6px;
    padding: 8px 14px 0;
  }
  .well {
    display: grid;
    grid-template-columns: repeat(8, 1fr);
    grid-template-rows: repeat(8, 1fr);
    gap: 1px;
    flex: 1 1 auto;
    aspect-ratio: 1 / 1;
    padding: 2px;
    border-radius: 3px;
    background: #0b0c10;
  }
  .cell {
    border-radius: 1px;
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.03);
  }
  .cell.filled {
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.18);
  }
  .controls {
    display: grid;
    grid-template-rows: repeat(8, 1fr);
    gap: 1px;
    width: 52px;
    flex: none;
  }
  .scene {
    font-size: 8px;
    line-height: 1;
    padding: 0;
    border-radius: 2px;
    white-space: nowrap;
    overflow: hidden;
  }
  .scene.dead {
    opacity: 0.15;
    border-radius: 2px;
    background: #14161c;
  }
  .knob-row {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 6px;
    padding: 8px 14px 10px;
  }
</style>

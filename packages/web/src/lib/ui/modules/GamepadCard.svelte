<script lang="ts">
  // GamepadCard — display the live state of a connected gamepad
  // alongside the 18 patchable CV/gate outputs.
  //
  // Browser security: Gamepad API exposes the controller only after
  // the user has pressed a button on it. Until then,
  // navigator.getGamepads() returns null in that slot. We show a
  // "Press any button on your gamepad…" prompt; once the engine's
  // live-snapshot poll reports `connected`, the prompt swaps to the
  // pad's reported ID + live indicators.
  //
  // Visual:
  //   * Header: "GAMEPAD <pad id or 'no controller'>"
  //   * Two XY pads (left stick / right stick) drawing the live
  //     stick positions as small dots — purely informational, NOT
  //     a control surface (dragging the dot does nothing; the
  //     gamepad's own sticks are the source of truth).
  //   * Trigger bars (LT/RT) showing 0..1 fill.
  //   * Face-button + d-pad row with active-state highlighting.
  //   * Padded slot selector (0..3) so users can pick which of
  //     several connected pads to read.

  import { onDestroy, onMount } from 'svelte';
  import type { NodeProps } from '@xyflow/svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { useEngine } from '$lib/audio/engine-context';
  import { GAMEPAD_OUTPUTS, type GamepadSnapshot } from '$lib/audio/modules/gamepad';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  // Live snapshot poll. ~30Hz cadence (~33ms) — twice fast enough for
  // visual smoothness on the on-card indicators without churning
  // Svelte's reactivity graph at engine.read() rate.
  let snapshot = $state<GamepadSnapshot>({
    connected: false,
    id: '',
    values: Object.fromEntries(GAMEPAD_OUTPUTS.map((o) => [o.id, 0])),
  });
  const POLL_MS = 33;
  let pollId: ReturnType<typeof setInterval> | null = null;
  function poll() {
    const e = engineCtx.get();
    if (!e || !node) return;
    const s = e.read(node, 'snapshot') as GamepadSnapshot | undefined;
    if (s) snapshot = s;
  }
  onMount(() => { pollId = setInterval(poll, POLL_MS); });
  onDestroy(() => {
    if (pollId !== null) clearInterval(pollId);
    pollId = null;
  });

  // Pad-slot picker.
  let padIndex = $derived<number>(
    Math.max(0, Math.min(3, Math.round((node?.params?.padIndex as number | undefined) ?? 0))),
  );
  function setPadIndex(n: number) {
    const t = patch.nodes[id];
    if (!t) return;
    t.params.padIndex = Math.max(0, Math.min(3, Math.round(n)));
  }

  // PatchPanel ports — every output the engine def declares, plus the
  // padIndex param as a CV input would be over-engineering (it's
  // discrete + only 4 values); skip.
  const outputs: PortDescriptor[] = GAMEPAD_OUTPUTS.map((o) => ({
    id: o.id,
    label: o.label,
    cable: (o.type === 'cv' ? 'cv' : 'gate') as PortDescriptor['cable'],
  }));
  const inputs: PortDescriptor[] = [];

  // Stick-pad rendering: live values → dot position in a 64×64 box.
  const PAD_PX = 64;
  function dotX(v: number): number { return ((v + 1) / 2) * PAD_PX; }
  function dotY(v: number): number {
    // Y +1 from the engine = up in real-life stick → up on screen.
    return ((-v + 1) / 2) * PAD_PX;
  }
</script>

<div class="card gamepad" data-testid="gamepad-card">
  <div class="stripe"></div>
  <header class="title">
    <ModuleTitle {id} {data} defaultLabel="GAMEPAD" inline />
    <span class="status" class:on={snapshot.connected}>
      {#if snapshot.connected}
        {snapshot.id.length > 24 ? snapshot.id.slice(0, 21) + '…' : snapshot.id}
      {:else}
        press any button to connect
      {/if}
    </span>
  </header>

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="body">
      <div class="sticks">
        <div class="stick-block">
          <div class="stick-pad" aria-label="Left stick">
            <div class="crosshair-h"></div>
            <div class="crosshair-v"></div>
            <div
              class="dot"
              style="transform: translate({dotX(snapshot.values.lx ?? 0)}px, {dotY(snapshot.values.ly ?? 0)}px);"
            ></div>
          </div>
          <div class="stick-label">L</div>
        </div>
        <div class="stick-block">
          <div class="stick-pad" aria-label="Right stick">
            <div class="crosshair-h"></div>
            <div class="crosshair-v"></div>
            <div
              class="dot"
              style="transform: translate({dotX(snapshot.values.rx ?? 0)}px, {dotY(snapshot.values.ry ?? 0)}px);"
            ></div>
          </div>
          <div class="stick-label">R</div>
        </div>
      </div>

      <div class="triggers">
        <div class="trig-row">
          <span class="trig-label">LT</span>
          <div class="trig-bar"><div class="trig-fill" style="width: {(snapshot.values.lt ?? 0) * 100}%"></div></div>
        </div>
        <div class="trig-row">
          <span class="trig-label">RT</span>
          <div class="trig-bar"><div class="trig-fill" style="width: {(snapshot.values.rt ?? 0) * 100}%"></div></div>
        </div>
      </div>

      <div class="buttons">
        {#each ['lb','rb','a','b','x','y','du','dd','dl','dr','start','back'] as btn (btn)}
          <div class="btn-led" class:on={(snapshot.values[btn] ?? 0) >= 0.5}>{btn.toUpperCase()}</div>
        {/each}
      </div>

      <div class="slot-row">
        <span class="slot-label">SLOT</span>
        {#each [0, 1, 2, 3] as i (i)}
          <button
            type="button"
            class="slot-btn"
            class:on={padIndex === i}
            onclick={() => setPadIndex(i)}
            data-testid="gamepad-slot-{i}"
          >{i}</button>
        {/each}
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .card {
    background: var(--module-bg);
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text);
    padding-top: 18px;
    padding-bottom: 12px;
    position: relative;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    min-width: 280px;
  }
  :global(.svelte-flow__node:hover) .card { border-color: var(--accent-dim); }
  :global(.svelte-flow__node.selected) .card {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .stripe {
    position: absolute; top: 0; left: 0; right: 0;
    height: 2px; border-radius: 2px 2px 0 0;
    background: var(--cable-cv);
  }
  .title {
    font-size: 0.78rem;
    font-weight: 600;
    text-align: center;
    margin: 0 0 8px;
    letter-spacing: 0.05em;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }
  .status {
    font-size: 0.62rem;
    font-weight: 400;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
    text-transform: none;
    letter-spacing: 0;
  }
  .status.on { color: var(--accent, #00f0ff); }

  .body {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 0 10px;
  }

  .sticks {
    display: flex;
    justify-content: center;
    gap: 14px;
  }
  .stick-block {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
  }
  .stick-pad {
    position: relative;
    width: 64px;
    height: 64px;
    background: rgba(10, 12, 16, 0.7);
    border: 1px solid var(--border);
    border-radius: 50%;
  }
  .crosshair-h, .crosshair-v {
    position: absolute;
    background: rgba(255, 255, 255, 0.05);
  }
  .crosshair-h { left: 0; right: 0; top: 50%; height: 1px; }
  .crosshair-v { top: 0; bottom: 0; left: 50%; width: 1px; }
  .dot {
    position: absolute;
    top: -4px; left: -4px;
    width: 8px; height: 8px;
    border-radius: 50%;
    background: var(--accent, #00f0ff);
    box-shadow: 0 0 6px var(--accent, #00f0ff);
    transition: transform 25ms linear;
  }
  .stick-label {
    font-size: 0.6rem;
    font-family: ui-monospace, monospace;
    color: var(--text-dim);
  }

  .triggers {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .trig-row { display: flex; align-items: center; gap: 6px; }
  .trig-label {
    font-size: 0.6rem;
    font-family: ui-monospace, monospace;
    color: var(--text-dim);
    width: 18px;
  }
  .trig-bar {
    flex: 1;
    height: 8px;
    background: rgba(10, 12, 16, 0.7);
    border: 1px solid var(--border);
    border-radius: 2px;
    overflow: hidden;
  }
  .trig-fill {
    height: 100%;
    background: var(--cable-cv);
    transition: width 25ms linear;
  }

  .buttons {
    display: grid;
    grid-template-columns: repeat(6, 1fr);
    gap: 3px;
  }
  .btn-led {
    text-align: center;
    font-size: 0.55rem;
    font-family: ui-monospace, monospace;
    font-weight: 600;
    padding: 3px 0;
    background: rgba(10, 12, 16, 0.7);
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text-dim);
    transition: background 60ms ease-out, color 60ms ease-out, border-color 60ms ease-out;
  }
  .btn-led.on {
    background: var(--cable-gate, #ffd000);
    border-color: var(--cable-gate, #ffd000);
    color: #000;
  }

  .slot-row {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 2px;
  }
  .slot-label {
    font-size: 0.6rem;
    font-family: ui-monospace, monospace;
    color: var(--text-dim);
    flex: 1;
  }
  .slot-btn {
    appearance: none;
    background: rgba(10, 12, 16, 0.7);
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text-dim);
    width: 22px; height: 22px;
    font-family: ui-monospace, monospace;
    font-size: 0.7rem;
    cursor: pointer;
    transition: background 60ms ease-out, color 60ms ease-out, border-color 60ms ease-out;
  }
  .slot-btn.on {
    background: var(--accent, #00f0ff);
    border-color: var(--accent, #00f0ff);
    color: #000;
  }
</style>

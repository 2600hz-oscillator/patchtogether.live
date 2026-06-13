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
  import { mutateNode } from '$lib/graph/mutate';
  import { useEngine } from '$lib/audio/engine-context';
  import {
    GAMEPAD_OUTPUTS,
    type GamepadSnapshot,
    type GamepadData,
    newCalibrationSweep,
    recordCalibrationSample,
    sweepIsUsable,
    finalizeCalibration,
    type CalibrationSweep,
    detectChangedControl,
    setBinding,
    bindingForOutput,
    describeControl,
    type RawGamepadReading,
    type RemapBindings,
    type PhysicalControl,
  } from '$lib/audio/modules/gamepad';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  // Live snapshot poll. Rides requestAnimationFrame (~60Hz) so the on-card
  // stick dots / trigger bars / button LEDs track the controller in real
  // time. A setInterval here gets starved + coalesced behind main-thread
  // work, making the indicators lag; rAF pins the read to the paint cadence
  // (the same cadence the gamepad factory's own poll runs at) and is
  // naturally suspended when the tab is backgrounded. This is a UI/visual
  // read only — audio scheduling stays on the scheduler-clock worker tick.
  let snapshot = $state<GamepadSnapshot>({
    connected: false,
    id: '',
    values: Object.fromEntries(GAMEPAD_OUTPUTS.map((o) => [o.id, 0])),
    rawLeftX: 0,
    rawLeftY: 0,
    calibrated: false,
    raw: { axes: [], buttons: [] },
    bindings: {},
  });

  // ---------------- control REMAP (arm → detect → bind) ----------------
  // The Gamepad API has no events, so an armed "learn" listener must DIFF
  // consecutive polled snapshots (gamepad.ts detectChangedControl) and pick the
  // single control the user moved/pressed. Two entry points share this FSM:
  //   * right-click a button LED / trigger row → arm `only:'button'`,
  //   * the "Remap X" / "Remap Y" buttons under a stick → arm `only:'axis'`.
  // The committed binding lives on node.data.bindings (single in-place Y.Doc
  // write); the factory reads it each frame so a remap takes effect immediately
  // + survives reload + syncs to rack-mates. Esc or a timeout cancels.
  const REMAP_TIMEOUT_MS = 8000;
  let remap = $state<{
    outputId: string;
    only: 'axis' | 'button';
    /** Label of the output being rebound, for the affordance banner. */
    label: string;
    /** Baseline reading captured on the first armed frame to diff against. */
    baseline: RawGamepadReading | null;
  } | null>(null);
  let remapTimer: ReturnType<typeof setTimeout> | null = null;

  /** Live per-output overrides (synced) — drives the per-control "remapped"
   *  badges. Read off the snapshot the factory publishes each poll. */
  let bindings = $derived<RemapBindings>(snapshot.bindings ?? {});

  function isRemapped(outputId: string): boolean {
    return !!bindings[outputId];
  }
  function bindingLabel(outputId: string): string {
    const b = bindingForOutput(outputId, bindings);
    return b ? describeControl(b) : '';
  }

  function armRemap(outputId: string, only: 'axis' | 'button', label: string) {
    cancelRemap();
    // baseline=null → the next polled frame seeds it (first diff returns null).
    remap = { outputId, only, label, baseline: null };
    remapTimer = setTimeout(cancelRemap, REMAP_TIMEOUT_MS);
  }
  function cancelRemap() {
    remap = null;
    if (remapTimer !== null) { clearTimeout(remapTimer); remapTimer = null; }
  }
  /** Commit a detected physical control to the armed output as a SINGLE in-place
   *  node.data write (rides the Y.Doc → collab + undo). */
  function commitRemap(outputId: string, control: PhysicalControl) {
    mutateNode(id, (live) => {
      if (!live.data) live.data = {};
      const d = live.data as GamepadData;
      const next = setBinding(d.bindings, outputId, control);
      // Replace the bindings map's CONTENTS in place — never reassign an
      // integrated Y type. We mutate keys on the existing object when present.
      if (!d.bindings) {
        d.bindings = next;
      } else {
        // Drop keys no longer present, then set/overwrite the rest, all in place.
        for (const k of Object.keys(d.bindings)) {
          if (!(k in next)) delete d.bindings[k];
        }
        for (const k of Object.keys(next)) {
          d.bindings[k] = next[k]!;
        }
      }
    });
    cancelRemap();
  }
  /** Clear a single output's override (revert to its default control). */
  function clearRemap(outputId: string) {
    mutateNode(id, (live) => {
      const d = live.data as GamepadData | undefined;
      if (d?.bindings) delete d.bindings[outputId];
    });
  }

  // ---------------- left-stick calibration MODE ----------------
  // Entering calibration MODE arms a live min/max sweep. Each poll frame folds
  // the RAW left-stick axes (snapshot.rawLeftX/Y) into the sweep — this is
  // TRANSIENT render state, NOT a synced write (a per-frame Y.Doc write is the
  // render-storm bug class). Only the FINAL committed calibration is written,
  // once, to node.data on "complete calibration".
  let calibrating = $state(false);
  // Mutated in place every frame; reassigned to a fresh object to nudge Svelte
  // reactivity for the live min/max readout + the "complete" enabled gate.
  let sweep = $state<CalibrationSweep>(newCalibrationSweep());
  let canComplete = $derived(calibrating && sweepIsUsable(sweep));

  let rafId: number | null = null;
  function poll() {
    const e = engineCtx.get();
    if (e && node) {
      const s = e.read(node, 'snapshot') as GamepadSnapshot | undefined;
      if (s) {
        snapshot = s;
        if (calibrating && s.connected) {
          recordCalibrationSample(sweep, s.rawLeftX, s.rawLeftY);
          // Reassign a shallow copy so the $derived/readout re-evaluate.
          sweep = { ...sweep };
        }
        // Armed remap: diff the raw reading against the captured baseline and
        // bind the first control the user moves/presses past the threshold.
        if (remap && s.connected) {
          const cur = s.raw;
          if (!remap.baseline) {
            // Seed the baseline on the first armed frame (a diff needs a prev).
            remap = { ...remap, baseline: cur };
          } else {
            const hit = detectChangedControl(remap.baseline, cur, { only: remap.only });
            if (hit) commitRemap(remap.outputId, hit);
          }
        }
      }
    }
    rafId = requestAnimationFrame(poll);
  }
  onMount(() => {
    rafId = requestAnimationFrame(poll);
    window.addEventListener('keydown', onKeydown);
  });
  onDestroy(() => {
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = null;
    window.removeEventListener('keydown', onKeydown);
    if (remapTimer !== null) clearTimeout(remapTimer);
  });

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && remap) { e.preventDefault(); cancelRemap(); }
  }

  function startCalibration() {
    sweep = newCalibrationSweep();
    calibrating = true;
  }
  function cancelCalibration() {
    calibrating = false;
    sweep = newCalibrationSweep();
  }
  /** Lock in the swept range as a ONE-TIME synced write to node.data, then
   *  leave calibration mode. The factory's poll picks up the new calibration
   *  on its next frame. */
  function completeCalibration() {
    const cal = finalizeCalibration(sweep);
    if (cal) {
      // SINGLE committed write — never per frame. mutateNode rides the Y.Doc
      // (collab + undo) and mutates node.data IN PLACE (never reassigns an
      // integrated Y type).
      mutateNode(id, (live) => {
        if (!live.data) live.data = {};
        (live.data as GamepadData).leftStickCalibration = cal;
      });
    }
    calibrating = false;
    sweep = newCalibrationSweep();
  }
  /** Clear the committed calibration (revert to the fixed-deadzone path). */
  function clearCalibration() {
    mutateNode(id, (live) => {
      if (live.data) delete (live.data as GamepadData).leftStickCalibration;
    });
  }

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

  // Button-LED indicator labels mirror the PORT labels from GAMEPAD_OUTPUTS
  // so what you see on the button row (⬆⬇⬅⮕ for d-pad, LB/RB/A/B/X/Y for
  // face/shoulder, STA/SEL for start/back) matches what you see on the patch
  // jack labels. Pre-fix the LED row hard-coded uppercase ids (LB RB A B X Y
  // DU DD DL DR START BACK) while the output ports for d-pad rendered the
  // U+2B0x chevron family — that mismatch is the bug #1 the user reported.
  // Ordered to match the original 12-button grid: shoulders + face + d-pad +
  // start/back. Reading GAMEPAD_OUTPUTS so a future label edit in the engine
  // def auto-propagates here.
  const BUTTON_LED_IDS = ['lb','rb','a','b','x','y','du','dd','dl','dr','start','back'] as const;
  const buttonLeds: { id: string; label: string }[] = BUTTON_LED_IDS.map((bid) => {
    const out = GAMEPAD_OUTPUTS.find((o) => o.id === bid);
    return { id: bid, label: out?.label ?? bid.toUpperCase() };
  });

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
      <!-- Armed remap affordance: a "listening…" banner while a remap is armed,
           naming the output being rebound + how to cancel. -->
      {#if remap}
        <div class="remap-banner" data-testid="gamepad-remap-banner" role="status">
          <span class="remap-dot" aria-hidden="true"></span>
          <span class="remap-text">
            listening… {remap.only === 'axis' ? 'move an axis' : 'press a control'}
            to bind <b>{remap.label}</b> (Esc to cancel)
          </span>
          <button type="button" class="remap-cancel" onclick={cancelRemap} data-testid="gamepad-remap-cancel">✕</button>
        </div>
      {/if}

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
          <!-- Separate "Remap X / Remap Y" buttons (the user-preferred axis path:
               one axis at a time, no listen-for-both ambiguity). -->
          <div class="remap-xy">
            <button
              type="button"
              class="remap-btn"
              class:armed={remap?.outputId === 'lx'}
              class:bound={isRemapped('lx')}
              onclick={() => armRemap('lx', 'axis', 'L-X')}
              title={isRemapped('lx') ? `L-X ← ${bindingLabel('lx')} (right-click to reset)` : 'remap left-stick X axis'}
              oncontextmenu={(e) => { e.preventDefault(); clearRemap('lx'); }}
              data-testid="gamepad-remap-lx"
            >X</button>
            <button
              type="button"
              class="remap-btn"
              class:armed={remap?.outputId === 'ly'}
              class:bound={isRemapped('ly')}
              onclick={() => armRemap('ly', 'axis', 'L-Y')}
              title={isRemapped('ly') ? `L-Y ← ${bindingLabel('ly')} (right-click to reset)` : 'remap left-stick Y axis'}
              oncontextmenu={(e) => { e.preventDefault(); clearRemap('ly'); }}
              data-testid="gamepad-remap-ly"
            >Y</button>
          </div>
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
          <div class="remap-xy">
            <button
              type="button"
              class="remap-btn"
              class:armed={remap?.outputId === 'rx'}
              class:bound={isRemapped('rx')}
              onclick={() => armRemap('rx', 'axis', 'R-X')}
              title={isRemapped('rx') ? `R-X ← ${bindingLabel('rx')} (right-click to reset)` : 'remap right-stick X axis'}
              oncontextmenu={(e) => { e.preventDefault(); clearRemap('rx'); }}
              data-testid="gamepad-remap-rx"
            >X</button>
            <button
              type="button"
              class="remap-btn"
              class:armed={remap?.outputId === 'ry'}
              class:bound={isRemapped('ry')}
              onclick={() => armRemap('ry', 'axis', 'R-Y')}
              title={isRemapped('ry') ? `R-Y ← ${bindingLabel('ry')} (right-click to reset)` : 'remap right-stick Y axis'}
              oncontextmenu={(e) => { e.preventDefault(); clearRemap('ry'); }}
              data-testid="gamepad-remap-ry"
            >Y</button>
          </div>
        </div>
      </div>

      <!-- Left-stick calibration. Off-mode: a single "calibrate left stick"
           button (+ a "calibrated" badge / clear when one is committed). In
           mode: a sweep banner with live min/max + "complete" (gated until the
           sweep is usable) and "cancel". -->
      <div class="calib" data-testid="gamepad-calib">
        {#if !calibrating}
          <button
            type="button"
            class="calib-btn"
            onclick={startCalibration}
            data-testid="gamepad-calibrate-start"
          >calibrate left stick</button>
          {#if snapshot.calibrated}
            <span class="calib-badge" data-testid="gamepad-calibrated">calibrated</span>
            <button
              type="button"
              class="calib-clear"
              onclick={clearCalibration}
              data-testid="gamepad-calibrate-clear"
              title="clear calibration"
            >✕</button>
          {/if}
        {:else}
          <div class="calib-mode" data-testid="gamepad-calib-mode">
            <div class="calib-hint">sweep the left stick through its full range…</div>
            <div class="calib-range">
              x [{Number.isFinite(sweep.minX) ? sweep.minX.toFixed(2) : '–'}, {Number.isFinite(sweep.maxX) ? sweep.maxX.toFixed(2) : '–'}]
              · y [{Number.isFinite(sweep.minY) ? sweep.minY.toFixed(2) : '–'}, {Number.isFinite(sweep.maxY) ? sweep.maxY.toFixed(2) : '–'}]
            </div>
            <div class="calib-actions">
              <button
                type="button"
                class="calib-btn complete"
                disabled={!canComplete}
                onclick={completeCalibration}
                data-testid="gamepad-calibrate-complete"
              >complete calibration</button>
              <button
                type="button"
                class="calib-cancel"
                onclick={cancelCalibration}
                data-testid="gamepad-calibrate-cancel"
              >cancel</button>
            </div>
          </div>
        {/if}
      </div>

      <!-- Triggers — right-click a label to arm a button-remap (next press binds
           it); the bar shows the live 0..1. -->
      <div class="triggers">
        <div class="trig-row">
          <button
            type="button"
            class="trig-label remappable"
            class:armed={remap?.outputId === 'lt'}
            class:bound={isRemapped('lt')}
            oncontextmenu={(e) => { e.preventDefault(); armRemap('lt', 'button', 'LT'); }}
            onclick={(e) => { if (e.altKey) clearRemap('lt'); }}
            title={isRemapped('lt') ? `LT ← ${bindingLabel('lt')} (alt-click to reset)` : 'right-click to remap LT'}
            data-testid="gamepad-remap-lt"
          >LT{#if isRemapped('lt')}<span class="remap-mark" aria-hidden="true">●</span>{/if}</button>
          <div class="trig-bar"><div class="trig-fill" style="width: {(snapshot.values.lt ?? 0) * 100}%"></div></div>
        </div>
        <div class="trig-row">
          <button
            type="button"
            class="trig-label remappable"
            class:armed={remap?.outputId === 'rt'}
            class:bound={isRemapped('rt')}
            oncontextmenu={(e) => { e.preventDefault(); armRemap('rt', 'button', 'RT'); }}
            onclick={(e) => { if (e.altKey) clearRemap('rt'); }}
            title={isRemapped('rt') ? `RT ← ${bindingLabel('rt')} (alt-click to reset)` : 'right-click to remap RT'}
            data-testid="gamepad-remap-rt"
          >RT{#if isRemapped('rt')}<span class="remap-mark" aria-hidden="true">●</span>{/if}</button>
          <div class="trig-bar"><div class="trig-fill" style="width: {(snapshot.values.rt ?? 0) * 100}%"></div></div>
        </div>
      </div>

      <!-- Button LEDs — right-click a tile to arm a button-remap (next physical
           press binds that output); alt-click resets to the default. A small
           corner mark shows a remapped output. -->
      <div class="buttons">
        {#each buttonLeds as btn (btn.id)}
          <button
            type="button"
            class="btn-led remappable"
            class:on={(snapshot.values[btn.id] ?? 0) >= 0.5}
            class:armed={remap?.outputId === btn.id}
            class:bound={isRemapped(btn.id)}
            oncontextmenu={(e) => { e.preventDefault(); armRemap(btn.id, 'button', btn.label); }}
            onclick={(e) => { if (e.altKey) clearRemap(btn.id); }}
            title={isRemapped(btn.id) ? `${btn.label} ← ${bindingLabel(btn.id)} (alt-click to reset)` : `right-click to remap ${btn.label}`}
            data-testid="gamepad-remap-{btn.id}"
          >{btn.label}{#if isRemapped(btn.id)}<span class="remap-mark" aria-hidden="true">●</span>{/if}</button>
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

  .calib {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .calib-btn {
    appearance: none;
    background: rgba(10, 12, 16, 0.7);
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
    font-size: 0.6rem;
    padding: 4px 8px;
    cursor: pointer;
    transition: background 60ms ease-out, color 60ms ease-out, border-color 60ms ease-out;
  }
  .calib-btn:hover { border-color: var(--accent-dim); color: var(--text); }
  .calib-btn.complete {
    background: var(--accent, #00f0ff);
    border-color: var(--accent, #00f0ff);
    color: #000;
  }
  .calib-btn.complete:disabled {
    background: rgba(10, 12, 16, 0.7);
    border-color: var(--border);
    color: var(--text-dim);
    cursor: not-allowed;
    opacity: 0.6;
  }
  .calib-badge {
    font-size: 0.55rem;
    font-family: ui-monospace, monospace;
    color: var(--accent, #00f0ff);
    letter-spacing: 0.04em;
  }
  .calib-clear {
    appearance: none;
    background: transparent;
    border: none;
    color: var(--text-dim);
    cursor: pointer;
    font-size: 0.7rem;
    line-height: 1;
    padding: 0 2px;
  }
  .calib-clear:hover { color: var(--text); }
  .calib-mode {
    display: flex;
    flex-direction: column;
    gap: 4px;
    width: 100%;
  }
  .calib-hint {
    font-size: 0.58rem;
    font-family: ui-monospace, monospace;
    color: var(--accent, #00f0ff);
  }
  .calib-range {
    font-size: 0.55rem;
    font-family: ui-monospace, monospace;
    color: var(--text-dim);
  }
  .calib-actions { display: flex; gap: 6px; }
  .calib-cancel {
    appearance: none;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
    font-size: 0.6rem;
    padding: 4px 8px;
    cursor: pointer;
  }
  .calib-cancel:hover { border-color: var(--accent-dim); color: var(--text); }

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
    width: 22px;
  }
  /* trig-label is a <button> (remappable) — strip default chrome. */
  button.trig-label {
    appearance: none;
    background: transparent;
    border: none;
    padding: 0;
    text-align: left;
    cursor: pointer;
    position: relative;
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
    position: relative;
    appearance: none;
    text-align: center;
    font-size: 0.55rem;
    font-family: ui-monospace, monospace;
    font-weight: 600;
    padding: 3px 0;
    background: rgba(10, 12, 16, 0.7);
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text-dim);
    cursor: pointer;
    transition: background 60ms ease-out, color 60ms ease-out, border-color 60ms ease-out;
  }
  .btn-led.on {
    background: var(--cable-gate, #ffd000);
    border-color: var(--cable-gate, #ffd000);
    color: #000;
  }

  /* ── REMAP affordances ── */
  .remap-banner {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 6px;
    background: rgba(0, 240, 255, 0.08);
    border: 1px solid var(--accent, #00f0ff);
    border-radius: 3px;
    font-size: 0.55rem;
    font-family: ui-monospace, monospace;
    color: var(--accent, #00f0ff);
  }
  .remap-dot {
    width: 7px; height: 7px; border-radius: 50%;
    background: var(--accent, #00f0ff);
    box-shadow: 0 0 6px var(--accent, #00f0ff);
    animation: remap-pulse 0.9s ease-in-out infinite;
    flex: 0 0 auto;
  }
  @keyframes remap-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.25; } }
  .remap-text { flex: 1; line-height: 1.3; }
  .remap-cancel {
    appearance: none;
    background: transparent;
    border: none;
    color: var(--accent, #00f0ff);
    cursor: pointer;
    font-size: 0.7rem;
    line-height: 1;
    padding: 0 2px;
    flex: 0 0 auto;
  }
  .remap-xy {
    display: flex;
    gap: 3px;
    margin-top: 2px;
  }
  .remap-btn {
    appearance: none;
    background: rgba(10, 12, 16, 0.7);
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
    font-size: 0.55rem;
    line-height: 1;
    padding: 2px 6px;
    cursor: pointer;
    transition: background 60ms ease-out, color 60ms ease-out, border-color 60ms ease-out;
  }
  .remap-btn:hover { border-color: var(--accent-dim); color: var(--text); }
  .remap-btn.bound { border-color: var(--accent, #00f0ff); color: var(--accent, #00f0ff); }
  .remappable.armed,
  .remap-btn.armed {
    border-color: var(--accent, #00f0ff);
    box-shadow: 0 0 0 1px var(--accent-glow, rgba(0, 240, 255, 0.5));
    animation: remap-pulse 0.9s ease-in-out infinite;
  }
  .remap-mark {
    position: absolute;
    top: 1px; right: 2px;
    font-size: 0.4rem;
    line-height: 1;
    color: var(--accent, #00f0ff);
  }
  .trig-label.bound { color: var(--accent, #00f0ff); }

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

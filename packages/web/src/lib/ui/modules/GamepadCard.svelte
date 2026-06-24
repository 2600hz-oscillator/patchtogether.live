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
    applyBindingToData,
    clearBindingOnData,
    bindingForOutput,
    describeControl,
    toggleInvertOnData,
    CALIBRATION_DEADZONE,
    type StickCalibration,
    type StickInvert,
    type InvertibleAxis,
    type RawGamepadReading,
    type RemapBindings,
    type PhysicalControl,
    exportMapping,
    applyMapping,
    isGamepadMapping,
    GAMEPAD_PRESETS,
    type GamepadMapping,
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
    rawRightX: 0,
    rawRightY: 0,
    calibrated: false,
    rightCalibrated: false,
    raw: { axes: [], buttons: [] },
    bindings: {},
    invert: {},
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
   *  node.data write (rides the Y.Doc → collab + undo). The in-place mutation
   *  lives in `applyBindingToData` (gamepad.ts) — it assigns FRESH plain value
   *  objects and never re-assigns an already-integrated Y type, which is the trap
   *  that threw out of this rAF poll and killed all output after a 2nd remap. */
  function commitRemap(outputId: string, control: PhysicalControl) {
    mutateNode(id, (live) => {
      if (!live.data) live.data = {};
      applyBindingToData(live.data as GamepadData, outputId, control);
    });
    cancelRemap();
  }
  /** Clear a single output's override (revert to its default control). */
  function clearRemap(outputId: string) {
    mutateNode(id, (live) => {
      if (live.data) clearBindingOnData(live.data as GamepadData, outputId);
    });
  }

  // ---------------- per-axis INVERT toggles ----------------
  // Four small toggle buttons — left-X, left-Y, right-X, right-Y — flip the
  // direction of whatever physical axis is mapped to that output (v → -v at read
  // time). The flag is committed as a SINGLE in-place node.data write (rides the
  // Y.Doc → collab + undo) and the factory reads it each frame, so it composes on
  // top of a remap. Live state is read off the snapshot the factory publishes.
  let invert = $derived<StickInvert>(snapshot.invert ?? {});
  function isInverted(axisId: InvertibleAxis): boolean {
    return !!invert[axisId];
  }
  function toggleInvert(axisId: InvertibleAxis) {
    mutateNode(id, (live) => {
      if (!live.data) live.data = {};
      toggleInvertOnData(live.data as GamepadData, axisId);
    });
  }

  // ---------------- per-stick SET CENTER (true-resting-centre re-zero) ----------------
  // SYMMETRIC (both sticks). A one-click re-zero: capture the stick's CURRENT
  // resting raw axes as its calibration's true rest centre (centerX/centerY), so
  // a stick that physically RESTS off-centre (e.g. a Gladiator secondary
  // thumbstick) reads 0 at rest. This is the same true-resting-centre the
  // calibration sweep captures, exposed as a convenient standalone affordance.
  // A SINGLE in-place node.data write (rides the Y.Doc → collab + undo): when a
  // calibration already exists we mutate its centerX/centerY IN PLACE (never
  // reassign an integrated Y type); when none exists we create a fresh full-range
  // calibration carrying the captured centre, so the re-zero works standalone.
  function setCenter(stick: 'left' | 'right') {
    const rawX = stick === 'left' ? snapshot.rawLeftX : snapshot.rawRightX;
    const rawY = stick === 'left' ? snapshot.rawLeftY : snapshot.rawRightY;
    const cx = Number.isFinite(rawX) ? rawX : 0;
    const cy = Number.isFinite(rawY) ? rawY : 0;
    mutateNode(id, (live) => {
      if (!live.data) live.data = {};
      const d = live.data as GamepadData;
      const existing = stick === 'left' ? d.leftStickCalibration : d.rightStickCalibration;
      if (existing) {
        // Mutate the existing (possibly integrated) leaf IN PLACE — set only the
        // numeric centre keys, never re-assign the whole object.
        existing.centerX = cx;
        existing.centerY = cy;
      } else {
        // No calibration yet — create a fresh full-range one carrying the centre
        // so the re-zero applies even without a sweep.
        const cal: StickCalibration = {
          minX: -1, maxX: 1, minY: -1, maxY: 1,
          deadzone: CALIBRATION_DEADZONE,
          centerX: cx, centerY: cy,
        };
        if (stick === 'left') d.leftStickCalibration = cal;
        else d.rightStickCalibration = cal;
      }
    });
  }

  // ---------------- stick calibration MODE (left + right) ----------------
  // Entering calibration MODE arms a live min/max sweep for ONE stick. Each poll
  // frame folds that stick's RAW axes (snapshot.rawLeftX/Y or rawRightX/Y) into
  // the sweep — this is TRANSIENT render state, NOT a synced write (a per-frame
  // Y.Doc write is the render-storm bug class). Only the FINAL committed
  // calibration is written, once, to node.data on "complete calibration". The
  // sweep math + record shape are identical per stick; only which raw axes feed
  // it + which node.data field it commits to differ.
  let calibrating = $state<'left' | 'right' | null>(null);
  // Mutated in place every frame; reassigned to a fresh object to nudge Svelte
  // reactivity for the live min/max readout + the "complete" enabled gate.
  let sweep = $state<CalibrationSweep>(newCalibrationSweep());
  let canComplete = $derived(!!calibrating && sweepIsUsable(sweep));

  let rafId: number | null = null;
  function poll() {
    const e = engineCtx.get();
    if (e && node) {
      const s = e.read(node, 'snapshot') as GamepadSnapshot | undefined;
      if (s) {
        snapshot = s;
        if (calibrating && s.connected) {
          // Fold the ACTIVE stick's raw axes into the sweep.
          const rx = calibrating === 'left' ? s.rawLeftX : s.rawRightX;
          const ry = calibrating === 'left' ? s.rawLeftY : s.rawRightY;
          recordCalibrationSample(sweep, rx, ry);
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
    if (mappingStatusTimer !== null) clearTimeout(mappingStatusTimer);
  });

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && remap) { e.preventDefault(); cancelRemap(); }
  }

  // The stick's TRUE resting raw position, sampled the instant the user clicks
  // Calibrate (the stick is at rest then). Threaded into finalizeCalibration so
  // the committed calibration zeroes the stick at its ACTUAL rest — not the swept
  // midpoint, which only equals rest for a spring-centred stick.
  let restCenter = $state<{ x: number; y: number } | null>(null);
  function startCalibration(stick: 'left' | 'right') {
    sweep = newCalibrationSweep();
    const rawX = stick === 'left' ? snapshot.rawLeftX : snapshot.rawRightX;
    const rawY = stick === 'left' ? snapshot.rawLeftY : snapshot.rawRightY;
    // Capture the rest sample only when it's clean/finite; finalizeCalibration
    // falls back to the swept midpoint per-component when absent (never NaN).
    restCenter = (Number.isFinite(rawX) && Number.isFinite(rawY))
      ? { x: rawX, y: rawY }
      : null;
    calibrating = stick;
  }
  function cancelCalibration() {
    calibrating = null;
    sweep = newCalibrationSweep();
    restCenter = null;
  }
  /** Lock in the swept range as a ONE-TIME synced write to node.data (the active
   *  stick's calibration field), then leave calibration mode. The factory's poll
   *  picks up the new calibration on its next frame. */
  function completeCalibration() {
    const stick = calibrating;
    const cal = finalizeCalibration(sweep, CALIBRATION_DEADZONE, restCenter ?? undefined);
    if (cal && stick) {
      // SINGLE committed write — never per frame. mutateNode rides the Y.Doc
      // (collab + undo) and mutates node.data IN PLACE (never reassigns an
      // integrated Y type — a calibration record is a leaf plain object).
      mutateNode(id, (live) => {
        if (!live.data) live.data = {};
        const d = live.data as GamepadData;
        if (stick === 'left') d.leftStickCalibration = cal;
        else d.rightStickCalibration = cal;
      });
    }
    calibrating = null;
    sweep = newCalibrationSweep();
    restCenter = null;
  }
  /** Clear ONE stick's committed calibration (revert to the fixed-deadzone path). */
  function clearCalibration(stick: 'left' | 'right') {
    mutateNode(id, (live) => {
      if (!live.data) return;
      const d = live.data as GamepadData;
      if (stick === 'left') delete d.leftStickCalibration;
      else delete d.rightStickCalibration;
    });
  }

  // ---------------- SAVE / LOAD mapping + presets ----------------
  // A "mapping" is the full user-configurable control state (bindings, invert,
  // both stick calibrations) as one serializable bundle. Save downloads it as
  // JSON; Load (from file) + Load preset both funnel through applyMapping — a
  // SINGLE in-place node.data write (rides the Y.Doc → collab + undo), following
  // the same fresh-object discipline as the remap commit so it can't throw out of
  // the rAF poll. A transient status line surfaces success/ignored-garbage.
  let mappingStatus = $state<string | null>(null);
  let mappingStatusTimer: ReturnType<typeof setTimeout> | null = null;
  function flashStatus(msg: string) {
    mappingStatus = msg;
    if (mappingStatusTimer !== null) clearTimeout(mappingStatusTimer);
    mappingStatusTimer = setTimeout(() => { mappingStatus = null; }, 4000);
  }

  /** "Save mapping" → download the current mapping as a .json file. Mirrors the
   *  Blob + anchor download idiom used elsewhere (Canvas exportPerformanceZip). */
  function saveMapping() {
    const data = (patch.nodes[id]?.data ?? {}) as GamepadData;
    const mapping = exportMapping(data);
    try {
      const json = JSON.stringify(mapping, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'gamepad-mapping.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch { /* */ } }, 60_000);
      flashStatus('mapping saved');
    } catch (e) {
      flashStatus(`save failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Apply a mapping onto the live node.data via the single in-place mutation
   *  (collab + undo). applyMapping sanitises garbage internally, but we never let
   *  a throw escape into the rAF poll. */
  function applyMappingToNode(mapping: GamepadMapping) {
    mutateNode(id, (live) => {
      if (!live.data) live.data = {};
      applyMapping(live.data as GamepadData, mapping);
    });
  }

  /** "Load mapping" file picker → parse + validate JSON, then applyMapping.
   *  Garbage/unknown is ignored gracefully (never throws into the poll). */
  async function onMappingFile(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed: unknown = JSON.parse(text);
      if (!isGamepadMapping(parsed)) {
        flashStatus('ignored: not a gamepad mapping');
        return;
      }
      applyMappingToNode(parsed as GamepadMapping);
      flashStatus(`loaded ${file.name}`);
    } catch {
      flashStatus('ignored: invalid JSON');
    } finally {
      try { input.value = ''; } catch { /* */ }
    }
  }

  /** "Load preset…" select → applyMapping the chosen built-in preset's mapping. */
  let presetSel = $state('');
  function onPresetSelect(ev: Event) {
    const name = (ev.target as HTMLSelectElement).value;
    presetSel = '';
    if (!name) return;
    const preset = GAMEPAD_PRESETS.find((p) => p.name === name);
    if (!preset) return;
    applyMappingToNode(preset.mapping);
    flashStatus(`loaded preset: ${name}`);
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
          <!-- Per-axis INVERT toggles: flip the direction of the mapped axis. -->
          <div class="invert-xy">
            <span class="invert-label" aria-hidden="true">inv</span>
            <button
              type="button"
              class="invert-btn"
              class:on={isInverted('lx')}
              aria-pressed={isInverted('lx')}
              onclick={() => toggleInvert('lx')}
              title="invert left-stick X"
              data-testid="gamepad-invert-lx"
            >x</button>
            <button
              type="button"
              class="invert-btn"
              class:on={isInverted('ly')}
              aria-pressed={isInverted('ly')}
              onclick={() => toggleInvert('ly')}
              title="invert left-stick Y"
              data-testid="gamepad-invert-ly"
            >y</button>
          </div>
          <!-- SET CENTER: capture the stick's current resting position as its true
               centre (centerX/centerY) so an off-centre-resting stick reads 0. -->
          <div class="zero-xy">
            <button
              type="button"
              class="zero-btn"
              onclick={() => setCenter('left')}
              title="capture current left-stick position as centre"
              data-testid="gamepad-left-setcenter"
            >set center</button>
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
          <!-- Per-axis INVERT toggles: flip the direction of the mapped axis. -->
          <div class="invert-xy">
            <span class="invert-label" aria-hidden="true">inv</span>
            <button
              type="button"
              class="invert-btn"
              class:on={isInverted('rx')}
              aria-pressed={isInverted('rx')}
              onclick={() => toggleInvert('rx')}
              title="invert right-stick X"
              data-testid="gamepad-invert-rx"
            >x</button>
            <button
              type="button"
              class="invert-btn"
              class:on={isInverted('ry')}
              aria-pressed={isInverted('ry')}
              onclick={() => toggleInvert('ry')}
              title="invert right-stick Y"
              data-testid="gamepad-invert-ry"
            >y</button>
          </div>
          <!-- SET CENTER: capture the stick's current resting position as its true
               centre (centerX/centerY) so an off-centre-resting thumbstick reads 0. -->
          <div class="zero-xy">
            <button
              type="button"
              class="zero-btn"
              onclick={() => setCenter('right')}
              title="capture current right-stick position as centre"
              data-testid="gamepad-right-setcenter"
            >set center</button>
          </div>
        </div>
      </div>

      <!-- Stick calibration (left + right, symmetric). Off-mode: a "calibrate"
           button per stick (+ a "calibrated" badge / clear when one is
           committed). In mode (one stick at a time): a sweep banner naming the
           active stick with live min/max + "complete" (gated until the sweep is
           usable) and "cancel". -->
      <div class="calib" data-testid="gamepad-calib">
        {#if !calibrating}
          <div class="calib-stick">
            <button
              type="button"
              class="calib-btn"
              onclick={() => startCalibration('left')}
              data-testid="gamepad-calibrate-start"
            >calibrate left stick</button>
            {#if snapshot.calibrated}
              <span class="calib-badge" data-testid="gamepad-calibrated">calibrated</span>
              <button
                type="button"
                class="calib-clear"
                onclick={() => clearCalibration('left')}
                data-testid="gamepad-calibrate-clear"
                title="clear left calibration"
              >✕</button>
            {/if}
          </div>
          <div class="calib-stick">
            <button
              type="button"
              class="calib-btn"
              onclick={() => startCalibration('right')}
              data-testid="gamepad-calibrate-start-right"
            >calibrate right stick</button>
            {#if snapshot.rightCalibrated}
              <span class="calib-badge" data-testid="gamepad-calibrated-right">calibrated</span>
              <button
                type="button"
                class="calib-clear"
                onclick={() => clearCalibration('right')}
                data-testid="gamepad-calibrate-clear-right"
                title="clear right calibration"
              >✕</button>
            {/if}
          </div>
        {:else}
          <div class="calib-mode" data-testid="gamepad-calib-mode">
            <div class="calib-hint">sweep the {calibrating} stick through its full range…</div>
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

      <!-- Save / Load mapping + built-in presets. A "mapping" bundles the full
           control config (remaps, inverts, both calibrations). Save downloads
           JSON; Load (file) + Load preset both apply via applyMapping. -->
      <div class="mapping" data-testid="gamepad-mapping">
        <button
          type="button"
          class="mapping-btn"
          onclick={saveMapping}
          data-testid="gamepad-save-mapping"
          title="download the current control mapping as JSON"
        >save mapping</button>
        <label class="mapping-btn mapping-load" title="load a control mapping from a .json file">
          <input
            type="file"
            accept=".json,application/json"
            onchange={onMappingFile}
            data-testid="gamepad-load-mapping-input"
          />
          <span>load mapping…</span>
        </label>
        <select
          class="mapping-preset"
          bind:value={presetSel}
          onchange={onPresetSelect}
          data-testid="gamepad-preset-select"
          title="load a built-in preset mapping"
        >
          <option value="">load preset…</option>
          {#each GAMEPAD_PRESETS as p (p.name)}
            <option value={p.name}>{p.name}</option>
          {/each}
        </select>
      </div>
      {#if mappingStatus}
        <div class="mapping-status" data-testid="gamepad-mapping-status">{mappingStatus}</div>
      {/if}

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
    flex-direction: column;
    gap: 4px;
  }
  .calib-stick {
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

  /* ── SAVE / LOAD mapping + presets ── */
  .mapping {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .mapping-btn {
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
  .mapping-btn:hover { border-color: var(--accent-dim); color: var(--text); }
  .mapping-load {
    position: relative;
    overflow: hidden;
    display: inline-flex;
    align-items: center;
  }
  .mapping-load input[type='file'] {
    position: absolute;
    inset: 0;
    opacity: 0;
    cursor: pointer;
    font-size: 0; /* keep the native control from blowing out the label box */
  }
  .mapping-preset {
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
  .mapping-preset:hover { border-color: var(--accent-dim); color: var(--text); }
  .mapping-status {
    font-size: 0.55rem;
    font-family: ui-monospace, monospace;
    color: var(--accent, #00f0ff);
    letter-spacing: 0.02em;
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
  .invert-xy {
    display: flex;
    align-items: center;
    gap: 3px;
    margin-top: 2px;
  }
  .invert-label {
    font-size: 0.5rem;
    font-family: ui-monospace, monospace;
    color: var(--text-dim);
    letter-spacing: 0.04em;
  }
  .invert-btn {
    appearance: none;
    background: rgba(10, 12, 16, 0.7);
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
    font-size: 0.55rem;
    line-height: 1;
    padding: 2px 5px;
    cursor: pointer;
    transition: background 60ms ease-out, color 60ms ease-out, border-color 60ms ease-out;
  }
  .invert-btn:hover { border-color: var(--accent-dim); color: var(--text); }
  .invert-btn.on {
    background: var(--accent, #00f0ff);
    border-color: var(--accent, #00f0ff);
    color: #000;
  }
  .zero-xy {
    display: flex;
    align-items: center;
    gap: 3px;
    margin-top: 2px;
  }
  .zero-btn {
    appearance: none;
    background: rgba(10, 12, 16, 0.7);
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
    font-size: 0.55rem;
    line-height: 1;
    padding: 2px 5px;
    cursor: pointer;
    transition: background 60ms ease-out, color 60ms ease-out, border-color 60ms ease-out;
  }
  .zero-btn:hover { border-color: var(--accent-dim); color: var(--text); }
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

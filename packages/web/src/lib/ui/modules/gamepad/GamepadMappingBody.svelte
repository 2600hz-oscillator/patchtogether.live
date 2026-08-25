<script lang="ts">
  // GamepadMappingBody — THE CONTROLLER MAPPING BOARD, at the head of the dock
  // full view.
  //
  // ── WHAT IT IS ──────────────────────────────────────────────────────────────
  //
  // The module's OUTPUT is eighteen CV/gate jacks. Its INTERACTION is something
  // else entirely: making a non-standard controller behave like a standard one,
  // in three layers that each exist because a real device failed the one below.
  // REMAP (right-click a cell, then move the physical control you want bound —
  // the Gamepad API has no events, so the armed listener DIFFS consecutive polls
  // and takes the first thing past a threshold), CALIBRATE (sweep a stick; its
  // observed min/max become full ±1, with a captured true rest centre so a stick
  // that physically rests off-centre reads 0), and INVERT (four sign flips that
  // compose on top of both). The verb is TEACH THE RACK WHAT THIS STICK IS, and
  // the result saves to a `.json` you can share.
  //
  // ⚠ EVERY ONE OF THOSE GESTURES IS BLIND WITHOUT THE ECHO. You cannot tell
  // whether the remap took the axis you meant, or whether your sweep reached the
  // corners, from anything but watching the device. The two stick pads, the two
  // trigger bars and the twelve LEDs are that feedback — and they are a picture
  // of the CELL'S OWN STATE, not a preview of something elsewhere, which is
  // exactly why the declared role is `control-grid` and not `picture`.
  //
  // ── WHY A BODY RATHER THAN CELLS, mechanically ─────────────────────────────
  //
  // The ladder says reach for a shared cell first. Each rung refuses this
  // surface for a reason, not for taste:
  //
  //   * A `<familyId>-{n}` FAMILY CELL resolves to ONE ranked cell however many
  //     members the family has (matrixMix's one-member families are the shipped
  //     shape). `gamepad-led-{n}` would put a single cell in the lane standing
  //     for twelve LEDs, which says nothing a player can act on.
  //   * A PF-14 `panel` CELL requires a `minWidth` NUMBER and a probe drawn from
  //     `data` / `data-rev` / `text`. This surface is a twelve-cell grid or a
  //     calibration banner depending on mode, and the observable of an armed
  //     remap is A PHYSICAL BUTTON PRESS ON HARDWARE NO RUNNER HAS — so a probe
  //     could only have shipped by inventing a control the module does not have
  //     (the samsloop-waveform argument, from the other side).
  //   * SAVE MAPPING is a DOWNLOAD. `ShellActionCell.probe` is required and its
  //     vocabulary is an audition seam or a graph write; a file leaving the
  //     browser is neither, so it is not expressible as a probed action cell.
  //   * LOAD MAPPING genuinely could be a `ShellFileCell` — and it is the one
  //     third of a three-button row. Splitting it out would put a `.json`
  //     importer alone on a 192 px lane tile with no way to SAVE beside it and
  //     no preset picker, which is one workflow rendered in two places.
  //
  // ── ⚠ WHAT PROMOTION DELETED, AND WHERE EACH FINDING WENT ──────────────────
  //
  // Six text rows on `GamepadCard.svelte` do not come across. None of them is
  // merely hidden; each one's FINDING has a named home:
  //
  //   `snapshot.id` / "press any button to connect"  → the PAD lamp's `detail`
  //     (`aria-label`/`title`), plus the instruction as EMPTY-STATE copy. A
  //     device name painted outside every control, restating what is bound and
  //     CHANGING with state, is the exact shape `StatusLed` was built to make
  //     inexpressible.
  //   two `calibrated` badges                        → the CAL L / CAL R lamps.
  //     A state word about the module.
  //   the live sweep range `x [-0.98, 0.97] · …`     → DRAWN, not printed: the
  //     sweep's extent is a rectangle inside the stick pad, in the same
  //     coordinate system as the live dot. See `sweepBox`. The numbers survive
  //     on the pad's `aria-label`.
  //   "sweep the {calibrating} stick through…"       → the armed pad's own
  //     visual state plus that same accessible name.
  //   the save/load STATUS LINE (a 4 s toast)        → the MAPPING lamp, whose
  //     `tone` separates SUCCESS from REJECTED in COLOUR and which is MORE
  //     persistent than the toast was.
  //   every hover-title string                       → the SAME sentence on
  //     `aria-label`, permanently. Nothing is lost; it stops being mouse-only.
  //
  // ⚠ THE OLD SPELLINGS ARE NOT QUOTED ABOVE. `gamepad-face-model.test.ts` greps
  // this file's SOURCE for them, and a source gate cannot tell code from a
  // comment — naming a deleted mechanism in prose reddens the gate that proves
  // it is gone. (The same trap caught the word for a raster surface, below.)
  //
  // ⚠ THE TWELVE LED CAPTIONS STAY, and they are read from `GAMEPAD_OUTPUTS`
  // rather than typed, so a label edit on the def auto-propagates here. They are
  // tidyVco's A/D/S/R argument at three times the scale: the only thing
  // separating twelve identical tiles.
  //
  // ⚠ EVERY ACCESSIBLE NAME COMES FROM `./gamepad-board-model`. Not tidiness —
  // `face-rack-status-source.test.ts`'s control-grid leg refuses an
  // `aria-label={EXPR}` whose SAME expression is also painted, and this body
  // paints `{btn.label}` on twelve tiles. Routing the names through named
  // functions makes the two expressions structurally different.
  //
  // ── ⚠ THE POLL, AND WHY THERE IS NO STATUS REGISTRY ────────────────────────
  //
  // There are TWO rAF polls and only this one is on a component. The ENGINE poll
  // lives in `gamepadDef.factory`, is torn down in `dispose()`, and is what
  // writes all eighteen `ConstantSourceNode.offset`s — so THE AUDIO NEVER
  // DEPENDS ON THIS SURFACE. Collapse the dock and the sticks keep driving every
  // patched output. cameraInput needed `camera-status-registry` because
  // promotion parks its real card in a `pointer-events: none` headless host and
  // the body needed the card's published state; `gamepad` is in neither
  // `DOM_SOURCE_LANE_TYPES` nor `CARD_PRODUCER_LANE_TYPES`, so no card is kept
  // alive anywhere and a registry here would introduce A SECOND OWNER of state
  // the engine node already owns.
  //
  // ⚠ THIS BODY OWNS ITS FRAME, ITS LISTENER AND ITS TIMER, AND RELEASES ALL
  // THREE. A body that subscribed without unsubscribing is the node-resource
  // leak class from the other side.
  //
  // ⚠ THE IN-PLACE Y.DOC DISCIPLINE IS LOAD-BEARING AND IS NOT REIMPLEMENTED
  // HERE. Every write goes through the def's own helpers (`applyBindingToData`,
  // `clearBindingOnData`, `toggleInvertOnData`, `applyMapping`), which delete
  // and re-set individual keys and never re-assign an integrated Y type —
  // "the trap that threw out of this rAF poll and killed all output after a 2nd
  // remap". Three named regression legs in `gamepad-remap-ydoc.test.ts` pin it.
  // Any body that rebuilt `data.bindings` would be a shipped crash.

  import { onDestroy, onMount } from 'svelte';
  import { patch } from '$lib/graph/store';
  import { mutateNode } from '$lib/graph/mutate';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { StatusLed } from '$lib/ui/controls';
  import type { ModuleNode } from '$lib/graph/types';
  import {
    CALIBRATION_DEADZONE,
    GAMEPAD_OUTPUTS,
    GAMEPAD_PRESETS,
    applyBindingToData,
    applyMapping,
    clearBindingOnData,
    detectChangedControl,
    exportMapping,
    finalizeCalibration,
    isGamepadMapping,
    newCalibrationSweep,
    recordCalibrationSample,
    sweepIsUsable,
    toggleInvertOnData,
    type CalibrationSweep,
    type GamepadData,
    type GamepadMapping,
    type GamepadSnapshot,
    type InvertibleAxis,
    type PhysicalControl,
    type RawGamepadReading,
    type StickCalibration,
  } from '$lib/audio/modules/gamepad';
  import {
    PAD_PX,
    calibrationDetail,
    dotX,
    dotY,
    invertSentence,
    mappingDetail,
    padDetail,
    remapSentence,
    stickSentence,
    sweepBox,
    triggerSentence,
    type MappingOutcome,
    type Stick,
  } from './gamepad-board-model';

  let { nodeId }: { nodeId: string } = $props();

  const engineCtx = useEngine();

  let cardV = $derived(nodeVersion(nodeId));
  let node = $derived<ModuleNode | undefined>(
    (void cardV, patch.nodes[nodeId] as ModuleNode | undefined),
  );

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

  let bindings = $derived(snapshot.bindings ?? {});
  let invert = $derived(snapshot.invert ?? {});

  // ---------------- REMAP (arm → detect → bind) ----------------
  const REMAP_TIMEOUT_MS = 8000;
  let remap = $state<{
    outputId: string;
    only: 'axis' | 'button';
    baseline: RawGamepadReading | null;
  } | null>(null);
  let remapTimer: ReturnType<typeof setTimeout> | null = null;

  function armRemap(outputId: string, only: 'axis' | 'button') {
    cancelRemap();
    // baseline=null → the next polled frame seeds it (the first diff needs a prev).
    remap = { outputId, only, baseline: null };
    remapTimer = setTimeout(cancelRemap, REMAP_TIMEOUT_MS);
  }
  function cancelRemap() {
    remap = null;
    if (remapTimer !== null) { clearTimeout(remapTimer); remapTimer = null; }
  }
  function commitRemap(outputId: string, control: PhysicalControl) {
    mutateNode(nodeId, (live) => {
      if (!live.data) live.data = {};
      applyBindingToData(live.data as GamepadData, outputId, control);
    });
    cancelRemap();
  }
  function clearRemap(outputId: string) {
    mutateNode(nodeId, (live) => {
      if (live.data) clearBindingOnData(live.data as GamepadData, outputId);
    });
  }

  function toggleInvert(axisId: InvertibleAxis) {
    mutateNode(nodeId, (live) => {
      if (!live.data) live.data = {};
      toggleInvertOnData(live.data as GamepadData, axisId);
    });
  }

  // ---------------- SET CENTER (true-resting-centre re-zero) ----------------
  function setCenter(stick: Stick) {
    const rawX = stick === 'left' ? snapshot.rawLeftX : snapshot.rawRightX;
    const rawY = stick === 'left' ? snapshot.rawLeftY : snapshot.rawRightY;
    const cx = Number.isFinite(rawX) ? rawX : 0;
    const cy = Number.isFinite(rawY) ? rawY : 0;
    mutateNode(nodeId, (live) => {
      if (!live.data) live.data = {};
      const d = live.data as GamepadData;
      const existing = stick === 'left' ? d.leftStickCalibration : d.rightStickCalibration;
      if (existing) {
        // IN PLACE — set only the numeric centre keys, never re-assign the leaf.
        existing.centerX = cx;
        existing.centerY = cy;
      } else {
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

  // ---------------- CALIBRATION MODE ----------------
  // The live sweep is TRANSIENT render state, never a per-frame Y.Doc write
  // (that is the render-storm bug class). Only the FINAL record is committed.
  let calibrating = $state<Stick | null>(null);
  let sweep = $state<CalibrationSweep>(newCalibrationSweep());
  let canComplete = $derived(!!calibrating && sweepIsUsable(sweep));
  let leftBox = $derived(calibrating === 'left' ? sweepBox(sweep) : null);
  let rightBox = $derived(calibrating === 'right' ? sweepBox(sweep) : null);

  function startCalibration(stick: Stick) {
    sweep = newCalibrationSweep();
    calibrating = stick;
  }
  function cancelCalibration() {
    calibrating = null;
    sweep = newCalibrationSweep();
  }
  function completeCalibration() {
    const stick = calibrating;
    const cal = finalizeCalibration(sweep, CALIBRATION_DEADZONE);
    if (cal && stick) {
      mutateNode(nodeId, (live) => {
        if (!live.data) live.data = {};
        const d = live.data as GamepadData;
        if (stick === 'left') d.leftStickCalibration = cal;
        else d.rightStickCalibration = cal;
      });
    }
    calibrating = null;
    sweep = newCalibrationSweep();
  }
  function clearCalibration(stick: Stick) {
    mutateNode(nodeId, (live) => {
      if (!live.data) return;
      const d = live.data as GamepadData;
      if (stick === 'left') delete d.leftStickCalibration;
      else delete d.rightStickCalibration;
    });
  }

  // ---------------- SAVE / LOAD mapping + presets ----------------
  // ⚠ NO AUTO-CLEARING TOAST. The outcome LATCHES on the lamp until the next
  // gesture replaces it — see `mappingDetail` for why the "it's transient, so
  // the ruling doesn't reach it" argument is available here and refused.
  let mappingOutcome = $state<MappingOutcome | null>(null);

  function saveMapping() {
    const data = (patch.nodes[nodeId]?.data ?? {}) as GamepadData;
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
      mappingOutcome = { ok: true, message: 'mapping saved as gamepad-mapping.json' };
    } catch (e) {
      mappingOutcome = {
        ok: false,
        message: `save failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  function applyMappingToNode(mapping: GamepadMapping) {
    mutateNode(nodeId, (live) => {
      if (!live.data) live.data = {};
      applyMapping(live.data as GamepadData, mapping);
    });
  }

  async function onMappingFile(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed: unknown = JSON.parse(text);
      if (!isGamepadMapping(parsed)) {
        mappingOutcome = { ok: false, message: `ignored ${file.name}: not a gamepad mapping` };
        return;
      }
      applyMappingToNode(parsed as GamepadMapping);
      mappingOutcome = { ok: true, message: `loaded ${file.name}` };
    } catch {
      mappingOutcome = { ok: false, message: `ignored ${file.name}: invalid JSON` };
    } finally {
      try { input.value = ''; } catch { /* */ }
    }
  }

  let presetSel = $state('');
  function onPresetSelect(ev: Event) {
    const name = (ev.target as HTMLSelectElement).value;
    presetSel = '';
    if (!name) return;
    const preset = GAMEPAD_PRESETS.find((p) => p.name === name);
    if (!preset) return;
    applyMappingToNode(preset.mapping);
    mappingOutcome = { ok: true, message: `loaded preset: ${name}` };
  }

  // ---------------- the poll ----------------
  let rafId: number | null = null;
  function poll() {
    const e = engineCtx.get();
    const n = node;
    if (e && n) {
      const s = e.read(n, 'snapshot') as GamepadSnapshot | undefined;
      if (s) {
        snapshot = s;
        if (calibrating && s.connected) {
          const rx = calibrating === 'left' ? s.rawLeftX : s.rawRightX;
          const ry = calibrating === 'left' ? s.rawLeftY : s.rawRightY;
          recordCalibrationSample(sweep, rx, ry);
          // A shallow copy so the $derived box + the complete gate re-evaluate.
          sweep = { ...sweep };
        }
        if (remap && s.connected) {
          const cur = s.raw;
          if (!remap.baseline) {
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

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && remap) { e.preventDefault(); cancelRemap(); }
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

  // ---------------- rosters ----------------
  // ⚠ READ OFF `GAMEPAD_OUTPUTS`, never re-typed, so a label edit on the def
  // propagates here — the same ONE-PLACE rule the ranges obey, applied to
  // captions. The order is the physical grid's: shoulders, face, d-pad, menu.
  const BUTTON_LED_IDS = ['lb','rb','a','b','x','y','du','dd','dl','dr','start','back'] as const;
  const buttonLeds: { id: string; label: string }[] = BUTTON_LED_IDS.map((bid) => {
    const out = GAMEPAD_OUTPUTS.find((o) => o.id === bid);
    return { id: bid, label: out?.label ?? bid.toUpperCase() };
  });

  /** What an output IS, for a reader who cannot see the layout. DERIVED from the
   *  def's own port type — nothing here is a second list of the ports. */
  function roleOf(outputId: string): string {
    const out = GAMEPAD_OUTPUTS.find((o) => o.id === outputId);
    return out?.type === 'cv' ? `the ${outputId} CV output` : `the ${outputId} gate output`;
  }

  const LED_GESTURES = 'Right-click to rebind it, alt-click to reset it.';
  const AXIS_GESTURES = 'Click to rebind it, right-click to reset it.';
  const TRIGGER_GESTURES = 'Right-click to rebind it, alt-click to reset it.';

  const AXES: { stick: Stick; cap: string; x: string; y: string }[] = [
    { stick: 'left', cap: 'L', x: 'lx', y: 'ly' },
    { stick: 'right', cap: 'R', x: 'rx', y: 'ry' },
  ];
  const TRIGGERS: { id: string; label: string }[] = [
    { id: 'lt', label: 'LT' },
    { id: 'rt', label: 'RT' },
  ];
</script>

<div class="gamepad-board" data-testid="gamepad-body-{nodeId}">
  <!-- ── THE PAD LAMP + THE EMPTY STATE ─────────────────────────────────────
       Instructional copy in an empty state is not a measurement (midiclock's
       shipped precedent), and it is the honest content of the plate before a
       controller exists: the Gamepad API's gate is a physical button press, so
       there is no in-page affordance that could replace this sentence. -->
  <div class="head">
    <StatusLed
      caption="PAD"
      lit={snapshot.connected}
      detail={padDetail(snapshot.connected, snapshot.id)}
      testid="gamepad-led-pad-{nodeId}"
    />
    {#if !snapshot.connected}
      <p class="hint">Press any button ON THE CONTROLLER to connect it.</p>
    {/if}
  </div>

  <!-- ── THE TWO STICKS ─────────────────────────────────────────────────────
       SVG, never a raster surface. A 2-D drawing context would flip this body's
       role to `picture` under ROLE_PREDICATE and hide every mark it draws from
       every source gate; a WebGL one would enrol this file in the attest basis
       automatically, since basis membership is derived from CONTENT.
       ⚠ AND THE WORD ITSELF IS THE HAZARD: `paintsCanvas` greps raw source and
       cannot tell code from a comment, so spelling the tag out here — even to
       say it is absent — reddens the role gate. It caught this file once. -->
  <div class="sticks">
    {#each AXES as ax (ax.stick)}
      {@const live = { x: snapshot.values[ax.x] ?? 0, y: snapshot.values[ax.y] ?? 0 }}
      {@const box = ax.stick === 'left' ? leftBox : rightBox}
      {@const calibrated = ax.stick === 'left' ? snapshot.calibrated : snapshot.rightCalibrated}
      <div class="stick-block">
        <svg
          class="stick-pad"
          class:armed={calibrating === ax.stick}
          viewBox="0 0 {PAD_PX} {PAD_PX}"
          width={PAD_PX}
          height={PAD_PX}
          role="img"
          aria-label={stickSentence({
            stick: ax.stick,
            x: live.x,
            y: live.y,
            calibrated,
            sweep: calibrating === ax.stick ? sweep : null,
          })}
          data-testid="gamepad-stick-{ax.stick}-{nodeId}"
        >
          <rect class="pad-bg" x="0.5" y="0.5" width={PAD_PX - 1} height={PAD_PX - 1} rx="2" />
          <line class="cross" x1="0" y1={PAD_PX / 2} x2={PAD_PX} y2={PAD_PX / 2} />
          <line class="cross" x1={PAD_PX / 2} y1="0" x2={PAD_PX / 2} y2={PAD_PX} />
          {#if box}
            <!-- THE SWEEP EXTENT, DRAWN. It replaces four live decimals with a
                 picture of the exact quantity they reported, in the coordinate
                 system the player is already watching. -->
            <rect
              class="sweep"
              x={box.left}
              y={box.top}
              width={box.width}
              height={box.height}
            />
          {/if}
          <circle class="dot" cx={dotX(live.x)} cy={dotY(live.y)} r="3.5" />
        </svg>

        <div class="stick-cap">{ax.cap}</div>

        <div class="btn-row">
          {#each [{ axis: 'x' as const, port: ax.x }, { axis: 'y' as const, port: ax.y }] as a (a.port)}
            <button
              type="button"
              class="mini"
              class:armed={remap?.outputId === a.port}
              class:bound={!!bindings[a.port]}
              onclick={() => armRemap(a.port, 'axis')}
              oncontextmenu={(e) => { e.preventDefault(); clearRemap(a.port); }}
              aria-label={remapSentence({
                outputId: a.port,
                caption: a.axis.toUpperCase(),
                role: roleOf(a.port),
                bindings,
                armed: remap?.outputId === a.port,
                gestures: AXIS_GESTURES,
              })}
              data-testid="gamepad-remap-{a.port}-{nodeId}"
            >{a.axis.toUpperCase()}</button>
          {/each}
        </div>

        <div class="btn-row">
          <span class="cap" aria-hidden="true">inv</span>
          {#each [{ axis: 'x' as const, port: ax.x }, { axis: 'y' as const, port: ax.y }] as a (a.port)}
            <button
              type="button"
              class="mini"
              class:on={!!invert[a.port as InvertibleAxis]}
              aria-pressed={!!invert[a.port as InvertibleAxis]}
              onclick={() => toggleInvert(a.port as InvertibleAxis)}
              aria-label={invertSentence(ax.stick, a.axis, !!invert[a.port as InvertibleAxis])}
              data-testid="gamepad-invert-{a.port}-{nodeId}"
            >{a.axis}</button>
          {/each}
        </div>

        <button
          type="button"
          class="wide"
          onclick={() => setCenter(ax.stick)}
          data-testid="gamepad-setcenter-{ax.stick}-{nodeId}"
        >set center</button>
      </div>
    {/each}
  </div>

  <!-- ── CALIBRATION ────────────────────────────────────────────────────────
       Off-mode: one button per stick beside its lamp. In-mode: COMPLETE (gated
       by `sweepIsUsable`, which is where "am I there yet" is already answered on
       a non-text channel) and CANCEL. No hint sentence and no live range: the
       armed pad's own border and its sweep box carry both. -->
  <div class="calib" data-testid="gamepad-calib-{nodeId}">
    {#if !calibrating}
      {#each AXES as ax (ax.stick)}
        {@const calibrated = ax.stick === 'left' ? snapshot.calibrated : snapshot.rightCalibrated}
        <span class="calib-stick">
          <button
            type="button"
            class="wide"
            onclick={() => startCalibration(ax.stick)}
            data-testid="gamepad-calibrate-{ax.stick}-{nodeId}"
          >calibrate {ax.stick}</button>
          {#if ax.stick === 'left'}
            <StatusLed
              caption="CAL L"
              lit={calibrated}
              detail={calibrationDetail('left', calibrated)}
              testid="gamepad-led-cal-left-{nodeId}"
            />
          {:else}
            <StatusLed
              caption="CAL R"
              lit={calibrated}
              detail={calibrationDetail('right', calibrated)}
              testid="gamepad-led-cal-right-{nodeId}"
            />
          {/if}
          {#if calibrated}
            <button
              type="button"
              class="mini"
              onclick={() => clearCalibration(ax.stick)}
              aria-label={`clear the ${ax.stick} stick calibration and fall back to the fixed deadzone`}
              data-testid="gamepad-calibrate-clear-{ax.stick}-{nodeId}"
            >✕</button>
          {/if}
        </span>
      {/each}
    {:else}
      <button
        type="button"
        class="wide"
        disabled={!canComplete}
        onclick={completeCalibration}
        data-testid="gamepad-calibrate-complete-{nodeId}"
      >complete</button>
      <button
        type="button"
        class="wide"
        onclick={cancelCalibration}
        data-testid="gamepad-calibrate-cancel-{nodeId}"
      >cancel</button>
    {/if}
  </div>

  <!-- ── SAVE / LOAD / PRESET, and the outcome as a LAMP ────────────────────-->
  <div class="mapping" data-testid="gamepad-mapping-{nodeId}">
    <button
      type="button"
      class="wide"
      onclick={saveMapping}
      aria-label="download this node's bindings, inverts and both stick calibrations as a .json file"
      data-testid="gamepad-save-mapping-{nodeId}"
    >save mapping</button>
    <label class="wide file">
      <input
        type="file"
        accept=".json,application/json"
        onchange={onMappingFile}
        aria-label="load a saved gamepad mapping from a .json file"
        data-testid="gamepad-load-mapping-{nodeId}"
      />
      <span>load mapping</span>
    </label>
    <select
      class="preset"
      bind:value={presetSel}
      onchange={onPresetSelect}
      aria-label="apply a built-in mapping preset to this node"
      data-testid="gamepad-preset-{nodeId}"
    >
      <option value="">load preset…</option>
      {#each GAMEPAD_PRESETS as p (p.name)}
        <option value={p.name}>{p.name}</option>
      {/each}
    </select>
    <StatusLed
      caption="MAPPING"
      lit={!!mappingOutcome}
      tone={mappingOutcome && !mappingOutcome.ok ? 'warn' : 'accent'}
      detail={mappingDetail(mappingOutcome)}
      testid="gamepad-led-mapping-{nodeId}"
    />
  </div>

  <!-- ── TRIGGERS ──────────────────────────────────────────────────────────-->
  <div class="triggers">
    {#each TRIGGERS as t (t.id)}
      {@const v = Math.max(0, Math.min(1, snapshot.values[t.id] ?? 0))}
      <div class="trig-row">
        <button
          type="button"
          class="mini remappable"
          class:armed={remap?.outputId === t.id}
          class:bound={!!bindings[t.id]}
          oncontextmenu={(e) => { e.preventDefault(); armRemap(t.id, 'button'); }}
          onclick={(e) => { if (e.altKey) clearRemap(t.id); }}
          aria-label={remapSentence({
            outputId: t.id,
            caption: t.label,
            role: roleOf(t.id),
            bindings,
            armed: remap?.outputId === t.id,
            gestures: TRIGGER_GESTURES,
          })}
          data-testid="gamepad-remap-{t.id}-{nodeId}"
        >{t.label}{#if bindings[t.id]}<span class="mark" aria-hidden="true">●</span>{/if}</button>
        <svg
          class="trig-bar"
          viewBox="0 0 100 6"
          preserveAspectRatio="none"
          role="img"
          aria-label={triggerSentence(t.label, v)}
          data-testid="gamepad-trigbar-{t.id}-{nodeId}"
        >
          <rect class="trig-track" x="0" y="0" width="100" height="6" rx="1" />
          <rect class="trig-fill" x="0" y="0" width={v * 100} height="6" rx="1" />
        </svg>
      </div>
    {/each}
  </div>

  <!-- ── THE TWELVE BUTTON LEDS — the remap surface itself ─────────────────-->
  <div class="buttons">
    {#each buttonLeds as btn (btn.id)}
      <button
        type="button"
        class="led remappable"
        class:on={(snapshot.values[btn.id] ?? 0) >= 0.5}
        class:armed={remap?.outputId === btn.id}
        class:bound={!!bindings[btn.id]}
        oncontextmenu={(e) => { e.preventDefault(); armRemap(btn.id, 'button'); }}
        onclick={(e) => { if (e.altKey) clearRemap(btn.id); }}
        aria-label={remapSentence({
          outputId: btn.id,
          caption: btn.label,
          role: roleOf(btn.id),
          bindings,
          armed: remap?.outputId === btn.id,
          gestures: LED_GESTURES,
        })}
        data-testid="gamepad-remap-{btn.id}-{nodeId}"
      >{btn.label}{#if bindings[btn.id]}<span class="mark" aria-hidden="true">●</span>{/if}</button>
    {/each}
  </div>
</div>

<style>
  /* ── COMPACT BY DEFAULT, AND HERE THE MEASUREMENT DECIDED THE CHROME ───────
     Nothing declares a min-width and no row stretches: the board is exactly as
     wide as its widest row (the save/load row), and `.faceplate-body` above it
     is `width: max-content`, so any reserved width lands straight in the dock
     scene's slack measurement.

     ⚠ THAT MEASUREMENT IS A CONSTANT, NOT A FUNCTION OF THE CONTENT, which is
     why this board carries NO border, NO background and NO horizontal padding.
     Measured on the real dock pane: `bodyW - contentW` decomposes as 22 px of
     ModuleShell's own inset + 10 px of `.dock-ext-body` padding + whatever this
     element adds on its right. The first two are platform chrome every face
     pays; the third is ours. With `padding: 6px 8px` and a 1 px border the
     total came to 42 CSS px against a 40 px ceiling — and NO amount of extra
     content would have helped, because the widest row ENDS IN INK (the MAPPING
     lamp's caption), so growing the board moves `contentW` and `bodyW` by the
     same amount and the difference does not move at all. A frame around this
     surface is therefore not a look-versus-rule trade: it is width nothing
     draws in, which is the exact thing the ruling forbids. The dock plate
     already frames the body.

     ⚠ AND NO ROW MAY `flex-wrap`. Wrapping is the ONE thing that would break
     the flush-ink property above: the save/load row would put its lamp on a
     second line and leave the first line ending at the preset `<select>`, whose
     box is not measured (it paints no text node — its options live in a
     dropdown), so the slack would jump by ~90 px on a machine whose fonts
     happen to be a little wider. The pane scrolls; a row that does not fit is
     reachable by construction. */
  .gamepad-board {
    display: inline-flex;
    flex-direction: column;
    gap: 6px;
    align-items: flex-start;
    padding: 2px 0 4px;
    font-size: 10px;
  }

  .head {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .hint {
    margin: 0;
    font-size: 10px;
    line-height: 1.3;
    max-width: 30ch;
    color: var(--muted, #888);
  }

  .sticks {
    display: flex;
    gap: 14px;
  }
  .stick-block {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
  }
  .stick-pad {
    display: block;
    overflow: visible;
  }
  .pad-bg {
    fill: var(--module-bg, #101010);
    stroke: var(--border, #3a3a3a);
    stroke-width: 1;
  }
  .cross {
    stroke: var(--border, #2c2c2c);
    stroke-width: 1;
  }
  /* The ARMED pad is the non-text half of "which stick am I sweeping?" — the
     activity-dot principle, applied to the surface being calibrated. */
  .stick-pad.armed .pad-bg {
    stroke: var(--accent, #6cf);
    stroke-width: 1.5;
  }
  .sweep {
    fill: none;
    stroke: var(--accent, #6cf);
    stroke-width: 1;
    stroke-dasharray: 2 2;
  }
  .dot {
    fill: var(--cable-cv, #6cf);
  }
  .stick-cap {
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.6px;
    color: var(--muted, #888);
  }

  .btn-row {
    display: flex;
    align-items: center;
    gap: 3px;
  }
  .cap {
    font-size: 9px;
    letter-spacing: 0.5px;
    color: var(--muted, #777);
  }

  button,
  .file {
    font: inherit;
    font-size: 9px;
    letter-spacing: 0.4px;
    color: var(--fg, #ddd);
    background: var(--module-bg, #141414);
    border: 1px solid var(--border, #3a3a3a);
    border-radius: 2px;
    cursor: pointer;
    padding: 2px 4px;
  }
  button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .mini {
    min-width: 16px;
    text-align: center;
  }
  .wide {
    padding: 2px 6px;
    white-space: nowrap;
  }
  button.on,
  button.bound {
    border-color: var(--accent-dim, #47c);
    color: var(--fg, #eee);
  }
  button.armed {
    border-color: var(--accent, #6cf);
    box-shadow: 0 0 0 1px var(--accent-glow, rgba(102, 204, 255, 0.35));
  }
  .mark {
    margin-left: 2px;
    color: var(--accent, #6cf);
  }

  .file {
    position: relative;
    display: inline-block;
    overflow: hidden;
  }
  .file input {
    position: absolute;
    inset: 0;
    opacity: 0;
    cursor: pointer;
  }

  /* NO `flex-wrap` — see the board's own note. A wrapped row breaks the
     flush-ink property the width gate depends on. */
  .calib,
  .mapping {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .calib-stick {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .preset {
    font-size: 9px;
    padding: 1px 3px;
    background: var(--module-bg, #141414);
    color: var(--fg, #ddd);
    border: 1px solid var(--border, #3a3a3a);
    border-radius: 2px;
    max-width: 110px;
  }

  .triggers {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .trig-row {
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .trig-bar {
    display: block;
    width: 120px;
    height: 6px;
  }
  .trig-track { fill: var(--module-bg, #101010); stroke: var(--border, #333); stroke-width: 0.5; }
  .trig-fill { fill: var(--cable-cv, #6cf); }

  /* SIX COLUMNS × 12 tiles = two rows, the physical layout's own shape. */
  .buttons {
    display: grid;
    grid-template-columns: repeat(6, 30px);
    gap: 3px;
  }
  .led {
    height: 18px;
    padding: 0;
    text-align: center;
  }
  .led.on {
    background: var(--accent-dim, #2a4a5a);
    border-color: var(--accent, #6cf);
  }
</style>

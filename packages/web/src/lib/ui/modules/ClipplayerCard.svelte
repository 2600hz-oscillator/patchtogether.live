<script lang="ts">
  // CLIP PLAYER card (v2) — the always-available face of the 8-lane clip
  // launcher. Two views in one 3u tile:
  //   SESSION (default): an 8×8 launch grid. COLS = 8 instrument lanes
  //     (channels, ch1 = leftmost col), ROWS = 8 clip slots (slot 0 = top row).
  //     Matches the transposed Launchpad grid (Ableton convention: cols =
  //     tracks, rows = scenes). Single-click a cell = launch/queue that clip;
  //     click the playing cell = stop the lane; double-click = open its editor.
  //     A ▶/■ transport drives TIMELORDE (hidden when TIMELORDE is externally
  //     clocked). STEP / OCT / GATE / QNT params below.
  //   EDIT: a piano-roll note editor for one clip (X = step, Y = pitch, in-key
  //     rows). Click a cell to toggle a note on/off; RIGHT-click to cycle its
  //     velocity through 6 levels. Per-lane MONO replaces-on-add; POLY caps at 5.
  //
  // Clock is LOCKED TO TIMELORDE (no BPM knob, no clock cable). The monome grid
  // drives the SAME actions via lib/control/monome. All ports live in the shared yellow
  // drill-down <PatchPanel> (post-#767 — NO raw side <Handle> jacks); port ids
  // are byte-identical to clipplayerDef so the CV bridge routes unchanged.
  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import MidiAssignButton from '$lib/ui/controls/MidiAssignButton.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch, ydoc } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import { setNodeParam } from '$lib/graph/mutate';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import { clipplayerDef } from '$lib/audio/modules/clipplayer';
  import {
    CLIP_LANES,
    CLIP_SLOTS,
    clipIndex,
    laneOf,
    slotOf,
    lanePlaying,
    laneQueued,
    defaultNoteClip,
    coerceClipRecord,
    rowToMidi,
    scaleSteps,
    toggleNoteAt,
    cycleVelocity,
    noteCovering,
    velBucket,
    laneMono,
    laneColor,
    laneColorEff as laneColorEffOf,
    coerceLaneColor,
    readClip,
    defaultAutomationClip,
    automationClipDisplay,
    clampStepCount,
    MAX_CLIP_STEPS,
    MAX_AUTOMATION_TRACKS,
    type ClipPlayerData,
    type NoteClipRecord,
    type AutomationClipRecord,
  } from '$lib/audio/modules/clip-types';
  import { plainAutomationClip } from '$lib/audio/modules/clip-automation';
  import {
    getAutomationRender,
    automationCountdownColor,
    automationCountdownOn,
  } from '$lib/audio/modules/clip-automation-render';
  import { overriddenKeysFor, reEnableAllFor } from '$lib/audio/automation-touch';
  import {
    RATE_LABELS,
    RATE_DEFAULT_INDEX,
    coerceRateIndex,
    laneRateIndex,
  } from '$lib/audio/modules/clip-clock';
  import {
    coerceArrangeData,
    arrangeBlocks,
    arrangeLengthBeats,
    snapBeat,
    type ArrangeBlock,
    type ArrangeData,
  } from '$lib/audio/modules/clip-arrange';
  import {
    writeArrange as writeArrangeShared,
    commitMove,
    xToBeat,
    deleteBlock,
    setBlockSlot,
    setArrangeLength,
  } from './clipplayer-arrange-edit';
  import ClipArrangeEditor from './ClipArrangeEditor.svelte';
  import type { ScaleName } from '$lib/mike/music-theory';
  import { noteNameForMidi } from '$lib/audio/note-entry';
  import ModuleTitle from './ModuleTitle.svelte';
  import {
    serialAvailable as gridSerialAvailable,
    connect as gridConnect,
    isConnected as gridIsConnected,
    connectedRune as gridConnectedRune,
  } from '$lib/control/monome/monome-device.svelte';
  import {
    bindGridToClip,
    unbindGrid,
    boundClipNode,
    bindingRune,
  } from '$lib/control/monome/monome-control.svelte';
  import { portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  // --- monome grid connect + bind THIS clip-player. Capability-gated. ---
  const gridSupported = gridSerialAvailable();
  let gridBoundHere = $derived((bindingRune(), gridConnectedRune(), boundClipNode() === id));
  async function toggleGrid() {
    if (boundClipNode() === id) {
      unbindGrid();
      return;
    }
    const ok = await gridConnect(); // gesture-gated picker prompt
    if (ok || gridIsConnected()) bindGridToClip(id);
  }

  // Node-scoped re-derive (phase-2 CC perf fix): subscribe to THIS node's
  // version from the shared registry (nodes.observeDeep) instead of a
  // per-component whole-doc ydoc.on('update') pump — a commit on another
  // module no longer re-runs this card's derived chain.
  let cardVersion = $derived(nodeVersion(id));

  function pdef(pid: string) {
    return clipplayerDef.params.find((p) => p.id === pid)!;
  }
  const STEP_LABELS = ['1/4', '1/8', '1/16', '1/32'];
  let stepDiv = $derived((void cardVersion, Math.round(node?.params.stepDiv ?? pdef('stepDiv').defaultValue)));
  let quantize = $derived((void cardVersion, (node?.params.quantize ?? 1) >= 0.5));
  // Gate-sampled S&H toggle — ONE global toggle for all 8 lanes, baked into the
  // pitch CV; ON by default (the snh fallback supplies ON for old saves, no
  // schemaVersion bump needed). Replaces the 8 external S&H modules.
  let snhOn = $derived((void cardVersion, (node?.params.snh ?? 1) >= 0.5));
  let octave = $derived((void cardVersion, node?.params.octave ?? 0));
  let gateLength = $derived((void cardVersion, node?.params.gateLength ?? 0.9));

  function dataObj(): ClipPlayerData {
    return (node?.data ?? {}) as ClipPlayerData;
  }
  let clips = $derived.by<Record<string, unknown>>(() => {
    void cardVersion;
    return (dataObj().clips ?? {}) as Record<string, unknown>;
  });

  // SESSION ⇄ EDIT view + which clip the editor is on.
  let view = $state<'session' | 'edit'>('session');
  let selectedClip = $state(0);

  const setParam = (pid: string) => (v: number) => setNodeParam(id, pid, v);
  const readLive = (pid: string) => () => {
    const e = engineCtx.get();
    if (!e || !node) return undefined;
    return e.readParam(node, pid);
  };

  function writeData(mut: (d: ClipPlayerData) => void) {
    const target = patch.nodes[id];
    if (!target) return;
    ydoc.transact(() => {
      if (!target.data) target.data = {};
      mut(target.data as ClipPlayerData);
    });
  }

  function clipAt(index: number): NoteClipRecord | null {
    const c = coerceClipRecord(clips[String(index)]);
    return c && c.kind === 'note' ? c : null;
  }
  function ensureClip(index: number) {
    if (clips[String(index)]) return;
    writeData((d) => {
      if (!d.clips) d.clips = {};
      d.clips[String(index)] = defaultNoteClip();
    });
  }

  // --- per-lane queue (the synced playing-set the engine + peers consume) ---
  // `immediate` = a NOW override (mid-clip switch): the launch fires next tick
  // regardless of QNT (see queuedImmediate in the engine).
  function queueLane(lane: number, action: number | 'stop' | null, immediate = false) {
    // SyncedStore Y.Arrays reject index assignment — rebuild + assign whole.
    writeData((d) => {
      const base: (number | 'stop' | null)[] = new Array(CLIP_LANES).fill(null);
      if (Array.isArray(d.queued)) {
        for (let i = 0; i < d.queued.length && i < CLIP_LANES; i++) base[i] = d.queued[i];
      }
      base[lane] = action;
      d.queued = base;
      if (immediate) {
        const imm = new Array<boolean>(CLIP_LANES).fill(false);
        if (Array.isArray(d.queuedImmediate)) {
          for (let i = 0; i < d.queuedImmediate.length && i < CLIP_LANES; i++) imm[i] = !!d.queuedImmediate[i];
        }
        imm[lane] = true;
        d.queuedImmediate = imm;
      }
    });
  }
  function stopAll() {
    writeData((d) => {
      d.queued = new Array(CLIP_LANES).fill('stop');
    });
  }

  // Single-click: launch / queue / stop. Debounced so a double-click (→ edit)
  // doesn't also fire a launch.
  let clickTimer: ReturnType<typeof setTimeout> | null = null;
  // Shift-click = NOW (immediate mid-clip switch); plain click = quantized (QNT).
  function onPadClick(idx: number, ev: MouseEvent) {
    const now = ev.shiftKey;
    if (clickTimer) clearTimeout(clickTimer);
    clickTimer = setTimeout(() => {
      clickTimer = null;
      launchPad(idx, now);
    }, 220);
  }
  function onPadDblClick(idx: number) {
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
    ensureClip(idx);
    selectedClip = idx;
    view = 'edit';
  }
  function launchPad(idx: number, immediate = false) {
    const lane = laneOf(idx);
    const slot = slotOf(idx);
    if (!clips[String(idx)]) {
      ensureClip(idx);
      queueLane(lane, slot, immediate); // create + arm
      return;
    }
    if (lanePlaying(dataObj(), lane) === slot) queueLane(lane, 'stop', immediate);
    else queueLane(lane, slot, immediate);
  }

  function padState(idx: number): 'empty' | 'loaded' | 'queued' | 'playing' {
    const lane = laneOf(idx);
    const slot = slotOf(idx);
    const pl = lanePlaying(dataObj(), lane);
    const q = laneQueued(dataObj(), lane);
    if (q === slot) return 'queued';
    if (pl === slot) return q === 'stop' ? 'queued' : 'playing';
    return clips[String(idx)] ? 'loaded' : 'empty';
  }
  // 8 distinct row hues — the DEFAULT color a channel shows until the user picks
  // one with its color swatch. The default-hue + effective-colour math lives in
  // clip-types (laneColorEffOf) so the card swatch and the Launchpad LED pads
  // resolve the SAME colour for every channel.
  /** The channel's PICKED clip color (a `#rrggbb` hex), or null when unpicked. */
  function laneColorOf(lane: number): string | null {
    void cardVersion;
    return laneColor(dataObj(), lane);
  }
  /** The EFFECTIVE channel color: the picked color, else the default-hue hex. A
   *  concrete hex either way (feeds --lane-color + the color-input default). */
  function laneColorEff(lane: number): string {
    void cardVersion;
    return laneColorEffOf(dataObj(), lane);
  }
  /** Pick this channel's color — tints its whole column of clips. Mirrors
   *  setLaneRate: rebuild the CLIP_LANES array + assign the whole (SyncedStore
   *  Y.Arrays reject index assignment). */
  function setLaneColor(lane: number, color: string) {
    writeData((d) => {
      const base: (string | null)[] = new Array(CLIP_LANES).fill(null);
      if (Array.isArray(d.laneColor)) {
        for (let i = 0; i < CLIP_LANES && i < d.laneColor.length; i++) base[i] = coerceLaneColor(d.laneColor[i]);
      }
      base[lane] = coerceLaneColor(color);
      d.laneColor = base;
    });
  }

  // --- transport: writes TIMELORDE.running; hidden when externally clocked ---
  function timelordeId(): string | null {
    for (const [nid, n] of Object.entries(patch.nodes)) {
      if ((n as { type?: string } | undefined)?.type === 'timelorde') return nid;
    }
    return null;
  }
  let transportRunning = $state(false);
  let externallyClocked = $state(false);
  let curStep = $state(0);
  let songBeatLive = $state(0); // live song position for the arrangement playhead
  // AUTOMATION countdown mirror (client-local render state, polled — not synced):
  // 'yellow' | 'red' with an on-beat pulse in the last 4 beats before the
  // automation clip's own wrap, else null. Mirrors the launchpad pad flash.
  let autoCountdown = $state<{ color: 'yellow' | 'red'; on: boolean } | null>(null);
  $effect(() => {
    void node; // re-subscribe if the node identity changes
    let raf = 0;
    const frame = () => {
      const e = engineCtx.get();
      if (e && node) {
        const tr = e.read(node, 'transportRunning');
        if (typeof tr === 'number') transportRunning = tr >= 0.5;
        const ec = e.read(node, 'externallyClocked');
        if (typeof ec === 'number') externallyClocked = ec >= 0.5;
        if (view === 'edit') {
          const cs = e.read(node, `currentStep:${laneOf(selectedClip)}`);
          if (typeof cs === 'number') curStep = cs;
        }
        const sb = e.read(node, 'songBeat');
        if (typeof sb === 'number') songBeatLive = sb;
      }
      // Automation override indicator (client-local touch state — not synced, so
      // it's polled here, not derived from cardVersion). Lit when a param THIS
      // player automates is currently suspended by a live grab.
      const keys = overriddenKeysFor(id);
      autoOverridden = keys.length > 0 && keys.some((k) => autoTrackKeys.has(k));
      // Automation countdown mirror (client-local render state, polled here).
      const rs = getAutomationRender(id);
      const cc = rs && rs.recording ? automationCountdownColor(rs.beatsToLoopEnd) : null;
      autoCountdown = cc ? { color: cc, on: automationCountdownOn(rs!.beatPhase) } : null;
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  });
  let hasTimelorde = $derived((void cardVersion, timelordeId() !== null));
  let showTransport = $derived(hasTimelorde && !externallyClocked);
  function toggleTransport() {
    const tid = timelordeId();
    if (!tid) return;
    setNodeParam(tid, 'running', transportRunning ? 0 : 1);
  }

  // --- SONG MODE (arranger) — synced state on node.data ---
  let recording = $derived((void cardVersion, dataObj().recording === true));
  let arrangeMode = $derived((void cardVersion, dataObj().clipMode === 'arrangement'));
  let recordMode = $derived(
    (void cardVersion, dataObj().recordMode === 'overdub' ? 'overdub' : 'replace'),
  );
  let arrangeEvents = $derived(
    (void cardVersion, Array.isArray(dataObj().arrangement?.events) ? dataObj().arrangement!.events!.length : 0),
  );
  /** Arm/disarm recording. In REPLACE mode arming clears the log + restarts song
   *  time (engine, on the rising edge); in OVERDUB it keeps the take + merges. */
  function toggleRecord() {
    writeData((d) => { d.recording = !d.recording; });
  }
  /** Flip REPLACE ⇄ OVERDUB record mode. */
  function toggleRecordMode() {
    writeData((d) => { d.recordMode = d.recordMode === 'overdub' ? 'replace' : 'overdub'; });
  }
  /** Flip SESSION ⇄ ARRANGEMENT playback. */
  function toggleArrangeMode() {
    writeData((d) => { d.clipMode = d.clipMode === 'arrangement' ? 'session' : 'arrangement'; });
  }
  /** The full-window pop-out arranger editor (like the MAPPY MAP editor). */
  let arrangeEditorOpen = $state(false);

  // --- AUTOMATION LANE (task #183) ---
  // The designated automation clip pointer + its resolved record (the one clip
  // this player records/plays param envelopes into). Derived from synced
  // node.data; the override state is CLIENT-LOCAL (read from the touch registry).
  let autoClipPtr = $derived.by<{ lane: number; slot: number } | null>(() => {
    void cardVersion;
    const c = dataObj().automation?.clip;
    return c && typeof c.lane === 'number' && typeof c.slot === 'number'
      ? { lane: c.lane, slot: c.slot }
      : null;
  });
  let autoClip = $derived.by<AutomationClipRecord | null>(() => {
    void cardVersion;
    if (!autoClipPtr) return null;
    const rec = readClip(dataObj(), clipIndex(autoClipPtr.slot, autoClipPtr.lane));
    return rec && rec.kind === 'automation' ? rec : null;
  });
  let autoTrackCount = $derived(autoClip?.tracks.length ?? 0);
  let autoArmed = $derived((void cardVersion, dataObj().automation?.arm === true));
  // Automation clip LENGTH (steps) + DIV (clock-rate index) — the SINGLE source
  // (automationClipDisplay) the DIV select, LENGTH input, AND the clip-cell badge
  // all render from, so the shown timing can never disagree with the stored clip
  // (UI-can't-lie). Settable so a long, slow record window is user-tunable.
  let autoDisplay = $derived((void cardVersion, automationClipDisplay(autoClip)));
  let autoLen = $derived(autoDisplay.lengthSteps);
  let autoDiv = $derived(autoDisplay.divIndex);
  // The real track keys ("nodeId::paramId") of THIS clip — the card intersects
  // the controller's overridden keys against these so the indicator dot only
  // lights for params THIS player actually automates (never unrelated grabs).
  let autoTrackKeys = $derived(
    new Set((autoClip?.tracks ?? []).map((t) => `${t.target.nodeId}::${t.target.paramId}`)),
  );
  let autoOverridden = $state(false);

  /** Create THIS player's automation clip: stamp defaultAutomationClip() into the
   *  FIRST EMPTY cell of the LAST lane (lowest empty slot) + record the pointer.
   *  No-op if the last lane is full (MVP: one automation clip per player). */
  function createAutomationClip() {
    const lane = CLIP_LANES - 1;
    let slot = -1;
    for (let s = 0; s < CLIP_SLOTS; s++) {
      if (!clips[String(clipIndex(s, lane))]) { slot = s; break; }
    }
    if (slot < 0) return; // last lane full — no room
    writeData((d) => {
      if (!d.clips) d.clips = {};
      d.clips[String(clipIndex(slot, lane))] = defaultAutomationClip();
      if (!d.automation) d.automation = {};
      d.automation.clip = { lane, slot };
    });
  }
  /** Flip automation record-arm. When ARMING, claim single-writer by stamping
   *  this client's ydoc.clientID as the recorderId (the engine only records on
   *  the matching client — see isAutomationRecorder). */
  function toggleAutoArm() {
    writeData((d) => {
      if (!d.automation) d.automation = {};
      const arming = !d.automation.arm;
      d.automation.arm = arming;
      if (arming) d.automation.recorderId = ydoc.clientID;
    });
  }
  /** Re-enable every param THIS player has suspended (the override-dot click). */
  function reEnableAutomation() {
    reEnableAllFor(id);
  }
  /** Rewrite the automation clip with a mutated copy (whole-clip PLAIN reassign,
   *  never a live Y splice — the automation-clip commit discipline). */
  function writeAutoClip(mut: (rec: AutomationClipRecord) => AutomationClipRecord) {
    const ptr = autoClipPtr;
    const rec = autoClip;
    if (!ptr || !rec) return;
    const next = plainAutomationClip(mut(rec));
    writeData((d) => {
      if (!d.clips) d.clips = {};
      d.clips[String(clipIndex(ptr.slot, ptr.lane))] = next;
    });
  }
  /** Set the automation clip's LENGTH (steps). ARBITRARY counts are allowed (7, 13,
   *  …) — NOT snapped to musical multiples: a coprime length drifts against the
   *  other clips by design (the generative-desync feature). */
  function setAutoLen(steps: number) {
    writeAutoClip((rec) => ({ ...rec, lengthSteps: clampStepCount(steps) }));
  }
  /** Set the automation clip's own clock DIVISION (index into RATE_LABELS). */
  function setAutoDiv(idx: number) {
    writeAutoClip((rec) => ({ ...rec, div: coerceRateIndex(idx) }));
  }

  // --- SONG VIEW timeline (shown in ARRANGEMENT mode) ---
  const ARR_W = 312; // svg content width (px)
  const ARR_LANE_H = 13; // px per lane row
  let arrangeData = $derived.by<ArrangeData>(() => {
    void cardVersion;
    return coerceArrangeData(dataObj().arrangement);
  });
  let arrangeLen = $derived(arrangeLengthBeats(arrangeData, 4));
  let blocks = $derived(arrangeBlocks(arrangeData, arrangeLen));
  let selBlock = $state<{ lane: number; startBeat: number } | null>(null);
  let playheadX = $derived(arrangeLen > 0 ? ((songBeatLive % arrangeLen) / arrangeLen) * ARR_W : 0);
  const blockX = (b: ArrangeBlock) => (b.startBeat / arrangeLen) * ARR_W;
  const blockW = (b: ArrangeBlock) => Math.max(3, ((b.endBeat - b.startBeat) / arrangeLen) * ARR_W);
  const isSel = (b: ArrangeBlock) =>
    !!selBlock && selBlock.lane === b.lane && Math.abs(selBlock.startBeat - b.startBeat) < 1e-6;
  /** ONE arrangement write path (delegates to the shared transactional helper so
   *  card + pop-out editor + the drag commit all go through the same seam). */
  function writeArrange(mut: (a: ArrangeData) => ArrangeData) {
    writeArrangeShared(id, mut);
  }
  function selectBlock(b: ArrangeBlock) {
    selBlock = isSel(b) ? null : { lane: b.lane, startBeat: b.startBeat };
  }

  // --- drag-to-move blocks on the timeline (horizontal/time drag, v1) ---
  // LOCAL render state only during the drag — never a per-pointermove ydoc write
  // (the live-store-write-storm guard). ONE commitMove write lands on DROP.
  const SNAP_BARS = 4; // bar-snap (the card timeline always bar-snaps; the
  //                      pop-out editor exposes a SNAP bar/beat toggle).
  let svgEl: SVGSVGElement | null = $state(null);
  let drag = $state<{ lane: number; startBeat: number; previewBeat: number; moved: boolean } | null>(
    null,
  );
  // True for the click that immediately follows a real move-drop, so the
  // trailing synthetic `click` doesn't toggle the just-moved block's selection.
  let suppressNextClick = false;
  /** True if block `b` is the one currently being dragged (render its ghost). */
  function isDragging(b: ArrangeBlock): boolean {
    return !!drag && drag.lane === b.lane && Math.abs(drag.startBeat - b.startBeat) < 1e-6;
  }
  function dragX(): number {
    return drag ? (drag.previewBeat / arrangeLen) * ARR_W : 0;
  }
  function onBlockDown(b: ArrangeBlock, ev: PointerEvent) {
    if (ev.button !== 0) return;
    // Don't select on grab — a plain click selects (onBlockClick); selecting
    // here too would let the trailing click TOGGLE it back off. The drag ghost
    // is highlighted via the .dragging class, not selection.
    drag = { lane: b.lane, startBeat: b.startBeat, previewBeat: b.startBeat, moved: false };
    (ev.currentTarget as Element).setPointerCapture?.(ev.pointerId);
    ev.preventDefault();
    ev.stopPropagation();
  }
  function onBlockMove(ev: PointerEvent) {
    if (!drag || !svgEl) return;
    const rect = svgEl.getBoundingClientRect();
    const raw = xToBeat(ev.clientX - rect.left, rect.width, arrangeLen);
    const snapped = snapBeat(raw, SNAP_BARS);
    drag = {
      ...drag,
      previewBeat: snapped,
      moved: drag.moved || Math.abs(snapped - drag.startBeat) > 1e-6,
    };
  }
  function onBlockUp(ev: PointerEvent) {
    if (!drag) return;
    if (drag.moved) {
      commitMove(id, drag.lane, drag.startBeat, drag.previewBeat, SNAP_BARS); // ONE write
      // Keep the moved block selected at its NEW beat; swallow the trailing
      // synthetic click so it doesn't toggle that selection back off.
      selBlock = { lane: drag.lane, startBeat: snapBeat(drag.previewBeat, SNAP_BARS) };
      suppressNextClick = true;
    }
    try { (ev.currentTarget as Element).releasePointerCapture?.(ev.pointerId); } catch { /* */ }
    drag = null;
  }
  function onBlockClick(b: ArrangeBlock) {
    if (suppressNextClick) { suppressNextClick = false; return; }
    selectBlock(b);
  }
  function deleteSelected() {
    if (!selBlock) return;
    const s = selBlock;
    writeArrange((a) => deleteBlock(a, s.lane, s.startBeat));
    selBlock = null;
  }
  function cycleSelectedSlot(dir: 1 | -1) {
    if (!selBlock) return;
    const b = blocks.find(isSel);
    if (!b) return;
    const next = (b.slot + dir + CLIP_SLOTS) % CLIP_SLOTS;
    const s = selBlock;
    writeArrange((a) => setBlockSlot(a, s.lane, s.startBeat, next));
  }
  function nudgeLength(barsDelta: number) {
    writeArrange((a) => setArrangeLength(a, Math.max(4, arrangeLen + barsDelta * 4)));
  }

  function cycleStep() {
    setParam('stepDiv')((stepDiv + 1) % STEP_LABELS.length);
  }

  // --- piano-roll note editor (selected clip) ---
  const EDIT_ROWS = 8;
  const MAX_EDIT_COLS = 16;
  let editorRow = $state(0); // per-user pitch-window offset, in scale-degree ROWS (not synced)
  function scaleLenOf(clip: NoteClipRecord): number {
    return scaleSteps(clip.scale).length;
  }

  let editClip = $derived.by<NoteClipRecord | null>(() => {
    void cardVersion;
    return clipAt(selectedClip);
  });
  let editCols = $derived(Math.min(MAX_EDIT_COLS, editClip?.lengthSteps ?? 16));
  let editLane = $derived(laneOf(selectedClip));
  let editSlot = $derived(slotOf(selectedClip));

  // Display row 0 = top (highest). editorRow scrolls the window by scale-degree
  // rows (row buttons shift by 1, octave buttons by scaleLen).
  function midiForDisplayRow(clip: NoteClipRecord, displayRow: number): number {
    const logicalRow = editorRow + (EDIT_ROWS - 1 - displayRow);
    return rowToMidi(logicalRow, clip.root, clip.scale);
  }
  /** '' for empty, else `vel0`..`vel2` (the note's velocity COLOUR — 3 buckets,
   *  2 of the 6 levels each, matching the grid's 3 note colours). */
  function cellVel(clip: NoteClipRecord, step: number, midi: number): string {
    const ev = noteCovering(clip, step, midi);
    return ev ? `vel${velBucket(ev.velocity)}` : '';
  }
  function writeClipData(next: NoteClipRecord) {
    writeData((d) => {
      if (!d.clips) d.clips = {};
      d.clips[String(selectedClip)] = { ...next, steps: next.steps.map((s) => ({ ...s })) };
    });
  }
  function toggleNote(step: number, displayRow: number) {
    const clip = clipAt(selectedClip);
    if (!clip) return;
    const midi = midiForDisplayRow(clip, displayRow);
    // Mono lanes replace-on-add; poly lanes cap at 5 voices per column.
    const mono = laneMono(dataObj(), laneOf(selectedClip));
    writeClipData(toggleNoteAt(clip, step, midi, { mono }));
  }
  /** Right-click a cell → cycle its velocity level (mouse equivalent of the
   *  grid's VEL-hold). Places a note at the default level if the cell is empty. */
  function cycleCellVelocity(step: number, displayRow: number) {
    const clip = clipAt(selectedClip);
    if (!clip) return;
    writeClipData(cycleVelocity(clip, step, midiForDisplayRow(clip, displayRow)));
  }
  // --- per-lane MONO toggle (left of each launch-grid row) ---
  function laneIsMono(lane: number): boolean {
    void cardVersion;
    return laneMono(dataObj(), lane);
  }
  function toggleLaneMono(lane: number) {
    writeData((d) => {
      const base = new Array<boolean>(CLIP_LANES).fill(false);
      if (Array.isArray(d.mono)) for (let i = 0; i < CLIP_LANES && i < d.mono.length; i++) base[i] = !!d.mono[i];
      base[lane] = !base[lane];
      d.mono = base;
    });
  }

  // --- per-lane clock RATE dropdown (right of each launch-grid row) ---
  // 1/8..1/2 divide (advance every Nth base step), 2x/4x multiply; default 1 =
  // the global STEP grid. Synced per-lane index into clip-clock's RATE_MULTS;
  // the engine scales that lane's step duration (card-only control for now —
  // no monome-grid / Launchpad surface).
  function laneRate(lane: number): number {
    void cardVersion;
    return laneRateIndex(dataObj(), lane);
  }
  function setLaneRate(lane: number, idx: number) {
    writeData((d) => {
      const base = new Array<number>(CLIP_LANES).fill(RATE_DEFAULT_INDEX);
      if (Array.isArray(d.rate)) {
        for (let i = 0; i < CLIP_LANES && i < d.rate.length; i++) base[i] = coerceRateIndex(d.rate[i]);
      }
      base[lane] = coerceRateIndex(idx);
      d.rate = base;
    });
  }

  // --- RESET (RST button / MIDI note / `reset` gate input) ---
  // Bumps the synced resetNonce; every peer's engine snaps ACTIVE lanes back to
  // step 1 and re-anchors the shared rate-phase origin (queued launches keep).
  function doReset() {
    writeData((d) => {
      d.resetNonce = (typeof d.resetNonce === 'number' ? d.resetNonce : 0) + 1;
    });
  }

  const SCALES: (ScaleName | undefined)[] = ['major', 'minor', 'pentatonic', undefined];
  function scaleName(s: ScaleName | undefined): string {
    return s ? s : 'chromatic';
  }
  function cycleScale() {
    const clip = clipAt(selectedClip);
    if (!clip) return;
    const i = SCALES.indexOf(clip.scale);
    const nextScale = SCALES[(i + 1) % SCALES.length];
    writeData((d) => {
      const c = (d.clips ?? {})[String(selectedClip)] as NoteClipRecord | undefined;
      if (c) { if (nextScale) c.scale = nextScale; else delete c.scale; }
    });
  }
  const LENGTHS = [16, 32, 64, 128, 8];
  function cycleLength() {
    const clip = clipAt(selectedClip);
    if (!clip) return;
    const i = LENGTHS.indexOf(clip.lengthSteps);
    const next = LENGTHS[(i + 1) % LENGTHS.length];
    writeData((d) => {
      const c = (d.clips ?? {})[String(selectedClip)] as NoteClipRecord | undefined;
      if (c) c.lengthSteps = next;
    });
  }
  function clearClip() {
    writeData((d) => {
      const c = (d.clips ?? {})[String(selectedClip)] as NoteClipRecord | undefined;
      if (c) c.steps = [];
    });
  }

  let playheadCol = $derived(
    view === 'edit' && lanePlaying(dataObj(), editLane) === editSlot ? curStep : -1,
  );

  const inputs = portsFromDef(clipplayerDef.inputs, { stop_all: 'STOP ALL', reset: 'RESET' });
  const outputs: PortDescriptor[] = Array.from({ length: CLIP_LANES }, (_, i) => [
    { id: `pitch${i + 1}`, label: `PITCH ${i + 1}`, cable: 'polyPitchGate' },
    { id: `gate${i + 1}`, label: `GATE ${i + 1}`, cable: 'gate' },
    { id: `vel${i + 1}`, label: `VEL ${i + 1}`, cable: 'cv' },
  ]).flat();
</script>

<div class="card audio clipplayer-card" data-testid="clipplayer-card">
  <div class="stripe"></div>
  <header class="title">
    <ModuleTitle {id} {data} defaultLabel="CLIP PLAYER" inline />
    <span class="title-btns">
      <!-- Gate-sampled S&H — ONE global toggle for all 8 lanes (replaces the 8
           external S&H modules). ON (default) holds each lane's pitch on rests. -->
      <button
        type="button"
        class="snh-toggle"
        class:on={snhOn}
        data-testid={`clipplayer-snh-toggle`}
        aria-pressed={snhOn}
        title={snhOn
          ? 'Sample & Hold ON — every lane\'s pitch CV holds on rests (latched to the gate edge). Replaces 8 external S&H. Click for continuous.'
          : 'Sample & Hold OFF — rests rewrite pitch (legacy continuous). Click to hold.'}
        onclick={() => setParam('snh')(snhOn ? 0 : 1)}
      >{snhOn ? 'S&H' : 'OFF'}</button>
      {#if showTransport}
        <button
          class="transport"
          class:on={transportRunning}
          onclick={toggleTransport}
          title={transportRunning ? 'Stop transport (TIMELORDE)' : 'Start transport (TIMELORDE)'}
          data-testid={`clipplayer-transport-${id}`}
        >{transportRunning ? '■' : '▶'}</button>
      {/if}
      <!-- ARRANGER RECORD cluster (EXPERIMENTAL — SESSION ⇄ ARRANGE + the red ●).
           ARRANGER RECORD records CLIP LAUNCHES onto a song timeline; it is NOT
           CLIP RECORD (recording INTO a clip — KEYS note-record / the teal AUTO
           section →). Grouped + labelled so the prominent red ● isn't mistaken
           for "record automation". -->
      <span class="arranger-grp" title="ARRANGER RECORD (experimental) — records clip LAUNCHES to a song timeline. Not CLIP RECORD (recording into a clip).">
      <button
        class="song-mode"
        class:on={arrangeMode}
        onclick={toggleArrangeMode}
        title={arrangeMode
          ? `ARRANGEMENT (experimental) — playing the recorded song (${arrangeEvents} events). Click for SESSION.`
          : 'SESSION — launch clips live. Click for ARRANGEMENT (experimental — play the recorded song).'}
        data-testid={`clipplayer-mode-${id}`}
      >{arrangeMode ? 'ARR' : 'SES'}</button>
      <button
        class="rec-btn"
        class:on={recording}
        onclick={toggleRecord}
        title={recording
          ? 'ARRANGER RECORD (experimental): recording clip LAUNCHES to the song timeline — click to stop. (This is NOT clip record — the teal ◉ AUTO clip-records knob moves.)'
          : recordMode === 'overdub'
            ? 'ARRANGER RECORD (experimental): record clip LAUNCHES into the arrangement (OVERDUB). NOT clip record — the teal ◉ AUTO clip-records knob moves.'
            : 'ARRANGER RECORD (experimental): record clip LAUNCHES into the arrangement (REPLACE). NOT clip record — the teal ◉ AUTO clip-records knob moves.'}
        aria-pressed={recording}
        data-testid={`clipplayer-record-${id}`}
      >●</button>
      <!-- REPLACE ⇄ OVERDUB record-mode toggle. -->
      <button
        class="rec-mode"
        class:overdub={recordMode === 'overdub'}
        onclick={toggleRecordMode}
        title={recordMode === 'overdub'
          ? 'OVERDUB — arranger record keeps the take + merges new launches. Click for REPLACE.'
          : 'REPLACE — arranger record clears + records fresh. Click for OVERDUB.'}
        aria-pressed={recordMode === 'overdub'}
        data-testid={`clipplayer-recmode-${id}`}
      >{recordMode === 'overdub' ? 'OVR' : 'RPL'}</button>
      </span>
      <span class="grp-div" aria-hidden="true"></span>
      <!-- AUTOMATION section (distinct teal): create the automation clip, then arm
           REC AUTO and just MOVE controls — moving any control auto-captures it and
           records it (continuous overdub). The badge shows track count + the clip's
           div·length; the override dot lights when a grabbed control overrides
           playback (click to re-enable all). -->
      {#if !autoClipPtr}
        <button
          class="auto-new"
          onclick={createAutomationClip}
          title="＋AUTO — create this player's AUTOMATION clip (CLIP RECORD for knob/control moves — NOT arranger record). Then arm ◉ AUTO and just move controls to record them. (Optional: right-click a control → Assign to automation lane.)"
          data-testid={`clipplayer-auto-new-${id}`}
        >＋AUTO</button>
      {:else}
        <span class="auto-block" title="AUTOMATION — CLIP RECORD for live control moves (distinct from the experimental arranger-record ●)">
          <button
            class="auto-arm"
            class:on={autoArmed}
            class:cd-yellow={autoCountdown?.color === 'yellow'}
            class:cd-red={autoCountdown?.color === 'red'}
            class:cd-on={autoCountdown?.on}
            onclick={toggleAutoArm}
            title={autoArmed
              ? 'CLIP RECORD (automation, continuous overdub) — just MOVE any control and it records that param; every loop the untouched params keep playing back. Click to STOP. The 🟡🟡🔴🔴 flash counts down the last 4 beats to the loop wrap.'
              : 'Arm CLIP RECORD (automation) — punches in at the clip’s next loop start, then just MOVE controls: each moved control is auto-captured + recorded, and overdubs every loop until you click again (manual stop). NOT the arranger-record ●.'}
            aria-pressed={autoArmed}
            data-testid={`clipplayer-auto-arm-${id}`}
          >◉ AUTO</button>
          <span
            class="auto-count"
            title={`${autoTrackCount} automated param(s) of ${MAX_AUTOMATION_TRACKS} max`}
            data-testid={`clipplayer-auto-count-${id}`}
          >{autoTrackCount}/{MAX_AUTOMATION_TRACKS}</span>
          <input
            class="auto-len"
            type="number"
            min="1"
            max={MAX_CLIP_STEPS}
            step="1"
            value={autoLen}
            title="Automation clip LENGTH in steps. Any count works (7, 13, …) — it is NOT snapped to a bar, so a coprime length drifts against the other clips (generative desync)."
            aria-label="automation clip length in steps"
            data-testid={`clipplayer-auto-len-${id}`}
            onchange={(e) => setAutoLen(Number((e.currentTarget as HTMLInputElement).value))}
          />
          <select
            class="auto-div"
            value={String(autoDiv)}
            title={`Automation clip clock DIVISION (${RATE_LABELS[autoDiv]}) — a slow rate stretches the record loop; overrides the lane rate, latched at the clip's loop boundary.`}
            aria-label="automation clip clock division"
            data-testid={`clipplayer-auto-div-${id}`}
            onchange={(e) => setAutoDiv(Number((e.currentTarget as HTMLSelectElement).value))}
          >
            {#each RATE_LABELS as lbl, ri (ri)}
              <option value={String(ri)}>{lbl}</option>
            {/each}
          </select>
          {#if autoOverridden}
            <button
              class="auto-override"
              onclick={reEnableAutomation}
              title="A grabbed control is overriding automation playback (live wins) — click to re-enable all"
              aria-label="re-enable automation"
              data-testid={`clipplayer-auto-override-${id}`}
            >●</button>
          {/if}
        </span>
      {/if}
      <!-- Pop out the full-window arranger editor (timeline large + all ops). -->
      <button
        class="arr-open"
        onclick={() => (arrangeEditorOpen = true)}
        title="Open the full-window arranger editor"
        data-testid={`clipplayer-arrange-open-${id}`}
      >ARR ⤢</button>
      <button
        class="grid-btn"
        class:on={gridBoundHere}
        disabled={!gridSupported}
        onclick={toggleGrid}
        title={!gridSupported
          ? 'monome grid needs WebSerial (Chromium only)'
          : gridBoundHere
            ? 'Disconnect monome grid'
            : 'Connect a monome grid to launch clips'}
        data-testid={`clipplayer-grid-${id}`}
      >GRID</button>
      <button class="stop-all" onclick={stopAll} title="Stop all lanes" data-testid={`clipplayer-stopall-${id}`}>■</button>
    </span>
  </header>

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="body">
      {#if view === 'session' && arrangeMode}
        <!-- SONG VIEW: arrangement timeline (8 lane rows × song-time bars). Each
             block is a recorded clip launch spanning until the next change; a
             playhead sweeps during playback. Click a block to select, then
             edit with the toolbar. -->
        <div class="song-view" data-testid="clipplayer-songview">
          <svg
            bind:this={svgEl}
            class="song-tl"
            viewBox={`0 0 ${ARR_W} ${CLIP_LANES * ARR_LANE_H}`}
            width={ARR_W}
            height={CLIP_LANES * ARR_LANE_H}
            role="img"
            aria-label="arrangement timeline"
            onpointermove={onBlockMove}
            onpointerup={onBlockUp}
            onpointercancel={onBlockUp}
          >
            {#each Array(CLIP_LANES) as _l, lane (lane)}
              <rect x="0" y={lane * ARR_LANE_H} width={ARR_W} height={ARR_LANE_H - 1}
                class="song-lane" style={`--lane-color:${laneColorEff(lane)}`} />
            {/each}
            <!-- bar gridlines (every 4 beats) -->
            {#each Array(Math.max(1, Math.ceil(arrangeLen / 4))) as _b, bar (bar)}
              <line class="song-bar" x1={(bar * 4 / arrangeLen) * ARR_W} y1="0"
                x2={(bar * 4 / arrangeLen) * ARR_W} y2={CLIP_LANES * ARR_LANE_H} />
            {/each}
            {#each blocks as b (b.lane + ':' + b.startBeat)}
              {@const dragging = isDragging(b)}
              <rect
                class="song-block"
                class:sel={isSel(b)}
                class:dragging
                x={dragging ? dragX() : blockX(b)}
                y={b.lane * ARR_LANE_H + 1}
                width={blockW(b)}
                height={ARR_LANE_H - 3}
                style={`--lane-color:${laneColorEff(b.lane)}`}
                role="button"
                tabindex="0"
                aria-label={`lane ${b.lane + 1} clip ${b.slot + 1} at beat ${b.startBeat}`}
                data-lane={b.lane}
                data-slot={b.slot}
                onpointerdown={(ev) => onBlockDown(b, ev)}
                onclick={() => onBlockClick(b)}
                onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectBlock(b); } }}
              />
            {/each}
            <line class="song-playhead" x1={playheadX} y1="0" x2={playheadX} y2={CLIP_LANES * ARR_LANE_H} />
          </svg>
          <div class="song-tools">
            <span class="song-info">{blocks.length} blocks · {Math.round(arrangeLen / 4)} bars</span>
            <span class="song-len">
              <button onclick={() => nudgeLength(-1)} title="Shorten loop by a bar" aria-label="shorten">−</button>
              <button onclick={() => nudgeLength(1)} title="Lengthen loop by a bar" aria-label="lengthen">+</button>
            </span>
            <span class="song-edit" class:dim={!selBlock}>
              <button onclick={() => cycleSelectedSlot(-1)} disabled={!selBlock} title="Previous clip" aria-label="prev clip">◂</button>
              <button onclick={() => cycleSelectedSlot(1)} disabled={!selBlock} title="Next clip" aria-label="next clip">▸</button>
              <button class="song-del" onclick={deleteSelected} disabled={!selBlock} title="Delete selected block" data-testid="clipplayer-song-del">⌫</button>
            </span>
          </div>
        </div>
      {:else if view === 'session'}
        <!-- 8×8 launch grid: COLS = instrument lanes (channels, ch1 = leftmost),
             ROWS = clip slots (slot 0 = top). Per-channel MONO header (top) +
             clock-RATE footer (bottom) sit above/below their own column. The
             flat clip index (lane*8 + slot) is unchanged — only the on-screen
             (lane,slot) → (col,row) placement is transposed to match the pad. -->
        <div class="launch-grid" data-testid="clipplayer-grid" role="grid" aria-label="clip launch grid">
          <!-- channel header: per-lane COLOR swatch (top) + MONO/POLY toggle
               (bottom), one stacked cell per channel column. The color swatch is
               the SINGLE source of the channel color — present for BOTH mono and
               poly channels — and tints that channel's whole column of clips. -->
          <div class="grid-head" role="row">
            {#each Array(CLIP_LANES) as _l, lane (lane)}
              <div class="head-cell" style={`--lane-color:${laneColorEff(lane)}`}>
                <input
                  type="color"
                  class="lane-color"
                  value={laneColorEff(lane)}
                  onchange={(e) => setLaneColor(lane, (e.currentTarget as HTMLInputElement).value)}
                  title={`Ch ${lane + 1} clip color — tints this channel's whole column (empty clips stay unlit)`}
                  aria-label={`channel ${lane + 1} clip color`}
                  data-lane={lane}
                  data-testid={`clipplayer-color-${lane}`}
                />
                <button
                  class="lane-mono"
                  class:on={laneIsMono(lane)}
                  onclick={() => toggleLaneMono(lane)}
                  title={laneIsMono(lane)
                    ? `Ch ${lane + 1}: MONO — one note per column (click for POLY)`
                    : `Ch ${lane + 1}: POLY — up to 5 notes per column (click for MONO)`}
                  aria-label={`channel ${lane + 1} ${laneIsMono(lane) ? 'mono' : 'poly'}`}
                  aria-pressed={laneIsMono(lane)}
                  data-lane={lane}
                  data-testid={`clipplayer-mono-${lane}`}
                >{laneIsMono(lane) ? '1' : '5'}</button>
              </div>
            {/each}
          </div>
          {#each Array(CLIP_SLOTS) as _s, slot (slot)}
            <div class="grid-row" role="row">
              {#each Array(CLIP_LANES) as _l, lane (lane)}
                {@const idx = clipIndex(slot, lane)}
                {@const st = padState(idx)}
                {@const isAuto = !!autoClipPtr && autoClipPtr.lane === lane && autoClipPtr.slot === slot}
                {@const cd = autoCountdown && isAuto ? autoCountdown : null}
                <button
                  class="pad {st}"
                  class:auto-cell={isAuto}
                  class:cd-yellow={cd?.color === 'yellow'}
                  class:cd-red={cd?.color === 'red'}
                  class:cd-on={cd?.on}
                  role="gridcell"
                  style={`--lane-color:${laneColorEff(lane)}`}
                  aria-label={isAuto
                    ? `automation clip, div ${RATE_LABELS[autoDiv]}, ${autoLen} steps`
                    : `lane ${lane + 1} slot ${slot + 1} ${st}`}
                  data-clip={idx}
                  data-lane={lane}
                  data-slot={slot}
                  data-state={st}
                  data-testid={`clipplayer-pad-${idx}`}
                  onclick={(e) => onPadClick(idx, e)}
                  ondblclick={() => onPadDblClick(idx)}
                >{#if isAuto}<span
                    class="auto-cell-badge"
                    data-testid={`clipplayer-auto-cell-badge-${id}`}
                  >{autoDisplay.badge}</span>{/if}</button>
              {/each}
            </div>
          {/each}
          <!-- channel footer: per-lane clock RATE select — divide/multiply this
               channel's step rate off the global STEP grid (card-only for now). -->
          <div class="grid-foot" role="row">
            {#each Array(CLIP_LANES) as _l, lane (lane)}
              <select
                class="lane-rate"
                class:offgrid={laneRate(lane) !== RATE_DEFAULT_INDEX}
                style={`--lane-color:${laneColorEff(lane)}`}
                value={String(laneRate(lane))}
                title={`Ch ${lane + 1} clock rate — ×/÷ the STEP grid (${RATE_LABELS[laneRate(lane)]})`}
                aria-label={`channel ${lane + 1} clock rate`}
                data-lane={lane}
                data-testid={`clipplayer-rate-${lane}`}
                onchange={(e) => setLaneRate(lane, Number((e.currentTarget as HTMLSelectElement).value))}
              >
                {#each RATE_LABELS as lbl, ri (ri)}
                  <option value={String(ri)}>{lbl}</option>
                {/each}
              </select>
            {/each}
          </div>
        </div>

        <!-- params -->
        <div class="knob-row">
          <button class="step-btn" onclick={cycleStep} title="Steps per beat" data-testid="clipplayer-step">
            <span class="lbl">STEP</span><span class="val">{STEP_LABELS[stepDiv]}</span>
          </button>
          <Knob value={octave} min={pdef('octave').min} max={pdef('octave').max} defaultValue={pdef('octave').defaultValue}
            label="OCT" curve="discrete" onchange={setParam('octave')} moduleId={id} paramId="octave" readLive={readLive('octave')} />
          <Knob value={gateLength} min={pdef('gateLength').min} max={pdef('gateLength').max} defaultValue={pdef('gateLength').defaultValue}
            label="GATE" curve="linear" onchange={setParam('gateLength')} moduleId={id} paramId="gateLength" readLive={readLive('gateLength')} />
          <button class="qnt" class:on={quantize} onclick={() => setParam('quantize')(quantize ? 0 : 1)}
            title="Quantize launch to clip boundary" data-testid="clipplayer-quantize">QNT</button>
          <!-- RESET: all ACTIVE clips snap to step 1 + the per-lane rate phase
               re-anchors to a common origin. MIDI-assignable (right-click). -->
          <MidiAssignButton moduleId={id} paramId="reset" label="RESET" momentary={false} onToggle={doReset}>
            <button
              class="rst"
              onclick={doReset}
              title="Reset all active clips to step 1 (re-anchors lane clock phase; queued launches keep). Right-click to MIDI-assign."
              data-testid="clipplayer-reset"
            >RST</button>
          </MidiAssignButton>
        </div>
      {:else if editClip}
        <!-- piano-roll note editor for the selected clip -->
        <div class="editor" data-testid="clipplayer-editor">
          <div class="editor-head">
            <button class="back" onclick={() => (view = 'session')} title="Back to session" data-testid="clipplayer-back">‹</button>
            <span class="sel">L{editLane + 1}·S{editSlot + 1}</span>
            <button class="tag" onclick={cycleScale} title="Cycle scale">{scaleName(editClip.scale)}</button>
            <span class="tag root">{noteNameForMidi(editClip.root)}</span>
            <button class="tag" onclick={cycleLength} title="Cycle clip length">{editClip.lengthSteps}st</button>
            <span class="oct">
              <button onclick={() => (editorRow -= scaleLenOf(editClip))} title="Octave down" aria-label="octave down">⤓</button>
              <button onclick={() => (editorRow -= 1)} title="Row down" aria-label="row down">↓</button>
              <button onclick={() => (editorRow += 1)} title="Row up" aria-label="row up">↑</button>
              <button onclick={() => (editorRow += scaleLenOf(editClip))} title="Octave up" aria-label="octave up">⤒</button>
            </span>
            <button class="clear" onclick={clearClip} title="Clear clip" data-testid="clipplayer-clear">⌫</button>
          </div>
          <div class="piano-roll" data-testid="clipplayer-pianoroll">
            {#each Array(EDIT_ROWS) as _r, row (row)}
              <div class="pr-row">
                {#each Array(editCols) as _c, step (step)}
                  {@const midi = midiForDisplayRow(editClip, row)}
                  <button
                    class="cell {cellVel(editClip, step, midi)}"
                    class:playhead={step === playheadCol}
                    class:beat={step % 4 === 0 || row % 4 === 0}
                    data-step={step}
                    data-row={row}
                    aria-label={`step ${step} row ${row}`}
                    title="Click: note on/off · Right-click: cycle velocity"
                    data-testid={`clipplayer-cell-${row}-${step}`}
                    onclick={() => toggleNote(step, row)}
                    oncontextmenu={(e) => { e.preventDefault(); cycleCellVelocity(step, row); }}
                  ></button>
                {/each}
              </div>
            {/each}
          </div>
          <!-- Launch the clip you're editing without leaving the editor:
               NOW = jump straight in (immediate, ignores QNT); QUEUE = arm it to
               drop in on the lane's next loop boundary (follows QNT). Both target
               THIS clip's lane+slot. -->
          <div class="editor-foot">
            <button
              class="launch now"
              class:on={lanePlaying(dataObj(), editLane) === editSlot}
              onclick={() => queueLane(editLane, editSlot, true)}
              title="Jump into this clip NOW (immediate — ignores QNT)"
              data-testid="clipplayer-edit-now"
            >NOW</button>
            <button
              class="launch queue"
              class:armed={laneQueued(dataObj(), editLane) === editSlot}
              onclick={() => queueLane(editLane, editSlot, false)}
              title="Queue this clip (drops in on the lane's next loop boundary)"
              data-testid="clipplayer-edit-queue"
            >QUEUE</button>
          </div>
        </div>
      {/if}
    </div>
  </PatchPanel>
</div>

{#if arrangeEditorOpen}
  <ClipArrangeEditor {id} {node} onClose={() => (arrangeEditorOpen = false)} />
{/if}

<style>
  .card {
    /* Transposed layout: 8 channel COLUMNS of 28px pads + 7×3px gaps = 245px of
       grid (MONO header / RATE footer are per-column strips of the same width),
       + 2×12px body padding = ~269px of content. Card stays 336px (hp 2 rack
       tier forces 360px anyway); the narrower grid centers in the body. The 3u
       tier (540px tall) has ample room for the now-taller grid. */
    width: 336px;
    background: var(--module-bg);
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text);
    /* Clear the top border stripe + the corner PatchPanel jacks so the title
       isn't clipped at the top. */
    padding-top: 26px;
    padding-bottom: 16px;
    position: relative;
    /* Fill the pinned rack height (rack-sized sets a fixed height taller than
       the natural content): stack as a flex column so the body can absorb the
       slack instead of leaving dead space at the bottom. */
    display: flex;
    flex-direction: column;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  :global(.svelte-flow__node:hover) .card { border-color: var(--accent-dim); }
  :global(.svelte-flow__node.selected) .card {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .stripe {
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    border-radius: 2px 2px 0 0;
    background: var(--cable-polyPitchGate, var(--cable-pitch, var(--cable-audio)));
  }
  .title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 10px 4px;
  }
  .title-btns {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .transport,
  .stop-all {
    background: var(--control-bg, #222);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 2px;
    font-size: 11px;
    line-height: 1;
    padding: 2px 6px;
    cursor: pointer;
  }
  .transport.on {
    color: var(--accent, #6f9);
    border-color: var(--accent, #6f9);
  }
  .grid-btn {
    background: var(--control-bg, #222);
    color: var(--text-dim, #999);
    border: 1px solid var(--border);
    border-radius: 2px;
    font-size: 9px;
    letter-spacing: 0.05em;
    line-height: 1;
    padding: 3px 6px;
    cursor: pointer;
  }
  .grid-btn.on { color: var(--accent, #6cf); border-color: var(--accent, #6cf); }
  .grid-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  /* Gate-sampled S&H toggle — sits in the .title-btns row (upper-right). Same
     pill styling as the other title toggles; ON = accent-highlighted. */
  .snh-toggle {
    background: var(--control-bg, #222);
    color: var(--text-dim, #999);
    border: 1px solid var(--border);
    border-radius: 2px;
    font-size: 9px;
    letter-spacing: 0.05em;
    line-height: 1;
    padding: 3px 5px;
    cursor: pointer;
  }
  .snh-toggle.on { color: var(--accent, #6f9); border-color: var(--accent, #6f9); }
  /* SONG MODE: SES/ARR toggle + RECORD arm */
  .song-mode {
    background: var(--control-bg, #222);
    color: var(--text-dim, #999);
    border: 1px solid var(--border);
    border-radius: 2px;
    font-size: 9px;
    letter-spacing: 0.05em;
    line-height: 1;
    padding: 3px 5px;
    cursor: pointer;
  }
  .song-mode.on { color: var(--accent, #c9f); border-color: var(--accent, #c9f); }
  .rec-btn {
    background: var(--control-bg, #222);
    color: var(--text-dim, #999);
    border: 1px solid var(--border);
    border-radius: 2px;
    font-size: 11px;
    line-height: 1;
    padding: 2px 5px;
    cursor: pointer;
  }
  .rec-btn.on {
    color: #fff;
    background: #c0392b;
    border-color: #e74c3c;
    animation: rec-blink 1s steps(2) infinite;
  }
  @keyframes rec-blink { 50% { opacity: 0.5; } }
  /* REPLACE/OVERDUB record-mode pill (next to REC). */
  .rec-mode {
    background: var(--control-bg, #222);
    color: var(--text-dim, #999);
    border: 1px solid var(--border);
    border-radius: 2px;
    font-size: 9px;
    letter-spacing: 0.05em;
    line-height: 1;
    padding: 3px 5px;
    cursor: pointer;
  }
  .rec-mode.overdub { color: var(--accent, #e8b35b); border-color: var(--accent, #e8b35b); }
  /* AUTOMATION LANE controls (task #183): +AUTO create button, then the ARM
     toggle + track-count badge + override dot. Same pill language as the other
     title toggles. */
  .auto-new,
  .auto-arm {
    background: var(--control-bg, #222);
    color: var(--text-dim, #999);
    border: 1px solid var(--border);
    border-radius: 2px;
    font-size: 9px;
    letter-spacing: 0.05em;
    line-height: 1;
    padding: 3px 5px;
    cursor: pointer;
  }
  .auto-new:hover { color: var(--accent, #b06cff); border-color: var(--accent, #b06cff); }
  /* AUTOMATION arm — a distinct TEAL record affordance so it is never mistaken for
     the arranger's red ● (they sit apart, separated by .grp-div). Idle = teal tint;
     armed = bright teal, pulsing. */
  .auto-arm {
    color: #4fd6cf;
    border-color: #1b6b66;
  }
  .auto-arm:hover { color: #7ff0ea; border-color: #2fb0a8; }
  .auto-arm.on {
    color: #04211f;
    background: #14b8a6;
    border-color: #5ff0e4;
    animation: rec-blink 1s steps(2) infinite;
  }
  /* COUNTDOWN mirror (last 4 beats before the automation clip's own wrap):
     yellow (4,3) → red (2,1), pulsing bright ON the beat (.cd-on), dim between.
     Overrides the steady armed purple; no CSS animation (the pulse is driven by
     the polled render state so it stays beat-synced to the clip, not wall time). */
  .auto-arm.cd-yellow { animation: none; color: #1a1400; background: #6e6000; border-color: #b0a000; }
  .auto-arm.cd-yellow.cd-on { background: #d9c000; border-color: #fff06a; }
  .auto-arm.cd-red { animation: none; color: #fff; background: #7a1010; border-color: #b03030; }
  .auto-arm.cd-red.cd-on { background: #ff2a2a; border-color: #ff8a8a; }
  /* Visual grouping: the experimental arranger cluster vs the AUTOMATION section,
     separated by a divider so the red ● (arranger) reads as apart from the teal
     ◉ AUTO (automation). */
  .arranger-grp { display: inline-flex; align-items: center; gap: 3px; }
  .grp-div {
    display: inline-block;
    width: 1px;
    align-self: stretch;
    margin: 1px 3px;
    background: var(--border, #3a3a44);
  }
  .auto-block { display: inline-flex; align-items: center; gap: 3px; }
  .auto-len {
    width: 34px;
    font-size: 8px;
    padding: 2px 3px;
    background: var(--control-bg, #222);
    color: var(--text-dim, #bbb);
    border: 1px solid var(--border);
    border-radius: 2px;
    font-variant-numeric: tabular-nums;
  }
  .auto-div {
    font-size: 8px;
    padding: 2px 1px;
    background: var(--control-bg, #222);
    color: var(--text-dim, #bbb);
    border: 1px solid var(--border);
    border-radius: 2px;
  }
  .auto-count {
    font-size: 8px;
    color: var(--text-dim, #999);
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.02em;
    pointer-events: none;
  }
  .auto-override {
    background: transparent;
    border: none;
    color: #e8b35b;
    font-size: 11px;
    line-height: 1;
    padding: 0 2px;
    cursor: pointer;
    animation: rec-blink 1s steps(2) infinite;
  }
  .auto-override:hover { color: #ffd27a; }
  /* Pop-out arranger editor open button. */
  .arr-open {
    background: var(--control-bg, #222);
    color: var(--text-dim, #999);
    border: 1px solid var(--border);
    border-radius: 2px;
    font-size: 9px;
    letter-spacing: 0.05em;
    line-height: 1;
    padding: 3px 5px;
    cursor: pointer;
  }
  .arr-open:hover { color: var(--accent, #c9f); border-color: var(--accent, #c9f); }
  .body {
    margin-top: 18px;
    padding: 0 12px;
    /* Grow to fill the card's pinned rack height and CENTER the grid+controls
       cluster in the leftover slack, so the content reads as intentionally
       placed instead of bunched at the top with a blank bottom. */
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 14px;
  }
  /* SONG VIEW — arrangement timeline */
  .song-view { display: flex; flex-direction: column; gap: 6px; align-items: center; }
  .song-tl { background: #0d0d0d; border: 1px solid var(--border); border-radius: 2px; }
  .song-lane { fill: color-mix(in srgb, var(--lane-color) 20%, #06080d); }
  .song-bar { stroke: rgba(255, 255, 255, 0.08); stroke-width: 1; }
  .song-block {
    fill: color-mix(in srgb, var(--lane-color) 80%, #0b0d12);
    stroke: color-mix(in srgb, var(--lane-color) 70%, #fff);
    stroke-width: 0.5;
    cursor: grab;
    rx: 1;
  }
  .song-block.sel { stroke: #fff; stroke-width: 1.5; }
  .song-block.dragging { cursor: grabbing; opacity: 0.85; stroke: #fff; stroke-width: 1.5; }
  .song-playhead { stroke: var(--accent, #6cf); stroke-width: 1; opacity: 0.9; pointer-events: none; }
  .song-tools {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 9px;
    color: var(--text-dim, #999);
  }
  .song-tools button {
    background: var(--control-bg, #222);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 2px;
    font-size: 10px;
    line-height: 1;
    padding: 2px 5px;
    cursor: pointer;
  }
  .song-tools button:disabled { opacity: 0.4; cursor: not-allowed; }
  .song-edit.dim { opacity: 0.7; }
  .song-del { color: #e6a; }
  .launch-grid {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
  }
  /* A grid ROW is now one clip SLOT across all 8 channels; the head/foot strips
     hold the per-channel MONO toggle / RATE select. All share the 3px column
     gap so the 8 channel columns line up top-to-bottom. */
  .grid-row,
  .grid-head,
  .grid-foot { display: flex; gap: 3px; }
  /* Fixed INTEGER pad size (no flex:1 / aspect-ratio) so the 8-column layout is
     pixel-deterministic — sub-pixel flex rounding drifts across columns and
     flakes the VRT baseline. */
  .pad {
    width: 28px;
    height: 28px;
    flex: none;
    border: 1px solid var(--border);
    border-radius: 2px;
    background: #1a1a1a;
    cursor: pointer;
    padding: 0;
  }
  /* Channel-tinted states, all mixed off the single --lane-color (the swatch's
     picked color, else the default-hue hex). EMPTY pads carry no state class, so
     only the dark base .pad background shows — empty stays unlit. loaded = dim,
     queued = mid (+ blink), playing = full color (+ a soft glow). */
  .pad.loaded { background: color-mix(in srgb, var(--lane-color) 38%, #0b0d12); }
  .pad.queued {
    background: color-mix(in srgb, var(--lane-color) 72%, #0b0d12);
    animation: blink 0.4s steps(2) infinite;
  }
  .pad.playing {
    background: var(--lane-color);
    box-shadow: 0 0 5px color-mix(in srgb, var(--lane-color) 70%, transparent);
  }
  /* AUTOMATION countdown flash on the automation clip's OWN cell (mirrors the
     launchpad pad): 🟡🟡🔴🔴 in the last 4 beats, bright ON the beat (.cd-on). The
     pulse is driven by the polled render state (beat-synced to the clip), so no
     CSS keyframe animation. */
  .pad.cd-yellow { background: #6e6000; box-shadow: none; }
  .pad.cd-yellow.cd-on { background: #d9c000; box-shadow: 0 0 6px #d9c000; }
  .pad.cd-red { background: #7a1010; box-shadow: none; }
  .pad.cd-red.cd-on { background: #ff2a2a; box-shadow: 0 0 6px #ff2a2a; }
  /* AUTOMATION clip cell: a teal ring + a tiny div·length badge so the clip's REAL
     timing (e.g. "1/4·64") is visible ON the clip, not just buried in the AUTO
     block (the "I saw 1/1" confusion was the per-lane rate row, a different thing). */
  .pad.auto-cell { outline: 1px solid #14b8a6; outline-offset: -1px; }
  .auto-cell-badge {
    position: absolute;
    left: 1px;
    bottom: 0;
    font-size: 6px;
    line-height: 1;
    letter-spacing: -0.02em;
    color: #7ff0ea;
    text-shadow: 0 0 2px #000, 0 0 2px #000;
    pointer-events: none;
    font-variant-numeric: tabular-nums;
  }
  .pad { position: relative; }
  @keyframes blink { 50% { opacity: 0.35; } }

  .editor { display: flex; flex-direction: column; gap: 6px; }
  .editor-head {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 9px;
    color: var(--text-dim, #999);
  }
  .editor-head .sel { color: var(--text); font-weight: 600; }
  .editor-head .tag {
    background: var(--control-bg, #222);
    color: var(--text-dim, #aaa);
    border: 1px solid var(--border);
    border-radius: 2px;
    font-size: 9px;
    padding: 1px 4px;
    line-height: 1.4;
    cursor: pointer;
  }
  .editor-head .tag.root { cursor: default; }
  .back, .clear {
    background: var(--control-bg, #222);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 2px;
    font-size: 11px;
    line-height: 1;
    padding: 1px 5px;
    cursor: pointer;
  }
  .clear { margin-left: auto; }
  .oct { display: inline-flex; }
  .oct button {
    background: var(--control-bg, #222);
    color: var(--text);
    border: 1px solid var(--border);
    width: 16px; height: 15px;
    font-size: 10px; line-height: 1;
    cursor: pointer;
    margin-left: 1px;
  }
  .piano-roll { display: flex; flex-direction: column; align-items: center; gap: 2px; }
  /* Edit-view launch row — NOW (left) + QUEUE (right), bottom-right of the editor. */
  .editor-foot {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
    margin-top: 4px;
  }
  .editor-foot .launch {
    background: var(--control-bg, #222);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 2px;
    font-size: 10px;
    letter-spacing: 0.05em;
    line-height: 1;
    padding: 4px 9px;
    cursor: pointer;
  }
  .editor-foot .launch.now:hover,
  .editor-foot .launch.queue:hover { border-color: var(--accent-dim, #6f9); }
  /* NOW lights green while this clip is the one playing in its lane;
     QUEUE pulses amber while this clip is armed to drop in. */
  .editor-foot .launch.now.on {
    color: var(--accent, #6f9);
    border-color: var(--accent, #6f9);
  }
  .editor-foot .launch.queue.armed {
    color: #e8b35b;
    border-color: #e8b35b;
    animation: rec-blink 1s steps(2, jump-none) infinite;
  }
  .pr-row { display: flex; gap: 2px; }
  .cell {
    width: 15px;
    height: 13px;
    flex: none;
    border: 1px solid var(--border);
    border-radius: 1px;
    background: #161616;
    cursor: pointer;
    padding: 0;
  }
  /* Beat/bar guide: every 4th step (the 1/5/9/13 downbeats) and every 4th pitch
     row read a touch lighter, so the beat structure is easy to scan at a glance.
     Empty cells only — the vel/playhead rules below (later, same specificity)
     override on a placed note. */
  .cell.beat { background: #242424; }
  /* note cells by velocity COLOUR — 3 buckets (low/med/high), 2 of the 6
     velocity levels each, matching the grid's 3 note colours. A placed note
     (even 0%) always shows a colour; only an empty cell is dark. */
  .cell.vel0 { background: hsl(200 55% 32%); }
  .cell.vel1 { background: hsl(200 75% 48%); }
  .cell.vel2 { background: hsl(200 92% 64%); }
  /* the playhead lights the whole column so you see the tempo pulse cross the clip */
  .cell.playhead { background: rgba(108, 170, 255, 0.22); border-color: var(--accent, #6cf); }
  .cell.vel0.playhead,
  .cell.vel1.playhead,
  .cell.vel2.playhead { background: hsl(200 95% 70%); }
  /* One stacked header cell per channel COLUMN: the COLOR swatch (top) over the
     MONO/POLY toggle (bottom). 28px wide to align with the pads below; the
     --lane-color set here is inherited by both children. */
  .head-cell {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    width: 28px;
    flex: none;
  }
  /* per-channel COLOR picker — the single source of the channel color, present
     for BOTH mono and poly channels. Rendered as a flat 28×14 swatch (native
     platform chrome stripped so the layout stays VRT-stable). */
  .lane-color {
    width: 28px;
    height: 14px;
    flex: none;
    border: 1px solid var(--border);
    border-radius: 2px;
    padding: 0;
    background: none;
    cursor: pointer;
    appearance: none;
    -webkit-appearance: none;
  }
  .lane-color::-webkit-color-swatch-wrapper { padding: 0; }
  .lane-color::-webkit-color-swatch { border: none; border-radius: 1px; }
  .lane-color::-moz-color-swatch { border: none; border-radius: 1px; }
  /* per-channel MONO/POLY toggle — one per channel COLUMN, sits below its color
     swatch in the header strip (28px wide to align with the pads below). */
  .lane-mono {
    width: 28px;
    height: 18px;
    flex: none;
    border: 1px solid var(--border);
    border-radius: 2px;
    background: #141414;
    color: var(--text-dim, #888);
    font-size: 9px;
    font-weight: 600;
    line-height: 1;
    cursor: pointer;
    padding: 0;
  }
  .lane-mono.on {
    background: color-mix(in srgb, var(--lane-color) 55%, #0b0d12);
    color: #fff;
    border-color: color-mix(in srgb, var(--lane-color) 78%, #0b0d12);
  }
  /* per-channel clock RATE dropdown — one per channel COLUMN, sits in the footer
     strip directly below its column. Fixed integer size (28px wide to align with
     the pads above; RATE_LABELS are ≤3 chars so they fit) so the layout stays
     pixel-deterministic. */
  .lane-rate {
    width: 28px;
    height: 22px;
    flex: none;
    border: 1px solid var(--border);
    border-radius: 2px;
    background: #141414;
    color: var(--text-dim, #888);
    font-size: 9px;
    line-height: 1;
    padding: 0 1px;
    cursor: pointer;
    appearance: none; /* flat pill, no platform chrome — VRT-stable */
    text-align: center;
    text-align-last: center;
  }
  /* highlight a lane that's off the global grid so the polyrhythm reads at a
     glance (same accent language as the mono toggle). */
  .lane-rate.offgrid {
    color: #fff;
    background: color-mix(in srgb, var(--lane-color) 55%, #0b0d12);
    border-color: color-mix(in srgb, var(--lane-color) 78%, #0b0d12);
  }
  .knob-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    padding-top: 2px;
  }
  .step-btn {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1px;
    background: var(--control-bg, #222);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 2px;
    padding: 3px 7px;
    cursor: pointer;
  }
  .step-btn .lbl { font-size: 8px; color: var(--text-dim, #999); letter-spacing: 0.05em; }
  .step-btn .val { font-size: 11px; font-weight: 600; }
  .qnt {
    background: var(--control-bg, #222);
    color: var(--text-dim, #999);
    border: 1px solid var(--border);
    border-radius: 2px;
    font-size: 10px;
    padding: 4px 6px;
    cursor: pointer;
  }
  .qnt.on { color: var(--accent, #6cf); border-color: var(--accent, #6cf); }
  /* RESET — all active clips to step 1 (knob-row, next to QNT). */
  .rst {
    background: var(--control-bg, #222);
    color: var(--text-dim, #999);
    border: 1px solid var(--border);
    border-radius: 2px;
    font-size: 10px;
    letter-spacing: 0.05em;
    padding: 4px 6px;
    cursor: pointer;
  }
  .rst:hover { color: var(--accent, #6cf); border-color: var(--accent, #6cf); }
</style>

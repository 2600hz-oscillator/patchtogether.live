<script lang="ts">
  // CLIP PLAYER card (v2) — the always-available face of the 8-lane clip
  // launcher. Two views in one 3u tile:
  //   SESSION (default): an 8×8 launch grid. ROWS = 8 instrument lanes, COLS = 8
  //     clip slots. Single-click a cell = launch/queue that clip in its lane;
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
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch, ydoc } from '$lib/graph/store';
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
    type ClipPlayerData,
    type NoteClipRecord,
  } from '$lib/audio/modules/clip-types';
  import {
    coerceArrangeData,
    arrangeBlocks,
    arrangeLengthBeats,
    deleteBlock,
    setBlockSlot,
    setArrangeLength,
    type ArrangeBlock,
    type ArrangeData,
  } from '$lib/audio/modules/clip-arrange';
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

  // Re-render when the synced node.data / params change.
  let cardVersion = $state(0);
  $effect(() => {
    const h = () => { cardVersion = cardVersion + 1; };
    ydoc.on('update', h);
    return () => ydoc.off('update', h);
  });

  function pdef(pid: string) {
    return clipplayerDef.params.find((p) => p.id === pid)!;
  }
  const STEP_LABELS = ['1/4', '1/8', '1/16', '1/32'];
  let stepDiv = $derived((void cardVersion, Math.round(node?.params.stepDiv ?? pdef('stepDiv').defaultValue)));
  let quantize = $derived((void cardVersion, (node?.params.quantize ?? 1) >= 0.5));
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
  // 8 distinct row hues so instruments read at a glance.
  const laneHue = (lane: number) => Math.round((lane * 360) / CLIP_LANES);

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
  let arrangeEvents = $derived(
    (void cardVersion, Array.isArray(dataObj().arrangement?.events) ? dataObj().arrangement!.events!.length : 0),
  );
  /** Arm/disarm recording. Arming clears the log + restarts song time (engine,
   *  on the rising edge) — v1 replace semantics. */
  function toggleRecord() {
    writeData((d) => { d.recording = !d.recording; });
  }
  /** Flip SESSION ⇄ ARRANGEMENT playback. */
  function toggleArrangeMode() {
    writeData((d) => { d.clipMode = d.clipMode === 'arrangement' ? 'session' : 'arrangement'; });
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
  function writeArrange(mut: (a: ArrangeData) => ArrangeData) {
    writeData((d) => { d.arrangement = mut(coerceArrangeData(d.arrangement)); });
  }
  function selectBlock(b: ArrangeBlock) {
    selBlock = isSel(b) ? null : { lane: b.lane, startBeat: b.startBeat };
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

  const inputs: PortDescriptor[] = [{ id: 'stop_all', label: 'STOP ALL', cable: 'gate' }];
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
      {#if showTransport}
        <button
          class="transport"
          class:on={transportRunning}
          onclick={toggleTransport}
          title={transportRunning ? 'Stop transport (TIMELORDE)' : 'Start transport (TIMELORDE)'}
          data-testid={`clipplayer-transport-${id}`}
        >{transportRunning ? '■' : '▶'}</button>
      {/if}
      <!-- SONG MODE: SESSION ⇄ ARRANGE + RECORD arm. -->
      <button
        class="song-mode"
        class:on={arrangeMode}
        onclick={toggleArrangeMode}
        title={arrangeMode
          ? `ARRANGEMENT — playing the recorded song (${arrangeEvents} events). Click for SESSION.`
          : 'SESSION — launch clips live. Click for ARRANGEMENT (play the recorded song).'}
        data-testid={`clipplayer-mode-${id}`}
      >{arrangeMode ? 'ARR' : 'SES'}</button>
      <button
        class="rec-btn"
        class:on={recording}
        onclick={toggleRecord}
        title={recording
          ? 'Recording launches to the arrangement — click to stop'
          : 'Record clip launches into the arrangement (clears + records fresh)'}
        aria-pressed={recording}
        data-testid={`clipplayer-record-${id}`}
      >●</button>
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
            class="song-tl"
            viewBox={`0 0 ${ARR_W} ${CLIP_LANES * ARR_LANE_H}`}
            width={ARR_W}
            height={CLIP_LANES * ARR_LANE_H}
            role="img"
            aria-label="arrangement timeline"
          >
            {#each Array(CLIP_LANES) as _l, lane (lane)}
              <rect x="0" y={lane * ARR_LANE_H} width={ARR_W} height={ARR_LANE_H - 1}
                class="song-lane" style={`--lane-hue:${laneHue(lane)}`} />
            {/each}
            <!-- bar gridlines (every 4 beats) -->
            {#each Array(Math.max(1, Math.ceil(arrangeLen / 4))) as _b, bar (bar)}
              <line class="song-bar" x1={(bar * 4 / arrangeLen) * ARR_W} y1="0"
                x2={(bar * 4 / arrangeLen) * ARR_W} y2={CLIP_LANES * ARR_LANE_H} />
            {/each}
            {#each blocks as b (b.lane + ':' + b.startBeat)}
              <rect
                class="song-block"
                class:sel={isSel(b)}
                x={blockX(b)}
                y={b.lane * ARR_LANE_H + 1}
                width={blockW(b)}
                height={ARR_LANE_H - 3}
                style={`--lane-hue:${laneHue(b.lane)}`}
                role="button"
                tabindex="0"
                aria-label={`lane ${b.lane + 1} clip ${b.slot + 1} at beat ${b.startBeat}`}
                data-lane={b.lane}
                data-slot={b.slot}
                onclick={() => selectBlock(b)}
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
        <!-- 8×8 launch grid: rows = instrument lanes, cols = clip slots -->
        <div class="launch-grid" data-testid="clipplayer-grid" role="grid" aria-label="clip launch grid">
          {#each Array(CLIP_LANES) as _l, lane (lane)}
            <div class="grid-row" role="row" style={`--lane-hue:${laneHue(lane)}`}>
              <button
                class="lane-mono"
                class:on={laneIsMono(lane)}
                onclick={() => toggleLaneMono(lane)}
                title={laneIsMono(lane)
                  ? `Lane ${lane + 1}: MONO — one note per column (click for POLY)`
                  : `Lane ${lane + 1}: POLY — up to 5 notes per column (click for MONO)`}
                aria-label={`lane ${lane + 1} ${laneIsMono(lane) ? 'mono' : 'poly'}`}
                aria-pressed={laneIsMono(lane)}
                data-lane={lane}
                data-testid={`clipplayer-mono-${lane}`}
              >{laneIsMono(lane) ? '1' : '5'}</button>
              {#each Array(CLIP_SLOTS) as _s, slot (slot)}
                {@const idx = clipIndex(slot, lane)}
                {@const st = padState(idx)}
                <button
                  class="pad {st}"
                  role="gridcell"
                  aria-label={`lane ${lane + 1} slot ${slot + 1} ${st}`}
                  data-clip={idx}
                  data-lane={lane}
                  data-slot={slot}
                  data-state={st}
                  onclick={(e) => onPadClick(idx, e)}
                  ondblclick={() => onPadDblClick(idx)}
                ></button>
              {/each}
            </div>
          {/each}
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
                    data-step={step}
                    data-row={row}
                    aria-label={`step ${step} row ${row}`}
                    title="Click: note on/off · Right-click: cycle velocity"
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

<style>
  .card {
    width: 300px;
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
  .song-lane { fill: hsl(var(--lane-hue) 30% 8%); }
  .song-bar { stroke: rgba(255, 255, 255, 0.08); stroke-width: 1; }
  .song-block {
    fill: hsl(var(--lane-hue) 65% 45%);
    stroke: hsl(var(--lane-hue) 70% 60%);
    stroke-width: 0.5;
    cursor: pointer;
    rx: 1;
  }
  .song-block.sel { stroke: #fff; stroke-width: 1.5; }
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
  .grid-row { display: flex; gap: 3px; }
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
  /* lane-tinted states (hue per row) */
  .pad.loaded { background: hsl(var(--lane-hue) 45% 28%); }
  .pad.queued {
    background: hsl(var(--lane-hue) 70% 50%);
    animation: blink 0.4s steps(2) infinite;
  }
  .pad.playing {
    background: hsl(var(--lane-hue) 80% 55%);
    box-shadow: 0 0 5px hsl(var(--lane-hue) 90% 60%);
  }
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
  /* per-lane MONO/POLY toggle to the left of each launch-grid row */
  .lane-mono {
    width: 16px;
    height: 28px;
    flex: none;
    margin-right: 3px;
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
    background: hsl(var(--lane-hue) 55% 34%);
    color: #fff;
    border-color: hsl(var(--lane-hue) 70% 55%);
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
</style>

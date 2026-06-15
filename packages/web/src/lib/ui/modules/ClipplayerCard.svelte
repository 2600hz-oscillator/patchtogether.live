<script lang="ts">
  // CLIP PLAYER card (v2) — the always-available face of the 8-lane clip
  // launcher. Two views in one 3u tile:
  //   SESSION (default): an 8×8 launch grid. ROWS = 8 instrument lanes, COLS = 8
  //     clip slots. Single-click a cell = launch/queue that clip in its lane;
  //     click the playing cell = stop the lane; double-click = open its editor.
  //     A ▶/■ transport drives TIMELORDE (hidden when TIMELORDE is externally
  //     clocked). STEP / OCT / GATE / QNT params below.
  //   EDIT: a Deluge-style note editor for one clip (X = step, Y = pitch, in-key
  //     rows). Click a cell to place a note; click it again to cycle its
  //     velocity LOW→MED→HIGH→remove (the same gesture the grid uses).
  //
  // Clock is LOCKED TO TIMELORDE (no BPM knob, no clock cable). The monome grid
  // drives the SAME actions via lib/grid. All ports live in the shared yellow
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
    cycleNoteAt,
    noteAt,
    velTier,
    type ClipPlayerData,
    type NoteClipRecord,
  } from '$lib/audio/modules/clip-types';
  import type { ScaleName } from '$lib/mike/music-theory';
  import { noteNameForMidi } from '$lib/audio/note-entry';
  import ModuleTitle from './ModuleTitle.svelte';
  import {
    serialAvailable as gridSerialAvailable,
    connect as gridConnect,
    isConnected as gridIsConnected,
    connectedRune as gridConnectedRune,
  } from '$lib/grid/grid-device.svelte';
  import {
    bindGridToClip,
    unbindGrid,
    boundClipNode,
    bindingRune,
  } from '$lib/grid/grid-clip-binding.svelte';

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
  function queueLane(lane: number, action: number | 'stop' | null) {
    writeData((d) => {
      if (!Array.isArray(d.queued) || d.queued.length < CLIP_LANES) {
        const base: (number | 'stop' | null)[] = new Array(CLIP_LANES).fill(null);
        if (Array.isArray(d.queued)) {
          for (let i = 0; i < d.queued.length && i < CLIP_LANES; i++) base[i] = d.queued[i];
        }
        d.queued = base;
      }
      d.queued[lane] = action;
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
  function onPadClick(idx: number) {
    if (clickTimer) clearTimeout(clickTimer);
    clickTimer = setTimeout(() => {
      clickTimer = null;
      launchPad(idx);
    }, 220);
  }
  function onPadDblClick(idx: number) {
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
    ensureClip(idx);
    selectedClip = idx;
    view = 'edit';
  }
  function launchPad(idx: number) {
    const lane = laneOf(idx);
    const slot = slotOf(idx);
    if (!clips[String(idx)]) {
      ensureClip(idx);
      queueLane(lane, slot); // create + arm so it starts on the next boundary
      return;
    }
    if (lanePlaying(dataObj(), lane) === slot) queueLane(lane, 'stop');
    else queueLane(lane, slot);
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

  function cycleStep() {
    setParam('stepDiv')((stepDiv + 1) % STEP_LABELS.length);
  }

  // --- Deluge note editor (selected clip) ---
  const EDIT_ROWS = 8;
  const MAX_EDIT_COLS = 16;
  let editorOctave = $state(0); // per-user view offset (octaves), not synced

  let editClip = $derived.by<NoteClipRecord | null>(() => {
    void cardVersion;
    return clipAt(selectedClip);
  });
  let editCols = $derived(Math.min(MAX_EDIT_COLS, editClip?.lengthSteps ?? 16));
  let editLane = $derived(laneOf(selectedClip));
  let editSlot = $derived(slotOf(selectedClip));

  // Display row 0 = top (highest). Logical row 0 = clip root.
  function midiForDisplayRow(clip: NoteClipRecord, displayRow: number): number {
    const scaleLen = scaleSteps(clip.scale).length;
    const logicalRow = editorOctave * scaleLen + (EDIT_ROWS - 1 - displayRow);
    return rowToMidi(logicalRow, clip.root, clip.scale);
  }
  function cellTier(clip: NoteClipRecord, step: number, midi: number): '' | 'low' | 'med' | 'high' {
    const ev = noteAt(clip, step, midi);
    return ev ? velTier(ev.velocity) : '';
  }
  function cycleNote(step: number, displayRow: number) {
    const clip = clipAt(selectedClip);
    if (!clip) return;
    const midi = midiForDisplayRow(clip, displayRow);
    const next = cycleNoteAt(clip, step, midi);
    writeData((d) => {
      if (!d.clips) d.clips = {};
      d.clips[String(selectedClip)] = { ...next, steps: next.steps.map((s) => ({ ...s })) };
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
  const LENGTHS = [16, 32, 64, 8];
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
      {#if view === 'session'}
        <!-- 8×8 launch grid: rows = instrument lanes, cols = clip slots -->
        <div class="launch-grid" data-testid="clipplayer-grid" role="grid" aria-label="clip launch grid">
          {#each Array(CLIP_LANES) as _l, lane (lane)}
            <div class="grid-row" role="row" style={`--lane-hue:${laneHue(lane)}`}>
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
                  onclick={() => onPadClick(idx)}
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
        <!-- Deluge-style note editor for the selected clip -->
        <div class="editor" data-testid="clipplayer-editor">
          <div class="editor-head">
            <button class="back" onclick={() => (view = 'session')} title="Back to session" data-testid="clipplayer-back">‹</button>
            <span class="sel">L{editLane + 1}·S{editSlot + 1}</span>
            <button class="tag" onclick={cycleScale} title="Cycle scale">{scaleName(editClip.scale)}</button>
            <span class="tag root">{noteNameForMidi(editClip.root)}</span>
            <button class="tag" onclick={cycleLength} title="Cycle clip length">{editClip.lengthSteps}st</button>
            <span class="oct">
              <button onclick={() => (editorOctave -= 1)} title="Octave down" aria-label="octave down">−</button>
              <button onclick={() => (editorOctave += 1)} title="Octave up" aria-label="octave up">+</button>
            </span>
            <button class="clear" onclick={clearClip} title="Clear clip" data-testid="clipplayer-clear">⌫</button>
          </div>
          <div class="piano-roll" data-testid="clipplayer-pianoroll">
            {#each Array(EDIT_ROWS) as _r, row (row)}
              <div class="pr-row">
                {#each Array(editCols) as _c, step (step)}
                  {@const midi = midiForDisplayRow(editClip, row)}
                  {@const tier = cellTier(editClip, step, midi)}
                  <button
                    class="cell {tier}"
                    class:playhead={step === playheadCol}
                    data-step={step}
                    data-row={row}
                    aria-label={`step ${step} row ${row}`}
                    onclick={() => cycleNote(step, row)}
                  ></button>
                {/each}
              </div>
            {/each}
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
    padding-top: 18px;
    padding-bottom: 14px;
    position: relative;
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
  .body {
    margin-top: 24px;
    padding: 0 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .launch-grid {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .grid-row { display: flex; gap: 3px; }
  .pad {
    flex: 1;
    aspect-ratio: 1;
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
  .piano-roll { display: flex; flex-direction: column; gap: 2px; }
  .pr-row { display: flex; gap: 2px; }
  .cell {
    flex: 1;
    height: 13px;
    border: 1px solid var(--border);
    border-radius: 1px;
    background: #161616;
    cursor: pointer;
    padding: 0;
  }
  .cell.low { background: hsl(200 70% 32%); }
  .cell.med { background: hsl(200 75% 45%); }
  .cell.high { background: hsl(200 85% 60%); }
  .cell.playhead { border-color: var(--accent, #6cf); }
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

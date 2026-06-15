<script lang="ts">
  // CLIP PLAYER card — the standalone (no-grid) face of the clip-launcher.
  // Top: an 8×8 clip-launch grid (Ableton Session-view; click empty = create,
  // click loaded = launch/queue, click playing = stop). Bottom: a Deluge-style
  // note editor for the selected note clip (X = step, Y = pitch, in-key rows).
  // A monome grid drives the SAME actions via lib/grid (Phase 3); this card is
  // the always-available editor + launcher.
  //
  // All ports live in the shared yellow drill-down <PatchPanel> (post-#767 hard
  // standard — NO raw side <Handle> jacks). Port ids are byte-identical to
  // clipplayerDef so the CV bridge + persisted edges route unchanged.
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
    CLIP_TRACKS,
    CLIP_SCENES,
    clipIndex,
    defaultNoteClip,
    coerceClipRecord,
    rowToMidi,
    toggleNoteAt,
    type ClipPlayerData,
    type NoteClipRecord,
  } from '$lib/audio/modules/clip-types';
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

  // Monome grid (Phase 3) — WebSerial connect + bind THIS clip-player to the
  // grid. Capability-gated (Chromium only); the button always renders (so the
  // card chrome is deterministic) but is disabled where WebSerial is absent.
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

  let cardVersion = $state(0);
  $effect(() => {
    const h = () => { cardVersion = cardVersion + 1; };
    ydoc.on('update', h);
    return () => ydoc.off('update', h);
  });

  function pdef(pid: string) {
    return clipplayerDef.params.find((p) => p.id === pid)!;
  }
  let bpm = $derived((void cardVersion, node?.params.bpm ?? pdef('bpm').defaultValue));
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
  let playing = $derived((void cardVersion, dataObj().playing ?? null));
  let queued = $derived((void cardVersion, dataObj().queued ?? null));

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

  function selectedKey(): string {
    return String(selectedClip);
  }
  function clipAt(index: number): NoteClipRecord | null {
    const c = coerceClipRecord(clips[String(index)]);
    return c && c.kind === 'note' ? c : null;
  }

  function clickPad(index: number) {
    selectedClip = index;
    const key = String(index);
    if (!clips[key]) {
      // Empty → create a clip; don't launch (build it first).
      writeData((d) => {
        if (!d.clips) d.clips = {};
        d.clips[key] = defaultNoteClip();
      });
      return;
    }
    // Loaded → launch (or stop if it's the one playing). Quantize applies in the engine.
    if ((dataObj().playing ?? null) === key) writeData((d) => { d.queued = 'stop'; });
    else writeData((d) => { d.queued = key; });
  }

  function stopAll() {
    writeData((d) => { d.queued = 'stop'; });
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

  // Logical row 0 = clip root; the grid shows rows top=high → bottom=low.
  function midiForDisplayRow(clip: NoteClipRecord, displayRow: number): number {
    const scaleLen = clip.scale ? (clip.scale === 'pentatonic' ? 5 : clip.scale === 'minor' ? 7 : 7) : 12;
    const logicalRow = editorOctave * scaleLen + (EDIT_ROWS - 1 - displayRow);
    return rowToMidi(logicalRow, clip.root, clip.scale);
  }
  function noteOn(clip: NoteClipRecord, step: number, midi: number): boolean {
    return clip.steps.some((e) => e.step === step && e.midi === midi);
  }
  function toggleNote(step: number, displayRow: number) {
    const clip = clipAt(selectedClip);
    if (!clip) return;
    const midi = midiForDisplayRow(clip, displayRow);
    const next = toggleNoteAt(clip, step, midi);
    const key = selectedKey();
    writeData((d) => {
      if (!d.clips) d.clips = {};
      d.clips[key] = { ...next, steps: next.steps.map((s) => ({ ...s })) };
    });
  }

  // Playhead column (only while the selected clip is the one playing).
  let currentStep = $state(0);
  $effect(() => {
    let raf = 0;
    const tickFrame = () => {
      const e = engineCtx.get();
      if (e && node) {
        const cs = e.read(node, 'currentStep');
        if (typeof cs === 'number') currentStep = cs;
      }
      raf = requestAnimationFrame(tickFrame);
    };
    raf = requestAnimationFrame(tickFrame);
    return () => cancelAnimationFrame(raf);
  });
  let playheadCol = $derived(playing === selectedKey() ? currentStep : -1);

  function padState(index: number): 'empty' | 'loaded' | 'queued' | 'playing' {
    const key = String(index);
    if (playing === key) return 'playing';
    if (queued === key) return 'queued';
    return clips[key] ? 'loaded' : 'empty';
  }

  const inputs: PortDescriptor[] = [
    { id: 'clock', label: 'CLOCK IN', cable: 'gate' },
    { id: 'stop_all', label: 'STOP ALL', cable: 'gate' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'pitch', label: 'PITCH', cable: 'pitch' },
    { id: 'gate', label: 'GATE', cable: 'gate' },
    { id: 'velocity', label: 'VELOCITY', cable: 'cv' },
    { id: 'clip_gate', label: 'CLIP GATE', cable: 'gate' },
  ];
</script>

<div class="card audio clipplayer-card" data-testid="clipplayer-card">
  <div class="stripe"></div>
  <header class="title">
    <ModuleTitle {id} {data} defaultLabel="CLIP PLAYER" inline />
    <span class="title-btns">
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
      <button class="stop-all" onclick={stopAll} title="Stop all" data-testid={`clipplayer-stopall-${id}`}>■</button>
    </span>
  </header>

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="body">
      <!-- 8×8 launch grid: rows = scenes, cols = tracks -->
      <div class="launch-grid" data-testid="clipplayer-grid" role="grid" aria-label="clip launch grid">
        {#each Array(CLIP_SCENES) as _, scene (scene)}
          <div class="grid-row" role="row">
            {#each Array(CLIP_TRACKS) as _t, track (track)}
              {@const idx = clipIndex(track, scene)}
              {@const st = padState(idx)}
              <button
                class="pad {st}"
                class:selected={selectedClip === idx}
                role="gridcell"
                aria-label={`clip ${idx} ${st}`}
                data-clip={idx}
                data-state={st}
                onclick={() => clickPad(idx)}
              ></button>
            {/each}
          </div>
        {/each}
      </div>

      <!-- Deluge-style note editor for the selected clip -->
      <div class="editor" data-testid="clipplayer-editor">
        <div class="editor-head">
          <span class="sel">CLIP {selectedClip}</span>
          <span class="oct">
            <button onclick={() => (editorOctave -= 1)} title="Octave down" aria-label="octave down">−</button>
            <button onclick={() => (editorOctave += 1)} title="Octave up" aria-label="octave up">+</button>
          </span>
        </div>
        {#if editClip}
          <div class="piano-roll" data-testid="clipplayer-pianoroll">
            {#each Array(EDIT_ROWS) as _r, row (row)}
              <div class="pr-row">
                {#each Array(editCols) as _c, step (step)}
                  {@const midi = midiForDisplayRow(editClip, row)}
                  <button
                    class="cell"
                    class:on={noteOn(editClip, step, midi)}
                    class:playhead={step === playheadCol}
                    data-step={step}
                    data-row={row}
                    aria-label={`step ${step} row ${row}`}
                    onclick={() => toggleNote(step, row)}
                  ></button>
                {/each}
              </div>
            {/each}
          </div>
        {:else}
          <div class="empty-hint">click a pad to create / select a clip</div>
        {/if}
      </div>

      <!-- Transport -->
      <div class="knob-row">
        <Knob value={bpm} min={pdef('bpm').min} max={pdef('bpm').max} defaultValue={pdef('bpm').defaultValue}
          label="BPM" curve="linear" onchange={setParam('bpm')} moduleId={id} paramId="bpm" readLive={readLive('bpm')} />
        <Knob value={octave} min={pdef('octave').min} max={pdef('octave').max} defaultValue={pdef('octave').defaultValue}
          label="OCT" curve="discrete" onchange={setParam('octave')} moduleId={id} paramId="octave" readLive={readLive('octave')} />
        <Knob value={gateLength} min={pdef('gateLength').min} max={pdef('gateLength').max} defaultValue={pdef('gateLength').defaultValue}
          label="GATE" curve="linear" onchange={setParam('gateLength')} moduleId={id} paramId="gateLength" readLive={readLive('gateLength')} />
        <button class="qnt" class:on={quantize} onclick={() => setParam('quantize')(quantize ? 0 : 1)}
          title="Quantize launch to clip boundary" data-testid="clipplayer-quantize">QNT</button>
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .card {
    width: 360px;
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
    background: var(--cable-pitch, var(--cable-audio));
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
  .grid-btn.on {
    color: var(--accent, #6cf);
    border-color: var(--accent, #6cf);
  }
  .grid-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
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
  .grid-row {
    display: flex;
    gap: 3px;
  }
  .pad {
    flex: 1;
    aspect-ratio: 1;
    border: 1px solid var(--border);
    border-radius: 2px;
    background: #1a1a1a;
    cursor: pointer;
    padding: 0;
  }
  .pad.loaded { background: var(--accent-dim, #3a5); }
  .pad.queued { background: var(--accent, #6c9); animation: blink 0.4s steps(2) infinite; }
  .pad.playing { background: var(--accent, #6f9); box-shadow: 0 0 4px var(--accent-glow, #6f9); }
  .pad.selected { outline: 1px solid var(--accent, #6cf); outline-offset: -1px; }
  @keyframes blink { 50% { opacity: 0.35; } }

  .editor {
    border-top: 1px solid var(--border);
    padding-top: 6px;
  }
  .editor-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 10px;
    color: var(--text-dim, #999);
    margin-bottom: 4px;
  }
  .oct button {
    background: var(--control-bg, #222);
    color: var(--text);
    border: 1px solid var(--border);
    width: 18px; height: 16px;
    font-size: 11px; line-height: 1;
    cursor: pointer;
    margin-left: 2px;
  }
  .piano-roll {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .pr-row { display: flex; gap: 2px; }
  .cell {
    flex: 1;
    height: 12px;
    border: 1px solid var(--border);
    border-radius: 1px;
    background: #161616;
    cursor: pointer;
    padding: 0;
  }
  .cell.on { background: var(--accent, #6cf); }
  .cell.playhead { border-color: var(--accent, #6cf); background: #2a2a2a; }
  .cell.on.playhead { background: var(--accent, #9df); }
  .empty-hint { font-size: 10px; color: var(--text-dim, #888); padding: 8px 0; text-align: center; }
  .knob-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    padding-top: 4px;
  }
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

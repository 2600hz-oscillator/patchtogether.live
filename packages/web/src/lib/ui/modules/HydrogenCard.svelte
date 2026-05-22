<script lang="ts">
  // HydrogenCard — 16-instrument × 16-step pattern editor for the
  // TR-808 drum module. First pass UI; full Hydrogen "song mode +
  // mixer popup + drumkit picker" is deferred to follow-ups.
  //
  // Card body layout (top-to-bottom):
  //   1. Transport row: BPM / Swing / Gain knobs + PLAY toggle.
  //   2. Per-instrument grid rows: NAME [M][S] + 16 step cells.
  //      The currently-sounding step is highlighted via a poll on
  //      engine.read('currentStep') — same shape as DRUMSEQZ.
  //
  // Per-instrument vol/pan/A/D/S/R live in the PatchPanel sections so
  // the card itself stays the width of a normal module. The PatchPanel
  // also hosts every trig{i} input + clock_in / reset_in + stereo out.
  import { onDestroy } from 'svelte';
  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch, ydoc } from '$lib/graph/store';
  import {
    defaultTracks,
    coerceTracks,
    STEP_COUNT,
    type HydrogenTrack,
  } from '$lib/audio/modules/hydrogen';
  import { TR808_INSTRUMENTS } from '$lib/audio/modules/hydrogen-tr808-kit-data';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  function pget(key: string, fb: number): number {
    const v = node?.params?.[key];
    return typeof v === 'number' ? v : fb;
  }
  const set = (k: string) => (v: number) => {
    const t = patch.nodes[id];
    if (t) t.params[k] = v;
  };
  const live = (k: string) => () => {
    const e = engineCtx.get();
    if (!e || !node) return undefined;
    return e.readParam(node, k);
  };

  // ---------- pattern data (on node.data.tracks) ----------
  let tracks: HydrogenTrack[] = $derived.by(() => {
    const raw = (node?.data as Record<string, unknown> | undefined)?.tracks;
    return raw ? coerceTracks(raw) : defaultTracks();
  });

  function setCellOn(instIdx: number, stepIdx: number, on: boolean) {
    const t = patch.nodes[id];
    if (!t) return;
    ydoc.transact(() => {
      if (!t.data) t.data = {};
      const d = t.data as Record<string, unknown>;
      const current = coerceTracks(d.tracks);
      const row = current[instIdx] ?? [];
      while (row.length < STEP_COUNT) row.push({ on: false });
      row[stepIdx] = { on };
      current[instIdx] = row;
      d.tracks = current;
    });
  }

  function toggleCell(instIdx: number, stepIdx: number) {
    const row = tracks[instIdx];
    const was = row?.[stepIdx]?.on ?? false;
    setCellOn(instIdx, stepIdx, !was);
  }

  function clearAll() {
    const t = patch.nodes[id];
    if (!t) return;
    ydoc.transact(() => {
      if (!t.data) t.data = {};
      (t.data as Record<string, unknown>).tracks = defaultTracks();
    });
  }

  // ---------- playhead polling (visual highlight) ----------
  let activeStep = $state(-1);
  const POLL_MS = 30;
  let pollId: ReturnType<typeof setInterval> | null = null;
  function poll() {
    const e = engineCtx.get();
    if (!e || !node) return;
    const v = e.read(node, 'currentStep');
    if (typeof v === 'number') activeStep = v;
  }
  pollId = setInterval(poll, POLL_MS);
  onDestroy(() => {
    if (pollId !== null) clearInterval(pollId);
    pollId = null;
  });

  // ---------- transport ----------
  let isPlaying = $derived(pget('isPlaying', 0) >= 0.5);
  function togglePlay() {
    set('isPlaying')(isPlaying ? 0 : 1);
  }

  // ---------- PatchPanel sections — one per instrument + master ----------
  // Each instrument row gets its own section so the user can find the
  // trig + amp-env knobs by name; the section labels mirror the row
  // labels on the card body.
  const sections = [
    {
      label: 'Master',
      inputs: [
        { id: 'clock_in', label: 'CLOCK IN',  cable: 'gate' },
        { id: 'reset_in', label: 'RESET',     cable: 'gate' },
      ] as PortDescriptor[],
      outputs: [
        { id: 'out_l', label: 'OUT L', cable: 'audio' },
        { id: 'out_r', label: 'OUT R', cable: 'audio' },
      ] as PortDescriptor[],
    },
    ...TR808_INSTRUMENTS.map((inst) => ({
      label: inst.name,
      inputs: [{ id: `trig${inst.id}`, label: 'TRIG', cable: 'gate' }] as PortDescriptor[],
    })),
  ];
</script>

<div class="mod-card hydrogen-card" data-testid="hydrogen-card">
  <div class="stripe" style="background: var(--cable-gate);"></div>
  <header class="title">HYDROGEN <span class="kit-name">TR-808</span></header>

  <PatchPanel nodeId={id} {sections} groupingStrategy="sectioned" panelWidth={420}>
    <div class="body">
      <div class="transport-row">
        <button
          type="button"
          class="play-btn"
          class:on={isPlaying}
          onclick={togglePlay}
          data-testid="hydrogen-play"
          aria-pressed={isPlaying}
        >{isPlaying ? '■ STOP' : '▶ PLAY'}</button>
        <Knob value={pget('bpm', 120)}   min={30}  max={300} defaultValue={120} label="BPM" units="bpm" curve="linear" onchange={set('bpm')}   readLive={live('bpm')} />
        <Knob value={pget('swing', 0)}   min={0}   max={0.75} defaultValue={0} label="Sw"   curve="linear" onchange={set('swing')} readLive={live('swing')} />
        <Knob value={pget('gain', 1)}    min={0}   max={2}    defaultValue={1} label="Gain" curve="linear" onchange={set('gain')}  readLive={live('gain')} />
        <button type="button" class="clear-btn" onclick={clearAll} data-testid="hydrogen-clear">CLEAR</button>
      </div>

      <div class="grid">
        {#each TR808_INSTRUMENTS as inst}
          <div class="row" data-instrument-id={inst.id}>
            <div class="inst-name" title={inst.name}>{inst.label}</div>
            <button
              type="button"
              class="ms-btn"
              class:on={pget(`mute${inst.id}`, 0) >= 0.5}
              onclick={() => set(`mute${inst.id}`)(pget(`mute${inst.id}`, 0) >= 0.5 ? 0 : 1)}
              data-testid={`hydrogen-mute-${inst.id}`}
              title="Mute"
            >M</button>
            <button
              type="button"
              class="ms-btn solo"
              class:on={pget(`solo${inst.id}`, 0) >= 0.5}
              onclick={() => set(`solo${inst.id}`)(pget(`solo${inst.id}`, 0) >= 0.5 ? 0 : 1)}
              data-testid={`hydrogen-solo-${inst.id}`}
              title="Solo"
            >S</button>
            <div class="cells">
              {#each Array(STEP_COUNT) as _, s}
                <button
                  type="button"
                  class="cell"
                  class:on={tracks[inst.id]?.[s]?.on ?? false}
                  class:downbeat={s % 4 === 0}
                  class:active={s === activeStep}
                  onclick={() => toggleCell(inst.id, s)}
                  data-testid={`hydrogen-cell-${inst.id}-${s}`}
                  aria-label={`${inst.label} step ${s + 1}`}
                ></button>
              {/each}
            </div>
          </div>
        {/each}
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .mod-card.hydrogen-card {
    background-color: var(--module-bg, #1a1d23);
    border: 1px solid var(--border);
    border-radius: 3px;
    color: var(--text);
    padding: 14px 12px 12px;
    position: relative;
    isolation: isolate;
    min-width: 660px;
  }
  .stripe {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 4px;
    background: var(--cable-gate);
  }
  .title {
    font-weight: 700;
    font-size: 13px;
    letter-spacing: 1px;
    margin-bottom: 8px;
    text-align: center;
  }
  .title .kit-name {
    color: var(--accent, #00f0ff);
    font-weight: 400;
    margin-left: 6px;
    font-size: 11px;
  }

  .body { display: flex; flex-direction: column; gap: 6px; }

  .transport-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px 8px;
    background: var(--module-bg-deep, rgba(0,0,0,0.25));
    border: 1px solid var(--border);
    border-radius: 2px;
  }
  .play-btn, .clear-btn {
    background: var(--module-bg-deep, rgba(0,0,0,0.5));
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 2px;
    padding: 4px 10px;
    font-size: 11px;
    font-weight: 700;
    cursor: pointer;
    min-width: 64px;
  }
  .play-btn.on {
    background: var(--accent, #00f0ff);
    color: var(--module-bg, #1a1d23);
    border-color: var(--accent, #00f0ff);
  }
  .play-btn:hover, .clear-btn:hover { border-color: var(--accent, #00f0ff); }
  .clear-btn { margin-left: auto; }

  .grid {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .row {
    display: grid;
    grid-template-columns: 56px 18px 18px 1fr;
    gap: 4px;
    align-items: center;
  }
  .inst-name {
    font-size: 10px;
    font-weight: 700;
    text-align: right;
    color: var(--text-dim, #b8bcc4);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ms-btn {
    width: 18px;
    height: 18px;
    font-size: 9px;
    font-weight: 700;
    background: var(--module-bg-deep, rgba(0,0,0,0.5));
    color: var(--text-dim, #b8bcc4);
    border: 1px solid var(--border);
    border-radius: 2px;
    padding: 0;
    cursor: pointer;
  }
  .ms-btn.on {
    background: var(--cable-gate, #ffd000);
    color: #000;
    border-color: var(--cable-gate, #ffd000);
  }
  .ms-btn.solo.on {
    background: var(--accent, #00f0ff);
    border-color: var(--accent, #00f0ff);
  }

  .cells {
    display: grid;
    grid-template-columns: repeat(16, 1fr);
    gap: 2px;
  }
  .cell {
    appearance: none;
    aspect-ratio: 1 / 1;
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border);
    border-radius: 1px;
    cursor: pointer;
    padding: 0;
    transition: background 80ms ease-out, border-color 80ms ease-out;
  }
  .cell.downbeat { background: rgba(255,255,255,0.08); }
  .cell.on {
    background: var(--cable-gate, #ffd000);
    border-color: var(--cable-gate, #ffd000);
  }
  .cell.active {
    outline: 1px solid var(--accent, #00f0ff);
    outline-offset: 1px;
  }
  .cell:hover { border-color: var(--accent, #00f0ff); }
</style>

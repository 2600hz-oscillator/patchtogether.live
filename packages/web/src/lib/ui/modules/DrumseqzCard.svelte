<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import NoteEntry from '$lib/ui/controls/NoteEntry.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch, ydoc } from '$lib/graph/store';
  import {
    drumseqzDef,
    defaultTracks,
    coerceTracks,
    coerceCell,
    applyEuclideanToTrack,
    TRACK_COUNT,
    STEP_COUNT,
    type DrumseqzTrack,
  } from '$lib/audio/modules/drumseqz';
  import { useEngine } from '$lib/audio/engine-context';
  import { parseNoteName, noteNameForMidi, C3_MIDI } from '$lib/audio/note-entry';
  import { resolveArrowNav, type ArrowKey } from '$lib/audio/grid-nav';
  import { testHooksEnabled } from '$lib/dev/test-hooks';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  let cardVersion = $state(0);
  $effect(() => {
    const h = () => {
      cardVersion = cardVersion + 1;
    };
    ydoc.on('update', h);
    return () => ydoc.off('update', h);
  });

  let bpm        = $derived((void cardVersion, node?.params.bpm        ?? 120));
  let length     = $derived((void cardVersion, node?.params.length     ?? STEP_COUNT));
  let octave     = $derived((void cardVersion, node?.params.octave     ?? 0));
  let gateLength = $derived((void cardVersion, node?.params.gateLength ?? 0.5));
  let swing      = $derived((void cardVersion, node?.params.swing      ?? 0));
  let isPlaying  = $derived((void cardVersion, (node?.params.isPlaying ?? 0) >= 0.5));

  let tracks = $derived.by<DrumseqzTrack[]>(() => {
    void cardVersion;
    const raw = (node?.data as Record<string, unknown> | undefined)?.tracks;
    return coerceTracks(raw);
  });

  function readTrkParam(t: number, key: 'euclid' | 'root' | 'octave', fallback: number): number {
    void cardVersion;
    const v = node?.params[`trk${t + 1}_${key}`];
    return typeof v === 'number' ? v : fallback;
  }

  const set = (k: string) => (v: number) => {
    const target = patch.nodes[id];
    if (target) target.params[k] = v;
  };

  function togglePlay() {
    set('isPlaying')(isPlaying ? 0 : 1);
  }
  const live = (k: string) => () => {
    const e = engineCtx.get();
    if (!e || !node) return undefined;
    return e.readParam(node, k);
  };

  let currentStep = $state(0);
  let raf: number | null = null;
  $effect(() => {
    function tickFrame() {
      const e = engineCtx.get();
      if (e && node) {
        const cs = e.read(node, 'currentStep');
        if (typeof cs === 'number') currentStep = cs;
      }
      raf = requestAnimationFrame(tickFrame);
    }
    raf = requestAnimationFrame(tickFrame);
    return () => {
      if (raf !== null) cancelAnimationFrame(raf);
      raf = null;
    };
  });
  onDestroy(() => {
    if (raf !== null) cancelAnimationFrame(raf);
  });

  // --- Step + track mutation helpers ---

  function readTracksCopy(): DrumseqzTrack[] {
    const t = patch.nodes[id];
    const raw = (t?.data as Record<string, unknown> | undefined)?.tracks;
    return coerceTracks(raw);
  }

  function writeTracks(arr: DrumseqzTrack[]) {
    const target = patch.nodes[id];
    if (!target) return;
    ydoc.transact(() => {
      if (!target.data) target.data = {};
      (target.data as Record<string, unknown>).tracks = arr.map((tr) =>
        tr.map((c) => ({ on: c.on, midi: c.midi })),
      );
    });
  }

  function toggleGate(t: number, i: number) {
    const arr = readTracksCopy();
    const cur = arr[t]?.[i] ?? { on: false, midi: null };
    arr[t][i] = { on: !cur.on, midi: cur.midi };
    writeTracks(arr);
  }

  function commitPitch(t: number, i: number, input: string) {
    const arr = readTracksCopy();
    const cur = arr[t]?.[i] ?? { on: false, midi: null };
    const trimmed = input.trim();
    const parsed = trimmed === '' ? null : parseNoteName(trimmed);
    arr[t][i] = { on: cur.on, midi: parsed };
    writeTracks(arr);
  }

  /** Eucl slider rewrite: replaces the track's `on` flags with the Bjorklund
   *  pattern for the new k. Single transact for the whole track. */
  function applyEuclidean(t: number, k: number) {
    set(`trk${t + 1}_euclid`)(k);
    const arr = readTracksCopy();
    arr[t] = applyEuclideanToTrack(arr[t] ?? [], k);
    writeTracks(arr);
  }

  // --- Keyboard navigation ---

  let gridEl: HTMLElement | undefined = $state();

  const NAV_SPEC = { cols: STEP_COUNT, cellRows: TRACK_COUNT };

  function findCell(track: number, step: number, role: 'pitch' | 'gate'): HTMLElement | null {
    if (!gridEl) return null;
    return gridEl.querySelector<HTMLElement>(
      `[data-track="${track}"][data-step="${step}"] [data-role="${role}"]`,
    );
  }

  function focusCell(track: number, step: number, role: 'pitch' | 'gate'): boolean {
    const target = findCell(track, step, role);
    if (!target) return false;
    target.focus();
    if (target.tagName === 'INPUT') (target as HTMLInputElement).select();
    return true;
  }

  function handleNav(
    e: KeyboardEvent,
    track: number,
    step: number,
    role: 'pitch' | 'gate',
  ): boolean {
    const cellIdx = track * STEP_COUNT + step;
    if (
      e.key === 'ArrowLeft' || e.key === 'ArrowRight' ||
      e.key === 'ArrowUp'   || e.key === 'ArrowDown'
    ) {
      const next = resolveArrowNav({ index: cellIdx, role }, e.key as ArrowKey, NAV_SPEC);
      if (!next) return false;
      const nT = Math.floor(next.index / STEP_COUNT);
      const nS = next.index % STEP_COUNT;
      return focusCell(nT, nS, next.role);
    }
    if (e.key === 'Enter' && role === 'pitch') {
      tick().then(() => focusCell(track, Math.min(STEP_COUNT - 1, step + 1), 'pitch'));
      return true;
    }
    if (e.key === 'Tab') {
      const dir = e.shiftKey ? -1 : 1;
      const nextStep = step + dir;
      if (nextStep < 0 || nextStep > STEP_COUNT - 1) return false;
      return focusCell(track, nextStep, role);
    }
    return false;
  }

  // --- Test hooks (gated on testHooksEnabled) ---

  $effect(() => {
    if (!testHooksEnabled() || typeof window === 'undefined') return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    w.__drumseqzCellAt = (nodeId: string, track: number, step: number) => {
      const target = patch.nodes[nodeId];
      const raw = (target?.data as Record<string, unknown> | undefined)?.tracks;
      const all = coerceTracks(raw);
      return all[track]?.[step] ?? null;
    };
    w.__drumseqzSetCell = (
      nodeId: string,
      track: number,
      step: number,
      cell: { on?: boolean; midi?: number | null },
    ) => {
      const target = patch.nodes[nodeId];
      if (!target) return false;
      const raw = (target.data as Record<string, unknown> | undefined)?.tracks;
      const arr = coerceTracks(raw);
      const cur = arr[track]?.[step] ?? { on: false, midi: null };
      const next = coerceCell({
        on: cell.on ?? cur.on,
        midi: 'midi' in cell ? cell.midi : cur.midi,
      });
      arr[track][step] = next;
      ydoc.transact(() => {
        if (!target.data) target.data = {};
        (target.data as Record<string, unknown>).tracks = arr.map((tr) =>
          tr.map((c) => ({ on: c.on, midi: c.midi })),
        );
      });
      return true;
    };
  });

  const inputs: PortDescriptor[] = [
    { id: 'clock', label: 'CLOCK IN', cable: 'gate' },
  ];
  const outputs: PortDescriptor[] = [
    ...Array.from({ length: TRACK_COUNT }, (_, t) => ({
      id: `gate${t + 1}`,
      label: `TRACK ${t + 1} GATE`,
      cable: 'gate' as const,
    })),
    ...Array.from({ length: TRACK_COUNT }, (_, t) => ({
      id: `pitch${t + 1}`,
      label: `TRACK ${t + 1} PITCH`,
      cable: 'pitch' as const,
    })),
    { id: 'clock', label: 'CLOCK OUT', cable: 'gate' as const },
  ];
</script>

<div class="mod-card drumseqz-card">
  <div class="stripe" style="background: var(--cable-gate);"></div>
  <header class="title">
    DRUMSEQZ
    <button
      class="play-btn"
      class:playing={isPlaying}
      onclick={togglePlay}
      title={isPlaying ? 'Stop' : 'Play'}
      data-testid={`drumseqz-play-${id}`}
    >
      {isPlaying ? '■' : '▶'}
    </button>
  </header>

  <PatchPanel nodeId={id} {inputs} {outputs}>
  <div class="grid-area">
    <div class="grid" bind:this={gridEl} data-testid={`drumseqz-grid-${id}`}>
      {#each Array.from({ length: TRACK_COUNT }, (_, t) => t) as t (t)}
        <div class="track-label">T{t + 1}</div>
        {#each Array.from({ length: STEP_COUNT }, (_, i) => i) as i (i)}
          <div class="cell-slot" data-track={t} data-step={i}>
            <NoteEntry
              midi={tracks[t]?.[i]?.midi ?? null}
              on={tracks[t]?.[i]?.on ?? false}
              isActive={i === currentStep && isPlaying}
              dim={i >= length}
              testId={`drumseqz-pitch-${id}-${t}-${i}`}
              gateTestId={`drumseqz-gate-${id}-${t}-${i}`}
              onCommit={(input) => commitPitch(t, i, input)}
              onGateToggle={() => toggleGate(t, i)}
              onNavKey={(e) => {
                const role = (e.target as HTMLElement)?.dataset?.role === 'gate' ? 'gate' : 'pitch';
                return handleNav(e, t, i, role as 'pitch' | 'gate');
              }}
            />
          </div>
        {/each}
        <div class="track-knobs">
          <Fader
            value={readTrkParam(t, 'euclid', 0)}
            min={0}
            max={STEP_COUNT}
            defaultValue={0}
            label={`E${t + 1}`}
            curve="discrete"
            onchange={(v) => applyEuclidean(t, Math.round(v))}
          />
          <input
            class="root-input"
            type="text"
            spellcheck="false"
            autocomplete="off"
            value={noteNameForMidi(readTrkParam(t, 'root', C3_MIDI))}
            data-testid={`drumseqz-root-${id}-${t}`}
            title="Track root note"
            onchange={(e) => {
              const text = (e.currentTarget as HTMLInputElement).value.trim();
              const parsed = parseNoteName(text);
              if (parsed !== null) set(`trk${t + 1}_root`)(parsed);
            }}
          />
          <Fader
            value={readTrkParam(t, 'octave', 0)}
            min={-2}
            max={2}
            defaultValue={0}
            label={`O${t + 1}`}
            curve="discrete"
            onchange={set(`trk${t + 1}_octave`)}
          />
        </div>
      {/each}
    </div>
  </div>

  <div class="fader-row">
    <Fader value={bpm}        min={30}  max={300}  defaultValue={120} label="BPM"  curve="linear"   onchange={set('bpm')}        readLive={live('bpm')} />
    <Fader value={length}     min={1}   max={STEP_COUNT}  defaultValue={STEP_COUNT}  label="Len"  curve="discrete" onchange={set('length')}     readLive={live('length')} />
    <Fader value={octave}     min={-2}  max={2}    defaultValue={0}   label="Oct"  curve="discrete" onchange={set('octave')}     readLive={live('octave')} />
    <Fader value={gateLength} min={0.1} max={0.95} defaultValue={0.5} label="Gate" curve="linear"   onchange={set('gateLength')} readLive={live('gateLength')} />
    <Fader value={swing}      min={0}   max={0.75} defaultValue={0}   label="Sw"   curve="linear"   onchange={set('swing')}      readLive={live('swing')} />
  </div>
  </PatchPanel>
</div>

<style>
  .drumseqz-card {
    width: 820px;
    min-height: 360px;
    padding-right: 0;
    padding-left: 0;
  }
  .drumseqz-card > .title {
    padding-right: 22px;
    padding-left: 22px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }
  .play-btn {
    width: 22px;
    height: 22px;
    background: #2a2f3a;
    border: 1px solid #404652;
    color: var(--text);
    border-radius: 3px;
    font-size: 0.7rem;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
    padding: 0;
  }
  .play-btn.playing {
    background: var(--cable-gate);
    color: #1a1d23;
    border-color: var(--cable-gate);
  }
  .grid-area {
    margin: 18px 22px 8px;
  }
  .grid {
    display: grid;
    grid-template-columns: 28px repeat(16, 1fr) 110px;
    gap: 3px;
    align-items: stretch;
  }
  .track-label {
    font-size: 0.6rem;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
    text-align: center;
    align-self: center;
  }
  .cell-slot {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    min-width: 0;
  }
  .track-knobs {
    display: flex;
    flex-direction: row;
    gap: 4px;
    align-items: stretch;
    padding-left: 4px;
  }
  .root-input {
    width: 36px;
    background: #14171c;
    border: 1px solid #2a2f3a;
    border-radius: 2px;
    color: var(--text);
    font-family: ui-monospace, monospace;
    font-size: 0.65rem;
    text-align: center;
    align-self: center;
    padding: 2px 0;
    height: 18px;
    outline: none;
  }
  .root-input:focus-visible {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--accent);
  }
  .fader-row {
    margin-top: 6px;
    padding: 0 22px;
    gap: 8px;
  }
</style>

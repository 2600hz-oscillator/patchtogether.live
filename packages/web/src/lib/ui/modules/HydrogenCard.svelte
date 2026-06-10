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
  import MidiAssignButton from '$lib/ui/controls/MidiAssignButton.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import QuicksaveControls from '$lib/ui/QuicksaveControls.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch, ydoc } from '$lib/graph/store';
  import { setNodeParam } from '$lib/graph/mutate';
  import {
    defaultTracks,
    coerceTracks,
    STEP_COUNT,
    PER_VOICE_CV_SLOTS,
    perVoiceCvPortId,
    type HydrogenTrack,
  } from '$lib/audio/modules/hydrogen';
  import { KITS, KIT_COUNT, DEFAULT_KIT_INDEX, kitByIndex } from '$lib/audio/modules/hydrogen-kit-registry';
  import {
    readSlots,
    readPendingMode,
    readQueuedSlot,
    readLastLoadedSlot,
    setPendingMode,
    setQueuedSlot,
    handleSlotClick,
    type TransportCardDeps,
  } from '$lib/audio/modules/transport-card';
  import {
    type PendingMode,
    type SlotKey,
    type Snapshot,
  } from '$lib/audio/modules/transport-helpers';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  function pget(key: string, fb: number): number {
    const v = node?.params?.[key];
    return typeof v === 'number' ? v : fb;
  }
  const set = (k: string) => (v: number) => setNodeParam(id, k, v);
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

  // ---------- preset slots (quicksave) ----------
  // Sequencer-style 4-slot quicksave + play_cv / reset_cv /
  // queue1..4_cv CV inputs. Snapshot stores the PATTERN (tracks) +
  // transport-level knobs (bpm/swing/gain). Per-instrument tuning
  // (vol/pan/pitch/cutoff/Q/A/D/S/R/mute/solo) stays across slot
  // swaps so the user dials in their kit once and only the pattern
  // + tempo flip.
  let cardVersion = $state(0);
  $effect(() => {
    const h = () => { cardVersion = cardVersion + 1; };
    ydoc.on('update', h);
    return () => ydoc.off('update', h);
  });
  let slotsState     = $derived((void cardVersion, readSlots(node)));
  let pendingMode    = $derived<PendingMode>((void cardVersion, readPendingMode(node)));
  let queuedSlot     = $derived<SlotKey | null>((void cardVersion, readQueuedSlot(node)));
  let lastLoadedSlot = $derived<SlotKey | null>((void cardVersion, readLastLoadedSlot(node)));

  const transportDeps: TransportCardDeps = {
    nodeId: id,
    patch,
    transact: (fn) => ydoc.transact(fn),
    snapshot: (): Snapshot => {
      const t = patch.nodes[id];
      if (!t) return {};
      const data = (t.data as Record<string, unknown> | undefined) ?? {};
      const tracksRaw = coerceTracks(data.tracks);
      // Deep-clone tracks so the snapshot is independent of any
      // future Yjs mutations to the live tracks.
      const tracksClone = tracksRaw.map((tr) => tr.map((c) => ({ ...c })));
      return {
        tracks: tracksClone,
        bpm:   t.params.bpm   ?? 120,
        swing: t.params.swing ?? 0,
        gain:  t.params.gain  ?? 1,
      };
    },
    applySnapshot: (snap: Snapshot) => {
      const t = patch.nodes[id];
      if (!t) return;
      ydoc.transact(() => {
        if (!t.data) t.data = {};
        const td = t.data as Record<string, unknown>;
        if (Array.isArray(snap.tracks)) {
          td.tracks = (snap.tracks as Array<Array<Record<string, unknown>>>).map((tr) =>
            (Array.isArray(tr) ? tr : []).map((c) => ({ ...c })),
          );
        }
        for (const k of ['bpm', 'swing', 'gain'] as const) {
          const v = snap[k];
          if (typeof v === 'number') t.params[k] = v; // guard:allow-raw-write
        }
      });
    },
  };

  function onSetMode(m: PendingMode) { setPendingMode(transportDeps, m); }
  function onSlotClick(k: SlotKey) { handleSlotClick(transportDeps, k); }
  function onPlayToggle() { togglePlay(); }
  function onReset() {
    // Same "reset playhead + clear any pending queue" pattern SCORE
    // uses. Re-toggle play so the next step is step-0 if the user
    // was playing — the engine tick resets stepIndex when
    // shouldRun transitions false → true.
    const wasPlaying = isPlaying;
    setQueuedSlot(transportDeps, null);
    set('isPlaying')(0);
    if (wasPlaying) requestAnimationFrame(() => set('isPlaying')(1));
  }

  // ---------- per-instrument expansion ----------
  // Clicking an instrument name expands an inline knob row beneath it
  // exposing the 9 per-voice controls (vol / pan / pitch / cutoff /
  // Q / A / D / S / R). One expanded at a time — keeps the card
  // height bounded.
  let expandedInst = $state<number | null>(null);
  function toggleInst(id: number) {
    expandedInst = expandedInst === id ? null : id;
  }

  // ---------- kit selector ----------
  // `kit` param indexes into the KITS registry. Per-instrument
  // tuning (vol/pan/pitch/etc) persists across kit swaps — same
  // posture as a hardware drum machine, where "Channel 5 Volume"
  // doesn't reset when you load a new kit.
  let kitIndex = $derived(Math.max(0, Math.min(KIT_COUNT - 1, Math.round(pget('kit', DEFAULT_KIT_INDEX)))));
  let activeKit = $derived(kitByIndex(kitIndex));
  function cycleKit() {
    set('kit')((kitIndex + 1) % KIT_COUNT);
    // Auto-collapse any expanded inst — different kit can have
    // different per-slot label semantics; user can re-expand if
    // they want the new voice's knobs.
    expandedInst = null;
  }

  // ---------- PatchPanel sections — one per instrument + master ----------
  // Each instrument row gets its own section so the user can find the
  // trig + amp-env knobs by name; the section labels mirror the row
  // labels on the card body. The per-instrument section label changes
  // when the user swaps kits.
  let sections = $derived([
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
    {
      label: 'Transport CV',
      inputs: [
        { id: 'play_cv',   label: 'PLAY',   cable: 'gate' },
        { id: 'reset_cv',  label: 'RESET',  cable: 'gate' },
        { id: 'queue1_cv', label: 'Q1',     cable: 'gate' },
        { id: 'queue2_cv', label: 'Q2',     cable: 'gate' },
        { id: 'queue3_cv', label: 'Q3',     cable: 'gate' },
        { id: 'queue4_cv', label: 'Q4',     cable: 'gate' },
      ] as PortDescriptor[],
    },
    ...activeKit.instruments.map((inst) => ({
      label: inst.name,
      // Each instrument section now hosts its TRIG gate + the 9 per-voice
      // CV inputs (Vol/Pan/Pi/Cf/Q/A/D/S/R). PatchPanel renders these
      // collapsed by default and fans them out on click — same pattern
      // MIXMSTRS uses for its 49-input matrix. With 16 instruments x
      // 10 inputs each (1 trig + 9 CV), keeping everything in the
      // sectioned popover is the only layout that doesn't make the
      // card itself absurdly tall.
      inputs: [
        { id: `trig${inst.id}`, label: 'TRIG', cable: 'gate' },
        ...PER_VOICE_CV_SLOTS.map((slot) => ({
          id: perVoiceCvPortId(slot.short, inst.id),
          label: `CV ${slot.short.toUpperCase()}`,
          cable: 'cv',
        })),
      ] as PortDescriptor[],
    })),
  ]);
</script>

<div class="mod-card hydrogen-card" data-testid="hydrogen-card">
  <div class="stripe" style="background: var(--cable-gate);"></div>
  <header class="title">
    <ModuleTitle {id} {data} defaultLabel="HYDROGEN" inline />
    <button
      type="button"
      class="kit-btn"
      onclick={cycleKit}
      data-testid="hydrogen-kit-toggle"
      title={`Kit: ${activeKit.name} — click to cycle (${KITS.map((k) => k.name).join(' / ')})`}
      aria-label={`Kit: ${activeKit.name}. Click to cycle to the next kit.`}
    >{activeKit.name}</button>
  </header>

  <PatchPanel nodeId={id} {sections} groupingStrategy="sectioned" panelWidth={420}>
    <div class="body">
      <div class="transport-row">
        <MidiAssignButton moduleId={id} paramId="play" label="PLAY" momentary={false} onToggle={togglePlay}>
          <button
            type="button"
            class="play-btn"
            class:on={isPlaying}
            onclick={togglePlay}
            data-testid="hydrogen-play"
            aria-pressed={isPlaying}
          >{isPlaying ? '■ STOP' : '▶ PLAY'}</button>
        </MidiAssignButton>
        <Knob value={pget('bpm', 120)}   min={30}  max={300} defaultValue={120} label="BPM" units="bpm" curve="linear" onchange={set('bpm')} moduleId={id} paramId="bpm"   readLive={live('bpm')} />
        <Knob value={pget('swing', 0)}   min={0}   max={0.75} defaultValue={0} label="Sw"   curve="linear" onchange={set('swing')} moduleId={id} paramId="swing" readLive={live('swing')} />
        <Knob value={pget('gain', 1)}    min={0}   max={2}    defaultValue={1} label="Gain" curve="linear" onchange={set('gain')} moduleId={id} paramId="gain"  readLive={live('gain')} />
        <MidiAssignButton moduleId={id} paramId="clear" label="CLEAR" momentary={false} onToggle={clearAll}>
          <button type="button" class="clear-btn" onclick={clearAll} data-testid="hydrogen-clear">CLEAR</button>
        </MidiAssignButton>
      </div>

      <!-- Preset slots — SAVE / LOAD / QUEUE mode toggles + 4 slot buttons
           + PLAY (mirrors the existing PLAY in the transport row) + RESET.
           Mirrors the same shape SCORE / DRUMSEQZ / POLYSEQZ ship; the
           audio engine drains play_cv / reset_cv / queue{N}_cv each tick
           and applies the queued slot at the next pattern wrap. -->
      <QuicksaveControls
        nodeId={id}
        slots={slotsState}
        {pendingMode}
        {queuedSlot}
        {lastLoadedSlot}
        {isPlaying}
        {onSetMode}
        {onSlotClick}
        {onPlayToggle}
        {onReset}
      />

      <div class="grid">
        {#each activeKit.instruments as inst}
          <div class="row" data-instrument-id={inst.id}>
            <button
              type="button"
              class="inst-name"
              class:expanded={expandedInst === inst.id}
              onclick={() => toggleInst(inst.id)}
              title={`${inst.name} — click to ${expandedInst === inst.id ? 'collapse' : 'expand'} per-voice controls`}
              data-testid={`hydrogen-inst-toggle-${inst.id}`}
              aria-expanded={expandedInst === inst.id}
            >{inst.label}</button>
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
          {#if expandedInst === inst.id}
            <!-- Per-voice knob strip — matches Hydrogen's
                 "Instrument Properties" panel. The first row's knobs
                 (vol/pan/pitch/cutoff/Q) shape the SOUND; the second
                 row's (A/D/S/R) shapes the per-trigger envelope. -->
            <div class="voice-controls" data-testid={`hydrogen-voice-controls-${inst.id}`}>
              <Knob value={pget(`vol${inst.id}`,    inst.defaultGain)} min={0}     max={2}     defaultValue={inst.defaultGain} label="Vol"  curve="linear" onchange={set(`vol${inst.id}`)} moduleId={id} paramId={`vol${inst.id}`}    readLive={live(`vol${inst.id}`)} />
              <Knob value={pget(`pan${inst.id}`,    inst.defaultPan)}  min={-1}    max={1}     defaultValue={inst.defaultPan}  label="Pan"  curve="linear" onchange={set(`pan${inst.id}`)} moduleId={id} paramId={`pan${inst.id}`}    readLive={live(`pan${inst.id}`)} />
              <Knob value={pget(`pitch${inst.id}`,  0)}                min={-24}   max={24}    defaultValue={0}                label="Pi"   units="st" curve="linear" onchange={set(`pitch${inst.id}`)} moduleId={id} paramId={`pitch${inst.id}`} readLive={live(`pitch${inst.id}`)} />
              <Knob value={pget(`cutoff${inst.id}`, 20000)}            min={20}    max={20000} defaultValue={20000}            label="Cf"   units="Hz" curve="log"    onchange={set(`cutoff${inst.id}`)} moduleId={id} paramId={`cutoff${inst.id}`} readLive={live(`cutoff${inst.id}`)} />
              <Knob value={pget(`q${inst.id}`,      0.7)}              min={0.1}   max={20}    defaultValue={0.7}              label="Q"    curve="log" onchange={set(`q${inst.id}`)} moduleId={id} paramId={`q${inst.id}`}      readLive={live(`q${inst.id}`)} />
              <Knob value={pget(`A${inst.id}`,      inst.defaultA)}    min={0}     max={2}     defaultValue={inst.defaultA}    label="A"    units="s" curve="log" onchange={set(`A${inst.id}`)} moduleId={id} paramId={`A${inst.id}`}      readLive={live(`A${inst.id}`)} />
              <Knob value={pget(`D${inst.id}`,      inst.defaultD)}    min={0}     max={2}     defaultValue={inst.defaultD}    label="D"    units="s" curve="log" onchange={set(`D${inst.id}`)} moduleId={id} paramId={`D${inst.id}`}      readLive={live(`D${inst.id}`)} />
              <Knob value={pget(`S${inst.id}`,      inst.defaultS)}    min={0}     max={1}     defaultValue={inst.defaultS}    label="S"    curve="linear" onchange={set(`S${inst.id}`)} moduleId={id} paramId={`S${inst.id}`}      readLive={live(`S${inst.id}`)} />
              <Knob value={pget(`R${inst.id}`,      inst.defaultR)}    min={0.01}  max={5}     defaultValue={inst.defaultR}    label="R"    units="s" curve="log" onchange={set(`R${inst.id}`)} moduleId={id} paramId={`R${inst.id}`}      readLive={live(`R${inst.id}`)} />
            </div>
          {/if}
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
  .title .kit-btn {
    appearance: none;
    background: transparent;
    border: 1px solid var(--accent, #00f0ff);
    color: var(--accent, #00f0ff);
    font-family: inherit;
    font-weight: 600;
    font-size: 10px;
    letter-spacing: 0.5px;
    padding: 1px 6px;
    margin-left: 6px;
    border-radius: 2px;
    cursor: pointer;
    transition: background 80ms ease-out, color 80ms ease-out;
  }
  .title .kit-btn:hover {
    background: var(--accent, #00f0ff);
    color: var(--module-bg, #1a1d23);
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
    /* Click-to-expand: the instrument-name cell is now a button.
       Keeps the same visual treatment + adds a subtle accent when
       the per-voice strip below is expanded. */
    appearance: none;
    border: none;
    background: transparent;
    font-size: 10px;
    font-weight: 700;
    text-align: right;
    color: var(--text-dim, #b8bcc4);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: pointer;
    padding: 0;
    border-radius: 2px;
    transition: color 80ms ease-out, background 80ms ease-out;
  }
  .inst-name:hover {
    color: var(--text, #e6e8ec);
  }
  .inst-name.expanded {
    color: var(--accent, #00f0ff);
  }

  .voice-controls {
    grid-column: 1 / -1;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding: 6px 8px;
    margin: 2px 0 4px;
    background: var(--module-bg-deep, rgba(0,0,0,0.25));
    border: 1px solid var(--border);
    border-radius: 2px;
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

<script lang="ts">
  // MidiLaneCard — UI for the MIDI LANE per-channel instrument-demux module.
  //
  // A MIDI LANE turns ONE instrument's MIDI channel(s) into the CV/gate the
  // rack speaks: pitch / gate / velocity + two learn-assignable CC taps + a
  // by-note-number drum gate, with an optional poly output. Drop one per
  // instrument (multi-timbral = drop several, like multiple MIDI-CV-BUDDYs
  // but channel-aware and richer).
  //
  // Like MIDI-CV-BUDDY, the card owns the user-visible MIDI controls and
  // does NOT request Web MIDI on mount — the user clicks "Connect MIDI…"
  // once per origin. Connection/device state lives on the engine handle
  // (read via engine.read(node, 'state')); discrete settings (channel set,
  // priority, retrig, mode, CC#s, note#) persist in node.data (Yjs-synced).

  import { onDestroy } from 'svelte';
  import type { NodeProps } from '@xyflow/svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import type {
    MidiLaneApi,
    MidiLaneCardState,
    MidiLaneData,
    LaneMode,
  } from '$lib/audio/modules/midi-lane';
  import type { VoicePriority } from '$lib/audio/modules/midi-cv-buddy';
  import { noteNameForMidi } from '$lib/audio/note-entry';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  let cardState = $state<MidiLaneCardState>({
    connected: false,
    permissionDenied: false,
    devices: [],
    selectedDeviceId: null,
    lastNote: null,
    lastVelocity: 0,
    lastCcA: null,
    lastCcB: null,
    ccANum: null,
    ccBNum: null,
    learningCcA: false,
    learningCcB: false,
  });

  let savedData = $derived(((node?.data ?? {}) as Partial<MidiLaneData>));
  let channels = $derived<number[] | null>(savedData.channels ?? null);
  let priority = $derived<VoicePriority>(savedData.priority ?? 'last');
  let retrig = $derived<boolean>(savedData.retrig ?? true);
  let mode = $derived<LaneMode>(savedData.mode ?? 'mono');
  let ccA = $derived<number | null>(savedData.ccA ?? 1);
  let ccB = $derived<number | null>(savedData.ccB ?? null);
  let noteGateNote = $derived<number>(savedData.noteGateNote ?? 36);

  function getApi(): MidiLaneApi | null {
    const e = engineCtx.get();
    if (!e || !node) return null;
    return (e.read(node, 'card-api') as MidiLaneApi | undefined) ?? null;
  }

  // Becomes true after the engine pushes its first state snapshot. The
  // CC-persistence effect below waits for this so it doesn't clobber a
  // saved ccA/ccB with the initial (empty) card state before the engine —
  // which holds the authoritative value loaded from node.data — reports in.
  let engineStateLoaded = $state(false);

  let unsubscribe: (() => void) | null = null;
  $effect(() => {
    const _ = id;
    const api = getApi();
    if (!api) return;
    unsubscribe?.();
    unsubscribe = api.subscribe((s) => { cardState = s; engineStateLoaded = true; });
    return () => {
      unsubscribe?.();
      unsubscribe = null;
    };
  });
  onDestroy(() => { unsubscribe?.(); });

  async function onClickConnect(): Promise<void> {
    await getApi()?.connect();
  }

  function writeData(patch_: Partial<MidiLaneData>): void {
    const target = patch.nodes[id];
    if (!target) return;
    if (!target.data) target.data = {};
    for (const [k, v] of Object.entries(patch_)) {
      if (v === undefined) delete target.data[k];
      else (target.data as Record<string, unknown>)[k] = v as unknown;
    }
  }

  function onChangeDevice(ev: Event): void {
    const sel = (ev.currentTarget as HTMLSelectElement).value || null;
    getApi()?.selectDevice(sel);
    writeData({ lastDeviceId: sel });
  }

  // Channel selector: a single-select dropdown of ALL / 1..16 for the
  // common "one channel = one instrument" case. (The engine supports a
  // multi-channel Set; v1 of the card surfaces the single-channel +
  // ALL choices, which covers the DAW-style workflow. Multi-select can be
  // layered on later without an engine change.)
  function onChangeChannel(ev: Event): void {
    const raw = (ev.currentTarget as HTMLSelectElement).value;
    const next: number[] | null = raw === 'all' ? null : [Number.parseInt(raw, 10)];
    getApi()?.setChannels(next);
    writeData({ channels: next });
  }

  function onChangePriority(ev: Event): void {
    const p = (ev.currentTarget as HTMLSelectElement).value as VoicePriority;
    getApi()?.setPriority(p);
    writeData({ priority: p });
  }

  function onToggleRetrig(ev: Event): void {
    const v = (ev.currentTarget as HTMLInputElement).checked;
    getApi()?.setRetrig(v);
    writeData({ retrig: v });
  }

  function onChangeMode(ev: Event): void {
    const m = (ev.currentTarget as HTMLSelectElement).value as LaneMode;
    getApi()?.setMode(m);
    writeData({ mode: m });
  }

  function onChangeNoteGate(ev: Event): void {
    const n = Number.parseInt((ev.currentTarget as HTMLInputElement).value, 10);
    if (!Number.isFinite(n)) return;
    getApi()?.setNoteGateNote(n);
    writeData({ noteGateNote: n });
  }

  function onLearnCcA(): void { getApi()?.learnCcA(); }
  function onLearnCcB(): void { getApi()?.learnCcB(); }
  function onClearCcA(): void { getApi()?.setCcA(null); writeData({ ccA: null }); }
  function onClearCcB(): void { getApi()?.setCcB(null); writeData({ ccB: null }); }

  // Persist a learned CC# back to node.data. The engine holds the
  // authoritative assignment (ccANum / ccBNum on the card state); when it
  // diverges from what's saved in node.data — which happens the moment a
  // LEARN captures a wiggled CC — we mirror it so a reload restores the
  // binding. Only writes when the values actually differ (no churn).
  $effect(() => {
    if (engineStateLoaded && cardState.ccANum !== ccA) writeData({ ccA: cardState.ccANum });
  });
  $effect(() => {
    if (engineStateLoaded && cardState.ccBNum !== ccB) writeData({ ccB: cardState.ccBNum });
  });

  const inputs: PortDescriptor[] = [];
  // All declared ports always render a handle (the def is static, and the
  // I/O-consistency sweep requires def ↔ card parity). The `poly` port only
  // carries signal in mode='poly' (neutral otherwise), but its handle is
  // always wireable — same convention as DX7's always-present POLY port.
  const outputs: PortDescriptor[] = [
    { id: 'pitch_cv',    label: 'PITCH', cable: 'cv' },
    { id: 'gate',        label: 'GATE',  cable: 'gate' },
    { id: 'velocity_cv', label: 'VEL',   cable: 'cv' },
    { id: 'cc_a',        label: 'CC A',  cable: 'cv' },
    { id: 'cc_b',        label: 'CC B',  cable: 'cv' },
    { id: 'note_gate',   label: 'NOTE',  cable: 'gate' },
    { id: 'poly',        label: 'POLY',  cable: 'polyPitchGate' },
  ];

  let activeNoteLabel = $derived(
    cardState.lastNote === null ? '—' : noteNameForMidi(cardState.lastNote).toUpperCase(),
  );
  let channelLabel = $derived(
    channels === null ? 'all' : channels.length === 1 ? String(channels[0]) : 'all',
  );
</script>

<div class="mod-card midi-lane-card">
  <div class="stripe" style="background: var(--cable-cv);"></div>
  <ModuleTitle {id} {data} defaultLabel="MIDI LANE" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="body">
      {#if !cardState.connected}
        <button class="connect-btn" type="button" onclick={onClickConnect}>
          Connect MIDI…
        </button>
        {#if cardState.permissionDenied}
          <div class="hint err">Permission denied or browser unsupported.</div>
        {:else}
          <div class="hint">Class-compliant USB-MIDI (Reliq / Programm / ZOIA) appears here. One-time grant per origin.</div>
        {/if}
      {:else}
        <label class="row">
          <span class="lbl">DEVICE</span>
          <select onchange={onChangeDevice} value={cardState.selectedDeviceId ?? ''}>
            <option value="" disabled>(pick one)</option>
            {#each cardState.devices as d (d.id)}
              <option value={d.id}>{d.name}</option>
            {/each}
          </select>
        </label>

        <label class="row">
          <span class="lbl">CH</span>
          <select onchange={onChangeChannel} value={channelLabel}>
            <option value="all">ALL</option>
            {#each Array(16) as _, i (i)}
              <option value={String(i)}>{i + 1}</option>
            {/each}
          </select>
        </label>

        <label class="row">
          <span class="lbl">MODE</span>
          <select onchange={onChangeMode} value={mode}>
            <option value="mono">MONO</option>
            <option value="poly">POLY</option>
          </select>
        </label>

        {#if mode === 'mono'}
          <label class="row">
            <span class="lbl">PRIO</span>
            <select onchange={onChangePriority} value={priority}>
              <option value="last">LAST</option>
              <option value="low">LOW</option>
              <option value="high">HIGH</option>
            </select>
          </label>

          <label class="row retrig">
            <input type="checkbox" checked={retrig} onchange={onToggleRetrig} />
            <span>RETRIG</span>
          </label>
        {/if}

        <div class="cc-row">
          <span class="lbl">CC A</span>
          <span class="cc-val">{ccA === null ? '—' : ccA}</span>
          <button class="mini" class:learning={cardState.learningCcA} type="button" onclick={onLearnCcA}>
            {cardState.learningCcA ? 'WIGGLE…' : 'LEARN'}
          </button>
          <button class="mini" type="button" onclick={onClearCcA}>✕</button>
        </div>
        <div class="cc-row">
          <span class="lbl">CC B</span>
          <span class="cc-val">{ccB === null ? '—' : ccB}</span>
          <button class="mini" class:learning={cardState.learningCcB} type="button" onclick={onLearnCcB}>
            {cardState.learningCcB ? 'WIGGLE…' : 'LEARN'}
          </button>
          <button class="mini" type="button" onclick={onClearCcB}>✕</button>
        </div>

        <label class="row">
          <span class="lbl">NOTE#</span>
          <input
            class="note-num"
            type="number"
            min="0"
            max="127"
            value={noteGateNote}
            onchange={onChangeNoteGate}
          />
          <span class="note-name">{noteNameForMidi(noteGateNote).toUpperCase()}</span>
        </label>

        <div class="readout">
          <div class="readout-row">
            <span class="lbl">NOTE</span>
            <span class="val">{activeNoteLabel}</span>
          </div>
          <div class="readout-row">
            <span class="lbl">VEL</span>
            <span class="val">{cardState.lastVelocity}</span>
          </div>
        </div>
      {/if}
    </div>
  </PatchPanel>
</div>

<style>
  .midi-lane-card { width: 230px; }
  .midi-lane-card .body {
    padding: 10px 14px 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .midi-lane-card .connect-btn {
    padding: 8px 12px;
    background: var(--cable-cv, #6cc);
    color: #000;
    border: none;
    border-radius: 4px;
    font-weight: 600;
    cursor: pointer;
    font-size: 12px;
  }
  .midi-lane-card .connect-btn:hover { filter: brightness(1.15); }
  .midi-lane-card .hint {
    font-size: 10px;
    color: var(--muted, #888);
    margin-top: 4px;
    line-height: 1.3;
  }
  .midi-lane-card .hint.err { color: #d66; }
  .midi-lane-card .row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 10px;
  }
  .midi-lane-card .row .lbl,
  .midi-lane-card .cc-row .lbl {
    min-width: 42px;
    color: var(--muted, #aaa);
    font-weight: 600;
    letter-spacing: 0.5px;
  }
  .midi-lane-card .row select,
  .midi-lane-card .note-num {
    flex: 1;
    font-size: 10px;
    padding: 2px 4px;
    background: var(--panel, #222);
    color: var(--fg, #eee);
    border: 1px solid var(--border, #444);
    border-radius: 2px;
  }
  .midi-lane-card .note-num { max-width: 56px; }
  .midi-lane-card .note-name {
    font-size: 10px;
    font-family: var(--mono, ui-monospace, monospace);
    color: var(--fg, #ddd);
  }
  .midi-lane-card .cc-row {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 10px;
  }
  .midi-lane-card .cc-row .cc-val {
    min-width: 22px;
    text-align: center;
    font-family: var(--mono, ui-monospace, monospace);
    color: var(--fg, #eee);
    font-weight: 600;
  }
  .midi-lane-card .mini {
    font-size: 9px;
    padding: 2px 5px;
    background: var(--panel, #222);
    color: var(--fg, #ddd);
    border: 1px solid var(--border, #444);
    border-radius: 2px;
    cursor: pointer;
  }
  .midi-lane-card .mini:hover { filter: brightness(1.2); }
  .midi-lane-card .mini.learning {
    background: var(--cable-cv, #6cc);
    color: #000;
    font-weight: 700;
  }
  .midi-lane-card .row.retrig { gap: 6px; }
  .midi-lane-card .readout {
    margin-top: 6px;
    padding: 4px 6px;
    border: 1px solid var(--border, #333);
    border-radius: 3px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .midi-lane-card .readout-row {
    display: flex;
    justify-content: space-between;
    font-size: 10px;
    font-family: var(--mono, ui-monospace, monospace);
  }
  .midi-lane-card .readout-row .val {
    color: var(--fg, #eee);
    font-weight: 600;
  }
</style>

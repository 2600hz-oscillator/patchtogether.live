<script lang="ts">
  // MidiclockCard — UI for the MIDICLOCK module.
  //
  // Pattern mirrors MidiCvBuddyCard: Connect button (one-time per origin),
  // device picker, and a divisor selector for the clock output rate.
  // Live status: RUN indicator + total ticks observed since connect.

  import { onDestroy } from 'svelte';
  import type { NodeProps } from '@xyflow/svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { mutateNode, setNodeParam } from '$lib/graph/mutate';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import {
    CLOCK_DIVISORS,
    DEFAULT_DIVISOR,
    divisorLabel,
    isValidDivisor,
    snapDivisor,
    type ClockDivisor,
    type MidiclockApi,
    type MidiclockCardState,
    type MidiclockData,
  } from '$lib/audio/modules/midiclock';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  let cardState = $state<MidiclockCardState>({
    connected: false,
    permissionDenied: false, accessMessage: '',
    devices: [],
    selectedDeviceId: null,
    running: false,
    divisor: 24,
    ticksReceived: 0,
  });

  let savedData = $derived((node?.data ?? {}) as Partial<MidiclockData>);
  // ⚠ params FIRST, THEN THE LEGACY `data` KEY — the same order the factory
  // reads in, and for the same reason: `divisor` is a `ParamDef` now, and a
  // rack saved before that declaration still carries `data.divisor`. Reading
  // params first means a new value always wins; falling through means an old
  // rack keeps the division its author chose. The legacy key is never written
  // back from here (see the def's `snapDivisor` comment for why an engine- or
  // card-side repair of stored data is refused).
  let divisor = $derived<ClockDivisor>(
    typeof node?.params?.divisor === 'number'
      ? snapDivisor(node.params.divisor)
      : isValidDivisor(savedData.divisor)
        ? savedData.divisor
        : DEFAULT_DIVISOR,
  );

  function getApi(): MidiclockApi | null {
    const e = engineCtx.get();
    if (!e || !node) return null;
    return (e.read(node, 'card-api') as MidiclockApi | undefined) ?? null;
  }

  let unsubscribe: (() => void) | null = null;
  $effect(() => {
    const _ = id;
    const api = getApi();
    if (!api) return;
    unsubscribe?.();
    unsubscribe = api.subscribe((s) => { cardState = s; });
    return () => {
      unsubscribe?.();
      unsubscribe = null;
    };
  });
  onDestroy(() => { unsubscribe?.(); });

  async function onClickConnect(): Promise<void> {
    const api = getApi();
    if (!api) return;
    await api.connect();
  }

  function onChangeDevice(ev: Event): void {
    const sel = (ev.currentTarget as HTMLSelectElement).value || null;
    getApi()?.selectDevice(sel);
    // ⚠ ORIGIN-TAGGED. This used to go through a local `writeData` helper that
    // assigned straight onto `patch.nodes[id].data` — a bare SyncedStore proxy
    // write with no `ydoc.transact` and no `LOCAL_ORIGIN`. The store's
    // UndoManager tracks `LOCAL_ORIGIN` only, so picking a MIDI device SYNCED
    // to collaborators but was silently outside Cmd-Z. Nothing could see it:
    // `mutate.guard.test.ts`'s patterns all anchor on the literal token
    // `.params`, and this touched `.data`. `mutateNode` is the sanctioned seam.
    mutateNode(id, (live) => {
      if (!live.data) live.data = {};
      live.data.lastDeviceId = sel;
    });
  }

  function onChangeDivisor(ev: Event): void {
    const raw = Number.parseInt((ev.currentTarget as HTMLSelectElement).value, 10);
    if (!isValidDivisor(raw)) return;
    // ⚠ A PARAM NOW, NOT A `node.data` KEY. `setNodeParam` is the ordinary
    // origin-tagged seam every knob writes through, so the division is undoable
    // and reaches automation / MIDI learn / a group like any other value. The
    // ENGINE write is left to the param path rather than being driven here
    // twice — one truth, one writer.
    setNodeParam(id, 'divisor', raw);
  }

  const inputs: PortDescriptor[] = [];
  const outputs: PortDescriptor[] = [
    { id: 'clock',     label: 'CLK',   cable: 'gate' },
    { id: 'run',       label: 'RUN',   cable: 'cv'   },
    { id: 'midistart', label: 'START', cable: 'gate' },
    { id: 'midistop',  label: 'STOP',  cable: 'gate' },
  ];
</script>

<div class="mod-card midiclock-card">
  <div class="stripe" style="background: var(--cable-gate);"></div>
  <ModuleTitle {id} {data} defaultLabel="MIDICLOCK" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="body">
      {#if !cardState.connected}
        <!-- ⚠ CARRIES THE CONTROL FAMILY'S `testidPrefix`. `midiclock-connect`
             is a declared `controlFamilies` entry now (it is what the face's
             ranked action cell resolves against), and `module-docs-lint`
             requires every declared prefix to appear in the CARD source — the
             gate that keeps a family declaration and the card it describes from
             drifting apart. The card really does have this gesture, so naming
             it here is agreement rather than paperwork. -->
        <button
          class="connect-btn"
          type="button"
          data-testid="midiclock-connect-{id}"
          onclick={onClickConnect}
        >
          Connect MIDI…
        </button>
        {#if cardState.accessMessage}
          <!-- LOUD, and actionable. The old copy was a one-line hint swap that
               a user reading a dead button did not register — and the
               suppressed-prompt case produced NO message at all. -->
          <div class="hint err" data-testid="midiclock-access-error-{id}">
            {cardState.accessMessage}
          </div>
        {:else}
          <div class="hint">Click to grant MIDI access (one-time per origin).</div>
        {/if}
      {:else}
        <label class="row">
          <span class="lbl">DEVICE</span>
          <!-- ⚠ NAMED, because a fixture spec used to reach this element as
               `.locator('select').first()`. That worked only while the card
               happened to have exactly two selects in a known order, and it
               would have silently resolved to a DIFFERENT control the moment a
               third was added or the order changed — a wrong-element bug that
               reports as a confusing assertion failure somewhere else. -->
          <select
            data-testid="midiclock-card-device-{id}"
            onchange={onChangeDevice}
            value={cardState.selectedDeviceId ?? ''}
          >
            <option value="" disabled>(pick one)</option>
            {#each cardState.devices as d (d.id)}
              <option value={d.id}>{d.name}</option>
            {/each}
          </select>
        </label>

        <label class="row">
          <span class="lbl">DIV</span>
          <select onchange={onChangeDivisor} value={String(divisor)}>
            {#each CLOCK_DIVISORS as d (d)}
              <option value={String(d)}>{divisorLabel(d)}</option>
            {/each}
          </select>
        </label>

        <!-- ⚠ THE `TICKS` ROW IS GONE, AND IT WAS BROKEN RATHER THAN MERELY
             REDUNDANT. `midiclock.ts`'s CLOCK branch returns before `notify()`
             — correctly, since 24 PPQN at 120 BPM is 48 Hz of subscriber
             pressure — on the stated grounds that "Card has its own rAF for the
             activity LED". This card has never contained a
             `requestAnimationFrame`. So the number shown here was the count as
             of the last START, frozen for the entire performance, jumping at
             STOP: a live activity indicator in exactly the one state it must
             never be in. Deleted rather than repaired, because the honest fix
             (a poll or an rAF) would add a repaint loop for a raw count that
             the faceplate is not allowed to paint anyway.
             STATE survives HERE — this is the legacy card, not a faceplate, and
             it is driven by `notify()`, which fires on precisely the transport
             messages that change it. -->
        <div class="readout">
          <div class="readout-row">
            <span class="lbl">STATE</span>
            <span class="val state" class:running={cardState.running}>
              {cardState.running ? 'RUN' : 'STOP'}
            </span>
          </div>
        </div>
      {/if}
    </div>
  </PatchPanel>
</div>

<style>
  .midiclock-card { width: 200px; }
  .midiclock-card .body {
    padding: 10px 14px 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .midiclock-card .connect-btn {
    padding: 8px 12px;
    background: var(--cable-gate, #ec6);
    color: #000;
    border: none;
    border-radius: 4px;
    font-weight: 600;
    cursor: pointer;
    font-size: 12px;
  }
  .midiclock-card .connect-btn:hover { filter: brightness(1.15); }
  .midiclock-card .hint {
    font-size: 10px;
    color: var(--muted, #888);
    margin-top: 4px;
    line-height: 1.3;
  }
  .midiclock-card .hint.err { color: #d66; }
  .midiclock-card .row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 10px;
  }
  .midiclock-card .row .lbl {
    min-width: 42px;
    color: var(--muted, #aaa);
    font-weight: 600;
    letter-spacing: 0.5px;
  }
  .midiclock-card .row select {
    flex: 1;
    font-size: 10px;
    padding: 2px 4px;
    background: var(--panel, #222);
    color: var(--fg, #eee);
    border: 1px solid var(--border, #444);
    border-radius: 2px;
  }
  .midiclock-card .readout {
    margin-top: 6px;
    padding: 4px 6px;
    border: 1px solid var(--border, #333);
    border-radius: 3px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .midiclock-card .readout-row {
    display: flex;
    justify-content: space-between;
    font-size: 10px;
    font-family: var(--mono, ui-monospace, monospace);
  }
  .midiclock-card .readout-row .val {
    color: var(--fg, #eee);
    font-weight: 600;
  }
  .midiclock-card .readout-row .val.state {
    color: var(--muted, #888);
  }
  .midiclock-card .readout-row .val.state.running {
    color: var(--cable-gate, #ec6);
  }
</style>

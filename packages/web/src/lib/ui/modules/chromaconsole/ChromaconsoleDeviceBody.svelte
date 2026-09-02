<script lang="ts">
  // ChromaconsoleDeviceBody — the DEVICE BINDING and SLOT BOARD, at the head of
  // the dock full view. `MidiclockDeviceBody` / `PtzcamDeviceBody` are the
  // template; this one carries a second region they do not have, and the reason
  // is the module's whole design.
  //
  // ── WHAT IT CARRIES, AND WHY EACH PART IS ALLOWED TO ───────────────────────
  //
  // The resting-text rulings permit the module NAME, section LABELS, control
  // CAPTIONS and option/landmark NAMES. Everything here is one of those, an
  // ERROR, or a LAMP:
  //
  //   * THE OUTPUT `<select>` — the affordance that cannot be a face cell. Its
  //     roster lives on the engine handle behind `requestMIDIAccess()`, differs
  //     per machine, and changes when hardware is plugged in, so it is neither a
  //     `ParamDef` nor an `options` roster (a roster is a fixed set known when
  //     the def is authored). Its painted text is a device NAME — the
  //     cameraInput / midiclock / ptzcam precedent.
  //   * THE CHANNEL `<select>` — a FIXED 16-entry roster, which COULD be a
  //     `ShellSelectorCell`, and deliberately is not: the channel lives on the
  //     device HANDLE (`createDeviceHandle`), not on the graph, so a cell's
  //     `value: (node) => …` — a pure function of the NODE — would paint a
  //     stale channel forever. It sits beside the output it qualifies, which is
  //     also where a player looks for it.
  //   * THE SLOT BOARD — what each of the eight slots DRIVES, and where the
  //     assignment is changed. See the next section.
  //   * THE LAMP, through `StatusLed`: a static literal caption, a boolean that
  //     IS the picture, and the sentence on `aria-label` / `title`.
  //   * THE PRE-CONNECT HINT — instructional copy in an EMPTY state, which is
  //     the whole content of the plate before a grant (the midiclock licence).
  //   * THE PROBLEM LINE — an ERROR, `role="alert"`, absent whenever nothing is
  //     wrong. It is the OUTCOME OF A GESTURE, not resting text, and it carries
  //     `midiOutcomeMessage`'s sentence, which for the suppressed-prompt case is
  //     the only thing in the product that says what happened at all.
  //   * THE PEDAL COMMANDS — five `role: 'action'` device commands (tap tempo,
  //     capture, the two gesture-looper commands, the calibration menu). Painted
  //     text is each control's own descriptor LABEL.
  //
  // ── ⚠ WHY THE SLOT BOARD IS HERE AND NOT EIGHT MORE CELLS ──────────────────
  //
  // `deviceSlotParams` mints eight IDENTICAL `0..127 linear` params labelled
  // `slot 1`..`slot 8`, because a ParamDef id is public and permanent while what
  // each slot DRIVES is per-NODE (`node.data.assign`). A face cell's caption is
  // `ParamDef.label` and nothing else — `shellCellFor(node.type, ctl)` takes the
  // TYPE, and every param arm in ModuleShell passes `label={pd.label}` — so the
  // band below can only ever say `slot 1`..`slot 8`. This board is where the
  // eight NAMES live, and it is the owner-approved shape (2026-08-31
  // owner-decisions item 7: "accept two operable surfaces per slot — a generic
  // band knob plus the body's real Segmented"; the alternative, per-node cell
  // derivation, is platform work that ruling declines).
  //
  // ⚠ IT IS NOT A SECOND SET OF KNOBS. A continuous slot is turned in the band
  // below; its chip here says only what it IS. The one exception is a slot
  // assigned to one of the pedal's SELECTORS (`role: 'enum'` — the four module
  // switches and the six bypasses), whose states are NAMED RANGES rather than a
  // scale: those cannot be a knob at all honestly, and the card rendered them as
  // a `Segmented`. That control is reproduced here, with an explicit `testid` so
  // the second surface does not claim to be the param's cell (faces-parity
  // asserts exact multiset equality over `[data-testid^="control-"]`).
  //
  // ⚠ ASSIGN IS A MODE, AND THE MODE'S STATE IS COMPONENT STATE — deliberately,
  // against the pattern the SCREEN-toggle ruling establishes. `node.data` is for
  // a persistent VIEW PREFERENCE that must survive a reload and reach
  // collaborators; an assign mode is a transient EDITING state, and persisting
  // it would reopen the editor on every load and sync one collaborator's editing
  // into another's performance view. (The legacy card rendered all eight
  // `<select>`s permanently, which is eight dropdowns of chrome at rest for a
  // setting changed rarely.)
  //
  // ── ⚠ WHAT THE PROMOTION DELETED ───────────────────────────────────────────
  //
  // TWO readouts, both under the 2026-08-17 ruling:
  //
  //   the per-slot VALUE readout — gone. It is the white decimal the ruling
  //     names, and on a `readBack: 'none'` device it was also the element most
  //     likely to be read as "what the pedal holds". ⚠ THE DESCRIPTOR'S VALUE
  //     FORMATTER IS DELIBERATELY NOT IMPORTED HERE, and a permanent leg in
  //     `chromaconsole-face-model.test.ts` greps for it by name — the gate reads
  //     raw source and cannot tell code from a comment, so this sentence names
  //     it in words rather than in the identifier.
  //   the stale-slot COUNT ("N slot(s) point at controls this device no longer
  //     has") — the sentence is gone; the SIGNAL is kept and improved. The count
  //     said how many; the board marks WHICH, per chip, with the sentence on the
  //     chip's accessible name.
  //
  // The `pedal-snapped` marker STAYS, and the distinction is deliberate: it is a
  // property of the ASSIGNED CONTROL (static for as long as the assignment
  // stands), not a measurement of the value — the same class as an option name.
  // Two controls, RATE and TIME, are snapped by the pedal to tempo subdivisions
  // and cannot be un-snapped, and without the marker a player cannot reconcile a
  // smooth-looking number with a stepped-sounding result.
  //
  // The open-loop sentence ("Send-only — the pedal cannot report back") is gone
  // from the surface and is a RELOCATION rather than a loss: `docs.explanation`
  // carries it verbatim and at greater length, and the LINK lamp's detail says
  // it again wherever a reader asks what the lamp means.
  //
  // ── ⚠ NO ACTIVITY INDICATOR, NO COUNTER, NO ELAPSED TIME ───────────────────
  //
  // The legacy card's header records that its resting render must be byte-stable
  // for a committed VRT baseline, and that the same deletions keep it from
  // implying it knows the pedal's state. The face inherits both. `BINDERS §2.1`
  // would permit a non-text activity dot in principle; here it is refused,
  // because a blinking element breaks a determinism property this module holds
  // on purpose. Transmission detail is observable through the handle's ledger
  // (`read('ledger')`), which is where the e2e looks.
  //
  // ⚠ THIS BODY OWNS NO SUBSCRIPTION. Unlike midiclock's there is no push seam
  // to register with: `DeviceCardApi` is pull-only, and nothing on this module
  // changes on its own (which is what keeps the resting render stable). Reads
  // re-run on the node version and on this surface's own gestures — the card's
  // pattern, and the reason it needs no teardown.

  import { patch } from '$lib/graph/store';
  import { setNodeParam } from '$lib/graph/mutate';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import { Segmented, StatusLed } from '$lib/ui/controls';
  import type { ModuleNode } from '$lib/graph/types';
  import { CHROMA_CONSOLE } from '$lib/devices/hologram-chroma-console';
  import type { DeviceStatus } from '$lib/devices/device-module';
  import {
    actionControls,
    enumRangeValue,
    slottableControls,
    type DeviceControl,
    type ResolvedSlot,
  } from '$lib/devices/device-descriptor';
  import {
    chromaconsoleApi,
    chromaconsoleAssignSlot,
    chromaconsoleFireAction,
    chromaconsoleSelectPort,
    chromaconsoleSetChannel,
  } from '../chromaconsole-cell-actions';
  import {
    CHROMA_CHANNEL_CHOICES,
    chromaconsoleBoardDetail,
    chromaconsoleLinkDetail,
    chromaconsolePortOptions,
    chromaconsoleSlotChips,
  } from './chromaconsole-status-model';

  let { nodeId }: { nodeId: string } = $props();

  /** Bumped by this surface's own gestures so the api-backed reads re-run. There
   *  is no polling timer: nothing here changes on its own. */
  let revision = $state(0);
  /** The transient editing mode — see the header. */
  let assigning = $state(false);

  let nodeV = $derived(nodeVersion(nodeId));
  let node = $derived<ModuleNode | undefined>(
    (void nodeV, patch.nodes[nodeId] as ModuleNode | undefined),
  );

  const EMPTY_STATUS: DeviceStatus = {
    connected: false,
    portId: null,
    portName: null,
    channel: CHROMA_CONSOLE.defaultChannel,
    problem: '',
    staleSlots: [],
    delivered: 0,
    undelivered: 0,
  };

  let status = $derived.by<DeviceStatus>(() => {
    void revision;
    void node;
    return chromaconsoleApi(nodeId)?.status() ?? EMPTY_STATUS;
  });
  let outputs = $derived.by<{ id: string; name: string }[]>(() => {
    void revision;
    void node;
    return chromaconsoleApi(nodeId)?.listOutputs() ?? [];
  });
  let slots = $derived.by<ResolvedSlot[]>(() => {
    void revision;
    void node;
    return chromaconsoleApi(nodeId)?.slots() ?? [];
  });

  let portOptions = $derived(chromaconsolePortOptions(outputs));
  let chips = $derived(chromaconsoleSlotChips(slots));
  let boardDetail = $derived(chromaconsoleBoardDetail(slots));
  let linkDetail = $derived(chromaconsoleLinkDetail(status));

  /** The assignment roster, grouped the way the device's own documentation is.
   *  Descriptor data, so it is computed once per module rather than per node. */
  const GROUPED = (() => {
    const byGroup = new Map<string, DeviceControl[]>();
    for (const c of slottableControls(CHROMA_CONSOLE)) {
      const list = byGroup.get(c.group) ?? [];
      list.push(c);
      byGroup.set(c.group, list);
    }
    return [...byGroup.entries()];
  })();

  const ACTIONS = actionControls(CHROMA_CONSOLE);

  /** Enum controls write each named range's midpoint — `enumRangeValue`, the
   *  same resolver the card uses, so the two surfaces cannot disagree about
   *  which number means BYPASS. */
  function segmentOptions(control: DeviceControl): { value: number; label: string }[] {
    return (control.ranges ?? []).map((r) => ({
      value: enumRangeValue(r),
      label: r.label,
    }));
  }

  function slotValue(slotId: string): number {
    const v = node?.params?.[slotId];
    return typeof v === 'number' ? v : 0;
  }

  function onSelectPort(event: Event): void {
    const value = (event.currentTarget as HTMLSelectElement).value;
    chromaconsoleSelectPort(nodeId, value === '' ? null : value);
    revision++;
  }

  function onSelectChannel(event: Event): void {
    chromaconsoleSetChannel(nodeId, Number((event.currentTarget as HTMLSelectElement).value));
    revision++;
  }

  function onAssign(slotId: string, event: Event): void {
    const value = (event.currentTarget as HTMLSelectElement).value;
    chromaconsoleAssignSlot(nodeId, slotId, value === '' ? null : value);
    revision++;
  }

  function onFireAction(controlId: string): void {
    chromaconsoleFireAction(nodeId, controlId);
    revision++;
  }
</script>

<!-- ⚠ A COLUMN, and that is a layout requirement rather than a look:
     `.faceplate-body` is `width: max-content`, so a single flex ROW holding the
     pickers, the board and the lamp would have an intrinsic width equal to all
     of them UNWRAPPED. A column's max-content is the MAX of its rows. -->
<div class="chroma-device" data-testid="chromaconsole-device-body-{nodeId}">
  <div class="row-main">
    <label class="row">
      <span class="cap">Output</span>
      <select
        data-testid="chromaconsole-port-{nodeId}"
        value={status.portId ?? ''}
        onchange={onSelectPort}
      >
        <option value="">— no output —</option>
        {#each portOptions as opt (opt.value)}
          <option value={opt.value}>{opt.label}</option>
        {/each}
      </select>
    </label>

    <label class="row">
      <span class="cap">Channel</span>
      <select
        data-testid="chromaconsole-channel-{nodeId}"
        value={String(status.channel)}
        onchange={onSelectChannel}
      >
        {#each CHROMA_CHANNEL_CHOICES as ch (ch.value)}
          <option value={ch.value}>{ch.label}</option>
        {/each}
      </select>
    </label>

    <span class="lamps">
      <StatusLed
        caption="MIDI"
        lit={status.connected}
        detail={linkDetail}
        testid="chromaconsole-led-midi-{nodeId}"
      />
    </span>
  </div>

  {#if status.problem}
    <p class="err" role="alert" data-testid="chromaconsole-problem-{nodeId}">{status.problem}</p>
  {:else if outputs.length === 0}
    <!-- The EMPTY STATE: what to do, and why nothing is listed yet. -->
    <p class="hint">Press Connect MIDI to grant access and pick the pedal. One-time per origin.</p>
  {/if}

  <div class="board-head">
    <span class="cap">Slots</span>
    <button
      type="button"
      class="assign-toggle"
      aria-pressed={assigning}
      data-testid="chromaconsole-assign-mode-{nodeId}"
      onclick={() => (assigning = !assigning)}
    >
      {assigning ? 'Done' : 'Assign'}
    </button>
  </div>

  <div class="board" data-testid="chromaconsole-board-{nodeId}" aria-label={boardDetail}>
    {#each chips as chip (chip.slotId)}
      <div class="slot" data-testid="chromaconsole-slot-{nodeId}-{chip.index + 1}">
        {#if assigning}
          <select
            aria-label={chip.detail}
            data-testid="chromaconsole-assign-{nodeId}-{chip.index + 1}"
            value={chip.control?.id ?? ''}
            onchange={(e) => onAssign(chip.slotId, e)}
          >
            <option value="">— unassigned —</option>
            {#each GROUPED as [group, controls] (group)}
              <optgroup label={group}>
                {#each controls as c (c.id)}
                  <option value={c.id}>{c.label}</option>
                {/each}
              </optgroup>
            {/each}
          </select>
        {:else}
          <!-- The chip: the assigned control's NAME (never its value), its snap
               marker, and a stale mark. The SENTENCE is the accessible name. -->
          <span
            class="chip"
            class:stale={chip.stale}
            aria-label={chip.detail}
            title={chip.detail}
          >
            <span class="ord" aria-hidden="true">{chip.index + 1}</span>
            <span class="name">{chip.name}</span>
            {#if chip.snapped}<span class="snap">·snap</span>{/if}
            {#if chip.stale}<span class="warn" aria-hidden="true">⚠</span>{/if}
          </span>

          {#if chip.control && chip.control.role === 'enum'}
            <!-- The one control that cannot be an honest knob: its states are
                 NAMED RANGES. `paramId` keeps MIDI learn; the explicit `testid`
                 stops this second surface claiming to be the param's cell. -->
            <Segmented
              value={slotValue(chip.slotId)}
              segments={segmentOptions(chip.control)}
              moduleId={nodeId}
              paramId={chip.slotId}
              testid="chromaconsole-seg-{nodeId}-{chip.slotId}"
              onchange={(v) => setNodeParam(nodeId, chip.slotId, Number(v))}
              snapActive
            />
          {/if}
        {/if}
      </div>
    {/each}
  </div>

  <div class="commands">
    {#each ACTIONS as action (action.id)}
      <button
        type="button"
        title={action.doc}
        aria-label={action.doc}
        data-testid="chromaconsole-action-{nodeId}-{action.id}"
        onclick={() => onFireAction(action.id)}
      >
        {action.label}
      </button>
    {/each}
  </div>
</div>

<style>
  .chroma-device {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 5px;
    padding: 6px 10px;
    border: 1px solid var(--border, #333);
    border-radius: 3px;
    background: var(--panel, #1b1b1b);
  }
  .row-main {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  .hint,
  .err {
    margin: 0;
    font-size: 10px;
    line-height: 1.3;
    max-width: 34ch;
  }
  .hint { color: var(--muted, #888); }
  .err { color: #d66; }
  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 10px;
  }
  /* A control CAPTION, typeset the way every other cell caption is. */
  .cap {
    color: var(--muted, #aaa);
    font-weight: 600;
    letter-spacing: 0.5px;
    text-transform: uppercase;
    font-size: 9px;
  }
  .row select,
  .slot select {
    font-size: 10px;
    padding: 2px 4px;
    max-width: 190px;
    background: var(--panel, #222);
    color: var(--fg, #eee);
    border: 1px solid var(--border, #444);
    border-radius: 2px;
  }
  .lamps {
    display: inline-flex;
    align-items: center;
    gap: 12px;
    margin-left: auto;
  }
  .board-head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .assign-toggle,
  .commands button {
    font-size: 9px;
    padding: 1px 6px;
    background: var(--panel, #222);
    color: var(--fg, #eee);
    border: 1px solid var(--border, #444);
    border-radius: 2px;
    cursor: pointer;
  }
  .assign-toggle[aria-pressed='true'] {
    border-color: var(--accent, #6af);
    color: var(--accent, #6af);
  }
  /* TWO columns of four: eight one-line chips fit the plate the eight knob
     cells below occupy, and an enum slot's Segmented has room for its named
     ranges without the board growing a third column. */
  .board {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 3px 10px;
  }
  .slot {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .slot select {
    width: 100%;
  }
  .chip {
    display: inline-flex;
    align-items: baseline;
    gap: 4px;
    font-size: 10px;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
  }
  .chip .ord {
    color: var(--muted, #777);
    font-size: 9px;
    font-variant-numeric: tabular-nums;
  }
  .chip .name {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .chip.stale .name {
    color: #d98a3a;
  }
  .snap {
    font-size: 8px;
    opacity: 0.7;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .warn {
    color: #d98a3a;
    font-size: 9px;
  }
  .commands {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
</style>

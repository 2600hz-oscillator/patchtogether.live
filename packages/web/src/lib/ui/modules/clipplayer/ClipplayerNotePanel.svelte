<script lang="ts">
  // ClipplayerNotePanel — the `clipplayer-cell` family's cell: the PIANO-ROLL
  // note editor for the clip the launch grid has open, plus the clip-scoped
  // gestures that operate on it.
  //
  // X = step, Y = pitch. The WHOLE editable grid renders at once — every
  // editable pitch row tall by every step wide, up to 128 — so editing on a
  // computer never needs the Launchpad's pitch-window or step-page scrolling.
  // That is the owner's instruction ("we just always show the whole editable
  // grid") and it is why this panel declares a wide `minWidth`.
  //
  // ⚠ WHICH CLIP IT SHOWS IS NOT IN `node.data`. It comes from the node-keyed
  // selection registry next door, set by double-clicking a pad in the launch
  // panel — two INDEPENDENT shell cells sharing one selection, the dx7
  // map/detail precedent. Syncing the selection would drag a collaborator's
  // editor to your clip mid-edit; the card's own spec calls the equivalent
  // card-local state "a personal authoring lens".
  //
  // ⚠ THE SAME DOUBLE-CLICK ALSO NAVIGATES HERE. This band is the `editor` page
  // of a TABBED face (owner P0, 2026-09-04), so it is HIDDEN while the grid is
  // showing and the grid is hidden while it is — the legacy card's mutually
  // exclusive `cardView` branches, restored. `requestFaceTab` in the launch
  // panel is the seam; the SESSION tab is the way back.
  //
  // ⚠ NO RESTING DERIVED TEXT (the 2026-08-17/19 rulings). The card painted
  // `L1·S1`, the clip's root note name and a `c3–c7` range span as bare
  // readouts; those are values, not controls, so they move to the accessible
  // name and the tooltip. What still paints is control CAPTIONS that show their
  // own state — the scale button, the length button, the DIV button, the swing
  // amount — which is what a Selector does everywhere else on a faceplate.
  //
  // ⚠ THE PLAYHEAD POLL IS SCOPED TO A PLAYING CLIP, deliberately. It reads ONE
  // engine value (`currentStep:{lane}`) and only while the edited clip is the
  // one sounding in its lane; with nothing launched — which is every fresh
  // spawn and every VRT capture — the loop makes no engine call and the column
  // highlight is off, so this panel is a pure function of stored data at rest.
  //
  // ⚠ NO `control-<paramId>` TESTID (shell-cells panel rule 1). `restrictRange`
  // and `rangeFloor` are real params and therefore have their OWN cells in this
  // band, beside the roll — the one thing that moved rather than being
  // reproduced here, so the faceplate paints each of them exactly once.

  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import { clipplayerDef } from '$lib/audio/modules/clipplayer';
  import { noteNameForMidi } from '$lib/audio/note-entry';
  import {
    DEFAULT_CLIP_STEPS,
    MAX_CLIP_STEPS,
    autoClipHasTracks,
    editableRowRange,
    laneCustomScale,
    laneCustomScaleOn,
    defaultNoteClip,
    laneOf,
    lanePlaying,
    laneQueued,
    laneSwing,
    isSwingCentered,
    noteCovering,
    restrictedRowWindow,
    rowToMidi,
    slotOf,
    visibleNoteRows,
    type ClipPlayerData,
    type NoteClipRecord,
  } from '$lib/audio/modules/clip-types';
  import { RATE_LABELS, clipDivIndex } from '$lib/audio/modules/clip-clock';
  import { clearClipAutomation } from '$lib/graph/automation-assign';
  import {
    noteCellFill,
    noteCellPitchProb,
    noteCellPitchUnstable,
  } from '../clipplayer-prob-color';
  import { pitchProbLabel } from '$lib/audio/pitch-probability';
  import type { ClipplayerMenuAt } from './clipplayer-face-model';
  import {
    clipplayerClipAt,
    cycleClipplayerClipDiv,
    cycleClipplayerClipLength,
    cycleClipplayerClipScale,
    cycleClipplayerNoteVelocity,
    doubleClipplayerClip,
    emptyClipplayerClip,
    ensureClipplayerClip,
    nudgeClipplayerLaneSwing,
    queueClipplayerLane,
    setClipplayerCustomScaleOn,
    toggleClipplayerNote,
    toggleClipplayerScaleRow,
  } from './clipplayer-face-actions';
  import { clipplayerSelectedClip } from './clipplayer-face-selection.svelte';
  import ClipplayerClipMenu from './ClipplayerClipMenu.svelte';

  interface Props {
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  const engineCtx = useEngine();

  /** The version is carried in the result — a bare SyncedStore proxy is `===`
   *  to itself and the roll would freeze at first render. */
  let live = $derived.by(() => ({
    v: nodeVersion(nodeId),
    n: patch.nodes[nodeId] as ModuleNode | undefined,
  }));
  let data = $derived(live.n?.data as ClipPlayerData | undefined);

  function pdef(pid: string) {
    return clipplayerDef.params.find((p) => p.id === pid)!;
  }
  /** The DISPLAY-only pitch window pair. Read from the params (which the band's
   *  own cells write) — never mirrored into this component's state. */
  let restrictRange = $derived((live.v, (live.n?.params?.restrictRange ?? 0) >= 0.5));
  let rangeFloor = $derived(
    (live.v, Math.round(live.n?.params?.rangeFloor ?? pdef('rangeFloor').defaultValue)),
  );
  /** Window height when restricted. Matches `restrictedRowWindow`'s own default
   *  — the constant is interpolated into every string below rather than spelled
   *  out, which is the only reason the card's tooltips stayed correct while
   *  seven authored surfaces drifted to "4-octave". */
  const RESTRICT_OCTAVES = 3;

  let selectedClip = $derived(clipplayerSelectedClip(nodeId));
  let storedClip = $derived.by<NoteClipRecord | null>(() => {
    void live.v;
    return clipplayerClipAt(nodeId, selectedClip);
  });
  /**
   * The clip the roll draws. An EMPTY slot draws a DEFAULT clip's grid rather
   * than a placeholder, and the first edit creates it for real.
   *
   * ⚠ THE FACE DOES HAVE VIEWS AGAIN (owner P0, 2026-09-04), SO THIS IS NO
   * LONGER A DIFFERENCE FROM THE CARD — BUT IT IS STILL THE RIGHT DEFAULT, for
   * a reason the card never had. On the card the ONLY way into the editor is a
   * double-click on a pad, and that gesture creates the clip on the way in, so
   * the editor never sees an empty slot. On the face there is a SECOND way in:
   * the tab rail, which the card's GRID/CLIP strip is the ancestor of and which
   * performs no `ensureClip`. Opening the EDITOR tab directly therefore CAN land
   * on an empty slot, and the two honest options are a blank band or a live one.
   * Drawing a real grid you can write into is exactly what double-clicking the
   * pad would have given you, so that is what it draws.
   *
   * ⚠ AND IT STILL MUST NOT BE THE FIRST PAGE. `face.pages[0]` is the default
   * tab; `session` holds it, so a freshly opened faceplate shows the GRID and
   * this roll is not on screen at all until you ask for it. That is the whole
   * of the owner's report ("we do NOT want the clip viewer always visible").
   *
   * ⚠ IT WRITES NOTHING ON MOUNT. `ensureClipplayerClip` runs on the first
   * EDIT, never in a `$derived` and never in an `$effect` — a band that
   * committed a clip to the Y.Doc just for being rendered would put a write in
   * every rack boot and in every VRT capture.
   */
  let clip = $derived(storedClip ?? defaultNoteClip());
  let pending = $derived(storedClip === null);
  let editLane = $derived(laneOf(selectedClip));
  let editSlot = $derived(slotOf(selectedClip));

  let editRange = $derived(
    restrictRange
      ? restrictedRowWindow(clip.root, clip.scale, rangeFloor, RESTRICT_OCTAVES)
      : editableRowRange(clip.root, clip.scale),
  );
  let editCols = $derived(Math.min(MAX_CLIP_STEPS, clip.lengthSteps || DEFAULT_CLIP_STEPS));

  /** VIEW-LOCAL (never synced): revealing the checkbox column is a personal
   *  authoring lens, like holding shift. The MEMBERSHIP and the APPLIED flag
   *  both live on node.data. */
  let pickingScale = $state(false);
  /** The card's shift-to-edit-velocity modifier, held on this surface. */
  let velMode = $state(false);

  let customScaleNotes = $derived((live.v, laneCustomScale(data, editLane)));
  let customScaleOn = $derived((live.v, laneCustomScaleOn(data, editLane)));

  /** THE ONE ROW LIST the roll renders — the same `visibleNoteRows` the
   *  Launchpad and monome read. While PICKING it is deliberately UNFILTERED, so
   *  rows can be ADDED (a filtered picker could only ever remove them). */
  let editRowMidis = $derived.by<number[]>(() => {
    void live.v;
    return visibleNoteRows(clip, pickingScale ? undefined : data, editLane, editRange);
  });
  let editRows = $derived(editRowMidis.length || editRange.count || 8);

  /** THE FUNNEL: every note gesture resolves its pitch through here. */
  function midiForDisplayRow(c: NoteClipRecord, displayRow: number): number {
    const list = editRowMidis;
    if (list.length > 0) return list[Math.max(0, Math.min(list.length - 1, displayRow))]!;
    const r = editRange;
    return rowToMidi(r.hi - displayRow, c.root, c.scale);
  }

  let editorHasAuto = $derived.by(() => {
    void live.v;
    return autoClipHasTracks((data?.auto ?? {})[String(selectedClip)]);
  });
  let clipDivLabel = $derived((live.v, RATE_LABELS[clipDivIndex(storedClip, data, editLane)] ?? '1'));
  let swingPct = $derived((live.v, Math.round(laneSwing(data, editLane) * 100)));
  let scaleLabel = $derived(clip.scale ?? 'chromatic');

  // ── THE PLAYHEAD. One engine read per frame, and ONLY while the edited clip
  // is the one sounding in its lane — so a rack at rest does no work here and
  // the panel renders identically on a frozen graph. `curStep` is reset to -1
  // the moment the clip stops, or the column would stay lit where it stopped.
  let curStep = $state(-1);
  let clipIsSounding = $derived((live.v, lanePlaying(data, editLane) === editSlot));
  $effect(() => {
    if (!clipIsSounding) {
      curStep = -1;
      return;
    }
    const node = live.n;
    let raf = 0;
    const frame = () => {
      const e = engineCtx.get();
      if (e && node) {
        const cs = e.read(node, `currentStep:${editLane}`);
        if (typeof cs === 'number' && cs !== curStep) curStep = cs;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  });

  let menu = $state<ClipplayerMenuAt | null>(null);
  /** RIGHT-CLICK a note cell → the shared clip menu, NOTE-scoped. REFUSES on a
   *  cell that holds no note — the card's `openProbMenu` guard (`noteCovering`),
   *  mirrored verbatim: a note-scoped menu on an empty cell would offer
   *  probability rows for a note that does not exist. A PENDING slot has no
   *  stored clip at all, so it refuses everywhere. preventDefault still runs
   *  first, exactly as on the card, so the refusal does not fall through to the
   *  node's "Module actions" menu. */
  function openNoteMenu(e: MouseEvent, step: number, displayRow: number) {
    e.preventDefault();
    e.stopPropagation();
    if (!storedClip) return;
    const midi = midiForDisplayRow(storedClip, displayRow);
    if (!noteCovering(storedClip, step, midi)) return;
    menu = { kind: 'note', x: e.clientX, y: e.clientY, idx: selectedClip, step, midi, row: displayRow };
  }

  /** Every edit gesture in this band goes through here first: an empty slot is
   *  CREATED on the first edit, exactly as double-clicking its pad would have.
   *  Never called from a `$derived` or an `$effect` — only from a click. */
  function ensureThenEdit(edit: () => void) {
    if (pending) ensureClipplayerClip(nodeId, selectedClip);
    edit();
  }

  function cellTitle(c: NoteClipRecord, step: number, midi: number): string {
    const base =
      'Click: note on/off (Shift-click: cycle velocity) · Right-click: note probability (colour = purple ∝ probability, white = 100%), pitch probability, skip every — plus copy / paste / clear for the whole clip';
    const pp = noteCellPitchProb(c, step, midi);
    return pp > 0 ? `${base} — PITCH PROBABILITY ${pitchProbLabel(pp)} (dashed border)` : base;
  }
</script>

<div class="editor" class:pending data-testid="clipplayer-face-editor" data-pending={pending ? '1' : '0'}>
    <!-- THE CLIP HEAD. Every button below shows its OWN current value as its
         caption; the clip's identity (channel, slot, root, painted range) is on
         the group's accessible name instead of a resting readout row. -->
    <div
      class="head"
      role="group"
      aria-label={`channel ${editLane + 1} slot ${editSlot + 1}, root ${noteNameForMidi(
        clip.root,
      )}, showing ${noteNameForMidi(midiForDisplayRow(clip, editRows - 1))} to ${noteNameForMidi(
        midiForDisplayRow(clip, 0),
      )}`}
    >
      <button
        class="tag"
        title="Cycle this clip's scale — the note rows are its degrees"
        data-testid={`clipplayer-face-scale-${nodeId}`}
        onclick={() => ensureThenEdit(() => cycleClipplayerClipScale(nodeId, selectedClip))}>{scaleLabel}</button
      >
      <button
        class="tag"
        title={`Cycle this clip's length in steps (now ${clip.lengthSteps})`}
        data-testid={`clipplayer-face-length-${nodeId}`}
        onclick={() => ensureThenEdit(() => cycleClipplayerClipLength(nodeId, selectedClip))}>{clip.lengthSteps}st</button
      >
      <button
        class="tag"
        title="Clear this clip — empties its notes AND its recorded automation, keeping the clip. Undoable."
        aria-label="empty this clip"
        disabled={pending}
        data-testid="clipplayer-clear"
        onclick={() => emptyClipplayerClip(nodeId, selectedClip)}>⌫</button
      >
      {#if editorHasAuto}
        <button
          class="tag auto"
          title="Clear THIS clip's recorded automation (keeps the notes) — undoable"
          data-testid={`clipplayer-clear-auto-${nodeId}`}
          onclick={() => clearClipAutomation(nodeId, selectedClip)}>CLR AUTO</button
        >
      {/if}
    </div>

    <!-- CLIP OPS — DOUBLE, per-clip DIV, per-lane SWING ±, the VEL modifier and
         the custom-scale apply. All reuse the same helpers the Launchpad does. -->
    <div class="clip-ops" data-testid={`clipplayer-clip-ops-${nodeId}`}>
      <button
        class="op"
        title="DOUBLE — copy the clip's notes into a clip of twice the length"
        data-testid={`clipplayer-double-${nodeId}`}
        onclick={() => ensureThenEdit(() => doubleClipplayerClip(nodeId, selectedClip))}>×2</button
      >
      <button
        class="op"
        title={`Clip-Div — this clip's own division (${clipDivLabel}), overrides the lane rate; latched at the loop boundary`}
        data-testid={`clipplayer-clipdiv-${nodeId}`}
        onclick={() => ensureThenEdit(() => cycleClipplayerClipDiv(nodeId, selectedClip))}>DIV {clipDivLabel}</button
      >
      <span class="op-swing" title={`Swing this lane (odd steps pushed late) — ${swingPct}%`}>
        <button
          aria-label="swing down"
          data-testid={`clipplayer-swing-down-${nodeId}`}
          onclick={() => nudgeClipplayerLaneSwing(nodeId, selectedClip, -1)}>−</button
        >
        <span
          class="swing-val"
          class:on={!isSwingCentered(laneSwing(data, editLane))}
          data-testid={`clipplayer-swing-${nodeId}`}>SW {swingPct}</span
        >
        <button
          aria-label="swing up"
          data-testid={`clipplayer-swing-up-${nodeId}`}
          onclick={() => nudgeClipplayerLaneSwing(nodeId, selectedClip, 1)}>+</button
        >
      </span>
      <button
        class="op"
        class:on={velMode}
        aria-pressed={velMode}
        title="VELOCITY mode — while on, clicking a cell cycles its velocity instead of toggling the note. Shift-clicking a cell does the same for one click; this LATCHES it, standing in for the card's held-Shift, which a faceplate has no keyboard handler for."
        data-testid={`clipplayer-velmode-${nodeId}`}
        onclick={() => (velMode = !velMode)}>VEL</button
      >
      <button
        class="op"
        class:on={pickingScale}
        aria-pressed={pickingScale}
        title="CUSTOM SCALE picker — reveal a checkbox per row to choose this lane's note set. Your screen only: the picker's open state is never shared or saved."
        data-testid={`clipplayer-customscale-${nodeId}`}
        onclick={() => (pickingScale = !pickingScale)}>SCALE…</button
      >
      <button
        class="op op-scale"
        class:on={customScaleOn}
        disabled={!customScaleOn && customScaleNotes.length === 0}
        aria-pressed={customScaleOn}
        title={customScaleOn
          ? `Remove custom scale — unhide every row (the ${customScaleNotes.length}-note set is kept, so re-applying is one click)`
          : customScaleNotes.length === 0
            ? 'Apply custom scale — check one or more rows in the CUSTOM SCALE picker first'
            : `Apply custom scale — show ONLY the ${customScaleNotes.length} checked row(s) on this lane (face + Push/Launchpad). Hidden rows keep their notes and keep playing.`}
        data-testid={`clipplayer-customscale-apply-${nodeId}`}
        onclick={() => {
          const next = !customScaleOn;
          setClipplayerCustomScaleOn(nodeId, editLane, next);
          if (next) pickingScale = false;
        }}>{customScaleOn ? 'REMOVE SCALE' : 'APPLY SCALE'}</button
      >
    </div>

    <!-- The note-row colour KEY: which rows are C and which are F. Static
         captions over static swatches — a legend, not a readout. -->
    <div
      class="noterow-legend"
      aria-label="note-row colour key: c row, f row, other rows"
      data-testid="clipplayer-noterow-legend"
    >
      <span class="lg-row"><span class="lg-lbl">c</span><span class="lg-sw c" aria-hidden="true"></span></span>
      <span class="lg-row"><span class="lg-lbl">f</span><span class="lg-sw f" aria-hidden="true"></span></span>
      <span class="lg-row"><span class="lg-lbl">other</span><span class="lg-sw o" aria-hidden="true"></span></span>
    </div>

    <div class="roll-scroll">
      <div class="piano-roll" class:vel-mode={velMode} data-testid="clipplayer-pianoroll">
        {#each Array(editRows) as _r, row (row)}
          <div class="pr-row">
            {#if pickingScale}
              {@const rowMidi = midiForDisplayRow(clip, row)}
              <label class="scale-pick" title={`Include ${noteNameForMidi(rowMidi)} in this lane's custom scale`}>
                <input
                  type="checkbox"
                  checked={customScaleNotes.includes(rowMidi)}
                  onchange={() => toggleClipplayerScaleRow(nodeId, editLane, rowMidi)}
                  aria-label={`custom scale row ${noteNameForMidi(rowMidi)}`}
                  data-testid={`clipplayer-scalerow-${nodeId}-${rowMidi}`}
                />
                <span class="sp-lbl">{noteNameForMidi(rowMidi)}</span>
              </label>
            {/if}
            {#each Array(editCols) as _c, step (step)}
              {@const midi = midiForDisplayRow(clip, row)}
              {@const fill = noteCellFill(clip, step, midi)}
              <button
                class="cell"
                class:note={fill !== ''}
                class:unstable={noteCellPitchUnstable(clip, step, midi)}
                class:playhead={step === curStep}
                class:beat={step % 4 === 0}
                class:crow={midi % 12 === 0}
                class:frow={midi % 12 === 5}
                style={fill ? `background:${fill}` : undefined}
                data-step={step}
                data-row={row}
                aria-label={`step ${step} row ${row}`}
                title={cellTitle(clip, step, midi)}
                data-testid={`clipplayer-cell-${row}-${step}`}
                onclick={(e) =>
                  ensureThenEdit(() =>
                    velMode || e.shiftKey
                      ? cycleClipplayerNoteVelocity(nodeId, selectedClip, step, midi)
                      : toggleClipplayerNote(nodeId, selectedClip, step, midi),
                  )}
                oncontextmenu={(e) => openNoteMenu(e, step, row)}
              ></button>
            {/each}
          </div>
        {/each}
      </div>
    </div>

    <!-- Launch the clip you are editing without leaving the editor. -->
    <div class="editor-foot">
      <button
        class="launch now"
        class:on={clipIsSounding}
        title="Jump into this clip NOW (immediate — ignores QNT)"
        disabled={pending}
        data-testid="clipplayer-edit-now"
        onclick={() => queueClipplayerLane(nodeId, editLane, editSlot, true)}>NOW</button
      >
      <button
        class="launch queue"
        class:armed={laneQueued(data, editLane) === editSlot}
        title="Queue this clip (drops in on the lane's next loop boundary)"
        disabled={pending}
        data-testid="clipplayer-edit-queue"
        onclick={() => queueClipplayerLane(nodeId, editLane, editSlot, false)}>QUEUE</button
      >
    </div>
</div>

<ClipplayerClipMenu {nodeId} at={menu} onclose={() => (menu = null)} />

<style>
  .editor {
    display: grid;
    gap: 5px;
    width: 100%;
  }
  /* A slot with NO clip yet draws its grid at reduced contrast — the same
     information the launch grid's empty pad carries, said once more where the
     writing happens. The first note commits the clip and the dimming lifts. */
  .editor.pending .piano-roll {
    opacity: 0.62;
  }

  .head,
  .clip-ops {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
  }
  .tag,
  .op,
  .op-swing > button {
    height: 16px;
    padding: 0 5px;
    font-size: 9px;
    line-height: 1;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: rgb(255 255 255 / 0.42);
    background: rgb(255 255 255 / 0.05);
    border: 1px solid rgb(255 255 255 / 0.1);
    border-radius: 2px;
    cursor: pointer;
  }
  .tag:hover,
  .op:hover,
  .op-swing > button:hover {
    color: #fff;
  }
  .op.on,
  .tag.auto {
    color: #fff;
    border-color: var(--domain, #4dd6c1);
    background: color-mix(in srgb, var(--domain, #4dd6c1) 24%, transparent);
  }
  .op:disabled {
    color: rgb(255 255 255 / 0.2);
    cursor: default;
  }
  .op-swing {
    display: inline-flex;
    align-items: center;
    gap: 2px;
  }
  .swing-val {
    font-size: 9px;
    color: rgb(255 255 255 / 0.42);
    font-variant-numeric: tabular-nums;
  }
  .swing-val.on {
    color: var(--domain, #4dd6c1);
  }

  .noterow-legend {
    display: flex;
    gap: 8px;
    font-size: 9px;
    color: rgb(255 255 255 / 0.42);
  }
  .lg-row {
    display: inline-flex;
    align-items: center;
    gap: 3px;
  }
  .lg-sw {
    width: 10px;
    height: 8px;
    border-radius: 1px;
    display: inline-block;
  }
  /* The EXACT grid colours the roll paints, so the key cannot drift from it. */
  .lg-sw.c {
    background: #2e343c;
  }
  .lg-sw.f {
    background: #262626;
  }
  .lg-sw.o {
    background: #161616;
  }

  /* THE ONE SCROLLPORT. The card GREW to fit a 128-step clip (up to ~2,200 px);
     a dock band cannot, so the roll scrolls INSIDE its own box rather than
     making the faceplate scroll horizontally. Every row and every step is still
     rendered — nothing is paged away. */
  .roll-scroll {
    max-width: 100%;
    max-height: 260px;
    overflow: auto;
  }
  .piano-roll {
    display: grid;
    gap: 2px;
    width: max-content;
  }
  .pr-row {
    display: flex;
    gap: 2px;
  }
  .cell {
    width: 15px;
    height: 13px;
    flex: 0 0 auto;
    padding: 0;
    border: 1px solid rgb(255 255 255 / 0.06);
    border-radius: 2px;
    background: #161616;
    cursor: pointer;
  }
  .cell.beat {
    border-left-color: rgb(255 255 255 / 0.16);
  }
  .cell.crow {
    background: #2e343c;
  }
  .cell.frow {
    background: #262626;
  }
  /* PITCH PROBABILITY is a SHAPE, not a third colour: the cell already blends
     firing probability and play-every, and a third hue at 15×13 px is
     unreadable. The magnitude is in the tooltip and the menu's checkmark. */
  .cell.unstable {
    border-style: dashed;
  }
  .cell.playhead {
    background: rgba(108, 170, 255, 0.22);
    border-color: var(--accent, #6cf);
  }
  .cell.note.playhead {
    border-color: var(--accent, #6cf);
  }
  .vel-mode .cell {
    cursor: ns-resize;
  }

  .scale-pick {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    width: 44px;
    flex: 0 0 auto;
    font-size: 8px;
    color: rgb(255 255 255 / 0.42);
  }
  .scale-pick input {
    margin: 0;
  }
  .sp-lbl {
    font-variant-numeric: tabular-nums;
  }

  .editor-foot {
    display: flex;
    gap: 4px;
  }
  .launch {
    height: 16px;
    padding: 0 8px;
    font-size: 9px;
    letter-spacing: 0.06em;
    color: rgb(255 255 255 / 0.42);
    background: rgb(255 255 255 / 0.05);
    border: 1px solid rgb(255 255 255 / 0.1);
    border-radius: 2px;
    cursor: pointer;
  }
  .launch:hover {
    color: #fff;
  }
  .launch.on,
  .launch.armed {
    color: #fff;
    border-color: var(--domain, #4dd6c1);
    background: color-mix(in srgb, var(--domain, #4dd6c1) 26%, transparent);
  }
</style>

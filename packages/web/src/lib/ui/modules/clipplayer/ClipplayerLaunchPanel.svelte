<script lang="ts">
  // ClipplayerLaunchPanel — the clip player's SESSION view: the 8×8 launch grid.
  //
  // COLUMNS ARE THE 8 INSTRUMENT LANES, ROWS ARE THE 8 CLIP SLOTS (the scenes),
  // which is the transposed-Launchpad / Ableton-Session convention the card and
  // the hardware already use. The flat storage key is `clipIndex(slot, lane)`.
  //
  // ⚠ WHY A PF-14 PANEL AND NOT A ROW OF CELLS. `kria` is the precedent, stated
  // in its own face: the grid IS the module, everything a player plays lives in
  // `node.data`, and the only two controls the PARAM system knows about here are
  // global playback settings. A launcher whose faceplate paints seven knobs and
  // no pads is not a launcher.
  //
  // ⚠ IT IS THE FIRST BAND OF A TABBED FACE, NOT A `face.hero`, AND THAT IS THE
  // OWNER'S 2026-09-04 P0. A hero is promoted OUT of its band and painted above
  // every tab panel, so a hero grid cannot be hidden — and the whole instruction
  // was "when we double click on a grid cell … we do not see the grid". This
  // panel is therefore an ordinary rank-8 panel on the `session` page, which is
  // the face's FIRST page and so its default tab: what a freshly opened
  // faceplate paints is unchanged. See the def's face block.
  //
  // ⚠ THE PAD GEOMETRY IS PIXEL-FROZEN, AND IT IS NOT A STYLE CHOICE. 28×28 with
  // a 3 px gap, and the scene column is `position: absolute` OUTSIDE the row's
  // flex, exactly as the card has it — so adding or removing a scene control can
  // never shift a pad and the VRT baseline stays deterministic. The card's own
  // comment records that this was learned the hard way.
  //
  // ⚠ NO `control-<paramId>` TESTID ANYWHERE (shell-cells panel rule 1): every
  // affordance here writes `node.data`, not a ParamDef.

  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import type { ModuleNode } from '$lib/graph/types';
  import {
    CLIP_LANES,
    CLIP_SLOTS,
    laneOf,
    slotOf,
    type ClipPlayerData,
  } from '$lib/audio/modules/clip-types';
  import {
    clipplayerLaneViews,
    clipplayerPadViews,
    type ClipplayerMenuAt,
  } from './clipplayer-face-model';
  import {
    ensureClipplayerClip,
    launchClipplayerPad,
    launchClipplayerScene,
    setClipplayerLaneColor,
    toggleClipplayerLaneRecArm,
    toggleClipplayerLaneRecMode,
  } from './clipplayer-face-actions';
  import {
    clipplayerNowSticky,
    clipplayerSelectClip,
    clipplayerSelectLaneSlot,
    clipplayerSetNowSticky,
  } from './clipplayer-face-selection.svelte';
  import { requestFaceTab } from '$lib/ui/workflow/face-tab-request.svelte';
  import ClipplayerClipMenu from './ClipplayerClipMenu.svelte';

  interface Props {
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  /** ⚠ THE VERSION IS CARRIED IN THE RESULT (the ModuleShell `liveCell`
   *  pattern). `patch.nodes[id]` is a stable SyncedStore proxy, so a `$derived`
   *  that bumps on `nodeVersion(id)` and returns it BARE is `===` to its
   *  previous value and the whole grid freezes at first render — the
   *  proxy-identity trap this repo has shipped more than once. */
  let live = $derived.by(() => ({
    v: nodeVersion(nodeId),
    d: (patch.nodes[nodeId] as ModuleNode | undefined)?.data as ClipPlayerData | undefined,
  }));

  let pads = $derived(clipplayerPadViews(live.d));
  let lanes = $derived(clipplayerLaneViews(live.d));
  /** Pads indexed by `[slot][lane]` for the row-major render. */
  let rows = $derived(
    Array.from({ length: CLIP_SLOTS }, (_, slot) =>
      Array.from({ length: CLIP_LANES }, (_, lane) => pads[lane * CLIP_SLOTS + slot]!),
    ),
  );

  let menu = $state<ClipplayerMenuAt | null>(null);

  /** STICKY NOW — while on, a plain pad click launches IMMEDIATELY, ignoring
   *  QNT, exactly as a shift-click does.
   *
   *  ⚠ IT IS NODE-KEYED RATHER THAN COMPONENT STATE, and the scenes band is
   *  why. This panel is not the only cell that launches: `ClipplayerScenePanel`
   *  is a separate PF-14 cell whose ▶ calls the same `launchClipplayerScene`,
   *  and the legacy card has ONE `nowSticky` governing pads and scenes alike.
   *  Held here, the modifier reached the pads and not the scenes band — two
   *  launch affordances on one faceplate disagreeing about what NOW means.
   *  The registry lives in `clipplayer-face-selection.svelte.ts`, which already
   *  existed to carry the clip selection across the same two mounts.
   *
   *  Still view-local and never synced: it is a performance modifier, not patch
   *  content, and must not reach a collaborator's screen. */
  let nowSticky = $derived(clipplayerNowSticky(nodeId));

  // Single-click launches; double-click opens the editor instead. The card's
  // 220 ms debounce, verbatim — without it every double-click also fires a
  // launch on its way to the editor.
  let clickTimer: ReturnType<typeof setTimeout> | null = null;
  function onPadClick(index: number, ev: MouseEvent) {
    const now = ev.shiftKey || nowSticky;
    // CLAUSE 2 — a plain click also aims this lane's RECORD button at this pad.
    // Immediate (not inside the double-click timer) so the target moves the
    // instant you touch a pad, and separate from the editor selection so it
    // neither creates a clip nor navigates away from the grid.
    clipplayerSelectLaneSlot(nodeId, laneOf(index), slotOf(index));
    if (clickTimer) clearTimeout(clickTimer);
    clickTimer = setTimeout(() => {
      clickTimer = null;
      launchClipplayerPad(nodeId, index, now);
    }, 220);
  }
  /**
   * DOUBLE-CLICK = OPEN THIS CLIP IN THE EDITOR, and "open" means NAVIGATE —
   * the third line is the P0 the two before it were missing.
   *
   * ⚠ SELECTING WITHOUT NAVIGATING IS THE DEFECT THE OWNER REPORTED (2026-09-04:
   * "we do NOT want the clip viewer always visible. we want to see it when we
   * double click on a grid cell, at which point, we do not see the grid").
   * `ensureClip` + `select` are the card's first two statements; its third is
   * `cardView = 'clip'`, and the face had no equivalent because it had no views
   * — the grid and the piano roll were two bands of one scrolling column, both
   * on screen always. `face.tabbed` gives the face the card's views back, and
   * this call is the card's third statement in the face's vocabulary.
   *
   * ⚠ THE PAGE ID IS THE `face.pages` ID, not a testid and not a label. It is
   * resolved against the LIVE tab roster by `activeDockTab`, which falls back to
   * the first tab if it no longer exists — so a re-paged face degrades to the
   * grid rather than to a blank plate.
   */
  function onPadDblClick(index: number) {
    if (clickTimer) {
      clearTimeout(clickTimer);
      clickTimer = null;
    }
    ensureClipplayerClip(nodeId, index);
    clipplayerSelectClip(nodeId, index);
    requestFaceTab(nodeId, 'editor');
  }
  $effect(() => () => {
    if (clickTimer) clearTimeout(clickTimer);
  });

  function openPadMenu(e: MouseEvent, idx: number) {
    e.preventDefault();
    e.stopPropagation(); // don't also open the node's "Module actions" menu
    menu = { kind: 'clip', x: e.clientX, y: e.clientY, idx };
  }
</script>

<div class="launch" data-testid="clipplayer-face-grid">
  <!-- CHANNEL HEADER — one COLOUR swatch per lane. It is the only writer in the
       app of `node.data.laneColor`, which the shell reads live to paint the
       already-shipped mixmstrs face's channel accents: dropping it would freeze
       every channel accent in the rack at its default with no gate able to see
       it. So it is on the hero, not in a body. -->
  <div class="head" role="row">
    {#each lanes as l (l.lane)}
      <span class="head-cell" style={`--lane-color:${l.color}`}>
        <input
          class="lane-color"
          type="color"
          value={l.color}
          title={`Channel ${l.lane + 1} clip colour — tints its whole column, its Launchpad pads and every mixmstrs channel accent bound to this lane`}
          aria-label={`channel ${l.lane + 1} colour`}
          data-lane={l.lane}
          data-testid={`clipplayer-color-${l.lane}`}
          oninput={(e) => setClipplayerLaneColor(nodeId, l.lane, e.currentTarget.value)}
        />
        <!-- ⚠ THE RECORD CONTROLS SIT IN THE LANE'S OWN HEADER, DIRECTLY OVER
             ITS COLUMN, and both halves of that are owner rulings. The control
             must be "reachable from the launcher view, adjacent to the lane,
             never buried in a tab" — so it is here rather than on the
             `channels` band. And lane N's controls must read as ONE UNIT
             ("lane 1 should always be for all things lane 1") — so the arm and
             its mode stack vertically inside one lane cell, instead of forming
             two eight-wide rows of like controls. That row-of-eight shape is
             exactly what the owner rejected on the mixer. -->
        <span class="rec-strip">
          <button
            class="rec-arm"
            class:on={l.recArmed}
            class:live={l.recPhase === 'recording' || l.recPhase === 'stopping'}
            aria-pressed={l.recArmed}
            title={`Record into channel ${l.lane + 1}'s SELECTED clip — ${
              l.recMode === 'endless'
                ? 'ENDLESS: keeps recording until you tap this again or the transport stops, always ending at the end of the current loop'
                : 'CLIP: records exactly one loop, then stops'
            }. Can be armed while stopped — recording starts when the transport plays.`}
            aria-label={`channel ${l.lane + 1} audio record`}
            data-lane={l.lane}
            data-rec-phase={l.recPhase}
            data-testid={`clipplayer-rec-arm-${l.lane}`}
            onclick={() => toggleClipplayerLaneRecArm(nodeId, l.lane)}
          ></button>
          <button
            class="rec-mode"
            class:endless={l.recMode === 'endless'}
            title={`Channel ${l.lane + 1} record length — CLIP records exactly one loop; ENDLESS records whole loops until you tap record again or the transport stops`}
            aria-label={`channel ${l.lane + 1} record mode ${l.recMode === 'endless' ? 'endless' : 'clip'}`}
            data-lane={l.lane}
            data-rec-mode={l.recMode}
            data-testid={`clipplayer-rec-mode-${l.lane}`}
            onclick={() => toggleClipplayerLaneRecMode(nodeId, l.lane)}
            >{l.recMode === 'endless' ? '\u221e' : '1'}</button
          >
        </span>
      </span>
    {/each}
  </div>

  <div class="grid" role="grid" aria-label="clip launch grid">
    {#each rows as row, slot (slot)}
      <div class="grid-row" role="row">
        <!-- SCENE LAUNCH — fire this slot across every content lane. ABSOLUTELY
             POSITIONED outside the row's flex so the fixed-integer pad geometry
             never shifts (VRT determinism). -->
        <button
          class="scene-launch"
          title={`Launch scene ${slot + 1} (this slot across all channels)${nowSticky ? ' — NOW' : ''}`}
          aria-label={`launch scene ${slot + 1}`}
          data-slot={slot}
          data-testid={`clipplayer-scene-launch-${slot}`}
          onclick={(e) => launchClipplayerScene(nodeId, slot, e.shiftKey || nowSticky)}>▶</button
        >
        {#each row as pad (pad.index)}
          <button
            class="pad {pad.state}"
            class:has-audio={pad.hasAudio}
            role="gridcell"
            style={`--lane-color:${lanes[pad.lane]!.color}`}
            aria-label={`lane ${pad.lane + 1} slot ${pad.slot + 1} ${pad.state}${
              pad.hasAuto ? ' (has automation)' : ''
            }${pad.hasAudio ? ' (holds recorded audio)' : ''}`}
            title={pad.hasClip
              ? 'Click: launch/stop · Double-click: edit · Right-click: note probability, pitch probability, skip every, copy / paste / clear'
              : 'Click: launch/stop · Double-click: edit · Right-click: paste a copied clip here'}
            data-clip={pad.index}
            data-lane={pad.lane}
            data-slot={pad.slot}
            data-state={pad.state}
            data-auto={pad.hasAuto ? '1' : undefined}
            data-audio={pad.hasAudio ? '1' : undefined}
            data-testid={`clipplayer-pad-${pad.index}`}
            onclick={(e) => onPadClick(pad.index, e)}
            ondblclick={() => onPadDblClick(pad.index)}
            oncontextmenu={(e) => openPadMenu(e, pad.index)}
            >{#if pad.hasAuto}<span class="auto-dot" aria-hidden="true"></span>{/if}</button
          >
        {/each}
      </div>
    {/each}
  </div>

  <div class="foot">
    <button
      class="now"
      class:on={nowSticky}
      aria-pressed={nowSticky}
      title={nowSticky
        ? 'NOW on — launches drop immediately (ignore QNT)'
        : 'NOW off — launches follow QNT (shift-click a pad for a one-off immediate launch)'}
      data-testid={`clipplayer-now-${nodeId}`}
      onclick={() => clipplayerSetNowSticky(nodeId, !nowSticky)}>NOW</button
    >
  </div>
</div>

<ClipplayerClipMenu {nodeId} at={menu} onclose={() => (menu = null)} />

<style>
  .launch {
    display: grid;
    gap: 4px;
    justify-items: start;
  }
  /* The header aligns to the pad columns below: same 28 px track, same 3 px gap,
     and the same 14 px left inset the scene column occupies. */
  .head {
    display: grid;
    grid-template-columns: repeat(8, 28px);
    gap: 3px;
    margin-left: 14px;
  }
  .head-cell {
    display: block;
    width: 28px;
  }
  .lane-color {
    display: block;
    width: 28px;
    height: 12px;
    padding: 0;
    border: 1px solid rgb(255 255 255 / 0.16);
    border-radius: 2px;
    background: var(--lane-color);
    cursor: pointer;
  }
  /* Chrome/Safari draw their own swatch chrome inside the control; strip it so
     the row reads as eight flat colour chips. */
  .lane-color::-webkit-color-swatch-wrapper {
    padding: 0;
  }
  /* THE PER-LANE RECORD STRIP — arm over mode, inside the lane's own header
     cell, so one lane's controls are one visual unit sitting on its column. */
  .rec-strip {
    display: flex;
    gap: 1px;
    width: 28px;
    margin-top: 2px;
  }
  .rec-arm,
  .rec-mode {
    padding: 0;
    height: 10px;
    border: 1px solid rgb(255 255 255 / 0.16);
    border-radius: 2px;
    background: rgb(255 255 255 / 0.04);
    color: rgb(255 255 255 / 0.55);
    font-size: 7px;
    line-height: 1;
    cursor: pointer;
  }
  .rec-arm {
    flex: 1 1 auto;
  }
  .rec-mode {
    flex: 0 0 10px;
    font-variant-numeric: tabular-nums;
  }
  /* ARMED is a steady red; RECORDING pulses. ⚠ A DIFFERENT RED FROM THE
     AUTOMATION ARM (`ClipplayerArmPanel` uses hsl(0 62% 38%)) on purpose — two
     recorders that look identical and are not is the exact confusion the
     separate fields exist to prevent. */
  .rec-arm.on {
    background: #c0304a;
    border-color: #e2536c;
  }
  .rec-arm.live {
    background: #ff3b30;
    border-color: #fff;
    animation: clipplayer-pad-blink 0.5s steps(2, end) infinite;
  }
  .rec-mode.endless {
    color: #fff;
    border-color: rgb(255 255 255 / 0.4);
  }
  .lane-color::-webkit-color-swatch {
    border: none;
    border-radius: 1px;
  }

  .grid {
    display: grid;
    gap: 3px;
  }
  /* `position: relative` + an ABSOLUTE scene column is what keeps the pad row a
     pure 8×28 px track — the card's rule, carried over. */
  .grid-row {
    position: relative;
    display: grid;
    grid-template-columns: repeat(8, 28px);
    gap: 3px;
    margin-left: 14px;
  }
  .scene-launch {
    position: absolute;
    right: 100%;
    top: 0;
    bottom: 0;
    width: 12px;
    display: grid;
    place-items: center;
    padding: 0;
    font-size: 8px;
    line-height: 1;
    color: rgb(255 255 255 / 0.42);
    background: rgb(255 255 255 / 0.04);
    border: 1px solid rgb(255 255 255 / 0.08);
    border-radius: 2px;
    cursor: pointer;
  }
  .scene-launch:hover {
    color: #fff;
    background: rgb(255 255 255 / 0.12);
  }

  .pad {
    position: relative;
    width: 28px;
    height: 28px;
    padding: 0;
    border-radius: 3px;
    border: 1px solid rgb(255 255 255 / 0.1);
    background: rgb(255 255 255 / 0.04);
    cursor: pointer;
  }
  .pad.loaded {
    background: color-mix(in srgb, var(--lane-color) 38%, transparent);
    border-color: color-mix(in srgb, var(--lane-color) 60%, transparent);
  }
  /* CLAUSE 7 — A PURPLE BORDER MARKS A CLIP HOLDING RECORDED AUDIO.
     ⚠ AN OVERLAY, NOT A STATE. It is declared AFTER `.loaded` but BEFORE
     `playing`/`queued`, and re-asserted below them with the same specificity
     trick they use, because "holds a take" is orthogonal to "what is this pad
     doing right now": a recorded clip must keep its border while it plays,
     which is exactly when a player most needs to see it. Painting it as a
     `clipPadState` rung instead would have lost it the moment the clip
     sounded, since `playing` and `queued` outrank `loaded`. */
  .pad.has-audio {
    border-color: #a855f7;
  }
  .pad.playing {
    background: var(--lane-color);
    border-color: #fff;
  }
  /* QUEUED WINS OVER PLAYING and it BLINKS, because "a change is coming" is the
     single most important thing this grid can say. */
  .pad.queued {
    background: color-mix(in srgb, var(--lane-color) 55%, transparent);
    border-color: #fff;
    animation: clipplayer-pad-blink 0.5s steps(2, end) infinite;
  }
  /* …and the purple survives PLAYING and QUEUED — see the note on
     `.pad.has-audio`. It deliberately does NOT override the rec-* states: a pad
     mid-take is showing something more urgent than what it already holds. */
  .pad.has-audio.playing,
  .pad.has-audio.queued,
  .pad.has-audio.loaded {
    border-color: #a855f7;
  }
  @keyframes clipplayer-pad-blink {
    0% {
      opacity: 1;
    }
    100% {
      opacity: 0.45;
    }
  }
  /* AUDIO CLIP-RECORD states (shared clipPadState vocabulary, spec §4.9) —
     the same pictures the legacy card paints: rec-armed = hollow ring in the
     lane colour, slow pulse ("reserved, not yet content"); rec-active =
     filled RED (the product's record colour) while the take captures. */
  .pad.rec-armed {
    background: transparent;
    border-color: var(--lane-color);
    box-shadow: inset 0 0 0 1px var(--lane-color);
    animation: clipplayer-pad-blink 1.2s steps(2, end) infinite;
  }
  .pad.rec-active {
    background: #ff3b30;
    border-color: #ff3b30;
    box-shadow: 0 0 6px rgb(255 59 48 / 0.7);
  }
  @media (prefers-reduced-motion: reduce) {
    .pad.queued,
    .pad.rec-armed {
      animation: none;
      opacity: 0.7;
    }
  }
  .foot {
    display: flex;
    margin-left: 14px;
  }
  .now {
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
  .now:hover {
    color: #fff;
  }
  .now.on {
    color: #fff;
    border-color: var(--domain, #4dd6c1);
    background: color-mix(in srgb, var(--domain, #4dd6c1) 26%, transparent);
  }

  .auto-dot {
    position: absolute;
    right: 2px;
    bottom: 2px;
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: #4dd6c1;
  }
</style>

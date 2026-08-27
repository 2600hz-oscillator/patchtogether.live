<script lang="ts">
  // ScoreStaffPanel — the STAFF, as a PF-14 panel cell.
  //
  // ⚠ WHY A PANEL AND NOT A SHELL EXTENSION. `fullViewBody` was the first
  // candidate — it is wired, it takes a nodeId, it paints full-width at the head
  // of the dock — and it loses on two measurements. It requires no PROBE, so no
  // gate proves the staff is clickable (a `ShellPanelCell.probe` is non-optional
  // and `shell-cells.test.ts` sweeps every promoted face for an inert cell); and
  // it satisfies no RANKED KEY, while `score-note-{n}` is a declared
  // `controlFamily` that `module-face-lint`'s completeness gate requires a cell
  // for. A panel answers both. `editorSurface` would fit the description of a
  // notation editor exactly and is still wrong: it is DECLARED and UNWIRED, and
  // a face PR is not the place to load a third platform slot.
  //
  // ⚠ IT IS THE THIRD RENDERER OF ONE GRID, AND THE GRID IS IMPORTED. The engine
  // (`score.ts`), the legacy card and this panel all draw and play the same
  // document. `score-data.ts` records what happened the last time the placement
  // grid and the playback grid were derived separately: `triplet8th` is 4 ticks
  // wide against a scheduler that only visited multiples of 3, so FOUR of twelve
  // triplet positions per bar sounded, from the module's first commit, and
  // nothing looked wrong. Every constant here comes from `score-data.ts`
  // (the grid) or `score-layout.ts` (the pixels); this file re-types none.
  //
  // ⚠ THE FACE IS SELECTION-BASED, THE CARD IS MODAL, AND THAT IS THE DESIGN.
  // The card's fifteen toolbar buttons arm fifteen modes; a mode cannot be a
  // face cell without four of five cells lying about a single-valued state. Here
  // a click on empty staff PLACES `data.noteValue`, a click on a note SELECTS
  // it, and a click on the SELECTED note DELETES it. The mark cells in the bands
  // act on that selection — and, with nothing selected, arm what the next click
  // writes, which is what keeps them live on a score that has no notes yet. See
  // `score-cell-actions.ts` for the full argument and `score-writes.ts` for the
  // three live defects it closes as a consequence.
  //
  // ⚠ NO RESTING DERIVED TEXT. Everything this panel paints is the DOCUMENT —
  // the clef, the time signature, the key-signature glyphs, the noteheads, the
  // ties, the dynamics the PLAYER placed, the stop bar. That is content, like
  // the text of a sticky note, not a readout of the module. What is deliberately
  // NOT drawn: bar numbers, a tick ruler, a beat-subdivision comb, a
  // "page 2 of 4" watermark, a tempo marking derived from `bpm`, or a playhead
  // position counter. A real engraver would draw bar numbers; this module never
  // has, and adding them under cover of "it is notation" is how derived chrome
  // gets in wearing the document's clothes. The card's `.page-counter` span
  // (`2 / 4`) is dropped here for exactly that reason — the PAGES selector is
  // the one place the piece's length is named, and two indicators would be a
  // derived restatement of each other whichever one is "allowed".
  //
  // ⚠ NO `control-<paramId>` TESTID (shell-cells rule 1) — everything this panel
  // edits is `node.data`, which is why it is a panel at all.
  //
  // ⚠ SVG, NOT CANVAS, AND THAT IS LOAD-BEARING BEYOND TASTE. The WebGL attest
  // basis is derived from CONTENT, so a panel that acquired a rendering context
  // would enrol this module in it automatically and make every future edit here
  // cost a real-GPU re-attest window. SCORE costs ZERO attest today. Keep it
  // vector markup.

  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import { onMeterFrame } from '$lib/ui/meter-frame';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import {
    BARS_PER_ROW,
    ROWS_PER_PAGE,
    SMUFL,
    TICKS_PER_BAR,
    tickWidth,
    type NoteDuration,
    type ScoreNote,
    type StopBar,
  } from '$lib/audio/modules/score-data';
  import {
    BAR_W,
    ROW_INNER_W,
    ROW_LEFT_PAD,
    SCORE_HEIGHT,
    SCORE_WIDTH,
    STAFF_LINES,
    STAFF_LINE_GAP,
    STAFF_STEP_PX,
    TICK_PX,
    barLeftX,
    cellFromClient,
    dynamicYForBar,
    noteX,
    noteY,
    pageOf,
    rowTopLineY,
    topLineY,
  } from '$lib/audio/modules/score-layout';
  import {
    addNote,
    deleteNote,
    moveNote,
    readNoteValue,
    readScore,
    readSelectedNoteId,
    selectNote,
    selectOrDeleteNote,
    setStopBar,
    toggleAccidental,
    transposeNote,
  } from '$lib/audio/modules/score-writes';
  import { scoreStaffAriaLabel, noteAriaLabel } from './score-aria';

  const { nodeId }: { nodeId: string } = $props();

  const engineCtx = useEngine();
  // ⚠ EVERY DERIVE THAT READS `node.data` MUST VOID `version` ITSELF, and this
  // is not belt-and-braces. `patch.nodes[id]` is a SyncedStore proxy whose
  // IDENTITY NEVER CHANGES when its contents do, so `$derived(f(node))` has a
  // dependency that never invalidates: the graph is correct, the picture is
  // frozen, and a test reading `node.data` PASSES while the surface shows
  // nothing. Measured here — the staff stayed empty through a seed the same
  // test had already read back off the graph. `nodeVersion(id)` is the
  // observeDeep-driven counter that actually moves, so each derive names it.
  let version = $derived(nodeVersion(nodeId));
  let node = $derived((void version, patch.nodes[nodeId] as ModuleNode | undefined));
  let data = $derived((void version, readScore(node)));
  let selectedId = $derived((void version, readSelectedNoteId(node)));
  let noteValue = $derived<NoteDuration>((void version, readNoteValue(node)));
  let totalPages = $derived(data.pages);

  // ⚠ COMPONENT STATE, NOT `node.data`. `currentPage` is a VIEWPORT position,
  // not a property of the piece: one player looking at page 3 must not scroll
  // everyone else's screen or dirty the patch. `data.pages` (how long the piece
  // is) and `currentPage` (which part I am reading) are different things, and
  // the card already treats them so.
  let currentPage = $state(0);
  $effect(() => {
    if (currentPage >= totalPages) currentPage = Math.max(0, totalPages - 1);
  });

  // ⚠ PER-FRAME INTERACTION STATE STAYS LOCAL TOO. Drag position and the
  // overflow shake would push a Y.Doc update to every collaborator on every
  // pointermove if they lived on the node.
  let svgEl: SVGSVGElement | undefined = $state();
  let dragNoteId: string | null = null;
  let dragStopBar = $state(false);
  let shakeBar = $state<number | null>(null);
  function flashShake(bar: number) {
    shakeBar = bar;
    // pacing: the `.bar-shake` keyframe animation is 0.22s (the `score-shake`
    // rule in this component's own style block, and ScoreCard.svelte's
    // identical one) — this clears the overlay when the animation the product
    // defines has finished.
    //
    // ⚠ A LITERAL STYLE-OPEN TAG IN A COMMENT HERE CLOSES THE SCRIPT AS FAR AS
    // `svelte2tsx` IS CONCERNED, so the rule name is written out instead. The
    // real compiler accepts it and only `task typecheck` reddens, which is
    // exactly the vitest-lenient/svelte-check-strict split.

    setTimeout(() => { shakeBar = null; }, 220);
  }

  // ── the sounding note, from the SHARED frame pump ──────────────────────────
  //
  // ⚠ `onMeterFrame`, NOT A PRIVATE rAF LOOP, and this is strictly cheaper than
  // what the card does. `ScoreCard.svelte` runs an unconditional
  // `requestAnimationFrame` poll of `read('currentNoteId')` whether or not the
  // transport is running and whether or not the card is on screen. The shared
  // ticker visits every subscriber from ONE callback and SKIPS a subscriber
  // whose element is off-screen, which is the render-side analogue of the audio
  // thread's shared scheduler clock — and the reason ~60 independent card rAF
  // loops were coalesced in the first place (they starved the audio render
  // thread into an output-buffer underrun).
  let currentNoteId = $state<string | null>(null);
  $effect(() => {
    if (!svgEl) return;
    const h = onMeterFrame(svgEl, () => {
      const e = engineCtx.get();
      const n = patch.nodes[nodeId] as ModuleNode | undefined;
      if (!e || !n) return;
      const v = e.read(n, 'currentNoteId');
      currentNoteId = typeof v === 'string' ? v : null;
    });
    return () => h.stop();
  });

  function isBarOnPage(bar: number): boolean {
    return pageOf(bar) === currentPage;
  }

  function gotoPage(idx: number) {
    if (idx < 0 || idx >= totalPages) return;
    currentPage = idx;
  }

  // ── pointer ───────────────────────────────────────────────────────────────

  function onPointerDown(ev: PointerEvent) {
    if (!svgEl) return;
    const target = ev.target as Element;
    const noteEl = target.closest('[data-note-id]');
    const noteId = noteEl?.getAttribute('data-note-id') ?? null;
    const stopEl = target.closest('[data-stop-bar]');

    if (stopEl) {
      ev.preventDefault();
      ev.stopPropagation();
      dragStopBar = true;
      svgEl.setPointerCapture(ev.pointerId);
      return;
    }

    if (noteId) {
      ev.preventDefault();
      ev.stopPropagation();
      // ONE gesture, two outcomes: select, or — if it was already selected —
      // delete. This is the pointer route `deleteNote` never had.
      if (selectOrDeleteNote(nodeId, noteId) === 'selected') {
        dragNoteId = noteId;
        svgEl.setPointerCapture(ev.pointerId);
      }
      return;
    }

    ev.preventDefault();
    ev.stopPropagation();
    const cell = cellFromClient(svgEl, ev.clientX, ev.clientY, currentPage, totalPages);
    if (!cell) return;
    const placed = addNote(nodeId, cell.bar, cell.tick, cell.step, noteValue);
    if (placed === null) flashShake(cell.bar);
  }

  function onPointerMove(ev: PointerEvent) {
    if (!svgEl) return;
    if (dragStopBar) {
      const cell = cellFromClient(svgEl, ev.clientX, ev.clientY, currentPage, totalPages);
      if (cell) setStopBar(nodeId, cell.bar, cell.tick);
      return;
    }
    if (!dragNoteId) return;
    const cell = cellFromClient(svgEl, ev.clientX, ev.clientY, currentPage, totalPages);
    if (!cell) return;
    moveNote(nodeId, dragNoteId, cell.bar, cell.tick, cell.step);
  }

  function onPointerUp(ev: PointerEvent) {
    if (svgEl && (dragNoteId || dragStopBar)) {
      try { svgEl.releasePointerCapture(ev.pointerId); } catch { /* noop */ }
    }
    dragNoteId = null;
    dragStopBar = false;
  }

  // ⚠ THE KEY HANDLERS ARE CARRIED OVER VERBATIM AND NOTHING NEW IS DESIGNED
  // FOR THE KEYBOARD. The standing owner ruling is that this app is not
  // keyboard-navigable and that keyboard-a11y is never designed or filed. These
  // exist on the card today and keep working here for anyone who can focus a
  // note; what changed is that every operation they perform now ALSO has a
  // pointer route (delete → click the selection again; transpose → drag;
  // accidental → the ACC cell), because until this PR they were the only route.
  function onKeyDown(ev: KeyboardEvent) {
    if (ev.key === 'Escape') {
      dragNoteId = null;
      selectNote(nodeId, null);
      ev.preventDefault();
      return;
    }
    const noteEl = (ev.target as Element | null)?.closest('[data-note-id]');
    const noteId = noteEl?.getAttribute('data-note-id') ?? selectedId;
    if (!noteId) return;
    if (ev.key === 'Backspace' || ev.key === 'Delete') {
      ev.preventDefault();
      deleteNote(nodeId, noteId);
      return;
    }
    if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
      ev.preventDefault();
      transposeNote(nodeId, noteId, ev.key === 'ArrowUp' ? -1 : 1);
      return;
    }
    if (ev.key === '#') {
      ev.preventDefault();
      toggleAccidental(nodeId, noteId, 'sharp');
      return;
    }
    if (ev.key === 'b') {
      ev.preventDefault();
      toggleAccidental(nodeId, noteId, 'flat');
    }
  }

  // ── render data ───────────────────────────────────────────────────────────

  function noteGlyph(d: NoteDuration): string {
    if (d === 'whole') return SMUFL.noteWhole;
    if (d === 'half') return SMUFL.noteheadHalf;
    return SMUFL.noteheadBlack;
  }
  function flagGlyph(d: NoteDuration): string {
    if (d === 'eighth') return SMUFL.flag8thUp;
    if (d === '16th') return SMUFL.flag16thUp;
    return '';
  }
  function tiePathD(from: ScoreNote, to: ScoreNote): string {
    const ax = noteX(from.bar, from.tick) + 8;
    const ay = noteY(from.bar, from.staffStep);
    const cx = noteX(to.bar, to.tick);
    const cy = noteY(to.bar, to.staffStep);
    const arcUp = (from.staffStep + to.staffStep) / 2 <= 4;
    return `M ${ax} ${ay} Q ${(ax + cx) / 2} ${arcUp ? Math.min(ay, cy) - 12 : Math.max(ay, cy) + 12} ${cx} ${cy}`;
  }

  function keySigGlyphs(rowIdx: number): Array<{ x: number; y: number; glyph: string }> {
    const out: Array<{ x: number; y: number; glyph: string }> = [];
    const top = rowTopLineY(rowIdx);
    const ks = data.keySignature;
    let xCursor = 30;
    if (ks > 0) {
      const sharpStaffStep = [0, 3, -1, 2, 5, 1, 4];
      for (let i = 0; i < Math.min(7, ks); i++) {
        out.push({ x: xCursor, y: top + sharpStaffStep[i] * STAFF_STEP_PX + 4, glyph: SMUFL.accidentalSharp });
        xCursor += 7;
      }
    } else if (ks < 0) {
      const flatStaffStep = [4, 1, 5, 2, 6, 3, 7];
      for (let i = 0; i < Math.min(7, -ks); i++) {
        out.push({ x: xCursor, y: top + flatStaffStep[i] * STAFF_STEP_PX + 3, glyph: SMUFL.accidentalFlat });
        xCursor += 7;
      }
    }
    return out;
  }

  let visibleNotes = $derived(data.notes.filter((n) => isBarOnPage(n.bar)));
  let visibleDynamics = $derived(data.dynamics.filter((d) => isBarOnPage(d.bar)));
  let visibleTies = $derived(
    data.ties.filter((t) => {
      const fromN = data.notes.find((n) => n.id === t.fromNoteId);
      const toN = data.notes.find((n) => n.id === t.toNoteId);
      return !!fromN && !!toN && (isBarOnPage(fromN.bar) || isBarOnPage(toN.bar));
    }),
  );
  let stopBarVisible = $derived.by<StopBar | null>(() => {
    if (!data.stopBar) return null;
    return isBarOnPage(data.stopBar.bar) ? data.stopBar : null;
  });

  // ⚠ WHERE EVERY DELETED NUMBER WENT. The playhead position, the note count,
  // the bar total and the page you are on are all HERE — speakable, assertable
  // and unpainted — which is what every face spec proving this surface tracks
  // the graph reads.
  let staffAria = $derived(
    scoreStaffAriaLabel(data, currentPage, currentNoteId, selectedId),
  );
</script>

<div class="score-panel" data-testid={`score-staff-${nodeId}`}>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions
       — `role="application"` is exactly right for a score editor: this <svg> OWNS its key
       handling, so it MUST be focusable and MUST take pointer + key handlers. Svelte's rules
       do not model `application` as interactive. -->
  <svg
    bind:this={svgEl}
    class="staff"
    width={SCORE_WIDTH}
    height={SCORE_HEIGHT}
    viewBox={`0 0 ${SCORE_WIDTH} ${SCORE_HEIGHT}`}
    role="application"
    tabindex="0"
    aria-label={staffAria}
    data-testid="score-staff-panel"
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onpointercancel={onPointerUp}
    onkeydown={onKeyDown}
  >
    {#each Array(ROWS_PER_PAGE) as _row, rowIdx (rowIdx)}
      {#each Array(STAFF_LINES) as _line, li (li)}
        <line
          class="staff-line"
          x1={ROW_LEFT_PAD - 4}
          x2={ROW_LEFT_PAD + ROW_INNER_W + 4}
          y1={rowTopLineY(rowIdx) + li * STAFF_LINE_GAP}
          y2={rowTopLineY(rowIdx) + li * STAFF_LINE_GAP}
        />
      {/each}
      {#each Array(BARS_PER_ROW + 1) as _bar, bi (bi)}
        <line
          class="bar-line"
          class:end={bi === BARS_PER_ROW}
          x1={ROW_LEFT_PAD + bi * BAR_W}
          x2={ROW_LEFT_PAD + bi * BAR_W}
          y1={rowTopLineY(rowIdx)}
          y2={rowTopLineY(rowIdx) + (STAFF_LINES - 1) * STAFF_LINE_GAP}
        />
      {/each}
      <text class="smufl clef" x={6} y={rowTopLineY(rowIdx) + 25}>{SMUFL.gClef}</text>
      <g class="key-sig" data-testid={`score-key-sig-${nodeId}-${rowIdx}`}>
        {#each keySigGlyphs(rowIdx) as g (g.x + g.glyph + rowIdx)}
          <text class="smufl key-acc" x={g.x} y={g.y}>{g.glyph}</text>
        {/each}
      </g>
      {#if rowIdx === 0}
        <text class="smufl ts" x={48} y={rowTopLineY(0) + 10}>{SMUFL.timeSig4}</text>
        <text class="smufl ts" x={48} y={rowTopLineY(0) + 26}>{SMUFL.timeSig4}</text>
      {/if}
    {/each}

    {#if shakeBar !== null && isBarOnPage(shakeBar)}
      <rect
        class="bar-shake"
        x={barLeftX(shakeBar)}
        y={topLineY(shakeBar) - 4}
        width={BAR_W}
        height={(STAFF_LINES - 1) * STAFF_LINE_GAP + 8}
        data-testid={`score-shake-${nodeId}-${shakeBar}`}
      />
    {/if}

    {#each visibleTies as t (t.id)}
      {@const from = data.notes.find((n) => n.id === t.fromNoteId)}
      {@const to = data.notes.find((n) => n.id === t.toNoteId)}
      {#if from && to && isBarOnPage(from.bar) && isBarOnPage(to.bar)}
        <path
          class="tie"
          d={tiePathD(from, to)}
          data-tie-id={t.id}
          data-testid={`score-tie-${nodeId}-${t.id}`}
          fill="none"
          stroke="var(--cable-pitch)"
          stroke-width="1.5"
        />
      {/if}
    {/each}

    {#if currentNoteId}
      {@const playing = data.notes.find((n) => n.id === currentNoteId)}
      {#if playing && isBarOnPage(playing.bar)}
        <rect
          class="playing-highlight"
          x={noteX(playing.bar, playing.tick) - 6}
          y={noteY(playing.bar, playing.staffStep) - 8}
          width={Math.max(14, tickWidth(playing.duration) * TICK_PX)}
          height={16}
          rx={3}
          data-testid={`score-highlight-${nodeId}`}
        />
      {/if}
    {/if}

    {#each visibleNotes as n (n.id)}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex — the tabindex is LOAD-BEARING: notes are
           the focus targets `onKeyDown` reads back via `closest('[data-note-id]')`. -->
      <g
        class="note"
        class:selected={selectedId === n.id}
        data-note-id={n.id}
        data-testid={`score-note-${nodeId}-${n.id}`}
        data-bar={n.bar}
        data-tick={n.tick}
        data-midi={n.midi}
        data-duration={n.duration}
        data-step={n.staffStep}
        data-selected={selectedId === n.id ? 'true' : 'false'}
        role="img"
        aria-label={noteAriaLabel(n, selectedId === n.id, currentNoteId === n.id)}
        tabindex="0"
      >
        {#if selectedId === n.id}
          <circle
            class="sel-ring"
            cx={noteX(n.bar, n.tick) + 4}
            cy={noteY(n.bar, n.staffStep)}
            r={9}
          />
        {/if}
        {#if n.accidental === 'sharp'}
          <text class="smufl acc" x={noteX(n.bar, n.tick) - 9} y={noteY(n.bar, n.staffStep) + 3}>{SMUFL.accidentalSharp}</text>
        {:else if n.accidental === 'flat'}
          <text class="smufl acc" x={noteX(n.bar, n.tick) - 9} y={noteY(n.bar, n.staffStep) + 3}>{SMUFL.accidentalFlat}</text>
        {:else if n.accidental === 'natural'}
          <text class="smufl acc" x={noteX(n.bar, n.tick) - 9} y={noteY(n.bar, n.staffStep) + 3}>{SMUFL.accidentalNatural}</text>
        {/if}
        <text class="smufl notehead" x={noteX(n.bar, n.tick)} y={noteY(n.bar, n.staffStep) + 4}>{noteGlyph(n.duration)}</text>
        {#if n.duration !== 'whole'}
          <line class="stem"
            x1={noteX(n.bar, n.tick) + 8}
            x2={noteX(n.bar, n.tick) + 8}
            y1={noteY(n.bar, n.staffStep) + 1}
            y2={noteY(n.bar, n.staffStep) - 22} />
        {/if}
        {#if flagGlyph(n.duration)}
          <text class="smufl flag" x={noteX(n.bar, n.tick) + 8} y={noteY(n.bar, n.staffStep) - 22}>{flagGlyph(n.duration)}</text>
        {/if}
      </g>
    {/each}

    {#each visibleDynamics as d (d.id)}
      <text
        class="dynamic"
        x={noteX(d.bar, d.tick)}
        y={dynamicYForBar(d.bar)}
        data-dynamic-id={d.id}
        data-testid={`score-dyn-${nodeId}-${d.id}`}
      >{d.level}</text>
    {/each}

    {#if stopBarVisible}
      {@const sx = noteX(stopBarVisible.bar, Math.min(TICKS_PER_BAR - 0.001, Math.max(0, stopBarVisible.tick))) - 4}
      {@const sy0 = topLineY(stopBarVisible.bar)}
      {@const sy1 = sy0 + (STAFF_LINES - 1) * STAFF_LINE_GAP}
      <g
        class="stop-bar"
        data-stop-bar="1"
        data-testid={`score-stop-bar-${nodeId}`}
        data-bar={stopBarVisible.bar}
        data-tick={stopBarVisible.tick}
      >
        <line class="stop-line" x1={sx} x2={sx} y1={sy0 - 2} y2={sy1 + 2} />
        <line class="stop-line" x1={sx + 4} x2={sx + 4} y1={sy0 - 2} y2={sy1 + 2} />
        <rect class="stop-hit" x={sx - 5} y={sy0 - 6} width={16} height={sy1 - sy0 + 12} />
      </g>
    {/if}
  </svg>

  <!-- The picture's own SCROLLBAR. Two buttons and no numeral: which page you
       are looking at is a viewport position, and the piece's LENGTH is named
       once, by the PAGES selector. The accessible names carry the position. -->
  {#if totalPages > 1}
    <div class="page-nav">
      <button
        type="button"
        class="page-btn"
        data-testid={`score-page-prev-${nodeId}`}
        aria-label={`previous page (showing page ${currentPage + 1} of ${totalPages})`}
        title="Previous page"
        disabled={currentPage <= 0}
        onclick={() => gotoPage(currentPage - 1)}
      >‹</button>
      <button
        type="button"
        class="page-btn"
        data-testid={`score-page-next-${nodeId}`}
        aria-label={`next page (showing page ${currentPage + 1} of ${totalPages})`}
        title="Next page"
        disabled={currentPage >= totalPages - 1}
        onclick={() => gotoPage(currentPage + 1)}
      >›</button>
    </div>
  {/if}
</div>

<style>
  .score-panel {
    position: relative;
    display: block;
  }
  .staff {
    display: block;
    width: 100%;
    height: auto;
    background: #0c0e12;
    cursor: crosshair;
    user-select: none;
    -webkit-user-select: none;
    touch-action: none;
  }
  .staff:focus-visible {
    outline: 1px solid var(--accent);
    outline-offset: -1px;
  }
  .staff-line, .bar-line {
    stroke: #5e6573;
    stroke-width: 0.75;
  }
  .bar-line.end { stroke-width: 1.5; }
  .smufl {
    font-family: 'Bravura', ui-serif, serif;
    fill: var(--text);
  }
  .clef { font-size: 36px; }
  .ts { font-size: 22px; }
  .key-acc { font-size: 18px; }
  .notehead { font-size: 18px; cursor: pointer; }
  .acc { font-size: 16px; }
  .flag { font-size: 16px; }
  .stem { stroke: var(--text); stroke-width: 1.2; }
  .note:hover .notehead, .note:focus .notehead { fill: var(--accent); }
  .note.selected .notehead { fill: var(--accent); }
  .sel-ring {
    fill: none;
    stroke: var(--accent);
    stroke-width: 1.2;
    stroke-opacity: 0.85;
  }
  .tie { stroke-linecap: round; }
  .dynamic {
    font-family: ui-serif, serif;
    font-style: italic;
    font-weight: 700;
    font-size: 14px;
    fill: var(--text);
  }
  .playing-highlight {
    fill: var(--cable-pitch);
    fill-opacity: 0.18;
    stroke: var(--cable-pitch);
    stroke-opacity: 0.9;
    stroke-width: 1;
  }
  .bar-shake {
    fill: rgba(220, 60, 60, 0.18);
    stroke: rgba(220, 60, 60, 0.7);
    stroke-width: 1.5;
    animation: score-shake 0.22s ease-in-out;
    pointer-events: none;
  }
  @keyframes score-shake {
    0%   { transform: translateX(0); }
    25%  { transform: translateX(-4px); }
    50%  { transform: translateX(4px); }
    75%  { transform: translateX(-2px); }
    100% { transform: translateX(0); }
  }
  .stop-bar { cursor: ew-resize; }
  .stop-line { stroke: var(--accent, #d05050); stroke-width: 2; }
  .stop-hit { fill: transparent; pointer-events: all; }
  .page-nav {
    position: absolute;
    right: 8px;
    bottom: 6px;
    display: flex;
    align-items: center;
    gap: 4px;
    background: rgba(20, 23, 28, 0.85);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 3px 5px;
  }
  .page-btn {
    background: #14171c;
    border: 1px solid var(--border);
    color: var(--text-dim);
    border-radius: 3px;
    height: 22px;
    min-width: 22px;
    padding: 0 5px;
    cursor: pointer;
    font-size: 0.8rem;
    line-height: 1;
  }
  .page-btn:hover:not(:disabled) { border-color: var(--accent-dim); color: var(--text); }
  .page-btn:disabled { opacity: 0.35; cursor: not-allowed; }
</style>

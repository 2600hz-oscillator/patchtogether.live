<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import QuicksaveControls from '$lib/ui/QuicksaveControls.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch, ydoc } from '$lib/graph/store';
  import { setNodeParam } from '$lib/graph/mutate';
  import { useEngine } from '$lib/audio/engine-context';
  import {
    handleSlotClick,
    readSlots,
    readPendingMode,
    readQueuedSlot,
    readLastLoadedSlot,
    setPendingMode,
    setQueuedSlot,
    type TransportCardDeps,
  } from '$lib/audio/modules/transport-card';
  import type { PendingMode, SlotKey, Snapshot } from '$lib/audio/modules/transport-helpers';

  const SCORE_INPUTS: PortDescriptor[] = [
    { id: 'clock',   label: 'CLOCK IN', cable: 'gate' },
    { id: 'attack',  cable: 'cv' },
    { id: 'decay',   cable: 'cv' },
    { id: 'sustain', cable: 'cv' },
    { id: 'release', cable: 'cv' },
    { id: 'play_cv',   label: 'PLAY GATE',     cable: 'gate' },
    { id: 'reset_cv',  label: 'RESET GATE',    cable: 'gate' },
    { id: 'queue1_cv', label: 'PLAY QUEUE 1',  cable: 'gate' },
    { id: 'queue2_cv', label: 'PLAY QUEUE 2',  cable: 'gate' },
    { id: 'queue3_cv', label: 'PLAY QUEUE 3',  cable: 'gate' },
    { id: 'queue4_cv', label: 'PLAY QUEUE 4',  cable: 'gate' },
  ];
  const SCORE_OUTPUTS: PortDescriptor[] = [
    { id: 'pitch', cable: 'pitch' },
    { id: 'gate',  cable: 'gate' },
    { id: 'env',   cable: 'cv' },
    { id: 'clock', label: 'CLOCK OUT', cable: 'gate' },
  ];
  import {
    BARS_PER_PAGE,
    BARS_PER_ROW,
    DEFAULT_PAGES,
    DYNAMIC_SCALE,
    MAX_PAGES,
    ROWS_PER_PAGE,
    SCORE_MAX_MIDI,
    SCORE_MIN_MIDI,
    SMUFL,
    TICKS_PER_BAR,
    canPlace,
    keySignatureLetters,
    quantizeTick,
    staffStepToMidi,
    tickWidth,
    totalBars,
    type Accidental,
    type DynamicLevel,
    type DynamicMarker,
    type NoteDuration,
    type ScoreData,
    type ScoreNote,
    type StopBar,
    type Tie,
  } from '$lib/audio/modules/score-data';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  let cardVersion = $state(0);
  $effect(() => {
    const h = () => { cardVersion = cardVersion + 1; };
    ydoc.on('update', h);
    return () => ydoc.off('update', h);
  });

  let bpm = $derived((void cardVersion, node?.params.bpm ?? 120));
  let attack = $derived((void cardVersion, node?.params.attack ?? 0.005));
  let decay = $derived((void cardVersion, node?.params.decay ?? 0.1));
  let sustain = $derived((void cardVersion, node?.params.sustain ?? 0.7));
  let release = $derived((void cardVersion, node?.params.release ?? 0.3));
  let isPlaying = $derived((void cardVersion, (node?.params.isPlaying ?? 0) >= 0.5));

  let scoreData = $derived.by<ScoreData>(() => {
    void cardVersion;
    const raw = (node?.data as Record<string, unknown> | undefined) ?? {};
    return {
      notes: Array.isArray(raw.notes) ? (raw.notes as ScoreNote[]) : [],
      dynamics: Array.isArray(raw.dynamics) ? (raw.dynamics as DynamicMarker[]) : [],
      ties: Array.isArray(raw.ties) ? (raw.ties as Tie[]) : [],
      keySignature: typeof raw.keySignature === 'number' ? (raw.keySignature as number) : 0,
      pages:
        typeof raw.pages === 'number'
          ? Math.max(1, Math.min(MAX_PAGES, raw.pages as number))
          : DEFAULT_PAGES,
      loop: typeof raw.loop === 'boolean' ? (raw.loop as boolean) : false,
      stopBar: (() => {
        const sb = raw.stopBar as { bar?: number; tick?: number } | undefined;
        return sb && typeof sb === 'object' && typeof sb.bar === 'number' && typeof sb.tick === 'number'
          ? { bar: sb.bar, tick: sb.tick }
          : undefined;
      })(),
    };
  });

  let totalPages = $derived(scoreData.pages);
  let currentPage = $state(0); // zero-based; UI displays +1
  // Clamp current page when pages shrink (e.g. via collab edit).
  $effect(() => {
    if (currentPage >= totalPages) currentPage = Math.max(0, totalPages - 1);
  });

  const set = (k: string) => (v: number) => {
    setNodeParam(id, k, v);
  };
  const live = (k: string) => () => {
    const e = engineCtx.get(); if (!e || !node) return undefined;
    return e.readParam(node, k);
  };

  function togglePlay() { set('isPlaying')(isPlaying ? 0 : 1); }

  // ----- rAF poll for currently-playing note id -----
  let currentNoteId = $state<string | null>(null);
  let raf: number | null = null;
  $effect(() => {
    function tickFrame() {
      const e = engineCtx.get();
      if (e && node) {
        const v = e.read(node, 'currentNoteId');
        currentNoteId = typeof v === 'string' ? v : null;
      }
      raf = requestAnimationFrame(tickFrame);
    }
    raf = requestAnimationFrame(tickFrame);
    return () => { if (raf !== null) cancelAnimationFrame(raf); raf = null; };
  });
  onDestroy(() => { if (raf !== null) cancelAnimationFrame(raf); });

  // ---------------- Layout constants ----------------
  // 4 rows × 4 bars per page. Each page renders 4 staff rows; only the active
  // page is visible at a time.
  const CARD_WIDTH = 720;
  const ROW_LEFT_PAD = 60;
  const ROW_RIGHT_PAD = 12;
  const ROW_INNER_W = CARD_WIDTH - ROW_LEFT_PAD - ROW_RIGHT_PAD;
  const BAR_W = ROW_INNER_W / BARS_PER_ROW;
  const TICK_PX = BAR_W / TICKS_PER_BAR;
  const STAFF_LINE_GAP = 8;        // px between adjacent lines
  const STAFF_STEP_PX = STAFF_LINE_GAP / 2; // 4px per staff step
  const ROW_HEIGHT = 80;           // tighter than v1 to fit 4 rows
  const ROW_TOP_PAD = 18;
  const STAFF_LINES = 5;
  // Y of the top staff line for the i-th row on the visible page.
  function rowTopLineY(rowIdx: number): number {
    return ROW_TOP_PAD + rowIdx * ROW_HEIGHT;
  }
  const TOTAL_HEIGHT = ROW_TOP_PAD + ROWS_PER_PAGE * ROW_HEIGHT + 36;

  /** Page index for an absolute bar. */
  function pageOf(bar: number): number {
    return Math.floor(bar / BARS_PER_PAGE);
  }
  /** Row index (0..ROWS_PER_PAGE-1) within the bar's page. */
  function rowOf(bar: number): number {
    const local = bar - pageOf(bar) * BARS_PER_PAGE;
    return Math.floor(local / BARS_PER_ROW);
  }
  /** Local bar within its row (0..BARS_PER_ROW-1). */
  function rowLocalBar(bar: number): number {
    const local = bar - pageOf(bar) * BARS_PER_PAGE;
    return local % BARS_PER_ROW;
  }
  function topLineY(bar: number): number {
    return rowTopLineY(rowOf(bar));
  }
  function barLeftX(bar: number): number {
    return ROW_LEFT_PAD + rowLocalBar(bar) * BAR_W;
  }
  function noteX(bar: number, tick: number): number {
    return barLeftX(bar) + tick * TICK_PX + 6;
  }
  function noteY(bar: number, staffStep: number): number {
    return topLineY(bar) + staffStep * STAFF_STEP_PX;
  }
  /** Bar is currently visible on the active page. */
  function isBarOnPage(bar: number): boolean {
    return pageOf(bar) === currentPage;
  }

  /** Convert pixel y to a row index on the current page. */
  function yToRowIdx(py: number): number {
    const r = Math.floor((py - ROW_TOP_PAD + ROW_HEIGHT * 0.6) / ROW_HEIGHT);
    return Math.max(0, Math.min(ROWS_PER_PAGE - 1, r));
  }
  function yToStep(rowIdx: number, py: number): number {
    const top = rowTopLineY(rowIdx);
    return Math.round((py - top) / STAFF_STEP_PX);
  }

  /** Convert (clientX, clientY) to (bar, tick, step) in score-space — using
   *  the active page index. */
  function pointerToCell(svgEl: SVGSVGElement, clientX: number, clientY: number): {
    bar: number; tick: number; step: number;
  } | null {
    const rect = svgEl.getBoundingClientRect();
    const px = ((clientX - rect.left) / rect.width) * CARD_WIDTH;
    const py = ((clientY - rect.top) / rect.height) * TOTAL_HEIGHT;
    const rowIdx = yToRowIdx(py);
    const step = yToStep(rowIdx, py);
    if (px < ROW_LEFT_PAD || px > ROW_LEFT_PAD + ROW_INNER_W + 4) return null;
    const localBar = Math.min(BARS_PER_ROW - 1, Math.max(0, Math.floor((px - ROW_LEFT_PAD) / BAR_W)));
    const bar = currentPage * BARS_PER_PAGE + rowIdx * BARS_PER_ROW + localBar;
    if (bar >= totalPages * BARS_PER_PAGE) return null;
    const xInBar = px - barLeftX(bar) - 6;
    const rawTick = Math.max(0, Math.min(TICKS_PER_BAR - 1, Math.round(xInBar / TICK_PX)));
    return { bar, tick: rawTick, step };
  }

  // ---------------- Toolbar state ----------------
  type Tool =
    | { kind: 'duration'; duration: NoteDuration }
    | { kind: 'sharp' }
    | { kind: 'flat' }
    | { kind: 'tie' }
    | { kind: 'dynamic'; level: DynamicLevel }
    | { kind: 'stopBar' }
    | { kind: 'select' };
  let activeTool = $state<Tool>({ kind: 'duration', duration: 'quarter' });

  const DURATION_BUTTONS: Array<{ d: NoteDuration; label: string; glyph: string }> = [
    { d: 'whole',      label: 'whole',   glyph: SMUFL.noteWhole },
    { d: 'half',       label: 'half',    glyph: SMUFL.noteheadHalf },
    { d: 'quarter',    label: 'quarter', glyph: SMUFL.noteheadBlack },
    { d: 'eighth',     label: 'eighth',  glyph: SMUFL.noteheadBlack + SMUFL.flag8thUp },
    { d: 'triplet8th', label: 'triplet', glyph: '3' },
    { d: '16th',       label: '16th',    glyph: SMUFL.noteheadBlack + SMUFL.flag16thUp },
  ];
  const DYNAMIC_BUTTONS: DynamicLevel[] = ['pp', 'p', 'mf', 'f', 'ff'];

  // Tie pick state
  let tiePickFirst = $state<string | null>(null);

  // Bar shake animation (overflow rejection)
  let shakeBar = $state<number | null>(null);
  function flashShake(bar: number) {
    shakeBar = bar;
    setTimeout(() => { shakeBar = null; }, 220);
  }

  // ---------------- Mutations ----------------
  function genId(prefix: string): string {
    return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
  }

  function writeData(mut: (d: ScoreData) => void) {
    const t = patch.nodes[id];
    if (!t) return;
    ydoc.transact(() => {
      if (!t.data) t.data = {};
      const cur = scoreData;
      const next: ScoreData = {
        notes: cur.notes.map((n) => ({ ...n })),
        dynamics: cur.dynamics.map((d) => ({ ...d })),
        ties: cur.ties.map((t) => ({ ...t })),
        keySignature: cur.keySignature,
        pages: cur.pages,
        loop: cur.loop,
        stopBar: cur.stopBar ? { ...cur.stopBar } : undefined,
      };
      mut(next);
      const td = t.data as Record<string, unknown>;
      td.notes = next.notes;
      td.dynamics = next.dynamics;
      td.ties = next.ties;
      td.keySignature = next.keySignature;
      td.pages = next.pages;
      td.loop = next.loop;
      // Use null-sentinel to remove the marker (Yjs map shape).
      if (next.stopBar) td.stopBar = next.stopBar;
      else td.stopBar = undefined;
    });
  }

  function addNote(bar: number, tick: number, step: number, duration: NoteDuration) {
    const ks = scoreData.keySignature;
    const midi = staffStepToMidi(step, ks, null);
    if (midi < SCORE_MIN_MIDI || midi > SCORE_MAX_MIDI) return;
    const snapTick = quantizeTick(tick, duration);
    const maxBar = totalBars(scoreData);
    if (!canPlace(bar, snapTick, duration, midi, scoreData.notes, undefined, maxBar)) {
      flashShake(bar);
      return;
    }
    writeData((d) => {
      d.notes.push({
        id: genId('n'),
        bar,
        tick: snapTick,
        duration,
        midi,
        staffStep: step,
        accidental: null,
      });
    });
  }

  function placeDynamic(bar: number, tick: number, level: DynamicLevel) {
    writeData((d) => {
      d.dynamics = d.dynamics.filter((m) => !(m.bar === bar && m.tick === tick));
      d.dynamics.push({ id: genId('d'), bar, tick, level });
    });
  }

  function setStopBar(bar: number, tick: number) {
    writeData((d) => {
      // Snap tick to 16th boundaries (multiples of 3).
      const snap = Math.max(0, Math.min(TICKS_PER_BAR, Math.round(tick / 3) * 3));
      d.stopBar = { bar, tick: snap };
    });
  }

  function clearStopBar() {
    writeData((d) => {
      d.stopBar = undefined;
    });
  }

  function toggleLoop() {
    writeData((d) => { d.loop = !d.loop; });
  }

  function addPage() {
    if (totalPages >= MAX_PAGES) return;
    writeData((d) => { d.pages = Math.min(MAX_PAGES, d.pages + 1); });
    // Don't auto-jump — the user explicitly navigates to the new page via
    // the → arrow. Auto-jumping fights the clamp $effect (totalPages is
    // $derived from scoreData and lags by one tick after writeData).
  }

  function gotoPage(idx: number) {
    if (idx < 0 || idx >= totalPages) return;
    currentPage = idx;
  }

  function toggleAccidentalOnNote(noteId: string, kind: 'sharp' | 'flat') {
    writeData((d) => {
      const idx = d.notes.findIndex((n) => n.id === noteId);
      if (idx < 0) return;
      const n = { ...d.notes[idx] };
      const wanted: Accidental = kind === 'sharp' ? 'sharp' : 'flat';
      n.accidental = n.accidental === wanted ? null : wanted;
      n.midi = staffStepToMidi(n.staffStep, d.keySignature, n.accidental);
      d.notes[idx] = n;
    });
  }

  function cycleKey(delta: 1 | -1) {
    writeData((d) => {
      const next = Math.max(-7, Math.min(7, d.keySignature + delta));
      d.keySignature = next;
      d.notes = d.notes.map((n) =>
        n.accidental === null ? { ...n, midi: staffStepToMidi(n.staffStep, next, null) } : n,
      );
    });
  }
  function resetKey() {
    writeData((d) => {
      d.keySignature = 0;
      d.notes = d.notes.map((n) =>
        n.accidental === null ? { ...n, midi: staffStepToMidi(n.staffStep, 0, null) } : n,
      );
    });
  }

  function addTie(fromId: string, toId: string) {
    if (fromId === toId) return;
    writeData((d) => {
      d.ties.push({ id: genId('t'), fromNoteId: fromId, toNoteId: toId });
    });
  }

  function deleteNote(noteId: string) {
    writeData((d) => {
      d.notes = d.notes.filter((n) => n.id !== noteId);
      d.ties = d.ties.filter((t) => t.fromNoteId !== noteId && t.toNoteId !== noteId);
    });
  }

  // ---------------- Pointer handlers ----------------
  let svgEl: SVGSVGElement | undefined = $state();
  let dragNoteId: string | null = null;
  let dragOffset: { dx: number; dy: number } = { dx: 0, dy: 0 };
  let dragStopBar = $state(false);

  function onSvgPointerDown(ev: PointerEvent) {
    if (!svgEl) return;
    const target = ev.target as Element;
    const noteEl = target.closest('[data-note-id]') as Element | null;
    const noteId = noteEl?.getAttribute('data-note-id') ?? null;
    const stopEl = target.closest('[data-stop-bar]') as Element | null;

    // Stop-bar drag (existing marker)
    if (stopEl && (activeTool.kind === 'duration' || activeTool.kind === 'select' || activeTool.kind === 'stopBar')) {
      ev.preventDefault();
      ev.stopPropagation();
      dragStopBar = true;
      svgEl.setPointerCapture(ev.pointerId);
      return;
    }

    // Tie picking: clicking a note when tie tool active.
    if (activeTool.kind === 'tie' && noteId) {
      ev.preventDefault();
      ev.stopPropagation();
      if (tiePickFirst === null) {
        tiePickFirst = noteId;
      } else {
        addTie(tiePickFirst, noteId);
        tiePickFirst = null;
      }
      return;
    }

    // Sharp/Flat on existing note → toggle per-note accidental
    if ((activeTool.kind === 'sharp' || activeTool.kind === 'flat') && noteId) {
      ev.preventDefault();
      ev.stopPropagation();
      toggleAccidentalOnNote(noteId, activeTool.kind);
      return;
    }

    // Sharp/Flat on empty staff → cycle key signature
    if (activeTool.kind === 'sharp' && !noteId) {
      ev.preventDefault();
      ev.stopPropagation();
      cycleKey(1);
      return;
    }
    if (activeTool.kind === 'flat' && !noteId) {
      ev.preventDefault();
      ev.stopPropagation();
      cycleKey(-1);
      return;
    }

    // Drag existing note (any tool except tie/dynamic/sharp/flat) when click hits a note.
    if (noteId && (activeTool.kind === 'duration' || activeTool.kind === 'select')) {
      ev.preventDefault();
      ev.stopPropagation();
      dragNoteId = noteId;
      dragOffset = { dx: 0, dy: 0 };
      svgEl.setPointerCapture(ev.pointerId);
      return;
    }

    // Place dynamic
    if (activeTool.kind === 'dynamic') {
      ev.preventDefault();
      ev.stopPropagation();
      const cell = pointerToCell(svgEl, ev.clientX, ev.clientY);
      if (cell) placeDynamic(cell.bar, cell.tick, activeTool.level);
      return;
    }

    // Place stop-bar marker (or move existing).
    if (activeTool.kind === 'stopBar') {
      ev.preventDefault();
      ev.stopPropagation();
      const cell = pointerToCell(svgEl, ev.clientX, ev.clientY);
      if (cell) setStopBar(cell.bar, cell.tick);
      return;
    }

    // Place note
    if (activeTool.kind === 'duration') {
      ev.preventDefault();
      ev.stopPropagation();
      const cell = pointerToCell(svgEl, ev.clientX, ev.clientY);
      if (cell) addNote(cell.bar, cell.tick, cell.step, activeTool.duration);
      return;
    }
  }

  function onSvgPointerMove(ev: PointerEvent) {
    if (!svgEl) return;
    if (dragStopBar) {
      const cell = pointerToCell(svgEl, ev.clientX, ev.clientY);
      if (cell) setStopBar(cell.bar, cell.tick);
      return;
    }
    if (!dragNoteId) return;
    const cell = pointerToCell(svgEl, ev.clientX, ev.clientY);
    if (!cell) return;
    const id = dragNoteId;
    const maxBar = totalBars(scoreData);
    writeData((d) => {
      const idx = d.notes.findIndex((n) => n.id === id);
      if (idx < 0) return;
      const n = { ...d.notes[idx] };
      const snapTick = quantizeTick(cell.tick, n.duration);
      const newMidi = staffStepToMidi(cell.step, d.keySignature, n.accidental);
      if (newMidi < SCORE_MIN_MIDI || newMidi > SCORE_MAX_MIDI) return;
      if (!canPlace(cell.bar, snapTick, n.duration, newMidi, d.notes, n.id, maxBar)) return;
      n.bar = cell.bar;
      n.tick = snapTick;
      n.staffStep = cell.step;
      n.midi = newMidi;
      d.notes[idx] = n;
    });
  }

  function onSvgPointerUp(ev: PointerEvent) {
    if (svgEl && (dragNoteId || dragStopBar)) {
      try { svgEl.releasePointerCapture(ev.pointerId); } catch { /* noop */ }
    }
    dragNoteId = null;
    dragStopBar = false;
  }

  function onSvgKeyDown(ev: KeyboardEvent) {
    if (ev.key === 'Escape') {
      tiePickFirst = null;
      dragNoteId = null;
      ev.preventDefault();
      return;
    }
    const target = ev.target as Element | null;
    const noteEl = target?.closest('[data-note-id]') as HTMLElement | null;
    const noteId = noteEl?.getAttribute('data-note-id');
    if (!noteId) return;
    if (ev.key === 'Backspace' || ev.key === 'Delete') {
      ev.preventDefault();
      deleteNote(noteId);
      return;
    }
    if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
      ev.preventDefault();
      const delta = ev.key === 'ArrowUp' ? -1 : 1;
      writeData((d) => {
        const idx = d.notes.findIndex((n) => n.id === noteId);
        if (idx < 0) return;
        const n = { ...d.notes[idx] };
        const newStep = n.staffStep + delta;
        const newMidi = staffStepToMidi(newStep, d.keySignature, n.accidental);
        if (newMidi < SCORE_MIN_MIDI || newMidi > SCORE_MAX_MIDI) return;
        n.staffStep = newStep;
        n.midi = newMidi;
        d.notes[idx] = n;
      });
      return;
    }
    if (ev.key === '#') {
      ev.preventDefault();
      toggleAccidentalOnNote(noteId, 'sharp');
      return;
    }
    if (ev.key === 'b') {
      ev.preventDefault();
      toggleAccidentalOnNote(noteId, 'flat');
      return;
    }
  }

  // ---------------- Derived render data ----------------
  let activeKey = $derived(scoreData.keySignature);
  let keyAccidentals = $derived.by(() => {
    const res = keySignatureLetters(activeKey);
    return { sharps: [...res.sharps], flats: [...res.flats] };
  });

  function dynamicYForBar(bar: number): number {
    const baseTop = topLineY(bar);
    const bottomLine = baseTop + (STAFF_LINES - 1) * STAFF_LINE_GAP;
    return bottomLine + 18;
  }

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
    const midX = (ax + cx) / 2;
    const midY = arcUp ? Math.min(ay, cy) - 12 : Math.max(ay, cy) + 12;
    return `M ${ax} ${ay} Q ${midX} ${midY} ${cx} ${cy}`;
  }

  function selectDuration(d: NoteDuration) { activeTool = { kind: 'duration', duration: d }; }
  function selectSharp() { activeTool = { kind: 'sharp' }; tiePickFirst = null; }
  function selectFlat() { activeTool = { kind: 'flat' }; tiePickFirst = null; }
  function selectTie() { activeTool = { kind: 'tie' }; tiePickFirst = null; }
  function selectDynamic(level: DynamicLevel) { activeTool = { kind: 'dynamic', level }; }
  function selectStopBar() { activeTool = { kind: 'stopBar' }; tiePickFirst = null; }

  function isDurationActive(d: NoteDuration): boolean {
    return activeTool.kind === 'duration' && activeTool.duration === d;
  }
  function isDynamicActive(level: DynamicLevel): boolean {
    return activeTool.kind === 'dynamic' && activeTool.level === level;
  }

  function onContextMenu(ev: MouseEvent) {
    if (activeTool.kind === 'sharp' || activeTool.kind === 'flat') {
      ev.preventDefault();
      resetKey();
    }
  }

  function keySigGlyphs(rowIdx: number): Array<{ x: number; y: number; glyph: string }> {
    const out: Array<{ x: number; y: number; glyph: string }> = [];
    const top = rowTopLineY(rowIdx);
    let xCursor = 30;
    if (activeKey > 0) {
      const sharpStaffStep = [0, 3, -1, 2, 5, 1, 4];
      for (let i = 0; i < Math.min(7, activeKey); i++) {
        out.push({
          x: xCursor,
          y: top + sharpStaffStep[i] * STAFF_STEP_PX + 4,
          glyph: SMUFL.accidentalSharp,
        });
        xCursor += 7;
      }
    } else if (activeKey < 0) {
      const flatStaffStep = [4, 1, 5, 2, 6, 3, 7];
      for (let i = 0; i < Math.min(7, -activeKey); i++) {
        out.push({
          x: xCursor,
          y: top + flatStaffStep[i] * STAFF_STEP_PX + 3,
          glyph: SMUFL.accidentalFlat,
        });
        xCursor += 7;
      }
    }
    return out;
  }

  // ---------------- Quicksave + transport ----------------

  // Read directly from patch.nodes[id] inside each snapshot/apply call so
  // we capture LIVE state (Svelte 5 closures over $derived/$props snapshot
  // their initial value otherwise — see svelte.dev/e/state_referenced_locally).
  const transportDeps: TransportCardDeps = {
    nodeId: id,
    patch,
    transact: (fn) => ydoc.transact(fn),
    snapshot: (): Snapshot => {
      const t = patch.nodes[id];
      const raw = (t?.data as Record<string, unknown> | undefined) ?? {};
      const notes = (Array.isArray(raw.notes) ? (raw.notes as ScoreNote[]) : []).map((n) => ({ ...n }));
      const dynamics = (Array.isArray(raw.dynamics) ? (raw.dynamics as DynamicMarker[]) : []).map((d) => ({ ...d }));
      const ties = (Array.isArray(raw.ties) ? (raw.ties as Tie[]) : []).map((tt) => ({ ...tt }));
      const keySignature = typeof raw.keySignature === 'number' ? (raw.keySignature as number) : 0;
      const pages =
        typeof raw.pages === 'number' ? Math.max(1, Math.min(MAX_PAGES, raw.pages as number)) : DEFAULT_PAGES;
      const loop = typeof raw.loop === 'boolean' ? (raw.loop as boolean) : false;
      const sb = raw.stopBar as { bar?: number; tick?: number } | undefined;
      const stopBar =
        sb && typeof sb === 'object' && typeof sb.bar === 'number' && typeof sb.tick === 'number'
          ? { bar: sb.bar, tick: sb.tick }
          : undefined;
      return {
        notes,
        dynamics,
        ties,
        keySignature,
        pages,
        loop,
        stopBar,
        bpm: t?.params.bpm ?? 120,
        attack: t?.params.attack ?? 0.005,
        decay: t?.params.decay ?? 0.1,
        sustain: t?.params.sustain ?? 0.7,
        release: t?.params.release ?? 0.3,
      };
    },
    applySnapshot: (snap: Snapshot) => {
      const t = patch.nodes[id];
      if (!t) return;
      // Deep-clone array/object fields so we don't reassign Y-tree references
      // (the snapshot may itself live inside slots[N], and Yjs forbids the
      // same Y.Map appearing at two places — "Not supported: reassigning
      // object that already occurs in the tree.").
      ydoc.transact(() => {
        if (!t.data) t.data = {};
        const td = t.data as Record<string, unknown>;
        if (Array.isArray(snap.notes)) {
          td.notes = (snap.notes as ScoreNote[]).map((n) => ({ ...n }));
        }
        if (Array.isArray(snap.dynamics)) {
          td.dynamics = (snap.dynamics as DynamicMarker[]).map((d) => ({ ...d }));
        }
        if (Array.isArray(snap.ties)) {
          td.ties = (snap.ties as Tie[]).map((tt) => ({ ...tt }));
        }
        if (typeof snap.keySignature === 'number') td.keySignature = snap.keySignature;
        if (typeof snap.pages === 'number') td.pages = snap.pages;
        if (typeof snap.loop === 'boolean') td.loop = snap.loop;
        if (snap.stopBar && typeof snap.stopBar === 'object') {
          const sb = snap.stopBar as { bar: number; tick: number };
          td.stopBar = { bar: sb.bar, tick: sb.tick };
        } else if ('stopBar' in snap) {
          td.stopBar = undefined;
        }
        for (const k of ['bpm', 'attack', 'decay', 'sustain', 'release'] as const) {
          const v = snap[k];
          if (typeof v === 'number') t.params[k] = v;
        }
      });
    },
  };

  let slotsState = $derived((void cardVersion, readSlots(node)));
  let pendingMode = $derived<PendingMode>((void cardVersion, readPendingMode(node)));
  let queuedSlot = $derived<SlotKey | null>((void cardVersion, readQueuedSlot(node)));
  let lastLoadedSlot = $derived<SlotKey | null>((void cardVersion, readLastLoadedSlot(node)));

  function onSetMode(m: PendingMode) { setPendingMode(transportDeps, m); }
  function onSlotClick(k: SlotKey) { handleSlotClick(transportDeps, k); }
  function onPlayToggle() { togglePlay(); }
  function onReset() {
    const wasPlaying = isPlaying;
    setQueuedSlot(transportDeps, null);
    set('isPlaying')(0);
    if (wasPlaying) requestAnimationFrame(() => set('isPlaying')(1));
  }

  // Bars on the active page only, for note rendering.
  let visibleNotes = $derived(scoreData.notes.filter((n) => isBarOnPage(n.bar)));
  let visibleDynamics = $derived(scoreData.dynamics.filter((d) => isBarOnPage(d.bar)));
  let visibleTies = $derived(
    scoreData.ties.filter((t) => {
      const fromN = scoreData.notes.find((n) => n.id === t.fromNoteId);
      const toN = scoreData.notes.find((n) => n.id === t.toNoteId);
      return fromN && toN && (isBarOnPage(fromN.bar) || isBarOnPage(toN.bar));
    }),
  );
  let stopBarVisible = $derived.by<StopBar | null>(() => {
    if (!scoreData.stopBar) return null;
    return isBarOnPage(scoreData.stopBar.bar) ? scoreData.stopBar : null;
  });
</script>

<div class="mod-card score-card">
  <div class="stripe" style="background: var(--cable-pitch);"></div>
  <header class="title">
    <ModuleTitle {id} {data} defaultLabel="Score" inline />
    <button class="play-btn" class:playing={isPlaying} onclick={togglePlay} title={isPlaying ? 'Stop' : 'Play'}>
      {isPlaying ? '■' : '▶'}
    </button>
  </header>

  <PatchPanel nodeId={id} inputs={SCORE_INPUTS} outputs={SCORE_OUTPUTS}>
  <!-- Toolbar -->
  <div class="toolbar" data-testid={`score-toolbar-${id}`}>
    {#each DURATION_BUTTONS as btn (btn.d)}
      <button
        type="button"
        class="tool-btn"
        class:active={isDurationActive(btn.d)}
        data-testid={`score-tool-${btn.d}-${id}`}
        title={btn.label}
        onclick={() => selectDuration(btn.d)}
      ><span class="smufl">{btn.glyph}</span></button>
    {/each}
    <button
      type="button"
      class="tool-btn"
      class:active={activeTool.kind === 'sharp'}
      data-testid={`score-tool-sharp-${id}`}
      title="Sharp (click note: per-note accidental; click empty staff: key signature +1; right-click: reset)"
      onclick={selectSharp}
      oncontextmenu={onContextMenu}
    ><span class="smufl">{SMUFL.accidentalSharp}</span></button>
    <button
      type="button"
      class="tool-btn"
      class:active={activeTool.kind === 'flat'}
      data-testid={`score-tool-flat-${id}`}
      title="Flat (click note: per-note accidental; click empty staff: key signature -1; right-click: reset)"
      onclick={selectFlat}
      oncontextmenu={onContextMenu}
    ><span class="smufl">{SMUFL.accidentalFlat}</span></button>
    <button
      type="button"
      class="tool-btn"
      class:active={activeTool.kind === 'tie'}
      data-testid={`score-tool-tie-${id}`}
      title="Tie / slur — click first note, then second"
      onclick={selectTie}
    >tie</button>
    {#each DYNAMIC_BUTTONS as level (level)}
      <button
        type="button"
        class="tool-btn dyn"
        class:active={isDynamicActive(level)}
        data-testid={`score-tool-dyn-${level}-${id}`}
        title={`Dynamic ${level} (${Math.round(DYNAMIC_SCALE[level] * 100)}%)`}
        onclick={() => selectDynamic(level)}
      >{level}</button>
    {/each}
    <button
      type="button"
      class="tool-btn"
      class:active={activeTool.kind === 'stopBar'}
      data-testid={`score-tool-stop-${id}`}
      title="Stop-music double-bar — click on the staff to set the end of the sequence"
      onclick={selectStopBar}
    >stop</button>
    <button
      type="button"
      class="tool-btn loop"
      class:active={scoreData.loop}
      data-testid={`score-tool-loop-${id}`}
      title={scoreData.loop ? 'Loop ON — wraps to start at end of sequence' : 'Loop OFF — stops at end of sequence'}
      onclick={toggleLoop}
    >loop</button>
  </div>

  <!-- Staff SVG -->
  <svg
    bind:this={svgEl}
    class="staff"
    width={CARD_WIDTH}
    height={TOTAL_HEIGHT}
    viewBox={`0 0 ${CARD_WIDTH} ${TOTAL_HEIGHT}`}
    role="application"
    tabindex="0"
    data-testid={`score-staff-${id}`}
    onpointerdown={onSvgPointerDown}
    onpointermove={onSvgPointerMove}
    onpointerup={onSvgPointerUp}
    onpointercancel={onSvgPointerUp}
    oncontextmenu={onContextMenu}
    onkeydown={onSvgKeyDown}
  >
    <!-- Four staff rows for the active page -->
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
      <!-- Bar lines -->
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
      <!-- Clef + key sig (and time sig on first row of page) -->
      <text class="smufl clef" x={6} y={rowTopLineY(rowIdx) + 25}>{SMUFL.gClef}</text>
      {#each keySigGlyphs(rowIdx) as g (g.x + g.glyph + rowIdx)}
        <text class="smufl key-acc" x={g.x} y={g.y}>{g.glyph}</text>
      {/each}
      {#if rowIdx === 0}
        <text class="smufl ts" x={48} y={rowTopLineY(0) + 10}>{SMUFL.timeSig4}</text>
        <text class="smufl ts" x={48} y={rowTopLineY(0) + 26}>{SMUFL.timeSig4}</text>
      {/if}
    {/each}

    <!-- Per-bar shake overlay -->
    {#each scoreData.notes as _n, idx (idx)}
      {idx === 0 ? '' : ''}
    {/each}
    {#if shakeBar !== null && isBarOnPage(shakeBar)}
      <rect
        class="bar-shake"
        x={barLeftX(shakeBar)}
        y={topLineY(shakeBar) - 4}
        width={BAR_W}
        height={(STAFF_LINES - 1) * STAFF_LINE_GAP + 8}
        data-testid={`score-shake-${id}-${shakeBar}`}
      />
    {/if}

    <!-- Tie arcs -->
    {#each visibleTies as t (t.id)}
      {@const from = scoreData.notes.find((n) => n.id === t.fromNoteId)!}
      {@const to = scoreData.notes.find((n) => n.id === t.toNoteId)!}
      {#if from && to && isBarOnPage(from.bar) && isBarOnPage(to.bar)}
        <path
          class="tie"
          d={tiePathD(from, to)}
          data-tie-id={t.id}
          data-testid={`score-tie-${id}-${t.id}`}
          fill="none"
          stroke="var(--cable-pitch)"
          stroke-width="1.5"
        />
      {/if}
    {/each}

    <!-- Currently-playing highlight -->
    {#if currentNoteId}
      {@const playing = scoreData.notes.find((n) => n.id === currentNoteId)}
      {#if playing && isBarOnPage(playing.bar)}
        <rect
          class="playing-highlight"
          x={noteX(playing.bar, playing.tick) - 6}
          y={noteY(playing.bar, playing.staffStep) - 8}
          width={Math.max(14, tickWidth(playing.duration) * TICK_PX)}
          height={16}
          rx={3}
          data-testid={`score-highlight-${id}`}
        />
      {/if}
    {/if}

    <!-- Notes (visible on this page) -->
    {#each visibleNotes as n (n.id)}
      <g
        class="note"
        class:tie-pick={tiePickFirst === n.id}
        data-note-id={n.id}
        data-testid={`score-note-${id}-${n.id}`}
        data-bar={n.bar}
        data-tick={n.tick}
        data-midi={n.midi}
        data-duration={n.duration}
        data-step={n.staffStep}
        tabindex="0"
      >
        {#if n.accidental === 'sharp'}
          <text class="smufl acc" x={noteX(n.bar, n.tick) - 9} y={noteY(n.bar, n.staffStep) + 3}>{SMUFL.accidentalSharp}</text>
        {:else if n.accidental === 'flat'}
          <text class="smufl acc" x={noteX(n.bar, n.tick) - 9} y={noteY(n.bar, n.staffStep) + 3}>{SMUFL.accidentalFlat}</text>
        {:else if n.accidental === 'natural'}
          <text class="smufl acc" x={noteX(n.bar, n.tick) - 9} y={noteY(n.bar, n.staffStep) + 3}>{SMUFL.accidentalNatural}</text>
        {/if}
        <text class="smufl notehead" x={noteX(n.bar, n.tick)} y={noteY(n.bar, n.staffStep) + 4}>{noteGlyph(n.duration)}</text>
        {#if n.duration === 'half' || n.duration === 'quarter' || n.duration === 'eighth' || n.duration === '16th' || n.duration === 'triplet8th'}
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

    <!-- Dynamic markers -->
    {#each visibleDynamics as d (d.id)}
      <text
        class="dynamic"
        x={noteX(d.bar, d.tick)}
        y={dynamicYForBar(d.bar)}
        data-dynamic-id={d.id}
        data-testid={`score-dyn-${id}-${d.id}`}
      >{d.level}</text>
    {/each}

    <!-- Stop-music double-bar marker (visible on this page) -->
    {#if stopBarVisible}
      {@const sx = (() => {
        // tick = TICKS_PER_BAR is allowed (end-of-bar). Project onto the row.
        const safeTick = Math.min(TICKS_PER_BAR - 0.001, Math.max(0, stopBarVisible.tick));
        return noteX(stopBarVisible.bar, safeTick) - 4;
      })()}
      {@const sy0 = topLineY(stopBarVisible.bar)}
      {@const sy1 = sy0 + (STAFF_LINES - 1) * STAFF_LINE_GAP}
      <g
        class="stop-bar"
        data-stop-bar="1"
        data-testid={`score-stop-bar-${id}`}
        data-bar={stopBarVisible.bar}
        data-tick={stopBarVisible.tick}
      >
        <line class="stop-line" x1={sx} x2={sx} y1={sy0 - 2} y2={sy1 + 2} />
        <line class="stop-line" x1={sx + 4} x2={sx + 4} y1={sy0 - 2} y2={sy1 + 2} />
        <!-- Wide hit target for drag -->
        <rect class="stop-hit" x={sx - 5} y={sy0 - 6} width={16} height={sy1 - sy0 + 12} />
      </g>
    {/if}
  </svg>

  <!-- ADSR + BPM faders -->
  <div class="fader-row">
    <Fader value={bpm}     min={30}    max={300} defaultValue={120}   label="BPM" curve="linear" onchange={set('bpm')} moduleId={id} paramId="bpm"     readLive={live('bpm')} />
    <Fader value={attack}  min={0.001} max={10}  defaultValue={0.005} label="A"   curve="log"    onchange={set('attack')} moduleId={id} paramId="attack"  readLive={live('attack')} />
    <Fader value={decay}   min={0.001} max={10}  defaultValue={0.1}   label="D"   curve="log"    onchange={set('decay')} moduleId={id} paramId="decay"   readLive={live('decay')} />
    <Fader value={sustain} min={0}     max={1}   defaultValue={0.7}   label="S"   curve="linear" onchange={set('sustain')} moduleId={id} paramId="sustain" readLive={live('sustain')} />
    <Fader value={release} min={0.001} max={10}  defaultValue={0.3}   label="R"   curve="log"    onchange={set('release')} moduleId={id} paramId="release" readLive={live('release')} />
  </div>

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

  <!-- Page navigation (lower right) -->
  <div class="page-nav" data-testid={`score-page-nav-${id}`}>
    <button
      type="button"
      class="page-btn"
      data-testid={`score-page-prev-${id}`}
      title="Previous page"
      disabled={currentPage <= 0}
      onclick={() => gotoPage(currentPage - 1)}
    >‹</button>
    <span class="page-counter" data-testid={`score-page-counter-${id}`}>
      {currentPage + 1} / {totalPages}
    </span>
    <button
      type="button"
      class="page-btn"
      data-testid={`score-page-next-${id}`}
      title="Next page"
      disabled={currentPage >= totalPages - 1}
      onclick={() => gotoPage(currentPage + 1)}
    >›</button>
    <button
      type="button"
      class="page-btn add"
      data-testid={`score-page-add-${id}`}
      title="Add page"
      disabled={totalPages >= MAX_PAGES}
      onclick={addPage}
    >+</button>
  </div>
  </PatchPanel>
</div>

<style>
  .score-card {
    width: 720px;
    padding-left: 0;
    padding-right: 0;
    position: relative;
  }
  .score-card > .title {
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
  .toolbar {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
    padding: 6px 22px 4px;
  }
  .tool-btn {
    background: #14171c;
    border: 1px solid var(--border);
    color: var(--text-dim);
    border-radius: 3px;
    height: 26px;
    min-width: 28px;
    padding: 0 6px;
    cursor: pointer;
    font-family: 'Bravura', ui-serif, serif;
    font-size: 0.85rem;
    line-height: 1;
  }
  .tool-btn.dyn,
  .tool-btn.loop {
    font-family: ui-serif, serif;
    font-style: italic;
    font-size: 0.85rem;
  }
  .tool-btn.active {
    border-color: var(--accent);
    color: var(--accent);
    background: rgba(64, 92, 130, 0.18);
  }
  .tool-btn:hover {
    border-color: var(--accent-dim);
  }
  .tool-btn .smufl {
    font-family: 'Bravura', ui-serif, serif;
  }
  .staff {
    display: block;
    margin: 0 auto;
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
  .bar-line.end {
    stroke-width: 1.5;
  }
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
  .note:hover .notehead, .note:focus .notehead {
    fill: var(--accent);
  }
  .note.tie-pick .notehead {
    fill: var(--cable-pitch);
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
  .fader-row {
    margin-top: 6px;
    padding: 0 22px;
    gap: 8px;
    display: flex;
  }
  .stop-bar { cursor: ew-resize; }
  .stop-line {
    stroke: var(--accent, #d05050);
    stroke-width: 2;
  }
  .stop-hit {
    fill: transparent;
    pointer-events: all;
  }
  .page-nav {
    position: absolute;
    right: 16px;
    bottom: 8px;
    display: flex;
    align-items: center;
    gap: 4px;
    background: rgba(20, 23, 28, 0.85);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 3px 6px;
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
  .page-btn:hover:not(:disabled) {
    border-color: var(--accent-dim);
    color: var(--text);
  }
  .page-btn:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }
  .page-btn.add {
    color: var(--accent);
  }
  .page-counter {
    font-size: 0.78rem;
    color: var(--text-dim);
    min-width: 32px;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
</style>

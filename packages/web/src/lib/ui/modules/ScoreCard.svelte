<script lang="ts">
  import { onDestroy } from 'svelte';
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import { patch, ydoc } from '$lib/graph/store';
  import { useEngine } from '$lib/audio/engine-context';
  import {
    TICKS_PER_BAR,
    BARS_PER_ROW,
    DYNAMIC_SCALE,
    ALL_DURATIONS,
    ALL_DYNAMICS,
    canPlace,
    cycleKeyFlatter,
    cycleKeySharper,
    notesUnderTie,
    quantizeTick,
    sortNotes,
    staffStepToMidi,
    tickWidth,
    type Accidental,
    type DynamicLevel,
    type DynamicMarker,
    type NoteDuration,
    type ScoreData,
    type ScoreNote,
    type Tie,
  } from '$lib/audio/score-data';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  let cardVersion = $state(0);
  $effect(() => {
    const h = () => { cardVersion = cardVersion + 1; };
    ydoc.on('update', h);
    return () => ydoc.off('update', h);
  });

  let bpm        = $derived((void cardVersion, node?.params.bpm        ?? 120));
  let attack     = $derived((void cardVersion, node?.params.attack     ?? 0.005));
  let decay      = $derived((void cardVersion, node?.params.decay      ?? 0.1));
  let sustain    = $derived((void cardVersion, node?.params.sustain    ?? 0.7));
  let release    = $derived((void cardVersion, node?.params.release    ?? 0.3));
  let isPlaying  = $derived((void cardVersion, (node?.params.isPlaying ?? 0) >= 0.5));

  let scoreData: ScoreData = $derived.by<ScoreData>(() => {
    void cardVersion;
    const d = node?.data as Partial<ScoreData> | undefined;
    return {
      notes: Array.isArray(d?.notes) ? (d!.notes as ScoreNote[]) : [],
      dynamics: Array.isArray(d?.dynamics) ? (d!.dynamics as DynamicMarker[]) : [],
      ties: Array.isArray(d?.ties) ? (d!.ties as Tie[]) : [],
      keySignature: typeof d?.keySignature === 'number' ? d!.keySignature : 0,
    };
  });

  // ---------------- Geometry ----------------
  // SVG viewBox is 720 × 360. Each row hosts 4 bars; staff lines 8 px apart.
  // bar layout: 60..720 along the row body. 60 px before bar 1 reserved for
  // clef + key sig + (row 0) time sig.
  const SVG_W = 720;
  const SVG_H = 360;
  const ROW_TOP_Y = [70, 220];
  const STAFF_LINE_GAP = 8;
  const STAFF_LEFT_X = 60;
  const STAFF_RIGHT_X = 700;
  const BARS_X_START = 78;
  const ROW_BAR_WIDTH = (STAFF_RIGHT_X - BARS_X_START) / BARS_PER_ROW;
  const TICK_PX = ROW_BAR_WIDTH / TICKS_PER_BAR;
  const STEP_PX = 4;

  function rowOf(bar: number): 0 | 1 {
    return bar < BARS_PER_ROW ? 0 : 1;
  }
  function barLeftX(bar: number): number {
    const colInRow = bar % BARS_PER_ROW;
    return BARS_X_START + colInRow * ROW_BAR_WIDTH;
  }
  function topLineYForBar(bar: number): number {
    return ROW_TOP_Y[rowOf(bar)];
  }
  function barTickToX(bar: number, tick: number): number {
    return barLeftX(bar) + tick * TICK_PX;
  }
  function staffStepToY(bar: number, step: number): number {
    return topLineYForBar(bar) + step * STEP_PX;
  }
  function yToStaffStep(bar: number, y: number): number {
    return Math.round((y - topLineYForBar(bar)) / STEP_PX);
  }

  // ---------------- Tools / mode state ----------------
  type Tool = NoteDuration | 'sharp' | 'flat' | 'tie' | DynamicLevel;
  let activeTool: Tool = $state('quarter');

  let mode = $state<'idle' | 'tie-pick-first' | 'tie-pick-second' | 'dragging'>('idle');
  let tieFirstId: string | null = $state(null);
  let dragNoteId: string | null = $state(null);
  let dragOffsetX = $state(0);
  let dragOffsetY = $state(0);
  let dragGhost: { x: number; y: number; bar: number; tick: number; midi: number; valid: boolean } | null = $state(null);
  let shakeBar = $state<number | null>(null);
  let shakeTimer: ReturnType<typeof setTimeout> | null = null;

  function isDurationTool(t: Tool): t is NoteDuration {
    return (ALL_DURATIONS as readonly string[]).includes(t);
  }
  function isDynamicTool(t: Tool): t is DynamicLevel {
    return (ALL_DYNAMICS as readonly string[]).includes(t);
  }

  // ---------------- Yjs writers ----------------
  function writeData(mut: (d: ScoreData) => void) {
    const t = patch.nodes[id];
    if (!t) return;
    ydoc.transact(() => {
      if (!t.data) t.data = {};
      const cur: ScoreData = {
        notes: Array.isArray((t.data as Partial<ScoreData>).notes) ? [...((t.data as ScoreData).notes)] : [],
        dynamics: Array.isArray((t.data as Partial<ScoreData>).dynamics) ? [...((t.data as ScoreData).dynamics)] : [],
        ties: Array.isArray((t.data as Partial<ScoreData>).ties) ? [...((t.data as ScoreData).ties)] : [],
        keySignature: typeof (t.data as Partial<ScoreData>).keySignature === 'number' ? (t.data as ScoreData).keySignature : 0,
      };
      mut(cur);
      (t.data as Record<string, unknown>).notes = cur.notes;
      (t.data as Record<string, unknown>).dynamics = cur.dynamics;
      (t.data as Record<string, unknown>).ties = cur.ties;
      (t.data as Record<string, unknown>).keySignature = cur.keySignature;
    });
  }

  function setParam(k: string, v: number) {
    const t = patch.nodes[id]; if (t) t.params[k] = v;
  }
  function togglePlay() {
    setParam('isPlaying', isPlaying ? 0 : 1);
  }
  const live = (k: string) => () => {
    const e = engineCtx.get(); if (!e || !node) return undefined;
    return e.readParam(node, k);
  };

  function flashShake(bar: number) {
    shakeBar = bar;
    if (shakeTimer) clearTimeout(shakeTimer);
    shakeTimer = setTimeout(() => { shakeBar = null; }, 220);
  }

  // ---------------- Currently-playing-note highlight (rAF poll) ----------------
  let currentNoteId = $state<string | null>(null);
  let raf: number | null = null;
  $effect(() => {
    function frame() {
      const e = engineCtx.get();
      if (e && node) {
        const cs = e.read(node, 'currentNoteId');
        currentNoteId = (typeof cs === 'string' || cs === null) ? cs : null;
      }
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
    return () => {
      if (raf !== null) cancelAnimationFrame(raf);
      raf = null;
    };
  });
  onDestroy(() => {
    if (raf !== null) cancelAnimationFrame(raf);
    if (shakeTimer) clearTimeout(shakeTimer);
  });

  // ---------------- Hit testing ----------------
  function svgCoords(e: PointerEvent | MouseEvent, svg: SVGSVGElement): { x: number; y: number } {
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const local = pt.matrixTransform(ctm.inverse());
    return { x: local.x, y: local.y };
  }

  /** Map SVG (x, y) to (bar, tickInBar, staffStep). Returns null if outside any
   *  bar's rendering area. Rounding stays loose so the user can drop slightly
   *  off-grid and still snap. */
  function hitTest(x: number, y: number): { bar: number; tickInBar: number; step: number } | null {
    for (let row: 0 | 1 = 0; row <= 1; row++) {
      const top = ROW_TOP_Y[row];
      // Generous vertical band: 32 px above the staff (ledger lines for C6) +
      // 64 px below (ledger for C4 and a buffer).
      if (y < top - 32 || y > top + 4 * STAFF_LINE_GAP + 32) continue;
      for (let col = 0; col < BARS_PER_ROW; col++) {
        const bar = (row as 0 | 1) * BARS_PER_ROW + col;
        const x0 = barLeftX(bar);
        const x1 = x0 + ROW_BAR_WIDTH;
        if (x >= x0 - 4 && x < x1 + 4) {
          const rawTick = Math.max(0, Math.min(TICKS_PER_BAR - 1, Math.round((x - x0) / TICK_PX)));
          const step = yToStaffStep(bar, y);
          return { bar, tickInBar: rawTick, step };
        }
      }
    }
    return null;
  }

  function findNoteAt(x: number, y: number, sd: ScoreData): ScoreNote | null {
    const hit = hitTest(x, y);
    if (!hit) return null;
    for (const n of sd.notes) {
      if (n.bar !== hit.bar) continue;
      const nx = barTickToX(n.bar, n.tick);
      const w = tickWidth(n.duration) * TICK_PX;
      const ny = staffStepToY(n.bar, n.staffStep);
      if (x >= nx - 6 && x <= nx + Math.max(12, w) && Math.abs(y - ny) < 8) return n;
    }
    return null;
  }

  // ---------------- Pointer handlers ----------------
  let svgEl: SVGSVGElement | null = $state(null);

  function onSvgPointerDown(e: PointerEvent) {
    if (!svgEl) return;
    const { x, y } = svgCoords(e, svgEl);
    const sd = scoreData;
    const hit = hitTest(x, y);
    const noteUnder = findNoteAt(x, y, sd);

    if (activeTool === 'tie') {
      if (!noteUnder) return;
      e.stopPropagation();
      if (mode === 'tie-pick-first' || mode === 'idle') {
        tieFirstId = noteUnder.id;
        mode = 'tie-pick-second';
      } else if (mode === 'tie-pick-second') {
        if (tieFirstId && tieFirstId !== noteUnder.id) {
          const a = tieFirstId;
          const b = noteUnder.id;
          writeData((d) => {
            d.ties.push({ id: `tie-${crypto.randomUUID().slice(0, 8)}`, fromNoteId: a, toNoteId: b });
          });
        }
        tieFirstId = null;
        mode = 'idle';
      }
      return;
    }

    if (activeTool === 'sharp' || activeTool === 'flat') {
      e.stopPropagation();
      if (noteUnder) {
        const newAcc: Accidental = activeTool === 'sharp' ? 'sharp' : 'flat';
        writeData((d) => {
          const n = d.notes.find((m) => m.id === noteUnder.id);
          if (!n) return;
          n.accidental = n.accidental === newAcc ? null : newAcc;
          n.midi = staffStepToMidi(n.staffStep, d.keySignature, n.accidental);
        });
      } else if (hit) {
        // Click empty staff with sharp/flat tool → cycle key sig.
        writeData((d) => {
          d.keySignature = activeTool === 'sharp'
            ? cycleKeySharper(d.keySignature)
            : cycleKeyFlatter(d.keySignature);
          for (const n of d.notes) {
            if (n.accidental === null) {
              n.midi = staffStepToMidi(n.staffStep, d.keySignature, null);
            }
          }
        });
      }
      return;
    }

    if (isDynamicTool(activeTool) && hit) {
      e.stopPropagation();
      const tickInBar = quantizeTick(hit.tickInBar, '16th');
      writeData((d) => {
        d.dynamics.push({
          id: `dyn-${crypto.randomUUID().slice(0, 8)}`,
          bar: hit.bar,
          tick: tickInBar,
          level: activeTool as DynamicLevel,
        });
      });
      return;
    }

    if (isDurationTool(activeTool)) {
      if (noteUnder) {
        // Drag mode.
        e.stopPropagation();
        mode = 'dragging';
        dragNoteId = noteUnder.id;
        const nx = barTickToX(noteUnder.bar, noteUnder.tick);
        const ny = staffStepToY(noteUnder.bar, noteUnder.staffStep);
        dragOffsetX = x - nx;
        dragOffsetY = y - ny;
        try { svgEl.setPointerCapture(e.pointerId); } catch { /* */ }
        return;
      }
      if (!hit) return;
      e.stopPropagation();
      // Place a new note.
      const dur = activeTool;
      const tickInBar = quantizeTick(hit.tickInBar, dur);
      const step = Math.max(-4, Math.min(14, hit.step));
      const midi = staffStepToMidi(step, sd.keySignature, null);
      if (!canPlace(hit.bar, tickInBar, dur, midi, sd.notes)) {
        flashShake(hit.bar);
        return;
      }
      writeData((d) => {
        d.notes.push({
          id: `n-${crypto.randomUUID().slice(0, 8)}`,
          bar: hit.bar,
          tick: tickInBar,
          duration: dur,
          midi,
          staffStep: step,
          accidental: null,
        });
      });
    }
  }

  function onSvgPointerMove(e: PointerEvent) {
    if (mode !== 'dragging' || !dragNoteId || !svgEl) return;
    const { x, y } = svgCoords(e, svgEl);
    const hit = hitTest(x - dragOffsetX, y - dragOffsetY);
    if (!hit) { dragGhost = null; return; }
    const sd = scoreData;
    const note = sd.notes.find((n) => n.id === dragNoteId);
    if (!note) return;
    const tickInBar = quantizeTick(hit.tickInBar, note.duration);
    const step = Math.max(-4, Math.min(14, hit.step));
    const midi = staffStepToMidi(step, sd.keySignature, note.accidental);
    const valid = canPlace(hit.bar, tickInBar, note.duration, midi, sd.notes, note.id);
    dragGhost = { x: barTickToX(hit.bar, tickInBar), y: staffStepToY(hit.bar, step), bar: hit.bar, tick: tickInBar, midi, valid };
  }

  function onSvgPointerUp(e: PointerEvent) {
    if (mode !== 'dragging' || !dragNoteId || !svgEl) return;
    const ghost = dragGhost;
    const sd = scoreData;
    const note = sd.notes.find((n) => n.id === dragNoteId);
    try { svgEl.releasePointerCapture(e.pointerId); } catch { /* */ }
    if (note && ghost && ghost.valid) {
      const step = yToStaffStep(ghost.bar, ghost.y);
      writeData((d) => {
        const n = d.notes.find((m) => m.id === dragNoteId);
        if (!n) return;
        n.bar = ghost.bar;
        n.tick = ghost.tick;
        n.staffStep = step;
        n.midi = ghost.midi;
      });
    } else if (note && ghost && !ghost.valid) {
      flashShake(ghost.bar);
    }
    dragGhost = null;
    dragNoteId = null;
    mode = 'idle';
  }

  function onSvgContextMenu(e: MouseEvent) {
    if (activeTool === 'sharp' || activeTool === 'flat') {
      e.preventDefault();
      e.stopPropagation();
      writeData((d) => {
        d.keySignature = 0;
        for (const n of d.notes) {
          if (n.accidental === null) {
            n.midi = staffStepToMidi(n.staffStep, 0, null);
          }
        }
      });
    }
  }

  // ---------------- Glyph helpers ----------------
  // SMuFL Unicode codepoints (Bravura font). Falls back to rough Unicode shapes
  // when Bravura is missing.
  const GLYPH = {
    gClef: '',
    timeSig4: '',
    accidentalSharp: '',
    accidentalFlat: '',
    accidentalNatural: '',
    noteWhole: '',
    noteheadHalf: '',
    noteheadBlack: '',
    flag8thUp: '',
    flag8thDown: '',
    flag16thUp: '',
    flag16thDown: '',
    tupletColon: '', // tuplet 3
    rest16th: '',
  } as const;

  // Standard treble-clef positions for key-signature glyphs (top→down).
  // Sharps: F#5, C#5, G#5, D#5, A#4, E#5, B#4 — the staff steps where the
  // sharp glyph sits next to the relevant pitch.
  const SHARP_STEPS = [0, 3, 1, 4, 7, 2, 5];
  const FLAT_STEPS = [4, 1, 5, 2, 6, 3, 7];

  // ---------------- Derived rendering state ----------------
  let renderedNotes = $derived(sortNotes(scoreData.notes));

  function noteGlyph(d: NoteDuration): string {
    if (d === 'whole') return GLYPH.noteWhole;
    if (d === 'half') return GLYPH.noteheadHalf;
    return GLYPH.noteheadBlack;
  }
  function noteFlagGlyph(d: NoteDuration, stemUp: boolean): string {
    if (d === 'eighth' || d === 'triplet8th') return stemUp ? GLYPH.flag8thUp : GLYPH.flag8thDown;
    if (d === '16th') return stemUp ? GLYPH.flag16thUp : GLYPH.flag16thDown;
    return '';
  }
  function hasStem(d: NoteDuration): boolean {
    return d !== 'whole';
  }

  function pickTool(t: Tool) {
    if (mode === 'tie-pick-second') {
      tieFirstId = null;
    }
    activeTool = t;
    mode = t === 'tie' ? 'tie-pick-first' : 'idle';
  }

  function clearAll() {
    writeData((d) => {
      d.notes = [];
      d.dynamics = [];
      d.ties = [];
    });
  }

  // ---------------- Tie/slur arc renderer ----------------
  function tiePath(t: Tie): string {
    const span = notesUnderTie(t, scoreData.notes);
    if (span.length < 2) return '';
    const a = span[0]!;
    const c = span[span.length - 1]!;
    const ax = barTickToX(a.bar, a.tick) + 6;
    const ay = staffStepToY(a.bar, a.staffStep) - 4;
    const cx = barTickToX(c.bar, c.tick);
    const cy = staffStepToY(c.bar, c.staffStep) - 4;
    const midX = (ax + cx) / 2;
    const midY = Math.min(ay, cy) - 12;
    return `M${ax},${ay} Q${midX},${midY} ${cx},${cy}`;
  }
</script>

<div class="mod-card score-card" data-testid={`score-${id}`}>
  <div class="stripe" style="background: var(--cable-gate);"></div>
  <header class="title">
    Score
    <button class="play-btn" class:playing={isPlaying} onclick={togglePlay} title={isPlaying ? 'Stop' : 'Play'}>
      {isPlaying ? '■' : '▶'}
    </button>
  </header>

  <Handle type="target" position={Position.Left} id="clock"   style="top: 56px;  --handle-color: var(--cable-gate);" />
  <Handle type="target" position={Position.Left} id="attack"  style="top: 92px;  --handle-color: var(--cable-cv);" />
  <Handle type="target" position={Position.Left} id="decay"   style="top: 128px; --handle-color: var(--cable-cv);" />
  <Handle type="target" position={Position.Left} id="sustain" style="top: 164px; --handle-color: var(--cable-cv);" />
  <Handle type="target" position={Position.Left} id="release" style="top: 200px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 50px;">clk in</span>
  <span class="port-label left" style="top: 86px;">a cv</span>
  <span class="port-label left" style="top: 122px;">d cv</span>
  <span class="port-label left" style="top: 158px;">s cv</span>
  <span class="port-label left" style="top: 194px;">r cv</span>

  <Handle type="source" position={Position.Right} id="pitch" style="top: 56px;  --handle-color: var(--cable-pitch);" />
  <Handle type="source" position={Position.Right} id="gate"  style="top: 92px;  --handle-color: var(--cable-gate);" />
  <Handle type="source" position={Position.Right} id="env"   style="top: 128px; --handle-color: var(--cable-cv);" />
  <Handle type="source" position={Position.Right} id="clock" style="top: 164px; --handle-color: var(--cable-gate);" />
  <span class="port-label right" style="top: 50px;">pitch</span>
  <span class="port-label right" style="top: 86px;">gate</span>
  <span class="port-label right" style="top: 122px;">env</span>
  <span class="port-label right" style="top: 158px;">clk out</span>

  <div class="toolbar" data-testid={`score-toolbar-${id}`}>
    {#each ALL_DURATIONS as dur (dur)}
      <button
        type="button"
        class="tool"
        class:active={activeTool === dur}
        data-testid={`score-tool-${dur}`}
        title={dur}
        onclick={() => pickTool(dur)}
      >{dur === 'whole' ? '\u{1D15D}' : dur === 'half' ? '\u{1D15E}' : dur === 'quarter' ? '\u{1D15F}' : dur === 'eighth' ? '\u{1D160}' : dur === 'triplet8th' ? '3' : '\u{1D161}'}</button>
    {/each}
    <span class="sep"></span>
    <button type="button" class="tool" class:active={activeTool === 'sharp'} data-testid="score-tool-sharp" onclick={() => pickTool('sharp')} title="Sharp / key sig +1">{GLYPH.accidentalSharp}</button>
    <button type="button" class="tool" class:active={activeTool === 'flat'} data-testid="score-tool-flat" onclick={() => pickTool('flat')} title="Flat / key sig -1">{GLYPH.accidentalFlat}</button>
    <button type="button" class="tool" class:active={activeTool === 'tie'} data-testid="score-tool-tie" onclick={() => pickTool('tie')} title="Tie/slur">{'⌣'}</button>
    <span class="sep"></span>
    {#each ALL_DYNAMICS as dyn (dyn)}
      <button
        type="button"
        class="tool dyn"
        class:active={activeTool === dyn}
        data-testid={`score-tool-${dyn}`}
        title={`${dyn} (${Math.round(DYNAMIC_SCALE[dyn] * 100)}%)`}
        onclick={() => pickTool(dyn)}
      >{dyn}</button>
    {/each}
    <span class="sep"></span>
    <span class="keysig-readout" data-testid={`score-keysig-${id}`}>key: {scoreData.keySignature}</span>
    <button type="button" class="tool small" data-testid={`score-clear-${id}`} onclick={clearAll} title="Clear all notes">clear</button>
  </div>

  <svg
    bind:this={svgEl}
    class="score-svg"
    viewBox="0 0 {SVG_W} {SVG_H}"
    width={SVG_W}
    height={SVG_H}
    onpointerdown={onSvgPointerDown}
    onpointermove={onSvgPointerMove}
    onpointerup={onSvgPointerUp}
    onpointercancel={onSvgPointerUp}
    oncontextmenu={onSvgContextMenu}
    role="application"
    aria-label="Score editor"
    data-testid={`score-svg-${id}`}
  >
    <!-- Staff lines + bar lines per row -->
    {#each [0, 1] as row (row)}
      {@const yTop = ROW_TOP_Y[row]}
      <g class="staff-row">
        {#each [0, 1, 2, 3, 4] as line (line)}
          <line
            x1={STAFF_LEFT_X}
            x2={STAFF_RIGHT_X}
            y1={yTop + line * STAFF_LINE_GAP}
            y2={yTop + line * STAFF_LINE_GAP}
            stroke="var(--text-dim, #6b7280)"
            stroke-width="0.8"
          />
        {/each}
        <!-- G-clef -->
        <text x={STAFF_LEFT_X + 4} y={yTop + 4 * STAFF_LINE_GAP - 4} class="glyph clef">{GLYPH.gClef}</text>
        <!-- Time signature only on row 0 -->
        {#if row === 0}
          <text x={BARS_X_START - 14} y={yTop + 1.5 * STAFF_LINE_GAP + 4} class="glyph timesig">{GLYPH.timeSig4}</text>
          <text x={BARS_X_START - 14} y={yTop + 3.5 * STAFF_LINE_GAP + 4} class="glyph timesig">{GLYPH.timeSig4}</text>
        {/if}
        <!-- Key signature glyphs -->
        {#if scoreData.keySignature > 0}
          {#each Array(Math.min(7, scoreData.keySignature)) as _, i (i)}
            <text
              x={STAFF_LEFT_X + 28 + i * 8}
              y={yTop + (SHARP_STEPS[i] ?? 0) * STEP_PX + 4}
              class="glyph keysig"
            >{GLYPH.accidentalSharp}</text>
          {/each}
        {:else if scoreData.keySignature < 0}
          {#each Array(Math.min(7, -scoreData.keySignature)) as _, i (i)}
            <text
              x={STAFF_LEFT_X + 28 + i * 8}
              y={yTop + (FLAT_STEPS[i] ?? 0) * STEP_PX + 4}
              class="glyph keysig"
            >{GLYPH.accidentalFlat}</text>
          {/each}
        {/if}
        <!-- Bar lines -->
        {#each [0, 1, 2, 3, 4] as col (col)}
          {@const x = BARS_X_START + col * ROW_BAR_WIDTH}
          {@const isThick = col === BARS_PER_ROW && (row === 0 || row === 1)}
          <line
            x1={x} x2={x}
            y1={yTop} y2={yTop + 4 * STAFF_LINE_GAP}
            stroke="var(--text-dim, #6b7280)"
            stroke-width={isThick ? 2.4 : 0.8}
          />
        {/each}
        <!-- Bar shake overlay -->
        {#each [0, 1, 2, 3] as col (col)}
          {@const bar = row * BARS_PER_ROW + col}
          {#if shakeBar === bar}
            <rect
              class="shake"
              data-testid={`score-shake-${id}-${bar}`}
              x={BARS_X_START + col * ROW_BAR_WIDTH + 1}
              y={yTop - 4}
              width={ROW_BAR_WIDTH - 2}
              height={4 * STAFF_LINE_GAP + 8}
              fill="rgba(248, 113, 113, 0.18)"
              stroke="rgba(248, 113, 113, 0.9)"
              stroke-width="1"
            />
          {/if}
        {/each}
      </g>
    {/each}

    <!-- Dynamic markers (below each bar, italicized text) -->
    {#each scoreData.dynamics as dyn (dyn.id)}
      {@const y = topLineYForBar(dyn.bar) + 4 * STAFF_LINE_GAP + 18}
      <text
        class="dynamic"
        x={barTickToX(dyn.bar, dyn.tick)}
        y={y}
        data-testid={`score-dyn-${id}-${dyn.id}`}
      >{dyn.level}</text>
    {/each}

    <!-- Tie arcs (under notes) -->
    {#each scoreData.ties as tie (tie.id)}
      <path
        class="tie"
        data-tie-id={tie.id}
        data-testid={`score-tie-${id}-${tie.id}`}
        d={tiePath(tie)}
        fill="none"
        stroke="var(--accent, #60a5fa)"
        stroke-width="1.4"
      />
    {/each}

    <!-- Currently-playing note highlight -->
    {#each renderedNotes as n (n.id)}
      {#if currentNoteId === n.id}
        {@const w = tickWidth(n.duration) * TICK_PX}
        <rect
          class="playing"
          data-testid={`score-playing-${id}`}
          x={barTickToX(n.bar, n.tick) - 4}
          y={staffStepToY(n.bar, n.staffStep) - 8}
          width={Math.max(14, w + 8)}
          height={16}
          rx="3"
          fill="var(--cable-pitch, #fde68a)"
          fill-opacity="0.2"
          stroke="var(--cable-pitch, #fde68a)"
          stroke-opacity="1"
          stroke-width="0.8"
        />
      {/if}
    {/each}

    <!-- Notes -->
    {#each renderedNotes as n (n.id)}
      {@const x = barTickToX(n.bar, n.tick)}
      {@const y = staffStepToY(n.bar, n.staffStep)}
      {@const stemUp = n.staffStep > 4}
      <g
        class="note"
        data-note-id={n.id}
        data-testid={`score-note-${id}-${n.id}`}
        data-bar={n.bar}
        data-tick={n.tick}
        data-midi={n.midi}
        data-duration={n.duration}
      >
        <!-- Ledger lines for notes above/below the staff -->
        {#if n.staffStep < 0}
          {#each Array(Math.ceil(-n.staffStep / 2)) as _, i (i)}
            <line
              x1={x - 6} x2={x + 10}
              y1={topLineYForBar(n.bar) - (i + 1) * STAFF_LINE_GAP}
              y2={topLineYForBar(n.bar) - (i + 1) * STAFF_LINE_GAP}
              stroke="var(--text-dim, #6b7280)" stroke-width="0.8"
            />
          {/each}
        {/if}
        {#if n.staffStep > 8}
          {#each Array(Math.ceil((n.staffStep - 8) / 2)) as _, i (i)}
            <line
              x1={x - 6} x2={x + 10}
              y1={topLineYForBar(n.bar) + (4 + i + 1) * STAFF_LINE_GAP}
              y2={topLineYForBar(n.bar) + (4 + i + 1) * STAFF_LINE_GAP}
              stroke="var(--text-dim, #6b7280)" stroke-width="0.8"
            />
          {/each}
        {/if}
        <!-- Per-note accidental -->
        {#if n.accidental === 'sharp'}
          <text x={x - 10} y={y + 4} class="glyph accidental" data-acc="sharp">{GLYPH.accidentalSharp}</text>
        {:else if n.accidental === 'flat'}
          <text x={x - 10} y={y + 4} class="glyph accidental" data-acc="flat">{GLYPH.accidentalFlat}</text>
        {:else if n.accidental === 'natural'}
          <text x={x - 10} y={y + 4} class="glyph accidental" data-acc="natural">{GLYPH.accidentalNatural}</text>
        {/if}
        <!-- Notehead -->
        <text x={x} y={y + 4} class="glyph note-head">{noteGlyph(n.duration)}</text>
        <!-- Stem -->
        {#if hasStem(n.duration)}
          <line
            x1={stemUp ? x + 6 : x}
            x2={stemUp ? x + 6 : x}
            y1={y}
            y2={stemUp ? y - 28 : y + 28}
            stroke="var(--text, #cbd5e1)" stroke-width="1"
          />
          {@const flag = noteFlagGlyph(n.duration, stemUp)}
          {#if flag}
            <text
              x={stemUp ? x + 6 : x}
              y={stemUp ? y - 28 : y + 28}
              class="glyph flag"
            >{flag}</text>
          {/if}
          {#if n.duration === 'triplet8th'}
            <text x={x + 2} y={stemUp ? y - 32 : y + 36} class="tuplet">3</text>
          {/if}
        {/if}
      </g>
    {/each}

    <!-- Drag ghost -->
    {#if dragGhost}
      <rect
        class="ghost"
        data-testid={`score-ghost-${id}`}
        x={dragGhost.x - 4}
        y={dragGhost.y - 8}
        width="14"
        height="16"
        rx="2"
        fill={dragGhost.valid ? 'rgba(96, 165, 250, 0.25)' : 'rgba(248, 113, 113, 0.25)'}
        stroke={dragGhost.valid ? 'var(--accent, #60a5fa)' : '#f87171'}
        stroke-width="0.8"
      />
    {/if}
  </svg>

  <div class="fader-row">
    <Fader value={bpm}     min={30}    max={300} defaultValue={120}   label="BPM" curve="linear" onchange={(v) => setParam('bpm', v)}     readLive={live('bpm')} />
    <Fader value={attack}  min={0.001} max={10}  defaultValue={0.005} label="A"   curve="log"    units="s" onchange={(v) => setParam('attack', v)}  readLive={live('attack')} />
    <Fader value={decay}   min={0.001} max={10}  defaultValue={0.1}   label="D"   curve="log"    units="s" onchange={(v) => setParam('decay', v)}   readLive={live('decay')} />
    <Fader value={sustain} min={0}     max={1}   defaultValue={0.7}   label="S"   curve="linear" onchange={(v) => setParam('sustain', v)} readLive={live('sustain')} />
    <Fader value={release} min={0.001} max={10}  defaultValue={0.3}   label="R"   curve="log"    units="s" onchange={(v) => setParam('release', v)} readLive={live('release')} />
  </div>
</div>

<style>
  .score-card {
    width: 760px;
    min-height: 520px;
    padding-right: 0;
    padding-left: 0;
    overflow: visible;
  }
  .score-card > .title {
    padding: 0 22px;
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
    flex-wrap: wrap;
    gap: 4px;
    padding: 6px 22px 6px;
    align-items: center;
    user-select: none;
    font-family: 'Bravura', 'Bravura Text', ui-monospace, monospace;
  }
  .toolbar .tool {
    background: #14171c;
    border: 1px solid #2a2f3a;
    color: var(--text);
    border-radius: 2px;
    padding: 2px 8px;
    font-size: 1.1rem;
    line-height: 1.2;
    cursor: pointer;
    min-width: 20px;
    text-align: center;
  }
  .toolbar .tool.dyn {
    font-style: italic;
    font-family: ui-serif, serif;
    font-size: 0.85rem;
    font-weight: 700;
  }
  .toolbar .tool.small {
    font-size: 0.75rem;
    font-family: inherit;
  }
  .toolbar .tool.active {
    background: var(--accent, #60a5fa);
    color: #1a1d23;
    border-color: var(--accent, #60a5fa);
  }
  .toolbar .sep {
    width: 1px;
    background: #2a2f3a;
    align-self: stretch;
    margin: 2px 4px;
  }
  .toolbar .keysig-readout {
    color: var(--text-dim);
    font-size: 0.7rem;
    font-family: ui-monospace, monospace;
    margin-left: 4px;
  }
  .score-svg {
    display: block;
    width: 100%;
    height: auto;
    max-width: 720px;
    margin: 4px auto 0;
    background: rgba(255, 255, 255, 0.02);
    border-radius: 2px;
    cursor: crosshair;
    touch-action: none;
    font-family: 'Bravura', 'Bravura Text', serif;
  }
  .score-svg :global(.glyph) {
    font-family: 'Bravura', 'Bravura Text', serif;
    fill: var(--text, #cbd5e1);
  }
  .score-svg :global(.glyph.clef) { font-size: 36px; }
  .score-svg :global(.glyph.timesig) { font-size: 18px; }
  .score-svg :global(.glyph.note-head) { font-size: 22px; }
  .score-svg :global(.glyph.accidental) { font-size: 18px; }
  .score-svg :global(.glyph.keysig) { font-size: 18px; }
  .score-svg :global(.glyph.flag) { font-size: 22px; }
  .score-svg :global(.dynamic) {
    font-style: italic;
    font-weight: 700;
    font-family: ui-serif, serif;
    font-size: 11px;
    fill: var(--text);
  }
  .score-svg :global(.tuplet) {
    font-style: italic;
    font-family: ui-serif, serif;
    font-size: 10px;
    fill: var(--text-dim);
    text-anchor: middle;
  }
  .score-svg :global(.shake) {
    animation: score-shake 200ms ease-out;
  }
  @keyframes score-shake {
    0%, 100% { transform: translateX(0); }
    25% { transform: translateX(-3px); }
    50% { transform: translateX(3px); }
    75% { transform: translateX(-2px); }
  }
  .fader-row {
    margin-top: 12px;
    padding: 0 22px;
    gap: 8px;
  }
</style>

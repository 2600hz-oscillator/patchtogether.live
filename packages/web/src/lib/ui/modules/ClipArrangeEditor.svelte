<script lang="ts">
  // ClipArrangeEditor — the full-window pop-out arranger for CLIP PLAYER: a big
  // timeline (8 lane rows × song-time bars) with draggable clip blocks + all the
  // arrangement edit ops (SES/ARR, REC arm, REPLACE/OVERDUB, SNAP bar/beat, loop
  // length ±, cycle-clip, delete). Opened from the card's "ARR ⤢" button. Mirrors
  // the MAPPY MAP editor (full-window fixed overlay, Esc / backdrop close).
  //
  // It holds NO arrangement copy — `node` is the SAME live synced node the card
  // passes in, and ALL writes go through the shared clipplayer-arrange-edit
  // helpers (Yjs in-place discipline). During a DRAG only LOCAL state moves; ONE
  // commitMove write lands on DROP (the live-store-write-storm guard).

  import { onMount, onDestroy } from 'svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { patch, ydoc } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import type { ModuleNode } from '$lib/graph/types';
  import { CLIP_LANES, CLIP_SLOTS, type ClipPlayerData } from '$lib/audio/modules/clip-types';
  import {
    coerceArrangeData,
    arrangeBlocks,
    arrangeLengthBeats,
    snapBeat,
    type ArrangeBlock,
  } from '$lib/audio/modules/clip-arrange';
  import {
    writeArrange as writeArrangeShared,
    commitMove,
    xToBeat,
    deleteBlock,
    setBlockSlot,
    setArrangeLength,
  } from './clipplayer-arrange-edit';
  import type { ArrangeData } from '$lib/audio/modules/clip-arrange';

  let {
    id,
    node,
    onClose,
  }: {
    id: string;
    node: ModuleNode | undefined;
    onClose: () => void;
  } = $props();

  // Node-scoped re-derive (phase-2 CC perf fix): subscribe to THIS node's
  // version from the shared registry (nodes.observeDeep) instead of a
  // per-component whole-doc ydoc.on('update') pump — a commit on another
  // module no longer re-runs this card's derived chain.
  let version = $derived(nodeVersion(id));

  function dataObj(): ClipPlayerData {
    return (node?.data ?? {}) as ClipPlayerData;
  }
  /** ONE data write (mode/record flags) — same seam as the card. */
  function writeData(mut: (d: ClipPlayerData) => void) {
    const t = patch.nodes[id];
    if (!t) return;
    ydoc.transact(() => {
      if (!t.data) t.data = {};
      mut(t.data as ClipPlayerData);
    });
  }
  /** ONE arrangement write path (the shared transactional helper, bound to id). */
  function writeArrange(mut: (a: ArrangeData) => ArrangeData) {
    writeArrangeShared(id, mut);
  }

  // --- synced state mirrors (re-read on every update) ---
  let recording = $derived((void version, dataObj().recording === true));
  let arrangeMode = $derived((void version, dataObj().clipMode === 'arrangement'));
  let recordMode = $derived(
    (void version, dataObj().recordMode === 'overdub' ? 'overdub' : 'replace'),
  );
  let arrangeData = $derived.by(() => {
    void version;
    return coerceArrangeData(dataObj().arrangement);
  });
  let arrangeLen = $derived(arrangeLengthBeats(arrangeData, 4));
  let blocks = $derived(arrangeBlocks(arrangeData, arrangeLen));

  function toggleRecord() {
    writeData((d) => { d.recording = !d.recording; });
  }
  function toggleRecordMode() {
    writeData((d) => { d.recordMode = d.recordMode === 'overdub' ? 'replace' : 'overdub'; });
  }
  function toggleArrangeMode() {
    writeData((d) => { d.clipMode = d.clipMode === 'arrangement' ? 'session' : 'arrangement'; });
  }
  function nudgeLength(barsDelta: number) {
    writeArrange((a) => setArrangeLength(a, Math.max(4, arrangeLen + barsDelta * 4)));
  }

  // --- SNAP toggle (bar = 4 beats, beat = 1) ---
  let snapBar = $state(true);
  let snapTo = $derived(snapBar ? 4 : 1);

  // --- selection + edit ops ---
  let selBlock = $state<{ lane: number; startBeat: number } | null>(null);
  const isSel = (b: ArrangeBlock) =>
    !!selBlock && selBlock.lane === b.lane && Math.abs(selBlock.startBeat - b.startBeat) < 1e-6;
  function selectBlock(b: ArrangeBlock) {
    selBlock = isSel(b) ? null : { lane: b.lane, startBeat: b.startBeat };
  }
  function deleteSelected() {
    if (!selBlock) return;
    const s = selBlock;
    writeArrange((a) => deleteBlock(a, s.lane, s.startBeat));
    selBlock = null;
  }
  function cycleSelectedSlot(dir: 1 | -1) {
    if (!selBlock) return;
    const b = blocks.find(isSel);
    if (!b) return;
    const next = (b.slot + dir + CLIP_SLOTS) % CLIP_SLOTS;
    const s = selBlock;
    writeArrange((a) => setBlockSlot(a, s.lane, s.startBeat, next));
  }

  // --- big-timeline geometry ---
  const VW = 1000; // svg content width (px, viewBox)
  const LANE_H = 40; // tall lane rows (room for slot labels)
  const VH = CLIP_LANES * LANE_H;
  const laneHue = (lane: number) => Math.round((lane * 360) / CLIP_LANES);
  const blockX = (b: ArrangeBlock) => (b.startBeat / arrangeLen) * VW;
  const blockW = (b: ArrangeBlock) => Math.max(6, ((b.endBeat - b.startBeat) / arrangeLen) * VW);

  // --- live playhead (read the engine songBeat, like the card) ---
  let songBeatLive = $state(0);
  const engineCtx = useEngine();
  $effect(() => {
    void node;
    let raf = 0;
    const frame = () => {
      const e = engineCtx.get();
      if (e && node) {
        const sb = e.read(node, 'songBeat');
        if (typeof sb === 'number') songBeatLive = sb;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  });
  let playheadX = $derived(arrangeLen > 0 ? ((songBeatLive % arrangeLen) / arrangeLen) * VW : 0);

  // --- drag-to-move (horizontal/time) — LOCAL preview, ONE commitMove on drop ---
  let svgEl: SVGSVGElement | null = $state(null);
  let drag = $state<{ lane: number; startBeat: number; previewBeat: number; moved: boolean } | null>(
    null,
  );
  let suppressNextClick = false;
  function isDragging(b: ArrangeBlock): boolean {
    return !!drag && drag.lane === b.lane && Math.abs(drag.startBeat - b.startBeat) < 1e-6;
  }
  function dragX(): number {
    return drag ? (drag.previewBeat / arrangeLen) * VW : 0;
  }
  function onBlockDown(b: ArrangeBlock, ev: PointerEvent) {
    if (ev.button !== 0) return;
    // Don't select on grab (the trailing click would toggle it off). The drag
    // ghost shows via .dragging; selection happens on a plain click or a move.
    drag = { lane: b.lane, startBeat: b.startBeat, previewBeat: b.startBeat, moved: false };
    (ev.currentTarget as Element).setPointerCapture?.(ev.pointerId);
    ev.preventDefault();
    ev.stopPropagation();
  }
  function onBlockMove(ev: PointerEvent) {
    if (!drag || !svgEl) return;
    const rect = svgEl.getBoundingClientRect();
    const raw = xToBeat(ev.clientX - rect.left, rect.width, arrangeLen);
    const snapped = snapBeat(raw, snapTo);
    drag = {
      ...drag,
      previewBeat: snapped,
      moved: drag.moved || Math.abs(snapped - drag.startBeat) > 1e-6,
    };
  }
  function onBlockUp(ev: PointerEvent) {
    if (!drag) return;
    if (drag.moved) {
      commitMove(id, drag.lane, drag.startBeat, drag.previewBeat, snapTo);
      // the moved block keeps its selection at the NEW beat.
      selBlock = { lane: drag.lane, startBeat: snapBeat(drag.previewBeat, snapTo) };
      suppressNextClick = true;
    }
    try { (ev.currentTarget as Element).releasePointerCapture?.(ev.pointerId); } catch { /* */ }
    drag = null;
  }
  function onBlockClick(b: ArrangeBlock) {
    if (suppressNextClick) { suppressNextClick = false; return; }
    selectBlock(b);
  }

  function onKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') { ev.preventDefault(); onClose(); }
  }
  onMount(() => { window.addEventListener('keydown', onKey); });
  onDestroy(() => { window.removeEventListener('keydown', onKey); });

  let bars = $derived(Math.max(1, Math.ceil(arrangeLen / 4)));
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  class="editor-overlay nodrag nowheel"
  data-testid="cliparrange-editor"
  role="dialog"
  aria-label="CLIP PLAYER arranger editor"
  onpointerdown={(e) => { if (e.target === e.currentTarget) onClose(); }}
>
  <div class="editor-panel">
    <div class="editor-bar">
      <span class="title">ARRANGE · clip player</span>

      <button
        type="button"
        class="bar-btn"
        class:on={arrangeMode}
        onclick={toggleArrangeMode}
        data-testid="cliparrange-editor-mode"
        title={arrangeMode ? 'Playing the ARRANGEMENT. Click for SESSION.' : 'SESSION. Click for ARRANGEMENT.'}
      >{arrangeMode ? 'ARR' : 'SES'}</button>
      <button
        type="button"
        class="bar-btn rec"
        class:on={recording}
        onclick={toggleRecord}
        data-testid="cliparrange-editor-rec"
        title={recording ? 'Recording — click to stop' : 'Arm RECORD'}
      >● REC</button>
      <button
        type="button"
        class="bar-btn"
        class:on={recordMode === 'overdub'}
        onclick={toggleRecordMode}
        data-testid="cliparrange-editor-recmode"
        title={recordMode === 'overdub'
          ? 'OVERDUB — arming keeps the take + merges. Click for REPLACE.'
          : 'REPLACE — arming clears + records fresh. Click for OVERDUB.'}
      >{recordMode === 'overdub' ? 'OVERDUB' : 'REPLACE'}</button>
      <button
        type="button"
        class="bar-btn"
        class:on={!snapBar}
        onclick={() => (snapBar = !snapBar)}
        data-testid="cliparrange-editor-snap"
        title="Snap dragged blocks to the BAR (4 beats) or the BEAT (1)"
      >SNAP {snapBar ? 'BAR' : 'BEAT'}</button>

      <span class="len">
        <button type="button" onclick={() => nudgeLength(-1)} data-testid="cliparrange-editor-shorten" title="Shorten loop by a bar" aria-label="shorten">−</button>
        <span class="len-read">{Math.round(arrangeLen / 4)} bars</span>
        <button type="button" onclick={() => nudgeLength(1)} data-testid="cliparrange-editor-lengthen" title="Lengthen loop by a bar" aria-label="lengthen">+</button>
      </span>

      <span class="sel-ops" class:dim={!selBlock}>
        <button type="button" onclick={() => cycleSelectedSlot(-1)} disabled={!selBlock} data-testid="cliparrange-editor-prev" title="Previous clip" aria-label="prev clip">◂</button>
        <button type="button" onclick={() => cycleSelectedSlot(1)} disabled={!selBlock} data-testid="cliparrange-editor-next" title="Next clip" aria-label="next clip">▸</button>
        <button type="button" class="del" onclick={deleteSelected} disabled={!selBlock} data-testid="cliparrange-editor-del" title="Delete selected block">⌫</button>
      </span>

      <div class="spacer"></div>
      <span class="info">{blocks.length} blocks</span>
      <button
        type="button"
        class="bar-btn close"
        onclick={onClose}
        data-testid="cliparrange-editor-close"
        title="Close (Esc)"
      >✕</button>
    </div>

    <div class="editor-stage">
      <div class="stage-grid">
        <div class="lane-gutter" aria-hidden="true">
          {#each Array(CLIP_LANES) as _l, lane (lane)}
            <div class="lane-label" style={`--lane-hue:${laneHue(lane)}`}>L{lane + 1}</div>
          {/each}
        </div>
        <svg
          bind:this={svgEl}
          class="big-tl"
          viewBox={`0 0 ${VW} ${VH}`}
          preserveAspectRatio="none"
          role="img"
          aria-label="arrangement timeline"
          onpointermove={onBlockMove}
          onpointerup={onBlockUp}
          onpointercancel={onBlockUp}
          data-testid="cliparrange-editor-tl"
        >
          {#each Array(CLIP_LANES) as _l, lane (lane)}
            <rect x="0" y={lane * LANE_H} width={VW} height={LANE_H - 1}
              class="lane-bg" style={`--lane-hue:${laneHue(lane)}`} />
          {/each}
          {#each Array(bars) as _b, bar (bar)}
            <line class="bar-line" x1={(bar * 4 / arrangeLen) * VW} y1="0"
              x2={(bar * 4 / arrangeLen) * VW} y2={VH} />
          {/each}
          {#each blocks as b (b.lane + ':' + b.startBeat)}
            {@const dragging = isDragging(b)}
            {@const bx = dragging ? dragX() : blockX(b)}
            {@const bw = blockW(b)}
            <g
              class="block-g"
              role="button"
              tabindex="0"
              aria-label={`lane ${b.lane + 1} clip ${b.slot + 1} at beat ${b.startBeat}`}
              data-lane={b.lane}
              data-slot={b.slot}
              onpointerdown={(ev) => onBlockDown(b, ev)}
              onclick={() => onBlockClick(b)}
              onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectBlock(b); } }}
            >
              <rect
                class="block"
                class:sel={isSel(b)}
                class:dragging
                x={bx}
                y={b.lane * LANE_H + 3}
                width={bw}
                height={LANE_H - 7}
                style={`--lane-hue:${laneHue(b.lane)}`}
              />
              <text class="block-num" x={bx + bw / 2} y={b.lane * LANE_H + LANE_H / 2}>{b.slot + 1}</text>
            </g>
          {/each}
          <line class="playhead" x1={playheadX} y1="0" x2={playheadX} y2={VH} />
        </svg>
      </div>
      <p class="hint">
        Drag a block to move it in time (snaps to {snapBar ? 'bar' : 'beat'}) · click to select ·
        ◂ ▸ swap clip · ⌫ delete · cross-lane move is a follow-up
      </p>
    </div>
  </div>
</div>

<style>
  .editor-overlay {
    position: fixed;
    inset: 0;
    z-index: 9000;
    background: rgba(4, 6, 8, 0.86);
    backdrop-filter: blur(3px);
    display: flex;
    align-items: stretch;
    justify-content: center;
  }
  .editor-panel {
    flex: 1;
    display: flex;
    flex-direction: column;
    margin: 24px;
    border: 1px solid var(--accent, #c9f);
    border-radius: 10px;
    background: #0a0d12;
    overflow: hidden;
    box-shadow: 0 18px 60px #000a;
  }
  .editor-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid #1c2430;
    background: #11161f;
    flex-wrap: wrap;
  }
  .title {
    font: 600 0.8rem/1 ui-monospace, monospace;
    letter-spacing: 0.08em;
    color: var(--accent, #c9f);
  }
  .spacer { flex: 1; }
  .info { font: 0.7rem/1 ui-monospace, monospace; color: var(--text-dim, #8b97a6); }
  .bar-btn {
    background: #1b2230;
    border: 1px solid #2c3545;
    border-radius: 4px;
    color: var(--text, #d7dde6);
    padding: 3px 10px;
    font: 0.68rem/1 ui-monospace, monospace;
    letter-spacing: 0.05em;
    cursor: pointer;
  }
  .bar-btn.on {
    background: rgba(200, 150, 255, 0.16);
    border-color: var(--accent, #c9f);
    color: var(--accent, #c9f);
  }
  .bar-btn.rec.on {
    background: #c0392b;
    border-color: #e74c3c;
    color: #fff;
    animation: rec-blink 1s steps(2) infinite;
  }
  @keyframes rec-blink { 50% { opacity: 0.5; } }
  .bar-btn.close { color: #ff8a8a; border-color: #5a2c2c; }
  .len, .sel-ops {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .len button, .sel-ops button {
    background: #1b2230;
    border: 1px solid #2c3545;
    border-radius: 4px;
    color: var(--text, #d7dde6);
    padding: 3px 8px;
    font: 0.72rem/1 ui-monospace, monospace;
    cursor: pointer;
  }
  .len button:disabled, .sel-ops button:disabled { opacity: 0.4; cursor: not-allowed; }
  .len-read { font: 0.68rem/1 ui-monospace, monospace; color: var(--text-dim, #8b97a6); min-width: 3.2em; text-align: center; }
  .sel-ops.dim { opacity: 0.7; }
  .sel-ops .del { color: #e6a; }
  .editor-stage {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    justify-content: center;
    gap: 10px;
    padding: 16px;
    min-height: 0;
  }
  .stage-grid {
    display: flex;
    flex: 1;
    min-height: 0;
    border: 1px solid #1c2430;
    background: #050608;
  }
  .lane-gutter {
    display: flex;
    flex-direction: column;
    flex: none;
    width: 40px;
    border-right: 1px solid #1c2430;
  }
  .lane-label {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    font: 0.66rem/1 ui-monospace, monospace;
    color: hsl(var(--lane-hue) 60% 65%);
    border-bottom: 1px solid #11161f;
  }
  .big-tl {
    flex: 1;
    width: 100%;
    height: 100%;
    min-width: 0;
    touch-action: none;
    display: block;
  }
  .lane-bg { fill: hsl(var(--lane-hue) 30% 8%); }
  .bar-line { stroke: rgba(255, 255, 255, 0.08); stroke-width: 1; }
  .block-g { cursor: grab; }
  .block-g:active { cursor: grabbing; }
  .block {
    fill: hsl(var(--lane-hue) 65% 45%);
    stroke: hsl(var(--lane-hue) 70% 60%);
    stroke-width: 1;
    rx: 2;
  }
  .block.sel { stroke: #fff; stroke-width: 2.5; }
  .block.dragging { opacity: 0.85; stroke: #fff; stroke-width: 2.5; }
  .block-num {
    fill: #fff;
    font: 700 16px ui-monospace, monospace;
    text-anchor: middle;
    dominant-baseline: central;
    pointer-events: none;
    paint-order: stroke;
    stroke: #000a;
    stroke-width: 3px;
  }
  .playhead { stroke: var(--accent, #6cf); stroke-width: 2; opacity: 0.9; pointer-events: none; }
  .hint {
    margin: 0;
    color: var(--text-dim, #8b97a6);
    font: 0.72rem/1.4 ui-monospace, monospace;
    text-align: center;
  }
</style>

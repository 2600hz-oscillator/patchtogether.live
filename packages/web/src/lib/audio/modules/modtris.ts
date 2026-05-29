// packages/web/src/lib/audio/modules/modtris.ts
//
// MODTRIS — interactive Tetris-clone game module (research prototype).
//
// Single-user prototype per docs/design/game-modules.md §2 (MODTRIS:
// single-owner; multi-user is a follow-up via 30 Hz awareness snapshot).
// Gate-in: rotate_l / rotate_r / drop_fast / move_l / move_r (rising-edge
// triggered). Gate-out: line_cleared / overfill (one 5 ms pulse per event;
// a Tetris produces 4 separate line_cleared pulses).
//
// Runtime shape (mirrors PONG):
//   - Pure state stepper in modtris-state.ts (deterministic, tested).
//   - 5 AnalyserNode taps read the gate-in CVs once per scheduler-clock
//     tick; the rising-edge helper turns each into a boolean event.
//   - 2 ConstantSourceNodes for the gate outputs; on a line-clear /
//     overfill event we schedule setValueAtTime(1, t) → setValueAtTime(0,
//     t + 5ms). For a multi-line clear we issue ONE pulse PER LINE,
//     staggered by the pulse-width + a small spacer so downstream consumers
//     see N distinct edges.
//   - Live state cached on the handle; the card pulls it via
//     engine.read(node, 'snapshot') inside its own rAF.
//
// Why no audio worklet: identical to PONG — game logic runs at visual
// cadence, has no per-sample DSP, benefits from being easy to test and
// debug on the main thread. BUGGLES + PONG both use this pattern.
//
// Inputs:
//   rotate_l / rotate_r (gate): rising-edge rotate piece counter / clockwise.
//   drop_fast (gate): rising-edge fast-drop piece.
//   move_l / move_r (gate): rising-edge horizontal move.
//
// Outputs:
//   line_cleared (gate): one 5 ms pulse per cleared line (Tetris = 4 staggered pulses).
//   overfill (gate): one 5 ms pulse when the well overfills (game over).
//
// Params:
//   gravityBpm (log 30..240, default 60): drop-tick tempo.
//   levelStep (linear 1..20, default 10): lines-per-level threshold (controls difficulty ramp).

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { getSchedulerClock, SCHEDULER_TICK_MS } from '$lib/audio/scheduler-clock';
import {
  initModtrisState,
  stepModtrisState,
  detectRisingEdge,
  type ModtrisInputs,
  type ModtrisParams,
  type ModtrisState,
} from './modtris-state';

export type { ModtrisState, ModtrisParams } from './modtris-state';

/** Gate pulse width in seconds. Matches BUGGLES / PONG (CLOCK_PULSE_MS). */
const GATE_PULSE_S = 0.005;
/** Spacer between back-to-back pulses on the same gate (e.g. a Tetris
 *  fires 4 line_cleared pulses). Must be > 0 so consumers see distinct edges. */
const GATE_SPACER_S = 0.005;
/** Schedule cushion — see PONG's identical comment. */
const SCHEDULE_CUSHION_S = 0.005;

export const modtrisDef: AudioModuleDef = {
  type: 'modtris',
  domain: 'audio',
  label: 'MODTRIS',
  category: 'games',
  schemaVersion: 1,
  vizPassthrough: true,

  inputs: [
    // Gate inputs — bipolar/unipolar CV, but the stepper only cares about
    // rising-edge crossings of 0.5. No paramTarget; we read via analyser
    // taps each tick (same pattern as PONG's paddle CVs).
    { id: 'rotate_l',  type: 'gate' },
    { id: 'rotate_r',  type: 'gate' },
    { id: 'drop_fast', type: 'gate' },
    { id: 'move_l',    type: 'gate' },
    { id: 'move_r',    type: 'gate' },
  ],
  outputs: [
    { id: 'line_cleared', type: 'gate' },
    { id: 'overfill',     type: 'gate' },
  ],
  params: [
    {
      id: 'gravityBpm', label: 'Drop',
      defaultValue: 60, min: 30, max: 240, curve: 'log',
    },
    {
      id: 'levelStep', label: 'Lvl',
      defaultValue: 10, min: 1, max: 20, curve: 'linear',
    },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    // ---- Gate-in analyser taps (5 of them) -----------------------------
    // Mirrors PONG. Each tap is a small-fftSize AnalyserNode; we read the
    // tail sample of getFloatTimeDomainData per tick and compare to the
    // previous tick's tail to detect a rising edge.
    function makeGateTap() {
      const a = ctx.createAnalyser();
      a.fftSize = 32;
      a.smoothingTimeConstant = 0;
      const buf = new Float32Array(32);
      return {
        node: a,
        read(): number {
          a.getFloatTimeDomainData(buf);
          return buf[buf.length - 1] ?? 0;
        },
      };
    }
    const rotateLTap  = makeGateTap();
    const rotateRTap  = makeGateTap();
    const dropFastTap = makeGateTap();
    const moveLTap    = makeGateTap();
    const moveRTap    = makeGateTap();
    let lastRotateL = 0, lastRotateR = 0, lastDropFast = 0, lastMoveL = 0, lastMoveR = 0;

    // ---- Gate outputs --------------------------------------------------
    const lineClearedSrc = ctx.createConstantSource();
    lineClearedSrc.offset.value = 0;
    lineClearedSrc.start();
    const overfillSrc = ctx.createConstantSource();
    overfillSrc.offset.value = 0;
    overfillSrc.start();

    /** Schedule N pulses on `src`, each `GATE_PULSE_S` wide and separated by
     *  `GATE_SPACER_S`. Used for line-clear so a Tetris fires 4 edges. */
    function pulseGateNTimes(src: ConstantSourceNode, n: number): void {
      if (n <= 0) return;
      const t0 = ctx.currentTime + SCHEDULE_CUSHION_S;
      try { src.offset.cancelScheduledValues(t0); } catch { /* */ }
      for (let i = 0; i < n; i++) {
        const t = t0 + i * (GATE_PULSE_S + GATE_SPACER_S);
        src.offset.setValueAtTime(1, t);
        src.offset.setValueAtTime(0, t + GATE_PULSE_S);
      }
    }
    function pulseGateOnce(src: ConstantSourceNode): void {
      pulseGateNTimes(src, 1);
    }

    // ---- Param cache + state -------------------------------------------
    const params: ModtrisParams = {
      gravityBpm: (node.params ?? {}).gravityBpm ?? 60,
      levelStep:  (node.params ?? {}).levelStep  ?? 10,
    };
    let state: ModtrisState = initModtrisState();

    // ---- Scheduler tick subscription -----------------------------------
    // Each tick: sample all 5 gate inputs, edge-detect, step the stepper,
    // fire output gates for any emitted events.
    const dtSeconds = SCHEDULER_TICK_MS / 1000;
    const tick = () => {
      const rL = rotateLTap.read();
      const rR = rotateRTap.read();
      const dF = dropFastTap.read();
      const mL = moveLTap.read();
      const mR = moveRTap.read();
      const inputs: ModtrisInputs = {
        rotateL:  detectRisingEdge(lastRotateL,  rL),
        rotateR:  detectRisingEdge(lastRotateR,  rR),
        dropFast: detectRisingEdge(lastDropFast, dF),
        moveL:    detectRisingEdge(lastMoveL,    mL),
        moveR:    detectRisingEdge(lastMoveR,    mR),
      };
      lastRotateL = rL; lastRotateR = rR; lastDropFast = dF; lastMoveL = mL; lastMoveR = mR;

      state = stepModtrisState(state, inputs, params, dtSeconds);

      if (state.events.linesCleared > 0) {
        pulseGateNTimes(lineClearedSrc, state.events.linesCleared);
      }
      if (state.events.overfill) {
        pulseGateOnce(overfillSrc);
      }
    };
    const unsubscribe = getSchedulerClock().subscribe(tick);

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['rotate_l',  { node: rotateLTap.node,  input: 0 }],
        ['rotate_r',  { node: rotateRTap.node,  input: 0 }],
        ['drop_fast', { node: dropFastTap.node, input: 0 }],
        ['move_l',    { node: moveLTap.node,    input: 0 }],
        ['move_r',    { node: moveRTap.node,    input: 0 }],
      ]),
      outputs: new Map([
        ['line_cleared', { node: lineClearedSrc, output: 0 }],
        ['overfill',     { node: overfillSrc,    output: 0 }],
      ]),
      setParam(paramId, value) {
        if (paramId === 'gravityBpm' || paramId === 'levelStep') {
          params[paramId] = value;
        }
      },
      readParam(paramId) {
        if (paramId === 'gravityBpm' || paramId === 'levelStep') {
          return params[paramId];
        }
        return undefined;
      },
      read(key) {
        if (key === 'snapshot') return state;
        return undefined;
      },
      dispose() {
        unsubscribe();
        try { lineClearedSrc.stop(); } catch { /* */ }
        try { overfillSrc.stop();    } catch { /* */ }
        lineClearedSrc.disconnect();
        overfillSrc.disconnect();
        rotateLTap.node.disconnect();
        rotateRTap.node.disconnect();
        dropFastTap.node.disconnect();
        moveLTap.node.disconnect();
        moveRTap.node.disconnect();
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Pure draw function — shared between the on-card 2D canvas and any future
// cross-domain video bridge. 16-bit pixel-perfect aesthetic, matching PONG.
// ---------------------------------------------------------------------------

import { COLS, ROWS, PIECE_COLOR_INDEX, pieceCells } from './modtris-state';

/** Standard Tetris-color palette indexed by PIECE_COLOR_INDEX (1..7). */
const COLOR_PALETTE: Record<number, string> = {
  1: '#00f0f0', // I — cyan
  2: '#f0f000', // O — yellow
  3: '#a000f0', // T — purple
  4: '#00f000', // S — green
  5: '#f00000', // Z — red
  6: '#0000f0', // J — blue
  7: '#f0a000', // L — orange
};

export interface ModtrisDrawOpts {
  /** Pixels per cell in CSS units. */
  cellPx?: number;
  /** Foreground line color (grid). */
  grid?: string;
  /** Background. */
  bg?: string;
  /** Border color for locked + active cells. */
  outline?: string;
}

export function drawModtris(
  ctx2d: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  state: ModtrisState,
  w: number,
  h: number,
  opts: ModtrisDrawOpts = {},
): void {
  const grid = opts.grid ?? '#1a2030';
  const bg = opts.bg ?? '#0b121a';
  const outline = opts.outline ?? '#0b121a';

  // Background.
  ctx2d.fillStyle = bg;
  ctx2d.fillRect(0, 0, w, h);

  // Calculate cell size to fit the well into the canvas. Reserve a 30%
  // right strip for the "next piece" preview + line count.
  const wellWidthPx = Math.floor(w * 0.7);
  const cellPx = opts.cellPx ?? Math.floor(Math.min(wellWidthPx / COLS, h / ROWS));
  const wellX = 0;
  const wellY = Math.floor((h - cellPx * ROWS) / 2);

  // Grid background.
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      ctx2d.fillStyle = grid;
      ctx2d.fillRect(wellX + c * cellPx, wellY + r * cellPx, cellPx - 1, cellPx - 1);
    }
  }

  // Locked cells.
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const v = state.well[r * COLS + c]!;
      if (v === 0) continue;
      drawCell(ctx2d, wellX + c * cellPx, wellY + r * cellPx, cellPx, COLOR_PALETTE[v] ?? '#fff', outline);
    }
  }

  // Active piece.
  if (state.piece) {
    const color = COLOR_PALETTE[PIECE_COLOR_INDEX[state.piece.kind]!] ?? '#fff';
    for (const [c, r] of pieceCells(state.piece)) {
      if (r < 0 || r >= ROWS) continue;
      drawCell(ctx2d, wellX + c * cellPx, wellY + r * cellPx, cellPx, color, outline);
    }
  }

  // Right strip: NEXT label + next piece preview + line count.
  const stripX = wellX + cellPx * COLS + 6;
  const stripW = w - stripX - 4;
  if (stripW > 20) {
    ctx2d.fillStyle = '#dafff7';
    ctx2d.font = '700 9px ui-monospace, monospace';
    ctx2d.textAlign = 'left';
    ctx2d.textBaseline = 'top';
    ctx2d.fillText('NEXT', stripX, wellY);

    // Mini preview of state.queue[0]. Use a smaller cellPx.
    const next = state.queue[0];
    if (next) {
      const miniCell = Math.max(4, Math.floor(cellPx * 0.6));
      const previewY = wellY + 14;
      const color = COLOR_PALETTE[PIECE_COLOR_INDEX[next]!] ?? '#fff';
      // Render the piece at rotation 0 in a 4-cell grid.
      const cells = pieceCells({ kind: next, rotation: 0, col: 0, row: 0 });
      for (const [c, r] of cells) {
        drawCell(ctx2d, stripX + c * miniCell, previewY + r * miniCell, miniCell, color, outline);
      }
    }

    // Line count.
    ctx2d.fillStyle = '#dafff7';
    ctx2d.font = '700 11px ui-monospace, monospace';
    ctx2d.fillText('LN', stripX, wellY + 90);
    ctx2d.fillText(String(state.lines), stripX, wellY + 102);
  }
}

function drawCell(
  ctx2d: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  fill: string,
  outline: string,
): void {
  ctx2d.fillStyle = fill;
  ctx2d.fillRect(x, y, size - 1, size - 1);
  ctx2d.fillStyle = outline;
  ctx2d.fillRect(x, y, size - 1, 1);
  ctx2d.fillRect(x, y, 1, size - 1);
}

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
//
// ⚠ `vizPassthrough: true` IS A LICENCE, NOT A WORKING PATH, and the
// user-facing prose that promised otherwise has been removed from
// `docs.explanation`. `GROUP_VIZ_HOST_TYPES` is `new Set(['scope'])`, so
// GroupCard opens a portal slot for this module and mounts nothing into it —
// measured `canvasInSlot 0` for modtris (and frogger / pong / nibbles) against
// SCOPE's 1, recorded in `group-viz-hosts.test.ts` and tracked as #1755. The
// flag stays declared because it is what the eventual host fix reads. The
// well's real home is the DOCK FACEPLATE BODY (see `face.extension` below).

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { getSchedulerClock, SCHEDULER_TICK_MS } from '$lib/audio/scheduler-clock';
import { mulberry32 } from '$lib/sync/prng';
import {
  initModtrisState,
  stepModtrisState,
  detectRisingEdge,
  type ModtrisInputs,
  type ModtrisParams,
  type ModtrisState,
  type Rng,
} from './modtris-state';

export type { ModtrisState, ModtrisParams } from './modtris-state';

/** Gate pulse width in seconds. Matches BUGGLES / PONG (CLOCK_PULSE_MS). */
const GATE_PULSE_S = 0.005;
/** Spacer between back-to-back pulses on the same gate (e.g. a Tetris
 *  fires 4 line_cleared pulses). Must be > 0 so consumers see distinct edges. */
const GATE_SPACER_S = 0.005;
/** Schedule cushion — see PONG's identical comment. */
const SCHEDULE_CUSHION_S = 0.005;

/**
 * How many ticks the VRT pin steps when `__modtrisVrtTicks` is absent.
 *
 * ⚠ NOT A POPULATION COUNT — it is a POSITION on the game's own timeline.
 * 1600 ticks x 25 ms = 40 s of play at the default 60 BPM gravity, which is far
 * enough in that pieces have LOCKED and the well carries a real stack, so the
 * pinned frame differs from the boot frame in the well AND in the NEXT queue
 * and cannot be reached by a stepper that never ran. Both capture paths set the
 * global explicitly; this is the value a bare seed gets.
 */
const VRT_DEFAULT_PINNED_TICKS = 1600;

/** All five gate edges low — what the pinned sim runs with, since a VRT scene
 *  patches nothing into the steering inputs. */
const NO_INPUT_EDGES: ModtrisInputs = {
  rotateL: false, rotateR: false, dropFast: false, moveL: false, moveR: false,
};

export const modtrisDef: AudioModuleDef = {
  type: 'modtris',
  palette: { top: 'Games', sub: 'Arcade' },
  domain: 'audio',
  label: 'modtris',
  category: 'games',
  vizPassthrough: true,

  inputs: [
    // Gate inputs — bipolar/unipolar CV, but the stepper only cares about
    // rising-edge crossings of 0.5. No paramTarget; we read via analyser
    // taps each tick (same pattern as PONG's paddle CVs).
    { id: 'rotate_l',  type: 'gate', edge: 'trigger' },
    { id: 'rotate_r',  type: 'gate', edge: 'trigger' },
    { id: 'drop_fast', type: 'gate', edge: 'trigger' },
    { id: 'move_l',    type: 'gate', edge: 'trigger' },
    { id: 'move_r',    type: 'gate', edge: 'trigger' },
  ],
  outputs: [
    { id: 'line_cleared', type: 'gate', edge: 'trigger' },
    { id: 'overfill',     type: 'gate', edge: 'trigger' },
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

  // ── THE FACEPLATE ────────────────────────────────────────────────────────
  //
  // THE TIER LADDER, read back as a sentence: at mini you get DROP; at compact
  // and above, DROP and LVL; at the dock, both plus THE WELL. Derived through
  // `curatedFace` in modtris-face-model.test.ts, never read off the cap
  // constants — four sibling faces got that wrong by reading `FACE_TIER_CAPS`
  // directly, which is the pre-reconciliation number rather than what the lane
  // actually fits.
  //
  // ⚠ THE RANK. `gravityBpm` is the module's TEMPO, and on a module whose two
  // outputs are GATES that is rank 1 by definition — everything downstream of
  // `line_cleared` is clocked by how fast the stack fills. It is also the param
  // read on EVERY step (`gravitySecondsPerDrop`), so its effect lands on the
  // next frame. THE LOSER, NAMED: `levelStep` lost mini to it because a
  // threshold that changes difficulty over the next several minutes is not a
  // control a 46 px lane column can serve.
  //
  // ⚠ AND THE RANK ONLY BECAME DEFENSIBLE IN THIS DIFF. `levelStep` was read by
  // NOTHING until the ramp landed in `modtris-state.ts` — declared, faded,
  // contract-locked, documented as a difficulty ramp, and inert. Ranking a dead
  // control 2 of 2 would have baked the defect into the UI, so the wiring and
  // the face ship together.
  //
  // ⚠ `glyph: 'none'` IS FORCED, and that is measured rather than assumed. Both
  // outputs are `type: 'gate'`, so `primaryAudioOutPortId` is NULL and every
  // LIVE glyph kind — scope, meter, envelope, waveform — resolves
  // `{kind:'static'}` and is refused by the dead-glyph clause. `'algorithm'`
  // still RESOLVES since #2160 widened it, and it is refused on its own merits:
  // a null `paramId` means the shell feeds `topologyValue: 0`, and
  // `ShellExtensionGlyphProps` is `{num, numbers?, testid?}` with NO `nodeId`,
  // so the component could not resolve a graph node and could not reach the
  // game snapshot. It would be one constant picture, identical on every modtris
  // in the rack forever. Pinned both ways, including the counterfactual, in
  // modtris-face-model.test.ts. ⚠ SO THE LANE TILE STILL HAS NO WELL. That is
  // not a regression — modtris is not in `NON_SHELL_LANE_TYPES`, is not a
  // `CARD_PRODUCER` and is not in `HEADLESS_MOUNT_LANE_TYPES`, so
  // `laneRenderKind` already returned 'placeholder' and the shipping shell
  // mounted NO modtris surface at all while the game ran and pulsed gates
  // underneath — but it is not the fix either.
  face: {
    order: ['gravityBpm', 'levelStep'],
    glyph: 'none',
    // ONE band. Both params answer the same question — HOW HARD IS THIS GAME —
    // and splitting them would invent a distinction the module does not have.
    // ⚠ `order` and `pages` AGREE, unusual for this house style and stated so a
    // reader does not go hunting for the disagreement. A tab rail needs
    // DOCK_TAB_MIN_BANDS = 7 bands and NOTHING IS PADDED to reach one.
    pages: [{ id: 'fall', label: 'fall', controls: ['gravityBpm', 'levelStep'] }],
    // ⚠ DECLARED, AND THE REASON IS PARITY RATHER THAN TASTE. The legacy card
    // renders both as `<NeonFader>`; without `paramCells` the shell derives
    // KNOBS and a player's muscle memory for a vertical throw lands on a rotary.
    // ⚠ Note the divergence from the sibling: `frogger` declares NOTHING here
    // because `FroggerCard` draws a `<Knob>`. Each face matches its OWN card;
    // copying across the family would be a parity loss nothing gates.
    paramCells: { gravityBpm: 'fader', levelStep: 'fader' },
    // The well. See $lib/ui/modules/modtris/shell-extension.ts.
    extension: 'modtris',
    // ⚠ AUTHORED RATHER THAN DERIVED. All five inputs are `gate` with NO
    // `paramTarget` — they are the module's real signal inputs, not CV holes for
    // a ranked param — so the rail would otherwise be five anonymous jacks.
    // ⚠ THE IDS ARE NOT FREE: an input group must claim the LEADING slot
    // ('voice'/'signal') or name a declared page, or it appends as a stray band
    // after every page and the rear totality gate cannot see it
    // (module-face-lint). The four steering triggers take the leading 'signal'
    // slot — they ARE what you play the module with — and DROP takes the 'fall'
    // page's own slot, beside the gravity fader that shares that band. The
    // OUTPUT rail takes the derived default (both `gate`, one section).
    rear: {
      groups: [
        { id: 'signal', label: 'steer', ports: ['move_l', 'move_r', 'rotate_l', 'rotate_r'] },
        { id: 'fall', label: 'drop', ports: ['drop_fast'] },
      ],
    },
  },

  docs: {
    explanation:
      "A playable Tetris-style block-stacking game wrapped as a CV/gate module — the falling-block gameplay drives the patch. Pieces drop into a 10×20 well at a tempo you set (DROP); you steer and rotate them with five gate inputs, and the game emits gate pulses on the events it produces: every line cleared and an overfill (game over). So a sequencer or clock pattern playing the game becomes a generative trigger source whose rhythm follows the stacking — a four-line 'Tetris' fires four separate LINE pulses in quick succession. You DON'T touch a surface to play: you patch gates into MOVE L/R, ROT L/R and DROP, and the well accumulates every decision you have made, so the same input pattern produces a different output rate ten seconds later. The well + next-piece preview + line count render on a 2D canvas at the head of the module's dock faceplate (and on the legacy card), and there is no video output port — MODTRIS speaks in gates, and the well is how you read what it is saying. DROP sets the gravity tempo and LVL sets how many cleared lines it takes to speed it up.",
    inputs: {
      rotate_l: "Rotate the current piece counter-clockwise on each rising edge — one quarter-turn per pulse (acts on the leading edge only, so a held gate rotates once).",
      rotate_r: "Rotate the current piece clockwise on each rising edge — one quarter-turn per pulse.",
      drop_fast: "Hard/fast-drop the current piece on each rising edge — slams it down a step (or to the bottom) per pulse, locking it sooner.",
      move_l: "Move the current piece one column LEFT on each rising edge — one cell per pulse.",
      move_r: "Move the current piece one column RIGHT on each rising edge — one cell per pulse.",
    },
    outputs: {
      line_cleared:
        "Fires a 5 ms pulse for each line cleared — a single clear is one pulse, a Tetris (four lines at once) emits FOUR distinct staggered pulses so a downstream counter or envelope sees each line. Patch into a drum/envelope trigger to sonify clears.",
      overfill:
        "Fires a single 5 ms pulse when the well overfills (a piece locks above the top = game over). Use it as an end-of-run trigger — fire a sound, reset a scene, or restart another module.",
    },
    controls: {
      gravityBpm:
        "DROP gravity tempo in BPM (30..240, log, default 60) — how fast pieces fall on their own before the LVL ramp is applied. Higher = faster, more frantic stacking (and a denser stream of LINE/OVERFILL pulses). It is read on every scheduler tick, so a move lands on the next drop rather than the next piece. MIDI-learnable.",
      levelStep:
        "LVL threshold (1..20, default 10) — how many cleared lines it takes to advance a level. Each level multiplies the time between automatic drops by 0.85, so the game gets ~18% faster per level on top of whatever DROP is set to, down to a floor of 50 ms per row. Lower = a steeper difficulty curve: at LVL 1 every cleared line speeds the game up. It applies to the RUNNING game — the level is re-derived from the line count on every tick, so moving this fader mid-game re-prices the ramp immediately rather than at the next level-up — and an overfill resets the line count, and with it the level, to zero. MIDI-learnable.",
    },
  },

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
    let rng: Rng = Math.random;
    let state: ModtrisState = initModtrisState({ rng });

    // ---- Scheduler tick subscription -----------------------------------
    // Each tick: sample all 5 gate inputs, edge-detect, step the stepper,
    // fire output gates for any emitted events.
    const dtSeconds = SCHEDULER_TICK_MS / 1000;

    // ── THE VRT DETERMINISM PIN — A SEED *AND* A TICK COUNT ────────────────
    //
    // ⚠ MODTRIS NEEDS BOTH, AND THAT IS THE DIFFERENCE FROM FROGGER. frogger's
    // stepper has no `Math.random` anywhere, so a tick count alone made its
    // board a pure function of (ticks, params). modtris has a 7-BAG
    // FISHER-YATES SHUFFLE (`refillQueueIfNeeded`), so the tick count alone
    // fixes HOW FAR the sim ran and not WHICH pieces it ran with.
    //
    // ⚠ AND THE SEED ALONE IS NOT ENOUGH EITHER, which is measured on the
    // sibling with this exact topology rather than assumed: pong drifted 72
    // differing pixels at max channel delta 237 across two ubuntu boots WITH a
    // seed, because a seed fixes WHICH trajectory and cannot fix how far along
    // it the capture landed. The number of scheduler ticks that land before the
    // harness's screenshot is a function of boot speed.
    //
    // So the pin does both: it rebuilds the state under `mulberry32(seed)`,
    // steps it a FIXED number of ticks, and then STOPS TICKING ALTOGETHER. The
    // well is TIME-INVARIANT rather than frozen at whatever moment the harness
    // reached — lushgarden's and pong's shape. That matters more here than
    // almost anywhere, because the game clock is a Web Worker `setInterval`
    // that is NOT gated on the AudioContext, so the harness's audio suspend
    // could never have stopped this game.
    //
    // ⚠ NO `freeze` ParamDef, DELIBERATELY. A `params` edit is in contract-lock
    // (and, on a def in the WebGL basis, in the attest hash), so it costs a
    // contract re-pin and buys only INTRA-boot stillness — it holds whichever
    // frame the harness caught, a different frame per boot. A boot-time global
    // costs neither and buys time-invariance. Reach for a ParamDef only when no
    // boot-time global can reach the seam (a WORKER `renderLocus` is that case;
    // this factory is main-thread).
    //
    // ⚠ READ TWICE — AT CONSTRUCTION AND ONCE MORE IN THE TICK — because the
    // two capture paths install the globals at different moments. The FACE
    // harness uses `simPin`, i.e. `addInitScript` BEFORE `goto`, so they are
    // already there when this factory runs. The CARD scene (`vrt-scenes.ts`)
    // sets them from `afterSpawn`, i.e. AFTER construction. A construction-only
    // read would leave the card scene silently unpinned — a dead pin that
    // produces a plausible well and a different one on every boot.
    //
    // ⚠ NOTHING IN THE APP EVER SETS EITHER GLOBAL.
    //
    // ⚠ DOOM IS EXCLUDED FROM THIS MECHANISM BY NAME. It is the other game
    // module in the tree and it must never be re-timed: `runtime.runTic()` is
    // called inside its `surface.draw`, so DOOM's game clock IS its frame clock
    // and pinning ticks would re-specify how far the marine walks. No DOOM file
    // was opened for this change.
    let vrtPinned = false;
    function readVrtPin(): { seed: number; ticks: number } | undefined {
      const g = globalThis as { __modtrisVrtSeed?: number; __modtrisVrtTicks?: number };
      const seed = g.__modtrisVrtSeed;
      if (typeof seed !== 'number' || !Number.isFinite(seed)) return undefined;
      const t = g.__modtrisVrtTicks;
      const ticks = typeof t === 'number' && Number.isFinite(t) && t >= 0
        ? Math.floor(t)
        : VRT_DEFAULT_PINNED_TICKS;
      return { seed: seed | 0, ticks };
    }
    function applyVrtPin(seed: number, ticks: number): void {
      // ONE generator for the init bag AND every refill, so the stream
      // continues rather than restarting — handing the stepper a second
      // generator would make the capture deterministic only until the first bag
      // ran out.
      rng = mulberry32(seed);
      state = initModtrisState({ rng });
      for (let i = 0; i < ticks; i++) {
        state = stepModtrisState(state, NO_INPUT_EDGES, params, dtSeconds, { rng });
      }
      vrtPinned = true;
    }
    const bootPin = readVrtPin();
    if (bootPin !== undefined) applyVrtPin(bootPin.seed, bootPin.ticks);

    const tick = () => {
      // ⚠ THE PIN COMES FIRST AND RETURNS. Letting the clock advance the well
      // even once re-introduces the boot-speed dependence the pin exists to
      // remove. This is the "suppress all further stepping" half, not a freeze.
      if (vrtPinned) return;
      // The LATE install (the card scene's `afterSpawn`). One-shot: once it
      // fires, the branch above owns every subsequent tick.
      const latePin = readVrtPin();
      if (latePin !== undefined) {
        applyVrtPin(latePin.seed, latePin.ticks);
        return;
      }
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

      state = stepModtrisState(state, inputs, params, dtSeconds, { rng });

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

    // Line count + difficulty level.
    //
    // ⚠ PAINTED INTO THE CANVAS BY THE MODULE'S OWN FUNCTION, which is what the
    // resting-text ruling allows: a game's score inside its playfield is the
    // game's artwork, and the strip is 30 % of the canvas by construction
    // (`wellWidthPx = w * 0.7`) rather than slack to be reclaimed. A `LINES 17`
    // or `LEVEL 2` row rendered as CHROME BESIDE the well would be the refused
    // hero-readout shape and neither surface has one.
    //
    // ⚠ `LV` IS NEW IN THIS DIFF and it is here because `levelStep` is newly
    // WIRED: without it the only evidence a level advanced is that the pieces
    // feel faster, which is indistinguishable from someone having moved DROP.
    ctx2d.fillStyle = '#dafff7';
    ctx2d.font = '700 11px ui-monospace, monospace';
    ctx2d.fillText('LN', stripX, wellY + 90);
    ctx2d.fillText(String(state.lines), stripX, wellY + 102);
    ctx2d.fillText('LV', stripX, wellY + 120);
    ctx2d.fillText(String(state.level), stripX, wellY + 132);
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

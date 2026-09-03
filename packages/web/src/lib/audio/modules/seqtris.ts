// packages/web/src/lib/audio/modules/seqtris.ts
//
// SEQTRIS — an 8×8 Tetris you play on a Launchpad, wired into the rack as a
// clocked note source.
//
// The RULES are not here. Every one of them — the piece set, rotation, the
// tracked square, line clears, the note derivation and the speed ladder — lives
// in the PURE core (`seqtris-engine.ts`) so it can be pinned exactly by unit
// tests. This file is the WIRING: a clock input, four output ports, a Launchpad
// claim and a card API.
//
// ── THE PORTS ────────────────────────────────────────────────────────────────
//   in   clock   trigger. Gravity is counted in PULSES on this jack, never in
//                milliseconds — see the divisor ladder below.
//   out  piece   polyPitchGate. A note whenever the current piece moves.
//   out  board   polyPitchGate. STUBBED: declared and silent, per the spec.
//   out  line    trigger. One pulse per cleared row.
//   out  spawn   trigger. One pulse per new piece.
//
// ── GRAVITY IS A CLOCK DIVISOR, AND THAT IS THE WHOLE TEMPO DESIGN ───────────
// One row every GRAV pulses. Clearing a line steps GRAV down the ladder to the
// next integer that approximates +10% speed, so the game gets faster WITHOUT
// ever leaving the clock grid: a gravity step and a spawn land on a clock edge
// before the level-up and after it. A fractional "+10%" would buy the exact
// percentage and lose the alignment, and the spec asks for the alignment.
//
// At the default GRAV of 8, a TIMELORDE 8x (32nd-note) clock at 90 bpm is one
// row per beat — the owner's "comfortable-to-slow" start. The ladder from 8 is
// 8·7·6·5·4·3·2·1, eight levels; a finer clock (CV BUDDY at 24 or 48 PPQN with
// GRAV to match) buys ~10%-sized rungs instead of the coarse ones near the end.
//
// ── QUANT ────────────────────────────────────────────────────────────────────
// The spec asks for "piece movements and spawns that line up 1-1 with clock
// events". With QUANT on (the default) a button press is LATCHED and applied on
// the next clock pulse, so every note this module emits is on the grid. With it
// off a press moves the piece the instant it arrives, which is how a video game
// feels and how an unquantized performance sounds. ⚠ With NOTHING patched into
// `clock` a latched press would never be applied at all, so an unpatched clock
// always plays free regardless of QUANT — a module that eats its input because
// a jack is empty is broken, not quantized.
//
// ── THE LAUNCHPAD ────────────────────────────────────────────────────────────
// CONNECT → pick a port → the 8×8 pads become the board and the right-hand
// scene column becomes the controls. See `$lib/audio/seqtris-launchpad`, which
// owns the claim and the LED writes; the picture is repainted on every state
// change rather than on a timer, because that is exactly when it changes.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { patch as livePatch } from '$lib/graph/store';
import { getSchedulerClock, SCHEDULER_TICK_MS } from '$lib/audio/scheduler-clock';
import { createEdgeCounter } from '$lib/audio/edge-detect';
import { createPolySender, POLY_CHANNEL_PAIRS, type PolySender } from '$lib/audio/poly';
import { midiToVOct } from '$lib/audio/note-entry';
import { isInputPortConnected } from './transport-helpers';
import {
  acquireSeqtrisLaunchpad,
  type SeqtrisLaunchpadBinding,
  type SeqtrisLaunchpadStatus,
} from '$lib/audio/seqtris-launchpad';
import type { LaunchpadPort } from '$lib/control/launchpad/launchpad-device.svelte';
import {
  applyInput,
  clockPulse,
  coalesceSeqtrisNotes,
  createSeqtrisState,
  divisorLadder,
  renderBoard,
  setBaseDivisor,
  SEQTRIS_DEFAULT_DIVISOR,
  type SeqtrisEvent,
  type SeqtrisInput,
  type SeqtrisPieceId,
  type SeqtrisState,
} from './seqtris-engine';

/** Trigger width on `line` / `spawn`. */
const PULSE_SEC = 0.01;
/** Spacing between the pulses of a MULTI-line clear, so two rows read as two
 *  hits rather than one wide one. */
const LINE_STAGGER_SEC = 0.02;
/** Gate-low window between two Piece notes, so a downstream envelope sees a
 *  rising edge rather than a level that never left 1. */
const GATE_GAP_SEC = 0.002;
/** Scheduling lookahead off the ~25 ms scheduler tick. */
const LOOKAHEAD_SEC = 0.01;
/** Fallback pulse period before two clock edges have been seen. */
const DEFAULT_PULSE_SEC = 60 / 90 / 8; // 90 bpm at 8 pulses per beat
/** Ceiling on latched presses awaiting a clock pulse (QUANT on CLOCK). A clock
 *  that stops while someone keeps pressing must not grow an unbounded queue
 *  that then replays a minute of input at once; the OLDEST are dropped, so the
 *  most recent intent is what survives. */
const PENDING_MAX = 16;

export interface SeqtrisSnapshot {
  /** Row-major length-64 board INCLUDING the falling piece. */
  readonly board: readonly (SeqtrisPieceId | null)[];
  readonly piece: SeqtrisPieceId | null;
  readonly divisor: number;
  readonly baseDivisor: number;
  readonly ladder: readonly number[];
  readonly lines: number;
  readonly totalLines: number;
  readonly gameOvers: number;
  readonly notesFired: number;
  readonly spawns: number;
  readonly lineFires: number;
  readonly tiedDrops: number;
  readonly clockPulses: number;
  readonly clockPatched: boolean;
  /** Bumped on every state change — a cheap change token for the card. */
  readonly version: number;
}

export interface SeqtrisCardApi {
  connect(): Promise<void>;
  launchpadStatus(): SeqtrisLaunchpadStatus;
  bindPort(port: LaunchpadPort): boolean;
  unbindPort(): void;
  /** An on-screen (or scripted) press of one of the eight game controls. */
  press(input: SeqtrisInput): void;
  snapshot(): SeqtrisSnapshot;
  subscribe(fn: () => void): () => void;
}

export const seqtrisDef: AudioModuleDef = {
  // String LITERALS, not constants: module-manifest.ts extracts these fields
  // with a ?raw regex and cannot resolve a reference.
  type: 'seqtris',
  palette: { top: 'Games', sub: 'Arcade' },
  domain: 'audio',
  label: 'seqtris',
  category: 'games',
  size: '3u',
  hp: 2,

  inputs: [
    { id: 'clock', type: 'gate', edge: 'trigger' },
  ],
  outputs: [
    { id: 'piece', type: 'polyPitchGate' },
    { id: 'board', type: 'polyPitchGate' },
    { id: 'line', type: 'gate', edge: 'trigger' },
    { id: 'spawn', type: 'gate', edge: 'trigger' },
  ],
  params: [
    {
      id: 'gravity',
      label: 'grav',
      defaultValue: SEQTRIS_DEFAULT_DIVISOR,
      min: 1,
      max: 48,
      curve: 'discrete',
      units: 'pulses',
    },
    {
      id: 'quantize',
      label: 'quant',
      defaultValue: 1,
      min: 0,
      max: 1,
      curve: 'discrete',
      options: [
        { value: 0, label: 'free' },
        { value: 1, label: 'clock' },
      ],
    },
  ],

  face: {
    // ⚠ `gravity` IS RANK 1, AND THE LOSER IS NAMED. Gravity is the game's
    // tempo, in clock pulses per row, and everything downstream of PIECE / LINE
    // / SPAWN is clocked by how fast the stack builds; it is also the one param
    // with a live engine effect (`setParam` → `setBaseDivisor` → `changed()`),
    // so moving it repaints immediately. `quantize` is a two-position mode
    // switch that changes WHEN a press lands, not what the game does, and at
    // the `mini` tier (one control) a tempo serves better than a latch mode.
    // ⚠ NEITHER PARAM IS INERT — the one place seqtris is easier than its
    // modtris sibling, whose face PR had to wire a dead `levelStep` before it
    // could honestly rank it. `gravity` is read on every `setParam` and every
    // `gravitySec()`; `quantize` on every `press()`. No wiring work is owed and
    // `params` is not edited, so contract-lock does not move.
    order: ['gravity', 'quantize'],

    // ONE band. Both params answer the same question — HOW does the game move —
    // and `pages` AGREES with `order` rather than disagreeing (stated so a
    // reader does not go hunting for a distinction the module does not have). A
    // tab rail needs DOCK_TAB_MIN_BANDS = 7 bands; NOTHING IS PADDED to reach
    // one, per the owner's control-heavy/tabbed ruling read in the correct
    // direction.
    pages: [{ id: 'fall', label: 'fall', controls: ['gravity', 'quantize'] }],

    // ⚠ FORCED, AND MEASURED RATHER THAN ASSUMED. `primaryAudioOutPortId` needs
    // a `type: 'audio'` output; seqtris' four outputs are polyPitchGate x2 and
    // gate x2, so every LIVE glyph kind (scope/meter/envelope/waveform)
    // resolves `{kind:'static'}` and is refused by the dead-glyph clause.
    // `'algorithm'` resolves but is refused on its merits: `ShellExtensionGlyphProps`
    // is `{num, numbers?, testid?}` with NO `nodeId`, so a glyph component
    // cannot resolve a graph node, cannot reach `card-api`, and would draw one
    // identical picture on every seqtris in the rack forever. `hasVideoSurface`
    // is `domain === 'video'`; this is audio. So: none — and the tile's picture
    // comes from the module's own `tileBody` instead.
    glyph: 'none',

    // ⚠ NO `paramCells`, AND THE ABSENCE IS THE DECLARATION. The card draws
    // both controls as `<KnobConic>`, and a KNOB is exactly what
    // `paramCellKind` resolves with nothing declared: `gravity` has no options
    // and is not a 0/1 switch, and `quantize` has an `options` roster, which
    // resolves `'knob'` at every LANE tier and `'segmented'` in the DOCK. So
    // the lane is card-identical and the dock renders the two-position switch
    // the def already names (`free` / `clock`) instead of a rotary sweeping a
    // hidden binary. ⚠ There is no `'knob'` literal to declare — the union is
    // `grid | color | hue | fader` — and `'fader'` would be red anyway (the
    // lint demands a CONTINUOUS scale, and both params are `discrete`).
    // ⚠ The `options` LABELS are NOT re-typed here: same one-source rule as a
    // range, same gate family.

    // The well, the eight-button hardware column and CONNECT.
    // See $lib/ui/modules/seqtris/shell-extension.ts.
    extension: 'seqtris',

    // ⚠ AUTHORED RATHER THAN DERIVED. `clock` is a real signal input with NO
    // paramTarget, so the derived rail would render one anonymous jack. An
    // input group must claim the LEADING slot ('voice'/'signal') or name a
    // declared page, or it appends as a stray band after every page and the
    // rear totality gate cannot see it (module-face-lint). 'signal' is the
    // leading slot and `clock` IS what you play the module with.
    // The OUTPUT rail takes the derived default: `piece`/`board` are one cable
    // domain and `line`/`spawn` another, and `rearFieldPlan` splits by domain
    // only once the rail out-runs a column — four ports do not.
    rear: {
      groups: [{ id: 'signal', label: 'clock', ports: ['clock'] }],
    },
  },

  docs: {
    explanation:
      'An 8x8 Tetris you play on a Novation Launchpad, wired into the rack as a clocked note '
      + 'source. The eight-by-eight pad grid IS the well, and the right-hand scene column is the '
      + 'controller: top to bottom, RESET BOARD, two dead buttons, DROP PIECE, ROTATE LEFT, '
      + 'ROTATE RIGHT, MOVE LEFT, MOVE RIGHT. Press CONNECT on the card, pick your Launchpad, and '
      + 'the board appears on the pads in the classic piece colours; the card shows the same '
      + 'picture and the same eight buttons, so you can play it without hardware too. The piece '
      + 'set is the normal seven with two shapes cut down for the short well: the straight line '
      + 'is two cells instead of four, and the two L pieces are three-cell corners, so nothing is '
      + 'ever taller than three rows. Each piece carries ONE tracked square, chosen when it '
      + 'spawns as the leftmost square of its top row, and that square is what plays: its column '
      + 'picks the octave and its row picks a note of a C major scale running downward from the '
      + 'top row, so the leftmost column reaches down to C0 and the rightmost up to C8. PIECE '
      + 'fires that note every time the piece moves; a hard drop instead sends every row it falls '
      + 'through at once under one held gate, a tie. SPAWN pulses on each new piece and LINE '
      + 'pulses once per cleared row. Gravity is counted in CLOCK PULSES, not seconds — one row '
      + 'every GRAV pulses — and each cleared line steps GRAV down to the next whole number about '
      + 'ten percent faster, so the game speeds up without ever drifting off the clock. BOARD is '
      + 'declared but silent for now.',
    inputs: {
      clock:
        'The game clock. Every rising edge is one pulse; the piece falls one row every GRAV '
        + 'pulses, so the patch tempo is the game tempo. Because gravity is a whole number of '
        + 'pulses, a speed-up from a cleared line still lands every fall and every spawn on a '
        + 'clock edge. A TIMELORDE 8x output at 90 bpm with GRAV at 8 is one row per beat, which '
        + 'is a comfortable pace to actually play at. With nothing patched here the piece never '
        + 'falls on its own and the buttons play free.',
    },
    outputs: {
      piece:
        'The note the current piece is sounding, as a poly note cable. It fires afresh every time '
        + 'the piece moves — gravity, a sideways move, a rotation — and once more each time a '
        + 'piece spawns, so the top row (a C) is always heard. Pitch comes from the tracked '
        + 'square: column picks the octave, row picks a descending C major scale degree. A hard '
        + 'drop is the exception: every row the piece falls through arrives together on separate '
        + 'voices under a single gate that is held for one gravity step, so the drop reads as one '
        + 'tied chord rather than a burst of retriggers.',
      board:
        'Reserved for a future reading of the LANDED stack. It is declared so a patch can be '
        + 'built around it now, and it is silent — no voice on it ever gates. Patch PIECE for the '
        + 'notes.',
      line:
        'Fires a short pulse each time a completed row is cleared and the stack drops. A double '
        + 'clear fires twice, 20 ms apart, so a counter or a drum sees each row. It does NOT fire '
        + 'on a stack-out — nothing was cleared there.',
      spawn:
        'Fires a short pulse the moment a new piece appears at the top of the well, including the '
        + 'fresh piece that follows a stack-out. Patch it at a drum or an envelope to hear the '
        + 'shape of the game.',
    },
    controls: {
      gravity:
        'GRAV, in clock pulses per row (1..48, default 8). This is the LEVEL-ZERO speed; every '
        + 'cleared line steps the working divisor down to the next whole number roughly ten '
        + 'percent faster, ending at 1 (a row per pulse). Because it is a whole number of pulses, '
        + 'the game loop is always a proper divisor of the incoming clock. From the default of 8 '
        + 'the ladder is 8, 7, 6, 5, 4, 3, 2, 1 — eight levels, though the steps near the end are '
        + 'much bigger than ten percent. Feed a finer clock (24 or 48 pulses per beat) and set '
        + 'GRAV to match for rungs that are actually ten percent apart. Changing GRAV re-derives '
        + 'the current speed from the lines you have already cleared rather than resetting them.',
      quantize:
        'QUANT decides when a button press takes effect. On CLOCK (the default) a press is held '
        + 'until the next clock pulse, so every note the module emits lands on the grid — moves, '
        + 'rotations and drops included. On FREE a press acts the instant it arrives, which feels '
        + 'like a video game and sounds unquantized. With nothing patched into CLOCK, presses '
        + 'always act immediately whatever this says.',
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const nodeId = node.id;

    // ─── Clock input: tap + the SHARED windowed edge counter ───────────────
    // Never a whole-buffer rescan: the AnalyserNode ring overlaps the ~25 ms
    // scheduler tick, and re-scanning it counts one clock pulse twice — which
    // on this module would drop a piece two rows per pulse.
    const clockGain = ctx.createGain();
    const clockAnalyser = ctx.createAnalyser();
    clockAnalyser.fftSize = 2048;
    clockGain.connect(clockAnalyser);
    const clockSilence = ctx.createConstantSource();
    clockSilence.offset.value = 0;
    clockSilence.start();
    clockSilence.connect(clockGain);
    const clockCounter = createEdgeCounter({ ctx, analyser: clockAnalyser });

    // ─── Outputs ───────────────────────────────────────────────────────────
    const piecePoly: PolySender = createPolySender(ctx);
    // BOARD is declared and never written — the spec stubs it. It still needs a
    // real merger so the jack exists and a cable can be drawn to it today.
    const boardPoly: PolySender = createPolySender(ctx);

    function makeGate(): ConstantSourceNode {
      const c = ctx.createConstantSource();
      c.offset.setValueAtTime(0, ctx.currentTime);
      c.start();
      return c;
    }
    const lineGate = makeGate();
    const spawnGate = makeGate();

    // ─── Params ────────────────────────────────────────────────────────────
    const knobs: Record<string, number> = {};
    for (const p of seqtrisDef.params) {
      const saved = node.params?.[p.id];
      knobs[p.id] = typeof saved === 'number' ? saved : p.defaultValue;
    }

    // ─── Game state ────────────────────────────────────────────────────────
    let state: SeqtrisState = createSeqtrisState({ baseDivisor: Math.round(knobs.gravity!) });
    /** Presses waiting for the next clock pulse (QUANT on CLOCK). */
    const pending: SeqtrisInput[] = [];
    let version = 0;
    let notesFired = 0;
    let spawns = 0;
    let lineFires = 0;
    let tiedDrops = 0;
    let clockPulses = 0;
    let pulseSec = DEFAULT_PULSE_SEC;
    let lastEdgeAt = ctx.currentTime;

    const listeners = new Set<() => void>();

    // ─── Launchpad ─────────────────────────────────────────────────────────
    // Acquired here rather than below the scheduler wiring because `changed()`
    // repaints through it. `press` is a hoisted function declaration.
    const launchpad: SeqtrisLaunchpadBinding = acquireSeqtrisLaunchpad(nodeId, press);

    function changed(): void {
      version++;
      launchpad.paint(renderBoard(state));
      for (const fn of listeners) {
        try {
          fn();
        } catch {
          /* a card throw must not stop the game */
        }
      }
    }

    function clockPatched(): boolean {
      return isInputPortConnected(Object.values(livePatch.edges), nodeId, 'clock');
    }

    /** One gravity step in seconds, from the measured pulse period. */
    function gravitySec(): number {
      return Math.max(0.03, Math.min(4, pulseSec * state.divisor));
    }

    // ─── Audio scheduling ──────────────────────────────────────────────────
    function pulseGate(gate: ConstantSourceNode, at: number): void {
      gate.offset.setValueAtTime(1, at);
      gate.offset.setValueAtTime(0, at + PULSE_SEC);
    }

    /**
     * Put one Piece note (or one tied chord) on the poly cable.
     *
     * The explicit `silence(at)` + re-open 2 ms later is what makes the note a
     * NEW note: writing 1 over a gate that is already 1 produces no rising edge
     * at all, so without the gap a note after a tie would be inaudible on any
     * envelope downstream.
     */
    function fireNote(vocts: readonly number[], at: number, gateOffSec: number): void {
      piecePoly.silence(at);
      const lanes: { pitch: number; gate: 0 | 1 }[] = [];
      for (let i = 0; i < POLY_CHANNEL_PAIRS; i++) {
        const v = vocts[i];
        lanes.push(v === undefined ? { pitch: 0, gate: 0 } : { pitch: v, gate: 1 });
      }
      piecePoly.scheduleStep(at + GATE_GAP_SEC, lanes, gateOffSec);
      notesFired++;
    }

    /**
     * Render one batch of game events onto the audio graph.
     *
     * ⚠ A TIE PUSHES THE NOTES AFTER IT. A hard drop locks the piece and spawns
     * the next one in the SAME batch, so the drop chord and the new piece's
     * spawn note are the same instant on the game clock. Scheduling both at `at`
     * would close the tie 2 ms after opening it — the tie would not exist. The
     * chord is therefore held for one gravity step and every LATER note in the
     * batch is pushed behind it. The `line` and `spawn` GATES still fire at `at`:
     * those events really did happen then.
     */
    function emit(events: readonly SeqtrisEvent[], at: number): void {
      let noteAt = at;
      let lineIndex = 0;
      for (const ev of events) {
        if (ev.kind === 'note') {
          fireNote([midiToVOct(ev.midi)], noteAt, Math.max(0.02, gravitySec() * 0.5));
        } else if (ev.kind === 'tie') {
          const hold = Math.max(0.06, gravitySec());
          fireNote(ev.midis.map(midiToVOct), noteAt, hold);
          tiedDrops++;
          noteAt += hold;
        } else if (ev.kind === 'spawn') {
          pulseGate(spawnGate, at);
          spawns++;
        } else if (ev.kind === 'line') {
          pulseGate(lineGate, at + lineIndex * LINE_STAGGER_SEC);
          lineIndex++;
          lineFires++;
        }
      }
    }

    // ─── Input + clock ─────────────────────────────────────────────────────
    function applyNow(input: SeqtrisInput, at: number): void {
      const step = applyInput(state, input);
      state = step.state;
      emit(coalesceSeqtrisNotes(step.events), at);
    }

    function press(input: SeqtrisInput): void {
      // An unpatched clock plays free whatever QUANT says — latching a press
      // that nothing will ever release is a dead module, not a quantized one.
      if (knobs.quantize! >= 0.5 && clockPatched()) {
        pending.push(input);
        while (pending.length > PENDING_MAX) pending.shift();
        return;
      }
      applyNow(input, ctx.currentTime + LOOKAHEAD_SEC);
      changed();
    }

    function tick(): void {
      const now = ctx.currentTime;
      const edges = clockCounter.poll(now);
      if (edges <= 0) return;

      // One timestamp, N edges: split the elapsed time between them so a fast
      // clock's pulses do not all land on the same instant (and inaudibly
      // overwrite each other).
      const elapsed = Math.max(1e-4, now - lastEdgeAt);
      pulseSec = Math.max(0.001, Math.min(4, elapsed / edges));
      lastEdgeAt = now;
      const spread = edges > 1 ? Math.min(SCHEDULER_TICK_MS / 1000, elapsed) / edges : 0;

      for (let i = 0; i < edges; i++) {
        const at = now + LOOKAHEAD_SEC + i * spread;
        clockPulses++;
        // ⚠ ONE BATCH PER PULSE, coalesced. Player input first, then gravity —
        // the ordinary Tetris frame order — but every one of those movements
        // lands on the SAME audio instant, so only the piece's FINAL position
        // is ever heard. `coalesceSeqtrisNotes` drops the notes that were
        // overwritten rather than scheduling (and counting) sounds nobody can
        // hear; the gates it leaves alone, because those really did all happen.
        const batch: SeqtrisEvent[] = [];
        while (pending.length > 0) {
          const step = applyInput(state, pending.shift()!);
          state = step.state;
          batch.push(...step.events);
        }
        const gravity = clockPulse(state);
        state = gravity.state;
        batch.push(...gravity.events);
        emit(coalesceSeqtrisNotes(batch), at);
      }
      changed();
    }

    const unsubscribeTick = getSchedulerClock().subscribe(() => {
      try {
        tick();
      } catch (err) {
        console.error('[seqtris] tick error', err);
      }
    });

    function snapshot(): SeqtrisSnapshot {
      return {
        board: renderBoard(state),
        piece: state.piece?.id ?? null,
        divisor: state.divisor,
        baseDivisor: state.baseDivisor,
        ladder: divisorLadder(state.baseDivisor),
        lines: state.lines,
        totalLines: state.totalLines,
        gameOvers: state.gameOvers,
        notesFired,
        spawns,
        lineFires,
        tiedDrops,
        clockPulses,
        clockPatched: clockPatched(),
        version,
      };
    }

    const cardApi: SeqtrisCardApi = {
      connect: () => launchpad.connect(),
      launchpadStatus: () => launchpad.status(),
      bindPort: (port) => {
        const ok = launchpad.bind(port);
        if (ok) launchpad.paint(renderBoard(state));
        return ok;
      },
      unbindPort: () => launchpad.unbind(),
      press,
      snapshot,
      subscribe: (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    };

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['clock', { node: clockGain, input: 0 }],
      ]),
      // ⚠ `{ node, output }`, NOT a bare AudioNode. `AudioDomainNodeHandle`
      // declares `Map<string, { node: AudioNode; output: number }>` and the
      // engine reads `sout.node` / `sout.output` — a bare node makes both
      // `undefined`, the connect throws inside the reconciler, and the module
      // ships GREEN AND SILENT with every jack drawn and no cable carrying
      // anything. Measured here: `notesFired` climbed, the game ran, the
      // faceplate animated, and the poly bus was dead.
      outputs: new Map<string, { node: AudioNode; output: number }>([
        ['piece', { node: piecePoly.output, output: 0 }],
        ['board', { node: boardPoly.output, output: 0 }],
        ['line', { node: lineGate, output: 0 }],
        ['spawn', { node: spawnGate, output: 0 }],
      ]),
      setParam(id, value) {
        if (!(id in knobs)) return;
        knobs[id] = value;
        if (id === 'gravity') {
          state = setBaseDivisor(state, Math.round(value));
          changed();
        }
      },
      readParam(id) {
        return knobs[id];
      },
      read(key: string): unknown {
        if (key === 'card-api') return cardApi;
        if (key === 'state') return snapshot();
        return undefined;
      },
      dispose() {
        unsubscribeTick();
        launchpad.release();
        listeners.clear();
        piecePoly.dispose();
        boardPoly.dispose();
        for (const g of [lineGate, spawnGate]) {
          try {
            g.stop();
          } catch {
            /* already stopped */
          }
          g.disconnect();
        }
        try {
          clockSilence.stop();
        } catch {
          /* already stopped */
        }
        clockSilence.disconnect();
        clockGain.disconnect();
        clockAnalyser.disconnect();
      },
    };
  },
};

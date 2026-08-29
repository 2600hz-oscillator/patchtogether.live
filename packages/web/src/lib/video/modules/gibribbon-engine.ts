// packages/web/src/lib/video/modules/gibribbon-engine.ts
//
// GIBRIBBON — the REWRITTEN pure game core (rev 3 spec, owner-ruled rewrite).
//
// The owner's ruling (2026-08-28, verbatim): "gibribbon has never really
// worked so that one should be done as a full rewrite, based on looking at the
// history of the module and understanding it was intended to be a
// cv-controlled fair-use approximation of the game vib ribbon, and function as
// a playable game in that respect. it also will use doom marine and monster
// assets, but this is fair use artistic parody area".
//
// THIS FILE IS DELIBERATELY GL-FREE AND DOM-FREE — the whole game is a pure
// state machine over ONE clock, unit-tested without WebGL. The two structural
// fixes the rewrite exists for live here:
//
//  F1 — ADAPTIVE PROMINENCE COURSE EXTRACTION (closes the #624/#698/#701
//      class). The old engine spawned on an ABSOLUTE threshold
//      (cvSpawnThreshold 0.42) against another module's DSP gains — so a
//      band-edge refactor in synesthesia (#698) silently killed half the game
//      while every test stayed green. The new extractor normalizes each
//      channel against ITS OWN rolling recent range and spawns on RELATIVE
//      prominence with rank competition + a starvation boost, so ANY varying
//      source at ANY gain yields a playable course, a dead-flat channel (raw
//      silence OR a stuck DC rail) spawns nothing, and no upstream gain drift
//      can silently starve one channel while the others fire. There is no
//      absolute level threshold against foreign DSP anywhere in this file.
//
//  F4 — ONE CLOCK AUTHORITY (closes the #635 class). The old engine mixed
//      discrete clock-tick jumps with wall-clock dt scroll, which made ~3.2%
//      of events physically un-hittable at certain phases. Here EVERYTHING is
//      a function of the scheduler tick count: `step()` is called once per
//      scheduler tick (25 ms, the shared Web-Worker clock), course ticks
//      derive from it (internal tempo accumulator OR external clock edges —
//      one code path, two tick sources, never two clocks), and judgement is
//      anchored to the tick-derived sub-beat PHASE. Render interpolation
//      reads the same phase, so the picture can never disagree with the
//      judgement and a frame rate cannot move the window. The zero-un-hittable
//      phase sweep is kept as a permanent invariant test over this stepper.
//
// DETERMINISM IS DESIGNED IN: no Math.random, no Date.now, no
// performance.now. All randomness flows from the xorshift32 seed; all timing
// flows from the scheduler tick count. Two runs with the same seed and the
// same per-tick input stream are byte-identical.
//
// ATTRACT MODE (F3, replaces the #626 autoplay crutch): a bare, idle module
// self-plays — course from a synthesized rotating CV, a deterministic bot
// clearing events — and the renderer labels the state ATTRACT in-canvas, so a
// self-playing module can never again mask a dead CV path. Any real input
// (a button, a clock edge, a moving CV) exits attract into a fresh PLAY run.

// ── Event taxonomy (KEPT from the original build — the game feel worth
//    carrying; none of it was the broken part) ──────────────────────────────

/** The four gameplay events, each mapped to one ABXY button. */
export type GibEventKind = 'loop' | 'jump' | 'imp' | 'zombie';

/** Which physical ABXY button clears each event kind. This mapping is the
 *  contract the lookahead lane + the input judge both read. */
export const EVENT_BUTTON: Record<GibEventKind, GibButton> = {
  loop: 'a',
  jump: 'b',
  imp: 'x',
  zombie: 'y',
};

/** The four player buttons (named to disambiguate from the x/y joystick
 *  AXES — `x_btn`/`y_btn` are the ABXY buttons, not the stick). */
export type GibButton = 'a' | 'b' | 'x' | 'y';

/** A spawned obstacle/enemy travelling along the ribbon. `pos` is measured in
 *  course units: `spawnPos` at spawn (off the right edge — the ~2-bar
 *  lookahead buffer), 0.0 at the judgement point, decreasing by exactly
 *  `scrollPerTick` per COURSE tick. Sub-tick motion is the render/judge
 *  PHASE, never a mutation of `pos`. */
export interface GibEvent {
  /** Monotonic id (spawn order) — stable across ticks for the renderer. */
  id: number;
  kind: GibEventKind;
  pos: number;
  /** Has this event already been judged (hit or missed)? Judged events keep
   *  rendering their resolution animation but never re-judge. */
  resolved: boolean;
  outcome: 'hit' | 'miss' | null;
  /** COURSE tick at which the resolution happened (renderer timeline). */
  resolvedTick: number | null;
}

// ── Marine health ladder (DOOM-face-ladder-in-spirit degradation) ──────────

export type GibHealth = 'super' | 'healthy' | 'wounded' | 'critical' | 'dead';

/** Ordered ladder (index = severity). Climbing toward 0 = healthier. */
export const HEALTH_LADDER: GibHealth[] = ['super', 'healthy', 'wounded', 'critical', 'dead'];

/** Map a health rung to a normalized 0..1 vitality for the health_cv output
 *  (super=1, healthy=0.75, wounded=0.5, critical=0.25, dead=0). KEPT. */
export function healthToCv(h: GibHealth): number {
  switch (h) {
    case 'super': return 1.0;
    case 'healthy': return 0.75;
    case 'wounded': return 0.5;
    case 'critical': return 0.25;
    case 'dead': return 0.0;
  }
}

// ── Tuning ─────────────────────────────────────────────────────────────────

export interface GibTuning {
  /** Course advance per COURSE TICK, in pos units. The ONLY scroll authority:
   *  there is no per-second scroll term anywhere in the rewrite. */
  scrollPerTick: number;
  /** Where events spawn. 1.0 is the right screen edge; spawning beyond it is
   *  what makes the course a READABLE lookahead buffer (~2 bars of ticks at
   *  the default tempo) rather than whack-a-mole. */
  spawnPos: number;
  /** Half-width of the judgement window centred on the (aim-shifted)
   *  judgement point. INVARIANT (the kept #635 lesson, asserted by the
   *  phase-sweep test): 2·hitWindow MUST exceed scrollPerTick with margin. */
  hitWindow: number;
  /** An event whose pos falls below this without being cleared is a MISS. */
  missPos: number;
  /** Per-channel rolling-baseline window, in COURSE ticks (~4 bars at the
   *  default tempo). The F1 mechanism: prominence is measured against THIS,
   *  never against an absolute level. */
  baselineWindowTicks: number;
  /** Resting-floor guard: a channel whose recent range (max−min over the
   *  baseline window) is below this is DEAD — raw silence and a stuck DC rail
   *  both spawn nothing, at any gain. */
  flatRangeEps: number;
  /** Prominence eligibility bar at difficulty 0 / 1: the fraction of a
   *  channel's OWN recent range its level must reach to compete this tick.
   *  Difficulty interpolates between them (higher difficulty = lower bar =
   *  denser course). */
  prominenceBarEasy: number;
  prominenceBarHard: number;
  /** Bar reduction while the beat gate is high — musical placement is a BIAS,
   *  never a hard gate on spawning. */
  gateBias: number;
  /** Rank boost per fully-starved channel (no spawn for a whole baseline
   *  window). The competition half of F1: gain drift cannot silently starve
   *  a channel because starvation raises its rank. */
  starvationBoost: number;
  /** PEAK HOLD: how many course ticks a channel's peak stays eligible after
   *  it lands. Without it, a source whose peaks are phase-locked one tick
   *  behind another channel's spawns is starved FOREVER by the rate limiter
   *  (found by the corpus test's quiet/hot entries — the peak always arrived
   *  on a blocked tick and was gone by the next allowed one). */
  peakGraceTicks: number;
  /** Rate limiter: min COURSE ticks between spawns at difficulty 0 / 1. */
  minSpawnGapEasyTicks: number;
  minSpawnGapHardTicks: number;
  /** Combo length that promotes healthy → super. */
  superStreak: number;
  /** Combo length that heals one rung (critical→wounded, wounded→healthy). */
  healStreak: number;
  scorePerHit: number;
  maxComboMult: number;
  /** Which cv channel index (0..3) maps to which event kind. */
  cvEventMap: GibEventKind[];
  /** Opening course ticks of a fresh run during which nothing spawns. */
  countInTicks: number;
  /** Scheduler-side: idle ms (no real input) before an autoplay-enabled
   *  module re-enters ATTRACT self-play. */
  attractIdleMs: number;
  /** External clock ownership window: after a clock edge the internal tempo
   *  accumulator is suppressed this long (one tick path, two tick sources). */
  externalClockHoldMs: number;
  /** ms the GAME OVER banner holds in ATTRACT before the bot restarts. */
  attractGameOverHoldMs: number;
}

export const GIB_TUNING: GibTuning = {
  scrollPerTick: 0.18,
  // 8 course ticks of approach (8 × 0.18 = 1.44): at the default ~0.42 s
  // beat that is ~3.4 s ≈ 2 bars of readable lookahead.
  spawnPos: 1.44,
  // KEPT from #635 with its margin: window width 0.22 > step 0.18. In the
  // rewrite the judged position moves in scheduler-tick quanta (~0.01/step at
  // the default tempo), so the window is crossed by ~20 judgeable steps —
  // un-hittability is structurally unrepresentable, and the phase-sweep test
  // proves it by construction rather than by margin.
  hitWindow: 0.11,
  missPos: -0.12,
  baselineWindowTicks: 32,
  flatRangeEps: 0.04,
  prominenceBarEasy: 0.82,
  prominenceBarHard: 0.55,
  gateBias: 0.12,
  starvationBoost: 0.35,
  peakGraceTicks: 1,
  minSpawnGapEasyTicks: 3,
  minSpawnGapHardTicks: 1,
  superStreak: 8,
  healStreak: 4,
  scorePerHit: 100,
  maxComboMult: 8,
  cvEventMap: ['loop', 'jump', 'imp', 'zombie'],
  countInTicks: 2,
  attractIdleMs: 10_000,
  externalClockHoldMs: 1500,
  attractGameOverHoldMs: 2000,
};

// ── Per-scheduler-tick inputs + params ─────────────────────────────────────

/** Everything the stepper consumes for ONE scheduler tick. The factory
 *  samples its params + drains its edge queues into this; tests hand-build
 *  it. Pure data — the stepper never reaches past it. */
export interface GibStepInputs {
  /** The four course-channel levels, sampled this tick (0..1). */
  cv: readonly number[];
  /** The beat-gate level, sampled this tick. */
  gate: number;
  /** External clock rising edges since the last step (usually 0 or 1). */
  clockEdges: number;
  /** ABXY press edges since the last step, in arrival order. */
  buttons: readonly GibButton[];
  /** `restart` port / R key / RESET action edges since the last step. */
  restartEdges: number;
  /** Joystick aim axes, sampled this tick (−1..1). */
  axisX: number;
  axisY: number;
  /** TRUE when any REAL input arrived since the last step (a button, a clock
   *  edge, a restart, a moving CV/gate/axis). Drives attract entry/exit —
   *  the honest proxy for "idle-and-unpatched". */
  activity: boolean;
}

/** The module params the stepper reads, resolved per tick. */
export interface GibStepParams {
  /** Scheduler tick period in ms (SCHEDULER_TICK_MS = 25). */
  tickMs: number;
  /** Internal transport rate, BPM-equivalent (one course tick per beat). */
  tempoBpm: number;
  /** 0..1 — scales extraction density and internal course rate together. */
  difficulty: number;
  /** The `autoplay` param under attract semantics: ≥0.5 = attract enabled. */
  attract: number;
}

export const DEFAULT_STEP_PARAMS: GibStepParams = {
  tickMs: 25,
  tempoBpm: 143, // ≈ the original's 0.42 s beat
  difficulty: 0.5,
  attract: 1,
};

/** An all-quiet input tick (what a bare unpatched module feeds itself). */
export const IDLE_INPUTS: GibStepInputs = {
  cv: [0, 0, 0, 0],
  gate: 0,
  clockEdges: 0,
  buttons: [],
  restartEdges: 0,
  axisX: 0,
  axisY: 0,
  activity: false,
};

// ── Game state ─────────────────────────────────────────────────────────────

/** Rolling per-channel stats for the adaptive extractor. Ring buffer of the
 *  channel's own recent per-course-tick levels. */
export interface GibChannelStats {
  hist: number[];
  /** Next write index into `hist`. */
  idx: number;
  /** How many entries of `hist` are valid (≤ baselineWindowTicks). */
  filled: number;
  /** Course tick of this channel's last spawn (starvation rank input). */
  lastSpawnTick: number;
}

/** Side-effect events the shell drains each tick to pulse gates + drive
 *  feedback. KEPT shape. */
export interface GibOutEvent {
  type: 'hit' | 'miss' | 'fire' | 'kill' | 'degrade' | 'heal' | 'super' | 'gameover';
  kind?: GibEventKind;
}

export interface GibState {
  /** ATTRACT = honest self-play (labelled in-canvas); PLAY = a real run. */
  mode: 'attract' | 'play';
  /** COURSE ticks since run start (the transport). */
  tick: number;
  /** SCHEDULER ticks since run start (the one clock everything derives from). */
  schedTick: number;
  /** Internal-tempo phase accumulator, ms (only advances while no external
   *  clock owns the transport). */
  beatAccMs: number;
  /** External-clock ownership countdown, ms (>0 = external owns). */
  extHoldMs: number;
  /** EMA of the external clock period, ms (judge/render phase under an
   *  external clock). Seeded from the internal tempo. */
  extPeriodMs: number;
  /** Scheduler tick at which the last COURSE tick landed (phase anchor). */
  lastCourseSchedTick: number;
  events: GibEvent[];
  health: GibHealth;
  combo: number;
  score: number;
  hits: number;
  misses: number;
  /** Player press edges consumed (observability: e2e reads this to prove an
   *  input path — keyboard, gamepad cable — reaches the judge). */
  presses: number;
  lastSpawnTick: number;
  nextEventId: number;
  /** xorshift32 state — the ONLY randomness. Pinnable via __gibribbonVrtSeed. */
  rng: number;
  aimX: number;
  aimY: number;
  outQueue: GibOutEvent[];
  chans: GibChannelStats[];
  /** ms since the last REAL input (attract entry timer). */
  idleMs: number;
  /** Last event id the attract bot pressed (one press per event). */
  attractPressedId: number;
  /** Scheduler tick of death (attract auto-restart + banner timeline). */
  diedAtSchedTick: number;
  /** Render feedback: scheduler ticks of hit-flash remaining (deterministic —
   *  decays per scheduler tick, never per wall-clock frame). */
  flashTicks: number;
}

function newChannelStats(): GibChannelStats {
  return { hist: [], idx: 0, filled: 0, lastSpawnTick: -1_000_000 };
}

/** Seed a fresh run. Deterministic in `seed`. */
export function newRun(seed: number, mode: 'attract' | 'play'): GibState {
  return {
    mode,
    tick: 0,
    schedTick: 0,
    beatAccMs: 0,
    extHoldMs: 0,
    extPeriodMs: 0,
    lastCourseSchedTick: 0,
    events: [],
    health: 'healthy',
    combo: 0,
    score: 0,
    hits: 0,
    misses: 0,
    presses: 0,
    lastSpawnTick: -1_000_000,
    nextEventId: 1,
    rng: (seed >>> 0) || 0xc0de,
    aimX: 0,
    aimY: 0,
    outQueue: [],
    chans: [newChannelStats(), newChannelStats(), newChannelStats(), newChannelStats()],
    idleMs: 0,
    attractPressedId: 0,
    diedAtSchedTick: -1,
    flashTicks: 0,
  };
}

/** Restart in place (restart port / R key / RESET action / attract entry).
 *  The next seed derives from the current rng stream so successive runs
 *  differ but the WHOLE sequence stays a function of the boot seed. */
function restartRun(s: GibState, mode: 'attract' | 'play'): void {
  const nextSeed = (nextRandU32(s) ^ 0x9e3779b9) >>> 0;
  const fresh = newRun(nextSeed, mode);
  Object.assign(s, fresh);
}

/** xorshift32 — deterministic, fast, no library. */
function nextRandU32(s: GibState): number {
  let x = s.rng >>> 0;
  x ^= x << 13; x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5; x >>>= 0;
  s.rng = x >>> 0;
  return s.rng;
}
function nextRand(s: GibState): number {
  return nextRandU32(s) / 0xffffffff;
}

/** Set the joystick AIM. Clamped so a hot CV can't push the judgement point
 *  off the ribbon. KEPT. */
export function setAim(s: GibState, axisX: number, axisY: number): void {
  s.aimX = Math.max(-1, Math.min(1, axisX || 0));
  s.aimY = Math.max(-1, Math.min(1, axisY || 0));
}

// ── Health-ladder helpers (KEPT) ───────────────────────────────────────────

function healthIndex(h: GibHealth): number {
  return HEALTH_LADDER.indexOf(h);
}

function degrade(s: GibState): void {
  const i = Math.min(HEALTH_LADDER.length - 1, healthIndex(s.health) + 1);
  s.health = HEALTH_LADDER[i]!;
  s.outQueue.push({ type: s.health === 'dead' ? 'gameover' : 'degrade' });
  if (s.health === 'dead') s.diedAtSchedTick = s.schedTick;
}

function heal(s: GibState): void {
  if (s.health === 'dead') return;
  const i = Math.max(0, healthIndex(s.health) - 1);
  const next = HEALTH_LADDER[i]!;
  if (next !== s.health) {
    s.health = next;
    s.outQueue.push({ type: next === 'super' ? 'super' : 'heal' });
  }
}

// ── Phase: the sub-beat position of the CURRENT scheduler tick ─────────────

/** Sub-course-tick phase 0..1 — how far between course ticks this scheduler
 *  tick sits. It is a pure function of tick counts (internal mode: the ms
 *  accumulator; external mode: scheduler ticks since the last course tick
 *  over the measured clock period), so judgement and render read the SAME
 *  number and a frame clock can never move either. */
export function judgePhase(s: GibState, params: GibStepParams): number {
  if (s.extHoldMs > 0) {
    const period = s.extPeriodMs > 0 ? s.extPeriodMs : beatMsOf(params);
    const elapsed = (s.schedTick - s.lastCourseSchedTick) * params.tickMs;
    return Math.max(0, Math.min(1, elapsed / period));
  }
  const beatMs = beatMsOf(params);
  return Math.max(0, Math.min(1, s.beatAccMs / beatMs));
}

/** The judged/rendered position of an event at the given phase. */
export function effectivePos(ev: GibEvent, phase: number, tuning: GibTuning = GIB_TUNING): number {
  return ev.pos - phase * tuning.scrollPerTick;
}

function beatMsOf(params: GibStepParams): number {
  const bpm = Math.max(30, Math.min(300, params.tempoBpm || 143));
  // Difficulty nudges the internal course rate ±20% around the tempo knob.
  const scale = 0.8 + 0.4 * clamp01(params.difficulty);
  return 60000 / (bpm * scale);
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v || 0));
}

// ── Adaptive prominence extraction (THE F1 FIX) ────────────────────────────

/** Push one course tick's level into a channel's rolling window. */
function pushLevel(c: GibChannelStats, level: number, windowTicks: number): void {
  if (c.hist.length < windowTicks) {
    c.hist.push(level);
    c.filled = c.hist.length;
    c.idx = c.hist.length % windowTicks;
  } else {
    c.hist[c.idx] = level;
    c.idx = (c.idx + 1) % windowTicks;
    c.filled = windowTicks;
  }
}

interface ChannelRead {
  min: number;
  max: number;
  range: number;
}

function readStats(c: GibChannelStats): ChannelRead {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < c.filled; i++) {
    const v = c.hist[i]!;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (c.filled === 0) { min = 0; max = 0; }
  return { min, max, range: Math.max(0, max - min) };
}

/**
 * Decide which (if any) event to spawn on this COURSE tick.
 *
 * The generation rule, and why every piece is gain-proof:
 *   - a channel is DEAD when its recent range is under `flatRangeEps` —
 *     silence and stuck DC rails spawn nothing (the resting-floor guard);
 *   - a live channel's PROMINENCE is its level's position inside its OWN
 *     recent range ((level − min) / range ∈ 0..1) — multiplying the whole
 *     source by any gain leaves prominence unchanged, which is the property
 *     that closes the #698/#701 class structurally;
 *   - eligibility = prominence ≥ bar, where the bar comes from DIFFICULTY
 *     and drops by `gateBias` while the beat gate is high (bias, never a
 *     hard gate);
 *   - eligible channels COMPETE BY RANK: prominence plus a starvation boost
 *     that grows the longer a channel has gone unspawned, so no channel can
 *     be silently starved by its neighbours; ties break on the seeded rng;
 *   - a rate limiter (difficulty-scaled) caps overall density.
 *
 * Exported for the liveness/property tests. Pure aside from the rng advance.
 */
export function extractSpawn(
  s: GibState,
  cv: readonly number[],
  gateHigh: boolean,
  params: GibStepParams,
  tuning: GibTuning = GIB_TUNING,
): GibEventKind | null {
  // Count-in: a fresh run opens with a readable empty ribbon.
  if (s.tick <= tuning.countInTicks) return null;
  const difficulty = clamp01(params.difficulty);
  const minGap = Math.round(
    tuning.minSpawnGapEasyTicks
    + (tuning.minSpawnGapHardTicks - tuning.minSpawnGapEasyTicks) * difficulty,
  );
  if (s.tick - s.lastSpawnTick < minGap) return null;

  let bar = tuning.prominenceBarEasy
    + (tuning.prominenceBarHard - tuning.prominenceBarEasy) * difficulty;
  if (gateHigh) bar -= tuning.gateBias;

  let bestIdx = -1;
  let bestScore = -Infinity;
  for (let i = 0; i < tuning.cvEventMap.length; i++) {
    const c = s.chans[i]!;
    const stats = readStats(c);
    // Resting-floor guard: a flat channel is DEAD regardless of level.
    if (stats.range < tuning.flatRangeEps) continue;
    let level = cv[i] ?? 0;
    // Peak hold: a peak that landed on a rate-limited tick still competes on
    // the next allowed one (unless this channel itself just spawned).
    if (
      tuning.peakGraceTicks > 0
      && c.filled >= 2
      && c.lastSpawnTick < s.tick - 1
    ) {
      const window = c.hist.length;
      for (let back = 1; back <= tuning.peakGraceTicks && back < c.filled; back++) {
        const idx = (c.idx - 1 - back + 2 * window) % window;
        const prev = c.hist[idx]!;
        if (prev > level) level = prev;
      }
    }
    const prominence = (level - stats.min) / stats.range;
    if (prominence < bar) continue;
    const starvation = Math.min(1, (s.tick - c.lastSpawnTick) / tuning.baselineWindowTicks);
    const score = prominence + tuning.starvationBoost * starvation + nextRand(s) * 1e-6;
    if (score > bestScore) { bestScore = score; bestIdx = i; }
  }
  if (bestIdx < 0) return null;
  s.chans[bestIdx]!.lastSpawnTick = s.tick;
  return tuning.cvEventMap[bestIdx]!;
}

function spawnEvent(s: GibState, kind: GibEventKind, tuning: GibTuning): GibEvent {
  const ev: GibEvent = {
    id: s.nextEventId++,
    kind,
    pos: tuning.spawnPos,
    resolved: false,
    outcome: null,
    resolvedTick: null,
  };
  s.events.push(ev);
  s.lastSpawnTick = s.tick;
  return ev;
}

// ── Course tick (the transport step — spawn feed + scroll + miss) ──────────

function registerMiss(s: GibState, ev: GibEvent): void {
  ev.resolved = true;
  ev.outcome = 'miss';
  ev.resolvedTick = s.tick;
  s.combo = 0;
  s.misses += 1;
  s.outQueue.push({ type: 'miss', kind: ev.kind });
  degrade(s);
}

/** ONE course tick: advance the ribbon, judge misses, prune, feed the
 *  extractor. Called only from step() — internal tempo and external clock
 *  edges share this single path. Exported for the property tests. */
export function courseTick(
  s: GibState,
  cv: readonly number[],
  gateHigh: boolean,
  params: GibStepParams,
  tuning: GibTuning = GIB_TUNING,
): void {
  if (s.health === 'dead') return;
  s.tick += 1;
  s.lastCourseSchedTick = s.schedTick;
  for (const ev of s.events) {
    ev.pos -= tuning.scrollPerTick;
    if (!ev.resolved && ev.pos <= tuning.missPos) registerMiss(s, ev);
  }
  s.events = s.events.filter((ev) => ev.pos > -0.4);
  for (let i = 0; i < 4; i++) pushLevel(s.chans[i]!, cv[i] ?? 0, tuning.baselineWindowTicks);
  // A scroll-induced miss may have ended the run. isGameOver reads the LIVE
  // state, so TS does not wrongly narrow s.health from the entry guard.
  if (isGameOver(s)) return;
  const kind = extractSpawn(s, cv, gateHigh, params, tuning);
  if (kind) spawnEvent(s, kind, tuning);
}

// ── Judgement (tick-anchored, phase-adjusted — the F4 contract) ────────────

/**
 * Judge a player BUTTON PRESS at the given phase. Finds the nearest
 * UNRESOLVED event whose button matches and whose PHASE-ADJUSTED position is
 * inside the window around the aim-shifted judgement point. A press with no
 * match is ignored (no penalty for spare presses — the Vib-Ribbon
 * forgiveness; the penalty is for MISSING). KEPT shape; the position it
 * measures is now tick-phase-derived so no clock but the scheduler can move
 * the window.
 */
export function judgePress(
  s: GibState,
  button: GibButton,
  phase: number,
  tuning: GibTuning = GIB_TUNING,
): GibEvent | null {
  if (s.health === 'dead') return null;
  const centre = s.aimX * tuning.hitWindow;
  let best: GibEvent | null = null;
  let bestDist = Infinity;
  for (const ev of s.events) {
    if (ev.resolved) continue;
    if (EVENT_BUTTON[ev.kind] !== button) continue;
    const dist = Math.abs(effectivePos(ev, phase, tuning) - centre);
    if (dist <= tuning.hitWindow && dist < bestDist) {
      best = ev;
      bestDist = dist;
    }
  }
  if (!best) return null;
  registerHit(s, best, tuning);
  return best;
}

function registerHit(s: GibState, ev: GibEvent, tuning: GibTuning): void {
  ev.resolved = true;
  ev.outcome = 'hit';
  ev.resolvedTick = s.tick;
  s.combo += 1;
  s.hits += 1;
  const mult = Math.min(tuning.maxComboMult, s.combo);
  s.score += tuning.scorePerHit * mult;
  s.flashTicks = 8;
  s.outQueue.push({ type: 'hit', kind: ev.kind });
  if (ev.kind === 'imp' || ev.kind === 'zombie') {
    s.outQueue.push({ type: 'fire', kind: ev.kind });
    s.outQueue.push({ type: 'kill', kind: ev.kind });
  }
  if (s.combo >= tuning.superStreak && s.health === 'healthy') {
    heal(s); // healthy → super
  } else if (s.combo > 0 && s.combo % tuning.healStreak === 0) {
    if (s.health === 'wounded' || s.health === 'critical') heal(s);
  }
}

// ── ATTRACT source (the honest self-play feed) ─────────────────────────────

/**
 * The synthesized 4-channel CV the attract transport feeds the SAME
 * extraction path a patched source uses (never a parallel spawn path). Each
 * non-rest beat raises one channel, rotating across the four kinds; ~1 in 3
 * beats rests so the course breathes. PURE in `tick` (a hash, not the rng)
 * so it is identical across collaborators and pinnable boots.
 */
export function attractCv(tick: number): number[] {
  const cv = [0, 0, 0, 0];
  const h = Math.imul(tick >>> 0, 2654435761) >>> 0;
  if (h % 3 !== 0) cv[tick % 4] = 0.85;
  return cv;
}

/** Attract's beat gate: high on non-rest beats (musical placement bias). */
export function attractGate(tick: number): boolean {
  const h = Math.imul(tick >>> 0, 2654435761) >>> 0;
  return h % 3 !== 0;
}

// ── THE STEPPER — one scheduler tick, the whole game ───────────────────────

/**
 * Advance the game by ONE SCHEDULER TICK. This is the single clock authority:
 * course ticks, judgement phase, attract timing, feedback decay — everything
 * derives from calls to this function plus the per-tick inputs. In-place
 * mutation of `s`; identical (state, inputs, params) always produce the same
 * result.
 */
export function step(
  s: GibState,
  inputs: GibStepInputs,
  params: GibStepParams,
  tuning: GibTuning = GIB_TUNING,
): void {
  s.schedTick += 1;
  if (s.flashTicks > 0) s.flashTicks -= 1;

  // 1. ATTRACT bookkeeping. Real input zeroes the idle timer; in attract it
  //    is the arcade "insert coin": the input starts a fresh PLAY run and is
  //    consumed by the start (never judged against the attract course).
  if (inputs.activity) {
    s.idleMs = 0;
    if (s.mode === 'attract') {
      restartRun(s, 'play');
      return;
    }
  } else {
    s.idleMs += params.tickMs;
  }

  // 2. RESTART edges — the new gate port (frogger's start_gate precedent),
  //    the R key and the RESET action all land here: hard-reset mid-run,
  //    fresh run from game over. One path.
  if (inputs.restartEdges > 0 && s.mode === 'play') {
    restartRun(s, 'play');
    return;
  }

  // 3. ATTRACT toggled OFF mid-attract: self-play stops IMMEDIATELY — an
  //    honest attract mode obeys its own switch (a fresh idle PLAY run: with
  //    flat CV the ribbon stays honestly empty).
  if (s.mode === 'attract' && params.attract < 0.5) {
    restartRun(s, 'play');
    return;
  }

  // 4. ATTRACT (re-)entry: enabled, idle long enough → self-play resumes.
  if (
    s.mode === 'play'
    && params.attract >= 0.5
    && s.idleMs >= tuning.attractIdleMs
  ) {
    restartRun(s, 'attract');
    return;
  }

  // 5. Attract auto-restart after its own game over (banner holds first).
  if (
    s.mode === 'attract'
    && s.health === 'dead'
    && s.diedAtSchedTick >= 0
    && (s.schedTick - s.diedAtSchedTick) * params.tickMs >= tuning.attractGameOverHoldMs
  ) {
    restartRun(s, 'attract');
    return;
  }

  // 6. Aim (play mode only — attract keeps the marine centred).
  if (s.mode === 'play') setAim(s, inputs.axisX, inputs.axisY);
  else setAim(s, 0, 0);

  // 7. TRANSPORT — one code path, two tick sources, never two clocks.
  let courseTicksDue = 0;
  if (s.mode === 'play' && inputs.clockEdges > 0) {
    // External clock takes over instantly and owns the transport while its
    // edges keep arriving inside the hold window.
    const elapsedMs = (s.schedTick - s.lastCourseSchedTick) * params.tickMs;
    if (s.tick > 0 && elapsedMs > 0 && elapsedMs < 10_000) {
      s.extPeriodMs = s.extPeriodMs > 0
        ? s.extPeriodMs * 0.7 + elapsedMs * 0.3
        : elapsedMs;
    }
    s.extHoldMs = tuning.externalClockHoldMs;
    s.beatAccMs = 0;
    courseTicksDue = Math.min(8, inputs.clockEdges);
  } else if (s.mode === 'play' && s.extHoldMs > 0) {
    // External owns but no edge this tick: wait (phase keeps sweeping).
    s.extHoldMs = Math.max(0, s.extHoldMs - params.tickMs);
  } else {
    // Internal tempo — the SAME course path, clocked by the TEMPO param.
    const beatMs = beatMsOf(params);
    s.beatAccMs += params.tickMs;
    let guard = 4;
    while (s.beatAccMs >= beatMs && guard-- > 0) {
      s.beatAccMs -= beatMs;
      courseTicksDue += 1;
    }
  }

  // 8. Course ticks: feed = the patched CV in play mode, the synthesized
  //    rotation in attract. Same extractor either way.
  for (let i = 0; i < courseTicksDue; i++) {
    const feedTick = s.tick + 1;
    const cv = s.mode === 'attract' ? attractCv(feedTick) : inputs.cv;
    const gateHigh = s.mode === 'attract' ? attractGate(feedTick) : inputs.gate > 0.5;
    courseTick(s, cv, gateHigh, params, tuning);
  }

  // 9. Judgement — player presses in play mode, phase-anchored.
  const phase = judgePhase(s, params);
  if (s.mode === 'play') {
    for (const b of inputs.buttons) {
      s.presses += 1;
      judgePress(s, b, phase, tuning);
    }
  }

  // 10. The attract bot: clears each event once as it reaches the window —
  //    honest self-play through the REAL judge (the sequencer half keeps
  //    generating evt_* gates while idle, as designed).
  if (s.mode === 'attract' && s.health !== 'dead') {
    let nearest: GibEvent | null = null;
    let nearestDist = Infinity;
    for (const ev of s.events) {
      if (ev.resolved || ev.id === s.attractPressedId) continue;
      const dist = Math.abs(effectivePos(ev, phase, tuning));
      if (dist < nearestDist) { nearest = ev; nearestDist = dist; }
    }
    if (nearest && nearestDist <= tuning.hitWindow * 0.6) {
      s.attractPressedId = nearest.id;
      judgePress(s, EVENT_BUTTON[nearest.kind], phase, tuning);
    }
  }
}

// ── Lane + drains (KEPT shapes) ────────────────────────────────────────────

export interface GibLaneSlot {
  id: number;
  kind: GibEventKind;
  button: GibButton;
  pos: number;
  hot: boolean;
}

/**
 * The readable lookahead lane: the next `count` upcoming events NEAREST the
 * marine first, with phase-adjusted positions so the approach indicator and
 * the HOT flag agree with what the judge would say RIGHT NOW.
 */
export function upcomingLane(
  s: GibState,
  phase: number,
  count = 4,
  tuning: GibTuning = GIB_TUNING,
): GibLaneSlot[] {
  const centre = s.aimX * tuning.hitWindow;
  return s.events
    .filter((ev) => !ev.resolved && effectivePos(ev, phase, tuning) > -tuning.hitWindow)
    .sort((a, b) => a.pos - b.pos)
    .slice(0, count)
    .map((ev) => {
      const p = effectivePos(ev, phase, tuning);
      return {
        id: ev.id,
        kind: ev.kind,
        button: EVENT_BUTTON[ev.kind],
        pos: p,
        hot: Math.abs(p - centre) <= tuning.hitWindow,
      };
    });
}

/** Drain + clear the queued side-effect events (gates / animations). */
export function drainOutEvents(s: GibState): GibOutEvent[] {
  const out = s.outQueue;
  s.outQueue = [];
  return out;
}

export function isGameOver(s: GibState): boolean {
  return s.health === 'dead';
}

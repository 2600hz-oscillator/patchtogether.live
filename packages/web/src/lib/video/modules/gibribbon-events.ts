// packages/web/src/lib/video/modules/gibribbon-events.ts
//
// GibRibbon — the PURE event generator + game state machine.
//
// GibRibbon is a Vib-Ribbon spiritual successor: a single white vector
// "ribbon" / ground line scrolls right→left, obstacles + enemies ride the
// ribbon in from the right, and the player must pulse the correct ABXY button
// gate within a timing window as each event reaches the marine. Hits succeed
// (marine jumps / loops / fires-and-kills); misses degrade the marine down a
// DOOM-flavoured health ladder; clean streaks recover and can reach a SUPER
// state.
//
// THIS FILE IS DELIBERATELY GL-FREE AND DOM-FREE. The whole event lifecycle —
// generation from the clock/gate/CV input stream, the timing window, the
// hit/miss judgement, the degradation ladder, score + combo — is a pure,
// deterministic state machine so it unit-tests independently of WebGL (the
// gibribbon.ts factory is the thin GL/audio shell around it, exactly as
// nibbles-game.ts is for nibbles.ts).
//
// Phase-2 note (parent): EVENT GENERATION is a pure function of the inputs and
// every threshold lives in the exported GIB_TUNING constant block, so the
// parent can tune Synesthesia-CV → event frequency/selection without editing
// any logic. See GibTuning below.

// ── Event taxonomy ─────────────────────────────────────────────────────────

/** The four gameplay events, each mapped to one ABXY button. */
export type GibEventKind = 'loop' | 'jump' | 'imp' | 'zombie';

/** Which physical ABXY button clears each event kind. This mapping is the
 *  contract the overhead prompt strip + the input judge both read. */
export const EVENT_BUTTON: Record<GibEventKind, GibButton> = {
  loop: 'a',
  jump: 'b',
  imp: 'x',
  zombie: 'y',
};

/** The four player buttons (named to disambiguate from the x/y joystick
 *  AXES — `x_btn`/`y_btn` are the ABXY buttons, not the stick). */
export type GibButton = 'a' | 'b' | 'x' | 'y';

/** A spawned obstacle/enemy travelling along the ribbon. Position is a
 *  normalized 0..1 progress from spawn (1.0, far right) to the marine
 *  (0.0, the judgement point just left of centre). */
export interface GibEvent {
  /** Monotonic id (spawn order) — stable across ticks for the renderer. */
  id: number;
  kind: GibEventKind;
  /** 1.0 at spawn (right edge) → decreases as it scrolls toward the marine;
   *  reaches 0.0 at the judgement point. */
  pos: number;
  /** Has this event already been judged (hit or missed)? Judged events keep
   *  rendering their resolution animation but never re-judge. */
  resolved: boolean;
  /** Set once resolved: did the player clear it in time? */
  outcome: 'hit' | 'miss' | null;
  /** Tick at which the resolution happened (for the renderer's death/fire
   *  animation timeline). null until resolved. */
  resolvedTick: number | null;
}

// ── Marine health ladder (DOOM-flavoured degradation) ──────────────────────

/** Health rungs, best → worst. SUPER is the reward state reached on a long
 *  clean streak; GAME OVER terminates the run. */
export type GibHealth = 'super' | 'healthy' | 'wounded' | 'critical' | 'dead';

/** Ordered ladder (index = severity). Climbing toward 0 = healthier. */
export const HEALTH_LADDER: GibHealth[] = ['super', 'healthy', 'wounded', 'critical', 'dead'];

// ── Tunable thresholds (Phase-2 surface) ───────────────────────────────────

/**
 * Every gameplay constant the parent may want to tune lives here so CV→event
 * tuning never has to touch the state-machine logic. All are pure numbers.
 */
export interface GibTuning {
  /** Ribbon scroll speed in pos-units PER CLOCK TICK. The clock paces the
   *  scroll; one clock pulse advances every live event by this much. */
  scrollPerClock: number;
  /** Scroll advance per WALL-CLOCK SECOND, used between clock pulses so the
   *  ribbon glides smoothly instead of stepping. The clock pulse is the
   *  authoritative beat; this just interpolates. */
  scrollPerSecond: number;
  /** Half-width (in pos units) of the timing window centred on the judgement
   *  point (pos 0). A button press judges the nearest unresolved event whose
   *  |pos| ≤ this. */
  hitWindow: number;
  /** An event that scrolls PAST -hitWindow without being cleared is a MISS. */
  missPos: number;
  /** CV threshold: a cv channel's level must exceed this for it to be eligible
   *  to spawn its mapped event on a beat. Slow Synesthesia envelopes sit below
   *  this until their band is energetic. */
  cvSpawnThreshold: number;
  /** Minimum clock ticks between spawns (rate limiter so a hot CV channel
   *  can't carpet the ribbon). */
  minSpawnIntervalTicks: number;
  /** Combo length that promotes healthy → super. */
  superStreak: number;
  /** Combo length (consecutive hits) that heals one rung (critical→wounded,
   *  wounded→healthy). */
  healStreak: number;
  /** Score awarded per hit (multiplied by the current combo, capped). */
  scorePerHit: number;
  /** Max combo multiplier applied to scorePerHit. */
  maxComboMult: number;
  /** Which cv channel index (0..3) maps to which event kind. The parent tunes
   *  this so a given Synesthesia band drives a given event. */
  cvEventMap: GibEventKind[];
}

/** Default tuning. Chosen so a 1× clock at a musical tempo gives a playable
 *  ~2-3 second approach per obstacle, and the four cv channels map 1:1 to the
 *  four event kinds in declaration order (cv1→loop, cv2→jump, cv3→imp,
 *  cv4→zombie). */
export const GIB_TUNING: GibTuning = {
  scrollPerClock: 0.18,
  scrollPerSecond: 0.22,
  hitWindow: 0.09,
  missPos: -0.12,
  cvSpawnThreshold: 0.5,
  minSpawnIntervalTicks: 2,
  superStreak: 8,
  healStreak: 4,
  scorePerHit: 100,
  maxComboMult: 8,
  cvEventMap: ['loop', 'jump', 'imp', 'zombie'],
};

/**
 * AUTOPLAY CV — the synthesized 4-channel CV the module feeds its INTERNAL clock
 * when NO external clock/CV rig is patched, so a freshly-dropped GibRibbon card
 * SELF-PLAYS. A game should play on drop, not sit inert until you hand-wire a
 * timelorde→macseq→synesthesia chain (that chain is the OPTIONAL "musical mode"
 * override; without it the card was previously dead — marine running in place,
 * zero events). Each beat raises ONE channel above cvSpawnThreshold, rotating
 * across the four event kinds (loop/jump/imp/zombie) so all four appear, with
 * periodic rests for breathing room; chooseSpawn's rate-limit sets the final
 * cadence. PURE + deterministic in `beat` (no Math.random) so it's unit-testable
 * and identical across collaborators.
 */
export function autoplayCv(beat: number, tuning: GibTuning = GIB_TUNING): number[] {
  const cv = [0, 0, 0, 0];
  // Deterministic hash of the beat → ~1 in 3 beats is a REST (no channel hot),
  // so events don't arrive as an unbroken metronome.
  const h = (Math.imul(beat >>> 0, 2654435761) >>> 0);
  const rest = h % 3 === 0;
  if (!rest) {
    const ch = beat % 4; // rotate loop→jump→imp→zombie so every kind shows up
    cv[ch] = Math.max(0.85, tuning.cvSpawnThreshold + 0.3);
  }
  return cv;
}

// ── Game state ─────────────────────────────────────────────────────────────

export interface GibState {
  /** Live (and recently-resolved) events on the ribbon. Resolved events are
   *  pruned once they scroll fully off the left edge. */
  events: GibEvent[];
  health: GibHealth;
  /** Consecutive-hit streak (resets to 0 on a miss). Drives heal + super. */
  combo: number;
  /** Total score. */
  score: number;
  /** Monotonic clock-tick counter (one per clock rising edge). */
  tick: number;
  /** Clock tick at which the last event spawned (rate limiter). */
  lastSpawnTick: number;
  /** Monotonic id source for spawned events. */
  nextEventId: number;
  /** Deterministic PRNG state (xorshift32) for tie-breaking which CV channel
   *  spawns when several are eligible on the same beat. Pure + reproducible. */
  rng: number;
  /** Counters for the UI / tests. */
  hits: number;
  misses: number;
  /** Set on the tick a hit/miss/fire happens, consumed by the factory to pulse
   *  the matching audio gate output. Cleared by `drainOutEvents`. */
  outQueue: GibOutEvent[];
}

/** Side-effect events the GL/audio shell drains each frame to pulse gates +
 *  trigger animations. */
export interface GibOutEvent {
  type: 'hit' | 'miss' | 'fire' | 'kill' | 'degrade' | 'heal' | 'super' | 'gameover';
  kind?: GibEventKind;
}

/** Seed a fresh game. `seed` makes the spawn tie-breaking deterministic. */
export function newGame(seed = 0xc0de): GibState {
  return {
    events: [],
    health: 'healthy',
    combo: 0,
    score: 0,
    tick: 0,
    lastSpawnTick: -GIB_TUNING.minSpawnIntervalTicks,
    nextEventId: 1,
    rng: (seed >>> 0) || 0xc0de,
    hits: 0,
    misses: 0,
    outQueue: [],
  };
}

/** xorshift32 — deterministic, fast, no library. Advances + returns 0..1. */
function nextRand(s: GibState): number {
  let x = s.rng >>> 0;
  x ^= x << 13; x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5; x >>>= 0;
  s.rng = x >>> 0;
  return (x >>> 0) / 0xffffffff;
}

// ── Health-ladder helpers ──────────────────────────────────────────────────

function healthIndex(h: GibHealth): number {
  return HEALTH_LADDER.indexOf(h);
}

/** Move one rung WORSE (toward dead). Returns the resulting health. */
function degrade(s: GibState): GibHealth {
  const i = Math.min(HEALTH_LADDER.length - 1, healthIndex(s.health) + 1);
  s.health = HEALTH_LADDER[i]!;
  s.outQueue.push({ type: s.health === 'dead' ? 'gameover' : 'degrade' });
  return s.health;
}

/** Move one rung BETTER (toward super), but never past 'super' and never out
 *  of 'dead' (game over is terminal). */
function heal(s: GibState): GibHealth {
  if (s.health === 'dead') return s.health;
  const i = Math.max(0, healthIndex(s.health) - 1);
  const next = HEALTH_LADDER[i]!;
  if (next !== s.health) {
    s.health = next;
    s.outQueue.push({ type: next === 'super' ? 'super' : 'heal' });
  }
  return s.health;
}

// ── Spawn generation (PURE function of the inputs) ─────────────────────────

/**
 * Decide which (if any) event to spawn on a CLOCK BEAT, given the 4 CV levels
 * (0..1) and the current gate state. Pure: identical (state-snapshot, cv,
 * gateHigh) inputs always pick the same event (the only stochastic part — the
 * tie-break among multiple eligible channels — is driven by the state's
 * deterministic rng).
 *
 * Generation rule:
 *   - spawns only happen on a clock beat (the caller gates this) AND only when
 *     the rate limiter allows (≥ minSpawnIntervalTicks since the last spawn);
 *   - a CV channel is ELIGIBLE if its level exceeds cvSpawnThreshold;
 *   - among eligible channels, the gate state biases selection: when the beat
 *     gate is HIGH we pick the channel with the HIGHEST level (the strongest
 *     transient that beat); when LOW we still allow a spawn but only from the
 *     single strongest channel (so off-beat spawns are sparser);
 *   - ties break deterministically via the rng.
 *
 * Returns the chosen GibEventKind, or null for "no spawn this beat".
 */
export function chooseSpawn(
  s: GibState,
  cv: readonly number[],
  gateHigh: boolean,
  tuning: GibTuning = GIB_TUNING,
): GibEventKind | null {
  if (s.tick - s.lastSpawnTick < tuning.minSpawnIntervalTicks) return null;

  // Collect eligible channels (level over threshold).
  const eligible: { idx: number; level: number }[] = [];
  for (let i = 0; i < tuning.cvEventMap.length; i++) {
    const lvl = cv[i] ?? 0;
    if (lvl > tuning.cvSpawnThreshold) eligible.push({ idx: i, level: lvl });
  }
  if (eligible.length === 0) return null;

  // Highest level first; deterministic rng tie-break.
  eligible.sort((a, b) => (b.level - a.level) || (nextRand(s) - 0.5));

  // Off-beat (gate low): only the single strongest spawns, and only if it's
  // notably above threshold (avoids a steady mid-level CV continuously
  // dribbling spawns). On-beat (gate high): the strongest of the beat spawns.
  const top = eligible[0]!;
  if (!gateHigh && top.level < (tuning.cvSpawnThreshold + 1) / 2) return null;

  return tuning.cvEventMap[top.idx]!;
}

/** Spawn an event of `kind` at the right edge (pos 1.0). Updates the rate
 *  limiter. */
export function spawnEvent(s: GibState, kind: GibEventKind): GibEvent {
  const ev: GibEvent = {
    id: s.nextEventId++,
    kind,
    pos: 1.0,
    resolved: false,
    outcome: null,
    resolvedTick: null,
  };
  s.events.push(ev);
  s.lastSpawnTick = s.tick;
  return ev;
}

// ── Per-frame scroll + miss detection ──────────────────────────────────────

/**
 * Advance the ribbon by `delta` pos-units (the caller scales clock vs.
 * wall-clock). Any unresolved event that scrolls past `missPos` is judged a
 * MISS (the player let it reach the marine without the correct press) and
 * degrades the marine. Fully-offscreen resolved events are pruned.
 */
export function scroll(s: GibState, delta: number, tuning: GibTuning = GIB_TUNING): void {
  for (const ev of s.events) {
    ev.pos -= delta;
    if (!ev.resolved && ev.pos <= tuning.missPos) {
      registerMiss(s, ev);
    }
  }
  // Prune events that have fully scrolled off the left (keep a little tail so
  // the resolution animation can play before they vanish).
  s.events = s.events.filter((ev) => ev.pos > -0.4);
}

function registerMiss(s: GibState, ev: GibEvent): void {
  ev.resolved = true;
  ev.outcome = 'miss';
  ev.resolvedTick = s.tick;
  s.combo = 0;
  s.misses += 1;
  s.outQueue.push({ type: 'miss', kind: ev.kind });
  degrade(s);
}

// ── Input judgement (a button press) ───────────────────────────────────────

/**
 * Judge a player BUTTON PRESS. Finds the nearest UNRESOLVED event within the
 * timing window whose required button matches `button`. On a match → HIT
 * (success animation, score, combo, possible heal/super). A press with no
 * matching in-window event is simply ignored (no penalty for spare presses —
 * matches Vib-Ribbon's forgiveness of extra taps; the penalty is for MISSING,
 * handled in scroll()).
 *
 * Returns the resolved event on a hit, or null when the press matched nothing.
 */
export function judgePress(
  s: GibState,
  button: GibButton,
  tuning: GibTuning = GIB_TUNING,
): GibEvent | null {
  if (s.health === 'dead') return null;
  let best: GibEvent | null = null;
  let bestDist = Infinity;
  for (const ev of s.events) {
    if (ev.resolved) continue;
    if (EVENT_BUTTON[ev.kind] !== button) continue;
    const dist = Math.abs(ev.pos);
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

  s.outQueue.push({ type: 'hit', kind: ev.kind });
  // Enemy events fire the marine + play the death animation.
  if (ev.kind === 'imp' || ev.kind === 'zombie') {
    s.outQueue.push({ type: 'fire', kind: ev.kind });
    s.outQueue.push({ type: 'kill', kind: ev.kind });
  }

  // Streak rewards: super on a long streak, otherwise heal a rung every
  // healStreak hits (so a player recovering from critical can climb back).
  if (s.combo >= tuning.superStreak && s.health === 'healthy') {
    heal(s); // healthy → super
  } else if (s.combo > 0 && s.combo % tuning.healStreak === 0) {
    if (s.health === 'wounded' || s.health === 'critical') heal(s);
  }
}

// ── Tick driver ────────────────────────────────────────────────────────────

/**
 * Advance the game by ONE CLOCK TICK. This is the authoritative beat: it
 * increments the tick counter, applies one clock's worth of scroll, then runs
 * spawn generation from the CV/gate inputs. Between clock ticks the factory
 * also calls `scroll(s, scrollPerSecond * dt)` for smooth motion — but spawns
 * and the tick counter ONLY advance here, keeping generation deterministic per
 * beat.
 *
 * Pure aside from in-place mutation: identical (state, cv, gateHigh) inputs
 * always produce the same result.
 */
export function clockTick(
  s: GibState,
  cv: readonly number[],
  gateHigh: boolean,
  tuning: GibTuning = GIB_TUNING,
): void {
  if (s.health === 'dead') return;
  s.tick += 1;
  scroll(s, tuning.scrollPerClock, tuning);
  // scroll() may have ended the game via a miss; re-check (isGameOver reads the
  // live state so TS doesn't wrongly narrow s.health to non-'dead' here).
  if (isGameOver(s)) return;
  const kind = chooseSpawn(s, cv, gateHigh, tuning);
  if (kind) spawnEvent(s, kind);
}

/** Drain + clear the queued side-effect events (gates / animations). */
export function drainOutEvents(s: GibState): GibOutEvent[] {
  const out = s.outQueue;
  s.outQueue = [];
  return out;
}

/** Convenience: is the run over? */
export function isGameOver(s: GibState): boolean {
  return s.health === 'dead';
}

/** Map a health rung to a normalized 0..1 "vitality" for the CV health output
 *  (super=1, healthy=0.75, wounded=0.5, critical=0.25, dead=0). */
export function healthToCv(h: GibHealth): number {
  switch (h) {
    case 'super': return 1.0;
    case 'healthy': return 0.75;
    case 'wounded': return 0.5;
    case 'critical': return 0.25;
    case 'dead': return 0.0;
  }
}

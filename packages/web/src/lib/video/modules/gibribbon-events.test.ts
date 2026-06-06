// packages/web/src/lib/video/modules/gibribbon-events.test.ts
//
// Unit tests for the PURE GibRibbon event generator + game state machine.
// No GL, no DOM — this is the deterministic core the GL/audio factory wraps.

import { describe, it, expect } from 'vitest';
import {
  newGame,
  clockTick,
  scroll,
  spawnEvent,
  chooseSpawn,
  judgePress,
  drainOutEvents,
  healthToCv,
  autoplayCv,
  isGameOver,
  EVENT_BUTTON,
  GIB_TUNING,
  HEALTH_LADDER,
  type GibState,
  type GibEventKind,
} from './gibribbon-events';

/** Run a fixed clock/gate/CV input sequence and return the final state.
 *  `frames` is an array of [cv4, gateHigh] per clock beat. */
function drive(
  seed: number,
  frames: Array<{ cv: number[]; gate: boolean }>,
): GibState {
  const s = newGame(seed);
  for (const f of frames) clockTick(s, f.cv, f.gate);
  return s;
}

describe('GibRibbon event generator (pure)', () => {
  it('is deterministic: same seed + same inputs → identical event stream', () => {
    const frames = Array.from({ length: 30 }, (_, i) => ({
      cv: [i % 4 === 0 ? 0.9 : 0.1, i % 3 === 0 ? 0.8 : 0.0, 0.2, 0.6],
      gate: i % 2 === 0,
    }));
    const a = drive(123, frames);
    const b = drive(123, frames);
    // Same spawned event kinds in the same order.
    expect(a.events.map((e) => e.kind)).toEqual(b.events.map((e) => e.kind));
    expect(a.score).toBe(b.score);
    expect(a.nextEventId).toBe(b.nextEventId);
  });

  it('spawns nothing when all CV channels sit below the threshold', () => {
    const s = drive(1, Array.from({ length: 20 }, () => ({ cv: [0.1, 0.2, 0.0, 0.3], gate: true })));
    expect(s.events.length).toBe(0);
  });

  it('a hot CV channel spawns its mapped event kind', () => {
    // cv index 2 → 'imp' (default cvEventMap = [loop, jump, imp, zombie]).
    const s = newGame(7);
    // Need ≥ minSpawnIntervalTicks ticks since lastSpawnTick; first tick is fine
    // because lastSpawnTick seeds to -minSpawnIntervalTicks.
    clockTick(s, [0, 0, 0.95, 0], true);
    expect(s.events.length).toBe(1);
    expect(s.events[0]!.kind).toBe('imp');
  });

  it('rate-limits spawns to minSpawnIntervalTicks', () => {
    const s = newGame(7);
    const hot = [0.95, 0, 0, 0]; // cv0 → loop
    clockTick(s, hot, true); // tick 1: spawns
    clockTick(s, hot, true); // tick 2: too soon (interval = 2)
    expect(s.events.filter((e) => e.id <= 2).length).toBe(1);
    clockTick(s, hot, true); // tick 3: 2 ticks elapsed → spawns again
    expect(s.events.length).toBe(2);
  });

  it('on-beat gate picks the STRONGEST eligible channel', () => {
    const s = newGame(99);
    // cv0=loop (0.6), cv3=zombie (0.95) → zombie should win on the beat.
    const kind = chooseSpawn(s, [0.6, 0.0, 0.0, 0.95], true);
    expect(kind).toBe('zombie');
  });
});

describe('GibRibbon scroll + miss judgement', () => {
  it('an unjudged event that scrolls past missPos becomes a MISS and degrades', () => {
    const s = newGame(1);
    const ev = spawnEvent(s, 'jump');
    ev.pos = 0.0; // at the judgement point
    expect(s.health).toBe('healthy');
    // Scroll past the miss line.
    scroll(s, Math.abs(GIB_TUNING.missPos) + 0.05);
    expect(ev.outcome).toBe('miss');
    expect(s.misses).toBe(1);
    expect(s.combo).toBe(0);
    expect(s.health).toBe('wounded'); // degraded one rung
  });

  it('repeated misses walk down the ladder to GAME OVER', () => {
    const s = newGame(1);
    const miss = () => {
      const ev = spawnEvent(s, 'loop');
      ev.pos = GIB_TUNING.missPos + 0.001;
      scroll(s, 0.01);
    };
    // healthy → wounded → critical → dead.
    miss(); expect(s.health).toBe('wounded');
    miss(); expect(s.health).toBe('critical');
    miss(); expect(s.health).toBe('dead');
    expect(isGameOver(s)).toBe(true);
  });
});

describe('GibRibbon hit judgement', () => {
  it('a correct in-window button press resolves the matching event as a HIT', () => {
    const s = newGame(1);
    const ev = spawnEvent(s, 'jump'); // jump → button 'b'
    ev.pos = 0.02; // inside hitWindow (0.09)
    const hit = judgePress(s, EVENT_BUTTON.jump);
    expect(hit).toBe(ev);
    expect(ev.outcome).toBe('hit');
    expect(s.hits).toBe(1);
    expect(s.combo).toBe(1);
    expect(s.score).toBe(GIB_TUNING.scorePerHit); // combo mult 1 on first hit
  });

  it('the WRONG button does not clear an event (it stays unresolved → eventual miss)', () => {
    const s = newGame(1);
    const ev = spawnEvent(s, 'imp'); // imp → button 'x'
    ev.pos = 0.0;
    const res = judgePress(s, 'a'); // wrong button
    expect(res).toBeNull();
    expect(ev.resolved).toBe(false);
  });

  it('a press outside the timing window matches nothing', () => {
    const s = newGame(1);
    const ev = spawnEvent(s, 'loop');
    ev.pos = GIB_TUNING.hitWindow + 0.05; // too far right
    const res = judgePress(s, EVENT_BUTTON.loop);
    expect(res).toBeNull();
    expect(ev.resolved).toBe(false);
  });

  it('clearing an ENEMY (imp/zombie) queues fire + kill side-effects', () => {
    const s = newGame(1);
    const ev = spawnEvent(s, 'zombie'); // zombie → 'y'
    ev.pos = 0.0;
    judgePress(s, EVENT_BUTTON.zombie);
    const out = drainOutEvents(s);
    const types = out.map((o) => o.type);
    expect(types).toContain('hit');
    expect(types).toContain('fire');
    expect(types).toContain('kill');
  });

  it('clearing a LOOP/JUMP obstacle queues only a hit (no fire/kill)', () => {
    const s = newGame(1);
    const ev = spawnEvent(s, 'loop');
    ev.pos = 0.0;
    judgePress(s, EVENT_BUTTON.loop);
    const out = drainOutEvents(s);
    expect(out.map((o) => o.type)).toEqual(['hit']);
  });

  it('combo multiplies score and caps at maxComboMult', () => {
    const s = newGame(1);
    for (let i = 0; i < GIB_TUNING.maxComboMult + 3; i++) {
      const ev = spawnEvent(s, 'loop');
      ev.pos = 0.0;
      judgePress(s, EVENT_BUTTON.loop);
    }
    // Last hit's mult is capped, not unbounded.
    expect(s.combo).toBe(GIB_TUNING.maxComboMult + 3);
    // Score sum = scorePerHit * sum(min(maxComboMult, i) for i=1..n).
    const n = GIB_TUNING.maxComboMult + 3;
    let expected = 0;
    for (let i = 1; i <= n; i++) expected += GIB_TUNING.scorePerHit * Math.min(GIB_TUNING.maxComboMult, i);
    expect(s.score).toBe(expected);
  });

  it('a miss resets the combo to 0', () => {
    const s = newGame(1);
    const h = spawnEvent(s, 'loop'); h.pos = 0.0; judgePress(s, EVENT_BUTTON.loop);
    expect(s.combo).toBe(1);
    const m = spawnEvent(s, 'jump'); m.pos = GIB_TUNING.missPos + 0.001; scroll(s, 0.01);
    expect(s.combo).toBe(0);
  });
});

describe('GibRibbon health ladder (degrade / heal / super)', () => {
  it('a long clean streak promotes healthy → SUPER', () => {
    const s = newGame(1);
    for (let i = 0; i < GIB_TUNING.superStreak; i++) {
      const ev = spawnEvent(s, 'loop'); ev.pos = 0.0; judgePress(s, EVENT_BUTTON.loop);
    }
    expect(s.health).toBe('super');
    expect(drainOutEvents(newGame(1))).toEqual([]); // sanity: fresh state has no queue
  });

  it('hits while wounded heal back up the ladder', () => {
    const s = newGame(1);
    s.health = 'critical';
    // healStreak hits → climb critical → wounded.
    for (let i = 0; i < GIB_TUNING.healStreak; i++) {
      const ev = spawnEvent(s, 'loop'); ev.pos = 0.0; judgePress(s, EVENT_BUTTON.loop);
    }
    expect(s.health).toBe('wounded');
  });

  it('healthToCv maps each rung to a distinct 0..1 vitality', () => {
    const vals = HEALTH_LADDER.map(healthToCv);
    // strictly decreasing super(1) → dead(0)
    for (let i = 1; i < vals.length; i++) expect(vals[i]).toBeLessThan(vals[i - 1]!);
    expect(healthToCv('super')).toBe(1);
    expect(healthToCv('dead')).toBe(0);
  });

  it('once dead, clockTick and judgePress are inert', () => {
    const s = newGame(1);
    s.health = 'dead';
    clockTick(s, [0.99, 0.99, 0.99, 0.99], true);
    expect(s.events.length).toBe(0); // no spawn after death
    const ev = spawnEvent(s, 'loop'); ev.pos = 0;
    expect(judgePress(s, EVENT_BUTTON.loop)).toBeNull();
  });
});

describe('EVENT_BUTTON mapping', () => {
  it('maps the four event kinds to the four ABXY buttons 1:1', () => {
    const kinds: GibEventKind[] = ['loop', 'jump', 'imp', 'zombie'];
    const buttons = kinds.map((k) => EVENT_BUTTON[k]);
    expect(new Set(buttons).size).toBe(4); // all distinct
    expect(buttons).toEqual(['a', 'b', 'x', 'y']);
  });
});

// ── Phase-2 demo CV calibration ─────────────────────────────────────────────
//
// The bundled GIBRIBBON demo (gibribbon-demo.imp.json) drives cv1..cv4 from
// SYNESTHESIA copy-A's four SLOW (500 ms) envelope-followers tracking a
// sequenced MACROOSCILLATOR voice. We can't run the real DSP in vitest, so we
// model the four slow envelopes ANALYTICALLY as the demo's rhythm produces
// them, then push them through the SAME pure pipeline the factory uses
// (clockTick → chooseSpawn → scroll) and assert the resulting event RATE is
// game-appropriate and that all four event kinds appear. This is the
// deterministic guard for GIB_TUNING.cvSpawnThreshold / minSpawnIntervalTicks
// (and, indirectly, the SYNESTHESIA gain lift in the envelope generator).
describe('GibRibbon — Phase-2 demo CV calibration (synthetic slow envelopes)', () => {
  // Demo transport math (see gibribbon-demo.ts / build-gibribbon-demo-envelope.mjs):
  //   TIMELORDE bpm=120 → 2× (8th) = 0.25 s clocks MACSEQ (1 step = 0.25 s),
  //   1× (quarter) = 0.5 s is GIBRIBBON's scroll clock. So one GIBRIBBON clock
  //   tick = 2 MACSEQ steps; KICK (every 8 steps) = every 4 GIBRIBBON ticks.
  const MACSEQ_STEPS_PER_GIB_TICK = 2;
  const KICK_PERIOD_STEPS = 8;

  /**
   * Model the four SLOW (500 ms) SYNESTHESIA copy-A envelopes at GIBRIBBON
   * clock tick `tick`, plus the MACSEQ gate state on that tick.
   *
   * Bands (cv index → kind via the default cvEventMap [loop,jump,imp,zombie]):
   *   cv1 (low,      loop)   — energised by KICK; slow swell, phase 0.
   *   cv2 (low-mid,  jump)   — energised by SNARE (back-beat); phase shifted.
   *   cv3 (mid,      imp)    — the FM/STRING/WAVESHAPE melodic voices; phase shifted.
   *   cv4 (high,     zombie) — WAVESHAPE brightness / snare noise; phase shifted.
   *
   * Each band is a slow (period ≈ a few seconds) raised cosine in ~0.30..0.92,
   * phase-staggered so the strongest band rotates over the bar — exactly the
   * "four slow followers chase a moving spectral centroid" behaviour the real
   * SYNESTHESIA produces. The gate is HIGH on the GIBRIBBON ticks that align
   * with a KICK or SNARE MACSEQ step (the back-beat biases which band spawns).
   */
  function demoSample(tick: number): { cv: number[]; gate: boolean } {
    // Slow swell with a multi-second period (8 GIBRIBBON ticks = 4 s = one
    // KICK bar). Each band peaks (`0.5 - 0.5·cos` = 1 at `tick+phase = 4`) on
    // a DISTINCT even tick (0/2/4/6) so the spectral centroid rotates across
    // all four bands over the bar — i.e. each event kind gets its turn as the
    // strongest channel on a rate-limiter-eligible tick. This mirrors how
    // SYNESTHESIA's four slow followers each lead in turn as the sequenced
    // voice moves through its kick/snare/melodic spectral content.
    const period = 8;
    const band = (phase: number, lo: number, hi: number): number => {
      const c = 0.5 - 0.5 * Math.cos((2 * Math.PI * (tick + phase)) / period);
      return lo + c * (hi - lo);
    };
    const cv = [
      band(4, 0.30, 0.92), // cv1 low      (loop)   — peaks at tick 0, 8, …
      band(2, 0.30, 0.90), // cv2 low-mid  (jump)   — peaks at tick 2, 10, …
      band(0, 0.30, 0.88), // cv3 mid      (imp)    — peaks at tick 4, 12, …
      band(-2, 0.28, 0.86), // cv4 high    (zombie) — peaks at tick 6, 14, …
    ];
    // GIBRIBBON tick → first MACSEQ step it covers.
    const macseqStep = tick * MACSEQ_STEPS_PER_GIB_TICK;
    const onKick = macseqStep % KICK_PERIOD_STEPS === 0;
    const onSnare = macseqStep % KICK_PERIOD_STEPS === 4;
    return { cv, gate: onKick || onSnare };
  }

  /** Run the demo's synthetic stream for `ticks` GIBRIBBON clock ticks and
   *  collect the spawned-event kinds (one entry per spawn, in order).
   *
   *  We detect a spawn via the monotonic `nextEventId` (NOT by scanning
   *  `s.events`, which scroll() prunes as events leave the ribbon). A clock
   *  tick spawns at most ONE event (chooseSpawn returns ≤1 kind), at pos 1.0
   *  with the highest id, so the just-spawned event is always still present in
   *  `s.events` immediately after clockTick — read its kind there.
   *
   *  A COMPETENT PLAYER is simulated: after each clock tick we press the
   *  correct button for any in-window event (judgePress with the matching
   *  EVENT_BUTTON). This is what keeps the marine alive so we measure the pure
   *  SPAWN rate over the whole window rather than the truncated rate up to an
   *  unattended game-over (the demo is meant to be PLAYED). */
  function runDemo(seed: number, ticks: number): GibEventKind[] {
    const s = newGame(seed);
    const spawned: GibEventKind[] = [];
    let prevNextId = s.nextEventId;
    for (let t = 0; t < ticks; t++) {
      const { cv, gate } = demoSample(t);
      clockTick(s, cv, gate);
      if (s.nextEventId > prevNextId) {
        const justSpawned = s.events.find((e) => e.id === s.nextEventId - 1);
        if (justSpawned) spawned.push(justSpawned.kind);
        prevNextId = s.nextEventId;
      }
      // Perfect-player clear: judge every in-window unresolved event so the
      // marine survives the run (otherwise unattended misses end the game and
      // truncate the rate we're trying to measure).
      for (const ev of [...s.events]) {
        if (!ev.resolved && Math.abs(ev.pos) <= GIB_TUNING.hitWindow) {
          judgePress(s, EVENT_BUTTON[ev.kind]);
        }
      }
    }
    return spawned;
  }

  it('produces a game-appropriate event rate (~1 spawn per 1–3 scroll ticks)', () => {
    const TICKS = 64; // 32 s of play at 0.5 s/tick.
    const spawned = runDemo(0xc0de, TICKS);
    // minSpawnIntervalTicks=2 caps the rate at 1 / 2 ticks; the floor is "often
    // enough to be fun". Target ~1 per 1–3 ticks → spawns in [TICKS/3, TICKS/2].
    const lo = Math.floor(TICKS / 3); // ~21
    const hi = Math.ceil(TICKS / 2); // 32 (the hard cap)
    expect(spawned.length).toBeGreaterThanOrEqual(lo);
    expect(spawned.length).toBeLessThanOrEqual(hi);
    // Express as a per-tick rate for the human-readable record.
    const perTick = spawned.length / TICKS;
    expect(perTick).toBeGreaterThanOrEqual(1 / 3);
    expect(perTick).toBeLessThanOrEqual(1 / 2);
  });

  it('spawns ALL FOUR event kinds over a representative run', () => {
    const spawned = runDemo(0xc0de, 64);
    const kinds = new Set(spawned);
    expect(kinds.has('loop')).toBe(true);
    expect(kinds.has('jump')).toBe(true);
    expect(kinds.has('imp')).toBe(true);
    expect(kinds.has('zombie')).toBe(true);
  });

  it('honours minSpawnIntervalTicks: never two spawns on adjacent ticks', () => {
    // Drive with all-bands-hot every tick: the rate limiter must still gate it
    // to at most one spawn per 2 ticks (no carpet-bomb even at max energy).
    const s = newGame(7);
    const hot = [0.9, 0.9, 0.9, 0.9];
    let lastSpawnAtTick = -10;
    for (let t = 0; t < 40; t++) {
      const before = s.nextEventId;
      clockTick(s, hot, true);
      if (s.nextEventId > before) {
        expect(t - lastSpawnAtTick).toBeGreaterThanOrEqual(GIB_TUNING.minSpawnIntervalTicks);
        lastSpawnAtTick = t;
      }
    }
  });

  it('the resting floor (all bands below threshold) still spawns NOTHING', () => {
    // SYNESTHESIA at rest sits well under cvSpawnThreshold (0.42); confirm the
    // lowered threshold did not turn silence into a spawn source.
    const s = newGame(1);
    for (let t = 0; t < 30; t++) clockTick(s, [0.2, 0.25, 0.15, 0.3], true);
    expect(s.events.length).toBe(0);
  });

  it('is deterministic for the demo stream (same seed → identical kinds)', () => {
    const a = runDemo(0xabcd, 50);
    const b = runDemo(0xabcd, 50);
    expect(a).toEqual(b);
  });
});

describe('GibRibbon AUTOPLAY cv (self-play when no external clock/CV patched)', () => {
  it('returns 4 channels; non-rest beats raise exactly one above the spawn threshold', () => {
    let hotBeats = 0;
    let restBeats = 0;
    for (let b = 1; b <= 60; b++) {
      const cv = autoplayCv(b);
      expect(cv).toHaveLength(4);
      const hot = cv.filter((v) => v > GIB_TUNING.cvSpawnThreshold);
      if (hot.length === 0) restBeats++;
      else {
        hotBeats++;
        expect(hot).toHaveLength(1); // exactly one channel hot per active beat
      }
    }
    expect(hotBeats).toBeGreaterThan(0);
    expect(restBeats).toBeGreaterThan(0); // there ARE rests (not a metronome)
  });

  it('is deterministic in beat (same beat → same cv)', () => {
    expect(autoplayCv(17)).toEqual(autoplayCv(17));
    expect(autoplayCv(18)).not.toEqual(autoplayCv(17)); // rotates / rests vary
  });

  it('driving clockTick with autoplayCv self-plays: all 4 event kinds spawn, no input', () => {
    // Mirrors the module's INTERNAL clock: tick the game purely from autoplayCv
    // (no external clock/CV). The card must produce a live, varied event stream.
    const s = newGame(3);
    const seen = new Set<GibEventKind>();
    for (let b = 1; b <= 200; b++) {
      clockTick(s, autoplayCv(b), true);
      for (const ev of s.events) seen.add(ev.kind);
    }
    expect(s.events.length + s.score).toBeGreaterThan(0); // events actually spawned
    expect(seen).toEqual(new Set<GibEventKind>(['loop', 'jump', 'imp', 'zombie']));
  });
});

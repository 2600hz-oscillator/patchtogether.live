// packages/web/src/lib/video/modules/gibribbon-engine.test.ts
//
// The rewritten GIBRIBBON pure core, under test:
//   - the ported game-feel suites (judgement, ladder, combo/score, aim, lane,
//     restart) — kept from the original build because none of them were the
//     broken part;
//   - the KEPT #635 zero-un-hittable PHASE SWEEP, re-aimed at the new
//     one-clock stepper (plus its negative control reproducing the old
//     dual-clock hole, so the sweep cannot go vacuously green);
//   - the NEW adaptive-extraction basics (relative prominence, resting-floor,
//     gain invariance, rank competition, rate limiting) — the F1 gate. The
//     full source-corpus liveness property test (incl. the #701 fixture
//     voice) lives in gibribbon-liveness.test.ts;
//   - ATTRACT mode semantics (honest self-play, insert-coin exit, idle
//     re-entry, autoplay=0 never self-plays) — the F3 gate;
//   - determinism: same seed + same input stream ⇒ identical state.

import { describe, it, expect } from 'vitest';
import {
  GIB_TUNING,
  DEFAULT_STEP_PARAMS,
  IDLE_INPUTS,
  EVENT_BUTTON,
  HEALTH_LADDER,
  newRun,
  step,
  courseTick,
  judgePress,
  judgePhase,
  effectivePos,
  upcomingLane,
  drainOutEvents,
  setAim,
  healthToCv,
  attractCv,
  attractGate,
  isGameOver,
  type GibState,
  type GibStepInputs,
  type GibStepParams,
  type GibEvent,
  type GibEventKind,
  type GibButton,
} from './gibribbon-engine';

const PLAY: GibStepParams = { ...DEFAULT_STEP_PARAMS, attract: 0 };

function inputs(over: Partial<GibStepInputs> = {}): GibStepInputs {
  return { ...IDLE_INPUTS, ...over };
}

/** One externally-clocked course tick through the real stepper. */
function clockStep(s: GibState, over: Partial<GibStepInputs> = {}): void {
  step(s, inputs({ clockEdges: 1, activity: true, ...over }), PLAY);
}

/** Warm a play-mode run past the count-in with flat CV (nothing spawns). */
function warmPastCountIn(s: GibState): void {
  for (let i = 0; i <= GIB_TUNING.countInTicks; i++) clockStep(s);
}

/** Prime channel `idx`'s rolling window with a resting floor then spike it —
 *  the minimal "varying source" the adaptive extractor requires. Returns
 *  after the spike's course tick (the spawn tick, if eligible). */
function spikeChannel(s: GibState, idx: number, level = 0.95): void {
  const cv = [0, 0, 0, 0];
  cv[idx] = level;
  clockStep(s, { cv, gate: 1 });
}

/** Manually place an unresolved event (the sweep + judgement fixtures). */
function placeEvent(s: GibState, kind: GibEventKind, pos: number): GibEvent {
  const ev: GibEvent = {
    id: s.nextEventId++,
    kind,
    pos,
    resolved: false,
    outcome: null,
    resolvedTick: null,
  };
  s.events.push(ev);
  return ev;
}

describe('GIBRIBBON engine — determinism (the M3 bar, state half)', () => {
  it('same seed + same input stream ⇒ identical state, twice over', () => {
    const script = (s: GibState) => {
      warmPastCountIn(s);
      spikeChannel(s, 2);
      for (let i = 0; i < 7; i++) clockStep(s);
      step(s, inputs({ buttons: ['x'], activity: true }), PLAY);
      for (let i = 0; i < 40; i++) step(s, inputs(), PLAY);
    };
    const a = newRun(0xc0de, 'play');
    const b = newRun(0xc0de, 'play');
    script(a);
    script(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('attract runs are identical across boots with the same seed', () => {
    const a = newRun(0x5eed, 'attract');
    const b = newRun(0x5eed, 'attract');
    for (let i = 0; i < 800; i++) {
      step(a, IDLE_INPUTS, DEFAULT_STEP_PARAMS);
      step(b, IDLE_INPUTS, DEFAULT_STEP_PARAMS);
    }
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('GIBRIBBON engine — adaptive extraction basics (F1)', () => {
  it('raw silence spawns NOTHING (resting-floor guard)', () => {
    const s = newRun(1, 'play');
    for (let i = 0; i < 60; i++) clockStep(s);
    expect(s.events).toHaveLength(0);
    expect(s.nextEventId).toBe(1);
  });

  it('a stuck DC rail spawns NOTHING at ANY level — flat is dead, not loud', () => {
    for (const level of [0.2, 0.5, 0.99]) {
      const s = newRun(1, 'play');
      for (let i = 0; i < 60; i++) clockStep(s, { cv: [level, level, level, level], gate: 1 });
      expect(s.events, `flat DC at ${level}`).toHaveLength(0);
    }
  });

  it('a varying channel spawns its mapped kind', () => {
    const s = newRun(1, 'play');
    warmPastCountIn(s);
    spikeChannel(s, 2); // cv3 → imp
    expect(s.events).toHaveLength(1);
    expect(s.events[0]!.kind).toBe('imp');
  });

  it('GAIN INVARIANCE: scaling the whole source leaves the spawn sequence identical', () => {
    // The F1 property in miniature: prominence is measured against the
    // channel's OWN range, so a linear gain change cannot alter eligibility
    // or rank. (The full corpus version, incl. the #701 voice at broken
    // gains, is in gibribbon-liveness.test.ts.)
    const spawnLog = (scale: number): string => {
      const s = newRun(7, 'play');
      const log: string[] = [];
      let lastId = s.nextEventId;
      for (let t = 0; t < 96; t++) {
        // A deterministic 4-channel pattern with per-channel character.
        const cv = [
          (t % 8 === 0 ? 0.9 : 0.1) * scale,
          (t % 8 === 4 ? 0.7 : 0.15) * scale,
          (t % 5 === 2 ? 0.6 : 0.05) * scale,
          (t % 7 === 3 ? 0.5 : 0.1) * scale,
        ];
        clockStep(s, { cv, gate: 1 });
        if (s.nextEventId > lastId) {
          const ev = s.events.find((e) => e.id === s.nextEventId - 1);
          log.push(`${s.tick}:${ev?.kind}`);
          lastId = s.nextEventId;
        }
      }
      return log.join(',');
    };
    const unity = spawnLog(1.0);
    expect(unity.length).toBeGreaterThan(0);
    expect(spawnLog(0.5)).toBe(unity);
    expect(spawnLog(0.1)).toBe(unity);
  });

  it('RANK COMPETITION: a quiet channel beside a loud one still spawns (no starvation)', () => {
    const s = newRun(3, 'play');
    const seen = new Set<GibEventKind>();
    let lastId = s.nextEventId;
    for (let t = 0; t < 128; t++) {
      const cv = [
        t % 4 === 0 ? 0.95 : 0.2, // loud, busy channel
        t % 8 === 2 ? 0.12 : 0.02, // quiet channel, own rhythm, 8x smaller
        0,
        0,
      ];
      clockStep(s, { cv, gate: 1 });
      if (s.nextEventId > lastId) {
        const ev = s.events.find((e) => e.id === s.nextEventId - 1);
        if (ev) seen.add(ev.kind);
        lastId = s.nextEventId;
      }
    }
    expect(seen.has('loop'), 'the loud channel spawns').toBe(true);
    expect(seen.has('jump'), 'the QUIET channel must also spawn — rank, not level').toBe(true);
  });

  it('rate-limits spawns to the difficulty-scaled minimum gap', () => {
    const s = newRun(1, 'play');
    const spawnedAt: number[] = [];
    let lastId = s.nextEventId;
    for (let t = 0; t < 64; t++) {
      const cv = [t % 2 === 0 ? 0.9 : 0.05, 0, 0, 0];
      clockStep(s, { cv, gate: 1 });
      if (s.nextEventId > lastId) { spawnedAt.push(s.tick); lastId = s.nextEventId; }
    }
    expect(spawnedAt.length).toBeGreaterThan(2);
    for (let i = 1; i < spawnedAt.length; i++) {
      expect(spawnedAt[i]! - spawnedAt[i - 1]!).toBeGreaterThanOrEqual(2); // gap at difficulty 0.5
    }
  });

  it('the count-in suppresses ALL spawns for the opening ticks', () => {
    const s = newRun(1, 'play');
    // Hot varying feed from tick 1 — still nothing during the count-in
    // (the guard covers ticks 1..countInTicks inclusive).
    for (let i = 0; i < GIB_TUNING.countInTicks; i++) {
      clockStep(s, { cv: [i % 2 === 0 ? 0.9 : 0.0, 0, 0, 0], gate: 1 });
      expect(s.events, `tick ${s.tick} is inside the count-in`).toHaveLength(0);
    }
  });

  it('the gate is a BIAS, never a hard gate: off-beat spawns still happen', () => {
    const s = newRun(1, 'play');
    warmPastCountIn(s);
    spikeChannel(s, 0, 0.95);
    // gate low on the spike tick — prominence 1.0 clears even the unbiased bar.
    const s2 = newRun(1, 'play');
    warmPastCountIn(s2);
    clockStep(s2, { cv: [0.95, 0, 0, 0], gate: 0 });
    expect(s2.events.length, 'a full-range peak spawns with the gate LOW').toBe(1);
  });
});

describe('GIBRIBBON engine — scroll + miss judgement (ported)', () => {
  it('an unjudged event that scrolls past missPos becomes a MISS and degrades', () => {
    const s = newRun(1, 'play');
    warmPastCountIn(s);
    spikeChannel(s, 0);
    expect(s.events).toHaveLength(1);
    for (let i = 0; i < 10; i++) clockStep(s);
    const ev = s.events.find((e) => e.outcome === 'miss');
    expect(ev).toBeTruthy();
    expect(s.health).toBe('wounded');
    expect(s.misses).toBe(1);
    const out = drainOutEvents(s);
    expect(out.some((e) => e.type === 'miss')).toBe(true);
    expect(out.some((e) => e.type === 'degrade')).toBe(true);
  });

  it('repeated misses walk down the ladder to GAME OVER (and pulse it once)', () => {
    const s = newRun(1, 'play');
    warmPastCountIn(s);
    for (let m = 0; m < 3; m++) {
      spikeChannel(s, 0);
      for (let i = 0; i < 10; i++) clockStep(s);
    }
    expect(s.health).toBe('dead');
    expect(isGameOver(s)).toBe(true);
    const out = drainOutEvents(s);
    expect(out.filter((e) => e.type === 'gameover')).toHaveLength(1);
    // Dead ⇒ the course is inert.
    const tickBefore = s.tick;
    clockStep(s);
    expect(s.tick).toBe(tickBefore);
    expect(judgePress(s, 'a', 0)).toBeNull();
  });
});

describe('GIBRIBBON engine — hit judgement (ported, phase-anchored)', () => {
  it('a correct in-window button press through step() resolves a HIT', () => {
    const s = newRun(1, 'play');
    warmPastCountIn(s);
    spikeChannel(s, 2); // imp at spawnPos = 1.44
    for (let i = 0; i < 7; i++) clockStep(s); // pos → 0.18
    // Course tick + press in one step: pos → 0.0, phase 0 → dead-centre hit.
    step(s, inputs({ clockEdges: 1, buttons: ['x'], activity: true }), PLAY);
    const ev = s.events.find((e) => e.kind === 'imp');
    expect(ev?.outcome).toBe('hit');
    expect(s.score).toBeGreaterThan(0);
    expect(s.hits).toBe(1);
    expect(s.presses).toBe(1);
  });

  it('the WRONG button does not clear an event', () => {
    const s = newRun(1, 'play');
    warmPastCountIn(s);
    spikeChannel(s, 2);
    for (let i = 0; i < 7; i++) clockStep(s);
    step(s, inputs({ clockEdges: 1, buttons: ['a'], activity: true }), PLAY);
    const ev = s.events.find((e) => e.kind === 'imp');
    expect(ev?.resolved).toBe(false);
    expect(s.score).toBe(0);
  });

  it('a press outside the timing window matches nothing (spare presses are free)', () => {
    const s = newRun(1, 'play');
    placeEvent(s, 'loop', 0.5);
    expect(judgePress(s, 'a', 0)).toBeNull();
    expect(s.combo).toBe(0);
  });

  it('clearing an ENEMY queues fire + kill; an obstacle queues only the hit', () => {
    const s = newRun(1, 'play');
    placeEvent(s, 'imp', 0.0);
    judgePress(s, 'x', 0);
    let out = drainOutEvents(s);
    expect(out.map((e) => e.type)).toEqual(expect.arrayContaining(['hit', 'fire', 'kill']));
    placeEvent(s, 'jump', 0.0);
    judgePress(s, 'b', 0);
    out = drainOutEvents(s);
    expect(out.some((e) => e.type === 'hit')).toBe(true);
    expect(out.some((e) => e.type === 'fire')).toBe(false);
    expect(out.some((e) => e.type === 'kill')).toBe(false);
  });

  it('combo multiplies score and caps at maxComboMult; a miss resets it', () => {
    const s = newRun(1, 'play');
    const per = GIB_TUNING.scorePerHit;
    for (let i = 0; i < 10; i++) {
      placeEvent(s, 'loop', 0.0);
      judgePress(s, 'a', 0);
    }
    // 1+2+…+8 then capped at 8: 36 + 2·8 = 52 units.
    expect(s.score).toBe(per * 52);
    expect(s.combo).toBe(10);
    const ev = placeEvent(s, 'jump', GIB_TUNING.missPos + 0.01);
    ev.pos = GIB_TUNING.missPos - 0.001;
    // Simulate the miss the course would register.
    courseTick(s, [0, 0, 0, 0], false, PLAY);
    expect(s.combo).toBe(0);
  });
});

describe('GIBRIBBON engine — health ladder (ported)', () => {
  it('a long clean streak promotes healthy → SUPER', () => {
    const s = newRun(1, 'play');
    for (let i = 0; i < GIB_TUNING.superStreak; i++) {
      placeEvent(s, 'loop', 0.0);
      judgePress(s, 'a', 0);
    }
    expect(s.health).toBe('super');
    expect(drainOutEvents(s).some((e) => e.type === 'super')).toBe(true);
  });

  it('hits while wounded heal back up the ladder', () => {
    const s = newRun(1, 'play');
    s.health = 'wounded';
    for (let i = 0; i < GIB_TUNING.healStreak; i++) {
      placeEvent(s, 'loop', 0.0);
      judgePress(s, 'a', 0);
    }
    expect(s.health).toBe('healthy');
  });

  it('healthToCv maps each rung to a distinct descending 0..1 vitality', () => {
    const values = HEALTH_LADDER.map(healthToCv);
    expect(values).toEqual([1.0, 0.75, 0.5, 0.25, 0.0]);
    for (let i = 1; i < values.length; i++) expect(values[i]!).toBeLessThan(values[i - 1]!);
  });
});

describe('GIBRIBBON engine — joystick AIM (ported)', () => {
  it('setAim clamps both axes to −1..1', () => {
    const s = newRun(1, 'play');
    setAim(s, 5, -7);
    expect(s.aimX).toBe(1);
    expect(s.aimY).toBe(-1);
    setAim(s, Number.NaN, 0.5);
    expect(s.aimX).toBe(0);
    expect(s.aimY).toBe(0.5);
  });

  it('aimX re-centres the judgement point (lead/lag) without widening it', () => {
    const s = newRun(1, 'play');
    // An event one window EARLY (pos 0.2): unreachable centred, reachable led.
    placeEvent(s, 'loop', 0.2);
    expect(judgePress(s, 'a', 0)).toBeNull();
    setAim(s, 1, 0);
    expect(judgePress(s, 'a', 0)).not.toBeNull();
    // NOT a wider window: two windows away stays unreachable even at full aim.
    const s2 = newRun(1, 'play');
    setAim(s2, 1, 0);
    placeEvent(s2, 'loop', 0.34);
    expect(judgePress(s2, 'a', 0)).toBeNull();
  });
});

describe('GIBRIBBON engine — lookahead lane (ported, phase-adjusted)', () => {
  it('returns the next-N unresolved events NEAREST the marine first', () => {
    const s = newRun(1, 'play');
    placeEvent(s, 'zombie', 0.9);
    placeEvent(s, 'loop', 0.1);
    placeEvent(s, 'imp', 0.5);
    const lane = upcomingLane(s, 0);
    expect(lane.map((l) => l.kind)).toEqual(['loop', 'imp', 'zombie']);
    expect(lane.map((l) => l.button)).toEqual(['a', 'x', 'y']);
  });

  it('caps the lane, excludes resolved events, flags the in-window slot HOT', () => {
    const s = newRun(1, 'play');
    for (let i = 0; i < 6; i++) placeEvent(s, 'loop', 0.3 + i * 0.2);
    const cleared = placeEvent(s, 'jump', 0.05);
    cleared.resolved = true;
    cleared.outcome = 'hit';
    placeEvent(s, 'imp', 0.02);
    const lane = upcomingLane(s, 0);
    expect(lane).toHaveLength(4);
    expect(lane[0]!.kind).toBe('imp');
    expect(lane[0]!.hot).toBe(true);
    expect(lane.some((l) => l.kind === 'jump')).toBe(false);
    expect(lane[1]!.hot).toBe(false);
  });
});

describe('GIBRIBBON engine — ATTRACT mode (F3: the honest self-play)', () => {
  it('a bare idle module self-plays: spawns, clears, scores — and SAYS attract', () => {
    const s = newRun(0xa77 , 'attract');
    for (let i = 0; i < 2400; i++) step(s, IDLE_INPUTS, DEFAULT_STEP_PARAMS);
    expect(s.mode).toBe('attract');
    expect(s.nextEventId).toBeGreaterThan(4);
    expect(s.score, 'the attract bot clears through the REAL judge').toBeGreaterThan(0);
    expect(s.health).not.toBe('dead');
  });

  it('attract shows a VARIED course: ≥3 distinct kinds among early spawns', () => {
    const s = newRun(0xa77, 'attract');
    const seen = new Set<GibEventKind>();
    let lastId = s.nextEventId;
    for (let i = 0; i < 2400 && seen.size < 3; i++) {
      step(s, IDLE_INPUTS, DEFAULT_STEP_PARAMS);
      while (lastId < s.nextEventId) {
        const ev = s.events.find((e) => e.id === lastId);
        if (ev) seen.add(ev.kind);
        lastId += 1;
      }
    }
    expect(seen.size).toBeGreaterThanOrEqual(3);
  });

  it('attract feeds the SAME extractor: its CV rotates all four channels', () => {
    const perChannel = [0, 0, 0, 0];
    for (let t = 0; t < 64; t++) {
      const cv = attractCv(t);
      for (let i = 0; i < 4; i++) if (cv[i]! > 0) perChannel[i] += 1;
    }
    for (let i = 0; i < 4; i++) expect(perChannel[i], `channel ${i}`).toBeGreaterThan(0);
    // …with rests, so the course breathes.
    let rests = 0;
    for (let t = 0; t < 64; t++) if (!attractGate(t)) rests += 1;
    expect(rests).toBeGreaterThan(8);
  });

  it('INSERT COIN: any real input exits attract into a fresh PLAY run', () => {
    const s = newRun(0xa77, 'attract');
    for (let i = 0; i < 1200; i++) step(s, IDLE_INPUTS, DEFAULT_STEP_PARAMS);
    expect(s.score).toBeGreaterThan(0);
    step(s, inputs({ buttons: ['x'], activity: true }), DEFAULT_STEP_PARAMS);
    expect(s.mode).toBe('play');
    expect(s.score).toBe(0);
    expect(s.tick).toBe(0);
    // The coin press was consumed by the start — it judged nothing.
    expect(s.presses).toBe(0);
  });

  it('idle long enough with attract enabled ⇒ self-play RESUMES', () => {
    const s = newRun(1, 'play');
    const ticksToIdle = Math.ceil(GIB_TUNING.attractIdleMs / DEFAULT_STEP_PARAMS.tickMs) + 2;
    for (let i = 0; i < ticksToIdle; i++) step(s, IDLE_INPUTS, DEFAULT_STEP_PARAMS);
    expect(s.mode).toBe('attract');
  });

  it('toggling ATTRACT OFF mid-attract stops self-play IMMEDIATELY', () => {
    const s = newRun(0xa77, 'attract');
    for (let i = 0; i < 600; i++) step(s, IDLE_INPUTS, DEFAULT_STEP_PARAMS);
    expect(s.mode).toBe('attract');
    step(s, IDLE_INPUTS, PLAY); // attract param now 0
    expect(s.mode).toBe('play');
    expect(s.score).toBe(0);
    // …and it does not creep back while the toggle stays off.
    for (let i = 0; i < 200; i++) step(s, IDLE_INPUTS, PLAY);
    expect(s.mode).toBe('play');
  });

  it('attract DISABLED (autoplay=0) ⇒ the module NEVER self-plays', () => {
    const s = newRun(1, 'play');
    const ticksToIdle = Math.ceil(GIB_TUNING.attractIdleMs / PLAY.tickMs) * 2;
    for (let i = 0; i < ticksToIdle; i++) step(s, IDLE_INPUTS, PLAY);
    expect(s.mode).toBe('play');
    // The internal tempo still runs the course (one tick path) — but with
    // flat CV nothing spawns, so the ribbon is honestly empty.
    expect(s.tick).toBeGreaterThan(0);
    expect(s.events).toHaveLength(0);
  });

  it('attract auto-restarts after its own game over (banner hold first)', () => {
    const s = newRun(1, 'attract');
    // Force a death mid-attract.
    s.health = 'critical';
    placeEvent(s, 'loop', GIB_TUNING.missPos + 0.001);
    // March: the miss lands on the next course tick, then the banner holds,
    // then the bot restarts.
    let sawDead = false;
    for (let i = 0; i < 400; i++) {
      step(s, IDLE_INPUTS, DEFAULT_STEP_PARAMS);
      if (isGameOver(s)) sawDead = true;
      if (sawDead && !isGameOver(s)) break;
    }
    expect(sawDead).toBe(true);
    expect(s.health).not.toBe('dead');
    expect(s.mode).toBe('attract');
  });
});

describe('GIBRIBBON engine — RESTART (the new gate port, one path)', () => {
  it('a restart edge mid-run hard-resets to a fresh PLAY run', () => {
    const s = newRun(1, 'play');
    warmPastCountIn(s);
    spikeChannel(s, 0);
    for (let i = 0; i < 8; i++) clockStep(s);
    step(s, inputs({ clockEdges: 1, buttons: ['a'], activity: true }), PLAY);
    expect(s.score + s.misses).toBeGreaterThan(0);
    step(s, inputs({ restartEdges: 1, activity: true }), PLAY);
    expect(s.tick).toBe(0);
    expect(s.score).toBe(0);
    expect(s.health).toBe('healthy');
    expect(s.mode).toBe('play');
  });

  it('a restart edge from GAME OVER starts a fresh run', () => {
    const s = newRun(1, 'play');
    warmPastCountIn(s);
    for (let m = 0; m < 3; m++) {
      spikeChannel(s, 0);
      for (let i = 0; i < 10; i++) clockStep(s);
    }
    expect(s.health).toBe('dead');
    step(s, inputs({ restartEdges: 1, activity: true }), PLAY);
    expect(s.health).toBe('healthy');
    expect(s.tick).toBe(0);
  });

  it('successive restarts stay a pure function of the boot seed', () => {
    const run = () => {
      const s = newRun(0xfeed, 'play');
      step(s, inputs({ restartEdges: 1, activity: true }), PLAY);
      step(s, inputs({ restartEdges: 1, activity: true }), PLAY);
      return s.rng;
    };
    expect(run()).toBe(run());
  });
});

describe('GIBRIBBON engine — ZERO-UN-HITTABLE (the kept #635 invariant, one clock)', () => {
  it('the per-course-tick step is STRICTLY LESS than the full window width (with margin)', () => {
    const windowWidth = 2 * GIB_TUNING.hitWindow;
    expect(GIB_TUNING.scrollPerTick).toBeLessThan(windowWidth);
    expect(windowWidth - GIB_TUNING.scrollPerTick).toBeGreaterThanOrEqual(0.02);
    expect(GIB_TUNING.missPos).toBeLessThan(-GIB_TUNING.hitWindow);
  });

  /**
   * The sweep, re-aimed at the new engine. An event is UN-HITTABLE iff there
   * is NO scheduler tick at which a press would land it — i.e. no tick where
   * |effectivePos − centre| ≤ hitWindow. The old lever (sub-beat phase at
   * spawn) sweeps via the beat accumulator; the old fps lever is replaced by
   * TEMPO, because in the one-clock design the frame rate cannot appear in
   * the judgement at all (judgement reads only tick counts — that absence IS
   * the fix, and this sweep pins the remaining lever).
   *
   * Swept for the CENTRED aim AND both aim extremes, so the re-centring aid
   * can never manufacture an unreachable event either.
   */
  function eventEverJudgeable(phase01: number, tempoBpm: number, aimX: number): boolean {
    const params: GibStepParams = { ...PLAY, tempoBpm };
    const s = newRun(1, 'play');
    setAim(s, aimX, 0);
    const beatMs = (() => {
      // Recover the effective beat length the stepper will use by observing
      // course ticks rather than re-deriving the formula (instrument honesty).
      const probe = newRun(1, 'play');
      let steps = 0;
      while (probe.tick < 1 && steps < 4000) { step(probe, IDLE_INPUTS, params); steps += 1; }
      return steps * params.tickMs;
    })();
    s.beatAccMs = phase01 * beatMs;
    const ev = placeEvent(s, 'loop', GIB_TUNING.spawnPos);
    const centre = s.aimX * GIB_TUNING.hitWindow;
    let ever = false;
    for (let i = 0; i < 6000; i++) {
      step(s, IDLE_INPUTS, params);
      const live = s.events.find((e) => e.id === ev.id);
      if (!live) break;
      const p = effectivePos(live, judgePhase(s, params));
      if (!live.resolved && Math.abs(p - centre) <= GIB_TUNING.hitWindow) ever = true;
      if (live.resolved) break;
    }
    return ever;
  }

  it('ZERO un-hittable events across a dense phase sweep at multiple tempos + aim extremes', () => {
    const PHASES = 400;
    for (const tempo of [60, 80, 100, 120, 143, 160, 180]) {
      for (const aim of [0, -1, 1]) {
        let unhittable = 0;
        for (let p = 0; p < PHASES; p += 1) {
          if (!eventEverJudgeable(p / PHASES, tempo, aim)) unhittable += 1;
        }
        expect(
          unhittable,
          `un-hittable at ${tempo} BPM, aim ${aim}: ${unhittable}/${PHASES}`,
        ).toBe(0);
      }
    }
  }, 60_000);

  it('REGRESSION GUARD: the OLD dual-clock judgement (tick-jump, window==step) WAS un-hittable', () => {
    // Re-create the pre-rewrite defect shape: judgement only sees positions
    // at COURSE-TICK boundaries (no phase adjustment) with the old 0.09
    // half-window against the 0.18 step, plus the old wall-clock dt scroll.
    // The sweep must FIND holes here, or the zero above is vacuous.
    const OLD_STEP = 0.18;
    const OLD_WINDOW = 0.09;
    const INTERNAL_BEAT_S = 0.42;
    const dt = 1 / 30;
    let unhittable = 0;
    const PHASES = 400;
    for (let p = 0; p < PHASES; p++) {
      let pos = 1.0;
      let beatAcc = (p / PHASES) * INTERNAL_BEAT_S;
      let t = 0;
      let ever = false;
      while (pos > -0.4 && t < 30) {
        t += dt;
        beatAcc += dt;
        while (beatAcc >= INTERNAL_BEAT_S) {
          beatAcc -= INTERNAL_BEAT_S;
          pos -= OLD_STEP;
        }
        pos -= 0.22 * dt; // the old scrollPerSecond smooth term
        if (Math.abs(pos) <= OLD_WINDOW) ever = true;
      }
      if (!ever) unhittable++;
    }
    expect(unhittable).toBeGreaterThan(0);
  });

  it('EVENT_BUTTON maps the four kinds to the four buttons 1:1 (contract)', () => {
    const kinds: GibEventKind[] = ['loop', 'jump', 'imp', 'zombie'];
    const buttons = kinds.map((k) => EVENT_BUTTON[k]);
    expect(buttons).toEqual(['a', 'b', 'x', 'y']);
    expect(new Set(buttons).size).toBe(4);
  });

  it('external clock ownership: internal tempo pauses while edges arrive', () => {
    const s = newRun(1, 'play');
    // Take over with a clock edge, then idle within the hold window.
    clockStep(s);
    const tickAfterEdge = s.tick;
    const holdTicks = Math.floor(GIB_TUNING.externalClockHoldMs / PLAY.tickMs) - 1;
    for (let i = 0; i < holdTicks; i++) step(s, inputs(), PLAY);
    expect(s.tick, 'no internal course ticks while the external clock owns').toBe(tickAfterEdge);
    // After the hold lapses the internal tempo resumes the SAME path.
    for (let i = 0; i < 200; i++) step(s, inputs(), PLAY);
    expect(s.tick).toBeGreaterThan(tickAfterEdge);
  });
});

describe('GIBRIBBON engine — no wall-clock, no ambient randomness (source contract)', () => {
  it('press buttons map is total and self-consistent', () => {
    const btns = new Set<GibButton>(Object.values(EVENT_BUTTON));
    expect(btns.size).toBe(4);
  });

  it('extractSpawn never reads absolute levels: doubling a flat floor changes nothing', () => {
    // A flat floor at 0.0 and a flat floor at 0.4 with the same spikes on top
    // produce the same spawn decisions (prominence is range-relative).
    const log = (floor: number): string => {
      const s = newRun(11, 'play');
      const out: string[] = [];
      let lastId = s.nextEventId;
      for (let t = 0; t < 64; t++) {
        const spike = t % 6 === 3 ? 0.5 : 0;
        clockStep(s, { cv: [floor + spike, 0, 0, 0], gate: 1 });
        if (s.nextEventId > lastId) { out.push(String(s.tick)); lastId = s.nextEventId; }
      }
      return out.join(',');
    };
    const atZero = log(0);
    expect(atZero.length).toBeGreaterThan(0);
    expect(log(0.4)).toBe(atZero);
  });
});

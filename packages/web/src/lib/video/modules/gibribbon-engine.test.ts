// packages/web/src/lib/video/modules/gibribbon-engine.test.ts
//
// The rewritten GIBRIBBON pure core, under test — AUDIO-IN edition:
//   - the ported game-feel suites (judgement, damage ladder, combo/score,
//     aim, lane, restart) — kept from the original build;
//   - the KEPT #635 zero-un-hittable PHASE SWEEP over the one-clock stepper
//     (plus its dual-clock negative control);
//   - the adaptive-extraction basics (relative prominence, resting-floor,
//     gain invariance, rank competition, rate limiting) — fed by BAND rows
//     now, but the extractor is source-agnostic by design and these legs
//     prove exactly that. The full audio corpus (incl. the #701 fixture
//     voice rendered as audio) is in gibribbon-liveness.test.ts;
//   - the VIB-RIBBON DAMAGE MODEL (owner bug 2026-08-29, "marine doesn't
//     die when hit"): an uncleared event reaching the marine degrades him a
//     VISIBLE form (painTicks holds the pain pose), degradation past the
//     floor is DEATH, streaks recover forms — rabbit→frog→insect,
//     DOOM-cast;
//   - ATTRACT semantics: honest self-play that now deliberately FUMBLES so
//     the ladder is visible, insert-coin exit, idle re-entry, honest toggle;
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
  attractBands,
  attractOnset,
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

/** Feed ONE course tick directly (the extraction/judgement fixtures — the
 *  exported course path, tick-exact). Onset defaults HIGH: most legs test
 *  extraction eligibility, and the onset is a bias, pinned separately. */
function feed(s: GibState, bands: readonly number[], onset = true): void {
  courseTick(s, bands, onset, PLAY);
}

/** Warm a play-mode run past the count-in with silence (nothing spawns). */
function warmPastCountIn(s: GibState): void {
  for (let i = 0; i <= GIB_TUNING.countInTicks; i++) feed(s, [0, 0, 0, 0]);
}

/** Prime band `idx`'s rolling window then spike it — the minimal "varying
 *  source" the adaptive extractor requires. */
function spikeBand(s: GibState, idx: number, level = 0.95): void {
  const bands = [0, 0, 0, 0];
  bands[idx] = level;
  feed(s, bands);
}

/** Run step() until `n` COURSE ticks have landed (the integration legs —
 *  the internal tempo is the ONE transport, so course ticks are earned by
 *  scheduler ticks, never injected). */
function stepCourseTicks(
  s: GibState,
  n: number,
  params: GibStepParams,
  inputsFor: () => GibStepInputs = () => IDLE_INPUTS,
): void {
  const target = s.tick + n;
  let guard = 100000;
  while (s.tick < target && guard-- > 0) step(s, inputsFor(), params);
  if (guard <= 0) throw new Error('stepCourseTicks: transport never advanced');
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
      // A full band-driven script through step(): spike, scroll, press, idle.
      stepCourseTicks(s, 3, PLAY);
      stepCourseTicks(s, 1, PLAY, () => inputs({ bands: [0, 0, 0.95, 0], onset: true, activity: true }));
      stepCourseTicks(s, 7, PLAY);
      step(s, inputs({ buttons: ['x'], activity: true }), PLAY);
      for (let i = 0; i < 40; i++) step(s, IDLE_INPUTS, PLAY);
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

describe('GIBRIBBON engine — adaptive extraction basics (F1, now over BANDS)', () => {
  it('raw silence spawns NOTHING (resting-floor guard)', () => {
    const s = newRun(1, 'play');
    for (let i = 0; i < 60; i++) feed(s, [0, 0, 0, 0]);
    expect(s.events).toHaveLength(0);
    expect(s.nextEventId).toBe(1);
  });

  it('a stuck DC band spawns NOTHING at ANY level — flat is dead, not loud', () => {
    for (const level of [0.2, 0.5, 0.99]) {
      const s = newRun(1, 'play');
      for (let i = 0; i < 60; i++) feed(s, [level, level, level, level]);
      expect(s.events, `flat DC at ${level}`).toHaveLength(0);
    }
  });

  it('a varying band spawns its mapped kind (band identity IS event identity)', () => {
    const s = newRun(1, 'play');
    warmPastCountIn(s);
    spikeBand(s, 2); // high-mid → imp
    expect(s.events).toHaveLength(1);
    expect(s.events[0]!.kind).toBe('imp');
  });

  it('GAIN INVARIANCE: scaling the whole source leaves the spawn sequence identical', () => {
    const spawnLog = (scale: number): string => {
      const s = newRun(7, 'play');
      const log: string[] = [];
      let lastId = s.nextEventId;
      for (let t = 0; t < 96; t++) {
        const bands = [
          (t % 8 === 0 ? 0.9 : 0.1) * scale,
          (t % 8 === 4 ? 0.7 : 0.15) * scale,
          (t % 5 === 2 ? 0.6 : 0.05) * scale,
          (t % 7 === 3 ? 0.5 : 0.1) * scale,
        ];
        feed(s, bands);
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

  it('RANK COMPETITION: a quiet band beside a loud one still spawns (no starvation)', () => {
    const s = newRun(3, 'play');
    const seen = new Set<GibEventKind>();
    let lastId = s.nextEventId;
    for (let t = 0; t < 128; t++) {
      const bands = [
        t % 4 === 0 ? 0.95 : 0.2, // loud, busy band
        t % 8 === 2 ? 0.12 : 0.02, // quiet band, own rhythm, 8x smaller
        0,
        0,
      ];
      feed(s, bands);
      if (s.nextEventId > lastId) {
        const ev = s.events.find((e) => e.id === s.nextEventId - 1);
        if (ev) seen.add(ev.kind);
        lastId = s.nextEventId;
      }
    }
    expect(seen.has('loop'), 'the loud band spawns').toBe(true);
    expect(seen.has('jump'), 'the QUIET band must also spawn — rank, not level').toBe(true);
  });

  it('rate-limits spawns to the difficulty-scaled minimum gap', () => {
    const s = newRun(1, 'play');
    const spawnedAt: number[] = [];
    let lastId = s.nextEventId;
    for (let t = 0; t < 64; t++) {
      feed(s, [t % 2 === 0 ? 0.9 : 0.05, 0, 0, 0]);
      if (s.nextEventId > lastId) { spawnedAt.push(s.tick); lastId = s.nextEventId; }
    }
    expect(spawnedAt.length).toBeGreaterThan(2);
    for (let i = 1; i < spawnedAt.length; i++) {
      expect(spawnedAt[i]! - spawnedAt[i - 1]!).toBeGreaterThanOrEqual(2); // gap at difficulty 0.5
    }
  });

  it('the count-in suppresses ALL spawns for the opening ticks', () => {
    const s = newRun(1, 'play');
    for (let i = 0; i < GIB_TUNING.countInTicks; i++) {
      feed(s, [i % 2 === 0 ? 0.9 : 0.0, 0, 0, 0]);
      expect(s.events, `tick ${s.tick} is inside the count-in`).toHaveLength(0);
    }
  });

  it('the onset is a BIAS, never a hard gate: an off-onset full-range peak still spawns', () => {
    const s = newRun(1, 'play');
    warmPastCountIn(s);
    feed(s, [0.95, 0, 0, 0], /*onset*/ false);
    expect(s.events.length, 'a full-range peak spawns with NO onset flag').toBe(1);
  });
});

describe('GIBRIBBON engine — the VIB-RIBBON DAMAGE MODEL (collision → visible form → death)', () => {
  it('an uncleared event reaching the marine is a HIT ON HIM: degrade + PAIN HOLD', () => {
    const s = newRun(1, 'play');
    warmPastCountIn(s);
    spikeBand(s, 0);
    expect(s.events).toHaveLength(1);
    for (let i = 0; i < 10; i++) feed(s, [0, 0, 0, 0]);
    const ev = s.events.find((e) => e.outcome === 'miss');
    expect(ev).toBeTruthy();
    expect(s.health).toBe('wounded');
    expect(s.misses).toBe(1);
    // The VISIBLE half the owner's bug report was about: the pain form holds
    // on screen for ~1 s of scheduler ticks, not one blink.
    expect(s.painTicks).toBeGreaterThanOrEqual(30);
    const out = drainOutEvents(s);
    expect(out.some((e) => e.type === 'miss')).toBe(true);
    expect(out.some((e) => e.type === 'degrade')).toBe(true);
  });

  it('repeated hits walk the ladder DOWN TO DEATH (rabbit → frog → insect → gone)', () => {
    const s = newRun(1, 'play');
    warmPastCountIn(s);
    const rungs: string[] = [s.health];
    for (let m = 0; m < 3; m++) {
      spikeBand(s, 0);
      for (let i = 0; i < 10; i++) feed(s, [0, 0, 0, 0]);
      rungs.push(s.health);
    }
    expect(rungs).toEqual(['healthy', 'wounded', 'critical', 'dead']);
    expect(isGameOver(s)).toBe(true);
    const out = drainOutEvents(s);
    expect(out.filter((e) => e.type === 'gameover')).toHaveLength(1);
    // Dead ⇒ the course is inert.
    const tickBefore = s.tick;
    feed(s, [0.9, 0, 0, 0]);
    expect(s.tick).toBe(tickBefore);
    expect(judgePress(s, 'a', 0)).toBeNull();
  });

  it('clean streaks RECOVER forms; a long streak reaches SUPER (gold Vibri)', () => {
    const s = newRun(1, 'play');
    s.health = 'critical';
    for (let i = 0; i < GIB_TUNING.healStreak; i++) {
      placeEvent(s, 'loop', 0.0);
      judgePress(s, 'a', 0);
    }
    expect(s.health).toBe('wounded');
    for (let i = 0; i < GIB_TUNING.healStreak; i++) {
      placeEvent(s, 'loop', 0.0);
      judgePress(s, 'a', 0);
    }
    expect(s.health).toBe('healthy');
    const s2 = newRun(1, 'play');
    for (let i = 0; i < GIB_TUNING.superStreak; i++) {
      placeEvent(s2, 'loop', 0.0);
      judgePress(s2, 'a', 0);
    }
    expect(s2.health).toBe('super');
    expect(drainOutEvents(s2).some((e) => e.type === 'super')).toBe(true);
  });

  it('healthToCv maps each rung to a distinct descending 0..1 vitality', () => {
    const values = HEALTH_LADDER.map(healthToCv);
    expect(values).toEqual([1.0, 0.75, 0.5, 0.25, 0.0]);
    for (let i = 1; i < values.length; i++) expect(values[i]!).toBeLessThan(values[i - 1]!);
  });
});

describe('GIBRIBBON engine — hit judgement (ported, phase-anchored)', () => {
  it('a correct in-window button press through step() resolves a HIT', () => {
    const s = newRun(1, 'play');
    stepCourseTicks(s, 3, PLAY);
    stepCourseTicks(s, 1, PLAY, () => inputs({ bands: [0, 0, 0.95, 0], onset: true }));
    const imp = s.events.find((e) => e.kind === 'imp');
    expect(imp, 'the spike must spawn an imp through step()').toBeTruthy();
    // Scroll until the imp is judgeable, then press on that very tick.
    let guard = 20000;
    while (guard-- > 0) {
      const phase = judgePhase(s, PLAY);
      const live = s.events.find((e) => e.id === imp!.id)!;
      if (Math.abs(effectivePos(live, phase)) <= GIB_TUNING.hitWindow) break;
      step(s, IDLE_INPUTS, PLAY);
    }
    step(s, inputs({ buttons: ['x'], activity: true }), PLAY);
    expect(s.events.find((e) => e.id === imp!.id)?.outcome).toBe('hit');
    expect(s.score).toBeGreaterThan(0);
    expect(s.hits).toBe(1);
    expect(s.presses).toBe(1);
  });

  it('the WRONG button does not clear an event', () => {
    const s = newRun(1, 'play');
    placeEvent(s, 'imp', 0.0);
    expect(judgePress(s, 'a', 0)).toBeNull();
    expect(s.events[0]!.resolved).toBe(false);
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

  it('combo multiplies score and caps at maxComboMult; a collision resets it', () => {
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
    courseTick(s, [0, 0, 0, 0], false, PLAY);
    expect(s.combo).toBe(0);
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
    placeEvent(s, 'loop', 0.2);
    expect(judgePress(s, 'a', 0)).toBeNull();
    setAim(s, 1, 0);
    expect(judgePress(s, 'a', 0)).not.toBeNull();
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

describe('GIBRIBBON engine — ATTRACT mode (F3: honest self-play with a VISIBLE ladder)', () => {
  it('a bare idle module self-plays: spawns, clears, scores — and SAYS attract', () => {
    const s = newRun(0xa77, 'attract');
    for (let i = 0; i < 2400; i++) step(s, IDLE_INPUTS, DEFAULT_STEP_PARAMS);
    expect(s.mode).toBe('attract');
    expect(s.nextEventId).toBeGreaterThan(4);
    expect(s.score, 'the attract bot clears through the REAL judge').toBeGreaterThan(0);
    expect(s.health).not.toBe('dead');
  });

  it('⚠ the bot FUMBLES on purpose: the damage ladder is VISIBLE in attract', () => {
    // The owner's "marine doesn't die when hit" was partly THIS: the first
    // build's perfect bot meant attract never showed a single hit landing.
    const s = newRun(0xa77, 'attract');
    let sawPain = false;
    let sawDegraded = false;
    for (let i = 0; i < 6000; i++) {
      step(s, IDLE_INPUTS, DEFAULT_STEP_PARAMS);
      if (s.painTicks > 0) sawPain = true;
      if (s.health === 'wounded' || s.health === 'critical') sawDegraded = true;
    }
    expect(s.misses, 'attract must take real hits').toBeGreaterThan(0);
    expect(sawPain, 'the pain form must show').toBe(true);
    expect(sawDegraded, 'a lower form must show').toBe(true);
    // …but never sits on the corpse: near death the bot plays clean.
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

  it('attract feeds the SAME extractor: its band pattern rotates all four bands', () => {
    const perBand = [0, 0, 0, 0];
    for (let t = 0; t < 64; t++) {
      const bands = attractBands(t);
      for (let i = 0; i < 4; i++) if (bands[i]! > 0) perBand[i] += 1;
    }
    for (let i = 0; i < 4; i++) expect(perBand[i], `band ${i}`).toBeGreaterThan(0);
    let rests = 0;
    for (let t = 0; t < 64; t++) if (!attractOnset(t)) rests += 1;
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
    expect(s.presses).toBe(0);
  });

  it('MOVING AUDIO is real input too: bands activity exits attract (music takes over)', () => {
    const s = newRun(0xa77, 'attract');
    for (let i = 0; i < 400; i++) step(s, IDLE_INPUTS, DEFAULT_STEP_PARAMS);
    expect(s.mode).toBe('attract');
    // The shell flags moving audio as activity; the engine only sees the flag.
    step(s, inputs({ bands: [0.7, 0, 0, 0], activity: true }), DEFAULT_STEP_PARAMS);
    expect(s.mode).toBe('play');
  });

  it('toggling ATTRACT OFF mid-attract stops self-play IMMEDIATELY', () => {
    const s = newRun(0xa77, 'attract');
    for (let i = 0; i < 600; i++) step(s, IDLE_INPUTS, DEFAULT_STEP_PARAMS);
    expect(s.mode).toBe('attract');
    step(s, IDLE_INPUTS, PLAY); // attract param now 0
    expect(s.mode).toBe('play');
    expect(s.score).toBe(0);
    for (let i = 0; i < 200; i++) step(s, IDLE_INPUTS, PLAY);
    expect(s.mode).toBe('play');
  });

  it('idle long enough with attract enabled ⇒ self-play RESUMES', () => {
    const s = newRun(1, 'play');
    const ticksToIdle = Math.ceil(GIB_TUNING.attractIdleMs / DEFAULT_STEP_PARAMS.tickMs) + 2;
    for (let i = 0; i < ticksToIdle; i++) step(s, IDLE_INPUTS, DEFAULT_STEP_PARAMS);
    expect(s.mode).toBe('attract');
  });

  it('attract DISABLED (autoplay=0) ⇒ the module NEVER self-plays', () => {
    const s = newRun(1, 'play');
    const ticksToIdle = Math.ceil(GIB_TUNING.attractIdleMs / PLAY.tickMs) * 2;
    for (let i = 0; i < ticksToIdle; i++) step(s, IDLE_INPUTS, PLAY);
    expect(s.mode).toBe('play');
    // The internal tempo still runs the course — but silence spawns nothing,
    // so the ribbon is honestly empty.
    expect(s.tick).toBeGreaterThan(0);
    expect(s.events).toHaveLength(0);
  });

  it('attract auto-restarts after its own game over (banner hold first)', () => {
    const s = newRun(1, 'attract');
    s.health = 'critical';
    placeEvent(s, 'loop', GIB_TUNING.missPos + 0.001);
    let sawDead = false;
    for (let i = 0; i < 2000; i++) {
      step(s, IDLE_INPUTS, DEFAULT_STEP_PARAMS);
      if (isGameOver(s)) sawDead = true;
      if (sawDead && !isGameOver(s)) break;
    }
    expect(sawDead).toBe(true);
    expect(isGameOver(s)).toBe(false);
    expect(s.mode).toBe('attract');
  });
});

describe('GIBRIBBON engine — RESTART (the gate port, one path)', () => {
  it('a restart edge mid-run hard-resets to a fresh PLAY run', () => {
    const s = newRun(1, 'play');
    warmPastCountIn(s);
    spikeBand(s, 0);
    for (let i = 0; i < 10; i++) feed(s, [0, 0, 0, 0]);
    expect(s.misses).toBeGreaterThan(0);
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
      spikeBand(s, 0);
      for (let i = 0; i < 10; i++) feed(s, [0, 0, 0, 0]);
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
   * The sweep, over the one-clock stepper. An event is UN-HITTABLE iff there
   * is NO scheduler tick at which a press would land it. The sub-beat phase
   * at spawn sweeps via the beat accumulator; TEMPO replaces the old fps
   * lever, because in the one-clock design the frame rate cannot appear in
   * the judgement at all. Swept for the centred aim AND both aim extremes.
   */
  function eventEverJudgeable(phase01: number, tempoBpm: number, aimX: number): boolean {
    const params: GibStepParams = { ...PLAY, tempoBpm };
    const s = newRun(1, 'play');
    setAim(s, aimX, 0);
    const beatMs = (() => {
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
});

describe('GIBRIBBON engine — no absolute levels (source contract)', () => {
  it('press buttons map is total and self-consistent', () => {
    const btns = new Set<GibButton>(Object.values(EVENT_BUTTON));
    expect(btns.size).toBe(4);
  });

  it('extractSpawn never reads absolute levels: raising a flat floor changes nothing', () => {
    const log = (floor: number): string => {
      const s = newRun(11, 'play');
      const out: string[] = [];
      let lastId = s.nextEventId;
      for (let t = 0; t < 64; t++) {
        const spike = t % 6 === 3 ? 0.5 : 0;
        feed(s, [floor + spike, 0, 0, 0]);
        if (s.nextEventId > lastId) { out.push(String(s.tick)); lastId = s.nextEventId; }
      }
      return out.join(',');
    };
    const atZero = log(0);
    expect(atZero.length).toBeGreaterThan(0);
    expect(log(0.4)).toBe(atZero);
  });
});

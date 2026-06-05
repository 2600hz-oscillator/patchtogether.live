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

// packages/web/src/lib/audio/cv-buddy-node-lifetime.test.ts
//
// ES-9 I/O HAS **NODE** LIFETIME, NOT **CARD** LIFETIME — pinned.
//
// ── Why this file exists ────────────────────────────────────────────────────
// The `card-unmount-kills-node-resources` class (#1531 / #1574 / #1583) is the
// most productive bug pattern this repo has found: under the faceplate shell an
// UN-MIGRATED module has no real lane card, so its card exists only while the
// dock full-view is open. Collapsing the dock unmounts it and runs every
// `onDestroy` / `$effect` cleanup — and ⚠ LRU eviction is the silent second
// trigger, because expanding one module evicts another's pane. Any resource
// whose true lifetime is the NODE therefore dies to a benign view action, on a
// module the user never touched.
//
// `cvBuddy` / `cvBuddyMini` are the highest-stakes candidates in that class:
// their handle drives a PHYSICAL Eurorack interface through the ES-9 — DC
// coupled pitch/gate/velocity jacks, plus a hardware RUN gate and DIN-sync
// CLOCK that outboard gear locks to. A teardown here is not a dropped preview;
// it is a performer's rack going silent.
//
// ⚠ THE AUDIT SAYS THE PROPERTY ALREADY HOLDS, AND THAT IS EXACTLY WHY THIS
// FILE IS WRITTEN THIS WAY. The engine has no view-driven teardown path at all,
// so a suite that merely exercised the happy path would be green for a reason
// it never checked, and would stay green if someone added one tomorrow. Every
// leg below is therefore paired with a control, and the load-bearing legs are
// the STRUCTURAL ones: they assert WHO IS ALLOWED TO DISPOSE, so a new caller
// is RED on arrival rather than discovered by a user losing hardware output.
//
// ── What this file does NOT cover, stated rather than implied ───────────────
//   * NO REAL HARDWARE. There is no ES-9 on CI and none is required: every
//     claim here is about handle lifetime, which is upstream of the device.
//     The owner's hardware verification is a separate, human leg.
//   * NO REAL AudioContext. A fake context records the calls that matter
//     (`start`/`stop`/`disconnect`/`setValueAtTime`), which is what makes a
//     teardown OBSERVABLE. It says nothing about produced voltages.
//   * NO CLOCK PULSES ARE DRIVEN. Ticking the generator needs the live patch
//     store seeded so `ownsTransport` resolves, which couples this suite to
//     rack-global state it is not about. Pulse math is already covered by
//     `cv-buddy/clock-math` and slot allocation by `cv-buddy/slot-alloc`.
//   * NO DOM. Whether a *card* unmount happens is a UI question; this file
//     asserts the card cannot REACH the engine when it does (see the source
//     guard at the bottom), which is the half that can regress silently.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCvBuddyHandle, cvBuddyDef, type CvBuddyClockState } from './modules/cv-buddy';
import { cvBuddyMiniDef } from './modules/cv-buddy-mini';
import { es9Def } from './modules/es9';
import { getSchedulerClock } from './scheduler-clock';
import type { AudioDomainNodeHandle } from './engine';
import type { ModuleNode } from '$lib/graph/types';

// ── The fake context: only what CV Buddy touches, and it RECORDS ────────────

interface FakeSource {
  __kind: 'const';
  offset: { value: number; setValueAtTime: (v: number, t: number) => void; cancelScheduledValues: (t: number) => void };
  started: number;
  stopped: number;
  disconnected: number;
  start: () => void;
  stop: () => void;
  connect: () => void;
  disconnect: () => void;
}

interface FakeGain {
  __kind: 'gain';
  gain: { value: number };
  disconnected: number;
  connect: () => void;
  disconnect: () => void;
}

function makeCtx(): { ctx: AudioContext; sources: FakeSource[]; gains: FakeGain[] } {
  const sources: FakeSource[] = [];
  const gains: FakeGain[] = [];
  const ctx = {
    currentTime: 0,
    sampleRate: 48000,
    createGain(): FakeGain {
      const g: FakeGain = {
        __kind: 'gain',
        gain: { value: 1 },
        disconnected: 0,
        connect() {},
        disconnect() { g.disconnected++; },
      };
      gains.push(g);
      return g;
    },
    createConstantSource(): FakeSource {
      const s: FakeSource = {
        __kind: 'const',
        offset: {
          value: 0,
          setValueAtTime(v: number) { s.offset.value = v; },
          cancelScheduledValues() {},
        },
        started: 0,
        stopped: 0,
        disconnected: 0,
        start() { s.started++; },
        stop() { s.stopped++; },
        connect() {},
        disconnect() { s.disconnected++; },
      };
      sources.push(s);
      return s;
    },
  } as unknown as AudioContext;
  return { ctx, sources, gains };
}

function node(id: string, params: Record<string, number> = {}): ModuleNode {
  return { id, type: 'cvBuddy', params } as unknown as ModuleNode;
}

/** Subscribe to the scheduler WITHOUT starting its real worker/interval, and
 *  hand back the tick count so "is the pump still attached" is observable. */
function stubScheduler(): { unsubscribes: number; subscribes: number; restore: () => void } {
  const clock = getSchedulerClock();
  const rec = { unsubscribes: 0, subscribes: 0, restore: () => {} };
  const spy = vi.spyOn(clock, 'subscribe').mockImplementation(() => {
    rec.subscribes++;
    return () => { rec.unsubscribes++; };
  });
  rec.restore = () => spy.mockRestore();
  return rec;
}

const live: AudioDomainNodeHandle[] = [];
async function makeHandle(
  ctx: AudioContext,
  id = 'cvBuddy-1',
  kind: 'full' | 'mini' = 'full',
  params: Record<string, number> = {},
): Promise<AudioDomainNodeHandle> {
  const h = await createCvBuddyHandle(ctx, node(id, params), kind);
  live.push(h);
  return h;
}

afterEach(() => {
  // Never leave a scheduler subscription behind — a leaked one would make the
  // NEXT file's subscription accounting wrong.
  while (live.length) {
    try { live.pop()!.dispose(); } catch { /* already disposed by a test */ }
  }
  vi.restoreAllMocks();
});

// ────────────────────────────────────────────────────────────────────────────

describe('cv buddy — the handle is materialized and BOUND (non-vacuity)', () => {
  it('exposes the ES-9-facing ports, and the passthrough is ONE node per signal', async () => {
    const sched = stubScheduler();
    const { ctx } = makeCtx();
    const h = await makeHandle(ctx);

    expect([...h.outputs.keys()].sort()).toEqual(['clock', 'gate', 'pitchCv', 'run', 'velCv']);
    expect([...h.inputs.keys()].sort()).toEqual(['gate', 'pitch', 'velocity']);

    // THE PASSTHROUGH INVARIANT: pitch in and pitchCv out are the SAME node, so
    // "the signal path survived" and "the binding survived" are one question.
    expect(h.outputs.get('pitchCv')!.node).toBe(h.inputs.get('pitch')!.node);
    expect(h.outputs.get('gate')!.node).toBe(h.inputs.get('gate')!.node);
    expect(h.outputs.get('velCv')!.node).toBe(h.inputs.get('velocity')!.node);

    // The generated sources are LIVE — started, not stopped.
    const run = h.outputs.get('run')!.node as unknown as FakeSource;
    const clk = h.outputs.get('clock')!.node as unknown as FakeSource;
    expect(run.started).toBe(1);
    expect(clk.started).toBe(1);
    expect(run.stopped).toBe(0);
    expect(clk.stopped).toBe(0);
    expect(sched.subscribes).toBe(1); // the pump is attached
    expect(sched.unsubscribes).toBe(0);
  });

  it('the MINI drops velocity and nothing else — same clock, same run', async () => {
    stubScheduler();
    const { ctx } = makeCtx();
    const h = await makeHandle(ctx, 'cvBuddyMini-1', 'mini');
    expect([...h.outputs.keys()].sort()).toEqual(['clock', 'gate', 'pitchCv', 'run']);
    expect([...h.inputs.keys()].sort()).toEqual(['gate', 'pitch']);
    expect(h.outputs.has('velCv')).toBe(false);
  });
});

describe('cv buddy — POSITIVE CONTROL: a real teardown IS visible to this probe', () => {
  // ⚠ THE SPINE OF THE FILE. Every dispose path in the engine is view-blind, so
  // every "it survived" leg below would pass identically against a probe that
  // never looked at anything. This proves the probe CAN go red — and it does it
  // by calling exactly what `AudioEngine.removeNode` calls (`handle.dispose()`,
  // engine.ts:341), not a stand-in.
  it('dispose() stops BOTH generated sources, disconnects, and detaches the pump', async () => {
    const sched = stubScheduler();
    const { ctx } = makeCtx();
    const h = await makeHandle(ctx);

    const run = h.outputs.get('run')!.node as unknown as FakeSource;
    const clk = h.outputs.get('clock')!.node as unknown as FakeSource;
    const pitch = h.outputs.get('pitchCv')!.node as unknown as FakeGain;

    h.dispose();

    expect(run.stopped, 'RUN would keep driving jack 7').toBe(1);
    expect(clk.stopped, 'CLOCK would keep driving jack 8').toBe(1);
    expect(run.disconnected).toBeGreaterThan(0);
    expect(clk.disconnected).toBeGreaterThan(0);
    expect(pitch.disconnected, 'the note passthrough would stay wired').toBeGreaterThan(0);
    expect(sched.unsubscribes, 'the clock pump would keep ticking a dead handle').toBe(1);
  });
});

describe('cv buddy — the handle SURVIVES everything that is not a teardown', () => {
  // The property the audit established, held as a permanent negative control.
  // These are the operations a card performs across mount → collapse → expand →
  // dock-open → dock-close → LRU-evict → remount. NONE of them reaches the
  // engine, so the handle must be untouched — same object, same bindings.
  it('param writes (the ONLY thing the card sends the engine) never re-bind a port', async () => {
    const sched = stubScheduler();
    const { ctx } = makeCtx();
    const h = await makeHandle(ctx);

    const before = {
      pitch: h.outputs.get('pitchCv')!.node,
      gate: h.outputs.get('gate')!.node,
      vel: h.outputs.get('velCv')!.node,
      run: h.outputs.get('run')!.node,
      clock: h.outputs.get('clock')!.node,
    };

    // The card's entire write surface: setNodeParam('ppqn'|'clockOffsetMs').
    for (const cycle of [0, 1, 2, 3, 4, 5, 6]) {
      h.setParam!('ppqn', [1, 2, 4, 8, 12, 24, 48][cycle]!);
      h.setParam!('clockOffsetMs', cycle - 3);
    }

    expect(h.outputs.get('pitchCv')!.node).toBe(before.pitch);
    expect(h.outputs.get('gate')!.node).toBe(before.gate);
    expect(h.outputs.get('velCv')!.node).toBe(before.vel);
    expect(h.outputs.get('run')!.node).toBe(before.run);
    expect(h.outputs.get('clock')!.node).toBe(before.clock);

    // Still live, still pumped — the inverse of the positive control above.
    expect((before.run as unknown as FakeSource).stopped).toBe(0);
    expect((before.clock as unknown as FakeSource).stopped).toBe(0);
    expect(sched.unsubscribes).toBe(0);
    // And the writes actually landed, or the leg proved nothing.
    expect(h.readParam!('ppqn')).toBe(48);
    expect(h.readParam!('clockOffsetMs')).toBe(3);
  });

  it('the skips counter is MONOTONIC — a reset is the tell that a node restarted', async () => {
    // `CvBuddyClockState.skips` is documented as never reset while the node
    // lives, so it doubles as a lifetime witness: if a collapse silently
    // re-materialized the handle, this would fall back to 0 and the card's
    // cumulative total would lie.
    stubScheduler();
    const { ctx } = makeCtx();
    const h = await makeHandle(ctx);

    const first = (h.read!('state') as CvBuddyClockState).skips;
    expect(first).toBe(0);
    for (let i = 0; i < 5; i++) h.setParam!('ppqn', 24);
    const later = h.read!('state') as CvBuddyClockState;
    expect(later.skips).toBe(first); // no churn, no reset
    expect(typeof later.ownsClock).toBe('boolean');
  });
});

describe('cv buddy — the EVICTION path cannot fire on these modules', () => {
  // The engine has exactly one CONDITIONAL dispose path: the `maxInstances`
  // singleton eviction (engine.ts:275-283), which lex-tiebreaks and disposes an
  // EXISTING handle when a duplicate spawns. It is gated entirely on the def
  // declaring `maxInstances`.
  it('neither cvBuddy nor cvBuddyMini declares maxInstances', async () => {
    expect((cvBuddyDef as { maxInstances?: number }).maxInstances).toBeUndefined();
    expect((cvBuddyMiniDef as { maxInstances?: number }).maxInstances).toBeUndefined();
  });

  it('POSITIVE CONTROL — the same predicate DOES see es9 declaring it', () => {
    // ⚠ Without this leg, the assertion above passes just as well against a
    // typo'd property name, a renamed field, or a def that failed to import —
    // "nobody declares it" and "I am reading the wrong key" are the same green.
    // es9 is `maxInstances: 1` (es9.ts:214), which is ALSO why #2045 exists: a
    // concurrent multiplayer spawn can lex-tiebreak dispose() onto the LIVE
    // hardware bridge. That hazard is real and filed; it is simply not reachable
    // through these two defs, and this pair of legs is what says so.
    expect((es9Def as { maxInstances?: number }).maxInstances).toBe(1);
  });
});

/**
 * Strip comments so a prose mention of `dispose()` is not counted as a call
 * site — and, on the card, so a comment EXPLAINING that it must not tear down
 * does not fail the guard that checks it doesn't.
 *
 * ⚠ THIS IS NOT DEFENSIVE PROGRAMMING, IT IS A MEASURED HAZARD. The sibling
 * gatemaiden face-model guards went red on first run for exactly this: the
 * card's own comments quoted the code they documented removing, and a
 * source-level deny cannot tell code from comment. Rewording the prose until
 * the regex stops matching is the wrong fix — it leaves the instrument blind
 * and silently forbids the next author from writing down what changed.
 *
 * ⚠ `//` is stripped only when NOT preceded by `:`, so a `'https://…'` inside a
 * string survives; a naive stripper eats the rest of that line.
 */
function stripComments(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('cv buddy — STRUCTURAL: who is allowed to dispose a live handle', () => {
  const engineSrc = readFileSync(join(import.meta.dirname, 'engine.ts'), 'utf-8');

  it('INSTRUMENT — the stripper drops comments and keeps code', () => {
    expect(stripComments('a(); // dispose()\nb();')).not.toMatch(/dispose\(\)/);
    expect(stripComments('a(); /* x */ b();')).toBe('a();  b();');
    expect(stripComments("const u = 'https://x/y';")).toContain("'https://x/y'");
    // Direction 2: it does not eat the file.
    expect(stripComments(engineSrc)).toMatch(/removeNode/);
    expect(stripComments(engineSrc).length).toBeGreaterThan(engineSrc.length / 4);

    // ⚠ MEASURED, AND IT IS WHY THE STRIP IS LOAD-BEARING RATHER THAN TIDY.
    // A raw grep of engine.ts for these call sites returns FIVE; the stripped
    // scan returns FOUR. The extra one is `engine.ts:339` — a COMMENT reading
    // "…before removeNode. handle.dispose()", documenting the contract right
    // above the real call. Without the strip this file would assert 5, and the
    // day someone reworded that comment the count would move for a reason that
    // is not a code change. Asserted as a DIFFERENCE so it stays true.
    const rawHits = [...engineSrc.matchAll(/\bhandle\.dispose\(\)|\bevictHandle\.dispose\(\)/g)];
    const strippedHits = [...stripComments(engineSrc).matchAll(/\bhandle\.dispose\(\)|\bevictHandle\.dispose\(\)/g)];
    expect(
      rawHits.length - strippedHits.length,
      'engine.ts no longer documents dispose() in a comment — if that prose was ' +
        'deleted this is fine, but the strip is no longer demonstrated by this file',
    ).toBeGreaterThan(0);
  });

  it('every handle-dispose call site in the engine is one of the FOUR known, VIEW-BLIND ones', () => {
    // ⚠ THIS IS THE LEG THAT PROTECTS THE PROPERTY GOING FORWARD. The audit
    // enumerated the engine's dispose call sites and found none that reads view
    // state — no LRU, no collapse hook, nothing keyed to a mounted component.
    // (The dock LRU that unmounts CARDS is a UI mechanism with no engine path.)
    // That is a fact about today's source, so it is asserted against the source:
    // a NEW `.dispose()` on a node handle is RED here, and whoever adds one has
    // to state which lifetime it belongs to.
    const body = stripComments(engineSrc);
    const sites = [...body.matchAll(/^.*\bhandle\.dispose\(\)|^.*\bevictHandle\.dispose\(\)/gm)]
      .map((m) => m[0].trim());

    // The four: removeNode (graph lifetime), the maxInstances eviction, the
    // post-await race loser, and whole-engine teardown.
    expect(sites.length, `unexpected handle.dispose() call sites:\n${sites.join('\n')}`).toBe(4);

    // NON-VACUITY: the pattern must actually match something, or a regex typo
    // reads as "there are no dispose sites at all" — a green that means the
    // opposite of what it claims.
    expect(sites.length).toBeGreaterThan(0);
    expect(body).toMatch(/removeNode\(nodeId: string\)/);
    expect(body).toMatch(/evictHandle\.dispose\(\)/);
  });
});

describe('cv buddy — STRUCTURAL: the CARD cannot reach the engine on unmount', () => {
  const rawCardSrc = readFileSync(
    join(import.meta.dirname, '../ui/modules/CvBuddyBody.svelte'),
    'utf-8',
  );
  // Comment-stripped for the same reason the engine scan is: this guard must
  // stay honest while the file is free to EXPLAIN itself.
  const cardSrc = stripComments(rawCardSrc);

  it('MUTATION CONTROL — each deny below can actually go RED', () => {
    // ⚠ The property this file asserts ALREADY HOLDS, so every leg here passed
    // on first run. That is precisely the condition under which a green means
    // nothing, so the denies are shown firing against a card that DOES the
    // forbidden thing — the same predicates, a mutated subject.
    const mutated = stripComments(
      rawCardSrc.replace('<script lang="ts">', '<script lang="ts">\n  import { onDestroy } from "svelte";\n  onDestroy(() => { engineCtx.get()?.removeNode(node); });'),
    );
    expect(mutated).toMatch(/onDestroy/);
    expect(mutated).toMatch(/removeNode/);
    // …and the REAL card does not.
    expect(cardSrc).not.toMatch(/onDestroy/);
  });

  it('the shared body declares NO onDestroy and disposes NOTHING', () => {
    // The #1531 giveaway is a card-owned teardown ("Card destroyed mid-record:
    // abandon"). Those teardowns were CORRECT when a card unmount implied the
    // module was going away; the dock shell made collapse produce the identical
    // unmount, and the card cannot tell the two apart — so it must do neither.
    expect(cardSrc).not.toMatch(/onDestroy/);
    expect(cardSrc).not.toMatch(/\.dispose\(\)/);
    expect(cardSrc).not.toMatch(/removeNode/);
    expect(cardSrc).not.toMatch(/\.stop\(\)/);
  });

  it("the body's only $effect cleanup is its OWN 1 Hz poll interval", () => {
    // The single cleanup this component owns. It is a DISPLAY mirror of a
    // counter the engine keeps, so losing it to a collapse costs a repaint and
    // nothing else — which is exactly why it is allowed to exist here.
    expect(cardSrc).toMatch(/clearInterval\(timer\)/);
    expect(cardSrc).toMatch(/setInterval\(poll, 1000\)/);
    // NON-VACUITY: prove the file really is the shared body both cards render,
    // so this guard cannot be passing against the wrong file.
    expect(cardSrc).toMatch(/CvBuddy/);
    expect(cardSrc).toMatch(/read\(node, 'state'\)/);
  });
});

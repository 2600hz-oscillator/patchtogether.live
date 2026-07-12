// packages/web/src/lib/video/pull-eval.test.ts
//
// SINK-DRIVEN PULL EVALUATION — engine-level unit gates (no WebGL needed;
// stub canvas + spy handles, the engine.test.ts pattern).
//
// The contract under test (stack-study adoption item 1):
//   * an UNWATCHED, side-effect-free node costs ZERO render work — its draw()
//     is never invoked (the "N heavy generators unconnected → frame cost
//     unchanged" proof, using draw-invocation counts as the deterministic
//     cost proxy);
//   * a watched sink pulls its whole upstream chain (reverse reachability);
//   * side-effectful modules (audioSources / audioInputs / subscribePulse /
//     def pullExempt) stay live while unwatched;
//   * card visibility demotes watch marks; a render lease overrides both;
//   * the kill switch (`__videoPullEval = false`) restores push evaluation.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { VideoEngine, type VideoNodeHandle } from '$lib/video/engine';
import { registerVideoModule } from '$lib/video/module-registry';
import type { Edge, ModuleNode } from '$lib/graph/types';
import { computeActiveSet, isPullEvalOn } from '$lib/video/pull-eval';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface SpyRig {
  engine: VideoEngine;
  /** Advance the engine's injected watch clock (ms). */
  advance(ms: number): void;
  /** Register + add a spy node; returns its per-node draw mock. */
  addSpy(
    id: string,
    opts?: {
      audioSources?: boolean;
      audioInputs?: boolean;
      subscribePulse?: boolean;
      pullExempt?: boolean;
    },
  ): Promise<ReturnType<typeof vi.fn>>;
  addEdge(id: string, from: string, to: string): void;
}

function makeRig(): SpyRig {
  const glStub = {} as unknown as WebGL2RenderingContext;
  const canvas = {
    width: 1,
    height: 1,
    getContext: () => glStub,
  } as unknown as HTMLCanvasElement;

  let now = 0;
  const engine = new VideoEngine({ canvas, watchNow: () => now });

  const draws = new Map<string, ReturnType<typeof vi.fn>>();

  async function addSpy(
    id: string,
    opts: {
      audioSources?: boolean;
      audioInputs?: boolean;
      subscribePulse?: boolean;
      pullExempt?: boolean;
    } = {},
  ): Promise<ReturnType<typeof vi.fn>> {
    const draw = vi.fn();
    draws.set(id, draw);
    const handle: VideoNodeHandle = {
      domain: 'video',
      surface: { fbo: null, texture: null, draw, dispose: () => {} },
      setParam: () => {},
      readParam: () => undefined,
      dispose: () => {},
    };
    if (opts.audioSources) {
      handle.audioSources = new Map([['out', { node: {} as AudioNode, output: 0 }]]);
    }
    if (opts.audioInputs) {
      handle.audioInputs = new Map([['in', { node: {} as AudioNode, input: 0 }]]);
    }
    if (opts.subscribePulse) {
      handle.subscribePulse = () => () => {};
    }
    // Unique def type per node so the shared registry never collides across
    // tests (the engine.test.ts convention).
    const stubType = (`pull-spy-${id}-` + Math.random().toString(36).slice(2)) as ModuleNode['type'];
    registerVideoModule({
      type: stubType,
      domain: 'video',
      label: 'pull-spy',
      category: 'sources',
      inputs: [{ id: 'in', type: 'video' }],
      outputs: [{ id: 'out', type: 'video' }],
      params: [],
      pullExempt: opts.pullExempt,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      factory: (() => handle) as any,
    });
    await engine.addNode({
      id,
      type: stubType,
      domain: 'video',
      position: { x: 0, y: 0 },
      params: {},
    } as ModuleNode);
    return draw;
  }

  function addEdge(id: string, from: string, to: string): void {
    const edge: Edge = {
      id,
      source: { nodeId: from, portId: 'out' },
      target: { nodeId: to, portId: 'in' },
      sourceType: 'video',
      targetType: 'video',
    };
    engine.addEdge(edge);
  }

  return {
    engine,
    advance: (ms) => {
      now += ms;
    },
    addSpy,
    addEdge,
  };
}

/** Past the spawn-grace TTL — a node that nothing observes decays by here. */
const PAST_TTL_MS = 2000;

afterEach(() => {
  delete (globalThis as unknown as { __videoPullEval?: boolean }).__videoPullEval;
});

// ---------------------------------------------------------------------------
// Pure core
// ---------------------------------------------------------------------------

describe('pull-eval — computeActiveSet (pure reverse reachability)', () => {
  it('includes roots and everything upstream of them, and nothing else', () => {
    // a -> b -> c (root), d isolated, e -> f (unwatched island)
    const incoming = new Map<string, string[]>([
      ['b', ['a']],
      ['c', ['b']],
      ['f', ['e']],
    ]);
    const active = computeActiveSet(['c'], (id) => incoming.get(id) ?? []);
    expect([...active].sort()).toEqual(['a', 'b', 'c']);
  });

  it('tolerates cycles without hanging (feedback graphs)', () => {
    const incoming = new Map<string, string[]>([
      ['a', ['b']],
      ['b', ['a']],
    ]);
    const active = computeActiveSet(['a'], (id) => incoming.get(id) ?? []);
    expect([...active].sort()).toEqual(['a', 'b']);
  });

  it('multiple roots union their upstream cones', () => {
    const incoming = new Map<string, string[]>([
      ['b', ['a']],
      ['d', ['c']],
    ]);
    const active = computeActiveSet(['b', 'd'], (id) => incoming.get(id) ?? []);
    expect([...active].sort()).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('pull-eval — runtime flag', () => {
  it('defaults ON; global override kill-switches', () => {
    expect(isPullEvalOn()).toBe(true);
    (globalThis as unknown as { __videoPullEval?: boolean }).__videoPullEval = false;
    expect(isPullEvalOn()).toBe(false);
    (globalThis as unknown as { __videoPullEval?: boolean }).__videoPullEval = true;
    expect(isPullEvalOn()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Engine integration
// ---------------------------------------------------------------------------

describe('pull-eval — engine skips unwatched side-effect-free nodes', () => {
  it('a freshly added node renders during the spawn grace, then decays to zero draws', async () => {
    const rig = makeRig();
    const draw = await rig.addSpy('solo');

    // Within the spawn grace: renders (cards are still mounting).
    rig.engine.step();
    expect(draw).toHaveBeenCalledTimes(1);

    // Nothing ever observed it → after the TTL it costs nothing.
    rig.advance(PAST_TTL_MS);
    rig.engine.step();
    rig.engine.step();
    expect(draw).toHaveBeenCalledTimes(1);
    expect(rig.engine.pullStats().skipped).toContain('solo');
    expect(rig.engine.framesDrawnFor('solo')).toBe(1);

    rig.engine.dispose();
  });

  it('ZERO-COST PROOF: N unconnected generators add zero draw work while a watched chain renders 1:1', async () => {
    const rig = makeRig();
    const N = 25;
    const heavies: Array<ReturnType<typeof vi.fn>> = [];
    for (let i = 0; i < N; i++) heavies.push(await rig.addSpy(`gen${i}`));
    const src = await rig.addSpy('src');
    const sink = await rig.addSpy('sink');
    rig.addEdge('e1', 'src', 'sink');

    // Expire everyone's spawn grace, then watch ONLY the sink (an OUTPUT
    // card's blit would do this in production).
    rig.advance(PAST_TTL_MS);
    const STEPS = 10;
    for (let s = 0; s < STEPS; s++) {
      rig.engine.markWatched('sink');
      rig.engine.step();
    }

    // Watched chain: exactly one draw per engine frame (cadence intact).
    expect(sink).toHaveBeenCalledTimes(STEPS);
    expect(src).toHaveBeenCalledTimes(STEPS);
    // The N generators: ZERO draws — unwatched chains cost no render work.
    for (const h of heavies) expect(h).not.toHaveBeenCalled();

    const stats = rig.engine.pullStats();
    expect(stats.enabled).toBe(true);
    expect(stats.skipped).toHaveLength(N);
    expect(stats.evaluated.sort()).toEqual(['sink', 'src']);

    rig.engine.dispose();
  });

  it('reverse reachability pulls a multi-hop chain from one watched sink', async () => {
    const rig = makeRig();
    const a = await rig.addSpy('a');
    const b = await rig.addSpy('b');
    const c = await rig.addSpy('c');
    const island = await rig.addSpy('island');
    rig.addEdge('e1', 'a', 'b');
    rig.addEdge('e2', 'b', 'c');

    rig.advance(PAST_TTL_MS);
    rig.engine.markWatched('c');
    rig.engine.step();

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(c).toHaveBeenCalledTimes(1);
    expect(island).not.toHaveBeenCalled();

    rig.engine.dispose();
  });

  it('watch marks decay after the TTL (a torn-down preview stops the chain)', async () => {
    const rig = makeRig();
    const draw = await rig.addSpy('n');
    rig.advance(PAST_TTL_MS);

    rig.engine.markWatched('n');
    rig.engine.step();
    expect(draw).toHaveBeenCalledTimes(1);

    // No re-mark; the TTL lapses → skipped.
    rig.advance(PAST_TTL_MS);
    rig.engine.step();
    expect(draw).toHaveBeenCalledTimes(1);

    rig.engine.dispose();
  });
});

describe('pull-eval — side-effect exemptions stay live unwatched', () => {
  it('audioSources / audioInputs / subscribePulse / def pullExempt each exempt a node', async () => {
    const rig = makeRig();
    const aud = await rig.addSpy('aud', { audioSources: true });
    const rec = await rig.addSpy('rec', { audioInputs: true });
    const pulse = await rig.addSpy('pulse', { subscribePulse: true });
    const flagged = await rig.addSpy('flagged', { pullExempt: true });
    const plain = await rig.addSpy('plain');

    rig.advance(PAST_TTL_MS);
    rig.engine.step();

    expect(aud).toHaveBeenCalledTimes(1);
    expect(rec).toHaveBeenCalledTimes(1);
    expect(pulse).toHaveBeenCalledTimes(1);
    expect(flagged).toHaveBeenCalledTimes(1);
    expect(plain).not.toHaveBeenCalled();

    rig.engine.dispose();
  });

  it('an exempt node pulls its upstream inputs with it', async () => {
    const rig = makeRig();
    const feeder = await rig.addSpy('feeder');
    const game = await rig.addSpy('game', { audioSources: true });
    rig.addEdge('e1', 'feeder', 'game');

    rig.advance(PAST_TTL_MS);
    rig.engine.step();

    expect(game).toHaveBeenCalledTimes(1);
    expect(feeder).toHaveBeenCalledTimes(1);

    rig.engine.dispose();
  });
});

describe('pull-eval — visibility + leases', () => {
  it('a watched node whose card is known-offscreen is skipped; fail-open when unknown', async () => {
    const rig = makeRig();
    const draw = await rig.addSpy('n');
    rig.advance(PAST_TTL_MS);

    // Watched + visibility UNKNOWN → drawn (fail-open).
    rig.engine.markWatched('n');
    rig.engine.step();
    expect(draw).toHaveBeenCalledTimes(1);

    // Watched + known-offscreen → skipped (the offscreen preview loop keeps
    // blitting, but nobody can see it).
    rig.engine.setCardVisibility('n', false);
    rig.engine.markWatched('n');
    rig.engine.step();
    expect(draw).toHaveBeenCalledTimes(1);

    // Back into view → renders again.
    rig.engine.setCardVisibility('n', true);
    rig.engine.markWatched('n');
    rig.engine.step();
    expect(draw).toHaveBeenCalledTimes(2);

    // Cleared to unknown (card unmounted) → fail-open again.
    rig.engine.setCardVisibility('n', null);
    rig.engine.markWatched('n');
    rig.engine.step();
    expect(draw).toHaveBeenCalledTimes(3);

    rig.engine.dispose();
  });

  it('a render lease overrides visibility AND needs no watch marks; release decays', async () => {
    const rig = makeRig();
    const draw = await rig.addSpy('out');
    rig.advance(PAST_TTL_MS);
    rig.engine.setCardVisibility('out', false);

    const release = rig.engine.acquireRenderLease('out');
    rig.engine.step();
    expect(draw, 'leased node renders despite offscreen card + no watch').toHaveBeenCalledTimes(1);

    release();
    release(); // idempotent
    rig.engine.step();
    expect(draw, 'released lease stops the renders').toHaveBeenCalledTimes(1);

    rig.engine.dispose();
  });
});

describe('pull-eval — observation hooks mark watch', () => {
  it('engine.read() keeps a polled node rendering', async () => {
    const rig = makeRig();
    const draw = await rig.addSpy('n');
    rig.advance(PAST_TTL_MS);

    rig.engine.step();
    expect(draw).not.toHaveBeenCalled();

    rig.engine.read('n', 'anything'); // a card polling state IS an observer
    rig.engine.step();
    expect(draw).toHaveBeenCalledTimes(1);

    rig.engine.dispose();
  });

  it('blitOutputToDrawingBuffer marks watch before any GL work (stub-GL safe)', async () => {
    const rig = makeRig();
    const draw = await rig.addSpy('n');
    rig.advance(PAST_TTL_MS);

    // Spy surface has texture:null → the blit returns right after marking;
    // wrap anyway so a future stub-GL throw can't fail the marking assert.
    try {
      rig.engine.blitOutputToDrawingBuffer('n');
    } catch {
      /* stub GL */
    }
    rig.engine.step();
    expect(draw).toHaveBeenCalledTimes(1);

    rig.engine.dispose();
  });
});

describe('pull-eval — kill switch restores push evaluation', () => {
  it('__videoPullEval=false draws every node, watched or not', async () => {
    (globalThis as unknown as { __videoPullEval?: boolean }).__videoPullEval = false;
    const rig = makeRig();
    const a = await rig.addSpy('a');
    const b = await rig.addSpy('b');
    rig.advance(PAST_TTL_MS);

    rig.engine.step();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(rig.engine.pullStats().enabled).toBe(false);

    rig.engine.dispose();
  });
});

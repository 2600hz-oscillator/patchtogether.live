// packages/web/src/lib/audio/audio-out-failover.test.ts
//
// THE TERMINAL SINK'S RUNTIME LATCH RECOVERY — the single highest-value line in
// the audio-health PR, and the one that must not be taken on trust.
//
// ── What is being defended ──────────────────────────────────────────────────
// `audioOutDef.factory`'s `try/catch` covers `audioWorklet.addModule` and node
// CONSTRUCTION. A throw inside the master limiter's `process()` happens on the
// render thread AFTER construction succeeded, so the catch is structurally
// unable to see it — and per spec the node then outputs silence for the rest of
// its lifetime. Because it is the TERMINAL node, that is the whole rack, gone,
// permanently, with `ctx.state` still `'running'` (so no resume overlay) and
// nothing in the console.
//
// The hard-clip fallback already existed. It was simply unreachable from that
// failure. `failoverTerminalTailToClip` makes it reachable.
//
// ── Both directions ─────────────────────────────────────────────────────────
//   (a) FORCED — run the failover and assert the graph is REWIRED: the dead
//       node is disconnected from the merger and from everything downstream,
//       and a fresh clipper carries merger → destination AND every tap.
//   (b) UNTOUCHED — assert the healthy graph is not rewired when nothing
//       latches. Without this leg, a failover that fired unconditionally would
//       pass (a) — and it would replace the look-ahead limiter with a hard clip
//       on every boot, which is an audible regression.
//
// The graph is a fake: `failoverTerminalTailToClip` only calls `connect` /
// `disconnect` / `createWaveShaper`, so a real AudioContext buys nothing here
// and would make the test capability-dependent for no gain.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { failoverTerminalTailToClip } from './audio-out-failover';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { MASTER_CEILING } from '../../../../dsp/src/lib/master-limiter-dsp';

interface Conn {
  to: FakeNode;
}

class FakeNode {
  readonly label: string;
  readonly out: Conn[] = [];
  /** Nodes this one has been disconnected FROM (targeted disconnects). */
  readonly disconnectedFrom: FakeNode[] = [];
  disconnectedAll = 0;

  constructor(label: string) {
    this.label = label;
  }

  connect(to: FakeNode): FakeNode {
    this.out.push({ to });
    return to;
  }

  disconnect(to?: FakeNode): void {
    if (to) {
      this.disconnectedFrom.push(to);
      for (let i = this.out.length - 1; i >= 0; i--) {
        if (this.out[i]!.to === to) this.out.splice(i, 1);
      }
    } else {
      this.disconnectedAll++;
      this.out.length = 0;
    }
  }

  targets(): string[] {
    return this.out.map((c) => c.to.label);
  }
}

class FakeWaveShaper extends FakeNode {
  curve: Float32Array | null = null;
  oversample: string = 'none';
}

/** The fake graph only implements `connect`/`disconnect`, which is all the
 *  function under test touches. Cast at the boundary rather than stubbing 9
 *  unused AudioNode members. */
const asNode = (n: FakeNode): AudioNode => n as unknown as AudioNode;

function makeGraph() {
  const shapers: FakeWaveShaper[] = [];
  const ctx = {
    createWaveShaper() {
      const w = new FakeWaveShaper(`clip${shapers.length}`);
      shapers.push(w);
      return w;
    },
  } as unknown as BaseAudioContext;

  const merger = new FakeNode('merger');
  const limiter = new FakeNode('limiter');
  const destination = new FakeNode('destination');
  const outTap = new FakeNode('outTap');
  const chanSplit = new FakeNode('chanSplit');

  // The wiring the factory builds.
  merger.connect(limiter);
  limiter.connect(destination);
  limiter.connect(outTap);
  limiter.connect(chanSplit);

  return { ctx, merger, limiter, destination, outTap, chanSplit, shapers };
}

describe('audio-out — runtime latch failover', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warnSpy.mockRestore());

  it('(b) UNTOUCHED: a healthy graph keeps the LIMITER in the terminal path', () => {
    // The negative control. If the failover ever fires without a latch, the
    // rack silently loses look-ahead limiting and gains a hard clipper — an
    // audible regression that no other test in the repo would catch.
    const g = makeGraph();
    expect(g.merger.targets()).toEqual(['limiter']);
    expect(g.limiter.targets()).toEqual(['destination', 'outTap', 'chanSplit']);
    expect(g.shapers, 'no clipper is built unless something latched').toHaveLength(0);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('(a) FORCED: the failover rewires merger → clip → destination + every tap', () => {
    const g = makeGraph();
    const clip = failoverTerminalTailToClip(g.ctx, asNode(g.limiter), asNode(g.merger), [
      asNode(g.destination),
      asNode(g.outTap),
      asNode(g.chanSplit),
    ]);

    // The dead node is out of the path in BOTH directions.
    expect(g.merger.disconnectedFrom.map((n) => n.label)).toEqual(['limiter']);
    expect(g.limiter.disconnectedAll, 'the latched node is fully disconnected').toBe(1);
    expect(g.limiter.targets(), 'a latched node must feed nothing').toEqual([]);

    // The audible path is restored, and so are BOTH analysis taps — a failover
    // that forgot the taps would leave every e2e audibility read at 0 while the
    // speakers worked, which is its own false diagnosis.
    expect(g.merger.targets()).toEqual(['clip0']);
    expect((clip as unknown as FakeNode).targets()).toEqual([
      'destination',
      'outTap',
      'chanSplit',
    ]);
  });

  it('the replacement clips at the SAME ceiling the limiter enforced', () => {
    // The ceiling is imported from the limiter core in audio-out.ts, never
    // re-typed — so this asserts the shared constant reached the curve.
    const g = makeGraph();
    failoverTerminalTailToClip(g.ctx, asNode(g.limiter), asNode(g.merger), [
      asNode(g.destination),
    ]);
    const shaper = g.shapers[0]!;
    expect(shaper.oversample).toBe('4x');
    expect(shaper.curve).toBeInstanceOf(Float32Array);
    const curve = shaper.curve!;
    expect(Math.max(...curve), 'positive ceiling').toBeCloseTo(MASTER_CEILING, 6);
    expect(Math.min(...curve), 'negative ceiling').toBeCloseTo(-MASTER_CEILING, 6);
    // Below the ceiling it is the identity — the fallback must not colour a
    // normally-levelled mix.
    const mid = curve[(curve.length - 1) / 2]!;
    expect(mid, 'identity at 0').toBeCloseTo(0, 9);
  });

  it('it is LOUD — a silent failover is indistinguishable from the bug', () => {
    const g = makeGraph();
    failoverTerminalTailToClip(g.ctx, asNode(g.limiter), asNode(g.merger), [
      asNode(g.destination),
    ]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const line = String(warnSpy.mock.calls[0]![0]);
    expect(line).toContain('audio-out');
    expect(line).toMatch(/LATCHED/);
    expect(line, 'it must say what the user lost and what to do').toMatch(/hard clip/i);
  });

  it('an already-disconnected dead node does not abort the rewire', () => {
    // dispose() may have raced the latch. The rewire must still complete —
    // throwing here would leave the rack silent, which is the bug we are fixing.
    const g = makeGraph();
    g.limiter.disconnect();
    const hostile = {
      disconnect() {
        throw new Error('InvalidAccessError');
      },
    } as unknown as AudioNode;
    expect(() =>
      failoverTerminalTailToClip(g.ctx, hostile, asNode(g.merger), [asNode(g.destination)]),
    ).not.toThrow();
    expect(g.merger.targets()).toContain('clip0');
  });

  it('the factory arms the failover exactly once, and only when the worklet built', () => {
    // Source-level, because `audio-out.ts` imports the compiled worklet as
    // `?url` and cannot be loaded outside Vite. The guard is on the `limiter`
    // binding, which is non-null only on the success path — so the load-time
    // clip fallback never double-registers a recovery on itself.
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, 'modules/audio-out.ts'), 'utf8');
    expect(src).toMatch(/if \(limiter\) \{/);
    expect(src, 'a latched processor can fire more than once').toContain('if (failedOver) return;');
    expect(src).toContain('onWorkletNodeError(limiter,');
    expect(
      src,
      'the failover must rewire BOTH terminal taps, or every audibility read ' +
        'goes to 0 while the speakers still work',
    ).toMatch(/failoverTerminalTailToClip\(ctx, tail, merger, \[[\s\S]{0,120}chanSplit/);
  });
});

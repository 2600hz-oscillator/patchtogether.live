// node-samsloop-registry.test.ts
//
// #1588 — a SAMSLOOP take belongs to the NODE, not to the card.
//
// The property under test is a LIFETIME, so these tests are about which events end a
// recording and which do not. Only two may: `stop()` (the user pressed STOP, or the byte
// cap fired) and `sweep()` finding the node gone from the graph. A card unmount is
// neither, and there is deliberately no third method for one to call.
//
// ── THE INSTRUMENT IS UNDER TEST TOO ─────────────────────────────────────────
//
// SAMSLOOP's shipped progress readout was `(performance.now() - recStartTimeMs) / 1000`,
// and that number is INVARIANT to the capture pump being dead: a wall clock advances
// whether or not one sample arrived. A gate built on it would have been green against the
// exact half-fix this file exists to prevent (an entry that survives the collapse with a
// detached tap). So `elapsed` is now frames/rate, `wallElapsed` is kept and named, and
// there is a PERMANENT leg below that drives the two apart in BOTH directions.
//
// Everything drives through the injected seams — no MessagePort, no AudioContext, no Yjs
// store, no timers — so this runs in vitest's node environment.

import { describe, expect, it } from 'vitest';

import {
  NodeSamsloopRegistry,
  writeSamsloopTake,
  type FinishedTake,
  type SamsloopRegistryDeps,
  type SamsloopTap,
  type StartTakeArgs,
} from './node-samsloop-registry.svelte';

/** A MessagePort test double that records subscribe/unsubscribe and can post chunks. */
function makeFakePort() {
  const listeners = new Set<(ev: MessageEvent) => void>();
  let started = false;
  return {
    get listenerCount() {
      return listeners.size;
    },
    get started() {
      return started;
    },
    addEventListener(type: string, fn: EventListener) {
      if (type === 'message') listeners.add(fn as unknown as (ev: MessageEvent) => void);
    },
    removeEventListener(type: string, fn: EventListener) {
      if (type === 'message') listeners.delete(fn as unknown as (ev: MessageEvent) => void);
    },
    start() {
      started = true;
    },
    /** What the samsloop-tap worklet does: post one L/R block. */
    postChunk(l: Float32Array, r: Float32Array) {
      for (const fn of [...listeners]) fn({ data: { type: 'chunk', l, r } } as MessageEvent);
    },
    postJunk(data: unknown) {
      for (const fn of [...listeners]) fn({ data } as MessageEvent);
    },
  };
}

interface Harness {
  registry: NodeSamsloopRegistry;
  port: ReturnType<typeof makeFakePort>;
  tap: SamsloopTap;
  enables: boolean[];
  commits: { nodeId: string; take: FinishedTake }[];
  /** Advance the injected clock, in ms. */
  advance(ms: number): void;
  /** Fire the publish ticker n times (it is what refreshes wallElapsed). */
  tick(n?: number): void;
  /** Post `frames` frames of a constant-amplitude block. */
  feed(frames: number, amp?: number): void;
  tickers: number;
}

const CAPTURE_RATE = 8_000;

function harness(overrides: Partial<SamsloopRegistryDeps> = {}): Harness {
  const port = makeFakePort();
  const enables: boolean[] = [];
  const commits: { nodeId: string; take: FinishedTake }[] = [];
  const ticks: (() => void)[] = [];
  let clock = 1_000;
  let tickersCreated = 0;

  const tap: SamsloopTap = {
    port,
    setEnabled: (e) => enables.push(e),
    sampleRate: CAPTURE_RATE,
  };

  const deps: SamsloopRegistryDeps = {
    now: () => clock,
    startTicker: (fn) => {
      tickersCreated++;
      ticks.push(fn);
      return () => {
        const i = ticks.indexOf(fn);
        if (i >= 0) ticks.splice(i, 1);
      };
    },
    commit: (nodeId, take) => {
      // Copy out of the zero-copy subarray views before the buffer is released.
      commits.push({
        nodeId,
        take: { ...take, l: Float32Array.from(take.l), r: Float32Array.from(take.r) },
      });
      return true;
    },
    ...overrides,
  };

  const h: Harness = {
    registry: new NodeSamsloopRegistry(deps),
    port,
    tap,
    enables,
    commits,
    advance: (ms) => {
      clock += ms;
    },
    tick: (n = 1) => {
      for (let i = 0; i < n; i++) for (const t of [...ticks]) t();
    },
    feed: (frames, amp = 0.5) => {
      const l = new Float32Array(frames).fill(amp);
      const r = new Float32Array(frames).fill(amp);
      port.postChunk(l, r);
    },
    get tickers() {
      return tickersCreated;
    },
  };
  return h;
}

function startArgs(h: Harness, over: Partial<StartTakeArgs> = {}): StartTakeArgs {
  return {
    tap: h.tap,
    captureFrames: 4_000, // 0.5 s at CAPTURE_RATE
    barWidth: 10,
    barSeconds: 0.5,
    rate: 48_000,
    bits: 16,
    channels: 1,
    ...over,
  };
}

describe('a SAMSLOOP take outlives the card that started it', () => {
  it('the card has NO way to end a take — the absence IS the guard', () => {
    // THE STRUCTURAL ASSERTION. #1588 happened because a card's unmount `$effect` could
    // reach `attachedTap.setEnabled(false)` and drop the buffer. The fix is not "cards
    // should not do that", it is that there is nothing to call: no dispose/release/
    // detach/abandon on the registry. `tsc` refuses the old teardown before any test
    // runs, and this fails loudly if a plausible-looking escape hatch reappears.
    const { registry } = harness();
    const surface = new Set<string>();
    for (
      let o: object | null = registry;
      o && o !== Object.prototype;
      o = Object.getPrototypeOf(o) as object | null
    ) {
      for (const k of Object.getOwnPropertyNames(o)) surface.add(k);
    }
    for (const forbidden of ['dispose', 'release', 'detach', 'abandon', 'destroy', 'teardown', 'unmount']) {
      expect(
        surface.has(forbidden),
        `NodeSamsloopRegistry.${forbidden}() would let a card unmount destroy a take again (#1588)`,
      ).toBe(false);
    }
    // POSITIVE CONTROL for this probe: it can see methods that DO exist, so the run
    // above is not vacuously passing on an empty surface.
    expect(surface.has('stop'), 'the probe can see real methods').toBe(true);
    expect(surface.has('sweep')).toBe(true);
    expect(surface.has('start')).toBe(true);
  });

  it('a collapse-shaped event does not exist: chunks keep accumulating with no card involved', () => {
    const h = harness();
    h.registry.start('n1', startArgs(h));
    expect(h.registry.isRecording('n1')).toBe(true);

    h.feed(100);
    const atCollapse = h.registry.progress('n1')!.frames;
    expect(atCollapse).toBe(100);

    // Simulate the card going away the only way the system can express it now: the card
    // simply stops calling. Nothing is notified; the tap is still subscribed and enabled.
    h.feed(300);
    h.feed(300);
    const p = h.registry.progress('n1')!;
    expect(p.frames, 'frames kept arriving with no card involved').toBe(700);
    expect(h.registry.isRecording('n1'), 'still recording').toBe(true);
    expect(h.commits, 'nothing finalized it').toEqual([]);
    expect(h.enables, 'the tap was never disabled').toEqual([true]);
  });

  it('the tap is enabled at start and its port is STARTED (addEventListener does not auto-start)', () => {
    const h = harness();
    h.registry.start('n1', startArgs(h));
    expect(h.enables).toEqual([true]);
    expect(h.port.started, 'a MessagePort only delivers after start() when using addEventListener').toBe(true);
    expect(h.port.listenerCount).toBe(1);
  });

  it('non-chunk port traffic is ignored rather than crashing the pump', () => {
    const h = harness();
    h.registry.start('n1', startArgs(h));
    expect(() => {
      h.port.postJunk(null);
      h.port.postJunk({ type: 'enabled', enabled: true });
      h.port.postJunk({ type: 'chunk' }); // no l/r
    }).not.toThrow();
    h.feed(64);
    expect(h.registry.progress('n1')!.frames).toBe(64);
  });
});

describe('the PROGRESS instrument can read "dead" — negative-controlled BOTH ways', () => {
  // ⚠ THIS IS THE INSTRUMENT TEST, AND IT IS PERMANENT. The e2e's causal claim is
  // "the take kept GROWING while the card was collapsed", and it reads `elapsed`.
  // If `elapsed` were the wall clock (as the card's readout used to be) that claim
  // would be true of a completely dead capture. These two legs prove the number
  // MOVES when capture happens and STAYS PUT when it does not.

  it('a silent tap advances wallElapsed but NOT elapsed/frames', () => {
    const h = harness();
    h.registry.start('n1', startArgs(h));
    h.advance(2_000);
    h.tick();
    const p = h.registry.progress('n1')!;
    expect(p.wallElapsed, 'the wall clock ran for 2 s').toBeCloseTo(2, 6);
    expect(p.frames, 'but nothing was captured').toBe(0);
    expect(
      p.elapsed,
      'elapsed is frames/rate, so it must read 0 for a take that captured nothing — ' +
        'a wall-clock elapsed would have read 2.000 here and made the e2e vacuous',
    ).toBe(0);
  });

  it('...and a tap that posts moves elapsed by exactly frames/rate', () => {
    const h = harness();
    h.registry.start('n1', startArgs(h));
    h.feed(2_000); // 0.25 s at CAPTURE_RATE
    h.advance(2_000);
    h.tick();
    const p = h.registry.progress('n1')!;
    expect(p.frames).toBe(2_000);
    expect(p.elapsed, `2000 frames / ${CAPTURE_RATE} Hz = 0.25 s (units: SECONDS of TAKE)`).toBeCloseTo(0.25, 6);
    expect(p.wallElapsed, 'and the wall clock disagrees, which is the whole point').toBeCloseTo(2, 6);
  });
});

describe('stop() is user intent and it COMMITS', () => {
  it('encodes and writes the take, then reports it as stopped', () => {
    const h = harness();
    h.registry.start('n1', startArgs(h));
    h.feed(1_000, 0.25);
    const ok = h.registry.stop('n1', 'user');
    expect(ok).toBe(true);
    expect(h.commits).toHaveLength(1);
    expect(h.commits[0]!.nodeId).toBe('n1');
    expect(h.commits[0]!.take.l).toHaveLength(1_000);
    expect(h.commits[0]!.take.l[0]).toBeCloseTo(0.25, 6);
    expect(
      h.commits[0]!.take.captureRate,
      'the take is tagged with the TAP rate, never the RATE switch',
    ).toBe(CAPTURE_RATE);
    expect(h.registry.isRecording('n1')).toBe(false);
    expect(h.registry.view('n1')!.stopReason).toBe('user');
    expect(h.registry.view('n1')!.committed).toBe(true);
  });

  it('the tap is released exactly at stop — not before, not never', () => {
    const h = harness();
    h.registry.start('n1', startArgs(h));
    h.feed(50);
    expect(h.enables, 'held enabled for the take').toEqual([true]);
    expect(h.port.listenerCount).toBe(1);
    h.registry.stop('n1', 'user');
    expect(h.enables).toEqual([true, false]);
    expect(h.port.listenerCount, 'the pump is detached at stop').toBe(0);
  });

  it('a stopped take receives no further frames', () => {
    const h = harness();
    h.registry.start('n1', startArgs(h));
    h.feed(200);
    h.registry.stop('n1', 'user');
    h.feed(500);
    expect(h.registry.progress('n1')!.frames, 'the last chunk landed before the stop, nothing after').toBe(200);
    expect(h.commits, 'and nothing was committed twice').toHaveLength(1);
  });

  it('the publish ticker stops with the take — no leak past stop', () => {
    const h = harness();
    h.registry.start('n1', startArgs(h));
    h.advance(1_000);
    h.tick();
    expect(h.registry.progress('n1')!.wallElapsed).toBeCloseTo(1, 6);
    h.registry.stop('n1', 'user');
    h.advance(5_000);
    h.tick();
    expect(
      h.registry.progress('n1')!.wallElapsed,
      'a cancelled ticker cannot still be running the clock forward',
    ).toBeCloseTo(1, 6);
  });

  it('an empty take commits nothing rather than writing a zero-length sample', () => {
    const h = harness();
    h.registry.start('n1', startArgs(h));
    expect(h.registry.stop('n1', 'user')).toBe(false);
    expect(h.commits).toEqual([]);
    expect(h.registry.view('n1')!.committed).toBe(false);
  });

  it('stop is a no-op on a node that is not recording', () => {
    const h = harness();
    expect(h.registry.stop('nope', 'user')).toBe(false);
    h.registry.start('n1', startArgs(h));
    h.feed(10);
    h.registry.stop('n1', 'user');
    expect(h.registry.stop('n1', 'user'), 'a second STOP cannot commit the same take twice').toBe(false);
    expect(h.commits).toHaveLength(1);
  });
});

describe('the CAP fires wherever the card is', () => {
  it('filling the accumulator finalizes the take with nobody watching', () => {
    // #1588 acceptance: "REC, collapse, then stop while collapsed: a complete take is
    // written". The cap-stop used to live in the card's chunk handler, so a collapse both
    // killed the pump AND removed the only code that knew how to finish.
    const h = harness();
    h.registry.start('n1', startArgs(h, { captureFrames: 500 }));
    h.feed(300);
    expect(h.registry.isRecording('n1')).toBe(true);
    h.feed(300); // overruns the capacity
    expect(h.registry.isRecording('n1'), 'the cap ended it').toBe(false);
    expect(h.registry.view('n1')!.stopReason).toBe('cap');
    expect(h.commits, 'and it was COMMITTED, not dropped').toHaveLength(1);
    expect(
      h.commits[0]!.take.l,
      'the take is exactly the capacity — the head of the capture is what is kept',
    ).toHaveLength(500);
  });

  it('the cap-stop releases the tap too', () => {
    const h = harness();
    h.registry.start('n1', startArgs(h, { captureFrames: 100 }));
    h.feed(100);
    expect(h.enables).toEqual([true, false]);
    expect(h.port.listenerCount).toBe(0);
  });
});

describe('start()', () => {
  it('is idempotent while recording — a second press cannot silently replace a live take', () => {
    const h = harness();
    h.registry.start('n1', startArgs(h));
    h.feed(400);
    h.registry.start('n1', startArgs(h));
    expect(h.registry.progress('n1')!.frames, 'the accumulator was not reallocated').toBe(400);
    expect(h.commits, 'and the live take was not abandoned').toEqual([]);
    expect(h.tickers, 'no second publish ticker').toBe(1);
  });

  it('replaces a STOPPED entry — that is the ordinary "record again"', () => {
    const h = harness();
    h.registry.start('n1', startArgs(h));
    h.feed(100);
    h.registry.stop('n1', 'user');
    h.registry.start('n1', startArgs(h));
    expect(h.registry.isRecording('n1')).toBe(true);
    expect(h.registry.progress('n1')!.frames, 'a fresh accumulator').toBe(0);
    expect(h.registry.view('n1')!.stopReason).toBeNull();
  });

  it('freezes the settings for the take, so a card-side change cannot reach it', () => {
    const h = harness();
    h.registry.start('n1', startArgs(h, { rate: 22_050, bits: 8, channels: 2 }));
    h.feed(64);
    h.registry.stop('n1', 'user');
    expect(h.commits[0]!.take).toMatchObject({ rate: 22_050, bits: 8, channels: 2 });
  });
});

describe('the live peak bar is registry-owned', () => {
  it('accumulates across the whole take, so a re-expanded card sees no hole', () => {
    const h = harness();
    // barSeconds 0.5 at 8 kHz over 10 columns = 400 frames per column.
    h.registry.start('n1', startArgs(h, { barWidth: 10, barSeconds: 0.5 }));
    h.feed(400, 0.5); // column 0
    h.feed(400, 0.9); // column 1
    const peaks = h.registry.progress('n1')!.peaks;
    expect(peaks).toHaveLength(10);
    expect(peaks[0], 'column 0 holds the first block´s peak').toBeCloseTo(0.5, 5);
    expect(peaks[1]).toBeCloseTo(0.9, 5);
    expect(peaks[2], 'nothing has reached column 2 yet').toBe(0);
  });
});

describe('sweep keys teardown to GRAPH lifetime', () => {
  it('a node still in the graph keeps recording — the NEGATIVE CONTROL', () => {
    // This leg is what makes the next one meaningful: it proves sweep() is capable of NOT
    // tearing down, so "ended when deleted" is a real discrimination rather than sweep
    // ending things unconditionally.
    const h = harness();
    h.registry.start('n1', startArgs(h));
    h.registry.sweep(['n1', 'other']);
    expect(h.registry.isRecording('n1')).toBe(true);
    h.feed(120);
    expect(h.registry.progress('n1')!.frames, 'and it is still capturing').toBe(120);
    expect(h.enables).toEqual([true]);
  });

  it('a node deleted by any route ends its take and releases the tap', () => {
    const h = harness();
    h.registry.start('n1', startArgs(h));
    h.feed(120);
    h.registry.sweep(['other']);
    expect(h.registry.isRecording('n1')).toBe(false);
    expect(h.registry.nodeIds, 'the entry is gone entirely').toEqual([]);
    expect(h.enables, 'the tap is released').toEqual([true, false]);
    expect(h.port.listenerCount).toBe(0);
    expect(
      h.commits,
      'and NOT committed — the node left the graph, so there is no node.data to write into',
    ).toEqual([]);
  });

  it('sweep stops the pump AND the ticker', () => {
    const h = harness();
    h.registry.start('n1', startArgs(h));
    h.feed(50);
    h.registry.sweep([]);
    h.advance(5_000);
    h.tick();
    h.feed(500);
    expect(h.registry.progress('n1'), 'no entry, so nothing to report').toBeNull();
  });

  it('is per-node — one deletion does not disturb another take', () => {
    const h = harness();
    h.registry.start('n1', startArgs(h));
    h.registry.start('n2', startArgs(h));
    expect(h.registry.recordingNodeIds.sort()).toEqual(['n1', 'n2']);
    h.registry.sweep(['n2']);
    expect(h.registry.recordingNodeIds).toEqual(['n2']);
    h.feed(80);
    expect(h.registry.progress('n2')!.frames, 'n2 kept capturing').toBe(80);
  });

  it('sweeps STOPPED entries too, so a deleted node leaves nothing behind', () => {
    const h = harness();
    h.registry.start('n1', startArgs(h));
    h.feed(30);
    h.registry.stop('n1', 'user');
    expect(h.registry.nodeIds).toEqual(['n1']);
    h.registry.sweep([]);
    expect(h.registry.nodeIds).toEqual([]);
  });
});

describe('a hostile tap cannot take the recording down with it', () => {
  it('a throwing setEnabled at start still produces a live entry', () => {
    const h = harness();
    const tap: SamsloopTap = {
      ...h.tap,
      setEnabled: () => {
        throw new Error('worklet gone');
      },
    };
    expect(() => h.registry.start('n1', startArgs(h, { tap }))).not.toThrow();
    expect(h.registry.isRecording('n1')).toBe(true);
  });

  it('a throwing tap at STOP still commits the bytes', () => {
    // The bytes are the irreplaceable part. A port that has already been neutered must
    // not be able to prevent the take from being written.
    const h = harness();
    const port = makeFakePort();
    let armed = false;
    const tap: SamsloopTap = {
      port: {
        addEventListener: port.addEventListener.bind(port),
        removeEventListener: () => {
          if (armed) throw new Error('port detached');
        },
        start: port.start.bind(port),
      },
      setEnabled: () => {
        if (armed) throw new Error('worklet gone');
      },
      sampleRate: CAPTURE_RATE,
    };
    h.registry.start('n1', startArgs(h, { tap }));
    port.postChunk(new Float32Array(64).fill(0.3), new Float32Array(64).fill(0.3));
    armed = true;
    expect(h.registry.stop('n1', 'user')).toBe(true);
    expect(h.commits[0]!.take.l).toHaveLength(64);
  });
});

describe('writeSamsloopTake — the commit shape', () => {
  const take = (over: Partial<FinishedTake> = {}): FinishedTake => ({
    l: new Float32Array(480).fill(0.5),
    r: new Float32Array(480).fill(0.5),
    captureRate: 48_000,
    rate: 48_000,
    bits: 16,
    channels: 1,
    ...over,
  });

  it('writes the sample, its metadata and the loop window', () => {
    const target = { data: {} as Record<string, unknown>, params: {} as Record<string, number> };
    const res = writeSamsloopTake(target, take());
    expect(res).not.toBeNull();
    expect(res!.frames).toBe(480);
    expect(res!.storedRate, 'a 48 kHz capture at the 48 kHz switch decimates by 1').toBe(48_000);
    const sample = target.data.sample as { byteLength: number; rate: number; bits: number; channels: number };
    expect(sample.byteLength).toBe(480 * 2);
    expect(sample.rate).toBe(48_000);
    expect(target.data.sampleLength).toBe(480);
    expect(target.data.sampleRate).toBe(48_000);
    expect(target.params.start, 'the window opens over the whole take').toBe(0);
    expect(target.params.end).toBe(480);
  });

  it('clears the UPLOAD keys — the one-sample invariant, expressed in the data', () => {
    // A record-after-upload that left both key sets on node.data made the READER's
    // precedence, not the user's last action, decide what plays.
    const target = {
      data: { fileBytesB64: 'AAA', fileName: 'x.wav', sampleLength: 9, samples: [1, 2] } as Record<string, unknown>,
      params: {} as Record<string, number>,
    };
    writeSamsloopTake(target, take());
    expect(target.data.fileBytesB64).toBeUndefined();
    expect(target.data.fileName).toBeUndefined();
    expect(target.data.samples).toBeUndefined();
    expect(target.data.sample, 'and the recording IS there').toBeTruthy();
  });

  it('tags the bytes with the ACHIEVED rate, not the requested one', () => {
    // Integer decimation from 48 kHz cannot reach 44.1 kHz — it decimates by round(1.088)
    // = 1 and the samples stay 48 kHz. Tagging them 44 100 is what played every take
    // 148 cents flat and 8.8 % long.
    const target = { data: {} as Record<string, unknown>, params: {} as Record<string, number> };
    const res = writeSamsloopTake(target, take({ captureRate: 48_000, rate: 44_100 }));
    expect(res!.storedRate).toBe(48_000);
    expect((target.data.sample as { rate: number }).rate).toBe(48_000);
  });

  it('refuses an empty take rather than writing a zero-length sample', () => {
    const target = { data: {} as Record<string, unknown>, params: {} as Record<string, number> };
    expect(writeSamsloopTake(target, take({ l: new Float32Array(0), r: new Float32Array(0) }))).toBeNull();
    expect(target.data.sample).toBeUndefined();
  });

  it('creates node.data when the node has none', () => {
    const target: { data?: Record<string, unknown>; params: Record<string, number> } = { params: {} };
    writeSamsloopTake(target, take());
    expect(target.data?.sample).toBeTruthy();
  });
});

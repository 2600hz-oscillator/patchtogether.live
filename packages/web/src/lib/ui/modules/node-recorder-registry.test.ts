// node-recorder-registry.test.ts
//
// #1574 — the recording belongs to the NODE, not to the card.
//
// The property under test is a LIFETIME, so the tests are about which events end a
// recording and which do not. Only two may: `stop()` (the user pressed Record OFF) and
// `sweep()` finding the node gone from the graph. A card unmount is neither, and there is
// deliberately no third method for one to call.
//
// Everything drives through the injected seams — no rAF, no DOM, no GL — so this runs in
// vitest's node environment.

import { describe, expect, it, vi } from 'vitest';

import { NodeRecorderRegistry, type RegistryDeps, type StartRecordingArgs } from './node-recorder-registry.svelte';

/** A recorder test double that records what was asked of it. */
function makeFakeRecorder() {
  const calls: string[] = [];
  let frames = 0;
  let onStateChange: ((s: string) => void) | undefined;
  const rec = {
    calls,
    get frames() {
      return frames;
    },
    async start() {
      calls.push('start');
      onStateChange?.('recording');
    },
    frame() {
      frames++;
    },
    elapsed() {
      return frames / 60;
    },
    async stop() {
      calls.push('stop');
      return 'take.mp4';
    },
    async abandon() {
      calls.push('abandon');
    },
    _bind(cb: (s: string) => void) {
      onStateChange = cb;
    },
  };
  return rec;
}

interface Harness {
  registry: NodeRecorderRegistry;
  recorders: ReturnType<typeof makeFakeRecorder>[];
  /** Advance the capture pump by n frames. */
  pump(n: number): void;
  leases: { acquired: string[]; released: string[] };
  engine: StartRecordingArgs['engine'];
  canvases: { width: number; height: number; drawn: number }[];
}

function harness(): Harness {
  const recorders: ReturnType<typeof makeFakeRecorder>[] = [];
  const ticks: (() => void)[] = [];
  const leases = { acquired: [] as string[], released: [] as string[] };
  const canvases: { width: number; height: number; drawn: number }[] = [];

  const deps: RegistryDeps = {
    makeRecorder: (opts) => {
      const r = makeFakeRecorder();
      r._bind(opts.onStateChange as (s: string) => void);
      recorders.push(r);
      return r as never;
    },
    makeCanvas: (width, height) => {
      const c = { width, height, drawn: 0 };
      canvases.push(c);
      return {
        get width() {
          return c.width;
        },
        set width(v: number) {
          c.width = v;
        },
        get height() {
          return c.height;
        },
        set height(v: number) {
          c.height = v;
        },
        getContext: () => ({ drawImage: () => { c.drawn++; } }),
      } as never;
    },
    startPump: (tick) => {
      ticks.push(tick);
      return () => {
        const i = ticks.indexOf(tick);
        if (i >= 0) ticks.splice(i, 1);
      };
    },
  };

  const engine: StartRecordingArgs['engine'] = {
    canvas: { width: 1920, height: 1080 } as never,
    blitOutputToDrawingBuffer: () => {},
    acquireRenderLease: (nodeId: string) => {
      leases.acquired.push(nodeId);
      return () => leases.released.push(nodeId);
    },
  };

  return {
    registry: new NodeRecorderRegistry(deps),
    recorders,
    pump: (n) => {
      for (let i = 0; i < n; i++) for (const t of [...ticks]) t();
    },
    leases,
    engine,
    canvases,
  };
}

function startArgs(engine: StartRecordingArgs['engine']): StartRecordingArgs {
  return {
    engine,
    width: 1920,
    height: 1080,
    options: {
      nodeId: 'n1',
      audioTrack: null,
      filename: 'take',
      dirHandle: null,
      videoCodec: 'avc' as never,
      videoBitrate: 1_000,
      keyFrameInterval: 2,
      audioBitrate: 128_000,
      hardwareAcceleration: 'prefer-hardware' as never,
      width: 1920,
      height: 1080,
      saveBytes: async () => {},
    } as never,
  };
}

describe('a recording outlives the card that started it', () => {
  it('the card has NO way to end a recording — the absence IS the guard', () => {
    // THE STRUCTURAL ASSERTION. #1574 happened because a card could call
    // `recorder.abandon()` from onDestroy. The fix is not "cards should not do that", it
    // is that there is nothing to call: no dispose/release/detach/abandon on the
    // registry. `tsc` refuses the old teardown before any test runs, and this test fails
    // loudly if someone re-adds a plausible-looking escape hatch.
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
        `NodeRecorderRegistry.${forbidden}() would let a card unmount end a recording again (#1574)`,
      ).toBe(false);
    }
    // POSITIVE CONTROL for this probe: it can see methods that DO exist, so the run
    // above is not vacuously passing on an empty surface.
    expect(surface.has('stop'), 'the probe can see real methods').toBe(true);
    expect(surface.has('sweep')).toBe(true);
  });

  it('a collapse-shaped event does not exist: the recording survives everything but stop and sweep', async () => {
    const h = harness();
    await h.registry.start('n1', startArgs(h.engine));
    expect(h.registry.isRecording('n1')).toBe(true);

    // Simulate the card going away the only way the system can express it now: the card
    // simply stops calling. Nothing is notified, and the pump keeps running.
    h.pump(10);
    expect(h.recorders[0].frames, 'frames keep arriving with no card involved').toBe(10);
    expect(h.registry.isRecording('n1'), 'still recording').toBe(true);
    expect(h.recorders[0].calls, 'nothing abandoned it').not.toContain('abandon');
  });

  it('the render lease is held for the recording, not for the view', async () => {
    // Without this the engine stops drawing the collapsed node and the take records a
    // stale buffer — the projector bug (#1531) taught this the expensive way.
    const h = harness();
    await h.registry.start('n1', startArgs(h.engine));
    expect(h.leases.acquired).toEqual(['n1']);
    expect(h.leases.released, 'lease held while recording').toEqual([]);
    await h.registry.stop('n1');
    expect(h.leases.released, 'released exactly once, at stop').toEqual(['n1']);
  });

  it('the capture canvas is registry-owned and follows engine resolution', async () => {
    const h = harness();
    await h.registry.start('n1', startArgs(h.engine));
    h.pump(1);
    expect(h.canvases[0].drawn).toBe(1);
    // An engine resolution change is followed rather than frozen at the start size.
    (h.engine as { canvas: { width: number; height: number } }).canvas = { width: 1280, height: 720 } as never;
    h.pump(1);
    expect(h.canvases[0].width).toBe(1280);
    expect(h.canvases[0].height).toBe(720);
  });

  it('stop() finalizes and writes the file', async () => {
    const h = harness();
    await h.registry.start('n1', startArgs(h.engine));
    const name = await h.registry.stop('n1');
    expect(name).toBe('take.mp4');
    expect(h.recorders[0].calls).toContain('stop');
    expect(h.recorders[0].calls).not.toContain('abandon');
    expect(h.registry.isRecording('n1')).toBe(false);
  });

  it('the pump stops when the recording does — no leak past stop', async () => {
    const h = harness();
    await h.registry.start('n1', startArgs(h.engine));
    h.pump(3);
    const atStop = h.recorders[0].frames;
    await h.registry.stop('n1');
    h.pump(5);
    expect(h.recorders[0].frames, 'a stopped recording receives no further frames').toBe(atStop);
  });

  it('start is idempotent — a second press cannot silently replace a live take', async () => {
    const h = harness();
    await h.registry.start('n1', startArgs(h.engine));
    await h.registry.start('n1', startArgs(h.engine));
    expect(h.recorders.length, 'no second recorder was constructed').toBe(1);
    expect(h.recorders[0].calls.filter((c) => c === 'abandon')).toEqual([]);
  });

  it('a failed start leaves nothing behind', async () => {
    const h = harness();
    const deps: Partial<RegistryDeps> = {
      makeRecorder: () => ({ async start() { throw new Error('no encoder'); } }) as never,
      makeCanvas: () => ({ width: 0, height: 0 }) as never,
      startPump: () => () => {},
    };
    const reg = new NodeRecorderRegistry(deps);
    const ok = await reg.start('n1', startArgs(h.engine));
    expect(ok).toBe(false);
    expect(reg.isRecording('n1')).toBe(false);
    expect(h.leases.released, 'the lease taken for the attempt is given back').toEqual(['n1']);
  });
});

describe('sweep keys teardown to GRAPH lifetime', () => {
  it('a node still in the graph keeps recording — the NEGATIVE CONTROL', async () => {
    // This leg is what makes the next one meaningful: it proves sweep() is capable of
    // NOT abandoning, so "abandoned when deleted" is a real discrimination rather than
    // sweep tearing down unconditionally.
    const h = harness();
    await h.registry.start('n1', startArgs(h.engine));
    h.registry.sweep(['n1', 'other']);
    expect(h.registry.isRecording('n1')).toBe(true);
    expect(h.recorders[0].calls).not.toContain('abandon');
    h.pump(2);
    expect(h.recorders[0].frames, 'and it is still capturing').toBe(2);
  });

  it('a node deleted by any route abandons its recording, leaving the recover candidate', async () => {
    const h = harness();
    await h.registry.start('n1', startArgs(h.engine));
    h.registry.sweep(['other']);
    expect(h.registry.isRecording('n1')).toBe(false);
    expect(h.recorders[0].calls, 'abandon, not stop — the node is gone, so there is nothing to finalize into').toContain('abandon');
    expect(h.leases.released, 'the render lease is given back').toEqual(['n1']);
  });

  it('sweep stops the pump too', async () => {
    const h = harness();
    await h.registry.start('n1', startArgs(h.engine));
    h.pump(2);
    const atSweep = h.recorders[0].frames;
    h.registry.sweep([]);
    h.pump(5);
    expect(h.recorders[0].frames).toBe(atSweep);
  });

  it('sweep is per-node — one deletion does not disturb another recording', async () => {
    const h = harness();
    await h.registry.start('n1', startArgs(h.engine));
    await h.registry.start('n2', { ...startArgs(h.engine), options: { ...startArgs(h.engine).options, nodeId: 'n2' } });
    expect(h.registry.liveNodeIds.sort()).toEqual(['n1', 'n2']);
    h.registry.sweep(['n2']);
    expect(h.registry.liveNodeIds).toEqual(['n2']);
    expect(h.recorders[0].calls).toContain('abandon');
    expect(h.recorders[1].calls).not.toContain('abandon');
  });
});

describe('the pump is defensive', () => {
  it('an engine error drops a frame instead of killing the recording', async () => {
    const h = harness();
    let boom = false;
    const engine = {
      ...h.engine,
      blitOutputToDrawingBuffer: () => {
        if (boom) throw new Error('gl lost');
      },
    };
    await h.registry.start('n1', { ...startArgs(engine), engine });
    h.pump(2);
    boom = true;
    h.pump(3);
    boom = false;
    h.pump(2);
    expect(h.registry.isRecording('n1'), 'a dropped frame is recoverable; a dead pump silently truncates').toBe(true);
    expect(h.recorders[0].frames, 'the erroring ticks contributed no frames, the others did').toBe(4);
  });

  it('a missing engine canvas is skipped, not crashed on', async () => {
    const h = harness();
    const engine = { ...h.engine, canvas: null };
    await h.registry.start('n1', { ...startArgs(engine), engine });
    expect(() => h.pump(3)).not.toThrow();
    expect(h.registry.isRecording('n1')).toBe(true);
  });
});

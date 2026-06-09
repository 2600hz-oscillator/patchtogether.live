// packages/web/src/lib/video/modules/recorderbox.test.ts
//
// Unit-level checks for the RECORDERBOX module def + its factory guards.
// Vitest runs under node — no WebGL2, so we can't exercise the surface.draw
// path (covered by e2e), but we CAN verify:
//   - the def registers under the right type / domain / category;
//   - the I/O surface matches the spec (in video + audio_l/audio_r + out video);
//   - the factory degrades gracefully with no AudioContext (records video only);
//   - the factory publishes the audio-input SINKS when an AudioContext is
//     present (the cross-domain audio→video audio-input bridge consumes them);
//   - the capture chain has the SILENT keep-alive path to ctx.destination that
//     makes the AudioContext PULL the graph (the orphan-silent GUARD) + resumes
//     a suspended context + tears the keep-alive down on dispose;
//   - the ENCODABLE-RATE FIX (the ACTUAL reported "audio not recorded" bug):
//     a low-rate AudioContext (16 kHz, e.g. a Bluetooth/HFP device) would make
//     Mediabunny pick HE-AAC (mp4a.40.29) the browser can't encode → silent MP4;
//     the factory bridges the capture through a dedicated 48 kHz context so the
//     encoder sees AAC-LC. Tests pin: bridge built at 16 kHz, NOT at 48 kHz;
//   - filename + recording round-trip through node.data on a REAL syncedStore
//     (not a mock) — the Yjs "already integrated" trap regression net.

import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { syncedStore, getYjsDoc } from '@syncedstore/core';
import { getVideoModuleDef, listVideoModuleDefs } from '$lib/video/module-registry';
import { recorderboxDef } from '$lib/video/modules/recorderbox';
// Side-effect import auto-registers the video defs.
import '$lib/video/modules';
import type { ModuleNode, Edge } from '$lib/graph/types';
import type { VideoEngineContext } from '$lib/video/engine';

describe('RECORDERBOX — module def shape', () => {
  it('is registered under type "recorderbox" with domain "video"', () => {
    const def = getVideoModuleDef('recorderbox');
    expect(def).toBeDefined();
    if (!def) return;
    expect(def.domain).toBe('video');
    expect(def.label).toBe('recorderbox');
    expect(def.category).toBe('output');
    expect(def.schemaVersion).toBe(1);
  });

  it('input surface: in (video) + audio_l (audio) + audio_r (audio)', () => {
    const def = getVideoModuleDef('recorderbox')!;
    expect(def.inputs).toHaveLength(3);
    expect(def.inputs.find((p) => p.id === 'in')?.type).toBe('video');
    expect(def.inputs.find((p) => p.id === 'audio_l')?.type).toBe('audio');
    expect(def.inputs.find((p) => p.id === 'audio_r')?.type).toBe('audio');
  });

  it('output surface: a single video pass-through output', () => {
    const def = getVideoModuleDef('recorderbox')!;
    expect(def.outputs).toHaveLength(1);
    expect(def.outputs.find((p) => p.id === 'out')?.type).toBe('video');
  });

  it('declares no params (filename + record live in node.data, not params)', () => {
    const def = getVideoModuleDef('recorderbox')!;
    expect(def.params).toEqual([]);
  });

  it('appears in the global video registry list (auto-registered)', () => {
    const types = listVideoModuleDefs().map((d) => d.type);
    expect(types).toContain('recorderbox');
  });

  it('has a factory function', () => {
    expect(typeof recorderboxDef.factory).toBe('function');
  });
});

// ── Factory guards (a minimal GL + AudioContext mock; we never call draw()) ──

function makeGlMock() {
  // Just enough WebGL2 surface for compileFragment / createFbo / uniform
  // lookups the factory makes at construction time.
  const noop = () => {};
  return {
    createShader: () => ({}),
    shaderSource: noop,
    compileShader: noop,
    getShaderParameter: () => true,
    createProgram: () => ({}),
    attachShader: noop,
    linkProgram: noop,
    getProgramParameter: () => true,
    getUniformLocation: () => ({}),
    createFramebuffer: () => ({}),
    createTexture: () => ({}),
    deleteFramebuffer: noop,
    deleteTexture: noop,
    deleteProgram: noop,
  } as unknown as WebGL2RenderingContext;
}

function makeCtx(audioCtx?: AudioContext): VideoEngineContext {
  return {
    gl: makeGlMock(),
    res: { width: 1024, height: 768 },
    compileFragment: () => ({}) as WebGLProgram,
    createFbo: () => ({ fbo: {} as WebGLFramebuffer, texture: {} as WebGLTexture }),
    drawFullscreenQuad: () => {},
    audioCtx,
  };
}

const node: ModuleNode = {
  id: 'rec1', type: 'recorderbox', domain: 'video',
  position: { x: 0, y: 0 }, params: {},
};

describe('RECORDERBOX — factory degrades without an AudioContext', () => {
  it('builds a handle + records video-only (no audioInputs, no stream)', () => {
    const handle = recorderboxDef.factory(makeCtx(undefined), node);
    expect(handle.domain).toBe('video');
    expect(handle.audioInputs).toBeUndefined();
    expect(handle.read?.('audioStream')).toBeNull();
    expect(handle.read?.('hasAudio')).toBe(false);
    // Disposing without an audio graph must not throw.
    expect(() => handle.dispose()).not.toThrow();
  });
});

describe('RECORDERBOX — factory publishes audio-input sinks with an AudioContext', () => {
  // A connection-LOGGING fake AudioContext (the same shape the cross-domain
  // bridge tests use). Every node is tagged + every connect/disconnect is
  // recorded so we can assert the actual capture GRAPH, not just that nodes
  // were created. This is how we prove the orphan-silent fix WITHOUT a real
  // encoder / browser (vitest runs under node, no Web Audio): the capture chain
  // must have a real path to ctx.destination so the AudioContext pulls it.
  interface ConnRec {
    fromTag: string; toTag: string; output?: number; input?: number;
    kind: 'connect' | 'disconnect';
  }

  function makeNodeFactory(log: ConnRec[]) {
    return function makeNode(tag: string) {
      return {
        __tag: tag,
        connect(dest: unknown, output?: number, input?: number) {
          log.push({ fromTag: tag, toTag: (dest as { __tag?: string })?.__tag ?? 'unknown', output, input, kind: 'connect' });
        },
        disconnect(dest?: unknown, output?: number, input?: number) {
          log.push({ fromTag: tag, toTag: (dest as { __tag?: string } | undefined)?.__tag ?? '*', output, input, kind: 'disconnect' });
        },
      };
    };
  }

  /** sampleRate defaults to 48000 (the common case → NO resample bridge). Pass
   *  a low rate (e.g. 16000) to exercise the encodable-rate resample path. */
  function makeLoggingAudioCtx(sampleRate = 48_000) {
    const log: ConnRec[] = [];
    let gainSeq = 0;
    const makeNode = makeNodeFactory(log);
    const stream = { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
    const destination = makeNode('ctx-destination');
    // Tag the 3 gains in creation order: gainL, gainR, keepAlive.
    const gains = [makeNode('gainL'), makeNode('gainR'), { ...makeNode('keepAlive'), gain: { value: 1 } }];
    const merger = makeNode('merger');
    const streamDest = { ...makeNode('streamDest'), stream, channelCount: 0 };
    return {
      ctx: {
        state: 'running',
        sampleRate,
        destination,
        createGain: vi.fn(() => gains[gainSeq++]),
        createChannelMerger: vi.fn(() => merger),
        createMediaStreamDestination: vi.fn(() => streamDest),
        resume: vi.fn(async () => {}),
      } as unknown as AudioContext,
      log,
      stream,
      keepAliveGain: gains[2] as unknown as { gain: { value: number } },
      makeNode,
    };
  }

  it('exposes audio_l + audio_r sink nodes + a capture MediaStream', () => {
    const { ctx } = makeLoggingAudioCtx();
    const handle = recorderboxDef.factory(makeCtx(ctx), node);
    expect(handle.audioInputs).toBeDefined();
    expect(handle.audioInputs?.has('audio_l')).toBe(true);
    expect(handle.audioInputs?.has('audio_r')).toBe(true);
    // Each sink is an AudioNode with an input index.
    const l = handle.audioInputs?.get('audio_l');
    expect(l?.input).toBe(0);
    expect(l?.node).toBeDefined();
    // The card pulls the capture stream from read('audioStream').
    expect(handle.read?.('hasAudio')).toBe(true);
    expect(handle.read?.('audioStream')).toBeDefined();
    expect(() => handle.dispose()).not.toThrow();
  });

  // ── ORPHAN-SILENT REGRESSION NET ──
  // The patched-audio-is-silent bug: the capture subgraph terminated at a
  // MediaStreamAudioDestinationNode only, with NO path to ctx.destination, so
  // Chromium never pulled the graph + the captured track was silent. The fix
  // adds a SILENT keep-alive merger → gain(0) → ctx.destination. These pins
  // assert the actual graph so a future refactor can't quietly drop the pull.
  it('the capture chain has a SILENT keep-alive path to ctx.destination (so the graph is pulled → non-silent track)', () => {
    const { ctx, log, keepAliveGain } = makeLoggingAudioCtx();
    const handle = recorderboxDef.factory(makeCtx(ctx), node);

    // 1. merger feeds the keep-alive gain.
    expect(log.some((c) => c.kind === 'connect' && c.fromTag === 'merger' && c.toTag === 'keepAlive')).toBe(true);
    // 2. the keep-alive gain reaches ctx.destination (the actual pull anchor —
    //    a MediaStreamAudioDestinationNode alone does NOT pull the graph).
    expect(log.some((c) => c.kind === 'connect' && c.fromTag === 'keepAlive' && c.toTag === 'ctx-destination')).toBe(true);
    // 3. the keep-alive is SILENT (gain 0) so it adds nothing to the master bus
    //    (the documented tap-only contract — Record must not monitor through the
    //    speakers). It exists ONLY to make the AudioContext pull the chain.
    expect(keepAliveGain.gain.value).toBe(0);
    // 4. There IS a complete connected path merger → keepAlive → ctx.destination
    //    (the upstream source → gainL/gainR → merger is wired by the bridge at
    //    edge time; this proves the terminal half that makes it audible-to-encode).
    handle.dispose();
  });

  it('resumes a SUSPENDED AudioContext so the capture chain is actually pulled', () => {
    const { ctx } = makeLoggingAudioCtx();
    (ctx as unknown as { state: string }).state = 'suspended';
    const resumeSpy = (ctx as unknown as { resume: ReturnType<typeof vi.fn> }).resume;
    const handle = recorderboxDef.factory(makeCtx(ctx), node);
    expect(resumeSpy).toHaveBeenCalled();
    handle.dispose();
  });

  it('dispose tears down the keep-alive gain (no leaked path to ctx.destination)', () => {
    const { ctx, log } = makeLoggingAudioCtx();
    const handle = recorderboxDef.factory(makeCtx(ctx), node);
    handle.dispose();
    expect(log.some((c) => c.kind === 'disconnect' && c.fromTag === 'keepAlive')).toBe(true);
  });

  // ── ENCODABLE-RATE REGRESSION NET (the ACTUAL silent-MP4 root cause) ──
  // On a machine whose output device pins the AudioContext to a LOW rate (e.g.
  // a Bluetooth/HFP headset → 16 kHz), the capture track is 2ch @ 16 kHz.
  // Mediabunny then picks HE-AAC (mp4a.40.29), which Chrome's encoder rejects,
  // so addAudioTrack throws + the soundtrack is silently dropped → silent MP4.
  // The fix bridges the capture through a dedicated 48 kHz AudioContext so the
  // encoder sees AAC-LC. These pins assert the bridge IS built at a low rate and
  // is NOT built at a normal rate.

  /** Install a fake global AudioContext that records construction + exposes a
   *  48 kHz resample graph; returns a restore fn + the captured ctor calls. */
  function withFakeGlobalAudioContext(log: ConnRec[]) {
    const makeNode = makeNodeFactory(log);
    const ctorCalls: Array<{ sampleRate?: number }> = [];
    const resampleStream = { getTracks: () => [{ stop: vi.fn() }], __tag: 'resampleStream' } as unknown as MediaStream;
    const g = globalThis as unknown as { AudioContext?: unknown };
    const prev = g.AudioContext;
    g.AudioContext = class {
      state = 'running';
      destination = makeNode('resample-ctx-destination');
      constructor(opts?: { sampleRate?: number }) { ctorCalls.push(opts ?? {}); }
      createMediaStreamSource() { return makeNode('resampleSrc'); }
      createMediaStreamDestination() { return { ...makeNode('resampleDest'), channelCount: 0, stream: resampleStream }; }
      createGain() { return { ...makeNode('resampleKeepAlive'), gain: { value: 1 } }; }
      resume() { return Promise.resolve(); }
      close() { return Promise.resolve(); }
    } as unknown as typeof AudioContext;
    return { restore: () => { g.AudioContext = prev; }, ctorCalls, resampleStream };
  }

  it('LOW-rate context (16 kHz): bridges capture through a dedicated 48 kHz context so AAC-LC is encodable', () => {
    const { ctx, log } = makeLoggingAudioCtx(16_000);
    const fake = withFakeGlobalAudioContext(log);
    try {
      const handle = recorderboxDef.factory(makeCtx(ctx), node);
      // A 48 kHz resample AudioContext was constructed.
      expect(fake.ctorCalls.some((c) => c.sampleRate === 48_000)).toBe(true);
      // The capture stream handed to the recorder is the RESAMPLED (48 kHz) one,
      // not the raw 16 kHz dest stream (which would force HE-AAC → silent).
      expect(handle.read?.('audioStream')).toBe(fake.resampleStream);
      // The resample source feeds a 48 kHz dest + a keep-alive on that context.
      expect(log.some((c) => c.kind === 'connect' && c.fromTag === 'resampleSrc' && c.toTag === 'resampleDest')).toBe(true);
      expect(log.some((c) => c.kind === 'connect' && c.fromTag === 'resampleKeepAlive' && c.toTag === 'resample-ctx-destination')).toBe(true);
      handle.dispose();
    } finally {
      fake.restore();
    }
  });

  it('NORMAL-rate context (48 kHz): uses the direct dest stream (no second context)', () => {
    const { ctx, log, stream } = makeLoggingAudioCtx(48_000);
    const fake = withFakeGlobalAudioContext(log);
    try {
      const handle = recorderboxDef.factory(makeCtx(ctx), node);
      // No resample context constructed at the normal rate.
      expect(fake.ctorCalls.length).toBe(0);
      // The capture stream is the direct app-context dest stream.
      expect(handle.read?.('audioStream')).toBe(stream);
      handle.dispose();
    } finally {
      fake.restore();
    }
  });
});

// ── node.data round-trip on a REAL syncedStore (not a mock) ──

type PatchStore = { nodes: Record<string, ModuleNode>; edges: Record<string, Edge> };

describe('RECORDERBOX — filename + recording round-trip via node.data (real Y.Doc)', () => {
  it('persists filename + recording flags edited IN PLACE on the live store', () => {
    const patch = syncedStore<PatchStore>({ nodes: {}, edges: {} });
    const ydoc = getYjsDoc(patch);

    ydoc.transact(() => {
      patch.nodes.rec1 = {
        id: 'rec1', type: 'recorderbox', domain: 'video',
        position: { x: 0, y: 0 }, params: {}, data: {},
      };
    });

    // Mutate node.data IN PLACE (the Yjs-safe pattern the card uses) — never
    // reassign the data object (which would detach the live Y type).
    ydoc.transact(() => {
      const n = patch.nodes.rec1;
      if (n) {
        if (!n.data) n.data = {};
        n.data.filename = 'my-jam';
        n.data.recording = true;
      }
    });
    expect(patch.nodes.rec1?.data?.filename).toBe('my-jam');
    expect(patch.nodes.rec1?.data?.recording).toBe(true);

    // Toggle recording OFF in place — round-trips.
    ydoc.transact(() => {
      const n = patch.nodes.rec1;
      if (n?.data) n.data.recording = false;
    });
    expect(patch.nodes.rec1?.data?.recording).toBe(false);
    // Filename survives the recording toggle (independent keys).
    expect(patch.nodes.rec1?.data?.filename).toBe('my-jam');

    // Round-trip through a fresh doc applying the same update (sync survival).
    const update = Y.encodeStateAsUpdate(ydoc);
    const patch2 = syncedStore<PatchStore>({ nodes: {}, edges: {} });
    Y.applyUpdate(getYjsDoc(patch2), update);
    expect(patch2.nodes.rec1?.data?.filename).toBe('my-jam');
    expect(patch2.nodes.rec1?.data?.recording).toBe(false);
  });
});

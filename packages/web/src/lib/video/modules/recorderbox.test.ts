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
  function makeAudioCtxMock() {
    const gain = { connect: vi.fn(), disconnect: vi.fn() };
    const merger = { connect: vi.fn(), disconnect: vi.fn() };
    const stream = { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
    const dest = { stream, channelCount: 0, connect: vi.fn(), disconnect: vi.fn() };
    return {
      createGain: vi.fn(() => gain),
      createChannelMerger: vi.fn(() => merger),
      createMediaStreamDestination: vi.fn(() => dest),
      _stream: stream,
    } as unknown as AudioContext & { _stream: MediaStream };
  }

  it('exposes audio_l + audio_r sink nodes + a capture MediaStream', () => {
    const ac = makeAudioCtxMock();
    const handle = recorderboxDef.factory(makeCtx(ac), node);
    expect(handle.audioInputs).toBeDefined();
    expect(handle.audioInputs?.has('audio_l')).toBe(true);
    expect(handle.audioInputs?.has('audio_r')).toBe(true);
    // Each sink is an AudioNode with an input index.
    const l = handle.audioInputs?.get('audio_l');
    expect(l?.input).toBe(0);
    expect(l?.node).toBeDefined();
    // The card pulls the capture stream from read('audioStream').
    expect(handle.read?.('hasAudio')).toBe(true);
    expect(handle.read?.('audioStream')).toBe((ac as unknown as { _stream: MediaStream })._stream);
    expect(() => handle.dispose()).not.toThrow();
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

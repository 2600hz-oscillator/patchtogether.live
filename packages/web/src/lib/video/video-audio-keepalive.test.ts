// packages/web/src/lib/video/video-audio-keepalive.test.ts
//
// Deterministic bridge-unit (DBU) coverage for createVideoAudioKeepAlive — the
// shared silent keep-alive that makes Chromium pull a <video>-source module's
// audio so its decode doesn't throttle to ~1 fps (the "only one video plays at
// a time" bug, PR #301). Previously the ONLY proof of the actual
//   source -> gain(0) -> destination
// wiring lived in the heavy video-audio-output.spec.ts / multi-video-playback
// e2e (live MediaElementSource decode — irreducibly slow + renderer/codec
// dependent). The TOPOLOGY is pure graph plumbing, so it belongs in a fast
// fake-AudioContext unit (mirrors engine-video-audio-bridge.test.ts's recording
// fake). The live e2e keeps only the terminal "operator can hear it" energy
// assertion, which has no pure surface.

import { describe, it, expect, beforeEach } from 'vitest';
import { createVideoAudioKeepAlive } from './video-audio-keepalive';

// ---- Recording fake AudioContext (records every connect/disconnect) ----

interface ConnRec {
  from: string;
  to: string;
  kind: 'connect' | 'disconnect';
}

let connlog: ConnRec[] = [];

function fakeNode(tag: string) {
  return {
    __tag: tag,
    // gain nodes carry a .gain; harmless on source nodes.
    gain: { value: 1 },
    connect(dest: { __tag?: string }) {
      connlog.push({ from: tag, to: dest.__tag ?? 'unknown', kind: 'connect' });
    },
    disconnect() {
      connlog.push({ from: tag, to: '*', kind: 'disconnect' });
    },
  };
}

interface FakeCtx {
  state: 'running' | 'suspended';
  destination: { __tag: string };
  resumeCalls: number;
  resumeRejects: boolean;
  lastMediaEl: HTMLVideoElement | null;
  createMediaElementSource(el: HTMLVideoElement): ReturnType<typeof fakeNode>;
  createGain(): ReturnType<typeof fakeNode>;
  resume(): Promise<void>;
}

function makeCtx(opts: { state?: 'running' | 'suspended'; resumeRejects?: boolean; failSource?: boolean } = {}): FakeCtx {
  return {
    state: opts.state ?? 'running',
    destination: { __tag: 'destination' },
    resumeCalls: 0,
    resumeRejects: opts.resumeRejects ?? false,
    lastMediaEl: null,
    createMediaElementSource(el) {
      if (opts.failSource) throw new Error('element already has a source attached');
      this.lastMediaEl = el;
      return fakeNode('mediaElementSource');
    },
    createGain() {
      return fakeNode('gain');
    },
    resume() {
      this.resumeCalls++;
      return this.resumeRejects ? Promise.reject(new Error('no resume')) : Promise.resolve();
    },
  };
}

const FAKE_VIDEO_EL = { id: 'video-el' } as unknown as HTMLVideoElement;

beforeEach(() => {
  connlog = [];
});

describe('createVideoAudioKeepAlive — graph topology', () => {
  it('wires source -> gain(0) -> destination', () => {
    const ctx = makeCtx();
    createVideoAudioKeepAlive(ctx as unknown as AudioContext, FAKE_VIDEO_EL);

    // The two keep-alive connects, in order.
    const connects = connlog.filter((c) => c.kind === 'connect');
    expect(connects).toEqual([
      { from: 'mediaElementSource', to: 'gain', kind: 'connect' },
      { from: 'gain', to: 'destination', kind: 'connect' },
    ]);
  });

  it('the keep-alive gain is 0 (inaudible) — never leaks the source to the speakers at unity', () => {
    // Spy on the gain node the helper creates.
    const ctx = makeCtx();
    let createdGain: ReturnType<typeof fakeNode> | null = null;
    const origCreateGain = ctx.createGain.bind(ctx);
    ctx.createGain = () => {
      createdGain = origCreateGain();
      return createdGain;
    };
    createVideoAudioKeepAlive(ctx as unknown as AudioContext, FAKE_VIDEO_EL);
    expect(createdGain).not.toBeNull();
    expect(createdGain!.gain.value).toBe(0);
  });

  it('creates the MediaElementSource from the passed <video> element and returns it', () => {
    const ctx = makeCtx();
    const ka = createVideoAudioKeepAlive(ctx as unknown as AudioContext, FAKE_VIDEO_EL);
    expect(ctx.lastMediaEl).toBe(FAKE_VIDEO_EL);
    // The caller fans `source` into its own splitter for audio_l / audio_r.
    expect((ka.source as unknown as { __tag: string }).__tag).toBe('mediaElementSource');
  });
});

describe('createVideoAudioKeepAlive — teardown', () => {
  it('disconnect() tears down BOTH the gain and the source (no leaked nodes)', () => {
    const ctx = makeCtx();
    const ka = createVideoAudioKeepAlive(ctx as unknown as AudioContext, FAKE_VIDEO_EL);
    connlog = []; // ignore the wiring connects; watch the teardown
    ka.disconnect();
    const tornDown = connlog.filter((c) => c.kind === 'disconnect').map((c) => c.from).sort();
    expect(tornDown).toEqual(['gain', 'mediaElementSource']);
  });

  it('disconnect() is idempotent — a second call is a no-op', () => {
    const ctx = makeCtx();
    const ka = createVideoAudioKeepAlive(ctx as unknown as AudioContext, FAKE_VIDEO_EL);
    ka.disconnect();
    connlog = [];
    ka.disconnect();
    expect(connlog).toEqual([]);
  });
});

describe('createVideoAudioKeepAlive — context resume', () => {
  it('resumes a SUSPENDED context (a suspended context pulls nothing)', () => {
    const ctx = makeCtx({ state: 'suspended' });
    createVideoAudioKeepAlive(ctx as unknown as AudioContext, FAKE_VIDEO_EL);
    expect(ctx.resumeCalls).toBe(1);
  });

  it('does NOT resume an already-running context', () => {
    const ctx = makeCtx({ state: 'running' });
    createVideoAudioKeepAlive(ctx as unknown as AudioContext, FAKE_VIDEO_EL);
    expect(ctx.resumeCalls).toBe(0);
  });

  it('swallows a resume() rejection (best-effort; the audio-gate is the backstop)', () => {
    const ctx = makeCtx({ state: 'suspended', resumeRejects: true });
    // Must not throw synchronously or reject unhandled.
    expect(() => createVideoAudioKeepAlive(ctx as unknown as AudioContext, FAKE_VIDEO_EL)).not.toThrow();
    expect(ctx.resumeCalls).toBe(1);
  });
});

describe('createVideoAudioKeepAlive — construction failure', () => {
  it('propagates a createMediaElementSource failure so the caller can fall back', () => {
    // Hot-reload case: the element already has a MediaElementSource. The helper
    // must throw (the caller catches + uses silent ConstantSourceNodes).
    const ctx = makeCtx({ failSource: true });
    expect(() => createVideoAudioKeepAlive(ctx as unknown as AudioContext, FAKE_VIDEO_EL)).toThrow();
    // Nothing wired if the source could not be created.
    expect(connlog).toEqual([]);
  });
});

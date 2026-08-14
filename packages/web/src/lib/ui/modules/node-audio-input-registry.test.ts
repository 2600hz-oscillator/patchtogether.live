// node-audio-input-registry.test.ts
//
// The contract that makes AUDIO IN survive a card unmount (#1590, from the
// #1583 audit).
//
// ⚠ WHAT THESE LEGS ARE FOR. The defect was NOT "the stream stopped" — it was
// "the stream stopped BECAUSE A COMPONENT UNMOUNTED", and a card unmounts for
// reasons that have nothing to do with the user being finished: collapse, dock
// LRU eviction, ESC, M/E, navigation. So every leg below is about WHO is
// allowed to stop the tracks and WHEN — not about whether stopping works.
//
// And this row is the irreversible one: `MediaStreamTrack.stop()` cannot be
// undone (the track is permanently `ended`; only a fresh getUserMedia — a new
// permission decision — can replace it, and it fails outright if another app
// has since taken the device). A test that only checked "re-acquire works"
// would be asserting the recovery the real world does not always offer.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { nodeAudioInput } from './node-audio-input-registry.svelte';

/** A MediaStreamTrack stub that records the irreversible transition. */
function makeTrack(settings: MediaTrackSettings = { channelCount: 2, deviceId: 'dev-a' }) {
  const listeners: Record<string, Array<() => void>> = {};
  return {
    kind: 'audio',
    readyState: 'live' as 'live' | 'ended',
    stopped: 0,
    stop() {
      this.stopped += 1;
      this.readyState = 'ended';
    },
    getSettings: () => settings,
    addEventListener(ev: string, fn: () => void) {
      (listeners[ev] ??= []).push(fn);
    },
    emit(ev: string) {
      for (const fn of listeners[ev] ?? []) fn();
    },
  };
}

function makeStream(track: ReturnType<typeof makeTrack>) {
  return {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
}

/** A minimal engine + the attach spy. `audioInAttach(engine, id, null)` is the
 *  detach call — the second thing the old unmount destroyed. */
const attachCalls: Array<{ id: string; payload: unknown }> = [];
vi.mock('$lib/audio/modules/audioin', () => ({
  audioInAttach: (_engine: unknown, id: string, payload: unknown) => {
    attachCalls.push({ id, payload });
    return true;
  },
}));

const engine = { get: () => ({}) } as never;

let track: ReturnType<typeof makeTrack>;

beforeEach(() => {
  attachCalls.length = 0;
  track = makeTrack();
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia: vi.fn(async () => makeStream(track)),
    },
  });
  // Each test works on its own node id, then sweeps it away at the end of the
  // suite via the explicit sweeps below — the registry is a singleton.
});

describe('the card ADOPTS; it never creates or destroys', () => {
  it('adopt is idempotent and NON-DESTRUCTIVE — a re-mount keeps the live stream', async () => {
    nodeAudioInput.adopt('n1', engine);
    await nodeAudioInput.request('n1', { audio: true });
    expect(nodeAudioInput.isStreaming('n1')).toBe(true);

    // A second mount of the same card (collapse → expand) adopts again.
    nodeAudioInput.adopt('n1', engine);

    expect(
      nodeAudioInput.isStreaming('n1'),
      're-adopting must not reset the entry — this is what makes re-expanding show the LIVE input',
    ).toBe(true);
    expect(track.stopped, 'adopt must never stop a track').toBe(0);
    expect(track.readyState).toBe('live');
    nodeAudioInput.sweep([]);
  });

  it('the view is readable before adopt — a card can render a frame first', () => {
    expect(nodeAudioInput.view('never-adopted').state).toBe('idle');
    expect(nodeAudioInput.view('never-adopted').streaming).toBe(false);
  });
});

describe('THE DEFECT: only a USER ACTION or the GRAPH SWEEP may stop the tracks', () => {
  it('a node that is still in the graph keeps streaming across a sweep', async () => {
    nodeAudioInput.adopt('n2', engine);
    await nodeAudioInput.request('n2', { audio: true });

    // The graph still holds the node — this is every collapse, every LRU
    // eviction, every ESC. Nothing may be released.
    nodeAudioInput.sweep(['n2', 'other']);

    expect(track.stopped, 'a live node was swept away while still in the graph').toBe(0);
    expect(nodeAudioInput.isStreaming('n2')).toBe(true);
    nodeAudioInput.sweep([]);
  });

  it('the sweep DOES release a node the graph no longer has', async () => {
    nodeAudioInput.adopt('n3', engine);
    await nodeAudioInput.request('n3', { audio: true });
    expect(track.stopped).toBe(0);

    nodeAudioInput.sweep([]); // node deleted from the graph

    expect(track.stopped, 'a deleted node must release its device').toBe(1);
    expect(track.readyState).toBe('ended');
    expect(nodeAudioInput.view('n3').streaming).toBe(false);
    // …and the engine was detached, not left pointing at a dead stream.
    expect(attachCalls.at(-1)).toEqual({ id: 'n3', payload: null });
  });

  it('stop() is the USER control and does release — it is not dead code', async () => {
    nodeAudioInput.adopt('n4', engine);
    await nodeAudioInput.request('n4', { audio: true });

    nodeAudioInput.stop('n4');

    expect(track.stopped).toBe(1);
    expect(nodeAudioInput.view('n4').state).toBe('idle');
    nodeAudioInput.sweep([]);
  });
});

describe('THE STRUCTURAL GUARD — there is no card-lifecycle teardown to call', () => {
  // The regression this file exists to prevent is a future `onDestroy` that
  // reaches for a teardown method. The defence is that no such method EXISTS,
  // so `tsc` refuses the call before any test runs. This leg pins that, and is
  // deliberately a PERMANENT NEGATIVE CONTROL: it fails the moment someone adds
  // one back, which is exactly when a human should be asked why.
  const LIFECYCLE_NAMES = ['dispose', 'destroy', 'teardown', 'unmount', 'onCardUnmount', 'release'];

  it('exposes no method named for a component lifecycle event', () => {
    const surface = new Set<string>();
    let proto: object | null = Object.getPrototypeOf(nodeAudioInput);
    while (proto && proto !== Object.prototype) {
      for (const k of Object.getOwnPropertyNames(proto)) surface.add(k);
      proto = Object.getPrototypeOf(proto);
    }
    const offenders = LIFECYCLE_NAMES.filter((n) => surface.has(n));
    expect(
      offenders,
      `a lifecycle-named method is an invitation to call it from onDestroy — which IS #1590. ` +
        `The two legitimate releases are stop() (the user asked) and sweep() (the graph lost the node).`,
    ).toEqual([]);
  });

  it('…and the guard is not vacuous: it CAN see a method that is present', () => {
    const surface = new Set(Object.getOwnPropertyNames(Object.getPrototypeOf(nodeAudioInput)));
    // Positive control on the same predicate the leg above uses: `stop` and
    // `sweep` really are on the surface, so an empty offender list means "none
    // of those names", not "the reflection found nothing".
    expect(surface.has('stop')).toBe(true);
    expect(surface.has('sweep')).toBe(true);
  });
});

describe('the failure classification survives the move off the card', () => {
  it.each([
    ['NotAllowedError', 'permission-denied'],
    ['NotFoundError', 'no-inputs-found'],
    ['OverconstrainedError', 'no-inputs-found'],
    ['NotReadableError', 'device-in-use'],
    ['SomethingElse', 'error'],
  ])('%s → %s', async (name, expected) => {
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn(async () => {
          const e = new Error('nope');
          e.name = name;
          throw e;
        }),
      },
    });
    const id = `err-${name}`;
    nodeAudioInput.adopt(id, engine);
    const view = await nodeAudioInput.request(id, { audio: true });
    expect(view.state).toBe(expected);
    expect(view.streaming).toBe(false);
    nodeAudioInput.sweep([]);
  });
});

describe('end-of-stream is a REAL end, not a lifecycle event', () => {
  it("a track's 'ended' event releases the entry — the device is already gone", async () => {
    nodeAudioInput.adopt('n5', engine);
    await nodeAudioInput.request('n5', { audio: true });
    expect(nodeAudioInput.isStreaming('n5')).toBe(true);

    track.emit('ended'); // permission revoked / hardware unplugged

    expect(nodeAudioInput.view('n5').state).toBe('error');
    expect(nodeAudioInput.view('n5').streaming).toBe(false);
    nodeAudioInput.sweep([]);
  });
});

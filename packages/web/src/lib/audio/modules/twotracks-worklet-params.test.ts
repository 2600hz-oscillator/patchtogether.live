// packages/web/src/lib/audio/modules/twotracks-worklet-params.test.ts
//
// EVERY def param TWOTRACKS routes to an AudioParam must EXIST on the worklet.
//
// THE BUG THIS PINS. `TwoTracksProcessor.parameterDescriptors` declared
// `decay_b` — a name nothing in the worklet ever reads — and did NOT declare
// `echoes_b`, which `processReel` reads on every block
// (`packages/dsp/src/twotracks.ts`: `pEchoes = suffix === '' ? 'echoes' :
// 'echoes_b'`). So reel B's ECHOES knob wrote to nothing: the factory's
// `params.get('echoes_b')?.setValueAtTime(...)` optional-chained over an
// undefined AudioParam, and `kv('echoes_b', 3)` fell through to its literal
// default. Reel B was permanently stuck at 3 repeats while the knob moved
// 1..5 and the card printed the value back from the Y.Doc.
//
// WHY NOTHING CAUGHT IT. Every layer above the worklet is self-consistent —
// the def declares `echoes_b`, the card reads and writes `echoes_b`, the
// param map sends `echoes_b`, contract-lock pins `echoes_b` — and every one of
// those gates reads only the RACK side of the contract. The worklet's
// descriptor list is the other side, and the two were never compared. The
// optional chaining is what makes the failure silent rather than a TypeError.
//
// This is the general gate, not a spot check for the one name: it walks the
// whole map, so any future param added on one side only fails here.

import { describe, expect, it, beforeAll } from 'vitest';
import { twotracksDef, cardParamToWorkletParam } from './twotracks';

type Descriptor = { name: string; defaultValue: number; minValue: number; maxValue: number };

let descriptors: Descriptor[] = [];

beforeAll(async () => {
  const g = globalThis as unknown as {
    sampleRate?: number;
    AudioWorkletProcessor?: unknown;
    registerProcessor?: (n: string, c: { parameterDescriptors: Descriptor[] }) => void;
  };
  g.sampleRate = 48000;
  g.AudioWorkletProcessor = class {
    port = { onmessage: null as unknown, postMessage: (): void => {} };
  };
  let captured: { parameterDescriptors: Descriptor[] } | null = null;
  g.registerProcessor = (_n, ctor) => { captured = ctor; };
  await import('../../../../../dsp/src/twotracks');
  if (!captured) throw new Error('twotracks processor did not register');
  descriptors = (captured as { parameterDescriptors: Descriptor[] }).parameterDescriptors;
  expect(descriptors.length, 'the descriptor list must be non-empty').toBeGreaterThan(20);
});

describe('twotracks: the def↔worklet AudioParam contract', () => {
  it('every param the def routes to an AudioParam is DECLARED by the worklet', () => {
    const declared = new Set(descriptors.map((d) => d.name));
    const missing: string[] = [];
    for (const p of twotracksDef.params) {
      const target = cardParamToWorkletParam(p.id);
      if (target === null) continue; // display-only / message-driven
      if (!declared.has(target)) missing.push(`${p.id} → "${target}"`);
    }
    expect(
      missing,
      `these def params route to worklet AudioParams that DO NOT EXIST, so the ` +
        `knob is a permanent no-op (params.get() is undefined and the ` +
        `optional-chained setValueAtTime silently drops the write): ` +
        missing.join(', '),
    ).toEqual([]);
  });

  it('ECHOES B specifically: declared, and with reel A’s range', () => {
    const a = descriptors.find((d) => d.name === 'echoes')!;
    const b = descriptors.find((d) => d.name === 'echoes_b');
    expect(b, 'the worklet must declare echoes_b — processReel reads it').toBeDefined();
    // The two reels are the same machine; their ECHOES must agree, and both
    // must agree with the def. Comparing to reel A rather than to literals
    // means a future range change cannot leave the reels asymmetric.
    expect([b!.minValue, b!.maxValue, b!.defaultValue]).toEqual([a.minValue, a.maxValue, a.defaultValue]);
    const defB = twotracksDef.params.find((p) => p.id === 'echoes_b')!;
    expect([b!.minValue, b!.maxValue, b!.defaultValue]).toEqual([defB.min, defB.max, defB.defaultValue]);
  });

  it('no descriptor is declared that nothing routes to (the dead `decay_b` shape)', () => {
    // The inverse direction: a descriptor with no def param pointing at it is
    // either dead weight or — as here — a rename that lost its other half.
    // Transient host-driven params are legitimately unrouted, so they are
    // named rather than pattern-matched: an exemption you have to type.
    const HOST_DRIVEN = new Set([
      'rec_start', 'rec_arm', 'overdub_toggle',
      'rec_start_b', 'rec_arm_b', 'overdub_toggle_b',
      'lofiSeed', 'scrubVelocity_a', 'scrubVelocity_b',
    ]);
    const routed = new Set(
      twotracksDef.params.map((p) => cardParamToWorkletParam(p.id)).filter((x): x is string => x !== null),
    );
    const orphans = descriptors
      .map((d) => d.name)
      .filter((n) => !routed.has(n) && !HOST_DRIVEN.has(n));
    expect(
      orphans,
      `worklet AudioParams nothing writes to: ${orphans.join(', ')}. ` +
        `"decay_b" sat here for the module's whole life while the code read ` +
        `"echoes_b", which was never declared — the two halves of one rename.`,
    ).toEqual([]);
  });
});

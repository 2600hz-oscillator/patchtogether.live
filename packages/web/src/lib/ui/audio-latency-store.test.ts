// Audio-latency (AudioContext buffer) store unit tests.
//
// vitest runs in `node` (no DOM). The store touches only `localStorage`,
// so we polyfill that one global before importing the .svelte.ts module
// (its constructor reads localStorage). Filename is `.test.ts` (not
// `.svelte.test.ts`) so the svelte loader doesn't try to compile it as a
// runes module — it imports the runes store from `./audio-latency-store.svelte`.

import { describe, it, expect, beforeEach, vi } from 'vitest';

class StorageStub {
  private map = new Map<string, string>();
  getItem(k: string): string | null { return this.map.get(k) ?? null; }
  setItem(k: string, v: string): void { this.map.set(k, v); }
  removeItem(k: string): void { this.map.delete(k); }
  clear(): void { this.map.clear(); }
  get length(): number { return this.map.size; }
  key(i: number): string | null { return Array.from(this.map.keys())[i] ?? null; }
}
const storageStub = new StorageStub();
// Must be in place BEFORE the .svelte.ts module evaluates (its constructor
// reads localStorage).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).localStorage = storageStub;

const {
  audioLatencyStore,
  AUDIO_LATENCY_OPTIONS,
  DEFAULT_AUDIO_LATENCY_MODE,
  isAudioLatencyMode,
  getAudioLatencyOption,
  latencyHintFor,
} = await import('./audio-latency-store.svelte');

const STORAGE_KEY = 'pt.audioLatency';

beforeEach(() => {
  storageStub.clear();
  audioLatencyStore.set(DEFAULT_AUDIO_LATENCY_MODE, /*persist*/ false);
  audioLatencyStore.booted = null;
});

describe('latency mode → latencyHint mapping (the 4-step ladder)', () => {
  it('exposes exactly Low / Tight / Balanced / Stable in order', () => {
    expect(AUDIO_LATENCY_OPTIONS.map((o) => o.id)).toEqual([
      'low',
      'tight',
      'balanced',
      'stable',
    ]);
    expect(AUDIO_LATENCY_OPTIONS.map((o) => o.label)).toEqual([
      'Low',
      'Tight',
      'Balanced',
      'Stable',
    ]);
  });

  it('Low = the browser-default "interactive" category (today behavior)', () => {
    expect(latencyHintFor('low')).toBe('interactive');
  });

  it('Tight = the user-requested in-between numeric hint (~0.012 s)', () => {
    expect(latencyHintFor('tight')).toBe(0.012);
  });

  it('Balanced ≈ 0.025 s', () => {
    expect(latencyHintFor('balanced')).toBe(0.025);
  });

  it('Stable ≈ 0.045 s (heavy/video-laden patches)', () => {
    expect(latencyHintFor('stable')).toBe(0.045);
  });

  it('numeric hints increase monotonically Tight < Balanced < Stable', () => {
    const t = latencyHintFor('tight') as number;
    const b = latencyHintFor('balanced') as number;
    const s = latencyHintFor('stable') as number;
    expect(t).toBeLessThan(b);
    expect(b).toBeLessThan(s);
  });

  it('Tight sits between interactive (Low) and Balanced', () => {
    // The whole point of the in-between step: Low is the smallest buffer
    // ('interactive', not numerically comparable but conceptually lowest);
    // Tight must be strictly below Balanced.
    expect(latencyHintFor('tight') as number).toBeLessThan(latencyHintFor('balanced') as number);
  });
});

describe('default', () => {
  it('default mode is "tight" (honors low-latency preference + adds slack over Low)', () => {
    expect(DEFAULT_AUDIO_LATENCY_MODE).toBe('tight');
  });

  it('a fresh store with no stored preference starts at the default', () => {
    expect(audioLatencyStore.current).toBe('tight');
    expect(audioLatencyStore.latencyHint).toBe(0.012);
  });
});

describe('isAudioLatencyMode / getAudioLatencyOption', () => {
  it('accepts the four valid ids, rejects everything else', () => {
    for (const id of ['low', 'tight', 'balanced', 'stable']) {
      expect(isAudioLatencyMode(id)).toBe(true);
    }
    expect(isAudioLatencyMode('huge')).toBe(false);
    expect(isAudioLatencyMode('')).toBe(false);
    expect(isAudioLatencyMode(null)).toBe(false);
    expect(isAudioLatencyMode(0.025)).toBe(false);
  });

  it('getAudioLatencyOption returns the matching option', () => {
    expect(getAudioLatencyOption('stable').label).toBe('Stable');
    expect(getAudioLatencyOption('stable').latencyHint).toBe(0.045);
  });

  it('getAudioLatencyOption falls back to the default for an unknown id', () => {
    // Cast through unknown so TS lets us pass an invalid id.
    const opt = getAudioLatencyOption('bogus' as unknown as 'low');
    expect(opt.id).toBe(DEFAULT_AUDIO_LATENCY_MODE);
  });
});

describe('persistence round-trip (localStorage)', () => {
  it('set() persists the chosen mode', () => {
    audioLatencyStore.set('stable');
    expect(audioLatencyStore.current).toBe('stable');
    expect(storageStub.getItem(STORAGE_KEY)).toBe('stable');
  });

  it('set(persist=false) does not write to localStorage', () => {
    storageStub.clear();
    audioLatencyStore.set('balanced', false);
    expect(audioLatencyStore.current).toBe('balanced');
    expect(storageStub.getItem(STORAGE_KEY)).toBeNull();
  });

  it('set() falls back to the default on an unknown id', () => {
    audioLatencyStore.set('nope' as unknown as 'low');
    expect(audioLatencyStore.current).toBe(DEFAULT_AUDIO_LATENCY_MODE);
    expect(storageStub.getItem(STORAGE_KEY)).toBe(DEFAULT_AUDIO_LATENCY_MODE);
  });

  it('round-trips: a stored value is read back on a fresh construction', async () => {
    // Persist a non-default value...
    storageStub.setItem(STORAGE_KEY, 'balanced');
    // ...and simulate a reload by re-importing the module with a fresh
    // module registry so a brand-new singleton runs its constructor.
    vi.resetModules();
    const fresh = await import('./audio-latency-store.svelte');
    expect(fresh.audioLatencyStore.current).toBe('balanced');
    expect(fresh.audioLatencyStore.latencyHint).toBe(0.025);
  });

  it('a corrupt stored value is ignored → default', async () => {
    storageStub.setItem(STORAGE_KEY, 'garbage');
    vi.resetModules();
    const fresh = await import('./audio-latency-store.svelte');
    expect(fresh.audioLatencyStore.current).toBe(DEFAULT_AUDIO_LATENCY_MODE);
  });

  it('set() still updates `current` even when localStorage throws', () => {
    const spy = vi.spyOn(storageStub, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    try {
      audioLatencyStore.set('stable');
      expect(audioLatencyStore.current).toBe('stable');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('reload-pending state (mid-session change → reload hint)', () => {
  it('reloadPending is false before the engine has booted', () => {
    expect(audioLatencyStore.booted).toBeNull();
    audioLatencyStore.set('stable');
    // No boot yet → don't nag.
    expect(audioLatencyStore.reloadPending).toBe(false);
  });

  it('reloadPending is false right after boot at the chosen mode', () => {
    audioLatencyStore.set('balanced');
    audioLatencyStore.bootedWith('balanced');
    expect(audioLatencyStore.reloadPending).toBe(false);
  });

  it('reloadPending flips true when the choice changes after boot', () => {
    audioLatencyStore.set('low');
    audioLatencyStore.bootedWith('low');
    expect(audioLatencyStore.reloadPending).toBe(false);
    audioLatencyStore.set('stable');
    expect(audioLatencyStore.reloadPending).toBe(true);
  });

  it('reloadPending clears again if the user reverts to the booted mode', () => {
    audioLatencyStore.set('low');
    audioLatencyStore.bootedWith('low');
    audioLatencyStore.set('stable');
    expect(audioLatencyStore.reloadPending).toBe(true);
    audioLatencyStore.set('low');
    expect(audioLatencyStore.reloadPending).toBe(false);
  });
});

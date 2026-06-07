// HD-store unit tests. Mirrors skin-store.test.ts: vitest runs under `node`
// (no DOM), so we polyfill `window` + `localStorage` BEFORE importing the runes
// store (the module IIFE constructs the singleton, which probes both).
//
// Filename note: `.test.ts` (not `.svelte.test.ts`) so the svelte loader
// doesn't try to compile this file as a runes module — it imports the store
// from `./hd-store.svelte`.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---- Minimal globals polyfill (must run BEFORE the store import). ----
class StorageStub {
  private map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  clear(): void {
    this.map.clear();
  }
  get length(): number {
    return this.map.size;
  }
  key(i: number): string | null {
    return Array.from(this.map.keys())[i] ?? null;
  }
}
const storageStub = new StorageStub();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).window = globalThis;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).localStorage = storageStub;
// A deterministic 16:9 "viewport" for the toggle-capture path.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).innerWidth = 2560;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).innerHeight = 1440;

const { hdStore } = await import('./hd-store.svelte');
const { VIDEO_RES } = await import('$lib/video/engine');

const STORAGE_KEY = 'pt.hd';

beforeEach(() => {
  storageStub.clear();
  hdStore.set(false);
  storageStub.clear();
});

describe('hdStore', () => {
  it('defaults OFF with engineRes = VIDEO_RES (byte-for-byte today)', () => {
    expect(hdStore.on).toBe(false);
    expect(hdStore.engineRes).toEqual({
      width: VIDEO_RES.width,
      height: VIDEO_RES.height,
    });
  });

  it('set(true) captures a viewport-derived HD res from the 16:9 stub', () => {
    hdStore.set(true);
    expect(hdStore.on).toBe(true);
    // 2560×1440 → 16:9 → 1920×1080.
    expect(hdStore.res).toEqual({ width: 1920, height: 1080 });
    expect(hdStore.engineRes).toEqual({ width: 1920, height: 1080 });
  });

  it('set(true, explicitRes) honors the override (e2e determinism)', () => {
    hdStore.set(true, { width: 1440, height: 1080 });
    expect(hdStore.engineRes).toEqual({ width: 1440, height: 1080 });
  });

  it('engineRes returns VIDEO_RES when OFF even if a res was captured earlier', () => {
    hdStore.set(true);
    expect(hdStore.engineRes.width).toBe(1920);
    hdStore.set(false);
    expect(hdStore.on).toBe(false);
    expect(hdStore.engineRes).toEqual({
      width: VIDEO_RES.width,
      height: VIDEO_RES.height,
    });
  });

  it('toggle() flips state', () => {
    expect(hdStore.on).toBe(false);
    hdStore.toggle();
    expect(hdStore.on).toBe(true);
    hdStore.toggle();
    expect(hdStore.on).toBe(false);
  });

  it('persists {on,res} to localStorage as JSON', () => {
    hdStore.set(true, { width: 1920, height: 1080 });
    const raw = storageStub.getItem(STORAGE_KEY);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw as string);
    expect(parsed.on).toBe(true);
    expect(parsed.res).toEqual({ width: 1920, height: 1080 });
  });

  it('persists OFF as well', () => {
    hdStore.set(true);
    hdStore.set(false);
    const parsed = JSON.parse(storageStub.getItem(STORAGE_KEY) as string);
    expect(parsed.on).toBe(false);
  });

  it('set still updates `on` even when localStorage.setItem throws', () => {
    const spy = vi
      .spyOn(storageStub, 'setItem')
      .mockImplementation(() => {
        throw new Error('quota');
      });
    try {
      hdStore.set(true, { width: 1280, height: 720 });
      expect(hdStore.on).toBe(true);
      expect(hdStore.engineRes).toEqual({ width: 1280, height: 720 });
    } finally {
      spy.mockRestore();
    }
  });
});

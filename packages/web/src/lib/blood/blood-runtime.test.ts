// packages/web/src/lib/blood/blood-runtime.test.ts
//
// Unit coverage for the Blood data-resolution policy: in-browser INJECTED data
// (the hosted-preview path, where the owner picks proprietary RFFs in the
// browser) takes PRIORITY over the /blood/ server fetch (the local
// `task setup:blood` path). This is the seam that makes the hosted CF Pages
// preview playable without putting non-redistributable data on the server.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  loadBloodData,
  setInjectedBloodData,
  clearInjectedBloodData,
  hasInjectedBloodData,
  BLOOD_REQUIRED_FILES,
} from './blood-runtime';

describe('blood-runtime: injected data vs server fetch', () => {
  beforeEach(() => {
    clearInjectedBloodData();
  });
  afterEach(() => {
    clearInjectedBloodData();
    vi.restoreAllMocks();
  });

  it('reports all required files missing when nothing is injected + fetch 404s', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404 }) as unknown as Response),
    );
    const { files, missing } = await loadBloodData();
    expect(files).toEqual([]);
    expect(new Set(missing)).toEqual(new Set(BLOOD_REQUIRED_FILES));
  });

  it('uses injected files instead of fetching (priority over the server path)', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: false, status: 404 }) as unknown as Response);
    vi.stubGlobal('fetch', fetchSpy);

    setInjectedBloodData([
      { name: 'BLOOD.RFF', bytes: new Uint8Array([1]) },
      { name: 'GUI.RFF', bytes: new Uint8Array([2]) },
      { name: 'SOUNDS.RFF', bytes: new Uint8Array([3]) },
    ]);
    expect(hasInjectedBloodData()).toBe(true);

    const { files, missing } = await loadBloodData();
    // No fetch when injected data is present.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(missing).toEqual([]);
    expect(files.map((f) => f.name).sort()).toEqual([...BLOOD_REQUIRED_FILES].sort());
  });

  it('canonicalises injected names to uppercase + still reports missing required ones', async () => {
    vi.stubGlobal('fetch', vi.fn());
    setInjectedBloodData([
      { name: 'blood.rff', bytes: new Uint8Array([1]) }, // lowercase from the OS picker
      // GUI.RFF + SOUNDS.RFF deliberately omitted → reported missing.
    ]);
    const { files, missing } = await loadBloodData();
    expect(files[0].name).toBe('BLOOD.RFF');
    expect(new Set(missing)).toEqual(new Set(['GUI.RFF', 'SOUNDS.RFF']));
  });

  it('passes extra (non-required) files through to MEMFS', async () => {
    vi.stubGlobal('fetch', vi.fn());
    setInjectedBloodData([
      { name: 'BLOOD.RFF', bytes: new Uint8Array([1]) },
      { name: 'GUI.RFF', bytes: new Uint8Array([2]) },
      { name: 'SOUNDS.RFF', bytes: new Uint8Array([3]) },
      { name: 'TILES000.ART', bytes: new Uint8Array([4]) }, // extra art
    ]);
    const { files, missing } = await loadBloodData();
    expect(missing).toEqual([]);
    expect(files.map((f) => f.name)).toContain('TILES000.ART');
  });

  it('clearInjectedBloodData restores the server-fetch path', async () => {
    setInjectedBloodData([{ name: 'BLOOD.RFF', bytes: new Uint8Array([1]) }]);
    expect(hasInjectedBloodData()).toBe(true);
    clearInjectedBloodData();
    expect(hasInjectedBloodData()).toBe(false);

    const fetchSpy = vi.fn(async () => ({ ok: false, status: 404 }) as unknown as Response);
    vi.stubGlobal('fetch', fetchSpy);
    await loadBloodData();
    expect(fetchSpy).toHaveBeenCalled(); // back to fetching
  });
});

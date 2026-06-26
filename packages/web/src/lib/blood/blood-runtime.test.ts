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
  BLOOD_BUNDLED_FILES,
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
    // Only the REQUIRED set gates "missing" — extra bundled DAT/ART that 404
    // are skipped silently, not reported missing.
    expect(new Set(missing)).toEqual(new Set(BLOOD_REQUIRED_FILES));
  });

  it('boots OUT-OF-BOX from the bundled shareware: fetches the FULL bundled set, nothing missing', async () => {
    // Simulate the beta-gated deploy where static/blood/ carries the bundled
    // 1997 shareware — every bundled file is served 200.
    const fetchSpy = vi.fn(async (url: string) => {
      const name = String(url).split('/').pop() ?? '';
      const known = (BLOOD_BUNDLED_FILES as readonly string[]).includes(name);
      return {
        ok: known,
        status: known ? 200 : 404,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchSpy);

    const { files, missing } = await loadBloodData();
    expect(missing).toEqual([]); // out-of-box: no picker needed
    expect(files.map((f) => f.name).sort()).toEqual([...BLOOD_BUNDLED_FILES].sort());
    // It fetched the whole bundled set (the engine needs the DAT/ART too).
    expect(fetchSpy).toHaveBeenCalledTimes(BLOOD_BUNDLED_FILES.length);
  });

  it('extra (non-required) bundled files that 404 are skipped, not reported missing', async () => {
    // Only the 3 REQUIRED RFFs are served; the DAT/ART 404. The card must NOT
    // flag "missing" (those are best-effort) — boot still proceeds.
    const fetchSpy = vi.fn(async (url: string) => {
      const name = String(url).split('/').pop() ?? '';
      const required = (BLOOD_REQUIRED_FILES as readonly string[]).includes(name);
      return {
        ok: required,
        status: required ? 200 : 404,
        arrayBuffer: async () => new Uint8Array([9]).buffer,
      } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchSpy);

    const { files, missing } = await loadBloodData();
    expect(missing).toEqual([]);
    expect(files.map((f) => f.name).sort()).toEqual([...BLOOD_REQUIRED_FILES].sort());
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

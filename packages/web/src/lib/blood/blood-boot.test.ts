// packages/web/src/lib/blood/blood-boot.test.ts
//
// The BLOOD BOOT SEAM, tested where it is cheap — the pure half of the thing
// that, if it went wrong, would ship a module that never starts.
//
// ⚠ WHAT THIS FILE CAN AND CANNOT PROVE, stated up front because the difference
// is the whole reason there are three layers of coverage on one function. It
// proves the seam DOES the right thing when called, and in the right ORDER. It
// cannot prove either SURFACE calls it — a body that imports `autoBootBlood`
// and never invokes it passes every test here. That half is
// `blood-face-model.test.ts` at the source and `blood-face-screen.spec.ts` /
// `blood-audio-output.spec.ts` in a real browser.
//
// No IndexedDB shim is installed, deliberately: vitest runs in node, the store
// feature-detects and returns empty, and "no stored full-game data" is the
// DEFAULT path every hosted visitor takes. `blood-data-store.test.ts` owns the
// shimmed half.

import { describe, expect, it, beforeEach } from 'vitest';
import {
  BLOOD_REQUIRED,
  autoBootBlood,
  awaitBloodExtras,
  bloodErrorKind,
  bootBlood,
  importBloodData,
} from './blood-boot';
import { clearInjectedBloodData, loadBloodData } from './blood-runtime';
import type { BloodHandleExtras } from '$lib/video/modules/blood';

/** A recording stand-in for the module's engine handle. The four methods the
 *  seam touches, plus a call log — which is what makes the ORDERING claim
 *  (`resetLoad` strictly before the re-boot) assertable at all. */
function fakeExtras(opts: { error?: string | null; missing?: string[] } = {}) {
  const calls: string[] = [];
  let latched = false;
  const extras = {
    calls,
    getRuntime: () => null,
    async ensureLoaded() {
      calls.push('ensureLoaded');
      latched = true;
      return opts.error ?? null;
    },
    pushKeyboardKey: () => false,
    missingDataFiles: () => opts.missing ?? [],
    resetLoad() {
      calls.push('resetLoad');
      latched = false;
    },
    get latched() {
      return latched;
    },
  };
  return extras as unknown as BloodHandleExtras & { calls: string[]; latched: boolean };
}

function fakeFile(name: string, bytes = new Uint8Array([1, 2, 3, 4])): File {
  return {
    name,
    arrayBuffer: async () => bytes.buffer.slice(0),
  } as unknown as File;
}

beforeEach(() => {
  clearInjectedBloodData();
});

describe('bootBlood — the verdict', () => {
  it('READY on success, and reports no missing files', async () => {
    const extras = fakeExtras();
    expect(await bootBlood(extras)).toEqual({ status: 'ready', error: null, missing: [] });
    expect(extras.calls).toEqual(['ensureLoaded']);
  });

  it('ERROR carries BOTH the message and the missing list', async () => {
    // The two are read from different places — the return value and the handle —
    // and a surface needs both to choose between "run this build command" and
    // "pick your own data".
    const extras = fakeExtras({ error: 'Blood data missing (GUI.RFF)', missing: ['GUI.RFF'] });
    const r = await bootBlood(extras);
    expect(r.status).toBe('error');
    expect(r.error).toContain('GUI.RFF');
    expect(r.missing).toEqual(['GUI.RFF']);
  });

  it('autoBootBlood boots even with NOTHING stored — the out-of-box path', async () => {
    // The default for every hosted visitor: no IndexedDB data, so the runtime
    // falls through to the BUNDLED 1997 shareware. The restore must not be a
    // precondition of the boot.
    const extras = fakeExtras();
    expect((await autoBootBlood(() => extras))?.status).toBe('ready');
    expect(extras.calls).toEqual(['ensureLoaded']);
  });
});

describe('⚠ autoBootBlood WAITS FOR ENGINE ADOPTION — the regression this file exists for', () => {
  it('boots on a handle that only appears a few frames after mount', async () => {
    // THE SHIPPED BUG, reproduced. A surface mounts as soon as the GRAPH has the
    // node; the VideoEngine adopts it on its own tick. `BloodCard` used to
    // survive this by ACCIDENT — its mount handler awaited the IndexedDB restore
    // before reading `extras`, so the engine got a turn — and the first draft of
    // this seam read the handle synchronously and returned early when it was
    // null. Result: BLOOD booted on the dock (engine always ahead) and NOT in
    // `blood-ingame.spec.ts` (BLOOD + videoOut + an edge = later adoption),
    // where it turned a passing test into a silent `test.skip`.
    const extras = fakeExtras();
    let reads = 0;
    const read = () => (++reads > 3 ? extras : null);
    const r = await autoBootBlood(read);
    expect(r?.status, 'a late-adopted node must still boot').toBe('ready');
    expect(reads, 'the accessor is re-read, not called once').toBeGreaterThan(3);
    expect(extras.calls).toEqual(['ensureLoaded']);
  });

  it('gives up with NULL rather than hanging when the node is never adopted', async () => {
    // The surface then sits in `idle` with its manual BOOT button — the same
    // fallback both surfaces already had, reached deliberately instead of by a
    // lost race. Bounded in FRAMES, never milliseconds.
    let reads = 0;
    expect(await awaitBloodExtras(() => { reads++; return null; }, 3)).toBeNull();
    expect(reads, 'it really retried rather than returning on the first read').toBe(4);
    // …and the whole mount path reports that as null rather than throwing.
    expect(await autoBootBlood(() => null)).toBeNull();
  });

  it('awaitBloodExtras returns immediately when the node is ALREADY adopted', async () => {
    // The common case must cost nothing: no frame is waited when the first read
    // succeeds, so the dock body does not paint a spurious idle frame.
    const extras = fakeExtras();
    let reads = 0;
    const got = await awaitBloodExtras(() => { reads++; return extras; });
    expect(got).toBe(extras);
    expect(reads).toBe(1);
  });
});

describe('importBloodData — the picker path, and the ORDER that makes it work', () => {
  it('⚠ RESETS THE LATCHED LOAD BEFORE RE-BOOTING', async () => {
    // THE BUG THIS ORDER EXISTS TO PREVENT, and it is invisible without a call
    // log: `ensureLoaded` LATCHES its verdict. If the picker registered fresh
    // bytes and then simply re-booted, the latched "data missing" would be
    // handed straight back and the files the owner just picked would never be
    // read — the failure would look exactly like "the picker does nothing".
    const extras = fakeExtras();
    await extras.ensureLoaded(); // latch a prior attempt
    extras.calls.length = 0;
    const done = await importBloodData([fakeFile('blood.rff')], extras);
    expect(done).not.toBeNull();
    expect(extras.calls).toEqual(['resetLoad', 'ensureLoaded']);
  });

  it('CANONICALISES the picked names — casing and directory prefix both', async () => {
    // A `webkitdirectory` pick hands us "Blood/blood.rff"; the Build resource
    // loader looks for "BLOOD.RFF". A surface reporting the raw name would be
    // reporting a file the engine never looked for.
    const extras = fakeExtras();
    const done = await importBloodData(
      [fakeFile('Blood/blood.rff'), fakeFile('gui.RFF')],
      extras,
    );
    expect(done!.names).toEqual(['BLOOD.RFF', 'GUI.RFF']);
  });

  it('⚠ REGISTERS THE BYTES WITH THE RUNTIME — the positive control', async () => {
    // Without this leg every assertion above passes on an implementation that
    // canonicalises names, resets the latch, re-boots and never actually hands
    // the runtime a single byte. `loadBloodData` short-circuits on injected
    // data, so reading it back is a direct observation rather than a proxy.
    const extras = fakeExtras();
    await importBloodData([fakeFile('blood.rff'), fakeFile('gui.rff')], extras);
    const loaded = await loadBloodData();
    expect(loaded.files.map((f) => f.name)).toEqual(['BLOOD.RFF', 'GUI.RFF']);
    // …and the missing list is computed against the REQUIRED set, so a partial
    // pick is still reported as incomplete rather than silently accepted.
    expect(loaded.missing).toEqual(['SOUNDS.RFF']);
  });

  it('an EMPTY pick is a no-op — the dismissed-dialog case', async () => {
    const extras = fakeExtras();
    expect(await importBloodData([], extras)).toBeNull();
    expect(extras.calls).toEqual([]);
  });
});

describe('bloodErrorKind — the three shapes a surface branches on', () => {
  it('classifies each', () => {
    expect(bloodErrorKind('BLOOD WASM not built', [])).toBe('not-built');
    expect(bloodErrorKind('Blood data missing (GUI.RFF)', ['GUI.RFF'])).toBe('data-missing');
    expect(bloodErrorKind('seqSpawn aborted', [])).toBe('engine');
  });

  it('⚠ NOT-BUILT WINS OVER DATA-MISSING, and the precedence is the point', () => {
    // With no wasm there is nothing to load data INTO, so offering the picker
    // would send the player off to find files that cannot help. The card made
    // the same choice; this keeps both surfaces making it identically.
    expect(bloodErrorKind('BLOOD WASM not built', ['GUI.RFF'])).toBe('not-built');
  });
});

describe('BLOOD_REQUIRED — the surfaces name the files the runtime looks for', () => {
  it('is the runtime\'s own list, not a typed copy', () => {
    // Both surfaces print this list in their data-missing prompt. Re-typing it
    // is how a prompt ends up naming a file the loader stopped requiring.
    expect([...BLOOD_REQUIRED]).toEqual(['BLOOD.RFF', 'GUI.RFF', 'SOUNDS.RFF']);
  });
});

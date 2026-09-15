// /preflight is SHELL-ONLY (owner ruling 2026-09-15): the universal `load`
// redirects a plain browser to /rack before the page component mounts. Pinned
// here at the seam, with the shell leg as its positive control; the e2e
// negative leg (preflight-rig-setup.spec.ts) proves the same thing through a
// real navigation.
import { afterEach, describe, expect, it } from 'vitest';
import { csr, load, ssr } from './+page';
import { setNativeAvailableForTests } from '$lib/platform/native';

describe('/preflight route gate', () => {
  afterEach(() => setNativeAvailableForTests(null));

  it('in a plain browser the load REDIRECTS to /rack (307) — nothing of the page paints', () => {
    setNativeAvailableForTests(false);
    let thrown: unknown = null;
    try {
      load();
    } catch (e) {
      thrown = e;
    }
    expect(thrown, 'SvelteKit redirect() throws a Redirect').toMatchObject({ status: 307, location: '/rack' });
  });

  it('POSITIVE CONTROL — under the shell the load lets the page render', () => {
    setNativeAvailableForTests(true);
    expect(() => load()).not.toThrow();
  });

  it('is client-rendered, so the ptNative probe runs where the bridge exists', () => {
    expect(ssr).toBe(false);
    expect(csr).toBe(true);
  });
});

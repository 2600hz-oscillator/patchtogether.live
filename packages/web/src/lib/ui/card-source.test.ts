// The delegation-follower is now load-bearing for TWO source-level gates, so
// it gets negative controls in BOTH directions: it must SEE what a shared body
// renders (or the stripe gate false-positives) and it must not INVENT what no
// file renders (or every gate reading it goes vacuous).

import { describe, it, expect } from 'vitest';
import { readCardSourceWithDelegates, delegatedSiblings, type CardSourceFs } from './card-source';

const join = (...p: string[]) => p.join('/');

function fakeFs(files: Record<string, string>): CardSourceFs {
  return {
    readFileSync: (path: string) => {
      const f = files[path];
      if (f === undefined) throw new Error(`ENOENT ${path}`);
      return f;
    },
    existsSync: (path: string) => path in files,
  };
}

const DIR = '/cards';
const WRAPPER = '/cards/MiniCard.svelte';

describe('readCardSourceWithDelegates', () => {
  it('THE REGRESSION: markup in a shared body is visible through a thin wrapper', () => {
    const fs = fakeFs({
      [WRAPPER]: `<script>import Body from './Body.svelte';</script>\n<Body kind="mini" />`,
      '/cards/Body.svelte': `<div class="stripe" style="background: var(--cable-cv);"></div>`,
    });
    const src = readCardSourceWithDelegates(WRAPPER, DIR, fs, join);
    expect(src, 'the body\'s stripe reached the gate').toContain('--cable-cv');
  });

  it('NEGATIVE CONTROL: a body that renders nothing adds nothing', () => {
    // Guards the other direction. If this ever passed, the helper would be
    // manufacturing matches and every gate built on it would be vacuous.
    const fs = fakeFs({
      [WRAPPER]: `<script>import Body from './Body.svelte';</script>\n<Body />`,
      '/cards/Body.svelte': `<div class="plain"></div>`,
    });
    const src = readCardSourceWithDelegates(WRAPPER, DIR, fs, join);
    expect(src).not.toContain('--cable-');
    expect(src).not.toContain('<Handle');
  });

  it('NEGATIVE CONTROL: a raw <Handle> hidden in the body is still caught', () => {
    // The false-NEGATIVE half — the expensive one. Moving a banned element into
    // a shared body must not launder it past the PatchPanel gate.
    const fs = fakeFs({
      [WRAPPER]: `<script>import Body from './Body.svelte';</script>\n<Body />`,
      '/cards/Body.svelte': `<Handle type="source" />`,
    });
    expect(readCardSourceWithDelegates(WRAPPER, DIR, fs, join)).toContain('<Handle');
  });

  it('a missing sibling is skipped, not thrown — a gate must not die on a stale import', () => {
    const fs = fakeFs({ [WRAPPER]: `<script>import Gone from './Gone.svelte';</script>` });
    expect(() => readCardSourceWithDelegates(WRAPPER, DIR, fs, join)).not.toThrow();
  });

  it('does not follow non-sibling imports', () => {
    // Scope is stated in the helper; this pins it so a widening is deliberate.
    const fs = fakeFs({
      [WRAPPER]: `<script>import X from '$lib/ui/Other.svelte';</script>`,
      '/cards/Other.svelte': `<div class="stripe" style="background: var(--cable-cv);"></div>`,
    });
    expect(readCardSourceWithDelegates(WRAPPER, DIR, fs, join)).not.toContain('--cable-cv');
  });

  it('a self-import cannot double the source', () => {
    const fs = fakeFs({
      [WRAPPER]: `import Self from './MiniCard.svelte';\nmarker`,
    });
    const src = readCardSourceWithDelegates(WRAPPER, DIR, fs, join);
    expect(src.match(/marker/g)).toHaveLength(1);
  });

  it('delegatedSiblings names the file a finding really lives in', () => {
    expect(delegatedSiblings(`import Body from './CvBuddyBody.svelte';`)).toEqual([
      'CvBuddyBody.svelte',
    ]);
    expect(delegatedSiblings(`<div/>`)).toEqual([]);
  });
});

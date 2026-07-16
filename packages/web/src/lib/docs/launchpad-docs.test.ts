// LaunchpadDocs — SSR render smoke test for the tabbed doc restructure.
//
// Renders the component server-side (svelte/server) and asserts the owner's
// tab IA + record vocabulary + the grid-only copy/paste stance hold in the
// DEFAULT render (top tab "1 Launchpad" → Grid Mode). Pure unit — no browser.
import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import LaunchpadDocs from './LaunchpadDocs.svelte';

const html = () => render(LaunchpadDocs as never, { props: {} }).body;

describe('LaunchpadDocs — tabbed structure', () => {
  it('has the two top-level tabs and the four owner-named single-mode subtabs', () => {
    const out = html();
    expect(out).toContain('1 Launchpad');
    expect(out).toContain('2 Launchpads');
    expect(out).toContain('Grid Mode');
    expect(out).toContain('Clip Mode');
    expect(out).toContain('Arranger Mode (TBD)');
    expect(out).toContain('Control Mode');
  });

  it('uses ARIA tab semantics (tablist / tab / tabpanel)', () => {
    const out = html();
    expect(out).toContain('role="tablist"');
    expect(out).toContain('role="tab"');
    expect(out).toContain('role="tabpanel"');
    expect(out).toContain('aria-selected="true"');
  });

  it('defaults to 1 Launchpad → Grid Mode', () => {
    const out = html();
    // The grid panel renders; other single panels don't.
    expect(out).toContain('id="lp1-panel-grid"');
    expect(out).not.toContain('id="lp1-panel-clip"');
    expect(out).not.toContain('id="lp2-panel-matrix"');
  });

  it('names the two record features CLIP RECORD and ARRANGER RECORD', () => {
    const out = html();
    expect(out).toContain('CLIP RECORD');
    expect(out).toContain('ARRANGER RECORD');
    // Discoverability: both arming surfaces are named in the vocabulary box.
    expect(out).toContain('◉ AUTO');
    expect(out).toContain('QUEUE-REC');
    expect(out).toContain('Assign to automation lane');
  });

  it('documents copy/paste as Grid-only (no editor CPY/PST doc content)', () => {
    const out = html();
    // The Grid tab carries the copy/paste palette…
    expect(out).toContain('ONLY copy/paste');
    // …and the removed editor scene pads are gone from the doc entirely.
    expect(out).not.toContain('CPY');
    expect(out).not.toContain('PST');
  });
});

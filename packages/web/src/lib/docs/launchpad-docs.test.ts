// LaunchpadDocs — SSR render smoke test for the tabbed doc restructure.
//
// Renders the component server-side (svelte/server) and asserts the owner's
// tab IA + record vocabulary hold in the DEFAULT render (top tab "1 Launchpad"
// → Grid Mode), and that the grid-only copy/paste stance holds in EVERY tab
// panel (panels are {#if}-gated, so each combination is rendered via the
// initial-tab props). Pure unit — no browser.
import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import LaunchpadDocs from './LaunchpadDocs.svelte';

const html = (props: Record<string, string> = {}) =>
  render(LaunchpadDocs as never, { props } as never).body;

// Every tab combination (mirrors SINGLE_TABS / PAIR_TABS in the component).
const SINGLE_TAB_IDS = ['grid', 'clip', 'arranger', 'control', 'walkthrough'] as const;
const PAIR_TAB_IDS = ['matrix', 'deck', 'editor', 'keys'] as const;
const everyPanel = (): { name: string; out: string }[] => [
  ...SINGLE_TAB_IDS.map((id) => ({
    name: `single/${id}`,
    out: html({ initialTopTab: 'single', initialSingleTab: id }),
  })),
  ...PAIR_TAB_IDS.map((id) => ({
    name: `pair/${id}`,
    out: html({ initialTopTab: 'pair', initialPairTab: id }),
  })),
];

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
    // Discoverability: the arming surfaces are named in the vocabulary box —
    // per-lane arm (the owner-locked model): SHIFT+top-row on the hardware,
    // the per-lane ◉ on the card; module-level assignment; CV never recorded.
    expect(out).toContain('arm the');
    expect(out).toContain('double-tap SHIFT');
    expect(out).toContain('QUEUE-REC');
    expect(out).toContain('Assign to automation lane');
    expect(out).toContain('CV is never recorded');
  });

  it('documents copy/paste as Grid-only (no editor CPY/PST doc content)', () => {
    const out = html();
    // The Grid tab carries the copy/paste palette…
    expect(out).toContain('ONLY copy/paste');
    // …and the removed editor scene pads are gone from the default panel.
    expect(out).not.toContain('CPY');
    expect(out).not.toContain('PST');
  });

  it('has no CPY/PST in ANY tab panel (incl. the pair note editor where they were removed)', () => {
    for (const { name, out } of everyPanel()) {
      expect(out, name).not.toContain('CPY');
      expect(out, name).not.toContain('PST');
    }
  });

  it('renders each tab combination (the initial-tab props select the panel)', () => {
    for (const id of SINGLE_TAB_IDS) {
      const out = html({ initialTopTab: 'single', initialSingleTab: id });
      expect(out, id).toContain(`id="lp1-panel-${id}"`);
    }
    for (const id of PAIR_TAB_IDS) {
      const out = html({ initialTopTab: 'pair', initialPairTab: id });
      expect(out, id).toContain(`id="lp2-panel-${id}"`);
    }
  });
});

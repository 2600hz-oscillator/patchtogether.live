import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import ClipplayerDocs from './ClipplayerDocs.svelte';
import Push2Docs from './Push2Docs.svelte';
import Push2PadGuide from './Push2PadGuide.svelte';
import LaunchpadDocs from './LaunchpadDocs.svelte';

describe('Clip Player guide ownership and navigation', () => {
  it('resolves every controller cross-link to a canonical guide section', () => {
    const canonical = render(ClipplayerDocs).body;
    const ids = new Set([...canonical.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
    ids.add('reference'); // supplied by the generated module page below the guide
    const pages = [render(Push2Docs).body];
    for (const initialMode of ['grid','clip','keys','control','audio','lengthEdit','arranger'] as const) {
      pages.push(render(Push2PadGuide, { props: { initialMode } }).body);
    }
    for (const initialSingleTab of ['grid','clip','arranger','control','audio','walkthrough']) {
      pages.push(render(LaunchpadDocs, { props: { initialTopTab:'single', initialSingleTab } } as never).body);
    }
    for (const initialPairTab of ['matrix','deck','editor','keys','audio']) {
      pages.push(render(LaunchpadDocs, { props: { initialTopTab:'pair', initialPairTab } } as never).body);
    }
    const links = pages.flatMap(page => [...page.matchAll(/href="\/docs\/modules\/clipplayer#([^"]+)"/g)].map(m => m[1]));
    expect(links.length).toBeGreaterThan(15);
    for (const anchor of links) expect(ids.has(anchor), `missing Clip Player section #${anchor}`).toBe(true);
    for (const page of pages) expect(page).not.toContain('controller-audio-guide');
  });

  it('preserves readable visual guides in server-rendered HTML', () => {
    const page = render(ClipplayerDocs).body;
    for (const view of ['session','notes','audio','song']) expect(page).toContain(`data-testid="clip-guide-${view}"`);
    expect(page).toContain('id="monome"');
    expect(page).toContain('id="audition"');
    expect(page).toContain('id="song-mode"');
    expect(page).toContain('.ptperf.zip');
    expect(page).toContain('not time-stretched');
  });
});

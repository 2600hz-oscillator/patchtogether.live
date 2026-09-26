import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';
import { setNodeParams } from './_module-coverage-helpers';
import { installRenderSmokeHooks, stepAndReadStats, assertRenderStats } from './_render-smoke';
import { SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';

// Real module factories, graph cables, audio analyser bridge and rendered FBO.
// A disconnected CV cable is the negative control: the same stimulus must stop
// affecting the picture, and the saved manual position must be restored.
for (const control of ['fader', 'dryWet'] as const) {
  test(`FADER ${control} CV changes rendered output and unplug restores the manual fader`, async ({ page, errorWatch }) => {
    test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS);
    await installRenderSmokeHooks(page);
    await page.goto('/rack?seed=none');
    await spawnPatch(page, [
      { id: 'dc', type: 'depolarizer', params: { depth: 0 } }, // genuine +0.5 CV
      { id: 'polarity', type: 'unityscalemathematik', params: { unityAtten: -1 } },
      { id: 'picture', type: 'shapes', domain: 'video', params: { shape: 0, zoom: 1 } },
      { id: 'fd', type: 'fader', domain: 'video', params: { fader: 0, dryWet: 0, [control]: 0.5 } },
    ], [
      { id: 'dc-cable', from: { nodeId: 'dc', portId: 'out' }, to: { nodeId: 'polarity', portId: 'u_in' }, sourceType: 'cv', targetType: 'cv' },
      { id: 'cv-cable', from: { nodeId: 'polarity', portId: 'u_out' }, to: { nodeId: 'fd', portId: control }, sourceType: 'cv', targetType: 'cv' },
      { id: 'picture-cable', from: { nodeId: 'picture', portId: 'out' }, to: { nodeId: 'fd', portId: control === 'fader' ? 'in_b' : 'return' }, sourceType: 'mono-video', targetType: 'mono-video' },
    ]);

    async function renderedAt(value: number) {
      // Rendering is paused; each probe explicitly advances the shared engine.
      await expect.poll(async () => {
        await stepAndReadStats(page, { nodeId: 'fd', steps: 2 });
        return page.evaluate((param) => {
          const w = window as unknown as { __engine: () => { getDomain: (domain: string) => { ctx: AudioContext; readParam: (id: string, param: string) => number } } };
          const audio = w.__engine().getDomain('audio');
          return { audioState: audio.ctx.state, value: w.__engine().getDomain('video').readParam('fd', param) };
        }, control);
      }).toEqual({ audioState: 'running', value });
      const result = await stepAndReadStats(page, { nodeId: 'fd', steps: 2 });
      assertRenderStats(result, 2);
      return result.mean;
    }

    const source = await stepAndReadStats(page, { nodeId: 'picture', steps: 2 });
    assertRenderStats(source, 2);
    const low = await renderedAt(0.25);
    await setNodeParams(page, 'polarity', { unityAtten: 1 });
    await expect.poll(() => page.evaluate(() => {
      const w = window as unknown as { __engine: () => { getDomain: (domain: string) => { ctx: AudioContext; readParam: (id: string, param: string) => number } } };
      const audio = w.__engine().getDomain('audio');
      return { state: audio.ctx.state, value: audio.readParam('polarity', 'unityAtten') };
    }), { message: 'CV source is running and its manual control update reached DSP' }).toEqual({ state: 'running', value: 1 });
    const high = await renderedAt(0.75);
    expect(low / source.mean).toBeCloseTo(0.25, 1);
    expect(high / source.mean).toBeCloseTo(0.75, 1);
    expect(high).toBeGreaterThan(low * 2.5);

    // CV never writes its transient value into the saved/shared patch.
    expect(await page.evaluate((param) => {
      const w = window as unknown as { __patch: { nodes: Record<string, { params: Record<string, number> }> } };
      return w.__patch.nodes.fd.params[param];
    }, control)).toBe(0.5);

    await setNodeParams(page, 'fd', { [control]: 0.3 });
    await renderedAt(0.55); // a manual move re-centres the live modulation
    await page.evaluate(() => {
      const w = window as unknown as { __patch: { edges: Record<string, unknown> }; __ydoc: { transact: (fn: () => void) => void } };
      w.__ydoc.transact(() => { delete w.__patch.edges['cv-cable']; });
    });
    const restored = await renderedAt(0.3);
    expect(restored / source.mean).toBeCloseTo(0.3, 1);

    // A browser never offers the native process Exit command.
    await page.getByTestId('workflow-file-trigger').click();
    await expect(page.getByTestId('workflow-file-menu')).toBeVisible();
    await expect(page.getByTestId('workflow-file-exit')).toHaveCount(0);
  });
}

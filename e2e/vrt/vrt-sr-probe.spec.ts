// e2e/vrt/vrt-sr-probe.spec.ts — VRT_PROBE=1 only. Prints the capture
// machine's AudioContext sample rate + the render-quantum submultiple
// (sampleRate / 128), i.e. the lowest frequency whose period divides a render
// quantum exactly. A sine at an integer multiple of that number produces a
// PHASE-INVARIANT AnalyserNode window, which is the only way an oscillating
// audio trace can be pinned by a screenshot without seeding synthetic data.
// The app never pins the rate (it takes whatever the device offers), so this
// number is a property of the machine and must be measured, not assumed.
import { test } from '@playwright/test';
import { spawnPatch } from '../tests/_helpers';

test('audio sample-rate probe', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/rack?shell=legacy&seed=none');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [{ id: 'vco', type: 'analogVco', position: { x: 60, y: 70 }, domain: 'audio' }],
    [],
  );
  await page.waitForTimeout(600);
  const info = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __engine?: () => Record<string, unknown> | null;
    };
    const e = w.__engine?.() as Record<string, unknown> | null | undefined;
    const keys = e ? Object.keys(e) : [];
    // Where does the AudioContext actually live? Every VRT scene's
    // `freezeAudio` does `w.__engine?.()?.ctx.suspend()` inside a try/catch —
    // if `.ctx` is not there, that suspend is a SILENT no-op and every
    // "we freeze the AudioContext so the trace is stable" claim in
    // vrt-scenes.ts / vrt-composite-scenes.ts is false.
    const direct = (e as { ctx?: AudioContext } | null | undefined)?.ctx;
    const viaDomain = (
      e as { getDomain?: (d: string) => { ctx?: AudioContext } } | null | undefined
    )?.getDomain?.('audio')?.ctx;
    const ctx = direct ?? viaDomain;
    return {
      engineKeys: keys,
      hasDirectCtx: !!direct,
      hasDomainCtx: !!viaDomain,
      sampleRate: ctx?.sampleRate ?? null,
      state: ctx?.state ?? null,
    };
  });
  // eslint-disable-next-line no-console
  console.log(
    `[sr] sampleRate=${info.sampleRate} state=${info.state} ` +
      `quantumSubmultipleHz=${info.sampleRate ? info.sampleRate / 128 : '?'} ` +
      `hasDirectCtx=${info.hasDirectCtx} hasDomainCtx=${info.hasDomainCtx} ` +
      `engineKeys=[${info.engineKeys.join(',')}]`,
  );
});

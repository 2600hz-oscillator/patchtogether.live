import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';
import { pinVrtFonts, awaitVrtFonts } from '../vrt/_fonts';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

test('PROBE: wavesculpt card pixel delta vs committed baseline', async ({ page, rack }) => {
  await pinVrtFonts(page);
  await spawnPatch(page, [
    { id: 'ws', type: 'wavesculpt', position: { x: 200, y: 100 }, domain: 'audio' },
  ]);
  await awaitVrtFonts(page);
  await page.addStyleTag({
    content:
      '.svelte-flow__minimap,.svelte-flow__controls,.svelte-flow__attribution{display:none !important;}',
  });
  const card = page.locator('.svelte-flow__node-wavesculpt').first();
  await card.waitFor({ state: 'visible' });
  await page.waitForTimeout(1500);

  const shot = await card.screenshot();
  const actual = PNG.sync.read(shot);
  const baseP = path.resolve('vrt/__screenshots__/vrt.spec.ts/darwin/wavesculpt.png');
  const base = PNG.sync.read(fs.readFileSync(baseP));

  // eslint-disable-next-line no-console
  console.log('DIMS', JSON.stringify({
    actual: `${actual.width}x${actual.height}`,
    baseline: `${base.width}x${base.height}`,
  }));
  if (actual.width !== base.width || actual.height !== base.height) {
    // eslint-disable-next-line no-console
    console.log('DIMENSION MISMATCH — no ratio computable');
    return;
  }
  const diff = new PNG({ width: base.width, height: base.height });
  for (const thr of [0.1, 0.02, 0.0]) {
    const n = pixelmatch(base.data, actual.data, diff.data, base.width, base.height, {
      threshold: thr,
    });
    // eslint-disable-next-line no-console
    console.log(
      `DIFF threshold=${thr} pixels=${n} ratio=${(n / (base.width * base.height)).toFixed(5)}`,
    );
  }
  fs.writeFileSync('/tmp/ws-actual.png', PNG.sync.write(actual));
  fs.writeFileSync('/tmp/ws-diff.png', PNG.sync.write(diff));
  expect(true).toBe(true);
});

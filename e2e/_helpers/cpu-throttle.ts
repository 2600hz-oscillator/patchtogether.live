// LOCAL reproduction of a starved CI shard. `E2E_CPU_THROTTLE=8` applies CDP
// CPU throttling to the page under test (`Emulation.setCPUThrottlingRate`) —
// the seam backdraft-clocked-delay.spec.ts carries inline. A real-GPU dev box
// cannot otherwise see the failure mode a hot 4-worker SwiftShader shard
// produces: every action completes, each one costs 5-40× (a 9 s click, a 4 s
// export), and the SUM crosses the test budget with no assertion ever failing.
//
// Default `1` = no-op, so a plain local run and CI are untouched. Never set it
// on CI: the shard's own contention is the real thing this stands in for.

import type { Page } from '@playwright/test';

export const CPU_THROTTLE = Number(process.env.E2E_CPU_THROTTLE ?? '1');

/** Throttle the page's renderer CPU by `E2E_CPU_THROTTLE` (no-op at 1). */
export async function applyCpuThrottle(page: Page): Promise<void> {
  if (!(CPU_THROTTLE > 1)) return;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });
}

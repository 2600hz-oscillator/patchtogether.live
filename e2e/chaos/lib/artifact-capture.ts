// On-violation artifact capture. The plan (chaos-tests-and-bandmates.md §6)
// specifies a richer set (scope dump, full intent trace, video). Stage-1 ships
// a minimal but useful subset: meta + patch snapshot + console + screenshot.
// The remaining artifacts land in later iterations once we have a real bug
// to validate that more data actually helps triage.

import type { Page } from '@playwright/test';
import type { Intent } from './intent';
import type { ConsoleEvent, Violation } from './invariants';
import type { PatchSnapshot, EngineSnapshot } from './state';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname_ = dirname(fileURLToPath(import.meta.url));
const FINDINGS_ROOT = join(__dirname_, '..', 'findings');

export interface FindingMeta {
  ts: string;
  seed: number;
  personality: string;
  iteration: number;
  invariantId: string;
  message: string;
  gitSha?: string;
}

export interface FindingBundle {
  meta: FindingMeta;
  patch: PatchSnapshot;
  engine: EngineSnapshot;
  consoleEvents: ConsoleEvent[];
  intentTrace: Intent[];
}

export async function saveFinding(page: Page, bundle: FindingBundle): Promise<string> {
  const dirName = `${bundle.meta.ts.replace(/[:.]/g, '-')}-seed${bundle.meta.seed}-${bundle.meta.invariantId}`;
  const dir = join(FINDINGS_ROOT, dirName);
  await mkdir(dir, { recursive: true });

  await writeFile(
    join(dir, 'meta.json'),
    JSON.stringify(bundle.meta, null, 2),
  );
  await writeFile(
    join(dir, 'patch.json'),
    JSON.stringify({ patch: bundle.patch, engine: bundle.engine }, null, 2),
  );
  await writeFile(
    join(dir, 'console.jsonl'),
    bundle.consoleEvents.map((e) => JSON.stringify(e)).join('\n'),
  );
  await writeFile(
    join(dir, 'intent-trace.jsonl'),
    bundle.intentTrace.map((i) => JSON.stringify(i)).join('\n'),
  );

  // Best-effort screenshot — don't fail the finding if the page is in a
  // weird state (e.g., COOP/COEP errors on the screenshot capture itself).
  try {
    await page.screenshot({ path: join(dir, 'screenshot.png'), fullPage: true });
  } catch {
    /* page may be too broken to screenshot */
  }

  return dir;
}

export function violationMeta(
  v: Violation,
  ctx: { seed: number; personality: string; iteration: number },
): FindingMeta {
  return {
    ts: new Date().toISOString(),
    seed: ctx.seed,
    personality: ctx.personality,
    iteration: ctx.iteration,
    invariantId: v.invariantId,
    message: v.message,
  };
}

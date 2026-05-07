// /docs/testing — list ART scenarios + E2E specs at build time.
// Pure file-system enumeration; no runtime DB or auth.
//
// Repo root resolution: the `vite build` (and `vite dev`) processes are
// always launched from packages/web (npm run dev|build -w packages/web),
// so process.cwd() === <repo>/packages/web. Two ups from that is the repo
// root, where `art/`, `e2e/`, and `vrt/` live. We bake the listing into
// the prerendered HTML via this `load`, so the runtime path is never
// touched in production (the page is static).

import { readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { PageServerLoad } from './$types';

const REPO = resolve(process.cwd(), '..', '..');

function listSafe(p: string): string[] {
  try { return readdirSync(p); } catch { return []; }
}

export const load: PageServerLoad = () => {
  const artScenariosDir = join(REPO, 'art', 'scenarios');
  const artBaselinesDir = join(REPO, 'art', 'baselines');
  const e2eTestsDir = join(REPO, 'e2e', 'tests');

  const artScenarios = listSafe(artScenariosDir).flatMap((g) => {
    const groupDir = join(artScenariosDir, g);
    let stat;
    try { stat = statSync(groupDir); } catch { return []; }
    if (!stat.isDirectory()) return [];
    return listSafe(groupDir)
      .filter((f) => f.endsWith('.test.ts'))
      .map((f) => ({ group: g, file: f, path: `art/scenarios/${g}/${f}` }));
  }).sort((a, b) => a.path.localeCompare(b.path));

  const artBaselines = listSafe(artBaselinesDir).flatMap((g) => {
    const groupDir = join(artBaselinesDir, g);
    let stat;
    try { stat = statSync(groupDir); } catch { return []; }
    if (!stat.isDirectory()) return [];
    return listSafe(groupDir)
      .filter((f) => f.endsWith('.f32') || f.endsWith('.sha'))
      .map((f) => ({ group: g, file: f, path: `art/baselines/${g}/${f}` }));
  }).sort((a, b) => a.path.localeCompare(b.path));

  const vrtImplemented = existsSync(join(REPO, 'vrt'));
  const e2eSpecs = listSafe(e2eTestsDir).filter((f) => f.endsWith('.spec.ts')).sort();

  return { artScenarios, artBaselines, vrtImplemented, e2eSpecs };
};

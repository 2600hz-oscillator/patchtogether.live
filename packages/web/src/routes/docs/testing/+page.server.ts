// Server-only loader so we can readdirSync at prerender time. Build emits
// static HTML; no runtime requests reach this file.
import { readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const prerender = true;

const HERE = fileURLToPath(new URL('.', import.meta.url));
// HERE = packages/web/src/routes/docs/testing
const REPO = resolve(HERE, '..', '..', '..', '..', '..', '..');

function listSafe(p: string): string[] {
  try { return readdirSync(p); } catch { return []; }
}

interface ScenarioRef { group: string; file: string; path: string; }

export const load = () => {
  const artScenariosDir = join(REPO, 'art', 'scenarios');
  const artBaselinesDir = join(REPO, 'art', 'baselines');

  const artScenarios: ScenarioRef[] = listSafe(artScenariosDir).flatMap((g) => {
    const groupDir = join(artScenariosDir, g);
    let s;
    try { s = statSync(groupDir); } catch { return []; }
    if (!s.isDirectory()) return [];
    return listSafe(groupDir)
      .filter((f) => f.endsWith('.test.ts'))
      .map((f) => ({ group: g, file: f, path: `art/scenarios/${g}/${f}` }));
  }).sort((a, b) => a.path.localeCompare(b.path));

  const artBaselines: ScenarioRef[] = listSafe(artBaselinesDir).flatMap((g) => {
    const groupDir = join(artBaselinesDir, g);
    let s;
    try { s = statSync(groupDir); } catch { return []; }
    if (!s.isDirectory()) return [];
    return listSafe(groupDir)
      .filter((f) => f.endsWith('.f32') || f.endsWith('.sha'))
      .map((f) => ({ group: g, file: f, path: `art/baselines/${g}/${f}` }));
  }).sort((a, b) => a.path.localeCompare(b.path));

  const vrtImplemented = existsSync(join(REPO, 'vrt'));

  const e2eTestsDir = join(REPO, 'e2e', 'tests');
  const e2eSpecs = listSafe(e2eTestsDir).filter((f) => f.endsWith('.spec.ts')).sort();

  return {
    artScenarios,
    artBaselines,
    vrtImplemented,
    e2eSpecs,
  };
};

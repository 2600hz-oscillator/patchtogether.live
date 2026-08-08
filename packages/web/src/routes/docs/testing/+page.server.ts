import type { PageServerLoad } from './$types';

// This page lists FILE NAMES only — every consumer below is `Object.keys(...)`.
//
// ⚠ IT USED TO GET THEM FROM `import.meta.glob(..., { query: '?url', eager: true })`,
// with a comment explaining that `?url` "gives us the keyset (paths) without
// inlining file bytes". The first half is true and the second is not: `?url` on
// a real file makes Vite EMIT THAT FILE as a build asset. It kept the bytes out
// of the JS by putting them in `output/server/_app/immutable/assets/` instead.
//
// Measured cost, on this repo: 20.27 MB of ART `.f32` baselines and 5.67 MB of
// `.ts` sources — ~26 MB of files nothing ever reads — emitted into the SERVER
// output and carried into the Cloudflare Worker. It put the Worker within ~60 kB
// of the hard 3 MiB limit, which meant ANY new `e2e/tests/*.spec.ts` broke the
// preview deploy for the whole repo. That is exactly how it was found: one added
// spec, `Deployment failed! Your Worker exceeded the size limit of 3 MiB`.
//
// So: read the directory listings instead. This route is PRERENDERED
// (`docs/+layout.ts` sets `prerender = true`, and the build emits a static
// `docs/testing.html`), so `load` runs on the BUILD machine and never at
// runtime — which is what makes `node:fs` correct here rather than the hazard
// the old comment was rightly worried about. (`nodejs_compat` is already on for
// this Worker — wrangler.toml — so the import itself is supported regardless.)
//
// Every read is fail-soft: if the tree is not there, the page shows empty lists
// instead of throwing. So the worst case of un-prerendering this route, or
// running somewhere without a filesystem, is a page with nothing on it — never
// a 500 and never a broken build.
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * The repo root, found by walking up until a directory has BOTH `art/` and
 * `e2e/`. Anchored to CONTENT rather than to a fixed `../../../../../..` depth,
 * so moving this route does not silently produce empty lists — the failure mode
 * the `?url` globs did not have and the one thing worth being careful about.
 * Returns null when not found; every caller then yields an empty list.
 */
function repoRoot(): string | null {
  try {
    let dir = resolve(process.cwd());
    for (let i = 0; i < 8; i += 1) {
      if (existsSync(join(dir, 'art')) && existsSync(join(dir, 'e2e'))) return dir;
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  } catch {
    /* no filesystem here — fall through to null */
  }
  return null;
}

/** Files directly inside `<root>/<rel>` matching `test`, sorted. [] if absent. */
function listFiles(root: string | null, rel: string, test: (f: string) => boolean): string[] {
  if (!root) return [];
  try {
    const dir = join(root, rel);
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** Immediate subdirectory names of `<root>/<rel>`, sorted. [] if absent. */
function listDirs(root: string | null, rel: string): string[] {
  if (!root) return [];
  try {
    const dir = join(root, rel);
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** `<group>/<file>` pairs under a two-level tree, e.g. art/scenarios/<g>/<f>. */
function listGrouped(
  root: string | null,
  rel: string,
  test: (f: string) => boolean,
): { group: string; file: string }[] {
  return listDirs(root, rel).flatMap((group) =>
    listFiles(root, join(rel, group), test).map((file) => ({ group, file })),
  );
}

export interface ArtScenario {
  group: string;
  file: string;
  path: string;
}
export interface ArtBaseline {
  group: string;
  file: string;
  path: string;
}

function relPath(absPath: string, rootSegment: string): string {
  const i = absPath.indexOf(rootSegment);
  return i >= 0 ? absPath.slice(i) : absPath;
}

export const load: PageServerLoad = () => {
  // Resolved on every server render — which for this route means the BUILD
  // (it prerenders to a static docs/testing.html) and the dev server. Both have
  // the repo on disk, so dev shows the same data the shipped page does.
  const root = repoRoot();

  const artScenarios: ArtScenario[] = listGrouped(root, 'art/scenarios', (f) =>
    f.endsWith('.test.ts'),
  )
    .map(({ group, file }) => ({ group, file, path: `art/scenarios/${group}/${file}` }))
    .sort((a, b) => a.path.localeCompare(b.path));

  const artBaselines: ArtBaseline[] = listGrouped(
    root,
    'art/baselines',
    (f) => f.endsWith('.f32') || f.endsWith('.sha'),
  )
    .map(({ group, file }) => ({ group, file, path: `art/baselines/${group}/${file}` }))
    .sort((a, b) => a.path.localeCompare(b.path));

  const e2eSpecs = listFiles(root, 'e2e/tests', (f) => f.endsWith('.spec.ts'));

  // Presence probe for a repo-root `vrt/` harness — unchanged semantics: the
  // old glob pointed at `<root>/vrt/**/*`, so a missing directory meant false.
  const vrtImplemented = listFiles(root, 'vrt', () => true).length > 0
    || listDirs(root, 'vrt').length > 0;

  return { artScenarios, artBaselines, vrtImplemented, e2eSpecs };
};

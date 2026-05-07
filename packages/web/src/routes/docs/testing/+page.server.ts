import type { PageServerLoad } from './$types';

// Vite resolves these globs at build time, so the testing page is fully
// frozen alongside the rest of the prerendered site. No runtime fs reads —
// which means the path is invariant to where the bundle lands at runtime
// (Cloudflare Pages worker, vite preview, etc.).
//
// We only need filenames here (no source contents), so the globs use the
// `?url` query — Vite gives us the keyset (paths) without inlining file
// bytes. `?url` also lets the baseline glob match `.f32` / `.sha` blobs
// that aren't valid JS and would otherwise blow up the parser.
const ART_SCENARIO_GLOB = import.meta.glob('../../../../../../art/scenarios/*/*.test.ts', {
  query: '?url',
  import: 'default',
  eager: true,
}) as Record<string, string>;
const ART_BASELINE_GLOB = import.meta.glob(
  '../../../../../../art/baselines/*/*.{f32,sha}',
  { query: '?url', import: 'default', eager: true },
) as Record<string, string>;
const E2E_SPEC_GLOB = import.meta.glob('../../../../../../e2e/tests/*.spec.ts', {
  query: '?url',
  import: 'default',
  eager: true,
}) as Record<string, string>;
// VRT presence: probe glob — if any file lives under vrt/, the harness
// exists. Empty dir = empty record = "not yet implemented".
const VRT_PROBE = import.meta.glob('../../../../../../vrt/**/*', {
  query: '?url',
  import: 'default',
  eager: true,
}) as Record<string, string>;

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
  const artScenarios: ArtScenario[] = Object.keys(ART_SCENARIO_GLOB)
    .map((p) => {
      const path = relPath(p, 'art/');
      const segs = path.split('/');
      // path looks like `art/scenarios/<group>/<file>`
      const group = segs[2] ?? 'unknown';
      const file = segs[3] ?? path;
      return { group, file, path };
    })
    .sort((a, b) => a.path.localeCompare(b.path));

  const artBaselines: ArtBaseline[] = Object.keys(ART_BASELINE_GLOB)
    .map((p) => {
      const path = relPath(p, 'art/');
      const segs = path.split('/');
      const group = segs[2] ?? 'unknown';
      const file = segs[3] ?? path;
      return { group, file, path };
    })
    .sort((a, b) => a.path.localeCompare(b.path));

  const e2eSpecs = Object.keys(E2E_SPEC_GLOB)
    .map((p) => {
      const segs = p.split('/');
      return segs[segs.length - 1];
    })
    .sort();

  const vrtImplemented = Object.keys(VRT_PROBE).length > 0;

  return { artScenarios, artBaselines, vrtImplemented, e2eSpecs };
};

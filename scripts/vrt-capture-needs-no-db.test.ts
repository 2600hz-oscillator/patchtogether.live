// scripts/vrt-capture-needs-no-db.test.ts
//
// THE VRT CAPTURE VISITS NO DATABASE-BACKED ROUTE. Pure-unit, zero-flake, runs
// in the `unit` lane via `task test` → `task test:scripts`. No browser, no
// database, no Docker.
//
// WHY THIS IS A GATE AND NOT A COMMENT (#1828)
// -------------------------------------------
// vrt-update.yml's capture — the repo's ONLY baseline author — used to declare
// `services: postgres:17` plus an `Apply DB schema` step. Both were copied when
// the workflow was written (#549: "mirrors the ci.yml `vrt` job (postgres
// service container)"); that ci.yml `vrt` job was deleted 2026-08-17. Nothing in
// the capture ever read the database, and #1828 removed it.
//
// That removal rests on an argument about which ROUTES the capture visits. An
// argument in a workflow comment ROTS: the next spec added to FULL_MATCH could
// visit /r/ or /dashboard, and the capture would then boot an app whose server
// load opens a Postgres connection with no Postgres to open it against.
//
// ⚠ THE ASYMMETRY IS WHY THIS IS WORTH A GATE. A wrong answer does not fail
// fast — it fails after a 45-55 MINUTE capture, and per #1810 a failed capture
// discards every good baseline in the run. This test moves that failure into
// the unit lane, where it costs milliseconds.
//
// WHAT IT ASSERTS
//  1. Every `page.goto` target in e2e/vrt/ is a STRING LITERAL. A dynamic URL is
//     RED — not because it is wrong, but because it is outside what this
//     scanner can follow, and that decision belongs to a human.
//  2. No target resolves to a DB-backed route prefix (deny by default).
//  3. TRANSITIVE REACHABILITY, the real question: for the routes the capture
//     visits, no server entry point (its `+page.server.ts` / `+layout.server.ts`
//     chain, plus hooks.server.ts) can reach `$lib/server/db` through imports.
//     A DIRECT-import check would be too weak and would have passed a route
//     like /dashboard, which reaches the driver via $lib/server/rackspaces.
//  4. POSITIVE CONTROL on that resolver: /dashboard and /api/health MUST come
//     back reachable. A resolver that had quietly stopped following imports
//     would report "no route touches the DB" for the whole app.
//  5. The workflow side is anchored: vrt-update.yml's capture declares no
//     postgres, no DATABASE_URL and no schema apply.
//
// WHAT THIS GATE CANNOT SEE
//   · A DYNAMICALLY-BUILT URL. Assertion 1 turns that from a blind spot into a
//     RED test, but only for `.goto(` call sites — a navigation performed by
//     clicking a link, or `page.evaluate(() => location.assign(…))`, is not
//     read here at all.
//   · A REDIRECT. If `/rack` ever server-redirected into a DB-backed route, the
//     goto target would still be `/rack` and this gate would stay green. The
//     reachability check partly covers it (the redirecting load would itself be
//     on the visited chain) but a client-side redirect would not be seen.
//   · WHETHER THE APP ACTUALLY BOOTS WITHOUT A DATABASE. That is proved by a
//     real capture run, not here.
//   · SPECS OUTSIDE e2e/vrt/. The functional e2e lane genuinely needs postgres —
//     its playwright.config.ts starts the Hocuspocus relay as a SECOND
//     webServer, and that relay decides persistence off DATABASE_URL at module
//     load. Nothing here says otherwise, and that service was deliberately kept.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VRT_DIR = join(ROOT, 'e2e/vrt');
const WEB_SRC = join(ROOT, 'packages/web/src');
const ROUTES = join(WEB_SRC, 'routes');
const DB_MODULE = join(WEB_SRC, 'lib/server/db.ts');

/** Route prefixes whose server side can reach Postgres. Deny by default. */
const DB_BACKED_PREFIXES = ['/r/', '/dashboard', '/api/', '/sign-in', '/sign-up'];

// ---------------------------------------------------------------------------
// Scanners
// ---------------------------------------------------------------------------

function vrtSources(dir = VRT_DIR): Array<[string, string]> {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .sort()
    .map((f) => [f, readFileSync(join(dir, f), 'utf8')] as [string, string]);
}

export interface Nav {
  file: string;
  line: number;
  /** The literal target, or null when the argument is not a plain string. */
  target: string | null;
  raw: string;
}

/** Every `.goto(<arg>)` call site, literal or not. */
export function navigations(sources = vrtSources()): Nav[] {
  const out: Nav[] = [];
  for (const [file, src] of sources) {
    src.split('\n').forEach((line, i) => {
      const m = line.match(/\.goto\(\s*([^)]*)\)/);
      if (!m) return;
      const arg = m[1].trim();
      const lit = arg.match(/^'([^']*)'$/) ?? arg.match(/^"([^"]*)"$/);
      out.push({ file, line: i + 1, target: lit ? lit[1] : null, raw: arg });
    });
  }
  return out;
}

/** Pathnames (query stripped) the capture navigates to. */
export function visitedPaths(navs = navigations()): string[] {
  return [...new Set(navs.filter((n) => n.target).map((n) => n.target!.split('?')[0]))].sort();
}

/**
 * Transitive import closure of a web-source file, following `$lib/…` and
 * relative specifiers inside packages/web/src. Returns true when
 * `$lib/server/db` is reachable — i.e. when serving that entry point can open a
 * Postgres connection.
 */
export function reachesDb(entry: string, dbModule = DB_MODULE): boolean {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop() as string;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    if (file === dbModule) return true;
    const src = readFileSync(file, 'utf8');
    for (const [, spec] of src.matchAll(/from\s+'([^']+)'/g)) {
      let base: string | null = null;
      if (spec.startsWith('$lib/')) base = join(WEB_SRC, 'lib', spec.slice('$lib/'.length));
      else if (spec.startsWith('.')) base = join(dirname(file), spec);
      if (!base) continue;
      base = base.replace(/\.js$/, '');
      for (const cand of [`${base}.ts`, join(base, 'index.ts')]) {
        if (existsSync(cand)) stack.push(cand);
      }
    }
  }
  return false;
}

/** Server entry points that run when serving `pathname`, ancestors included. */
export function serverEntryPoints(pathname: string): string[] {
  const segments = pathname.split('/').filter(Boolean);
  const dirs = [ROUTES, ...segments.map((_, i) => join(ROUTES, ...segments.slice(0, i + 1)))];
  const files: string[] = [];
  for (const d of dirs) {
    for (const f of ['+layout.server.ts', '+page.server.ts', '+server.ts']) {
      const p = join(d, f);
      if (existsSync(p)) files.push(p);
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// 1 + 2. What the capture navigates to.
// ---------------------------------------------------------------------------

describe('the VRT capture navigates only to DB-free routes', () => {
  const navs = navigations();

  it('finds navigations at all — a scan matching nothing would pass everything below', () => {
    expect(navs.length).toBeGreaterThan(0);
    // Anchored to NAMES the corpus must contain, never to a count.
    const targets = new Set(navs.map((n) => n.target));
    expect(targets.has('/')).toBe(true);
    expect([...targets].some((t) => t !== null && t.startsWith('/rack'))).toBe(true);
  });

  it('every navigation target is a STRING LITERAL this scanner can read', () => {
    // Not a style rule. A computed URL is outside what a text scan can follow,
    // so the honest response is to refuse it and make a human decide, rather
    // than to report green over something never examined.
    const dynamic = navs.filter((n) => n.target === null);
    expect(
      dynamic.map((n) => `${n.file}:${n.line}  .goto(${n.raw})`),
      'A computed navigation target cannot be checked against the DB-backed ' +
        'prefix list. Either make it a literal, or establish by hand that it ' +
        'cannot reach /r/, /dashboard or /api and say so here.',
    ).toEqual([]);
  });

  it('no navigation target is a DB-backed route', () => {
    const offenders = navs
      .filter((n) => n.target !== null && DB_BACKED_PREFIXES.some((p) => (n.target as string).startsWith(p)))
      .map((n) => `${n.file}:${n.line}  ${n.target}`);
    expect(
      offenders,
      'vrt-update.yml runs this capture with NO postgres and NO schema apply ' +
        '(#1828). A spec visiting a DB-backed route would boot a server load ' +
        'that opens a Postgres connection against nothing — and it would fail ' +
        'after a 45-55 minute capture, discarding every good baseline (#1810). ' +
        'Either drop the navigation, or restore postgres to that job AS A STEP ' +
        '(.github/scripts/start-postgres.sh), never as a `services:` block.',
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3 + 4. The real question: can serving those routes reach a database?
// ---------------------------------------------------------------------------

describe('serving the visited routes cannot reach Postgres', () => {
  const visited = visitedPaths();

  it('resolves the visited pathnames (non-vacuous)', () => {
    expect(visited).toContain('/');
    expect(visited).toContain('/rack');
  });

  it('POSITIVE CONTROL: the resolver DOES find the DB from a DB-backed route', () => {
    // /dashboard reaches it only TRANSITIVELY — +page.server.ts imports
    // $lib/server/rackspaces, which imports ./db.js. A direct-import check would
    // call this route DB-free, which is exactly the false green this control
    // exists to make impossible.
    expect(reachesDb(join(ROUTES, 'dashboard/+page.server.ts'))).toBe(true);
    expect(reachesDb(join(ROUTES, 'api/health/+server.ts'))).toBe(true);
  });

  it('NEGATIVE CONTROL: the resolver does NOT claim the DB from a route with no server side', () => {
    expect(reachesDb(join(ROUTES, 'rack/+page.ts'))).toBe(false);
  });

  it('no server entry point on a visited route can reach $lib/server/db', () => {
    const entries = visited.flatMap((p) => serverEntryPoints(p).map((f) => [p, f] as const));
    // The root +layout.server.ts is on every chain; if this list were empty the
    // assertion below would be vacuous.
    expect(entries.length).toBeGreaterThan(0);
    const offenders = entries
      .filter(([, f]) => reachesDb(f))
      .map(([p, f]) => `${p} → ${f.slice(ROOT.length + 1)}`);
    expect(offenders, 'a visited route opens a Postgres connection server-side').toEqual([]);
  });

  it('...and neither can hooks.server.ts, which runs on EVERY request', () => {
    expect(reachesDb(join(WEB_SRC, 'hooks.server.ts'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. Anchor the workflow side, so the two halves cannot drift apart.
// ---------------------------------------------------------------------------

describe('vrt-update.yml declares no database', () => {
  const src = readFileSync(join(ROOT, '.github/workflows/vrt-update.yml'), 'utf8');
  const code = src
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');

  it('has no postgres service container', () => {
    expect(code).not.toMatch(/^\s*image:\s*\S*postgres/m);
    expect(code).not.toMatch(/^ {4}services:/m);
  });

  it('sets no DATABASE_URL and applies no schema', () => {
    expect(code).not.toMatch(/DATABASE_URL:/);
    expect(code).not.toMatch(/apply-db-schema\.sh/);
  });

  it('still dispatches with the branch ref property #1458 depends on (not regressed here)', () => {
    // Unrelated to the DB, deliberately asserted next to it: this file is now
    // edited for reliability reasons, and `--ref "$BRANCH"` (so a branch runs
    // its OWN capture) is the property that makes such edits testable at all.
    expect(readFileSync(join(ROOT, 'Taskfile.yml'), 'utf8')).toMatch(
      /gh workflow run vrt-update\.yml --ref "\$BRANCH"/,
    );
  });
});

// ---------------------------------------------------------------------------
// Negative controls for the scanners themselves.
// ---------------------------------------------------------------------------

describe('negative controls: the scanners can actually fail', () => {
  it('navigations() FLAGS a DB-backed literal', () => {
    const navs = navigations([['evil.spec.ts', "  await page.goto('/r/abc?invite=x');\n"]]);
    expect(navs).toEqual([
      { file: 'evil.spec.ts', line: 1, target: '/r/abc?invite=x', raw: "'/r/abc?invite=x'" },
    ]);
    expect(DB_BACKED_PREFIXES.some((p) => (navs[0].target as string).startsWith(p))).toBe(true);
  });

  it('navigations() reports a TEMPLATE target as unreadable rather than as safe', () => {
    // The blind spot, surfaced. Before this, a computed URL simply did not
    // appear in the scan at all — indistinguishable from "no navigation".
    const navs = navigations([['dyn.spec.ts', '  await page.goto(`/r/${id}`);\n']]);
    expect(navs).toHaveLength(1);
    expect(navs[0].target).toBeNull();
  });

  it('navigations() does NOT flag the capture real targets', () => {
    const navs = navigations([['ok.spec.ts', "  await page.goto('/rack?shell=legacy&seed=none');\n"]]);
    expect(navs[0].target).toBe('/rack?shell=legacy&seed=none');
    expect(DB_BACKED_PREFIXES.some((p) => (navs[0].target as string).startsWith(p))).toBe(false);
  });

  it('serverEntryPoints() walks ancestors, not just the leaf directory', () => {
    // /rack has NO server files of its own (+page.ts sets ssr = false); the
    // root +layout.server.ts is the only thing on its chain, and a scan that
    // looked only at the leaf would return an empty list and prove nothing.
    const entries = serverEntryPoints('/rack');
    expect(entries.some((f) => f.endsWith(join('routes', '+layout.server.ts')))).toBe(true);
  });
});

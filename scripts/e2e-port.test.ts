// scripts/e2e-port.test.ts
//
// scripts/e2e-port.sh is THE single derivation of a worktree's default e2e
// port (#1597) — every entry point (Taskfile targets, dev-server.sh,
// e2e/worktree-port.ts and through it the vrt/chaos/audio-drift configs)
// resolves through it, because "an isolation mechanism that only half the
// entry points honour is not isolation". These tests pin its contract:
//
//   · E2E_PORT wins, verbatim (the explicit override).
//   · Deterministic per checkout: same tree → same port on every call.
//   · The derivation actually DEPENDS on the tree's path (the perturbation
//     control — an instrument blind to the dimension under test would happily
//     return the same clean number for every worktree, which is exactly the
//     collision the script exists to remove).
//   · The formula is pinned (BASE + cksum(physical root) % RANGE), so a
//     re-implementation drift in either direction reddens here.
//   · The old shared defaults (5173 dev / 4173 preview) are OUTSIDE both
//     ranges — no worktree can derive its way back onto the collision port.
//
// The TS mirror (e2e/worktree-port.ts) is asserted to SHELL OUT to the script
// rather than re-implementing the hash — one derivation, zero drift.

import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'e2e-port.sh');

async function run(args: string[], env: Record<string, string | undefined> = {}, script = SCRIPT): Promise<string> {
  const cleaned = { ...process.env, ...env };
  // The test runner's own E2E_PORT (e.g. an agent shell exporting it) must not
  // leak into the derivation legs.
  if (!('E2E_PORT' in env)) delete cleaned.E2E_PORT;
  if (!('E2E_PREVIEW' in env)) delete cleaned.E2E_PREVIEW;
  const { stdout } = await execFileAsync('bash', [script, ...args], { env: cleaned });
  return stdout.trim();
}

/** cksum of a string, via the same POSIX tool the script uses. */
async function cksumOf(s: string): Promise<number> {
  const { stdout } = await execFileAsync('bash', ['-c', `printf %s "$1" | cksum | cut -d' ' -f1`, '_', s]);
  return Number(stdout.trim());
}

/** Copy the script into a fake checkout at `root` so its self-derived repo
 *  root IS that path — the only way to perturb the input without a test-only
 *  override knob in the production script. */
function plantScript(root: string): string {
  mkdirSync(join(root, 'scripts'), { recursive: true });
  const planted = join(root, 'scripts', 'e2e-port.sh');
  cpSync(SCRIPT, planted);
  return planted;
}

describe('scripts/e2e-port.sh (#1597)', () => {
  it('an explicit E2E_PORT wins, verbatim, in both modes', async () => {
    expect(await run([], { E2E_PORT: '5199' })).toBe('5199');
    expect(await run(['preview'], { E2E_PORT: '5199' })).toBe('5199');
    expect(await run([], { E2E_PORT: '5199', E2E_PREVIEW: '1' })).toBe('5199');
  });

  it('is deterministic and pins the exact formula (BASE + cksum(root) % 400)', async () => {
    const dev = Number(await run([]));
    const devAgain = Number(await run([]));
    expect(devAgain, 'same tree must derive the same port every call').toBe(dev);

    // Pin the formula against the PHYSICAL root, computed with the same POSIX
    // cksum the script uses. If the script's derivation drifts (base, range,
    // hash input), this is the leg that names it.
    const { stdout } = await execFileAsync('bash', ['-c', `cd "$1" && pwd -P`, '_', ROOT]);
    const physRoot = stdout.trim();
    const sum = await cksumOf(physRoot);
    expect(dev).toBe(5600 + (sum % 400));
    expect(Number(await run(['preview']))).toBe(4400 + (sum % 400));
    expect(Number(await run([], { E2E_PREVIEW: '1' })), 'E2E_PREVIEW=1 selects the preview range').toBe(
      4400 + (sum % 400),
    );
  });

  it('ranges exclude the old shared collision ports (and Postgres)', async () => {
    const dev = Number(await run([]));
    const preview = Number(await run(['preview']));
    expect(dev, 'dev range is 5600-5999 (never 5173, never 5432)').toBeGreaterThanOrEqual(5600);
    expect(dev).toBeLessThanOrEqual(5999);
    expect(preview, 'preview range is 4400-4799 (never 4173)').toBeGreaterThanOrEqual(4400);
    expect(preview).toBeLessThanOrEqual(4799);
  });

  it('PERTURBATION CONTROL: the derived port depends on the checkout path', async () => {
    // Plant the script into fake checkouts and assert each derives ITS OWN
    // formula value (proves the script reads its own location). Then the
    // headline property — perturbing the path MOVES the number — asserted on a
    // planted root chosen to be collision-free with this checkout's slot, so
    // the leg is deterministic instead of 1-in-400 flaky. If ten candidate
    // paths all landed in this tree's slot the formula itself would be the
    // suspect, and the loud failure below is the right outcome.
    const base = mkdtempSync(join(tmpdir(), 'e2e-port-'));
    const portHere = Number(await run([]));
    let moved: number | null = null;
    for (let i = 0; i < 10 && moved === null; i++) {
      const root = join(base, `tree-${i}`);
      const port = Number(await run([], {}, plantScript(root)));
      expect(port, `planted checkout ${root} must derive from ITS path`).toBe(
        5600 + ((await cksumOf(realOf(root))) % 400),
      );
      if (port !== portHere) moved = port;
    }
    expect(moved, 'a different checkout path must be able to derive a different port').not.toBeNull();
  });

  it('the TS mirror shells out to the script instead of re-implementing the hash', () => {
    const src = readFileSync(join(ROOT, 'e2e', 'worktree-port.ts'), 'utf8');
    expect(src, 'e2e/worktree-port.ts must invoke scripts/e2e-port.sh').toContain('e2e-port.sh');
    expect(src, 'no second cksum implementation').not.toContain('cksum');
  });

  it('the entry points resolve through the script (anchored to the artifacts)', () => {
    const taskfile = readFileSync(join(ROOT, 'Taskfile.yml'), 'utf8');
    // Every Taskfile consumer that used to hand-type `${E2E_PORT:-5173}` now
    // derives; a re-typed shared default is the regression this leg reddens on.
    expect(taskfile).toContain('e2e-port.sh');
    expect(taskfile, 'no Taskfile consumer may fall back to the shared 5173 again').not.toContain('E2E_PORT:-5173');
    expect(taskfile).not.toContain('E2E_PORT:-4173');
    const devServer = readFileSync(join(ROOT, 'scripts', 'dev-server.sh'), 'utf8');
    expect(devServer).toContain('e2e-port.sh');
    expect(devServer).not.toContain('E2E_PORT:-5173');
    expect(devServer).not.toContain('E2E_PORT:-4173');
  });
});

function realOf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

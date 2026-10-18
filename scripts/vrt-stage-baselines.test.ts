// Exercise the workflow's actual staging shell against a real Git fixture.
// This covers file selection/copying, not renderer correctness or PNG decoding.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const workflow = readFileSync(new URL('../.github/workflows/vrt-update.yml', import.meta.url), 'utf8');
const step = workflow.split("- name: Stage ONLY this shard's changed baselines")[1]
  ?.split('- name: Upload this shard')[0];
const body = step?.match(/run: \|\n([\s\S]+)/)?.[1];
if (!body) throw new Error('VRT staging step was not found');
// Redirect only the destination; every selection/copy command is production code.
const staging = body.replace(/^ {10}/gm, '').replaceAll('/tmp/vrt-shard-out', './staged');
const baselineRoot = 'e2e/vrt/__screenshots__';
let root: string;

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'pipe' });
}
function write(path: string, bytes: string): void {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
}
function stage(script = staging): Record<string, string> {
  execFileSync('bash', ['-c', script], { cwd: root, stdio: 'pipe' });
  const out = join(root, 'staged');
  return Object.fromEntries(readdirSync(out, { recursive: true })
    .map(String)
    .filter((path) => statSync(join(out, path)).isFile())
    .map((path) => [path, readFileSync(join(out, path), 'utf8')]));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vrt-stage-'));
  git('init', '--quiet');
  for (const name of ['changed', 'unchanged', 'deleted']) {
    write(`${baselineRoot}/existing.spec.ts/${name}.png`, name);
  }
  git('add', '.');
  git('-c', 'user.name=VRT fixture', '-c', 'user.email=vrt-fixture@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Fixture baseline');
  write(`${baselineRoot}/existing.spec.ts/changed.png`, 'new pixels');
  rmSync(join(root, baselineRoot, 'existing.spec.ts/deleted.png'));
  write(`${baselineRoot}/existing.spec.ts/new.png`, 'new scene in existing directory');
  write(`${baselineRoot}/new.spec.ts/first.png`, 'first scene');
  write(`${baselineRoot}/new.spec.ts/second.png`, 'second scene');
  write('unrelated.png', 'outside the baseline tree');
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('CI VRT baseline staging', () => {
  it('copies changed and new files, including a wholly new spec directory, without unchanged or deleted baselines', () => {
    expect(stage()).toEqual({
      [`${baselineRoot}/existing.spec.ts/changed.png`]: 'new pixels',
      [`${baselineRoot}/existing.spec.ts/new.png`]: 'new scene in existing directory',
      [`${baselineRoot}/new.spec.ts/first.png`]: 'first scene',
      [`${baselineRoot}/new.spec.ts/second.png`]: 'second scene',
    });
  });

  it('positive control: restoring directory-collapsed status loses the new spec while retaining existing-directory changes', () => {
    const old = staging.replace(' --untracked-files=all', '');
    expect(old).not.toBe(staging);
    expect(stage(old)).toEqual({
      [`${baselineRoot}/existing.spec.ts/changed.png`]: 'new pixels',
      [`${baselineRoot}/existing.spec.ts/new.png`]: 'new scene in existing directory',
    });
  });
});

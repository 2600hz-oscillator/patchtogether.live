import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

interface Job {
  if: string;
  needs?: string[];
  steps?: { name?: string; run?: string }[];
}
type Context = Record<string, unknown>;
const jobs = (file: string): Record<string, Job> =>
  parse(readFileSync(resolve(import.meta.dirname, '../.github/workflows', file), 'utf8')).jobs;
const deploy = jobs('deploy.yml');
const daily = jobs('daily-prod-deploy.yml');

// Evaluate the checked-in conditions against explicit event/result cases.
// Substitution also handles GitHub job IDs containing hyphens.
function allowed(job: Job, context: Context): boolean {
  const expression = job.if.replace(/\b(?:needs|github|inputs)(?:\.[\w-]+)+/g, (path) => {
    const value = path.split('.').reduce<unknown>((value, key) =>
      value && typeof value === 'object' ? (value as Context)[key] : undefined, context);
    return JSON.stringify(value ?? '');
  });
  return Boolean(new Function('always', 'contains', 'return (' + expression + ');')(
    () => true, (value: string, part: string) => value.includes(part),
  ));
}

describe('relay upgrades precede their web clients', () => {
  for (const tier of ['dev', 'autotest']) {
    const relay = 'deploy-relay-' + tier;
    const web = deploy['deploy-' + tier]!;
    it(tier + ': workflow graph orders relay before web', () => {
      expect(web.needs).toContain(relay);
      expect(deploy[relay]!.needs).toContain('verify-ci');
      expect(deploy[relay]!.needs).not.toContain('deploy-' + tier);
    });
    for (const result of ['success', 'failure', 'cancelled', 'skipped']) {
      it(tier + ': changed relay result ' + result, () => {
        expect(allowed(web, {
          github: { event_name: 'push', ref: 'refs/heads/main' },
          needs: { [relay]: { result }, 'relay-changed': { result: 'success', outputs: { changed: 'true' } } },
        })).toBe(result === 'success');
      });
      it(tier + ': manual relay requires exact-commit CI result ' + result, () => {
        expect(allowed(deploy[relay]!, {
          github: { event_name: 'workflow_dispatch', event: { inputs: { target: tier } } },
          needs: { 'verify-ci': { result } },
        })).toBe(result === 'success');
      });
    }
    for (const detection of ['success', 'failure']) {
      it(tier + ': skipped relay with change detection ' + detection, () => {
        expect(allowed(web, {
          github: { event_name: 'push', ref: 'refs/heads/main' },
          needs: { [relay]: { result: 'skipped' }, 'relay-changed': { result: detection, outputs: { changed: 'false' } } },
        })).toBe(detection === 'success');
      });
    }
  }

  it('production graphs order relay before web and recording the release', () => {
    expect(deploy['deploy-prod']!.needs).toContain('deploy-relay-prod');
    expect(daily['deploy-web']!.needs).toContain('deploy-relay');
    expect(daily['deploy-relay']!.needs).not.toContain('deploy-web');
    expect(daily.record!.needs).toContain('deploy-web');
  });

  for (const result of ['success', 'failure', 'cancelled', 'skipped']) {
    it('version-bump production relay result ' + result, () => {
      expect(allowed(deploy['deploy-prod']!, {
        github: { event_name: 'push', ref: 'refs/heads/main' },
        needs: { 'detect-version-bump': { outputs: { bumped: 'true' } }, 'deploy-relay-prod': { result } },
      })).toBe(result === 'success');
    });
    for (const changed of ['true', 'false']) {
      it('nightly relay result ' + result + ', changed ' + changed, () => {
        expect(allowed(daily['deploy-web']!, {
          inputs: { dry_run: false },
          needs: { 'find-green': { outputs: { found: 'true', changed: 'true', relay_changed: changed } }, 'deploy-relay': { result } },
        })).toBe(result === 'success' || (result === 'skipped' && changed === 'false'));
      });
    }
  }

  for (const dryRun of [true, false]) {
    for (const changed of ['true', 'false']) {
      it('nightly relay dry run ' + dryRun + ', changed ' + changed, () => {
        expect(allowed(daily['deploy-relay']!, {
          inputs: { dry_run: dryRun },
          needs: { 'find-green': { outputs: { found: 'true', changed: 'true', relay_changed: changed } } },
        })).toBe(!dryRun && changed === 'true');
      });
    }
  }

  for (const [name, job] of [
    ...Object.entries(deploy).filter(([name]) => name.startsWith('deploy-relay-')),
    ['nightly relay', daily['deploy-relay']!] as const,
  ]) {
    it(name + ': missing credentials fail before invoking the deployment CLI', () => {
      const script = job.steps?.find((step) => step.run?.includes('flyctl deploy'))?.run;
      expect(script).toBeTruthy();
      // The sentinel fails differently, proving the credential guard stopped
      // the script. No external command or deployment is performed.
      const result = spawnSync('bash', ['-c', 'flyctl() { echo unexpected-deploy; return 99; }\n' + script], {
        env: { PATH: process.env.PATH, FLY_API_TOKEN: '' }, encoding: 'utf8',
      });
      expect(result.status).toBe(1);
      expect(result.stdout).not.toContain('unexpected-deploy');
      const permitted = spawnSync('bash', ['-c', 'flyctl() { echo simulated-deploy; return 0; }\n' + script], {
        env: { PATH: process.env.PATH, FLY_API_TOKEN: 'test-only-token' }, encoding: 'utf8',
      });
      expect(permitted.status).toBe(0);
      expect(permitted.stdout).toContain('simulated-deploy');
    });
  }
});

// scripts/webgl-cotenancy.test.ts
//
// THE PRE-FLIGHT ONLY EVER SAMPLED AT START.
//
// `webgl:attest`'s quiet-machine guard is correct at t=0 — it refused with a
// browser at 38 % GPU and accepted at 21 %. But load ARRIVING MID-RUN was
// invisible to it, and surfaced as TEST FAILURES rather than an abort:
// `Pass A-heavy: 30 failed`, every one in wavesculpt.spec.ts, on a branch that
// does not touch wavesculpt. That spec passes 17/17 in ~36 s on clean main and
// on the PR's own tree. It was contention, wearing a regression's clothes.
//
// ⚠ THE MID-RUN SAMPLER CANNOT REUSE THE PRE-FLIGHT PREDICATE, and this is the
// single thing most worth testing here. The pre-flight's name matching is sound
// at t=0 *because we have not spawned chromium yet*, so anything matching is
// somebody else's. The moment the run starts that premise dies: Playwright's own
// browsers ARE Chromium and match `Chromium` / `Helper (Renderer)` exactly like
// a co-tenant. A sampler reusing the pre-flight predicate would flag ITSELF and
// abort every run — a guard that fires always is as useless as one that never
// fires, and considerably more annoying.
//
// So `foreignCoTenants` excludes the attest's own PID and its descendants, and
// `EXCLUDES our own chromium subtree` below is the negative control for exactly
// that. It is paired with a positive control (a genuine foreign co-tenant IS
// reported) so an implementation returning [] unconditionally cannot pass.
//
// ── WHAT THESE TESTS DO NOT COVER ───────────────────────────────────────────
//  · The watchdog's KILL path (spawn → sustained samples → SIGTERM → exit 3) is
//    not exercised: it needs a real multi-minute Playwright pass. What IS
//    covered is the predicate that decides whether to fire, in both directions,
//    plus a leg run against the REAL process table so the fixtures cannot drift
//    away from what `ps` actually emits.
//  · Nothing here runs an attest, and nothing here touches the GPU.

import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import {
  parsePs,
  selfSubtree,
  foreignCoTenants,
  formatCoTenants,
  parseListeners,
  leakedServers,
  COTENANT_RE,
} from './webgl-cotenancy';

/** `ps -A -o %cpu=,pid=,ppid=,comm=` — real shapes, taken from a live machine. */
const PS_FIXTURE = [
  '  0.0     1     0 /sbin/launchd',
  ' 42.9   500     1 /Applications/Discord.app/Contents/Frameworks/Discord Helper (Renderer).app/Contents/MacOS/Discord Helper (Renderer)',
  '  0.0   501   500 /Applications/Discord.app/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler',
  ' 12.0   900     1 /usr/bin/node',
  ' 30.0   901   900 /Users/x/ms-playwright/chromium-1234/chrome-mac/Chromium.app/Contents/MacOS/Chromium',
  ' 25.0   902   901 /Users/x/ms-playwright/chromium-1234/Chromium Helper (Renderer).app/Contents/MacOS/Chromium Helper (Renderer)',
  '  3.0   903     1 /System/Library/CoreServices/Dock.app/Contents/MacOS/Dock',
].join('\n');

describe('ps parsing', () => {
  it('keeps the WHOLE remainder as the name — paths contain spaces', () => {
    // ⚠ A 4-way split truncates "Discord Helper (Renderer)" to "Discord",
    // losing the `Helper (Renderer)` token that the renderer-not-brand matching
    // depends on. Only the first three fields are whitespace-delimited.
    const rows = parsePs(PS_FIXTURE);
    const discord = rows.find((r) => r.pid === 500)!;
    expect(discord.name).toContain('Discord Helper (Renderer)');
    expect(discord.cpu).toBe(42.9);
    expect(discord.ppid).toBe(1);
  });

  it('ignores blank and malformed lines rather than emitting NaN rows', () => {
    const rows = parsePs('\n   \nnot a ps line\n  1.5   7   1 /bin/thing\n');
    expect(rows).toEqual([{ cpu: 1.5, pid: 7, ppid: 1, name: '/bin/thing' }]);
  });
});

describe('subtree ownership', () => {
  it('collects transitive descendants, not just direct children', () => {
    // 900 → 901 → 902. A one-level check would miss the renderer, which is the
    // process that actually burns GPU.
    const mine = selfSubtree(parsePs(PS_FIXTURE), 900);
    expect([...mine].sort((a, b) => a - b)).toEqual([900, 901, 902]);
  });

  it('terminates on a pid cycle instead of hanging', () => {
    const rows = parsePs(['  1.0  10  11 /a', '  1.0  11  10 /b'].join('\n'));
    expect([...selfSubtree(rows, 10)].sort()).toEqual([10, 11]);
  });
});

describe('foreignCoTenants — the mid-run predicate', () => {
  it('EXCLUDES our own chromium subtree (the whole reason this exists)', () => {
    // Pretend we are pid 900: the Chromium at 901 and its renderer at 902 are
    // OURS. Both match COTENANT_RE by name and both are over the CPU floor, so
    // a name-only predicate would report them and abort every run.
    const found = foreignCoTenants(parsePs(PS_FIXTURE), 900, 25);
    expect(found.map((r) => r.pid), 'our own browsers must never count as co-tenants').not.toContain(901);
    expect(found.map((r) => r.pid)).not.toContain(902);
  });

  it('POSITIVE CONTROL: a genuine foreign co-tenant IS still reported', () => {
    // Without this, an implementation that returned [] for everything would
    // pass the exclusion test above perfectly.
    const found = foreignCoTenants(parsePs(PS_FIXTURE), 900, 25);
    expect(found.map((r) => r.pid)).toContain(500);
    expect(formatCoTenants(found)[0]).toBe('43% Discord Helper (Renderer)');
  });

  it('respects the CPU floor in both directions', () => {
    // Discord at 42.9 is over a 25 floor and under a 50 floor. The floor is
    // what separates "a backgrounded tab idling" from "a real contender".
    expect(foreignCoTenants(parsePs(PS_FIXTURE), 900, 25).map((r) => r.pid)).toContain(500);
    expect(foreignCoTenants(parsePs(PS_FIXTURE), 900, 50).map((r) => r.pid)).not.toContain(500);
  });

  it('ignores non-GPU processes however busy they are', () => {
    // Dock is at 3 % and would be excluded by the floor anyway; raise it and it
    // must STILL be ignored, because it is not a GPU client we care about.
    const rows = parsePs('  99.0   903     1 /System/Library/CoreServices/Dock.app/Contents/MacOS/Dock');
    expect(foreignCoTenants(rows, 900, 25)).toEqual([]);
  });

  it('matches the RENDERER, not the brand', () => {
    // The regression that motivated the current regex: Discord's compositing
    // renderer has no "Electron"/"Chromium"/"Chrome" anywhere in its path.
    expect(COTENANT_RE.test('/Applications/Foo.app/Contents/MacOS/Foo Helper (Renderer)')).toBe(true);
    expect(COTENANT_RE.test('/usr/bin/some-random-daemon')).toBe(false);
  });

  it('AGAINST THE LIVE PROCESS TABLE: never reports this very process', () => {
    // Fixtures can drift away from what `ps` actually prints. Run the real
    // command, and assert the one thing that must hold on any machine: our own
    // subtree is never in the result. (This node process matches nothing by
    // name today, so the assertion is about the parse surviving reality.)
    const rows = parsePs(execSync('ps -A -o %cpu=,pid=,ppid=,comm=', { encoding: 'utf8' }));
    expect(rows.length, 'the live ps parse returned nothing — the -o format changed').toBeGreaterThan(0);
    const found = foreignCoTenants(rows, process.pid, 25);
    const mine = selfSubtree(rows, process.pid);
    expect(found.filter((r) => mine.has(r.pid))).toEqual([]);
  });
});

describe('leaked dev servers from other checkouts', () => {
  const LSOF = ['p111', 'nlocalhost:5173', 'p222', 'n127.0.0.1:4173', 'p333', 'n*:8080'].join('\n');

  it('parses the -F pid/name stream, carrying the pid down', () => {
    expect(parseListeners(LSOF)).toEqual([
      { pid: 111, port: 5173 },
      { pid: 222, port: 4173 },
      { pid: 333, port: 8080 },
    ]);
  });

  it('reports a SIBLING worktree and not our own checkout', () => {
    const root = '/repo/inet.modular/.claude/worktrees/agent-mine';
    const cwds: Record<number, string> = {
      111: '/repo/inet.modular/.claude/worktrees/agent-other/packages/web',
      222: `${root}/packages/web`,
      333: '/somewhere/unrelated-project',
    };
    const leaked = leakedServers(parseListeners(LSOF), root, (pid) => cwds[pid] ?? null);
    expect(leaked.map((l) => l.pid), 'only the sibling worktree is leaked').toEqual([111]);
    expect(leaked[0].port).toBe(5173);
  });

  it('tolerates a pid whose cwd cannot be read', () => {
    const leaked = leakedServers(parseListeners(LSOF), '/repo/x', () => null);
    expect(leaked).toEqual([]);
  });
});

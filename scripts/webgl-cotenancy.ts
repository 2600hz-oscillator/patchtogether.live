// scripts/webgl-cotenancy.ts
//
// WHO ELSE IS ON THIS GPU — sampled BEFORE and DURING a real-GPU attest.
//
// The attest drives one Metal/ANGLE context. A co-tenant GPU client (a browser,
// an Electron app, a leaked vite dev server) steals cycles from it, renders slow
// down, and a DIFFERENT one or two timing-sensitive WebGL specs stall on each
// saturated run. That surfaces as TEST FAILURES, which read exactly like a
// regression and get diagnosed as one.
//
// ⚠ THE PRE-FLIGHT ONLY EVER SAMPLED AT START, AND THAT IS THE BUG THIS MODULE
// EXISTS FOR. It correctly refused at 38 % co-tenant CPU and correctly accepted
// at 21 % — but load ARRIVING MID-RUN is invisible to a single sample at t=0.
// Measured: `Pass A-heavy: 30 failed`, every one in wavesculpt.spec.ts, on a
// branch that does not touch wavesculpt — and that spec passes 17/17 in ~36 s
// on clean main AND on the PR's own tree. Contention, reported as a regression.
//
// ── WHY THE MID-RUN SAMPLE NEEDS ANCESTRY, NOT JUST A NAME ──────────────────
// The pre-flight's name matching is sound at t=0 precisely because WE have not
// spawned chromium yet, so anything matching is somebody else's. That premise
// DIES the moment the run starts: Playwright's own browsers are Chromium, and
// they match `Chromium` and `Helper (Renderer)` exactly like a co-tenant would.
// A mid-run sampler reusing the pre-flight predicate would therefore flag ITSELF
// and abort every single run.
//
// So `foreignCoTenants` walks the process tree and excludes the attest's own
// PID and everything descended from it. What remains is genuinely someone else.
//
// ⚠ AND THE LOAD-AVERAGE LEG CANNOT BE CARRIED ACROSS EITHER, for the same
// reason in a different shape: our own parallel workers ARE the load. Pre-flight
// keeps `load1 > cores/2`; the mid-run sampler deliberately does NOT, and reads
// only attributable per-process CPU. That is a real narrowing of what the
// mid-run check can see, and it is the honest one — a load figure we are
// ourselves generating cannot distinguish us from a co-tenant.

export interface PsRow {
  cpu: number;
  pid: number;
  ppid: number;
  name: string;
}

/** ⚠ MATCH THE RENDERER, NOT THE BRAND. This list was brand-only once and MISSED
 *  a measured 42.9 % co-tenant: Discord's GPU-compositing renderer lives at
 *    /Applications/Discord.app/…/Discord Helper (Renderer).app/…
 *  with no "Electron", "Chromium" or "Chrome" anywhere in the path. (Its crashpad
 *  handler DOES say "Electron Framework" and sits at 0.0 %, so the one process
 *  the old regex could see was the one that never touches the GPU.)
 *
 *  `Helper \(Renderer\)` is the generic Chromium multi-process renderer name
 *  EVERY Electron app ships, so it catches the next one without another brand
 *  being added. Brands are kept for the non-Electron cases and as belt-and-braces. */
export const COTENANT_RE =
  /Google Chrome|Microsoft Edge|Safari|Chromium|firefox|Brave|Electron|Discord|Slack|Helper \(Renderer\)|Patchtogether\.app|Spotify/i;

/** Parse `ps -A -o %cpu=,pid=,ppid=,comm=`.
 *
 *  ⚠ THE NAME IS THE REST OF THE LINE, NOT THE FOURTH FIELD. Process paths
 *  contain spaces — "Microsoft Edge Helper (Renderer)" is four words on its own
 *  — so a naive 4-way split truncates exactly the renderer processes this module
 *  most needs to see. Only the first three fields are whitespace-delimited. */
export function parsePs(out: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const raw of out.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(\S+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const cpu = parseFloat(m[1]);
    if (!Number.isFinite(cpu)) continue;
    rows.push({ cpu, pid: Number(m[2]), ppid: Number(m[3]), name: m[4] });
  }
  return rows;
}

/** Every pid descended from `rootPid`, plus `rootPid` itself. */
export function selfSubtree(rows: PsRow[], rootPid: number): Set<number> {
  const childrenOf = new Map<number, number[]>();
  for (const r of rows) {
    const list = childrenOf.get(r.ppid);
    if (list) list.push(r.pid);
    else childrenOf.set(r.ppid, [r.pid]);
  }
  const seen = new Set<number>([rootPid]);
  const stack = [rootPid];
  while (stack.length) {
    for (const child of childrenOf.get(stack.pop()!) ?? []) {
      if (seen.has(child)) continue; // defensive: a pid cycle would otherwise hang
      seen.add(child);
      stack.push(child);
    }
  }
  return seen;
}

/** GPU co-tenants that are NOT us: name matches, CPU at or above `minCpu`, and
 *  the process is outside our own subtree. Sorted heaviest first. */
export function foreignCoTenants(rows: PsRow[], selfPid: number, minCpu: number): PsRow[] {
  const mine = selfSubtree(rows, selfPid);
  return rows
    .filter((r) => !mine.has(r.pid) && r.cpu >= minCpu && COTENANT_RE.test(r.name))
    .sort((a, b) => b.cpu - a.cpu);
}

/** Short, human-readable rendering: `43% Discord Helper (Renderer)`. */
export function formatCoTenants(rows: PsRow[]): string[] {
  return rows.map((r) => `${r.cpu.toFixed(0)}% ${r.name.split('/').pop()}`);
}

/** A vite/dev server left listening by ANOTHER checkout.
 *  `worktree:guard` classifies an idle worktree as abandoned and removes it, but
 *  it does not stop a dev server that worktree started — so a leaked server can
 *  sit there compiling and serving while an attest tries to have the machine to
 *  itself. `cwd` is what identifies it, exactly as in scripts/dev-server.sh. */
export interface LeakedServer {
  pid: number;
  port: number;
  cwd: string;
}

/** Parse `lsof -nP -iTCP -sTCP:LISTEN -Fpn` into { pid, port } pairs.
 *  The -F format is a stream of `p<pid>` records each followed by `n<addr>`
 *  lines, so the current pid is carried down until the next `p`. */
export function parseListeners(out: string): { pid: number; port: number }[] {
  const found: { pid: number; port: number }[] = [];
  let pid = 0;
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) {
      pid = Number(line.slice(1)) || 0;
      continue;
    }
    if (line.startsWith('n') && pid) {
      const m = /:(\d+)$/.exec(line.trim());
      if (m) found.push({ pid, port: Number(m[1]) });
    }
  }
  return found;
}

/** Which listeners belong to a checkout OTHER than `repoRoot`.
 *  `cwdOf` is injected so this is testable without real processes. */
export function leakedServers(
  listeners: { pid: number; port: number }[],
  repoRoot: string,
  cwdOf: (pid: number) => string | null,
): LeakedServer[] {
  const out: LeakedServer[] = [];
  const seen = new Set<number>();
  for (const l of listeners) {
    if (seen.has(l.pid)) continue;
    seen.add(l.pid);
    const cwd = cwdOf(l.pid);
    if (!cwd) continue;
    // Only worktrees of THIS repo — an unrelated project's server on the box is
    // a co-tenant question (handled by CPU above), not a leaked-worktree one.
    if (!/[/]\.claude[/]worktrees[/]/.test(cwd) && !cwd.includes('inet.modular')) continue;
    if (cwd === repoRoot || cwd.startsWith(repoRoot + '/')) continue;
    out.push({ pid: l.pid, port: l.port, cwd });
  }
  return out;
}

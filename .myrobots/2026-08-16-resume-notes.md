# 2026-08-16 — resume notes: the load crash, and everything suspended mid-flight

Written after the machine was driven into the ground. Owner: *"whatever you just
did absolutely killed the system… figure out what happened and what rules we need
to avoid it."* Everything except the mixmstrs work is suspended; this file is the
handoff.

---

## 1. What actually happened

**Measured after the fact:**

```
load averages: 5.83 (1m)  21.18 (5m)  25.02 (15m)
hw.ncpu = 10
```

**Sustained ~2.5× oversubscription on a 10-core machine.** Not a spike — the 15
minute average is the highest of the three, so it had been pinned for a while and
was already recovering by the time it was measured.

Also standing at the time: **9 worktrees / 6.6 GB of `node_modules`**, and 4
leftover `node`/`workerd` listeners.

### The mechanism

Three agents were live concurrently, and each one independently runs a
**process-multiplying** workload:

| per agent | what it spawns |
|---|---|
| `npm install` in a fresh worktree | dozens of parallel extractions |
| a dev server | vite + a `workerd` preview server |
| `vitest` | one worker per core by default |
| Playwright e2e | multiple workers, each a browser + renderer |
| ART / VRT | more browsers, SwiftShader software rasterisation |

On top of that, at the same moment: a **VRT capture** dispatch, my own
`task webgl:attest` attempts (which want the GPU *solo*), and the owner's own
Edge session.

⚠ **The 2-agent guidance was never the binding constraint — the WORKLOAD SHAPE
was.** Two agents doing scoped unit runs is nothing; three agents each running a
suite is 30+ processes. The cap counted the wrong thing.

### Contributing factors seen earlier the same day

- **Leaked `workerd` preview servers** from finished agents and from deleted
  worktrees. `task e2e:stop` could NOT see them — it only knows its own port
  (it reported "nothing to stop for mode=dev (port 5669)" while three servers
  ran on 51231 / 52741 / 58026). They were only found because the
  `webgl:attest` pre-flight refused and named them.
- **Two agents stalled on long silent commands** (a 25-min sweep, a 40-min VRT
  capture) and were killed by the 600 s watchdog — while still holding their
  processes.

---

## 2. Rules to adopt

1. **Cap by WORKLOAD, not agent count.** At most **ONE** agent may be in a heavy
   phase (`npm install`, any e2e/ART/VRT run, a full unit suite) at a time.
   Others must be reading/editing//scoped-unit only. Two agents are fine; two
   agents both running Playwright are not.
2. **Never run `webgl:attest` or `collab:attest` while any agent is live.** Both
   want the machine quiet; the attest pre-flight already refuses, which is a
   guard to respect rather than route around. ⚠ Never set
   `WEBGL_ATTEST_ALLOW_BUSY=1`.
3. **Fresh-worktree `npm install` is the single heaviest step — stagger it.**
   Do not start two worktree agents in the same minute.
4. **Sweep leaked servers before and after any agent batch.** `task e2e:stop` is
   NOT sufficient (see above). Check `lsof -nP -iTCP -sTCP:LISTEN | grep -E
   'node|workerd'` and kill orphans by pid. **Worth a task target: a repo-wide
   `dev-servers:sweep` that finds every listener whose cwd is under this repo.**
5. **Never block silently on a long command.** A VRT capture is 37–54 min and the
   sweep is 25–45 min; the agent watchdog kills at 600 s of silence. Dispatch,
   then keep working, or poll with output.
6. **Prune worktrees aggressively.** 9 worktrees × ~700 MB is 6.6 GB and every one
   is a potential server host. Remove on merge, not "later".
7. **Watch the 5/15-minute load averages, not the 1-minute.** The 1-minute
   reading was 5.83 while the box was still recovering from 25.

---

## 3. ✅ DONE — mixmstrs MERGED by the owner

**PR #1738 — MERGED 2026-08-16T17:56:48Z. Faces on main: 47.**

Owner: *"1738 looks great now and is good to merge as is"*, then merged it
themselves. Nothing outstanding on it.

Original notes kept below because the parking story is the reusable part:

- Head `d0e5216b`, marked ready for review (was draft).
- ⚠ It was **parked**: the branch head was the `vrt-baseline-bot` commit, so CI /
  Deploy / VRT-gallery were all `action_required` (#1694). The golden re-pin
  commit on top un-parked them.
- Contents: the owner's four review items, the **drawer height control (#1767)**,
  a `[hidden]` console-band fix, main merged, and the bot's baselines.
- ⚠ The bot committed **4** files: 2 new (`face-mixmstrs-{compact,dock}`) and **2
  MODIFIED** — `face-kickdrum-dock` and `face-tidyVco-dock`. That is the
  shared-chrome change moving other faces' baselines, which is expected.
- Counter re-pinned on the merged tree: **46 → 47**, derived. `face:inventory`
  19/19, `docs:check` 14/14 — confirmed on `main` after the merge.

⚠ **Sweep the other open PRs for conflicts this merge created** — it touched the
shared face-registry files (`strict-faces.ts`, `face-readout-values.ts`,
`_shell-faces.ts`, `face-migration.generated.md`) AND the shared dock chrome, and
it moved two OTHER faces' baselines. `flox activate -- task pr:conflict-sweep`.

---

## 4. SUSPENDED — pick up tonight

### PR #1770 — toybox custom-shader params (#1708) · BLOCKED ON A GPU ATTEST
- Branch `feat/toybox-custom-shader-params`. All gates green locally.
- ⚠ **Needs `flox activate -- task webgl:attest`.** Hash on the merged tree was
  `8f22e121cbd8459e588d8d39015280188ac7e5dfe9a3cb0d73ece345aadd68f3` — **re-check
  it**, main has moved since. The pre-flight refused because the owner's **Edge**
  was at 38.5 % sustained; do not kill their browser, wait for a quiet machine.
- What it does: `resolveLayerContent(layer)` is the one seam every consumer reads,
  so a disk-loaded shader gets faders / CV targets / (later) randomize targets.
  Registration is **observation-driven**, not pick-driven — the card's pick-time
  call was deleted, because keeping it makes the picking peer pass a test the
  receiving peer fails.
- It **refuted the issue's suggested fix**: also injecting the extracted names
  into the wrapper is a duplicate global declaration and **ANGLE rejects it** —
  proven with a `@webgl-smoke` test rather than argued.
- **Randomize targets come free**: they will read
  `resolveLayerContent(…).meta.params`.

### Issue #1769 (P0, partially fixed) — cv-param-reach cost
### ⚠ OWNER DIRECTION (2026-08-16): *"we don't really want anything that long running"*

**45 minutes is an emergency unblock, NOT a target.** The agreed plan, cheapest
lever first:

1. **SHARD IT.** The job is main-only and embarrassingly parallel — 220
   independent per-port renders. Five shards ≈ **5 min each**. This is the real
   answer and costs only a matrix. **Start here.**
2. Skip NAMED `render-not-reproducible` modules unconditionally (reclaims
   wavesculpt ~109 s, makes the cost deterministic rather than coin-flip).
3. `snaredrum` at 145.6 s / 21 ports is the largest single line — look for a
   cheaper drive.

With 1 + 2 the cap should come down to **~10 min**, which is a real bound rather
than a shrug. ⚠ Do not leave the cap at 45 as the end state.

- **#1768 MERGED**: cap 25 → 45 min. That un-blocked main from reporting
  `cancelled` forever, which had **silently blocked the nightly PROD deploy**
  (`find-green` disqualifies any job that is not success/skipped/null).
- ⚠ **The first 45-min run then completed as `failure`** — a real verdict at last.
  **Nobody has read that failure yet. Read it first.** Run 31958987489.
- **The durable fix is NOT done.** The agent stalled running the full sweep. The
  lever, identified by #1669's author and deliberately left: *skip per-port
  renders for any module NAMED `render-not-reproducible`*, exactly as
  `harness-cannot-materialize` already does — reclaims wavesculpt's ~109 s
  **unconditionally** and makes the cost deterministic instead of coin-flip.
  ⚠ Do **not** delete the reproducibility leg (#1680: off-thread renders + a
  `setInterval` pump make wavesculpt/cloudseed/cube racy). `snaredrum` is the
  largest remaining line at 145.6 s / 21 ports.
  ⚠ **Do not run the sweep to measure it** — read
  `[cv-param-reach] slowest: …` out of the CI logs instead.

### Q19 `analogLogicMaths` faceplate — not started
- Agent was spawned and stopped before doing anything; branch
  `feat/faceplate-analoglogicmaths` may not exist.
- Spec: queue file § Q19 (~line 1302). ⚠ *"§9's verdict, CORRECTED"* — it was
  once rejected on merit and that was withdrawn; understand why first.
- ⚠ Its discrete sibling `illogic` (#1758) shipped a defect **at exactly its
  declared threshold** (four gates sampled 0.49 and 0.51, none sampled 0.5). If
  this module has a threshold/comparator/fold point, **sample it AT the value**.

### Queue after that
Q20 `moog923`, Q21 `moog905`, both spec'd. Faces stand at **46 on main**, 47 once
#1738 lands.

---

## 5. Open owner items

- **#1759 (merged) wants a hardware check** — only the owner can confirm the
  Launchpad surface stays lit through a real collapse.
- **#1739** — the `m` tray needed a third `drawer` view; #1738 carries it.
- **#1704** — owner ruled *fix and attest, no audition* for RING; that DSP change
  is still unbuilt.
- **#1767** — the drawer height control, built in #1738.

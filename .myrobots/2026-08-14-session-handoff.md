# Session handoff — 2026-08-14 (~00:40 ET), shutting down at owner request near session limit

State written for the NEXT session. Verify claims against the board before acting; PRs may
have gone green (or red) after this was written.

## Open PRs — 3, all expected green; MERGE ON GREEN

| PR | what | state at handoff | notes |
|---|---|---|---|
| **#1601** | `perf/ci-critical-path` — vrt-strict sharded 4×, build-web unhooked (#1595) | 0F, mid-CI | Two guard failures were fixed in `0ce1fa22` (die-mute timeout 600s; NUL escaped in vrt-shard-plan.mjs; `.ci-measure/` residue removed). **After merge: measure a real run against the 19.8→~17.7 min projection and post to #1595.** |
| **#1603** | `fix/layers-spec-settled-sampling` — the board's top flake fixed (#1589 spec) | 0F, mid-CI | Sampled the collapse TRANSITION; now pins to the PARKED element. **Merge this FIRST, then merge main into #1598** — its 2F are this exact flake. |
| **#1598** | `fix/wavesculpt-timelorde-producer-lifetime` (#1587) | 2F (both = the #1603 flake) | WebGL attestation `27479e86…` is committed on the branch and valid. After #1603 lands: `git merge origin/main`, push, should go green. Its producer set includes **synesthesia** — verify #1590's latched-gate symptom before closing that row. |

## In-flight agent workflow (DIES with this session — recover from worktrees/branches)

Workflow `whcffqcwy` had 4 agents on: **#1597** (attest server identity), **#1500**
(collab-nightly), **#1499** (e2e typecheck), **#1549** (svelte-check warnings, salvaging
worktree `wf_77318311-e2d-2`). The #1597 agent's task list showed steps 1–5 of 7 COMPLETE
(identity endpoint, port derivation, attest wiring, consumer coherence) with tests/verify
remaining — branch `fix/attest-server-identity`. On resume: check `git worktree list` +
`git ls-remote origin` for their branches; salvage per the pattern that worked twice today
(tab-focus #1599 and ci-critical-path #1601 were both finished from dead agents' trees —
verify yourself, never trust the dead agent's unreported claims).

## Merged this session (2026-08-13, 38 PRs total)

The whole collapse/unmount P0 wave: #1573 dock tray · #1574 recorderbox · #1585 editors ·
#1588 samsloop · #1589 toybox+export guard · #1590-skifree · #1508 Tab focus (rack-flip →
F) · #1592/#1594 attest classifier (deny-by-default skips) · #1582 clipplayer unsoundness ·
#1581 migration inventory · plus the timings enrollment (#1600 filed for the accept loop).

## Do-next queue (all non-legacy, per owner's path)

1. Merge-on-green the 3 PRs above (order: 1603 → 1598-refresh → 1601).
2. Recover the 4 agent branches (#1597 first — it is a P0 gate-integrity fix).
3. **#1590 remainder**: audioIn (irreversible `t.stop()` — needs registry/re-acquire) +
   doom (LRU evict freezes every peer) + verify synesthesia via #1598.
4. #1512 extension registry — the legacy report (`.myrobots/2026-08-13-legacy-closeout-explanation-for-owner.md`)
   says re-label P0; it gates 50 bespoke faces. #1515 LEG-04 guard is the cheapest
   compounding-cost item on the board.
5. #1600 timings accept loop; #1569 flaky-tail remainder; #1523 waitForTimeout burn-down.

## Environment facts that will bite otherwise

- **Local Postgres** for collab attests: cluster at scratchpad `pgdata`, port **54320**
  (`postgresql://postgres@localhost:54320/patchtogether_test`). May need
  `pg_ctl -D <dir> -o "-p 54320 -k /tmp" -l <dir>/pg.log start` after reboot.
- **Never let anything default to port 5173** — sibling worktree servers get silently
  adopted (`reuseExistingServer`), and the attest then tests the WRONG TREE (#1597,
  memory: attest-reuses-sibling-worktree-server). Explicit `E2E_PORT` per agent, always.
- The attest pre-flight's "leaked servers" list includes **multi-day orphaned `workerd`
  daemons** — `pkill -f workerd-darwin-arm64` clears them; low pids are NOT recent.
- Worktrees at 7/10 after cleanup. `fix/typecheck-warning-gate` worktree
  (`wf_77318311-e2d-2`, 45 dirty + 1 unpushed) is the #1549 salvage — do not remove.
- Crons: both killed at owner request. No loop is armed.

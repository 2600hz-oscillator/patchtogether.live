# Three things salvaged from a destroyed macrooscillator worktree — 2026-08-08

The macrooscillator face shipped in **#1432**, and the engine measurements this file once carried
were re-derived at build time and now live in `face-specs-batch-3-macrooscillator.md` (which
corrects several of them). Three items are NOT recorded anywhere else.

## 1. Never `--force` a worktree removal

An agent had a substantially complete, green macrooscillator face build in an isolation worktree —
32/32 unit, all 13 e2e rows, typecheck clean — **uncommitted and unpushed**. I removed the worktree
with `git worktree remove --force` while triaging unauthorized agents, without checking whether it
was dirty. `task worktree:guard` exists to refuse exactly that, and `--force` skips it. The code
was unrecoverable.

**Run `task worktree:clean`, which removes only checkouts that are clean AND pushed. If it
refuses, that refusal is the point.**

## 2. An 85 ms liveness window reported three live macros as bit-exactly dead

A 4096-sample window declared all three MODAL macros dead. They are not — **the window was shorter
than MODAL's own 250 ms impulse period**. Fixed at 15360 samples (320 ms), with the false reading
pinned as a permanent negative-control leg. Textbook "the instrument was blind to the dimension
under test": the number was clean, authoritative and wrong, and nothing about its output said so.

## 3. Two layout constraints, measured on the shell

- A strike button on its own row overflowed the 1u card by **30.2 CSS px**. The card has ~8 px of
  slack — a button like that must **share the engine-name row**.
- The dock sidebar overflowed **78 CSS px horizontally** (1298 vs 1220) on long flow notes and axis
  nouns. The sidebar content column is **258 px**; keep readout values under **~26 characters**.

*(The fourth item this file carried — that `bootWithFace` never froze the AudioContext, so no
free-running module could hold a faceplate baseline — was fixed in #1420.)*

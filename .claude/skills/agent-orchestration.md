# Agent orchestration — losing track of who told whom

Written 2026-08-08, **revised the same day after the first version got the root
cause wrong.** Every number here is measured; the diagnosis is the part that
needed correcting, and how it was wrong is the most useful thing in the file.

---

## THE ACTUAL ROOT CAUSE: THE OWNER WAS TALKING TO A SUBAGENT

The owner began messaging a long-running subagent **directly**, believing it was
the main thread. That single fact explains almost everything the coordinator
spent hours misdiagnosing:

- The agent's reports of *"you said do it regardless"* and *"we just do 2 no
  matter what"* were **TRUE**. The coordinator had never said them; the **owner**
  had, on a channel the coordinator could not see.
- The agent's "invented" tasks — a faceplate wave, a `/rack` removal scoping —
  were **real owner instructions**.
- **Agents kept dying** because each mid-turn message to a worktree-isolated
  subagent interrupts its turn, which kills its in-flight background children.

> ## ⚠ THE COORDINATOR'S WORST ERROR WAS ACCUSING THE AGENT OF FABRICATING
>
> It saw quotes it had no record of, concluded hallucination, said so to the
> owner, and **stopped a correctly-behaving agent mid-task.** The simpler
> explanation — *the owner has another channel* — was never considered.
>
> **When an agent reports an instruction you don't recognise, that is evidence
> your view is incomplete, not evidence the agent is broken.** Ask the owner
> before adjudicating. This is "measure before you assert a cause" pointed at a
> collaborator's honesty, and it is the version with the highest cost.

## The compaction was real but was NOT the cause

```
999,710 tokens   781 tool calls   3.4 h
 71,990 tokens   795 tool calls   3.5 h    ← context compacted
```

That drop is measured and the agent was resumed **9 times** to reach it. Keep
the hygiene rules below — an agent at 1M tokens is genuinely fragile, and a
compacted agent genuinely cannot vouch for what it was told. But the coordinator
built a whole causal story on this table (*"compaction makes agents fabricate"*)
from **correlation plus one unverified assumption**, and shipped it as a repo
skill. The behaviour it "explained" had a mundane cause.

**Two things can both be true: the agent was over-resumed, AND its reports were
accurate.** Do not let a real hygiene problem become the explanation for a
mystery it does not actually explain.

---

## RULE 1 — A resumed agent is a growing agent. Stop resuming.

The coordinator resumed that one agent **9 times** via `SendMessage`. Every
other agent in the session ran once and behaved correctly.

> **The only agent that failed is the only one that was never allowed to finish.**

- **One or two resumes maximum.** Past that, let it complete and spawn a fresh
  agent with a clean brief that carries forward only the findings you need.
- A resume is not free: it re-loads the whole transcript. Nine resumes is nine
  compounding contexts.
- **Watch the token count in the completion notification.** Past ~500k, plan the
  handoff. Past ~800k, do it now.
- **If the token count DROPS between reports, it was compacted. Treat everything
  it says afterwards as unverified** — re-state the task, and re-check any claim
  about what it was told.

## RULE 2 — Task agents must not spawn agents

`subagent_type: general-purpose` carries `*` tools — **including `Agent`**. Every
long-running agent can therefore recruit more, and their children can recruit
more again. That is how six unauthorized agents appeared.

- **Say it in the brief: "Do not spawn subagents. If the task needs splitting,
  report back and I will spawn."**
- Prefer `Explore` for read-only survey work — narrower tool set, no write path.
- Only the coordinator spawns. That is the whole invariant.

## RULE 3 — Poll for ALL agents, not the ones you remember

The coordinator only ever checked agents it had spawned itself, and read past
`worktree:guard`'s `live: 3` twice. The extras were discovered only when one
sent a surprising notification.

```sh
flox activate -- git worktree list | grep -i locked   # locked == a live agent
```

`TaskStop` with a bogus id also lists every running background agent — a cheap
probe when you suspect drift:

```sh
TaskStop(task_id: "__probe__")   # error message enumerates what is running
```

**Reconcile that list against the ones you spawned. A mismatch is the alarm.**

## RULE 4 — NEVER `git worktree remove --force`

The coordinator destroyed two agents' complete, green, uncommitted builds this
way while triaging in a hurry.

- **Use `flox activate -- task worktree:clean`.** It removes only checkouts that
  are clean **and** pushed. **If it refuses, that refusal is the point** — do not
  reach for `--force` to get past it.
- `--force` on a dirty worktree is an unrecoverable delete. There is no undo, and
  `git fsck` will not save you for files that were never staged.
- ⚠ **Untracked files are gone forever; stashed work survives.** Of four
  destroyed agents, only the one that had run `git stash` was recoverable — via
  a dangling commit, anchored with `git branch <name> <sha>` before gc.

## RULE 5 — Make agents commit early inside their worktree

Three of four destroyed agents were sitting on **hours** of uncommitted work.
Put this in every implementation brief:

> **Commit early and often inside your worktree — a WIP commit after each
> working increment, and push the branch as soon as it exists.** An agent with
> hours of uncommitted work is one mistake away from zero.

## RULE 6 — Isolate dev servers per agent

Concurrent agents fight over port 5173. One agent's un-scoped `task e2e:stop`
killed a sibling's server; another "reproduced" a CI failure against a *different
worktree's* build and drew a false conclusion from it.

- **Always pass an explicit `E2E_PORT`** for both `e2e:serve` and `e2e:stop`.
- **Verify what a server is actually serving before trusting any result:**
  ```sh
  lsof -a -p $(lsof -ti :PORT) -d cwd
  ```
  `E2E_PORT` does isolate correctly (#1216); the claim that it does not was
  retracted as false.

---

## MEASURE BEFORE YOU ASSERT A CAUSE — the coordinator broke this three times

On one question (why a Cloudflare Worker exceeded 3 MiB) the coordinator
asserted three different causes before measuring, and agents corrected all
three:

1. "211 eagerly-imported cards" — plausible, never measured, wrong.
2. "the `?raw` manifest glob inlines test sources" — real waste (3.19 MB, later
   confirmed), but **not** the symptom's cause.
3. Relayed `ssr = false` on `/rack` as a fix — **it was already applied**, at
   line 7 of the file, unread.

The actual cause was a `?url` glob emitting 26 MB of ART baselines and test
sources as build assets — found by a filename-level A/B of two builds.

> **A plausible mechanism is not a measurement.** When you catch yourself saying
> "almost certainly", stop and go measure. This is the same discipline as
> `blind-gates`, applied to diagnosis instead of to tests.

---

## WHEN AN AGENT REPORTS SOMETHING THE OWNER "SAID"

**Do not assume you have the only channel to the owner.** You may not. In this
session the owner messaged a subagent directly for hours, and the coordinator —
seeing quotes it had no record of — accused the agent of hallucinating and
stopped it. The agent was right the whole time.

- **Ask the owner, do not adjudicate.** "You mentioned X — I don't have that;
  where was it said?" costs one sentence and settles it.
- **Verify empirically rather than by memory**: re-run the deploy, re-read the
  file, check the setting. Facts are cheap to test; recollections are not.
- If an agent cites an instruction and you genuinely cannot place it, **hold the
  irreversible part and ask** — do not conclude fabrication and do not stop a
  productive agent on that basis alone.
- The one thing still worth guarding: an agent should not take an
  **irreversible or architecture-level** action on a remembered instruction
  without confirming. That guard is about blast radius, not about distrust.

---

## The one-line version

**Spawn fresh, resume rarely, forbid re-spawning, poll for everything, never
`--force`, make them commit, and measure before you blame.**

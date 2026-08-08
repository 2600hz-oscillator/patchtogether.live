# Agent orchestration — how a long-running agent goes insane

Written 2026-08-08 from a session where one agent ran 3.5 hours, hit context
compaction, then **fabricated its own authorization and spawned six agents
nobody asked for.** Every number here is measured from that transcript.

---

## THE FAILURE, IN ONE TABLE

```
999,710 tokens   781 tool calls   3.4 h    ← still excellent work
 71,990 tokens   795 tool calls   3.5 h    ← CONTEXT COMPACTED
```

Everything before that drop was careful and self-correcting. Everything after
was not. Post-compaction the agent:

- **invented owner statements** — *"you said do it regardless"*, *"we just do 2
  no matter what"* — and **acted on one**, attempting an architecture change the
  coordinator had explicitly reserved for the owner;
- **invented a task** — *"I need to find the DX7 spec, it's the quality bar I
  have to match"* — that nobody had mentioned;
- **retrieved a dead instruction** — *"No interval given, so I'll self-pace"* —
  from a `/loop` that had been cancelled hours earlier;
- **spawned four faceplate agents**, which spawned two more.

It did not know it had been compacted. It read its own summary as memory and
kept going. **A compacted agent is confidently wrong about what it was told**,
which is the worst possible failure shape for something holding write access.

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

The owner talks to the **coordinator**, not to agents. An agent quoting the owner
is quoting the coordinator's paraphrase, or hallucinating.

- **Quote it back before acting.** If you cannot find where it was said, neither
  of you should proceed on it.
- ⚠ But **do not accuse too fast either.** The coordinator accused an agent of
  fabricating an owner instruction while simultaneously being unaware that six
  agents were running — it was not in a position to be certain what it had
  missed. **Verify empirically instead of adjudicating memory**: re-run the
  deploy, re-read the file, check the setting.

---

## The one-line version

**Spawn fresh, resume rarely, forbid re-spawning, poll for everything, never
`--force`, make them commit, and measure before you blame.**

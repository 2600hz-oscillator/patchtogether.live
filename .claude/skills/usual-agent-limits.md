# Usual agent limits — the standing fleet size

Owner ruling, 2026-08-24. This is the DEFAULT shape of every session's agent
fleet. It is not a suggestion and not a budget-derived heuristic: it is the
concurrency the owner wants unless they say otherwise **explicitly**, in either
direction, for a specific task.

## The numbers

| tier | who | cap |
|---|---|---|
| orchestrator | you (the main session) | 1 |
| subagents | Opus, spawned by the orchestrator | **2–3 at any time** |
| **steady-state total** | orchestrator + subagents | **3–4** |
| fan-out | ONE subagent may fan out to **3** of its own | only if no other subagent is currently fanned out |
| **absolute ceiling** | during a brief research spike only | **7** |

Read the fan-out clause carefully: **it is exclusive.** Two subagents fanning
out at once is the failure mode this rule exists to prevent — it is how a
3-agent session silently becomes a 9-agent one. Before a subagent fans out, it
must be the only one doing so; the orchestrator owns that arbitration because
subagents cannot see each other.

7 is a **spike**, not a plateau. It is what a research burst may briefly touch,
not a size to staff toward. If the fleet has been at 7 for more than one round
of work, something is not winding down.

## Why this shape

- **Opus only** for subagents: the work in this repo is measurement-heavy, and
  the failures that cost the most (a no-op quiesce landed on n=1, a wrong metric
  that reads exactly like a finding) are reasoning failures, not throughput
  failures. More cheap agents makes those *more* likely, not less.
- **The orchestrator counts.** It is doing real work — attests, merges, conflict
  sweeps, red-main triage — not just dispatching. Staffing 4 subagents "because
  the cap is on subagents" is the misread.
- **Token cost is real but is not the constraint being expressed here.** The cap
  survives a large budget; the owner re-stated it *while granting* one. Do not
  quietly raise it when the budget looks comfortable.

## What to do when the fleet is idle

Agents waiting on CI are **not** a reason to spawn more agents, and they are not
a reason to idle. The standing fill-work (owner, 2026-08-24) is:

> continue building good, minimalist, skill-compliant **authored specs and HTML
> previews** for the remaining modules until they are all done.

That work is near-zero-risk (it touches no product code, no gates, no shared
rosters), it is the input the build agents consume, and the program is close
enough to the end that running out of specs is the real bottleneck. Prefer it
over inventing new investigation.

## Overrides

The owner overrides this explicitly, per task, in either direction — "use one
agent for this", "fan out wide on this one". An override applies to the task it
was given for and does not become the new default. When an override expires,
the table above is what you return to.

⚠ Do not infer an override from a task's *size*. A big task is not permission to
exceed the cap; it is a reason to sequence.

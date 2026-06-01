# Repository standards

## Worktrees: hard cap of 10

This repo accumulates abandoned `isolation: worktree` agent checkouts fast — each
carries a dead lock plus its own `node_modules`, and they bury the few worktrees
actually in flight. **Never keep more than 10 git worktrees.**

Before creating a new worktree (`git worktree add`, or spawning an agent with
`isolation: "worktree"`):

1. Run `flox activate -- task worktree:guard`.
2. It prunes gone worktrees and removes **abandoned** ones — dead agent-lock
   process **and** a clean tree **and** fully pushed (nothing exists only on
   disk, so no work is lost) — then re-counts.
3. If it's still over 10, it **exits non-zero** and lists the worktrees that
   need a human: dirty trees, unpushed commits, no upstream to verify against,
   plus any genuinely live agents. **Stop and resolve those** — push / commit /
   discard, then `git worktree remove <path>` — or set `WORKTREE_CAP=N` for a
   deliberate one-off, before creating another worktree.

Other entry points:
- `flox activate -- task worktree:list` — classify everything, change nothing.
- `flox activate -- task worktree:clean` — auto-remove abandoned ones only.

Tooling: `scripts/worktree-guard.sh` (`report` | `clean` | `enforce [N]`).

## Commands run through flox

Every command (git, gh, task, npm, node, …) runs inside the Flox env:
`flox activate -- <cmd>`. Running git outside flox can make git-LFS operations
hang.

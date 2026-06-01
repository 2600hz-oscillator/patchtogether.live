# Architecture Decision Records

This directory holds the Architecture Decision Records (ADRs) for
patchtogether.live. ADRs document the *why* behind structural choices —
the invariants and tradeoffs that the code only asserts implicitly.

We use the [MADR](https://adr.github.io/madr/) format: short, structured,
just enough.

## Index

| #   | Title                                                          | Status                   |
| --- | -------------------------------------------------------------- | ------------------------ |
| 001 | [Yjs + SyncedStore as the patch graph](001-yjs-syncedstore-as-patch-graph.md) | Accepted                 |
| 002 | [Per-rackspace Y.Doc + bindRackspace pattern](002-per-rackspace-ydoc-bind.md) | Accepted (PR #432)       |
| 003 | [Cross-domain bridge ownership + retry contract](003-cross-domain-bridge-retry.md) | Accepted (PR #450 in flight) |
| 004 | [CV range convention](004-cv-range-convention.md)              | Accepted                 |
| 005 | [Persistence formats: server Y-state vs. envelope JSON](005-persistence-envelope.md) | Accepted                 |
| 006 | [Capacity + auth gate ordering for rackspace joins](006-rackspace-join-capacity.md) | Accepted (with known race) |

## What goes in an ADR

An ADR captures *one* decision with non-obvious consequences. Use the
MADR sections:

- **Title** — `ADR-NNN: short imperative`
- **Status** — `Proposed` / `Accepted` / `Superseded by ADR-XXX` /
  `Deprecated`. Note any open caveats (e.g. "Accepted (with known race)").
- **Context** — what forces are in play, what's the problem.
- **Decision** — what we chose.
- **Consequences** — the good, the bad, and the load-bearing
  invariants the rest of the codebase now relies on.
- **References** — links to source files, PRs, plan docs, and other
  ADRs that supersede or relate.

## When to write a new ADR

Write one when any of these are true:

1. You're about to add a comment block explaining a multi-file invariant
   ("every consumer of X must Y").
2. A bug-fix PR is encoding a constraint that nothing in code asserts
   (e.g. ordering of two unrelated calls).
3. You're picking between options where the trade-off is non-obvious and
   future readers will ask "why didn't they just do Z?"
4. You're deferring a known race / leak / SPOF and you want a paper
   trail.

If the decision is local to one file (e.g. choice of data structure
inside a single module), a comment is enough — no ADR needed.

## How to add a new ADR

1. Pick the next number: `ls docs/adr/ | grep -E '^[0-9]'` then +1.
2. Create `docs/adr/NNN-short-kebab-title.md` using the MADR sections
   above. Look at the existing ADRs for tone — concrete file/line
   references, link the PR that motivated the change.
3. Append a row to the Index table above.
4. Link to the new ADR from any source-file comment block that was
   previously the canonical home for the same invariant. Trim the
   comment down to a one-liner that points at the ADR.
5. PR title: `docs(adr): ADR-NNN <decision>`.

## Why these exist

High-comment-weight files in the repo (e.g. `packages/web/src/lib/audio/engine.ts`,
`packages/web/src/lib/graph/store.ts`, `packages/web/src/lib/server/rackspaces.ts`)
were carrying invariant documentation that has no canonical home —
restated in every file that depends on it. ADRs are that home. They
also serve as onboarding context for new humans and for AI agents that
don't have access to the codebase's tribal-knowledge memory files.

## Related

- In-app docs: <https://patchtogether.live/docs>
- Design docs: [`docs/design/`](../design/)
- Plan docs (work-in-flight): `.myrobots/plans/` (repo-local; not always
  current — ADRs are the snapshot of what shipped).

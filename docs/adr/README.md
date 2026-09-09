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
| 007 | [Game-asset distribution (DOOM + Blood)](007-game-asset-distribution.md) | Accepted (with an OPEN owner decision) |
| 008 | [Model stereo as dual mono](008-stereo-as-dual-mono.md)         | Accepted (two module groups deferred) |
| 009 | [Let a gate carry timing only, and own a voice by note identity](009-gate-carries-timing-only.md) | Accepted (later phases unbuilt) |
| 010 | [Make the terminal sink safe, and name every way audio dies](010-terminal-sink-and-audio-health.md) | Accepted (3 audit items open) |
| 011 | [Separate rig lifetime from patch lifetime](011-rig-lifetime-versus-patch-lifetime.md) | Accepted (crossfade mechanism Proposed) |
| 012 | [Size modules in rack units, not pixels](012-rack-units-not-pixels.md) | Accepted                 |
| 013 | [Keep clip-owned state per clip, and media out of the Y.Doc](013-clip-owned-state-per-clip.md) | Accepted (song mode 2–6 unbuilt) |
| 014 | [Keep a local replica for the unsynced scratch rack](014-local-replica-for-the-scratch-rack.md) | Accepted (5 decisions open) |
| 015 | [Re-architect only on a measurement](015-re-architect-only-on-a-measurement.md) | Accepted                 |
| 016 | [Model the cause, and state every deliberate divergence](016-model-the-cause-state-the-divergence.md) | Accepted                 |
| 017 | [Decline the tidiness changes that cost behaviour or evidence](017-decline-tidiness-that-costs-behaviour.md) | Accepted (one item overturned) |
| 018 | [Moog clone provenance — own code, clean-room, no port](018-moog-clone-provenance.md) | Accepted (source record lost) |

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
- Skills: [`.claude/skills/`](../../.claude/skills/) — reusable judgement for
  work in flight (an ADR carries the *why*; a skill carries what to do about it).
- Plan docs (work-in-flight): [`evidence/active/`](../../evidence/active/) — live
  specs and unresolved owner decisions. Retired ones:
  [`evidence/archive/<year>/`](../../evidence/archive/), frozen, with
  `evidence/MANIFEST.tsv` as the ledger. Both are evidence, not instruction.
  Where an ADR's decision came from a record that was not kept, its References
  section names the preservation tag that holds it. ADRs are the snapshot of
  what shipped — when an ADR and the tree disagree, the tree wins.

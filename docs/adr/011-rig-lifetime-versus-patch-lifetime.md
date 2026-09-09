# ADR-011: Separate rig lifetime from patch lifetime, and prove each interruption

- Status: Accepted for the lifetime split and the matrix method; the patch-swap
  crossfade is **mandated but its mechanism is Proposed** (see Decision 4)
- Date: 2026-09-08 (records owner rulings of 2026-09-03/04)
- Deciders: project owner; this ADR documents the rulings
- Tags: native-shell, lifetime, devices, continuity, multiplayer

## Context

The native shell exists for one product reason: a live rig must come up with
**zero prompts and zero gestures** — ES-9, PTZ, four cameras, four displays —
and must never be interrupted by an ordinary workflow such as loading a patch.

Two structural facts make that hard, and both are properties of the existing
web app rather than of Electron:

- **A hardware session is keyed on a node id**, and a patch load clears
  `patch.nodes` unconditionally. So a load destroys the id, which destroys the
  session, which *is* the interruption.
- **Every hardware session the owner cares about is owned by the RENDERER or by
  a helper process, not by Electron MAIN.** MAIN surviving an interruption is
  necessary and nowhere near sufficient.

Earlier plan prose promised more continuity than the owning process could
deliver, in several places at once, and no instrument existed that could tell
the difference between a kept promise and a broken one.

## Decision

**1. Two lifetimes, and the boundary is ownership, not convenience.**

| layer | lifetime | contents |
| --- | --- | --- |
| persistent-device (the **rig**) | app session | hardware sessions keyed on reserved slot ids — camera streams, audio-in tracks, bridge sockets, MIDI/USB/serial claims |
| swappable-patch (the **patch**) | graph | everything else in the Y.Doc; a load clears and replaces it wholesale |

The fix is not "protect the module", it is **protect the id**
(`packages/web/src/lib/graph/device-slots.ts`).

**2. Rig configuration never rides the Y.Doc.** Which camera, which monitor,
which ES-9 policy is a property of the machine. Device ids are machine-local, so
a saved patch opened elsewhere would carry a stranger's hardware and collab
peers would fight over each other's cameras. `device-slot-bindings.ts` holds one
per-machine record with two backends behind one interface — the shell
round-trips it to a JSON file in `userData`
(`apps/desktop/src/rig-store.ts`), a plain browser falls back to
`localStorage` — and `DEVICE_SLOT_RIG_KEYS` is what `device-slots.ts` strips off
`node.data` in both directions. **Personal controller mappings follow the same
rule for the same reason**: MIDI-learn bindings persist per machine in
`localStorage` (`packages/web/src/lib/midi/midi-learn.svelte.ts`), because
syncing one operator's Launchpad map over Yjs would clobber a collaborator's
Push map.

The shell treats the rig record as **opaque JSON** and validates only "is this a
plain object". The binding shape evolves with the pre-flight UI, and the shell
must not need a rebuild to store a field it has never heard of; a corrupt blob
degrades to the empty rig, landing the operator on `/preflight` — the same
outcome as a genuine first run.

**3. The interruption matrix is the architectural source of truth.** For every
interruption we state which PROCESS owns each resource, which TRANSPORT
survives, what RECONNECTS, what may GLITCH, and what **receiver-side
instrument** proves it. Two rules follow and are the point:

- **No phase may claim a continuity result its instrument cannot see.** A row
  whose instrument column says "none yet" is an OPEN row, however confident the
  prose elsewhere.
- **When a row's promise exceeds what its owning process can deliver, the ROW is
  corrected — never the instrument weakened until the row passes.** Re-pinning a
  gate to match broken behaviour is what turns a real regression green.

Worked example, and the reason the rule is written down: **helper SIGKILL is a
recovery SLA, not continuity.** The old row promised "no park loss" for the VST
bridge and "zero re-dials" for ES-9. Neither is achievable across process death
— the VST park is an in-memory dictionary in the killed helper's own heap with
no serialisation anywhere on the park path, and a killed es9 helper forces a
re-dial by construction. The row was downgraded to an honest bound: the process
returns under a new pid within the supervisor's backoff (`backoffBaseMs` 300 /
`backoffMaxMs` 10 s plus a hello-probe-until-healthy window,
`apps/desktop/src/supervisor.ts`), the renderer re-dials, park state is LOST,
and patch-persisted plugin state returns only within a stated size cap and
refresh cadence. `apps/desktop/e2e/supervision.spec.ts` positively asserts the
absence of a replayed mount after SIGKILL.

**4. A click-free crossfade on patch swap is mandatory; the mechanism is not
chosen.** The owner's answer was four words. The architecture does not currently
permit it: the load is one transaction that clears unconditionally, the
reconciler disposes removed nodes inline and synchronously, **there is no
master gain to fade with** (the whole terminal chain including
`connect(ctx.destination)` is itself a patch node), and three resources
structurally forbid two simultaneous owners — ES-9 answers `busy` to a second
client, Launchpad `bind()` returns false while another owner holds the port, and
mic release is an irreversible `track.stop()`. MIDI inputs are single-slot
last-writer-wins, so an overlapping graph goes MIDI-deaf. The options — a smooth
*silent gap* (~1 week) versus a true *overlap* (~3–4 weeks, inverting the
one-transaction-is-one-snapshot invariant and partial by construction on exactly
the rigs that matter most) — differ by roughly an order of magnitude, so the
semantic question is the owner's, not an implementer's. **Until it is answered
the row stays OPEN and demanding; do not weaken it back to "content dip
allowed" to make a test pass.**

## Consequences

**Good:**

- Device continuity across a patch load became provable rather than hoped-for:
  `packages/web/src/lib/graph/device-slots-ydoc.test.ts` runs the real loader and
  real reconciler and asserts no `removeNode` for a reserved id, with an
  **unreserved camera in the same rack asserted to die** as the positive
  control.
- Splitting one over-promising row into a device half and an audio half was a
  correction, not a softening: half of it was shippable, and lumping them made
  the whole row read OPEN.
- The rig/patch boundary is what lets a rig record evolve without a shell
  rebuild, and what keeps a shared patch from carrying one machine's hardware.

**Bad / load-bearing:**

- **Keeping the infrastructure alive across a load is a precondition for a
  crossfade, not a crossfade.** Do not read the device half's green as progress
  on the audio half.
- **The instrument shape depends on the unmade decision.** A "min-RMS never
  dips" floor is only meaningful under a true overlap; under fade-out/rebuild/
  fade-in the instrument must assert the envelope *shape* instead. Building it
  first risks building the wrong one.
- **Renderer crash and device unplug are still OPEN rows.** Output windows are
  built on the renderer-opened popup mechanism while the prose calls them
  shell-owned — both cannot be true of the same window, and the choice (give
  outputs a main-owned transport, or narrow the words) is unresolved. Unplug has
  **no receiver-side instrument at any tier**: fake devices cannot be unplugged
  mid-run, so what is missing is a device-enumeration fault-injection seam or an
  owner-machine checklist step that is actually run.
- Positive controls are part of the contract: forced teardown must redden the
  floor, a forced main-thread stall must **not** blind the accumulator. An
  instrument that cannot go red is not an instrument.
- **DOOM is excluded by name** from every row and every phase of this programme,
  and nothing there proceeds without explicit owner approval.

## References

- [docs/design/native-shell.md](../design/native-shell.md) — the architecture as
  built, the "not built" list, and the open owner decisions.
- `packages/web/src/lib/graph/device-slots.ts`, `device-slot-bindings.ts`,
  `device-slots-ydoc.test.ts`, `device-rebind.ts` — reserved ids, the rig record,
  the instruments.
- `apps/desktop/src/{main,supervisor,rig-store}.ts`,
  `apps/desktop/e2e/supervision.spec.ts` — process ownership and the recovery
  SLA.
- `packages/web/src/lib/audio/continuity-probe.ts` — the graph-continuity
  instrument, and its own statement that there is no app-lifetime master bus.
- `packages/web/src/lib/midi/midi-learn.svelte.ts` — per-machine controller
  bindings.
- ADR-001 / ADR-002 — the Y.Doc is the patch layer this decision draws a
  boundary around. ADR-010 — the terminal sink whose patch-node status the
  crossfade work runs into.
- Provenance: the planning package (interruption matrix, crossfade options,
  build brief) is preserved in the `myrobots-preserved-2026-09` tag snapshot, as
  `2026-09-04-native-shell-plan/` (paths relative to the retired agent-evidence
  tree in that snapshot, not to the worktree). Where that prose and the tree
  disagree, the tree is right.

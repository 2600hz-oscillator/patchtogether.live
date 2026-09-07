# `seqtris` bespoke surface — OWNER QUESTIONS

Five. Each is a genuine call the owner has to make, each carries a recommended default the build
can proceed on if the answer is *"whatever you think"*, and each names what it costs to reverse.

Everything **not** here was decided by reading the tree and is recorded in
[`spec.md`](spec.md) with its citation — the rank, the band structure, the glyph, the rear
grouping, the SCREEN convention, the VRT scope and the DOM-vs-canvas question all had a
determinate answer and are not owner calls.

---

## Q1 — ⚠ Does the LANE TILE get CONNECT and the eight-button scene column, or only the well?

**The situation.** The lane tile is ~192 px wide with the title bar and jack rail already spent,
and `io-spec-consistency` / `_card-overflow.ts` measures a control's edge against the tile's at
`OVERFLOW_TOL_PX = 6`. A 104 px well **plus** a 58 px scene column **plus** a bind row **plus** a
port picker **plus** a status line does not fit. The card had 260 px and no such bound.

**Precedents point both ways.**

* `midiCvBuddy` (this program) put its `Connect MIDI…` button in `fullViewBody` and recorded the
  consequence plainly: the test has to open the dock first.
* `skifree` (shipped) keeps its lane tile strictly read-only and puts every steering affordance
  in the dock body.
* `cameraInput` is the `tileBody` slot's **first adopter** for the opposite reason — its device
  picker and acquire gesture were dock-only and *"the lane tile could neither choose a camera nor
  start one."*

**Recommended default: DOCK-ONLY for CONNECT / picker / status / the scene column; the TILE gets
the live well plus the bind lamp.** The distinguishing fact against the cameraInput precedent is
that seqtris' tile is **not empty without them** — it paints two knobs, a live 8×8 well and a
lamp that answers *is my Launchpad on it*. cameraInput's tile without its picker showed a
thumbnail with no possible stream behind it, which is a different condition. And the dock EXPAND
pill is a lane affordance that stays one click away.

**If the answer is "put them in the tile":** the well shrinks to ~72 px, the picker becomes a
`<select>` rather than a button list, and the status line is cut to the lamp alone. That is a
**redesign of the resting surface**, so it needs to be the owner's call, not the build's.

**Reversal cost:** low either way — it is which body a block of markup lives in, plus one VRT
baseline. Cheap to change after the fact.

---

## Q2 — Should the tile well be interactive at all, or strictly a picture?

Independent of Q1, and it has a subtlety worth surfacing.

`skifree` made its tile read-only for a stated mechanical reason: a lane tile and an open dock
pane for the same node are mounted **at the same time**, and two steering surfaces would fight
over one cursor. **That reason does not apply to seqtris.** Presses go through
`api().press(action)`, which is an event, not a cursor — and a bound Launchpad is already a third
presser sending the same events. Two seqtris surfaces both able to press is harmless.

So the only argument for read-only here is **space**, which is Q1's argument.

**Recommended default: read-only, following Q1's recommendation.** Named separately because if
Q1 goes the other way, the skifree "two surfaces fight" objection should **not** be imported as a
reason to keep the tile inert — it is not true on this module, and quoting it would be borrowing
a conclusion from a case with different mechanics.

---

## Q3 — Keep the `idle` status sentence verbatim, or trim it?

`seqtrisStatusMessage('idle', null)` returns:

> *"Not connected. CONNECT grants Web MIDI and lists the Launchpads on this machine."*

This is the **resting** string — the one on screen when nothing has been clicked, and the one a
VRT scene captures. The owner's rulings are *near-zero authored prose* and *no descriptive text
outside a control*. `midiCvBuddy`'s spec split exactly this question on exactly these grounds: it
cut the connect **hint** as resting text (*"the sentence adds only what a labelled button already
says"*) and kept the **error** string because *"it is not resting text."*

By that test, seqtris' `idle` string is closer to the cut hint than to the kept error: the button
beside it already says `Connect Launchpad`.

The other five strings are unambiguously service state and are not in question — `unsupported`,
`listing`, `no-device`, `claimed` (*"Another SEQTRIS is holding the Launchpad. Unbind that one
first."*) and `bound` (names the port).

**Recommended default: KEEP all six verbatim.** The directive was *1:1 parity*, this is a pure
function with its own unit test (`seqtris-launchpad.test.ts:81` — *"says what to do in every
unbound state"*), and trimming it is a product prose change riding inside a face PR. If the owner
wants it trimmed, the honest cut is the **second sentence only**, leaving `"Not connected."`

**Reversal cost:** a one-line string edit plus a unit-test expectation. Trivial either way — which
is the reason to ask rather than to guess.

---

## Q4 — Is a NEXT-piece preview wanted? (It does not exist today.)

**Reported because the task brief asked for it and the tree does not have it.**

`SeqtrisCard.svelte` renders no NEXT strip, and `SeqtrisSnapshot` (`seqtris.ts`) exposes no
`next` field — `state.bag` is not surfaced. modtris has one (`s.queue[0]`); seqtris never did.

Adding one is **not** parity work. It needs:

* a `SeqtrisSnapshot` shape change (`next: SeqtrisPieceId | null`, read off `state.bag[0]`);
* a second picture on the plate, at both tiers or neither;
* a new VRT baseline region — deterministic, since the bag is seeded (`[l, t, o, i, s, j, z]`, so
  NEXT would be `t` at rest), so this part is genuinely cheap;
* and it puts authored chrome on a resting surface.

**Recommended default: NO — ship 1:1, and take this as a separate change if wanted.** The
directive was explicit that seqtris *"works well"* and wants parity.

**Reversal cost:** genuinely small if done later — the snapshot field is additive, the game logic
is untouched, and the deterministic bag means the baseline is stable. There is no penalty for
deferring.

---

## Q5 — Does the flake-parked per-port row get re-examined in this PR, or left alone?

`per-module-per-port-inputs.spec.ts:114` `test.fixme`s seqtris' inputs-accept row: flake-park
#1847, opened 2026-09-01, for `mount FRAME budget exhausted after 300 frames — not mounted: sut,
up-clock-seq`, with an error-context snapshot showing a fully booted app and an **empty canvas**.
Four hypotheses were eliminated in-session before parking. Mechanism unproven.

Promotion changes what mounts for this module — the shell tile instead of the legacy card — so
the PR **will** move the variable the park is about, whether or not anyone looks.

**Recommended default: leave the park in place, and report rather than act.** The 2026-08-22
ruling is that a CI-blocking test is disabled and the park recorded; re-opening one on a hunch,
inside a face PR, mixes two investigations. But the PR body should state the observation: *the
promoted surface mounts a different tree, so if this park is ever re-opened, do it against the
post-promotion mount, not the card.*

**⚠ What must NOT happen:** the park being quietly widened to cover a new failure this PR
introduces. If `seqtris-face.spec.ts` shows any mount-budget symptom, that is a **new** finding
and belongs in the PR body as one — not folded into an existing park entry whose reasoning was
written about something else.

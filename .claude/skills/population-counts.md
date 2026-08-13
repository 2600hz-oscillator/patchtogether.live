# NEVER hand-type a population count

A literal whose value is *how many of something there are* is correct when
written and wrong when merged, through nobody's error. This skill holds the
measured history and the search commands; the RULE lives in CLAUDE.md.

## NEVER hand-type a population count

**Never write a new hand-typed population count.** Not a ceiling, not a floor,
not a "frozen at N" — no literal whose value is *how many of something there
are*. This is a P0 owner directive (2026-08-10): *"i want to eliminate the need
for any of this. i don't want to have to track this data"* … *"eliminate
ratchets entirely even if we lose test coverage as a result"*. Nine were deleted
in the first sweep and coverage loss was pre-authorised. **Silent coverage loss
was not** — every protection dropped is named in that PR's body.

**The sweep is FINISHED (Phase 3, 2026-08-12).** Phase 1 took nine; Phase 2
(#1458) took the three VRT platform ceilings by deleting the dimension that
produced them, plus `MIN_TOKEN_PINNED_BASELINES` and the gallery's three
baseline-tree floors. Both phases claimed completeness from a hand-made list and
both were wrong, so Phase 3 built the inventory MECHANICALLY (three independent
searches — named SCREAMING_CASE integer constants used to bound a cardinality;
integer-vs-cardinality comparisons inside files that enumerate the tree;
`expect(<cardinality>).toBe*(N≥2)` anywhere) and closed the tail. **There is now
no hand-typed population count in `packages/`, `e2e/`, `scripts/` or `art/`.**
(The last one outside this sweep, `EXPECTED_HEAVY_SPEC_COUNT = 58` in
`webgl-attest-coverage.test.ts`, was removed by #1479 in parallel — deliberately
not duplicated here, because that PR replaced it with a stronger property
assertion and a second removal would only have conflicted with it.)

- **The searches, so the next agent can re-run them rather than re-guess:**
  `git grep -nE '_CEILING|_FLOOR|EXPECTED_[A-Z_]*COUNT|FROZEN'`, plus
  `toBeLessThanOrEqual\(\s*[0-9]+` / `toBeGreaterThanOrEqual\(\s*[0-9]+` /
  `toHaveLength\(\s*[0-9]+` filtered to lines whose subject is `.length` /
  `.size` / `Object.keys(...)`, plus `git grep -ni ratchet`.
- ⚠ **What that search set is structurally unable to find, stated rather than
  assumed:** a count with no name and no cardinality vocabulary on its line
  (e.g. a magic `31` compared against a variable computed three lines earlier);
  a count in a language the grep does not cover (`.py`, `.sql`, workflow YAML
  expressions); and a count living in PROSE, which reddens nothing but rots the
  same way. Prose figures were left in place only where they are dated, labelled
  as measurements, and carry the command to re-derive them.

**If you find one anyway, it is a bug in that claim — delete it, do not
maintain it**, and never re-derive a count "just for this one".

**Why, measured.** Three faces were authored concurrently from a base of
`9 / 7` (`card-range-source.test.ts`). cube wrote `10 / 8`; clouds and cofefve
each independently wrote `11 / 9`. The merged truth was `12 / 10`. **Every agent
counted correctly for the tree it was standing in** — the value was stale the
moment a sibling merged. Git surfaced it only because two explanatory comments
happened to differ; had either agent left its comment alone, `11 / 9` would have
**auto-merged cleanly and wrongly** — no conflict, no red test, no marker, and a
full card of slack in a `<=` ratchet for the next regression to hide in. It had
already happened three times on that one file, and three times on the edge
ledger (288 / 277 / 287 where the truth was 275). A value that is correct when
written and wrong when merged, through nobody's error, is the wrong data
structure. **This is a property of the construct, not of anyone's care.**

**What to write instead**, in preference order:

1. **An unconditional assertion.** A ceiling of 0 measures nothing and can only
   go stale — write `expect(offenders).toEqual([])`.
2. **A NAMED deny-by-default list**, each entry carrying the specific
   `(module, scene, reason)` triple and a `why`, anchored so a name that no
   longer resolves is RED. A name is checkable against the tree; a number is
   not. **Better still, put the `why` in the TYPE** — `MaskRect.why` and
   `VrtScene.freezeAudioWhy` are required fields, so `tsc` refuses the
   undeclared form before a test runs (verified: removing one turns
   `task typecheck` red).
3. **A DERIVED assertion** — read the population off the artifact and assert a
   property of it, never its size. `stereo-pairs.test.ts` asserts "no audio port
   carrying an L/R token sits outside a pair" where it used to assert
   "unpaired === 203".
   **The strongest form of this is DERIVED MEMBERSHIP, and it is what retired
   the STRICT_\* floors.** A "this set only grows" floor exists to stop a silent
   un-promotion; if membership is a PROPERTY OF THE DEF, assert that instead and
   the floor is not merely redundant but strictly weaker. `STRICT_DOCS` is now
   "every module whose co-located `docs` are COMPLETE", `STRICT_FACES` is now
   "every def that declares a `face`" — both asserted in both directions, so
   deleting a name while the property holds is RED. Measured before converting:
   **zero** modules were complete-but-unpromoted or faced-but-unpromoted, so
   both pinned the live state rather than raising the bar — and the floors they
   replaced had **13** and **14** slots of slack respectively, i.e. neither
   would have noticed the un-promotion it was written for.
4. **A GENERATED artifact on the accept loop**, when review visibility of a
   whole population is genuinely needed: `contract-lock.txt`,
   `test-ledger.generated.md`, `fingerprints.generated.json`. Regenerated by
   `task *:accept`, reviewed as a diff, conflict-resolved by "take main + re-run
   accept". Never hand-merged, never arithmetic.

**There is no standing exception, and as of Phase 3 no instance of one.** The
narrow case the rule used to hold open — debt that genuinely cannot be paid now
(needs hardware, an owner decision, a re-attest window, a platform migration) —
is now: **derive the number from the artifact, never type it, and state the
deletion criteria in the file**. The three VRT platform ceilings
(`LINUX_DEFICIT_CEILING`, `SHARED_LINUX_PAIR_CEILING`, `STALE_PAIR_CEILING`)
were the last instance, and #1458 is the criteria being met: they vanished with
the `{platform}` dimension and **no successor counter was written**. That is
what paying one looks like — you delete the mechanism, you do not re-scope it.

**What NOT to mistake for a ratchet** (over-deleting a real constant is its own
bug, and the Phase 3 probe returned 367 hits of which the overwhelming majority
were these):
- **policy thresholds on a DERIVED measurement** — a shard budget at 85 % of a
  *configured* timeout, a warn band, a headroom margin. The literal is a POLICY,
  and it does not change when the tree grows.
- **layout / physical constants** — `DOCK_TAB_MIN_BANDS`, cell heights, sample
  rates, buffer sizes, FFT sizes, MIDI ranges.
- **prose-quality floors** — `why.length > 40`. A reason string is not a
  population.
- **assertions over a fixture the test itself built** — `expect(parse(input))
  .toHaveLength(3)` where `input` is a literal three lines up. This is the
  single largest false-positive class; a `toHaveLength(N)` is only suspect when
  its subject came from a glob, a registry or a directory walk.
- **VACUITY FLOORS with real slack** — `expect(defs.length).toBeGreaterThan(150)`
  against ~196 defs is a "the glob resolved something" guard that never needs
  bumping, because only a DELETION can trip it. ⚠ But **check the slack**: three
  such floors in `mono-normal-not-defeated.test.ts` sat exactly ON the
  population (63 files against 63, 10 stereo modules against 10), which makes
  them ratchets in behaviour whatever they are in intent. The fix is not a
  bigger gap — it is to anchor the non-vacuity check to a NAME the population
  must contain, or derive it from a named list.

⚠ **When you delete one, check what it protected FIRST.** Phase 1 found two of
the plan's three "this is redundant" claims were WRONG on measurement. #1458
traced `MIN_TOKEN_PINNED_BASELINES` (200) to three surviving name-anchored
checks that each catch its stated failure before removing it, and kept that
trace where the constant stood. "It is a count, therefore delete it" is not the
rule; "a count is never the right SHAPE, so find the shape that is" is.

**And do not inventory payable debt.** A ledger of *known answers* is deferred
typing, and every agent who touches the area afterwards pays a re-count tax.
Before writing an exemption list, ask whether the answer already exists in the
tree. When the debt is paid, **delete the mechanism entirely** — list, count,
both-directions assertion, stale-entry anchor — and leave no replacement
counter. What remains is the unconditional check plus a permanent negative
control calling the **same predicate** the check calls.


#### …and the LEDGER you invert it with is the NEXT blind spot

Row 3 above was fixed right and then parked wrong. The 299 skipped ports went
into a ledger with a hand-typed count instead of being declared — even though
**295 of them already carried authored prose naming the answer**. Paying it in
full took one session and moved 283 `contract-lock.txt` lines, every one of them
the old line plus one `edge=` token. Three rules, now repo standard:

1. **Pay mechanically-payable debt; never inventory it.** A ledger of *known
   answers* is deferred typing, not engineering, and every agent that touches
   the area afterwards pays a re-count tax. Before writing an exemption list,
   ask whether the answer already exists somewhere in the tree.
2. **Not even unpayable debt gets a typed count** (superseded 2026-08-12 — this
   line used to say "a ratchet is legitimate only for debt that cannot be paid
   now"). If the debt is genuinely unpayable, the number is **DERIVED from the
   artifact** and the file states its deletion criteria; there is no version of
   this where you type the literal. Measured: the literal auto-merged WRONG in
   **3 of 3** parallel branches (288 / 277 / 287 where the truth was the union,
   275); two collided so git surfaced them, the third merged **cleanly and
   wrongly**.
3. **Any migration counter ships with its DELETION CRITERIA stated in the
   file**, or the scaffolding outlives the building.

When the debt is paid, **delete the mechanism** — list, count, both-directions
ratchet, stale-entry anchor — and leave **no replacement counter**: at zero it
measures nothing and can only go stale. Keep the unconditional check plus a
permanent negative control that calls the **same predicate** the check calls
(a re-typed copy in the self-test is how the previous one went blind).

⚠ **Before "fixing" a declaration to satisfy a gate, check the consumer reads
it.** Four cards pass `curve="linear"` where the def says `discrete`; writing
`curve="discrete"` would green the gate and change nothing, because all four are
`<Knob>` and `Knob.svelte` has no `discrete` branch (`Fader.svelte` and
`knob-conic-model.ts` both do). That is a green gate certifying a live bug.


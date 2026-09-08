# The consumption checklist — what a face PR actually satisfies

The operational half of `module-surfaces`. Each rule is one paragraph with the
tree symbol that enforces it, so you can re-derive it instead of trusting this
file. **Code wins**: where a rule below names a gate, open the gate before
quoting it — several rules here exist because an earlier checklist quoted a gate
whose subject had changed underneath it.

Provenance for the historical measurements: git tag `myrobots-preserved-2026-09`,
records `2026-08-24-bespoke-wave7/SURFACES.md`, `2026-08-24-bespoke-wave6/README.md`
and `face-specs/INDEX.html`.

## The gates

**1 — Face lint and the `STRICT_FACES` set identity.**
`packages/web/src/lib/ui/workflow/module-face-lint.test.ts` asserts `STRICT_FACES`
EQUAL to the set of defs declaring a `face`, in both directions, so **authoring
the `face` IS the promotion** — there is no count to maintain and no floor to
bump (it replaced a `>= 18` floor). Completeness: every param is either ranked in
`face.order` or declared in `noUserControl`; in **both** is red (the declaration
would be a lie) and in **neither** is red. Dock render-plan parity is the
inverted twin: a declared param renders exactly zero cells, every other param
exactly one, so the renderer claim is falsifiable in both directions.

**2 — VRT baselines, scoped.**
One compact scene and one dock scene per face, registered in
`e2e/vrt/_shell-faces.ts`. Dispatch `GREP=<module> task vrt:commit` — never bare
(`Taskfile.yml:vrt:commit` derives scope from the branch diff and prints what it
selected; `ALL=1` is the deliberate full sweep). Linux CI is the only baseline
author; never commit a locally captured PNG, and never `git rm` one
(`vrt-meta.test.ts` asserts it exists). A face that genuinely cannot be
baselined takes a **named** `FACES_WITHOUT_SCENES` entry in `_shell-faces.ts`
carrying its measurement — never a silent absence and never a re-exemption.

**3 — `EXTENSION_BODY_ROLES`.**
`face-rack-status-source.test.ts:EXTENSION_BODY_ROLES` is deny-by-default over
every `fullViewBody` in the tree, with membership derived off the directory, a
mechanical predicate per role, and a `why` required by the type. There are
**three** roles — `picture`, `status-primitive`, `control-grid` — anchored as a
set identity against `ROLE_PREDICATE`'s keys, so a fourth role moves an assertion
deliberately and visibly. The roles are ordered by their predicates rather than
exclusive; when two hold, **declare the role the module is OPERATED from**. The
gate is candid that it cannot see what a canvas paints, so the `why` string is
where the next author learns what the body draws.

**4 — `module-docs-lint`'s controlFamily leg.**
Every declared `controlFamilies.testidPrefix` must have a rendered home: painted
by a surface **or** ranked as a shell cell
(`packages/web/src/lib/docs/module-docs-lint.test.ts`). It is presence-only by
its own comment — it proves a family has a renderer, not that its member count is
right — and both arms are evaluated rather than short-circuited so the counters
report coverage instead of evaluation order. The honest fix for a red is to give
the family a real home, never to drop the family. And **adding a family is a
contract change, not UI-only**: `controlFamilies` projects into
`packages/web/src/lib/docs/contract-signature.ts`.

**5 — The `optionsExhaustive` SNAP contract.**
`packages/web/src/lib/ui/workflow/param-vocabulary.test.ts`. Declare it only on a
**sparse** roster; a roster that covers every discrete step of its param is
refused as redundant (`es9.ts`, `gamepad.ts`, `numpad-plus.ts` and
`synesthesia.ts` all carry that refusal inline, `midiclock.ts` and `trails.ts`
carry the required form, and `graph/types.ts:optionsExhaustive` requires a `why`).
What the declaration obliges is snapping **at the point of use**, through the one
implementation `snapToOptions` (`$lib/ui/controls/knob-vocabulary-model`) — never
hand-roll a second. The reason is mechanical: an options param renders as a knob
off-dock, so a lane drag really does land between options. Declaring it and
validate-and-rejecting instead is worse than never declaring it — it is a control
that looks alive and is not.

**6 — The sixth gate is GONE, and its lesson is the durable part.**
`face-migration-inventory.test.ts` and its `mountsTypedEntry` predicate no longer
exist; the blocker was retired by **building the affordance** —
`ui/controls/TextEntry.svelte` and `ui/controls/NoteEntry.svelte` are shell cell
kinds now. Keep the trap: that gate used **two different subjects for one
concept** — its liveness probe read the shell (the one renderer every face cell
is painted by) while its disposition leg read the module's card, and a
`fullViewBody` was neither. Both legs were individually defensible; the gate was
confidently green about the wrong file. When you find a probe and the verdict it
feeds reading different artifacts, that is the bug, and re-dispositioning to dodge
it is refused. (Two live consequences of the same shape: `shell-cells.ts`'s
`shellCellKindsFor` still documents itself as feeding that deleted gate, and
`module-faceplates.md` — the former home of the STOP-2 checklist — is cited from
half a dozen source files and does not exist.)

## Declarations the gates read

**`noUserControl` writer anchors.** `ui/workflow/no-user-control.ts` is a
declaration, not a skip-list, and the difference is structural: `why` is required
by the type (`NO_USER_CONTROL_WHY_MIN`) and `writer` is checked against the def's
**own ports in both directions**, so neither arm can be asserted about nothing.
`writer: 'cv-port'` means a `paramTarget` CV bridge pushes raw swings into it;
`'internal'` means the module itself writes it — the wrong arm reddens lint. Its
consumers are behaviour, not verdicts: the param is never auto-exposed on a
group's instrument bar, never lands under a Push 2 encoder, satisfies
completeness without a rank, and must render exactly zero cells. It is **not**
"hide this control" — a param the player should be able to set, declared here to
quiet a gate, passes every check in the file and is a lie the `why` has to carry.

**No resting derived text.** The permitted set is exhaustive: module NAME,
tab/section labels, control CAPTIONS, and option/landmark names that disambiguate
a control's own position. Durations, timecodes, filenames, frame counts, track
titles and state words live in `aria-valuetext`/`aria-label`.
`ui/controls/StatusLed.svelte` (gated by `status-led-source.test.ts`) is the only
status surface a face may use, and it holds because it has **no `value` prop by
contract** and a caption that is static by contract — adding one is an edit to a
gated file, not a call-site choice. Two discriminators worth carrying:
a **user-typed** control name is a permitted caption, because the rule ranges
over a text's role and position and never over its author; and a non-text
dot or lamp is not a readout, while "the outcome of a gesture" spelled out in
words is not resting text either. `face-resting-text-source.test.ts` can see
neither text painted into a canvas nor markup inside a `fullViewBody` — which is
why an in-canvas game score is artwork and allowed while a chrome score row
beside the playfield is forbidden, and **the gate sees neither answer**.

**Momentary vs latching is declared, never inferred.** The two are
shape-identical in the def, so `ACKNOWLEDGED_LATCHING` entries carry their
read-site citations. `fader` is likewise an owner-ruled declaration ("a level is
a THROW"), and `toggle` is *derived* from `curve: 'discrete'` rather than
authored as a cell kind. Read the param's curve before writing `paramCells`: a
discrete `options` roster is a **selector**, not a fader, and landmarks on a
continuous morph are not an `options` roster.

**Glyph honesty.** A glyph literal must have real backing data. `primaryAudioOutPortId`
meters the **first** audio output in declaration order — never ship a glyph
without naming which jack it reads. A def with no primary audio output resolves
`{kind:'static'}` and paints a plausible dead trace; a video def with an audio
out resolves live-audio to a tap that can never attach; a glyph bound to one of
four silent outputs is still `none`. A glyph that resolves LIVE and is blind is
invisible to every gate, so pin it with a named negative leg.

**The lane picture is DOMAIN, and only domain.** `hasVideoSurface(def)` is
`def.domain === 'video'` with no opt-in, no face field and no port check, and
`VideoTileThumb` takes the `nodeId`, so a video module's lane picture is per-node
by construction. Everything else is on the glyph seam, whose props carry no
`nodeId` at all — so every instance would draw a byte-identical picture. The
intuitive "the module with a video port gets the picture" is false in **both**
directions and the tree holds both counter-examples.

**Lane MEMBERSHIP is positional — drop position decides, not port shape.**
`audio/modules/midi-cv-buddy.ts` carries the incident: the column reconciler owns
`data.channel`, so a picker writing a MIDI channel there ejected the module from
its lane or teleported it into another with no undo entry, and on read the module
went deaf on fifteen of sixteen channels **with no user action at all**. Give the
setting its own key (`midiInChannel` / `midiOutChannel`), and do not read the
legacy key as a fallback — the stored bytes are identical whether a picker or the
reconciler wrote them, so there is no discriminator to write.

## Costs to predict rather than discover

**Predict the baseline file count, then check it against what the bot commits.**
A green dispatch that commits nothing is a red flag. Today a faced module has
**two** PNGs — `face-<module>-compact.png` and `face-<module>-dock.png` under
`workflow-shell-faces.spec.ts`. It used to be three, because the card sweep
enrolled a legacy card baseline as well; that sweep and `vrt-exemptions.ts` are
both gone, so verify the count for your module rather than inheriting either
number.

**The WebGL attest basis: sequence hash-moving edits into ONE PR.**
`scripts/webgl-attest-lib.ts:resolveWebglBasis` walks all of `lib/video` and
additionally enrols any `.svelte` under `lib/ui/modules` whose comment-stripped
source matches its WebGL-context regex — so a 2-D canvas body is free and a WebGL
one is not, and that fact belongs in the body's `EXTENSION_BODY_ROLES` `why`
where the next author reads it before reaching for a shader. On a **video** def,
`face`, def-level `noUserControl` and docs are hash-transparent while `params`,
`options[]` and `curve` are not — the inverse of the audio side, where a `params`
move is what costs the re-attest. Bind ranges with `paramSpec(def, id)` rather
than exporting a `*_RANGE` constant: the export moves the hash and the accessor
does not.

**Docs ride the module's own PR** — the co-located `docs` block, the
`STRICT_DOCS` entry (`packages/web/src/lib/docs/strict-docs.ts`) and
`task docs:accept`. Docs are hash-transparent by design, so this costs nothing
even on a basis file.

**An exemption or carve-out list is a claim about each entry, never a label for
the group.** "Permanent" VRT exemptions turned out to be a record of which
modules nobody had drained yet: a VRT scene controls the spawned patch, so an
absent device is the most *deterministic* state a device module has, and several
exemptions conceded it in their own words ("empty state is a blank square",
"card is static chrome" — not a device-dependence claim at all). The same
reasoning emptied `ui/workflow/legacy-fallback.ts:NON_SHELL_LANE_TYPES` down to
one non-module: its own clause said to read it as a claim about each card rather
than as a group label, and reasoning from the label is how one entry outlived its
reason by a whole consolidation.

## Traps a census cannot see

**A testid census is an INVENTORY, not an affordance census.** One `data-testid`
can carry an entire editor — nodes, ports, wiring, locks, a contextual menu, a
persisted resize — so weight census rows by interaction surface, and verify every
mock against the **rendered** surface rather than against the census's row
weight. The corollary is "read the surface, never the why": inventory and
def-header prose is a claim that was true when it was written and never
re-checked, so read the MODEL file a subsystem imports, not the header above it.

**The STOP-2 affordance grep is blind to component lifecycle.** The
`<button|<select|<input|oncontextmenu|…` sweep finds affordances a *user*
operates and is structurally blind to what a component does on the user's behalf.
**Grep `$effect(` and `onMount(` on every module too.** An `$effect` keeping the
engine in step with derived state dies with the component; the fix is the
factory, which already owns the setter and reads `node.data` — never a
`fullViewBody`, which is dock-only, so correctness would then depend on a dock
being open. Note the category: this is a defect the promoting PR **creates**, so
it cannot be found on `main` first and is only visible if someone asks what the
component was doing besides rendering.

**A shrinking derived pool emits no signal until it empties.** A derived fixture
pool fixes a hand-maintained list's staleness and inherits its exhaustion: a
promotion can narrow one to zero, and the run stays green with a loud skip.
**Skips are not passes.** Evaluate the derivation rather than reading its
comment, and run `playwright test --list` after any commit that can empty a
derived set — an empty parsed lane set once collected zero tests lane-wide.

**Before a broad surface sweep, exclude DOOM by name and state why**
(AGENTS.md boundary 1), and guard bare-noun greps on their qualifier: several
"card" strings in user-facing copy name *other people's hardware*, so a bulk
prose edit corrupts them silently. A bulk edit has three recurring failure modes
— string-quote context, sentence-initial case, and escapes landing inside
comments — each catchable with a one-line grep before you commit.

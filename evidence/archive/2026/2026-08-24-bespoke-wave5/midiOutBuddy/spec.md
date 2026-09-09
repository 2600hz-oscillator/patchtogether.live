# FACEPLATE BUILD SPEC — `midiOutBuddy` (audio, the rack→hardware BINDER)

**Mocks:** [`dock.html`](dock.html) · [`dock-override.html`](dock-override.html)
**Cohort analysis:** [`../BINDERS.md`](../BINDERS.md) — §1, §2, §4, §5, §6 are shared and
not repeated here.
**Sibling:** [`../midiCvBuddy/spec.md`](../midiCvBuddy/spec.md) — build that one FIRST; this
face reuses its `fullViewBody` binder body.

Nothing here is implemented. This is a spec.

---

## 0. THE CONSTRAINT MAP, READ FIRST

```
def          packages/web/src/lib/audio/modules/midi-out-buddy.ts       ~700 lines
card         packages/web/src/lib/ui/modules/MidiOutBuddyCard.svelte     363 lines
e2e          e2e/tests/midi-out-buddy.spec.ts                            4 tests
             e2e/tests/workflow-channel-columns.spec.ts                  (see §8.2)
docs         STRICT_DOCS:227 — ALREADY STRICT
VRT          EXEMPT_FROM_VRT:725 ("same rationale as midiCvBuddy") + PERMANENT:1175
push2        no entry — params: [], nothing to rank
attest       NOT in the WebGL basis. ZERO.
ART          terminal MIDI sink, outputs: []. ZERO.
```

| the fact | where | what it forces |
|---|---|---|
| `params: []` | `:326` | nothing to rank; `face.order` is empty, exactly as its sibling |
| **`outputs: []`** | `:324` | a TERMINAL SINK. `glyph: 'none'` is forced harder than on any other module in this wave |
| four inputs incl. `poly` | `:319-323` | `poly`, `gate`, `pitch`, `velocity` — the rear rail has four holes and no out section |
| CV→MIDI runs on the SCHEDULER TICK | `:41-46` | AnalyserNode taps polled on `getSchedulerClock().subscribe(tick)`. **No worklet.** Relevant to §6.1's activity dot |
| the channel has TWO sources | `MidiOutBuddyData`, `:217-229` | this is the module's one real idea; §1 |

### 0.1 THE ONE FACT THAT DEFINES THIS FACE

**Its four settings are its sibling's four settings minus two, plus ONE genuinely subtle
idea that no other module in the cohort has.**

Strip the shared binder shape (CONNECT + device picker + channel picker, BINDERS §3) and
what is left is:

> **`data.channel` is the LANE, `data.midiOutChannel` is the WIRE, and they are allowed to
> disagree forever.**

`midi-out-buddy.ts:217-229` is 13 lines of comment explaining why, and it is worth quoting
because the face's whole design question is downstream of it:

> *"`data.channel` is NOT ours. It is the WORKFLOW CHANNEL-COLUMN membership scalar … The
> column reconciler prunes any node whose `data.channel !== ch` out of column `ch`'s order
> array and adopts it into the column matching the new value — which also re-plans the
> lane's clip note-tap edges and re-binds the automation lane. So a card that wrote
> `data.channel` to set its MIDI output channel was silently REASSIGNING ITS LANE (and
> losing its clip assignment) on every channel change."* (#1168)

So the module has one control (`CH`) whose value is read from one key, written to a
different key, and **defaults to a third thing** — `effectiveMidiOutChannel` (`:264-268`) is
`override ?? lane ?? 1`.

⚠ **A generic face path cannot express that, and this is the sharp version of the
"where does state live" question.** A `ParamDef` has one storage location. This control has
a read key, a write key, a fallback chain and an invariant (`isMidiOutChannelOverridden`,
`:275-283`). **It is not a param and must not be made one.** The `fullViewBody` is not a
convenience here; it is the only shape that fits.

---

## 1. WHAT THE MODULE IS FOR

**One sentence:** it lets the rack play a hardware synth.

The verb is *patch a gate and a pitch into it and the hardware sounds*. Its sibling is the
same idea pointed the other way, and the def says so in its first line: *"the OUTPUT
complement of MIDI-CV-BUDDY"*.

The one thing it does that its siblings do not: **it is the only module in the cohort whose
correct behaviour depends on where it sits in the rack.** In a channel lane it follows the
lane by doing nothing at all (no write — `:225-229`). Dragged to another column, it follows
again. Overridden, it stops following and keeps its clip assignment. That is a real,
non-obvious behaviour, and the card was built to make its one dangerous state visible.

Two engineering details worth carrying, because a face author will otherwise flatten them:

* **The sounding note is TRACKED, not recomputed.** `:22-25` — the NoteOff targets the note
  that was actually turned on, *"even if `pitch` drifted while the gate was held (a slow
  glide under a held gate must not strand the original note)"*.
* **All-notes-off on dispose AND on device change** (`:29-31`). Deleting the module cannot
  strand a note on external gear. **Nothing on the face may bypass that path** — in
  particular, a device picker in a `fullViewBody` must call the same `selectDevice` the card
  calls, not re-implement selection.

---

## 2. STOP 1 — is promoting this module a PARITY LOSS?

**No.** Verdict: **PROMOTE.**

Neither filed refusal applies: there is no XY pad to collapse (#1974) and no canvas the
shell cannot paint (#2065). The card's controls live inside `PatchPanel`'s slot
(`:195-249`), so the lane tier ladder never showed them and cannot lose them.

⚠ **The one thing that COULD have been a parity loss is the override badge, and it is
not** — see §6.1. The finding it carries survives on a channel the card already has.

---

## 3. STOP 2 — does every way of getting DATA IN survive?

```sh
grep -nE '<button|<select|<input|oncontextmenu|manualTrigger|Toggle|Selector|accept=' \
  packages/web/src/lib/ui/modules/MidiOutBuddyCard.svelte
```

| # | line | affordance | survives as |
|---|---|---|---|
| 1 | `:198` | `Connect MIDI…` | `fullViewBody` button — **shared with midiCvBuddy** (BINDERS §3) |
| 2 | `:213` | OUT `<select>` over `cardState.devices` | `fullViewBody` `<select>`, roster via `read('card-api')` |
| 3 | `:223` | CH `<select>` 1..16 | `fullViewBody` `<select>`. ⚠ writes `midiOutChannel` ONLY — §0.1 |

**Three hits, three mappings. Nothing is unrepresentable.**

**Plus the non-interactive elements the grep does not catch:**

| | line | what | verdict |
|---|---|---|---|
| 4 | `:204-206` | `accessMessage` error line | ✅ **KEPT** — the outcome of a gesture, not resting text. (This module is already the CORRECT one; its sibling is being fixed to match — `../midiCvBuddy/spec.md §3.2`) |
| 5 | `:208` | `"Click to grant MIDI access (one-time per origin)."` | ⛔ REMOVED. Same as the sibling |
| 6 | `:230-238` | the `↯ CH n ≠ LANE m` badge | ⛔ text REMOVED, **signal KEPT** — §6.1 |
| 7 | `:240-246` | `NOTE` readout + lit dot | ⛔ text REMOVED, **dot KEPT** — BINDERS §2.1 |

**STOP 2 passes.**

### 3.1 ⚠ AND ONE AFFORDANCE THAT IS NOT ON THE CARD AT ALL

`:162-165`:

```ts
// Keep the engine's send-channel in step with the derived effective channel,
// so a module that has NOT been overridden still follows its lane when it is
// moved between columns (setChannel is idempotent — a no-op when unchanged).
$effect(() => { const ch = channel; getApi()?.setChannel(ch); });
```

**This is a card-hosted `$effect` doing engine work, and promotion deletes the card.**

If the `fullViewBody` does not carry it, then a module dragged between channel columns
stops following its lane — a **silent** regression that only appears after a drag, on the
one behaviour this module's own def spends 13 lines explaining.

⚠ **And a `fullViewBody` is DOCK-ONLY.** `dockFullViewHeadPlan` renders it in the dock full
view and nowhere else, so an effect that lives there runs **only while the dock is open on
this node** — which is strictly worse than the card, and worse in a way that is easy not to
notice, because the common test path opens the dock.

**This is a real design problem and the spec must not hand-wave it. Two routes:**

| route | assessment |
|---|---|
| **(a) Move the reconciliation INTO THE ENGINE.** The factory already reads `node.data` and already owns `setChannel`. Have it derive the effective channel from live `node.data` rather than being pushed a value by a UI component | ✅ **RECOMMENDED.** It is where the logic belongs, it removes a UI→engine push entirely, and it makes the behaviour independent of whether any surface is mounted. `effectiveMidiOutChannel` is already a pure exported function (`:264-268`), so the engine can call the same one the UI calls |
| (b) Put the `$effect` in the `fullViewBody` | ✗ correctness now depends on a dock being open. Rejected |

**Route (a) is a real code change and it belongs in this PR**, because promotion is what
removes the surface the behaviour currently depends on. It is the clearest instance in this
wave of the module-faceplates STOP-2 rule biting on something that is not a `<button>`.

⚠ **The generalisable lesson, which is why this is written out:** STOP 2's grep finds
affordances a USER operates. It is structurally blind to a component-lifecycle side effect
— an `$effect`, an `onMount`, a subscription — that the card performs on the user's behalf.
**Those die on promotion exactly as buttons do, and no grep in the skill finds them.**
Grep the card for `$effect(` and `onMount(` as well, on every module in this cohort.

---

## 4. THE LANE PICTURE — refused, and this is the strongest refusal in the wave

BINDERS §5. `outputs: []` (`:324`) — **there is no output port of any type.** Not merely no
`audio` port: no port. `primaryAudioOutPortId` cannot resolve, every glyph literal falls to
`{kind:'static'}`, and the dead-glyph clause reddens unconditionally. `glyph: 'none'`.

**The lane tile after promotion:** title + four input jacks (POLY / GATE / PITCH / VEL) and
no controls, since there are no rankable params. Same as today.

⚠ **One thing DOES change in the lane and it must be checked:** the card's override
OUTLINE. `:258-259` styles `.mod-card[data-ch-override='true']`, and after promotion there
is no `.mod-card`. **A `ModuleShell` tile has no such rule**, so the divergent-route signal
would silently vanish from the lane while surviving in the dock. §6.1 route (b) is the fix.

---

## 5. THE FACE

```ts
face: {
  glyph: 'none',          // forced — outputs: [] (§4)
  order: [],              // params: [] — nothing to rank
  extension: 'midi-out-buddy',
}
```

One band, no pages, no rail (`DOCK_TAB_MIN_BANDS = 7`). No hero — there are no keys to move.

**The body**, three rows plus one state:

```
┌──────────────────────────────────────────┐
│  [ Connect MIDI… ]                       │   ← state A
└──────────────────────────────────────────┘

┌──────────────────────────────────────────┐
│  OUT      [ Elektron Digitone       ▾ ]  │   ← state B: bound, following lane
│  CH       [ 3                       ▾ ]  │
└──────────────────────────────────────────┘

╒══════════════════════════════════════════╕   ← state C: OVERRIDDEN.
│  OUT      [ Elektron Digitone       ▾ ]  │     violet plate outline, NO badge text
│  CH       [ 9                       ▾ ]  │
╘══════════════════════════════════════════╛
```

### 5.1 WIDTH — COMPACT, and narrower than its sibling

`.midi-out-buddy-card { width: 220px; }` (`:253`), same geometry as midiCvBuddy. **Two rows
instead of four.** Nothing here is a live picture, scope trace, video preview or XY pad.
**Nothing earns width.** ~300 px, for the same long-port-name reason, and no exemption entry.

---

## 6. RESTING TEXT

BINDERS §2. The two module-specific calls:

### 6.1 ⚠ THE OVERRIDE BADGE — the finding that survives, and the one thing that narrows

BINDERS §2.2 carries the full argument. The short version, because it is the reviewable
call on this module:

**Deleted:** `↯ CH 9 ≠ LANE 3` (`:236`) and its `title=` sentence (`:234`). A hover reveal
is *"there but hidden"*, refused by name, so the tooltip goes with the badge.

**Kept:** the `[data-ch-override='true']` violet outline (`:258-259`), which the card's own
CSS comment describes as chosen so *"a divergent route is unmistakable"* and explicitly
*"Outline + shadow only, so the card's geometry never shifts."*

**Why the outline is not covered by the ruling:** the ruling enumerates TEXT roles and its
own wording is *"A value, a measurement, a state word or a sentence has no place."* A
colour is none of those. The same principle keeps the activity dot (BINDERS §2.1) and is
the reason `rear-direction.ts` carries direction on four NON-COLOUR channels — meaning
without printing it is an established idiom here, not a loophole.

**Two build consequences:**

1. **The face must reproduce the outline on the PLATE**, and — per §4 — on the LANE TILE
   too. `ModuleShell` has no `data-ch-override` rule today. This is the one piece of new
   CSS the face needs.
2. **The e2e is unaffected.** `:189-190` says it outright: *"data-ch-override is BOTH the
   styling hook and the state the e2e reads: one source of truth."* The specs read the
   attribute, not the badge text, so **no assertion is weakened by the removal** — the same
   property that let the original readout deletion land cleanly.

⚠ **WHAT GENUINELY NARROWS**, stated because CLAUDE.md requires it: the badge names the two
numbers; the outline says only *that* they differ. The numbers move to `aria-valuetext` on
the CH cell (`"channel 9; this module's lane is 3"`) — speakable, assertable, unpainted. A
sighted player now sees *something is off-lane* and must open the cell to learn *what*.
**That is a real reduction in at-rest information and it is the ruling's intended trade,
not an oversight.**

### 6.2 THE NOTE READOUT — text out, dot in

`:240-246` is a `NOTE` label, a note-name value, and a lit dot. **The dot already exists on
this module**, which is why midiCvBuddy's face borrows it rather than inventing it.

Text out (`aria-valuetext` on the OUT cell). Dot kept. ⚠ **The dot here is genuinely live**
— it is driven by `cardState.activeNote`, updated on the scheduler tick (`:41-46`). At
rest, with nothing patched into GATE and no device connected, it is dark and stable, which
is the VRT state. **Verify rather than assume** (§13); `analogVco` was dropped from a batch
for a live surface that measured **254 / 154 / 315 px across three captures of one tile**.

---

## 7. WHERE STATE LIVES

| key | lives | owner | face path |
|---|---|---|---|
| `channel` (LANE) | `node.data` | ⚠ the **channel-column reconciler** — READ-ONLY here | read only; never written |
| `midiOutChannel` | `node.data` | this module's card | `fullViewBody` CH cell |
| `lastDeviceId` | `node.data` | this module's card | `fullViewBody` OUT cell |
| tracked sounding note, access | engine closure | the scheduler tick | not persisted |

**No migration.** No key changes name or type; a patch saved before the face loads after it.

⚠ **`writeData` is untagged** — `:135-143`, byte-for-byte the same helper as
`MidiCvBuddyCard.svelte:89-97`. BINDERS §4. Same fix, same PR: wrap in
`ydoc.transact(fn, LOCAL_ORIGIN)`.

---

## 8. THE e2e SURFACE

### 8.1 The module's own spec

| line | test | after promotion |
|---|---|---|
| `:41` | drops + mounts with **EVERY declared input handle**, no console errors | ✅ survives — and it is the gate that caught the poly-jack regression the card's own comment describes (`:167-173`: expected 4, got 3) |
| `:88` | the capture buffer exists and is empty before anything sends | ✅ unaffected — instrument-level |
| `:133` | `Connect MIDI…` reveals the OUT device + channel selectors | ⚠ **moves to the DOCK.** `fullViewBody` is dock-only |
| `:150` | SEQUENCER gate/pitch → captured MIDI NoteOn on the fake output | ✅ unaffected — it drives the graph, not the card |

Three of four survive untouched; one is a surface re-point. ⚠ **Say the surface change in
the PR body** — a re-point that silently converts a lane assertion into a dock assertion is
how a spec ends up asserting something it no longer means.

### 8.2 ⚠ `workflow-channel-columns.spec.ts` — check what it reads BEFORE building

It is in the grep hits for this module and it is the spec that covers the #1168 behaviour.
**If any assertion in it reads the badge TEXT rather than `data-ch-override`, the badge's
removal breaks it** — and if it reads the attribute, nothing changes.

`:189-190`'s comment claims the attribute is the single source of truth. **Verify that claim
against the spec file rather than trusting the comment.** This is the one place in this
module where a comment and a test could have drifted apart, and a comment does not gate.

### 8.3 The #2166 class

Not in `_face-fixtures.ts`'s `DENIED` map; not in `LEGACY_DOCK_CANDIDATES`. Nothing inherits
the repaired `scope` hazard.

⚠ **But `scripts/test-reconciliation.test.ts:287` names `midiOutBuddy`** in a list with
`audioOut`, `sticky` and `livecode`. Read what that list IS before promoting — a
reconciliation fixture whose precondition is "un-faced" is exactly the green-and-blind class,
and its name gives no hint either way.

---

## 9. VRT

`EXEMPT_FROM_VRT:725` — *"same rationale as midiCvBuddy"* — plus `PERMANENT:1175`.

**The decision is taken at `midiCvBuddy`, not here** (BINDERS §6: one rationale, cited four
times). If the sibling discharges, this discharges with it in the same sweep. Whatever
happens, both lists move together — set equality is asserted, so **a one-sided delete is
RED** — and `task test:ledger:accept` runs after.

After: 2 face scenes added.

---

## 10. COST

| | |
|---|---|
| **WebGL attest** | **ZERO** — not in `webgl-attest-lib.ts`'s basis |
| **ART** | **ZERO** — `outputs: []`, a terminal MIDI sink with no audio path |
| **contract-lock** | **UNCHANGED** — no param added; `face` is fully contract-transparent. ⚠ Expect an EMPTY `docs:accept` diff, and if it is not empty something in §0.1 is wrong |
| **Push 2** | **UNCHANGED** — `params: []` |
| **docs** | already `STRICT_DOCS:227`, all four inputs documented in `module-manifest.ts:775-777` |
| **VRT** | 2 added; exemption follows the sibling's decision |
| **CI wall-time** | zero param cells; ≈ 10 s faces-parity + 2 VRT scenes. Under the ~2 min threshold |
| ⚠ **BOTH cost artifacts** | re-pin `e2e-timings.generated.json` AND `vrt-strict-timings.generated.json` |

---

## 11. DEFECT LEDGER — folded into this PR

| # | defect | where | fix |
|---|---|---|---|
| D1 | `node.data` writes untagged — Cmd-Z does not undo a device or channel change | `:135-143` | `ydoc.transact(fn, LOCAL_ORIGIN)`. BINDERS §4 |
| D2 | **the lane-following `$effect` dies with the card** — a module dragged between columns silently stops following its lane | card `:162-165` | move the reconciliation into the engine factory, which already owns `setChannel` and already reads `node.data`. §3.1 route (a) |
| D3 | the override outline has no `ModuleShell` equivalent — the divergent-route signal vanishes from the LANE on promotion while surviving in the dock | `:258-259` vs `ModuleShell` | one CSS rule on the shell tile, keyed on the same `data-ch-override`. §4 |

D2 is the one to read carefully. It is not a bug on `main` — it is a **defect that
promotion CREATES**, which is a different and more dangerous category, because it does not
exist until the PR that must also fix it.

---

## 12. TASTE CALLS

| call | revert |
|---|---|
| the override signal is an OUTLINE and nothing else | re-add the badge — but it is text, so this is a ruling change, not a taste change |
| the outline is added to the LANE tile as well as the plate | drop the shell CSS rule; the lane then loses the signal |
| CH stays a 16-option `<select>` rather than a segmented | render segmented — sixteen segments is a wall of digits |
| the lane-following logic moves into the engine | keep it in the body, and accept that it only runs while the dock is open |

---

## 13. MUST-VERIFY

1. **`workflow-channel-columns.spec.ts` reads `data-ch-override`, not badge text.** §8.2.
   A comment claims it; a comment does not gate.
2. **`test-reconciliation.test.ts:287`'s list is not an un-faced-fixture precondition.** §8.3.
3. **The activity dot is VRT-stable at rest.** §6.2.
4. **The lane tile is otherwise unchanged** — screenshot before/after. §4.
5. **`docs:accept` is EMPTY.** §10.
6. **The `fullViewBody`'s device picker calls the same `selectDevice`** the card called, so
   the all-notes-off-on-device-change path (`:29-31`) is not bypassed. §1.
7. **Grep the card for `$effect(` and `onMount(`, not just for `<button|<select>`.** §3.1 is
   the reason, and it applies to every module in this cohort.

---

## 14. VERIFICATION GATE

```sh
# 1. the rulings' source gates FIRST
flox activate -- task test:one -- face-resting-text-source
flox activate -- task test:one -- face-readout-source
flox activate -- task test:one -- face-width-source

# 2. face lint + promotion anchor (both directions) + plans
flox activate -- task test:one -- module-face-lint
flox activate -- task test:one -- curated-face
flox activate -- task test:one -- dock-row-plan
flox activate -- task test:one -- dock-faceplate-model

# 3. extension registry + shell module-freedom
flox activate -- task test:one -- shell-extensions
flox activate -- task test:one -- module-shell-import-guard

# 4. the module's pure core — D2 moves logic INTO it, so this is the real gate
flox activate -- task test:one -- midi-out-buddy
flox activate -- task test:one -- mutate.guard

# 5. registries + neighbours
flox activate -- task test:one -- rear-card-model
flox activate -- task test:one -- push-card-schema   # expect NO diff
flox activate -- task test:one -- module-docs-lint
flox activate -- task docs:check                     # expect NO diff

# 6. VRT exemption set equality (a one-sided delete is RED)
flox activate -- task test:one -- vrt-exemptions
flox activate -- task test:ledger:accept

# 7. e2e — the module's spec, the channel-column spec (D2 + §8.2), faces-parity
flox activate -- task e2e:serve
REPEAT=3 flox activate -- task e2e:one -- tests/midi-out-buddy.spec.ts
REPEAT=3 flox activate -- task e2e:one -- tests/workflow-channel-columns.spec.ts
REPEAT=3 flox activate -- npx --workspace e2e playwright test faces-parity --grep midiOutBuddy
flox activate -- task e2e:stop

# 8. typecheck LAST
flox activate -- task typecheck

# 9. VRT: dispatch only, SCOPED. Predict TWO files. COUNT them. NEVER commit a PNG.
GREP=midiOutBuddy flox activate -- task vrt:commit

# 10. BOTH cost artifacts
flox activate -- task e2e:timings:accept -- <run>
flox activate -- task vrt:strict:timings:accept -- <run>

# 11. attest: NIL.
```

---

## 15. VERDICT

**PROMOTE.** ONE PR. Risk **LOW/MEDIUM**. Estimate **≈ 7 h**.

Build it **second**, after `midiCvBuddy`, so it inherits the shared binder body rather than
authoring it.

The MEDIUM half of the risk is entirely D2 — **a defect that promotion creates rather than
one it inherits.** It is the wave's clearest demonstration that STOP 2's grep, as written in
the skill, is blind to component-lifecycle side effects: a `$effect` that reconciles the
engine on the user's behalf dies on promotion exactly as a button does, and nothing in the
checklist looks for it.

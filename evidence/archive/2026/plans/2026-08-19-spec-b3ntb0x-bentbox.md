# §27 — FACEPLATE BUILD SPEC · `b3ntb0x` + `bentbox` (2026-08-19)

**Read against `28761a17` (`fix/mandelbulb-glyph-trap`, which carries
`origin/main` @ `6d6980ca` merged in).** Format follows
`.myrobots/plans/faceplate-queue-2026-08-14.md` §25.3–§25.8 / §26.3–§26.7.

⚠ **METHOD, AND ITS LIMIT, STATED FIRST.** A real-GPU attest and a MIRROR
re-attest are in flight and another agent is committing in this checkout, so
this lane ran **NO** vitest, **NO** e2e, **NO** attest and **NO** `gh`. Every
figure below is therefore **DERIVED-BY-READING** unless it carries the word
MEASURED, and the only MEASURED numbers quoted are ones already **recorded in
committed source** (the merged harness spec's header) and re-cited here, not
re-run. Where a figure is float32-precision-dependent this spec **refuses to
print it** and names it as a claim for the GLSL harness instead — that
distinction is the point of §27.6.

⚠ **THIS SPEC SUPERSEDES §24 OF THE QUEUE ON FOUR POINTS**, all of which went
stale under it. They are called out inline as ⟵ **§24 STALE**.

---

## 27.1 THE RELATIONSHIP, settled from the code — a FAMILY, not a superset pair

**They are two independent implementations of one aesthetic, and the shared
logic is DUPLICATED, not shared.**

| evidence | file:line |
|---|---|
| lineage declared in the source: *"a circuit-level NTSC composite RE-ARCHITECTURE of BENTBOX"* | `b3ntb0x.ts:3` |
| *"NOTHING is imported from BENTBOX / TOYBOX / QUADRALOGICAL"* | `b3ntb0x.ts:51` |
| mirror helpers labelled *"(clean, NOT imported from bentbox)"* | `b3ntb0x.ts:138` |
| CPU mirror fold labelled *"ported clean … NOT imported from bentbox"* | `b3ntb0x-dsp.ts:266-268` |
| the suite treats them as ONE class | `strict-docs.ts:358-359` (adjacent) · `vrt-exemptions.ts:681,687,1048` · `per-module-per-port-behavioral.spec.ts:218` (*"the bentbox / b3ntb0x / backdraft animated-video variance class"*) |

**The param-id intersection is EXACTLY FOUR** — `mirrorX`, `mirrorY`,
`mirrorXGate`, `mirrorYGate` (DERIVED-BY-READING, `b3ntb0x.ts:781-784` ×
`bentbox.ts:489-494`). Of bentbox's 12 bending knobs, **zero** exist on b3ntb0x
by id, and vice versa. Different palette groups (`Processors` vs `Utilities`),
different architectures (4 GLSL passes / 6 FBOs, two RGBA16F, vs 1 pass / 2
RGBA8).

> **So: TWO faces sharing ONE family LAYOUT and ONE extension pattern. The only
> control block you may legitimately share is MIRROR X / MIRROR Y (+ their two
> `noUserControl` gate params). Any sentence of the form "b3ntb0x is bentbox
> with more knobs" is FALSE** — and §27.8 lists **three** places where the two
> modules implement the *same named thing* in *opposite* ways, one of which
> b3ntb0x's own source comment identifies as the bug bentbox still has.

### 27.1a What both share (DERIVED-BY-READING, so it is not restated per entry)

| property | b3ntb0x | bentbox |
|---|---|---|
| params (total / user-facing) | 22 / **20** | 16 / **14** |
| inputs (video / cv / gate-shaped cv) | 1 / 16 / 2 | 1 / 12 / 2 |
| outputs | 1 (`out`, `type:'video'`) | 1 (`out`, `type:'video'`) |
| **any `type:'audio'` output** | **NO** (`:759-761`) | **NO** (`:464-468`) |
| declares `face` | no | no |
| declares `noUserControl` | **needed (2)** | **needed (2)** |
| in `STRICT_DOCS` | yes (`:358`) | yes (`:359`) |
| card passes `readLive` | **YES — all 18 knobs** (`B3ntb0xCard.svelte:339-359`) | **YES — all 12 knobs** (`BentboxCard.svelte:370-383`) |
| multi-state enum lacking `options[]` | 0 | 0 |
| any `curve:'discrete'` param | **0** | **0** |
| genuine BOOLEAN declared `curve:'linear'` | **2** (`mirrorX`,`mirrorY`) | **2** (`mirrorX`,`mirrorY`) |
| determinism/freeze seam | `globalThis.__b3ntb0xFreezeTimeSec` (`:948`) — **not a param** | `globalThis.__bentboxFreezeTime` (`:637`) — **not a param** |
| `pullExempt` / `audioSources` / `audioInputs` / `subscribePulse` | none | none |
| in `EXEMPT_FROM_VRT` + `ALLOWED_PERMANENT_EXEMPT` | yes | yes |
| in `modules-card-map.test.ts` `EXPECTED_NODE_TYPES` | **NO** | yes (`:38`) |
| in `push-card-config.ts` / `workflow-shell-faces.spec.ts` FACES / `DESCRIPTIONS` / `card-def-agreement` | no | no |
| behavioral sweep exemption | WHOLE-MODULE (`:376`) | NARROW, timing only (`:359`) |

- ⟵ **§24 STALE (1): "card passes ZERO `readLive`" is no longer true of either
  card.** Both now bind `readLive={live(...)}` on every knob. **So "the face
  fixes a live CV-blindness defect" is NOT available as merit here** — do not
  copy that sentence from the §25 cohort into these PRs. What the face buys is
  the tab rail, the pages, the readouts and the STOP-2 story, not `readLive`.
- ⟵ **§24 STALE (2): `card-def-debt.ts` no longer ledgers b3ntb0x's
  `burst_starve` / `chroma_leak` label debt** — the file carries no entry for
  either module today. The *divergence still exists* (card prints `Burst Strv` /
  `Chroma Lk` at `B3ntb0xCard.svelte:343,345`; the def says `Burst Starve` /
  `Chroma Leak` at `b3ntb0x.ts:767-768`), and the dock renders the **DEF's**
  label — so **the user-visible rename is still owed, it is simply no longer
  ledgered anywhere.** Plan band width for the longer strings and say so in the
  PR body.
- **`noUserControl` now has TWO adopters, not one** (`backdraft.ts`,
  `spirographs.ts` — grep of `noUserControl:` under `lib/*/modules/`), so these
  two are the third and fourth and there is a copyable precedent.

---

## 27.2 ⟵ §24 STALE (3): THE `fullViewBody` BLOCKER IS GONE, AND THERE ARE ALREADY TWO ADOPTERS

§24 built its whole risk argument on *"the slot has been WIRED since #1732 with
ZERO adopters"*. Both halves are now wrong:

- `shell-extensions.ts:124` — `WIRED_SHELL_EXTENSION_SLOTS = ['glyph',
  'fullViewBody']`.
- `shell-extensions.test.ts:163-176` pins that the slot has *a real render site*
  (read in code, mounted, queryable by testid) and that **the dock gating lives
  in ONE place** (`dockFullViewHeadPlan`).
- **Two modules already declare it**: `backdraft.ts:3313`
  (`extension: 'backdraft'` → `ui/modules/backdraft/BackdraftOutputBody.svelte`)
  and `video-out.ts:139` (`extension: 'videoOut'` →
  `ui/modules/videoOut/VideoOutBody.svelte`).

**Consequence for the plan:** this is no longer "a platform-adoption PR wearing
a face". It is a face PR that **copies a landed body twice**. §24's recommended
split (land the extension first, THEN the faces) is withdrawn — the extension
render site is already gated by someone else's tests.

⚠ **AND THE COPY IS NOT FREE OF A DECISION.** The shared
`VideoCanvasContextMenu` carries three optional actions **neither card wires**:
`ondetach` / `onreattach` (#1821, guards at `VideoCanvasContextMenu.svelte`
`{#if ondetach && !isDetached}` / `{#if onreattach && isDetached}`) and
`ondelete`. `VideoOutCard.svelte` and `videoOut/VideoOutBody.svelte` are the
**only** two files in the tree that pass `ondetach=`. So when the b3ntb0x /
bentbox bodies are cloned from `VideoOutBody`, **detach will arrive by accident
unless it is a decision.** Decide it, write it down, and do not let a
copy-paste be the reason a module grew an affordance.

---

## 27.3 THE SCREEN ON/OFF CELL — spec it ONCE, adopt it twice

Both modules own a preview canvas, so both are in scope for the owner ruling
(`.claude/skills/module-faceplates.md:126-153`).

| module | preview testid | blit seam | fullscreen wrap testid |
|---|---|---|---|
| b3ntb0x | `b3ntb0x-canvas` | `blitOutputForPreview(id)` (#1802-gated, `B3ntb0xCard.svelte:183`) | `b3ntb0x-fs-wrap` |
| bentbox | `bentbox-canvas` | `blitOutputForPreview(id)` (#1802-gated, `BentboxCard.svelte:207`) | `bentbox-fs-wrap` |

**Both already use the gated seam, so the cell has one template and no
per-module seam question** (unlike `outlines` in §25.2, which reads a
`sceneCanvas`). Copy `BackdraftOutputBody.svelte:120-138, 294, 311-318`:
`node.data.previewCollapsed`, `data-preview-collapsed` on the wrap, the button
reading `SCREEN ON` / `SCREEN OFF`.

**⚠ GEOMETRY IS SETTLED AND IT IS A MEASUREMENT, NOT A TASTE: OVERLAY the
preview's BOTTOM-RIGHT CORNER on a translucent backplate (`rgba(5,6,8,0.72)`),
NEVER a row of its own.** Precedent spirographs (`592ca4f6b`); a stacked row
cost **~18.8 px on a card carrying ~11 px of slack** and `io-spec-consistency`
caught the 7.8 px overhang against a tolerance of 6
(MEASURED — recorded at `module-faceplates.md:137-153`, not re-run here). Keep
the wrap's small `min-height`: it is inert behind the canvas and only matters
with SCREEN **off**, where an absolutely-positioned button would otherwise
leave the card.

### ⚠ THE PRODUCER HAZARD IS SHARPER HERE THAN THE RULING'S GENERIC FORM

The ruling says "the module KEEPS RENDERING". On these two the reason is
mechanical and module-specific, and it is stronger than the #1720/#1721 stale-
frame argument:

1. **The blit IS the watch mark.** `engine.ts:1583-1634`: `blitOutputForPreview`
   calls `markWatched` **only** after its gate passes (`:1632`), and the header
   says so — *"because the blit IS the watch mark, no `markWatched` — so the
   node stops being a pull root and its whole upstream chain stops rendering."*
2. **Neither module is pull-exempt.** `engine.ts:1123-1130` exempts a node only
   for non-empty `audioSources` / `audioInputs`, a `subscribePulse` function, or
   a def-level `pullExempt`. b3ntb0x's and bentbox's handles declare **none** of
   the four (`b3ntb0x.ts:1079-1098`, `bentbox.ts:681-697`), and `pullExempt`
   appears in no video def.
3. **Freezing these two does not merely stale a frame — it stalls a STATEFUL
   ANALOG SIMULATION.** b3ntb0x's AC-coupling baseline is a genuine cross-frame
   one-pole integrator living in the bend ping-pong's `.a` channel
   (`b3ntb0x.ts:302-303, 374, 975-976`), its CRT persistence is a second
   ping-pong (`:1018-1019`), and `uFieldParity` is driven by `framesElapsed &
   1` (`:1030`) so the interlace phase stops advancing. bentbox has the same
   feedback ping-pong (`:604-605`) and parity (`:642`). **A SCREEN-OFF that
   stops the draw therefore returns a picture whose analog state is stale by
   however long the user looked away** — which is not what "the preview is
   collapsed" promises.

**So the cell must keep the node a pull root while collapsed** (a render lease,
or an explicit `markWatched`), exactly as backdraft does. The e2e leg proving
it must gate on the **`framesElapsed` counter delta** — a monotone integer,
renderer-independent, and both modules already surface it through
`read('framesElapsed')` (`b3ntb0x.ts:1090`, `bentbox.ts:693`) — with pixel
distinctness as an *additional*, capability-probed leg, never the precondition
(§25.2's #1847 lesson). ⚠ And do **not** reach for `read('hasInput')` as the
liveness probe: see DEFECT **D7**, it returns `framesElapsed > 0` on both.

**Tab-persistence:** put the invariant in a PURE unit
(`<mod>-face-model.test.ts`) asserted over every declared page — the collapsed
flag is NODE-keyed and is not per-band render state — and keep **exactly one**
e2e leg (one switch away and back). b3ntb0x has **8 pages**, so the naive
loop-every-tab spec would be 8 chances to lose one coin flip.

---

## 27.4 Q38 · `b3ntb0x` — a four-stage analog pipeline whose headline gesture is switched OFF by a default, and whose fourth bend tap is its first one wearing a different name

**Merit: YES, and it is the strongest video candidate in the bank.** 22 params
(**20 user-facing** + 2 `noUserControl`), 19 inputs (1 `video` + 16
`paramTarget` CV + 2 gate-shaped CV), 1 `video` output. `palette: {top:'Video
modules', sub:'Processors'}`, `category:'output'`.

STOP 1 refuses only when **all** of ≤2 params / no control families / no
`node.data` affordances / no derived quantity worth a readout hold. b3ntb0x
fails every clause: 20 controls across four genuinely different circuit stages,
three `node.data` affordances, and two derived quantities that no single knob
can express (§27.4d). There is nothing marginal here.

**Control-heavy: YES, and unlike ruttetra (§25.3) the rail is NOT marginal.**

### 27.4a THE RANKING ARGUMENT, FROM THE DSP

The module synthesises a per-column composite VOLTAGE with real sync, bends
*that voltage*, then demodulates and renders it. So the ranking descends from
**what the signal passes through, in order**:

`encode (picture → voltage)` → `couple → GAIN → bias → bend A-D → soft-clip +
diode clamp` → `recover sync → 13-tap quadrature demod → hue → leak → peak` →
`CRT`.

**`sync_crush` is the only control every other control's signal passes
through** — it multiplies the whole composite at `:314`, before bias, before
the bends, before the nonlinearity. That is the hero on the DSP's own terms.

⚠ **AND IT IS THE "CHECK YOUR HERO FOR INERTNESS AT SPAWN" CLAUSE FIRING.** At
the shipped `tbc = 1` (`:719`), `recoverLineOffset` returns
`(rawOffset + wobble) * (1.0 - tbc)` = **exactly 0.0** (`:443`), so **no amount
of Sync Crush or Bias can displace a single line.** The controls still change
amplitude and clipping; the *tearing and rolling the module is named for* is
gated off by a default. The module's own explanation instructs the player to
*"Crank Sync Crush + Bias to tear and roll the picture"* (`:788`) — **at
factory settings that instruction cannot work**, and the `tbc` control doc
(`:826`) states the opposite behaviour correctly. Two doc sentences that
contradict each other operationally. Filed as **D2**.

**Recommendation: hero = `sync_crush` anyway, and land D2's default fix FIRST,
in its own owner-preview commit** (§25.3's rule: a behaviour fix is its own
commit, so the face re-baselines once instead of twice). The alternative —
hero = `tbc` — is refused with an argument: TBC is a *corrector*, not a
gesture; promoting the corrector to hero would enshrine the defect as the
design.

Displacement the timebase delivers, **DERIVED-BY-READING** (`:421-443`; 1 output
px = `(1 − ACTIVE_START)/VIDEO_RES.width` = `0.84/1024` = 8.2031e-4 of a line):

| state | recovered offset (line-frac) | **output px @ 1024** |
|---|---|---|
| `tbc = 1` (**shipped**), any sync_crush/bias | 0 exactly | **0.00** |
| clean sync, `tbc = 0`, static term | +0.003333 (scan lands at k=14) | **+4.06** |
| clean sync, `tbc = 0`, wobble term | ±0.012 (`:441`) | **±14.63** |
| crushed sync, `tbc = 0` (scan fires at k=0) | −0.055 | **−67.05** |
| ⚠ scan QUANTUM (`0.10/24`, `:427`) | 0.0041667 | **5.08 px — the finest step the corrector can see** |

⚠ **Two facts nothing in the tree states.** (a) The tear is not a smooth
displacement: each scanline independently either finds its edge at k=14 or at
k=0, so a crushed line **jumps 71.1 px in one step** — the "tear" is
mechanically a per-line two-state snap. (b) Sync damage smaller than **5.08
output px is bit-exactly invisible** to the corrector. Filed as **D3**.

### 27.4b PAGES, BY FUNCTION — and the rail engages on BOTH honest groupings

| grouping | pages | membership |
|---|---|---|
| **(a) BY CIRCUIT STAGE — recommended** | **8** | `signal` (ac_dc, sync_crush, bias) · `bend` (bend_a…d) · `carrier` (burst_starve, sub_drift) · `timebase` (tbc, luma_peak) · `colour` (hue, enhance, chroma_leak) · `tube` (feedback, tube_bloom) · `glass` (overscan, barrel) · `fold` (mirrorX, mirrorY) |
| (b) glass+fold merged (both are CRT output-coordinate ops) | **7** | as above with `glass` = overscan, barrel, mirrorX, mirrorY |

**8 covers exactly the 20 user params (3+4+2+2+3+2+2+2). Both groupings clear
`DOCK_TAB_MIN_BANDS = 7` (`dock-tabs-model.ts:57`), so the tab rail engages
HONESTLY and this entry does NOT re-open §25.5's escalation.** That is the
sharpest structural difference from ruttetra, and it should be said in the PR
body: the threshold question is not this module's problem.

Grouping (a) is recommended because it *is* the module's architecture — the
four passes are named in the file header (`:11-47`) and the CPU mirror is split
the same way (`b3ntb0x-dsp.ts`). ⚠ **Do NOT derive the pages from the card's
own header comment** (`B3ntb0xCard.svelte:12-16`): it declares four groups of
6/4/4/4 and puts `Hue` under ENCODE/BEND, while the markup renders `Hue` in the
second row (`:348`) and the 5-column grid (`:517`) means **no declared group
lines up with a row** — `feedback` (a CRT param) paints inside the BEND row.
Filed as **D12**.

⚠ `order` and `pages` deliberately DISAGREE. `order` is priority; `pages` is
signal order. Say so in the comment.

**Tier ladder as a sentence:** at mini you get SYNC CRUSH; at compact you get
SYNC CRUSH and BIAS (the pair that is one gesture); at plate you get the whole
destruction story (sync_crush, bias, bend_c, bend_a, tbc, burst_starve); the
remaining fourteen are dock-only.

Rank order:
`sync_crush, bias, bend_c, bend_a, tbc, burst_starve | bend_b, bend_d, sub_drift, hue, enhance, chroma_leak, ac_dc, luma_peak, feedback, tube_bloom, overscan, barrel, mirrorX, mirrorY`.

⚠ **Two demotion arguments that are NOT taste.** `bend_d` sits below `bend_b`
because it is **`enhance` with a smaller coefficient** (D4) — ranking two
spellings of one operation adjacently at the top would be ranking the same
control twice. `enhance` and `bend_d` are both **bit-exactly inert on a
monochrome source with Bias at 0** (D5), so neither may be promoted to a tier
where a player is likely to be feeding a mono chain.

**Inertness-at-spawn sweep (DERIVED-BY-READING).** True nulls at their
defaults: `sub_drift` (`:224` `driftErr = 0`), `burst_starve` (`:491-496`
`colourKill = 1`, crawl 0), `hue` (`:504` θ=0), `luma_peak` (`:517` guarded),
`bend_a…d` (all guarded `> 1e-4`), `feedback` (`:656` guarded), `bias` (0),
`enhance` (0), `ac_dc` (0). Non-neutral shipped defaults, all CRT-look:
`chroma_leak` 0.15, `tube_bloom` 0.35, `overscan` 0.2, `barrel` 0.25 — plus
`tbc` 1 and `sync_crush` 1, whose *neutrality is the defect* (D2/D6).

### 27.4c GLYPH — `'none'`, and here is the VERIFICATION the brief demanded

`b3ntb0xDef.outputs` is exactly `[{ id: 'out', type: 'video' }]`
(`b3ntb0x.ts:759-761`). **There is NO `type:'audio'` output.** So
`primaryAudioOutPortId` (`outputs.find(o => o.type === 'audio')?.id`) returns
`undefined`, the generic video rule applies unchanged, and **any glyph literal
other than `'none'` resolves to `{kind:'static'}` and reddens
`module-face-lint`'s dead-glyph clause.**

⚠ **This was VERIFIED, not assumed, because the assumption has already failed
once.** `mandelbulb` is the one video def in the fleet that DOES publish a
`type:'audio'` output, where the mechanism does not fire and a glyph resolves
to `{kind:'live-audio'}` bound to a tap that structurally cannot see a
video-domain node — every def-reading gate green, the readout flat forever
(`packages/web/src/lib/ui/workflow/mandelbulb-glyph-tap.test.ts:1-46`). Neither
module here is that case.

**Assert `hasVideoSurface(def)` (`module-shell-model.ts:177`), not the glyph
declaration** — `'none' + blank tile` and `'none' + live thumb` are
indistinguishable from the declaration alone.

### 27.4d READOUTS — two, each with a permanent negative control; and two REJECTED with reasons

**R1 · `b3ntb0x-sync-shift` — the horizontal displacement the timebase actually
delivers, in OUTPUT PIXELS.** It is not any one knob: it is
`(rawOffset + wobble)·(1 − tbc)` where `rawOffset` is decided by whether
`sync_crush` × `bias` dragged the line above the −0.15 detector threshold
(`:428-431`).

- ⚠ **NEGATIVE CONTROL (permanent leg):** a knob readback of `tbc` is
  **structurally blind to `sync_crush` and `bias`**. Hold `tbc = 0.5` and sweep
  `sync_crush` 1 → 2: the printed shift must move from ≈ +2.03 px to ≈ −33.5 px
  while the `tbc` dial reads 0.5 at both.
- ⚠ **SECOND PERMANENT LEG (the one that makes the defect visible):** at
  `tbc = 1` the readout must be **exactly 0 px for every `sync_crush` and every
  `bias`**. A readout that keeps moving there is printing the uniform's
  argument, not the delivered shift.
- ⚠ **UNITS IN THE MESSAGE:** `output px @ 1024`, and the assertion text must
  carry the **5.08 px scan quantum** so a reader knows the number is a ladder,
  not a continuum.
- ⚠ **STATE ITS BLIND SPOT INSIDE ITSELF:** it is a per-line WORST CASE, not
  what any given scanline shows.

**R2 · `b3ntb0x-chroma-gain` — the total chroma multiplier the bend network
delivers.** `(1 + 2·enhance) · (1 + 0.8·|bend_d|)`. **This readout pays for
itself by making D4 visible**: two separately-labelled controls multiply the
same quantity.

| enhance | bend_d | delivered chroma × (DERIVED-BY-READING, `:312-313, :356-357`) |
|---|---|---|
| 0 | 0 | ×1.00 |
| 0.5 | 0 | ×2.00 |
| 1 | 0 | ×3.00 |
| 0.5 | 1 | **×3.60** |
| 1 | 1 | **×5.40** |

- ⚠ **NEGATIVE CONTROL:** a knob readback of `enhance` is blind to `bend_d`.
  Hold `enhance = 0.5` (dial says 0.5, ×2) and sweep `bend_d` 0 → 1: the
  printed gain must climb ×2.00 → ×3.60.
- ⚠ **SECOND PERMANENT LEG:** it must be **invariant to `hue`** (a rotation
  preserves magnitude, `:504-509`) and **invariant to `chroma_leak`** (which
  adds to LUMA, `:514`). A gain readout that moves on either is measuring
  something else.

**REJECTED · a HUE readout in degrees.** The merged harness spec already
refutes it: rendered, `0.9π` is a **shader constant and not a delivered one** —
MEASURED at three input hues (recorded in `e2e/tests/b3ntb0x-hue-claim.spec.ts:
20-27`, not re-run here) full travel delivers **172.5° / 157.7° / 161.9°**,
because the YIQ basis is not isotropic and a rigid rotation in (I,Q) arrives
warped in RGB. **A face printing "162°" would print the uniform's argument.**
And the input-independent half — *it never reaches 180°* — is a bound, not a
value; per the no-resting-numbers ruling a readout paints only when its text is
a declared option/landmark NAME with no `format` (`paintsReadout`), and `hue`
declares no options. **So: no Hue readout at all.**

**REJECTED · a CRUSH-STEPS readout.** `bend_c` maps monotonically to the step
count; printing it restates the dial. (It would, incidentally, have to choose
between two different step counts — see D22.)

**⚠ NOT A READOUT, AND THIS IS THE `cvBuddy` SHAPE: the `reduced precision (no
float FBO)` badge** (`B3ntb0xCard.svelte:215-216, 333-335`, testid
`b3ntb0x-reduced-precision`, fed by `videoEngine.read?.(id,'isFloat')` ←
`b3ntb0x.ts:1093`). A `FaceReadoutValue` is `(read: (paramId) => number |
undefined) => string` — **structurally unable to reach `read(id, 'isFloat')`.**
It is a real capability signal (see D23's 8192 cliff), so it **must move into
the `fullViewBody` extension body**, which holds the node id and the engine.
Losing it silently is the failure mode.

### 27.4e `bareCells`

**No candidate. Do not declare it.** Every label on this face is a distinct
circuit term (`Bias` / `AC/DC` / `Sync Crush` / `Burst Starve` / …) and none
restates its page heading. The nearest thing to mixmstrs' `1LO…8LO` is
`Bend A`/`B`/`C`/`D` under a `bend` heading — and those are **exactly the
tidyVco `A/D/S/R` case that STAYS**: the letters are the only thing separating
four otherwise-identical knobs whose four operations are unrelated (wavefold /
comb / crush / bleed). Dropping the captions there would make the page
unusable.

### 27.4f ⚠ STOP 2 — the card-only inventory, COMPLETE

Grep run exactly as the skill prescribes over `B3ntb0xCard.svelte` (hits: `:61,
62, 100, 105, 246, 247, 313, 323, 363, 371, 384, 387`). Every hit, mapped:

| card-only affordance | file:line | survives as |
|---|---|---|
| `oncontextmenu` → the ⛶ OUTPUT menu (Fullscreen ×N screens · Full Frame · Present ×N · Present-all · Stop presenting) | `:323`, `:391-406` | **`fullViewBody` extension body** (§27.2) |
| `node.data.fullFrame` (Y.Doc-synced, *"so a wall-of-TVs layout survives reload + is shareable"*) | `:100-109` | **extension body**, same `mutateNode` write |
| MIRROR X / MIRROR Y buttons | `:362-379` (testids `b3ntb0x-mirror-x/-y`) | **`face.order` params** `mirrorX`/`mirrorY` — but they need `face.paramCells: {mirrorX:'toggle', mirrorY:'toggle'}` or they paint as rotaries (§27.4g) |
| `reduced precision (no float FBO)` badge | `:215-216, 333-335` | **extension body** — NOT a readout (§27.4d) |
| corner RESIZE handle, raw `node.data.width/height` | `:234-253, 382-388` (testid `b3ntb0x-resize-handle`, `role="separator"`) | ⚠ **#1865 — UNRESOLVED, and it is a population of 8 pool modules, not a quirk.** The face PR must land a resizable video-surface cell **or carry a written exemption with an argument.** Functional parity is a hard requirement; silence is not an acceptable outcome. |
| per-frame engine→store reflect of `mirrorX/Y` (raw write, outside undo, so a GATE edge updates the buttons) | `:203-214` | ⚠ **This is the card-unmount class (#1531/#1574/#1583/#1723) verbatim** — already dead for anyone who has not docked the module. **A face PR neither causes nor cures it**; the fix is a NODE-keyed registry either way. Name it in the PR body so it is not mistaken for a regression the face introduced. |
| jack short labels (`ENH`/`BIAS`/`AC`/`CRSH`/`BRST`/`CHRM`/`LUMA`/`BNDA-D`/`FBK`/`TBC`/`BLM`/`OVSC`/`BARL`/`MIRX`/`MIRY`) | `:289-295` | derived via `portsFromDef` already — the face regenerates them from the def; **expect jack labels to change.** |
| knob labels `Burst Strv` / `Chroma Lk` | `:343, 345` | the def's `Burst Starve` / `Chroma Leak` — **a user-visible rename** (§27.1a) |

**Strings that exist ONLY on the card:** `reduced precision (no float FBO)`,
the two button captions `MIRROR X` / `MIRROR Y`, their two `title=` sentences,
`Burst Strv`, `Chroma Lk`, `Resize B3NTB0X`, and the menu title `B3NTB0X`.
Every one is accounted for above.

**No `<select>`, no `<input>`, no file loader, no momentary, no
`manualTrigger`** — verified by the grep. Nothing here is `samsloop`-shaped.

### 27.4g PARAMS WITH NO USER CONTROL, and the BOOLEAN-declared-`linear` pair

**`noUserControl` (2 entries, `writer: 'cv-port'`):** `mirrorXGate` and
`mirrorYGate` (`b3ntb0x.ts:783-784`). They are never uniforms — they exist only
to be edge-detected on the CPU (`:954, :957`) — and the def says so itself:
*"Read for edge detection, not as a continuous control"* (`:834-835`).

⚠ **CHECKED AGAINST THE DEF'S OWN PORTS, as the type requires.** `writer:
'cv-port'` is assertable in both directions: `mirror_x_gate` and
`mirror_y_gate` (`:756-757`) declare `paramTarget: 'mirrorXGate' /
'mirrorYGate'` and carry **no `cvScale`** (raw passthrough, deliberately). **The
PARAM exposes no patch handle; the PORT does, and that is correct** — the
handle a player patches is the gate input, not the synthetic level.

```ts
noUserControl: [
  { param: 'mirrorXGate', writer: 'cv-port',
    why: 'the mirror_x_gate CV bridge writes the raw 0..1 swing; the module edge-detects a RISING edge to FLIP mirrorX. There is no continuous setting to make.' },
  { param: 'mirrorYGate', writer: 'cv-port', why: '… as mirrorXGate, for the Y axis.' },
]
```

**Neither module needs a `writer:'internal'` entry.** Both freeze seams are
`globalThis` flags, not `ParamDef`s (`b3ntb0x.ts:948`, `bentbox.ts:637`) — so
spirographs' `freeze` precedent (`spirographs.ts:375-378`) does **not** transfer
here, and inventing an internal entry would name a param that does not exist.

**⚠ THE BOOLEANS DECLARED `curve:'linear'` — `mirrorX` and `mirrorY`.** They are
reduced to `>= 0.5 ? 1.0 : 0.0` in the shader (`:1035-1036`) and toggled by the
card's buttons, yet declared `min:0 max:1 curve:'linear'` (`:781-782`).
`looksLikeToggle` is `p.curve === 'discrete' && p.min === 0 && p.max === 1`
(`graph/group-controls.ts`), so `paramCellKind` (`shell-control-kind.ts:257-272`)
falls through to `'knob'` — **a def-driven face would paint two continuous
rotaries over a two-state value.** Same on bentbox (`bentbox.ts:489-490`,
shader `:659-660`).

**Two fixes, and their prices are NOT the same — this is the sharpest cost
finding in the spec:**

| fix | contract-lock (`task docs:accept`) | **WebGL re-attest** |
|---|---|---|
| `face.paramCells: { mirrorX:'toggle', mirrorY:'toggle' }` | **free** (`face` is enumerated in `FACE_FIELDS_NOT_IN_LOCK`) | **FREE** — `face` is in `HASH_TRANSPARENT_PROPS` (`scripts/attest-code-basis.ts:96-109`) |
| `curve: 'discrete'` on the def | **COSTS** — `curve` is projected by `serializeModuleContract` | **COSTS A REAL-GPU RE-ATTEST** — `params` is NOT hash-transparent |

**Recommendation: declare `face.paramCells` in the face PR (free on both
counts), and file the `curve` correction as its own issue.** The def-level
declaration is still wrong for every non-face consumer (docs, Push 2 ranking,
the legacy card's own `looksLikeToggle` path), but it is not the face's bill to
pay, and paying it drags a GPU re-attest into a look PR.

⚠ **A caution that must be in the issue, not discovered later:** neither
`mirrorX` nor `mirrorY` has a CV port (only the *gate* params do), so changing
`curve` cannot perturb any `cvScale` mapping. That is what makes the correction
safe — verify it again rather than trusting this line.

### 27.4h RISK: **MEDIUM.** Down from §24's MEDIUM-HIGH, because the platform blocker landed

The remaining risks are: the #1865 resize affordance (a genuine blocker until
answered), the 8-page tab rail being the video pool's second tabbed face, D2's
default change being look-affecting, and the `detach` decision in §27.2. **Do
not auto-merge** — it is look-affecting.

---

## 27.5 Q39 · `bentbox` — every control is bit-exactly inert until something is patched, and its phosphor mask moves with the picture

**Merit: YES.** 16 params (**14 user-facing** + 2 `noUserControl`), 15 inputs
(1 `video` + 12 `paramTarget` CV + 2 gate-shaped CV), 1 `video` output.
`palette: {top:'Video modules', sub:'Utilities'}`, `category:'output'`.

STOP 1: 14 controls, three `node.data` affordances, and one genuinely derived
quantity (§27.5d). Not marginal. **YES.**

### 27.5a THE RANKING ARGUMENT, FROM THE DSP

The module's own brief is in its header: *"Composite glitches are TIMING
glitches, not pixel glitches"* (`bentbox.ts:8-9`). Everything descends from the
per-line horizontal offset `hOffset` (`:291-300`), which is the only thing in
the shader that moves the picture rather than recolouring it.

Displacement, **DERIVED-BY-READING** at `VIDEO_RES.width = 1024`
(`video/engine.ts:23`):

| control | shader | full-travel displacement | applies to |
|---|---|---|---|
| `hsync_drift` | `driftRand · 0.12` (`:293`) | **±122.9 px** | **EVERY line** — `driftRand` is a hash, never zero |
| `scan_wobble` | `sin(…)·0.06` (`:292`) | **±61.4 px** | **EVERY line** |
| `hsync_loss` | `+ (hash−0.5)·0.6` when `lossRoll < loss·0.18` (`:298-300`) | **±307.2 px** | ⚠ **at most 18 % of lines, even at full travel** |
| `vsync_drift` | `sin(t·0.7)·0.4 + t·drift·0.05` (`:303-304`) | ±0.4 of height **plus an unbounded ramp in t** | whole frame, vertically |

**`hsync_drift` is the hero.** It is the largest *unconditionally applicable*
displacement — `hsync_loss` is 2.5× bigger but reaches at most 18 % of lines
(D18), which is the "check demotions for unconditional applicability" clause
deciding the order rather than a preference.

⚠ **`feedback_delay` is BIT-EXACTLY INERT whenever `feedback_gain = 0`, which
is its shipped default** (`:354` `mix(decoded, max(decoded, prev),
uFeedbackGain)` discards `prev` entirely at 0). This is mirrorpool's `wind_dir`
shape verbatim: rank it **immediately after** `feedback_gain`, never above it,
and never promote it to a tier where its master is absent — a lane tile showing
`Delay` without `Feedback` would be a dead control.

**Inertness-at-spawn sweep.** True nulls at default: `hsync_drift`,
`hsync_loss`, `vsync_drift`, `scan_wobble`, `chroma_phase`,
`chroma_instability`, `feedback_gain`, `feedback_delay` (dependent),
`wavefold`. Non-zero shipped defaults: `bloom` 0.4, `noise` 0.05
(*"CRTs always have some"*, `:428-429`), `master_gain` 1 — **whose neutrality is
itself the defect** (D15: Gain **0** is the cleanest image the module can make).

**Tier ladder as a sentence:** at mini you get HS DRIFT; at compact you get HS
DRIFT and HS LOSS (the timing pair); at plate you get the whole destruction
story (hs_drift, hs_loss, solarize, hue, feedback, gain); wobble, vs_drift,
shimmer, delay, bloom, noise and the two mirrors are dock-only.

Rank order:
`hsync_drift, hsync_loss, wavefold, chroma_phase, feedback_gain, master_gain | scan_wobble, vsync_drift, chroma_instability, feedback_delay, bloom, noise, mirrorX, mirrorY`.

### 27.5b PAGES — **6, and per the ruling that is NOT padded to 7**

| page | controls |
|---|---|
| `timing` | `hsync_drift`, `hsync_loss`, `vsync_drift`, `scan_wobble` |
| `chroma` | `chroma_phase`, `chroma_instability` |
| `drive` | `wavefold`, `master_gain` |
| `recursion` | `feedback_gain`, `feedback_delay` |
| `tube` | `bloom`, `noise` |
| `fold` | `mirrorX`, `mirrorY` |

Six pages, 14 controls. **`DOCK_TAB_MIN_BANDS = 7` is not reached, so bentbox
ships UNTABBED.**

⚠ **The obvious seventh — splitting `noise` out of `tube` — is REFUSED as
padding.** `bloom` and `noise` are one idea (CRT post) applied twice, and the
DSP agrees: they are the last two operations in the shader (`:357-361`,
`:384-387`), separated only by the deliberate ordering note *"added LAST so it
isn't soaked by the feedback path"*. Manufacturing a page from that is exactly
what the ruling forbids.

⚠ **AND DO NOT USE THIS ENTRY TO RE-OPEN §25.5.** Lowering
`DOCK_TAB_MIN_BANDS` to 6 to make the family symmetric would re-baseline every
already-faced module with exactly 6 bands (a tabbed face never packs rows), for
no gain — **its sibling reaches 8 on its own merits**, so the family does not
need the threshold moved. §25.5's recommendation (2) stands.

### 27.5c GLYPH — `'none'`, VERIFIED the same way

`bentboxDef.outputs` is exactly `[{ id: 'out', type: 'video' }]`
(`bentbox.ts:464-468`). **No `type:'audio'` output**, so
`primaryAudioOutPortId` is `undefined` and the generic rule applies unchanged;
`mandelbulb`'s trap does not reach here. Assert `hasVideoSurface`, not the
declaration.

### 27.5d READOUTS — one strong, one conditional, one REJECTED

**R3 · `bentbox-tear-px` — the worst-case per-line horizontal displacement, in
OUTPUT PIXELS.** Derived from `hsync_drift·0.12 + scan_wobble·0.06` (always)
plus `0.3` on the `hsync_loss·0.18` minority of lines.

- ⚠ **NEGATIVE CONTROL:** a knob readback of `hsync_drift` is **blind to
  `hsync_loss`**, which contributes a **2.5× larger** displacement on a
  minority of lines. Hold `hsync_drift = 0.5` (±61.4 px) and take `hsync_loss`
  0 → 1: the printed worst case must climb to **±368.6 px** while the HS Drift
  dial does not move.
- ⚠ **SECOND PERMANENT LEG:** it must be **invariant to `vsync_drift`** — that
  is the *vertical* axis (`:303-304`). A "tear" readout that moves on VS Drift
  is measuring the wrong axis and every number it prints is void.
- ⚠ **UNITS + BLIND SPOT IN THE MESSAGE:** `output px @ 1024`, **worst case not
  typical**, and — the honest part — `sampleUv` is wrapped with `fract()`
  (`:313`), so a displacement past the frame edge **reappears on the other
  side** rather than clipping. The number is a magnitude, not a position.

**R4 · `bentbox-feedback-lines` — the feedback tap's Y offset, in SCANLINES.**
`(feedback_delay·0.04 − 0.02)·240` (`:352`). **This readout exists to make D14
visible.**

| `feedback_delay` | offset (DERIVED-BY-READING) |
|---|---|
| **0 (shipped default)** | **−4.80 lines** |
| 0.25 | −2.40 |
| **0.5** | **0.00 — the true null, at the dial MIDPOINT** |
| 1 | +4.80 |
| total travel | **9.6 of 240 lines = 4.0 % of picture height** |

- ⚠ **NEGATIVE CONTROL / the leg that makes it honest:** the readout must go
  **inert (`—`)** when `feedback_gain = 0`, because at 0 the tap is discarded
  entirely (`:354`). A delay readout that keeps counting lines while the
  feedback is off is printing a number nothing consumes — the `wind_dir` defect
  expressed as a readout.
- It is also the number that refutes the module's own doc: `:527` promises
  *"sliding between line-level and **field-level** recursion"*, and field level
  (120 lines) is **25× further** than the control can reach.

**REJECTED · a "signal present / no signal" readout.** It is the obvious thing
to author, because bentbox visibly shows a blue idle field with nothing patched
(`:266-273`). **Do not.** The only key that looks like it answers the question
is `read('hasInput')`, and on both modules it returns `framesElapsed > 0`
(D7) — `true` unconditionally from frame 1. And a `FaceReadoutValue` is
param-only, so it cannot reach `read()` at all. **The right home for a
signal-present indicator is the extension body, and it must read
`resolveInputSourceId(id, 'in')` or a fixed `hasInput`, never the current one.**

### 27.5e `bareCells`

**No candidate.** `HS Drift` / `HS Loss` / `VS Drift` / `Wobble` under a
`timing` heading are four different mechanisms, not four instances of one; the
mixmstrs `1LO…8LO` shape does not appear anywhere on this face. Do not declare
it to have declared it.

### 27.5f ⚠ STOP 2 — the card-only inventory, COMPLETE

Grep hits over `BentboxCard.svelte`: `:67, 70, 116, 118, 123, 272, 273, 347,
357, 387, 395, 408, 411`. The inventory is **structurally identical to
b3ntb0x's minus the precision badge**, so §27.4f's table transfers line-for-line
with these substitutions — plus **one item b3ntb0x does not have**:

| card-only affordance | file:line | survives as |
|---|---|---|
| ⛶ OUTPUT menu | `:357`, `:415-…` | `fullViewBody` body |
| `node.data.fullFrame` (Y.Doc-synced — *"so a wall-of-TVs layout survives reload + is shareable"*, `:116-117`) | `:118-129` | `fullViewBody` body |
| MIRROR X / MIRROR Y buttons | `:386-403` (`bentbox-mirror-x/-y`) | `face.paramCells: toggle` (§27.4g) |
| corner RESIZE handle, raw `node.data.width/height` | `:260-279, 406-412` | ⚠ **#1865, unresolved — same blocker** |
| per-frame engine→store mirror reflect | `:230-243` | ⚠ card-unmount class, neither caused nor cured by the face |
| ⚠ **the 15 input `PortDescriptor`s are HAND-WRITTEN, not `portsFromDef`** | `:313-329` (outputs DO use `portsFromDef`, `:330`; b3ntb0x derives BOTH, `B3ntb0xCard.svelte:289-296`) | **the face regenerates them from the def — expect the jack labels to change**, and note nothing currently enforces that the hand-written list agrees with the def. Filed as **D20**. |

**⚠ THE FOUR-STRING LABEL TRAP, and it is deliberate.** One control carries
**four different strings**: param id `wavefold`, def label **`Solarize`**
(`:483`, with the reason written at `:478-482`), CV port `wavefold_cv`
(`:453`), and the card's jack **`SOLAR`** (`:323`). A face keeps the def label
and regenerates the jack — so the jack legend changes and the docs' *"param id
'wavefold'"* parenthetical (`:528`) becomes the only place the id is visible.
Plan for it; do not "fix" it by renaming the id (persisted patches + the
`wavefold_cv` edge depend on it).

**No `<select>`, no `<input>`, no file loader, no momentary.** Nothing
`samsloop`-shaped.

**Strings that exist ONLY on the card:** `MIRROR X` / `MIRROR Y` and their two
`title=` sentences, `Resize BENTBOX`, the menu title `BENTBOX`, and the fifteen
jack legends at `:313-329` (`HSD`/`HSL`/`VSD`/`WOB`/`HUE`/`SHM`/`FBK`/`DLY`/
`SOLAR`/`BLM`/`NSE`/`GAIN`/`MIRX`/`MIRY`, plus `IN`).

### 27.5g PARAMS WITH NO USER CONTROL

Identical shape to §27.4g: **`mirrorXGate` / `mirrorYGate`,
`writer: 'cv-port'`**, checked against `mirror_x_gate` / `mirror_y_gate`
(`bentbox.ts:461-462`, no `cvScale`). The def already writes the `why` for you —
*"Hidden — no card knob; the module edge-detects a rising edge to FLIP"*
(`:411-415`, `:534-535`). No `writer:'internal'` entry (the freeze seam is a
`globalThis` flag, `:637`).

### 27.5h ⚠ THE HINT TEXT MUST NOT BE SHARED WITH b3ntb0x

With nothing patched, **every bentbox control is bit-exactly inert** —
`:266-273` returns the idle field *before* the mirror fold and every subsequent
stage. b3ntb0x deliberately feeds black through the FULL pipeline
(`b3ntb0x.ts:243`), so its sync, CRT and geometry controls still act on an
unpatched node. **Opposite unpatched behaviour, same family.** A face author
copying one module's page hints onto the other ships a false statement. Filed
as **D17**.

### 27.5i RISK: **MEDIUM-LOW.** The simplest of the pair

One shader pass, no float FBOs, no precision badge, untabbed, and a body that
is a near-verbatim clone of b3ntb0x's. Its risks are the #1865 resize blocker,
D20's hand-written ports, and D13's Hue geometry being *the opposite* of its
sibling's under an identical label. **Do not auto-merge** — look-affecting.

---

## 27.6 THE GLSL-CLAIM HARNESS — which claims it should cover, and which it should NOT

`e2e/_helpers/glsl-claim.ts` measures a **GLSL-DELIVERED** value against a claim
the def makes, on the real output texture, through a paused engine loop and a
pinned module clock. It is the right tool for every *"the shader does X"*
statement below, and **this spec deliberately hand-rolls no probe of its own.**

**Read the harness's own stated blind spots before adding a leg**
(`glsl-claim.ts:33-62`): it sees the OUTPUT TEXTURE not the screen; it samples
on a **stride 17** (prime, co-prime with the row width, because an NTSC
subcarrier aliases to a beautiful constant on any stride that divides it); hue
below `minSat` is noise, so `qualifying` must be asserted; **"the shader ignores
the uniform" and "the effect is genuinely zero" are the same reading**, so
every leg owes a POSITIVE control; and it does not know *why*.

### The claims it SHOULD cover (in priority order)

| # | claim | module | why the harness and not source-reading | control it owes |
|---|---|---|---|---|
| **C1** | **`bentbox.chroma_phase`'s ends BOTH equal its centre, and its maximum shift is at HALF travel** (`bentbox.ts:324`, `·TWO_PI` over a −1..1 param) | bentbox | ⚠ **This is the GEOMETRY-level control the merged spec names as the gap it deliberately did not build** (`b3ntb0x-hue-claim.spec.ts:53-66`). Today "under 180°" is a measured *bound*; adding this makes it a measured **discrimination**. And the residue at exactly ±1 is a **float32 question** this spec refuses to print (§27.8 D13) — only a render answers it. | `cumulativeRotationDeg` must climb **through 360 and RETURN to ~0**, with `assertUnambiguousSteps` guarding the unwrap. Positive control: half travel delivers the maximum. Negative control: a LUMA-only param (`bloom`) moves the hue not at all. |
| **C2** | **`b3ntb0x.enhance` is a CHROMA GAIN, not an edge sharpener — and it is bit-exactly inert on a MONOCHROME source** (`:312-313`) | b3ntb0x | The identity `neighborAvg == Y` depends on `SUBCARRIER_PERIOD = 4` oversampled px making the two taps exactly ±90° of carrier. That is a *shader arithmetic* claim; the harness reports `sat`, which is precisely the observable. | Sweep `enhance` 0→1 with the colorizer rig: `sat` must climb ≈ ×3 while `hueDeg` stays put (a gain preserves angle). **Positive control:** the same sweep with the colorizer bypassed (mono in) must move `sat` **not at all** — that is the inertness claim and the instrument's own negative control in one leg. |
| **C3** | **`b3ntb0x.bend_d` multiplies the SAME quantity `enhance` does** (`:356-357` vs `:313`) | b3ntb0x | The strongest claim in the spec and the one no def-reading gate can see. `b3ntb0x.test.ts:499-550` proves each uniform is *consumed*; it cannot see that two of them are the same operation. | Measure `sat` at `(enhance 0.5, bend_d 0)` and `(enhance 0.5, bend_d 1)` → the ratio must be **1.8**; then at `(enhance 1, bend_d 0)` → the SAME `sat` as `(enhance 0, bend_d 1)` scaled by the predicted ratio. Two paths to one number is the proof. |
| **C4** | **`b3ntb0x.sync_crush = 0` is a bit-exact BLACK OUT, not an "underdrive"** (`:314`, doc `:817`) | b3ntb0x | #1758's sample-AT-the-declared-value rule. A def-reading gate cannot see that a declared MIN kills the module. | `qualifying` must fall to **0** at `sync_crush = 0` — and ⚠ this is the one leg where `assertMeasurable` must be **inverted deliberately and loudly**, with a POSITIVE control at `sync_crush = 1` proving the rig is alive in the same test. "0 qualifying" and "the rig never rendered" are otherwise the same reading. |
| **C5** | **`bentbox.master_gain = 0` produces the CLEANEST image, and Gain COMPRESSES highlights** (`:343`, doc `:531`) | bentbox | The mix weight `uWavefold*0.7 + uMasterGain*0.1` going to exactly 0 is a *delivered brightness* claim, and `DeliveredColour.val` is the observable. | `val` at gain 0 / 1 / 2 on a white field must be **monotone-ish around ≈ 1.000 / 0.978 / 0.997** — i.e. gain 0 is the BRIGHTEST. Negative control: `val` must be invariant to `chroma_phase` (a rotation on a grey field has no chroma to rotate). |
| **C6** | **`b3ntb0x.tbc = 1` delivers ZERO displacement for every `sync_crush`** (`:443`) | b3ntb0x | The R1 readout's second permanent leg. ⚠ **Hue is the wrong observable** — this is a *spatial* claim, so it needs a positional reduction the harness does not have today. **Add it as a sibling reducer in `glsl-claim.ts`, not as a bespoke probe in a spec**, so the "ONE export site" property survives. | Positive control: the same measurement at `tbc = 0` must be non-zero, or the reducer is blind. |

### The claims it should NOT cover

- **"Hue rotates 162°."** Already refuted by the harness itself: the delivered
  angle is input-dependent (172.5 / 157.7 / 161.9, MEASURED, recorded at
  `b3ntb0x-hue-claim.spec.ts:20-27`). The gateable claim is *"never reaches
  180°"* and it is **already committed**. Do not re-litigate it, and do not
  print 162 anywhere on the face.
- **The 240-line decimation (D16) and the 68.75 % figure.** That is a
  *resolution* claim, not a colour one; the stride-17 sampler is structurally
  the wrong instrument. A unit test over `floor(uv.y * 240.0)` is both cheaper
  and honest.
- **Anything about the CARD.** `setVideoParam` reaches past the control
  deliberately (`glsl-claim.ts:356-359`), so a harness leg is never evidence
  that a control is wired. That stays an e2e gesture test.

### ⚠ COST — read this before adding six legs

`STEPS = 2` per read is a **cost number that was the difference between green
and a CI timeout** (`b3ntb0x-hue-claim.spec.ts:83-97`): the first version used 8
per read across a 3-tint sweep and **exceeded the 180 s test timeout on CI**,
which is a 2-core VM at roughly 6× a dev machine. Every b3ntb0x frame is a full
4-pass render. **Pay the cold start ONCE via `warmUntilMeasurable` and use 2
steps per read**, and estimate this PR's CI wall-time delta before merging —
anything over ~2 min needs owner sign-off.

⚠ **And do NOT copy `b3ntb0x.spec.ts`'s frame driver.** The harness's
`stepFrames` yields ONE FRAME PER JS TURN deliberately: MEASURED (recorded at
`glsl-claim.ts:143-154`, not re-run here) 8 `step()` calls in one turn leave
b3ntb0x's output **bit-exactly black** under `E2E_SWIFTSHADER=1`, while the same
8 taken one per turn render a clean field. `b3ntb0x.spec.ts` uses the
single-turn DRS form and therefore fails under SwiftShader today — nothing has
reported it because that spec carries no `@webgl-smoke` tag.

---

## 27.7 THE ATTEST LEDGER — and one asymmetry that inverts the obvious intuition

**⚠ THIS SPEC PROPOSES NO ATTEST RUN.** A MIRROR re-attest is queued and is
orchestrator-run only. What follows is the *price list* so the face PRs can be
sequenced against it, not an instruction to run anything.

**Both defs ARE in the WebGL attest basis, by directory walk.**
`scripts/webgl-attest-lib.ts:256-263` adds **every** non-`.test.ts` file under
`packages/web/src/lib/video` — so `b3ntb0x.ts`, `b3ntb0x-dsp.ts` and
`bentbox.ts` are all in.

**Both CARDS are OUT.** The card sweep (`:265-272`) admits a `.svelte` file only
if `sourceCreatesWebglContext` matches; both cards call `getContext('2d')`
(`B3ntb0xCard.svelte:177`, `BentboxCard.svelte:201`). **So a new
`ui/modules/b3ntb0x/` extension body is FREE for the same reason** — provided it
blits like the cards do and never creates a GL context. Verify that rather than
assume it.

| edit | in the basis? | WebGL re-attest | `task docs:accept` |
|---|---|---|---|
| the `face` declaration (incl. `pages`, `order`, `hero`, `paramCells`, `bareCells`, `extension`) | stripped | **NIL** | free — except `face.sidebar`, which **IS** projected |
| `noUserControl` | stripped | **NIL** | free |
| `docs` prose fixes (D2, D5, D9, D10, D14, D15, D16, D18) | stripped | **NIL** | **yes** — docs are in the lock |
| comments / JSDoc anywhere in the def | stripped | **NIL** | no |
| the new `ui/modules/<mod>/shell-extension.ts` + `*Body.svelte` | not in basis | **NIL** | no |
| **`curve: 'discrete'` on `mirrorX`/`mirrorY`** | `params` — **hashed** | **REAL-GPU RE-ATTEST** | **yes** |
| **an `options[]` roster on any param** | `params` — **hashed** | **REAL-GPU RE-ATTEST** | **no** |
| **a `label` rename (`Burst Strv` → `Burst Starve` at the DEF)** | `params` — **hashed** | **REAL-GPU RE-ATTEST** | **yes** |
| any shader / factory fix (D1, D2's default, D3, D6, D21) | hashed | **REAL-GPU RE-ATTEST** | maybe |

⚠ **THE ASYMMETRY, stated because it reads backwards:** the queue's standing
line is *"`options[]` is free, `curve` costs a `docs:accept`"*. That is true of
the **CONTRACT LOCK** and **false of the ATTEST**. `HASH_TRANSPARENT_PROPS`
(`scripts/attest-code-basis.ts:96-109`) is exactly `docs`, `controlFamilies`,
`face`, `noUserControl` — **`params` is not on it**, so on a VIDEO def *any*
ParamDef edit, `options[]` included, costs a real-GPU re-attest that CI
(SwiftShader) structurally cannot run. **On a video module the cheap fix is
always the one inside `face`.** That is why §27.4g recommends `face.paramCells`
over `curve`.

⚠ And the nested-`face` carve-out does not apply here: only a def's **own
top-level** `face` is stripped. Neither module has geometry with a nested
`face:`.

**So: both face PRs, as specced, cost ZERO attest.** Confirm that rather than
assume it — `b3ntb0x.ts` carries no attest warning in its header, but the
directory walk is what decides, not the header.

---

## 27.8 DEFECTS FOUND — file:line evidence, and none of them folded into the face PRs

### b3ntb0x

**D1 · The DECODE pass binds a sampler it never reads.** `uEncode` is declared
(`b3ntb0x.ts:391`), its location cached (`:892`), and `fboEncode.texture` bound
to TEXTURE1 with `uniform1i(dU.uEncode, 1)` **every frame** (`:1005-1007`) — and
`DECODE_FRAG` never samples it: all four `texture()` calls read `uBend`
(`:428, :465, :518, :519`). **Two comments assert the opposite** — the BEND
output note *"the decoder reads the region from the ENCODE texture's A (helper
side-channel)"* (`:371-373`) and the PASS-3 header *"region/phase helpers from
fboEncode"* (`:378-382`). ⚠ **The "no dead control" guard
(`b3ntb0x.test.ts:499-550`) is keyed on the PARAM `WIRING` map (`:501`), so a
dead SAMPLER is structurally invisible to it** — a gate that cannot see the
thing next to the thing it checks.

**D2 · `tbc` defaults to 1 and that zeroes the module's headline gesture.**
`:443` is `return (rawOffset + wobble) * (1.0 - tbc);` — at the shipped `tbc = 1`
(`:719`) that is **exactly 0.0, every frame**. The 24-iteration sync scan
(`:426-432`) and the wobble term (`:441`) are computed and multiplied by zero.
`docs.explanation` (`:788`) instructs *"Crank Sync Crush + Bias to tear and roll
the picture"*; the `tbc` control doc (`:826`) says the opposite, correctly. **At
factory settings the module's own instruction cannot work.**

**D3 · The recovered sync offset is QUANTISED to 5.08 output px and nothing
says so.** The scan samples 24 columns at `0.10/24` spacing (`:427`) = 0.0041667
line-fraction = **5.079 output px at 1024 wide** (DERIVED-BY-READING). Sync
damage finer than that is bit-exactly invisible to the corrector; and because
each line either finds its edge at k=14 or at k=0, a crushed line **snaps 71.1
px in one step** rather than tearing progressively.

**D4 · `bend_d` is `enhance` with a smaller coefficient.** Both read the SAME
`neighborAvg` (`:312`); enhance multiplies the chroma carrier by `1 + 2·e`
(`:313`) and D by `1 + 0.8·d` (`:357`), so they **multiply** (×5.40 at both
full). The def's docs (`:801`, `:824`) describe D as cross-coupling *"onto the
DC/baseline path"* — it does not touch `nb`, the actual baseline (`:302-303`);
it adds to `vc`. The one thing D does that enhance does not is scale the BIAS,
because it runs after `+ uBias` (`:317`) — so at `bias = +0.5, bend_d = 1` it
adds **+0.40 V of pure DC** to a flat field, a brightness shift with no ripple
involved.

**D5 · `enhance` is a chroma gain that is inert on monochrome, documented as an
edge sharpener.** `neighborAvg` averages taps exactly ±90° of subcarrier apart
(`SUBCARRIER_PERIOD = 4`, `:91`; `dx` = one oversampled texel, `:295`), so it
equals Y exactly and `vc − neighborAvg` is the pure chroma carrier. Kernel width
is **±0.149 OUTPUT px** (one oversampled texel ÷ the 0.84 active span) — it
cannot sharpen an edge at output resolution, and on a source with no chroma it
does **nothing at all**. Docs `:791` and `:814` say *"HF peaking / edge
over-ring"* and *"sharpens edges"*.

**D6 · A declared MIN that is a bit-exact BLACK OUT.** `sync_crush = 0` makes
`vc = 0` at `:314` before bias; with the bends identity at their defaults the
whole composite is zero, the demod recovers Y=I=Q=0, and the CRT pass emits
black. Docs `:817` say *"below 1 it underdrives"*. ⚠ **Note the family
inversion: bentbox's identically-shaped Gain dial does the OPPOSITE at its
declared min** (D15) — one min kills the picture, the other cleans it.

**D8 · The pure mirror's default coefficient is the KNOWN-BROKEN one.**
`b3ntb0x-dsp.ts:171-180` defaults `acCoupleMix`'s `alpha = 0.02`; the shader
runs `AC_LEAK_ALPHA = 0.08` (`b3ntb0x-dsp.ts:452`, inlined at
`b3ntb0x.ts:283, 303`), and `b3ntb0x.ts:299-301` states in so many words that
0.02 is the value that made the control do nothing (*"owner-reported 'weak'"*).
`b3ntb0x.test.ts:207-212` calls `acCoupleMix` **without** an alpha — so the test
that exists to keep the mirror and the shader from diverging is exercising the
one coefficient the shader abandoned.

**D9 · A doc comment that contradicts itself and the code inside one sentence.**
`b3ntb0x-dsp.ts:323-324`: *"hue −1..+1 maps to ±π (one full half-turn each way
is plenty of tint swing; ±π would alias)"*. The code is `HUE_MAX_RAD = 0.9 *
Math.PI` (`:330`).

**D10 · "sign picks fold polarity" is not what the code does.**
`b3ntb0x.ts:821` and `b3ntb0x-dsp.ts:383-386`. The fold is driven by
`mag = Math.abs(a)` (`b3ntb0x-dsp.ts:404-410`; GLSL `b3ntb0x.ts:326-332`); the
only sign-carrying term is `+ a * 0.05` (`:412` / `:332`), a ±0.05 V DC nudge
the `clamp(vc, −0.6, 1.4)` at `:365` swallows at high magnitude.

**D11 · `asymSat` is a mirror of nothing.** Exported as part of the "pure DSP
mirror" (`b3ntb0x-dsp.ts:214-217`), re-exported (`b3ntb0x.ts:114`) and
unit-tested (`b3ntb0x.test.ts:185-188`) — and **no shader stage calls it**;
BEND_FRAG uses `softClip` + `clamp` only (`:364-365`). A green test certifying a
function the GPU never runs.

**D12 · The card's own group comment does not describe the card.**
`B3ntb0xCard.svelte:12-16` declares four groups (6/4/4/4) with `Hue` under
ENCODE/BEND; the markup renders `Hue` in the second row (`:348`) and the grid is
`repeat(5, 1fr)` (`:517`), so no declared group aligns with a row and `feedback`
paints inside the BEND row. **Do not derive the face's pages from it.**

**D22 · `bend_c` drives TWO quantisers with different step counts.** The
composite-domain crush (`:345-349`, 64 → 3 steps) and the RGB-domain crush
(`:528-532`, 256 → 3 steps) are both keyed off the same uniform. Docs `:823`
describe only the second (*"the visible crush is applied on the recovered
RGB"*), and the CPU mirror `b3ntb0xBendCrush` (`b3ntb0x-dsp.ts:424-429`) mirrors
only the first. Minor, but it is why a "crush steps" readout would have to pick
one (§27.4d rejects it).

**D23 · A capability cliff worth a badge, and the badge is card-only.**
`b3ntb0xOsWidth` (`:101-105`) is `min(round(baseWidth)·8, maxTexSize)`. At 4:3
the base is 1024 → **8192, exactly the very common cap, fitting by ZERO
margin**; at 16:9 (1366) it wants 10928, so an 8192-cap GPU silently gets
**5.997×** instead of 8× while the shader's `dx` stays inlined at
`1/(1024·8)` (`:295, :422, :454`). That is what the `isFloat` badge gestures at,
and it is why the badge must survive promotion (§27.4d).

### bentbox

**D13 · The Hue dial spans exactly ONE FULL TURN, so both ends equal the
centre.** `bentbox.ts:324`: `ang = (uChromaPhase + phaseNoise) * TWO_PI` with
`chroma_phase ∈ [−1, 1]` (`:474`). DERIVED-BY-READING: 0.25 → 90°; **0.5 → 180°,
the actual maximum hue shift**; ±1 → ±360° → back to the centre colour.
⚠ **Its sibling's identically-labelled `hue` tops out at `0.9π = 162°` and never
wraps** (`b3ntb0x-dsp.ts:330`, `b3ntb0x.ts:504`) — **two controls, one label,
opposite geometry**, and this is the single sharpest argument for specifying the
family together.
⚠ **The exact residue at ±1 is a float32 question and this spec REFUSES to print
it.** In float32 the GLSL constant `6.2831853` and 2π round to the same value,
so the residue is a rounding artefact of the shader compiler, not of the source.
**§24's `sin ≈ −3.07e−10` could not be reproduced by reading and should not be
carried forward.** This is claim **C1** for the harness.

**D14 · The delay's NULL is at the dial midpoint, not at its default.** `:352`
`fract(sampleUv.y + uFeedbackDelay*0.04 − 0.02)`. Default 0 → **−4.80 of 240
lines**; 0.5 → **exactly 0**; 1 → +4.80. Total travel **9.6 lines = 4.0 % of
picture height**, while docs `:527` promise *"sliding between line-level and
**field-level** recursion"* — field level is **~25× further** than the control
reaches.

**D15 · The declared MIN of Gain is the CLEANEST image, and Gain compresses
rather than overdrives.** `:337` `comp = softClip(comp * uMasterGain)` feeding
`:343` `mix(yiq.x, comp − (iq.x+iq.y)*0.5, uWavefold*0.7 + uMasterGain*0.1)` —
at `master_gain = 0` (and `wavefold = 0`) the mix weight is exactly 0, so **the
whole composite/wavefold/soft-clip stage is DISCARDED**. DERIVED-BY-READING, a
pure-white input:

| `master_gain` | delivered white | delivered 0.1-grey |
|---|---|---|
| **0** | **1.000000** (the brightest the module makes) | 0.100000 |
| 1 (default) | 0.977778 | 0.099970 |
| 2 (max) | **0.996825 — still BELOW its input** | **0.119532 (+19.5 %)** |

Docs `:531` and `:512` say *"higher overdrives into white smear"*. It
**compresses highlights and lifts darks** — the opposite shape.

**D16 · An undocumented always-on 240-line decimation.** `:284-285` snaps to
`LINES = 240` inside a **768-row** FBO (`VIDEO_RES = 1024×768`,
`video/engine.ts:23`), so **68.75 % of incoming vertical detail is discarded
before any knob acts**. The explanation (`:498`) says *"resampled to a 240-line
raster"* without saying the FBO is 768. ⚠ b3ntb0x does NOT do this — its
`LINES = 240` (`b3ntb0x.ts:560`) is a scanline **mask** over a full-768 picture.

**D17 · With nothing patched, EVERY bentbox control is bit-exactly inert.**
`:266-273` returns the idle field **before** the mirror fold (`:278`) and every
subsequent stage. b3ntb0x deliberately feeds black through the FULL pipeline
(`b3ntb0x.ts:243`), so its sync/CRT/geometry controls still act unpatched.
Opposite unpatched behaviour, same family.

**D18 · HS Loss reaches at most 18 % of lines at full travel.** `:298`
`if (lossRoll < uHsyncLoss * 0.18)` over a uniformly-distributed `lossRoll`.
Docs `:521` call it *"probability a scanline drops lock"* without the 0.18
ceiling.

**D19 · Solarize's bottom travel is a GAIN, not a fold.** `wavefold()`
(`:239-246`) pre-gains by `1 + 3·amt` and folds only where `|s| > 1`, so on a
0.5-grey composite folding cannot begin until `amt > 0.3333` — **the bottom
33.3 % of the dial simply brightens the picture** (and simultaneously raises the
`:343` mix weight by `0.7·amt`). A declared range whose bottom third does not do
the thing the label names.

**D20 · The card hand-writes its 15 input `PortDescriptor`s.** `:313-329`, while
its outputs use `portsFromDef` (`:330`) and b3ntb0x derives both
(`B3ntb0xCard.svelte:289-296`). They agree today and **nothing enforces it** —
neither module is in `card-def-agreement` or `RANGE_BOUND_CARDS`.

**D21 · The phosphor triad moves WITH the picture, and b3ntb0x's own source says
that is the bug.** `:373` `float col = floor(uv.x * 240.0 * 3.0)` — keyed off
`uv`, which at that point is the **mirror-folded, drifted output coordinate**
(`:278`), so the "phosphor stripes" mirror and wobble along with the image.
b3ntb0x keys the identical feature off `gl_FragCoord.x` (`:643`) with the reason
written out (`:636-642`): *"The phosphor stripes are a property of the physical
SCREEN, not the picture … they stay straight while the image warps behind them
(that's what reads as 'image behind glass' instead of an RGB pattern painted
INTO the picture)."* **Same named feature, opposite implementation, and one of
them carries its own refutation of the other.** This is the *"identical to /
same as"* class in its purest form.

### both

**D7 · `read('hasInput')` LIES on both modules.** `b3ntb0x.ts:1089` and
`bentbox.ts:691` both return `framesElapsed > 0` — *"has drawn a frame"*, not
*"an input is patched"*. Every sibling in the fleet returns
`lastInputTexture !== null` (`video-out.ts:202`, `monoglitch.ts:269`,
`recorderbox.ts:426`). No spec currently reads it on either module
(`video-aspect-switch.spec.ts:66` and `multi-output.spec.ts:63` both drive
`videoOut`), so it is **latent** — and it is exactly the key a face's
"signal present" probe or a SCREEN-ON liveness leg would reach for first
(§27.3, §27.5d). ⚠ On bentbox the lie is *visibly* wrong: the shader shows the
blue idle field (`:266-273`) while `hasInput` reports `true`.

**D24 · Both cards re-type every range the def declares.**
`B3ntb0xCard.svelte:339-359` and `BentboxCard.svelte:370-383` pass literal
`min={…} max={…} defaultValue={…}` on every `<Knob>`. They agree with the def
today (checked param by param) and **neither card is in
`RANGE_BOUND_CARDS`** — so this is the backdraft class sitting unguarded. The
face PR *retires* the card, which resolves it by deletion; note it so nobody
"fixes" it by adding a gate to a file that is about to stop being the UI.

---

## 27.9 THE ADVERSARIAL PASS — what I attacked in my own spec, and what survived

- **"You inherited §24 wholesale."** No — four of its claims are refuted above
  (`readLive`, `card-def-debt`, the `fullViewBody` blocker, the ±1 residue), each
  with the file:line that refutes it. The parts that survived were re-derived
  from the current source, not copied.
- **"8 pages is padding to reach the rail."** Attacked directly: the *merged*
  grouping (glass+fold) still gives **7**, so the rail engages on the
  conservative reading too. A page count that survives being argued down is not
  padded. And the pages are the module's own four passes, named in its header.
- **"The chroma-gain readout is a knob relabelled."** It is not: it is the
  product of two knobs, and the negative control (hold `enhance`, sweep
  `bend_d`) is exactly the leg a relabelled knob would fail.
- **"D4 is a coincidence of coefficients, not a duplicate control."** The
  strongest objection. It survives because both expressions read the **same
  variable** `neighborAvg` computed once at `:312` — not two similar
  quantities, one quantity used twice. C3 is designed to settle it in pixels
  rather than by argument.
- **"You are printing a float32 residue as a finding."** Deliberately NOT —
  §27.8 D13 refuses the number and routes it to C1. That refusal is the point:
  §24 printed one and it could not be reproduced.
- **"The SCREEN cell is a copy-paste; why spec it?"** Because `markWatched`
  lives inside the blit (`engine.ts:1632`) and neither module is pull-exempt, so
  the naive implementation is a producer kill switch on a **stateful** analog
  simulation. That is a module-specific argument, not a restatement of the
  ruling.
- **"#1865 is someone else's problem."** It is not: functional parity is a hard
  requirement and the resize handle is the only way to make either module's
  screen big in-rack. The spec refuses to hand-wave it and says so twice.

## 27.10 THE PAIR AT A GLANCE

| | `b3ntb0x` | `bentbox` |
|---|---|---|
| **merit** | **YES** (20 user params, 4 stages) | **YES** (14 user params) |
| **tab rail** | **YES — 8 pages honestly, 7 on the merged grouping** | **NO — 6, and NOT padded** |
| **hero** | `sync_crush` (⚠ headline effect gated off by D2) | `hsync_drift` (unconditionally applicable) |
| **glyph** | `'none'` — **verified: no `type:'audio'` output** (`:759-761`) | `'none'` — **verified** (`:464-468`) |
| **SCREEN ON/OFF** | overlay bottom-right; keep the node a pull root | identical cell, same seam |
| **`noUserControl`** | 2 · `writer:'cv-port'` | 2 · `writer:'cv-port'` |
| **booleans as `linear`** | `mirrorX`,`mirrorY` → `face.paramCells:'toggle'` | same |
| **readouts** | `sync-shift` (px), `chroma-gain` (×) | `tear-px`, `feedback-lines` |
| **`bareCells`** | none — the Bend letters are the tidyVco case | none |
| **STOP-2 blocker** | **#1865 resize** — answer or exempt in writing | **#1865 resize** — same |
| **attest** | **NIL as specced** | **NIL as specced** |
| **defects** | D1–D12, D22, D23 (+D7, D24) | D13–D21 (+D7, D24) |
| **risk** | MEDIUM | MEDIUM-LOW |
| **auto-merge** | **NO** — look-affecting | **NO** — look-affecting |

**Build order: `b3ntb0x` first.** It is the one that reaches the rail, it is the
one whose extension body the other clones, and its defect list is where the
family's shared misconceptions are written down.

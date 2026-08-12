# Face specs — round 2 (the 10 unmocked plan modules)

> **2026-08-12 janitorial sweep: the TEN SPEC DRAFTS WERE DELETED; the defect
> lists are all that remain, which is the half the skills cite.** Every one of
> the ten faces has shipped, so the drafts were describing a design the code has
> since replaced. Each section is now: the module, its verdict line, and its
> fact-checker defect list verbatim.
>
> ⚠ Two kinds of stale citation survive INSIDE the quoted defects and are left
> as written because they are the evidence, not the claim: (a) references to
> `EXEMPT_BASELINE_PAIRS` / the `vrt-meta` linux-pair ratchet — that whole
> mechanism was deleted with the VRT `{platform}` dimension (#1458); (b) the
> banner's pointer to `undeclared-edge-ledger.ts:57` — that file was deleted when
> every gate port was declared (#1442).

> ⚠ **STATUS CORRECTED 2026-08-04. KEEP THIS FILE — but read it as a DEFECT LIST, never as a
> design.** Two repository skills cite it by path:
> `.claude/skills/module-faceplates.md:434` ("a 71-defect adversarial review of ten drafts —
> **the defect lists are the valuable half**") and
> `.claude/skills/module-adversarial-audit.md:175`. Deleting it breaks both.
>
> - **All ten of these modules now have SHIPPED faces** (batch B, 2026-08-02 — qbrt, delay,
>   reverb, shimmershine, mixer, filter, tomtom, karplus, snaredrum, sixstrum are all in
>   `STRICT_FACES`). **The ten SPEC DRAFTS below are therefore spent**, and the file's own
>   header already says not one of them came back sound.
> - **They were superseded by `face-redo-*.md`** (PR #1307, `9187fd84`), which re-specced
>   the same ten against the merged platform and records that *"round-2's DSP citations are
>   off by 1–2 lines; its BLOCKER is false"*. **Prefer the re-do specs for any design
>   question; prefer this file only for its defect enumeration.**
> - The consolidated shipped-code ledger lives at `face-redo-INDEX.md` §4 — and **that** is
>   the numbering the source tree cites (`shell-cells.ts:410`, `audition-ledger.ts:25`,
>   `mutate.guard.test.ts:26`, `undeclared-edge-ledger.ts:57`,
>   `card-def-agreement.test.ts:167`). Several of its rows have since closed; see §4's
>   correction table there rather than re-deriving from here.

Generated 2026-08-01 by a 20-agent fan-out: one agent AUTHORED each spec from the design
program's §4 prose + the real def/card, then a second agent ADVERSARIALLY FACT-CHECKED it
against the code.

## ⚠ READ THIS BEFORE BUILDING ANY OF THEM

**Not one of the ten came back sound.** 4 CONTRADICT the code, 6 NEED WORK. Treat every spec
below as a DRAFT whose defect list is the more valuable half.

**The most important finding: TWO agents (qbrt, sixstrum) independently invented the SAME false
blocker** — that PF-6f cannot ship because `PatchEngine` is reachable only through Svelte
context, therefore a shell-cells `action` needs a ~14 LOC platform change first. That is wrong.
`packages/web/src/lib/audio/engine-ref.ts` already exports `getActiveEngine()` for exactly this,
and it is ALREADY consumed from plain `.ts` modules (`clipplayer.ts:28`,
`push2-control.svelte.ts:35`). Both specs would have shipped an unnecessary prerequisite PR.
Because two independent agents made the identical error, assume a THIRD would too — this is a
systematic misreading of the engine seam, not a one-off.

| module | verdict | blockers | major | total defects |
|---|---|---|---|---|
| **qbrt** | CONTRADICTS_CODE | 1 | 2 | 7 |
| **delay** | NEEDS_WORK | 0 | 1 | 7 |
| **reverb** | CONTRADICTS_CODE | 1 | 6 | 10 |
| **shimmershine** | NEEDS_WORK | 0 | 2 | 8 |
| **mixer** | NEEDS_WORK | 0 | 4 | 7 |
| **filter** | CONTRADICTS_CODE | 1 | 2 | 7 |
| **tomtom** | NEEDS_WORK | 0 | 2 | 7 |
| **karplus** | NEEDS_WORK | 0 | 2 | 6 |
| **snaredrum** | NEEDS_WORK | 0 | 1 | 8 |
| **sixstrum** | CONTRADICTS_CODE | 1 | 0 | 4 |


---

## qbrt

**Verdict: CONTRADICTS_CODE** · archetype: DUAL-IDENTITY PROCESSOR — a stereo resonant filter you insert (always-on, dual-mono, no cross-feed) that a rising edge on PING turns into a struck percussion VOICE. Four params, one audition action, one glyph. It is the only module in Batch B whose two identities share the same four knobs: CUTOFF is simultaneously the corner frequency and the pitch the resonator rings at (qbrt.ts:47-48, qbrt.dsp:66-72).

**DEFECTS — fix these before building:**

- **[BLOCKER]** risks[0] declares a BLOCKER — 'PF-6f AS THE PLAN DESCRIBES IT CANNOT WORK ... the PatchEngine is reachable ONLY through Svelte context ... An action cell as shipped can only mutate the graph store. REQUIRED PLATFORM DELTA (~14 LOC, 2 files): add readKey?: string to ShellActionCell ... Ship it in the qbrt PR or in a 1-file platform PR immediately before it.' This is false. A non-context, process-wide engine accessor already exists and is already used from plain .ts modules.
  - *evidence:* packages/web/src/lib/audio/engine-ref.ts:3-5 — 'A tiny process-wide accessor for the live PatchEngine, for code that runs OUTSIDE the Svelte context tree where provideEngineContext / useEngine apply'; :23-25 `export function getActiveEngine(): PatchEngine | null`. It is live in the shell: Canvas.svelte:6991 `setActiveEngine(e)` (cleared at :7556). It is ALREADY consumed from non-component .ts modules exactly as a shell-cells `onFire(nodeId)` would: packages/web/src/lib/audio/modules/clipplayer.ts:28 + :794/:810/:2097/:2239, and packages/web/src/lib/control/push2/push2-control.svelte.ts:35 + :279 (`const e = getActiveEngine();`). Combined with engine.ts:2147 `read(node, key)` and the karplus.ts:288-295 `manualTrigger` seam, a shell-cells `action` spec can fire the audition today with zero platform change — which is precisely what the plan asserts at plan:105 ('The no-platform-change FALLBACK, which ships TODAY'). The spec's own cited evidence (shell-cells.ts:62-67 onFire signature, ModuleShell.svelte:584 `cell.onFire(id)`) is accurate but does not support the conclusion: onFire receives the nodeId, and the nodeId is all getActiveEngine()+patch.nodes need. The prescribed ShellActionCell.readKey field, the optional-onFire change, the ModuleShell action-branch rewrite and the new shell-cells.test 'exactly one of onFire/readKey' clause are all unnecessary scope, and the spec instructs shipping them as a prerequisite PR.

- **[MAJOR]** The spec ships the exact page-label <-> rear-band-label desync its own risks[6] warns about. It renames the `ping` PAGE label to 'ping · plays the filter' but never respecifies the `ping` REAR GROUP label, then asserts they are the same string.
  - *evidence:* qbrt.ts:152 — `{ id: 'ping', label: 'ping · resonator', ports: ['ping'] }`. The spec's pages[1].label = 'ping · plays the filter'. Its rationale specifies ONLY one rear relabel ('WHY THE REAR CHANGES ONLY ITS LABELS. `signal` → `stereo in · no cross-feed`'), leaving the ping group at 'ping · resonator'. rear-card-model.ts:288-290 makes the ping page's band take the CURATED group's label (`const g = curatedGroups.find(gr => gr.id === page.id)` → `curatedBand(g)`), so the dock band header would read 'ping · plays the filter' while the rear face of the same band reads 'ping · resonator'. risks[6] states 'Both are specified above as the same string; change them together or not at all' — contradicted by the spec's own `pages` array. And as risks[6] itself notes (verified: 0 qbrt hits in packages/web/src/lib/ui/workflow/rear-card-model.test.ts), nothing will catch it.

- **[MAJOR]** vrtImpact mis-states the vrt-meta instrument: 'the ratchet is at its bound and will fail if you drain without lowering.' The gate is a CEILING and can only be tripped by GROWING; draining 2 pairs to 117 passes silently.
  - *evidence:* packages/web/src/lib/audio/modules/vrt-meta.test.ts:315 `const linuxPending = [...EXEMPT_BASELINE_PAIRS].filter((p) => p.startsWith('linux/')).length;` → :468 `).toBeLessThanOrEqual(119);`, with the failure message at :318 reading 'the linux-baseline deficit GREW.' Current count is 119 (grep -c "^  'linux/" e2e/vrt/vrt-exemptions.ts = 119), so removing e2e/vrt/vrt-exemptions.ts:1014-1015 yields 117 ≤ 119 → GREEN. The 119→117 edit is still correct as the repo convention (the comment block at :306-309 says 'LOWER the number when you land linux baselines'), but a builder who trusts the spec's stated causality will omit it and see no red — the same 'a gate that cannot fail is decoration' class the spec's own risks[1] invokes.

- **[MINOR]** vrtImpact fabricates a citation for the page-label assertion claim: 'No `.page-label` text assert exists for qbrt (only adsr's, at :117).' There is no `.page-label` selector anywhere in that spec file, and :117 is unrelated.
  - *evidence:* `grep -n "page-label" e2e/vrt/workflow-shell-faces.spec.ts` returns zero hits (nor does 'label'/'band' appear as a selector — only prose at :15, :41, :70 and a comment at :111). e2e/vrt/workflow-shell-faces.spec.ts:115-120 is the `page.waitForFunction` inside `bootWithFace` that polls `__patch.nodes['pinned-mixmstrs'].data.columns['1']`. The conclusion (nothing asserts qbrt's page-label text) is right; the evidence for it is invented, and `{ type: 'qbrt', pages: 2 }` at :57 IS correctly cited.

- **[MINOR]** Four DSP citations are off by 1-2 lines, including the one carrying the X-BP naming argument, and one cited range runs past EOF.
  - *evidence:* packages/dsp/src/qbrt.dsp is 72 lines. `notch = x - bp;` is :45, not the cited :47 (:47 is `seg = int(min(2.0, m3));`) — this is the literal the spec leans on to justify 'X-BP' over 'NOTCH'. `qBase = (resonanceKnob…)*20.0 + 0.7;` is :67, not the cited :69. `qPing = qBase + ev * 30.0;` is :69, not the cited :70. `click = clickEnv(ping) * 1.5;` is :71, not the cited :72. The rationale's 'qbrt.dsp:59-73' overruns the file. The underlying facts (four taps at 0, 1/3, 2/3, 1 via m3=mSm*3 / seg=int(min(2,m3)) / t=m3-seg / ba.selectn at :46-52; Q 0.7..20.5; +30 boost; 1.5 click peak; edge(x) at :14) are all correct.

- **[MINOR]** The spec instructs preserving the def's face comment block while leaving a number in it that its own glyph derivation proves wrong, and that its 5th rank makes wrong twice.
  - *evidence:* qbrt.ts:119 reads `//   full (8):    all four — PING DEC joins last`. The full-tier cap is SIX, not 8: curated-face.ts:45 `LANE_PLATE_MAX_CELLS = PLATE_COLS * PLATE_MAX_ROWS` with module-shell-model.ts feeding faceTierCap('full', …) = 6 (pinned at curated-face.test.ts:258-259). After this face lands it is also no longer 'all four' — it is five. The spec's glyph field derives laneBodyPlan(4/5, true, 'full') in detail but never ledgers this stale line, and its glyph instruction ('keep the def's existing 8-line justification comment (qbrt.ts:124-130) verbatim') covers only :124-130 — which is 7 lines, not 8.

- **[MINOR]** vrtImpact's dock-diff causal list is in tension with the fold evidence the spec itself cites: it adds a 5th cell to the LAST band plus a new persistent readout line on a face already 18 px past the clipped faceplate cap, then asserts the 5th cell is one of 'three independent causes' of the diff.
  - *evidence:* e2e/vrt/vrt-exemptions.ts:1027-1031 states `.dock-faceplate` caps at `min(60vh, 680px)` = 425 px in the VRT viewport and lists 'filter/lfo/qbrt 18' as the measured overflow — content past that cap 'renders … below the fold, where the element screenshot never saw it.' The spec's pages[1] puts `qbrt-ping-{n}` first in the ping band (the trailing band), and the `mode` landmark readout (KnobConic.svelte:282-283, a 9 px line at :411-424) adds height above it. Whether the new PING cell contributes any pixels to face-qbrt-dock.png is unmeasured; the rationale simultaneously argues 'the band budget was never the constraint the batch specs assumed' from the same 18 px figure.


---

## delay

**Verdict: NEEDS_WORK** · archetype: mono insert FX — one audio in, one audio out, one param-targeted CV jack. The "processor" face archetype shared with reverb / shimmershine / cloudseed / filter (glyph `meter`, curated rear `signal` band labelled `mono in`, house `output blend` tail page). delay is the primitive of that family: no sync, no tone, no stereo, no feedback CV. What separates it from every sibling is that its hero knob is the only one that makes a SOUND OF ITS OWN — the DelayNode is a fractional-read line, so moving TIME varispeeds the buffer and Dopplers the tail (measured, delay.ts:10-17: +0.5 s ramp over 1 s drops a 1 kHz sine to ~498 Hz = the exact varispeed prediction, nowhere near the 1000 Hz a crossfading line would hold).

**DEFECTS — fix these before building:**

- **[MAJOR]** ciDelta states faces-parity goes "4 cells → 5". The def has THREE params and zero control families, so the dock renders 3 cells today and 4 after adding time_cv_amt.
  - *evidence:* packages/web/src/lib/audio/modules/delay.ts:92-94 declares exactly three ParamDefs (time, feedback, mix); the def has no `controlFamilies`. e2e/tests/faces-parity.spec.ts:585-588 asserts `expect(cells.length).toBe(defIds.length + (spec.controlFamilies?.length ?? 0))` — a gate that is green on main, so delay's rendered cell count is provably 3. The plan's own CI table agrees: `.myrobots/plans/dx7-and-faces-design-program-2026-07-27.md:1325` reads "Batch B | qbrt +1, delay +1, reverb +1 | +2.4 s" (3 modules × 1 cell × 0.8 s). The derived +0.8 s survives; the absolute counts are both off by one.

- **[MINOR]** newParams says the factory "is three GainNodes and a native DelayNode (delay.ts:181-232)". It is FIVE GainNodes, and the cited range truncates the factory mid-map.
  - *evidence:* packages/web/src/lib/audio/modules/delay.ts:182 `inputGain`, :197 `dry`, :204 `feedback`, :206 `wet`, :218 `output` — five `ctx.createGain()` calls, plus `ctx.createDelay(MAX_DELAY_S)` at :202. The factory body runs :181-275; :232 lands inside the `outputs` Map literal. The spec contradicts itself: its ART risk bullet correctly cites "factory (:181-275)".

- **[MINOR]** reverb.ts:99 is cited for two mutually exclusive facts — as reverb's `order` leading with `mix`, and as reverb's one-control 'output blend' page.
  - *evidence:* packages/web/src/lib/audio/modules/reverb.ts:96 is `order: ['mix', 'size', 'damp']`; :99 is `{ id: 'output', label: 'output blend', controls: ['mix'] },`. The controlLoss citation ("reverb.ts:99 (1)") is right; the rank-3 rationale citation ("reverb.ts:99 leads with `mix`") points at the wrong line and should be :96. The parallel citations cloudseed.ts:626 (4 controls) and shimmershine.ts:271 (1 control) both check out exactly.

- **[MINOR]** The band label `echo · time · feedback · mix` does not follow the precedent the spec cites, and lists only 3 of the page's 4 controls.
  - *evidence:* .myrobots/plans/dx7-and-faces-design-program-2026-07-27.md:696 is the cited lfo precedent: `{ id:'engine', label:'rate · depth · shape' }` — the label is the MEMBER LIST ONLY; the page id is never repeated inside it. The spec prepends the id word ('echo ·') and then omits `time_cv_amt`, so the label is neither the cited style nor a complete member list. Nothing gates page-label text (module-face-lint.test.ts:193-206 checks only glyph validity and order duplicates), so this is style, not a build failure.

- **[MINOR]** "the SMALLEST gesture a full-scale LFO can make is a half-second sweep" contradicts the spec's own halfSpan arithmetic in the same sentence.
  - *evidence:* packages/web/src/lib/audio/cv-scale.ts:58-61 — `const halfSpan = (paramMax - paramMin) / 2; const effective = knob + cv * depth * halfSpan;` For delay's time (0.001..2) that is 0.9995, which the spec states correctly two clauses earlier as ±0.9995 s. A full-scale ±1 CV is therefore a ~1 s excursion each way (~2 s peak-to-peak), not "a half-second sweep". The dead-feature argument is unaffected; only the number is wrong.

- **[MINOR]** A cluster of line/path citations drift by a few lines or name the wrong directory. All resolve to the right code, but a reader following them lands off-target.
  - *evidence:* rear-card-model.ts: the page loop is :287-300 (spec: :285-299) and the extra-curated append :302-307 (spec: :302-306); `rearHoleLabel` is :137-152 (spec: :133-149). module-face-lint.test.ts: the "rear derivation rendered a port TWICE" push is :768 (spec: :761-766). `looksLikeToggle` is in packages/web/src/lib/graph/group-controls.ts:46-48 — correct lines, but there is no ui/workflow/group-controls.ts and the spec gives no path. ModuleShell.svelte lives at packages/web/src/lib/ui/modules/ (not ui/workflow/), and its cluster render is :798-799 (spec: :792-801). KnobConic.svelte builds the vocab at :160 and emits `readout-<paramId>` at :283 (spec: ":162 calls it every animation frame", ":282-283"). Contrast: engine.ts:38, :456, :461-462, Canvas.svelte:7944, module-docs-lint.test.ts:151, module-face-lint.test.ts:419/:677, rear-card-model.test.ts pins (tidyVco :55, kickdrum :120, adsr :158, vca :182, lfo :195, cloudseed :210), art/scenarios/delay/profile.test.ts:110, contract-lock.txt:786-792/:1118, vrt-exemptions.ts:1004-1017, workflow-shell-faces.spec.ts:62/:74/:222 are all EXACT.

- **[MINOR]** `order` and `pages` rank `time_cv_amt`, which does not exist in the def. This is a declared new param, not an invention — but it makes the face unbuildable until the param lands in the SAME commit, and the spec never states that dependency as a hard ordering constraint the way it does for PF-12.
  - *evidence:* packages/web/src/lib/audio/modules/delay.ts:85-95 declares only time/feedback/mix. module-face-lint.test.ts:125-148 pushes an orphan for any `face.order` key that fails `keyResolves`, and :212-243 (STRICT_FACES completeness) fails any promoted module whose params are not all ranked. delay is in STRICT_FACES (strict-faces.ts:50) and STRICT_DOCS (strict-docs.ts:71), so the param, its `face.order` rank, its page membership AND its `docs.controls` entry (module-docs-lint.test.ts:151) must all land atomically or three unit gates go red.


---

## reverb

**Verdict: CONTRADICTS_CODE** · archetype: FX / mono insert processor — the "wet-dry blend at rank 1" FX archetype (cloudseed.ts:553, shimmershine.ts:249 name it verbatim). Mono in / mono out, ZERO CV ports, no families, no statics, no momentary, no paramCells. It is the simplest face shape in STRICT_FACES: N knobs in one signal-order band + a meter glyph. reverb.ts:53-54 — inputs `[{id:'audio',type:'audio'}]`, outputs `[{id:'audio',type:'audio'}]`.

**DEFECTS — fix these before building:**

- **[BLOCKER]** The ONE concrete DSP edit instruction points at the wrong line, and a second citation points past end-of-file. The spec says: "replace `fb2 = 0.5;` (reverb.dsp:18) with `fb2 = hslider(\"diffusion[style:knob]\", 0.5, 0.0, 0.95, 0.001);`" and separately "the Faust tank sums eight combs with no output scaling (reverb.dsp:20 → `re.mono_freeverb`)".
  - *evidence:* packages/dsp/src/reverb.dsp is 19 lines total. Line 15 is `  fb2 = 0.5;                              // fixed allpass feedback`. Line 18 is `  wet = re.mono_freeverb(fb1, fb2, d, 0.5, audio);` — i.e. the line the spec names as the edit target is the mono_freeverb call, not the constant. Line 20 DOES NOT EXIST. The same wrong :18 is repeated in newParams item 1 ("the hardcoded literal `fb2 = 0.5` at packages/dsp/src/reverb.dsp:18") and item 2. An implementer following the line number edits the wrong statement; this is the only file in the PR whose edit can change audio.

- **[MAJOR]** "`reverb.dsp` has exactly three `hslider`s and one hidden constant; after this PR the def↔DSP surface is 1:1 with zero un-exposed capability" is FALSE — there are TWO hidden constants — and the spec omits the `room`/`spread` rejection the plan explicitly requires it to state.
  - *evidence:* packages/dsp/src/reverb.dsp:18 `wet = re.mono_freeverb(fb1, fb2, d, 0.5, audio);` passes a hardcoded `0.5` as the 4th argument. The stdlib signature (extracted from node_modules/@grame/faustwasm/libfaust-wasm/libfaust-wasm.data) is `mono_freeverb(fb1, fb2, damp, spread) = _ <: par(i,8,lbcf(combtuningL(i)+spread,fb1,damp)) :> seq(i,4,allpass_comb(1024, allpasstuningL(i)+spread, -fb2))` with `// spread = spatial spread in number of samples (for stereo)`. So `spread` remains un-exposed after the PR. The plan's reverb §4 bullet at .myrobots/plans/dx7-and-faces-design-program-2026-07-27.md:753 mandates the statement "**`room` (Faust `spread`) is REJECTED** — see §2's demotion table. Reverb's contract cost is **+1, not +2**" (argued at plan:120). The spec never mentions room/spread anywhere.

- **[MAJOR]** The spec calls the pinned ART render "the DEFAULT render" and builds its entire byte-identity verification protocol on that framing. The pinned render is not at defaults.
  - *evidence:* art/scenarios/reverb/profile.test.ts:32 — `params: { size: 0.85, damp: 0.3, mix: 0.5 }`. Def defaults (reverb.ts:56-58) are size 0.5 / damp 0.3 / mix 0.3, so TWO of three are off-default (size +0.35 → fb1 = 0.5+0.45*0.85 = 0.8825, not 0.725). The spec's risks item 2 says "Keep it OUT of the pinned `renderProfile()` so the pin stays an honest statement about the DEFAULT render" — the pin has never been a default-render statement.

- **[MAJOR]** The spec asserts coverage-groups-6-7-8-9 "is the only bespoke e2e that touches this module". There are at least two others, and one of them is HARD-COUPLED to the exact DOM the spec's mandatory ReverbCard edit rewrites — and would break outright under the `size`→`Decay` relabel the spec discusses at length.
  - *evidence:* e2e/tests/param-edit-undo.spec.ts:42-81 is the repo's undo-tracking test and it drives ReverbCard specifically: `:51` spawns `type: 'reverb'`, `:61-62` locates `.svelte-flow__node[data-id="rev-1"] .track[role="slider"][aria-label="Size"]`, then hover + wheel. The spec's mandatory remedy rewrites that row (4th Fader, `.fader-row` → `display:flex; justify-content:center; gap:12px`, card widened). The `aria-label="Size"` selector also dies the moment the label becomes 'Decay' (plan:1455 OPEN item 6) — the spec argues the relabel purely on contract/VRT grounds and never names this selector. Also e2e/tests/docs-virtual-module.spec.ts:177-184 carries a reverb row (`controlParam: 'size'`, `cvPort: ''`, comment "reverb has no CV inputs (three knobs only)").

- **[MAJOR]** The card-widening remedy and its cited precedent are both derived from CSS widths that the committed VRT baselines contradict. The spec says "widen `.reverb-card` from 200 px (`:37`)" and "Adopt ShimmershineCard.svelte:41-47's explicit `display:flex…` row — 280 px holds five, so ~250 px holds four comfortably."
  - *evidence:* vrt.spec.ts:128 captures `.svelte-flow__node-reverb`; e2e/vrt/vrt.config.ts:226-227 pins `viewport: {width:1280,height:720}` + `deviceScaleFactor: 1` and sets no screenshot `scale`, so the baseline is CSS px. e2e/vrt/__screenshots__/vrt.spec.ts/darwin/reverb.png measures 360×361 against ReverbCard.svelte:37 `.reverb-card { width: 200px; }` — the 3-Fader row ALREADY overflows the declared width by ~160 px. Worse for the precedent: ShimmershineCard.svelte:41 declares `width: 280px` yet .../darwin/shimmershine.png measures 720×361, so "280 px holds five" is contradicted by 440 px. (Same pattern: MixerCard 260px → 720×361; VcaCard 160px → 360×361 — the captured box does not track the declared card width at all.) The spec's derived VRT mechanism ("the card widens off 200 px… A dimension change makes Playwright fail outright") is reasoning from a number the artifact disproves.

- **[MAJOR]** The spec's mandatory remedy — a 4th `<Fader>` for `diffusion` on ReverbCard — reproduces the exact def↔card divergence the spec spends a paragraph legislating against, because Fader cannot render `landmarks` at all.
  - *evidence:* `grep -n landmark packages/web/src/lib/ui/controls/Fader.svelte` returns ZERO hits. Landmarks are a KnobConic-only prop (KnobConic.svelte:51 `landmarks?: readonly ParamLandmark[]`, :160 vocab, :265 detent ticks, :283 `data-testid={`readout-${paramId}`}`), and the only consumer is the shell: ModuleShell.svelte:544 `landmarks={pd.landmarks}`. So the spec's own `[{0:'flutter'},{0.5:'classic'},{0.95:'smear'}]` roster renders in the shell dock and is invisible on the legacy card that legacy-fallback.ts:106-108 (`laneRenderKind`: `if (!i.workflowMode || !i.shellPreview || !i.hasCard) return 'legacy'`) serves to every dawless user. The controlLoss ledger names the missing-knob half of this and misses the missing-vocabulary half.

- **[MAJOR]** The spec folds a Faust rebuild + ART re-pin into a face PR, which the plan's own authoring recipe forbids for this exact constant — and the spec, asked to correct the plan where it is wrong, never flags the contradiction.
  - *evidence:* .myrobots/plans/dx7-and-faces-design-program-2026-07-27.md:1414-1417 (Step 8): "If a constant is hiding a real dimension (reverb's `fb2`, shimmershine's shifter `rate`), propose it as a **separate PR** with its contract line, docs entry, face rank, faces-parity cell and ART re-pin all itemized. **Never fold a DSP change into a face wave.**" The plan's Batch B bullet at :749-752 nonetheless lists `diffusion` as Contract +1 in the face wave, and :1233 flags it as "the one thing in the face program that can move audio". The spec adopts :749 and is silent on :1417.

- **[MINOR]** The archetype framing quotes two sources "verbatim" for a phrase neither contains, and attributes a rank neither supports.
  - *evidence:* The spec opens: 'the "wet-dry blend at rank 1" FX archetype (cloudseed.ts:553, shimmershine.ts:249 name it verbatim)'. packages/web/src/lib/audio/modules/shimmershine.ts:249 actually reads "the cloudseed FX archetype's wet/dry blend at rank **2**", and shimmershine.ts:267 is `order: ['shimmer', 'mix', 'decay', 'size', 'damp']` — mix at rank 2. cloudseed.ts:553 reads "wet/dry blend center-stage" with no rank, and cloudseed.ts:569-577 ranks `late_out, dry_out, late_line_decay, early_out…` with no `mix` param at all.

- **[MINOR]** A run of citation off-by-ones. None changes a conclusion — every one brackets the right code — but they should be corrected before the spec is used as an implementation map.
  - *evidence:* KnobConic.svelte:277 cited for the `.label` div → it is :278 (the readout testid is :283). module-docs-lint.test.ts:171-173 cited for STRICT_DOCS param completeness → the loop is :170-172. contract-signature.ts:105-108 cited for the param sort → `for (const p of [...(def.params ?? [])].sort(byId))` is :108, `byId` (localeCompare) is :73. rear-card-model.ts:297 cited for the empty-band drop → `if (band.holes.length > 0) bands.push(band);` is :299. coverage-groups-6-7-8-9.spec.ts:36 cited for the named-param spawn → :37. module-face-lint.test.ts:677 cited for the cellCount gate → :677 is `const LANE_TIERS`, the `it(...)` is :678. legacy-fallback.ts:32-38 cited for the dawless-always-legacy rule → :32-38 is the `LaneRenderKind` type + snowflake header; the rule is the file header :20-22 and `laneRenderKind` at :106-108. "docs promise 'the tail always dies — 0.95 is the ceiling' (reverb.ts:20, docs.controls.size)" conflates two places — :20 is the file-header comment; the docs.controls.size sentence is reverb.ts:128.

- **[MINOR]** The allpass tap figures are quoted as absolute sample counts without stating the sample rate they belong to, while the rest of the spec (and the ART harness) runs at the module's live SR.
  - *evidence:* The spec: "at 0 the allpasses degenerate to pure delays (225/341/441/556 samples ≈ 5.1/7.7/10/12.6 ms)". The stdlib (libfaust-wasm.data, mono_freeverb `with{}` block) defines `origSR = 44100; allpasstuningL(0) = 556*SR/origSR : int; (1) = 441…; (2) = 341…` — the taps RESCALE with SR (reverb.ts:16-17 and docs.explanation both say so). The millisecond figures survive the rescale; the sample counts are the 44.1 kHz values only (at 48 kHz they are 245/371/480/605).


---

## shimmershine

**Verdict: NEEDS_WORK** · archetype: Time-based stereo FX insert — the reverb/delay/cloudseed archetype (`category: 'effects'`, `palette: {top:'Audio modules', sub:'Effects'}`, `glyph: 'meter'`, `stereoPairs: [[in_l,in_r],[out_l,out_r]]`, shimmershine.ts:211-216). Structurally: a Schroeder tank you tune + ONE gain that regenerates it + ONE gain that blends it out. Zero sources, zero gates, zero discrete params, zero control families, zero card-only buttons — the simplest face in Batch D by a wide margin.

**DEFECTS — fix these before building:**

- **[MAJOR]** The spec's `pages[].label` values are explanatory PROSE, not labels — and they render verbatim as the dock band header AND the rear band header. 'reverb tank · damp is inside the combs' (38 chars) and 'the tank output · fed back, then blended out' (44 chars) would replace the 2-word headers the committed baseline shows.
  - *evidence:* curated-face.ts:292-297 — `dockFacePlan` maps `pages` straight through as `{id: p.id, label: p.label, …}`; rear-card-model.ts:291 — a page with no matching curated group becomes `{ id: page.id, label: page.label, holes: [] }`. So the page label IS the rendered band caption on both faces. Every shipped face uses 1-3 lowercase words: reverb.ts:98 `{ id: 'tank', label: 'reverb tank' }`, delay.ts:133-134 `'delay line'` / `'output blend'`, dx7.ts:225 `label: 'voice'`, and shimmershine's own current pages at shimmershine.ts:269-271 — which is exactly what e2e/vrt/__screenshots__/workflow-shell-faces.spec.ts/darwin/face-shimmershine-dock.png renders as `REVERB TANK` / `SHIMMER LOOP` / `OUTPUT BLEND` at ~90 px band pitch. A 38/44-char uppercase header does not fit that band and contradicts the house style the spec claims to be following.

- **[MAJOR]** The spec omits the `face.rear.groups` label-override entries that its OWN risk section and newParams section presuppose, and that the plan explicitly demands — then mis-cites the plan line range so the requirement disappears.
  - *evidence:* The deliverable declares NO rear change (the `rationale` rear derivation names only the existing curated `signal`). Yet `risks[2]` says "The two `ports: []` curated rear groups are a LABEL-ONLY override…" and `newParams[2]` says damp_cv "FALSIFIES this spec's rear label 'tank cv · DAMP has no jack'" — two pieces of config that appear nowhere in the spec. The plan flags this exact item as its own bullet at .myrobots/plans/dx7-and-faces-design-program-2026-07-27.md:858-860: "⚠ **The rear band labels need explicit `rear.groups` entries** — with no curated group for id `loop`, the rear band inherits the **page** label… The draft assumed they'd appear." The spec's correction (b) cites "plan:855-859" as if that whole range were the page-split bullet; the page-split bullet is :855-857 and :858-860 is the separate rear-label warning it never engages. Result: the face is not buildable as specified without a decision the spec never makes (long page labels, or the missing rear groups).

- **[MINOR]** A claim the spec presents as directly MEASURED from the committed PNG is contradicted by that PNG: the OUTPUT BLEND band LABEL is fully rendered, not "entirely below the fold". Only the MIX knob is clipped.
  - *evidence:* e2e/vrt/__screenshots__/workflow-shell-faces.spec.ts/darwin/face-shimmershine-dock.png (1220×425). Cropping rows 370-425 shows the header text `OUTPUT BLEND` painted in full at y≈383, with the MIX knob half-drawn beneath it. The spec's rationale states: "the third band OUTPUT BLEND is **clipped at the frame edge — its MIX knob half-drawn, its label entirely below the fold.**" The knob clause is true; the label clause is false. This is the second of the two justifications the spec offers for the 3→2 band collapse, and it is the one presented as independent measured evidence.

- **[MINOR]** Wrong line for the structural gate the spec instructs the implementer to move in the same commit — the `face-page` count assertion is at :222, not :227.
  - *evidence:* e2e/vrt/workflow-shell-faces.spec.ts:222 — `await expect(faceplate.locator('[data-testid="face-page"]')).toHaveCount(pages);`. Line :227-228 is inside the subsequent `toHaveScreenshot({ … maxDiffPixels: DOCK_MAX_DIFF })` call. The spec's vrtImpact says "the dock test asserts `[data-testid="face-page"]` `toHaveCount(pages)` (:227)". (The substantive claim — that the count assert precedes and therefore fails before the pixel pin — is correct; only the anchor is wrong. `{ type: 'shimmershine', pages: 3 }` at :56 is correct.)

- **[MINOR]** The `tail`-glyph demotion is cited to plan line 117; the `tail` row is at line 116. Line 117 is the `response` glyph row — a different demoted item.
  - *evidence:* .myrobots/plans/dx7-and-faces-design-program-2026-07-27.md — :112 `### DEMOTED — explicitly, with the reason`, :113 blank, :114 table header, :115 separator, :116 the `**`tail` glyph kind**` row, :117 the `**`response` glyph kind**` row. The spec's `glyph` field says "The `tail` glyph proposed for this module is DEMOTED in the plan (§2, line 117) on three independent defects" — the three-defect reasoning belongs to :116.

- **[MINOR]** Correction (e) attacks a BATCH-level dependency line as though it were a shimmershine claim, so "the plan is wrong" overstates it.
  - *evidence:* Plan :845 `### BATCH D — shimmershine · adsr · mixer · filter`, :846 `Depends on: **PF-1, PF-4, PF-9**.` The dependency is declared for the four-module batch, and the plan itself assigns PF-9 clusters to *filter* at :1134 (`- **PF-9 clusters on the `envelopes` band**: `filter eg` … vs `amp eg``) and PF-1/PF-10 to qbrt/filter mode elsewhere. The spec's "plan:846 makes Batch D depend on PF-1/PF-4/PF-9. **shimmershine needs NONE of them**" is true of shimmershine but is not a plan error. (The underlying verification is sound: DIRECTION_SUFFIX = /_(?:in|out)$/ at patch-panel-labels.ts:166 does not match `in_l`/`out_r`, so PF-4 is genuinely unneeded.)

- **[MINOR]** Citation drift across ~9 code anchors, several landing on a different statement than the one quoted.
  - *evidence:* packages/dsp/src/shimmershine.ts — the "self-caps at 0.92" comment is at :33 (spec says :32); "size=1, decay=1 → comb fb ≈ 0.92" is at :247 (spec says :248, which is `const effSize = …` — a line the spec separately and correctly cites as :248); `outL[i] = dryL * (1 - mix) + wetL * mix` is at :273 (spec says :271, which is `this.fbR = …`); the `2.0` rate / 25 ms window literals are at :225-226 (spec says :224, the comment). shell-glyph-live.ts — `glyphBinding` starts at :102 and the `if (audioOut) return { kind: 'live-audio', portId: audioOut }` branch the spec depends on is at :147 (spec says ":83-105"; only its `primaryAudioOutPortId` :86 is right). contract-signature.ts:108 sorts params by id (spec says :107). e2e/tests/faces-parity.spec.ts:97-98 defines FACE_FIXED_MS/FACE_PER_CELL_MS, applied at :597 (spec says :96-97). e2e/vrt/vrt.config.ts:60 lists workflow-shell-faces.spec.ts in FULL_MATCH (spec says :59). None of these change a conclusion, but the spec's authority rests on the citations.

- **[MINOR]** "0 legend statics (no shimmershine.legend.json exists — only adsr/lfo/sequencer do)" conflates a VRT annotation overlay with the shell-cells STATIC cell registry. The conclusion is right; the cited evidence proves nothing about it.
  - *evidence:* The only `*.legend.json` files in the repo are e2e/vrt/__annotated__/{adsr,lfo,sequencer}.legend.json — VRT annotation overlays. The face-lint's family/static resolution reads `SHELL_CELLS` (packages/web/src/lib/ui/workflow/shell-cells.ts:161, `Record<moduleType, Record<faceKey, ShellCell>>`) and `def.controlFamilies` (module-face-lint.test.ts:125). shimmershine has no SHELL_CELLS entry and no controlFamilies, which is the actual reason it ranks no family/static keys.


---

## mixer

**Verdict: NEEDS_WORK** · archetype: SYMMETRIC-BANK UTILITY — N interchangeable channel controls plus one master. Every design tension in this face descends from that shape (an arbitrary rank 2, a plate order that fights the priority order, and no legal way to collapse the bank into one cell), and none of them is a mixer-specific accident: mixmstrs, attenumix and moog984 are the same archetype waiting behind it.

**DEFECTS — fix these before building:**

- **[MAJOR]** The VRT ledger is presented as exhaustive but omits mixer's THIRD baseline pair — the legacy-card scene, which is in the REQUIRED vrt-strict subset, and which is the one surface the spec proposes editing.
  - *evidence:* ciDelta says "VRT runs the same two mixer scenes (compact + dock)" and vrtImpact enumerates only face-mixer-dock.png (MOVES), face-mixer-compact.png (UNCHANGED) and "there is no mixer rear scene" (NOT AFFECTED). But e2e/vrt/__screenshots__/vrt.spec.ts/darwin/mixer.png AND .../linux/mixer.png both exist — the per-card scene auto-enrolled by e2e/vrt/vrt.spec.ts:55-58 — and mixer is listed in STRICT_VRT_MODULES at e2e/vrt/vrt-exemptions.ts:886 ('mixer', // 4-channel mixer fader card), i.e. the `vrt-strict (visual regression — strict subset)` REQUIRED context, not the informational lane. The spec's own controlLoss item edits that exact file ("DELETE the card's labels map") and changes the rendered output label from 'OUT' to 'MIX' (MixerCard.svelte:24 `portsFromDef(mixerDef.outputs, { audio: 'OUT' })` -> PortDef.label 'MIX', consumed verbatim-uppercased by patch-panel-labels.ts:189-191 at PatchPanel.svelte:1036). The scene is never named, so nobody is told to check it.

- **[MAJOR]** The structural-gate edit instruction — stated twice, as the one same-commit change that prevents a confusing red — points at the WRONG LINE, and the line it names is a DIFFERENT module's row.
  - *evidence:* risks and vrtImpact both say: "e2e/vrt/workflow-shell-faces.spec.ts:47 `{ type: 'mixer', pages: 2 }` -> `pages: 1`". e2e/vrt/workflow-shell-faces.spec.ts:47 is `{ type: 'adsr', pages: 1 }`. mixer's row is line 61. The count assertion cited as ":227" is at :222 (`await expect(faceplate.locator('[data-testid="face-page"]')).toHaveCount(pages);`).

- **[MAJOR]** The glyph field's headline — a "MEASURED CORRECTION TO THE DEF'S OWN SAFETY CLAIM" that the face comment "must say so instead of claiming otherwise" — contradicts the def, which already says the glyph steps aside at the full tier.
  - *evidence:* mixer.ts:100-102 already states: "full-in-lane (plate)  all five (5 cells <= the 3x2 whole-cell cap; the glyph steps aside for the ranked controls, per laneBodyPlan) — the complete mixer in the lane." The laneBodyPlan arithmetic the spec derives is correct (module-shell-model.ts:339-342), but there is nothing to correct: the def never claims the meter renders at 'full'. The claim it does cite, mixer.ts:104-108, is about the meter being load-bearing where it renders, and is scoped by :100-102.

- **[MAJOR]** The FOR-side evidence for renaming the output 'OUT' -> 'MIX' misreads the DIRECTION_SUFFIX rule; the file cited is evidence AGAINST the rename.
  - *evidence:* Spec: "the repo's own DIRECTION_SUFFIX rule (patch-panel-labels.ts:148-165) kills 'OUT' next to a '->' glyph as saying it twice". The rule is `const DIRECTION_SUFFIX = /_(?:in|out)$/` at patch-panel-labels.ts:166, applied in expandStem at :171 — it strips a trailing `_in`/`_out` from a COMPOUND id (`audio_out` -> 'AUDIO'); it can never match a standalone label or the bare id `audio`. The same file deliberately PRESERVES the word: ABBREV_TO_VERBOSE maps `out: 'OUT'` at :105, and PREFIX_TO_VERBOSE expands `^out([LR])$` -> 'OUT L'/'OUT R' at :142. The companion cite "ABBREV_TO_VERBOSE['audio'] = 'AUDIO', patch-panel-labels.ts:104" is at :106.

- **[MINOR]** The faces-parity failure mode is overstated: an unrecognised cell kind fails ONE module's test, not "the whole spec".
  - *evidence:* e2e/tests/faces-parity.spec.ts:533 `throw new Error(...unknown cell control kind...)` sits inside driveCell, which is called from the per-type test generated at :537-538 (`for (const type of [...STRICT_FACES].sort()) { test(...) }`). It aborts the remaining cells of that one module's test; the other STRICT_FACES tests are independent. The cite ":531" is :533.

- **[MINOR]** Systematic +/- few-line citation drift on the svelte/e2e/art anchors, so a reviewer cannot trust the spec's line numbers even where the substance is right.
  - *evidence:* ModuleShell.svelte ":379" -> :380 (`portsFromDef(def.inputs ?? [])`); ":815" -> :817 (`controls.slice(0, lanePlan.cellCount)`); shell-glyph-live.ts ":150" -> :147 (`if (audioOut) return { kind: 'live-audio', portId: audioOut };`); shell-glyph-live.ts ":295" -> :292 (`audio.getOutputNode(nodeId, portId)`); art/scenarios/mixer/profile.test.ts ":87" -> :83 (`const srcSha = await dspSourceSha('mixer.dsp');`); vrt-exemptions.ts "1033-1035" -> the 421->398 sentence is :1033-1034. (By contrast the contract-signature.ts:76-88 / :91-129, contract-lock.txt:1797-1807, module-face-lint.test.ts:419/:618, Fader.svelte:337/437-439/453, KnobConic.svelte:205, level-meter.ts:24, attenumix.ts:137 and faces-parity.spec.ts:265 cites are exact.)

- **[MINOR]** The controlLoss ledger declares the one-source-of-truth audit closed while leaving the card's re-typed RANGES unmentioned — the exact divergence class the standard is written about.
  - *evidence:* The ledger flags only the labels map (MixerCard.svelte:21-24) as the def-disagreement risk, and the rationale asserts "the control ledger really is closed" off a grep pattern (`<button|<select|<input|...|Knob|XyPad`) that cannot see numeric literals. MixerCard.svelte:33-37 re-types `min={0} max={1} defaultValue={1} curve="linear"` on all five Faders, duplicating mixer.ts:72-76. The values AGREE today, so this is latent rather than a live bug — but it is the same single-source violation the spec argues must be fixed for labels, and the spec's own PF-19 (promoting Fader into the shell) is what would remove it.


---

## filter

**Verdict: CONTRADICTS_CODE** · archetype: PROCESSOR · single-engine VCF. One hero the hand SWEEPS (cutoff), one hand RIDES (resonance), one set-once switch that RE-FRAMES what the hero means (mode), and one two-knob modulation-depth stage that decides how hard a patched EG/LFO throws the sweep. Not a voice (no gate/pitch in), not a mixer (one audio in / one audio out), not a multi-engine effect (three parallel fi.reson sections but ba.selectn picks exactly one — filter.dsp:9).

**DEFECTS — fix these before building:**

- **[BLOCKER]** The spec's rear-card TOTALITY PROOF is arithmetically wrong: it states "bands = [signal(audio), modulation/'cv depth'(cutoff,res)], holeCount 2+1 = 3 = declared port count. Totality gate green." Both sides of that equals sign are false, and the error is exactly the class it cites elsewhere — a metric invariant to the dimension under test.
  - *evidence:* packages/web/src/lib/ui/workflow/rear-card-model.ts:328-330 — `const holeCount = bands.reduce(...) + outs.length;`. The field's own docstring at :105-107 reads "Total hole count (inputs + outputs) — always equals the declared port count (the no-orphan-holes guarantee, linted)." For filter: 1 (signal) + 2 (modulation) input holes + 1 output = holeCount 4. Declared port count is also 4 — 3 inputs (filter.ts:65, :89, :90) + 1 output (filter.ts:92). The spec used the code's own named field with the outputs term dropped, so its "proof" would have read 3=3 GREEN even if filterDef.outputs had been emptied. That is a false verification of a linted invariant, stated with the code's vocabulary.

- **[MAJOR]** The def CONTRADICTS ITSELF on the HP/BP slopes, and the spec mis-files this as unverifiable ("filters.lib is not vendored ... treat the sentence as suspect") while simultaneously endorsing a roster that says the opposite. No external library is needed to see it — the contradiction is inside filter.ts.
  - *evidence:* filter.ts:205 (docs.controls.mode): HIGHPASS "is built as input-minus-lowpass, so its deep stopband tapers at 6 dB/octave rather than 12" and BANDPASS has "6 dB/octave skirts on both sides". The SAME FILE asserts 12 dB/oct four times: filter.ts:6-7 ("three `fi.reson{lp,hp,bp}` 2-pole (12 dB/oct) sections"), filter.ts:115 (option title "Highpass — ... (12 dB/oct)"), filter.ts:116 (option title "Bandpass — ... (12 dB/oct)"), filter.ts:188 (docs.explanation "All three are two-pole (12 dB/octave)"). The spec's risks[6] asserts the BP-6dB reading "is correct" — which makes filter.ts:116 wrong — while its rationale correction (a) instructs "Do NOT paste the plan's snippet" and treats the shipped roster as untouchable. Those two spec claims cannot both stand. The stated reason for untouchability is also wrong in scope: faces-parity.spec.ts:692 pins only `toHaveText(['LP','HP','BP'])` (the LABELS); `title` is asserted nowhere, so correcting the titles costs zero test churn. The spec's own docs ratchet would cement the contradictory sentence.

- **[MAJOR]** The VRT impact ledger enumerates the WRONG scene set. The spec says "The VRT scene count is unchanged (2 per platform)" and "exactly 2 files move (darwin + linux face-filter-dock.png)", but filter has THREE baseline pairs, and the third one is in the REQUIRED vrt-strict lane and captures the very component the spec's PR edits.
  - *evidence:* e2e/vrt/__screenshots__/vrt.spec.ts/darwin/filter.png and .../linux/filter.png both exist (the legacy FilterCard scene). `filter` is a member of STRICT_VRT_MODULES at e2e/vrt/vrt-exemptions.ts:883 (`'filter', // filter knob card`), and e2e/vrt/vrt.spec.ts:35,50 restrict `task vrt:strict` — the required `vrt-strict (visual regression — strict subset)` context — to that set. The spec's own PR body edits FilterCard.svelte:22 (the setNodeParam bug-fix) and FilterCard.svelte:26/:35-36 discussion. The conclusion ("zero baselines move") happens to survive because setNodeParam is pixel-neutral, but the ledger and the `git rm`-before-dispatch contingency in risks[0] are both incomplete for the lane that gates the merge.

- **[MINOR]** Systematic off-by-N line citations in every file OUTSIDE packages/web/src/lib/{docs,graph,ui} — the e2e specs, the strict-faces registry, and the Faust source. The lib-side citations are exact; these are not.
  - *evidence:* strict-faces.ts:46 → `'filter'` is at packages/web/src/lib/ui/workflow/strict-faces.ts:51; line 46 is where `'filter'` sits in the DIFFERENT file packages/web/src/lib/docs/strict-docs.ts. e2e/vrt/workflow-shell-faces.spec.ts:76 for DOCK_MAX_DIFF → actual :74 (`const DOCK_MAX_DIFF = 1500;`); ":57 FACES table" → the table opens at :43 and the `{ type: 'filter', pages: 2 }` row is :60. e2e/tests/faces-parity.spec.ts:650 for `data-shell-tier','full'` → :653; :661 for `toHaveText('LP')` → :659; :694 for `toHaveText(['LP','HP','BP'])` → :692. packages/dsp/src/filter.dsp:9 for `ba.selectn` → :9 is BLANK, `ba.selectn(3, int(modeKnob), lp, hp, bp)` is :10; ":12" for the ±5-octave mapping → :12 is the comment, the code is :13; "si.smoo (filter.dsp:12-13)" → si.smoo is on :13 and :14; "fi.resonhp (filter.dsp:18)" → :18 is `fi.resonlp`, resonhp is :19.

- **[MINOR]** "filter.dsp declares exactly THREE UI elements (cutoffKnob :6, resKnob :7, modeKnob :8) ... are engine-graph GainNodes, not hsliders" — the framing is wrong for one of the three.
  - *evidence:* packages/dsp/src/filter.dsp:8 is `modeKnob = nentry("mode", 0, 0, 2, 1);` — an `nentry`, not an `hslider`. Only :6 and :7 are hsliders. The count of three UI elements and the strict-superset conclusion hold; the "not hsliders" contrast does not.

- **[MINOR]** "both platforms' files dated Jul 28, regenerated by #1213" is false for half the baselines it names.
  - *evidence:* `ls -la` on e2e/vrt/__screenshots__/workflow-shell-faces.spec.ts: darwin/face-filter-compact.png and linux/face-filter-compact.png are both dated **Jul 26 07:58**; only face-filter-dock.png (darwin + linux) is Jul 28 13:28. This is consistent with the spec's own model — faceTierCap('compact', true) = LANE_ROW_MAX_CELLS_WITH_GLYPH = 2 (curated-face.ts:77, module-shell-model.ts:286), so the compact tile holds only cutoff+resonance and a `mode` primitive swap could not move it — but the stated fact is still wrong.

- **[MINOR]** The `res` port is filed under the wrong classification branch: "its stem is `res`, the param is `resonance` — the tidyVco pwm_cv/pw class". `res` and `pwm_cv` reach the voice band by DIFFERENT branches; they are not the same class.
  - *evidence:* packages/web/src/lib/ui/workflow/rear-card-model.ts:125-129 — `rearTargetParamId` returns a target only for an explicit `paramTarget` or an id ending `_cv`. tidyVco's `pwm_cv` DOES yield target 'pwm' and is then rejected by the `paramIds.has(target)` half of the test at :229. filter's `res` (filter.ts:90) has no `_cv` suffix and no paramTarget, so rearTargetParamId returns `undefined` and `isPerParamCv` is false at the FIRST clause — it never reaches the paramIds test. Same destination (:231 voice.push), different mechanism. Note the def's own comment at filter.ts:83-88 states this correctly ("port id 'res' is intentionally short"), and I confirmed the label table it relies on: patch-panel-labels.ts:55 `res: 'RESONANCE'`.


---

## tomtom

**Verdict: NEEDS_WORK** · archetype: struck percussion voice (drum family: kickdrum · snaredrum · tomtom · clap) — one mono trigger-driven engine, a manual press-pad audition, a per-knob CV on every continuous control, live-audio 'scope' glyph. Already in STRICT_FACES + STRICT_DOCS (strict-faces.ts:48, strict-docs.ts:384).

**DEFECTS — fix these before building:**

- **[MAJOR]** "VRT scene count is unchanged (2 tomtom scenes; no new scenes)" — there are FIVE tomtom VRT scenes, not two, and the vrtImpact ledger never names the other three.
  - *evidence:* e2e/vrt/vrt-karplus-tomtom-states.spec.ts:74 ('tomtom-simmons-zap'), :82 ('tomtom-timbale-tight'), :91 ('tomtom-strike-held') — three committed scenes with baselines on BOTH platforms (e2e/vrt/__screenshots__/vrt-karplus-tomtom-states.spec.ts/{darwin,linux}/tomtom-*.png), registered in vrt.config.ts:52. The spec asserts the count twice (ciDelta and vrtImpact) and both are wrong. I verified the conclusion survives — those scenes capture the LEGACY card (`.svelte-flow__node-tomtom` at /rack, spec L129) and I opened tomtom-strike-held.png: it is the MEMBRANE/COLOR/OUT fader card with the orange .held STRIKE button, untouched by a `face` change. But the spec's own rule is "UNCHANGED (assert, do not assume)", and the one scene it omits is literally the STRIKE pin — the control this face relocates. The ledger must name all five and state why three do not move.

- **[MAJOR]** "a per-band constant of 88 px cross-checked six ways across nine faces ... every step exactly 88" — the SAME committed line the spec cites contains three rows that falsify the linear model, and the spec omits all three.
  - *evidence:* e2e/vrt/vrt-exemptions.ts:1030-1032 reads in full: "cloudseed 498, kickdrum/sixstrum 370, snaredrum/tidyVco 282, tomtom 194, dx7 166, karplus 106, shimmershine 58, filter/lfo/qbrt 18". Cross-referencing the page counts in e2e/vrt/workflow-shell-faces.spec.ts: shimmershine :56 = 3 pages measuring 58 while karplus :57 = 3 pages measuring 106 — two same-page-count faces 48 px apart, so the per-band cost is NOT a constant. dx7 :52 = 4 pages measuring 166 where the model demands 194 (tomtom's own figure). cloudseed :50 = 8 pages measuring 498 where 18 + 88x6 = 546. The spec's nine 'cross-checks' are exactly the nine rows that fit; the three that do not are on the same line and are never mentioned. The '18 px' post-merge prediction is therefore uncross-validated — overflow is a function of band CONTENT (wrap/rows/hero), not page count. (The first-principles case for tomtom specifically still holds: I read face-tomtom-dock.png and the band pitch is ~88-90 px with 3- and 2-knob bands, and 5 columns = 5x46 + 4x10 = 270 px cannot wrap inside the 900 px .faceplate-body floor at DockFullView.svelte:122/164/226. Say that instead of claiming a validated constant.)

- **[MINOR]** "packages/dsp/src/tomtom.ts:87 parameterDescriptors" — wrong line; :87 is a PARAM_SPECS table row.
  - *evidence:* packages/dsp/src/tomtom.ts:87 is `['strike', 0, 0, 1],`, the last entry of the PARAM_SPECS array which closes at :88. `static get parameterDescriptors()` is at :116, with `automationRate: (name === 'strike' ? 'k-rate' : 'a-rate')` at :124. The substantive claim (9 descriptors, no tenth control) is TRUE and independently verified.

- **[MINOR]** "vrt-meta.test.ts:469, `toBeLessThanOrEqual(119)`" — off by one.
  - *evidence:* packages/web/src/lib/audio/modules/vrt-meta.test.ts:468 is `).toBeLessThanOrEqual(119);` (the other ceiling, the stale-exemption ratchet, is at :508). The VALUE and the arithmetic are correct: I counted EXEMPT_BASELINE_PAIRS programmatically = 127 total, 119 starting 'linux/', and karplus has zero pending pairs, so 119->117 (tomtom alone) / 119->115 (with snaredrum's :1008-1009) is right.

- **[MINOR]** "`.dock-faceplate` caps at `min(60vh, 680px)` = 425 px in the 1280x720 VRT viewport" — 60vh of 720 px is 432 px; 425 is an observed screenshot height presented as a derivation.
  - *evidence:* e2e/vrt/vrt.config.ts:226 pins `viewport: { width: 1280, height: 720 }`; DockFullView.svelte:237 is `max-height: min(60vh, 680px)` with `padding-bottom: 4px` at :239. 0.60 x 720 = 432, not 425. The 425 figure is the committed baseline's actual height (face-tomtom-dock.png is 1220x425, verified) and is quoted verbatim from vrt-exemptions.ts:1027-1028 — so the number is fine, the stated arithmetic is not. Per CLAUDE.md's 'state the units / validate the instrument' rule this should read 'measured 425 px' not '= 425 px'.

- **[MINOR]** Citation drift on five references — all substantively correct, all off by 1-3 lines, in a spec whose whole value proposition is line-exact evidence.
  - *evidence:* serializeModuleContract cited :92-127, actually contract-signature.ts:92-129; ContractDefLike cited :35-53, actually :35-54; art/scenarios/tomtom/profile.test.ts cited :160-167, the second dspSourceSha is at :161; rear-card-model.test.ts cited :225-238, the negative-control `it(` opens at :224; TomtomCard.svelte:93 labels the jack 'V/OCT' not 'V-OCT'. (Counter-note: the load-bearing citations are EXACT — module-face-lint.test.ts:411-413 and :419-439, faces-parity.spec.ts:597, ModuleShell.svelte:430-445 and :797-806, DockFullView.svelte:237, types.ts:491-496/:503, p1-batch2-faces.spec.ts:40-47, plan line 1197, workflow-shell-faces.spec.ts:55, packages/dsp/src/tomtom.ts:156.)

- **[MINOR]** The spec silently renames the plan's page-2 label and omits it from its own numbered corrections list.
  - *evidence:* .myrobots/plans/dx7-and-faces-design-program-2026-07-27.md:955 specifies `stick · heat · out`; the spec ships `stick · breath · out` and discusses the label at length in risks/rationale without ever flagging it as a deviation, while listing six other numbered '§4 CORRECTIONS'. Given the spec's own standard ('a correction is more valuable than the spec itself'), the divergence ledger is incomplete. Substantively the change is defensible — the def's docs.explanation calls the layer BREATH, and NOISE is that layer — but it must be declared.


---

## karplus

**Verdict: NEEDS_WORK** · archetype: Externally-struck monophonic VOICE — a physical-model string with NO internal exciter. Unlike every other voice on the bar (dx7/sixstrum/tidyVco self-oscillate; kick/snare/tom ship a `strike` press-PARAM), karplus can only sound when something fires `trigger_in` (karplus.ts:55, edge:'trigger'). Its audition affordance is not a param and not a family — it is an engine `read()` seam (karplus.ts:288-295), which is why it is structurally unrankable today.

**DEFECTS — fix these before building:**

- **[MAJOR]** The archetype's central premise — that karplus is the ONE voice with no internal exciter, that 'dx7/sixstrum/tidyVco self-oscillate', and that its `read('manualTrigger')` audition seam is 'why it is structurally unrankable today' — is contradicted by SIXSTRUM, which is an externally-struck string voice with the identical seam and the identical unranked hole, already shipped in STRICT_FACES.
  - *evidence:* packages/web/src/lib/audio/modules/sixstrum.ts:377-384 declares `read(key){ if (key === 'manualTrigger') return () => { fireTrigger(strumCs, ctx.currentTime); } }` — the same shape as karplus.ts:288-295, with the comment 'On-card STRUM audition — fires one canonical trigger pulse at strum #1'. packages/web/src/lib/ui/modules/SixstrumCard.svelte:73-78 calls `e.read(node,'manualTrigger')` and :188-192 renders the audition `<button data-testid="sixstrum-strum">`. sixstrum does NOT self-oscillate: contract-lock.txt:2932-2937 declares `sixstrum in strum1..strum6 gate edge=trigger` plus `sixstrum in poly polyPitchGate` (:2929) — struck from outside exactly like karplus. sixstrum is listed in packages/web/src/lib/ui/workflow/strict-faces.ts with a shipped face whose order (sixstrum.ts:137-161) likewise never ranks its strum audition. karplus is therefore not the unique case the spec's whole rationale ('this is the whole point of the spec', 'the one voice in the rack that cannot make a sound by itself') rests on, and the correct framing is a PATTERN with a live unfixed sibling — which promotes the spec's own risk #5 (retire the family when PF-6 `face.actions` lands) from a footnote to the actual recommendation.

- **[MAJOR]** 'kick/snare/tom ship a `strike` press-PARAM' is false for two of the three named modules. Only tomtom declares one.
  - *evidence:* packages/web/src/lib/audio/modules/tomtom.ts:81 `{ id: 'strike', label: 'Strike', defaultValue: 0, min: 0, max: 1, curve: 'discrete' }` and :130 `momentary: ['strike']` → contract-lock.txt:3355 `tomtom param strike 0..1 discrete default=0`. kickdrum's FULL param list is contract-lock.txt:1481-1505 and snaredrum's is :3020-3041 — neither contains a `strike` param, and grep for 'strike|momentary' over kickdrum.ts returns ZERO hits and over snaredrum.ts only prose hits (no `momentary:` block on either def). The contrast the archetype draws — karplus is unrankable BECAUSE the drums solved this with a press-param — is supported by exactly one module, not three.

- **[MINOR]** The spec calls the bare `data-testid="karplus-strike"` a necessary 'deliberate, documented abuse of the family mechanism' and cites `sixstrum-preset` as its precedent — but the cited precedent actually FOLLOWS the documented convention, so nothing forces the deviation.
  - *evidence:* graph/types.ts:429-430 documents members as `${testidPrefix}-${nodeId}-${i}`. SixstrumCard.svelte:155 emits `data-testid={`sixstrum-preset-${id}-1`}` — the conventional form. KarplusCard.svelte:127 emits the bare `data-testid="karplus-strike"` only because no family existed when it was written, and the spec proposes to declare a family and KEEP the bare testid. Since the PR already edits that line to share `karplusStrike`, renaming it to `karplus-strike-${id}-1` costs one line and removes the 'abuse'. The spec's supporting claim is itself correct — I confirmed the grep is presence-only at module-docs-lint.test.ts:240 (`if (!cards.includes(f.testidPrefix))`) — but a weak gate is not a reason to deviate.

- **[MINOR]** The VRT ledger says 'TWO scenes exist for karplus' and names only vrt-karplus-tomtom-states.spec.ts as the unaffected legacy set. A THIRD committed baseline pair covers the legacy card and is omitted.
  - *evidence:* e2e/vrt/__screenshots__/vrt.spec.ts/darwin/karplus.png and .../linux/karplus.png exist on disk. e2e/vrt/vrt.spec.ts:55-57 builds `COVERED_MODULES = REGISTRY.filter(...)` — registry-driven, so karplus is enrolled without appearing by name (grep for 'karplus' in vrt.spec.ts returns nothing, which is exactly why it is easy to miss). The spec proposes touching KarplusCard.svelte twice (share `karplusStrike`; boy-scout the range derivation), so that pair belongs in the ledger.

- **[MINOR]** The 'the legacy card RE-TYPES every range as a literal' finding enumerates min/max/curve/units but omits `label`, which is the def-declared field that actually diverges TODAY (the ranges do not).
  - *evidence:* Def labels (karplus.ts:76,77,79,80,81,82): 'Decay','Bright','Stiff','Color','Burst','Level'. Card labels (KarplusCard.svelte:102,103,104,110,111,134): label="Dec", "Brt", "Stf", "Col", "Brst", "Lvl". Same one-source-of-truth class the spec correctly identifies for ranges, except this one is a LIVE divergence rather than a latent one — and it is the field that moves pixels, so a naive 'derive everything from the def' fix would move the vrt.spec.ts/karplus.png baseline the ledger omits. I did verify the eight RANGES agree value-for-value with karplus.ts:75-82, so that half of the spec's claim is correct.

- **[MINOR]** Two citation drifts.
  - *evidence:* (a) 'the three module-face-lint momentary clauses (module-face-lint.test.ts:391-439)' — the three clauses are at module-face-lint.test.ts:350, :391 and :419; the cited range covers only the last two. (b) 'Today's order already leads `decay, brightness` (karplus.ts:112-113)' — :112 is the `// hero ladder` comment; the keys are at :113 and :114.


---

## snaredrum

**Verdict: NEEDS_WORK** · archetype: Struck percussion VOICE with an internal MECHANISM (drum family — sibling to kickdrum/tomtom). No internal clock, no preset roster, no node.data: 22 ParamDefs, two strike inputs with DIFFERENT semantics (trigger_in edge:'trigger' → one hit; gate_in edge:'gate' → the two-hand roll engine), stereo audio_l/audio_r, glyph 'scope' (live analyser on audio_l). The archetype's distinguishing feature vs kickdrum/tomtom: it is the only drum with an ENGINE (roll_speed/bounce/humanize/spread), so the face must rank a mechanism, not just a timbre.

**DEFECTS — fix these before building:**

- **[MAJOR]** The delivered `pages` field omits the PF-9 `clusters` that the spec's own central argument depends on — a builder copying `pages` verbatim ships exactly the flat 7-control band the spec claims to reject.
  - *evidence:* Spec `pages[3]` = {id:'bus', controls:['tone','damp','drive','hard','ceiling','width','level']} with no clusters, which is byte-identical in membership+order to the plan's page 4 the spec says it 'REJECTS ... as specified' (plan .myrobots/plans/dx7-and-faces-design-program-2026-07-27.md:1008-1010). The six clusters exist only in the `rationale` prose. `ModuleFacePage.clusters` is a real merged field — graph/types.ts:503, resolved by curated-face.ts:186-204, rendered at ModuleShell.svelte:796-805 (`data-face-cluster`). Without them page 'bus' is a 7-control band spanning three ideas, which the plan's §1 rule at :63-64 ('Any merge that produces a 6+ control band whose members are three different ideas is rejected') rejects — the exact defect the spec charges the plan with.

- **[MINOR]** The vrt-meta linux-deficit ratchet citation points at the `it()` header, not the number to lower.
  - *evidence:* Spec: 'lower the vrt-meta linux-deficit ratchet (packages/web/src/lib/audio/modules/vrt-meta.test.ts:314-321) by exactly 2'. vrt-meta.test.ts:314 is `it('the linux-baseline deficit only shrinks toward zero', () => {`, :315 computes `linuxPending`, :316-321 is the assertion message. The literal to edit is `).toBeLessThanOrEqual(119);` at vrt-meta.test.ts:468. (I counted EXEMPT_BASELINE_PAIRS: exactly 119 `linux/` entries, so the '-2 → 117' arithmetic itself is right.)

- **[MINOR]** "Same PR also updates `cells.length === params + families` accounting: snaredrum goes 22 -> 23 (faces-parity.spec.ts:584-588)" is false — that assertion is registry-derived and needs no edit.
  - *evidence:* e2e/tests/faces-parity.spec.ts:588 asserts `.toBe(defIds.length + (spec.controlFamilies?.length ?? 0))`, where `spec` comes from `readSpec()` (:162) reading `__moduleSpecs`, which projects the live def — packages/web/src/lib/dev/module-specs.ts:154-168 builds `controlFamilies` from `def.controlFamilies`. Adding the family auto-updates both sides. Contrast the genuinely manual `{ type: 'snaredrum', pages: 5 }` → `4` at e2e/vrt/workflow-shell-faces.spec.ts:54, which the spec correctly flags.

- **[MINOR]** "There is NO press/release" overstates the platform gap — the momentary press/release primitive already exists and is already wired in ModuleShell.
  - *evidence:* packages/web/src/lib/ui/controls/Button.svelte declares `momentary?: boolean` (:18-19,:40), fires `onGate(high)` (:66), handles pointerdown/up/cancel/leave (:71-100) and emits `aria-pressed` (:127). ModuleShell.svelte:435-444 already renders `<Button momentary onGate={(high) => firePressParam(pd, high)}>` for `face.momentary` params. What is actually missing is a `mode`/`onGate` field on `ShellActionCell` (shell-cells.ts:62-67); the new-cell-kind cost is justified only by wanting TWO pads in ONE cell, not by the absence of press/release.

- **[MINOR]** The proposed `'strike'` driveCell probe contradicts the primitive it names: a `mode:'trigger'` pad has no `aria-pressed` to assert.
  - *evidence:* Spec risk 4: the branch should prove 'mouse.down -> aria-pressed="true", mouse.up -> aria-pressed="false"' for the pads. Button.svelte:127 is `aria-pressed={momentary ? pressed : undefined}` — a one-shot Button (the `onTrigger` path the spec itself cites at ModuleShell.svelte:584) emits no `aria-pressed` at all. The HIT pad is declared `mode:'trigger'`, so the probe cannot pass on it unless the new cell renders trigger pads as `momentary` Buttons — which the spec never states.

- **[MINOR]** The card-label-abbreviation ledger is enumerated but incomplete — it misses `wire`.
  - *evidence:* Spec controlLoss lists GDmp/Dec/Amt/Drv/Sprd/Wid/Lvl/Ceil/PAmt/PTim. SnaredrumCard.svelte:157 paints `label="Wire"` while snaredrum.ts:103 declares `label: 'Wires'` — a further visible text change on every dock/compact baseline that the ledger does not name. (The `wire_tone` 'Tone'→'W Tone' case is separately covered by the 'Tone three times' note.)

- **[MINOR]** Two plan citations are wrong, and one plan-vs-spec divergence is left unflagged in a section that claims to enumerate the corrections.
  - *evidence:* (a) Spec risk 10 cites karplus's `order` array at 'line 984 of the plan'; the array is at .myrobots/plans/dx7-and-faces-design-program-2026-07-27.md:970 — :984 is the PF-6f remedy bullet. The substance of the trap (no `karplus-strike-{n}` in that order + a mandated family → module-face-lint.test.ts:228 'control family not in face.order') is correct. (b) The spec's ciDelta of '+12 to +16 s' silently contradicts the plan's budgeted Batch E CI delta (plan:1328 '+2.4 s' for karplus+snaredrum+tomtom; plan:942 'CI: +~3 s') by ~5×; the gap is entirely the new e2e case the spec adds, but it is absent from the spec's 'CORRECTIONS TO THE PLAN' list.

- **[MINOR]** "snaredrum writes NOTHING to node.data" is literally false; the conclusion survives but the premise as stated does not.
  - *evidence:* SnaredrumCard.svelte:128 mounts `<ModuleTitle {id} {data} …>`, and ModuleTitle.svelte:20-28 documents that the rename field persists through the `node.data.name` channel, so a snaredrum node does carry `data`. The operative point (no snaredrum-SPECIFIC data key an audition could flip, so no satisfiable `ShellPanelProbe.effect` per shell-cells.ts:128-130) is still correct.


---

## sixstrum

**Verdict: CONTRADICTS_CODE** · archetype: INSTRUMENT (voice + strummer + chord-voicer in one), not a voice. 19 params, 22 in / 1 out, 1 existing control family. STRICT_FACES + STRICT_DOCS member. glyph 'scope'.

**DEFECTS — fix these before building:**

- **[BLOCKER]** risks[0] — the spec's headline "⚠ THE BUILDABILITY BLOCKER — PF-6f AS WRITTEN CANNOT SHIP": it asserts that because `ShellActionCell.onFire: (nodeId: string) => void` receives only a nodeId and `useEngine()` is a Svelte context accessor, "a plain spec function cannot reach" the engine, and therefore demands a ~15 LOC platform widening (`readKey?: string` XOR `onFire`, plus a `fireCellAction` branch in ModuleShell) and a re-sizing of PF-6f from 'S per module' to 'S + platform'. The code already provides exactly this seam.
  - *evidence:* packages/web/src/lib/audio/engine-ref.ts:23 — `export function getActiveEngine(): PatchEngine | null`, whose file header (:3-11) says verbatim it is "A tiny process-wide accessor for the live PatchEngine, for code that runs OUTSIDE the Svelte context tree where provideEngineContext / useEngine apply" and that "callers poll it at the moment of use (a button click, a feedback-pump tick)". It is registered by Canvas.svelte:6991 (`setActiveEngine(e)`) / cleared at :7556, and is ALREADY driven from plain non-component functions on user interactions: PatchPanel.svelte:424 `getActiveEngine()?.setGateInput(nodeId, portId, high)`, clipplayer.ts:794/810/2097/2239, push2-control.svelte.ts:279, ElectraConnectButton.svelte:43. The audition target is reachable from a bare id two ways: PatchEngine.read(node,key) is public at engine.ts:2147 and merely delegates to the domain-level `read(nodeId: string, key: string)` declared at engine.ts:152 / implemented at :762; and a shell-cells-imported actions module already resolves node-from-id — dx7-patch-actions.ts:57 imports `patch` from '$lib/graph/store' and reads `patch.nodes[nodeId]` at :269. So the sixstrum audition ships today as `onFire: (nodeId) => { const t = getActiveEngine()?.read(patch.nodes[nodeId], 'manualTrigger'); if (typeof t === 'function') t(); }` against the UNCHANGED ShellActionCell at shell-cells.ts:62-67. Knock-on: risks[1] clause (b) ("in shell-cells.test.ts assert every `readKey`-bearing action cell names a key the module's factory actually serves, and that an action declares exactly one of onFire/readKey") gates on a field that should not be added, and the ciDelta/effort sizing inherits the same false premise.

- **[MINOR]** controlFamilies[0] cites the wrong evidence for its own correction: "⚠ The plan's REASON for shortening is WRONG — see risks[3]". risks[3] is about `rearHoleLabel` ignoring `port.label` on paramTarget'd CV ports and says nothing about where a ControlFamily label renders. No risk entry supports the claim. (The claim's SUBSTANCE is correct — I verified it independently — but the pointer is dead, so a reviewer following it lands on an unrelated finding.)
  - *evidence:* ModuleShell.svelte:562 `label={view === 'dock-full' ? cell.tag : ctl.label}` + :563 `compact={view !== 'dock-full'}`, and Selector.svelte:184 `{#if label && !compact}<span class="lab">{label}</span>{/if}` — at lane tiers `compact` is true so the family label is suppressed to title/aria (Selector.svelte:176,178). That is the real proof; risks[3] (rear-card-model.ts:138-152) is a different subject.

- **[MINOR]** Six line citations are drifted against the current tree. Each is individually harmless but the spec is sold on file:line precision and these are the refs an implementer will open first.
  - *evidence:* (a) risks[5] "e2e/vrt/workflow-shell-faces.spec.ts:52 { type: 'sixstrum', pages: 6 }" — actual line is :53. (b) controlFamilies[0] "the dock `.cell-cap` (ModuleShell.svelte:558, max-width 220px)" — :558 is `<Selector`; the cell-cap render is :567 and the `max-width: 220px` rule is at :972. (c) risks[0] "ModuleShell's action branch (:572-581)" and rationale "a bare `▸` (ModuleShell.svelte:575)" — the action branch is :578-587 and the `▸` literal is at :581. (d) newParams[0] "KnobConic + persistent option readout at every LANE tier (shell-control-kind.ts:126-130)" — :126-130 is the `paramCellKind` signature; the rule is :133-136 (`if (p.options?.length) { if (tier !== 'dock') return 'knob'; return p.options.length <= SEGMENTED_MAX_OPTIONS ? 'segmented' : 'selector'; }`). (e) risks[0] "`useEngine()` (engine-context.ts:22)" — declared at :21. (f) newParams[1] "rearHoleLabel (rear-card-model.ts:135-150)" — the function spans :138-152.

- **[MINOR]** newParams[0]'s render claim "all three keep the KnobConic + persistent option readout at every LANE tier" is vacuous for this face — none of the three params can ever reach a lane tier under the spec's own ranking, so the sentence describes a code path the face never exercises and could mislead a reviewer into expecting a lane-tier visual change (and into expecting the compact/plate VRT to move).
  - *evidence:* The spec ranks tuning #8, strumDir #9, quality #15. curated-face.ts:46 `LANE_PLATE_MAX_CELLS = PLATE_COLS * PLATE_MAX_ROWS` = 6 (module-shell-model.ts:288-289) and :65 `full: LANE_PLATE_MAX_CELLS`, with curatedFace slicing `ranked.slice(0, cap)` at :227 — so ranks 7+ are dock-only and shell-control-kind.ts:134's `if (tier !== 'dock') return 'knob'` branch is unreachable for all three on this face.

---

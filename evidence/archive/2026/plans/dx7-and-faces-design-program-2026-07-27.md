# DX7 operator views + the 16-module face redesign — PROGRAM PLAN

**Status:** ~~ready to execute~~ **EXECUTED — both arms shipped.** Every adversarial verdict has been folded in; rejected
items are demoted with the reason inline, not appended. Verified against the tree at `aa883ca9`.
**Rule for the executing agent:** this file supersedes the research/spec drafts it was synthesised from.
Where it contradicts an earlier `.myrobots` draft, this file wins.

> **TRIAGE 2026-08-04 — the program RAN. Kept because `.claude/skills/module-faceplates.md:433`
> cites §7 as the working recipe, and because §0's engine verdict is the record of *why* the
> DX7 was rebuilt before a pixel was drawn.**
>
> **DX7 arm — 8/8 complete.** §0's three blocking DSP items all shipped, in the order this
> plan set: **#1187** (the 32-algorithm routing table + per-algorithm feedback — the
> "op6-into-op2 cross-feed" bug named in §0), **#1190** (incremental non-destructive operator
> messages, i.e. the `applyPatch`-resets-everything problem), **#1210** (authentic operator
> envelope + the fixed-frequency law). Then the UI: **#1265** (PR3 pure model layer),
> **#1268** (PR4 algorithm glyph + 32-diagram picker), **#1266** (PR5 voice edit buffer +
> preset STAMP), **#1270** (PR6 operator map + detail panel). Owner decisions on PR0 are in
> **#1189**. The "exactly ONE new param (`feedback`)" call held.
>
> **FACES arm — shipped and then re-done.** Batches A–F landed across **#1169 / #1171 / #1174**
> and the batch D/E wave (**#1276** adsr, **#1289** karplus, …); the platform gaps §4 predicted
> were built out (Segmented cells, `PortDef.label`). **18 faceplates now ship**, and they were
> subsequently re-specced wholesale against the corrected platform — see the `face-redo-*` and
> `face-specs-round-2-*` files, which SUPERSEDE the per-module face specs in §4 of this doc.
> Read §2 (platform) and §7 (recipe) as current; read §4's per-module specs as historical.

---

## 0. THE DX7 ENGINE VERDICT (read this first — it sets the program's shape)

**Operator views are DSP WORK FIRST, then pure UI wiring. They are explicitly NOT ParamDef exposure.**

- **DSP, blocking, before a single pixel — three items.** (1) The 32-algorithm routing table is wrong for
  14 algorithms **and per-algorithm feedback is not expressible**: `algo.feedback` exists
  (`packages/dsp/src/dx7.ts:84`) but is `FEEDBACK_OP_DEFAULT = 5` for all 32 (`:186,194`) *and* the memory
  it injects is hardcoded to op6 — `v.fbMem = (v.fbMem + v.opOut[5]!) * 0.5` (`:574`), mirrored at
  `dx7-render.ts:122`. Filling in `feedback` alone would inject **op6's output into op2** — cross-feed, not
  feedback. (2) The envelope an EG editor would draw **is not the envelope this worklet plays**: it starts
  at 0 (`dsp/src/dx7.ts:393-394`), auto-advances past seg 2 with no gate-held sustain (`:659-666`), and uses
  `tau = 8·exp(-0.09·r)` (`:614-617`), not the DX7's linear-dB law. (3) Live operator editing needs a
  non-destructive incremental message — `applyPatch` resets all 5 voices and zeroes `lastGate` (`:385-399`).
  Add to that: FIXED-frequency mode computes `ratio * C4_HZ` instead of `10^((coarse&3)+fine/100)` Hz
  (`:562`), and `coarse`/`fine` are **not stored at all** — `DX7OpData` keeps only the derived `ratio`.
- **UI, non-blocking, cheap.** With the engine correct, the operator view is wiring over `node.data` plus
  two bespoke panel cells. **Zero operator ParamDefs.**
- **ParamDef exposure: exactly ONE new param (`feedback`), plus two control families.** +3 lines in
  `contract-lock.txt`. The naive "expose 79 operator params" design is rejected: +79 contract lines, +79
  authored docs blurbs, +79 face ranks, ~+60 s CI on one Playwright row, and it is the hardware's
  spreadsheet problem with a mouse.

Cost consequence: **the DX7 feature is gated on two owner-audition audio-change PRs** (routing table,
envelope law). Everything visual sits behind them. Plan accordingly — the 16-module face work below is
fully independent and should run in parallel.

---

## 1. PROGRAM SHAPE

```
PLATFORM (§2)  ──┬──> DX7 (§3)      PR0 → PR0b → PR1 → PR2 → PR3 → PR4 → PR5 → PR6
                 │                   (two owner-preview audio PRs up front)
                 └──> FACES (§4)     Batch A → B → C → D → E → F   (16 modules, 5 merge batches)
```

Platform first, because eleven of the sixteen module specs and four of the eight DX7 PRs depend on a
platform seam. Faces and DX7 do not block each other after Batch A.

### The correction that reshaped the whole plan: **the 720p dock fold is NOT as tight as the batch specs assumed**

Three of the four spec batches justified page merges with a computed "~134 px band budget ⇒ one band at
720p". I checked the committed baselines:

- `e2e/vrt/__screenshots__/workflow-shell-faces.spec.ts/darwin/face-filter-dock.png` (1220×425) — **both**
  bands render fully; content ends ~15 px above the frame. What is clipped is the jack rail.
- `.../face-mixer-dock.png` (1220×421) — both bands **plus** the jack rail, ~26 px spare.

Two arithmetic errors caused it: a 68 px dock hero was assumed for every face (that is the `ScopeScreen`
height; a `glyph: 'meter'` face renders a **VuMeter at thickness 16** — `ModuleShell.svelte:489-496`), and
a 626 px split pane was modelled when the VRT dock scene is a single 1220 px pane.

**Consequences, applied everywhere below:**
1. **Band merges must be justified by grouping semantics, not budget.** Any merge that produces a
   6+ control band whose members are three different ideas is rejected.
2. **"Band 1 must hold the hero ranks" is dropped as a requirement.** `order` is a *priority ranking for
   tiers that show a subset*; `pages` is *signal/function order for a tier that shows everything*. They
   answer different questions. State this in every face comment. (This resolves the snaredrum and sixstrum
   rank↔page objections without re-cutting either face around a phantom fold.)
3. **PF-8 (gate the duplicate lane rail out of the dock) still ships** — it is 3 lines and buys 23 px —
   but it is no longer load-bearing for any page decision.

---

## 2. PLATFORM — fix once, early

Each item lists the module specs that depend on it. Do not start a dependent module PR before its
platform item is merged.

### Batch A — the platform wave (ships before any face edit)

| id | item | effort | contract | depended on by |
|---|---|---|---|---|
| **PF-0** | **tidyVco `hold` momentary fix** (see §5, it is a live bug, not a platform item — but it ships here because it comes with the cross-check assertion) | S ~35 LOC | none | tidyVco |
| **PF-7** | **FULL-tier cap reconciliation.** `faceTierCap('full')` returns **6**; widen `module-face-lint.test.ts:349-365` past `'compact'`. ⚠ moves the synthetic pin at `curated-face.test.ts:68`. | S ~10 LOC + 1 pin | none | every face's ranking is written to a 6, not an 8 |
| **PF-8** | **Dock lane-rail gate.** `ModuleShell.svelte:619-627` renders `PatchPanel variant='lane-rail'` unconditionally; gate on `view === 'lane'`. The dock's patch surface is the RearCard (`DockFullView.svelte:169-175`). ⚠ verify `workflow-rear-card.spec.ts` / `workflow-dock*.spec.ts` first; all dock VRT baselines move. | TINY ~3 LOC | none | all (cosmetic) |
| **PF-2** | **param → Toggle.** `ParamCellKind` gains `'toggle'`, returned when `looksLikeToggle(p) && !momentary.has(p.id)`. ⚠ **signature change**: `paramCellKind(paramId: string, momentary)` today (`shell-control-kind.ts:52`) must become `paramCellKind(p: ParamDef, momentary)` — call-site edits in `ModuleShell.svelte` + model tests. `Toggle.svelte` already emits `role="switch"` + `control-<paramId>`, so faces-parity's existing `'toggle'` drive branch works unchanged. **DO NOT remove `kickdrum:hard`/`snaredrum:hard` from `ACKNOWLEDGED_LATCHING`** — they *are* latching and the gate at `module-face-lint.test.ts:321-341` requires the classification independently of the render kind. **DO NOT apply to `tidyVco:hold`** — it is momentary (PF-0). | S ~30 LOC | none | kickdrum, snaredrum, cloudseed |
| **PF-4** | **`PortDef.label?: string`.** Thread through `ModuleShell.svelte:314`'s `portsFromDef` call (it passes **no** labels map today, so every migrated module falls back to id derivation). Both consumers already declare and honour it (`patch-panel-labels.ts:18-24,157-160`; `rear-card-model.ts:42,152`). `portLine` (`contract-signature.ts:76-88`) has no label branch. ⚠ a VIDEO def's port labels land in the WebGL attest basis — wrap in `docs-hash-ignore`. None here. | TINY ~6 LOC | none | mixer, lfo, adsr, vca, sixstrum |
| **PF-5** | **Jack-label suffix doubling + underscores.** `expandStem` (`patch-panel-labels.ts:145-151`) neither strips a trailing `_in`/`_out` nor converts `_`→space, so the rear reads `TRIGGER IN` next to a `←` glyph and the **lane drill-down** (which calls `resolveVerboseLabel` raw, `PatchPanel.svelte:1003-1036`) reads `TRIGGER_IN`. One rule in the shared helper fixes both. ⚠ `patch-panel-labels.test.ts` is an exact-string golden; `rear-card-model.test.ts` + the rear VRT baselines may pin text. **Collision policy:** after stripping, sample-hold's `cv_in`/`cv_out` both become `CV` — disambiguate by rail position + glyph, and say so in the helper's comment. | TINY + test churn | none | all rears (quality, not a control loss) |
| **PF-9** | **`ModuleFacePage.clusters?: {label, controls}[]`** — mirrors `ModuleFaceRear.clusters`; a ~14 px sub-header instead of an ~81 px extra band. `graph/types.ts`, `curated-face.ts` (`dockFacePlan` pass-through), ModuleShell's band loop, `module-face-lint`. | S ~25 LOC | none | tidyVco, kickdrum, snaredrum, cloudseed |

### Batch A2 — the vocabulary wave (ships immediately after A)

| id | item | effort | contract | depended on by |
|---|---|---|---|---|
| **PF-1** | **`ParamDef.options?: readonly {value:number; label:string; title?:string}[]`.** Render: dock + ≤6 options → `<Segmented>`; dock + ≥7 → `<Selector>`; **every lane tier** → `KnobConic` with a **persistent** option-name readout. **CONTRACT DECISION, record it in the PR body: do NOT extend the param line in `contract-signature.ts:105-108`.** Option labels are cosmetic in exactly the sense `ParamDef.label` already is (`delay.ts:86-91` states that precedent verbatim); the value→meaning mapping is DSP and is already pinned by `min/max/curve`. So `options` is contract-transparent. ⚠ `Segmented` has **zero call sites** today outside the barrel — it emits `data-testid="control-<paramId>"` on its `role="radiogroup"` (`Segmented.svelte:97`) and is MIDI-assignable, so faces-parity's multiset holds. ⚠ `activeSegmentIndex` is an **exact** match returning `-1` (`segmented-model.ts:20-28`) — any param whose saved values may be off-detent needs `nearestSegmentValue` on read (cloudseed `late_mode`, see §4.C). ⚠ new `driveCell` branch required: faces-parity **throws** on an unrecognised `data-cell-control` (`faces-parity.spec.ts:115,342`). | M ~90 LOC + e2e branch | none | filter, sixstrum, cloudseed, tidyVco |
| **PF-3** | **`ParamDef.format?: (v:number)=>string`** + KnobConic persistent readout. ⚠ **gate the persistent readout on `options`/`format` being present** or ~17 dock baselines move for nothing. | S ~25 LOC | none | cloudseed (×46), reverb, delay |
| **PF-10** | **`ParamDef.landmarks?: {value:number; label:string}[]`** — tick marks + a *nearest-landmark* readout on `KnobConic`, for a **continuous morph** where a Segmented would lie by hiding the in-between blends. **Distinct from PF-1; never conflate them.** | S/M ~60 LOC | none | qbrt `mode`, lfo `shape` |
| **PF-11** | **Wrap `face:` in `docs-hash-ignore` on ART pattern-3 defs.** `art/scenarios/delay/profile.test.ts:110` pins `docsStrippedRepoSourceSha('.../modules/delay.ts')` and `stripDocsForPin` (`art/setup/capture.ts:97-101`) strips only marked regions — `delay.ts` marks `docs:` but **not** `face:`, so a pure face edit moves the `.sha`. Same shape in `art/scenarios/{scaler,polarizer,illogic,depolarizer}/profile.test.ts`. One-time `.sha` re-pin per module; then face edits are free forever. This is the owner's "docs must not change attest hashes" directive extended to the UI-metadata sibling. | TINY + 5 re-pins | 5 `.sha` | delay (and the next fan-out) |

### Batch A3 — the seams (ships alongside the face batches that need them)

| id | item | effort | contract | depended on by |
|---|---|---|---|---|
| **PF-6** | **`face.actions?: {key, label, title?, page?, mode:'trigger'\|'gate', readKey?:string, paramId?:string}[]`** — the audition seam. A `readKey` entry calls `engine.read(node, key)`; a `paramId` entry drives a momentary press-param. **A listed action SATISFIES `module-face-lint`'s deny-missing-curation for that param id.** ⚠ **this breaks FOUR gates, not one** — (a) `face.order` completeness, (b) the dock render-plan parity assert (every `ParamDef.id` exactly once in `dockFacePlan`), (c) `module-face-lint.test.ts:314` *"face.momentary '<id>' is not ranked in face.order"*, (d) the switch-classification ratchet. Plus faces-parity asserts `cells.length === params + families` and `[data-cell-kind="static"]` count 0, so a new `data-cell-kind` value is needed. **Size it M, not S.** | M ~120 LOC across 6 files | none | karplus, sixstrum, kickdrum, snaredrum, qbrt, tomtom |
| **PF-6f** | **The no-platform-change FALLBACK, which ships TODAY.** A one-member `controlFamily {id:'<mod>-strike', kind:'other', testidPrefix:'<mod>-strike'}` + a `shell-cells` `action` spec. `module-docs-lint.test.ts:231-248` greps the prefix against card source: `KarplusCard.svelte:127` and `SixstrumCard.svelte:192` already emit theirs. Cost: **+1 contract-lock family line + 1 `docs.controls` entry per module**. **Use this for Batches B and E; migrate onto PF-6 when it lands.** | S per module | +1 line each | karplus, sixstrum, qbrt, kickdrum, snaredrum |
| **PF-12** | **CV-depth attenuator seam.** Input descriptor gains `attenuate?: GainNode`; the engine inserts it between the cvScale chain and `din.param`. ⚠ **the per-param analyser tap must move with it** — `engine.ts:442-450` taps `connectSource`, the same node fed to `din.param`; leaving the tap upstream makes the motorized modulation readout show the **pre-attenuation** CV, and a "byte-identical at gain 1.0" test cannot catch it. **Test at gain 0.5.** The load-bearing fact that makes this a *depth trim* rather than a value scaler: `attachCvScale`'s WaveShaper emits a **delta**, not an absolute (`cv-scale.ts:132-137,204-206`) — say so in the seam's comment. | S ~12 LOC | none | delay `time_cv_amt` |
| **PF-13** | **Param WRITE override registry.** `SHELL_PARAM_WRITES[type][paramId] = (nodeId, v) => …`; ModuleShell's param branch uses `override ?? params.set(pd.id)`. For macro params that mutate siblings. ⚠ **MIDI storm guard required** — a learned CC sweeping `preset_index` would fire up to 4 full 46-param `mutateNode` transactions; dedupe repeats and commit on settle (`midi-cc-write-storm-fix`). | S ~12 LOC + guard | none | cloudseed |
| **PF-14** | **`ShellPanelCell`** — a bespoke panel with a **declared** operability probe, so faces-parity stays registry-driven off `STRICT_FACES` instead of special-casing a module. ⚠ publish probes from the **shell layer** (`window.__shellPanelProbes`), NOT from `__moduleSpecs` — `packages/web/src/lib/dev/module-specs.ts` projects the module registry and importing `shell-cells.ts` there creates a live circular import through `dx7-patch-actions.ts` → `$lib/audio/modules/dx7`. ⚠ add a face-lint rule: **a `panel` cell may only be SELECTED at tier `dock`** (do not rely on `PLATE_COLS*PLATE_MAX_ROWS = 6` truncating it — bump that constant and a 280 px SVG lands in a 46 px `--kcol-max` column). ⚠ **hard rule for panel internals: a panel must NEVER emit `data-testid="control-<paramId>"`** — faces-parity asserts exact multiset equality against the def param set. | M ~140 LOC | none | dx7 |
| **PF-15** | **`'grid'` param cell kind + `'algorithm'` glyph literal.** dx7-scoped. `'grid'` renders a chip + a **portaled, viewport-clamped popover** (reusing `Selector.svelte:190-200`'s portal machinery) at **every** tier, so a 32-cell diagram grid never has to fit a lane column. `'algorithm'` goes into `ModuleFace['glyph']` + `VALID_GLYPHS` (`module-face-lint.test.ts:82`) + a `glyphBinding` branch **before** the `if (audioOut) return {kind:'live-audio'}` short-circuit + a ModuleShell branch. **State in the code comment that this is not yet a general precedent** — when a second topology-bearing module arrives, widen the binding to carry a layout-source id rather than adding a second literal. | M ~120 LOC | none | dx7 |
| **PF-16** | **Dock TABS.** `ModuleFacePage.label` is already documented as *"Human tab label"* (`graph/types.ts:395-396`) and `DockFullView.svelte:180-184` hardcodes one `MODULE` tab with the comment *"real per-op tabs are P1"*. **Implementation decision that halves the gate cost: hide inactive pages with CSS (`hidden` / `display:none`), do NOT `{#if}`-unmount them.** faces-parity §1 (`[data-testid^="control-"]`, `:361-371`) and the cell-count assert (`renderedCells`, `:175-183`) both use `evaluateAll` and **match hidden elements**, so they pass unchanged; only the per-cell `toBeVisible()` + `scrollIntoViewIfNeeded` drive loop (`:244`) needs a tab-walk. **Scroll ownership:** `.faceplate-scroll` and `.editor` are both `overflow:auto` — pick `.editor`, pin the tab rail + title bar. | M ~120 + ~40 LOC | none | cloudseed |
| **PF-17** | **`<OssAttribution>` in the ModuleShell dock footer** when `def.ossAttribution` exists. | TINY ~5 LOC | none | cloudseed (licence-adjacent) |

### DEMOTED — explicitly, with the reason

| item | why demoted | revisit when |
|---|---|---|
| **`tail` glyph kind** (scrolling RMS history, proposed for delay/reverb/cloudseed/shimmershine) | Three independent defects. (a) It swaps a 16 px VuMeter dock hero for a 64 px ScopeScreen-family hero — **+48 px, twice what PF-8 recovers** — on exactly the faces the spec called fold-constrained. (b) The renderer is unspecified: all three `ScopeScreen` modes map a buffer to a **centred ±1** trace (`ScopeScreen.svelte:31`); an RMS history is positive-only 0..1 and would draw in the top half. (c) `getLevel()` is RMS over `GLYPH_TAP_FFT_SIZE = 2048` ≈ 43 ms (`shell-glyph-live.ts:185,303-310`), so echoes closer than ~50 ms merge — which is precisely the flanger/chorus range `delay.time_cv_amt` exists to enable. | Own PR, with a positive-only renderer, a measured hero-height budget, and the time-base claim bounded to >50 ms |
| **`response` glyph kind** (filter magnitude curve) | The reuse justification fails on 5 of the 6 modules it names: qbrt's `mode` is a continuous 0..1 morph, moog904a/b/c are 24 dB/oct ladders, moog907a/914 are fixed banks. Each needs its own law — which is the special-casing the new-kind argument existed to avoid. Renderer also unspecified (same positive-only problem). | After a second genuine 2-pole `fi.reson` consumer exists |
| **`levels` glyph (mixer), `strings` glyph (sixstrum), `transient` glyph (drums), adsr playhead** | Same class. `strings` additionally needs a worklet→main `postMessage` + a `read()` seam; the adsr playhead needs a second port resolver because `primaryAudioOutPortId` filters `o.type === 'audio'` (`shell-glyph-live.ts:75-77`). | A dedicated glyph wave, after `tail`'s renderer settles the pattern |
| **reverb `room` (Faust `spread`)** | **REJECTED outright**, three ways. The stdlib signature is `mono_freeverb(fb1,fb2,damp,spread)` where spread is *"spatial spread in number of **samples**"*: a 0..1 knob on comb tunings of 1214..1760 samples is ~20 µs — inaudible; `lbcf`'s delay is `: int` so a float slider inside a `~` recursion truncates or refuses to compile; and it is the **stereo decorrelation** parameter (`stereo_freeverb` passes 0 left / spread right), so on our mono tank (`reverb.dsp:18` passes the literal `0.5`) it is a uniform constant offset, not modal re-tuning. | never, as specified |
| **Six new DSP params** — lfo `offset`, adsr `manualGate`, vca `response`, shimmershine `interval` + `damp_cv`, filter `mode` morph | Each is real DSP + a contract line + an ART re-pin. Never fold a DSP change into a face wave. | One PR each, after the face program |

---

## 3–4 · DELETED 2026-08-12

**§3 (the corrected full DX7 spec, ~515 lines) and §4 (the 16 per-module face
specs, ~525 lines) were deleted in the janitorial sweep.** §3 shipped in full —
#1187 / #1190 / #1210 (engine) and #1265 / #1266 / #1268 / #1270 (UI) — so the
def and the DSP are the record. §4 was superseded wholesale by the `face-redo-*`
and `face-specs-round-2-*` files, which re-specced the same modules against the
merged platform and found round-1's citations off by 1–2 lines. Nothing in
either section was live backlog.

## 5. CONTROL-LOSS LEDGER

The owner's hard rule: **we never lose controls when we redesign full views.** Every affordance that is
currently unreachable (or wrongly rendered) from a face, with its remedy and the PR that closes it.

| module | affordance | today | status | remedy | closes in |
|---|---|---|---|---|---|
| **tidyVco** | `hold` momentary drone pad | `TidyVcoCard.svelte:236-244` press-pad | **SEVERE — renders as a LATCHING rotary; dragging to 1 latches the voice open forever and persists a stuck 1 into the Y.Doc for every rack-mate** | `face.momentary:['hold']` + delete the wrong `ACKNOWLEDGED_LATCHING` entry + the docs cross-check assertion | **PF-0, Batch A (first thing that ships)** |
| **karplus** | PLUCK audition | `KarplusCard.svelte:123-129` → `karplus.ts:288-295` | **SEVERE — structurally unrankable; an unpatched KARPLUS is mute under `?shell=1`, on the one voice that cannot sound without an external strike; neither gate can see it** | PF-6f family `karplus-strike` + `action` cell (→ PF-6 later) | Batch E |
| **sixstrum** | STRUM audition (barres all six) | `SixstrumCard.svelte:188-194` → `sixstrum.ts:378-385` | **SEVERE — same class** | PF-6f family `sixstrum-strum`; ⚠ no ConstantSource keep-alives (breaks normalling detection) | Batch F |
| **cloudseed** | preset bank (slots, ‹ ›, name, RT60) | `CloudseedCard.svelte:252-269` | **SEVERE — and a state-consistency BUG: the dock knob changes the SOUND while the persisted Y.Doc keeps the old 45 values** | extract `cloudseed-preset-actions.ts`; **delete `cloudseed.ts:699-722`**; PF-13 write override + MIDI storm guard; PF-1 named options | Batch C |
| **cloudseed** | 9 ON/OFF pills + `late_mode` | `CloudseedCard.svelte:164…239` | **SEVERE — continuous rotaries; `linear` curve means even the unclassified-switch gate is blind** | curve `linear`→`discrete` (10 lines) + PF-2 Toggle; `late_mode` via PF-1 + nearest-segment read | Batch C |
| **cloudseed** | 46 formatted readouts (RT60 sec, stage counts, Hz) | `formatParameter()` on the card | MODERATE — shell prints raw `0.63` | PF-3, ~10 lines reusing the existing formatter + `cppId` table | Batch C |
| **cloudseed** | OSS attribution ("Ghost Note Audio") | `CloudseedCard.svelte:272` | MINOR, licence-adjacent | PF-17 dock footer | Batch C |
| **cloudseed** | clear tail | **never existed** — the worklet handles `clearBuffers` and the host has never sent it | NEW capability | family + `action` cell + `handle.write('clearTail')` + a card button | Batch C |
| **filter** | LP / HP / BP as NAMES | `FilterCard.svelte:39-43` three labelled buttons | MODERATE — numeric rotary, hover-only readout | PF-1 `options` (Segmented in dock, persistent readout in lane) | Batch D |
| **sixstrum** | `strumDir` / `quality` / `tuning` names | `SixstrumCard.svelte:50-54` name tables | MODERATE — bare numbers (`5` for `sus4`) | PF-1 `options` | Batch F |
| **tidyVco** | `oct2` −1/0/+1 | Fader, equally uninformative | MODERATE — inherited, not caused | PF-1 `options` | Batch F |
| **kickdrum** | `hard` ON/OFF | `KickdrumCard.svelte:182-188` pill | MODERATE — rotary reading `0.00` | PF-2 Toggle (keep the latching classification) | Batch F |
| **snaredrum** | `hard` ON/OFF | `SnaredrumCard.svelte:187-193` pill | MODERATE | PF-2 Toggle | Batch E |
| **kickdrum** | audition | **none on either surface** | MODERATE — an unpatched kick is silent in the dock while tomtom/karplus/sixstrum can all be auditioned | PF-6f + host `ConstantSource`; ⚠ **never a `strike` param** (moves the ART `.sha`) | Batch F |
| **snaredrum** | audition ×2 (hit + **roll**) | none | MODERATE — the roll is the module's whole reason to exist | PF-6f with `mode:'trigger'` **and** `mode:'gate'` | Batch E |
| **qbrt** | ping audition | none; no `manualTrigger` seam exists | MODERATE — the headline capability is untriggerable from the dock | PF-6f + ~8 lines (`ConstantSource` → `merger` input 2) | Batch B |
| **adsr** | fire the envelope | none | MODERATE | deferred: `manualGate` param + `face.momentary` (separate DSP PR, ART re-pin ×2) | post-program |
| **qbrt** | `mode` LP/BP/HP landmarks | never on the card either | MINOR | PF-10 landmarks (**not** PF-1 — a Segmented would hide the morph) | Batch B |
| **lfo** | `SHAPE_GLYPHS` morph marks | `LfoCard.svelte:20-24` | **ACCEPTED LOSS** — the wave-morph glyph shows the resolved shape continuously and reactively, which is strictly more information. Argument goes in the face comment. | (optionally PF-10) | Batch B |
| **dx7** | ALG display readout | `Dx7Card.svelte:103-105` | MINOR | the `'grid'` chip reads `ALG 05` | dx7 PR 4 |
| **dx7** | the 6-operator matrix | **never existed in any UI** | NEW capability | panel cells | dx7 PR 6 |
| **mixer · delay · reverb · vca · adsr · shimmershine · tomtom** | — | — | **NONE — verified line by line** (Fader/PatchPanel only; tomtom's STRIKE is fully covered by `face.momentary`) | — | — |

**Label-quality (not control loss), fixed once by PF-4 + PF-5:** `TRIGGER IN` doubling the `←` glyph and
`TRIGGER_IN` in the lane drill-down; `PHASE0`; `IN1`; `env`/`env_inv` and `audio`/`audio_inv` reading as
unrelated ports; twelve `STRUM1…MUTE6` where `1…6` twice would do.

---

## 6 · DELETED 2026-08-12

**The merge order / risk register (~155 lines) is spent** — every batch it
sequenced has merged. §8 below keeps the residue that still needs a decision.

## 7. THE RECIPE — the authoring standard for the NEXT fan-out

The owner's directive: *"when we fan out again on other modules we will do the same degree of specific
authoring."* This is what "the same degree" means. A module spec is not done until every step below has an
answer **with a file:line behind it**.

**Step 1 — read four things, in this order, before writing a word.**
`packages/web/src/lib/audio/modules/<mod>.ts` (def, face, docs) · `packages/web/src/lib/ui/modules/<Mod>Card.svelte`
(the legacy card, **line by line** — this is the control-loss ground truth) · the DSP
(`packages/dsp/src/<mod>.ts` or `.dsp` or `lib/<mod>-dsp.ts`) · `art/scenarios/<mod>/*` (what is pinned and
by what hash function).

**Step 2 — "what is it FOR", in one paragraph, musically.** Not a feature list. Name the ONE thing it does
that its siblings do not, and name the verb a player performs on it. Every ranking argument below must
descend from this paragraph.

**Step 3 — rank against the DSP, not against the declaration order.** The bar: *a rank is only defended if
the argument would be wrong for a different module.* Concretely — check every hero candidate for
**inertness at spawn** (tidyVco's `pw` is gated off at the shape default; shimmershine's `decay` is a
multiplier on a `size` that can be 0; karplus's `position` is a per-step CV target, not a knob you ride),
and check every demotion candidate for **unconditional applicability** (adsr's `release` is the only stage
that always runs). **Ranks 1–6 are the entire lane budget; rank 7+ is dock-only.** Print the tier ladder
(mini / compact / plate / dock) and read it back as a sentence.

**Step 4 — page by FUNCTION, and let `order` and `pages` disagree.** `order` = priority for tiers showing a
subset; `pages` = signal/function order for the tier showing everything. Say so in the face comment or the
next author will "fix" one to match the other. A page earns a header only if it groups **≥2** controls or
the lone control is the module's identity. **Never merge two distinct engines into one band to save
vertical space** — measure the actual dock baseline PNG before believing any fold arithmetic.

**Step 5 — the rear card is a PROJECTION of `face.pages`.** Any page id/label/membership edit silently
re-groups it. For every page change, re-derive the rear on paper: which CV holes land in which band, are
there orphans (a `_cv` stem that is not a param id — the `bend_cv`/`bend_amt` and `pwm_cv`/`pw` class), does
a curated group id still match a page id. Then check `rear-card-model.test.ts` for a pin.

**Step 6 — `audioRate` is a CLAIM, and you must cite the source.** Tick a `~` only after reading the worklet:
per-sample read = true; `WtParamSmoother` at 80 Hz, `si.smoo`, or a once-per-block sample-and-hold = false.
Write the citation into the face comment. (tidyVco's audit correctly *dropped* `res_cv`/`drive_cv` after
re-reading the DSP; qbrt correctly ticks nothing.)

**Step 7 — the control-loss pass, adversarially.** Grep the legacy card for
`<button|<select|<input|oncontextmenu|manualTrigger|Toggle|Selector|format`. Every hit maps to a face key, a
shell cell, a `face.momentary` entry, or a **written exemption with an argument**. Remember the two gates are
blind here: `module-face-lint`'s completeness enumerates params + declared families + numbered-legend
statics, and only **three** legend files exist in the whole repo (adsr, lfo, sequencer) — so for 14 of 17
promoted modules a card-only button is invisible to CI.

**Step 8 — new controls from first principles, then reject most of them.** Diff the def's params against the
DSP's `PARAM_TABLE` / `parameterDescriptors` / `hslider`s. If they are 1:1, **say "zero un-exposed DSP
capability" — that is a finding, not a shortfall.** If a constant is hiding a real dimension (reverb's
`fb2`, shimmershine's shifter `rate`), propose it as a **separate PR** with its contract line, docs entry,
face rank, faces-parity cell and ART re-pin all itemized. **Never fold a DSP change into a face wave.**

**Step 9 — price it against the real gates, not the imagined ones.** Contract-lock lines · ART pin *and its
hash function* (a `docsStrippedRepoSourceSha` on the def file means a **face** edit moves the `.sha` unless
`face:` is inside `docs-hash-ignore`) · attest bases · VRT baselines **per platform** with the drain list ·
the structural page count · faces-parity cell delta × ~0.8 s · which unit pins move.

**Step 10 — write the taste calls down as taste calls, with the alternative and the one-line revert.** Every
spec above has a "if you disagree, swap these two entries and nothing else moves" for its judgement calls.
That is what makes a spec reviewable instead of arguable.

**Step 11 — flake-check.** `REPEAT=3` on every new or seriously changed test before the MR. A flake is
root-caused, never re-run.

**Anti-patterns this program had to correct, in order of how often they recurred:**
(1) justifying a design decision with computed pixel arithmetic instead of the committed baseline PNG;
(2) listing "faces-parity: cell count unchanged" as the verification and missing the named regression specs,
the page-label text assert, and the six `rear-card-model` pins;
(3) proposing a ranking identical to the existing one and presenting it as a redesign;
(4) "the same platform pattern as module X" without checking module Y's stated invariant (sixstrum's
zero-length-channel normalling detection vs karplus's ConstantSource);
(5) assuming an ART `.sha` exists because other modules have one;
(6) prose that contradicts the code block directly beneath it.

---

## 8. OPEN — needs an owner decision

> **2026-08-12: items 1 and 3 are MOOT** — both dx7 audio PRs shipped (#1187
> routing table, #1210 envelope + fixed-frequency law), so there is nothing left
> to combine or accept. Items 4–9 are face-ranking questions and the faceplate
> pipeline is PAUSED by owner directive; they are banked, not blocked.

2. ~~**dx7 PR 0 changes the sound of saved racks** on 14 algorithms plus two built-in voices. Accept, or ship
   a per-node "legacy routing" opt-out?~~ — **RESOLVED 2026-07-27: ACCEPTED.** No legacy-routing opt-out.
   The owner also ruled **keep HARMONICA as re-routed — do NOT re-voice it.** Rationale for keeping: the
   table was simply wrong, and re-voicing would conflate "we fixed a bug" with "we retuned a preset",
   destroying the bisectability of any future spectral regression. The moving voices are HARMONICA (alg 19,
   audible) and TUB BELLS (alg 8, marginal) — MARIMBA is bit-identical.
4. **adsr `release` over `attack` at rank 1** — well-argued from `TRIGGER_PULSE_S == attack default`, but it
   changes the mini tile. One-line revert.
5. **tidyVco `cutoff` to rank 1** (mini tile changes from SHAPE to CUTOFF).
6. **reverb `size` label → `Decay`** — free, but it renames a control users have seen for a year.
7. **sixstrum preset at rank 3, not 1** — I moved it off the mini tile because at mini it is a one-click
   destructive 14-param stamp. Confirm.
8. **Is the glyph wave (`tail` / `response` / `levels` / `strings` / `transient`) worth its own program?**
   All five are demoted here for concrete reasons; four modules' glyphs stay generic until then.
9. **PF-6 (`face.actions`) now vs the per-module family fallback?** The fallback ships today at +1 contract
   line per module (5 total) and is migratable; PF-6 is a proper M platform PR touching four gates.

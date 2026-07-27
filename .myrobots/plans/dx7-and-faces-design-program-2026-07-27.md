# DX7 operator views + the 16-module face redesign — PROGRAM PLAN

**Status:** corrected design, ready to execute. Every adversarial verdict has been folded in; rejected
items are demoted with the reason inline, not appended. Verified against the tree at `aa883ca9`.
**Rule for the executing agent:** this file supersedes the research/spec drafts it was synthesised from.
Where it contradicts an earlier `.myrobots` draft, this file wins.

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

## 3. DX7 — the corrected full spec, phased

### 3.1 Architecture

**Zero operator ParamDefs.** The 78 operator values live in `node.data.voice` (a plain-JS `DX7Voice`),
which already rides the Y.Doc, the `.imp.json` envelope and Hocuspocus snapshots.

**Exactly ONE new ParamDef** — `feedback` (0..7 discrete, default 4 = E.PIANO 1's stored value,
`dx7-banks.ts:76`, so a fresh spawn is bit-identical). It is a real param because it is the one continuous
timbral control a player *rides*, so it must carry MIDI-learn, automation and motorized readback.
`looksLikeSwitch` needs `0..1 discrete default 0` — `feedback` is exempt, no `ACKNOWLEDGED_LATCHING`
entry needed.

**Authority split — memorize this, it is the whole state design.**
- `node.params.algorithm` and `node.params.feedback` are **authoritative**.
- `node.data.voice` is authoritative for the other 78 values. Its own `algorithm`/`feedback` fields are a
  *stamp source*, never read at send time.
- Trade accepted and stated: operator values get **no MIDI-learn, no CV, no automation lane, no per-value
  undo granularity**. Operator editing is patch *design*, not performance.

`node.data` after PR 5:
```ts
node.data = {
  preset:      string,      // EXISTING — the ORIGIN voice name (a display label only)
  userPatches: DX7Voice[],  // EXISTING — imported cartridges, unchanged
  voice:       DX7Voice,    // NEW — the working EDIT BUFFER (plain JS, deep-unwrapped)
  opOn:        boolean[6],  // NEW — edit-buffer only (authentic: SYX param 155 is not in the stored voice)
  voiceRev:    number,      // NEW — monotonic; the factory polls THIS
};
```

### 3.2 `face.order` and `face.pages` — pasteable

```ts
face: {
  // RACKLINE face (UI curation only — NOT the I/O contract). The DX7 is a
  // PATCH-DRIVEN instrument whose identity is its VOICE and the ALGORITHM that
  // wires it; the six operators are patch DESIGN, so they live in the dock and
  // nowhere else. `order` is a PRIORITY ranking for tiers that show a subset;
  // `pages` is FUNCTION order for the tier that shows everything. Different
  // questions, different answers — do not "fix" one to match the other.
  //   mini    (1) the PRESET selector, beside a live algorithm map that shows
  //               what that sound IS.
  //   compact (2 + glyph) + FEEDBACK — the one continuous timbral control an FM
  //               player rides. (Rejected: ALGORITHM here. It would spend both
  //               compact cells on discrete selectors on a synth, and the glyph
  //               already shows the topology.)
  //   plate   (6 — laneBodyPlan's no-clip cap; ranks 7+ are DOCK-ONLY) adds
  //               algorithm, level, transpose, RELEASE. Release stays in the
  //               plate: it is the "why don't my bells ring" trap. voiceCount
  //               is the one that drops out.
  order: [
    'dx7-preset-select-{n}',  // 1
    'feedback',               // 2
    'algorithm',              // 3
    'level',                  // 4
    'transpose',              // 5
    'release',                // 6   ← the lane budget ends HERE
    'voiceCount',             // 7
    'attack', 'decay', 'sustain',        // 8-10
    'dx7-operator-map-{n}',   // 11  panel — dock-only by face-lint rule (PF-14)
    'dx7-op-detail-{n}',      // 12  panel — dock-only
    'dx7-syx-input-{n}',      // 13
  ],
  pages: [
    // The cartridge loader sits WITH the selector — same job (get a voice in) —
    // which kills the old one-control 'cartridge' band.
    { id: 'voice',       label: 'voice',       controls: ['dx7-preset-select-{n}', 'dx7-syx-input-{n}'] },
    // ONE band for the whole wiring+operator editor. .page-controls is flex-wrap
    // at 10px column gap; at the 900px .faceplate-body floor the usable width is
    // ~856px, so this lays out as: row 1 = [ALG chip ~90] [FEEDBACK ~56] [MAP 280]
    // = ~446px, row 2 = [DETAIL 560]. Map and detail land on ADJACENT ROWS —
    // both visible together, no tab switch. (Do NOT promise side-by-side: 90+56+
    // 280+560 = 986 > 856.)
    { id: 'operators',   label: 'algorithm · operators',
      controls: ['algorithm', 'feedback', 'dx7-operator-map-{n}', 'dx7-op-detail-{n}'] },
    { id: 'performance', label: 'performance', controls: ['voiceCount', 'transpose', 'level'] },
    { id: 'ampenv',      label: 'master adsr', controls: ['attack', 'decay', 'sustain', 'release'] },
  ],
  glyph: 'algorithm',
  paramCells: { algorithm: 'grid' },   // PF-15; UI metadata, contract-transparent
  rear: {  // UNCHANGED — no new ports
    groups:   [{ id: 'voice', label: 'note source', ports: ['poly', 'pitch_cv', 'gate'] }],
    clusters: [{ group: 'voice', label: 'mono (legacy)', ports: ['pitch_cv', 'gate'] }],
  },
},
```

**Cell arithmetic (the faces-parity invariant):** 9 params + 4 families = **13 cells**, 13 unique
`data-cell-key`s, exactly 9 `control-*` testids. Every `order` key is claimed by a page → no `__unpaged`
band. **Pages = 4, so `workflow-shell-faces.spec.ts:52` `{ type: 'dx7', pages: 4 }` is UNCHANGED.**

### 3.3 The operator view

**The algorithm diagram IS the operator view.** One live map + one detail panel. Not six Dexed strips
(unusable below ~1400 px, 6× the parity cost), not six `OP n` dock pages (that re-creates the hardware's
OPERATOR SELECT — the exact affordance we are killing).

**`dx7-operator-map` (280 px, `minWidth: 280`).** One SVG, computed `viewBox`,
`preserveAspectRatio="xMidYMid meet"` so a 4-deep serial algorithm shrinks and a flat additive one grows,
and nothing clips. Geometry from the pure `dx7AlgorithmLayout(num)` — never hand-drawn. Each operator
block carries five marks:
1. operator number, top-left;
2. **role colour** — carrier warm / modulator cool / **both** purple (the opsix rule). ⚠ this is the
   deuteranopia trap: **lead with the carrier rail** (a horizontal line under the bottom row that every
   carrier drops onto, making the output sum literal) as the primary carrier cue; colour is reinforcement;
3. **ON/OFF dot** — off dims the tile to 30 %. Click toggles `node.data.opOn[i]`;
4. **resolved frequency** — `×3.06`. **`FIX <n> Hz` is PHASE 2** and the `RATIO|FIXED` toggle is not
   rendered until PR 0b fixes the law (see §3.5);
5. **EG thumbnail + level bar** (20×12), drawn by the *same* `dx7EgCurve()` as the big editor,
   **scaled vertically by the op's output level** and role-tinted.

Plus the feedback loop drawn on the **correct** operator per the corrected table (self-loop from the right
edge into the top; a bracket wrapping the loop for algorithms 4 and 6). Selection is **local component
`$state`, deliberately not in `node.data`** — a rack-mate's click must not yank your panel.

**`dx7-op-detail` (560 px, `minWidth: 560`).** Header = `OP 3` + a role chip. Three rows:
- **A · PITCH** — `COARSE` 0–31, `FINE` 0–99, `DETUNE` −7…+7 (displayed signed, stored 0–14), and a large
  **resolved readout** (`×3.06`). Raw coarse/fine is never shown alone.
- **B · ENVELOPE** — the draggable 4-point curve, the eight `R1–R4 / L1–L4` numeric readouts beneath, and
  a `COPY EG →` action. **Ghost the other five operators' curves behind the active one** (same
  `dx7EgCurve()`, ~10 LOC) — this restores the one FM8 property the map's 20×12 thumbnails cannot deliver:
  cross-operator envelope comparison while editing.
- **C · OUTPUT LEVEL** — 0–99 bar with a dB readout.

**Header also carries the patch-safety cluster** (this is not optional — see §3.5 defect 3):
`E.PIANO 1 ✱` dirty chip · **`REVERT`** · **`STORE`** (append the edit buffer to `node.data.userPatches`
under an editable 10-char name) · **`INIT`**. Without STORE + a name, an edited voice can never be saved
or exported, and `INIT + op mute` is the canonical FM-learning entry point.

**Panel probes** (PF-14), published from the shell layer:
```ts
'dx7-operator-map-{n}': { kind:'panel', label:'operators', component: Dx7OperatorMap, minWidth: 280,
  probe: { testid:'dx7-op-onoff-2', action:'click',
           effect: { kind:'data', key:'opOn[1]', expect:'changed' } } },
'dx7-op-detail-{n}':    { kind:'panel', label:'operator detail', component: Dx7OpDetail, minWidth: 560,
  probe: { testid:'dx7-eg-point-2', action:'drag',
           effect: { kind:'data-rev', key:'voiceRev' } } },
```
⚠ The map's probe asserts **`opOn[1]` changed**, not merely that `voiceRev` advanced — a voiceRev-only
probe passes on a dead mute button.

### 3.4 The algorithm picker

`algorithm` **stays a real ParamDef** (1..32 discrete). Only the RENDERING changes, via PF-15's `'grid'`:
a **chip reading `ALG 05`** that opens a **portaled, viewport-clamped 4×8 popover** of 32 miniature
diagrams (~36×52 px) in the DX7's chart order. Selected cell glows; hover/focus shows
`ALG 24 · 5 carriers · fb op6`; arrows move, Enter/Space commits, Home/End jump; mini-blocks are
role-coloured.

**Popover, not an inline grid, and it is deliberate:** the chip lives in the *same band* as the map, so
the diagram beneath **updates live as you arrow through the grid** — which is strictly better than
side-by-side, and a 320×224 inline grid plus a 280 map plus a 560 detail (1160 px) does not fit the
856 px `.faceplate-body` floor.

DOM contract (load-bearing):
```html
<div class="kcol" data-cell-kind="param" data-cell-control="grid" data-cell-key="algorithm">
  <button class="alg-chip" aria-haspopup="dialog">ALG 05</button>
  <!-- popover, portaled -->
  <div role="radiogroup" aria-label="Algorithm" data-testid="control-algorithm">
    <button role="radio" aria-checked="true" data-testid="dx7-alg-cell-5" …/> …32 total…
  </div>
</div>
```
Exactly **one** `control-algorithm` → faces-parity's multiset holds. The root is `midi-assignable` on
`paramId='algorithm'`.

**Geometry is DERIVED.** New pure module `$lib/audio/dx7-algorithm-layout.ts`:
```ts
export interface Dx7Block    { op:number; col:number; row:number }
export interface Dx7Edge     { from:number; to:number }
export interface Dx7Feedback { from:number; to:number }   // self-loop when from === to
export interface Dx7Layout   { num:number; blocks:Dx7Block[]; edges:Dx7Edge[];
                               feedback:Dx7Feedback; cols:number; rows:number }
export function dx7AlgorithmLayout(num:number): Dx7Layout;
```
`row` = longest path down to a carrier; `col` by a left-to-right DFS over carriers in operator order.
**One pure function feeds the picker, the map, the tiles and the glyph — so the picture can never drift
from the engine.** Unit-tested against `DX7_ALGORITHMS` (all 6 blocks placed, every `modSrcs` edge drawn,
exactly one feedback marker, no two blocks share `(col,row)`) plus a golden snapshot of all 32 layouts.
**Do not ship 32 hand-drawn SVGs** — they rot the instant the table changes and nothing notices.

### 3.5 The glyph

**`glyph: 'scope'` → `'algorithm'`.** Today `glyphBinding` resolves `'scope'` to `live-audio` on `out`
(`shell-glyph-live.ts:126`): at 64 px an FM trace is a wobbly line that looks the same for every patch,
and it **flatlines whenever nothing is gated** — which is most of the time you are looking at a rack. The
algorithm map is **data-derived** and therefore always live: six role-coloured blocks with level bars and
EG thumbnails, wired in the current topology, from the same `dx7AlgorithmLayout` + `dx7OpRole` the dock
uses. In the **dock hero** (214 px cap, `DOCK_HERO_GLYPH_W`) render the map at 100 px beside a 100 px live
`ScopeScreen`; in the **lane**, map only.

### 3.6 The DSP work (the blocking half)

**Message protocol.** `applyPatch` gains a `reset` flag; three new non-destructive messages
(mirroring `packages/dsp/src/cloudseed.ts:1405-1410`'s `setParam` / separate-`clearBuffers` split):

| message | payload | value domain | resets voices? |
|---|---|---|---|
| `patch` | `{voice}` | full `PatchMessage` | **yes** (preset LOAD only) |
| `voice` | `{voice}` | full `PatchMessage` | **no** — used for a REMOTE `voiceRev` bump |
| `opParam` | `{op:0..5, field, value}` | see below | no |
| `algorithm` | `{value:1..32}` | int | no (`process()` re-reads `this.patch.algorithm` per block, `:472`) |
| `feedback` | `{value:0..7}` | int, worklet divides by 7 | no |

**`opParam` value domain — get this wrong and you have a ~1000× envelope error.** The worklet stores
`rateCoefs` (`= rateToCoef(r)`) and `levels`/`outputAmp` (`= levelToAmp(l)`), not the raw bytes:

| `field` | host sends | worklet applies |
|---|---|---|
| `r0..r3` | raw 0–99 | `rateToCoef(v)` → `rateCoefs[n]` |
| `l0..l3` | raw 0–99 | `levelToAmp(v)` → `levels[n]` |
| `level` | raw 0–99 | `levelToAmp(v)` → `outputAmp` |
| `ratio` | float (host `dx7Ratio(coarse,fine)`) | stored verbatim |
| `detuneFactor` | float (host `dx7DetuneFactor`) | stored verbatim |
| `fixedMode` | 0/1 | boolean |

**Operator MUTE routes through `opParam field:'level' value:0`**, never through the whole-patch message —
the stored level stays in `node.data.voice`, so unmute re-sends it. Muting via `{type:'patch'}` would kill
every sounding note (`applyPatch` zeroes `lastGate`, so a still-high gate is not re-detected as a rising
edge until it falls).

### 3.7 The PRs — dependency order

Every PR is independently green and mergeable **except** where a dependency is named.

---

#### **PR 0 — `fix(dx7): correct the 32-algorithm routing table + PER-ALGORITHM feedback` — OWNER PREVIEW, DO NOT AUTO-MERGE**
Depends on: nothing. Everything visual depends on it.

- Fix `modSrcs` for the **14** wrong algorithms — 10, 11, 18, 19, 20, 21, 23, 24, 25, 26, 27, 29, 30, 31 —
  in the **TWO** table sites: `packages/web/src/lib/audio/dx7-algorithms.ts` and
  `packages/dsp/src/dx7.ts` (`MOD_TABLE`). ⚠ **`dx7-render.ts` has NO table** — it
  `import { DX7_ALGORITHMS } from './dx7-algorithms'` (`:15`) and indexes it at `:43`. Do not send an
  agent hunting for a third table.
- **Per-algorithm feedback, which is FOUR line-edits, not a data change.** `Algorithm.feedback` already
  exists (`dsp/src/dx7.ts:84`) but the memory it injects is hardcoded to op6:
  - `dsp/src/dx7.ts:555-556` — injection keyed on `algo.feedback` ✔ (already right)
  - `dsp/src/dx7.ts:574` — `v.fbMem = (v.fbMem + v.opOut[5]!) * 0.5` ✘ **must source from the feedback op**
  - `dx7-render.ts:112-113` — `if (opIdx === 5 && …)` ✘
  - `dx7-render.ts:122` — `fbMem = (fbMem + opOut[5]!) * 0.5` ✘
- **Multi-operator loops (algs 4 → `6→4`, 6 → `6→5`) need `{from,to}`, not `feedback: number`.** Change
  the engine field to a pair in **both** table sites; injection keys on `to`, the memory is fed from
  `from`. A scalar cannot express them and the two must land together or alg 4/6 stay wrong.
- Real placement: **op6** self-loop for 1, 3, 5, 7, 11, 13, 14, 16, 19, 22, 23, 24, 25, 26, 29, 31, 32 ·
  **op2** for 2, 9, 12, 15, 17 · **op3** for 10, 18, 20, 21, 27 · **op4** for 8 · **op5** for 28, 30 ·
  **multi-op** for 4 and 6. Delete `FEEDBACK_OP_DEFAULT` and the false comment at `dsp/src/dx7.ts:189-191`.
- Replace `dx7-algorithms.test.ts`'s structural-only assertions with a **golden pin against the real
  chart** plus an **all-32-rows-distinct** assertion (today only 21 topologies are distinct).
- **ART — the instruction that was wrong in the draft. There are ZERO `.sha` pins for dx7** (101 `.sha`
  files exist under `art/`; none for dx7). The six `art/scenarios/dx7/*.test.ts` are **threshold
  assertions**. So there is nothing to "re-pin" — `algorithm-spectra` (alg 1/5/16/32 mutual distinctness,
  L1 > 0.01), `preset-spectra` (**HARMONICA on alg 19**, in the fixed set; **MARIMBA on alg 8**, whose
  feedback moves op6→op4) and `spectral-audit` must be **re-audited and re-authored**. Budget that as real
  work, not a rubber stamp.
- **Two built-in voices change audibly** — `dx7-banks.ts:118` (alg 19) and `:179` (alg 8). Re-audition and,
  if needed, re-voice them; the docs say they were "written to evoke the classic factory sounds".
- Fix `docs.explanation` in `modules/dx7.ts` — it asserts *"Operator 6 also feeds back into itself"*,
  false for 15 algorithms after this PR.
- **Do NOT touch `vrt-exemptions.ts:881`.** That comment is on the **legacy card**, which this program
  leaves alone; it does not "finally become true".
- Saved racks using the affected algorithms **will sound different**. That is the cost of a correct table;
  surface it in the PR body for the owner's decision.

#### **PR 0b — `fix(dx7): authentic operator envelope + fixed-frequency law` — OWNER PREVIEW, DO NOT AUTO-MERGE**
Depends on: nothing (may be combined with PR 0 at the owner's option — see §6).

The EG editor is the centrepiece of the operator view, and **the envelope it would draw is not the one
this worklet plays.** Verified:

| the DX7 (and the editor) | this worklet |
|---|---|
| idles at **L4** | note-on sets `envValue=0, envSeg=0` (`dsp/src/dx7.ts:393-394`) |
| **HOLDS at L3** while the gate is high | `if (seg < 3)` auto-advances on 1 % proximity (`:659-666`) — it keeps falling to L4 with the gate still high |
| L4 is start **and** end | L4 is only the end |
| linear-in-dB rate law, rate 0 ≈ 90 s | `tau = 8·exp(-0.09·r)`, τ ∈ [1.1 ms, 8 s] (`:614-617`) |
| FIXED = `10^((coarse&3)+fine/100)` Hz | `ratio * C4_HZ` (`:562`) |

Shipping the editor over this engine is the same failure the program declares blocking for the algorithm
table, on a surface visible for **all 32 algorithms × 6 operators**. Fix the engine:
- start/idle at L4; hold at seg 2 until note-off; release seg 3 targets L4;
- linear-in-dB rate law (keep `levelToAmp`'s `(l-99)*0.75 dB`, which is already right);
- fixed-frequency `10^((coarse&3)+fine/100)`;
- **mirror every change into `dx7-render.ts`** — `dsp/src/dx7.ts:5-10` declares it an authoritative SYNC
  PARTNER, and ART reads it, so a one-sided edit means ART silently passes on stale expectations;
- fix the `dx7-syx.ts` header comment: transpose "12 = middle C" is wrong on lines 45 and 92 — it is **24**
  (the worklet correctly uses `transpose − 24`).
- ART: re-author `envelope` and re-check `preset-spectra` / `spectral-audit`.

**If the owner rejects 0b:** re-author §3.3 Row B and `dx7-eg-curve.ts` to draw *this* engine's shape
(start 0, no hold, τ-based times), delete the msfa seconds readout, and move FIXED mode to phase 2. Do not
ship the DX7-authentic curve over the non-authentic engine.

#### **PR 1 — `feat(dsp): incremental non-destructive dx7 operator messages`**
Depends on: nothing (parallel with 0 / 0b).
- The five-message protocol of §3.6 in `dsp/src/dx7.ts`; `applyPatch(voice, reset)`.
- **No render-math change**, so the SYNC PARTNER obligation is satisfied with no `dx7-render.ts` edit and
  no ART movement.
- DSP unit test: `opParam` mutates `this.patch.operators[n]` with the correct transform applied, and leaves
  every voice's `phase/envValue/envSeg/releasing/fbMem/opOut/laneOwner/ampEnv` **and `lastGate`** untouched.
- Delete the now-misleading `docs.controls.algorithm` sentence "it also RESETS the voices".
- **CI delta: ~0.**

#### **PR 2 — `feat(ui): param cell kinds + the panel shell cell`**
Depends on: nothing. **Corrected from the draft — the draft version fails `module-face-lint` on merge.**
- PF-1 (`ParamDef.options`), PF-2 (`'toggle'`), PF-14 (`ShellPanelCell`), PF-15 (`'grid'` + `'algorithm'`
  glyph literal). `face.paramCells?: Readonly<Record<string,'grid'>>` — **only `'grid'`**; `'toggle'` is
  auto-derived from `looksLikeToggle` and `'segmented'` is auto-derived from `options`, so neither needs a
  declaration. (The draft's `Record<string,'segmented'|…>` could not carry option labels at all —
  `Segmented` requires `segments: {value,label,title}[]`, so `filter.mode` would have rendered three
  *unlabeled* buttons.)
- Ship `filter.mode` as `options` in this PR to prove the seam on a module that needs it.
- **DO NOT touch `ACKNOWLEDGED_LATCHING`.** The draft moved `kickdrum:hard`/`snaredrum:hard` out; both are
  `0..1 discrete default 0`, so `module-face-lint.test.ts:321-341` *"every switch-shaped param is
  classified momentary OR acknowledged latching"* fails immediately. They **are** latching; the entry
  records the classification and is orthogonal to the render primitive.
- New lint rules: every `paramCells` key is a declared param **and** appears in `face.order`; a param on
  `face.momentary` may not also be in `paramCells`; **a `panel` cell may only be selected at tier `dock`**.
- faces-parity: `CellControl` union += `'segmented' | 'grid' | 'panel'`; three `driveCell` branches; a
  `readData(page, nodeId, path)` helper mirroring `readParam`.
- **CI delta: ~0** (cell counts unchanged, cheaper drives).
- VRT: regen `face-filter-*` darwin locally.

#### **PR 3 — `feat(dx7): pure model layer`**
Depends on: **PR 0** (the layout golden pins the corrected table). Ideally also **PR 0b** (the EG curve).

| file | responsibility |
|---|---|
| `$lib/audio/dx7-algorithm-layout.ts` | `(num) → {blocks, edges, feedback:{from,to}, cols, rows}` + 32-layout golden |
| `$lib/audio/dx7-op-role.ts` | `(num, op) → role + colour token` |
| `$lib/audio/dx7-eg-curve.ts` | `(r[4], l[4], outputLevel) → polyline + segment times` |
| `$lib/audio/dx7-format.ts` | coarse/fine/mode → `×3.06` / Hz; level → dB; detune 0–14 → ±7; rate → seconds |
| `$lib/audio/dx7-voice-edit.ts` | `deepUnwrapVoice`, `setOpField`, `copyEg`, `isDirty(voice, preset)`, `ratioToCoarseFine` |

- **`coarse`/`fine` must be ADDED to `DX7OpData`** — verified, it stores only the derived `ratio`
  (`dx7-syx.ts:58-75`); `parsePackedVoice:183-186` reads coarse/fine and discards them, and
  `dx7-banks.ts`'s `op()` helper does the same. That means touching `dx7-syx.ts`, `dx7-banks.ts` (×9
  voices), `dx7-render.ts` and the ART fixtures, **plus a defined `ratio → (coarse, fine)` inverse and a
  migration** — every already-saved rack's `node.data.userPatches` has no coarse/fine, and without the
  inverse an imported cartridge opens with an empty pitch row.
- **`deepUnwrapVoice` is a NEW function, not an extraction.** `sendPatch`'s unwrap (`modules/dx7.ts:274-283`)
  builds a `PatchMessage` operator payload — a *different* shape from `DX7Voice` (no `pitchEg`, no `lfo`,
  no name/algorithm/feedback/transpose wrapper). Two functions.
- No UI, no def change, no contract change. **CI delta ~+2 s.**

#### **PR 4 — `feat(dx7): algorithm chip + popover picker + algorithm glyph`**
Depends on: **PR 2, PR 3**.
- `Dx7AlgorithmGrid.svelte` (chip + portaled popover), `Dx7AlgorithmGlyph.svelte`.
- Def: `face.glyph = 'algorithm'`, `face.paramCells = { algorithm: 'grid' }`. No new params/families →
  **no contract-lock move**.
- VRT: regen darwin `face-dx7-compact` + `face-dx7-dock`. `linux/face-dx7-compact` and
  `linux/face-dx7-dock` are already in `EXEMPT_BASELINE_PAIRS` (`vrt-exemptions.ts:1003-1004`) — **leave
  them exempt**, no `vrt-update.yml` dispatch.
- **CI delta ~+2 s.**

#### **PR 5 — `feat(dx7): the voice edit buffer + preset STAMP model`**
Depends on: **PR 1**.
- `node.data.voice` / `opOn` / `voiceRev`; `selectDx7Preset` becomes a **stamp** in ONE `mutateNode`
  transaction (undo is a single step, the collab update is one message):
  ```ts
  mutateNode(nodeId, (live) => {
    live.data.preset      = name;
    live.data.voice       = deepUnwrapVoice(resolved);   // MANDATORY
    live.data.opOn        = [true,true,true,true,true,true];
    live.data.voiceRev    = (live.data.voiceRev ?? 0) + 1;
    live.params.algorithm = resolved.algorithm;
    live.params.feedback  = resolved.feedback;
  });
  ```
  ⚠ **`deepUnwrapVoice` is mandatory, not defensive** — `modules/dx7.ts:261-273` documents a shipped bug:
  voices read out of SyncedStore are Yjs **proxies** whose `op.r`/`op.l` are `Y.Array` proxies that throw
  in `structuredClone`, so SYX-loaded voices fail to stamp while built-ins work.
  ⚠ **Do not put the stamp helper in `packages/web/src/lib/graph/mutate.ts`** — that file IS in the collab
  attest basis.
- Factory: `pollPresetChange` → `pollVoiceRev` + a `lastSentRev` guard; `setParam` routes
  `algorithm`/`feedback` to their messages **before** the AudioParam early-out.
- **KEEP the `currentAlgo` host shadow** (the draft said to retire it — that is incoherent). `readParam` is
  the *engine handle's* method (`modules/dx7.ts:362-368`); `params.get('algorithm')` is `undefined` because
  `algorithm` is not an AudioParam, so deleting the shadow breaks (a) the legacy card's motorized readback
  and (b) PR 2's own `'grid'` drive branch, which polls `readParam`. `dx7.test.ts:162` asserts it. Keep it
  and update it on **both** `setParam` and the stamp.
- **`sendPatch` must inject the params, not the voice's own fields.** It currently posts
  `feedback: Number(voice.feedback)` (`modules/dx7.ts:289`) and `applyPatch` consumes it (`dsp:379`). A
  remote `voiceRev` bump goes through `sendPatch`, so without this a rack-mate's edit silently reverts your
  feedback. Same bug class as the preset poll.
- **Remote `voiceRev` bumps use `{type:'voice'}` (non-destructive), not `{type:'patch'}`.** The draft's
  *"a remote edit is not a live gesture"* is wrong: it means any rack-mate's operator tweak stops **your**
  notes.
- **Migration rule (required, or every saved rack boots wrong).** Old nodes have `data.preset='BASS 1'`
  with no `params.feedback` and often no `params.algorithm` — the existing
  `node.params?.algorithm !== undefined ? … : v.algorithm` (`modules/dx7.ts:301-303`) exists for exactly
  this. On boot: `voice = data.voice ?? deepUnwrapVoice(findPatch(data.preset))`, and hydrate
  `params.algorithm`/`params.feedback` from that voice when absent. `pollVoiceRev` must tolerate an
  undefined `voiceRev`.
- **New param `feedback`** + its `docs.controls` entry + rank 2 + the `operators` page. `task docs:accept`
  → **+1 contract-lock line**.
- **Dirty chip must NOT reuse `dx7PresetName`.** `Dx7Card.svelte:86` binds `<select value={presetName}>`
  from the same reader, and `e2e/tests/dx7.spec.ts` asserts `toHaveValue('E.PIANO 1')` — appending `✱`
  makes the select match no `<option>`. Add a separate `dx7PresetChipLabel()`; leave `dx7PresetName` pure.
- Testable without UI: a unit test that a stamp writes 3 data keys + 2 params in ONE undo step; an e2e that
  a preset change survives reload and reaches a peer.
- **CI delta ~+0.8 s** (10 → 11 cells).

#### **PR 6 — `feat(dx7): the operator map + detail panel`**
Depends on: **PR 3, PR 4, PR 5** (and therefore PR 0 / 0b).
- `Dx7OperatorMap.svelte`, `Dx7OpDetail.svelte`, `Dx7EgEditor.svelte` under `$lib/ui/modules/dx7/`.
- Two new `controlFamilies` (`dx7-operator-map` kind `'cell'`, `dx7-op-detail` kind `'other'`). Their
  `testidPrefix` grep (`module-docs-lint.test.ts:233-243`) is satisfied by the new `.svelte` files
  themselves — `allCardSource()` walks all of `lib/ui/**`. **No legacy-card edit.**
- Two `shell-cells` panel specs with probes; `face.order` + `face.pages` as in §3.2; two `docs.controls`
  entries. `task docs:accept` → **+2 contract-lock lines**.
- **EG editor interaction:** four draggable points; **Y = LEVEL** (0–99), **X = the RATE of the segment
  ARRIVING at that point**, mapped `x = (99 − rate)/99` — **raw rate, never seconds** (rate 99 is
  milliseconds while rate 0 is tens of seconds, so a linear-seconds axis is unusable and a log-seconds axis
  makes the drag→stored round-trip lossy; a 1:1 mapping is also what the VRT baseline and the drag probe
  need). Approximate seconds on hover only. Transient during drag, **single commit on pointer-up** via
  `createDragCommit` — writing each frame into the live Y.Doc is the CV-modulation write-storm class.
  Shift-drag = fine.
- **Delete the draft's "read-only curve + 8 Fader rows" fallback pre-authorization.** Given this repo's
  slip history that fallback becomes the shipped state, and it is one step from the numeric-envelope
  anti-pattern every modern editor replaced. The drag editor **is** the feature: ship PR 6 with it or not
  at all.
- `workflow-shell-faces.spec.ts:52` stays `{ type: 'dx7', pages: 4 }` — **no structural gate edit**.
- **VRT honesty:** the dock will scroll at 720p, and `workflow-shell-faces.spec.ts:225`
  element-screenshots `[data-testid="dock-full-view"]`, so a scrolled `.faceplate-scroll` leaves the
  operators band **unpinned**. Either add a targeted VRT scene that scrolls to the band first, or state
  plainly in the PR that the panels have no pixel gate. Do not imply the dock baseline covers them.
- New e2e `dx7-operator-edit.spec.ts`: load E.PIANO 1 → drag op2's EG point 2 → assert the sound changed
  **and a held note did NOT stop** (the PR-1 payoff — implement as a capability-gated RMS continuity
  assert, not a bare claim) → reload → the edit persisted → mute op2 → assert `opOn[1]` false **and** the
  spectrum changed.
- **CI delta ~+2.4 s** (10 → 13 cells at the measured ~0.8 s/cell; the 1.8 s figure is the *budget
  ceiling*, not wall-time).

#### **PR 7+ — phase 2, engine first**
LFO → pitch EG → keyboard level scaling → rate scaling → osc key sync → amp-mod sens. **Each PR is DSP +
syx-unpack + UI together**; none ships until the engine honours it, or the cell fails faces-parity's
observable-effect bar and forces the docs gate into prose admitting it does nothing. **Velocity sensitivity
stays blocked** until `polyPitchGate` carries velocity — a platform change, not a dx7 one. Do not ship
`opN_kvs` knobs that provably do nothing.

---

## 4. THE 16 MODULES — corrected specs, worst-to-best, in merge batches

Ordering follows the audit's worst→best ranking so the weakest faces are fixed first.
**Global rules applied to every spec below:** ranks 1–6 are the entire lane budget (PF-7); `order` is
priority, `pages` is function order, and they are allowed to disagree; band merges need a grouping
argument, not a budget argument (§1); and at the `full` lane tier a face with ≥4 cells renders **no glyph**
(`laneBodyPlan`: `glyph = hasGlyph && rows <= 1`) — price that into every new param.

### BATCH B — the five weakest (qbrt · vca · lfo · delay · reverb)
Depends on: **PF-7, PF-8, PF-4, PF-1, PF-10, PF-11, PF-12, PF-6f**.
Contract: **+4 lines** (qbrt edge, lfo edge, delay `time_cv_amt`, reverb `diffusion`) + up to 1 family.
CI: **+~2.5 s**. VRT drains: qbrt linux pairs.

**qbrt** — *"two instruments in a four-knob module, and the face has never said so."*
- `order` **unchanged** (`cutoff, resonance, mode, pingDecay`). Say so explicitly: it is right by accident
  and now has arguments (cutoff is the corner *and* the pitch it rings at; resonance is not gain-compensated
  so it is also the loudest thing on the module; `pingDecay` is inert until a cable reaches PING). **The
  draft presented an identical array as a redesign — don't.**
- `pages` stay **2**, headers rewritten to teach: `filter · dual mono` (the fact a patcher most needs —
  no cross-feed, no M/S, both sides on one knob set) and `ping · plays the filter` (the filter never
  self-oscillates, so PING is the only way to make it sing).
- Rear: **rename the `signal` GROUP label** to `stereo in — dual mono, no cross-feed`. **Do not add the
  proposed cluster** — it would cover 100 % of a two-hole band, leaving an empty band header followed by a
  cluster header; that is the rear analogue of the single-control page the same spec convicts.
- **Contract +1: `edge: 'trigger'` on `ping`** (`contract-lock.txt:2541`). `qbrt.dsp:14` is a textbook
  rising-edge detector and the def header calls this a known gap; `docs.inputs.ping` already contains the
  trigger vocabulary, so `module-docs-lint`'s edge gate clears.
- Audition: **PF-6f** (`qbrt-ping` family + `action` cell) + ~8 lines in the factory — a `ConstantSource`
  summed into `merger` input 2 (`qbrt.ts:199,219`) fired through the shared `fireTrigger`. Zero DSP, zero
  Faust recompile.
- `mode` gets **PF-10 landmarks** (0 = LP, ⅓ = BP, ⅔ = HP, 1 = input−BP), **not** PF-1 — a Segmented would
  lie by hiding the in-between blends, which are the point of a morph.
- Structural gate: unchanged (2).

**vca** — *the rack's multiply.*
- `order`: **`['cvAmount','base']`**. `base` defaults to **0** (`vca.ts:58`) — a knob whose default is
  "off, waiting for a cable" is a setup control; `cvAmount` is the attenuverter whose sign turns the module
  from an amplifier into a ducker. On a 2-param module the ranking is 100 % of the front-side budget.
- One page, relabelled **`gain = base + cv × amount`** — the gain LAW is the entire module in eight
  characters, including why a negative amount inverts phase.
- Rear: rename the `gain stage` group → `gain cv`. ⚠ **`rear-card-model.test.ts:182` pins this** — the
  draft billed the face as "S, 1 file"; it is two, plus `rear-vca` is one of only four pinned rear VRT
  scenes with **both** platform baselines committed and neither exempt.
- ⚠ The vca **page id** `'gain'` and the **rear group id** `'gain'` collide, and the curated group's label
  wins on the rear. The plan works *because* they match — renaming either alone desyncs the band.
- **PF-4** labels: `audio` → `OUT`, `audio_inv` → `OUT ⌀ (phase flip)`. Verified `markStereoPairs` will not
  pair them (stems don't match `_l`/`_r`).
- Glyph `meter` unchanged. New params: none (`vca.dsp` has two `hslider`s).

**lfo** — *a quadrature modulation bus, not "an LFO".*
- `order`: **`['rate','depth','shape']`**. `depth 0` is provably flat (`packages/dsp/src/lfo.ts:167-168`,
  `gain = max(0,depth) * 2`), so depth is the modulation's on/off *and* its amount. `shape` is demoted
  **because the glyph already draws it** — the correct use of a glyph is to buy a rank.
- `pages` **2 → 1**: `{ id:'engine', label:'rate · depth · shape' }`. The old `shape` band held one knob,
  and "shape is the engine, depth is an output scaler" does not survive being questioned.
  ⚠ **`rear-card-model.test.ts:195` pins the two-band rear** (`'lfo: curated SYNC band + shape/engine page
  bands'`) — rear CV bands derive from `face.pages`, so this test moves. The draft claimed the rear was
  untouched. ⚠ the def's own comment *"The two CV bands mirror the dock pages exactly"* becomes false —
  rewrite it in the same commit.
- Keep the pinned `sync` group verbatim (an LFO is not a voice; the hole is a phase reset).
- **Contract +1: `edge: 'trigger'` on `clock`** (`contract-lock.txt:1500`; implemented as
  `lastClockSample < 0.5 && c >= 0.5` at `packages/dsp/src/lfo.ts:174-176`).
- **PF-4** labels on the four phase taps — today `expandStem('phase0')` returns **`PHASE0`**, so the rear is
  a label *downgrade* from `LfoCard.svelte:25-27`'s explicit `'PHASE 0°' … 'PHASE 270°'` on the module's
  identity ports. Label them `0°` / `90°` / `180° (anti)` / `270°`.
- `SHAPE_GLYPHS` loss: **ACCEPTED, and the argument goes in the face comment** — the wave-morph glyph shows
  the resolved shape continuously and reactively, which is strictly more information than three static
  marks. **Do NOT "fix" it with PF-1**: `shape` is `linear 0..2` and the crossfade between anchors is a
  documented feature; a Segmented would destroy the morph. Use **PF-10** if anything.
- Structural gate: 2 → **1**.

**delay** — *the primitive single-tap echo.*
- **PF-11 FIRST.** `art/scenarios/delay/profile.test.ts:110` pins
  `docsStrippedRepoSourceSha('.../modules/delay.ts')` and `delay.ts` wraps `docs:` but not `face:` — so
  **even a pure face edit moves the `.sha` today.** Wrap `face:` in `docs-hash-ignore`, take the one-time
  re-pin, and do the same for `scaler`, `polarizer`, `illogic`, `depolarizer`.
- `order`: `['time','feedback','mix','time_cv_amt']`. Rank 1 argument replaced: TIME is the only knob that
  makes **a sound of its own** — it varispeeds the buffer and Dopplers the tail (a measured +0.5 s ramp over
  1 s drops a 1 kHz sine to ~498 Hz); feedback and mix are level-ish.
- `pages` **2 → 1** (`echo`): `output blend` held one knob and was house template shared verbatim with
  reverb/shimmershine/cloudseed.
- Rear: the page collapse **forces a pin** — otherwise `time` derives into a band named `echo`, worse than
  today. Pin `{ id:'mod', label:'time cv · varispeeds the line', ports:['time'] }`, keep `mono in`, keep
  `audioRate:['time']` (it is the only true `~` in the batch: `DelayNode.delayTime` is a-rate and the CV
  reaches it through a plain scaling curve with no de-zipping).
- **Contract +1: `time_cv_amt`** (±1, default +1 = exact identity). Justification is the module's own
  documented dead feature: the docs advertise *"a slow LFO into TIME CV at a few milliseconds of depth and
  you have a flanger"* and a full-scale ±1 CV moves the delay ±1.0 s. Needs **PF-12** (with the tap move).
- ⚠ **Priced trade:** 3 → 4 ranked controls crosses the plate to 2 rows, so delay **loses its full-tier
  in-lane glyph** permanently. Take it (glyph survives at mini, compact and the dock hero) and state it in
  the commit so nobody rediscovers it as a bug.
- Glyph stays **`meter`** — the `tail` proposal is demoted (§2).
- Rejected on the module's own stated boundary: feedback CV (the absence of it is what makes the 0.95
  ceiling absolute), a tone control in the loop (that is COFEFVE), ping-pong (COFEFVE).
- Structural gate: 2 → **1**.

**reverb** — *the plain room.*
- **The `size` → `Decay` RELABEL is the highest-value edit and it is FREE.** `ParamDef.label` is excluded
  from `contract-signature` (`delay.ts:86-91` states the precedent). Keep the param **id** `size`
  (renaming it moves contract-lock *and* orphans every saved rack's value). Rewrite `docs.controls.size` to
  lead with DECAY — today it has to apologise for the name in its first sentence.
- `order`: `['mix','size','damp','diffusion']`. `mix` leads because it is the only level-critical control —
  the wet leg is eight combs summed with no output scaling, ~+10 dB at default and ~+21 dB peak at size 1,
  with nothing limiting.
- `pages` **2 → 1** (`reverb tank → blend`), rendered in signal order while `order` leads with `mix`.
- **Contract +1: `diffusion`** (allpass feedback, currently the literal `fb2 = 0.5`). ⚠ **do NOT `si.smoo`
  it** — `si.smoo` initialises at 0 and ramps over ~23 ms, exactly the region an impulse-response profile
  captures, so it *would* move the `.f32`. A plain `hslider` compiles to a per-block constant and should be
  byte-identical at the default 0.5. **Verify from a clean `packages/dsp/dist` with a real `task dsp:build`**,
  not `dsp:fetch-dist`.
- **`room` (Faust `spread`) is REJECTED** — see §2's demotion table. Reverb's contract cost is **+1, not +2**.
- ⚠ 3 → 4 ranked controls: same glyph cliff as delay.
- Glyph stays `meter`. Rejected: switching `mix` to equal-power (changes audio for every saved patch).
- Rear finished; change nothing (`mono in` states the module's most consequential patch-time fact).
- Structural gate: 2 → **1**.

### BATCH C — cloudseed alone
Depends on: **PF-1, PF-2, PF-3, PF-13, PF-16, PF-17**. Contract: **+11 lines**. CI: **+0.8 s** + ~1.6 s tabs.
This is the largest face in the repo (47 cells) and gets its own PR.

- **LOSS 1 (SEVERE — a state-consistency bug, not a UI downgrade).** `CloudseedCard.svelte:252-269` renders
  the whole preset bank and its `applyPreset` writes all 46 values into the graph in one undoable
  `mutateNode`. The face ranks `preset_index` as an ordinary param, and turning it fires
  `cloudseed.ts:699-722`, which pushes the preset into the **worklet** and explicitly leaves the store
  alone — so in the dock **the sound changes while the persisted Y.Doc keeps the old 45 values**, and the
  next knob move, save/reload or peer join silently reverts it.
  **Remedy:** extract `$lib/ui/modules/cloudseed-preset-actions.ts` (lift `applyPreset` + `cppIdToParamId`
  out of the card so both surfaces call the same stamp); **DELETE `cloudseed.ts:699-722`** — this is safe,
  verified: `packages/web/src/lib/audio/reconciler.ts:175-190` diffs `node.params` and calls
  `engine.setParam` per changed key, so the 46 `mutateNode` writes reconcile normally; add **PF-13**
  (`SHELL_PARAM_WRITES.cloudseed.preset_index`) with the MIDI storm guard; render via **PF-1** `options`
  derived from `CLOUDSEED_PRESETS` (`p.name.replace(/^\[FX\]\s*/,'').toLowerCase()` → `divine inspiration`,
  `short room`, `bright hall`, `infinite pad`). **Do not touch `preset.name`** — `impulse-response.test.ts`
  matches on `.includes('SHORT')`.
  **Not a ControlFamily:** that costs a contract line *and* leaves `preset_index` needing a second cell.
  **Behaviour change to note in the PR:** a collaborator's recall now arrives as 46 visible param writes.
- **LOSS 2 (SEVERE).** Nine ON/OFF pills render as continuous rotaries — eight `*_enabled` plus `late_mode`.
  ⚠ **The draft said ten and listed `interpolation`; `interpolation` is NOT on the card** — it appears in
  `CloudseedCard.svelte` only inside `cppIdToParamId` (line 81).
  **Remedy (a):** flip the `curve` from `'linear'` to `'discrete'` for the 8 enables + `late_mode` +
  `interpolation` = **10 contract lines**. Include `interpolation`: the worklet hard-thresholds all of them
  at 0.5 (`cloudseed.ts:122-131,155`), so `linear` was always a lie about the value space. Implementation is
  one optional `curve` on `CLOUDSEED_MESSAGE_PARAMS` honoured by the `.map()` at `:463-470`.
  **Follow-on the gate will demand:** every flipped param whose default is 0 becomes `looksLikeSwitch`-shaped
  and must go into `ACKNOWLEDGED_LATCHING` as `cloudseed:<id>` — they are **latching**, never
  `face.momentary`. Let the gate name them; the known five are `high_cut_enabled`, `tap_enabled`,
  `early_diffuse_enabled`, `eq_low_shelf_enabled`, `eq_lowpass_enabled`.
  **Remedy (b):** **PF-2** renders them as `<Toggle>` (zero e2e work — the existing `'toggle'` drive branch
  handles it). `late_mode` uses **PF-1** instead (`{0:'pre'},{1:'post'}`) — a Toggle labelled "Late Mode"
  has an ambiguous on-state.
  ⚠ **`late_mode` migration is NOT safe as the draft claimed.** The shell paints it as a continuous knob
  today, so a saved rack can legitimately hold 0.37, and `activeSegmentIndex` is an exact match returning
  `-1` → a Segmented lighting nothing. Use `nearestSegmentValue` (already at `Segmented.svelte:36-45`, wired
  only to the MIDI path) on read, or normalise at load. **Assert against a real saved fixture.**
- **LOSS 3.** All 46 readouts. **PF-3, and here it is ~10 lines** because `formatParameter(val, cppId)`
  already exists and is exported (`cloudseed.ts:177-242`) and `CLOUDSEED_MESSAGE_PARAMS` already carries
  every `cppId` (`:383-422`): `format: (v) => formatParameter(v, p.cppId)` in the `.map()`, plus seven
  one-liners for the macros via `CLOUDSEED_MACRO_CPP_MAP` (`:743-751`). `Decay 0.63` becomes `2.34 sec` —
  which restores the card's DECAY hero readout as a property of the knob.
- **LOSS 4.** `<OssAttribution author="Ghost Note Audio">` (`CloudseedCard.svelte:272`) — **PF-17**.
- **LOSS 5 (new).** The worklet already handles `clearBuffers` (`packages/dsp/src/cloudseed.ts:1410-1411`,
  wired down through `ReverbController` → every line/diffuser/shelf/lowpass) and the host has **never sent
  it**. On a module whose INFINITE PAD tail is ~30 s, "make it stop" is a real gesture with a real
  implementation and no button. Ship a one-member `controlFamily {id:'cloudseed-clear', kind:'other',
  testidPrefix:'cs-clear-tail'}` + a `shell-cells` `action` cell + `handle.write('clearTail')` + **the
  matching button in `CloudseedCard.svelte`** (required by `module-docs-lint.test.ts:231-248`).
  **+1 contract family line + 1 `docs.controls` entry.**
- **`order` — 47 keys.** `preset_index` at rank 1 (the dx7 precedent: on a 46-parameter *constructive*
  reverb the first decision is never a fader), then `late_out, late_line_decay, dry_out, late_line_size,
  tap_predelay, early_out, high_cut` for the hero eight, then input stage / late lines / late diffusion /
  taps / early diffusion / tail EQ / stereo+seeds, then `cloudseed-clear-{n}`.
  ⚠ **`tap_predelay` 15 → 6** is the biggest re-rank and the clearest illustration of what a curated face
  is *for*: it is buried in the `taps` page only because the C++ enum put it in the tap group
  (`CloudseedParam.TapPredelay = 12`), while the docs say it is *"a 0..500 ms gap ahead of the entire wet
  path"*. Pre-delay is on the front panel of every reverb ever made.
  ⚠ **Drop the mini-tier illustration.** The lane knob column is capped at 46 px (`--kcol-max`), so mini
  renders a KnobConic with a truncated readout, not a tile reading `bright hall`. The ranking still stands.
- **`pages` — 8, membership rewritten, count UNCHANGED.**
  1. `space · blend` (7): `preset_index, late_out, late_line_decay, dry_out, early_out, late_line_size,`
     **`cloudseed-clear-{n}`** — ⚠ the draft omitted the family from *both* `order` and `pages`, which
     would (a) fail `module-face-lint.test.ts:178-182` and (b) once ranked-but-unpaged, produce a 9th
     `__unpaged` band (`curated-face.ts:224-230`) and fail the structural gate `{type:'cloudseed', pages:8}`.
  2. `input · pre-delay · cuts` (6) — ⚠ **fixes a plain paging bug**: today `low_cut` sits on `input stage`
     (`:627`) and `high_cut` on `output stage` (`:632`), yet the docs describe **both** as wet-path input
     filters. This also un-splits the rear.
  3. `taps · early echoes` (4) · 4. `early diffusion` (6) · 5. `late tank · delay lines` (4) ·
  6. `late diffusion · in-loop` (7) · 7. `tail eq · inside the loop` (8) ·
  8. `stereo · seeds · re-roll the room` (5).
  **7+6+4+6+4+7+8+5 = 47 ✓.** The `late` 12-control dumping ground splits into two engines — the def's own
  `order` comment (`:596`) already knew the split; the page never took it.
- **Rear.** Pin `stereo in` + one cluster `wet tone cuts` (`low_cut_cv`, `high_cut_cv`); the re-paging fixes
  the rest for free. ⚠ **`rear-card-model.test.ts:210-219` pins the current rear exactly**
  (`['signal','blend','input','output']` with exact per-band port lists) and **must be updated** to
  `['signal','space','input','seeds']`. The draft's verification list omitted `rear-card-model` entirely.
- **PF-16 tabs.** Eight bands × ~81 px is the one face no amount of re-grouping fixes. CSS-hide inactive
  pages so faces-parity §1 and the cell-count assert pass unchanged.
- New controls: **none needed** — cloudseed is the only module in the program with 100 % engine coverage
  (all 45 C++ params declared). Its problem is entirely presentation, which is a legitimate finding.
- **Risk: HIGH, concentrated in deleting `cloudseed.ts:699-722`.** Pair it with a regression test that
  (i) recalls a preset, (ii) edits one knob, (iii) asserts the edit **survives**, (iv) asserts all 46 graph
  params equal the preset's.

### BATCH D — shimmershine · adsr · mixer · filter
Depends on: **PF-1, PF-4, PF-9**. Contract: **+1 line** (adsr edge). CI: **~0**. VRT drains: shimmershine.

**shimmershine** — *the ambient halo; a module parked on a self-oscillation threshold.*
- `order`: **`['shimmer','damp','mix','size','decay']`**. `damp` 4 → 2 is the strongest DSP-grounded call in
  the batch: `_CombLP.tick` is `fbStore = fbStore*damp + y*(1-damp)`, so at damp 1 the store never takes new
  signal, comb feedback stops outright and the tail collapses to ~0.15 s RT60 **whatever DECAY and SIZE are
  doing**. It is the tone control *and* the panic button — and the **only param with no CV jack**, so the
  panel knob is the only way to reach it. `decay` 3 → 5 because `effSize = size * (0.5 + 0.5*decay)`
  (`:192`) — a dependent scaler cannot outrank the parameter it scales, and it does nothing at size 0.
- `pages` **3 → 2**, split by architecture, not by template:
  `{loop: shimmer, damp}` (the regeneration path — **damp lives inside each comb's feedback loop**
  (`:61-66`), so filing it under "reverb tank" actively misteaches) and `{tank: size, decay, mix}`.
- ⚠ **The rear band labels need explicit `rear.groups` entries** — with no curated group for id `loop`, the
  rear band inherits the **page** label. To get `shimmer loop · damp is panel-only` and `tank · blend` you
  must declare them. The draft assumed they'd appear.
- Rear also: `stereo in · patch BOTH` — `in_r` is **not** normalled from `in_l` (the factory wires a
  0-valued ConstantSource into both worklet inputs, so the mono fallback is dead in practice, "verified in
  Chrome") and a mono source patched to IN L alone comes back **hard-left**. That is the most likely user
  bug with this module and the rear is where the patcher is standing.
- Glyph stays `meter` (the `tail` proposal is demoted). Deferred to their own PRs: `damp_cv` port
  (⚠ **verify ART, do not assume** — adding an input changes the factory's input map and node fan-in) and
  the `interval` param (default **must** be 2.0; ART re-pin).
- Structural gate: 3 → **2**. VRT: darwin regen; **`linux/face-shimmershine-{compact,dock}` are in
  `EXEMPT_BASELINE_PAIRS` (`vrt-exemptions.ts:1011-1012`)** — either leave them exempt (darwin only) or
  drain + lower the vrt-meta ratchet by 2 in the same commit before dispatching.

**adsr** — *the rack's shape-of-a-note.*
- `order`: **`['release','attack','sustain','decay']`**. The argument is structural, and I verified both
  premises: `sustain` defaults to **0.7** so decay travels only 0.3, and `TRIGGER_PULSE_S = 0.005`
  (`gate-trigger.ts:35`) is **exactly** the `attack` default of `0.005 s` — so under the rack's canonical
  trigger pulse the attack completes at the instant the gate drops and **the entire audible envelope is the
  release**. Release is also the only stage that applies unconditionally (*"applies even when the gate drops
  mid-attack"*). ⚠ **owner taste call** — the counter ("attack is the most-played envelope control") is real
  for a swell-oriented amp EG; the revert is one line.
- **Keep the page id `stages`**; relabel to `gate → attack · decay · sustain · release`.
  ⚠ **`e2e/tests/workflow-shell-faces.spec.ts:117` asserts `.page-label` `toHaveText('stages')`** — a hard
  break. Update the assert in the same commit. ⚠ the comment at `:96` (*"the designer's top-ranked control
  (attack, rank 1 — shows at EVERY tier)"*) becomes wrong; rewrite it.
  Controls stay in canonical A/D/S/R order, **deliberately not `face.order`** — `order` is priority for
  tiers showing a subset; a page shows all four, where the only sane order is signal order. Say so.
- **Contract +1: `edge: 'gate'` on `gate`** (`contract-lock.txt:40`). Its own doc says it is level-sensitive
  on both edges (`adsr.ts:127`) — textbook `edge:'gate'`, and tidyVco's identical port already declares it
  (`:3235`). Without it the rear renders no `▬` glyph and no edge legend on the module's only input band.
- Keep the rear's two clusters split **by CV law** (`times` log ±1 V = ×100/÷100 vs `level` linear ±0.5) —
  with param labels A/D/S/R that header is the only thing that says which hole is a level. Page **id**
  unchanged → `rear-card-model.test.ts:158` does not move.
- **PF-4** labels: `env` → `ENVELOPE`, `env_inv` → `ENVELOPE ⁻¹ (duck)` — nothing today says they are the
  same contour, one flipped, which is the whole "one cable gives you sidechain" pitch.
- Deferred to their own PRs: the playhead glyph (needs a cv-output resolver) and `manualGate` (+1 param,
  ART re-pin against **both** `adsr` and `adsr-invert`).
- ⚠ adsr is alphabetically first in faces-parity and pays SvelteKit's cold `/rack` compile — **do not let
  its budget shrink.**
- Structural gate: 1 (unchanged; only the label assert moves).

**mixer** — *four-into-one; zero control loss, verified.*
- `order` **unchanged** (`master` first). The argument the draft was missing and that settles it:
  **`master` is the module's only headroom control** — it cannot boost (max 1.0), the sum is unbounded, and
  four correlated unity sources leave this module at **+12 dB**, clipping at whatever downstream stage
  clamps. Mini = master + meter *is* the clip-management pair.
- `pages` **2 → 1** (`channel levels · in1→ch1 … in4→ch4 → master`). Every hardware mixer puts the master in
  the channel row; a 5-fader mixer that needs a scroll is absurd. Rear unaffected — none of the four inputs
  is a per-param CV, so `curatedByPort` claims them before derivation.
- **PF-4** labels — adopt the card's **existing** vocabulary so both surfaces match and nothing churns:
  `in1..in4` → `INPUT 1..4`, `audio` → `OUT` (`MixerCard.svelte:22-24`). ⚠ the draft proposed
  `CH 1..4`/`SUM`, i.e. a *new* vocabulary; don't. Today `expandStem('in1')` → `IN1` (no `^in\d$` in
  `PREFIX_TO_VERBOSE`), which is why the band label currently has to carry the whole mapping.
- Glyph: keep `meter`; ship the **S fallback — make `VuMeter` clip-aware** (a red segment above 1.0), which
  is the cheapest safety win on the module whose headline hazard is "MIXER does not protect you". The
  `levels` per-channel ladder is demoted (§2).
- New controls: **none**. Master above unity is rejected on musical grounds (it worsens the one hazard and
  removes the only headroom control); mute is `ch=0`; per-channel CV is ATTENUMIX; pan/stereo is MIXMSTRS.
- Structural gate (`e2e/vrt/workflow-shell-faces.spec.ts` FACES table): 2 → **1**.

**filter** — *the bread-and-butter VCF.*
- `order` **unchanged**, now defended: rank 4 `cutoff_cv_amt` outranks `res_cv_amt` because **EG → cutoff is
  the single most common patch in any rack** and without the trim a plain 0..1 envelope asks for +5 octaves
  and pins at the 20 kHz ceiling (`filter.ts:26-29`).
- `pages` stay **2** — `cv depth` groups 2 controls and names a stage a player thinks about separately.
  ⚠ **Delete the fold justification** (§1: I measured `face-filter-dock.png`; both bands render fully with
  ~15 px spare, and filter.ts's in-source "verified against the captured baseline" claim was correct).
- **Loss remedy — PF-1 on `mode`:**
  ```ts
  options: [ {value:0,label:'lp'}, {value:1,label:'hp'}, {value:2,label:'bp'} ]  // ba.selectn branch order
  ```
  Dock → `<Segmented>`; every lane tier → KnobConic with a **persistent** `lp`/`hp`/`bp` readout (`mode` is
  rank 3 so it only appears at the plate tier, where a Segmented could never fit).
- Rear **finished — change nothing.** The `res` pin is already the right non-obvious call: `res` carries
  neither `paramTarget` nor a `<param>_cv` id, so derivation would file it next to the audio input.
- Glyph stays `scope`; the `response` kind is demoted (§2).
- New controls: **none.** `filter.dsp` has three UI elements; the two attenuverters are the entire
  engine-graph headroom. Log the `mode` morph (crossfade instead of `ba.selectn`) as a separate audio PR —
  it would also break the Segmented render.
- Structural gate: 2 (unchanged).

### BATCH E — tomtom · karplus · snaredrum
Depends on: **PF-6f** (or PF-6), **PF-2**, **PF-9**. Contract: **+2 family lines** (karplus, snaredrum) if
on the fallback path, 0 on PF-6. CI: **+~3 s**. VRT drains: tomtom, snaredrum.

**tomtom** — *the whole classic synth-tom lineage in one continuous space; the repo's reference face.*
- ⚠ **HARD GATE FIX.** The draft removed `strike` from `face.order` while keeping
  `face.momentary: ['strike']`. `module-face-lint.test.ts:314` fails on exactly that combination:
  *"face.momentary '<id>' is not ranked in face.order"*. **`strike` STAYS at rank 9** (the draft's own
  fallback becomes the default). Nothing is lost — the pad already works via `face.momentary` →
  ModuleShell's momentary `<Button>` (`:363-378`), which presses **and releases** so nothing latches. Under
  PF-6 later, an action-listed param id can satisfy completeness and the pad moves to a fixed slot.
- `order` ranks 1–6 unchanged (`tune, bend_amt, decay, tone, noise, drive` — exactly the Vermona DRM1 tom
  channel, in the lane). `bend_time` at 7 keeps its argument (inaudible while BEND is 0). `level` at 8 per
  the drum-family rule (tomtom sets loudness with drive; the rack's mixer owns the fader).
- `pages` **4 → 2**: `membrane · sweep · ring` (tune, bend_amt, bend_time, decay, tone) and
  `stick · heat · out` (**strike**, noise, drive, level). Band 1 is one idea — everything the struck head
  does. Band 2 is everything that is not the membrane, and it finally gives the STRIKE pad a home named for
  the stick.
- ⚠ **The `membrane` rear pin is MANDATORY and must be re-pointed at the new page id.** `bend_cv`'s stem is
  `bend`, which is not a param (`bend_amt` is), so `rearTargetParamId` returns `'bend'`, `pageOfParam`
  misses, and the hole falls into the trailing orphan `cv` band. Renaming the page without moving the pin
  silently re-breaks it. **Do NOT "fix" this with `paramTarget: 'bend_amt'`** — tomtom reads all eleven
  inputs as node inputs per sample, so a `paramTarget` would re-route the CV onto an AudioParam, break the
  DSP wiring **and** move a contract line.
- `audioRate` on every continuous CV is correct and unusual here — the worklet reads them per sample with no
  smoothing. `trigger_in`/`accent_in` are rightly excluded (the trigger's meaning is its edge; accent is
  latched at that edge).
- New controls: none (`TomtomParams` is a 1:1 mirror). Structural gate: 4 → **2**.

**karplus** — *physical modelling's original trick; the module that CANNOT sound without an external strike.*
- `order`: **`['decay','brightness','tune','color','burst','level','position','stiffness']`** — `level`
  8 → 6, `position` 6 → 7. The draft's rank-8 comment said *"as on every face"*, which is the generic
  reasoning this program exists to kill, **and it is wrong for this module**: karplus is the only voice with
  no output bound (kick/snare/tom all end in a true-peak tanh), and `docs.controls.level` says *"nothing
  normalizes the voice's loudness across settings — a bright, long, hard-picked note is far hotter than a
  dark mallet thump"* — and the knob that causes that blow-up is `brightness`, **rank 2, in the same tile**.
  `position` is the right thing to give up: its own docs recommend it as a per-step S&H CV target, not a
  knob you ride.
- `pages` **3 → 2**: `string · ring` (tune, decay, brightness, stiffness) and `pick · strike · out`
  (color, burst, position, level). The old `out` page held one knob; the insight is that on this module the
  output trim exists *because* the exciter settings change the loudness — COLOR/BURST/POS/LEVEL are one idea.
- **PLUCK (SEVERE loss).** `KarplusCard.svelte:123-129` fires through `engine.read(node,'manualTrigger')`
  (`karplus.ts:288-295`); it is neither a param nor a family, so it **cannot be ranked at all** and karplus
  has no legend file — **neither gate can see the omission**. Remedy: **PF-6f** family `karplus-strike`
  (`testidPrefix` already greps clean against `KarplusCard.svelte:127`) + a `shell-cells` action; migrate to
  PF-6 later. **Land karplus's and sixstrum's together — they are the same shape.**
- Rear **unchanged** — the two-hands split (striking hand: trigger+accent latched at the edge = one gesture;
  fretting hand: pitch+damp) is the most musically-argued rear in the repo. CV routing into the two new page
  ids verified zero-orphan.
- ⚠ At the `full` tier karplus renders 6 cells and **no glyph** — the "most informative pixel budget on the
  tile" claim holds at mini/compact/dock hero only.
- Structural gate: 3 → **2**. VRT: karplus's linux pairs are **already drained** — no dispatch.

**snaredrum** — *its reason to exist is the two-hand DRUMROLL.*
- `order`: `['tune','wire','tone','roll_speed','bounce','damp', 'head_decay','crack','pitch_amt',
  'pitch_time','damping','body_decay','wire_tone','wire_decay','crack_tone','humanize','spread',
  'drive','hard','ceiling','width','level']`. **`bounce` 7 → 5 is the best-evidenced finding in the whole
  program** — at rank 7 it renders **nowhere** in the lane, so today you can set a roll's rate but not its
  character on the only drum with a roll engine. `roll_speed` 6 → 4. `damp` 13 → 6: one knob scaling head,
  body **and** the wire bed's decays together (×(1 − 0.6·damp)) — the "towel on the drum" gesture, and the
  natural counterpart to a buzz roll.
- `pages` **5 → 4**, function-grouped (page order ≠ rank order, per §1 — do NOT re-cut this face to put the
  heroes in band 1):
  1. `drum · head + body` (6): tune, pitch_amt, pitch_time, damping, head_decay, body_decay
  2. `snap · wire + crack` (5): wire, wire_tone, wire_decay, crack, crack_tone
  3. `roll · two hands` (4): roll_speed, bounce, humanize, spread — the best band in the program and the
     only page in the repo naming a mechanism no other module has
  4. `whole drum · bus · out` (7): tone, damp, drive, hard, ceiling, width, level — `tone` tilts the tonal
     voice *against the wire bed* and `damp` scales all three decays, so both are whole-instrument scalers,
     not head controls. That is what dissolves the old 8-control `tone · body` dumping ground.
  **6+5+4+7 = 22 ✓**
- ⚠ **Reconcile the draft's prose with its code**: it said *"the only change to the existing curation is the
  strike cluster's label"* and then added five clusters. Ship the clusters (via **PF-9** on the front where
  wanted, and rear clusters as today) and describe them accurately.
- Rear: keep everything; change the strike cluster label to **`strike — one hit / hold to roll`**. That
  single string is where a player learns the module's defining fact — two strike jacks with *different*
  semantics — at the moment they are dragging a cable.
- **Audition — snaredrum is the module that proves the seam needs TWO modes.** `hit` (trigger) + `roll`
  (**gate**, `mode:'gate'`, a second host ConstantSource held into worklet input 1 — verified `gate_in` is
  input 1, `snaredrum.ts:331`). Without a gate mode the roll is unauditionable. On the PF-6f path this is
  one family with two action cells.
- `hard` → **PF-2** Toggle (leave the `ACKNOWLEDGED_LATCHING` entry in place).
- ⚠ **File the known `spread` sign bug** alongside this work: `docs.controls.spread` documents that the
  bed's pan term is summed with the **opposite** sign to the voices' constant-power pan, so a left-hand
  stroke throws its sizzle right. It is a `packages/dsp/src/lib/` fix + ART re-pin, out of scope — but
  promoting the roll band raises the chance a user reports it first.
- New controls: none (`PARAM_TABLE` is exactly 22 rows). Structural gate: 5 → **4**. VRT drain:
  `linux/face-snaredrum-{compact,dock}` (`vrt-exemptions.ts:1007-1008`).

### BATCH F — sixstrum · kickdrum · tidyVco
Depends on: **PF-1, PF-4, PF-9, PF-2, PF-6f**. Contract: **+1 family line** (sixstrum) on the fallback path.
CI: **+~2.5 s**. VRT drains: sixstrum (incl. rear).

**sixstrum** — *not a voice, an instrument.*
- ⚠ **`sixstrum-preset-{n}` goes to rank 3, NOT rank 1.** The draft's rank-1 promotion fails three ways:
  (a) its central argument is factually wrong — `sixstrumPresetName` reads back off **`tuning` alone**
  (`sixstrum-preset-actions.ts:64-70`, whose own comment says it reports *"the TUNING the instrument is
  in… not 'the preset is still pristine'"*), so it is a 3-state readout of one param, not "the
  highest-information readout on the module"; (b) at `mini` `cellCount = 1`, so the **only** visible control
  at the coarsest zoom would be a one-click **destructive 14-param `setNodeParam` stamp** — the dx7
  precedent does not transfer, dx7's selector writes one `node.data.preset` slot; (c) it would knock `ring`
  off the compact tile.
  **Corrected `order`:** `['strumSpread','ring','sixstrum-preset-{n}','material','pickTone','body',
  'muteDepth','register','strumDir','tuning','quality','stiffness','spread','pickGrain','pickPos',
  'attack','envDecay','sustain','release','level']`. Compact stays `strumSpread + ring`; the preset is the
  first control in the first dock band. **`body` 20 → 6, replacing `muteDepth`** — muteDepth is inert unless
  a MUTE gate is patched (an always-dead lane cell) while BODY always does something and follows TUNING
  (guitar ≈100/215 Hz, bass ≈58/120, harp ≈175/330), i.e. it is the acoustic half of "which instrument".
- ⚠ **Shorten the declared family label** from `'Preset — guitar / bass / harp'` to `'Preset'`. The lane
  `Selector` renders `ctl.label` inside a 46 px `--kcol-max` column. **Contract-transparent** — the family
  line emits `id kind prefix [count]`, no label.
- `pages` **6 → 5** (the anatomy cut, without over-merging):
  1. `instrument · tuning · chord` (4): preset, tuning, register, quality — preset first, `tuning` right
     under it as "the one value of that preset you can still swap alone"
  2. `strings` (4): ring, material, stiffness, spread
  3. `strum hand` (3): strumSpread, strumDir, muteDepth
  4. `pick` (3): pickTone, pickGrain, pickPos
  5. `envelope · body · out` (6): attack, envDecay, sustain, release, body, level — on this instrument the
     amp ADSR and the box are the same stage: strings → per-string ADSR → sum → LEVEL → **then** BODY.
  **4+4+3+3+6 = 20 ✓**
- **STRUM (SEVERE loss)** — `SixstrumCard.svelte:188-194` → `sixstrum.ts:378-385`, unrankable. **PF-6f**
  family `sixstrum-strum` (prefix greps clean against `:192`). ⚠ **DO NOT use the karplus ConstantSource
  pattern blindly here**: `sixstrum.ts:319-323` states *"NO silence keep-alives on the inputs — SIX STRUM
  detects an unpatched input by its zero-length channel array (that's how strum normalling and poly/chord
  presence work)."* Any permanently-connected source on an input that is not already carrying `strumCs`
  makes that input read as patched forever. Verify `strumCs`'s existing connection does not already defeat
  strum-1 normalling.
- **Three name readouts → PF-1 `options`:** `strumDir` (down/up/alt), `tuning` (guitar/bass/harp),
  `quality` (maj/min/dom7/maj7/min7/sus4/pow5/oct → ≥7 options, so `Selector` in the dock). Today the shell
  shows `5` where the card showed `sus4`.
- **Rear — keep FUNCTION grouping** (all six strums, then all six mutes), against the card's per-string
  sections, because the **normalling rule is a property of the strum SET** ("an unpatched string follows the
  nearest PATCHED strum at or below it") and the mute set's "hold all six to choke" is likewise a set
  property; splitting into six pairs makes both invisible. Buy back per-string findability with **PF-4**:
  the twelve holes read `1 2 3 4 5 6` twice under their cluster headers. Band label `play — three ways`
  (POLY *owns* pitch and plucking while patched; the strum triggers and chord voicer stand down).
- New controls: none. Structural gate: 6 → **5**. VRT drains: `linux/face-sixstrum-{compact,dock}` **and
  `linux/rear-sixstrum`** (`vrt-exemptions.ts:1005-1006, 1016`) — sixstrum is the only module in the program
  needing a **rear** re-capture.

**kickdrum** — *a producer's kick; the batch's reference face.*
- `order` **ranks 1–6 unchanged** — say so plainly; they already satisfy "the control a player rides", and
  churning a correct ranking is not a deliverable. The 7+ tail is re-ordered to read **band by band**
  (sub → body → click → drive → dynamics) so the roster and the faceplate tell the same story. ⚠ **correct
  the false comment at `kickdrum.ts:150`** ("ranks 4–8 → the full-in-lane face") — per PF-7 ranks 7-8 render
  nowhere in the lane, which is why `level` is invisible today.
- ⚠ **`level` stays dock-only** (the drum-family rule): kickdrum sets loudness with DRIVE and CEILING, and
  `level` is applied *before* the ceiling, so it is a saturation lever, not a fader.
- `pages` **6 → 5** — the draft's 4-page cut produced a **9-control `bus` band that is three different
  things**, i.e. exactly the charge it levels at snaredrum, and the "reading order teaches the chain"
  defence does not survive a 50/50 pane (~626 px visible against ~584 px of cells behind a 900 px
  `.faceplate-body` floor). Corrected:
  1. `sub · the pulse` (5): tune, sub_decay, sub_level, sub_eq, **translate** — with the reason now stated:
     TRANSLATE taps a copy of the **raw sub layer pre-drive** and reconstructs its 2nd/3rd/4th harmonics, so
     it is literally a sub-layer control (the audit's one thinness finding, closed).
  2. `body · the punch` (7) · 3. `click · the edge` (4) · 4. `drive · character` (3: drive, hard, tilt) ·
  5. `dynamics · out` (6: attack, sustain, glue, ceiling, width, level). **5+7+4+3+6 = 25 ✓**
  Keeps the face's best existing idea: each band-EQ lives with the layer it shapes.
- Rear: keep the pinned `strike` band (renamed off the derived `voice` because this drum has no pitch/gate
  note pair *and* because `pitch_cv`'s stem is `pitch` — the day a param named `pitch` appears,
  `rearTargetParamId` would silently re-file the jack). Add the `drive` / `dynamics` / `stereo · out`
  clusters so the merged bands still read as the mastering chain. `audioRate: ['pitch_cv']` stays.
- `hard` → **PF-2** Toggle. Audition → **PF-6f** (`kickdrum-strike`) + a host `ConstantSource` fired through
  `fireTrigger`. ⚠ **Do NOT solve the audition with a `strike` PARAM** — that requires a row in
  `packages/dsp/src/kickdrum.ts` `PARAM_TABLE`, and `art/scenarios/kickdrum/profile.test.ts:24-28` states
  the `.sha` covers *"the worklet entry AND every -dsp lib"*, so the worklet edit forces an ART re-capture
  even though the `.f32` is byte-identical. The host-side source touches neither.
- New controls: **none** — `PARAM_TABLE` is exactly 25 rows == the def. Zero un-exposed DSP capability;
  stating that is the finding.
- Structural gate: 6 → **5**. VRT: kickdrum's linux pairs are already drained.

**tidyVco** — *the rack's one complete virtual-analog voice.*
- ⚠ **The draft's ranking and page rename are REJECTED.** They break
  `e2e/tests/faces-parity.spec.ts:415-440`, a dedicated regression block titled *"tidyVco tune-cluster
  regression (the owner control-loss report)"* which asserts `control-detune` and `control-oct2` visible in
  the **lane full face** and inside the **dock band `[data-face-page="oscillator"]"`**. The draft moved
  detune/oct2 to ranks 8-9 and renamed `oscillator` → `tone`: three simultaneous breaks, restoring exactly
  the state the test exists to prevent. Its justification was also invalid — it cited PF-7 (ranks 7-8 are
  invisible) to justify moving controls *out of* ranks 4-5 *into* 7-8, manufacturing the invisibility it
  claimed as evidence.
- **Corrected `order` — same six controls in the lane, re-ordered within:**
  `['cutoff','shape1','res','detune','oct2','pw','fold','env', 'shape2','mix','sub','sym','drive','track',
  'fatk','fdec','fsus','frel','atk','dec','sus','rel','width','level','hold']`.
  `cutoff` to rank 1 (the one control hot in **every** patch state, and the control a 303/VCS3 player
  literally rides). `pw` 2 → 6 on the DSP: `tidyOscSample` gates the pulse leg on `s > 0`
  (`tidy-vco-dsp.ts:453-457`) and both `shape` defaults are 0, so **`pw` is provably inert at spawn** — the
  compact tile ships a knob that does nothing until you move the knob beside it. `res` to 3 (on a diode
  ladder resonance is a *timbre* control: it compresses through the feedback limiter and drops the passband
  ~10 dB — the 303 squelch). **detune/oct2 stay at 4-5, inside the plate — the regression stays green.**
- **`pages` stay 5 and page ids are UNCHANGED** (`oscillator`, `wavefolder`, `filter`, `envelopes`,
  `output`). The wavefolder merge was fold-driven and the fold premise is false (§1). ⚠ **The rear's pinned
  `oscillator` group and the page id must remain in lockstep**; renaming the page without the group
  produces a derived band holding only fold/sym plus a stray appended 7-hole band, and the totality gate
  **will not catch it** (every port still renders exactly once, just in a wrecked order).
- **PF-9 clusters on the `envelopes` band**: `filter eg` (fatk/fdec/fsus/frel) vs `amp eg`
  (atk/dec/sus/rel). Today the **rear** teaches that split and the front hides it behind eight unlabeled
  A/D/S/R knobs — a ~14 px sub-header instead of an ~81 px band.
- **PF-0 — the batch's only functional bug, and it ships FIRST, in Batch A, at `hold`'s CURRENT rank 25 with
  no re-ranking.** `hold` is a MOMENTARY pad rendering as a LATCHING rotary. Four independent confirmations:
  `TidyVcoCard.svelte:236-244` is `onpointerdown → 1` / `onpointerup → 0` with pointer capture (the file's
  only `<button>`); the def's own doc says *"Momentary drone pad: pressed = the mono gate held high,
  released = note-off (no latch)"* (`tidy-vco.ts:327`); the DSP ORs it with the gate exactly like tomtom's
  strike (`packages/dsp/src/tidy-vco.ts:241`); and it sits in the worklet's `UNSMOOTHED` set because *"the
  pad's LEVEL is the event"*. It renders as a knob because the def declares **no `face.momentary`** and the
  gate is **silenced** by `'tidyVco:hold'` in `ACKNOWLEDGED_LATCHING` (`module-face-lint.test.ts:290`)
  justified as *"sample-and-hold ENGAGE"* — **factually wrong, there is no sample-and-hold in this module.**
  **Fix (2 lines + 1 assertion):** add `momentary: ['hold']`; **delete** `'tidyVco:hold'` from
  `ACKNOWLEDGED_LATCHING`; and add the systemic guard — **for every `ACKNOWLEDGED_LATCHING` entry, assert
  the param's authored `docs.controls[id]` does NOT match `/momentary|no latch|press(ed)?|while pressed/i`.**
  ~15 LOC, pure unit, zero CI cost, and it would have caught this on the day it was written.
  ⚠ **Do not promote `hold` into the lane plate.** There is zero precedent for a momentary `<Button>`
  inside the plate (tomtom ranks `strike` 9th, dock-only), and `laneBodyPlan`'s no-clip guarantee is derived
  entirely from knob-column geometry (42 px rows = 26 knob + 5 gap + 11 label).
- `oct2` (−1/0/+1) → **PF-1 `options`** (it is `-1..1 discrete`, so `looksLikeSwitch` never sees it — the
  card's Fader is equally uninformative, so the face would inherit rather than fix the weakest control).
- Rear: pin + rename the leading band to **`play`** with two clusters — `poly bus` and `mono (fallback)` —
  because derivation heads it `voice`, which says nothing, and the module's most consequential patch-time
  fact is that **poly wins the moment any lane is gated and the mono pair goes dead**
  (`tidy-vco-dsp.ts:878-888`). Keep `audioRate` exactly as audited (`cutoff_cv, pwm_cv, fold_cv, sym_cv`);
  **do not add back `res_cv`/`drive_cv`** — the worklet reads those first-sample-only.
- Glyph: **keep `waveform`** (the only DUAL binding in the set — param-derived core wave *plus* the live
  trace, and the only glyph that says something while a gated voice is silent).
- New controls: **none** (`PARAM_TABLE` is exactly 25 rows == the def; unison count, filter slope and sub
  waveform are all constants and all need DSP + an ART re-pin).
- Structural gate: **5, unchanged.** VRT: `face-tidyVco-{compact,dock}` **and `rear-tidyVco`** — all three
  have darwin *and* linux baselines committed, none exempt.

---

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

## 6. SEQUENCING + RISK

### Merge order

```
1.  Batch A   PF-0, PF-7, PF-8, PF-2, PF-4, PF-5, PF-9          (platform; PF-0 is a live bug)
2.  Batch A2  PF-1, PF-3, PF-10, PF-11                          (vocabulary; PF-11 = 5 ART .sha re-pins)
3.  dx7 PR 0  ◀ OWNER PREVIEW ────┐                             ┌─ 4.  Batch B (5 modules)
    dx7 PR 0b ◀ OWNER PREVIEW ────┤   run in parallel with ─────┤   5.  Batch C (cloudseed + PF-16)
    dx7 PR 1  (dsp messages)      │   the face batches          │   6.  Batch D (4 modules)
    dx7 PR 2  (PF-1/2/14/15)      │                             │   7.  Batch E (3 modules + PF-6f)
    dx7 PR 3  →  PR 4  →  PR 5  → PR 6                          └─  8.  Batch F (3 modules)
9.  PF-6 face.actions (proper M platform PR) → migrate the PF-6f fallbacks onto it
10. Deferred DSP params, one PR each; the glyph wave (tail/response/levels/strings/transient)
```

**Owner decision before step 3:** combine PR 0 and PR 0b into one preview? They audition together and share
the same ART re-authoring pass, so combining saves one full ART cycle; keeping them separate preserves
bisectability if a spectral regression appears. **Criterion: combine if the owner is auditioning both in one
sitting anyway; split if either might be rejected independently.**

### Owner preview required (never auto-merge)

| PR | why |
|---|---|
| **dx7 PR 0** | audio changes for 14 algorithms; **two built-in voices** (HARMONICA alg 19, MARIMBA alg 8) change; saved racks on those algorithms sound different |
| **dx7 PR 0b** | envelope + fixed-frequency law — audio changes for **every** dx7 patch |
| **dx7 PR 6** | major new visual surface |
| **reverb `diffusion`** | Faust rebuild — the one thing in the face program that can move audio |
| **every glyph-kind PR** | look-affecting (`video-aspect-resolution-review-before-merge` extends to any look-affecting change) |
| **PF-8, PF-1 persistent readout** | move dock baselines across ~17 faces |

### Contract-lock

| PR | lines | what |
|---|---|---|
| dx7 PR 5 | +1 | `feedback` param |
| dx7 PR 6 | +2 | `dx7-operator-map`, `dx7-op-detail` families |
| qbrt | +1 | `ping … edge=trigger` (`contract-lock.txt:2541`) |
| lfo | +1 | `clock … edge=trigger` (`:1500`) |
| adsr | +1 | `gate … edge=gate` (`:40`) |
| delay | +1 | `time_cv_amt` |
| reverb | +1 | `diffusion` (**not +2** — `room` rejected) |
| cloudseed | +11 | 10 curve `linear`→`discrete`, +1 family |
| PF-6f fallbacks | +1 each ×5 | karplus, sixstrum, qbrt, kickdrum, snaredrum (**0 if PF-6 lands first**) |
| **total** | **~24** | across ~8 `task docs:accept` runs |

`contract-lock.txt` is a top conflict surface. **After every merge run `flox activate -- task
pr:conflict-sweep`; never `gh pr update-branch` on it** — it silently drops additions. On conflict, take
main + re-run `task docs:accept`; never hand-merge.

**Contract-transparent by construction** (verified: `serializeModuleContract`, `contract-signature.ts:91-129`,
has no `face`/`docs`/label branch, and `contract-lock.txt` contains **zero** `face` lines): every
`face.*` edit; every `docs` edit; `PortDef.label`; `ParamDef.options` (**decision: do not extend the param
line**); `ParamDef.format`; `ParamDef.landmarks`; `ControlFamily.label`; `ModuleFacePage.clusters`;
`face.actions`; `face.paramCells`; the new glyph literal.

### Attest — **NIL for this entire program**

All 17 modules are **audio** defs, so none is in the WebGL attest basis (`resolveWebglBasis` covers
`lib/video/**`, webgl-context `.svelte` cards, cube/hypercube/wavesculpt) — **no `docs-hash-ignore` markers
are required on any def here**, and no GPU re-attest. `graph/types.ts`, `lib/ui/workflow/**`,
`lib/ui/controls/**`, `ModuleShell.svelte`, `packages/dsp/src/dx7.ts` and `packages/dsp/src/cloudseed.ts`
are in **neither** the collab basis nor the grand basis (`packages/dsp/src/cloudseed.ts` is not under
`packages/dsp/src/lib`).

**Three ways to break that accidentally — all avoidable:**
1. appending a driver in **`e2e/tests/_drivers.ts`** (every append flips the collab hash);
2. editing **`e2e/tests/_helpers.ts`** or `_collab-helpers.ts` (in the collab basis) for the PF-16 tab-walk —
   **keep that rework inside `faces-parity.spec.ts` itself**;
3. putting the dx7 stamp helper in **`packages/web/src/lib/graph/mutate.ts`** (collab basis).

### ART

| module | pin | face edit costs a re-pin? |
|---|---|---|
| **dx7** | **none — zero `.sha` files exist**; six threshold specs | **N/A — PR 0/0b must RE-AUTHOR `algorithm-spectra`, `preset-spectra`, `spectral-audit`, `envelope`** |
| **delay** | `docsStrippedRepoSourceSha('.../modules/delay.ts')` | **YES today** — `face:` is inside the hash. **PF-11 fixes it once**, then free forever. Same for scaler/polarizer/illogic/depolarizer. |
| reverb | `dspSourceSha('reverb.dsp')` | no (yes only for `diffusion`; `.f32` must be byte-identical — verify from a clean dist with a real `task dsp:build`) |
| filter · mixer | `dspSourceSha(...)` | no |
| cloudseed | tolerance test, no pin | no |
| kickdrum · snaredrum | `.sha` covers the worklet entry **and every -dsp lib** | no — **provided the audition stays host-side** |
| tidyVco · adsr · vca · lfo · shimmershine · karplus · tomtom · sixstrum · qbrt | worklet/dsp `.sha` or none | no (deferred new params each need their own) |

Repo rule: regenerate the `.sha` **LAST** and confirm **only** `.sha` moved, never `.f32`.

### VRT

**Drain BEFORE dispatch, always** (`vrt-update.yml`). A scene still in `EXEMPT_BASELINE_PAIRS` is
`test.skip()`-ed **unconditionally**, so `--update-snapshots` writes nothing for it and the dispatch comes
back green having captured zero baselines.

| batch | pending linux pairs to drain (`vrt-exemptions.ts`) |
|---|---|
| B | `linux/face-qbrt-{compact,dock}` (`:1013-1014`) |
| C | none (batch-3 already drained) |
| D | `linux/face-shimmershine-{compact,dock}` (`:1011-1012`) — or leave exempt and go darwin-only |
| E | `linux/face-{snaredrum,tomtom}-{compact,dock}` (`:1007-1010`) |
| F | `linux/face-sixstrum-{compact,dock}` **+ `linux/rear-sixstrum`** (`:1005-1006, 1016`) |
| dx7 | **none — keep `linux/face-dx7-{compact,dock}` exempt** (`:1003-1004`); darwin regenerates locally |

Procedure: remove the pairs **and lower the vrt-meta linux-deficit ratchet by the same count in the SAME
commit**; push; **then** dispatch `gh workflow run vrt-update.yml -f ref=<branch> -f platform=linux`
**unscoped** — `-f grep=…` dies as `startup_failure`. The bot's push lands follow-on runs in
`action_required`, not `queued` — approve them.

**Structural page-count edits** (`e2e/vrt/workflow-shell-faces.spec.ts` FACES table, `:42-64`):
dx7 4→**4** (none) · qbrt 2→2 · vca 1→1 · lfo 2→**1** · delay 2→**1** · reverb 2→**1** · cloudseed 8→8 ·
shimmershine 3→**2** · adsr 1→1 (**but the `.page-label` text assert at `:117` moves**) · mixer 2→**1** ·
filter 2→2 · tomtom 4→**2** · karplus 3→**2** · snaredrum 5→**4** · sixstrum 6→**5** · kickdrum 6→**5** ·
tidyVco 5→5.

### CI wall-time

`faces-parity`'s **measured** cost is ~0.8 s/cell on CI; the 1.8 s figure in the spec is the *budget
ceiling*, not wall-time.

| | Δ cells | Δ wall-time |
|---|---|---|
| dx7 | 10 → 13 | +2.4 s |
| Batch B | qbrt +1, delay +1, reverb +1 | +2.4 s |
| Batch C | 46 → 47 + ~8 tab clicks | +0.8 s + ~1.6 s |
| Batch D | 0 | ~0 |
| Batch E | karplus +1, snaredrum +2 | +2.4 s |
| Batch F | sixstrum +1, kickdrum +1 | +1.6 s |
| **total** | | **≈ +11 s** |

Well under the 2-minute sign-off threshold — **state it in every PR body anyway** and **confirm on CI, not
locally**: cloudseed is the budget-setting row and CI runs SwiftShader at ~4× the local per-cell cost.

### Per-PR verification gate (CLAUDE.md, non-negotiable)

```sh
flox activate -- task test:one -- module-face-lint      # order/pages/momentary/paramCells completeness
flox activate -- task test:one -- rear-card-model       # ⚠ pins tidyVco/kickdrum/adsr/vca/lfo/cloudseed
flox activate -- task test:one -- curated-face          # ⚠ PF-7 moves the synthetic pin at :68
flox activate -- task test:one -- shell-cells           # no inert cells on a promoted face
flox activate -- task test:one -- module-docs-lint      # STRICT_DOCS completeness + family testid grep
flox activate -- task docs:check                        # contract golden, read-only
REPEAT=3 flox activate -- npx --workspace e2e playwright test faces-parity --grep <module>
REPEAT=3 flox activate -- task e2e:one -- workflow-shell-faces
REPEAT=3 flox activate -- task vrt:one -- <module>      # inspect the PNG diff
flox activate -- task typecheck                         # svelte-check is stricter than vitest
```
Plus `task art:one -- <module>` for delay / reverb / dx7. Every new or seriously changed test **3× in a row**.

### The three surfaces the drafts systematically missed — check them every time

1. **`e2e/tests/faces-parity.spec.ts:415-440`** — the tidyVco tune-cluster regression, named after an owner
   control-loss report. It pins specific ranks *and* a specific dock band id.
2. **`e2e/tests/workflow-shell-faces.spec.ts:116-117`** — adsr's page **id** and its `.page-label` **text**.
3. **`packages/web/src/lib/ui/workflow/rear-card-model.test.ts`** — `:55` tidyVco, `:120` kickdrum,
   `:158` adsr, `:182` vca, `:195` lfo, `:210` cloudseed. **Rear bands derive from `face.pages`**, so any
   page id/label/membership change moves these — and the totality gate will **not** catch a wrecked band
   order because every port still renders exactly once.

---

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

1. **Combine dx7 PR 0 and PR 0b into one preview?** Saves one full ART re-authoring cycle; costs
   bisectability. (§6)
2. **dx7 PR 0 changes the sound of saved racks** on 14 algorithms plus two built-in voices. Accept, or ship
   a per-node "legacy routing" opt-out? (Recommendation: accept — the table is simply wrong.)
3. **dx7 PR 0b changes the sound of every dx7 patch** (envelope shape + rate law). Accept, or draw this
   engine's envelope and drop the DX7-authenticity claim? (Recommendation: accept 0b.)
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

# FACE SPEC — `mixmstrs` (batch 6)

> **Two owner rulings, 2026-08-11, apply to this file** (verbatim at
> `rings.ts:585-590` and `:645-650`): *"we should prefer almost zero AI authored
> text, and all future faceplate work should reflect that"* and *"lets stop doing
> these and clean up the existing ones, get rid of them. lose the signal flow
> diagrams."* Every proposed `hint` and the `signal-flow` sidebar block have been
> **deleted** from §5/§9; their measured content is in §3/§6/§7. Do not re-author
> them. Measurements belong in `docs.controls` (the `rings.ts:592-596` precedent),
> not on the panel.

> ⚠ **SEQUENCING COLLISION — read before scheduling.**
> `.myrobots/stereo-audio-plan/plan.md` **PR-6 adds 8 per-channel pan params
> (`pan1..pan8`) plus a row of pan knobs to this module** (owner-decided; verified
> 2026-08-12 as NOT STARTED). That changes the param count this whole spec is
> written against, **re-ranks mixmstrs' generic push card** (no
> `PUSH_CARD_CONTROLS` entry — §11) and **re-pins the mixmstrs ART baselines**.
> **The two pieces of work collide and must be sequenced**, not run in parallel.

## 0. STATUS

**Authored 2026-08-11 against `main` at `52e3d882`. UNBUILT** — no `face:` block at
all (`grep -c '^  face:'` = 0).

**Verdict: PROMOTE — and it is the hardest face in the repo, by a factor of two.**
91 params, 111 input ports, 6 outputs, **219 lines of `contract-lock.txt`**. The
next-largest faced module is `pentemelodica` at 49 cells; `cloudseed` is 47, `cube`
28. mixmstrs is **91 cells, 1.86× the current maximum.**

archetype: **the console.** Eight stereo channel strips, two stereo aux sends with
a per-bus pre/post tap, two stereo return strips, one master.

In `STRICT_DOCS`. In `STRICT_VRT_MODULES` (`vrt-exemptions.ts:1053` — the *required*
`vrt-strict` gate, not the informational lane). In `DOCKABLE_TYPES`
(`dockable.ts:29`). **Not** in `PUSH_CARD_CONTROLS`. **Not** in
`card-range-source.test.ts`. `rack-sizes.ts:81` — `4u / hp 6`, 661×1080 px.

**THE HEADLINE: SIXTEEN of the ninety-one params are BIT-EXACTLY inert at the
factory default with every input driven — and a seventeenth and eighteenth are
inert until any send is opened. Separately, the host factory OVERWRITES three
per-channel params at every load, so a rack saved with a hand-set compressor comes
back 30.05 dB louder with the compressor bypassed.**

**Method.** REAL shipped Faust wasm (`packages/dsp/dist/mixmstrs.{wasm,json}`, the
exact bytes the browser ships) through `@grame/faustwasm`'s headless
`FaustMonoOfflineProcessor` — the same path `art/setup/faust-offline.ts` uses.
48 kHz, 128-sample blocks, 0.5 s renders, statistics over the tail half (so
`si.smoo` has settled). **Determinism control: two identical renders bit-equal on
all 14 outputs — `true`, on both passes.**

⚠ **THE FIRST PASS OF THIS MEASUREMENT WAS WRONG AND ITS OUTPUT LOOKED
AUTHORITATIVE.** Pass 1 drove only `ch1L`/`ch1R` and reported **75 of 83 params
bit-exactly inert**. Sixty-three of those were "the channel is silent", not "the
control is dead" — a metric blind to the dimension under test, returning a clean
number and a false headline. Pass 2 drives all twenty audio inputs (eight
decorrelated saw pairs + two noise returns) and the number is **18**. **On a module
with eight symmetric channels, any probe that feeds one channel measures the patch,
not the module.**

---

## 1. THE CONTRACT — every param and port

### 1a. Params — 91

**Per channel, N ∈ 1..8 — ten each, eighty total.**

| id | label | range | curve | default | units |
|---|---|---|---|---|---|
| `ch{N}_volume` | `{N}V` | 0 .. 1 | linear | **0.8** | — |
| `ch{N}_low` | `{N}Lo` | −12 .. 12 | linear | 0 | dB |
| `ch{N}_mid` | `{N}Md` | −12 .. 12 | linear | 0 | dB |
| `ch{N}_high` | `{N}Hi` | −12 .. 12 | linear | 0 | dB |
| `ch{N}_thresh` | `{N}Th` | −36 .. 0 | linear | **−12** | dB |
| `ch{N}_ratio` | `{N}Rt` | 1 .. 10 | linear | **2** | — |
| `ch{N}_compEnable` | `{N}Cp` | 0 .. 1 | **discrete** | 0 | — |
| `comp{N}` | `{N}Cm` | 0 .. 1 | linear | 0 | — |
| `ch{N}_send1` | `{N}S1` | 0 .. 1 | linear | 0 | — |
| `ch{N}_send2` | `{N}S2` | 0 .. 1 | linear | 0 | — |

**Bus — three.** `master_volume` (0..1 linear, **0.8**), `send1Pre` and `send2Pre`
(0..1 **discrete**, 0 = POST).

**Per return, R ∈ 1..2 — four each, eight total.** `ret{R}_volume`
(0..1 linear, **1.0** — unity, deliberately not the channels' 0.8),
`ret{R}_low/mid/high` (−12..12 linear, 0, dB).

80 + 3 + 8 = **91**. Ten are `0..1 discrete default 0` — the eight `compEnable`s
plus the two `sendPre`s — i.e. ten params `looksLikeSwitch()` sees. **Every one
needs an `ACKNOWLEDGED_LATCHING` entry** (they are latching, not momentary), which
is ten lines in a shared hand-maintained file (`module-face-lint.test.ts:357`) — the
single largest addition any face has made to that list.

### 1b. Ports — 111 in, 6 out

- **20 audio inputs**: `ch{1..8}L` / `ch{1..8}R`, `ret1L` / `ret1R`, `ret2L` /
  `ret2R`. Declared `stereoPairs` covers all ten pairs (`mixmstrs.ts:199-203`).
- **91 CV inputs**, one per param, `paramTarget` = the same id (`buildInputs()`,
  `mixmstrs.ts:180-191`). `cvScale: 'discrete'` for the ten discrete params,
  `'linear'` for the other 81.
- **6 audio outputs**: `masterL` / `masterR`, `send1L` / `send1R`, `send2L` /
  `send2R`. **None is declared in `stereoPairs`** — all three pairs resolve through
  the L/R token fallback in `stereo-pairs.ts`.
- **8 internal post-fader level taps** (Faust outputs 6..13) are NOT module ports.
  They feed the AnalyserNodes behind `read('levels') → number[8]`.

⚠ **Three stale comments — see §10-H.** The real counts are **91 params / 111
inputs**, and only **83** params are Faust UI params (the eight `comp{N}` macros
have no backing Faust slider).

---

## 2. AT SPAWN — measured

Every channel fed a decorrelated saw pair (110·N Hz left, ×1.003 right, 0.35
amplitude); both returns fed decorrelated noise at 0.25.

| output | value |
|---|---|
| `masterL` | rms **−4.91 dB**, peak **2.0923** |
| `send1L` / `send1R` / `send2L` / `send2R` | **bit-zero** (`−∞ dB`) |
| VU taps ch1..8 | 0.1329 0.1083 0.0908 0.0852 0.0935 0.1128 0.1264 0.1266 |

**The default state is already over full scale on a realistic patch** (peak 2.09
with eight decorrelated 0.35-amplitude sources) and **both aux sends are silent**,
because all sixteen send amounts default to 0.

---

## 3. THE EIGHTEEN THAT DO NOTHING — measured, with a two-sided control

Full sweep: every one of the 83 Faust params driven to `min`, `mid` and `max`,
`max|Δ|` taken against the default render over the six patchable outputs, with all
twenty inputs live.

| dependent | enabler (default) | `Δ` at the shipped default | `Δ` with the enabler open |
|---|---|---|---|
| `ch{N}_thresh` × 8 | `ch{N}_compEnable` / `comp{N}` (**0**) | **0.000e+0** | **1.150e-1** at `compEnable = 1` |
| `ch{N}_ratio` × 8 | `ch{N}_compEnable` / `comp{N}` (**0**) | **0.000e+0** | **7.437e-2** at `compEnable = 1` |
| `send1Pre` | any `ch{N}_send1 > 0` (all **0**) | **0.000e+0** | **3.214e-1** at sends 0.5 |
| `send2Pre` | any `ch{N}_send2 > 0` (all **0**) | **0.000e+0** | (identical construction) |

⚠ **THE PLATEAU AND THE FLOOR, BOTH, because bit-identity alone proves nothing.**
The plateau is the **entire declared range** — 36 dB of `thresh`, 9:1 of `ratio`,
both ends of both switches — rendering byte-for-byte identical output. The module's
**quantisation floor**, i.e. the smallest non-zero move any param on the module
makes over the same sweep, is **6.883e-2** (`ch5_compEnable`). So the inert plateau
is not "two adjacent values landed in one bucket": the smallest thing this module
can do at all is 6.9e-2, and these eighteen do **exactly 0.0** across their whole
travel. The negative control closes it from the other side — open `compEnable` and
the same two params move **1.15e-1** and **7.44e-2**, both *above* the module's own
floor.

**Sixteen of ninety-one faders are decoration at spawn**, and the module ships two
independent ways to wake them (`comp{N}`, the macro; `ch{N}_compEnable`, the manual
switch) with no surface saying either is required.

For scale, the top live movers at the shipped default: `master_volume` 2.107e+0 ·
`ch1_high` 8.439e-1 · `ch2_high` 8.413e-1 · `ch3_high` 8.386e-1 · `ch4_high`
8.360e-1 · `ch5_high` 8.333e-1.

---

## 4. THE RANKING — 91 params, a lane budget of six

| rank | key | tier | why |
|---|---|---|---|
| 1 | `master_volume` | mini | the one control a mixer always has a hand on, and measured the single largest mover (2.107e+0). |
| 2 | `ret1_volume` | compact | bus-wide, and the control that makes a PRE-fader send usable at all. |
| 3 | `ret2_volume` | plate | " |
| 4 | `send1Pre` | plate | bus-wide tap point. Ranked here *because* it is inert until a send opens — an enabler-adjacent control the panel must not hide. |
| 5 | `send2Pre` | plate | " |
| 6 | `ch1_volume` | plate | — *lane budget ends here* — |
| 7–13 | `ch2_volume` … `ch8_volume` | dock | |
| 14–21 | `comp1` … `comp8` | dock | the enabler for sixteen dependents; ranked immediately above them. |
| 22–29 | `ch{N}_send1` | dock | the enabler for `send1Pre`. |
| 30–37 | `ch{N}_send2` | dock | the enabler for `send2Pre`. |
| 38–45 / 46–53 / 54–61 | `ch{N}_low` / `_mid` / `_high` | dock | |
| 62–69 | `ch{N}_compEnable` | dock | the manual half of the enabler. |
| 70–77 / 78–85 | `ch{N}_thresh` / `_ratio` | dock | dependents. |
| 86–91 | `ret{R}_low/mid/high` × 2 | dock | |
| 92 | `mixmstrs-console-{n}` | dock (panel) | the picture — §9. |

**The rule the ranking follows, and the alternative it rejects.** Rank by **SCOPE**:
everything BUS-WIDE first, then per-channel, function-major. The property this buys
is the bluebox one — *every prefix of the ranking is a complete master section,
never a truncated channel bank.*

The obvious alternative — `master_volume` then `ch1_volume` … `ch5_volume` — makes
the 6-cell FULL plate look like a **five-channel mixer**. That is not a subset of an
eight-channel mixer; it is a different, wrong instrument, and a player who has
channels 6–8 patched sees no evidence they exist. mixmstrs is the inverse of
bluebox: a keypad has no priority ranking and every prefix is a keypad; a console
*has* a priority ranking and no prefix of the channel bank is a console.

⚠ **AND THE LANE TIERS STILL CANNOT REPRESENT THIS MODULE.** Rank 6
(`ch1_volume`) is a wart: it is the first per-channel control and there is no
principled reason it is channel 1 rather than any other. The honest fix — an
eight-fader mini-console **panel** in the lane tile — is **forbidden by
`module-face-lint`**: a `panel` cell may only be SELECTED at tier `dock`, and with
91 params ahead of it a panel's rank is 92, so it is dock-only by arithmetic as well
as by rule. The compromise is that the lane carries the `meter` glyph (which reads
`masterL`, the first `audio`-typed output — `shell-glyph-live.ts:95-97`) and the
console picture lives at the dock.

---

## 5. THE LAYOUT — five bands and eleven clusters, and what it sacrifices

**The constraint that decides everything: at seven or more bands the dock becomes a
TAB RAIL and exactly one band renders at a time.** On a mixer that is fatal for the
one thing the dock must do — *let you balance eight faders against each other.*

So the layout is **FIVE bands** (under the threshold, one scrolling column, every
band visible together) with membership grouped **by FUNCTION, not by channel**, and
the eight-channel structure carried by `clusters` inside each band — a ~14 px
sub-header instead of a ~81 px extra band (`graph/types.ts:502-507`: *reach for a
PAGE when the controls are a different IDEA; reach for a CLUSTER when they are the
same idea, twice*). Eight channels' LOW is the same idea eight times.

```ts
face: {
  title: 'Console',

  order: [
    // 1-6 = the LANE budget. Bus-wide first: every prefix is a complete
    // master section, never a truncated channel bank (see §4).
    'master_volume', 'ret1_volume', 'ret2_volume', 'send1Pre', 'send2Pre',
    'ch1_volume',
    // dock — ENABLER always above its DEPENDENTS
    'ch2_volume','ch3_volume','ch4_volume','ch5_volume','ch6_volume','ch7_volume','ch8_volume',
    'comp1','comp2','comp3','comp4','comp5','comp6','comp7','comp8',
    'ch1_send1', /* … ×8 … */ 'ch8_send1',
    'ch1_send2', /* … ×8 … */ 'ch8_send2',
    'ch1_low',   /* … ×8 … */ 'ch8_low',
    'ch1_mid',   /* … ×8 … */ 'ch8_mid',
    'ch1_high',  /* … ×8 … */ 'ch8_high',
    'ch1_compEnable', /* … ×8 … */ 'ch8_compEnable',
    'ch1_thresh',     /* … ×8 … */ 'ch8_thresh',
    'ch1_ratio',      /* … ×8 … */ 'ch8_ratio',
    'ret1_low','ret1_mid','ret1_high','ret2_low','ret2_mid','ret2_high',
    'mixmstrs-console-{n}',        // PANEL, rank 92 — dock-only by rule AND by arithmetic
  ],

  pages: [
    // FIVE bands. A sixth is affordable; a SEVENTH turns the dock into a tab
    // rail and destroys the only thing this face exists for (all eight faders
    // in one frame). That is the hard budget every future edit must respect.
    { id: 'levels', label: 'levels',
      controls: ['ch1_volume','ch2_volume','ch3_volume','ch4_volume',
                 'ch5_volume','ch6_volume','ch7_volume','ch8_volume',
                 'master_volume', 'mixmstrs-console-{n}'] },
    { id: 'eq', label: 'eq',
      controls: [/* the 24 EQ params */],
      clusters: [
        { label: 'low',  controls: ['ch1_low', /* …×8 */ ] },
        { label: 'mid',  controls: ['ch1_mid', /* …×8 */ ] },
        { label: 'high', controls: ['ch1_high', /* …×8 */ ] },
      ] },
    { id: 'dynamics', label: 'dynamics',
      controls: ['comp1', /* …×8 */ , /* + the 24 manual */],
      clusters: [
        { label: 'amount',    controls: ['comp1', /* …×8 */ ] },
        { label: 'enable',    controls: ['ch1_compEnable', /* …×8 */ ] },
        { label: 'threshold', controls: ['ch1_thresh', /* …×8 */ ] },
        { label: 'ratio',     controls: ['ch1_ratio',  /* …×8 */ ] },
      ] },
    { id: 'sends', label: 'aux sends',
      controls: [/* 16 sends + 2 pre */],
      clusters: [
        { label: 'send 1', controls: ['ch1_send1', /* …×8 */ , 'send1Pre'] },
        { label: 'send 2', controls: ['ch1_send2', /* …×8 */ , 'send2Pre'] },
      ] },
    { id: 'returns', label: 'returns',
      controls: [/* 8 return params */],
      clusters: [
        { label: 'return 1', controls: ['ret1_volume','ret1_low','ret1_mid','ret1_high'] },
        { label: 'return 2', controls: ['ret2_volume','ret2_low','ret2_mid','ret2_high'] },
      ] },
  ],

  glyph: 'meter',       // resolves to live-audio on `masterL` (the first audio out)

  hero: {
    cell: 'mixmstrs-console-{n}',
    control: 'master_volume',
    readouts: [
      { label: 'headroom', valueId: 'mixmstrs-headroom' },
      { label: 'asleep',   valueId: 'mixmstrs-comp-asleep' },
      { label: 'sends',    valueId: 'mixmstrs-send-state' },
    ],
  },

  sidebar: [ /* §9 */ ],
  rear:    { /* §8 */ },
}
```

**Cell arithmetic:** 91 params + 1 family = **92 cells**, all 91 param ids appearing
exactly once (`heroFacePlan` REMOVES `master_volume` and the panel from their bands
rather than duplicating them). `_shell-faces.ts` row:
`{ type: 'mixmstrs', pages: 5 }`. The `levels` band declares ten keys; the hero
promotes two of them out, leaving **eight rendered cells**, so no band empties and
the count stays 5.

### What this layout SACRIFICES, stated plainly

**The channel strip.** On the legacy card, channel 3's fader, EQ, comp and sends sit
in one vertical column and you read them together. Here they are in five different
bands and you read them by *scanning down the same column position*. The mitigation
is that every cluster holds exactly eight cells in channel order, so column N of
every cluster is channel N and the page reads as a **console grid — rows are
functions, columns are channels.** That alignment is load-bearing, and it is why the
EQ is three clusters of eight rather than one band of twenty-four
(`.page-controls` is flex-wrap; at the ~856 px `.faceplate-body` floor a 24-cell row
wraps at ~15 and the columns stop lining up).

**Vertical extent.** Five bands with eleven clusters is roughly
90 + 3×(14+56) + 4×(14+56) + 2×(14+56) + 2×(14+56) ≈ **860 px** of faceplate,
against `DOCK_BAND_PX = 90` for a plain single-row band. `.faceplate-scroll` is
`overflow:auto`, so it scrolls. The `levels` band is first precisely so the thing you
must see without scrolling is the thing you always need.

**The 720p read.** At the measured dock geometry only `levels` and part of `eq` are
above the fold. That is the correct trade: the alternative (eleven bands, tabbed)
puts *nothing* above the fold except one tab's worth.

---

## 6. DERIVED READOUTS — three facts no control on this module can show

All three are pure functions of the live params, which is what makes them
registerable under the params-only `FaceReadoutValue`.

### A. `mixmstrs-headroom` — the number ninety-one faders cannot add up

Prints the bus's worst-case (fully correlated) gain:
`Σ ch{N}_volume × master_volume`, as a multiplier and in dB. At the shipped default:
**5.12× · +14.2 dB**.

**MEASURED, and this is what anchors it:** eight correlated full-scale saws at the
defaults give `masterL` peak **5.1194** — 8 × 0.8 × 0.8 = 5.12 to four decimals. The
ladder, measured:

| channels fed | `masterL` peak |
|---|---|
| 1 | 0.6399 |
| **2** | **1.2799 — already over full scale** |
| 3 | 1.9198 |
| 4 | 2.5597 |
| 6 | 3.8396 |
| 8 | **5.1194** |

**TWO correlated full-scale sources already clip at the shipped defaults**, and
nothing in this module limits, soft-clips or compensates. Every fader says `0.80`
and none of them says that.

**NEGATIVE CONTROL — `ch1_thresh`:** must not move the readout by a hair (it is
bit-exactly inert at the default, §3). **SECOND LEG — `master_volume` 0.8 → 1.0:**
must scale it by exactly 1.25 (measured: peak 5.1194 → 6.3994, ratio 1.2500). A
readout that only ever went up with a channel fader would pass a one-sided test
while being blind to the master.

⚠ **Label it as a worst case.** It is the correlated bound; decorrelated sources sum
in power, not amplitude. Print `≤ 5.12× (+14.2 dB)`, never `is`.

### B. `mixmstrs-comp-asleep` — the module's own argument, counted

`2 × |{N : compEnable(N) < 0.5}|`, i.e. how many `thresh` + `ratio` faders are
currently doing nothing. At the factory default: **`16 asleep`**.

**NEGATIVE CONTROL — `ch1_volume`:** a level change wakes nothing; the count must
not move. **SECOND LEG — `ch1_compEnable` 0 → 1:** must read `14 asleep`, which the
measurement backs (`ch1_thresh` Δ 0.000e+0 → 1.150e-1, `ch1_ratio` 0.000e+0 →
7.437e-2, both above the module's 6.883e-2 floor). Both legs are required: a counter
that only ever went down would pass a one-sided test while being wrong about *which*
controls it was counting.

⚠ The macro complicates it and the readout must be honest: `comp{N} > 0` writes
`compEnable = 1`, so raising the macro *also* wakes the pair — while simultaneously
overwriting the values they hold (§7-A). The readout counts the live `compEnable`,
which is the truth of the DSP either way.

### C. `mixmstrs-send-state` — the tap point, and whether the bus is alive

`SEND 1 POST · silent  ·  SEND 2 POST · silent` at the factory default; flips to
`SEND 1 PRE · 3 ch` once a send opens.

**This is the readout that states the enabler pair.** `send1Pre` is **bit-exactly
inert** while every `ch{N}_send1` is 0 (measured max|Δ| 0.000e+0); open the sends to
0.5 and the same switch moves the output by **3.214e-1**. The switch is on the
panel, it clicks, it changes nothing, and no surface says why.

**NEGATIVE CONTROL — `send1Pre` alone, with every send at 0:** the readout must
report `silent` in *both* switch positions, because the DSP does. A readout that
merely echoed the switch would print `PRE` and imply something happened.
**SECOND LEG — `ch3_send1` 0 → 0.5:** must go `silent` → `1 ch`.

*(Measured PRE/POST behaviour: `ch1_send1 = 1`, `send1L` rms by fader position —
POST: −∞ / −22.83 / −12.73 / −10.79 dB at vol 0 / 0.25 / 0.8 / 1.0;
PRE: **−10.79 dB at every one of them**. That is the whole feature in one row.)*

---

## 7. FIVE MORE MEASURED FACTS

### A · THE COMP MACRO OVERWRITES A SAVED RACK AT LOAD — 30.05 dB of it

Source-level, `mixmstrs.ts:319-337`. The factory's init loop walks `PARAMS` **in
declaration order**, and `comp{N}` is declared *after* `ch{N}_thresh`,
`ch{N}_ratio` and `ch{N}_compEnable` (`buildParams`, `:126-131`). For a `comp` id it
calls `applyCompMacro`, which writes all three:

```js
for (const def of PARAMS) {
  const v = (node.params ?? {})[def.id] ?? def.defaultValue;
  if (def.id.startsWith('comp')) { compMacro[def.id] = v; applyCompMacro(def.id, v); continue; }
  params.get(`${PARAM_PREFIX}/${def.id}`)?.setValueAtTime(v, ctx.currentTime);
}
```

So the saved `thresh` / `ratio` / `compEnable` are written, and then
**unconditionally overwritten** by `mapCompMacro(comp{N})`. Every rack saved before
the macro landed has no `comp{N}` key at all, so it takes the default `0` →
`{ enable: 0, thresh: 0, ratio: 1 }`.

**MEASURED on the real DSP**, a 0.9-amplitude sine into ch1:

| | `masterL` rms | peak |
|---|---|---|
| what the rack SAVED (`thresh −30, ratio 8, enable 1`) | **−37.850 dB** | 0.0181 |
| what the factory writes at load (macro 0 → `en 0, thr 0, rat 1`) | **−7.803 dB** | 0.5759 |

**A rack saved with the compressor engaged loads 30.05 dB LOUDER, uncompressed.**

Three secondary consequences, all real:
- `ch{N}_thresh` and `ch{N}_ratio` **never hold their declared defaults** (−12 dB
  and 2). At spawn the Faust params are 0 and 1.
- The CARD still shows the saved value — `paramVal('ch1_thresh', -12)` reads
  `node.params`, which is untouched — while `readLive` reads the Faust param and
  returns 0. **The knob and its own motorized readback disagree**, silently.
- The def's docs say the manual params *"remain exposed … for power users who want
  manual control"* (`mixmstrs.ts:31-35`). True within a session, false across a save.

**A DEF/FACTORY bug, not a face bug, and it must NOT be fixed in a face PR** — it
changes the audio of every saved rack that used the compressor, so it is an
owner-audition PR of its own. The face's job is to make the state *visible* (§6-B).

### B · THE LOW AND HIGH SHELVES CUT ABOUT A THIRD OF WHAT THEY BOOST

`shelfGain(dB) = 10^(dB/20) − 1`; a band is `x + firstOrderFilter(x) · shelfGain`
(`mixmstrs.dsp:148-158`). That is a **complex sum**, so `|1 + H·g|` is not
`1 / |1 + H/g|` and the control is asymmetric everywhere except at the DC/Nyquist
asymptotes. Measured, ±12 on the knob:

| band | frequency | knob +12 | knob −12 |
|---|---|---|---|
| low | 25 Hz | +11.79 dB | −9.37 dB |
| low | 50 Hz | +11.10 dB | −6.01 dB |
| **low** | **100 Hz** (its own corner) | **+9.26 dB** | **−2.74 dB** |
| low | 200 Hz | +5.99 dB | −0.90 dB |
| high | 4 kHz | +5.60 dB | −0.79 dB |
| **high** | **8 kHz** (its own corner) | **+9.26 dB** | **−2.74 dB** |
| high | 16 kHz | +11.57 dB | −8.05 dB |
| high | 20 kHz | +11.90 dB | −10.71 dB |

**At its own design frequency a −12 dB shelf cuts 2.74 dB.** The MID band, built
from `fi.bandpass(2, 600, 1600)`, is nearly symmetric by contrast: +12.00 / −11.86 dB
at 1 kHz, with 0.59 dB and 0.75 dB of leakage from the low and high bands at the
same frequency. A face cannot fix this; it can decline to label the knob `±12 dB` as
though it were true, and it can name the three corner frequencies (100 Hz /
600–1600 Hz / 8 kHz), which no surface currently does.

### C · THE VU ROW IS A MONO-SUM TAP, SO IT READS CORRELATION, NOT LEVEL

`ch{N}Level = (ch{N}ML + ch{N}MR) * 0.5` (`mixmstrs.dsp:349-356`). Measured on ch1,
referenced to the dual-mono reading of the same source at the same level:

| source | VU tap | vs dual mono |
|---|---|---|
| dual mono (L = R) | 0.282827 | 0.00 dB |
| decorrelated noise L/R | 0.164093 | **−2.98 dB** |
| detuned pair (220 / 220.7 Hz) | 0.192533 | **−3.35 dB** |
| **anti-phase (L = −R)** | **0.000000** | **−∞** |

`masterL` and `masterR` are **unchanged** in every one of those cases (ratio
1.000000 between the in-phase and anti-phase renders). **So an anti-phase channel
carries full level into the master and its meter reads exactly zero.** This is the
module's own instrument being blind to the dimension it claims to measure —
CLAUDE.md's rule, in the shipped DSP. The face's hero must label the bars `Σ mono`;
the fix (stereo taps, +8 Faust outputs) is named as a future option in the `.dsp`
itself (`:277`).

### D · THE SEND BUS HAS NO MASTER TRIM

Measured, all eight channels fed a 0.5-amplitude saw:

| every send at | `send1L` peak | `send1L` rms |
|---|---|---|
| 0.25 | 0.7999 | −6.71 dB |
| 0.50 | **1.5999** | −0.69 dB |
| 1.00 | **3.1997** | +5.33 dB |

`s1OutL` is a bare sum of eight taps (`mixmstrs.dsp:336`) with **no bus gain
anywhere** — `master_volume` is on the master path only. The 91-param roster has no
`send1_volume`.

### E · THE RETURN STRIP'S `ba.if(flat, …)` BYPASS IS DEAD CODE

`returnChain` guards its EQ with `flat = (low==0)&(mid==0)&(high==0)` on the grounds
that *"a shelving/peaking biquad at 0 dB is only unity to within coefficient
rounding"* (`mixmstrs.dsp:228-234`). **Measured: false for this implementation.**
`shelfGain(0) = 10^0 − 1 = 0` exactly, so `eq3band(0,0,0,x)` is `x + filtered·0` —
bit-exactly `x`. Driving the same source through the CHANNEL path (EQ at 0 dB,
compressor bypassed, unity fader) and through the RETURN path (`ba.if` takes the dry
branch, unity fader) gives **bit-equal output, max|Δ| = 0.000e+0**. And `ba.if` is
`select2`, which evaluates both branches, so the guard saves no CPU either.
Harmless; worth deleting the next time that file is opened — not in a face PR.

*(For completeness, the return EQ's authority once engaged, measured on noise into
ret1: `ret1_low` +0.01 dB → Δ 0.0011 dB; +3 → +0.4668; +12 → +4.3025; −12 →
−0.4906. The same shelf asymmetry as §7-B.)*

---

## 8. THE REAR — and the ES-9 send/return rack

`rear-card-model.ts` renders **every declared port, one hole each, no elision**.
Stereo pairs collapse to one hole (`RearHole.stereoSiblingPortId`), so: **20 audio
inputs → 10 holes**, **91 CV inputs → 91 holes**, **6 outputs → 3 holes** — **104
holes**. mixmstrs has no `face.rear` today, so all of it falls to the default
derivation.

**With the §5 pages the derivation is already right**, and that is a reason to
prefer those pages over per-channel ones: the CV holes for `ch{N}_low/mid/high` land
in the `eq` band, the sixteen send CVs in `sends`, and so on. A curated `face.rear`
is then needed only for two things:

```ts
rear: {
  groups: [
    { id: 'signal', label: 'channel inputs · ch1 … ch8',
      ports: ['ch1L','ch2L','ch3L','ch4L','ch5L','ch6L','ch7L','ch8L'] },
    { id: 'returns', label: 'aux returns · wet back from the sends',
      ports: ['ret1L','ret2L'] },
  ],
  clusters: [
    { group: 'signal', label: 'stereo pairs — one hole per pair', ports: [/* … */] },
  ],
}
```
*(List the FIRST member of each collapsed pair; the sibling rides the same hole.)*

### The ES-9 interaction — and it is the reason this module's rear matters

The owner's real rack, pinned verbatim in three places
(`packages/web/src/lib/graph/per-leg-patching.test.ts:5-19`,
`e2e/tests/es9-per-leg-patching.spec.ts:8-22`,
`packages/web/src/lib/ui/port-patch-helpers.ts:61-68`), is **eight mono cables
between mixmstrs and the ES-9**:

```
mixmstrs.send1L → es9.out3      es9.in14 → mixmstrs.ret1L
mixmstrs.send1R → es9.out4      es9.in13 → mixmstrs.ret1R
mixmstrs.send2L → es9.out5      es9.in11 → mixmstrs.ret2L
mixmstrs.send2R → es9.out6      es9.in12 → mixmstrs.ret2R
```

`in14`→**L** with `in13`→**R** is reversed and `in11/in12` is non-adjacent —
physical holes chosen by hand, explicitly not to be normalised.

**Three consequences for this face, all load-bearing:**

1. **The face must NOT break per-leg patching.** `stereo-pairs.ts`'s
   `MONO_AUDIO_POINT_MODULES` contains exactly one entry (`es9`), and
   `stereo-autowire.ts:276-306`'s mono-audio-point trim runs *after* the
   `channelMode` filter so "patch only R" into an ES-9 jack writes the R leg rather
   than nothing. Nothing in a `face` touches that path — `ModuleFaceRear` only groups
   and labels — but a `rear.groups` entry that listed `send1L` and `send1R` as
   separate holes would fight the collapse. **List one member per pair.**
2. **The rear band labels are the only place the send/return topology can be
   named.** The derivation would file `send1L/R` into a generic OUTPUTS rail beside
   `masterL/R`; on a console the sends are a different *kind* of output.
3. **`send1Pre` is the control that makes the ES-9 return usable**, and it is one of
   the eighteen inert-at-default params (§3). A player who wires the eight cables
   above, mutes a channel and expects the hardware reverb to ring on gets silence
   until they both open a send *and* flip PRE. §6-C is that fact as a readout, and
   **it is the single strongest argument for this face.**

⚠ The browser's 2-channel `getUserMedia` ceiling
(`.myrobots/plans/es9-recorderbox-2026-08-01.md:247` — `getCapabilities().channelCount`
returns `{max: 2}` against a real ES-9 in Chrome) is *why* every one of those eight
legs is a separate mono cable. It does not constrain the face; it explains why the
rear is the surface that matters.

---

## 9. THE PICTURE

**`mixmstrs-console-{n}` — a `ShellPanelCell` promoted into the hero.** Eight bars
from `read('levels')` (the real post-fader taps), each with its fader position
marked, plus the master. Three things only this can show:

- the **bars are captioned `Σ mono`**, because they are (§7-C) — a channel whose
  meter reads zero while the master carries it is otherwise undiagnosable;
- the **tap point** drawn on each strip, moving between after-fader and before-fader
  as `send{N}Pre` flips — the feature's whole mechanism, currently described only in
  a `title=` tooltip;
- the **headroom bar** across the top, red past 1.0, anchored on §6-A.

Probe (required, `ShellPanelProbe`): a `text` effect on a *different* testid — the
panel's channel-label row against its scale-toggle button, the bluebox/cofefve
pattern. **Never `data-rev`: a revision counter passes on a dead button.**

**Sidebar** — the `signal-flow` block is deleted per the 2026-08-11 ruling. What
remains:

```ts
sidebar: [
  { kind: 'readouts', label: 'enabler -> dependents', entries: [
    { label: 'COMP = 0',   text: 'THRESH + RATIO are inert (16 faders)' },
    { label: 'SENDS = 0',  text: 'the PRE/POST switch is inert' },
    { label: 'VU bars',    text: 'mono sum — an anti-phase channel reads 0' },
    { label: 'headroom',   text: 'two hot channels already clip' },
  ] },
  { kind: 'presets', label: 'openers', entries: [
    { id: 'unity',  label: 'unity gains',  values: { /* all faders 1.0, master 0.5 */ } },
    { id: 'aux',    label: 'both sends open', values: { ch1_send1: 0.4, /* … */ send1Pre: 1 } },
    { id: 'glue',   label: 'gentle glue',  values: { comp1: 0.4, /* …×8 */ } },
  ] },
]
```

⚠ The `presets` block is doing real work, exactly as on cofefve: **two of the three
enabler families open with one click each**, and a preset applies through the
ordinary param write path (real undo, real sync).

⚠ The surfaces that paint unconditionally are the **hero readouts**, the **hero
picture's captions** and the **sidebar** — everything load-bearing lives there.

---

## 10. ALREADY-WRONG — ordered by cost to a user

- **A · the comp macro clobbers a saved compressor at load, measured 30.05 dB**
  (§7-A). **Its own PR, owner audition, saved-rack audio change.**
- **B · sixteen faders are bit-exactly inert at the factory default** (§3), with no
  surface saying so. The face is the fix; **the *defaults* question — should
  `compEnable` ship at 0 when `thresh`/`ratio` ship at usable values? — is
  explicitly the OWNER'S call.**
- **C · the two PRE/POST switches are inert until a send opens** (§3, §6-C) — **and
  they are the controls the owner's ES-9 rack depends on.**
- **D · the VU row is blind to an anti-phase channel** (§7-C). A DSP change
  (+8 outputs) or a labelled bar; the face can only label.
- **E · the LOW/HIGH shelves cut ~2.7 dB where the knob says −12** (§7-B).
- **F · two hot channels clip the bus at the shipped defaults** (§6-A); nothing
  limits and the master fader cannot exceed 1.0.
- **G · the send bus has no trim and reaches peak 3.1997** at eight sends open
  (§7-D).
- **H · three stale counts in comments — ALL THREE CONFIRMED STILL OPEN**:
  `mixmstrs.ts:10` *"81 AudioParams"*, `MixmstrsCard.svelte:63` *"101 inputs"*, and
  `mixmstrs-sections.ts:7` *"101 inputs"*. **The truth is 91 / 111.**
- **I · `MixmstrsCard.svelte` re-types every range as a literal** — 8 channels × 10
  knobs plus the returns and master — while importing `mixmstrsDef`, and mixmstrs is
  **CONFIRMED not in `card-range-source.test.ts`**. **This is the largest un-gated
  card/def divergence surface in the repo.** Bind it through `paramSpec()` and enrol
  it in the SAME PR that touches the card, per the boy-scout precedent every recent
  face PR followed.
- **J · the return `ba.if(flat)` bypass is provably a no-op** (§7-E).

---

## 11. COST

| | |
|---|---|
| **contract-lock** | **+1 line** for the `mixmstrs-console` panel family. The 91 params and 111 ports are already pinned; `face` is contract-transparent. |
| **`ACKNOWLEDGED_LATCHING`** | **+10 entries** (8 `compEnable`, 2 `sendPre`) in `module-face-lint.test.ts:357`. The largest single addition to that list; each needs its own `why`. |
| **shared registries** | `strict-faces.ts`, `e2e/vrt/_shell-faces.ts` (`{ type: 'mixmstrs', pages: 5 }`), `shell-cells.ts` (the console panel + probe), `face-readout-values.ts` (3 `valueId`s), `card-range-source.test.ts` (§10-I). |
| **VRT** | +`face-mixmstrs-{compact,dock}` = **2 baselines** (one set since #1458, authored by linux CI — never commit one). ⚠ The existing `vrt.spec.ts/mixmstrs.png` is in **`STRICT_VRT_MODULES`**, so any card edit moves a REQUIRED baseline, not an informational one. |
| **e2e** | +1 `faces-parity` row at **92 cells**. Derived budget `FACE_FIXED_MS + FACE_PER_CELL_MS × cells` = 30 000 + 600×92 = **85.2 s** (45 000 + 1 800×92 = **210.6 s** under `SLOW_RENDER`), against pentemelodica's 59.4 s / 133.2 s today. **≈ +85 s on one shard — OVER the ~2 min flag threshold when the slow-render lane is counted, so it needs the sign-off CLAUDE.md requires.** |
| **ART** | mixmstrs has three scenarios (`passthrough`, `prefader-sends`, `profile`). A face touches none; §10-A would re-pin all three and must not ride along. ⚠ **So would stereo-plan PR-6** — see the collision note at the top. |
| **Push 2** | No `PUSH_CARD_CONTROLS` entry, so the card is generic-tier over 91 params — its eight push controls are whatever the generic ranker picks and **will silently re-rank on any param edit, which stereo-plan PR-6 is.** Give it an explicit entry in the same PR. |
| **the bottom line** | The most expensive face in the programme and the one with the most to say. Its argument is not curation — a mixer's controls are self-explanatory — it is that **eighteen of its ninety-one controls are asleep, its meters are blind to phase, its bus clips at two channels, and its compressor forgets itself every time you reload the rack**, and not one of those five facts is visible anywhere today. |

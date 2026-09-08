# Docs review + Monome-module restore — design

**Date:** 2026-07-18
**Author:** docs-systems + controller-integration architect (design only — no source changes)
**Scope:** (1) an honest review of the living-docs system + the clip-player doc page and a
concrete restructure proposal; (2) a spec to restore MONOME as a first-class module analogous
to the Launchpad; (3) a phased plan with effort, risks, and owner questions.

This is DESIGN ONLY. Nothing below was built. All paths are absolute-from-repo-root.

> **RE-VERIFIED 2026-08-12 — STILL UN-BUILT AND STILL THE LIVE SPEC.**
> §2's central asymmetry is unchanged: `packages/web/src/lib/meta/modules/`
> contains `launchpad-control.ts`, `push2-control.ts` and `electra-control.ts`,
> but **there is still no monome module def** — no `MonomeControlCard.svelte`, no
> `MonomeDocs.svelte`, no `/docs/modules/monomeControl` route. The monome remains
> a bare adapter under `lib/control/monome` reachable only through the clipplayer
> card's GRID button, exactly as §0.4 describes. None of Phases 1–3 shipped.
> Three controllers are now first-class (Push 2 and Electra shipped in the
> interim), which strengthens §2.3's file-for-file argument — there are peers to
> pattern-match against, not one. Re-check §0's file:line citations against the
> tree before building; the clip-player surface has changed a great deal since
> (scene repeats **#1091**, SHIFT hold-only **#1094**, card parity **#1100**,
> SONG MODE **#1099**).

---

## 0. Ground truth (what the code actually is, file:line-verified)

### 0.1 The living-docs system — three tiers, one contract
(`CLAUDE.md` "Living docs" + `packages/web/src/lib/docs/`)

- **GENERATED** — `io-explain.ts` turns each `PortDef`/`ParamDef` into a fixed human
  sentence (cable-type label, cv-scale mode, edge semantic, stereo normaling). The I/O
  tables on a module page are rendered from this and can never drift from the def; the drift
  gate (`module-manifest.test.ts`) fails CI if any port/param produces an empty explanation.
- **AUTHORED** — co-located `docs: { explanation, inputs, outputs, controls }` +
  `controlFamilies[]` on the def itself (so a port change and its doc edit land in one diff).
  `clipplayer` is a heavy example: `packages/web/src/lib/audio/modules/clipplayer.ts:155-228`
  (a ~1-screen `explanation`, per-output/per-input strings, and 9 control families).
- **PINNED** — `contract-lock.txt` is the ONLY committed living-docs artifact;
  `module-docs.generated.ts` is a gitignored build artifact. Gates: `contract-lock.test.ts`,
  `module-docs-ensure.test.ts`, `module-docs-lint.test.ts`. Accept loop = `task docs:accept`.
- **STRICT_DOCS** ratchet (`strict-docs.ts`) — `clipplayer` is in it (line ~234), so every
  clipplayer port/param/family MUST carry authored docs.
- **Attest hashing** — no longer a concern for docs at all: `scripts/attest-code-basis.ts`
  strips comments and a def's `docs`/`controlFamilies`/`face` from every attest basis, so
  documentation is free to write anywhere. *(This section originally described the
  `docs-hash-ignore` marker discipline, deleted repo-wide 2026-08-09.)*

### 0.2 How a module doc PAGE renders
- **Catalog** `/docs/modules/+page.svelte` — auto-built from `buildModuleManifest()`, which
  globs ONLY `audio/modules/*.ts` (video defs are gated+authored but have no `[id]` page).
  It also renders a hand-maintained **"guides & hardware"** section from
  `module-guides.ts:GUIDE_PAGES` (the walkthrough pages that have no module def).
- **Auto `[id]` page** `/docs/modules/[id]/+page.svelte` — the 2-column interactive explorer
  (live/virtual card LEFT, hover pane RIGHT), then GENERATED I/O tables, params, controls,
  source, prev/next. It shows `docs.explanation` (`:76-78`) and — if
  `module-guides.ts:MODULE_GUIDES[type]` exists — a prominent **"Full guide"** callout
  (`:80-89`).
- **Custom static routes win over `[id]`** (SvelteKit precedence). Relevant ones:
  - `/docs/modules/launchpadControlLeft/+page.svelte` → renders `LaunchpadDocs.svelte`
    (the GOLD STANDARD). This slug equals the Launchpad module's TYPE, so right-click card →
    "View docs" lands here directly.
  - `/docs/modules/grid-clip-launcher/+page.svelte` → a hand-authored CLIP-PLAYER + monome
    guide. **`grid-clip-launcher` matches no module type** — it's an orphan slug reachable
    only via `MODULE_GUIDES.clipplayer` and the catalog's guides section.
  - `/docs/modules/clipplayer` → the auto `[id]` page (clipplayer IS in the audio glob).

### 0.3 The controller-agnostic core + the two adapters
- **Shared brain** `packages/web/src/lib/control/clip-surface-map.ts` — placement-free:
  clip-index↔(slot,lane) math, edit-mode pitch/step math, length-edit classifier, and the
  per-cell LED *decision* helpers as 0-15 varibright levels (`LED_LOADED=6`, `LED_PLAYING=15`,
  …). Its header states the intent: "the monome + both Launchpads are thin adapters over ONE
  brain."
- **Monome adapter** `control/monome/monome-map.ts` — supplies ONLY the 16×8 placement +
  re-exports the shared brain; LEDs are **brightness levels** (no colour).
- **Launchpad adapter** `control/launchpad/launchpad-map.ts` — supplies the 8×8×2 placement
  + the **RGB colour language**, defers every decision to the brain.
- Bindings: `monome/monome-control.svelte.ts` (session/edit/lengthEdit; per-machine
  localStorage binding) and `launchpad/launchpad-control.svelte.ts` (far richer — single-mode
  4-view rework, KEYS, scene repeats, arm map, per-lane deck).
- Devices: `monome/monome-device.svelte.ts` (WebSerial + `mext.ts` codec + simulated-grid
  test hook) and `launchpad/launchpad-device.svelte.ts` (WebMIDI).

### 0.4 The asymmetry that IS the "lost monome"
- **Launchpad = a first-class module.** `packages/web/src/lib/meta/modules/launchpad-control.ts`
  (`launchpadControlDef`, `type: 'launchpadControlLeft'`, `domain: 'meta'`, palette `Hybrid`,
  `card: 'LaunchpadControlCard'`, `size: '1u'`, no I/O) → you drop it on the canvas; it binds a
  `clipplayer`. It has a card (`ui/modules/LaunchpadControlCard.svelte`), a first-class tabbed
  doc, and `MODULE_GUIDES`/`GUIDE_PAGES` entries.
- **Monome = NOT a module.** There is no `meta/modules/monome-control.ts`, no
  `MonomeControlCard.svelte`, no monome-owned doc. The monome is reachable ONLY through the
  clipplayer card's **"GRID"** button (`ui/modules/ClipplayerCard.svelte:893`, calling
  `bindGridToClip(id)` at `:128`). Its binding/device/map/tests all exist and work — it is
  already a clean thin adapter over the shared core — but it was **never promoted** to the
  first-class module status the Launchpad got in the #832→#1069 arc. Its only doc is the shared
  `grid-clip-launcher` page.

**So "monome was lost" = the monome never became a peer module of the Launchpad, and its docs
never got their own home.** The logic is intact; the *packaging* and the *docs* fell behind.

---

## 1. DOCS REVIEW

### 1.1 The living-docs system — assessment (it is good; keep it)
The GENERATED/AUTHORED/PINNED split is genuinely strong: the I/O tables cannot drift, the
authored prose lives on the def, and the contract golden makes a silent contract change fail
CI. The `MODULE_GUIDES` callout + `GUIDE_PAGES` section are the right seam for hand-written
walkthroughs that the audio-glob catalog can't see. Nothing here needs re-architecting.

Two *system-level* gaps this review surfaces (both addressed by the proposal, not blockers):
1. **Control-surface modules are second-class in the doc model.** The catalog globs only
   `audio/modules`, so `meta` modules (Launchpad, and a future Monome) get NO auto page and
   depend entirely on a hand-authored static route + a `GUIDE_PAGES`/`MODULE_GUIDES` entry.
   That's fine — but it means "which controllers drive module X" is not expressible in the
   generated layer; it must be authored. There is no "controllers" concept in the doc IA.
2. **A module driven by N controllers has no canonical map from the module to those docs.**
   `clipplayer` is driven by the card, a monome, and 1–2 Launchpads, but a reader lands on ONE
   guide (`grid-clip-launcher`) that happens to be monome-centric, and the Launchpad doc is a
   sibling with no cross-link. The "one module, many surfaces" relationship is invisible.

### 1.2 Why the clip-player doc is confusing — root causes
`LaunchpadDocs.svelte` is the quality bar; the clip-player experience falls short of it for
five concrete reasons:

1. **Fragmented across three pages with three unrelated slugs, and "View docs" lands on the
   driest one.** Right-clicking the clip-player card → "View docs" opens
   `/docs/modules/clipplayer` — the AUTO reference (faceplate + port/param tables first). The
   rich operator guide is a *different* URL (`grid-clip-launcher`), and the Launchpad guide is a
   *third* (`launchpadControlLeft`). A newcomer meets port tables, not the mental model.

2. **The one rich guide is named and structured around the monome, but is really three
   documents in one scroll.** `grid-clip-launcher/+page.svelte` interleaves (a) controller-
   NEUTRAL content — the mental model, the card, editing concepts, song mode — with (b)
   monome-SPECIFIC hardware — "Connecting a monome grid", the 16×8 layout diagram, brightness
   LED levels, the exact session/edit/length pad coordinates — and (c) song mode. A Launchpad
   user (or a card-only user) has to wade through monome pad addresses that don't apply to them,
   and a monome user has to hunt for the hardware bits between the neutral sections. There is no
   "pick your controller" fork.

3. **Stark asymmetry between the two controllers.** The Launchpad has a polished, tabbed,
   live-constant-driven standalone doc (`LaunchpadDocs.svelte`, ~1900 lines, "1 Launchpad" /
   "2 Launchpads" tabs, per-view sub-tabs, colour legends generated from the firmware RGB). The
   monome has a handful of inline `<section>`s inside a page it shares with the clip player. Same
   underlying brain, wildly different doc treatment — which reads as "the monome is an
   afterthought."

4. **Naming/discoverability mismatch.** The slug `grid-clip-launcher` matches neither the module
   type (`clipplayer`) nor its label ("clip player"); nothing in the URL says "clip player." The
   guide-callout title — "Clip launcher, monome grid & song mode"
   (`module-guides.ts:24`) — buries the controller-neutral material behind "monome grid," so a
   Launchpad user may not realize this is *their* guide too.

5. **No controllers hub and no cross-links.** Nothing lists "here is everything that can drive
   the clip player" (card / monome / Launchpad ×1-2 / any keyboard or Electra via MIDI-learn).
   The clipplayer page doesn't point at the Launchpad doc; the Launchpad doc doesn't point back
   at the clip-player concepts or the monome; the monome content doesn't point at the Launchpad.
   Each surface is a dead-end.

### 1.3 Restructure proposal — information architecture
Adopt a consistent **overview → controllers → card UI → per-mode reference** shape, with the
clip-player page's TOP linking to each supported controller's own doc (the owner's ask).

**A. `/docs/modules/clipplayer` (auto `[id]`) — add a CONTROLLERS block near the top.**
Between `docs.explanation` (`[id]/+page.svelte:76-78`) and the faceplate (`:96`), render a small
**controller chooser** — a grid of cards, one per surface:
   - **Card only** → anchor into the clip-player guide's "Quick start (no hardware)".
   - **monome grid** → `/docs/modules/monomeControl` (new; see §2).
   - **Launchpad (1 or 2 units)** → `/docs/modules/launchpadControlLeft`.
   - **MIDI keyboard / Electra** → the KEYS/MIDI-learn note (Launchpad KEYS today; a plain
     MIDI-keyboard path is an owner question — see §3).
This is data-driven so it can't rot: add a `controllers: ControllerRef[]` field to
`MODULE_GUIDES` (or a sibling `MODULE_CONTROLLERS` map keyed by module type), and the `[id]`
page renders whatever is listed. It stays in the AUTHORED tier (hand-maintained, no contract
churn), symmetric with `MODULE_GUIDES`.

**B. Split the operator guide into a controller-NEUTRAL clip-player guide.**
Repoint `MODULE_GUIDES.clipplayer` at a controller-neutral guide (retitle "Clip player — build,
launch, edit & arrange"). Move the monome-specific hardware sections OUT of it and into the new
Monome doc (§2.5). What stays: the one-minute mental model, quick start (no hardware), the card
(session/edit views, per-lane mono/poly, automation), pages/FOLLOW/DOUBLE/LENGTH concepts, and
song mode. What leaves: "Connecting a monome grid", the 16×8 layout diagram, the brightness LED
legend, and the on-grid pad coordinates.

**C. Two peer controller docs, same shape.**
   - `/docs/modules/launchpadControlLeft` → `LaunchpadDocs.svelte` (unchanged; gold standard).
   - `/docs/modules/monomeControl` → new `MonomeDocs.svelte` mirroring the Launchpad doc's
     quality: Setup/connect → the 16×8 session layout → the brightness LED language (generated
     from the live `monome-map` LED constants) → session pads → the on-grid note editor →
     length-edit → (future) song-mode-on-grid. Reuses the existing `GridDiagram.svelte` +
     `clip-grid-spec.ts` diagrams (already live-constant driven).

**D. Cross-links everywhere (kill the dead-ends).**
Every controller doc gets a header nav: "← Clip player guide · Other controllers: monome ·
Launchpad." The clip-player guide's Controllers section links to both. Optionally a light
`/docs/controllers` hub (or just lean on the catalog's existing "guides & hardware" section,
which already lists both) — owner question.

**How it renders vs the tiers (consistency):**
- The controller docs are hand-authored **static routes** (like `launchpadControlLeft`), NOT
  GENERATED, and — because `meta` modules have empty I/O — they don't participate in the
  AUTHORED contract or add anything but a trivial line to `contract-lock.txt`. They stay
  drift-safe the way the Launchpad doc already is: **import the LIVE `*-map` constants** (LED
  levels / RGB) so a legend can't disagree with the firmware, guarded by a small unit test in
  the `launchpad-docs.test.ts` mold.
- The controllers block is AUTHORED data (a small hand-maintained map), same class as
  `MODULE_GUIDES`. No GENERATED or PINNED surface changes except the one contract line the new
  meta module adds (accepted via `task docs:accept`).
- Nothing here touches a WebGL-attest-basis file → **no re-attest.**

---

## 2. MONOME MODULE spec — restore as a first-class peer of the Launchpad

**Call: RESTORE, do not rebuild.** The monome device, protocol, placement map, and binding all
exist, are tested, and already sit on the shared `clip-surface-map` core — exactly the target
architecture. The missing pieces are the *module wrapper* + a *first-class doc*, which mirror
the Launchpad's file set almost one-for-one. Rebuilding would throw away healthy, hardware-
verified code (Phase-0 real-grid fixes in #801, golden-vector `mext` tests).

### 2.1 What EXISTS today (healthy, keep)
| Concern | File | State |
|---|---|---|
| WebSerial device singleton + sim test hook | `control/monome/monome-device.svelte.ts` | ✅ works |
| mext byte codec (LED set/all, key rx, handshake) | `control/monome/mext.ts` | ✅ golden-tested |
| 16×8 placement over the shared brain | `control/monome/monome-map.ts` | ✅ works |
| Binding: session / edit / length-edit | `control/monome/monome-control.svelte.ts` | ✅ works |
| Tests | `mext.test.ts` (191), `monome-device.test.ts` (159), `monome-map.test.ts` (407), `monome-control.test.ts` (618) | ✅ |
| Card entry point | `ClipplayerCard.svelte` "GRID" button → `bindGridToClip` | ✅ works |
| Shared doc (mixed) | `docs/modules/grid-clip-launcher/+page.svelte` | ⚠️ mixed |

### 2.2 What is GONE / never existed (the restore work)
| Missing peer-of-Launchpad piece | Launchpad has | Monome needs |
|---|---|---|
| Meta module def | `meta/modules/launchpad-control.ts` | **`meta/modules/monome-control.ts`** (new) |
| Canvas card | `ui/modules/LaunchpadControlCard.svelte` | **`ui/modules/MonomeControlCard.svelte`** (new) |
| First-class doc component | `docs/LaunchpadDocs.svelte` | **`docs/MonomeDocs.svelte`** (new) |
| Doc route | `docs/modules/launchpadControlLeft/` | **`docs/modules/monomeControl/`** (new) |
| Guide registration | `MODULE_GUIDES` + `GUIDE_PAGES` entries | **both entries** (new) |
| Palette presence | `Hybrid/Hybrid` | **`Hybrid/Hybrid`** (new) |

The binding is also **behind the Launchpad on features** (no scene-scroll to 64 scenes, no
per-lane MONO/MUTE/RATE/SWING deck, no KEYS keyboard, no scene-repeats gesture, no arranger
REC/SES⇄ARR — the latter is the parked `.myrobots/plans/monome-song-mode-entry/PROPOSAL-FINAL.md`).
Feature-parity is a **follow-up**, NOT part of the restore (owner Q §3).

### 2.3 The adapter surface — file-for-file map to the Launchpad
```
LAUNCHPAD (exists)                                   MONOME (target)
─────────────────────────────────────────────────   ─────────────────────────────────────────────
meta/modules/launchpad-control.ts                    meta/modules/monome-control.ts          [NEW]
  launchpadControlDef                                   monomeControlDef
  type 'launchpadControlLeft' (legacy-kept)             type 'monomeControl'  (clean, new)
  domain 'meta', palette Hybrid/Hybrid                  domain 'meta', palette Hybrid/Hybrid
  card 'LaunchpadControlCard', size 1u, no I/O          card 'MonomeControlCard', size 1u, no I/O

ui/modules/LaunchpadControlCard.svelte               ui/modules/MonomeControlCard.svelte      [NEW]
  Pair / Connect-single handshake, bind clip           Connect (WebSerial picker), bind clip
  statusRune/pairRune/bindingRune                       connectedRune/bindingRune
  → launchpad-control.svelte.ts (exists)               → monome-control.svelte.ts (exists)

control/launchpad/launchpad-device.svelte.ts (WebMIDI)  control/monome/monome-device.svelte.ts (WebSerial)  [exists]
control/launchpad/launchpad-map.ts (8×8×2 + RGB)        control/monome/monome-map.ts (16×8 + brightness)    [exists]
control/launchpad/launchpad-control.svelte.ts           control/monome/monome-control.svelte.ts             [exists]
control/clip-surface-map.ts  ◄── SHARED BRAIN, both adapters defer every decision to it ──►      [exists]

docs/LaunchpadDocs.svelte + route launchpadControlLeft  docs/MonomeDocs.svelte + route monomeControl        [NEW]
module-guides.ts: MODULE_GUIDES + GUIDE_PAGES entries   module-guides.ts: add monomeControl entries         [NEW]
```
The new files (`monome-control.ts` meta def, `MonomeControlCard.svelte`, `MonomeDocs.svelte` +
route, guide entries) are the ONLY additions. Everything under `control/monome/` is reused
unchanged.

### 2.4 LED / placement language (brightness, not RGB)
The monome is a **varibright (0-15) brightness** surface; there is no colour. State distinctions
come entirely from the shared brain's level decisions (`clip-surface-map.ts:50-79`) as the monome
already renders them (`monome-map.ts:computeSessionLeds/computeEditLeds/computeLengthEditLeds`):
- empty 0 · loaded 6 · queued lo/hi 3/12 (blink) · playing 15 · stop idle/active 3/12 · scene
  idle 4 · edit pad 5 · transport-on 15 · held-modifier idle/on 4/15 · copy-indicator pulse
  ramp [8,13,8,3].
- Placement (16 wide): cols 0-7 = clip matrix (**pad.x = slot, pad.y = lane**); col 8 = per-lane
  STOP; col 9 = SCENE launch; (15,0) EDIT, (15,2) COPY, (15,3) COPY-IND, (15,4) PASTE, (15,5)
  PASTE-REV, (15,6) STOP-ALL, (15,7) TRANSPORT. EDIT mode: rows 0-6 note grid × 16 steps, row 7
  = function row. LENGTH-EDIT: 2-row block/step rulers.
The Monome doc's LED legend renders these **exact live constants** (import from `monome-map`) so
it can't drift — the brightness analogue of the Launchpad doc's RGB legend.

### 2.5 Connection / transport path
- **WebSerial** (Chromium only), gesture-gated `connect()` (`monome-device.svelte.ts:127`), FTDI
  UART 115200 8N1, DTR+RTS asserted on open (real-hardware fix). Picker shows all serial ports
  (macOS hides FTDI vendor metadata). Classic FTDI grids only (mext); **USB-C grids not
  supported** (`mext.ts:29` note) — owner Q whether v1 needs them.
- **mext codec** (`mext.ts`): 0x18 led-set, 0x19 led-all, 0x21/0x20 key down/up, handshake
  query/id/size. Full repaints batch single-LED writes (~44 ms) — the 0x1A quadrant map is
  deferred pending a byte-form confirmation.
- **Binding** (`monome-control.svelte.ts`): per-machine `localStorage` (`pt.grid.boundClipNode`),
  never synced; LED frames are local render state; only the launch/queue writes go to
  `node.data.queued[]` (the same synced field the card + Launchpad write → multiplayer for free).

### 2.6 Grid sizes 64 / 128 / 256
`mext.ts` fixes `GRID_WIDTH=16, GRID_HEIGHT=8` (a **128**), and `monome-map.ts` imports those as
constants, so **placement is 128-only today**. The device DOES read real size from the handshake
(`size-resp 0x03` updates `gridW/gridH` in the device), but the map ignores it. The layout needs
16 columns (8 matrix + the right control strip), so:
- **v1: canonical target = a 128 (16×8).** The card surfaces the connected size; a non-128 warns.
- **64 (8×8):** matrix-only is possible (drop the right strip; move STOP/SCENE/EDIT onto a
  held-modifier layer). Follow-up — needs a placement variant keyed off `gridSize()`.
- **256 (16×16):** extra 8 rows are spare (or a song-overview band). Follow-up.
Recommend shipping 128-first (mirrors the Launchpad's single-unit-first pragmatism) and gating
64/256 behind an owner decision (§3 Q4).

### 2.7 The doc it ships with
`MonomeDocs.svelte` at `/docs/modules/monomeControl`, mirroring `LaunchpadDocs.svelte`'s
structure but for one brightness surface: Setup/connect (Chromium + FTDI grid, the port picker
caveat) → 16×8 session layout (`GridDiagram`) → brightness LED legend (live constants) →
session pads (launch/scene/stop/copy-paste) → on-grid note editor (7 pitch rows × 16 steps +
function row) → length-edit page → grid-size notes → cross-links (clip-player guide · Launchpad).
Registered in `module-guides.ts` (`MODULE_GUIDES.monomeControl` + a `GUIDE_PAGES` entry) so it's
one click from both the clipplayer `[id]` callout and the catalog's guides section.

---

## 3. Phased plan

Three independently-shippable PRs. Total ≈ 5-6 engineering-days. Each PR is unit + a little VRT;
CI wall-time delta is modest (well under the >2 min sign-off bar), except confirm the new card's
VRT baseline generation.

### Phase 1 — Restore Monome as a first-class module (≈1-1.5 d, 1 PR)
1. `meta/modules/monome-control.ts` — `monomeControlDef` mirroring `launchpad-control.ts`
   (type `monomeControl`, domain meta, palette Hybrid/Hybrid, card `MonomeControlCard`, 1u, no
   I/O). Meta registry is **glob-driven** (`meta/modules/index.ts`) → pure add, no barrel edit.
2. `ui/modules/MonomeControlCard.svelte` — Connect (gesture-gated WebSerial picker via
   `monome-device.connect()`), bind/unbind to the first clipplayer (`bindGridToClip` /
   `unbindGrid` / `restoreGridBinding` already exported), status via `connectedRune` +
   `bindingRune`. Simpler than the Launchpad card (one device, no L/R pairing).
3. Register the card in `ui/modules/modules-card-map.ts` + `rack-sizes.ts`; add the type to
   `modules-card-map.test.ts:EXPECTED_NODE_TYPES` (shared file — post-merge conflict-sweep).
4. Keep the clipplayer card's "GRID" button as a shortcut (owner Q on coexist vs replace).
5. Tests: `modules-card-map`, per-module-per-port (meta = no ports → exempt like the Launchpad),
   a VRT baseline for `MonomeControlCard`, and `task docs:accept` for the one new
   `contract-lock.txt` line. Flake-check the new spec 3×.

### Phase 2 — Monome docs (≈1.5 d, 1 PR)
1. `docs/MonomeDocs.svelte` — extract + refresh the monome-specific content out of
   `grid-clip-launcher`; import live `monome-map` constants for the layout + brightness legend;
   reuse `GridDiagram` + `clip-grid-spec` diagrams.
2. Route `docs/modules/monomeControl/{+page.svelte,+page.server.ts}` (server returns `{}` so it
   prerenders like siblings under the docs `prerender = true` subtree).
3. `module-guides.ts`: add `MODULE_GUIDES.monomeControl` + a `GUIDE_PAGES` entry.
4. A `launchpad-docs.test.ts`-style drift guard (doc renders + imports live constants).

### Phase 3 — Clip-player doc restructure + controller cross-links (≈2-2.5 d, 1 PR)
1. Add the **Controllers** chooser block to `[id]/+page.svelte` (data-driven from a new
   `MODULE_CONTROLLERS` map / extended `MODULE_GUIDES`), rendered above the faceplate.
2. Split `grid-clip-launcher` into a controller-NEUTRAL clip-player guide (mental model, card,
   editing, song mode); move monome hardware into `MonomeDocs`. Repoint `MODULE_GUIDES.clipplayer`
   + retitle. Keep `grid-clip-launcher` as a redirect/alias to preserve inbound links + the old
   callout (owner Q6).
3. Cross-link header nav on all controller docs + the clip-player guide; optional
   `/docs/controllers` hub (or lean on the catalog guides section).
4. Trim controller-specific prose from the clipplayer co-located `docs.explanation` over time
   (optional polish; the co-located block stays the pinned source for ports/params).

### Risks
- **Shared-file conflict surface:** `modules-card-map.test.ts:EXPECTED_NODE_TYPES`,
  `module-guides.ts`, `contract-lock.txt`. Run `task pr:conflict-sweep` after each merge; never
  `gh pr update-branch` on these.
- **contract-lock line:** the new meta def adds one line → `task docs:accept`, review the diff.
- **Collab-attest:** meta modules have no engine factory and are NOT in `_drivers.ts`, so the
  registration is a pure glob add — **lower** re-attest risk than an audio/video module. Confirm
  the meta-def snapshot isn't pulled into the collab basis before merging (flag, likely clean).
- **VRT baseline** needed for `MonomeControlCard`; generate via the vrt-update flow.
- **Grid-size scope creep:** keep 64/256 out of v1 (128 canonical) or it balloons Phase 1.
- **Breaking `grid-clip-launcher`:** it's prerendered + linked; alias/redirect rather than delete.
- **Out of scope but note during preview:** the Launchpad doc's 5th "Walkthrough" sub-tab
  (beyond the owner's four) — `LaunchpadDocs.svelte:9-13` flags it for owner review.

### Owner questions
1. **Restore vs rebuild** — confirm RESTORE (promote the existing, tested binding to a module).
   [Recommended: yes.]
2. **Coexist vs replace** — does the new Monome MODULE replace the clipplayer card's "GRID"
   button, or coexist (button = shortcut)? [Recommended: coexist.]
3. **Feature-parity scope** — ship the module at TODAY's monome feature level first, and treat
   scene-scroll-to-64 / per-lane deck / KEYS / scene-repeats / arranger-on-grid (the parked
   `monome-song-mode-entry` proposal) as follow-ups? [Recommended: yes — ship the wrapper first.]
4. **Grid sizes** — 128 canonical for v1, with 64 (matrix-only) + 256 as follow-ups? Or must v1
   handle all three? [Recommended: 128-first.]
5. **Naming** — module `type: 'monomeControl'`, label "monome control", doc slug
   `/docs/modules/monomeControl`, palette Hybrid/Hybrid (beside Launchpad control)? OK?
6. **Old URL** — keep `grid-clip-launcher` as a redirect/alias to the new controller-neutral
   clip-player guide, or retire it?
7. **Controllers hub** — a dedicated `/docs/controllers` index, or is the catalog's existing
   "guides & hardware" section + per-doc cross-links enough? [Recommended: cross-links + catalog
   section; skip a new hub for v1.]
8. **MIDI keyboard / Electra as a listed "controller"** — should the clip-player Controllers
   block list a generic MIDI-keyboard/Electra path (KEYS today is Launchpad-only), or only the
   card / monome / Launchpad? 
9. **USB-C monome** — confirm v1 targets classic FTDI grids only (mext), no USB-C support.

---

## 4. Summary
- **Confusion root-causes:** the clip player is documented across three unrelated slugs and
  "View docs" opens the driest (auto reference) one; the single rich guide (`grid-clip-launcher`)
  fuses controller-neutral + monome-specific + song-mode content with no "pick your controller"
  fork; the Launchpad has a gold-standard standalone doc while the monome is a buried inline
  section; the slug/title hide the neutral content behind "monome"; and there is no controllers
  hub or cross-linking, so every surface is a dead-end.
- **Monome call:** RESTORE, not rebuild — the device/protocol/map/binding all exist, are tested,
  and already sit on the shared `clip-surface-map` core. Only the module wrapper (meta def +
  card) and a first-class doc are missing; they mirror the Launchpad file set one-for-one.
- **Doc IA:** overview → controllers → card UI → per-mode reference. The clip-player page grows a
  data-driven Controllers block linking to each surface's own doc; the operator guide is split
  into a controller-neutral clip-player guide; the monome gets its own `MonomeDocs` peer of
  `LaunchpadDocs`; all controller docs cross-link. Stays within GENERATED/AUTHORED/PINNED
  (hand-authored static routes importing live constants, one new contract-lock line, no WebGL
  re-attest).
- **Top owner questions:** confirm restore-not-rebuild; coexist-vs-replace the GRID button;
  ship-current-features-first; 128-canonical grid size; naming `monomeControl`; keep/redirect the
  old `grid-clip-launcher` URL.
- **Effort:** ≈5-6 days across 3 independently-shippable PRs (module restore → monome docs →
  clip-player restructure), modest CI wall-time.
- **Doc path:** `/Users/2600hz/Documents/workspace/inet.modular/.myrobots/plans/docs-review-monome-2026-07-18.md`

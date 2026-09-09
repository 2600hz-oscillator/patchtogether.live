# Splitting patchtogether.live into AGPL / MIT / Private — Report & Plan

_Final. Draft folded together with the adversarial legal review (2026-07-01).
Every "hidden client-side" claim from the draft has been downgraded to
"obfuscated"; the DSP-privacy plan has been corrected for AGPL §13 Corresponding
Source; SNES9x/Blood are re-classified as non-free quarantine (not private/paid
tier material); and the private-tier boundary is redefined as a provable
arm's-length service. See §10 for the itemized legal-review resolution._

**I am not a lawyer. Items tagged ⚖️ need counsel before anything ships under new
labels.**

> **TRIAGE 2026-08-04 — NOT EXECUTED; nothing here has been acted on.** `LICENSE`
> is still the single AGPL-3.0-or-later file ("patchtogether.live / Copyright (C)
> 2026 2600hz-oscillator") and there is no second licence file, no MIT subtree and
> no private tier. So this remains a live decision document, and the ⚖️ items
> still need counsel before anything moves.
> One factual note for whoever picks it up: the specific evidence in §1 that
> `packages/dsp/dist/clouds.js` ships unminified with its `// src/clouds.ts`
> header is a 2026-07-01 observation about a **build artifact** — re-check the
> current dist before quoting it, since the AGPL §13 Corresponding-Source argument
> is built on it.

## 1. Executive summary + recommendation

patchtogether.live is today a **single public monorepo, uniformly licensed
AGPL-3.0-or-later** (`/Users/2600hz/Documents/workspace/inet.modular/LICENSE`,
© 2026 2600hz-oscillator), with permissive and GPL-family third-party code
lawfully aggregated inside it. The repo is already `visibility: PUBLIC`, so
**nothing is hidden today** — this exercise is forward-looking.

Two facts dominate every downstream decision, and the legal review sharpened both:

- **Client-side code cannot be hidden by any repo/license mechanism** — the
  browser downloads it. Minifying/stripping sourcemaps is **obfuscation, not
  hiding**. Worse, the "compiled" DSP dist is *not even minified*:
  `packages/dsp/dist/clouds.js` ships as readable ESM with the original
  `// src/clouds.ts` header, full variable names, and comments. **And there is a
  copyleft trap the draft missed:** the first-party DSP is the owner's *own AGPL
  code*, so serving only a minified `dist/*.js` to browsers while withholding the
  preferred-for-modification source is an **AGPL §13 / §1 Corresponding-Source
  violation**, not merely "weak protection." Repo privacy buys **nothing** for
  the prized DSP/video IP, and the minify-and-withhold plan is affirmatively
  non-compliant. (Review P0-3, P2-2.)
- **Only server-side code is genuinely hideable**: the Fly relay
  (`packages/server/src/*`), SvelteKit SSR/`$lib/server/*`, and env secrets
  (already walled) — **and only if that server code is a real arm's-length
  service that imports zero AGPL source** (Review P0-2).

**Recommendation: a B+D hybrid on a single public monorepo — do NOT go
multi-repo (A) or private-npm-package (C).** But the *contents* of the private
tier are much narrower than the draft assumed:

1. Keep one public monorepo; license **by directory/package**. AGPL for the core
   (as today); carve a small **MIT module-authoring SDK** (stable seams:
   `PortDef`/`ParamDef`, `gate-trigger`, `edge-detect`, worklet-build helpers,
   `new-module` scaffold) — **only if it can be proven, by CI dependency-boundary
   lint, to import zero AGPL/GPL packages** (Review P1-1).
2. Store truly-private content in a **git submodule** mounted at a glob-reachable
   overlay path, with its own LFS store and its own attest bases. The private
   tier holds **server business logic + secrets ONLY** (plus a *quarantine* — not
   a moat — for non-free game components). It does **NOT** hold DSP source, any
   client module, or any DOOM/Blood-derived netcode.
3. Make the build **tolerate the submodule's absence** via an extra optional
   `import.meta.glob` root (empty dir → `{}` → open subset builds with no
   conditional code), plus registry-derived central lists so private names never
   leak. **The public AGPL tree MUST remain independently buildable** (`task
   build` succeeds with the private submodule absent) or the §13 offer is
   defective (Review P2-2).

This is where GitLab (`ee/`), Cal.com (AGPL + `ee/`), and PostHog (MIT + `ee/`)
converged: one visible repo, license-by-directory, hidden code only via a
submodule/overlay for genuine server-side/enterprise logic. It preserves the
single flox env, single lockfile, `dsp-build`-once CI optimization, the attest
systems, and the single `task build` → wrangler/Fly deploy.

**Priority framing: mid-priority, incremental.** The highest-value, lowest-risk
moves (secret-boundary hardening, header-label fixes, SNES9x/Blood quarantine,
in-app §13 source link) are near-free and go first; the physical module split is
a later, larger phase gated on registry-derivation work already in motion
(PR #551). **The single most important caveat: hiding = server-side only, and
only behind a genuinely arm's-length, AGPL-import-free API — everything the
browser touches is public, and minify-and-withhold of first-party AGPL DSP is a
license violation, not a moat.**

---

## 2. Current license state

- **First-party: uniformly AGPL-3.0-or-later**, single copyright holder
  `2600hz-oscillator`. Root `package.json` → `"license": "AGPL-3.0-or-later"`,
  `"private": true`; `packages/present-shell/package.json` restates it explicitly
  (proof a workspace can carry its own license). `packages/{web,server,dsp}`,
  `art`, `e2e` carry **no `license` field**, are all `private:true`, and inherit
  the root AGPL. **No per-file SPDX headers** (`grep SPDX-License-Identifier
  packages/web/src` = 0 hits). The "or later" grant is present.
- **No dual-licensing, no proprietary code, no submodules today.** `.gitignore`
  hides only `.env`/`*.secret` and points at a separate private
  `../patchtogether-infra-docs` repo. DOOM/Blood WASM are gitignored *build
  artifacts*, not withheld source. So the "hidden critical parts" are **net-new**
  — there is no existing closed component to model on.
- **Two network surfaces** (both matter for §13): the CF Pages client bundle
  (conveyed to browsers) and server processes — the Fly Hocuspocus/Yjs relay
  (`packages/server`) plus SvelteKit/CF-Worker endpoints
  (`packages/web/src/lib/server/*`, `hooks.server.ts`, Clerk auth).

**Third-party licenses already in-tree (the real complexity):**

| Component | Path | License | Integration |
|---|---|---|---|
| DOOM (doomgeneric/Chocolate/id) | `packages/web/native/doomgeneric/` → `static/doom/doom.wasm` | **GPLv2** | separate WASM blob, `fetch()`, `dgpt_*` C-ABI; aggregation documented in `doomgeneric/NOTICE.md` |
| DOOM shims / netcode | `doomgeneric_patchtogether.c`, `net_pt.c/.h` | **GPLv2 (derivative — stays GPLv2)** | multiplayer lockstep is DOOM-derived; cannot become MIT or private |
| Blood / NBlood | `packages/web/native/nblood/` → `static/blood/blood.wasm` | **GPLv2 (EDuke32 exc.) + Ken Silverman BUILDLIC = NON-COMMERCIAL** + LGPL-2.1 libsmackerdec, MIT mimalloc/voidwrap | WASM blob |
| SNES9x (snes9x2005/CATSFC) | `packages/web/native/snes9x/` | **NON-FREE: Snes9x core is "personal use only", non-commercial, NOT relicensable by us**; the MIT text in `copyright` covers ONLY the RetroArch wrapper | WASM blob |
| HELM / POLYHELM | `packages/dsp/src/{helm,polyhelm}.ts`, `lib/helm-engine.ts` | **GPL-3.0** (Matt Tytel) | TS port, "GPL firewall" headers |
| GRIDS | `packages/dsp/src/grids.ts`, `grids-resources.ts` | **GPLv3** (MI) — ⚠️ header **wrongly says "MIT"** | LUTs derive from GPLv3 source |
| SYMBIOTE | `packages/dsp/src/symbiote.ts`, `symbiote-core.ts` | **GPLv3 ×2** (Grids + TB-3PO/O&C/Hemisphere) | TS port |
| @grame/faustwasm | npm | **LGPL-3.0**; Faust-generated wasm may inherit stdlib primitive licenses (some STK/GPL-flavored) | runtime + build tool |
| mediabunny | npm | **MPL-2.0** | file-level copyleft, non-infecting |
| MI ports (clouds/elements/rings/warps/peaks/marbles/stages/tides2/macrooscillator/veils/plaits/braids), CloudSeed, CallSine, cocoadelay | `packages/dsp/src/*.ts`, cards under `packages/web/src/lib/ui/modules/*` | **MIT** (Émilie Gillet et al.) — ⚠️ `cocoadelay-core.ts` header wrongly says "GPL-3.0" (harmless over-restriction) | clean-room ports; upstream MIT is genuinely MIT-compatible, but our AGPL graph/glue around them is not |
| TOYBOX shaders/models | `static/toybox/` | **MIT** + one **CC-BY-3.0** (`synthwave-sunset.frag.glsl`) + **CC0** models; no CC-BY-NC | assets |
| skifree | `packages/web/native/skifree/` | **MIT** | — |
| Bravura font | `static/fonts/Bravura.woff2` | **OFL-1.1** — ⚠️ license text not vendored beside font | asset |

Data assets (gitignored / user-provided): DOOM1.WAD (id shareware), Blood game
data (proprietary Monolith/Atari), SNES ROMs (proprietary).

---

## 3. Proposed 3-way split — concrete mapping

Grounded in the measured import-direction matrix: the codebase is correctly
bottom-heavy **except the `graph` row**, which wrongly reaches up into
audio/video/meta. The audio/video engines themselves (`engine.ts`,
`reconciler.ts`, `module-registry.ts`) are store-free and snapshot-bus-driven — a
near-clean kernel.

### (A) MIT — reusable framework/SDK (leaf layer, AGPL-free, GPL-free)
The stable seams an external module author needs, **none of which may import the
AGPL app or any GPL DSP** (enforced by CI boundary lint — Review P1-1):
- **Contract kernel:** `graph/types.ts` (zero imports —
  `PortDef`/`ParamDef`/`ModuleDef`/`CableType`/`Domain`/`canConnect`),
  `graph/validate-edge.ts`, `graph/cap.ts`, `graph/duplicate.ts`,
  `graph/snapshot.ts` (*only after* the risk-#1 inversion below).
- **Domain-pluggable engine:**
  `audio/{engine,reconciler,module-registry,poly,cv-scale,edge-detect,gate-trigger,scheduler-clock}.ts`;
  `video/{engine,module-registry,mat4,mesh,primitives}`; `meta/module-registry.ts`.
- **Sync primitives:** `graph/store.ts`, `multiplayer/provider.ts`, `sync/prng.ts`.
- **UI kit:** `ui/controls/*` (Knob/Fader/WaveformGlyph/MidiAssignButton),
  `ui/skins/*`, `ui/rack-grid.ts`/`rack-sizes.ts`, `PatchPanel.svelte`,
  `PickupCable.svelte`, `port-patch-helpers.ts`.
- **DSP framework:** the `packages/dsp` build *pipeline* (`scripts/build.mjs`,
  worklet helpers, `scripts/new-module.ts`). NOTE: the pipeline is MIT-safe but
  the **catalog is mixed** (modules carry varied upstream licenses via
  `ossAttribution`, and Faust output may inherit stdlib licenses — Review P2-3) —
  the catalog stays with the app, and each `.dsp`/worklet is license-audited
  before any tier label.
- Standalone MIT candidate: `packages/present-shell` (already outside the
  workspace array, own license).

**Hard exclusions from the MIT tier** (they force ≥GPL, per Review P1-1/P1-2):
`packages/dsp/src/{helm,polyhelm,grids,symbiote}.ts` + engines; **all
DOOM/Blood-derived code including `net_pt.c`/`doomgeneric_patchtogether.c` and
the multiplayer lockstep netcode**; and anything importing the AGPL
graph/engine. The MI-derived modules are upstream MIT, but our AGPL graph wiring
around them is AGPL — only the wiring-free core seams above are MIT-eligible.

### (B) AGPL — the application/product
- `ui/Canvas.svelte` (**5,816-line orchestrator**), all modals/menus,
  `ModulePalette`, `routes/*`.
- The **concrete module catalog**: ~330 files in `audio/modules/`, the
  `video/modules/` set, 229 cards in `ui/modules/`.
- **All first-party DSP source** (`packages/dsp/src/*.ts` + the `dsp-build`
  tooling) — this stays AGPL and stays *public and buildable* (see §5/§10: it
  cannot be hidden client-side, and withholding its source violates §13).
- App graph features: `graph/persistence.ts`, `graph/performance-*`,
  `graph/mutate.ts`, `ui/example-patches/`.
- The **GPL-family engines/ports** (helm/polyhelm/grids/symbiote) and the
  **DOOM/Blood shims + multiplayer netcode** — these are GPLv2/GPLv3, remain
  copyleft, and their source must be offered; they live in the public tree.
- Living-docs + attest tooling: `docs/*`, `scripts/*-attest*`, `ci-*-attest/`.
- The relay `packages/server` *interface/AGPL portions* (it never imports web;
  it's a standalone AGPL service — see §6 for the §13 caveat that a *hidden*
  backend must be built clean of any external AGPL fork).

### (C) Private — hidden critical (deliberately VERY narrow; server-side only)
Redefined per Review P0-2/P0-3/P1-2: the private tier holds **only** code that is
(a) server-side, (b) a genuine arm's-length service reachable over a documented,
substitutable API, and (c) imports **zero** AGPL source. Everything else the
draft wanted to "hide" is either unhideable (client) or copyleft (game code).

- **Server business logic + secrets moat:** `packages/server/src/{capacity,
  rack-access,reaper,auth}.ts` (per-rackspace 4-user cap, tier gating, reaping);
  `lib/server/{invites,rackspaces,rackspaces-capacity,home-auth,feedback}.ts`;
  `routes/api/*`; `hooks.server.ts` (beta gate). The **invite-signing secret** is
  the crown jewel (rotating it is the only invite-revocation primitive —
  `$lib/server/invites.ts` HMAC-SHA256). **Precondition:** these must be lifted
  onto a clean API that imports no AGPL graph/CRDT types, or they are a combined
  work and owe source under §13.
- **Env secrets** — already gitignored, never committed. Which variables those
  are, where each one lives and which must match across tiers is inventoried in
  `runbooks/secrets-and-accounts.md`, which is their only home; a licensing
  analysis does not need to restate it. These are the one unambiguously safe
  "private" category.

**NOT in the private tier (corrections vs. draft):**
- ❌ **DSP/video source** — client-side, unhideable, and first-party AGPL:
  withholding source violates §13. Stays AGPL/public.
- ❌ **DOOM/Blood game bridges + multiplayer netcode** — GPLv2 derivatives;
  §3(GPLv2) entitles WASM recipients to source. Cannot be private. Stays GPLv2.
- ⚠️ **SNES9x + Blood BUILDLIC content** — these are NON-FREE / non-commercial
  and do **not** become ours by hiding them. They are a **quarantine**, not a
  moat: keep strictly user-supplied/optional (as ROMs already are), never bundle
  into a paid/"private" tier, never relabel MIT, carry verbatim license text.
- ⚠️ **Optional/premium/unreleased roadmap** (clip-launcher/milkdrop pre-ship) —
  feature-flag-until-ship only; once shipped it is in the browser and public.

---

## 4. Third-party license constraints that FORCE placement

**Copyleft floor — cannot ever be MIT:**
- GPL-3.0: `helm.ts`, `polyhelm.ts` → block any MIT DSP spinoff.
- GPLv3: `grids.ts`, `symbiote.ts`/`symbiote-core.ts` (doubly, Grids + TB-3PO).
- GPLv2 engines: DOOM, Blood — kept legal *only* by arm's-length aggregation
  (separate `.wasm`, `fetch()`, `dgpt_*`-style ABI). **GPLv2-only is NOT
  combination-compatible with GPLv3/AGPLv3**, so the aggregation posture in
  `doomgeneric/NOTICE.md` (and the Blood equivalent) is load-bearing — any future
  tightening (bundling the engine, sharing memory/source) resurrects the
  incompatibility.
- **GPLv2 derivatives — DOOM/Blood shims + netcode:** `net_pt.c`,
  `doomgeneric_patchtogether.c`, and the multiplayer lockstep are derivatives of
  GPLv2 code (GPLv2 §2(b)). They **cannot** be relabeled MIT and **cannot** be
  withheld as private-proprietary (GPLv2 §3 entitles binary/WASM recipients to
  source). **The "crown-jewel netcode" instinct is a trap: our netcode is
  DOOM-derived and therefore copyleft — it cannot be the private moat.** (Review
  P1-2.)
- Weak/library copyleft (AGPL-compatible, constrain but don't force placement):
  @grame/faustwasm (LGPL-3.0 — must preserve relink rights for the shipped
  runtime; audit Faust stdlib primitive licenses per generated worklet — Review
  P2-3); mediabunny (MPL-2.0, file-level).

**NON-FREE / NON-COMMERCIAL flags beyond copyleft — escalate to owner NOW
(conflict with Clerk paid tiers regardless of AGPL, and hiding does not cure
them):**
- **SNES9x core** "personal use only" — **non-free; not relicensable by us; not
  MIT; not a private/paid-tier candidate.** Stricter than DOOM: the "DOOM
  precedent" (GPLv2, free copyleft) does **NOT** transfer to SNES9x. (Review
  P0-1.)
- **Blood's Build engine** (Ken Silverman BUILDLIC, non-commercial,
  internet-only).
These are the two most serious risks and are independent of the split itself.

**Permissive — may go either tier (attribution travels):** all MI ports (MIT),
CloudSeed/CallSine/cocoadelay (MIT — fix the mislabel), TOYBOX shaders (MIT + 1
CC-BY-3.0), CC0 models, skifree (MIT), Bravura (OFL-1.1 — vendor the OFL text),
all JS deps (yjs, @syncedstore, @hocuspocus/*, @xyflow/svelte, codemirror, hls.js
Apache-2.0, node-web-audio-api BSD-3, etc.). **Notice retention:** MIT/BSD
require the copyright + permission notice ship "in all copies" — a build that
strips these from the client bundle violates the very MIT terms we rely on
(Review P2-4). `OssAttribution.svelte` must be complete and ship a notice
manifest with the deployed client.

**Header mislabels to correct (accuracy, not restructuring):** `grids.ts` claims
MIT for GPLv3 code (dangerous under-restriction); `cocoadelay-core.ts` claims
GPL-3.0 for MIT code (harmless over-restriction).

---

## 5. Hidden-critical parts + hiding mechanism (client vs server tagged)

The governing distinction, corrected per the review: **client-side =
compile/minify/obfuscate ONLY (never "hidden"; and for first-party AGPL code,
even minify-and-withhold is a §13 violation); server-side = genuinely hideable,
but only behind an arm's-length AGPL-import-free API.**

| # | Item | Client/Server | Value | Mechanism (corrected) |
|---|---|---|---|---|
| P0 | Env/infra secrets (inventory: `runbooks/secrets-and-accounts.md`) | **Server** | Highest | `$env/dynamic/private` + Fly/CF secrets (already walled). Only work: never leak into a `VITE_*` var. **Unambiguously safe to keep private.** |
| P0 | Relay capacity/access/anti-abuse (`packages/server/src/{capacity,rack-access,reaper,auth}.ts`) | **Server** | High | Private submodule — **only after** lifting onto an API that imports zero AGPL graph/CRDT types (else combined work → §13 forces source). CI boundary lint must prove no AGPL import. |
| P0 | SSR secret-signing (`$lib/server/invites.ts` HMAC) & api routes | **Server** | High | SvelteKit `$lib/server/*` is guaranteed off the client bundle — keep it there; same zero-AGPL-import rule to make it truly private. |
| ~~P1~~ | ~~Original DSP source hidden via prebuilt-dist + minify~~ | **Client** | **N/A — REMOVED** | **Struck.** First-party DSP is AGPL; serving minified `dist/*.js` while withholding the buildable source is an AGPL §1/§13 Corresponding-Source **violation**, not protection. Client DSP is unhideable AND must ship its source offer. Keep `packages/dsp/src` public + buildable. |
| P1 | Unreleased roadmap (clip-launcher/milkdrop, DOOM-MP feature timing) | **Client** (+ any server pieces) | Timing-only | Feature-flag / gitignore-until-ship. Once shipped it is in the browser and public. NOT a durable hide. |
| — | GPL game engines + DOOM/Blood shims + netcode | Client blob / GPLv2 src | N/A | Copyleft **forbids** hiding source (GPLv2 §3); not a private-tier candidate. Netcode is DOOM-derived → cannot be the moat. |
| — | SNES9x / Blood BUILDLIC | Client blob | N/A (hazard) | **Quarantine, not moat:** user-supplied/optional, never paid/private tier, never MIT, verbatim license carried. |
| — | MI-derived DSP (clouds/elements/rings/marbles/stages/tides2/plaits/grids/symbiote) | Client | N/A | MIT (or GPL for grids/symbiote) upstream — nothing of ours to protect; attribution (`OssAttribution.svelte`) must stay + ship in bundle. |
| — | Attest system (`ci-webgl-attest/`, `ci-collab-attest/`, `scripts/*attest*`) | CI | N/A | READMEs self-document as **not security controls** (single-trusted-actor staleness gates). Secrecy adds zero. |
| — | Clerk publishable key / tier UI | Client | N/A | Designed public. |

**Bottom line for §5:** the *only* things both valuable and actually hideable are
server-side (relay + SSR signing + secrets), and only once they are decoupled to
import no AGPL source. The prized DSP/video "sauce" is client-side, unhideable,
**and** legally required to ship its source. Strike every "hidden client" claim;
say "obfuscated" at most, and don't obfuscate-and-withhold first-party AGPL DSP.

---

## 6. AGPL §13 network-use + hidden-code legal considerations

**(⚖️ items need counsel.)**

- **§13 is already triggered and continuous.** Hosting the modified/ongoing
  service at patchtogether.live obliges offering **Corresponding Source** to
  *every user who interacts over the network* — including anonymous/invite/beta
  users (the beta gate/invite secrets do NOT narrow the §13 audience). It is not
  avoided by "we never ship a tarball."
- **Two independent obligations:** (a) the **client bundle is *conveyed*** to
  every browser → full source attaches regardless of §13, and the
  **preferred-for-modification form** (un-minified, buildable) must be offered —
  so minifying first-party AGPL DSP does not shrink the obligation; (b) the
  **server processes** (relay, Worker endpoints) are the classic §13 target.
- **Corresponding Source completeness (Review P2-2):** §1 requires the *scripts
  and tooling to build/install* be part of Corresponding Source. If the split
  moves build config, module-registry codegen, or the DSP/Faust build into a
  private tier, the AGPL offer is **defective** because a recipient cannot rebuild
  the served app. **The AGPL public tree must remain self-buildable (`task
  build` succeeds without the private submodule).** This kills the draft's
  "move `dsp-build` private, ship dist only" idea.
- ⚖️ **Compliance gap:** README §License only points at `LICENSE`; there is **no
  in-app "get the source" affordance**. The running instance should surface a
  visible source offer. Near-free to add, independent of any restructuring.
- **Nonprofit changes nothing (Review P2-1).** AGPL §13 / GPL §§5-6 trigger on
  conveyance and network interaction, **not on profit motive**. A nonprofit
  serving the AGPL app over the network owes Corresponding Source exactly as a
  for-profit does, and nonprofit status does not cure non-commercial-licensed
  components (SNES9x/Blood). **Strike any nonprofit-as-safe-harbor reasoning.**

**Hidden-code = combined-work vs. mere-aggregate (FSF test: intimacy of
communication + shared execution/data). The private tier escapes §13 ONLY if ALL
hold (Review P0-2):**
- a **separate process/service**, AND
- reachable through an **independent, documented, substitutable** interface a
  third party could reimplement, AND
- **imports zero AGPL source** (no `$lib` graph types, no CRDT/graph internals,
  no shared data structures), AND
- **independently usable.**

Consequences:
- **Bundled into the SvelteKit client** (a `.ts`/`.svelte` importing the AGPL
  graph/registry, running in the same page) = **combined/derivative work** →
  cannot be hidden while shipped.
- **AudioWorklet is NOT a separation boundary** — same web app, same bundle, same
  port contracts, same distribution; "another thread" ≠ aggregation for GPL.
- **Code-split / dynamic `import()` is NOT an aggregation boundary** ⚖️ — a
  lazily-loaded chunk still sharing AGPL types is likely still combined.
- **A separately-fetched WASM blob over a narrow documented ABI IS the strong
  aggregation case** — the DOOM pattern (own artifact, own sandbox, arm's-length
  interface, no AGPL-source import, independently usable). A genuine "hidden"
  component must have this shape.
- **A separate service over HTTP/WebSocket is the cleanest hide** (classic
  open-core) — **caveat:** if that service *forks/incorporates* AGPL code (e.g.,
  the Hocuspocus relay), §13 attaches *to the service* and its modified source
  must be offered. A hidden backend must be built **clean of any external AGPL
  fork** and importing no first-party AGPL source, not as a fork of the relay.
- **Enforce with CI:** a dependency-boundary check that fails if the private (or
  MIT) packages import AGPL/GPL packages. If it can't pass, the honest outcome is
  that code is AGPL and its source must be offered.

**Relicensing / MIT-side legality:**
- One-way compatibility: MIT can be pulled *into* AGPL; AGPL cannot be absorbed
  into MIT. The **MIT layer must be the lower/leaf** the AGPL layer consumes; the
  moment an "MIT" piece imports the AGPL core, the distributed combined work is
  AGPL-governed and the MIT label is **false and unenforceable** against a
  downstream user (Review P1-1).
- ⚖️ **Sole-copyright-holder assumption must be verified.** If 2600hz-oscillator
  is truly the sole holder of first-party code (no outside-contributor copyright
  entered the tree, CLA status confirmed), the owner may dual-license/relicense
  their own contributions. They **cannot** relicense third-party parts.

**⚖️ Lawyer-needed items (consolidated):**
1. Exact Helm grant (GPL-3.0-only vs -or-later) + accuracy of the "relicensed to
   AGPL" label on `helm.ts`.
2. Sign-off on the DOOM/Blood **aggregation** theory (GPLv2 ↔ AGPLv3), re-review
   if any boundary tightens.
3. Whether a specific proposed hidden component sits on the aggregation or
   derivative side (code-split/worklet/dynamic-import gray zone).
4. Contributor IP / CLA confirmation that the owner can relicense first-party
   code.
5. §13 compliance mechanics (visible source offer; what "Corresponding Source"
   must include — incl. build tooling — for CF Pages bundle + Fly relay +
   Workers).
6. **SNES9x (non-free) + Blood non-commercial clauses vs. Clerk paid tiers** —
   independent of the split; potentially the most urgent commercial-risk item.
7. Trademark/branding (`patchtogether.live` name, `2600hz` org) if the project
   ever visibly splits.

---

## 7. Recommended split mechanics + impact

**Chosen: B+D hybrid (submodule storage + absence-tolerant build) on one public
monorepo**, with the private tier scoped to server-side/secret content ONLY (per
§3C corrections). Rejected alternatives and why (judged against six mechanical
constraints):

- **C1 — modules discovered by `import.meta.glob` at build time**, not an import
  list (`audio/modules/index.ts:35` globs `./*.ts`; same in `video/modules`,
  `meta/modules`, `ui/modules-card-map.ts:26`). The glob is shallow + relative +
  **returns `{}` for a missing dir without failing the build**. A *second
  optional glob root* at a private overlay path naturally yields zero private
  modules in a public checkout — free stubbing, no conditional code. (Applies to
  server-side overlays; note client modules generally cannot be private.)
- **C2 — attest bases straddle the boundary.** `scripts/webgl-attest-lib.ts`
  hashes `lib/video/**` + WebGL cards + `AUDIO_WEBGL_MODULE_DEFS`;
  `scripts/collab-attest-lib.ts` hashes `packages/server/src` + `lib/multiplayer`
  + specific `graph/*.ts` + `lib/doom/doom-*.ts`. The `docs-hash-ignore:start/end`
  markers already prove the basis is surgically scoped — exclude the private glob
  root from the public basis; give private content its own attest.
- **C3 — DSP dist + ART baselines cross-hashed** (`scripts/dsp-src-hash.sh`,
  `art/baselines/**/*.f32` SHA-pinned). Since DSP source now stays public
  (§3B/§5), this constraint mostly evaporates for the private tier — but any
  future private *server* worklet would need its source + `.f32` pin co-located.
- **C4 — LFS is repo-scoped** (`.gitattributes`: ART `.f32/.wav`, VRT PNGs,
  `*.wasm`, 39 MB Blood set). Private content takes its LFS objects into the
  submodule's own store. (Blood/SNES9x LFS = quarantine, not moat.)
- **C5 — real deploy needs the whole assembled tree** — deploy/main CI
  reconstitutes public+private (submodule checkout via deploy key) before `task
  build`; the **public tree must still build alone** (Review P2-2).
- **C6 — hand-maintained central lists enumerate ALL modules**
  (`docs/module-manifest.ts` DESCRIPTIONS, `docs/strict-docs.ts`,
  `e2e/vrt/vrt-exemptions.ts`, per-module-per-port spec lists,
  `modules-card-map.test.ts` EXPECTED_NODE_TYPES) + two generated goldens
  (`contract-lock.txt`, `module-docs.generated.ts`). Since client modules stay
  public this leak surface is smaller, but registry-derivation (PR #551) is still
  the right direction for any private *server* names.

**Option scorecard (dev-loop / CI / attest / deploy / contributor-build):**
- **A (multi-repo): rejected.** Breaks the glob + single-lockfile; triplicates
  flox/dsp-dist/LFS pipelines; splits attest source from its committed proof
  (C2); precedent (GitLab/Cal.com/PostHog) moved *away* from it.
- **C (private npm pkg): rejected for hidden content.** Fights C1 hardest; needs
  private-registry auth + a public stub. **Reasonable ONLY for the MIT SDK** (a
  genuinely publishable, AGPL-import-free library).
- **B (submodule) + D (absence-tolerant overlay): chosen.** D = build tolerates
  the private submodule's absence; B = how private content is stored/versioned.

**Impact if B+D adopted:**
- **Dev loop:** preserved — one flox env, one lockfile, `task test:one`/`e2e:one`
  fast loops intact. Cost: submodule ergonomics (pinned SHA, detached HEAD,
  LFS-in-submodule).
- **CI:** deploy/main CI adds `submodules: true` + deploy key; **fork/public CI
  runs the stubbed build and becomes the standing proof the open experience
  works** (a feature, and a §13 self-buildability guarantee). The
  `dsp-build`-once → downstream-restore optimization survives (DSP stays public).
- **Attest:** private (server) content carries its own attest in the submodule;
  public bases exclude the overlay path → public attest stays green without
  seeing private source.
- **Deploy:** near-unchanged — materialize submodule, then normal `task build` →
  wrangler/Fly.
- **Contributors:** clone the public tree, build the full open experience
  (private = server business logic only; DOOM/Blood already fall back to "not
  built" overlays). No secrets leak.

**MIT tier mechanics:** per-package `LICENSE` + `license` field (present-shell
already demonstrates this) **plus a CI dependency-boundary lint proving zero
AGPL/GPL imports** (Review P1-1). If ever published as a real reusable SDK, that
package can be published to a public registry as MIT.

---

## 8. Phased execution plan (mid-priority, incremental, lowest-risk first)

**Phase 0 — Near-free correctness/compliance (no restructuring, do first).**
1. Fix header mislabels: `packages/dsp/src/grids.ts` (GPLv3, not MIT — the
   dangerous direction) and `cocoadelay-core.ts` (MIT, not GPL-3.0).
2. Vendor the OFL-1.1 text beside `static/fonts/Bravura.woff2`; ensure the
   client build ships a complete MIT/BSD/GPL notice manifest (Review P2-4).
3. ⚖️ Add an in-app §13 **"Source" link** surfacing the repo to interacting
   users (counsel confirms wording/scope + what Corresponding Source includes,
   incl. build tooling).
4. Audit that **no secret leaks into a `VITE_*`** var (client-exposed) — verify
   the `$env/dynamic/private` vs `VITE_*` boundary is clean.
5. ⚖️ **Quarantine SNES9x + Blood BUILDLIC now** (Review P0-1): keep
   user-supplied/optional, never bundle into paid/private tier, never relabel
   MIT, carry verbatim license text; escalate the non-free/non-commercial vs.
   paid-tier conflict to owner/counsel (highest commercial risk).
6. ⚖️ Confirm sole-copyright-holder / CLA status (gates any MIT or proprietary
   relicense).
7. **Strike all "nonprofit reduces obligations" reasoning** wherever it appears
   in prior planning (Review P2-1).

**Phase 1 — Secret/server hardening (server-side, genuinely hideable, low
risk).**
8. Confirm `packages/server` has zero inbound imports from web (already
   verified) **and audit its outbound imports of AGPL graph/CRDT types** — the
   private backend must import zero AGPL source to escape §13 (Review P0-2). Add
   the CI dependency-boundary lint here.
9. Collapse the duplicated business logic: `lib/server/{rackspaces,
   rackspaces-capacity,home-auth}` mirrors `packages/server/{capacity,auth,
   rack-access}` — plan a single shared private module (on a clean, AGPL-free
   API) before the physical split so two copies don't drift.
10. Keep secrets exactly as-is (already walled); document invite-signing-secret
    rotation as the invite-revocation primitive (in
    `runbooks/secrets-and-accounts.md`, where the names live).

**Phase 2 — Detangle the architectural knot (enables ANY clean cut; do before
moving files).**
11. **Risk #1 (load-bearing):** invert the registry-singleton import in
    `graph/snapshot.ts:29-31` (also `graph/persistence.ts`,
    `graph/control-surface-params.ts`) to dependency-injected
    `resolvePortType`/registry accessor. Detaches the graph/engine SDK from the
    concrete catalog — the prerequisite for the MIT kernel.
12. Relocate misfiled module logic out of `graph/`: `graph/toybox-*.ts` (7 files)
    + `graph/vfpga-runner.ts` → their module homes; move the reusable
    `doom/cv-gate-edge.ts` (imported by 11 files) to a neutral SDK utility and
    audit vs. `audio/edge-detect.ts`. **Note:** anything DOOM-derived stays
    GPLv2 — the *neutral* utility must be original, not lifted from GPL netcode
    (Review P1-2).
13. **Risk #2:** plan the factory-injected persistent-state handle so the 28
    audio + 3 video modules stop importing the live `graph/store` singleton
    directly (also fixes the Y.Doc write-storm class).

**Phase 3 — Registry-derive the central lists (removes name-leak blocker, C6).**
14. Extend the PR-#551 glob/registry-driven approach from *registration* to
    DESCRIPTIONS, STRICT_DOCS, VRT exemptions, per-port spec lists, and
    `modules-card-map.test.ts` EXPECTED_NODE_TYPES — so any private *server*
    names never appear publicly; goldens (`contract-lock.txt`,
    `module-docs.generated.ts`) regenerate per-tier via `task docs:accept`.

**Phase 4 — Introduce the overlay seam (B+D), still all-public content.**
15. Add **one extra optional glob root** per registry pointing at a private
    overlay dir (missing dir → `{}` → no conditional). Validate the tree builds
    **identically** with the overlay empty (this is the §13 self-buildability
    proof — Review P2-2).
16. Wire deploy/main CI checkout for `submodules: true` (deploy key), leave
    fork/public CI without it — verify the stubbed build is green.
17. Add the **CI dependency-boundary lint** (private + MIT packages import zero
    AGPL/GPL) as a required gate (Review P0-2/P1-1).

**Phase 5 — Move the first genuinely-private content into the submodule
(server-side ONLY).**
18. Move the **server business logic** (`packages/server/src/{capacity,
    rack-access,reaper,auth}.ts` + `lib/server/*` on the clean API) into the
    submodule with its own attest. **Do NOT move DSP source, client modules, or
    any DOOM/Blood-derived code.**
19. Handle the game components as **quarantine**, not moat: keep GPLv2 shims
    public (source-offer obligation), keep SNES9x/Blood non-free content
    user-supplied/optional. The 39 MB Blood LFS set may move to the submodule's
    LFS store for repo-size reasons, but this is quarantine bookkeeping, not
    "hiding critical IP."
20. ~~DSP-source privacy via prebuilt-dist + minify~~ — **REMOVED** (Review
    P0-3/P2-2: violates §13; DSP stays public + buildable).

**Phase 6 — Carve the MIT SDK (optional, contribution-facing, gated on Phase
2).**
21. After `Canvas.svelte` is decomposed enough to expose the reusable UI kit,
    extract the MIT SDK package (types + `gate-trigger`/`edge-detect` +
    worklet-build helpers + `new-module` scaffold) with its own `LICENSE`/
    `license` field **and a green boundary-lint proving zero AGPL/GPL imports**
    (Review P1-1). Per-worklet Faust-stdlib license audit before labeling any DSP
    output MIT (Review P2-3). Largest mechanical effort; last, and only if
    external contribution is a real goal.

Each phase is independently shippable and reversible; nothing after Phase 0 is
required for compliance (except that Phase 0 items 3/5/7 ARE compliance).

---

## 9. Risks + open questions

**Legal (⚖️ counsel):**
- **SNES9x non-free "personal use only" + Blood BUILDLIC non-commercial vs.
  Clerk paid tiers** — potentially blocks commercial operation *regardless of the
  split*; hiding does not cure it; resolve before monetizing (Review P0-1).
- Helm exact grant (GPL-3.0-only blocks the "AGPL port" label from being a true
  relicense).
- Sole-copyright / CLA status — the entire MIT-carve and any proprietary grant
  depend on it.
- §13 source-offer sufficiency (in-app link; what Corresponding Source must
  include — **including build tooling** — across three deploy surfaces; Review
  P2-2).
- Aggregation theory for the GPLv2 engines — re-review if any boundary tightens.
- Whether any specific hidden component lands on the aggregation vs. derivative
  side (code-split/worklet/dynamic-import gray zone; Review P0-2).
- Trademark handling if the project ever visibly splits.

**Technical / process:**
- **Repo-privacy buys NOTHING for client-side IP**, and minify-and-withhold of
  first-party AGPL DSP is an affirmative §13 violation — not "weak protection"
  (Review P0-3/P2-2). Manage expectations: hiding = server-side only; client =
  public, full stop.
- **The private tier is a combined work unless proven arm's-length** (separate
  service, substitutable API, zero AGPL imports) — enforce via CI boundary lint
  or the "private" code owes source (Review P0-2).
- **DOOM/Blood netcode is GPLv2-derived → cannot be the moat** (Review P1-2);
  the crown-jewel-netcode instinct is a legal trap here.
- **AGPL tree must stay self-buildable** — moving build tooling/codegen/DSP-build
  private breaks Corresponding Source (Review P2-2).
- **Attest fragility:** any private (server) module changes a public-basis hash
  unless the overlay path is excluded and per-tier attest is set up correctly
  (C2). Get this wrong and public CI goes red.
- **Submodule ergonomics + LFS-in-submodule** add contributor friction;
  detached-HEAD/pinned-SHA mistakes are common.
- **MIT notice retention** — the client build must not strip MIT/BSD/GPL notices
  (Review P2-4); `OssAttribution.svelte` must be complete.
- **`Canvas.svelte` (5,816 lines)** and the **28+3 store-coupled modules** are
  the biggest mechanical efforts; the MIT-kernel carve is blocked until the
  Phase-2 detangle lands.
- **Worktree/CI budget:** the split multiplies CI checkout/attest paths; monitor
  wall-time (>2 min additions need owner sign-off per repo standard).

**Open questions for the owner:**
1. Is the goal *anti-competitive protection* (a source-available license like
   BSL/FSL might beat a physical split) or genuine *hiding* of specific server
   logic? The former is a license change, not a restructuring — and it is the
   only realistic lever for client-side DSP/video, since that code cannot be
   hidden.
2. Is external contribution actually wanted (justifies the MIT SDK carve in
   Phase 6) or is "MIT side" aspirational?
3. Given DSP/video is client-side and unhideable (and AGPL-source-obligated), is
   the owner comfortable with it being fully public + reverse-engineerable, or
   does this change the appetite for a source-available relicense?
4. Commercial intent — this decides whether the SNES9x/Blood non-free clauses are
   a hard blocker or moot.

---

## 10. Legal review: resolved concerns + still-open (lawyer) questions

**Resolved in this final (draft corrections applied):**
- **P0-1 SNES9x non-free.** Reclassified from "effective GPLv2 floor + personal
  use" to **NON-FREE / non-relicensable**: cannot be MIT, cannot be a
  private/paid-tier moat, must stay user-supplied/optional with verbatim license.
  The "DOOM precedent" explicitly does **not** transfer. (§2 table, §3C, §4, §5,
  §9, Phase 0.5.)
- **P0-2 AGPL §13 boundary.** Private tier redefined as a **provable
  arm's-length service** (separate process + substitutable documented API + zero
  AGPL imports + independently usable); worklet / code-split / dynamic-import are
  explicitly NOT boundaries; a CI dependency-boundary lint is now a required gate
  (Phase 1.8, Phase 4.17). (§3C, §6, §7, §9.)
- **P0-3 client JS unhideable.** All "hidden client" language downgraded to
  "obfuscated"; the DSP-privacy-via-minify plan is **struck** and additionally
  flagged as a §13 violation for first-party AGPL code. Only server code is
  hideable. (§1, §5 table row P1→REMOVED, §9.)
- **P1-1 MIT contamination.** MIT tier is valid only with own `license` field +
  zero AGPL/GPL imports proven by CI; the MI-derived modules are upstream MIT but
  our AGPL glue is not. (§3A, §4, §6, §7, §9.)
- **P1-2 GPL-derived placement / netcode.** DOOM/Blood shims (`net_pt.c`,
  `doomgeneric_patchtogether.c`) and the multiplayer lockstep netcode stay
  GPLv2 — cannot be MIT or private; the netcode cannot be the moat. (§2 table,
  §3B/§3C, §4, §5, §9.)
- **P2-1 nonprofit ≠ safe harbor.** Struck as a mitigating factor everywhere;
  obligations are orthogonal to entity type. (§6, Phase 0.7, §9.)
- **P2-2 Corresponding Source completeness.** AGPL public tree must remain
  self-buildable; build tooling/codegen/DSP-build cannot move private; the
  empty-overlay build is the self-buildability proof. Draft Phase-5 DSP-privacy
  step removed. (§1, §6, §7 C5, Phase 4.15, Phase 5.20, §9.)
- **P2-3 Faust/DSP generated licensing.** Per-worklet Faust-stdlib license audit
  required before any MIT label on DSP output. (§2 table, §3A, Phase 6.21.)
- **P2-4 MIT/BSD notice retention.** Client build must ship a complete notice
  manifest; `OssAttribution.svelte` completeness required. (§4, Phase 0.2, §9.)

**Still-open (require a lawyer before shipping under new labels):**
1. **SNES9x + Blood non-commercial/non-free vs. Clerk paid tiers** — most urgent
   commercial-risk item; may block monetization independent of the split.
2. **Helm grant scope** (GPL-3.0-only vs -or-later) and validity of the
   "relicensed to AGPL" label on `helm.ts`.
3. **Sole-copyright / CLA confirmation** — gates any MIT carve or proprietary
   grant on first-party code.
4. **§13 mechanics** — sufficiency of the in-app source offer and the exact
   contents of Corresponding Source (incl. build tooling) across CF Pages bundle,
   Fly relay, and Workers.
5. **Aggregation vs. derivative** classification for any specific proposed hidden
   component (the code-split/worklet/dynamic-import gray zone).
6. **GPLv2 ↔ AGPLv3 aggregation theory** for DOOM/Blood — re-review if any
   boundary tightens (bundling, shared memory, source sharing).
7. **Trademark/branding** (`patchtogether.live`, `2600hz`) if the project ever
   visibly splits.

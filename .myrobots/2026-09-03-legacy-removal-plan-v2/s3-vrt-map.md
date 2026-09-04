# S3 — the VRT slice: the dependency map, measured

**Status:** ⚠ EVIDENCE, NOT INSTRUCTION (`.myrobots/` per AGENTS.md). NOT STARTED.
**Derived at** `f5ead8c58` (drain 41), from the tree — not from the plan's prose.
**Why this file exists:** S3 is the one slice whose cost is not in its own file. Every
number below was re-measured; a successor should spot-check rather than re-derive.

## The lane is TWO FILES, and that is the whole shape of S3

`e2e/vrt/vrt.config.ts:106` — `STRICT_MATCH = ['vrt.spec.ts', 'workflow-shell-faces.spec.ts']`.

Those are the only two specs in the REQUIRED `vrt-strict` lane. Everything else
under `e2e/vrt/` (31 further spec files) runs in **no CI job at all** — they are
`FULL_MATCH` members, and `FULL_MATCH` is only exercised by `task vrt:update`,
the baseline CAPTURE path. So:

* re-pointing a non-`STRICT_MATCH` vrt spec buys ZERO required-lane signal;
* deleting one costs ZERO required-lane coverage;
* the required lane's cost after S4 is whatever survives in those two files.

⚠ Do not confuse `e2e/tests/workflow-shell-faces.spec.ts` (an ordinary e2e spec,
already drained) with `e2e/vrt/workflow-shell-faces.spec.ts` (the face scenes,
and half the strict lane). `vrt.config.ts` has `testDir: '.'` relative to
`e2e/vrt/`, so `STRICT_MATCH` names the vrt one.

## `vrt.spec.ts` IS the card sweep, and nothing else

`test.describe('VRT: every module card matches its baseline')` with a single
`for (const mod of COVERED_MODULES)` loop, booting `/rack?shell=legacy&seed=none`
and capturing one element screenshot per module. It has no other describe.

Under owner ruling 5 ("vrt-strict card half DELETED") the whole file goes, and
with it:

| artefact | count |
|---|---:|
| `e2e/vrt/__screenshots__/vrt.spec.ts/*.png` | **131** |
| `vrt-strict-timings.generated.json` rows naming it | 46 |
| total vrt baselines in the repo, for scale | 630 |

Its three exemption tables (`EXEMPT_FROM_VRT` 66, `STRICT_VRT_MODULES` 45,
`VRT_MODULE_MASKS` 31) live in `e2e/vrt/vrt-exemptions.ts`.

## The interlock — 47 files reference `vrt.spec.ts`

Most are PROSE (a face scene explaining why it exists given what the card scene
covered). Those are S5 archaeology. The ones that are CODE and will red:

| file | why it reds |
|---|---|
| `scripts/vrt-shard-plan.test.ts` | 9 refs; hard literals incl. `'vrt.spec.ts :: adsr card matches baseline'` (:142) and synthetic `zzbrandnew`/`polarizer`/`depolarizer` fixtures. Re-anchor onto `workflow-shell-faces.spec.ts`, which already appears at :219. |
| `scripts/vrt-gallery.test.ts` | 18 refs; imports `STRICT_VRT_MODULES` (:80) as its **vacuity tripwire** — the anchor is deliberately a list of NAMES, not a count (:246 explains why). Needs a new anchor with the same property. |
| `packages/web/src/lib/audio/modules/vrt-meta.test.ts` | asserts every `STRICT_VRT_MODULES` entry has a committed `vrt.spec.ts/<type>.png`. |
| `scripts/vrt-accept-manifest.test.ts` | 15 refs |
| `scripts/vrt-shard-coverage.test.ts` | 10 refs |
| `scripts/vrt-scope.test.ts` / `.mjs` | 5 / 3 refs |
| `scripts/vrt-accept.test.ts`, `vrt-changeset-gallery.test.ts` | 3 each |
| `packages/web/src/lib/ui/vrt-cable-stripe.{ts,test.ts}` | UNIT lane, reads `__screenshots__` directly. The brief is explicit: **dies in the SAME commit as the baselines it reads**, not in S4. |
| `e2e/vrt/vrt-legacy-mask-audit.spec.ts` | the only other real importer of `VRT_MODULE_MASKS` / `EXEMPT_FROM_VRT`; family (c), dies with the sweep. |
| `e2e/vrt/vrt.config.ts` | `STRICT_MATCH` + `FULL_MATCH` both name it. |
| `e2e/vrt/build_gallery.py` | 4 refs |
| `scripts/test-ledger.mjs`, `scripts/test-reconciliation.mjs` | 1 each |

## Sequencing that avoids a red intermediate

1. `vrt-cable-stripe.{ts,test.ts}` + `vrt-legacy-mask-audit.spec.ts` + `vrt.spec.ts`
   + its 131 baselines + the three tables, in ONE commit.
2. Same commit: `vrt.config.ts` (`STRICT_MATCH` becomes one file), the six
   `scripts/vrt-*.test.ts` re-anchors, `vrt-meta.test.ts`, `build_gallery.py`,
   and the 46 `vrt-strict-timings` rows.
3. Only then the prose sweep across `_shell-faces.ts` etc. (S5).

⚠ `scripts/vrt-gallery.test.ts`'s tripwire is the one to think about rather than
mechanically re-point: its whole argument (:243-254) is that an anchor must be
checkable against the tree, must not need maintenance as baselines come and go,
and must fail with a NAME. Replacing it with a count would be a regression the
file itself argues against.

## What S3 does NOT need

* No baseline RECAPTURE for the card sweep — it is deleted, not re-pointed, so
  no `vrt-update` dispatch is spent on it.
* No owner preview for deleted scenes. The look-changes ruling covers RE-POINTED
  visual scenes; the renderer-content families (`cube-adsr-composite`,
  `vrt-synesthesia-*`, `vrt-wavesculpt-*`, `vrt-colourofmagic`, `vrt-toybox`,
  `vrt-composite*`, `cellshade`/`mirrorpool`/`pentemelodica`,
  `vrt-karplus-tomtom-states`, the probes) DO need it — and they are all
  non-`STRICT_MATCH`, so they run in no CI job and can be sequenced after the
  required lane is settled.

---

# S5 archaeology — sizing, measured at `4a0c745173`

Owner ruling 2 is "remove ALL references to the idea legacy ever existed", which is
stronger than "stop reading the param". Two measurements a successor should have
before planning that sweep:

| surface | count | note |
|---|---:|---|
| module def files whose prose says "the card" / "this card" / "its card" / "on the card" | **236** | ⚠ **USER-FACING.** These are `description` / per-param doc strings rendered on the docs pages, not code comments. e.g. numpadPlus's description ends "While the card is focused it captures the Numpad keys exclusively". A player reads these. |
| non-e2e files containing `shell=legacy` | 20+ | incl. `Canvas.svelte`, `strict-faces.ts`, `legacy-fallback.ts`, `shell-cells.ts`, `dom-source-modules.ts`, `WorkflowTopbar.svelte`, `AudioIoSurface.svelte` |

The 236 are the item to size honestly: they are prose a user reads, so they cannot be
regex-swept ("card" → "tile") without reading each one — several describe a physical
eurorack panel, where "card" is not the UI noun at all.

`docs:accept` regenerates the docs artefacts from these strings, so the sweep and the
accept run go together.

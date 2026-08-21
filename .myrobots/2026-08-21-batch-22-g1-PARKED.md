# batch-22 G1 — PARKED mid-build on the #2088 owner pivot (2026-08-21)

Branch `faces/batch-22-g1-video-knob-banks`. Four video faces (edges, colorizer,
inwards, vdelay) are BUILT but UNVERIFIED — no gate has been run against them yet.

## What is done

- 4 defs carry a `face` block (`order`, `paramCells` all-`fader`, `glyph: 'none'`,
  `extension`).
- 4 × `$lib/ui/modules/<id>/{shell-extension.ts, <Name>OutputBody.svelte}` —
  preview canvas + SCREEN ON/OFF over `previewCollapsed`, keeping `markWatched`
  alive while collapsed (#2015).
- 4 promoted in `STRICT_FACES`; 4 roster entries in `e2e/vrt/_shell-faces.ts`
  with `videoFaceWhy`, `inwards` additionally pinning `__videoEngineFreezeTime`.

## What is NOT done — do these first on resume

- `face:inventory:accept` (dispositions still say `generic-face` for all four).
- `task face:check`, `typecheck`, the module suites, the VRT roster unit gates.
- No VRT capture dispatched. No PR opened.

## Two findings worth keeping

1. **The group was scoped as "knob banks" and they are FADER banks.** All twelve
   params render `NeonFader` on their cards. Hence `paramCells: {...'fader'}` on
   every face — an undeclared face resolves a fader to a KNOB, and no def-reading
   gate can see the swap. On `colorizer` it would also have falsified shipped
   prose ("dial the three faders").
2. **`inwards` is the only one that animates at rest** (SOURCE, `uTime`, Speed
   0.5). Its scene pins the engine clock via `simPin` rather than gaining a
   `freeze` ParamDef, to keep the batch zero-attest. ⚠ The roster's 4plexvid note
   steers toward a `freeze` param for clock-driven modules; the entry argues why
   the stateless case differs. **This is the one decision to re-confirm on
   resume** — it was never gate-verified.

Issues #2089 (scoreboard solo) and #2090 (onetonine declared-vs-rendered) were
filed before the park. Derivation: `.myrobots/2026-08-21-batch-22-video-thin-tail-derivation.md`.

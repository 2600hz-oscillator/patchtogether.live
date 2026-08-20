// e2e/tests/_face-quiesce.ts
//
// PER-DEF QUIESCE for the faces-parity sweep — the declaration that lets a face
// whose module runs an expensive LIVE pipeline be driven without the sweep
// competing with it for the page's main thread.
//
// ⚠ WHY THIS EXISTS, MEASURED TWICE ON CI. `faces-parity` walks every cell of a
// face and drives it, and each drive is a Playwright round trip — a
// `locator.evaluate` for the cell's centre, then an auto-retrying poll for the
// commit. Those run ON THE PAGE'S MAIN THREAD, the same thread the module's own
// render loop is using. For most faces that is free: a knob and a static plate
// cost nothing between round trips. For a module that recomputes a large field
// every frame it is not free at all, and the two starve each other — the sweep
// slows the module, the module slows the sweep, and the row runs out of budget
// having driven half its cells.
//
// `foxy` is the first face to hit it: 33 cells over a module that rebuilds a
// 256x256 volumetric heightfield ~24x/second and scans it into a 64x256
// wavetable. Observed on CI twice — once recovering on retry, then failing BOTH
// attempts at `Test timeout of 144000ms exceeded`, stopped at the drag-commit
// poll partway through the cell walk.
//
// ⚠ AND THE BUDGET WAS ALREADY THE RIGHT SHAPE, which is why this is a hook and
// not a bigger number. `faces-parity` derives its per-row timeout as
// `FACE_FIXED_MS + FACE_PER_CELL_MS * cells.length` — already scaled by work,
// already 3 s/cell under SLOW_RENDER, and 45 s + 3 s x 33 IS the 144 s that
// blew. Raising `FACE_PER_CELL_MS` would be a flat multiplier across every
// faced module to accommodate one module's render loop, which buys a slower
// failure and hides the cost instead of removing it.
//
// ── WHAT A QUIESCE MAY AND MAY NOT BE ──────────────────────────────────────
//
// It installs ONE boot-time global, via `addInitScript` BEFORE `goto`, so the
// flag is set before any module factory runs and can be read at CONSTRUCTION.
// That is the `simPin` contract from the VRT face harness (`e2e/vrt/
// _shell-faces.ts`), deliberately the same shape so there is one idea here and
// not two.
//
// ⚠ IT MUST NOT DISABLE THE THING UNDER TEST. This sweep's subject is the CELL
// SURFACE — does every declared control render, and does driving it move the
// graph. A quiesce may stop a module's own animation; it may NOT touch
// `setParam` / `readParam`, the cells, or the faceplate's structure, because
// those are exactly what the row asserts. A flag that made the row pass by
// making it measure less would be the blind-gate failure this repo keeps
// writing down, so each entry states which of the two it stops.
//
// ⚠ DENY BY DEFAULT. A face with no entry is driven live, which is the correct
// default and what every other faced module gets. `faces-parity` asserts both
// directions over this roster: an entry naming a module that is not in
// STRICT_FACES is RED (a stale name cannot sit here unnoticed), and the `why`
// is REQUIRED BY THE TYPE, so `tsc` refuses a bare `{ global, value }`.
//
// ⚠ THE SPEC NEVER NAMES A MODULE. It reads this roster by the type it is
// already iterating, which is what keeps the sweep registry-driven: a future
// face adopts a quiesce by adding an entry here, with no edit to the sweep.

/** One face's boot-time quiesce declaration. */
export interface FaceQuiesce {
  /** The `globalThis` property the module reads at CONSTRUCTION. */
  readonly global: string;
  /** The value to install. */
  readonly value: number;
  /**
   * REQUIRED, and `tsc` refuses the entry without it. Two things it must say:
   * what the module does that competes with the sweep, and WHAT THE FLAG STOPS
   * — specifically that it does not stop the cells the row is asserting on.
   */
  readonly why: string;
}

/** `moduleType` → its quiesce. Absent = driven live (the default). */
export const FACE_QUIESCE: Readonly<Record<string, FaceQuiesce>> = {
  foxy: {
    global: '__foxyVrtSeed',
    value: 1,
    why:
      'FOXY rebuilds a 256x256 volumetric heightfield from three rasters and scans it into a '
      + '64x256 wavetable ~24x/second, ALL on the page main thread (the video stages are pure '
      + 'CPU by design — this is an AUDIO def and the engine has no GL context). The parity row '
      + 'drives 33 cells, and every drive is a main-thread round trip, so the sweep and the '
      + 'rebuild starve each other: observed on CI as a recovered-on-retry flake and then as a '
      + 'BOTH-ATTEMPTS failure at the 144 s derived budget, stopped at the drag-commit poll '
      + 'partway through the cell walk. '
      + '⚠ WHAT THE FLAG STOPS, AND WHAT IT LEAVES ALONE. `__foxyVrtSeed` is the determinism '
      + 'seed the module already carries for its VRT scenes: `bridgeTick` paints all three '
      + 'rasters ONCE from fixed synthetic waveforms and then SHORT-CIRCUITS on every later '
      + 'call, so the rebuild stops and the faceplate still shows a real, fully-built picture. '
      + 'It does NOT touch `setParam`, `readParam`, the cell surface or the band structure — '
      + 'those are separate handle methods the seed never reaches, and they are precisely what '
      + 'this row asserts. So the sweep still drives all 33 cells and still proves every one of '
      + 'them moves the graph; it just stops re-deriving a wavetable underneath itself while '
      + 'doing so.',
  },
};

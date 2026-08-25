// e2e/vrt/vrt-determinism-probe.spec.ts
//
// MEASUREMENT TOOL, not a gate. It asserts nothing about any face — it PRINTS,
// exactly like its sibling probes (vrt-fold-probe, vrt-face-audio-probe,
// vrt-frame-stability). What it DOES assert is its own instrument (see the two
// controls below), because a diff engine that silently reads zero is
// indistinguishable from a perfectly deterministic app.
//
// ── THE QUESTION ────────────────────────────────────────────────────────────
//
// Owner premise (2026-08-25): a Svelte web app's components CAN render
// deterministically every time, so every pixel of VRT tolerance is HIDING A BUG
// rather than accommodating physics. The gate today allows
//
//     DOCK_MAX_DIFF    = 1500 px      (_shell-faces.ts)
//     COMPACT_MAX_DIFF =  150 px      (documented as INERT — the config ratio binds)
//     threshold        = 0.1          (26/255 per channel, vrt.config.ts)
//     maxDiffPixelRatio= 0.01
//
// Before any of that can move, one number has to exist: HOW MANY FACE SCENES
// ARE ACTUALLY NON-DETERMINISTIC BOOT-TO-BOOT, on the renderer that gates
// (linux / SwiftShader)?
//
// The existing exact-diff audits (vrt-fold-probe's "exact diff of every
// committed dock baseline", vrt-face-audio-probe's compact sibling) answer a
// DIFFERENT question: SCENE-vs-COMMITTED-BASELINE. A non-zero row there is
// ambiguous — the baseline may simply be stale. This probe removes the
// baseline from the loop entirely: it boots the SAME face TWICE, in the SAME
// browser session, on the SAME machine, through the SAME scene code the gate
// runs, and diffs BOOT 1 against BOOT 2. There is nothing left for a non-zero
// row to mean except "this scene does not reproduce".
//
// ── WHY IT MIRRORS THE GATE'S SCENE EXACTLY ─────────────────────────────────
//
// Same viewport per tier (LEGACY_FOLD_VIEWPORT / foldViewportFor), same
// `bootWithFace` opts off the roster entry, same zoom + LOD tier, same
// openDock + unfoldDockPane, same freezeFaceAudio / freezeFaceVideo, same
// locators, same `animations: 'disabled'`. A probe that booted the scene even
// slightly differently would be authoritative about nothing — the shared-module
// argument in `_shell-faces.ts`'s own header.
//
// It also mirrors the ONE piece of `toHaveScreenshot` that is easy to forget:
// Playwright does not screenshot once, it re-screenshots until TWO CONSECUTIVE
// captures agree and only then compares. `settledCapture` below reproduces that
// (at threshold 0 — byte equality — rather than the gate's 26/255), so the
// image this probe diffs is the same KIND of image the gate diffs, and INTRA
// -boot instability is reported as its own column instead of leaking into the
// cross-boot number as noise.
//
// ── THE INSTRUMENT IS CONTROLLED IN BOTH DIRECTIONS, EVERY ROW ──────────────
//
// CLAUDE.md: "a wrong metric reads exactly like a finding", and "a passing
// negative control is NOT enough — prefer a POSITIVE control". Both run inside
// the same single decode pass as the real measurement, so they cost one
// `page.evaluate` between them and cannot be skipped for a row:
//
//   NEGATIVE — A vs A must be 0 differing pixels at threshold 1.
//   POSITIVE — A vs (A with ONE pixel's red channel moved by exactly ONE level)
//              must report diffPixels=1 and maxDelta=1. This is the sensitivity
//              claim stated as an assertion: the instrument can see the
//              smallest difference a PNG can express, on THIS image, at THIS
//              size. A diff engine that decoded to a blank ImageData, or
//              compared the wrong buffers, passes the negative control and
//              fails this one.
//
// Both are `expect`ed, so a broken instrument reddens the probe instead of
// reporting a clean, plausible, false "everything is deterministic".
//
// ── HOW TO RUN ──────────────────────────────────────────────────────────────
//
// Locally (macOS — a valid determinism measurement, since both boots are on
// the same machine; NOT a valid comparison against a linux baseline):
//
//   VRT_PROBE=1 npx --workspace e2e playwright test \
//     --config=vrt/vrt.config.ts vrt-determinism-probe --grep "zdet-g1-compact"
//
// On the renderer that gates (linux/SwiftShader) — the spec is temporarily also
// in FULL_MATCH so `vrt-update.yml`'s capture job selects it by `--grep`:
//
//   gh workflow run vrt-update.yml -f ref=<branch> -f grep=zdet-g1-compact
//
// It writes no snapshot, so `--update-snapshots=changed` has nothing to
// regenerate and the capture job's commit step finds an empty diff.
//
// ⚠ DOOM is not in this roster and is not reachable from it — `FACES` has no
// doom entry (it is in EXEMPT_FROM_VRT), so no DOOM spec, wait or budget is
// read or changed here.

import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  FACES,
  LEGACY_FOLD_VIEWPORT,
  bootWithFace,
  faceSceneTimeout,
  foldViewportFor,
  frameMember,
  freezeFaceAudio,
  freezeFaceVideo,
  openDock,
  settle,
  unfoldDockPane,
  type BootFaceOptions,
} from './_shell-faces';

/**
 * How many DISPATCH GROUPS the roster is round-robined into.
 *
 * NOT a population count — it is a PARALLELISM constant, and it is sized by
 * arithmetic rather than picked: `vrt-update.yml`'s capture job is ONE
 * unsharded 125-minute job, and the roster's own measured scene costs
 * (`_shell-faces.ts`'s FACE_SCENE_WEIGHT table: 7.0-10.4 s for a face with no
 * live video surface, 13.2-36.7 s for one that declares `videoFaceWhy`) put two
 * boots of both tiers of the whole roster well past that ceiling. Four groups
 * put every group inside it with room, and each group is dispatched against its
 * own ref so the four run in parallel.
 *
 * Round-robin rather than contiguous slices: the video faces arrive in BATCHES
 * in the roster, so a contiguous split would put the expensive half in one
 * group. `i % GROUPS` spreads them by construction.
 */
const GROUPS = 4;

type Tier = 'compact' | 'dock';

interface DiffDetail {
  width: number;
  height: number;
  /** -1 when the two captures are not even the same size. */
  diffAt1: number;
  diffAt26: number;
  maxDelta: number;
  box: { x0: number; y0: number; x1: number; y1: number } | null;
  /** NEGATIVE CONTROL: A vs A at threshold 1. Must be 0. */
  selfDiff: number;
  /** POSITIVE CONTROL: A vs A-with-one-channel-moved-by-one. Must be 1. */
  posDiff: number;
  /** POSITIVE CONTROL: the max channel delta that perturbation produced. Must be 1. */
  posMaxDelta: number;
}

/**
 * Decode both captures ONCE in the page and report the real diff plus both
 * controls off the same buffers.
 *
 * In-page decode via <img> + a scratch canvas, for the reason
 * `vrt-surface-stats.diffRegion` already states: the only node-side PNG decoder
 * reachable here is an undeclared transitive of Playwright's own tree. This
 * function is a superset of `diffRegion` (max channel delta + both controls in
 * one pass) and is local to the probe rather than a widening of the shared
 * helper, so nothing on the gate path changes to take a measurement.
 */
async function diffDetail(page: Page, a: Buffer, b: Buffer): Promise<DiffDetail> {
  return page.evaluate(
    async ({ aB64, bB64 }) => {
      const decode = async (b64: string): Promise<ImageData> => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        if (!ctx) throw new Error('zdet: no 2D context for the scratch canvas');
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(0, 0, c.width, c.height);
      };
      const A = await decode(aB64);
      const B = await decode(bB64);

      // Both controls run on A alone, so they are defined even when the two
      // captures differ in SIZE (itself a determinism finding, reported as -1).
      const perturbed = new Uint8ClampedArray(A.data);
      // XOR 1 moves the channel by exactly one level in whichever direction
      // does not clip — 255 -> 254, 0 -> 1. A "+1" would clip on a white pixel
      // and silently make the positive control measure nothing.
      perturbed[0] = A.data[0] ^ 1;

      const count = (
        x: Uint8ClampedArray,
        y: Uint8ClampedArray,
        thr: number,
      ): { n: number; max: number; box: { x0: number; y0: number; x1: number; y1: number } | null } => {
        const W = A.width;
        const H = A.height;
        let n = 0;
        let max = 0;
        let x0 = W;
        let y0 = H;
        let x1 = -1;
        let y1 = -1;
        for (let py = 0; py < H; py++) {
          for (let px = 0; px < W; px++) {
            const i = (py * W + px) * 4;
            const d = Math.max(
              Math.abs(x[i] - y[i]),
              Math.abs(x[i + 1] - y[i + 1]),
              Math.abs(x[i + 2] - y[i + 2]),
              Math.abs(x[i + 3] - y[i + 3]),
            );
            if (d > max) max = d;
            if (d < thr) continue;
            n++;
            if (px < x0) x0 = px;
            if (px > x1) x1 = px;
            if (py < y0) y0 = py;
            if (py > y1) y1 = py;
          }
        }
        return { n, max, box: n === 0 ? null : { x0, y0, x1, y1 } };
      };

      const self = count(A.data, A.data, 1);
      const pos = count(A.data, perturbed, 1);

      if (A.width !== B.width || A.height !== B.height) {
        return {
          width: A.width,
          height: A.height,
          diffAt1: -1,
          diffAt26: -1,
          maxDelta: -1,
          box: null,
          selfDiff: self.n,
          posDiff: pos.n,
          posMaxDelta: pos.max,
        };
      }
      const d1 = count(A.data, B.data, 1);
      const d26 = count(A.data, B.data, 26);
      return {
        width: A.width,
        height: A.height,
        diffAt1: d1.n,
        diffAt26: d26.n,
        maxDelta: d1.max,
        box: d1.box,
        selfDiff: self.n,
        posDiff: pos.n,
        posMaxDelta: pos.max,
      };
    },
    { aB64: a.toString('base64'), bB64: b.toString('base64') },
  );
}

interface SettledCapture {
  png: Buffer;
  /** true when two CONSECUTIVE captures came back byte-identical. */
  settled: boolean;
  /** how many screenshots it took. */
  tries: number;
}

/**
 * `toHaveScreenshot`'s settle loop, reproduced at ZERO tolerance.
 *
 * The gate re-screenshots until two consecutive captures agree at 26/255 before
 * it compares anything. Reproducing that here is what keeps INTRA-boot motion
 * out of the CROSS-boot number: without it, an animating scene would report a
 * large cross-boot diff that is really two arbitrary phases of the same
 * animation, and the two causes need opposite fixes.
 *
 * Byte equality rather than a pixel compare: it is free (no page round-trip),
 * and it is strictly stronger — byte-identical PNGs are pixel-identical.
 * A scene that never converges is reported as `settled: false` rather than
 * retried forever; that is itself the finding.
 */
async function settledCapture(el: Locator, max = 4): Promise<SettledCapture> {
  let prev = await el.screenshot({ animations: 'disabled' });
  for (let i = 2; i <= max; i++) {
    const next = await el.screenshot({ animations: 'disabled' });
    if (next.equals(prev)) return { png: next, settled: true, tries: i };
    prev = next;
  }
  return { png: prev, settled: false, tries: max };
}

/**
 * ⚠ THE INSTRUMENT'S OWN STATED BLIND SPOT, AND THE CONTROL FOR IT.
 *
 * Both boots run in ONE Playwright context, so the second one meets whatever
 * the first left behind. `bootWithFace` starts by navigating to `/rack` — a
 * REAL document navigation, so every scrap of in-memory app state is torn down
 * — but localStorage, sessionStorage, IndexedDB and the HTTP/font cache all
 * survive it. If boot 2 were matching boot 1 because it INHERITED something,
 * this probe would read "deterministic" for the same reason the scene is
 * broken: the classic gate-whose-precondition-is-the-defect shape.
 *
 * `ZDET_WIPE_STORAGE=1` wipes all of it between boots. Run a subset both ways:
 * numbers that do not move mean persisted state is not what is holding the two
 * captures together. It is a CONTROL, deliberately not the default — the gate
 * itself captures against a baseline taken on a warm CI runner, so the
 * warm-cache boot is the faithful one and the cold one is the check on it.
 */
async function wipeStorage(page: Page): Promise<void> {
  await page.context().clearCookies();
  await page.evaluate(async () => {
    localStorage.clear();
    sessionStorage.clear();
    const dbs = (await indexedDB.databases?.()) ?? [];
    await Promise.all(
      dbs.map(
        (d) =>
          new Promise<void>((resolve) => {
            if (!d.name) return resolve();
            const req = indexedDB.deleteDatabase(d.name);
            req.onsuccess = req.onerror = req.onblocked = (): void => resolve();
          }),
      ),
    );
    if (globalThis.caches) {
      for (const k of await caches.keys()) await caches.delete(k);
    }
  });
}

/**
 * ONE boot of ONE scene, byte-for-byte the sequence
 * `workflow-shell-faces.spec.ts` runs for that tier.
 */
async function captureScene(
  page: Page,
  type: string,
  tier: Tier,
  pages: number,
  bootOpts: BootFaceOptions,
): Promise<SettledCapture> {
  const label = `zdet-${type}-${tier}`;
  if (tier === 'compact') {
    await page.setViewportSize(LEGACY_FOLD_VIEWPORT);
    const memberId = await bootWithFace(page, type, bootOpts);
    await frameMember(page, memberId, 0.45, 'compact');
    await freezeFaceAudio(page, label);
    if (bootOpts.videoFaceWhy) await freezeFaceVideo(page, memberId, label);
    return settledCapture(
      page.locator(`.svelte-flow__node[data-id="${memberId}"] [data-testid="module-shell"]`),
    );
  }
  await page.setViewportSize(foldViewportFor(type));
  const memberId = await bootWithFace(page, type, bootOpts);
  await frameMember(page, memberId, 0.7, 'full');
  const faceplate = await openDock(page, memberId, pages);
  await unfoldDockPane(page);
  await freezeFaceAudio(page, label);
  if (bootOpts.videoFaceWhy) await freezeFaceVideo(page, memberId, label);
  await settle(page);
  return settledCapture(faceplate);
}

test.describe.configure({ mode: 'default' });

const ROSTER = FACES as readonly {
  type: string;
  pages: number;
  videoFaceWhy?: string;
  singletonAdoptWhy?: string;
  simPin?: BootFaceOptions['simPin'];
}[];

ROSTER.forEach(({ type, pages, videoFaceWhy, singletonAdoptWhy, simPin }, index) => {
  // ONE opts object for BOTH tiers, for the reason the gate spec states: a
  // determinism declaration that reached only one tier would leave the other
  // unpinned, which is the "isolation mechanism only half the entry points
  // honour" shape.
  const bootOpts: BootFaceOptions = {
    ...(videoFaceWhy ? { videoFaceWhy } : {}),
    ...(singletonAdoptWhy ? { singletonAdoptWhy } : {}),
    ...(simPin ? { simPin } : {}),
  };
  const group = (index % GROUPS) + 1;

  for (const tier of ['compact', 'dock'] as const) {
    test(`zdet-g${group}-${tier}-${type}`, async ({ page }) => {
      // TWO full scenes plus the settle captures and one decode pass. The
      // per-scene bound the gate derives for this face, doubled, plus a flat
      // allowance for the diff — never a flat number, so a face that declares a
      // measured `sceneWeight` carries it here too.
      test.setTimeout(faceSceneTimeout(type, tier) * 2 + 60_000);
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));

      const boot1 = await captureScene(page, type, tier, pages, bootOpts);
      if (process.env.ZDET_WIPE_STORAGE === '1') await wipeStorage(page);
      const boot2 = await captureScene(page, type, tier, pages, bootOpts);
      const d = await diffDetail(page, boot1.png, boot2.png);

      // ── THE INSTRUMENT, BOTH DIRECTIONS, THIS ROW ─────────────────────────
      expect(
        d.selfDiff,
        `zdet ${type} ${tier}: NEGATIVE CONTROL FAILED — the same capture diffed `
          + `against itself reported ${d.selfDiff} differing px at threshold 1. Every `
          + `number this probe printed is noise.`,
      ).toBe(0);
      expect(
        [d.posDiff, d.posMaxDelta],
        `zdet ${type} ${tier}: POSITIVE CONTROL FAILED — moving ONE pixel's red `
          + `channel by ONE level reported ${d.posDiff} px / maxDelta ${d.posMaxDelta}, `
          + `expected 1 / 1. The diff engine cannot see the smallest difference a PNG `
          + `can express, so a zero row proves nothing.`,
      ).toEqual([1, 1]);

      const verdict =
        d.diffAt1 < 0
          ? 'SIZE-MISMATCH'
          : d.diffAt1 === 0
            ? 'DETERMINISTIC'
            : 'NON-DETERMINISTIC';
      // eslint-disable-next-line no-console
      console.log(
        `[zdet] ${type.padEnd(18)} ${tier.padEnd(7)} ${verdict.padEnd(17)} `
          + `${d.width}x${d.height} diff@1=${d.diffAt1} diff@26=${d.diffAt26} `
          + `maxDelta=${d.maxDelta} box=${JSON.stringify(d.box)} `
          + `settled=${boot1.settled}/${boot2.settled} tries=${boot1.tries}/${boot2.tries} `
          + `video=${videoFaceWhy ? 'y' : 'n'} simPin=${simPin ? 'y' : 'n'} `
          + `wipe=${process.env.ZDET_WIPE_STORAGE === '1' ? 'y' : 'n'} `
          + `budget=${tier === 'compact' ? 'COMPACT_MAX_DIFF' : 'DOCK_MAX_DIFF'} `
          + `pageerrors=${errors.length}`,
      );
    });
  }
});

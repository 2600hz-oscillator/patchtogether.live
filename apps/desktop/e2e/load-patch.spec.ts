// File ▸ Load Patch… (⌘O) — the native menu's one job, end to end.
//
// Main runs the picker, READS the pick (the sandboxed renderer can name no
// path) and pushes the bytes over the event envelope; the rack hands them to
// the same loader the topbar's File ▸ Load uses. The picker is stubbed in MAIN
// (`dialog.showOpenDialog`) so the real click handler runs against a real
// fixture — everything after the stub is the shipped path. The fixture is the
// web lane's `e2e/fixtures/cold-load-patch.ptperf.zip` (analogVco → scope →
// audioOut), exported by the product's own `__perfZip.export()`.
//
// Legs, one launch:
//   1. on /preflight the item is DISABLED and a (programmatic) click never
//      reaches the picker — there is no rack to take a patch;
//   2. on /rack the item is enabled and a pick loads the fixture: its node and
//      edge ids land in `__patch` and its nodes paint;
//   3. cancel is a no-op — with the positive control that the picker WAS
//      consulted, so "nothing changed" is not "nothing happened";
//   4. an unreadable pick (a directory) and a pick that is not a performance
//      each land in the rack's load-error banner, the place a bad topbar load
//      reports — then the fixture loads again, so neither error wedged the
//      loader.

import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { enterRack } from './enter-rack';

const APP_DIR = path.resolve(__dirname, '..');
const WEB_ROOT = process.env.PT_DESKTOP_WEB_ROOT
  ? path.resolve(process.env.PT_DESKTOP_WEB_ROOT)
  : path.resolve(APP_DIR, '../../packages/web/build');
const FIXTURE = path.resolve(APP_DIR, '../../e2e/fixtures/cold-load-patch.ptperf.zip');
const FIXTURE_NODES = ['out', 'scp', 'vco'];
// The fixture's wiring by endpoint, not by edge id: the loader may canonicalize
// an id (its double-patched R leg comes back as `e-scp-ch1_out-out-R`), and
// what the performer needs is the cables, not their names.
const FIXTURE_CABLES = ['vco.sine>scp.ch1', 'scp.ch1_out>out.L', 'scp.ch1_out>out.R'];
const BOOT_MS = 60_000;

interface PatchShape {
  nodes: string[];
  cables: string[];
}

type Pick = { canceled: boolean; filePaths: string[] };

/** Point main's picker at `next` (the stub is installed once, below). */
async function setNextPick(app: ElectronApplication, next: Pick): Promise<void> {
  await app.evaluate((_electron, pick) => {
    const g = globalThis as unknown as { __openDialog: { next: Pick } };
    g.__openDialog.next = pick;
  }, next);
}

async function pickerCalls(app: ElectronApplication): Promise<number> {
  return app.evaluate(() => (globalThis as unknown as { __openDialog: { calls: number } }).__openDialog.calls);
}

/** The real menu item, driven the way the OS menu and the accelerator drive it. */
async function clickLoadPatch(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById('load-patch');
    if (!item) throw new Error('File ▸ Load Patch… is not in the application menu');
    item.click();
  });
}

async function loadPatchEnabled(app: ElectronApplication): Promise<boolean | null> {
  return app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('load-patch')?.enabled ?? null);
}

async function patchShape(page: Page): Promise<PatchShape> {
  return page.evaluate(() => {
    interface End { nodeId: string; portId: string }
    const w = window as unknown as {
      __patch: { nodes: Record<string, unknown>; edges: Record<string, { source: End; target: End }> };
    };
    const cables = Object.values(w.__patch.edges).map(
      (e) => `${e.source.nodeId}.${e.source.portId}>${e.target.nodeId}.${e.target.portId}`,
    );
    return { nodes: Object.keys(w.__patch.nodes).sort(), cables: cables.sort() };
  });
}

test('File ▸ Load Patch… loads the picked performance through the rack loader; cancel and bad picks are handled', async () => {
  test.setTimeout(BOOT_MS * 3);
  if (!fs.existsSync(path.join(WEB_ROOT, 'fallback.html'))) {
    throw new Error(
      `No desktop web bundle at ${WEB_ROOT} — run \`task desktop:build:web\` first (or set PT_DESKTOP_WEB_ROOT).`,
    );
  }
  if (!fs.existsSync(FIXTURE)) throw new Error(`fixture missing: ${FIXTURE}`);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-shell-load-patch-'));
  fs.writeFileSync(path.join(userDataDir, 'rig-bindings.json'), '{}');
  const notAPatch = path.join(userDataDir, 'notes.zip');
  fs.writeFileSync(notAPatch, 'this is not a performance bundle');
  const app = await _electron.launch({
    args: [`--user-data-dir=${userDataDir}`, APP_DIR],
    env: { ...process.env, PT_DESKTOP_WEB_ROOT: WEB_ROOT, PT_DESKTOP_PORT: '0', PT_DESKTOP_WINDOWED: '1', PT_HELPERS: 'off' },
  });
  const mainErrors: string[] = [];
  app.process().stderr?.on('data', (d: Buffer) => mainErrors.push(String(d)));
  try {
    const page = await app.firstWindow();
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    await expect(page.getByTestId('preflight-panel')).toBeVisible({ timeout: BOOT_MS });

    // The picker stub lives in MAIN, where the click handler calls it; the
    // handler reads `dialog.showOpenDialog` off the module at call time.
    await app.evaluate(({ dialog }) => {
      const g = globalThis as unknown as { __openDialog: { calls: number; next: Pick } };
      g.__openDialog = { calls: 0, next: { canceled: true, filePaths: [] } };
      dialog.showOpenDialog = (async () => {
        g.__openDialog.calls += 1;
        return g.__openDialog.next;
      }) as typeof dialog.showOpenDialog;
    });

    // 1. The splash has no loader: the item is grey, and a click is a no-op
    //    before the picker — not a pick that vanishes.
    expect(await loadPatchEnabled(app), 'disabled on /preflight').toBe(false);
    await setNextPick(app, { canceled: false, filePaths: [FIXTURE] });
    await clickLoadPatch(app);
    expect(await pickerCalls(app), 'the picker is never opened without a rack').toBe(0);

    // 2. The rack announces its loader on mount; the item follows it.
    await enterRack(page);
    await page.waitForFunction(() => !!(window as unknown as { __patch?: unknown }).__patch, undefined, { timeout: BOOT_MS });
    await expect.poll(() => loadPatchEnabled(app), { message: 'enabled once the rack mounted', timeout: BOOT_MS }).toBe(true);

    const before = await patchShape(page);
    expect(before.nodes, 'the fresh rack is not already the fixture').not.toEqual(expect.arrayContaining(FIXTURE_NODES));
    await clickLoadPatch(app);
    await expect.poll(() => pickerCalls(app)).toBe(1);
    await expect.poll(() => patchShape(page), { timeout: 30_000 }).toEqual(
      expect.objectContaining({
        nodes: expect.arrayContaining(FIXTURE_NODES),
        cables: expect.arrayContaining(FIXTURE_CABLES),
      }),
    );
    for (const id of FIXTURE_NODES) {
      await expect(page.locator(`.svelte-flow__node[data-id="${id}"]`)).toBeVisible({ timeout: 30_000 });
    }
    await expect(page.getByTestId('load-error')).toHaveCount(0);
    const loaded = await patchShape(page);

    // 3. Cancel: the picker was consulted (positive control) and nothing moved.
    await setNextPick(app, { canceled: true, filePaths: [] });
    await clickLoadPatch(app);
    await expect.poll(() => pickerCalls(app)).toBe(2);
    expect(await patchShape(page)).toEqual(loaded);
    await expect(page.getByTestId('load-error')).toHaveCount(0);

    // 4a. Main cannot read the pick: the error crosses to the rack's banner.
    await setNextPick(app, { canceled: false, filePaths: [userDataDir] });
    await clickLoadPatch(app);
    await expect(page.getByTestId('load-error')).toHaveText(/Load performance failed: .*EISDIR/, { timeout: 30_000 });
    expect(mainErrors.join('')).toMatch(/\[shell\] load patch: cannot read/);
    expect(await patchShape(page), 'a failed read leaves the rack as it was').toEqual(loaded);

    // 4b. Main reads it fine; the loader rejects it — same banner, its message.
    await setNextPick(app, { canceled: false, filePaths: [notAPatch] });
    await clickLoadPatch(app);
    await expect(page.getByTestId('load-error')).toHaveText(/Load performance failed: Performance zip is corrupt/, { timeout: 30_000 });
    expect(await patchShape(page), 'a rejected pick leaves the rack as it was').toEqual(loaded);

    // Neither failure wedged the loader: the fixture loads again and the
    // banner clears.
    await page.evaluate(() => {
      const w = window as unknown as {
        __patch: { nodes: Record<string, unknown>; edges: Record<string, unknown> };
        __ydoc: { transact(fn: () => void): void };
      };
      w.__ydoc.transact(() => {
        for (const id of Object.keys(w.__patch.edges)) delete w.__patch.edges[id];
        for (const id of Object.keys(w.__patch.nodes)) delete w.__patch.nodes[id];
      });
    });
    await setNextPick(app, { canceled: false, filePaths: [FIXTURE] });
    await clickLoadPatch(app);
    await expect.poll(() => patchShape(page), { timeout: 30_000 }).toEqual(
      expect.objectContaining({ nodes: expect.arrayContaining(FIXTURE_NODES), cables: expect.arrayContaining(FIXTURE_CABLES) }),
    );
    await expect(page.getByTestId('load-error')).toHaveCount(0);
    expect(await pickerCalls(app)).toBe(5);

    expect(pageErrors).toEqual([]);
    expect(app.windows().length, 'no stray dialog window').toBe(1);
  } finally {
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

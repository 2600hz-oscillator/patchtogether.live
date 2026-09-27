import { test, expect, _electron } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { enterRack } from './enter-rack';

const APP_DIR = path.resolve(__dirname, '..');
const WEB_ROOT = process.env.PT_DESKTOP_WEB_ROOT
  ? path.resolve(process.env.PT_DESKTOP_WEB_ROOT)
  : path.resolve(APP_DIR, '../../packages/web/build');

for (const stateOnly of [false, true]) {
  test(`native patch export ${stateOnly ? 'current state' : 'full history'} picks before slow collection and round-trips`, async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-export-'));
    const app = await _electron.launch({
      args: [`--user-data-dir=${userDataDir}`, APP_DIR],
      env: { ...process.env, PT_DESKTOP_WEB_ROOT: WEB_ROOT, PT_DESKTOP_PORT: '0',
        PT_DESKTOP_WINDOWED: '1', PT_HELPERS: 'off' },
    });
    try {
      const page = await app.firstWindow();
      await enterRack(page);
      await page.waitForFunction(() => !!(window as unknown as { __patch?: unknown }).__patch);
      await page.waitForFunction(() => typeof (window as unknown as { __ensureEngine?: unknown }).__ensureEngine === 'function');
      await page.evaluate(() => (window as unknown as { __ensureEngine(): Promise<unknown> }).__ensureEngine());
      // The pinned audio input publishes its default binding asynchronously.
      await page.waitForFunction(() => (window as unknown as {
        __patch: { nodes: Record<string, { data?: { deviceId?: string } }> };
      }).__patch.nodes['pinned-audioIn']?.data?.deviceId === 'default');
      // Snapshot after normal module initialization has populated default data.
      const before = await page.evaluate(async () => {
        const w = window as unknown as {
          __patch: { nodes: Record<string, unknown>; edges: Record<string, unknown> };
          __saveHandle: FileSystemFileHandle;
          __pickerCalled: boolean;
          __releaseCollection: () => void;
          showSaveFilePicker: (o: { suggestedName: string }) => Promise<FileSystemFileHandle>;
          __suggestedName: string;
        };
        const root = await navigator.storage.getDirectory();
        const handle = await root.getFileHandle('export.zip', { create: true });
        w.__saveHandle = handle;
        w.__pickerCalled = false;
        const collectionGate = new Promise<void>(resolve => { w.__releaseCollection = resolve; });
        // Model slow media/device collection with an observable gate. The old
        // path waited here before opening any picker; real activation expired.
        Object.defineProperty(navigator, 'requestMIDIAccess', { configurable: true,
          value: async () => { await collectionGate; return { inputs: new Map(), outputs: new Map() }; },
        });
        w.showSaveFilePicker = async o => {
          if (!navigator.userActivation.isActive) throw new DOMException('Gesture expired', 'SecurityError');
          w.__suggestedName = o.suggestedName;
          w.__pickerCalled = true;
          return handle;
        };
        return JSON.parse(JSON.stringify(w.__patch)) as { nodes: unknown; edges: unknown };
      });
      await page.getByTestId('workflow-file-trigger').click();
      await page.getByTestId(stateOnly ? 'workflow-file-save-performance-state-only' : 'workflow-file-save-performance').click();
      await expect.poll(() => page.evaluate(() => (window as unknown as { __pickerCalled: boolean }).__pickerCalled)).toBe(true);
      await page.evaluate(() => (window as unknown as { __releaseCollection(): void }).__releaseCollection());
      await expect.poll(() => page.evaluate(async () => (await (window as unknown as { __saveHandle: FileSystemFileHandle }).__saveHandle.getFile()).size)).toBeGreaterThan(0);
      const result = await page.evaluate(async () => {
        const w = window as unknown as {
          __patch: { nodes: Record<string, unknown>; edges: Record<string, unknown> };
          __ydoc: { transact(fn: () => void): void };
          __saveHandle: FileSystemFileHandle;
          __suggestedName: string;
          __perfZip: { load(bytes: Uint8Array): Promise<void> };
        };
        const file = await w.__saveHandle.getFile();
        const bytes = new Uint8Array(await file.arrayBuffer());
        w.__ydoc.transact(() => {
          for (const id of Object.keys(w.__patch.edges)) delete w.__patch.edges[id];
          for (const id of Object.keys(w.__patch.nodes)) delete w.__patch.nodes[id];
        });
        await w.__perfZip.load(bytes);
        return { name: w.__suggestedName, size: file.size };
      });
      expect(result.name).toBe(stateOnly ? 'performance-state.ptperf.zip' : 'performance.ptperf.zip');
      expect(result.size).toBeGreaterThan(100);
      // Loading also schedules module initialization (CLIPPLAYER's empty
      // automation map, for example). Compare after that observable state
      // settles, not in the same microtask that applied the envelope.
      await expect.poll(() => page.evaluate(() => {
        const p = (window as unknown as { __patch: { nodes: unknown; edges: unknown } }).__patch;
        return JSON.parse(JSON.stringify({ nodes: p.nodes, edges: p.edges }));
      })).toEqual({ nodes: before.nodes, edges: before.edges });
      await page.evaluate(() => {
        (window as unknown as { showSaveFilePicker(): Promise<FileSystemFileHandle> }).showSaveFilePicker = async () => {
          throw new DOMException('Save permission refused by the test', 'NotAllowedError');
        };
      });
      await page.getByTestId('workflow-file-trigger').click();
      await page.getByTestId(stateOnly ? 'workflow-file-save-performance-state-only' : 'workflow-file-save-performance').click();
      await expect(page.getByText(/Save permission refused by the test/).first()).toBeVisible();
    } finally {
      await app.close();
    }
  });
}

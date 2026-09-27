import { test, expect, _electron } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { enterRack } from './enter-rack';

const APP_DIR = path.resolve(__dirname, '..');
const WEB_ROOT = process.env.PT_DESKTOP_WEB_ROOT
  ? path.resolve(process.env.PT_DESKTOP_WEB_ROOT)
  : path.resolve(APP_DIR, '../../packages/web/build');

// This exercises real encoders, OPFS and writable handles, but deliberately
// does not claim coverage of the OS-native chooser or an external folder.
// Those still need a separate native-dialog check.
for (const aspect of ['4:3', '16:9']) test(`RECORDERBOX starts from a fresh native rack and saves playable ${aspect} video and stereo audio`, async () => {
  const testInfo = test.info();
  if (!fs.existsSync(path.join(WEB_ROOT, 'fallback.html'))) {
    throw new Error('Build the isolated desktop bundle with task desktop:build:web first.');
  }
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-recorderbox-'));
  const app = await _electron.launch({
    args: [`--user-data-dir=${userDataDir}`, APP_DIR],
    env: { ...process.env, PT_DESKTOP_WEB_ROOT: WEB_ROOT, PT_DESKTOP_PORT: '0',
      PT_DESKTOP_WINDOWED: '1', PT_HELPERS: 'off' },
  });
  const diagnostics: string[] = [];
  await app.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
  app.process().stderr?.on('data', d => diagnostics.push(String(d)));
  try {
    const page = await app.firstWindow();
    page.on('pageerror', e => diagnostics.push(String(e)));
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) diagnostics.push(`Navigated: ${frame.url()}`); });
    page.on('crash', () => diagnostics.push('Renderer crashed'));
    page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') diagnostics.push(m.text()); });
    await enterRack(page);
    await page.waitForFunction(() => !!(window as unknown as { __patch?: unknown }).__patch);
    // Do not boot the engine through a test hook: RECORD must start it.
    if (aspect === '16:9') {
      await page.getByTestId('workflow-file-trigger').click();
      await page.getByRole('button', { name: '4:3', exact: true }).click();
      await page.keyboard.press('Escape');
    }
    await page.evaluate(() => {
      const w = window as unknown as {
        __patch: { nodes: Record<string, unknown>; edges: Record<string, {
          target?: { nodeId: string; portId: string };
        }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        w.__patch.nodes['recording-source'] = {
          id: 'recording-source', type: 'shapes', domain: 'video',
          position: { x: 400, y: 80 }, params: { shape: 0, zoom: 1 },
        };
        w.__patch.nodes['recording-tone'] = {
          id: 'recording-tone', type: 'analogVco', domain: 'audio',
          position: { x: 600, y: 80 }, params: {},
        };
        for (const [id, edge] of Object.entries(w.__patch.edges)) {
          if (edge.target?.nodeId === 'workflow-recorderbox' && edge.target.portId === 'in') {
            delete w.__patch.edges[id];
          }
        }
        w.__patch.edges['recording-video'] = {
          id: 'recording-video', source: { nodeId: 'recording-source', portId: 'out' },
          target: { nodeId: 'workflow-recorderbox', portId: 'in' },
          sourceType: 'mono-video', targetType: 'video',
        } as never;
        for (const portId of ['audio_l', 'audio_r']) {
          w.__patch.edges[`recording-${portId}`] = {
            id: `recording-${portId}`, source: { nodeId: 'recording-tone', portId: 'sine' },
            target: { nodeId: 'workflow-recorderbox', portId },
            sourceType: 'audio', targetType: 'audio',
          } as never;
        }
      });
    });
    const node = page.locator('.svelte-flow__node[data-id="workflow-recorderbox"]');
    await node.getByTestId('shell-open-dock').click();
    const dock = page.getByTestId('dock-full-view');
    await expect(dock.getByTestId('recorderbox-face-body')).toBeVisible();
    const record = dock.getByTestId('recorderbox-face-record');
    await expect(record).toBeEnabled();
    await page.evaluate(() => {
      (window as unknown as { showDirectoryPicker(): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker = async () => {
        throw new DOMException('Folder access refused by the test', 'NotAllowedError');
      };
    });
    await record.click();
    await expect(dock.getByTestId('recorderbox-face-error')).toContainText('Folder access refused by the test');
    await expect(record).toHaveText(/RECORD/);
    await expect(node.getByTestId('recorderbox-tile-error')).toBeVisible();
    // Use real Chromium directory/file handles and writable streams. Only the
    // interactive chooser is replaced; encoding, scratch worker and saving run.
    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const dest = await root.getDirectoryHandle('recorded-takes', { create: true });
      const w = window as unknown as { __recordingDestination: FileSystemDirectoryHandle; showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> };
      w.__recordingDestination = dest;
      w.showDirectoryPicker = async () => dest;
    });
    await dock.getByTestId('recorderbox-face-change-folder').click();
    await expect(dock.getByTestId('recorderbox-face-folder')).toHaveText('recorded-takes');
    await expect(record).toBeEnabled();
    await record.click();
    await expect(record).toHaveText(/STOP/);
    await expect(dock.getByTestId('recorderbox-face-error')).toHaveCount(0);
    await expect(dock.getByTestId('recorderbox-face-rec-led')).toHaveAttribute('data-lit', '1');
    // A take belongs to the node, not this dock. Reopening during capture
    // must neither interrupt it nor offer its live scratch file as recovery.
    await dock.getByTestId('faceplate-close').click();
    await expect(dock).toHaveCount(0);
    await node.getByTestId('shell-open-dock').click();
    await expect(record).toHaveText(/STOP/);
    await page.waitForFunction(() => Number(document.querySelector('[data-testid="recorderbox-face-rec-led"]')?.getAttribute('title')?.match(/recording for (\d+):(\d+)/)?.[2] ?? 0) >= 1, undefined, { timeout: 15_000 });
    await expect(dock.getByTestId('recorderbox-face-recover')).toHaveCount(0);
    await record.click();
    await expect.poll(() => page.evaluate(async () => {
      const dir = (window as unknown as { __recordingDestination: FileSystemDirectoryHandle & { values(): AsyncIterable<FileSystemFileHandle> } }).__recordingDestination;
      for await (const handle of dir.values()) if ((await handle.getFile()).size > 1000) return true;
      return false;
    }), { timeout: 30_000, message: 'the finalized recording reached its destination' }).toBe(true);
    await expect(dock.getByTestId('recorderbox-face-recover')).toHaveCount(0);
    const savedBytes = await page.evaluate(async () => {
      const dir = (window as unknown as { __recordingDestination: FileSystemDirectoryHandle & { values(): AsyncIterable<FileSystemFileHandle> } }).__recordingDestination;
      for await (const handle of dir.values()) return Array.from(new Uint8Array(await (await handle.getFile()).arrayBuffer()));
      throw new Error('No saved take');
    });
    await testInfo.attach('recorded-take', { body: Buffer.from(savedBytes), contentType: 'video/mp4' });
    const decoded = await page.evaluate(async () => {
      const dir = (window as unknown as { __recordingDestination: FileSystemDirectoryHandle & {
        values(): AsyncIterable<FileSystemFileHandle>;
      } }).__recordingDestination;
      let file: File | undefined;
      for await (const handle of dir.values()) file = await handle.getFile();
      if (!file) throw new Error('No recorded file');
      const url = URL.createObjectURL(file);
      const video = document.createElement('video');
      video.muted = true;
      try {
        await new Promise<void>((resolve, reject) => {
          video.onloadeddata = () => resolve();
          video.onerror = () => reject(new Error(`Recorded MP4 cannot decode: ${video.error?.message}`));
          video.src = url;
          video.load();
        });
        await new Promise<void>((resolve, reject) => { video.onseeked=()=>resolve(); video.onerror=()=>reject(new Error('Seek failed')); video.currentTime=Math.min(0.5,video.duration/2); });
        const canvas = document.createElement('canvas');
        canvas.width = 64; canvas.height = 48;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(video, 0, 0, 64, 48);
        const px = ctx.getImageData(0, 0, 64, 48).data;
        let sum = 0, sumSq = 0;
        for (let i = 0; i < px.length; i += 4) {
          const y = (px[i] + px[i + 1] + px[i + 2]) / 3;
          sum += y; sumSq += y * y;
        }
        const n = px.length / 4;
        const audioContext = new AudioContext();
        let audioRms: number[];
        try {
          const audio = await audioContext.decodeAudioData(await file.arrayBuffer());
          audioRms = Array.from({ length: audio.numberOfChannels }, (_, channel) => {
            const samples = audio.getChannelData(channel);
            let energy = 0;
            for (const sample of samples) energy += sample * sample;
            return Math.sqrt(energy / samples.length);
          });
        } finally { await audioContext.close(); }
        return { audioRms, duration: video.duration, width: video.videoWidth, height: video.videoHeight,
          variance: sumSq / n - (sum / n) ** 2 };
      } finally {
        video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url);
      }
    });
    expect(decoded.audioRms).toHaveLength(2);
    for (const rms of decoded.audioRms) expect(rms, 'both recorded audio channels carry the patched oscillator').toBeGreaterThan(0.01);
    expect(decoded.duration).toBeGreaterThan(0.5);
    expect(decoded.width).toBe(aspect === '4:3' ? 1024 : 1366);
    expect(decoded.height).toBe(768);
    expect(decoded.variance, 'the recorded picture contains the patched source, not a blank frame').toBeGreaterThan(15);
  } finally {
    console.log('Recorder diagnostics:', diagnostics.join('\n'));
    if (testInfo.status !== testInfo.expectedStatus) {
      const trace = testInfo.outputPath('native-recording-trace.zip');
      await app.context().tracing.stop({ path: trace });
      await testInfo.attach('native-recording-trace', { path: trace, contentType: 'application/zip' });
    } else {
      await app.context().tracing.stop();
    }
    await app.close();
  }
});

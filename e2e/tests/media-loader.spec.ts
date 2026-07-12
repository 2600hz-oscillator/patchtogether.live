// e2e/tests/media-loader.spec.ts
//
// The /media media-loader scaffold view: a synthesized DataTransfer drop
// (real File objects built in-page), inline previews + probe statuses,
// the unsupported-file notice, per-item remove, clear-all, and the hidden
// file-input browse fallback with duplicate detection.
//
// FOLDER-drop traversal (webkitGetAsEntry / FileSystemEntry recursion) is
// deliberately NOT covered here: Playwright cannot fake webkitGetAsEntry —
// real FileSystemEntry objects only exist on a true OS-level drag, and a
// synthetic DataTransfer's items return null entries. That whole path
// (nested dirs, readEntries batching, per-entry errors) is unit-covered in
// packages/web/src/lib/media/ingest.test.ts with mocked entry trees.

import { test, expect } from './_fixtures';

// 1×1 transparent PNG — a real decodable image so the probe reaches 'ready'.
const PNG_1X1_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test.describe('media loader (/media)', () => {
  test('drop ingests files, previews + metadata render, unsupported surfaces, remove + clear work', async ({
    page,
    errorWatch,
  }) => {
    void errorWatch; // armed: any page error / console.error fails the test
    await page.goto('/media');
    const zone = page.getByTestId('media-drop-zone');
    await expect(zone).toBeVisible();
    await expect(page.getByTestId('media-empty-hint')).toBeVisible();

    // Drag-over affordance: enter flips it on, leave drains it off.
    await zone.evaluate((el) => {
      el.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true }));
    });
    await expect(zone).toHaveAttribute('data-drag-active', 'true');
    await zone.evaluate((el) => {
      el.dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true }));
    });
    await expect(zone).toHaveAttribute('data-drag-active', 'false');

    // Synthesize a multi-file drop: a real PNG, a real (generated) WAV, and a
    // .txt that must be REPORTED as unsupported — DataTransfer + File can only
    // be constructed in the browser context.
    await zone.evaluate((el, pngB64) => {
      const png = Uint8Array.from(atob(pngB64), (c) => c.charCodeAt(0));

      // Minimal valid WAV: 44-byte header + 0.25 s of 16-bit mono silence.
      const sampleRate = 8000;
      const samples = sampleRate / 4;
      const dataSize = samples * 2;
      const wav = new DataView(new ArrayBuffer(44 + dataSize));
      const str = (off: number, s: string) => {
        for (let i = 0; i < s.length; i++) wav.setUint8(off + i, s.charCodeAt(i));
      };
      str(0, 'RIFF');
      wav.setUint32(4, 36 + dataSize, true);
      str(8, 'WAVE');
      str(12, 'fmt ');
      wav.setUint32(16, 16, true); // fmt chunk size
      wav.setUint16(20, 1, true); // PCM
      wav.setUint16(22, 1, true); // mono
      wav.setUint32(24, sampleRate, true);
      wav.setUint32(28, sampleRate * 2, true); // byte rate
      wav.setUint16(32, 2, true); // block align
      wav.setUint16(34, 16, true); // bits/sample
      str(36, 'data');
      wav.setUint32(40, dataSize, true);

      const dt = new DataTransfer();
      dt.items.add(new File([png], 'pixel.png', { type: 'image/png' }));
      dt.items.add(new File([wav.buffer], 'blip.wav', { type: 'audio/wav' }));
      dt.items.add(new File(['not media'], 'notes.txt', { type: 'text/plain' }));
      el.dispatchEvent(
        new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }),
      );
    }, PNG_1X1_B64);

    // Both media files land as items; the txt is surfaced, never silently dropped.
    const items = page.getByTestId('media-item');
    await expect(items).toHaveCount(2);
    const notice = page.getByTestId('media-rejected-notice');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('notes.txt');
    await expect(notice).toContainText('unsupported type (text/plain)');

    // Image item: probe reaches 'ready' with real 1×1 dimensions + <img> preview.
    const imgItem = page.locator('[data-testid="media-item"][data-kind="image"]');
    await expect(imgItem).toHaveAttribute('data-status', 'ready');
    await expect(imgItem.getByTestId('media-item-name')).toHaveText('pixel.png');
    await expect(imgItem.getByTestId('media-item-meta')).toHaveText('1×1');
    await expect(imgItem.locator('img[data-testid="media-item-preview"]')).toBeVisible();

    // Audio item: probe reaches 'ready' with the generated 0.25 s duration
    // + an <audio controls> preview wired to the item's object URL.
    const audioItem = page.locator('[data-testid="media-item"][data-kind="audio"]');
    await expect(audioItem).toHaveAttribute('data-status', 'ready');
    await expect(audioItem.getByTestId('media-item-meta')).toHaveText('0.25s');
    const audioPreview = audioItem.locator('audio[data-testid="media-item-preview"]');
    await expect(audioPreview).toBeVisible();
    await expect(audioPreview).toHaveAttribute('src', /^blob:/);

    // Per-item remove.
    await imgItem.getByTestId('media-item-remove').click();
    await expect(items).toHaveCount(1);
    await expect(page.locator('[data-testid="media-item"][data-kind="audio"]')).toHaveCount(1);

    // Clear-all → back to the empty state.
    await page.getByTestId('media-clear-all').click();
    await expect(items).toHaveCount(0);
    await expect(page.getByTestId('media-empty-hint')).toBeVisible();
  });

  test('browse-input fallback adds items; a re-dropped duplicate is skipped with a notice', async ({
    page,
    errorWatch,
  }) => {
    void errorWatch;
    await page.goto('/media');
    const zone = page.getByTestId('media-drop-zone');
    await expect(zone).toBeVisible();

    // The hidden <input type="file"> browse fallback (setInputFiles drives the
    // SAME onchange path a user's file picker does).
    await page.getByTestId('media-file-input').setInputFiles({
      name: 'pixel.png',
      mimeType: 'image/png',
      buffer: Buffer.from(PNG_1X1_B64, 'base64'),
    });
    const items = page.getByTestId('media-item');
    await expect(items).toHaveCount(1);
    await expect(items).toHaveAttribute('data-status', 'ready');

    // Duplicate detection keys on name+size+lastModified, so drive it with two
    // IDENTICAL synthesized drops (fixed lastModified — Playwright's buffer
    // setInputFiles stamps a fresh temp-file mtime per call, which would make
    // a re-pick nondeterministic as a dupe probe).
    const dropDot = (el: HTMLElement, pngB64: string) => {
      const png = Uint8Array.from(atob(pngB64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(
        new File([png], 'dot.png', { type: 'image/png', lastModified: 1_700_000_000_000 }),
      );
      el.dispatchEvent(
        new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }),
      );
    };
    await zone.evaluate(dropDot, PNG_1X1_B64);
    await expect(items).toHaveCount(2);

    await zone.evaluate(dropDot, PNG_1X1_B64);
    const skipped = page.getByTestId('media-skipped-notice');
    await expect(skipped).toBeVisible();
    await expect(skipped).toContainText('dot.png');
    await expect(skipped).toContainText('already in library');
    await expect(items).toHaveCount(2); // not double-added
  });
});

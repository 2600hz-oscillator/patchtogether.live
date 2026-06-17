import { describe, it, expect, vi } from 'vitest';
import {
  savePerformanceZip,
  ensureZipName,
  DEFAULT_PERF_ZIP_NAME,
  type ZipSavePicker,
} from './performance-save';

const BYTES = new Uint8Array([1, 2, 3, 4]);

describe('ensureZipName', () => {
  it('appends .zip when missing', () => {
    expect(ensureZipName('my show')).toBe('my_show.zip');
  });
  it('keeps an existing .zip (case-insensitive) without doubling it', () => {
    expect(ensureZipName('set1.zip')).toBe('set1.zip');
    expect(ensureZipName('SET1.ZIP')).toBe('SET1.ZIP');
  });
  it('strips path separators and reserved characters', () => {
    expect(ensureZipName('a/b\\c:d*e?f')).toBe('a_b_c_d_e_f.zip');
  });
  it('falls back to performance for an empty / dots-only name', () => {
    expect(ensureZipName('')).toBe('performance.zip');
    expect(ensureZipName('   ')).toBe('performance.zip');
    expect(ensureZipName('...')).toBe('performance.zip');
  });
  it('caps very long names', () => {
    const out = ensureZipName('x'.repeat(500));
    expect(out.endsWith('.zip')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(124);
  });
});

describe('savePerformanceZip — picker path (Chromium)', () => {
  it('writes the bytes to the chosen handle and reports saved', async () => {
    const writes: BufferSource[] = [];
    let closed = false;
    const handle = {
      createWritable: async () => ({
        write: async (d: BufferSource) => {
          writes.push(d);
        },
        close: async () => {
          closed = true;
        },
      }),
    };
    const picker = vi.fn<ZipSavePicker>(async () => handle as unknown as FileSystemFileHandle);

    const outcome = await savePerformanceZip(BYTES, { picker });

    expect(outcome).toBe('saved');
    expect(picker).toHaveBeenCalledTimes(1);
    // suggested name + a .zip accept type are offered to the dialog
    const arg = picker.mock.calls[0]![0];
    expect(arg.suggestedName).toBe(DEFAULT_PERF_ZIP_NAME);
    expect(arg.types).toBeTruthy();
    expect(writes).toEqual([BYTES]);
    expect(closed).toBe(true);
  });

  it('returns cancelled (no throw) when the user dismisses the picker', async () => {
    const picker = vi.fn<ZipSavePicker>(async () => {
      throw new DOMException('The user aborted a request.', 'AbortError');
    });
    const download = vi.fn();
    const outcome = await savePerformanceZip(BYTES, { picker, download });
    expect(outcome).toBe('cancelled');
    expect(download).not.toHaveBeenCalled(); // does NOT fall through to a forced download
  });

  it('honours a custom suggested name', async () => {
    const handle = { createWritable: async () => ({ write: async () => {}, close: async () => {} }) };
    const picker = vi.fn<ZipSavePicker>(async () => handle as unknown as FileSystemFileHandle);
    await savePerformanceZip(BYTES, { picker, suggestedName: 'tonight.zip' });
    expect(picker.mock.calls[0]![0].suggestedName).toBe('tonight.zip');
  });
});

describe('savePerformanceZip — fallback path (no picker)', () => {
  it('prompts for a name, ensures .zip, and downloads it', async () => {
    const download = vi.fn();
    const prompt = vi.fn(() => 'my live set');
    const outcome = await savePerformanceZip(BYTES, { picker: null, prompt, download });
    expect(outcome).toBe('saved');
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(download).toHaveBeenCalledWith(BYTES, 'my_live_set.zip');
  });

  it('returns cancelled when the prompt is dismissed', async () => {
    const download = vi.fn();
    const prompt = vi.fn(() => null);
    const outcome = await savePerformanceZip(BYTES, { picker: null, prompt, download });
    expect(outcome).toBe('cancelled');
    expect(download).not.toHaveBeenCalled();
  });
});

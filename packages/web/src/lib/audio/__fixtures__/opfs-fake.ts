// packages/web/src/lib/audio/__fixtures__/opfs-fake.ts
//
// A minimal in-memory OPFS, sufficient for the clip media store: nested
// directory handles, positioned file writes, `getFile()`, `removeEntry`, and
// `values()` enumeration.
//
// ⚠ WHY A FAKE AND NOT `vi.mock` OF THE STORE. The recorderbox tests mock the
// whole store module, which tests the CALLERS and leaves the store's own
// ordering — manifest before bytes, truncate before recovery, what the GC
// spares — covered by nothing but e2e. The properties this slice has to get
// right are all inside the store, so the store has to actually run.
//
// It is a FAKE, not an emulator: it does not model quota, concurrent access
// handles, or partial writes. Anything depending on those is an e2e claim, not
// a unit one, and this file must not be extended to pretend otherwise.

export class FakeOpfsFile {
  name: string;
  data: Uint8Array = new Uint8Array(0);
  constructor(name: string) {
    this.name = name;
  }
  /** Positioned write, growing the file as needed — the one operation a
   *  `FileSystemSyncAccessHandle` gives us that a WritableStream does not. */
  writeAt(bytes: Uint8Array, position: number): void {
    const end = position + bytes.length;
    if (end > this.data.length) {
      const grown = new Uint8Array(end);
      grown.set(this.data, 0);
      this.data = grown;
    }
    this.data.set(bytes, position);
  }
}

class FakeFileHandle {
  readonly kind = 'file' as const;
  constructor(
    readonly name: string,
    private readonly file: FakeOpfsFile,
  ) {}
  async getFile(): Promise<File> {
    const bytes = this.file.data;
    // Node has both; fall back to a structural stand-in if a runtime has
    // neither, so the fake never becomes the reason a test cannot run.
    if (typeof File === 'function') return new File([bytes as BlobPart], this.name);
    return {
      name: this.name,
      size: bytes.length,
      arrayBuffer: async () => bytes.slice().buffer,
    } as unknown as File;
  }
}

export class FakeOpfsDir {
  readonly kind = 'directory' as const;
  files = new Map<string, FakeOpfsFile>();
  dirs = new Map<string, FakeOpfsDir>();
  constructor(readonly name: string) {}

  async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<FakeOpfsDir> {
    let d = this.dirs.get(name);
    if (!d) {
      if (!opts?.create) throw new DOMExceptionLike(`no such directory: ${name}`);
      d = new FakeOpfsDir(name);
      this.dirs.set(name, d);
    }
    return d;
  }

  async getFileHandle(name: string, opts?: { create?: boolean }): Promise<FakeFileHandle> {
    let f = this.files.get(name);
    if (!f) {
      if (!opts?.create) throw new DOMExceptionLike(`no such file: ${name}`);
      f = new FakeOpfsFile(name);
      this.files.set(name, f);
    }
    return new FakeFileHandle(name, f);
  }

  async removeEntry(name: string): Promise<void> {
    if (!this.files.delete(name) && !this.dirs.delete(name)) {
      throw new DOMExceptionLike(`no such entry: ${name}`);
    }
  }

  async *values(): AsyncGenerator<{ kind: 'file' | 'directory'; name: string }> {
    for (const [name] of this.files) yield { kind: 'file', name };
    for (const [name] of this.dirs) yield { kind: 'directory', name };
  }
}

class DOMExceptionLike extends Error {
  name = 'NotFoundError';
}

export interface InstalledOpfs {
  root: FakeOpfsDir;
  /** The raw bytes stored at an OPFS path, or null. */
  bytesAt(path: string): Uint8Array | null;
  /** Whether a path exists — the assertion for "no byte was written yet". */
  exists(path: string): boolean;
  /** Every file name directly inside a directory. */
  namesIn(dirPath: string): string[];
  restore(): void;
}

/** Install the fake as `navigator.storage.getDirectory` (and a `Worker` stub, so
 *  `hasClipMediaStore()` reports true) and return the handle plus a restore. */
export function installFakeOpfs(): InstalledOpfs {
  const root = new FakeOpfsDir('');
  const g = globalThis as unknown as Record<string, unknown>;
  const prevWorker = g.Worker;

  // ⚠ `globalThis.navigator` IS GETTER-ONLY IN NODE — a plain assignment throws
  // "Cannot set property navigator of #<Object> which has only a getter", and
  // the throw lands in a `beforeEach`, where vitest reports it as 32 identical
  // failures in the AFTER hook and hides the real cause. `defineProperty` is
  // the only spelling that works, and the original descriptor is what restores
  // it (deleting the key would leave the process without a navigator).
  const prevNavDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const storage = { getDirectory: async () => root as unknown as FileSystemDirectoryHandle };
  Object.defineProperty(globalThis, 'navigator', {
    value: { ...(g.navigator as object | undefined), storage },
    configurable: true,
    writable: true,
  });
  // `hasClipMediaStore()` requires Worker because createSyncAccessHandle is
  // worker-only. The unit tests inject a writer instead of using one, but the
  // capability check must still read true.
  if (typeof g.Worker === 'undefined') g.Worker = class {} as unknown as typeof Worker;

  const walk = (path: string): { dir: FakeOpfsDir | null; leaf: string } => {
    const parts = path.split('/').filter(Boolean);
    const leaf = parts.pop() ?? '';
    let dir: FakeOpfsDir | null = root;
    for (const p of parts) {
      dir = dir?.dirs.get(p) ?? null;
      if (!dir) break;
    }
    return { dir, leaf };
  };

  return {
    root,
    bytesAt(path) {
      const { dir, leaf } = walk(path);
      return dir?.files.get(leaf)?.data ?? null;
    },
    exists(path) {
      const { dir, leaf } = walk(path);
      return !!dir && (dir.files.has(leaf) || dir.dirs.has(leaf));
    },
    namesIn(dirPath) {
      const parts = dirPath.split('/').filter(Boolean);
      let dir: FakeOpfsDir | null = root;
      for (const p of parts) {
        dir = dir?.dirs.get(p) ?? null;
        if (!dir) return [];
      }
      return [...dir.files.keys()];
    },
    restore() {
      if (prevNavDesc) Object.defineProperty(globalThis, 'navigator', prevNavDesc);
      else delete g.navigator;
      if (prevWorker === undefined) delete g.Worker;
      else g.Worker = prevWorker;
    },
  };
}

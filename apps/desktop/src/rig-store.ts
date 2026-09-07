// The per-machine RIG store — main-side persistence for device bindings.
//
// The WEB side owns the schema (packages/web device-slot-bindings.ts:
// `RigBindings`); the SHELL treats the record as OPAQUE JSON and only
// persists/returns it verbatim. That asymmetry is deliberate: the binding shape
// evolves with the pre-flight UI (ES-9 push policy, PTZ, launchpad mode, …) and
// the shell must not need a redeploy to store a field it has never heard of. So
// there is exactly ONE validation here — "is this a plain object" — and it lives
// at the bridge op, not in this file; a load that finds a corrupt blob degrades
// to the empty rig rather than throwing, and the operator lands on /preflight to
// re-bind (the same outcome as a genuine first run).
//
// LIFETIME (interruption-matrix.md:39): device bindings are owned by Electron
// MAIN and die "app quit only" — they must survive a renderer crash/reload AND a
// full relaunch. That is the whole point of keeping them OFF the Y.Doc and on
// disk: `build-brief.md:381` — "bindings applied at boot; relaunch restores
// everything."
//
// WHY A PLAIN JSON FILE, NOT electron-store. apps/desktop keeps its dependency
// set minimal (only `ws` today) so its standalone lockfile and ~100 MB Electron
// install stay cheap. The rig record is a single small blob written whole and
// read whole; electron-store's per-key API, schema layer and atomic-write are
// all things we either do not need or reproduce in a dozen lines below. If a
// second config domain (window bounds, helper prefs) later wants keyed access,
// revisit — but a lone opaque blob does not justify the dep.
//
// PURE of Electron on purpose: the caller passes the absolute file path
// (`path.join(app.getPath('userData'), 'rig-bindings.json')` in main.ts), so
// this module imports only node:fs / node:path and is unit-testable against a
// temp dir with nothing installed (rig-store.test.cjs).

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Opaque to the shell — the web side (`RigBindings`) owns the real shape. */
export type RigBindings = Record<string, unknown>;

function isPlainObject(v: unknown): v is RigBindings {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Synchronous-read, atomic-write persistence for the per-machine rig record.
 *
 * The record loads once at construction into an in-memory cache; `get()` serves
 * that cache without touching disk (a boot-time device restore may consult it
 * on a hot path), and `set()` replaces it and writes the file atomically.
 */
export class RigStore {
  private cache: RigBindings = {};
  /** True when the file was absent, empty, or unparseable at load — i.e. there
   *  is no usable configured rig, so the shell opens /preflight. */
  private firstRun = true;

  constructor(private readonly filePath: string) {
    this.load();
  }

  /** No usable rig on disk at boot (absent / empty / corrupt). Drives the
   *  first-run → /preflight vs configured → /rack decision in main.ts. */
  isFirstRun(): boolean {
    return this.firstRun;
  }

  /** The persisted record, or `{}` when unset. Returns the live cache object —
   *  callers must treat it as read-only. */
  get(): RigBindings {
    return this.cache;
  }

  /** Replace the record and persist it atomically (temp write + rename). Throws
   *  only on a genuine filesystem failure, which the bridge op surfaces as an
   *  `internal` PtError; the in-memory cache is updated first regardless. */
  set(bindings: RigBindings): void {
    this.cache = bindings;
    this.firstRun = false;
    this.writeAtomic(bindings);
  }

  private load(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch {
      // ENOENT and friends: genuine first run.
      this.cache = {};
      this.firstRun = true;
      return;
    }
    if (raw.trim().length === 0) {
      this.cache = {};
      this.firstRun = true;
      return;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isPlainObject(parsed)) {
        this.cache = parsed;
        this.firstRun = false;
        return;
      }
    } catch {
      // fall through — malformed JSON is tolerated as "no usable rig".
    }
    this.cache = {};
    this.firstRun = true;
  }

  private writeAtomic(bindings: RigBindings): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    // Same-directory temp so the rename stays on one filesystem (rename is only
    // atomic within a filesystem). Unique per write so two writers never share
    // a temp path.
    const tmp = path.join(
      dir,
      `.${path.basename(this.filePath)}.${process.pid}.${Date.now()}.${Math.random()
        .toString(36)
        .slice(2)}.tmp`,
    );
    try {
      fs.writeFileSync(tmp, JSON.stringify(bindings, null, 2), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      // Best-effort cleanup so a failed write does not leave a temp turd behind.
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* nothing to clean */
      }
      throw err;
    }
  }
}

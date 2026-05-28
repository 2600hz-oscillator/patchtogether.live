# e2e/fixtures

Binary test fixtures consumed by Playwright specs.

## `sm64-idb.bin` (optional; LFS-tracked when present)

Pre-extracted IDB `'assets'` blob (msgpack-encoded) for the SM64 module's
e2e spec. With this file committed, `sm64.spec.ts` seeds IndexedDB and
boots the engine without an interactive ROM upload. **Without** it, the
spec test that exercises a real boot calls `test.skip()` with a clear
log line pointing here.

### Regenerate (one-time, requires a US sm64.z64 ROM)

```bash
flox activate -- node scripts/extract-sm64-idb.mjs /path/to/your/sm64.z64
flox activate -- git add e2e/fixtures/sm64-idb.bin
```

See `packages/web/native/sm64js/README.md` for the full recipe + the
WTFPL / clearance context for committing the extracted bytes.

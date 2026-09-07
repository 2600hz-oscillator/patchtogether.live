// node:test for the per-machine rig store (src/rig-store.ts).
//
// Runs against the COMPILED output — `npm run build` (tsc → dist/) first, then
//   node --test src/rig-store.test.cjs
// It is a .cjs file so it is NOT swept into the tsc build (tsconfig include is
// `src/**/*.ts`) and needs nothing installed. The membership gate's wired test
// entry stays apps/desktop/e2e/boot.spec.ts; this is an additional local unit
// lane for the store's persistence contract.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { RigStore } = require('../dist/rig-store.js');

/** A fresh, empty temp directory per test, auto-removed after. */
function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A representative opaque RigBindings blob — the shell never inspects it. */
function sampleBindings() {
  return {
    cameras: { cam1: { deviceId: 'abc123', deviceLabel: 'FaceTime HD' }, cam2: { deviceId: 'def456' } },
    outputs: { output1: { screen: { label: 'DELL U2720Q', isInternal: false, width: 3840, height: 2160, dpr: 2, left: 0, top: 0 } } },
    audioOut: { outputDeviceId: 'sink-es9' },
    es9: { pushPolicy: 'always' },
    push: { deviceId: 'push2-usb' },
    launchpad: { deviceId: 'lp-mini', mode: 'launchcontrol' },
    ptz: { deviceId: 'obsbot-1' },
    // an unknown future field must still round-trip verbatim (opaque persistence)
    somethingTheShellHasNeverHeardOf: { nested: [1, 2, { ok: true }] },
  };
}

test('first run: no file → isFirstRun true, get() is empty', (t) => {
  const dir = tmpDir(t);
  const store = new RigStore(path.join(dir, 'rig-bindings.json'));
  assert.equal(store.isFirstRun(), true);
  assert.deepEqual(store.get(), {});
});

test('round-trip: set then reload returns the exact record, no longer first-run', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'rig-bindings.json');
  const bindings = sampleBindings();

  const a = new RigStore(file);
  a.set(bindings);
  assert.equal(a.isFirstRun(), false);
  assert.deepEqual(a.get(), bindings);

  // A fresh instance reads what was persisted (survives "relaunch").
  const b = new RigStore(file);
  assert.equal(b.isFirstRun(), false);
  assert.deepEqual(b.get(), bindings);
});

test('atomic write: final file is valid JSON, no temp file left behind', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'rig-bindings.json');

  new RigStore(file).set(sampleBindings());

  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(onDisk, sampleBindings());

  const leftovers = fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], `temp files leaked: ${leftovers.join(', ')}`);
});

test('overwrite: the second set wins on reload', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'rig-bindings.json');

  const store = new RigStore(file);
  store.set({ cameras: { cam1: { deviceId: 'first' } } });
  store.set({ cameras: { cam1: { deviceId: 'second' } } });

  assert.deepEqual(new RigStore(file).get(), { cameras: { cam1: { deviceId: 'second' } } });
});

test('malformed file: unparseable JSON degrades to empty first-run, no throw', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'rig-bindings.json');
  fs.writeFileSync(file, '{ this is not: json ]]', 'utf8');

  let store;
  assert.doesNotThrow(() => {
    store = new RigStore(file);
  });
  assert.equal(store.isFirstRun(), true);
  assert.deepEqual(store.get(), {});
});

test('non-object JSON (array / scalar) is treated as no usable rig', (t) => {
  const dir = tmpDir(t);
  for (const [name, body] of [
    ['array', '[1,2,3]'],
    ['number', '42'],
    ['null', 'null'],
    ['string', '"hello"'],
  ]) {
    const file = path.join(dir, `rig-${name}.json`);
    fs.writeFileSync(file, body, 'utf8');
    const store = new RigStore(file);
    assert.equal(store.isFirstRun(), true, `${name} should be first-run`);
    assert.deepEqual(store.get(), {}, `${name} should be empty`);
  }
});

test('empty file: whitespace-only content is first-run', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'rig-bindings.json');
  fs.writeFileSync(file, '   \n\t', 'utf8');

  const store = new RigStore(file);
  assert.equal(store.isFirstRun(), true);
  assert.deepEqual(store.get(), {});
});

test('set creates a missing parent directory', (t) => {
  const dir = tmpDir(t);
  // userData usually exists, but a first-ever write must not depend on it.
  const file = path.join(dir, 'nested', 'deeper', 'rig-bindings.json');
  const store = new RigStore(file);
  store.set({ audioOut: { outputDeviceId: 'x' } });

  assert.equal(fs.existsSync(file), true);
  assert.deepEqual(new RigStore(file).get(), { audioOut: { outputDeviceId: 'x' } });
});

test('empty-object bindings persist as a real configured rig (not first-run)', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'rig-bindings.json');
  const store = new RigStore(file);
  store.set({});
  assert.equal(store.isFirstRun(), false);
  // Reload: an explicitly-written {} is on disk, so it is no longer first-run.
  const reloaded = new RigStore(file);
  assert.equal(reloaded.isFirstRun(), false);
  assert.deepEqual(reloaded.get(), {});
});

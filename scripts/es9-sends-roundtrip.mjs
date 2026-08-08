// scripts/es9-sends-roundtrip.mjs
//
// ONE-OFF verification + re-emit for the owner's ES-9 send/return rack.
//
//   node scripts/es9-sends-roundtrip.mjs <in.zip> <out.ptperf.zip>
//
// 1. Decodes the `pt-performance-v1` bundle's base64 Y.Doc update.
// 2. Re-encodes it and confirms nodes/edges/params survive byte-for-byte at the
//    VALUE level (a Y.Doc update is not byte-stable, so the compare is on the
//    decoded JSON, which is what actually has to round-trip).
// 3. Re-zips it as a loadable bundle.
//
// It deliberately does NOT rewrite anything: the point is to hand back the
// owner's own patch, re-emitted by the current code path, so he can confirm the
// eight send/return edges without rebuilding them by hand.

import { readFileSync, writeFileSync } from 'node:fs';
import * as Y from 'yjs';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error('usage: node scripts/es9-sends-roundtrip.mjs <in.zip> <out.zip>');
  process.exit(2);
}

const files = unzipSync(new Uint8Array(readFileSync(inPath)));
const manifest = JSON.parse(strFromU8(files['performance.json']));
if (manifest.format !== 'pt-performance-v1') {
  throw new Error(`unexpected format ${manifest.format}`);
}

/** Decode a base64 Y.Doc update into plain { nodes, edges } JSON. */
function decode(b64) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(Buffer.from(b64, 'base64')));
  const dump = (name) => {
    const out = {};
    doc.getMap(name).forEach((v, k) => {
      out[k] = v && typeof v.toJSON === 'function' ? v.toJSON() : v;
    });
    return out;
  };
  return { doc, nodes: dump('nodes'), edges: dump('edges') };
}

const before = decode(manifest.bundle.patch.update);

// Re-encode as a fresh full-state update — the shape a save produces.
const reEncoded = Buffer.from(Y.encodeStateAsUpdate(before.doc)).toString('base64');
const after = decode(reEncoded);

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const nodesOk = same(before.nodes, after.nodes);
const edgesOk = same(before.edges, after.edges);

const edgeList = Object.values(before.edges)
  .map((e) => `${e.source.nodeId}:${e.source.portId} -> ${e.target.nodeId}:${e.target.portId}`)
  .sort();

console.log(`nodes: ${Object.keys(before.nodes).length}  edges: ${edgeList.length}`);
console.log(`round-trip nodes identical: ${nodesOk}`);
console.log(`round-trip edges identical: ${edgesOk}`);
if (!nodesOk || !edgesOk) process.exit(1);

// THE EIGHT that motivated the work, printed so the check is legible.
const EIGHT = [
  'pinned-mixmstrs:send1L -> es9-9f485c08:out3',
  'pinned-mixmstrs:send1R -> es9-9f485c08:out4',
  'pinned-mixmstrs:send2L -> es9-9f485c08:out5',
  'pinned-mixmstrs:send2R -> es9-9f485c08:out6',
  'es9-9f485c08:in14 -> pinned-mixmstrs:ret1L',
  'es9-9f485c08:in13 -> pinned-mixmstrs:ret1R',
  'es9-9f485c08:in11 -> pinned-mixmstrs:ret2L',
  'es9-9f485c08:in12 -> pinned-mixmstrs:ret2R',
];
const missing = EIGHT.filter((e) => !edgeList.includes(e));
console.log(`the eight send/return edges present: ${missing.length === 0}`);
if (missing.length) {
  console.log('MISSING:', missing);
  process.exit(1);
}

const outManifest = {
  ...manifest,
  savedAt: manifest.savedAt,
  bundle: {
    ...manifest.bundle,
    patch: { ...manifest.bundle.patch, update: reEncoded },
  },
};

// Fixed mod-time so the emitted bundle is deterministic for a fixed input —
// zipSync otherwise stamps DOS time from the clock (see performance-zip.ts).
writeFileSync(
  outPath,
  Buffer.from(
    zipSync(
      { 'performance.json': strToU8(JSON.stringify(outManifest)) },
      { mtime: new Date(manifest.savedAt ?? 0) },
    ),
  ),
);
console.log(`wrote ${outPath}`);

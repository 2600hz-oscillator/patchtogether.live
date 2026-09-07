import fs from 'fs';
import * as Y from 'yjs';
const j = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const doc = new Y.Doc();
Y.applyUpdate(doc, new Uint8Array(Buffer.from(j.bundle.patch.update, 'base64')));
const nodes = doc.getMap('nodes');
const edges = doc.getMap('edges');
const first = [...edges.entries()][0];
console.log('EDGE raw shape:', JSON.stringify(first[1] instanceof Y.Map ? first[1].toJSON() : first[1], null, 2));
console.log('\nEDGE key sample:', first[0]);
console.log('\n--- all edges resolved ---');
const typeOf = id => { const n = nodes.get(id); return n instanceof Y.Map ? n.toJSON().type : (n ? '?' : 'MISSING'); };
for (const [id, e] of edges.entries()) {
  const o = e instanceof Y.Map ? e.toJSON() : e;
  const k = Object.keys(o);
  const s = o.from ?? o.source ?? o.src;
  const t = o.to ?? o.target ?? o.dst;
  console.log(`  ${String(typeOf(s)).padEnd(15)} ${JSON.stringify(o.fromPort ?? o.sourceHandle ?? o.outPort ?? '')}  ->  ${String(typeOf(t)).padEnd(15)} ${JSON.stringify(o.toPort ?? o.targetHandle ?? o.inPort ?? '')}   [keys ${k.join(',')}]`);
}

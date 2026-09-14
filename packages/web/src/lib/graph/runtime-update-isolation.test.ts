import { it, expect } from 'vitest';
import { syncedStore, getYjsDoc } from '@syncedstore/core';
import { attachReconciler } from '../audio/reconciler';
import { createSnapshotBus } from './snapshot';
import { LockstepTransport } from '../doom/doom-lockstep';

it('asynchronous node creation coalesces pending changes into one follow-up', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release=resolve; });
  let snap = {nodes:[{id:'review',type:'analogVco',domain:'audio',position:{x:0,y:0},params:{value:0}}],edges:[]};
  let listener!: (s: typeof snap) => void;
  let completedPasses = 0; const writes: number[]=[];
  const bus = {current:()=>snap,subscribe:(fn:typeof listener)=>{listener=fn;fn(snap);return ()=>{};}};
  const engine = {addNode:()=>gate,removeNode:()=>{},addEdge:()=>{},removeEdge:()=>{},hasEdge:()=>false,
    setParam:(_n:unknown,_p:string,v:number)=>writes.push(v)};
  const handle = attachReconciler(engine as never,{bus:bus as never,
    rig:{snapshot:()=>({cameras:{},outputs:{}}),subscribe:()=>()=>{}} as never,onReconciled:()=>{completedPasses++;}});
  await Promise.resolve(); await Promise.resolve();
  for(let i=1;i<=200;i++) {
    snap={...snap,nodes:[{...snap.nodes[0]!,params:{value:i}}]};
    listener(snap);
    await new Promise<void>(resolve=>queueMicrotask(resolve));
  }
  release(); await handle.reconcile(); handle.dispose();
  console.log('PROBE reconcile_queue',JSON.stringify({updates:200,completedPasses,writes}));
  expect(completedPasses).toBe(2);
  expect(writes).toEqual([200]);
});

it('DOOM tic traffic should not rebuild an unchanged patch graph',()=>{
  const patch=syncedStore({nodes:{},edges:{}}) as any;const doc=getYjsDoc(patch);
  const bus=createSnapshotBus({patch,ydoc:doc});let snapshots=0;let updates=0;let bytes=0;
  const off=bus.subscribe(()=>{snapshots++;});snapshots=0;
  doc.on('update',(u:Uint8Array)=>{updates++;bytes+=u.byteLength;});
  const a=new LockstepTransport({doc,moduleId:'review',slot:0,numPlayers:2});
  const b=new LockstepTransport({doc,moduleId:'review',slot:1,numPlayers:2});
  const cmd={forwardmove:0,sidemove:0,angleturn:0,buttons:0};
  for(let tic=0;tic<350;tic++){a.appendLocal(tic,cmd);b.appendLocal(tic,cmd);}
  console.log('PROBE doom_graph_amplification',JSON.stringify({tics:350,players:2,updates,bytes,snapshots,nodes:bus.current().nodes.length}));
  off();bus.dispose();doc.destroy();
  expect(snapshots).toBe(0);
});

it.each(['remove', 'replace'] as const)('a %s received during a pending factory is applied by the follow-up', async change => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = { id: 'one', type: 'analogVco', domain: 'audio', position: { x: 0, y: 0 }, params: {} };
  let snap = { nodes: [first], edges: [] };
  let listener!: (snapshot: typeof snap) => void;
  const bus = { current: () => snap, subscribe: (fn: typeof listener) => { listener = fn; fn(snap); return () => {}; } };
  const operations: string[] = [];
  const engine = {
    addNode: async (node: typeof first) => { operations.push('add:' + node.type); if (node.type === first.type) await gate; },
    removeNode: (node: typeof first) => operations.push('remove:' + node.type),
    addEdge() {}, removeEdge() {}, hasEdge: () => false, setParam() {},
  };
  const handle = attachReconciler(engine as never, { bus: bus as never,
    rig: { snapshot: () => ({ cameras: {}, outputs: {} }), subscribe: () => () => {} } as never });
  await Promise.resolve(); await Promise.resolve();
  const settled = handle.reconcile();
  snap = { nodes: change === 'remove' ? [] : [{ ...first, type: 'vca' }], edges: [] };
  listener(snap);
  release();
  await settled;
  handle.dispose();
  expect(operations).toEqual(change === 'remove'
    ? ['add:analogVco', 'remove:analogVco']
    : ['add:analogVco', 'remove:analogVco', 'add:vca']);
});

import { it, expect, vi } from 'vitest';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { createSharedClock } from './shared-clock.svelte';

function fixture() {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  const listeners = new Map<string, Set<(event: any) => void>>();
  const requests: Array<{id:number}> = [];
  let now = 1000; let tick = () => {};
  const provider = {
    awareness, configuration: {websocketProvider: {status: 'connected'}},
    on(event: string, fn: (event:any)=>void) { if (!listeners.has(event)) listeners.set(event,new Set()); listeners.get(event)!.add(fn); },
    off(event: string, fn: (event:any)=>void) { listeners.get(event)?.delete(fn); },
    sendStateless(payload: string) { requests.push(JSON.parse(payload)); },
  };
  const emit = (event:string, payload:any) => { for (const fn of listeners.get(event) ?? []) fn(payload); };
  const clock = createSharedClock({provider:provider as never,ydoc:doc,deps:{
    perfNow:()=>now, setInterval:((fn:()=>void)=>{tick=fn;return 0;}) as never,clearInterval:()=>{},randomU32:()=>42,
  }});
  const respond = (session='server-a') => {
    const request = requests.at(-1)!;
    const serverRecvTs = now + 9010; now += 20;
    const payload = JSON.stringify({type:'clock-pong',id:request.id,session,serverRecvTs,serverSendTs:serverRecvTs});
    emit('stateless',{payload}); return payload;
  };
  return {clock,doc,awareness,requests,emit,respond,
    advance(ms=125) {now+=ms;tick();},
    destroy(){clock.destroy();awareness.destroy();doc.destroy();},
  };
}
it('cursor and DOOM awareness traffic never fabricate observations; duplicate replies are ignored',()=>{
  const f=fixture();
  try {
    const payload=f.respond(); const before={...f.clock.snapshot};
    for(let i=0;i<20;i++) {
      f.awareness.setLocalStateField('__heartbeat',{tick:i,ts_ms:1});
      f.awareness.setLocalStateField('cursor',{x:i});
      f.awareness.setLocalStateField('doom:review:key',{ts:i});
      f.emit('stateless',{payload});
    }
    expect(f.clock.snapshot).toEqual(before);
    expect(before.sampleCount).toBe(1);expect(before.converged).toBe(false);
  } finally {f.destroy();}
});
it('converges from real exchanges, then resets samples on reconnect and server restart',()=>{
  const f=fixture();
  try {
    f.respond();
    for(let i=1;i<8;i++){f.advance();f.respond();}
    expect(f.clock.snapshot.converged).toBe(true);
    expect(f.clock.epoch_ms).not.toBeNull();
    expect(f.clock.rngSeed()).toBe(42);
    const count=f.requests.length;f.advance(125);
    expect(f.requests).toHaveLength(count);
    f.emit('status',{status:'disconnected'});f.advance(6000);
    expect(f.requests).toHaveLength(count);
    f.emit('status',{status:'connected'});f.respond();
    expect(f.clock.snapshot.sampleCount).toBe(1);
    f.advance();f.respond('server-b');
    expect(f.clock.snapshot.sampleCount).toBe(1);
  } finally {f.destroy();}
});
it('bounds pending probes and rejects old replies after timeout',()=>{
  const f=fixture();
  try {
    const id=f.requests[0]!.id;
    for(let i=0;i<20;i++) f.advance(125);
    expect(f.requests).toHaveLength(1);
    f.advance(6000);expect(f.requests).toHaveLength(2);
    f.emit('stateless',{payload:JSON.stringify({type:'clock-pong',id,session:'old',serverRecvTs:100,serverSendTs:100})});
    expect(f.clock.snapshot.sampleCount).toBe(0);
    f.respond();expect(f.clock.snapshot.sampleCount).toBe(1);
  } finally {f.destroy();}
});
it('notifies epoch reset exactly once and detaches on destroy',()=>{
  const f=fixture();
  f.respond();const reset=vi.fn();f.clock.onReset(reset);
  f.clock.resetEpoch();expect(reset).toHaveBeenCalledTimes(1);
  const epoch=f.clock.epoch_ms;f.clock.destroy();
  f.doc.getMap('meta').set('epoch_ms',epoch!+100);
  expect(reset).toHaveBeenCalledTimes(1);
  f.awareness.destroy();f.doc.destroy();
});

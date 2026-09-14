import { beforeAll, afterAll, it, expect, vi } from 'vitest';
type Processor = {
  port: {onmessage:(event:{data:unknown})=>void};
  process(inputs:Float32Array[][], outputs:Float32Array[][], params:Record<string,Float32Array>):boolean;
};
let Processor: new()=>Processor;
beforeAll(async()=>{
  vi.stubGlobal('sampleRate',48000);
  vi.stubGlobal('currentFrame',0);
  vi.stubGlobal('AudioWorkletProcessor',class {port={onmessage:null,postMessage:()=>{}};});
  vi.stubGlobal('registerProcessor',(_name:string,ctor:new()=>Processor)=>{Processor=ctor;});
  // @ts-expect-error The worklet is a classic script; registerProcessor captures its constructor.
  await import('./lfo');
});
afterAll(()=>vi.unstubAllGlobals());
const params={rate:new Float32Array([1]),shape:new Float32Array([0]),depth:new Float32Array([0.5])};
function block(p:Processor, frame:number, trigger=false) {
  vi.stubGlobal('currentFrame',frame);
  const outputs=Array.from({length:4},()=>[new Float32Array(128)]);
  p.process(trigger?[[new Float32Array(128).fill(1)]]:[],outputs,params);
  return outputs[0]![0]!;
}
function anchor(p:Processor,sharedNow:number,audioNow:number,type='init',epoch=10000) {
  p.port.onmessage({data:{type,epoch_ms:epoch,sharedNow_ms:sharedNow,audioOrigin_s:audioNow,smoothing_ms:200}});
}
it('staggered clients render the same actual samples at the same shared instant',()=>{
  const early=new Processor();const late=new Processor();const unanchored=new Processor();
  anchor(early,10000,0);anchor(late,11250,0);
  const a=block(early,60000);const b=block(late,0);const control=block(unanchored,0);
  expect([...a]).toEqual([...b]);
  expect(Math.max(...a)).toBeGreaterThan(0.99);
  expect(Math.max(...control)).toBeLessThan(0.02);
});
it('resync converges to a new anchor and epoch reset uses that epoch',()=>{
  const p=new Processor();block(p,0);
  anchor(p,11250,0,'resync');
  // An unanchored worklet snaps on its first available clock, even for resync.
  expect(block(p,0)[0]).toBeGreaterThan(0.99);
  anchor(p,12000,0,'init',12000);
  expect(Math.abs(block(p,0)[0]!)).toBeLessThan(0.001);
});
it('external trigger reset remains effective after clock anchoring',()=>{
  const p=new Processor();anchor(p,11250,0);block(p,0);
  const triggered=block(p,128,true);
  expect(Math.abs(triggered[0]!)).toBeLessThan(0.001);
  const following=block(p,256,true);
  expect(Math.abs(following[0]!)).toBeLessThan(0.03);
});

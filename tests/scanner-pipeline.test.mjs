import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const app=readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
const workerSource=readFileSync(new URL('../web/portrait-worker.js',import.meta.url),'utf8');
function workerHarness(){
 const counts={segmenters:0,sessions:0,runs:0,closed:0,bitmaps:0},messages=[];
 const vision={FilesetResolver:{forVisionTasks:async()=>({})},ImageSegmenter:{createFromOptions:async()=>{
  counts.segmenters++;return {segment(bitmap,callback){callback({categoryMask:{getAsUint8Array:()=>new Uint8Array(4),width:2,height:2}});},close(){counts.closed++;}};
 }}};
 const ort={env:{wasm:{}},Tensor:class{dispose(){}},InferenceSession:{create:async()=>{
  counts.sessions++;return {inputNames:['image'],outputNames:['matte'],async run(){counts.runs++;return {matte:{dims:[1,1,32,32],data:new Float32Array(1024),dispose(){}}};}};
 }}};
 const s={self:{location:{href:'http://localhost/portrait-worker.js'},navigator:{hardwareConcurrency:8},crossOriginIsolated:true,postMessage:m=>messages.push(m)},
  performance:{now:()=>1},URL,Uint8Array,Float32Array,OffscreenCanvas:class{
   getContext(){return {save(){},clearRect(){},translate(){},scale(){},drawImage(){},restore(){},getImageData(){return {data:new Uint8Array(4096)};}};}
  },loadModule:async path=>path.includes('vision_bundle')?vision:path.includes('ort.wasm')?ort:path.includes('portrait-fit')?{portraitAccessoryIssue:lm=>lm.hat?'Снимите головной убор':''}:{imageToNchw:()=>new Float32Array(3072),cleanPortraitAlpha:()=>new Uint8Array(1024)}};
 vm.createContext(s);vm.runInContext(workerSource.replaceAll('import(', 'loadModule('),s);
 const send=async(options={})=>s.self.onmessage({data:options.warmup?options:{bitmap:{width:32,height:32,close(){counts.bitmaps++;}},...options}});
 return {send,counts,messages};
}
test('two portraits reuse both models and retain two matte passes per image',async()=>{
 const h=workerHarness();await h.send({warmup:true});await h.send();await h.send();
 assert.equal(h.counts.segmenters,1);assert.equal(h.counts.sessions,1);assert.equal(h.counts.runs,4);
 assert.equal(h.counts.bitmaps,2);assert.equal(h.messages.filter(m=>m.engine==='modnet').length,2);
 assert.equal(h.messages.filter(m=>m.ready).length,1);
});
test('headwear is rejected before running the warmed matting model',async()=>{
 const h=workerHarness();await h.send({landmarks:{hat:true}});
 assert.equal(h.counts.sessions,1);assert.equal(h.counts.runs,0);
 assert.equal(h.messages.at(-1).error,'Снимите головной убор');assert.equal(h.counts.bitmaps,1);
});
test('all six poses are captured while warming models; only the used portrait is analysed',async()=>{
 const elements=new Map(),views=[],fits=[];let captures=0,created=0,terminated=0,now=0;
 const points=Array.from({length:478},()=>({x:.5,y:.5,z:0}));
 const canvas=()=>({width:0,height:0,getContext:()=>({drawImage(){}}),toDataURL:()=>{captures++;return 'data:image/jpeg;base64,test';}});
 const s={currentUser:{avatar_consent_current:true},AbortController,scanEpoch:0,scannerAbort:null,restoringAbort:null,
  $:id=>{if(!elements.has(id))elements.set(id,{textContent:'',showModal(){},appendChild(){}});return elements.get(id);},
  stopAudio(){},controls(){},scanInstruction(){},enableCamera:async()=>{},dependencies:async()=>{},
  video:{videoWidth:640,videoHeight:480,closest:()=>({})},performance:{now:()=>now+=700},landmarks:()=>({faceLandmarks:[points]}),
  portraitQuality:()=>'',scanQuality:()=>'',scanTurnIssue:()=>'',faceYaw:()=>0,
  document:{createElement:()=>canvas()},lastMediaTimestamp:0,detector:{detectForVideo:()=>({faceLandmarks:[points]})},sleep:async()=>{},stopCamera(){},
  Worker:class{constructor(){created++;}terminate(){terminated++;}},warmPortraitWorker:async()=>{},
  fitPortrait:async(view,progress,signal,worker)=>{fits.push({worker,role:view.role});return {};},THREE:{},avatarTopology:{},
  LocalAvatar:{create(t,v){views.push(...v);return {dispose(){}};}},packPortraitAnalysis:()=>({}),
  api:async()=>({}),installModel(){},showPortraitCutout(){},cancelScan(){},
 };
 vm.createContext(s);vm.runInContext(app.slice(app.indexOf('async function scan()'),app.indexOf('function cancelScan()')),s);
 await s.scan();assert.equal(views.length,6);assert.equal(captures,6);assert.equal(created,1);assert.equal(terminated,1);
 assert.equal(fits.length,1);assert.equal(fits[0].role,'portrait');
});
test('final portrait asks for a relaxed neutral pose instead of a stretched neck',()=>{
 assert.match(app,/Мягко сомкните губы, расслабьте плечи и не вытягивайте шею/);
});
test('a stalled accelerated portrait pass retries once in compatible mode',async()=>{
 const elements=new Map(),modes=[];let now=0,workers=0,terminated=0;
 const points=Array.from({length:478},()=>({x:.5,y:.5,z:0}));
 const s={currentUser:{avatar_consent_current:true},AbortController,scanEpoch:0,scannerAbort:null,restoringAbort:null,
  $:id=>{if(!elements.has(id))elements.set(id,{textContent:'',showModal(){},appendChild(){}});return elements.get(id);},
  stopAudio(){},controls(){},scanInstruction(){},enableCamera:async()=>{},dependencies:async()=>{},
  video:{videoWidth:640,videoHeight:480,closest:()=>({})},performance:{now:()=>now+=700},landmarks:()=>({faceLandmarks:[points]}),
  portraitQuality:()=>'',scanQuality:()=>'',scanTurnIssue:()=>'',faceYaw:()=>0,
  document:{createElement:()=>({width:0,height:0,getContext:()=>({drawImage(){}}),toDataURL:()=>''})},
  lastMediaTimestamp:0,detector:{detectForVideo:()=>({faceLandmarks:[points]})},sleep:async()=>{},stopCamera(){},
  Worker:class{constructor(){workers++;}terminate(){terminated++;}},warmPortraitWorker:async()=>{},
  async fitPortrait(view,progress,signal,worker,options){modes.push(options);if(!options.singleThread)throw new Error('Обработка снимка заняла слишком долго.');return {};},
  THREE:{},avatarTopology:{},LocalAvatar:{create:()=>({dispose(){}})},packPortraitAnalysis:()=>({}),
  api:async()=>({}),installModel(){},showPortraitCutout(){},cancelScan(){},
 };
 vm.createContext(s);vm.runInContext(app.slice(app.indexOf('async function scan()'),app.indexOf('function cancelScan()')),s);
 await s.scan();
 assert.deepEqual(modes.map(({singleThread,timeoutMs})=>({singleThread,timeoutMs})),[
  {singleThread:false,timeoutMs:20000},{singleThread:true,timeoutMs:60000},
 ]);
 assert.equal(workers,2);assert.equal(terminated,2);
});
test('cancelling portrait analysis immediately stops the worker and releases the image',async()=>{
 const abort=new AbortController();let stopped=0,closed=0;
 const worker={postMessage(){abort.abort();},terminate(){stopped++;}};
 const s={createImageBitmap:async()=>({close(){closed++;}}),DOMException,setTimeout,clearTimeout,
  portraitAccessoryIssue:()=>'',fitStablePortraitAnchors:()=>({})};
 vm.createContext(s);vm.runInContext(app.slice(app.indexOf('async function fitPortrait('),app.indexOf('function showPortraitCutout(')),s);
 await assert.rejects(s.fitPortrait({canvas:{},landmarks:[]},()=>{},abort.signal,worker),{name:'AbortError'});
 assert.equal(stopped,1);assert.equal(closed,1);
});
test('portrait warmup has a deadline and terminates a stuck worker',async()=>{
 let stopped=0;const worker={postMessage(){},terminate(){stopped++;}};
 const s={DOMException,setTimeout:(fn)=>{queueMicrotask(fn);return 1;},clearTimeout(){}};
 vm.createContext(s);vm.runInContext(app.slice(app.indexOf('async function warmPortraitWorker('),app.indexOf('async function fitPortrait(')),s);
 await assert.rejects(s.warmPortraitWorker(worker,new AbortController().signal,1),/слишком долго/);
 assert.equal(stopped,1);
});

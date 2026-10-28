import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import {requestUserCamera,withTimeout} from '../web/core.mjs';

const source=readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
const pauseSource=source.slice(source.indexOf('function pause('),source.indexOf('function stop('));
const tickSource=source.slice(source.indexOf('function tick('),source.indexOf('function showLesson('));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function harness(options={}){
  const calls=[],elements=new Map();let cameraLive=true;
  const sandbox={
    running:true,paused:false,pausePending:false,studySessionId:'lesson-1',
    lessonTransition:null,resumeCancelled:false,lessonCameraEnabled:true,lessonPresenceEnabled:true,
    lessonElapsed:1000,lessonStarted:0,lessonLimitSeconds:1200,detectError:false,
    performance:{now:()=>2000},document:{hidden:false,body:{classList:{add(){},remove(){}}}},
    $:id=>{if(!elements.has(id))elements.set(id,{textContent:''});return elements.get(id);},
    controls(){},stopAudio(){},cancelTutor(){},stopHandsFree(){},setListenerState(){},fail(){},
    stopCamera(){cameraLive=false;calls.push('camera:stop');},cameraLive:()=>cameraLive,
    async enableCamera(){calls.push('camera:start');cameraLive=true;},
    context:()=>({resume:async()=>{calls.push('audio:resume');}}),
    presence:{reset(){calls.push('presence:reset');}},
    startLessonPresence(){calls.push('presence:start');},
    async startHandsFree(){calls.push('mic:start');},
    async api(path,body){const {action}=JSON.parse(body);calls.push(action);return {elapsed_seconds:3,limit_seconds:1200};},
    ...options,
  };
  vm.createContext(sandbox);vm.runInContext(pauseSource,sandbox);
  return {state:sandbox,calls,pause:sandbox.pause,elements};
}

test('pause stops the camera and local clock before a delayed network response',async()=>{
  const request=deferred(), h=harness({api:()=>request.promise});
  const pending=h.pause();
  assert.equal(h.state.paused,true);assert.equal(h.state.pausePending,true);
  assert.ok(h.calls.includes('camera:stop'));
  assert.equal(h.pause(),pending);
  request.resolve({elapsed_seconds:3,limit_seconds:1200});await pending;
  assert.equal(h.state.pausePending,false);assert.equal(h.state.lessonTransition,null);
});

test('camera failure keeps lesson paused and the next resume can succeed',async()=>{
  const h=harness({paused:true,detectError:true,enableCamera:async()=>{throw new Error('busy camera');}});
  await assert.rejects(h.pause(),/busy camera/);
  assert.equal(h.state.paused,true);assert.ok(!h.calls.includes('resume'));
  h.state.enableCamera=async()=>{h.calls.push('camera:start');};
  await h.pause();
  assert.equal(h.state.paused,false);assert.equal(h.state.detectError,false);
  assert.ok(h.calls.indexOf('camera:start')<h.calls.indexOf('resume'));
  assert.ok(h.calls.includes('audio:resume'));assert.ok(h.calls.includes('presence:start'));
});

test('repeated pause and resume cycles restore camera, audio and presence',async()=>{
  const h=harness();
  for(let cycle=0;cycle<10;cycle++){
    await h.pause(true);assert.equal(h.state.paused,true);
    await h.pause();assert.equal(h.state.paused,false);
    assert.equal(h.state.pausePending,false);assert.equal(h.state.lessonTransition,null);
  }
  assert.equal(h.calls.filter(c=>c==='resume').length,10);
  assert.equal(h.calls.filter(c=>c==='presence:start').length,10);
});

test('ten cycles release actual camera tracks and bind a fresh playable stream on resume',async()=>{
  const h=harness({paused:true}),streams=[];
  Object.assign(h.state,{cameraEpoch:0,cameraAbort:null,stream:null,lastFrame:-1,lastResult:null,
    lastSeenFrame:0,AbortController,withTimeout,requestUserCamera,
    video:{srcObject:null,readyState:4,videoWidth:640,play:async()=>{}},
    stopTracks:value=>value?.getTracks().forEach(t=>t.stop()),mediaError:e=>e,
    navigator:{mediaDevices:{async getUserMedia(){
      const track={readyState:'live',muted:false,stop(){this.readyState='ended';}};
      const stream={getTracks:()=>[track],getVideoTracks:()=>[track]};streams.push(stream);return stream;
    }}}});
  h.state.cameraLive=()=>!!h.state.stream?.getVideoTracks().some(t=>t.readyState==='live');
  vm.runInContext(source.slice(source.indexOf('async function enableCamera()'),source.indexOf('function landmarks(')),h.state);
  for(let cycle=0;cycle<10;cycle++){
    await h.pause();assert.equal(h.state.cameraLive(),true);
    assert.equal(h.state.video.srcObject,streams[cycle]);
    await h.pause(true);assert.equal(h.state.video.srcObject,null);
    assert.equal(streams[cycle].getTracks()[0].readyState,'ended');
  }
  assert.equal(streams.length,10);
});

test('automatic pause during camera reconnection never resumes a hidden lesson',async()=>{
  const camera=deferred(),h=harness({paused:true,enableCamera:()=>camera.promise});
  const resume=h.pause();await Promise.resolve();
  h.state.document.hidden=true;const automatic=h.pause(true);
  camera.resolve();await Promise.all([resume,automatic]);
  assert.equal(h.state.paused,true);assert.ok(!h.calls.includes('resume'));
  assert.ok(!h.calls.includes('mic:start'));assert.ok(h.calls.includes('pause'));
});

test('automatic pause arriving after resume request reconciles the server back to paused',async()=>{
  const response=deferred(), h=harness({paused:true});
  h.state.api=async(path,body)=>{const {action}=JSON.parse(body);h.calls.push(action);
    return action==='resume'?response.promise:{elapsed_seconds:4,limit_seconds:1200};};
  const resume=h.pause();
  while(!h.calls.includes('resume'))await Promise.resolve();
  const automatic=h.pause(true);response.resolve({elapsed_seconds:4,limit_seconds:1200});
  await Promise.all([resume,automatic]);
  assert.equal(h.state.paused,true);assert.deepEqual(h.calls.filter(c=>['pause','resume'].includes(c)),['resume','pause']);
  assert.ok(!h.calls.includes('presence:start'));
});

test('a stopped lesson cannot be revived by a late resume response',async()=>{
  const response=deferred(),h=harness({paused:true,api:()=>response.promise});
  const pending=h.pause();await Promise.resolve();await Promise.resolve();
  h.state.running=false;h.state.studySessionId=null;
  response.resolve({elapsed_seconds:3,limit_seconds:1200});await pending;
  assert.ok(!h.calls.includes('presence:start'));assert.ok(!h.calls.includes('mic:start'));
});

test('lost resume response keeps devices stopped and reconciles server pause before retry',async()=>{
  const h=harness({paused:true});let failed=false;
  h.state.api=async(path,body)=>{const {action}=JSON.parse(body);h.calls.push(action);
    if(action==='resume'&&!failed){failed=true;throw new Error('connection lost after resume');}
    return {elapsed_seconds:4,limit_seconds:1200};};
  await assert.rejects(h.pause(),/connection lost/);
  assert.equal(h.state.paused,true);assert.equal(h.state.pausePending,true);
  assert.equal(h.state.cameraLive(),false);assert.ok(!h.calls.includes('mic:start'));
  await h.pause();
  assert.deepEqual(h.calls.filter(c=>['pause','resume'].includes(c)),['resume','pause','resume']);
  assert.equal(h.state.paused,false);assert.equal(h.state.pausePending,false);
});

test('hiding the tab during lesson start pauses before activating mic or avatar speech',async()=>{
  const response=deferred(),h=harness({running:false,paused:false,
    status:{},hideTaskSwitch(){},showLesson(){},playVoice(){throw new Error('must not speak');}});
  h.state.$('readyCamera').checked=true;
  h.state.api=async(path,body)=>{
    const {action}=JSON.parse(body);h.calls.push(action);
    return action==='start'?response.promise:{elapsed_seconds:1,limit_seconds:1200};};
  vm.runInContext(source.slice(source.indexOf('async function start()'),source.indexOf('function pause(')),h.state);
  const starting=h.state.start();
  while(!h.calls.includes('start'))await Promise.resolve();
  h.state.document.hidden=true;
  response.resolve({id:'lesson-2',elapsed_seconds:0,limit_seconds:1200});await starting;
  assert.equal(h.state.paused,true);assert.equal(h.state.cameraLive(),false);
  assert.deepEqual(h.calls.filter(c=>['start','pause'].includes(c)),['start','pause']);
  assert.ok(!h.calls.includes('mic:start'));
});

test('face detector error keeps live camera and avatar loop running, discards detector',()=>{
  const h=harness();let closed=false,frames=0;
  Object.assign(h.state,{requestAnimationFrame:()=>frames++,scanning:false,
    video:{readyState:4},lastSeenFrame:1999,landmarks(){throw new Error('WebGL failure');},
    detector:{close(){closed=true;}},dependenciesPromise:Promise.resolve(),lastMediaTimestamp:100,
    mesh:null,lessonLimitHandled:false});
  vm.runInContext(tickSource,h.state);h.state.tick(2000);
  assert.equal(h.state.paused,false);assert.ok(!h.calls.includes('camera:stop'));
  assert.equal(h.state.detector,null);assert.equal(h.state.dependenciesPromise,null);
  assert.equal(h.state.lessonPresenceEnabled,false);assert.equal(closed,true);assert.equal(frames,1);
});

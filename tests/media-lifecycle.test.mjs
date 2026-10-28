import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import {withTimeout,Presence} from '../web/core.mjs';
const source=readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
const section=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const turn=()=>new Promise(resolve=>setImmediate(resolve));

test('submitting on a break preserves the draft and resumes only after the lesson does',async()=>{
  let requests=0;const field={value:'Как решить пример?'};
  const s={running:true,paused:true,lessonTransition:null,tutorBusy:false,questionRecording:false,
    listenerPending:false,$:()=>field,answerQuestion:async()=>requests++};
  vm.createContext(s);vm.runInContext(section('async function askTutor(', 'async function answerQuestion('),s);
  const event={preventDefault(){}};
  await s.askTutor(event);assert.equal(requests,0);assert.equal(field.value,'Как решить пример?');
  s.paused=false;s.lessonTransition=Promise.resolve();await s.askTutor(event);assert.equal(requests,0);
  s.lessonTransition=null;await s.askTutor(event);assert.equal(requests,1);assert.equal(field.value,'');
});

test('a late automatic question cannot restart a paused or stopped avatar',async()=>{
  for(const state of [{running:true,paused:true},{running:false,paused:false},{running:true,paused:false,lessonTransition:{}}]){
    const s={lessonTransition:null,...state};vm.createContext(s);
    vm.runInContext(section('async function answerQuestion(', 'function setListenerState('),s);
    await s.answerQuestion('Отложенный вопрос'); // No chat, audio or server access is allowed here.
  }
});

function micHarness(extra={}){
  const elements=new Map(),s={listenEpoch:0,listener:null,listenerPending:false,childSpeakingUntil:0,
    running:true,paused:false,helpEpoch:0,playing:false,tutorBusy:false,questionRecording:false,
    taskSwitchPending:null,echoUntil:0,followupUntil:0,status:{speech:{enabled:true}},
    document:{hidden:false},performance:{now:()=>10000},AbortController,withTimeout,
    $:id=>{if(!elements.has(id))elements.set(id,{checked:true,style:{}});return elements.get(id);},
    stopTracks:stream=>stream?.getTracks().forEach(t=>t.stop()),setListenerState(){},controls(){},fail(){},
    mediaError:e=>e,encodeWav:x=>x,isDirectedSpeech:()=>true,classifySpeechRecognitionError:()=>({stop:false}),
    presence:new Presence(),...extra};
  vm.createContext(s);
  vm.runInContext(section('function stopHandsFree()', 'async function voiceQuestion()'),s);
  return s;
}

test('microphone is never requested after pause while audio context was resuming',async()=>{
  const audio=deferred();let requests=0;
  const s=micHarness({context:()=>({resume:()=>audio.promise}),navigator:{mediaDevices:{getUserMedia(){requests++;}}}});
  const pending=s.startHandsFree();s.paused=true;s.stopHandsFree();audio.resolve();await pending;
  assert.equal(requests,0);assert.equal(s.listener,null);
});

test('late microphone permission stream is stopped and cannot reconnect after pause',async()=>{
  const permission=deferred();let stopped=0,modules=0;
  const s=micHarness({context:()=>({resume:async()=>{},audioWorklet:{addModule(){modules++;}}}),
    navigator:{mediaDevices:{getUserMedia:()=>permission.promise}}});
  const pending=s.startHandsFree();await turn();s.paused=true;s.stopHandsFree();
  permission.resolve({getTracks:()=>[{stop(){stopped++;}}]});await pending;
  assert.equal(stopped,1);assert.equal(modules,0);assert.equal(s.listener,null);
});

test('cancelled recognition releases lock; its late completion cannot unlock a new question',async()=>{
  const responses=[deferred(),deferred()];let answers=0;
  const s=micHarness({api:()=>responses.shift().promise,answerQuestion:async()=>{answers++;}});
  const old=responses[0],fresh=responses[1];
  const first=s.recognizeHandsFree(new Uint8Array(),s.listenEpoch);
  assert.equal(s.listenerPending,true);s.stopHandsFree();assert.equal(s.listenerPending,false);
  const second=s.recognizeHandsFree(new Uint8Array(),s.listenEpoch);
  old.resolve({text:'старый вопрос'});await first;
  assert.equal(answers,0);assert.equal(s.listenerPending,true);
  fresh.resolve({text:'новый вопрос'});await second;
  assert.equal(answers,1);assert.equal(s.listenerPending,false);
});

test('cancelled browser reminder settles without browser end event and can be spoken again',async()=>{
  let spoken=0,cancelled=0;
  const s={playbackId:0,activeCues:[],browserSpeechFinish:null,browserUtterance:null,
    audioSources:new Set(),analyser:null,playing:false,performance:{now:()=>1000},
    status:{phrases:[{}]},controls(){},$:()=>({}),SpeechSynthesisUtterance:class{},
    window:{speechSynthesis:{getVoices:()=>[],speak(){spoken++;},cancel(){cancelled++;}}}};
  vm.createContext(s);
  vm.runInContext(section('function stopAudio()', 'async function playVoice(')+
    section('async function speakBrowserPrompt(', 'function beginAudio('),s);
  let finished=0;
  for(let cycle=0;cycle<10;cycle++){
    const pending=s.speakBrowserPrompt('Вернись к занятию','camera').then(()=>finished++);
    s.stopAudio();await turn();
    assert.equal(finished,cycle+1);assert.equal(s.playing,false);assert.equal(s.browserSpeechFinish,null);
    await pending;
  }
  assert.equal(spoken,10);assert.equal(cancelled,10);
});

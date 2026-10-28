import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const source=readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
const section=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end));
function harness(){
  const elements=new Map(),posted=[],played=[],messages=[],progress=[];
  const s={token:'test',running:true,paused:false,lessonTransition:null,taskFinished:false,taskSolved:false,
    taskSwitchPending:null,helpEpoch:0,dialogId:'task-old',studySessionId:'lesson',
    tutorBusy:false,questionRecording:false,listenerPending:false,currentJob:null,followupUntil:0,
    pausePending:false,recording:false,referenceLoaded:false,status:{},performance:{now:()=>1000},
    $:id=>{if(!elements.has(id))elements.set(id,{value:'direct',textContent:'',
      querySelector:()=>({}),replaceChildren(){this.cleared=true;}});return elements.get(id);},
    controls(){},clearError(){},stopAudio(){},requestId:()=>String(posted.length),
    fail(error){throw error;},chatMessage:(role,text)=>messages.push({role,text}),
    context:()=>({resume:async()=>{},decodeAudioData:async()=>({duration:1})}),
    fetch:async()=>({ok:true,arrayBuffer:async()=>new ArrayBuffer(44)}),
    beginAudio(buffer,text,kind,cues){played.push({text,kind,cues});return Promise.resolve();},
    sleep:async()=>progress.push(elements.get('tutorStatus').textContent),
    async api(path,body){
      if(path==='dialog'){
        const payload=JSON.parse(body);posted.push(payload);
        return {id:'job',session:payload.session||'task-new'};
      }
      if(path==='status')return {tutor:{enabled:true},phrases:[]};
      return Array.isArray(s.result)?s.result.shift():s.result;
    },renderParentSummary(){},renderSubscription(){},renderVoiceTakes(){},
  };
  vm.createContext(s);
  vm.runInContext(section('function taskCompletionPrompt()', 'function setListenerState(')+
    section('async function poll()', 'function renderParentSummary('),s);
  return {s,posted,played,messages,elements,progress};
}

test('correct answer plays audio, keeps its success prompt and sends next task without old context',async()=>{
  const h=harness();h.s.result={state:'done',answer:'Верно! Новое задание?',finished:true,solved:true,cues:[{time:0,shape:'open'}],chunks:[]};
  await h.s.answerQuestion('Двенадцать');
  assert.equal(h.s.dialogId,null);assert.equal(h.s.taskFinished,true);assert.equal(h.played.length,1);
  assert.match(h.elements.get('tutorStatus').textContent,/Правильно.*новое задание/);
  await h.s.poll();await h.s.poll();
  assert.match(h.elements.get('tutorStatus').textContent,/Правильно.*новое задание/);
  h.s.result={state:'done',answer:'От девяти отними четыре.',finished:false,solved:false,cues:[],chunks:[]};
  await h.s.answerQuestion('Сколько будет девять минус четыре?');
  assert.equal(h.posted[0].session,'task-old');assert.equal(h.posted[1].session,null);
  assert.equal(h.s.dialogId,'task-new');assert.equal(h.s.taskFinished,false);
  assert.equal(h.s.taskSolved,false);assert.equal(h.elements.get('tutorMessages').cleared,true);
});

test('showing the solution invites a new task without falsely praising a correct answer',async()=>{
  const h=harness();h.s.result={state:'done',answer:'Разберём решение: ответ 12.',finished:true,solved:false,cues:[],chunks:[]};
  await h.s.answerQuestion('Не знаю');await h.s.poll();
  assert.equal(h.s.taskFinished,true);assert.equal(h.s.taskSolved,false);
  assert.match(h.elements.get('tutorStatus').textContent,/Разобрали задание.*новое задание/);
  assert.doesNotMatch(h.elements.get('tutorStatus').textContent,/Правильно/);
});

test('standard avatar voice never shows the parent Qwen generation message',async()=>{
  const h=harness();h.s.status={voice_provider:'qwen'};h.s.$('replyVoice').value='yandex';
  h.s.result=[{state:'speaking',answer:'Подумай.',chunks:[]},
    {state:'done',answer:'Подумай.',finished:false,solved:false,cues:[],chunks:[]}];
  await h.s.answerQuestion('Сколько будет семь плюс пять?');
  assert.equal(h.posted[0].voice,'yandex');
  assert.deepEqual(h.progress,['Озвучиваю подсказку…']);
  await h.s.poll();
  assert.match(h.elements.get('replyVoiceHint').textContent,/голосом Адым/);
});

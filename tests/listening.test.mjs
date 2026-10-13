import test from 'node:test';
import assert from 'node:assert/strict';
import {SpeechGate,isDirectedSpeech,classifySpeechRecognitionError} from '../web/listening.mjs';
const rate=16000;
const frame=(volume,frequency=210)=>Float32Array.from({length:320},(_,i)=>volume*Math.sin(2*Math.PI*frequency*i/rate));
function send(gate,n,volume,frequency){let result;for(let i=0;i<n;i++)result=gate.push(frame(volume,frequency))||result;return result;}
test('silence, low hum, short clicks and avatar playback do not produce a question',()=>{
  for(const mode of ['silence','hum','click','echo']){
    const gate=new SpeechGate(rate);let outputs=[];
    for(let i=0;i<100;i++){
      const input=mode==='click'?frame(i===30?.5:0):frame(mode==='silence'?0:.1,mode==='hum'?20:210);
      const utterance=gate.push(input,mode==='echo');if(utterance)outputs.push(utterance);
    }
    assert.equal(outputs.length,0,mode);
  }
});
test('sustained speech yields one bounded utterance after the pause; noise is not sent continuously',()=>{
  const gate=new SpeechGate(rate);send(gate,30,.001);
  assert.equal(send(gate,35,.12),undefined);
  const utterance=send(gate,50,0);
  assert.ok(utterance instanceof Float32Array);
  assert.ok(utterance.length>rate*.7 && utterance.length<rate*2);
  assert.equal(send(gate,100,0),undefined);
});
test('quiet laptop microphone speech is still detected',()=>{
  const gate=new SpeechGate(rate);send(gate,30,.001);
  send(gate,35,.006);
  const utterance=send(gate,40,0);
  assert.ok(utterance instanceof Float32Array);
});
test('suppression discards a partially recorded question and resumes cleanly',()=>{
  const gate=new SpeechGate(rate);send(gate,25,.12);gate.push(frame(.12),true);
  assert.equal(send(gate,50,0),undefined);
  send(gate,35,.12);assert.ok(send(gate,50,0));
});
test('question routing distinguishes Russian requests and follow-up answers from unrelated speech',()=>{
  for(const text of ['Как решить это уравнение?','папа помоги','Не понимаю задание','Это правильно?','Помоги?'])assert.equal(isDirectedSpeech(text),true,text);
  for(const text of ['Реши три плюс пять','два плюс два','Какое слово вставить'])assert.equal(isDirectedSpeech(text),true,text);
  for(const text of ['','Музыка играет тихо','Реклама закончилась'])assert.equal(isDirectedSpeech(text),false,text);
  assert.equal(isDirectedSpeech('получилось пять',true),true);
  assert.equal(isDirectedSpeech('5',true),true);
});

test('speech errors distinguish unclear audio from provider failures',()=>{
  assert.deepEqual(classifySpeechRecognitionError(new Error('SpeechKit не разобрал вопрос. Повторите или введите текст.')),
    {stop:false,message:'Не разобрал речь. Подойди ближе к микрофону и попробуй ещё раз.'});
  assert.deepEqual(classifySpeechRecognitionError(new Error('Не слышно речи. Подойдите ближе к микрофону.')),
    {stop:false,message:'Не разобрал речь. Подойди ближе к микрофону и попробуй ещё раз.'});
  assert.deepEqual(classifySpeechRecognitionError(new Error('Не удалось связаться со SpeechKit. Повторите позже.')),
    {stop:true,message:'Не удалось связаться со SpeechKit. Повторите позже.'});
  assert.deepEqual(classifySpeechRecognitionError(new Error('Превышена квота SpeechKit (код 429).')),
    {stop:true,message:'Превышена квота SpeechKit (код 429).'});
});

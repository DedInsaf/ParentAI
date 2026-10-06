import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Presence, positionsFor, neutralFacePositions, encodeWav, scanQuality, scanCoverage, faceYaw, mouthRig, speechOpening} from '../web/core.mjs';
test('coordinates use matching physical units on a wide camera',()=>{
  const p=positionsFor([{x:.6,y:.6,z:.1},{x:.5,y:.5,z:0}],1280,720,1);
  assert.ok(Math.abs(p[1]/p[0]+720/1280)<1e-6);
  assert.equal(p[2],-.1);
});
test('absence, return debounce, cooldown, break reset',()=>{
  const p=new Presence();
  assert.equal(p.update(false,1).remind,false);
  assert.equal(p.update(false,9).remind,true);
  assert.equal(p.update(false,10).remind,false);
  assert.equal(p.update(true,11).state,'returning');
  assert.equal(p.update(false,12).state,'missing');
  assert.equal(p.update(false,13).state,'missing');
  assert.equal(p.update(false,21).remind,false);
  assert.equal(p.update(false,39).remind,true);
  p.update(true,40); assert.equal(p.update(true,42).state,'present');
  p.reset(); assert.equal(p.state,'present');
});
test('WAV PCM16 header, length, sample rate and clipping',()=>{
  const b=encodeWav(new Float32Array([-2,0,2]),48000), v=new DataView(b);
  assert.equal(b.byteLength,50); assert.equal(v.getUint32(24,true),48000);
  assert.equal(v.getInt16(44,true),-32768); assert.equal(v.getInt16(48,true),32767);
});
test('scan rejects offscreen face',()=>{
  const lm=Array.from({length:468},()=>({x:0,y:0,z:0}));
  assert.equal(scanQuality(lm,1280,720),'Поместите всё лицо в кадр');
});
test('three-view scan distinguishes front and opposite side turns',()=>{
  const lm=Array.from({length:468},()=>({x:.5,y:.5,z:0}));
  lm[33]={x:.4,y:.5,z:0}; lm[263]={x:.6,y:.5,z:0}; lm[1]={x:.5,y:.5,z:0};
  assert.equal(scanCoverage(lm,960,720),''); assert.equal(faceYaw(lm),0);
  lm[1].x=.56; assert.ok(faceYaw(lm)>.25);
  lm[1].x=.44; assert.ok(faceYaw(lm)<-.25);
});
test('front capture rejects a mild side pose that the old threshold accepted',()=>{
  const lm=Array.from({length:478},()=>({x:.5,y:.5,z:0}));
  lm[33]={x:.4,y:.4,z:0};lm[263]={x:.6,y:.4,z:0};
  lm[10].y=.25;lm[152].y=.75;
  assert.equal(scanQuality(lm,960,720),'');
  lm[1].x=.525;
  assert.equal(scanQuality(lm,960,720),'Посмотрите прямо в объектив');
  lm[1].x=.5;lm[263].z=.03;
  assert.equal(scanQuality(lm,960,720),'Посмотрите прямо в объектив');
  lm[263].z=0;lm[152].y=.95;
  assert.equal(scanQuality(lm,960,720),'Отодвиньте камеру немного дальше, чтобы было видно шею');
});
test('neutral geometry removes eye yaw and roll without changing source landmarks',()=>{
  const lm=Array.from({length:478},()=>({x:.5,y:.5,z:0}));
  lm[33]={x:.4,y:.39,z:.025};lm[263]={x:.6,y:.41,z:-.025};
  lm[1]={x:.5,y:.52,z:-.1};
  const original=JSON.stringify(lm), positions=neutralFacePositions(lm,960,720);
  assert.ok(Math.abs(positions[33*3+1]-positions[263*3+1])<1e-9);
  assert.ok(Math.abs(positions[33*3+2]-positions[263*3+2])<1e-9);
  assert.ok(positions[1*3+2]>positions[33*3+2]);
  assert.equal(JSON.stringify(lm),original);
});
import {withTimeout} from '../web/core.mjs';
test('late camera stream is disposed after permission timeout',async()=>{
  let resolve, disposed;
  const pending=new Promise(r=>{resolve=r});
  await assert.rejects(withTimeout(pending,5,v=>{disposed=v}));
  resolve('stream'); await new Promise(r=>setTimeout(r,0));
  assert.equal(disposed,'stream');
});
test('cancelling pending microphone permission also disposes late stream',async()=>{
  const controller=new AbortController(); let resolve, disposed=false;
  const pending=withTimeout(new Promise(r=>{resolve=r}),1000,()=>{disposed=true},controller.signal);
  controller.abort(); await assert.rejects(pending);
  resolve({}); await new Promise(r=>setTimeout(r,0)); assert.equal(disposed,true);
});
import {closeFaceOpenings,FACE_OPENINGS} from '../web/core.mjs';
test('eye and mouth interiors have textured triangles with valid vertices',()=>{
  const original=Array.from({length:478},(_,i)=>({x:i/500,y:.5,z:0}));
  const filled=closeFaceOpenings(original,[0,1,2]);
  assert.equal(filled.points.length,471);
  assert.equal(filled.indices.length,3+FACE_OPENINGS.flat().length*3);
  for (const id of filled.indices) assert.ok(id>=0 && id<filled.points.length);
  assert.equal(positionsFor(filled.points,960,720).length,471*3);
  assert.equal(original.length,478);
  FACE_OPENINGS.forEach((ring,i)=>assert.ok(Math.abs(filled.points[468+i].x-ring.reduce((sum,id)=>sum+original[id].x,0)/ring.length)<1e-6));
});
test('mouth rig separates lips and audio level opens the mouth',()=>{
  const points=Array.from({length:471},()=>({x:.5,y:.5,z:0}));
  points[13]={x:.5,y:.45,z:0}; points[152]={x:.5,y:.8,z:0};
  points[78]={x:.42,y:.5,z:0}; points[308]={x:.58,y:.5,z:0};
  const rig=mouthRig(points);
  assert.ok(rig.weights[14] > 0); assert.ok(rig.weights[13] < 0); assert.ok(rig.width > .1);
  assert.equal(speechOpening(new Float32Array(32)),0);
  assert.ok(speechOpening(new Float32Array(32).fill(.2)) > .8);
});
test('mouth can be left open for a separate dark cavity',()=>{
  const points=Array.from({length:478},()=>({x:.5,y:.5,z:0}));
  const filled=closeFaceOpenings(points,[0,1,2],false);
  assert.equal(filled.indices.length,3+(FACE_OPENINGS[0].length+FACE_OPENINGS[1].length)*3);
});
import {portraitQuality} from '../web/core.mjs';
test('body portrait requires space below the chin and keeps a strict front pose',()=>{
  const lm=Array.from({length:478},()=>({x:.5,y:.4,z:0}));
  lm[33]={x:.44,y:.3,z:0};lm[263]={x:.56,y:.3,z:0};lm[10].y=.2;lm[152].y=.5;
  assert.equal(portraitQuality(lm,960,720),'');
  lm[152].y=.7;assert.match(portraitQuality(lm,960,720),/плечи/);
  lm[152].y=.5;lm[1].x=.54;assert.match(portraitQuality(lm,960,720),/прямо/);
  lm[1].x=.5;lm[10].y=.05;assert.match(portraitQuality(lm,960,720),/макушка/);
  lm[10].y=.2;lm[234].x=.05;lm[454].x=.4;assert.match(portraitQuality(lm,960,720),/по центру/);
});

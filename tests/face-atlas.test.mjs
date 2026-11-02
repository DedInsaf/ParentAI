import test from 'node:test';
import assert from 'node:assert/strict';
import {bakeDetailedFaceAtlas,isFrontOnlyEyeTriangle,portraitDetailBlend} from '../web/face-atlas.mjs';

test('eye and glasses triangles always keep the single frontal texture',()=>{
  const landmarks=Array.from({length:468},()=>({x:.5,y:.5,z:0}));
  landmarks[10]={x:.5,y:.20,z:0};landmarks[152]={x:.5,y:.62,z:0};
  landmarks[234]={x:.40,y:.42,z:0};landmarks[454]={x:.60,y:.42,z:0};
  landmarks[33]={x:.44,y:.36,z:0};landmarks[263]={x:.56,y:.36,z:0};
  landmarks[100]={x:.43,y:.35,z:0};landmarks[101]={x:.50,y:.37,z:0};landmarks[102]={x:.61,y:.40,z:0};
  landmarks[200]={x:.43,y:.53,z:0};landmarks[201]={x:.50,y:.54,z:0};landmarks[202]={x:.57,y:.53,z:0};
  assert.equal(isFrontOnlyEyeTriangle({landmarks},[100,101,102]),true);
  assert.equal(isFrontOnlyEyeTriangle({landmarks},[200,201,202]),false);
});

test('close-up detail stays on the central face and fades before hair ears and jaw',()=>{
  const landmarks=Array.from({length:468},()=>({x:.5,y:.42,z:0}));
  landmarks[10]={x:.5,y:.20,z:0};landmarks[152]={x:.5,y:.72,z:0};
  landmarks[234]={x:.32,y:.44,z:0};landmarks[454]={x:.68,y:.44,z:0};
  landmarks[1]={x:.5,y:.42,z:0};landmarks[2]={x:.48,y:.43,z:0};landmarks[3]={x:.52,y:.43,z:0};
  landmarks[4]={x:.325,y:.45,z:0};landmarks[5]={x:.327,y:.47,z:0};landmarks[6]={x:.33,y:.49,z:0};
  landmarks[7]={x:.47,y:.70,z:0};landmarks[8]={x:.5,y:.71,z:0};landmarks[9]={x:.53,y:.70,z:0};
  const portrait={landmarks};
  assert.ok(portraitDetailBlend(portrait,[1,2,3])>.9);
  assert.ok(portraitDetailBlend(portrait,[4,5,6])<.2);
  assert.equal(portraitDetailBlend(portrait,[7,8,9]),0);
});

test('avatar face atlas layers the close capture over the portrait before adding side views',()=>{
  const landmarks=Array.from({length:478},()=>({x:.5,y:.42,z:0}));
  landmarks[10]={x:.5,y:.20,z:0};landmarks[152]={x:.5,y:.72,z:0};
  landmarks[234]={x:.32,y:.44,z:0};landmarks[454]={x:.68,y:.44,z:0};
  landmarks[1]={x:.5,y:.42,z:0};landmarks[2]={x:.48,y:.43,z:0};landmarks[3]={x:.52,y:.43,z:0};
  const portraitCanvas={name:'portrait'},detailCanvas={name:'detail'},created=[],previous=globalThis.document;
  globalThis.document={createElement:()=>{
    const draws=[],context={globalAlpha:1,drawImage:image=>draws.push(image),save(){},restore(){},beginPath(){},moveTo(){},lineTo(){},closePath(){},clip(){},setTransform(){}};
    const canvas={width:0,height:0,draws,getContext:()=>context};created.push(canvas);return canvas;
  }};
  try {
    const portrait={canvas:portraitCanvas,landmarks,yaw:0},detail={canvas:detailCanvas,landmarks,yaw:0};
    portraitCanvas.width=detailCanvas.width=640;portraitCanvas.height=detailCanvas.height=480;
    const atlas=bakeDetailedFaceAtlas(portrait,detail,[portrait,detail],[1,2,3]);
    assert.equal(created.length,2);assert.equal(atlas,created[1]);
    assert.deepEqual(created[0].draws,[portraitCanvas,detailCanvas]);
    assert.equal(created[1].draws[0],created[0]);
  } finally {globalThis.document=previous;}
});

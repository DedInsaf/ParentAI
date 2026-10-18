import test from 'node:test';
import assert from 'node:assert/strict';
import {isFrontOnlyEyeTriangle} from '../web/face-atlas.mjs';

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

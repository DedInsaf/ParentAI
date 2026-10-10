import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeBytes,encodeBytes,packPortraitAnalysis,unpackPortraitAnalysis} from '../web/avatar-persistence.mjs';

test('portrait analysis survives compact storage without loading vision models',()=>{
  const labels=new Uint8Array([0,1,3,4,2,1]),alpha=new Float32Array([0,.1,.5,.75,.999,1]);
  const packed=packPortraitAnalysis({segmentation:{width:3,height:2,data:labels},matte:{width:2,height:3,alpha}});
  const restored=unpackPortraitAnalysis(packed);
  assert.deepEqual([...restored.segmentation.data],[...labels]);
  assert.equal(restored.segmentation.matte,restored.matte);
  for(let i=0;i<alpha.length;i++)assert.ok(Math.abs(restored.matte.alpha[i]-alpha[i])<=1/255);
});

test('saved binary planes reject truncation and malformed dimensions',()=>{
  assert.deepEqual([...decodeBytes(encodeBytes(new Uint8Array([1,2,255])),3)],[1,2,255]);
  assert.throws(()=>decodeBytes('AA==',2),/повреждены/);
  assert.throws(()=>unpackPortraitAnalysis({segmentation:{width:3,height:2,data:'AA=='},matte:{width:1,height:1,alpha:'AA=='}}),/повреждены/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {OVAL,skullGeometry,earGeometry,neckGeometry,hairGeometry,blinkAmount} from '../web/head-geometry.mjs';

test('skull matches every face seam vertex and extends behind the face',()=>{
  const face=new Float32Array(468*3);
  OVAL.forEach((id,i)=>{const a=i/OVAL.length*Math.PI*2; face.set([Math.sin(a),Math.cos(a)*1.3,.1*Math.sin(a)],id*3);});
  const head=skullGeometry(face);
  OVAL.forEach((id,i)=>assert.deepEqual(head.positions.slice(i*3,i*3+3),Array.from(face.slice(id*3,id*3+3))));
  assert.ok(Math.min(...head.positions.filter((_,i)=>i%3===2)) < -1);
  for(const geometry of [head,earGeometry(head,-1),earGeometry(head,1),neckGeometry(head),hairGeometry(head)]) {
    assert.ok(geometry.positions.every(Number.isFinite));
    assert.ok(geometry.indices.every(i=>Number.isInteger(i)&&i>=0&&i<geometry.positions.length/3));
  }
  const neck=neckGeometry(head);
  assert.ok(Math.min(...neck.positions.filter((_,i)=>i%3===1)) < -1.3);
  assert.deepEqual(hairGeometry(head,'none').positions,[]);
  assert.ok(blinkAmount(.09)>.99);
  assert.equal(blinkAmount(1),0);
});

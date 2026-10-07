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

test('shirt shoulders extend beyond the head and connect at the neck',async()=>{
  const {torsoGeometry,neckGeometry}=await import('../web/head-geometry.mjs');
  const head={cx:0,cy:0,width:1,height:1.4,edgeZ:0};
  const torso=torsoGeometry(head),neck=neckGeometry(head);
  assert.ok(torso.positions.every(Number.isFinite));
  assert.ok(Math.max(...torso.positions.filter((_,i)=>i%3===0))>1);
  const torsoTop=Math.max(...torso.positions.filter((_,i)=>i%3===1));
  const neckBottom=Math.min(...neck.positions.filter((_,i)=>i%3===1));
  assert.ok(torsoTop>neckBottom); // overlap prevents a visible gap
  // The front centre of the first ring forms a visible rounded neckline and
  // must sit below the side seam instead of covering the neck with a flat bar.
  const sideY=torso.positions[1],frontY=torso.positions[(12*3)+1];
  assert.ok(frontY<sideY-head.height*.06);
  assert.ok(torsoTop<head.cy-head.height*.80); // shoulders leave a useful neck length
  // The visible neck must support the head, with a collar enclosing its base.
  for(let row=9;row<25;row++) {
    const xs=neck.positions.slice(row*32*3,(row+1)*32*3).filter((_,i)=>i%3===0);
    assert.ok(Math.max(...xs)-Math.min(...xs)>=head.width*.53);
  }
  const neckBase=neck.positions.slice(24*32*3,25*32*3);
  const collar=torso.positions.slice(0,48*3);
  for(const axis of [0,2]) {
    const extent=points=>Math.max(...points.filter((_,i)=>i%3===axis))-Math.min(...points.filter((_,i)=>i%3===axis));
    assert.ok(extent(collar)>=extent(neckBase));
  }
  assert.ok(torso.indices.every(i=>i>=0&&i<torso.positions.length/3));
});

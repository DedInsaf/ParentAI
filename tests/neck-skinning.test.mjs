import test from 'node:test';
import assert from 'node:assert/strict';
import {deformPortraitNeck} from '../web/neck-skinning.mjs';

test('lowered head moves upper neck with it without moving the collar',()=>{
  const base=new Float32Array([.2,1,.1,.3,.5,.1,.4,0,.1]),output=new Float32Array(base.length);
  deformPortraitNeck(base,output,{x:0,y:1,z:0},{x:0,y:0,z:0},1,0,.06);
  assert.ok(Math.abs(output[1]-.94)<1e-6);
  assert.ok(Math.abs(output[4]-.47)<1e-6);
  assert.deepEqual([...output.slice(6)],[...base.slice(6)]);
});

test('upper neck follows the same head rotation while collar stays fixed',()=>{
  const base=new Float32Array([.2,1,.1,.3,.5,.1,.4,0,.1]),output=new Float32Array(base.length),joint={x:0,y:1,z:-.2};
  for(const rotation of [{x:.1,y:.2,z:-.08},{x:-.15,y:-.3,z:.1},{x:0,y:0,z:0}]){
    deformPortraitNeck(base,output,joint,rotation,1,0);
    const before=Math.hypot(base[0]-joint.x,base[1]-joint.y,base[2]-joint.z),after=Math.hypot(output[0]-joint.x,output[1]-joint.y,output[2]-joint.z);
    assert.ok(Math.abs(before-after)<1e-6,'jaw attachment rotates rigidly without changing head proportions');
    assert.deepEqual([...output.slice(6)],[...base.slice(6)]);
    assert.ok(output.every(Number.isFinite));
    const first=output.slice();deformPortraitNeck(base,output,joint,rotation,1,0);assert.deepEqual(output,first);
  }
  assert.deepEqual(output,base);
});

test('neck attachment uses the same XYZ rotation convention as the head',()=>{
  const base=new Float32Array([1,2,3]),output=new Float32Array(3),joint={x:0,y:0,z:0};
  for(const [rotation,expected] of [[{x:Math.PI/2,y:0,z:0},[1,-3,2]],[{x:0,y:Math.PI/2,z:0},[3,2,-1]],[{x:0,y:0,z:Math.PI/2},[-2,1,3]]]){
    deformPortraitNeck(base,output,joint,rotation,2,0);
    expected.forEach((value,i)=>assert.ok(Math.abs(output[i]-value)<1e-6));
  }
});

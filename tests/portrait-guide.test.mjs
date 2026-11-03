import test from 'node:test';
import assert from 'node:assert/strict';
import {containedCameraRect} from '../web/portrait-guide.mjs';

test('body guide follows the actual camera pixels rather than letterbox bars',()=>{
  assert.deepEqual(containedCameraRect(1000,600,640,480),{left:100,top:0,width:800,height:600});
  assert.deepEqual(containedCameraRect(800,800,1280,720),{left:0,top:175,width:800,height:450});
  assert.equal(containedCameraRect(800,800,0,0),null);
});

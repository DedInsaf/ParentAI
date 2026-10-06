import test from 'node:test';
import assert from 'node:assert/strict';
import {AvatarMotion} from '../web/avatar-motion.mjs';

test('idle pose changes continuously, with brief gaze shifts and body sway',()=>{
  const motion=new AvatarMotion();let before=null,glance=0,sway=0;
  for(let t=0;t<24;t+=1/30){
    const pose={...motion.update(t,{active:true})};
    if(before)for(const key of ['yaw','pitch','roll','bodyRoll','gazeX'])assert.ok(Math.abs(pose[key]-before[key])<.025);
    glance=Math.max(glance,Math.abs(pose.yaw));sway=Math.max(sway,Math.abs(pose.bodyRoll));before=pose;
  }
  assert.ok(glance>.07);assert.ok(sway>.004);
});
test('local speech smoothly redirects gaze and head before recognition completes',()=>{
  const motion=new AvatarMotion();let p;
  for(let t=0;t<=9;t+=1/60)p=motion.update(t,{active:true});
  const before={...p};assert.ok(Math.abs(before.yaw)>.07);
  const first={...motion.update(9.02,{active:true,listening:true})};
  assert.ok(Math.abs(first.yaw)>0);assert.ok(Math.abs(first.yaw-before.yaw)<.035);
  for(let t=9.04;t<9.54;t+=1/60)p=motion.update(t,{active:true,listening:true});
  assert.ok(Math.abs(p.yaw)<.02);assert.ok(Math.abs(p.gazeX)<.003);
  for(let t=9.55;t<11.9;t+=1/60)p=motion.update(t,{active:true});
  assert.ok(Math.abs(p.yaw)<.02); // attention survives the child's pause
});
test('preview turns, pauses, and reduced motion never reset pose abruptly',()=>{
  const motion=new AvatarMotion();motion.update(0);
  const first={...motion.update(.03,{preview:.26,active:true})};assert.ok(first.preview>0&&first.preview<.05);
  let p;for(let t=.06;t<2;t+=.03)p=motion.update(t,{preview:.26,active:true});
  assert.ok(Math.abs(p.preview-.26)<.001);
  const before={...p};const next={...motion.update(2.03,{preview:0,reduced:true})};assert.ok(next.preview>0&&next.preview<before.preview);
  for(let t=2.06;t<5;t+=.03)p=motion.update(t,{reduced:true});
  for(const key of ['yaw','pitch','roll','breath','gazeX','bodyYaw','bodyRoll'])assert.ok(Math.abs(p[key])<.001);
});

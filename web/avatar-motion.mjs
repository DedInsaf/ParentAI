// Stateful motion in seconds. Input changes only targets, never the rendered pose.
const damp=(value,target,velocity,dt,speed)=>{
  const offset=value-target,term=(velocity+speed*offset)*dt,decay=Math.exp(-speed*dt);
  return [target+(offset+term)*decay,(velocity-speed*term)*decay];
};
export class AvatarMotion {
  constructor(){this.last=null;this.attentionUntil=0;this.nextLook=0;this.lookX=0;this.lookY=0;this.pose={yaw:0,pitch:0,roll:0,bodyRoll:0,bodyYaw:0,breath:0,gazeX:0,gazeY:0,preview:0};this.velocity=Object.fromEntries(Object.keys(this.pose).map(k=>[k,0]));}
  attend(seconds){this.attentionUntil=Math.max(this.attentionUntil,seconds+3);}
  update(seconds,{active=false,speaking=false,listening=false,engaged=false,preview=0,reduced=false}={}) {
    const dt=this.last===null?0:Math.min(.08,Math.max(0,seconds-this.last));this.last=seconds;
    if(listening||engaged||speaking)this.attend(seconds);
    const attentive=seconds<this.attentionUntil;
    if(seconds>=this.nextLook){
      // Brief glances with a calm return in between; deterministic for testing.
      const step=Math.floor(seconds/5.9);
      this.lookX=step%3===0?0:Math.sin(step*2.4)*.13;
      this.lookY=step%3===0?0:Math.cos(step*1.7)*.035;
      this.nextLook=seconds+2.4+(1+Math.sin(step*1.3))*1.4;
    }
    const move=active&&!reduced?1:0;
    const targets={
      yaw:move*((attentive?0:this.lookX)+Math.sin(seconds*.71)*.012),
      pitch:move*((attentive?0:this.lookY)+Math.sin(seconds*.83)*.011+(speaking?Math.sin(seconds*2.7)*.008:0)),
      roll:move*Math.sin(seconds*.43)*.009,
      bodyRoll:move*Math.sin(seconds*.37)*.006,
      bodyYaw:move*Math.sin(seconds*.29)*.010,
      breath:move*(Math.sin(seconds*1.38)*.0018),
      gazeX:move*(attentive?0:this.lookX*1.6),gazeY:move*(attentive?0:this.lookY*1.4),preview,
    };
    for(const key of Object.keys(this.pose)) {
      const speed=key.startsWith('gaze')?(attentive?16:5):key==='preview'?9:attentive&&key==='yaw'?9:3.5;
      [this.pose[key],this.velocity[key]]=damp(this.pose[key],targets[key],this.velocity[key],dt,speed);
    }
    return this.pose;
  }
}

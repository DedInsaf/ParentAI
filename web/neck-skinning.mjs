// The jaw and upper neck move together; the collar stays on the torso.
// Coordinates are in the original portrait frame, before group offsets.
export function deformPortraitNeck(base,output,joint,rotation,jawY,collarY){
  const span=Math.max(.0001,jawY-collarY);
  const cx=Math.cos(rotation.x),sx=Math.sin(rotation.x),cy=Math.cos(rotation.y),sy=Math.sin(rotation.y),cz=Math.cos(rotation.z),sz=Math.sin(rotation.z);
  for(let i=0;i<base.length;i+=3){
    const t=Math.max(0,Math.min(1,(base[i+1]-collarY)/span)),weight=t*t*(3-2*t);
    const x=base[i]-joint.x,y=base[i+1]-joint.y,z=base[i+2]-joint.z;
    const zx=cz*x-sz*y,zy=sz*x+cz*y,yx=cy*zx+sy*z,yz=-sy*zx+cy*z;
    output[i]=base[i]+(yx-x)*weight;
    output[i+1]=base[i+1]+(cx*zy-sx*yz-y)*weight;
    output[i+2]=base[i+2]+(sx*zy+cx*yz-z)*weight;
  }
  return output;
}

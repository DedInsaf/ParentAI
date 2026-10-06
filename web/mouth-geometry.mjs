// A recessed, closed interior follows the actual animated inner-lip boundary.
// Keeping its rim near the lips hides the background even from a side view.
export function mouthInteriorPositions(face, ring, width, output=new Float32Array((ring.length*2+1)*3)) {
  const center=[0,0,0],n=ring.length;
  for(const id of ring) for(let axis=0;axis<3;axis++) center[axis]+=face[id*3+axis]/n;
  ring.forEach((id,i)=>{
    for(let axis=0;axis<3;axis++) {
      const value=face[id*3+axis];
      output[i*3+axis]=value-(axis===2 ? width*.004 : 0);
      output[(n+i)*3+axis]=center[axis]+(value-center[axis])*.68-(axis===2 ? width*.085 : 0);
    }
  });
  output.set([center[0],center[1],center[2]-width*.16],n*6);
  return output;
}

export function mouthInteriorGeometry(face,ring,width) {
  const indices=[],n=ring.length;
  for(let i=0;i<n;i++) {
    const j=(i+1)%n;
    indices.push(i,j,n+i,j,n+j,n+i,n+i,n+j,n*2);
  }
  return {positions:mouthInteriorPositions(face,ring,width),indices};
}

export function upperTeethGeometry(width) {
  const positions=[],indices=[];
  const outline=[[-.5,.15],[-.35,0],[.35,0],[.5,.15],[.5,.85],[.35,1],[-.35,1],[-.5,.85]];
  // Six small rounded crowns along a recessed dental arch, rather than a box.
  for(let tooth=0;tooth<6;tooth++) {
    const start=positions.length/3,cx=(tooth-2.5)*width*.075;
    const depth=x=>-width*(.03+.35*(x/width)**2);
    for(const [x,y] of outline) {
      const px=cx+x*width*.068;
      positions.push(px,width*(-.052+y*.042),depth(px));
    }
    positions.push(cx,-width*.031,depth(cx)+width*.002);
    for(let i=0;i<outline.length;i++) indices.push(start+i,start+(i+1)%outline.length,start+outline.length);
  }
  return {positions,indices};
}

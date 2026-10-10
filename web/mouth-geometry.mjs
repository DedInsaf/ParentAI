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
  const indices=[],colors=[],n=ring.length,centerY=ring.reduce((sum,id)=>sum+face[id*3+1],0)/n;
  for(let layer=0;layer<2;layer++)for(const id of ring){
    const lower=face[id*3+1]<centerY?1:0,depth=layer?.72:1;
    colors.push((.105+lower*.035)*depth,(.018+lower*.012)*depth,(.028+lower*.012)*depth);
  }
  colors.push(.035,.004,.008);
  for(let i=0;i<n;i++) {
    const j=(i+1)%n;
    indices.push(i,j,n+i,j,n+j,n+i,n+i,n+j,n*2);
  }
  return {positions:mouthInteriorPositions(face,ring,width),indices,colors};
}

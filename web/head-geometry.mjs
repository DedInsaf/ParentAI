// Lightweight fitted topology. No spherical primitive or image plane is used for the skull.
export const OVAL = [10,338,297,332,284,251,389,356,454,323,361,288,397,365,379,378,400,377,152,148,176,149,150,136,172,58,132,93,234,127,162,21,54,103,67,109];

export function skullGeometry(face) {
  const x=OVAL.map(i=>face[i*3]), y=OVAL.map(i=>face[i*3+1]);
  const width=Math.max(...x)-Math.min(...x), height=Math.max(...y)-Math.min(...y);
  const cx=(Math.max(...x)+Math.min(...x))/2, cy=(Math.max(...y)+Math.min(...y))/2;
  const edgeZ=OVAL.reduce((sum,i)=>sum+face[i*3+2],0)/OVAL.length;
  const depth=width*.74, positions=[], indices=[], rim=[];
  // Ring zero is exactly the face oval: a shared positional boundary, not an overlay.
  for(let ring=0;ring<=8;ring++) {
    const t=ring/8;
    const contourScale=Math.cos(Math.PI*t/2)*(1+.12*Math.sin(Math.PI*t));
    for(const [j,id] of OVAL.entries()) {
      const fx=face[id*3],fy=face[id*3+1],fz=face[id*3+2];
      const upper=Math.max(0,(fy-cy)/height);
      positions.push(cx+(fx-cx)*contourScale,cy+(fy-cy)*contourScale+upper*height*.18*Math.sin(Math.PI*t),
        fz*(1-t)+edgeZ*t-depth*Math.sin(Math.PI*t/2));
      rim.push(1-t);
      if(ring) { const a=(ring-1)*OVAL.length+j,b=(ring-1)*OVAL.length+(j+1)%OVAL.length,c=ring*OVAL.length+j,d=ring*OVAL.length+(j+1)%OVAL.length; indices.push(a,c,b,b,c,d); }
    }
  }
  const center=positions.length/3; positions.push(cx,cy,edgeZ-depth-.07*width); rim.push(0);
  for(let j=0;j<OVAL.length;j++) indices.push(8*OVAL.length+j,center,8*OVAL.length+(j+1)%OVAL.length);
  return {positions,indices,rim,cx,cy,width,height,edgeZ,depth};
}

export function earGeometry(head, side) {
  const {cx,cy,width,height,edgeZ}=head, positions=[],indices=[],shade=[];
  // Radial concha and raised helix, with an asymmetric lobe and a curved outer rim.
  const rings=7,segments=32;
  for(let r=0;r<=rings;r++) for(let i=0;i<segments;i++) {
    const radius=r/rings, a=2*Math.PI*i/segments;
    const lobe=1-.13*Math.max(0,-Math.sin(a));
    const bulge=Math.exp(-Math.pow((radius-.78)/.16,2))*.048*width;
    positions.push(cx+side*(width*.48+radius*width*.055*Math.cos(a)),
      cy+height*.01+radius*height*.12*Math.sin(a)*lobe,
      edgeZ-width*.17+bulge-radius*width*.025);
    shade.push(.70+.30*radius);
    if(r) { const a0=(r-1)*segments+i,b=(r-1)*segments+(i+1)%segments,c=r*segments+i,d=r*segments+(i+1)%segments;indices.push(a0,c,b,b,c,d); }
  }
  return {positions,indices,shade};
}

export function neckGeometry(head) {
  const {cx,cy,width,height,edgeZ}=head, positions=[],indices=[];
  const profiles=Array.from({length:25},(_,i)=>{
    const t=i/24;
    // Tuck under the jaw, narrow gently at mid-neck, then meet the collar.
    // The old diameter was only a third of face width and looked like a stalk.
    return [.30-.03*Math.sin(Math.PI*t)+.025*t, .32+.51*t, .21-.018*Math.sin(Math.PI*t)+.018*t];
  });
  for(const [ring,[rx,drop,rz]] of profiles.entries()) for(let j=0;j<32;j++) {
    const a=j/32*Math.PI*2;
    positions.push(cx+width*rx*Math.cos(a),cy-height*drop,edgeZ-width*.33+width*rz*Math.sin(a));
    if(ring) {const b=(ring-1)*32+j,c=(ring-1)*32+(j+1)%32,d=ring*32+j,e=ring*32+(j+1)%32;indices.push(b,d,c,c,d,e);}
  }
  // Close the base; no cone-shaped shoulder primitive beneath the face.
  const center=positions.length/3;
  positions.push(cx,cy-height*.83,edgeZ-width*.33);
  for(let j=0;j<32;j++) indices.push(24*32+j,24*32+(j+1)%32,center);
  return {positions,indices};
}

export function hairGeometry(head,style='short') {
  if(style==='none')return {positions:[],indices:[]};
  const {cx,cy,width,height,edgeZ,depth}=head,positions=[],indices=[];
  // Fit the scalp to the same skull rings. An independent ellipsoid intersected
  // the temples and left large exposed triangular patches during head turns.
  const contour=[28,29,30,31,32,33,34,35,0,1,2,3,4,5,6,7,8],columns=contour.length;
  for(let ring=0;ring<=8;ring++)for(let j=0;j<columns;j++){
    const offset=(ring*OVAL.length+contour[j])*3,t=ring/8;
    const x=head.positions[offset],y=head.positions[offset+1],z=head.positions[offset+2];
    const lock=Math.sin(j*2.7+ring*.7)*width*.002*t;
    const length=style==='medium'?height*.15*t*(1-Math.max(0,(y-cy)/height)*1.5):0;
    positions.push(cx+(x-cx)*1.025,y+height*.018*(1-.7*t)-length,
      z+width*.012*(1-t)-width*.012*t+lock);
    if(ring&&j){const a=(ring-1)*columns+j-1,b=a+1,c=ring*columns+j-1,d=c+1;indices.push(a,c,b,b,c,d);}
  }
  return {positions,indices};
}

export function blinkAmount(seconds) {
  const phase=seconds%4.7;
  return phase<.18 ? Math.sin(Math.PI*phase/.18) : 0;
}

export function torsoGeometry(head){
  const {cx,cy,width,height,edgeZ}=head,positions=[],indices=[];
  // Start at the actual base of the neck.  The previous .74 profile was high
  // enough to hide most of the neck behind a straight strip of shirt.
  const profiles=[[.34,.815,.23],[.64,.88,.24],[1.07,1,.25],[1.12,1.2,.27],[1.06,1.56,.27]];
  const rows=32,segments=48;
  for(let row=0;row<=rows;row++){
    const v=row/rows*(profiles.length-1),i=Math.min(profiles.length-2,Math.floor(v));
    const t=v-i,e=t*t*(3-2*t);
    const [rx,drop,rz]=profiles[i].map((x,k)=>x*(1-e)+profiles[i+1][k]*e);
    for(let j=0;j<segments;j++){
      const a=j/segments*Math.PI*2;
      // Lower only the front-centre edge to form a soft round collar.  It
      // exposes the neck while the sides and back still overlap it cleanly.
      const collarFade=Math.max(0,1-row/7),front=Math.max(0,Math.sin(a));
      const collarDip=.075*Math.pow(front,4)*collarFade*collarFade;
      positions.push(cx+width*rx*Math.cos(a),cy-height*(drop+collarDip),edgeZ-width*.33+width*rz*Math.sin(a));
      if(row){const b=(row-1)*segments+j,c=(row-1)*segments+(j+1)%segments,d=row*segments+j,f=row*segments+(j+1)%segments;indices.push(b,d,c,c,d,f);}
    }
  }
  const center=positions.length/3;positions.push(cx,cy-height*1.56,edgeZ-width*.33);
  for(let j=0;j<segments;j++)indices.push(rows*segments+j,center,rows*segments+(j+1)%segments);
  return {positions,indices};
}

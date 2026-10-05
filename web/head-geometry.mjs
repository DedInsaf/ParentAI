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
    return [.19-.035*Math.sin(Math.PI*t)+.015*t, .32+.51*t, .15-.016*Math.sin(Math.PI*t)];
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

export function hairGeometry(head, style='short') {
  if(style==='none') return {positions:[],indices:[]};
  const {cx,cy,width,height,edgeZ,depth}=head, positions=[],indices=[];
  const rows=16,columns=48;
  // Scalp shape plus tapered directional locks. Hairline is higher at the front.
  for(let r=0;r<=rows;r++) for(let j=0;j<=columns;j++) {
    const a=j/columns*Math.PI*2, front=(1+Math.sin(a))/2;
    const phi=(r/rows)*(.78+(.70*(1-front)));
    const lock=Math.sin(j*2.7+r*.42)*.009*width*(r/rows);
    const length=style==='medium' ? .055*height*(1-front)*r/rows : 0;
    positions.push(cx+Math.cos(a)*Math.sin(phi)*(width*.56+lock),
      cy+height*.60*Math.cos(phi)-length,
      edgeZ-depth*.48+Math.sin(a)*Math.sin(phi)*(depth*.74+lock));
    if(r && j) {const b=(r-1)*(columns+1)+j-1,c=b+1,d=r*(columns+1)+j-1,e=d+1;indices.push(b,d,c,c,d,e);}
  }
  return {positions,indices};
}

export function blinkAmount(seconds) {
  const phase=seconds%4.7;
  return phase<.18 ? Math.sin(Math.PI*phase/.18) : 0;
}

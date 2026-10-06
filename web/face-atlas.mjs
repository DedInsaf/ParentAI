import {closeFaceOpenings} from './core.mjs';

// Keep the portrait's coordinate system, with sharper facial pixels from the close-up.
export function bakePortraitFaceAtlas(portrait,detail,indices) {
  const atlas=document.createElement('canvas');atlas.width=portrait.canvas.width;atlas.height=portrait.canvas.height;
  const ctx=atlas.getContext('2d');ctx.drawImage(portrait.canvas,0,0);
  if(!detail || detail===portrait)return atlas;
  const srcPoints=closeFaceOpenings(detail.landmarks,[],false).points;
  const dstPoints=closeFaceOpenings(portrait.landmarks,[],false).points;
  for(let i=0;i<indices.length;i+=3) {
    const ids=indices.slice(i,i+3);
    const src=ids.map(id=>[srcPoints[id].x*detail.canvas.width,srcPoints[id].y*detail.canvas.height]);
    const dst=ids.map(id=>[dstPoints[id].x*atlas.width,dstPoints[id].y*atlas.height]);
    const [p,q,r]=src,[a,b,c]=dst,u=q[0]-p[0],v=q[1]-p[1],s=r[0]-p[0],t=r[1]-p[1],det=u*t-s*v;
    if(Math.abs(det)<.05)continue;
    const aa=((b[0]-a[0])*t-(c[0]-a[0])*v)/det,cc=((c[0]-a[0])*u-(b[0]-a[0])*s)/det;
    const bb=((b[1]-a[1])*t-(c[1]-a[1])*v)/det,dd=((c[1]-a[1])*u-(b[1]-a[1])*s)/det;
    ctx.save();ctx.beginPath();ctx.moveTo(...a);ctx.lineTo(...b);ctx.lineTo(...c);ctx.closePath();ctx.clip();
    ctx.setTransform(aa,bb,cc,dd,a[0]-aa*p[0]-cc*p[1],a[1]-bb*p[0]-dd*p[1]);ctx.drawImage(detail.canvas,0,0);ctx.restore();
  }
  return atlas;
}

// Warp visible cheek triangles from the side scans into the front UV atlas.
// Unseen/foreshortened triangles keep the front photo; no invented side pixels.
export function bakeFaceAtlas(front,views,indices){
  const atlas=document.createElement('canvas');atlas.width=front.canvas.width;atlas.height=front.canvas.height;
  const ctx=atlas.getContext('2d');ctx.drawImage(front.canvas,0,0);
  const nose=front.landmarks[1].x,half=Math.abs(front.landmarks[454].x-front.landmarks[234].x)/2;
  for(let i=0;i<indices.length;i+=3){
    const ids=indices.slice(i,i+3);
    if(ids.some(id=>id>=468))continue;
    const x=ids.reduce((sum,id)=>sum+front.landmarks[id].x,0)/3;
    const amount=Math.max(0,Math.min(.85,(Math.abs(x-nose)/half-.32)/.65));
    if(amount<.03)continue;
    const source=views.find(v=>v!==front && v.canvas && (x<nose?v.yaw>.16:v.yaw<-.16));
    if(!source)continue;
    const src=ids.map(id=>[source.landmarks[id].x*source.canvas.width,source.landmarks[id].y*source.canvas.height]);
    const dst=ids.map(id=>[front.landmarks[id].x*atlas.width,front.landmarks[id].y*atlas.height]);
    const [p,q,r]=src,[a,b,c]=dst;
    const u=q[0]-p[0],v=q[1]-p[1],s=r[0]-p[0],t=r[1]-p[1],det=u*t-s*v;
    const area=(b[0]-a[0])*(c[1]-a[1])-(c[0]-a[0])*(b[1]-a[1]);
    if(Math.abs(area)<.2 || Math.abs(det)<.2 || Math.abs(det/area)<.22)continue;
    const aa=((b[0]-a[0])*t-(c[0]-a[0])*v)/det;
    const cc=((c[0]-a[0])*u-(b[0]-a[0])*s)/det;
    const bb=((b[1]-a[1])*t-(c[1]-a[1])*v)/det;
    const dd=((c[1]-a[1])*u-(b[1]-a[1])*s)/det;
    ctx.save();ctx.beginPath();ctx.moveTo(...a);ctx.lineTo(...b);ctx.lineTo(...c);ctx.closePath();ctx.clip();
    ctx.globalAlpha=amount;ctx.setTransform(aa,bb,cc,dd,a[0]-aa*p[0]-cc*p[1],a[1]-bb*p[0]-dd*p[1]);
    ctx.drawImage(source.canvas,0,0);ctx.restore();
  }
  return atlas;
}

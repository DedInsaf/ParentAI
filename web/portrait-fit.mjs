import {defaultPortraitAnchors,portraitAnchorIssue} from './portrait-geometry.mjs';

export function combineCategoryMasks(masks,width,height) {
  if(!Array.isArray(masks)||!masks.length||masks.some(mask=>mask?.length!==width*height))throw new Error('Некорректные маски портрета');
  const result=new Uint8Array(width*height),counts=new Uint8Array(6);
  for(let i=0;i<result.length;i++){
    counts.fill(0);for(const mask of masks)if(mask[i]<counts.length)counts[mask[i]]++;
    let best=masks[0][i],votes=counts[best]||0;
    for(let category=0;category<counts.length;category++)if(counts[category]>votes){best=category;votes=counts[category];}
    result[i]=best;
  }
  // Two conservative majority passes remove isolated background holes without
  // shaving off thin ears, hair strands or the shirt collar.
  let current=result;
  for(let pass=0;pass<2;pass++){
    const next=current.slice();
    for(let y=1;y<height-1;y++)for(let x=1;x<width-1;x++){
      counts.fill(0);for(let oy=-1;oy<=1;oy++)for(let ox=-1;ox<=1;ox++)counts[current[(y+oy)*width+x+ox]]++;
      let best=current[y*width+x],votes=counts[best];for(let category=0;category<counts.length;category++)if(counts[category]>votes){best=category;votes=counts[category];}
      if(votes>=6)next[y*width+x]=best;
    }
    current=next;
  }
  return current;
}

// Fit to measured classes in image space, rather than average head/body ratios.
// Labels: background, hair, body skin, face skin, clothes, accessories.
export function fitPortraitAnchors(lm,{data,width,height}) {
  const a=defaultPortraitAnchors(lm);
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||data?.length!==width*height)return a;
  const fw=lm[454].x-lm[234].x,fh=lm[152].y-lm[10].y,cx=lm[152].x;
  const at=(x,y)=>data[Math.min(height-1,Math.max(0,Math.round(y*height)))*width+Math.min(width-1,Math.max(0,Math.round(x*width)))];
  const run=(y,accept,limit=fw*1.8)=>{
    let l=cx,r=cx;if(!accept(at(cx,y)))return null;
    for(let x=cx;x>=Math.max(.02,cx-limit);x-=1/width){if(!accept(at(x,y)))break;l=x;}
    for(let x=cx;x<=Math.min(.98,cx+limit);x+=1/width){if(!accept(at(x,y)))break;r=x;}
    return r-l>fw*.25?{left:l,right:r,y}:null;
  };
  const hair=[];
  for(let y=Math.max(.02,lm[10].y-fh*.65);y<lm[234].y;y+=1/height)for(let x=Math.max(.02,lm[234].x-fw*.35);x<Math.min(.98,lm[454].x+fw*.35);x+=1/width)if(at(x,y)===1)hair.push({x,y});
  if(hair.length>12){
    const top=Math.min(...hair.map(p=>p.y)),upper=hair.filter(p=>p.y<top+3/height);
    a.crown={x:upper.reduce((s,p)=>s+p.x,0)/upper.length,y:top};
    const left=hair.reduce((p,v)=>v.x<p.x?v:p),right=hair.reduce((p,v)=>v.x>p.x?v:p);
    a.templeLeft={...left};a.templeRight={...right};
  }
  const neckRows=[];
  for(let y=lm[152].y+fh*.04;y<Math.min(.97,lm[152].y+fh*.30);y+=1/height){
    const row=run(y,c=>c===2||c===3,fw*.6);
    if(row&&row.right-row.left<fw*1.05)neckRows.push(row);
  }
  if(neckRows.length>=3){
    // A V-neck exposes skin far below the actual neck. Use the last broad
    // section, not the last skin pixel at the tip of the shirt opening.
    const widest=Math.max(...neckRows.map(r=>r.right-r.left));
    const row=neckRows.filter(r=>r.right-r.left>=widest*.85).at(-1);
    a.neckLeft={x:row.left,y:row.y};a.neckRight={x:row.right,y:row.y};
  }
  const body=[];
  const bottom=Math.min(.96,lm[152].y+fh*1.15);
  for(let y=Math.max(a.neckLeft.y,a.neckRight.y)+2/height;y<=bottom;y+=1/height){
    const row=run(y,c=>c>0);if(row&&row.right-row.left>fw*1.3)body.push(row);
  }
  if(body.length>5){
    const maxWidth=Math.max(...body.map(r=>r.right-r.left));
    const shoulder=body.find(r=>r.right-r.left>=maxWidth*.90),chest=body.at(-1);
    if(shoulder&&shoulder.y<chest.y){
      a.shoulderLeft={x:shoulder.left,y:shoulder.y};a.shoulderRight={x:shoulder.right,y:shoulder.y};
      a.chestLeft={x:chest.left,y:chest.y};a.chestRight={x:chest.right,y:chest.y};
    }
  }
  // Ears are skin, not the hair silhouette. Keep a modest estimate if obscured.
  for(const [key,id,side] of [['earLeft',234,-1],['earRight',454,1]]){
    let best=null;
    for(let y=lm[id].y-fh*.04;y<lm[id].y+fh*.16;y+=1/height)for(let n=0;n<=fw*.22;n+=1/width){const x=lm[id].x+side*n,c=at(x,y);if((c===2||c===3)&&(!best||side*x>side*best.x))best={x,y};}
    if(best&&side*(best.x-lm[id].x)>fw*.015){
      // Segmentation often includes a lock of hair or a shadow below one ear.
      // Measure only its horizontal reach; MediaPipe gives the stable ear height.
      const reach=Math.min(fw*.16,Math.max(fw*.035,side*(best.x-lm[id].x)));
      a[key]={x:lm[id].x+side*reach,y:lm[id].y+fh*.035};
    }
  }
  return portraitAnchorIssue(a,lm)?defaultPortraitAnchors(lm):a;
}

export function fitStablePortraitAnchors(lm,mask) {
  const {data,width,height}=mask;
  if(data?.length!==width*height)return defaultPortraitAnchors(lm);
  const shifted=(dx,dy)=>{
    const output=new Uint8Array(data.length);
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){
      const sx=Math.max(0,Math.min(width-1,x-dx)),sy=Math.max(0,Math.min(height-1,y-dy));
      output[y*width+x]=data[sy*width+sx];
    }
    return fitPortraitAnchors(lm,{data:output,width,height});
  };
  const candidates=[[0,0],[-1,0],[1,0],[0,-1],[0,1]].map(([dx,dy])=>shifted(dx,dy));
  const result=structuredClone(candidates[0]),median=values=>values.sort((a,b)=>a-b)[values.length>>1];
  for(const key of Object.keys(result))for(const axis of ['x','y'])result[key][axis]=median(candidates.map(candidate=>candidate[key][axis]));
  return portraitAnchorIssue(result,lm)?candidates[0]:result;
}

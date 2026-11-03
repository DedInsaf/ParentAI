export function containedCameraRect(boxWidth,boxHeight,videoWidth,videoHeight){
  if(!(boxWidth>0&&boxHeight>0&&videoWidth>0&&videoHeight>0))return null;
  const scale=Math.min(boxWidth/videoWidth,boxHeight/videoHeight),width=videoWidth*scale,height=videoHeight*scale;
  return {left:(boxWidth-width)/2,top:(boxHeight-height)/2,width,height};
}

let overlay=null;
export function updatePortraitGuide(video,active,ready=false){
  if(!active){overlay?.remove();overlay=null;return;}
  const rect=containedCameraRect(video.clientWidth,video.clientHeight,video.videoWidth,video.videoHeight);
  if(!rect)return;
  if(!overlay){
    overlay=document.createElement('div');overlay.setAttribute('aria-hidden','true');
    Object.assign(overlay.style,{position:'absolute',pointerEvents:'none',zIndex:'3'});
    video.parentElement.appendChild(overlay);
  }
  Object.assign(overlay.style,{left:`${video.offsetLeft+rect.left}px`,top:`${video.offsetTop+rect.top}px`,width:`${rect.width}px`,height:`${rect.height}px`});
  const aspect=video.videoHeight/video.videoWidth,rx=170*aspect,shoulder=620*aspect,color=ready?'#a7f3b1':'#ffffff';
  const signature=`${aspect}:${ready}`;if(overlay.dataset.signature===signature)return;
  overlay.dataset.signature=signature;
  overlay.innerHTML=`<svg width="100%" height="100%" viewBox="0 0 1000 1000" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
    <g fill="none" stroke="#153b31" stroke-opacity=".5" stroke-width="9">
      <ellipse cx="500" cy="320" rx="${rx}" ry="205"/>
      <path d="M ${500-rx*.65} 525 L ${500-rx*.65} 565 Q ${500-shoulder} 600 ${500-shoulder} 815 M ${500+rx*.65} 525 L ${500+rx*.65} 565 Q ${500+shoulder} 600 ${500+shoulder} 815"/>
    </g>
    <g fill="none" stroke="${color}" stroke-width="3" stroke-dasharray="12 8">
      <ellipse cx="500" cy="320" rx="${rx}" ry="205"/>
      <path d="M ${500-rx*.65} 525 L ${500-rx*.65} 565 Q ${500-shoulder} 600 ${500-shoulder} 815 M ${500+rx*.65} 525 L ${500+rx*.65} 565 Q ${500+shoulder} 600 ${500+shoulder} 815"/>
    </g>
    <rect x="170" y="855" width="660" height="90" rx="22" fill="#153b31" fill-opacity=".86"/>
    <text x="500" y="910" fill="white" font-family="sans-serif" font-size="28" text-anchor="middle">${ready?'Положение подходит · не двигайтесь':'Голова в овале · плечи внутри контура'}</text>
  </svg>`;
}

const MAX_PIXELS=2_100_000;

function dimensions(plane,valueName){
  const width=plane?.width,height=plane?.height;
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width*height>MAX_PIXELS)throw new Error(`Некорректные размеры ${valueName}.`);
  return {width,height,length:width*height};
}

export function encodeBytes(value){
  const bytes=value instanceof Uint8Array?value:new Uint8Array(value.buffer,value.byteOffset,value.byteLength),parts=[];
  for(let offset=0;offset<bytes.length;offset+=0x8000)parts.push(String.fromCharCode(...bytes.subarray(offset,offset+0x8000)));
  return btoa(parts.join(''));
}

export function decodeBytes(value,length){
  if(typeof value!=='string'||value.length>Math.ceil(length/3)*4+4)throw new Error('Некорректные сохранённые данные аватара.');
  let binary;try{binary=atob(value);}catch{throw new Error('Некорректные сохранённые данные аватара.');}
  if(binary.length!==length)throw new Error('Сохранённые данные аватара повреждены.');
  const bytes=new Uint8Array(length);for(let i=0;i<length;i++)bytes[i]=binary.charCodeAt(i);return bytes;
}

export function packPortraitAnalysis(view){
  const segmentation=view?.segmentation,matte=view?.matte;
  const labels=dimensions(segmentation,'маски'),alpha=dimensions(matte,'силуэта');
  if(segmentation.data?.length!==labels.length||matte.alpha?.length!==alpha.length)throw new Error('Анализ портрета не завершён.');
  const quantized=new Uint8Array(alpha.length);
  for(let i=0;i<quantized.length;i++)quantized[i]=Math.round(Math.max(0,Math.min(1,matte.alpha[i]))*255);
  return {segmentation:{width:labels.width,height:labels.height,data:encodeBytes(segmentation.data)},matte:{width:alpha.width,height:alpha.height,alpha:encodeBytes(quantized)}};
}

export function unpackPortraitAnalysis(value){
  const labels=dimensions(value?.segmentation,'маски'),matteInfo=dimensions(value?.matte,'силуэта');
  const data=decodeBytes(value.segmentation.data,labels.length),quantized=decodeBytes(value.matte.alpha,matteInfo.length),alpha=new Float32Array(matteInfo.length);
  for(let i=0;i<alpha.length;i++)alpha[i]=quantized[i]/255;
  const matte={width:matteInfo.width,height:matteInfo.height,alpha};
  return {segmentation:{width:labels.width,height:labels.height,data,matte},matte};
}

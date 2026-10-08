// Both networks run inside this worker. No photo is sent to a remote service.
self.onmessage=async ({data:bitmap})=>{
  let segmenter,session;
  const began=performance.now(),progress=message=>self.postMessage({progress:true,message});
  try {
    const {FilesetResolver,ImageSegmenter}=await import('./vendor/vision/vision_bundle.mjs');
    const {imageToNchw,cleanPortraitAlpha}=await import('./portrait-matte.mjs');
    const ort=await import('./vendor/matting/ort.wasm.min.mjs');
    progress('Находим лицо, волосы, шею и одежду…');
    const files=await FilesetResolver.forVisionTasks('/vendor/vision/wasm');
    segmenter=await ImageSegmenter.createFromOptions(files,{baseOptions:{modelAssetPath:'/vendor/vision/selfie_multiclass.tflite',delegate:'CPU'},canvas:new OffscreenCanvas(1,1),runningMode:'IMAGE',outputCategoryMask:true,outputConfidenceMasks:false});
    // Copy masks inside the callback: MediaPipe releases them when it returns.
    const classes=await new Promise((resolve,reject)=>{
      try {segmenter.segment(bitmap,result=>{
        const mask=result.categoryMask;
        resolve({data:mask.getAsUint8Array().slice(),width:mask.width,height:mask.height});
      });} catch(error){reject(error);}
    });
    segmenter.close();segmenter=null;
    progress('Аккуратно отделяем волосы и края плеч от фона…');
    // A single WASM thread works on Safari/iOS without SharedArrayBuffer.
    ort.env.wasm.numThreads=1;ort.env.wasm.proxy=false;
    ort.env.wasm.wasmPaths=new URL('./vendor/matting/',self.location.href).href;
    session=await ort.InferenceSession.create('/vendor/matting/modnet.onnx',{executionProviders:['wasm'],graphOptimizationLevel:'all'});
    const factor=Math.min(512/Math.min(bitmap.width,bitmap.height),768/Math.max(bitmap.width,bitmap.height));
    const width=Math.max(32,Math.round(bitmap.width*factor/32)*32),height=Math.max(32,Math.round(bitmap.height*factor/32)*32);
    const canvas=new OffscreenCanvas(width,height),ctx=canvas.getContext('2d',{willReadFrequently:true});
    ctx.drawImage(bitmap,0,0,width,height);
    const tensor=new ort.Tensor('float32',imageToNchw(ctx.getImageData(0,0,width,height).data,width,height),[1,3,height,width]);
    let output;
    try {output=await session.run({[session.inputNames[0]]:tensor});} finally {tensor.dispose();}
    const matteTensor=output[session.outputNames[0]],dims=matteTensor.dims;
    const matteWidth=dims.at(-1),matteHeight=dims.at(-2);
    progress('Проверяем цельность лица, шеи и одежды…');
    const alpha=cleanPortraitAlpha(matteTensor.data,matteWidth,matteHeight);
    for(const value of Object.values(output))value.dispose();
    await session.release();session=null;
    self.postMessage({...classes,matte:{alpha,width:matteWidth,height:matteHeight},engine:'modnet',analysisMs:performance.now()-began},[classes.data.buffer,alpha.buffer]);
  } catch(error){self.postMessage({error:error.message||'Не удалось отделить фон.'});}
  finally {bitmap.close();segmenter?.close();if(session)await session.release();self.close();}
};

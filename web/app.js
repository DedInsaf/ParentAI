import {positionsFor,neutralFacePositions, scanQuality, portraitQuality, faceYaw, Presence, encodeWav, withTimeout, closeFaceOpenings, FACE_OPENINGS, mouthRig, speechOpening} from './core.mjs';
import {skullGeometry, earGeometry, neckGeometry, torsoGeometry, hairGeometry, OVAL, blinkAmount} from './head-geometry.mjs';
import {bakeFaceAtlas,bakePortraitFaceAtlas} from './face-atlas.mjs';
import {SpeechGate,isDirectedSpeech} from './listening.mjs';
import {mouthInteriorGeometry,mouthInteriorPositions,upperTeethGeometry} from './mouth-geometry.mjs';
import {PORTRAIT_HANDLES,defaultPortraitAnchors,portraitAnchorIssue,portraitBodyGeometry,portraitHairContour,portraitHairGeometry,portraitEarGeometry} from './portrait-geometry.mjs';
const $ = id => document.getElementById(id);
const video = $('camera');
const fail = e => { $('error').hidden = false; $('error').textContent = e.message || String(e); };
const clearError = () => { $('error').hidden = true; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let token, status = {}, stream, detector, THREE, renderer, scene, camera, mesh, base, jawWeights, mouthWidth, cavityMesh, cavityIds, avatarGroup;
let audioContext, analyser, audioSource, pcm, playing = false, recording = false, scanning = false;
let running = false, paused = false, lastFrame = -1, lastDetect = 0, lastResult = null, lastSeenFrame = 0;
let lastMediaTimestamp = -1;
let jaw = 0, dependenciesPromise, detectError = false, connecting = false, playbackId = 0, audioKind = '';
const presence = new Presence();
const pendingActions = new Set();
let online = false, recordCancelled = false, recordingStream, recordingAbort, referenceRejected = false, previewUrl, renderTime = 0;
let referenceLoaded = false, voiceModeTouched = false;
let lessonStarted = 0, lessonElapsed = 0, tutorBusy = false;
let avatarViews=[], avatarTopology, activeCues=[], audioStarted=0, dialogId=null, helpEpoch=0;
let questionRecording=false, questionStop=false, questionCancel=false, questionAbort, questionStream;
let currentJob=null, lipShape=0, lipPucker=0;
let previewYaw=0,showWireframe=false,scanSpeechAt=0,scanSpeechText='',scanEpoch=0;
let portraitView=null,headPivot=null,teethMesh=null,tongueMesh=null;
let portraitAnchors=null,portraitDraft=false,portraitConfirmed=false,selectedAnchor='neckLeft',portraitRebuildTimer;
const portraitGroups={body:['neckLeft','neckRight','shoulderLeft','shoulderRight','chestLeft','chestRight'],hair:['crown','templeLeft','templeRight'],ears:['earLeft','earRight']};
let listener=null,listenEpoch=0,echoUntil=0,followupUntil=0,listenerPending=false,cameraEpoch=0,cameraAbort;
const audioSources=new Set();let audioNext=0;
const voiceBusy = () => ['generating', 'cancelling'].includes(status.voice);
const stopTracks = value => value?.getTracks().forEach(t => t.stop());
function mediaError(e) {
  const messages = {NotAllowedError: 'Доступ запрещён. Разрешите камеру или микрофон в настройках браузера.', NotFoundError: 'Камера или микрофон не найдены.', NotReadableError: 'Камера или микрофон заняты другим приложением.'};
  return new Error(messages[e.name] || e.message);
}


async function api(path, body, retry = true, timeout = 15000, signal) {
  const controller = new AbortController();
  const abort=()=>controller.abort();signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted)abort();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch('/api/' + path, {method: body === undefined ? 'GET' : 'POST',
      signal: controller.signal,
      headers: {'X-App-Token': token, ...(body !== undefined ? {'Content-Type': 'application/octet-stream'} : {})}, body});
    if (res.status === 403 && retry) {
      const session = await fetch('/api/session', {signal: controller.signal});
      if (!session.ok) throw new Error('Не удалось восстановить подключение');
      ({token} = await session.json());
      return api(path, body, false, timeout,signal);
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);
    return data;
  } finally { clearTimeout(timer);signal?.removeEventListener("abort",abort); }
}
function controls() {
  const transition = pendingActions.has('startBtn') || pendingActions.has('pauseBtn');
  $('scanBtn').disabled = !online || transition || !stream || scanning || running || recording || connecting;
  $('nextVoiceBtn').disabled=!mesh || scanning || portraitDraft;
  $('editProportionsBtn').hidden=!portraitView;
  $('editProportionsBtn').disabled=scanning || running;
  $('savePortraitBtn').disabled=scanning || !portraitView || running || pendingActions.has('savePortraitBtn') || Boolean(portraitAnchorIssue(portraitAnchors,portraitView.landmarks));
  for(const control of $('portraitEditor').querySelectorAll('button:not(#savePortraitBtn),select'))control.disabled=scanning || running || pendingActions.has('savePortraitBtn');
  $('previewMotionBtn').disabled=!mesh || !status.phrases?.length || scanning || recording || running;
  $('nextReadyBtn').disabled=!(status.phrases?.length) || recording || voiceBusy();
  for(const id of ['viewFrontBtn','viewSideBtn','viewMeshBtn']) $(id).disabled=!mesh || scanning;
  for(const button of document.querySelectorAll('[data-setup-step]')) button.disabled=scanning || recording || running || (portraitDraft&&button.dataset.setupStep!=='face');
  $('cameraBtn').disabled = !online || transition || connecting || scanning || running || recording;
  $('recordBtn').disabled = !online || transition || recording || scanning || running || voiceBusy();
  $('voiceMode').disabled = recording || running || voiceBusy();
  $('microphone').disabled = recording;
  $('generateBtn').disabled = !online || transition || recording || running || !status.reference || referenceRejected || status.reference_mode !== $('voiceMode').value || voiceBusy();
  $('generateBtn').textContent = $('voiceMode').value === 'direct' ? 'Сохранить напоминание' : 'Создать голос';
  $('testVoiceBtn').disabled = !online || !(status.phrases?.length) || recording || running;
  $('startBtn').disabled = !online || transition || !mesh || portraitDraft || !(status.phrases?.length) || running || scanning || recording || voiceBusy();
  $('pauseBtn').disabled = !running || transition;
  $('stopBtn').disabled = !running;
  $('lessonVoiceBtn').disabled = !running || paused || tutorBusy || questionRecording || !(status.phrases?.length);
  $('stopSpeechBtn').disabled = !playing;
  $('askBtn').disabled = tutorBusy || questionRecording || listenerPending || !online || !status.tutor?.enabled;
  $('voiceQuestionBtn').disabled = !running || paused || !online || tutorBusy || listenerPending || !status.speech?.enabled;
  $('voiceQuestionBtn').textContent = questionRecording ? 'Закончить вопрос' : 'Помощь · спросить голосом';
  $('cancelHelpBtn').hidden = !tutorBusy && !questionRecording && !listenerPending;
  $('cancelRecordBtn').hidden = !recording;
  $('cancelVoiceBtn').hidden = !voiceBusy();
  $('cancelVoiceBtn').disabled = status.voice === 'cancelling';
  $('cancelScanBtn').hidden = !scanning;
  for (const id of pendingActions) $(id).disabled = true;
  if (!running) $('monitorStatus').textContent = mesh && status.phrases?.length ? 'Готово к занятию' : 'Настройте лицо и голос';
  $('readyHint').textContent = running ? (paused ? 'Перерыв. Камера и напоминания выключены.' : 'Занятие идёт. Можно сделать перерыв в любой момент.') : !online ? 'Подключение к приложению…' : !mesh ? 'Сначала создайте маску' : !status.phrases?.length ? 'Теперь сохраните голос' : 'Всё готово. Посадите ребёнка перед камерой и начните занятие.';
}
async function poll() {
  try {
    status = await api('status'); online = true;
    $('connection').textContent = 'Подключено';
    $('ttsStatus').textContent = `Клонирование: ${status.voice_engine?.message || status.tts}`;
    $('assetsStatus').textContent = `Распознавание: ${status.assets}`;
    if (!tutorBusy && !questionRecording) $('tutorStatus').textContent = status.tutor?.message || 'Помощник YandexGPT не настроен';
    if (!recording) $('voiceHint').textContent = status.error || status.progress || (status.phrases.length ? 'Сохранённый голос готов. Можно начать занятие.' : 'Выберите способ записи голоса.');
    if (status.reference && !referenceLoaded && !recording) {
      $('reference').src = '/audio/reference.wav'; $('reference').hidden = false; referenceLoaded = true;
      if (!voiceModeTouched) { $('voiceMode').value = status.reference_mode; updateVoiceMode(); }
    }
  } catch {
    online = false; $('connection').textContent = 'Нет связи · переподключение…';
    if (running && !paused) await pause();
  } finally { controls(); }
}
async function pollLoop() { await poll(); setTimeout(pollLoop, 2000); }

async function dependencies() {
  if (!dependenciesPromise) dependenciesPromise = (async () => {
    $('cameraHint').textContent = 'Загрузка распознавания лица…';
    const [three, vision] = await Promise.all([
      import('./vendor/three.module.js'),
      import('./vendor/vision/vision_bundle.mjs'),
    ]);
    THREE = three;
    const files = await vision.FilesetResolver.forVisionTasks('/vendor/vision/wasm');
    const options = {baseOptions: {modelAssetPath: '/vendor/vision/face_landmarker.task', delegate: 'GPU'}, runningMode: 'VIDEO', numFaces: 2};
    try { detector = await vision.FaceLandmarker.createFromOptions(files, options); }
    catch { options.baseOptions.delegate = 'CPU'; detector = await vision.FaceLandmarker.createFromOptions(files, options); }
    if (!renderer) initScene();
    return vision;
  })().catch(e => { dependenciesPromise = null; throw new Error('Не удалось загрузить 3D/распознавание. Проверьте загрузку ресурсов в разделе «Состояние» и повторите. ' + e.message); });
  return dependenciesPromise;
}
function initScene() {
  scene = new THREE.Scene();
  camera = new THREE.OrthographicCamera(-1, 1, 1, -1, .01, 100);
  renderer = new THREE.WebGLRenderer({antialias: true, alpha: true});
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  scene.add(new THREE.AmbientLight(0xffffff, 1.7));
  scene.add(new THREE.HemisphereLight(0xffffff, 0x66717b, .45));
  const light = new THREE.DirectionalLight(0xffffff, .65); light.position.set(2, 3, 4); scene.add(light);
  $('scene').appendChild(renderer.domElement);
  new ResizeObserver(() => fit()).observe($('scene'));
}
function fit() {
  if (!renderer) return;
  const w = $('scene').clientWidth, h = $('scene').clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h); camera.aspect = w / h;
  if (mesh) {
    const box = new THREE.Box3().setFromObject(avatarGroup || mesh);
    const center = box.getCenter(new THREE.Vector3());
    const halfH = Math.max((box.max.y - box.min.y) / 2, (box.max.x - box.min.x) / (2 * camera.aspect)) * 1.18;
    camera.left = -halfH * camera.aspect; camera.right = halfH * camera.aspect;
    camera.top = halfH; camera.bottom = -halfH;
    camera.position.set(center.x, center.y, 5);
    camera.lookAt(center.x, center.y, 0);
  }
  camera.updateProjectionMatrix();
}
async function enableCamera() {
  if (stream && stream.getVideoTracks().some(t => t.readyState === 'live')) return;
  stopCamera(); const epoch=cameraEpoch;cameraAbort=new AbortController();
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Откройте приложение через адрес localhost из run_app.py.');
  let candidate;
  try {
    candidate=await withTimeout(navigator.mediaDevices.getUserMedia({video:{width:{ideal:960},height:{ideal:720},frameRate:{ideal:20,max:30},facingMode:'user'},audio:false}),20000,stopTracks,cameraAbort.signal);
    if(epoch!==cameraEpoch || document.hidden) {stopTracks(candidate);throw new Error('Подключение камеры отменено.');}
    stream=candidate;video.srcObject=stream;
    await withTimeout(video.play(),10000);
    const readyBy=performance.now()+10000;
    while(video.readyState<2 || !video.videoWidth) {
      if(epoch!==cameraEpoch || document.hidden) throw new Error('Подключение камеры отменено.');
      if(performance.now()>readyBy) throw new Error('Камера не передаёт изображение. Повторите подключение.');
      await sleep(50);
    }
    if(epoch!==cameraEpoch) throw new Error('Подключение камеры отменено.');
  } catch(e) {stopTracks(candidate);if(epoch===cameraEpoch)stopCamera();throw mediaError(e);}
  lastFrame=-1;lastResult=null;lastSeenFrame=performance.now();detectError=false;
  $('cameraHint').textContent='Камера включена. Посмотрите прямо в объектив.';
  $('cameraBtn').textContent='Выключить камеру';controls();
}
function stopCamera() {
  cameraEpoch++;cameraAbort?.abort();stopTracks(stream);stream=null;video.srcObject=null;lastResult=null;
  $('cameraBtn').textContent='Включить камеру';
}
function landmarks(now) {
  if (!detector || !stream || video.readyState < 2) return null;
  if (video.currentTime !== lastFrame && now - lastDetect > 75) {
    lastFrame = video.currentTime; lastDetect = now;
    lastResult = detectVideo(now); lastSeenFrame = now;
  }
  return lastResult;
}
function detectVideo(now) {
  // A queued animation frame can carry an older timestamp than a direct start/scan check.
  // MediaPipe requires strictly increasing timestamps across every call.
  const timestamp = Math.max(now, lastMediaTimestamp + .01);
  lastMediaTimestamp = timestamp;
  return detector.detectForVideo(video, timestamp);
}

async function scan() {
  const epoch=++scanEpoch;
  scanning = true; $('portraitEditor').hidden=true; $('scanProgress').value = 0; controls(); clearError();
  const scanPanel=document.querySelector('.setup');
  scanPanel.classList.add('scanning-screen');scanPanel.setAttribute('role','dialog');scanPanel.setAttribute('aria-modal','true');scanPanel.setAttribute('aria-label','Сканирование лица и шеи');
  $('cancelScanBtn').focus({preventScroll:true});
  try {
    await context().resume();
    await dependencies(); await enableCamera();
    const takePose = async (phase, instruction, validate) => {
      const phaseStarted=performance.now();
      scanInstruction(instruction,true);
      $('scanPhase').textContent=['1 из 2 · лицо прямо','2 из 2 · портрет по грудь'][phase];
      scanPanel.classList.toggle('portrait-scan',phase===1);
      let stableStart = 0, previous, frameTime = -1;
      const deadline = performance.now() + 45000;
      while (scanning && epoch===scanEpoch && performance.now() < deadline) {
        await sleep(90);
        const now = performance.now();
        if (video.readyState < 2 || frameTime === video.currentTime) continue;
        frameTime = video.currentTime;
        const result = detectVideo(now), lm = result.faceLandmarks?.[0];
        const issue = result.faceLandmarks?.length !== 1 ? 'В кадре должен быть один человек' : validate(lm);
        const movement = previous && lm ? Math.hypot(lm[1].x - previous.x, lm[1].y - previous.y) : 0;
        previous = lm?.[1];
        if (issue || movement > .018) {
          stableStart = 0; $('scanProgress').value = phase / 2;
          scanInstruction(issue || 'Не двигайтесь, сейчас сделаем снимок'); $('scanCountdown').textContent=''; continue;
        }
        if (!stableStart) stableStart = now;
        $('cameraHint').textContent = 'Отлично. Не двигайтесь';
        $('scanCountdown').textContent=String(Math.max(1,2-Math.floor((now-stableStart)/1000)));
        $('scanProgress').value = Math.min((phase + 1) / 2, (phase + (now - stableStart) / 1800) / 2);
        if (now - stableStart >= 1800) {
          if(now-phaseStarted<3500 || ($('scanAudio').checked && window.speechSynthesis?.speaking && now-phaseStarted<12000)) continue;
          // Freeze pixels and run the detector on that exact image. VIDEO inference
          // can otherwise describe a different frame while the head is turning.
          const canvas = document.createElement('canvas');
          canvas.width = Math.min(1080, video.videoWidth);
          canvas.height = Math.round(video.videoHeight * canvas.width / video.videoWidth);
          canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
          lastMediaTimestamp=Math.max(performance.now(),lastMediaTimestamp+.01);
          const imageResult=detector.detectForVideo(canvas,lastMediaTimestamp);
          const frozen=imageResult.faceLandmarks?.[0];
          if(imageResult.faceLandmarks?.length!==1 || validate(frozen)) {stableStart=0;continue;}
          scanTone();
          return {landmarks: frozen, canvas, photo: canvas.toDataURL('image/jpeg', .92), yaw: faceYaw(frozen),role:phase===0?'front':'portrait'};
        }
      }
      if (!scanning) return null;
      throw new Error('Не удалось сделать снимок. Посмотрите прямо, держите голову ровно и оставьте волосы, уши и плечи в кадре.');
    };
    const front = await takePose(0, 'Посмотрите прямо в объектив. Держите голову ровно', lm => scanQuality(lm, video.videoWidth, video.videoHeight));
    if (!front) return;
    const portrait=await takePose(1,'Лицо снято. Теперь отодвиньте камеру для портрета по грудь. Макушка, оба уха и плечи целиком в кадре. Смотрите прямо.',lm=>portraitQuality(lm,video.videoWidth,video.videoHeight));
    if(!portrait)return;
    portraitView=portrait;portraitAnchors=defaultPortraitAnchors(portrait.landmarks);portraitConfirmed=false;portraitDraft=true;
    avatarViews=[front];
    previewYaw=0;
    buildMesh(front.landmarks,front.canvas,(await dependencies()).FaceLandmarker.FACE_LANDMARKS_TESSELATION,avatarViews);
    stopCamera();openPortraitEditor();
    $('faceStatus').textContent='Проверьте пропорции на снимке';
    scanInstruction('Снимки готовы. Совместите точки контура с собой на фотографии и сохраните аватар.',true);
    $('scanPhase').textContent='Готово · 2 снимка';
  } finally { scanning = false; lastFrame = -1; $('scanCountdown').textContent='';scanPanel.classList.remove('scanning-screen','portrait-scan');scanPanel.removeAttribute('role');scanPanel.removeAttribute('aria-modal');scanPanel.removeAttribute('aria-label');if(portraitDraft&&portraitView&&$('portraitEditor').hidden)openPortraitEditor();controls();$('scanBtn').focus({preventScroll:true}); }
}
function scanInstruction(text,force=false) {
  $('cameraHint').textContent=text;
  if(!$('scanAudio').checked || !window.speechSynthesis) return;
  const now=performance.now();
  if(!force && (text===scanSpeechText || now-scanSpeechAt<5000)) return;
  speechSynthesis.cancel();
  const utterance=new SpeechSynthesisUtterance(text);utterance.lang='ru-RU';utterance.rate=.92;
  const voice=speechSynthesis.getVoices().find(v=>v.lang.startsWith('ru') && v.localService);
  if(voice) utterance.voice=voice;
  speechSynthesis.speak(utterance);scanSpeechText=text;scanSpeechAt=now;
}
function scanTone() {
  if(!$('scanAudio').checked) return;
  const ctx=context(),osc=ctx.createOscillator(),gain=ctx.createGain();
  osc.frequency.value=740;gain.gain.setValueAtTime(.08,ctx.currentTime);gain.gain.exponentialRampToValueAtTime(.001,ctx.currentTime+.18);
  osc.connect(gain);gain.connect(ctx.destination);osc.start();osc.stop(ctx.currentTime+.2);
  osc.onended=()=>{osc.disconnect();gain.disconnect();};
}
function sampledColor(views, pointForView, fallback) {
  const samples = [];
  for (const view of views) {
    const point = pointForView(view);
    if (!view.canvas || !point) continue;
    const ctx = view.canvas.getContext('2d', {willReadFrequently:true});
    const x = Math.round(point.x * view.canvas.width), y = Math.round(point.y * view.canvas.height);
    const radius = Math.max(2, Math.round(view.canvas.width * .008));
    const data = ctx.getImageData(Math.max(0,x-radius), Math.max(0,y-radius), radius*2, radius*2).data;
    let r=0,g=0,b=0,n=0;
    for (let i=0;i<data.length;i+=4) { if (data[i+3]) { r+=data[i]; g+=data[i+1]; b+=data[i+2]; n++; } }
    if (n) samples.push([r/n,g/n,b/n]);
  }
  if (!samples.length) return new THREE.Color(fallback);
  const mean = axis => samples.reduce((sum,c)=>sum+c[axis],0)/samples.length/255;
  return new THREE.Color().setRGB(mean(0),mean(1),mean(2),THREE.SRGBColorSpace);
}
function hairColor(view){
  const chosen=localStorage.getItem('parentai-hair-color');
  if(chosen)return new THREE.Color(chosen);
  const lm=view.landmarks,w=view.canvas.width,h=view.canvas.height;
  const fw=Math.abs(lm[454].x-lm[234].x),fh=Math.abs(lm[152].y-lm[10].y);
  const x=Math.max(0,Math.floor((lm[10].x-fw*.2)*w)),y=Math.max(0,Math.floor((lm[10].y-fh*.16)*h));
  const sw=Math.min(w-x,Math.max(1,Math.floor(fw*.4*w))),sh=Math.min(h-y,Math.max(1,Math.floor(fh*.22*h)));
  const data=view.canvas.getContext('2d',{willReadFrequently:true}).getImageData(x,y,sw,sh).data,pixels=[];
  for(let i=0;i<data.length;i+=4)pixels.push([data[i],data[i+1],data[i+2]]);
  pixels.sort((a,b)=>a.reduce((s,c)=>s+c,0)-b.reduce((s,c)=>s+c,0));
  const rgb=pixels[Math.floor(pixels.length*.2)]||[55,38,28];
  const color=new THREE.Color().setRGB(...rgb.map(c=>c/255),THREE.SRGBColorSpace);
  $('hairColor').value='#'+color.getHexString();return color;
}
function rebuildPortrait() {
  clearTimeout(portraitRebuildTimer);
  if(!portraitView || !avatarViews.length || running)return;
  const front=avatarViews.find(v=>v.role==='front') || avatarViews[0];
  buildMesh(front.landmarks,front.canvas,avatarTopology,avatarViews);
}
function renderPortraitEditor() {
  if(!portraitView || !portraitAnchors)return;
  const canvas=$('portraitCanvas');canvas.width=portraitView.canvas.width;canvas.height=portraitView.canvas.height;
  const ctx=canvas.getContext('2d');ctx.drawImage(portraitView.canvas,0,0);ctx.lineWidth=2;ctx.strokeStyle='#c4f9de';
  const line=points=>{ctx.beginPath();points.forEach((p,i)=>ctx[i?'lineTo':'moveTo'](p.x*canvas.width,p.y*canvas.height));ctx.stroke();};
  const a=portraitAnchors,lm=portraitView.landmarks;
  line(Array.from({length:33},(_,i)=>portraitHairContour(a,i/32)));
  line([{x:a.neckLeft.x,y:lm[152].y},a.neckLeft,a.shoulderLeft,a.chestLeft,a.chestRight,a.shoulderRight,a.neckRight,{x:a.neckRight.x,y:lm[152].y}]);
  [...$('portraitHandles').children].forEach(button=>{
    const p=a[button.dataset.anchor];button.style.left=`${p.x*100}%`;button.style.top=`${p.y*100}%`;
    button.hidden=!portraitGroups[$('portraitGroup').value].includes(button.dataset.anchor);
    button.setAttribute('aria-pressed',String(button.dataset.anchor===selectedAnchor));
  });
  $('portraitPoint').value=selectedAnchor;
  $('portraitHint').textContent=portraitAnchorIssue(a,lm) || `${PORTRAIT_HANDLES[selectedAnchor]}. Перетащите точку или используйте стрелки. Начальный контур нужно проверить по фото.`;
  controls();
}
function openPortraitEditor() {
  if(!portraitView)return;
  portraitDraft=true;stopCamera();$('portraitEditor').hidden=false;
  $('portraitHandles').replaceChildren(...Object.entries(PORTRAIT_HANDLES).map(([key,label],i)=>{
    const button=document.createElement('button');button.type='button';button.className='portrait-handle';button.dataset.anchor=key;
    button.textContent=String(i+1);button.setAttribute('aria-label',label);button.title=label;return button;
  }));
  selectPortraitGroup();
  renderPortraitEditor();$('portraitEditor').scrollIntoView({block:'start',behavior:'smooth'});
}
function selectPortraitGroup() {
  const keys=portraitGroups[$('portraitGroup').value];
  if(!keys.includes(selectedAnchor))selectedAnchor=keys[0];
  $('portraitPoint').replaceChildren(...keys.map(key=>new Option(PORTRAIT_HANDLES[key],key)));
}
function movePortraitPoint(dx,dy) {
  if(!portraitDraft || !portraitAnchors)return;
  const p=portraitAnchors[selectedAnchor];p.x=Math.max(.015,Math.min(.985,p.x+dx));p.y=Math.max(.015,Math.min(.985,p.y+dy));
  renderPortraitEditor();clearTimeout(portraitRebuildTimer);portraitRebuildTimer=setTimeout(rebuildPortrait,120);
}
async function savePortrait() {
  const issue=portraitAnchorIssue(portraitAnchors,portraitView?.landmarks);
  if(issue)throw new Error(issue);
  const serialize=({landmarks,photo,yaw,role})=>({landmarks,photo,yaw,role});
  const front=avatarViews.find(v=>v.role==='front') || avatarViews[0];
  await api('avatar',JSON.stringify({version:5,views:[{...serialize(front),role:'front'}],portrait:{...serialize(portraitView),role:'portrait'},anchors:portraitAnchors}));
  portraitDraft=false;portraitConfirmed=true;$('portraitEditor').hidden=true;rebuildPortrait();
  $('faceStatus').textContent='Фронтальный аватар сохранён';$('cameraHint').textContent='Модель готова. Можно перейти к голосу.';
}
function disposeAvatar() {
  if (!avatarGroup) return;
  avatarGroup.traverse(item => {
    item.geometry?.dispose();
    const materials = Array.isArray(item.material) ? item.material : [item.material];
    materials.filter(Boolean).forEach(material => { material.map?.dispose(); material.dispose(); });
  });
  scene.remove(avatarGroup); avatarGroup = null;
}
function buildMesh(lm, canvas, topology, views = [{landmarks:lm, canvas, yaw:0}]) {
  avatarViews=views; avatarTopology=topology;
  const detail=views.find(v=>v.role==='front') || views.find(v=>v.canvas===canvas) || views[0];
  if(portraitView){lm=portraitView.landmarks;canvas=portraitView.canvas;portraitAnchors ||= defaultPortraitAnchors(lm);}
  const indices = [];
  for (let i = 0; i < topology.length; i += 3) {
    const tri = [topology[i].start, topology[i].end, topology[i + 1].end];
    if (tri.every(n => n < 468)) indices.push(...tri);
  }
  const filled = closeFaceOpenings(lm, indices, false);
  const geometry = new THREE.BufferGeometry();
  base = new Float32Array((portraitView?positionsFor:neutralFacePositions)(filled.points, canvas.width, canvas.height));
  geometry.setAttribute('position', new THREE.BufferAttribute(base.slice(), 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(filled.points.flatMap(p => [p.x, 1 - p.y])), 2));
  geometry.setIndex(filled.indices); geometry.computeVertexNormals(); geometry.computeBoundingSphere();
  const front=views.find(v=>v.role==='front') || views.find(v=>v.canvas===canvas) || views[0];
  const texture = new THREE.CanvasTexture(portraitView?bakePortraitFaceAtlas(portraitView,detail,filled.indices):bakeFaceAtlas(front,views,filled.indices)); texture.colorSpace = THREE.SRGBColorSpace;
  // The photo already contains lighting. Additional directional light made skin waxy/overexposed.
  const next = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({map: texture,roughness:1,metalness:0,side: THREE.DoubleSide}));
  const rig = mouthRig(filled.points); jawWeights = rig.weights; mouthWidth = Math.abs(base[308*3]-base[78*3]);
  cavityIds = FACE_OPENINGS[2];
  const cavityData=mouthInteriorGeometry(base,cavityIds,mouthWidth);
  const cavityGeometry = new THREE.BufferGeometry();
  cavityGeometry.setAttribute('position', new THREE.BufferAttribute(cavityData.positions, 3));
  cavityGeometry.setIndex(cavityData.indices);
  const nextCavity = new THREE.Mesh(cavityGeometry, new THREE.MeshBasicMaterial({color:0x241218,side:THREE.DoubleSide}));

  const head=skullGeometry(base), {cx,cy,width,height,edgeZ,depth}=head;
  const skin = sampledColor(views, view => view.landmarks[view.yaw < 0 ? 454 : 234], 0xc58f78);
  const hair=hairColor(front);
  const portrait=portraitView || front;
  const bodyTexture=new THREE.CanvasTexture(portrait.canvas);bodyTexture.colorSpace=THREE.SRGBColorSpace;
  const skinMaterial = new THREE.MeshStandardMaterial({map:bodyTexture,roughness:1,side:THREE.DoubleSide});
  const hairMaterial = new THREE.MeshStandardMaterial({color:hair,roughness:1,metalness:0,side:THREE.DoubleSide});
  const group = new THREE.Group();
  const pivot=new THREE.Group(),fixedBody=new THREE.Group();
  const makeGeometry = data => {
    const result = new THREE.BufferGeometry();
    result.setAttribute('position',new THREE.Float32BufferAttribute(data.positions,3));
    if(data.uv)result.setAttribute('uv',new THREE.Float32BufferAttribute(data.uv,2));
    result.setIndex(data.indices); result.computeVertexNormals(); return result;
  };
  const shellGeometry=makeGeometry(head), colors=[];
  const context2d=canvas.getContext('2d',{willReadFrequently:true});
  for(let i=0;i<head.positions.length/3;i++) {
    const id=OVAL[i%OVAL.length],p=lm[id];
    const rgb=context2d.getImageData(Math.min(canvas.width-1,Math.max(0,Math.round(p.x*canvas.width))),Math.min(canvas.height-1,Math.max(0,Math.round(p.y*canvas.height))),1,1).data;
    const border=new THREE.Color().setRGB(rgb[0]/255,rgb[1]/255,rgb[2]/255,THREE.SRGBColorSpace);
    const blend=border.lerp(skin,1-head.rim[i]); colors.push(blend.r,blend.g,blend.b);
  }
  shellGeometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));
  pivot.add(new THREE.Mesh(shellGeometry,new THREE.MeshStandardMaterial({vertexColors:true,roughness:1,side:THREE.DoubleSide})));
  $('legacyAppearance').hidden=Boolean(portraitView);
  if(portraitView) {
    skinMaterial.dispose();hairMaterial.dispose();
    const frame={nose:lm[1],aspect:canvas.height/canvas.width,scale:4.2};
    const photoMaterial=new THREE.MeshStandardMaterial({map:bodyTexture,roughness:1,side:THREE.DoubleSide});
    fixedBody.add(new THREE.Mesh(makeGeometry(portraitBodyGeometry(lm,portraitAnchors,frame,base)),photoMaterial));
    pivot.add(new THREE.Mesh(makeGeometry(portraitHairGeometry(lm,portraitAnchors,frame,base)),photoMaterial));
    for(const side of [-1,1])pivot.add(new THREE.Mesh(makeGeometry(portraitEarGeometry(lm,portraitAnchors,frame,base,side)),photoMaterial));
  } else {
    const hairData=hairGeometry(head,$('hairStyle').value);
    if(hairData.positions.length) pivot.add(new THREE.Mesh(makeGeometry(hairData),hairMaterial));
    else hairMaterial.dispose();
    const neckData=neckGeometry(head),neck=makeGeometry(neckData),neckUV=[];
    const bodyLandmarks=portrait.landmarks;
    const imageFaceHeight=Math.abs(bodyLandmarks[152].y-bodyLandmarks[10].y);
    const imageFaceWidth=Math.abs(bodyLandmarks[454].x-bodyLandmarks[234].x);
    for(let i=0;i<neckData.positions.length;i+=3) {
      const x=neckData.positions[i],y=neckData.positions[i+1];
      // Keep the wider mesh sampling skin, rather than the background beside the neck.
      const u=bodyLandmarks[152].x+(x-cx)/width*imageFaceWidth*.72;
      const v=bodyLandmarks[152].y+(cy-height*.5-y)/height*imageFaceHeight;
      neckUV.push(Math.max(.01,Math.min(.99,u)),1-Math.max(.01,Math.min(.99,v)));
    }
    neck.setAttribute('uv',new THREE.Float32BufferAttribute(neckUV,2));
    fixedBody.add(new THREE.Mesh(neck,skinMaterial));
    const torsoData=torsoGeometry(head),torso=makeGeometry(torsoData),torsoUV=[];
    for(let i=0;i<torsoData.positions.length;i+=3){
      const u=bodyLandmarks[152].x+(torsoData.positions[i]-cx)/width*imageFaceWidth;
      const v=bodyLandmarks[152].y+(cy-height*.5-torsoData.positions[i+1])/height*imageFaceHeight;
      torsoUV.push(Math.max(.01,Math.min(.99,u)),1-Math.max(.01,Math.min(.99,v)));
    }
    torso.setAttribute('uv',new THREE.Float32BufferAttribute(torsoUV,2));
    const shirtMaterial=new THREE.MeshStandardMaterial(portraitView?{map:bodyTexture,roughness:1,side:THREE.DoubleSide}:{color:0x263d54,roughness:1,side:THREE.DoubleSide});
    fixedBody.add(new THREE.Mesh(torso,shirtMaterial));
    for (const side of [-1,1]) {
      const data=earGeometry(head,side), ear=makeGeometry(data);
      ear.setAttribute('color',new THREE.Float32BufferAttribute(data.shade.flatMap(shade=>[skin.r*shade,skin.g*shade,skin.b*shade]),3));
      pivot.add(new THREE.Mesh(ear,new THREE.MeshStandardMaterial({vertexColors:true,roughness:1,side:THREE.DoubleSide})));
    }
  }
  const nextTeeth=new THREE.Mesh(makeGeometry(upperTeethGeometry(mouthWidth)),new THREE.MeshStandardMaterial({color:0xa99f91,roughness:.8,side:THREE.DoubleSide}));
  nextTeeth.position.fromArray(base,13*3);nextTeeth.visible=false;
  const tongueGeometry=new THREE.SphereGeometry(mouthWidth*.16,12,8);tongueGeometry.scale(1,.20,.12);
  tongueGeometry.translate(0,mouthWidth*.013,-mouthWidth*.055);
  const nextTongue=new THREE.Mesh(tongueGeometry,new THREE.MeshBasicMaterial({color:0x71343f}));
  nextTongue.position.fromArray(base,14*3);nextTongue.visible=false;
  pivot.add(nextCavity,next,nextTeeth,nextTongue);
  group.add(pivot,fixedBody);
  group.position.set(cx,cy,edgeZ-depth*.32);
  for (const container of group.children) for(const child of container.children) child.position.sub(group.position);
  disposeAvatar(); avatarGroup=group;headPivot=pivot;teethMesh=nextTeeth;tongueMesh=nextTongue; mesh=next; cavityMesh=nextCavity; scene.add(group);applyModelView();
  $('placeholder').hidden = true; $('placeholder').style.display = 'none'; fit();
}
function context() { return audioContext ||= new AudioContext(); }
function stopAudio() {
  playbackId++;activeCues=[];
  for(const source of audioSources) {try{source.stop();}catch{} source.disconnect();}
  audioSources.clear();audioSource=null;analyser?.disconnect();analyser=null;
  playing=false;audioKind='';audioNext=0;echoUntil=performance.now()+1000;controls();
}
async function playVoice(kind='manual') {
  if(!status.phrases?.length) throw new Error('Сначала создайте голос.');
  stopAudio();const playId=playbackId,ctx=context();await ctx.resume();if(playId!==playbackId)return;
  const item=status.phrases[Math.floor(Math.random()*status.phrases.length)];
  const res=await fetch('/audio/'+item.file);
  if(!res.ok) throw new Error('Аудиофайл недоступен');
  const buffer=await ctx.decodeAudioData(await res.arrayBuffer());
  if(playId!==playbackId)return;
  beginAudio(buffer,item.text,kind);
}
function beginAudio(buffer,text,kind,cues=[]) {
  const ctx=context(),id=playbackId;
  if(!analyser) {
    analyser=ctx.createAnalyser();analyser.fftSize=512;pcm=new Float32Array(512);analyser.connect(ctx.destination);
    audioStarted=ctx.currentTime+.03;activeCues=[];audioNext=audioStarted;
  }
  const start=Math.max(audioNext,ctx.currentTime+.03),offset=start-audioStarted;
  activeCues.push(...cues.map(c=>({...c,time:c.time+offset})));
  const source=ctx.createBufferSource();source.buffer=buffer;audioSource=source;
  source.connect(analyser);audioSources.add(source);audioNext=start+buffer.duration;
  const ended=new Promise(resolve=>{source.onended=()=>{
    audioSources.delete(source);source.disconnect();resolve();
    if(id!==playbackId)return;
    if(!audioSources.size){playing=false;audioKind='';echoUntil=performance.now()+1000;controls();}
  };});
  playing=true;audioKind=kind;source.start(start);
  $('phraseText').textContent=text;$('lessonSpeech').textContent=text;controls();return ended;
}

async function record() {
  recording = true; recordCancelled = false; recordingAbort = new AbortController(); controls(); clearError(); stopAudio(); $('reference').pause();
  let mic, node, source, recordContext;
  try {
    recordContext = new AudioContext(); await recordContext.resume();
    const device = $('microphone').value;
    mic = await withTimeout(navigator.mediaDevices.getUserMedia({audio: {deviceId: device ? {exact: device} : undefined, channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false}}), 20000, stopTracks, recordingAbort.signal);
    recordingStream = mic;
    if (recordCancelled) return;
    const selected = device;
    const devices = await navigator.mediaDevices.enumerateDevices();
    $('microphone').replaceChildren(new Option('По умолчанию', ''), ...devices.filter(d => d.kind === 'audioinput').map(d => new Option(d.label || 'Микрофон', d.deviceId)));
    $('microphone').value = selected;
    await recordContext.audioWorklet.addModule('/recorder.js');
    source = recordContext.createMediaStreamSource(mic); node = new AudioWorkletNode(recordContext, 'recorder');
    const chunks = []; let count = 0, peak = 0;
    node.port.onmessage = ({data}) => { chunks.push(data); count += data.length; let sum = 0; peak = 0; for (const x of data) { sum += x*x; peak = Math.max(peak, Math.abs(x)); } $('level').value = Math.min(1, Math.sqrt(sum/data.length)*5); };
    source.connect(node); node.connect(recordContext.destination);
    const duration = $('voiceMode').value === 'direct' ? 8 : 20;
    const mode = $('voiceMode').value;
    const started = performance.now();
    while (count < recordContext.sampleRate * duration) {
      if (recordCancelled) return;
      if (performance.now() - started > (duration + 8) * 1000 || mic.getAudioTracks()[0].readyState !== 'live') throw new Error('Запись прервалась. Проверьте микрофон и повторите.');
      $('voiceHint').textContent = `${Math.max(0, duration - Math.floor(count / recordContext.sampleRate))} сек. ${peak > .98 ? 'Перегрузка — отодвиньте микрофон!' : 'Говорите спокойно, с паузами.'}`;
      await sleep(100);
    }
    source.disconnect(); node.disconnect(); mic.getTracks().forEach(t => t.stop());
    const samples = new Float32Array(count); let offset = 0;
    for (const c of chunks) { samples.set(c, offset); offset += c.length; }
    $('voiceHint').textContent = 'Проверяю качество записи…';
    if (recordCancelled) return;
    const wav = encodeWav(samples, recordContext.sampleRate);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(new Blob([wav], {type: 'audio/wav'}));
    $('reference').src = previewUrl; $('reference').hidden = false;
    referenceLoaded = true;
    referenceRejected = true;
    const result = await api('reference?mode=' + mode, wav);
    referenceRejected = false;
    $('reference').src = '/audio/reference.wav?t=' + Date.now(); $('reference').hidden = false;
    $('voiceHint').textContent = `Запись: ${result.seconds} сек. Прослушайте её, затем нажмите «Создать голос».`;
    status = await api('status');
  } catch(e) { if (!recordCancelled) throw mediaError(e); } finally { source?.disconnect(); node?.disconnect(); mic?.getTracks().forEach(t => t.stop()); await recordContext?.close(); $('level').value = 0; recordingStream = null; recording = false; controls(); }
}
async function start() {
  await context().resume();
  await dependencies();
  await enableCamera();
  let result;
  for (let attempt = 0; attempt < 10; attempt++) {
    result = detectVideo(performance.now());
    if (result.faceLandmarks?.length === 1) break;
    await sleep(120);
  }
  if (result.faceLandmarks?.length !== 1) throw new Error('Перед началом в кадре должен быть один ребёнок.');
  if(document.hidden || !stream) throw new Error('Подключение занятия отменено.');
  stopAudio(); running = true; paused = false; presence.reset(); lessonElapsed = 0; lessonStarted = performance.now(); showLesson(); controls();
  if($('replyVoice').value==='parent') api('voice-warm',new Uint8Array()).catch(()=>{});
  startHandsFree().catch(fail);
  try { await playVoice('lesson'); } catch(e) { fail(e); }
}
async function pause() {
  stopAudio(); cancelTutor();stopHandsFree();
  if (!paused) { lessonElapsed += performance.now() - lessonStarted; paused = true; stopCamera(); $('pauseBtn').textContent = 'Продолжить'; $('monitorStatus').textContent = 'Перерыв · камера выключена'; }
  else { await enableCamera(); presence.reset(); paused = false; lessonStarted = performance.now(); $('pauseBtn').textContent = 'Перерыв';startHandsFree().catch(fail); }
  controls();
}
function stop() { stopHandsFree();api('voice-release',new Uint8Array()).catch(()=>{});running = false; paused = false; stopAudio(); stopCamera(); cancelTutor(); presence.reset(); $('pauseBtn').textContent = 'Перерыв'; $('monitorStatus').textContent = 'Занятие завершено · камера выключена'; showSetup(); controls(); }
let reminderPending = false;
async function reminder() {
  if (reminderPending) return;
  reminderPending = true;
  try { await playVoice('reminder'); if (!running || paused || presence.state !== 'absent') stopAudio(); }
  catch (e) { fail(e); }
  finally { reminderPending = false; }
}
function tick(now) {
  requestAnimationFrame(tick);
  if (running && !paused && !scanning) {
    try {
      const result = landmarks(now);
      if (!stream?.getVideoTracks().some(t => t.readyState === 'live') || now - lastSeenFrame > 3000) throw new Error('Камера перестала передавать изображение. Нажмите «Продолжить», чтобы подключить её снова.');
      const found = result?.faceLandmarks?.length > 0;
      const current = presence.update(found, now / 1000);
      $('monitorStatus').textContent = {present:'Лицо в кадре · занятие идёт',missing:'Лицо вне кадра · ждём возвращения',absent:'Пора вернуться к занятию',returning:'С возвращением'}[current.state];
      if (found && audioKind === 'reminder') stopAudio();
      if (current.remind && !tutorBusy && !questionRecording && !playing) reminder();
    } catch (e) { if (!detectError) { detectError = true; pause(); fail(e); } }
  }
  if (mesh && !document.hidden && now - renderTime >= 33) {
    renderTime = now;
    let target = 0;
    if (playing && analyser) { analyser.getFloatTimeDomainData(pcm); target = speechOpening(pcm) * mouthWidth * .13; }
    const elapsed=audioContext ? audioContext.currentTime-audioStarted : 0;
    const cue=playing ? activeCues.findLast(c=>c.time<=elapsed) : null;
    if(cue?.shape==='closed' || cue?.shape==='silence') target*=.12;
    if(cue?.shape==='teeth')target=Math.min(target,mouthWidth*.035);
    const shape=cue?.shape==='round' ? -.20 : cue?.shape==='wide' ? .10 : 0;
    lipShape+=(shape-lipShape)*.25;
    lipPucker+=((cue?.shape==='round' ? mouthWidth*.035 : 0)-lipPucker)*.25;
    jaw += (target - jaw)*.25;
    const pos = mesh.geometry.getAttribute('position');
    const mouthX=(base[61*3]+base[291*3])/2, mouthY=(base[13*3+1]+base[14*3+1])/2;
    const blink=blinkAmount(now/1000);
    const eyes=FACE_OPENINGS.slice(0,2).map(ring=>{
      const ey=ring.reduce((sum,id)=>sum+base[id*3+1],0)/ring.length;
      const ex=ring.reduce((sum,id)=>sum+base[id*3],0)/ring.length;
      return {ey,ex,half:Math.max(...ring.map(id=>Math.abs(base[id*3]-ex)))};
    });
    for (let i=0;i<jawWeights.length;i++) {
      const x=base[i*3],y=base[i*3+1],z=base[i*3+2];
      const nearLip=Math.exp(-(((x-mouthX)/(mouthWidth*.55))**2)-((y-mouthY)/(mouthWidth*.25))**2);
      pos.array[i*3]=x+(x-mouthX)*lipShape*nearLip;
      pos.array[i*3+1]=y-jawWeights[i]*jaw;
      pos.array[i*3+2]=z+lipPucker*nearLip;
      for(const {ex,ey,half} of eyes) {
        if(Math.abs(x-ex)<half*1.02 && Math.abs(y-ey)<half*.45) pos.array[i*3+1]-=(y-ey)*blink;
      }
    }
    pos.needsUpdate = true;
    if (cavityMesh) {
      const mouth = cavityMesh.geometry.getAttribute('position');
      mouthInteriorPositions(pos.array,cavityIds,mouthWidth,mouth.array);
      mouth.needsUpdate = true;
    }
    mesh.geometry.computeVertexNormals();
    const aperture=Math.max(0,pos.array[13*3+1]-pos.array[14*3+1]);
    if(teethMesh) {
      teethMesh.visible=jaw>mouthWidth*.05 && aperture>mouthWidth*.045;
      teethMesh.position.fromArray(pos.array,13*3).sub(avatarGroup.position);
      teethMesh.scale.x=1+lipShape;
    }
    if(tongueMesh) {
      tongueMesh.visible=jaw>mouthWidth*.08 && aperture>mouthWidth*.08;
      tongueMesh.position.fromArray(pos.array,14*3).sub(avatarGroup.position);
      tongueMesh.scale.x=1+lipShape;
    }
    if (avatarGroup) {
      const motion = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : ((running && !paused)||audioKind==='preview' ? 1 : 0);
      avatarGroup.rotation.y=running?0:previewYaw;
      headPivot.rotation.y=Math.sin(now / 3300)*.045*motion;
      headPivot.rotation.x=(Math.sin(now/2100)*.015+(playing?Math.sin(now/420)*.008:0))*motion;
      headPivot.rotation.z=Math.sin(now/4700)*.012*motion;
    }
    renderer.render(scene,camera);
  }
  if (running) {
    const elapsed = lessonElapsed + (paused ? 0 : now - lessonStarted), seconds = Math.floor(elapsed/1000);
    $('lessonClock').textContent = `${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;
  }
}
function showLesson() {
  $('lessonAvatarSlot').appendChild($('scene'));
  $('lessonCameraSlot').appendChild(video.closest('.camera-frame'));
  $('setupPage').hidden = true; $('lessonPage').hidden = false;
  document.body.classList.add('in-lesson');
  document.querySelector('h1').textContent = 'Занятие';
  $('lessonSpeech').textContent = 'Я рядом. Если нужна помощь, скажи «помоги» или задай вопрос.';
  history.pushState({lesson:true}, '', '#lesson');
  requestAnimationFrame(fit); window.scrollTo(0,0);
}
function showSetup() {
  $('setupAvatarSlot').appendChild($('scene'));
  $('setupCameraSlot').appendChild(video.closest('.camera-frame'));
  $('lessonPage').hidden = true; $('setupPage').hidden = false;
  document.body.classList.remove('in-lesson');
  document.querySelector('h1').textContent = 'Рядом во время занятий';
  if (location.hash) history.replaceState({}, '', location.pathname + location.search);
  requestAnimationFrame(fit); window.scrollTo(0,0);
}
function setupStep(step) {
  if(scanning || recording) return;
  const content={face:['Создадим вашу 3D-модель','Поставьте камеру на уровне глаз. Каждый шаг звучит голосом.'],voice:['Теперь запишем ваш голос','Запишите образец в тихой комнате, затем прослушайте результат.'],ready:['Всё готово к занятию','Посадите ребёнка перед камерой и начните. Вопросы можно задавать голосом или текстом.']};
  if(!content[step]) return;
  if(step!=='face') stopCamera();
  document.querySelectorAll('[data-step-panel]').forEach(panel=>panel.hidden=panel.dataset.stepPanel!==step);
  document.querySelectorAll('[data-setup-step]').forEach(button=>{
    if(button.dataset.setupStep===step) button.setAttribute('aria-current','step');
    else button.removeAttribute('aria-current');
  });
  [$('stepTitle').textContent,$('stepDescription').textContent]=content[step];
  requestAnimationFrame(fit);window.scrollTo({top:0,behavior:'auto'});
}
function applyModelView() {
  avatarGroup?.traverse(item=>{
    if(item.material && item!==cavityMesh) item.material.wireframe=showWireframe;
  });
  $('viewMeshBtn').setAttribute('aria-pressed',String(showWireframe));
  $('viewMeshBtn').textContent=showWireframe?'Скрыть сетку':'Показать сетку';
}
function chatMessage(role, text) {
  const box = document.createElement('p'); box.className = `chat-message ${role}`;
  const label = document.createElement('strong'); label.textContent = role === 'user' ? 'Ребёнок' : 'Помощник';
  const content = document.createElement('span'); content.textContent = text;
  box.append(label, content); $('tutorMessages').appendChild(box); box.scrollIntoView({block:'nearest'});
}
function cancelTutor() {
  helpEpoch++; questionCancel=true; questionAbort?.abort(); stopTracks(questionStream);
  listener?.sttAbort?.abort();tutorBusy=false;followupUntil=0;stopAudio();
  if(currentJob) api('dialog-cancel',JSON.stringify({id:currentJob})).catch(()=>{});
  currentJob=null; controls();
}
async function askTutor(event) {
  event.preventDefault();
  const question = $('assignment').value.trim();
  if (!question || tutorBusy || questionRecording || listenerPending) return;
  $('assignment').value = '';
  await answerQuestion(question);
}
async function answerQuestion(question) {
  const epoch=++helpEpoch;
  chatMessage('user',question);stopAudio();tutorBusy=true;controls();clearError();
  let displayed=false,received=0;const completions=[];
  const getAudio=async(key,chunk,cues,text)=>{
    const url='/api/dialog-audio/'+key+(chunk===null?'':'?chunk='+chunk);
    const res=await fetch(url,{headers:{'X-App-Token':token}});
    if(!res.ok)throw new Error('Аудио ответа недоступно.');
    const buffer=await context().decodeAudioData(await res.arrayBuffer());
    if(epoch!==helpEpoch)return;
    completions.push(beginAudio(buffer,text,'answer',cues));
  };
  try {
    await context().resume();$('tutorStatus').textContent='YandexGPT готовит подсказку…';
    const started=await api('dialog',JSON.stringify({question,level:$('schoolLevel').value,session:dialogId,voice:$('replyVoice').value}));
    if(epoch!==helpEpoch){await api('dialog-cancel',JSON.stringify({id:started.id}));return;}
    dialogId=started.session;currentJob=started.id;
    const deadline=performance.now()+660000;
    while(epoch===helpEpoch){
      const result=await api('dialog/'+started.id);
      if(epoch!==helpEpoch)return;
      if(result.answer&&!displayed){displayed=true;chatMessage('assistant',result.answer);$('lessonSpeech').textContent=result.answer;}
      while(received<(result.chunks?.length||0)){
        const i=received++;await getAudio(started.id,i,result.chunks[i].cues,result.answer);
        if(epoch!==helpEpoch)return;
      }
      if(result.state==='done'){
        if(!received&&result.cues?.length)await getAudio(started.id,null,result.cues,result.answer);
        await Promise.all(completions);if(epoch!==helpEpoch)return;
        followupUntil=performance.now()+60000;
        $('tutorStatus').textContent=result.warning||'Твоя очередь — попробуй следующий шаг.';break;
      }
      if(result.state==='error')throw new Error(result.warning);
      if(result.state==='cancelled')break;
      $('tutorStatus').textContent=result.state==='speaking'?'Озвучиваю подсказку…':'YandexGPT готовит подсказку…';
      if(performance.now()>deadline)throw new Error('Ответ занял слишком много времени.');
      await sleep(180);
    }
  } catch(e){
    if(epoch===helpEpoch){stopAudio();if(currentJob)api('dialog-cancel',JSON.stringify({id:currentJob})).catch(()=>{});
      fail(e);$('tutorStatus').textContent='Повторите вопрос или начните новое задание.';}
  } finally{if(epoch===helpEpoch){tutorBusy=false;currentJob=null;controls();}}
}
function stopHandsFree(){
  listenEpoch++;
  if(listener){listener.sttAbort?.abort();listener.abort.abort();listener.source?.disconnect();listener.high?.disconnect();listener.low?.disconnect();listener.node?.disconnect();stopTracks(listener.mic);listener=null;}
  $('listenerStatus').textContent='Микрофон выключен';
}
async function startHandsFree(){
  stopHandsFree();
  if(!running||paused||!$('handsFree').checked)return;
  if(!status.speech?.enabled){$('listenerStatus').textContent='Для голосовых вопросов настройте SpeechKit';return;}
  const epoch=listenEpoch,entry={abort:new AbortController()};listener=entry;
  try{
    const ctx=context();await ctx.resume();
    entry.mic=await withTimeout(navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true}}),20000,stopTracks,entry.abort.signal);
    if(epoch!==listenEpoch){stopTracks(entry.mic);return;}
    await ctx.audioWorklet.addModule('/listener-worklet.js');
    if(epoch!==listenEpoch){stopTracks(entry.mic);return;}
    entry.source=ctx.createMediaStreamSource(entry.mic);
    entry.high=ctx.createBiquadFilter();entry.high.type='highpass';entry.high.frequency.value=100;
    entry.low=ctx.createBiquadFilter();entry.low.type='lowpass';entry.low.frequency.value=Math.min(5000,ctx.sampleRate*.4);
    entry.node=new AudioWorkletNode(ctx,'lesson-listener');const gate=new SpeechGate(ctx.sampleRate);
    entry.node.port.onmessage=({data})=>{
      if(epoch!==listenEpoch)return;
      const suppressed=!running||paused||document.hidden||tutorBusy||questionRecording||listenerPending||playing||performance.now()<echoUntil||presence.state==='absent';
      const samples=gate.push(data,suppressed);
      const message=tutorBusy?'Готовлю ответ · микрофон на паузе':listenerPending?'Распознаю вопрос…':suppressed?(presence.state==='absent'?'Жду возвращения к камере':'Микрофон на паузе · слушаю после ответа'):gate.active.length?'Слышу речь…':'Слушаю · скажи «помоги» или задай вопрос';
      if($('listenerStatus').textContent!==message)$('listenerStatus').textContent=message;
      if(samples)recognizeHandsFree(encodeWav(samples,ctx.sampleRate),epoch).catch(fail);
    };
    entry.source.connect(entry.high);entry.high.connect(entry.low);entry.low.connect(entry.node);entry.node.connect(ctx.destination);
    entry.mic.getAudioTracks()[0].onended=()=>{if(epoch===listenEpoch){stopHandsFree();$('listenerStatus').textContent='Микрофон отключён · включите снова';}};
  }catch(e){if(epoch===listenEpoch){stopHandsFree();$('handsFree').checked=false;throw mediaError(e);}}
}
async function recognizeHandsFree(wav,listenId){
  listenerPending=true;controls();const epoch=helpEpoch;const abort=new AbortController();if(listener)listener.sttAbort=abort;
  $('listenerStatus').textContent='Распознаю вопрос…';
  try{
    const result=await api('speech',wav,true,50000,abort.signal);
    if(listenId!==listenEpoch||epoch!==helpEpoch||!running||paused)return;
    if(isDirectedSpeech(result.text,performance.now()<followupUntil))await answerQuestion(result.text);
    else $('listenerStatus').textContent='Речь без вопроса пропущена';
  }catch(e){
    if(listenId!==listenEpoch||epoch!==helpEpoch)return;
    if(/не имеет доступа|добавьте|лимит|код 429/i.test(e.message)){$('handsFree').checked=false;stopHandsFree();$('listenerStatus').textContent=e.message;fail(e);}
    else $('listenerStatus').textContent='Не разобрал речь · повтори вопрос';
  }finally{listenerPending=false;controls();}
}
async function voiceQuestion() {
  if(questionRecording) { questionStop=true; return; }
  if(tutorBusy||listenerPending||!running||paused)return;
  stopHandsFree();questionRecording=true; questionStop=false; questionCancel=false;
  questionAbort=new AbortController(); stopAudio(); controls();
  let ctx,source,node,mic;
  let wav;
  try {
    ctx=new AudioContext(); await ctx.resume();
    mic=await withTimeout(navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true}}),20000,stopTracks,questionAbort.signal);
    questionStream=mic;
    await ctx.audioWorklet.addModule('/recorder.js');
    source=ctx.createMediaStreamSource(mic); node=new AudioWorkletNode(ctx,'recorder');
    const chunks=[]; let count=0;
    node.port.onmessage=({data})=>{chunks.push(data);count+=data.length;};
    source.connect(node);node.connect(ctx.destination);
    const began=performance.now();
    while(!questionStop && !questionCancel && count<ctx.sampleRate*25) {
      $('tutorStatus').textContent=`Слушаю вопрос · ${Math.floor(count/ctx.sampleRate)} сек. Нажми «Закончить вопрос», когда закончишь.`;
      if(performance.now()-began>33000 || mic.getAudioTracks()[0].readyState!=='live') throw new Error('Микрофон перестал передавать звук.');
      await sleep(100);
    }
    if(questionCancel) return;
    const samples=new Float32Array(count); let offset=0;
    for(const chunk of chunks) {samples.set(chunk,offset);offset+=chunk.length;}
    wav=encodeWav(samples.slice(0,ctx.sampleRate*25),ctx.sampleRate);
  } catch(e) {if(!questionCancel) fail(mediaError(e));}
  finally {source?.disconnect();node?.disconnect();stopTracks(mic);await ctx?.close();questionStream=null;questionRecording=false;controls();if(running&&!paused)startHandsFree().catch(fail);}
  if(!wav || questionCancel) return;
  const epoch=++helpEpoch; tutorBusy=true;controls();
  try {
    $('tutorStatus').textContent='SpeechKit распознаёт вопрос…';
    const result=await api('speech',wav,true,50000);
    if(epoch!==helpEpoch) return;
    tutorBusy=false;
    await answerQuestion(result.text);
  } catch(e) {if(epoch===helpEpoch) {tutorBusy=false;controls();fail(e);}}
}
function action(id, fn) { $(id).addEventListener('click', async () => {
  if (pendingActions.has(id)) return;
  pendingActions.add(id); clearError(); controls();
  try { await fn(); } catch(e) { fail(e); }
  finally { pendingActions.delete(id); controls(); }
}); }
function updateVoiceMode() {
  const direct = $('voiceMode').value === 'direct';
  $('recordBtn').textContent = direct ? 'Записать напоминание · 8 сек' : 'Записать образец · 20 сек';
  $('readText').textContent = direct ? 'Давай вернёмся к заданию. Если нужна помощь, позови меня.' : 'Привет! Я рядом, если тебе нужна помощь. Давай спокойно разберёмся с заданием. Сначала прочитаем условие, потом подумаем над решением. Не нужно торопиться. У тебя всё получится.';
}
$('voiceMode').addEventListener('change', () => { voiceModeTouched = true; updateVoiceMode(); controls(); });
action('cancelRecordBtn', () => { recordCancelled = true; recordingAbort?.abort(); stopTracks(recordingStream); });
action('cancelScanBtn', () => { scanning = false;scanEpoch++;window.speechSynthesis?.cancel(); $('cameraHint').textContent = 'Сканирование отменено'; });
document.addEventListener('keydown',event=>{
  if(!scanning) return;
  if(event.key==='Escape') {event.preventDefault();$('cancelScanBtn').click();}
  if(event.key==='Tab') {event.preventDefault();$('cancelScanBtn').focus();}
});
action('cancelVoiceBtn', async () => { await api('cancel', new Uint8Array()); await poll(); });
action('cameraBtn', async () => { connecting = true; controls(); try { if (stream) { stopCamera(); $('cameraHint').textContent = 'Камера выключена'; } else { await dependencies(); await enableCamera(); } } finally { connecting = false; controls(); } });
action('scanBtn', scan); action('recordBtn', record); action('generateBtn', async () => { await api('generate', new Uint8Array()); await poll(); });
action('testVoiceBtn', () => playVoice('preview')); action('startBtn', start); action('pauseBtn', pause); action('stopBtn', stop);
action('lessonVoiceBtn', () => playVoice('lesson')); action('stopSpeechBtn', cancelTutor);
$('handsFree').addEventListener('change',()=>startHandsFree().catch(fail));
$('replyVoice').addEventListener('change',()=>{if(running&&$('replyVoice').value==='parent')api('voice-warm',new Uint8Array()).catch(()=>{});});
$('voiceQuestionBtn').addEventListener('click',()=>voiceQuestion().catch(fail));
$('scanAudio').addEventListener('change',()=>{if(!$('scanAudio').checked) window.speechSynthesis?.cancel();});
document.querySelectorAll('[data-setup-step]').forEach(button=>button.addEventListener('click',()=>setupStep(button.dataset.setupStep)));
action('nextVoiceBtn',()=>setupStep('voice'));action('nextReadyBtn',()=>setupStep('ready'));
action('viewFrontBtn',()=>{previewYaw=0;});action('viewSideBtn',()=>{previewYaw=.12;});
action('editProportionsBtn',openPortraitEditor);
action('savePortraitBtn',savePortrait);
action('resetPortraitBtn',()=>{portraitAnchors=defaultPortraitAnchors(portraitView.landmarks);renderPortraitEditor();rebuildPortrait();});
action('cancelPortraitBtn',async()=>{
  clearTimeout(portraitRebuildTimer);portraitDraft=false;$('portraitEditor').hidden=true;
  disposeAvatar();mesh=null;portraitView=null;portraitAnchors=null;avatarViews=[];
  $('placeholder').hidden=false;$('placeholder').style.display='grid';$('faceStatus').textContent='Голова ещё не отсканирована';
  await restoreAvatar();
});
$('portraitPoint').addEventListener('change',()=>{selectedAnchor=$('portraitPoint').value;renderPortraitEditor();});
$('portraitGroup').addEventListener('change',()=>{selectPortraitGroup();renderPortraitEditor();});
for(const [id,dx,dy] of [['pointLeft',-.003,0],['pointRight',.003,0],['pointUp',0,-.003],['pointDown',0,.003]])action(id,()=>movePortraitPoint(dx,dy));
let portraitDrag=null;
$('portraitHandles').addEventListener('pointerdown',event=>{
  const button=event.target.closest('[data-anchor]');if(!button || button.disabled)return;
  selectedAnchor=button.dataset.anchor;portraitDrag={id:event.pointerId,button};button.setPointerCapture(event.pointerId);renderPortraitEditor();event.preventDefault();
});
$('portraitHandles').addEventListener('pointermove',event=>{
  if(!portraitDrag || portraitDrag.id!==event.pointerId || pendingActions.has('savePortraitBtn'))return;
  const rect=$('portraitImage').getBoundingClientRect(),p=portraitAnchors[selectedAnchor];
  p.x=Math.max(.015,Math.min(.985,(event.clientX-rect.left)/rect.width));p.y=Math.max(.015,Math.min(.985,(event.clientY-rect.top)/rect.height));
  renderPortraitEditor();
});
for(const name of ['pointerup','pointercancel'])$('portraitHandles').addEventListener(name,event=>{
  if(!portraitDrag || portraitDrag.id!==event.pointerId)return;
  portraitDrag.button.releasePointerCapture(event.pointerId);portraitDrag=null;rebuildPortrait();
});
$('portraitHandles').addEventListener('keydown',event=>{
  const key=event.target.dataset.anchor,delta={ArrowLeft:[-.003,0],ArrowRight:[.003,0],ArrowUp:[0,-.003],ArrowDown:[0,.003]}[event.key];
  if(!key || !delta)return;selectedAnchor=key;event.preventDefault();movePortraitPoint(...delta);
});
action('previewMotionBtn',()=>playVoice('preview'));
action('viewMeshBtn',()=>{showWireframe=!showWireframe;applyModelView();});
$('hairStyle').addEventListener('change',()=>{
  localStorage.setItem('parentai-hair',$('hairStyle').value);
  if(avatarViews.length) {const front=avatarViews.find(v=>v.role==='front') || [...avatarViews].sort((a,b)=>Math.abs(a.yaw)-Math.abs(b.yaw))[0];buildMesh(front.landmarks,front.canvas,avatarTopology,avatarViews);}
});
$('hairStyle').value=localStorage.getItem('parentai-hair') || 'short';
$('hairColor').addEventListener('change',()=>{localStorage.setItem('parentai-hair-color',$('hairColor').value);if(avatarViews.length){const front=avatarViews.find(v=>v.role==='front')||avatarViews[0];buildMesh(front.landmarks,front.canvas,avatarTopology,avatarViews);}});
$('tutorForm').addEventListener('submit', askTutor);
$('cancelHelpBtn').addEventListener('click', cancelTutor);
$('clearHelpBtn').addEventListener('click', () => { cancelTutor(); dialogId=null;followupUntil=0; $('tutorMessages').replaceChildren(); $('assignment').value = ''; });
window.addEventListener('popstate', () => { if (running) stop(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { recordCancelled = true; recordingAbort?.abort(); stopTracks(recordingStream);scanning=false;scanEpoch++;window.speechSynthesis?.cancel();stopHandsFree();stopCamera(); } if (document.hidden && running && !paused) { pause(); $('monitorStatus').textContent = 'Перерыв · окно скрыто'; } });
window.addEventListener('beforeunload', () => { stopHandsFree();stopTracks(questionStream);stopTracks(recordingStream);stopAudio(); stopCamera(); detector?.close(); audioContext?.close(); });
async function restoreAvatar() {
  try {
    const saved = await api('avatar');
    if (!saved) return;
    $('faceStatus').textContent = 'Восстанавливаю маску…';
    const vision = await dependencies();
    const sourceViews = saved.views || [{landmarks:saved.landmarks,photo:saved.photo,yaw:0}];
    const views = await Promise.all(sourceViews.map(async view => {
      const photo = new Image(); photo.src = view.photo; await photo.decode();
      const canvas = document.createElement('canvas'); canvas.width = photo.width; canvas.height = photo.height;
      canvas.getContext('2d').drawImage(photo,0,0);
      return {...view,canvas};
    }));
    portraitView=null;portraitAnchors=null;portraitDraft=false;portraitConfirmed=saved.version===5;
    if(saved.portrait){const photo=new Image();photo.src=saved.portrait.photo;await photo.decode();const canvas=document.createElement('canvas');canvas.width=photo.width;canvas.height=photo.height;canvas.getContext('2d').drawImage(photo,0,0);portraitView={...saved.portrait,canvas};portraitAnchors=saved.anchors || defaultPortraitAnchors(saved.portrait.landmarks);}
    const front = views.find(view=>view.role==='front') || [...views].sort((a,b)=>Math.abs(a.yaw||0)-Math.abs(b.yaw||0))[0];
    buildMesh(front.landmarks, front.canvas, vision.FaceLandmarker.FACE_LANDMARKS_TESSELATION, views);
    $('faceStatus').textContent = portraitConfirmed ? 'Фронтальный аватар загружен' : 'Старый скан · проверьте контур';
    $('cameraHint').textContent = portraitConfirmed ? 'Модель загружена. Можно перейти к голосу.' : 'Сделайте два снимка прямо или настройте пропорции по сохранённому портрету.';
  } catch(e) { $('faceStatus').textContent = 'Пересканируйте лицо'; fail(e); }
  finally { controls(); }
}
async function refreshMicrophones() {
  try {
    const selected = $('microphone').value;
    const devices = await navigator.mediaDevices.enumerateDevices();
    $('microphone').replaceChildren(new Option('По умолчанию', ''), ...devices.filter(d=>d.kind==='audioinput' && d.deviceId).map((d,i)=>new Option(d.label || `Микрофон ${i+1}`,d.deviceId)));
    if ([...$('microphone').options].some(o=>o.value===selected)) $('microphone').value=selected;
  } catch {}
}
navigator.mediaDevices?.addEventListener('devicechange', refreshMicrophones);
refreshMicrophones();
if (location.hash === '#lesson') history.replaceState({}, '', location.pathname + location.search);
updateVoiceMode(); controls(); requestAnimationFrame(tick);
try {
  ({token} = await (await fetch('/api/session')).json());
  await poll(); await restoreAvatar();
} catch { online = false; }
pollLoop();

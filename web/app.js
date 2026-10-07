import {Presence, encodeWav, withTimeout, speechOpening, scanQuality, scanTurnIssue, portraitQuality, faceYaw} from './core.mjs';
import {blinkAmount} from './head-geometry.mjs';
import {SpeechGate,isDirectedSpeech} from './listening.mjs';
import {AvatarMotion} from './avatar-motion.mjs';
import {ModelAvatar} from './avatar-model.mjs';
import {LocalAvatar} from './local-avatar.mjs';
import {fitPortraitAnchors} from './portrait-fit.mjs';
import {defaultPortraitAnchors} from './portrait-geometry.mjs';
const $ = id => document.getElementById(id);
const video = $('camera');
const fail = e => { $('error').hidden = false; $('error').textContent = e.message || String(e); };
const clearError = () => { $('error').hidden = true; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let token, status = {}, stream, detector, avatarTopology, THREE, renderer, scene, camera, mesh, avatarGroup, modelAvatar;
let audioContext, analyser, audioSource, pcm, playing = false, recording = false, scanning = false;
let running = false, paused = false, lastFrame = -1, lastDetect = 0, lastResult = null, lastSeenFrame = 0;
let lastMediaTimestamp = -1;
let dependenciesPromise, detectError = false, connecting = false, playbackId = 0, audioKind = '';
const presence = new Presence();
const pendingActions = new Set();
let online = false, recordCancelled = false, recordingStream, recordingAbort, referenceRejected = false, previewUrl, renderTime = 0;
let referenceLoaded = false, voiceModeTouched = false;
let lessonStarted = 0, lessonElapsed = 0, tutorBusy = false;
let activeCues=[], audioStarted=0, dialogId=null, helpEpoch=0;
let questionRecording=false, questionStop=false, questionCancel=false, questionAbort, questionStream;
let currentJob=null;
let previewYaw=0,showWireframe=false,scanEpoch=0;
let scannerAbort=null;
let listener=null,listenEpoch=0,echoUntil=0,followupUntil=0,listenerPending=false,cameraEpoch=0,cameraAbort;
const audioSources=new Set();let audioNext=0;
const avatarMotion=new AvatarMotion();let childSpeakingUntil=0;
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
  $('scanBtn').disabled = !online || transition || !status.scanner?.enabled || scanning || running || recording || connecting;
  $('nextVoiceBtn').disabled=!mesh || scanning;
  $('scannerUnavailable').hidden=true;
  $('previewMotionBtn').disabled=!mesh || !status.phrases?.length || scanning || recording || running;
  $('nextReadyBtn').disabled=!(status.phrases?.length) || recording || voiceBusy();
  for(const id of ['viewFrontBtn','viewSideBtn','viewMeshBtn']) $(id).disabled=!mesh || scanning;
  for(const button of document.querySelectorAll('[data-setup-step]')) button.disabled=scanning || recording || running;
  $('recordBtn').disabled = !online || transition || recording || scanning || running || voiceBusy();
  $('voiceMode').disabled = recording || running || voiceBusy();
  $('microphone').disabled = recording;
  $('generateBtn').disabled = !online || transition || recording || running || !status.reference || referenceRejected || status.reference_mode !== $('voiceMode').value || voiceBusy();
  $('generateBtn').textContent = $('voiceMode').value === 'direct' ? 'Сохранить напоминание' : 'Создать голос';
  $('testVoiceBtn').disabled = !online || !(status.phrases?.length) || recording || running;
  $('startBtn').disabled = !online || transition || !mesh || !(status.phrases?.length) || running || scanning || recording || voiceBusy();
  $('pauseBtn').disabled = !running || transition;
  $('stopBtn').disabled = !running;
  $('lessonVoiceBtn').disabled = !running || paused || tutorBusy || questionRecording || !(status.phrases?.length);
  $('stopSpeechBtn').disabled = !playing;
  $('askBtn').disabled = tutorBusy || questionRecording || listenerPending || !online || !status.tutor?.enabled;
  $('voiceQuestionBtn').disabled = !running || paused || !online || tutorBusy || listenerPending || !status.speech?.enabled;
  $('handsFree').disabled=!status.speech?.enabled && !listener;
  $('voiceQuestionBtn').textContent = questionRecording ? 'Закончить вопрос' : 'Записать вопрос';
  $('readyHandsFree').disabled=running || !status.speech?.enabled;
  $('readyMicHint').textContent=status.speech?.enabled?'После начала микрофон будет заметен над аватаром. Его можно выключить в любой момент.':'Голосовые вопросы пока не подключены. Можно написать вопрос; родителю нужно настроить SpeechKit.';
  $('stopSpeechBtn').hidden=!playing;
  $('readyHandsFree').checked=$('handsFree').checked;
  $('faceNextHint').textContent=!mesh?'После создания аватара можно перейти к голосу.':'';
  $('voiceNextHint').textContent=voiceBusy()?'Готовим голос. Можно отменить и попробовать снова.':!status.phrases?.length?'Запишите, прослушайте и сохраните голос, чтобы продолжить.':'';
  $('startHint').textContent=!mesh?'Сначала создайте образ родителя на первом шаге.':!status.phrases?.length?'Сначала сохраните голос на втором шаге.':voiceBusy()?'Подождите, пока голос будет готов.':'';
  $('startBtn').textContent=pendingActions.has('startBtn')?'Подключаем камеру…':'Начать занятие →';
  $('cancelHelpBtn').hidden = !tutorBusy && !questionRecording && !listenerPending;
  $('cancelRecordBtn').hidden = !recording;
  $('cancelVoiceBtn').hidden = !voiceBusy();
  $('cancelVoiceBtn').disabled = status.voice === 'cancelling';
  $('cancelScanBtn').hidden = !scanning;
  for (const id of pendingActions) $(id).disabled = true;
  if (!running) $('monitorStatus').textContent = mesh && status.phrases?.length ? 'Готово к занятию' : 'Настройте лицо и голос';
  $('readyHint').textContent = running ? (paused ? 'Перерыв. Камера и напоминания выключены.' : 'Занятие идёт. Можно сделать перерыв в любой момент.') : !online ? 'Подключение к приложению…' : !mesh ? 'Сначала создайте свой аватар' : !status.phrases?.length ? 'Теперь сохраните голос' : 'Всё готово. Посадите ребёнка перед камерой и начните занятие.';
}
async function poll() {
  try {
    status = await api('status'); online = true;
    $('connection').textContent = 'Подключено';
    $('ttsStatus').textContent = `Клонирование: ${status.voice_engine?.message || status.tts}`;
    $('assetsStatus').textContent = `Распознавание: ${status.assets}`;
    if (!tutorBusy && !questionRecording) $('tutorStatus').textContent = status.tutor?.enabled?'Скажи «помоги» или напиши вопрос. Будем пробовать по шагам.':'Помощник ещё не подключён. Попроси родителя настроить Яндекс.';
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
    avatarTopology=vision.FaceLandmarker.FACE_LANDMARKS_TESSELATION;
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
  scene.add(new THREE.AmbientLight(0xffffff, 1.05));
  scene.add(new THREE.HemisphereLight(0xffffff, 0x66717b, .45));
  const light = new THREE.DirectionalLight(0xffffff, .3); light.position.set(2, 3, 4); scene.add(light);
  $('scene').appendChild(renderer.domElement);
  new ResizeObserver(() => fit()).observe($('scene'));
}
function fit() {
  if (!renderer) return;
  const w = $('scene').clientWidth, h = $('scene').clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h); camera.aspect = w / h;
  if (modelAvatar) modelAvatar.fit(camera, camera.aspect);
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
  controls();
}
function stopCamera() {
  cameraEpoch++;cameraAbort?.abort();stopTracks(stream);stream=null;video.srcObject=null;lastResult=null;
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
  if(!$('avatarConsent').checked){$('avatarConsent').focus();throw new Error('Разрешите ParentAI создать аватар из снимков на этом устройстве.');}
  stopAudio();scanning=true;const epoch=++scanEpoch,abort=new AbortController();scannerAbort=abort;
  $('scannerDialog').showModal();$('scannerCamera').appendChild(video.closest('.camera-frame'));controls();
  try {
    scanInstruction('Подключаем камеру. Сядьте лицом к свету, чтобы волосы и уши были видны.');
    await dependencies();await enableCamera();
    const poses=[
      {role:'front',direction:0,instruction:'Посмотрите прямо в объектив и мягко сомкните губы.'},
      {role:'left',direction:1,instruction:'Немного поверните голову к стрелке ←'},
      {role:'right',direction:-1,instruction:'Теперь немного поверните голову к стрелке →'},
      {role:'left_outer',direction:1,outer:true,instruction:'Поверните голову к стрелке ← чуть сильнее'},
      {role:'right_outer',direction:-1,outer:true,instruction:'Поверните голову к стрелке → чуть сильнее'},
      {role:'portrait',direction:0,instruction:'Снова смотрите прямо. Отодвиньте камеру, чтобы были видны макушка, оба уха, шея и плечи.'},
    ];
    const views=[];
    for(const {role,direction,outer=false,instruction} of poses){
      if(epoch!==scanEpoch)return;
      $('captureStep').textContent=`Снимок ${views.length+1} из ${poses.length}`;scanInstruction(instruction,true);
      let stable=0,previous=null;const began=performance.now();
      while(epoch===scanEpoch){
        const now=performance.now();if(now-began>90000)throw new Error('Не удалось сделать снимок. Отдохните и попробуйте ещё раз.');
        const result=landmarks(now),points=result?.faceLandmarks?.length===1?result.faceLandmarks[0]:null;
        const issue=!points?'В кадре должен быть один человек.':role==='portrait'?portraitQuality(points,video.videoWidth,video.videoHeight):role==='front'?scanQuality(points,video.videoWidth,video.videoHeight):scanTurnIssue(points,video.videoWidth,video.videoHeight,direction,outer);
        const movement=points&&previous?Math.max(...[1,33,263,152].map(i=>Math.hypot(points[i].x-previous[i].x,points[i].y-previous[i].y))):1;
        if(issue||movement>.012)stable=0;else if(!stable)stable=now;
        previous=points;
        if(issue)scanInstruction(issue);
        const remaining=stable?Math.max(0,1.2-(now-stable)/1000):1.2;
        $('captureCountdown').textContent=stable?String(Math.ceil(remaining)):'…';
        if(stable&&remaining<=0){
          const canvas=document.createElement('canvas'),scale=Math.min(1,960/video.videoWidth);canvas.width=Math.round(video.videoWidth*scale);canvas.height=Math.round(video.videoHeight*scale);canvas.getContext('2d').drawImage(video,0,0,canvas.width,canvas.height);
          lastMediaTimestamp=Math.max(now,lastMediaTimestamp+.01);
          const frozen=detector.detectForVideo(canvas,lastMediaTimestamp).faceLandmarks;
          if(frozen.length!==1){stable=0;continue;}
          const fresh=frozen[0];
          const frozenIssue=role==='portrait'?portraitQuality(fresh,canvas.width,canvas.height):role==='front'?scanQuality(fresh,canvas.width,canvas.height):scanTurnIssue(fresh,canvas.width,canvas.height,direction,outer);
          if(frozenIssue){stable=0;continue;}
          views.push({role,yaw:faceYaw(fresh),canvas,landmarks:fresh.map(p=>({x:p.x,y:p.y,z:p.z})),photo:canvas.toDataURL('image/jpeg',.88)});
          scanInstruction('Снимок готов.',true);await sleep(1200);break;
        }
        await sleep(80);
      }
    }
    if(epoch!==scanEpoch)return;
    stopCamera();scanInstruction('Все снимки готовы. Находим волосы, шею и плечи.',true);
    const portrait=views.find(view=>view.role==='portrait');portrait.anchors=await fitPortrait(portrait);
    scanInstruction('Создаём объёмную модель прямо на устройстве.',true);
    const model=LocalAvatar.create(THREE,views,avatarTopology);
    await api('avatar',JSON.stringify({version:7,views:views.map(({role,yaw,landmarks,photo})=>({role,yaw,landmarks,photo})),anchors:portrait.anchors}),true,60000,abort.signal);
    if(epoch!==scanEpoch){model.dispose();return;}
    installModel(model);cancelScan();
    $('faceStatus').textContent='Локальный 3D-аватар готов';$('cameraHint').textContent='Аватар создан на этом устройстве. Проверьте поворот и запишите голос.';
    scanInstruction('Ваш аватар готов. Фотографии никуда не отправлялись.',true);
  } catch(error){if(epoch===scanEpoch){cancelScan();throw error;}}
}
function cancelScan() {
  scanEpoch++;scanning=false;scannerAbort?.abort();stopCamera();
  $('setupCameraSlot').appendChild(video.closest('.camera-frame'));
  if($('scannerDialog').open)$('scannerDialog').close();
  window.speechSynthesis?.cancel();controls();$('scanBtn').focus({preventScroll:true});
}
let lastScanInstruction='',lastScanInstructionAt=0;
function scanInstruction(text,force=false) {
  $('cameraHint').textContent=text;$('scannerMessage').textContent=text;
  if(!$('scanAudio').checked||!window.speechSynthesis)return;
  const now=performance.now();if(!force&&(text===lastScanInstruction||now-lastScanInstructionAt<4500))return;
  lastScanInstruction=text;lastScanInstructionAt=now;speechSynthesis.cancel();
  const utterance=new SpeechSynthesisUtterance(text);utterance.lang='ru-RU';utterance.rate=.92;
  const voice=speechSynthesis.getVoices().find(v=>v.lang.startsWith('ru')&&v.localService);if(voice)utterance.voice=voice;speechSynthesis.speak(utterance);
}
async function fitPortrait(view) {
  let worker,bitmap;
  try {
    bitmap=await createImageBitmap(view.canvas);
    const mask=await new Promise((resolve,reject)=>{
      worker=new Worker('/portrait-worker.js');const timer=setTimeout(()=>reject(new Error('Контур не найден')),20000);
      worker.onmessage=({data})=>{clearTimeout(timer);data.error?reject(new Error(data.error)):resolve(data);};
      worker.onerror=event=>{clearTimeout(timer);reject(new Error(event.message||'Контур не найден'));};
      worker.postMessage(bitmap,[bitmap]);
    });
    view.segmentation=mask;
    return fitPortraitAnchors(view.landmarks,mask);
  } catch { return defaultPortraitAnchors(view.landmarks); }
  finally {worker?.terminate();bitmap?.close();}
}
async function renderDependencies() {
  THREE ||= await import('./vendor/three.module.js');if(!renderer)initScene();
}
function installModel(model) {
  if(modelAvatar){scene.remove(modelAvatar.object);modelAvatar.dispose();}
  modelAvatar=model;avatarGroup=model.object;mesh=avatarGroup;scene.add(avatarGroup);applyModelView();
  $('placeholder').hidden=true;$('placeholder').style.display='none';fit();controls();
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
    $('voiceHint').textContent = `Запись: ${result.seconds} сек. Прослушайте её, затем нажмите «${mode==='direct'?'Сохранить напоминание':'Создать голос'}».`;
    status = await api('status');
  } catch(e) { if (!recordCancelled) throw mediaError(e); } finally { source?.disconnect(); node?.disconnect(); mic?.getTracks().forEach(t => t.stop()); await recordContext?.close(); $('level').value = 0; recordingStream = null; recording = false; controls(); }
}
async function start() {
  await context().resume();
  try {
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
  } catch(error){stopCamera();stopHandsFree();throw error;}
  stopAudio(); running = true; paused = false; presence.reset(); lessonElapsed = 0; lessonStarted = performance.now(); showLesson(); controls();
  if($('replyVoice').value==='parent') api('voice-warm',new Uint8Array()).catch(()=>{});
  startHandsFree().catch(fail);
  try { await playVoice('lesson'); } catch(e) { fail(e); }
}
async function pause() {
  stopAudio(); cancelTutor();stopHandsFree();
  if (!paused) { lessonElapsed += performance.now() - lessonStarted; paused = true; document.body.classList.add('on-break');stopCamera();setListenerState('off','Перерыв. Камера и микрофон выключены.'); $('pauseBtn').textContent = 'Продолжить занятие'; $('monitorStatus').textContent = 'Перерыв · камера выключена'; }
  else { await enableCamera(); presence.reset(); paused = false;document.body.classList.remove('on-break'); lessonStarted = performance.now(); $('pauseBtn').textContent = 'Сделать перерыв';startHandsFree().catch(fail); }
  controls();
}
function stop() { stopHandsFree();api('voice-release',new Uint8Array()).catch(()=>{});running = false; paused = false;document.body.classList.remove('on-break'); stopAudio(); stopCamera(); cancelTutor(); presence.reset(); $('pauseBtn').textContent = 'Сделать перерыв'; $('monitorStatus').textContent = 'Занятие завершено · камера выключена'; showSetup(); controls(); }
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
      if (current.remind && !tutorBusy && !questionRecording && !listenerPending && now>childSpeakingUntil && !playing) reminder();
    } catch (e) { if (!detectError) { detectError = true; pause(); fail(e); } }
  }
  if (mesh && !document.hidden && now - renderTime >= 33) {
    renderTime = now;
    let opening=0;
    if(playing&&analyser){analyser.getFloatTimeDomainData(pcm);opening=speechOpening(pcm);}
    const elapsed=audioContext?audioContext.currentTime-audioStarted:0;
    const cue=playing?activeCues.findLast(c=>c.time<=elapsed):null;
    const pose=avatarMotion.update(now/1000,{active:(running&&!paused)||audioKind==='preview',speaking:playing,listening:now<childSpeakingUntil,engaged:listenerPending||questionRecording||tutorBusy,preview:running?0:previewYaw,reduced:matchMedia('(prefers-reduced-motion: reduce)').matches});
    modelAvatar?.update(pose,opening,cue?.shape,blinkAmount(now/1000));
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
  document.body.classList.add('in-lesson');$('lessonToolbar').hidden=false;
  document.querySelector('h1').textContent = 'Давай позанимаемся';
  $('lessonSpeech').textContent = 'Я рядом. Скажи «помоги» и расскажи, что не получается.';
  $('micIntro').hidden=!$('handsFree').checked || !status.speech?.enabled;
  setListenerState('off','Микрофон ещё не включён. Можно написать вопрос.');
  history.pushState({lesson:true}, '', '#lesson');
  requestAnimationFrame(fit); window.scrollTo(0,0);
}
function showSetup() {
  $('setupAvatarSlot').appendChild($('scene'));
  $('setupCameraSlot').appendChild(video.closest('.camera-frame'));
  $('lessonPage').hidden = true; $('setupPage').hidden = false;
  document.body.classList.remove('in-lesson');$('lessonToolbar').hidden=true;
  document.querySelector('h1').textContent = 'Рядом во время занятий';
  if (location.hash) history.replaceState({}, '', location.pathname + location.search);
  requestAnimationFrame(fit); window.scrollTo(0,0);
}
function setupStep(step) {
  if(scanning || recording) return;
  const content={face:['Давайте создадим ваш образ','Сканер создаст объёмный аватар по снимкам лица. Готовый образ появится здесь автоматически.'],voice:['Знакомый голос — спокойнее учиться','Запишите образец в тихой комнате, затем прослушайте результат.'],ready:['Устроимся поудобнее','Посадите ребёнка перед камерой и начните. Вопросы можно задавать голосом или текстом.']};
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
    if(item.material && item.isMesh) for(const material of Array.isArray(item.material)?item.material:[item.material])material.wireframe=showWireframe;
  });
  $('viewMeshBtn').setAttribute('aria-pressed',String(showWireframe));
  $('viewMeshBtn').textContent=showWireframe?'Скрыть сетку':'Показать сетку';
}
function chatMessage(role, text) {
  const box = document.createElement('p'); box.className = `chat-message ${role}`;
  const label = document.createElement('strong'); label.textContent = role === 'user' ? 'Ты' : 'Давай попробуем';
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
    await context().resume();$('tutorStatus').textContent='Думаю, как помочь…';
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
      $('tutorStatus').textContent=result.state==='speaking'?'Озвучиваю подсказку…':'Думаю, как помочь…';
      if(performance.now()>deadline)throw new Error('Ответ занял слишком много времени.');
      await sleep(180);
    }
  } catch(e){
    if(epoch===helpEpoch){stopAudio();if(currentJob)api('dialog-cancel',JSON.stringify({id:currentJob})).catch(()=>{});
      fail(e);$('tutorStatus').textContent='Повторите вопрос или начните новое задание.';}
  } finally{if(epoch===helpEpoch){tutorBusy=false;currentJob=null;controls();}}
}
function setListenerState(state,message) {
  const titles={off:'Микрофон выключен',connecting:'Включаем микрофон…',listening:'Микрофон включён',speech:'Слышу тебя',waiting:'Микрофон включён · пауза',processing:'Вопрос принят',error:'Микрофон выключен'};
  $('micCard').dataset.state=state;$('micTitle').textContent=titles[state];
  if($('listenerStatus').textContent!==message)$('listenerStatus').textContent=message;
  if(state!=='speech')$('lessonLevel').style.width='0%';
  if(state==='error'||(state==='off'&&!$('handsFree').checked))$('micIntro').hidden=true;
}
function stopHandsFree(){
  listenEpoch++;
  if(listener){listener.sttAbort?.abort();listener.abort.abort();listener.source?.disconnect();listener.high?.disconnect();listener.low?.disconnect();listener.node?.disconnect();stopTracks(listener.mic);listener=null;}
  childSpeakingUntil=0;setListenerState('off',paused?'Перерыв. Микрофон и камера выключены.':'Включи «Без кнопки» или напиши вопрос.');
}
async function startHandsFree(){
  stopHandsFree();
  if(!running||paused||!$('handsFree').checked)return;
  if(!status.speech?.enabled){setListenerState('off','Попроси родителя подключить голосовые вопросы. Пока можно написать.');return;}
  setListenerState('connecting','Разреши микрофон в окне браузера. Затем можно говорить без кнопки.');
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
      setListenerState(listenerPending?'processing':suppressed?'waiting':gate.active.length?'speech':'listening',message);
      if(gate.active.length){childSpeakingUntil=performance.now()+1500;$('lessonLevel').style.width=Math.min(100,gate.level*600)+'%';}
      if(samples)recognizeHandsFree(encodeWav(samples,ctx.sampleRate),epoch).catch(fail);
    };
    entry.source.connect(entry.high);entry.high.connect(entry.low);entry.low.connect(entry.node);entry.node.connect(ctx.destination);
    entry.mic.getAudioTracks()[0].onended=()=>{if(epoch===listenEpoch){stopHandsFree();$('handsFree').checked=false;setListenerState('error','Доступ к микрофону потерян. Включи «Без кнопки», чтобы попробовать снова.');}};
  }catch(e){if(epoch===listenEpoch){stopHandsFree();$('handsFree').checked=false;setListenerState('error','Не удалось включить микрофон. Разреши доступ в браузере или напиши вопрос.');throw mediaError(e);}}
}
async function recognizeHandsFree(wav,listenId){
  listenerPending=true;controls();const epoch=helpEpoch;const abort=new AbortController();if(listener)listener.sttAbort=abort;
  setListenerState('processing','Распознаю вопрос. Сейчас отвечу.');
  try{
    const result=await api('speech',wav,true,50000,abort.signal);
    if(listenId!==listenEpoch||epoch!==helpEpoch||!running||paused)return;
    if(isDirectedSpeech(result.text,performance.now()<followupUntil))await answerQuestion(result.text);
    else setListenerState('listening','Скажи «помоги» и задай вопрос.');
  }catch(e){
    if(listenId!==listenEpoch||epoch!==helpEpoch)return;
    if(/не имеет доступа|добавьте|лимит|код 429/i.test(e.message)){$('handsFree').checked=false;stopHandsFree();setListenerState('error',e.message);fail(e);}
    else setListenerState('listening','Не разобрал речь. Попробуй ещё раз.');
  }finally{listenerPending=false;controls();}
}
async function voiceQuestion() {
  if(questionRecording) { questionStop=true; return; }
  if(tutorBusy||listenerPending||!running||paused)return;
  stopHandsFree();questionRecording=true; questionStop=false; questionCancel=false;
  questionAbort=new AbortController(); stopAudio();setListenerState('connecting','Разреши микрофон в браузере.'); controls();
  let ctx,source,node,mic;
  let wav;
  try {
    ctx=new AudioContext(); await ctx.resume();
    mic=await withTimeout(navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true}}),20000,stopTracks,questionAbort.signal);
    questionStream=mic;setListenerState('speech','Говори. Когда закончишь, нажми «Закончить вопрос».');
    await ctx.audioWorklet.addModule('/recorder.js');
    source=ctx.createMediaStreamSource(mic); node=new AudioWorkletNode(ctx,'recorder');
    const chunks=[]; let count=0;
    node.port.onmessage=({data})=>{chunks.push(data);count+=data.length;const rms=Math.sqrt(data.reduce((v,x)=>v+x*x,0)/data.length);if(rms>.008)childSpeakingUntil=performance.now()+1500;};
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
    $('tutorStatus').textContent='Распознаю твой вопрос…';
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
  $('voiceModeHint').textContent=direct?'Запись сохранится как есть. Для новых ответов вашим голосом выберите второй вариант.':'Новые фразы будут создаваться вашим голосом на компьютере. Первый ответ после запуска может готовиться дольше.';
  $('readText').textContent = direct ? 'Давай вернёмся к заданию. Если нужна помощь, позови меня.' : 'Привет! Я рядом, если тебе нужна помощь. Давай спокойно разберёмся с заданием. Сначала прочитаем условие, потом подумаем над решением. Не нужно торопиться. У тебя всё получится.';
}
$('voiceMode').addEventListener('change', () => { voiceModeTouched = true; updateVoiceMode(); controls(); });
action('cancelRecordBtn', () => { recordCancelled = true; recordingAbort?.abort(); stopTracks(recordingStream); });
action('cancelScanBtn', cancelScan);
$('scannerDialog').addEventListener('cancel',event=>{event.preventDefault();cancelScan();});
action('cancelVoiceBtn', async () => { await api('cancel', new Uint8Array()); await poll(); });
action('scanBtn', scan); action('recordBtn', record); action('generateBtn', async () => { await api('generate', new Uint8Array()); await poll(); });
action('testVoiceBtn', () => playVoice('preview')); action('startBtn', start); action('pauseBtn', pause); action('stopBtn', stop);
action('lessonVoiceBtn', () => playVoice('lesson')); action('stopSpeechBtn', cancelTutor);
$('handsFree').addEventListener('change',()=>{clearError();$('readyHandsFree').checked=$('handsFree').checked;startHandsFree().catch(fail);});
$('readyHandsFree').addEventListener('change',()=>{$('handsFree').checked=$('readyHandsFree').checked;});
action('dismissMicIntroBtn',()=>{$('micIntro').hidden=true;});
document.querySelector('.brand').addEventListener('click',event=>{event.preventDefault();if(running)stop();setupStep('face');});
$('replyVoice').addEventListener('change',()=>{if(running&&$('replyVoice').value==='parent')api('voice-warm',new Uint8Array()).catch(()=>{});});
$('voiceQuestionBtn').addEventListener('click',()=>voiceQuestion().catch(fail));
$('scanAudio').addEventListener('change',()=>{if(!$('scanAudio').checked) window.speechSynthesis?.cancel();});
document.querySelectorAll('[data-setup-step]').forEach(button=>button.addEventListener('click',()=>setupStep(button.dataset.setupStep)));
action('nextVoiceBtn',()=>setupStep('voice'));action('nextReadyBtn',()=>setupStep('ready'));
action('viewFrontBtn',()=>{previewYaw=0;});action('viewSideBtn',()=>{previewYaw=.55;});
action('previewMotionBtn',()=>playVoice('preview'));
action('viewMeshBtn',()=>{showWireframe=!showWireframe;applyModelView();});
$('tutorForm').addEventListener('submit', askTutor);
$('cancelHelpBtn').addEventListener('click', cancelTutor);
$('clearHelpBtn').addEventListener('click', () => { cancelTutor(); dialogId=null;followupUntil=0; $('tutorMessages').replaceChildren(); $('assignment').value = ''; });
window.addEventListener('popstate', () => { if (running) stop(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { recordCancelled = true; recordingAbort?.abort(); stopTracks(recordingStream);if(scanning)cancelScan();window.speechSynthesis?.cancel();stopHandsFree();stopCamera(); } if (document.hidden && running && !paused) { pause(); $('monitorStatus').textContent = 'Перерыв · окно скрыто'; } });
window.addEventListener('beforeunload', () => { stopHandsFree();stopTracks(questionStream);stopTracks(recordingStream);stopAudio(); stopCamera(); scannerAbort?.abort();modelAvatar?.dispose();detector?.close(); audioContext?.close(); });
async function restoreAvatar() {
  try {
    const saved=await api('avatar');if(!saved)return;
    if(saved.version===7){
      $('faceStatus').textContent='Восстанавливаем локальный аватар…';await dependencies();
      const views=await Promise.all(saved.views.map(async view=>{const image=new Image();image.src=view.photo;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;canvas.getContext('2d').drawImage(image,0,0);return {...view,canvas,anchors:view.role==='portrait'?saved.anchors:undefined};}));
      const portrait=views.find(view=>view.role==='portrait');if(portrait)await fitPortrait(portrait);
      installModel(LocalAvatar.create(THREE,views,avatarTopology));
      $('faceStatus').textContent='Локальный 3D-аватар загружен';$('cameraHint').textContent='Аватар хранится на этом устройстве.';return;
    }
    if(saved.version!==6){
      $('faceStatus').textContent='Нужен новый скан';
      $('cameraHint').textContent='Ваш прежний снимок сохранён. Для локального объёмного аватара создайте новый образ через сканер.';
      return;
    }
    $('faceStatus').textContent='Восстанавливаем ваш аватар…';await renderDependencies();
    const response=await fetch('/api/avatar-model',{headers:{'X-App-Token':token}});
    if(!response.ok)throw new Error('Не удалось загрузить сохранённый аватар. Повторите сканирование.');
    installModel(await ModelAvatar.create(THREE,await response.arrayBuffer()));
    $('faceStatus').textContent='Ваш 3D-аватар загружен';
    $('cameraHint').textContent='Аватар сохранён. Сканировать заново не нужно.';
  } catch(error){$('faceStatus').textContent='Не удалось восстановить аватар';fail(error);}
  finally{controls();}
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

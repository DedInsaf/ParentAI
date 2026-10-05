import {positionsFor, scanQuality, scanCoverage, faceYaw, Presence, encodeWav, withTimeout, closeFaceOpenings, FACE_OPENINGS, mouthRig, speechOpening} from './core.mjs';
import {skullGeometry, earGeometry, neckGeometry, hairGeometry, OVAL, blinkAmount} from './head-geometry.mjs';
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
let lessonStarted = 0, lessonElapsed = 0, tutorBusy = false, tutorAbort, tutorHistory = [];
let avatarViews=[], avatarTopology, activeCues=[], audioStarted=0, dialogId=null, helpEpoch=0;
let questionRecording=false, questionStop=false, questionCancel=false, questionAbort, questionStream;
let currentJob=null, lipShape=0, lipPucker=0;
const voiceBusy = () => ['generating', 'cancelling'].includes(status.voice);
const stopTracks = value => value?.getTracks().forEach(t => t.stop());
function mediaError(e) {
  const messages = {NotAllowedError: 'Доступ запрещён. Разрешите камеру или микрофон в настройках браузера.', NotFoundError: 'Камера или микрофон не найдены.', NotReadableError: 'Камера или микрофон заняты другим приложением.'};
  return new Error(messages[e.name] || e.message);
}


async function api(path, body, retry = true, timeout = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch('/api/' + path, {method: body === undefined ? 'GET' : 'POST',
      signal: controller.signal,
      headers: {'X-App-Token': token, ...(body !== undefined ? {'Content-Type': 'application/octet-stream'} : {})}, body});
    if (res.status === 403 && retry) {
      const session = await fetch('/api/session', {signal: controller.signal});
      if (!session.ok) throw new Error('Не удалось восстановить подключение');
      ({token} = await session.json());
      return api(path, body, false, timeout);
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);
    return data;
  } finally { clearTimeout(timer); }
}
function controls() {
  const transition = pendingActions.has('startBtn') || pendingActions.has('pauseBtn');
  $('scanBtn').disabled = !online || transition || !stream || scanning || running || recording || connecting;
  $('cameraBtn').disabled = !online || transition || connecting || scanning || running || recording;
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
  $('askBtn').disabled = tutorBusy || questionRecording || !online || !status.tutor?.enabled;
  $('voiceQuestionBtn').disabled = !running || paused || !online || tutorBusy || !status.speech?.enabled;
  $('voiceQuestionBtn').textContent = questionRecording ? 'Закончить вопрос' : 'Помощь · спросить голосом';
  $('cancelHelpBtn').hidden = !tutorBusy && !questionRecording;
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
    $('ttsStatus').textContent = `Клонирование: ${status.tts}`;
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
  scene.add(new THREE.HemisphereLight(0xffffff, 0x304050, 1.15));
  const light = new THREE.DirectionalLight(0xffffff, 1.35); light.position.set(2, 3, 4); scene.add(light);
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
  stopCamera();
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Откройте приложение через адрес localhost из run_app.py.');
  try { stream = await withTimeout(navigator.mediaDevices.getUserMedia({video: {width: {ideal: 960}, height: {ideal: 720}, frameRate: {ideal: 20, max: 30}, facingMode: 'user'}, audio: false}), 20000, stopTracks); } catch(e) { throw mediaError(e); }
  video.srcObject = stream;
  try {
    await withTimeout(video.play(), 10000);
    const readyBy = performance.now() + 10000;
    while (video.readyState < 2 || !video.videoWidth) {
      if (performance.now() > readyBy) throw new Error('Камера не передаёт изображение. Повторите подключение.');
      await sleep(50);
    }
  } catch(e) { stopCamera(); throw e; }
  lastFrame = -1; lastResult = null; lastSeenFrame = performance.now(); detectError = false;
  $('cameraHint').textContent = 'Камера включена. Посмотрите прямо в объектив.';
  $('cameraBtn').textContent = 'Выключить камеру';
  controls();
}
function stopCamera() {
  stream?.getTracks().forEach(t => t.stop()); stream = null; video.srcObject = null; lastResult = null;
  $('cameraBtn').textContent = 'Включить камеру';
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
  scanning = true; $('scanProgress').value = 0; controls(); clearError();
  try {
    await dependencies(); await enableCamera();
    const takePose = async (phase, instruction, validate) => {
      let stableStart = 0, previous, frameTime = -1;
      const deadline = performance.now() + 25000;
      while (scanning && performance.now() < deadline) {
        await sleep(90);
        const now = performance.now();
        if (video.readyState < 2 || frameTime === video.currentTime) continue;
        frameTime = video.currentTime;
        const result = detectVideo(now), lm = result.faceLandmarks?.[0];
        const issue = result.faceLandmarks?.length !== 1 ? 'В кадре должен быть один человек' : validate(lm);
        const movement = previous && lm ? Math.hypot(lm[1].x - previous.x, lm[1].y - previous.y) : 0;
        previous = lm?.[1];
        if (issue || movement > .018) {
          stableStart = 0; $('scanProgress').value = phase / 3;
          $('cameraHint').textContent = issue || 'Замрите на секунду'; continue;
        }
        if (!stableStart) stableStart = now;
        $('cameraHint').textContent = `${instruction} · держите положение`;
        $('scanProgress').value = Math.min((phase + 1) / 3, (phase + (now - stableStart) / 900) / 3);
        if (now - stableStart >= 900) {
          const canvas = document.createElement('canvas');
          canvas.width = Math.min(720, video.videoWidth);
          canvas.height = Math.round(video.videoHeight * canvas.width / video.videoWidth);
          canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
          return {landmarks: lm, canvas, photo: canvas.toDataURL('image/jpeg', .88), yaw: faceYaw(lm)};
        }
      }
      if (!scanning) return null;
      throw new Error('Не удалось снять этот ракурс. Поверните голову медленнее и оставьте уши в кадре.');
    };
    const front = await takePose(0, 'Снято спереди', lm => scanQuality(lm, video.videoWidth, video.videoHeight));
    if (!front) return;
    $('cameraHint').textContent = 'Теперь медленно поверните голову в любую сторону';
    const side = await takePose(1, 'Первый боковой ракурс снят', lm => {
      const issue = scanCoverage(lm, video.videoWidth, video.videoHeight), yaw = Math.abs(faceYaw(lm));
      return issue || (yaw < .20 ? 'Поверните голову сильнее, чтобы было видно ухо' : yaw > .62 ? 'Немного повернитесь обратно' : '');
    });
    if (!side) return;
    $('cameraHint').textContent = 'Отлично. Теперь поверните голову в другую сторону';
    const other = await takePose(2, 'Все три ракурса сняты', lm => {
      const issue = scanCoverage(lm, video.videoWidth, video.videoHeight), yaw = faceYaw(lm);
      return issue || (Math.abs(yaw) < .20 || yaw * side.yaw > -.04 ? 'Поверните голову в противоположную сторону' : Math.abs(yaw) > .62 ? 'Немного повернитесь обратно' : '');
    });
    if (!other) return;
    const views = [front, side, other];
    buildMesh(front.landmarks, front.canvas, (await dependencies()).FaceLandmarker.FACE_LANDMARKS_TESSELATION, views);
    $('faceStatus').textContent = 'Объёмная маска готова';
    await api('avatar', JSON.stringify({version: 2, views: views.map(({landmarks, photo, yaw}) => ({landmarks, photo, yaw}))}));
    $('faceStatus').textContent = '3D-голова сохранена';
    $('cameraHint').textContent = 'Готово: лицо, боковые ракурсы, уши и объём головы сохранены.';
  } finally { scanning = false; lastFrame = -1; controls(); }
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
  const indices = [];
  for (let i = 0; i < topology.length; i += 3) {
    const tri = [topology[i].start, topology[i].end, topology[i + 1].end];
    if (tri.every(n => n < 468)) indices.push(...tri);
  }
  const filled = closeFaceOpenings(lm, indices, false);
  const geometry = new THREE.BufferGeometry();
  base = new Float32Array(positionsFor(filled.points, canvas.width, canvas.height));
  geometry.setAttribute('position', new THREE.BufferAttribute(base.slice(), 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(filled.points.flatMap(p => [p.x, 1 - p.y])), 2));
  geometry.setIndex(filled.indices); geometry.computeVertexNormals(); geometry.computeBoundingSphere();
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  // The photo already contains lighting. Additional directional light made skin waxy/overexposed.
  const next = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({map: texture, side: THREE.DoubleSide}));
  const rig = mouthRig(filled.points); jawWeights = rig.weights; mouthWidth = rig.width * 4.2;
  cavityIds = FACE_OPENINGS[2];
  const cavityPositions = new Float32Array((cavityIds.length + 1) * 3);
  cavityIds.forEach((id, i) => cavityPositions.set(base.slice(id * 3, id * 3 + 3), i * 3));
  for (const axis of [0,1,2]) cavityPositions[cavityIds.length*3+axis] = cavityIds.reduce((sum,id)=>sum+base[id*3+axis],0)/cavityIds.length;
  for (let i=2;i<cavityPositions.length;i+=3) cavityPositions[i] -= .012;
  const cavityGeometry = new THREE.BufferGeometry();
  cavityGeometry.setAttribute('position', new THREE.BufferAttribute(cavityPositions, 3));
  cavityGeometry.setIndex(cavityIds.flatMap((_,i)=>[i,(i+1)%cavityIds.length,cavityIds.length]));
  const nextCavity = new THREE.Mesh(cavityGeometry, new THREE.MeshBasicMaterial({color:0x301720,side:THREE.DoubleSide}));

  const head=skullGeometry(base), {cx,cy,width,height,edgeZ,depth}=head;
  const skin = sampledColor(views, view => view.landmarks[view.yaw < 0 ? 454 : 234], 0xc58f78);
  const hair = sampledColor(views, view => ({x:view.landmarks[10].x,y:Math.max(.02,view.landmarks[10].y-.09)}), 0x3a2a25);
  hair.multiplyScalar(.58);
  if (hair.b > hair.g * 1.05) hair.b = hair.g * .78; // Dark backgrounds often add a blue cast to brown hair.
  const skinMaterial = new THREE.MeshBasicMaterial({color:skin,side:THREE.DoubleSide});
  const hairMaterial = new THREE.MeshStandardMaterial({color:hair,roughness:1,metalness:0,side:THREE.DoubleSide});
  const group = new THREE.Group();
  const makeGeometry = data => {
    const result = new THREE.BufferGeometry();
    result.setAttribute('position',new THREE.Float32BufferAttribute(data.positions,3));
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
  group.add(new THREE.Mesh(shellGeometry,new THREE.MeshBasicMaterial({vertexColors:true,side:THREE.DoubleSide})));
  const hairData=hairGeometry(head,$('hairStyle').value);
  if(hairData.positions.length) group.add(new THREE.Mesh(makeGeometry(hairData),hairMaterial));
  else hairMaterial.dispose();
  group.add(new THREE.Mesh(makeGeometry(neckGeometry(head)),skinMaterial));
  for (const side of [-1,1]) {
    const data=earGeometry(head,side), ear=makeGeometry(data);
    ear.setAttribute('color',new THREE.Float32BufferAttribute(data.shade.flatMap(shade=>[skin.r*shade,skin.g*shade,skin.b*shade]),3));
    group.add(new THREE.Mesh(ear,new THREE.MeshBasicMaterial({vertexColors:true,side:THREE.DoubleSide})));
  }
  group.add(nextCavity,next);
  group.position.set(cx,cy,edgeZ-depth*.32);
  for (const child of group.children) child.position.sub(group.position);
  disposeAvatar(); avatarGroup=group; mesh=next; cavityMesh=nextCavity; scene.add(group);
  $('placeholder').hidden = true; $('placeholder').style.display = 'none'; fit();
}
function context() { return audioContext ||= new AudioContext(); }
function stopAudio() { playbackId++; activeCues=[]; if (audioSource) { try { audioSource.stop(); } catch {} audioSource.disconnect(); audioSource = null; } analyser?.disconnect(); analyser = null; playing = false; audioKind = ''; controls(); }
async function playVoice(kind = 'manual') {
  if (!status.phrases?.length) throw new Error('Сначала создайте голос.');
  stopAudio(); const playId = playbackId;
  const ctx = context(); await ctx.resume(); if (playId !== playbackId) return;
  const item = status.phrases[Math.floor(Math.random() * status.phrases.length)];
  const res = await fetch('/audio/' + item.file);
  if (!res.ok) throw new Error('Аудиофайл недоступен');
  const buffer = await ctx.decodeAudioData(await res.arrayBuffer());
  if (playId !== playbackId) return;
  beginAudio(buffer,item.text,kind);
}
function beginAudio(buffer,text,kind,cues=[]) {
  const ctx=context(); activeCues=cues; audioStarted=ctx.currentTime;
  const source = ctx.createBufferSource(); source.buffer = buffer;
  audioSource = source; analyser = ctx.createAnalyser(); analyser.fftSize = 512;
  pcm = new Float32Array(analyser.fftSize); source.connect(analyser); analyser.connect(ctx.destination);
  source.onended = () => { if (audioSource === source) { playing = false; audioKind = ''; source.disconnect(); analyser?.disconnect(); controls(); } };
  playing = true; audioKind = kind; source.start(); $('phraseText').textContent = text; $('lessonSpeech').textContent = text; controls();
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
  stopAudio(); running = true; paused = false; presence.reset(); lessonElapsed = 0; lessonStarted = performance.now(); showLesson(); controls();
  try { await playVoice('lesson'); } catch(e) { fail(e); }
}
async function pause() {
  stopAudio(); cancelTutor();
  if (!paused) { lessonElapsed += performance.now() - lessonStarted; paused = true; stopCamera(); $('pauseBtn').textContent = 'Продолжить'; $('monitorStatus').textContent = 'Перерыв · камера выключена'; }
  else { await enableCamera(); presence.reset(); paused = false; lessonStarted = performance.now(); $('pauseBtn').textContent = 'Перерыв'; }
}
function stop() { running = false; paused = false; stopAudio(); stopCamera(); cancelTutor(); presence.reset(); $('pauseBtn').textContent = 'Перерыв'; $('monitorStatus').textContent = 'Занятие завершено · камера выключена'; showSetup(); controls(); }
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
    if (playing && analyser) { analyser.getFloatTimeDomainData(pcm); target = speechOpening(pcm) * mouthWidth * .24; }
    const elapsed=audioContext ? audioContext.currentTime-audioStarted : 0;
    const cue=playing ? activeCues.findLast(c=>c.time<=elapsed) : null;
    if(cue?.shape==='closed' || cue?.shape==='silence') target*=.12;
    const shape=cue?.shape==='round' ? -.30 : cue?.shape==='wide' ? .18 : 0;
    lipShape+=(shape-lipShape)*.25;
    lipPucker+=((cue?.shape==='round' ? mouthWidth*.07 : 0)-lipPucker)*.25;
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
      cavityIds.forEach((id,i)=>{ mouth.array[i*3]=pos.array[id*3]; mouth.array[i*3+1]=pos.array[id*3+1]; mouth.array[i*3+2]=pos.array[id*3+2]-.012; });
      for (const axis of [0,1,2]) mouth.array[cavityIds.length*3+axis]=cavityIds.reduce((sum,id)=>sum+mouth.array[cavityIds.indexOf(id)*3+axis],0)/cavityIds.length;
      mouth.needsUpdate = true;
    }
    if (avatarGroup) {
      const motion = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : (running && !paused ? 1 : .65);
      avatarGroup.rotation.y = Math.sin(now / 3300) * .14 * motion;
      avatarGroup.rotation.x = (Math.sin(now / 2100) * .035 + (playing ? Math.sin(now / 420) * .016 : 0)) * motion;
      avatarGroup.rotation.z = Math.sin(now / 4700) * .022 * motion;
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
  $('lessonSpeech').textContent = 'Я рядом. Если нужна помощь, напиши своё задание.';
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
function chatMessage(role, text) {
  const box = document.createElement('p'); box.className = `chat-message ${role}`;
  const label = document.createElement('strong'); label.textContent = role === 'user' ? 'Ребёнок' : 'Помощник';
  const content = document.createElement('span'); content.textContent = text;
  box.append(label, content); $('tutorMessages').appendChild(box); box.scrollIntoView({block:'nearest'});
}
function cancelTutor() {
  helpEpoch++; questionCancel=true; questionAbort?.abort(); stopTracks(questionStream);
  tutorAbort?.abort(); tutorAbort = null; tutorBusy = false; stopAudio();
  if(currentJob) api('dialog-cancel',JSON.stringify({id:currentJob})).catch(()=>{});
  currentJob=null; controls();
}
async function askTutor(event) {
  event.preventDefault();
  const question = $('assignment').value.trim();
  if (!question || tutorBusy || questionRecording) return;
  $('assignment').value = '';
  await answerQuestion(question);
}
async function answerQuestion(question) {
  const epoch=++helpEpoch;
  chatMessage('user', question); stopAudio();
  tutorBusy=true; controls(); clearError();
  let displayed=false;
  try {
    await context().resume();
    $('tutorStatus').textContent='YandexGPT готовит подсказку…';
    const started=await api('dialog',JSON.stringify({question,level:$('schoolLevel').value,session:dialogId}));
    if(epoch!==helpEpoch) { await api('dialog-cancel',JSON.stringify({id:started.id})); return; }
    dialogId=started.session; currentJob=started.id;
    const deadline=performance.now()+660000;
    while(epoch===helpEpoch) {
      const result=await api('dialog/'+started.id);
      if(epoch!==helpEpoch) return;
      if(result.answer && !displayed) { displayed=true; chatMessage('assistant',result.answer); $('lessonSpeech').textContent=result.answer; }
      if(result.state==='done') {
        if(result.cues?.length) {
          const res=await fetch('/api/dialog-audio/'+started.id,{headers:{'X-App-Token':token}});
          if(!res.ok) throw new Error('Аудио ответа недоступно.');
          const buffer=await context().decodeAudioData(await res.arrayBuffer());
          if(epoch!==helpEpoch) return;
          beginAudio(buffer,result.answer,'answer',result.cues);
        }
        $('tutorStatus').textContent=result.warning || 'Твоя очередь — попробуй следующий шаг.';
        break;
      }
      if(result.state==='error') throw new Error(result.warning);
      if(result.state==='cancelled') break;
      $('tutorStatus').textContent=result.state==='speaking' ? 'XTTS озвучивает подсказку. Текст уже можно читать…' : 'YandexGPT готовит подсказку…';
      if(performance.now()>deadline) throw new Error('Ответ занял слишком много времени.');
      await sleep(800);
    }
  } catch(e) {
    if(epoch===helpEpoch) { fail(e); $('tutorStatus').textContent='Повторите вопрос или начните новое задание.'; }
  } finally { if(epoch===helpEpoch) { tutorBusy=false; currentJob=null; controls(); } }
}
async function voiceQuestion() {
  if(questionRecording) { questionStop=true; return; }
  questionRecording=true; questionStop=false; questionCancel=false;
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
  finally {source?.disconnect();node?.disconnect();stopTracks(mic);await ctx?.close();questionStream=null;questionRecording=false;controls();}
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
action('cancelScanBtn', () => { scanning = false; $('cameraHint').textContent = 'Сканирование отменено'; });
action('cancelVoiceBtn', async () => { await api('cancel', new Uint8Array()); await poll(); });
action('cameraBtn', async () => { connecting = true; controls(); try { if (stream) { stopCamera(); $('cameraHint').textContent = 'Камера выключена'; } else { await dependencies(); await enableCamera(); } } finally { connecting = false; controls(); } });
action('scanBtn', scan); action('recordBtn', record); action('generateBtn', async () => { await api('generate', new Uint8Array()); await poll(); });
action('testVoiceBtn', () => playVoice('preview')); action('startBtn', start); action('pauseBtn', pause); action('stopBtn', stop);
action('lessonVoiceBtn', () => playVoice('lesson')); action('stopSpeechBtn', stopAudio);
$('voiceQuestionBtn').addEventListener('click',()=>voiceQuestion().catch(fail));
$('hairStyle').addEventListener('change',()=>{
  localStorage.setItem('parentai-hair',$('hairStyle').value);
  if(avatarViews.length) {const front=[...avatarViews].sort((a,b)=>Math.abs(a.yaw)-Math.abs(b.yaw))[0];buildMesh(front.landmarks,front.canvas,avatarTopology,avatarViews);}
});
$('hairStyle').value=localStorage.getItem('parentai-hair') || 'short';
$('tutorForm').addEventListener('submit', askTutor);
$('cancelHelpBtn').addEventListener('click', cancelTutor);
$('clearHelpBtn').addEventListener('click', () => { cancelTutor(); dialogId=null; tutorHistory = []; $('tutorMessages').replaceChildren(); $('assignment').value = ''; });
window.addEventListener('popstate', () => { if (running) stop(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { recordCancelled = true; recordingAbort?.abort(); stopTracks(recordingStream); scanning = false; } if (document.hidden && running && !paused) { pause(); $('monitorStatus').textContent = 'Перерыв · окно скрыто'; } });
window.addEventListener('beforeunload', () => { stopTracks(recordingStream); stopAudio(); stopCamera(); detector?.close(); audioContext?.close(); });
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
    const front = [...views].sort((a,b)=>Math.abs(a.yaw||0)-Math.abs(b.yaw||0))[0];
    buildMesh(front.landmarks, front.canvas, vision.FaceLandmarker.FACE_LANDMARKS_TESSELATION, views);
    $('faceStatus').textContent = views.length === 3 ? 'Сохранённая 3D-голова' : 'Старая маска · лучше пересканировать';
    $('cameraHint').textContent = views.length === 3 ? 'Три ракурса загружены. Камера пока выключена.' : 'Для ушей и объёма пересканируйте голову по новой инструкции.';
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

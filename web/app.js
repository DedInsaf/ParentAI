import {Presence, encodeWav, withTimeout, requestUserCamera, speechOpening, scanQuality, scanTurnIssue, portraitQuality, faceYaw} from './core.mjs';
import {blinkAmount} from './head-geometry.mjs';
import {SpeechGate,isDirectedSpeech,classifySpeechRecognitionError} from './listening.mjs';
import {AvatarMotion} from './avatar-motion.mjs';
import {ModelAvatar} from './avatar-model.mjs';
import {LocalAvatar} from './local-avatar.mjs';
import {fitStablePortraitAnchors} from './portrait-fit.mjs';
import {portraitCutout} from './portrait-texture.mjs';
import {packPortraitAnalysis,unpackPortraitAnalysis} from './avatar-persistence.mjs';
const $ = id => document.getElementById(id);
const video = $('camera');
const fail = e => { $('error').hidden = false; $('error').textContent = e.message || String(e); };
const clearError = () => { $('error').hidden = true; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const requestId = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
let token, currentUser, authenticated = false, appStarted = false;
let status = {}, stream, detector, avatarTopology, THREE, renderer, scene, camera, mesh, avatarGroup, modelAvatar;
let audioContext, analyser, audioSource, pcm, playing = false, recording = false, scanning = false;
let running = false, paused = false, pausePending = false, lastFrame = -1, lastDetect = 0, lastResult = null, lastSeenFrame = 0;
let lastMediaTimestamp = -1;
let avatarDependenciesPromise,dependenciesPromise, detectError = false, connecting = false, playbackId = 0, audioKind = '';
const presence = new Presence();
const pendingActions = new Set();
let online = false, recordCancelled = false, recordingStream, recordingAbort, referenceRejected = false, previewUrl, renderTime = 0;
let referenceLoaded = false, voiceModeTouched = false;
let lessonStarted = 0, lessonElapsed = 0, tutorBusy = false, lessonCameraEnabled = false, lessonPresenceEnabled = false;
let activeCues=[], audioStarted=0, dialogId=null, studySessionId=null, lessonLimitSeconds=null, lessonLimitHandled=false, helpEpoch=0;
let questionRecording=false, questionStop=false, questionCancel=false, questionAbort, questionStream;
let currentJob=null;
let previewYaw=0,showWireframe=false,scanEpoch=0;
let scannerAbort=null,restoringAbort=null;
let listener=null,listenEpoch=0,echoUntil=0,followupUntil=0,listenerPending=false,cameraEpoch=0,cameraAbort;
const audioSources=new Set();let audioNext=0;
const avatarMotion=new AvatarMotion();let childSpeakingUntil=0;
const voiceBusy = () => ['generating', 'cancelling'].includes(status.voice);
const stopTracks = value => value?.getTracks().forEach(t => t.stop());
const cameraLive = () => !!stream?.getVideoTracks().some(track => track.readyState === 'live');
function mediaError(e) {
  const messages = {
    NotAllowedError: 'Доступ к камере или микрофону запрещён. Разрешите его для браузера в «Системные настройки → Конфиденциальность и безопасность», затем повторите.',
    SecurityError: 'Браузер заблокировал камеру или микрофон. Откройте Адым по локальному адресу из приложения и разрешите доступ.',
    NotFoundError: 'Камера или микрофон не найдены. Подключите устройство и повторите.',
    NotReadableError: 'Камера или микрофон заняты другим приложением. Закройте FaceTime, Zoom или другую программу и повторите.',
    AbortError: 'Камера или микрофон не смогли запуститься. Закройте другие приложения, использующие их, и повторите.',
    UnsupportedError: 'Камера недоступна в этом браузере. Откройте Адым по адресу localhost из приложения.',
  };
  return new Error(messages[e.name] || e.message);
}


async function api(path, body, retry = true, timeout = 15000, signal, operationId = requestId()) {
  const controller = new AbortController();
  const abort=()=>controller.abort();signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted)abort();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch('/api/' + path, {method: body === undefined ? 'GET' : 'POST',
      signal: controller.signal,
      headers: {'X-App-Token': token, 'X-Request-Id': operationId,
        ...(body !== undefined ? {'Content-Type': 'application/octet-stream'} : {})}, body});
    if (res.status === 403 && retry) {
      const session = await fetch('/api/session', {signal: controller.signal});
      if (!session.ok) throw new Error('Не удалось восстановить подключение');
      ({token} = await session.json());
      return api(path, body, false, timeout,signal,operationId);
    }
    const data = await res.json();
    if (res.status === 401) {
      authenticated = false;
      location.reload();
      throw new Error(data.error || 'Сессия завершена. Войдите снова.');
    }
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
  $('pauseBtn').disabled = !running || transition || (paused && (!online || pausePending));
  $('stopBtn').disabled = !running;
  $('retryCameraBtn').hidden = !running || paused || cameraLive();
  $('retryCameraBtn').disabled = !running || paused || pendingActions.has('retryCameraBtn');
  $('lessonVoiceBtn').disabled = !running || paused || tutorBusy || questionRecording || !(status.phrases?.length);
  $('stopSpeechBtn').disabled = !playing;
  $('askBtn').disabled = tutorBusy || questionRecording || listenerPending || !online || !status.tutor?.enabled;
  $('voiceQuestionBtn').disabled = !running || paused || !online || tutorBusy || listenerPending || !status.speech?.enabled;
  $('handsFree').disabled=!status.speech?.enabled && !listener;
  $('voiceQuestionBtn').textContent = questionRecording ? 'Закончить вопрос' : 'Записать вопрос';
  $('readyHandsFree').disabled=running || !status.speech?.enabled;
  $('readyMicHint').textContent=status.speech?.enabled
    ?`После начала микрофон будет заметен над аватаром. Распознавание: ${status.speech.provider}${status.speech.fallback?` · резерв: ${status.speech.fallback}`:''}.`
    :'Голосовые вопросы пока не подключены. Можно написать вопрос; родителю нужно установить локальную модель или настроить SpeechKit.';
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
    status = await api('status');
    if(pausePending&&running&&paused&&studySessionId){
      const session=await api('study-session',JSON.stringify({action:'pause',id:studySessionId}));
      lessonElapsed=Number(session.elapsed_seconds||0)*1000;lessonLimitSeconds=session.limit_seconds;
      pausePending=false;$('monitorStatus').textContent='Перерыв · связь восстановлена, таймер остановлен';
    }
    online = true;
    $('connection').textContent = 'Подключено';
    $('ttsStatus').textContent = `Клонирование: ${status.voice_engine?.message || status.tts}`;
    $('assetsStatus').textContent = `Распознавание: ${status.assets}`;
    const cloneOption=$('voiceMode').querySelector('option[value="clone"]');
    const parentReplyOption=$('replyVoice').querySelector('option[value="parent"]');
    cloneOption.disabled=!status.xtts_enabled;
    parentReplyOption.disabled=!status.xtts_enabled;
    cloneOption.textContent=status.xtts_enabled?'Напоминания и новые ответы моим голосом':'Голос родителя отключён в конфигурации';
    parentReplyOption.textContent=status.xtts_enabled?'Голос родителя · основной':'Голос родителя · отключён в конфигурации';
    // PRODUCT INVARIANT: never switch replyVoice to Yandex automatically.
    // A provider voice is allowed only after an explicit parent selection;
    // otherwise a failure stays visible instead of impersonating the parent.
    if(!status.xtts_enabled&&$('voiceMode').value==='clone'){$('voiceMode').value='direct';updateVoiceMode();}
    renderParentSummary(status.usage);
    renderSubscription(status.usage, status.billing);
    if (!tutorBusy && !questionRecording) $('tutorStatus').textContent = status.tutor?.enabled?'Скажи «помоги» или напиши вопрос. Будем пробовать по шагам.':'Помощник ещё не подключён. Попроси родителя настроить Яндекс.';
    if (!recording) $('voiceHint').textContent = status.error || status.progress || (status.phrases.length ? 'Сохранённый голос готов. Можно начать занятие.' : 'Выберите способ записи голоса.');
    if (status.reference && !referenceLoaded && !recording) {
      $('reference').src = '/audio/reference.wav'; $('reference').hidden = false; referenceLoaded = true;
      if (!voiceModeTouched) { $('voiceMode').value = status.reference_mode; updateVoiceMode(); }
    }
  } catch {
    online = false; $('connection').textContent = 'Нет связи · переподключение…';
    if (running && !paused) { try { await pause(); } catch {} }
  } finally { controls(); }
}
function renderParentSummary(value) {
  if (!value || !$('planName')) return;
  $('planName').textContent = value.plan.title;
  $('summaryAssignments').textContent = value.report.assignments;
  $('summaryHints').textContent = value.report.hints;
  $('summaryIndependent').textContent = value.report.solved_independently;
  $('summaryDifficult').textContent = value.report.difficult;
  $('summaryToday').textContent = `${Number(value.usage.today_cost_rubles).toFixed(2)} ₽`;
  $('summaryCost').textContent = `${Number(value.usage.external_cost_rubles).toFixed(2)} ₽`;
  $('summaryRemaining').textContent = value.plan.unlimited ? 'Без ограничений' :
    `${value.remaining.sessions} занятий · ${value.remaining.assignments} новых задач`;
  $('summaryText').textContent = value.report.summary;
}
function renderSubscription(summary, billing) {
  if (!summary || !billing || !$('currentPlanHero')) return;
  const current = summary.plan.code;
  const free = billing.plans?.free || {};
  const paid = billing.plans?.paid || {};
  const ultra = billing.plans?.ultra || {};
  const planTitle = summary.plan.unlimited ? 'Admin' : summary.plan.title;
  $('headerPlanName').textContent = planTitle;
  $('billingBtn').setAttribute('aria-label', `Тариф: ${planTitle}. Открыть информацию о подписке`);
  $('currentPlanHero').textContent = summary.plan.unlimited ? 'Admin · без ограничений' : `Сейчас: ${summary.plan.title}`;
  for (const [prefix, plan, defaults] of [
    ['free', free, [5,20,3,3,150]], ['paid', paid, [20,30,3,10,3600]], ['ultra', ultra, [45,45,4,20,9000]],
  ]) {
    $(`${prefix}Sessions`).textContent = plan.sessions ?? defaults[0];
    $(`${prefix}Minutes`).textContent = plan.session_minutes ?? defaults[1];
    $(`${prefix}Tasks`).textContent = plan.assignments_per_session ?? defaults[2];
    $(`${prefix}Voice`).textContent = plan.yandex_voice_per_session ?? defaults[3];
    const fallbackSeconds=plan.stt_billed_seconds ?? defaults[4],fallbackMinutes=fallbackSeconds/60;
    $(`${prefix}SpeechFallback`).textContent=`${Number.isInteger(fallbackMinutes)?fallbackMinutes:String(fallbackMinutes).replace('.',',')} мин`;
  }
  $('paidPrice').textContent = paid.monthly_price_rubles ?? 490;
  $('ultraPrice').textContent = ultra.monthly_price_rubles ?? 990;
  $('freePlanCard').classList.toggle('is-current', current === 'free');
  $('paidPlanCard').classList.toggle('is-current', current === 'paid');
  $('ultraPlanCard').classList.toggle('is-current', current === 'ultra');
  $('freePlanState').textContent = current === 'free' ? 'Текущий тариф' : 'Базовый тариф';
  $('freePlanBtn').textContent = current === 'free' ? 'Текущий тариф' : 'Free';
  const button = $('buyPaidBtn'), ultraButton = $('buyUltraBtn');
  const waiting = ['pending','subscription_activated'].includes(summary.payment?.status);
  const hasPaidPlan = current === 'paid' || current === 'ultra';
  button.disabled = summary.plan.unlimited || hasPaidPlan || waiting || !billing.provider?.enabled;
  ultraButton.disabled = summary.plan.unlimited || hasPaidPlan || waiting || !billing.provider?.enabled;
  button.textContent = summary.plan.unlimited ? 'У вас доступ без ограничений' : current === 'paid' ?
    'Подписка активна' : hasPaidPlan ? 'Смена тарифа — через поддержку' : waiting ? 'Ожидаем подтверждение Platega' :
    `Оформить за ${paid.monthly_price_rubles ?? 490} ₽/месяц`;
  ultraButton.textContent = summary.plan.unlimited ? 'У вас доступ без ограничений' : current === 'ultra' ?
    'Подписка активна' : hasPaidPlan ? 'Смена тарифа — через поддержку' : waiting ? 'Ожидаем подтверждение Platega' :
    `Оформить за ${ultra.monthly_price_rubles ?? 990} ₽/месяц`;
  if (!billing.provider?.enabled && current === 'free') {
    $('billingMessage').textContent = 'Кнопка покупки готова. Чтобы принимать оплату, добавьте Merchant ID и API-ключ Platega в настройки сервера.';
  } else if (waiting) {
    $('billingMessage').textContent = 'Подписка создана в Platega и ожидает подтверждения. Нажмите кнопку ещё раз, чтобы вернуться к оплате.';
    (summary.payment?.plan === 'ultra' ? ultraButton : button).disabled = false;
  } else if (current === 'paid' || current === 'ultra') {
    $('billingMessage').textContent = `${summary.plan.title} активен. Чтобы сменить тариф без двойного списания, сначала отмените текущую подписку через Platega или напишите в поддержку.`;
  } else if (summary.plan.unlimited) {
    $('billingMessage').textContent = 'Администратор тестирует все возможности продукта без тарифных ограничений.';
  } else {
    $('billingMessage').textContent = 'Оплата проходит на защищённой странице Platega через СБП. Списание повторяется раз в месяц; отменить подписку можно по ссылке из письма Platega.';
  }
}
async function pollLoop() {
  if (!authenticated) return;
  try { await poll(); }
  finally { if (authenticated) setTimeout(pollLoop, 2000); }
}

async function avatarDependencies(){
  if(!avatarDependenciesPromise)avatarDependenciesPromise=(async()=>{
    const [three, vision] = await Promise.all([
      import('./vendor/three.module.js'),
      import('./vendor/vision/vision_bundle.mjs'),
    ]);
    THREE=three;avatarTopology=vision.FaceLandmarker.FACE_LANDMARKS_TESSELATION;
    if(!renderer)initScene();return vision;
  })().catch(error=>{avatarDependenciesPromise=null;throw error;});
  return avatarDependenciesPromise;
}
async function dependencies() {
  if (!dependenciesPromise) dependenciesPromise = (async () => {
    $('cameraHint').textContent = 'Загрузка распознавания лица…';
    const vision=await avatarDependencies();
    const files = await vision.FilesetResolver.forVisionTasks('/vendor/vision/wasm');
    const options = {baseOptions: {modelAssetPath: '/vendor/vision/face_landmarker.task', delegate: 'GPU'}, runningMode: 'VIDEO', numFaces: 2};
    try { detector = await vision.FaceLandmarker.createFromOptions(files, options); }
    catch { options.baseOptions.delegate = 'CPU'; detector = await vision.FaceLandmarker.createFromOptions(files, options); }
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
  if (cameraLive()) {
    if (video.srcObject !== stream) video.srcObject = stream;
    await withTimeout(video.play(),10000);
    lastSeenFrame=performance.now();detectError=false;controls();return;
  }
  stopCamera(); const epoch=cameraEpoch;cameraAbort=new AbortController();
  let candidate;
  try {
    candidate=await requestUserCamera(navigator.mediaDevices,stopTracks,cameraAbort.signal);
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
  if(!$('avatarConsent').checked){$('avatarConsent').focus();throw new Error('Разрешите Адым создать аватар из снимков на этом устройстве.');}
  stopAudio();scanning=true;const epoch=++scanEpoch,abort=new AbortController();scannerAbort=abort;restoringAbort?.abort();
  $('scannerDialog').showModal();$('scannerCamera').appendChild(video.closest('.camera-frame'));controls();
  try {
    scanInstruction('Подключаем камеру. Сядьте лицом к свету, чтобы волосы и уши были видны.');
    await Promise.all([enableCamera(),dependencies()]);
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
    stopCamera();scanInstruction('Все снимки готовы. Несколько раз проверяем волосы, шею и одежду. Это может занять до 30 секунд.',true);
    $('captureStep').textContent='Анализ снимков';$('captureCountdown').textContent='';
    const front=views.find(view=>view.role==='front'),portrait=views.find(view=>view.role==='portrait');
    front.anchors=await fitPortrait(front,message=>scanInstruction(message),abort.signal);
    if(portrait){
      scanInstruction('Отдельно уточняем шею, футболку и края плеч.',true);
      portrait.anchors=await fitPortrait(portrait,message=>scanInstruction(message),abort.signal);
    }
    if(epoch!==scanEpoch)return;
    scanInstruction('Создаём объёмную модель прямо на устройстве.',true);
    const model=LocalAvatar.create(THREE,views,avatarTopology);
    try {await api('avatar',JSON.stringify({version:7,views:views.map(({role,yaw,landmarks,photo})=>({role,yaw,landmarks,photo})),anchors:(portrait||front).anchors,portraitAnalysis:packPortraitAnalysis(portrait||front)}),true,60000,abort.signal);}
    catch(error){model.dispose();throw error;}
    if(epoch!==scanEpoch){model.dispose();return;}
    installModel(model);showPortraitCutout(portrait||front);cancelScan();
    $('faceStatus').textContent='Черновик 3D-аватара создан';$('cameraHint').textContent='Черновик сохранён на этом устройстве. Проверьте лицо, волосы, шею и поворот.';
    scanInstruction('Черновик аватара создан и сохранён. Фотографии никуда не отправлялись.',true);
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
async function fitPortrait(view,onProgress=()=>{},signal) {
  let worker,bitmap;
  try {
    bitmap=await createImageBitmap(view.canvas);
    const mask=await new Promise((resolve,reject)=>{
      if(signal?.aborted){reject(new DOMException('Сканирование отменено','AbortError'));return;}
      worker=new Worker('/portrait-worker.js');
      const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',cancel);};
      const cancel=()=>{cleanup();worker.terminate();reject(new DOMException('Сканирование отменено','AbortError'));};
      const timer=setTimeout(()=>{cleanup();reject(new Error('Обработка снимка заняла слишком долго. Попробуйте ещё раз.'));},90000);
      signal?.addEventListener('abort',cancel,{once:true});
      worker.onmessage=({data})=>{if(data.progress){onProgress(data.message);return;}cleanup();data.error?reject(new Error(data.error)):resolve(data);};
      worker.onerror=event=>{cleanup();reject(new Error(event.message||'Контур не найден'));};
      try {worker.postMessage(bitmap,[bitmap]);} catch(error){cleanup();reject(error);}
    });
    view.segmentation=mask;
    view.matte=mask.matte;
    return fitStablePortraitAnchors(view.landmarks,mask);
  }
  finally {worker?.terminate();bitmap?.close();}
}
function showPortraitCutout(view){
  $('cutoutImage').src=portraitCutout(view).toDataURL('image/png');$('cutoutPreview').hidden=false;
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
  lessonCameraEnabled = $('readyCamera').checked;
  if (lessonCameraEnabled) {
    try {
      await enableCamera();
      if(document.hidden || !cameraLive()) throw new Error('Подключение занятия отменено.');
    } catch(error){stopCamera();stopHandsFree();throw error;}
  } else {
    stopCamera();
    $('monitorStatus').textContent = 'Камера выключена родителем';
  }
  let study;
  try { study = await api('study-session', JSON.stringify({action:'start'})); }
  catch(error){stopCamera();throw error;}
  studySessionId=study.id;lessonLimitSeconds=study.limit_seconds;lessonLimitHandled=false;pausePending=false;dialogId=null;
  stopAudio(); running = true; paused = false; presence.reset(); lessonElapsed = Number(study.elapsed_seconds||0)*1000; lessonStarted = performance.now(); showLesson();
  if(lessonCameraEnabled) startLessonPresence();
  else $('monitorStatus').textContent='Камера выключена родителем';
  controls();
  if($('replyVoice').value==='parent') api('voice-warm',new Uint8Array()).catch(()=>{});
  startHandsFree().catch(fail);
  try { await playVoice('lesson'); } catch(e) { fail(e); }
}
async function pause() {
  stopAudio(); cancelTutor();stopHandsFree();
  if (!paused) {
    const localElapsed=lessonElapsed+performance.now()-lessonStarted;
    try {
      const session=await api('study-session',JSON.stringify({action:'pause',id:studySessionId}));
      lessonElapsed=Number(session.elapsed_seconds||0)*1000;lessonLimitSeconds=session.limit_seconds;pausePending=false;
    } catch(error) {
      lessonElapsed=localElapsed;
      paused = true;pausePending=true; lessonPresenceEnabled=false;document.body.classList.add('on-break');stopCamera();setListenerState('off','Перерыв. Камера и микрофон выключены.'); $('pauseBtn').textContent = 'Продолжить занятие'; $('monitorStatus').textContent = 'Перерыв локально · ждём связь с приложением';
      controls();
      throw error;
    }
    paused = true; lessonPresenceEnabled=false;document.body.classList.add('on-break');stopCamera();setListenerState('off','Перерыв. Камера и микрофон выключены.'); $('pauseBtn').textContent = 'Продолжить занятие'; $('monitorStatus').textContent = 'Перерыв · камера выключена';
  } else {
    // Reconnect the camera before resuming the server clock. If permission or
    // the device fails, the paid lesson time remains paused.
    if (lessonCameraEnabled) await enableCamera();
    let session;
    try { session=await api('study-session',JSON.stringify({action:'resume',id:studySessionId})); }
    catch(error){if(lessonCameraEnabled)stopCamera();throw error;}
    lessonElapsed=Number(session.elapsed_seconds||0)*1000;lessonLimitSeconds=session.limit_seconds;
    presence.reset(); paused = false;document.body.classList.remove('on-break'); lessonStarted = performance.now(); $('pauseBtn').textContent = 'Сделать перерыв';if(lessonCameraEnabled)startLessonPresence();startHandsFree().catch(fail);
  }
  controls();
}
function stop(message='Занятие завершено · камера выключена',notifyServer=true) { const session=studySessionId;studySessionId=null;if(session&&notifyServer)api('study-session',JSON.stringify({action:'stop',id:session})).catch(()=>{});stopHandsFree();api('voice-release',new Uint8Array()).catch(()=>{});running = false; paused = false;pausePending=false;dialogId=null;lessonCameraEnabled=false;lessonPresenceEnabled=false;document.body.classList.remove('on-break'); stopAudio(); stopCamera(); cancelTutor(); presence.reset(); $('pauseBtn').textContent = 'Сделать перерыв'; $('monitorStatus').textContent = message; showSetup(); controls(); }
function startLessonPresence() {
  lessonPresenceEnabled=!!detector;
  $('monitorStatus').textContent=lessonPresenceEnabled?'Камера включена · ищем лицо':'Камера включена · запускаем проверку лица';
  if(lessonPresenceEnabled)return;
  dependencies().then(()=>{
    if(!running||paused||!lessonCameraEnabled||!cameraLive())return;
    lessonPresenceEnabled=true;lastFrame=-1;presence.reset();$('monitorStatus').textContent='Камера включена · ищем лицо';
  }).catch(()=>{
    if(running&&!paused&&lessonCameraEnabled&&cameraLive())$('monitorStatus').textContent='Камера включена · проверка лица временно недоступна';
  });
}
async function reconnectLessonCamera() {
  if (!running || paused) return;
  lessonCameraEnabled=true;$('readyCamera').checked=true;
  $('monitorStatus').textContent='Подключаем камеру…';controls();
  try {
    await enableCamera();
    if(!cameraLive()) throw new Error('Камера не передаёт изображение. Повторите подключение.');
    detectError=false;presence.reset();startLessonPresence();
  } catch(error) {
    lessonCameraEnabled=false;lessonPresenceEnabled=false;stopCamera();$('monitorStatus').textContent='Камера не подключена';throw error;
  } finally {controls();}
}
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
  if (running && !paused && !scanning && lessonCameraEnabled) {
    try {
      if (!cameraLive() || video.readyState < 2) throw new Error('Камера перестала передавать изображение. Нажмите «Продолжить», чтобы подключить её снова.');
      if(lessonPresenceEnabled){
        const result = landmarks(now);
        if (now - lastSeenFrame > 3000) throw new Error('Камера перестала передавать изображение. Нажмите «Продолжить», чтобы подключить её снова.');
        const found = result?.faceLandmarks?.length > 0;
        const current = presence.update(found, now / 1000);
        $('monitorStatus').textContent = {present:'Лицо в кадре · занятие идёт',missing:'Лицо вне кадра · ждём возвращения',absent:'Пора вернуться к занятию',returning:'С возвращением'}[current.state];
        if (found && audioKind === 'reminder') stopAudio();
        if (current.remind && !tutorBusy && !questionRecording && !listenerPending && now>childSpeakingUntil && !playing) reminder();
      }
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
    const limit = Number.isFinite(lessonLimitSeconds) ? lessonLimitSeconds : null;
    const left = limit === null ? null : Math.max(0, limit-seconds);
    const shown = left === null ? seconds : left;
    $('lessonClock').textContent = `${left === null ? '' : 'осталось '}${String(Math.floor(shown/60)).padStart(2,'0')}:${String(shown%60).padStart(2,'0')}`;
    if(left === 0 && !lessonLimitHandled){lessonLimitHandled=true;stop('Время занятия закончилось · можно начать следующее');fail(new Error('Время занятия закончилось. Перерыв в лимит не входил.'));}
  }
}
function showLesson() {
  $('lessonAvatarSlot').appendChild($('scene'));
  $('lessonCameraSlot').appendChild(video.closest('.camera-frame'));
  $('setupPage').hidden = true; $('lessonPage').hidden = false;
  document.body.classList.add('in-lesson');$('lessonToolbar').hidden=false;
  document.querySelector('h1').textContent = 'Сделаем следующий шаг вместе';
  $('lessonSpeech').textContent = 'Я рядом. Скажи «помоги» и расскажи, что не получается.';
  $('micIntro').hidden=!$('handsFree').checked || !status.speech?.enabled;
  setListenerState('off','Микрофон ещё не включён. Можно написать вопрос.');
  history.pushState({lesson:true}, '', '#lesson');
  requestAnimationFrame(fit); window.scrollTo(0,0);
}
function showSetup() {
  $('setupAvatarSlot').appendChild($('scene'));
  $('setupCameraSlot').appendChild(video.closest('.camera-frame'));
  $('readyCameraPreview').hidden=true;
  $('lessonPage').hidden = true; $('setupPage').hidden = false;
  document.body.classList.remove('in-lesson');$('lessonToolbar').hidden=true;
  document.querySelector('h1').textContent = 'Шаг за шагом к самостоятельности';
  if (location.hash) history.replaceState({}, '', location.pathname + location.search);
  requestAnimationFrame(fit); window.scrollTo(0,0);
}
function closeReadyCameraPreview(uncheck=false) {
  if (!running && !scanning) stopCamera();
  $('setupCameraSlot').appendChild(video.closest('.camera-frame'));
  $('readyCameraPreview').hidden=true;
  if(uncheck)$('readyCamera').checked=false;
}
async function showReadyCameraPreview() {
  $('readyCameraPreview').hidden=false;
  $('readyCameraStatus').textContent='Подключаем камеру…';
  $('readyCameraSlot').appendChild(video.closest('.camera-frame'));
  try {
    await enableCamera();
    $('readyCameraStatus').textContent='Камера работает. Это изображение остаётся на устройстве.';
  } catch(error) {
    // A temporary permission/device error must not silently opt the lesson out
    // of camera use. Keep the parent's choice and retry when Start is pressed.
    stopCamera();
    $('readyCameraStatus').textContent='Камера пока не подключилась. Проверьте разрешение — при начале занятия попробуем ещё раз.';
    throw error;
  }
}
function setupStep(step) {
  if(scanning || recording) return;
  const content={face:['Давайте создадим ваш образ','Сканер создаст объёмный аватар по снимкам лица. Готовый образ появится здесь автоматически.'],voice:['Знакомый голос — спокойнее учиться','Запишите образец в тихой комнате, затем прослушайте результат.'],ready:['Устроимся поудобнее','Посадите ребёнка перед камерой и начните. Вопросы можно задавать голосом или текстом.']};
  if(!content[step]) return;
  closeReadyCameraPreview(false);
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
    const started=await api('dialog',JSON.stringify({question,level:$('schoolLevel').value,session:dialogId,
      study_session:studySessionId,voice:$('replyVoice').value,request_id:requestId()}));
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
        $('tutorStatus').textContent=result.warning||result.limit_warning||'Твоя очередь — попробуй следующий шаг.';break;
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
    if(result.limit_warning)$('tutorStatus').textContent=result.limit_warning;
    if(listenId!==listenEpoch||epoch!==helpEpoch||!running||paused)return;
    if(isDirectedSpeech(result.text,performance.now()<followupUntil))await answerQuestion(result.text);
    else setListenerState('listening','Скажи «помоги» и задай вопрос.');
  }catch(e){
    if(listenId!==listenEpoch||epoch!==helpEpoch)return;
    const failure=classifySpeechRecognitionError(e);
    if(failure.stop){$('handsFree').checked=false;stopHandsFree();setListenerState('error',failure.message);fail(new Error(failure.message));}
    else setListenerState('listening',failure.message);
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
    if(result.limit_warning)$('tutorStatus').textContent=result.limit_warning;
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
action('retryCameraBtn', reconnectLessonCamera);
action('lessonVoiceBtn', () => playVoice('lesson')); action('stopSpeechBtn', cancelTutor);
$('handsFree').addEventListener('change',()=>{clearError();$('readyHandsFree').checked=$('handsFree').checked;startHandsFree().catch(fail);});
$('readyHandsFree').addEventListener('change',()=>{$('handsFree').checked=$('readyHandsFree').checked;});
$('readyCamera').addEventListener('change',async()=>{
  clearError();$('readyCamera').disabled=true;
  try {
    if($('readyCamera').checked)await showReadyCameraPreview();
    else closeReadyCameraPreview(false);
  } catch(error){fail(error);}
  finally{$('readyCamera').disabled=false;controls();}
});
$('closeReadyCameraBtn').addEventListener('click',()=>closeReadyCameraPreview(true));
action('dismissMicIntroBtn',()=>{$('micIntro').hidden=true;});
document.querySelector('.app-header .brand').addEventListener('click',event=>{event.preventDefault();if(running)stop();setupStep('face');});
$('replyVoice').addEventListener('change',()=>{if(running&&$('replyVoice').value==='parent')api('voice-warm',new Uint8Array()).catch(()=>{});});
$('voiceQuestionBtn').addEventListener('click',()=>voiceQuestion().catch(fail));
$('scanAudio').addEventListener('change',()=>{if(!$('scanAudio').checked) window.speechSynthesis?.cancel();});
document.querySelectorAll('[data-setup-step]').forEach(button=>button.addEventListener('click',()=>setupStep(button.dataset.setupStep)));
action('nextVoiceBtn',()=>setupStep('voice'));action('nextReadyBtn',()=>setupStep('ready'));
action('viewFrontBtn',()=>{previewYaw=0;});action('viewSideBtn',()=>{previewYaw=.11;});
action('previewMotionBtn',()=>playVoice('preview'));
action('viewMeshBtn',()=>{showWireframe=!showWireframe;applyModelView();});
$('tutorForm').addEventListener('submit', askTutor);
$('cancelHelpBtn').addEventListener('click', cancelTutor);
$('clearHelpBtn').addEventListener('click', () => { cancelTutor(); dialogId=null;followupUntil=0; $('tutorMessages').replaceChildren(); $('assignment').value = ''; });
window.addEventListener('popstate', () => { if (running) stop(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { recordCancelled = true; recordingAbort?.abort(); stopTracks(recordingStream);if(scanning)cancelScan();window.speechSynthesis?.cancel();stopHandsFree();stopCamera(); } if (document.hidden && running && !paused) { pause().catch(()=>{}); $('monitorStatus').textContent = 'Перерыв · окно скрыто'; } });
window.addEventListener('beforeunload', () => {
  if(running&&!paused&&studySessionId)fetch('/api/study-session',{method:'POST',keepalive:true,headers:{'X-App-Token':token,'Content-Type':'application/json'},body:JSON.stringify({action:'pause',id:studySessionId})}).catch(()=>{});
  stopHandsFree();stopTracks(questionStream);stopTracks(recordingStream);stopAudio(); stopCamera(); scannerAbort?.abort();restoringAbort?.abort();modelAvatar?.dispose();detector?.close(); audioContext?.close();
});
async function restoreAvatar() {
  const restoringEpoch=scanEpoch,abort=new AbortController();restoringAbort=abort;
  try {
    const saved=await api('avatar');if(!saved||restoringEpoch!==scanEpoch)return;
    if(saved.version===7){
      $('faceStatus').textContent='Восстанавливаем локальный аватар…';await avatarDependencies();
      const views=await Promise.all(saved.views.map(async view=>{const image=new Image();image.src=view.photo;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;canvas.getContext('2d').drawImage(image,0,0);return {...view,canvas,anchors:view.role==='portrait'?saved.anchors:undefined};}));
      const front=views.find(view=>view.role==='front'),portrait=views.find(view=>view.role==='portrait');
      const bust=portrait||front;
      if(saved.portraitAnalysis){const analysis=unpackPortraitAnalysis(saved.portraitAnalysis);bust.segmentation=analysis.segmentation;bust.matte=analysis.matte;}
      else {
        await dependencies();bust.anchors=await fitPortrait(bust,message=>{if(restoringEpoch===scanEpoch)$('faceStatus').textContent='Проверяем сохранённый силуэт: '+message.toLowerCase();},abort.signal);
        saved.anchors=bust.anchors;saved.portraitAnalysis=packPortraitAnalysis(bust);
        await api('avatar',JSON.stringify(saved),true,60000,abort.signal);
      }
      if(restoringEpoch!==scanEpoch)return;
      installModel(LocalAvatar.create(THREE,views,avatarTopology));
      showPortraitCutout(portrait||front);
      $('faceStatus').textContent='Черновик 3D-аватара загружен';$('cameraHint').textContent='Черновик хранится на этом устройстве и доступен после перезапуска.';return;
    }
    if(saved.version!==6){
      $('faceStatus').textContent='Нужен новый скан';
      $('cameraHint').textContent='Ваш прежний снимок сохранён. Для локального объёмного аватара создайте новый образ через сканер.';
      return;
    }
    $('faceStatus').textContent='Восстанавливаем ваш аватар…';await renderDependencies();
    const response=await fetch('/api/avatar-model',{headers:{'X-App-Token':token}});
    if(!response.ok)throw new Error('Не удалось загрузить сохранённый аватар. Повторите сканирование.');
    const model=await ModelAvatar.create(THREE,await response.arrayBuffer());
    if(restoringEpoch!==scanEpoch){model.dispose();return;}
    installModel(model);
    $('faceStatus').textContent='Ваш 3D-аватар загружен';
    $('cameraHint').textContent='Аватар сохранён. Сканировать заново не нужно.';
  } catch(error){if(restoringEpoch===scanEpoch){$('faceStatus').textContent='Не удалось восстановить аватар';fail(error);}}
  finally{if(restoringAbort===abort)restoringAbort=null;controls();}
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

function authMode(mode) {
  const login = mode === 'login';
  $('loginForm').hidden = !login;
  $('registerForm').hidden = login;
  $('loginTab').setAttribute('aria-selected', String(login));
  $('registerTab').setAttribute('aria-selected', String(!login));
  $('authError').hidden = true;
  requestAnimationFrame(() => $(login ? 'loginIdentifier' : 'registerLogin').focus());
}

function authBusy(form, busy) {
  for (const control of form.elements) control.disabled = busy;
  const button = form.querySelector('button[type=submit]');
  if (button) {
    if (!button.dataset.label) button.dataset.label = button.textContent;
    button.textContent = busy ? 'Подождите…' : button.dataset.label;
  }
}

async function authRequest(path, values) {
  const response = await fetch('/api/auth/' + path, {
    method: 'POST',
    headers: {'X-App-Token': token, 'Content-Type': 'application/json'},
    body: JSON.stringify(values),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Ошибка ${response.status}`);
  return data;
}

async function startApplication() {
  if (appStarted) return;
  appStarted = true;
  refreshMicrophones();
  if (location.hash === '#lesson') history.replaceState({}, '', location.pathname + location.search);
  updateVoiceMode(); controls(); requestAnimationFrame(tick);
  try { await poll(); await restoreAvatar(); }
  catch (error) { online = false; fail(error); }
  pollLoop();
}

function showApplication(user) {
  currentUser = user;
  authenticated = true;
  $('accountLogin').textContent = user.is_admin ? `${user.login} · Админ` : user.login;
  $('authPage').hidden = true;
  document.querySelector('.app-header').hidden = false;
  $('setupPage').hidden = false;
  document.body.classList.remove('auth-pending');
  startApplication();
}

$('loginTab').addEventListener('click', () => authMode('login'));
$('registerTab').addEventListener('click', () => authMode('register'));
$('authPaidBtn').addEventListener('click', () => authMode('register'));
$('billingBtn').addEventListener('click', () => $('billingDialog').showModal());
$('closeBillingBtn').addEventListener('click', () => {$('billingDialog').close(); $('billingBtn').focus();});
$('billingDialog').addEventListener('click', event => {if (event.target === $('billingDialog')) $('billingDialog').close();});
document.querySelector('.auth-brand').addEventListener('click', event => event.preventDefault());
for (const [formId, path] of [['loginForm', 'login'], ['registerForm', 'register']]) {
  $(formId).addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    $('authError').hidden = true;
    if (formId === 'registerForm' && $('registerPassword').value !== $('registerPasswordConfirmation').value) {
      $('authError').textContent = 'Пароли не совпадают.';
      $('authError').hidden = false;
      $('registerPasswordConfirmation').focus();
      return;
    }
    const values = Object.fromEntries(new FormData(form));
    authBusy(form, true);
    try {
      const data = await authRequest(path, values);
      showApplication(data.user);
    } catch (error) {
      $('authError').textContent = error.message || String(error);
      $('authError').hidden = false;
    } finally { authBusy(form, false); }
  });
}
$('logoutBtn').addEventListener('click', async () => {
  $('logoutBtn').disabled = true;
  try {
    if(running&&studySessionId){
      const session=studySessionId;
      try { await api('study-session',JSON.stringify({action:'stop',id:session})); }
      catch {}
      stop('Занятие завершено · камера выключена',false);
    }
    await authRequest('logout', {});
  }
  finally { location.reload(); }
});
async function buyPlan(plan, buttonId) {
  clearError();
  pendingActions.add(buttonId); controls();
  try {
    const checkout = await api('billing/checkout', JSON.stringify({plan}), true, 30000);
    const target = new URL(checkout.redirect);
    if (target.protocol !== 'https:' || target.hostname !== 'pay.platega.io') throw new Error('Получена небезопасная ссылка оплаты.');
    location.assign(target.href);
  } catch (error) {
    fail(error);
  } finally {
    pendingActions.delete(buttonId); controls();
  }
}
$('buyPaidBtn').addEventListener('click', () => buyPlan('paid','buyPaidBtn'));
$('buyUltraBtn').addEventListener('click', () => buyPlan('ultra','buyUltraBtn'));

try {
  const response = await fetch('/api/session');
  if (!response.ok) throw new Error('Не удалось подключиться к приложению.');
  const session = await response.json();
  token = session.token;
  if (session.user) showApplication(session.user);
  else authMode('login');
} catch (error) {
  $('authError').textContent = error.message || String(error);
  $('authError').hidden = false;
}

import {Presence, encodeWav, withTimeout, fetchFailure, requestUserCamera, speechOpening, scanQuality, scanTurnIssue, portraitQuality, faceYaw} from './core.mjs';
import {blinkAmount} from './head-geometry.mjs';
import {SpeechGate,isDirectedSpeech,classifySpeechRecognitionError} from './listening.mjs';
import {AvatarMotion} from './avatar-motion.mjs';
import {ModelAvatar} from './avatar-model.mjs';
import {LocalAvatar} from './local-avatar.mjs';
import {fitStablePortraitAnchors,portraitAccessoryIssue} from './portrait-fit.mjs';
import {portraitCutout} from './portrait-texture.mjs';
import {packPortraitAnalysis,unpackPortraitAnalysis} from './avatar-persistence.mjs';
import {requestAuth} from './auth-client.mjs';
const $ = id => document.getElementById(id);
const video = $('camera');
const fail = e => { $('error').hidden = false; $('error').textContent = e.message || String(e); };
const clearError = () => { $('error').hidden = true; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const requestId = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
let token, currentUser, authenticated = false, appStarted = false;
const requestedPlan = new URLSearchParams(location.search).get('plan');
let status = {}, stream, detector, avatarTopology, THREE, renderer, scene, camera, mesh, avatarGroup, modelAvatar;
let audioContext, analyser, audioSource, pcm, playing = false, recording = false, scanning = false;
let browserUtterance = null, browserSpeechStarted = 0, browserSpeechFinish = null;
let running = false, paused = false, pausePending = false, lastFrame = -1, lastDetect = 0, lastResult = null, lastSeenFrame = 0;
let lessonTransition = null, resumeCancelled = false;
let lastMediaTimestamp = -1;
let avatarDependenciesPromise,dependenciesPromise, detectError = false, connecting = false, playbackId = 0, audioKind = '';
const presence = new Presence();
const pendingActions = new Set();
let billingNotice='';
let online = false, recordCancelled = false, recordingStream, recordingAbort, referenceRejected = false, previewUrl, renderTime = 0;
let referenceLoaded = false, voiceModeTouched = false, voiceTake = 1;
let lessonStarted = 0, lessonElapsed = 0, tutorBusy = false, lessonCameraEnabled = false, lessonPresenceEnabled = false;
let activeCues=[], audioStarted=0, dialogId=null, taskFinished=false, studySessionId=null, lessonLimitSeconds=null, lessonLimitHandled=false, helpEpoch=0;
let taskSwitchPending=null;
let questionRecording=false, questionStop=false, questionCancel=false, questionAbort, questionStream;
let currentJob=null;
let previewYaw=0,showWireframe=false,scanEpoch=0;
let scannerAbort=null,restoringAbort=null;
let listener=null,listenEpoch=0,echoUntil=0,followupUntil=0,listenerPending=false,cameraEpoch=0,cameraAbort;
const audioSources=new Set();let audioNext=0;
const avatarMotion=new AvatarMotion();let childSpeakingUntil=0;
const voiceBusy = () => ['generating', 'cancelling'].includes(status.voice);
const voiceTakeTexts = {
  1: 'Сегодня мы спокойно разберём задание по шагам. Сначала прочитаем условие, затем найдём главное и подумаем, с чего лучше начать. Не торопись, говори ясно и делай небольшие паузы.',
  2: 'У тебя хорошо получается. Даже если ответ не пришёл сразу, ничего страшного: попробуем ещё раз и обязательно найдём решение. Я рядом, верю в тебя и всегда готов помочь.',
  3: 'Пожалуйста, вернись к занятию и сядь перед камерой. Нам осталось совсем немного. Давай сосредоточимся, закончим это задание вместе, а потом ты сможешь отдохнуть.',
};
const stopTracks = value => value?.getTracks().forEach(t => t.stop());
const cameraLive = () => !!stream?.getVideoTracks().some(track => track.readyState === 'live');
function mediaError(e) {
  const messages = {
    NotAllowedError: 'Доступ к камере или микрофону запрещён. Разрешите его для браузера в «Системные настройки → Конфиденциальность и безопасность», затем повторите.',
    SecurityError: 'Браузер заблокировал камеру или микрофон. Откройте Адым по защищённому адресу HTTPS и разрешите доступ.',
    NotFoundError: 'Камера или микрофон не найдены. Подключите устройство и повторите.',
    NotReadableError: 'Камера или микрофон заняты другим приложением. Закройте FaceTime, Zoom или другую программу и повторите.',
    AbortError: 'Камера или микрофон не смогли запуститься. Закройте другие приложения, использующие их, и повторите.',
    UnsupportedError: 'Камера недоступна в этом браузере. Откройте Адым в актуальной версии Chrome, Edge или Safari.',
  };
  return new Error(messages[e.name] || e.message);
}


async function api(path, body, retry = true, timeout = 15000, signal, operationId = requestId()) {
  const controller = new AbortController();
  let timedOut = false;
  const abort=()=>controller.abort();signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted)abort();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
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
  } catch(error) {
    throw fetchFailure(error,path,timedOut,!!signal?.aborted);
  } finally { clearTimeout(timer);signal?.removeEventListener("abort",abort); }
}
function controls() {
  const transition = !!lessonTransition || pendingActions.has('startBtn') || pendingActions.has('pauseBtn');
  const directVoice = $('voiceMode').value === 'direct';
  const recordedTakes = status.reference_mode === 'clone' ? (status.reference_takes || []) : [];
  const selectedTakeRecorded = recordedTakes.includes(voiceTake);
  const samplesReady = directVoice || recordedTakes.length === 3;
  const voiceProfileReady = !!status.phrases?.length && status.voice === 'ready' &&
    status.reference_mode === $('voiceMode').value && samplesReady;
  $('scanBtn').disabled = !online || transition || !status.scanner?.enabled || scanning || running || recording || connecting;
  $('nextVoiceBtn').disabled=!mesh || scanning;
  $('scannerUnavailable').hidden=true;
  $('previewMotionBtn').disabled=!mesh || !status.phrases?.length || scanning || recording || running;
  $('nextVoiceTakeBtn').hidden = directVoice || voiceTake >= 3 || !selectedTakeRecorded;
  $('nextVoiceTakeBtn').disabled = recording || voiceBusy();
  $('nextVoiceTakeBtn').textContent = voiceTake === 1 ? 'Дальше: второй образец — поддерживаю →' : 'Дальше: третий образец — зову вернуться →';
  $('nextReadyBtn').hidden = !voiceProfileReady;
  $('nextReadyBtn').disabled=!voiceProfileReady || recording || voiceBusy();
  for(const id of ['viewFrontBtn','viewSideBtn']) $(id).disabled=!mesh || scanning;
  for(const button of document.querySelectorAll('[data-setup-step]')) button.disabled=scanning || recording || running;
  $('recordBtn').disabled = !online || transition || recording || scanning || running || voiceBusy();
  $('voiceMode').disabled = recording || running || voiceBusy();
  $('microphone').disabled = recording;
  $('generateBtn').disabled = !online || transition || recording || running || !status.reference || !samplesReady || referenceRejected || status.reference_mode !== $('voiceMode').value || voiceBusy();
  $('generateBtn').hidden = !directVoice && !samplesReady;
  $('generateBtn').textContent = $('voiceMode').value === 'direct' ? 'Сохранить напоминание' : 'Создать голос';
  $('testVoiceBtn').disabled = !online || !(status.phrases?.length) || recording || running;
  $('startBtn').disabled = !online || transition || !mesh || !(status.phrases?.length) || running || scanning || recording || voiceBusy();
  $('pauseBtn').disabled = !running || transition || (paused && (!online || pausePending));
  $('stopBtn').disabled = !running;
  $('retryCameraBtn').hidden = !running || cameraLive();
  $('retryCameraBtn').disabled = !running || transition || pendingActions.has('retryCameraBtn');
  $('lessonVoiceBtn').disabled = !running || paused || tutorBusy || questionRecording || !(status.phrases?.length);
  $('stopSpeechBtn').disabled = !playing;
  $('askBtn').disabled = !running || paused || transition || tutorBusy || !!taskSwitchPending || questionRecording || listenerPending || !online || !status.tutor?.enabled;
  $('voiceQuestionBtn').disabled = !running || paused || !online || tutorBusy || !!taskSwitchPending || listenerPending || !status.speech?.enabled;
  $('handsFree').disabled=!status.speech?.enabled && !listener;
  $('voiceQuestionBtn').textContent = questionRecording ? 'Закончить вопрос' : 'Записать вопрос';
  $('readyHandsFree').disabled=running || !status.speech?.enabled;
  $('readyMicHint').textContent=status.speech?.enabled
    ?'После начала микрофон будет заметен над аватаром. Запись вопроса закончится автоматически после короткой паузы.'
    :'Голосовые вопросы временно недоступны. Вопрос можно написать текстом.';
  $('stopSpeechBtn').hidden=!playing;
  $('readyHandsFree').checked=$('handsFree').checked;
  $('faceNextHint').textContent=!mesh?'После создания аватара можно перейти к голосу.':'';
  $('voiceNextHint').textContent=voiceBusy()?'Готовим голос. Можно отменить и попробовать снова.':
    !directVoice && !selectedTakeRecorded?`Сначала запишите образец ${voiceTake} из 3.`:
    !directVoice && voiceTake < 3?'Прослушайте запись и нажмите кнопку перехода к следующему образцу.':
    !voiceProfileReady?'Все записи готовы. Теперь создайте и прослушайте общий голос.':'';
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
    if(pausePending&&running&&paused&&studySessionId&&!lessonTransition){
      await pause(true);
      if(running&&paused)$('monitorStatus').textContent='Перерыв · связь восстановлена, таймер остановлен';
    }
    online = true;
    $('connection').textContent = '';
    $('connection').hidden = true;
    $('ttsStatus').textContent = `Клонирование: ${status.voice_engine?.message || status.tts}`;
    $('assetsStatus').textContent = `Распознавание: ${status.assets}`;
    const cloneOption=$('voiceMode').querySelector('option[value="clone"]');
    const parentReplyOption=$('replyVoice').querySelector('option[value="parent"]');
    const cloneEnabled=status.voice_clone_enabled??status.xtts_enabled;
    const qwen=status.voice_provider==='qwen';
    cloneOption.disabled=!cloneEnabled;
    parentReplyOption.disabled=!cloneEnabled;
    cloneOption.textContent=cloneEnabled?(qwen?'Новые ответы моим голосом · Qwen, медленно':'Напоминания и новые ответы моим голосом'):'Новые ответы голосом родителя пока недоступны';
    parentReplyOption.textContent=cloneEnabled?(qwen?'Голос родителя · Qwen, 2–5 минут':'Голос родителя · основной'):'Голос родителя · недоступен';
    $('qwenWarning').hidden=!qwen;
    if(!cloneEnabled&&$('replyVoice').value==='parent'){
      $('replyVoice').value='yandex';
      $('replyVoiceHint').textContent='Адым озвучивает новые подсказки обычным голосом, а напоминания может произносить записью родителя.';
    }else if(qwen){
      $('replyVoiceHint').textContent='Qwen сохраняет голос родителя, но на тестовом сервере ответ может готовиться 2–5 минут. Голос Адым отвечает значительно быстрее.';
    }else if(cloneEnabled){
      $('replyVoiceHint').textContent='Можно выбрать голос родителя или обычный голос Адым.';
    }
    if(!cloneEnabled&&$('voiceMode').value==='clone'){$('voiceMode').value='direct';updateVoiceMode();}
    renderParentSummary(status.usage);
    renderSubscription(status.usage, status.billing);
    if (!tutorBusy && !questionRecording && !listenerPending) $('tutorStatus').textContent = running&&paused?'Занятие на паузе. Нажми «Продолжить занятие», когда будешь готов.':status.tutor?.enabled?'Задай вопрос голосом или напиши его. Будем пробовать по шагам.':'Подсказки временно недоступны. Попробуй немного позже.';
    renderVoiceTakes();
    if (!recording) $('voiceHint').textContent = status.error || status.progress || (status.phrases.length ? 'Сохранённый голос готов. Можно начать занятие.' : 'Выберите способ записи голоса.');
    if (status.reference && !referenceLoaded && !recording) {
      if (!voiceModeTouched) { $('voiceMode').value = status.reference_mode; updateVoiceMode(); }
      loadVoiceTake(voiceTake); referenceLoaded = true;
    }
  } catch {
    online = false; $('connection').hidden = false; $('connection').textContent = 'Нет связи · переподключаемся…';
    if (running && (!paused||lessonTransition)) { try { await pause(true); } catch {} }
  } finally { controls(); }
}
function renderParentSummary(value) {
  if (!value || !$('planName')) return;
  $('planName').textContent = value.plan.title;
  $('summaryAssignments').textContent = value.report.assignments;
  $('summaryHints').textContent = value.report.hints;
  $('summaryIndependent').textContent = value.report.solved_independently;
  $('summaryDifficult').textContent = value.report.difficult;
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
  const planTitle = summary.plan.unlimited ? 'Администратор' : summary.plan.title;
  $('headerPlanName').textContent = planTitle;
  $('billingBtn').setAttribute('aria-label', `Тариф: ${planTitle}. Открыть информацию о подписке`);
  $('currentPlanHero').textContent = summary.plan.unlimited ? 'Администратор · без ограничений' : `Сейчас: ${summary.plan.title}`;
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
  $('freePlanBtn').textContent = current === 'free' ? 'Текущий тариф' : 'Бесплатный';
  const button = $('buyPaidBtn'), ultraButton = $('buyUltraBtn');
  const waiting = ['pending','subscription_activated'].includes(summary.payment?.status);
  const hasPaidPlan = current === 'paid' || current === 'ultra';
  const buyerIdentified = !!currentUser?.email && !!currentUser?.telegram_username;
  button.disabled = summary.plan.unlimited || hasPaidPlan || waiting || !buyerIdentified;
  ultraButton.disabled = summary.plan.unlimited || hasPaidPlan || waiting || !buyerIdentified;
  button.textContent = summary.plan.unlimited ? 'У вас доступ без ограничений' : current === 'paid' ?
    'Подписка активна' : hasPaidPlan ? 'Смена тарифа — через поддержку' : waiting ? 'Ожидаем подтверждение Platega' :
    `Оформить за ${paid.monthly_price_rubles ?? 490} ₽/месяц`;
  ultraButton.textContent = summary.plan.unlimited ? 'У вас доступ без ограничений' : current === 'ultra' ?
    'Подписка активна' : hasPaidPlan ? 'Смена тарифа — через поддержку' : waiting ? 'Ожидаем подтверждение Platega' :
    `Оформить за ${ultra.monthly_price_rubles ?? 990} ₽/месяц`;
  if (!buyerIdentified && current === 'free') {
    $('billingMessage').textContent = 'Перед оплатой сохраните Telegram username родителя в блоке «Данные покупателя».';
  } else if (!billing.provider?.enabled && current === 'free') {
    $('billingMessage').textContent = 'Покупка подписки временно недоступна. Пока можно пользоваться бесплатным тарифом.';
  } else if (waiting) {
    $('billingMessage').textContent = 'Подписка создана в Platega и ожидает подтверждения. Нажмите кнопку ещё раз, чтобы вернуться к оплате.';
    (summary.payment?.plan === 'ultra' ? ultraButton : button).disabled = false;
  } else if (current === 'paid' || current === 'ultra') {
    $('billingMessage').textContent = `${summary.plan.title} активен. Чтобы сменить тариф без двойного списания, сначала отмените текущую подписку через Platega или напишите в поддержку.`;
  } else if (summary.plan.unlimited) {
    $('billingMessage').textContent = 'Доступ администратора работает без тарифных ограничений.';
  } else {
    $('billingMessage').textContent = 'Оплата проходит на защищённой странице Platega через СБП. Списание повторяется раз в месяц; отменить подписку можно по ссылке из письма Platega.';
  }
  if(billingNotice)$('billingMessage').textContent=billingNotice;
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
  })().catch(error => {
    dependenciesPromise = null;
    console.error('Не удалось запустить локальное распознавание лица.', error);
    const details=String(error?.message||error||'');
    if(/WebAssembly|wasm|Content Security|CompileError/i.test(details)){
      throw new Error('Браузер не смог запустить локальное распознавание лица. Обновите страницу и попробуйте ещё раз.');
    }
    throw new Error('Не удалось загрузить локальные файлы создания аватара. Обновите страницу и попробуйте ещё раз.');
  });
  return dependenciesPromise;
}
function initScene() {
  scene = new THREE.Scene();
  camera = new THREE.OrthographicCamera(-1, 1, 1, -1, .01, 100);
  renderer = new THREE.WebGLRenderer({antialias: true, alpha: true});
  renderer.domElement.addEventListener('webglcontextlost',event=>{
    event.preventDefault();
    if(running)pause(true).catch(fail);
    fail(new Error('Отображение аватара прервано. После восстановления нажмите «Продолжить занятие».'));
  });
  renderer.domElement.addEventListener('webglcontextrestored',()=>{
    renderTime=0;fit();
    if(running&&paused)$('monitorStatus').textContent='Аватар восстановлен · можно продолжить занятие';
    controls();
  });
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
  if (cameraLive() && !stream.getVideoTracks().some(track=>track.muted)) {
    if (video.srcObject !== stream) video.srcObject = stream;
    await withTimeout(video.play(),10000);
    lastFrame=-1;lastResult=null;lastSeenFrame=performance.now();detectError=false;controls();return;
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
  if(!currentUser?.avatar_consent_current&&!$('avatarConsent').checked){$('avatarConsent').focus();throw new Error('Разрешите Адым создать и сохранить аватар из снимков.');}
  if(!currentUser?.avatar_consent_current){
    const consent=await api('account/consent',JSON.stringify({kind:'avatar',accepted:true}),true,15000);
    currentUser=consent.user;
  }
  stopAudio();scanning=true;const epoch=++scanEpoch,abort=new AbortController();scannerAbort=abort;restoringAbort?.abort();
  $('scannerDialog').showModal();$('scannerCamera').appendChild(video.closest('.camera-frame'));controls();
  try {
    scanInstruction('Перед съёмкой снимите шляпу, кепку и наушники. Очки оставьте, если носите их постоянно. Сядьте лицом к свету.',true);
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
          const view={role,yaw:faceYaw(fresh),canvas,landmarks:fresh.map(p=>({x:p.x,y:p.y,z:p.z})),photo:canvas.toDataURL('image/jpeg',.88)};
          views.push(view);
          if(role==='front'){
            scanInstruction('Проверяем, что шляпа, кепка или наушники сняты. Очки можно оставить.',true);
            const accessoryMask=await scanAccessories(view,abort.signal);
            const accessoryIssue=portraitAccessoryIssue(view.landmarks,accessoryMask);
            if(accessoryIssue)throw new Error(accessoryIssue);
          }
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
    scanInstruction('Создаём ваш объёмный аватар.',true);
    const model=LocalAvatar.create(THREE,views,avatarTopology);
    try {await api('avatar',JSON.stringify({version:7,views:views.map(({role,yaw,landmarks,photo})=>({role,yaw,landmarks,photo})),anchors:(portrait||front).anchors,portraitAnalysis:packPortraitAnalysis(portrait||front)}),true,60000,abort.signal);}
    catch(error){model.dispose();throw error;}
    if(epoch!==scanEpoch){model.dispose();return;}
    installModel(model);showPortraitCutout(portrait||front);cancelScan();
    $('faceStatus').textContent='3D-аватар создан';$('cameraHint').textContent='Аватар сохранён в вашем профиле. Проверьте лицо, волосы, шею и поворот.';
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
    const accessoryIssue=portraitAccessoryIssue(view.landmarks,mask);
    if(accessoryIssue)throw new Error(accessoryIssue);
    return fitStablePortraitAnchors(view.landmarks,mask);
  }
  finally {worker?.terminate();bitmap?.close();}
}
async function scanAccessories(view,signal) {
  let worker,bitmap;
  try {
    bitmap=await createImageBitmap(view.canvas);
    return await new Promise((resolve,reject)=>{
      if(signal?.aborted){reject(new DOMException('Сканирование отменено','AbortError'));return;}
      worker=new Worker('/portrait-worker.js');
      const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',cancel);};
      const cancel=()=>{cleanup();worker.terminate();reject(new DOMException('Сканирование отменено','AbortError'));};
      const timer=setTimeout(()=>{cleanup();reject(new Error('Проверка головного убора заняла слишком долго. Попробуйте ещё раз.'));},30000);
      signal?.addEventListener('abort',cancel,{once:true});
      worker.onmessage=({data})=>{if(data.progress)return;cleanup();data.error?reject(new Error(data.error)):resolve(data);};
      worker.onerror=event=>{cleanup();reject(new Error(event.message||'Не удалось проверить головной убор.'));};
      try {worker.postMessage({bitmap,accessoriesOnly:true},[bitmap]);bitmap=null;} catch(error){cleanup();reject(error);}
    });
  } finally {worker?.terminate();bitmap?.close();}
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
  const finish=browserSpeechFinish;browserSpeechFinish=null;
  if(browserUtterance){browserUtterance=null;window.speechSynthesis?.cancel();}
  finish?.();
  for(const source of audioSources) {try{source.stop();}catch{} source.disconnect();}
  audioSources.clear();audioSource=null;analyser?.disconnect();analyser=null;
  playing=false;audioKind='';audioNext=0;echoUntil=performance.now()+1000;controls();
}
async function playVoice(kind='manual') {
  if(!status.phrases?.length) throw new Error('Сначала создайте голос.');
  stopAudio();const playId=playbackId,ctx=context();await ctx.resume();if(playId!==playbackId)return;
  const matching=status.phrases.filter(item=>item.purpose===kind),pool=matching.length?matching:status.phrases;
  const item=pool[Math.floor(Math.random()*pool.length)];
  const res=await fetch('/audio/'+item.file);
  if(!res.ok) throw new Error('Аудиофайл недоступен');
  const buffer=await ctx.decodeAudioData(await res.arrayBuffer());
  if(playId!==playbackId)return;
  return beginAudio(buffer,item.text,kind);
}
async function speakBrowserPrompt(text,kind) {
  if(!window.speechSynthesis)return playVoice(kind);
  stopAudio();const id=playbackId;
  return new Promise(resolve=>{
    const utterance=new SpeechSynthesisUtterance(text);utterance.lang='ru-RU';utterance.rate=.92;
    const local=window.speechSynthesis.getVoices().find(voice=>voice.lang.startsWith('ru')&&voice.localService);
    if(local)utterance.voice=local;
    const finish=()=>{if(browserUtterance===utterance){browserUtterance=null;browserSpeechFinish=null;playing=false;audioKind='';echoUntil=performance.now()+1000;controls();}resolve();};
    browserSpeechFinish=finish;
    utterance.onend=finish;utterance.onerror=finish;browserUtterance=utterance;browserSpeechStarted=performance.now();
    playing=true;audioKind=kind;$('phraseText').textContent=text;$('lessonSpeech').textContent=text;controls();
    try{window.speechSynthesis.speak(utterance);}catch{browserUtterance=null;browserSpeechFinish=null;playing=false;audioKind='';resolve(playVoice(kind));}
  });
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
  if(!currentUser?.avatar_consent_current&&!$('voiceDataConsent').checked){$('voiceDataConsent').focus();throw new Error('Отдельно разрешите Адым создать и сохранить образцы вашего голоса.');}
  if(!currentUser?.avatar_consent_current){
    const consent=await api('account/consent',JSON.stringify({kind:'avatar',accepted:true}),true,15000);
    currentUser=consent.user;
  }
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
    const duration = $('voiceMode').value === 'direct' ? 8 : 18;
    const mode = $('voiceMode').value;
    const take = mode === 'direct' ? 1 : voiceTake;
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
    const result = await api(`reference?mode=${mode}&take=${take}`, wav);
    referenceRejected = false;
    $('reference').src = `${take === 1 ? '/audio/reference.wav' : `/audio/reference-${take}.wav`}?t=${Date.now()}`; $('reference').hidden = false;
    $('voiceHint').textContent = mode==='direct'
      ? `Запись: ${result.seconds} сек. Прослушайте её, затем нажмите «Сохранить напоминание».`
      : `Образец ${take}: чистой речи ${result.speech_seconds} сек. Прослушайте запись и выберите следующий образец.`;
    status = await api('status');
    renderVoiceTakes();
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
  studySessionId=study.id;lessonLimitSeconds=study.limit_seconds;lessonLimitHandled=false;pausePending=false;dialogId=null;taskFinished=false;hideTaskSwitch();
  stopAudio(); running = true; paused = false; presence.reset(); lessonElapsed = Number(study.elapsed_seconds||0)*1000; lessonStarted = performance.now(); showLesson();
  // The tab may have been hidden while the server was starting the lesson.
  if(document.hidden||(lessonCameraEnabled&&!cameraLive())){await pause(true);return;}
  if(lessonCameraEnabled) startLessonPresence();
  else $('monitorStatus').textContent='Камера выключена родителем';
  controls();
  startHandsFree().catch(fail);
  try { await playVoice('lesson'); } catch(e) { fail(e); }
}
function pause(forcePause=false) {
  if(!running||!studySessionId)return Promise.resolve();
  if(forcePause){resumeCancelled=true;stopCamera();}
  if(lessonTransition){
    // A hidden tab/camera failure must never toggle an in-flight resume back
    // into another resume. Finish it, then reconcile the server to paused.
    return forcePause?lessonTransition.catch(()=>{}).then(()=>pause(true)):lessonTransition;
  }
  const sessionId=studySessionId;
  const resuming=paused&&!forcePause;
  resumeCancelled=false;
  // Keep the audio unlock inside the button gesture, before network awaits.
  const audioReady=resuming?context().resume():Promise.resolve();
  lessonTransition=(async()=>{
    stopAudio();cancelTutor();stopHandsFree();
    if(!resuming){
      if(!paused)lessonElapsed+=performance.now()-lessonStarted;
      paused=true;pausePending=true;lessonPresenceEnabled=false;
      document.body.classList.add('on-break');stopCamera();
      setListenerState('off','Перерыв. Камера и микрофон выключены.');
      $('tutorStatus').textContent='Занятие на паузе. Нажми «Продолжить занятие», когда будешь готов.';
      $('pauseBtn').textContent='Продолжить занятие';
      $('monitorStatus').textContent='Перерыв · камера выключена';controls();
      const session=await api('study-session',JSON.stringify({action:'pause',id:sessionId}));
      if(!running||studySessionId!==sessionId)return;
      lessonElapsed=Number(session.elapsed_seconds||0)*1000;lessonLimitSeconds=session.limit_seconds;pausePending=false;
      return;
    }
    const interrupted=()=>resumeCancelled||document.hidden||!running||studySessionId!==sessionId;
    try{
      await audioReady;
      if(pausePending){
        await api('study-session',JSON.stringify({action:'pause',id:sessionId}));
        pausePending=false;
      }
      if(interrupted())return;
      if(lessonCameraEnabled)await enableCamera();
      if(interrupted()){stopCamera();return;}
      // A lost response can still mean the server resumed. Reconcile to a
      // pause on the next successful poll before offering another resume.
      pausePending=true;
      const session=await api('study-session',JSON.stringify({action:'resume',id:sessionId}));
      if(interrupted()){stopCamera();return;}
      lessonElapsed=Number(session.elapsed_seconds||0)*1000;lessonLimitSeconds=session.limit_seconds;
      pausePending=false;detectError=false;presence.reset();paused=false;
      document.body.classList.remove('on-break');lessonStarted=performance.now();
      $('pauseBtn').textContent='Сделать перерыв';
      if(lessonCameraEnabled)startLessonPresence();startHandsFree().catch(fail);
    }catch(error){stopCamera();throw error;}
  })().finally(()=>{lessonTransition=null;controls();});
  return lessonTransition;
}
function stop(message='Занятие завершено · камера выключена',notifyServer=true) { const session=studySessionId;studySessionId=null;if(session&&notifyServer)api('study-session',JSON.stringify({action:'stop',id:session})).catch(()=>{});stopHandsFree();api('voice-release',new Uint8Array()).catch(()=>{});running = false; paused = false;pausePending=false;dialogId=null;taskFinished=false;lessonCameraEnabled=false;lessonPresenceEnabled=false;document.body.classList.remove('on-break'); stopAudio(); stopCamera(); cancelTutor(); presence.reset(); $('pauseBtn').textContent = 'Сделать перерыв'; $('monitorStatus').textContent = message; showSetup(); controls(); }
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
  if (!running) return;
  if(paused)return pause();
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
const presencePrompts={
  camera:'Вернись, пожалуйста, в кадр, чтобы я видел, что ты рядом.',
  away:'Ты уже пять минут не в кадре. Возвращайся, пожалуйста, продолжим занятие вместе.',
};
let reminderPending = false;
async function reminder(kind) {
  if (reminderPending) return;
  reminderPending = true;
  try {
    const hasRecorded=status.phrases?.some(item=>item.purpose===kind);
    if(hasRecorded)await playVoice(kind);else await speakBrowserPrompt(presencePrompts[kind],kind);
    if (!running || paused || presence.state !== 'absent') stopAudio();
  }
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
        $('monitorStatus').textContent = {present:'Лицо в кадре · занятие идёт',missing:'Лицо пропало · готовлю напоминание',absent:'Ребёнок не в кадре · зову вернуться',returning:'С возвращением'}[current.state];
        if (found && (audioKind === 'camera' || audioKind === 'away')) stopAudio();
        if (current.reminder && !tutorBusy && !questionRecording && !listenerPending && now>childSpeakingUntil && !playing) {
          presence.acknowledgeReminder(current.reminder,now/1000);reminder(current.reminder);
        }
      }
    } catch (e) {
      lessonPresenceEnabled=false;
      try{detector?.close();}catch{}
      detector=null;dependenciesPromise=null;lastMediaTimestamp=-1;
      if(!cameraLive()||video.readyState<2||now-lastSeenFrame>3000){
        detectError=true;pause(true).catch(fail);fail(e);
      }else{
        // A MediaPipe/WebGL failure is not a lost camera. Discard the broken
        // detector so the next reconnect can create it again; keep the avatar
        // and lesson running instead of entering an unrecoverable pause loop.
        detectError=true;
        $('monitorStatus').textContent='Камера включена · проверка лица временно недоступна';
      }
    }
  }
  if (mesh && !document.hidden && now - renderTime >= 33) {
    renderTime = now;
    let opening=0;
    if(playing&&analyser){analyser.getFloatTimeDomainData(pcm);opening=speechOpening(pcm);}
    else if(playing&&browserUtterance)opening=.22+.18*Math.abs(Math.sin((now-browserSpeechStarted)*.018));
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
}
function chatMessage(role, text) {
  const box = document.createElement('p'); box.className = `chat-message ${role}`;
  const label = document.createElement('strong'); label.textContent = role === 'user' ? 'Ты' : 'Давай попробуем';
  const content = document.createElement('span'); content.textContent = text;
  box.append(label, content); $('tutorMessages').appendChild(box); box.scrollIntoView({block:'nearest'});
}
function hideTaskSwitch() {
  taskSwitchPending=null;
  $('taskSwitchPrompt').hidden=true;
}
function showTaskSwitch(question) {
  taskSwitchPending={question};
  $('taskSwitchPrompt').hidden=false;
  $('taskSwitchPrompt').scrollIntoView({block:'nearest'});
  controls();
}
function cancelTutor() {
  helpEpoch++; questionCancel=true; questionAbort?.abort(); stopTracks(questionStream);
  listener?.sttAbort?.abort();tutorBusy=false;followupUntil=0;stopAudio();
  if(currentJob) api('dialog-cancel',JSON.stringify({id:currentJob})).catch(()=>{});
  currentJob=null;hideTaskSwitch();controls();
}
async function askTutor(event) {
  event.preventDefault();
  const question = $('assignment').value.trim();
  if (!question || !running || paused || lessonTransition || tutorBusy || questionRecording || listenerPending) return;
  $('assignment').value = '';
  await answerQuestion(question);
}
async function answerQuestion(question,switchAction=null,renderQuestion=true) {
  if(!running||paused||lessonTransition)return;
  if(taskSwitchPending&&!switchAction)return;
  const epoch=++helpEpoch;
  if(taskFinished){$('tutorMessages').replaceChildren();taskFinished=false;$('assignment').placeholder='Например: не понимаю, как решить 2x + 3 = 11';}
  if(renderQuestion)chatMessage('user',question);stopAudio();tutorBusy=true;controls();clearError();
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
      study_session:studySessionId,voice:$('replyVoice').value,request_id:requestId(),switch_action:switchAction}));
    if(started.switch_required){showTaskSwitch(question);$('tutorStatus').textContent='Это новое задание или продолжение предыдущего?';return;}
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
        if(result.finished){dialogId=null;taskFinished=true;followupUntil=0;$('assignment').placeholder='Введи условие нового задания';}
        else {taskFinished=false;followupUntil=performance.now()+60000;}
        $('tutorStatus').textContent=result.warning||result.limit_warning||(result.finished?'Правильно! Введи или скажи новое задание':'Твоя очередь — попробуй следующий шаг.');break;
      }
      if(result.state==='error')throw new Error(result.warning);
      if(result.state==='cancelled')break;
      $('tutorStatus').textContent=result.state==='speaking'?(status.voice_provider==='qwen'?'Qwen создаёт голос родителя · обычно 2–5 минут…':'Озвучиваю подсказку…'):'Думаю, как помочь…';
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
  listenEpoch++;listenerPending=false;
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
    if(epoch!==listenEpoch)return;
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
      const suppressed=!running||paused||document.hidden||tutorBusy||!!taskSwitchPending||questionRecording||listenerPending||playing||performance.now()<echoUntil||presence.state==='absent';
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
    const result=await api('speech',wav,true,120000,abort.signal);
    if(result.limit_warning)$('tutorStatus').textContent=result.limit_warning;
    if(listenId!==listenEpoch||epoch!==helpEpoch||!running||paused)return;
    const heard=String(result.text||'').trim();
    $('tutorStatus').textContent=`Услышал: «${heard}»`;
    // During a lesson the microphone is explicitly enabled by the parent and
    // camera presence is confirmed. Do not silently discard a clear phrase
    // merely because Whisper omitted a question mark or wake word.
    if(isDirectedSpeech(heard,performance.now()<followupUntil)||/[а-яёa-z0-9]{2}/iu.test(heard))await answerQuestion(heard);
    else setListenerState('listening','Не разобрал вопрос. Скажи его ещё раз.');
  }catch(e){
    if(listenId!==listenEpoch||epoch!==helpEpoch)return;
    const failure=classifySpeechRecognitionError(e);
    if(failure.stop){$('handsFree').checked=false;stopHandsFree();setListenerState('error',failure.message);fail(new Error(failure.message));}
    else setListenerState('listening',failure.message);
  }finally{if(listenId===listenEpoch){listenerPending=false;controls();}}
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
    if(questionCancel)return;
    mic=await withTimeout(navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true}}),20000,stopTracks,questionAbort.signal);
    questionStream=mic;setListenerState('speech','Говори. Когда закончишь, нажми «Закончить вопрос».');
    await ctx.audioWorklet.addModule('/recorder.js');
    if(questionCancel)return;
    source=ctx.createMediaStreamSource(mic); node=new AudioWorkletNode(ctx,'recorder');
    const chunks=[]; let count=0,detectedUtterance=null;const gate=new SpeechGate(ctx.sampleRate);
    node.port.onmessage=({data})=>{
      chunks.push(data);count+=data.length;const rms=Math.sqrt(data.reduce((v,x)=>v+x*x,0)/data.length);
      if(rms>.0045)childSpeakingUntil=performance.now()+1500;
      const utterance=gate.push(data);
      if(utterance&&!detectedUtterance){detectedUtterance=utterance;questionStop=true;}
    };
    source.connect(node);node.connect(ctx.destination);
    const began=performance.now();
    while(!questionStop && !questionCancel && count<ctx.sampleRate*25) {
      $('tutorStatus').textContent=`Слушаю вопрос · ${Math.floor(count/ctx.sampleRate)} сек. Нажми «Закончить вопрос», когда закончишь.`;
      if(performance.now()-began>33000 || mic.getAudioTracks()[0].readyState!=='live') throw new Error('Микрофон перестал передавать звук.');
      await sleep(100);
    }
    if(!questionCancel){
      const samples=detectedUtterance||new Float32Array(count); let offset=0;
      if(!detectedUtterance)for(const chunk of chunks) {samples.set(chunk,offset);offset+=chunk.length;}
      wav=encodeWav(samples.slice(0,ctx.sampleRate*25),ctx.sampleRate);
    }
  } catch(e) {if(!questionCancel) fail(mediaError(e));}
  finally {source?.disconnect();node?.disconnect();stopTracks(mic);await ctx?.close();questionStream=null;questionRecording=false;controls();}
  if(!wav || questionCancel){if(running&&!paused)startHandsFree().catch(fail);return;}
  const epoch=++helpEpoch; tutorBusy=true;controls();
  try {
    $('tutorStatus').textContent='Распознаю твой вопрос…';
    const result=await api('speech',wav,true,120000,questionAbort.signal);
    if(result.limit_warning)$('tutorStatus').textContent=result.limit_warning;
    if(epoch!==helpEpoch) return;
    tutorBusy=false;
    await answerQuestion(result.text);
  } catch(e) {if(epoch===helpEpoch) {tutorBusy=false;controls();fail(e);}}
  finally {if(running&&!paused)startHandsFree().catch(fail);}
}
function action(id, fn) { $(id).addEventListener('click', async () => {
  if (pendingActions.has(id)) return;
  pendingActions.add(id); clearError(); controls();
  try { await fn(); } catch(e) { fail(e); }
  finally { pendingActions.delete(id); controls(); }
}); }
function loadVoiceTake(take) {
  const recorded = status.reference_mode === 'clone' && status.reference_takes?.includes(take);
  if ($('voiceMode').value === 'direct' && status.reference_mode === 'direct' && status.reference) {
    $('reference').src = '/audio/reference.wav'; $('reference').hidden = false;
  } else if (recorded) {
    $('reference').src = take === 1 ? '/audio/reference.wav' : `/audio/reference-${take}.wav`;
    $('reference').hidden = false;
  } else {
    $('reference').removeAttribute('src'); $('reference').load(); $('reference').hidden = true;
  }
}
function renderVoiceTakes() {
  const recorded = status.reference_mode === 'clone' ? (status.reference_takes || []) : [];
  for (const button of document.querySelectorAll('[data-voice-take]')) {
    const take = Number(button.dataset.voiceTake);
    button.setAttribute('aria-pressed', String(take === voiceTake));
    button.classList.toggle('recorded', recorded.includes(take));
    button.querySelector('small').textContent = recorded.includes(take) ? 'Готово · можно повторить' : 'Записать';
  }
}
function updateVoiceMode() {
  const direct = $('voiceMode').value === 'direct';
  $('voiceTakes').hidden = direct;
  $('recordBtn').textContent = direct ? 'Записать напоминание · 8 сек' : `Записать образец ${voiceTake} · 18 сек`;
  $('voiceModeHint').textContent=direct?'Аватар будет воспроизводить только эту точную запись — новые ответы она не озвучит.':'Запишите три образца с разной естественной интонацией. Модель усреднит тембр по всем записям и будет меньше искажать голос.';
  $('readText').textContent = direct ? 'Давай вернёмся к заданию. Если нужна помощь, позови меня.' : voiceTakeTexts[voiceTake];
  loadVoiceTake(voiceTake);
  renderVoiceTakes();
}
$('voiceMode').addEventListener('change', () => { voiceModeTouched = true; updateVoiceMode(); controls(); });
for (const button of document.querySelectorAll('[data-voice-take]')) button.addEventListener('click', () => {
  voiceTake = Number(button.dataset.voiceTake); updateVoiceMode(); controls();
});
action('nextVoiceTakeBtn', () => {
  voiceTake = Math.min(3, voiceTake + 1); updateVoiceMode(); controls();
});
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
$('voiceQuestionBtn').addEventListener('click',()=>voiceQuestion().catch(fail));
$('scanAudio').addEventListener('change',()=>{if(!$('scanAudio').checked) window.speechSynthesis?.cancel();});
document.querySelectorAll('[data-setup-step]').forEach(button=>button.addEventListener('click',()=>setupStep(button.dataset.setupStep)));
action('nextVoiceBtn',()=>setupStep('voice'));action('nextReadyBtn',()=>setupStep('ready'));
action('viewFrontBtn',()=>{previewYaw=0;});action('viewSideBtn',()=>{previewYaw=.11;});
action('previewMotionBtn',()=>playVoice('preview'));
$('tutorForm').addEventListener('submit', askTutor);
$('cancelHelpBtn').addEventListener('click', cancelTutor);
$('clearHelpBtn').addEventListener('click', async () => { const previous=dialogId;cancelTutor();dialogId=null;taskFinished=false;followupUntil=0;if(previous)await api('dialog-switch',JSON.stringify({session:previous})).catch(fail);$('tutorMessages').replaceChildren();$('assignment').value='';$('assignment').placeholder='Например: не понимаю, как решить 2x + 3 = 11';$('assignment').focus(); });
$('switchTaskBtn').addEventListener('click',()=>{const pending=taskSwitchPending;if(!pending)return;hideTaskSwitch();$('tutorMessages').replaceChildren();answerQuestion(pending.question,'new',true);});
$('continueTaskBtn').addEventListener('click',()=>{const pending=taskSwitchPending;if(!pending)return;hideTaskSwitch();answerQuestion(pending.question,'continue',false);});
window.addEventListener('popstate', () => { if (running) stop(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { recordCancelled = true; recordingAbort?.abort(); stopTracks(recordingStream);if(scanning)cancelScan();window.speechSynthesis?.cancel();stopHandsFree();stopCamera(); } if (document.hidden && running) { pause(true).catch(()=>{}); $('monitorStatus').textContent = 'Перерыв · окно скрыто'; } });
window.addEventListener('beforeunload', () => {
  if(running&&!paused&&studySessionId)fetch('/api/study-session',{method:'POST',keepalive:true,headers:{'X-App-Token':token,'Content-Type':'application/json'},body:JSON.stringify({action:'pause',id:studySessionId})}).catch(()=>{});
  stopHandsFree();stopTracks(questionStream);stopTracks(recordingStream);stopAudio(); stopCamera(); scannerAbort?.abort();restoringAbort?.abort();modelAvatar?.dispose();detector?.close(); audioContext?.close();
});
async function restoreAvatar() {
  const restoringEpoch=scanEpoch,abort=new AbortController();restoringAbort=abort;
  try {
    const saved=await api('avatar');if(!saved||restoringEpoch!==scanEpoch)return;
    if(saved.version===7){
      $('faceStatus').textContent='Восстанавливаем ваш аватар…';await avatarDependencies();
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
      $('faceStatus').textContent='3D-аватар загружен';$('cameraHint').textContent='Аватар хранится в вашем профиле и доступен после повторного входа.';return;
    }
    if(saved.version!==6){
      $('faceStatus').textContent='Нужен новый скан';
      $('cameraHint').textContent='Ваш прежний снимок сохранён. Чтобы использовать новый объёмный аватар, создайте образ ещё раз.';
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
  return requestAuth(path,values);
}

const ADMIN_PLAN_TITLES={free:'Бесплатный',paid:'Адым Плюс',ultra:'Адым Ультра'};
const ADMIN_ACTION_TITLES={ban:'заблокировал',unban:'разблокировал',set_plan:'изменил тариф',revoke_sessions:'завершил все входы'};
function adminElement(tag,className,text){const element=document.createElement(tag);if(className)element.className=className;if(text!==undefined)element.textContent=text;return element;}
function adminDate(timestamp){return timestamp?new Date(Number(timestamp)*1000).toLocaleString('ru-RU',{dateStyle:'short',timeStyle:'short'}):'ещё не было';}
function adminBadge(text,className=''){const badge=adminElement('span',`admin-badge ${className}`.trim(),text);return badge;}
function adminMetaLine(label,value){const line=adminElement('span');line.append(document.createTextNode(`${label}: `),adminElement('strong','',value));return line;}

async function loadAdminAudit(){
  const target=$('adminAuditEntries');target.replaceChildren();
  const {entries}=await api('admin/audit?limit=40');
  if(!entries.length){target.append(adminElement('p','helper','Действий пока нет.'));return;}
  for(const entry of entries){
    const row=adminElement('div','admin-audit-entry');
    let detail='';
    if(entry.action==='set_plan')detail=` · ${ADMIN_PLAN_TITLES[entry.details?.plan]||entry.details?.plan||''}`;
    if(entry.action==='ban'&&entry.details?.reason)detail=` · ${entry.details.reason}`;
    row.append(adminElement('strong','',`${entry.admin_login||'Администратор'} ${ADMIN_ACTION_TITLES[entry.action]||entry.action} ${entry.target_login}${detail}`),adminElement('span','',adminDate(entry.created_at)));
    target.append(row);
  }
}

async function runAdminAction(account,action,values,button){
  if(action==='ban'&&!window.confirm(`Заблокировать аккаунт ${account.login}? Пользователь сразу выйдет из Адым.`))return;
  if(action==='revoke_sessions'&&!window.confirm(`Завершить все входы аккаунта ${account.login}?`))return;
  const oldLabel=button.textContent;button.disabled=true;button.textContent='Подождите…';$('adminMessage').textContent='Сохраняем изменение…';
  try{
    await api('admin/user',JSON.stringify({user_id:account.id,action,...values}),true,30000);
    $('adminMessage').textContent=`Готово: ${account.login} обновлён.`;
    await Promise.all([loadAdminUsers(),loadAdminAudit()]);
  }catch(error){$('adminMessage').textContent=error.message||String(error);button.disabled=false;button.textContent=oldLabel;}
}

function renderAdminUsers(page){
  $('adminTotalUsers').textContent=page.stats?.total??page.total??0;
  $('adminBlockedUsers').textContent=page.stats?.banned??0;
  $('adminPaidUsers').textContent=page.stats?.paid??0;
  const target=$('adminUsers');target.replaceChildren();
  if(!page.users?.length){target.append(adminElement('p','admin-empty','Аккаунты не найдены.'));return;}
  for(const account of page.users){
    const self=account.id===currentUser?.id,protectedAccount=self||account.role==='admin';
    const card=adminElement('article',`admin-user${account.is_banned?' is-banned':''}${self?' is-self':''}`);
    const identity=adminElement('div','admin-identity');
    identity.append(adminElement('strong','',account.login),adminElement('span','',account.email));
    identity.append(adminElement('span','',account.telegram_username || 'Telegram не указан'));
    const badges=adminElement('div','admin-badges');
    badges.append(adminBadge(account.plan_title||ADMIN_PLAN_TITLES[account.plan]||'Бесплатный'));
    if(account.is_banned)badges.append(adminBadge('Заблокирован','blocked'));
    if(account.role==='admin')badges.append(adminBadge(self?'Это вы':'Администратор','admin'));
    identity.append(badges);
    const meta=adminElement('div','admin-meta');
    meta.append(adminMetaLine('Регистрация',adminDate(account.created_at)),adminMetaLine('Последний вход',adminDate(account.last_login_at)),adminMetaLine('Последняя активность',adminDate(account.last_activity_at||account.last_seen_at)),adminMetaLine('Всего входов',String(account.login_count||0)),adminMetaLine('Активных входов',String(account.active_sessions||0)),adminMetaLine('За месяц',`${account.assignments||0} задач · ${account.hints||0} подсказок`),adminMetaLine('Расход',`${Number(account.external_cost_rubles||0).toFixed(2)} ₽`));
    const controls=adminElement('div','admin-controls');
    if(protectedAccount){controls.append(adminElement('p','helper admin-wide',self?'Ваш администраторский аккаунт защищён от изменений.':'Другой администратор защищён от изменений.'));}
    else{
      const select=adminElement('select');select.setAttribute('aria-label',`Тариф аккаунта ${account.login}`);
      for(const [value,title] of Object.entries(ADMIN_PLAN_TITLES)){const option=adminElement('option','',title);option.value=value;option.selected=value===(account.plan||'free');select.append(option);}
      const save=adminElement('button','secondary','Сохранить тариф');save.type='button';save.disabled=true;select.addEventListener('change',()=>save.disabled=select.value===(account.plan||'free'));save.addEventListener('click',()=>runAdminAction(account,'set_plan',{plan:select.value},save));
      controls.append(select,save);
      if(account.is_banned){const unban=adminElement('button','admin-unban admin-wide','Разблокировать аккаунт');unban.type='button';unban.addEventListener('click',()=>runAdminAction(account,'unban',{},unban));controls.append(unban);}
      else{
        const reason=adminElement('input','admin-wide');reason.placeholder='Причина блокировки — необязательно';reason.maxLength=240;reason.setAttribute('aria-label',`Причина блокировки ${account.login}`);
        const ban=adminElement('button','admin-ban','Заблокировать');ban.type='button';ban.addEventListener('click',()=>runAdminAction(account,'ban',{reason:reason.value},ban));
        const revoke=adminElement('button','secondary','Завершить все входы');revoke.type='button';revoke.disabled=!(account.active_sessions>0);revoke.addEventListener('click',()=>runAdminAction(account,'revoke_sessions',{},revoke));
        controls.append(reason,ban,revoke);
      }
    }
    card.append(identity,meta,controls);target.append(card);
  }
}

async function loadAdminUsers(){
  const query=$('adminSearch').value.trim();$('adminMessage').textContent='Загружаем аккаунты…';
  try{const page=await api(`admin/users?q=${encodeURIComponent(query)}&limit=50`);renderAdminUsers(page);$('adminMessage').textContent=page.total>page.users.length?`Показаны первые ${page.users.length} из ${page.total}. Уточните поиск.`:`Найдено аккаунтов: ${page.total}.`;}
  catch(error){$('adminMessage').textContent=error.message||String(error);throw error;}
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
  $('billingEmail').value = user.email || '';
  $('billingTelegram').value = user.telegram_username || '';
  $('billingContactMessage').textContent = user.telegram_username ? 'Данные покупателя сохранены.' : 'Укажите Telegram перед покупкой подписки.';
  $('adminPanelBtn').hidden = !user.is_admin;
  $('authPage').hidden = true;
  document.querySelector('.app-header').hidden = false;
  $('setupPage').hidden = false;
  document.body.classList.remove('auth-pending');
  startApplication();
  if (!user.legal_current) {
    requestAnimationFrame(() => {
      if (!$('legalConsentDialog').open) $('legalConsentDialog').showModal();
    });
  }
  if (requestedPlan === 'paid' || requestedPlan === 'ultra') {
    requestAnimationFrame(() => { if (user.legal_current) $('billingDialog').showModal(); });
  }
}

$('loginTab').addEventListener('click', () => authMode('login'));
$('registerTab').addEventListener('click', () => authMode('register'));
$('authPaidBtn').addEventListener('click', () => authMode('register'));
$('billingBtn').addEventListener('click', () => $('billingDialog').showModal());
$('closeBillingBtn').addEventListener('click', () => {$('billingDialog').close(); $('billingBtn').focus();});
$('billingDialog').addEventListener('click', event => {if (event.target === $('billingDialog')) $('billingDialog').close();});
$('billingDialog').addEventListener('close',()=>{billingNotice='';});
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
    if (formId === 'registerForm') {
      values.parent_confirmed = form.elements.parent_confirmed.checked;
      values.terms_accepted = form.elements.terms_accepted.checked;
      values.privacy_accepted = form.elements.privacy_accepted.checked;
      values.plan=requestedPlan;
    }
    authBusy(form, true);
    try {
      const data = await authRequest(path, values);
      if (data.verification_required) {
        form.reset();authMode('login');
        window.dispatchEvent(new CustomEvent('adym:email-verification-required',{
          detail:{email:data.email,message:data.message}}));
        return;
      }
      showApplication(data.user);
    } catch (error) {
      if (error.verificationRequired) {
        window.dispatchEvent(new CustomEvent('adym:email-verification-required',{
          detail:{email:error.email || (String(values.identifier||'').includes('@')?values.identifier:values.email),
                  message:error.message}}));
      }
      $('authError').textContent = error.message || String(error);
      $('authError').hidden = false;
    } finally { authBusy(form, false); }
  });
}
$('legalConsentDialog').addEventListener('cancel', event => event.preventDefault());
$('legalConsentForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form=event.currentTarget,button=form.querySelector('button[type="submit"]');
  $('legalConsentError').hidden=true;button.disabled=true;button.textContent='Сохраняем…';
  try{
    const data=await api('account/consent',JSON.stringify({kind:'legal',accepted:true}),true,15000);
    currentUser=data.user;$('legalConsentDialog').close();
    if(requestedPlan==='paid'||requestedPlan==='ultra')$('billingDialog').showModal();
  }catch(error){$('legalConsentError').textContent=error.message||String(error);$('legalConsentError').hidden=false;}
  finally{button.disabled=false;button.textContent='Подтвердить и продолжить';}
});
$('billingContactForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('saveBillingContactBtn');
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Сохраняем…';
  $('billingContactMessage').textContent = '';
  try {
    const data = await api('account/billing-contact', JSON.stringify({
      telegram_username: $('billingTelegram').value,
    }), true, 15000);
    currentUser = data.user;
    $('billingTelegram').value = data.user.telegram_username;
    $('billingContactMessage').textContent = 'Данные покупателя сохранены. Можно переходить к оплате.';
    await poll();
  } catch (error) {
    $('billingContactMessage').textContent = error.message || String(error);
    $('billingTelegram').focus();
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
});
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
$('deleteAccountBtn').addEventListener('click', () => {
  document.querySelector('.account').open = false;
  $('deleteAccountForm').reset();
  $('deleteAccountError').hidden = true;
  $('deleteAccountDialog').showModal();
  requestAnimationFrame(() => $('deletePassword').focus());
});
$('adminPanelBtn').addEventListener('click',async()=>{
  document.querySelector('.account').open=false;$('adminDialog').showModal();$('adminSearch').focus();
  try{await Promise.all([loadAdminUsers(),loadAdminAudit()]);}catch{}
});
$('closeAdminBtn').addEventListener('click',()=>$('adminDialog').close());
$('adminDialog').addEventListener('click',event=>{if(event.target===$('adminDialog'))$('adminDialog').close();});
$('adminSearchForm').addEventListener('submit',event=>{event.preventDefault();loadAdminUsers().catch(()=>{});});
$('adminRefreshBtn').addEventListener('click',()=>Promise.all([loadAdminUsers(),loadAdminAudit()]).catch(()=>{}));
$('cancelDeleteAccountBtn').addEventListener('click', () => $('deleteAccountDialog').close());
$('deleteAccountDialog').addEventListener('click', event => {
  if (event.target === $('deleteAccountDialog')) $('deleteAccountDialog').close();
});
$('deleteAccountForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form=event.currentTarget,button=$('confirmDeleteAccountBtn');
  $('deleteAccountError').hidden=true;button.disabled=true;
  const label=button.textContent;button.textContent='Удаляем…';
  try {
    if(running)stop('Занятие завершено · камера выключена',false);
    const values=Object.fromEntries(new FormData(form));
    await authRequest('delete',values);
    authenticated=false;location.replace('/');
  } catch(error) {
    $('deleteAccountError').textContent=error.message||String(error);
    $('deleteAccountError').hidden=false;
  } finally {button.disabled=false;button.textContent=label;}
});
async function buyPlan(plan, buttonId) {
  clearError();
  billingNotice='';
  if (!currentUser?.telegram_username) {
    $('billingContactMessage').textContent = 'Сначала укажите и сохраните Telegram username родителя.';
    $('billingTelegram').focus();
    return;
  }
  if(!status.billing?.provider?.enabled){
    billingNotice='Покупка подписки временно недоступна. Пока можно пользоваться бесплатным тарифом. Списаний не будет.';
    $('billingMessage').textContent=billingNotice;
    return;
  }
  pendingActions.add(buttonId); controls();
  try {
    const checkout = await api('billing/checkout', JSON.stringify({plan}), true, 30000);
    const target = new URL(checkout.redirect);
    if (target.protocol !== 'https:' || target.hostname !== 'pay.platega.io') throw new Error('Получена небезопасная ссылка оплаты.');
    location.assign(target.href);
  } catch (error) {
    billingNotice=error.message||'Не удалось оформить подписку. Повторите попытку позже.';
    $('billingMessage').textContent=billingNotice;
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
  else authMode(requestedPlan === 'paid' || requestedPlan === 'ultra' ? 'register' : 'login');
} catch (error) {
  $('authError').textContent = error.message || String(error);
  $('authError').hidden = false;
}

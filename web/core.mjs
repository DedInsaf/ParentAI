export function positionsFor(landmarks, width, height, scale = 4.2) {
  const nose = landmarks[1];
  return landmarks.flatMap(p => [
    (p.x - nose.x) * scale,
    -(p.y - nose.y) * height / width * scale,
    -(p.z - nose.z) * scale,
  ]);
}

export function scanCoverage(lm, width, height) {
  if (!lm || lm.length < 468) return 'Лицо не найдено';
  if (lm.slice(0, 468).some(p => p.x < .03 || p.x > .97 || p.y < .03 || p.y > .97)) return 'Поместите всё лицо в кадр';
  const eyeWidth = Math.abs(lm[263].x - lm[33].x);
  if (eyeWidth < .12) return 'Подойдите ближе к камере';
  const roll = Math.abs(lm[263].y - lm[33].y) * height / width / eyeWidth;
  if (roll > .18) return 'Держите голову ровно';
  return '';
}

export function faceYaw(lm) {
  if (!lm || lm.length < 264) return 0;
  const eyeWidth = Math.max(.001, Math.abs(lm[263].x - lm[33].x));
  return (lm[1].x - (lm[33].x + lm[263].x) / 2) / eyeWidth;
}

export function scanQuality(lm, width, height) {
  const coverage = scanCoverage(lm, width, height);
  if (coverage) return coverage;
  const eyeWidth = Math.abs(lm[263].x - lm[33].x);
  const roll = Math.abs(lm[263].y - lm[33].y) * height / width / eyeWidth;
  const yaw = Math.abs(lm[1].x - (lm[33].x + lm[263].x) / 2) / eyeWidth;
  const depthYaw = Math.abs(lm[33].z - lm[263].z) / eyeWidth;
  if (roll > .08 || yaw > .075 || depthYaw > .12) return 'Посмотрите прямо в объектив';
  if(lm[152].y + Math.abs(lm[152].y-lm[10].y)*.33 > .96) return 'Отодвиньте камеру немного дальше, чтобы было видно шею';
  if (Math.abs(lm[14].y - lm[13].y) / Math.abs(lm[152].y - lm[10].y) > .035) return 'Мягко сомкните губы';
  return '';
}

// Remove the camera pose from geometry while keeping original image UVs.
// Eye line defines yaw/roll; this is a rigid rotation, not a mirrored face.
export function neutralFacePositions(lm, width, height, scale=4.2) {
  const positions=positionsFor(lm,width,height,scale);
  const left=33*3,right=263*3;
  const dx=positions[right]-positions[left], dz=positions[right+2]-positions[left+2];
  const yaw=Math.atan2(dz,dx), c=Math.cos(yaw),s=Math.sin(yaw);
  const eyeX=(positions[left]+positions[right])/2,eyeZ=(positions[left+2]+positions[right+2])/2;
  for(let i=0;i<positions.length;i+=3) {
    const x=positions[i]-eyeX,z=positions[i+2]-eyeZ;
    positions[i]=c*x+s*z+eyeX; positions[i+2]=-s*x+c*z+eyeZ;
  }
  const roll=Math.atan2(positions[right+1]-positions[left+1],positions[right]-positions[left]);
  const cr=Math.cos(roll),sr=Math.sin(roll),eyeY=(positions[left+1]+positions[right+1])/2;
  for(let i=0;i<positions.length;i+=3) {
    const x=positions[i]-eyeX,y=positions[i+1]-eyeY;
    positions[i]=cr*x+sr*y+eyeX;positions[i+1]=-sr*x+cr*y+eyeY;
  }
  return positions;
}

export function portraitQuality(lm,width,height){
  if(!lm || lm.length<468)return 'В кадре должен быть один человек';
  const eyeWidth=Math.abs(lm[263].x-lm[33].x);
  if(eyeWidth<.06)return 'Подойдите немного ближе';
  if(Math.abs(faceYaw(lm))>.075 || Math.abs(lm[263].z-lm[33].z)/eyeWidth>.12)return 'Посмотрите прямо в объектив';
  const faceHeight=Math.abs(lm[152].y-lm[10].y);
  const faceWidth=Math.abs(lm[454].x-lm[234].x),center=(lm[454].x+lm[234].x)/2;
  if(lm[10].y-faceHeight*.35<.025)return 'Опустите лицо в кадре: макушка и волосы должны быть видны целиком';
  if(center-faceWidth*1.35<.025 || center+faceWidth*1.35>.975)return 'Отодвиньте камеру и поместите лицо по центру: оба уха и плечи должны быть в кадре';
  if(lm[152].y+faceHeight*1.1>.95)return 'Отодвиньте камеру: должны быть видны плечи и верх футболки';
  if(lm[10].y<.03 || Math.abs(lm[263].y-lm[33].y)*height/width/eyeWidth>.08)return 'Держите голову ровно и полностью в кадре';
  return '';
}

export class Presence {
  constructor() { this.reset(); }
  reset() { this.state = 'present'; this.since = 0; this.lastReminder = -Infinity; }
  update(present, now) {
    let remind = false;
    if (present) {
      if (this.state !== 'present' && this.state !== 'returning') { this.state = 'returning'; this.since = now; }
      if (this.state === 'returning' && now - this.since >= 2) this.state = 'present';
    } else {
      if (this.state === 'present' || this.state === 'returning') { this.state = 'missing'; this.since = now; }
      if (this.state === 'missing' && now - this.since >= 8) this.state = 'absent';
      if (this.state === 'absent' && now - this.lastReminder >= 30) { remind = true; this.lastReminder = now; }
    }
    return {state: this.state, remind};
  }
}

export function encodeWav(samples, rate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2), v = new DataView(buffer);
  const str = (offset, text) => [...text].forEach((ch, i) => v.setUint8(offset + i, ch.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, buffer.byteLength - 8, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  samples.forEach((x, i) => v.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, x)) * (x < 0 ? 32768 : 32767)), true));
  return buffer;
}

// Dispose a stream that arrives after the user has already seen a timeout.
export function withTimeout(promise, ms, dispose = () => {}, signal) {
  let expired = false, timer, abort;
  const result = new Promise((resolve, reject) => {
    abort = () => { expired = true; reject(new Error('Действие отменено')); };
    timer = setTimeout(() => { expired = true; reject(new Error('Время ожидания истекло. Проверьте разрешения и повторите.')); }, ms);
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) abort();
    promise.then(value => { if (expired) dispose(value); else resolve(value); }, reject);
  });
  return result.finally(() => { clearTimeout(timer); signal?.removeEventListener('abort', abort); });
}

// MediaPipe's tessellation omits the eye and mouth interiors. Fill those holes
// from the same photograph rather than displaying the scene background through them.
export const FACE_OPENINGS = [
  [33,7,163,144,145,153,154,155,133,173,157,158,159,160,161,246],
  [362,382,381,380,374,373,390,249,263,466,388,387,386,385,384,398],
  [78,95,88,178,87,14,317,402,318,324,308,415,310,311,312,13,82,81,80,191],
];
export function closeFaceOpenings(landmarks, triangles, textureMouth = true) {
  const points = landmarks.slice(0,468).map(p=>({...p}));
  const indices = [...triangles];
  for (const [opening, ring] of FACE_OPENINGS.entries()) {
    const center = {x:0,y:0,z:0};
    for (const i of ring) for (const k of ['x','y','z']) center[k] += points[i][k] / ring.length;
    const id = points.length; points.push(center);
    if (opening !== 2 || textureMouth) ring.forEach((vertex,i)=>indices.push(vertex,ring[(i+1)%ring.length],id));
  }
  return {points, indices};
}

const LOWER_LIP = [78,95,88,178,87,14,317,402,318,324,308];
const UPPER_LIP = [78,191,80,81,82,13,312,311,310,415,308];
export function mouthRig(points) {
  const top = points[13], bottom = points[152];
  const width = Math.abs(points[308].x - points[78].x);
  const center = (points[308].x + points[78].x) / 2;
  const weights = points.map(p => {
    const below = Math.max(0, (p.y - top.y) / Math.max(.01, bottom.y - top.y));
    const side = Math.max(0, 1 - Math.abs(p.x - center) / Math.max(.01, width * 1.8));
    return below > 0 ? Math.min(.65, .15 + below * .5) * side : 0;
  });
  const contour = (ids, amount) => ids.forEach((id,i) => { weights[id] = Math.sin(Math.PI*i/(ids.length-1))*amount; });
  contour(LOWER_LIP, 1);
  contour(UPPER_LIP, -.16);
  contour([61,146,91,181,84,17,314,405,321,375,291], .8);
  contour([61,185,40,39,37,0,267,269,270,409,291], -.1);
  return {weights, width};
}
export function speechOpening(samples) {
  if (!samples?.length) return 0;
  const rms = Math.sqrt(samples.reduce((sum,v)=>sum+v*v,0)/samples.length);
  return Math.min(1, Math.sqrt(Math.max(0, rms - .008) * 7));
}

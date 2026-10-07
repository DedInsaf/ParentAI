const key = value => String(value).toLowerCase().split(':').pop().replace(/[^a-z0-9]/g, '');
const clamp = value => Math.max(0, Math.min(1, value));

export function embeddedModel(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 20 || buffer.byteLength > 64 * 1024 * 1024) throw new Error('Некорректный размер аватара.');
  const bytes = new DataView(buffer);
  if (bytes.getUint32(0, true) !== 0x46546c67 || bytes.getUint32(4, true) !== 2 || bytes.getUint32(8, true) !== buffer.byteLength || bytes.getUint32(16, true) !== 0x4e4f534a) throw new Error('Повреждённая модель аватара.');
  const size = bytes.getUint32(12, true);
  if (size > 4 * 1024 * 1024 || 20 + size > buffer.byteLength) throw new Error('Повреждённое описание аватара.');
  const data = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, size)));
  if ([...(data.buffers || []), ...(data.images || [])].some(item => 'uri' in item)) throw new Error('Внешние ресурсы аватара не разрешены.');
  return data;
}

export function faceWeights(opening, cue, blink) {
  const speech = clamp(opening);
  const closed = cue === 'closed' || cue === 'silence';
  return {jawopen: closed ? speech * .04 : cue === 'teeth' ? speech * .20 : speech * .58,
    mouthclose: cue === 'closed' ? .65 : 0, mouthfunnel: cue === 'round' ? speech * .55 : 0,
    mouthpucker: cue === 'round' ? speech * .35 : 0,
    mouthstretchleft: cue === 'wide' ? speech * .22 : 0, mouthstretchright: cue === 'wide' ? speech * .22 : 0,
    eyeblinkleft: clamp(blink), eyeblinkright: clamp(blink)};
}

export class ModelAvatar {
  static async create(THREE, buffer) {
    embeddedModel(buffer); // No network requests from textures or external buffers.
    const {GLTFLoader} = await import('./vendor/loaders/GLTFLoader.js');
    const gltf = await new GLTFLoader().parseAsync(buffer, '');
    try { return new ModelAvatar(THREE, gltf.scene); }
    catch (error) { disposeModel(gltf.scene); throw error; }
  }
  constructor(THREE, object) {
    this.THREE = THREE; this.object = object; this.bones = {}; this.morphs = [];
    this.restPosition = object.position.clone();
    object.traverse(item => {
      if (item.isBone) {
        const name = key(item.name);
        this.bones[name] = {object: item, quaternion: item.quaternion.clone()};
      }
      if (item.morphTargetDictionary && item.morphTargetInfluences) {
        for (const [name, index] of Object.entries(item.morphTargetDictionary)) this.morphs.push({name: key(name), index, object: item});
      }
      // Keep the scanner's face; don't add artificial teeth or mouth surfaces.
      if (item.isMesh && /(^|[_\s])teeth([_\s]|$)/i.test(item.name)) item.visible = false;
    });
    if (!this.bones.head || !this.bones.neck || !['jawopen', 'eyeblinkleft', 'eyeblinkright'].every(name => this.morphs.some(m => m.name === name))) throw new Error('В сканере выберите анимируемый аватар T2.');
    object.updateMatrixWorld(true);
    // Exports are often in a T-pose. Move arms to a relaxed pose using each
    // skeleton's own world-space direction, without rescaling the shoulders.
    for (const side of ['left', 'right']) {
      const upper = this.bones[side + 'arm'], lower = this.bones[side + 'forearm'];
      if (!upper || !lower) continue;
      const origin = upper.object.getWorldPosition(new THREE.Vector3());
      const direction = lower.object.getWorldPosition(new THREE.Vector3()).sub(origin).normalize();
      const target = new THREE.Vector3(Math.sign(origin.x || direction.x) * .15, -1, .06).normalize();
      const world = upper.object.getWorldQuaternion(new THREE.Quaternion());
      const turn = new THREE.Quaternion().setFromUnitVectors(direction, target).multiply(world);
      const parent = upper.object.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
      upper.object.quaternion.copy(parent.multiply(turn)); upper.quaternion.copy(upper.object.quaternion);
      object.updateMatrixWorld(true);
    }
    const head = this.bones.head.object.getWorldPosition(new THREE.Vector3());
    const box = new THREE.Box3().setFromObject(object);
    const headHeight = Math.max(.12, box.max.y - head.y);
    const left = this.bones.leftarm || this.bones.leftshoulder;
    const right = this.bones.rightarm || this.bones.rightshoulder;
    const shoulders = left && right ? Math.abs(left.object.getWorldPosition(new THREE.Vector3()).x - right.object.getWorldPosition(new THREE.Vector3()).x) : headHeight * 2;
    this.frame = {x: head.x, y: box.max.y - headHeight * 1.7, z: head.z,
      height: headHeight * 3.7, width: Math.max(shoulders * 1.45, headHeight * 2.5)};
    this.rotation = new THREE.Euler(); this.delta = new THREE.Quaternion();
  }
  fit(camera, aspect) {
    const f = this.frame, half = Math.max(f.height / 2, f.width / (2 * aspect)) * 1.08;
    camera.left = -half * aspect; camera.right = half * aspect; camera.top = half; camera.bottom = -half;
    camera.position.set(f.x, f.y, f.z + 5); camera.lookAt(f.x, f.y, f.z);
    camera.updateProjectionMatrix();
  }
  rotate(name, x, y, z) {
    const bone = this.bones[name]; if (!bone) return;
    this.delta.setFromEuler(this.rotation.set(x, y, z));
    bone.object.quaternion.copy(bone.quaternion).multiply(this.delta);
  }
  update(pose, opening, cue, blink, dt = 1 / 30) {
    this.object.rotation.set(0, pose.preview + pose.bodyYaw, pose.bodyRoll);
    this.object.position.copy(this.restPosition); this.object.position.y += pose.breath * this.frame.height;
    this.rotate('neck', pose.pitch * .25, pose.yaw * .3, pose.roll * .25);
    this.rotate('head', pose.pitch * .75, pose.yaw * .7, pose.roll * .75);
    const hasEyes = ['lefteye', 'eyeleft', 'righteye', 'eyeright'].some(name => this.bones[name]);
    for (const name of ['lefteye', 'eyeleft']) this.rotate(name, pose.gazeY, pose.gazeX, 0);
    for (const name of ['righteye', 'eyeright']) this.rotate(name, pose.gazeY, pose.gazeX, 0);
    const weights = faceWeights(opening, cue, blink), blend = 1 - Math.exp(-Math.min(.1, dt) * 24);
    // Eye directions also work with rigs that expose only ARKit morphs.
    Object.assign(weights, {eyelookoutleft: hasEyes ? 0 : clamp(-pose.gazeX), eyelookinleft: hasEyes ? 0 : clamp(pose.gazeX),
      eyelookoutright: hasEyes ? 0 : clamp(pose.gazeX), eyelookinright: hasEyes ? 0 : clamp(-pose.gazeX),
      eyelookupleft: hasEyes ? 0 : clamp(-pose.gazeY), eyelookupright: hasEyes ? 0 : clamp(-pose.gazeY),
      eyelookdownleft: hasEyes ? 0 : clamp(pose.gazeY), eyelookdownright: hasEyes ? 0 : clamp(pose.gazeY)});
    for (const morph of this.morphs) {
      if (!(morph.name in weights)) continue;
      const values = morph.object.morphTargetInfluences;
      values[morph.index] += (weights[morph.name] - values[morph.index]) * blend;
    }
  }
  dispose() { disposeModel(this.object); }
}

function disposeModel(object) {
  const geometries = new Set(), materials = new Set(), textures = new Set();
  object.traverse(item => {
    if (item.geometry) geometries.add(item.geometry);
    for (const material of (Array.isArray(item.material) ? item.material : [item.material]).filter(Boolean)) {
      materials.add(material); for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
    }
    item.skeleton?.dispose();
  });
  for (const texture of textures) { texture.source?.data?.close?.(); texture.dispose(); }
  for (const material of materials) material.dispose(); for (const geometry of geometries) geometry.dispose();
}

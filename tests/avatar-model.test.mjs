import test from 'node:test';
import assert from 'node:assert/strict';
import {faceWeights, embeddedModel} from '../web/avatar-model.mjs';

test('Russian lip forms close, round and stretch actual morphs without synthetic teeth', () => {
  assert.ok(faceWeights(1, 'closed', 0).jawopen < faceWeights(1, 'wide', 0).jawopen);
  assert.equal(faceWeights(0, 'round', 0).mouthpucker, 0);
  assert.ok(faceWeights(1, 'round', 0).mouthfunnel > 0);
  assert.ok(faceWeights(1, 'wide', 0).mouthstretchleft > 0);
  assert.equal(faceWeights(0, null, 1).eyeblinkright, 1);
  for (const v of Object.values(faceWeights(20, 'wide', 4))) assert.ok(v >= 0 && v <= 1);
});

test('3D parser rejects broken headers and external textures before calling GLTFLoader', () => {
  assert.throws(() => embeddedModel(new ArrayBuffer(24)));
  const text = JSON.stringify({buffers: [{uri: 'https://evil.example/private'}]}), size = Math.ceil(text.length / 4) * 4;
  const buffer = new ArrayBuffer(20 + size), view = new DataView(buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, buffer.byteLength, true);
  view.setUint32(12, size, true); view.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(buffer, 20).fill(32); new Uint8Array(buffer, 20).set(new TextEncoder().encode(text));
  assert.throws(() => embeddedModel(buffer), /Внешние/);
});

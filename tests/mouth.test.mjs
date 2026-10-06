import test from 'node:test';
import assert from 'node:assert/strict';
import {mouthInteriorGeometry,mouthInteriorPositions} from '../web/mouth-geometry.mjs';

test('mouth stays sealed at animated lips and closes the interior',()=>{
  const ring=Array.from({length:20},(_,i)=>i),face=new Float32Array(60),width=.6;
  const update=opening=>ring.forEach(i=>{
    const a=i/20*Math.PI*2;
    face.set([Math.cos(a)*width/2,Math.sin(a)*opening,Math.cos(a)*width*.01],i*3);
  });
  update(.001);
  const cavity=mouthInteriorGeometry(face,ring,width);
  assert.ok(cavity.indices.every(i=>i>=0&&i<cavity.positions.length/3));
  for(const opening of [.001,.07,.02]) {
    update(opening);
    assert.equal(mouthInteriorPositions(face,ring,width,cavity.positions),cavity.positions);
    ring.forEach((id,i)=>{
      assert.equal(cavity.positions[i*3],face[id*3]);
      assert.equal(cavity.positions[i*3+1],face[id*3+1]);
      assert.ok(cavity.positions[i*3+2]<face[id*3+2]);
    });
    assert.ok(cavity.positions.every(Number.isFinite));
    assert.ok(cavity.positions.at(-1)<-width*.12);
  }
});

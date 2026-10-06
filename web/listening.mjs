// Local endpointing: adaptive noise floor, sustained speech, pre-roll, and echo gating.
// This detects likely speech; it cannot identify a child versus speech from a TV.
export class SpeechGate {
  constructor(rate){this.rate=rate;this.noise=.003;this.reset();}
  reset(){this.level=0;this.pre=[];this.preSamples=0;this.active=[];this.samples=0;this.voiced=0;this.run=0;this.silence=0;}
  push(audio,suppressed=false){
    if(suppressed){this.reset();return null;}
    const duration=audio.length/this.rate;
    let sum=0,crossings=0;
    for(let i=0;i<audio.length;i++){sum+=audio[i]*audio[i];if(i && (audio[i]>=0)!==(audio[i-1]>=0))crossings++;}
    const rms=Math.sqrt(sum/audio.length),zcr=crossings/audio.length;this.level=rms;
    const speech=rms>Math.max(.008,this.noise*3.2) && zcr>.004 && zcr<.42;
    if(!this.active.length && !speech) this.noise=.98*this.noise+.02*Math.min(rms,.02);
    if(!this.active.length){
      this.pre.push(audio);this.preSamples+=audio.length;
      while(this.preSamples>this.rate*.3 && this.pre.length>1)this.preSamples-=this.pre.shift().length;
      this.run=speech?this.run+duration:0;
      if(this.run>=.16){this.active=this.pre.slice();this.samples=this.preSamples;this.voiced=this.run;this.silence=0;}
      return null;
    }
    this.active.push(audio);this.samples+=audio.length;
    if(speech){this.voiced+=duration;this.silence=0;}else this.silence+=duration;
    if(this.silence<.85 && this.samples/this.rate<24)return null;
    let result=null;
    if(this.voiced>=.4){
      const length=Math.min(this.samples,this.rate*25);result=new Float32Array(length);let offset=0;
      for(const chunk of this.active){const n=Math.min(chunk.length,length-offset);if(n<=0)break;result.set(chunk.subarray(0,n),offset);offset+=n;}
    }
    this.reset();return result;
  }
}

export function isDirectedSpeech(text,followup=false){
  const cleaned=text.toLowerCase().replace(/[^а-яёa-z0-9\s]/g,' ').trim();
  if(!cleaned || cleaned.length>4000)return false;
  // Russian boundaries use spaces: JS \b is ASCII-only.
  const addressed=/(^|\s)(помоги|помогите|объясни|подскажи|пожалуйста|мама|папа|как|почему|зачем|сколько|какой|какая|какое|который|что|где|когда)(\s|$)/u.test(cleaned);
  const stuck=/(не понимаю|не получается|не знаю|не понял|не поняла|это правильно|проверь|решить|уравнение|задачу)/u.test(cleaned);
  return addressed||stuck||(followup && /[а-яё0-9]/u.test(cleaned));
}

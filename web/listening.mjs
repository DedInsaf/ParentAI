// Local endpointing: adaptive noise floor, sustained speech, pre-roll, and echo gating.
// This detects likely speech; it cannot identify a child versus speech from a TV.
export class SpeechGate {
  constructor(rate){this.rate=rate;this.noise=.0015;this.reset();}
  reset(){this.level=0;this.pre=[];this.preSamples=0;this.active=[];this.samples=0;this.voiced=0;this.run=0;this.silence=0;}
  push(audio,suppressed=false){
    if(suppressed){this.reset();return null;}
    const duration=audio.length/this.rate;
    let sum=0,crossings=0;
    for(let i=0;i<audio.length;i++){sum+=audio[i]*audio[i];if(i && (audio[i]>=0)!==(audio[i-1]>=0))crossings++;}
    const rms=Math.sqrt(sum/audio.length),zcr=crossings/audio.length;this.level=rms;
    // Laptop microphones often expose already noise-suppressed speech at a
    // much lower level than a raw microphone. Keep the adaptive floor, but do
    // not require the child to speak loudly for the utterance to start.
    const speech=rms>Math.max(.0035,this.noise*2.2) && zcr>.001 && zcr<.46;
    if(!this.active.length && !speech) this.noise=.98*this.noise+.02*Math.min(rms,.02);
    if(!this.active.length){
      this.pre.push(audio);this.preSamples+=audio.length;
      while(this.preSamples>this.rate*.3 && this.pre.length>1)this.preSamples-=this.pre.shift().length;
      this.run=speech?this.run+duration:0;
      if(this.run>=.12){this.active=this.pre.slice();this.samples=this.preSamples;this.voiced=this.run;this.silence=0;}
      return null;
    }
    this.active.push(audio);this.samples+=audio.length;
    if(speech){this.voiced+=duration;this.silence=0;}else this.silence+=duration;
    if(this.silence<.65 && this.samples/this.rate<24)return null;
    let result=null;
    if(this.voiced>=.28){
      const length=Math.min(this.samples,this.rate*25);result=new Float32Array(length);let offset=0;
      for(const chunk of this.active){const n=Math.min(chunk.length,length-offset);if(n<=0)break;result.set(chunk.subarray(0,n),offset);offset+=n;}
    }
    this.reset();return result;
  }
}

export function isDirectedSpeech(text,followup=false){
  const questionMark=String(text).includes('?');
  const cleaned=text.toLowerCase().replace(/[^а-яёa-z0-9\s]/g,' ').trim();
  if(!cleaned || cleaned.length>4000)return false;
  // Russian boundaries use spaces: JS \b is ASCII-only.
  const addressed=/(^|\s)(помоги|помогите|объясни|подскажи|пожалуйста|мама|папа|как|почему|зачем|сколько|какой|какая|какое|который|что|где|когда)(\s|$)/u.test(cleaned);
  const stuck=/(не понимаю|не получается|не знаю|не понял|не поняла|это правильно|проверь|реши|решить|уравнение|задач|пример|упражнение)/u.test(cleaned);
  const schoolQuestion=/(^|\s)(плюс|минус|умнож|раздел|равно|ответ|слово|буква|число|дроб|степен|корень)(\s|$)/u.test(cleaned);
  return addressed||stuck||schoolQuestion||questionMark||(followup && /[а-яё0-9]/u.test(cleaned));
}

export function classifySpeechRecognitionError(error){
  const message=String(error?.message||error||'Неизвестная ошибка распознавания речи.').trim();
  const retryableAudio=/(не слышно речи|не разобрал вопрос|повторите или введите текст|запись вопроса неполная|некорректная запись вопроса)/iu.test(message);
  if(retryableAudio)return {stop:false,message:'Не разобрал речь. Подойди ближе к микрофону и попробуй ещё раз.'};

  // Provider, network, access, and quota failures must be shown verbatim. Hiding
  // them behind "не разобрал речь" makes a SpeechKit outage look like a bad mic
  // and causes the hands-free loop to keep sending requests to a broken service.
  return {stop:true,message};
}

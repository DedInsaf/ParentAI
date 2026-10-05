class Listener extends AudioWorkletProcessor {
  constructor(){super();this.buffer=new Float32Array(1024);this.offset=0;}
  process(inputs,outputs){
    const input=inputs[0]?.[0];
    if(input)for(const value of input){
      this.buffer[this.offset++]=value;
      if(this.offset===this.buffer.length){this.port.postMessage(this.buffer);this.buffer=new Float32Array(1024);this.offset=0;}
    }
    for(const output of outputs)for(const channel of output)channel.fill(0);
    return true;
  }
}
registerProcessor('lesson-listener',Listener);

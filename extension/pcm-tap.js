// AudioWorklet que copia o áudio de um canal para o recorder.js, em blocos de 100 ms
// (4800 amostras a 48 kHz). Fica numa thread de áudio própria, então não perde amostra
// quando a página está ocupada.
class PcmTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(4800);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      this.block[this.filled++] = channel[i];
      if (this.filled === this.block.length) {
        this.port.postMessage(this.block.slice());
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm-tap", PcmTap);

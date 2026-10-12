// Capture PCM at the AudioContext's actual rate. No resampling or monitoring.
class VoiceCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const requested = options.processorOptions?.maxFrames;
    this.maxFrames = Math.min(
      Number.isFinite(requested) && requested > 0
        ? Math.floor(requested)
        : sampleRate * 90,
      sampleRate * 90,
    );
    this.frames = 0;
    this.energy = 0;
    this.chunkEnergy = 0;
    this.peak = 0;
    this.clipped = 0;
    this.invalid = 0;
    this.offset = 0;
    this.bytes = new Uint8Array(8192);
    this.view = new DataView(this.bytes.buffer);
    this.finished = false;
    this.port.onmessage = (event) => {
      if (event.data?.type === 'stop') this.finish('manual');
    };
  }

  flush() {
    if (!this.offset) return;
    const bytes = this.bytes.slice(0, this.offset * 2);
    this.port.postMessage(
      {
        type: 'chunk',
        bytes,
        frames: this.frames,
        rms: Math.sqrt(this.chunkEnergy / this.offset),
        peak: this.peak,
      },
      [bytes.buffer],
    );
    this.offset = 0;
    this.chunkEnergy = 0;
  }

  finish(reason) {
    if (this.finished) return;
    this.finished = true;
    this.flush();
    this.port.postMessage({
      type: 'done',
      reason,
      frames: this.frames,
      energy: this.energy,
      peak: this.peak,
      clipped: this.clipped,
      invalid: this.invalid,
    });
  }

  process(inputs) {
    if (this.finished) return false;
    const channels = inputs[0];
    if (!channels?.length) return true;
    const count = Math.min(channels[0].length, this.maxFrames - this.frames);
    for (let i = 0; i < count; i++) {
      let value = 0;
      for (const channel of channels) {
        const input = channel[i];
        if (Number.isFinite(input)) value += input / channels.length;
        else this.invalid++;
      }
      this.peak = Math.max(this.peak, Math.abs(value));
      if (Math.abs(value) >= 0.999) this.clipped++;
      value = Math.max(-1, Math.min(1, value));
      this.energy += value * value;
      this.chunkEnergy += value * value;
      this.view.setInt16(
        this.offset * 2,
        Math.round(value < 0 ? value * 32768 : value * 32767),
        true,
      );
      this.offset++;
      this.frames++;
      if (this.offset === 4096) this.flush();
    }
    if (this.frames >= this.maxFrames) this.finish('limit');
    return !this.finished;
  }
}

registerProcessor('voice-capture-pcm', VoiceCaptureProcessor);
